// Instant Slack wake for Instinct when the owner saves a board task assigned to it.
// Free tier: one Slack chat.postMessage per new task, inside the same Worker request (ctx.waitUntil).
// Secret: SLACK_NOTIFY_TOKEN (Worker secret, never logged or echoed). Channel: SLACK_AGENTS_CHANNEL (default #agents).
// Idempotence: only called for newly created tasks (duplicates never notify). A repeated notification could not
// cause double execution anyway: the claim endpoint rejects a second claim with 409.
import { slackTaskMessage } from '../integrations/board-agent.js';

export const AGENTS_CHANNEL = 'C0CFVFY4684';

export async function notifyInstinct(env, tasks, hubStub, transport = (...a) => fetch(...a)) {
  const token = env.SLACK_NOTIFY_TOKEN;
  if (!token) return { skipped: 'not configured' };
  const channel = env.SLACK_AGENTS_CHANNEL || AGENTS_CHANNEL;
  const results = [];
  for (const task of tasks) {
    if (task.agent !== 'instinct' || task.source !== 'office-owner-session' || task.status !== 'queued') continue;
    let delivery = 'error', note = '', slackTs = '';
    try {
      const r = await transport('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel, text: slackTaskMessage(task, { wakeInstinct: true }), unfurl_links: false, unfurl_media: false }),
      });
      const d = await r.json();
      if (d.ok && /^\d+\.\d+$/.test(d.ts || '')) { delivery = 'delivered'; slackTs = d.ts; }
      else note = 'Slack: ' + String(d.error || r.status).slice(0, 80);
    } catch { note = 'Slack send failed'; }
    try {
      await hubStub.fetch('https://hub/board/delivery', { method: 'POST', body: JSON.stringify({ id: task.id, delivery, slackTs, note }) });
    } catch { /* receipt is best effort; the poll still finds the task */ }
    results.push({ id: task.id, delivery });
  }
  return results;
}
