'use strict';

// Approve / decline a pending JSM approval (30 Oct 2026): the approval id is read
// live, never trusted from the caller; one decision per approval, ever; read back.
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'appr-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db/database');
const ta = require('./ticket-approvals');

test.before(async () => { await db.init(); });
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

const pending = (over) => ({ id: '2931', name: 'Pending Rejection Approval (to CC)', finalDecision: 'pending', canAnswer: true, approvers: ['Chris Middleton'], ...over });

function fakeJira(approvals) {
  let state = approvals.map((a) => ({ ...a }));
  const calls = [];
  return {
    calls,
    list: async () => state.map((a) => ({ ...a })),
    answer: async (key, id, decision) => {
      calls.push({ key, id, decision });
      state = state.map((a) => (a.id === id ? { ...a, finalDecision: decision === 'approve' ? 'approved' : 'declined' } : a));
      return { finalDecision: 'x' };
    },
  };
}

test('pickPending: none, not mine, two, or exactly one', () => {
  assert.match(ta.pickPending([]).why, /no pending approval/);
  assert.match(ta.pickPending([pending({ finalDecision: 'approved' })]).why, /no pending approval/);
  assert.match(ta.pickPending([pending({ canAnswer: false })]).why, /not one Jira lets you answer/);
  assert.match(ta.pickPending([pending(), pending({ id: '2932' })]).why, /2 pending approvals/);
  assert.equal(ta.pickPending([pending()]).approval.id, '2931');
});

test('approve answers the live approval, reads it back, and is never sent twice', async () => {
  const j = fakeJira([pending()]);
  const r = await ta.decide({ key: 'nt-34482', decision: 'approve' }, j);
  assert.equal(r.ok, true); assert.equal(r.outcome, 'confirmed');
  assert.deepEqual(j.calls, [{ key: 'NT-34482', id: '2931', decision: 'approve' }]);
  const again = await ta.decide({ key: 'NT-34482', decision: 'decline' }, j);
  assert.equal(again.ok, false);
  assert.equal(j.calls.length, 1, 'an answered approval is not answered again');
});

test('refusals touch nothing: bad decision, bad key, nothing pending', async () => {
  const j = fakeJira([pending({ id: '5000', finalDecision: 'declined' })]);
  assert.equal((await ta.decide({ key: 'NT-1', decision: 'maybe' }, j)).status, 400);
  assert.equal((await ta.decide({ key: 'nope', decision: 'approve' }, j)).status, 400);
  const r = await ta.decide({ key: 'NT-2', decision: 'decline' }, j);
  assert.equal(r.status, 409);
  assert.equal(j.calls.length, 0);
});

test('a timeout is unknown and blocks a repeat until checked', async () => {
  const j = fakeJira([pending({ id: '7000' })]);
  j.answer = async () => { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; };
  const r = await ta.decide({ key: 'NT-3', decision: 'approve' }, j);
  assert.equal(r.ok, false);
  const again = await ta.decide({ key: 'NT-3', decision: 'approve' }, j);
  assert.equal(again.outcome, 'blocked');
});
