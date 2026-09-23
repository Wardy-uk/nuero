'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { msSyncIssue } = require('./watchdog');

// Local-time constructors throughout: the rule reads getHours()/getDay(), so a
// fixture built from a UTC string would shift an hour under BST.
const wedAt = (h, m) => new Date(2026, 8, 23, h, m); // Wed 23 Sep 2026
const minsBefore = (d, n) => new Date(d.getTime() - n * 60000).toISOString();

test('flags a sync older than an hour inside the working window', () => {
  const now = wedAt(16, 30);
  const issue = msSyncIssue(minsBefore(now, 195), now); // the 13:15 → 16:30 gap
  assert.strictEqual(issue.key, 'ms-sync:stale');
  assert.strictEqual(issue.level, 'critical', 'only criticals are pushed');
  assert.match(issue.detail, /195 min/);
});

test('positive control: a recent sync is not flagged', () => {
  const now = wedAt(16, 30);
  assert.strictEqual(msSyncIssue(minsBefore(now, 45), now), null);
  assert.strictEqual(msSyncIssue(minsBefore(now, 60), now), null, 'exactly an hour is still fine');
});

test('never having succeeded is flagged, not read as fine', () => {
  const issue = msSyncIssue(null, wedAt(11, 0));
  assert.strictEqual(issue.level, 'critical');
  assert.strictEqual(msSyncIssue('not a date', wedAt(11, 0)).key, 'ms-sync:stale');
});

test('quiet outside the window the job runs in', () => {
  const stale = minsBefore(wedAt(18, 45), 0); // last run of the day
  assert.strictEqual(msSyncIssue(stale, wedAt(7, 0)), null, 'before 09:30');
  assert.strictEqual(msSyncIssue(stale, wedAt(9, 0)), null, 'the 08:15 run has not had its hour');
  assert.strictEqual(msSyncIssue(stale, wedAt(21, 0)), null, 'evening');
  assert.strictEqual(msSyncIssue(stale, new Date(2026, 8, 26, 12, 0)), null, 'Saturday');
  // …and the same stale stamp IS flagged once the window opens, so the
  // quiet cases above are the window and not a broken rule.
  assert.ok(msSyncIssue(minsBefore(wedAt(10, 0), 120), wedAt(10, 0)));
});
