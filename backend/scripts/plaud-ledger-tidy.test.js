'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { planTidy, applyPlan } = require('./plaud-ledger-tidy');

const STATE = {
  syncedRecordings: { s1: { syncedAt: '2026-09-22T07:04:44Z' }, s2: { syncedAt: '2026-09-08T15:00:00Z' } },
  pendingRecordings: { p1: { startAt: '2026-10-12T09:00:00Z' } },
  pendingSpeakers: { s1: { firstSeenAt: '2026-09-22T07:19:09Z', attempts: 3 }, g1: { firstSeenAt: '2026-10-09T13:15:10Z' } },
  failedRecordings: {
    g1: { failedAt: '2026-10-09T13:20:42Z', message: '404' },
    s2: { failedAt: '2026-10-14T08:20:11Z', message: '404' },
    live: { failedAt: '2026-08-12T13:22:22Z', message: 'timed out' },
    p1: { failedAt: '2026-09-13T11:45:38Z', message: '500' },
    unknown: { failedAt: '2026-07-09T15:34:52Z', message: 'timed out' },
  },
};
const EVIDENCE = {
  s1: { plaud: 'present', activeNotes: 10 },
  s2: { plaud: 'present', activeNotes: 12 },
  g1: { plaud: 'gone', activeNotes: 0 },
  live: { plaud: 'present', activeNotes: 0 },
  p1: { plaud: 'present', activeNotes: 0 },
};
const decision = (items, ledger, id) => items.find((i) => i.ledger === ledger && i.id === id).change;

test('removes only what is proven stale, and keeps everything still owed', () => {
  const items = planTidy(STATE, EVIDENCE);
  assert.equal(decision(items, 'pendingSpeakers', 's1'), 'remove');
  assert.equal(decision(items, 'pendingSpeakers', 'g1'), 'remove');
  assert.equal(decision(items, 'failedRecordings', 'g1'), 'remove');
  assert.equal(decision(items, 'failedRecordings', 's2'), 'remove');
  assert.equal(decision(items, 'failedRecordings', 'live'), 'keep', 'PLAUD still holds it and NEURO has no note');
  assert.equal(decision(items, 'failedRecordings', 'p1'), 'keep', 'untranscribed recordings stay owed');
  assert.equal(decision(items, 'failedRecordings', 'unknown'), 'keep', 'no evidence is never a removal');
});

test('a gone recording that still has a vault note is not removed', () => {
  const items = planTidy(STATE, { ...EVIDENCE, g1: { plaud: 'gone', activeNotes: 1 } });
  assert.equal(decision(items, 'failedRecordings', 'g1'), 'keep');
});

test('applying the plan never touches synced or pending, and never mutates its input', () => {
  const before = JSON.stringify(STATE);
  const next = applyPlan(STATE, planTidy(STATE, EVIDENCE));
  assert.equal(JSON.stringify(STATE), before);
  assert.deepEqual(next.syncedRecordings, STATE.syncedRecordings);
  assert.deepEqual(next.pendingRecordings, STATE.pendingRecordings);
  assert.deepEqual(Object.keys(next.failedRecordings).sort(), ['live', 'p1', 'unknown']);
  assert.deepEqual(Object.keys(next.pendingSpeakers), []);
});
