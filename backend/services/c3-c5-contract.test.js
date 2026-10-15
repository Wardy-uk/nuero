'use strict';

// C3 + C5 (15 Oct 2026): every rail section states known or not-read, with a
// reason; every candidate carries safe human display fields, and SAiM's
// decision shows only display text built from them — never a raw id,
// timestamp or internal type. Real composer, real policy, real contract checks.

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../shared/attention-contracts.cjs');
const D = require('../../shared/display-text.cjs');
const NC = require('./neuro-candidates');
const ND = require('./neuro-display');
const POL = require('../../saim/policy/attention-policy.cjs');
const SC = require('./saim-policy-scenarios');

const clone = (x) => JSON.parse(JSON.stringify(x));
const SECTIONS = ['protected', 'held', 'judgement', 'next'];
const displayStrings = (d) => [d.display.lead.title, d.display.lead.sentence, d.display.lead.when, d.display.protected && d.display.protected.what,
  d.display.next && d.display.next.title, d.display.next && d.display.next.when,
  ...(Array.isArray(d.display.held) ? d.display.held.flatMap((h) => [h.title, h.why, h.returns]) : []),
  ...d.display.judgement.flatMap((j) => [j.what, j.by, j.basis])].filter((s) => s != null);

// ── C3 ──────────────────────────────────────────────────────────────────────

test('C3: every decision states known / not-read for all four rail sections', () => {
  for (const s of SC.SCENARIOS) {
    const { decision: d } = s.build();
    assert.deepEqual(Object.keys(d.known).sort(), [...SECTIONS].sort(), s.id);
    for (const sec of SECTIONS) {
      assert.equal(typeof d.known[sec].known, 'boolean', `${s.id} ${sec}`);
      if (!d.known[sec].known) assert.ok(d.known[sec].why, `${s.id} ${sec}: a reason when not read`);
    }
    const blind = d.lead.rule === 'S1 blind';
    assert.equal(SECTIONS.every((sec) => d.known[sec].known === !blind), true, `${s.id}: blind = nothing read, otherwise everything read`);
  }
});

function partial(mutate, surface = 'work-desktop', id = '1') {
  const s = SC.SCENARIOS.find((x) => x.id === id).build();
  const cands = clone(s.candidates);
  mutate(cands.constraints);
  const now = Date.parse(s.decision.decidedAt);
  return { clean: POL.decide(clone(s.candidates), { surface, now }), d: POL.decide(cands, { surface, now }) };
}

test('C3: a partial outage marks only the sections that depend on it — and never as "nothing there"', () => {
  let r = partial((k) => { k.approvalsReadable = false; });
  assert.deepEqual(r.d.known.judgement, { known: false, why: 'couldn’t read approvals' });
  assert.equal(r.d.known.held.known, true); assert.equal(r.d.known.protected.known, true);
  assert.equal(r.d.lead.rule, r.clean.lead.rule, 'the lead does not change because a section is unread');
  r = partial((k) => { k.diaryReadable = false; });
  assert.deepEqual(r.d.known.protected, { known: false, why: 'couldn’t read the diary' });
  assert.deepEqual(r.d.known.next, { known: false, why: 'couldn’t read the diary' });
  r = partial((k) => { k.blocksReadable = false; k.diaryReadable = false; });
  assert.equal(r.d.known.next.why, 'couldn’t read task blocks or the diary');
  r = partial((k) => { k.commitmentsReadable = false; });
  assert.deepEqual(r.d.known.held, { known: false, why: 'couldn’t read commitments' });
  r = partial((k) => { delete k.approvalsReadable; });
  assert.equal(r.d.known.judgement.known, false, 'a flag NEURO didn’t state is not read');
  r = partial((k) => { k.homeReadable = false; }, 'home-pi', '4');
  assert.equal(r.d.lead.rule, 'S1 blind', 'home scope: no household model is blind');
  for (const sec of SECTIONS) assert.deepEqual(r.d.known[sec], { known: false, why: 'couldn’t read the household model' }, `blind home screen claims nothing read: ${sec}`);
  r = partial((k) => { k.commitmentsReadable = false; }, 'home-pi', '4');
  assert.equal(r.d.known.held.known, true, 'home scope held depends on the household model, not work commitments');
});

