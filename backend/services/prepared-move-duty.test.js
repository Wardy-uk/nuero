'use strict';

// exec.dutyPermits — the ONE off-duty exception, and how narrow it is (21–22 Oct 2026).
// Off duty, only a v2 private PROMISE draft whose immutable firstOrigin is exactly
// 'manual' may go ahead; never on leave, never with duty unreadable. A promise key
// alone is NOT evidence of a manual start. (The route-level proof, through the view,
// /request, /confirm and the executor, is routes/prepared-moves-off-duty.test.js.)

const test = require('node:test');
const assert = require('node:assert/strict');
const { dutyPermits } = require('./prepared-move-exec');

const rec = ({ contract = 'prepared-move-v2', origin = 'answer', firstOrigin = 'manual', privateDraft = { label: 'x' }, promiseKey = 'promise:322', kind = 'project-note' } = {}) => ({
  packet: { contract, origin, ...(firstOrigin === null ? {} : { firstOrigin }), selected: { kind, ...(privateDraft ? { privateDraft } : {}), source: promiseKey ? { promiseKey } : {} } },
});
const OFF = { onDuty: false, why: 'off-duty' };

test('on duty: any move', () => {
  assert.equal(dutyPermits({ onDuty: true, why: 'working' }, rec({ privateDraft: null, firstOrigin: 'scan' })), true);
  assert.equal(dutyPermits({ onDuty: true, why: 'working' }, rec()), true);
});
test('off duty: a v2 private promise draft Nick started himself (firstOrigin manual) — and nothing else', () => {
  assert.equal(dutyPermits(OFF, rec()), true, 'manual, re-planned by answers: eligible');
  assert.equal(dutyPermits(OFF, rec({ origin: 'manual' })), true, 'manual, as first prepared: eligible');
  assert.equal(dutyPermits(OFF, rec({ firstOrigin: 'scan' })), false, 'scan-created');
  assert.equal(dutyPermits(OFF, rec({ firstOrigin: 'mcp' })), false, 'MCP/API-created');
  assert.equal(dutyPermits(OFF, rec({ firstOrigin: 'answer' })), false, 'an answer is never a start');
  assert.equal(dutyPermits(OFF, rec({ firstOrigin: null, origin: 'manual' })), false, 'no firstOrigin recorded → held (never inferred from origin)');
  assert.equal(dutyPermits(OFF, rec({ firstOrigin: 'Manual' })), false, 'exactly "manual"');
  assert.equal(dutyPermits(OFF, rec({ promiseKey: null })), false, 'not linked to a promise');
  assert.equal(dutyPermits(OFF, rec({ privateDraft: null })), false, 'an ordinary promise move');
  for (const kind of ['meeting-prep', 'email-reply']) assert.equal(dutyPermits(OFF, rec({ kind, privateDraft: null })), false, kind);
  assert.equal(dutyPermits(OFF, rec({ contract: 'prepared-move-v1' })), false, 'never a v1 packet');
  assert.equal(dutyPermits(OFF, null), false);
});
test('on leave, or duty unreadable: nothing, not even his manual private draft', () => {
  assert.equal(dutyPermits({ onDuty: false, why: 'leave' }, rec()), false);
  assert.equal(dutyPermits({ onDuty: false, why: 'unknown' }, rec()), false);
  assert.equal(dutyPermits(null, rec()), false);
  assert.equal(dutyPermits(undefined, rec()), false);
});
