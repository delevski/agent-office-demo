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

test('v2 scene chrome: zoom buttons, reset, board + shelves overlays, bottom tab bar kept', () => {
  const html = read('index.html');
  for (const id of ['btn-zoomin', 'btn-zoomout', 'btn-resetcam', 'btn-board', 'btn-shelves', 'board-ov', 'shelf-ov', 'bottomnav'])
    assert.match(html, new RegExp(`id="${id}"`), id);
  for (const label of ['משרד', 'אירועים', 'סוכנים']) assert.ok(html.includes(label), label);
});

test('showcase: public route, demo only (no private API calls), embeddable', () => {
  const worker = read('worker.js');
  assert.match(worker, /\/showcase/);
  assert.match(worker, /frame-ancestors \*/);
  const main = read('main.js');
  assert.match(main, /SHOWCASE/);
  assert.match(main, /if \(!SHOWCASE\) await checkAuth\(\)/); // never asks the private API
  assert.match(read('README.md'), /<iframe[^>]+showcase/);
});

test('accessibility + performance guards', () => {
  assert.match(read('styles.css'), /prefers-reduced-motion:\s*reduce/);
  const office = read('office.js');
  assert.match(office, /prefers-reduced-motion/);
  assert.match(office, /setPixelRatio\(Math\.min\(devicePixelRatio \|\| 1, maxDpr\)\)/); // capped pixel ratio
  assert.match(office, /InstancedMesh/);
  assert.match(office, /mergeStatic/);
});

test('demo roster carries clearly-demo skills and sample tasks for the shelves and the board', () => {
  const r = JSON.parse(read('roster.json'));
  for (const a of r.agents) { assert.ok(a.skills?.length, a.id); assert.ok(a.demoTasks?.length, a.id); }
  for (const a of r.live) { assert.ok(!a.skills && !a.demoTasks, `${a.id}: live agents report their own skills`); }
});

test('v3: reviews overlay, changes card and the shared insights module are wired and public', () => {
  const html = read('index.html');
  for (const id of ['btn-reviews', 'review-ov', 'review-ov-body', 'changes-card', 'changes-list']) assert.match(html, new RegExp(`id="${id}"`), id);
  const ignore = read('.assetsignore').split('\n').map(s => s.trim());
  assert.ok(!ignore.includes('insights.js'), 'insights.js is imported by the browser');
  assert.match(read('main.js'), /from '\.\/insights\.js/);
  assert.match(read('office-state.js'), /from '\.\/insights\.js'/);
  const readme = read('README.md');
  for (const kind of ['review', 'pr.merged', 'deploy']) assert.match(readme, new RegExp('`' + kind.replace('.', '\\.') + '`'), kind);
});

test('v4: replay bar, summary overlay and the shared reducer are public; replay/summary routes are protected', () => {
  const html = read('index.html');
  for (const id of ['btn-replay', 'replay-bar', 'replay-slider', 'replay-play', 'replay-speed', 'replay-exit', 'btn-summary', 'summary-ov', 'summary-text']) assert.match(html, new RegExp(`id="${id}"`), id);
  const ignore = read('.assetsignore').split('\n').map(s => s.trim());
  assert.ok(!ignore.includes('office-state.js'), 'office-state.js runs in the browser for the replay');
  assert.match(read('main.js'), /from '\.\/office-state\.js'/);
  const worker = read('worker.js');
  assert.match(worker, /\/api\/replay/);
  assert.match(worker, /\/api\/summary/);
  const readme = read('README.md');
  for (const s of ['`handoff`', '/api/summary', 'budget', 'activity', 'from_agent']) assert.ok(readme.includes(s), s);
});

test('v5: reliability on the agent card and a "give a task" form that only writes a board card', () => {
  const html = read('index.html');
  for (const id of ['btn-assign', 'assign-ov', 'assign-form', 'assign-title', 'assign-agent', 'assign-note']) assert.match(html, new RegExp(`id="${id}"`), id);
  const main = read('main.js');
  assert.match(main, /reliabilityHtml\(a, v\)/);
  assert.match(main, /'\.\/api\/tasks'/);
  const worker = read('worker.js');
  const i = worker.indexOf("path === '/api/tasks'");
  assert.ok(i > 0);
  const handler = worker.slice(i, worker.indexOf('/* ---- private reads', i));
  assert.match(handler, /isLoggedIn/);
  assert.match(handler, /kind: 'task\.queued'/);
  assert.doesNotMatch(handler, /fetch\((?!'https:\/\/hub\/report')/, 'the only call is to the office hub: no agent is contacted');
  const readme = read('README.md');
  assert.ok(readme.includes('/api/tasks') && readme.includes('Reliability'));
});
