'use strict';

/**
 * Is this normal for a Tuesday?
 *
 * The past tense NEURO never had. Pure, so what is under test is the product:
 * what counts as a habit, and — the expensive half — when there is not enough
 * evidence to claim one.
 *
 * ⚠ A pattern layer that speaks from a thin sample is WORSE than none, because
 * it sounds exactly like one that knows. Measured before building: health has
 * ~108 samples per weekday, wins ~14, and desktop_daily ~2. Only the first two
 * can carry an answer today, and the code has to say which.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const r = require('../../shared/rhythm.cjs');

// ── Enough evidence, or none ─────────────────────────────────────────────────

test('⚠ NEGATIVE: below the floor there is NO habit, and the count says why', () => {
  // desktop_daily has ~2 samples per weekday. A median over two Tuesdays is not
  // his normal Tuesday.
  const p = r.typical([420, 460]);
  assert.equal(p.known, false);
  assert.equal(p.n, 2);
  assert.match(p.why, /only 2 samples, need 8/);
  assert.equal(p.typical, null, 'and no number is offered at all');
});

test('enough samples yields a typical value', () => {
  const p = r.typical([7, 7.5, 8, 7.2, 8.1, 7.8, 7.4, 7.9]);
  assert.equal(p.known, true);
  assert.equal(p.n, 8);
  assert.ok(p.typical > 7 && p.typical < 8);
});

test('⚠ MEDIAN, never mean — one freak night must not become his normal', () => {
  // Seven ordinary nights and one 14-hour one.
  const nights = [7, 7, 7, 7, 7, 7, 7, 14];
  assert.equal(r.typical(nights).typical, 7, 'the median ignores the outlier');
  const mean = nights.reduce((a, b) => a + b, 0) / nights.length;
  assert.ok(mean > 7.8, 'where a mean would have moved his normal by most of an hour');
});

test('unreadable values are dropped, not counted as zero', () => {
  const p = r.typical([7, 7, 7, null, undefined, NaN, 7, 7, 7, 7, 7, 7]);
  assert.equal(p.n, 9);
  assert.equal(p.typical, 7);
});

// ── Comparing today with the habit ───────────────────────────────────────────

const HABIT = r.typical([7, 7.2, 7.4, 7.5, 7.6, 7.8, 8, 8.2]);

test('a normal day is reported as normal, and is not notable', () => {
  const c = r.compare(7.5, HABIT);
  assert.equal(c.known, true);
  assert.equal(c.notable, false);
});

test('a genuinely unusual value is notable, in HIS OWN spread', () => {
  // Not an absolute threshold: "unusual" means different for someone who sleeps
  // 6-7h than for someone who ranges 5-10h.
  const c = r.compare(4.5, HABIT);
  assert.equal(c.direction, 'below');
  assert.equal(c.notable, true);
});

test('⚠ NEGATIVE: no habit means NO comparison, never "normal"', () => {
  const thin = r.typical([7, 7]);
  const c = r.compare(3, thin);
  assert.equal(c.known, false);
  assert.equal(c.notable, false, 'a 3-hour night is not called fine because we cannot judge it');
  assert.match(c.why, /only 2 samples/);
});

test('⚠ NEGATIVE: nothing recorded today is NOT a normal day', () => {
  const c = r.compare(null, HABIT);
  assert.equal(c.known, false);
  assert.match(c.why, /nothing recorded/);
});

test('⚠ a ZERO spread never makes everything notable', () => {
  // Identical samples mean the signal is coarse, not that he is perfect — and
  // dividing by it would call every difference remarkable.
  const flat = r.typical([8, 8, 8, 8, 8, 8, 8, 8]);
  assert.equal(flat.spread, 0);
  assert.equal(r.compare(9, flat).notable, false);
});

// ── Slicing by weekday ───────────────────────────────────────────────────────

test('rows group by weekday', () => {
  const rows = [
    { day: '2026-09-07', h: 7 }, // Monday
    { day: '2026-09-14', h: 8 }, // Monday
    { day: '2026-09-12', h: 9 }, // Saturday
  ];
  const g = r.byWeekday(rows, x => r.weekdayOf(x.day), x => x.h);
  assert.deepEqual(g[1], [7, 8], 'Mondays');
  assert.deepEqual(g[6], [9], 'Saturday');
});

test('⚠ the weekday is ARITHMETIC on the digits, never a parsed Date', () => {
  // `new Date('2026-09-13')` is UTC midnight and lands on the previous day west
  // of here — the same class of bug as parsing calendar times, which this repo
  // has now hit in four separate places.
  assert.equal(r.weekdayOf('2026-09-13'), 0, 'Sunday');
  assert.equal(r.weekdayOf('2026-09-14'), 1, 'Monday');
  assert.equal(r.weekdayOf('2026-09-12'), 6, 'Saturday');
  assert.equal(r.weekdayOf('2026-01-01'), 4, 'Thursday');
  assert.equal(r.weekdayOf('2024-02-29'), 4, 'a leap day');
});

test('an unreadable date is null, not day zero', () => {
  for (const bad of ['', 'nonsense', null, undefined, '13/09/2026']) {
    assert.equal(r.weekdayOf(bad), null, JSON.stringify(bad));
  }
});
