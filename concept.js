// concept.js — the "concept room": the approved Apple-style room is the scene (an empty day plate and a night
// plate) and the six people on it are animated sprites in the same style. The sprites sit, type, walk to the
// gong, gather to talk, take coffee breaks and put on pyjamas at night, all driven by the same calls the 3D
// office gets (converse, ringBell, coffeeBreak, gatherAll, time of day). Name pills and speech bubbles follow
// the sprites and come from data: demo roster in demo mode, the live roster after login.

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
// the person who sits at each seat in the picture (sprite set), and where: box = the seated cut-out, as fractions of the picture
export const SEAT_CHARS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
export const SEAT_BOX = [
  { x: 0.2091, y: 0.3133, w: 0.0982, h: 0.0836, fx: 0.2582, fy: 0.3969 },
  { x: 0.4539, y: 0.2562, w: 0.0975, h: 0.1016, fx: 0.5026, fy: 0.3578 },
  { x: 0.7046, y: 0.3266, w: 0.0789, h: 0.0992, fx: 0.744, fy: 0.4258 },
  { x: 0.4263, y: 0.4344, w: 0.0848, h: 0.0875, fx: 0.4688, fy: 0.5219 },
  { x: 0.7009, y: 0.4938, w: 0.0774, h: 0.1, fx: 0.7396, fy: 0.5938 },
  { x: 0.4033, y: 0.6234, w: 0.0967, h: 0.1008, fx: 0.4516, fy: 0.7242 },
];
const SPRITE_ASPECT = { stand: 113 / 338, walk1: 150 / 340, walk2: 156 / 340, pj: 121 / 335, sleep: 224 / 300 };
export const SPOTS = {
  talk: [{ x: 0.575, y: 0.455 }, { x: 0.25, y: 0.585 }, { x: 0.81, y: 0.48 }],
  bell: { x: 0.845, y: 0.705 },
  coffee: [{ x: 0.665, y: 0.325 }, { x: 0.715, y: 0.325 }, { x: 0.69, y: 0.355 }],
  meet: { x: 0.70, y: 0.36, r: 0.07 },
};
// things a person can not walk through (fractions of the picture), and the floor
const BLOCK = [[0.18, 0.36, 0.32, 0.46], [0.41, 0.28, 0.56, 0.38], [0.63, 0.36, 0.80, 0.46], [0.35, 0.47, 0.52, 0.57], [0.62, 0.53, 0.79, 0.64], [0.34, 0.66, 0.51, 0.77], [0.60, 0.15, 0.80, 0.265], [0.55, 0.79, 0.67, 0.87]];
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
const inBlock = (x, y, pad = 0.012) => BLOCK.some(([a, b, c, d]) => x > a - pad && x < c + pad && y > b - pad && y < d + pad);
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

const standH = y => 0.085 + 0.11 * y; // a standing person's height as a fraction of the picture height, by depth

