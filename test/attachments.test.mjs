import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { EventHub } from '../server/hub.js';
import { makeSession } from '../server/auth.js';
import { sniffType, safeName, MAX_FILE_BYTES, MAX_FILES } from '../server/files.js';
import { slackTaskMessage, createBoardClient } from '../integrations/board-agent.js';

function fakeR2() {
  const m = new Map();
  return { m,
    async put(k, v, o) { m.set(k, { body: v, ...o, size: v.byteLength }); },
    async head(k) { const o = m.get(k); return o ? { size: o.size, customMetadata: o.customMetadata, httpMetadata: o.httpMetadata } : null; },
    async get(k) { const o = m.get(k); return o ? { body: new Blob([o.body]).stream(), size: o.size, customMetadata: o.customMetadata, httpMetadata: o.httpMetadata } : null; },
    async delete(k) { m.delete(k); } };
}
async function setup(extraEnv = {}) {
  const data = new Map();
  const st = { storage: {
    async get(k) { return Array.isArray(k) ? new Map(k.filter(x => data.has(x)).map(x => [x, structuredClone(data.get(x))])) : structuredClone(data.get(k)); },
    async put(k, v) { if (typeof k === 'object') for (const [key, val] of Object.entries(k)) data.set(key, structuredClone(val)); else data.set(k, structuredClone(v)); },
    async delete(keys) { for (const k of [].concat(keys)) data.delete(k); },
    async list({ prefix }) { return new Map([...data].filter(([k]) => k.startsWith(prefix))); },
  }, blockConcurrencyWhile: fn => fn(), getWebSockets: () => [] };
  const hub = new EventHub(st); await new Promise(r => setTimeout(r, 0));
  const env = { OFFICE_PASSWORD: 'test-only-password', AGENT_TOKEN_INSTINCT: 'i', AGENT_TOKEN_HERMES: 'h', AGENT_TOKEN_TAB: 't', INGEST_TOKEN: 'legacy', ...extraEnv,
    HUB: { idFromName: () => '', get: () => ({ fetch: (url, init) => hub.fetch(new Request(url, init)) }) } };
  const cookie = 'ao_session=' + await makeSession(env);
  const call = (path, { method, body, auth = 'owner', headers = {} } = {}) => worker.fetch(new Request('https://office.test' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { ...(auth === 'owner' ? { Cookie: cookie } : auth ? { Authorization: 'Bearer ' + auth } : {}), ...headers }, ...(body === undefined ? {} : { body }) }), env);
  const upload = (bytes, name = 'a.png', type = 'image/png', opts = {}) => call('/api/uploads', { body: bytes, headers: { 'X-File-Name': encodeURIComponent(name), 'Content-Type': type }, ...opts });
  const task = (body, opts = {}) => call('/api/tasks', { body: JSON.stringify({ requestId: '12345678-1234-1234-1234-123456789012', title: 'תקן את המסך', ...body }), headers: { 'Content-Type': 'application/json' }, ...opts });
  return { call, upload, task, env };
}
const j = async r => ({ status: r.status, ...(await r.json()) });
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

test('sniffing: type comes from the bytes, active content is never served inline', () => {
  assert.equal(sniffType(PNG, 'text/html', 'x.html'), 'image/png');
  assert.equal(sniffType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'application/x-evil'), 'image/jpeg');
  assert.equal(sniffType(new TextEncoder().encode('%PDF-1.7 ...'), ''), 'application/pdf');
  assert.equal(sniffType(new TextEncoder().encode('שם,עיר\nדנה,חיפה\n'), '', 'rows.csv'), 'text/csv');
  assert.equal(sniffType(new TextEncoder().encode('<html><script>alert(1)</script>'), 'image/png', 'x.png'), 'text/plain');
  assert.equal(sniffType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), 'image/svg+xml', 'x.svg'), 'text/plain');
  assert.equal(sniffType(new Uint8Array([1, 2, 0, 3, 4, 5]), 'image/png'), 'application/octet-stream');
  assert.equal(sniffType(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(sniffType(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0]), 'audio/webm;codecs=opus'), 'audio/webm');
  assert.equal(safeName('../a"b\\c<d>.png'), 'a b c d .png'); assert.equal(safeName(''), 'file'); assert.ok(safeName('x'.repeat(300) + '.csv').endsWith('.csv'));
});

