// The lite room: one view only, a 2D fallback when WebGL is missing, lazy 3D, and the per-frame performance rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { todAt, parseHHMM } from '../room-core.js';
import { sourceHash } from '../scripts/src-hash.mjs';

const root = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
const main = read('main.js'), concept = read('concept.js'), css = read('concept.css'), html = read('index.html'), stage = read('src3d/stage3d.js');

test('one view: the old office is gone (file, toggle, rotate buttons, canvas, saved view preference)', () => {
  assert.ok(!existsSync(new URL('office.js', root)));
  for (const s of ['btn-view3d', 'btn-rotl', 'btn-rotr', 'id="scene"', 'scene-hint', 'scene-fallback']) assert.ok(!html.includes(s), s);
  assert.doesNotMatch(main, /createOffice|office\.js|btn-view3d|btn-rot|#scene|CV_KEY|LS\.get\('view'|QS\.get\('view'\)/);
  assert.doesNotMatch(css, /#scene|#btn-rot/);
  assert.match(html, /<body class="cvx">/, 'the room is on from the first paint');
});

test('fallback: without WebGL (or after a lost context) the agents are still drawn as 2D avatars at their desks', () => {
  assert.match(concept, /function useFallback\(/);
  assert.match(concept, /hasWebGL\(\)/);
  assert.match(concept, /webglcontextlost/);
  assert.match(concept, /st\.loaded\.catch\(e => useFallback\(e\)\)/, 'a model that fails to load falls back too');
  assert.match(concept, /forceFallback/);
  for (const s of ['.cv-dot', '.cv-dot .av', '.cv-dots']) assert.ok(css.includes(s), s);
  // the avatar sits at the desk seat and follows the same walking paths as the 3D person; it carries the agent's emblem
  assert.match(concept, /function dotFor\(ac\)/);
  assert.match(main, /avatar: a => emblemSVG\(a/);
  assert.match(concept, /root\.insertBefore\(dotsEl, pillsEl\)/, 'avatars sit under the name pills');
});

test('lazy 3D: the plate is painted first, then the bundle and the model load; the page itself ships no three.js', () => {
  assert.doesNotMatch(concept, /from '\.\/stage3d/);
  assert.match(concept, /= import\(stageUrl\)/);
  assert.match(concept, /plate\.decode\(\)|plate\.decode \?/);
  assert.match(concept, /requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => setTimeout\(loadStage, 0\)\)\)/, 'two frames after the decode');
  assert.match(html, /rel="preload" as="image" href="\.\/assets\/office-room-day\.jpg"/, 'the plate is preloaded');
  assert.match(html, /media="print" onload=/, 'the webfont does not block rendering');
  assert.ok(!existsSync(new URL('three.module.js', root)), 'three.js is bundled (tree-shaken), not shipped whole');
  assert.ok(statSync(new URL('stage3d.min.js', root)).size < 700 * 1024, 'the 3D bundle stays small');
  assert.ok(statSync(new URL('assets/models/agent.glb', root)).size < 400 * 1024, 'the model is meshopt-compressed');
  assert.match(stage, /setMeshoptDecoder/);
});

test('the committed bundle is built from the current sources (run `npm run build` after editing src3d/)', () => {
  assert.ok(read('stage3d.min.js').includes('src ' + sourceHash()), 'stage3d.min.js is stale');
});

test('performance rules: no frames when hidden/offscreen, calm room at ~30 fps, transform-only pills, shared geometry, reused scratch objects', () => {
  assert.match(concept, /document\.hidden \|\| !onScreen/);
  assert.match(concept, /IntersectionObserver/);
  assert.match(concept, /anyMoving\(\)/);
  assert.match(concept, /style\.translate/, 'pills move with translate only');
  assert.doesNotMatch(concept.slice(concept.indexOf('function pillFor'), concept.indexOf('function buildDots')), /style\.(left|top)|offsetWidth|getBoundingClientRect|clientWidth/, 'no layout reads or top/left writes per frame');
  assert.match(css, /\.cv-tag\{[^}]*will-change:translate/);
  assert.doesNotMatch(css.match(/\.cv-tag\{[^}]*\}/)[0], /backdrop-filter:blur/, 'moving pills have no backdrop blur');
  assert.match(stage, /one geometry and one skeleton layout for all six clones/);
  assert.doesNotMatch(stage, /geometry\.clone\(\)/);
  assert.match(stage, /const blobGeo = new THREE\.PlaneGeometry/);
  // per-frame code (Person.update / applyOverlay / solveArm / frame) allocates nothing
  const hot = stage.slice(stage.indexOf('update(dt, t, time) {'), stage.indexOf('dispose() {')) + stage.slice(stage.indexOf('function solveArm'), stage.indexOf('function blobTexture'));
  assert.doesNotMatch(hot.replace('this._target ||= new THREE.Vector3()', '').replace('this.prev = target.clone()', ''), /new THREE\.(Vector|Quaternion|Euler|Matrix)|\.clone\(\)/);
  assert.match(concept, /po = poses\.get\(ac\.id\); if \(!po\) poses\.set/, 'one reused pose object per person');
  assert.match(concept, /nightImg\.style\.backgroundImage/, 'the night plate is fetched when first needed');
});

test('night/day logic is kept: same stops as the old room, working agents stay awake (PR #11)', () => {
  assert.equal(todAt(12).night, 0); assert.equal(todAt(23).night, 1); assert.equal(todAt(2).phase, 'night');
  assert.ok(todAt(6.6).night > 0 && todAt(6.6).night < 0.4); assert.equal(todAt(6.6).phase, 'dawn'); assert.equal(todAt(17.9).phase, 'dusk');
  assert.equal(parseHHMM('23:30'), 23.5); assert.equal(parseHHMM('25:00'), null);
  assert.match(stage, /if \(t\.typing\) return 'typing';/);
  assert.match(stage, /return t\.night > 0\.55 \? 'sleep' : null;/);
  assert.match(concept, /sl = night > 0\.55 && ac\.state === 'sit' && !\(status\.get\(ac\.id\) === 'working'/, 'the 2D fallback keeps working agents awake too');
});

test('cache-busting: the changed modules carry new ?v= versions in the import chain', () => {
  assert.match(html, /main\.js\?v=31/); assert.match(html, /concept\.css\?v=4/); assert.match(html, /styles\.css\?v=37/);
  assert.match(main, /concept\.js\?v=5/); assert.match(main, /room-core\.js\?v=1/); assert.match(main, /board-state\.js\?v=1/);
  assert.match(concept, /stage3d\.min\.js\?v=1/);
  assert.match(concept, /agent\.glb\?v=2/); assert.match(stage, /agent\.glb\?v=2/);
});

test('fallback, run for real with a stub DOM and no WebGL: one avatar per agent, at its desk, names and bubbles still work', async () => {
  const mk = () => {
    const el = { children: [], dataset: {}, style: { setProperty() {} }, classList: { add() {}, remove() {} }, _html: '', offsetWidth: 120,
      appendChild(c) { this.children.push(c); return c; }, insertBefore(c) { this.children.push(c); return c; }, remove() {}, setAttribute() {}, addEventListener() {},
      querySelector(sel) { return (this._q ||= {})[sel] ||= mk(); },
      querySelectorAll(sel) { if (sel === '.cv-tag') return [...this._html.matchAll(/data-id="([^"]+)"/g)].map(m => Object.assign(mk(), { dataset: { id: m[1] } })); return []; },
      set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; }, clientWidth: 1440, clientHeight: 900 };
    return el;
  };
  const root = mk(), made = [];
  const g = globalThis, saved = {};
  const stubs = {
    document: { hidden: false, body: mk(), documentElement: mk(), createElement: () => { const e = mk(); made.push(e); return e; }, addEventListener() {} },
    window: {}, matchMedia: () => ({ matches: false }), ResizeObserver: class { observe() {} }, IntersectionObserver: class { observe() {} },
    requestAnimationFrame: cb => setTimeout(() => cb(performance.now()), 5), CSS: { escape: s => s }, Image: class { decode() { return Promise.resolve(); } },
  };
  for (const [k, v] of Object.entries(stubs)) { saved[k] = Object.getOwnPropertyDescriptor(g, k); Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); }
  try {
    const { createConcept } = await import('../concept.js');
    const cv = createConcept(root, { forceFallback: true, avatar: a => `<svg data-emblem="${a.id}"></svg>`, esc: s => String(s) });
    const cast = [{ id: 'a1', name: 'Alpha', color: '#ff0000' }, { id: 'b2', name: 'Beta', color: '#00ff00' }, { id: 'c3', name: 'Gamma', color: '#0000ff' }];
    cv.setCast(cast);
    await new Promise(r => setTimeout(r, 120));
    assert.equal(cv.fallback, true, 'the 2D fallback is active');
    assert.equal(cv.cast3d.length, 0, 'no 3D people');
    const dots = made.filter(e => /class="?cv-dot|av"/.test(e.innerHTML) || e.className === 'cv-dot');
    assert.equal(dots.length, 3, 'one avatar per agent in the roster');
    assert.ok(dots.every((d, i) => d.innerHTML.includes(`data-emblem="${cast[i].id}"`)), 'each avatar carries its agent emblem');
    assert.deepEqual(cv.actorState('a1').state, 'sit', 'they start seated at their desks');
    cv.setCast(cast.slice(0, 2)); await new Promise(r => setTimeout(r, 40));
    assert.equal(cv.cast.length, 2, 'the avatars follow the roster');
  } finally {
    stubs.document.hidden = true; await new Promise(r => setTimeout(r, 60)); // the frame loop stops itself
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(g, k, d); else delete g[k]; }
  }
});
