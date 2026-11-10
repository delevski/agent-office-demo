// Task attachments (Cloudflare R2, binding FILES) and voice transcription (Workers AI, binding AI).
// Both are optional: without the binding the endpoint answers 501 and the page hides/degrades the feature.
// Files are private: the owner (login cookie) uploads and reads; an agent reads only files attached to a task assigned
// to it (Bearer per-agent token, Instinct's relay token reads all, like /api/inbox?relay=1). Nothing is served publicly.
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 5;
export const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
export const FILE_ID = /^f-[a-f0-9]{32}$/;
const PREFIX = 'files/';

const TEXT_TYPES = new Set(['text/plain', 'text/csv', 'text/tab-separated-values', 'text/markdown', 'application/json']);
const INLINE = /^(image\/(png|jpeg|gif|webp)|application\/pdf|audio\/(ogg|webm|mp4|mpeg|wav|x-wav))$/;
const OFFICE = /^application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)$/;

const ascii = (b, from, s) => [...s].every((c, i) => b[from + i] === c.charCodeAt(0));
// Content-type from the bytes, not from what the browser claims. Anything that could run in a browser (html, svg, js)
// is demoted to text/plain and is always served as a download.
export function sniffType(bytes, declared = '', name = '') {
  const b = bytes, decl = String(declared || '').split(';')[0].trim().toLowerCase();
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 'PNG')) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && ascii(b, 0, 'GIF8')) return 'image/gif';
  if (b.length >= 12 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'image/webp';
  if (b.length >= 12 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE')) return 'audio/wav';
  if (b.length >= 5 && ascii(b, 0, '%PDF-')) return 'application/pdf';
  if (b.length >= 4 && ascii(b, 0, 'OggS')) return 'audio/ogg';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return decl.startsWith('video/') ? 'video/webm' : 'audio/webm';
  if (b.length >= 12 && ascii(b, 4, 'ftyp')) return decl.startsWith('video/') ? 'video/mp4' : decl === 'audio/mp4' || decl === 'audio/x-m4a' ? 'audio/mp4' : 'video/mp4';
  if (b.length >= 3 && (ascii(b, 0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))) return 'audio/mpeg';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4) return OFFICE.test(decl) ? decl : 'application/zip';
  if (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'application/octet-stream'; // legacy .doc/.xls
  const head = b.subarray(0, 4096);
  if (!head.includes(0)) { // looks like text
    let ok = true;
    try { new TextDecoder('utf-8', { fatal: true }).decode(head.length === 4096 ? head.subarray(0, 4090) : head); } catch { ok = false; }
    if (ok) {
      if (/\.csv$/i.test(name) || decl === 'text/csv') return 'text/csv';
      if (/\.json$/i.test(name) || decl === 'application/json') return 'application/json';
      if (/\.md$/i.test(name) || decl === 'text/markdown') return 'text/markdown';
      if (/\.tsv$/i.test(name) || decl === 'text/tab-separated-values') return 'text/tab-separated-values';
      return 'text/plain';
    }
  }
  return 'application/octet-stream';
}
export function safeName(raw) {
  let n = String(raw || '').replace(/[\u0000-\u001f\u007f"\\/<>:*?|]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s.]+/, '').trim();
  if (n.length > 120) { const m = /(\.[A-Za-z0-9]{1,8})$/.exec(n); n = n.slice(0, 110) + (m ? m[1] : ''); }
  return n || 'file';
}
function reply(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
function randomId() {
  const a = crypto.getRandomValues(new Uint8Array(16));
  return 'f-' + [...a].map(x => x.toString(16).padStart(2, '0')).join('');
}
export const filesConfigured = env => !!(env.FILES && typeof env.FILES.put === 'function');
export const aiConfigured = env => !!(env.AI && typeof env.AI.run === 'function');

export async function uploadFile(request, env) {
  if (!filesConfigured(env)) return reply({ ok: false, error: 'uploads not configured' }, 501);
  const declaredLen = Number(request.headers.get('Content-Length') || 0);
  if (declaredLen > MAX_FILE_BYTES) return reply({ ok: false, error: 'file too large', limit: MAX_FILE_BYTES }, 413);
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return reply({ ok: false, error: 'empty file' }, 400);
  if (buf.byteLength > MAX_FILE_BYTES) return reply({ ok: false, error: 'file too large', limit: MAX_FILE_BYTES }, 413);
  let name = '';
  try { name = decodeURIComponent(request.headers.get('X-File-Name') || ''); } catch { name = ''; }
  name = safeName(name);
  const type = sniffType(new Uint8Array(buf), request.headers.get('Content-Type') || '', name);
  const id = randomId();
  await env.FILES.put(PREFIX + id, buf, { httpMetadata: { contentType: type }, customMetadata: { name, type, size: String(buf.byteLength), at: String(Date.now()) } });
  return reply({ ok: true, file: { id, name, type, size: buf.byteLength } });
}

// Resolve the ids the owner attached to a new task into stored metadata (never trusts names/sizes from the client).
export async function resolveAttachments(env, ids, origin) {
  if (!ids.length) return { ok: true, list: [] };
  if (!filesConfigured(env)) return { ok: false, error: 'uploads not configured' };
  const list = [];
  for (const id of ids) {
    const head = await env.FILES.head(PREFIX + id);
    if (!head) return { ok: false, error: 'attachment not found: ' + id };
    const m = head.customMetadata || {};
    list.push({ id, name: safeName(m.name), type: m.type || head.httpMetadata?.contentType || 'application/octet-stream', size: Number(m.size) || head.size || 0, url: origin + '/api/files/' + id });
  }
  return { ok: true, list };
}

export async function deleteFile(env, id) {
  if (!filesConfigured(env)) return reply({ ok: false, error: 'uploads not configured' }, 501);
  await env.FILES.delete(PREFIX + id);
  return reply({ ok: true });
}

export async function serveFile(env, id) {
  if (!filesConfigured(env)) return reply({ ok: false, error: 'uploads not configured' }, 501);
  const obj = await env.FILES.get(PREFIX + id);
  if (!obj) return reply({ ok: false, error: 'not found' }, 404);
  const m = obj.customMetadata || {};
  const type = m.type || obj.httpMetadata?.contentType || 'application/octet-stream';
  const name = safeName(m.name);
  const inline = INLINE.test(type);
  return new Response(obj.body, { headers: {
    'Content-Type': type,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-store',
    'Content-Length': String(obj.size ?? ''),
  } });
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
// Hebrew speech-to-text through Workers AI (binding AI). 501 when the binding is absent: the page then keeps the audio.
export async function transcribe(request, env) {
  if (!aiConfigured(env)) return reply({ ok: false, error: 'transcription not configured' }, 501);
  if (Number(request.headers.get('Content-Length') || 0) > MAX_AUDIO_BYTES) return reply({ ok: false, error: 'audio too large', limit: MAX_AUDIO_BYTES }, 413);
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return reply({ ok: false, error: 'empty audio' }, 400);
  if (buf.byteLength > MAX_AUDIO_BYTES) return reply({ ok: false, error: 'audio too large', limit: MAX_AUDIO_BYTES }, 413);
  const bytes = new Uint8Array(buf);
  const model = env.AI_WHISPER_MODEL || '@cf/openai/whisper-large-v3-turbo';
  let out;
  try { out = await env.AI.run(model, { audio: toBase64(bytes), language: 'he', task: 'transcribe' }); }
  catch {
    if (bytes.length > 4 * 1024 * 1024) return reply({ ok: false, error: 'transcription failed' }, 502);
    try { out = await env.AI.run('@cf/openai/whisper', { audio: [...bytes] }); }
    catch { return reply({ ok: false, error: 'transcription failed' }, 502); }
  }
  const text = String(out?.text || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
  return reply({ ok: true, text });
}