test('upload: owner only, same-origin, limits, 501 without the R2 binding', async () => {
  const { upload, call } = await setup({ FILES: fakeR2() });
  assert.equal((await upload(PNG, 'a.png', 'image/png', { auth: null })).status, 401);
  assert.equal((await upload(PNG, 'a.png', 'image/png', { auth: 't' })).status, 401, 'an agent token cannot upload');
  assert.equal((await upload(PNG, 'a.png', 'image/png', { auth: 'legacy' })).status, 401);
  assert.equal((await upload(PNG, 'a.png', 'image/png', { headers: { Origin: 'https://evil.test', 'X-File-Name': 'a.png' } })).status, 403);
  assert.equal((await upload(new Uint8Array(0))).status, 400);
  assert.equal((await upload(new Uint8Array(MAX_FILE_BYTES + 1), 'big.bin', 'application/octet-stream')).status, 413);
  const ok = await j(await upload(PNG, 'מסך הבית.png', 'text/html'));
  assert.equal(ok.status, 200); assert.match(ok.file.id, /^f-[a-f0-9]{32}$/); assert.equal(ok.file.type, 'image/png'); assert.equal(ok.file.name, 'מסך הבית.png'); assert.equal(ok.file.size, PNG.length);
  const none = await setup();
  assert.equal((await none.upload(PNG)).status, 501);
  const me = await j(await call('/api/me')); assert.equal(me.uploads, true); assert.equal(me.transcribe, false);
  const me2 = await j(await none.call('/api/me')); assert.equal(me2.uploads, false);
  assert.equal((await j(await none.call('/api/me', { auth: null }))).uploads, undefined, 'flags only for the owner');
});

test('attachments: task keeps server-verified metadata, inbox shows it to the assignee only, Slack lists it', async () => {
  const { call, upload, task } = await setup({ FILES: fakeR2() });
  const f1 = (await j(await upload(PNG, 'screen.png'))).file;
  const f2 = (await j(await upload(new TextEncoder().encode('a,b\n1,2\n'), 'data.csv', 'text/csv'))).file;
  assert.equal((await task({ agent: 'tab', attachments: ['f-' + '0'.repeat(32)] })).status, 400, 'unknown id');
  assert.equal((await task({ agent: 'tab', attachments: ['nope'] })).status, 400, 'bad id');
  assert.equal((await task({ agent: 'tab', attachments: Array.from({ length: MAX_FILES + 1 }, (_, i) => 'f-' + String(i).repeat(32)) })).status, 400, 'more than 5');
  const made = await j(await task({ agent: 'tab', attachments: [f1.id, f2.id, f1.id], note: 'ראה צילום' }));
  assert.equal(made.status, 200);
  const att = made.tasks[0].attachments;
  assert.deepEqual(att.map(a => [a.id, a.name, a.type, a.size]), [[f1.id, 'screen.png', 'image/png', PNG.length], [f2.id, 'data.csv', 'text/csv', 8]]);
  assert.equal(att[0].url, 'https://office.test/api/files/' + f1.id);
  const inbox = await j(await call('/api/inbox', { auth: 't' }));
  assert.deepEqual(Object.keys(inbox.tasks[0].attachments[0]).sort(), ['id', 'name', 'size', 'type', 'url']);
  assert.equal(inbox.tasks[0].attachments.length, 2); assert.ok(!JSON.stringify(inbox).includes('claimToken'));
  assert.equal((await j(await call('/api/inbox', { auth: 'h' }))).tasks.length, 0);
  assert.match(slackTaskMessage(made.tasks[0]), /קבצים מצורפים \(2\):\n• screen\.png \(image\/png, 16B\) https:\/\/office\.test\/api\/files\/f-/);
  assert.ok(!slackTaskMessage({ id: 'board-x', agent: 'tab', title: 't', note: '' }).includes('קבצים מצורפים'));
  // same requestId with different attachments is a conflict, not a silent merge
  assert.equal((await task({ agent: 'tab', attachments: [f1.id], note: 'ראה צילום' })).status, 409);
  assert.equal((await j(await task({ agent: 'tab', attachments: [f1.id, f2.id], note: 'ראה צילום' }))).duplicate, true);
  // a task that carries attachments needs the binding
  const none = await setup();
  assert.equal((await none.task({ agent: 'tab', attachments: ['f-' + 'a'.repeat(32)] })).status, 501);
  assert.equal((await none.task({ agent: 'tab' })).status, 200, 'plain tasks keep working without R2');
});

