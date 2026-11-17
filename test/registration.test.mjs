import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { EventHub } from '../server/hub.js';
import { makeSession } from '../server/auth.js';
import { parseInviteKey, normalizeAgentId, validAgentId, inviteState, inviteView, sha256hex } from '../server/registration.js';

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
  return { call, env, sent };
}

test('invite creation is owner-only and same-origin; the secret appears only in the fragment of the returned URL', async () => {
  const { call } = await setup();
  assert.equal((await call('/api/invites', { agent: 'grok' }, null)).status, 401);
  assert.equal((await call('/api/invites', { agent: 'grok' }, 'i')).status, 401);
  assert.equal((await call('/api/invites', { agent: 'grok' }, 'owner', { Origin: 'https://evil.example' })).status, 403);
  const res = await call('/api/invites', { agent: 'grok', name: 'Grok', board: true });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.ok(d.ok && d.invite && d.url);
  const m = /^https:\/\/office\.test\/join\/([a-f0-9]{16})#([a-f0-9]{32})$/.exec(d.url);
  assert.ok(m, 'url shape /join/<id>#<secret>: ' + d.url);
  assert.equal(m[1], d.invite.id);
  assert.ok(!JSON.stringify(d.invite).includes(m[2]), 'invite view must not contain the secret');
});

test('register exchanges id+secret for a dedicated token, exactly once (replay rejected)', async () => {
  const { call } = await setup();
  const inv = await (await call('/api/invites', { agent: 'grok', name: 'Grok', board: true })).json();
  const { id, secret } = parseInviteKey(new URL(inv.url).pathname.slice(6) + '-' + new URL(inv.url).hash.slice(1));
  const res = await call('/api/register', { id, secret }, null);
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.ok(d.ok && d.agent === 'grok' && d.token.startsWith('aot_'));
  assert.ok(d.endpoints.ingest && d.endpoints.heartbeat && d.endpoints.inbox);
  const replay = await call('/api/register', { id, secret }, null);
  assert.ok(replay.status === 409 || replay.status === 410 || replay.status === 400, 'replay status ' + replay.status);
  assert.equal((await replay.json()).ok, false);
});

test('a wrong secret never registers and never leaks invite state', async () => {
  const { call } = await setup();
  const inv = await (await call('/api/invites', { agent: 'grok', name: 'Grok', board: true })).json();
  const id = new URL(inv.url).pathname.split('/').pop();
  const wrong = await call('/api/register', { id, secret: '0'.repeat(32) }, null);
  assert.equal((await wrong.json()).ok, false);
  assert.ok(wrong.status === 401 || wrong.status === 403, 'wrong secret status ' + wrong.status);
  const manifest = await (await call('/api/invite/' + id, undefined, null)).json();
  assert.equal(manifest.state, 'pending');
  assert.ok(!JSON.stringify(manifest).includes(inv.url.split('#')[1]), 'manifest must not contain the secret');
});

test('a registered agent token writes only as its own agent (token-bound identity)', async () => {
  const { call } = await setup();
  const inv = await (await call('/api/invites', { agent: 'grok', name: 'Grok', board: true })).json();
  const id = new URL(inv.url).pathname.split('/').pop();
  const secret = new URL(inv.url).hash.slice(1);
  const reg = await (await call('/api/register', { id, secret }, null)).json();
  const ok = await call('/api/ingest', { kind: 'status', status: 'idle', note: 'connected' }, reg.token);
  assert.equal(ok.status, 200);
  const mismatch = await call('/api/ingest', { kind: 'status', status: 'idle', agent: 'hermes' }, reg.token);
  assert.equal(mismatch.status, 403);
  assert.equal((await call('/api/ingest', { kind: 'status', status: 'idle' }, 'aot_deadbeef')).status, 401);
});

test('owner disable revokes a registered agent; env-token agents are untouched', async () => {
  const { call } = await setup();
  const inv = await (await call('/api/invites', { agent: 'grok', name: 'Grok', board: true })).json();
  const id = new URL(inv.url).pathname.split('/').pop();
  const reg = await (await call('/api/register', { id, secret: new URL(inv.url).hash.slice(1) }, null)).json();
  assert.equal((await call('/api/ingest', { kind: 'status', status: 'idle' }, reg.token)).status, 200);
  const rev = await call('/api/agents/revoke', { id: 'grok' });
  assert.equal(rev.status, 200);
  const after = await call('/api/ingest', { kind: 'status', status: 'idle' }, reg.token);
  assert.ok(after.status === 401 || after.status === 403, 'disabled token status ' + after.status);
  assert.equal((await call('/api/ingest', { kind: 'status', status: 'idle', agent: 'instinct' }, 'i')).status, 200, 'env token still works');
});

test('id and state helpers: normalization, reserved ids, and safe views', async () => {
  assert.equal(normalizeAgentId('Grok 4'), 'grok-4');
  assert.equal(normalizeAgentId('  GPT--5__Pro '), 'gpt-5-pro');
  assert.equal(normalizeAgentId('!!!'), '');
  assert.ok(validAgentId('grok-4', ['instinct']));
  assert.ok(!validAgentId('instinct', ['instinct']) && !validAgentId('owner', []) && !validAgentId('board-x', []) && !validAgentId('Grok', []));
  const base = { id: 'x'.repeat(16), agent: 'grok', name: 'Grok', board: true, created: 1, expires: Date.now() + 1000, secretHash: 'shh' };
  assert.equal(inviteState(null), 'notfound');
  assert.equal(inviteState(base), 'pending');
  assert.equal(inviteState({ ...base, used: true }), 'registered');
  assert.equal(inviteState({ ...base, revoked: true, used: true }), 'revoked');
  assert.equal(inviteState({ ...base, expires: 1 }), 'expired');
  const v = inviteView(base);
  assert.ok(!('secretHash' in v) && !JSON.stringify(v).includes('shh'));
  assert.equal(await sha256hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
