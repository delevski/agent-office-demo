// join.js — the public agent self-registration page (/join/<id>#<secret>).
// The secret lives in the URL fragment: it never reaches the server in a request line, log or
// referrer. The page fetches the public manifest, shows the agent (or its operator) the exact
// steps, can register manually from the browser as a fallback, and polls until the agent connects.

const app = document.getElementById('app');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const idMatch = /^\/join\/([a-f0-9]{16})$/.exec(location.pathname);
const secretMatch = /^#([a-f0-9]{32})$/.exec(location.hash || '');
const inviteId = idMatch?.[1] || '';
const secret = secretMatch?.[1] || '';
const origin = location.origin;

let poll = null, manifest = null, registering = false;

function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

function curlBlock(cmd) {
  return `<div class="code" dir="ltr"><pre>${esc(cmd)}</pre><button class="copy" type="button" data-copy="${esc(cmd)}">העתקה</button></div>`;
}

function registerCmd() {
  return `curl -X POST ${origin}/api/register \\
  -H 'Content-Type: application/json' \\
  -d '{"id":"${inviteId}","secret":"${secret || '<החלק שאחרי # בקישור>'}'}}'`;
}
function ingestCmd() {
  return `curl -X POST ${origin}/api/ingest \\
  -H "Authorization: Bearer $OFFICE_TOKEN" \\
  -H 'Content-Type: application/json' \\
  -d '{"kind":"status","status":"idle","note":"connected"}'`;
}
function inboxCmd() {
  return `curl ${origin}/api/inbox \\
  -H "Authorization: Bearer $OFFICE_TOKEN"`;
}

function renderError(title, text) {
  stopPoll();
  app.innerHTML = `<div class="state bad"><div class="big">⛔</div><h2>${esc(title)}</h2><p>${esc(text)}</p></div>`;
}

function renderSuccess(st) {
  stopPoll();
  app.innerHTML = `
    <div class="state ok">
      <div class="big">✅</div>
      <h2>${esc(st.name || st.agent)} מחובר למשרד</h2>
      <p>הרישום הושלם${st.connected ? ' והסוכן כבר מדווח - הוא מופיע עכשיו במשרד של אורי.' : '.'}</p>
      ${st.board ? '<p class="muted">הסוכן יכול גם לקבל משימות מהלוח דרך תיבת המשימות שלו.</p>' : ''}
    </div>
    <details class="more"><summary>מדריך דיווח (למי שמפעיל את הסוכן)</summary>
      <p>דיווח סטטוס או משימה, עם הטוקן שהתקבל ברישום:</p>
      ${curlBlock(ingestCmd())}
      ${st.board ? `<p>בדיקת משימות שמחכות לסוכן (כל כמה דקות). לכל משימה: <code dir="ltr">POST /api/inbox/&lt;task-id&gt;/claim {}</code>, שומרים את ה־claimToken ומדווחים התקדמות/סיום ל־/api/ingest איתו.</p>${curlBlock(inboxCmd())}` : ''}
    </details>`;
  wireCopy();
}

