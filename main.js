// main.js — UI, roster, live ingestion (WS + polling), demo simulation, feed, KPIs, chart,
// Ori's login and the per-agent live panel.
import { createRoomCore } from './room-core.js?v=1';
import { createConcept } from './concept.js?v=5';
import { cardModel, cardHtml, placeCard } from './agent-card.js?v=1';
import { createBell } from './sound.js';
import { notPickedUp, waitingMinutes } from './board-state.js?v=1';
import { emblemSVG } from './emblems.js';
import { agentAlert, alertLabel, durationHe, reviewTrend, severityCounts, ALERT_AFTER_MIN, SEVERITIES, meetingGroups, reliability, RELIABILITY } from './insights.js';
import { applyReport, publicView as viewAt, feedNote, isFeedEvent, emptyAgent } from './office-state.js';

/* ---------------- page modes ---------------- */
// /showcase or ?showcase=1 : public, embeddable, demo-only view (never calls the private API).
const QS = new URLSearchParams(location.search);
const SHOWCASE = QS.has('showcase') || /^\/showcase\/?$/.test(location.pathname);
const CAPTURE = QS.get('capture') === '1';             // deterministic frame stepping (video export)
if (SHOWCASE) {
  document.body.classList.add('showcase');
  if (QS.get('bg') === 'transparent') document.body.classList.add('bg-transparent');
  if (QS.get('bg') === 'light') document.body.classList.add('bg-light');
}

/* ---------------- roster: data-driven, fetched from roster.json ---------------- */
const FALLBACK_ROSTER = { agents: [
  {"id": "hermessi", "name": "hermessi", "role": "סוכן שחרורים", "handle": "hermessi", "color": "#8b7cf6", "skin": "#f2c9a4", "hair": "#5a3d28", "longHair": true, "kinds": [["release.ready", "גרסה מוכנה לשחרור", "#"], ["task.done", "משימה הושלמה", "+1"]], "emblem": {"mono": "h", "icon": "wing"}, "skills": ["ארוז גרסאות", "הערות שחרור", "ניהול גרסאות", "פריסה"], "demoTasks": ["ShortiGo release", "PR #7 נמזג"], "demoBoard": {"doing": {"title": "ShortiGo release", "ago": 12}, "todo": [], "done": [{"title": "PR #7 נמזג", "at": "10:42"}], "rank": 1}, "slot": 3},
  {"id": "claudi", "name": "Claudi", "role": "סוכנת סקירת קוד", "handle": "claudi", "color": "#e07a4f", "skin": "#e8b48c", "hair": "#2c2320", "longHair": true, "kinds": [["review.done", "סקירת קוד הושלמה", "+1"], ["pr.approved", "PR אושר", "#"]], "emblem": {"mono": "C", "icon": "spark"}, "skills": ["סקירת קוד", "בדיקות", "ארכיטקטורה", "תיעוד"], "demoTasks": ["PR #8 review"], "demoBoard": {"doing": {"title": "PR #8 review", "ago": 4}, "todo": [], "done": [], "rank": 0}, "slot": 1},
  {"id": "gepeta", "name": "Gepeta", "role": "סוכנת תוכן", "handle": "gepeta", "color": "#4fb986", "skin": "#f2c9a4", "hair": "#3a2a1c", "longHair": false, "kinds": [["doc.draft", "טיוטה מוכנה", "+1"], ["task.done", "משימה הושלמה", "+1"]], "emblem": {"mono": "G", "icon": "pen"}, "skills": ["הערות שחרור", "מסמכי מוצר", "ניוזלטר", "תרגום"], "demoTasks": ["ShortiGo release notes"], "demoBoard": {"doing": null, "todo": [{"title": "ShortiGo release notes", "when": "מחר"}], "done": [], "rank": 1}, "slot": 2},
  {"id": "grocki", "name": "Grocki", "role": "סוכן QA", "handle": "grocki", "color": "#ef6f9c", "skin": "#d9a077", "hair": "#1f1a16", "longHair": false, "kinds": [["test.passed", "בדיקות עברו", "#"], ["bug.found", "נמצא באג", "#"]], "emblem": {"mono": "Gr", "icon": "magnet"}, "skills": ["בדיקות מובייל", "רגרסיה", "דוחות באגים", "תשלומים"], "demoTasks": ["בדיקת דף תשלום במובייל"], "demoBoard": {"doing": null, "todo": [{"title": "בדיקת דף תשלום במובייל", "when": "היום"}], "done": [], "rank": 0}, "slot": 4},
  {"id": "gemino", "name": "Gemino", "role": "סוכן נתונים", "handle": "gemino", "color": "#4aa3ee", "skin": "#f2c9a4", "hair": "#8a5a2b", "longHair": true, "kinds": [["report.built", "דוח נבנה", "+1"], ["task.done", "משימה הושלמה", "+1"]], "emblem": {"mono": "Gm", "icon": "chat"}, "skills": ["דוחות", "ניתוח נתונים", "קמפיינים", "לוחות מחוונים"], "demoTasks": ["תיקון הפניה אחרי כניסה", "דוח קמפיין שבועי"], "demoBoard": {"doing": {"title": "תיקון הפניה אחרי כניסה", "ago": 25}, "todo": [], "done": [{"title": "דוח קמפיין שבועי", "at": "09:58"}], "rank": 2}, "slot": 0},
  {"id": "deepsi", "name": "Deepsi", "role": "סוכנת מחקר", "handle": "deepsi", "color": "#2cc0c0", "skin": "#c98e63", "hair": "#24201c", "longHair": false, "kinds": [["research.done", "סיכום מחקר מוכן", "+1"], ["doc.updated", "מסמך עודכן", "#"]], "emblem": {"mono": "D", "icon": "coin"}, "skills": ["מחקר מתחרים", "סיכומים", "מדריך API", "מקורות"], "demoTasks": ["עדכון מדריך ה-API", "מחקר מתחרים · סיכום"], "demoBoard": {"doing": null, "todo": [{"title": "עדכון מדריך ה-API", "when": "יום ד׳"}], "done": [{"title": "מחקר מתחרים · סיכום", "at": "09:15"}], "rank": 2}, "slot": 5}
]};

let AGENTS = [];          // demo characters (roster.json "agents")
let LIVE = [];            // real agents (roster.json "live" + anyone who reports)
const liveState = new Map(); // agent id -> server view (GET /api/agents)
const auth = { loggedIn: false, configured: false };
function roster() { return mode === 'live' ? LIVE : AGENTS; }
const STATE_HE = { typing: 'עובד/ת במחשב', walk: 'זז/ה במשרד', idle: 'בהפסקה', celebrate: 'חוגג/ת 🎉', meeting: 'בישיבת בוקר' };
const LIVE_COLORS = ['#f26d6d','#f7b84d','#8fd14f','#4dc9f7','#c986f2','#f279b6','#ffd166','#6ee7b7'];
const LIVE_SKINS = ['#f2c9a4','#e8b48c','#d9a077','#c98e63'];
const LIVE_HAIRS = ['#3a2a1c','#1f1a16','#5a3d28','#24201c','#8a5a2b','#2c2320'];

function rnd(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function $(sel) { return document.querySelector(sel); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function markerVal(m) {
  if (m === '+1') return '+1';
  if (m === '#') return '#' + rnd(40, 999);
  if (m === '₪') return '₪' + (rnd(3, 40) * 100).toLocaleString('he-IL');
  if (m === 'min') return rnd(2, 14) + 'min';
  if (m === 'CTR') return 'CTR ' + rnd(1, 6) + '.' + rnd(0, 9) + '%';
  return m || '';
}

const agentStats = new Map(); // id -> {events, last, state}
function statOf(id) {
  if (!agentStats.has(id)) agentStats.set(id, { events: 0, last: '—', state: 'typing' });
  return agentStats.get(id);
}

/* ---------------- boot with progress + retry ---------------- */
const bootFill = $('#boot-fill'), bootStep = $('#boot-step');
function bootSet(pct, text) { bootFill.style.width = pct + '%'; bootStep.textContent = text; }

let office = null;
async function loadRoster() {
  try {
    const r = await fetch('./roster.json?v=23');
    if (!r.ok) throw new Error('roster ' + r.status);
    const d = await r.json();
    if (!Array.isArray(d.agents) || !d.agents.length) throw new Error('empty roster');
    return d;
  } catch (e) {
    console.warn('roster fallback:', e.message);
    return FALLBACK_ROSTER;
  }
}


/* ---------------- concept view: the approved room picture + live pills, bubbles and the right-hand panel ---------------- */
let cv = null, chatLog = [];
const isDesktop = () => matchMedia('(min-width:901px)').matches;
function castNow() { return mode === 'live' ? LIVE : AGENTS; }
let cvMode = '';
function demoChatSeed() {
  return [['gemino', 'נתוני ShortiGo מוכנים, העליתי את הדוח לתיקייה המשותפת'], ['hermessi', 'מעולה, מתחיל לארוז את ה-release'], ['deepsi', 'סיכום המתחרים עודכן, יש שני דברים לשים לב אליהם']]
    .map(([id, text]) => ({ a: AGENTS.find(x => x.id === id), text })).filter(l => l.a);
}
function syncCast() {
  if (!cv) return;
  if (cvMode !== mode) { if (cvMode) chatLog = mode === 'demo' ? demoChatSeed() : []; cvMode = mode; } // live mode never shows the demo conversation
  { const card = document.querySelector('.scene-card'); const n = parseFloat(card && card.style.getPropertyValue('--night')); if (!Number.isNaN(n)) cv.setNight(n); }
  cv.setCast(castNow());
  if (acId && !castNow().some(x => x.id === acId)) closeAgentCard(); // the mode changed: that person is not in this room
  castNow().forEach(a => cv.setStatus(a.id, mode === 'live' ? sceneStatus(liveState.get(a.id)) : (agentStats.get(a.id)?.state === 'idle' ? 'idle' : 'working')));
  renderCPanel();
}
function cpOpen(open) {
  document.body.classList.toggle('cp-closed', !open);
  $('#btn-board')?.classList.toggle('on', open);
  LS.set('cpanel', open ? '1' : '0');
}
function relMin(ts) {
  if (!ts) return 'עכשיו';
  const mn = Math.max(0, Math.round((nowRef() - ts) / 60000));
  if (mn < 1) return 'עכשיו';
  return mn < 60 ? `לפני ${mn} דק׳` : when(ts);
}
function chip(a) { return `<span class="pchip"><i style="background:${esc(a.color)}"></i>${esc(a.name)}</span>`; }
// Queued board task nobody has claimed for 10+ minutes: warning chip + owner-only "ping again" (also in the board overlay).
function isUnclaimed(b) { return !!b && b.status === 'queued' && (b.unclaimed || notPickedUp(b)); }
function cpWaitHtml(c) {
  const b = c.board; if (!isUnclaimed(b)) return '';
  return `<div class="kwarn" role="alert"><span>${ic('triangle-alert', 'inline')} לא נלקחה ${waitingMinutes(b)} דק׳</span>${auth.loggedIn && b.delivery !== 'error' ? `<button class="kping board-ping" type="button" data-task="${esc(b.id)}">פינג שוב</button>` : ''}</div>`;
}
function renderCPanel() {
  const root = $('#cpanel'); if (!root || !cv) return;
  const bd = boardData();
  const names = { todo: 'לביצוע', doing: 'בעבודה', done: 'הושלם' };
  const total = bd.columns.todo.length + bd.columns.doing.length + bd.columns.done.length;
  $('#cp-sub').textContent = `${castNow().length} סוכנים · ${total} משימות`;
  $('#cp-cols').innerHTML = ['todo', 'doing', 'done'].map(k => {
    const list = bd.columns[k].slice(0, k === 'done' ? 4 : 5);
    const label = c => k === 'doing' ? relMin(c.since || c.ts) : (c.when || (k === 'done' ? when(c.ts) : ''));
    return `<div class="kcol k-${k}"><div class="khead"><span class="kdot"></span>${names[k]}<span class="kcount">${bd.columns[k].length}</span></div>`
      + (list.length ? list.map(c => `<div class="kcard"><div class="kt">${safeUrl(c.link) ? `<a href="${safeUrl(c.link)}" target="_blank" rel="noopener">${esc(c.title)}</a>` : esc(c.title)}</div><div class="km">${chip(c.agent)}<span class="when">${esc(label(c))}</span></div>${k === 'todo' ? cpWaitHtml(c) : ''}</div>`).join('')
        : `<div class="kempty">${esc(bd.empty?.[k] || '—')}</div>`) + '</div>';
  }).join('');
  // last code review
  let rv = '';
  if (mode === 'live') {
    const r = reviews[reviews.length - 1];
    if (r) {
      const who = agentMeta(r.reviewer_agent), [vt] = VERDICT_HE[r.verdict] || [''];
      const n = (r.findings || []).length;
      rv = `${chip(who)} סקר/ה את <b>PR #${esc(r.pr)}</b> · ${n} הערות<span class="badge-ok${r.verdict === 'approved' ? '' : ' chg'}">${ic(r.verdict === 'approved' ? 'circle-check' : 'refresh-cw', 'inline')}${esc(vt)}</span>`;
    } else rv = '<span class="muted">עוד אין ביקורות קוד</span>';
  } else {
    const a = AGENTS.find(x => x.id === 'claudi') || AGENTS[0];
    if (a) rv = `${chip(a)} סקרה את <b>PR #8</b> · 2 הערות, מאושר בכפוף לתיקון<span class="badge-ok">${ic('circle-check', 'inline')}אושר</span>`;
  }
  $('#cp-review').innerHTML = rv;
  const lines = chatLog.slice(-3);
  $('#cp-chat').innerHTML = lines.length ? lines.map(l => `<div class="cm">${chip(l.a)}<span class="cb">${esc(l.text)}</span></div>`).join('') : '<div class="muted">כשסוכנים ידברו, השיחה תופיע כאן</div>';
}

/* ---------------- agent card: click / tap a person in the room ----------------
   Built from the data the dashboard already holds (liveState from /api/agents, or the demo board); nothing is fetched here,
   nothing runs while it is closed, and while it is open it re-renders only when the data changes (and every 15 s for the clock). */
let acEl = null, acId = null, acTimer = 0, acHtml = '', acHide = 0;
function agentCardModel(a) {
  const status = mode === 'live' ? sceneStatus(liveState.get(a.id)) : (agentStats.get(a.id)?.state === 'idle' ? 'idle' : 'working');
  return cardModel({ agent: a, status, sleeping: cv.isSleeping(a.id), view: liveState.get(a.id) || null, demo: demoBoard.get(a.id) || null, now: nowRef() });
}
function fillAgentCard(a) {
  const m = agentCardModel(a), html = cardHtml(m, { esc, emblem: emblemSVG(a, 44, { title: false }) });
  acEl.dataset.st = m.status; acEl.setAttribute('aria-label', `${m.name} · ${m.statusLabel}`);
  if (html !== acHtml) { acHtml = html; acEl.innerHTML = html; }
}
function onAcDown(e) { // a tap outside the card closes it (a tap on a person switches the card instead)
  if (!acEl || acEl.contains(e.target) || e.target.closest?.('.cv-tag')) return;
  if (e.target.closest?.('#cv') && cv.pickAt(e.clientX, e.clientY)) return;
  closeAgentCard();
}
function onAcKey(e) { if (e.key === 'Escape') closeAgentCard(); }
function openAgentCard(id, pt) {
  const a = castNow().find(x => x.id === id); if (!a) return;
  if (!acEl) {
    acEl = document.createElement('aside'); acEl.id = 'agent-card'; acEl.className = 'oc-card'; acEl.hidden = true; acEl.setAttribute('role', 'dialog');
    acEl.addEventListener('click', e => { if (e.target.closest('.oc-x')) closeAgentCard(); });
    (document.querySelector('.scene-card') || document.body).appendChild(acEl);
  }
  clearTimeout(acHide);
  const first = acId === null;
  acId = id; acHtml = ''; fillAgentCard(a);
  acEl.hidden = false;
  const host = acEl.parentElement.getBoundingClientRect(), mobile = !isDesktop();
  const rr = $('#cv').getBoundingClientRect(), ox = rr.left - host.left, oy = rr.top - host.top;   // the room's corner inside the card's container
  const avoid = mobile ? [] : cv.boxes().map(b => ({ x0: b.x0 + ox, x1: b.x1 + ox, y0: b.y0 + oy, y1: b.y1 + oy, w: b.id === id ? 8 : 1 }));
  const cp = document.body.classList.contains('cp-closed') ? null : $('#cpanel')?.getBoundingClientRect();   // the open board panel counts as something not to cover
  if (cp && !mobile) avoid.push({ x0: cp.left - host.left, y0: cp.top - host.top, x1: cp.right - host.left, y1: cp.bottom - host.top, w: 0.6 });
  const pl = placeCard({ anchor: pt ? { x: pt.x - host.left, y: pt.y - host.top } : { x: host.width / 2, y: host.height / 2 }, W: host.width, H: host.height, cw: acEl.offsetWidth, ch: acEl.offsetHeight, mobile, avoid });
  acEl.style.left = pl.mode === 'float' ? pl.left + 'px' : ''; acEl.style.top = pl.mode === 'float' ? pl.top + 'px' : '';
  requestAnimationFrame(() => acEl && acEl.classList.add('on'));
  if (first) {
    document.addEventListener('pointerdown', onAcDown, true); document.addEventListener('keydown', onAcKey);
    acTimer = setInterval(() => { const b = acId && castNow().find(x => x.id === acId); if (b) fillAgentCard(b); }, 15000);
    acEl.querySelector('.oc-x')?.focus({ preventScroll: true });
  }
}
function closeAgentCard() {
  if (!acEl || acId === null) return;
  acId = null; clearInterval(acTimer);
  document.removeEventListener('pointerdown', onAcDown, true); document.removeEventListener('keydown', onAcKey);
  acEl.classList.remove('on');
  acHide = setTimeout(() => { if (acId === null) acEl.hidden = true; }, 240);
}
function refreshAgentCard(id) { if (acId && (!id || id === acId)) { const a = castNow().find(x => x.id === acId); if (a) fillAgentCard(a); } }
function initConcept() {
  cv = window.__cv = createConcept($('#cv'), { esc,
    onPick: (id, pt) => { if (id) openAgentCard(id, pt); else closeAgentCard(); },
    avatar: a => emblemSVG(a, 40, { title: false }),
    onStrike: strength => { bellSound.ring(strength, strength < 0.9 ? -2 : 0); window.__bellStrikes.push({ clock: +(performance.now() / 1000).toFixed(2), strength }); },
    onLine: (id, text) => {
      const a = castNow().find(x => x.id === id); if (!a) return;
      chatLog.push({ a, text }); if (chatLog.length > 12) chatLog.shift(); renderCPanel();
    } });
  cpOpen(isDesktop() && LS.get('cpanel', '1') !== '0');
  drawerOpen = false; applyDrawer(false);
  syncCast();
  // the first screen is a believable moment in the day (demo only)
  if (mode === 'demo' && !QS.get('quiet')) {
    const seed = [['gemino', 'PR #8 מוכן לסקירה, מי פנוי?', 600], ['claudi', 'אני על זה, שתי דקות', 1700]];
    seed.forEach(([id, text, at]) => setTimeout(() => { if (mode === 'demo') cv.say(id, text, 14000); }, at));
    chatLog = demoChatSeed();
    renderCPanel();
  }
  setInterval(renderCPanel, 30000);
  // controls
  $('#cp-close').addEventListener('click', () => cpOpen(false));
  $('#cp-add').addEventListener('click', () => { if (mode === 'live') $('#btn-assign')?.click(); else { openAssignDemo(); } });
  $('#btn-agents').addEventListener('click', () => { drawerOpen = !drawerOpen; LS.set('drawer', drawerOpen ? '1' : '0'); applyDrawer(); });
  // zoom / reset act on the room picture
  $('#btn-zoomin').addEventListener('click', () => cv.setZoom(cv.getZoom() * 1.25));
  $('#btn-zoomout').addEventListener('click', () => cv.setZoom(cv.getZoom() / 1.25));
  $('#btn-resetcam').addEventListener('click', () => { cv.setPan(0); cv.setZoom(1); });
  $('#btn-board').addEventListener('click', e => {
    if (!isDesktop()) return;
    e.stopImmediatePropagation(); e.preventDefault();
    cpOpen(document.body.classList.contains('cp-closed'));
  }, true);
  const demoGate = id => $(id)?.addEventListener('click', e => {
    if (mode === 'live') return;
    e.stopImmediatePropagation(); e.preventDefault();
    toast('זמין במצב חי אחרי כניסה');
  }, true);
  demoGate('#btn-replay');
}
function openAssignDemo() { toast('משימות חדשות נשלחות במצב חי, אחרי כניסה'); }

async function boot() {
  $('#boot-error').classList.add('hidden');
  try {
    bootSet(35, 'קורא סגל סוכנים…');
    const doc = await loadRoster();
    AGENTS = doc.agents;
    bootSet(55, 'בונה את המשרד…');
    initConcept();
    office = createRoomCore(cv, {
      onFrame: (dt, t) => { simFrame(dt, t); lifeFrame(dt); },
      onTimeOfDay: onTimeOfDay,
    }, { time: QS.get('time') || '' });
    window.__office = office;
    applyDrawer(false);
    if (!SHOWCASE) (doc.live || []).forEach(meta => addLiveCharacter({ ...meta, live: true }));
    initDemoBoard();
    syncCast();
    bootSet(85, 'בודק כניסה…');
    if (!SHOWCASE) await checkAuth();
    bootSet(100, 'מוכן!');
    setTimeout(() => $('#boot').classList.add('hidden'), SHOWCASE ? 0 : 250);
    if (auth.loggedIn) enterLiveMode({ quiet: true });
    else startSim();
    refreshWorld(true);
  } catch (e) {
    console.error(e);
    bootStep.textContent = 'שגיאה בטעינה';
    $('#boot-error').classList.remove('hidden');
  }
}
$('#boot-retry').addEventListener('click', boot);

/* ---------------- busy wrapper + toasts ---------------- */
/** Lucide icon from the inline sprite in index.html (thin outline, currentColor). */
const ic = (name, cls = '') => `<svg class="ico${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
function toast(msg, { err = false, retry = null, icon = '' } = {}) {
  if (SHOWCASE) return;
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  if (icon || err) el.insertAdjacentHTML('beforeend', ic(icon || 'triangle-alert', 'toast-ico'));
  const span = document.createElement('span'); span.textContent = msg;
  el.appendChild(span);
  if (retry) {
    const b = document.createElement('button'); b.className = 'btn'; b.type = 'button'; b.textContent = 'נסה שוב';
    b.addEventListener('click', () => { el.remove(); retry(); });
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), retry ? 9000 : 3500);
}
function withBusy(btn, labelWhileBusy, fn) {
  if (btn.disabled) return; // double-click guard
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span> ${labelWhileBusy}`;
  Promise.resolve()
    .then(fn)
    .then(newHtml => { btn.disabled = false; btn.innerHTML = typeof newHtml === 'string' ? newHtml : orig; })
    .catch(e => {
      btn.disabled = false; btn.innerHTML = orig;
      console.error(e);
      toast('הפעולה נכשלה — אפשר לנסות שוב', { err: true, retry: () => withBusy(btn, labelWhileBusy, fn) });
    });
}

/* ---------------- clock ---------------- */
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('he-IL', { hour12: false }); }, 1000);

