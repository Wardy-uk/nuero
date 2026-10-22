'use strict';

/**
 * Layout of this slice's surfaces (22 Oct 2026), measured in Chromium
 * (Electron, offscreen) at phone 390×844, Fire 7 landscape 1024×552,
 * 1440×900 and 1920×1080, with the app's REAL stylesheets:
 *   - the PWA bar is exactly four items — Capture · Now · Review · More — all
 *     visible, on one row, inside the width (More is never hidden);
 *   - "What SAiM may do": one control, no sideways overflow, the allow button
 *     and the stop inside the width, and no tall empty page;
 *   - a Now row with "Make this ready" after its own action, inside the width.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saim-day-layout-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
delete process.env.SAIM_PREPARED_MOVE_EXECUTION;
const db = require('../db/database');
const budget = require('./authority-budget');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'saim', 'app', 'src');

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
  b.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: 'api', namespace: 'stub' }));
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl = (p) => p; export const authHeaders = () => ({});', loader: 'js' }));
} }];
async function bundle(entry) {
  const out = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], plugins, logLevel: 'silent' });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}
const CSS = ['App.css', 'views/Authority.css', 'views/Now.css', 'components/MakeReady.css'].map((f) => fs.readFileSync(path.join(APP, f), 'utf8')).join('\n');
const SIZES = [[390, 844], [1024, 552], [1440, 900], [1920, 1080]];

/** The PWA shell as App.jsx draws it: the More menu (closed) and the four-item bar. */
function shell(view) {
  const btn = (label, extra = {}) => React.createElement('button', { type: 'button', className: 'navbtn', ...extra }, React.createElement('span', { className: 'navbtn__icon' }, '·'), React.createElement('span', { className: 'navbtn__label' }, label));
  return React.createElement('div', { className: 'app' },
    React.createElement('main', { className: 'app__view' }, view),
    React.createElement('nav', { id: 'saim-more', className: 'app__nav app__nav--more app__nav--menu', hidden: true }, ['SAiM', 'Tasks', 'Chat', 'Prep', 'Ritual', "Who's in", 'Controls', 'What SAiM may do'].map((l) => React.cloneElement(btn(l), { key: l }))),
    React.createElement('nav', { className: 'app__nav', 'aria-label': 'Neuro Mobile' }, ['Capture', 'Now', 'Review'].map((l) => React.cloneElement(btn(l), { key: l })), React.cloneElement(btn('More', { 'aria-expanded': false }), { key: 'more' })));
}
const html = (el) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>:root{--panel:#111820;--panel-2:#0d1319;--line:#22303c;--muted:#8b98a8;--text:#e6edf3}html,body{margin:0;background:#06090d;color:#e6edf3;font-family:system-ui}*{animation:none!important;transition:none!important}${CSS}</style></head><body>${renderToString(el)}</body></html>`;

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
      const bar = [...document.querySelectorAll('nav.app__nav:not([hidden]) .navbtn')].filter((e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0);
      const over = [...document.querySelectorAll('main *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.right > vw + 1; }).slice(0, 5).map((e) => e.className || e.tagName);
      return { vw, vh: innerHeight, sw: document.documentElement.scrollWidth,
        bar: bar.map((e) => ({ label: e.textContent.replace('·', '').trim(), ...box(e) })),
        allow: box(document.querySelector('.auth__allow')), stop: box(document.querySelector('.auth__stop')), auth: box(document.querySelector('.auth')),
        make: box(document.querySelector('.mr__btn')), open: box(document.querySelector('.now__go')), over };
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
  await db.init();
  const bin = electronBinary();
  if (!bin) { skipWhy = 'no Electron binary here (set ELECTRON_PATH) — layout NOT verified'; return; }
  const A = await bundle(path.join(APP, 'views', 'Authority.jsx'));
  const M = await bundle(path.join(APP, 'components', 'MakeReady.jsx'));
  const noop = () => {};
  const auth = (status, ui) => React.createElement(A.AuthorityView, { state: { kind: 'ready', status }, ui, onAllow: noop, onGrant: noop, onRevoke: noop, onStop: noop, onAskResume: noop, onResume: noop, onCancel: noop });
  budget._test.reset();
  const none = budget.status();
  const preview = budget.previewGrant({});
  budget._test.reset(); budget._test.grantToday();
  const granted = budget.status();
  const nowRow = React.createElement('section', { className: 'now' }, React.createElement('div', { className: 'now__item lit' },
    React.createElement('div', { className: 'now__item-title' }, 'Renewal question for the Acme account and both of its sites — a long subject that must wrap'),
    React.createElement('button', { type: 'button', className: 'now__go' }, 'Open →'),
    React.createElement(M.MakeReadyView, { item: { ref: 'held:email-urgent', label: 'Draft the reply' }, onPress: noop, onOpen: noop })));
  const PAGES = { 'auth-none': auth(none), 'auth-granting': auth(none, { kind: 'granting', preview }), 'auth-granted': auth(granted), 'now-row': nowRow };
  const jobs = [];
  for (const [name, el] of Object.entries(PAGES)) {
    const file = path.join(tmp, `${name}.html`); fs.writeFileSync(file, html(shell(el)));
    for (const [w, h] of SIZES) jobs.push({ name, file, w, h });
  }
  const appDir = path.join(tmp, 'app'); fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'day-measure', main: 'main.js', private: true }));
  fs.writeFileSync(path.join(appDir, 'main.js'), MEASURE);
  fs.writeFileSync(path.join(tmp, 'jobs.json'), JSON.stringify(jobs));
  const env = { ...process.env, J: path.join(tmp, 'jobs.json'), O: path.join(tmp, 'out.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(bin, [appDir], { env, timeout: 120000, encoding: 'utf8' });
  if (!fs.existsSync(env.O)) throw new Error(`Electron produced no measurements (status ${r.status}): ${(r.stderr || '').slice(0, 800)}`);
  results = JSON.parse(fs.readFileSync(env.O, 'utf8'));
});
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });
const get = (name, w) => results.find((x) => x.name === name && x.w === w);

