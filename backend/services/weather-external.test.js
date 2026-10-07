'use strict';

/**
 * External weather: the normalised store, the EA rain gauge adapter and the
 * Weather Underground adapter (import + publish), against a scratch SQLite.
 *
 * Fixtures are COPIED from the live APIs on 7 Oct 2026, not invented — the
 * hydrology timestamps carrying no zone, the 204 from an offline station and
 * precipTotal being a since-midnight accumulation were all found on real data.
 * No network: every fetch is a stub.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-extwx-')), 'a.db');

const db = require('../db/database');
const ext = require('./weather-external');
const ea = require('./weather-ea');
const wu = require('./weather-wu');

test.before(async () => { await db.init(); });

const NOW = Date.parse('2026-10-07T12:40:00Z');
const noSleep = async () => {};

// ── live fixtures ────────────────────────────────────────────────────────────
const FM_ITEM = {
  '@id': 'http://environment.data.gov.uk/flood-monitoring/data/readings/3641-rainfall-tipping_bucket_raingauge-t-15_min-mm/2026-10-07T12-00-00Z',
  dateTime: '2026-10-07T12:00:00Z',
  measure: 'http://environment.data.gov.uk/flood-monitoring/id/measures/3641-rainfall-tipping_bucket_raingauge-t-15_min-mm',
  value: 0.0,
};
const HY_15 = { measure: { '@id': 'x' }, date: '2026-06-02', dateTime: '2026-06-02T00:15:00', value: 0.8, valid: '10000', invalid: '0', missing: '0', completeness: 'Complete', quality: 'Good' };
const HY_DAY = { measure: { '@id': 'x' }, date: '1985-10-24', dateTime: '1985-10-24T09:00:00', value: 0.0, valid: '0', invalid: '0', missing: '0', completeness: 'Incomplete', quality: 'Good' };
const WU_CURRENT = {
  stationID: 'ICOALV53', obsTimeUtc: '2026-10-07T12:41:42Z', obsTimeLocal: '2026-10-07 13:41:42', neighborhood: 'Whitwick',
  softwareType: null, country: 'GB', solarRadiation: null, lon: -1.365108, realtimeFrequency: null, epoch: 1791376902,
  lat: 52.74191, uv: null, winddir: 292, humidity: 93.0, qcStatus: 1,
  metric: { temp: 10.8, heatIndex: 10.8, dewpt: 9.7, windChill: 10.8, windSpeed: 2.1, windGust: 2.1, pressure: 996.95, precipRate: 0.25, precipTotal: 5.84, elev: 41.8 },
};

function fakeFetch(handler) {
  const calls = [];
  const f = async (url) => {
    calls.push(String(url));
    const r = await handler(String(url), calls.length);
    const status = r.status || 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r.body, text: async () => r.text ?? JSON.stringify(r.body) };
  };
  f.calls = calls;
  return f;
}

// ── pure ─────────────────────────────────────────────────────────────────────

test('EA live reading shapes to SI with provisional QC and a compact raw payload', () => {
  const o = ea.shapeFlood(FM_ITEM, NOW);
  assert.equal(o.observed_at, Date.parse('2026-10-07T12:00:00Z'));
  assert.equal(o.period_s, 900);
  assert.equal(o.rain_mm, 0, 'a zero is a measurement (dry), kept');
  assert.equal(o.qc_status, 'provisional');
  assert.deepEqual(o.raw_payload, { dateTime: '2026-10-07T12:00:00Z', value: 0 });
  assert.equal(ext.validate(o, NOW).ok, true);
});

test('EA hydrology: a zone-less timestamp is read as UTC, never local', () => {
  // 2 June is BST; a local parse would land at 23:15 on 1 June UTC.
  const o = ea.shapeHydrology(HY_15, 900, NOW);
  assert.equal(o.observed_at, Date.parse('2026-06-02T00:15:00Z'));
  assert.equal(o.qc_status, 'good');
  assert.equal(o.raw_payload.completeness, 'Complete');
  assert.ok(ea.PROVENANCE[o.provenance], 'every provenance code resolves');
  assert.equal(o.raw_payload.quality, 'Good', 'the source flag is preserved verbatim');
  // A shape the header did not anticipate is refused, not guessed at.
  assert.equal(ea.shapeHydrology({ ...HY_15, dateTime: '2026-06-02T00:15:00+01:00' }, 900, NOW), null);
});

test('EA daily series keeps its water-day date in the raw payload', () => {
  const o = ea.shapeHydrology(HY_DAY, 86400, NOW);
  assert.equal(o.period_s, 86400);
  assert.equal(o.raw_payload.date, '1985-10-24');
  assert.equal(o.observed_at, Date.parse('1985-10-24T09:00:00Z'));
});

test('EA quality words map, and an unknown one is kept rather than guessed', () => {
  assert.equal(ea.mapQuality('Unchecked'), 'unchecked');
  assert.equal(ea.mapQuality('Suspect'), 'suspect');
  assert.equal(ea.mapQuality('Rejected'), 'unknown:Rejected');
  assert.equal(ea.mapQuality(undefined), 'unknown');
});

test('a missing value is null, never 0', () => {
  assert.equal(ea.shapeFlood({ dateTime: '2026-10-07T12:00:00Z', value: null }, NOW).rain_mm, null);
});

test('validation refuses out-of-bounds values and missing provenance rather than clipping', () => {
  const o = ea.shapeFlood(FM_ITEM, NOW);
  assert.equal(ext.validate({ ...o, rain_mm: -1 }, NOW).ok, false);
  assert.equal(ext.validate({ ...o, provenance: null }, NOW).ok, false);
  assert.equal(ext.validate({ ...o, observed_at: NOW + 3600000 }, NOW).ok, false, 'a reading from the future is a broken clock');
});

test('backfill chunks walk backwards and stop at the floor', () => {
  assert.deepEqual(ea.nextChunk(900, '2016-02-01', '2016-01-01'), { from: '2016-01-01', to: '2016-02-01' });
  assert.equal(ea.nextChunk(900, '2016-01-01', '2016-01-01'), null);
  const d = ea.nextChunk(86400, '2026-06-01', '1985-10-24');
  assert.ok(d.from < '2021-06-01' && d.to === '2026-06-01');
  assert.equal(ea.floorFor(900, {}), '2021-01-01');
  assert.equal(ea.floorFor(900, { WEATHER_EA_15MIN_FROM: '1900-01-01' }), '2021-01-01', 'before the gauge opened is refused');
  assert.equal(ea.floorFor(900, { WEATHER_EA_15MIN_FROM: '2000-01-01' }), '2000-01-01');
});

test('backoff grows and caps', () => {
  assert.equal(ext.backoffMs(0), 0);
  assert.equal(ext.backoffMs(1), 5 * 60000);
  assert.equal(ext.backoffMs(2), 10 * 60000);
  assert.equal(ext.backoffMs(20), 6 * 3600000);
});

test('WU current: km/h → m/s, precipTotal is an accumulation, rain_mm stays null', () => {
  const o = wu.shapeCurrent(WU_CURRENT, NOW);
  assert.equal(o.source_id, 'wu:ICOALV53');
  assert.equal(o.wind_ms, 0.583);
  assert.equal(o.rain_accum_mm, 5.84);
  assert.equal(o.rain_mm, null);
  assert.equal(o.qc_status, 'good');
  assert.equal(o.period_s, 0);
  assert.equal(ext.validate(o, NOW).ok, true);
});

test('WU import is blocked, not failed, without a key — and the default stations are the three named', () => {
  assert.match(wu.importBlocked({}), /WU_API_KEY/);
  assert.equal(wu.importBlocked({ WU_API_KEY: 'k' }), null);
  assert.deepEqual(wu.importStations({}), ['ICOALV53', 'ICOALV50', 'ICOALV19']);
});

test('WU upload params convert SI → imperial at the boundary, and omit what was not measured', () => {
  const p = wu.toWuParams({ observedAt: Date.parse('2026-10-07T12:00:00Z'), temperatureC: 10, humidityPct: 93.4, pressureHpa: 1000, windMs: null });
  assert.equal(p.tempf, 50);
  assert.equal(p.humidity, 93);
  assert.equal(p.baromin, 29.53);
  assert.equal(p.dateutc, '2026-10-07 12:00:00');
  assert.ok(!('windspeedmph' in p), 'no sensor is not a reading of 0');
  assert.ok(!('rainin' in p));
});

test('the upload preview never carries the station key', () => {
  const env = { WU_STATION_ID: 'ICOALV59', WU_STATION_KEY: 'sekrit123' };
  const pv = wu.previewUpload({ observedAt: NOW, temperatureC: 12 }, {}, env);
  assert.ok(!pv.url.includes('sekrit123'));
  assert.match(pv.url, /PASSWORD=%3Credacted%3E/);
  assert.equal(pv.config.keySet, true);
  assert.ok(!JSON.stringify(pv.config).includes('sekrit'));
});

// ── storage ──────────────────────────────────────────────────────────────────

test('upsert: identical re-read is a duplicate; a QC revision updates in place and keeps the old raw', () => {
  const unchecked = ea.shapeHydrology({ ...HY_15, dateTime: '2026-09-01T10:00:00', quality: 'Unchecked', value: 0.4 }, 900, NOW);
  assert.equal(ext.upsert([unchecked], { nowMs: NOW }).stored, 1);
  assert.equal(ext.upsert([unchecked], { nowMs: NOW + 1000 }).duplicate, 1, 'receipt time alone is not a change');
  const good = ea.shapeHydrology({ ...HY_15, dateTime: '2026-09-01T10:00:00', quality: 'Good', value: 0.6 }, 900, NOW);
  assert.equal(ext.upsert([good], { nowMs: NOW + 2000 }).revised, 1);
  const row = db.get("SELECT * FROM external_weather_observations WHERE feed = 'ea-hydrology' AND observed_at = ?", [Date.parse('2026-09-01T10:00:00Z')]);
  assert.equal(row.revision, 1);
  assert.equal(row.rain_mm, 0.6);
  assert.equal(row.qc_status, 'good');
  assert.equal(JSON.parse(row.previous_payload).quality, 'Unchecked');
});

test('canonical rain prefers the qualified record, falls back to live, and never invents a gap', () => {
  const t1 = '2026-09-02T10:00:00', t2 = '2026-09-02T10:15:00';
  ext.upsert([
    ea.shapeFlood({ dateTime: t1 + 'Z', value: 0.2 }, NOW),
    ea.shapeHydrology({ ...HY_15, dateTime: t1, value: 0.4 }, 900, NOW),
    ea.shapeFlood({ dateTime: t2 + 'Z', value: 0.6 }, NOW),
  ], { nowMs: NOW });
  const s = ext.canonicalRain('ea:3641', { periodS: 900, fromMs: Date.parse(t1 + 'Z'), toMs: Date.parse('2026-09-02T11:00:00Z') });
  assert.deepEqual(s.map((p) => [p.rainMm, p.feed]), [[0.4, 'ea-hydrology'], [0.6, 'ea-flood-monitoring']]);
  assert.equal(s.length, 2, 'the 10:30 and 10:45 slots are absent, not zero');
});

test('EA live sync: stores, records success and lag; an empty answer counts as a failed run for freshness', async () => {
  const f = fakeFetch(() => ({ body: { items: [FM_ITEM, { ...FM_ITEM, dateTime: '2026-10-07T11:45:00Z', value: 0.2 }] } }));
  const r = await ea.syncLive({ nowMs: NOW, fetchImpl: f, sleep: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.stored, 2);
  assert.match(f.calls[0], /since=2026-09-0\dT/);
  const st = ext.syncState('ea:3641', 'ea-flood-monitoring');
  assert.equal(st.lastObservedAt, Date.parse('2026-10-07T12:00:00Z'));
  assert.equal(ext.judge(st, NOW).state, 'ok');
  // the second pass asks only from six hours before what it holds
  const f2 = fakeFetch(() => ({ body: { items: [] } }));
  await ea.syncLive({ nowMs: NOW + 900000, fetchImpl: f2, sleep: noSleep });
  assert.match(f2.calls[0], /since=2026-10-07T06:00:00Z/);
});

test('EA live sync: a 5xx is retried in-call, then recorded with backoff; a 4xx is not retried', async () => {
  const f = fakeFetch(() => ({ status: 503, body: {} }));
  const r = await ea.syncLive({ nowMs: NOW + 2000000, fetchImpl: f, sleep: noSleep, force: true });
  assert.equal(r.ok, false);
  assert.equal(f.calls.length, 3);
  assert.equal(r.consecutiveFailures, 1);
  const skipped = await ea.syncLive({ nowMs: NOW + 2000001, fetchImpl: f, sleep: noSleep });
  assert.equal(skipped.skipped, 'backing-off');
  assert.equal(f.calls.length, 3, 'nothing was fetched while backing off');
  assert.equal(ext.judge(ext.syncState('ea:3641', 'ea-flood-monitoring'), NOW + 2000001).state, 'backing-off');

  const f4 = fakeFetch(() => ({ status: 404, body: {} }));
  await ea.syncLive({ nowMs: NOW + 3000000, fetchImpl: f4, sleep: noSleep, force: true });
  assert.equal(f4.calls.length, 1);
  // and a success clears it
  await ea.syncLive({ nowMs: NOW + 4000000, fetchImpl: fakeFetch(() => ({ body: { items: [FM_ITEM] } })), sleep: noSleep, force: true });
  assert.equal(ext.syncState('ea:3641', 'ea-flood-monitoring').consecutiveFailures, 0);
});

test('backfill is resumable: it persists the cursor per chunk and stops cleanly on a failure', async () => {
  process.env.WEATHER_EA_15MIN_FROM = '2026-04-01';
  process.env.WEATHER_EA_DAILY_FROM = '2025-01-01';
  // The oldest chunk keeps failing past the in-call retries.
  const f = fakeFetch((url) => {
    const m = url.match(/mineq-date=(\d{4}-\d\d-\d\d)/);
    if (m[1] === '2026-04-01') return { status: 500, body: {} };
    return { body: { items: [{ ...HY_15, dateTime: `${m[1]}T00:00:00`, value: 0.2 }] } };
  });
  const r1 = await ea.backfillStep({ nowMs: NOW, maxChunks: 5, periods: [900], fetchImpl: f, sleep: noSleep });
  assert.equal(r1[900].complete, false);
  const cursorAfterFail = r1[900].cursor;
  assert.ok(r1[900].errors >= 1);
  const r2 = await ea.backfillStep({ nowMs: NOW, maxChunks: 50, periods: [900], fetchImpl: fakeFetch((url) => ({ body: { items: [] } })), sleep: noSleep });
  assert.equal(r2[900].complete, true);
  assert.equal(r2[900].cursor, '2026-04-01');
  assert.ok(cursorAfterFail > '2026-04-01');
  delete process.env.WEATHER_EA_15MIN_FROM; delete process.env.WEATHER_EA_DAILY_FROM;
});

test('qualified recent sync reads month chunks of 15-min plus the daily series', async () => {
  const f = fakeFetch(() => ({ body: { items: [] } }));
  const r = await ea.syncQualifiedRecent({ nowMs: NOW, fetchImpl: f, sleep: noSleep, force: true });
  assert.equal(r.ok, true);
  assert.ok(f.calls.some((u) => u.includes('-t-86400-')));
  assert.ok(f.calls.filter((u) => u.includes('-t-900-')).length >= 4);
  assert.ok(f.calls.every((u) => u.includes('mineq-date=')), 'inclusive lower bound — min-date drops a day');
});

test('WU import: a 204 station is offline, not an error; the key never reaches a stored error', async () => {
  const env = { WU_API_KEY: 'topsecretkey', WU_IMPORT_STATIONS: 'ICOALV53,ICOALV50' };
  const f = fakeFetch((url) => (url.includes('ICOALV50') ? { status: 204, body: null } : { body: { observations: [WU_CURRENT] } }));
  const r = await wu.syncImport({ nowMs: NOW + 120000, env, fetchImpl: f, sleep: noSleep });
  assert.equal(r.results.find((x) => x.station === 'ICOALV50').offline, true);
  assert.equal(r.results.find((x) => x.station === 'ICOALV53').stored, 1);
  const bad = fakeFetch(() => ({ status: 401, body: {} }));
  await wu.syncImport({ nowMs: NOW + 240000, env: { ...env, WU_IMPORT_STATIONS: 'ICOALV19' }, fetchImpl: bad, sleep: noSleep });
  const st = ext.syncState('wu:ICOALV19', 'wu-pws-v2');
  assert.equal(st.lastError, 'HTTP 401');
  assert.ok(!JSON.stringify(ext.health(NOW)).includes('topsecretkey'));
});

test('WU publish: only a "success" body is an acceptance, and the key is redacted from any echo', async () => {
  const env = { WU_STATION_ID: 'ICOALV59', WU_STATION_KEY: 'k3y' };
  const ok = await wu.publish({ observedAt: NOW, temperatureC: 10 }, {}, { env, fetchImpl: fakeFetch(() => ({ text: 'success\n' })) });
  assert.equal(ok.ok, true);
  const no = await wu.publish({ observedAt: NOW, temperatureC: 10 }, {}, { env, fetchImpl: fakeFetch(() => ({ text: 'INVALIDPASSWORDID|Password or key and/or id are incorrect k3y' })) });
  assert.equal(no.ok, false, 'a 200 that does not say success is a refusal');
  assert.ok(!no.body.includes('k3y'));
  assert.equal((await wu.publish({ observedAt: NOW }, {}, { env: {} })).blocked, 'WU_STATION_KEY is not set');
});

test('publishLatest is a no-op while publishing is off or the hardware has never reported', async () => {
  assert.match((await wu.publishLatest({ env: {} })).blocked, /WU_PUBLISH_ENABLED/);
  const r = await wu.publishLatest({ env: { WU_PUBLISH_ENABLED: 'true', WU_STATION_KEY: 'x' } });
  assert.match(r.blocked, /never reported/);
});

test('every registry agrees: the publisher is a declared external writer with a matrix row', () => {
  const writers = require('./external-writes').WRITERS;
  assert.ok(writers['wunderground.publish']);
  const src = require('./native-sources');
  assert.equal(src.describe('weather.ea-3641').expected, true);
  assert.equal(src.describe('weather.ea-3641-qualified').expected, false);
});

test('a key pasted in Settings is stored, used by the import, and an .env key still wins', async () => {
  const K = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  assert.equal(wu.setStoredKey('short').ok, false, 'a malformed key is refused, not stored');
  assert.equal(wu.credentialSource({}), null);
  assert.equal(wu.setStoredKey(K).ok, true);
  assert.equal(wu.credentialSource({}), 'stored');
  assert.equal(wu.importBlocked({}), null);
  const f = fakeFetch(() => ({ body: { observations: [WU_CURRENT] } }));
  await wu.syncImport({ nowMs: NOW + 900000, env: { WU_IMPORT_STATIONS: 'ICOALV53' }, fetchImpl: f, sleep: noSleep });
  assert.ok(f.calls[0].includes(`apiKey=${K}`), 'the stored key is the one sent');
  assert.equal(wu.credentialSource({ WU_API_KEY: 'envkey' }), 'env');
  assert.equal(wu.apiKey({ WU_API_KEY: 'envkey' }), 'envkey');
  assert.deepEqual(wu.clearStoredKey({}), { ok: true, stillInEnv: false });
  assert.equal(wu.credentialSource({}), null);
});

test('no weather route ever returns the stored key', async () => {
  const express = require('express');
  const http = require('http');
  const app = express(); app.use(express.json()); app.use('/api/weather', require('../routes/weather'));
  const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api/weather`;
  const K = 'f0e1d2c3b4a5968778695a4b3c2d1e0f';
  try {
    const bad = await fetch(base + '/wu/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'nope' }) });
    assert.equal(bad.status, 400);
    const ok = await fetch(base + '/wu/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: K }) });
    const okText = await ok.text();
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(okText).credentialSource, process.env.WU_API_KEY ? 'env' : 'stored');
    const src = await (await fetch(base + '/sources')).text();
    for (const body of [okText, src]) {
      assert.ok(!body.includes(K) && !body.includes(K.slice(0, 8)), 'neither the key nor a prefix of it is returned');
    }
    assert.equal(JSON.parse(src).wu.credentialSource, 'stored');
    const del = await (await fetch(base + '/wu/key', { method: 'DELETE' })).json();
    assert.equal(del.credentialSource, null);
  } finally { server.close(); }
});

test('nearby(): each configured neighbour with its latest reading and name; offline listed, not dropped', () => {
  const n = wu.nearby(NOW + 300000, { WU_IMPORT_STATIONS: 'ICOALV53,ICOALV50,ICOALV99' });
  const by = Object.fromEntries(n.map((x) => [x.station, x]));
  assert.equal(by.ICOALV53.name, 'Whitwick');
  assert.equal(by.ICOALV53.latest.temperatureC, 10.8);
  assert.equal(by.ICOALV53.latest.rainTodayMm, 5.84);
  assert.equal(by.ICOALV50.latest, null);
  assert.equal(by.ICOALV50.offline, true);
  assert.equal(by.ICOALV99.latest, null, 'a configured station never imported is listed, not dropped');
  assert.equal(by.ICOALV53.latest.stale, false);
  assert.equal(wu.nearby(NOW + 3 * 3600000, { WU_IMPORT_STATIONS: 'ICOALV53' })[0].latest.stale, true);
});
