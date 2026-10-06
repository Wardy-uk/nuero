'use strict';

/**
 * weather-trend — the plain-English 6 / 12 / 24 hour outlook at the top of the
 * Weather screen. PURE: minutes in, words out. No model call.
 *
 * ⚠ DETERMINISTIC ON PURPOSE. This is a line he will make decisions off (coat,
 * washing out, walk the dog now or later), and a language model asked "what will
 * the weather do" will answer fluently whether or not anything supports it.
 * Every phrase here is chosen by a rule that can be read and tested, and the
 * evidence that chose it is printed beside it.
 *
 * What it leans on, in order of trust:
 *   1. the station's PRESSURE TENDENCY over the last three hours — the classic
 *      barometer reading, measured here, not modelled. Bands are the WMO/Met
 *      Office tendency bands: steady < 1.0 hPa/3h, slowly 1.0–3.5, plain
 *      3.6–6.0, quickly > 6.0.
 *   2. the forecast's precipitation (amount and probability) for each horizon;
 *   3. humidity and temperature, as qualifiers only.
 *
 * ⚠ CALIBRATED WORDS. Nothing says "will". A barometer is good for the next few
 * hours and worth less every hour after, so the local tendency LEADS the 6-hour
 * line, QUALIFIES the 12-hour one and is not used at 24. Where the two sources
 * disagree, it says so rather than picking one.
 *
 * ⚠ AN UNREADABLE INPUT IS NAMED, never filled in. Under an hour of station
 * history means no tendency; no forecast means no rain wording — and the
 * paragraph says which, so "conditions look stable" can never be the product of
 * having looked at nothing.
 */

const HOUR = 3600 * 1000;
const RAIN_MM = 0.2;          // shared/weather-outlook's trace rule: 0.01 mm/h is a damp haze, not rain
const MIN_SPAN_MS = HOUR;     // shortest history a tendency is computed from
const TENDENCY_SPAN_MS = 3 * HOUR;
const EDGE_MS = 10 * 60 * 1000; // a tendency end is the median of ten minutes, not one reading
const DISAGREE_C = 5;         // local vs forecast temperature gap worth saying out loud

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function median(xs) {
  const s = xs.filter(isNum).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const fmt = (v, dp = 1) => (isNum(v) ? (Math.round(v * 10 ** dp) / 10 ** dp).toFixed(dp) : '—');
const signed = (v, dp = 1) => (isNum(v) ? (v > 0 ? '+' : v < 0 ? '−' : '±') + fmt(Math.abs(v), dp) : '—');

/** Europe/London wall-clock HH:MM for an instant. */
function londonTime(ms) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
}

/** WMO tendency band for a 3-hour change. PURE. */
function tendencyBand(delta3h) {
  if (!isNum(delta3h)) return null;
  const a = Math.abs(delta3h);
  const dir = delta3h > 0 ? 'rising' : 'falling';
  if (a < 1.0) return { band: 'steady', dir: 'steady', word: 'steady' };
  if (a <= 3.5) return { band: 'slow', dir, word: `${dir} slowly` };
  if (a <= 6.0) return { band: 'moderate', dir, word: dir };
  return { band: 'quick', dir, word: `${dir} quickly` };
}

/**
 * Change of one measure over the most recent stretch of history, scaled to
 * three hours. PURE. Ends are medians over ten minutes so a single noisy
 * reading cannot invent a trend. Returns null with a reason when the history is
 * too short — never a zero, which would read as "steady".
 */
function changeOver(obs, key, nowMs) {
  const rows = obs.filter((o) => isNum(o[key]) && o.t <= nowMs);
  if (rows.length < 2) return { delta3h: null, why: 'no station history yet' };
  const first = rows[0].t;
  const want = nowMs - TENDENCY_SPAN_MS;
  const startT = Math.max(first, want);
  const span = nowMs - startT;
  if (span < MIN_SPAN_MS) return { delta3h: null, why: 'under an hour of station history' };
  const startVals = rows.filter((o) => o.t >= startT && o.t < startT + EDGE_MS).map((o) => o[key]);
  const endVals = rows.filter((o) => o.t > nowMs - EDGE_MS).map((o) => o[key]);
  if (!startVals.length || !endVals.length) return { delta3h: null, why: 'a gap in the station history' };
  const a = median(startVals);
  const b = median(endVals);
  // ⚠ The medians sit at the CENTRES of their ten-minute windows, so the change
  //   happened over span − EDGE, not span. Dividing by span reads every
  //   tendency ~6% low over three hours and ~11% low over one.
  const between = span - EDGE_MS;
  return { delta3h: ((b - a) * TENDENCY_SPAN_MS) / between, raw: b - a, spanH: span / HOUR, now: b };
}

