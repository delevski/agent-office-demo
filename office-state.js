// office-state.js — per-agent live state for the Agent Office (pure functions, no I/O).
// The Durable Object (worker.js -> server/hub.js) keeps one state object per agent and runs every
// accepted report through applyReport(). The browser runs the same reducer to replay a day.
// Kept pure so it is unit-tested with `node --test`.
import { agentAlert, dayOf, history7, lastDays, SEVERITIES, budgetMeter, BUDGET_FIELDS, ALERT_AFTER_MS } from './insights.js';
export { dayOf, ALERT_AFTER_MS, ALERT_AFTER_MIN } from './insights.js';

export const OFFLINE_AFTER_MS = 10 * 60 * 1000;   // no report for 10 min -> shown as offline
export const MAX_TASKS = 30;                       // recent tasks kept per agent
export const USAGE_DAYS = 14;                      // daily usage history kept per agent
export const DAILY_DAYS = 14;                      // daily done/failed counters kept per agent (7-day graph)
export const MAX_FINDINGS = 50;                    // findings kept per review
export const NEW_KINDS = ['review', 'pr.merged', 'deploy', 'handoff', 'pr.opened', 'chat.exchange'];
export const CHAT_MAX_LINES = 6;                   // lines kept per chat.exchange
export const CHAT_LINE_MAX = 90;                   // characters per chat line
export const CHAT_MAX_PEOPLE = 4;                  // participants per chat.exchange
export const MAX_CHAIN = 8;                        // agents kept in a task's handoff chain
export const STATUSES = ['working', 'idle', 'blocked', 'offline'];
export const USAGE_FIELDS = ['messages', 'tokens', 'cost', 'tasks', 'calls', 'pct_of_quota'];
const TASK_STATUSES = ['running', 'done', 'failed', 'blocked', 'queued', 'handed'];

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
  if (c.budget && typeof c.budget === 'object') { // daily budget: {cost (USD), tokens, messages}
    const b = {};
    for (const k of BUDGET_FIELDS) { const n = num(c.budget[k]); if (n !== undefined && n > 0) b[k] = n; }
    if (Object.keys(b).length) out.budget = b;
  } else if (num(c.budget) > 0) out.budget = { cost: num(c.budget) };
  return Object.keys(out).length ? out : null;
}