test('C3: the composer states commitmentsReadable; a refused decision reads nothing; the contract requires reasons', () => {
  const { candidates } = SC.SCENARIOS.find((x) => x.id === '1').build();
  assert.equal(candidates.constraints.commitmentsReadable, true);
  const blind = SC.SCENARIOS.find((x) => x.id === '6a').build().candidates;
  assert.equal(blind.constraints.commitmentsReadable, false);
  const refused = POL.decide({ contract: 'neuro-candidates-v1' }, { surface: 'work-desktop', now: Date.now() });
  assert.ok(refused.refused);
  for (const sec of SECTIONS) assert.equal(refused.known[sec].known, false);
  assert.equal(C.checkAttention(refused).ok, true);
  const ok = SC.SCENARIOS[0].build().decision;
  assert.equal(C.checkAttention({ ...ok, known: undefined }).ok, false);
  assert.equal(C.checkAttention({ ...ok, known: { ...ok.known, judgement: { known: false, why: null } } }).ok, false, 'not read without a reason');
  assert.equal(C.checkAttention({ ...ok, known: { ...ok.known, next: undefined } }).ok, false);
});

// ── C5: candidates ───────────────────────────────────────────────────────────

test('C5: every composed candidate carries display { title, timing, explanation }, all safe', () => {
  let n = 0;
  for (const s of SC.SCENARIOS) {
    for (const c of s.build().candidates.candidates) {
      n += 1;
      assert.deepEqual(Object.keys(c.display).sort(), ['explanation', 'timing', 'title'], `${s.id} ${c.id}`);
      for (const k of ['title', 'timing', 'explanation']) assert.ok(c.display[k] === null || D.isSafeDisplay(c.display[k]), `${s.id} ${c.id}.${k}: ${c.display[k]}`);
    }
  }
  assert.ok(n > 30, 'positive control');
});

test('C5: the real leaks are fixed at the source — action types, raw ids, markup, ISO times', () => {
  const now = new Date(2026, 9, 15, 14, 0).getTime();
  // A real prepared action: NEURO's raw title is "chase agenda: Ops sync"; the display never is.
  const ap = ND.displayFor({ kind: 'approval', title: 'chase agenda: Ops sync', time: { deadlineAt: new Date(2026, 9, 20, 9, 0).toISOString() }, facts: { type: 'chase_agenda', subject: 'Ops sync' } }, { subject: 'Ops sync', now });
  assert.deepEqual(ap, { title: 'Ask for an agenda: Ops sync', timing: 'expires 09:00 Tue 20 Oct', explanation: 'Waiting for your approval in NEURO' });
  assert.equal(ND.displayFor({ kind: 'approval', facts: { type: 'some_new_type' } }, { now }).title, 'An action waiting for your approval', 'an unknown type is never shown');
  // Opaque ids and markup never reach a display field.
  assert.equal(ND.displayFor({ kind: 'attention-item', title: 'AAMkAGI2THVSAAA=', facts: {} }).title, null);
  assert.equal(ND.displayFor({ kind: 'commitment', title: 'Send rota <!--task:12--> #carried-2d', time: {}, facts: {} }).title, 'Send rota');
  assert.equal(ND.displayFor({ kind: 'meeting', title: 'Nurtur - Micom ', time: { start: '14:00', end: '15:00' }, facts: { othersAttending: true } }).title, 'Nurtur - Micom', 'trailing whitespace trimmed');
  assert.equal(ND.displayFor({ kind: 'attention-item', title: 'x', facts: { reason: 'chase_commitment queued' } }).explanation, null, 'an internal type in a reason is dropped, never shown');
  assert.equal(ND.displayFor({ kind: 'commitment', title: 'Fix the user_id field', time: { due: '2026-10-15' }, facts: { daysLate: 0 } }, { now }).title, 'Fix the user_id field', 'Nick’s own words may contain snake_case');
  assert.equal(ND.displayFor({ kind: 'commitment', title: 'x x x', time: { due: '2026-10-13' }, facts: { daysLate: 2 } }, { now }).timing, '2 days overdue');
  // Found on live data: a home obligation carries no daysLate — a past date must still read as overdue.
  assert.equal(ND.displayFor({ kind: 'home', title: 'Book my car in for its MOT', time: { due: '2026-10-12' }, facts: { homeKind: 'obligation' } }, { now }).timing, '3 days overdue');
  assert.equal(ND.displayFor({ kind: 'home', title: 'Bins', time: { due: '2026-10-16' }, facts: {} }, { now }).timing, 'due tomorrow');
});

// ── C5: the decision ─────────────────────────────────────────────────────────

test('C5: every decision string a screen shows is safe — across every scenario and both scopes', () => {
  for (const s of SC.SCENARIOS) {
    const { decision: d } = s.build();
    const strings = displayStrings(d);
    assert.ok(strings.length >= 1);
    for (const t of strings) assert.ok(D.isSafeDisplay(t), `${s.id}: "${t}"`);
    assert.equal(C.checkAttention(d).ok, true, `${s.id}: ${C.checkAttention(d).reason}`);
  }
});

