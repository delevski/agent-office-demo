// server/hub.js — the one Durable Object (SQLite-backed, free plan) behind the office.
// Storage keys:  events, seq (feed, unchanged)  ·  agent:<id> (per-agent live state)
//                reviews (code reviews, newest last)  ·  changes (merged PRs, deploys, closed tasks)
//                fail:<ip> (login throttle)
import { applyReport, feedNote, isFeedEvent, publicView, emptyAgent, newlyDone, dayOf } from './agents.js';
import { changesForDay } from '../insights.js';

const FEED_MAX = 200;
const REVIEWS_MAX = 300;
const CHANGES_MAX = 400;
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
      const next = applyReport(prev, r, now);
      this.agents.set(r.agent, next);
      const writes = { ['agent:' + r.agent]: next };
      let ev = null;
      if (isFeedEvent(r)) {
        ev = { agent: r.agent, kind: r.kind, value: r.value, note: feedNote(r).slice(0, 140), ts: now, id: ++this.seq };
        if (r.task?.link) ev.link = r.task.link;
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
      if ((r.kind === 'pr.merged' || r.kind === 'deploy') && r.change) newChanges.push(r.change);
      for (const t of newlyDone(prev, next))
        newChanges.push({ id: `task:${r.agent}:${t.id || t.title}`, type: 'task.done', agent: r.agent, title: t.title || t.id, link: t.link || '', ts: t.ended });
      for (const c of newChanges) this.changes = EventHub.upsert(this.changes, c, CHANGES_MAX);
      if (newChanges.length) writes.changes = this.changes;
      await this.state.storage.put(writes);
      if (ev) this.broadcast({ type: 'event', event: ev });
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
