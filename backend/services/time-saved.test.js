'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-timesaved-'));
process.env.NEURO_DB_PATH = path.join(scratch, 'agent.db');

const db = require('../db/database');
const ts = require('./time-saved');
const report = require('./neuro-weekly-report');

test.before(async () => { await db.init(); });

test('every area the weekly report counts as acted has an estimate', () => {
  const acting = report.SOURCES.filter((s) => !s.informational).map((s) => s.id);
  const missing = acting.filter((id) => !ts.DEFAULTS[id]);
  assert.deepEqual(missing, [], `give these an estimate in time-saved DEFAULTS: ${missing.join(', ')}`);
});

test('time saved is count × estimate, informational areas save nothing, and it says estimated', () => {
  const ests = [{ id: 'one-to-ones', minutes: 5, what: 'x' }, { id: 'router', minutes: 10, what: 'y' }];
  const r = ts.apply([
    { id: 'one-to-ones', acted: 3 },
    { id: 'router', acted: 0 },
    { id: 'pushes', acted: 40, informational: true },
  ], ests);
  assert.equal(r.timeSaved.minutes, 15);
  assert.equal(r.timeSaved.estimated, true);
  assert.equal(r.areas[0].minutesSaved, 15);
  assert.equal(r.areas[2].minutesSaved, 0);
});

test('an override wins, null resets, junk is refused and changes nothing', () => {
  db.setState(ts.KEY, '{}');
  ts.setEstimate('router', 20);
  assert.equal(ts.minutesFor('router'), 20);
  for (const bad of [-1, 241, 'abc', '', true, NaN]) {
    assert.throws(() => ts.setEstimate('router', bad), /minutes must be/);
  }
  assert.equal(ts.minutesFor('router'), 20);
  assert.throws(() => ts.setEstimate('nope', 3), /unknown area/);
  ts.setEstimate('router', null);
  assert.equal(ts.minutesFor('router'), ts.DEFAULTS.router.minutes);
});

test('words', () => {
  assert.equal(ts.words(0), 'no time');
  assert.equal(ts.words(0.4), 'under a minute');
  assert.equal(ts.words(12.4), '12 min');
  assert.equal(ts.words(125), '2h 05m');
});

test('the composed report carries the total', () => {
  const r = report.compose({ week: '2026-11-02', now: new Date('2026-11-09T12:00:00Z') });
  assert.ok(r.timeSaved, 'timeSaved present');
  assert.equal(r.timeSaved.estimated, true);
});
