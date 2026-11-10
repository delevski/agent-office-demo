// Apple redesign: chrome (icons, pill/dock, accent, system fonts) and the bigger room. Static checks, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{23E9}-\u{23FA}\u{25B6}\u{21A9}]/u;

test('icons: every <use href="#i-…"> in the markup and in main.js exists in the inline Lucide sprite', () => {
  const html = read('index.html'), main = read('main.js');
  const symbols = new Set([...html.matchAll(/<symbol id="i-([a-z0-9-]+)"/g)].map(m => m[1]));
  assert.ok(symbols.size >= 40, 'the sprite ships the icons');
  const used = new Set([
    ...[...html.matchAll(/href="#i-([a-z0-9-]+)"/g)].map(m => m[1]),
    ...[...main.matchAll(/\bic\('([a-z0-9-]+)'/g)].map(m => m[1]),
    ...[...main.matchAll(/\bicon: '([a-z0-9-]+)'/g)].map(m => m[1]),
    ...[...main.matchAll(/ic\([^)]*\? '([a-z0-9-]+)' : '([a-z0-9-]+)'/g)].flatMap(m => [m[1], m[2]]),
  ]);
  for (const u of used) assert.ok(symbols.has(u), `icon ${u} is in the sprite`);
});

test('chrome: no emoji used as an icon in the markup or in main.js UI templates', () => {
  const html = read('index.html').replace(/<symbol[\s\S]*?<\/symbol>/g, '');
  assert.doesNotMatch(html, EMOJI, 'index.html has no emoji');
  const main = read('main.js');
  for (const name of ['TASK_ICON', 'CHANGE_ICON', 'VERDICT_HE'])
    assert.doesNotMatch(main.match(new RegExp(`const ${name} = [^\\n]*`))[0], EMOJI, name);
  assert.doesNotMatch(main.match(/function renderAuthButton[\s\S]*?\n}/)[0], EMOJI);
});

test('every existing control and label is still there', () => {
  const html = read('index.html');
  for (const id of ['btn-meeting', 'btn-pause', 'btn-speed', 'btn-sound', 'btn-notify', 'btn-login', 'btn-actions', 'btn-board', 'btn-shelves', 'btn-reviews', 'btn-replay', 'btn-zoomin', 'btn-zoomout', 'btn-resetcam', 'drawer-toggle'])
    assert.match(html, new RegExp(`id="${id}"`), id);
  for (const label of ['ישיבת בוקר', 'השהה', 'מהירות ×1', 'כניסה', 'פעולות', 'לוח משימות', 'מדף סקילים', 'ביקורות', 'שחזור יום', 'איפוס מצלמה', 'לצלצל בפעמון', 'הפסקת קפה', 'מתיחות', 'לחגוג', 'שיחה קצרה', 'ישיבת צוות', 'כולם לשולחנות'])
    assert.ok(html.includes(label), label);
});

test('style: system font stack, one blue accent, floating frosted pill top bar and dock', () => {
  const css = read('styles.css');
  assert.match(css, /-apple-system,BlinkMacSystemFont,"SF Pro Text"/);
  assert.match(css, /--accent:#007aff/);
  assert.match(css, /\.topbar\{position:absolute;top:14px;left:50%;transform:translateX\(-50%\)/);
  assert.match(css, /backdrop-filter:saturate\(180%\) blur\(22px\)/);
  assert.doesNotMatch(css, /#f5b301/i, 'the old amber accent is gone');
  assert.match(css, /\.scene-quick\{[^}]*border-radius:999px/);
  assert.match(css, /\.ov-card\{border-radius:30px/);
  assert.match(css, /prefers-reduced-motion/);
});

test('room: the painted plate is the only scene, up to 6 desks, day/night, bell, bubbles and pyjamas intact', () => {
  const stage = read('src3d/stage3d.js'), concept = read('concept.js'), core = read('room-core.js'), calib = read('concept-calib.js');
  assert.equal((calib.match(/"cx"/g) || []).length, 6, 'six desks');
  assert.match(concept, /cast = list\.slice\(0, SLOTS\.length\)/);
  assert.match(core, /function virtualNow\(\)/);
  assert.match(core, /const TOD_STOPS = \[\[0, 'night'\]/);
  for (const s of ['uNight', 'function seatedOverlay', 'blobTexture']) assert.ok(stage.includes(s), s);
  for (const s of ['function bell(', 'function say(', 'onStrike(']) assert.ok(concept.includes(s), s);
});

test('roster: up to 6 demo agents with ids and names (Ori\'s six), live roster unchanged', () => {
  const r = JSON.parse(read('roster.json'));
  assert.ok(r.agents.length >= 1 && r.agents.length <= 6);
  for (const a of r.agents) assert.ok(a.id && a.name && a.color);
});
