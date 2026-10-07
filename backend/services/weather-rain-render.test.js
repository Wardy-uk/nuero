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

function nowcastPayload(over = {}) {
  const st = (id, mi, bearing, sector, dir, raining, latest, extra = {}) => ({
    id, name: id === 'ICOALV2' ? 'Coalville' : null, raining, lastSeenAt: latest ? latest.t : NOW - 5 * 3600000,
    geo: { mi, bearing, dir, sector, ring: mi <= 3.5 ? 'near' : 'far' },
    latest, elevation: { reportedM: 143.9, groundM: 142 }, ...extra,
  });
  const L = (t, temp, rain = 0) => ({ t: NOW - t * MIN, temperatureC: temp, humidityPct: 80, windMs: 4, windDirectionDeg: 260, rainAccumMm: rain, rainRateMmH: 0 });
  return {
    ok: true, nowMs: NOW, homeKnown: true, reporting: 3,
    wind: { fromDeg: 260, from: 'W', speedMs: 4, mph: 9, stations: 12, steadiness: 0.8, trusted: true },
    home: { raining: false },
    arrival: { state: 'rain-likely', etaMin: [12, 30], raining: ['ICOALV52'], upwind: ['ICOALV52', 'IASHBY12'], nearest: { id: 'ICOALV52', mi: 3.3, dir: 'WSW' }, confidence: 'low' },
    pressure: { known: true, delta3h: -2.1, word: 'falling slowly', band: 'slow', stations: 14, agree: 11 },
    stations: [
      st('ICOALV2', 0.7, 305, 'W', 'NW', false, L(4, 13.2)),
      st('ICOALV52', 3.3, 238, 'W', 'WSW', true, L(6, 12.1, 1.4)),
      st('ILOUGH46', 5.3, 98, 'E', 'E', false, L(5, 13.8)),
      st('IDERBY127', 5.0, 335, 'N', 'NNW', null, null, { elevation: { reportedM: 47.9, groundM: 168, mismatch: true } }),
    ],
    record: { hits: 0, misses: 0, unknown: 0, open: 1, onsets: 0, onsetsPredicted: 0 },
    ...over,
  };
}

test('the nowcast card names the rain window, the wind, the pressure consensus and the record', async () => {
  const m = await load();
  const html = view(m, { data: { node: null }, rain: rainPayload(), sources: SOURCES, nowcast: nowcastPayload() });
  assert.match(html, /aria-label="Local nowcast"/);
  assert.match(html, /Rain likely in about <strong>12–30 min<\/strong>/);
  assert.match(html, /nearest ICOALV52 \(3\.3 mi WSW\)\. Low confidence/);
  assert.match(html, /from W, 9 mph \(median of 12 stations\)/);
  assert.match(html, /falling slowly across the ring \(-2\.1 hPa in 3 h; 11 of 14 agree\)/);
  assert.match(html, /no rain calls yet — each one is recorded and checked/);
});

test('the nowcast never pretends: no wind, home raining and a failed read each say so', async () => {
  const m = await load();
  const v = (arrival) => view(m, { data: { node: null }, nowcast: nowcastPayload({ arrival }) });
  assert.match(v({ state: 'no-wind', why: 'the stations disagree on the wind direction' }), /Can’t call rain arriving: the stations disagree/);
  assert.match(v({ state: 'raining-here' }), /Raining here now\./);
  assert.match(v({ state: 'dry-upwind', upwind: ['A', 'B'], reporting: 2 }), /No rain upwind — 2 of 2 upwind stations reporting, all dry\./);
  assert.match(view(m, { data: { node: null }, nowcast: { error: 'HTTP 500' } }), /Couldn’t read the local nowcast: HTTP 500/);
  const rec = view(m, { data: { node: null }, nowcast: nowcastPayload({ record: { hits: 3, misses: 1, unknown: 1, onsets: 5, onsetsPredicted: 3 } }) });
  assert.match(rec, /rain calls 3 right, 1 wrong, 1 couldn’t tell; rain started here 5 times, 3 called in advance/);
});

