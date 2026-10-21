'use strict';

// Mass schedule / reschedule over a window (21 Oct 2026). Nick's calls: every
// selected person is (re)placed INSIDE the window, spread across it, and anyone
// with a 1-2-1 already in the diary is MOVED rather than double-booked.
//
// ⚠ Dates are derived from the clock, never literals: a fixture written as a
// fixed date becomes "the window is already over" the day real time passes it.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'o21w-')), 'test.db');
delete process.env.OBSIDIAN_VAULT_PATH;

const booking = require('./one-to-one-booking');
const db = require('../db/database');
const detect = require('./one-to-one-detect');
const microsoft = require('./microsoft');
const availability = require('./team-availability');
const preparedActions = require('./prepared-actions');
const workingDays = require('./working-days');
const {
  validateWindow, eligibleDays, spreadIndex, findSlotInDays, matchOneToOnes, dateStr,
} = booking._internals;

test.before(async () => { await db.init(); });

function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

/** A Monday at least two weeks out whose Mon–Thu are all working days. */
function cleanWeek() {
  let d = addDays(new Date(), 14);
  d.setHours(12, 0, 0, 0);
  for (;;) {
    while (d.getDay() !== 1) d = addDays(d, 1);
    const days = [0, 1, 2, 3].map(i => addDays(d, i));
    if (days.every(x => workingDays.isWorkingDay(x, []))) return days.map(dateStr);
    d = addDays(d, 7);
  }
}

const ev = (id, date, from, to, subject, extra = {}) => ({
  id, date, start: `${date}T${from}:00`, end: `${date}T${to}:00`, subject, showAs: 'busy', ...extra,
});

function stubTeam(t, names, { events = [], emails = {} } = {}) {
  t.mock.method(detect, 'getIndex', () => ({
    people: names.map(name => ({ name, bookable: true })), byPerson: {},
  }));
  t.mock.method(detect, 'buildRoster', () => ({
    people: names.map(name => ({ name, email: emails[name] === undefined ? `${name.split(' ')[0].toLowerCase()}@x.test` : emails[name] })),
  }));
  t.mock.method(microsoft, 'fetchCalendarEvents', async () => events.map(e => ({ ...e })));
  t.mock.method(availability, 'snapshot', () => ({}));
  t.mock.method(availability, 'daysOffFor', () => ({ known: true, dates: new Set() }));
}

// ── validateWindow ─────────────────────────────────────────────────────────

test('a window that is not a real range is refused, never clamped', () => {
  const now = new Date('2026-10-21T10:00:00');
  assert.strictEqual(validateWindow('2026-10-2', '2026-11-01', now).ok, false);
  assert.strictEqual(validateWindow('2026-02-31', '2026-03-05', now).ok, false, 'Feb 31 is not rolled into March');
  assert.match(validateWindow('2026-11-10', '2026-11-01', now).error, /ends before it starts/);
  assert.match(validateWindow('2026-10-01', '2026-10-21', now).error, /already over/);
  assert.match(validateWindow('2026-10-22', '2027-03-01', now).error, /at most/);
  assert.strictEqual(validateWindow('bad', 'x', now).invalid, true);
});

test('a window starting today starts TOMORROW, and says so', () => {
  const now = new Date('2026-10-21T10:00:00');
  const v = validateWindow('2026-10-21', '2026-11-04', now);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.effectiveFrom, '2026-10-22');
  assert.strictEqual(v.startsLater, true);
  assert.strictEqual(validateWindow('2026-10-23', '2026-11-04', now).startsLater, false);
});

// ── pure placement ─────────────────────────────────────────────────────────

test('eligible days skip weekends and Fridays', () => {
  const [mon] = cleanWeek();
  const sun = dateStr(addDays(new Date(`${mon}T12:00:00`), 6));
  const days = eligibleDays([], mon, sun);
  assert.strictEqual(days.length, 4, 'Mon–Thu only');
  assert.ok(days.every(d => new Date(`${d}T12:00:00`).getDay() !== 5));
});

test('spread puts people across the window, not all on day one', () => {
  assert.deepStrictEqual([0, 1, 2, 3].map(i => spreadIndex(i, 4, 8)), [0, 2, 4, 6]);
  assert.deepStrictEqual([0, 1, 2].map(i => spreadIndex(i, 3, 2)), [0, 0, 1], 'more people than days stays in range');
  assert.strictEqual(spreadIndex(0, 0, 0), 0);
});

