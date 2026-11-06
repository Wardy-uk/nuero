'use strict';

/**
 * A capacity card says what its task IS (Nick, 6 Nov 2026: "detail is very
 * lacking"). The card's title was 400 characters of task text cut off mid-word,
 * its only line "Sized at 8h.", and nothing said the task was a NEURO suggestion
 * he had accepted. The detail was all recorded; these pin that it is shown.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { shortTaskTitle } = require('./decision-engine');
const { describeTaskProvenance } = require('../../shared/task-provenance.cjs');

test('a long task is named by its first clause, at a word boundary', () => {
  assert.equal(shortTaskTitle('Build succession plan — cover for HoTS and emerging team leads'), 'Build succession plan');
  const long = "Add a Jira custom field (or parse ticket description) to tag blockers: 'waiting_external', 'needs_info', 'genuine_bug', 'user_error'. NOVA checks this before routing.";
  const s = shortTaskTitle(long);
  assert.ok(s.length <= 90, s);
  assert.match(s, /…$/);
  assert.equal(shortTaskTitle('Short one'), 'Short one');
});

test('an accepted NEURO suggestion says so, rather than "Recorded as capability-suggestion"', () => {
  const p = describeTaskProvenance({ source: 'capability-suggestion', created_at: '2026-10-15 09:02:38' }, { now: new Date('2026-11-06T14:00:00') });
  assert.match(p.how, /What I could do for you/);
  assert.equal(p.known, true);
});
