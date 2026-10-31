// main.js — UI, roster, live ingestion (WS + polling), demo simulation, feed, KPIs, chart.
import { createOffice } from './office.js?v=10';

/* ---------------- roster: data-driven, fetched from roster.json ---------------- */
const FALLBACK_ROSTER = { agents: [
  { id:'noa', name:'נועה', role:'סוכנת לידים', handle:'noa', color:'#7aa2f7', skin:'#f2c9a4', hair:'#5a3d28', longHair:true, kinds:[['lead.new','ליד חדש נכנס','+1'],['lead.qualified','ליד סומן כמתאים','+1']] },
  { id:'maya', name:'מאיה', role:'סוכנת מכירות', handle:'maya', color:'#ef87a8', skin:'#e8b48c', hair:'#2c2320', longHair:true, kinds:[['quote.sent','הצעת מחיר נשלחה','#'],['deal.won','עסקה נסגרה!','₪']] },
  { id:'itay', name:'איתי', role:'סוכן שירות', handle:'itay', color:'#57c98a', skin:'#f2c9a4', hair:'#3a2a1c', longHair:false, kinds:[['call.done','שיחת שירות הסתיימה','min'],['ticket.closed','פנייה נסגרה','#']] },
  { id:'dani', name:'דני', role:'סוכן גבייה', handle:'dani', color:'#f2a65a', skin:'#d9a077', hair:'#1f1a16', longHair:false, kinds:[['payment.received','תשלום התקבל','₪'],['invoice.sent','חשבונית הופקה','#']] },
  { id:'shira', name:'שירה', role:'סוכנת תוכן', handle:'shira', color:'#b085e8', skin:'#f2c9a4', hair:'#8a5a2b', longHair:true, kinds:[['post.draft','טיוטת פוסט מוכנה','+1'],['post.published','פוסט פורסם','+1']] },
  { id:'omer', name:'עומר', role:'סוכן פרסום', handle:'omer', color:'#5ecfd6', skin:'#c98e63', hair:'#24201c', longHair:false, kinds:[['ad.report','דוח קמפיין נבנה','+1'],['campaign.tuned','קמפיין כוונן','CTR']] },
]};

let AGENTS = [];
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
    const r = await fetch('./roster.json?v=10');
    if (!r.ok) throw new Error('roster ' + r.status);
    const d = await r.json();
    if (!Array.isArray(d.agents) || !d.agents.length) throw new Error('empty roster');
    return d.agents;
  } catch (e) {
    console.warn('roster fallback:', e.message);
    return FALLBACK_ROSTER.agents;
  }
}

