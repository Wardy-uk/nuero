'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { cadenceState } = require('./one-to-one-detect');

// These pin the fix for the bug where NEURO reminded Nick to book 1-2-1s that
// were already in his diary.
//
// The cause: `next-1-2-1-due` carried two meanings. one-to-one-detect wrote it
// as "when the next one is OWED" (last held + cadence); one-to-one-booking's
// book() overwrote it with the date of the meeting it had just created. Both
// readers — the 1-2-1 nudge and the Team board — assumed the first meaning, so
// every booking wrote a nag against itself: "Get them in the diary" about a
// meeting already in it, then "These need booking now" the day after it
// happened. A booking now lives in `1-2-1-booked` and this function is the one
// place that decides what any of it means.

const TODAY = '2026-08-16';

test('a 1-2-1 in the diary is silent — the whole point of the fix', () => {
  const s = cadenceState({
    lastHeld: '2026-03-26',   // genuinely ages ago...
    nextDue: '2026-04-09',    // ...so the cadence date is long past
    booked: '2026-08-18',     // ...but it IS booked
  }, TODAY);
  assert.equal(s.state, 'booked');
  assert.equal(s.daysUntil, 2);
});

test('a booking today still counts as booked, not overdue', () => {
  const s = cadenceState({ lastHeld: '2026-07-01', nextDue: '2026-07-15', booked: TODAY }, TODAY);
  assert.equal(s.state, 'booked');
  assert.equal(s.daysUntil, 0);
});

test('the booked date passing with no note is unwritten, NOT "needs booking"', () => {
  // This is the state the old code reported as "Overdue 1-2-1: Stephen (was
  // 2026-08-18). These need booking now." — about a meeting that had happened.
  const s = cadenceState({
    lastHeld: '2026-03-26',
    nextDue: '2026-04-09',
    booked: '2026-08-14',
  }, TODAY);
  assert.equal(s.state, 'unwritten');
  assert.equal(s.daysSince, 2);
});

test('a note dated on the booking clears it — the booking is spent', () => {
  const s = cadenceState({
    lastHeld: '2026-08-14',   // the write-up landed
    nextDue: '2026-08-28',
    booked: '2026-08-14',
  }, TODAY);
  assert.equal(s.state, 'ok');
});

test('a note dated BEFORE the booking does not cancel it', () => {
  // An unrelated earlier meeting note must not make a future booking vanish.
  const s = cadenceState({
    lastHeld: '2026-08-01',
    nextDue: '2026-08-15',
    booked: '2026-08-20',
  }, TODAY);
  assert.equal(s.state, 'booked');
});

test('nothing booked and the due date is past → overdue', () => {
  const s = cadenceState({ lastHeld: '2026-07-01', nextDue: '2026-07-15' }, TODAY);
  assert.equal(s.state, 'overdue');
  assert.equal(s.daysOverdue, 32);
});

test('nothing booked and due within the window → due-soon', () => {
  const s = cadenceState({ lastHeld: '2026-08-04', nextDue: '2026-08-18' }, TODAY);
  assert.equal(s.state, 'due-soon');
  assert.equal(s.daysUntil, 2);
});

test('soonDays is respected — the board uses 3, the nudge 2', () => {
  const args = { lastHeld: '2026-08-05', nextDue: '2026-08-19' };
  assert.equal(cadenceState(args, TODAY, { soonDays: 2 }).state, 'ok');
  assert.equal(cadenceState(args, TODAY, { soonDays: 3 }).state, 'due-soon');
});

test('someone off-cadence is never chased, however overdue the numbers look', () => {
  // `cadence: n/a` is how maternity / long-term sick comes out of the rota.
  const s = cadenceState({ lastHeld: '2026-01-01', nextDue: '2026-01-15', bookable: false }, TODAY);
  assert.equal(s.state, 'ok');
});

test('no due date and no booking is quiet, not overdue', () => {
  assert.equal(cadenceState({ lastHeld: '2026-08-01' }, TODAY).state, 'ok');
});

test('a booking with no last-1-2-1 at all still reads unwritten once it passes', () => {
  const s = cadenceState({ booked: '2026-08-10' }, TODAY);
  assert.equal(s.state, 'unwritten');
  assert.equal(s.daysSince, 6);
});

test('date maths does not drift across the BST boundary', () => {
  // The Pi may run UTC; addDays/daysBetween both anchor at midday for this.
  const s = cadenceState({ nextDue: '2026-10-26' }, '2026-10-24', { soonDays: 3 });
  assert.equal(s.state, 'due-soon');
  assert.equal(s.daysUntil, 2);
});

// ---------------------------------------------------------------------------
// foldDetected — the stamp is the LAGGING copy
//
// Reported live on 20 Aug 2026: Hope Goodall's card rendered the summary of the
// 1-2-1 note dated that morning and, one line above it, "Met 2026-08-19 — no
// note". Both halves read the same person from the same board: the summary came
// from the detector, the badge from `last-1-2-1`, which was still 2026-04-30
// because syncPeopleNotes only stamps at 22:00. Same rule as everywhere else in
// NEURO — a 1-2-1 is DETECTED, not declared — so the stamp never wins over a
// note the detector can actually see.
// ---------------------------------------------------------------------------

