// worker.js — Agent Office backend: static assets + realtime event ingestion + Ori's login.
// Routes:
//   POST /api/ingest                 agent report (Bearer per-agent token, or legacy X-Ingest-Token)
//   POST /api/agents/:id/heartbeat   full snapshot from one agent (Bearer token of that agent)
//   POST /api/login  {password}      -> sets the long-lived signed session cookie
//   POST /api/logout                 -> clears it
//   GET  /api/me                     -> {loggedIn, loginConfigured}
//   GET  /api/agents                 (session) all agents' live state
//   GET  /api/agents/:id             (session) one agent
//   GET  /api/events?since=N         (session) polling fallback / catch-up
//   GET  /api/reviews[?author=id]    (session) code reviews (kind "review")
//   GET  /api/changes[?day=YYYY-MM-DD] (session) what changed today: merged PRs, deploys, closed tasks
//   GET  /api/replay[?day=YYYY-MM-DD]  (session) the day's reports + a start-of-day snapshot, for the replay
//   GET  /api/summary[?since=ISO|ms][&format=text] (session OR any agent token) the overnight digest
//   POST /api/tasks {title, agent, note}  (session) "give a task": adds a card to that agent's to-do column.
//                                          Creates durable per-agent inbox requests (idempotent requestId).
//   GET  /api/ws                     (session) WebSocket live stream
//   GET  /showcase                   public, embeddable demo-only view (same page, ?showcase mode)
//   everything else                  -> static assets (the site; demo mode needs no login)

import { normalizeReport, agentId } from './server/agents.js';
import {
  checkPassword, isLoggedIn, loginConfigured, makeSession, sessionCookie, tokenAgents, writerFor,
} from './server/auth.js';

export { EventHub } from './server/hub.js';
import { parseBoardTask } from './server/board.js';
import { notifyInstinct } from './server/notify.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Ingest-Token',
};

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...headers },
  });
}
// Private reads carry no CORS header: only the office page itself (same origin) can read them.
function privateJson(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function hub(env) {
  return env.HUB.get(env.HUB.idFromName('global'));
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 32_000) throw new Error('too large');
  return JSON.parse(text || '{}');
}

