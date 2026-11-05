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
//   GET  /api/ws                     (session) WebSocket live stream
//   GET  /showcase                   public, embeddable demo-only view (same page, ?showcase mode)
//   everything else                  -> static assets (the site; demo mode needs no login)

import { normalizeReport, agentId } from './server/agents.js';
import {
  checkPassword, isLoggedIn, loginConfigured, makeSession, sessionCookie, tokenAgents, writerFor,
} from './server/auth.js';

export { EventHub } from './server/hub.js';

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
  const res = await hub(env).fetch('https://hub/report', { method: 'POST', body: JSON.stringify(report) });
  return json({ ok: true, ...(await res.json()) });
}

export default {
  async fetch(request, env) {
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

    /* ---- private reads: Ori only ---- */
    if (path.startsWith('/api/')) {
      if (!(await isLoggedIn(request, env))) return privateJson({ ok: false, error: 'login required' }, 401);

      if (path === '/api/agents' || /^\/api\/agents\/[^/]+$/.test(path)) {
        const one = path === '/api/agents' ? '' : agentId(decodeURIComponent(path.split('/')[3]));
        const known = encodeURIComponent(tokenAgents(env).join(','));
        const res = await hub(env).fetch(`https://hub/agents?known=${known}&id=${encodeURIComponent(one)}`);
        return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
      if (path === '/api/reviews' || path === '/api/changes') {
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
