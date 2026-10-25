'use strict';

/**
 * Build Brief 002 — the truthful attention contract (23 Oct 2026).
 *
 * D-008: urgent ranked or held work is reflected or explained, never sat under
 *        an unexplained "Nothing pressing" / "Nothing needs you".
 * D-009: gaps from reads made AFTER the situation is composed reach the
 *        presentation's honesty and degraded model.
 *
 * Fixtures are deterministic and run the REAL pure pipeline:
 *   context-state.resolveContext → attention.gateContextFor → attention.gate
 *   → (canonical-read.composeNow / mergeCanonicalGaps)
 *   → presentation-intent.composePresentation, saim-surface.silenceFor,
 *     neuro-candidates.compose → saim/policy decide.
 * Fixture A = a "Steady" context with a high-urgency capacity card.
 * Fixture B = on duty, in hours, not working, with capacity/overdue in the pool.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const CS = require('./context-state');
const AT = require('./attention');
const PI = require('./presentation-intent');
const SS = require('./saim-surface');
const CR = require('./canonical-read');
const NC = require('./neuro-candidates');
const POL = require('../../saim/policy/attention-policy.cjs');
const HW = require('../../shared/held-work.cjs');

// Friday 23 Oct 2026, 11:00 BST — a working day, in hours.
const NOW = Date.parse('2026-10-23T10:00:00Z');
const ALL_CLEAR = /nothing pressing|nothing needs you right now|nothing needs you that i can see|all quiet|everything.s where it should be/i;

const capacity = (over = {}) => ({ type: 'capacity', id: 'capacity-over-2026-10-23', dedupeKey: 'capacity:over:2026-10-23',
  title: 'More work due by the end of today than you have time for', reason: '6h due, 2h free — 4h short.',
  score: 80, urgency: 'high', tier: 1, source: 'neuro', ...over });
const overdueHigh = { type: 'todo', id: 'todo-overdue-top', title: 'Send the Q3 board pack', reason: 'Overdue (due 2026-10-20)', score: 85, urgency: 'high', tier: 1 };
const overdueMedium = { type: 'todo', id: 'todo-overdue-summary', title: 'Tidy the KB', reason: 'Overdue · 3 other overdue', score: 65, urgency: 'medium', tier: 2 };
const emailMed = { type: 'email', id: 'email-1', title: 'Reply to Chris', reason: 'Waiting 2 days', score: 60, urgency: 'medium', tier: 2 };

function steadyInputs() {
  return {
    calendar: { known: true, events: [] },
    focusSession: { known: true, session: null },
    queue: { known: true, breaching: 0, escalations: 0 },
    location: { known: true, place: 'home' },
    presence: { known: true, state: 'present' },
    rituals: { known: true, standupDone: true, eodDone: false },
    workingDay: { known: true, isWorkingDay: true, reason: null },
  };
}
const workLife = { doing: 'working', label: 'Working', showWork: true, confidence: 'likely', place: { kind: 'home', label: 'study' } };
const relaxLife = { doing: 'relaxing', label: 'Relaxing', showWork: false, confidence: 'likely', place: { kind: 'home', label: 'living room' } };

function pipeline(context, life, pool) {
  const gateCtx = AT.gateContextFor(context, life);
  const g = AT.gate(gateCtx, pool, new Date(NOW));
  return { context, life, poolAvailable: true, gaps: [], approvals: { known: true, needsApproval: 0, needsReview: 0 },
    primary: g.primary, secondary: g.secondary, dropped: g.dropped, quiet: g.quiet, situation: null };
}
const allText = (pres) => [pres.situation.headline, pres.situation.summary].join(' · ');

// ── Fixture A: "Steady" context + high-urgency capacity ─────────────────────

test('A1. context-state "Steady" no longer claims "Nothing pressing" — it says what it checked', () => {
  const ctx = CS.resolveContext(steadyInputs(), new Date(NOW));
  assert.equal(ctx.activity, 'steady');
  assert.equal(ctx.label, 'Steady');
  assert.doesNotMatch(ctx.summary, ALL_CLEAR, 'the context read cannot see the pool, so it must not claim an all-clear');
  assert.match(ctx.summary, /meeting|session|ritual|breaching/);
});

test('A2. Steady + high-urgency capacity: the card leads, the moment is not calm, nothing says "Nothing pressing"', () => {
  const ctx = CS.resolveContext(steadyInputs(), new Date(NOW));
  const p = pipeline(ctx, workLife, [capacity(), emailMed]);
  assert.equal(p.primary.type, 'capacity');
  const pres = PI.composePresentation(p, { now: NOW });
  assert.equal(pres.mode, 'working');
  assert.equal(pres.situation.summary, capacity().title);
  assert.notEqual(pres.situation.tone, 'calm', 'an urgent primary is not a calm moment');
  assert.equal(pres.situation.attentionLevel, 'elevated');
  assert.doesNotMatch(allText(pres), ALL_CLEAR);
  assert.doesNotMatch(p.context.summary, ALL_CLEAR, 'the why-line beside the card is not an all-clear either');
});

test('A3. a context card leads (ritual) while urgent capacity waits in secondary: the summary NAMES it', () => {
  const ctx = { ...CS.resolveContext(steadyInputs(), new Date(NOW)), activity: 'ritual', ritual: 'eod', label: 'EOD outstanding', summary: 'The end-of-day wrap hasn’t been done.' };
  const p = pipeline(ctx, workLife, [capacity()]);
  assert.equal(p.primary.kind, 'context');
  assert.equal(p.secondary[0].type, 'capacity');
  const pres = PI.composePresentation(p, { now: NOW });
  assert.equal(pres.situation.summary, `${capacity().title} is waiting.`);
  assert.notEqual(pres.situation.attentionLevel, 'none');
  assert.doesNotMatch(allText(pres), ALL_CLEAR);
});

// ── Fixture B: on duty, not working, capacity/overdue in the pool ───────────

test('B1. on duty + showWork=false folds to OFF but KEEPS urgent work (keepUrgentWork)', () => {
  const ctx = CS.resolveContext(steadyInputs(), new Date(NOW));
  assert.equal(ctx.duty.onDuty, true, 'fixture is on duty');
  const gc = AT.gateContextFor(ctx, relaxLife);
  assert.equal(gc.activity, 'off');
  assert.equal(gc.keepUrgentWork, true);
  // A genuine day off never carries it.
  const off = AT.gateContextFor({ ...ctx, duty: { onDuty: false, known: true, reason: 'weekend' } }, relaxLife);
  assert.equal(off.keepUrgentWork, false);
});

test('B2. on duty, not working: urgent capacity and urgent overdue still lead; ordinary work is held, counted, never an all-clear', () => {
  const ctx = CS.resolveContext(steadyInputs(), new Date(NOW));
  const p = pipeline(ctx, relaxLife, [capacity(), overdueHigh, overdueMedium, emailMed]);
  assert.equal(p.primary.kind, 'item');
  assert.equal(p.primary.type, 'capacity', 'urgent capacity is not suppressed by the on-duty gate');
  assert.ok(p.secondary.some((s) => s.id === 'todo-overdue-top'), 'urgent overdue survives too');
  const heldIds = p.dropped.map((d) => d.id);
  assert.deepEqual(heldIds.sort(), ['email-1', 'todo-overdue-summary']);
  for (const d of p.dropped) { assert.equal(d.heldFor, 'off'); assert.ok('urgency' in d); }
  const pres = PI.composePresentation(p, { now: NOW });
  assert.equal(pres.situation.summary, capacity().title);
  assert.doesNotMatch(allText(pres), ALL_CLEAR);
});

test('B3. on duty, not working, ONLY non-urgent work: held and COUNTED, not "Nothing pressing right now."', () => {
  const ctx = CS.resolveContext(steadyInputs(), new Date(NOW));
  const p = pipeline(ctx, relaxLife, [overdueMedium, emailMed]);
  assert.equal(p.primary.kind, 'context');
  const pres = PI.composePresentation(p, { now: NOW });
  assert.equal(pres.mode, 'working');
  assert.equal(pres.situation.summary, "2 work items held back while you don't look to be working.");
  assert.equal(pres.situation.attentionLevel, 'low');
  assert.doesNotMatch(allText(pres), ALL_CLEAR);
});

test('B4. MUTATION GUARD: without keepUrgentWork the old fold would have held the capacity card', () => {
  const ctx = CS.resolveContext(steadyInputs(), new Date(NOW));
  const gc = { ...AT.gateContextFor(ctx, relaxLife), keepUrgentWork: false };
  const g = AT.gate(gc, [capacity()], new Date(NOW));
  assert.equal(g.primary.kind, 'context', 'the pre-Brief-002 behaviour, reconstructed');
  assert.equal(g.dropped[0].type, 'capacity');
});

// ── Off duty: held may stay held, with an accurate count and reason ─────────

test('C1. a genuine day off holds urgent capacity, says so with the count, and drops "Quiet"', () => {
  const ctx = { activity: 'off', label: 'Not a working day', summary: "It's the weekend.", quiet: true,
    duty: { onDuty: false, known: true, reason: 'weekend' }, confidence: { level: 'high' } };
  const p = pipeline(ctx, relaxLife, [capacity(), overdueMedium, emailMed]);
  assert.equal(p.primary.kind, 'context');
  assert.equal(p.dropped.length, 3);
  const pres = PI.composePresentation(p, { now: Date.parse('2026-10-24T10:00:00Z') });
  assert.equal(pres.mode, 'off-duty');
  assert.equal(pres.situation.headline, 'Saturday', '"Quiet" is withheld while urgent work is held');
  assert.equal(pres.situation.summary, "3 work items held back while you're off duty, 1 of them urgent.");
  assert.doesNotMatch(allText(pres), ALL_CLEAR);
  // The phone/kiosk lead here is the context card itself (the foot carries "N
  // held"), so there is no silence line. Where a silence line IS composed over
  // held work, it carries the same count, never "Nothing here needs you."
  assert.equal(SS.compose(p, {}).silence, null);
  const silence = SS.compose({ ...p, primary: null }, {}).silence;
  assert.equal(silence.sub, "3 work items held back while you're off duty, 1 of them urgent.");
});

test('C2. composeNow counts the gate holds AND its own into ONE workHeld; calm is false while urgent work is held', () => {
  const ctx = { activity: 'off', label: 'Not a working day', quiet: true, duty: { onDuty: false, known: true, reason: 'weekend' }, confidence: { level: 'high' } };
  const g = AT.gate(AT.gateContextFor(ctx, relaxLife), [capacity(), emailMed], new Date(NOW));
  const decision = { context: ctx, life: relaxLife, primary: g.primary, secondary: g.secondary, dropped: g.dropped, poolAvailable: true, gaps: [] };
  const now = CR.composeNow({ decision, nextEvents: [], commitments: [], tasks: [], sources: [], approvals: null, goals: [], crowd: null, gaps: [] });
  assert.equal(now.workHeld.count, 2);
  assert.equal(now.workHeld.urgent, 1);
  assert.equal(now.calm, false);
  assert.match(now.calmSay, /^2 work items held back while you're off duty, 1 of them urgent\./);
});

test('C3. a quiet Saturday with NOTHING held keeps its calm wording unchanged', () => {
  const ctx = { activity: 'off', label: 'Not a working day', summary: "It's the weekend.", quiet: true, duty: { onDuty: false, known: true, reason: 'weekend' }, confidence: { level: 'high' } };
  const p = pipeline(ctx, relaxLife, []);
  const pres = PI.composePresentation(p, { now: Date.parse('2026-10-24T10:00:00Z') });
  assert.equal(pres.situation.headline, 'Quiet Saturday');
  assert.equal(pres.situation.summary, 'Nothing needs you right now.');
});

// ── SAiM policy: S11 never stands over held work unsaid ─────────────────────

test('D1. SAiM S11 carries the held count on the lead itself; the rule id is unchanged', () => {
  const ctx = { activity: 'off', label: 'Relaxing', quiet: false, duty: { onDuty: false, known: true }, confidence: { level: 'high' } };
  const p = pipeline(ctx, relaxLife, [capacity(), emailMed]);
  const facts = { calendar: [], calendarKnown: true, approvals: [], taskDomains: new Map(),
    workingWindow: { hours: '08:00-18:00', todayIsWorking: false, todayStart: null, todayEnd: null, nextStart: null } };
  const cands = NC.compose({ ...p, work: { atDesk: true, deskKnown: true }, utterances: [], situation: { sections: {} } }, { rows: [], block: null, session: null }, facts, { now: NOW });
  const d = POL.decide(cands, { surface: 'work-desktop', now: NOW });
  assert.equal(d.lead.rule, 'S11 nothing');
  assert.equal(d.lead.why, "Nothing needs you right now — 2 work items held back while you're off duty, 1 of them urgent.");
  assert.equal(d.policyVersion, '2026-10-25.1');
});

// ── D-009: late-stage gaps reach the presentation ───────────────────────────

test('E1. mergeCanonicalGaps: a failed late read flips honesty.complete and the calm line', () => {
  const ctx = { activity: 'off', label: 'Not a working day', quiet: true, duty: { onDuty: false, known: true, reason: 'weekend' }, confidence: { level: 'high' } };
  const p = pipeline(ctx, relaxLife, []);
  p.situation = { calm: true, calmSay: 'Nothing needs you right now.', uncertainty: { unreadable: false, gaps: [] }, sections: {} };
  const before = PI.composePresentation(p, { now: NOW });
  assert.equal(before.situation.honesty.complete, true, 'control: a clean read is complete');
  CR.mergeCanonicalGaps(p, [{ input: 'radar', why: 'radar down' }, { input: 'promises', why: 'ledger locked' }]);
  assert.deepEqual(p.gaps.map((g) => g.input), ['radar', 'promises']);
  assert.equal(p.situation.uncertainty.unreadable, true);
  assert.equal(p.situation.calm, false);
  assert.match(p.situation.calmSay, /not an all-clear/);
  const after = PI.composePresentation(p, { now: NOW });
  assert.equal(after.situation.honesty.complete, false);
  assert.match(after.situation.honesty.say, /radar/);
  assert.match(after.situation.honesty.say, /promises/);
  assert.ok(after.details.some((d) => d.id === 'gaps'), 'a visible caveat, not just a flag');
  assert.doesNotMatch(after.situation.summary, /^Nothing needs you right now\.$/, 'the summary admits it could not see everything');
});

test('E2. mergeCanonicalGaps never duplicates a gap the attention build already reported', () => {
  const p = { gaps: [{ input: 'life', why: 'x' }], situation: null };
  CR.mergeCanonicalGaps(p, [{ input: 'life', why: 'y' }, { input: 'home', why: 'z' }]);
  assert.deepEqual(p.gaps.map((g) => g.input), ['life', 'home']);
});

test('E3. WIRING: now() merges the late gaps BEFORE the presentation is composed', () => {
  const src = require('fs').readFileSync(require.resolve('./canonical-read'), 'utf8');
  const body = src.slice(src.indexOf('async function now('));
  const merge = body.indexOf('mergeCanonicalGaps(payload, gaps)');
  const lastLate = body.lastIndexOf("gaps.push({ input: 'promises'");
  const compose = body.indexOf('composePresentation(payload');
  assert.ok(merge > 0 && lastLate > 0 && compose > 0, 'positive control: all three markers exist');
  assert.ok(lastLate < merge && merge < compose, 'merge runs after the last late read and before composition');
});

// ── The shared helper itself ────────────────────────────────────────────────

test('F1. isUrgentWork uses existing semantics only: capacity, and high/critical overdue', () => {
  assert.equal(HW.isUrgentWork(capacity()), true);
  assert.equal(HW.isUrgentWork(overdueHigh), true);
  assert.equal(HW.isUrgentWork(overdueMedium), false, 'documented ambiguity: medium overdue is held, but counted');
  assert.equal(HW.isUrgentWork(emailMed), false);
  assert.equal(HW.isUrgentWork({ ...emailMed, urgency: 'high' }), false, 'urgent email is not capacity/overdue');
  assert.equal(HW.heldWork([{ heldFor: 'meeting' }, { heldFor: null }]).count, 0, 'only duty/life holds count');
});
