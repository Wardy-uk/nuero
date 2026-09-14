'use strict';

/**
 * Reading a deadline out of a commitment, and the ten-day default (14 Sep 2026).
 *
 * The fixtures below are REAL sentences, copied off the live Pi out of the last
 * 400 `capture_todo` candidates — not invented ones, because the whole finding
 * was that the plausible implementation (take any date you can see) is wrong
 * about a quarter of the time on Nick's actual data, and invented fixtures
 * would have agreed with it.
 *
 * Everything here is pure: no DB, no vault, no clock beyond the one it is
 * handed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveDueDate, statedDue, findDates, DEFAULT_DUE_DAYS } = require('./commitment-due');

// A Monday, so nothing below can pass by accidentally landing on a weekday.
const NOW = new Date(2026, 8, 14);

const due = (text, now = NOW) => resolveDueDate(text, { now });

// ── The default ──────────────────────────────────────────────────────────────

test('a commitment with no deadline gets ten days', () => {
  const r = due('Nick Ward to send breakdown of Parsons contacts: consent vs non-consent');
  assert.equal(r.source, 'default');
  assert.equal(r.date, '2026-09-24');
  assert.equal(r.phrase, null, 'nothing was read, so nothing may be quoted back');
});

test('the default is Nick’s ten, in calendar days', () => {
  assert.equal(DEFAULT_DUE_DAYS, 10);
  // Counted, not rounded to a working day: a rule that is quietly twelve days
  // because two of them were a weekend cannot be predicted from its own name.
  assert.equal(due('No date here', new Date(2026, 8, 17)).date, '2026-09-27');  // a Sunday
});

test('the default is never in the past, whatever the sentence mentions', () => {
  // The property that matters most: a task born overdue is a broken commitment
  // in the weekly risk report, manufactured by NEURO rather than by Nick.
  for (const text of [
    'Raise the issue including the 2026-06-04 escalation with Maria',
    'Chase Billin for outstanding July and August 2026 invoices',
    'Complete the calculations, aiming to complete this by August 20, 2026',
  ]) {
    assert.ok(due(text).date > '2026-09-14', `${text} produced a past due date`);
  }
});

// ── A date that IS a deadline ────────────────────────────────────────────────

test('a stated deadline wins over the default', () => {
  const r = due('Document WFH productivity study summary and publish internally by 2026-09-16');
  assert.equal(r.source, 'stated');
  assert.equal(r.date, '2026-09-16');
  assert.match(r.phrase, /by 2026-09-16/, 'a date read out of a sentence must be quotable back');
});

test('the deadline phrasings that actually occur are all read', () => {
  assert.equal(due('Write the new internal ticket process guide by end of 2026-10-04').date, '2026-10-04');
  assert.equal(due('Deliver product strategy pitch to Mel Morris on 2026-09-15').date, '2026-09-15');
  assert.equal(due('Bring an issue to the UAT session on September 16th').date, '2026-09-16');
  assert.equal(due('Send the summary before 20/09/2026').date, '2026-09-20');
  assert.equal(due('Have the RCA done no later than 1 October 2026').date, '2026-10-01');
});

test('a month with no year takes the nearest one', () => {
  // A commitment made in December and due "by 5 January" means the January
  // three weeks away, not the one eleven months back.
  assert.equal(due('Finish it by 5 January', new Date(2026, 11, 15)).date, '2027-01-05');
});

// ── A date that is NOT a deadline ────────────────────────────────────────────
//
// These four are the finding. Each is a real sentence carrying a real, parseable
// date that means something other than "this is when it is due", and each one
// must fall through to the default rather than becoming it.

test('a START date is not a deadline', () => {
  const r = due('Implement Support WFH one day per week policy and monitor metrics starting 2026-09-16');
  assert.equal(r.source, 'default', '"starting" is when it begins, not when it is owed');
  assert.equal(r.date, '2026-09-24');
});

test('somebody else’s return date is not a deadline', () => {
  assert.equal(due('Nick to speak with Chris (returning 2026-08-25) and demand a decision').source, 'default');
});

test('a reference to a past event is not a deadline', () => {
  assert.equal(due('Raise the issue including the 2026-06-04 escalation with Maria').source, 'default');
});

test('a lookback period is not a deadline', () => {
  // ⚠ This one also contains the word "by" — "segment by platform" — which is
  // exactly why the cue has to govern a DATE rather than merely appear.
  const r = due('Nick to complete analysis of property feed tickets since August and segment by platform');
  assert.equal(r.source, 'default');
});

test('a deadline already gone is refused, not honoured', () => {
  // Parseable, genuinely cued, and in the past. Honouring it would create the
  // overdue task; the default is the safe reading, and Nick can move it.
  const r = due('Produce a formal RCA document by the morning of August 18, 2026');
  assert.equal(r.source, 'default');
  assert.equal(statedDue('Produce a formal RCA document by the morning of August 18, 2026', NOW), null);
  // The same sentence a year on IS read, so this is the clock and not the words.
  assert.equal(due('Produce a formal RCA document by the morning of August 18, 2027').date, '2027-08-18');
});

test('today counts as still in time', () => {
  assert.equal(due('Send the note by 2026-09-14').date, '2026-09-14', 'due today is not overdue');
});

// ── Parsing ──────────────────────────────────────────────────────────────────

test('an impossible date is not a date', () => {
  // ⚠ Round-trip validated: `new Date(2026, 1, 31)` is a perfectly happy
  // 3 March, so a range check alone would accept this and silently move it.
  assert.deepEqual(findDates('by 31 February 2027', NOW), []);
  assert.equal(due('Do the thing by 31 February 2027').source, 'default');
});

test('nothing in, default out — never a crash', () => {
  for (const bad of [null, undefined, '', '   ']) {
    const r = resolveDueDate(bad, { now: NOW });
    assert.equal(r.source, 'default');
    assert.equal(r.date, '2026-09-24');
  }
});

test('the date is built in local time', () => {
  // Never toISOString() — the Pi may run UTC, and a late-evening promotion
  // would land the default on the wrong day. This is the calendar's own bug,
  // which is not being repeated here.
  const lateEvening = new Date(2026, 8, 14, 23, 45);
  assert.equal(due('No deadline', lateEvening).date, '2026-09-24');
});
