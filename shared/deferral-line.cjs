'use strict';

/**
 * What "you put this off" says, in words — one vocabulary, both surfaces.
 *
 * ⚠⚠ THE SURFACE WAS PRINTING A MACHINE STRING AT HIM. `attention.js` built its
 * held line by interpolating the stored instant raw:
 *
 *     `you put this off (${entry.reason})${until ? ` until ${entry.until}` : ''}`
 *
 * which rendered, on the desk tablet:
 *
 *     1 held — you put this off (waiting-on-someone) until 2026-09-15T12:38:41.575Z.
 *
 * Three separate things wrong with that, and the third is the one that showed:
 *
 *   • `2026-09-15T12:38:41.575Z` is an identifier, not a label. This repo has
 *     the rule already — an opaque id is never a label (`candidate-provenance`,
 *     where 150 characters of base64 appeared under "waiting on you").
 *   • it is UTC. Everything else on the screen is Europe/London, so through
 *     BST that string is an hour out from every other time beside it.
 *   • it is SEVENTY-FIVE CHARACTERS. It wrapped, and the wrap pushed the foot
 *     up into the flat row — which is the "overlap" that had been chased
 *     through six commits of band-height rebalancing. The bands were being
 *     budgeted to fit a string that should never have been that long.
 *
 * ⚠ AND TASKS ALREADY SAID IT PROPERLY. `Tasks.jsx` has had `heldLine` and
 * `describeUntil` since the defer feature shipped, rendering "blocked on
 * someone, until tomorrow 12:38". So one fact had two vocabularies and the
 * ambient surface had the worse one — exactly the drift `say`, `speech` and
 * `silence` are composed server-side to prevent.
 *
 * PURE: no clock, no DB. `now` and `timeZone` are passed, so this pins without
 * either and cannot read the host's zone by accident.
 */

/**
 * ⚠ THE SLUG IS NEVER SHOWN. `waiting-on-someone` is a key in a map, and
 * printing it is the same mistake as printing the timestamp — the reader is
 * being handed the thing the code uses to look something up.
 *
 * ⚠ An unrecognised reason falls through to ITSELF rather than to "no reason
 * given": a reason NEURO recorded and this map has not learned yet is still
 * information, and replacing it with "none" would be inventing an absence.
 */
const REASON_LABELS = {
  'too-big': 'too big',
  'waiting-on-someone': 'blocked on someone',
  'no-context': 'wrong context',
  'not-now': 'not today',
  unspecified: 'no reason given',
};

/** Wall-clock parts of an instant in a named zone, or null. */
function partsIn(date, timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const out = {};
    for (const p of fmt.formatToParts(date)) {
      if (p.type !== 'literal') out[p.type] = p.value;
    }
    if (!out.year || !out.hour) return null;
    // `hour12: false` can yield "24" for midnight in some ICU versions.
    const hour = out.hour === '24' ? '00' : out.hour;
    return { ymd: `${out.year}-${out.month}-${out.day}`, hhmm: `${hour}:${out.minute}` };
  } catch {
    return null;
  }
}

/**
 * "until 14:30" / "until tomorrow 09:00" / "until Tue 09:00", or '' when there
 * is nothing honest to say.
 *
 * ⚠ COMPUTED IN A NAMED ZONE, never with the host's local getters. The Pi may
 * run in UTC — the calendar has been bitten by exactly this twice — so the zone
 * is passed and the comparison ("is that tomorrow?") is made on the SAME
 * zone's calendar days as the clock time it prints. Doing one in London and the
 * other in UTC is how "tomorrow 00:30" comes to mean tonight.
 */
function describeUntil(untilIso, { now, timeZone = 'Europe/London' } = {}) {
  if (!untilIso) return '';
  const at = new Date(untilIso);
  if (Number.isNaN(at.getTime())) return '';
  const ref = now instanceof Date ? now : new Date(now || Date.now());
  if (Number.isNaN(ref.getTime())) return '';

  const a = partsIn(at, timeZone);
  const n = partsIn(ref, timeZone);
  if (!a || !n) return '';

  if (a.ymd === n.ymd) return `until ${a.hhmm}`;

  // Whole days between the two zone-local dates.
  const days = Math.round(
    (Date.parse(`${a.ymd}T00:00:00Z`) - Date.parse(`${n.ymd}T00:00:00Z`)) / 86400000
  );
  // ⚠ A time already gone says so plainly rather than "until Sun 12:38", which
  // reads as a future date. A deferral whose clock has run out is released on
  // the next pass, so this is a narrow window — and a confident wrong tense is
  // worse than an honest vague one.
  if (days < 0) return 'and that has passed';
  if (days === 1) return `until tomorrow ${a.hhmm}`;
  if (days <= 6) {
    const weekday = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(at);
    return `until ${weekday} ${a.hhmm}`;
  }
  const when = new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short' }).format(at);
  return `until ${when}`;
}

/**
 * The whole line: "blocked on someone, until tomorrow 12:38".
 *
 * ⚠ NO SUBJECT AND NO PRONOUN. The caller already says how many were held and
 * which one this is; adding "you put this off" repeats a fact the sentence
 * around it is carrying, and length is exactly what broke this.
 */
function describeDeferral(reason, untilIso, opts = {}) {
  const label = REASON_LABELS[reason] || reason || 'no reason given';
  const until = describeUntil(untilIso, opts);
  return until ? `${label}, ${until}` : label;
}

module.exports = { REASON_LABELS, describeUntil, describeDeferral };
