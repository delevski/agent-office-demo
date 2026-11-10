// The agent card: click / tap a person (3D body, name pill or 2D avatar) → one card with status, what they do now and for how
// long, the last five tasks, last seen and the open board tasks.  Pure model + html are tested directly; the click → person
// mapping is run for real against concept.js with a stub DOM; the wiring in main.js / css is checked on the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cardModel, cardHtml, clean, safeLink, durHe, whenHe, actorBox, hitTest, placeCard, MIN_TAP, RECENT_MAX, STATUS_LABEL } from '../agent-card.js';

const root = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
const main = read('main.js'), concept = read('concept.js'), css = read('concept.css'), html = read('index.html'), card = read('agent-card.js');
const roster = JSON.parse(read('roster.json'));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NOW = new Date(2026, 10, 9, 21, 0, 0).getTime(), MIN = 60_000, HOUR = 3600_000;
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

// the demo board exactly as main.js seeds it from roster.json (demoBoard)
const demoBoard = a => { const sb = a.demoBoard; return { doing: sb.doing ? sb.doing.title : null, doingSince: sb.doing ? NOW - (sb.doing.ago || 3) * MIN : 0, todo: sb.todo.map(x => x.title), todoWhen: Object.fromEntries(sb.todo.map(x => [x.title, x.when || ''])), done: sb.done.map((d, k) => ({ title: d.title, ended: NOW - (k + 1) * 9 * MIN, at: d.at })) }; };

test('demo mode: every demo character (hermessi, Claudi, Gepeta, Grocki, Gemino, Deepsi) gets a full card from the demo board', () => {
  assert.deepEqual(roster.agents.map(a => a.name), ['hermessi', 'Claudi', 'Gepeta', 'Grocki', 'Gemino', 'Deepsi']);
  for (const a of roster.agents) {
    const b = demoBoard(a), m = cardModel({ agent: a, status: 'working', demo: b, now: NOW }), h = cardHtml(m, { esc, emblem: '<svg></svg>' });
    assert.equal(m.name, a.name); assert.equal(m.role, a.role); assert.equal(m.status, 'working'); assert.equal(m.statusLabel, 'עובד עכשיו');
    assert.ok(m.current && m.current.title, a.name + ' has a current task (the next queued one when nothing is running yet)');
    for (const part of [a.name, a.role, 'דמו', 'עובד עכשיו', 'משימות אחרונות', 'משימות פתוחות בלוח', 'נראה לאחרונה', m.current.title]) assert.ok(text(h).includes(part), a.name + ' card shows ' + part);
  }
  const gem = roster.agents.find(a => a.id === 'gemino'), m = cardModel({ agent: gem, status: 'working', demo: demoBoard(gem), now: NOW });
  assert.equal(m.current.title, 'תיקון הפניה אחרי כניסה'); assert.equal(m.current.running, '25 דק׳', 'how long it has been running'); assert.equal(m.current.clock, '20:35');
  assert.deepEqual(m.recent.map(r => r.title), ['דוח קמפיין שבועי']); assert.equal(m.recent[0].status, 'done');
  assert.equal(m.lastSeenLabel, 'עכשיו');
  const dee = roster.agents.find(a => a.id === 'deepsi'), md = cardModel({ agent: dee, status: 'idle', demo: demoBoard(dee), now: NOW });
  assert.equal(md.status, 'idle'); assert.equal(md.current, null); assert.deepEqual(md.open.map(o => o.title), ['עדכון מדריך ה-API']); assert.equal(md.open[0].when, 'יום ד׳');
});

