'use strict';

/**
 * The outlook, split into what the sensor says, what the forecast says, and
 * whether they agree. Pure, so the product under test is the WORDING: which rule
 * fired, which readings were used, and that nothing claims certainty.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const w = require('./weather-trend');

const H = 3600000;
const NOW = Date.parse('2026-10-06T12:00:00Z');

/** Minutes over the last `hours`, pressure moving linearly by `dP` across them. */
function minutes({ hours = 3, p0 = 1005, dP = 0, t0 = 14, dT = 0, rh = 70 } = {}) {
  const n = hours * 60;
  return Array.from({ length: n + 1 }, (_, i) => ({
    t: NOW - (n - i) * 60000,
    pressureHpa: p0 + (dP * i) / n,
    temperatureC: t0 + (dT * i) / n,
    humidityPct: rh,
  }));
}
// Forecast temperature matches the sensor's default 14°C now, so the sensor reads as outdoors.
const fc = (hours, over = {}) => [{ validAt: NOW, temperatureC: 14, humidityPct: 80, pressureHpa: 1000, precipMm: 0, precipProb: 5 },
  ...Array.from({ length: hours }, (_, i) => ({
    validAt: NOW + (i + 1) * H, temperatureC: 13 + (i % 4), humidityPct: 80, pressureHpa: 1000, precipMm: 0, precipProb: 5, ...over,
  }))];
const sum = (o) => w.summarise({ nowMs: NOW, providerLabel: 'Open-Meteo', ...o });

test('WMO tendency bands', () => {
  assert.equal(w.tendencyBand(0.4).word, 'steady');
  assert.equal(w.tendencyBand(-0.99).word, 'steady');
  assert.equal(w.tendencyBand(-2).word, 'falling slowly');
  assert.equal(w.tendencyBand(4).word, 'rising');
  assert.equal(w.tendencyBand(-7).word, 'falling quickly');
  assert.equal(w.tendencyBand(null), null);
});

test('a tendency is never computed from under an hour, and says why rather than reading as steady', () => {
  const c = w.changeOver(minutes({ hours: 0.5 }).slice(-20), 'pressureHpa', NOW);
  assert.equal(c.delta3h, null);
  assert.match(c.why, /under an hour/);
});

test('a short history is scaled to three hours', () => {
  const c = w.changeOver(minutes({ hours: 1.5, dP: -1.5 }), 'pressureHpa', NOW);
  assert.ok(Math.abs(c.delta3h - -3) < 0.25, String(c.delta3h));
});

// ── The split ───────────────────────────────────────────────────────────────

test('⚠ the sensor and the forecast are reported SEPARATELY, each in its own words', () => {
  const r = sum({ obs: minutes({ dP: -2.4, rh: 88 }), forecast: fc(24, { precipMm: 0.6, precipProb: 70 }) });
  assert.equal(r.sensor.verdict, 'Pressure falling in humid air — rain risk increasing over the next few hours.');
  assert.doesNotMatch(r.sensor.verdict, /forecast|Open-Meteo|%|mm/, 'the sensor verdict quotes nothing from the forecast');
  assert.equal(r.forecast.provider, 'Open-Meteo');
  assert.deepEqual(r.forecast.horizons.map((h) => h.hours), [6, 12, 24]);
  assert.match(r.forecast.horizons[0].words, /rain likely/);
  assert.equal(r.comparison.verdict, 'agree');
  assert.equal(r.confidence, 'good');
});

test('the sensor says which readings it used, with the value and a reason', () => {
  const r = sum({ obs: minutes({ dP: -2.4, rh: 88 }), forecast: fc(24) });
  const by = Object.fromEntries(r.sensor.lines.map((l) => [l.label, l]));
  assert.match(by.Pressure.value, /−2\.4 hPa per 3 h \(falling slowly\)/);
  assert.equal(by.Pressure.used, true);
  assert.equal(by.Humidity.used, true);
  assert.match(by.Humidity.note, /counts towards rain risk/);
});

test('rising pressure + dry forecast → settling, agree', () => {
  const r = sum({ obs: minutes({ dP: 2 }), forecast: fc(24) });
  assert.equal(r.sensor.verdict, 'Pressure rising — settling.');
  assert.equal(r.forecast.horizons[1].words, 'dry');
  assert.equal(r.comparison.verdict, 'agree');
});

test('steady pressure → the sensor sees no change coming', () => {
  assert.equal(sum({ obs: minutes({ dP: 0.2 }), forecast: fc(24) }).sensor.verdict, 'Pressure steady — no sign of a change in the next few hours.');
});

