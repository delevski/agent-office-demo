#!/usr/bin/env node
// eval-runner.mjs — runs scenarios against YOUR agent and posts real results to the office panel "בדיקות אמינות".
//   node integrations/eval-runner.mjs --scenarios my-scenarios.json --agent ./my-agent.sh --repeat 5 --variant v1 \
//        --office https://office.ordel.dev   (token in env OFFICE_EVAL_TOKEN: the per-agent token of an agent listed in EVAL_EVALUATORS)
//   add --dry-run to print the results without posting.
// What it does, and does not do:
//  * Runs ONLY the local program you pass in --agent (spawned directly, no shell, prompt on stdin, 120s timeout, output capped).
//    Nothing from a scenario file or from the office is ever executed, fetched or used as a command. It makes no network calls
//    except the one POST to --office, and calls no model or paid API itself.
//  * The agent program prints either plain text (the answer) or JSON {"output": "...", "tools_called": ["a","b"]}.
//  * Scenarios: [{ "scenario": "claims-own-task", "title": "...", "stage": "execution"|"code", "tags": [], "trigger": "prompt",
//      "assertions": [ {"kind":"tool_called","value":"claim_task","label":"..."}, {"kind":"output_contains","value":"..."},
//                      {"kind":"tool_not_called","value":"..."}, {"kind":"max_duration_ms","value":30000} ] }]
//    Assertion kinds are the deterministic ones. The office recomputes each from the evidence posted here.
//  * Real code-quality checks: a scenario may list "checks": [{"label":"unit tests pass","cmd":"npm","args":["test"],"cwd":"/path/to/repo",
//      "timeout_s":300}]. YOU author them in your own scenario file; the runner runs each one directly (no shell) AFTER the agent finished and posts
//      the result as a state_check: passed = exit code 0, evidence = the command, exit code and the tail of its output. This is how the "איכות קוד"
//      tab gets real results (tests, build, lint). A scenario with "stage":"code" must have at least one check.
//  * A judge score is only posted if your scenario file supplies it; this runner never invents one.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const OUT_CAP = 20_000, TIMEOUT_MS = 120_000;

export function runAgent(cmd, args, prompt) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let out = '', err = '', done = false;
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const finish = r => { if (!done) { done = true; clearTimeout(timer); resolve({ ...r, duration_ms: Date.now() - t0 }); } };
    const timer = setTimeout(() => { p.kill('SIGKILL'); finish({ error: 'timeout' }); }, TIMEOUT_MS);
    p.stdout.on('data', d => { if (out.length < OUT_CAP) out += d; });
    p.stderr.on('data', d => { if (err.length < 2000) err += d; });
    p.on('error', e => finish({ error: String(e.message || e) }));
    p.on('close', code => {
      if (code !== 0) return finish({ error: `exit ${code}${err ? ': ' + err.slice(0, 200) : ''}` });
      let output = out, tools = [];
      try { const j = JSON.parse(out); if (j && typeof j === 'object') { output = String(j.output ?? ''); tools = Array.isArray(j.tools_called) ? j.tools_called.map(String) : []; } } catch { /* plain text */ }
      finish({ output, tools });
    });
    p.stdin.on('error', () => {}); p.stdin.end(prompt);
  });
}

export function runCheck(c) {
  return new Promise(resolve => {
    const t0 = Date.now(), timeoutMs = Math.min(Math.max(Number(c.timeout_s) || 300, 1), 1800) * 1000;
    let out = '', done = false;
    const label = String(c.label || c.cmd), shown = [c.cmd, ...(c.args || [])].join(' ').slice(0, 120);
    const finish = (code, note) => { if (done) return; done = true; clearTimeout(timer); const tail = out.replace(/\s+/g, ' ').trim().slice(-160);
      resolve({ id: 'check-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40), kind: 'state_check', label, passed: code === 0, evidence: `${shown} → ${note || 'exit ' + code} (${((Date.now() - t0) / 1000).toFixed(1)}s)${tail ? ': ' + tail : ''}`.slice(0, 400) }); };
    let p;
    try { p = spawn(String(c.cmd), (c.args || []).map(String), { cwd: c.cwd ? String(c.cwd) : undefined, stdio: ['ignore', 'pipe', 'pipe'], shell: false }); } catch (e) { return finish(-1, 'could not start'); }
    const timer = setTimeout(() => { p.kill('SIGKILL'); finish(-1, 'timeout'); }, timeoutMs);
    p.stdout.on('data', d => { out = (out + d).slice(-4000); }); p.stderr.on('data', d => { out = (out + d).slice(-4000); });
    p.on('error', e => finish(-1, 'could not start: ' + String(e.message || e).slice(0, 80)));
    p.on('close', code => finish(code === null ? -1 : code));
  });
}

export async function runAll({ scenarios, cmd, args, repeat, variant, model, post }) {
  const results = [];
  for (const sc of scenarios) {
    for (let i = 1; i <= repeat; i++) {
      const r = sc.trigger && cmd ? await runAgent(cmd, args, sc.trigger) : { output: '', tools: [], duration_ms: 0 };
      const checks = [];
      if (!r.error) for (const c of sc.checks || []) checks.push(await runCheck(c)); // checks only after a clean agent run; a crashed run fails on its own
      // A run that crashed or timed out is still posted: it fails its assertions (no output, no tools) instead of vanishing.
      const body = { scenario: sc.scenario, title: sc.title, stage: sc.stage || 'execution', tags: sc.tags || [], trigger: sc.trigger,
        run_id: `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`, attempt: i, variant: { label: variant, model },
        output: r.output || (r.error ? `[הריצה נכשלה: ${r.error}]` : ''), tools_called: r.tools || [], duration_ms: r.duration_ms,
        assertions: [...(sc.assertions || []), ...checks] };
      results.push({ body, error: r.error || null, posted: post ? await post(body) : null });
    }
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => x.startsWith('--') ? [...acc, [x.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc, []));
  if (!a.scenarios) { console.error('usage: --scenarios file.json [--agent ./program] [--agent-arg x] [--repeat 5] [--variant label] [--model name] [--office URL] [--dry-run]'); process.exit(2); }
  const scenarios = JSON.parse(readFileSync(a.scenarios, 'utf8'));
  const token = process.env.OFFICE_EVAL_TOKEN;
  const dry = a['dry-run'] === true;
  if (!dry && (!a.office || !token)) { console.error('need --office and env OFFICE_EVAL_TOKEN (or --dry-run)'); process.exit(2); }
  const post = dry ? null : async body => {
    const res = await fetch(new URL('/api/evals/ingest', a.office), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
  const rs = await runAll({ scenarios, cmd: a.agent && a.agent !== true ? a.agent : '', args: a['agent-arg'] && a['agent-arg'] !== true ? [a['agent-arg']] : [], repeat: Math.max(1, Math.min(50, Number(a.repeat) || 1)), variant: String(a.variant || 'default'), model: String(a.model || ''), post });
  for (const r of rs) console.log(`${r.body.scenario} #${r.body.attempt}`, r.error ? `AGENT ERROR ${r.error}` : 'ran', r.posted ? `posted ${r.posted.status}` : '(dry run)');
  if (dry) console.log(JSON.stringify(rs.map(r => r.body), null, 2));
}