async function boot() {
  $('#boot-error').classList.add('hidden');
  try {
    bootSet(15, 'טוען מנוע תלת־ממד…');
    await delay(100);
    bootSet(35, 'קורא סגל סוכנים…');
    AGENTS = await loadRoster();
    bootSet(55, 'בונה את המשרד…');
    office = createOffice($('#scene'), AGENTS, { onSelect: id => selectAgent(id, true) });
    bootSet(85, 'מתחבר לערוץ החי…');
    connectLive();
    pollEvents(); // catch-up: show recent real events immediately
    bootSet(100, 'מוכן!');
    setTimeout(() => $('#boot').classList.add('hidden'), 250);
    startSim();
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
function enterLiveMode() {
  if (mode === 'live') return;
  mode = 'live';
  clearTimeout(simTimer);
  toast('⚡ המשרד עבר למצב חי — מגיעים אירועים אמיתיים');
  setPill();
}
function enterDemoMode() {
  mode = 'demo';
  paused = false;
  scheduleNext();
  setPill();
  toast('חזרנו למצב דמו (סימולציה)');
}
$('#live-pill').addEventListener('click', () => {
  if (mode === 'live') enterDemoMode();
  else { mode = 'live'; clearTimeout(simTimer); setPill(); toast('מצב חי — ממתין לאירועים אמיתיים'); }
});

/* ---------------- KPIs ---------------- */
const kpis = {
  leads:   { label: 'לידים היום',   v: 0, money: false },
  quotes:  { label: 'הצעות מחיר',   v: 0, money: false },
  calls:   { label: 'שיחות שירות',  v: 0, money: false },
  revenue: { label: 'הכנסות (דמו)', v: 0, money: true  },
};
function renderKpis() {
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
function logLine(agent, kind, val, he) {
  const log = $('#log');
  const time = new Date().toLocaleTimeString('he-IL', { hour12: false });
  const div = document.createElement('div');
  div.className = 'log-line fresh';
  div.innerHTML = `<span class="log-time">[${time}]</span><span class="log-name" style="color:${agent.color}">${agent.handle}:</span> <span class="log-kind">${kind}</span> <span class="log-val">${val}</span> <span class="log-he">${he}</span>`;
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
  return AGENTS.find(x => x.id === idOrHandle || x.handle === idOrHandle);
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
  target.innerHTML = panelHtml(a);
  if (isMobile) $('#sheet').classList.remove('hidden');
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
    <div class="card-head" style="padding:0 0 8px"><h3>הסוכנים</h3><span class="muted">${AGENTS.length} פעילים</span></div>
    <div class="ag-list">${AGENTS.map(a => {
      const st = statOf(a.id);
      return `<div class="ag-item" data-id="${a.id}">
        <div class="ap-avatar" style="background:${a.color};width:34px;height:34px;font-size:.9rem">${(a.name || '?')[0]}</div>
        <div class="grow"><div style="font-weight:800;font-size:.88rem">${a.name} · <span class="muted">${a.role}${a.live ? ' ⚡' : ''}</span></div>
        <div class="ag-last">${st.last}</div></div>
        <span class="mono muted">${st.events}</span>
      </div>`;
    }).join('')}</div>`;
  document.querySelectorAll('.ag-item').forEach(el =>
    el.addEventListener('click', () => selectAgent(el.dataset.id)));
}
function refreshAgentViews(a) {
  if (selectedId === a.id && window.innerWidth > 900) renderPanel(a);
  if (selectedId === a.id && window.innerWidth <= 900 && !$('#sheet').classList.contains('hidden')) renderPanel(a);
  if (!selectedId) renderPanelDefault();
}
function updateWallScreen() {
  office.updateScreen(
    AGENTS.map(x => ({ v: statOf(x.id).events, color: x.color })),
    AGENTS.reduce((s, x) => s + statOf(x.id).events, 0));
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
  bumpKpisForKind(kind, val);
  if (/deal|payment|won|closed/.test(kind) && Math.random() < 0.9) office.celebrate(a.id);
  else if (Math.random() < 0.22) {
    office.walkTo(a.id, { x: -6.8, y: 0, z: 3.4 });
    st.state = 'walk';
    setTimeout(() => { office.goHome(a.id); st.state = 'typing'; refreshAgentViews(a); }, 2600);
  } else office.setState(a.id, 'typing');
  refreshAgentViews(a);
  updateWallScreen();
}

/* ---------------- live channel: WebSocket + polling fallback ---------------- */
let lastId = 0, ws = null, liveSeen = false;
function connectLive() {
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
    } catch {}
  };
  sock.onclose = () => { if (ws === sock) ws = null; setTimeout(connectLive, 5000); };
  sock.onerror = () => { try { sock.close(); } catch {} };
}
async function pollEvents() {
  try {
    const r = await fetch('./api/events?since=' + lastId);
    if (!r.ok) return;
    const d = await r.json();
    (d.events || []).forEach(onLiveEvent);
    if (typeof d.lastId === 'number') lastId = Math.max(lastId, d.lastId);
  } catch {}
}
setInterval(pollEvents, 7000); // catch-up; no-op when WS delivers first

function onLiveEvent(ev) {
  if (typeof ev.id === 'number') { if (ev.id <= lastId) return; lastId = ev.id; }
  enterLiveMode();
  liveSeen = true;
  let a = findAgent(ev.agent);
  if (!a) a = createLiveAgent(ev.agent);
  const he = ev.note || ev.kind;
  applyEventToOffice(a, ev.kind || 'event', ev.value || '', he);
}

function createLiveAgent(handle) {
  let h = 0;
  for (const c of String(handle)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const meta = {
    id: 'live-' + handle,
    name: String(handle),
    role: 'סוכן חי',
    handle: String(handle),
    color: LIVE_COLORS[h % LIVE_COLORS.length],
    skin: LIVE_SKINS[h % LIVE_SKINS.length],
    hair: LIVE_HAIRS[h % LIVE_HAIRS.length],
    longHair: h % 2 === 0,
    live: true,
    kinds: [],
  };
  AGENTS.push(meta);
  office.addAgent(meta);
  statOf(meta.id);
  renderPanelDefault();
  toast(`⚡ סוכן חדש עלה למשרד: ${handle}`);
  return meta;
}

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
