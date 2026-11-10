// Durable owner-submitted requests. Agent reports cannot create a trusted board request.
import { notPickedUp } from '../board-state.js';
import { FILE_ID, MAX_FILES } from './files.js';
export const BOARD_AGENTS = ['instinct', 'hermes', 'tab'];
export const BOARD_LIMIT = 300;
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