test('a full target day falls FORWARD first, then back to the window start', () => {
  const days = cleanWeek();
  const full = [];
  // Two 1-2-1s already on day 2 → its cap is reached.
  full.push(ev('a', days[2], '14:00', '14:30', '1-2-1 — Nick / A'), ev('b', days[2], '16:00', '16:30', '1-2-1 — Nick / B'));
  assert.strictEqual(findSlotInDays(full, days, 2, 30).date, days[3]);
  // Day 3 also full → wraps to the start.
  full.push(ev('c', days[3], '14:00', '14:30', '1-2-1 — Nick / C'), ev('d', days[3], '16:00', '16:30', '1-2-1 — Nick / D'));
  assert.strictEqual(findSlotInDays(full, days, 2, 30).date, days[0]);
});

test('the person\'s own leave is never offered', () => {
  const days = cleanWeek();
  const off = new Set([days[0], days[1]]);
  assert.strictEqual(findSlotInDays([], days, 0, 30, off).date, days[2]);
});

test('matchOneToOnes finds by attendee and ignores the Plaud write-up block', () => {
  const [d] = cleanWeek();
  const events = [
    ev('plaud', d, '15:00', '15:05', 'Plaud admin — 1-2-1 — Nick / Hope'),
    ev('real', d, '14:00', '14:30', 'Catch up', { attendees: [{ email: 'hope@x.test' }] }),
    ev('team', d, '11:00', '12:00', 'Team Meeting Hope handover'),
  ];
  const m = matchOneToOnes(events, 'Hope Goodall', 'hope@x.test', `${d}T00:00:00`);
  assert.deepStrictEqual(m.map(e => e.id), ['real']);
});

// ── planWindow ─────────────────────────────────────────────────────────────

test('plan: an existing 1-2-1 is MOVED, someone without one is BOOKED, all inside the window', async (t) => {
  const days = cleanWeek();
  const later = dateStr(addDays(new Date(`${days[0]}T12:00:00`), 21)); // booked well past the window
  stubTeam(t, ['Ann One', 'Bob Two'], {
    events: [ev('BOB-121', later, '14:00', '14:30', '1-2-1 — Nick / Bob', { attendees: [{ email: 'bob@x.test' }] })],
  });
  const r = await booking.planWindow(['Ann One', 'Bob Two'], { from: days[0], to: days[3] });
  assert.strictEqual(r.ok, true, r.error);
  const ann = r.planned.find(p => p.person === 'Ann One');
  const bob = r.planned.find(p => p.person === 'Bob Two');
  assert.strictEqual(ann.mode, 'book');
  assert.strictEqual(bob.mode, 'move');
  assert.strictEqual(bob.current.eventId, 'BOB-121');
  for (const p of r.planned) assert.ok(p.date >= days[0] && p.date <= days[3], `${p.person} inside the window`);
  assert.notStrictEqual(ann.date, bob.date, 'spread across days, not stacked');
});

test('plan: a meeting being moved does not block its own day or count towards the cap', async (t) => {
  const days = cleanWeek();
  // Two 1-2-1s fill day 0's cap — and both are people in this batch.
  stubTeam(t, ['Ann One', 'Bob Two'], {
    events: [
      ev('ANN', days[0], '14:00', '14:30', '1-2-1 — Nick / Ann', { attendees: [{ email: 'ann@x.test' }] }),
      ev('BOB', days[0], '16:00', '16:30', '1-2-1 — Nick / Bob', { attendees: [{ email: 'bob@x.test' }] }),
    ],
  });
  const r = await booking.planWindow(['Ann One', 'Bob Two'], { from: days[0], to: days[0] });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.planned.length, 2, 'both re-placed on the only day, not refused');
  assert.deepStrictEqual(r.skipped, []);
});

test('plan: nobody is pushed outside the window — they are reported by name', async (t) => {
  const days = cleanWeek();
  const names = ['P1 a', 'P2 b', 'P3 c'];
  stubTeam(t, names);
  // One day, cap of 2: the third cannot fit.
  const r = await booking.planWindow(names, { from: days[0], to: days[0] });
  assert.strictEqual(r.planned.length, 2);
  assert.strictEqual(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /no free/);
  assert.ok(r.planned.every(p => p.date === days[0]));
});

