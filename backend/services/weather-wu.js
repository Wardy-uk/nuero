'use strict';

/**
 * weather-wu — Weather Underground, both directions.
 *
 * ── IMPORT (neighbouring PWS stations) ──────────────────────────────────────
 * The public dashboards (wunderground.com/dashboard/pws/<ID>) are rendered from
 * The Weather Company's v2 PWS API, traced on 7 Oct 2026:
 *
 *   /v2/pws/observations/current      latest reading            (200, or 204 = offline)
 *   /v2/pws/observations/all/1day     today, ~5-minute summaries
 *   /v2/pws/observations/hourly/7day  last week, hourly summaries
 *   /v2/pws/history/{all|hourly|daily}?date=YYYYMMDD
 *   /v2/pws/dailysummary/1day, /v2/pwsidentity
 *
 * All need an `apiKey`. The dashboard page embeds one in its server-rendered
 * state and it answers for any station — but it is The Weather Company's key
 * for their own web front end, not one issued to us, and using it is outside
 * any terms we hold. So NEURO does NOT use it, and it is not stored anywhere.
 * The supported route is the key WU issues to a PWS OWNER (ICOALV59 is
 * registered): set WU_API_KEY and this adapter imports. Whether an owner key
 * reads OTHER people's stations is WU's documented behaviour for the PWS
 * contributor API, but it is UNVERIFIED here until a real key is in hand —
 * the first run with one will say so either way.
 *
 * Units requested `units=m`: °C, km/h, hPa, mm, m. Converted to SI here, once.
 * ⚠ `precipTotal` is the ACCUMULATION SINCE LOCAL MIDNIGHT, not this
 * interval's rain. It is stored as rain_accum_mm; rain_mm is left null rather
 * than differenced from a series that resets at a time zone's midnight and
 * restarts whenever the station does.
 *
 * ── PUBLISH (our own station ICOALV59) ──────────────────────────────────────
 * The PWS upload protocol (weatherstation.wunderground.com/.../updateweatherstation.php):
 * imperial units, `dateutc`, ID + PASSWORD (the station key). Converted from
 * SI only here, at the outbound boundary. NEURO's store stays canonical: a
 * failed upload changes nothing locally. Credentials come from the
 * environment ONLY (WU_STATION_ID, WU_STATION_KEY) and are never logged,
 * returned by a route, or written to the DB — previews redact them.
 */

const ext = require('./weather-external');

const API = 'https://api.weather.com/v2/pws';
const UPLOAD = 'https://weatherstation.wunderground.com/weatherstation/updateweatherstation.php';
const FEED = 'wu-pws-v2';
const DEFAULT_IMPORT = ['ICOALV53', 'ICOALV50', 'ICOALV19'];
const STATION_ID = /^[A-Z0-9]{4,20}$/;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (isNum(v) ? v : null);
const kmhToMs = (v) => (isNum(v) ? Math.round((v / 3.6) * 1000) / 1000 : null);

// ── Credential ───────────────────────────────────────────────────────────────
//
// The rescuetime.js pattern: pasted in Settings and stored in agent_state, read
// at CALL time so it works with no restart; `.env` WU_API_KEY wins where set.
// No route ever returns the value, not even masked — only where it came from.
const KEY_STATE = 'wu_api_key';

function _stored() {
  try { return require('../db/database').getState(KEY_STATE) || ''; } catch { return ''; }
}

function apiKey(env = process.env) {
  return env.WU_API_KEY || _stored();
}

/** WHERE the key came from — 'env' | 'stored' | null. Never what it is. */
function credentialSource(env = process.env) {
  if (env.WU_API_KEY) return 'env';
  return _stored() ? 'stored' : null;
}

/** Shape-checked only; a wrong-but-well-formed key is caught by the first import. */
function setStoredKey(value) {
  const k = String(value || '').trim();
  if (!k) return { ok: false, error: 'No key given.' };
  if (!/^[A-Za-z0-9]{20,64}$/.test(k)) return { ok: false, error: 'That does not look like a Weather Underground API key (a run of 32 letters and digits).' };
  require('../db/database').setState(KEY_STATE, k);
  return { ok: true };
}

