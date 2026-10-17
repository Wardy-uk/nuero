'use strict';

/**
 * The Apple Health page's Nutrition section — a REAL render via esbuild, fed a
 * payload from the real nutrition.compose(), so a field renamed on either side
 * fails here. NutritionSection fetches in useEffect (never run by
 * renderToString), so the pure NutritionView is mounted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');
const nutrition = require('./nutrition');

const COMPONENTS = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components');

let mod = null;
async function load() {
  if (mod) return mod;
  const out = await esbuild.build({
    entryPoints: [path.join(COMPONENTS, 'NutritionSection.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'],
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const apiFetch = async () => ({ ok: true, json: async () => ({}) });', loader: 'js',
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

const TODAY = '2026-10-12';
const meal = (day, kcal, sodiumG) => [
  { metric: 'dietary_energy_consumed', value: kcal, recorded_at: `${day} 12:00:00` },
  { metric: 'dietary_sodium', value: sodiumG, recorded_at: `${day} 12:00:00` },
  { metric: 'dietary_calcium', value: 0.2, recorded_at: `${day} 12:00:00` },
];

function render(data, extra = {}) {
  const { NutritionView } = mod;
  return renderToString(React.createElement(NutritionView, { data, range: 14, onRange() {}, showAll: false, onToggleAll() {}, ...extra }))
    .replace(/<!-- -->/g, '');
}

test('logged and unlogged days render differently, and a low day is not marked', async () => {
  await load();
  const data = nutrition.compose({ samples: [...meal('2026-10-11', 2100, 3), ...meal('2026-10-10', 500, 3)], today: TODAY, windowDays: 7 });
  const html = render(data);
  assert.match(html, /2100/);
  assert.doesNotMatch(html, />part</);
  assert.match(html, /500/);
  assert.match(html, /not logged/);
  // Salt is shown as salt (sodium × 2.5), against the 6g limit.
  assert.match(html, /7\.5 g/);
  assert.match(html, /nut-bar--over/);
  // Calcium is a floor: tagged, and never coloured as under.
  assert.match(html, />floor</);
  assert.doesNotMatch(html, /nut-bar--under/);
});

test('a window with nothing logged says so, and never renders a zero day', async () => {
  await load();
  const data = nutrition.compose({ samples: [], today: TODAY, windowDays: 7 });
  const html = render(data);
  assert.match(html, /Nothing logged in the last 7 days/);
  assert.doesNotMatch(html, /0 kcal/);
});

test('alcohol: a column per day and a summary line; an unreadable day shows — not 0', async () => {
  await load();
  const data = nutrition.compose({
    entries: [
      { metric: 'dietary_energy_consumed', value: 825, recorded_at: '2026-10-11 19:14:13', food_type: 'Blended Scotch Whisky Aged 3 Years', food_item: 'W1' },
      { metric: 'dietary_energy_consumed', value: 1800, recorded_at: '2026-10-10 12:00:00', food_type: null, food_item: null },
    ],
    today: TODAY, windowDays: 7,
  });
  const html = render(data);
  assert.match(html, /Alcohol <span class="nut-unit">units/);
  assert.match(html, />14\.7</);
  assert.match(html, /data-testid="nut-alcohol"[^>]*>alcohol <b>14\.7<\/b> units \(1 drink\) over 1 day with drink names/);
  assert.match(html, /No named entries this day[^>]*>—</);
});
