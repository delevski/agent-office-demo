// audit-state.js — the "בקרה" (control) log: who did what to which PR / task, and who wrote to whom.
// Pure functions (no I/O), shared by the Durable Object (server/hub.js), the Worker (worker.js) and the tests.
// An audit event is one flat row:
//   { id, ts, type, actor, reported_by, to?, pr?, repo?, title?, link?, verdict?, channel?, quote?, text?, sha?, target?, env?, status?, task_id?, prs? }
// `actor` = who did the thing; `reported_by` = which agent's token (or "board") told the office about it. For an approval
// by a human (Ori) the actor is "ori" and reported_by is always the reporting agent: it can never pass as Ori's own entry.
import { str, agentId, link, parsePr, repoOf, prLink, eventTime, CHAT_MAX_LINES } from './office-state.js';
import { dayOf, dayBounds } from './insights.js';

export const AUDIT_TYPES = ['pr.opened', 'pr.reviewed', 'pr.approved', 'pr.merged', 'deploy', 'message', 'task.created', 'task.claimed', 'task.done', 'task.failed', 'task.cancelled'];
export const APPROVAL_CHANNELS = ['whatsapp', 'slack', 'imessage', 'email', 'phone', 'board', 'site', 'github', 'other'];
export const MESSAGE_CHANNELS = ['slack', 'board', 'handoff', 'whatsapp', 'email', 'github', 'other'];
export const AUDIT_ONLY_KINDS = ['pr.approved', 'message'];
export const AUDIT_KIND_ALIASES = { 'pr.approval': 'pr.approved', 'pr.approve': 'pr.approved', approval: 'pr.approved', approved: 'pr.approved', msg: 'message', dm: 'message', 'agent.message': 'message' };
export const AUDIT_QUOTE_MAX = 300;
export const AUDIT_TEXT_MAX = 500;
export const AUDIT_DAYS = 30;           // days of audit kept (one storage key per day)
export const AUDIT_DAY_MAX = 400;       // events kept per day
export const AUDIT_DAY_BYTES = 96_000;  // ...or fewer, so one stored value stays well under the storage value limit
export const AUDIT_ITEMS_MAX = 300;     // timeline rows returned by one query

const CHANNEL_ALIASES = { wa: 'whatsapp', 'whats-app': 'whatsapp', ווטסאפ: 'whatsapp', וואטסאפ: 'whatsapp', sms: 'imessage', text: 'imessage', mail: 'email', gh: 'github', web: 'site', office: 'site', ticket: 'board', inbox: 'board' };
function channelOf(v, allowed) {
  const s = str(v, 20).toLowerCase().replace(/[\s_]+/g, '-');
  const c = CHANNEL_ALIASES[s] || s;
  return allowed.includes(c) ? c : '';
}
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
const oneLine = (v, n) => str(v, n * 2).replace(/\s+/g, ' ').trim().slice(0, n);

/** Canonical audit kind for an ingest body, or '' when it is not an audit-only kind. */
export function auditKind(body) {
  const k = str(body?.kind ?? body?.type, 40);
  const kind = AUDIT_KIND_ALIASES[k] || k;
  return AUDIT_ONLY_KINDS.includes(kind) ? kind : '';
}

/** pr.approved: someone (usually Ori) approved a PR; an agent reports it, verbatim quote included. */
export function parseApproval(body, sender, now = Date.now()) {
  const errors = [];
  const { pr, repo: repoFromPr } = parsePr(body.pr ?? body.pr_number ?? body.pull_request);
  const repo = repoOf(body.repo ?? body.repository ?? '') || repoFromPr || '';
  if (!/^\d+$/.test(pr)) errors.push('pr: required (number, "#12" or the PR URL)');
  const approver = agentId(body.approver ?? body.approved_by);
  if (!approver) errors.push('approver: required (who approved, e.g. "ori")');
  const channel = channelOf(body.channel ?? 'other', APPROVAL_CHANNELS);
  if (!channel) errors.push('channel: one of ' + APPROVAL_CHANNELS.join(', '));
  const quote = oneLine(body.quote ?? body.text, AUDIT_QUOTE_MAX);
  if (!quote) errors.push('quote: required (the approval, word for word, max ' + AUDIT_QUOTE_MAX + ')');
  const ts = eventTime(body.approved_at ?? body.ts, now, errors);
  return {
    audit: {
      id: `approved:${repo}#${pr}@${approver}`, ts, type: 'pr.approved', actor: approver, reported_by: sender || '',
      pr, repo, title: str(body.title ?? body.pr_title, 160), link: link(body.link ?? body.url) || prLink(repo, pr),
      channel, quote,
    },
    errors,
  };
}

