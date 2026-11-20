// eval-state.js — the "בדיקות אמינות" (agent evals) panel's data model. Pure functions (no I/O), shared by the Durable Object,
// the Worker, the runner (integrations/eval-runner.mjs) and the tests.
//
// A scenario = a trigger prompt + assertions (the pass conditions). A RUN is one execution of a scenario against an agent
// variant (model / version label). Evidence is tiered by WHO produced it, and the tiers are never merged into one score:
//   source "evaluator"  - posted through /api/evals/ingest by an agent the OWNER configured as an evaluator (env EVAL_EVALUATORS).
//                         Only these runs feed the headline counts.
//   source "self"       - an ordinary agent's own report about itself (/api/ingest). Shown, clearly labelled "self-reported", counted
//                         separately, never in the headline.
// Per assertion:
//   deterministic       - the server recomputes pass/fail from the submitted evidence (tools called, output, duration), so a producer
//                         cannot just claim "passed". The evidence itself is still produced by the poster. `state_check` (an end-state
//                         check) cannot be recomputed here: stored as basis "reported".
//   judge               - a producer-supplied model name + score. NOT validated here: stored and shown as "reported, not validated",
//                         never counted as a pass rate.
//   human               - the owner's verdict in the panel.
// Only a count of runs (k of n) is shown; no confidence label, threshold or composite score. Nothing is seeded.
import { str, agentId } from './office-state.js';

export const DET_KINDS = ['tool_called', 'tool_not_called', 'output_contains', 'output_not_contains', 'max_duration_ms', 'state_check'];
export const EVAL_KINDS = [...DET_KINDS, 'judge'];
export const STAGES = ['execution', 'code'];   // 1) did the agent carry out the task correctly  2) quality of the code it produced
export const EVAL_DAYS = 30;
export const EVAL_DAY_MAX = 400;
export const EVAL_DAY_BYTES = 96_000;
export const OUTPUT_MAX = 2000;
export const RUNS_SHOWN = 12;

const slug = (v, n = 60) => str(v, n).toLowerCase().replace(/[^a-z0-9\u0590-\u05ff._-]+/g, '-').replace(/^-+|-+$/g, '');
const oneLine = (v, n) => str(v, n * 2).replace(/\s+/g, ' ').trim().slice(0, n);
const nonNeg = v => { const n = Number(v); return v !== '' && v !== null && v !== undefined && Number.isFinite(n) && n >= 0 ? n : undefined; };

/** Evaluate one deterministic assertion against a run's evidence. Returns { passed, evidence } or null for state_check. */
export function checkAssertion(spec, ev) {
  const out = String(ev.output ?? ''), tools = (ev.tools || []).map(t => String(t));
  switch (spec.kind) {
    case 'tool_called': return { passed: tools.includes(spec.value), evidence: tools.includes(spec.value) ? `הכלי ${spec.value} נקרא` : `הכלי ${spec.value} לא נקרא (נקראו: ${tools.join(', ') || 'אף כלי'})` };
    case 'tool_not_called': return { passed: !tools.includes(spec.value), evidence: tools.includes(spec.value) ? `הכלי ${spec.value} נקרא למרות האיסור` : `הכלי ${spec.value} לא נקרא` };
    case 'output_contains': return { passed: out.toLowerCase().includes(spec.value.toLowerCase()), evidence: `חיפוש "${spec.value}" בפלט` };
    case 'output_not_contains': return { passed: !out.toLowerCase().includes(spec.value.toLowerCase()), evidence: `בדיקה ש-"${spec.value}" לא מופיע בפלט` };
    case 'max_duration_ms': {
      const d = nonNeg(ev.duration_ms), lim = nonNeg(spec.value);
      if (d === undefined) return { passed: false, evidence: 'לא דווח זמן ריצה' };
      return { passed: d <= lim, evidence: `${Math.round(d)}ms מול מגבלה ${Math.round(lim)}ms` };
    }
    default: return null;
  }
}

