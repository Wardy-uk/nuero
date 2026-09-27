'use strict';

/**
 * A REAL render of the Exertion / fitness / sleep-room section, through esbuild,
 * with payloads shaped like the live API's. A vite build proves it compiles; this
 * proves the honesty rules reach the page.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const COMPONENTS = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components');

async function load() {
  const out = await esbuild.build({
    entryPoints: [path.join(COMPONENTS, 'PerformanceSection.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'],
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const apiUrl = (p) => p; export const apiFetch = async () => ({ json: async () => ({}) });',
          loader: 'js',
        }));
      },
    }],
    logLevel: 'silent',
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  return m.exports.default;
}

const Chart = ({ title, days }) => React.createElement('div', { 'data-chart': title }, `${title}:${days.length}`);

const initial = (over = {}) => ({
  today: {
    today: { day: '2026-09-27', load: 42, score: 2.4, zoneMinutes: [30, 10, 2, 0, 0], elevatedMinutes: 120, partial: true, restHr: 75, maxHr: 158 },
    yesterday: { day: '2026-09-26', load: 209, score: 7.5 },
    trainingLoad: { known: true, ratio: 1.62, state: 'spike', acute: 120, chronic: 74, basis: 'acute:chronic ratio, textbook bands — a heuristic, not validated on you' },
    target: { known: true, low: 59, high: 81, recovery: 'normal' },
    scale: 'Banister TRIMP above resting + 10 bpm; the 0–10 score is a display scale and is not Athlytic’s',
  },
  exertion: { days: [{ day: '2026-09-26', load: 209, complete: true }, { day: '2026-09-25', load: 30, complete: true }] },
  fitness: { vo2max: { series: [{ week: '2026-09-21', value: 31.2 }], unit: 'ml/kg/min', change90d: -0.4 }, walkingHr: { series: [], unit: 'bpm' }, note: 'estimate' },
  sleepEnv: { known: false, needsLocation: true, why: 'NEURO does not know where the logger lives' },
  heat: { known: false, why: 'only 1 carried hike(s) with heart rate and walking speed — need 6', hikes: [] },
  ...over,
});

test('the scale disclaimer, the suggestion label and the heuristic all reach the page', async () => {
  const P = await load();
  const html = renderToString(React.createElement(P, { Chart, initial: initial() }));
  assert.match(html, /not Athlytic/);
  assert.match(html, /a suggestion/);
  assert.match(html, /heuristic/);
  assert.match(html, /1\.62×/);
  // Zone bands are in HIS bpm, from the scale the day was judged on: 75 + 0.2×83.
  assert.match(html, /92\+/);
});

test('the sleep read asks where the logger lives rather than guessing', async () => {
  const P = await load();
  const html = renderToString(React.createElement(P, { Chart, initial: initial() }));
  assert.match(html, /where it lives/);
  assert.match(html, /value="bedroom"/);
});

test('an empty fitness series says so instead of drawing a blank chart', async () => {
  const P = await load();
  const html = renderToString(React.createElement(P, { Chart, initial: initial() }));
  assert.match(html, /data-chart="VO2 max"/);
  assert.match(html, /Walking heart rate[\s\S]*No readings in the last two years/);
});

test('a finding is shown only when the service called it one', async () => {
  const P = await load();
  const sleepEnv = {
    known: true, sentence: 'No clear link between the bedroom overnight and your sleep across 30 nights.', threshold: 0.0125,
    caveat: 'Nights since 2026-09-27.',
    results: [{ outcome: 'asleepHours', label: 'time asleep', known: true, nights: 30, p: 0.03, significant: false, coolValue: 7.7, warmValue: 7.8, coolRoomC: 18, warmRoomC: 21, unit: 'h' }],
  };
  const html = renderToString(React.createElement(P, { Chart, initial: initial({ sleepEnv }) }));
  assert.match(html, /No clear link/);
  assert.ok(!/0\.03 ✓/.test(html), 'p = 0.03 is above the corrected threshold and must not be ticked');
});
