// server/agents.js — per-agent live state for the Agent Office (pure functions, no I/O).
// The Durable Object (worker.js -> EventHub) keeps one state object per agent and runs every
// accepted report through applyReport(). Kept pure so it is unit-tested with `node --test`.

export const OFFLINE_AFTER_MS = 10 * 60 * 1000;   // no report for 10 min -> shown as offline
export const MAX_TASKS = 30;                       // recent tasks kept per agent
export const USAGE_DAYS = 14;                      // daily usage history kept per agent
export const STATUSES = ['working', 'idle', 'blocked', 'offline'];
export const USAGE_FIELDS = ['messages', 'tokens', 'cost', 'tasks', 'calls', 'pct_of_quota'];
const TASK_STATUSES = ['running', 'done', 'failed', 'blocked'];

/* ---------------- sanitizers ---------------- */
export function str(v, n) {
  return String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
}
export function agentId(v) {
  return str(v, 40).toLowerCase();
}
export function link(v) {
  const s = str(v, 500);
  return /^https?:\/\/\S+$/i.test(s) ? s : '';
}
function num(v) {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
function list(v, maxItems = 50, maxLen = 60) {
  if (typeof v === 'string') v = v.split(',');
  if (!Array.isArray(v)) return undefined;
  const out = [];
  for (const x of v) {
    const s = str(typeof x === 'object' && x ? (x.name ?? x.id ?? '') : x, maxLen);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}
function time(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) && t > 0 ? t : fallback;
}
/** YYYY-MM-DD in the office's time zone (Ori is in Israel). */
export function dayOf(ts, tz = 'Asia/Jerusalem') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}
function cleanTask(t, now) {
  if (!t || typeof t !== 'object') return null;
  const title = str(t.title ?? t.name, 160);
  const id = str(t.id, 80);
  if (!title && !id) return null;
  return { id, title, link: link(t.link ?? t.ref ?? t.url), since: time(t.since ?? t.started ?? t.started_at, now) };
}
function cleanUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const out = {};
  for (const k of USAGE_FIELDS) { const n = num(u[k]); if (n !== undefined) out[k] = n; }
  return Object.keys(out).length ? out : null;
}
function cleanConfig(c) {
  if (!c || typeof c !== 'object') return null;
  const out = {};
  const model = str(c.model, 60); if (model) out.model = model;
  const skills = list(c.skills); if (skills) out.skills = skills;
  const tools = list(c.tools); if (tools) out.tools = tools;
  const models = list(c.models, 10); if (models) out.models = models;
  const description = str(c.description, 300); if (description) out.description = description;
  return Object.keys(out).length ? out : null;
}

/* ---------------- report normalization ---------------- */
// One report = one POST body. Fields may be nested ("usage": {...}) or flat at the top level,
// so small reporters (curl, hooks) can send whatever is simplest for them.
const KIND_ALIASES = {
  'task.started': 'task.start', 'task.begin': 'task.start',
  'task.completed': 'task.done', 'task.finished': 'task.done', 'task.ok': 'task.done',
  'task.error': 'task.failed',
};
export function normalizeReport(body, now = Date.now()) {
  body = body && typeof body === 'object' ? body : {};
  let kind = str(body.kind ?? body.type, 40) || 'event';
  kind = KIND_ALIASES[kind] || kind;
  const r = {
    agent: agentId(body.agent),
    name: str(body.name ?? body.config?.name, 40), // optional display name
    kind,
    value: str(body.value, 60),
    note: str(body.note, 140),
    ts: now,
  };
  if (STATUSES.includes(body.status)) r.status = body.status;
  const task = cleanTask(body.task ?? body.current, now);
  if (task) r.task = task;
  if (kind === 'usage' || kind === 'heartbeat') {
    const u = cleanUsage(body.usage ?? body);
    if (u) r.usage = u;
    r.mode = body.mode === 'add' ? 'add' : 'set';
    r.day = /^\d{4}-\d{2}-\d{2}$/.test(body.day ?? '') ? body.day : dayOf(now);
  }
  if (kind === 'config' || kind === 'heartbeat') {
    const c = cleanConfig(body.config ?? body.capabilities ?? body);
    if (c) r.config = c;
  }
  if (kind === 'heartbeat' && Array.isArray(body.recent)) {
    r.recent = body.recent.slice(0, MAX_TASKS).map(t => {
      const ct = cleanTask(t, now);
      if (!ct) return null;
      const res = String(t.result ?? t.status ?? 'ok');
      ct.status = /fail|error/.test(res) ? 'failed' : /block/.test(res) ? 'blocked' : /run|progress/.test(res) ? 'running' : 'done';
      ct.ended = ct.status === 'running' ? undefined : time(t.done_at ?? t.ended ?? t.ended_at, now);
      return ct;
    }).filter(Boolean);
  }
  if (kind === 'task.done' || kind === 'task.failed') {
    if (body.status === 'failed' || kind === 'task.failed') r.taskStatus = 'failed';
    else if (body.status === 'blocked') r.taskStatus = 'blocked';
    else r.taskStatus = 'done';
  }
  return r;
}

/** Does this report belong in the public event feed / animate the scene? */
export function isFeedEvent(r) {
  return !['usage', 'config', 'heartbeat'].includes(r.kind);
}

