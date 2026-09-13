'use strict';

// "Is it going to rain in half an hour?" (13 Sep 2026)
//
// PURE and browser-safe. Takes the current conditions, the hourly forecast and
// `now`, and returns the one or two things worth saying. No network, no clock.
//
// Nick: *"is it going to rain in 30 mins? tell me. what's the temp going to be?
// ... I need you to think like JARVIS."* He is right that reporting the CURRENT
// sky is the least useful version — he can see out of the window. What he
// cannot see is the next three hours.
//
// ⚠⚠ A TRACE IS NOT RAIN, and this is the whole difficulty. The live forecast on
//   the morning this was written read `condition: rainy` at **0.01 mm/h** for
//   three consecutive hours — which is a damp haze, not weather anyone changes
//   their plans for. Announcing "rain at eleven" off the back of it teaches him
//   to ignore the line, and a weather warning that is always on costs nothing
//   less than the one that matters. `RAIN_MM` is the floor, and the CONDITION
//   alone is never enough.
//
// ⚠ `precipitation_probability` IS NULL on this integration (met.no). It is not
//   used at all rather than being treated as zero — a missing probability and a
//   zero probability are different facts, and only one of them means dry.
//
// ⚠ IT REPORTS A CHANGE, NOT A STATE. "Cloudy" is what he can already see.
//   "Rain from 2" and "up to 21 by lunch" are things he cannot. Where nothing
//   changes, it says nothing rather than padding.
//
// ⚠ NO FORECAST IS SILENCE, never an inferred one. A forecast is the one thing
//   here that cannot be derived from what is to hand.

// Below this, an hour is damp rather than wet. Met.no reports 0.01 mm/h for a
// haze and calls the condition `rainy`; 0.2 mm/h is where it starts to be worth
// a coat.
const RAIN_MM = 0.2;

// How far ahead is worth speaking about. Beyond a few hours it is a forecast
// rather than a heads-up, and he did not ask for a forecast.
const HORIZON_HOURS = 4;

const WET = new Set(['rainy', 'pouring', 'snowy', 'snowy-rainy', 'hail', 'lightning-rainy']);

function toMs(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function hhmm(iso) {
  const s = String(iso || '');
  // ⚠ SLICED out of the string, never parsed into a Date. Home Assistant has
  // already rendered these in the local zone, and re-parsing re-applies an
  // offset — the BST bug this repo has now hit in three separate places.
  const m = s.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

/**
 * @param {object} current  { condition, tempC }
 * @param {Array}  hours    [{ datetime, condition, temperature, precipitation }]
 * @param {Date}   now
 * @returns {{ known, rain, temp, lines }}
 *   rain  { starts, stops, mm } | null   — `starts` is a wall-clock string
 *   temp  { high, at, direction } | null
 *   lines the phrasing, composed ONCE here so every surface says it the same way
 */
function outlook(current, hours, now, opts = {}) {
  const rainMm = opts.rainMm ?? RAIN_MM;
  const horizon = opts.horizonHours ?? HORIZON_HOURS;
  const nowMs = toMs(now);
  const lines = [];

  if (!Array.isArray(hours) || !hours.length || nowMs === null) {
    return { known: false, rain: null, temp: null, lines, why: 'no hourly forecast' };
  }

  const ahead = hours
    .map(h => ({ ...h, ms: toMs(h && h.datetime) }))
    .filter(h => h.ms !== null && h.ms > nowMs && h.ms <= nowMs + horizon * 3600_000)
    .sort((a, b) => a.ms - b.ms);

  if (!ahead.length) {
    return { known: false, rain: null, temp: null, lines, why: 'the forecast does not reach the next few hours' };
  }

  // --- Rain ---------------------------------------------------------------
  // ⚠ BOTH tests must pass: the forecaster calls it wet AND there is enough of
  //   it to matter. Either alone produces a line he learns to ignore.
  const wet = ahead.filter(h => WET.has(String(h.condition)) && Number(h.precipitation) >= rainMm);
  let rain = null;
  if (wet.length) {
    const first = wet[0];
    const mins = Math.round((first.ms - nowMs) / 60000);
    rain = { starts: hhmm(first.datetime), inMinutes: mins, mm: Number(first.precipitation) };
    lines.push(mins <= 45
      ? `Rain in about ${Math.max(5, Math.round(mins / 5) * 5)} minutes`
      : `Rain from ${rain.starts}`);
  }

  // --- Temperature --------------------------------------------------------
  // ⚠ The INTERESTING number, not the current one. A high he is heading for is
  //   worth knowing; "it is 18 degrees" he can feel.
  const temps = ahead.map(h => Number(h.temperature)).filter(Number.isFinite);
  let temp = null;
  if (temps.length) {
    const nowT = Number(current && current.tempC);
    const high = Math.max(...temps);
    const peak = ahead.find(h => Number(h.temperature) === high);
    const direction = !Number.isFinite(nowT) ? null : high > nowT + 1.5 ? 'up' : high < nowT - 1.5 ? 'down' : 'flat';
    temp = { high: Math.round(high), at: hhmm(peak && peak.datetime), direction };
    // ⚠ Only worth saying when it MOVES. "Still 18" is not news.
    if (direction === 'up') lines.push(`up to ${temp.high}° by ${temp.at}`);
    else if (direction === 'down') lines.push(`down to ${Math.round(Math.min(...temps))}°`);
  }

  return { known: true, rain, temp, lines, why: null };
}

module.exports = { outlook, hhmm, RAIN_MM, HORIZON_HOURS, WET };