/** message: one agent wrote to another (or to Ori). `from` is always the reporting agent. */
export function parseMessage(body, sender, now = Date.now()) {
  const errors = [];
  const from = agentId(body.from ?? body.from_agent) || sender || '';
  const to = agentId(body.to ?? body.to_agent ?? body.recipient);
  if (!from) errors.push('from: required');
  if (!to) errors.push('to: required (who the message was for)');
  if (from && to && from === to) errors.push('to: must be someone other than from');
  const channel = channelOf(body.channel ?? 'other', MESSAGE_CHANNELS);
  if (!channel) errors.push('channel: one of ' + MESSAGE_CHANNELS.join(', '));
  const text = oneLine(body.text ?? body.message ?? body.note, AUDIT_TEXT_MAX);
  if (!text) errors.push('text: required (max ' + AUDIT_TEXT_MAX + ')');
  const ts = eventTime(body.ts, now, errors);
  return {
    audit: { id: `msg:${from}>${to}:${ts}:${hash(text)}`, ts, type: 'message', actor: from, reported_by: sender || from, to, channel, text, link: link(body.link ?? body.url) },
    errors,
  };
}

/** Normalise an audit-only ingest body. { kind, audit, errors } */
export function parseAuditKind(body, sender, now = Date.now()) {
  const kind = auditKind(body);
  if (!kind) return null;
  const p = kind === 'pr.approved' ? parseApproval(body, sender, now) : parseMessage(body, sender, now);
  return { kind, audit: p.audit, errors: p.errors };
}

/** The audit rows a normalised report adds (existing kinds: pr.opened, review, pr.merged, deploy, handoff, chat.exchange). */
export function auditFromReport(r, now = Date.now()) {
  const out = [];
  const by = r.agent || '';
  if (r.kind === 'pr.opened' && r.change) {
    const c = r.change;
    out.push({ id: `opened:${c.repo}#${c.pr || c.title}`, ts: c.ts, type: 'pr.opened', actor: c.author_agent || by, reported_by: by, pr: c.pr, repo: c.repo, title: c.title, link: c.link });
  } else if (r.kind === 'review' && r.review) {
    const v = r.review;
    out.push({ id: `reviewed:${v.id}`, ts: v.ts, type: 'pr.reviewed', actor: v.reviewer_agent, reported_by: by, to: v.author_agent, pr: v.pr, repo: v.repo, title: v.title, link: v.link,
      verdict: v.verdict, text: str(v.summary, 200), findings: (v.findings || []).length });
  } else if (r.kind === 'pr.merged' && r.change) {
    const c = r.change;
    out.push({ id: `merged:${c.repo}#${c.pr || c.title}`, ts: c.ts, type: 'pr.merged', actor: c.merged_by || by, reported_by: by, pr: c.pr, repo: c.repo, title: c.title, link: c.link, sha: c.sha || '' });
  } else if (r.kind === 'deploy' && r.change) {
    const c = r.change;
    out.push({ id: `deploy:${c.target}:${c.env}:${c.version || c.ts}`, ts: c.ts, type: 'deploy', actor: c.agent || by, reported_by: by, target: c.target, env: c.env, sha: c.version, status: c.status,
      link: c.link, text: c.note || '', ...(c.prs ? { prs: c.prs } : {}) });
  } else if (r.kind === 'handoff' && r.handoff) {
    const h = r.handoff;
    out.push({ id: `msg:${h.from}>${h.to}:${h.ts}:${hash('h' + (h.task_id || h.title))}`, ts: h.ts, type: 'message', actor: h.from, reported_by: by, to: h.to, channel: 'handoff',
      text: oneLine(`העביר משימה: ${h.title || h.task_id}${h.note ? ' · ' + h.note : ''}`, AUDIT_TEXT_MAX), link: h.link || '' });
  } else if (r.kind === 'chat.exchange' && r.chat) {
    const c = r.chat;
    c.lines.slice(0, CHAT_MAX_LINES).forEach((l, i) => {
      const others = c.participants.filter(p => p !== l.agent);
      if (!others.length) return;
      const ch = channelOf(c.source, MESSAGE_CHANNELS) || 'other';
      out.push({ id: `msg:${l.agent}>${others.join('+')}:${c.ts}:${i}:${hash(l.text)}`, ts: c.ts + i, type: 'message', actor: l.agent, reported_by: by, to: others.join(', '), channel: ch, text: l.text, link: c.link || '' });
    });
  }
  return out.map(e => ({ ...e, ts: Math.min(e.ts || now, now + 60_000) }));
}

