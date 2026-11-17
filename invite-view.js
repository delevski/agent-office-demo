// invite-view.js — the owner-only "הזמנת סוכן" panel (lazy-loaded by main.js on first open).
// Creates one-time invite links (/join/<id>#<secret> - the secret lives in the URL fragment,
// so it never reaches the server, a log or a referrer), lists invites and registered agents,
// and revokes either. All writes go through the session API with same-origin checks server-side.

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATE_HE = {
  pending: ['ממתין לרישום', 'st-pending'],
  registered: ['נרשם ✓', 'st-ok'],
  expired: ['פג תוקף', 'st-dead'],
  revoked: ['בוטל', 'st-dead'],
  locked: ['נעול (ניסיונות שגויים)', 'st-dead'],
  notfound: ['לא נמצא', 'st-dead'],
};

function when(ts) {
  return new Intl.DateTimeFormat('he-IL', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Jerusalem' }).format(new Date(ts));
}

export function createInvite({ body, toast, onChanged, onUnauthorized }) {
  let data = null, busy = false, createdUrl = '', createdName = '';

  async function api(path, payload) {
    const r = await fetch(path, {
      method: payload === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (r.status === 401) { onUnauthorized?.(); throw new Error('unauthorized'); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) throw new Error(d.error || ('שגיאה ' + r.status));
    return d;
  }

  function normalizeId(raw) {
    return String(raw || '').trim().toLowerCase()
      .replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  }

  function render() {
    const invites = data?.invites || [], agents = data?.agents || [];
    body.innerHTML = `
      <form class="iv-form" id="iv-form" novalidate>
        <div class="iv-row">
          <label class="grow">שם הסוכן<input id="iv-name" type="text" maxlength="40" required autocomplete="off" placeholder="למשל: Grok"></label>
          <label>מזהה (באנגלית)<input id="iv-id" type="text" maxlength="30" autocomplete="off" dir="ltr" placeholder="grok"></label>
        </div>
        <div class="iv-row">
          <label>תוקף הקישור<select id="iv-ttl">
            <option value="24">יום</option>
            <option value="72">3 ימים</option>
            <option value="168" selected>7 ימים</option>
          </select></label>
          <label class="iv-check"><input id="iv-board" type="checkbox" checked> <span>לאפשר קבלת משימות מהלוח</span></label>
        </div>
        <div class="iv-err" id="iv-err" role="alert"></div>
        <div class="modal-actions"><button class="btn btn-gold" id="iv-submit" type="submit">יצירת קישור הזמנה</button></div>
      </form>
      <div class="iv-created hidden" id="iv-created">
        <div class="iv-created-title">✅ הקישור מוכן - שלח אותו לסוכן (או למי שמפעיל אותו):</div>
        <div class="iv-linkbox" dir="ltr"><code id="iv-link"></code><button class="btn btn-ghost" id="iv-copy" type="button">העתקה</button></div>
        <div class="muted">החלק אחרי ה־# הוא הסוד החד־פעמי - הוא לא נשמר בשרת ולא נשלח אליו. אפשר גם <a id="iv-open" href="#" target="_blank" rel="noopener">לפתוח את דף ההצטרפות</a> ולראות מה הסוכן יראה.</div>
      </div>
      <h4 class="iv-h">הזמנות</h4>
      <div class="iv-list" id="iv-invites">${invites.length ? invites.map(inviteRow).join('') : '<div class="iv-empty">עוד לא נוצרו הזמנות.</div>'}</div>
      <h4 class="iv-h">סוכנים שנרשמו</h4>
      <div class="iv-list" id="iv-agents">${agents.length ? agents.map(agentRow).join('') : '<div class="iv-empty">עוד לא נרשם אף סוכן דרך הזמנה.</div>'}</div>`;
    wire();
    if (createdUrl) showCreated(createdUrl, createdName);
  }

  function inviteRow(i) {
    const [label, cls] = STATE_HE[i.state] || [i.state, 'st-dead'];
    return `<div class="iv-item">
      <span class="iv-state ${cls}">${label}</span>
      <span class="grow"><b>${esc(i.name)}</b> <span class="mono muted" dir="ltr">${esc(i.agent)}</span>${i.board ? ' · לוח' : ''}</span>
      <span class="muted">עד ${when(i.expires)}</span>
      ${i.state === 'pending' ? `<button class="btn btn-ghost iv-revoke" data-id="${esc(i.id)}" type="button">ביטול</button>` : ''}
    </div>`;
  }

  function agentRow(a) {
    return `<div class="iv-item">
      <span class="iv-state ${a.disabled ? 'st-dead' : 'st-ok'}">${a.disabled ? 'מושבת' : 'פעיל'}</span>
      <span class="grow"><b>${esc(a.name)}</b> <span class="mono muted" dir="ltr">${esc(a.id)}</span>${a.board ? ' · לוח' : ''}</span>
      <span class="muted">נרשם ${when(a.created)}</span>
      ${a.disabled ? '' : `<button class="btn btn-ghost iv-disable" data-id="${esc(a.id)}" data-name="${esc(a.name)}" type="button">השבתה</button>`}
    </div>`;
  }

  function showCreated(url, name) {
    const box = body.querySelector('#iv-created');
    box.classList.remove('hidden');
    body.querySelector('#iv-link').textContent = url;
    body.querySelector('#iv-open').href = url;
    body.querySelector('#iv-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(url); toast('הקישור הועתק - שלח אותו לסוכן ' + name); }
      catch { toast('לא הצלחתי להעתיק - סמן והעתק ידנית', { err: true }); }
    };
  }

  async function refresh() {
    data = await api('./api/invites');
    render();
  }

  function wire() {
    const nameInput = body.querySelector('#iv-name'), idInput = body.querySelector('#iv-id');
    let idTouched = false;
    idInput.addEventListener('input', () => { idTouched = true; });
    nameInput.addEventListener('input', () => { if (!idTouched) idInput.value = normalizeId(nameInput.value); });
    body.querySelector('#iv-form').addEventListener('submit', async e => {
      e.preventDefault();
      if (busy) return;
      const name = nameInput.value.trim();
      const id = normalizeId(idInput.value || name);
      const err = body.querySelector('#iv-err');
      err.textContent = '';
      if (!name) { err.textContent = 'צריך שם לסוכן'; nameInput.focus(); return; }
      if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(id)) { err.textContent = 'המזהה צריך להיות 2-31 תווים באנגלית קטנה, ספרות או מקף'; idInput.focus(); return; }
      busy = true;
      const btn = body.querySelector('#iv-submit');
      btn.disabled = true; btn.textContent = 'יוצר…';
      try {
        const d = await api('./api/invites', { name, agent: id, board: body.querySelector('#iv-board').checked, ttlHours: Number(body.querySelector('#iv-ttl').value) });
        createdUrl = d.url; createdName = name;
        toast('נוצרה הזמנה עבור ' + name);
        await refresh();
      } catch (e2) {
        if (e2.message !== 'unauthorized') err.textContent = 'לא נוצר: ' + e2.message;
        btn.disabled = false; btn.textContent = 'יצירת קישור הזמנה';
      } finally { busy = false; }
    });
    body.querySelectorAll('.iv-revoke').forEach(b => b.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      try { await api('./api/invites/revoke', { id: b.dataset.id }); toast('ההזמנה בוטלה'); await refresh(); }
      catch (e2) { if (e2.message !== 'unauthorized') toast('לא בוטל: ' + e2.message, { err: true }); }
      finally { busy = false; }
    }));
    body.querySelectorAll('.iv-disable').forEach(b => b.addEventListener('click', async () => {
      if (busy) return;
      if (!b.dataset.armed) { // two-tap confirm: reliable for people and automation alike
        b.dataset.armed = '1';
        const orig = b.textContent;
        b.textContent = 'אישור השבתה?';
        b.classList.add('iv-danger');
        setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = orig; b.classList.remove('iv-danger'); } }, 4000);
        return;
      }
      busy = true;
      try { await api('./api/agents/revoke', { id: b.dataset.id }); toast(b.dataset.name + ' הושבת'); onChanged?.(); await refresh(); }
      catch (e2) { if (e2.message !== 'unauthorized') toast('לא הושבת: ' + e2.message, { err: true }); }
      finally { busy = false; }
    }));
  }

  return {
    async start() {
      body.innerHTML = '<div class="iv-empty">טוען…</div>';
      createdUrl = '';
      try { await refresh(); }
      catch (e) {
        if (e.message === 'unauthorized') return;
        body.innerHTML = '<div class="iv-empty">לא הצלחתי לטעון את ההזמנות. <button class="btn btn-ghost" id="iv-retry" type="button">נסה שוב</button></div>';
        body.querySelector('#iv-retry')?.addEventListener('click', () => this.start());
      }
    },
  };
}