function renderPending(m) {
  const exp = new Date(m.expires_at);
  const expStr = new Intl.DateTimeFormat('he-IL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jerusalem' }).format(exp);
  app.innerHTML = `
    <div class="invite-for">
      <span class="pill">ממתין לרישום</span>
      <h2>הזמנה עבור <b>${esc(m.agent.name)}</b> <code class="mono" dir="ltr">${esc(m.agent.id)}</code></h2>
      <p class="muted">הקישור תקף עד ${esc(expStr)} · שימוש חד־פעמי${m.agent.board ? ' · כולל קבלת משימות מהלוח' : ''}</p>
    </div>
    ${!secret ? `<div class="warn">⚠️ הקישור שאצלך חסר את החלק שאחרי ה־# (הסוד החד־פעמי). בקש את הקישור המלא שוב - בלי אותו חלק אי אפשר להירשם.</div>` : ''}
    <ol class="steps">
      <li>
        <b>רישום:</b> שולחים בקשה אחת עם המזהה והסוד שבקישור. בתשובה חוזר טוקן אישי לסוכן.
        ${curlBlock(registerCmd())}
      </li>
      <li>
        <b>שומרים את הטוקן</b> שחוזר (משתנה סביבה <code dir="ltr">OFFICE_TOKEN</code>). הוא מוצג פעם אחת בלבד ואי אפשר לשחזר אותו.
      </li>
      <li>
        <b>מתחילים לדווח</b> - סטטוס, התחלת משימה, סיום, קונפיגורציה:
        ${curlBlock(ingestCmd())}
      </li>
      ${m.agent.board ? `<li>
        <b>משימות מהלוח:</b> בודקים את התיבה כל כמה דקות, לוקחים משימה ב־claim ומדווחים התקדמות עם ה־claimToken:
        ${curlBlock(inboxCmd())}
      </li>` : ''}
    </ol>
    <div class="row">
      <button class="primary" id="do-register" type="button" ${!secret ? 'disabled' : ''}>רישום ידני מהדפדפן</button>
      <span class="muted" id="reg-status" role="status"></span>
    </div>
    <details class="more"><summary>מפרט לסוכן (JSON) - אפשר לתת לסוכן לקרוא ישירות</summary>
      <div class="code" dir="ltr"><pre>${esc(JSON.stringify(m, null, 2))}</pre><button class="copy" type="button" data-copy="${esc(JSON.stringify(m, null, 2))}">העתקה</button></div>
    </details>
    <div class="wait" id="wait-line"><span class="dot"></span> ממתין שהסוכן יירשם… (הדף מתעדכן לבד)</div>`;
  wireCopy();
  const btn = document.getElementById('do-register');
  btn?.addEventListener('click', async () => {
    if (registering) return;
    registering = true;
    btn.disabled = true; btn.textContent = 'נרשם…';
    const status = document.getElementById('reg-status');
    try {
      const r = await fetch('/api/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: inviteId, secret }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || ('שגיאה ' + r.status));
      stopPoll();
      app.innerHTML = `
        <div class="state ok"><div class="big">🔑</div><h2>הסוכן נרשם</h2>
        <p>זה הטוקן האישי של <b>${esc(d.name)}</b> - מוצג <b>פעם אחת</b>. העתק אותו עכשיו לסביבת הסוכן (<code dir="ltr">OFFICE_TOKEN</code>):</p>
        <div class="code token" dir="ltr"><pre>${esc(d.token)}</pre><button class="copy" type="button" data-copy="${esc(d.token)}">העתקת הטוקן</button></div>
        <p class="muted">${esc(d.note_he || '')}</p></div>`;
      wireCopy();
    } catch (e) {
      status.textContent = 'לא נרשם: ' + e.message;
      btn.disabled = false; btn.textContent = 'רישום ידני מהדפדפן';
      registering = false;
    }
  });
}

function wireCopy() {
  app.querySelectorAll('.copy').forEach(b => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'הועתק ✓'; setTimeout(() => { b.textContent = b.closest('.token') ? 'העתקת הטוקן' : 'העתקה'; }, 1800); }
    catch { b.textContent = 'סמן והעתק ידנית'; }
  }));
}

async function checkStatus() {
  try {
    const r = await fetch(`/api/invite/${inviteId}/status`);
    const d = await r.json();
    if (d.ok && d.state === 'registered') renderSuccess(d);
    else if (d.ok && d.state !== 'pending') renderState(d);
  } catch { /* keep polling */ }
}

function renderState(st) {
  stopPoll();
  if (st.state === 'registered') return renderSuccess(st);
  if (st.state === 'expired') return renderError('פג תוקף ההזמנה', 'הקישור הזה כבר לא בתוקף. בקש מהבעלים קישור הזמנה חדש.');
  if (st.state === 'revoked') return renderError('ההזמנה בוטלה', 'הבעלים ביטל את הקישור הזה. בקש קישור חדש.');
  if (st.state === 'locked') return renderError('ההזמנה ננעלה', 'יותר מדי ניסיונות רישום שגויים. בקש מהבעלים קישור חדש.');
  renderError('משהו לא תקין', 'מצב ההזמנה לא מזוהה. בקש מהבעלים קישור חדש.');
}

async function boot() {
  if (!inviteId) return renderError('הקישור לא תקין', 'כתובת ההזמנה לא מזוהה. ודא שהעתקת את הקישור המלא.');
  let m;
  try {
    const r = await fetch(`/api/invite/${inviteId}`);
    m = await r.json();
    if (!r.ok || !m.ok) throw new Error(m.error || 'not found');
  } catch { return renderError('ההזמנה לא נמצאה', 'ייתכן שהקישור שונה או נמחק. בקש מהבעלים קישור חדש.'); }
  manifest = m;
  if (m.state === 'pending') {
    renderPending(m);
    poll = setInterval(checkStatus, 3000);
  } else {
    renderState({ state: m.state, agent: m.agent.id, name: m.agent.name, board: m.agent.board, connected: m.state === 'registered' });
  }
}

boot();