function clearStoredKey(env = process.env) {
  require('../db/database').setState(KEY_STATE, '');
  return { ok: true, stillInEnv: Boolean(env.WU_API_KEY) };
}

function importStations(env = process.env) {
  const raw = (env.WU_IMPORT_STATIONS || '').trim();
  const list = raw ? raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : DEFAULT_IMPORT;
  return list.filter((s) => STATION_ID.test(s));
}

/** Why import cannot run, or null. PURE. */
function importBlocked(env = process.env) {
  if (!apiKey(env)) return 'No Weather Underground API key — add one in Settings → Integrations (or WU_API_KEY in .env)';
  return null;
}

/** WU qcStatus → internal qc. 1 passed, 0 not yet checked, -1 failed. PURE. */
function mapQc(q) {
  if (q === 1) return 'good';
  if (q === 0) return 'unchecked';
  if (q === -1) return 'failed';
  return q == null ? 'unknown' : `unknown:${String(q).slice(0, 16)}`;
}

function _base(o, sid, receivedAt) {
  const t = Date.parse(o && o.obsTimeUtc);
  if (!Number.isFinite(t) || !/Z$/.test(String(o.obsTimeUtc))) return null;
  return {
    source_id: `wu:${sid}`, source_type: 'wu-pws', feed: FEED, observed_at: t, received_at: receivedAt,
    lat: num(o.lat), lon: num(o.lon), qc_status: mapQc(o.qcStatus), qc_detail: null,
  };
}

/** A /observations/current entry → internal shape. PURE. */
function shapeCurrent(o, receivedAt) {
  const sid = o && typeof o.stationID === 'string' ? o.stationID : null;
  if (!sid || !STATION_ID.test(sid)) return null;
  const b = _base(o, sid, receivedAt);
  if (!b) return null;
  const m = o.metric || {};
  return {
    ...b, period_s: 0,
    temperature_c: num(m.temp), humidity_pct: num(o.humidity), dewpoint_c: num(m.dewpt), pressure_hpa: num(m.pressure),
    wind_ms: kmhToMs(m.windSpeed), gust_ms: kmhToMs(m.windGust), wind_direction_deg: num(o.winddir),
    rain_mm: null, rain_rate_mm_h: num(m.precipRate), rain_accum_mm: num(m.precipTotal), elevation_m: num(m.elev),
    raw_payload: o,
    provenance: { api: 'twc-pws-v2', endpoint: 'observations/current', units: 'm', station: sid },
  };
}

/**
 * A summary entry (/observations/all/1day, /history/all) → internal shape,
 * using the AVERAGES. `periodS` is the summary interval. PURE.
 */
function shapeSummary(o, periodS, receivedAt, endpoint = 'observations/all/1day') {
  const sid = o && typeof o.stationID === 'string' ? o.stationID : null;
  if (!sid || !STATION_ID.test(sid)) return null;
  const b = _base(o, sid, receivedAt);
  if (!b) return null;
  const m = o.metric || {};
  return {
    ...b, period_s: periodS,
    temperature_c: num(m.tempAvg), humidity_pct: num(o.humidityAvg), dewpoint_c: num(m.dewptAvg),
    pressure_hpa: isNum(m.pressureMax) && isNum(m.pressureMin) ? Math.round(((m.pressureMax + m.pressureMin) / 2) * 100) / 100 : null,
    wind_ms: kmhToMs(m.windspeedAvg), gust_ms: kmhToMs(m.windgustHigh), wind_direction_deg: num(o.winddirAvg),
    rain_mm: null, rain_rate_mm_h: num(m.precipRate), rain_accum_mm: num(m.precipTotal), elevation_m: null,
    raw_payload: o,
    provenance: { api: 'twc-pws-v2', endpoint, units: 'm', station: sid, statistic: 'interval averages; gust is the high' },
  };
}

