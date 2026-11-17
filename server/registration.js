// server/registration.js — self-service agent registration.
// The owner creates a one-time invite link in the office; the invited agent (or its runtime)
// exchanges it at POST /api/register for its own dedicated write token. Invite secrets and
// agent tokens are stored as SHA-256 hashes in the Durable Object; each plaintext crosses the
// wire exactly once (the invite URL to the owner, the token in the register response) and is
// never logged. Existing env-token agents (AGENT_TOKEN_<ID>) are untouched and always win
// over a dynamic id.

export const INVITE_ID_LEN = 16;        // hex chars
export const INVITE_SECRET_LEN = 32;    // hex chars
export const TOKEN_PREFIX = 'aot_';
export const TOKEN_LEN = 48;            // hex chars after the prefix
export const INVITE_TTL_DEFAULT = 7 * 86400_000;
export const INVITE_TTL_MAX = 7 * 86400_000;
export const INVITE_TTL_MIN = 3600_000;
export const MAX_PENDING_INVITES = 20;
export const MAX_DYNAMIC_AGENTS = 50;
export const INVITE_FAILS_LOCK = 10;    // wrong-secret attempts before the invite locks
export const REGISTER_WINDOW_MS = 15 * 60 * 1000;
export const REGISTER_IP_MAX = 20;      // register attempts per IP per window
export const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
export const RESERVED_IDS = ['all', 'unknown', 'legacy', 'office', 'owner', 'ori', 'system', 'admin', 'demo'];

export function randHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function parseInviteKey(key) {
  const m = new RegExp(`^([a-f0-9]{${INVITE_ID_LEN}})-([a-f0-9]{${INVITE_SECRET_LEN}})$`).exec(String(key || ''));
  return m ? { id: m[1], secret: m[2] } : null;
}

/** Display name -> agent id ("Grok 4" -> "grok-4"); '' when nothing usable remains. */
export function normalizeAgentId(raw) {
  return String(raw || '').trim().toLowerCase()
    .replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
}

export function validAgentId(id, taken = []) {
  if (!AGENT_ID_RE.test(id) || id.startsWith('board-')) return false;
  if (RESERVED_IDS.includes(id)) return false;
  return !taken.includes(id);
}

export function inviteState(inv, now = Date.now()) {
  if (!inv) return 'notfound';
  if (inv.revoked) return 'revoked';
  if (inv.used) return 'registered';
  if ((inv.fails || 0) >= INVITE_FAILS_LOCK) return 'locked';
  if (inv.expires <= now) return 'expired';
  return 'pending';
}

/** Safe public/owner view: never the secret hash. */
export function inviteView(inv, now = Date.now()) {
  return { id: inv.id, agent: inv.agent, name: inv.name, board: !!inv.board, created: inv.created, expires: inv.expires, state: inviteState(inv, now) };
}

export function dynView(d) {
  return { id: d.id, name: d.name, board: !!d.board, created: d.created, disabled: !!d.disabled };
}
