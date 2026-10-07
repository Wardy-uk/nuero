'use strict';

/**
 * weather-nowcast — what ~16 neighbouring weather stations say about the next
 * hour or so at home, and an honest record of whether that turned out right.
 *
 * The weather MODEL owns the forecast. A ring of real stations can add two
 * things the model cannot:
 *
 *   1. RAIN ARRIVING. If stations UPWIND (by the wind the stations themselves
 *      measure) are reporting rain and home is dry, rain is likely within a
 *      rough window. Rain cells travel with the wind above the surface, which
 *      runs faster than the wind at a garden station, so the window is a RANGE
 *      (1.5–3× the measured surface wind), never a minute.
 *   2. A PRESSURE CONSENSUS. Every station's absolute pressure is offset (owners
 *      enter wrong elevations; measured 7 Oct 2026, −16 to +5 hPa), but a
 *      station's CHANGE over three hours is still valid. The median change
 *      across the ring, and how many agree, is a far stronger signal than one
 *      barometer.
 *
 * ⚠ EVERY RAIN CALL IS RECORDED AND SCORED. A prediction is a row before it is
 * a sentence on a screen; when its window has passed it is marked hit / miss /
 * unknown against the EA gauge and the near stations. Rain that starts at home
 * is recorded too, predicted or not — otherwise the record could only ever
 * count hits and false alarms, never the rain it missed.
 *
 * ⚠ HOME'S COORDINATES ARE NEVER IN CODE (the repo is public). They come from
 * weather-forecast.location() — WEATHER_LAT/LON or Home Assistant's zone.home.
 *
 * Pure half first (geometry, rain detection, wind, upwind, ETA, consensus);
 * storage and the pass below.
 */

const ext = require('./weather-external');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const MI_M = 1609.344;

const FRESH_MS = 45 * MIN;          // a reading older than this says nothing about now
const RAIN_LOOKBACK_MS = 30 * MIN;  // "raining" = rain in the last half hour
const RAIN_RATE_MM_H = 0.2;         // below this a tipping bucket is noise or dew
const RAIN_DELTA_MM = 0.2;          // one or two tips
const UPWIND_DEG = 50;              // a station within ±50° of the wind's source is upwind
const HOME_RADIUS_MI = 1.2;         // a station this close stands in for home
const NEAR_RING_MI = 3.5;           // ≤ this is the "about 2 miles" ring
const MIN_WIND_STATIONS = 3;
const MIN_PRESSURE_STATIONS = 5;
const RAW_RETAIN_DAYS = 30;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => ((r * 180) / Math.PI + 360) % 360;

// ── Geometry ─────────────────────────────────────────────────────────────────

/** Distance (miles) and bearing (° from N) from home to a point. PURE. */
function geo(home, lat, lon) {
  const dLat = rad(lat - home.lat), dLon = rad(lon - home.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(home.lat)) * Math.cos(rad(lat)) * Math.sin(dLon / 2) ** 2;
  const mi = (2 * 6371000 * Math.asin(Math.sqrt(a))) / MI_M;
  const y = Math.sin(dLon) * Math.cos(rad(lat));
  const x = Math.cos(rad(home.lat)) * Math.sin(rad(lat)) - Math.sin(rad(home.lat)) * Math.cos(rad(lat)) * Math.cos(dLon);
  return { mi, bearing: deg(Math.atan2(y, x)) };
}

const SECTORS = ['N', 'E', 'S', 'W'];
function sector(bearing) { return SECTORS[Math.round((((bearing % 360) + 360) % 360) / 90) % 4]; }
function ring(mi) { return mi <= NEAR_RING_MI ? 'near' : 'far'; }
function angleDiff(a, b) { const d = Math.abs((((a - b) % 360) + 360) % 360); return d > 180 ? 360 - d : d; }

const COMPASS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (b) => (isNum(b) ? COMPASS16[Math.round((((b % 360) + 360) % 360) / 22.5) % 16] : null);

// ── Rain at a station ────────────────────────────────────────────────────────