const { foldDetected } = require('./one-to-one-detect');

test('a detected note newer than the stamp wins, and the due date follows it', () => {
  const f = foldDetected(
    { 'last-1-2-1': '2026-04-30', 'next-1-2-1-due': '2026-05-14', '1-2-1-booked': '2026-08-19', cadence: 'fortnightly' },
    '2026-08-20',
  );
  assert.equal(f.lastHeld, '2026-08-20');
  // Recomputed exactly as tonight's sync will. Reading the stale 2026-05-14
  // would only trade "no note" for a spurious "overdue by 98d".
  assert.equal(f.nextDue, '2026-09-03');
});

test('and that fold is what stops the card saying "no note" about a note on disk', () => {
  const fm = { 'last-1-2-1': '2026-04-30', 'next-1-2-1-due': '2026-05-14', '1-2-1-booked': '2026-08-19', cadence: 'fortnightly' };
  assert.equal(cadenceState(foldDetected(fm, null), '2026-08-20').state, 'unwritten');
  assert.notEqual(cadenceState(foldDetected(fm, '2026-08-20'), '2026-08-20').state, 'unwritten');
});

test('the stamp is left alone when the detector has nothing newer', () => {
  const fm = { 'last-1-2-1': '2026-08-04', 'next-1-2-1-due': '2026-08-18', cadence: 'fortnightly' };
  assert.deepEqual(foldDetected(fm, '2026-07-01'), { lastHeld: '2026-08-04', nextDue: '2026-08-18', booked: null });
  assert.deepEqual(foldDetected(fm, null), { lastHeld: '2026-08-04', nextDue: '2026-08-18', booked: null });
  // Same date: the sync has caught up. The due date IS recomputed from last + cadence
  // (see the stale-stored-due test below), which here agrees with what was stored.
  assert.equal(foldDetected(fm, '2026-08-04').nextDue, '2026-08-18');
});

test('a detected note carries a person who was never stamped at all', () => {
  const f = foldDetected({ cadence: 'weekly' }, '2026-08-20');
  assert.equal(f.lastHeld, '2026-08-20');
  assert.equal(f.nextDue, '2026-08-27');
});

// ---------------------------------------------------------------------------
// The WORDS, not just the state (13 Sep 2026)
//
// Found by comparing the server rule against `PeopleBoard.get121Status`, the
// browser copy kept for consolidation: the two agreed on every state and
// DISAGREED on what to call one of them. `cadenceState` says of `unwritten`
// that "a booking is a SCHEDULE, never evidence of attendance - nothing here
// knows whether the meeting took place", and the label two hundred lines below
// it read "Held <date>, not written up". Live that rendered against Sebastian
// Broome, the exact person the comment names, and the same string is WRITTEN
// INTO THE VAULT by one-to-one-tracker.
// ---------------------------------------------------------------------------

const { cadenceLabel } = require('./one-to-one-detect');

test('a booking is never described as a meeting that happened', () => {
  for (const days of [null, 48]) {
    const label = cadenceLabel({ state: 'unwritten', booked: '2026-09-07', daysOverdue: days });
    // The forbidden claim, in every form the wording has taken.
    assert.ok(!/held/i.test(label), `label claims attendance: ${label}`);
    assert.ok(!/met/i.test(label), `label claims attendance: ${label}`);
    assert.ok(!/attended/i.test(label), `label claims attendance: ${label}`);
    // Positive control: it still says the useful half.
    assert.match(label, /2026-09-07/);
    assert.match(label, /no note/i);
  }
});

test('a stale booking cannot hide an overdue 1-2-1', () => {
  // `cadenceState` computes daysOverdue on this state precisely so a booking
  // that has been and gone does not mask a real gap - and the label dropped it,
  // so the number was carried, correct, and said by nobody.
  const label = cadenceLabel({ state: 'unwritten', booked: '2026-09-07', daysOverdue: 48 });
  assert.match(label, /overdue by 48d/);
});

test('the ordinary not-written-up-yet case carries no overdue suffix', () => {
  // Seen last week, note not written. ABSENT rather than "0d": a zero there
  // reads as a deadline that has just passed rather than one that has not.
  const label = cadenceLabel({ state: 'unwritten', booked: '2026-09-07', daysOverdue: null });
  assert.ok(!/overdue/i.test(label), label);
});

test('positive control - the other labels still render', () => {
  assert.match(cadenceLabel({ state: 'overdue', daysOverdue: 12 }), /Overdue by 12d/);
  assert.match(cadenceLabel({ state: 'booked', booked: '2026-09-17' }), /Booked 2026-09-17/);
  assert.match(cadenceLabel({ state: 'due-soon', daysUntil: 2 }), /Due in 2d/);
  assert.equal(cadenceLabel(null), '—');
});
