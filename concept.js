// concept.js — the "concept room": the approved Apple-style room is the scene (an empty day plate and a night
// plate) and the six people in it are real rigged 3D characters (stage3d.js) rendered on a transparent canvas
// over the picture. They sit and type, walk to the gong, gather to talk, take coffee breaks and put on pyjamas
// at night, all driven by the same calls the 3D office gets (converse, ringBell, coffeeBreak, gatherAll, time of
// day). Name pills and speech bubbles follow the people and come from data: demo roster in demo mode, the live
// roster after login. Movement is planned on the painted floor (picture fractions); stage3d turns it into
// skeletal animation at the matching spot of the real 3D floor.
import { createStage } from './stage3d.js?v=2';
import { CALIB } from './concept-calib.js';

export const ROOM_DAY = './assets/office-room-day.jpg';
export const ROOM_NIGHT = './assets/office-room-night.jpg';
export const IMG_ASPECT = 1050 / 1000;              // the picture is laid out 1050 x 1000 inside the 1600 x 1000 concept frame
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

export function createConcept(root, { esc = s => String(s), onLine = () => {} } = {}) {
  const dayImg = root.querySelector('.cv-img'), nightImg = root.querySelector('.cv-img-night'), pillsEl = root.querySelector('.cv-pills'), world = root.querySelector('.cv-world');
  let cast = [], seats = new Map(), W = 0, H = 0, zoom = 1, pan = 0, lay = null, night = 0;
  const status = new Map(), timers = new Map(), actors = new Map(), speakUntil = new Map();
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let box = { x: 0, y: 0, w: 1, h: 1 };
  let stage = null;
  try { stage = createStage(world); } catch (e) { console.warn('no WebGL: the people are not drawn', e); }

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
    const a = stage.floorAt(x, y), b = stage.floorAt(x + 0.02, y + 0.02);
    return Math.max(1, a.distanceTo(b) / Math.hypot(0.02, 0.02));
  }

  /* ---------- actors ---------- */
  function mkActor(a, seat) {
    const s = SEATS[seat];
    return { id: a.id, seat, x: s.fx, y: s.fy, state: 'sit', path: [], dir: null, look: null, hop: 0, onArrive: null, busy: null, away: false, exitT: 0, pendingPath: null };
  }
  function pillFor(ac) {
    const el = pillsEl.querySelector(`.cv-tag[data-id="${CSS.escape(ac.id)}"]`); if (!el) return;
    let x, y;
    const hd = stage && stage.headOf(ac.id);
    if (!hd) { const s = SLOTS[ac.seat], p = P(s.x, s.y); x = p.x; y = p.y; }
    else { const p = P(hd.x, hd.y); x = p.x; y = p.y; }
    const pv = ac.pill; if (pv && Math.abs(pv.x - x) < 80 && Math.abs(pv.y - y) < 80) { x = pv.x + (x - pv.x) * 0.35; y = pv.y + (y - pv.y) * 0.35; } ac.pill = { x, y };
    el.style.left = x.toFixed(1) + 'px'; el.style.top = y.toFixed(1) + 'px';
    const b = pillsEl.querySelector(`.cv-bub[data-for="${CSS.escape(ac.id)}"]`);
    if (b) { const bw = b.offsetWidth || 160; b.style.left = Math.max(bw / 2 + 6, Math.min(W - bw / 2 - 6, x)).toFixed(1) + 'px'; b.style.top = (y - 24 * (lay?.desktop ? lay.u : 0.8)).toFixed(1) + 'px'; }
  }
  const poses = new Map();
  let raf = 0, last = 0;
  function tick(now) {
    raf = 0;
    if (!W || !H || document.hidden) return;
    if (lay && !lay.desktop && now - last < 30) { raf = requestAnimationFrame(tick); return; } // phones: ~30 fps
    const dt = Math.min(0.1, (now - last) / 1000 || 0.016); last = now;
    for (const ac of actors.values()) {
      if (ac.state === 'exit') { ac.exitT -= dt; if (ac.exitT <= 0) { ac.state = 'walk'; ac.path = ac.pendingPath || []; ac.pendingPath = null; } }
      else if (ac.state === 'walk') {
        const tgt = ac.path[0];
        if (!tgt) { ac.state = ac.after || 'sit'; ac.dir = null; const cb = ac.onArrive; ac.onArrive = null; cb && cb(); }
        else {
          const dx = tgt.x - ac.x, dy = tgt.y - ac.y, d = Math.hypot(dx, dy), step = 1.25 * dt / mpf(ac.x, ac.y);
          if (d <= step) { ac.x = tgt.x; ac.y = tgt.y; ac.path.shift(); } else { ac.x += dx / d * step; ac.y += dy / d * step; }
          if (d > 1e-6) ac.dir = { x: dx / d * 0.02, y: dy / d * 0.02 };
        }
      }
      if (ac.hop > 0) ac.hop = Math.max(0, ac.hop - dt / 0.7);
      const st = status.get(ac.id), spk = (speakUntil.get(ac.id) || 0) > now;
      poses.set(ac.id, { fx: ac.x, fy: ac.y, mode: ac.state === 'sit' ? 'sit' : ac.state === 'exit' ? 'exit' : ac.state === 'walk' ? 'walk' : 'stand',
        dirX: ac.dir?.x, dirY: ac.dir?.y, lookX: ac.look?.x, lookY: ac.look?.y, speaking: spk, night, typing: st === 'working' || st === 'typing', hop: ac.hop });
    }
    if (stage) { stage.resize(box); stage.frame(dt, poses, night, now / 1000); }
    for (const ac of actors.values()) pillFor(ac);
    raf = requestAnimationFrame(tick);
  }
  function kick() { if (!raf && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(tick); } }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', kick);

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
  const convoQ = []; let convoBusy = false;
  function converse(spec) {
    const ids = [...new Set((spec.participants || []).concat((spec.lines || []).map(l => l.agent)))].filter(id => actors.has(id) && !actors.get(id).busy);
    const lines = (spec.lines || []).filter(l => l && l.text && actors.has(l.agent));
    if (!lines.length) return false;
    if (ids.length < 2) { const l = lines[0]; say(l.agent, l.text, 3600); onLine(l.agent, l.text); return true; }
    if (convoBusy) { if (convoQ.length < 3) convoQ.push(spec); return true; }
    convoBusy = true;
    const members = ids.map(id => actors.get(id));
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
      setTimeout(() => { let back = 0; members.forEach(ac => goSeat(ac, () => { ac.busy = null; if (++back === members.length) { convoBusy = false; const nx = convoQ.shift(); if (nx) converse(nx); } })); }, t + 900);
    }
    return true;
  }
  function bell(id, label) {
    const ac = actors.get(id); if (!ac || ac.busy) return false;
    ac.busy = 'bell'; leaveSeat(ac);
    walkTo(ac, SPOTS.bell, { after: 'stand', look: { x: SPOTS.bell.x + 0.06, y: SPOTS.bell.y - 0.035 }, onArrive: () => {
      ring(id); root.classList.add('bell-shake'); setTimeout(() => root.classList.remove('bell-shake'), 1500);
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
    for (const el of [dayImg, nightImg]) if (el) el.style.cssText = `left:${box.x.toFixed(1)}px;top:${box.y.toFixed(1)}px;width:${box.w.toFixed(1)}px;height:${box.h.toFixed(1)}px`;
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
    pillsEl.innerHTML = cast.map(a => `<div class="cv-tag" data-id="${esc(a.id)}" data-seat="${seats.get(a.id)}" data-st="${status.get(a.id) || 'working'}" style="--ac:${esc(a.color)}"><i></i><span class="nm">${esc(a.name)}</span><span class="zz" aria-hidden="true">z</span></div>`).join('');
    place();
  }
  function setStatus(id, st) {
    status.set(id, st);
    const el = pillsEl.querySelector(`[data-id="${CSS.escape(id)}"]`); if (el) el.dataset.st = st;
    kick();
  }
  function say(id, text, ms = 3600) {
    const ac = actors.get(id); if (!ac || !text) return false;
    clearTimeout(timers.get(id));
    speakUntil.set(id, performance.now() + Math.min(ms, 4200));
    let b = pillsEl.querySelector(`.cv-bub[data-for="${CSS.escape(id)}"]`);
    if (!b) { b = document.createElement('div'); b.className = 'cv-bub'; b.dataset.for = id; pillsEl.appendChild(b); }
    b.textContent = text;
    pillFor(ac);
    requestAnimationFrame(() => b.classList.add('on'));
    timers.set(id, setTimeout(() => { b.classList.remove('on'); setTimeout(() => b.remove(), 300); }, ms));
    kick();
    return true;
  }
  function ring(id) {
    const el = pillsEl.querySelector(`.cv-tag[data-id="${CSS.escape(id)}"]`); if (!el) return;
    el.classList.remove('ring'); void el.offsetWidth; el.classList.add('ring'); setTimeout(() => el.classList.remove('ring'), 2600);
  }
  function setNight(n) { night = n; kick(); }
  function setZoom(z) { zoom = Math.max(1, Math.min(2.2, z)); place(); }
  function setPan(p) { pan = Math.max(-0.3, Math.min(0.3, p)); place(); }
  const ro = new ResizeObserver(() => { place(); });
  ro.observe(root);
  return { setCast, setStatus, say, ring, place, setZoom, getZoom: () => zoom, setPan, getPan: () => pan, seatOf: id => seats.get(id), converse, bell, coffee, gather, hop, setNight,
    actorState: id => { const a = actors.get(id); return a ? { state: a.state, x: a.x, y: a.y, busy: a.busy } : null; }, get cast() { return cast; }, get stage() { return stage; }, get cast3d() { return stage ? [...stage.chars.keys()] : []; } };
}
