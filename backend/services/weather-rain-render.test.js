'use strict';

/**
 * The rain chart and the sources strip on the Weather screen: does it DRAW,
 * and does it keep "no reading" apart from "dry"?
 *
 * Real render through esbuild, like weather-render.test.js. Payload shapes are
 * the live /api/weather/rainfall and /api/weather/sources answers from pi5
 * (7 Oct 2026), trimmed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const FILE = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'WeatherPanel.jsx');

const cache = new Map();
async function build(file) {
  if (cache.has(file)) return cache.get(file);
  const out = await esbuild.build({
    entryPoints: [file], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'],
    plugins: [{
      name: 'stub',
      setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        b.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const apiFetch = async () => ({ ok: true, json: async () => ({}) });', loader: 'js',
        }));
      },
    }],
    logLevel: 'silent',
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  cache.set(file, m.exports);
  return m.exports;
}
const load = () => build(FILE);
const loadRain = () => build(path.join(path.dirname(FILE), 'WeatherRain.jsx'));

const NOW = Date.parse('2026-10-07T13:30:00Z');
const MIN = 60000;

function rainPayload(range = 'day') {
  // 24 hours: 22 hours of real readings (some dry, some wet, one Suspect), then
  // two hours with nothing read at all.
  const points = [];
  const start = NOW - 24 * 60 * MIN;
  for (let t = start; t < NOW - 2 * 60 * MIN; t += 15 * MIN) {
    const h = new Date(t).getUTCHours();
    points.push({ t, rainMm: h === 6 ? 0.4 : 0, feed: 'ea-hydrology', qc: h === 9 ? 'suspect' : 'unchecked' });
  }
  return { ok: true, source: 'ea:3641', periodS: 900, points };
}

const SOURCES = {
  ok: true,
  feeds: [
    { sourceId: 'ea:3641', feed: 'ea-flood-monitoring', state: 'ok', lastObservedAt: NOW - 45 * MIN, lastSuccessAt: NOW - 11 * MIN, consecutiveFailures: 0 },
    { sourceId: 'ea:3641', feed: 'ea-hydrology', state: 'ok', lastObservedAt: NOW - 45 * MIN, lastSuccessAt: NOW - 15 * MIN, consecutiveFailures: 0 },
  ],
  backfill: {
    900: { cursor: '2025-10-05', floor: '2021-01-01', chunks: 8, rows: 23712, errors: 0, lastError: null },
    86400: { cursor: '1985-10-24', floor: '1985-10-24', chunks: 9, rows: 14900, errors: 0, lastError: null },
  },
  wu: { importStations: ['ICOALV53', 'ICOALV50', 'ICOALV19'], importBlocked: 'WU_API_KEY is not set', publish: { stationId: 'ICOALV59', keySet: false, enabled: false } },
};

function view(m, props) {
  // React separates adjacent text with <!-- --> markers; the words are what is asserted.
  return renderToString(React.createElement(m.WeatherView, { range: 'day', onRange() {}, nowMs: NOW, ...props })).replace(/<!-- -->/g, '');
}

test('the rain chart draws bars, a hatched gap for slots never read, and a hollow Suspect bar', async () => {
  const m = await load();
  const html = view(m, { data: { node: null, ranges: null }, rain: { ...rainPayload(), query: null }, sources: SOURCES });
  assert.match(html, /aria-label="Rain chart"/);
  assert.match(html, /EA Mount St Bernards gauge/);
  assert.match(html, /mm in this window/);
  assert.match(html, /class="wx-bar[ "]/, 'real readings draw as bars');
  assert.match(html, /data-gap="1"/, 'a slot with no reading is a hatched gap, not a zero bar');
  assert.match(html, /wx-bar--suspect/, 'a bar with an EA-Suspect value is drawn hollow');
  assert.match(html, /no reading \(hatched\)/);
  assert.match(html, /not the home station/);
});

test('rain shows even when the home station has never reported', async () => {
  const m = await load();
  const html = view(m, { data: { node: null }, rain: rainPayload(), sources: SOURCES });
  assert.match(html, /No station readings yet/);
  assert.match(html, /aria-label="Rain chart"/);
});

test('a failed rain read says so and is never drawn as a dry window', async () => {
  const m = await load();
  const html = view(m, { data: { node: null }, rain: { error: 'HTTP 503' }, sources: SOURCES });
  assert.match(html, /Couldn’t read the rain gauge: HTTP 503\. This is not a dry spell\./);
  assert.doesNotMatch(html, /class="wx-bar[ "]/);
  assert.doesNotMatch(html, /mm in this window/, 'no total is claimed for a window nobody read');
  assert.doesNotMatch(html, /have no reading/, 'no slot count is claimed either');
});

test('nothing rain-shaped renders before the rain request has answered', async () => {
  const m = await load();
  const html = view(m, { data: { node: null }, rain: null, sources: null });
  assert.doesNotMatch(html, /Rain chart/);
  assert.doesNotMatch(html, /aria-label="Weather sources"/);
});

test('the sources strip names each feed, says WU is not set up rather than broken, and states backfill progress', async () => {
  const m = await load();
  const html = view(m, { data: { node: null }, rain: rainPayload(), sources: SOURCES });
  assert.match(html, /EA gauge — live \(provisional\)/);
  assert.match(html, /EA gauge — quality-checked record/);
  assert.match(html, /wx-src-state--ok/);
  assert.match(html, /Not set up/);
  assert.match(html, /needs an API key — Settings → Integrations → Weather Underground/);
  assert.match(html, /needs the station key, and the home station back online/);
  assert.match(html, /15-minute history: back to 5 Oct 2025, still walking to 1 Jan 2021/);
  assert.match(html, /Daily history: complete back to 24 Oct 1985/);
  assert.doesNotMatch(html, /Failing/, 'a credential not yet supplied is not a fault');
});

test('a failing feed says why and when it retries', async () => {
  const m = await load();
  const s = { ...SOURCES, feeds: [{ sourceId: 'ea:3641', feed: 'ea-flood-monitoring', state: 'backing-off', lastObservedAt: NOW - 5 * 3600000, lastSuccessAt: NOW - 5 * 3600000, consecutiveFailures: 3, lastError: 'HTTP 503', retryAfter: NOW + 20 * MIN }] };
  const html = view(m, { data: { node: null }, rain: rainPayload(), sources: s });
  assert.match(html, /Backing off/);
  assert.match(html, /HTTP 503/);
  assert.match(html, /retrying/);
});

test('bars: a dry reading is 0 mm, an unread slot is null, part-read and Suspect are counted', async () => {
  const r = await loadRain();
  const q = { fromMs: 0, toMs: 4 * 3600000, bucketMs: 3600000, period: 900 };
  const pts = [
    ...[0, 1, 2, 3].map((i) => ({ t: i * 900000, rainMm: 0, feed: 'ea-hydrology', qc: 'good' })), // hour 0: four dry readings
    { t: 3600000, rainMm: 1.2, feed: 'ea-flood-monitoring', qc: 'provisional' }, // hour 1: one of four
    { t: 2 * 3600000, rainMm: 0.4, feed: 'ea-hydrology', qc: 'suspect' }, // hour 2: suspect
    { t: 2 * 3600000 + 900000, rainMm: null, feed: 'ea-hydrology', qc: 'missing' }, // a null value is not a reading
  ];
  const bars = r.rainBars(pts, q);
  assert.deepEqual(bars.map((b) => b.mm), [0, 1.2, 0.4, null]);
  assert.equal(bars[0].n, 4);
  assert.equal(bars[2].n, 1, 'the null-valued point did not count as a reading');
  const sum = r.rainSummary(bars);
  assert.equal(sum.totalMm, 1.6);
  assert.equal(sum.missing, 1);
  assert.equal(sum.partial, 2);
  assert.equal(sum.suspect, 1);
});

test('the query a range asks for: 15-minute data up to a week, daily totals beyond', async () => {
  const r = await loadRain();
  assert.equal(r.rainQuery('day', NOW).period, 900);
  assert.equal(r.rainQuery('week', NOW).period, 900);
  assert.equal(r.rainQuery('month', NOW).period, 86400);
  assert.equal(r.rainQuery('year', NOW).period, 86400);
  const q = r.rainQuery('week', NOW);
  assert.ok(q.toMs - q.fromMs <= 92 * 86400000, "inside the route's 15-minute span limit");
  assert.ok(q.toMs >= NOW && q.fromMs < NOW);
});

test('nearby stations: a reading shows with its age, an offline station says so, a stale one is marked', async () => {
  const m = await load();
  const nearby = [
    { station: 'ICOALV53', name: 'Whitwick', offline: false, error: null,
      latest: { observedAt: NOW - 4 * MIN, ageMs: 4 * MIN, stale: false, temperatureC: 13.5, humidityPct: 65, pressureHpa: 996.95, windMs: 2.194, gustMs: 2.361, windDirectionDeg: 292, rainRateMmH: 0, rainTodayMm: 5.84, qc: 'good' } },
    { station: 'ICOALV50', name: null, offline: true, error: null, latest: null },
    { station: 'ICOALV19', name: 'Coalville', offline: false, error: null,
      latest: { observedAt: NOW - 90 * MIN, ageMs: 90 * MIN, stale: true, temperatureC: 13.5, humidityPct: 71, pressureHpa: 999.66, windMs: 1.389, gustMs: 2.194, windDirectionDeg: 298, rainRateMmH: 0, rainTodayMm: 5.08, qc: 'good' } },
  ];
  const html = view(m, { data: { node: null }, rain: rainPayload(), sources: { ...SOURCES, nearby } });
  assert.match(html, /aria-label="Nearby stations"/);
  assert.match(html, /Whitwick/);
  assert.match(html, /13\.5°C/);
  assert.match(html, /5 mph WNW, gust 5/);
  assert.match(html, /5\.8 mm/);
  assert.match(html, /Offline — no current reading/);
  assert.match(html, /wx-nb--stale/);
  assert.match(html, /⚠ /);
});

test('no nearby card when no station is configured or the sources read failed', async () => {
  const m = await load();
  assert.doesNotMatch(view(m, { data: { node: null }, rain: rainPayload(), sources: { ...SOURCES, nearby: [] } }), /Nearby stations/);
  assert.doesNotMatch(view(m, { data: { node: null }, rain: rainPayload(), sources: { error: 'HTTP 500' } }), /Nearby stations/);
});

test('elevation on the card: ground height, with the owner figure beside it only when it is wrong', async () => {
  const r = await loadRain();
  assert.equal(r.elevationText({ reportedM: 143.9, groundM: 142, mismatch: false }), '142 m');
  assert.equal(r.elevationText({ reportedM: 47.9, groundM: 168, mismatch: true }), '168 m ground · owner says 48 m');
  assert.equal(r.elevationText({ reportedM: 50, groundM: null, mismatch: false }), '50 m (owner’s figure, unchecked)');
  assert.equal(r.elevationText(null), '—');
  const m = await load();
  const nearby = [{ station: 'ICOALV16', name: 'Coalville', offline: false, error: null, elevation: { reportedM: 47.9, groundM: 168, mismatch: true },
    latest: { observedAt: NOW - 4 * MIN, ageMs: 4 * MIN, stale: false, temperatureC: 12.7, humidityPct: 80, pressureHpa: 1022, windMs: 1, gustMs: 2, windDirectionDeg: 0, rainRateMmH: 0, rainTodayMm: 4, qc: 'good' } }];
  assert.match(view(m, { data: { node: null }, rain: rainPayload(), sources: { ...SOURCES, nearby } }), /Elevation<\/dt><dd>168 m ground · owner says 48 m/);
});
