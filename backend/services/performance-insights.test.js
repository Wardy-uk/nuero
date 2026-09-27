'use strict';

/** Each insight earns a claim only by measurement — pinned here both ways. */

const test = require('node:test');
const assert = require('node:assert/strict');
const pi = require('./performance-insights');

test('the permutation test finds a real relationship and not a random one', () => {
  const xs = Array.from({ length: 40 }, (_, i) => 17 + (i % 10) * 0.6);
  const strong = xs.map((x) => 9 - (x - 17) * 0.4);
  assert.ok(pi.permutationTest(xs, strong).p < 0.01);
  // A fixed pseudo-random y unrelated to x.
  let s = 7; const noise = xs.map(() => ((s = (s * 16807) % 2147483647) / 2147483647) * 3 + 6);
  assert.ok(pi.permutationTest(xs, noise).p > 0.05);
});

test('the p-value is deterministic — the same data never flips the verdict', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8]; const ys = [2, 1, 4, 3, 6, 5, 8, 7];
  assert.deepEqual(pi.permutationTest(xs, ys), pi.permutationTest(xs, ys));
});

test('the overnight room is 23:00–07:00 LOCAL, filed under the WAKE date', () => {
  const t = (iso) => Date.parse(iso) / 1000;
  // BST: 22:30 UTC on 20 Sep is 23:30 local → belongs to the night waking on the 21st.
  const room = pi.overnightRoom([
    { t: t('2026-09-20T22:30:00Z'), temperature_c: 20 },
    { t: t('2026-09-21T00:30:00Z'), temperature_c: 20 },
    { t: t('2026-09-21T03:30:00Z'), temperature_c: 20 },
    { t: t('2026-09-21T05:30:00Z'), temperature_c: 20 },
    { t: t('2026-09-21T12:00:00Z'), temperature_c: 30 }, // midday — not the night
  ]);
  assert.deepEqual([...room.keys()], ['2026-09-21']);
  assert.equal(room.get('2026-09-21').tempC, 20);
});

const nights = (n, f) => Array.from({ length: n }, (_, i) => {
  const day = new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10);
  const temp = 17 + (i % 8);
  return { day, temp, row: { day, complete: true, ...f(temp, i) } };
});

test('warmer room, shorter sleep: found, in minutes, with the evidence', () => {
  const ns = nights(40, (temp) => ({ asleepHours: 8.5 - (temp - 17) * 0.1 }));
  const room = new Map(ns.map((n) => [n.day, { tempC: n.temp }]));
  const r = pi.sleepEnvironment(ns.map((n) => n.row), room);
  const f = r.findings.find((x) => x.outcome === 'asleepHours');
  assert.ok(f, 'the relationship should be found');
  assert.match(r.sentence, /min lower/);
  assert.match(r.sentence, /p = /);
});

test('no link is said as no link — never padded into a finding', () => {
  const ns = nights(40, (_t, i) => ({ asleepHours: 7.5 + ((i * 7) % 5) * 0.1 }));
  const room = new Map(ns.map((n) => [n.day, { tempC: n.temp }]));
  const r = pi.sleepEnvironment(ns.map((n) => n.row), room);
  assert.equal(r.findings.length, 0);
  assert.match(r.sentence, /No clear link/);
});

test('too few nights refuses rather than guessing', () => {
  const ns = nights(10, (temp) => ({ asleepHours: 9 - temp * 0.1 }));
  const room = new Map(ns.map((n) => [n.day, { tempC: n.temp }]));
  const r = pi.sleepEnvironment(ns.map((n) => n.row), room);
  assert.ok(r.results.every((x) => x.known === false));
  assert.match(r.sentence, /Not enough nights/);
});

test('the room is never called the bedroom', () => {
  const ns = nights(40, (temp) => ({ asleepHours: 8.5 - (temp - 17) * 0.1 }));
  const room = new Map(ns.map((n) => [n.day, { tempC: n.temp }]));
  const r = pi.sleepEnvironment(ns.map((n) => n.row), room);
  assert.ok(!/bedroom/i.test(r.sentence));
  assert.match(r.caveat, /not known to be the bedroom/);
});

test('cardio fitness reports change over 90 days, weekly', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({
    recorded_at: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().replace('T', ' ').slice(0, 19),
    value: 30 + i * 0.02,
  }));
  const c = pi.cardioFitness(rows, []);
  assert.ok(c.vo2max.change90d > 1.5 && c.vo2max.change90d < 2.1, `got ${c.vo2max.change90d}`);
  assert.equal(c.walkingHr.latest, null);
});

test('heat cost waits for enough carried hikes', () => {
  const r = pi.heatCost([{ effort: 5, tempC: 12 }, { effort: 6, tempC: 20 }]);
  assert.equal(r.known, false);
  assert.match(r.why, /need 6/);
});

test('one lucky outcome out of four is NOT a finding — the threshold is corrected', () => {
  // Weak link on sleep only; the first real run found exactly this shape at p = 0.025.
  const ns = nights(40, (temp, i) => ({ asleepHours: 7.7 + (temp - 17) * 0.02 + ((i * 7) % 5) * 0.08, awakeHours: 0.3, deepHours: 0.6 + ((i * 3) % 4) * 0.05, hrvMedian: 16 + ((i * 5) % 7) }));
  const room = new Map(ns.map((n) => [n.day, { tempC: n.temp }]));
  const r = pi.sleepEnvironment(ns.map((n) => n.row), room);
  assert.ok(r.threshold < 0.05, 'the threshold must be corrected for the outcomes tested');
  for (const f of r.findings) assert.ok(f.p < r.threshold);
});