/** Validate + normalize an `eval.result` ingest body. Never trusts a reported `passed` for a computable assertion. */
export function parseEvalResult(body, sender, now = Date.now(), source = 'self') {
  const errors = [];
  const scenario = slug(body.scenario ?? body.scenario_id);
  if (!scenario) errors.push('scenario: required');
  const run_id = slug(body.run_id, 80);
  if (!run_id) errors.push('run_id: required (one id per execution; a retried report with the same id replaces, never duplicates)');
  const rawA = Array.isArray(body.assertions) ? body.assertions.slice(0, 30) : [];
  if (!rawA.length) errors.push('assertions: at least one required (a scenario without success conditions proves nothing)');
  const variantIn = body.variant && typeof body.variant === 'object' ? body.variant : {};
  const variant = { label: oneLine(variantIn.label ?? body.variant_label ?? 'default', 40) || 'default', model: oneLine(variantIn.model ?? body.model ?? '', 60) };
  const tools = (Array.isArray(body.tools_called) ? body.tools_called : []).slice(0, 80).map(t => oneLine(t, 60)).filter(Boolean);
  const output = str(body.output, OUTPUT_MAX);
  const duration_ms = nonNeg(body.duration_ms);
  const assertions = [];
  rawA.forEach((a, i) => {
    if (!a || typeof a !== 'object') { errors.push(`assertions[${i}]: object required`); return; }
    const kind = str(a.kind, 30);
    if (!EVAL_KINDS.includes(kind)) { errors.push(`assertions[${i}].kind: one of ${EVAL_KINDS.join(', ')}`); return; }
    const label = oneLine(a.label || kind, 120);
    const id = slug(a.id || `${kind}-${i}`, 60);
    if (kind === 'judge') {
      const j = a.judge && typeof a.judge === 'object' ? a.judge : {};
      const model = oneLine(j.model, 60), score = Number(j.score), threshold = j.threshold === undefined ? 0.7 : Number(j.threshold);
      if (!model) { errors.push(`assertions[${i}].judge.model: required (an unattributed judge score is not stored)`); return; }
      if (!Number.isFinite(score) || score < 0 || score > 1) { errors.push(`assertions[${i}].judge.score: number 0..1`); return; }
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) { errors.push(`assertions[${i}].judge.threshold: number 0..1`); return; }
      assertions.push({ id, kind, label, type: 'judge', basis: 'reported_unvalidated', passed: score >= threshold, evidence: oneLine(j.rationale, 400), judge: { model, score: Math.round(score * 1000) / 1000, threshold } });
      return;
    }
    const value = kind === 'state_check' ? '' : oneLine(a.value ?? a.tool, 200);
    if (kind !== 'state_check' && value === '') { errors.push(`assertions[${i}].value: required for ${kind}`); return; }
    if (kind === 'max_duration_ms' && nonNeg(value) === undefined) { errors.push(`assertions[${i}].value: number of ms`); return; }
    if (kind === 'state_check') {
      if (typeof a.passed !== 'boolean') { errors.push(`assertions[${i}].passed: boolean (the runner's end-state check result)`); return; }
      const evidence = oneLine(a.evidence, 400);
      if (!evidence) { errors.push(`assertions[${i}].evidence: required for state_check (what was checked and what it returned)`); return; }
      assertions.push({ id, kind, label, type: 'deterministic', basis: 'reported', passed: a.passed, evidence });
      return;
    }
    const r = checkAssertion({ kind, value }, { output, tools, duration_ms });
    const mismatch = typeof a.passed === 'boolean' && a.passed !== r.passed;
    assertions.push({ id, kind, label, type: 'deterministic', basis: 'recomputed', passed: r.passed, evidence: r.evidence, value, ...(mismatch ? { reported_mismatch: true } : {}) });
  });
  const stageIn = STAGES.includes(str(body.stage, 12)) ? str(body.stage, 12) : 'execution';
  if (stageIn === 'code' && !assertions.some(a => a.kind === 'state_check'))
    errors.push('stage code: needs at least one state_check (a real end-state check such as the tests or the build, with its exit code as evidence). Text or tool-presence checks do not measure code quality');
  if (errors.length) return { errors };
  const ts = Number.isFinite(Number(body.ts)) && Number(body.ts) > 0 && Number(body.ts) <= now + 60_000 ? Number(body.ts) : now;
  return { errors, result: {
    id: `${source}:${scenario}:${variant.label}:${run_id}`, ts, type: 'eval.result', source: source === 'evaluator' ? 'evaluator' : 'self', scenario, title: oneLine(body.title || scenario, 120),
    tags: (Array.isArray(body.tags) ? body.tags : []).slice(0, 8).map(t => slug(t, 30)).filter(Boolean),
    stage: STAGES.includes(str(body.stage, 12)) ? str(body.stage, 12) : 'execution',
    run_id, attempt: Math.min(Math.max(1, Math.floor(Number(body.attempt) || 1)), 1000),
    agent: agentId(body.agent) || sender, reported_by: sender, variant,
    trigger: oneLine(body.trigger, 500), output, tools, ...(duration_ms !== undefined ? { duration_ms } : {}), assertions,
  } };
}

