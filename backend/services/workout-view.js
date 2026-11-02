'use strict';

/**
 * A workout, looked at properly (2 Nov 2026). Contract `workout-view-v1`.
 *
 * Nick: "we need a proper view card — all stats and the GPS track on a map",
 * then "absolutely everything you can". Every tracked workout (one the watch
 * sent a GPS route for) gets a page; the newest hike leads Life → Outdoor.
 *
 *   read(id)            the whole page: map, watch + track figures, elevation
 *                       profile, heart rate, splits, body, weather where he was,
 *                       the weather station at home, the carried logger, Ember,
 *                       the route plan, the hike verdict, earlier walks of the
 *                       same route, photos, the vault note.
 *   list() / lastHike() the index and the Outdoor lead card.
 *   photoWindows / storePhoto / removePhoto / photoFile   the photo store.
 *   refreshWeather()    the ONLY network call (Open-Meteo), run by the
 *                       workout-extras job. A read never reaches the internet.
 *
 * ⚠ Reads write nothing. ⚠ An unread source is a named gap, never a zero.
 * ⚠ Coordinates of where he walked ARE returned here (the track is the point of
 *   the page) — the reverse of outdoor.js's old rule, by Nick's call on 12 Oct
 *   when watch tracks started being kept.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const model = require('./workout-view-model');

const CONTRACT = 'workout-view-v1';
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const MAX_THUMB_BYTES = 600 * 1024;
const WEATHER_PER_PASS = 6;

function _db() { return require('../db/database'); }
function _loop() { return require('./hiking-loop'); }
function _localMinute(ms) { return require('./world-model').localMinute(ms); }
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
function _json(s, d) { try { return s ? JSON.parse(s) : d; } catch { return d; } }
function _sql(ms) { return new Date(ms).toISOString().replace('T', ' ').slice(0, 19); }

// ── photo store location ───────────────────────────────────────────────────

function photoDir() {
  if (process.env.WORKOUT_PHOTO_DIR) return process.env.WORKOUT_PHOTO_DIR;
  if (process.env.NODE_TEST_CONTEXT) return path.join(require('os').tmpdir(), 'neuro-workout-photos-test');
  if (fs.existsSync('/mnt/data')) return '/mnt/data/neuro-workout-photos';
  return path.join(__dirname, '..', 'data', 'workout-photos');
}

// ── what counts ────────────────────────────────────────────────────────────

/** A hike is a Hiking workout, or a Walking one of an hour or more (hiking-loop's rule). */
function isHike(type, durationSeconds) {
  return /hik/i.test(type || '') || (/walk/i.test(type || '') && (durationSeconds || 0) >= 60 * 60);
}

function _window(w) {
  const loop = _loop();
  const startMs = loop.parseStamp(w.started_at);
  const endMs = w.ended_at ? loop.parseStamp(w.ended_at) : (w.duration_seconds ? startMs + w.duration_seconds * 1000 : NaN);
  return { startMs, endMs };
}

function _row(id) {
  return _db().get('SELECT * FROM health_workouts WHERE id = ?', [id]);
}

/** Every workout that has a watch track, newest first. */
function _tracked() {
  return _db().all(`SELECT w.id, w.source_uuid, w.activity_type, w.started_at, w.ended_at, w.duration_seconds, w.distance_m, w.elevation_m,
                           w.active_energy_kcal, w.avg_heart_rate, w.max_heart_rate, r.point_count
                      FROM health_workouts w JOIN workout_routes r ON r.source_uuid = w.source_uuid
                     ORDER BY w.started_at DESC`);
}

function _title(type, startLabel) {
  const kind = /hik/i.test(type) ? 'Hike' : /walk/i.test(type) ? 'Walk' : /run/i.test(type) ? 'Run' : /cycl/i.test(type) ? 'Ride' : type;
  return startLabel ? `${kind} — ${startLabel}` : kind;
}

function _places(m, startMs, endMs) {
  if (!m.known) return { start: null, end: null };
  try {
    const [j] = require('./place-naming').labelJourneys([{
      startedAt: startMs, endedAt: endMs,
      start: { lat: m.stats.start.lat, lon: m.stats.start.lon }, end: { lat: m.stats.end.lat, lon: m.stats.end.lon },
    }]);
    return { start: j.startLabel || null, end: j.endLabel || null };
  } catch { return { start: null, end: null }; }
}

// ── summaries (list, card) ─────────────────────────────────────────────────