/** Hebrew one-liner for the event log when the reporter sent no note. */
export function feedNote(r) {
  if (r.note) return r.note;
  const t = r.task?.title || '';
  if (r.kind === 'task.start') return t ? `התחיל: ${t}` : 'התחיל משימה';
  if (r.kind === 'task.done') return (r.taskStatus === 'failed' ? 'נכשל: ' : 'סיים: ') + t;
  if (r.kind === 'task.failed') return t ? `נכשל: ${t}` : 'משימה נכשלה';
  if (r.kind === 'status') return { working: 'עובד', idle: 'פנוי', blocked: 'תקוע — מחכה למשהו', offline: 'התנתק' }[r.status] || 'עדכון סטטוס';
  return r.kind;
}

/* ---------------- state ---------------- */
export function emptyAgent(id, now = Date.now()) {
  return { id, name: '', status: 'idle', current: null, tasks: [], usage: {}, config: null, events: 0, firstSeen: now, lastSeen: 0 };
}

function upsertTask(a, t) {
  const i = a.tasks.findIndex(x => (t.id && x.id === t.id) || (!t.id && t.title && x.title === t.title && x.status === 'running'));
  if (i >= 0) a.tasks[i] = { ...a.tasks[i], ...Object.fromEntries(Object.entries(t).filter(([, v]) => v !== '' && v !== undefined)) };
  else a.tasks.unshift(t);
  a.tasks.sort((x, y) => (y.ended || y.since || 0) - (x.ended || x.since || 0));
  if (a.tasks.length > MAX_TASKS) a.tasks.length = MAX_TASKS;
}

function setUsage(a, day, usage, mode, now) {
  const prev = a.usage[day] || {};
  const next = { ...prev };
  for (const [k, v] of Object.entries(usage)) next[k] = mode === 'add' ? Math.round(((prev[k] || 0) + v) * 1e6) / 1e6 : v;
  next.updated = now;
  a.usage[day] = next;
  const days = Object.keys(a.usage).sort();
  while (days.length > USAGE_DAYS) delete a.usage[days.shift()];
}

/** Apply one normalized report to an agent state (returns a new object). */
export function applyReport(prev, r, now = Date.now()) {
  const a = structuredClone(prev || emptyAgent(r.agent, now));
  a.lastSeen = now;
  if (r.name) a.name = r.name;
  if (isFeedEvent(r)) a.events = (a.events || 0) + 1;

  switch (r.kind) {
    case 'task.start': {
      const t = r.task || { id: '', title: r.note || 'משימה', link: '', since: now };
      if (!t.id) t.id = 't' + now.toString(36);
      a.current = { id: t.id, title: t.title, link: t.link, since: t.since };
      upsertTask(a, { ...t, status: 'running' });
      a.status = 'working';
      break;
    }
    case 'task.done':
    case 'task.failed': {
      const t = r.task || (a.current ? { ...a.current } : null);
      const status = TASK_STATUSES.includes(r.taskStatus) ? r.taskStatus : 'done';
      if (t) {
        const match = a.tasks.find(x => (t.id && x.id === t.id) || (!t.id && x.title === t.title));
        upsertTask(a, { ...(match || {}), ...t, id: t.id || match?.id || 't' + now.toString(36), since: match?.since || t.since, status, ended: now });
        if (a.current && ((t.id && a.current.id === t.id) || (!t.id && a.current.title === t.title))) a.current = null;
      }
      if (!a.current) a.status = r.status || 'idle';
      break;
    }
    case 'status': {
      if (r.status) a.status = r.status;
      if (r.task) a.current = { id: r.task.id, title: r.task.title, link: r.task.link, since: r.task.since };
      else if (r.status === 'idle' || r.status === 'offline') a.current = null;
      break;
    }
    case 'usage':
      if (r.usage) setUsage(a, r.day, r.usage, r.mode, now);
      break;
    case 'config':
      if (r.config) a.config = { ...(a.config || {}), ...r.config, updated: now };
      break;
    case 'heartbeat': {
      if (r.status) a.status = r.status;
      if (r.task) a.current = { id: r.task.id, title: r.task.title, link: r.task.link, since: r.task.since };
      else if (r.status && r.status !== 'working') a.current = null;
      for (const t of r.recent || []) upsertTask(a, { ...t, id: t.id || 'h' + (t.ended || now).toString(36) + t.title.length });
      if (r.usage) setUsage(a, r.day, r.usage, 'set', now);
      if (r.config) a.config = { ...(a.config || {}), ...r.config, updated: now };
      break;
    }
    default:
      // legacy free-form event ({agent, kind, value, note}): counts as activity only.
      if (r.status) a.status = r.status;
      break;
  }
  return a;
}

/** What the UI receives: state + derived fields (offline, today's usage). */
export function publicView(a, now = Date.now()) {
  const today = dayOf(now);
  const offline = !a.lastSeen || now - a.lastSeen > OFFLINE_AFTER_MS;
  const doneToday = a.tasks.filter(t => t.status === 'done' && t.ended && dayOf(t.ended) === today).length;
  const u = a.usage[today] || null;
  return {
    id: a.id,
    name: a.name || a.id,
    status: offline ? 'offline' : a.status,
    reportedStatus: a.status,
    current: a.current,
    tasks: a.tasks.slice(0, 15),
    usageToday: u ? { ...u, tasks: u.tasks ?? doneToday } : (doneToday ? { tasks: doneToday } : null),
    usageDays: Object.keys(a.usage).sort().reverse().slice(0, 7).map(d => ({ day: d, ...a.usage[d] })),
    config: a.config,
    events: a.events || 0,
    lastSeen: a.lastSeen || null,
    hasData: !!a.lastSeen,
  };
}
