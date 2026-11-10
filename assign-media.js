// assign-media.js — voice dictation + file attachments for the "משימה חדשה" modal.
// Lazy: main.js imports this only when the modal opens, so it costs nothing on the first paint of the room.
// Voice: Web Speech API (he-IL, live) where it exists; otherwise MediaRecorder -> /api/transcribe (Workers AI whisper);
//        if transcription is not available the recording is kept as an attachment ("תמלול לא זמין").
// Files: pick, paste or drag-drop; images get thumbnails, other files chips; uploaded to /api/uploads (R2), owner-only.
export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_REC_MS = 5 * 60_000;
const NOTE_MAX = 1500;

export function humanSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B'; }
export function extOf(name, type) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name || '');
  if (m) return m[1].toUpperCase();
  return (type || '').split('/')[1]?.slice(0, 4).toUpperCase() || 'FILE';
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Merge dictated text into a field: keep what was typed, add a space, respect maxlength.
export function joinText(base, spoken, max) {
  const b = base.replace(/\s+$/, ''), s = spoken.replace(/\s+/g, ' ').trim();
  const out = b && s ? b + ' ' + s : b || s;
  return max ? out.slice(0, max) : out;
}
export function checkFile(file, count) {
  if (count >= MAX_FILES) return 'אפשר לצרף עד ' + MAX_FILES + ' קבצים';
  if (file.size > MAX_FILE_BYTES) return file.name + ': גדול מ־20MB';
  if (!file.size) return file.name + ': קובץ ריק';
  return '';
}
// Mono 16 kHz WAV: every browser can make it and Whisper always reads it (Safari records AAC/mp4, Chrome webm/opus).
async function toWav(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return blob;
  const ctx = new AC();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const rate = 16000, len = Math.ceil(buf.duration * rate);
    const off = new OfflineAudioContext(1, len, rate), src = off.createBufferSource();
    src.buffer = buf; src.connect(off.destination); src.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVEfmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
    return new Blob([out], { type: 'audio/wav' });
  } catch { return blob; } finally { ctx.close?.(); }
}

