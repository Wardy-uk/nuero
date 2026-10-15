'use strict';

// C6 (15 Oct 2026): versioned attention contracts refuse incompatible shapes.
// The live Pi's `neuro-candidates-v1` and the branch's carried one NAME over two
// SHAPES; every consumer must check name + supported version + shape and REFUSE
// anything else — never fall back, never read part of a payload, and never turn
// "I couldn't read it" into S11 "nothing needs you".

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../shared/attention-contracts.cjs');
const NC = require('./neuro-candidates');
const POL = require('../../saim/policy/attention-policy.cjs');
const SC = require('./saim-policy-scenarios');

const NOW = SC.at(14, 20);
const clone = (x) => JSON.parse(JSON.stringify(x));
const good = () => clone(SC.SCENARIOS.find((s) => s.id === '8').build().candidates); // carries an attention-item + block

/** A real v1 payload as the live Pi emits it: same top level, no risk split on items. */
function v1Shape() {
  const p = good();
  p.contract = 'neuro-candidates-v1';
  for (const c of p.candidates) if (c.facts) { delete c.facts.risk; delete c.facts.riskBasis; delete c.facts.urgency; delete c.facts.neuroUrgency; }
  return p;
}

const assertRefusedSafely = (d, why) => {
  assert.equal(d.contract, 'saim-attention-v1', why);
  assert.ok(d.refused, `${why}: carries refused`);
  assert.equal(d.lead.rule, 'S1 blind', `${why}: an unreadable input is blind, never another rule`);
  assert.notEqual(d.lead.rule, 'S11 nothing', `${why}: never "nothing needs you"`);
  assert.match(d.lead.why, /isn’t an all-clear/, why);
  assert.equal(d.lead.ref, null, `${why}: no candidate was read`);
  assert.equal(d.protected, null);
  assert.deepEqual(d.judgement, []);
  assert.equal(d.recommended, null, `${why}: nothing is offered from an unread payload`);
  assert.deepEqual(d.alternatives, []);
  assert.deepEqual(C.SUPPORTED['neuro-candidates'], d.refused.supported);
  assert.equal(C.checkAttention(d).ok, true, `${why}: the refusal is itself a valid decision`);
};

test('the producer emits neuro-candidates-v2 and every scenario’s output validates', () => {
  assert.equal(NC.CONTRACT, 'neuro-candidates-v2');
  for (const s of SC.SCENARIOS) {
    const { candidates, decision } = s.build();
    assert.equal(candidates.contract, 'neuro-candidates-v2', s.id);
    const r = C.checkCandidates(candidates);
    assert.equal(r.ok, true, `${s.id}: ${r.reason}`);
    assert.equal(decision.refused, undefined, `${s.id}: a valid payload is decided, not refused`);
    const a = C.checkAttention(decision);
    assert.equal(a.ok, true, `${s.id}: ${a.reason}`);
  }
});

test('a v1 payload is refused safely — by name, and as a shape even when relabelled v2', () => {
  const v1 = v1Shape();
  assert.equal(C.checkCandidates(v1).reason, 'unsupported contract');
  assertRefusedSafely(POL.decide(v1, { surface: 'work-desktop', now: NOW }), 'v1 by name');
  const disguised = { ...v1Shape(), contract: 'neuro-candidates-v2' };
  const r = C.checkCandidates(disguised);
  assert.equal(r.ok, false);
  assert.match(r.reason, /facts\.risk missing \(v1 shape\?\)/);
  assertRefusedSafely(POL.decide(disguised, { surface: 'work-desktop', now: NOW }), 'v1 shape labelled v2');
});

test('a future or unknown contract is refused, never read as the nearest known one', () => {
  for (const name of ['neuro-candidates-v3', 'neuro-candidates', 'saim-attention-v1', 'NEURO-CANDIDATES-V2', '', null, undefined, 2]) {
    const p = good(); p.contract = name;
    assertRefusedSafely(POL.decide(p, { surface: 'work-desktop', now: NOW }), `contract=${String(name)}`);
  }
});

