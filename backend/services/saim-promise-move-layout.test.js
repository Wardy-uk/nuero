'use strict';

/**
 * Layout of the held promise's answer interaction and the "Also open" status
 * list (24 Oct 2026), measured in Chromium (Electron, offscreen) at phone
 * 390×844, Fire 7 landscape 1024×552, 1440×900 and 1920×1080 with the REAL
 * stylesheets (KeepMyWord.css, PreparedMove.css):
 *   - the question, the text box and "Tell SAiM" sit inside the width;
 *   - long candidate names wrap as buttons, never off the side;
 *   - "Needs your decision…" and "Scheduled for…" rows stay inside the width,
 *     and the Show button never leaves the row.
 * Skips — and says so — where no Electron binary exists.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saim-promise-layout-'));
const ROOT = path.resolve(__dirname, '..', '..');

function electronBinary() {
  if (process.env.ELECTRON_PATH && fs.existsSync(process.env.ELECTRON_PATH)) return process.env.ELECTRON_PATH;
  for (const base of [path.join(ROOT, 'saim', 'desktop-electron'), ROOT]) {
    try { const p = require(require.resolve('electron', { paths: [base] })); if (typeof p === 'string' && fs.existsSync(p)) return p; } catch { /* not here */ }
  }
  return null;
}
const plugins = [{ name: 'stub', setup(b) {
  b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
  b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
  b.onResolve({ filter: /^\.\.?\/api(\.js)?$/ }, () => ({ path: 'api', namespace: 'stub' }));
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl = (p) => p; export const authHeaders = () => ({}); export const apiFetch = async () => ({});', loader: 'js' }));
} }];
async function bundle(entry) {
  const out = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], plugins, logLevel: 'silent' });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}
