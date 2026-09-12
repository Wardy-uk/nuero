'use strict';

/**
 * What is Nick working on, right now?
 *
 * `resolve()` is pure, so what is under test is the product: the ORDER of the
 * three sources, and — the expensive half — the things each one is not allowed
 * to claim.
 *
 * The rule worth breaking the suite over is that the laptop can never name a
 * task. It is the only source that is always available, so it is the one that
 * would quietly become the answer; and "VS Code is in the foreground" supports
 * nothing at all about which of 93 open tasks he is on. Get that wrong and
 * every feature built on this is confidently about the wrong work.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cw = require('./current-work');

const NOW = Date.parse('2026-09-12T14:00:00Z');
const ALL_READ = { session: true, blocks: true, desktop: true };

const SESSION = { active: true, paused: false, stale: false, text: 'Revise the charter into V2', taskId: 30 };
const BLOCK = { id: 7, startMs: NOW - 600_000, endMs: NOW + 1_800_000, taskIds: [41, 42], tasks: ['Task A', 'Task B'] };
const DESKTOP = { app: 'Code', host: 'DESKTOP-8LGF9RR', active: true, known: true };

// ── The order of precedence ──────────────────────────────────────────────────

test('an explicit session wins over everything', () => {
  const r = cw.resolve({ session: SESSION, blocks: [BLOCK], desktop: DESKTOP, readable: ALL_READ }, NOW);
  assert.equal(r.kind, 'session');
  assert.equal(r.task, 'Revise the charter into V2');
  assert.deepEqual(r.taskIds, [30]);
  assert.equal(r.confidence, 'high');
});

test('a live block wins over the laptop', () => {
  const r = cw.resolve({ session: null, blocks: [BLOCK], desktop: DESKTOP, readable: ALL_READ }, NOW);
  assert.equal(r.kind, 'block');
  assert.deepEqual(r.taskIds, [41, 42]);
  assert.equal(r.confidence, 'medium');
});

test('the laptop answers only when nothing better does', () => {
  const r = cw.resolve({ session: null, blocks: [], desktop: DESKTOP, readable: ALL_READ }, NOW);
  assert.equal(r.kind, 'app');
  assert.equal(r.app, 'Code');
  assert.equal(r.confidence, 'low');
});

// ── What the laptop may never claim ──────────────────────────────────────────

test('⚠ NEGATIVE: the laptop branch NEVER names a task', () => {
  const r = cw.resolve({ session: null, blocks: [], desktop: DESKTOP, readable: ALL_READ }, NOW);
  assert.equal(r.task, null, 'an app is not a task');
  assert.deepEqual(r.taskIds, [], 'and it cannot hand task ids to a cohort matcher');
  assert.match(r.why, /says nothing about which task/);
});

// ── A block holds many tasks ─────────────────────────────────────────────────

test('⚠ a multi-task block names NO single task — the first is not the answer', () => {
  const r = cw.resolve({ session: null, blocks: [BLOCK], desktop: null, readable: ALL_READ }, NOW);
  assert.equal(r.task, null, 'naming one of two would be a guess dressed as a fact');
  assert.deepEqual(r.taskIds, [41, 42], 'but both are carried');
});

test('a single-task block does name it', () => {
  const one = { ...BLOCK, taskIds: [41], tasks: ['Task A'] };
  const r = cw.resolve({ session: null, blocks: [one], desktop: null, readable: ALL_READ }, NOW);
  assert.equal(r.task, 'Task A');
});

test('a block whose window has passed is not current work', () => {
  const past = { ...BLOCK, startMs: NOW - 7_200_000, endMs: NOW - 3_600_000 };
  const r = cw.resolve({ session: null, blocks: [past], desktop: null, readable: ALL_READ }, NOW);
  assert.notEqual(r.kind, 'block');
});

test('a block that has not started yet is not current work', () => {
  const later = { ...BLOCK, startMs: NOW + 3_600_000, endMs: NOW + 7_200_000 };
  const r = cw.resolve({ session: null, blocks: [later], desktop: null, readable: ALL_READ }, NOW);
  assert.notEqual(r.kind, 'block');
});

test('⚠ overlapping blocks pick the most recently started, never at random', () => {
  const early = { ...BLOCK, id: 1, startMs: NOW - 3_000_000, taskIds: [1], tasks: ['Early'] };
  const late = { ...BLOCK, id: 2, startMs: NOW - 60_000, taskIds: [2], tasks: ['Late'] };
  const r = cw.resolve({ session: null, blocks: [early, late], desktop: null, readable: ALL_READ }, NOW);
  assert.deepEqual(r.taskIds, [2]);
});

// ── Sessions he is not actually in ───────────────────────────────────────────

test('⚠ a PAUSED session is not current work — he stopped on purpose', () => {
  const paused = { ...SESSION, paused: true };
  const r = cw.resolve({ session: paused, blocks: [], desktop: null, readable: ALL_READ }, NOW);
  assert.notEqual(r.kind, 'session');
  assert.equal(r.task, null);
  assert.ok(r.paused, 'but it is reported, so a surface can offer to resume');
  assert.equal(r.paused.task, 'Revise the charter into V2');
});

test('⚠ a STALE session is not current work either', () => {
  const stale = { ...SESSION, stale: true };
  const r = cw.resolve({ session: stale, blocks: [], desktop: null, readable: ALL_READ }, NOW);
  assert.notEqual(r.kind, 'session');
  assert.equal(r.paused.stale, true);
});

test('a paused session does not block a live block from answering', () => {
  const r = cw.resolve({ session: { ...SESSION, paused: true }, blocks: [BLOCK], desktop: null, readable: ALL_READ }, NOW);
  assert.equal(r.kind, 'block', 'he paused one thing and the diary says he is on another');
  assert.ok(r.paused, 'and the paused one is still named');
});

// ── Unknown is a first-class answer ──────────────────────────────────────────

test('⚠ nothing readable is known:false, NOT "he is doing nothing"', () => {
  const r = cw.resolve({ readable: { session: false, blocks: false, desktop: false } }, NOW);
  assert.equal(r.known, false);
  assert.equal(r.kind, null);
  assert.match(r.why, /none of the three sources could be read/);
});

test('read fine, nothing running is known:true with a different reason', () => {
  const r = cw.resolve({ session: null, blocks: [], desktop: { app: null, active: false, known: true }, readable: ALL_READ }, NOW);
  assert.equal(r.known, true, 'we looked, and the answer is nothing');
  assert.equal(r.kind, null);
  assert.match(r.why, /not at the laptop/);
});

test('⚠ a laptop that has gone quiet says SO, rather than "not working"', () => {
  const r = cw.resolve({ session: null, blocks: [], desktop: { app: null, active: false, known: false }, readable: ALL_READ }, NOW);
  assert.equal(r.kind, null);
  assert.match(r.why, /cannot tell/);
});

test('an unreadable clock cannot invent a live block', () => {
  const r = cw.resolve({ session: null, blocks: [BLOCK], desktop: null, readable: ALL_READ }, 'not a date');
  assert.notEqual(r.kind, 'block');
});

test('every answer carries a reason in words', () => {
  const cases = [
    { session: SESSION, blocks: [], desktop: null, readable: ALL_READ },
    { session: null, blocks: [BLOCK], desktop: null, readable: ALL_READ },
    { session: null, blocks: [], desktop: DESKTOP, readable: ALL_READ },
    { session: null, blocks: [], desktop: null, readable: ALL_READ },
  ];
  for (const c of cases) {
    const r = cw.resolve(c, NOW);
    assert.ok(typeof r.why === 'string' && r.why.length > 0, JSON.stringify(c));
  }
});

// ── The WIRING, which the pure tests above cannot see ────────────────────────
//
// ⚠ These exist because `resolve()` was exhaustively pinned and `current()` was
// not, and the bug was entirely in the join: `runAcross(now)` passed a Date
// into the parameter that takes per-host sample BUCKETS, so it read as an empty
// object and answered "the laptop has never reported" while the agent had 400
// samples and a live 14-minute run. A well-formed wrong answer, thrown by
// nothing, invisible to every test of the pure half.

test('⚠ current() reads the laptop through the STATEFUL accessor', () => {
  const da = require('./desktop-activity');
  const realRun = da.run;
  let sawArgs = null;
  da.run = (...args) => { sawArgs = args; return { known: true, app: 'Code', host: 'DESKTOP-8LGF9RR', minutes: 14, why: null }; };
  try {
    const r = cw.current(new Date(NOW));
    assert.equal(r.kind, 'app', 'a live run in Code is an answer, not a shrug');
    assert.equal(r.app, 'Code');
    assert.equal(sawArgs.length, 1, 'run(now) takes the clock and nothing else');
    assert.ok(sawArgs[0] instanceof Date || typeof sawArgs[0] === 'number');
  } finally {
    da.run = realRun;
  }
});

test('⚠ a laptop that genuinely has not reported still says so', () => {
  const da = require('./desktop-activity');
  const realRun = da.run;
  da.run = () => ({ known: false, app: null, host: null, why: 'the laptop has never reported' });
  try {
    const r = cw.current(new Date(NOW));
    assert.notEqual(r.kind, 'app');
  } finally {
    da.run = realRun;
  }
});

// ── At the laptop is a separate fact from what he is doing ───────────────────
//
// ⚠ A running session wins the `kind`, but he is still sitting at the machine.
// Anything offering to OPEN something there needs to know — otherwise it queues
// an intent that expires unclaimed two minutes later and looks broken.

test('⚠ atDesk travels on EVERY answer, not just the app branch', () => {
  const withDesk = { ...DESKTOP };
  const cases = [
    { session: SESSION, blocks: [], desktop: withDesk },
    { session: null, blocks: [BLOCK], desktop: withDesk },
    { session: null, blocks: [], desktop: withDesk },
    { session: { ...SESSION, paused: true }, blocks: [], desktop: withDesk },
  ];
  for (const c of cases) {
    const r = cw.resolve({ ...c, readable: ALL_READ }, NOW);
    assert.equal(r.atDesk, true, 'kind=' + r.kind);
    assert.equal(r.host, 'DESKTOP-8LGF9RR');
  }
});

test('not at the laptop is atDesk:false but deskKnown:true', () => {
  const r = cw.resolve({ session: null, blocks: [], desktop: { app: null, active: false, known: true }, readable: ALL_READ }, NOW);
  assert.equal(r.atDesk, false);
  assert.equal(r.deskKnown, true, 'we looked');
});

test('⚠ a laptop that has not reported is deskKnown:FALSE, not "not at the desk"', () => {
  // The two license different behaviour: one means do not offer, the other
  // means say you cannot tell.
  const r = cw.resolve({ session: null, blocks: [], desktop: { known: false }, readable: ALL_READ }, NOW);
  assert.equal(r.atDesk, false);
  assert.equal(r.deskKnown, false);
});
