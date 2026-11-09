// concept.js — the "concept room": the approved Apple-style room picture is the scene, and everything that
// moves on top of it (name pills, status, speech bubbles, the bell) is driven by live data.
// The pills follow the agents of the current mode (demo roster, or the real live roster after login),
// so live names always come from the live roster and never from the demo list.

export const ROOM_IMG = './assets/office-room.jpg';
export const IMG_ASPECT = 1050 / 1000;              // the picture is laid out 1050 x 1000 inside the 1600 x 1000 concept frame
export const FRAME = { w: 1600, h: 1000, imgW: 1050, imgLeft: -25 };

// Desk seats in the picture, as fractions of the picture (x, y) where the name pill sits.
// Derived from the concept frame (px in the 1600x1000 frame, picture offset -25px).
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

export function createConcept(root, { esc = s => String(s) } = {}) {
  const img = root.querySelector('.cv-img'), pillsEl = root.querySelector('.cv-pills');
  let cast = [], seats = new Map(), W = 0, H = 0, zoom = 1, pan = 0, lay = null;
  const status = new Map(), timers = new Map();

  function pos(seat) {
    const s = SLOTS[seat]; if (!s || !lay) return { x: 0, y: 0 };
    let x = lay.left + s.x * lay.w, y = lay.top + s.y * lay.h;
    if (lay.zoom !== 1) { x = W / 2 + (x - W / 2) * lay.zoom; y = H / 2 + (y - H / 2) * lay.zoom; }
    return { x: x + pan * W, y };
  }
  function place() {
    W = root.clientWidth; H = root.clientHeight;
    if (!W || !H) return;
    lay = layoutFor(W, H, zoom);
    const z = lay.zoom;
    img.style.cssText = `left:${(W / 2 + (lay.left - W / 2) * z + pan * W).toFixed(1)}px;top:${(H / 2 + (lay.top - H / 2) * z).toFixed(1)}px;width:${(lay.w * z).toFixed(1)}px;height:${(lay.h * z).toFixed(1)}px`;
    document.body.style.setProperty('--pz', lay.desktop ? Math.max(0.7, Math.min(1.15, lay.u)).toFixed(3) : '1');
    root.style.setProperty('--cvu', Math.max(0.62, Math.min(1.1, lay.desktop ? lay.u : 0.8)).toFixed(3));
    for (const el of pillsEl.children) {
      const seat = +el.dataset.seat, p = pos(seat);
      el.style.left = p.x.toFixed(1) + 'px'; el.style.top = p.y.toFixed(1) + 'px';
    }
  }
  function setCast(list) {
    cast = list.slice(0, SLOTS.length);
    seats = assignSlots(cast);
    pillsEl.innerHTML = cast.map(a => `<div class="cv-tag" data-id="${esc(a.id)}" data-seat="${seats.get(a.id)}" data-st="${status.get(a.id) || 'working'}" style="--ac:${esc(a.color)}"><i></i><span class="nm">${esc(a.name)}</span><span class="zz" aria-hidden="true">z</span></div>`).join('');
    place();
  }
  function setStatus(id, st) {
    status.set(id, st);
    const el = pillsEl.querySelector(`[data-id="${CSS.escape(id)}"]`); if (el) el.dataset.st = st;
  }
  function say(id, text, ms = 3600) {
    const seat = seats.get(id); if (seat == null || !text) return false;
    clearTimeout(timers.get(id));
    let b = pillsEl.querySelector(`.cv-bub[data-for="${CSS.escape(id)}"]`);
    if (!b) { b = document.createElement('div'); b.className = 'cv-bub'; b.dataset.for = id; b.dataset.seat = seat; pillsEl.appendChild(b); }
    b.textContent = text; b.dataset.seat = seat;
    const p = pos(seat); const bw = b.offsetWidth || 160; b.style.left = Math.max(bw / 2 + 6, Math.min(W - bw / 2 - 6, p.x)).toFixed(1) + 'px'; b.style.top = (p.y - 24).toFixed(1) + 'px';
    requestAnimationFrame(() => b.classList.add('on'));
    timers.set(id, setTimeout(() => { b.classList.remove('on'); setTimeout(() => b.remove(), 300); }, ms));
    return true;
  }
  /** a bell icon over an agent's pill (bell rung / PR opened) */
  function ring(id) {
    const el = pillsEl.querySelector(`.cv-tag[data-id="${CSS.escape(id)}"]`); if (!el) return;
    el.classList.remove('ring'); void el.offsetWidth; el.classList.add('ring'); setTimeout(() => el.classList.remove('ring'), 2600);
  }
  function setPan(p) { pan = Math.max(-0.3, Math.min(0.3, p)); setZoom(zoom); }
  function setZoom(z) { zoom = Math.max(1, Math.min(2.2, z)); place(); for (const b of pillsEl.querySelectorAll('.cv-bub')) { const p = pos(+b.dataset.seat); b.style.left = p.x + 'px'; b.style.top = (p.y - 24) + 'px'; } }
  const ro = new ResizeObserver(() => { place(); });
  ro.observe(root);
  return { setCast, setStatus, say, ring, place, setZoom, getZoom: () => zoom, setPan, getPan: () => pan, seatOf: id => seats.get(id), get cast() { return cast; } };
}
