'use strict';

/**
 * The weekend hiking pick on Outdoor (7 Nov 2026). PURE.
 * Pinned: it ranks on the same suitability verdict; ties break on rain, then the
 * wettest hour, then wind, and only past a difference that matters; unknown never
 * wins; two poor days pick nothing; a Sunday compares Sunday alone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const m = require('./outdoor-model');

const w = (day, state, measures = {}, extra = {}) => ({ day, state, severe: false, line: `${state}.`, measures, ...extra });

test('weekendDays: weekday → next Sat+Sun; Saturday → today+Sunday; Sunday → just Sunday', () => {
  assert.deepEqual(m.weekendDays('2026-11-05'), ['2026-11-07', '2026-11-08']);  // Thursday
  assert.deepEqual(m.weekendDays('2026-11-07'), ['2026-11-07', '2026-11-08']);  // Saturday
  assert.deepEqual(m.weekendDays('2026-11-08'), ['2026-11-08']);                // Sunday
});

test('a better verdict wins', () => {
  const r = m.weekendPick([w('2026-11-07', 'mixed'), w('2026-11-08', 'favourable')]);
  assert.equal(r.best, '2026-11-08');
  assert.match(r.line, /^Sunday looks better for a hike than Saturday/);
});

test('same verdict: less rain edges it, but a sub-1mm difference is a tie', () => {
  const edge = m.weekendPick([w('2026-11-07', 'mixed', { rainMm: 4 }), w('2026-11-08', 'mixed', { rainMm: 1.5 })]);
  assert.equal(edge.best, '2026-11-08');
  assert.match(edge.line, /Sunday edges it — 1.5 mm of rain against 4 mm/);
  const tie = m.weekendPick([w('2026-11-07', 'favourable', { rainMm: 0.2, maxProb: 20, windKmh: 12 }), w('2026-11-08', 'favourable', { rainMm: 0.6, maxProb: 25, windKmh: 14 })]);
  assert.equal(tie.best, null);
  assert.equal(tie.tie, true);
  assert.match(tie.line, /look much the same/);
});

test('unknown never wins, and two poor days pick nothing', () => {
  const one = m.weekendPick([w('2026-11-07', 'unknown'), w('2026-11-08', 'mixed')]);
  assert.equal(one.best, '2026-11-08');
  assert.match(one.line, /No forecast for Saturday yet/);
  const none = m.weekendPick([w('2026-11-07', 'unknown'), w('2026-11-08', 'unknown')]);
  assert.equal(none.known, false);
  const poor = m.weekendPick([w('2026-11-07', 'poor'), w('2026-11-08', 'poor')]);
  assert.equal(poor.best, null);
  assert.match(poor.line, /Neither weekend day looks good/);
});

test('suitability carries its numbers for the comparison', () => {
  const s = m.suitability({ daily: { precipitationMm: 3.2, tempHighC: 12, tempLowC: 5, windKmh: 20 } });
  assert.equal(s.measures.rainMm, 3.2);
  assert.equal(s.measures.windKmh, 20);
});

test('the card draws the weekend group with the better day marked', async () => {
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'canonical', 'OutdoorCard.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      b.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiFetch = async () => ({ ok: true, json: async () => ({}) });', loader: 'js' }));
    } }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  const weekend = m.weekendPick([w('2026-11-07', 'mixed'), w('2026-11-08', 'favourable', {}, { planned: true })]);
  const data = { summary: { confirmedHikes: 0, meaningfulWalks: 0 }, goal: null, weekend };
  const html = renderToString(React.createElement(mod.exports.OutdoorView, { data }));
  assert.match(html, /data-testid="outdoor-weekend"/);
  assert.match(html, /Sunday · better day/);
  assert.match(html, /Sunday looks better for a hike than Saturday/);
  assert.match(html, />planned</);
});
