// Read-only presentation aliases. Never use this projection for writes or authentication.
export const DISPLAY_NAMES = Object.freeze({ tab: 'tobi', instinct: 'inna' });
export function displayName(id, fallback = id) { return DISPLAY_NAMES[id] || fallback; }
export function displayText(value) {
  // Protect links, code spans and machine identifiers. Only exact old proper names in prose change.
  return String(value ?? '').split(/(https?:\/\/[^\s<>]+|`[^`]*`|[\w./:@-]*[/_@][\w./:@-]*)/g)
    .map((part, i) => i % 2 ? part : part.replace(/\b(?:Tab|Instinct)\b/g, name => name === 'Tab' ? 'tobi' : 'inna')).join('');
}
const TEXT_FIELDS = new Set(['title', 'note', 'text', 'summary', 'result', 'description', 'deliveryNote', 'topic', 'agreed']);
export function displayRecord(value) {
  if (Array.isArray(value)) return value.map(displayRecord);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key,
    key === 'name' && (value.id in DISPLAY_NAMES) ? displayName(value.id, v) :
    TEXT_FIELDS.has(key) && typeof v === 'string' ? displayText(v) :
    v && typeof v === 'object' ? displayRecord(v) : v]));
}