test('the bar is exactly Capture · Now · Review · More at every size — one row, all inside the width, More never hidden', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const m of results) {
    assert.deepEqual(m.bar.map((b) => b.label), ['Capture', 'Now', 'Review', 'More'], `${m.name} @${m.w}`);
    const tops = new Set(m.bar.map((b) => Math.round(b.t)));
    assert.equal(tops.size, 1, `${m.name} @${m.w}: one row`);
    for (const b of m.bar) assert.ok(b.l >= -1 && b.r <= m.vw + 1 && b.w >= 44 && b.h >= 32, `${m.name} @${m.w}: ${b.label} inside and tappable`);
  }
});

test('no sideways overflow anywhere, at 390, Fire 7 landscape, 1440 and 1920', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const m of results) {
    assert.ok(m.sw <= m.vw, `${m.name} @${m.w}: page ${m.sw}px wide in ${m.vw}px`);
    assert.deepEqual(m.over, [], `${m.name} @${m.w}: content past the right edge`);
  }
});

test('What SAiM may do: the one allow control and the stop are inside the width; the page is compact, not a sprawling empty layout', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const [w] of SIZES) {
    const m = get('auth-none', w);
    assert.ok(m.allow && m.allow.r <= m.vw + 1 && m.allow.h >= 36, `@${w}: allow button`);
    assert.ok(m.stop && m.stop.r <= m.vw + 1, `@${w}: stop`);
    assert.ok(m.auth.h < 520, `@${w}: compact — ${Math.round(m.auth.h)}px tall`);
    if (w >= 1440) assert.ok(m.stop.b <= m.vh, `@${w}: the stop is above the fold`);
    const g = get('auth-granted', w);
    assert.equal(g.allow, null, `@${w}: once allowed, no allow button`);
    assert.ok(g.stop && g.stop.r <= g.vw + 1);
  }
});

test('a Now row: Make this ready sits AFTER the row’s own action and inside the width', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const [w] of SIZES) {
    const m = get('now-row', w);
    assert.ok(m.open && m.make, `@${w}: both controls drawn`);
    assert.ok(m.make.t >= m.open.t - 1 && (m.make.t > m.open.b - 1 || m.make.l > m.open.r - 1), `@${w}: after the row’s own Open`);
    assert.ok(m.make.r <= m.vw + 1 && m.make.h >= 30, `@${w}: inside and tappable`);
  }
});