test('four statuses with their dot: working, idle, sleeping (night, seated, not working), offline', () => {
  const a = roster.agents[1], d = demoBoard(a);
  assert.equal(cardModel({ agent: a, status: 'working', sleeping: true, demo: d, now: NOW }).status, 'working', 'a working agent never shows as asleep');
  assert.equal(cardModel({ agent: a, status: 'idle', sleeping: true, demo: d, now: NOW }).status, 'sleeping');
  assert.equal(cardModel({ agent: a, status: 'idle', demo: d, now: NOW }).status, 'idle');
  assert.equal(cardModel({ agent: { ...a, live: true }, status: 'idle', view: null, now: NOW }).status, 'offline', 'a live agent that never reported is offline');
  for (const k of ['working', 'idle', 'sleeping', 'offline']) assert.ok(STATUS_LABEL[k]);
  assert.match(cardHtml(cardModel({ agent: a, status: 'idle', sleeping: true, demo: d, now: NOW }), { esc }), /במצב שינה/);
  // the dot is styled per status
  for (const k of ['working', 'idle', 'sleeping', 'offline', 'blocked']) assert.ok(css.includes(`.oc-card[data-st="${k}"] .oc-dot`), k);
});

const live = { id: 'tab', name: 'Tab', role: 'עוזר אישי', color: '#f7b84d', live: true };
const view = {
  id: 'tab', name: 'Tab', status: 'working', hasData: true, lastSeen: NOW - 40_000, activity: { text: 'מריץ טסטים' },
  current: { title: 'LeadFlow /site ghp_abcdefghijklmnop1234 עדכון', since: NOW - 17 * MIN, link: 'https://github.com/delevski/leadflow-mvp/pull/64?token=SECRET123#x' },
  usageToday: { tokens: 987654, cost: 12.5, messages: 3 }, config: { model: 'model-x', tools: ['bash'], skills: ['s'] }, budget: { limit: 5 }, meter: { pct: 80 },
  tasks: [
    { id: 't1', title: 'PR #13', status: 'done', ended: NOW - 2 * HOUR }, { id: 't2', title: 'בדיקת OG', status: 'failed', ended: NOW - 30 * MIN },
    { id: 't3', title: 'ריל', status: 'done', ended: NOW - 5 * HOUR }, { id: 't4', title: 'כרטיס בלוח', status: 'queued', since: NOW - 9 * MIN },
    { id: 't5', title: 'סקירת PR', status: 'blocked', since: NOW - 20 * MIN }, { id: 't6', title: 'a', status: 'done', ended: NOW - 26 * HOUR },
    { id: 't7', title: 'b', status: 'done', ended: NOW - 27 * HOUR }, { id: 't8', title: 'c', status: 'done', ended: NOW - 28 * HOUR }, { id: 't9', title: 'עובד כעת', status: 'running', since: NOW - 17 * MIN },
  ],
};

test('live mode: current task and how long, last 5 finished (done or failed, newest first, with when), last seen, open board tasks', () => {
  const m = cardModel({ agent: live, status: 'working', view, now: NOW });
  assert.equal(m.current.running, '17 דק׳'); assert.equal(m.current.activity, 'מריץ טסטים');
  assert.equal(m.recent.length, RECENT_MAX);
  assert.deepEqual(m.recent.map(r => r.title), ['בדיקת OG', 'PR #13', 'ריל', 'a', 'b']);
  assert.deepEqual(m.recent.map(r => r.status), ['failed', 'done', 'done', 'done', 'done']);
  assert.deepEqual(m.recent.map(r => r.whenLabel), ['לפני 30 דק׳', 'היום 19:00', 'היום 16:00', 'אתמול 19:00', 'אתמול 18:00']);
  assert.deepEqual(m.open.map(o => [o.title, o.status]), [['כרטיס בלוח', 'queued'], ['סקירת PR', 'blocked']], 'queued and blocked board tasks of this agent');
  assert.equal(m.lastSeenLabel, 'עכשיו');
  const h = text(cardHtml(m, { esc }));
  for (const s of ['בדיקת OG', 'PR #13', 'כרטיס בלוח', 'סקירת PR', 'בתור', 'תקוע', 'בעבודה כבר 17 דק׳']) assert.ok(h.includes(s), s);
  assert.match(cardHtml(m, { esc }), /class="oc-failed"/);
});