/* ---------------- mode: demo (simulation) vs live (real events) ---------------- */
let mode = 'demo';
function setPill() {
  const pill = $('#live-pill');
  const label = pill.querySelector('.pill-label');
  pill.classList.toggle('paused', mode === 'demo' && paused);
  pill.classList.toggle('live', mode === 'live');
  label.textContent = mode === 'live' ? 'חי · אירועים אמיתיים' : (paused ? 'דמו · מושהה' : 'דמו · סימולציה');
}
// Live mode = real agents only, and only after Ori logs in. Demo mode = the built-in simulation.
function showCast() {
  document.body.classList.toggle('is-live', mode === 'live');
  $('#badge-mode').textContent = mode === 'live' ? 'חי' : 'דמו';
  syncCast();
  $('#chart-sub').textContent = '30 הדקות האחרונות · ' + (mode === 'live' ? 'חי' : 'דמו');
  $('#log-sub').textContent = mode === 'live' ? 'אירועים אמיתיים שהסוכנים מדווחים' : 'טבלת דמו · כל שורה מזיזה דמות';
  $('#foot-demo').classList.toggle('hidden', mode === 'live');
  $('#foot-live').classList.toggle('hidden', mode !== 'live');
  refreshAlerts();
}
function resetBoard() {
  selectedId = null;
  office.unfocus();
  $('#sheet').classList.add('hidden');
  $('#log').innerHTML = '';
  chartData.fill(0); drawChart();
  for (const k of Object.keys(kpis)) kpis[k].v = 0;
  renderKpis();
  renderPanelDefault();
  updateWallScreen();
  renderChanges();
}
function enterLiveMode({ quiet = false } = {}) {
  if (!auth.loggedIn) { openLogin(); return; }
  if (mode === 'live') return;
  mode = 'live';
  clearTimeout(simTimer);
  showCast();
  resetBoard();
  setPill();
  lastId = 0;
  loadAgents().then(() => pollEvents(true));
  loadReviews(); loadChanges();
  connectLive();
  refreshWorld(true);
  if (!quiet) toast('מצב חי — הסוכנים האמיתיים שלך', { icon: 'zap' });
}
function enterDemoMode() {
  mode = 'demo';
  paused = false;
  showCast();
  resetBoard();
  scheduleNext();
  setPill();
  refreshWorld(true);
  toast('חזרנו למצב דמו (סימולציה)');
}
$('#live-pill').addEventListener('click', () => {
  if (mode === 'live') enterDemoMode();
  else enterLiveMode();
});

/* ---------------- KPIs ---------------- */
const kpis = {
  leads:   { label: 'משימות שהושלמו', v: 0, money: false },
  quotes:  { label: 'סקירות ובדיקות', v: 0, money: false },
  calls:   { label: 'שחרורים ופריסות', v: 0, money: false },
  revenue: { label: 'באגים שנמצאו', v: 0, money: false },
};
function liveKpis() {
  const views = LIVE.map(a => liveState.get(a.id)).filter(Boolean);
  const sum = f => views.reduce((s, v) => s + (Number(v.usageToday?.[f]) || 0), 0);
  const reported = f => views.some(v => v.usageToday && v.usageToday[f] !== undefined);
  return [
    ['online', 'סוכנים מחוברים', `${views.filter(v => v.status !== 'offline').length}/${LIVE.length}`],
    ['tasks', 'משימות היום', reported('tasks') ? fmtNum(sum('tasks')) : '—'],
    ['messages', 'הודעות היום', reported('messages') ? fmtNum(sum('messages')) : '—'],
    ['cost', 'עלות היום', reported('cost') ? fmtCost(sum('cost')) : '—'],
  ];
}
function renderKpis() {
  if (mode === 'live') {
    $('#kpis').innerHTML = liveKpis().map(([k, label, v]) => `
    <div class="kpi" id="kpi-${k}">
      <div class="k-label">${label}</div>
      <div class="k-value">${esc(v)}</div>
    </div>`).join('');
    return;
  }
  $('#kpis').innerHTML = Object.entries(kpis).map(([k, x]) => `
    <div class="kpi" id="kpi-${k}">
      <span class="k-num-outline">${String(Math.min(x.v, 99)).padStart(2, '0')}</span>
      <div class="k-label">${x.label}</div>
      <div class="k-value">${x.money ? '₪' + x.v.toLocaleString('he-IL') : x.v}</div>
    </div>`).join('');
}
function bumpKpi(k, amount) {
  kpis[k].v += amount; renderKpis();
  const el = $('#kpi-' + k); if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
}
function bumpKpisForKind(kind, val) {
  if (/^(task|doc|report|research|lead)/.test(kind)) bumpKpi('leads', 1);
  else if (/^(review|pr|test|quote|deal)/.test(kind)) bumpKpi('quotes', 1);
  else if (/^(release|deploy|call|ticket|support)/.test(kind)) bumpKpi('calls', 1);
  else if (/^(bug|payment|invoice|charge)/.test(kind)) bumpKpi('revenue', 1);
}
renderKpis();

/* ---------------- event log ---------------- */
const feedCount = { n: 0 };
function logLine(agent, kind, val, he, ts) {
  const log = $('#log');
  const time = new Date(ts || Date.now()).toLocaleTimeString('he-IL', { hour12: false });
  const div = document.createElement('div');
  div.className = 'log-line fresh';
  div.innerHTML = `<span class="log-time">[${time}]</span><span class="log-name" style="color:${agent.color}">${esc(agent.handle)}:</span> <span class="log-kind">${esc(kind)}</span> <span class="log-val">${esc(val)}</span> <span class="log-he">${esc(he)}</span>`;
  log.prepend(div);
  setTimeout(() => div.classList.remove('fresh'), 1600);
  while (log.children.length > 60) log.lastChild.remove();
  feedCount.n++; feedTotal.n++; renderStrip();
  const pill = $('#feed-pill');
  if (pill && !$('#view-feed').classList.contains('active') && window.innerWidth <= 900) pill.textContent = feedCount.n;
}

/* ---------------- agent panel ---------------- */
let selectedId = null;
function findAgent(idOrHandle) {
  return roster().find(x => x.id === idOrHandle || x.handle === idOrHandle);
}
function panelHtml(a) {
  const st = statOf(a.id);
  const tag = a.live ? 'חי' : 'דמו';
  return `
    <div class="ap-head">
      <span class="ap-emblem">${emblemSVG(a, 46)}</span>
      <div><div class="ap-name">${a.name}</div><div class="ap-role">${a.role} · ${tag}</div></div>
    </div>
    <div class="ap-status"><span class="dot" style="background:${a.color}"></span><span>${STATE_HE[st.state] || st.state}</span></div>
    <div class="ap-row"><span>פעולה אחרונה</span><span class="muted">${st.last}</span></div>
    <div class="ap-row"><span>אירועים היום</span><span class="mono">${st.events}</span></div>
    <div class="ap-actions"><button class="btn btn-gold" id="ap-focus" type="button">${ic('crosshair')}<span class="lbl">מיקוד במשרד</span></button></div>`;
}
function renderPanel(a) {
  const isMobile = window.innerWidth <= 900;
  const target = isMobile ? $('#sheet-body') : $('#agent-panel');
  target.innerHTML = a.live ? livePanelHtml(a) : panelHtml(a);
  if (isMobile) $('#sheet').classList.remove('hidden');
  target.querySelector('#ap-back')?.addEventListener('click', () => {
    selectedId = null; office.unfocus();
    if (isMobile) $('#sheet').classList.add('hidden');
    renderPanelDefault();
  });
  target.querySelector('#ap-reviews')?.addEventListener('click', () => openReviews(a.id));
  target.querySelector('#ap-focus').addEventListener('click', e => {
    withBusy(e.currentTarget, 'ממקד…', async () => {
      await delay(250);
      office.focus(a.id);
      if (isMobile) { $('#sheet').classList.add('hidden'); switchView('view-scene'); }
    });
  });
}
function selectAgent(id) {
  selectedId = id;
  const a = findAgent(id);
  if (!a) return;
  office.focus(id);
  renderPanel(a);
}
$('#sheet-close').addEventListener('click', () => $('#sheet').classList.add('hidden'));