const CSS = [
  path.join(ROOT, 'saim', 'app', 'src', 'App.css'),
  path.join(ROOT, 'saim', 'shared-ui', 'presentation', 'KeepMyWord.css'),
  path.join(ROOT, 'saim', 'app', 'src', 'components', 'PreparedMove.css'),
].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const SIZES = [[390, 844], [1024, 552], [1440, 900], [1920, 1080]];
const page = (el) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>html,body{margin:0;background:#06080c;color:#e6edf3;font-family:system-ui}main{padding:16px;box-sizing:border-box;max-width:100%}*{animation:none!important;transition:none!important}${CSS}</style></head><body><main>${renderToString(el)}</main></body></html>`;

const MEASURE = `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const jobs = JSON.parse(fs.readFileSync(process.env.J, 'utf8'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
process.on('unhandledRejection', (e) => { console.error(String(e && e.stack || e)); app.exit(2); });
app.whenReady().then(async () => {
  const out = [];
  for (const j of jobs) {
    const win = new BrowserWindow({ width: j.w, height: j.h, useContentSize: true, show: false, paintWhenInitiallyHidden: true, webPreferences: { offscreen: true } });
    win.setContentSize(j.w, j.h);
    const url = 'data:text/html;charset=utf-8;base64,' + fs.readFileSync(j.file).toString('base64');
    try { await win.loadURL(url); } catch { await new Promise((r) => setTimeout(r, 300)); await win.loadURL(url); }
    const m = await win.webContents.executeJavaScript(\`(() => {
      const vw = document.documentElement.clientWidth;
      const box = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
      const all = (s) => [...document.querySelectorAll(s)].map(box);
      const over = [...document.querySelectorAll('main *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.right > vw + 1; }).slice(0, 5).map((e) => e.className || e.tagName);
      return { vw, sw: document.documentElement.scrollWidth, over,
        input: box(document.querySelector('.kmw__ask-input')), submit: box(document.querySelector('.kmw__ask button[type=submit]')),
        choices: all('.kmw__choice'), rows: all('.pmo2__alsoitem'), shows: all('.pmo2__alsoshow'),
        ivField: box(document.querySelector('.pmo2__iv textarea')), ivSubmit: box(document.querySelector('.pmo2__iv button[type=submit]')),
        ivPark: box([...document.querySelectorAll('.pmo2__iv button')].find((b) => b.textContent === 'Park this for now')),
        ivQuestion: box(document.querySelector('.pmo2__iv label')), ivProg: box(document.querySelector('.pmo2__ivprog')) };
    })()\`);
    out.push({ name: j.name, w: j.w, h: j.h, ...m });
    win.destroy();
  }
  fs.writeFileSync(process.env.O, JSON.stringify(out));
  app.quit();
});
`;

let results = null; let skipWhy = null;
test.before(async () => {
  const bin = electronBinary();
  if (!bin) { skipWhy = 'no Electron binary here (set ELECTRON_PATH) — layout NOT verified'; return; }
  const K = await bundle(path.join(ROOT, 'saim', 'shared-ui', 'presentation', 'KeepMyWord.jsx'));
  const PM = await bundle(path.join(ROOT, 'saim', 'app', 'src', 'components', 'PreparedMove.jsx'));
  const q = { id: 'owed', question: 'Which Christopher do you mean?', why: '“Christopher” could be 3 people in your People notes, so SAiM won’t pick. Choose the full name, or type a group.', choices: ['Christopher Middleton-Featherstonehaugh', 'Christopher Smith', 'Christopher Bartholomew-Jones'] };
  const ask = React.createElement('div', { className: 'kmw' }, React.createElement('div', { className: 'kmw__rows' },
    React.createElement(K.KmwMove, { move: { state: 'ask', ref: 'promise:promise:322', recordId: 'pm_x', version: 2, question: q }, onPromiseMove: async () => ({}) })));
  const also = React.createElement(PM.Outstanding, { view: { outstanding: [
    { recordId: 'pm_1', title: 'Define achievable targets for hybrid/WFH incentive; agree plan on 2026-09-02', state: 'needs-decision', say: 'Needs your decision before I can schedule it.' },
    { recordId: 'pm_2', title: 'Write the Support Hub rota notes', state: 'scheduled', say: 'Scheduled for Thursday 22 Oct 09:00–09:30; I can now make the next item ready.' },
    { recordId: 'pm_3', title: 'Renewal question', state: 'ready', say: 'Ready for you to confirm — nothing needs booking.' },
  ] }, onShow: () => {} });
  // The private-draft interview as Home shows it after "Prepare a private working draft".
  const brief = require('./private-brief');
  const T = 'Define achievable targets for hybrid/WFH incentive; agree plan on 2026-09-02';
  const out = brief.compose({ title: T, promiseText: T, source: { path: 'Meetings/2026/09/2026-09-01 – Weekly Meeting Ticket Health, AI Integration, and Team Performance.md', title: '2026-09-01 – Weekly Meeting Ticket Health, AI Integration, and Team Performance' },
    lines: [{ text: 'Consider hybrid model (e.g., two days WFH) as incentive tied to achievable targets, leveraging AI efficiency gains; stagger WFH to maintain coverage.', line: 98 }, { text: T + '.', line: 123 }], leftOut: 2, answers: [], todayYmd: '2026-10-26' });
  const PRIV = { label: brief.LABEL, cannot: brief.CANNOT, can: brief.CAN };
  const view = { move: { version: 2, recordId: 'pm_9', recordVersion: 1, kind: 'project-note', plan: 'draft', title: T,
    prepared: { headline: 'I prepared a private draft for you — no decision made, nothing sent.' }, privateDraft: PRIV, interview: out.interview,
    outcome: { goal: `Think “${T}” through yourself, with what your notes say in one place.` }, why: { because: [], willNot: [] }, evidence: [], freshness: [],
    deliverable: { title: 'x — private draft', sourceFacts: [], suggested: { label: brief.LABEL, text: out.text }, gaps: out.gaps },
    options: [{ id: 'unfinished', writes: ['Save your unfinished private draft'] }], notOffered: [],
    respond: { defer: { days: [{ days: 1, label: 'Until tomorrow' }], reasons: [{ id: 'not-now', label: 'Not now' }] }, decline: { reasons: [], say: 'x' } }, moment: { headline: 'x' } } };
  const interview = React.createElement('div', { className: 'app' }, React.createElement('main', { className: 'app__view' },
    React.createElement(PM.PreparedMoveView, { state: { kind: 'ready', view }, onChoose() {}, onAsk() {}, onConfirm() {}, onCancel() {}, onAgain() {}, onAnswer() {}, onPark() {}, onAskOption() {} })));
  const jobs = [];
  for (const [name, el] of Object.entries({ ask, also, interview })) {
    const file = path.join(tmp, `${name}.html`); fs.writeFileSync(file, page(el));
    for (const [w, h] of SIZES) jobs.push({ name, file, w, h });
  }
  const appDir = path.join(tmp, 'app'); fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'promise-measure', main: 'main.js', private: true }));
  fs.writeFileSync(path.join(appDir, 'main.js'), MEASURE);
  fs.writeFileSync(path.join(tmp, 'jobs.json'), JSON.stringify(jobs));
  const env = { ...process.env, J: path.join(tmp, 'jobs.json'), O: path.join(tmp, 'out.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(bin, [appDir], { env, timeout: 120000, encoding: 'utf8' });
  if (!fs.existsSync(env.O)) throw new Error(`Electron produced no measurements (status ${r.status}): ${(r.stderr || '').slice(0, 800)}`);
  results = JSON.parse(fs.readFileSync(env.O, 'utf8'));
});
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