/** Import the current reading for each configured station. */
async function syncImport({ nowMs = Date.now(), env = process.env, fetchImpl, sleep } = {}) {
  const blocked = importBlocked(env);
  if (blocked) return { ok: false, blocked };
  const results = [];
  for (const sid of importStations(env)) {
    const sourceId = `wu:${sid}`;
    const st = ext.syncState(sourceId, FEED);
    if (ext.backingOff(st, nowMs)) { results.push({ station: sid, skipped: 'backing-off', retryAfter: st.retryAfter }); continue; }
    const run = require('./source-health').beginSourceRun(`weather.wu-${sid.toLowerCase()}`, { system: 'weather-underground', expectedIntervalMs: 10 * 60 * 1000, staleAfterMs: 3 * 3600 * 1000 });
    const url = `${API}/observations/current?stationId=${encodeURIComponent(sid)}&format=json&units=m&numericPrecision=decimal&apiKey=${encodeURIComponent(apiKey(env))}`;
    try {
      const body = await ext.getJson(url, { fetchImpl, sleep, timeoutMs: 20000 });
      // 204: the station has nothing current. An answer about the station,
      // not a failure of ours — but not a success for its freshness either.
      if (body == null) {
        ext.recordSuccess(sourceId, FEED, { nowMs, stats: { offline: true } });
        run.fail('station reported no current observation (offline)', { reason: 'station-offline' });
        results.push({ station: sid, offline: true });
        continue;
      }
      const shaped = (body.observations || []).map((o) => shapeCurrent(o, nowMs)).filter(Boolean);
      const r = ext.upsert(shaped, { nowMs });
      const stats = { stored: r.stored, duplicate: r.duplicate, revised: r.revised, rejected: r.rejected };
      ext.recordSuccess(sourceId, FEED, { nowMs, newestObservedAt: r.newestObservedAt, stats });
      run.succeed(stats);
      results.push({ station: sid, ...stats });
    } catch (e) {
      // ⚠ The key is in the URL; never let a message that might echo it out.
      const msg = e.status ? `HTTP ${e.status}` : 'network error';
      const b = ext.recordFailure(sourceId, FEED, msg, { nowMs });
      run.fail(msg, { reason: e.status ? `http-${e.status}` : 'network' });
      results.push({ station: sid, error: msg, ...b });
    }
  }
  return { ok: true, results };
}

// ── Publish ──────────────────────────────────────────────────────────────────

const cToF = (c) => Math.round((c * 9 / 5 + 32) * 10) / 10;
const msToMph = (v) => Math.round(v * 2.2369363 * 10) / 10;
const hpaToInHg = (v) => Math.round(v * 0.0295299830714 * 1000) / 1000;
const mmToIn = (v) => Math.round((v / 25.4) * 1000) / 1000;

function publishConfig(env = process.env) {
  return {
    stationId: env.WU_STATION_ID || 'ICOALV59',
    keySet: !!env.WU_STATION_KEY,
    enabled: env.WU_PUBLISH_ENABLED === 'true',
  };
}

/**
 * Internal SI observation → WU upload params (no credentials). PURE.
 * `extra.rainLastHourMm` / `extra.rainTodayMm` are the two rain fields WU
 * wants; they are accumulations the caller must compute, never guessed here.
 * A measure that is null is OMITTED — WU reads an absent field as "no sensor",
 * which is the truth; a 0 would be a reading.
 */
function toWuParams(obs, extra = {}) {
  if (!obs || !Number.isFinite(obs.observedAt)) return null;
  const p = { dateutc: new Date(obs.observedAt).toISOString().slice(0, 19).replace('T', ' '), action: 'updateraw', softwaretype: 'NEURO' };
  if (isNum(obs.temperatureC)) p.tempf = cToF(obs.temperatureC);
  if (isNum(obs.humidityPct)) p.humidity = Math.round(obs.humidityPct);
  if (isNum(obs.dewpointC)) p.dewptf = cToF(obs.dewpointC);
  if (isNum(obs.pressureHpa)) p.baromin = hpaToInHg(obs.pressureHpa);
  if (isNum(obs.windMs)) p.windspeedmph = msToMph(obs.windMs);
  if (isNum(obs.gustMs)) p.windgustmph = msToMph(obs.gustMs);
  if (isNum(obs.windDirectionDeg)) p.winddir = Math.round(obs.windDirectionDeg) % 360;
  if (isNum(extra.rainLastHourMm)) p.rainin = mmToIn(extra.rainLastHourMm);
  if (isNum(extra.rainTodayMm)) p.dailyrainin = mmToIn(extra.rainTodayMm);
  return p;
}