function renderPanelDefault() {
  const el = $('#agent-panel');
  if (!el) return;
  el.innerHTML = `
    <div class="card-head" style="padding:0 0 8px"><h3>הסוכנים</h3><span class="muted">${mode === 'live' ? liveCountLabel() : AGENTS.length + ' פעילים'}</span></div>
    ${mode === 'live' ? alertBannerHtml() : ''}
    <div class="ag-list">${roster().map(a => {
      if (a.live) return liveListItem(a);
      const st = statOf(a.id);
      return `<div class="ag-item" data-id="${a.id}">
        <span class="ap-emblem sm">${emblemSVG(a, 36)}</span>
        <div class="grow"><div style="font-weight:800;font-size:.88rem">${a.name} · <span class="muted">${a.role}${a.live ? ' ' + ic('zap', 'inline') : ''}</span></div>
        <div class="ag-last">${st.last}</div></div>
        <span class="mono muted">${st.events}</span>
      </div>`;
    }).join('')}</div>`;
  document.querySelectorAll('.ag-item, .al-row').forEach(el => {
    el.addEventListener('click', () => selectAgent(el.dataset.id));
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectAgent(el.dataset.id); } });
  });
}
function refreshAgentViews(a) {
  if (selectedId === a.id && window.innerWidth > 900) renderPanel(a);
  if (selectedId === a.id && window.innerWidth <= 900 && !$('#sheet').classList.contains('hidden')) renderPanel(a);
  if (!selectedId) renderPanelDefault();
}
function updateWallScreen() { /* the wall screen was a prop of the old 3D office; the numbers live in the panel now */ }

/* ---------------- chart ---------------- */
const chartData = Array.from({ length: 30 }, () => rnd(0, 5)); // fictional demo history
function drawChart() {
  const cv = $('#chart');
  if (!cv || !cv.clientWidth) return;
  const dpr = Math.min(window.devicePixelRatio, 2);
  const W = cv.clientWidth * dpr, H = 90 * dpr;
  if (cv.width !== W) { cv.width = W; cv.height = H; }
  const c = cv.getContext('2d');
  c.clearRect(0, 0, W, H);
  const max = Math.max(4, ...chartData);
  c.strokeStyle = '#007aff'; c.lineWidth = 2 * dpr; c.beginPath();
  chartData.forEach((v, i) => {
    const x = W - (i + 0.5) / chartData.length * W;
    const y = H - 6 * dpr - (v / max) * (H - 16 * dpr);
    i ? c.lineTo(x, y) : c.moveTo(x, y);
  });
  c.stroke();
  c.fillStyle = '#007aff33';
  chartData.forEach((v, i) => {
    const x = W - (i + 0.5) / chartData.length * W;
    const y = H - 6 * dpr - (v / max) * (H - 16 * dpr);
    c.beginPath(); c.arc(x, y, 2.5 * dpr, 0, 7); c.fill();
  });
}
window.addEventListener('resize', drawChart);
setInterval(() => { chartData.unshift(0); chartData.pop(); drawChart(); }, 60_000);
drawChart();

/* ---------------- event application (shared by demo + live) ---------------- */
function applyEventToOffice(a, kind, val, he) {
  logLine(a, kind, val, he);
  chartData[0]++;
  const st = statOf(a.id);
  st.events++; st.last = he || kind;
  if (mode === 'demo') bumpKpisForKind(kind, val);
  const rings = ringWorthy(kind, he);
  if (rings) ringFor(a, rings, he);
  else if (/deal|payment|won|closed|task\.done|published/.test(kind) && Math.random() < 0.9) office.celebrate(a.id);
  else if (mode === 'demo' && Math.random() < 0.12) {
    if (office.coffeeBreak(a.id, 3 + Math.random() * 3)) st.state = 'walk';
  } else if (mode === 'demo') office.setState(a.id, 'typing');
  if (mode === 'demo') demoTaskStep(a, kind);
  refreshAgentViews(a);
  updateWallScreen();
  refreshWorld();
}

/* ---------------- live channel: WebSocket + polling fallback (Ori only) ---------------- */
let lastId = 0, ws = null;
function connectLive() {
  if (!auth.loggedIn || ws) return;
  let sock;
  try {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    sock = new WebSocket(`${proto}://${location.host}/api/ws`);
  } catch { return; } // polling covers us
  ws = sock;
  sock.onmessage = e => {
    try {
      const m = JSON.parse(e.data);
      if (m.type === 'event' && m.event) onLiveEvent(m.event);
      if (m.type === 'agent' && m.agent) onAgentUpdate(m.agent);
      if (m.type === 'review' && m.review) onReview(m.review);
      if (m.type === 'change' && m.change) onChange(m.change);
    } catch {}
  };
  sock.onclose = () => { if (ws === sock) ws = null; if (auth.loggedIn) setTimeout(connectLive, 5000); };
  sock.onerror = () => { try { sock.close(); } catch {} };
}
async function apiGet(path) {
  const r = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  if (r.status === 401) { onLoggedOut(true); return null; }
  if (!r.ok) throw new Error(path + ' ' + r.status);
  return r.json();
}
async function pollEvents(first = false) {
  if (!auth.loggedIn || mode !== 'live' || replay.active) return;
  try {
    const d = await apiGet('./api/events?since=' + lastId);
    if (!d) return;
    let evs = d.events || [];
    if (first) { // catch-up: show the recent history in the log without replaying animations
      evs.slice(-15).forEach(ev => { const a = liveAgentFor(ev.agent); logLine(a, ev.kind || 'event', ev.value || '', ev.note || ev.kind, ev.ts); statOf(a.id).last = ev.note || ev.kind; });
      evs = [];
      lastId = Math.max(lastId, d.lastId || 0);
    }
    evs.forEach(onLiveEvent);
    if (typeof d.lastId === 'number') lastId = Math.max(lastId, d.lastId);
  } catch {}
}
async function loadAgents() {
  if (!auth.loggedIn || replay.active) return;
  try {
    const d = await apiGet('./api/agents');
    if (!d) return;
    (d.agents || []).forEach(v => onAgentUpdate(v, { quiet: true }));
    renderKpis();
    if (selectedId) { const a = findAgent(selectedId); if (a) renderPanel(a); } else renderPanelDefault();
  } catch (e) {
    console.warn(e);
    toast('לא הצלחנו לטעון את נתוני הסוכנים', { err: true, retry: loadAgents });
  }
}
setInterval(() => pollEvents(), 7000);   // catch-up; no-op when WS delivers first
setInterval(() => loadAgents(), 30_000); // refreshes "offline" (10 min without a report)

function onLiveEvent(ev) {
  if (typeof ev.id === 'number') { if (ev.id <= lastId) return; lastId = ev.id; }
  if (mode !== 'live' || replay.active) return;
  const a = liveAgentFor(ev.agent);
  applyEventToOffice(a, ev.kind || 'event', ev.value || '', ev.note || ev.kind);
  // v6: a real conversation (e.g. a Slack thread) plays out in the room
  if (ev.kind === 'chat.exchange' && ev.chat) office.converse(ev.chat);
}

const SCENE_STATE = { working: 'typing', idle: 'idle', blocked: 'idle', offline: 'idle' };
function sceneStatus(view) { return !view || !view.hasData ? 'offline' : (['working', 'idle', 'blocked', 'offline'].includes(view.status) ? view.status : 'idle'); }
function onAgentUpdate(view, { quiet = false, replaying = false } = {}) {
  if (!view || !view.id) return;
  if (replay.active && !replaying) return; // the replay owns the room; live state is reloaded on exit
  const a = liveAgentFor(view.id, view.name);
  liveState.set(a.id, view);
  const st = statOf(a.id);
  st.state = SCENE_STATE[view.status] || 'typing';
  st.events = Math.max(st.events, view.events || 0);
  if (view.current?.title) st.last = view.current.title;
  office.setStatus(a.id, sceneStatus(view));
  applyAlert(a);
  scheduleMeetings();
  refreshWorld();
  refreshAgentCard(a.id);
  if (quiet || mode !== 'live') return;
  renderKpis();
  refreshAgentViews(a);
  updateWallScreen();
}

function liveAgentFor(id, name) {
  id = String(id || 'unknown').toLowerCase();
  return LIVE.find(x => x.id === id || x.handle === id) || createLiveAgent(id, name);
}
function addLiveCharacter(meta) {
  meta.seatIndex = LIVE.length < 6 ? LIVE.length : undefined; // sit at a hidden demo desk
  LIVE.push(meta);
  office.setStatus(meta.id, sceneStatus(liveState.get(meta.id)));
  statOf(meta.id);
  syncCast();
  return meta;
}
function createLiveAgent(handle, name) {
  let h = 0;
  for (const c of String(handle)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const meta = addLiveCharacter({
    id: String(handle),
    name: String(name || handle),
    role: 'סוכן',
    handle: String(handle),
    color: LIVE_COLORS[h % LIVE_COLORS.length],
    skin: LIVE_SKINS[h % LIVE_SKINS.length],
    hair: LIVE_HAIRS[h % LIVE_HAIRS.length],
    longHair: h % 2 === 0,
    live: true,
    kinds: [],
  });
  if (mode === 'live') { renderPanelDefault(); toast(`סוכן חדש עלה למשרד: ${meta.name}`, { icon: 'zap' }); }
  return meta;
}

/* ---------------- live agent panel ---------------- */
const STATUS_HE = { working: 'עובד עכשיו', idle: 'פנוי', blocked: 'תקוע · ממתין', offline: 'לא מחובר' };
const TASK_ICON = { running: ic('loader-circle', 't-run'), done: ic('circle-check', 't-ok'), failed: ic('circle-x', 't-bad'), blocked: ic('octagon-alert', 't-warn'), queued: ic('inbox', 't-q'), handed: ic('corner-up-right', 't-q') };
const TASK_HE = { running: 'בעבודה', done: 'הושלם', failed: 'נכשל', blocked: 'תקוע', queued: 'בתור', handed: 'הועבר' };
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function safeUrl(u) { return /^https?:\/\//i.test(String(u || '')) ? esc(u) : ''; }
function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString('he-IL');
}
function fmtCost(n) { n = Number(n) || 0; return '$' + (n >= 100 ? n.toFixed(0) : n.toFixed(2)); }
function nowRef() { return replay.active ? replay.t : Date.now(); }
function hhmm(ts) { return new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false }); }
function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, nowRef() - ts) / 1000;
  if (s < 60) return 'עכשיו';
  if (s < 3600) return `לפני ${Math.round(s / 60)} דק׳`;
  if (s < 86400) return `לפני ${Math.round(s / 3600)} שע׳`;
  return new Date(ts).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
}
function when(ts) {
  if (!ts) return '';
  return nowRef() - ts < 86400_000 ? hhmm(ts) : new Date(ts).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
}
function statusOf(v) { return !v || !v.hasData ? 'nodata' : v.status; }
function liveCountLabel() {
  const on = LIVE.filter(a => { const v = liveState.get(a.id); return v && v.hasData && v.status !== 'offline'; }).length;
  return `${on} מחוברים מתוך ${LIVE.length}`;
}
function liveListItem(a) {
  const v = liveState.get(a.id);
  const st = statusOf(v);
  const line = st === 'nodata' ? 'אין נתונים עדיין' : v.activity?.text ? '▸ ' + v.activity.text : v.current?.title ? v.current.title : (STATUS_HE[st] + (v.lastSeen ? ' · ' + ago(v.lastSeen) : ''));
  const al = alertOf(v);
  const mt = v?.meter && v.meter.level !== 'ok' ? v.meter : null;
  return `<div class="ag-item${al ? ' ag-alert' : ''}" data-id="${esc(a.id)}" role="button" tabindex="0">
    <span class="ap-emblem sm">${emblemSVG(a, 36)}</span>
    <div class="grow"><div style="font-weight:800;font-size:.88rem">${esc(a.name)} · <span class="muted">${esc(a.role)}</span></div>
    <div class="ag-last">${esc(line)}</div></div>
    ${mt ? `<span class="mt-chip mt-${mt.level}" title="${esc(meterText(mt))}">${ic('wallet', 'inline')} ${Math.round(mt.pct)}%</span>` : ''}
    ${al ? `<span class="st-chip st-alert" title="${esc(alertTitle(al))}">${ic('triangle-alert', 'inline')} ${esc(alertLabel(al))}</span>`
      : `<span class="st-chip st-${st}"><span class="dot"></span>${st === 'nodata' ? 'אין נתונים' : STATUS_HE[st]}</span>`}
  </div>`;
}
function usageTile(label, value) {
  return `<div class="u-tile"><div class="u-val${value === '—' ? ' u-none' : ''}">${esc(value)}</div><div class="u-label">${label}</div></div>`;
}
function livePanelHtml(a) {
  const v = liveState.get(a.id);
  const st = statusOf(v);
  const head = `
    <div class="ap-top"><button class="btn btn-ghost ap-back" id="ap-back" type="button">→ כל הסוכנים</button></div>
    <div class="ap-head">
      <span class="ap-emblem">${emblemSVG(a, 46)}</span>
      <div class="grow"><div class="ap-name">${esc(a.name)}</div><div class="ap-role">${esc(a.role)} · חי</div></div>
      <span class="st-chip st-${st}"><span class="dot"></span>${st === 'nodata' ? 'אין נתונים' : STATUS_HE[st]}</span>
    </div>`;
  const focus = `<div class="ap-actions"><button class="btn btn-gold" id="ap-focus" type="button">${ic('crosshair')}<span class="lbl">מיקוד במשרד</span></button></div>`;
  if (st === 'nodata') {
    return head + `<div class="ap-nodata"><b>אין נתונים עדיין.</b> ${esc(a.name)} עוד לא דיווח למשרד. ברגע שיגיע הדיווח הראשון יופיעו כאן העבודה הנוכחית, המשימות, השימוש והיכולות שלו.</div>` + focus;
  }
  const cur = v.current;
  const currentHtml = cur?.title
    ? `<div class="ap-current">${safeUrl(cur.link) ? `<a href="${safeUrl(cur.link)}" target="_blank" rel="noopener">${esc(cur.title)} ↗</a>` : `<span>${esc(cur.title)}</span>`}
         ${v.activity?.text ? `<div class="ap-activity">▸ ${esc(v.activity.text)}</div>` : ''}
         ${cur.since ? `<div class="muted">מאז ${when(cur.since)} · ${ago(cur.since)}</div>` : ''}</div>`
    : `<div class="ap-current ap-current-none">${st === 'offline' ? 'לא מחובר כרגע' : 'אין משימה פעילה כרגע'}</div>`;
  const u = v.usageToday;
  const has = f => u && u[f] !== undefined;
  const usageHtml = (v.meter ? meterHtml(v.meter) : '') + (u
    ? `<div class="u-grid">
        ${usageTile('הודעות', has('messages') ? fmtNum(u.messages) : '—')}
        ${usageTile('טוקנים', has('tokens') ? fmtNum(u.tokens) : '—')}
        ${usageTile('עלות', has('cost') ? fmtCost(u.cost) : '—')}
        ${usageTile('משימות', has('tasks') ? fmtNum(u.tasks) : '—')}
      </div>${has('pct_of_quota') ? `<div class="u-quota"><span style="width:${Math.min(100, u.pct_of_quota)}%"></span></div><div class="muted">${fmtNum(u.pct_of_quota)}% מהמכסה היומית</div>` : ''}
      ${u.updated ? `<div class="muted ap-upd">דווח ${ago(u.updated)}</div>` : ''}`
    : `<div class="ap-empty-line">לא דווח שימוש היום</div>`);
  const tasks = v.tasks || [];
  const tasksHtml = tasks.length
    ? `<ul class="ap-tasks">${tasks.slice(0, 8).map(t => `
        <li title="${TASK_HE[t.status] || ''}"><span class="t-ico" aria-label="${TASK_HE[t.status] || ''}">${TASK_ICON[t.status] || '•'}</span>
          <span class="grow">${safeUrl(t.link) ? `<a href="${safeUrl(t.link)}" target="_blank" rel="noopener">${esc(t.title || t.id)}</a>` : esc(t.title || t.id)}${chainHtml(t)}${t.note ? `<div class="muted">${esc(t.note)}</div>` : ''}</span>
          <span class="muted">${when(t.ended || t.since)}</span></li>`).join('')}</ul>`
    : `<div class="ap-empty-line">עוד אין משימות</div>`;
  const c = v.config;
  const chips = (arr) => (arr || []).map(x => `<span class="chip">${esc(x)}</span>`).join('');
  const configHtml = c
    ? `${c.model ? `<div class="ap-row"><span>מודל</span><span class="ap-model">${esc(c.model)}</span></div>` : ''}
       ${c.description ? `<div class="ap-desc">${esc(c.description)}</div>` : ''}
       ${c.skills?.length ? `<div class="ap-sub">סקילים <span class="muted">(${c.skills.length})</span></div><div class="chips">${chips(c.skills)}</div>` : ''}
       ${c.tools?.length ? `<div class="ap-sub">כלים <span class="muted">(${c.tools.length})</span></div><div class="chips chips-tools">${chips(c.tools)}</div>` : ''}`
    : `<div class="ap-empty-line">הסוכן עוד לא דיווח על היכולות שלו</div>`;
  const al = alertOf(v);
  const alertHtml = al ? `<div class="al-card" role="alert"><b>${ic('triangle-alert', 'inline')} ${al.kind === 'stuck' ? 'תקוע' : 'שקט'} ${esc(durationHe(al.minutes))}</b> <span>${esc(alertTitle(al))}</span></div>` : '';
  return head + alertHtml + `
    <div class="ap-seen muted">דיווח אחרון ${ago(v.lastSeen)}</div>
    <section class="ap-sec"><h4>עובד עכשיו על</h4>${currentHtml}</section>
    ${reliabilityHtml(a, v)}
    <section class="ap-sec"><h4>7 ימים אחרונים</h4>${historyHtml(v.history7)}</section>
    <section class="ap-sec"><h4>שימוש היום</h4>${usageHtml}</section>
    ${agentReviewsHtml(a)}
    <section class="ap-sec"><h4>משימות אחרונות</h4>${tasksHtml}</section>
    <section class="ap-sec"><h4>יכולות</h4>${configHtml}</section>` + focus;
}


