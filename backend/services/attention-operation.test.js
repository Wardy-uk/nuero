'use strict';

/**
 * What SAiM says she is DOING, and the four things it must never say.
 *
 * The composer is PURE, so every rule here pins without a Pi, a database or a
 * house — the `pi-health.assess()` split. The rules ARE the product: the
 * ranking, the refusal to call a request a result, and the refusal to look
 * calm over a pool she could not read.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { composeOperation } = require('./attention-operation');
const { PHASES, LABELS, labelFor, isActivePhase, isInFlight } = require('../../shared/operation-phase.cjs');

// A readable, unremarkable afternoon. Every test starts here and adds ONE fact,
// so what moved the phase is never ambiguous.
function calm(extra = {}) {
  return {
    poolAvailable: true,
    quiet: false,
    context: { activity: 'steady', confidence: { level: 'high' } },
    rooms: { known: true, offers: [] },
    desk: { known: true, requested: [], taken: [] },
    deferrals: [],
    ...extra,
  };
}

const DESK_REQUESTED = { id: 'di_a', app: 'code', label: 'VS Code', at: '2026-09-20T10:00:00.000Z' };
const DESK_TAKEN = { id: 'di_b', app: 'browser', label: 'your browser', at: '2026-09-20T10:01:00.000Z' };
const OFFER = {
  key: 'room:living-room:lights-on#living-room@1',
  kind: 'lights-on',
  area: 'Living Room',
  say: 'Want the living room lights on?',
};

// ── The resting answers ─────────────────────────────────────────────────────

test('a calm readable day is STANDING BY, and invents nothing', () => {
  const op = composeOperation(calm());
  assert.equal(op.phase, 'standing_by');
  assert.equal(op.label, 'STANDING BY');
  // ⚠ The one thing it must never do is manufacture a job to look busy.
  //   `primary: null` has always been a legitimate answer.
  assert.equal(op.detail, null);
  assert.equal(op.subject, null);
  assert.equal(op.active, false);
});

test('in a meeting she is QUIET, and does not prompt for work', () => {
  const op = composeOperation(calm({ quiet: true, context: { activity: 'in-meeting', confidence: { level: 'high' } } }));
  assert.equal(op.phase, 'quiet');
  assert.equal(op.label, 'QUIET');
  // The context label sits an inch away in the crown already saying "in a
  // meeting". Repeating why would be the same fact twice — `covered`'s rule.
  assert.equal(op.detail, null);
});

test('confidence is carried through, and is null when the read did not say', () => {
  assert.equal(composeOperation(calm()).confidence, 'high');
  assert.equal(composeOperation(calm({ context: {} })).confidence, null);
});

// ── The honesty rule the crown exists for ───────────────────────────────────

test('an unreadable pool is UNAVAILABLE and says it is not an all-clear', () => {
  const op = composeOperation(calm({ poolAvailable: false }));
  assert.equal(op.phase, 'unavailable');
  assert.equal(op.label, 'UNAVAILABLE');
  assert.match(op.detail, /all-clear/i);
  assert.equal(op.active, true);
});

test('UNAVAILABLE outranks a request in flight, an offer and a deferral', () => {
  // ⚠ MUTATION-CHECKED. Moving the pool check below the desk check turns this
  //   red. The ranking is deliberate: this phase is not a status, it is a
  //   warning about how much of the rest of the screen can be believed, and a
  //   request in flight still says so on its own card.
  const op = composeOperation(calm({
    poolAvailable: false,
    desk: { known: true, requested: [DESK_REQUESTED], taken: [DESK_TAKEN] },
    rooms: { known: true, offers: [OFFER] },
    deferrals: [{ id: 'x', type: 'todo', why: 'until 14:00' }],
  }));
  assert.equal(op.phase, 'unavailable');
});

test('a routine gap does NOT reach UNAVAILABLE', () => {
  // ⚠ NEGATIVE, and it is the one that keeps the word meaning something. Gaps
  //   are routine and are already rendered in their own words; promoting one
  //   to the crown would leave UNAVAILABLE permanently lit, and a warning
  //   that is always on is one nobody reads by week two.
  const op = composeOperation(calm({ gaps: [{ input: 'rooms', why: 'home assistant unreachable' }] }));
  assert.equal(op.phase, 'standing_by');
});

// ── Requested is not done ───────────────────────────────────────────────────

test('a queued request is EXECUTING and names what was asked', () => {
  const op = composeOperation(calm({ desk: { known: true, requested: [DESK_REQUESTED], taken: [] } }));
  assert.equal(op.phase, 'executing');
  assert.match(op.detail, /VS Code/);
  assert.deepEqual(op.subject, { type: 'desk-intent', id: 'di_a', title: 'VS Code' });
  assert.equal(op.changedAt, DESK_REQUESTED.at);
  assert.equal(isInFlight(op.phase), true);
});

test('a claimed request is VERIFYING — taken, outcome unknown', () => {
  const op = composeOperation(calm({ desk: { known: true, requested: [], taken: [DESK_TAKEN] } }));
  assert.equal(op.phase, 'verifying');
  assert.match(op.detail, /taken/i);
  assert.match(op.detail, /what happened/i);
  assert.equal(op.subject.id, 'di_b');
});

test('EXECUTING and VERIFYING are never merged, and requested leads', () => {
  // Two different facts: "nobody has picked it up" and "the machine has it and
  // has not said what happened" send Nick to different places if it goes
  // wrong. The unclaimed one leads because it is the weaker position.
  const op = composeOperation(calm({ desk: { known: true, requested: [DESK_REQUESTED], taken: [DESK_TAKEN] } }));
  assert.equal(op.phase, 'executing');
});

test('nothing in flight ever claims the thing happened', () => {
  // ⚠ FORBIDDEN WORDING over every sentence an in-flight phase can produce.
  //   The whole point of this layer is that a request sent is not an action
  //   completed, so a detail line reading "opened" or "done" would restate the
  //   bug in words while the phase was technically correct.
  for (const desk of [
    { known: true, requested: [DESK_REQUESTED], taken: [] },
    { known: true, requested: [], taken: [DESK_TAKEN] },
  ]) {
    const { detail } = composeOperation(calm({ desk }));
    assert.doesNotMatch(detail, /\b(opened|done|complete|completed|success|succeeded|sorted)\b/i, detail);
  }
});

test('an unreadable intent queue claims nothing is in flight', () => {
  // ⚠ "I could not look" is not "nothing is happening" — so it must not invent
  //   an EXECUTING either. It falls through, and `attention.js` names the
  //   unreadable queue as a gap on the channel built for that.
  const op = composeOperation(calm({ desk: { known: false, why: 'could not read the intent queue', requested: [], taken: [] } }));
  assert.equal(op.phase, 'standing_by');
});

// ── Approval happens before the write ───────────────────────────────────────

test('an open room offer is AWAITING AUTHORISATION, in the offer own words', () => {
  const op = composeOperation(calm({ rooms: { known: true, offers: [OFFER] } }));
  assert.equal(op.phase, 'awaiting_authorisation');
  assert.equal(op.label, 'AWAITING AUTHORISATION');
  // ⚠ VERBATIM. `rooms` composed this sentence; rephrasing it here would put
  //   two sentences about one light switch on one screen.
  assert.equal(op.detail, OFFER.say);
  assert.deepEqual(op.subject, { type: 'room-offer', id: OFFER.key, title: 'Living Room' });
});

test('an offer outranks QUIET, so the crown cannot contradict the card', () => {
  const op = composeOperation(calm({ quiet: true, rooms: { known: true, offers: [OFFER] } }));
  assert.equal(op.phase, 'awaiting_authorisation');
});

test('an unreadable house offers nothing to authorise', () => {
  const op = composeOperation(calm({ rooms: { known: false, offers: [] } }));
  assert.equal(op.phase, 'standing_by');
});

// ── Held for later ──────────────────────────────────────────────────────────

test('a deferral is MONITORING and reuses the sentence already composed for it', () => {
  const held = { id: 'todo-1', type: 'todo', why: 'you put this off until 2pm' };
  const op = composeOperation(calm({ deferrals: [held] }));
  assert.equal(op.phase, 'monitoring');
  assert.equal(op.detail, held.why);
  assert.equal(op.subject.id, 'todo-1');
});

test('several deferrals are counted, never one of them picked as the answer', () => {
  const op = composeOperation(calm({
    deferrals: [{ id: 'a', why: 'until 2pm' }, { id: 'b', why: 'until 4pm' }],
  }));
  assert.equal(op.phase, 'monitoring');
  assert.match(op.detail, /2 things/);
  assert.equal(op.subject, null, 'no single subject where there are several');
});

test('a deferral never outranks real work in flight', () => {
  const op = composeOperation(calm({
    deferrals: [{ id: 'a', why: 'until 2pm' }],
    desk: { known: true, requested: [DESK_REQUESTED], taken: [] },
  }));
  assert.equal(op.phase, 'executing');
});

// ── The vocabulary ──────────────────────────────────────────────────────────

test('every phase the composer can emit has a label', () => {
  const emitted = [
    composeOperation(calm({ poolAvailable: false })),
    composeOperation(calm({ desk: { known: true, requested: [DESK_REQUESTED], taken: [] } })),
    composeOperation(calm({ desk: { known: true, requested: [], taken: [DESK_TAKEN] } })),
    composeOperation(calm({ rooms: { known: true, offers: [OFFER] } })),
    composeOperation(calm({ quiet: true })),
    composeOperation(calm({ deferrals: [{ id: 'a', why: 'later' }] })),
    composeOperation(calm()),
  ];
  for (const op of emitted) {
    assert.ok(PHASES.includes(op.phase), `${op.phase} is in the vocabulary`);
    assert.equal(op.label, LABELS[op.phase]);
    assert.equal(typeof op.label, 'string');
    assert.ok(op.label.length > 0);
  }
  // A positive control: the list above really did move the phase around, so a
  // composer that returned one constant could not pass this.
  assert.equal(new Set(emitted.map((o) => o.phase)).size, 7);
});

test('a phase this vocabulary does not know is not active and has no label', () => {
  // ⚠ A client reading a payload from a newer backend must fall back to showing
  //   LESS, never to placing a detail line it cannot interpret.
  assert.equal(labelFor('teleporting'), null);
  assert.equal(isActivePhase('teleporting'), false);
});

test('the resting phases are not active, and the in-flight ones are', () => {
  for (const p of ['standing_by', 'quiet', 'monitoring']) assert.equal(isActivePhase(p), false, p);
  for (const p of ['unavailable', 'executing', 'verifying', 'awaiting_authorisation']) {
    assert.equal(isActivePhase(p), true, p);
  }
});

test('rubbish in does not throw — the feed is never the casualty', () => {
  for (const bad of [undefined, null, 'nonsense', 42, []]) {
    const op = composeOperation(bad);
    assert.equal(op.phase, 'standing_by');
  }
});
