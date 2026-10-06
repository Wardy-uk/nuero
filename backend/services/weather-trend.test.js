'use strict';

/**
 * The 6/12/24 hour outlook. Pure, so the product under test is the WORDING: which
 * rule fired, what evidence it printed, and that it never claims certainty.
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
const fc = (hours, over = {}) => Array.from({ length: hours }, (_, i) => ({
  validAt: NOW + (i + 1) * H, temperatureC: 13 + (i % 4), humidityPct: 80, pressureHpa: 1000, precipMm: 0, precipProb: 5, ...over,
}));

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

test('falling pressure + humid air + forecast rain → rain risk increasing, with the evidence', () => {
  const r = w.summarise({ obs: minutes({ dP: -2.4, rh: 88 }), forecast: fc(24, { precipMm: 0.6, precipProb: 70 }), nowMs: NOW, providerLabel: 'Open-Meteo' });
  assert.match(r.horizons[0].outlook, /rain risk increasing/);
  assert.match(r.paragraph, /Next 6 hours/);
  assert.match(r.paragraph, /pressure −2\.4 hPa\/3h, falling slowly/);
  assert.match(r.paragraph, /humidity 88%/);
  assert.equal(r.confidence, 'good');
});

test('rising pressure + dry forecast → settling', () => {
  const r = w.summarise({ obs: minutes({ dP: 2 }), forecast: fc(24), nowMs: NOW });
  assert.match(r.horizons[0].outlook, /^settling/);
  assert.match(r.horizons[1].outlook, /dry/);
});

test('steady pressure + dry forecast → conditions look stable', () => {
  const r = w.summarise({ obs: minutes({ dP: 0.2 }), forecast: fc(24), nowMs: NOW });
  assert.match(r.horizons[0].outlook, /conditions look stable/);
});

test('⚠ the two sources disagreeing is SAID, not resolved by picking one', () => {
  const r = w.summarise({ obs: minutes({ dP: 2.5 }), forecast: fc(24, { precipMm: 2, precipProb: 80 }), nowMs: NOW });
  assert.match(r.horizons[0].outlook, /mixed signals/);
  const r2 = w.summarise({ obs: minutes({ dP: -4, rh: 90 }), forecast: fc(24), nowMs: NOW, providerLabel: 'Open-Meteo' });
  assert.match(r2.horizons[0].outlook, /though Open-Meteo shows it dry/);
});

test('a damp-haze trace (0.01 mm, low probability) is not called rain', () => {
  const r = w.summarise({ obs: minutes(), forecast: fc(24, { precipMm: 0.01, precipProb: 10 }), nowMs: NOW });
  assert.doesNotMatch(r.paragraph, /rain likely|showers/);
});

test('rain timing is given in Europe/London wall-clock time', () => {
  const f = fc(24);
  f[3] = { ...f[3], precipMm: 1.5, precipProb: 80 }; // 16:00 UTC = 17:00 BST
  const r = w.summarise({ obs: minutes(), forecast: f, nowMs: NOW });
  assert.match(r.horizons[0].outlook, /from about 17:00/);
});

test('⚠ no station history: the paragraph says the trend is missing, never "stable"', () => {
  const r = w.summarise({ obs: [], forecast: fc(24), nowMs: NOW });
  assert.doesNotMatch(r.paragraph, /stable|settling/);
  assert.match(r.paragraph, /no pressure trend yet/);
  assert.equal(r.confidence, 'low');
});

test('⚠ no forecast and no history: an explicit no-outlook, not an empty all-clear', () => {
  const r = w.summarise({ obs: [], forecast: [], nowMs: NOW });
  assert.match(r.paragraph, /no outlook/);
  assert.match(r.paragraph, /no forecast available/);
});

test('a stale station is not used for the trend', () => {
  const r = w.summarise({ obs: minutes({ dP: -5, rh: 95 }), forecast: fc(24), nowMs: NOW, latestStale: true });
  assert.doesNotMatch(r.paragraph, /rain risk increasing/);
  assert.match(r.paragraph, /has not reported recently/);
});

test('a sensor reading far warmer than the forecast is flagged (the indoor/sheltered case)', () => {
  const r = w.summarise({ obs: minutes({ t0: 23.4 }), forecast: [{ validAt: NOW, temperatureC: 16.1, precipMm: 0, precipProb: 0 }, ...fc(24)], nowMs: NOW });
  assert.match(r.paragraph, /warmer than the forecast — check it is sited outdoors/);
  assert.notEqual(r.confidence, 'good');
});

test('⚠ nothing generated says "will" — calibrated wording only', () => {
  const scenarios = [
    { dP: -7, rh: 95, f: { precipMm: 3, precipProb: 90 } },
    { dP: 7, f: {} }, { dP: 0, f: { precipProb: 40 } }, { dP: -2, rh: 60, f: {} },
  ];
  for (const sc of scenarios) {
    const r = w.summarise({ obs: minutes(sc), forecast: fc(24, sc.f), nowMs: NOW });
    assert.doesNotMatch(r.paragraph, /\bwill\b|\bdefinitely\b|\bcertain/i, r.paragraph);
  }
});
