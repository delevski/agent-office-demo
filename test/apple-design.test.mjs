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
  for (const id of ['btn-meeting', 'btn-pause', 'btn-speed', 'btn-sound', 'btn-notify', 'btn-login', 'btn-actions', 'btn-board', 'btn-shelves', 'btn-reviews', 'btn-replay', 'btn-zoomin', 'btn-zoomout', 'btn-rotl', 'btn-rotr', 'btn-resetcam', 'drawer-toggle'])
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

test('room: bigger and airier, desks spaced out, up to 6 desks', () => {
  const office = read('office.js');
  const room = office.match(/const ROOM = \{ w: ([\d.]+), d: ([\d.]+), h: ([\d.]+) \}/);
  assert.ok(room && Number(room[1]) >= 18 && Number(room[2]) >= 13.5 && Number(room[3]) >= 4, 'floor is at least 18 x 13.5');
  const cols = office.match(/const COLS = \[([^\]]+)\]/)[1].split(',').map(Number);
  const rows = [...office.match(/const ROWS = \[([^\]]+)\]/)[1].matchAll(/z: (-?[\d.]+)/g)].map(m => Number(m[1]));
  assert.ok(cols.length * rows.length <= 6 && cols.length * rows.length >= 6, '3 columns x 2 rows = 6 desks');
  assert.ok(cols[1] - cols[0] >= 5 && cols[2] - cols[1] >= 5, 'columns at least 5 apart (desk is 2.1 wide)');
  assert.ok(rows[1] - rows[0] >= 4.5, 'rows at least 4.5 apart');
  const hw = Number(room[1]) / 2, hd = Number(room[2]) / 2;
  assert.ok(Math.abs(cols[0]) + 1.05 < hw && rows[1] + 1 < hd && rows[0] - 1 > -hd, 'desks stay inside the room');
  assert.match(office, /const WIN = \[\{ z: -4\.8, w: 3\.2 \}, \{ z: 0\.2, w: 3\.2 \}, \{ z: 5\.2, w: 3\.2 \}\]/, 'three big windows');
  assert.match(office, /fitZoom\(-HW - 0\.2, HW \+ 0\.2, -HD, HD, ROOM\.h, 0\.72\)/, 'portrait home view frames the whole room');
});

test('lighting: brighter daylight, light oak and white materials; day/night, bell, bubbles and pajamas intact', () => {
  const office = read('office.js');
  assert.match(office, /HemisphereLight\(0xfffaf0, 0xc7b49c, 1\.6\)/);
  assert.match(office, /wall: '#fbfaf7'/);
  assert.match(office, /woodLight: '#eed8b3'/);
  for (const s of ['setPajamas(ch, wantPj)', 'function virtualNow()', "ch.action === 'bell'", 'function sayText']) assert.ok(office.includes(s), s);
});

test('roster data is untouched by the redesign: up to 6 agents with ids and names', () => {
  const r = JSON.parse(read('roster.json'));
  assert.ok(r.agents.length >= 1 && r.agents.length <= 6);
  for (const a of r.agents) assert.ok(a.id && a.name && a.color);
});
