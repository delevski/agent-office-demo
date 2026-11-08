// server/hub.js — the one Durable Object (SQLite-backed, free plan) behind the office.
// Storage keys:  events, seq (feed, unchanged)  ·  agent:<id> (per-agent live state)
//                reviews (code reviews, newest last)  ·  changes (merged PRs, deploys, closed tasks)
//                fail:<ip> (login throttle)
import { applyReport, feedNote, isFeedEvent, publicView, emptyAgent, newlyDone, dayOf } from './agents.js';
import { changesForDay, buildSummary, overnightSince, dayBounds } from '../insights.js';

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
  const { errors, ...rest } = r;
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
      this.agents = new Map();
      const rows = await this.state.storage.list({ prefix: 'agent:' });
      for (const [k, v] of rows) this.agents.set(k.slice(6), v);
    });
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

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();

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
      if (this.dropDays?.length) {
        const keys = [];
        for (const d of this.dropDays) { keys.push('snap:' + d); for (let i = 0; i <= LOG_MAX_CHUNKS; i++) keys.push(`log:${d}:${i}`); }
        await this.state.storage.delete(keys);
        this.dropDays = null;
      }
      if (ev) this.broadcast({ type: 'event', event: ev });
      if (handoff) this.broadcast({ type: 'handoff', handoff });
      if (receiver) this.broadcast({ type: 'agent', agent: publicView(receiver, now) });
      if (r.kind === 'review' && r.review) this.broadcast({ type: 'review', review: r.review });
      for (const c of newChanges) this.broadcast({ type: 'change', change: c });
      this.broadcast({ type: 'agent', agent: publicView(next, now) });
      return json({ event: ev, agent: r.agent });
    }

    if (url.pathname === '/agents') {
      const known = (url.searchParams.get('known') || '').split(',').filter(Boolean);
      const one = url.searchParams.get('id') || '';
      if (one) {
        const a = this.agents.get(one) || (known.includes(one) ? emptyAgent(one, now) : null);
        return a ? json({ agent: publicView(a, now) }) : json({ error: 'unknown agent' }, 404);
      }
      const ids = new Set([...known, ...this.agents.keys()]);
      const agents = [...ids].map(id => publicView(this.agents.get(id) || { ...emptyAgent(id, now), firstSeen: 0 }, now));
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
      const agents = [...ids].map(id => publicView(this.agents.get(id) || { ...emptyAgent(id, now), firstSeen: 0 }, now)).map(v => ({ ...v, tasks: (this.agents.get(v.id)?.tasks || []) }));
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
