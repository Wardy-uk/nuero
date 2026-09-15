'use strict';

/**
 * Apple Calendar and Reminders ingest.
 *
 * The test that matters most is the delete scoping. calendar-sync is
 * replace-by-window and runs every few minutes; before `source` existed it
 * emptied the WHOLE table, so every Apple event would have been wiped minutes
 * after the phone pushed it — silently, leaving a diary that looked exactly like
 * the work-only one it had always been.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ⚠ NEVER the live agent.db (mistakes.md, 13 Aug).
process.env.NEURO_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-apple-')), 'scratch.db',
);

const db = require('../db/database');
const apple = require('./apple-ingest');

test.before(async () => { await db.init(); });

// ── The delete scoping ───────────────────────────────────────────────────────

test('a Graph sync does not delete Apple events', () => {
  db.upsertCalendarEvent({
    id: 'graph-1', subject: 'Team standup', start: '2026-09-01T09:00:00',
    end: '2026-09-01T09:15:00', showAs: 'busy', source: 'graph',
  });
  apple.ingestCalendar({
    from: '2026-09-01T00:00:00', to: '2026-09-02T00:00:00',
    events: [{ id: 'a1', title: 'Parents evening', start: '2026-09-01T18:00:00', end: '2026-09-01T19:00:00' }],
  });

  // This is exactly what calendar-sync does on every run, every few minutes.
  db.clearCalendarCache('graph');

  const left = db.getCalendarEvents('2026-09-01T00:00:00', '2026-09-02T00:00:00');
  assert.equal(left.length, 1, 'the Apple event must survive a Graph sync');
  assert.equal(left[0].subject, 'Parents evening');
  assert.equal(left[0].source, 'apple');
});

test('clearCalendarCache refuses to run without a source', () => {
  // A default of 'graph' would make the dangerous call the easy one to write,
  // and the dangerous call is the one that silently empties the table.
  assert.throws(() => db.clearCalendarCache(), /requires a source/);
});

test('an Apple push replaces only its own window', () => {
  db.upsertCalendarEvent({
    id: 'apple:old', subject: 'Last month', start: '2026-08-01T10:00:00',
    end: '2026-08-01T11:00:00', showAs: 'busy', source: 'apple',
  });
  apple.ingestCalendar({
    from: '2026-09-10T00:00:00', to: '2026-09-11T00:00:00',
    events: [{ id: 'a2', title: 'Dentist', start: '2026-09-10T14:00:00', end: '2026-09-10T14:30:00' }],
  });

  // Outside the pushed window, so it is not the push's business to delete it.
  const august = db.getCalendarEvents('2026-08-01T00:00:00', '2026-08-02T00:00:00');
  assert.equal(august.length, 1, 'a narrower push must not delete a wider one');
});

test('an empty push with a window clears it; without one it is refused', () => {
  apple.ingestCalendar({
    from: '2026-09-20T00:00:00', to: '2026-09-21T00:00:00',
    events: [{ id: 'a3', title: 'Gone', start: '2026-09-20T09:00:00', end: '2026-09-20T10:00:00' }],
  });
  // An empty diary is a real answer and must clear the window.
  apple.ingestCalendar({ from: '2026-09-20T00:00:00', to: '2026-09-21T00:00:00', events: [] });
  assert.equal(db.getCalendarEvents('2026-09-20T00:00:00', '2026-09-21T00:00:00').length, 0);

  // No window is the shape a broken client sends, and honouring it would empty
  // the personal calendar on a malformed request.
  assert.equal(apple.ingestCalendar({ events: [] }).ok, false);
  assert.equal(apple.ingestCalendar({ from: 'x', to: 'y' }).ok, false);
});

// ── Normalising ──────────────────────────────────────────────────────────────

test('attendeesOther stays THREE-valued through normalisation', () => {
  // Scriptable does not always populate attendees. Coercing that unknown to
  // false would tell context-state "solo block" about a real meeting.
  assert.equal(apple.normaliseEvent({ id: 'x', start: 's', attendeesOther: true }).attendeesOther, true);
  assert.equal(apple.normaliseEvent({ id: 'x', start: 's', attendeesOther: false }).attendeesOther, false);
  assert.equal(apple.normaliseEvent({ id: 'x', start: 's' }).attendeesOther, undefined);
});

test('an unusable event is dropped rather than half-written', () => {
  // Every consumer reads the cache as the truth about the diary, so a row with
  // no start is worse than a missing one.
  assert.equal(apple.normaliseEvent({ title: 'no id or start' }), null);
  assert.equal(apple.normaliseEvent({ id: 'x' }), null);

  const res = apple.ingestCalendar({
    from: '2026-09-25T00:00:00', to: '2026-09-26T00:00:00',
    events: [{ id: 'ok', title: 'Fine', start: '2026-09-25T09:00:00' }, { title: 'broken' }],
  });
  assert.equal(res.stored, 1);
  // Never silent — a push where half the events were unusable is a broken client.
  assert.equal(res.rejected, 1);
});

test('an Apple id can never collide with a Graph one', () => {
  const row = apple.normaliseEvent({ id: 'abc', start: '2026-09-01T09:00:00' });
  assert.ok(String(row.id).startsWith('apple:abc'));
});

test('⚠ every occurrence of a RECURRING event survives', () => {
  // EventKit gives every occurrence of a recurring event the SAME identifier —
  // a weekly Saturday commitment is one identifier and many occurrences. With
  // the identifier alone as the key, calendar_cache.event_id is UNIQUE and the
  // upsert is INSERT OR REPLACE, so they all collapsed into a single row and a
  // repeating event appeared in the diary exactly once. Nothing threw; the
  // calendar was just quietly emptier than reality — the worst possible
  // direction for the one thing that answers "is Nick free".
  const res = apple.ingestCalendar({
    from: '2026-11-01T00:00:00', to: '2026-11-30T00:00:00',
    events: [
      { id: 'weekly-sat', title: 'Parkrun', start: '2026-11-07T09:00:00', end: '2026-11-07T10:00:00' },
      { id: 'weekly-sat', title: 'Parkrun', start: '2026-11-14T09:00:00', end: '2026-11-14T10:00:00' },
      { id: 'weekly-sat', title: 'Parkrun', start: '2026-11-21T09:00:00', end: '2026-11-21T10:00:00' },
    ],
  });

  assert.equal(res.stored, 3, 'three occurrences, three rows');
  const held = db.getCalendarEvents('2026-11-01T00:00:00', '2026-11-30T00:00:00');
  assert.equal(held.filter((e) => e.subject === 'Parkrun').length, 3);
});

test('artefact calendars are skipped, and reported per calendar', () => {
  // Measured from the live device: two subscribed UK holiday feeds are both on,
  // which is why every bank holiday arrived twice. working-days already knows
  // the bank holidays from gov.uk and is what the day planner actually consults,
  // so these rows were duplicated noise in the table that answers "is Nick free".
  const res = apple.ingestCalendar({
    from: '2027-01-01T00:00:00', to: '2027-01-05T00:00:00',
    events: [
      { id: 'h1', title: 'New Year', start: '2027-01-01T00:00:00', isAllDay: true, calendar: 'UK Holidays' },
      { id: 'h2', title: 'New Year', start: '2027-01-01T00:00:00', isAllDay: true, calendar: 'Holidays in United Kingdom' },
      { id: 'g1', title: 'Run 5k', start: '2027-01-02T09:00:00', calendar: 'Garmin Workouts' },
      { id: 'real', title: 'Lunch with Liz', start: '2027-01-03T12:00:00', calendar: 'ward.nickj@gmail.com' },
    ],
  });

  assert.equal(res.stored, 1, 'only the real commitment survives');
  assert.deepEqual(res.skippedCalendars, {
    'UK Holidays': 1, 'Holidays in United Kingdom': 1, 'Garmin Workouts': 1,
  });

  const held = db.getCalendarEvents('2027-01-01T00:00:00', '2027-01-05T00:00:00');
  assert.deepEqual(held.map((e) => e.subject), ['Lunch with Liz']);
});

test('⚠ an event whose calendar is UNKNOWN is KEPT', () => {
  // The opposite of the Reminders whitelist, deliberately. The failure
  // directions are opposite: a shopping list flooding the task store is the risk
  // there, so unknown is skipped; a MISSING event making a busy day look free is
  // the risk here — the exact bug that took two rounds to find — so unknown is
  // kept.
  const res = apple.ingestCalendar({
    from: '2027-02-01T00:00:00', to: '2027-02-02T00:00:00',
    events: [{ id: 'u1', title: 'Unattributed but real', start: '2027-02-01T10:00:00' }],
  });
  assert.equal(res.stored, 1);
  assert.deepEqual(res.skippedCalendars, {});
});

test('a birthday is NOT an artefact', () => {
  // Real personal context, and exactly what a second brain should know about.
  const res = apple.ingestCalendar({
    from: '2027-03-01T00:00:00', to: '2027-03-02T00:00:00',
    events: [{ id: 'b1', title: "Mum's birthday", start: '2027-03-01T00:00:00', isAllDay: true, calendar: 'Birthdays' }],
  });
  assert.equal(res.stored, 1);
});

test('the skip list is configurable, and can be emptied', () => {
  const saved = process.env.APPLE_SKIP_CALENDARS;
  // An explicit empty string means "skip nothing" — distinct from unset, which
  // takes the measured defaults.
  process.env.APPLE_SKIP_CALENDARS = '';
  const res = apple.ingestCalendar({
    from: '2027-04-01T00:00:00', to: '2027-04-02T00:00:00',
    events: [{ id: 'k1', title: 'Kept', start: '2027-04-01T09:00:00', calendar: 'Nozbe' }],
  });
  assert.equal(res.stored, 1);
  if (saved === undefined) delete process.env.APPLE_SKIP_CALENDARS;
  else process.env.APPLE_SKIP_CALENDARS = saved;
});

test('the calendars the phone could see are reported, and absent is not empty', () => {
  // "My Saturday event is missing" was unanswerable: an empty diary and a
  // calendar iOS will not let Scriptable read produced an identical result.
  const withList = apple.ingestCalendar({
    from: '2026-12-01T00:00:00', to: '2026-12-02T00:00:00',
    events: [{ id: 'x', title: 'Thing', start: '2026-12-01T09:00:00', calendar: 'Home' }],
    calendars: ['Home', 'Work', 'UK Holidays'],
  });
  assert.deepEqual(withList.visibleCalendars, ['Home', 'Work', 'UK Holidays']);
  assert.deepEqual(withList.byCalendar, { Home: 1 });

  // An older copy of the script does not send them at all. `null` keeps that
  // distinct from "the phone can see no calendars", which is a real and much
  // more alarming answer.
  const without = apple.ingestCalendar({
    from: '2026-12-03T00:00:00', to: '2026-12-04T00:00:00', events: [],
  });
  assert.equal(without.visibleCalendars, null);
});

test('an all-day event is free, not a wall across the day', () => {
  const row = apple.normaliseEvent({ id: 'b', start: '2026-09-01', isAllDay: true });
  assert.equal(row.showAs, 'free', 'a birthday must not block the afternoon');
});

// ── Reminders ────────────────────────────────────────────────────────────────

test('⚠ only whitelisted lists are ingested, and the rest are REPORTED', () => {
  // The first run pulled in every list — a shopping list of 15 items, none of
  // them a task. The deeper problem was that they could never leave: NEURO
  // cannot write to iCloud, so a shopping item is ticked off in a shop and
  // NEURO's copy stays open for ever. An append-only store with nothing closing
  // it, growing every sync — the inbox_items failure exactly.
  const res = apple.ingestReminders({
    reminders: [
      { title: 'Call the school', list: 'Reminders' },
      { title: 'peanut butter', list: 'Shopping' },
      { title: 'Mugs', list: 'Shopping' },
      { title: 'orphan with no list' },
    ],
  });

  assert.equal(res.created, 1, 'only the built-in list is ingested by default');
  // Reported, not silently dropped: an ingest that discards most of its input
  // looks identical to one that received nothing, so "why has my reminder not
  // appeared" has to be answerable without guessing.
  assert.deepEqual(res.skippedLists, { Shopping: 2, '(no list)': 1 });
  assert.deepEqual(res.seenLists, { Reminders: 1, Shopping: 2, '(no list)': 1 });

  const taskStore = require('./task-store');
  const texts = taskStore.listTasks({ status: 'open' }).map((t) => t.text);
  assert.ok(texts.includes('Call the school'));
  assert.equal(texts.includes('peanut butter'), false);
});

test('a reminder with no list is never ingested', () => {
  // Scriptable does not always expose `calendar`. Treating unknown as the
  // default list would quietly reopen the door the whitelist exists to close.
  const res = apple.ingestReminders({ reminders: [{ title: 'unattributed' }] });
  assert.equal(res.created, 0);
});

test('⚠ the same meeting from both calendars is stored ONCE, and Graph wins', () => {
  // Today nothing duplicates, because Nick's work account is not in the iOS
  // Calendar app — but that is a setting, not a guarantee. The day it changes,
  // every work meeting arrives a second time under an apple: id, nothing throws,
  // and the diary is silently twice as full for time-fit and the day planner.
  db.upsertCalendarEvent({
    id: 'graph-dupe', subject: 'Weekly Ops Review', start: '2026-10-01T10:00:00',
    end: '2026-10-01T11:00:00', showAs: 'busy', source: 'graph',
  });

  const res = apple.ingestCalendar({
    from: '2026-10-01T00:00:00', to: '2026-10-02T00:00:00',
    events: [
      // The phone's copy of the same Exchange meeting — a different id, because
      // the two systems share no identifier and never will.
      { id: 'apple-copy', title: 'Weekly Ops Review', start: '2026-10-01T10:00:00', end: '2026-10-01T11:00:00' },
      { id: 'apple-only', title: 'Swimming lesson', start: '2026-10-01T17:00:00', end: '2026-10-01T18:00:00' },
    ],
  });

  assert.equal(res.stored, 1);
  assert.equal(res.duplicates, 1, 'named rather than quietly dropped');

  const day = db.getCalendarEvents('2026-10-01T00:00:00', '2026-10-02T00:00:00');
  assert.equal(day.filter((e) => e.subject === 'Weekly Ops Review').length, 1);
  // Graph's copy is the survivor: it carries response status and a real attendee
  // list, where the Apple copy usually cannot say if anyone else is even in it.
  assert.equal(day.find((e) => e.subject === 'Weekly Ops Review').source, 'graph');
  assert.ok(day.some((e) => e.subject === 'Swimming lesson'), 'a genuinely personal event still lands');
});

test('the LIST decides the domain, and personal is the default', () => {
  delete process.env.APPLE_WORK_LISTS;
  assert.equal(apple.domainForList('Shopping'), 'personal');
  assert.equal(apple.domainForList(null), 'personal');

  process.env.APPLE_WORK_LISTS = 'Nurtur, Work Stuff';
  assert.equal(apple.domainForList('Nurtur'), 'work');
  assert.equal(apple.domainForList('  nurtur  '), 'work', 'matching is case and space insensitive');
  assert.equal(apple.domainForList('Shopping'), 'personal');
  delete process.env.APPLE_WORK_LISTS;
});

test('a reminder becomes a personal task with its due date', () => {
  const res = apple.ingestReminders({
    reminders: [{ title: 'Renew the car tax', dueDate: '2026-09-05', list: 'Reminders' }],
  });
  assert.equal(res.created, 1);

  const taskStore = require('./task-store');
  const task = taskStore.listTasks({ status: 'open' }).find(t => t.text === 'Renew the car tax');
  assert.ok(task);
  assert.equal(task.domain, 'personal');
  assert.equal(task.source, 'apple-reminders');
  assert.equal(task.due_date, '2026-09-05');
});

test('⚠ a completed task is NOT resurrected by the next push', () => {
  // This is the loop that would otherwise make the whole feature unusable.
  // NEURO cannot write to iCloud, so a reminder Nick ticked off in NEURO stays
  // open in Apple and keeps being pushed. It is safe only because createTask
  // folds into the existing row WHATEVER its status, and the fold never touches
  // status. Verified here rather than assumed.
  const taskStore = require('./task-store');
  apple.ingestReminders({ reminders: [{ title: 'Post the parcel', list: 'Reminders' }] });

  const created = taskStore.listTasks({ status: 'open' }).find(t => t.text === 'Post the parcel');
  taskStore.updateTask(created.id, { status: 'done' });

  const again = apple.ingestReminders({ reminders: [{ title: 'Post the parcel', list: 'Reminders' }] });
  assert.equal(again.created, 0, 'it must fold, not create a second task');
  assert.equal(again.folded, 1);

  const after = taskStore.getTask(created.id);
  assert.equal(after.status, 'done', 'the completed task must stay completed');
});

test('a completed reminder is skipped, never created-then-closed', () => {
  // Creating a task to immediately close it would put work in the wins ledger
  // that nobody did today — "a win is DETECTED, not declared".
  const res = apple.ingestReminders({
    reminders: [{ title: 'Something already done', isCompleted: true, list: 'Reminders' }],
  });
  assert.equal(res.created, 0);
  assert.equal(res.skippedCompleted, 1);

  const taskStore = require('./task-store');
  assert.equal(
    taskStore.listTasks({ status: 'all', includeDone: true }).some(t => t.text === 'Something already done'),
    false,
  );
});

test('a titleless reminder is rejected and reported', () => {
  // On an ingested list, or the whitelist would skip them before the title check
  // and the test would pass for the wrong reason.
  const res = apple.ingestReminders({
    reminders: [{ notes: 'no title', list: 'Reminders' }, { title: '   ', list: 'Reminders' }],
  });
  assert.equal(res.created, 0);
  assert.equal(res.rejected.length, 2);
});

// ── Staleness ────────────────────────────────────────────────────────────────

test('a phone that stopped pushing is visibly stale', () => {
  // A push-based feed fails SILENTLY by definition — the phone simply stops
  // calling, and a frozen calendar answers every question exactly as a live one
  // does. Same species as the Jira cache that read as current for seven weeks.
  const s = apple.status();
  assert.equal(s.known, true);
  assert.ok('stale' in s);
  assert.ok('ageHours' in s);
});

// ── "I could not look" is not "there is nothing there" ───────────────────────
//
// Measured 13 Sep 2026: the native app pushed `0 calendar(s) visible` 323 times
// with no EventKit permission, and every one of those was a well-formed payload
// that would have CLEARED the window and answered ok. The three cases below are
// the whole rule, and the middle one is the only refusal.

test('a push from a phone that can see no calendars is refused, and clears nothing', () => {
  const from = '2026-10-01T00:00:00';
  const to = '2026-10-02T00:00:00';
  apple.ingestCalendar({
    from, to, calendars: ['Home'],
    events: [{ id: 'keep-1', title: 'Dentist', start: '2026-10-01T09:00:00', end: '2026-10-01T09:30:00', calendar: 'Home' }],
  });
  const dentists = () => db.getCalendarEvents(from, to).filter((e) => e.subject === 'Dentist');
  assert.equal(dentists().length, 1, 'setup: the event should be stored');

  const res = apple.ingestCalendar({ from, to, calendars: [], events: [] });

  assert.equal(res.ok, false, 'a phone that can see nothing has not read an empty diary');
  assert.equal(res.reason, 'no-calendar-access');
  assert.equal(res.cleared, false);
  assert.equal(
    dentists().length, 1,
    'the window must survive a push that could not look',
  );
});

test('a phone that CAN look and finds nothing still clears the window', () => {
  const from = '2026-10-03T00:00:00';
  const to = '2026-10-04T00:00:00';
  apple.ingestCalendar({
    from, to, calendars: ['Home'],
    events: [{ id: 'gone-1', title: 'Cancelled thing', start: '2026-10-03T09:00:00', end: '2026-10-03T09:30:00', calendar: 'Home' }],
  });
  const cancelled = () => db.getCalendarEvents(from, to).filter((e) => e.subject === 'Cancelled thing');
  assert.equal(cancelled().length, 1, 'setup');

  // A real empty answer. Refusing this would leave a cancelled event in the
  // diary for ever, which is the failure in the other direction.
  const res = apple.ingestCalendar({ from, to, calendars: ['Home'], events: [] });

  assert.equal(res.ok, true);
  assert.equal(cancelled().length, 0, 'a real empty window must clear');
});

test('a client too old to report its calendars is not accused of having no access', () => {
  const from = '2026-10-05T00:00:00';
  const to = '2026-10-06T00:00:00';
  // `calendars` absent entirely — unknown, and not evidence of a refusal.
  const res = apple.ingestCalendar({ from, to, events: [] });
  assert.equal(res.ok, true, 'unknown must stay lenient');
  assert.equal(apple.status().access, 'unknown');
});

// ── The attempt and the rows are separate facts ──────────────────────────────

test('status tells a refused push apart from a phone that has gone quiet', () => {
  apple.ingestCalendar({
    from: '2026-10-07T00:00:00', to: '2026-10-08T00:00:00',
    calendars: [], events: [],
  });
  const st = apple.status();

  assert.equal(st.access, 'none', 'the cause is permission, not silence');
  assert.ok(st.lastAttemptAt, 'a push that stored nothing still left a trace');
  assert.equal(st.visibleCalendars, 0);
});

test('a push that lands events reports access as ok', () => {
  apple.ingestCalendar({
    from: '2026-10-09T00:00:00', to: '2026-10-10T00:00:00',
    calendars: ['Home', 'Birthdays'],
    events: [{ id: 'ok-1', title: 'Swim', start: '2026-10-09T07:00:00', end: '2026-10-09T08:00:00', calendar: 'Home' }],
  });
  const st = apple.status();
  assert.equal(st.access, 'ok');
  assert.equal(st.visibleCalendars, 2);
});

// ── Local wall-clock, never UTC ──────────────────────────────────────────────
//
// The BST bug, third repo. Live on 13 Sep 2026 the moment the native client
// first got permission: a 13:55 appointment stored `12:55Z` and rendered 12:55,
// and that day's all-day event stored `2026-09-12T23:00:00Z` — filed under
// yesterday and absent from today's agenda. Everything downstream SLICES the
// time out of this string, so a `Z` is not a harmless extra.

test('a UTC stamp is converted to local wall-clock, and loses the Z', () => {
  assert.equal(apple.toLocalWallClock('2026-09-13T12:55:00.000Z'), '2026-09-13T13:55:00');
});

test('an all-day event lands on the right DAY, not the one before', () => {
  // Midnight BST is 23:00Z the previous day. Stored raw, the event is filed
  // under yesterday and drops out of today's agenda entirely — which is how a
  // busy day reads as free, the worst direction for this table.
  assert.equal(apple.toLocalWallClock('2026-09-12T23:00:00.000Z'), '2026-09-13T00:00:00');
});

test('a WINTER stamp does not move — this is a conversion, not a blind +1', () => {
  // The test that tells a real timezone conversion from a hardcoded offset.
  assert.equal(apple.toLocalWallClock('2026-01-15T09:00:00Z'), '2026-01-15T09:00:00');
});

test('a wall-clock string is left exactly alone', () => {
  // The Scriptable client sent these deliberately. Re-reading one as UTC is the
  // same bug running in the other direction.
  assert.equal(apple.toLocalWallClock('2026-09-05T09:00:00'), '2026-09-05T09:00:00');
});

test('an explicit offset is honoured too', () => {
  assert.equal(apple.toLocalWallClock('2026-09-13T13:55:00+01:00'), '2026-09-13T13:55:00');
});

test('an unreadable time is returned unchanged, never guessed', () => {
  // A time nobody can read is not an invitation to invent one.
  assert.equal(apple.toLocalWallClock('not a date'), 'not a date');
  assert.equal(apple.toLocalWallClock(''), '');
});

test('an ingested event is STORED as wall-clock, all the way to the row', () => {
  // The pure function is not the promise — the row is. This is the assertion
  // that would have caught it: the live payload, end to end.
  const from = '2026-09-13T00:00:00';
  const to = '2026-09-14T00:00:00';
  apple.ingestCalendar({
    from, to, calendars: ['ward.nickj@gmail.com'],
    events: [{
      id: 'tz-1', title: 'Appointment', calendar: 'ward.nickj@gmail.com',
      start: '2026-09-13T12:55:00.000Z', end: '2026-09-13T13:55:00.000Z',
    }],
  });

  const row = db.getCalendarEvents(from, to).find((e) => e.subject === 'Appointment');
  assert.ok(row, 'the event should be stored');
  assert.equal(row.start_time, '2026-09-13T13:55:00');
  assert.equal(row.end_time, '2026-09-13T14:55:00');
  assert.ok(!/Z$/.test(row.start_time), 'no zone marker may reach the row');
});

// ── Which app pushed ─────────────────────────────────────────────────────────
//
// Both apps read ONE EventKit store on one device, so they stay under a single
// `apple` source — splitting them would put every event in the diary twice.
// What the tag buys is attributability: with iOS 17 partial access the two can
// legitimately see different calendars, and a count flipping between 23 and 3
// must name who reported which.

test('the pushing app is recorded and reported', () => {
  apple.ingestCalendar({
    from: '2026-11-01T00:00:00', to: '2026-11-02T00:00:00',
    calendars: ['Home'], client: 'saim',
    events: [{ id: 'c-1', title: 'Swim', calendar: 'Home', start: '2026-11-01T07:00:00', end: '2026-11-01T08:00:00' }],
  });
  assert.equal(apple.status().client, 'saim');

  apple.ingestCalendar({
    from: '2026-11-03T00:00:00', to: '2026-11-04T00:00:00',
    calendars: ['Home'], client: 'neuro', events: [],
  });
  assert.equal(apple.status().client, 'neuro');
});

test('a refused push still says who was refused', () => {
  // The case this exists for: one app has access and the other does not, and
  // "something pushed blind" is useless without knowing which.
  apple.ingestCalendar({
    from: '2026-11-05T00:00:00', to: '2026-11-06T00:00:00',
    calendars: [], events: [], client: 'saim',
  });
  const st = apple.status();
  assert.equal(st.access, 'none');
  assert.equal(st.client, 'saim');
});

test('an unnamed or junk client is null, never a guess', () => {
  // A client that did not say is UNKNOWN. Defaulting to whichever app seems
  // likely would put a name on a push nobody can trace.
  apple.ingestCalendar({
    from: '2026-11-07T00:00:00', to: '2026-11-08T00:00:00',
    calendars: ['Home'], events: [],
  });
  assert.equal(apple.status().client, null);

  apple.ingestCalendar({
    from: '2026-11-09T00:00:00', to: '2026-11-10T00:00:00',
    calendars: ['Home'], events: [], client: '../../etc/passwd',
  });
  assert.equal(apple.status().client, null, 'a junk tag is refused, not stored');
});

test('two apps pushing the same diary do not double it', () => {
  // The whole safety argument for sharing the sensor: same store, same device,
  // same row key, replace-by-window. Two syncers cost a repeated read.
  const from = '2026-11-11T00:00:00';
  const to = '2026-11-12T00:00:00';
  const event = { id: 'dup-1', title: 'Dentist', calendar: 'Home', start: '2026-11-11T09:00:00', end: '2026-11-11T09:30:00' };

  apple.ingestCalendar({ from, to, calendars: ['Home'], events: [event], client: 'neuro' });
  apple.ingestCalendar({ from, to, calendars: ['Home'], events: [event], client: 'saim' });

  const rows = db.getCalendarEvents(from, to).filter((e) => e.subject === 'Dentist');
  assert.equal(rows.length, 1, 'one diary, one row, whichever app pushed it');
});
