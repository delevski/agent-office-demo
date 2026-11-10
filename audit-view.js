// audit-view.js — the "בקרה" panel (owner only). Lazy-loaded by main.js on first open; no dependencies.
// Renders GET /api/audit: one chronological timeline where a PR (or a board task) is ONE row whose steps expand on click,
// and agent-to-agent messages are single rows. Filters: type, day, agent, PR/repo. All text goes through esc().
const TZ = 'Asia/Jerusalem';
const NAMES = { ori: 'אורי', instinct: 'Instinct', hermes: 'Hermes', tab: 'Tab', board: 'הלוח', legacy: 'מפתח כללי' };
const CHANNELS = { whatsapp: 'WhatsApp', slack: 'Slack', imessage: 'iMessage', email: 'מייל', phone: 'טלפון', board: 'לוח', site: 'האתר', github: 'GitHub', handoff: 'העברה', other: 'אחר' };
const PR_STATUS = { open: ['נפתח', 'st-open'], reviewed: ['נבדק', 'st-rev'], changes_requested: ['נדרשו תיקונים', 'st-warn'], approved: ['אושר', 'st-ok'], merged: ['מוזג', 'st-merged'], deployed: ['באוויר', 'st-live'] };
const TASK_STATUS = { queued: ['ממתין', 'st-open'], running: ['בעבודה', 'st-rev'], done: ['הושלם', 'st-live'], failed: ['נכשל', 'st-bad'], cancelled: ['בוטל', 'st-off'] };
const VERDICT = { approved: ['אישר', 'v-ok'], changes_requested: ['ביקש תיקונים', 'v-warn'], commented: ['הגיב', 'v-note'] };
const TYPES = [['', 'הכל'], ['pr', 'PR'], ['message', 'הודעות'], ['task', 'משימות'], ['deploy', 'פריסות']];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => /^https?:\/\/[^\s"'<>]+$/i.test(u || '') ? u : '';
const who = id => NAMES[id] || (id ? id.charAt(0).toUpperCase() + id.slice(1) : '—');
const whoList = s => String(s || '').split(',').map(x => who(x.trim())).join(', ');
const fmtTime = ts => new Intl.DateTimeFormat('he-IL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(ts);
const dayKey = ts => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
function dayLabel(ts, now) {
  const k = dayKey(ts), today = dayKey(now), yest = dayKey(now - 86400_000);
  const d = new Intl.DateTimeFormat('he-IL', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(ts);
  return k === today ? 'היום · ' + d : k === yest ? 'אתמול · ' + d : d;
}
const shortDay = k => { const [, m, d] = k.split('-'); return `${+d}/${+m}`; };
const ic = (n, cls = '') => `<svg class="ico ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const a = (url, text) => safeUrl(url) ? `<a href="${esc(safeUrl(url))}" target="_blank" rel="noopener">${text}</a>` : text;
const chip = (map, k) => { const [t, c] = map[k] || [k, 'st-open']; return `<span class="au-chip ${c}">${esc(t)}</span>`; };

/* ---------- one step of a PR / task ---------- */
function stepHtml(s) {
  const t = fmtTime(s.ts), by = s.reported_by && s.reported_by !== s.actor ? `<span class="au-rep" title="הסוכן שדיווח על הפעולה">דווח ע״י ${esc(who(s.reported_by))}</span>` : '';
  const row = (icon, cls, main, extra = '') => `<li class="au-step ${cls}"><span class="au-dot">${ic(icon)}</span><div class="au-sb"><div class="au-sline"><span class="au-sm">${main}</span><span class="au-time">${esc(t)}</span></div>${extra}</div></li>`;
  switch (s.type) {
    case 'pr.opened': return row('git-pull-request', 'k-open', `<b dir="auto">${esc(who(s.actor))}</b> פתח <bdi>PR</bdi> ${by}`);
    case 'pr.reviewed': {
      const [vt, vc] = VERDICT[s.verdict] || VERDICT.commented;
      return row('scan-eye', 'k-rev', `<b dir="auto">${esc(who(s.actor))}</b> ביקר${s.to ? ` את ${esc(who(s.to))}` : ''} · <span class="au-v ${vc}">${esc(vt)}</span>${s.findings ? ` · ${s.findings} ממצאים` : ''} ${by}`, s.text ? `<div class="au-quote au-plain">${esc(s.text)}</div>` : '');
    }
    case 'pr.approved': return row('circle-check', 'k-appr', `<b dir="auto">${esc(who(s.actor))}</b> אישר · <span class="au-ch">${esc(CHANNELS[s.channel] || s.channel)}</span>`,
      `<div class="au-quote">“${esc(s.quote)}”</div><div class="au-rep au-rep-warn">דווח ע״י ${esc(who(s.reported_by))} · לא אומת מול ${esc(who(s.actor))}</div>`);
    case 'pr.merged': return row('git-merge', 'k-merge', `<b dir="auto">${esc(who(s.actor))}</b> מיזג${s.sha ? ` · <span class="mono au-sha">${esc(s.sha.slice(0, 7))}</span>` : ''} ${by}`);
    case 'deploy': return row('rocket', 'k-dep', `<b dir="auto">${esc(who(s.actor))}</b> ${s.status === 'failed' ? 'פריסה נכשלה' : s.status === 'rolled_back' ? 'ביטל פריסה' : 'פרס'} · ${esc(s.target || '')}${s.sha ? ` · <span class="mono au-sha">${esc(String(s.sha).slice(0, 12))}</span>` : ''} ${by}`);
    case 'task.created': return row('plus', 'k-task', `<b dir="auto">${esc(who(s.actor))}</b> ${s.via === 'ticket' ? 'פתח טיקט' : 'יצר משימה'} ל-<b dir="auto">${esc(who(s.to))}</b>`, s.text ? `<div class="au-quote au-plain">${esc(s.text)}</div>` : '');
    case 'task.claimed': return row('inbox', 'k-task', `<b dir="auto">${esc(who(s.actor))}</b> לקח את המשימה`);
    case 'task.done': return row('check', 'k-done', `<b dir="auto">${esc(who(s.actor))}</b> סיים`, s.text ? `<div class="au-quote au-plain">${esc(s.text)}</div>` : '');
    case 'task.failed': return row('circle-x', 'k-bad', `<b dir="auto">${esc(who(s.actor))}</b> דיווח כשל`, s.text ? `<div class="au-quote au-plain">${esc(s.text)}</div>` : '');
    case 'task.cancelled': return row('x', 'k-bad', `<b dir="auto">${esc(who(s.actor))}</b> ביטל את המשימה`);
    default: return row('circle-dot', '', esc(s.type));
  }
}
/* ---------- one-line summary of a PR: who did each stage ---------- */
function prSummary(it) {
  const by = t => it.steps.find(s => s.type === t), last = t => [...it.steps].reverse().find(s => s.type === t);
  const parts = [];
  const o = by('pr.opened'); if (o) parts.push(`נפתח: <b dir="auto">${esc(who(o.actor))}</b>`);
  const r = last('pr.reviewed'); if (r) parts.push(`נבדק: <b dir="auto">${esc(who(r.actor))}</b>`);
  const ap = last('pr.approved'); if (ap) parts.push(`אושר: <b dir="auto">${esc(who(ap.actor))}</b> <span class="au-ch">${esc(CHANNELS[ap.channel] || ap.channel)}</span>`);
  const m = by('pr.merged'); if (m) parts.push(`מוזג: <b dir="auto">${esc(who(m.actor))}</b>`);
  const d = last('deploy'); if (d) parts.push(`נפרס: <b dir="auto">${esc(who(d.actor))}</b>`);
  return parts.join(' · ');
}
function prHtml(it, open) {
  const num = it.pr ? `<span class="au-num mono">#${esc(it.pr)}</span>` : '';
  const repo = it.repo ? `<span class="au-repo mono">${esc(it.repo.split('/').pop())}</span>` : '';
  return `<article class="au-item au-pr${open ? ' open' : ''}" data-key="${esc(it.key)}">
    <button class="au-head" type="button" aria-expanded="${open}">
      <span class="au-ico k-pr">${ic('git-pull-request')}</span>
      <span class="au-main"><span class="au-title">${num}<span class="au-tt" dir="rtl">${esc(it.title || 'PR ללא כותרת')}</span></span><span class="au-sub">${prSummary(it)}</span></span>
      <span class="au-side">${chip(PR_STATUS, it.status)}<span class="au-time">${esc(fmtTime(it.ts))}</span></span>
      <span class="au-caret">${ic('chevron-left')}</span>
    </button>
    <div class="au-detail"><ol class="au-steps">${it.steps.map(stepHtml).join('')}</ol>
      <div class="au-foot">${repo}${a(it.link, `<span class="au-open">פתיחה ב-GitHub ↗</span>`)}</div></div>
  </article>`;
}
function taskHtml(it, open) {
  const ticket = it.via === 'ticket';
  return `<article class="au-item au-task${open ? ' open' : ''}" data-key="${esc(it.key)}">
    <button class="au-head" type="button" aria-expanded="${open}">
      <span class="au-ico k-task">${ic(ticket ? 'handshake' : 'clipboard-list')}</span>
      <span class="au-main"><span class="au-title"><span class="au-tt" dir="rtl">${esc(it.title)}</span></span><span class="au-sub">${ticket ? 'טיקט' : 'משימה'}: <b dir="auto">${esc(who(it.from))}</b> <span class="au-to">אל</span> <b dir="auto">${esc(who(it.to))}</b></span></span>
      <span class="au-side">${chip(TASK_STATUS, it.status)}<span class="au-time">${esc(fmtTime(it.ts))}</span></span>
      <span class="au-caret">${ic('chevron-left')}</span>
    </button>
    <div class="au-detail"><ol class="au-steps">${it.steps.map(stepHtml).join('')}</ol></div>
  </article>`;
}
function eventHtml(it) {
  const e = it.ev;
  if (e.type === 'deploy') return `<article class="au-item au-msg"><div class="au-head static"><span class="au-ico k-dep">${ic('rocket')}</span><span class="au-main"><span class="au-title">${esc(who(e.actor))} פרס · ${esc(e.target || '')}</span><span class="au-sub">${e.sha ? `<span class="mono au-sha">${esc(String(e.sha).slice(0, 12))}</span> · ` : ''}${e.status === 'failed' ? 'נכשל' : 'הצליח'}${e.text ? ' · ' + esc(e.text) : ''}</span></span><span class="au-side"><span class="au-time">${esc(fmtTime(e.ts))}</span></span></div></article>`;
  return `<article class="au-item au-msg"><div class="au-head static">
    <span class="au-ico k-msg">${ic('message-circle')}</span>
    <span class="au-main"><span class="au-title au-from"><b dir="auto">${esc(who(e.actor))}</b> <span class="au-to">אל</span> <b dir="auto">${esc(whoList(e.to))}</b></span><span class="au-text">${esc(e.text)}</span>${e.link ? `<span class="au-sub">${a(e.link, 'קישור ↗')}</span>` : ''}</span>
    <span class="au-side"><span class="au-chip st-ch">${esc(CHANNELS[e.channel] || e.channel)}</span><span class="au-time">${esc(fmtTime(e.ts))}</span></span></div></article>`;
}

/* ---------- the panel ---------- */
export function createAudit({ body, filters, sub, load }) {
  const state = { type: '', day: '', agent: '', q: '', open: new Set(), data: null, busy: false, err: '' };
  let timer = null, seq = 0;

  function query() {
    const p = new URLSearchParams();
    if (state.type) p.set('type', state.type);
    if (state.day) p.set('day', state.day);
    if (state.agent) p.set('agent', state.agent);
    const q = state.q.trim();
    if (q) p.set(/^(?:[\w.-]+\/[\w.-]+)?#?\d+$/.test(q) && !/^[\w.-]+\/[\w.-]+$/.test(q) ? 'pr' : 'repo', q.replace(/^#/, ''));
    return p.toString();
  }
  async function refresh() {
    const my = ++seq; state.busy = true;
    try { const d = await load(query()); if (my !== seq || !d) return; state.data = d; state.err = ''; } catch (e) { if (my === seq) state.err = 'לא הצלחתי לטעון את יומן הבקרה'; }
    state.busy = false; render();
  }
  function renderFilters() {
    const d = state.data, c = d?.counts || {};
    const count = k => { const n = k === 'pr' ? c.pr : k === 'message' ? c.message : k === 'task' ? c.task : c.deploy; return k && d && n ? ` <i>${n}</i>` : ''; };
    const days = (d?.days || []).map(x => `<option value="${esc(x.day)}"${x.day === state.day ? ' selected' : ''}>${esc(shortDay(x.day))} · ${x.count}</option>`).join('');
    const agents = (d?.agents || []).map(x => `<option value="${esc(x)}"${x === state.agent ? ' selected' : ''}>${esc(who(x))}</option>`).join('');
    filters.innerHTML = `<div class="au-seg" role="tablist" aria-label="סוג">${TYPES.map(([k, t]) => `<button type="button" role="tab" aria-selected="${state.type === k}" class="${state.type === k ? 'on' : ''}" data-type="${k}">${t}${state.type === k || !k ? '' : count(k)}</button>`).join('')}</div>
      <div class="au-sel">
        <label><span>יום</span><select data-f="day"><option value="">הכל</option>${days}</select></label>
        <label><span>סוכן</span><select data-f="agent"><option value="">כולם</option>${agents}</select></label>
        <label class="au-q"><span>PR / ריפו</span><input data-f="q" type="search" inputmode="search" dir="ltr" placeholder="#16 או owner/repo" value="${esc(state.q)}" autocomplete="off"></label>
        ${state.type || state.day || state.agent || state.q ? '<button class="au-reset" type="button" data-reset>ניקוי</button>' : ''}
      </div>`;
  }
  function render() {
    const d = state.data;
    if (!d) { body.innerHTML = `<div class="au-empty">${state.err ? esc(state.err) : 'טוען…'}</div>`; return; }
    sub.textContent = `מי אישר, מי מיזג, מי כתב למי · ${d.total} שורות${d.truncated ? ' (הצגת החדשות ביותר)' : ''}`;
    // keep the focused field while typing
    const sig = JSON.stringify([state.type, state.day, state.agent, d.days, d.agents, d.counts]);
    if (sig !== state.sig && !(filters.contains(document.activeElement) && document.activeElement.dataset.f === 'q')) { state.sig = sig; renderFilters(); }
    if (!d.items.length) { body.innerHTML = `<div class="au-empty"><b>אין אירועים לפי הסינון.</b><br>${state.type || state.day || state.agent || state.q ? 'נסה לנקות את הסינון.' : 'כשסוכן ידווח <span class="mono">pr.approved</span>, <span class="mono">pr.merged</span>, <span class="mono">message</span> וכו׳ ל-<span class="mono">/api/ingest</span>, זה יופיע כאן.'}</div>`; return; }
    let lastDay = '', html = '';
    for (const it of d.items) {
      const k = dayKey(it.ts);
      if (k !== lastDay) { lastDay = k; html += `<h4 class="au-day">${esc(dayLabel(it.ts, d.now))}</h4>`; }
      html += it.kind === 'pr' ? prHtml(it, state.open.has(it.key)) : it.kind === 'task' ? taskHtml(it, state.open.has(it.key)) : eventHtml(it);
    }
    body.innerHTML = html + (state.err ? `<div class="au-empty">${esc(state.err)}</div>` : '');
  }
  filters.addEventListener('click', e => {
    const t = e.target.closest('[data-type]');
    if (t) { state.type = t.dataset.type; refresh(); return; }
    if (e.target.closest('[data-reset]')) { Object.assign(state, { type: '', day: '', agent: '', q: '' }); refresh(); }
  });
  filters.addEventListener('change', e => { const f = e.target.dataset?.f; if (f && f !== 'q') { state[f] = e.target.value; refresh(); } });
  let deb = 0;
  filters.addEventListener('input', e => { if (e.target.dataset?.f === 'q') { state.q = e.target.value; clearTimeout(deb); deb = setTimeout(refresh, 300); } });
  body.addEventListener('click', e => {
    const h = e.target.closest('.au-head:not(.static)'); if (!h || e.target.closest('a')) return;
    const card = h.parentElement, key = card.dataset.key, open = !card.classList.contains('open');
    card.classList.toggle('open', open); h.setAttribute('aria-expanded', open);
    open ? state.open.add(key) : state.open.delete(key);
  });
  return {
    start() { refresh(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden && body.offsetParent !== null) refresh(); }, 20_000); },
    stop() { clearInterval(timer); timer = null; },
    state,
  };
}
