'use strict';
/** The Settings AI budget card (shadow), rendered for real via esbuild + renderToString. */


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

test('Settings: where the shared ledger is, and whether VANTAGE writes the same one', () => {
  const ledger = { id: '0c9a3e1f-1111-4222-8333-444455556666', path: '/mnt/data/ai-gate/ledger.db', apps: [{ app: 'neuro' }, { app: 'vantage' }] };
  const ok = html(React.createElement(V.AiBudgetView, { profile: profile({ config: { ok: true, problems: [] }, ledger, peer: { state: 'match' } }) }));
  assert.match(ok, /Shared ledger: <code>\/mnt\/data\/ai-gate\/ledger\.db<\/code> · id 0c9a3e1f · registered: neuro, vantage/);
  assert.match(ok, /VANTAGE writes the same ledger ✓/);
  assert.doesNotMatch(ok, /role="alert">The shared ledger is misconfigured/);

  const mm = html(React.createElement(V.AiBudgetView, { profile: profile({ ledger, peer: { state: 'mismatch', say: 'The two apps write DIFFERENT ledgers (/mnt/data/ai-gate/ledger.db vs /home/x/ledger.db). Set the same absolute AI_GATE_DB_PATH in both.' } }) }));
  assert.match(mm, /role="alert">The two apps write DIFFERENT ledgers/);
  assert.doesNotMatch(mm, /writes the same ledger ✓/);

  const down = html(React.createElement(V.AiBudgetView, { profile: profile({ ledger, peer: { state: 'unreachable', say: 'x' } }) }));
  assert.match(down, /VANTAGE could not be asked which ledger it writes/);
  assert.doesNotMatch(down, /writes the same ledger ✓/, 'unreachable is never a match');

  // Misconfigured AND unreadable: the reason is shown, not just "couldn’t be read".
  const bad = html(React.createElement(V.AiBudgetView, { profile: { ok: true, known: false, degraded: 'AI_GATE_DB_PATH is not set, so there is no shared AI ledger.', config: { ok: false, problems: ['AI_GATE_DB_PATH is not set.'] }, ledger: null, peer: { state: 'unknown' } } }));
  assert.match(bad, /couldn’t be read — this is not “nothing spent”/);
  assert.match(bad, /role="alert">The shared ledger is misconfigured: AI_GATE_DB_PATH is not set\./);
  assert.match(bad, /Shared ledger: not open/);
});

test('VANTAGE Admin: the same ledger line, and a loud warning when NEURO is not on its ledger', async (t) => {
  const roots = [path.resolve(__dirname, '..', '..', '..'), path.resolve(__dirname, '..', '..', '..', '..', '..', '..')];
  const admin = roots.flatMap((r) => [
    path.join(r, 'Service Desk Continual Improvement', '.claude', 'worktrees', 'ai-gate', 'frontend', 'src', 'views', 'Admin.jsx'),
    path.join(r, 'Service Desk Continual Improvement', 'frontend', 'src', 'views', 'Admin.jsx'),
  ]).find((p) => fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('export function LedgerLine'));
  if (!admin) return t.skip('no VANTAGE checkout with the ledger line beside this one');
  const out = await esbuild.build({
    entryPoints: [admin], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      b.onResolve({ filter: /api\.js$/ }, () => ({ path: 'api', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const api = {}; export const setPin = () => {};', loader: 'js' }));
    } }],
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  const { AiBudgetView } = mod.exports;
  const ledger = (apps) => ({ id: '0c9a3e1f-1111-4222-8333-444455556666', path: '/mnt/data/ai-gate/ledger.db', apps: apps.map((app) => ({ app })) });
  const both = html(React.createElement(AiBudgetView, { profile: profile({ config: { ok: true, problems: [] }, ledger: ledger(['neuro', 'vantage']) }) }));
  assert.match(both, /Shared ledger: <code>\/mnt\/data\/ai-gate\/ledger\.db<\/code> · id 0c9a3e1f · registered: neuro, vantage/);
  assert.doesNotMatch(both, /NEURO has not registered/);
  const alone = html(React.createElement(AiBudgetView, { profile: profile({ ledger: ledger(['vantage']) }) }));
  assert.match(alone, /NEURO has not registered on this ledger/);
  const bad = html(React.createElement(AiBudgetView, { profile: { known: false, degraded: 'x', config: { ok: false, problems: ['AI_GATE_DB_PATH is not set.'] }, ledger: null } }));
  assert.match(bad, /The shared ledger is misconfigured: AI_GATE_DB_PATH is not set\./);
});