async function ingest(request, env, forcedAgent = null) {
  const who = writerFor(request, env);
  if (!who.ok) return json({ ok: false, error: 'unauthorized' }, 401);
  let body;
  try { body = await readJson(request); } catch { return json({ ok: false, error: 'invalid json' }, 400); }
  if (forcedAgent) { body.agent = forcedAgent; body.kind = 'heartbeat'; }
  // A per-agent token may only write as its own agent.
  if (who.agent) {
    if (body.agent && agentId(body.agent) !== who.agent) return json({ ok: false, error: 'token does not match agent' }, 403);
    body.agent = who.agent;
  }
  const report = normalizeReport(body);
  // review / pr.merged / deploy are validated; the original kinds never are (backward compatible)
  if (report.errors) return json({ ok: false, error: 'invalid ' + report.kind, details: report.errors }, 400);
  if (!report.agent) report.agent = 'unknown';
  // Board lifecycle reports require the assigned agent's token and its claim receipt.
  const route = report.task?.id?.startsWith('board-') ? '/board/report' : '/report';
  if (route === '/board/report' && who.agent !== report.agent) return json({ ok: false, error: 'per-agent token required' }, 403);
  const res = await hub(env).fetch('https://hub' + route, { method: 'POST', body: JSON.stringify({ ...report, ...(route === '/board/report' ? { note: typeof body.note === 'string' ? body.note.slice(0, 2000) : '' } : {}), claimToken: body.claimToken }) });
  return json({ ok: res.ok, ...(await res.json()) }, res.status);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    /* ---- writes from agents ---- */
    if (path === '/api/ingest' && request.method === 'POST') return ingest(request, env);
    const hb = /^\/api\/agents\/([^/]+)\/heartbeat$/.exec(path);
    if (hb && request.method === 'POST') return ingest(request, env, agentId(decodeURIComponent(hb[1])));

    /* ---- login ---- */
    if (path === '/api/login' && request.method === 'POST') {
      if (!loginConfigured(env)) return privateJson({ ok: false, error: 'login not configured' }, 503);
      const ip = request.headers.get('CF-Connecting-IP') || 'local';
      const guard = await (await hub(env).fetch('https://hub/login-guard?ip=' + encodeURIComponent(ip))).json();
      if (guard.blocked) return privateJson({ ok: false, error: 'too many attempts' }, 429);
      let body = {};
      try { body = await readJson(request); } catch { /* empty */ }
      if (!checkPassword(env, body.password)) {
        await hub(env).fetch('https://hub/login-fail?ip=' + encodeURIComponent(ip), { method: 'POST' });
        return privateJson({ ok: false, error: 'wrong password' }, 401);
      }
      const cookie = sessionCookie(await makeSession(env), url.protocol === 'https:');
      return privateJson({ ok: true }, 200, { 'Set-Cookie': cookie });
    }
    if (path === '/api/logout' && request.method === 'POST') {
      return privateJson({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', url.protocol === 'https:', 0) });
    }
    if (path === '/api/me') {
      return privateJson({ loggedIn: await isLoggedIn(request, env), loginConfigured: loginConfigured(env) });
    }

    /* ---- morning summary: Ori, or any agent / cron holding a write token (to post it somewhere) ---- */
    if (path === '/api/summary' && request.method === 'GET') {
      if (!(await isLoggedIn(request, env)) && !writerFor(request, env).ok) return privateJson({ ok: false, error: 'login or agent token required' }, 401);
      const qs = new URLSearchParams(url.search);
      qs.set('known', tokenAgents(env).join(','));
      const res = await hub(env).fetch('https://hub/summary?' + qs.toString());
      return new Response(res.body, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' } });
    }

    /* ---- owner requests and per-agent inboxes ---- */
    if (path === '/api/tasks' && request.method === 'POST') {
      if (!(await isLoggedIn(request, env))) return privateJson({ ok: false, error: 'login required' }, 401);
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) return privateJson({ ok: false, error: 'bad origin' }, 403);
      let body;
      try { body = await readJson(request); } catch { return privateJson({ ok: false, error: 'invalid json' }, 400); }
      const parsed = parseBoardTask(body, tokenAgents(env));
      if (parsed.errors.length) return privateJson({ ok: false, error: 'invalid task', details: parsed.errors }, 400);
      const res = await hub(env).fetch('https://hub/board/create', { method: 'POST', body: JSON.stringify(parsed) });
      const out = await res.json();
      // Instant wake for Instinct: only for newly created owner-session tasks (never for duplicates). Poll stays as backup.
      if (res.ok && !out.duplicate && Array.isArray(out.tasks)) {
        const job = notifyInstinct(env, out.tasks, hub(env));
        if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
      }
      return privateJson(out, res.status);
    }
    if (path === '/api/tasks' && request.method === 'GET') {
      if (!(await isLoggedIn(request, env))) return privateJson({ ok: false, error: 'login required' }, 401);
      const res = await hub(env).fetch('https://hub/board/list');
      return privateJson(await res.json(), res.status);
    }
    const retry = /^\/api\/tasks\/(board-[a-zA-Z0-9-]+)\/retry$/.exec(path);
    if (retry && request.method === 'POST') {
      if (!(await isLoggedIn(request, env))) return privateJson({ error: 'login required' }, 401);
      if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return privateJson({ error: 'bad origin' }, 403);
      const res = await hub(env).fetch('https://hub/board/retry', { method: 'POST', body: JSON.stringify({ id: retry[1] }) });
      return privateJson(await res.json(), res.status);
    }
    const inbox = /^\/api\/inbox(?:\/(board-[a-zA-Z0-9-]+)\/(claim|delivery))?$/.exec(path);
    if (inbox) {
      const who = writerFor(request, env);
      if (!who.ok || !who.agent) return privateJson({ ok: false, error: 'per-agent token required' }, 401);
      if (request.method === 'GET' && !inbox[1]) {
        const relay = url.searchParams.get('relay') === '1';
        if (relay && who.agent !== 'instinct') return privateJson({ ok: false, error: 'relay forbidden' }, 403);
        const res = await hub(env).fetch('https://hub/board/list?agent=' + (relay ? '' : who.agent));
        return privateJson(await res.json(), res.status);
      }
      if (request.method === 'POST' && inbox[1]) {
        let body;
        try { body = await readJson(request); } catch { return privateJson({ ok: false, error: 'invalid json' }, 400); }
        if (inbox[2] === 'delivery' && who.agent !== 'instinct') return privateJson({ ok: false, error: 'relay forbidden' }, 403);
        const res = await hub(env).fetch('https://hub/board/' + inbox[2], { method: 'POST', body: JSON.stringify({ ...body, id: inbox[1], agent: who.agent }) });
        return privateJson(await res.json(), res.status);
      }
      return privateJson({ ok: false, error: 'method not allowed' }, 405);
    }

    /* ---- private reads: Ori only ---- */
    if (path.startsWith('/api/')) {
      if (!(await isLoggedIn(request, env))) return privateJson({ ok: false, error: 'login required' }, 401);

      if (path === '/api/agents' || /^\/api\/agents\/[^/]+$/.test(path)) {
        const one = path === '/api/agents' ? '' : agentId(decodeURIComponent(path.split('/')[3]));
        const known = encodeURIComponent(tokenAgents(env).join(','));
        const res = await hub(env).fetch(`https://hub/agents?known=${known}&id=${encodeURIComponent(one)}`);
        return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
      if (path === '/api/reviews' || path === '/api/changes' || path === '/api/replay' || path === '/api/handoffs') {
        const res = await hub(env).fetch('https://hub' + path.slice(4) + (url.search || ''));
        return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
      if (path === '/api/events') {
        const res = await hub(env).fetch('https://hub/list' + (url.search || ''));
        return new Response(res.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
      if (path === '/api/ws') {
        if ((request.headers.get('Upgrade') || '') !== 'websocket')
          return new Response('expected websocket upgrade', { status: 426 });
        return hub(env).fetch(request);
      }
      return privateJson({ ok: false, error: 'not found' }, 404);
    }

    /* ---- public showcase: the same page in demo-only mode, embeddable in an iframe ---- */
    if (path === '/showcase' || path === '/showcase/') {
      const res = await env.ASSETS.fetch(new Request(new URL('/', url), request));
      const headers = new Headers(res.headers);
      headers.set('Content-Security-Policy', 'frame-ancestors *');
      headers.delete('X-Frame-Options');
      headers.set('Cache-Control', 'public, max-age=300');
      return new Response(res.body, { status: res.status, headers });
    }

    return env.ASSETS.fetch(request);
  },
};