/**
 * Is a station raining NOW? PURE over its readings (oldest first,
 * {t, rainRateMmH, rainAccumMm}). Two signals, either suffices: a rain rate
 * reported in the last half hour, or the since-midnight total rising over it.
 * The total RESETS at local midnight — a fall is a new day, so the later value
 * is itself the rain since. Returns null when there is no fresh reading: a
 * station that has gone quiet is not a dry one.
 */
function stationRaining(readings, nowMs) {
  const recent = (readings || []).filter((r) => r.t > nowMs - RAIN_LOOKBACK_MS && r.t <= nowMs);
  if (!recent.length) return null;
  if (recent.some((r) => isNum(r.rainRateMmH) && r.rainRateMmH >= RAIN_RATE_MM_H)) return true;
  const withAcc = (readings || []).filter((r) => isNum(r.rainAccumMm) && r.t <= nowMs);
  const before = withAcc.filter((r) => r.t <= nowMs - RAIN_LOOKBACK_MS).pop() || withAcc.find((r) => r.t > nowMs - RAIN_LOOKBACK_MS);
  const last = withAcc[withAcc.length - 1];
  if (before && last && last.t > before.t) {
    const d = last.rainAccumMm >= before.rainAccumMm ? last.rainAccumMm - before.rainAccumMm : last.rainAccumMm;
    if (d >= RAIN_DELTA_MM) return true;
  }
  return false;
}

// ── Wind ─────────────────────────────────────────────────────────────────────

/**
 * The wind the ring measures: a speed-weighted vector mean of each station's
 * latest direction (WU's winddir is where the wind comes FROM). PURE.
 * `steadiness` is the length of the mean unit vector (1 = all agree, 0 = none),
 * and below 0.4 the direction is not trusted. Null when too few stations have
 * any wind to speak of.
 */
function ringWind(stations) {
  const w = stations.filter((s) => s.latest && isNum(s.latest.windDirectionDeg) && isNum(s.latest.windMs) && s.latest.windMs >= 0.5);
  if (w.length < MIN_WIND_STATIONS) return null;
  let x = 0, y = 0, sx = 0, sy = 0;
  for (const s of w) {
    x += Math.sin(rad(s.latest.windDirectionDeg)) * s.latest.windMs;
    y += Math.cos(rad(s.latest.windDirectionDeg)) * s.latest.windMs;
    sx += Math.sin(rad(s.latest.windDirectionDeg));
    sy += Math.cos(rad(s.latest.windDirectionDeg));
  }
  const speeds = w.map((s) => s.latest.windMs).sort((a, b) => a - b);
  const median = speeds[Math.floor(speeds.length / 2)];
  const steadiness = Math.hypot(sx, sy) / w.length;
  return { fromDeg: Math.round(deg(Math.atan2(x, y))), speedMs: median, stations: w.length, steadiness: Math.round(steadiness * 100) / 100, trusted: steadiness >= 0.4 };
}

/**
 * Rain arriving? PURE. Needs a trusted wind, home dry (or unknown), and at least
 * one fresh upwind station raining. ETA is a RANGE from the nearest raining
 * upwind station: rain moves at 1.5–3× the surface wind, floored at 2 m/s so a
 * calm garden never yields "in three hours".
 */
function rainArrival({ stations, wind, homeRaining }) {
  if (homeRaining === true) return { state: 'raining-here' };
  if (!wind || !wind.trusted) return { state: 'no-wind', why: wind ? 'the stations disagree on the wind direction' : 'too few stations reporting wind' };
  const upwind = stations.filter((s) => s.geo && angleDiff(s.geo.bearing, wind.fromDeg) <= UPWIND_DEG && s.geo.mi > HOME_RADIUS_MI);
  const reporting = upwind.filter((s) => s.raining !== null);
  const raining = upwind.filter((s) => s.raining === true).sort((a, b) => a.geo.mi - b.geo.mi);
  if (!upwind.length) return { state: 'no-upwind', why: `no station lies upwind (${compass(wind.fromDeg)})` };
  if (!raining.length) return { state: 'dry-upwind', upwind: upwind.map((s) => s.id), reporting: reporting.length };
  const v = Math.max(2, wind.speedMs);
  const near = raining[0];
  const meters = near.geo.mi * MI_M;
  const earliest = Math.max(5, Math.round(meters / (v * 3) / 60));
  const latest = Math.max(earliest + 10, Math.round(meters / (v * 1.5) / 60));
  return {
    state: 'rain-likely',
    nearest: { id: near.id, mi: Math.round(near.geo.mi * 10) / 10, dir: compass(near.geo.bearing) },
    raining: raining.map((s) => s.id),
    upwind: upwind.map((s) => s.id),
    etaMin: [earliest, latest],
    confidence: raining.length >= 2 ? 'moderate' : 'low',
  };
}

