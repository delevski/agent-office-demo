// emblems.js — original, data-driven agent emblems (no third-party marks).
// One source of truth for the DOM (SVG string) and the 3D scene (canvas drawing),
// driven by roster.json: { color, emblem: { mono, icon } }. Unknown agents get a
// fallback monogram + a deterministic icon, so a new reporter has a badge at once.

// 24×24 icon paths. `s` = stroked (round caps), `f` = filled. All drawn for this project.
export const ICONS = {
  tab:      { s: 'M3.5 12h11 M10.5 7.5 15 12l-4.5 4.5 M19.5 6v12' },                     // the Tab key: arrow to a stop
  spark:    { f: 'M13.2 2 5 13.4h5.6L9.4 22l9.6-12.6h-5.8z' },                         // lightning spark (Instinct)
  wing:     { f: 'M3 18c0-7 5-12.5 16.5-14-1.4 1.6-2.3 3-2.8 4.2 1.6-.6 3.3-.8 5-.6-1.4 1.6-2.9 2.7-4.6 3.4 1.4.1 2.8.4 4 1-1.5 1.5-3.2 2.4-5 2.9 1 .3 2 .8 2.7 1.4C14.6 18.3 9 19 3 18z' }, // winged messenger (feathered wing)
  magnet:   { s: 'M6 4v8a6 6 0 0 0 12 0V4 M6 8h3.5 M14.5 8H18' },
  tag:      { s: 'M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8-9 9z M8.5 8.5h.01' },
  chat:     { s: 'M4 5.5h16v10H9l-4.5 4v-4H4z M8 10.5h8' },
  coin:     { s: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z M9.5 9.5c.4-1 1.4-1.5 2.6-1.5 1.5 0 2.4.8 2.4 1.9 0 2.6-5 1.5-5 4.2 0 1.1 1 1.9 2.6 1.9 1.2 0 2.2-.5 2.6-1.5 M12 6.5v1.5 M12 16v1.5' },
  pen:      { s: 'M14.5 4.5l5 5L9 20H4v-5z M12.5 6.5l5 5' },
  megaphone:{ s: 'M3.5 10v4h3l7 4.5v-13L6.5 10z M17 9a4 4 0 0 1 0 6 M6.5 14l1.5 5h2.5l-1-4.2' },
  hex:      { s: 'M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z M12 8.5v7 M8.8 10.2 15.2 13.8' },
  orbit:    { s: 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z M3.5 12c0-2.2 3.8-4 8.5-4s8.5 1.8 8.5 4-3.8 4-8.5 4-8.5-1.8-8.5-4z' },
  leaf:     { s: 'M5 19c0-8 5-13 14-14 0 9-5 14-13 14z M5 19l8-8' },
};
const FALLBACK_ICONS = ['hex', 'orbit', 'leaf', 'spark', 'chat'];

let uid = 0;
function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }

/** Normalized emblem for any agent meta (roster entry or a live reporter we never saw). */
export function emblemOf(meta = {}) {
  const e = meta.emblem || {};
  const name = String(meta.name || meta.id || '?');
  const firstWord = name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ')[0] || '?';
  const mono = String(e.mono || (/^[A-Za-z]/.test(firstWord) ? firstWord[0].toUpperCase() : firstWord[0])).slice(0, 3);
  const icon = ICONS[e.icon] ? e.icon : FALLBACK_ICONS[hash(meta.id || name) % FALLBACK_ICONS.length];
  return { mono, icon, color: meta.color || '#f5b301', id: meta.id || name };
}

/* ---------------- colour helpers ---------------- */
export function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16) || 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
export function shade(hex, amt) { // amt -1..1 (darker .. lighter)
  const [r, g, b] = hexToRgb(hex);
  const f = c => Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt));
  return '#' + [f(r), f(g), f(b)].map(c => c.toString(16).padStart(2, '0')).join('');
}
function lum(hex) {
  const [r, g, b] = hexToRgb(hex).map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Ink colour for text on top of `hex` (dark ink on light brand colours). */
export function inkOn(hex) { return lum(hex) > 0.28 ? '#1a1407' : '#ffffff'; }

/* ---------------- DOM: SVG string ---------------- */
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function emblemSVG(meta, size = 40, { title = true } = {}) {
  const e = emblemOf(meta);
  const id = 'eg' + hash(e.id + e.color).toString(36) + '-' + (++uid); // unique: a gradient referenced from a hidden SVG would not paint
  const ink = inkOn(e.color);
  const ic = ICONS[e.icon];
  const fs = e.mono.length >= 3 ? 15 : e.mono.length === 2 ? 19 : 25;
  const iconSvg = ic.f
    ? `<path d="${ic.f}" fill="${e.color}"/>`
    : `<path d="${ic.s}" fill="none" stroke="${e.color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
  return `<svg class="emblem" width="${size}" height="${size}" viewBox="0 0 48 48" role="img" aria-label="${esc(meta.name || e.id)}">${title ? `<title>${esc(meta.name || e.id)}</title>` : ''}
<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(e.color, 0.28)}"/><stop offset="1" stop-color="${shade(e.color, -0.12)}"/></linearGradient></defs>
<rect x="2" y="2" width="44" height="44" rx="14" fill="url(#${id})"/>
<rect x="3" y="3" width="42" height="42" rx="13" fill="none" stroke="#ffffff" stroke-opacity=".35" stroke-width="1.5"/>
<text x="24" y="${e.mono.length >= 3 ? 30 : 32}" text-anchor="middle" font-family="Heebo,system-ui,sans-serif" font-weight="900" font-size="${fs}" fill="${ink}" letter-spacing="-.5">${esc(e.mono)}</text>
<g transform="translate(28 1) scale(.8)"><circle cx="12" cy="12" r="11" fill="#17130c" stroke="#ffffff" stroke-opacity=".9" stroke-width="1.6"/><g transform="translate(4.2 4.2) scale(.65)">${iconSvg}</g></g>
</svg>`;
}

/* ---------------- canvas: same emblem for 3D textures ---------------- */
function rrect(c, x, y, w, h, r) { c.beginPath(); c.roundRect(x, y, w, h, r); }
export function drawEmblem(c, x, y, size, meta) {
  const e = emblemOf(meta);
  const k = size / 48;
  c.save();
  c.translate(x, y); c.scale(k, k);
  const g = c.createLinearGradient(0, 0, 0, 48);
  g.addColorStop(0, shade(e.color, 0.28)); g.addColorStop(1, shade(e.color, -0.12));
  c.fillStyle = g; rrect(c, 2, 2, 44, 44, 14); c.fill();
  c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 1.5; rrect(c, 3, 3, 42, 42, 13); c.stroke();
  c.fillStyle = inkOn(e.color);
  const fs = e.mono.length >= 3 ? 15 : e.mono.length === 2 ? 19 : 25;
  c.font = `900 ${fs}px Heebo, system-ui, sans-serif`;
  c.textAlign = 'center'; c.textBaseline = 'alphabetic';
  c.fillText(e.mono, 24, e.mono.length >= 3 ? 30 : 32);
  // icon chip (top-left corner of the badge, like the SVG)
  c.translate(28, 1); c.scale(0.8, 0.8);
  c.beginPath(); c.arc(12, 12, 11, 0, Math.PI * 2);
  c.fillStyle = '#17130c'; c.fill();
  c.strokeStyle = 'rgba(255,255,255,.9)'; c.lineWidth = 1.6; c.stroke();
  c.translate(4.2, 4.2); c.scale(0.65, 0.65);
  const ic = ICONS[e.icon];
  if (ic.f) { c.fillStyle = e.color; c.fill(new Path2D(ic.f)); }
  else { c.strokeStyle = e.color; c.lineWidth = 2.6; c.lineCap = 'round'; c.lineJoin = 'round'; c.stroke(new Path2D(ic.s)); }
  c.restore();
}