test('never shows tokens or secrets: key-like strings are masked, links lose their query, usage / model / config are not on the card', () => {
  const m = cardModel({ agent: live, status: 'working', view, now: NOW }), h = cardHtml(m, { esc });
  assert.ok(!/ghp_|SECRET123|987654|model-x|bash|token=/.test(h), h);
  assert.ok(h.includes('•••'));
  assert.match(h, /href="https:\/\/github\.com\/delevski\/leadflow-mvp\/pull\/64"/);
  assert.equal(clean('Bearer abcdef0123456789xyz'), '•••'); assert.equal(clean('api_key=abc123'), '•••'); assert.equal(clean('sk-abcdefghijkl1234'), '•••');
  assert.equal(clean('x'.repeat(300)).length, 120);
  assert.equal(safeLink('javascript:alert(1)'), ''); assert.equal(safeLink('https://a.b/c?d=e'), 'https://a.b/c');
  const evil = cardHtml(cardModel({ agent: { ...live, name: '<img onerror=x>' }, status: 'working', view: { ...view, current: { title: '"><script>x</script>' } }, now: NOW }), { esc });
  assert.ok(!/<script|<img/.test(evil), 'html-escaped');
});

test('offline / not reported yet: a calm card, no invented data', () => {
  const m = cardModel({ agent: live, status: 'working', view: { id: 'tab', hasData: false }, now: NOW });
  assert.equal(m.status, 'offline'); assert.equal(m.current, null); assert.equal(m.lastSeenLabel, 'עוד לא דיווח');
  const h = text(cardHtml(m, { esc }));
  assert.ok(h.includes('לא מחובר כרגע') && h.includes('עוד אין משימות שהסתיימו') && h.includes('אין משימות פתוחות בלוח'));
});

test('time words', () => {
  assert.equal(durHe(20_000), 'פחות מדקה'); assert.equal(durHe(12 * MIN), '12 דק׳'); assert.equal(durHe(HOUR + 5 * MIN), '1 שע׳ 5 דק׳'); assert.equal(durHe(2 * HOUR), '2 שע׳'); assert.equal(durHe(50 * HOUR), '2 ימים');
  assert.equal(whenHe(NOW - 5_000, NOW), 'עכשיו'); assert.equal(whenHe(NOW - 7 * MIN, NOW), 'לפני 7 דק׳'); assert.equal(whenHe(NOW - 26 * HOUR, NOW), 'אתמול 19:00'); assert.equal(whenHe(NOW - 5 * 24 * HOUR, NOW), '4/11');
});

/* ---------- click → person ---------- */
test('hit boxes: at least 44 px each way, the nearer person wins an overlap, a miss is null', () => {
  const tiny = actorBox('a', { x: 100, y: 100 }, { x: 100, y: 110 });
  assert.ok(tiny.x1 - tiny.x0 >= MIN_TAP && tiny.y1 - tiny.y0 >= MIN_TAP);
  const far = actorBox('far', { x: 200, y: 100 }, { x: 200, y: 200 }), near = actorBox('near', { x: 220, y: 150 }, { x: 220, y: 260 });
  assert.equal(hitTest([far, near], 210, 190), 'near', 'overlap → the one lower on the picture (in front)');
  assert.equal(hitTest([far, near], 200, 120), 'far');
  assert.equal(hitTest([far, near], 600, 600), null);
  assert.ok(actorBox('fb', { x: 50, y: 50 }, { x: 50, y: 80 }, { extraBottom: 30 }).y1 >= 80 + 30, 'the 2D avatar is inside its box');
});