// ── Pressure consensus ───────────────────────────────────────────────────────

/**
 * One station's pressure change over ~3 h, scaled to 3 h. PURE. Uses the
 * reading nearest three hours ago (within 40 min) and the latest fresh one —
 * the offset cancels because both come from the same barometer.
 */
function stationTendency(readings, nowMs) {
  const p = (readings || []).filter((r) => isNum(r.pressureHpa) && r.t <= nowMs);
  if (p.length < 2) return null;
  const last = p[p.length - 1];
  if (nowMs - last.t > FRESH_MS) return null;
  const target = nowMs - 3 * HOUR;
  let best = null;
  for (const r of p) if (Math.abs(r.t - target) <= 40 * MIN && (!best || Math.abs(r.t - target) < Math.abs(best.t - target))) best = r;
  if (!best || last.t - best.t < 2 * HOUR) return null;
  return ((last.pressureHpa - best.pressureHpa) * 3 * HOUR) / (last.t - best.t);
}

function tendencyBand(d) {
  if (!isNum(d)) return null;
  const a = Math.abs(d); const dir = d > 0 ? 'rising' : 'falling';
  if (a < 1.0) return { band: 'steady', word: 'steady' };
  if (a <= 3.5) return { band: 'slow', word: `${dir} slowly` };
  if (a <= 6.0) return { band: 'moderate', word: dir };
  return { band: 'quick', word: `${dir} quickly` };
}

/** Median 3-hour change across the ring and how many stations agree. PURE. */
function pressureConsensus(tendencies) {
  const t = tendencies.filter(isNum).sort((a, b) => a - b);
  if (t.length < MIN_PRESSURE_STATIONS) return { known: false, stations: t.length, why: `${t.length} of the ring have three hours of pressure` };
  const median = t.length % 2 ? t[(t.length - 1) / 2] : (t[t.length / 2 - 1] + t[t.length / 2]) / 2;
  const band = tendencyBand(median);
  const agree = band.band === 'steady' ? t.filter((v) => Math.abs(v) < 1).length : t.filter((v) => Math.sign(v) === Math.sign(median) && Math.abs(v) >= 0.5).length;
  return { known: true, delta3h: Math.round(median * 10) / 10, word: band.word, band: band.band, stations: t.length, agree };
}

// ── Storage reads ────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }

function readings(sourceId, fromMs, toMs) {
  return _db().all(
    `SELECT observed_at AS t, temperature_c, humidity_pct, pressure_hpa, wind_ms, gust_ms, wind_direction_deg, rain_rate_mm_h, rain_accum_mm, lat, lon, elevation_m, qc_status
       FROM external_weather_observations WHERE source_id = ? AND feed = 'wu-pws-v2' AND observed_at >= ? AND observed_at <= ? ORDER BY observed_at`,
    [sourceId, fromMs, toMs]
  ).map((r) => ({ t: r.t, temperatureC: r.temperature_c, humidityPct: r.humidity_pct, pressureHpa: r.pressure_hpa, windMs: r.wind_ms, gustMs: r.gust_ms,
    windDirectionDeg: r.wind_direction_deg, rainRateMmH: r.rain_rate_mm_h, rainAccumMm: r.rain_accum_mm, lat: r.lat, lon: r.lon, elevationM: r.elevation_m, qc: r.qc_status }));
}