/* ---------------- new kinds: review · pr.merged · deploy (validated: bad payloads get a 400) ---------------- */
const MAX_PAST_MS = 400 * 86400_000;
const FUTURE_SLACK_MS = 5 * 60 * 1000;
/** ts for an event that may be reported late (a review written an hour ago). Future times clamp to now. */
export function eventTime(v, now, errors) {
  if (v === null || v === undefined || v === '') return now;
  const t = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(t) || t <= 0) { errors.push('ts: not a date (ISO string or epoch ms)'); return now; }
  if (t > now + FUTURE_SLACK_MS) return now;
  if (t < now - MAX_PAST_MS) { errors.push('ts: older than 400 days'); return now; }
  return Math.min(t, now);
}
/** pr: 12 | "12" | "#12" | "https://github.com/owner/repo/pull/12" -> {pr, repo?} */
export function parsePr(v) {
  if (v === null || v === undefined) return { pr: '' };
  const s = str(v, 300);
  const m = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i.exec(s);
  if (m) return { pr: m[2], repo: m[1] };
  return { pr: str(s.replace(/^#/, ''), 20) };
}
export function repoOf(v) {
  const s = str(v, 100).replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
  return s;
}
export function prLink(repo, pr) {
  return /^[\w.-]+\/[\w.-]+$/.test(repo) && /^\d+$/.test(pr) ? `https://github.com/${repo}/pull/${pr}` : '';
}
const VERDICTS = {
  approved: 'approved', approve: 'approved', lgtm: 'approved', accepted: 'approved', pass: 'approved',
  changes_requested: 'changes_requested', request_changes: 'changes_requested', changes: 'changes_requested',
  rejected: 'changes_requested', reject: 'changes_requested', fail: 'changes_requested',
  commented: 'commented', comment: 'commented', comments: 'commented', neutral: 'commented',
};
const SEVERITY_ALIASES = {
  critical: 'critical', blocker: 'critical', severe: 'critical',
  high: 'high', major: 'high', error: 'high',
  medium: 'medium', moderate: 'medium', normal: 'medium', warning: 'medium',
  low: 'low', minor: 'low',
  nit: 'nit', nitpick: 'nit', trivial: 'nit', info: 'nit', style: 'nit', suggestion: 'nit',
};
function cleanFinding(f, i, errors) {
  if (typeof f === 'string') { const title = str(f, 160); if (!title) { errors.push(`findings[${i}]: empty`); return null; } return { severity: 'medium', title }; }
  if (!f || typeof f !== 'object') { errors.push(`findings[${i}]: must be an object or a string`); return null; }
  const rawSev = str(f.severity ?? f.level ?? f.priority ?? 'medium', 20).toLowerCase();
  const severity = SEVERITY_ALIASES[rawSev];
  if (!severity) errors.push(`findings[${i}].severity: "${rawSev}" is not one of ${SEVERITIES.join(', ')}`);
  const title = str(f.title ?? f.message ?? f.text ?? f.summary ?? f.body, 160);
  if (!title) errors.push(`findings[${i}]: needs a title (or message)`);
  const out = { severity: severity || 'medium', title };
  const file = str(f.file ?? f.path, 120); if (file) out.file = file;
  const line = num(f.line); if (line !== undefined) out.line = Math.floor(line);
  return out;
}
/** review: who reviewed which PR of whom, and what they found. */
export function parseReview(body, sender, now = Date.now()) {
  const errors = [];
  const { pr, repo: repoFromPr } = parsePr(body.pr ?? body.pr_number ?? body.pull_request);
  const repo = repoOf(body.repo ?? body.repository ?? '') || repoFromPr || '';
  if (!pr) errors.push('pr: required (number, "#12" or the PR URL)');
  const author = agentId(body.author_agent ?? body.author);
  if (!author) errors.push('author_agent: required (the agent whose PR was reviewed)');
  const reviewer = agentId(body.reviewer_agent ?? body.reviewer) || sender || '';
  if (!reviewer) errors.push('reviewer_agent: required');
  const rawVerdict = str(body.verdict ?? body.state ?? 'commented', 30).toLowerCase().replace(/[\s-]+/g, '_');
  const verdict = VERDICTS[rawVerdict];
  if (!verdict) errors.push(`verdict: "${rawVerdict}" is not one of approved, changes_requested, commented`);
  let findings = [];
  const rawF = body.findings ?? body.issues ?? [];
  if (!Array.isArray(rawF)) errors.push('findings: must be an array');
  else findings = rawF.slice(0, MAX_FINDINGS).map((f, i) => cleanFinding(f, i, errors)).filter(Boolean);
  const round = Math.max(1, Math.floor(num(body.round) || 1));
  const ts = eventTime(body.ts ?? body.reviewed_at, now, errors);
  const review = {
    id: `${repo}#${pr}@${reviewer}#${round}`,
    pr, repo, title: str(body.title ?? body.pr_title, 160),
    link: link(body.link ?? body.url) || prLink(repo, pr),
    author_agent: author, reviewer_agent: reviewer, verdict, round,
    findings, summary: str(body.summary, 300), ts,
  };
  return { review, errors };
}
/** pr.merged: a PR landed on main. */
export function parseMerge(body, sender, now = Date.now()) {
  const errors = [];
  const { pr, repo: repoFromPr } = parsePr(body.pr ?? body.pr_number ?? body.pull_request);
  const repo = repoOf(body.repo ?? body.repository ?? '') || repoFromPr || '';
  const title = str(body.title ?? body.pr_title, 160);
  if (!pr && !title) errors.push('pr or title: required');
  const ts = eventTime(body.ts ?? body.merged_at, now, errors);
  return {
    change: {
      id: `pr:${repo}#${pr || title}`, type: 'pr.merged', agent: sender || '', pr, repo, title,
      link: link(body.link ?? body.url) || prLink(repo, pr),
      author_agent: agentId(body.author_agent ?? body.author), merged_by: agentId(body.merged_by) || sender || '', sha: str(body.sha ?? body.merge_sha ?? body.commit, 40), ts,
    },
    errors,
  };
}
/** pr.opened: a PR was opened (the room rings the bell). */
export function parsePrOpened(body, sender, now = Date.now()) {
  const errors = [];
  const { pr, repo: repoFromPr } = parsePr(body.pr ?? body.pr_number ?? body.pull_request ?? body.number);
  const repo = repoOf(body.repo ?? body.repository ?? '') || repoFromPr || '';
  const title = str(body.title ?? body.pr_title, 160);
  if (!pr && !title) errors.push('pr or title: required');
  const ts = eventTime(body.ts ?? body.opened_at ?? body.created_at, now, errors);
  return {
    change: {
      id: `pr-open:${repo}#${pr || title}`, type: 'pr.opened', agent: sender || '', pr, repo, title,
      link: link(body.link ?? body.url) || prLink(repo, pr),
      author_agent: agentId(body.author_agent ?? body.author) || sender || '', ts,
    },
    errors,
  };
}

/** chat.exchange: agents talked (e.g. in Slack) and maybe agreed; the room shows it as speech bubbles.
 *  {participants:["tab","hermes"], lines:[{agent:"tab", text:"..."}], topic?, agreed?, source?, link?} */
export function parseChat(body, sender, now = Date.now()) {
  const errors = [];
  const raw = Array.isArray(body.participants ?? body.agents) ? (body.participants ?? body.agents) : [];
  const people = [];
  const addP = id => { const a = agentId(id); if (a && !people.includes(a)) people.push(a); };
  raw.forEach(addP);
  const rawLines = Array.isArray(body.lines ?? body.messages) ? (body.lines ?? body.messages) : [];
  const lines = [];
  for (const l of rawLines.slice(0, CHAT_MAX_LINES * 3)) {
    if (!l || typeof l !== 'object') continue;
    const who = agentId(l.agent ?? l.from ?? l.speaker);
    const text = str(l.text ?? l.message ?? l.line, 400).replace(/\s+/g, ' ').trim();
    if (!who || !text) continue;
    lines.push({ agent: who, text: text.length > CHAT_LINE_MAX ? text.slice(0, CHAT_LINE_MAX - 1) + '…' : text });
    addP(who);
    if (lines.length >= CHAT_MAX_LINES) break;
  }
  if (sender && !people.length) addP(sender);
  if (people.length < 2) errors.push('participants: at least two different agents (or lines from two agents)');
  if (people.length > CHAT_MAX_PEOPLE) errors.push(`participants: at most ${CHAT_MAX_PEOPLE}`);
  if (!lines.length) errors.push('lines: at least one {agent, text}');
  const agreedRaw = body.agreed ?? body.agreement ?? body.outcome;
  const agreed = agreedRaw === true || /^(true|yes|agreed|agree|ok|done)$/i.test(String(agreedRaw ?? ''));
  const ts = eventTime(body.ts, now, errors);
  return {
    chat: {
      participants: people.slice(0, CHAT_MAX_PEOPLE), lines, topic: str(body.topic ?? body.subject, 100), agreed,
      source: str(body.source ?? body.channel ?? 'slack', 30), link: link(body.link ?? body.url), ts,
    },
    errors,
  };
}

const DEPLOY_STATUS = { success: 'success', succeeded: 'success', ok: 'success', done: 'success', live: 'success', failed: 'failed', failure: 'failed', fail: 'failed', error: 'failed', rolled_back: 'rolled_back', rollback: 'rolled_back' };
/** deploy: something went live (or failed to). */
export function parseDeploy(body, sender, now = Date.now()) {
  const errors = [];
  const target = str(body.target ?? body.service ?? body.app ?? body.project, 60);
  if (!target) errors.push('target: required (what was deployed, e.g. "agent-office")');
  const rawStatus = str(body.status ?? body.result ?? 'success', 20).toLowerCase().replace(/[\s-]+/g, '_');
  const status = DEPLOY_STATUS[rawStatus];
  if (!status) errors.push(`status: "${rawStatus}" is not one of success, failed, rolled_back`);
  const env = str(body.env ?? body.environment ?? 'production', 30);
  const version = str(body.version ?? body.sha ?? body.tag ?? body.commit, 40);
  const ts = eventTime(body.ts ?? body.deployed_at, now, errors);
  // which PRs went out with this deploy (audit log): prs: [13, "#14", "https://github.com/o/r/pull/15"], repo: "owner/name"
  const repo = repoOf(body.repo ?? body.repository ?? '');
  const rawPrs = Array.isArray(body.prs) ? body.prs : (body.pr !== undefined && body.pr !== null && body.pr !== '' ? [body.pr] : []);
  const prs = [];
  for (const x of rawPrs.slice(0, 12)) { const p = parsePr(x); if (/^\d+$/.test(p.pr) && !prs.some(y => y.pr === p.pr)) prs.push({ pr: p.pr, repo: p.repo || repo }); }
  return {
    change: {
      id: `deploy:${target}:${env}:${version || ts}`, type: 'deploy', agent: sender || '', target, env, version,
      status: status || 'success', link: link(body.link ?? body.url), note: str(body.note, 140), ts,
      ...(prs.length ? { prs } : {}),
    },
    errors,
  };
}

/** handoff: one agent passes a task to another. */
export function parseHandoff(body, sender, now = Date.now()) {
  const errors = [];
  const from = agentId(body.from ?? body.from_agent) || sender || '';
  const to = agentId(body.to ?? body.to_agent);
  if (!from) errors.push('from: required');
  if (!to) errors.push('to: required (the agent receiving the work)');
  if (from && to && from === to) errors.push('to: must be a different agent than from');
  const t = body.task && typeof body.task === 'object' ? body.task : {};
  const taskId = str(body.task_id ?? t.id, 80);
  const title = str(body.title ?? t.title, 160);
  if (!taskId && !title) errors.push('task_id or title: required');
  const ts = eventTime(body.ts, now, errors);
  return { handoff: { from, to, task_id: taskId, title, link: link(body.link ?? t.link), note: str(body.note, 140), ts }, errors };
}

/* ---------------- report normalization ---------------- */
// One report = one POST body. Fields may be nested ("usage": {...}) or flat at the top level,
// so small reporters (curl, hooks) can send whatever is simplest for them.
const KIND_ALIASES = {
  'task.handoff': 'handoff', 'hand_off': 'handoff', 'handover': 'handoff',
  'pr.open': 'pr.opened', 'pr.created': 'pr.opened', 'pr.new': 'pr.opened', 'pull_request.opened': 'pr.opened',
  'chat': 'chat.exchange', 'chat.agreed': 'chat.exchange', 'conversation': 'chat.exchange', 'slack.exchange': 'chat.exchange', 'agreement': 'chat.exchange',
  'pr.review': 'review', 'pr.reviewed': 'review', 'review.done': 'review', 'pr.merge': 'pr.merged', 'merge': 'pr.merged', 'deployed': 'deploy', 'deploy.done': 'deploy',
  'task.started': 'task.start', 'task.begin': 'task.start',
  'task.completed': 'task.done', 'task.finished': 'task.done', 'task.ok': 'task.done',
  'task.error': 'task.failed',
  'task.queue': 'task.queued', 'task.todo': 'task.queued', 'task.planned': 'task.queued',
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
      ct.status = /fail|error/.test(res) ? 'failed' : /block/.test(res) ? 'blocked' : /run|progress/.test(res) ? 'running' : /queue|todo|pending|planned/.test(res) ? 'queued' : 'done';
      ct.ended = ct.status === 'running' || ct.status === 'queued' ? undefined : time(t.done_at ?? t.ended ?? t.ended_at, now);
      return ct;
    }).filter(Boolean);
  }
  // live "current activity" line: a short what-I'm-doing-right-now text
  const activity = str(body.activity ?? body.detail ?? body.task?.activity ?? body.task?.detail ?? body.current?.activity ?? body.current?.detail, 120);
  if (activity) r.activity = activity;
  // handoff chain on a task.start / task.queued: {"from_agent": "tab"}
  const fromAgent = agentId(body.from_agent ?? body.task?.from_agent);
  if (fromAgent && fromAgent !== r.agent && /^task\.(start|queued)$/.test(kind)) r.from_agent = fromAgent;
  if (Array.isArray(body.chain)) r.chain = body.chain.map(agentId).filter(Boolean).slice(-MAX_CHAIN);
  if (kind === 'handoff') { const p = parseHandoff(body, r.agent, now); r.handoff = p.handoff; if (p.errors.length) r.errors = p.errors; }
  if (kind === 'review') { const p = parseReview(body, r.agent, now); r.review = p.review; if (p.errors.length) r.errors = p.errors; }
  if (kind === 'pr.merged') { const p = parseMerge(body, r.agent, now); r.change = p.change; if (p.errors.length) r.errors = p.errors; }
  if (kind === 'pr.opened') { const p = parsePrOpened(body, r.agent, now); r.change = p.change; if (p.errors.length) r.errors = p.errors; }
  if (kind === 'chat.exchange') { const p = parseChat(body, r.agent, now); r.chat = p.chat; if (p.errors.length) r.errors = p.errors; }
  if (kind === 'deploy') { const p = parseDeploy(body, r.agent, now); r.change = p.change; if (p.errors.length) r.errors = p.errors; delete r.status; }
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
  if (r.kind === 'handoff' && r.handoff) return `העביר ל-${r.handoff.to}: ${r.handoff.title || r.handoff.task_id}${r.handoff.note ? ' · ' + r.handoff.note : ''}`;
  if (r.note) return r.note;
  const t = r.task?.title || '';
  if (r.kind === 'task.start') return t ? `התחיל: ${t}` : 'התחיל משימה';
  if (r.kind === 'task.done') return (r.taskStatus === 'failed' ? 'נכשל: ' : 'סיים: ') + t;
  if (r.kind === 'task.failed') return t ? `נכשל: ${t}` : 'משימה נכשלה';
  if (r.kind === 'task.queued') return t ? `בתור: ${t}` : 'משימה נוספה לתור';
  if (r.kind === 'review' && r.review) {
    const v = r.review, n = v.findings.length;
    const verdict = { approved: 'אושר', changes_requested: 'נדרשו תיקונים', commented: 'הערות' }[v.verdict] || '';
    return `ביקורת על PR #${v.pr} של ${v.author_agent}: ${n ? n + ' ממצאים' : 'בלי ממצאים'} · ${verdict}`;
  }
  if (r.kind === 'pr.merged' && r.change) return `מוזג: PR ${r.change.pr ? '#' + r.change.pr : ''}${r.change.title ? ' · ' + r.change.title : ''}`.trim();
  if (r.kind === 'pr.opened' && r.change) return `פתח PR ${r.change.pr ? '#' + r.change.pr : ''}${r.change.title ? ' · ' + r.change.title : ''} 🔔`.replace(/\s+/g, ' ').trim();
  if (r.kind === 'chat.exchange' && r.chat) {
    const c = r.chat;
    return `שיחה: ${c.participants.join(' ↔ ')}${c.topic ? ' · ' + c.topic : ''}${c.agreed ? ' · הסכימו 🤝' : ''}`;
  }
  if (r.kind === 'deploy' && r.change) {
    const c = r.change;
    return `${c.status === 'success' ? 'פריסה' : c.status === 'failed' ? 'פריסה נכשלה' : 'פריסה בוטלה'}: ${c.target} → ${c.env}${c.version ? ' · ' + c.version : ''}`;
  }
  if (r.kind === 'status') return { working: 'עובד', idle: 'פנוי', blocked: 'תקוע — מחכה למשהו', offline: 'התנתק' }[r.status] || 'עדכון סטטוס';
  return r.kind;
}

