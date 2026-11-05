// Run: node --test test/
// v4: activity line, handoffs, budget meter, morning summary, meeting room, day-replay helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReport, applyReport, publicView, feedNote, isFeedEvent } from '../office-state.js';
import { budgetMeter, refKey, meetingGroups, buildSummary, overnightSince, dayBounds } from '../insights.js';

const T0 = Date.parse('2026-11-05T08:00:00Z');
const MIN = 60_000, H = 60 * MIN;
const step = (a, body, t) => applyReport(a, normalizeReport(body, t), t);

test('activity line: set from activity/detail on task.start / status / heartbeat, cleared when the work ends', () => {
  let a = step(null, { agent: 'tab', kind: 'task.start', task: { id: '1', title: 'Page' }, activity: 'writing the hero' }, T0);
  assert.equal(publicView(a, T0).activity.text, 'writing the hero');
  a = step(a, { agent: 'tab', kind: 'status', status: 'working', task: { id: '1', title: 'Page' }, detail: 'fixing review notes' }, T0 + MIN);
  assert.equal(publicView(a, T0 + MIN).activity.text, 'fixing review notes');
  a = step(a, { agent: 'tab', kind: 'heartbeat', status: 'working', current: { id: '1', title: 'Page', detail: 'running tests' } }, T0 + 2 * MIN);
  assert.equal(publicView(a, T0 + 2 * MIN).activity.text, 'running tests');
  // a usage report keeps it
  a = step(a, { agent: 'tab', kind: 'usage', usage: { cost: 1 } }, T0 + 3 * MIN);
  assert.equal(publicView(a, T0 + 3 * MIN).activity.text, 'running tests');
  // a new task without a line drops the old one; finishing clears it
  const b = step(a, { agent: 'tab', kind: 'task.start', task: { id: '2', title: 'Next' } }, T0 + 4 * MIN);
  assert.equal(publicView(b, T0 + 4 * MIN).activity, null);
  const c = step(a, { agent: 'tab', kind: 'task.done' }, T0 + 4 * MIN);
  assert.equal(publicView(c, T0 + 4 * MIN).activity, null);
  // long text is trimmed; no field = no line (backward compatible)
  assert.equal(normalizeReport({ agent: 'x', kind: 'status', activity: 'x'.repeat(500) }, T0).activity.length, 120);
  assert.equal(normalizeReport({ agent: 'x', kind: 'status' }, T0).activity, undefined);
});

test('handoff: validated; sender side marks the task handed and frees the desk', () => {
  const bad = normalizeReport({ agent: 'tab', kind: 'handoff', to: 'tab' }, T0);
  assert.ok(bad.errors.some(e => e.startsWith('to:')));
  assert.ok(bad.errors.some(e => e.startsWith('task_id')));
  assert.ok(normalizeReport({ agent: 'tab', kind: 'handoff', task_id: 'x' }, T0).errors.some(e => e.startsWith('to:')));
  const r = normalizeReport({ agent: 'Tab', kind: 'handoff', to: 'Hermes', task_id: 'k1', note: 'tests pass' }, T0);
  assert.equal(r.errors, undefined);
  assert.deepEqual([r.handoff.from, r.handoff.to, r.handoff.task_id], ['tab', 'hermes', 'k1']);
  assert.equal(normalizeReport({ agent: 'tab', kind: 'task.handoff', to: 'nova', title: 'x' }, T0).kind, 'handoff');
  let a = step(null, { agent: 'tab', kind: 'task.start', task: { id: 'k1', title: 'Write tests' } }, T0);
  a = applyReport(a, r, T0 + MIN);
  const v = publicView(a, T0 + MIN);
  assert.equal(v.current, null);
  assert.equal(v.status, 'idle');
  const t = v.tasks.find(x => x.id === 'k1');
  assert.equal(t.status, 'handed'); assert.equal(t.handed_to, 'hermes'); assert.equal(t.title, 'Write tests');
  assert.ok(isFeedEvent(r));
  assert.match(feedNote({ ...r, handoff: { ...r.handoff, title: 'Write tests' } }), /hermes: Write tests/);
  // a handed task is not counted as done in the 7-day graph
  assert.equal(v.history7.at(-1).done, 0);
});

test('handoff chain: task.start with from_agent, and an explicit chain', () => {
  let a = step(null, { agent: 'hermes', kind: 'task.queued', task: { id: 'k1', title: 'Write tests' }, chain: ['nova', 'tab'] }, T0);
  assert.deepEqual(a.tasks[0].chain, ['nova', 'tab']);
  a = step(a, { agent: 'hermes', kind: 'task.start', task: { id: 'k1', title: 'Write tests' }, from_agent: 'tab' }, T0 + MIN);
  assert.deepEqual(a.tasks.find(t => t.id === 'k1').chain, ['nova', 'tab'], 'the same sender is not added twice');
  const b = step(null, { agent: 'instinct', kind: 'task.start', task: { id: 'd', title: 'Deploy' }, from_agent: 'hermes' }, T0);
  assert.deepEqual(b.tasks[0].chain, ['hermes']);
  // from_agent equal to the sender is ignored
  assert.equal(normalizeReport({ agent: 'tab', kind: 'task.start', from_agent: 'tab' }, T0).from_agent, undefined);
});