function _summary(w, { places = true } = {}) {
  const { startMs, endMs } = _window(w);
  const route = _db().getWorkoutRoute(w.source_uuid);
  const m = model.measure(route ? route.points : []);
  const pl = places ? _places(m, startMs, endMs) : { start: null, end: null };
  let photos = 0;
  try { photos = _db().get('SELECT COUNT(*) n FROM workout_photos WHERE workout_id = ? AND removed_at IS NULL', [w.id]).n; } catch { photos = 0; }
  return {
    id: w.id, type: w.activity_type, hike: isHike(w.activity_type, w.duration_seconds),
    day: Number.isFinite(startMs) ? _loop().localDay(startMs) : String(w.started_at).slice(0, 10),
    startLocal: Number.isFinite(startMs) ? _localMinute(startMs) : null,
    endLocal: Number.isFinite(endMs) ? _localMinute(endMs) : null,
    title: _title(w.activity_type, pl.start && pl.start.name),
    distanceM: isNum(w.distance_m) ? Math.round(w.distance_m) : (m.known ? m.stats.distanceM : null),
    durationSeconds: w.duration_seconds ?? null,
    ascentM: isNum(w.elevation_m) ? Math.round(w.elevation_m) : (m.known ? m.stats.ascentM : null),
    avgHr: isNum(w.avg_heart_rate) ? Math.round(w.avg_heart_rate) : null,
    trackPoints: route ? route.pointCount : 0,
    photos, start: pl.start, end: pl.end,
    line: model.trackLine(m, 300),
  };
}

/** The index: every tracked workout, newest first. */
function list({ limit = 200 } = {}) {
  const rows = _tracked().slice(0, Math.max(1, Math.min(500, limit)));
  return { ok: true, contract: CONTRACT, workouts: rows.map((w) => _summary(w, { places: false })) };
}

/** The newest tracked hike — Life → Outdoor's lead card reads the whole page for it. */
function lastHike({ now = Date.now() } = {}) {
  const row = _tracked().find((w) => isHike(w.activity_type, w.duration_seconds));
  if (!row) return { ok: true, contract: CONTRACT, workout: null, why: 'no hike with a watch track yet' };
  return read(row.id, { now });
}

// ── the parts of one page ──────────────────────────────────────────────────

function _hrSamples(startMs, endMs) {
  return _db().all("SELECT recorded_at, value FROM health_samples WHERE metric = 'heartRate' AND recorded_at >= ? AND recorded_at <= ? ORDER BY recorded_at",
    [_sql(startMs - 60000), _sql(endMs + 60000)])
    .map((r) => ({ t: Math.round(_loop().parseStamp(r.recorded_at) / 1000), bpm: Number(r.value) }));
}

function _maxHr() {
  try { const r = require('./exertion').maxHr(); return r && isNum(r.value) ? r : null; } catch { return null; }
}

/** What else the watch measured during the window. Absent = not measured. */
function _body(startMs, endMs) {
  const db = _db();
  const sum = (metric) => { const r = db.get('SELECT SUM(value) s, COUNT(*) n FROM health_samples WHERE metric = ? AND recorded_at >= ? AND recorded_at <= ?', [metric, _sql(startMs), _sql(endMs)]); return r && r.n ? Number(r.s) : null; };
  const avg = (metric) => { const r = db.get('SELECT AVG(value) a, COUNT(*) n FROM health_samples WHERE metric = ? AND recorded_at >= ? AND recorded_at <= ?', [metric, _sql(startMs), _sql(endMs)]); return r && r.n ? Number(r.a) : null; };
  const daylightS = sum('time_in_daylight');
  const steps = sum('steps');
  const one = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
  return {
    steps: steps == null ? null : Math.round(steps),
    flightsClimbed: one(sum('flights_climbed'), 0),
    activeKcal: one(sum('activeEnergy'), 0),
    daylightMinutes: daylightS == null ? null : Math.round(daylightS / 60),
    walkingSpeedKmh: one(avg('walking_speed')),
    stepLengthCm: one(avg('walking_step_length'), 0),
    asymmetryPct: one(avg('walking_asymmetry_percentage')),
    doubleSupportPct: one(avg('walking_double_support_percentage')),
    soundDb: one(avg('environmental_audio_exposure'), 0),
    note: 'Totals and averages of what the watch recorded between the start and end of the workout.',
  };
}