/** The request that WOULD be sent, password redacted. PURE. */
function previewUpload(obs, extra = {}, env = process.env) {
  const cfg = publishConfig(env);
  const params = toWuParams(obs, extra);
  if (!params) return { ok: false, reason: 'no observation to publish' };
  const q = new URLSearchParams({ ID: cfg.stationId, PASSWORD: '<redacted>', ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  return { ok: true, config: cfg, url: `${UPLOAD}?${q}`, params };
}

/**
 * Upload one observation. Returns {ok, status, body} — WU answers 200 with
 * the word "success", and a 200 carrying anything else is NOT an acceptance
 * (an INVALIDPASSWORDID body arrives as a 200).
 */
async function publish(obs, extra = {}, { env = process.env, fetchImpl = fetch } = {}) {
  const cfg = publishConfig(env);
  if (!cfg.keySet) return { ok: false, blocked: 'WU_STATION_KEY is not set' };
  const params = toWuParams(obs, extra);
  if (!params) return { ok: false, reason: 'no observation to publish' };
  const q = new URLSearchParams({ ID: cfg.stationId, PASSWORD: env.WU_STATION_KEY, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  let res;
  try {
    res = await fetchImpl(`${UPLOAD}?${q}`, { signal: AbortSignal.timeout(15000) });
  } catch (e) {
    return { ok: false, uncertain: true, reason: 'network error' };
  }
  const body = String(await res.text()).trim().slice(0, 200);
  const accepted = res.ok && /^success/i.test(body);
  return { ok: accepted, status: res.status, body: accepted ? 'success' : body.replace(env.WU_STATION_KEY, '<redacted>') };
}

/**
 * Publish the home station's newest reading if it is newer than the last one
 * uploaded. A no-op while the hardware is offline or publishing is off.
 */
async function publishLatest({ nowMs = Date.now(), env = process.env, fetchImpl } = {}) {
  const cfg = publishConfig(env);
  if (!cfg.enabled) return { ok: false, blocked: 'WU_PUBLISH_ENABLED is not true' };
  if (!cfg.keySet) return { ok: false, blocked: 'WU_STATION_KEY is not set' };
  const station = require('./weather-station');
  const node = env.WU_PUBLISH_NODE || station.defaultNode();
  const latest = station.latest(node, nowMs);
  if (!latest) return { ok: false, blocked: 'the home station has never reported' };
  if (latest.stale) return { ok: false, blocked: `the home station's newest reading is stale (${Math.round(latest.ageMs / 60000)} min old)` };
  const sid = `wu-publish:${cfg.stationId}`;
  const st = ext.syncState(sid, 'wu-upload');
  if (st && st.lastObservedAt && st.lastObservedAt >= latest.observedAt) return { ok: true, skipped: 'already-published' };
  if (ext.backingOff(st, nowMs)) return { ok: false, skipped: 'backing-off', retryAfter: st.retryAfter };
  const r = await publish(latest, {}, { env, fetchImpl });
  if (r.ok) ext.recordSuccess(sid, 'wu-upload', { nowMs, newestObservedAt: latest.observedAt, stats: { status: r.status } });
  else ext.recordFailure(sid, 'wu-upload', r.reason || r.body || `HTTP ${r.status}`, { nowMs });
  return { ...r, observedAt: latest.observedAt };
}

module.exports = {
  FEED, DEFAULT_IMPORT, UPLOAD,
  apiKey, credentialSource, setStoredKey, clearStoredKey,
  importStations, importBlocked, mapQc, shapeCurrent, shapeSummary, syncImport,
  publishConfig, toWuParams, previewUpload, publish, publishLatest,
};
