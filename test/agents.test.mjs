// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReport, applyReport, publicView, dayOf, OFFLINE_AFTER_MS, isFeedEvent } from '../server/agents.js';
import { makeSession, verifySession, writerFor, tokenAgents, safeEqual, checkPassword } from '../server/auth.js';

const T0 = Date.parse('2026-11-05T08:00:00Z');
const run = (reports, start = T0) => {
  let a = null, t = start;
  for (const body of reports) { t += 1000; a = applyReport(a, normalizeReport(body, t), t); }
  return { a, t };
};

test('task.start sets current work, task.done files it as done', () => {
  const { a, t } = run([
    { agent: 'tab', kind: 'task.start', task: { id: 'pr-61', title: 'Agent panel PR', link: 'https://github.com/x/y/pull/61' } },
    { agent: 'tab', kind: 'task.done', task: { id: 'pr-61' } },
  ]);
  assert.equal(a.current, null);
  assert.equal(a.tasks.length, 1);
  assert.equal(a.tasks[0].status, 'done');
  assert.equal(a.tasks[0].title, 'Agent panel PR');
  assert.equal(a.tasks[0].link, 'https://github.com/x/y/pull/61');
  const v = publicView(a, t);
  assert.equal(v.status, 'idle');
  assert.equal(v.usageToday.tasks, 1); // derived from finished tasks when not reported
});

test('task.failed and status events', () => {
  const { a } = run([
    { agent: 'x', kind: 'task.start', task: { title: 'deploy' } },
    { agent: 'x', kind: 'task.failed', task: { title: 'deploy' } },
    { agent: 'x', kind: 'status', status: 'blocked', task: { title: 'waiting for approval' } },
  ]);
  assert.equal(a.tasks[0].status, 'failed');
  assert.equal(a.status, 'blocked');
  assert.equal(a.current.title, 'waiting for approval');
});

test('usage: set replaces today, add accumulates; nested or flat', () => {
  const { a, t } = run([
    { agent: 'i', kind: 'usage', usage: { messages: 10, tokens: 5000, cost: 0.2 } },
    { agent: 'i', kind: 'usage', messages: 3, cost: 0.05, mode: 'add' },
  ]);
  const u = publicView(a, t).usageToday;
  assert.equal(u.messages, 13);
  assert.equal(u.tokens, 5000);
  assert.equal(u.cost, 0.25);
  assert.equal(u.tasks, 0);
});

test('usage ignores junk numbers', () => {
  const r = normalizeReport({ agent: 'i', kind: 'usage', usage: { messages: 'abc', tokens: -5, cost: '1.5' } });
  assert.deepEqual(r.usage, { cost: 1.5 });
});

test('config: model, skills[] and tools[] are sanitized and merged', () => {
  const { a } = run([
    { agent: 'h', kind: 'config', config: { model: 'Tab', skills: ['research', 'research', '<b>x</b>', 'video'] } },
    { agent: 'h', kind: 'config', config: { tools: 'browser, phone' } },
  ]);
  assert.equal(a.config.model, 'Tab');
  assert.deepEqual(a.config.skills, ['research', 'bx/b', 'video']);
  assert.deepEqual(a.config.tools, ['browser', 'phone']);
});

test('heartbeat snapshot (Instinct contract) fills everything at once', () => {
  const { a, t } = run([{
    agent: 'instinct', kind: 'heartbeat', status: 'working',
    current: { title: 'LeadFlow deploy', since: '2026-11-05T07:30:00Z', ref: 'https://github.com/a/b/pull/56' },
    recent: [{ title: 'migration 025', done_at: '2026-11-05T07:00:00Z', result: 'ok' }, { title: 'flaky test', result: 'failed' }],
    usage: { period: 'day', tasks: 12, calls: 340, pct_of_quota: 40 },
    capabilities: { skills: ['deploy'], tools: ['wrangler'], model: 'instinct-1' },
  }]);
  const v = publicView(a, t);
  assert.equal(v.status, 'working');
  assert.equal(v.current.link, 'https://github.com/a/b/pull/56');
  assert.equal(v.current.since, Date.parse('2026-11-05T07:30:00Z'));
  assert.equal(v.tasks.length, 2);
  assert.ok(v.tasks.some(x => x.status === 'failed'));
  assert.equal(v.usageToday.tasks, 12);
  assert.equal(v.usageToday.pct_of_quota, 40);
  assert.equal(v.config.model, 'instinct-1');
  assert.equal(isFeedEvent(normalizeReport({ kind: 'heartbeat' })), false);
});

test('offline after 10 minutes without a report; no-data agents say so', () => {
  const { a, t } = run([{ agent: 'tab', kind: 'status', status: 'working' }]);
  assert.equal(publicView(a, t + OFFLINE_AFTER_MS + 1).status, 'offline');
  const empty = publicView({ id: 'hermes', status: 'idle', current: null, tasks: [], usage: {}, config: null, lastSeen: 0 }, t);
  assert.equal(empty.hasData, false);
  assert.equal(empty.status, 'offline');
  assert.equal(empty.usageToday, null);
});

test('links must be http(s); strings are stripped of markup', () => {
  const r = normalizeReport({ agent: 'A<script>', kind: 'task.start', task: { title: '<img onerror=x>', link: 'javascript:alert(1)' } });
  assert.equal(r.agent, 'ascript');
  assert.equal(r.task.link, '');
  assert.ok(!/[<>]/.test(r.task.title));
});

