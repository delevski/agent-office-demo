// main.js — UI, mock realtime simulation, feed, KPIs, chart. All data is fictional demo data.
import { createOffice } from './office.js?v=9';

/* ---------------- demo agents (fictional) ---------------- */
const AGENTS = [
  { id: 'noa',   name: 'נועה',  role: 'סוכנת לידים',    handle: 'noa',   color: '#7aa2f7', colorHex: 0x7aa2f7, skin: 0xf2c9a4, hair: 0x5a3d28, longHair: true,
    kinds: [ ['lead.new', 'ליד חדש נכנס', () => '+1'], ['lead.qualified', 'ליד סומן כמתאים', () => '+1'] ] },
  { id: 'maya',  name: 'מאיה',  role: 'סוכנת מכירות',   handle: 'maya',  color: '#ef87a8', colorHex: 0xef87a8, skin: 0xe8b48c, hair: 0x2c2320, longHair: true,
    kinds: [ ['quote.sent', 'הצעת מחיר נשלחה', () => '#' + rnd(40, 99)], ['deal.won', 'עסקה נסגרה!', () => '₪' + (rnd(3, 18) * 500).toLocaleString('he-IL')] ] },
  { id: 'itay',  name: 'איתי',  role: 'סוכן שירות',     handle: 'itay',  color: '#57c98a', colorHex: 0x57c98a, skin: 0xf2c9a4, hair: 0x3a2a1c, longHair: false,
    kinds: [ ['call.done', 'שיחת שירות הסתיימה', () => rnd(2, 14) + 'min'], ['ticket.closed', 'פנייה נסגרה', () => '#' + rnd(100, 999)] ] },
  { id: 'dani',  name: 'דני',   role: 'סוכן גבייה',     handle: 'dani',  color: '#f2a65a', colorHex: 0xf2a65a, skin: 0xd9a077, hair: 0x1f1a16, longHair: false,
    kinds: [ ['payment.received', 'תשלום התקבל', () => '₪' + (rnd(2, 40) * 100).toLocaleString('he-IL')], ['invoice.sent', 'חשבונית הופקה', () => '#' + rnd(1000, 1999)] ] },
  { id: 'shira', name: 'שירה',  role: 'סוכנת תוכן',     handle: 'shira', color: '#b085e8', colorHex: 0xb085e8, skin: 0xf2c9a4, hair: 0x8a5a2b, longHair: true,
    kinds: [ ['post.draft', 'טיוטת פוסט מוכנה', () => '+1'], ['post.published', 'פוסט פורסם', () => '+1'] ] },
  { id: 'omer',  name: 'עומר',  role: 'סוכן פרסום',     handle: 'omer',  color: '#5ecfd6', colorHex: 0x5ecfd6, skin: 0xc98e63, hair: 0x24201c, longHair: false,
    kinds: [ ['ad.report', 'דוח קמפיין נבנה', () => '+1'], ['campaign.tuned', 'קמפיין כוונן', () => 'CTR ' + rnd(1, 6) + '.' + rnd(0, 9) + '%'] ] },
];
const STATE_HE = { typing: 'עובד/ת במחשב', walk: 'זז/ה במשרד', idle: 'בהפסקה', celebrate: 'חוגג/ת 🎉', meeting: 'בישיבת בוקר' };