export function runVerdicts(r, review) {
  const det = r.assertions.filter(a => a.type === 'deterministic'), jd = r.assertions.filter(a => a.type === 'judge');
  return {
    det: det.length ? (det.every(a => a.passed) ? 'pass' : 'fail') : 'none',
    judge: jd.length ? (jd.every(a => a.passed) ? 'pass' : 'fail') : 'not_run', // reported, NOT validated: never aggregated
    human: review ? review.verdict : 'pending',
  };
}

// n = runs that had at least one deterministic check; unscored = runs with none (shown, never counted as pass or fail).
// pct is null when n is 0 (the UI says "not tested yet", never 0%). It is a share of the runs actually made, not a reliability guarantee.
const tally = vs => { const d = vs.filter(x => x.v.det !== 'none'), k = d.filter(x => x.v.det === 'pass').length; return { n: d.length, k, failed: d.length - k, unscored: vs.length - d.length, pct: d.length ? Math.round(1000 * k / d.length) / 10 : null }; };

/** Group results into scenarios -> variants. Headline counts use evaluator-source runs only; self-reported runs are counted apart.
 *  `reviews` = { [result id]: {verdict, note, ts} }. Only k-of-n counts are produced, never a percentage label or composite score. */
export function buildEvals(results, reviews = {}, q = {}, now = Date.now()) {
  const stage = STAGES.includes(q.stage) ? q.stage : '', tag = slug(q.tag), variantQ = str(q.variant, 40), agent = agentId(q.agent);
  const rows = (results || []).filter(r => (!stage || (r.stage || 'execution') === stage) && (!tag || r.tags.includes(tag)) && (!variantQ || r.variant.label === variantQ) && (!agent || r.agent === agent));
  const byScn = new Map();
  for (const r of rows) { if (!byScn.has(r.scenario)) byScn.set(r.scenario, []); byScn.get(r.scenario).push(r); }
  const scenarios = [...byScn.entries()].map(([scenario, rs]) => {
    const byVar = new Map();
    for (const r of rs) { const k = r.variant.label; if (!byVar.has(k)) byVar.set(k, []); byVar.get(k).push(r); }
    const variants = [...byVar.entries()].map(([label, runs]) => {
      runs.sort((a, b) => b.ts - a.ts);
      const vs = runs.map(r => ({ r, v: runVerdicts(r, reviews[r.id]) }));
      const ev = vs.filter(x => x.r.source === 'evaluator'), self = vs.filter(x => x.r.source !== 'evaluator');
      const judged = vs.filter(x => x.v.judge !== 'not_run');
      const humans = vs.filter(x => x.v.human !== 'pending');
      const latest = runs[0];
      const fails = {};
      for (const { r } of vs) for (const a of r.assertions) if (a.type === 'deterministic' && !a.passed) (fails[a.id] ||= { id: a.id, label: a.label, count: 0 }).count++;
      return {
        label, model: latest.variant.model, agent: latest.agent, last_ts: latest.ts, runs_total: vs.length,
        evaluator: { ...tally(ev), runs: ev.length },             // headline: deterministic pass, evaluator-posted runs only
        self: { ...tally(self), runs: self.length },              // self-reported by the agent itself; shown apart, never in the headline
        judge: { reported_runs: judged.length, models: [...new Set(judged.flatMap(x => x.r.assertions.filter(a => a.type === 'judge').map(a => a.judge.model)))], validated: false },
        human: { n: humans.length, k: humans.filter(x => x.v.human === 'pass').length, pending: vs.length - humans.length },
        top_failures: Object.values(fails).sort((a, b) => b.count - a.count).slice(0, 3),
        mismatches: vs.reduce((s, { r }) => s + r.assertions.filter(a => a.reported_mismatch).length, 0),
        runs: vs.slice(0, RUNS_SHOWN).map(({ r, v }) => ({ id: r.id, source: r.source, ts: r.ts, attempt: r.attempt, run_id: r.run_id, agent: r.agent, reported_by: r.reported_by, trigger: r.trigger, output: r.output, tools: r.tools, duration_ms: r.duration_ms ?? null, verdicts: v, review: reviews[r.id] || null, assertions: r.assertions })),
      };
    }).sort((a, b) => b.last_ts - a.last_ts);
    return { scenario, stage: rs[0].stage || 'execution', title: rs[0].title, tags: [...new Set(rs.flatMap(r => r.tags))], runs: rs.length, last_ts: Math.max(...rs.map(r => r.ts)), variants };
  }).sort((a, b) => b.last_ts - a.last_ts);
  const allTags = [...new Set((results || []).flatMap(r => r.tags))].sort();
  const allVariants = [...new Set((results || []).map(r => r.variant.label))].sort();
  return { now, stage, total_runs: rows.length, scenarios, tags: allTags, variants: allVariants };
}

