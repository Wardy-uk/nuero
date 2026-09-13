'use strict';

// Is this normal for a Tuesday? (13 Sep 2026)
//
// PURE and browser-safe. Takes samples and returns what is typical, or refuses.
// No DB, no clock — the caller supplies both.
//
// WHY THIS EXISTS. Nick, 13 Sep: *"you're taking it literally... think outside
// the box, dream big and anticipate."* He was right, and the gap is structural
// rather than featural: **everything NEURO does answers "what is true right
// now"**. There is no pattern layer anywhere in it. Two years of health, three
// months of activity, and nothing has ever asked what USUALLY happens at this
// time on this day. She has a present tense, and since this morning a future
// tense borrowed from a weather API. She has no past tense she can reason with,
// and anticipation is built out of the past tense.
//
// ⚠⚠ MEASURED BEFORE BUILDING, AND THE CONSTRAINT IS REAL:
//
//     health_daily    759 days  (2024-08-16 -> 2026-09-13)   ~108 per weekday
//     wins            483 rows  (2026-06-01 -> )             ~14  per weekday
//     activity_log  12,085 rows (2026-06-18 -> )
//     desktop_daily    13 days  (2026-09-01 -> )             ~2   per weekday
//     calendar_cache  105 events, a ROLLING FOUR-WEEK WINDOW
//
//   So sleep can carry a confident answer, output a usable one, and desk time
//   cannot yet — and the CALENDAR KEEPS NO HISTORY AT ALL, so "when does his
//   week really start", "which meetings actually happen" and "how often does
//   the 10am slip" are unanswerable today. That is fixable by archiving what
//   rolls out of the window, but it is not fixable RETROSPECTIVELY, which is
//   the argument for starting now.
//
// ⚠ SO IT REFUSES BY DEFAULT. `MIN_SAMPLES` is the floor, and below it the
//   answer is `known:false` WITH THE COUNT — never a mean over three days
//   presented as a habit. A pattern layer that speaks from a thin sample is
//   worse than none, because it sounds exactly like one that knows.
//
// ⚠ MEDIAN, NEVER MEAN. One 14-hour night or one 3am deploy drags a mean and
//   tells him his normal is something he has done once. `stress-score` and
//   `health-daily` both made this call already; this follows them rather than
//   picking again.
//
// ⚠ IT DESCRIBES AND NEVER PRESCRIBES. "You usually sleep 7h54 on a Saturday"
//   is a fact about him. "You should go to bed" is a verdict, and nothing here
//   has the standing to give one — the same line `health-daily` draws when it
//   refuses to diagnose.

// Below this many samples for a given weekday, there is no habit to report.
// Eight is roughly two months of one weekday: enough that a fortnight of
// oddness cannot define his normal, and low enough that a young signal becomes
// usable within a season rather than a year.
const MIN_SAMPLES = 8;

// A value this far from the typical is worth remarking on. Expressed in the
// spread of his OWN data rather than an absolute, because "an unusual night"
// means something different for someone who sleeps 6-7h than for someone who
// ranges 5-10h.
const NOTABLE_MADS = 1.5;

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Median absolute deviation — the robust spread, matching `stress-score`. */
function mad(values, mid) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return null;
  return median(v.map(x => Math.abs(x - mid)));
}

/**
 * What is typical, from a set of samples?
 *
 * @param {Array<number>} values  one per occurrence — already filtered to the
 *                                weekday (or whatever slice) being asked about
 * @returns {{ known, typical, spread, n, why }}
 */
function typical(values, opts = {}) {
  const min = opts.minSamples ?? MIN_SAMPLES;
  const v = Array.isArray(values) ? values.filter(Number.isFinite) : [];
  if (v.length < min) {
    // ⚠ The COUNT travels with the refusal. "I have only looked at three
    // Saturdays" is a fact he can act on — it tells him to wait, not that
    // something is broken.
    return { known: false, typical: null, spread: null, n: v.length, why: `only ${v.length} sample${v.length === 1 ? '' : 's'}, need ${min}` };
  }
  const mid = median(v);
  return { known: true, typical: mid, spread: mad(v, mid), n: v.length, why: null };
}

/**
 * How does today compare with what is typical?
 *
 * @returns {{ known, direction, deltas, notable, why }}
 *   direction 'above' | 'below' | 'normal'
 *   notable   true only when it is outside his OWN usual spread
 */
function compare(value, pattern, opts = {}) {
  const mads = opts.notableMads ?? NOTABLE_MADS;
  if (!pattern || pattern.known !== true) {
    return { known: false, direction: null, delta: null, notable: false, why: (pattern && pattern.why) || 'no pattern' };
  }
  if (!Number.isFinite(value)) {
    // ⚠ "Today is unreadable" is not "today is normal".
    return { known: false, direction: null, delta: null, notable: false, why: 'nothing recorded for today' };
  }
  const delta = value - pattern.typical;
  // ⚠ A ZERO SPREAD means every sample was identical, which on real data means
  // the signal is coarse rather than that he is perfectly consistent. Treat any
  // difference as unremarkable rather than dividing by zero into "notable".
  const spread = Number.isFinite(pattern.spread) && pattern.spread > 0 ? pattern.spread : null;
  const notable = spread === null ? false : Math.abs(delta) >= mads * spread;
  return {
    known: true,
    direction: Math.abs(delta) < 1e-9 ? 'normal' : delta > 0 ? 'above' : 'below',
    delta,
    notable,
    why: null,
  };
}

/** Group daily rows by weekday. `dayOf` returns 0-6 for a row. */
function byWeekday(rows, dayOf, valueOf) {
  const out = [[], [], [], [], [], [], []];
  for (const r of rows || []) {
    const d = dayOf(r);
    const v = valueOf(r);
    if (Number.isInteger(d) && d >= 0 && d <= 6 && Number.isFinite(v)) out[d].push(v);
  }
  return out;
}

/**
 * The weekday of an ISO date string, without constructing a Date.
 *
 * ⚠ `new Date('2026-09-13')` is parsed as UTC midnight, which in a negative
 * offset lands on the previous day — the same class of bug as parsing calendar
 * times. This is arithmetic on the digits and has no timezone at all.
 */
function weekdayOf(dayStr) {
  const m = String(dayStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  // Sakamoto's algorithm. 0 = Sunday.
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const yy = mo < 3 ? y - 1 : y;
  return (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + t[mo - 1] + d) % 7;
}

module.exports = { typical, compare, byWeekday, weekdayOf, median, mad, MIN_SAMPLES, NOTABLE_MADS };
