'use strict';

/** The logger's wire contract and the window join, without a database. */

const test = require('node:test');
const assert = require('node:assert/strict');
const env = require('./environment');

const NOW = 1_790_000_000;
const r = (t, tempC, humidityPct = 60, pressureHpa = 1000, timingErrorSeconds = 150) =>
  ({ t, tempC, humidityPct, pressureHpa, timingErrorSeconds });

test('a millisecond timestamp is refused by name', () => {
  const v = env.validateReading(r(NOW * 1000, 10), NOW);
  assert.equal(v.ok, false);
  assert.match(v.reason, /milliseconds/);
});

test('values outside the sensor range are a decoding fault, refused', () => {
  assert.equal(env.validateReading(r(NOW, 650), NOW).ok, false);
  assert.equal(env.validateReading(r(NOW, 10, 140), NOW).ok, false);
  assert.equal(env.validateReading(r(NOW, 10, 50, 10132), NOW).ok, false);
});

test('a temperature-only reading is valid — absent is not out of range', () => {
  const v = env.validateReading({ t: NOW, tempC: -3.5 }, NOW);
  assert.equal(v.ok, true);
  assert.equal(v.reading.humidityPct, null);
});

test('one bad reading does not fail the batch, and is named', () => {
  const v = env.validateBatch({ sensorId: 'DDCCBBAA', readings: [r(NOW, 10), r(NOW + 9999, 10)] }, NOW);
  assert.equal(v.ok, true);
  assert.equal(v.accepted.length, 1);
  assert.deepEqual(v.rejectedReasons, { 't is in the future': 1 });
});

test('dew point matches Magnus-Tetens', () => {
  assert.ok(Math.abs(env.dewPoint(20, 50) - 9.26) < 0.05);
  assert.equal(env.dewPoint(20, null), null);
});

test('barometric ascent ignores noise on the flat', () => {
  // ±0.2 hPa jitter is under 2 m — no climb.
  assert.equal(env.baroAscent([1000, 1000.2, 999.8, 1000.1, 999.9]), 0);
  // 1000 → 988 hPa is roughly 100 m up.
  const up = env.baroAscent([1000, 997, 994, 991, 988]);
  assert.ok(up > 90 && up < 110, `got ${up}`);
});

test('readings match a workout by window, not padded by timing error', () => {
  const workouts = [{
    id: 1, source_uuid: 'W1', activity_type: 'Hiking',
    started_at: '2026-09-21 09:00:00', ended_at: '2026-09-21 11:00:00', duration_seconds: 7200,
  }];
  const start = Date.parse('2026-09-21T09:00:00Z') / 1000;
  const readings = [
    { t: start - 300, temperature_c: 20, humidity_pct: 50, pressure_hpa: 1000, timing_error_s: 150 }, // in the car
    { t: start + 600, temperature_c: 11, humidity_pct: 80, pressure_hpa: 1000, timing_error_s: 150 },
    { t: start + 3600, temperature_c: 13, humidity_pct: 70, pressure_hpa: 990, timing_error_s: 150 },
  ];
  const [h] = env.matchWorkouts(workouts, readings);
  assert.equal(h.id, 'W1');
  assert.equal(h.conditions.readings, 2);
  assert.equal(h.conditions.tempMinC, 11);
  assert.equal(h.conditions.tempMaxC, 13);
  assert.equal(h.conditions.timingErrorSeconds, 150);
});

test('a walk with no readings says why, instead of an empty summary', () => {
  const [h] = env.matchWorkouts([{
    id: 2, activity_type: 'Walking', started_at: '2026-09-21 09:00:00', ended_at: '2026-09-21 10:00:00',
  }], []);
  assert.equal(h.conditions, null);
  assert.match(h.why, /no logger readings/);
});

test('a missing end falls back to duration', () => {
  const w = env.workoutWindow({ started_at: '2026-09-21 09:00:00', duration_seconds: 600 });
  assert.equal(w.end - w.start, 600);
});

test('dedupe tolerance never reaches the next record', () => {
  assert.equal(env.dedupeToleranceSeconds(900), 30);
  assert.equal(env.dedupeToleranceSeconds(60), 30);
  assert.equal(env.dedupeToleranceSeconds(20), 10);
  assert.equal(env.dedupeToleranceSeconds(1), 0);
  assert.equal(env.dedupeToleranceSeconds(null), 0);
});

const rd = (t, temperature_c, humidity_pct = 60, pressure_hpa = 1000) => ({ t, temperature_c, humidity_pct, pressure_hpa });

test('a logger left on the shelf is NOT carried — the room does not become the weather', () => {
  const before = [rd(0, 21.3), rd(900, 21.4), rd(1800, 21.3)];
  const inside = [rd(3600, 21.4), rd(4500, 21.5), rd(5400, 21.4)];
  assert.equal(env.carriedVerdict(inside, before, {}).carried, 'unknown');
  // And a watch that climbed 300 m against flat pressure is positively not carried.
  assert.equal(env.carriedVerdict(inside, before, { elevation_m: 300 }).carried, 'not-carried');
});

test('leaving the house shows in the air', () => {
  const before = [rd(0, 21.3), rd(900, 21.4)];
  const inside = [rd(3600, 12.1, 85), rd(4500, 11.8, 88)];
  const v = env.carriedVerdict(inside, before, {});
  assert.equal(v.carried, 'likely');
  assert.match(v.why, /away from the house/);
});

test('a climb the pressure agrees with is carried', () => {
  const inside = [rd(0, 20, 60, 1000), rd(900, 20, 60, 994), rd(1800, 20, 60, 988)];
  assert.equal(env.carriedVerdict(inside, [], { elevation_m: 120 }).carried, 'likely');
});

test('one reading is not enough to say', () => {
  assert.equal(env.carriedVerdict([rd(0, 10)], [], {}).carried, 'unknown');
});
