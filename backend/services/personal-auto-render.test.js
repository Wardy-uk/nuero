'use strict';

/**
 * Personal automations on screen (1 Nov 2026), rendered for real (esbuild →
 * renderToString): the hike suggestion and GP pack views, the hike arm form
 * pre-filled, and a source scan that Now, Outdoor and Personal Admin MOUNT them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..', '..');
async function load(rel) {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, rel)], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom', 'leaflet'], logLevel: 'silent',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      b.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiFetch = async () => ({ ok: true, json: async () => ({}) }); export const API_URL = "";', loader: 'js' }));
    } }],
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  return m.exports;
}

let offers; let hike;
test.before(async () => {
  offers = await load('frontend/src/components/PersonalAutoOffers.jsx');
  hike = await load('frontend/src/components/canonical/HikeSafetyCard.jsx');
});

const SUG = { weekend: '2026-11-07', day: '2026-11-07', line: "Saturday looks good and you're 1 hike behind — plan one?", weather: 'Looks favourable.',
  prefill: { plannedStart: '2026-11-07T09:30', plannedFinish: '2026-11-07T14:30', name: 'Mam Tor', emberPlanned: true, party: [{ name: 'Helen' }], note: 'Prefilled from your last walk.' } };

test('the hike suggestion offers Plan it and Not this weekend; nothing renders without one', () => {
  const html = renderToString(React.createElement(offers.HikeSuggestionView, { suggestion: SUG, onPlan: () => {}, onDismiss: () => {} }));
  assert.match(html, /Saturday looks good and you(&#x27;|')re 1 hike behind/);
  assert.match(html, /Plan it/);
  assert.match(html, /Not this weekend/);
  assert.equal(renderToString(React.createElement(offers.HikeSuggestionView, { suggestion: null })), '');
  assert.equal(renderToString(React.createElement(offers.GpPacksView, { packs: [] })), '');
});

test('a GP pack ready shows Open', () => {
  const html = renderToString(React.createElement(offers.GpPacksView, { packs: [{ path: 'Personal/Health/GP visits/x.md', line: 'GP pack ready for Thursday', title: 'GP appointment', time: '10:20' }], onOpen: () => {} }));
  assert.match(html, /GP pack ready for Thursday/);
  assert.match(html, /Open/);
});

test('Plan it opens the arm form pre-filled — date, times, name, party, Ember — and arming is still a press', () => {
  const data = { active: null, contacts: [{ name: 'Helen', email: 'h@example.com' }], recent: [], sendsFrom: null, rule: '', limits: '' };
  const html = renderToString(React.createElement(hike.HikeSafetyView, { data, act: async () => true, prefill: SUG.prefill }));
  assert.match(html, /data-testid="hike-arm-form"/);
  assert.match(html, /value="2026-11-07T09:30"/);
  assert.match(html, /value="2026-11-07T14:30"/);
  assert.match(html, /value="Mam Tor"/);
  assert.match(html, /value="Helen"/);
  assert.match(html, /Prefilled from your last walk/);
  const plain = renderToString(React.createElement(hike.HikeSafetyView, { data, act: async () => true }));
  assert.doesNotMatch(plain, /hike-arm-form/, 'without a prefill the form stays closed');
});

test('mounted: Now, Outdoor and Personal Admin', () => {
  const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  assert.match(src('frontend/src/components/AdhdPanel.jsx'), /<PersonalAutoOffers \/>/);
  assert.match(src('frontend/src/components/canonical/OutdoorCard.jsx'), /<HikeSuggestion \/>/);
  assert.match(src('frontend/src/components/canonical/FutureRadar.jsx'), /renewalWatch/);
  assert.match(src('frontend/src/App.jsx'), /registerNavigator\(/);
});
