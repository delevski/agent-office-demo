// v6 static checks + the synthesized bell with a mock AudioContext (no browser, no audio files). Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { strike, createBell } from '../sound.js';

const root = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');

test('layout: full-screen room with a drawer, a closed-state strip and its toggle', () => {
  const html = read('index.html');
  for (const id of ['drawer', 'drawer-toggle', 'drawer-strip', 'drawer-body', 'view-agents', 'view-feed', 'btn-actions', 'actions-pop', 'btn-rotl', 'btn-rotr', 'btn-sound', 'btn-notify'])
    assert.match(html, new RegExp(`id="${id}"`), id);
  assert.ok(html.indexOf('id="drawer-body"') < html.indexOf('id="view-agents"'), 'the side panel lives in the drawer');
  const css = read('styles.css');
  assert.match(css, /#layout\.drawer-closed \.drawer-strip\{display:flex\}/);
  assert.match(css, /prefers-reduced-motion: reduce\)\{\n  \.scene-sky::after\{animation:none\}/);
});

test('time of day: real clock by default, ?time=HH:MM / cycle as a debug override', () => {
  const main = read('main.js'), office = read('office.js');
  assert.match(main, /time: QS\.get\('time'\)/);
  assert.match(office, /function virtualNow\(\)/);
  assert.match(office, /tickClock\(t, vnow\)/, 'the wall clock reads the room clock');
  assert.match(office, /setPajamas\(ch, wantPj\)/);
});

test('bell: rings on task.done and pr.opened in live mode, notifications only after a tap', () => {
  const main = read('main.js');
  assert.match(main, /kind === 'pr\.opened'\) return 'pr'/);
  assert.match(main, /kind === 'task\.done' && !\/\^נכשל\//);
  const i = main.indexOf("Notification.requestPermission");
  assert.ok(i > 0 && main.lastIndexOf("addEventListener('click'", i) > main.lastIndexOf('\n}', i), 'permission is requested inside a click handler');
  assert.match(main, /if \(mode === 'live' && title && !silentNotify\) notify\(/, 'demo events never raise system notifications');
});

test('camera: no azimuth clamp, walls fade instead', () => {
  const office = read('office.js');
  assert.doesNotMatch(office, /goal\.az = Math\.min\(BASE_AZ \+ LIM\.az/);
  assert.match(office, /function updateWalls\(dt\)/);
  assert.match(office, /rotateBy\(rad\)/);
});

test('no audio files are shipped; the bell is synthesized', () => {
  const files = readdirSync(new URL('./', root));
  assert.ok(!files.some(f => /\.(mp3|wav|ogg|m4a|aac)$/i.test(f)), 'no audio assets');
  assert.doesNotMatch(read('sound.js'), /fetch\(|new Audio\(|\.mp3|\.wav/);
});

function mockCtx() {
  const made = { osc: 0, starts: [], gains: [] };
  const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime(v) { made.gains.push(v); } });
  const node = () => ({ connect() {} });
  return {
    made, sampleRate: 8000, currentTime: 0, state: 'running',
    createOscillator: () => { made.osc++; return { ...node(), type: '', frequency: param(), start(t) { made.starts.push(t); }, stop() {} }; },
    createGain: () => ({ ...node(), gain: param() }),
    createBuffer: (c, n) => ({ getChannelData: () => new Float32Array(n) }),
    createBufferSource: () => ({ ...node(), buffer: null, start() {} }),
    createBiquadFilter: () => ({ ...node(), type: '', frequency: param(), Q: param() }),
    createDynamicsCompressor: () => node(),
    destination: node(), resume: async () => {},
  };
}

test('strike(): a bell is several inharmonic partials started together, louder for a stronger hit', () => {
  const a = mockCtx(); strike(a, a.destination, 1, { strength: 1 });
  const b = mockCtx(); strike(b, b.destination, 1, { strength: 0.3 });
  assert.ok(a.made.osc >= 6);
  assert.ok(a.made.starts.every(t => t === 1));
  assert.ok(Math.max(...a.made.gains) > Math.max(...b.made.gains));
});

test('createBell(): silent until unlocked (autoplay rules), and when muted', () => {
  const ctx = mockCtx();
  globalThis.AudioContext = function () { return ctx; };
  const bell = createBell();
  assert.equal(bell.ring(), false, 'no context before the first tap');
  bell.unlock();
  assert.equal(bell.ring(), true);
  bell.setMuted(true);
  assert.equal(bell.ring(), false);
  delete globalThis.AudioContext;
});
