// concept.js — the "concept room": the approved Apple-style room is the scene (an empty day plate and a night
// plate) and the six people in it are real rigged 3D characters (stage3d.js) rendered on a transparent canvas
// over the picture. They sit and type, walk to the gong, gather to talk, take coffee breaks and put on pyjamas
// at night, all driven by the same calls the 3D office gets (converse, ringBell, coffeeBreak, gatherAll, time of
// day). Name pills and speech bubbles follow the people and come from data: demo roster in demo mode, the live
// roster after login. Movement is planned on the painted floor (picture fractions); stage3d turns it into
// skeletal animation at the matching spot of the real 3D floor.
// The 3D bundle (stage3d.min.js) is loaded lazily, after the room picture is on screen. A device without WebGL (or a lost
// GL context) gets a light 2D fallback instead: a round emblem avatar per agent that sits at its desk and walks the same
// paths, with the same name pills and speech bubbles.
import { CALIB } from './concept-calib.js';
import { actorBox, hitTest } from './agent-card.js?v=1';

export const ROOM_DAY = './assets/office-room-day.jpg';
export const ROOM_NIGHT = './assets/office-room-night.jpg';
export const IMG_ASPECT = 1050 / 1000;              // the picture is laid out 1050 x 1000 inside the 1600 x 1000 concept frame
export const STAGE_URL = './stage3d.min.js?v=1';
export const MODEL_URL = './assets/models/agent.glb?v=2';
export const FRAME = { w: 1600, h: 1000, imgW: 1050, imgLeft: -25 };

// Desk seats in the picture, as fractions of the picture (x, y) where the name pill sits.
const px = (x, y) => ({ x: +((x + 25) / 1050).toFixed(4), y: +(y / 1000).toFixed(4) });
export const SLOTS = [
  px(260, 303), // 0 back-left
  px(504, 245), // 1 back-centre
  px(753, 309), // 2 back-right
  px(467, 416), // 3 mid-left
  px(740, 476), // 4 mid-right
  px(453, 603), // 5 front
];
export const SLOT_ORDER = [3, 1, 2, 4, 0, 5]; // which seat the nth agent without an explicit seat takes
// Where each person sits (the chair behind the desk, in picture fractions) and the two ways round the desk to it.
export const SEATS = CALIB.seat.map((s, i) => ({ fx: s[0], fy: s[1], sides: [{ x: CALIB.sideL[i][0], y: CALIB.sideL[i][1] }, { x: CALIB.sideR[i][0], y: CALIB.sideR[i][1] }] }));
export const SPOTS = {
  talk: [{ x: 0.575, y: 0.455 }, { x: 0.25, y: 0.585 }, { x: 0.81, y: 0.48 }],
  bell: { x: 0.845, y: 0.705 },
  coffee: [{ x: 0.665, y: 0.325 }, { x: 0.715, y: 0.325 }, { x: 0.69, y: 0.355 }],
  meet: { x: 0.70, y: 0.36, r: 0.07 },
};
// things a person can not walk through: the six desks (floor footprint, from the calibration) and two pieces of furniture
const rect = (a, b, c, d) => [[a, b], [c, b], [c, d], [a, d]];
const BLOCK = [...CALIB.foot, rect(0.60, 0.15, 0.80, 0.265), rect(0.55, 0.79, 0.67, 0.87)];
const FLOOR = [[0.07, 0.40], [0.10, 0.33], [0.54, 0.205], [0.60, 0.215], [0.78, 0.26], [0.96, 0.37], [0.95, 0.78], [0.90, 0.84], [0.42, 0.875], [0.05, 0.45]];

/** seat for each agent: explicit `slot` first, then the free seats in SLOT_ORDER. Max 6. */
export function assignSlots(agents) {
  const used = new Set(), out = new Map();
  for (const a of agents) if (Number.isInteger(a.slot) && a.slot >= 0 && a.slot < SLOTS.length && !used.has(a.slot) && out.size < SLOTS.length) { out.set(a.id, a.slot); used.add(a.slot); }
  const free = SLOT_ORDER.filter(s => !used.has(s));
  for (const a of agents) { if (out.has(a.id) || !free.length) continue; const s = free.shift(); out.set(a.id, s); }
  return out;
}