/* ---------------- 3. stuck / silent alerts ---------------- */
const alertShown = new Map(); // id -> alert kind already toasted
function alertOf(v) { return v ? agentAlert(v, nowRef()) : null; }
function alertTitle(al) {
  if (!al) return '';
  return al.kind === 'stuck'
    ? `אין עדכון על המשימה${al.task ? ` "${al.task}"` : ''} מאז ${hhmm(al.since)} (הסף: ${ALERT_AFTER_MIN} דק׳)`
    : `אין דיווח מאז ${hhmm(al.since)} (הסף: ${ALERT_AFTER_MIN} דק׳)`;
}
function liveAlerts() {
  return LIVE.map(a => ({ a, al: alertOf(liveState.get(a.id)) })).filter(x => x.al);
}
function alertBannerHtml() {
  const list = liveAlerts();
  if (!list.length) return '';
  return `<div class="al-banner" role="alert">
    <div class="al-title">${ic('triangle-alert', 'inline')} ${list.length === 1 ? 'סוכן אחד דורש תשומת לב' : `${list.length} סוכנים דורשים תשומת לב`}</div>
    ${list.map(({ a, al }) => `<div class="al-row" data-id="${esc(a.id)}" role="button" tabindex="0">
      <span class="ap-emblem sm">${emblemSVG(a, 26, { title: false })}</span>
      <span class="grow"><b>${esc(a.name)}</b> · ${al.kind === 'stuck' ? 'תקוע' : 'שקט'} ${esc(durationHe(al.minutes))}${al.task ? ` · <span class="muted">${esc(al.task)}</span>` : ''}</span>
    </div>`).join('')}
  </div>`;
}
function applyAlert(a) {
  const al = mode === 'live' ? alertOf(liveState.get(a.id)) : null;
  if (al && alertShown.get(a.id) !== al.kind && mode === 'live' && !replay.active) toast(`${a.name}: ${al.kind === 'stuck' ? 'תקוע' : 'שקט'} ${durationHe(al.minutes)}`, { err: true });
  if (al) alertShown.set(a.id, al.kind); else alertShown.delete(a.id);
  return al;
}
function refreshAlerts() {
  let n = 0;
  for (const a of LIVE) if (applyAlert(a)) n++;
  const nav = document.querySelector('.navbtn[data-view="view-agents"]');
  if (nav) nav.classList.toggle('has-alert', mode === 'live' && n > 0);
  if (mode === 'live' && !selectedId && window.innerWidth > 900) renderPanelDefault();
}
setInterval(refreshAlerts, 20_000);

/* ---------------- 2. 7-day history (per agent, from task.done / task.failed) ---------------- */
const DOW_HE = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
function historyHtml(days) {
  days = Array.isArray(days) && days.length ? days : [];
  if (!days.length) return `<div class="ap-empty-line">אין נתונים לשבוע האחרון</div>`;
  const done = days.reduce((s, d) => s + d.done, 0), failed = days.reduce((s, d) => s + d.failed, 0);
  const max = Math.max(4, ...days.map(d => d.done + d.failed));
  const W = 280, H = 92, padB = 18, colW = W / days.length, barW = Math.min(22, colW * 0.56);
  const bars = days.map((d, i) => {
    const x = i * colW + (colW - barW) / 2;
    const hD = (d.done / max) * (H - padB - 14), hF = (d.failed / max) * (H - padB - 14);
    const yD = H - padB - hD, yF = yD - hF;
    const dow = DOW_HE[new Date(d.day + 'T12:00:00Z').getUTCDay()];
    const today = i === days.length - 1;
    const tot = d.done + d.failed;
    return `<g><title>${d.day}: ${d.done} הושלמו, ${d.failed} נכשלו</title>
      <rect x="${x}" y="${H - padB - 1}" width="${barW}" height="1" fill="#3a2f1d"/>
      ${d.done ? `<rect x="${x}" y="${yD}" width="${barW}" height="${hD}" rx="3" fill="#4ade80"/>` : ''}
      ${d.failed ? `<rect x="${x}" y="${yF}" width="${barW}" height="${hF}" rx="3" fill="#f87171"/>` : ''}
      ${tot ? `<text x="${x + barW / 2}" y="${yF - 4}" text-anchor="middle" class="h-num">${tot}</text>` : ''}
      <text x="${x + barW / 2}" y="${H - 4}" text-anchor="middle" class="h-day${today ? ' h-today' : ''}">${today ? 'היום' : dow}</text></g>`;
  }).join('');
  // the SVG is drawn left-to-right (oldest -> today) inside an LTR box so "today" sits at the end of the timeline
  return `<div class="hist" dir="ltr"><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="משימות ב-7 הימים האחרונים">${bars}</svg></div>
    <div class="hist-sum">${done || failed ? `<span><i class="lg lg-done"></i>${done} הושלמו</span><span><i class="lg lg-fail"></i>${failed} נכשלו</span>` : '<span class="muted">אין משימות שהסתיימו בשבוע האחרון</span>'}</div>`;
}

/* ---------------- 1. code reviews ---------------- */
let reviews = [];
const VERDICT_HE = { approved: ['אושר', ic('circle-check', 'inline'), 'v-ok'], changes_requested: ['נדרשו תיקונים', ic('refresh-cw', 'inline'), 'v-chg'], commented: ['הערות', ic('message-circle', 'inline'), 'v-com'] };
const SEV_HE = { critical: 'קריטי', high: 'גבוה', medium: 'בינוני', low: 'נמוך', nit: 'ניטפיק' };
async function loadReviews() {
  if (!auth.loggedIn || mode !== 'live') return;
  try { const d = await apiGet('./api/reviews'); if (d) { reviews = d.reviews || []; afterReviews(); } } catch (e) { console.warn(e); }
}
function onReview(r) {
  if (mode !== 'live' || replay.active) return;
  const i = reviews.findIndex(x => x.id === r.id);
  if (i >= 0) reviews[i] = r; else reviews.push(r);
  reviews.sort((a, b) => a.ts - b.ts);
  afterReviews();
}
function afterReviews() {
  if (!$('#review-ov').classList.contains('hidden')) renderReviewOverlay();
  if (selectedId) { const a = findAgent(selectedId); if (a?.live) renderPanel(a); }
}
function agentMeta(id) { return LIVE.find(x => x.id === id) || AGENTS.find(x => x.id === id) || { id, name: id, color: '#a89c86', role: '' }; }
function nameOf(id) { return agentMeta(id).name || id; }
function trendChartSvg(trend, { W = 560, H = 190, focus = null, compact = false } = {}) {
  const series = trend.filter(s => s.points.length);
  if (!series.length) return '';
  const all = series.flatMap(s => s.points);
  const t0 = Math.min(...all.map(p => p.ts)), t1 = Math.max(...all.map(p => p.ts));
  const maxY = Math.max(4, ...all.map(p => p.findings));
  const pl = compact ? 6 : 30, pr = compact ? 6 : 12, pt = compact ? 8 : 14, pb = compact ? 8 : 22;
  const x = ts => pl + (t1 === t0 ? 0.5 : (ts - t0) / (t1 - t0)) * (W - pl - pr);
  const y = v => pt + (1 - v / maxY) * (H - pt - pb);
  const grid = compact ? '' : [0, Math.round(maxY / 2), maxY].map(v => `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="#332a1c" stroke-dasharray="3 4"/><text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end" class="t-ax">${v}</text>`).join('');
  const labelled = [];
  const lines = series.map(s => {
    const c = agentMeta(s.author).color, dim = focus && s.author !== focus;
    const lp = s.points[s.points.length - 1], lx = x(lp.ts), ly = y(lp.findings);
    const showLabel = !compact && !labelled.some(([px, py]) => Math.abs(px - lx) < 18 && Math.abs(py - ly) < 14);
    if (showLabel) labelled.push([lx, ly]);
    const pts = s.points.map(p => `${x(p.ts).toFixed(1)},${y(p.findings).toFixed(1)}`).join(' ');
    return `<g opacity="${dim ? 0.28 : 1}"><polyline points="${pts}" fill="none" stroke="${c}" stroke-width="${compact ? 2 : 3}" stroke-linejoin="round" stroke-linecap="round"/>
      ${s.points.map(p => `<circle cx="${x(p.ts).toFixed(1)}" cy="${y(p.findings).toFixed(1)}" r="${compact ? 2.5 : 4.5}" fill="#15110b" stroke="${c}" stroke-width="2"><title>${esc(nameOf(s.author))} · PR #${esc(p.pr)}: ${p.findings} ממצאים</title></circle>`).join('')}
      ${showLabel ? `<text x="${lx - 8}" y="${ly - 9}" text-anchor="end" class="t-lbl" fill="${c}">${lp.findings}</text>` : ''}</g>`;
  }).join('');
  const axis = compact ? '' : `<text x="${pl}" y="${H - 4}" class="t-ax">${esc(dateShort(t0))}</text><text x="${W - pr}" y="${H - 4}" text-anchor="end" class="t-ax">${esc(dateShort(t1))}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%"${compact ? ` height="${H}"` : ''} preserveAspectRatio="${compact ? 'none' : 'xMidYMid meet'}" role="img" aria-label="ממצאים לכל PR לאורך זמן">${grid}${lines}${axis}</svg>`;
}
function dateShort(ts) { return new Date(ts).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' }); }
function changePct(s) {
  if (s.change === null || s.change === undefined || s.points.length < 2) return '';
  const pct = Math.round(Math.abs(s.change) * 100);
  if (pct === 0) return '<span class="tr-flat">ללא שינוי</span>';
  return s.change < 0 ? `<span class="tr-down" title="פחות ממצאים לכל PR">↓ ${pct}%</span>` : `<span class="tr-up" title="יותר ממצאים לכל PR">↑ ${pct}%</span>`;
}
function sevChips(findings) {
  const c = severityCounts(findings);
  const chips = SEVERITIES.filter(s => c[s]).map(s => `<span class="sev sev-${s}">${c[s]} ${SEV_HE[s]}</span>`).join('');
  return chips || '<span class="sev sev-none">בלי ממצאים</span>';
}
function agentReviewsHtml(a) {
  const mine = reviews.filter(r => r.author_agent === a.id);
  const given = reviews.filter(r => r.reviewer_agent === a.id).length;
  if (!mine.length && !given) return '';
  const tr = reviewTrend(mine)[0];
  const last = mine[mine.length - 1];
  return `<section class="ap-sec"><h4>ביקורות קוד</h4>
    ${tr ? `<div class="rv-mini">${trendChartSvg([tr], { W: 280, H: 54, compact: true })}</div>
      <div class="rv-mini-sum">${tr.points.length} PRs נבדקו · ממצאים: ${tr.first} → ${tr.last} ${changePct(tr)}</div>
      <div class="rv-mini-last muted">אחרון: PR #${esc(last.pr)} · ${esc(nameOf(last.reviewer_agent))} · ${VERDICT_HE[last.verdict]?.[0] || ''}</div>` : ''}
    ${given ? `<div class="rv-mini-last muted">ביקר ${given} PRs של אחרים</div>` : ''}
    <button class="btn btn-ghost rv-open" id="ap-reviews" type="button">${ic('search')}<span class="lbl">כל הביקורות</span></button></section>`;
}
let reviewFocus = null;
function openReviews(focus = null) { reviewFocus = focus; renderReviewOverlay(); openOverlay('#review-ov'); }
function renderReviewOverlay() {
  const trend = reviewTrend(reviews);
  $('#review-ov-sub').textContent = 'חי · מי ביקר כל PR, מה נמצא, ואיך זה משתנה לאורך זמן';
  if (!reviews.length) {
    $('#review-ov-body').innerHTML = `<div class="rv-empty"><b>עוד אין ביקורות.</b><br>כשסוכן יבקר PR הוא ישלח <span class="mono">review</span> ל-<span class="mono">/api/ingest</span>, והביקורת תופיע כאן עם גרף הממצאים לכל סוכן.</div>`;
    return;
  }
  const legend = trend.map(s => `<button type="button" class="rv-leg${reviewFocus === s.author ? ' on' : ''}" data-author="${esc(s.author)}" style="--ac:${esc(agentMeta(s.author).color)}">
      <span class="ap-emblem sm">${emblemSVG(agentMeta(s.author), 24, { title: false })}</span>
      <span><b>${esc(nameOf(s.author))}</b> <span class="muted">${s.points.length} PRs · ${s.first} → ${s.last}</span> ${changePct(s)}</span></button>`).join('');
  const cards = reviews.slice().reverse().map(r => {
    const au = agentMeta(r.author_agent), rv = agentMeta(r.reviewer_agent);
    const [vt, vi, vc] = VERDICT_HE[r.verdict] || ['', '', ''];
    const title = `PR #${esc(r.pr)}${r.title ? ' · ' + esc(r.title) : ''}`;
    return `<article class="rv-card" style="--ac:${esc(au.color)}">
      <div class="rv-top">
        <div class="grow"><div class="rv-title">${safeUrl(r.link) ? `<a href="${safeUrl(r.link)}" target="_blank" rel="noopener">${title} ↗</a>` : title}</div>
          <div class="rv-meta">${r.repo ? `<span class="mono">${esc(r.repo)}</span> · ` : ''}${esc(when(r.ts))}${r.round > 1 ? ` · סבב ${r.round}` : ''}</div></div>
        <span class="rv-verdict ${vc}">${vi} ${vt}</span>
      </div>
      <div class="rv-who"><span class="ap-emblem sm">${emblemSVG(au, 22, { title: false })}</span><b>${esc(au.name)}</b><span class="muted">כתב</span>
        <span class="rv-arrow">←</span><span class="ap-emblem sm">${emblemSVG(rv, 22, { title: false })}</span><b>${esc(rv.name)}</b><span class="muted">ביקר</span></div>
      <div class="chips rv-sev">${sevChips(r.findings)}</div>
      ${r.summary ? `<div class="rv-sum">${esc(r.summary)}</div>` : ''}
      ${r.findings.length ? `<ul class="rv-find">${r.findings.slice(0, 4).map(f => `<li><span class="sev-dot sev-${f.severity}"></span><span class="grow">${esc(f.title)}${f.file ? ` <span class="mono muted">${esc(f.file)}${f.line ? ':' + f.line : ''}</span>` : ''}</span></li>`).join('')}${r.findings.length > 4 ? `<li class="muted">ועוד ${r.findings.length - 4}…</li>` : ''}</ul>` : ''}
    </article>`;
  }).join('');
  $('#review-ov-body').innerHTML = `
    <section class="rv-trend">
      <div class="rv-trend-head"><h4>ממצאים לכל PR לאורך זמן</h4><span class="muted">קו שיורד = פחות ממצאים בכל PR</span></div>
      <div class="rv-chart" dir="ltr">${trendChartSvg(trend, { focus: reviewFocus })}</div>
      <div class="rv-legend">${legend}</div>
    </section>
    <div class="rv-list">${cards}</div>`;
  document.querySelectorAll('.rv-leg').forEach(b => b.addEventListener('click', () => {
    reviewFocus = reviewFocus === b.dataset.author ? null : b.dataset.author; renderReviewOverlay();
  }));
}

/* ---------------- 4. what changed today ---------------- */
let changesToday = [], changesDay = '', changesShown = null;
const CHANGE_ICON = { 'pr.merged': ic('git-merge'), deploy: ic('rocket'), 'task.done': ic('circle-check'), 'pr.opened': ic('git-pull-request') };
async function loadChanges() {
  if (!auth.loggedIn || mode !== 'live') return;
  try { const d = await apiGet('./api/changes'); if (d) { changesToday = d.changes || []; changesDay = d.day || ''; renderChanges(); } } catch (e) { console.warn(e); }
}
function todayKey() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date()); }
function onChange(c) {
  if (mode !== 'live' || replay.active) return;
  if (new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(c.ts)) !== todayKey()) return;
  changesToday = [c, ...changesToday.filter(x => x.id !== c.id)].sort((a, b) => b.ts - a.ts);
  renderChanges();
}
function changeLine(c) {
  if (c.type === 'pr.merged') return `<b>מוזג</b> PR${c.pr ? ' #' + esc(c.pr) : ''}${c.title ? ' · ' + esc(c.title) : ''}${c.repo ? ` <span class="mono muted">${esc(c.repo)}</span>` : ''}`;
  if (c.type === 'deploy') {
    const st = c.status === 'success' ? '<b>פריסה</b>' : c.status === 'failed' ? '<b class="ch-fail">פריסה נכשלה</b>' : '<b class="ch-fail">פריסה בוטלה</b>';
    return `${st} ${esc(c.target)} → ${esc(c.env)}${c.version ? ` <span class="mono muted">${esc(c.version)}</span>` : ''}`;
  }
  if (c.type === 'pr.opened') return `<b>נפתח</b> PR${c.pr ? ' #' + esc(c.pr) : ''}${c.title ? ' · ' + esc(c.title) : ''}${c.repo ? ` <span class="mono muted">${esc(c.repo)}</span>` : ''}`;
  return `<b>הושלם</b> ${esc(c.title)}`;
}
function renderChanges() {
  const el = $('#changes-list'); if (!el) return;
  const list = replay.active && changesShown ? changesShown : changesToday;
  const counts = { 'pr.merged': 0, deploy: 0, 'task.done': 0 };
  list.forEach(c => { if (counts[c.type] !== undefined) counts[c.type]++; });
  $('#changes-sub').textContent = list.length ? `${counts['pr.merged']} מיזוגים · ${counts.deploy} פריסות · ${counts['task.done']} משימות` : 'היום';
  if (!list.length) { el.innerHTML = `<div class="ch-empty">עוד לא השתנה כלום היום. מיזוגים, פריסות ומשימות שנסגרו יופיעו כאן.</div>`; return; }
  el.innerHTML = list.map(c => {
    const a = agentMeta(c.merged_by || c.agent);
    const body = changeLine(c);
    return `<li class="ch-item ch-${c.type.replace('.', '-')}">
      <span class="ch-time">${esc(hhmm(c.ts))}</span><span class="ch-ico" aria-hidden="true">${CHANGE_ICON[c.type] || '•'}</span>
      <span class="grow">${safeUrl(c.link) ? `<a href="${safeUrl(c.link)}" target="_blank" rel="noopener">${body}</a>` : body}
        <span class="ch-by" style="color:${esc(a.color)}">${esc(a.name)}</span></span></li>`;
  }).join('');
}
setInterval(() => { if (mode === 'live') { loadChanges(); loadReviews(); } }, 60_000);


