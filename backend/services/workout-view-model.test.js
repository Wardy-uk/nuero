'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('./workout-view-model');
const { shapeWeather } = require('./workout-view');

const T0 = 1793612525;
const line = (n, { dLat = 0.0001, ele = () => 100, t = (i) => T0 + i * 10, lon = -1.3 } = {}) =>
  Array.from({ length: n }, (_, i) => [52.68 + i * dLat, lon, ele(i), t(i)]);

test('a GPS jump is not distance', () => {
  const pts = line(50);
  pts[25] = [53.5, -1.3, 100, pts[25][3]]; // 90 km away for ten seconds
  const r = m.measure(pts);
  assert.ok(r.stats.distanceM < 600, `distance ${r.stats.distanceM}`);
  assert.ok(r.stats.gpsJumpsIgnored >= 1);
});

test('standing still is not moving time', () => {
  const pts = [...line(30), ...line(30, { dLat: 0, t: (i) => T0 + 300 + i * 30 }).map((p) => [52.68 + 29 * 0.0001, p[1], p[2], p[3]])];
  const r = m.measure(pts);
  assert.ok(r.stats.movingSeconds < r.stats.totalSeconds - 600, `moving ${r.stats.movingSeconds} of ${r.stats.totalSeconds}`);
});

test('elevation jitter under the threshold is not climbing', () => {
  const r = m.measure(line(200, { ele: (i) => 100 + (i % 2) }));
  assert.equal(r.stats.ascentM, 0);
});

test('the same route walked twice matches; a different one does not', () => {
  const a = m.measure(line(200));
  const b = m.measure(line(200, { t: (i) => T0 + 86400 * 7 + i * 12 }));
  const c = m.measure(line(200, { lon: -1.0 }));
  assert.equal(m.sameRoute(a, b).same, true);
  assert.equal(m.sameRoute(a, c).same, false);
});

test('a photo without GPS is pinned to where the track was when it was taken; outside the walk it is not pinned', () => {
  const r = m.measure(line(100));
  const p = m.placePhoto({ takenT: T0 + 500 }, r);
  assert.equal(p.placedBy, 'time');
  assert.ok(Math.abs(p.lat - (52.68 + 50 * 0.0001)) < 1e-4);
  assert.equal(m.placePhoto({ takenT: T0 + 86400 }, r).placedBy, 'none');
  assert.equal(m.placePhoto({ lat: 52.1, lon: -1.1, takenT: T0 }, r).placedBy, 'gps');
});

test('heart-rate bands are weighted by time, not by how often the watch sampled', () => {
  const samples = [{ t: 0, bpm: 100 }, ...Array.from({ length: 60 }, (_, i) => ({ t: 600 + i, bpm: 150 }))];
  const hr = m.heartRate(samples, { startT: 0, endT: 660, max: 160 });
  const under60 = hr.bands.rows[0].minutes; // the 60% line is 96 bpm, so 100 is in 60–70%
  const band6070 = hr.bands.rows[1].minutes;
  assert.equal(under60, 0);
  assert.ok(band6070 >= 1.9 && band6070 <= 2.1, `the 100 bpm reading stands for 2 min (capped), got ${band6070}`);
  assert.equal(hr.max, 150);
});

test('the weather is the hours the walk covered, in London time', () => {
  const json = {
    hourly: {
      time: ['2026-11-02T08:00', '2026-11-02T09:00', '2026-11-02T10:00', '2026-11-02T11:00', '2026-11-02T12:00'],
      temperature_2m: [5, 6, 8, 9, 10], apparent_temperature: [2, 3, 5, 6, 7], relative_humidity_2m: [90, 85, 80, 75, 70],
      precipitation: [0, 0, 0.4, 0.2, 0], weather_code: [3, 3, 61, 3, 2], cloud_cover: [100, 100, 90, 80, 50],
      wind_speed_10m: [8, 9, 12, 14, 10], wind_gusts_10m: [15, 18, 25, 30, 20], wind_direction_10m: [220, 225, 230, 240, 250],
    },
    daily: { time: ['2026-11-02'], sunrise: ['2026-11-02T07:00'], sunset: ['2026-11-02T16:30'] },
  };
  const w = shapeWeather(json, { startLocal: '2026-11-02 09:42', endLocal: '2026-11-02 11:43', lat: 52.68, lon: -1.3 });
  assert.deepEqual(w.hours.map((h) => h.at), ['09:00', '10:00', '11:00']);
  assert.equal(w.summary.words, 'Light rain');
  assert.equal(w.summary.rainMm, 0.6);
  assert.equal(w.summary.gustMaxMph, 30);
  assert.deepEqual(w.sun, { sunrise: '07:00', sunset: '16:30' });
});