/** layout of the picture inside a W x H box: desktop = the concept frame scaled to fit; phones = picture fills the width */
export function layoutFor(W, H, zoom = 1) {
  if (W >= 901) {
    const u = Math.min(W / FRAME.w, H / FRAME.h);
    const imgW = FRAME.imgW * u, imgH = FRAME.h * u;
    return { u, left: FRAME.imgLeft * u, top: (H - imgH) / 2, w: imgW, h: imgH, zoom, desktop: true };
  }
  const w = Math.min(Math.max(W * 1.35, H * IMG_ASPECT), W * 1.6), h = w / IMG_ASPECT; // phones: a little wider than the screen so the desks stay big
  return { u: w / FRAME.imgW, left: W / 2 - 0.505 * w, top: (H - h) / 2, w, h, zoom, desktop: false };
}

/* ---------------- walking: a small grid planner over the floor, around the desks ---------------- */
const inPoly = (x, y, poly = FLOOR) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
const inBlock = (x, y) => BLOCK.some(poly => inPoly(x, y, poly));
const free = (x, y) => inPoly(x, y) && !inBlock(x, y);
const STEP = 0.025;
function segFree(a, b) { const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.01); for (let i = 1; i < n; i++) { const t = i / n; if (!free(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return false; } return true; }
export function planPath(from, to) {
  if (segFree(from, to)) return [to];
  const key = (i, j) => i + ',' + j, nodes = new Map();
  const snap = p => { let best = null, bd = 1e9; for (let r = 0; r < 14 && !best; r++) for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) { if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue; const i = Math.round(p.x / STEP) + di, j = Math.round(p.y / STEP) + dj; if (!free(i * STEP, j * STEP)) continue; const d = Math.hypot(i * STEP - p.x, j * STEP - p.y); if (d < bd) { bd = d; best = [i, j]; } } return best || [Math.round(p.x / STEP), Math.round(p.y / STEP)]; };
  const s = snap(from), g = snap(to), open = [{ i: s[0], j: s[1], g: 0, f: 0, prev: null }], best = new Map([[key(s[0], s[1]), 0]]);
  let end = null, guard = 0;
  while (open.length && guard++ < 6000) {
    open.sort((a, b) => a.f - b.f); const cur = open.shift();
    if (cur.i === g[0] && cur.j === g[1]) { end = cur; break; }
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const i = cur.i + di, j = cur.j + dj, x = i * STEP, y = j * STEP; if (!free(x, y)) continue;
      const cost = cur.g + Math.hypot(di, dj), k = key(i, j); if (best.has(k) && best.get(k) <= cost) continue; best.set(k, cost);
      open.push({ i, j, g: cost, f: cost + Math.hypot(i - g[0], j - g[1]), prev: cur });
    }
  }
  if (!end) return [to];
  const pts = []; for (let n = end; n; n = n.prev) pts.push({ x: n.i * STEP, y: n.j * STEP });
  pts.reverse();
  // string-pull: drop points that are not needed
  const out = []; let a = from;
  for (let k = 0; k < pts.length; k++) { if (k + 1 < pts.length && segFree(a, pts[k + 1])) continue; out.push(pts[k]); a = pts[k]; }
  out.push(to);
  return out;
}

