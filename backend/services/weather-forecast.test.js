'use strict';

/** Provider shaping, the standing-forecast rule and bucket alignment — pure. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const f = require('./weather-forecast');

const H = 3600000;
const T0 = Date.parse('2026-10-06T12:00:00Z');

test('Open-Meteo hourly arrays become points, units untouched, missing measures null', () => {
  const pts = f.shapeOpenMeteo({ hourly: {
    time: [T0 / 1000, T0 / 1000 + 3600],
    temperature_2m: [16.1, 15.4], relative_humidity_2m: [84, 86], surface_pressure: [999.2, null],
    precipitation: [0, 0.4], precipitation_probability: [10, 55],
  } });
  assert.equal(pts.length, 2);
  assert.deepEqual(pts[1], { validAt: T0 + H, temperatureC: 15.4, humidityPct: 86, pressureHpa: null, precipMm: 0.4, precipProb: 55 });
});

test('an Open-Meteo answer with no hourly block is an error, not an empty forecast', () => {
  assert.throws(() => f.shapeOpenMeteo({}), /no hourly/);
});

test('⚠ the Home Assistant shape (live sample) leaves pressure NULL — it has none', () => {
  const pts = f.shapeHomeAssistant([{ condition: 'partlycloudy', datetime: '2026-10-06T19:00:00+00:00', temperature: 16.1, precipitation: 0.0, humidity: 84 }]);
  assert.equal(pts[0].validAt, Date.parse('2026-10-06T19:00:00Z'));
  assert.equal(pts[0].pressureHpa, null);
  assert.equal(pts[0].temperatureC, 16.1);
});

// ── Standing forecast ───────────────────────────────────────────────────────

const row = (issued, valid, temp) => ({ issued_at: issued, valid_at: valid, temperature_c: temp, humidity_pct: null, pressure_hpa: null, precip_mm: null, precip_prob: null });

test('⚠ a PAST hour shows the forecast standing at that hour, not one issued afterwards', () => {
  const now = T0 + 10 * H;
  const pts = f.pickStanding([
    row(T0 - 6 * H, T0 + 2 * H, 10),   // issued long before
    row(T0 + 1 * H, T0 + 2 * H, 12),   // newest standing at T0+2
    row(T0 + 5 * H, T0 + 2 * H, 99),   // issued AFTER the hour — an analysis, excluded
  ], now);
  assert.equal(pts.length, 1);
  assert.equal(pts[0].temperatureC, 12);
});

test('a past hour with only after-the-fact issues has no forecast at all', () => {
  assert.equal(f.pickStanding([row(T0 + 5 * H, T0 + 2 * H, 99)], T0 + 10 * H).length, 0);
});

test('a FUTURE hour takes the newest forecast', () => {
  const pts = f.pickStanding([row(T0, T0 + 5 * H, 10), row(T0 + H, T0 + 5 * H, 11)], T0 + 2 * H);
  assert.equal(pts[0].temperatureC, 11);
});

// ── Alignment ───────────────────────────────────────────────────────────────

const plan = (fromMs, bucketMs, n) => ({ bucketMs, starts: Array.from({ length: n }, (_, i) => fromMs + i * bucketMs) });
const pt = (validAt, temperatureC, pressureHpa = null) => ({ validAt, temperatureC, humidityPct: null, pressureHpa });

test('short buckets interpolate at their midpoint between hourly points', () => {
  const out = f.alignToBuckets([pt(T0, 10, 1000), pt(T0 + H, 12, 1002)], plan(T0, 5 * 60000, 12));
  // midpoint of the first 5-min bucket is 2.5 min in: 10 + 2 * 2.5/60
  assert.equal(out[0].temperatureC, 10.08);
  assert.equal(out[5].temperatureC, 10.92);
  assert.equal(out[5].pressureHpa, 1000.92);
  assert.equal(out[0].humidityPct, null, 'a measure the provider did not supply stays null');
});

test('⚠ a gap of more than two hours between points is drawn as a gap, not a line', () => {
  const out = f.alignToBuckets([pt(T0, 10), pt(T0 + 4 * H, 14)], plan(T0, 30 * 60000, 8));
  assert.ok(out.slice(1, 7).every((r) => r.temperatureC === null));
});

test('long buckets average the points inside them', () => {
  const out = f.alignToBuckets([pt(T0, 10), pt(T0 + H, 12), pt(T0 + 2 * H, 14), pt(T0 + 3 * H, 30)], plan(T0, 3 * H, 2));
  assert.equal(out[0].temperatureC, 12);
  assert.equal(out[1].temperatureC, 30);
});

test('no points → every bucket null, never zero', () => {
  assert.ok(f.alignToBuckets([], plan(T0, H, 5)).every((r) => r.temperatureC === null && r.pressureHpa === null));
});