/** The weather station at home during the walk — labelled as HOME, never as where he walked. */
function _home(startMs, endMs) {
  try {
    const r = _db().get(`SELECT MIN(temperature_c) lo, MAX(temperature_c) hi, AVG(humidity_pct) rh,
                                MIN(pressure_hpa) plo, MAX(pressure_hpa) phi, COUNT(*) n
                           FROM weather_observations WHERE observed_at >= ? AND observed_at <= ?`, [startMs, endMs]);
    if (!r || !r.n) return { known: false, why: 'the home weather station has no readings for that time' };
    const f = (v) => (v == null ? null : Math.round(v * 10) / 10);
    return { known: true, where: 'at home (the outdoor station)', readings: r.n, tempMinC: f(r.lo), tempMaxC: f(r.hi), humidityPct: Math.round(r.rh), pressureMinHpa: f(r.plo), pressureMaxHpa: f(r.phi) };
  } catch (e) { return { known: false, why: `could not read the home station: ${e.message}` }; }
}

function _weather(id) {
  let r = null;
  try { r = _db().get('SELECT state, payload, why, fetched_at FROM workout_weather WHERE workout_id = ?', [id]); } catch { r = null; }
  if (!r) return { state: 'pending', why: 'NEURO has not fetched the weather for this walk yet — it is fetched in the background within half an hour' };
  if (r.state !== 'ok') return { state: 'unavailable', why: r.why || 'the weather could not be read', fetchedAt: r.fetched_at };
  return { state: 'ok', fetchedAt: r.fetched_at, ..._json(r.payload, {}) };
}

function _links(id) {
  try { return _db().all('SELECT relation, target_id, label, set_at FROM outdoor_activity_links WHERE activity_id = ?', [`workout:${id}`]); } catch { return []; }
}

function _routePlan(links) {
  const l = links.find((x) => x.relation === 'route');
  if (!l) return null;
  let r = null;
  try { r = _db().get('SELECT route_id, name, distance_km, elevation_gain_m, geometry_json, region, difficulty FROM outdoor_routes WHERE route_id = ?', [l.target_id]); } catch { r = null; }
  if (!r) return { routeId: l.target_id, name: l.label || null, missing: true };
  const geom = _json(r.geometry_json, []);
  return { routeId: r.route_id, name: r.name, distanceKm: r.distance_km, elevationGainM: r.elevation_gain_m, region: r.region, difficulty: r.difficulty, line: model.thin(geom, 800) };
}

function _verdict(w, route, startMs, endMs) {
  const loop = _loop();
  const track = loop.routeFromPayload(w.payload, w.created_at);
  const mins = w.duration_seconds ? Math.round(w.duration_seconds / 60) : null;
  const tv = loop.trackVerdict({ type: w.activity_type, mins, startMs, endMs, track });
  let day = null;
  try {
    const d = loop.localDay(startMs);
    const weeksBack = Math.ceil((Date.now() - startMs) / (7 * 86400000)) + 1;
    if (weeksBack <= loop.MAX_WEEKS) {
      const h = loop.read({ weeks: weeksBack });
      if (h && h.active) for (const wk of h.weeks) for (const v of wk.days) if (v.day === d) day = { state: v.state, by: v.by || null, why: v.why };
    }
  } catch { day = null; }
  return { counts: tv.valid, why: tv.why, day, rule: 'A hike counts when the watch recorded its GPS track with a Hiking workout (or a 60+ minute Walking one) and it arrived within 24 hours — or when you say so.' };
}

function _comparison(w, m) {
  if (!m.known) return { others: [], why: 'no track to compare' };
  const others = [];
  for (const o of _tracked()) {
    if (o.id === w.id) continue;
    const r = _db().getWorkoutRoute(o.source_uuid);
    if (!r || !r.points || !r.points.length) continue;
    const first = r.points[0];
    const startGap = require('./outdoor-model').haversineM({ lat: first[0], lon: first[1] }, { lat: m.stats.start.lat, lon: m.stats.start.lon });
    if (startGap > model.SAME_ROUTE_START_M) continue;
    const om = model.measure(r.points);
    const same = model.sameRoute(m, om);
    if (!same.same) continue;
    const { startMs } = _window(o);
    others.push({
      id: o.id, day: Number.isFinite(startMs) ? _loop().localDay(startMs) : String(o.started_at).slice(0, 10), type: o.activity_type,
      durationSeconds: o.duration_seconds, movingSeconds: om.stats.movingSeconds, distanceM: isNum(o.distance_m) ? Math.round(o.distance_m) : om.stats.distanceM,
      paceSecPerKm: om.stats.movingPaceSecPerKm, ascentM: isNum(o.elevation_m) ? Math.round(o.elevation_m) : om.stats.ascentM,
      avgHr: isNum(o.avg_heart_rate) ? Math.round(o.avg_heart_rate) : null, why: same.why,
    });
  }
  others.sort((a, b) => (a.day < b.day ? 1 : -1));
  return { others, why: others.length ? `${others.length} other walk${others.length === 1 ? '' : 's'} followed the same route` : 'no other tracked walk followed this route' };
}

