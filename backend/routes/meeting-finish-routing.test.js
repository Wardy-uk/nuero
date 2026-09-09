'use strict';

/**
 * "That's finished" — over real HTTP, against a real calendar cache.
 *
 * Real HTTP because a green service suite says nothing about routing, and this
 * router already carries `/records/:id/act`, which is exactly the shape that
 * swallows a literal path registered after it. It also drives the whole chain
 * the button actually walks — cache row → `attention.currentMeetingEvent` →
 * `meeting-finish` → `agent_state` → back through `_calendarInput` — because
 * every one of those seams is a place the override could be dropped in silence.
 *
 *   run: node --test backend/routes/meeting-finish-routing.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mfin-')), 'a.db');

const db = require('../db/database');
const attention = require('../services/attention');
const meetingFinish = require('../services/meeting-finish');
const router = require('./attention');

let server;
let base;

const iso = (ms) => new Date(ms).toISOString();

// A meeting running RIGHT NOW, with other people in it — the only kind SARA
// goes quiet for, and so the only kind this button may release.
function seedRunningMeeting(over = {}) {
  const now = Date.now();
  db.upsertCalendarEvent(Object.assign({
    id: 'evt-live',
    subject: 'Nurtur - Micom (Commercials)',
    start: iso(now - 10 * 60000),
    end: iso(now + 20 * 60000),
    isAllDay: false,
    location: 'Microsoft Teams Meeting',
    organizer: 'someone@nurtur.tech',
    showAs: 'busy',
    // ⚠ Exactly true. Three-valued in the column, and a solo focus block must
    // never be releasable — there was nothing to release.
    attendeesOther: true,
  }, over));
}

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/attention', router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test.beforeEach(() => {
  // Scoped to the source the fixture writes — `clearCalendarCache` refuses an
  // unscoped wipe on purpose, since the work and personal diaries share a table.
  db.clearCalendarCache('graph');
  db.setState(meetingFinish.STATE_KEY, JSON.stringify({}));
});

const post = (p, body) => fetch(`${base}/api/attention/${p}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
});

test('positive control — the fixture really does read as a running meeting', () => {
  // Without this, every refusal below would pass on a cache the route cannot
  // see, which proves only that the seeding is broken.
  seedRunningMeeting();
  const live = attention.currentMeetingEvent(new Date());
  assert.ok(live, 'the seeded meeting is the one running now');
  assert.equal(live.subject, 'Nurtur - Micom (Commercials)');
});

test('finishing early releases the quiet state, end to end', async () => {
  seedRunningMeeting();
  const res = await post('meeting/finished');
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.match(json.key, /^id:evt-live::/);

  // ⚠ THE POINT OF THE WHOLE THING: the feed must now agree. Asserting only on
  // the route's own answer would pass on a handler that stored a row nothing
  // reads — which is how a button comes to look like it worked.
  assert.equal(attention.currentMeetingEvent(new Date()), null, 'he is no longer in it');
});

test('⚠ pressing it again is refused rather than silently re-storing', async () => {
  seedRunningMeeting();
  assert.equal((await post('meeting/finished')).status, 200);
  const again = await post('meeting/finished');
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /not in a meeting/);
});

test('⚠ a STALE key is refused — a polled screen can be holding the last meeting', async () => {
  seedRunningMeeting();
  const res = await post('meeting/finished', { key: 'id:evt-from-this-morning::2026-01-01T09:00:00Z' });
  assert.equal(res.status, 409);
  const json = await res.json();
  assert.match(json.error, /not the meeting running now/);
  // It names the right one, so the client can retry without guessing.
  assert.match(json.key, /evt-live/);
  assert.ok(attention.currentMeetingEvent(new Date()), 'and nothing was released');
});

test('⚠ a SOLO block cannot be finished — there was no quiet state to release', async () => {
  // Half Nick's diary is blocked-out work. SARA never went quiet for it, so a
  // button that appears to release something would be doing nothing at all.
  seedRunningMeeting({ attendeesOther: false });
  const res = await post('meeting/finished');
  assert.equal(res.status, 409, 'not a meeting the route can even see');
  assert.equal(db.getState(meetingFinish.STATE_KEY), '{}');
});

test('⚠ with no meeting running there is nothing to finish', async () => {
  const res = await post('meeting/finished');
  assert.equal(res.status, 409);
  assert.equal(db.getState(meetingFinish.STATE_KEY), '{}');
});

test('⚠ THE CALENDAR IS NOT TOUCHED — the meeting still ends when it says', async () => {
  // It is not Nick's to shorten: other people are in it and Graph would mail
  // every one of them. This records where HE is.
  seedRunningMeeting();
  const before = db.getCalendarEvents('2000-01-01T00:00', '2100-01-01T00:00');
  await post('meeting/finished');
  const after = db.getCalendarEvents('2000-01-01T00:00', '2100-01-01T00:00');
  assert.deepEqual(after, before, 'the cache row is byte-identical');
});

test('the way back really works, over HTTP', async () => {
  seedRunningMeeting();
  const { key } = await (await post('meeting/finished')).json();
  assert.equal(attention.currentMeetingEvent(new Date()), null);

  const res = await post('meeting/resume', { key });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).cleared, true);
  assert.ok(attention.currentMeetingEvent(new Date()), 'he is back in it');
});

test('resume without a key is a 400, not a silent clear-everything', async () => {
  const res = await post('meeting/resume', {});
  assert.equal(res.status, 400);
});

test('⚠ the literal /meeting paths are not swallowed by /records/:id/act', async () => {
  // Express matches in registration order and this codebase has shipped a
  // literal path parsed as a parameter before.
  const res = await post('meeting/finished');
  const json = await res.json();
  assert.ok(!/unknown action|invalid action/i.test(json.error || ''),
    'it reached the meeting handler, not the lifecycle act handler');
});
