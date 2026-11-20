import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { EventHub } from '../server/hub.js';
import { makeSession } from '../server/auth.js';
import { parseEvalResult, buildEvals, executionFromAudit, checkAssertion } from '../eval-state.js';
import { runAgent, runAll, runCheck } from '../integrations/eval-runner.mjs';

async function setup(extra = {}) {
  const data = new Map();
  const st = { storage: {
    async get(k) { return Array.isArray(k) ? new Map(k.filter(x => data.has(x)).map(x => [x, structuredClone(data.get(x))])) : structuredClone(data.get(k)); },
    async put(k, v) { if (typeof k === 'object') for (const [key, val] of Object.entries(k)) data.set(key, structuredClone(val)); else data.set(k, structuredClone(v)); },
    async delete(keys) { for (const k of [].concat(keys)) data.delete(k); },
    async list({ prefix }) { return new Map([...data].filter(([k]) => k.startsWith(prefix))); },
  }, blockConcurrencyWhile: fn => fn(), getWebSockets: () => [] };
  const hub = new EventHub(st); await new Promise(r => setTimeout(r, 0));
  const env = { OFFICE_PASSWORD: 'test-only-password', AGENT_TOKEN_INSTINCT: 'i', AGENT_TOKEN_HERMES: 'h', AGENT_TOKEN_TAB: 't', INGEST_TOKEN: 'legacy', EVAL_EVALUATORS: 'hermes', ...extra,
    HUB: { idFromName: () => '', get: () => ({ fetch: (url, init) => hub.fetch(new Request(url, init)) }) } };
  const cookie = 'ao_session=' + await makeSession(env);
  const call = (path, body, auth = 'owner') => worker.fetch(new Request('https://office.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(auth === 'owner' ? { Cookie: cookie } : auth ? { Authorization: 'Bearer ' + auth } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  return { call, env };
}
const A = [{ kind: 'tool_called', value: 'claim_task', label: 'claimed' }, { kind: 'output_contains', value: 'done', label: 'says done' }];
const run = (n, over = {}) => ({ scenario: 'S1', title: 'Scenario one', run_id: 'r' + n, variant: { label: 'v1' }, output: 'all done', tools_called: ['claim_task'], duration_ms: 100, assertions: A, ...over });

test('deterministic assertions are recomputed; a producer cannot claim a pass', () => {
  const r = parseEvalResult(run(1, { tools_called: [], assertions: [{ kind: 'tool_called', value: 'claim_task', passed: true }] }), 'hermes');
  assert.deepEqual(r.errors, []);
  assert.equal(r.result.assertions[0].passed, false);
  assert.equal(r.result.assertions[0].reported_mismatch, true);
  assert.equal(r.result.assertions[0].basis, 'recomputed');
});
test('validation: unsafe/unknown kinds, regex, missing assertions, unattributed judge are rejected', () => {
  assert.ok(parseEvalResult(run(1, { assertions: [{ kind: 'output_matches', value: '(a+)+$' }] }), 'x').errors.length);
  assert.ok(parseEvalResult(run(1, { assertions: [] }), 'x').errors.length);
  assert.ok(parseEvalResult(run(1, { assertions: [{ kind: 'judge', judge: { score: 0.9 } }] }), 'x').errors.length);
  assert.ok(parseEvalResult(run(1, { assertions: [{ kind: 'state_check', passed: true }] }), 'x').errors.length);
  assert.ok(parseEvalResult({ ...run(1), run_id: '' }, 'x').errors.length);
});
test('percentages come with counts; no runs = null pct, never 0; self-reports are never in the headline', () => {
  const mk = (n, source, out) => parseEvalResult(run(n, { output: out }), 'hermes', Date.now(), source).result;
  const rs = [mk(1, 'evaluator', 'done'), mk(2, 'evaluator', 'done'), mk(3, 'evaluator', 'oops'), mk(4, 'evaluator', 'done'), mk(5, 'self', 'done')];
  const v = buildEvals(rs).scenarios[0].variants[0];
  assert.deepEqual([v.evaluator.n, v.evaluator.k, v.evaluator.pct], [4, 3, 75]);
  assert.deepEqual([v.self.n, v.self.k], [1, 1]);
  const onlySelf = buildEvals([mk(9, 'self', 'done')]).scenarios[0].variants[0];
  assert.equal(onlySelf.evaluator.pct, null);
  assert.equal(onlySelf.evaluator.n, 0);
  assert.equal(buildEvals([]).scenarios.length, 0);
});
test('judge scores are stored but never counted or marked validated', () => {
  const r = parseEvalResult(run(1, { assertions: [...A, { kind: 'judge', label: 'quality', judge: { model: 'some-model', score: 0.95, rationale: 'good' } }] }), 'hermes', Date.now(), 'evaluator').result;
  const j = r.assertions.find(a => a.type === 'judge');
  assert.equal(j.basis, 'reported_unvalidated');
  const v = buildEvals([r]).scenarios[0].variants[0];
  assert.equal(v.judge.validated, false);
  assert.equal(v.evaluator.n, 1); // counted on the deterministic checks only
});
test('runs with no deterministic checks are unscored, not failures', () => {
  const r = parseEvalResult(run(1, { assertions: [{ kind: 'judge', judge: { model: 'm', score: 0.2 } }] }), 'hermes', Date.now(), 'evaluator').result;
  const v = buildEvals([r]).scenarios[0].variants[0];
  assert.deepEqual([v.evaluator.n, v.evaluator.unscored, v.evaluator.pct], [0, 1, null]);
});
test('stages stay apart', () => {
  const a = parseEvalResult(run(1, { stage: 'code', scenario: 'C1', assertions: [{ kind: 'state_check', label: 't', passed: true, evidence: 'npm test exit 0' }] }), 'h', Date.now(), 'evaluator').result;
  const b = parseEvalResult(run(2), 'h', Date.now(), 'evaluator').result;
  assert.equal(buildEvals([a, b], {}, { stage: 'code' }).scenarios.length, 1);
  assert.equal(buildEvals([a, b], {}, { stage: 'execution' }).scenarios[0].scenario, 's1');
});
test('execution record: real semantics, confirmed gaps vs missing evidence', () => {
  const ev = (type, task_id, o) => ({ id: `${task_id}:${type}`, task_id, type, to: 'tab', title: task_id, ...o });
  const created = id => ev('task.created', id, { ts: 1, actor: 'ori' });
  const out = executionFromAudit([
    created('clean'), ev('task.claimed', 'clean', { ts: 2, actor: 'tab' }), ev('task.done', 'clean', { ts: 3, actor: 'tab', text: 'ok', via: 'agent-report' }),
    created('noresult'), ev('task.done', 'noresult', { ts: 3, actor: 'tab', text: '', via: 'agent-report' }),
    created('failed'), ev('task.failed', 'failed', { ts: 3, actor: 'tab', text: 'could not', via: 'agent-report' }),
    created('backfill'), ev('task.done', 'backfill', { ts: 5, actor: 'owner-session', text: 'x', via: 'owner-reconciliation' }),
    ev('task.done', 'old', { ts: 3, actor: 'tab', text: 'ok' }), // created event outside retention: unknown, never a violation
    created('open'), ev('task.claimed', 'open', { ts: 2, actor: 'tab' }),
    created('cancelled'), ev('task.cancelled', 'cancelled', { ts: 2, actor: 'ori' }), ev('task.done', 'cancelled', { ts: 3, actor: 'tab', text: 'x' }),
  ]);
  assert.equal(out.total, 5); // unfinished and cancelled tasks are not listed
  const a = out.agents[0];
  assert.deepEqual([a.clean, a.no_result, a.reported_failed, a.owner_backfill, a.unknown], [1, 1, 1, 1, 1]);
  assert.deepEqual([a.n, a.pct], [3, 33.3]); // only agent-closed tasks count; backfilled and unknown stay outside the percentage
  assert.equal(out.tasks.find(t => t.task_id === 'old').status, 'unknown');
  assert.equal(executionFromAudit([]).agents.length, 0);
  const tt = executionFromAudit([{ id: 'a', task_id: 'tt', type: 'task.created', ts: 1, to: 'tab', title: '[בדיקת אמינות] x' }, { id: 'b', task_id: 'tt', type: 'task.done', ts: 2, to: 'tab', actor: 'tab', title: '[בדיקת אמינות] x', text: 'שורה', via: 'agent-report' }]);
  assert.deepEqual([tt.tests.n, tt.tests.clean, tt.tests.pct, tt.tests.items[0].result], [1, 1, 100, 'שורה']);
  assert.equal(executionFromAudit([]).tests.pct, null);
  const pend = executionFromAudit([{ id: 'p', task_id: 'pp', type: 'task.created', ts: 1, to: 'hermes', title: '[בדיקת אמינות] y' }]);
  assert.deepEqual([pend.tests.pending.length, pend.tests.pending[0].claimed, pend.tests.n], [1, false, 0]);
});
test('code stage needs a real end-state check; text/tool presence alone is rejected', () => {
  assert.ok(parseEvalResult(run(1, { stage: 'code' }), 'h').errors.some(e => e.includes('state_check')));
  const ok = parseEvalResult(run(2, { stage: 'code', assertions: [{ kind: 'state_check', label: 'tests', passed: true, evidence: 'npm test → exit 0' }] }), 'h');
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.result.assertions[0].basis, 'reported');
});
test('HTTP: self report via /api/ingest is "self"; /api/evals/ingest needs an evaluator agent; reads and reviews are owner-only', async () => {
  const { call, env } = await setup();
  const legacy = await worker.fetch(new Request('https://office.test/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': 'legacy' }, body: JSON.stringify({ kind: 'eval.result', ...run(1) }) }), env);
  assert.equal(legacy.status, 403); // the shared legacy token has no agent identity, so it cannot post eval runs
  const self = await call('/api/ingest', { kind: 'eval.result', ...run(1) }, 't');
  assert.equal((await self.json()).source, 'self');
  assert.equal((await call('/api/evals/ingest', run(2), 't')).status, 403);
  const ok = await call('/api/evals/ingest', run(2), 'h');
  const okj = await ok.json(); assert.equal(okj.source, 'evaluator');
  assert.equal((await call('/api/evals/ingest', run(3, { assertions: [] }), 'h')).status, 400);
  assert.equal((await call('/api/evals', undefined, 't')).status, 401);
  assert.equal((await call('/api/evals', undefined, null)).status, 401);
  const list = await (await call('/api/evals?stage=execution')).json();
  const v = list.scenarios[0].variants[0];
  assert.deepEqual([v.evaluator.n, v.evaluator.k, v.self.n], [1, 1, 1]);
  assert.equal((await call('/api/evals/review', { id: okj.eval_id, verdict: 'pass' }, 't')).status, 401);
  assert.equal((await call('/api/evals/review', { id: okj.eval_id, verdict: 'fail', note: 'wrong' })).status, 200);
  const after = (await (await call('/api/evals')).json()).scenarios[0].variants[0];
  assert.equal(after.human.n, 1); assert.equal(after.human.k, 0);
  assert.equal((await call('/api/ingest', { kind: 'eval.result', ...run(4) }, 'i')).status, 200); // retry safe
  const again = await call('/api/evals/ingest', run(2), 'h'); assert.equal(again.status, 200);
  assert.equal((await (await call('/api/evals')).json()).scenarios[0].variants[0].evaluator.n, 1); // same run id replaces, no duplicate
});
test('runner: spawns only the given program without a shell, posts failures too, never executes scenario text', async () => {
  assert.match((await runAgent('definitely-not-a-real-program-xyz', [], 'hi')).error, /spawn .*(ENOENT|EACCES)/);
  const r = await runAgent(process.execPath, ['-e', 'process.stdin.on("data",()=>{});process.stdin.on("end",()=>console.log(JSON.stringify({output:"done",tools_called:["claim_task"]})))'], '$(touch /tmp/pwned-eval)');
  assert.equal(r.output, 'done'); assert.deepEqual(r.tools, ['claim_task']);
  const posted = [];
  const res = await runAll({ scenarios: [{ scenario: 's', trigger: 'x', assertions: A }], cmd: 'definitely-not-a-real-program-xyz', args: [], repeat: 2, variant: 'v', model: '', post: async b => { posted.push(b); return { status: 200 }; } });
  assert.equal(posted.length, 2); assert.ok(res[0].error);
  assert.equal(checkAssertion({ kind: 'tool_called', value: 'claim_task' }, { tools: posted[0].tools_called, output: posted[0].output }).passed, false);
});
test('runner checks: exit code decides, evidence carries the command and output, no shell', async () => {
  const ok = await runCheck({ label: 'ok', cmd: process.execPath, args: ['-e', 'console.log("42 passed")'] });
  assert.equal(ok.passed, true); assert.match(ok.evidence, /exit 0/); assert.match(ok.evidence, /42 passed/);
  const bad = await runCheck({ label: 'bad', cmd: process.execPath, args: ['-e', 'console.error("1 failed");process.exit(3)'] });
  assert.equal(bad.passed, false); assert.match(bad.evidence, /exit 3/);
  const inj = await runCheck({ label: 'inj', cmd: process.execPath, args: ['-e', 'console.log(process.argv[1])', '; touch /tmp/pwned-eval2'] });
  assert.equal(inj.passed, true);
  const missing = await runCheck({ label: 'm', cmd: 'definitely-not-a-real-program-xyz', args: [] });
  assert.equal(missing.passed, false);
  const posted = [];
  await runAll({ scenarios: [{ scenario: 'c', stage: 'code', trigger: 't', checks: [{ label: 'x', cmd: process.execPath, args: ['-e', ''] }] }], cmd: '', args: [], repeat: 1, variant: 'v', model: '', post: async b => { posted.push(b); return {}; } });
  assert.equal(posted[0].assertions[0].kind, 'state_check');
  assert.equal(parseEvalResult(posted[0], 'h').errors.length, 0);
});
test('identity: a self report is always about the poster; only an evaluator may name a known subject agent', async () => {
  const { call } = await setup();
  assert.equal((await call('/api/ingest', { kind: 'eval.result', ...run(1), agent: 'tab' }, 'h')).status, 403); // the ingest route already refuses a mismatched agent field
  assert.equal(parseEvalResult({ ...run(1), agent: 'tab' }, 'hermes', Date.now(), 'self').result.agent, 'hermes'); // and the parser itself ignores it for self reports
  const s = await (await call('/api/ingest', { kind: 'eval.result', ...run(1) }, 'h')).json();
  assert.match(s.eval_id, /^self:hermes:/);
  const e = await call('/api/evals/ingest', run(5, { agent: 'not-an-agent' }), 'h'); assert.equal(e.status, 400);
  const e2 = await (await call('/api/evals/ingest', run(6, { agent: 'tab' }), 'h')).json();
  const runs = (await (await call('/api/evals')).json()).scenarios.flatMap(x => x.variants.flatMap(v => v.runs));
  const selfRun = runs.find(r => r.id === s.eval_id), evRun = runs.find(r => r.id === e2.eval_id);
  assert.deepEqual([selfRun.agent, selfRun.reported_by], ['hermes', 'hermes']);
  assert.deepEqual([evRun.agent, evRun.reported_by], ['tab', 'hermes']);
});
test('replacement: another poster cannot overwrite a run; a review does not survive changed content', async () => {
  const { call } = await setup();
  const a = await (await call('/api/ingest', { kind: 'eval.result', ...run(1) }, 'h')).json();
  const b = await (await call('/api/ingest', { kind: 'eval.result', ...run(1) }, 't')).json();
  assert.notEqual(a.eval_id, b.eval_id); // same scenario/variant/run_id from two posters = two runs
  assert.equal((await call('/api/evals/review', { id: 'self:nobody:S1:v1:zz', verdict: 'pass' })).status, 404);
  assert.equal((await call('/api/evals/review', { id: a.eval_id, verdict: 'pass' })).status, 200);
  const get = async () => (await (await call('/api/evals')).json()).scenarios.flatMap(x => x.variants.flatMap(v => v.runs)).find(r => r.id === a.eval_id);
  assert.equal((await get()).review.verdict, 'pass');
  await call('/api/ingest', { kind: 'eval.result', ...run(1), output: 'something else entirely' }, 'h'); // the same poster replaces own run with new content
  const g = await get();
  assert.deepEqual([g.review, g.review_stale, g.verdicts.human], [null, true, 'pending']);
});
test('test dispatch is gated: refused and reported disabled unless the owner enables it', async () => {
  const off = await setup();
  const body = { requestId: 'a'.repeat(20), agent: 'tab', title: '[בדיקת אמינות] x', note: '' };
  assert.equal((await off.call('/api/tasks', body)).status, 403);
  assert.equal((await (await off.call('/api/evals')).json()).dispatch_enabled, false);
  assert.equal((await off.call('/api/tasks', { ...body, title: 'normal task' })).status, 200); // ordinary board cards are untouched
  const on = await setup({ EVAL_TEST_DISPATCH: 'enabled' });
  assert.equal((await on.call('/api/tasks', body)).status, 200);
  assert.equal((await (await on.call('/api/evals')).json()).dispatch_enabled, true);
});