test('dayOf uses Israel time', () => {
  assert.equal(dayOf(Date.parse('2026-11-04T22:30:00Z')), '2026-11-05');
});

/* ---------------- auth ---------------- */
const env = { OFFICE_PASSWORD: 'correct horse', AGENT_TOKEN_TAB: 'tok-tab', AGENT_TOKEN_INSTINCT: 'tok-inst', INGEST_TOKEN: 'legacy' };
const req = (headers) => new Request('https://office.test/api/ingest', { method: 'POST', headers });

test('session cookie round-trip, tamper and expiry', async () => {
  const v = await makeSession(env, T0);
  assert.ok(await verifySession(env, v, T0 + 1000));
  assert.ok(!(await verifySession(env, v.replace(/.$/, c => (c === 'A' ? 'B' : 'A')), T0)));
  const [, exp] = v.split('.');
  assert.ok(!(await verifySession(env, `v1.${Number(exp) + 1}.${v.split('.')[2]}`, T0)));
  assert.ok(!(await verifySession(env, v, Number(exp) + 1)));
  assert.ok(!(await verifySession({ ...env, OFFICE_PASSWORD: 'changed' }, v, T0)), 'password change logs out');
  assert.ok(!(await verifySession({}, v, T0)), 'no secret -> nobody is logged in');
});

test('password check', () => {
  assert.ok(checkPassword(env, 'correct horse'));
  assert.ok(!checkPassword(env, 'correct hors'));
  assert.ok(!checkPassword({}, ''));
  assert.ok(!safeEqual('', ''));
});

test('per-agent bearer tokens decide the agent; legacy token stays valid', () => {
  assert.deepEqual(writerFor(req({ Authorization: 'Bearer tok-tab' }), env), { ok: true, agent: 'tab' });
  assert.deepEqual(writerFor(req({ Authorization: 'Bearer tok-inst' }), env), { ok: true, agent: 'instinct' });
  assert.deepEqual(writerFor(req({ Authorization: 'Bearer nope' }), env), { ok: false });
  assert.deepEqual(writerFor(req({ 'X-Ingest-Token': 'legacy' }), env), { ok: true, agent: null });
  assert.deepEqual(writerFor(req({}), env), { ok: false });
  assert.deepEqual(tokenAgents(env).sort(), ['instinct', 'tab']);
});

test('task.queued puts planned work in the "to do" column without changing status', () => {
  const { a, t } = run([
    { agent: 'nova', kind: 'task.start', task: { id: 'n1', title: 'Research' } },
    { agent: 'nova', kind: 'task.queued', task: { id: 'n2', title: 'Translate the deck' } },
    { agent: 'nova', kind: 'task.todo', task: { id: 'n3', title: 'Alias works too' } },
  ]);
  assert.equal(a.status, 'working');
  assert.equal(a.current.id, 'n1');
  assert.deepEqual(a.tasks.filter(x => x.status === 'queued').map(x => x.id).sort(), ['n2', 'n3']);
  // starting a queued task moves it to running
  const b = applyReport(a, normalizeReport({ agent: 'nova', kind: 'task.start', task: { id: 'n2', title: 'Translate the deck' } }, t + 1000), t + 1000);
  assert.equal(b.tasks.find(x => x.id === 'n2').status, 'running');
  // a late task.queued never demotes a running/done task
  const c = applyReport(b, normalizeReport({ agent: 'nova', kind: 'task.queued', task: { id: 'n2', title: 'Translate the deck' } }, t + 2000), t + 2000);
  assert.equal(c.tasks.find(x => x.id === 'n2').status, 'running');
});

test('heartbeat recent[] understands queued results', () => {
  const { a } = run([{ agent: 'nova', kind: 'heartbeat', status: 'idle', recent: [{ id: 'q1', title: 'Later', result: 'queued' }, { id: 'd1', title: 'Done', result: 'ok' }] }]);
  assert.equal(a.tasks.find(x => x.id === 'q1').status, 'queued');
  assert.equal(a.tasks.find(x => x.id === 'q1').ended, undefined);
  assert.equal(a.tasks.find(x => x.id === 'd1').status, 'done');
});

test('task.done note is kept on the task so the board card shows what was done', () => {
  const { a } = run([
    { agent: 'hermes', kind: 'task.start', task: { id: 'r1', title: 'סבב מענה לבקשה' } },
    { agent: 'hermes', kind: 'task.done', task: { id: 'r1' }, note: 'ענה לאורי בוואטסאפ: מחר 10:00 נקבעה פגישה עם רועי' },
  ]);
  assert.equal(a.tasks[0].status, 'done');
  assert.equal(a.tasks[0].note, 'ענה לאורי בוואטסאפ: מחר 10:00 נקבעה פגישה עם רועי');
});

test('task.done without note keeps the note reported at start', () => {
  const { a } = run([
    { agent: 'hermes', kind: 'task.start', task: { id: 'b1', title: 'מענה לאורי' }, note: 'בודק את לוח השנה' },
    { agent: 'hermes', kind: 'task.done', task: { id: 'b1' } },
  ]);
  assert.equal(a.tasks[0].status, 'done');
  assert.equal(a.tasks[0].note, 'בודק את לוח השנה');
});
