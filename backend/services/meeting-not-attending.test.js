'use strict';
// "I'm not going" must reach every reader of the RAW calendar (22 Oct 2026).
// Nick said he was not attending the MWU BYM Call; the meeting card, the
// "prep now" suggestion and a prepared meeting-prep move all still fired,
// because they read calendar_cache directly and only the attention context
// applied the override.
const path = require('path');
const os = require('os');
const fs = require('fs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mna-'));
process.env.NEURO_DB_PATH = path.join(dir, 'agent.db');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const mf = require('./meeting-finish');

test('isSkipped reads both shapes and only a notAttending entry', () => {
  const entries = { 'id:E1::2026-10-22T16:00:00.0000000': { notAttending: true, scheduledEnd: '2099-01-01T00:00:00Z' } };
  assert.equal(mf.isSkipped({ event_id: 'E1', start_time: '2026-10-22T16:00:00.0000000' }, entries), true, 'raw cache row');
  assert.equal(mf.isSkipped({ id: 'E1', start: '2026-10-22T16:00:00.0000000' }, entries), true, 'attention shape');
  assert.equal(mf.isSkipped({ event_id: 'E1', start_time: '2026-10-29T16:00:00.0000000' }, entries), false, 'next week’s occurrence is untouched');
  const finished = { 'id:E1::2026-10-22T16:00:00.0000000': { at: 'x', scheduledEnd: '2099-01-01T00:00:00Z' } };
  assert.equal(mf.isSkipped({ event_id: 'E1', start_time: '2026-10-22T16:00:00.0000000' }, finished), false, 'finished-early is not "not going"');
  assert.equal(mf.isSkipped({ event_id: 'E1', start_time: '2026-10-22T16:00:00.0000000' }, null), false);
});

test('a meeting he is not going to produces no meeting card (so no prep nudge, no prepared move)', async () => {
  await require('../db/database').init();
  const pad = (n) => String(n).padStart(2, '0');
  const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00.0000000`;
  const soon = new Date(Date.now() + 40 * 60000);
  const end = new Date(Date.now() + 70 * 60000);
  const row = (id) => ({ event_id: id, subject: 'MWU BYM Call', start_time: local(soon), end_time: local(end), show_as: 'busy', attendees_other: 1 });

  const r = mf.finish({ id: 'skip', start: row('skip').start_time, end: row('skip').end_time, subject: 'MWU BYM Call', attendeesOther: true }, new Date(), { notAttending: true });
  assert.equal(r.ok, true, r.reason);

  const { collectMeetings } = require('./decision-engine');
  const items = collectMeetings({ calendar: [row('skip'), row('keep')] });
  const ids = items.map((i) => i.id);
  assert.ok(ids.includes('cal-keep'), 'positive control: an ordinary meeting is still listed');
  assert.ok(!ids.includes('cal-skip'), 'the skipped occurrence is gone');

  assert.equal(mf.skippedNow(row('skip')), true);
  mf.resume(r.key);
  assert.equal(mf.skippedNow(row('skip')), false, 'resume brings it back');
});

test('meeting prep stops being offered once the meeting has started', async () => {
  const { recheck } = require('./prepared-move-planner');
  const london = (ms) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  };
  const packet = (startLocal) => ({ selected: { kind: 'meeting-prep', title: 'MWU BYM Call', source: { eventId: 'E9' }, forum: { start: startLocal } } });
  const deps = (startLocal) => ({ meetingEvent: () => ({ event_id: 'E9', subject: 'MWU BYM Call', start_time: `${startLocal}:00.0000000`, show_as: 'busy', attendees_other: 1 }) });
  const past = london(Date.now() - 60 * 60000);
  const future = london(Date.now() + 3 * 60 * 60000);
  assert.equal((await recheck(packet(future), { deps: deps(future) })).ok, true, 'positive control: a meeting still to come keeps its prep');
  const r = await recheck(packet(past), { deps: deps(past) });
  assert.equal(r.ok, false);
  assert.match(r.why, /already started/);
});

test('the "Also open" list drops prep for a meeting that has started', () => {
  const { outstandingFrom } = require('./prepared-move-view');
  const rec = (id, start) => ({ id, version: 1, moveKey: `k-${id}`, packet: { origin: 'scan', selected: { kind: 'meeting-prep', plan: 'draft', title: id, forum: { start } } } });
  const now = Date.parse('2026-10-22T16:20:00Z'); // 17:20 London
  const rows = outstandingFrom([rec('past', '2026-10-22T16:00'), rec('later', '2026-10-23T10:00')], now);
  const ids = rows.map((r) => r.recordId);
  assert.ok(ids.includes('later'), 'positive control');
  assert.ok(!ids.includes('past'));
});
