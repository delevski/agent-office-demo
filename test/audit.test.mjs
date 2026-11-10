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


const ok = async r => { const j = await r.json(); return { status: r.status, ...j }; };
const MIN = 60_000;
const iso = ms => new Date(ms).toISOString();

test('audit: pr.approved is validated, needs a verbatim quote, and records who REPORTED it', async () => {
  const { call } = await setup();
  const good = { kind: 'pr.approved', pr: 16, repo: 'delevski/agent-office-demo', approver: 'Ori', channel: 'WhatsApp', quote: 'תמזג ותעלה', title: 'New task modal' };
  assert.equal((await call('/api/ingest', good, null)).status, 401);
  assert.equal((await call('/api/ingest', { ...good, quote: '' }, 't')).status, 400);
  assert.equal((await call('/api/ingest', { ...good, channel: 'carrier-pigeon' }, 't')).status, 400);
  assert.equal((await call('/api/ingest', { ...good, pr: 'abc' }, 't')).status, 400);
  assert.equal((await call('/api/ingest', { ...good, approver: '' }, 't')).status, 400);
  // an agent can never report another agent's approval, nor write as another agent
  const spoof = await ok(await call('/api/ingest', { ...good, approver: 'hermes' }, 't')); assert.equal(spoof.status, 400);
  assert.match(JSON.stringify(spoof.details), /approver/);
  assert.equal((await call('/api/ingest', { ...good, reported_by: 'hermes' }, 't')).status, 403);
  assert.equal((await call('/api/ingest', { ...good, agent: 'hermes' }, 't')).status, 403);
  const r = await ok(await call('/api/ingest', good, 't'));
  assert.equal(r.status, 200); assert.equal(r.reported_by, 'tab');
  const a = await ok(await call('/api/audit?pr=16')); const pr = a.items[0];
  assert.equal(pr.kind, 'pr'); assert.equal(pr.status, 'approved');
  assert.deepEqual({ t: pr.steps[0].type, actor: pr.steps[0].actor, by: pr.steps[0].reported_by, ch: pr.steps[0].channel, q: pr.steps[0].quote }, { t: 'pr.approved', actor: 'ori', by: 'tab', ch: 'whatsapp', q: 'תמזג ותעלה' });
  // a retry of the same approval does not duplicate the row
  await call('/api/ingest', good, 't');
  assert.equal((await ok(await call('/api/audit?pr=16'))).items[0].steps.length, 1);
});

test('audit: message needs from == token, a different recipient and caps the text', async () => {
  const { call } = await setup();
  const m = { kind: 'message', to: 'instinct', channel: 'slack', text: 'דיפלוי של #16 בבקשה', link: 'https://example.com/x' };
  assert.equal((await call('/api/ingest', m, null)).status, 401);
  assert.equal((await call('/api/ingest', { ...m, from: 'hermes' }, 't')).status, 403);
  assert.equal((await call('/api/ingest', { ...m, to: 'tab' }, 't')).status, 400);
  assert.equal((await call('/api/ingest', { ...m, to: '' }, 't')).status, 400);
  assert.equal((await call('/api/ingest', { ...m, text: '  ' }, 't')).status, 400);
  assert.equal((await call('/api/ingest', { ...m, channel: 'pigeon' }, 't')).status, 400);
  assert.equal((await call('/api/ingest', { ...m, from: 'tab', text: 'א'.repeat(900) }, 't')).status, 200);
  const a = await ok(await call('/api/audit?type=message'));
  assert.equal(a.items.length, 1); assert.equal(a.items[0].ev.text.length, 500);
  assert.equal(a.items[0].ev.actor, 'tab'); assert.equal(a.items[0].ev.to, 'instinct');
});

