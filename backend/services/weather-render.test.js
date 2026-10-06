'use strict';

/**
 * Does the Weather screen DRAW, in every state?
 *
 * WeatherView takes its payload as a prop, so mounting it reaches the real
 * branches (the container fetches in useEffect, which renderToString never runs).
 * Lives in backend/services because `node --test` is only run from backend/.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const FILE = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'WeatherPanel.jsx');

let mod = null;
async function load() {
  if (mod) return mod;
  const out = await esbuild.build({
    entryPoints: [FILE], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
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

const NOW = Date.parse('2026-10-06T18:00:00Z');

/** The real summarise() output for the 6 Oct case: steady pressure, sensor indoors, rain overnight. */
function liveSummary() {
  const obs = Array.from({ length: 181 }, (_, i) => ({ t: NOW - (180 - i) * 60000, pressureHpa: 999.85, temperatureC: 23.2, humidityPct: 54.5 }));
  const forecast = [{ validAt: NOW, temperatureC: 16.4, precipMm: 0, precipProb: 10 },
    ...Array.from({ length: 24 }, (_, i) => ({ validAt: NOW + (i + 1) * 3600000, temperatureC: 15 - i * 0.2, precipMm: i >= 9 ? 1 : 0, precipProb: i >= 9 ? 95 : 20 }))];
  return require('./weather-trend').summarise({ obs, forecast, nowMs: NOW, providerLabel: 'Open-Meteo', issuedAt: NOW - 600000 });
}
const B = 5 * 60000;
function payload(over = {}) {
  const fromMs = NOW - 24 * 3600000;
  const series = Array.from({ length: 30 }, (_, i) => ({
    t: fromMs + i * B * 10,
    n: i < 25 ? 5 : 0,
    local: i < 25 ? { temperatureC: 15 + i * 0.1, humidityPct: 80, pressureHpa: 1004 - i * 0.05 } : { temperatureC: null, humidityPct: null, pressureHpa: null },
    forecast: { temperatureC: 14 + i * 0.1, humidityPct: 82, pressureHpa: 1003 },
  }));
  return {
    ok: true, range: 'day', node: 'outdoor-1', nodes: [],
    ranges: [{ id: 'hour', label: 'Hourly' }, { id: 'day', label: 'Daily' }, { id: 'week', label: 'Weekly' }, { id: 'month', label: 'Monthly' }, { id: 'year', label: 'Yearly' }],
    latest: { observedAt: NOW - 60000, temperatureC: 15.2, humidityPct: 81, pressureHpa: 1003.4, rssi: -55, ageMs: 60000, stale: false },
    staleAfterMs: 300000,
    history: { n: 1440, firstObservedAt: NOW - 86400000 },
    plan: { fromMs, toMs: fromMs + 30 * B * 10, bucketMs: B * 10, nowMs: NOW },
    forecast: { provider: 'open-meteo', label: 'Open-Meteo', lastIssuedAt: NOW - 600000, points: 48 },
    series,
    summary: liveSummary(),
    ...over,
  };
}
const render = (m, props) => renderToString(React.createElement(m.WeatherView, { range: 'day', ...props }));

test('all five ranges are offered', async () => {
  const html = render(await load(), { data: payload() });
  for (const l of ['Hourly', 'Daily', 'Weekly', 'Monthly', 'Yearly']) assert.match(html, new RegExp(`>${l}<`));
});

