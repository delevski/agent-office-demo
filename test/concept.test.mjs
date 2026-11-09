// The concept view: the approved room picture is the scene; pills, bubbles and the panel are live data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { SLOTS, SLOT_ORDER, SEAT_CHARS, SEAT_BOX, SPOTS, assignSlots, layoutFor, planPath, FRAME } from '../concept.js';

const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const roster = JSON.parse(read('roster.json'));
const main = read('main.js'), html = read('index.html'), css = read('concept.css');

test('demo roster: the six names Ori chose, in his order, each with a seat in the picture', () => {
  assert.deepEqual(roster.agents.map(a => a.name), ['hermessi', 'Claudi', 'Gepeta', 'Grocki', 'Gemino', 'Deepsi']);
  const seats = assignSlots(roster.agents);
  assert.equal(seats.size, 6);
  assert.equal(new Set(seats.values()).size, 6, 'one seat each');
  for (const a of roster.agents) assert.ok(a.skills.length && a.demoTasks.length, a.id);
});

test('live mode takes its names from the live roster, never from the demo list', () => {
  const liveNames = roster.live.map(a => a.name);
  assert.ok(liveNames.length && liveNames.every(n => !roster.agents.some(a => a.name === n)), 'live and demo names are different sets');
  // the cast the pills show is chosen by mode: LIVE when live, AGENTS when demo
  assert.match(main, /function castNow\(\) \{ return mode === 'live' \? LIVE : AGENTS; \}/);
  assert.match(main, /cv\.setCast\(castNow\(\)\)/);
  // pills are built from the agent objects (name, colour), no name literal anywhere in concept.js
  const cjs = read('concept.js');
  for (const a of roster.agents) assert.ok(!cjs.includes(a.name), `concept.js hard-codes ${a.name}`);
  // live agents that come from the server (any name) get seats too
  const seats = assignSlots([{ id: 'x1', name: 'שם כלשהו' }, { id: 'x2', name: 'Other' }, { id: 'x3', name: 'Third' }]);
  assert.deepEqual([...seats.keys()], ['x1', 'x2', 'x3']);
  assert.equal(new Set(seats.values()).size, 3);
});

test('more than six agents never share a seat: the extra ones simply have no pill', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: 'a' + i, name: 'A' + i }));
  const seats = assignSlots(many);
  assert.equal(seats.size, SLOTS.length);
  assert.equal(new Set(seats.values()).size, SLOTS.length);
});

test('explicit seats win, free seats fill in SLOT_ORDER', () => {
  const s = assignSlots([{ id: 'a', slot: 5 }, { id: 'b' }, { id: 'c' }]);
  assert.equal(s.get('a'), 5);
  assert.equal(s.get('b'), SLOT_ORDER[0]);
  assert.equal(s.get('c'), SLOT_ORDER[1]);
});

test('layout: desktop is the 1600x1000 concept frame scaled; phones fill the width', () => {
  const d = layoutFor(1600, 1000);
  assert.equal(d.u, 1); assert.equal(d.left, -25); assert.equal(d.w, 1050); assert.equal(d.h, 1000);
  const d2 = layoutFor(1440, 900);
  assert.ok(Math.abs(d2.u - 0.9) < 1e-9 && Math.abs(d2.w - 945) < 1e-6);
  const p = layoutFor(390, 700);
  assert.equal(p.desktop, false); assert.ok(p.w >= 390);
  // seats are inside the picture
  for (const s of SLOTS) { assert.ok(s.x > 0 && s.x < 1 && s.y > 0 && s.y < 1); }
  assert.equal(FRAME.w, 1600);
});

test('the concept chrome: room picture, panel open by default, dock, tools, pills layer', () => {
  assert.ok(existsSync(new URL('../assets/office-room-day.jpg', import.meta.url)) && existsSync(new URL('../assets/office-room-night.jpg', import.meta.url)));
  for (const id of ['cv', 'cv-pills', 'cpanel', 'cp-cols', 'cp-review', 'cp-chat', 'cp-add', 'cp-close', 'btn-view3d', 'btn-agents']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /concept\.css/);
  assert.match(main, /cpOpen\(isDesktop\(\) && LS\.get\('cpanel', '1'\) !== '0'\)/, 'the panel opens by default on desktop');
  for (const v of ['width:560px', 'top:84px', 'border-radius:30px', 'backdrop-filter:blur(40px)', 'bottom:26px', 'border-radius:26px', 'height:48px', '#0a84ff']) assert.ok(css.includes(v), v);
  // the real 3D room stays one tap away
  assert.match(main, /setView\(!document\.body\.classList\.contains\('cvx'\)\)/);
});

test('no emoji as UI icons in the concept chrome', () => {
  const chrome = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('<!-- Mobile agent sheet -->'));
  assert.doesNotMatch(chrome, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
});

test('the board, review row and chat in the panel are rendered from the same data as the board overlay', () => {
  assert.match(main, /function renderCPanel\(\)[\s\S]*boardData\(\)/);
  assert.match(main, /reviews\[reviews\.length - 1\]/);
  assert.match(main, /o\.converse = spec =>/);
});

test('motion: every seat has its sprite set, plates exist, and paths between seats and spots stay on the floor', () => {
  for (const c of SEAT_CHARS) for (const nm of ['sit', 'stand', 'walk1', 'walk2', 'pj', 'sleep']) assert.ok(existsSync(new URL(`../assets/sprites/${c}-${nm}.webp`, import.meta.url)), `${c}-${nm}`);
  assert.equal(SEAT_BOX.length, 6);
  for (const b of SEAT_BOX) { assert.ok(b.fx > 0 && b.fx < 1 && b.fy > 0 && b.fy < 1); }
  for (const b of SEAT_BOX) for (const to of [SPOTS.talk[0], SPOTS.bell, SPOTS.coffee[0], SPOTS.meet]) {
    const p = planPath({ x: b.fx, y: b.fy }, to);
    assert.ok(p.length >= 1 && p.length < 40);
    const end = p[p.length - 1]; assert.ok(Math.abs(end.x - to.x) < 1e-9 && Math.abs(end.y - to.y) < 1e-9);
  }
});

test('motion: the concept view is driven by the same calls as the 3D office (converse, bell, coffee, gather, night)', () => {
  for (const call of ['o.converse = spec =>', 'o.ringBell = (id, label) =>', 'o.coffeeBreak =', 'o.gatherAll =', 'o.disperseAll =', 'cv.setNight(info.night)']) assert.ok(main.includes(call), call);
  assert.match(main, /setRenderPaused\(/);
});
