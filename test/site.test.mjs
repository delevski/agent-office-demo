// Static checks on the site files (no browser needed). Run: node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');

test('index.html: RTL Hebrew, viewport, login form, local assets exist', () => {
  const html = read('index.html');
  assert.match(html, /<html lang="he" dir="rtl">/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /id="login-form"/);
  assert.match(html, /type="password"/);
  for (const [, src] of html.matchAll(/(?:src|href)="\.\/([^"?]+)/g)) assert.ok(existsSync(new URL(src, root)), src);
});

test('roster.json: demo agents + real agents (Tab, Instinct, Hermes)', () => {
  const r = JSON.parse(read('roster.json'));
  assert.ok(r.agents.length >= 6);
  assert.deepEqual(r.live.map(a => a.id), ['tab', 'instinct', 'hermes']);
  for (const a of r.live) assert.ok(a.name && a.color && !a.kinds, a.id);
});

test('.assetsignore keeps server code, tests and local secrets out of the public site', () => {
  const ignore = read('.assetsignore').split('\n').map(s => s.trim());
  for (const p of ['.dev.vars', 'server', 'test', 'worker.js', 'wrangler.toml', 'node_modules', '.wrangler'])
    assert.ok(ignore.includes(p), p);
});

test('no secret values in tracked config', () => {
  const toml = read('wrangler.toml');
  assert.doesNotMatch(toml, /^\s*(OFFICE_PASSWORD|SESSION_SECRET|AGENT_TOKEN_\w+|INGEST_TOKEN)\s*=/m);
  assert.doesNotMatch(read('worker.js') + read('server/auth.js'), /\b(password|token)\s*[:=]\s*['"][^'"\n]{6,}['"]/i);
});
