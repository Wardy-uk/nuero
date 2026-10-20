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

test('before any allowance: both gates shut, zero left, no receipts, and the stop is there', () => {
  budget._test.reset();
  const t = text(render(budget.status()));
  assert.match(t, /SAiM is technically locked on this device\./);
  assert.match(t, /SAiM has no allowance to act today\./);
  assert.match(t, /Nothing on this screen opens it\./);
  assert.match(t, /Calendar blocks 0 of 0/); assert.match(t, /New notes 0 of 0/); assert.match(t, /Money £0/); assert.match(t, /People contacted 0/);
  assert.match(t, /None yet\. A receipt appears here only after SAiM has carried something out and read it back\./);
  assert.match(t, /Allow one block and one note today…/);
  assert.match(render(budget.status()), /class="auth__stop"[^>]*>Stop all SAiM actions</);
});

test('the grant step shows exactly the server’s terms before anything is given', () => {
  budget._test.reset();
  const p = budget.previewGrant({ blockMinutes: 30 });
  const t = text(render(budget.status(), { kind: 'granting', preview: p }));
  assert.match(t, /You would allow exactly this:/);
  for (const line of p.statement) assert.ok(t.includes(line.replace(/\s+/g, ' ')), line);
  assert.match(t, /Give this allowance/);
  assert.equal(budget.status().grant, null, 'rendering the preview granted nothing');
});

test('after granting: the allowance gate opens, the device gate does NOT; still nothing claimed done', () => {
  budget._test.reset(); budget._test.grantToday();
  const t = text(render(budget.status()));
  assert.match(t, /SAiM is allowed to make one calendar block \(up to 30 minutes\) and one note today\./);
  assert.match(t, /SAiM is technically locked on this device\./);
  assert.match(t, /SAiM can’t act yet: the device is still locked\./);
  assert.match(t, /Calendar blocks 1 of 1/); assert.match(t, /Minutes 30 of 30/);
  assert.match(t, /Nothing has been carried out today\./);
  assert.doesNotMatch(t, /Both are in place|read back ·|done and read back/);
  assert.match(t, /Take today’s allowance away/);
});

test('stopped: the stop banner, a two-step resume, and no stop button repeated', () => {
  budget._test.reset(); budget._test.grantToday(); budget.stop();
  const h = render(budget.status());
  assert.match(text(h), /All SAiM actions are stopped\./);
  assert.match(text(h), /Resume…/);
  assert.doesNotMatch(h, /auth__stop"/);
  assert.doesNotMatch(text(h), /Allow one block/, 'no granting while stopped');
});

test('a receipt is rendered only from a receipt — and a practice run says so', () => {
  budget._test.reset();
  budget.recordReceipt({ target: 'sandbox', complete: true, plain: 'Both are in place and checked.', at: new Date().toISOString(), steps: [{ step: 'calendar', status: 'done' }, { step: 'note', status: 'done' }] }, { title: 'x' });
  const t = text(render(budget.status()));
  assert.match(t, /practice run/); assert.match(t, /Both are in place and checked\./);
  assert.match(t, /Calendar block: done and read back/); assert.match(t, /Note: done and read back/);
});

test('it is its own screen in the shared tab list, and the flow speaks only to /api/saim-authority', () => {
  const tabs = fs.readFileSync(path.join(APP, '..', '..', 'shared-ui', 'tabs.jsx'), 'utf8');
  assert.match(tabs, /\{ id: 'authority', label: 'May do'.*Component: Authority \}/);
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
