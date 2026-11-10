// Durable owner-submitted requests. Agent reports cannot create a trusted board request.
import { notPickedUp } from '../board-state.js';
import { FILE_ID, MAX_FILES } from './files.js';
export const BOARD_AGENTS = ['instinct', 'hermes', 'tab'];
export const BOARD_LIMIT = 300;
export const TERMINAL = ['done', 'failed', 'cancelled']; // a settled task takes no more claims or reports
// Agent-to-agent tickets (POST /api/inbox): limits per sending agent.
export const TICKET_PER_HOUR = 10;
export const TICKET_OPEN_MAX = 20;
export const TICKET_DEPTH_MAX = 3;
export const TICKET_NOTE_MAX = 1000;
export const NOTE_MAX = 1500; // was 300: dictated notes and file descriptions need room
export function parseBoardTask(body, known) {
  const title = typeof body?.title === 'string' ? body.title.trim().replace(/\s+/g, ' ') : '';
  const note = typeof body?.note === 'string' ? body.note.trim() : '';
  const agents = body?.agent === 'all' ? BOARD_AGENTS : [body?.agent];
  const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
  const attachments = Array.isArray(body?.attachments) ? [...new Set(body.attachments.map(String))] : [];
  const errors = [];
  if (!title || title.length > 160) errors.push('title: required, max 160');
  if (note.length > NOTE_MAX) errors.push('note: max ' + NOTE_MAX);
  if (attachments.length > MAX_FILES || attachments.some(id => !FILE_ID.test(id))) errors.push('attachments: max ' + MAX_FILES + ' valid ids');
  if (agents.some(a => !BOARD_AGENTS.includes(a) || !known.includes(a))) errors.push('agent: unavailable');
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) errors.push('requestId: required');
  return { title, note, agents, requestId, attachments, errors };
}
export function boardView(task, now = Date.now()) {
  const { claimToken, ...view } = task;
  return { ...view, stale: ['running', 'queued'].includes(task.status) && now - task.updated > 30 * 60_000, unclaimed: notPickedUp(task, now) };
}
export function boardReport(task, kind = 'task.queued') {
  const status = task.status;
  return { agent: task.agent, kind, ts: task.updated, name: '', value: '', note: task.result || task.note,
    task: { id: task.id, title: task.title, since: task.created, link: task.link || '' },
    assigned: { note: task.note }, board: boardView(task),
    taskStatus: status === 'blocked' ? 'blocked' : status === 'failed' ? 'failed' : 'done' };
}

/** An agent's ticket for another agent. `from` always comes from the caller's token. */
export function parseTicket(body, from, known) {
  const title = typeof body?.title === 'string' ? body.title.trim().replace(/\s+/g, ' ') : '';
  const note = typeof body?.note === 'string' ? body.note.trim() : '';
  const to = typeof body?.to === 'string' ? body.to.trim().toLowerCase() : '';
  const rawRef = typeof (body?.link ?? body?.ref) === 'string' ? String(body.link ?? body.ref).trim() : '';
  const requestId = body?.requestId === undefined || body?.requestId === '' ? crypto.randomUUID() : body.requestId;
  const parent = typeof body?.parent === 'string' ? body.parent : '';
  const errors = [];
  if (!title || title.length > 160) errors.push('title: required, max 160');
  if (note.length > TICKET_NOTE_MAX) errors.push('note: max ' + TICKET_NOTE_MAX);
  if (rawRef && !(/^https?:\/\/\S+$/i.test(rawRef) && rawRef.length <= 500)) errors.push('link: an http(s) URL, max 500');
  if (!BOARD_AGENTS.includes(to) || !known.includes(to)) errors.push('to: one of ' + BOARD_AGENTS.filter(a => known.includes(a)).join(', '));
  else if (to === from) errors.push('to: a ticket must be for another agent, not yourself');
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) errors.push('requestId: 16-80 letters, digits or dashes (omit it to get one)');
  if (parent && !/^board-[a-zA-Z0-9-]+$/.test(parent)) errors.push('parent: a board task id');
  return { title, note, to, from, ref: rawRef, requestId, parent, id: 'board-' + requestId + '-' + to, errors };
}
