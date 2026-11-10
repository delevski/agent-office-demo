// Instant Slack wake for every assignee when the owner saves a board task (and on "ping again").
// Free tier: one Slack chat.postMessage per task, inside the same Worker request (ctx.waitUntil).
// Secrets: SLACK_NOTIFY_TOKEN (never logged or echoed). Channel: SLACK_AGENTS_CHANNEL (default #agents).
// Mentions: SLACK_AGENT_MENTIONS (optional JSON {"tab":"U...","hermes":"U...","instinct":"U..."}, defaults in integrations/board-agent.js).
// Idempotence: only newly created tasks notify (duplicates never do), and a repeated notification cannot cause
// double execution: the claim endpoint rejects a second claim with 409.
import { slackTaskMessage, parseMentions } from '../integrations/board-agent.js';
import { waitingMinutes } from '../board-state.js';

export const AGENTS_CHANNEL = 'C0CFVFY4684';

export async function notifyAgents(env, tasks, hubStub, transport = (...a) => fetch(...a), { reminder = false } = {}) {
  const token = env.SLACK_NOTIFY_TOKEN;
  if (!token) return { skipped: 'not configured' };
  const channel = env.SLACK_AGENTS_CHANNEL || AGENTS_CHANNEL;
  const mentions = parseMentions(env.SLACK_AGENT_MENTIONS);
  const now = Date.now();
  const due = tasks.filter(t => ['office-owner-session', 'agent-ticket'].includes(t.source) && t.status === 'queued' && mentions[t.agent]);
  return Promise.all(due.map(async task => {
    let delivery = 'error', note = '', slackTs = '';
    try {
      const text = slackTaskMessage(task, { wakeInstinct: true, mentions, reminderMinutes: reminder ? Math.max(1, waitingMinutes(task, now)) : 0 });
      const r = await transport('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
      });
      const d = await r.json();
      if (d.ok && /^\d+\.\d+$/.test(d.ts || '')) { delivery = 'delivered'; slackTs = d.ts; }
      else note = 'Slack: ' + String(d.error || r.status).slice(0, 80);
    } catch { note = 'Slack send failed'; }
    try {
      await hubStub.fetch('https://hub/board/delivery', { method: 'POST', body: JSON.stringify({ id: task.id, delivery, slackTs, note }) });
    } catch { /* receipt is best effort; the poll still finds the task */ }
    return { id: task.id, agent: task.agent, delivery };
  }));
}
// Kept for callers and tests written when only Instinct was woken.
export const notifyInstinct = notifyAgents;
