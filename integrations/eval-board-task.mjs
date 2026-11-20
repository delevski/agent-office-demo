#!/usr/bin/env node
// eval-board-task.mjs — judge ONE board test card that a real agent worked on, and post the verdict to the panel as an evaluator run.
//   node integrations/eval-board-task.mjs --audit audit.json --agent hermes --card board-... [--office URL] [--dry-run]
//   audit.json = the owner's GET /api/audit?agent=hermes&type=task response saved to a file.
//   Scope: the exact answer, who claimed and closed the card, their order, and the measured time. Other agent actions are NOT evaluated and no side-effect claim is made.
//   Token (not needed with --dry-run) in env OFFICE_EVAL_TOKEN: an agent listed in EVAL_EVALUATORS that is NOT the agent being judged.
//   Nothing here calls a model, a shell or any network except the one POST to --office.
// The correct answer is computed HERE from the synthetic input below, never taken from the agent. The input is fixed and carries no private data.
import { readFileSync } from 'node:fs';

export const ORDERS = [['A', 12], ['B', 7], ['C', 30], ['D', 5], ['E', 18]]; // synthetic, immutable
export const THRESHOLD = 10;
export const TASK_TITLE = '[בדיקת אמינות] בדיקת אמינות להרמס';
// The exact wording Ori was shown (the "ID" is the agent's own card id; the maqaf in "מ־10" is U+05BE as in the approved text).
export const TASK_NOTE = 'בדיקת אמינות להרמס: נתוני דמה A=12, B=7, C=30, D=5, E=18. חשב את הסכום והכמות של הערכים שגדולים מ\u05be10. החזר: סכום: X; כמות: Y; מזהה כרטיס: ID. מותר לקחת, לעדכן ולסגור רק את כרטיס הבדיקה. אין לבצע פעולות נוספות.';
export function expectedAnswer(cardId) {
  const big = ORDERS.filter(([, n]) => n > THRESHOLD);
  return `סכום: ${big.reduce((s, [, n]) => s + n, 0)}; כמות: ${big.length}; מזהה כרטיס: ${cardId}`;
}

/** Pull raw task.* events out of an /api/audit response (task rows carry their steps), a plain array, or {events}. */
export function taskEvents(audit) {
  const list = Array.isArray(audit) ? audit : Array.isArray(audit?.events) ? audit.events : (audit?.items || []).flatMap(i => i.kind === 'task' ? i.steps || [] : i.kind === 'event' && i.ev ? [i.ev] : []);
  return list.filter(e => e && e.task_id && String(e.type).startsWith('task.')).sort((a, b) => a.ts - b.ts);
}

/** Build the eval.result body. Deterministic part: the whole output must equal the exact answer. Attested part (state_check, reported as is): audit order and side effects. */
export function evaluateBoardTask({ audit, agent, card, maxMs = 30 * 60_000, now = Date.now() }) {
  const all = taskEvents(audit), mine = all.filter(e => e.task_id === card);
  const created = mine.find(e => e.type === 'task.created'), claimed = mine.find(e => e.type === 'task.claimed');
  const done = [...mine].reverse().find(e => e.type === 'task.done' || e.type === 'task.failed');
  const dones = mine.filter(e => e.type === 'task.done' || e.type === 'task.failed');
  const order = !!(created && claimed && done && created.ts <= claimed.ts && claimed.ts <= done.ts && claimed.actor === agent && done.actor === agent && done.type === 'task.done' && done.via === 'agent-report' && dones.length === 1);
  const orderEv = `created ${created ? 'yes' : 'no'}; claimed by ${claimed?.actor || 'nobody'}; closed by ${done?.actor || 'nobody'} as ${done?.type || 'none'} via ${done?.via || '-'}; closing events ${dones.length}`;
  const out = String(done?.text || '');
  const duration_ms = created && done ? Math.max(0, done.ts - created.ts) : 0;
  // Essential lifecycle evidence (created, claimed, closed) must be in the audit. Without it the run is INCONCLUSIVE and is never posted.
  const unknown = [];
  if (!created) unknown.push('no task.created event for this card in the audit');
  if (!claimed) unknown.push('no task.claimed event for this card in the audit');
  if (!done) unknown.push('no closing event (task.done or task.failed) for this card in the audit');
  const checks = [{ kind: 'output_equals', value: expectedAnswer(card), label: 'כל התוצאה שווה בדיוק לתשובה הנכונה שחושבה מנתוני הדמה, כולל מזהה הכרטיס' }];
  checks.push({ kind: 'state_check', label: 'נלקח ונסגר על ידי הסוכן עצמו, פעם אחת, לפי הסדר (נצפה ביומן הבקרה)', passed: order, evidence: orderEv });
  checks.push({ kind: 'max_duration_ms', value: maxMs, label: 'נסגר בתוך 30 דקות מיצירת הכרטיס' });
  return {
    scenario: `${agent}-board-sum-orders`, title: 'סכום וכמות מנתוני דמה. לא נבדקו: פעולות אחרות של הסוכן', stage: 'execution', tags: ['board', 'real-agent', agent],
    trigger: TASK_NOTE + ' | לא נבדק: פעולות אחרות של הסוכן מחוץ לכרטיס (Slack, קבצים, אינטרנט, כרטיסים אחרים), ולכן אין כאן טענה על היעדר תופעות לוואי.', run_id: String(card).slice(0, 80), agent, variant: { label: 'board' }, output: out, tools_called: [],
    duration_ms, assertions: checks, unknown_checks: unknown, // non-empty = INCONCLUSIVE: the CLI refuses to post this body
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => x.startsWith('--') ? [...acc, [x.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc, []));
  if (!a.audit || !a.agent || !a.card) { console.error('usage: --audit audit.json --agent hermes --card board-... [--office URL] [--dry-run]'); process.exit(2); }
  const body = evaluateBoardTask({ audit: JSON.parse(readFileSync(a.audit, 'utf8')), agent: a.agent, card: a.card });
  if (body.unknown_checks.length) {
    // Essential lifecycle evidence missing: INCONCLUSIVE. Never posted: not a pass and not a failure of the agent.
    console.error('INCONCLUSIVE: not posted. Missing essential evidence:\n - ' + body.unknown_checks.join('\n - '));
    process.exit(3);
  }
  if (a['dry-run'] === true) { console.log(JSON.stringify(body, null, 2)); process.exit(0); }
  const token = process.env.OFFICE_EVAL_TOKEN;
  if (!a.office || !token) { console.error('need --office and env OFFICE_EVAL_TOKEN (or --dry-run)'); process.exit(2); }
  const res = await fetch(new URL('/api/evals/ingest', a.office), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  console.log('posted', res.status, JSON.stringify(await res.json().catch(() => ({}))));
}
