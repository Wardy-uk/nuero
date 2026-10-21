'use strict';

/**
 * "What SAiM may do" (saim/app/src/views/Authority.jsx) — the real component,
 * bundled with esbuild and rendered against REAL server payloads: the status is
 * produced by authority-budget.status() on a scratch database, not a fixture.
 * Pins: the two gates read as two separate facts; the stop is always there and
 * never small; nothing claims a receipt that does not exist; it is its own
 * screen in the shared tab list.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saim-authority-view-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
delete process.env.SAIM_PREPARED_MOVE_EXECUTION;

const db = require('../db/database');
const budget = require('./authority-budget');
const APP = path.resolve(__dirname, '..', '..', 'saim', 'app', 'src');

let View; let flow;
test.before(async () => {
  await db.init();
  flow = await import(pathToFileURL(path.join(APP, 'authority.mjs')).href);
  const out = await esbuild.build({
    entryPoints: [path.join(APP, 'views', 'Authority.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    plugins: [{
      name: 'stub',
      setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        b.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl = (p) => p; export const authHeaders = () => ({});', loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  View = mod.exports.AuthorityView;
});
test.after(() => { delete process.env.SAIM_PREPARED_MOVE_EXECUTION; try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

const text = (h) => h.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const render = (status, ui) => renderToString(React.createElement(View, { state: { kind: 'ready', status }, ui, onAllow() {}, onGrant() {}, onRevoke() {}, onStop() {}, onAskResume() {}, onResume() {}, onCancel() {} }));

test('before any allowance: ONE plain control, nothing left today, no receipts, and the stop is there', () => {
  budget._test.reset();
  const h = render(budget.status());
  const t = text(h);
  assert.match(t, /Carrying out moves is switched off on NEURO’s server\./);
  assert.match(t, /SAiM can prepare moves, but carrying them out is switched off on NEURO’s server and you haven’t allowed any today\./);
  assert.equal((h.match(/<button/g) || []).length, 2, 'two controls only: allow, and stop');
  assert.match(t, /Allow SAiM to carry out up to three prepared moves today/);
  assert.match(t, /Nothing has been carried out today\./);
  assert.doesNotMatch(t, /Pi|device lock|SAIM_|env|Money|People contacted|Minutes \d/, 'no implementation words, no sprawling tiles');
  assert.match(h, /class="auth__stop"[^>]*>Stop all SAiM actions</);
});

test('the allow step shows exactly the server’s terms before anything is given', () => {
  budget._test.reset();
  const p = budget.previewGrant({});
  const t = text(render(budget.status(), { kind: 'granting', preview: p }));
  for (const line of p.statement) assert.ok(t.includes(line.replace(/\s+/g, ' ')), line);
  assert.match(t, /Allow this/);
  assert.equal(budget.status().grant, null, 'rendering the preview granted nothing');
});

test('after allowing: what is left today in one line; the server switch still reads as off; nothing claimed done', () => {
  budget._test.reset(); budget._test.grantToday();
  const t = text(render(budget.status()));
  assert.match(t, /three of three prepared moves left today · 3 calendar blocks · 3 notes or reply drafts/);
  assert.match(t, /Each move still waits for you to confirm it\./);
  assert.match(t, /SAiM can prepare moves, but carrying them out is switched off on NEURO’s server\./);
  assert.match(t, /Nothing has been carried out today\./);
  assert.doesNotMatch(t, /done and read back/);
  assert.match(t, /Take today’s allowance away/);
  process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
  try {
    const on = text(render(budget.status()));
    assert.match(on, /SAiM is ready\./);
    assert.match(on, /SAiM can carry out three more prepared moves today, each after you confirm it\./);
  } finally { delete process.env.SAIM_PREPARED_MOVE_EXECUTION; }
});

test('stopped: the stop banner, a two-step resume, and no stop button repeated', () => {
  budget._test.reset(); budget._test.grantToday(); budget.stop();
  const h = render(budget.status());
  assert.match(text(h), /All SAiM actions are stopped\./);
  assert.match(text(h), /Resume…/);
  assert.doesNotMatch(h, /auth__stop"/);
  assert.doesNotMatch(text(h), /Allow SAiM to carry out/, 'no granting while stopped');
});

test('a receipt is rendered only from a receipt — and a practice run says so', () => {
  budget._test.reset();
  budget.recordReceipt({ target: 'sandbox', complete: true, plain: 'Both are in place and checked.', at: new Date().toISOString(), steps: [{ step: 'calendar', status: 'done' }, { step: 'note', status: 'done' }] }, { title: 'x' });
  const t = text(render(budget.status()));
  assert.match(t, /practice run/); assert.match(t, /Both are in place and checked\./);
  assert.match(t, /Calendar block: done and read back/); assert.match(t, /Note: done and read back/);
});

test('it lives in More (the secondary list), and the flow speaks only to /api/saim-authority — and the flow speaks only to /api/saim-authority', () => {
  const tabs = fs.readFileSync(path.join(APP, '..', '..', 'shared-ui', 'tabs.jsx'), 'utf8');
  assert.match(tabs, /\{ id: 'authority', label: 'What SAiM may do'.*Component: Authority \}/);
  const src = fs.readFileSync(path.join(APP, 'authority.mjs'), 'utf8');
  const paths = [...src.matchAll(/`\$\{BASE\}\/([a-z/]+)`/g)].map((m) => m[1]);
  assert.deepEqual(paths.sort(), ['status']);
  assert.match(src, /const BASE = '\/api\/saim-authority';/);
  assert.doesNotMatch(src + fs.readFileSync(path.join(APP, 'views', 'Authority.jsx'), 'utf8'), /feature-flags|SAIM_PREPARED_MOVE_EXECUTION|localStorage/, 'nothing here can touch the device lock or keep authority on the device');
  assert.equal(typeof flow.stopAll, 'function');
  // The always-on kiosk never offers it (its proxy has no door for it).
  const kiosk = fs.readFileSync(path.join(APP, '..', '..', 'frontend', 'src', 'App.jsx'), 'utf8');
  assert.match(kiosk, /const canShowTab = \(t\) => t\.id !== 'authority' && /);
});