export function mount({ form, title, note, caps, toast, onUnauthorized }) {
  const $ = s => form.querySelector(s);
  const mic = $('#as-mic'), attach = $('#as-attach'), input = $('#as-file'), list = $('#as-files'), status = $('#as-status'), tools = $('#as-tools'), card = form.closest('.ov-card') || form;
  let files = [], seq = 0, last = note, recog = null, recorder = null, stream = null, recTimer = 0, tick = 0, wantListening = false, processing = 0;
  const C = () => caps() || {};

  const say = (msg, kind = '') => { status.textContent = msg || ''; status.dataset.kind = kind; };
  function layout() {
    const c = C();
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const canRecord = !!(window.MediaRecorder && navigator.mediaDevices?.getUserMedia);
    mic.hidden = !(SR || (canRecord && (c.transcribe || c.uploads)));
    attach.hidden = !c.uploads;
    tools.hidden = mic.hidden && attach.hidden;
    $('#as-drop-hint').hidden = !c.uploads;
  }
  [title, note].forEach(el => el.addEventListener('focus', () => { last = el; }));

  /* ---------- files ---------- */
  function render() {
    list.innerHTML = files.map(f => `<div class="as-file ${f.status}${f.thumb ? ' has-thumb' : ''}" data-k="${f.key}">
      ${f.thumb ? `<img class="as-thumb" src="${f.thumb}" alt="" decoding="async">` : `<span class="as-ext">${esc(extOf(f.name, f.type))}</span>`}
      <span class="as-meta"><span class="as-fn" dir="auto">${esc(f.name)}</span><span class="as-fs">${f.status === 'error' ? esc(f.err || 'ההעלאה נכשלה') : f.status === 'uploading' ? 'מעלה…' : '<bdi>' + humanSize(f.size) + '</bdi>'}</span></span>
      <button class="as-rm" type="button" aria-label="הסרת ${esc(f.name)}" data-k="${f.key}">×</button></div>`).join('');
    list.hidden = !files.length;
    attach.disabled = files.length >= MAX_FILES;
  }
  async function upload(f) {
    try {
      const r = await fetch('./api/uploads', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': f.file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name) }, body: f.file });
      if (r.status === 401) { onUnauthorized?.(); throw new Error('החיבור פג'); }
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(r.status === 413 ? 'גדול מ־20MB' : r.status === 501 ? 'העלאת קבצים לא מוגדרת בשרת' : 'ההעלאה נכשלה');
      f.id = d.file.id; f.type = d.file.type; f.status = 'ready';
    } catch (e) { f.status = 'error'; f.err = e.message; }
    f.file = null; render(); changed();
  }
  function add(fileList, rename) {
    for (const file of [...fileList]) {
      const err = checkFile(file, files.length);
      if (err) { say(err, 'err'); continue; }
      say('');
      const f = { key: 'k' + (++seq), name: rename ? rename(file) : file.name || 'file', type: file.type, size: file.size, status: 'uploading', file, id: '', thumb: /^image\/(png|jpe?g|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : '' };
      files.push(f); render(); changed(); upload(f);
    }
  }
  function remove(key) {
    const i = files.findIndex(f => f.key === key); if (i < 0) return;
    const [f] = files.splice(i, 1);
    if (f.thumb) URL.revokeObjectURL(f.thumb);
    if (f.id) fetch('./api/uploads/' + encodeURIComponent(f.id), { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
    render(); changed();
  }
  const changed = () => form.dispatchEvent(new CustomEvent('assign-media', { detail: { busy: busy(), ids: ids() } }));
  const busy = () => files.some(f => f.status === 'uploading') || processing > 0 || !!recorder;
  const ids = () => files.filter(f => f.status === 'ready' && f.id).map(f => f.id);

  attach.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { add(input.files); input.value = ''; });
  list.addEventListener('click', e => { const b = e.target.closest('.as-rm'); if (b) remove(b.dataset.k); });
  form.addEventListener('paste', e => {
    if (!C().uploads) return;
    const fs = [...(e.clipboardData?.files || [])];
    if (!fs.length) return;
    e.preventDefault();
    add(fs, f => f.name && f.name !== 'image.png' ? f.name : 'הדבקה-' + new Date().toTimeString().slice(0, 5).replace(':', '') + '-' + (seq + 1) + '.' + ((f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')));
  });
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  let dragDepth = 0;
  card.addEventListener('dragenter', e => { if (C().uploads && hasFiles(e)) { e.preventDefault(); dragDepth++; card.classList.add('as-drop'); } });
  card.addEventListener('dragover', e => { if (C().uploads && hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  card.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; card.classList.remove('as-drop'); } });
  card.addEventListener('drop', e => { dragDepth = 0; card.classList.remove('as-drop'); if (C().uploads && hasFiles(e)) { e.preventDefault(); add(e.dataTransfer.files); } });

  /* ---------- voice ---------- */
  const setMic = on => { mic.classList.toggle('rec', on); mic.setAttribute('aria-pressed', on ? 'true' : 'false'); mic.querySelector('.lbl').textContent = on ? 'עצור' : 'הקלטה'; };
  function stopAll() {
    wantListening = false;
    try { recog?.stop(); } catch {}
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch {} }
    clearTimeout(recTimer); clearInterval(tick);
  }
  function startDictation() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const target = last === title || last === note ? last : note;
    const max = target === title ? 160 : NOTE_MAX;
    let base = target.value, finals = '';
    recog = new SR(); recog.lang = 'he-IL'; recog.interimResults = true; recog.continuous = true; recog.maxAlternatives = 1;
    recog.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) finals += ' ' + t; else interim += t; }
      target.value = joinText(base, finals + ' ' + interim, max);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    };
    recog.onerror = e => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      wantListening = false;
      if (['service-not-allowed', 'language-not-supported', 'network'].includes(e.error) && window.MediaRecorder && (C().transcribe || C().uploads)) { say(''); startRecording(); return; }
      say(e.error === 'not-allowed' ? 'אין הרשאה למיקרופון. אפשר לאשר אותה בהגדרות הדפדפן' : 'ההכתבה לא זמינה בדפדפן הזה', 'err');
      setMic(false);
    };
    recog.onend = () => { // Chrome ends a session after a pause; carry on until the user stops
      if (wantListening) { base = target.value; finals = ''; try { recog.start(); } catch { wantListening = false; setMic(false); } } else setMic(false);
    };
    wantListening = true; setMic(true); say('מקשיב… מדברים בעברית', 'rec');
    try { recog.start(); } catch { wantListening = false; setMic(false); }
  }
  async function startRecording() {
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { say('אין הרשאה למיקרופון. אפשר לאשר אותה בהגדרות הדפדפן', 'err'); setMic(false); return; }
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    const mime = types.find(t => MediaRecorder.isTypeSupported?.(t)) || '';
    const chunks = [];
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop()); clearTimeout(recTimer); clearInterval(tick);
      const type = recorder.mimeType || mime || 'audio/webm'; recorder = null; setMic(false);
      if (!chunks.length) { say('ההקלטה ריקה', 'err'); changed(); return; }
      await finishRecording(new Blob(chunks, { type }));
    };
    const t0 = Date.now(); setMic(true); say('מקליט… 0:00', 'rec');
    tick = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); say('מקליט… ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'), 'rec'); }, 500);
    recTimer = setTimeout(() => stopAll(), MAX_REC_MS);
    recorder.start(); changed();
  }
  async function finishRecording(blob) {
    const keep = (why) => {
      if (C().uploads && files.length < MAX_FILES) {
        const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
        add([new File([blob], 'הקלטה.' + ext, { type: blob.type })], f => 'הקלטה-' + new Date().toTimeString().slice(0, 5).replace(':', '') + '.' + ext);
        say(why + ' · ההקלטה צורפה כקובץ', 'warn');
      } else say(why, 'err');
    };
    if (!C().transcribe) { keep('תמלול לא זמין'); return; }
    processing++; say('מתמלל…', 'rec'); changed();
    try {
      const wav = await toWav(blob);
      const r = await fetch('./api/transcribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': wav.type || 'application/octet-stream' }, body: wav });
      if (r.status === 401) { onUnauthorized?.(); throw new Error('auth'); }
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error('fail');
      if (!d.text) { say('לא זוהה דיבור', 'warn'); }
      else { note.value = joinText(note.value, d.text, NOTE_MAX); note.dispatchEvent(new Event('input', { bubbles: true })); say('תומלל ✓', 'ok'); }
    } catch { keep('התמלול נכשל'); }
    finally { processing--; changed(); }
  }
  mic.addEventListener('click', () => {
    if (mic.classList.contains('rec')) { stopAll(); return; }
    if (processing) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) startDictation(); else startRecording();
  });

  layout();
  return {
    ids, busy, relayout: layout, stop: stopAll,
    reset() { stopAll(); files.forEach(f => f.thumb && URL.revokeObjectURL(f.thumb)); files = []; processing = 0; recorder = null; render(); say(''); setMic(false); layout(); last = note; },
  };
}