/* ---------------- B3. handoff chain ---------------- */
function chainHtml(t, card = false) {
  const chain = (t.chain || []).filter(Boolean);
  if (!chain.length) return '';
  const names = [...chain.map(nameOf), card ? t.agent?.name : null].filter(Boolean);
  return `<div class="${card ? 'kb-chain' : 'ap-chain'}" title="מי העביר את המשימה"><span dir="ltr">${names.map(esc).join(' → ')}</span></div>`;
}

/* ---------------- B4. cost / token meter ---------------- */
const METER_FIELD = { cost: 'עלות', tokens: 'טוקנים', messages: 'הודעות' };
function meterVal(f, n) { return f === 'cost' ? fmtCost(n) : fmtNum(n); }
function meterText(mt) { return `${METER_FIELD[mt.field]} היום ${meterVal(mt.field, mt.used)} מתוך ${meterVal(mt.field, mt.limit)} · ${Math.round(mt.pct)}%`; }
function meterHtml(mt) {
  return `<div class="mt mt-${mt.level}">
    <div class="mt-row"><span>${mt.level === 'over' ? `<i class="ldot ldot-over"></i> חרג מהתקציב` : mt.level === 'warn' ? `<i class="ldot ldot-warn"></i> קרוב לתקציב` : 'תקציב יומי'}</span><span class="mt-num" dir="ltr">${esc(meterVal(mt.field, mt.used))} / ${esc(meterVal(mt.field, mt.limit))}</span></div>
    <div class="mt-bar"><span style="width:${Math.min(100, mt.pct)}%"></span></div>
    <div class="muted">${esc(METER_FIELD[mt.field])} · ${Math.round(mt.pct)}% מהתקציב היומי</div></div>`;
}

/* ---------------- B6. meeting room ---------------- */
let meetTimer = null, lastMeetSig = '';
function scheduleMeetings() { if (!meetTimer) meetTimer = setTimeout(() => { meetTimer = null; refreshMeetings(); }, 300); }
function refreshMeetings() {
  if (!office) return;
  const groups = mode === 'live' ? meetingGroups(LIVE.map(a => liveState.get(a.id)).filter(Boolean)) : [];
  const sig = JSON.stringify(groups);
  if (sig === lastMeetSig) return;
  const before = lastMeetSig ? JSON.parse(lastMeetSig) : [];
  lastMeetSig = sig;
  if (!replay.active && mode === 'live') for (const g of groups) if (!before.some(b => b.key === g.key && b.ids.length >= g.ids.length))
    toast(`${g.ids.map(nameOf).join(', ')} עברו לחדר הישיבות · ${g.label}`);
}

/* ---------------- B5. morning summary ---------------- */
async function openSummary() {
  openOverlay('#summary-ov');
  $('#summary-text').textContent = 'טוען…';
  try {
    const r = await fetch('./api/summary', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) throw new Error('summary ' + r.status);
    const s = await r.json();
    $('#summary-text').textContent = s.text;
    $('#summary-sub').textContent = `מ-${hhmm(s.since)} עד ${hhmm(s.until)} · מוכן לשליחה`;
  } catch (e) { $('#summary-text').textContent = 'לא הצלחנו לטעון את הסיכום. אפשר לנסות שוב.'; }
}
$('#btn-summary')?.addEventListener('click', openSummary);
$('#summary-copy')?.addEventListener('click', e => {
  withBusy(e.currentTarget, 'מעתיק…', async () => { await navigator.clipboard.writeText($('#summary-text').textContent); toast('הסיכום הועתק'); });
});

/* ---------------- B2. day replay ---------------- */
// The room, the board, the feed and "what changed today" run from the day's stored reports through the
// very same reducer the server uses (office-state.js), so the replay shows exactly what happened, when.
const replay = { active: false, data: null, t: 0, t0: 0, t1: 0, states: new Map(), idx: 0, playing: false, speed: 60, raf: 0, lastFrame: 0, lastView: 0 };
const REPLAY_SPEEDS = [10, 60, 600];
function cloneSnap(snap) { const m = new Map(); for (const [id, s] of Object.entries(snap || {})) m.set(id, structuredClone({ usage: {}, ...s })); return m; }
async function enterReplay() {
  if (mode !== 'live' || replay.active) return;
  const btn = $('#btn-replay');
  withBusy(btn, 'טוען…', async () => {
    const d = await apiGet('./api/replay');
    if (!d) return;
    const reports = (d.reports || []).slice().sort((a, b) => a.ts - b.ts);
    if (!reports.length) { toast('עוד אין אירועים היום לשחזור'); return; }
    Object.assign(replay, { active: true, data: { ...d, reports }, playing: false, idx: 0 });
    replay.t0 = Math.max(d.start, reports[0].ts - 5 * 60_000);
    replay.t1 = Math.min(d.end, Math.max(d.now, reports[reports.length - 1].ts + 60_000));
    document.body.classList.add('is-replay');
    $('#replay-bar').classList.remove('hidden');
    const sl = $('#replay-slider'); sl.min = 0; sl.max = 1000; sl.value = 0;
    $('#replay-from').textContent = hhmm(replay.t0); $('#replay-to').textContent = hhmm(replay.t1);
    selectedId = null; office.unfocus();
    replaySeek(replay.t0);
    replayPlay(true);
  });
}
function exitReplay() {
  if (!replay.active) return;
  replayPlay(false);
  replay.active = false; replay.data = null; replay.states = new Map();
  document.body.classList.remove('is-replay');
  $('#replay-bar').classList.add('hidden');
  liveState.clear();
  lastMeetSig = '';
  $('#log').innerHTML = '';
  loadAgents().then(() => pollEvents(true));
  loadChanges();
  refreshWorld(true);
}
function replayRender(full = false) {
  const t = replay.t;
  // agents with nothing yet at this moment show as "no data", not with their live numbers
  const ids = new Set([...LIVE.map(a => a.id), ...replay.states.keys()]);
  for (const id of ids) {
    const s = replay.states.get(id) || { ...emptyAgent(id, replay.t0), firstSeen: replay.t0 };
    const a = liveAgentFor(id, s.name);
    const v = viewAt(s, t);
    liveState.set(a.id, v);
    onAgentUpdate(v, { quiet: !full, replaying: true });
  }
  renderKpis();
  if (selectedId) { const a = findAgent(selectedId); if (a) renderPanel(a); } else renderPanelDefault();
  changesShown = changesToday.filter(c => c.ts <= t);
  renderChanges();
  refreshMeetings();
  refreshWorld(true);
  $('#replay-time').textContent = new Date(t).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  $('#replay-slider').value = Math.round((t - replay.t0) / Math.max(1, replay.t1 - replay.t0) * 1000);
}
function replayApply(r, animate) {
  const prev = replay.states.get(r.agent);
  replay.states.set(r.agent, applyReport(prev, r, r.ts));
  if (!isFeedEvent(r)) return;
  const a = liveAgentFor(r.agent, r.name);
  if (animate) {
    logLine(a, r.kind, r.value || '', feedNote(r), r.ts);
    if (r.kind === 'task.done' && r.taskStatus !== 'failed') office.celebrate(a.id);
  }
}
function replaySeek(t) {
  replay.t = Math.max(replay.t0, Math.min(replay.t1, t));
  replay.states = cloneSnap(replay.data.snapshot);
  const reps = replay.data.reports;
  let i = 0;
  for (; i < reps.length && reps[i].ts <= replay.t; i++) replayApply(reps[i], false);
  replay.idx = i;
  // the log shows the last lines up to this moment
  $('#log').innerHTML = '';
  reps.slice(0, i).filter(isFeedEvent).slice(-15).forEach(r => logLine(liveAgentFor(r.agent, r.name), r.kind, r.value || '', feedNote(r), r.ts));
  replayRender(true);
}
function replayStep(now) {
  if (!replay.active || !replay.playing) return;
  const dt = Math.min(0.1, (now - (replay.lastFrame || now)) / 1000);
  replay.lastFrame = now;
  replay.t = Math.min(replay.t1, replay.t + dt * 1000 * replay.speed);
  const reps = replay.data.reports;
  let changed = false;
  while (replay.idx < reps.length && reps[replay.idx].ts <= replay.t) { replayApply(reps[replay.idx], true); replay.idx++; changed = true; }
  if (changed || now - replay.lastView > 400) { replay.lastView = now; replayRender(changed); }
  if (replay.t >= replay.t1) { replayPlay(false); return; }
  replay.raf = requestAnimationFrame(replayStep);
}
function replayPlay(on) {
  replay.playing = on && replay.t < replay.t1;
  cancelAnimationFrame(replay.raf);
  $('#replay-play').innerHTML = ic(replay.playing ? 'pause' : 'play');
  $('#replay-play').setAttribute('aria-label', replay.playing ? 'השהיה' : 'ניגון');
  if (replay.playing) { replay.lastFrame = 0; replay.raf = requestAnimationFrame(replayStep); }
}
$('#btn-replay')?.addEventListener('click', enterReplay);
$('#replay-exit')?.addEventListener('click', exitReplay);
$('#replay-play')?.addEventListener('click', () => { if (replay.t >= replay.t1) replaySeek(replay.t0); replayPlay(!replay.playing); });
$('#replay-speed')?.addEventListener('click', e => {
  replay.speed = REPLAY_SPEEDS[(REPLAY_SPEEDS.indexOf(replay.speed) + 1) % REPLAY_SPEEDS.length];
  e.currentTarget.textContent = '×' + replay.speed;
});
$('#replay-slider')?.addEventListener('input', e => {
  const k = Number(e.currentTarget.value) / 1000;
  replaySeek(replay.t0 + k * (replay.t1 - replay.t0));
});
window.__replay = { enter: enterReplay, exit: exitReplay, seek: t => replaySeek(t), play: on => replayPlay(on), state: () => ({ active: replay.active, t: replay.t, t0: replay.t0, t1: replay.t1, idx: replay.idx, n: replay.data?.reports.length || 0 }), speed: s => { replay.speed = s; $('#replay-speed').textContent = '×' + s; } };


