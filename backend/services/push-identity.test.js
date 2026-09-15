'use strict';

// A push must be identified by the THING it is about, never by its wording.
//
// The regression this pins: `webpush.sendToAll` derives identity as
// `data.key || title`, and 29 of 32 call sites pass no `key`. For a watchdog
// alert the title fallback is correct -- a reworded disk-space warning is the
// same interruption. For an EVENT it is fatal: "Starting in 10 min" is the
// title of every meeting alert ever sent, so every meeting collapsed into one
// attention record, the first notified, and every meeting since was refused as
// "already notified, nothing changed".
//
// Measured on the live push log on 15 Sep 2026, over 129 attempts since 8 Sep:
//   meeting_alert  27 suppressed   0 sent
//   day_plan        9 suppressed   0 sent
//   meeting_prep    4 suppressed   3 sent   <- its title carries the meeting
//                                              name, which is the control that
//                                              proves the mechanism.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lifecycle = require('./attention-lifecycle');

const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

test('two different meetings are two different records', () => {
  const a = lifecycle.dedupeKeyForPush('meeting_alert', 'meeting_alert:AAA');
  const b = lifecycle.dedupeKeyForPush('meeting_alert', 'meeting_alert:BBB');
  assert.notEqual(a, b, 'distinct events must not share an attention record');
});

test('the title fallback is what collapsed them, and still would', () => {
  // Documents the failure rather than the fix: identical refs -- which is what
  // a constant title produces -- still yield one key. That is correct for an
  // alert and is exactly why an event must pass its own key.
  const a = lifecycle.dedupeKeyForPush('meeting_alert', '\u{1F4C5} Starting in 10 min');
  const b = lifecycle.dedupeKeyForPush('meeting_alert', '\u{1F4C5} Starting in 10 min');
  assert.equal(a, b);
});

test('a pool type still collapses to its nudge, deliberately', () => {
  // Unchanged by this fix. A standing "you have urgent email" fact is ONE
  // ongoing thing and must not re-interrupt per arrival; changing that is a
  // product decision, not a bug fix.
  assert.equal(lifecycle.dedupeKeyForPush('email', 'anything'), 'nudge:email');
  assert.equal(lifecycle.dedupeKeyForPush('email', 'something else'), 'nudge:email');
});

test('every event-shaped push names its own instance', () => {
  const briefing = read('briefing.js');
  const planner = read('day-planner.js');

  // Positive control: if these call sites move or are renamed, the assertions
  // below would pass by absence and prove nothing.
  assert.match(briefing, /type: 'meeting_alert'/, 'control: meeting_alert push still exists');
  assert.match(briefing, /type: 'brief'/, 'control: brief push still exists');
  assert.match(planner, /type: 'day_plan'/, 'control: day_plan push still exists');

  const meetingCall = briefing.slice(briefing.indexOf("type: 'meeting_alert'"));
  assert.match(meetingCall.slice(0, 200), /key: `meeting_alert:\$\{id\}`/,
    'a meeting alert must be keyed on the event, not on its constant title');

  const briefCall = briefing.slice(briefing.indexOf("type: 'brief'"));
  assert.match(briefCall.slice(0, 200), /key: `brief:\$\{brief\.ts\}`/,
    'one morning brief is not the next');

  const planCall = planner.slice(planner.indexOf("type: 'day_plan'"));
  assert.match(planCall.slice(0, 200), /key: `day_plan:\$\{dateKey\}:\$\{window\.key\}`/,
    'one half-day is not the next');
});