/** Is home raining? EA gauge first (a 15-min total > 0 in the last 30 min), then any near station. */
function homeRainNow(stations, nowMs) {
  const ea = ext.canonicalRain('ea:3641', { periodS: 900, fromMs: nowMs - 45 * MIN, toMs: nowMs + 1 });
  const eaWet = ea.length ? ea.some((p) => p.t > nowMs - 45 * MIN && (p.rainMm || 0) > 0) : null;
  const near = stations.filter((s) => s.geo && s.geo.mi <= HOME_RADIUS_MI && s.raining !== null);
  const nearWet = near.length ? near.some((s) => s.raining) : null;
  const known = eaWet !== null || nearWet !== null;
  return { raining: known ? Boolean(eaWet || nearWet) : null, ea: eaWet, near: nearWet, nearStations: near.map((s) => s.id) };
}

/** Did it rain at home between two instants? EA gauge + near-station totals. null = could not tell. */
function homeRainBetween(stationIds, fromMs, toMs) {
  const ea = ext.canonicalRain('ea:3641', { periodS: 900, fromMs, toMs });
  if (ea.some((p) => (p.rainMm || 0) > 0)) return true;
  // ⚠ "dry" needs EVIDENCE of dry: readings that cover the window. No readings
  //   at all is "could not tell", never a miss against the prediction.
  let looked = ea.some((p) => Number.isFinite(p.rainMm));
  for (const id of stationIds) {
    const r = readings(`wu:${id}`, fromMs - 30 * MIN, toMs);
    if (r.some((x) => x.t >= fromMs)) looked = true;
    for (let i = 1; i < r.length; i++) {
      const a = r[i - 1].rainAccumMm, b = r[i].rainAccumMm;
      if (isNum(a) && isNum(b) && r[i].t >= fromMs && (b - a >= RAIN_DELTA_MM || (b < a && b >= RAIN_DELTA_MM))) return true;
      if (r[i].t >= fromMs && isNum(r[i].rainRateMmH) && r[i].rainRateMmH >= RAIN_RATE_MM_H) return true;
    }
  }
  return looked ? false : null;
}

// ── The picture now ──────────────────────────────────────────────────────────

/**
 * Build the nowcast. `home` = {lat, lon} or null (then no geometry and no rain
 * call — said, not guessed).
 */
function build({ home, nowMs = Date.now(), env = process.env } = {}) {
  const wu = require('./weather-wu');
  const ids = wu.importStations(env);
  const ground = (() => { try { return JSON.parse(_db().getState('wu_ground_elevation') || '{}') || {}; } catch { return {}; } })();
  const stations = ids.map((id) => {
    const r = readings(`wu:${id}`, nowMs - 4 * HOUR, nowMs);
    const lastAny = _db().get(`SELECT lat, lon, raw_payload FROM external_weather_observations WHERE source_id = ? ORDER BY observed_at DESC LIMIT 1`, [`wu:${id}`]);
    const fresh = r.filter((x) => x.t > nowMs - FRESH_MS);
    const latest = fresh.length ? fresh[fresh.length - 1] : null;
    let name = null; try { name = lastAny ? JSON.parse(lastAny.raw_payload).neighborhood || null : null; } catch { /* label only */ }
    const g = home && lastAny && isNum(lastAny.lat) && isNum(lastAny.lon) ? geo(home, lastAny.lat, lastAny.lon) : null;
    return {
      id, name,
      geo: g ? { mi: Math.round(g.mi * 100) / 100, bearing: Math.round(g.bearing), dir: compass(g.bearing), sector: sector(g.bearing), ring: ring(g.mi) } : null,
      latest: latest ? { ...latest, ageMs: nowMs - latest.t } : null,
      lastSeenAt: r.length ? r[r.length - 1].t : null,
      raining: stationRaining(r, nowMs),
      tendency3h: stationTendency(r, nowMs),
      elevation: (() => {
        const reportedM = latest ? latest.elevationM : null;
        const groundM = ground[id] && isNum(ground[id].m) ? ground[id].m : null;
        // The server judges the mismatch, as weather-wu.nearby does, so no renderer re-derives it.
        return { reportedM, groundM, mismatch: isNum(reportedM) && isNum(groundM) && Math.abs(reportedM - groundM) > wu.ELEVATION_MISMATCH_M };
      })(),
    };
  });
  const wind = ringWind(stations);
  const home_ = homeRainNow(stations, nowMs);
  const arrival = home ? rainArrival({ stations, wind, homeRaining: home_.raining }) : { state: 'no-home', why: 'home location unknown' };
  const pressure = pressureConsensus(stations.map((s) => s.tendency3h));
  return {
    nowMs, homeKnown: !!home,
    wind: wind ? { ...wind, from: compass(wind.fromDeg), mph: Math.round(wind.speedMs * 2.2369363) } : null,
    home: home_, arrival, pressure, stations,
    reporting: stations.filter((s) => s.latest).length,
  };
}

