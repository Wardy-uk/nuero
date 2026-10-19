'use strict';

/**
 * The Microsoft sign-in card keeps its code on screen until Nick closes it
 * (19 Oct 2026). It used to hide the code as soon as /status said
 * `authenticated` — which an EXPIRED sign-in in the token cache also says — so
 * the code vanished within 3 seconds. A REAL render via esbuild of the exported
 * pieces, plus the server's pure sign-in state.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const COMPONENTS = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components');

let mod = null;
async function load() {
  if (mod) return mod;
  const out = await esbuild.build({
    entryPoints: [path.join(COMPONENTS, 'MicrosoftSignIn.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'],
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)(api|useCachedFetch|cacheStore)(\.js)?$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const apiUrl = (p) => p; export const apiFetch = async () => ({ ok: true, json: async () => ({}) }); export default function useCachedFetch() { return { data: null, refresh() {} }; }; export function useCachedFetch2() {}',
          loader: 'js',
        }));
      },
    }],
    logLevel: 'silent',
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  mod = m.exports;
  return mod;
}

const NOW = Date.now();
const code = { userCode: 'ABCD-1234', issuedAt: new Date(NOW - 60000).toISOString(), expiresAt: new Date(NOW + 14 * 60000).toISOString() };

test('outcome: an account in the cache is NOT a finished sign-in; only an ending after this code was issued is', async () => {
  const { signInOutcome } = await load();
  // The bug: the server said authenticated (an expired sign-in) — nothing here reads that.
  assert.equal(signInOutcome(code, { pending: true, last: null }, NOW), 'waiting');
  // An ending from BEFORE this code (yesterday's sign-in) does not count.
  assert.equal(signInOutcome(code, { last: { at: new Date(NOW - 86400000).toISOString(), ok: true } }, NOW), 'waiting');
  assert.equal(signInOutcome(code, { last: { at: new Date(NOW).toISOString(), ok: true } }, NOW), 'signed-in');
  assert.equal(signInOutcome(code, { last: { at: new Date(NOW).toISOString(), ok: false, error: 'AADSTS50126' } }, NOW), 'failed');
  assert.equal(signInOutcome(code, null, NOW + 20 * 60000), 'expired');
  assert.equal(signInOutcome({ ...code, issuedAt: NOW - 60000 }, { last: { at: new Date(NOW).toISOString(), ok: true } }, NOW), 'signed-in', 'a numeric issuedAt from POST /auth works too');
});

test('the code stays on screen in every state, with Close always there', async () => {
  const { DeviceCodePanel } = await load();
  const render = (outcome, signIn = null) => renderToString(React.createElement(DeviceCodePanel, { deviceCode: code, signIn, outcome, onNewCode() {}, onClose() {}, connecting: false }));
  for (const outcome of ['waiting', 'signed-in', 'failed', 'expired']) {
    const html = render(outcome, outcome === 'failed' ? { last: { ok: false, error: 'AADSTS70043: expired' } } : null);
    assert.match(html, /ABCD-1234/, `${outcome}: the code is still shown`);
    assert.match(html, />Close</, `${outcome}: Close is offered`);
  }
  assert.match(render('waiting'), /Waiting for you to sign in…/);
  assert.match(render('signed-in'), /Signed in\. Calendar, tasks and email will catch up/);
  assert.match(render('failed', { last: { ok: false, error: 'AADSTS70043: expired' } }), /didn’t finish: AADSTS70043: expired/);
  assert.match(render('expired'), /This code has expired\./);
  assert.match(render('expired'), /Get a new code/);
  assert.doesNotMatch(render('waiting'), /Get a new code/);
});

test('source: nothing clears the code except Close or a new code', () => {
  const src = fs.readFileSync(path.join(COMPONENTS, 'AdminPanel.jsx'), 'utf8');
  const clears = src.match(/setDeviceCode\(null\)/g) || [];
  assert.equal(clears.length, 1, 'exactly one place clears the code');
  assert.match(src, /const closeSignIn = \(\) => \{ setDeviceCode\(null\);/, 'and it is Close');
  assert.doesNotMatch(src, /data\.authenticated\)\s*\{\s*setDeviceCode/, 'never cleared because an account is cached');
});

test('server: signInState reports the waiting code only while usable, and how the last attempt ended', () => {
  process.env.NEURO_DB_PATH = process.env.NEURO_DB_PATH || path.join(require('os').tmpdir(), 'ms-signin-card.db');
  const ms = require('./microsoft');
  const info = { userCode: 'ABCD-1234', verificationUri: 'https://microsoft.com/devicelogin', issuedAt: NOW - 60000, expiresInMs: 15 * 60000, expiresAt: new Date(NOW + 14 * 60000).toISOString() };
  const live = ms.signInState({ pending: true, info, last: null, now: NOW });
  assert.equal(live.pending, true); assert.equal(live.userCode, 'ABCD-1234'); assert.equal(live.last, null);
  const dead = ms.signInState({ pending: true, info, last: null, now: NOW + 20 * 60000 });
  assert.equal(dead.pending, false); assert.equal(dead.userCode, null, 'an expired code is never handed back');
  const failed = ms.signInState({ pending: false, info: null, last: { at: NOW, ok: false, error: 'AADSTS50126' }, now: NOW });
  assert.deepEqual(failed.last, { at: new Date(NOW).toISOString(), ok: false, error: 'AADSTS50126' });
  assert.equal(ms.signInState({ pending: false, info: null, last: { at: NOW, ok: true }, now: NOW }).last.error, null);
});
