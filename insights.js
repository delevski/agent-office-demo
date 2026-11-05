// insights.js — pure helpers shared by the server (Durable Object) and the browser:
// stuck/silent alerts, the 7-day task history, the review trend and today's change feed.
// No I/O, no DOM: unit-tested with `node --test`, imported by server/agents.js, server/hub.js and main.js.

/** Config: an agent with an open task and no update about it, or a heartbeat agent that went quiet,
 *  for longer than this is flagged in the room and in the panel. */
export const ALERT_AFTER_MIN = 30;
export const ALERT_AFTER_MS = ALERT_AFTER_MIN * 60 * 1000;
export const HISTORY_DAYS = 7;

const TZ = 'Asia/Jerusalem';
/** YYYY-MM-DD in the office's time zone (Ori is in Israel). */
export function dayOf(ts, tz = TZ) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}
/** The last `n` office days ending today, oldest first (calendar arithmetic, so DST never skips a day). */
export function lastDays(now, n = HISTORY_DAYS) {
  const [y, m, d] = dayOf(now).split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  return out;
}

/* ---------------- 3. stuck / silent ---------------- */
/**
 * v: an agent's public view (current, taskUpdated, lastSeen, lastHeartbeat, reportedStatus, hasData).
 * stuck  = it has an open task and nothing about that task arrived for ALERT_AFTER_MS;
 * silent = no open task, but it was mid-work (or reports by heartbeat) and went quiet for ALERT_AFTER_MS.
 * An agent that said it went offline is never flagged.
 */
export function agentAlert(v, now = Date.now(), afterMs = ALERT_AFTER_MS) {
  if (!v || !v.hasData || !v.lastSeen) return null;
  const said = v.reportedStatus || v.status;
  if (said === 'offline') return null;
  if (v.current) {
    const last = Math.max(v.taskUpdated || v.lastSeen || 0, 0);
    if (now - last > afterMs) return { kind: 'stuck', since: last, minutes: Math.floor((now - last) / 60000), task: v.current.title || v.current.id || '' };
    return null;
  }
  const quiet = now - v.lastSeen;
  if (quiet > afterMs && (v.lastHeartbeat || said === 'working' || said === 'blocked'))
    return { kind: 'silent', since: v.lastSeen, minutes: Math.floor(quiet / 60000), task: '' };
  return null;
}
/** "42 דק׳" / "2 שע׳ 5 דק׳" */
export function durationHe(min) {
  min = Math.max(0, Math.floor(min));
  if (min < 60) return `${min} דק׳`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h >= 48) return `${Math.floor(h / 24)} ימים`;
  return m ? `${h} שע׳ ${m} דק׳` : `${h} שע׳`;
}
export function alertLabel(al) {
  if (!al) return '';
  return (al.kind === 'stuck' ? 'תקוע ' : 'שקט ') + durationHe(al.minutes);
}

/* ---------------- 2. 7-day history ---------------- */
/** Count done/failed per office day from a task list (tasks carry status + ended). */
export function countTasksByDay(tasks) {
  const out = {};
  for (const t of tasks || []) {
    if (!t || !t.ended || (t.status !== 'done' && t.status !== 'failed')) continue;
    const d = dayOf(t.ended);
    out[d] = out[d] || { done: 0, failed: 0 };
    out[d][t.status]++;
  }
  return out;
}
/** [{day, done, failed}] for the last HISTORY_DAYS days, oldest first. Each day takes the larger of the
 *  stored daily counter and what the recent task list still shows (agents that reported before the counter existed). */
export function history7(daily, tasks, now = Date.now()) {
  const fromTasks = countTasksByDay(tasks);
  return lastDays(now).map(day => {
    const a = (daily && daily[day]) || {}, b = fromTasks[day] || {};
    return { day, done: Math.max(a.done || 0, b.done || 0), failed: Math.max(a.failed || 0, b.failed || 0) };
  });
}

/* ---------------- 1. review trend ---------------- */
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'nit'];
export function severityCounts(findings) {
  const c = Object.fromEntries(SEVERITIES.map(s => [s, 0]));
  for (const f of findings || []) if (c[f.severity] !== undefined) c[f.severity]++;
  return c;
}
/**
 * One point per PR per author: x = first review time of that PR, y = all findings on it
 * (every reviewer, every round). Returns [{author, points:[{pr, repo, ts, findings, reviews}], first, last, avgFirst, avgLast, change}]
 * sorted by number of PRs. `change` compares the average of the first half of the PRs with the last half
 * (negative = fewer findings = improving).
 */