/* ---------------- board task rows ---------------- */
export function auditFromTask(task, step, now = Date.now()) {
  const ticket = task.source === 'agent-ticket';
  const base = { task_id: task.id, title: str(task.title, 160), to: task.agent, link: task.ref || '' };
  if (step === 'created') return { ...base, id: `task:${task.id}:created`, ts: task.created, type: 'task.created', actor: ticket ? task.from : 'ori', reported_by: ticket ? task.from : 'board', via: ticket ? 'ticket' : 'owner', text: str(task.note, 200) };
  if (step === 'claimed') return { ...base, id: `task:${task.id}:claimed`, ts: now, type: 'task.claimed', actor: task.agent, reported_by: task.agent };
  if (step === 'done' || step === 'failed') return { ...base, id: `task:${task.id}:${step}`, ts: now, type: 'task.' + step, actor: task.agent, reported_by: task.agent, status: task.status, text: str(task.result, 200), link: task.link || task.ref || '' };
  if (step === 'cancelled') return { ...base, id: `task:${task.id}:cancelled`, ts: now, type: 'task.cancelled', actor: 'ori', reported_by: 'board' };
  return null;
}

/* ---------------- storage helpers (one key per day) ---------------- */
/** Merge `events` into a day's stored list: upsert by id, keep time order, cap by count and bytes (oldest go first). */
export function mergeDay(list, events) {
  const out = list.slice();
  for (const e of events) { const i = out.findIndex(x => x.id === e.id); if (i >= 0) out[i] = e; else out.push(e); }
  out.sort((a, b) => a.ts - b.ts);
  let kept = out.length > AUDIT_DAY_MAX ? out.slice(-AUDIT_DAY_MAX) : out;
  while (kept.length > 1 && JSON.stringify(kept).length > AUDIT_DAY_BYTES) kept = kept.slice(1);
  return kept;
}

/* ---------------- the query: grouped timeline ---------------- */
const involves = (e, agent) => [e.actor, e.reported_by, e.to].some(x => String(x || '').split(',').map(s => s.trim()).includes(agent));
const prKey = e => (e.pr ? `${e.repo || ''}#${e.pr}` : '');
export function prStatus(steps) {
  const has = t => steps.some(s => s.type === t);
  const merged = steps.find(s => s.type === 'pr.merged');
  const deployed = steps.some(s => s.type === 'deploy' && (!merged || s.ts >= merged.ts - 1000));
  if (merged && deployed) return 'deployed';
  if (merged) return 'merged';
  if (has('pr.approved')) return 'approved';
  const reviews = steps.filter(s => s.type === 'pr.reviewed');
  if (reviews.length) return reviews[reviews.length - 1].verdict === 'changes_requested' ? 'changes_requested' : 'reviewed';
  return 'open';
}
export function taskStatus(steps) {
  const last = [...steps].sort((a, b) => a.ts - b.ts).pop();
  return { 'task.created': 'queued', 'task.claimed': 'running', 'task.done': 'done', 'task.failed': 'failed', 'task.cancelled': 'cancelled' }[last?.type] || 'queued';
}
function expandDeploys(events) {
  // a deploy that lists PRs is also a step of each of those PRs (a missing repo is taken from the PR's other steps)
  const repoOfPr = new Map();
  for (const e of events) if (e.pr && e.repo) { if (!repoOfPr.has(e.pr)) repoOfPr.set(e.pr, new Set()); repoOfPr.get(e.pr).add(e.repo); }
  const out = [];
  for (const e of events) {
    out.push(e);
    if (e.type === 'deploy') for (const p of e.prs || []) {
      const known = repoOfPr.get(p.pr);
      const repo = p.repo || (known && known.size === 1 ? [...known][0] : '');
      out.push({ ...e, id: e.id + '>' + p.pr, pr: p.pr, repo, _fromDeploy: true });
    }
  }
  return out;
}
const TYPE_GROUPS = { pr: t => t.startsWith('pr.'), message: t => t === 'message', task: t => t.startsWith('task.'), deploy: t => t === 'deploy' };

/**
 * Build the owner's timeline.
 *   all: every stored event (any day, oldest first)
 *   q:   { day: 'YYYY-MM-DD'|'', agent, type: pr|message|task|deploy|<exact type>, pr: '16'|'owner/repo#16', repo }
 * Returns { items (newest first), days, agents, repos, counts }.
 */
