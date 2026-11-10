import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { EventHub } from '../server/hub.js';
import { makeSession } from '../server/auth.js';
import { createBoardClient, slackTaskMessage } from '../integrations/board-agent.js';

async function setup(extraEnv = {}) {
  const data = new Map(); const sent = [];
  const st = { storage: {
    async get(k) { return Array.isArray(k) ? new Map(k.filter(x => data.has(x)).map(x => [x, structuredClone(data.get(x))])) : structuredClone(data.get(k)); },
    async put(k, v) { if (typeof k === 'object') for (const [key, val] of Object.entries(k)) data.set(key, structuredClone(val)); else data.set(k, structuredClone(v)); },
    async delete(keys) { for (const k of [].concat(keys)) data.delete(k); },
    async list({ prefix }) { return new Map([...data].filter(([k]) => k.startsWith(prefix))); },
  }, blockConcurrencyWhile: fn => fn(), getWebSockets: () => [{ send: m => sent.push(JSON.parse(m)) }] };
  let hub = new EventHub(st); await new Promise(r => setTimeout(r, 0));
  const env = { OFFICE_PASSWORD: 'test-only-password', AGENT_TOKEN_INSTINCT: 'i', AGENT_TOKEN_HERMES: 'h', AGENT_TOKEN_TAB: 't', INGEST_TOKEN: 'legacy', ...extraEnv,
    HUB: { idFromName: () => '', get: () => ({ fetch: (url, init) => hub.fetch(new Request(url, init)) }) } };
  const cookie = 'ao_session=' + await makeSession(env);
  const call = async (path, body, auth = 'owner', headers = {}) => worker.fetch(new Request('https://office.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(auth === 'owner' ? { Cookie: cookie } : auth ? { Authorization: 'Bearer ' + auth } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  const create = (agent = 'all', requestId = '12345678-1234-1234-1234-123456789012', title = 'משימת בדיקה בדיונית') => call('/api/tasks', { agent, requestId, title, note: 'דמו מקומי בלבד' });
  return { call, create, sent, data, restart: async () => { hub = new EventHub(st); await new Promise(r => setTimeout(r, 0)); } };
}
const json = async r => ({ status: r.status, ...(await r.json()) });

test('board: owner-only, CSRF, malformed, unavailable assignee and bounded body', async () => {
  const { call } = await setup();
  const body = { title: 'x', agent: 'tab', requestId: '12345678-12345678' };
  assert.equal((await call('/api/tasks', body, null)).status, 401);
  assert.equal((await call('/api/tasks', body, 't')).status, 401);
  assert.equal((await call('/api/tasks', body, 'owner', { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await call('/api/tasks', { ...body, agent: 'ghost' })).status, 400);
  assert.equal((await call('/api/tasks', { ...body, requestId: '' })).status, 400);
  assert.equal((await call('/api/tasks', { ...body, note: 'x'.repeat(33000) })).status, 400);
});

test('board: all creates 3 durable independent assignments; duplicate key returns same tasks', async () => {
  const { call, create, restart } = await setup();
  const a = await json(await create()); assert.equal(a.tasks.length, 3);
  assert.deepEqual(a.tasks.map(t => t.agent), ['instinct', 'hermes', 'tab']);
  assert.ok(a.tasks.every(t => t.source === 'office-owner-session' && !t.claimToken));
  const b = await json(await create()); assert.equal(b.duplicate, true); assert.deepEqual(b.tasks, a.tasks);
  assert.equal((await create('all', a.tasks[0].requestId, 'different')).status, 409);
  await restart(); assert.equal((await json(await call('/api/tasks'))).tasks.length, 3);
  assert.equal((await json(await call('/api/agents'))).agents.reduce((n, a) => n + a.tasks.length, 0), 3);
});

test('board: inbox isolation; relay only Instinct; legacy token cannot read; no claim leaks', async () => {
  const { call, create } = await setup(); await create();
  const t = await json(await call('/api/inbox', undefined, 't')); assert.equal(t.tasks.length, 1); assert.equal(t.tasks[0].agent, 'tab');
  assert.equal((await call('/api/inbox?relay=1', undefined, 't')).status, 403);
  assert.equal((await call('/api/inbox', undefined, 'legacy')).status, 401);
  assert.equal((await json(await call('/api/inbox?relay=1', undefined, 'i'))).tasks.length, 3);
  const id = t.tasks[0].id;
  assert.equal((await call('/api/inbox/' + id + '/claim', {}, 'h')).status, 403);
  const claim = await json(await call('/api/inbox/' + id + '/claim', {}, 't'));
  assert.ok(claim.claimToken);
  assert.equal((await call('/api/inbox/' + id + '/claim', {}, 't')).status, 409);
  assert.equal((await call('/api/inbox/' + id + '/claim', { claimToken: claim.claimToken }, 't')).status, 200);
  for (const path of ['/api/tasks', '/api/agents', '/api/events', '/api/replay']) assert.ok(!JSON.stringify(await json(await call(path))).includes(claim.claimToken), path);
});

test('board: mock recipient executes -> progress -> done with result; duplicate completion idempotent', async () => {
  const { call, create, restart } = await setup();
  const task = (await json(await create('hermes'))).tasks[0];
  const report = (kind, note, claimToken, status) => call('/api/ingest', { kind, note, claimToken, status, task: { id: task.id, link: 'https://example.com/result' } }, 'h');
  assert.equal((await report('task.done', 'fake')).status, 403);
  const claim = await json(await call('/api/inbox/' + task.id + '/claim', {}, 'h'));
  await restart();
  assert.equal((await report('task.progress', 'בודק', claim.claimToken)).status, 200);
  assert.equal((await report('task.done', '', claim.claimToken)).status, 400);
  const longResult = 'תוצאה '.repeat(100);
  assert.equal((await report('task.done', longResult, claim.claimToken)).status, 200);
  assert.equal((await report('task.done', longResult, claim.claimToken)).status, 200);
  assert.equal((await report('task.start', 'again', claim.claimToken)).status, 409);
  const board = (await json(await call('/api/tasks'))).tasks[0];
  assert.equal(board.status, 'done'); assert.equal(board.result, longResult.trim());
  const a = (await json(await call('/api/agents'))).agents.find(a => a.id === 'hermes');
  assert.equal(a.tasks[0].board.result, longResult.trim()); assert.equal(a.tasks[0].status, 'done');
});

test('board: waiting approval is blocked, not completed; delivery receipt is not execution', async () => {
  const { call, create } = await setup(); const task = (await json(await create('tab'))).tasks[0];
  const path = '/api/inbox/' + task.id;
  assert.equal((await call(path + '/delivery', { delivery: 'delivered', slackTs: '1794160521.405459' }, 't')).status, 403);
  assert.equal((await call(path + '/delivery', { delivery: 'delivered' }, 'i')).status, 400);
  await call(path + '/delivery', { delivery: 'error', note: 'Slack unavailable' }, 'i');
  assert.equal((await call('/api/tasks/' + task.id + '/retry', {})).status, 200);
  await call(path + '/delivery', { delivery: 'delivered', slackTs: '1794160521.405459' }, 'i');
  assert.equal((await json(await call('/api/tasks'))).tasks[0].status, 'queued');
  const claim = await json(await call(path + '/claim', {}, 't'));
  await call('/api/ingest', { kind: 'task.done', status: 'blocked', note: 'ממתין לאישור מיזוג של אורי', claimToken: claim.claimToken, task: { id: task.id } }, 't');
  assert.equal((await json(await call('/api/tasks'))).tasks[0].status, 'blocked');
  assert.equal((await call('/api/tasks/' + task.id + '/retry', {})).status, 409);
});

test('board: Slack formatter addresses only chosen agent, escapes extra mentions, no token', () => {
  const message = slackTaskMessage({ id: 'board-test-tab', title: 'בדיקה <@everyone>', note: '<script>&', agent: 'tab' });
  assert.match(message, /^<@U0CELHLPWGL>/); assert.match(message, /&lt;@everyone&gt;/);
  assert.ok(!message.includes('U0CF7ASDK0R')); assert.match(message, /claim/);
  assert.throws(() => slackTaskMessage({ agent: 'instinct' }));
});

test('board: adapter uses scoped token and keeps task id/claim/result intact', async () => {
  const { call, create } = await setup(); await create('tab');
  const client = createBoardClient('t', 'https://office.test', (url, init) => call(new URL(url).pathname + new URL(url).search, init.body ? JSON.parse(init.body) : undefined, 't'));
  const task = (await client.inbox()).tasks[0]; const c = await client.claim(task.id);
  await client.update(task.id, c.claimToken, 'task.progress', 'עובד');
  await client.update(task.id, c.claimToken, 'task.done', 'בדיקה מקומית הושלמה');
  assert.equal((await client.inbox()).tasks[0].status, 'done');
});

test('board: restart retains long results in separate bounded storage entries; stale waiting is visible', async () => {
  const { call, create, data, restart } = await setup();
  const task = (await json(await create('tab'))).tasks[0];
  assert.ok(data.has('board:' + task.id)); assert.equal(data.has('board'), false);
  const saved = data.get('board:' + task.id); saved.updated = Date.now() - 31 * 60_000;
  data.set('board:' + task.id, saved); await restart();
  const b = (await json(await call('/api/tasks'))).tasks[0]; assert.equal(b.stale, true);
  const { claimToken } = await json(await call('/api/inbox/' + task.id + '/claim', {}, 't'));
  await call('/api/ingest', { kind: 'task.done', status: 'blocked', task: { id: task.id }, claimToken, note: 'צריך אישור' }, 't');
  await restart();
  // The same saved receipt may resume after the owner decision; no new unclaimed execution.
  assert.equal((await call('/api/inbox/' + task.id + '/claim', {}, 't')).status, 409);
  assert.equal((await call('/api/ingest', { kind: 'task.progress', task: { id: task.id }, claimToken, note: 'אחרי קבלת החלטה מאומתת' }, 't')).status, 200);
});

test('board: concurrent duplicate create/claim never produces a second execution receipt', async () => {
  const { create, call } = await setup();
  const created = await Promise.all([create('tab'), create('tab'), create('tab')]);
  const lists = await Promise.all(created.map(json));
  assert.equal(new Set(lists.flatMap(r => r.tasks.map(t => t.id))).size, 1);
  const id = lists[0].tasks[0].id;
  const claims = await Promise.all([call('/api/inbox/' + id + '/claim', {}, 't'), call('/api/inbox/' + id + '/claim', {}, 't')]);
  assert.deepEqual(claims.map(r => r.status).sort(), [200,409]);
});

test('presence: running owner claim survives idle, restart and another task completing; last settlement idles', async () => {
  const { call, create, restart, data, sent } = await setup();
  const first = (await json(await create('instinct'))).tasks[0];
  const claim = await json(await call('/api/inbox/' + first.id + '/claim', {}, 'i'));
  const view = async () => (await json(await call('/api/agents'))).agents.find(a => a.id === 'instinct');
  assert.equal((await view()).status, 'working');
  await call('/api/ingest', { agent: 'instinct', kind: 'heartbeat', status: 'idle' }, 'i');
  assert.equal((await view()).status, 'working');
  assert.equal((await view()).current.id, first.id);
  assert.equal(sent.filter(x => x.type === 'agent').at(-1).agent.status, 'working');
  const second = (await json(await create('instinct', '12345678-1234-1234-1234-123456789099'))).tasks[0];
  const claim2 = await json(await call('/api/inbox/' + second.id + '/claim', {}, 'i'));
  await call('/api/ingest', { agent: 'instinct', kind: 'task.done', task: { id: second.id }, note: 'done locally', claimToken: claim2.claimToken }, 'i');
  assert.equal((await view()).status, 'working');
  assert.equal((await view()).current.id, first.id);
  // Even after an agent loses connectivity, retain the open claim and its age,
  // never invent a fresh heartbeat. Durable tasks outlive the 15-card history.
  const saved = data.get('agent:instinct'); saved.lastSeen = Date.now() - 86400_000; saved.tasks = [];
  data.set('agent:instinct', saved);
  const board = data.get('board:' + first.id); board.updated = Date.now() - 3600_000; data.set('board:' + first.id, board);
  await restart();
  assert.equal((await view()).status, 'working');
  assert.equal((await view()).presenceStale, true);
  assert.equal((await view()).lastSeen, saved.lastSeen);
  await call('/api/ingest', { agent: 'instinct', kind: 'task.done', task: { id: first.id }, note: 'done locally', claimToken: claim.claimToken }, 'i');
  assert.equal((await view()).status, 'idle');
  assert.equal((await view()).current, null);
});

test('notify: every assignee gets one @-mention in #agents, mapping configurable, receipt per task, non-owner tasks skip', async () => {
  const { notifyAgents, notifyInstinct } = await import('../server/notify.js');
  assert.equal(notifyInstinct, notifyAgents);
  const calls = [], deliveries = [];
  const transport = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ ok: true, ts: '1794300000.000' + (100 + calls.length) }) }; };
  const stub = { fetch: (u, i) => { deliveries.push(JSON.parse(i.body)); return new Response('{}'); } };
  const env = { SLACK_NOTIFY_TOKEN: 'xoxb-test-secret' };
  const mk = (agent, extra = {}) => ({ id: 'board-a-' + agent, agent, source: 'office-owner-session', status: 'queued', title: 'x <@everyone>', note: '', ...extra });
  const tasks = [mk('instinct'), mk('hermes'), mk('tab'), mk('tab', { id: 'board-b-tab', source: 'agent-report' }), mk('hermes', { id: 'board-c-hermes', status: 'running' }), mk('nobody', { id: 'board-d-nobody' })];
  const out = await notifyAgents(env, tasks, stub, transport);
  assert.equal(calls.length, 3); assert.deepEqual(out.map(o => o.agent), ['instinct', 'hermes', 'tab']);
  const bodies = calls.map(c => JSON.parse(c.init.body));
  assert.ok(bodies.every(b => b.channel === 'C0CFVFY4684'));
  assert.match(bodies[0].text, /^<@U0CDK0BDWQ2>/); assert.match(bodies[1].text, /^<@U0CF7ASDK0R>/); assert.match(bodies[2].text, /^<@U0CELHLPWGL>/);
  for (const b of bodies) {
    assert.equal((b.text.match(/<@U[A-Z0-9]+>/g) || []).length, 1, 'exactly one mention per message');
    assert.ok(!b.text.includes('@everyone>')); assert.match(b.text, /GET \/api\/inbox/); assert.match(b.text, /\/api\/inbox\/board-a-[a-z]+\/claim/);
  }
  assert.ok(!JSON.stringify(out).includes('xoxb'));
  assert.deepEqual(deliveries.map(d => [d.id, d.delivery, d.note]), [['board-a-instinct', 'delivered', ''], ['board-a-hermes', 'delivered', ''], ['board-a-tab', 'delivered', '']]);
  assert.deepEqual(await notifyAgents({}, tasks, stub, transport), { skipped: 'not configured' });
  // mapping and channel are configurable by env; a bad mapping falls back to the defaults
  calls.length = 0;
  await notifyAgents({ ...env, SLACK_AGENTS_CHANNEL: 'C999', SLACK_AGENT_MENTIONS: '{"tab":"UCUSTOM123"}' }, [mk('tab'), mk('hermes')], stub, transport);
  assert.equal(JSON.parse(calls[0].init.body).channel, 'C999'); assert.match(JSON.parse(calls[0].init.body).text, /^<@UCUSTOM123>/); assert.match(JSON.parse(calls[1].init.body).text, /^<@U0CF7ASDK0R>/);
  calls.length = 0;
  await notifyAgents({ ...env, SLACK_AGENT_MENTIONS: '{not json' }, [mk('tab')], stub, transport);
  assert.match(JSON.parse(calls[0].init.body).text, /^<@U0CELHLPWGL>/);
  const failing = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: 'not_in_channel' }) });
  await notifyAgents(env, [mk('hermes')], stub, failing);
  assert.equal(deliveries.at(-1).delivery, 'error'); assert.match(deliveries.at(-1).note, /not_in_channel/);
  const throwing = async () => { throw new Error('net'); };
  await notifyAgents(env, [mk('tab')], stub, throwing);
  assert.equal(deliveries.at(-1).note, 'Slack send failed');
});