// ── Recording and scoring ────────────────────────────────────────────────────

function _open(kind) {
  return _db().get(`SELECT * FROM weather_nowcast_predictions WHERE kind = ? AND status = 'open' ORDER BY made_at DESC LIMIT 1`, [kind]);
}

/** Score open predictions whose window has closed. */
function resolveDue(nowMs, nearIds) {
  const due = _db().all(`SELECT * FROM weather_nowcast_predictions WHERE status = 'open' AND valid_to <= ?`, [nowMs]);
  let n = 0;
  for (const p of due) {
    const r = homeRainBetween(nearIds, p.valid_from, p.valid_to);
    const status = r === true ? 'hit' : r === false ? 'miss' : 'unknown';
    _db().run('UPDATE weather_nowcast_predictions SET status = ?, resolved_at = ?, outcome = ? WHERE id = ?',
      [status, nowMs, JSON.stringify({ rainedAtHome: r }), p.id]);
    n++;
  }
  return n;
}

/**
 * One pass: score what is due, record rain starting at home, and record a new
 * rain call if there is one and none is already open. Returns the nowcast.
 */
async function pass({ nowMs = Date.now(), home = undefined, env = process.env } = {}) {
  if (home === undefined) {
    const loc = await require('./weather-forecast').location().catch(() => ({ known: false }));
    home = loc && loc.known ? { lat: loc.latitude, lon: loc.longitude } : null;
  }
  const nc = build({ home, nowMs, env });
  const nearIds = nc.stations.filter((s) => s.geo && s.geo.mi <= HOME_RADIUS_MI).map((s) => s.id);
  const resolved = resolveDue(nowMs, nearIds);
  const db = _db();

  // Rain STARTING at home — the false negatives need this.
  let prevWet = null;
  try { prevWet = JSON.parse(db.getState('weather_nowcast_home') || 'null'); } catch { prevWet = null; }
  if (nc.home.raining === true && prevWet && prevWet.raining === false) {
    const by = db.get(`SELECT id FROM weather_nowcast_predictions WHERE kind = 'rain-arrival' AND made_at <= ? AND valid_to >= ? ORDER BY made_at DESC LIMIT 1`, [nowMs, nowMs - 30 * MIN]);
    db.run('INSERT INTO weather_nowcast_onsets (at, predicted_by, evidence) VALUES (?, ?, ?)', [nowMs, by ? by.id : null, JSON.stringify(nc.home)]);
  }
  if (nc.home.raining !== null) db.setState('weather_nowcast_home', JSON.stringify({ raining: nc.home.raining, at: nowMs }));

  let recorded = null;
  if (nc.arrival.state === 'rain-likely' && !_open('rain-arrival')) {
    const [a, b] = nc.arrival.etaMin;
    const info = db.run(
      `INSERT INTO weather_nowcast_predictions (kind, made_at, valid_from, valid_to, claim, evidence) VALUES ('rain-arrival', ?, ?, ?, ?, ?)`,
      [nowMs, nowMs, nowMs + (b + 30) * MIN, JSON.stringify({ etaMin: [a, b], confidence: nc.arrival.confidence }),
        JSON.stringify({ wind: nc.wind, raining: nc.arrival.raining, nearest: nc.arrival.nearest })]
    );
    recorded = Number(info.lastInsertRowid);
  }
  return { ...nc, resolved, recorded };
}