/* ---------------- state ---------------- */
export function emptyAgent(id, now = Date.now()) {
  return { id, name: '', status: 'idle', current: null, tasks: [], usage: {}, config: null, events: 0, firstSeen: now, lastSeen: 0, taskUpdated: 0, lastHeartbeat: 0, daily: {} };
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
  const before = new Map((a.tasks || []).map(t => [t.id, t.status]));
  // heartbeat recent[] items without an id get a synthetic one; never count the same finished title twice a day
  const seenFinished = new Set((a.tasks || []).filter(t => t.ended).map(t => `${t.status}|${t.title}|${dayOf(t.ended)}`));
  const currentBefore = a.current?.id || a.current?.title || null;
  // reliability: an open task that went quiet past the alert threshold is one "stuck" incident, counted once
  // (when the agent is next heard from, or by the browser while it is still stuck)
  const staleFrom = prev?.current ? (prev.taskUpdated || prev.lastSeen || 0) : 0;
  if (staleFrom && now - staleFrom > ALERT_AFTER_MS && a.incidentFor !== staleFrom && prev.status !== 'offline') {
    a.incidents = { ...(a.incidents || {}) };
    const d = dayOf(now);
    a.incidents[d] = (a.incidents[d] || 0) + 1;
    a.incidentFor = staleFrom;
    for (const k of Object.keys(a.incidents)) if (k < dayOf(now - 30 * 86400_000)) delete a.incidents[k];
  }
  a.lastSeen = now;
  if (r.kind === 'heartbeat') a.lastHeartbeat = now;
  if (r.name) a.name = r.name;
  if (isFeedEvent(r)) a.events = (a.events || 0) + 1;

  switch (r.kind) {
    case 'task.progress':
    case 'task.start': {
      const t = r.task || { id: '', title: r.note || 'משימה', link: '', since: now };
      if (!t.id) t.id = 't' + now.toString(36);
      a.current = { id: t.id, title: t.title, link: t.link, since: t.since };
      const previous = a.tasks.find(x => x.id === t.id);
      upsertTask(a, { ...previous, ...t, status: 'running', ...(r.note ? { note: r.note } : {}), ...(r.board ? { board: r.board, assigned: true, note: r.board.note } : {}) });
      a.status = 'working';
      break;
    }
    case 'task.done':
    case 'task.failed': {
      const t = r.task || (a.current ? { ...a.current } : null);
      const status = TASK_STATUSES.includes(r.taskStatus) ? r.taskStatus : 'done';
      if (t) {
        const match = a.tasks.find(x => (t.id && x.id === t.id) || (!t.id && x.title === t.title));
        // a done/failed report may carry a short "what was actually done" note: keep it on the
        // task so the kanban card and panel show it instead of a bare title
        upsertTask(a, { ...(match || {}), ...t, id: t.id || match?.id || 't' + now.toString(36), since: match?.since || t.since, status, ended: now, ...(r.note ? { note: r.note } : {}), ...(r.board ? { board: r.board } : {}) });
        if (a.current && ((t.id && a.current.id === t.id) || (!t.id && a.current.title === t.title))) a.current = null;
      }
      if (!a.current) a.status = r.status || 'idle';
      break;
    }
    case 'task.queued': { // planned work: shows in the board's "to do" column, does not change status
      const t = r.task || { id: '', title: r.note || 'משימה', link: '', since: now };
      if (!t.id) t.id = 'q' + now.toString(36);
      const existing = a.tasks.find(x => x.id === t.id);
      // r.assigned is set only by the office itself (the "give a task" button), never parsed from an agent's report
      if (!existing || existing.status === 'queued') upsertTask(a, { ...t, status: 'queued', ...(r.assigned ? { assigned: true, note: r.assigned.note || '' } : {}), ...(r.board ? { board: r.board } : {}) });
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
    case 'handoff': { // sender side: the task leaves this desk (the hub queues it on the receiver)
      const h = r.handoff; if (!h) break;
      const match = a.tasks.find(x => (h.task_id && x.id === h.task_id) || (!h.task_id && h.title && x.title === h.title));
      const id = h.task_id || match?.id || 'h' + now.toString(36);
      upsertTask(a, { ...(match || { title: h.title, link: h.link, since: now }), id, title: h.title || match?.title || id, status: 'handed', handed_to: h.to, ended: now });
      if (a.current && (a.current.id === id || (!h.task_id && a.current.title === h.title))) { a.current = null; a.status = 'idle'; }
      break;
    }
    case 'review':
    case 'pr.merged':
    case 'pr.opened':
    case 'chat.exchange':
    case 'deploy':
      // stored by the hub (reviews / change log); for the sender it counts as activity only
      break;
    default:
      // legacy free-form event ({agent, kind, value, note}): counts as activity only.
      if (r.status) a.status = r.status;
      break;
  }
  // handoff chain carried by a task.start / task.queued ({"from_agent"} or a full {"chain"})
  if ((r.chain || r.from_agent) && /^task\.(start|queued)$/.test(r.kind)) {
    const id = r.kind === 'task.start' ? a.current?.id : (r.task?.id || null);
    const t = id && a.tasks.find(x => x.id === id);
    if (t) t.chain = (r.chain || [...(t.chain || []).filter(x => x !== r.from_agent), r.from_agent]).slice(-MAX_CHAIN);
  }
  // live activity line
  if (r.activity) a.activity = { text: r.activity, ts: now };
  else if (r.kind === 'task.start') a.activity = null;
  if (!a.current && a.status !== 'working') a.activity = null;
  // stuck detection: when did the open task last get an update?
  const currentNow = a.current?.id || a.current?.title || null;
  if (currentNow && (currentNow !== currentBefore || (r.task && ['task.start', 'task.progress', 'status', 'heartbeat'].includes(r.kind)))) a.taskUpdated = now;
  if (!currentNow) a.taskUpdated = 0;
  // 7-day history: count every task that just became done/failed, on the day it ended
  a.daily = a.daily || {};
  for (const t of a.tasks) {
    if ((t.status !== 'done' && t.status !== 'failed') || !t.ended || before.get(t.id) === t.status) continue;
    const d = dayOf(t.ended);
    if (r.kind === 'heartbeat' && seenFinished.has(`${t.status}|${t.title}|${d}`)) continue;
    a.daily[d] = a.daily[d] || { done: 0, failed: 0 };
    a.daily[d][t.status]++;
  }
  const days = Object.keys(a.daily).sort();
  while (days.length > DAILY_DAYS) delete a.daily[days.shift()];
  return a;
}

/** Tasks that this report closed as done (for the "what changed today" feed). */
export function newlyDone(prev, next) {
  const before = new Map((prev?.tasks || []).map(t => [t.id, t.status]));
  return (next?.tasks || []).filter(t => t.status === 'done' && t.ended && before.get(t.id) !== 'done');
}

/** What the UI receives: state + derived fields (offline, today's usage). */
export function publicView(a, now = Date.now()) {
  const today = dayOf(now);
  const offline = !a.lastSeen || now - a.lastSeen > OFFLINE_AFTER_MS;
  const doneToday = a.tasks.filter(t => t.status === 'done' && t.ended && dayOf(t.ended) === today).length;
  const u = a.usage[today] || null;
  const view = {
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
    taskUpdated: a.current ? (a.taskUpdated || a.lastSeen || null) : null,
    lastHeartbeat: a.lastHeartbeat || null,
    history7: history7(a.daily, a.tasks, now),
    activity: a.activity && !offline ? a.activity : null,
    incidents7: lastDays(now).reduce((s, d) => s + (a.incidents?.[d] || 0), 0),
    incidentFor: a.incidentFor || 0,
    budget: a.config?.budget || null,
  };
  view.meter = budgetMeter(view.usageToday, view.budget);
  view.alert = agentAlert(view, now);
  return view;
}
