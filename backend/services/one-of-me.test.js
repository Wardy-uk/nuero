'use strict';

/**
 * "There's only one of me" (Nick, 6 Nov 2026).
 *
 * At 14:00 SAiM's desktop showed a focus block ("It's 14:00 — your focus
 * block", Publish the podcast, 57 min left) AND, beneath it, "Working", a
 * Needs-you capacity overload, an overdue WhatsApp capacity card with Done /
 * Not now, a promise with "Start this task", and a Holding-the-week Next card
 * saying "No protected time is booked ahead". Three things asking to be done
 * now, and one statement contradicting the block on the same screen.
 *
 * The cause was ordering: the focus block was read AFTER the context, so with
 * no session started yet SAiM resolved "Working" and the gate let the whole pool
 * through. These pin the four rules that make the block the ONE thing:
 *   1. a block in its window IS being heads-down (context), session or not;
 *   2. during a block only the unsuppressable (escalation, imminent meeting)
 *      gets through — not a tier-1-by-score capacity card;
 *   3. the Next card counts the running block, and never offers a second Start;
 *   4. no "Start this task" on a promise while heads-down (source scan).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { resolveContext, ACTIVITY } = require('./context-state');
const { gate } = require('./attention');
const { cardsFrom } = require('./keep-my-word-cards');

const FRI_1403 = new Date('2026-11-06T14:03:00');

function calm(over = {}) {
  return {
    calendar: { known: true, events: [] },
    focusSession: { known: true, active: null },
    queue: { known: true, breaching: 0, unseenEscalations: 0 },
    location: { known: true, place: 'office', source: 'owntracks' },
    presence: { known: true, present: true },
    rituals: { known: true, standupOutstanding: false, eodOutstanding: false },
    workingDay: { known: true, isWorkingDay: true, reason: null },
    ...over,
  };
}

test('a focus block in its window is being heads-down, before any session starts', () => {
  const c = resolveContext(calm({ focusSession: { known: true, active: null, block: { startTime: '14:00', endTime: '15:00', task: 'Publish the podcast' } } }), FRI_1403);
  assert.equal(c.activity, ACTIVITY.IN_FOCUS_SESSION);
  assert.equal(c.label, 'In your focus block');
  assert.match(c.summary, /until 15:00/);
  assert.match(c.summary, /Publish the podcast/);
  assert.deepEqual(c.focusBlock, { startTime: '14:00', endTime: '15:00' });
  // Positive control: without the block the same moment is ordinary working time.
  const plain = resolveContext(calm(), FRI_1403);
  assert.notEqual(plain.activity, ACTIVITY.IN_FOCUS_SESSION);
  assert.equal(plain.focusBlock, null);
});

const ctx = (over = {}) => ({
  activity: ACTIVITY.IN_FOCUS_SESSION, label: 'In your focus block', summary: 'Your focus block until 15:00.',
  quiet: false, confidence: { score: 0.8, level: 'high', basis: [], rationale: '' }, reasons: [], contradictions: [], unknowns: [], ...over,
});
const item = (over) => ({ id: 'i', type: 'todo', title: 't', reason: 'r', score: 60, tier: 2, urgency: 'medium', meta: {}, ...over });
const OVERDUE_CAPACITY = item({ id: 'capacity-start-42', type: 'capacity', title: '"Evaluate WhatsApp" is overdue — 8h of work', tier: 1, score: 84, urgency: 'high', meta: { taskId: 42 } });
const OVERLOAD = item({ id: 'capacity-overload', type: 'capacity', title: 'More work due by the end of today than you have time for', tier: 1, score: 86, urgency: 'high' });
const ESCALATION = item({ id: 'escalations-unseen', type: 'escalation', title: 'NT-1', tier: 1, score: 97, _unsuppressable: true });

test('during a focus block only what cannot wait gets through — a capacity card waits', () => {
  const g = gate(ctx({ focusBlock: { startTime: '14:00', endTime: '15:00' } }), [OVERLOAD, OVERDUE_CAPACITY]);
  assert.equal(g.primary.kind, 'context', 'nothing is offered as a second thing to do');
  assert.equal(g.secondary.length, 0);
  assert.equal(g.dropped.length, 2);
  assert.match(g.dropped[0].why, /held until 15:00/);
  const e = gate(ctx({ focusBlock: { startTime: '14:00', endTime: '15:00' } }), [OVERDUE_CAPACITY, ESCALATION]);
  assert.equal(e.primary.id, 'escalations-unseen', 'an escalation still interrupts');
  // Positive control: a plain focus SESSION keeps its tier-1 rule unchanged.
  const s = gate(ctx(), [OVERDUE_CAPACITY]);
  assert.equal(s.primary.id, 'capacity-start-42');
});

test('the Next card counts the running block and never offers a second Start', () => {
  const focusBlock = {
    phase: 'start', dateKey: '2026-11-06', startTime: '14:00', endTime: '15:00',
    chosen: { id: 358, text: 'Publish the podcast' },
  };
  const c = cardsFrom({ focusBlock, now: FRI_1403.getTime() });
  assert.equal(c.next.state, 'running');
  assert.equal(c.next.detail.block.start, '14:00');
  assert.match(c.next.detail.block.title, /Publish the podcast/);
  assert.notEqual(c.next.primary.open.kind, 'session-start', 'the focus block card owns starting');
  assert.match(c.next.detail.session.why, /Running now, until 15:00/);
  // Positive control: no block → the old honest "none".
  const none = cardsFrom({ now: FRI_1403.getTime() });
  assert.equal(none.next.state, 'none');
  // A finished block is not "next".
  assert.equal(cardsFrom({ focusBlock: { ...focusBlock, phase: 'over' }, now: FRI_1403.getTime() }).next.state, 'none');
});

test('no promise "Start this task" while heads-down', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'saim', 'shared-ui', 'presentation', 'Situation.jsx'), 'utf-8');
  assert.match(src, /const kmwStart = plan\.profile === 'kiosk' \|\| plan\.mode === 'focus' \? null : onStartTask;/);
});
