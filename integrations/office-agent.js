// Agent Office — tiny reporter for your own agents. Zero deps, fire-and-forget.
// token = this agent's AGENT_TOKEN_<ID> value (Bearer). The token decides which agent you are.
const BASE = 'https://agent-office-demo.orworkdelevski.workers.dev';

export function createReporter(token, base = BASE) {
  const send = body => fetch(base + '/api/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  }).catch(() => {});
  return {
    taskStart: (id, title, link = '') => send({ kind: 'task.start', task: { id, title, link } }),
    taskDone: (id, failed = false) => send({ kind: failed ? 'task.failed' : 'task.done', task: { id } }),
    status: (status, title) => send({ kind: 'status', status, ...(title ? { task: { title } } : {}) }),
    usage: (usage, mode = 'set') => send({ kind: 'usage', usage, mode }),       // {messages, tokens, cost, tasks}
    config: config => send({ kind: 'config', config }),                       // {model, skills[], tools[]}
    event: (kind, value = '', note = '') => send({ kind, value: String(value), note: String(note) }),
  };
}

// Usage:
//   import { createReporter } from './office-agent.js';
//   const office = createReporter(process.env.AGENT_OFFICE_TOKEN);
//   office.taskStart('pr-61', 'Agent panel PR', 'https://github.com/…/pull/61');
//   office.taskDone('pr-61');
//   office.usage({ messages: 12, tokens: 48000, cost: 0.42 });
//   office.config({ model: 'MyAgent', skills: ['research'] });
