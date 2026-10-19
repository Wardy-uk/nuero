'use strict';
// Test-only: run a shadow pass at its SIMULATED instant (19 Oct 2026).
//
// canonical Now reaches parts of NEURO that read the wall clock rather than the
// `now` a pass is given — decision-engine.evaluate() is one, and through it the
// Monday weekly-report check — so a scenario judged next Tuesday at 07:30 was
// decided half on that instant and half on whenever the suite happened to run.
// From Monday midday onwards the empty test database read the report as late,
// SAiM led with "S2 critical risk", and the promise tests failed by the clock.
//
// at(ms, fn) pins the global clock to `ms` for the duration of fn (the parity
// tests' approach, but scoped to one pass so fixtures are still built on the
// real clock). reportsSent(instants) — called in a test's SETUP, before any
// write baseline — records the weekly report for each simulated week as SENT in
// the test's own database through the real weekly-risk.markSent, so the
// scenario is the one the test describes, not "and the report to Chris is
// overdue". at() itself writes nothing.
// No production code or policy is changed by this file.

const RealDate = Date;
let pinned = null;

class PinnedDate extends RealDate {
  constructor(...a) { if (a.length === 0 && pinned !== null) super(pinned); else super(...a); }
  static now() { return pinned !== null ? pinned : RealDate.now(); }
}
PinnedDate.UTC = RealDate.UTC;
PinnedDate.parse = RealDate.parse;

/** Install once, before anything is required. Unpinned, it is the real clock. */
function install() { if (global.Date !== PinnedDate) global.Date = PinnedDate; }

/** Setup only: the weekly report for the week of each instant, recorded as sent. Returns the weeks. */
function reportsSent(instants) {
  const wr = require('../../weekly-risk');
  const weeks = [];
  for (const ms of instants) {
    const d = require('../../pip-deliverables').build(new RealDate(ms));
    const week = d && d.weekly && d.weekly.current && d.weekly.current.week;
    if (!week) throw new Error('no current weekly-report week at the simulated instant');
    if (!wr.sentRecord(week)) wr.markSent(week, { sentAt: new RealDate(ms).toISOString() });
    if (!weeks.includes(week)) weeks.push(week);
  }
  return weeks;
}

/** Run fn with the wall clock pinned to ms. Writes nothing. */
async function at(ms, fn) {
  const prev = pinned;
  pinned = ms;
  try { return await fn(); } finally { pinned = prev; }
}

module.exports = { install, at, reportsSent, RealDate };