test('slackTaskMessage: Instinct only with the explicit wake flag; reminder line only when asked', () => {
  assert.throws(() => slackTaskMessage({ id: 'board-x', agent: 'instinct', title: 't', note: '' }));
  assert.match(slackTaskMessage({ id: 'board-x', agent: 'instinct', title: 't', note: '' }, { wakeInstinct: true }), /^<@U0CDK0BDWQ2>/);
  assert.ok(!slackTaskMessage({ id: 'board-x', agent: 'tab', title: 't', note: '' }).includes('תזכורת'));
  assert.match(slackTaskMessage({ id: 'board-x', agent: 'tab', title: 't', note: '' }, { reminderMinutes: 12 }), /תזכורת.*12/);
});

test('notify: route posts for each assignee once on first creation only, never duplicate or non-owner; receipts stored; execution still needs claim', async () => {
  const { call, create } = await setup({ SLACK_NOTIFY_TOKEN: 'xoxb-test-secret' });
  const sends = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, i) => { sends.push({ u, body: JSON.parse(i.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, ts: '1794300000.00' + (200 + sends.length) }) }; };
  try {
    assert.equal((await call('/api/tasks', { agent: 'all', requestId: 'abcdefgh-1234-5678-9999', title: 'x' }, null)).status, 401);
    assert.equal((await call('/api/tasks', { agent: 'all', requestId: 'abcdefgh-1234-5678-9999', title: 'x' }, 'i')).status, 401);
    assert.equal(sends.length, 0);
    const a = await json(await create('all'));
    assert.equal(sends.length, 3); assert.ok(sends.every(s => s.u === 'https://slack.com/api/chat.postMessage'));
    assert.deepEqual(sends.map(s => s.body.text.slice(0, 14)).sort(), ['<@U0CDK0BDWQ2>', '<@U0CELHLPWGL>', '<@U0CF7ASDK0R>']);
    await json(await create('all')); assert.equal(sends.length, 3, 'duplicate create does not re-ping');
    await json(await create('tab', '99999999-1234-1234-1234-123456789012')); assert.equal(sends.length, 4);
    assert.match(sends[3].body.text, /^<@U0CELHLPWGL>/);
    const list = (await json(await call('/api/tasks'))).tasks;
    assert.ok(list.filter(x => x.requestId === a.tasks[0].requestId).every(x => x.delivery === 'delivered' && x.status === 'queued' && /^\d+\.\d+$/.test(x.slackTs)));
    const t = list.find(x => x.id === a.tasks[0].id);
    const c1 = await json(await call('/api/inbox/' + t.id + '/claim', {}, 'i'));
    assert.equal((await call('/api/inbox/' + t.id + '/claim', {}, 'i')).status, 409); assert.ok(c1.claimToken);
  } finally { globalThis.fetch = realFetch; }
});

