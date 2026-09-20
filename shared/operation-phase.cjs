'use strict';

/**
 * What SAiM is DOING, as a closed vocabulary.
 *
 * The feed already says what she has READ (`context`), what she thinks matters
 * (`primary`) and how confident the read is (`field`). What it never said is
 * whether anything is actually under way — so a request Nick had just made and
 * a completely idle afternoon produced the same screen, and the only place a
 * request in flight was visible was a local `useState` inside one component.
 *
 * ── The loop this exists to make visible ────────────────────────────────────
 *   observe → assess → recommend → obtain approval → execute → verify → report
 *
 * ⚠⚠ A REQUEST SENT IS NOT AN ACTION COMPLETED, and that is the whole point.
 *   `executing` means the ask is out, `verifying` means something took it and
 *   has not said what happened, and NEITHER is success. The outcome is reported
 *   when it is known, or the failure is, and nothing in between claims either.
 *
 * ⚠ ONE VOCABULARY, and every surface renders `label` VERBATIM off the payload.
 *   This file exists so the phases and their wording are named ONCE — the
 *   `shared/ms-task.cjs` rule, where a marker written and parsed in two places
 *   is how one client comes to show a value another never meant. The Swift copy
 *   (`NeuroKit/Sources/NeuroKit/Operation.swift`) is pinned against this file
 *   by a test in each repo, exactly as `fieldDrive` and the design tokens are.
 *
 * PURE. No clock, no storage, no I/O.
 */

// ⚠ The order IS the precedence the composer applies, highest first, and it is
//   written down here rather than inside the composer so a reader can see the
//   ranking without reading the rules.
//
// ⚠ `unavailable` OUTRANKS EVERYTHING, including an action in flight. It is the
//   one phase that changes how much of the rest of the screen can be believed,
//   and the codebase already ranks that way everywhere else: `state-of-play`
//   puts a stale cache above big-but-true numbers, and SAiM's own provenance
//   lets a stale connection outrank the domain roll-up. A request in flight
//   still says so on its own card; a surface that has stopped being able to see
//   his work must never look calm.
const PHASES = [
  'unavailable',
  'executing',
  'verifying',
  'awaiting_authorisation',
  'quiet',
  'assessing',
  'monitoring',
  'standing_by',
];

// ⚠ SHORT, AND A STATEMENT OF FACT. Nothing here is a verdict, a score or a
//   mood: the corner of the screen that cannot flatter her is the one worth
//   keeping. "WORKING ON IT" would be both vaguer and more boastful than
//   "EXECUTING", which says exactly which half of the loop she is in.
const LABELS = {
  unavailable: 'UNAVAILABLE',
  executing: 'EXECUTING',
  verifying: 'VERIFYING',
  awaiting_authorisation: 'AWAITING AUTHORISATION',
  quiet: 'QUIET',
  assessing: 'ASSESSING',
  monitoring: 'MONITORING',
  standing_by: 'STANDING BY',
};

// The phases that have earned room on screen beyond the label itself.
//
// ⚠ `standing_by`, `quiet` and `monitoring` are RESTING: they are true for
//   hours at a time, and a detail line that is always there is one nobody reads
//   by week two — which then costs the reading of the ones that matter. That is
//   the same argument that closed the permanently-amber swap warning and the
//   seven-week "partly live" banner.
//
// ⚠ `unavailable` IS active even though it can last a long time, because what
//   it says is not "here is my status" but "do not trust what is beside me".
const ACTIVE = new Set(['unavailable', 'executing', 'verifying', 'awaiting_authorisation', 'assessing']);

/** PURE. The label for a phase, or null for one this vocabulary does not know. */
function labelFor(phase) {
  return Object.prototype.hasOwnProperty.call(LABELS, phase) ? LABELS[phase] : null;
}

/**
 * PURE. Does this phase earn more than its label?
 *
 * ⚠ An unrecognised phase is NOT active. A client reading a payload from a
 *   newer backend must fall back to showing less, never to showing a detail
 *   line it cannot place.
 */
function isActivePhase(phase) {
  return ACTIVE.has(phase);
}

/** PURE. Is this phase one where a request is out and unanswered? */
function isInFlight(phase) {
  return phase === 'executing' || phase === 'verifying';
}

module.exports = { PHASES, LABELS, ACTIVE, labelFor, isActivePhase, isInFlight };
