import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { joinText, checkFile, humanSize, extOf, mount, MAX_FILES, MAX_FILE_BYTES } from '../assign-media.js';

const read = p => readFile(new URL('../' + p, import.meta.url), 'utf8');

test('helpers: dictation joins into what was typed, limits and sizes are Ori-readable', () => {
  assert.equal(joinText('כתבתי', '  עוד   דברים ', 50), 'כתבתי עוד דברים');
  assert.equal(joinText('', 'שלום', 3), 'שלו'); assert.equal(joinText('abc  ', ''), 'abc');
  assert.equal(humanSize(900), '900 B'); assert.equal(humanSize(2048), '2 KB'); assert.equal(humanSize(5.5 * 1048576), '5.5 MB');
  assert.equal(extOf('report.final.pdf', ''), 'PDF'); assert.equal(extOf('noext', 'image/png'), 'PNG');
  assert.equal(checkFile({ name: 'a', size: 10 }, 0), ''); assert.match(checkFile({ name: 'a', size: 10 }, MAX_FILES), /5/);
  assert.match(checkFile({ name: 'big.mov', size: MAX_FILE_BYTES + 1 }, 0), /20MB/); assert.match(checkFile({ name: 'e', size: 0 }, 0), /ריק/);
});

// A tiny DOM stub: enough for mount() to run for real.
function stubDom() {
  const mk = (extra = {}) => { const handlers = {};
    return { hidden: false, disabled: false, value: '', dataset: {}, textContent: '', innerHTML: '', handlers, classList: { s: new Set(), toggle(c, on) { on ? this.s.add(c) : this.s.delete(c); }, add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, contains(c) { return this.s.has(c); } },
      addEventListener(t, fn) { (handlers[t] ||= []).push(fn); }, setAttribute() {}, dispatchEvent() {}, click() { this.clicked = true; }, closest() { return null; },
      querySelector() { return { textContent: '' }; }, ...extra }; };
  const els = { '#as-mic': mk(), '#as-attach': mk(), '#as-file': mk(), '#as-files': mk(), '#as-status': mk(), '#as-tools': mk(), '#as-drop-hint': mk() };
  const card = mk(); const form = mk({ querySelector: s => els[s], closest: () => card });
  return { els, form, card, title: mk(), note: mk() };
}
const caps = c => () => c;
const setEnv = (o) => { for (const [k, v] of Object.entries(o)) { if (v === undefined) delete globalThis[k]; else Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); } };

test('mount: without R2 the attach button is hidden; without speech, recorder or AI the mic is hidden too', () => {
  setEnv({ window: {}, navigator: {} });
  const d = stubDom();
  mount({ form: d.form, title: d.title, note: d.note, caps: caps({ uploads: false, transcribe: false }), toast() {} });
  assert.equal(d.els['#as-attach'].hidden, true); assert.equal(d.els['#as-mic'].hidden, true); assert.equal(d.els['#as-tools'].hidden, true);
  setEnv({ window: { webkitSpeechRecognition: function () {} }, navigator: {} });
  const d2 = stubDom();
  mount({ form: d2.form, title: d2.title, note: d2.note, caps: caps({ uploads: false, transcribe: false }), toast() {} });
  assert.equal(d2.els['#as-mic'].hidden, false, 'live dictation works with no server support at all'); assert.equal(d2.els['#as-attach'].hidden, true);
  setEnv({ window: {}, navigator: {} });
});

test('mount: attaching uploads each file to /api/uploads, shows a thumbnail for images and ids go to the task', async () => {
  const calls = [];
  setEnv({ window: {}, navigator: {}, URL: Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL() {} }),
    fetch: async (url, init) => { calls.push({ url, init }); return { status: 200, ok: true, json: async () => ({ ok: true, file: { id: 'f-' + String(calls.length).repeat(32), type: 'image/png', size: 5 } }) }; } });
  const d = stubDom();
  const ctl = mount({ form: d.form, title: d.title, note: d.note, caps: caps({ uploads: true, transcribe: false }), toast() {} });
  assert.equal(d.els['#as-attach'].hidden, false); assert.equal(d.els['#as-tools'].hidden, true === false);
  // the paste handler adds a screenshot straight from the clipboard
  const img = { name: 'image.png', type: 'image/png', size: 5 };
  d.form.handlers.paste[0]({ clipboardData: { files: [img] }, preventDefault() { this.stopped = true; } });
  assert.equal(ctl.busy(), true);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(calls.length, 1); assert.equal(calls[0].url, './api/uploads'); assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.credentials, 'same-origin');
  assert.match(decodeURIComponent(calls[0].init.headers['X-File-Name']), /^הדבקה-.*\.png$/); assert.equal(calls[0].init.body, img);
  assert.equal(ctl.busy(), false); assert.deepEqual(ctl.ids(), ['f-' + '1'.repeat(32)]);
  assert.match(d.els['#as-files'].innerHTML, /class="as-thumb" src="blob:x"/); assert.match(d.els['#as-files'].innerHTML, /as-rm/);
  // too many / too large files are refused with a message, nothing is uploaded
  for (let i = 0; i < 6; i++) d.form.handlers.paste[0]({ clipboardData: { files: [{ name: 'n' + i + '.pdf', type: 'application/pdf', size: 9 }] }, preventDefault() {} });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(calls.length, MAX_FILES); assert.match(d.els['#as-status'].textContent, /5/);
  d.form.handlers.paste[0]({ clipboardData: { files: [] }, preventDefault() { assert.fail('text paste must stay native'); } });
  // remove button drops the file and best-effort deletes the upload
  d.els['#as-files'].handlers.click[0]({ target: { closest: () => ({ dataset: { k: 'k1' } }) } });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(calls.at(-1).init.method, 'DELETE'); assert.equal(ctl.ids().length, MAX_FILES - 1);
  ctl.reset(); assert.deepEqual(ctl.ids(), []);
});

test('page wiring: lazy module, mic + attach in the modal, attachments sent with the task, no R2 -> nothing shown', async () => {
  const [main, html, css, am] = await Promise.all(['main.js', 'index.html', 'styles.css', 'assign-media.js'].map(read));
  assert.match(main, /import\('\.\/assign-media\.js\?v=1'\)/, 'loaded on demand, not statically');
  assert.ok(!/^import .*assign-media/m.test(main));
  for (const id of ['as-mic', 'as-attach', 'as-file', 'as-files', 'as-status']) assert.ok(html.includes('id="' + id + '"'), id);
  assert.match(html, /id="as-mic"[^>]*hidden/); assert.match(html, /id="as-attach"[^>]*hidden/, 'hidden until the server says R2 exists');
  assert.match(html, /id="assign-note" maxlength="1500"/);
  assert.match(main, /attachments/); assert.match(main, /auth\.uploads/); assert.match(main, /media\?\.busy\(\)/);
  assert.match(am, /he-IL/); assert.match(am, /\/api\/transcribe/); assert.match(am, /תמלול לא זמין/);
  assert.match(css, /\.as-file\b/); assert.match(css, /\.as-tool\.rec/);
  assert.ok((await read('assign-media.js')).length < 14000, 'keep the lazy module small');
});