test('files: private; owner and the assigned agent can read, others cannot; safe headers', async () => {
  const { call, upload, task } = await setup({ FILES: fakeR2() });
  const img = (await j(await upload(PNG, 'screen.png'))).file;
  const html = (await j(await upload(new TextEncoder().encode('<html><script>1</script>'), 'x.html', 'text/html'))).file;
  await task({ agent: 'hermes', attachments: [img.id, html.id] });
  const get = (id, auth) => call('/api/files/' + id, { auth });
  const own = await get(img.id, 'owner');
  assert.equal(own.status, 200); assert.equal(own.headers.get('Content-Type'), 'image/png'); assert.match(own.headers.get('Content-Disposition'), /^inline/);
  assert.equal(own.headers.get('X-Content-Type-Options'), 'nosniff'); assert.match(own.headers.get('Content-Security-Policy'), /sandbox/); assert.match(own.headers.get('Cache-Control'), /no-store/);
  assert.deepEqual([...new Uint8Array(await own.arrayBuffer())], [...PNG]);
  const dl = await get(html.id, 'owner');
  assert.equal(dl.headers.get('Content-Type'), 'text/plain'); assert.match(dl.headers.get('Content-Disposition'), /^attachment/);
  assert.equal((await get(img.id, 'h')).status, 200, 'assigned agent with its Bearer token');
  assert.equal((await get(img.id, 't')).status, 404, 'another agent: not found');
  assert.equal((await get(img.id, 'i')).status, 200, 'Instinct relay token reads any assignee file, like /api/inbox?relay=1');
  assert.equal((await get(img.id, 'legacy')).status, 401); assert.equal((await get(img.id, null)).status, 401);
  assert.equal((await get('f-' + 'b'.repeat(32), 'owner')).status, 404);
  assert.notEqual((await call('/api/files/not-an-id', { auth: 'owner' })).status, 200, 'malformed ids never reach R2');
  // unattached upload: agents cannot read it at all; owner can delete it, but not once attached
  const orphan = (await j(await upload(PNG, 'orphan.png'))).file;
  assert.equal((await get(orphan.id, 'h')).status, 404);
  assert.equal((await call('/api/uploads/' + orphan.id, { method: 'DELETE', auth: 'h' })).status, 401);
  assert.equal((await call('/api/uploads/' + orphan.id, { method: 'DELETE' })).status, 200); assert.equal((await get(orphan.id, 'owner')).status, 404);
  assert.equal((await call('/api/uploads/' + img.id, { method: 'DELETE' })).status, 409);
  // the agent client helper downloads with its token
  const client = createBoardClient('h', 'https://office.test', (url, init) => call(new URL(url).pathname, { auth: 'h', method: init?.method || 'GET' }));
  const f = await client.file('https://office.test/api/files/' + img.id);
  assert.equal(f.type, 'image/png'); assert.equal(f.bytes.length, PNG.length);
  await assert.rejects(() => client.file('https://evil.test/other'), /not an attachment url/);
});

test('transcribe: owner only, Hebrew, degrades to 501 without the AI binding, bounded', async () => {
  const seen = [];
  const AI = { async run(model, input) { seen.push({ model, input }); return { text: ' לתקן את   כפתור השליחה ' }; } };
  const { call } = await setup({ AI });
  const audio = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
  assert.equal((await call('/api/transcribe', { body: audio, auth: null })).status, 401);
  assert.equal((await call('/api/transcribe', { body: audio, auth: 't' })).status, 401);
  assert.equal((await call('/api/transcribe', { body: audio, headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await call('/api/transcribe', { body: new Uint8Array(0) })).status, 400);
  assert.equal((await call('/api/transcribe', { body: new Uint8Array(12 * 1024 * 1024 + 1) })).status, 413);
  const ok = await j(await call('/api/transcribe', { body: audio }));
  assert.deepEqual([ok.status, ok.text], [200, 'לתקן את כפתור השליחה']);
  assert.equal(seen[0].input.language, 'he'); assert.equal(typeof seen[0].input.audio, 'string'); assert.match(seen[0].model, /whisper/);
  assert.equal((await j(await call('/api/me'))).transcribe, true);
  const fallback = await setup({ AI: { async run(model) { if (model.includes('turbo')) throw new Error('x'); return { text: 'בסדר' }; } } });
  assert.equal((await j(await fallback.call('/api/transcribe', { body: audio }))).text, 'בסדר');
  const broken = await setup({ AI: { async run() { throw new Error('x'); } } });
  assert.equal((await broken.call('/api/transcribe', { body: audio })).status, 502);
  const none = await setup();
  const r = await j(await none.call('/api/transcribe', { body: audio }));
  assert.equal(r.status, 501); assert.equal(r.error, 'transcription not configured');
});