function _photos(id, m) {
  let rows = [];
  try { rows = _db().all('SELECT * FROM workout_photos WHERE workout_id = ? AND removed_at IS NULL ORDER BY taken_at', [id]); } catch { rows = []; }
  return rows.map((p) => {
    const takenMs = p.taken_at ? Date.parse(p.taken_at) : NaN;
    const pin = model.placePhoto({ lat: p.lat, lon: p.lon, takenT: Number.isFinite(takenMs) ? takenMs / 1000 : null }, m);
    return {
      id: p.photo_id, takenAt: p.taken_at, takenLocal: Number.isFinite(takenMs) ? _localMinute(takenMs) : null,
      width: p.width, height: p.height, ...pin,
    };
  });
}

function _note(id) {
  try {
    const r = _db().get('SELECT path, written_at FROM workout_notes WHERE workout_id = ?', [id]);
    if (!r) return null;
    const vault = encodeURIComponent(process.env.OBSIDIAN_VAULT_NAME || 'Nicks knowledge base');
    return { path: r.path, writtenAt: r.written_at, obsidianUrl: `obsidian://open?vault=${vault}&file=${encodeURIComponent(r.path)}` };
  } catch { return null; }
}

function _nav(id) {
  const rows = _tracked();
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) return { newer: null, older: null };
  return { newer: i > 0 ? rows[i - 1].id : null, older: i < rows.length - 1 ? rows[i + 1].id : null };
}

// ── the page ───────────────────────────────────────────────────────────────

/** The whole page for one workout. Writes nothing. */
function read(id, { now = Date.now() } = {}) {
  const wid = Number(id);
  if (!Number.isInteger(wid) || wid <= 0) return { ok: false, status: 400, error: 'id must be a workout number' };
  const w = _row(wid);
  if (!w) return { ok: false, status: 404, error: 'no such workout' };
  const gaps = [];
  const { startMs, endMs } = _window(w);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { ok: false, status: 409, error: 'this workout has no usable start and end time' };

  const route = w.source_uuid ? _db().getWorkoutRoute(w.source_uuid) : null;
  const m = model.measure(route ? route.points : []);
  if (!m.known) gaps.push({ input: 'track', why: route ? m.why : 'the watch sent no GPS route with this workout' });

  let hrSamples = [];
  try { hrSamples = _hrSamples(startMs, endMs); } catch (e) { gaps.push({ input: 'heart-rate', why: e.message }); }
  const maxHr = _maxHr();
  const hr = model.heartRate(hrSamples, { startT: startMs / 1000, endT: endMs / 1000, max: maxHr ? maxHr.value : null });
  if (hr.known && maxHr) hr.maxSource = maxHr.source === 'override' ? 'set by NEURO_MAX_HR' : 'the highest you have reached in a year (daily 99th percentile)';

  let body = null;
  try { body = _body(startMs, endMs); } catch (e) { gaps.push({ input: 'body', why: e.message }); }

  let logger = null;
  try { logger = require('./environment').conditionsForWorkout(wid); } catch (e) { gaps.push({ input: 'logger', why: e.message }); }

  const links = _links(wid);
  const companions = links.filter((l) => l.relation === 'companion').map((l) => ({ id: l.target_id, name: l.label || 'Ember' }));
  const places = _places(m, startMs, endMs);
  const photos = _photos(wid, m);
  const plan = _routePlan(links);

  return {
    ok: true, contract: CONTRACT,
    workout: {
      id: wid, uuid: w.source_uuid, type: w.activity_type, hike: isHike(w.activity_type, w.duration_seconds),
      day: _loop().localDay(startMs), startLocal: _localMinute(startMs), endLocal: _localMinute(endMs),
      title: _title(w.activity_type, places.start && places.start.name), source: w.source,
    },
    places,
    watch: {
      label: 'What the watch measured',
      distanceM: isNum(w.distance_m) ? Math.round(w.distance_m) : null,
      durationSeconds: w.duration_seconds ?? null,
      ascentM: isNum(w.elevation_m) ? Math.round(w.elevation_m) : null,
      activeKcal: isNum(w.active_energy_kcal) ? Math.round(w.active_energy_kcal) : null,
      avgHr: isNum(w.avg_heart_rate) ? Math.round(w.avg_heart_rate) : null,
      maxHr: isNum(w.max_heart_rate) ? Math.round(w.max_heart_rate) : null,
    },
    track: m.known ? { label: 'Measured from the GPS track', ...m.stats } : { known: false, why: gaps.find((g) => g.input === 'track')?.why },
    map: {
      line: model.trackLine(m),
      plan: plan && plan.line ? plan.line : [],
      start: m.known ? m.stats.start : null, end: m.known ? m.stats.end : null,
      highest: m.known ? m.stats.highest : null,
      photos: photos.filter((p) => isNum(p.lat)).map((p) => ({ id: p.id, lat: p.lat, lon: p.lon, placedBy: p.placedBy, takenLocal: p.takenLocal })),
    },
    profile: model.elevationProfile(m),
    heartRate: hr,
    splits: model.splits(m, hr.known ? hrSamples : []),
    body,
    weather: _weather(wid),
    home: _home(startMs, endMs),
    logger,
    companions,
    routePlan: plan ? { ...plan, line: undefined } : null,
    verdict: _verdict(w, route, startMs, endMs),
    comparison: (() => { try { return _comparison(w, m); } catch (e) { gaps.push({ input: 'comparison', why: e.message }); return { others: [], why: 'could not compare' }; } })(),
    photos,
    note: _note(wid),
    nav: _nav(wid),
    gaps,
    generatedAt: new Date(now).toISOString(),
  };
}

