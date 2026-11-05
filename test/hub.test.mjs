// Run: node --test test/
// The Durable Object end to end, on an in-memory storage: handoffs, the replay log, the morning summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventHub } from '../server/hub.js';
import { normalizeReport, applyReport, publicView } from '../office-state.js';

function fakeState() {
  const data = new Map();
  const sent = [];
  const storage = {
    async get(k) { if (Array.isArray(k)) return new Map(k.filter(x => data.has(x)).map(x => [x, structuredClone(data.get(x))])); return structuredClone(data.get(k)); },
    async put(k, v) { if (typeof k === 'object') { for (const [a, b] of Object.entries(k)) data.set(a, structuredClone(b)); } else data.set(k, structuredClone(v)); },
    async delete(k) { for (const x of [].concat(k)) data.delete(x); },
    async list({ prefix }) { return new Map([...data].filter(([k]) => k.startsWith(prefix))); },
  };
  return { data, sent, storage, blockConcurrencyWhile: fn => fn(), getWebSockets: () => [{ send: m => sent.push(JSON.parse(m)) }] };
}
async function hubWith() { const st = fakeState(); const hub = new EventHub(st); await new Promise(r => setTimeout(r, 0)); return { st, hub }; }
const report = (hub, body) => hub.fetch(new Request('https://hub/report', { method: 'POST', body: JSON.stringify(normalizeReport(body)) }));
const get = async (hub, path) => (await hub.fetch(new Request('https://hub' + path))).json();

test('hub: a handoff queues the task on the receiver with its chain and broadcasts the arc', async () => {
  const { st, hub } = await hubWith();
  await report(hub, { agent: 'tab', kind: 'task.start', task: { id: 'k1', title: 'Write tests' } });
  await report(hub, { agent: 'tab', kind: 'handoff', to: 'hermes', task_id: 'k1', note: 'all yours' });
  const hermes = hub.agents.get('hermes');
  const t = hermes.tasks.find(x => x.id === 'k1');
  assert.equal(t.status, 'queued'); assert.equal(t.title, 'Write tests'); assert.deepEqual(t.chain, ['tab']);
  assert.equal(hub.agents.get('tab').tasks.find(x => x.id === 'k1').status, 'handed');
  const arc = st.sent.find(m => m.type === 'handoff');
  assert.deepEqual([arc.handoff.from, arc.handoff.to, arc.handoff.title], ['tab', 'hermes', 'Write tests']);
  assert.ok(st.sent.some(m => m.type === 'agent' && m.agent.id === 'hermes'));
  // the feed line names the task even though only its id was sent
  assert.match(hub.events.at(-1).note, /hermes: Write tests · all yours/);
  // passing it on again extends the chain
  await report(hub, { agent: 'hermes', kind: 'handoff', to: 'instinct', task_id: 'k1' });
  assert.deepEqual(hub.agents.get('instinct').tasks.find(x => x.id === 'k1').chain, ['tab', 'hermes']);
  assert.equal((await get(hub, '/handoffs')).handoffs.length, 2);
});

test('hub: the replay log rebuilds exactly the live state', async () => {
  const { hub } = await hubWith();
  await report(hub, { agent: 'nova', kind: 'config', config: { budget: { tokens: 1000 } } });
  await report(hub, { agent: 'nova', kind: 'task.start', task: { id: 'r', title: 'Research', link: 'https://github.com/o/r/pull/1' }, activity: 'reading' });
  await report(hub, { agent: 'nova', kind: 'usage', usage: { tokens: 900 } });
  await report(hub, { agent: 'tab', kind: 'task.start', task: { id: 'x', title: 'X' }, from_agent: 'nova' });
  await report(hub, { agent: 'nova', kind: 'handoff', to: 'tab', task_id: 'r' });
  const d = await get(hub, '/replay');
  assert.equal(d.reports.length, 6, 'five reports + the receiver side of the handoff');
  assert.ok(d.start <= d.reports[0].ts && d.reports.at(-1).ts < d.end);
  const states = new Map(Object.entries(d.snapshot));
  for (const r of d.reports) states.set(r.agent, applyReport(states.get(r.agent), r, r.ts));
  const at = d.reports.at(-1).ts;
  for (const id of ['nova', 'tab']) {
    const live = publicView(hub.agents.get(id), at), replayed = publicView(states.get(id), at);
    assert.deepEqual({ ...replayed, firstSeen: 0 }, { ...live, firstSeen: 0 }, id);
  }
  assert.equal(publicView(states.get('nova'), at).meter.level, 'warn');
  // another day: empty, never an error
  const other = await get(hub, '/replay?day=2020-01-01');
  assert.deepEqual(other.reports, []);
});

test('hub: morning summary as JSON and as plain text', async () => {
  const { hub } = await hubWith();
  await report(hub, { agent: 'hermes', kind: 'task.start', task: { id: 'a', title: 'Fix login' } });
  await report(hub, { agent: 'hermes', kind: 'task.done', task: { id: 'a' } });
  await report(hub, { agent: 'instinct', kind: 'deploy', target: 'site', env: 'production', status: 'success' });
  const since = Date.now() - 3600_000;
  const s = await get(hub, `/summary?since=${since}&known=hermes,instinct,atlas`);
  assert.equal(s.since, since);
  assert.equal(s.counts.tasks_done, 1); assert.equal(s.counts.deploys, 1);
  assert.match(s.text, /Hermes — סיים 1: Fix login/);
  const txt = await hub.fetch(new Request('https://hub/summary?format=text'));
  assert.match(txt.headers.get('Content-Type'), /text\/plain/);
  assert.match(await txt.text(), /^☀️ סיכום משרד הסוכנים/);
  // a bad since falls back to the overnight default instead of failing
  assert.ok((await get(hub, '/summary?since=banana')).since < Date.now());
});
