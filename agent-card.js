// agent-card.js — the card that opens when you click a person in the room: who they are, what they are doing now and for
// how long, their last five finished tasks, when they were last seen and what is waiting for them on the board.
// Everything here is pure (data in, model / html / numbers out): no DOM, no timers, no fetching, so it costs nothing while
// the card is closed and can be tested in node.  main.js feeds it the data the dashboard already has (the live server
// view from /api/agents, or the demo board) and concept.js uses `actorBox` / `hitTest` on pointer events only.

export const STATUS_LABEL = { working: 'עובד עכשיו', idle: 'פנוי', sleeping: 'במצב שינה', blocked: 'תקוע · ממתין', offline: 'לא מחובר' };
export const RECENT_MAX = 5;
export const OPEN_MAX = 6;
export const MIN_TAP = 44;                     // px: the smallest tap target (mobile guidelines)

/* ---------------- never show a token or a secret ---------------- */
const SECRET = /(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:token|secret|password|passwd|api[_-]?key|authorization)\s*[=:]\s*\S+|[A-Fa-f0-9]{32,})/gi;
/** a one-line, length-capped, secret-free version of any text that comes from an agent */
export function clean(v, max = 120) {
  const s = String(v ?? '').replace(SECRET, '•••').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
/** http(s) links only, without query string or fragment (those are where tokens hide) */
export function safeLink(u) {
  try { const x = new URL(String(u || '')); return /^https?:$/.test(x.protocol) ? x.origin + x.pathname : ''; } catch { return ''; }
}

/* ---------------- time, in Hebrew ---------------- */
const two = n => String(n).padStart(2, '0');
export function durHe(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return 'פחות מדקה';
  if (m < 60) return `${m} דק׳`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return r ? `${h} שע׳ ${r} דק׳` : `${h} שע׳`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'יום' : `${d} ימים`;
}
/** the clock time a thing started: 20:09, or 'אתמול 20:09' */
export function clockHe(ts, now = Date.now()) {
  const d = new Date(ts), hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return new Date(now).toDateString() === d.toDateString() ? hm : whenHe(ts, now);
}
export function whenHe(ts, now = Date.now()) {
  if (!ts) return '';
  const diff = now - ts;
  if (diff < 60_000) return 'עכשיו';
  if (diff < 3600_000) return `לפני ${Math.floor(diff / 60000)} דק׳`;
  const d = new Date(ts), n = new Date(now), hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(n) - day(d)) / 86400_000);
  if (days <= 0) return `היום ${hm}`;
  if (days === 1) return `אתמול ${hm}`;
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

/* ---------------- the model ---------------- */
/**
 * @param in.agent    roster entry { id, name, role, color, live? }
 * @param in.status   'working' | 'idle' | 'blocked' | 'offline'   (what the room already shows for this agent)
 * @param in.sleeping true when the room draws this person asleep (night, seated, not working)
 * @param in.view     live mode: the server view of the agent (GET /api/agents): { current, tasks, lastSeen, hasData }
 * @param in.demo     demo mode: the demo board entry { doing, doingSince, todo[], todoWhen{}, done[{ title, ended }] }
 * @param in.now      ms
 */