/** The track record, for the screen. */
function record() {
  const db = _db();
  const by = Object.fromEntries(db.all(`SELECT status, COUNT(*) n FROM weather_nowcast_predictions WHERE kind = 'rain-arrival' GROUP BY status`, []).map((r) => [r.status, r.n]));
  const onsets = db.get('SELECT COUNT(*) n, SUM(predicted_by IS NOT NULL) p, MIN(at) first FROM weather_nowcast_onsets', []) || {};
  const first = db.get('SELECT MIN(made_at) t FROM weather_nowcast_predictions', []);
  const open = _open('rain-arrival');
  return {
    hits: by.hit || 0, misses: by.miss || 0, unknown: by.unknown || 0, open: by.open || 0,
    onsets: onsets.n || 0, onsetsPredicted: onsets.p || 0,
    since: Math.min(first && first.t ? first.t : Infinity, onsets.first || Infinity),
    openCall: open ? { madeAt: open.made_at, validTo: open.valid_to, claim: JSON.parse(open.claim) } : null,
  };
}

// ── Retention ────────────────────────────────────────────────────────────────

const londonDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

/**
 * Summarise every complete London day not yet summarised, then delete raw WU
 * readings older than RAW_RETAIN_DAYS. A day is only deleted once its summary
 * exists — the order is the guarantee.
 */
function retain({ nowMs = Date.now() } = {}) {
  const db = _db();
  const today = londonDay(nowMs);
  const rows = db.all(`SELECT source_id, observed_at, temperature_c, humidity_pct, pressure_hpa, wind_ms, gust_ms, rain_accum_mm
                         FROM external_weather_observations WHERE feed = 'wu-pws-v2' AND observed_at >= ? ORDER BY source_id, observed_at`,
    [nowMs - (RAW_RETAIN_DAYS + 2) * 24 * HOUR]);
  const groups = new Map();
  for (const r of rows) {
    const day = londonDay(r.observed_at);
    if (day >= today) continue;
    const k = `${r.source_id}|${day}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  let summarised = 0;
  const mean = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
  db.batchSaves(() => {
    for (const [k, list] of groups) {
      const [sid, day] = k.split('|');
      if (db.get('SELECT 1 FROM weather_station_daily WHERE source_id = ? AND day = ?', [sid, day])) continue;
      const pick = (f) => list.map((r) => r[f]).filter(isNum);
      const t = pick('temperature_c');
      const acc = pick('rain_accum_mm');
      db.run(`INSERT INTO weather_station_daily (source_id, day, n, t_min, t_max, t_mean, rh_mean, p_mean, wind_mean_ms, gust_max_ms, rain_mm)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sid, day, list.length, t.length ? Math.min(...t) : null, t.length ? Math.max(...t) : null, mean(t),
          mean(pick('humidity_pct')), mean(pick('pressure_hpa')), mean(pick('wind_ms')),
          pick('gust_ms').length ? Math.max(...pick('gust_ms')) : null, acc.length ? acc[acc.length - 1] : null]);
      summarised++;
    }
  });
  const cutoff = nowMs - RAW_RETAIN_DAYS * 24 * HOUR;
  const del = db.run(`DELETE FROM external_weather_observations WHERE feed = 'wu-pws-v2' AND observed_at < ?
                        AND EXISTS (SELECT 1 FROM weather_station_daily d WHERE d.source_id = external_weather_observations.source_id)`, [cutoff]);
  return { summarised, deleted: del.changes || 0 };
}

module.exports = {
  RAW_RETAIN_DAYS, HOME_RADIUS_MI, UPWIND_DEG,
  geo, sector, ring, angleDiff, compass, stationRaining, ringWind, rainArrival, stationTendency, pressureConsensus, tendencyBand,
  readings, build, pass, record, resolveDue, retain, londonDay,
};
