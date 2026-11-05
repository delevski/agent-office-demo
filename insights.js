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
