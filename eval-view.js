// eval-view.js — the "בדיקות אמינות" panel (owner only). Lazy-loaded by main.js on first open; no dependencies.
// Renders GET /api/evals. Two stages, kept apart: "ביצוע משימות" (did the agent carry out the task correctly) and "איכות קוד".
// Honesty rules shown in the UI itself: counts are k of n runs (no percentage, no composite score); self-reported runs are
// labelled and counted apart; a judge score a producer reported is shown as "דווח, לא אומת"; what never ran says "לא הורץ".
const TZ = 'Asia/Jerusalem';
const NAMES = { ori: 'אורי', instinct: 'inna', hermes: 'Hermes', tab: 'tobi', board: 'הלוח' };
const CHECKS = { claimed: 'הסוכן לקח את המשימה', claimed_first: 'לקח לפני שסיים', finished_by_owner_of_task: 'הסוכן עצמו דיווח סיום (לא רישום בדיעבד)', has_result: 'צורפה תוצאה' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const who = id => NAMES[id] || (id ? id.charAt(0).toUpperCase() + id.slice(1) : '—');
const fmt = ts => new Intl.DateTimeFormat('he-IL', { timeZone: TZ, day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(ts);
const pctTxt = p => (Math.round(p * 10) / 10).toString().replace(/\.0$/, '') + '%';
// "80%  8/10": percentage of the runs actually made, always with the counts. No runs = "טרם נבדק", never 0%.
const frac = (k, n) => n ? `<b class="ev-frac" dir="ltr">${pctTxt(100 * k / n)}</b> <span class="ev-cnt" dir="ltr">${k}/${n}</span>` : '<b class="ev-frac ev-none">טרם נבדק</b>';
const pill = (cls, t) => `<span class="ev-pill ${cls}">${esc(t)}</span>`;
const VERD = { pass: ['עבר', 'ok'], fail: ['נכשל', 'bad'], none: ['אין בדיקות', 'off'], not_run: ['לא הורץ', 'off'], pending: ['ממתין לבדיקה', 'off'] };
const vpill = v => pill(VERD[v]?.[1] || 'off', VERD[v]?.[0] || v);

function runHtml(r) {
  const det = r.assertions.filter(a => a.type === 'deterministic'), jd = r.assertions.filter(a => a.type === 'judge');
  const src = r.source === 'evaluator' ? pill('ok', 'מעריך ייעודי') : pill('warn', 'דיווח עצמי של הסוכן');
  const rows = det.map(a => `<li class="ev-a ${a.passed ? 'p' : 'f'}"><span class="ev-ad">${a.passed ? '✓' : '✗'}</span><div><div>${esc(a.label)}</div><div class="ev-ev">${esc(a.evidence)}</div><div class="ev-basis">${a.basis === 'reported' ? 'דווח ע״י המריץ, לא חושב מחדש' : 'חושב מחדש בשרת מהראיות שנשלחו'}${a.reported_mismatch ? ' · <b>הדיווח סתר את החישוב</b>' : ''}</div></div></li>`).join('');
  const jrows = jd.map(a => `<li class="ev-a j"><span class="ev-ad">?</span><div><div>${esc(a.label)}</div><div class="ev-ev">ציון שדווח: ${a.judge.score} (סף ${a.judge.threshold}) · מודל שדווח: ${esc(a.judge.model)}</div>${a.evidence ? `<div class="ev-ev">${esc(a.evidence)}</div>` : ''}<div class="ev-basis">דווח ע״י המריץ, לא אומת. לא נספר באחוזי הצלחה.</div></div></li>`).join('');
  const hv = r.review ? `${vpill(r.review.verdict)}${r.review.note ? ` <span class="muted">${esc(r.review.note)}</span>` : ''}` : vpill('pending');
  return `<details class="ev-run" data-id="${esc(r.id)}"><summary><span class="ev-rt">${esc(fmt(r.ts))}</span><span>ריצה ${esc(r.attempt)}</span>${vpill(r.verdicts.det)}${src}<span class="muted">${esc(who(r.agent))}</span></summary>
    <div class="ev-rb">
      ${r.trigger ? `<div class="ev-k">הבקשה לסוכן</div><div class="ev-q" dir="auto">${esc(r.trigger)}</div>` : ''}
      <div class="ev-k">בדיקות בקוד</div><ul class="ev-al">${rows || '<li class="muted">אין</li>'}</ul>
      <div class="ev-k">מודל כשופט</div>${jrows ? `<ul class="ev-al">${jrows}</ul>` : '<div class="muted">לא הורץ</div>'}
      <div class="ev-k">בדיקה אנושית</div><div class="ev-hv">${hv}
        <span class="ev-btns"><button data-rv="pass" type="button">עבר</button><button data-rv="fail" type="button">נכשל</button><button data-rv="clear" type="button">נקה</button></span></div>
      ${r.tools?.length ? `<div class="ev-k">כלים שנקראו</div><div class="mono ev-tools" dir="ltr">${esc(r.tools.join(' → '))}</div>` : ''}
      ${r.output ? `<div class="ev-k">פלט שהסוכן החזיר</div><pre class="ev-out" dir="auto">${esc(r.output)}</pre>` : ''}
      <div class="ev-basis">הועלה ע״י ${esc(who(r.reported_by))}${r.duration_ms != null ? ` · ${Math.round(r.duration_ms)}ms` : ''}</div>
    </div></details>`;
}

function variantHtml(v) {
  const e = v.evaluator, s = v.self;
  const trust = `<div class="ev-trust">"מעריך ייעודי" אומר מי העלה את התוצאה: סוכן שהבעלים הגדיר כמריץ. זה לא מוכיח שהכלים והפלט שדווחו אמיתיים. בדיקות בקוד נבדקות מחדש בשרת מול מה שנשלח, ובדיקות מצב סופי (state_check) נלקחות כפי שדווחו.</div>`;
  const head = e.runs
    ? `${frac(e.k, e.n)} <span class="muted">מהריצות עברו את כל הבדיקות בקוד (${e.failed} נכשלו${e.unscored ? `, ${e.unscored} ללא בדיקות בקוד ולא נספרו` : ''}). אחוז מהריצות שבוצעו, לא הבטחה לאמינות בכל מצב</span>`
    : `${frac(0, 0)} <span class="muted">אין ריצות של מעריך ייעודי</span>`;
  const selfLine = s.runs ? `<div class="ev-self">דיווחי הסוכן על עצמו (לא נספרים למעלה): ${frac(s.k, s.n)}${s.unscored ? ` · ${s.unscored} ללא בדיקות בקוד ולא נספרו` : ''}</div>` : '';
  const j = v.judge.reported_runs ? `<div class="ev-self">מודל כשופט: דווח ב-${v.judge.reported_runs} ריצות (${esc(v.judge.models.join(', '))}), לא אומת, לא נספר</div>` : `<div class="ev-self">מודל כשופט: לא הורץ</div>`;
  const h = `<div class="ev-self">בדיקה אנושית: ${v.human.n ? `${frac(v.human.k, v.human.n)} עברו` : 'טרם נבדק'}${v.human.pending ? ` · ${v.human.pending} ממתינות` : ''}</div>`;
  const fails = v.top_failures.length ? `<div class="ev-fails">נכשל הכי הרבה: ${v.top_failures.map(f => `${esc(f.label)} (${f.count})`).join(' · ')}</div>` : '';
  return `<div class="ev-var"><div class="ev-vh"><b dir="auto">${esc(v.label)}</b>${v.model ? `<span class="muted"> · ${esc(v.model)}</span>` : ''}<span class="muted"> · ${v.runs_total} ריצות שנשמרו, אחרונה ${esc(fmt(v.last_ts))}</span></div>
    <div class="ev-head2">${head}</div>${e.runs ? trust : ''}${selfLine}${j}${h}${fails}${v.mismatches ? `<div class="ev-warn">${v.mismatches} בדיקות שהמריץ דיווח עליהן שונה מהחישוב בשרת</div>` : ''}
    <div class="ev-runs">${v.runs.map(runHtml).join('')}</div>${v.runs_total > v.runs.length ? `<div class="muted ev-more">מוצגות ${v.runs.length} אחרונות</div>` : ''}</div>`;
}

function scenarioHtml(s) {
  return `<section class="ev-scn"><div class="ev-sh"><h4 dir="auto">${esc(s.title)}</h4>${s.stage === 'code' ? pill('off', 'איכות קוד') : ''}${s.tags.map(t => `<span class="ev-tag">${esc(t)}</span>`).join('')}</div>
    ${s.variants.map(variantHtml).join('')}
    ${s.variants.length > 1 ? '<div class="muted ev-cmp">השוואה בין גרסאות: אחוזים וספירות בלבד. מדגם קטן לא מוכיח שגרסה אחת טובה מהשנייה.</div>' : ''}</section>`;
}

const ST = { clean: 'הסתיים נקי', no_result: 'דווח "בוצע" בלי תוצאה', reported_failed: 'הסוכן דיווח כשל', owner_backfill: 'נרשם בדיעבד ע״י בעלים, לא נספר', unknown: 'ההיסטוריה חלקית, לא נספר' };
let testNote = ''; // last result of the "send test task" button, kept across re-renders
function testPanel(ex, agents, enabled) {
  const canCreate = agents !== null;
  const t = ex?.tests, items = (t?.items || []).map(x => `<li><b dir="auto">${esc(x.title.replace(/^\[[^\]]*\]\s*/, ''))}</b> <span class="muted">${esc(who(x.agent))} · ${esc(ST[x.status])}</span>${x.result ? `<div class="ev-q" dir="auto">התוצאה שהסוכן דיווח (לבדיקה שלך, המשרד לא מאמת נכונות): ${esc(x.result)}</div>` : ''}</li>`).join('');
  const pend = (t?.pending || []).map(x => `<li class="muted">${esc(who(x.agent))} · ${x.claimed ? 'הסוכן לקח, עדיין לא סגר' : 'נשלחה, עדיין לא נלקחה'} · ${esc(fmt(x.ts))}</li>`).join('');
  return `<section class="ev-scn"><div class="ev-sh"><h4>בדיקת ביצוע ראשונה</h4>${pill('warn', 'מפעיל סוכן אמיתי')}</div>
    <div class="ev-note">שולח להרמס משימה קצרה בלוח: לחשב סכום וכמות מתוך 5 ערכי דמה קבועים ולהחזיר בפורמט מדויק, בלי פעולות נוספות. התשובה הנכונה ידועה מראש, ולכן אפשר לבדוק אותה באמת ולא רק לראות שהכרטיס נסגר. נבדקים רק התשובה, מי לקח וסגר את הכרטיס, הסדר והזמן. פעולות אחרות של הסוכן לא נבדקות. התוצאה תיספר כאן כשיסגור אותה. הכרטיס נוצר בדרך הרגילה של הלוח, כולל ההודעה הרגילה לסוכנים ב-Slack. הסוכן עלול להשתמש במודל בתשלום לפי ההגדרות שלו, והמשרד לא יודע אם ובכמה.</div>
    ${canCreate ? `<div class="ev-hv"><select data-testagent aria-label="סוכן">${agents.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select><button class="btn btn-glass" data-sendtest type="button"${agents.length && agents.every(a => a.online) && enabled ? '' : ' disabled'}>שלח משימת בדיקה</button></div>${agents.length && !agents.every(a => a.online) ? '<div class="ev-self"><b>הסוכן לא מחובר כרגע</b> (אין דיווח ממנו ב-10 הדקות האחרונות), לכן לא נשלחת אליו משימה שתחכה לשווא.</div>' : ''}${enabled ? '' : '<div class="ev-self"><b>השליחה כבויה.</b> היא תופעל רק אחרי שבעל המשרד יאשר אותה בהגדרות השרת (EVAL_TEST_DISPATCH), כי הסוכן עלול להשתמש במודל בתשלום וההודעה הרגילה נשלחת ל-Slack.</div>'}<div class="ev-self" id="ev-testmsg" aria-live="polite">${esc(testNote)}</div>` : ''}
    ${t?.n ? `<div>${frac(t.clean, t.n)} <span class="muted">ממשימות הבדיקה שנשלחו מכאן והסוכן סגר</span></div>` : '<div class="ev-self"><b>טרם נבדק</b>: עדיין לא נשלחה או נסגרה משימת בדיקה.</div>'}
    ${pend ? `<div class="ev-k">ממתינות</div><ul class="ev-bad">${pend}</ul>` : ''}${items ? `<ul class="ev-bad">${items}</ul>` : ''}</section>`;
}

function executionHtml(ex) {
  if (!ex || !ex.total) return `<section class="ev-scn"><div class="ev-sh"><h4>רישום הלוח</h4></div><div class="ev-note">עדיין אין בלוח משימות שהסתיימו (ההיסטוריה נשמרת ${ex?.retention_days || 30} ימים), לכן <b>טרם נבדק</b>. כשסוכן יסיים משימה מהלוח היא תיספר כאן.</div></section>`;
  const ag = ex.agents.map(a => {
    const extra = [['no_result', a.no_result], ['reported_failed', a.reported_failed]].filter(([, c]) => c).map(([k, c]) => `${ST[k]}: ${c}`);
    const out = [['owner_backfill', a.owner_backfill], ['unknown', a.unknown]].filter(([, c]) => c).map(([k, c]) => `${ST[k]}: ${c}`);
    return `<div class="ev-ag"><div><b>${esc(who(a.agent))}</b> ${frac(a.clean, a.n)} <span class="muted">מהמשימות שדווחו כסיום או כשל ע״י הסוכן עצמו הסתיימו נקי</span></div>
      ${extra.length ? `<div class="ev-fails">${extra.join(' · ')}</div>` : ''}${out.length ? `<div class="ev-self">מחוץ לאחוז: ${out.join(' · ')}</div>` : ''}</div>`;
  }).join('');
  const rows = ex.tasks.filter(t => t.status !== 'clean').slice(0, 12).map(t => `<li><span class="ev-rt">${esc(fmt(t.ts))}</span> <b dir="auto">${esc(t.title)}</b> <span class="muted">${esc(who(t.agent))} · ${esc(ST[t.status])}</span></li>`).join('');
  return `<section class="ev-scn"><div class="ev-sh"><h4>רישום הלוח: האם הסוכנים סגרו משימות כסדרן</h4>${pill('ok', 'חושב ע״י המשרד')}</div>
    <div class="ev-note">נספרות רק משימות שהסוכן עצמו סגר: "נקי" = דיווח "בוצע" וצירף תוצאה. הלוח עצמו כופה שרק המוקצה לוקח משימה ושסיום דורש אישור לקיחה, ולכן זה לא נספר כבדיקה. זה בודק רישום תהליך ולא אם התוצאה נכונה, ותוכן התוצאה הוא מילותיו של הסוכן. משימות שנרשמו בדיעבד ע״י בעלים או שחסר להן מידע בהיסטוריה (נשמרים ${ex.retention_days} ימים) מוצגות בנפרד ולא נספרות, כי חוסר ראיה אינו הפרה.</div>
    ${ag}${rows ? `<div class="ev-k">משימות שלא נספרו כנקיות</div><ul class="ev-bad">${rows}</ul>` : ''}</section>`;
}

export function createEval({ body, filters, sub, load, review, createTest, testAgents }) {
  let sending = false;
  let stage = 'execution', tag = '', variant = '', data = null, timer = null, busy = false;
  const qs = () => new URLSearchParams({ stage, ...(tag ? { tag } : {}), ...(variant ? { variant } : {}) }).toString();
  const open = () => new Set([...body.querySelectorAll('details[open]')].map(d => d.dataset.id));
  function render() {
    const keep = open();
    filters.innerHTML = `<div class="au-seg" role="tablist">${[['execution', 'ביצוע משימות'], ['code', 'איכות קוד']].map(([k, t]) => `<button type="button" role="tab" data-stage="${k}" class="${stage === k ? 'on' : ''}">${t}</button>`).join('')}</div>
      <div class="au-sel"><label>תג<select data-f="tag"><option value="">הכל</option>${(data?.tags || []).map(t => `<option ${t === tag ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      <label>גרסה<select data-f="variant"><option value="">הכל</option>${(data?.variants || []).map(t => `<option ${t === variant ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label></div>`;
    sub.textContent = stage === 'execution' ? 'האם הסוכן עשה את המשימה נכון. ספירת ריצות אמיתיות בלבד' : 'איכות הקוד שהסוכן כתב. בנפרד מביצוע המשימות';
    if (!data) { body.innerHTML = '<div class="au-empty">טוען…</div>'; return; }
    const scn = data.scenarios;
    const intro = `<div class="ev-intro">כל אחוז כאן הוא חלק מהריצות שבוצעו בפועל, ולצידו מספר הריצות (למשל 8/10). זה לא הבטחה לאמינות בכל מצב. אין ציון משוקלל ואין נתוני דמו. כשאין ריצות כתוב "טרם נבדק", לא 0%.</div>`;
    const empty = stage === 'code' && !scn.length
      ? '<div class="au-empty"><b>טרם נבדק: לא הורצו בדיקות איכות קוד.</b><br>בדיקת קוד אמיתית היא הרצת פקודה (בדיקות או בנייה) ותוצאתה, לא טקסט או שם כלי. המריץ <span dir="ltr" class="mono">integrations/eval-runner.mjs</span> מריץ פקודות כאלה על המחשב של המפעיל, בלי קריאה לשירות חיצוני, ושולח את קוד היציאה והסיום לכאן.</div>'
      : stage === 'execution' && !scn.length ? '<div class="au-empty"><b>לא הורצו תרחישי בדיקה.</b><br>רישום הלוח למעלה מבוסס על משימות אמיתיות ופועל מעצמו. תרחישים עם תנאי הצלחה יופיעו כשמריץ ייעודי ישלח אותם (<span dir="ltr" class="mono">integrations/eval-runner.mjs</span>).</div>' : '';
    body.innerHTML = intro + (stage === 'execution' ? testPanel(data.execution, createTest ? (testAgents ? testAgents() : []) : null, !!data.dispatch_enabled) + executionHtml(data.execution) : '') + scn.map(scenarioHtml).join('') + empty;
    for (const d of body.querySelectorAll('details')) if (keep.has(d.dataset.id)) d.open = true;
  }
  async function refresh() {
    if (busy) return; busy = true;
    try { data = await load(qs()); } catch (e) { body.innerHTML = '<div class="au-empty">לא הצלחתי לטעון את הבדיקות.<br><button class="btn btn-ghost" data-retry type="button">נסה שוב</button></div>'; busy = false; return; }
    busy = false; render();
  }
  filters.addEventListener('click', e => { const b = e.target.closest('[data-stage]'); if (b) { stage = b.dataset.stage; tag = variant = ''; data = null; render(); refresh(); } });
  filters.addEventListener('change', e => { const f = e.target.dataset.f; if (f === 'tag') tag = e.target.value; else if (f === 'variant') variant = e.target.value; else return; refresh(); });
  body.addEventListener('click', async e => {
    if (e.target.closest('[data-retry]')) { body.innerHTML = '<div class="au-empty">טוען…</div>'; return refresh(); }
    const st = e.target.closest('[data-sendtest]');
    if (st && createTest) {
      if (sending) return;
      const sel = body.querySelector('[data-testagent]'), agent = sel.value, name = sel.selectedOptions[0]?.textContent || agent, msg = body.querySelector('#ev-testmsg');
      if (!agent) return;
      if (!confirm(`לשלוח משימת בדיקה ל-${name}?\nהסוכן יתחיל לעבוד עליה בפועל. הכרטיס יופיע בלוח וההודעה הרגילה תישלח לסוכנים ב-Slack. ייתכן שהסוכן ישתמש במודל בתשלום, ואין למשרד דרך לדעת.`)) return;
      sending = true; st.disabled = true; testNote = ''; msg.textContent = 'שולח…';
      try { const out = await createTest(agent); testNote = out?.duplicate ? `הבקשה כבר נקלטה קודם עבור ${name}. לא נוצר כרטיס נוסף.` : `נשלחה ל-${name}. התוצאה תופיע כאן אחרי שהסוכן יסגור את המשימה.`; }
      catch (err) { testNote = 'לא ברור אם הכרטיס נוצר. אפשר ללחוץ שוב: אותה בקשה לא תיצור כרטיס כפול. אם נשלח, הוא יופיע בהמתנה.'; msg.textContent = testNote; st.disabled = false; sending = false; return refresh(); }
      sending = false;
      st.disabled = false; return refresh();
    }
    const b = e.target.closest('[data-rv]'); if (!b) return;
    const id = b.closest('details')?.dataset.id; if (!id) return;
    b.disabled = true;
    try { await review({ id, verdict: b.dataset.rv }); } catch (err) { console.warn(err); }
    await refresh();
  });
  return { start() { refresh(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden) refresh(); }, 20000); }, stop() { clearInterval(timer); timer = null; } };
}