test('audit: a PR lifecycle from opened to deployed is ONE row with ordered steps', async () => {
  const { call } = await setup();
  const t0 = Date.now() - 50 * MIN, repo = 'delevski/agent-office-demo';
  await call('/api/ingest', { kind: 'pr.opened', pr: 15, repo, title: 'Ping all', ts: iso(t0) }, 'h');
  await call('/api/ingest', { kind: 'pr.reviewed', pr: 15, repo, author_agent: 'hermes', verdict: 'approved', summary: 'looks right', ts: iso(t0 + 5 * MIN) }, 't');
  await call('/api/ingest', { kind: 'pr.approved', pr: 15, repo, approver: 'ori', channel: 'whatsapp', quote: 'מצויין תמזג ותעלה', ts: iso(t0 + 10 * MIN) }, 't');
  await call('/api/ingest', { kind: 'pr.merged', pr: 15, repo, sha: 'ebb3dd71f9a806057edbf1f5d4d7291b3775dffc', ts: iso(t0 + 12 * MIN) }, 't');
  await call('/api/ingest', { kind: 'deploy', target: 'office.ordel.dev', repo, prs: [15, 16], version: 'd1612b8', ts: iso(t0 + 20 * MIN) }, 'i');
  const a = await ok(await call('/api/audit'));
  const rows = a.items.filter(i => i.kind === 'pr');
  assert.equal(rows.length, 2, 'PR 15 and the PR 16 the deploy mentions'); // #16 has only its deploy step
  const row = rows.find(r => r.pr === '15');
  assert.deepEqual(row.steps.map(s => s.type), ['pr.opened', 'pr.reviewed', 'pr.approved', 'pr.merged', 'deploy']);
  assert.deepEqual(row.steps.map(s => s.actor), ['hermes', 'tab', 'ori', 'tab', 'instinct']);
  assert.equal(row.status, 'deployed'); assert.equal(row.steps[3].sha.slice(0, 7), 'ebb3dd7');
  assert.equal(row.steps[1].verdict, 'approved'); assert.equal(row.steps[2].reported_by, 'tab');
  assert.equal(a.items.filter(i => i.kind === 'event').length, 0, 'the deploy lives inside its PRs, not as a loose row');
  // filters
  assert.equal((await ok(await call('/api/audit?agent=hermes'))).items.length, 1);
  assert.equal((await ok(await call('/api/audit?agent=nova'))).items.length, 0);
  assert.equal((await ok(await call('/api/audit?pr=' + encodeURIComponent(repo + '#15')))).items.length, 1);
  assert.equal((await ok(await call('/api/audit?pr=999'))).items.length, 0);
  assert.equal((await ok(await call('/api/audit?type=message'))).items.length, 0);
  assert.equal((await ok(await call('/api/audit?type=deploy'))).items.length, 1);
  assert.equal((await ok(await call('/api/audit?day=2001-01-01'))).items.length, 0);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
  assert.ok((await ok(await call('/api/audit?day=' + today))).items.length >= 0);
  assert.ok(a.days.length >= 1); assert.deepEqual(a.agents.filter(x => ['hermes', 'tab', 'instinct', 'ori'].includes(x)).sort(), ['hermes', 'instinct', 'ori', 'tab']);
});

test('audit: owner only. no cookie 401, agent token 403, never in the agent state', async () => {
  const { call } = await setup();
  await call('/api/ingest', { kind: 'message', to: 'hermes', channel: 'slack', text: 'hi' }, 't');
  assert.equal((await call('/api/audit', undefined, null)).status, 401);
  assert.equal((await call('/api/audit', undefined, 't')).status, 403);
  assert.equal((await call('/api/audit', undefined, 'i')).status, 403);
  assert.equal((await call('/api/audit', undefined, 'nope')).status, 401);
  assert.equal((await call('/api/audit', undefined, 'legacy')).status, 401);
  assert.equal((await call('/api/audit')).status, 200);
});