test('the answer form: question, text box, "Tell SAiM" and long-name choices all inside the width at every size', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const m of results.filter((x) => x.name === 'ask')) {
    assert.equal(m.sw, m.vw, `no sideways scroll @${m.w}: ${m.over.join(', ')}`);
    assert.ok(m.input && m.input.w >= 160, `the box is usable @${m.w} (${m.input && m.input.w}px)`);
    assert.ok(m.input.r <= m.vw && m.submit && m.submit.r <= m.vw, `box and button inside @${m.w}`);
    assert.equal(m.choices.length, 3);
    for (const c of m.choices) assert.ok(c.r <= m.vw + 0.5, `a choice runs off @${m.w}`);
  }
});

test('"Also open": every row and every Show button inside the width; Show only on the rows that need Nick', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const m of results.filter((x) => x.name === 'also')) {
    assert.equal(m.sw, m.vw, `no sideways scroll @${m.w}: ${m.over.join(', ')}`);
    assert.equal(m.rows.length, 3);
    assert.equal(m.shows.length, 2);
    for (const r of [...m.rows, ...m.shows]) assert.ok(r.r <= m.vw + 0.5, `off the side @${m.w}`);
  }
});

test('phone: the private-draft question, its field, "Tell SAiM" and "Park this for now" are ABOVE THE FOLD and inside the width', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const m of results.filter((x) => x.name === 'interview')) {
    assert.equal(m.sw, m.vw, `no sideways scroll @${m.w}: ${m.over.join(', ')}`);
    assert.ok(m.ivProg && m.ivQuestion && m.ivField && m.ivSubmit && m.ivPark, `the interview renders @${m.w}`);
    for (const [k, b] of [['field', m.ivField], ['Tell SAiM', m.ivSubmit], ['Park', m.ivPark]]) {
      assert.ok(b.r <= m.vw + 0.5, `${k} inside the width @${m.w}`);
      if (m.w === 390 || m.w >= 1440) assert.ok(b.b <= m.h, `${k} above the fold @${m.w}×${m.h} (bottom ${Math.round(b.b)})`);
    }
    assert.ok(m.ivField.w >= 200, `the field is usable @${m.w} (${Math.round(m.ivField.w)}px)`);
  }
});