export function reviewTrend(reviews) {
  const byAuthor = new Map();
  for (const r of reviews || []) {
    if (!r || !r.author_agent) continue;
    const key = `${r.repo || ''}#${r.pr}`;
    if (!byAuthor.has(r.author_agent)) byAuthor.set(r.author_agent, new Map());
    const prs = byAuthor.get(r.author_agent);
    const p = prs.get(key) || { pr: r.pr, repo: r.repo || '', ts: r.ts, findings: 0, reviews: 0 };
    p.ts = Math.min(p.ts, r.ts);
    p.findings += (r.findings || []).length;
    p.reviews++;
    prs.set(key, p);
  }
  const out = [];
  for (const [author, prs] of byAuthor) {
    const points = [...prs.values()].sort((a, b) => a.ts - b.ts);
    const half = Math.max(1, Math.floor(points.length / 2));
    const avg = arr => arr.reduce((s, p) => s + p.findings, 0) / (arr.length || 1);
    const avgFirst = avg(points.slice(0, half)), avgLast = avg(points.slice(-half));
    const change = points.length < 2 ? null : avgFirst === 0 ? (avgLast === 0 ? 0 : null) : (avgLast - avgFirst) / avgFirst;
    out.push({ author, points, first: points[0].findings, last: points[points.length - 1].findings, avgFirst, avgLast, change });
  }
  return out.sort((a, b) => b.points.length - a.points.length || a.author.localeCompare(b.author));
}

/* ---------------- 4. what changed today ---------------- */
/** Today's changes (merged PRs, deploys, closed tasks), newest first. `agents` are full agent states:
 *  tasks closed today that the change log does not hold yet (reported before it existed) are added from them. */