test('board: unclaimed state appears after 10 minutes and clears on claim; re-ping is owner-only, re-posts, counts', async () => {
  const { notPickedUp, PICKUP_WARN_MIN } = await import('../board-state.js');
  assert.equal(PICKUP_WARN_MIN, 10);
  assert.equal(notPickedUp({ status: 'queued', created: 1000 }, 1000 + 9 * 60_000), false);
  assert.equal(notPickedUp({ status: 'queued', created: 1000 }, 1000 + 10 * 60_000 + 1), true);
  assert.equal(notPickedUp({ status: 'running', created: 1000 }, 1000 + 60 * 60_000), false);
  const { call, create, data, restart } = await setup({ SLACK_NOTIFY_TOKEN: 'xoxb-test-secret' });
  const sends = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, i) => { sends.push(JSON.parse(i.body)); return { ok: true, status: 200, json: async () => ({ ok: true, ts: '1794300000.00' + (300 + sends.length) }) }; };
  try {
    const task = (await json(await create('hermes'))).tasks[0];
    assert.equal((await json(await call('/api/tasks'))).tasks[0].unclaimed, false);
    const saved = data.get('board:' + task.id); saved.created = Date.now() - 11 * 60_000; saved.updated = saved.created; data.set('board:' + task.id, saved); await restart();
    assert.equal((await json(await call('/api/tasks'))).tasks[0].unclaimed, true);
    // auth: owner only, CSRF-checked, agents cannot ping
    assert.equal((await call('/api/tasks/' + task.id + '/ping', {}, null)).status, 401);
    assert.equal((await call('/api/tasks/' + task.id + '/ping', {}, 'h')).status, 401);
    assert.equal((await call('/api/tasks/' + task.id + '/ping', {}, 'owner', { Origin: 'https://evil.test' })).status, 403);
    assert.equal(sends.length, 1);
    const r = await json(await call('/api/tasks/' + task.id + '/ping', {}));
    assert.equal(r.status, 200); assert.equal(r.sent, true);
    assert.equal(sends.length, 2); assert.match(sends[1].text, /^<@U0CF7ASDK0R>\n⏰ תזכורת/);
    const after = (await json(await call('/api/tasks'))).tasks[0];
    assert.equal(after.pings, 1); assert.equal(after.delivery, 'delivered'); assert.equal(after.unclaimed, true, 'still unclaimed until the agent claims');
    // the old retry route still works (failed delivery only) and re-posts for any agent
    assert.equal((await call('/api/tasks/' + task.id + '/retry', {})).status, 409);
    const bad = data.get('board:' + task.id); bad.delivery = 'error'; data.set('board:' + task.id, bad); await restart();
    assert.equal((await json(await call('/api/tasks/' + task.id + '/retry', {}))).sent, true); assert.equal(sends.length, 3);
    assert.equal((await json(await call('/api/tasks'))).tasks[0].delivery, 'delivered');
    // claim clears the warning and the ping is no longer allowed
    await call('/api/inbox/' + task.id + '/claim', {}, 'h');
    const claimed = (await json(await call('/api/tasks'))).tasks[0];
    assert.equal(claimed.status, 'running'); assert.equal(claimed.unclaimed, false);
    assert.equal((await call('/api/tasks/' + task.id + '/ping', {})).status, 409);
  } finally { globalThis.fetch = realFetch; }
});

test('board: ping without Slack configured returns the task to pending for the relay, no post, no secret', async () => {
  const { call, create } = await setup();
  const task = (await json(await create('tab'))).tasks[0];
  const r = await json(await call('/api/tasks/' + task.id + '/ping', {}));
  assert.equal(r.status, 200); assert.ok(!r.sent); assert.equal(r.task.delivery, 'pending'); assert.ok(!JSON.stringify(r).includes('claimToken'));
});

test('board page: not-picked-up warning and owner-only ping button are wired to the ping route', async () => {
  const { readFile } = await import('node:fs/promises');
  const main = await readFile(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(main, /board-warn/); assert.match(main, /kwarn/, 'desktop side panel shows it too'); assert.match(main, /board-ping/); assert.match(main, /\/ping/);
  assert.match(main, /waiting && auth\.loggedIn/, 'ping button only for the logged-in owner');
  assert.match(main, /from '\.\/board-state\.js\?v=1'/);
});
