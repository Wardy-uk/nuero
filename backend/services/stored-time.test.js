'use strict';

// ⚠ TZ FIRST, BEFORE ANYTHING IS REQUIRED. Node reads it once, at first use of
// Date. The whole bug is a timezone assumption, so testing it in the runner's
// own zone would prove nothing — and the Pi is on Europe/London, which is what
// makes it bite for seven months of the year.
process.env.TZ = 'Europe/London';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseStoredUtc, storedDate } = require('./stored-time');

test('a stored stamp is UTC, even though it carries no marker', () => {
  // ⚠ THE BUG, IN ONE ASSERTION. toSqlUtc writes
  // toISOString().replace('T',' ').slice(0,19), so this IS 13:30 UTC. Date.parse
  // reads the space-separated form as LOCAL, which on a BST Pi is 12:30 UTC —
  // a silent +60 minutes on every age computed from it.
  const ms = parseStoredUtc('2026-09-11 13:30:00');
  assert.equal(new Date(ms).toISOString(), '2026-09-11T13:30:00.000Z');

  // And the difference from the naive read is exactly the BST offset.
  assert.equal((ms - Date.parse('2026-09-11 13:30:00')) / 60000, 60);
});

test('a reading 23 minutes old does not age as 83', () => {
  // "Her senses" reported a live heart-rate sensor as stale, which is the one
  // screen whose entire job is to be believed.
  const now = Date.parse('2026-09-11T13:53:00Z');
  const ageMinutes = Math.round((now - parseStoredUtc('2026-09-11 13:30:00')) / 60000);
  assert.equal(ageMinutes, 23);
});

test('GMT half of the year is unaffected, and still correct', () => {
  // January is GMT, so the naive read happened to agree. The fix must not
  // shift the half that was already right.
  const ms = parseStoredUtc('2026-01-15 13:30:00');
  assert.equal(new Date(ms).toISOString(), '2026-01-15T13:30:00.000Z');
  assert.equal(ms, Date.parse('2026-01-15 13:30:00'));
});

test('an explicit zone is believed, not overridden', () => {
  // Anything that says what it means keeps meaning it.
  assert.equal(new Date(parseStoredUtc('2026-09-11T13:30:00Z')).toISOString(),
               '2026-09-11T13:30:00.000Z');
  assert.equal(new Date(parseStoredUtc('2026-09-11T13:30:00+01:00')).toISOString(),
               '2026-09-11T12:30:00.000Z');
});

test('the T-separated form with no zone is also ours, and also UTC', () => {
  assert.equal(new Date(parseStoredUtc('2026-09-11T13:30:00')).toISOString(),
               '2026-09-11T13:30:00.000Z');
});

test('an hour bucket does not slip into the next one', () => {
  // ⚠ ambient.js buckets by HOUR. A +60 skew filed every reading an hour late,
  // so "when is he usually active" was wrong by a bucket all summer.
  assert.equal(storedDate('2026-09-11 09:05:00').getUTCHours(), 9);
  // And the reading that would have crossed a DAY boundary stays put.
  assert.equal(storedDate('2026-09-11 23:30:00').toISOString().slice(0, 10), '2026-09-11');
});

test('unreadable stamps answer NaN and null rather than a wrong time', () => {
  // ⚠ A guessed timestamp is worse than a missing one: it plots.
  assert.ok(Number.isNaN(parseStoredUtc(null)));
  assert.ok(Number.isNaN(parseStoredUtc('')));
  assert.ok(Number.isNaN(parseStoredUtc('not a date')));
  assert.equal(storedDate('not a date'), null);
  assert.equal(storedDate(null), null);
});

test('a Date passes through unchanged', () => {
  const d = new Date('2026-09-11T13:30:00Z');
  assert.equal(parseStoredUtc(d), d.getTime());
});
