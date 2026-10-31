// Agent Office — tiny reporter for your own agents. Zero deps, fire-and-forget.
const URL = 'https://agent-office-demo.orworkdelevski.workers.dev/api/ingest';

export function createReporter(agent, token) {
  return function report(kind, value = '', note = '') {
    fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': token },
      body: JSON.stringify({ agent, kind, value: String(value), note: String(note) }),
    }).catch(() => {});
  };
}

// Usage:
//   import { createReporter } from './office-agent.js';
//   const report = createReporter('ritman', process.env.AGENT_OFFICE_TOKEN);
//   report('task.done', '+1', 'Built the export feature');
