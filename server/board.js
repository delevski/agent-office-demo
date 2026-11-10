// Durable owner-submitted requests. Agent reports cannot create a trusted board request.
import { notPickedUp } from '../board-state.js';
export const BOARD_AGENTS = ['instinct', 'hermes', 'tab'];
export const BOARD_LIMIT = 300;
export function parseBoardTask(body, known) {
  const title = typeof body?.title === 'string' ? body.title.trim().replace(/\s+/g, ' ') : '';
  const note = typeof body?.note === 'string' ? body.note.trim() : '';
  const agents = body?.agent === 'all' ? BOARD_AGENTS : [body?.agent];
  const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
  const errors = [];
  if (!title || title.length > 160) errors.push('title: required, max 160');
  if (note.length > 300) errors.push('note: max 300');
  if (agents.some(a => !BOARD_AGENTS.includes(a) || !known.includes(a))) errors.push('agent: unavailable');
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) errors.push('requestId: required');
  return { title, note, agents, requestId, errors };
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