// ── weather (the one network call) ─────────────────────────────────────────

const WMO = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
  85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
};

/**
 * PURE. Open-Meteo's hourly answer → the hours the walk covered, plus a summary.
 * `times` are London wall-clock "YYYY-MM-DDTHH:MM" strings (asked with timezone).
 */
function shapeWeather(json, { startLocal, endLocal, lat, lon }) {
  const h = json && json.hourly;
  if (!h || !Array.isArray(h.time)) return null;
  const from = `${startLocal.slice(0, 13)}:00`.replace(' ', 'T');
  const to = endLocal.replace(' ', 'T');
  const hours = [];
  for (let i = 0; i < h.time.length; i++) {
    if (h.time[i] < from || h.time[i] > to) continue;
    hours.push({
      at: h.time[i].slice(11, 16), tempC: h.temperature_2m?.[i] ?? null, feelsLikeC: h.apparent_temperature?.[i] ?? null,
      humidityPct: h.relative_humidity_2m?.[i] ?? null, rainMm: h.precipitation?.[i] ?? null, cloudPct: h.cloud_cover?.[i] ?? null,
      windMph: h.wind_speed_10m?.[i] ?? null, gustMph: h.wind_gusts_10m?.[i] ?? null, windFromDeg: h.wind_direction_10m?.[i] ?? null,
      code: h.weather_code?.[i] ?? null, words: WMO[h.weather_code?.[i]] || null,
    });
  }
  if (!hours.length) return null;
  const nums = (k) => hours.map((x) => x[k]).filter(isNum);
  const day = startLocal.slice(0, 10);
  const di = json.daily && Array.isArray(json.daily.time) ? json.daily.time.indexOf(day) : -1;
  const codes = hours.map((x) => x.code).filter(isNum);
  const worst = codes.length ? Math.max(...codes) : null;
  return {
    where: `where you walked (${lat.toFixed(2)}, ${lon.toFixed(2)})`, source: 'Open-Meteo',
    summary: {
      words: WMO[worst] || null, tempMinC: Math.min(...nums('tempC')), tempMaxC: Math.max(...nums('tempC')),
      feelsLikeMinC: nums('feelsLikeC').length ? Math.min(...nums('feelsLikeC')) : null,
      rainMm: Math.round(nums('rainMm').reduce((a, b) => a + b, 0) * 10) / 10,
      windMaxMph: nums('windMph').length ? Math.round(Math.max(...nums('windMph'))) : null,
      gustMaxMph: nums('gustMph').length ? Math.round(Math.max(...nums('gustMph'))) : null,
    },
    sun: di >= 0 ? { sunrise: String(json.daily.sunrise[di]).slice(11, 16), sunset: String(json.daily.sunset[di]).slice(11, 16) } : null,
    hours,
  };
}

