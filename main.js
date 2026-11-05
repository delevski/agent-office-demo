// main.js — UI, roster, live ingestion (WS + polling), demo simulation, feed, KPIs, chart,
// Ori's login and the per-agent live panel.
import { createOffice } from './office.js?v=21';
import { emblemSVG } from './emblems.js';
import { agentAlert, alertLabel, durationHe, reviewTrend, severityCounts, ALERT_AFTER_MIN, SEVERITIES } from './insights.js?v=21';

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
  { id:'noa', name:'נועה', role:'סוכנת לידים', handle:'noa', color:'#7aa2f7', skin:'#f2c9a4', hair:'#5a3d28', longHair:true, kinds:[['lead.new','ליד חדש נכנס','+1'],['lead.qualified','ליד סומן כמתאים','+1']] },
  { id:'maya', name:'מאיה', role:'סוכנת מכירות', handle:'maya', color:'#ef87a8', skin:'#e8b48c', hair:'#2c2320', longHair:true, kinds:[['quote.sent','הצעת מחיר נשלחה','#'],['deal.won','עסקה נסגרה!','₪']] },
  { id:'itay', name:'איתי', role:'סוכן שירות', handle:'itay', color:'#57c98a', skin:'#f2c9a4', hair:'#3a2a1c', longHair:false, kinds:[['call.done','שיחת שירות הסתיימה','min'],['ticket.closed','פנייה נסגרה','#']] },
  { id:'dani', name:'דני', role:'סוכן גבייה', handle:'dani', color:'#f2a65a', skin:'#d9a077', hair:'#1f1a16', longHair:false, kinds:[['payment.received','תשלום התקבל','₪'],['invoice.sent','חשבונית הופקה','#']] },
  { id:'shira', name:'שירה', role:'סוכנת תוכן', handle:'shira', color:'#b085e8', skin:'#f2c9a4', hair:'#8a5a2b', longHair:true, kinds:[['post.draft','טיוטת פוסט מוכנה','+1'],['post.published','פוסט פורסם','+1']] },
  { id:'omer', name:'עומר', role:'סוכן פרסום', handle:'omer', color:'#5ecfd6', skin:'#c98e63', hair:'#24201c', longHair:false, kinds:[['ad.report','דוח קמפיין נבנה','+1'],['campaign.tuned','קמפיין כוונן','CTR']] },
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
    const r = await fetch('./roster.json?v=21');
    if (!r.ok) throw new Error('roster ' + r.status);
    const d = await r.json();
    if (!Array.isArray(d.agents) || !d.agents.length) throw new Error('empty roster');
    return d;
  } catch (e) {
    console.warn('roster fallback:', e.message);
    return FALLBACK_ROSTER;
  }
}

