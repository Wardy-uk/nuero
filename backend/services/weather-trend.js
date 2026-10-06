'use strict';

/**
 * weather-trend — the 6 / 12 / 24 hour outlook at the top of the Weather screen.
 * PURE: minutes in, words out. No model call.
 *
 * ⚠ THREE PARTS, KEPT APART (Nick, 6 Oct 2026: "split it — what the forecast
 * says and what the sensor says"). A single blended paragraph made it impossible
 * to tell which claim came from the barometer in the garden and which from a
 * weather model:
 *   • `sensor`     — what the station ALONE says, and for each reading whether it
 *                    was used and why not;
 *   • `forecast`   — what the provider says, per horizon;
 *   • `comparison` — whether they agree, and the one reading that would settle a
 *                    disagreement.
 *
 * ⚠ DETERMINISTIC ON PURPOSE. This is a line he will make decisions off (coat,
 * washing out, walk the dog now or later), and a language model asked "what will
 * the weather do" will answer fluently whether or not anything supports it.
 * Every phrase is chosen by a rule that can be read and tested.
 *
 * The sensor's main signal is the PRESSURE TENDENCY over the last three hours —
 * the classic barometer reading. Bands are the WMO/Met Office tendency bands:
 * steady < 1.0 hPa/3h, slowly 1.0–3.5, plain 3.6–6.0, quickly > 6.0. A barometer
 * speaks for the next few hours, so the sensor's verdict is scoped to ~6 h.
 *
 * ⚠ AN INDOOR SENSOR'S HUMIDITY IS NOT WEATHER. Whether the station is outside
 * is decided FIRST (≥5 °C off the forecast temperature), and when it is probably
 * not, temperature and humidity are shown as "not used" — pressure is the same
 * indoors and out, so it stays.
 *
 * ⚠ CALIBRATED WORDS. Nothing says "will". An unreadable input is named, never
 * filled in: no history means no tendency, and "steady" can never be the product
 * of having looked at nothing.
 */