export function changesForDay(changes, agents, day, limit = 60) {
  const out = (changes || []).filter(c => c && c.ts && dayOf(c.ts) === day);
  const seen = new Set(out.map(c => c.id));
  for (const a of agents || []) {
    for (const t of a?.tasks || []) {
      if (t.status !== 'done' || !t.ended || dayOf(t.ended) !== day) continue;
      const id = `task:${a.id}:${t.id || t.title}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, type: 'task.done', agent: a.id, title: t.title || t.id, link: t.link || '', ts: t.ended });
    }
  }
  return out.sort((x, y) => y.ts - x.ts).slice(0, limit);
}


/* ---------------- B4. cost / token meter ---------------- */
export const BUDGET_FIELDS = ['cost', 'tokens', 'messages'];
export const BUDGET_WARN = 0.8; // amber from 80% of the daily budget, red over 100%
/** The tightest of the budgets the agent set: {field, used, limit, pct, level: 'ok'|'warn'|'over'} or null. */
export function budgetMeter(usage, budget) {
  if (!budget) return null;
  let best = null;
  for (const f of BUDGET_FIELDS) {
    if (!(budget[f] > 0)) continue;
    const used = Number(usage?.[f]) || 0;
    const pct = used / budget[f];
    if (!best || pct > best.pct) best = { field: f, used, limit: budget[f], pct };
  }
  if (!best) return null;
  best.level = best.pct > 1 ? 'over' : best.pct >= BUDGET_WARN ? 'warn' : 'ok';
  best.pct = Math.round(best.pct * 1000) / 10;
  return best;
}

/* ---------------- B6. meeting room ---------------- */
/** "owner/repo#12" for a PR link, "owner/repo" for a repo link, '' otherwise. */
export function refKey(link) {
  const s = String(link || '');
  const pr = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i.exec(s);
  if (pr) return `${pr[1].toLowerCase()}#${pr[2]}`;
  const repo = /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[/?#]|$)/i.exec(s);
  return repo ? repo[1].toLowerCase() : '';
}
/** Agents (views) that are working on the same PR / repo right now: [{key, label, ids}] with 2+ agents each. */
export function meetingGroups(views) {
  const by = new Map();
  for (const v of views || []) {
    if (!v || !v.current || v.status === 'offline') continue;
    const key = refKey(v.current.link);
    if (!key) continue;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(v.id);
  }
  return [...by.entries()].filter(([, ids]) => ids.length >= 2)
    .map(([key, ids]) => ({ key, label: key.includes('#') ? 'PR #' + key.split('#')[1] : key.split('/')[1], ids: ids.sort() }))
    .sort((a, b) => b.ids.length - a.ids.length || a.key.localeCompare(b.key));
}

/* ---------------- B5. morning summary ---------------- */
/** Office-zone offset from UTC (ms) at instant t. */
function zoneOffset(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
}
/** The UTC instant of a wall-clock time in the office zone (DST-safe). */
export function zoneTime(y, m, d, h = 0, min = 0) {
  const wall = Date.UTC(y, m - 1, d, h, min);
  let t = wall - zoneOffset(wall);
  t = wall - zoneOffset(t);
  return t;
}
/** Default "overnight" window start: 18:00 office time of the previous day. */
export function overnightSince(now = Date.now()) {
  const [y, m, d] = dayOf(now).split('-').map(Number);
  return zoneTime(y, m, d - 1, 18);
}
const fmtTime = ts => new Intl.DateTimeFormat('he-IL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
/**
 * Digest of what happened between since and until. agents: [{id, name, tasks[], alert}] (public views),
 * changes: change log, reviews: review list. Returns {since, until, counts, agents[], merged[], deploys[], reviews[], alerts[], text}.
 */
export function buildSummary({ agents = [], changes = [], reviews = [], since, until = Date.now() }) {
  const inWin = ts => ts && ts >= since && ts <= until;
  const cap = s => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
  const name = id => cap(agents.find(a => a.id === id)?.name || id);
  const per = agents.map(a => {
    const done = (a.tasks || []).filter(t => t.status === 'done' && inWin(t.ended));
    const failed = (a.tasks || []).filter(t => t.status === 'failed' && inWin(t.ended));
    return { id: a.id, name: cap(a.name || a.id), done: done.map(t => t.title || t.id), failed: failed.map(t => t.title || t.id), now: a.current?.title || '' };
  }).filter(a => a.done.length || a.failed.length || a.now);
  const merged = changes.filter(c => c.type === 'pr.merged' && inWin(c.ts)).sort((a, b) => a.ts - b.ts)
    .map(c => ({ pr: c.pr, repo: c.repo, title: c.title, link: c.link, by: c.merged_by || c.agent, ts: c.ts }));
  const deploys = changes.filter(c => c.type === 'deploy' && inWin(c.ts)).sort((a, b) => a.ts - b.ts)
    .map(c => ({ target: c.target, env: c.env, version: c.version, status: c.status, ts: c.ts }));
  const revs = reviews.filter(r => inWin(r.ts)).sort((a, b) => a.ts - b.ts)
    .map(r => ({ pr: r.pr, repo: r.repo, author: r.author_agent, reviewer: r.reviewer_agent, verdict: r.verdict, findings: (r.findings || []).length, ts: r.ts }));
  const alerts = agents.filter(a => a.alert).map(a => ({ id: a.id, name: cap(a.name || a.id), kind: a.alert.kind, minutes: a.alert.minutes, task: a.alert.task }));
  const counts = {
    tasks_done: per.reduce((s, a) => s + a.done.length, 0), tasks_failed: per.reduce((s, a) => s + a.failed.length, 0),
    prs_merged: merged.length, deploys: deploys.length, deploys_failed: deploys.filter(d => d.status !== 'success').length,
    reviews: revs.length, alerts: alerts.length,
  };
  const L = [];
  L.push(`☀️ סיכום משרד הסוכנים · ${fmtTime(since)}–${fmtTime(until)}`);
  if (!counts.tasks_done && !counts.tasks_failed && !merged.length && !deploys.length && !revs.length && !alerts.length) {
    L.push('שקט בלילה: לא נסגרו משימות, לא היו מיזוגים או פריסות.');
  } else {
    const head = [
      counts.tasks_done && (counts.tasks_done === 1 ? 'משימה אחת הושלמה' : `${counts.tasks_done} משימות הושלמו`),
      counts.tasks_failed && `${counts.tasks_failed} נכשלו`,
      merged.length && (merged.length === 1 ? 'PR אחד מוזג' : `${merged.length} PRs מוזגו`),
      deploys.length && (deploys.length === 1 ? 'פריסה אחת' : `${deploys.length} פריסות`) + (counts.deploys_failed ? ` (${counts.deploys_failed} נכשלו)` : ''),
      revs.length && (revs.length === 1 ? 'ביקורת אחת' : `${revs.length} ביקורות`),
    ].filter(Boolean);
    if (head.length) L.push(head.join(' · '));
    for (const a of per) {
      const parts = [];
      if (a.done.length) parts.push(`סיים ${a.done.length}: ${a.done.slice(0, 3).join(', ')}${a.done.length > 3 ? '…' : ''}`);
      if (a.failed.length) parts.push(`נכשל ${a.failed.length}`);
      if (a.now) parts.push(`עכשיו: ${a.now}`);
      L.push(`• ${a.name} — ${parts.join(' · ')}`);
    }
    for (const m of merged) L.push(`🔀 מוזג PR #${m.pr}${m.title ? ' ' + m.title : ''}${m.repo ? ` (${m.repo})` : ''}`);
    for (const d of deploys) L.push(`${d.status === 'success' ? '🚀' : '⚠️'} פריסה ${d.target} → ${d.env}${d.version ? ' ' + d.version : ''}${d.status === 'success' ? '' : ' · ' + d.status}`);
    for (const r of revs) L.push(`🔍 ${name(r.reviewer)} ביקר את PR #${r.pr} של ${name(r.author)}: ${r.findings} ממצאים (${r.verdict})`);
    for (const a of alerts) L.push(`⚠ ${a.name} ${a.kind === 'stuck' ? 'תקוע' : 'שקט'} ${durationHe(a.minutes)}${a.task ? ` · ${a.task}` : ''}`);
  }
  return { since, until, counts, agents: per, merged, deploys, reviews: revs, alerts, text: L.join('\n') };
}

/* ---------------- B2. day replay ---------------- */
/** Office-day bounds [start, end) in ms for a YYYY-MM-DD day (a DST day is 23 or 25 hours long). */
export function dayBounds(day) {
  const [y, m, d] = day.split('-').map(Number);
  return [zoneTime(y, m, d), zoneTime(y, m, d + 1)];
}


/* ---------------- C1. reliability score ---------------- */
// Three parts, all from data the office already has. 100 = every task done, never stuck, review findings falling.
export const RELIABILITY = {
  success: 60,   // share of finished tasks (7 days) that were done rather than failed
  stability: 25, // minus 8 for every stuck incident in 7 days (an open task silent for more than ALERT_AFTER_MIN)
  quality: 15,   // the agent's own PRs: findings per PR falling (first PRs vs latest) earns all of it, rising earns none
  stuckPenalty: 8,
};
/**
 * view: the agent's public view (history7, incidents7, incidentFor, taskUpdated, alert or computed alert);
 * trend: this agent's entry from reviewTrend() as the PR author, or null.
 * Returns {score, label, level, parts[], tasks, lowData}.
 */
export function reliability(view, trend = null, alert = null) {
  const R = RELIABILITY;
  const h = view?.history7 || [];
  const done = h.reduce((s, d) => s + (d.done || 0), 0), failed = h.reduce((s, d) => s + (d.failed || 0), 0);
  const n = done + failed;
  const success = n ? R.success * done / n : R.success * 0.75;
  let incidents = view?.incidents7 || 0;
  if (alert?.kind === 'stuck' && view?.incidentFor !== (view?.taskUpdated || view?.lastSeen)) incidents += 1; // stuck right now, not yet counted
  const stability = Math.max(0, R.stability - R.stuckPenalty * incidents);
  let quality = R.quality / 2, qualityDetail = 'אין עדיין ביקורות על PRs של הסוכן';
  if (trend && trend.points?.length >= 2 && trend.change !== null && trend.change !== undefined) {
    const c = Math.max(-1, Math.min(1, trend.change)); // change is a fraction: -1 = findings went to zero, +1 = doubled or worse
    quality = R.quality * (1 - c) / 2;
    qualityDetail = trend.last < trend.first ? `ממצאים לכל PR ירדו מ-${trend.first} ל-${trend.last}` : trend.last > trend.first ? `ממצאים לכל PR עלו מ-${trend.first} ל-${trend.last}` : `ממצאים לכל PR נשארו ${trend.last}`;
  } else if (trend && trend.points?.length === 1) qualityDetail = 'PR אחד בלבד עם ביקורת, עוד אין מגמה';
  const score = Math.round(success + stability + quality);
  const level = score >= 85 ? 'great' : score >= 70 ? 'good' : score >= 50 ? 'fair' : 'low';
  const label = { great: 'אמין מאוד', good: 'יציב', fair: 'בינוני', low: 'דורש תשומת לב' }[level];
  return {
    score, level, label, tasks: n, lowData: n < 3,
    parts: [
      { key: 'success', label: 'הצלחה', points: Math.round(success), max: R.success, detail: n ? `${done} הושלמו, ${failed} נכשלו ב-7 ימים` : 'אין משימות שהסתיימו ב-7 ימים (ניטרלי)' },
      { key: 'stability', label: 'יציבות', points: Math.round(stability), max: R.stability, detail: incidents ? `${incidents} פעמים תקוע ב-7 ימים (−${R.stuckPenalty} לכל אחת)` : 'לא נתקע ב-7 ימים' },
      { key: 'quality', label: 'איכות קוד', points: Math.round(quality), max: R.quality, detail: qualityDetail },
    ],
  };
}

/* ---------------- C2. "give a task" (a board card only) ---------------- */
/** Validate the office's own "give a task" form. Returns {task:{title, agent, note}, errors[]}. */
export function parseAssign(body, knownAgents = []) {
  const errors = [];
  const title = typeof body?.title === 'string' ? body.title.trim().replace(/\s+/g, ' ').slice(0, 160) : '';
  const agent = typeof body?.agent === 'string' ? body.agent.trim().toLowerCase() : '';
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 300) : '';
  if (!title) errors.push('title: required');
  if (!agent) errors.push('agent: required');
  else if (knownAgents.length && !knownAgents.includes(agent)) errors.push('agent: unknown agent');
  return { task: { title, agent, note }, errors };
}
