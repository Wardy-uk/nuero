'use strict';

/**
 * Keeping what the rolling cache forgets.
 *
 * `calendar_cache` is a ROLLING WINDOW — calendar-sync replaces it per source
 * per window, so an event drops out a few weeks after it happens and is gone.
 * Measured 13 Sep 2026: 105 events spanning 29 Aug → 25 Sep, and nothing older
 * anywhere in the database.
 *
 * That made every question about the SHAPE of his weeks unanswerable, and none
 * of it is recoverable retrospectively — which is the whole argument for the
 * table this pins.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-calhist-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const db = require('../db/database');

test.before(async () => { await db.init(); });

const ev = (over = {}) => ({
  event_id: 'e1', start_time: '2026-09-14T10:00', end_time: '2026-09-14T10:15',
  subject: 'Team Standup', is_all_day: 0, show_as: 'busy', attendees_other: 1,
  organizer: 'nick', source: 'graph', ...over,
});

test('an occurrence is kept', () => {
  assert.equal(db.archiveCalendarEvents([ev()]), 1);
  const rows = db.getCalendarHistory({ sinceDays: 3650 });
  assert.ok(rows.some(r => r.event_id === 'e1' && r.subject === 'Team Standup'));
});

test('⚠ it is IDEMPOTENT — every sync offers everything it can see', () => {
  // Called on every pass, so a repeat must fold rather than duplicate.
  const before = db.getCalendarHistory({ sinceDays: 3650 }).length;
  assert.equal(db.archiveCalendarEvents([ev(), ev(), ev()]), 0);
  assert.equal(db.getCalendarHistory({ sinceDays: 3650 }).length, before);
});

test('⚠ a RECURRING meeting is one row per OCCURRENCE', () => {
  // "Does the Tuesday standup actually happen" is a question about instances,
  // not about the series — so the key is (event_id, start_time).
  db.archiveCalendarEvents([ev({ start_time: '2026-09-21T10:00' })]);
  const mine = db.getCalendarHistory({ sinceDays: 3650 }).filter(r => r.event_id === 'e1');
  assert.equal(mine.length, 2);
});

test('⚠ `attendees_other` stays THREE-VALUED — null is not a solo block', () => {
  db.archiveCalendarEvents([ev({ event_id: 'unknown-attendees', attendees_other: null })]);
  const r = db.getCalendarHistory({ sinceDays: 3650 }).find(x => x.event_id === 'unknown-attendees');
  assert.equal(r.attendees_other, null, 'we could not tell, and that is not "nobody else"');

  db.archiveCalendarEvents([ev({ event_id: 'solo', attendees_other: 0 })]);
  const solo = db.getCalendarHistory({ sinceDays: 3650 }).find(x => x.event_id === 'solo');
  assert.equal(solo.attendees_other, 0, 'whereas this one genuinely is a solo block');
});

test('a row with no id or no start is skipped, not stored half-formed', () => {
  const before = db.getCalendarHistory({ sinceDays: 3650 }).length;
  assert.equal(db.archiveCalendarEvents([{ subject: 'nameless' }, { event_id: 'x' }, null]), 0);
  assert.equal(db.getCalendarHistory({ sinceDays: 3650 }).length, before);
});

test('an empty or missing batch is a no-op, not an error', () => {
  for (const bad of [[], null, undefined, 'nope']) {
    assert.equal(db.archiveCalendarEvents(bad), 0, JSON.stringify(bad));
  }
});

test('⚠ the raw reader matches the writer\'s column names', () => {
  // A mapped shape (`startTime` vs `start_time`) would archive a table of nulls
  // while reporting success — the camelCase trap this repo has hit three times.
  db.upsertCalendarEvent({ id: 'shape-check', subject: 'Shape', start: '2026-09-15T09:00', end: '2026-09-15T09:30', source: 'graph' });
  const raw = db.getAllCalendarEvents();
  const row = raw.find(r => r.event_id === 'shape-check');
  assert.ok(row, 'the reader returns raw rows');
  assert.equal(db.archiveCalendarEvents([row]), 1, 'and the writer accepts them unchanged');
  const kept = db.getCalendarHistory({ sinceDays: 3650 }).find(r => r.event_id === 'shape-check');
  assert.equal(kept.subject, 'Shape', 'with the subject intact rather than a row of nulls');
});

test('⚠ history SURVIVES the cache being cleared — that is the whole point', () => {
  db.upsertCalendarEvent({ id: 'doomed', subject: 'About to roll out', start: '2026-09-16T11:00', source: 'graph' });
  db.archiveCalendarEvents(db.getAllCalendarEvents());
  db.clearCalendarCache('graph');
  assert.equal(db.getAllCalendarEvents().some(r => r.event_id === 'doomed'), false, 'gone from the cache');
  assert.ok(db.getCalendarHistory({ sinceDays: 3650 }).some(r => r.event_id === 'doomed'), 'kept in history');
});