function rnd(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function $(sel) { return document.querySelector(sel); }

/* ---------------- boot with progress + retry ---------------- */
const bootFill = $('#boot-fill'), bootStep = $('#boot-step');
function bootSet(pct, text) { bootFill.style.width = pct + '%'; bootStep.textContent = text; }

let office = null;
function initOffice() {
  return new Promise((resolve, reject) => {
    try {
      bootSet(35, 'בונה את המשרד…');
      const canvas = $('#scene');
      office = createOffice(canvas, AGENTS, { onSelect: id => selectAgent(id, true) });
      bootSet(75, 'מעסיק סוכנים…');
      resolve();
    } catch (e) { reject(e); }
  });
}

async function boot() {
  $('#boot-error').classList.add('hidden');
  try {
    bootSet(15, 'טוען מנוע תלת־ממד…');
    await new Promise(r => setTimeout(r, 120));
    await initOffice();
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

/* ---------------- busy wrapper: loader + double-click guard + error/retry toast ---------------- */
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
const agentStats = new Map(AGENTS.map(a => [a.id, { events: 0, last: '—', state: 'typing' }]));

function panelHtml(a) {
  const st = agentStats.get(a.id);
  return `
    <div class="ap-head">
      <div class="ap-avatar" style="background:${a.color}">${a.name[0]}</div>
      <div><div class="ap-name">${a.name}</div><div class="ap-role">${a.role} · דמו</div></div>
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
function selectAgent(id, fromScene = false) {
  selectedId = id;
  const a = AGENTS.find(x => x.id === id);
  if (!a) return;
  office.focus(id);
  renderPanel(a);
  if (fromScene && window.innerWidth <= 900) { /* sheet opens over scene */ }
}
$('#sheet-close').addEventListener('click', () => $('#sheet').classList.add('hidden'));

/* desktop side panel default content */
function renderPanelDefault() {
  $('#agent-panel').innerHTML = `
    <div class="card-head" style="padding:0 0 8px"><h3>הסוכנים</h3><span class="muted">${AGENTS.length} פעילים · דמו</span></div>
    <div class="ag-list">${AGENTS.map(a => {
      const st = agentStats.get(a.id);
      return `<div class="ag-item" data-id="${a.id}">
        <div class="ap-avatar" style="background:${a.color};width:34px;height:34px;font-size:.9rem">${a.name[0]}</div>
        <div class="grow"><div style="font-weight:800;font-size:.88rem">${a.name} · <span class="muted">${a.role}</span></div>
        <div class="ag-last">${st.last}</div></div>
        <span class="mono muted">${st.events}</span>
      </div>`;
    }).join('')}</div>`;
  document.querySelectorAll('.ag-item').forEach(el =>
    el.addEventListener('click', () => selectAgent(el.dataset.id)));
}

/* ---------------- chart: events per minute ---------------- */
const chartData = Array.from({ length: 30 }, () => rnd(0, 5)); // fictional demo history
function drawChart() {
  const cv = $('#chart');
  const dpr = Math.min(window.devicePixelRatio, 2);
  const W = cv.clientWidth * dpr, H = 90 * dpr;
  if (cv.width !== W) { cv.width = W; cv.height = H; }
  const c = cv.getContext('2d');
  c.clearRect(0, 0, W, H);
  const max = Math.max(4, ...chartData);
  c.strokeStyle = '#f5b301'; c.lineWidth = 2 * dpr; c.beginPath();
  chartData.forEach((v, i) => {
    const x = W - (i + 0.5) / chartData.length * W;      // RTL: newest on the left
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

/* ---------------- simulation engine ---------------- */
let paused = false, speed = 1, simTimer = null, meetingActive = false;

function pickAgent() {
  const weights = [3, 2, 2, 2, 1, 1]; // noa busiest, like a leads agent
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < AGENTS.length; i++) { r -= weights[i]; if (r <= 0) return AGENTS[i]; }
  return AGENTS[0];
}

function fireEvent() {
  if (meetingActive) return;
  const a = pickAgent();
  const [kind, he, valFn] = a.kinds[rnd(0, a.kinds.length - 1)];
  const val = valFn();
  logLine(a, kind, val, he);
  chartData[0]++;
  const st = agentStats.get(a.id);
  st.events++; st.last = he;
  // KPI routing
  if (kind === 'lead.new' || kind === 'lead.qualified') bumpKpi('leads', 1);
  if (kind === 'quote.sent') bumpKpi('quotes', 1);
  if (kind === 'deal.won') { bumpKpi('quotes', 1); bumpKpi('revenue', parseInt(val.replace(/[^\d]/g, ''), 10) || 0); }
  if (kind === 'call.done' || kind === 'ticket.closed') bumpKpi('calls', 1);
  if (kind === 'payment.received') bumpKpi('revenue', parseInt(val.replace(/[^\d]/g, ''), 10) || 0);
  // animate the character — a new row moves the character
  if (kind === 'deal.won' || kind === 'payment.received') office.celebrate(a.id);
  else if (Math.random() < 0.25) {
    // short walk: get coffee, come back
    office.walkTo(a.id, { x: -6.8, y: 0, z: 3.4 });
    st.state = 'walk';
    setTimeout(() => { office.goHome(a.id); st.state = 'typing'; refreshAgentViews(a); }, 2600);
  } else office.setState(a.id, 'typing');
  refreshAgentViews(a);
  // wall screen
  office.updateScreen(AGENTS.map(x => ({ v: agentStats.get(x.id).events, color: x.color })), [...agentStats.values()].reduce((s, x) => s + x.events, 0));
}

function refreshAgentViews(a) {
  if (selectedId === a.id && window.innerWidth > 900) renderPanel(a);
  if (selectedId === a.id && window.innerWidth <= 900 && !$('#sheet').classList.contains('hidden')) renderPanel(a);
  if (!selectedId && window.innerWidth > 900) renderPanelDefault();
}

function scheduleNext() {
  clearTimeout(simTimer);
  if (paused) return;
  simTimer = setTimeout(() => { fireEvent(); scheduleNext(); }, rnd(1800, 4200) / speed);
}
function startSim() {
  // opening burst so the office is alive immediately
  office.updateScreen(AGENTS.map(x => ({ v: 0, color: x.color })), 0);
  let burst = 0;
  const b = setInterval(() => { fireEvent(); if (++burst >= 5) clearInterval(b); }, 450);
  setTimeout(scheduleNext, 3000);
  // one automatic morning meeting shortly after load — the reel's signature shot
  setTimeout(() => { if (!meetingDone && !paused) startMeeting(true); }, 18000);
}

/* ---------------- controls ---------------- */
$('#btn-pause').addEventListener('click', e => {
  const btn = e.currentTarget;
  withBusy(btn, paused ? 'מפעיל…' : 'משהה…', async () => {
    await delay(300);
    paused = !paused;
    btn.setAttribute('aria-pressed', String(paused));
    $('#live-pill').classList.toggle('paused', paused);
    $('#live-pill').lastChild.textContent = paused ? ' Realtime · מושהה' : ' Realtime · חי (דמו)';
    if (paused) clearTimeout(simTimer); else scheduleNext();
    if (selectedId) renderPanel(AGENTS.find(x => x.id === selectedId));
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
let meetingDone = false;
function startMeeting(auto = false) {
  meetingActive = true; meetingDone = true;
  if (window.innerWidth <= 900) switchView('view-scene');
  toast(auto ? 'ישיבת בוקר אוטומטית — הסוכנים מתאספים ☕' : 'הסוכנים מתאספים לישיבת בוקר ☕');
  office.gatherAll();
  AGENTS.forEach(a => { agentStats.get(a.id).state = 'meeting'; });
  if (!selectedId && window.innerWidth > 900) renderPanelDefault();
  setTimeout(() => {
    office.disperseAll();
    AGENTS.forEach(a => { agentStats.get(a.id).state = 'typing'; });
    meetingActive = false;
    toast('ישיבת הבוקר הסתיימה — חזרו לעבוד 💪');
    if (selectedId) renderPanel(AGENTS.find(x => x.id === selectedId));
  }, 7000);
}
$('#btn-meeting').addEventListener('click', e => {
  const btn = e.currentTarget;
  if (meetingActive) return;
  withBusy(btn, 'מזמן…', async () => {
    await delay(350);          // "scheduling" step with visible loader
    startMeeting(false);
  });
});
$('#btn-resetcam').addEventListener('click', e => {
  withBusy(e.currentTarget, 'מאפס…', async () => { await delay(200); office.unfocus(); office.resetCam(); selectedId = null; if (window.innerWidth > 900) renderPanelDefault(); });
});
$('#scene-retry').addEventListener('click', () => location.reload());

/* ---------------- mobile tabs ---------------- */
function switchView(id) {
  $('#sheet').classList.add('hidden');
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === id));
  document.querySelectorAll('.navbtn').forEach(b => b.classList.toggle('active', b.dataset.view === id));
  if (id === 'view-feed') { feedCount.n = 0; $('#feed-pill').textContent = '0'; }
  if (id === 'view-agents' && !selectedId) renderPanelDefaultMobile();
  drawChart();
}
function renderPanelDefaultMobile() {
  // reuse list inside agent-panel for the agents tab on mobile
  renderPanelDefault();
}
document.querySelectorAll('.navbtn').forEach(b =>
  b.addEventListener('click', () => {
    // tab switch shows a quick loader state on the button
    const btn = b;
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    const ico = btn.querySelector('.ico');
    const orig = ico.textContent;
    ico.innerHTML = '<span class="spin"></span>';
    setTimeout(() => { ico.textContent = orig; delete btn.dataset.busy; switchView(btn.dataset.view); }, 180);
  }));

/* default view on mobile */
if (window.innerWidth <= 900) switchView('view-scene');
else renderPanelDefault();

/* keep desktop panel fresh */
setInterval(() => { if (window.innerWidth > 900 && !selectedId) renderPanelDefault(); }, 5000);

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

boot();