/** What the forecast says about one horizon. PURE. */
function horizonForecast(points, nowMs, hours) {
  const inside = points.filter((p) => p.validAt > nowMs && p.validAt <= nowMs + hours * HOUR);
  if (!inside.length) return null;
  const mm = inside.map((p) => p.precipMm).filter(isNum);
  const prob = inside.map((p) => p.precipProb).filter(isNum);
  const temps = inside.map((p) => p.temperatureC).filter(isNum);
  const totalMm = mm.length ? mm.reduce((s, v) => s + v, 0) : null;
  const maxProb = prob.length ? Math.max(...prob) : null;
  const wet = inside.find((p) => (isNum(p.precipMm) && p.precipMm >= RAIN_MM) || (isNum(p.precipProb) && p.precipProb >= 50));
  let rain = 'unknown';
  // ⚠ Judged on the WETTEST HOUR, not the sum: a day of 0.01 mm traces adds up
  //   past 0.2 mm and is still a damp haze, never "a chance of showers".
  const wettest = mm.length ? Math.max(...mm) : null;
  if (wettest != null || maxProb != null) {
    if ((wettest != null && wettest >= RAIN_MM && totalMm >= 1) || (maxProb != null && maxProb >= 60)) rain = 'likely';
    else if ((wettest != null && wettest >= RAIN_MM) || (maxProb != null && maxProb >= 30)) rain = 'possible';
    else rain = 'unlikely';
  }
  return {
    hours,
    rain,
    totalMm: totalMm == null ? null : Math.round(totalMm * 10) / 10,
    maxProb,
    firstWetAt: wet ? wet.validAt : null,
    tempMin: temps.length ? Math.min(...temps) : null,
    tempMax: temps.length ? Math.max(...temps) : null,
  };
}

/** The local barometer's verdict on the next few hours. PURE. */
function localSignal(pressure, humidityPct) {
  const t = tendencyBand(pressure && pressure.delta3h);
  if (!t) return null;
  const humid = isNum(humidityPct) && humidityPct >= 80;
  if (t.dir === 'falling' && (t.band !== 'slow' || humid)) {
    return { kind: 'worsening', phrase: t.band === 'quick' ? 'turning unsettled, with rain risk increasing' : 'rain risk increasing' };
  }
  if (t.dir === 'falling') return { kind: 'softening', phrase: 'possibly turning less settled' };
  if (t.dir === 'rising') return { kind: 'improving', phrase: t.band === 'quick' ? 'clearing, though a quick rise can bring wind' : 'settling' };
  return { kind: 'stable', phrase: 'conditions look stable' };
}

function rainWords(f) {
  if (!f || f.rain === 'unknown') return null;
  const detail = [];
  if (isNum(f.maxProb)) detail.push(`${Math.round(f.maxProb)}% chance`);
  if (isNum(f.totalMm) && f.totalMm >= RAIN_MM) detail.push(`${fmt(f.totalMm)} mm`);
  const when = f.firstWetAt ? ` from about ${londonTime(f.firstWetAt)}` : '';
  const d = detail.length ? ` (${detail.join(', ')})` : '';
  if (f.rain === 'likely') return `rain likely${when}${d}`;
  if (f.rain === 'possible') return `a chance of showers${when}${d}`;
  return 'dry in the forecast';
}

const tempRange = (f) => (f && isNum(f.tempMin) && isNum(f.tempMax)
  ? (Math.round(f.tempMin) === Math.round(f.tempMax) ? `around ${Math.round(f.tempMin)}°C` : `${Math.round(f.tempMin)}–${Math.round(f.tempMax)}°C`)
  : null);

/**
 * Compose the outlook. PURE.
 * @param {object} p
 * @param {Array<{t,temperatureC,humidityPct,pressureHpa}>} p.obs station minutes, any order
 * @param {Array} p.forecast standing forecast points (validAt, temperatureC, …, precipMm, precipProb)
 * @param {number} p.nowMs
 * @param {string} [p.providerLabel]
 */
