'use strict';

/**
 * "Is it going to rain in 30 minutes?"
 *
 * Pure, so what is under test is the product: which of the next few hours is
 * worth a word, and — the expensive half — which is not.
 *
 * ⚠ THE FIXTURE IS THE LIVE FORECAST, taken off `weather.forecast_home` on the
 * morning this was written, and it is the whole reason the rule exists: three
 * consecutive hours of `condition: rainy` at **0.01 mm/h**. That is a damp
 * haze. Announcing "rain at eleven" off the back of it teaches him to ignore
 * the line, and a warning that is always on costs the one that matters.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const w = require('../../shared/weather-outlook.cjs');

const NOW = new Date('2026-09-13T09:30:00');
const at = (h, over = {}) => ({
  datetime: `2026-09-13T${String(h).padStart(2, '0')}:00:00`,
  condition: 'partlycloudy',
  temperature: 19,
  precipitation: 0,
  ...over,
});

// ── The trace rule ───────────────────────────────────────────────────────────

test('⚠ NEGATIVE: `rainy` at 0.01 mm is NOT rain — the live forecast case', () => {
  const hours = [
    at(10, { condition: 'rainy', precipitation: 0.01, temperature: 19.7 }),
    at(11, { condition: 'rainy', precipitation: 0.01, temperature: 20.6 }),
    at(12, { condition: 'partlycloudy', temperature: 21.1 }),
  ];
  const r = w.outlook({ condition: 'cloudy', tempC: 18.2 }, hours, NOW);
  assert.equal(r.rain, null, 'a damp haze is not a forecast of rain');
  assert.equal(r.lines.some(l => /rain/i.test(l)), false);
});

test('real rain IS reported, with when', () => {
  const hours = [at(10), at(11, { condition: 'rainy', precipitation: 1.2 }), at(12)];
  const r = w.outlook({ tempC: 18 }, hours, NOW);
  assert.ok(r.rain);
  assert.equal(r.rain.starts, '11:00');
  assert.ok(r.lines.some(l => /Rain from 11:00/.test(l)));
});

test('⚠ BOTH tests must pass — heavy precipitation under a dry condition is not rain', () => {
  // A condition the forecaster does not call wet, however much water it names.
  const hours = [at(10, { condition: 'partlycloudy', precipitation: 3 })];
  assert.equal(w.outlook({ tempC: 18 }, hours, NOW).rain, null);
});

test('rain within the hour is phrased in minutes, not a clock time', () => {
  const hours = [at(10, { condition: 'rainy', precipitation: 0.8 })];
  const r = w.outlook({ tempC: 18 }, hours, NOW);
  assert.match(r.lines[0], /Rain in about 30 minutes/);
  assert.equal(r.rain.inMinutes, 30);
});

test('⚠ precipitation_probability is NULL here and is never read as zero', () => {
  // met.no does not supply it. A missing probability and a zero probability are
  // different facts, and only one of them means dry.
  const hours = [at(10, { condition: 'rainy', precipitation: 1.5, precipitation_probability: null })];
  assert.ok(w.outlook({ tempC: 18 }, hours, NOW).rain, 'the absent field does not suppress it');
});

// ── Temperature ──────────────────────────────────────────────────────────────

test('it names the high he is heading for, not the temperature now', () => {
  const hours = [at(10, { temperature: 19.7 }), at(11, { temperature: 20.6 }), at(12, { temperature: 21.5 })];
  const r = w.outlook({ tempC: 18.2 }, hours, NOW);
  assert.equal(r.temp.high, 22, 'rounded from 21.5');
  assert.equal(r.temp.direction, 'up');
  assert.ok(r.lines.some(l => /up to 22° by 12:00/.test(l)));
});

test('⚠ a flat temperature says NOTHING — "still 18" is not news', () => {
  const hours = [at(10, { temperature: 18.4 }), at(11, { temperature: 18.1 })];
  const r = w.outlook({ tempC: 18.2 }, hours, NOW);
  assert.equal(r.temp.direction, 'flat');
  assert.deepEqual(r.lines, []);
});

test('a falling temperature is worth saying', () => {
  const hours = [at(10, { temperature: 15 }), at(11, { temperature: 13 })];
  const r = w.outlook({ tempC: 18 }, hours, NOW);
  assert.equal(r.temp.direction, 'down');
  assert.ok(r.lines.some(l => /down to 13°/.test(l)));
});

// ── Refusals ─────────────────────────────────────────────────────────────────

test('⚠ NO FORECAST is silence, never an inferred one', () => {
  for (const h of [null, undefined, []]) {
    const r = w.outlook({ condition: 'cloudy', tempC: 18 }, h, NOW);
    assert.equal(r.known, false);
    assert.deepEqual(r.lines, []);
  }
});

test('a forecast that does not reach the horizon says so', () => {
  // Everything in it is already in the past.
  const r = w.outlook({ tempC: 18 }, [at(7), at(8)], NOW);
  assert.equal(r.known, false);
  assert.match(r.why, /does not reach/);
});

test('⚠ it never looks beyond the horizon — that is a forecast, not a heads-up', () => {
  const hours = [at(10), at(20, { condition: 'rainy', precipitation: 5 })];
  const r = w.outlook({ tempC: 18 }, hours, NOW);
  assert.equal(r.rain, null, 'rain eleven hours away is not a heads-up');
});

test('an unreadable clock yields nothing rather than a guess', () => {
  assert.equal(w.outlook({ tempC: 18 }, [at(10)], 'not a date').known, false);
});

test('⚠ times are SLICED from the string, never parsed — the BST rule', () => {
  assert.equal(w.hhmm('2026-09-13T14:00:00+01:00'), '14:00');
  assert.equal(w.hhmm('nonsense'), null);
});
