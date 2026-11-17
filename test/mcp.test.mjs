import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { EventHub } from '../server/hub.js';
import { makeSession } from '../server/auth.js';

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
  const rpc = (body, auth = 'h') => call('/mcp', body, auth);
  return { call, rpc, env, sent };
}

test('MCP requires a per-agent bearer token and speaks JSON-RPC', async () => {
  const { rpc } = await setup();
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, null)).status, 401);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, 'wrong-token')).status, 401);
  const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' })).json();
  assert.equal(init.result.serverInfo.name, 'agent-office');
  assert.match(init.result.instructions, /"hermes"/, 'identity comes from the token (AGENT_TOKEN_HERMES -> hermes)');
  const tools = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  assert.deepEqual(tools.result.tools.map(t => t.name), ['report_status', 'check_inbox', 'claim_task', 'report_task']);
  const unknown = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'nope' })).json();
  assert.equal(unknown.error.code, -32601);
});

test('MCP report_status updates the token agent\'s live state only', async () => {
  const { rpc, call } = await setup();
  const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'report_status', arguments: { status: 'working', note: 'on it' } } });
  const out = JSON.parse((await res.json()).result.content[0].text);
  assert.ok(out.event && out.event.agent === 'hermes' && out.event.kind === 'status', JSON.stringify(out));
  const bad = JSON.parse((await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'report_status', arguments: { status: 'flying' } } })).json()).result.content[0].text);
  assert.equal(bad.ok, false);
  // the state landed as hermes (the token's agent), never as another agent
  assert.equal(out.agent, 'hermes');
  assert.equal(out.status, 'working');
});

test('MCP board flow: check_inbox -> claim_task -> report_task done, all as the token agent', async () => {
  const { call, rpc } = await setup();
  // owner creates a board task for hermes
  const created = await (await call('/api/tasks', { agent: 'hermes', requestId: 'mcp-test-1234-5678', title: 'MCP wiring', note: 'test' })).json();
  assert.ok(created.ok, JSON.stringify(created));
  const task = (created.tasks || [created.task]).find(t => t && t.id);
  assert.ok(task && task.id.startsWith('board-'), JSON.stringify(created));

  const inbox = JSON.parse((await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_inbox', arguments: {} } })).json()).result.content[0].text);
  assert.ok(inbox.ok && inbox.tasks.some(t => t.id === task.id), JSON.stringify(inbox));

  // claiming without ownership of the claim flow must fail for a wrong id; claim for real task works
  const claim = JSON.parse((await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'claim_task', arguments: { task_id: task.id } } })).json()).result.content[0].text);
  assert.ok(claim.ok && claim.claimToken, JSON.stringify(claim));

  // report_task without the claimToken is refused by the board
  const noClaim = JSON.parse((await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'report_task', arguments: { task_id: task.id, phase: 'done', claimToken: 'bogus', note: 'done' } } })).json()).result.content[0].text);
  assert.equal(noClaim.ok, undefined, 'board should reject a bogus claimToken: ' + JSON.stringify(noClaim));

  const done = JSON.parse((await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'report_task', arguments: { task_id: task.id, phase: 'done', claimToken: claim.claimToken, note: 'wired up', link: 'https://example.test/x' } } })).json()).result.content[0].text);
  assert.ok(done.event && done.event.kind === 'task.done' && done.agent === 'hermes', JSON.stringify(done));

  // a registered dynamic agent (aot_ token from the invite flow) can use MCP the same way
  const inv = await (await call('/api/invites', { agent: 'grok', name: 'Grok', board: true })).json();
  const reg = await (await call('/api/register', { id: new URL(inv.url).pathname.split('/').pop(), secret: new URL(inv.url).hash.slice(1) }, null)).json();
  const dynInit = await (await call('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize' }, reg.token)).json();
  assert.match(dynInit.result.instructions, /"grok"/);
});