async function boot() {
  $('#boot-error').classList.add('hidden');
  try {
    bootSet(15, 'טוען מנוע תלת־ממד…');
    await delay(100);
    bootSet(35, 'קורא סגל סוכנים…');
    const doc = await loadRoster();
    AGENTS = doc.agents;
    bootSet(55, 'בונה את המשרד…');
    // canvas textures (name tags, board, shelves) need the Hebrew webfont before they are drawn
    try { await Promise.race([Promise.all(['800 40px Heebo', '900 40px Heebo', '600 28px Heebo'].map(f => document.fonts.load(f))), delay(2500)]); } catch { /* fallback font */ }
    office = createOffice($('#scene'), AGENTS, {
      onSelect: id => { if (!SHOWCASE) selectAgent(id, true); },
      onBoard: () => { if (!SHOWCASE) openBoard(); },
      onShelf: () => { if (!SHOWCASE) openShelves(); },
      onFrame: simFrame,
    }, { showcase: SHOWCASE, capture: CAPTURE, adaptive: QS.get('quality') !== 'fixed', loopSeconds: Number(QS.get('loop')) || 12 });
    window.__office = office;
    if (!SHOWCASE) (doc.live || []).forEach(meta => addLiveCharacter({ ...meta, live: true }));
    initDemoBoard();
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
function toast(msg, { err = false, retry = null } = {}) {
  if (SHOWCASE) return;
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
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
  AGENTS.forEach(a => office.setVisible(a.id, mode === 'demo'));
  LIVE.forEach(a => office.setVisible(a.id, mode === 'live'));
  document.body.classList.toggle('is-live', mode === 'live');
  $('#badge-mode').textContent = mode === 'live' ? 'חי' : 'דמו';
  $('#chart-sub').textContent = '30 הדקות האחרונות · ' + (mode === 'live' ? 'חי' : 'דמו');
  $('#log-sub').textContent = mode === 'live' ? 'אירועים אמיתיים שהסוכנים מדווחים' : 'טבלת דמו · כל שורה מזיזה דמות';
  $('#foot-demo').classList.toggle('hidden', mode === 'live');
  $('#foot-live').classList.toggle('hidden', mode !== 'live');
  if (office) refreshAlerts();
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
  if (!quiet) toast('⚡ מצב חי — הסוכנים האמיתיים שלך');
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
  leads:   { label: 'לידים היום',   v: 0, money: false },
  quotes:  { label: 'הצעות מחיר',   v: 0, money: false },
  calls:   { label: 'שיחות שירות',  v: 0, money: false },
  revenue: { label: 'הכנסות (דמו)', v: 0, money: true  },
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
  const n = parseInt(String(val).replace(/[^\d]/g, ''), 10) || 0;
  if (/^lead/.test(kind)) bumpKpi('leads', 1);
  else if (/^(quote|deal)/.test(kind)) { bumpKpi('quotes', 1); if (/deal/.test(kind) && n) bumpKpi('revenue', n); }
  else if (/^(call|ticket|support)/.test(kind)) bumpKpi('calls', 1);
  else if (/^(payment|invoice|charge)/.test(kind) && n) bumpKpi('revenue', n);
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
  feedCount.n++;
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
    <div class="ap-actions"><button class="btn btn-gold" id="ap-focus" type="button">🎯 מיקוד במשרד</button></div>`;
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
        <div class="grow"><div style="font-weight:800;font-size:.88rem">${a.name} · <span class="muted">${a.role}${a.live ? ' ⚡' : ''}</span></div>
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
function updateWallScreen() {
  const list = roster();
  office.updateScreen(
    list.map(x => ({ v: statOf(x.id).events, color: x.color })),
    list.reduce((s, x) => s + statOf(x.id).events, 0));
}

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
  c.strokeStyle = '#f5b301'; c.lineWidth = 2 * dpr; c.beginPath();
  chartData.forEach((v, i) => {
    const x = W - (i + 0.5) / chartData.length * W;
    const y = H - 6 * dpr - (v / max) * (H - 16 * dpr);
    i ? c.lineTo(x, y) : c.moveTo(x, y);
  });
  c.stroke();
  c.fillStyle = '#f5b30122';
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
  if (/deal|payment|won|closed|task\.done|published/.test(kind) && Math.random() < 0.9) office.celebrate(a.id);
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
  if (!auth.loggedIn || mode !== 'live') return;
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
  if (!auth.loggedIn) return;
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
  if (mode !== 'live') return;
  const a = liveAgentFor(ev.agent);
  applyEventToOffice(a, ev.kind || 'event', ev.value || '', ev.note || ev.kind);
}

const SCENE_STATE = { working: 'typing', idle: 'idle', blocked: 'idle', offline: 'idle' };
function sceneStatus(view) { return !view || !view.hasData ? 'offline' : (['working', 'idle', 'blocked', 'offline'].includes(view.status) ? view.status : 'idle'); }
function onAgentUpdate(view, { quiet = false } = {}) {
  if (!view || !view.id) return;
  const a = liveAgentFor(view.id, view.name);
  liveState.set(a.id, view);
  const st = statOf(a.id);
  st.state = SCENE_STATE[view.status] || 'typing';
  st.events = Math.max(st.events, view.events || 0);
  if (view.current?.title) st.last = view.current.title;
  office.setStatus(a.id, sceneStatus(view));
  applyAlert(a);
  refreshWorld();
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
  office.addAgent(meta);
  office.setStatus(meta.id, sceneStatus(liveState.get(meta.id)));
  office.setVisible(meta.id, mode === 'live');
  statOf(meta.id);
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
  if (mode === 'live') { renderPanelDefault(); toast(`⚡ סוכן חדש עלה למשרד: ${meta.name}`); }
  return meta;
}

/* ---------------- live agent panel ---------------- */
const STATUS_HE = { working: 'עובד עכשיו', idle: 'פנוי', blocked: 'תקוע · ממתין', offline: 'לא מחובר' };
const TASK_ICON = { running: '⏳', done: '✅', failed: '❌', blocked: '⛔', queued: '🗂️' };
const TASK_HE = { running: 'בעבודה', done: 'הושלם', failed: 'נכשל', blocked: 'תקוע', queued: 'בתור' };
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
function hhmm(ts) { return new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false }); }
function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'עכשיו';
  if (s < 3600) return `לפני ${Math.round(s / 60)} דק׳`;
  if (s < 86400) return `לפני ${Math.round(s / 3600)} שע׳`;
  return new Date(ts).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
}
function when(ts) {
  if (!ts) return '';
  return Date.now() - ts < 86400_000 ? hhmm(ts) : new Date(ts).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
}
function statusOf(v) { return !v || !v.hasData ? 'nodata' : v.status; }
function liveCountLabel() {
  const on = LIVE.filter(a => { const v = liveState.get(a.id); return v && v.hasData && v.status !== 'offline'; }).length;
  return `${on} מחוברים מתוך ${LIVE.length}`;
}
function liveListItem(a) {
  const v = liveState.get(a.id);
  const st = statusOf(v);
  const line = st === 'nodata' ? 'אין נתונים עדיין' : v.current?.title ? v.current.title : (STATUS_HE[st] + (v.lastSeen ? ' · ' + ago(v.lastSeen) : ''));
  const al = alertOf(v);
  return `<div class="ag-item${al ? ' ag-alert' : ''}" data-id="${esc(a.id)}" role="button" tabindex="0">
    <span class="ap-emblem sm">${emblemSVG(a, 36)}</span>
    <div class="grow"><div style="font-weight:800;font-size:.88rem">${esc(a.name)} · <span class="muted">${esc(a.role)}</span></div>
    <div class="ag-last">${esc(line)}</div></div>
    ${al ? `<span class="st-chip st-alert" title="${esc(alertTitle(al))}">⚠ ${esc(alertLabel(al))}</span>`
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
  const focus = `<div class="ap-actions"><button class="btn btn-gold" id="ap-focus" type="button">🎯 מיקוד במשרד</button></div>`;
  if (st === 'nodata') {
    return head + `<div class="ap-nodata"><b>אין נתונים עדיין.</b> ${esc(a.name)} עוד לא דיווח למשרד. ברגע שיגיע הדיווח הראשון יופיעו כאן העבודה הנוכחית, המשימות, השימוש והיכולות שלו.</div>` + focus;
  }
  const cur = v.current;
  const currentHtml = cur?.title
    ? `<div class="ap-current">${safeUrl(cur.link) ? `<a href="${safeUrl(cur.link)}" target="_blank" rel="noopener">${esc(cur.title)} ↗</a>` : `<span>${esc(cur.title)}</span>`}
         ${cur.since ? `<div class="muted">מאז ${when(cur.since)} · ${ago(cur.since)}</div>` : ''}</div>`
    : `<div class="ap-current ap-current-none">${st === 'offline' ? 'לא מחובר כרגע' : 'אין משימה פעילה כרגע'}</div>`;
  const u = v.usageToday;
  const has = f => u && u[f] !== undefined;
  const usageHtml = u
    ? `<div class="u-grid">
        ${usageTile('הודעות', has('messages') ? fmtNum(u.messages) : '—')}
        ${usageTile('טוקנים', has('tokens') ? fmtNum(u.tokens) : '—')}
        ${usageTile('עלות', has('cost') ? fmtCost(u.cost) : '—')}
        ${usageTile('משימות', has('tasks') ? fmtNum(u.tasks) : '—')}
      </div>${has('pct_of_quota') ? `<div class="u-quota"><span style="width:${Math.min(100, u.pct_of_quota)}%"></span></div><div class="muted">${fmtNum(u.pct_of_quota)}% מהמכסה היומית</div>` : ''}
      ${u.updated ? `<div class="muted ap-upd">דווח ${ago(u.updated)}</div>` : ''}`
    : `<div class="ap-empty-line">לא דווח שימוש היום</div>`;
  const tasks = v.tasks || [];
  const tasksHtml = tasks.length
    ? `<ul class="ap-tasks">${tasks.slice(0, 8).map(t => `
        <li title="${TASK_HE[t.status] || ''}"><span class="t-ico" aria-label="${TASK_HE[t.status] || ''}">${TASK_ICON[t.status] || '•'}</span>
          <span class="grow">${safeUrl(t.link) ? `<a href="${safeUrl(t.link)}" target="_blank" rel="noopener">${esc(t.title || t.id)}</a>` : esc(t.title || t.id)}</span>
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
  const alertHtml = al ? `<div class="al-card" role="alert"><b>⚠ ${al.kind === 'stuck' ? 'תקוע' : 'שקט'} ${esc(durationHe(al.minutes))}</b> <span>${esc(alertTitle(al))}</span></div>` : '';
  return head + alertHtml + `
    <div class="ap-seen muted">דיווח אחרון ${ago(v.lastSeen)}</div>
    <section class="ap-sec"><h4>עובד עכשיו על</h4>${currentHtml}</section>
    <section class="ap-sec"><h4>7 ימים אחרונים</h4>${historyHtml(v.history7)}</section>
    <section class="ap-sec"><h4>שימוש היום</h4>${usageHtml}</section>
    ${agentReviewsHtml(a)}
    <section class="ap-sec"><h4>משימות אחרונות</h4>${tasksHtml}</section>
    <section class="ap-sec"><h4>יכולות</h4>${configHtml}</section>` + focus;
}


/* ---------------- 3. stuck / silent alerts ---------------- */
const alertShown = new Map(); // id -> alert kind already toasted
function alertOf(v) { return v ? agentAlert(v, Date.now()) : null; }
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
    <div class="al-title">⚠ ${list.length === 1 ? 'סוכן אחד דורש תשומת לב' : `${list.length} סוכנים דורשים תשומת לב`}</div>
    ${list.map(({ a, al }) => `<div class="al-row" data-id="${esc(a.id)}" role="button" tabindex="0">
      <span class="ap-emblem sm">${emblemSVG(a, 26, { title: false })}</span>
      <span class="grow"><b>${esc(a.name)}</b> · ${al.kind === 'stuck' ? 'תקוע' : 'שקט'} ${esc(durationHe(al.minutes))}${al.task ? ` · <span class="muted">${esc(al.task)}</span>` : ''}</span>
    </div>`).join('')}
  </div>`;
}
function applyAlert(a) {
  const al = mode === 'live' ? alertOf(liveState.get(a.id)) : null;
  office.setAlert(a.id, al ? { kind: al.kind, label: alertLabel(al) } : null);
  if (al && alertShown.get(a.id) !== al.kind && mode === 'live') toast(`⚠ ${a.name}: ${al.kind === 'stuck' ? 'תקוע' : 'שקט'} ${durationHe(al.minutes)}`, { err: true });
  if (al) alertShown.set(a.id, al.kind); else alertShown.delete(a.id);
  return al;
}
function refreshAlerts() {
  if (!office) return;
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
const VERDICT_HE = { approved: ['אושר', '✅', 'v-ok'], changes_requested: ['נדרשו תיקונים', '🔁', 'v-chg'], commented: ['הערות', '💬', 'v-com'] };
const SEV_HE = { critical: 'קריטי', high: 'גבוה', medium: 'בינוני', low: 'נמוך', nit: 'ניטפיק' };
async function loadReviews() {
  if (!auth.loggedIn || mode !== 'live') return;
  try { const d = await apiGet('./api/reviews'); if (d) { reviews = d.reviews || []; afterReviews(); } } catch (e) { console.warn(e); }
}
function onReview(r) {
  if (mode !== 'live') return;
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
    <button class="btn btn-ghost rv-open" id="ap-reviews" type="button">🔍 כל הביקורות</button></section>`;
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
let changesToday = [], changesDay = '';
const CHANGE_ICON = { 'pr.merged': '🔀', deploy: '🚀', 'task.done': '✅' };
async function loadChanges() {
  if (!auth.loggedIn || mode !== 'live') return;
  try { const d = await apiGet('./api/changes'); if (d) { changesToday = d.changes || []; changesDay = d.day || ''; renderChanges(); } } catch (e) { console.warn(e); }
}
function todayKey() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date()); }
function onChange(c) {
  if (mode !== 'live') return;
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
  return `<b>הושלם</b> ${esc(c.title)}`;
}
function renderChanges() {
  const el = $('#changes-list'); if (!el) return;
  const counts = { 'pr.merged': 0, deploy: 0, 'task.done': 0 };
  changesToday.forEach(c => { if (counts[c.type] !== undefined) counts[c.type]++; });
  $('#changes-sub').textContent = changesToday.length ? `${counts['pr.merged']} מיזוגים · ${counts.deploy} פריסות · ${counts['task.done']} משימות` : 'היום';
  if (!changesToday.length) { el.innerHTML = `<div class="ch-empty">עוד לא השתנה כלום היום. מיזוגים, פריסות ומשימות שנסגרו יופיעו כאן.</div>`; return; }
  el.innerHTML = changesToday.map(c => {
    const a = agentMeta(c.merged_by || c.agent);
    const body = changeLine(c);
    return `<li class="ch-item ch-${c.type.replace('.', '-')}">
      <span class="ch-time">${esc(hhmm(c.ts))}</span><span class="ch-ico" aria-hidden="true">${CHANGE_ICON[c.type] || '•'}</span>
      <span class="grow">${safeUrl(c.link) ? `<a href="${safeUrl(c.link)}" target="_blank" rel="noopener">${body}</a>` : body}
        <span class="ch-by" style="color:${esc(a.color)}">${esc(a.name)}</span></span></li>`;
  }).join('');
}
setInterval(() => { if (mode === 'live') { loadChanges(); loadReviews(); } }, 60_000);

/* ---------------- login (Ori only) ---------------- */
async function checkAuth() {
  try {
    const r = await fetch('./api/me', { credentials: 'same-origin', cache: 'no-store' });
    if (r.ok) Object.assign(auth, await r.json().then(d => ({ loggedIn: !!d.loggedIn, configured: !!d.loginConfigured })));
  } catch { /* static preview: no API -> demo only */ }
  renderAuthButton();
}
function renderAuthButton() {
  const b = $('#btn-login');
  b.innerHTML = auth.loggedIn ? '🔓 יציאה' : '🔒 כניסה';
  b.setAttribute('aria-label', auth.loggedIn ? 'יציאה מהמשרד החי' : 'כניסה למשרד החי');
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
    return '🔒 כניסה';
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

// The simulation runs on the 3D scene's clock (office onFrame), so it pauses with the tab,
// honours the speed button, and steps deterministically when frames are captured for video.
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
    return paused ? '▶ הפעל' : '⏸ השהה';
  });
});
$('#btn-speed').addEventListener('click', e => {
  const btn = e.currentTarget;
  withBusy(btn, 'משנה…', async () => {
    await delay(250);
    speed = speed === 1 ? 2 : speed === 2 ? 4 : 1;
    if (!paused) scheduleNext();
    return `מהירות ×${speed}`;
  });
});
function startMeeting(auto = false) {
  meetingActive = true; meetingDone = true;
  if (window.innerWidth <= 900) switchView('view-scene');
  toast(auto ? 'ישיבת בוקר אוטומטית — הסוכנים מתאספים ☕' : 'הסוכנים מתאספים לישיבת בוקר ☕');
  office.gatherAll();
  AGENTS.forEach(a => { statOf(a.id).state = 'meeting'; });
  renderPanelDefault();
  simAfter(7, () => {
    office.disperseAll();
    AGENTS.forEach(a => { statOf(a.id).state = 'typing'; });
    meetingActive = false;
    toast('ישיבת הבוקר הסתיימה — חזרו לעבוד 💪');
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
$('#scene-retry').addEventListener('click', () => location.reload());

/* ---------------- the world: kanban board + skills shelves (3D + readable 2D overlays) ---------------- */
// Demo board: each demo character works through its own clearly-labelled sample tasks.
const demoBoard = new Map(); // id -> {todo:[], doing:null, done:[{title, ended}]}
function initDemoBoard() {
  const now = Date.now();
  AGENTS.forEach((a, i) => {
    const t = (a.demoTasks || []).slice();
    if (!t.length) return;
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
  b.doing = b.todo.shift() || null;
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
      b.todo.forEach(title => cols.todo.push({ title, agent: a, status: 'queued' }));
      if (b.doing) cols.doing.push({ title: b.doing, agent: a, status: 'running', when: 'עכשיו' });
      b.done.forEach(d => cols.done.push({ title: d.title, agent: a, status: 'done', ts: d.ended, when: when(d.ended) }));
    }
    cols.done.sort((x, y) => y.ts - x.ts);
    return { demo: true, columns: cols, updated: Date.now() };
  }
  // live: only what the agents reported (task.start / task.done / task.failed / task.queued)
  const cols = { todo: [], doing: [], done: [] };
  for (const a of LIVE) {
    const v = liveState.get(a.id);
    for (const t of v?.tasks || []) {
      const card = { title: t.title || t.id, agent: a, status: t.status, link: t.link, ts: t.ended || t.since || 0 };
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
  const sig = JSON.stringify([bd.demo, Object.values(bd.columns).map(c => c.map(x => x.title + x.agent.id + x.status))]);
  if (sig !== lastBoardSig) { lastBoardSig = sig; office.updateBoard(bd); if (!$('#board-ov').classList.contains('hidden')) renderBoardOverlay(); }
  const rows = shelfRows();
  const ssig = JSON.stringify(rows.map(r => [r.meta.id, r.skills, r.nodata]));
  if (ssig !== lastShelfSig) { lastShelfSig = ssig; office.updateShelves(rows); if (!$('#shelf-ov').classList.contains('hidden')) renderShelfOverlay(); }
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
  $('#board-ov-sub').textContent = bd.demo ? 'דמו · משימות לדוגמה, לא נתונים אמיתיים' : 'חי · משימות שהסוכנים דיווחו על עצמם';
  const names = { todo: 'לביצוע', doing: 'בעבודה', done: 'הושלם' };
  $('#board-ov-cols').innerHTML = ['todo', 'doing', 'done'].map(k => {
    const list = bd.columns[k];
    return `<section class="kb-col kb-${k}" aria-label="${names[k]}">
      <h4><span class="kb-dot"></span>${names[k]} <span class="kb-count">${list.length}</span></h4>
      ${list.length ? list.map(c => `<article class="kb-card" style="--ac:${esc(c.agent.color)}">
        <span class="kb-emb">${emblemSVG(c.agent, 30, { title: false })}</span>
        <div class="grow"><div class="kb-title">${safeUrl(c.link) ? `<a href="${safeUrl(c.link)}" target="_blank" rel="noopener">${esc(c.title)}</a>` : esc(c.title)}</div>
        <div class="kb-meta">${esc(c.agent.name)}${c.status === 'failed' ? ' · <b class="kb-fail">נכשל</b>' : c.status === 'blocked' ? ' · ממתין' : ''}${c.when ? ' · ' + esc(c.when) : ''}</div></div>
      </article>`).join('') : `<div class="kb-empty">${esc(bd.empty?.[k] || '—')}</div>`}
    </section>`;
  }).join('');
}
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
$('#btn-board').addEventListener('click', () => { office?.focusBoard(); openBoard(); });
$('#btn-shelves').addEventListener('click', () => { office?.focusShelf(); openShelves(); });
$('#btn-reviews').addEventListener('click', () => openReviews(null));
$('#btn-zoomin').addEventListener('click', () => office?.zoomBy(0.75));
$('#btn-zoomout').addEventListener('click', () => office?.zoomBy(1.33));
document.addEventListener('keydown', e => { if (e.key === 'Tab') document.body.classList.add('kbd'); });
document.addEventListener('pointerdown', () => document.body.classList.remove('kbd'));
$('#scene').addEventListener('keydown', e => {
  if (e.key === '+' || e.key === '=') { office?.zoomBy(0.8); e.preventDefault(); }
  else if (e.key === '-' || e.key === '_') { office?.zoomBy(1.25); e.preventDefault(); }
  else if (e.key === '0') { office?.resetCam(); e.preventDefault(); }
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

setPill();
boot();
