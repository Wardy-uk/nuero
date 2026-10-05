'use strict';

/**
 * T-shirt sizes for tasks (Nick, 5 Oct 2026). PURE, browser-safe.
 *
 *   XS  up to 30 min      S  30 min – 1 hr      M  1 hr – half a day
 *   L   half a day – 1 day                      XL more than a day
 *
 * A size is NOT a second field. It is a BAND of `tasks.estimate_minutes`:
 * choosing one writes the band's upper bound as the estimate (exact — it is
 * Nick's figure, never an assumption), so blocking time, the day planner and
 * "what fits now" honour it with no extra plumbing, and a task already
 * estimated shows its size without anyone setting it.
 *
 * Bands are inclusive at the top: 30 min is XS, 60 is S, 240 (half a day) is
 * M, 480 (a working day) is L, anything longer is XL.
 */

const SIZES = Object.freeze([
  { id: 'XS', label: 'XS', max: 30, minutes: 30, desc: 'Less than 30 minutes' },
  { id: 'S', label: 'S', max: 60, minutes: 60, desc: '30 minutes to an hour' },
  { id: 'M', label: 'M', max: 240, minutes: 240, desc: 'An hour to half a day' },
  { id: 'L', label: 'L', max: 480, minutes: 480, desc: 'Half a day to a day' },
  { id: 'XL', label: 'XL', max: Infinity, minutes: 960, desc: 'More than a day' },
]);

/** The size an estimate falls in; null when there is no estimate. */
function sizeOf(minutes) {
  const m = Number(minutes);
  if (minutes == null || !Number.isFinite(m) || m <= 0) return null;
  return (SIZES.find((s) => m <= s.max) || SIZES[SIZES.length - 1]).id;
}

/** The estimate a size stands for; null for an unknown size. */
function minutesFor(size) {
  const s = SIZES.find((x) => x.id === String(size || '').toUpperCase());
  return s ? s.minutes : null;
}

module.exports = { SIZES, sizeOf, minutesFor };
