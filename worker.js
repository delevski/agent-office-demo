// worker.js — Agent Office backend: static assets + realtime event ingestion.
// Routes:
//   POST /api/ingest   (X-Ingest-Token auth) -> validate, store, broadcast
//   GET  /api/events?since=N                 -> polling fallback / catch-up
//   GET  /api/ws       (WebSocket upgrade)   -> live event stream
//   everything else                          -> static assets (the site)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Ingest-Token',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

function sanitize(body) {
  const s = (v, n) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
  return {
    agent: s(body.agent, 40) || 'unknown',
    kind: s(body.kind, 40) || 'event',
    value: s(body.value, 60),
    note: s(body.note, 140),
    ts: Date.now(),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/api/ingest' && request.method === 'POST') {
      const token = request.headers.get('X-Ingest-Token') || '';
      if (!env.INGEST_TOKEN || token !== env.INGEST_TOKEN)
        return json({ ok: false, error: 'unauthorized' }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid json' }, 400); }
      const stub = env.HUB.get(env.HUB.idFromName('global'));
      const res = await stub.fetch('https://hub/append', { method: 'POST', body: JSON.stringify(sanitize(body)) });
      return json({ ok: true, event: await res.json() });
    }

    if (url.pathname === '/api/events') {
      const stub = env.HUB.get(env.HUB.idFromName('global'));
      const res = await stub.fetch('https://hub/list' + (url.search || ''));
      return new Response(res.body, { headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    if (url.pathname === '/api/ws') {
      if ((request.headers.get('Upgrade') || '') !== 'websocket')
        return new Response('expected websocket upgrade', { status: 426 });
      const stub = env.HUB.get(env.HUB.idFromName('global'));
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

export class EventHub {
  constructor(state) {
    this.state = state;
    this.state.blockConcurrencyWhile(async () => {
      this.events = (await this.state.storage.get('events')) || [];
      this.seq = (await this.state.storage.get('seq')) || 0;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/append') {
      const ev = await request.json();
      ev.id = ++this.seq;
      this.events.push(ev);
      if (this.events.length > 200) this.events = this.events.slice(-200);
      await this.state.storage.put({ events: this.events, seq: this.seq });
      const msg = JSON.stringify({ type: 'event', event: ev });
      for (const ws of this.state.getWebSockets()) {
        try { ws.send(msg); } catch { /* dropped */ }
      }
      return json(ev);
    }

    if (url.pathname === '/list') {
      const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
      return json({ events: this.events.filter(e => e.id > since), lastId: this.seq });
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