/* ---------------- C1. reliability score ---------------- */
function reliabilityHtml(a, v) {
  if (!v?.hasData) return '';
  const trend = reviewTrend(reviews.filter(r => r.author_agent === a.id))[0] || null;
  const rel = reliability(v, trend, alertOf(v));
  const R = RELIABILITY;
  return `<section class="ap-sec rel rel-${rel.level}"><h4>אמינות</h4>
    <div class="rel-top"><div class="rel-score" dir="ltr">${rel.score}<small>/100</small></div>
      <div><div class="rel-label">${esc(rel.label)}</div>${rel.lowData ? '<div class="muted">מעט נתונים עדיין, הציון יתייצב עם עוד משימות</div>' : ''}</div></div>
    <div class="rel-parts">${rel.parts.map(p => `<div class="rel-part"><div class="rel-row"><span>${esc(p.label)}</span><span dir="ltr">${p.points}/${p.max}</span></div>
      <div class="rel-bar"><span style="width:${Math.round(p.points / p.max * 100)}%"></span></div><div class="muted">${esc(p.detail)}</div></div>`).join('')}</div>
    <details class="rel-how"><summary>איך זה מחושב?</summary>
      <p><b>הצלחה (${R.success})</b>: החלק מהמשימות שהסתיימו ב-7 הימים האחרונים שהושלמו ולא נכשלו. בלי משימות שהסתיימו: ${Math.round(R.success * 0.75)} (ניטרלי).</p>
      <p><b>יציבות (${R.stability})</b>: מתחילים מ-${R.stability} ומורידים ${R.stuckPenalty} על כל פעם שהסוכן נתקע (משימה פתוחה בלי עדכון יותר מ-${ALERT_AFTER_MIN} דקות) ב-7 ימים.</p>
      <p><b>איכות קוד (${R.quality})</b>: לפי מגמת הממצאים בביקורות על ה-PRs של הסוכן, מה-PRs הראשונים לאחרונים. ירידה מלאה = ${R.quality}, בלי שינוי = ${R.quality / 2}, עלייה = פחות. בלי ביקורות: ${R.quality / 2}.</p>
      <p class="muted">הכול מחושב מהאירועים שהסוכנים כבר שולחים. אין שדה חדש לדווח.</p>
    </details></section>`;
}

