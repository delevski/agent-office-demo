// Shared by the Worker (server/board.js) and the page (main.js): when does a queued board task count as
// "not picked up"? One constant, one rule, so the warning and the re-ping button never disagree.
export const PICKUP_WARN_MIN = 10;
export const PICKUP_WARN_MS = PICKUP_WARN_MIN * 60_000;
// A task is waiting for its agent while it is still queued (never claimed). `created` is the owner's save time.
export function notPickedUp(task, now = Date.now(), warnMs = PICKUP_WARN_MS) {
  return !!task && task.status === 'queued' && Number(task.created) > 0 && now - Number(task.created) > warnMs;
}
export function waitingMinutes(task, now = Date.now()) {
  return Math.max(0, Math.floor((now - Number(task?.created || now)) / 60_000));
}