test('budget meter: config.budget per day, amber from 80%, red over 100%', () => {
  assert.equal(budgetMeter({ cost: 1 }, null), null);
  assert.deepEqual(budgetMeter({ cost: 1 }, { cost: 4 }), { field: 'cost', used: 1, limit: 4, pct: 25, level: 'ok' });
  assert.equal(budgetMeter({ cost: 3.2 }, { cost: 4 }).level, 'warn');
  assert.equal(budgetMeter({ cost: 4.5 }, { cost: 4 }).level, 'over');
  assert.equal(budgetMeter({ cost: 4 }, { cost: 4 }).level, 'warn', 'exactly at the budget is not over yet');
  // the tightest budget wins
  assert.equal(budgetMeter({ cost: 1, tokens: 950 }, { cost: 10, tokens: 1000 }).field, 'tokens');
  let a = step(null, { agent: 'pixel', kind: 'config', config: { budget: { cost: 2, junk: 9, tokens: -1 } } }, T0);
  assert.deepEqual(a.config.budget, { cost: 2 });
  a = step(a, { agent: 'pixel', kind: 'usage', usage: { cost: 2.3 } }, T0 + MIN);
  const v = publicView(a, T0 + MIN);
  assert.equal(v.meter.level, 'over'); assert.equal(v.meter.pct, 115);
  assert.deepEqual(step(null, { agent: 'p', kind: 'config', config: { budget: 5 } }, T0).config.budget, { cost: 5 });
  assert.equal(publicView(step(null, { agent: 'p', kind: 'usage', usage: { cost: 1 } }, T0), T0).meter, null);
});

test('meeting room: 2+ agents on the same PR (or repo) share the table', () => {
  assert.equal(refKey('https://github.com/Office/Agent-Office/pull/120/files'), 'office/agent-office#120');
  assert.equal(refKey('https://github.com/office/leadflow'), 'office/leadflow');
  assert.equal(refKey('https://example.com/x'), '');
  const pr = 'https://github.com/o/r/pull/7';
  const views = [
    { id: 'tab', status: 'working', current: { link: pr } },
    { id: 'instinct', status: 'working', current: { link: pr + '#discussion' } },
    { id: 'hermes', status: 'working', current: { link: 'https://github.com/o/r/pull/8' } },
    { id: 'nova', status: 'offline', current: { link: pr } },
    { id: 'pixel', status: 'idle', current: null },
  ];
  assert.deepEqual(meetingGroups(views), [{ key: 'o/r#7', label: 'PR #7', ids: ['instinct', 'tab'] }]);
  assert.deepEqual(meetingGroups([]), []);
});

test('morning summary: counts, per-agent lines and a plain-text digest for a window', () => {
  const since = T0 - 12 * H, until = T0;
  const agents = [
    { id: 'hermes', name: 'Hermes', tasks: [{ title: 'Tests', status: 'done', ended: T0 - H }, { title: 'Old', status: 'done', ended: T0 - 30 * H }], current: { title: 'Fixes' } },
    { id: 'atlas', name: 'Atlas', tasks: [{ title: 'Migration', status: 'failed', ended: T0 - 2 * H }], alert: { kind: 'stuck', minutes: 45, task: 'Migration' } },
    { id: 'pixel', name: 'Pixel', tasks: [] },
  ];
  const changes = [{ type: 'pr.merged', pr: '12', repo: 'o/r', title: 'Cards', ts: T0 - 3 * H }, { type: 'deploy', target: 'site', env: 'production', status: 'failed', ts: T0 - 2 * H }, { type: 'deploy', target: 'site', env: 'production', status: 'success', ts: T0 - 40 * H }];
  const reviews = [{ pr: '12', author_agent: 'hermes', reviewer_agent: 'instinct', verdict: 'approved', findings: [{}], ts: T0 - 4 * H }];
  const s = buildSummary({ agents, changes, reviews, since, until });
  assert.deepEqual(s.counts, { tasks_done: 1, tasks_failed: 1, prs_merged: 1, deploys: 1, deploys_failed: 1, reviews: 1, alerts: 1 });
  assert.deepEqual(s.agents.map(a => a.id), ['hermes', 'atlas']);
  assert.match(s.text, /Hermes — סיים 1: Tests · עכשיו: Fixes/);
  assert.match(s.text, /Instinct ביקר את PR #12 של Hermes/);
  assert.match(s.text, /⚠ Atlas תקוע/);
  const quiet = buildSummary({ agents: [], since, until });
  assert.match(quiet.text, /שקט בלילה/);
  // default window: 18:00 Israel time yesterday (winter: UTC+2)
  assert.equal(new Date(overnightSince(T0)).toISOString(), '2026-11-04T16:00:00.000Z');
  assert.equal(new Date(overnightSince(Date.parse('2026-07-01T08:00:00Z'))).toISOString(), '2026-06-30T15:00:00.000Z');
});

test('dayBounds: Israel-time day, DST-safe', () => {
  assert.deepEqual(dayBounds('2026-11-05').map(x => new Date(x).toISOString()), ['2026-11-04T22:00:00.000Z', '2026-11-05T22:00:00.000Z']);
  const [s, e] = dayBounds('2026-10-25'); // clocks go back that night: a 25-hour day
  assert.equal((e - s) / H, 25);
});

test('replay: the browser reducer rebuilds the same state from the stored reports', () => {
  const reports = [
    { agent: 'tab', kind: 'task.start', task: { id: 'a', title: 'A' }, activity: 'x' },
    { agent: 'tab', kind: 'usage', usage: { cost: 2 } },
    { agent: 'tab', kind: 'task.done', task: { id: 'a' } },
  ].map((b, i) => normalizeReport(b, T0 + i * MIN));
  let live = null;
  for (const r of reports) live = applyReport(live, r, r.ts);
  // what the hub stores is JSON; replaying that JSON gives the same public view
  let replayed = null;
  for (const r of JSON.parse(JSON.stringify(reports))) replayed = applyReport(replayed, r, r.ts);
  assert.deepEqual(publicView(replayed, T0 + 5 * MIN), publicView(live, T0 + 5 * MIN));
});
