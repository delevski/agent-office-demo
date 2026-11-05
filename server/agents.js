// server/agents.js — the per-agent state logic now lives in ../office-state.js so the browser can run the
// very same reducer for the day replay. This file keeps the old import path working for the server and tests.
export * from '../office-state.js';