test('plan: a new booking with no address is flagged; a bad window is invalid', async (t) => {
  const days = cleanWeek();
  stubTeam(t, ['Nomail Person'], { emails: { 'Nomail Person': null } });
  t.mock.method(require('./contact-directory'), 'resolveName', async () => ({ status: 'unresolved' }));
  const r = await booking.planWindow(['Nomail Person'], { from: days[0], to: days[3] });
  assert.deepStrictEqual(r.withoutInvite, ['Nomail Person']);
  const bad = await booking.planWindow(['Nomail Person'], { from: days[3], to: days[0] });
  assert.strictEqual(bad.invalid, true);
});

// ── applyWindow ────────────────────────────────────────────────────────────

test('apply: a slot vacated by a meeting moving in the same batch is NOT a clash; anything else is', async (t) => {
  const days = cleanWeek();
  const d = days[1];
  stubTeam(t, ['Ann One', 'Bob Two', 'Cat Three'], {
    events: [
      ev('ANN', d, '14:00', '14:30', '1-2-1 — Nick / Ann', { attendees: [{ email: 'ann@x.test' }] }),
      ev('OTHER', d, '10:00', '11:00', 'Board meeting'),
    ],
  });
  const created = [];
  const moved = [];
  t.mock.method(preparedActions, 'prepareCalendarCreate', (p) => { created.push(p); return { ok: true, action: { actionId: `c${created.length}`, payloadHash: 'h', status: 'prepared' } }; });
  t.mock.method(preparedActions, 'prepareCalendarReschedule', (p) => { moved.push(p); return { ok: true, action: { actionId: `m${moved.length}`, payloadHash: 'h', status: 'prepared' } }; });

  const r = await booking.applyWindow([
    // Bob takes Ann's old slot — fine, Ann is moving out of it.
    { person: 'Bob Two', mode: 'book', start: `${d}T14:00:00`, end: `${d}T14:30:00`, email: 'bob@x.test' },
    { person: 'Ann One', mode: 'move', eventId: 'ANN', start: `${days[2]}T14:00:00`, end: `${days[2]}T14:30:00`, searchDays: 60 },
    // Cat onto the board meeting — refused.
    { person: 'Cat Three', mode: 'book', start: `${d}T10:00:00`, end: `${d}T10:30:00`, email: 'cat@x.test' },
    { person: 'Dan Four', mode: 'unchanged', start: `${d}T16:00:00`, end: `${d}T16:30:00` },
  ]);
  assert.strictEqual(r.results[0].person, 'Ann One', 'moves are prepared first');
  assert.strictEqual(r.results.find(x => x.person === 'Ann One').ok, true);
  assert.strictEqual(r.results.find(x => x.person === 'Bob Two').ok, true, 'vacated slot is free');
  const cat = r.results.find(x => x.person === 'Cat Three');
  assert.strictEqual(cat.ok, false);
  assert.match(cat.error, /Board meeting/);
  assert.ok(!r.results.some(x => x.person === 'Dan Four'), 'unchanged rows send nothing');
  assert.strictEqual(moved.length, 1);
  assert.strictEqual(moved[0].origin, '1to1-move', 'stamps and move history still follow');
});

test('apply: an incomplete row is refused alone', async (t) => {
  stubTeam(t, []);
  const r = await booking.applyWindow([{ person: 'X Y', mode: 'move', start: '2099-01-05T14:00:00', end: '2099-01-05T14:30:00' }]);
  assert.strictEqual(r.ok, false);
  assert.match(r.results[0].error, /incomplete/);
});

test('plan: a PAST 1-2-1 is never moved — that person gets a new booking instead', async (t) => {
  const days = cleanWeek();
  const yesterday = dateStr(addDays(new Date(), -1));
  stubTeam(t, ['Ann One'], {
    events: [ev('PAST', yesterday, '14:00', '14:30', '1-2-1 — Nick / Ann', { attendees: [{ email: 'ann@x.test' }] })],
  });
  const r = await booking.planWindow(['Ann One'], { from: days[0], to: days[3] });
  assert.strictEqual(r.planned[0].mode, 'book');
  assert.strictEqual(r.planned[0].current, null);
});
