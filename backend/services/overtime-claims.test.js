'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const ot = require('./overtime-claims');
const nova = require('./nova-client');

const exp = {
  month: '2026-10',
  rows: [
    { claimId: 1, agentName: 'Abdi Example', date: '2026-10-07', hours: 2, lateFromEarlierMonth: false },
    { claimId: 2, agentName: 'Abdi Example', date: '2026-09-30', hours: 1.5, lateFromEarlierMonth: true },
    { claimId: 3, agentName: 'Zoe Example', date: '2026-10-20', hours: 3, lateFromEarlierMonth: false },
  ],
  totals: [
    { agentName: 'Abdi Example', agentEmail: 'a@x', claims: 2, hours: 3.5 },
    { agentName: 'Zoe Example', agentEmail: 'z@x', claims: 1, hours: 3 },
  ],
  totalHours: 6.5,
};

test('the payroll email states every person, the total and the late claims', () => {
  const m = ot.payrollEmail(exp);
  assert.strictEqual(m.subject, 'Overtime – October 2026');
  assert.match(m.body, /Abdi Example: 3\.5 hours \(2 claims\)/);
  assert.match(m.body, /Zoe Example: 3 hours \(1 claim\)/);
  assert.match(m.body, /Total: 6\.5 hours\./);
  assert.match(m.body, /1 of these claims is for work in an earlier month/);
  assert.strictEqual(ot.payrollEmail(exp, { additional: true }).subject, 'Overtime – October 2026 (additional)');
});

test('bad input is refused before NOVA is asked', async () => {
  const original = nova.call;
  let calls = 0;
  nova.call = async () => { calls += 1; return {}; };
  try {
    assert.strictEqual((await ot.decide(5, { decision: 'maybe' })).code, 400);
    assert.strictEqual((await ot.decide(5, { decision: 'reject', note: '  ' })).code, 400, 'a rejection needs a reason');
    assert.strictEqual((await ot.decide(0, { decision: 'approve' })).code, 400);
    assert.strictEqual((await ot.claims({ month: '2026-13' })).code, 400);
    assert.strictEqual((await ot.claims({ status: 'paid' })).code, 400);
    assert.strictEqual((await ot.payrollFile('Oct')).code, 400);
    assert.strictEqual(calls, 0);
  } finally { nova.call = original; }
});

test('a decision sends Nick as the decider and passes NOVA\'s refusal through', async () => {
  const original = nova.call;
  let seen = null;
  nova.call = async (path, opts) => {
    seen = { path, body: opts.body };
    const e = new Error('This claim has Working Time warnings — approving it needs a reason, which is recorded.');
    e.status = 400;
    throw e;
  };
  try {
    const r = await ot.decide(7, { decision: 'approve' });
    assert.strictEqual(seen.path, '/api/neuro-bridge/overtime/claims/7/decide');
    assert.deepStrictEqual(seen.body.decidedBy, { name: 'Nick Ward', email: 'nickw@nurtur.tech' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 400);
    assert.match(r.error, /needs a reason/);
  } finally { nova.call = original; }
});

test('a NOVA without the overtime bridge is named as such, not as "Not authenticated"', async () => {
  const original = nova.call;
  try {
    nova.call = async () => { const e = new Error('Not authenticated'); e.status = 401; throw e; };
    assert.match((await ot.claims({})).error, /does not have this overtime bridge route yet/);
    nova.call = async () => { const e = new Error('claim not found'); e.status = 404; throw e; };
    assert.strictEqual((await ot.check(9)).error, 'claim not found', 'a real 404 keeps its own words');
  } finally { nova.call = original; }
});

test('a manual line is refused before NOVA is asked, and goes to NOVA as Nick with the fields as given', async () => {
  const calls = [];
  const orig = nova.call;
  nova.call = async (path, opts) => { calls.push({ path, opts }); return { id: 9, agentName: 'Abdi Example' }; };
  try {
    for (const bad of [
      { date: '2026-09-30', start: '17:30', end: '19:00', reason: 'x' },
      { agentEmail: 'a@x', date: '30/09/2026', start: '17:30', end: '19:00', reason: 'x' },
      { agentEmail: 'a@x', date: '2026-09-30', start: '5pm', end: '19:00', reason: 'x' },
      { agentEmail: 'a@x', date: '2026-09-30', start: '17:30', end: '19:00', reason: '  ' },
    ]) assert.strictEqual((await ot.addManual(bad)).ok, false);
    assert.strictEqual(calls.length, 0);
    const r = await ot.addManual({ agentEmail: 'a@x', date: '2026-09-30', start: '17:30', end: '19:00', reason: 'Missed from September' });
    assert.ok(r.ok);
    assert.strictEqual(calls[0].path, '/api/neuro-bridge/overtime/claims/manual');
    assert.strictEqual(calls[0].opts.method, 'POST');
    assert.deepStrictEqual(
      { ...calls[0].opts.body, decidedBy: calls[0].opts.body.decidedBy.name },
      { agentEmail: 'a@x', date: '2026-09-30', start: '17:30', end: '19:00', reason: 'Missed from September', overrideReason: null, decidedBy: 'Nick Ward' });
  } finally { nova.call = orig; }
});