test('audit: board tasks show created by / assigned to / claimed / done, cancel is owner only and stops the agent', async () => {
  const { call, create } = await setup();
  const [tab, hermes] = [(await json(await create('tab'))).tasks[0], (await json(await create('hermes', '12345678-1234-1234-1234-123456789098'))).tasks[0]];
  const claim = await json(await call('/api/inbox/' + tab.id + '/claim', {}, 't'));
  await call('/api/ingest', { kind: 'task.done', note: 'בוצע', claimToken: claim.claimToken, task: { id: tab.id } }, 't');
  assert.equal((await call('/api/tasks/' + hermes.id + '/cancel', {}, 'h')).status, 401);
  assert.equal((await call('/api/tasks/' + hermes.id + '/cancel', {}, null)).status, 401);
  assert.equal((await call('/api/tasks/' + hermes.id + '/cancel', {}, 'owner', { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await call('/api/tasks/' + hermes.id + '/cancel', {})).status, 200);
  assert.equal((await call('/api/tasks/' + hermes.id + '/cancel', {})).status, 409);
  assert.equal((await call('/api/tasks/' + tab.id + '/cancel', {})).status, 409, 'a done task cannot be cancelled');
  assert.equal((await call('/api/inbox/' + hermes.id + '/claim', {}, 'h')).status, 409, 'a cancelled task cannot be claimed');
  const a = await ok(await call('/api/audit?type=task'));
  const rowTab = a.items.find(i => i.key === tab.id), rowH = a.items.find(i => i.key === hermes.id);
  assert.deepEqual(rowTab.steps.map(s => s.type), ['task.created', 'task.claimed', 'task.done']);
  assert.equal(rowTab.from, 'ori'); assert.equal(rowTab.to, 'tab'); assert.equal(rowTab.status, 'done');
  assert.equal(rowH.status, 'cancelled');
  assert.equal((await json(await call('/api/inbox', undefined, 'h'))).tasks[0].status, 'cancelled');
});

test('tickets: an agent opens a ticket for ANOTHER agent; from is the token, Slack pings the assignee, audit shows it', async () => {
  const { call } = await setup({ SLACK_NOTIFY_TOKEN: 'xoxb-test-secret' });
  const sends = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, i) => { sends.push(JSON.parse(i.body)); return { ok: true, status: 200, json: async () => ({ ok: true, ts: '1794300000.00' + (500 + sends.length) }) }; };
  try {
    const t = { to: 'instinct', title: 'לפרוס את #16', note: 'ahead of the demo', link: 'https://github.com/delevski/agent-office-demo/pull/16' };
    assert.equal((await call('/api/inbox', t, null)).status, 401);
    assert.equal((await call('/api/inbox', t, 'legacy')).status, 401);
    assert.equal((await call('/api/inbox', t, 'owner')).status, 401, 'the owner cookie is not an agent');
    assert.equal((await call('/api/inbox', { ...t, to: 'tab' }, 't')).status, 400, 'not to yourself');
    assert.equal((await call('/api/inbox', { ...t, to: 'all' }, 't')).status, 400);
    assert.equal((await call('/api/inbox', { ...t, to: 'ghost' }, 't')).status, 400);
    assert.equal((await call('/api/inbox', { ...t, title: '' }, 't')).status, 400);
    assert.equal((await call('/api/inbox', { ...t, note: 'x'.repeat(1001) }, 't')).status, 400);
    assert.equal((await call('/api/inbox', { ...t, link: 'javascript:alert(1)' }, 't')).status, 400);
    const r = await ok(await call('/api/inbox', { ...t, from: 'hermes' }, 't')); // a spoofed "from" in the body is ignored: the token decides
    assert.equal(r.status, 200); assert.equal(r.task.from, 'tab'); assert.equal(r.task.agent, 'instinct'); assert.equal(r.task.source, 'agent-ticket');
    await new Promise(x => setTimeout(x, 20));
    assert.equal(sends.length, 1); assert.match(sends[0].text, /^<@U0CDK0BDWQ2>/); assert.match(sends[0].text, /טיקט מהסוכן tab/);
    assert.match(sends[0].text, /לא אישור של אורי/); assert.match(sends[0].text, /pull\/16/);
    assert.equal((await json(await call('/api/tasks'))).tasks[0].delivery, 'delivered');
    // appears for the assignee, claims like any task
    const inbox = await json(await call('/api/inbox', undefined, 'i')); assert.equal(inbox.tasks[0].id, r.task.id);
    assert.equal((await call('/api/inbox/' + r.task.id + '/claim', {}, 'i')).status, 200);
    // the same open ticket again is the same ticket, no second ping
    const again = await ok(await call('/api/inbox', t, 't')); assert.equal(again.duplicate, true);
    assert.equal(sends.length, 1);
    // audit
    const a = await ok(await call('/api/audit?type=task'));
    const row = a.items.find(i => i.key === r.task.id); assert.equal(row.from, 'tab'); assert.equal(row.to, 'instinct'); assert.equal(row.via, 'ticket');
    assert.deepEqual(row.steps.map(s => s.type), ['task.created', 'task.claimed']);
    // the owner can cancel it
    const hermesTicket = await ok(await call('/api/inbox', { ...t, to: 'hermes', title: 'אחר' }, 't'));
    assert.equal((await call('/api/tasks/' + hermesTicket.task.id + '/cancel', {})).status, 200);
  } finally { globalThis.fetch = realFetch; }
});

test('tickets: rate limit per agent, open-ticket cap, chain depth, requestId idempotence', async () => {
  const { call } = await setup();
  const mk = (n, extra = {}) => call('/api/inbox', { to: 'instinct', title: 'טיקט ' + n, ...extra }, 'h');
  for (let n = 0; n < 10; n++) assert.equal((await mk(n)).status, 200, 'ticket ' + n);
  const over = await ok(await mk(10)); assert.equal(over.status, 429); assert.ok(over.retry_after_s > 0);
  assert.equal((await call('/api/inbox', { to: 'instinct', title: 'מישהו אחר' }, 't')).status, 200, 'the limit is per agent');
  // requestId: same content is the same ticket (no new rate-limit slot), different content conflicts
  const rid = 'abcdefabcdef-1234-5678';
  const a = await ok(await call('/api/inbox', { to: 'instinct', title: 'מזהה', requestId: rid }, 't'));
  assert.equal((await ok(await call('/api/inbox', { to: 'instinct', title: 'מזהה', requestId: rid }, 't'))).duplicate, true);
  assert.equal((await call('/api/inbox', { to: 'instinct', title: 'אחר לגמרי', requestId: rid }, 't')).status, 409);
  assert.equal((await call('/api/inbox', { to: 'instinct', title: 'x', requestId: 'short' }, 't')).status, 400);
  // chain depth: a ticket made while working a ticket carries `parent`; the 4th hop is refused
  const { call: c2 } = await setup();
  let prev = (await ok(await c2('/api/inbox', { to: 'instinct', title: 'אחד' }, 't'))).task; let from = 'i', to = 'hermes', depthOk = 0;
  for (const [tok, nextTo] of [['i', 'hermes'], ['h', 'tab'], ['t', 'instinct'], ['i', 'hermes']]) {
    const r = await c2('/api/inbox', { to: nextTo, title: 'שרשרת ' + nextTo + depthOk, parent: prev.id }, tok);
    if (r.status === 200) { prev = (await r.json()).task; depthOk++; } else { assert.equal(r.status, 400); break; }
  }
  assert.equal(depthOk, 3);
});


test('audit UI: lazy-loaded, owner-only button, no static import', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8'), main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../audit-view.js', import.meta.url), 'utf8');
  assert.match(html, /id="btn-audit"[^>]*>/); assert.match(html.match(/<button[^>]*id="btn-audit"[^>]*>/)[0], /live-only/);
  assert.match(html, /id="audit-ov"/); assert.ok(!/(?:href|src)="[^"]*audit/.test(html), 'neither file is requested at page start');
  assert.ok(!/^import .*audit-view/m.test(main)); assert.match(main, /import\('\.\/audit-view\.js\?v=\d+'\)/); assert.match(main, /audit\.css\?v=\d+/);
  assert.match(main, /\/api\/audit/);
});

