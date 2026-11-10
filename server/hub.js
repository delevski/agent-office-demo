// server/hub.js — the one Durable Object (SQLite-backed, free plan) behind the office.
// Storage keys:  events, seq (feed, unchanged)  ·  agent:<id> (per-agent live state)
//                reviews (code reviews, newest last)  ·  changes (merged PRs, deploys, closed tasks)
//                audit:<day> (the "בקרה" log: PR lifecycle, agent messages, board tasks; one key per day, 30 days)
//                ticketrate:<agent> (agent-to-agent ticket rate limit)
//                fail:<ip> (login throttle)
import { applyReport, feedNote, isFeedEvent, publicView, emptyAgent, newlyDone, dayOf } from './agents.js';
import { changesForDay, buildSummary, overnightSince, dayBounds } from '../insights.js';

import { boardView, boardReport, BOARD_LIMIT, TICKET_PER_HOUR, TICKET_OPEN_MAX, TICKET_DEPTH_MAX, TERMINAL } from './board.js';
import { auditFromReport, auditFromTask, buildAudit, mergeDay, AUDIT_DAYS } from '../audit-state.js';

const FEED_MAX = 200;
const REVIEWS_MAX = 300;
const CHANGES_MAX = 400;
const HANDOFFS_MAX = 200;
const LOG_CHUNK = 150;       // day-log reports per storage key (the replay reads the whole day)
const LOG_CHUNK_BYTES = 96_000; // ...or fewer, so one stored value stays well under the storage value limit
const LOG_MAX_CHUNKS = 60;   // a cap on how much of a busy day is kept for the replay
const LOG_DAYS = 3;          // days of replay kept
/** What the replay stores of a report: all of it except the errors list (never present on accepted reports). */
function compact(r) {
  const { errors, claimToken, ...rest } = r;
  return rest;
}
const LOGIN_MAX_FAILS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export class EventHub {
  constructor(state) {
    this.state = state;
    this.state.blockConcurrencyWhile(async () => {
      this.events = (await this.state.storage.get('events')) || [];
      this.seq = (await this.state.storage.get('seq')) || 0;
      this.reviews = (await this.state.storage.get('reviews')) || [];
      this.changes = (await this.state.storage.get('changes')) || [];
      this.handoffs = (await this.state.storage.get('handoffs')) || [];
      this.logMeta = (await this.state.storage.get('logmeta')) || { day: '', chunk: 0, days: [] };
      this.logBuf = this.logMeta.day ? ((await this.state.storage.get(`log:${this.logMeta.day}:${this.logMeta.chunk}`)) || []) : [];
      this.board = [...(await this.state.storage.list({ prefix: 'board:' })).values()];
      this.agents = new Map();
      const rows = await this.state.storage.list({ prefix: 'agent:' });
      for (const [k, v] of rows) this.agents.set(k.slice(6), v);
    });
  }

  agentView(agent, now) {
    // The durable inbox is not subject to the activity history's 15-card cap.
    const owned = this.board.filter(t => t.agent === agent.id);
    // A generic idle heartbeat or a different task finishing cannot cancel an
    // owner request. Only its claim-backed lifecycle can settle it.
    const running = owned.filter(t => t.status === 'running').sort((a, b) => b.updated - a.updated);
    const active = running.find(t => t.id === agent.current?.id) || running[0];
    const effective = active ? { ...agent, status: 'working',
      current: { id: active.id, title: active.title, link: active.link, since: active.created },
      taskUpdated: active.updated } : agent;
    const view = publicView(effective, now);
    if (active) {
      // Preserve lastSeen and stale evidence: working means an open claim,
      // not a claim that the agent is still connected.
      view.status = 'working';
      view.presenceSource = 'board';
      view.presenceStale = boardView(active, now).stale;
    }
    view.tasks = [...owned.map(t => ({ id: t.id, title: t.title, status: t.status === 'queued' ? 'queued' : t.status,
      since: t.created, ended: TERMINAL.includes(t.status) ? t.updated : undefined,
      link: t.link, assigned: true, note: t.note, board: boardView(t, now) })), ...view.tasks.filter(t => !owned.some(b => b.id === t.id))];
    return view;
  }

  broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(msg); } catch { /* dropped */ }
    }
  }

  /** Insert or replace by id, keep time order, cap the list. */
  static upsert(list, item, max) {
    const i = list.findIndex(x => x.id === item.id);
    if (i >= 0) list[i] = item; else list.push(item);
    list.sort((a, b) => a.ts - b.ts);
    return list.length > max ? list.slice(-max) : list;
  }

  /** Append reports to today's replay log; the first report of a day snapshots every agent first. */
  logReports(reports, now, writes) {
    const d = dayOf(now);
    if (this.logMeta.day !== d) {
      const snap = {};
      for (const [id, a] of this.agents) { const { usage, ...rest } = a; snap[id] = { ...rest, usage: {} }; } // yesterday's usage is not needed to replay today
      writes['snap:' + d] = snap;
      const days = [...(this.logMeta.days || []).filter(x => x !== d), d].sort();
      const drop = days.length > LOG_DAYS ? days.splice(0, days.length - LOG_DAYS) : [];
      this.dropDays = drop;
      this.logMeta = { day: d, chunk: 0, days };
      this.logBuf = [];
      this.logBytes = 0;
    }
    if (this.logMeta.chunk >= LOG_MAX_CHUNKS) return;
    if (this.logBytes === undefined) this.logBytes = JSON.stringify(this.logBuf).length;
    for (const r of reports) {
      const c = { ...compact(r), ts: now }, size = JSON.stringify(c).length + 1; // the hub's clock, as applied live
      if (this.logBuf.length && (this.logBuf.length >= LOG_CHUNK || this.logBytes + size > LOG_CHUNK_BYTES)) {
        this.logMeta.chunk++; this.logBuf = []; this.logBytes = 0;
        if (this.logMeta.chunk >= LOG_MAX_CHUNKS) break;
      }
      this.logBuf.push(c); this.logBytes += size;
    }
    writes[`log:${d}:${this.logMeta.chunk}`] = this.logBuf;
    writes.logmeta = this.logMeta;
  }

  /** Append rows to the control log (one storage key per day; upsert by id, so a retried report never duplicates). */
  async addAudit(events) {
    const list = (events || []).filter(e => e && e.id && e.type && Number.isFinite(e.ts));
    if (!list.length) return;
    const byDay = new Map();
    for (const e of list) { const d = dayOf(e.ts); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(e); }
    const writes = {}; let newDay = false;
    for (const [d, evs] of byDay) {
      const cur = await this.state.storage.get('audit:' + d);
      if (!cur) newDay = true;
      writes['audit:' + d] = mergeDay(cur || [], evs);
    }
    await this.state.storage.put(writes);
    if (newDay) { // keep AUDIT_DAYS days
      const keys = [...(await this.state.storage.list({ prefix: 'audit:' })).keys()].sort();
      if (keys.length > AUDIT_DAYS) await this.state.storage.delete(keys.slice(0, keys.length - AUDIT_DAYS));
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();

    if (url.pathname === '/audit/add' && request.method === 'POST') {
      const body = await request.json();
      await this.addAudit(body.events);
      return json({ ok: true, ids: (body.events || []).map(e => e.id) });
    }
    if (url.pathname === '/audit') {
      const all = [];
      for (const v of (await this.state.storage.list({ prefix: 'audit:' })).values()) all.push(...v);
      const q = Object.fromEntries(['day', 'agent', 'type', 'pr', 'repo'].map(k => [k, url.searchParams.get(k) || '']));
      return json(buildAudit(all, q, now));
    }
    if (url.pathname === '/board/list') {
      const agent = url.searchParams.get('agent');
      return json({ tasks: this.board.filter(t => !agent || t.agent === agent).map(t => boardView(t, now)), now });
    }
    if (url.pathname === '/board/create' && request.method === 'POST') {
      const input = await request.json();
      const existing = this.board.filter(t => t.requestId === input.requestId);
      if (existing.length) {
        const ids = list => (list || []).map(a => a.id).join();
        if (existing[0].title !== input.title || existing[0].note !== input.note || existing.map(t => t.agent).sort().join() !== [...input.agents].sort().join() || ids(existing[0].attachments) !== ids(input.attachments))
          return json({ ok: false, error: 'requestId conflict' }, 409);
        return json({ ok: true, duplicate: true, tasks: existing.map(t => boardView(t)) });
      }
      // Never evict unfinished work. Owner retries with the same id after a lost response.
      if (this.board.length + input.agents.length > BOARD_LIMIT) return json({ ok: false, error: 'board full; archive completed requests first' }, 409);
      const added = input.agents.map(agent => ({ id: 'board-' + input.requestId + '-' + agent,
        requestId: input.requestId, title: input.title, note: input.note, agent,
        source: 'office-owner-session', created: now, updated: now, status: 'queued', delivery: 'pending', result: '', link: '',
        attachments: (input.attachments || []).map(a => ({ ...a })) }));
      this.board.push(...added);
      await this.state.storage.put(Object.fromEntries(added.map(t => ['board:' + t.id, t])));
      for (const task of added) await this.fetch(new Request('https://hub/report', { method: 'POST', body: JSON.stringify(boardReport(task)) }));
      await this.addAudit(added.map(t => auditFromTask(t, 'created', now)));
      return json({ ok: true, tasks: added.map(t => boardView(t)) });
    }
    // An agent opens a ticket for another agent (POST /api/inbox). `from` is the caller's token (set by the Worker), never the body.
    if (url.pathname === '/board/ticket' && request.method === 'POST') {
      const input = await request.json();
      const existing = this.board.find(t => t.id === input.id);
      if (existing) return existing.from === input.from && existing.agent === input.to && existing.title === input.title && (existing.note || '') === input.note
        ? json({ ok: true, duplicate: true, task: boardView(existing, now) }) : json({ ok: false, error: 'requestId conflict' }, 409);
      // same sender, same assignee, same title, still open: the same ticket, not a new one (stops accidental spam loops)
      const twin = this.board.find(t => t.source === 'agent-ticket' && t.from === input.from && t.agent === input.to && t.title === input.title && !TERMINAL.includes(t.status));
      if (twin) return json({ ok: true, duplicate: true, task: boardView(twin, now) });
      const mine = this.board.filter(t => t.source === 'agent-ticket' && t.from === input.from);
      if (mine.filter(t => !TERMINAL.includes(t.status)).length >= TICKET_OPEN_MAX) return json({ ok: false, error: 'too many open tickets from this agent (max ' + TICKET_OPEN_MAX + ')' }, 429);
      const key = 'ticketrate:' + input.from;
      const recent = ((await this.state.storage.get(key)) || []).filter(ts => now - ts < 3600_000);
      if (recent.length >= TICKET_PER_HOUR) return json({ ok: false, error: 'rate limit: max ' + TICKET_PER_HOUR + ' tickets per hour', retry_after_s: Math.max(1, Math.ceil((recent[0] + 3600_000 - now) / 1000)) }, 429);
      let depth = 0;
      if (input.parent) {
        const parent = this.board.find(t => t.id === input.parent && t.agent === input.from);
        if (!parent) return json({ ok: false, error: 'parent: not a task assigned to you' }, 400);
        depth = (parent.depth || 0) + 1;
        if (depth > TICKET_DEPTH_MAX) return json({ ok: false, error: 'ticket chain too deep (max ' + TICKET_DEPTH_MAX + ')' }, 400);
      }
      if (this.board.length + 1 > BOARD_LIMIT) return json({ ok: false, error: 'board full; archive completed requests first' }, 409);
      const task = { id: input.id, requestId: input.requestId, title: input.title, note: input.note, agent: input.to, from: input.from, ref: input.ref || '',
        source: 'agent-ticket', created: now, updated: now, status: 'queued', delivery: 'pending', result: '', link: '', attachments: [], depth, ...(input.parent ? { parent: input.parent } : {}) };
      this.board.push(task);
      recent.push(now);
      await this.state.storage.put({ ['board:' + task.id]: task, [key]: recent });
      await this.fetch(new Request('https://hub/report', { method: 'POST', body: JSON.stringify(boardReport(task)) }));
      await this.addAudit([auditFromTask(task, 'created', now)]);
      return json({ ok: true, task: boardView(task, now) });
    }
    // The owner cancels a task nobody has finished (queued, running or blocked). The agent's later reports are refused.
    if (url.pathname === '/board/cancel' && request.method === 'POST') {
      const body = await request.json(), task = this.board.find(t => t.id === body.id);
      if (!task) return json({ error: 'not found' }, 404);
      if (TERMINAL.includes(task.status)) return json({ error: 'already settled' }, 409);
      const wasRunning = task.status === 'running';
      task.status = 'cancelled'; task.updated = now; task.result = 'בוטל על ידי אורי';
      await this.state.storage.put('board:' + task.id, task);
      if (wasRunning) await this.fetch(new Request('https://hub/report', { method: 'POST', body: JSON.stringify({ ...boardReport(task, 'task.failed'), taskStatus: 'failed' }) }));
      await this.addAudit([auditFromTask(task, 'cancelled', now)]);
      this.broadcast({ type: 'agent', agent: this.agentView(this.agents.get(task.agent) || emptyAgent(task.agent, now), now) });
      return json({ ok: true, task: boardView(task, now) });
    }
    if (url.pathname === '/board/file') { // who may read / delete an uploaded file: agent='' = any assignee (owner side checks)
      const id = url.searchParams.get('id'), agent = url.searchParams.get('agent');
      const any = this.board.some(t => (t.attachments || []).some(a => a.id === id));
      const allowed = this.board.some(t => (!agent || t.agent === agent) && (t.attachments || []).some(a => a.id === id));
      return json({ attached: any, allowed });
    }
    if (url.pathname === '/board/retry' && request.method === 'POST') {
      const body = await request.json(), task = this.board.find(t => t.id === body.id);
      // retry: only after a failed send. force (re-ping): any task nobody has claimed yet.
      if (!task || task.status !== 'queued' || (task.delivery !== 'error' && !body.force)) return json({ error: 'not retryable' }, 409);
      task.delivery = 'pending'; task.deliveryNote = ''; task.updated = now;
      if (body.force) { task.pings = (task.pings || 0) + 1; task.lastPing = now; }
      await this.state.storage.put('board:' + task.id, task);
      await this.fetch(new Request('https://hub/report', { method: 'POST', body: JSON.stringify(boardReport(task)) }));
      return json({ ok: true, task: boardView(task, now) });
    }
    if (url.pathname === '/board/claim' && request.method === 'POST') {
      const body = await request.json(), task = this.board.find(t => t.id === body.id);
      if (!task || task.agent !== body.agent) return json({ error: 'not assigned' }, 403);
      if (TERMINAL.includes(task.status)) return json({ error: 'already settled' + (task.status === 'cancelled' ? ' (cancelled by the owner)' : '') }, 409);
      if (task.claimToken && task.claimToken !== body.claimToken) return json({ error: 'already claimed; do not repeat execution' }, 409);
      const first = !task.claimToken;
      task.claimToken ||= crypto.randomUUID();
      task.status = 'running'; task.updated = now;
      await this.state.storage.put('board:' + task.id, task);
      await this.fetch(new Request('https://hub/report', { method: 'POST', body: JSON.stringify(boardReport(task, 'task.start')) }));
      if (first) await this.addAudit([auditFromTask(task, 'claimed', now)]);
      return json({ ok: true, task: boardView(task), claimToken: task.claimToken });
    }
    if (url.pathname === '/board/delivery' && request.method === 'POST') {
      const body = await request.json(), task = this.board.find(t => t.id === body.id);
      if (!task) return json({ error: 'not found' }, 404);
      if (!['delivered', 'error'].includes(body.delivery)) return json({ error: 'invalid delivery' }, 400);
      if (body.delivery === 'delivered' && !/^\d+\.\d+$/.test(body.slackTs || '')) return json({ error: 'Slack receipt required' }, 400);
      task.delivery = body.delivery; task.deliveryNote = String(body.note || '').slice(0, 300);
      task.slackTs = body.slackTs || task.slackTs || ''; task.updated = now;
      await this.state.storage.put('board:' + task.id, task);
      this.broadcast({ type: 'agent', agent: this.agentView(this.agents.get(task.agent) || emptyAgent(task.agent, now), now) });
      return json({ ok: true, task: boardView(task) });
    }
    if (url.pathname === '/board/report' && request.method === 'POST') {
      const r = await request.json(), task = this.board.find(t => t.id === r.task?.id);
      if (!task || task.agent !== r.agent || !task.claimToken || task.claimToken !== r.claimToken) return json({ error: 'valid task claim required' }, 403);
      if (!['task.start', 'task.progress', 'task.done', 'task.failed'].includes(r.kind)) return json({ error: 'unsupported board event' }, 400);
      const result = String(r.note || '').trim().slice(0, 2000);
      if (['task.done', 'task.failed'].includes(r.kind) && !result) return json({ error: 'result required' }, 400);
      if (TERMINAL.includes(task.status)) {
        return ['task.done', 'task.failed'].includes(r.kind) && task.status === (r.kind === 'task.failed' ? 'failed' : r.taskStatus || 'done') && result === task.result
          ? json({ ok: true, duplicate: true }) : json({ error: 'already settled' }, 409);
      }
      task.status = r.kind === 'task.failed' ? 'failed' : r.kind === 'task.done' ? r.taskStatus || 'done' : 'running';
      task.updated = now; task.result = result || task.result;
      task.link = r.task.link || task.link;
      await this.state.storage.put('board:' + task.id, task);
      if (['task.done', 'task.failed'].includes(r.kind)) await this.addAudit([auditFromTask(task, task.status === 'failed' ? 'failed' : 'done', now)]);
      return this.fetch(new Request('https://hub/report', { method: 'POST', body: JSON.stringify(boardReport(task, r.kind)) }));
    }

    if (url.pathname === '/report' && request.method === 'POST') {
      const r = await request.json();
      const prev = this.agents.get(r.agent);
      // task.done / task.failed may name only the task id (or nothing = the current task):
      // borrow the title the agent reported at task.start so the feed reads well.
      if (/^task\./.test(r.kind) && !r.task?.title) {
        const t = r.task?.id ? prev?.tasks?.find(x => x.id === r.task.id) : prev?.current;
        if (t?.title) r.task = { ...(r.task || {}), id: r.task?.id || t.id, title: t.title, link: r.task?.link || t.link || '' };
      }
      if (r.kind === 'handoff' && r.handoff && !r.handoff.title && r.handoff.task_id) {
        const t = prev?.tasks?.find(x => x.id === r.handoff.task_id);
        if (t?.title) r.handoff = { ...r.handoff, title: t.title, link: r.handoff.link || t.link || '' };
      }
      const next = applyReport(prev, r, now);
      this.agents.set(r.agent, next);
      const writes = { ['agent:' + r.agent]: next };
      const logged = [r];
      // handoff: the receiving agent gets the task in its "to do" column, with the chain of who passed it on
      let handoff = null, receiver = null;
      if (r.kind === 'handoff' && r.handoff) {
        const h = r.handoff;
        const sent = next.tasks.find(t => t.handed_to === h.to && (t.id === h.task_id || (!h.task_id && t.title === h.title)));
        const id = h.task_id || sent?.id || 'h' + now.toString(36);
        const chain = [...(prev?.tasks?.find(t => t.id === id)?.chain || []).filter(x => x !== h.from), h.from];
        const rr = { agent: h.to, name: '', kind: 'task.queued', value: '', note: '', ts: now, task: { id, title: h.title || sent?.title || id, link: h.link || sent?.link || '', since: now }, chain };
        receiver = applyReport(this.agents.get(h.to), rr, now);
        this.agents.set(h.to, receiver);
        writes['agent:' + h.to] = receiver;
        logged.push(rr);
        handoff = { id: `${id}:${h.from}>${h.to}:${now}`, from: h.from, to: h.to, task_id: id, title: rr.task.title, note: h.note, ts: now };
      } else if (r.from_agent && /^task\.(start|queued)$/.test(r.kind)) {
        handoff = { id: `${r.task?.id || ''}:${r.from_agent}>${r.agent}:${now}`, from: r.from_agent, to: r.agent, task_id: r.task?.id || next.current?.id || '', title: r.task?.title || '', note: '', ts: now };
      }
      if (handoff) { this.handoffs = EventHub.upsert(this.handoffs, handoff, HANDOFFS_MAX); writes.handoffs = this.handoffs; }
      this.logReports(logged, now, writes);
      let ev = null;
      if (isFeedEvent(r)) {
        ev = { agent: r.agent, kind: r.kind, value: r.value, note: feedNote(r).slice(0, 140), ts: now, id: ++this.seq };
        if (r.task?.link) ev.link = r.task.link;
        // v6: what the room needs to animate a PR bell or a conversation (also replayed by GET /events)
        if (r.kind === 'pr.opened' && r.change) { ev.pr = { pr: r.change.pr, repo: r.change.repo, title: r.change.title, link: r.change.link }; if (r.change.link) ev.link = r.change.link; }
        if (r.kind === 'chat.exchange' && r.chat) { ev.chat = r.chat; if (r.chat.link) ev.link = r.chat.link; }
        this.events.push(ev);
        if (this.events.length > FEED_MAX) this.events = this.events.slice(-FEED_MAX);
        Object.assign(writes, { events: this.events, seq: this.seq });
      }
      // reviews and the "what changed today" log
      const newChanges = [];
      if (r.kind === 'review' && r.review) {
        this.reviews = EventHub.upsert(this.reviews, r.review, REVIEWS_MAX);
        writes.reviews = this.reviews;
      }
      if ((r.kind === 'pr.merged' || r.kind === 'deploy' || r.kind === 'pr.opened') && r.change) newChanges.push(r.change);
      for (const t of newlyDone(prev, next))
        newChanges.push({ id: `task:${r.agent}:${t.id || t.title}`, type: 'task.done', agent: r.agent, title: t.title || t.id, link: t.link || '', ts: t.ended });
      for (const c of newChanges) this.changes = EventHub.upsert(this.changes, c, CHANGES_MAX);
      if (newChanges.length) writes.changes = this.changes;
      await this.state.storage.put(writes);
      await this.addAudit(auditFromReport(r, now));
      if (this.dropDays?.length) {
        const keys = [];
        for (const d of this.dropDays) { keys.push('snap:' + d); for (let i = 0; i <= LOG_MAX_CHUNKS; i++) keys.push(`log:${d}:${i}`); }
        await this.state.storage.delete(keys);
        this.dropDays = null;
      }
      if (ev) this.broadcast({ type: 'event', event: ev });
      if (handoff) this.broadcast({ type: 'handoff', handoff });
      if (receiver) this.broadcast({ type: 'agent', agent: this.agentView(receiver, now) });
      if (r.kind === 'review' && r.review) this.broadcast({ type: 'review', review: r.review });
      for (const c of newChanges) this.broadcast({ type: 'change', change: c });
      this.broadcast({ type: 'agent', agent: this.agentView(next, now) });
      return json({ event: ev, agent: r.agent });
    }

    if (url.pathname === '/agents') {
      const known = (url.searchParams.get('known') || '').split(',').filter(Boolean);
      const one = url.searchParams.get('id') || '';
      if (one) {
        const a = this.agents.get(one) || (known.includes(one) ? emptyAgent(one, now) : null);
        return a ? json({ agent: this.agentView(a, now) }) : json({ error: 'unknown agent' }, 404);
      }
      const ids = new Set([...known, ...this.agents.keys()]);
      const agents = [...ids].map(id => this.agentView(this.agents.get(id) || { ...emptyAgent(id, now), firstSeen: 0 }, now));
      return json({ agents, now });
    }

    if (url.pathname === '/reviews') {
      const author = url.searchParams.get('author') || '';
      const list = author ? this.reviews.filter(r => r.author_agent === author) : this.reviews;
      return json({ reviews: list.slice(-200), now });
    }

    if (url.pathname === '/changes') {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('day') || '') ? url.searchParams.get('day') : dayOf(now);
      return json({ day, changes: changesForDay(this.changes, [...this.agents.values()], day), now });
    }

    if (url.pathname === '/replay') {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('day') || '') ? url.searchParams.get('day') : dayOf(now);
      const [start, end] = dayBounds(day);
      const snapshot = (await this.state.storage.get('snap:' + day)) || null;
      const reports = [];
      if ((this.logMeta.days || []).includes(day)) {
        const last = day === this.logMeta.day ? this.logMeta.chunk : LOG_MAX_CHUNKS;
        const keys = Array.from({ length: last + 1 }, (_, i) => `log:${day}:${i}`);
        const got = await this.state.storage.get(keys);
        for (const k of keys) if (got.get(k)) reports.push(...got.get(k));
      }
      return json({ day, start, end, now, snapshot: snapshot || {}, reports, handoffs: this.handoffs.filter(x => x.ts >= start && x.ts < end) });
    }

    if (url.pathname === '/summary') {
      const raw = url.searchParams.get('since');
      const parsed = raw ? (/^\d+$/.test(raw) ? Number(raw) : Date.parse(raw)) : NaN;
      const since = Number.isFinite(parsed) && parsed > 0 && parsed < now ? parsed : overnightSince(now);
      const known = (url.searchParams.get('known') || '').split(',').filter(Boolean);
      const ids = new Set([...known, ...this.agents.keys()]);
      const agents = [...ids].map(id => this.agentView(this.agents.get(id) || { ...emptyAgent(id, now), firstSeen: 0 }, now)).map(v => ({ ...v, tasks: (this.agents.get(v.id)?.tasks || []) }));
      const s = buildSummary({ agents, changes: this.changes, reviews: this.reviews, since, until: now });
      if (url.searchParams.get('format') === 'text') return new Response(s.text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      return json(s);
    }

    if (url.pathname === '/handoffs') return json({ handoffs: this.handoffs.slice(-100), now });

    if (url.pathname === '/list') {
      const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
      return json({ events: this.events.filter(e => e.id > since), lastId: this.seq });
    }

    if (url.pathname === '/login-guard') {
      const f = await this.state.storage.get('fail:' + url.searchParams.get('ip'));
      const blocked = !!f && now - f.t < LOGIN_WINDOW_MS && f.n >= LOGIN_MAX_FAILS;
      return json({ blocked });
    }
    if (url.pathname === '/login-fail') {
      const key = 'fail:' + url.searchParams.get('ip');
      const f = await this.state.storage.get(key);
      const next = f && now - f.t < LOGIN_WINDOW_MS ? { n: f.n + 1, t: f.t } : { n: 1, t: now };
      await this.state.storage.put(key, next);
      return json({ n: next.n });
    }

    if ((request.headers.get('Upgrade') || '') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('not found', { status: 404 });
  }
}
