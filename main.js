// main.js — UI, roster, live ingestion (WS + polling), demo simulation, feed, KPIs, chart,
// Ori's login and the per-agent live panel.
import { createOffice } from './office.js?v=11';

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
    const r = await fetch('./roster.json?v=11');
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
    office = createOffice($('#scene'), AGENTS, { onSelect: id => selectAgent(id, true) });
    (doc.live || []).forEach(meta => addLiveCharacter({ ...meta, live: true }));
    bootSet(85, 'בודק כניסה…');
    await checkAuth();
    bootSet(100, 'מוכן!');
    setTimeout(() => $('#boot').classList.add('hidden'), 250);
    if (auth.loggedIn) enterLiveMode({ quiet: true });
    else startSim();
  } catch (e) {
    console.error(e);
    bootStep.textContent = 'שגיאה בטעינה';
    $('#boot-error').classList.remove('hidden');
  }
}
$('#boot-retry').addEventListener('click', boot);

/* ---------------- busy wrapper + toasts ---------------- */
function toast(msg, { err = false, retry = null } = {}) {
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
  connectLive();
  if (!quiet) toast('⚡ מצב חי — הסוכנים האמיתיים שלך');
}
function enterDemoMode() {
  mode = 'demo';
  paused = false;
  showCast();
  resetBoard();
  scheduleNext();
  setPill();
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
      <div class="ap-avatar" style="background:${a.color}">${(a.name || '?')[0]}</div>
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
    <div class="ag-list">${roster().map(a => {
      if (a.live) return liveListItem(a);
      const st = statOf(a.id);
      return `<div class="ag-item" data-id="${a.id}">
        <div class="ap-avatar" style="background:${a.color};width:34px;height:34px;font-size:.9rem">${(a.name || '?')[0]}</div>
        <div class="grow"><div style="font-weight:800;font-size:.88rem">${a.name} · <span class="muted">${a.role}${a.live ? ' ⚡' : ''}</span></div>
        <div class="ag-last">${st.last}</div></div>
        <span class="mono muted">${st.events}</span>
      </div>`;
    }).join('')}</div>`;
  document.querySelectorAll('.ag-item').forEach(el => {
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
  if (/deal|payment|won|closed|task\.done/.test(kind) && Math.random() < 0.9) office.celebrate(a.id);
  else if (Math.random() < 0.22) {
    office.walkTo(a.id, { x: -6.8, y: 0, z: 3.4 });
    st.state = 'walk';
    setTimeout(() => { office.goHome(a.id); st.state = 'typing'; refreshAgentViews(a); }, 2600);
  } else office.setState(a.id, 'typing');
  refreshAgentViews(a);
  updateWallScreen();
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
function onAgentUpdate(view, { quiet = false } = {}) {
  if (!view || !view.id) return;
  const a = liveAgentFor(view.id, view.name);
  liveState.set(a.id, view);
  const st = statOf(a.id);
  st.state = SCENE_STATE[view.status] || 'typing';
  st.events = Math.max(st.events, view.events || 0);
  if (view.current?.title) st.last = view.current.title;
  if (mode === 'live') office.setState(a.id, st.state);
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
const TASK_ICON = { running: '⏳', done: '✅', failed: '❌', blocked: '⛔' };
const TASK_HE = { running: 'בעבודה', done: 'הושלם', failed: 'נכשל', blocked: 'תקוע' };
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
  return `<div class="ag-item" data-id="${esc(a.id)}" role="button" tabindex="0">
    <div class="ap-avatar" style="background:${a.color};width:34px;height:34px;font-size:.9rem">${esc((a.name || '?')[0])}</div>
    <div class="grow"><div style="font-weight:800;font-size:.88rem">${esc(a.name)} · <span class="muted">${esc(a.role)}</span></div>
    <div class="ag-last">${esc(line)}</div></div>
    <span class="st-chip st-${st}"><span class="dot"></span>${st === 'nodata' ? 'אין נתונים' : STATUS_HE[st]}</span>
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
      <div class="ap-avatar" style="background:${a.color}">${esc((a.name || '?')[0])}</div>
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
  return head + `
    <div class="ap-seen muted">דיווח אחרון ${ago(v.lastSeen)}</div>
    <section class="ap-sec"><h4>עובד עכשיו על</h4>${currentHtml}</section>
    <section class="ap-sec"><h4>שימוש היום</h4>${usageHtml}</section>
    <section class="ap-sec"><h4>משימות אחרונות</h4>${tasksHtml}</section>
    <section class="ap-sec"><h4>יכולות</h4>${configHtml}</section>` + focus;
}

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

function scheduleNext() {
  clearTimeout(simTimer);
  if (paused || mode !== 'demo') return;
  simTimer = setTimeout(() => { fireEvent(); scheduleNext(); }, rnd(1800, 4200) / speed);
}
function startSim() {
  updateWallScreen();
  let burst = 0;
  const b = setInterval(() => { fireEvent(); if (++burst >= 5) clearInterval(b); }, 450);
  setTimeout(scheduleNext, 3000);
  setTimeout(() => { if (!meetingDone && !paused && mode === 'demo') startMeeting(true); }, 18000);
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
  setTimeout(() => {
    office.disperseAll();
    AGENTS.forEach(a => { statOf(a.id).state = 'typing'; });
    meetingActive = false;
    toast('ישיבת הבוקר הסתיימה — חזרו לעבוד 💪');
    if (selectedId) renderPanel(findAgent(selectedId));
  }, 7000);
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