test('three charts draw, each with a SOLID local line and a DASHED forecast line, both named', async () => {
  const html = render(await load(), { data: payload() });
  for (const t of ['Temperature', 'Relative humidity', 'Pressure']) assert.match(html, new RegExp(`<h3>${t}</h3>`));
  const localPaths = html.match(/class="wx-line wx-line--local"/g) || [];
  const fcPaths = html.match(/class="wx-line wx-line--forecast"/g) || [];
  assert.equal(localPaths.length, 3);
  assert.equal(fcPaths.length, 3);
  assert.equal((html.match(/Local sensor/g) || []).length >= 3, true);
  assert.match(html, /Forecast<!-- --> \(Open-Meteo\)|Forecast \(Open-Meteo\)/);
  // A drawn path has real commands, not an empty `d`.
  assert.match(html, /d="M[\d.]+ [\d.]+ L/);
});

test('⚠ the outlook is SPLIT: a sensor card and a forecast card, then "together" — above the charts', async () => {
  const html = render(await load(), { data: payload() });
  const s = html.indexOf('What the sensor says');
  const f = html.indexOf('What the forecast says');
  const t = html.indexOf('>Together<');
  assert.ok(s > 0 && f > s && t > f, 'sensor, then forecast, then together');
  assert.ok(t < html.indexOf('<h3>Temperature</h3>'));
  // The fixture is the REAL summarise() output for the live indoor case.
  assert.match(html, /Pressure steady — no sign of a change/);
  assert.match(html, /probably indoors/);
  assert.equal((html.match(/>not used</g) || []).length, 2, 'temperature and humidity marked not used');
  assert.match(html, /Next 6 h/);
  assert.match(html, /Next 24 h/);
});

test('a backend older than the split still shows its paragraph rather than nothing', async () => {
  const html = render(await load(), { data: payload({ summary: { paragraph: 'Old-style outlook text.', confidence: 'low' } }) });
  assert.match(html, /Old-style outlook text\./);
});

test('⚠ a stale station SAYS so and names what to check', async () => {
  const p = payload({ latest: { ...payload().latest, ageMs: 40 * 60000, stale: true } });
  const html = render(await load(), { data: p });
  assert.match(html, /has not reported for/);
  assert.match(html, /not current conditions/);
});

test('no forecast for the window: the legend says so, and no dashed line is drawn', async () => {
  const p = payload();
  p.series = p.series.map((s) => ({ ...s, forecast: { temperatureC: null, humidityPct: null, pressureHpa: null } }));
  const html = render(await load(), { data: p });
  assert.match(html, /none for this window/);
  assert.equal((html.match(/wx-line--forecast/g) || []).length, 0);
});

test('⚠ no node yet is an empty state, distinct from an error', async () => {
  const html = render(await load(), { data: payload({ node: null, latest: null }) });
  assert.match(html, /No station readings yet/);
  assert.doesNotMatch(html, /Couldn’t load/);
});

test('an API error is shown, never rendered as an empty station', async () => {
  const html = render(await load(), { data: null, error: 'HTTP 503' });
  assert.match(html, /Couldn’t load the weather: <!-- -->HTTP 503|Couldn’t load the weather: HTTP 503/);
  assert.doesNotMatch(html, /No station readings yet/);
});

test('loading before any data', async () => {
  assert.match(render(await load(), { data: null, loading: true }), /Loading weather/);
});

test('times are Europe/London (18:00Z in October is 19:00 BST), with the zone named in tooltips', async () => {
  const m = await load();
  assert.equal(m.tickLabel(NOW, 'day'), '19:00');
  assert.match(m.exactTime(NOW, 60000), /19:00 BST/);
  assert.match(m.exactTime(Date.parse('2026-12-06T18:00:00Z'), 60000), /18:00 GMT/);
  assert.match(m.exactTime(NOW, 3600000), /19:00–20:00 BST/);
});

test('ticks land on round Europe/London boundaries, across a clock change too', async () => {
  const m = await load();
  const day = m.niceTicks(NOW - 24 * 3600000, NOW + 12 * 3600000, 'day', 5);
  assert.ok(day.length >= 3 && day.length <= 7);
  for (const t of day) assert.match(m.tickLabel(t, 'day'), /^(00|03|06|09|12|15|18|21):00$/);
  // Week spanning the 25 Oct 2026 change: every tick is London midnight.
  const wk = m.niceTicks(Date.parse('2026-10-21T10:00:00Z'), Date.parse('2026-10-28T10:00:00Z'), 'week', 8);
  for (const t of wk) assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t)), '00:00');
  const yr = m.niceTicks(NOW - 365 * 86400000, NOW, 'year', 6);
  for (const t of yr) assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric' }).format(new Date(t)), '1');
});

test('⚠ pressure forecast is drawn on the station’s level, labelled as shifted; the tooltip value is as issued', async () => {
  const m = await load();
  assert.equal(m.medianOffset([1001, 1001.2, 1000.8, null], [1015, 1015, 1015, 1016]), -14);
  assert.equal(m.medianOffset([1, null], [2, 3]), null, 'too little overlap shifts nothing');
  const p = payload();
  p.series = p.series.map((s) => ({ ...s, forecast: { ...s.forecast, pressureHpa: (s.local.pressureHpa ?? 1003) + 14 } }));
  const html = render(m, { data: p });
  assert.match(html, /shifted −14\.0 hPa to the station’s level/);
});