export function cardModel({ agent, status = 'idle', sleeping = false, view = null, demo = null, now = Date.now() }) {
  const live = !!agent.live;
  let current = null, recent = [], open = [], lastSeen = null;
  if (live) {
    const v = view && view.hasData ? view : null;
    if (!v) status = 'offline';
    else {
      const cur = v.current;
      if (cur && cur.title && status !== 'offline') current = { title: clean(cur.title), since: cur.since || null, link: safeLink(cur.link), activity: v.activity?.text ? clean(v.activity.text, 90) : '' };
      const tasks = Array.isArray(v.tasks) ? v.tasks : [];
      recent = tasks.filter(t => t && (t.status === 'done' || t.status === 'failed')).map(t => ({ title: clean(t.title || t.id), status: t.status, ts: t.ended || t.since || 0, link: safeLink(t.link) }))
        .sort((a, b) => b.ts - a.ts).slice(0, RECENT_MAX);
      open = tasks.filter(t => t && (t.status === 'queued' || t.status === 'blocked')).map(t => ({ title: clean(t.title || t.id), status: t.status, ts: t.since || 0, when: '' }));
      lastSeen = v.lastSeen || null;
    }
  } else if (demo) {
    if (demo.doing) current = { title: clean(demo.doing), since: demo.doingSince || null, link: '', activity: '' };
    recent = (demo.done || []).filter(d => d.title !== demo.doing).map(d => ({ title: clean(d.title), status: 'done', ts: d.ended || 0, at: d.at || '', link: '' })).sort((a, b) => b.ts - a.ts).slice(0, RECENT_MAX);
    open = (demo.todo || []).map(title => ({ title: clean(title), status: 'queued', ts: 0, when: clean(demo.todoWhen?.[title] || '', 24) }));
    lastSeen = status === 'offline' ? null : now;
  }
  let st = status === 'working' || status === 'blocked' || status === 'idle' || status === 'offline' ? status : 'idle';
  if (st === 'idle' && sleeping) st = 'sleeping';
  const nextUp = open.findIndex(o => !recent.some(r => r.title === o.title));   // (the demo simulation recycles finished sample tasks into the queue: not those)
  if (demo && !live && (st === 'working' || st === 'blocked') && !current && nextUp >= 0) { const t = open.splice(nextUp, 1)[0]; current = { title: t.title, since: null, link: '', activity: '' }; } // the room shows them busy: they have started the next one
  if (st !== 'working' && st !== 'blocked') current = null;      // only someone at work has a current task
  return {
    id: agent.id, name: clean(agent.name || agent.id, 40), role: clean(agent.role || '', 40), color: /^#[0-9a-f]{3,8}$/i.test(agent.color || '') ? agent.color : '#8e8e93',
    live, demo: !live, status: st, statusLabel: STATUS_LABEL[st],
    current: current && { ...current, running: current.since ? durHe(now - current.since) : '', clock: current.since ? clockHe(current.since, now) : '' },
    recent: recent.map(r => ({ ...r, whenLabel: r.at && now - r.ts > 3600_000 ? r.at : whenHe(r.ts, now) })),
    open: open.slice(0, OPEN_MAX), openMore: Math.max(0, open.length - OPEN_MAX),
    lastSeen, lastSeenLabel: lastSeen ? whenHe(lastSeen, now) : (live ? 'עוד לא דיווח' : 'אין נתונים'),
  };
}