function summarise({ obs = [], forecast = [], nowMs, providerLabel = 'the forecast', latestStale = false } = {}) {
  const rows = obs.slice().sort((a, b) => a.t - b.t);
  const pressure = changeOver(rows, 'pressureHpa', nowMs);
  const temp = changeOver(rows, 'temperatureC', nowMs);
  const last = rows[rows.length - 1] || null;
  const humidity = last ? last.humidityPct : null;
  const local = latestStale ? null : localSignal(pressure, humidity);
  const tend = tendencyBand(pressure.delta3h);

  const f6 = horizonForecast(forecast, nowMs, 6);
  const f12 = horizonForecast(forecast, nowMs, 12);
  const f24 = horizonForecast(forecast, nowMs, 24);

  const caveats = [];
  if (latestStale) caveats.push('the station has not reported recently, so its trend is not used');
  else if (pressure.delta3h == null) caveats.push(`no pressure trend yet — ${pressure.why}`);
  if (!f24) caveats.push('no forecast available, so rain timing is not given');

  // Local vs forecast at "now": a sheltered or indoor sensor reads warm, and
  // saying so is more useful than quietly blending two disagreeing numbers.
  const fcNow = forecast.reduce((best, p) => (Math.abs(p.validAt - nowMs) < Math.abs((best?.validAt ?? Infinity) - nowMs) ? p : best), null);
  let disagreement = null;
  if (last && !latestStale && fcNow && isNum(fcNow.temperatureC) && Math.abs(fcNow.validAt - nowMs) <= HOUR) {
    const gap = last.temperatureC - fcNow.temperatureC;
    if (Math.abs(gap) >= DISAGREE_C) {
      disagreement = gap;
      caveats.push(`the station reads ${fmt(Math.abs(gap))}°C ${gap > 0 ? 'warmer' : 'colder'} than ${providerLabel} — check it is sited outdoors and in shade`);
    }
  }

  // ── 6 hours: the barometer leads ─────────────────────────────────────────
  let six;
  const r6 = rainWords(f6);
  if (local && f6) {
    const forecastWet = f6.rain === 'likely' || f6.rain === 'possible';
    if (local.kind === 'improving' && f6.rain === 'likely') six = `mixed signals — pressure is rising but ${r6}`;
    else if ((local.kind === 'worsening') && !forecastWet) six = `${local.phrase}, though ${providerLabel} shows it dry`;
    else six = forecastWet ? `${local.phrase}; ${r6}` : local.phrase;
  } else if (local) six = local.phrase;
  else if (r6) six = r6;
  else six = 'no outlook — neither a station trend nor a forecast is available';
  const t6 = tempRange(f6);

  // ── 12 hours: forecast leads, the barometer qualifies ────────────────────
  let twelve = rainWords(f12);
  if (twelve && local && local.kind === 'worsening' && f12.rain === 'unlikely') twelve += ', though falling pressure argues for keeping an eye on it';
  if (!twelve) twelve = local ? `${local.phrase}, on the station trend alone` : null;
  const t12 = tempRange(f12);

  // ── 24 hours: forecast only ──────────────────────────────────────────────
  const twentyFour = rainWords(f24);
  const t24 = tempRange(f24);

  const join = (w, t) => [w, t].filter(Boolean).join(', ');
  const parts = [`Next 6 hours: ${join(six, t6)}.`];
  if (twelve || t12) parts.push(`Next 12: ${join(twelve, t12)}.`);
  if (twentyFour || t24) parts.push(`Next 24: ${join(twentyFour, t24)}.`);

  const evidence = [];
  if (pressure.delta3h != null && !latestStale) {
    const span = pressure.spanH < 2.9 ? ` (from ${fmt(pressure.spanH)} h of data)` : '';
    evidence.push(`pressure ${signed(pressure.delta3h)} hPa/3h, ${tend.word}${span}`);
  }
  if (last && !latestStale) {
    evidence.push(`humidity ${Math.round(last.humidityPct)}%`);
    const tw = temp.delta3h == null ? '' : Math.abs(temp.delta3h) < 0.5 ? ', steady' : temp.delta3h > 0 ? `, up ${fmt(temp.raw)}°C` : `, down ${fmt(Math.abs(temp.raw))}°C`;
    evidence.push(`${fmt(last.temperatureC)}°C${tw}`);
  }
  if (f24) evidence.push(`${providerLabel} for rain and temperature`);
  const paragraph = parts.join(' ') + (evidence.length ? ` Based on ${evidence.join('; ')}.` : '')
    + (caveats.length ? ` Note: ${caveats.join('; ')}.` : '');

  let confidence = 'low';
  if (local && f24 && disagreement == null) confidence = 'moderate';
  if (local && f24 && disagreement == null && local.kind !== 'stable'
    && ((local.kind === 'worsening' && f6 && f6.rain !== 'unlikely') || (local.kind === 'improving' && f6 && f6.rain === 'unlikely'))) confidence = 'good';

  return {
    paragraph,
    confidence,
    horizons: [
      { hours: 6, outlook: six, temperature: t6, forecast: f6 },
      { hours: 12, outlook: twelve, temperature: t12, forecast: f12 },
      { hours: 24, outlook: twentyFour, temperature: t24, forecast: f24 },
    ],
    evidence: {
      pressureDelta3h: pressure.delta3h == null ? null : Math.round(pressure.delta3h * 100) / 100,
      pressureTendency: tend ? tend.word : null,
      pressureSpanH: pressure.spanH ?? null,
      temperatureDelta: temp.raw ?? null,
      humidityPct: humidity,
      local: local ? local.kind : null,
      temperatureGapC: disagreement,
    },
    caveats,
  };
}

module.exports = { summarise, tendencyBand, changeOver, horizonForecast, localSignal, londonTime, RAIN_MM };
