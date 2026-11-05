// Run: node --test test/
// v3: reviews, 7-day history, stuck/silent alerts, "what changed today".
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReport, applyReport, publicView, newlyDone, isFeedEvent, feedNote } from '../server/agents.js';
import { agentAlert, ALERT_AFTER_MS, ALERT_AFTER_MIN, history7, lastDays, reviewTrend, changesForDay, severityCounts, alertLabel, dayOf } from '../insights.js';

const T0 = Date.parse('2026-11-05T08:00:00Z');
const MIN = 60_000, H = 60 * MIN, D = 24 * H;
const step = (a, body, t) => applyReport(a, normalizeReport(body, t), t);

/* ---------------- 1. review ---------------- */
test('review: validated, normalized, PR URL understood, reviewer defaults to the sender', () => {
  const r = normalizeReport({ agent: 'instinct', kind: 'review', pr: 'https://github.com/office/agent-office/pull/101', author_agent: 'Hermes', verdict: 'request changes',
    findings: [{ severity: 'major', title: 'No timeout', file: 'src/a.js', line: 12 }, 'Typo', { level: 'nit', message: 'naming' }], summary: 'ok', ts: T0 - H }, T0);
  assert.equal(r.errors, undefined);
  assert.equal(r.review.pr, '101');
  assert.equal(r.review.repo, 'office/agent-office');
  assert.equal(r.review.link, 'https://github.com/office/agent-office/pull/101');
  assert.equal(r.review.author_agent, 'hermes');
  assert.equal(r.review.reviewer_agent, 'instinct');
  assert.equal(r.review.verdict, 'changes_requested');
  assert.deepEqual(r.review.findings.map(f => f.severity), ['high', 'medium', 'nit']);
  assert.equal(r.review.findings[0].line, 12);
  assert.equal(r.review.ts, T0 - H);
  assert.equal(r.review.id, 'office/agent-office#101@instinct#1');
  assert.ok(isFeedEvent(r));
  assert.match(feedNote(r), /PR #101/);
});

test('review: bad payloads are rejected with readable errors', () => {
  const bad = normalizeReport({ agent: 'tab', kind: 'review', verdict: 'maybe', findings: 'lots' }, T0);
  assert.ok(bad.errors.some(e => e.startsWith('pr:')));
  assert.ok(bad.errors.some(e => e.startsWith('author_agent:')));
  assert.ok(bad.errors.some(e => e.startsWith('verdict:')));
  assert.ok(bad.errors.some(e => e.startsWith('findings:')));
  const sev = normalizeReport({ agent: 'tab', kind: 'review', pr: 3, author_agent: 'hermes', findings: [{ severity: 'huge', title: 'x' }, { severity: 'low' }] }, T0);
  assert.equal(sev.errors.length, 2);
  const legacy = normalizeReport({ agent: 'tab', kind: 'review', pr: 3, author_agent: 'hermes', ts: 'not a date' }, T0);
  assert.ok(legacy.errors.some(e => e.startsWith('ts:')));
  // future timestamps clamp to now
  assert.equal(normalizeReport({ agent: 'tab', kind: 'review', pr: 3, author_agent: 'hermes', ts: T0 + D }, T0).review.ts, T0);
});

test('original kinds never get validated or rejected (backward compatible)', () => {
  for (const body of [{ kind: 'task.start' }, { kind: 'lead.new', value: '+1' }, { kind: 'heartbeat', recent: 'x' }, {}, { kind: 'usage', usage: 'junk' }])
    assert.equal(normalizeReport({ agent: 'tab', ...body }, T0).errors, undefined, JSON.stringify(body));
});

test('reviewTrend: one point per PR, falling findings = improving', () => {
  const mk = (pr, n, ts, reviewer = 'instinct') => ({ pr: String(pr), repo: 'o/r', author_agent: 'hermes', reviewer_agent: reviewer, ts, findings: Array(n).fill({ severity: 'low', title: 'x' }) });
  const reviews = [mk(1, 6, T0), mk(2, 4, T0 + D), mk(2, 1, T0 + D + H, 'tab'), mk(3, 2, T0 + 2 * D), mk(4, 1, T0 + 3 * D),
    { pr: '9', repo: 'o/r', author_agent: 'tab', reviewer_agent: 'instinct', ts: T0, findings: [] }];
  const [h, t] = reviewTrend(reviews);
  assert.equal(h.author, 'hermes');
  assert.deepEqual(h.points.map(p => p.findings), [6, 5, 2, 1]); // PR 2 sums both reviewers
  assert.equal(h.first, 6); assert.equal(h.last, 1);
  assert.ok(h.change < 0, 'Hermes is improving');
  assert.equal(t.author, 'tab'); assert.equal(t.change, null); // one PR: no trend yet
  assert.deepEqual(reviewTrend([]), []);
  assert.deepEqual(severityCounts([{ severity: 'high' }, { severity: 'high' }, { severity: 'nit' }]), { critical: 0, high: 2, medium: 0, low: 0, nit: 1 });
});

/* ---------------- 2. 7-day history ---------------- */
test('history7: done/failed per day from task.done / task.failed and heartbeat recent[], counted once', () => {
  let a = null, t = T0;
  a = step(a, { agent: 'x', kind: 'heartbeat', recent: [
    { id: 'a', title: 'A', done_at: new Date(T0 - 2 * D).toISOString(), result: 'ok' },
    { id: 'b', title: 'B', done_at: new Date(T0 - 2 * D).toISOString(), result: 'failed' },
    { id: 'c', title: 'C', done_at: new Date(T0 - 9 * D).toISOString(), result: 'ok' }, // outside the window
  ] }, t);
  // the same snapshot again must not double count
  a = step(a, { agent: 'x', kind: 'heartbeat', recent: [{ id: 'a', title: 'A', done_at: new Date(T0 - 2 * D).toISOString(), result: 'ok' }] }, t += MIN);
  a = step(a, { agent: 'x', kind: 'task.start', task: { id: 'd', title: 'D' } }, t += MIN);
  a = step(a, { agent: 'x', kind: 'task.done', task: { id: 'd' } }, t += MIN);
  a = step(a, { agent: 'x', kind: 'task.done', task: { id: 'd' } }, t += MIN); // duplicate report
  a = step(a, { agent: 'x', kind: 'task.start', task: { id: 'e', title: 'E' } }, t += MIN);
  a = step(a, { agent: 'x', kind: 'task.failed' }, t += MIN);
  const v = publicView(a, t);
  assert.equal(v.history7.length, 7);
  assert.equal(v.history7[6].day, dayOf(t));
  assert.deepEqual(v.history7[6], { day: dayOf(t), done: 1, failed: 1 });
  assert.deepEqual(v.history7[4], { day: dayOf(T0 - 2 * D), done: 1, failed: 0 + 1 });
  assert.equal(v.history7.reduce((s, d) => s + d.done + d.failed, 0), 4);
});

test('history7 falls back to the task list for agents stored before the counter existed', () => {
  const old = { tasks: [{ id: '1', status: 'done', ended: T0 - D }, { id: '2', status: 'failed', ended: T0 }, { id: '3', status: 'running' }] };
  const h = history7(undefined, old.tasks, T0);
  assert.deepEqual(h.slice(-2).map(d => [d.done, d.failed]), [[1, 0], [0, 1]]);
  assert.equal(new Set(lastDays(T0)).size, 7);
});

/* ---------------- 3. stuck / silent ---------------- */
test(`alert: open task with no update for more than ${ALERT_AFTER_MIN} min -> stuck`, () => {
  assert.equal(ALERT_AFTER_MS, ALERT_AFTER_MIN * MIN);
  let a = step(null, { agent: 'atlas', kind: 'task.start', task: { id: 'm', title: 'Migration' } }, T0);
  assert.equal(publicView(a, T0 + ALERT_AFTER_MS - MIN).alert, null);
  // usage / config reports are not news about the task
  a = step(a, { agent: 'atlas', kind: 'usage', usage: { messages: 3 } }, T0 + 20 * MIN);
  const v = publicView(a, T0 + ALERT_AFTER_MS + 2 * MIN);
  assert.equal(v.alert.kind, 'stuck');
  assert.equal(v.alert.task, 'Migration');
  assert.equal(v.alert.minutes, ALERT_AFTER_MIN + 2);
  assert.match(alertLabel(v.alert), /^תקוע 32 דק׳$/);
  // a heartbeat that names the task counts as an update; finishing it clears the alert
  const b = step(a, { agent: 'atlas', kind: 'heartbeat', status: 'working', current: { id: 'm', title: 'Migration' } }, T0 + 40 * MIN);
  assert.equal(publicView(b, T0 + 41 * MIN).alert, null);
  const c = step(a, { agent: 'atlas', kind: 'task.done' }, T0 + 40 * MIN);
  assert.equal(publicView(c, T0 + 200 * MIN).alert, null);
});

test('alert: heartbeat agent that goes quiet -> silent; an agent that said offline is never flagged', () => {
  const a = step(null, { agent: 'pixel', kind: 'heartbeat', status: 'idle' }, T0);
  assert.equal(publicView(a, T0 + 10 * MIN).alert, null);
  assert.equal(publicView(a, T0 + 31 * MIN).alert.kind, 'silent');
  const off = step(a, { agent: 'pixel', kind: 'status', status: 'offline' }, T0 + MIN);
  assert.equal(publicView(off, T0 + 300 * MIN).alert, null);
  // event-only agents that are idle are not nagged
  const idle = step(null, { agent: 'tab', kind: 'task.start', task: { id: 'q' } }, T0);
  const done = step(idle, { agent: 'tab', kind: 'task.done' }, T0 + MIN);
  assert.equal(publicView(done, T0 + 500 * MIN).alert, null);
  assert.equal(agentAlert(null), null);
  assert.equal(agentAlert({ hasData: false }), null);
});

/* ---------------- 4. what changed today ---------------- */
test('pr.merged / deploy: validated and normalized', () => {
  const m = normalizeReport({ agent: 'instinct', kind: 'pr.merged', pr: '#44', repo: 'https://github.com/office/infra', title: 'Backups' }, T0);
  assert.equal(m.errors, undefined);
  assert.equal(m.change.type, 'pr.merged');
  assert.equal(m.change.repo, 'office/infra');
  assert.equal(m.change.link, 'https://github.com/office/infra/pull/44');
  assert.equal(m.change.merged_by, 'instinct');
  const d = normalizeReport({ agent: 'instinct', kind: 'deploy', target: 'leadflow', env: 'production', sha: 'abc1234', status: 'ok' }, T0);
  assert.equal(d.change.status, 'success');
  assert.equal(d.status, undefined, 'deploy status never becomes the agent status');
  assert.ok(normalizeReport({ agent: 'i', kind: 'deploy', status: 'exploded' }, T0).errors.length === 2);
  assert.ok(normalizeReport({ agent: 'i', kind: 'pr.merged' }, T0).errors.length === 1);
  assert.match(feedNote(d), /leadflow → production/);
});

test('changesForDay: today only, newest first, closed tasks merged in without duplicates', () => {
  let a = step(null, { agent: 'nova', kind: 'task.start', task: { id: 'n1', title: 'Research' } }, T0);
  const b = step(a, { agent: 'nova', kind: 'task.done', task: { id: 'n1' } }, T0 + MIN);
  const done = newlyDone(a, b);
  assert.equal(done.length, 1);
  assert.equal(newlyDone(b, step(b, { agent: 'nova', kind: 'task.done', task: { id: 'n1' } }, T0 + 2 * MIN)).length, 0);
  const changes = [
    { id: 'pr:o/r#1', type: 'pr.merged', ts: T0 - 30 * MIN, title: 'x' },
    { id: 'deploy:x', type: 'deploy', ts: T0 - 2 * D, target: 'old' },
    { id: 'task:nova:n1', type: 'task.done', agent: 'nova', ts: T0 + MIN, title: 'Research' },
  ];
  const out = changesForDay(changes, [b], dayOf(T0));
  assert.deepEqual(out.map(c => c.id), ['task:nova:n1', 'pr:o/r#1']);
  assert.deepEqual(changesForDay([], [], dayOf(T0)), []);
  // tasks closed before the change log existed still show up
  assert.equal(changesForDay([], [b], dayOf(T0))[0].title, 'Research');
});