test('audit UI: renders a PR row with the approval quote and "reported by", escaping markup', async () => {
  const { createAudit } = await import('../audit-view.js');
  const els = () => ({ innerHTML: '', textContent: '', addEventListener() {}, contains: () => false, offsetParent: {} });
  globalThis.document = { activeElement: null, hidden: false };
  const body = els(), filters = els(), sub = els(), ts = Date.parse('2026-11-10T09:13:00Z');
  const data = { now: ts + 60000, total: 1, truncated: false, counts: { pr: 1, message: 0, task: 0, deploy: 0 }, days: [{ day: '2026-11-10', count: 2 }], agents: ['ori', 'tab'], repos: [],
    items: [{ kind: 'pr', key: 'r#16', pr: '16', repo: 'o/r', title: '<img src=x onerror=alert(1)>', link: 'javascript:alert(1)', status: 'approved', ts, steps: [
      { id: 'a', ts, type: 'pr.approved', actor: 'ori', reported_by: 'tab', channel: 'whatsapp', quote: '<script>x</script> תמזג' }] }] };
  const api = createAudit({ body, filters, sub, load: async () => data });
  await api.start(); await new Promise(r => setTimeout(r, 10)); api.stop();
  assert.ok(!/<img|<script/.test(body.innerHTML), 'markup is escaped'); assert.match(body.innerHTML, /&lt;script&gt;/);
  assert.match(body.innerHTML, /דווח ע״י Tab/); assert.match(body.innerHTML, /WhatsApp/); assert.match(body.innerHTML, /תמזג/);
  assert.ok(!/href="javascript:/.test(body.innerHTML), 'unsafe links are dropped');
  assert.match(body.innerHTML, /אושר/);
});

test('board-agent client: ticket and audit helpers hit the documented endpoints with the agent token', async () => {
  const calls = [];
  const c = createBoardClient('tok', 'https://x.test', async (u, i) => { calls.push({ u, body: i.body && JSON.parse(i.body), auth: i.headers.Authorization }); return { ok: true, json: async () => ({ ok: true }) }; });
  await c.ticket({ to: 'instinct', title: 't', note: 'n', link: 'https://a.b/c' });
  await c.prApproved({ pr: 16, repo: 'o/r', channel: 'whatsapp', quote: 'כן' });
  await c.message({ to: 'tab', text: 'hi' });
  await c.deploy({ target: 'office', version: 'abc', prs: [1] });
  assert.deepEqual(calls.map(x => x.u), ['https://x.test/api/inbox', 'https://x.test/api/ingest', 'https://x.test/api/ingest', 'https://x.test/api/ingest']);
  assert.deepEqual(calls.map(x => x.body.kind), [undefined, 'pr.approved', 'message', 'deploy']);
  assert.ok(calls.every(x => x.auth === 'Bearer tok')); assert.equal(calls[1].body.approver, 'ori'); assert.equal(calls[0].body.to, 'instinct');
});