export function buildAudit(all, q = {}, now = Date.now()) {
  const events = all.slice().sort((a, b) => a.ts - b.ts);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(q.day || '') ? q.day : '';
  const [d0, d1] = day ? dayBounds(day) : [0, Infinity];
  const agent = agentIdSafe(q.agent);
  const type = String(q.type || '');
  const typeOk = t => !type || (TYPE_GROUPS[type] ? TYPE_GROUPS[type](t) : t === type);
  const prQ = parsePrQuery(q.pr);
  const repoQ = String(q.repo || '').toLowerCase();
  const prMatch = e => (!prQ.pr || (e.pr === prQ.pr && (!prQ.repo || (e.repo || '').toLowerCase() === prQ.repo))) && (!repoQ || (e.repo || '').toLowerCase() === repoQ);

  // facets for the filter bar come from everything stored
  const dayCount = new Map(); const agents = new Set(); const repos = new Set();
  for (const e of events) {
    const d = dayOf(e.ts); dayCount.set(d, (dayCount.get(d) || 0) + 1);
    for (const a of [e.actor, e.reported_by, e.to]) for (const x of String(a || '').split(',')) { const s = x.trim(); if (s && s !== 'board') agents.add(s); }
    if (e.repo) repos.add(e.repo);
  }

  const expanded = expandDeploys(events);
  const items = [];
  // PR rows: full lifecycle of every PR that has at least one matching step
  const byPr = new Map();
  for (const e of expanded) { const k = prKey(e); if (k) { if (!byPr.has(k)) byPr.set(k, []); byPr.get(k).push(e); } }
  const showPr = !type || type === 'pr' || type.startsWith('pr.');
  if (showPr) for (const [key, steps] of byPr) {
    const hit = steps.some(s => s.ts >= d0 && s.ts < d1 && typeOk(s.type) && (!agent || involves(s, agent)));
    if (!hit || !prMatch(steps[0])) continue;
    const pick = f => [...steps].reverse().find(f);
    const title = pick(s => s.title)?.title || '';
    const opened = steps.find(s => s.type === 'pr.opened');
    items.push({ kind: 'pr', key, pr: steps[0].pr, repo: steps[0].repo || '', title, link: pick(s => s.link && s.type !== 'deploy')?.link || prLink(steps[0].repo, steps[0].pr),
      status: prStatus(steps), author: opened?.actor || '', first: steps[0].ts, ts: steps[steps.length - 1].ts, steps });
  }
  // task rows
  const byTask = new Map();
  for (const e of events) if (e.task_id) { if (!byTask.has(e.task_id)) byTask.set(e.task_id, []); byTask.get(e.task_id).push(e); }
  if (!type || type === 'task' || type.startsWith('task.')) if (!prQ.pr && !repoQ) for (const [id, steps] of byTask) {
    if (!steps.some(s => s.ts >= d0 && s.ts < d1 && typeOk(s.type) && (!agent || involves(s, agent)))) continue;
    const created = steps.find(s => s.type === 'task.created') || steps[0];
    items.push({ kind: 'task', key: id, title: steps.find(s => s.title)?.title || id, from: created.actor, to: created.to, via: created.via || '', status: taskStatus(steps),
      note: created.text || '', link: [...steps].reverse().find(s => s.link)?.link || '', first: steps[0].ts, ts: steps[steps.length - 1].ts, steps });
  }
  // loose events: messages, and deploys that carry no PR
  if (!prQ.pr && !repoQ) for (const e of events) {
    const loose = e.type === 'message' || (e.type === 'deploy' && !(e.prs || []).length);
    if (!loose || !typeOk(e.type) || e.ts < d0 || e.ts >= d1 || (agent && !involves(e, agent))) continue;
    items.push({ kind: 'event', key: e.id, ts: e.ts, ev: e });
  }
  // type=deploy also lists the PR-carrying deploys, flat
  if (type === 'deploy') for (const e of events) if (e.type === 'deploy' && (e.prs || []).length && e.ts >= d0 && e.ts < d1 && (!agent || involves(e, agent))) items.push({ kind: 'event', key: e.id, ts: e.ts, ev: e });
  items.sort((a, b) => b.ts - a.ts);
  let counts = { pr: 0, message: 0, task: 0, deploy: 0 };
  if (type) counts = buildAudit(all, { ...q, type: '' }, now).counts; // the tab counts do not shrink when a tab is picked
  else for (const it of items) { if (it.kind === 'pr') counts.pr++; else if (it.kind === 'task') counts.task++; else if (it.ev.type === 'message') counts.message++; else counts.deploy++; }
  return {
    now, filters: { day, agent, type, pr: q.pr || '', repo: q.repo || '' },
    days: [...dayCount].map(([d, n]) => ({ day: d, count: n })).sort((a, b) => b.day.localeCompare(a.day)),
    agents: [...agents].sort(), repos: [...repos].sort(), counts, total: items.length,
    truncated: items.length > AUDIT_ITEMS_MAX, items: items.slice(0, AUDIT_ITEMS_MAX),
  };
}
function agentIdSafe(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40); }
function parsePrQuery(v) {
  const s = String(v || '').trim();
  if (!s) return { pr: '', repo: '' };
  const m = /^(?:([\w.-]+\/[\w.-]+))?#?(\d+)$/.exec(s.replace(/^#/, '')) || /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s);
  return m ? { pr: m[2], repo: (m[1] || '').toLowerCase() } : { pr: '\u0000', repo: '' }; // unparsable -> matches nothing
}
