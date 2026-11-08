// v6: pr.opened (rings the bell) and chat.exchange (speech bubbles). Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReport, applyReport, isFeedEvent, feedNote } from '../server/agents.js';

const T0 = Date.parse('2026-11-08T12:00:00Z');

test('pr.opened: parsed from a PR URL, validated, fed to the log with a bell', () => {
  const r = normalizeReport({ agent: 'instinct', kind: 'pr.opened', pr: 'https://github.com/delevski/agent-office-demo/pull/7', title: 'Office v6' }, T0);
  assert.equal(r.kind, 'pr.opened');
  assert.equal(r.errors, undefined);
  assert.equal(r.change.pr, '7');
  assert.equal(r.change.repo, 'delevski/agent-office-demo');
  assert.equal(r.change.link, 'https://github.com/delevski/agent-office-demo/pull/7');
  assert.equal(r.change.author_agent, 'instinct');
  assert.ok(isFeedEvent(r));
  assert.match(feedNote(r), /פתח PR #7 · Office v6/);
  const a = applyReport(null, r, T0);
  assert.equal(a.events, 1);
});

test('pr.opened aliases and validation', () => {
  for (const kind of ['pr.open', 'pr.created', 'pull_request.opened']) assert.equal(normalizeReport({ agent: 'tab', kind, pr: 3 }, T0).kind, 'pr.opened');
  const bad = normalizeReport({ agent: 'tab', kind: 'pr.opened' }, T0);
  assert.ok(bad.errors?.length);
});

test('chat.exchange: participants from lines, lines trimmed and capped, agreement flag', () => {
  const long = 'א'.repeat(300);
  const r = normalizeReport({
    agent: 'tab', kind: 'chat.exchange', topic: 'מי מתקן את הבאג', agreed: 'yes', source: 'slack',
    lines: [
      { agent: 'tab', text: 'אני לוקח את הטופס' }, { agent: 'Hermes', text: 'מסכים, אני על הבדיקות' },
      { agent: 'tab', text: long }, { agent: 'hermes', text: '' }, { nope: 1 }, 'x',
      ...Array.from({ length: 10 }, (_, i) => ({ agent: 'tab', text: 'שורה ' + i })),
    ],
  }, T0);
  assert.equal(r.errors, undefined);
  assert.deepEqual(r.chat.participants, ['tab', 'hermes']);
  assert.equal(r.chat.lines.length, 6);
  assert.ok(r.chat.lines[2].text.length <= 90);
  assert.equal(r.chat.agreed, true);
  assert.equal(r.chat.source, 'slack');
  assert.match(feedNote(r), /tab ↔ hermes · מי מתקן את הבאג · הסכימו/);
});

test('chat.exchange needs two agents and a line; aliases work', () => {
  assert.ok(normalizeReport({ agent: 'tab', kind: 'chat.exchange', lines: [{ agent: 'tab', text: 'hi' }] }, T0).errors.length);
  assert.ok(normalizeReport({ agent: 'tab', kind: 'chat.exchange', participants: ['tab', 'hermes'] }, T0).errors.length);
  const ok = normalizeReport({ agent: 'tab', kind: 'chat', participants: ['tab', 'instinct'], lines: [{ agent: 'instinct', text: 'סגור' }] }, T0);
  assert.equal(ok.kind, 'chat.exchange');
  assert.equal(ok.errors, undefined);
  assert.equal(ok.chat.agreed, false);
});

test('old kinds are untouched (backward compatible)', () => {
  const r = normalizeReport({ agent: 'tab', kind: 'task.done', task: { id: 'x', title: 'y' } }, T0);
  assert.equal(r.kind, 'task.done');
  assert.equal(r.chat, undefined);
  assert.equal(r.change, undefined);
});

// the hub end to end (in-memory storage, a fake socket): what the browser receives
import { EventHub } from '../server/hub.js';
function fakeState() {
  const data = new Map(), sent = [];
  const storage = {
    async get(k) { return structuredClone(data.get(k)); },
    async put(k, v) { if (typeof k === 'object') { for (const [a, b] of Object.entries(k)) data.set(a, structuredClone(b)); } else data.set(k, structuredClone(v)); },
    async delete(k) { for (const x of [].concat(k)) data.delete(x); },
    async list({ prefix }) { return new Map([...data].filter(([k]) => k.startsWith(prefix))); },
  };
  return { data, sent, storage, blockConcurrencyWhile: fn => fn(), getWebSockets: () => [{ send: m => sent.push(JSON.parse(m)) }] };
}
const post = (hub, body) => hub.fetch(new Request('https://hub/report', { method: 'POST', body: JSON.stringify(normalizeReport(body)) }));

test('hub: pr.opened is broadcast with the PR for the bell and lands in "what changed today"', async () => {
  const st = fakeState(), hub = new EventHub(st); await new Promise(r => setTimeout(r, 0));
  await post(hub, { agent: 'instinct', kind: 'pr.opened', pr: 7, repo: 'delevski/agent-office-demo', title: 'Office v6' });
  const ev = st.sent.find(m => m.type === 'event').event;
  assert.equal(ev.kind, 'pr.opened');
  assert.deepEqual(ev.pr, { pr: '7', repo: 'delevski/agent-office-demo', title: 'Office v6', link: 'https://github.com/delevski/agent-office-demo/pull/7' });
  assert.equal(ev.link, 'https://github.com/delevski/agent-office-demo/pull/7');
  const ch = st.sent.find(m => m.type === 'change').change;
  assert.equal(ch.type, 'pr.opened');
  assert.equal(hub.changes.length, 1);
});

test('hub: chat.exchange reaches the browser with its lines (and is kept for the polling fallback)', async () => {
  const st = fakeState(), hub = new EventHub(st); await new Promise(r => setTimeout(r, 0));
  await post(hub, { agent: 'tab', kind: 'chat.exchange', agreed: true, lines: [{ agent: 'tab', text: 'מסכים?' }, { agent: 'hermes', text: 'כן' }] });
  const ev = st.sent.find(m => m.type === 'event').event;
  assert.deepEqual(ev.chat.participants, ['tab', 'hermes']);
  assert.equal(ev.chat.lines.length, 2);
  assert.equal(ev.chat.agreed, true);
  const polled = await (await hub.fetch(new Request('https://hub/list?since=0'))).json();
  assert.ok(polled.events.some(e => e.chat && e.chat.lines[1].text === 'כן'));
});