export function mergeEvalDay(cur, add) {
  const m = new Map((cur || []).map(e => [e.id, e]));
  for (const e of add) m.set(e.id, e);
  let list = [...m.values()].sort((a, b) => a.ts - b.ts).slice(-EVAL_DAY_MAX);
  while (list.length > 1 && JSON.stringify(list).length > EVAL_DAY_BYTES) list.shift();
  return list;
}

export function parseReview(body, now = Date.now()) {
  const errors = [], id = str(body.id, 200), verdict = str(body.verdict, 10);
  if (!id) errors.push('id: required');
  if (!['pass', 'fail', 'clear'].includes(verdict)) errors.push('verdict: pass | fail | clear');
  return errors.length ? { errors } : { errors, id, verdict, note: oneLine(body.note, 300), ts: now };
}

/** Task-execution record computed by the office from its OWN board/audit log (not from anything an agent says about itself).
 *  Real semantics (server/hub.js): the hub itself refuses a claim from anyone but the assignee and refuses an agent's finish report
 *  without the claim receipt. So "claimed first" is enforced by the system and is NOT counted as a check here. What can differ:
 *    clean              the assignee reported "done" and attached a non-empty result
 *    no_result          the assignee reported "done" with an empty result (a confirmed process gap)
 *    reported_failed    the assignee reported "failed" (the agent says so; counted as not clean, but it is honesty, not a process gap)
 *    owner_backfill     the finish was recorded by the owner afterwards ("owner-reconciliation"): the agent never reported it, so whether
 *                       it was really done is UNKNOWN. Listed, not counted.
 *    unknown            the task's "created" event is not in the retained audit log (kept 30 days, capped per day), so the history is
 *                       incomplete. Missing evidence is not a violation: listed, not counted.
 *  Cancelled tasks and unfinished tasks are skipped. pct = clean / (clean + no_result + reported_failed). The content of a result is the
 *  agent's own words: this checks the recorded PROCESS and says nothing about whether the result is correct. */
export function executionFromAudit(events) {
  const byTask = new Map();
  for (const e of events || []) {
    if (!e.task_id || !String(e.type).startsWith('task.')) continue;
    if (!byTask.has(e.task_id)) byTask.set(e.task_id, []);
    byTask.get(e.task_id).push(e);
  }
  const agents = new Map(), tasks = [];
  for (const [task_id, evs] of byTask) {
    const end = evs.filter(e => e.type === 'task.done' || e.type === 'task.failed').sort((a, b) => a.ts - b.ts).at(-1);
    if (!end || evs.some(e => e.type === 'task.cancelled')) continue;
    const to = end.to || evs[0].to;
    let status;
    if (!evs.some(e => e.type === 'task.created')) status = 'unknown';
    else if (end.via === 'owner-reconciliation' || end.actor !== to) status = 'owner_backfill';
    else if (end.type === 'task.failed') status = 'reported_failed';
    else status = String(end.text || '').trim() ? 'clean' : 'no_result';
    tasks.push({ task_id, title: end.title || evs[0].title || task_id, agent: to, ts: end.ts, status, progress_updates: evs.filter(e => e.type === 'task.progress').length });
    const a = agents.get(to) || { agent: to, clean: 0, no_result: 0, reported_failed: 0, owner_backfill: 0, unknown: 0 };
    a[status]++;
    agents.set(to, a);
  }
  tasks.sort((a, b) => b.ts - a.ts);
  const list = [...agents.values()].map(a => { const n = a.clean + a.no_result + a.reported_failed; return { ...a, n, pct: n ? Math.round(1000 * a.clean / n) / 10 : null }; }).sort((x, y) => (y.n + y.owner_backfill + y.unknown) - (x.n + x.owner_backfill + x.unknown));
  return { source: 'office-recorded', agents: list, tasks: tasks.slice(0, 40), total: tasks.length, retention_days: AUDIT_DAYS_NOTE };
}
const AUDIT_DAYS_NOTE = 30;
