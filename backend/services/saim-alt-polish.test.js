'use strict';

/**
 * SAiM Alt v3 — the operational chrome is out of normal view (20 Oct 2026).
 *
 * Nick: the desk-state line, "Control ↗", the refresh icon and the lock icon are
 * operational signals, not part of the prepared moment. They show only with
 * ?debug=1. Locking moved into Controls. A genuinely degraded read still says so,
 * in plain words — never a raw error or an internal label.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const APP = path.resolve(__dirname, '..', '..', 'saim', 'app');
const GOLDEN = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '__golden__', 'alt-manifest', `${n}.json`), 'utf8'));
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
  b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
} };
async function load(entry) {
  const out = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], plugins: [stub], logLevel: 'silent' });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let Shell; let View; let Live; let Controls; let M; let model;
test.before(async () => {
  Shell = (await load(path.join(APP, 'alt-v2', 'Shell.jsx'))).default;
  View = (await load(path.join(APP, 'alt-v2-manifest', 'ManifestView.jsx'))).default;
  Live = await load(path.join(APP, 'alt-v2-manifest', 'LiveSaim.jsx'));
  Controls = await load(path.join(APP, 'alt-v2', 'ControlsPage.jsx'));
  M = await import(pathToFileURL(path.join(APP, 'alt-v2-manifest', 'manifest.mjs')).href);
  model = await import(pathToFileURL(path.join(APP, 'alt-v2', 'model.mjs')).href);
});

const shell = (debug) => renderToString(React.createElement(Shell, {
  active: 'saim', drive: { degraded: true }, debug,
  marker: React.createElement('a', { className: 'v2__ctl', href: '#' }, 'Control ↗'),
  onLock() {}, onRefresh() {},
}, React.createElement('p', null, 'page')));

test('debug mode is ?debug=1 and nothing else', () => {
  assert.equal(model.debugFromSearch('?debug=1'), true);
  assert.equal(model.debugFromSearch('?tab=saim&debug=1'), true);
  for (const s of ['', '?debug=0', '?debug=true', '?debug', null]) assert.equal(model.debugFromSearch(s), false, String(s));
});

test('the shell shows no Control link, refresh or lock in normal view — and all three in debug', () => {
  const normal = shell(false);
  assert.doesNotMatch(normal, /Control ↗|v2__refresh|Lock \/ change PIN|🔒|↻/);
  assert.match(normal, /class="v2__nav"/, 'the six-tab bar stays');
  const dbg = shell(true);
  assert.match(dbg, /Control ↗/); assert.match(dbg, /v2__refresh/); assert.match(dbg, /Lock \/ change PIN/);
});

test('locking lives in Controls', () => {
  const html = renderToString(React.createElement(Controls.ControlsPageView, { resp: { settings: { enabled: true } }, onLock() {}, onOpenAuthority() {} }));
  assert.match(html, /aria-label="This device"/); assert.match(html, />Lock SAiM</);
  const unread = renderToString(React.createElement(Controls.ControlsPageView, { resp: null, error: 'x', onLock() {} }));
  assert.match(unread, />Lock SAiM</, 'still reachable when settings cannot be read');
});

test('the desk-state line is debug-only on the live page', () => {
  const vm = GOLDEN('s05-protected-block');
  const live = (debug) => ({ onAct() {}, onDeskOpen() {}, deskStates: {}, onChoose() {}, linkFor: () => null, busy: false, debug });
  const normal = renderToString(React.createElement(View, { v: vm, live: live(false) }));
  assert.doesNotMatch(normal, /wk__presence|desk state not current|desk active/);
  assert.match(renderToString(React.createElement(View, { v: vm, live: live(true) })), /class="wk__presence"/);
});

test('a degraded read stays honest, in plain words, with no internal label or raw error', () => {
  const r = M.manifest({ candidates: null });
  assert.equal(r.tone, 'blind');
  assert.match(r.title, /isn’t an all-clear/);
  assert.doesNotMatch(`${r.state} ${r.title}`, /SAiM’s decision/);
  const live = { onAct() {}, onDeskOpen() {}, deskStates: {}, onChoose() {}, linkFor: () => null, busy: false, debug: false };
  const html = renderToString(React.createElement(View, { v: r, live })).replace(/&#x27;/g, '\'');
  assert.match(html, /didn’t line up, so I’m not guessing/);
  assert.doesNotMatch(html, /neuro-candidates|version this screen reads/);
  // Live: the unreachable and stale lines never print the raw error outside debug.
  const down = renderToString(React.createElement(Live.default, { canonical: null, error: '404 Not Found <!DOCTYPE html>', debug: false }));
  assert.match(down, /can’t reach NEURO right now/); assert.match(down, /isn’t an all-clear/);
  assert.doesNotMatch(down, /404|DOCTYPE/);
  assert.match(renderToString(React.createElement(Live.default, { canonical: null, error: 'timeout', debug: true })), /timeout/);
  assert.match(Live.staleLine('2026-10-20T08:05:00'), /^I couldn’t refresh just now — this is what I saw at 08:05\.$/);
  assert.match(Live.staleLine(null), /last thing I saw/);
});