test('placeCard: a bottom sheet on phones; on desktop beside the person, inside the room, away from other people', () => {
  assert.deepEqual(placeCard({ anchor: { x: 500, y: 300 }, W: 390, H: 800, cw: 340, ch: 300, mobile: true }), { mode: 'sheet' });
  const others = [{ x0: 150, y0: 250, x1: 250, y1: 450 }];
  const p = placeCard({ anchor: { x: 500, y: 300 }, W: 1200, H: 800, cw: 340, ch: 300, mobile: false, avoid: others });
  assert.equal(p.mode, 'float'); assert.ok(p.left >= 0 && p.left + 340 <= 1200 && p.top >= 0 && p.top + 300 <= 800);
  assert.ok(!(500 >= p.left && 500 <= p.left + 340 && 300 >= p.top && 300 <= p.top + 300), 'does not sit on the person');
  assert.ok(p.left + 340 <= 150 || p.left >= 250 || p.top + 300 <= 250 || p.top >= 450, 'does not cover the other person');
  const edge = placeCard({ anchor: { x: 1180, y: 790 }, W: 1200, H: 800, cw: 340, ch: 300, mobile: false });
  assert.ok(edge.left + 340 <= 1200 && edge.top + 300 <= 800);
});

test('concept.js maps a click on a person, a name pill or a 2D avatar to that person, and a click on empty room to nothing', async () => {
  const mk = () => ({ children: [], dataset: {}, style: { setProperty() {}, }, classList: { add() {}, remove() {}, contains: () => false }, _html: '', offsetWidth: 120, handlers: {},
    appendChild(c) { this.children.push(c); return c; }, insertBefore(c) { this.children.push(c); return c; }, remove() {}, setAttribute() {},
    addEventListener(t, f) { (this.handlers[t] ||= []).push(f); }, getBoundingClientRect() { return { left: 0, top: 0, width: 1440, height: 900 }; },
    querySelector(sel) { return (this._q ||= {})[sel] ||= mk(); },
    querySelectorAll(sel) { if (sel === '.cv-tag') return [...this._html.matchAll(/data-id="([^"]+)"/g)].map(m => Object.assign(mk(), { dataset: { id: m[1] } })); return []; },
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; }, clientWidth: 1440, clientHeight: 900 });
  const el = mk(), g = globalThis, saved = {};
  const stubs = { document: { hidden: true, body: mk(), documentElement: mk(), createElement: () => mk(), addEventListener() {} }, window: {}, matchMedia: () => ({ matches: false }), ResizeObserver: class { observe() {} }, IntersectionObserver: class { observe() {} },
    requestAnimationFrame: cb => setTimeout(() => cb(performance.now()), 5), Image: class { decode() { return Promise.resolve(); } } };
  for (const [k, v] of Object.entries(stubs)) { saved[k] = Object.getOwnPropertyDescriptor(g, k); Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); }
  try {
    const { createConcept } = await import('../concept.js');
    const picks = [];
    const cv = createConcept(el, { forceFallback: true, esc, onPick: (id, pt) => picks.push([id, !!pt && typeof pt.x === 'number']) });
    cv.setCast(roster.agents); await new Promise(r => setTimeout(r, 80));
    assert.equal(cv.fallback, true);
    const boxes = cv.boxes(); assert.equal(boxes.length, 6);
    for (const b of boxes) {
      assert.ok(b.x1 - b.x0 >= MIN_TAP && b.y1 - b.y0 >= MIN_TAP, b.id + ' tap target ≥ 44px');
      assert.equal(cv.pickAt(b.cx, b.cy), b.id, b.id + ': the middle of its box picks it');
      el.handlers.click[0]({ clientX: b.cx, clientY: b.cy, target: { closest: () => null } });
    }
    assert.deepEqual(picks.map(p => p[0]), roster.agents.map(a => a.id).sort((a, b) => boxes.findIndex(x => x.id === a) - boxes.findIndex(x => x.id === b)), 'one pick per click, the right person');
    assert.ok(picks.every(p => p[1]), 'the card gets the person\'s position');
    picks.length = 0;
    el.handlers.click[0]({ clientX: 5, clientY: 5, target: { closest: () => null } });
    assert.deepEqual(picks, [[null, false]], 'empty room → null (the card closes)');
    el.handlers.click[0]({ clientX: 5, clientY: 5, target: { closest: () => ({ dataset: { id: 'claudi' } }) } });
    assert.equal(picks[1][0], 'claudi', 'a name pill is a target of its own');
    assert.equal(cv.isSleeping('claudi'), false);
    assert.ok(cv.anchorOf('gemino') && typeof cv.anchorOf('gemino').x === 'number');
  } finally {
    stubs.document.hidden = true; await new Promise(r => setTimeout(r, 40));
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(g, k, d); else delete g[k]; }
  }
});

