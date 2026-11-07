'use strict';

/**
 * The Watch lock row on "Her senses" (7 Nov 2026).
 *
 * The laptop's Watch reporter died on 27 Oct and the lock sat blind for eleven
 * days with `mode: on` — the only reader was the Set up list. Pinned: a blind
 * lock that is switched on is a fault (stale, so the watchdog warns); off and
 * shadow are choices (off); a short blind spell is not an outage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { watchLockRow } = require('./signals');

const NOW = new Date('2026-11-07T10:00:00Z');
const at = (minAgo) => new Date(NOW.getTime() - minAgo * 60000).toISOString();
const host = (wl, reportedMinAgo = 1) => [{ host: 'DESKTOP', watchLock: wl, watchLockAt: at(reportedMinAgo) }];

test('no machine runs the lock → off, never stale', () => {
  assert.equal(watchLockRow([{ host: 'Mac', watchLock: null }], NOW).state, 'off');
  assert.equal(watchLockRow([], NOW).state, 'off');
});

test('off and shadow are choices → off', () => {
  assert.equal(watchLockRow(host({ mode: 'off' }), NOW).state, 'off');
  assert.equal(watchLockRow(host({ mode: 'shadow', presence: 'present' }), NOW).state, 'off');
});

test('the live case of 27 Oct: on + blind for days → stale, and it says the reporter stopped', () => {
  const r = watchLockRow(host({ mode: 'on', presence: 'blind', why: 'stale', presenceAgeS: 930725 }), NOW);
  assert.equal(r.state, 'stale');
  assert.match(r.why, /Watch reporter has stopped/);
  assert.match(r.why, /nothing will lock/);
});

test('a short blind spell is not an outage', () => {
  assert.equal(watchLockRow(host({ mode: 'on', presence: 'blind', presenceAgeS: 120 }), NOW).state, 'live');
});

test('the agent itself stopped reporting → stale', () => {
  assert.equal(watchLockRow(host({ mode: 'on', presence: 'present' }, 40), NOW).state, 'stale');
});

test('working lock → live with the Watch state', () => {
  const r = watchLockRow(host({ mode: 'on', presence: 'present', failures: 0 }), NOW);
  assert.equal(r.state, 'live');
  assert.match(r.detail, /present/);
});

test('failed lock calls → error', () => {
  assert.equal(watchLockRow(host({ mode: 'on', presence: 'present', failures: 2 }), NOW).state, 'error');
});