test('C5: the two policy-sentence leaks are gone from display — the S2u type id and the S6 raw date', () => {
  const s2u = SC.SCENARIOS.find((x) => x.id === '8').build().decision;
  assert.match(s2u.lead.why, /payroll_cutoff/, 'the machine field still records the type (trace)');
  assert.ok(!/payroll_cutoff/.test(s2u.display.lead.sentence));
  assert.match(s2u.display.lead.sentence, /this kind of item hasn’t been classified yet/);
  const at = (h, m, d = 15) => new Date(2026, 9, d, h, m);
  const s6 = SC.build({ now: at(11, 5).getTime(), surface: 'work-desktop', approvals: [{ id: 'pa_6', expiresAt: at(9, 0, 20).toISOString(), title: 'chase agenda: Quarterly review' }] }).decision;
  assert.equal(s6.lead.rule, 'S6 judgement waiting');
  assert.match(s6.lead.why, /Tue Oct 20 2026/, 'the old sentence (machine field) still carries the raw date');
  assert.equal(s6.display.lead.sentence, 'It’s waiting for you in NEURO — before 09:00 Tue 20 Oct.');
  assert.ok(!s6.display.lead.sentence.includes(s6.display.lead.title), 'the sentence never restates the headline');
  const s5 = SC.SCENARIOS.find((x) => x.id === '2a').build().decision;
  assert.deepEqual(s5.display.judgement, [{ what: 'Ask for an agenda', by: '18:00 today', basis: 'end of today’s working hours — it expires before you next start' }]);
});

test('C5: an unsafe display field from NEURO is replaced, never shown; the decision still validates', () => {
  const s = SC.SCENARIOS.find((x) => x.id === '1').build();
  const cands = clone(s.candidates);
  cands.candidates.find((c) => c.id === 'block:130').display.title = 'block:130 2026-10-15T14:00:00.000Z';
  cands.candidates.find((c) => c.kind === 'commitment').display.title = 'chase_commitment for AAMkAGI2THVSAAA=';
  const d = POL.decide(cands, { surface: 'work-desktop', now: Date.parse(s.decision.decidedAt) });
  for (const t of displayStrings(d)) assert.ok(D.isSafeDisplay(t), t);
  assert.equal(d.display.lead.title, null);
  assert.match(d.display.lead.sentence, /This is your blocked time for it\./);
  assert.ok(d.display.held.some((h) => h.title === 'Held item'));
  assert.equal(C.checkAttention(d).ok, true);
  // And the contract refuses a decision whose display leaks.
  assert.equal(C.checkAttention({ ...d, display: { ...d.display, lead: { ...d.display.lead, sentence: 'Open pa_0123456789abcdef now' } } }).ok, false);
});

test('C5: a v2 candidate without a display block is refused (contract), never read around', () => {
  const s = SC.SCENARIOS.find((x) => x.id === '1').build();
  const cands = clone(s.candidates);
  delete cands.candidates[0].display;
  assert.match(C.checkCandidates(cands).reason, /display missing/);
  assert.equal(POL.decide(cands, { surface: 'work-desktop', now: Date.parse(s.decision.decidedAt) }).lead.rule, 'S1 blind');
});

test('display-text: the safety check and time words', () => {
  const now = new Date(2026, 9, 15, 14, 0).getTime();
  for (const bad of ['2026-10-15T14:00:00Z', 'Tue Oct 20 2026', 'AAMkAGI2THVSAAA=', 'pa_0123456789abcdef', 'task:neuro:12', 'binary_sensor.kitchen_leak', 'x <!--task:1-->', 'neuro:?item=task%3A1', 'nova_flag raised', 'chase agenda: Ops sync', 'type payroll_cutoff']) assert.equal(D.isSafeDisplay(bad), false, bad);
  for (const good of ['Escalation with no reply from you', 'Fix the user_id field', 'NT-14855 — Portal down', 'Ask for an agenda: Ops sync', '14:00–15:30', null]) assert.equal(D.isSafeDisplay(good), true, String(good));
  assert.equal(D.whenText(new Date(2026, 9, 15, 18, 0).toISOString(), now), '18:00 today');
  assert.equal(D.whenText(new Date(2026, 9, 16, 9, 0).toISOString(), now), '09:00 tomorrow');
  assert.equal(D.dateText('2026-10-20', now), 'Tue 20 Oct');
  assert.equal(D.whenText('not a time', now), null);
});
