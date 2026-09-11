'use strict';

/**
 * Parse a timestamp the way THIS database stores them.
 *
 * ⚠ EVERY `recorded_at` IS UTC AND CARRIES NO MARKER. `toSqlUtc` in
 * `routes/health.js` writes `d.toISOString().replace('T',' ').slice(0,19)` —
 * "2026-09-11 13:30:00" — and `apple-health.js` says so explicitly: "returning
 * 'YYYY-MM-DD HH:MM:SS' in UTC to match what routes/health.js already stores —
 * string comparison in the baseline queries is also chronological comparison,
 * which only holds if everything is UTC."
 *
 * ⚠ BUT `Date.parse` AND `new Date()` READ THAT AS LOCAL TIME. The space-
 * separated form is not ISO-8601, so V8 falls back to its lenient local-time
 * path. On a BST Pi that is a silent +60 minutes, and the Pi IS on
 * Europe/London — which is the opposite of what everyone assumed until
 * 11 Sep 2026.
 *
 * What that cost, before this existed:
 *   - `signals.js` aged a heart-rate reading taken 23 minutes ago as 83, so
 *     "Her senses" reported a live sensor as stale. A freshness panel that
 *     cries wolf is worse than none, because it is the one screen whose whole
 *     job is to be believed.
 *   - `ambient.js` buckets readings by HOUR and by DAY. Every sample landed an
 *     hour late, so "when is he usually active" was wrong by a bucket all
 *     summer, and anything after 23:00 was filed on the following day.
 *
 * Same species as `todayKey()` in `nudges.js` and `_localDate` in
 * `meeting-prep-view.js`: UTC and local mixed in one process. This is the
 * reading half of that rule.
 */

/** ISO-8601 with an explicit zone: 'Z', '+01:00', '-0500'. */
const HAS_ZONE = /(?:Z|z|[+-]\d{2}:?\d{2})$/;

/**
 * @param {string|Date|null|undefined} value
 * @returns {number} epoch ms, or NaN when unreadable
 */
function parseStoredUtc(value) {
  if (value == null) return NaN;
  if (value instanceof Date) return value.getTime();

  const text = String(value).trim();
  if (!text) return NaN;

  // Already unambiguous — an explicit zone means it says what it means.
  if (HAS_ZONE.test(text)) return Date.parse(text);

  // 'YYYY-MM-DD HH:MM:SS' or 'YYYY-MM-DDTHH:MM:SS', both UTC by our own
  // convention. Normalise to ISO and say so, rather than letting V8 guess.
  const iso = text.includes('T') ? text : text.replace(' ', 'T');
  return Date.parse(`${iso}Z`);
}

/** Convenience for the many callers that want a Date. */
function storedDate(value) {
  const ms = parseStoredUtc(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

module.exports = { parseStoredUtc, storedDate };
