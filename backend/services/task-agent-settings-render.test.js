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
  assert.match(h, /<option value="enabled" disabled="">Enabled<\/option>/, 'cannot be switched on without a key');
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

test('with a key: only the configuration line — the key input is empty and nothing of the key is shown; the test asks before sending', () => {
  const h = view(S({ configured: true }));
  assert.match(h, /Anthropic key saved\. This is configuration only: it does not turn Do this on\./);
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

// ── 24 Oct 2026 production fix ──
const CAP_OFF = 'These limits are configured. They are enforced for new Do this runs once Do this is enabled. No task attempts can start while Do this is disabled.';
const RULES = { dailyUsd: 'A dollar amount from $0.01 to $50, at most two decimal places (for example 1.5 or 1.50). Use a full stop for decimals.', dailyRuns: 'A whole number of runs from 1 to 200.' };

test('the status sits at the top and is the server\'s own words; Disabled / Enabled is a labelled select, not a bare checkbox', () => {
  const h = view(S({ configured: true, capSay: CAP_OFF, status: { state: 'disabled', label: 'Task Agent: Disabled', say: 'No task attempts can start while Do this is disabled.' } }));
  assert.ok(h.indexOf('data-tas-status="disabled"') < h.indexOf('Do this (task agent)'), 'status comes first');
  assert.match(h, /Task Agent: Disabled/);
  assert.match(h, /No task attempts can start while Do this is disabled\./);
  assert.match(h, /<label class="tas__label" for="tas-enabled">Do this<\/label>/);
  assert.match(h, /<select id="tas-enabled"[^>]*><option value="disabled" selected="">Disabled<\/option><option value="enabled">Enabled<\/option>/);
  assert.ok(!/type="checkbox"/.test(h), 'no unlabeled checkbox');
  assert.ok(!/>Off</.test(h));
  assert.match(h, /These limits are configured\./);
  for (const [state, label] of [['enabled', 'Task Agent: Enabled'], ['needs-key', 'Task Agent: Needs a key'], ['blocked', 'Task Agent: Blocked']]) {
    const x = view(S({ configured: true, enabled: state !== 'disabled', status: { state, label, say: 'why' } }));
    assert.match(x, new RegExp(`data-tas-status="${state}"`)); assert.match(x, new RegExp(label));
  }
});

test('budget and runs are text fields showing the saved value exactly, with the rule stated before save', () => {
  const h = view(S({ dailyUsd: 1.5, dailyRuns: 2, limitRules: RULES }), { draft: { enabled: false, model: 'claude-sonnet-4-6', dailyUsd: '1.50', dailyRuns: '2' } });
  assert.match(h, /id="tas-usd"[^>]*type="text"[^>]*inputMode="decimal"/);
  assert.match(h, /id="tas-usd"[^>]*value="1\.50"/);
  assert.match(h, /id="tas-runs"[^>]*type="text"[^>]*value="2"/);
  assert.match(h, /at most two decimal places/);
  assert.match(h, /A whole number of runs from 1 to 200\./);
  assert.ok(!/type="number"/.test(h), 'no number inputs (they dropped the decimal point on some keyboards)');
  assert.ok(!/data-tas-unsaved/.test(h), 'saved and shown agree: no unsaved line');
});

test('an unsaved edit says so, and names what is saved — stale screen state cannot pass for the saved value', () => {
  const h = view(S({ dailyUsd: 15, dailyRuns: 20 }), { draft: { enabled: false, model: 'claude-sonnet-4-6', dailyUsd: '1.5', dailyRuns: '2.0' } });
  assert.match(h, /data-tas-unsaved/);
  assert.match(h, /Not saved yet: daily budget, daily run limit\./);
  assert.match(h, /Saved values: Disabled, \$15\.00 a day, 20 runs a day\./);
  assert.deepEqual(TS.unsavedFields({ enabled: false, model: 'm', dailyUsd: 1.5, dailyRuns: 2 }, { enabled: false, model: 'm', dailyUsd: '1.50', dailyRuns: '2' }), []);
  assert.deepEqual(TS.unsavedFields({ enabled: false, model: 'm', dailyUsd: 1.5, dailyRuns: 2 }, { enabled: true, model: 'm', dailyUsd: '15', dailyRuns: '2' }), ['Do this on/off', 'daily budget']);
  assert.deepEqual(TS.unsavedFields({ enabled: false, model: 'm', dailyUsd: 1.5, dailyRuns: 2 }, { enabled: false, model: 'm', dailyUsd: '1,5', dailyRuns: '2' }), ['daily budget'], 'a comma is not 1.5');
});

test('the save sends the typed text, and the draft shows a saved 1.5 as "1.50", never "15"', () => {
  const src = fs.readFileSync(path.join(ROOT, 'frontend/src/components/TaskAgentSettings.jsx'), 'utf8');
  assert.match(src, /dailyUsd: String\(draft\.dailyUsd\)\.trim\(\)/);
  assert.match(src, /Number\(s\.dailyUsd\)\.toFixed\(2\)/);
  assert.ok(!/dailyUsd: Number\(draft\.dailyUsd\)/.test(src));
});

test('a failed connection test shows Anthropic\'s own reason', () => {
  const r = view(S({ configured: true }), { test: { stage: null, result: { ok: false, error: 'Anthropic refused the request (400).', anthropic: { type: 'invalid_request_error', message: 'something specific' }, model: 'claude-sonnet-4-6', ledger: null } } });
  assert.match(r, /Anthropic said: invalid_request_error — something specific/);
});

test('Do this attempt limits: a folded advanced disclosure, every limit with its rule and default, errors per field', () => {
  const attemptRules = {
    maxRounds: { label: 'Model rounds per attempt', say: 'From 2 to 20.' }, maxNotes: { label: 'Source notes per attempt', say: 'From 1 to 20.' },
    maxSearches: { label: 'Extra searches per attempt', say: 'From 0 to 10.' }, maxInputTokens: { label: 'Input tokens per attempt', say: 'From 10000 to 400000.' },
    maxAttemptUsd: { label: 'Cost per attempt ($)', say: 'From $0.10.' }, maxOutputTokens: { label: 'Output tokens per round', say: 'From 500 to 8000.' },
  };
  const attempt = { maxRounds: 8, maxNotes: 6, maxSearches: 3, maxInputTokens: 80000, maxAttemptUsd: 2, maxOutputTokens: 4000 };
  const s = S({ attempt, attemptDefaults: attempt, attemptRules, attemptSay: 'These bound ONE attempt, separately from the daily budget and run limit.' });
  const h = strip(renderToString(React.createElement(TS.TaskAgentSettingsView, {
    s, draft: { enabled: false, model: s.model, dailyUsd: '1.00', dailyRuns: '10', attempt: { maxRounds: '8', maxNotes: '6', maxSearches: '3', maxInputTokens: '80000', maxAttemptUsd: '2.00', maxOutputTokens: '4000' } },
    setDraft: noop, keyText: '', setKeyText: noop, busy: false, result: null, errors: [{ field: 'attempt.maxRounds', error: 'From 2 to 20.' }],
    onSave: noop, onSaveKey: noop, onClearKey: noop, test: { stage: null, estimateUsd: null, result: null }, onTestAsk: noop, onTestConfirm: noop, onTestCancel: noop,
  })));
  assert.match(h, /<details class="tas__fold" data-tas-attempt="true"><summary>Do this attempt limits \(advanced\)<\/summary>/, 'folded by default');
  for (const r of Object.values(attemptRules)) assert.ok(h.includes(r.label), r.label);
  assert.match(h, /Default 80000\./);
  assert.match(h, /value="2\.00"/);
  assert.match(h, /separately from the daily budget/);
  assert.match(h, /<p class="tas__err">From 2 to 20\.<\/p>/);
  assert.equal(TS.changedAttempt(s, { attempt: { maxRounds: '8', maxAttemptUsd: '2.00' } }).maxRounds, undefined, 'unchanged values are not sent');
  assert.deepEqual(TS.changedAttempt(s, { attempt: { maxRounds: '10' } }), { maxRounds: '10' });
});