export function createConcept(root, { esc = s => String(s), onLine = () => {}, avatar = null, onStrike = () => {}, onPick = null, stageUrl = STAGE_URL, forceFallback = false } = {}) {
  const dayImg = root.querySelector('.cv-img'), nightImg = root.querySelector('.cv-img-night'), pillsEl = root.querySelector('.cv-pills'), world = root.querySelector('.cv-world');
  let cast = [], seats = new Map(), W = 0, H = 0, zoom = 1, pan = 0, lay = null, night = 0;
  const status = new Map(), timers = new Map(), actors = new Map(), speakUntil = new Map();
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let box = { x: 0, y: 0, w: 1, h: 1 };
  let stage = null, fallback = false, onScreen = true, nightLoaded = false;
  const dotsEl = document.createElement('div'); dotsEl.className = 'cv-dots'; dotsEl.setAttribute('aria-hidden', 'true');
  root.insertBefore(dotsEl, pillsEl);

  /* ---------- the 3D people, loaded after the picture is on screen ---------- */
  const hasWebGL = () => { try { const c = document.createElement('canvas'), g = c.getContext('webgl2') || c.getContext('webgl'); if (!g) return false; g.getExtension('WEBGL_lose_context')?.loseContext(); return true; } catch { return false; } };
  /** no WebGL (or it died): round emblem avatars at the desks instead of 3D people */
  function useFallback(why) {
    if (fallback) return;
    fallback = true; root.classList.add('cv-fallback');
    console.warn('3D people not drawn, using the light 2D fallback:', why && why.message || why);
    if (stage) { try { stage.dispose(); } catch { /* already gone */ } stage = null; }
    buildDots(); place(); kick();
  }
  async function loadStage() {
    if (forceFallback) return useFallback('forced');
    try {
      const modP = import(stageUrl);   // the downloads (bundle, model) run while we probe for WebGL
      fetch(MODEL_URL).catch(() => {}); // warms the HTTP cache: the loader's own request joins this one
      if (!hasWebGL()) { modP.catch(() => {}); return useFallback('no WebGL'); }
      const mod = await modP;
      const st = mod.createStage(world, { modelUrl: MODEL_URL });
      st.canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); useFallback('GL context lost'); });
      st.loaded.catch(e => useFallback(e));
      stage = st; st.setCast(cast, seats);
      place(); kick();
    } catch (e) { useFallback(e); }
  }
  // the picture first (decoded and painted), then the 3D bundle and the model
  {
    const plate = new Image(); plate.src = ROOM_DAY;
    const afterPaint = () => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(loadStage, 0))); // two frames: the picture has been painted
    (plate.decode ? plate.decode() : new Promise((res, rej) => { plate.onload = res; plate.onerror = rej; })).catch(() => {}).then(afterPaint);
  }
  const stageReady = () => !!(stage && stage.ready);

  function recalc() {
    W = root.clientWidth; H = root.clientHeight;
    if (!W || !H) return false;
    lay = layoutFor(W, H, zoom);
    const z = lay.zoom;
    box = { x: W / 2 + (lay.left - W / 2) * z + pan * W, y: H / 2 + (lay.top - H / 2) * z, w: lay.w * z, h: lay.h * z };
    return true;
  }
  const P = (fx, fy) => ({ x: box.x + fx * box.w, y: box.y + fy * box.h });
  /** metres per picture-fraction at a point of the floor (for a constant walking speed in the real 3D space) */
  function mpf(x, y) {
    if (!stage || !stage.ready) return 6;
    return stage.metresPerFraction(x, y);
  }

  /* ---------- actors ---------- */
  function mkActor(a, seat) {
    const s = SEATS[seat];
    return { id: a.id, seat, x: s.fx, y: s.fy, state: 'sit', path: [], dir: null, look: null, hop: 0, onArrive: null, busy: null, away: false, exitT: 0, pendingPath: null };
  }
  /* ---------- pills, bubbles and avatars: positioned with `translate` only (no top/left, no layout reads per frame) ---------- */
  const setPos = (el, x, y) => { // writes only when the point really moved
    const kx = Math.round(x * 4), ky = Math.round(y * 4);
    if (el._kx === kx && el._ky === ky) return;
    el._kx = kx; el._ky = ky; el.style.translate = (kx / 4) + 'px ' + (ky / 4) + 'px';
  };
  const tagEls = new Map(), bubEls = new Map(), dotElsById = new Map();
  /** where the head is, in px: the 3D head when the model is up, else the desk seat's name-pill spot (2D fallback: it follows the avatar) */
  function headPx(ac, out) {
    const hd = stage && stage.headOf(ac.id);
    if (hd) { const p = P(hd.x, hd.y); out.x = p.x; out.y = p.y; return; }
    const s = SLOTS[ac.seat], sf = SEATS[ac.seat];
    const p = fallback ? P(ac.x + (s.x - sf.fx), ac.y + (s.y - sf.fy)) : P(s.x, s.y);
    out.x = p.x; out.y = p.y;
  }
  const _h = { x: 0, y: 0 };
  function pillFor(ac) {
    const el = tagEls.get(ac.id); if (!el) return;
    headPx(ac, _h); let x = _h.x, y = _h.y;
    const pv = ac.pill; if (pv && Math.abs(pv.x - x) < 80 && Math.abs(pv.y - y) < 80) { x = pv.x + (x - pv.x) * 0.35; y = pv.y + (y - pv.y) * 0.35; } ac.pill = { x, y };
    setPos(el, x, y);
    const b = bubEls.get(ac.id);
    if (b) { const bw = b._w || 160; setPos(b, Math.max(bw / 2 + 6, Math.min(W - bw / 2 - 6, x)), y - 24 * (lay?.desktop ? lay.u : 0.8)); }
    if (fallback) dotFor(ac);
  }
  function buildDots() {
    dotsEl.innerHTML = ''; dotElsById.clear();
    if (!fallback) return;
    for (const a of cast) {
      const el = document.createElement('div'); el.className = 'cv-dot'; el.dataset.id = a.id; el.style.setProperty('--ac', a.color);
      el.innerHTML = '<i class="sh"></i><b class="av">' + (avatar ? avatar(a) : esc((a.name || '?').slice(0, 1).toUpperCase())) + '</b><u class="zz">z</u>';
      dotsEl.appendChild(el); dotElsById.set(a.id, el);
    }
  }
  function dotFor(ac) {
    const el = dotElsById.get(ac.id); if (!el) return;
    const s = SLOTS[ac.seat], sf = SEATS[ac.seat];
    const p = P(ac.x + (s.x - sf.fx), ac.y + (s.y - sf.fy) + 0.052); // just under the name pill, which sits at head height
    setPos(el, p.x, p.y);
    const depth = 0.72 + Math.max(0, Math.min(1, (ac.y - 0.3) / 0.5)) * 0.5; // nearer to the viewer = bigger
    const sc = depth.toFixed(2); if (el._sc !== sc) { el._sc = sc; el.style.setProperty('--dz', sc); }
    const sl = night > 0.55 && ac.state === 'sit' && !(status.get(ac.id) === 'working' || status.get(ac.id) === 'typing') ? '1' : '0';
    if (el.dataset.sleep !== sl) el.dataset.sleep = sl;
    const wk = ac.state === 'walk' ? '1' : '0'; if (el.dataset.walk !== wk) el.dataset.walk = wk;
  }

  /* ---------- clicking / tapping a person ----------
     Their hit box is computed on a pointer event only (nothing runs per frame while the card is closed): from above the head
     down to the feet (or the bottom of the 2D avatar), at least 44 px each way. The name pill is a target of its own. */
  const _hd = { x: 0, y: 0 };
  function boxes() {
    const out = [], r = 26 * (lay?.desktop ? lay.u : 0.8);
    for (const ac of actors.values()) {
      headPx(ac, _hd);
      const head = { x: _hd.x, y: _hd.y };
      let feet, extra = 0;
      if (fallback) { const s = SLOTS[ac.seat], sf = SEATS[ac.seat]; feet = P(ac.x + (s.x - sf.fx), ac.y + (s.y - sf.fy) + 0.052); extra = r; } else feet = P(ac.x, ac.y);
      out.push(actorBox(ac.id, head, feet, { extraBottom: extra }));
    }
    return out;
  }
  function pickAt(clientX, clientY) {
    const rc = root.getBoundingClientRect();
    return hitTest(boxes(), clientX - rc.left, clientY - rc.top);
  }
  /** where a person is, in client px (the card opens beside this point) */
  function anchorOf(id) {
    const ac = actors.get(id); if (!ac) return null;
    const rc = root.getBoundingClientRect(); headPx(ac, _hd);
    return { x: rc.left + _hd.x, y: rc.top + _hd.y };
  }
  const isSleeping = id => { const ac = actors.get(id); return !!ac && night > 0.55 && ac.state === 'sit' && !(status.get(id) === 'working' || status.get(id) === 'typing'); };
  if (onPick) {
    const idAt = e => { const t = e.target && e.target.closest ? e.target.closest('.cv-tag') : null; return t ? t.dataset.id : pickAt(e.clientX, e.clientY); };
    root.addEventListener('click', e => { const id = idAt(e); onPick(id, id ? anchorOf(id) : null, e); });   // a click on empty room reports null (closes the card)
    root.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('cv-tag')) { e.preventDefault(); const id = e.target.dataset.id; onPick(id, anchorOf(id), e); } });
    let hoverT = 0, hovering = false;
    root.addEventListener('pointermove', e => {                    // mouse only; at most every 60 ms
      if (e.pointerType !== 'mouse' || e.timeStamp - hoverT < 60) return; hoverT = e.timeStamp;
      const on = !!pickAt(e.clientX, e.clientY);
      if (on !== hovering) { hovering = on; root.style.cursor = on ? 'pointer' : ''; }
    }, { passive: true });
    root.addEventListener('pointerleave', () => { if (hovering) { hovering = false; root.style.cursor = ''; } });
  }
  const poses = new Map();
  let raf = 0, last = 0, perfAcc = 0, perfN = 0, perfT0 = 0;
  const anyMoving = () => { for (const ac of actors.values()) if (ac.state !== 'sit' || ac.hop > 0 || (speakUntil.get(ac.id) || 0) > now0) return true; return false; };
  let now0 = 0;
  function tick(now) {
    raf = 0;
    if (!W || !H || document.hidden || !onScreen) return;       // nothing visible: no frames at all
    now0 = now;
    const moving = anyMoving();
    // phones draw at ~30 fps; so does a calm room (everybody seated, typing or asleep) on any screen; walking is smooth everywhere
    const gap = ((lay && !lay.desktop) || !moving) ? 31 : 0;
    if (now - last < gap) { raf = requestAnimationFrame(tick); return; }
    const raw = (now - last) / 1000, dt = Math.min(0.1, raw || 0.016); last = now;
    for (const ac of actors.values()) {
      if (ac.state === 'exit') { ac.exitT -= dt; if (ac.exitT <= 0) { ac.state = 'walk'; ac.path = ac.pendingPath || []; ac.pendingPath = null; } }
      else if (ac.state === 'walk') {
        const tgt = ac.path[0];
        if (!tgt) { ac.state = ac.after || 'sit'; ac.dir = null; const cb = ac.onArrive; ac.onArrive = null; cb && cb(); }
        else {
          const dx = tgt.x - ac.x, dy = tgt.y - ac.y, d = Math.hypot(dx, dy), step = 1.25 * dt / mpf(ac.x, ac.y);
          if (d <= step) { ac.x = tgt.x; ac.y = tgt.y; ac.path.shift(); } else { ac.x += dx / d * step; ac.y += dy / d * step; }
          if (d > 1e-6) { const dr = ac.dir || (ac.dir = { x: 0, y: 0 }); dr.x = dx / d * 0.02; dr.y = dy / d * 0.02; }
        }
      }
      if (ac.hop > 0) ac.hop = Math.max(0, ac.hop - dt / 0.7);
      const st = status.get(ac.id), spk = (speakUntil.get(ac.id) || 0) > now;
      let po = poses.get(ac.id); if (!po) poses.set(ac.id, po = {});   // one reused pose object per person
      po.fx = ac.x; po.fy = ac.y; po.mode = ac.state === 'sit' ? 'sit' : ac.state === 'exit' ? 'exit' : ac.state === 'walk' ? 'walk' : 'stand';
      po.dirX = ac.dir?.x; po.dirY = ac.dir?.y; po.lookX = ac.look?.x; po.lookY = ac.look?.y; po.speaking = spk; po.night = night; po.typing = st === 'working' || st === 'typing'; po.hop = ac.hop;
    }
    if (stage) { stage.resize(box); stage.frame(dt, poses, night, now / 1000); }
    for (const ac of actors.values()) pillFor(ac);
    // adaptive quality: when frames keep running long, give back pixel ratio (then stop adapting)
    if (stage && stage.ready) {
      if (!perfT0) perfT0 = now;
      if (now - perfT0 > 2500) { perfAcc += raw; perfN++; if (perfAcc > 2.5) { const avg = perfAcc / perfN; perfAcc = 0; perfN = 0; if (avg > (moving ? 1 / 22 : 1 / 20)) stage.lowerQuality(); } }
    }
    raf = requestAnimationFrame(tick);
  }
  function kick() { if (!raf && !document.hidden && onScreen) { last = performance.now(); raf = requestAnimationFrame(tick); } }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { perfAcc = 0; perfN = 0; kick(); });
  if (typeof IntersectionObserver === 'function') new IntersectionObserver(es => { const v = es[es.length - 1].isIntersecting; if (v !== onScreen) { onScreen = v; perfAcc = 0; perfN = 0; if (v) kick(); } }).observe(root);

  /** walk to a spot; a person who is sitting stands up first and goes round the desk by its side */
  function walkTo(ac, spot, { after = 'stand', onArrive = null, look = null } = {}) {
    const finish = () => { if (look) ac.look = look; onArrive && onArrive(); };
    if (reduced) { ac.x = spot.x; ac.y = spot.y; ac.state = after; ac.away = ac.away && after !== 'sit'; finish(); kick(); return; }
    ac.after = after; ac.onArrive = finish;
    if (ac.state === 'sit') {
      const s = SEATS[ac.seat], side = s.sides.slice().sort((a, b) => Math.hypot(a.x - spot.x, a.y - spot.y) - Math.hypot(b.x - spot.x, b.y - spot.y))[0];
      ac.x = s.fx; ac.y = s.fy; ac.state = 'exit'; ac.exitT = 1.05; ac.look = null;
      ac.pendingPath = [side, ...planPath(side, spot)];
    } else { ac.path = planPath({ x: ac.x, y: ac.y }, spot); ac.state = 'walk'; }
    kick();
  }
  function goSeat(ac, cb) {
    const s = SEATS[ac.seat], from = { x: ac.x, y: ac.y };
    const side = s.sides.slice().sort((a, b) => Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y))[0];
    if (reduced) { ac.x = s.fx; ac.y = s.fy; ac.state = 'sit'; ac.away = false; cb && cb(); kick(); return; }
    ac.path = [...planPath(from, side), { x: s.fx, y: s.fy }]; ac.state = 'walk'; ac.after = 'sit'; ac.look = null;
    ac.onArrive = () => { ac.away = false; cb && cb(); };
    kick();
  }
  function leaveSeat(ac) { ac.away = true; }

  /* ---------- scenes ---------- */
  const convoQ = []; let convoBusy = false, talkers = [];
  function converse(spec) {
    const ids = [...new Set((spec.participants || []).concat((spec.lines || []).map(l => l.agent)))].filter(id => actors.has(id) && !actors.get(id).busy);
    const lines = (spec.lines || []).filter(l => l && l.text && actors.has(l.agent));
    if (!lines.length) return false;
    if (ids.length < 2) { const l = lines[0]; say(l.agent, l.text, 3600); onLine(l.agent, l.text); return true; }
    if (convoBusy) { if (convoQ.length < 3) convoQ.push(spec); return true; }
    convoBusy = true;
    const members = ids.map(id => actors.get(id));
    talkers = ids.slice();
    const cx = members.reduce((s, a) => s + SEATS[a.seat].fx, 0) / members.length, cy = members.reduce((s, a) => s + SEATS[a.seat].fy, 0) / members.length;
    const spot = SPOTS.talk.slice().sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))[0];
    let arrived = 0;
    members.forEach((ac, i) => {
      ac.busy = 'talk'; leaveSeat(ac);
      const ang = members.length === 2 ? (i ? 0 : Math.PI) : (i / members.length) * Math.PI * 2 + 0.4;
      const target = { x: spot.x + Math.cos(ang) * 0.045, y: spot.y + Math.sin(ang) * 0.022 };
      walkTo(ac, target, { after: 'stand', look: { x: spot.x, y: spot.y + 0.004 }, onArrive: () => { if (++arrived === members.length) speak(); } });
    });
    function speak() {
      let t = 500;
      lines.forEach(l => { setTimeout(() => { say(l.agent, l.text, 3000); onLine(l.agent, l.text); }, t); t += 2900; });
      setTimeout(() => { let back = 0; members.forEach(ac => goSeat(ac, () => { ac.busy = null; if (++back === members.length) { convoBusy = false; talkers = []; const nx = convoQ.shift(); if (nx) converse(nx); } })); }, t + 900);
    }
    return true;
  }
  function bell(id, label) {
    const ac = actors.get(id); if (!ac || ac.busy) return false;
    ac.busy = 'bell'; leaveSeat(ac);
    walkTo(ac, SPOTS.bell, { after: 'stand', look: { x: SPOTS.bell.x + 0.06, y: SPOTS.bell.y - 0.035 }, onArrive: () => {
      ring(id); root.classList.add('bell-shake'); setTimeout(() => root.classList.remove('bell-shake'), 1500);
      onStrike(0.8); setTimeout(() => onStrike(1), 650); // two strikes of the gong
      if (label) say(id, label, 3000);
      setTimeout(() => goSeat(ac, () => { ac.busy = null; }), 2600);
    } });
    return true;
  }
  function coffee(id, secs = 5) {
    const ac = actors.get(id); if (!ac || ac.busy) return false;
    ac.busy = 'coffee'; leaveSeat(ac);
    const spot = SPOTS.coffee[ac.seat % SPOTS.coffee.length];
    walkTo(ac, spot, { after: 'stand', look: { x: spot.x + 0.02, y: spot.y - 0.06 }, onArrive: () => setTimeout(() => goSeat(ac, () => { ac.busy = null; }), secs * 1000) });
    return true;
  }
  function gather(on) {
    const list = [...actors.values()].filter(a => !a.busy || a.busy === 'meet');
    if (on) {
      list.forEach((ac, i) => {
        ac.busy = 'meet'; leaveSeat(ac);
        const ang = (i / list.length) * Math.PI * 2 + 0.3, m = SPOTS.meet;
        walkTo(ac, { x: m.x + Math.cos(ang) * m.r, y: m.y + Math.sin(ang) * m.r * 0.55 }, { after: 'stand', look: { x: m.x, y: m.y } });
      });
    } else list.forEach(ac => { if (ac.busy === 'meet') goSeat(ac, () => { ac.busy = null; }); });
  }
  function hop(id) { const ac = actors.get(id); if (ac) { ac.hop = 1; kick(); } }

  /* ---------- pills, bubbles, layout ---------- */
  function place() {
    if (!recalc()) return;
    for (const el of [dayImg, nightImg]) if (el) { const st = el.style; st.left = box.x.toFixed(1) + 'px'; st.top = box.y.toFixed(1) + 'px'; st.width = box.w.toFixed(1) + 'px'; st.height = box.h.toFixed(1) + 'px'; }
    document.body.style.setProperty('--pz', lay.desktop ? Math.max(0.7, Math.min(1.15, lay.u)).toFixed(3) : '1');
    root.style.setProperty('--cvu', Math.max(0.62, Math.min(1.1, lay.desktop ? lay.u : 0.8)).toFixed(3));
    if (stage) stage.resize(box);
    for (const ac of actors.values()) pillFor(ac);
    kick();
  }
  function setCast(list) {
    cast = list.slice(0, SLOTS.length);
    seats = assignSlots(cast);
    for (const id of [...actors.keys()]) if (!seats.has(id)) actors.delete(id);
    for (const a of cast) {
      const seat = seats.get(a.id), cur = actors.get(a.id);
      if (cur && cur.seat === seat) continue;
      actors.set(a.id, mkActor(a, seat));
    }
    if (stage) stage.setCast(cast, seats);
    pillsEl.innerHTML = cast.map(a => `<div class="cv-tag" role="button" tabindex="0" aria-label="${esc(a.name)} · פרטים" data-id="${esc(a.id)}" data-seat="${seats.get(a.id)}" data-st="${status.get(a.id) || 'working'}" style="--ac:${esc(a.color)}"><i></i><span class="nm">${esc(a.name)}</span><span class="zz" aria-hidden="true">z</span></div>`).join('');
    tagEls.clear(); bubEls.clear();
    pillsEl.querySelectorAll('.cv-tag').forEach(el => tagEls.set(el.dataset.id, el));
    buildDots();
    place();
  }
  function setStatus(id, st) {
    status.set(id, st);
    const el = tagEls.get(id); if (el) el.dataset.st = st;
    kick();
  }
  function say(id, text, ms = 3600) {
    const ac = actors.get(id); if (!ac || !text) return false;
    clearTimeout(timers.get(id));
    speakUntil.set(id, performance.now() + Math.min(ms, 4200));
    let b = bubEls.get(id);
    if (!b) { b = document.createElement('div'); b.className = 'cv-bub'; b.dataset.for = id; pillsEl.appendChild(b); bubEls.set(id, b); }
    b.textContent = text; b._w = b.offsetWidth || 160; b._kx = null; // measured once per line, never per frame
    pillFor(ac);
    requestAnimationFrame(() => b.classList.add('on'));
    timers.set(id, setTimeout(() => { b.classList.remove('on'); setTimeout(() => { b.remove(); if (bubEls.get(id) === b) bubEls.delete(id); }, 300); }, ms));
    kick();
    return true;
  }
  function ring(id) {
    const el = tagEls.get(id); if (!el) return;
    el.classList.remove('ring'); void el.offsetWidth; el.classList.add('ring'); setTimeout(() => el.classList.remove('ring'), 2600);
  }
  function setNight(n) {
    night = n;
    if (n > 0.01 && !nightLoaded && nightImg) { nightLoaded = true; nightImg.style.backgroundImage = `url(${ROOM_NIGHT})`; } // the night picture is fetched the first time it is needed
    kick();
  }
  function setZoom(z) { zoom = Math.max(1, Math.min(2.2, z)); place(); }
  function setPan(p) { pan = Math.max(-0.3, Math.min(0.3, p)); place(); }
  const ro = new ResizeObserver(() => { place(); });
  ro.observe(root);
  return { setCast, setStatus, say, ring, place, pickAt, anchorOf, isSleeping, boxes, setZoom, getZoom: () => zoom, setPan, getPan: () => pan, seatOf: id => seats.get(id), converse, bell, coffee, gather, hop, setNight,
    talking: () => talkers.slice(), get fallback() { return fallback; }, actorState: id => { const a = actors.get(id); return a ? { state: a.state, x: a.x, y: a.y, busy: a.busy } : null; }, get cast() { return cast; }, get stage() { return stage; }, get cast3d() { return stage ? [...stage.chars.keys()] : []; } };
}
