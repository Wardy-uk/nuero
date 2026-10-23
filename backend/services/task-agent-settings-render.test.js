'use strict';

/**
 * Settings → AI & SAiM → Anthropic → "Do this", rendered for real (esbuild +
 * renderToString) from the component NEURO desktop mounts, plus the "off" hint on
 * the Do this button (phone and desktop share TaskAgent.jsx).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');

async function load(file) {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, file)], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    nodePaths: [path.join(ROOT, 'node_modules'), ...String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)],
    plugins: [
      { name: 'css', setup(b) { b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' })); b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' })); } },
      { name: 'api', setup(b) { b.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: 'api', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiFetch = async () => ({ status: 200, json: async () => ({}) }); export const apiUrl = (p) => p; export const authHeaders = () => ({});', loader: 'js' })); } },
    ],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let TS; let TA;
test.before(async () => { TS = await load('frontend/src/components/TaskAgentSettings.jsx'); TA = await load('saim/shared-ui/TaskAgent.jsx'); });
const noop = () => {};
const S = (over = {}) => ({
  enabled: false, configured: false, model: 'claude-sonnet-4-6',
  models: [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (recommended)' }, { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (cheaper, less capable)' }],
  dailyUsd: 1, dailyRuns: 10, today: { known: true, usd: 0.12, requests: 5, runs: 2, remainingUsd: 0.88, remainingRuns: 8 },
  resetsAt: '2026-10-23T23:00:00.000Z', gateMode: 'shadow',
  capSay: 'These limits are active: Do this is refused once either is reached. They apply only to Do this, and are independent of the wider AI gate, which is still in shadow mode and blocks nothing.',
  notice: 'This key is stored on this NEURO server. Encrypted secret storage is the next security upgrade.', ...over,
});
const view = (s, extra = {}) => strip(renderToString(React.createElement(TS.TaskAgentSettingsView, {
  s, draft: { enabled: s.enabled, model: s.model, dailyUsd: String(s.dailyUsd), dailyRuns: String(s.dailyRuns) }, setDraft: noop, keyText: '', setKeyText: noop, busy: false, result: null, errors: [],
  onSave: noop, onSaveKey: noop, onClearKey: noop, test: { stage: null, estimateUsd: null, result: null }, onTestAsk: noop, onTestConfirm: noop, onTestCancel: noop, ...extra,
})));
function strip(h) { return h.split('<!-- -->').join(''); }

test('every Stage 1 field is there: enabled, masked key, model, $ budget, run limit, today, the notice and the cap statement', () => {
  const h = view(S());
  assert.match(h, /type="password"/);
  assert.match(h, /autoComplete="new-password"|autocomplete="new-password"/);
  assert.match(h, /No key saved\./);
  assert.match(h, /id="tas-enabled"[^>]*disabled/, 'cannot be switched on without a key');
  assert.match(h, /Claude Sonnet 4\.6/); assert.match(h, /Claude Haiku 4\.5/);
  assert.match(h, /Do this daily budget/); assert.match(h, /value="1"/);
  assert.match(h, /Do this daily run limit/); assert.match(h, /value="10"/);
  assert.match(h, /\$0\.12<\/b> spent of \$1\.00/);
  assert.match(h, /2<\/b> of 10 runs/);
  assert.match(h, /This key is stored on this NEURO server\. Encrypted secret storage is the next security upgrade\./);
  assert.match(h, /independent of the wider AI gate, which is still in shadow mode/);
  assert.match(h, /Save a key to test it\./);
  assert.ok(!/encrypted (at rest|key)/i.test(h));
});

test('with a key: only "A key is saved" — the key input is empty and nothing of the key is shown; the test asks before sending', () => {
  const h = view(S({ configured: true }));
  assert.match(h, /A key is saved\./);
  assert.match(h, /id="tas-key"[^>]*value=""/);
  assert.match(h, /Replace key/); assert.match(h, /Clear key/);
  assert.match(h, /Test connection…/);
  const c = view(S({ configured: true }), { test: { stage: 'confirm', estimateUsd: 0.0008, result: null } });
  assert.match(c, /about \$0\.0008/);
  assert.match(c, /Send the test request/); assert.match(c, /Cancel/);
  const r = view(S({ configured: true }), { test: { stage: null, result: { ok: true, say: 'Connected: Anthropic answered with this key and model.', model: 'claude-sonnet-4-6', promptTokens: 31, completionTokens: 2, costUsd: 0.000123, ledger: { recorded: true, say: 'Recorded on the shared AI ledger (class task_agent_test).' } } } });
  assert.match(r, /Connected/); assert.match(r, /31 in \/ 2 out/); assert.match(r, /\$0\.00012/); assert.match(r, /Recorded on the shared AI ledger/);
});

test('field errors and an explicit save result are shown', () => {
  const h = view(S(), { errors: [{ field: 'dailyUsd', error: 'Enter an amount above $0 and up to $50.' }], result: { ok: false, say: 'Not saved — see the highlighted field.' } });
  assert.match(h, /Enter an amount above \$0 and up to \$50\./);
  assert.match(h, /Not saved — see the highlighted field\./);
  const ok = view(S(), { result: { ok: true, say: 'Saved.' } });
  assert.match(ok, /tas__result--ok[^>]*>Saved\./);
});

test('the component never writes the key to browser storage and clears the field before the request', () => {
  const src = fs.readFileSync(path.join(ROOT, 'frontend/src/components/TaskAgentSettings.jsx'), 'utf8');
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(src));
  assert.match(src, /setKeyText\(''\); \/\/ never keep it/);
});

test('the Do this button says when Do this is switched off', () => {
  const h = renderToString(React.createElement(TA.TaskAgentView, { run: null, budget: { enabled: false, configured: true, say: 'x' }, busy: false, error: null, onStart: noop, onAnswer: noop, onStop: noop, onOpenActions: noop, onOpenNote: noop }));
  assert.match(h, /Do this is switched off\. Nick turns it on in NEURO → Settings → AI &amp; SAiM → Anthropic\./);
  const on = renderToString(React.createElement(TA.TaskAgentView, { run: null, budget: { enabled: true, configured: true, say: 'x' }, busy: false, error: null, onStart: noop, onAnswer: noop, onStop: noop, onOpenActions: noop, onOpenNote: noop }));
  assert.ok(!/switched off/.test(on));
});

test('AdminPanel mounts it inside the Anthropic group', () => {
  const src = fs.readFileSync(path.join(ROOT, 'frontend/src/components/AdminPanel.jsx'), 'utf8');
  const i = src.indexOf('<div className="ai-setting-group-title">Anthropic</div>');
  const j = src.indexOf('<div className="ai-setting-group-title">OpenRouter</div>');
  const k = src.indexOf('<TaskAgentSettings />');
  assert.ok(i > 0 && k > i && k < j);
});