test('nearby stations: grouped by direction, plotted on the compass, wet / dry / quiet told apart', async () => {
  const m = await load();
  const html = view(m, { data: { node: null }, nowcast: nowcastPayload() });
  assert.match(html, /aria-label="Nearby stations"/);
  assert.match(html, /3 of 4 reporting/);
  for (const h of ['North', 'East', 'West']) assert.match(html, new RegExp(`<h3>${h}</h3>`));
  assert.doesNotMatch(html, /<h3>South<\/h3>/, 'an empty direction is not drawn');
  assert.match(html, /wx-cmp-st--wet/);
  assert.match(html, /wx-cmp-st--quiet/, 'a station with no recent reading is hollow, not dry');
  assert.match(html, /1\.4 mm today · raining/);
  assert.match(html, /last heard/);
  assert.match(html, /168 m ground · owner says 48 m/);
  assert.match(html, /wx-cmp-wind/, 'the wind arrow is drawn when the wind is trusted');
  assert.doesNotMatch(view(m, { data: { node: null }, nowcast: nowcastPayload({ wind: { ...nowcastPayload().wind, trusted: false } }) }), /wx-cmp-wind/);
});

test('elevation text: ground height, with the owner figure only when it is wrong', async () => {
  const r = await loadRain();
  assert.equal(r.elevationText({ reportedM: 143.9, groundM: 142, mismatch: false }), '142 m');
  assert.equal(r.elevationText({ reportedM: 47.9, groundM: 168, mismatch: true }), '168 m ground · owner says 48 m');
  assert.equal(r.elevationText({ reportedM: 50, groundM: null }), '50 m (owner’s figure, unchecked)');
  assert.equal(r.elevationText(null), '—');
});

test('sources strip: WU stations are one line, and a station that is not OK is named, never folded away', async () => {
  const m = await load();
  const wuFeed = (id, state, extra = {}) => ({ sourceId: `wu:${id}`, feed: 'wu-pws-v2', state, lastObservedAt: NOW - MIN, lastSuccessAt: NOW - MIN, consecutiveFailures: state === 'failing' ? 2 : 0, ...extra });
  const s = { ...SOURCES, feeds: [...SOURCES.feeds, wuFeed('IA', 'ok'), wuFeed('IB', 'ok'), wuFeed('IC', 'failing', { lastError: 'HTTP 401' })] };
  const html = view(m, { data: { node: null }, sources: s });
  assert.match(html, /Weather Underground nearby stations/);
  assert.match(html, /2 of 3 OK · IC failing \(HTTP 401\)/);
  assert.doesNotMatch(html, /Weather Underground IA/);
  assert.doesNotMatch(html, /Not set up/, 'with stations imported, the not-set-up line is gone');
});

test('layout: sensor|forecast then tiles|together, stale warning, nowcast, station charts, rain, nearby, sources — in that order', async () => {
  const m = await load();
  const S = require('./weather-trend').summarise({ obs: [], forecast: [], nowMs: NOW, providerLabel: 'Open-Meteo' });
  const data = {
    node: 'outdoor-1', range: 'day', ranges: null, summary: S, staleAfterMs: 300000, history: { n: 261 }, forecast: { label: 'Open-Meteo' },
    latest: { observedAt: NOW - 17 * 3600000, ageMs: 17 * 3600000, stale: true, temperatureC: 22.2, humidityPct: 57, pressureHpa: 999.3, rssi: -51 },
    plan: { fromMs: NOW - 24 * 3600000, toMs: NOW + 12 * 3600000, bucketMs: 300000, nowMs: NOW }, series: [],
  };
  const html = view(m, { data, rain: rainPayload(), sources: SOURCES, nowcast: nowcastPayload() });
  const at = (re) => { const i = html.search(re); assert.ok(i >= 0, `missing ${re}`); return i; };
  const order = [/wx-area-sensor/, /wx-area-forecast/, /wx-area-tiles/, /wx-area-together/, /class="wx-stale"/,
    /aria-label="Local nowcast"/, /aria-label="Temperature chart"/, /aria-label="Rain chart"/, /aria-label="Nearby stations"/, /aria-label="Weather sources"/].map(at);
  for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], `item ${i} is out of order`);
  assert.match(html, /wx-latest--2x2/);
  assert.equal(html.match(/aria-label="Local nowcast"/g).length, 1, 'the nowcast is drawn once');
});