test('missing or wrong-typed required fields are refused', () => {
  const cases = {
    'no input': undefined,
    'null input': null,
    'array input': [],
    'string input': 'neuro-candidates-v2',
    'no candidates list': (() => { const p = good(); delete p.candidates; return p; })(),
    'candidates not a list': (() => { const p = good(); p.candidates = {}; return p; })(),
    'no constraints': (() => { const p = good(); delete p.constraints; return p; })(),
    'poolReadable missing': (() => { const p = good(); delete p.constraints.poolReadable; return p; })(),
    'poolReadable a string': (() => { const p = good(); p.constraints.poolReadable = 'true'; return p; })(),
    'homeReadable a number': (() => { const p = good(); p.constraints.homeReadable = 1; return p; })(),
    'no readAt': (() => { const p = good(); delete p.readAt; return p; })(),
    'unknown candidate kind': (() => { const p = good(); p.candidates[0].kind = 'mystery'; return p; })(),
    'candidate without id': (() => { const p = good(); delete p.candidates[0].id; return p; })(),
    'candidate without facts': (() => { const p = good(); delete p.candidates[0].facts; return p; })(),
    'candidate without sphere': (() => { const p = good(); delete p.candidates[0].sphere; return p; })(),
    'attention-item with an invented riskBasis': (() => { const p = good(); p.candidates.find((c) => c.kind === 'attention-item').facts.riskBasis = 'probably'; return p; })(),
  };
  for (const [name, input] of Object.entries(cases)) {
    assert.equal(C.checkCandidates(input).ok, false, name);
    assertRefusedSafely(POL.decide(input, { surface: 'work-desktop', now: NOW }), name);
  }
});

test('the refusal never reads any candidate — not even a critical one', () => {
  const p = good(); // scenario 8 would lead S2u from its critical item
  p.constraints.poolReadable = 'yes';
  const d = POL.decide(p, { surface: 'work-desktop', now: NOW });
  assertRefusedSafely(d, 'partial payload');
  assert.ok(!JSON.stringify(d).includes('Payroll'), 'no title from the refused payload reaches the decision');
});

test('unknown EXTRA fields are ignored, and the decision is identical', () => {
  const plain = POL.decide(good(), { surface: 'work-desktop', now: NOW });
  const extra = good();
  extra.futureField = { anything: true };
  extra.constraints.somethingNew = 42;
  for (const c of extra.candidates) { c.addedLater = 'x'; c.facts.newFact = 1; }
  assert.equal(C.checkCandidates(extra).ok, true);
  const d = POL.decide(extra, { surface: 'work-desktop', now: NOW });
  assert.deepEqual({ ...d, trace: null }, { ...plain, trace: null });
});

test('refusal holds on every surface, with held shaped for the manifestation', () => {
  for (const surface of Object.keys(POL.SURFACES)) {
    const d = POL.decide(v1Shape(), { surface, now: NOW });
    assertRefusedSafely(d, surface);
    assert.equal(d.surface.id, surface);
    if (POL.SURFACES[surface].manifestation.held === 'count') assert.deepEqual(d.held, { count: 0 });
    else assert.deepEqual(d.held, []);
  }
});

test('an unknown surface is still a caller error (throws), not a refusal', () => {
  assert.throws(() => POL.decide(good(), { surface: 'toaster', now: NOW }), /unknown surface/);
});

test('checkAttention refuses incompatible decisions (for the resolver and adapter)', () => {
  const ok = POL.decide(good(), { surface: 'work-desktop', now: NOW });
  assert.equal(C.checkAttention(ok).ok, true);
  const bad = {
    'wrong contract': { ...ok, contract: 'saim-attention-v2' },
    'not saim': { ...ok, owner: 'neuro' },
    'no policyVersion': { ...ok, policyVersion: undefined },
    'unknown rule': { ...ok, lead: { ...ok.lead, rule: 'S12 vibes' } },
    'held malformed': { ...ok, held: 'four' },
    'judgement malformed': { ...ok, judgement: null },
    'no surface': { ...ok, surface: null },
    'refused but not blind': { ...ok, refused: { reason: 'x' } },
    'null': null,
  };
  for (const [name, d] of Object.entries(bad)) assert.equal(C.checkAttention(d).ok, false, name);
});

test('the registry is explicit: one supported version per family, and every lead rule the policy can emit is known', () => {
  assert.deepEqual([...C.SUPPORTED['neuro-candidates']], ['neuro-candidates-v2']);
  assert.deepEqual([...C.SUPPORTED['saim-attention']], ['saim-attention-v1']);
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../../saim/policy/attention-policy.cjs'), 'utf8');
  const emitted = new Set([...src.matchAll(/rule\('(S\d+[a-z]? [^']+)'/g)].map((m) => m[1]));
  assert.ok(emitted.size >= 13, 'positive control: the scan found the rules');
  for (const r of emitted) assert.ok(C.ATTENTION_RULES.includes(r), `rule "${r}" is missing from the registry`);
});