export function createConcept(root, { esc = s => String(s), onLine = () => {} } = {}) {
  const dayImg = root.querySelector('.cv-img'), nightImg = root.querySelector('.cv-img-night'), pillsEl = root.querySelector('.cv-pills'), world = root.querySelector('.cv-world');
  let cast = [], seats = new Map(), W = 0, H = 0, zoom = 1, pan = 0, lay = null, night = 0;
  const status = new Map(), timers = new Map(), actors = new Map();
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let box = { x: 0, y: 0, w: 1, h: 1 };

  function recalc() {
    W = root.clientWidth; H = root.clientHeight;
    if (!W || !H) return false;
    lay = layoutFor(W, H, zoom);
    const z = lay.zoom;
    box = { x: W / 2 + (lay.left - W / 2) * z + pan * W, y: H / 2 + (lay.top - H / 2) * z, w: lay.w * z, h: lay.h * z };
    return true;
  }
  const P = (fx, fy) => ({ x: box.x + fx * box.w, y: box.y + fy * box.h });

  /* ---------- actors ---------- */
  function mkActor(a, seat) {
    const char = SEAT_CHARS[seat], el = document.createElement('img');
    el.className = 'cv-actor'; el.alt = ''; el.draggable = false; el.dataset.id = a.id; el.decoding = 'async';
    world.appendChild(el);
    const sb = SEAT_BOX[seat];
    return { id: a.id, seat, char, el, x: sb.fx, y: sb.fy, state: 'sit', queue: null, path: [], face: 1, walkT: 0, hop: 0, onArrive: null, busy: null, away: false };
  }
  function src(char, nm) { return `./assets/sprites/${char}-${nm}.webp`; }
  function draw(ac) {
    const el = ac.el, sb = SEAT_BOX[ac.seat];
    const nightMode = night > 0.55;
    let nm, hF, anchorX = ac.x, anchorY = ac.y, flip = 1, bob = 0;
    if (ac.state === 'sit') {
      if (nightMode) { nm = 'sleep'; hF = sb.h * 1.02; anchorX = sb.fx; anchorY = sb.fy; } else { nm = 'sit'; hF = sb.h; anchorX = sb.fx; anchorY = sb.fy; }
      if (!nightMode && status.get(ac.id) !== 'idle' && status.get(ac.id) !== 'offline' && !reduced) bob = Math.sin(performance.now() / 260 + ac.seat) * 0.0012;
    } else {
      hF = standH(ac.y) * (ac.state === 'hop' ? 1 : 1);
      if (nightMode) nm = 'pj'; else nm = ac.state === 'walk' ? (Math.floor(ac.walkT * 3.4) % 2 ? 'walk2' : 'walk1') : 'stand';
      flip = ac.face;
      if (ac.state === 'walk') bob = -Math.abs(Math.sin(ac.walkT * 3.4 * Math.PI)) * 0.004;
    }
    if (ac.hop > 0) bob -= Math.sin((1 - ac.hop) * Math.PI) * 0.03;
    const hPx = hF * box.h;
    let wPx;
    if (nm === 'sit') wPx = sb.w * box.w * (hF / sb.h); else wPx = hPx * (SPRITE_ASPECT[nm] || 0.4);
    const s = nm === 'sit' ? `./assets/sprites/${ac.char}-sit.webp` : src(ac.char, nm);
    if (el.dataset.src !== s) { el.dataset.src = s; el.src = s; }
    const p = P(anchorX, anchorY + bob);
    el.style.cssText = `width:${wPx.toFixed(1)}px;height:${hPx.toFixed(1)}px;left:${(p.x - wPx / 2).toFixed(1)}px;top:${(p.y - hPx).toFixed(1)}px;transform:scaleX(${flip});z-index:${Math.round(anchorY * 1000)}`;
    ac.head = { x: p.x, y: p.y - hPx };
  }
  function pillFor(ac) {
    const el = pillsEl.querySelector(`.cv-tag[data-id="${CSS.escape(ac.id)}"]`); if (!el) return;
    let x, y;
    if (ac.state === 'sit') { const s = SLOTS[ac.seat], p = P(s.x, s.y); x = p.x; y = p.y; }
    else { x = ac.head.x; y = ac.head.y - 14 * (lay?.desktop ? lay.u : 0.8); }
    el.style.left = x.toFixed(1) + 'px'; el.style.top = y.toFixed(1) + 'px';
    const b = pillsEl.querySelector(`.cv-bub[data-for="${CSS.escape(ac.id)}"]`);
    if (b) { const bw = b.offsetWidth || 160; b.style.left = Math.max(bw / 2 + 6, Math.min(W - bw / 2 - 6, x)).toFixed(1) + 'px'; b.style.top = (y - 24 * (lay?.desktop ? lay.u : 0.8)).toFixed(1) + 'px'; }
  }
  let raf = 0, last = 0;
  function tick(now) {
    raf = 0;
    const dt = Math.min(0.1, (now - last) / 1000 || 0.016); last = now;
    let anim = false;
    for (const ac of actors.values()) {
      if (ac.state === 'walk') {
        anim = true;
        const tgt = ac.path[0];
        if (!tgt) { ac.state = ac.after || 'sit'; const cb = ac.onArrive; ac.onArrive = null; cb && cb(); }
        else {
          const dx = tgt.x - ac.x, dy = tgt.y - ac.y, d = Math.hypot(dx, dy), step = 0.13 * dt * (0.8 + ac.y * 0.5);
          ac.walkT += dt;
          if (d <= step) { ac.x = tgt.x; ac.y = tgt.y; ac.path.shift(); } else { ac.x += dx / d * step; ac.y += dy / d * step; if (Math.abs(dx) > 0.002) ac.face = dx > 0 ? 1 : -1; }
        }
      }
      if (ac.hop > 0) { ac.hop = Math.max(0, ac.hop - dt / 0.7); anim = true; }
      draw(ac); pillFor(ac);
    }
    const typing = !night && [...actors.values()].some(a => a.state === 'sit');
    if (anim || typing) raf = requestAnimationFrame(tick);
  }
  function kick() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); } }
  function walkTo(ac, spot, { after = 'stand', onArrive = null, face = null } = {}) {
    if (reduced) { ac.x = spot.x; ac.y = spot.y; ac.state = after; onArrive && onArrive(); kick(); return; }
    const from = { x: ac.x, y: ac.y };
    ac.path = planPath(from, spot); ac.state = 'walk'; ac.after = after; ac.onArrive = () => { if (face) ac.face = face; onArrive && onArrive(); };
    kick();
  }
  function goSeat(ac, cb) { const sb = SEAT_BOX[ac.seat]; walkTo(ac, { x: sb.fx, y: sb.fy }, { after: 'sit', onArrive: () => { ac.away = false; cb && cb(); } }); }
  function leaveSeat(ac) { // stand up from the chair: the standing sprite appears beside it
    const sb = SEAT_BOX[ac.seat]; ac.x = sb.fx - 0.02; ac.y = sb.fy + 0.012; ac.away = true;
  }

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
    const cx = members.reduce((s, a) => s + SEAT_BOX[a.seat].fx, 0) / members.length, cy = members.reduce((s, a) => s + SEAT_BOX[a.seat].fy, 0) / members.length;
    const spot = SPOTS.talk.slice().sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))[0];
    let arrived = 0;
    members.forEach((ac, i) => {
      ac.busy = 'talk'; leaveSeat(ac);
      const ang = members.length === 2 ? (i ? 0 : Math.PI) : (i / members.length) * Math.PI * 2 + 0.4;
      const target = { x: spot.x + Math.cos(ang) * 0.05, y: spot.y + Math.sin(ang) * 0.025 };
      walkTo(ac, target, { after: 'stand', face: Math.cos(ang) > 0 ? -1 : 1, onArrive: () => { if (++arrived === members.length) speak(); } });
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
    walkTo(ac, SPOTS.bell, { after: 'stand', face: 1, onArrive: () => {
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
    walkTo(ac, spot, { after: 'stand', face: -1, onArrive: () => setTimeout(() => goSeat(ac, () => { ac.busy = null; }), secs * 1000) });
    return true;
  }
  function gather(on) {
    const list = [...actors.values()].filter(a => !a.busy || a.busy === 'meet');
    if (on) {
      list.forEach((ac, i) => {
        ac.busy = 'meet'; leaveSeat(ac);
        const ang = (i / list.length) * Math.PI * 2 + 0.3, m = SPOTS.meet;
        walkTo(ac, { x: m.x + Math.cos(ang) * m.r, y: m.y + Math.sin(ang) * m.r * 0.55 }, { after: 'stand', face: Math.cos(ang) > 0 ? -1 : 1 });
      });
    } else list.forEach(ac => { if (ac.busy === 'meet') goSeat(ac, () => { ac.busy = null; }); });
  }
  function hop(id) { const ac = actors.get(id); if (ac) { ac.hop = 1; kick(); } }

  /* ---------- pills, bubbles, layout ---------- */
  function place() {
    if (!recalc()) return;
    const z = lay.zoom;
    for (const el of [dayImg, nightImg]) if (el) el.style.cssText = `left:${box.x.toFixed(1)}px;top:${box.y.toFixed(1)}px;width:${box.w.toFixed(1)}px;height:${box.h.toFixed(1)}px`;
    document.body.style.setProperty('--pz', lay.desktop ? Math.max(0.7, Math.min(1.15, lay.u)).toFixed(3) : '1');
    root.style.setProperty('--cvu', Math.max(0.62, Math.min(1.1, lay.desktop ? lay.u : 0.8)).toFixed(3));
    for (const ac of actors.values()) { draw(ac); pillFor(ac); }
    kick();
  }
  function setCast(list) {
    cast = list.slice(0, SLOTS.length);
    seats = assignSlots(cast);
    for (const [id, ac] of actors) if (!seats.has(id)) { ac.el.remove(); actors.delete(id); }
    for (const a of cast) {
      const seat = seats.get(a.id), cur = actors.get(a.id);
      if (cur && cur.seat === seat) continue;
      if (cur) cur.el.remove();
      actors.set(a.id, mkActor(a, seat));
    }
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
    let b = pillsEl.querySelector(`.cv-bub[data-for="${CSS.escape(id)}"]`);
    if (!b) { b = document.createElement('div'); b.className = 'cv-bub'; b.dataset.for = id; pillsEl.appendChild(b); }
    b.textContent = text;
    pillFor(ac);
    requestAnimationFrame(() => b.classList.add('on'));
    timers.set(id, setTimeout(() => { b.classList.remove('on'); setTimeout(() => b.remove(), 300); }, ms));
    return true;
  }
  function ring(id) {
    const el = pillsEl.querySelector(`.cv-tag[data-id="${CSS.escape(id)}"]`); if (!el) return;
    el.classList.remove('ring'); void el.offsetWidth; el.classList.add('ring'); setTimeout(() => el.classList.remove('ring'), 2600);
  }
  function setNight(n) { const was = night > 0.55; night = n; if ((n > 0.55) !== was) { for (const ac of actors.values()) draw(ac); } kick(); }
  function setZoom(z) { zoom = Math.max(1, Math.min(2.2, z)); place(); }
  function setPan(p) { pan = Math.max(-0.3, Math.min(0.3, p)); place(); }
  const ro = new ResizeObserver(() => { place(); });
  ro.observe(root);
  return { setCast, setStatus, say, ring, place, setZoom, getZoom: () => zoom, setPan, getPan: () => pan, seatOf: id => seats.get(id), converse, bell, coffee, gather, hop, setNight,
    actorState: id => { const a = actors.get(id); return a ? { state: a.state, x: a.x, y: a.y, busy: a.busy } : null; }, get cast() { return cast; } };
}
