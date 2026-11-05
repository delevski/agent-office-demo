// Run: node --test test/
// v5: reliability score per agent, "give a task" (a board card only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReport, applyReport, publicView } from '../office-state.js';
import { reliability, RELIABILITY, parseAssign, reviewTrend, ALERT_AFTER_MS, agentAlert } from '../insights.js';
import { EventHub } from '../server/hub.js';

const T0 = Date.parse('2026-11-05T08:00:00Z');
const MIN = 60_000;
const step = (a, body, t) => applyReport(a, normalizeReport(body, t), t);
const hist = (done, failed) => [{ day: 'x', done, failed }];

test('reliability: success, stability and review-trend parts add up to the score', () => {
  const perfect = reliability({ hasData: true, history7: hist(10, 0), incidents7: 0 }, { points: [{}, {}], first: 6, last: 0, change: -1 });
  assert.equal(perfect.score, 100); assert.equal(perfect.level, 'great');
  assert.deepEqual(perfect.parts.map(p => p.points), [RELIABILITY.success, RELIABILITY.stability, RELIABILITY.quality]);
  // half failed, stuck twice, findings flat
  const meh = reliability({ hasData: true, history7: hist(5, 5), incidents7: 2 }, { points: [{}, {}], first: 3, last: 3, change: 0 });
  assert.equal(meh.score, Math.round(30 + 9 + 7.5));
  assert.equal(meh.level, 'low');
  assert.equal(reliability({ history7: hist(8, 2), incidents7: 2 }).level, 'fair'); // 48 + 9 + 7.5
  // findings rising costs the quality part; it never goes below zero
  assert.equal(reliability({ history7: hist(1, 0) }, { points: [{}, {}], change: 3 }).parts[2].points, 0);
  // stability floors at zero
  assert.equal(reliability({ history7: hist(1, 0), incidents7: 9 }).parts[1].points, 0);
  // no data: neutral parts and flagged as low data
  const none = reliability({ hasData: true, history7: [] });
  assert.equal(none.score, Math.round(RELIABILITY.success * 0.75 + RELIABILITY.stability + RELIABILITY.quality / 2));
  assert.ok(none.lowData);
  // a real trend from reviewTrend (Hermes improving) feeds straight in
  const tr = reviewTrend([1, 2, 3, 4].map(i => ({ pr: String(i), repo: 'o/r', author_agent: 'hermes', ts: i, findings: Array(8 - 2 * i).fill({}) })))[0];
  assert.ok(reliability({ history7: hist(4, 0) }, tr).parts[2].points > RELIABILITY.quality / 2);
});

test('reliability: stuck incidents are counted once per silence, and a live stuck alert counts right away', () => {
  let a = step(null, { agent: 'atlas', kind: 'task.start', task: { id: 'm', title: 'Migration' } }, T0);
  const late = T0 + ALERT_AFTER_MS + 5 * MIN;
  // still stuck: not counted by the server yet, but the browser adds the live alert
  const vStuck = publicView(a, late);
  assert.equal(vStuck.incidents7, 0);
  const withAlert = reliability(vStuck, null, agentAlert(vStuck, late));
  assert.equal(withAlert.parts[1].points, RELIABILITY.stability - RELIABILITY.stuckPenalty);
  // the agent speaks again: one incident recorded; more reports in the same silence do not add more
  a = step(a, { agent: 'atlas', kind: 'usage', usage: { cost: 1 } }, late);
  a = step(a, { agent: 'atlas', kind: 'usage', usage: { cost: 2 } }, late + MIN);
  let v = publicView(a, late + MIN);
  assert.equal(v.incidents7, 1);
  assert.equal(reliability(v, null, agentAlert(v, late + MIN)).parts[1].points, RELIABILITY.stability - RELIABILITY.stuckPenalty, 'not double-counted with the live alert');
  // a fresh update, then a second silence = a second incident
  a = step(a, { agent: 'atlas', kind: 'status', status: 'working', task: { id: 'm', title: 'Migration' } }, late + 2 * MIN);
  a = step(a, { agent: 'atlas', kind: 'task.done' }, late + 2 * MIN + ALERT_AFTER_MS + MIN);
  assert.equal(publicView(a, late + 2 * MIN + ALERT_AFTER_MS + MIN).incidents7, 2);
  // normal work is never an incident
  let b = step(null, { agent: 'tab', kind: 'task.start', task: { id: '1' } }, T0);
  b = step(b, { agent: 'tab', kind: 'task.done' }, T0 + 10 * MIN);
  assert.equal(publicView(b, T0 + 10 * MIN).incidents7, 0);
});

test('give a task: validated; an agent cannot fake the "manual" flag', () => {
  assert.deepEqual(parseAssign({ title: '  Check   checkout ', agent: 'Hermes', note: 'mobile' }, ['hermes']), { task: { title: 'Check checkout', agent: 'hermes', note: 'mobile' }, errors: [] });
  assert.deepEqual(parseAssign({}, ['hermes']).errors, ['title: required', 'agent: required']);
  assert.deepEqual(parseAssign({ title: 'x', agent: 'ghost' }, ['hermes']).errors, ['agent: unknown agent']);
  assert.equal(parseAssign({ title: 'x'.repeat(500), agent: 'hermes' }).task.title.length, 160);
  assert.equal(parseAssign(null).errors.length, 2);
  const r = normalizeReport({ agent: 'hermes', kind: 'task.queued', task: { id: 'q', title: 'x' }, assigned: { note: 'fake' } }, T0);
  assert.equal(r.assigned, undefined);
  assert.equal(applyReport(null, r, T0).tasks[0].assigned, undefined);
});

test('give a task: the hub adds a queued card and changes nothing else about the agent', async () => {
  const data = new Map(); const sent = [];
  const st = { storage: { async get(k) { return Array.isArray(k) ? new Map() : structuredClone(data.get(k)); }, async put(k, v) { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) data.set(a, structuredClone(b)); else data.set(k, v); }, async delete() {}, async list() { return new Map(); } },
    blockConcurrencyWhile: fn => fn(), getWebSockets: () => [{ send: m => sent.push(JSON.parse(m)) }] };
  const hub = new EventHub(st); await new Promise(r => setTimeout(r, 0));
  const post = r => hub.fetch(new Request('https://hub/report', { method: 'POST', body: JSON.stringify(r) }));
  await post(normalizeReport({ agent: 'hermes', kind: 'task.start', task: { id: 'w', title: 'Working' } }));
  const now = Date.now();
  await post({ agent: 'hermes', name: '', kind: 'task.queued', value: '', note: 'משימה חדשה בלוח: Check checkout', ts: now, task: { id: 'm1', title: 'Check checkout', link: '', since: now }, assigned: { note: 'on mobile' } });
  const h = hub.agents.get('hermes');
  assert.equal(h.status, 'working'); assert.equal(h.current.id, 'w', 'the agent keeps working on its own task');
  const card = h.tasks.find(t => t.id === 'm1');
  assert.deepEqual([card.status, card.assigned, card.note], ['queued', true, 'on mobile']);
  assert.ok(sent.some(m => m.type === 'agent' && m.agent.tasks.some(t => t.id === 'm1')));
});