const HOUR = 3600 * 1000;
const RAIN_MM = 0.2;          // shared/weather-outlook's trace rule: 0.01 mm/h is a damp haze, not rain
const MIN_SPAN_MS = HOUR;     // shortest history a tendency is computed from
const TENDENCY_SPAN_MS = 3 * HOUR;
const EDGE_MS = 10 * 60 * 1000; // a tendency end is the median of ten minutes, not one reading
const DISAGREE_C = 5;         // local vs forecast temperature gap that says "not outdoors"

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function median(xs) {
  const s = xs.filter(isNum).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const fmt = (v, dp = 1) => (isNum(v) ? (Math.round(v * 10 ** dp) / 10 ** dp).toFixed(dp) : '—');
// A change that rounds to zero is ±0.0, never +0.0 — the sign would claim a direction it does not have.
const signed = (v, dp = 1) => (isNum(v) ? (Number(fmt(Math.abs(v), dp)) === 0 ? '±' : v > 0 ? '+' : '−') + fmt(Math.abs(v), dp) : '—');

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

/**
 * The barometer's classification of the next few hours. PURE. Humidity counts
 * only when it is outdoor air — the caller passes null otherwise.
 */
function localSignal(pressure, humidityPct) {
  const t = tendencyBand(pressure && pressure.delta3h);
  if (!t) return null;
  const humid = isNum(humidityPct) && humidityPct >= 80;
  if (t.dir === 'falling' && (t.band !== 'slow' || humid)) return { kind: 'worsening' };
  if (t.dir === 'falling') return { kind: 'softening' };
  if (t.dir === 'rising') return { kind: 'improving' };
  return { kind: 'stable' };
}

/** The sensor's own one-line verdict, in its own words. PURE. */
function sensorVerdict(local, tend, humidCounted) {
  if (!local || !tend) return null;
  if (local.kind === 'worsening') {
    if (tend.band === 'quick') return 'Pressure falling quickly — turning unsettled, with rain risk increasing over the next few hours.';
    return humidCounted
      ? 'Pressure falling in humid air — rain risk increasing over the next few hours.'
      : 'Pressure falling — rain risk increasing over the next few hours.';
  }
  if (local.kind === 'softening') return 'Pressure falling slowly — possibly turning less settled.';
  if (local.kind === 'improving') {
    return tend.band === 'quick' ? 'Pressure rising quickly — clearing, though a fast rise can bring wind.' : 'Pressure rising — settling.';
  }
  return 'Pressure steady — no sign of a change in the next few hours.';
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
  return 'dry';
}

const tempRange = (f) => (f && isNum(f.tempMin) && isNum(f.tempMax)
  ? (Math.round(f.tempMin) === Math.round(f.tempMax) ? `around ${Math.round(f.tempMin)}°C` : `${Math.round(f.tempMin)}–${Math.round(f.tempMax)}°C`)
  : null);

/**
 * How the two halves line up. PURE. `watch` names the one sensor reading that
 * would confirm or undercut rain the forecast has further out than a barometer
 * can see.
 */
function compare(local, f6, f12, f24, providerLabel) {
  if (!local && !f24) return { verdict: 'none', text: 'Neither the sensor nor a forecast is available.', watch: null };
  if (!local) return { verdict: 'forecast-only', text: `Only ${providerLabel} is available for now — the sensor has no trend yet.`, watch: null };
  if (!f24) return { verdict: 'sensor-only', text: 'Only the sensor is available — no forecast to compare with.', watch: null };
  const wet6 = !!f6 && (f6.rain === 'likely' || f6.rain === 'possible');
  let verdict;
  let text;
  if (local.kind === 'worsening') {
    [verdict, text] = wet6 ? ['agree', 'Agree: both point to rain in the next few hours.']
      : ['disagree', `Disagree: pressure is falling but ${providerLabel} has the next 6 hours dry — worth watching the sky.`];
  } else if (local.kind === 'improving') {
    [verdict, text] = f6 && f6.rain === 'likely' ? ['disagree', `Disagree: pressure is rising but ${providerLabel} still has rain in the next 6 hours.`]
      : ['agree', 'Agree: settling, and the forecast is dry or close to it.'];
  } else if (local.kind === 'softening') {
    [verdict, text] = wet6 ? ['agree', 'Broadly agree: a slow fall in pressure, and the forecast has some rain about.']
      : ['partial', 'Partly agree: the forecast is dry, but pressure is easing — no strong signal either way.'];
  } else if (f6 && f6.rain === 'likely') {
    [verdict, text] = ['disagree', `Disagree: pressure is steady while ${providerLabel} expects rain within 6 hours.`];
  } else if (wet6) {
    [verdict, text] = ['agree', 'Broadly agree: steady pressure, and the forecast only has a chance of showers.'];
  } else {
    [verdict, text] = ['agree', 'Agree: settled.'];
  }
  let watch = null;
  const later = [f12, f24].find((f) => f && f.rain === 'likely' && f.firstWetAt);
  if (later && (local.kind === 'stable' || local.kind === 'improving') && !(f6 && f6.rain === 'likely')) {
    watch = `${providerLabel} has rain from about ${londonTime(later.firstWetAt)}. Frontal rain usually follows a few hours of falling pressure, so a fall of more than 1 hPa over 3 hours before then would back it up; steady pressure would suggest it is overdone.`;
  }
  return { verdict, text, watch };
}

/**
 * Compose the outlook. PURE.
 * @param {object} p
 * @param {Array<{t,temperatureC,humidityPct,pressureHpa}>} p.obs station minutes, any order
 * @param {Array} p.forecast standing forecast points (validAt, temperatureC, …, precipMm, precipProb)
 * @param {number} p.nowMs
 * @param {string} [p.providerLabel]
 * @param {boolean} [p.latestStale]
 * @param {number|null} [p.issuedAt] when the forecast in use was fetched
 */
function summarise({ obs = [], forecast = [], nowMs, providerLabel = 'the forecast', latestStale = false, issuedAt = null } = {}) {
  const rows = obs.slice().sort((a, b) => a.t - b.t);
  const pressure = changeOver(rows, 'pressureHpa', nowMs);
  const temp = changeOver(rows, 'temperatureC', nowMs);
  const last = rows[rows.length - 1] || null;
  const historyMin = rows.length ? Math.round((nowMs - rows[0].t) / 60000) : 0;

  const f6 = horizonForecast(forecast, nowMs, 6);
  const f12 = horizonForecast(forecast, nowMs, 12);
  const f24 = horizonForecast(forecast, nowMs, 24);

  // Is the station actually outside? Decided FIRST: an indoor sensor's humidity
  // must not count towards rain risk. Pressure is the same indoors and out.
  const fcNow = forecast.reduce((best, p) => (Math.abs(p.validAt - nowMs) < Math.abs((best?.validAt ?? Infinity) - nowMs) ? p : best), null);
  let gap = null;
  if (last && !latestStale && fcNow && isNum(fcNow.temperatureC) && Math.abs(fcNow.validAt - nowMs) <= HOUR) {
    const g = last.temperatureC - fcNow.temperatureC;
    if (Math.abs(g) >= DISAGREE_C) gap = g;
  }
  const indoorLikely = gap != null;
  const humidity = last ? last.humidityPct : null;
  const humidCounted = !indoorLikely && isNum(humidity) && humidity >= 80;
  const local = latestStale ? null : localSignal(pressure, indoorLikely ? null : humidity);
  const tend = tendencyBand(pressure.delta3h);

  // ── What the sensor says ─────────────────────────────────────────────────
  let verdict;
  if (!last) verdict = 'No readings from the station yet.';
  else if (latestStale) verdict = 'The station has not reported recently, so it says nothing about now.';
  else if (!local) verdict = `Too little history for a pressure trend yet — ${historyMin} min of readings; it needs an hour, and three hours is the standard.`;
  else verdict = sensorVerdict(local, tend, humidCounted);

  const lines = [];
  if (last && !latestStale) {
    if (pressure.delta3h != null) {
      const provisional = pressure.spanH < 2.9 ? ` Measured over ${fmt(pressure.spanH)} h and scaled to 3 h, so provisional.` : '';
      lines.push({ label: 'Pressure', value: `${fmt(last.pressureHpa)} hPa · ${signed(pressure.delta3h)} hPa per 3 h (${tend.word})`, note: `The main signal.${provisional}`, used: true });
    } else {
      lines.push({ label: 'Pressure', value: `${fmt(last.pressureHpa)} hPa`, note: `No trend yet — ${pressure.why}.`, used: false });
    }
    const tTrend = temp.delta3h == null ? '' : Math.abs(temp.delta3h) < 0.5 ? ' · steady' : temp.delta3h > 0 ? ` · up ${fmt(temp.raw)}°C` : ` · down ${fmt(Math.abs(temp.raw))}°C`;
    lines.push(indoorLikely
      ? { label: 'Temperature', value: `${fmt(last.temperatureC)}°C${tTrend}`, note: `${fmt(Math.abs(gap))}°C ${gap > 0 ? 'above' : 'below'} the forecast for outside, so the sensor is probably indoors or sheltered.`, used: false }
      : { label: 'Temperature', value: `${fmt(last.temperatureC)}°C${tTrend}`, note: 'Context only — temperature alone does not forecast.', used: true });
    lines.push(indoorLikely
      ? { label: 'Humidity', value: `${Math.round(humidity)}%`, note: 'Reflects where the sensor sits, not the weather.', used: false }
      : { label: 'Humidity', value: `${Math.round(humidity)}%`, note: humidity >= 80 ? 'Humid — counts towards rain risk when pressure falls.' : 'Not humid enough to add to rain risk.', used: true });
  }
  const sensor = { available: !!local, verdict, lines, horizonHours: 6, indoorLikely, historyMinutes: historyMin };

  // ── What the forecast says ───────────────────────────────────────────────
  const horizons = [[6, f6], [12, f12], [24, f24]].map(([hours, f]) => ({
    hours, rain: f ? f.rain : 'unknown', words: rainWords(f), temperature: tempRange(f),
  }));
  const forecastPart = { available: !!f24, provider: providerLabel, issuedAt, horizons };

  const comparison = compare(local, f6, f12, f24, providerLabel);

  // ── One-paragraph form, composed from the parts (for any older reader) ───
  const join = (w, t) => [w, t].filter(Boolean).join(', ');
  const parts = [`Sensor: ${verdict}`];
  if (f24) parts.push(`Forecast (${providerLabel}) — 6 h: ${join(horizons[0].words, horizons[0].temperature)}; 12 h: ${join(horizons[1].words, horizons[1].temperature)}; 24 h: ${join(horizons[2].words, horizons[2].temperature)}.`);
  else parts.push('Forecast: none available.');
  parts.push(comparison.text);
  const paragraph = parts.join(' ');

  let confidence = 'low';
  if (local && f24 && !indoorLikely && pressure.spanH >= 2.9) confidence = 'moderate';
  if (confidence === 'moderate' && comparison.verdict === 'agree' && local.kind !== 'stable') confidence = 'good';

  return {
    paragraph,
    confidence,
    sensor,
    forecast: forecastPart,
    comparison,
    evidence: {
      pressureDelta3h: pressure.delta3h == null ? null : Math.round(pressure.delta3h * 100) / 100,
      pressureTendency: tend ? tend.word : null,
      pressureSpanH: pressure.spanH ?? null,
      temperatureDelta: temp.raw ?? null,
      humidityPct: humidity,
      local: local ? local.kind : null,
      temperatureGapC: gap,
    },
  };
}

module.exports = { summarise, tendencyBand, changeOver, horizonForecast, localSignal, sensorVerdict, compare, londonTime, RAIN_MM };
