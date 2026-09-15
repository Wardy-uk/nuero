'use strict';

// The past tense, read from the database (13 Sep 2026).
//
// `shared/rhythm.cjs` is the pure half — what counts as a habit, and when there
// is not enough evidence to claim one. This is the half that knows where the
// rows live. Keeping them apart is what lets the judgement pin without a
// database, exactly as `pi-health.assess()` and `context-state` are split.
//
// ⚠⚠ IT STATES A DIFFERENCE AND NEVER WHAT IT MEANS. "Shorter than your usual
//   Tuesday" is a comparison he can check against his own data. "You're tired",
//   "you're not yourself", "take it easy" are VERDICTS, and nothing here has
//   standing to give one — Apple Health cannot separate a late night from
//   illness from a hard week, which is why `health-daily` refuses to diagnose
//   and `readiness` carries its caveats rather than advice. The same line, one
//   layer up: rhythm may say what is DIFFERENT, never what it MEANS.
//
// ⚠ EVERY ANSWER CAN BE `known:false` WITH A REASON. A weekday with too few
//   samples has no habit, and saying so is the point — a pattern layer that
//   speaks from three Saturdays sounds exactly like one that knows.

const rhythm = require('../../shared/rhythm.cjs');

// Two years of nights is plenty; a year keeps the read cheap and still gives
// ~52 samples per weekday, well clear of the floor.
const SLEEP_DAYS = 365;

/**
 * How last night compares with his usual night for THAT weekday.
 *
 * ⚠ Compared within the weekday, not against a flat average. His Sunday is
 * 8h24 and his Tuesday 7h14 — over an hour apart — so a single "usual" would
 * call every Tuesday short and every Sunday long, which is a fact about the
 * week rather than about the night.
 *
 * @returns {{ known, hours, usual, weekday, direction, notable, why }}
 */
function sleepVsUsual({ days = SLEEP_DAYS } = {}) {
  let rows;
  try {
    rows = require('./health-daily').recentDays(days, { completeOnly: true });
  } catch (e) {
    return { known: false, why: 'could not read your sleep history: ' + e.message };
  }
  if (!Array.isArray(rows) || !rows.length) {
    return { known: false, why: 'no sleep history yet' };
  }

  // ⚠ `recentDays` returns newest first and `completeOnly` has already excluded
  // today's part-written row — which is what stops a half-recorded morning
  // reading as a short night.
  const latest = rows[0];
  if (!latest || !Number.isFinite(latest.asleepHours)) {
    return { known: false, why: 'no complete night recorded yet' };
  }

  const weekday = rhythm.weekdayOf(latest.day);
  if (weekday === null) return { known: false, why: 'the night carries no readable date' };

  // ⚠ The night being judged is EXCLUDED from its own baseline. Including it
  // drags the median towards itself, so an unusual night partly normalises
  // itself and the comparison understates every time.
  const sameWeekday = rows
    .filter(r => r.day !== latest.day && rhythm.weekdayOf(r.day) === weekday)
    .map(r => r.asleepHours);

  const pattern = rhythm.typical(sameWeekday);
  const cmp = rhythm.compare(latest.asleepHours, pattern);

  return {
    known: cmp.known,
    day: latest.day,
    weekday,
    hours: latest.asleepHours,
    usual: pattern.known ? pattern.typical : null,
    samples: pattern.n,
    direction: cmp.direction,
    notable: cmp.notable,
    why: cmp.known ? null : cmp.why,
  };
}

/**
 * The usual night for the weekday of a GIVEN day, excluding that day.
 *
 * WARNING  `sleepVsUsual()` picks the latest COMPLETE day, which is right for
 *   "the last night I can fully judge" and WRONG for "last night" - sleep is
 *   stamped to the WAKE DATE, so the night that just ended is TODAY's row, and
 *   today is never complete. Measured 13 Sep 2026: the row said 9.62h and the
 *   screen said 8h25, which was the night before last.
 *
 * WARNING  THE NIGHT BEING JUDGED IS STILL EXCLUDED FROM ITS OWN BASELINE.
 *   Including it drags the median towards itself and every comparison
 *   understates.
 */
function usualFor(dayStr, { days = SLEEP_DAYS } = {}) {
  const weekday = rhythm.weekdayOf(dayStr);
  if (weekday === null) return { known: false, why: 'unreadable date' };
  let rows;
  try {
    rows = require('./health-daily').recentDays(days, { completeOnly: true });
  } catch (e) {
    return { known: false, why: 'could not read your sleep history: ' + e.message };
  }
  if (!Array.isArray(rows)) return { known: false, why: 'no sleep history yet' };
  const sameWeekday = rows
    .filter(r => r.day !== dayStr && rhythm.weekdayOf(r.day) === weekday)
    .map(r => r.asleepHours);
  const pattern = rhythm.typical(sameWeekday);
  return {
    known: pattern.known,
    weekday,
    usual: pattern.known ? pattern.typical : null,
    samples: pattern.n,
    why: pattern.known ? null : pattern.why,
  };
}

/** The line for a specific night, or null when there is no habit yet. */
function lineFor(dayStr) {
  const p = usualFor(dayStr);
  if (!p.known || !Number.isFinite(p.usual)) return null;
  return sleepLine({ known: true, weekday: p.weekday, usual: p.usual });
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The comparison in words — composed ONCE, server-side, so the phone, the kiosk
 * and the desktop cannot phrase the same fact three ways.
 *
 * ⚠ Returns null when there is no habit to compare against. There is no useful
 * sentence to write about a pattern that does not exist yet, and inventing one
 * ("about normal!") is both a guess and the register saim-voice rejects.
 */
function sleepLine(read) {
  if (!read || read.known !== true || !Number.isFinite(read.usual)) return null;
  const name = DAY_NAMES[read.weekday] || 'that day';
  const hhmm = (v) => Math.floor(v) + 'h' + String(Math.round((v - Math.floor(v)) * 60)).padStart(2, '0');
  // ⚠ States the two numbers and the weekday. No adjective, no advice.
  return `usually ${hhmm(read.usual)} on a ${name}`;
}

module.exports = { sleepVsUsual, sleepLine, usualFor, lineFor, SLEEP_DAYS, DAY_NAMES };