/* Owner requests: keep a stable key across a network retry. */
let assignRequestId = '', assignFingerprint = '', media = null, mediaLoading = null;
// Voice + attachments live in their own module, fetched only when the modal opens (nothing on the first paint).
function loadAssignMedia() {
  if (media) { media.relayout(); return; }
  mediaLoading ||= import('./assign-media.js?v=1').then(mod => {
    media = mod.mount({ form: $('#assign-form'), title: $('#assign-title'), note: $('#assign-note'), caps: () => ({ uploads: auth.uploads, transcribe: auth.transcribe }), toast, onUnauthorized: () => onLoggedOut(true) });
    $('#assign-form').addEventListener('assign-media', e => { $('#assign-submit').disabled = !!e.detail.busy; });
  }).catch(() => { mediaLoading = null; });
}
function openAssign(agentId = '') {
  const sel = $('#assign-agent');
  const list = LIVE.length ? LIVE : [];
  sel.innerHTML = '<option value="all">כולם: Instinct, Hermes, Tab</option>' + list.filter(a => ['instinct', 'hermes', 'tab'].includes(a.id)).map(a => `<option value="${esc(a.id)}"${a.id === agentId ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
  assignRequestId = ''; assignFingerprint = '';
  $('#assign-title').value = ''; $('#assign-note').value = ''; $('#assign-err').textContent = '';
  media?.reset();
  openOverlay('#assign-ov');
  loadAssignMedia();
  setTimeout(() => $('#assign-title').focus(), 60);
}
$('#btn-assign')?.addEventListener('click', () => openAssign(selectedId || ''));
$('#assign-form')?.addEventListener('submit', e => {
  e.preventDefault();
  const title = $('#assign-title').value.trim(), agent = $('#assign-agent').value, note = $('#assign-note').value.trim();
  if (!title) { $('#assign-err').textContent = 'צריך כותרת למשימה'; $('#assign-title').focus(); return; }
  media?.stop();
  if (media?.busy()) { $('#assign-err').textContent = 'ממתין לסיום ההעלאה או התמלול'; return; }
  const attachments = media ? media.ids() : [];
  const fingerprint = JSON.stringify({ title, agent, note, attachments });
  if (fingerprint !== assignFingerprint) { assignRequestId = crypto.randomUUID(); assignFingerprint = fingerprint; }
  const requestId = assignRequestId;
  withBusy($('#assign-submit'), 'שומר בתור…', async () => {
    $('#assign-err').textContent = '';
    const r = await fetch('./api/tasks', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, agent, note, requestId, ...(attachments.length ? { attachments } : {}) }) });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) { onLoggedOut(true); return; }
    if (!r.ok || !d.ok) { $('#assign-err').textContent = 'לא נוסף: ' + ((d.details || []).join(', ') || d.error || r.status); return; }
    closeOverlay('#assign-ov'); media?.reset();
    toast(`נשמר בתור עבור ${agent === 'all' ? 'שלושת הסוכנים' : nameOf(agent)}. ממתין לאיסוף, לא בוצע עדיין.`);
    loadAgents();
    if (!$('#board-ov').classList.contains('hidden')) renderBoardOverlay();
  });
});

/* ---------------- login (Ori only) ---------------- */
async function checkAuth() {
  try {
    const r = await fetch('./api/me', { credentials: 'same-origin', cache: 'no-store' });
    if (r.ok) Object.assign(auth, await r.json().then(d => ({ loggedIn: !!d.loggedIn, configured: !!d.loginConfigured, uploads: !!d.uploads, transcribe: !!d.transcribe })));
  } catch { /* static preview: no API -> demo only */ }
  renderAuthButton();
}
function renderAuthButton() {
  const b = $('#btn-login');
  b.innerHTML = auth.loggedIn ? `${ic('lock-open')}<span class="lbl">יציאה</span>` : `${ic('lock')}<span class="lbl">כניסה</span>`;
  b.setAttribute('aria-label', auth.loggedIn ? 'יציאה מהמשרד החי' : 'כניסה למשרד החי');
  document.body.classList.toggle('authed', !!auth.loggedIn);
}
function openLogin() {
  $('#login-err').classList.add('hidden');
  $('#login').classList.remove('hidden');
  setTimeout(() => $('#login-pass').focus(), 50);
}
function closeLogin() { $('#login').classList.add('hidden'); $('#login-pass').value = ''; }
function onLoggedOut(expired = false) {
  if (!auth.loggedIn) return;
  auth.loggedIn = false;
  try { ws?.close(); } catch {}
  ws = null;
  liveState.clear();
  renderAuthButton();
  if (mode === 'live') enterDemoMode();
  if (expired) toast('החיבור פג — צריך להיכנס שוב', { err: true, retry: openLogin });
}
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#login-submit');
  const err = $('#login-err');
  err.classList.add('hidden');
  withBusy(btn, 'נכנס…', async () => {
    const r = await fetch('./api/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#login-pass').value }),
    }).catch(() => null);
    if (!r || !r.ok) {
      const msg = !r ? 'אין חיבור לשרת. אפשר לנסות שוב.'
        : r.status === 401 ? 'הסיסמה לא נכונה.'
        : r.status === 429 ? 'יותר מדי ניסיונות. כדאי לחכות רבע שעה.'
        : r.status === 503 ? 'הכניסה עוד לא הוגדרה בשרת.'
        : 'הכניסה נכשלה. אפשר לנסות שוב.';
      err.textContent = msg; err.classList.remove('hidden');
      $('#login-pass').select();
      return;
    }
    auth.loggedIn = true;
    renderAuthButton();
    closeLogin();
    enterLiveMode();
  });
});
$('#login-cancel').addEventListener('click', closeLogin);
$('#login').addEventListener('click', e => { if (e.target.id === 'login') closeLogin(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#login').classList.contains('hidden')) closeLogin(); });
$('#btn-login').addEventListener('click', e => {
  if (!auth.loggedIn) { openLogin(); return; }
  withBusy(e.currentTarget, 'יוצא…', async () => {
    await fetch('./api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    onLoggedOut();
    return `${ic('lock')}<span class="lbl">כניסה</span>`;
  });
});

/* ---------------- demo simulation ---------------- */
let paused = false, speed = 1, simTimer = null, meetingActive = false, meetingDone = false;

function pickAgent() {
  const weights = AGENTS.map(a => (a.kinds || []).some(k => /^lead/.test(k[0])) ? 3 : (a.kinds || []).length ? 2 : 0.2);
  const total = weights.reduce((x, y) => x + y, 0);
  let r = Math.random() * total;
  for (let i = 0; i < AGENTS.length; i++) { r -= weights[i]; if (r <= 0) return AGENTS[i]; }
  return AGENTS[0];
}

function fireEvent() {
  if (meetingActive || mode !== 'demo') return;
  const a = pickAgent();
  if (!a || !(a.kinds || []).length) return;
  const [kind, he, marker] = a.kinds[rnd(0, a.kinds.length - 1)];
  applyEventToOffice(a, kind, markerVal(marker), he);
}

// The simulation runs on the room clock (room-core onFrame), so it pauses with the tab and honours the speed button.
let simClock = 0, simNext = Infinity, nextCoffee = 6;
const simJobs = [];
function simAfter(sec, fn) { simJobs.push({ at: simClock + sec, fn }); }
function simFrame(dt) {
  if (mode !== 'demo' || paused) return;
  simClock += dt * speed;
  for (let i = simJobs.length - 1; i >= 0; i--) if (simJobs[i].at <= simClock) simJobs.splice(i, 1)[0].fn();
  if (simClock >= simNext) { fireEvent(); simNext = simClock + rnd(1800, 4200) / 1000; }
  if (simClock >= nextCoffee && !meetingActive) { // ambient life: someone grabs a coffee
    nextCoffee = simClock + 7 + Math.random() * 6;
    const a = AGENTS[rnd(0, AGENTS.length - 1)];
    if (a && office.coffeeBreak(a.id, 4 + Math.random() * 3)) statOf(a.id).state = 'walk';
  }
}
function scheduleNext() {
  clearTimeout(simTimer);
  if (paused || mode !== 'demo') return;
  simNext = simClock + rnd(1800, 4200) / 1000;
}
function startSim() {
  updateWallScreen();
  for (let i = 0; i < 5; i++) simAfter(0.45 * (i + 1), fireEvent);
  simNext = simClock + 3;
  if (!SHOWCASE) simAfter(18, () => { if (!meetingDone && !paused && mode === 'demo') startMeeting(true); });
}

/* ---------------- controls ---------------- */
$('#btn-pause').addEventListener('click', e => {
  const btn = e.currentTarget;
  withBusy(btn, paused ? 'מפעיל…' : 'משהה…', async () => {
    await delay(300);
    paused = !paused;
    btn.setAttribute('aria-pressed', String(paused));
    if (paused) clearTimeout(simTimer); else scheduleNext();
    setPill();
    if (selectedId) renderPanel(findAgent(selectedId));
    return paused ? `${ic('play')}<span class="lbl">הפעל</span>` : `${ic('pause')}<span class="lbl">השהה</span>`;
  });
});
$('#btn-speed').addEventListener('click', e => {
  const btn = e.currentTarget;
  withBusy(btn, 'משנה…', async () => {
    await delay(250);
    speed = speed === 1 ? 2 : speed === 2 ? 4 : 1;
    if (!paused) scheduleNext();
    return `${ic('gauge')}<span class="lbl">מהירות ×${speed}</span>`;
  });
});
function startMeeting(auto = false) {
  meetingActive = true; meetingDone = true;
  if (window.innerWidth <= 900) switchView('view-scene');
  toast(auto ? 'ישיבת בוקר אוטומטית — הסוכנים מתאספים' : 'הסוכנים מתאספים לישיבת בוקר', { icon: 'coffee' });
  office.gatherAll();
  AGENTS.forEach(a => { statOf(a.id).state = 'meeting'; });
  renderPanelDefault();
  simAfter(7, () => {
    office.disperseAll();
    AGENTS.forEach(a => { statOf(a.id).state = 'typing'; });
    meetingActive = false;
    toast('ישיבת הבוקר הסתיימה — חזרו לעבוד', { icon: 'check' });
    if (selectedId) renderPanel(findAgent(selectedId));
  });
}
$('#btn-meeting').addEventListener('click', e => {
  const btn = e.currentTarget;
  if (meetingActive) return;
  withBusy(btn, 'מזמין…', async () => {
    await delay(350);
    startMeeting(false);
  });
});
$('#btn-resetcam').addEventListener('click', e => {
  withBusy(e.currentTarget, 'מאפס…', async () => {
    await delay(200);
    office.unfocus(); office.resetCam(); selectedId = null;
    renderPanelDefault();
  });
});

/* ---------------- the world: kanban board + skills shelves (3D + readable 2D overlays) ---------------- */
// Demo board: each demo character works through its own clearly-labelled sample tasks.
const demoBoard = new Map(); // id -> {todo:[], doing:null, done:[{title, ended}]}
function initDemoBoard() {
  const now = Date.now();
  AGENTS.forEach((a, i) => {
    const t = (a.demoTasks || []).slice();
    if (!t.length) return;
    const sb = a.demoBoard; // optional seeded board (titles + labels) so the first screen is a realistic day
    if (sb) {
      demoBoard.set(a.id, {
        doing: sb.doing ? sb.doing.title : null,
        doingSince: sb.doing ? now - (sb.doing.ago || 3) * 60_000 : 0,
        todo: (sb.todo || []).map(x => x.title),
        rank: sb.rank ?? 9,
        todoWhen: Object.fromEntries((sb.todo || []).map(x => [x.title, x.when || ''])),
        done: (sb.done || []).map((d, k) => ({ title: d.title, ended: now - (k + 1 + i) * 9 * 60_000, at: d.at })),
      });
      // a spare pool for the simulation to recycle
      return;
    }
    demoBoard.set(a.id, {
      doing: t[0] || null,
      todo: t.slice(1, i % 2 ? 3 : 2),
      done: t.slice(i % 2 ? 3 : 2).map((title, k) => ({ title, ended: now - (k + 1 + i) * 9 * 60_000 })),
    });
  });
}
function demoTaskStep(a, kind) {
  const b = demoBoard.get(a.id); if (!b || Math.random() > 0.42) return;
  if (b.doing) { b.done.unshift({ title: b.doing, ended: Date.now() }); b.done.length = Math.min(b.done.length, 4); }
  const pool = (a.demoTasks || []);
  b.doing = b.todo.shift() || null; b.doingSince = Date.now();
  if (b.todo.length < 2) { // recycle a finished sample task back into the queue
    const recycled = pool.find(t => t !== b.doing && !b.todo.includes(t));
    if (recycled) b.todo.push(recycled);
  }
}
function boardData() {
  if (mode === 'demo') {
    const cols = { todo: [], doing: [], done: [] };
    for (const a of AGENTS) {
      const b = demoBoard.get(a.id); if (!b) continue;
      b.todo.forEach(title => cols.todo.push({ title, agent: a, status: 'queued', when: b.todoWhen?.[title] || '', rank: b.rank ?? 9 }));
      if (b.doing) cols.doing.push({ title: b.doing, agent: a, status: 'running', since: b.doingSince || 0, when: 'עכשיו', rank: b.rank ?? 9 });
      b.done.forEach(d => cols.done.push({ title: d.title, agent: a, status: 'done', ts: d.ended, when: d.at || when(d.ended) }));
    }
    cols.todo.sort((x, y) => x.rank - y.rank); cols.doing.sort((x, y) => x.rank - y.rank);
    cols.done.sort((x, y) => y.ts - x.ts);
    return { demo: true, columns: cols, updated: Date.now() };
  }
  // live: only what the agents reported (task.start / task.done / task.failed / task.queued)
  const cols = { todo: [], doing: [], done: [] };
  for (const a of LIVE) {
    const v = liveState.get(a.id);
    for (const t of v?.tasks || []) {
      const card = { title: t.title || t.id, agent: a, status: t.status, link: t.link, ts: t.ended || t.since || 0, chain: t.chain, handed_to: t.handed_to, assigned: t.assigned, note: t.note, board: t.board, id: t.id };
      card.when = card.ts ? when(card.ts) : '';
      if (t.status === 'running') cols.doing.push(card);
      else if (t.status === 'queued' || t.status === 'blocked') cols.todo.push(card);
      else cols.done.push(card);
    }
  }
  for (const k of Object.keys(cols)) cols[k].sort((x, y) => y.ts - x.ts);
  cols.done = cols.done.slice(0, 20);
  return { demo: false, columns: cols, updated: Date.now(),
    empty: { todo: 'אין משימות בתור', doing: 'אף סוכן לא עובד כרגע', done: 'עוד לא דווחו משימות' } };
}
function shelfRows() {
  if (mode === 'demo') return AGENTS.slice(0, 6).map(a => ({ meta: a, skills: a.skills || [], demo: true, nodata: !(a.skills || []).length }));
  return LIVE.slice(0, 6).map(a => {
    const skills = liveState.get(a.id)?.config?.skills || [];
    return { meta: a, skills, demo: false, nodata: !skills.length };
  });
}
let worldTimer = null, lastShelfSig = '', lastBoardSig = '';
function refreshWorld(now = false) {
  if (!office) return;
  if (!now) { if (!worldTimer) worldTimer = setTimeout(() => { worldTimer = null; refreshWorld(true); }, 400); return; }
  const bd = boardData();
  const sig = JSON.stringify([bd.demo, Object.values(bd.columns).map(c => c.map(x => x.title + x.agent.id + x.status + JSON.stringify(x.board || {}) + (x.board && x.board.status === 'queued' && notPickedUp(x.board) ? '!' : '')))]);
  if (sig !== lastBoardSig) { lastBoardSig = sig; if (!$('#board-ov').classList.contains('hidden')) renderBoardOverlay(); renderCPanel(); }
  const rows = shelfRows();
  const ssig = JSON.stringify(rows.map(r => [r.meta.id, r.skills, r.nodata]));
  if (ssig !== lastShelfSig) { lastShelfSig = ssig; if (!$('#shelf-ov').classList.contains('hidden')) renderShelfOverlay(); }
}

let lastFocus = null, overlayOpenedAt = 0;
function openOverlay(id) {
  lastFocus = document.activeElement;
  overlayOpenedAt = performance.now();
  const el = $(id); el.classList.remove('hidden');
  setTimeout(() => el.querySelector('.ov-close')?.focus(), 30);
}
function closeOverlay(id) { $(id).classList.add('hidden'); lastFocus?.focus?.(); }
function openBoard() { renderBoardOverlay(); openOverlay('#board-ov'); }
function openShelves() { renderShelfOverlay(); openOverlay('#shelf-ov'); }
function renderBoardOverlay() {
  const bd = boardData();
  $('#board-ov-sub').textContent = bd.demo ? 'דמו · משימות לדוגמה, לא נתונים אמיתיים' : 'חי · משימות הלוח ממתינות לאיסוף (בדיקה כל 5 דקות). סיום רק אחרי דיווח עם תוצאה.';
  const names = { todo: 'לביצוע', doing: 'בעבודה', done: 'הושלם' };
  $('#board-ov-cols').innerHTML = ['todo', 'doing', 'done'].map(k => {
    const list = bd.columns[k];
    return `<section class="kb-col kb-${k}" aria-label="${names[k]}">
      <h4><span class="kb-dot"></span>${names[k]} <span class="kb-count">${list.length}</span></h4>
      ${list.length ? list.map(c => `<article class="kb-card" style="--ac:${esc(c.agent.color)}">
        <span class="kb-emb">${emblemSVG(c.agent, 30, { title: false })}</span>
        <div class="grow"><div class="kb-title">${safeUrl(c.link) ? `<a href="${safeUrl(c.link)}" target="_blank" rel="noopener">${esc(c.title)}</a>` : esc(c.title)}</div>
        <div class="kb-meta">${c.assigned ? `<span class="kb-manual" title="נוסף ידנית מהלוח">${ic('pencil', 'inline')} ידני</span> · ` : ''}${esc(c.agent.name)}${c.status === 'failed' ? ' · <b class="kb-fail">נכשל</b>' : c.status === 'blocked' ? ' · ממתין' : c.status === 'handed' ? ` · ${ic('corner-up-right', 'inline')} הועבר ל-${esc(nameOf(c.handed_to))}` : ''}${c.when ? ' · ' + esc(c.when) : ''}</div>${chainHtml(c, true)}${boardStatusHtml(c)}${c.note ? `<div class="kb-note">${esc(c.note)}</div>` : ''}</div>
      </article>`).join('') : `<div class="kb-empty">${esc(bd.empty?.[k] || '—')}</div>`}
    </section>`;
  }).join('');
}
function filesHtml(b) {
  const list = (b.attachments || []).filter(a => /^f-[a-f0-9]{32}$/.test(a.id));
  return list.length ? `<div class="kb-files">${list.map(a => `<a class="kb-file" href="./api/files/${a.id}" target="_blank" rel="noopener">${ic('paperclip', 'inline')} ${esc(a.name)}</a>`).join('')}</div>` : '';
}
function boardStatusHtml(c) {
  if (!c.board) return '';
  const b = c.board;
  const waiting = isUnclaimed(b);
  const label = b.status === 'running' ? 'הסוכן קיבל ועובד' : b.status === 'done' ? 'הסוכן דיווח שהושלם' : b.status === 'blocked' ? 'ממתין לאישור או מידע' : b.status === 'failed' ? 'הסוכן דיווח על כשל' : b.delivery === 'delivered' ? 'נשלחה הודעה · ממתין לקבלה' : b.delivery === 'error' ? 'שליחת ההודעה נכשלה' : 'ממתין לאיסוף';
  const warn = waiting ? `<div class="board-warn" role="alert"><span class="bw-ic">${ic('triangle-alert', 'inline')}</span> לא נלקחה כבר ${waitingMinutes(b)} דקות${b.pings ? ` · נשלח פינג ${b.pings > 1 ? b.pings + ' פעמים' : 'פעם אחת'}` : ''}</div>` : '';
  const retry = b.delivery === 'error' && b.status === 'queued';
  const ping = waiting && auth.loggedIn && !retry ? `<button class="btn btn-ghost board-ping" data-task="${esc(b.id)}">פינג שוב</button>` : '';
  return `<div class="board-status" role="status">${esc(label)}${b.stale ? ' · ללא עדכון מעל 30 דקות' : ''}</div>${warn}${filesHtml(b)}${b.deliveryNote ? `<div class="kb-note">${esc(b.deliveryNote)}</div>` : ''}${b.result ? `<div class="board-result"><b>תוצאה / עדכון</b><br>${esc(b.result)}</div>` : ''}${retry ? `<button class="btn btn-ghost board-retry" data-task="${esc(b.id)}">ניסיון שליחת הודעה נוסף</button>` : ''}${ping}`;
}
function onBoardAction(e) {
  const btn = e.target.closest('.board-retry, .board-ping');
  if (!btn) return;
  e.stopPropagation();
  const ping = btn.classList.contains('board-ping');
  withBusy(btn, ping ? 'שולח פינג…' : 'מחזיר לתור…', async () => {
    const r = await fetch('./api/tasks/' + encodeURIComponent(btn.dataset.task) + (ping ? '/ping' : '/retry'), { method: 'POST', credentials: 'same-origin' });
    if (r.status === 401) { onLoggedOut(true); return; }
    if (r.status === 409 && ping) { toast('המשימה כבר נלקחה'); await loadAgents(); renderBoardOverlay(); return; }
    if (!r.ok) throw new Error(ping ? 'ping failed' : 'retry failed');
    if (ping) toast('נשלח פינג בסלאק');
    await loadAgents(); renderBoardOverlay(); renderCPanel();
  });
}
$('#board-ov-cols').addEventListener('click', onBoardAction);
$('#cp-cols')?.addEventListener('click', onBoardAction);
// "not picked up" is a function of time: re-evaluate once a minute, and only while the board is open.
setInterval(() => { if (mode !== 'live') return; if (!$('#board-ov').classList.contains('hidden')) refreshWorld(true); }, 60_000);
function renderShelfOverlay() {
  const rows = shelfRows();
  $('#shelf-ov-sub').textContent = mode === 'demo' ? 'דמו · סקילים לדוגמה של דמויות הדמו' : 'חי · היכולות שכל סוכן דיווח (config)';
  $('#shelf-ov-list').innerHTML = rows.map(r => `<section class="sh-row" style="--ac:${esc(r.meta.color)}">
      <div class="sh-head"><span class="ap-emblem">${emblemSVG(r.meta, 40, { title: false })}</span>
        <div><div class="sh-name">${esc(r.meta.name)}</div><div class="muted">${esc(r.meta.role || '')}</div></div>
        <span class="sh-count">${r.nodata ? '' : r.skills.length + ' סקילים'}</span></div>
      ${r.nodata ? `<div class="ap-empty-line">${r.demo ? 'אין סקילים לדמות הזו' : 'עוד לא דיווח על הסקילים שלו'}</div>`
        : `<div class="chips">${r.skills.map(s => `<span class="chip sh-chip">${esc(s)}</span>`).join('')}</div>`}
      ${!r.demo && liveState.get(r.meta.id)?.config?.tools?.length ? `<div class="ap-sub">כלים</div><div class="chips chips-tools">${liveState.get(r.meta.id).config.tools.map(s => `<span class="chip">${esc(s)}</span>`).join('')}</div>` : ''}
    </section>`).join('');
}
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeOverlay(b.dataset.close)));
// backdrop tap closes — but not the synthetic click of the very tap that opened it from the 3D scene
document.querySelectorAll('.overlay').forEach(ov => ov.addEventListener('click', e => { if (e.target === ov && performance.now() - overlayOpenedAt > 450) closeOverlay('#' + ov.id); }));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.overlay:not(.hidden)').forEach(ov => closeOverlay('#' + ov.id));
});
$('#btn-board').addEventListener('click', () => openBoard());
$('#btn-shelves').addEventListener('click', () => openShelves());
$('#btn-reviews').addEventListener('click', () => openReviews(null));
document.addEventListener('keydown', e => { if (e.key === 'Tab') document.body.classList.add('kbd'); });
document.addEventListener('pointerdown', () => document.body.classList.remove('kbd'));
$('#cv').addEventListener('keydown', e => { // the room picture is focusable: + / - zoom, 0 resets
  if (e.key === '+' || e.key === '=') { cv?.setZoom(cv.getZoom() * 1.25); e.preventDefault(); }
  else if (e.key === '-' || e.key === '_') { cv?.setZoom(cv.getZoom() / 1.25); e.preventDefault(); }
  else if (e.key === '0') { cv?.setPan(0); cv?.setZoom(1); e.preventDefault(); }
});

/* ---------------- mobile tabs ---------------- */
function switchView(id) {
  $('#sheet').classList.add('hidden');
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === id));
  document.querySelectorAll('.navbtn').forEach(b => b.classList.toggle('active', b.dataset.view === id));
  if (id === 'view-feed') { feedCount.n = 0; $('#feed-pill').textContent = '0'; }
  if (id === 'view-agents' && !selectedId) renderPanelDefault();
  drawChart();
}
document.querySelectorAll('.navbtn').forEach(b =>
  b.addEventListener('click', () => {
    const btn = b;
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    const ico = btn.querySelector('.ico');
    const orig = ico.textContent;
    ico.innerHTML = '<span class="spin"></span>';
    setTimeout(() => { ico.textContent = orig; delete btn.dataset.busy; switchView(btn.dataset.view); }, 180);
  }));

if (window.innerWidth <= 900) switchView('view-scene');
else renderPanelDefault();
setInterval(() => { if (window.innerWidth > 900 && !selectedId) renderPanelDefault(); }, 5000);


/* =================== v6: drawer + strip, bell + notifications, conversations, actions, time of day =================== */
const bellSound = createBell();
window.__bellStrikes = []; // strike times on the scene clock (used to put the synthesized sound on recordings)
const LS = { get(k, d) { try { const v = localStorage.getItem('office.' + k); return v === null ? d : v; } catch { return d; } }, set(k, v) { try { localStorage.setItem('office.' + k, String(v)); } catch {} } };
bellSound.setMuted(LS.get('sound', '1') === '0');
const unlockAudio = () => bellSound.unlock();
document.addEventListener('pointerdown', unlockAudio, { capture: true });
document.addEventListener('keydown', unlockAudio, { capture: true });
function renderSoundBtn() {
  const b = $('#btn-sound'); if (!b) return;
  b.innerHTML = ic(bellSound.muted ? 'volume-x' : 'volume-2');
  b.setAttribute('aria-pressed', String(!bellSound.muted));
  b.title = bellSound.muted ? 'צליל הפעמון כבוי' : 'צליל הפעמון פועל';
}
$('#btn-sound')?.addEventListener('click', () => {
  bellSound.setMuted(!bellSound.muted); LS.set('sound', bellSound.muted ? '0' : '1'); renderSoundBtn();
  if (!bellSound.muted) { bellSound.unlock(); setTimeout(() => bellSound.ring(0.5), 60); }
});
renderSoundBtn();

/* ---- browser notifications (Notification API) — asked only on a tap, shown for real events in live mode ---- */
const canNotify = typeof Notification !== 'undefined';
function renderNotifyBtn() {
  const b = $('#btn-notify'); if (!b) return;
  if (!canNotify) { b.title = 'הדפדפן הזה לא תומך בהתראות'; b.classList.remove('on'); return; }
  const p = Notification.permission;
  b.classList.toggle('on', p === 'granted');
  b.title = p === 'granted' ? 'התראות פועלות (לחיצה: התראת בדיקה)' : p === 'denied' ? 'ההתראות חסומות בהגדרות הדפדפן' : 'הפעלת התראות כשסוכן מסיים משימה או פותח PR';
}
$('#btn-notify')?.addEventListener('click', async () => {
  if (!canNotify) { toast('הדפדפן הזה לא תומך בהתראות. ההודעות יופיעו כאן בחלון.'); return; }
  if (Notification.permission === 'granted') { notify('בדיקת התראה', 'ככה תיראה התראה כשסוכן מסיים משימה או פותח PR', true); return; }
  if (Notification.permission === 'denied') { toast('ההתראות חסומות בהגדרות הדפדפן לאתר הזה', { err: true }); return; }
  try { await Notification.requestPermission(); } catch {}
  renderNotifyBtn();
  if (Notification.permission === 'granted') toast('התראות הופעלו', { icon: 'bell' });
});
renderNotifyBtn();
function notify(title, body, force = false) {
  if (!canNotify || Notification.permission !== 'granted') return false;
  if (!force && document.visibilityState === 'visible' && document.hasFocus()) return false; // the toast + sound already say it
  try {
    const n = new Notification(title, { body, tag: 'office-' + Date.now(), lang: 'he', dir: 'rtl', silent: false });
    n.onclick = () => { window.focus(); n.close(); };
    return true;
  } catch { return false; }
}

/* ---- the bell: task done / PR opened → the agent walks to the bell and rings it ---- */
const bellLog = { today: 0, day: '', lastDemo: -1e9 };
function ringWorthy(kind, he) {
  if (mode === 'live') {
    if (kind === 'pr.opened') return 'pr';
    if (kind === 'task.done' && !/^נכשל/.test(he || '')) return 'task';
    return null;
  }
  if (/deal\.won|published|task\.done/.test(kind) && simClock - bellLog.lastDemo > 40) { bellLog.lastDemo = simClock; return 'demo'; }
  return null;
}
function ringFor(a, why, he, { silentNotify = false } = {}) {
  if (!office || !a) return;
  const d = new Date().toDateString();
  if (bellLog.day !== d) { bellLog.day = d; bellLog.today = 0; }
  bellLog.today++;
  const prNum = why === 'pr' ? (String(he || '').match(/PR\s*#?\s*(\d+)/) || [])[1] : null;
  const label = why === 'pr' ? `${a.name} · ${prNum ? 'PR #' + prNum : 'PR חדש'}` : why === 'manual' ? `${a.name} מצלצל/ת` : `${a.name} · ${he || 'סיים משימה'}`;
  office.ringBell(a.id, label);
  if (replay.active) return;
  const title = why === 'pr' ? `${a.name} פתח/ה PR` : why === 'manual' ? '' : `${a.name} סיים/ה משימה`;
  if (title) toast(`${title}${he ? ' · ' + String(he).replace(/^סיים:\s*/, '').replace(/\s*🔔$/, '') : ''}`, { icon: why === 'pr' ? 'git-pull-request' : 'bell-ring' });
  if (mode === 'live' && title && !silentNotify) notify(title, String(he || '').replace(/\s*🔔$/, ''));
  renderStrip();
}
function manualRing() {
  const list = actionTargets();
  const a = list.find(x => x.id === acState.agent) || list[Math.floor(Math.random() * list.length)];
  if (a) ringFor(a, 'manual', '');
}

/* ---- drawer (desktop): full-screen room, the panel opens over it; a narrow strip stays when closed ---- */
let drawerOpen = LS.get('drawer', '1') !== '0';
function applyDrawer(animate = true) {
  const lay = $('#layout'), btn = $('#drawer-toggle');
  lay.classList.toggle('drawer-closed', !drawerOpen);
  btn.innerHTML = ic(drawerOpen ? 'chevron-left' : 'chevron-right');
  btn.setAttribute('aria-expanded', String(drawerOpen));
  btn.title = drawerOpen ? 'סגירת הפאנל' : 'פתיחת הפאנל';
  const desktop = window.innerWidth > 900;
  if (drawerOpen && desktop) setTimeout(drawChart, animate ? 340 : 0);
  renderStrip();
}
$('#drawer-toggle')?.addEventListener('click', () => { drawerOpen = !drawerOpen; LS.set('drawer', drawerOpen ? '1' : '0'); applyDrawer(); });
window.addEventListener('resize', () => applyDrawer(false));
const STRIP_DOT = { working: '#4ade80', idle: '#f5b301', blocked: '#f97316', offline: '#8b8577', nodata: '#8b8577', typing: '#4ade80', walk: '#4dc9f7', meeting: '#c986f2', celebrate: '#f472b6' };
function stripStatus(a) {
  if (mode === 'live') { const v = liveState.get(a.id); return { s: statusOf(v), label: v?.hasData ? (STATUS_HE[v.status] || v.status) : 'עוד לא דיווח', alert: !!alertOf(v) }; }
  const st = statOf(a.id).state; return { s: st, label: STATE_HE[st] || st, alert: false };
}
let stripTimer = 0;
function renderStrip() {
  if (stripTimer) return;
  stripTimer = setTimeout(() => {
    stripTimer = 0;
    const el = $('#drawer-strip'); if (!el || window.innerWidth <= 900) return;
    const list = roster().filter(a => office?.hasAgent(a.id));
    const alerts = mode === 'live' ? liveAlerts().length : 0;
    const ti = office?.timeInfo?.() || { hhmm: '--:--', phase: 'day' };
    const icon = ic(ti.phase === 'night' ? 'moon' : ti.phase === 'day' ? 'sun' : 'sunrise');
    const working = list.filter(a => ['working', 'typing'].includes(stripStatus(a).s)).length;
    // live: the same numbers as the KPI cards (connected · tasks today); demo: leads + revenue
    const k = mode === 'live' ? Object.fromEntries(liveKpis().map(([id, , v]) => [id, v])) : null;
    const s1 = k ? [k.online, 'מחוברים'] : [`${working}/${list.length}`, 'עובדים'];
    const s2 = k ? [k.tasks, 'משימות'] : [String(kpis.leads.v), 'הושלמו'];
    el.innerHTML = list.map(a => {
      const st = stripStatus(a), ini = esc((a.emblem?.mono || a.name || a.id).slice(0, 2));
      return `<button class="st-ag${st.alert ? ' alert' : ''}" type="button" data-id="${esc(a.id)}" style="--ac:${esc(a.color)};--sd:${STRIP_DOT[st.s] || '#8b8577'}" title="${esc(a.name)} · ${esc(st.label)}" aria-label="${esc(a.name)}: ${esc(st.label)}">${ini}<span class="st-dot"></span></button>`;
    }).join('') + `<div class="st-sep"></div>
      <div class="st-stat" title="${esc(s1[1])}"><b>${esc(s1[0])}</b>${esc(s1[1])}</div>
      <div class="st-stat" title="${esc(s2[1])} היום"><b>${esc(s2[0])}</b>${esc(s2[1])}</div>
      <div class="st-stat" title="אירועים מאז שהמסך נפתח"><b>${feedTotal.n}</b>אירועים</div>
      <div class="st-stat" title="צלצולים בפעמון היום"><b>${bellLog.today}</b>${ic('bell')}</div>
      ${alerts ? `<div class="st-stat warn" title="התראות"><b>${alerts}</b>${ic('triangle-alert')}</div>` : ''}
      <div class="st-sep"></div>
      <div class="st-stat" title="השעה בחדר"><b>${icon}</b>${esc(ti.hhmm)}</div>`;
    el.querySelectorAll('.st-ag').forEach(b => b.addEventListener('click', () => { drawerOpen = true; LS.set('drawer', '1'); applyDrawer(); selectAgent(b.dataset.id, true); }));
  }, 120);
}
const feedTotal = { n: 0 };
setInterval(renderStrip, 5000);

/* ---- time of day: the sky behind the room and the page theme follow the room's clock ---- */
let lastTod = '';
function onTimeOfDay(info) {
  const card = document.querySelector('.scene-card');
  const key = info.night.toFixed(2) + info.phase;
  if (card && key !== onTimeOfDay.key) {
    onTimeOfDay.key = key;
    card.style.setProperty('--night', info.night.toFixed(3));
    if (cv) cv.setNight(info.night);
    card.style.setProperty('--dawn', (info.phase === 'dawn' || info.phase === 'dusk' ? 1 : 0).toString());
  }
  if (info.phase !== lastTod) { lastTod = info.phase; document.body.dataset.tod = info.phase; renderStrip(); }
}

/* ---- conversations: demo scripts (demo mode) and quiet emoji small talk (live mode, no invented facts) ---- */
const DEMO_CHATS = [
  { lines: ['ה-PR מוכן לסקירה, מי פנוי?', 'אני על זה, שתי דקות', 'תודה, אשחרר אחרי האישור'], agreed: true },
  { lines: ['נתוני ShortiGo מוכנים', 'מעולה, מתחיל לארוז את ה-release', 'מעדכן את הערות השחרור'], agreed: true },
  { lines: ['הבדיקה במובייל נכשלה בדף התשלום', 'שולח לך צילום מסך', 'קיבלתי, מתקן עכשיו'], agreed: true },
  { lines: ['ראית את דוח הקמפיין השבועי?', 'כן, המספרים עלו 12% 🚀'], agreed: false },
  { lines: ['סיכום המתחרים עודכן', 'יש משהו שדורש תשומת לב?', 'שני דברים, אשלח לך'], agreed: true },
  { lines: ['קפה?', 'תמיד ☕'], agreed: false },
];
const LIVE_SMALLTALK = [['☕?', '👍'], ['👋', '🙂'], ['🚀', '🔥'], ['💡', '👀'], ['🙌', '😄']];
const life = { on: LS.get('life', '1') !== '0', nextChat: 22, nextLive: 0, t: 0, lastChat: 0 };
function pickTwo(list) {
  if (list.length < 2) return null;
  const a = list[Math.floor(Math.random() * list.length)];
  let b = a; while (b === a) b = list[Math.floor(Math.random() * list.length)];
  return [a, b];
}
function demoChat(pair, script) {
  const s = script || DEMO_CHATS[Math.floor(Math.random() * DEMO_CHATS.length)];
  const [a, b] = pair;
  return office.converse({ participants: [a.id, b.id], lines: s.lines.map((text, i) => ({ agent: i % 2 ? b.id : a.id, text })), agreed: s.agreed });
}
function lifeFrame(dt) {
  if (!office || SHOWCASE && QS.get('chat') !== '1' || replay.active || !life.on || paused) return;
  life.t += dt;
  if (mode === 'demo') {
    if (life.t >= life.nextChat && !meetingActive && !office.talking().length) {
      life.nextChat = life.t + 28 + Math.random() * 25;
      const pair = pickTwo(AGENTS.filter(a => office.hasAgent(a.id)));
      if (pair) demoChat(pair);
    }
  } else if (mode === 'live') {
    if (!life.nextLive) life.nextLive = life.t + 90 + Math.random() * 120;
    if (life.t >= life.nextLive && !office.talking().length) {
      life.nextLive = life.t + 180 + Math.random() * 240;
      const here = LIVE.filter(a => office.hasAgent(a.id) && liveState.get(a.id)?.hasData && liveState.get(a.id)?.status !== 'offline');
      const pair = pickTwo(here);
      if (pair) { const s = LIVE_SMALLTALK[Math.floor(Math.random() * LIVE_SMALLTALK.length)]; office.converse({ participants: [pair[0].id, pair[1].id], lines: [{ agent: pair[0].id, text: s[0] }, { agent: pair[1].id, text: s[1] }] }); }
    }
  }
}

/* ---- actions menu ---- */
const acState = { agent: '' };
function actionTargets() { return roster().filter(a => office?.hasAgent(a.id)); }
function renderActions() {
  const list = actionTargets();
  if (!list.find(a => a.id === acState.agent)) acState.agent = list[0]?.id || '';
  $('#ac-agents').innerHTML = list.map(a => `<button class="ac-agent" type="button" data-id="${esc(a.id)}" style="--ac:${esc(a.color)}" aria-pressed="${a.id === acState.agent}">${esc(a.name)}</button>`).join('');
  $('#ac-agents').querySelectorAll('.ac-agent').forEach(b => b.addEventListener('click', () => { acState.agent = b.dataset.id; renderActions(); }));
  const lifeBtn = document.querySelector('[data-act="life"]');
  lifeBtn.innerHTML = `${ic('sprout')}<span class="lbl">${life.on ? 'חיים במשרד: פועל' : 'חיים במשרד: כבוי'}</span>`;
  lifeBtn.setAttribute('aria-pressed', String(life.on));
  const tm = office?.timeInfo?.().mode || 'real';
  document.querySelectorAll('#ac-time [data-time]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.time === (tm === 'real' ? 'real' : acState.time))));
}
function toggleActions(open) {
  const pop = $('#actions-pop'), btn = $('#btn-actions');
  const show = open ?? pop.classList.contains('hidden');
  pop.classList.toggle('hidden', !show); btn.setAttribute('aria-expanded', String(show));
  if (show) renderActions();
}
$('#btn-actions')?.addEventListener('click', e => { e.stopPropagation(); toggleActions(); });
document.addEventListener('pointerdown', e => {
  const pop = $('#actions-pop');
  if (!pop.classList.contains('hidden') && !pop.contains(e.target) && e.target.id !== 'btn-actions') toggleActions(false);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') toggleActions(false); });
let teamMeetTimer = null;
document.querySelectorAll('#actions-pop [data-act]').forEach(b => b.addEventListener('click', () => {
  const list = actionTargets(), a = list.find(x => x.id === acState.agent) || list[0];
  if (!office || !a) return;
  const act = b.dataset.act;
  if (act === 'bell') ringFor(a, 'manual', '');
  else if (act === 'coffee') { if (!office.coffeeBreak(a.id, 6)) toast(`${a.name} כבר בדרך`); }
  else if (act === 'stretch') { if (!office.micro(a.id, 'stretch')) toast(`${a.name} לא יושב/ת כרגע`); }
  else if (act === 'celebrate') office.celebrate(a.id);
  else if (act === 'chat') {
    const others = list.filter(x => x.id !== a.id);
    if (!others.length) { toast('צריך לפחות שני סוכנים בחדר'); return; }
    const b2 = others[Math.floor(Math.random() * others.length)];
    if (mode === 'demo') demoChat([a, b2]);
    else office.converse({ participants: [a.id, b2.id], lines: [{ agent: a.id, text: `${b2.name}, רגע? ☕` }, { agent: b2.id, text: 'בטח!' }, { agent: a.id, text: '🙂' }] });
  }
  else if (act === 'meeting') {
    office.gatherAll(); clearTimeout(teamMeetTimer);
    toast('ישיבת צוות על השטיח', { icon: 'users' });
    teamMeetTimer = setTimeout(() => office.disperseAll(), 9000);
  }
  else if (act === 'home') { clearTimeout(teamMeetTimer); office.disperseAll(); }
  else if (act === 'life') { life.on = !life.on; LS.set('life', life.on ? '1' : '0'); renderActions(); }
  if (act !== 'life') toggleActions(false);
}));
document.querySelectorAll('#ac-time [data-time]').forEach(b => b.addEventListener('click', () => {
  acState.time = b.dataset.time;
  office?.setTime(b.dataset.time === 'real' ? null : b.dataset.time);
  renderActions(); renderStrip();
}));

setPill();
boot();
