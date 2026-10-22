'use strict';
/** The Settings AI budget card (shadow), rendered for real via esbuild + renderToString. */


const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');

async function load(file) {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, file)],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    // The repo's node_modules, plus NODE_PATH (a worktree has none of its own).
    nodePaths: [path.join(ROOT, 'node_modules'), ...String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)],
    define: { 'import.meta.env': JSON.stringify({ VITE_API_URL: '', DEV: false, PROD: true, MODE: 'test' }) },
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const apiUrl = p => p;\nexport const authHeaders = () => ({});\nexport const apiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });\nexport default { apiUrl };',
          loader: 'js',
        }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const html = (el) => renderToString(el).replace(/<!-- -->/g, '');
let V;
test.before(async () => { V = await load('frontend/src/components/AiBudgetCard.jsx'); assert.ok(V.AiBudgetView, 'positive control'); });

const profile = (over = {}) => ({
  ok: true, known: true, mode: 'shadow', dailyCapUsd: null, capSay: 'No daily cap — Nick has not chosen one. Shadow mode records what the gate would refuse; nothing is blocked.',
  day: '2026-10-22', spendUsd: 0.4123, openReservedUsd: 0, calls: 37, unknownCostCalls: 2, pessimisticCalls: 1,
  share: { callClass: 'radar', usd: 0.3, fraction: 0.7276 },
  byClass: [{ app: 'vantage', callClass: 'radar', calls: 3, usd: 0.3, unknownCost: 0, wouldRefuse: 0 }, { app: 'neuro', callClass: 'tts_speak', calls: 2, usd: 0, unknownCost: 2, wouldRefuse: 2 }],
  wouldRefuse: 2, refusals: [{ reason: 'unknown-price', count: 2, classes: ['neuro:tts_speak'] }, { reason: 'unbounded-output', count: 2, classes: ['neuro:tts_speak'] }],
  unpricedModels: ['openai/gpt-audio-mini'], pricesCheckedOn: '2026-10-22', history: [{ day: '2026-10-21', usd: 0.5 }, { day: '2026-10-22', usd: 0.41 }], ...over,
});

test('Settings: the shadow profile says there is no cap, shows today, Radar’s share, and every refusal reason', () => {
  const out = html(React.createElement(V.AiBudgetView, { profile: profile() }));
  assert.match(out, /Shadow mode\./);
  assert.match(out, /Nick has not chosen one/);
  assert.match(out, /\$0\.41/);
  assert.match(out, /Radar — 73% of today/);
  assert.match(out, /radar<\/td><td>vantage/);
  assert.match(out, /the model has no known price/);
  assert.match(out, /the output had no bound \(no max tokens\)/);
  assert.match(out, /openai\/gpt-audio-mini/);
  assert.match(out, /could not be priced, so today’s total is a floor/);
  assert.doesNotMatch(out, /<button|<input/, 'read-only: nothing to set');
});

test('Settings: an unreadable ledger is never rendered as nothing spent', () => {
  const out = html(React.createElement(V.AiBudgetView, { profile: { ok: false, known: false, degraded: 'The shared AI ledger could not be opened (EACCES).' } }));
  assert.match(out, /couldn’t be read — this is not “nothing spent”/);
  assert.match(out, /EACCES/);
  const empty = html(React.createElement(V.AiBudgetView, { profile: profile({ calls: 0, spendUsd: 0, byClass: [], refusals: [], wouldRefuse: 0, unknownCostCalls: 0, pessimisticCalls: 0, unpricedModels: [] }) }));
  assert.match(empty, /No model, embedding or TTS calls have gone through the gate today/);
});
