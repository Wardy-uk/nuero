'use strict';

// exec.dutyPermits — the ONE off-duty exception, and how narrow it is (26 Oct 2026).
// A private draft Nick started from his promise card may be saved outside working
// hours; nothing else moves off duty, and leave or an unreadable duty holds everything.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dutyPermits } = require('./prepared-move-exec');

const rec = (selected, contract = 'prepared-move-v2') => ({ packet: { contract, selected } });
const PRIVATE = rec({ privateDraft: { label: 'x' }, source: { promiseKey: 'promise:322' } });

test('on duty: any move', () => {
  assert.equal(dutyPermits({ onDuty: true, why: 'working' }, rec({ kind: 'project-note' })), true);
  assert.equal(dutyPermits({ onDuty: true, why: 'working' }, PRIVATE), true);
});
test('off duty (outside working hours): ONLY a promise-card private draft', () => {
  const off = { onDuty: false, why: 'off-duty' };
  assert.equal(dutyPermits(off, PRIVATE), true);
  assert.equal(dutyPermits(off, rec({ kind: 'project-note', source: { promiseKey: 'promise:322' } })), false, 'an ordinary promise move stays held');
  assert.equal(dutyPermits(off, rec({ privateDraft: { label: 'x' }, source: {} })), false, 'a private draft not from a promise card stays held');
  assert.equal(dutyPermits(off, rec({ privateDraft: { label: 'x' }, source: { promiseKey: 'promise:322' } }, 'prepared-move-v1')), false, 'never a v1 packet');
  assert.equal(dutyPermits(off, null), false);
});
test('on leave, or duty unreadable: nothing, not even his private draft', () => {
  assert.equal(dutyPermits({ onDuty: false, why: 'leave' }, PRIVATE), false);
  assert.equal(dutyPermits({ onDuty: false, why: 'unknown' }, PRIVATE), false);
  assert.equal(dutyPermits(null, PRIVATE), false);
  assert.equal(dutyPermits(undefined, PRIVATE), false);
});