test('⚠ disagreement is SAID, not resolved by picking one', () => {
  const a = sum({ obs: minutes({ dP: 2.5 }), forecast: fc(24, { precipMm: 2, precipProb: 80 }) });
  assert.equal(a.comparison.verdict, 'disagree');
  assert.match(a.comparison.text, /pressure is rising but Open-Meteo still has rain/);
  const b = sum({ obs: minutes({ dP: -4, rh: 90 }), forecast: fc(24) });
  assert.equal(b.comparison.verdict, 'disagree');
  assert.match(b.comparison.text, /pressure is falling but Open-Meteo has the next 6 hours dry/);
});

test('rain the forecast has beyond 6 hours, over steady pressure, names what would confirm it (London time)', () => {
  const f = fc(24);
  for (let i = 7; i <= 12; i++) f[i] = { ...f[i], precipMm: 1.5, precipProb: 90 }; // from 19:00 UTC = 20:00 BST
  const r = sum({ obs: minutes({ dP: 0.1 }), forecast: f });
  assert.match(r.comparison.watch, /rain from about 20:00/);
  assert.match(r.comparison.watch, /more than 1 hPa over 3 hours/);
});

test('a damp-haze trace (0.01 mm, low probability) is not called rain', () => {
  const r = sum({ obs: minutes(), forecast: fc(24, { precipMm: 0.01, precipProb: 10 }) });
  assert.ok(r.forecast.horizons.every((h) => h.words === 'dry'));
});

// ── The indoor sensor (the live case on 6 Oct 2026: 23.4°C against 16.1°C) ──

test('⚠ an indoor-looking sensor: temperature and humidity are marked NOT USED, pressure still is', () => {
  const r = sum({ obs: minutes({ t0: 23.4, rh: 54 }), forecast: fc(24) });
  assert.equal(r.sensor.indoorLikely, true);
  const by = Object.fromEntries(r.sensor.lines.map((l) => [l.label, l]));
  assert.equal(by.Temperature.used, false);
  assert.match(by.Temperature.note, /probably indoors/);
  assert.equal(by.Humidity.used, false);
  assert.equal(by.Pressure.used, true);
  assert.notEqual(r.confidence, 'good');
});

test('⚠ an indoor sensor’s humidity cannot turn a slow pressure fall into "rain risk increasing"', () => {
  // Slow fall + 90% humidity would be "worsening" outdoors; indoors the humidity is the room.
  const indoor = sum({ obs: minutes({ dP: -2, t0: 23, rh: 90 }), forecast: fc(24) });
  assert.equal(indoor.sensor.verdict, 'Pressure falling slowly — possibly turning less settled.');
  const outdoor = sum({ obs: minutes({ dP: -2, rh: 90 }), forecast: fc(24) });
  assert.match(outdoor.sensor.verdict, /rain risk increasing/);
});

// ── Missing inputs ──────────────────────────────────────────────────────────

test('⚠ under an hour of history: the sensor says so, never "steady"', () => {
  const r = sum({ obs: minutes({ hours: 0.5 }), forecast: fc(24) });
  assert.match(r.sensor.verdict, /Too little history for a pressure trend yet — 30 min/);
  assert.equal(r.sensor.available, false);
  assert.equal(r.comparison.verdict, 'forecast-only');
  assert.equal(r.confidence, 'low');
});

test('no forecast and no history: both halves say so', () => {
  const r = sum({ obs: [], forecast: [] });
  assert.equal(r.sensor.verdict, 'No readings from the station yet.');
  assert.equal(r.forecast.available, false);
  assert.equal(r.comparison.verdict, 'none');
});

test('a stale station says nothing about now', () => {
  const r = sum({ obs: minutes({ dP: -5, rh: 95 }), forecast: fc(24), latestStale: true });
  assert.match(r.sensor.verdict, /has not reported recently/);
  assert.equal(r.sensor.lines.length, 0);
});

test('⚠ nothing generated says "will" — calibrated wording only', () => {
  const scenarios = [
    { dP: -7, rh: 95, f: { precipMm: 3, precipProb: 90 } },
    { dP: 7, f: {} }, { dP: 0, f: { precipProb: 40 } }, { dP: -2, rh: 60, f: {} }, { dP: 0, t0: 23, f: { precipMm: 2, precipProb: 95 } },
  ];
  for (const sc of scenarios) {
    const r = sum({ obs: minutes(sc), forecast: fc(24, sc.f) });
    const all = [r.paragraph, r.sensor.verdict, r.comparison.text, r.comparison.watch || '', ...r.sensor.lines.map((l) => l.note)].join(' ');
    assert.doesNotMatch(all, /\bwill\b|\bdefinitely\b|\bcertain/i, all);
  }
});

test('a change that rounds to zero is ±0.0, never +0.0', () => {
  const obs = minutes({ dP: 0.01 });
  const r = sum({ obs, forecast: fc(24) });
  assert.match(r.sensor.lines[0].value, /±0\.0 hPa per 3 h/);
});
