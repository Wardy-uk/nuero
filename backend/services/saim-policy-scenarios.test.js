'use strict';

// The SAiM Attention Policy decision table (15 Oct 2026). Each scenario runs the
// real NEURO candidate composer and the real SAiM policy; the contract's §8
// table is generated from the same runs (scripts/saim-policy-table.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { SCENARIOS, row, iso } = require('./saim-policy-scenarios');

for (const s of SCENARIOS) {
  test(`scenario ${s.id}: ${s.name}`, () => {
    const r = row(s);
    const d = r.decision;
    const e = s.expect;
    assert.equal(d.lead.rule, e.rule, `rule — trace: ${r.trace}`);
    assert.equal(d.lead.ref, e.lead);
    assert.equal(d.protected ? d.protected.ref : null, e.protected);
    if (e.recommended) assert.equal(d.recommended && d.recommended.say, e.recommended);
    if (e.judgementEffective) assert.equal(d.judgement[0].effectiveDeadline, e.judgementEffective);
    if (e.heldIncludes) assert.ok(d.held.some((h) => h.ref === e.heldIncludes), 'held');
    if (e.excludedWork) assert.ok(d.scope.excluded.work > 0, 'work counted, not shown');
    if (e.maxActions) assert.ok((d.recommended ? 1 : 0) + d.alternatives.length <= e.maxActions, 'phone actions bounded');
    if (e.reviewType) assert.ok(d.review.unclassified.some((u) => u.type === e.reviewType && u.ledThisDecision === (e.reviewLed !== false)), 'listed for review');
    // Every decision explains itself: exactly one rule applied, and it is the lead's.
    assert.equal(d.trace.filter((t) => t.applies).length, 1);
    assert.equal(d.trace.find((t) => t.applies).rule, d.lead.rule);
  });
}

test('scenario 4: at home in the evening no work candidate leads, is held, or is judged', () => {
  const d = row(SCENARIOS.find((s) => s.id === '4')).decision;
  assert.equal(d.held.count, 1, 'only the home/family item that did not lead');
  assert.equal(d.judgement.length, 0);
  assert.ok(d.scope.excluded.work >= 3);
});

test('scenario 2: the effective deadline is what decides, not the raw expiry', () => {
  const after = row(SCENARIOS.find((s) => s.id === '2a')).decision;
  assert.match(after.trace.find((t) => t.rule === 'S4 deadline inside the block').why, /effective deadline 18:00 today/);
  assert.equal(after.judgement[0].deadline, iso(6, 0, 16));
  const inside = row(SCENARIOS.find((s) => s.id === '2b')).decision;
  assert.equal(inside.recommended.handOff, 'Actions, in NEURO on the desktop');
});

test('scenario 5: the same block meets a family item (held) and a hazard (interrupts)', () => {
  const fam = row(SCENARIOS.find((s) => s.id === '5a')).decision;
  assert.equal(fam.held.find((h) => h.ref === 'pd:anniv').returns, 'at 15:30');
  const haz = row(SCENARIOS.find((s) => s.id === '5b')).decision;
  assert.match(haz.lead.why, /Kitchen leak/);
});

test('scenario 6: unreadable data never reads as a quiet day, on either scope', () => {
  for (const id of ['6a', '6b']) {
    const d = row(SCENARIOS.find((s) => s.id === id)).decision;
    assert.match(d.lead.why, /isn’t an all-clear/);
    assert.equal(d.recommended, null);
  }
});

test('scenario 7: the phone shows the same lead as the desktop, with fewer actions and held as a count', () => {
  const phone = row(SCENARIOS.find((s) => s.id === '7')).decision;
  const desk = row(SCENARIOS.find((s) => s.id === '3')).decision;
  assert.equal(phone.lead.rule, desk.lead.rule);
  assert.equal(phone.alternatives.length, 1);
  assert.equal(typeof phone.held.count, 'number');
});

test('scenario 8: an unclassified "critical" leads under its own rule and is listed for review — never as classified risk', () => {
  const d = row(SCENARIOS.find((s) => s.id === '8')).decision;
  assert.equal(d.trace.find((t) => t.rule === 'S2 critical risk').applies, false);
  assert.match(d.lead.why, /hasn’t been classified yet/);
  assert.match(d.trace.find((t) => t.rule.startsWith('S2u')).why, /type “payroll_cutoff” is unclassified/);
  assert.deepEqual(d.review.unclassified.map((u) => u.type), ['payroll_cutoff']);
  assert.ok(d.review.action);
  const clean = row(SCENARIOS.find((s) => s.id === '1')).decision;
  assert.deepEqual(clean.review.unclassified, [], 'nothing to review when every type is classified');
});

test('scenario 9: in a running meeting an S2u item stays visible as possible risk but does not lead; classified S2 still does', () => {
  const s2u = row(SCENARIOS.find((x) => x.id === '9a')).decision;
  assert.equal(s2u.lead.rule, 'S3 meeting');
  const held = s2u.held.find((h) => h.ref === 'item:r-payroll_cutoff');
  assert.equal(held.why, 'possible risk — not yet classified');
  assert.equal(held.returns, 'at 15:00');
  const order = s2u.trace.map((t) => t.rule.split(' ')[0]);
  assert.deepEqual(order, ['S1', 'S2', 'S3'], 'S3 decides before S2u is reached');
  const s2 = row(SCENARIOS.find((x) => x.id === '9b')).decision;
  assert.equal(s2.lead.rule, 'S2 critical risk');
  assert.equal(s2.protected.kind, 'meeting', 'the meeting stays the protected context');
});

test('rule order: S1 → S2 → S3 → S2u → S3a → S4 → S5', () => {
  const d = row(SCENARIOS.find((x) => x.id === '1')).decision;
  assert.deepEqual(d.trace.map((t) => t.rule.split(' ')[0]).slice(0, 7), ['S1', 'S2', 'S3', 'S2u', 'S3a', 'S4', 'S5']);
});