async function _fetchWeather(w) {
  const route = _db().getWorkoutRoute(w.source_uuid);
  const m = model.measure(route ? route.points : []);
  if (!m.known) return { state: 'unavailable', why: 'no track to place the weather' };
  const mid = m.points[Math.floor(m.points.length / 2)];
  const { startMs, endMs } = _window(w);
  const day = _loop().localDay(startMs);
  const ageDays = (Date.now() - startMs) / 86400000;
  const base = ageDays > 75 ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast';
  const q = new URLSearchParams({
    latitude: mid[0].toFixed(3), longitude: mid[1].toFixed(3), start_date: day, end_date: day, timezone: 'Europe/London', wind_speed_unit: 'mph',
    hourly: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m,wind_direction_10m',
    daily: 'sunrise,sunset',
  });
  const res = await fetch(`${base}?${q}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`);
  const shaped = shapeWeather(await res.json(), { startLocal: _localMinute(startMs), endLocal: _localMinute(endMs), lat: mid[0], lon: mid[1] });
  return shaped ? { state: 'ok', payload: shaped } : { state: 'unavailable', why: 'Open-Meteo had no hours for that time' };
}

/** Fetch weather for tracked workouts that have none yet (or an old failure). */
async function refreshWeather({ max = WEATHER_PER_PASS } = {}) {
  const db = _db();
  const done = new Map(db.all('SELECT workout_id, state, fetched_at FROM workout_weather').map((r) => [r.workout_id, r]));
  const todo = _tracked().filter((w) => {
    const d = done.get(w.id);
    if (!d) return true;
    // An archive answer can lag a few days — retry a failure after a day.
    return d.state !== 'ok' && Date.now() - Date.parse(d.fetched_at) > 86400000;
  }).slice(0, max);
  let fetched = 0; const failed = [];
  for (const w of todo) {
    let r;
    try { r = await _fetchWeather(w); } catch (e) { r = { state: 'error', why: e.message }; failed.push(w.id); }
    db.run(`INSERT INTO workout_weather (workout_id, state, payload, why, fetched_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(workout_id) DO UPDATE SET state = excluded.state, payload = excluded.payload, why = excluded.why, fetched_at = excluded.fetched_at`,
    [w.id, r.state, r.payload ? JSON.stringify(r.payload) : null, r.why || null, new Date().toISOString()]);
    if (r.state === 'ok') fetched++;
  }
  return { checked: todo.length, fetched, failed };
}

// ── photos ─────────────────────────────────────────────────────────────────

/** What the phone should look for: every tracked workout's window, what is held and what was removed. */
function photoWindows() {
  const db = _db();
  const held = new Map();
  try {
    for (const r of db.all('SELECT workout_id, asset_id, removed_at FROM workout_photos')) {
      const e = held.get(r.workout_id) || { held: [], removed: [] };
      (r.removed_at ? e.removed : e.held).push(r.asset_id);
      held.set(r.workout_id, e);
    }
  } catch { /* none yet */ }
  return {
    ok: true, contract: 'workout-photo-windows-v1',
    rule: 'Every photo taken between a tracked workout\'s start and end, except screenshots and screen recordings. Send a resized JPEG (longest side 2048) and a thumbnail (longest side 480). Never send a removed asset again.',
    windows: _tracked().map((w) => {
      const { startMs, endMs } = _window(w);
      const e = held.get(w.id) || { held: [], removed: [] };
      return { workoutId: w.id, uuid: w.source_uuid, startAt: new Date(startMs).toISOString(), endAt: new Date(endMs).toISOString(), held: e.held, removed: e.removed };
    }).filter((x) => x.startAt && x.endAt),
  };
}

function _b64(s, max, what) {
  if (typeof s !== 'string' || !s) return { error: `${what} is required (base64 JPEG)` };
  const clean = s.replace(/^data:image\/[a-z]+;base64,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(clean)) return { error: `${what} is not base64` };
  const buf = Buffer.from(clean, 'base64');
  if (!buf.length) return { error: `${what} is empty` };
  if (buf.length > max) return { error: `${what} is ${Math.round(buf.length / 1024)} KB — larger than ${Math.round(max / 1024)} KB` };
  if (!(buf[0] === 0xff && buf[1] === 0xd8)) return { error: `${what} is not a JPEG` };
  return { buf };
}

