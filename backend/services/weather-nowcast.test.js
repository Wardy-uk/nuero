'use strict';

/**
 * The local nowcast: geometry, rain detection, the ring's wind, upwind rain and
 * its window, the pressure consensus — and, against a scratch SQLite, that every
 * rain call is recorded once, scored hit / miss / unknown honestly, that rain
 * starting at home is recorded predicted or not, and that retention summarises
 * before it deletes. Home here is an invented point, not anyone's house.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-nowcast-')), 'a.db');
process.env.WU_IMPORT_STATIONS = 'IWEST1,IWEST2,IEAST1,INEAR1,INORTH1,ISOUTH1';

const db = require('../db/database');
const nc = require('./weather-nowcast');
const ext = require('./weather-external');

test.before(async () => { await db.init(); });

const HOME = { lat: 52.0, lon: -1.0 };
const MIN = 60000;
const NOW = Date.parse('2026-10-07T15:00:00Z');
const offset = (mi, bearing) => {
  const km = mi * 1.609344, b = (bearing * Math.PI) / 180;
  return { lat: HOME.lat + (km * Math.cos(b)) / 111.32, lon: HOME.lon + (km * Math.sin(b)) / (111.32 * Math.cos((HOME.lat * Math.PI) / 180)) };
};

// ── pure ─────────────────────────────────────────────────────────────────────

test('geometry: distance, bearing and sector', () => {
  const p = offset(3, 90);
  const g = nc.geo(HOME, p.lat, p.lon);
  assert.ok(Math.abs(g.mi - 3) < 0.02);
  assert.ok(Math.abs(g.bearing - 90) < 0.5);
  assert.equal(nc.sector(44), 'N'); assert.equal(nc.sector(46), 'E'); assert.equal(nc.sector(320), 'N'); assert.equal(nc.sector(220), 'S'); assert.equal(nc.sector(230), 'W');
  assert.equal(nc.ring(2), 'near'); assert.equal(nc.ring(5), 'far');
  assert.equal(nc.angleDiff(350, 10), 20);
});

test('a station is raining on a rate, or on its since-midnight total rising — which resets at midnight', () => {
  const r = (mins, rate, acc) => ({ t: NOW - mins * MIN, rainRateMmH: rate, rainAccumMm: acc });
  assert.equal(nc.stationRaining([r(40, 0, 2), r(5, 0.8, 2.1)], NOW), true, 'a rate');
  assert.equal(nc.stationRaining([r(40, 0, 2), r(5, 0, 2.6)], NOW), true, 'the total rose 0.6 mm');
  assert.equal(nc.stationRaining([r(40, 0, 7.2), r(5, 0, 0.4)], NOW), true, 'after midnight the new total IS the rain since');
  assert.equal(nc.stationRaining([r(40, 0, 2), r(5, 0, 2)], NOW), false, 'dry is a reading, not an absence');
  assert.equal(nc.stationRaining([r(90, 0, 2)], NOW), null, 'a station that went quiet is not a dry one');
});

test('the ring wind is a vector mean (350° and 10° make north, not south) and refuses a muddle', () => {
  const s = (dir, ms) => ({ latest: { windDirectionDeg: dir, windMs: ms } });
  const w = nc.ringWind([s(350, 3), s(10, 3), s(0, 3)]);
  assert.ok(w.fromDeg <= 5 || w.fromDeg >= 355);
  assert.equal(w.trusted, true);
  assert.equal(nc.ringWind([s(0, 3), s(180, 3)]), null, 'too few stations');
  assert.equal(nc.ringWind([s(0, 3), s(120, 3), s(240, 3)]).trusted, false, 'three directions cancelling is not a wind');
});

function station(id, mi, bearing, raining) {
  return { id, geo: { mi, bearing }, raining };
}
const WEST_WIND = { fromDeg: 270, speedMs: 4, stations: 6, steadiness: 0.9, trusted: true };

test('rain arriving: upwind and wet gives a WINDOW; downwind rain, home rain and a muddled wind do not', () => {
  const a = nc.rainArrival({ stations: [station('W1', 3, 265, true), station('E1', 3, 90, false)], wind: WEST_WIND, homeRaining: false });
  assert.equal(a.state, 'rain-likely');
  assert.deepEqual(a.raining, ['W1']);
  assert.ok(a.etaMin[0] < a.etaMin[1], 'a range, never a minute');
  assert.equal(a.confidence, 'low', 'one wet station is a low-confidence call');
  assert.equal(nc.rainArrival({ stations: [station('E1', 3, 90, true), station('W1', 3, 270, false)], wind: WEST_WIND, homeRaining: false }).state, 'dry-upwind', 'rain downwind has gone');
  assert.equal(nc.rainArrival({ stations: [station('W1', 3, 270, true)], wind: WEST_WIND, homeRaining: true }).state, 'raining-here');
  assert.equal(nc.rainArrival({ stations: [station('W1', 3, 270, true)], wind: { ...WEST_WIND, trusted: false }, homeRaining: false }).state, 'no-wind');
  // calm: floored at 2 m/s, so 3 miles is not "in three hours"
  const calm = nc.rainArrival({ stations: [station('W1', 3, 270, true), station('W2', 5, 280, true)], wind: { ...WEST_WIND, speedMs: 0.5 }, homeRaining: false });
  assert.ok(calm.etaMin[1] <= 45, `got ${calm.etaMin}`);
  assert.equal(calm.confidence, 'moderate');
});

test('pressure consensus: the median change across the ring, and how many agree; too few is unknown', () => {
  const c = nc.pressureConsensus([-2.1, -1.8, -2.5, -1.2, -2.0, 0.3]);
  assert.equal(c.known, true);
  assert.equal(c.word, 'falling slowly');
  assert.equal(c.agree, 5);
  assert.equal(nc.pressureConsensus([-2, -2, null, -2]).known, false);
  // A station's offset cancels: only its own change counts.
  const rd = [{ t: NOW - 180 * MIN, pressureHpa: 1030 }, { t: NOW - 5 * MIN, pressureHpa: 1028 }];
  assert.ok(Math.abs(nc.stationTendency(rd, NOW) - (-2 * 180 / 175)) < 0.01);
  assert.equal(nc.stationTendency([{ t: NOW - 60 * MIN, pressureHpa: 1 }, { t: NOW - 5 * MIN, pressureHpa: 2 }], NOW), null, 'under two hours says nothing');
});

// ── the pass, against SQLite ────────────────────────────────────────────────

function wuRow(id, at, pos, f) {
  return {
    source_id: `wu:${id}`, source_type: 'wu-pws', feed: 'wu-pws-v2', observed_at: at, period_s: 0, received_at: at,
    temperature_c: 12, humidity_pct: 80, pressure_hpa: f.p ?? 1010, wind_ms: f.wind ?? 4, gust_ms: 6, wind_direction_deg: f.dir ?? 270,
    rain_rate_mm_h: f.rate ?? 0, rain_accum_mm: f.acc ?? 0, lat: pos.lat, lon: pos.lon,
    qc_status: 'good', raw_payload: { stationID: id, neighborhood: id }, provenance: { test: true },
  };
}
function seed(at, wet = {}) {
  const pos = {
    IWEST1: offset(3, 268), IWEST2: offset(5, 275), IEAST1: offset(3, 90), INEAR1: offset(0.5, 10), INORTH1: offset(2, 0), ISOUTH1: offset(2, 180),
  };
  const rows = [];
  for (const [id, p] of Object.entries(pos)) {
    for (const back of [190, 60, 20, 5]) {
      const w = wet[id] && back <= 20;
      rows.push(wuRow(id, at - back * MIN, p, { rate: w ? 1.2 : 0, acc: w ? 1 : 0, p: 1012 - (190 - back) * 0.01 }));
    }
  }
  assert.equal(ext.upsert(rows, { nowMs: at }).rejected, 0);
}
const eaRain = (at, mm) => ext.upsert([{ source_id: 'ea:3641', source_type: 'ea-raingauge', feed: 'ea-flood-monitoring', observed_at: at, period_s: 900,
  received_at: at, rain_mm: mm, qc_status: 'provisional', raw_payload: { v: mm }, provenance: 'test' }], { nowMs: at + MIN });

test('a pass records ONE rain call while upwind is wet, then scores it a hit when rain reaches home', async () => {
  seed(NOW, { IWEST1: true, IWEST2: true });
  eaRain(NOW - 30 * MIN, 0); eaRain(NOW - 15 * MIN, 0);
  const r = await nc.pass({ nowMs: NOW, home: HOME });
  assert.equal(r.arrival.state, 'rain-likely');
  assert.ok(r.recorded > 0, 'the call is a row before it is a sentence');
  const again = await nc.pass({ nowMs: NOW + 20 * MIN, home: HOME });
  assert.equal(again.recorded, null, 'one open call, not one per pass');
  // Rain reaches the gauge inside the window.
  eaRain(NOW + 30 * MIN, 0.4);
  const p = db.get('SELECT * FROM weather_nowcast_predictions WHERE id = ?', [r.recorded]);
  nc.resolveDue(p.valid_to + MIN, []);
  assert.equal(db.get('SELECT status FROM weather_nowcast_predictions WHERE id = ?', [r.recorded]).status, 'hit');
  assert.equal(nc.record().hits, 1);
});

test('a call whose window passes dry is a MISS; with no readings at all it is UNKNOWN, never a miss', () => {
  const t0 = NOW + 10 * 3600000;
  const ins = (from, to) => Number(db.run(`INSERT INTO weather_nowcast_predictions (kind, made_at, valid_from, valid_to, claim) VALUES ('rain-arrival', ?, ?, ?, '{}')`, [from, from, to]).lastInsertRowid);
  eaRain(t0 + 15 * MIN, 0); eaRain(t0 + 30 * MIN, 0);
  const dry = ins(t0, t0 + 45 * MIN);
  const blind = ins(t0 + 5 * 3600000, t0 + 6 * 3600000);
  nc.resolveDue(t0 + 7 * 3600000, []);
  assert.equal(db.get('SELECT status FROM weather_nowcast_predictions WHERE id = ?', [dry]).status, 'miss');
  assert.equal(db.get('SELECT status FROM weather_nowcast_predictions WHERE id = ?', [blind]).status, 'unknown');
});

test('rain starting at home is recorded even when nobody predicted it', async () => {
  const t = NOW + 24 * 3600000;
  db.setState('weather_nowcast_home', JSON.stringify({ raining: false, at: t - 20 * MIN }));
  seed(t, {});
  eaRain(t - 15 * MIN, 1.0);
  const before = nc.record();
  await nc.pass({ nowMs: t, home: HOME });
  const after = nc.record();
  assert.equal(after.onsets, before.onsets + 1);
  assert.equal(after.onsetsPredicted, before.onsetsPredicted, 'unpredicted rain counts against the record');
});

test('no home location: no geometry and no rain call — said, not guessed', async () => {
  const r = await nc.pass({ nowMs: NOW + 48 * 3600000, home: null });
  assert.equal(r.arrival.state, 'no-home');
  assert.equal(r.recorded, null);
});

test('retention summarises a day before deleting its raw readings, and never touches today or the EA gauge', () => {
  const now = Date.parse('2026-12-15T12:00:00Z');
  const old = Date.parse('2026-11-10T12:00:00Z');
  const pos = offset(2, 0);
  ext.upsert([wuRow('INORTH1', old, pos, { acc: 3 }), wuRow('INORTH1', old + 3600000, pos, { acc: 4 }), wuRow('INORTH1', now - 3600000, pos, {})], { nowMs: now });
  eaRain(old, 1.5);
  // Summaries are made inside the retention window, so run once while the old day is still in it.
  nc.retain({ nowMs: old + 2 * 86400000 });
  const day = db.get("SELECT * FROM weather_station_daily WHERE source_id = 'wu:INORTH1' AND day = '2026-11-10'");
  assert.equal(day.n, 2);
  assert.equal(day.rain_mm, 4);
  const r = nc.retain({ nowMs: now });
  assert.ok(r.deleted >= 2);
  assert.equal(db.get("SELECT COUNT(*) n FROM external_weather_observations WHERE source_id = 'wu:INORTH1' AND observed_at = ?", [old]).n, 0);
  assert.equal(db.get("SELECT COUNT(*) n FROM external_weather_observations WHERE source_id = 'wu:INORTH1' AND observed_at = ?", [now - 3600000]).n, 1, 'recent raw kept');
  assert.equal(db.get("SELECT COUNT(*) n FROM external_weather_observations WHERE source_id = 'ea:3641' AND observed_at = ?", [old]).n, 1, 'EA is never deleted');
  assert.ok(!db.get("SELECT 1 FROM weather_station_daily WHERE day = '2026-12-15'"), 'today is not summarised');
});

test("each station in the nowcast carries the server's elevation judgement", async () => {
  db.setState('wu_ground_elevation', JSON.stringify({ IWEST1: { m: 200 } }));
  const t = NOW + 72 * 3600000;
  seed(t, {});
  const r = nc.build({ home: HOME, nowMs: t });
  const w = r.stations.find((s) => s.id === 'IWEST1');
  assert.equal(w.elevation.groundM, 200);
  assert.equal(typeof w.elevation.mismatch, 'boolean');
});

test('the real route resolves home through weather-forecast.location() — and never returns the coordinates', async () => {
  // ⚠ Every other test hands the pass a home; the route asks the real lookup,
  //   which shipped unexported and 500'd on the first live call (7 Oct 2026).
  assert.equal(typeof require('./weather-forecast').location, 'function');
  process.env.WEATHER_LAT = String(HOME.lat); process.env.WEATHER_LON = String(HOME.lon);
  const express = require('express'); const http = require('http');
  const app = express(); app.use(express.json()); app.use('/api/weather', require('../routes/weather'));
  const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/weather/nowcast`);
    const text = await res.text();
    assert.equal(res.status, 200, text.slice(0, 200));
    const j = JSON.parse(text);
    assert.equal(j.homeKnown, true);
    assert.ok(j.stations.some((s) => s.geo), 'stations placed relative to home');
    // Home's own coordinates are not in the payload. (Stations' public positions
    // plus their distance and bearing would let anyone holding this PIN-gated
    // payload work home out — accepted, and not claimed otherwise.)
    assert.ok(!('lat' in j.home) && !('lon' in j.home) && !('lat' in j) && !('location' in j), 'no home coordinates in the payload');
  } finally { server.close(); delete process.env.WEATHER_LAT; delete process.env.WEATHER_LON; }
});
