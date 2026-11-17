// server/mcp.js — MCP (Model Context Protocol) endpoint for the Agent Office.
// One Streamable-HTTP-style JSON-RPC endpoint: the agent's existing per-agent Bearer token
// (env AGENT_TOKEN_<ID> or a registered aot_ token) authenticates every request, exactly like
// /api/ingest. Tools are pull-only: nothing here wakes the agent; its runtime decides when to call.
// The agent's identity comes from the token and can never be overridden by arguments.

const PROTOCOL_VERSION = '2025-06-18';

const STATUSES = ['working', 'idle', 'blocked', 'offline'];
const BOARD_KINDS = { start: 'task.start', progress: 'task.progress', done: 'task.done', failed: 'task.failed' };

export const MCP_TOOLS = [
  {
    name: 'report_status',
    description: 'Update your own live status in the office (your figure in the room).',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: STATUSES, description: 'working | idle | blocked | offline' },
        note: { type: 'string', description: 'short line shown with the status (max ~140 chars)' },
      },
      required: ['status'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_inbox',
    description: 'List the board tasks currently assigned to you (queued or running).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'claim_task',
    description: 'Claim one of your queued board tasks. Returns a claimToken you must pass to report_task for that task.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'board-... task id from check_inbox' } },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'report_task',
    description: 'Report progress on a claimed board task: start, progress, done or failed. done/failed require a result summary.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'board-... task id' },
        phase: { type: 'string', enum: Object.keys(BOARD_KINDS) },
        claimToken: { type: 'string', description: 'the token claim_task returned for this task' },
        note: { type: 'string', description: 'progress note, or the result summary for done/failed (required there)' },
        link: { type: 'string', description: 'optional URL of the result' },
      },
      required: ['task_id', 'phase', 'claimToken'],
      additionalProperties: false,
    },
  },
];

function rpcResult(id, result) { return { jsonrpc: '2.0', id: id ?? null, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

function toolText(id, value) { return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(value) }] }); }

async function callTool(hub, agent, name, args = {}) {
  if (name === 'report_status') {
    const status = String(args.status || '');
    if (!STATUSES.includes(status)) return { ok: false, error: 'status must be one of: ' + STATUSES.join(', ') };
    const res = await hub.fetch('https://hub/report', { method: 'POST', body: JSON.stringify({ agent, kind: 'status', status, note: String(args.note || '').slice(0, 140) }) });
    return { ...(await res.json()), status };
  }
  if (name === 'check_inbox') {
    const res = await hub.fetch('https://hub/board/list?agent=' + encodeURIComponent(agent));
    const d = await res.json();
    const tasks = (d.tasks || []).filter(t => !['done', 'failed', 'canceled'].includes(t.status))
      .map(t => ({ id: t.id, title: t.title, status: t.status, note: t.note || '', link: t.link || '' }));
    return { ok: res.ok, tasks };
  }
  if (name === 'claim_task') {
    const id = String(args.task_id || '');
    if (!/^board-[a-zA-Z0-9-]+$/.test(id)) return { ok: false, error: 'task_id must look like board-...' };
    const res = await hub.fetch('https://hub/board/claim', { method: 'POST', body: JSON.stringify({ id, agent }) });
    return res.json();
  }
  if (name === 'report_task') {
    const id = String(args.task_id || '');
    const kind = BOARD_KINDS[String(args.phase || '')];
    if (!/^board-[a-zA-Z0-9-]+$/.test(id)) return { ok: false, error: 'task_id must look like board-...' };
    if (!kind) return { ok: false, error: 'phase must be one of: ' + Object.keys(BOARD_KINDS).join(', ') };
    const note = [String(args.note || '').trim(), String(args.link || '').trim()].filter(Boolean).join(' ').slice(0, 2000);
    const res = await hub.fetch('https://hub/board/report', { method: 'POST', body: JSON.stringify({ agent, kind, task: { id }, note, claimToken: String(args.claimToken || '') }) });
    return res.json();
  }
  return { ok: false, error: 'unknown tool: ' + name };
}

/**
 * Handle one JSON-RPC request (or batch) at POST /mcp.
 * @param hub the EventHub stub; @param agent the token-derived agent id.
 */
export async function handleMcp(hub, agent, payload) {
  const run = async (msg) => {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'invalid JSON-RPC request');
    const { id, method, params } = msg;
    if (method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-office', version: '1' },
        instructions: 'You are agent "' + agent + '" in the Agent Office. Your identity comes from your token; every tool acts as you. Poll check_inbox on your own schedule - tools never push.',
      });
    }
    if (method === 'ping') return rpcResult(id, {});
    if (method.startsWith('notifications/')) return null; // acked silently
    if (method === 'tools/list') return rpcResult(id, { tools: MCP_TOOLS });
    if (method === 'tools/call') {
      const name = String(params?.name || '');
      if (!MCP_TOOLS.some(t => t.name === name)) return rpcError(id, -32602, 'unknown tool: ' + name);
      try {
        return toolText(id, await callTool(hub, agent, name, params?.arguments || {}));
      } catch (e) {
        return rpcError(id, -32603, 'tool failed: ' + (e && e.message ? e.message : 'error'));
      }
    }
    return rpcError(id, -32601, 'method not found: ' + method);
  };
  if (Array.isArray(payload)) {
    const out = [];
    for (const m of payload) { const r = await run(m); if (r) out.push(r); }
    return out;
  }
  return run(payload);
}