/* ---------- wiring ---------- */
test('wiring: one card at a time, closes on X / Esc / tap outside, switches on another character; reuses the dashboard data', () => {
  assert.match(main, /onPick: \(id, pt\) => \{ if \(id\) openAgentCard\(id, pt\); else closeAgentCard\(\); \}/);
  assert.equal((main.match(/createElement\('aside'\)/g) || []).length, 1, 'a single card element is reused (created on first use)');
  assert.match(main, /e\.key === 'Escape'\) closeAgentCard\(\)/); assert.match(main, /closest\('\.oc-x'\)\) closeAgentCard\(\)/);
  assert.match(main, /document\.addEventListener\('pointerdown', onAcDown, true\)/); assert.match(main, /document\.removeEventListener\('pointerdown', onAcDown, true\)/);
  assert.match(main, /cv\.pickAt\(e\.clientX, e\.clientY\)\) return;\s*\n\s*closeAgentCard\(\)/, 'a tap on another person switches instead of closing');
  // data: the same sources as the panel and the board
  assert.match(main, /liveState\.get\(a\.id\)/); assert.match(main, /demoBoard\.get\(a\.id\)/); assert.match(main, /sceneStatus\(liveState\.get\(a\.id\)\)/); assert.match(main, /cv\.isSleeping\(a\.id\)/);
  assert.match(main, /refreshAgentCard\(a\.id\)/, 'a live update re-renders the open card');
  assert.match(main, /clearInterval\(acTimer\)/, 'the 15 s clock tick stops with the card');
  assert.doesNotMatch(main.slice(main.indexOf('function agentCardModel'), main.indexOf('function initConcept')), /fetch\(|apiGet\(/, 'no new API');
});

test('light: no per-frame work for the card; hit tests run on pointer events only; no new libraries', () => {
  assert.doesNotMatch(card, /requestAnimationFrame|setInterval|setTimeout|document\.|window\./, 'agent-card.js is pure');
  const tick = concept.slice(concept.indexOf('function tick('), concept.indexOf('function kick('));
  assert.doesNotMatch(tick, /pickAt|boxes\(|hitTest|actorBox/, 'the frame loop never hit-tests');
  assert.match(concept, /root\.addEventListener\('click'/); assert.match(concept, /e\.pointerType !== 'mouse' \|\| e\.timeStamp - hoverT < 60/, 'hover cursor: mouse only, throttled');
  assert.doesNotMatch(read('index.html'), /<script[^>]+src="https?:/, 'no CDN scripts');
});

test('look: glass card, pointer cursor, 44px close target, bottom sheet on phones, RTL', () => {
  assert.match(css, /\.cv-tag\{cursor:pointer\}/);
  const oc = css.match(/\.oc-card\{[^}]*\}/)[0];
  assert.match(oc, /backdrop-filter:blur\(40px\) saturate\(180%\)/); assert.match(oc, /direction:rtl/);
  assert.match(css, /\.oc-x\{[^}]*width:44px;height:44px/);
  assert.match(css, /@media \(max-width:900px\)\{\s*\.oc-card\{left:0;right:0;bottom:0/, 'bottom sheet');
  assert.match(css, /prefers-reduced-motion: reduce\)\{ \.oc-card\{transition:none\}/);
  assert.match(css, /\.cv-tag::before\{content:"";position:absolute;inset:-8px -4px\}/, 'finger-sized pill');
});

test('cache-busting: new module versions in the import chain', () => {
  assert.match(html, /main\.js\?v=30/); assert.match(html, /concept\.css\?v=3/);
  assert.match(main, /concept\.js\?v=5/); assert.match(main, /agent-card\.js\?v=1/); assert.match(concept, /agent-card\.js\?v=1/);
});