/**
 * Keep one photo. Folds a re-send (same workout + asset), refuses a removed one.
 * The file is written BEFORE the row, so a row never points at nothing.
 */
function storePhoto(workoutId, { assetId, takenAt, lat, lon, width, height, full, thumb } = {}) {
  const wid = Number(workoutId);
  const w = Number.isInteger(wid) ? _row(wid) : null;
  if (!w) return { ok: false, status: 404, error: 'no such workout' };
  if (typeof assetId !== 'string' || !assetId.trim() || assetId.length > 200) return { ok: false, status: 400, error: 'assetId is required' };
  if (takenAt != null && Number.isNaN(Date.parse(takenAt))) return { ok: false, status: 400, error: 'takenAt must be an ISO time' };
  if (lat != null && (!isNum(lat) || Math.abs(lat) > 90)) return { ok: false, status: 400, error: 'lat is not a latitude' };
  if (lon != null && (!isNum(lon) || Math.abs(lon) > 180)) return { ok: false, status: 400, error: 'lon is not a longitude' };
  if ((lat == null) !== (lon == null)) return { ok: false, status: 400, error: 'lat and lon come together or not at all' };
  const db = _db();
  const prior = db.get('SELECT photo_id, removed_at FROM workout_photos WHERE workout_id = ? AND asset_id = ?', [wid, assetId]);
  if (prior && prior.removed_at) return { ok: false, status: 410, removed: true, error: 'Nick removed this photo — it is not taken back' };
  if (prior) return { ok: true, already: true, photoId: prior.photo_id };
  const f = _b64(full, MAX_PHOTO_BYTES, 'full');
  if (f.error) return { ok: false, status: 400, error: f.error };
  const t = _b64(thumb, MAX_THUMB_BYTES, 'thumb');
  if (t.error) return { ok: false, status: 400, error: t.error };
  const photoId = `wp_${crypto.randomBytes(8).toString('hex')}`;
  const dir = path.join(photoDir(), String(wid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${photoId}.jpg`), f.buf);
  fs.writeFileSync(path.join(dir, `${photoId}.thumb.jpg`), t.buf);
  db.run(`INSERT INTO workout_photos (photo_id, workout_id, asset_id, taken_at, lat, lon, width, height, bytes, sha256, received_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [photoId, wid, assetId, takenAt || null, lat ?? null, lon ?? null, Number.isInteger(width) ? width : null, Number.isInteger(height) ? height : null,
    f.buf.length, crypto.createHash('sha256').update(f.buf).digest('hex'), new Date().toISOString()]);
  return { ok: true, photoId };
}

/** A photo's file, or null. */
function photoFile(photoId, size = 'full') {
  if (!/^wp_[0-9a-f]{16}$/.test(String(photoId))) return null;
  const r = _db().get('SELECT workout_id, removed_at FROM workout_photos WHERE photo_id = ?', [photoId]);
  if (!r || r.removed_at) return null;
  const file = path.join(photoDir(), String(r.workout_id), `${photoId}${size === 'thumb' ? '.thumb' : ''}.jpg`);
  return fs.existsSync(file) ? file : null;
}

/** Nick removes a photo: the files go, the row stays as a tombstone so the phone never re-sends it. */
function removePhoto(photoId) {
  if (!/^wp_[0-9a-f]{16}$/.test(String(photoId))) return { ok: false, status: 400, error: 'not a photo id' };
  const db = _db();
  const r = db.get('SELECT workout_id, removed_at FROM workout_photos WHERE photo_id = ?', [photoId]);
  if (!r) return { ok: false, status: 404, error: 'no such photo' };
  if (r.removed_at) return { ok: true, already: true };
  for (const s of ['', '.thumb']) { try { fs.unlinkSync(path.join(photoDir(), String(r.workout_id), `${photoId}${s}.jpg`)); } catch { /* already gone */ } }
  db.run('UPDATE workout_photos SET removed_at = ? WHERE photo_id = ?', [new Date().toISOString(), photoId]);
  return { ok: true, workoutId: r.workout_id };
}

module.exports = {
  CONTRACT, isHike, photoDir, shapeWeather,
  list, lastHike, read, refreshWeather, photoWindows, storePhoto, photoFile, removePhoto,
  _tracked, _summary,
};