/** the card's inner html; `esc` escapes text for html, `emblem` is the agent's emblem svg (already safe) */
export function cardHtml(m, { esc, emblem = '' }) {
  const a = (t, href) => href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(t)}</a>` : esc(t);
  const cur = m.status === 'offline'
    ? `<div class="oc-none">${m.live ? 'לא מחובר כרגע' : 'לא פעיל כרגע'}</div>`
    : m.current
      ? `<div class="oc-cur"><b class="oc-cur-t">${a(m.current.title, m.current.link)}</b>${m.current.activity ? `<div class="oc-act">▸ ${esc(m.current.activity)}</div>` : ''}${m.current.running ? `<div class="oc-meta">בעבודה כבר ${esc(m.current.running)}${m.current.clock ? ` · מאז ${esc(m.current.clock)}` : ''}</div>` : ''}</div>`
      : `<div class="oc-none">${m.status === 'sleeping' ? 'במצב שינה, אין משימה פעילה' : m.status === 'working' || m.status === 'blocked' ? (m.live ? 'לא דווחה משימה ספציפית' : 'בין משימות, הבאה בתור') : 'אין משימה פעילה כרגע'}</div>`;
  const rec = m.recent.length
    ? `<ul class="oc-list">${m.recent.map(r => `<li class="oc-${r.status}"><span class="oc-ic" aria-label="${r.status === 'failed' ? 'נכשל' : 'הושלם'}">${r.status === 'failed' ? '✕' : '✓'}</span><span class="oc-t">${a(r.title, r.link)}</span><span class="oc-w">${esc(r.whenLabel)}</span></li>`).join('')}</ul>`
    : `<div class="oc-none">עוד אין משימות שהסתיימו</div>`;
  const opn = m.open.length
    ? `<ul class="oc-list">${m.open.map(r => `<li class="oc-${r.status}"><span class="oc-ic" aria-hidden="true">${r.status === 'blocked' ? '!' : '○'}</span><span class="oc-t">${esc(r.title)}</span><span class="oc-w">${esc(r.when || (r.status === 'blocked' ? 'תקוע' : 'בתור'))}</span></li>`).join('')}${m.openMore ? `<li class="oc-more">ועוד ${m.openMore}</li>` : ''}</ul>`
    : `<div class="oc-none">אין משימות פתוחות בלוח</div>`;
  return `<button class="oc-x" type="button" aria-label="סגירה"><span aria-hidden="true">✕</span></button>
    <div class="oc-head"><span class="oc-emb" style="--ac:${esc(m.color)}">${emblem}</span>
      <div class="oc-who"><div class="oc-name">${esc(m.name)}</div><div class="oc-role">${esc(m.role)}${m.demo ? ' · דמו' : ''}</div></div></div>
    <div class="oc-st"><i class="oc-dot"></i><span>${esc(m.statusLabel)}</span><span class="oc-seen">נראה לאחרונה: ${esc(m.lastSeenLabel)}</span></div>
    <section class="oc-sec"><h4>עובד עכשיו על</h4>${cur}</section>
    <section class="oc-sec"><h4>משימות אחרונות</h4>${rec}</section>
    <section class="oc-sec"><h4>משימות פתוחות בלוח</h4>${opn}</section>`;
}

/* ---------------- click → character ---------------- */
/**
 * The invisible hit box of one person, in px of the room: it runs from just above the head down to the feet (or, for the 2D
 * avatar, down to the bottom of the avatar) and is never smaller than a finger.
 * head / feet: { x, y } px.  extraBottom: px below the feet (the 2D avatar's radius).
 */
export function actorBox(id, head, feet, { extraBottom = 0, minTap = MIN_TAP } = {}) {
  const h = Math.max(Math.abs(feet.y - head.y), minTap);
  let x0 = head.x - Math.max(minTap, h * 0.6) / 2, x1 = head.x + Math.max(minTap, h * 0.6) / 2;
  let y0 = Math.min(head.y, feet.y) - h * 0.2, y1 = Math.max(head.y, feet.y) + h * 0.12 + extraBottom;
  if (y1 - y0 < minTap) { const c = (y0 + y1) / 2; y0 = c - minTap / 2; y1 = c + minTap / 2; }
  return { id, x0, y0, x1, y1, cx: head.x, cy: (y0 + y1) / 2, z: Math.max(feet.y, head.y) };
}
/** the id of the person under (x, y), or null.  Overlaps go to the nearer person (lower on the picture), then to the closest centre. */
export function hitTest(boxes, x, y) {
  let best = null;
  for (const b of boxes) {
    if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
    if (!best || b.z > best.z + 1 || (Math.abs(b.z - best.z) <= 1 && Math.hypot(x - b.cx, y - b.cy) < Math.hypot(x - best.cx, y - best.cy))) best = b;
  }
  return best ? best.id : null;
}

/* ---------------- where the card goes ---------------- */
const overlap = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
/**
 * desktop: next to the person, wherever on the room covers other people (and the board panel) least, kept inside the room.
 * phones: a bottom sheet.  `avoid` = boxes { x0, y0, x1, y1, w? } in the same px space as `anchor` (w weighs how bad covering one is).
 */
export function placeCard({ anchor, W, H, cw, ch, mobile, avoid = [], gap = 40, pad = 12, padLeft = 88, padTop = 84, padBottom = 100 }) {  // the margins keep clear of the top bar, the zoom buttons and the bottom toolbar
  if (mobile) return { mode: 'sheet' };
  const lo = padTop, hi = Math.max(padTop, H - ch - padBottom);
  const clampL = l => Math.max(padLeft, Math.min(W - cw - pad, l)), clampT = t => Math.max(lo, Math.min(hi, t));
  const lefts = [anchor.x - gap - cw, anchor.x + gap, anchor.x - cw / 2, padLeft, W - cw - pad].map(clampL);
  const tops = [anchor.y - ch * 0.35, anchor.y - ch - 20, anchor.y + 20, lo, hi, (lo + hi) / 2].map(clampT);
  let best = null;
  for (const left of lefts) {
    for (const top of tops) {
      const r = { x0: left, y0: top, x1: left + cw, y1: top + ch };
      const cover = avoid.reduce((n, b) => n + overlap(r, b) * (b.w || 1), 0) / 8;               // covering people / the board costs the most
      const away = Math.hypot(left + cw / 2 - anchor.x, top + ch / 2 - anchor.y);                  // then distance from the person
      const onPerson = anchor.x > left - 14 && anchor.x < left + cw + 14 && anchor.y > top - 14 && anchor.y < top + ch + 14 ? 5000 : 0;   // never on top of the person who was clicked
      const cost = cover + away + onPerson;
      if (!best || cost < best.cost) best = { cost, left, top };
    }
  }
  return { mode: 'float', left: Math.round(best.left), top: Math.round(best.top) };
}
