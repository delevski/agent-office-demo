// server/auth.js — Ori's login (one password -> long signed session cookie) and per-agent
// write tokens. No secret lives in code: everything is read from Worker env (secrets / .dev.vars).
//
//   OFFICE_PASSWORD        the one login password (required for login)
//   SESSION_SECRET         optional HMAC key for session cookies; when unset the key is derived
//                          from OFFICE_PASSWORD, so changing the password logs every browser out
//   AGENT_TOKEN_<ID>       per-agent write token, e.g. AGENT_TOKEN_TAB, AGENT_TOKEN_INSTINCT,
//                          AGENT_TOKEN_HERMES. The token decides which agent you are.
//   INGEST_TOKEN           legacy shared token (X-Ingest-Token), may write as any agent

export const COOKIE = 'ao_session';
export const SESSION_DAYS = 180;

const enc = new TextEncoder();

function b64url(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Constant-time string comparison (length is not secret here). */
export function safeEqual(a, b) {
  a = enc.encode(String(a ?? '')); b = enc.encode(String(b ?? ''));
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0 && a.length > 0;
}

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

function sessionKey(env) {
  if (env.SESSION_SECRET) return 'ao-session:' + env.SESSION_SECRET;
  if (env.OFFICE_PASSWORD) return 'ao-password:' + env.OFFICE_PASSWORD;
  return '';
}

export function loginConfigured(env) {
  return !!env.OFFICE_PASSWORD;
}

export function checkPassword(env, password) {
  return loginConfigured(env) && safeEqual(password, env.OFFICE_PASSWORD);
}

/** Cookie value: "v1.<expiry-ms>.<hmac>". */
export async function makeSession(env, now = Date.now()) {
  const exp = now + SESSION_DAYS * 86400_000;
  const body = `v1.${exp}`;
  return `${body}.${await hmac(sessionKey(env), body)}`;
}

export async function verifySession(env, value, now = Date.now()) {
  const key = sessionKey(env);
  if (!key || !value) return false;
  const parts = String(value).split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < now) return false;
  return safeEqual(parts[2], await hmac(key, `v1.${exp}`));
}

export function readCookie(request, name = COOKIE) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

export function sessionCookie(value, secure, maxAge = SESSION_DAYS * 86400) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export async function isLoggedIn(request, env) {
  return verifySession(env, readCookie(request));
}

/** Agent ids that have a write token configured (AGENT_TOKEN_TAB -> "tab"). */
export function tokenAgents(env) {
  return Object.keys(env || {})
    .filter(k => /^AGENT_TOKEN_[A-Z0-9_]+$/.test(k) && env[k])
    .map(k => k.slice('AGENT_TOKEN_'.length).toLowerCase().replace(/_/g, '-'));
}

/**
 * Who may write this report?
 *   { ok: true, agent: "tab" }   per-agent bearer token -> that agent only
 *   { ok: true, agent: null }    legacy INGEST_TOKEN -> any agent named in the body
 *   { ok: false }                anything else
 */
export function writerFor(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() || '';
  if (bearer) {
    let hit = null;
    for (const k of Object.keys(env || {})) {
      if (!/^AGENT_TOKEN_[A-Z0-9_]+$/.test(k) || !env[k]) continue;
      if (safeEqual(bearer, env[k])) hit = k.slice('AGENT_TOKEN_'.length).toLowerCase().replace(/_/g, '-');
    }
    return hit ? { ok: true, agent: hit } : { ok: false };
  }
  const legacy = request.headers.get('X-Ingest-Token') || '';
  if (legacy && env.INGEST_TOKEN && safeEqual(legacy, env.INGEST_TOKEN)) return { ok: true, agent: null };
  return { ok: false };
}
