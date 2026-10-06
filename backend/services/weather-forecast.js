'use strict';

/**
 * weather-forecast — the forecast the Weather screen overlays on the station's
 * readings, behind a provider abstraction.
 *
 * ⚠ WHY NOT JUST HOME ASSISTANT. NEURO already reads `weather.forecast_home`
 * (ha-rooms.readWeather), and it was checked first: its hourly forecast carries
 * temperature, humidity and precipitation and NO PRESSURE — and pressure is the
 * one measure the station is most useful for. So the default provider is
 * Open-Meteo (keyless, hourly temperature / humidity / SURFACE pressure /
 * precipitation and its probability), with Home Assistant kept as a second
 * provider that fills what it can and leaves pressure null rather than invented.
 *
 *   WEATHER_FORECAST_PROVIDER   open-meteo (default) | home-assistant
 *   WEATHER_LAT / WEATHER_LON   optional; otherwise HA's zone.home is asked
 *
 * ⚠ SURFACE pressure, not mean-sea-level. A BME280 reports the pressure where it
 * sits; MSL is that corrected to sea level and runs ~10 hPa higher here. Station
 * vs surface is the like-for-like pairing; the model's terrain height is not the
 * garden's, so expect a small fixed offset — the TREND is what is compared.
 *
 * ⚠ SNAPSHOTS. Every fetch is stored as issued and never overwritten
 * (`weather_forecast_points`). For a past hour the overlay shows the forecast
 * that was STANDING at that hour (the newest one issued at or before it), which
 * is the only comparison that means anything: asked today, a provider's view of
 * yesterday afternoon is an analysis, not a forecast.
 */

const HOUR = 3600 * 1000;
const SNAPSHOT_MIN_GAP_MS = 45 * 60 * 1000;
const TIMEOUT_MS = 10000;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (isNum(v) ? v : null);

// ── Providers ────────────────────────────────────────────────────────────────
//
// A provider is { label, fetch(location) → points[] } where a point is
// { validAt (ms), temperatureC, humidityPct, pressureHpa, precipMm, precipProb },
// any of the measures null when the provider does not supply it.

/** Shape an Open-Meteo hourly response. PURE. */
function shapeOpenMeteo(body) {
  const h = body && body.hourly;
  if (!h || !Array.isArray(h.time)) throw new Error('Open-Meteo answered with no hourly block');
  return h.time.map((t, i) => ({
    validAt: t * 1000,
    temperatureC: num(h.temperature_2m?.[i]),
    humidityPct: num(h.relative_humidity_2m?.[i]),
    pressureHpa: num(h.surface_pressure?.[i]),
    precipMm: num(h.precipitation?.[i]),
    precipProb: num(h.precipitation_probability?.[i]),
  })).filter((p) => Number.isFinite(p.validAt));
}

/** Shape Home Assistant's hourly `get_forecasts` entries. PURE. */
function shapeHomeAssistant(hours) {
  return (Array.isArray(hours) ? hours : []).map((h) => ({
    validAt: Date.parse(h && h.datetime),
    temperatureC: num(h && h.temperature),
    humidityPct: num(h && h.humidity),
    pressureHpa: num(h && h.pressure),
    precipMm: num(h && h.precipitation),
    precipProb: num(h && h.precipitation_probability),
  })).filter((p) => Number.isFinite(p.validAt));
}

const PROVIDERS = {
  'open-meteo': {
    label: 'Open-Meteo',
    async fetch(loc) {
      const q = new URLSearchParams({
        latitude: String(loc.latitude), longitude: String(loc.longitude),
        hourly: 'temperature_2m,relative_humidity_2m,surface_pressure,precipitation,precipitation_probability',
        timezone: 'UTC', timeformat: 'unixtime', forecast_days: '3',
      });
      const res = await fetch('https://api.open-meteo.com/v1/forecast?' + q, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error('Open-Meteo answered HTTP ' + res.status);
      return shapeOpenMeteo(await res.json());
    },
  },
  'home-assistant': {
    label: 'Home Assistant forecast',
    needsLocation: false,
    async fetch() {
      const w = await require('./ha-rooms').readWeather();
      if (!w || !w.known) throw new Error((w && w.why) || 'Home Assistant weather unreadable');
      return shapeHomeAssistant(w.hours);
    },
  },
};

function providerName() {
  const p = (process.env.WEATHER_FORECAST_PROVIDER || 'open-meteo').trim();
  return PROVIDERS[p] ? p : null;
}

async function location() {
  const lat = Number(process.env.WEATHER_LAT);
  const lon = Number(process.env.WEATHER_LON);
  if (process.env.WEATHER_LAT && process.env.WEATHER_LON && Number.isFinite(lat) && Number.isFinite(lon)) {
    return { known: true, latitude: lat, longitude: lon, from: 'env' };
  }
  const h = await require('./ha-rooms').readHomeLocation();
  return h.known ? { ...h, from: 'home-assistant' } : h;
}

// ── Pure selection and alignment ─────────────────────────────────────────────

/**
 * From many snapshots, one value per valid hour. PURE.
 *   • a PAST hour takes the newest forecast issued AT OR BEFORE it — the one that
 *     was standing; a snapshot issued afterwards is excluded, not used instead;
 *   • a FUTURE hour takes the newest forecast there is.
 * Rows are { issued_at, valid_at, temperature_c, ... } as stored.
 */
function pickStanding(rows, nowMs) {
  const best = new Map();
  for (const r of rows) {
    if (r.valid_at <= nowMs && r.issued_at > r.valid_at) continue;
    const cur = best.get(r.valid_at);
    if (!cur || r.issued_at > cur.issued_at) best.set(r.valid_at, r);
  }
  return [...best.values()].sort((a, b) => a.valid_at - b.valid_at).map((r) => ({
    validAt: r.valid_at,
    issuedAt: r.issued_at,
    temperatureC: r.temperature_c,
    humidityPct: r.humidity_pct,
    pressureHpa: r.pressure_hpa,
    precipMm: r.precip_mm,
    precipProb: r.precip_prob,
  }));
}

const KEYS = ['temperatureC', 'humidityPct', 'pressureHpa'];

/**
 * Put hourly forecast points onto the chart's buckets. PURE.
 *   • buckets of an hour or less: linear interpolation at the bucket's MIDPOINT
 *     between the two hourly points either side — but only when both are within
 *     two hours, so a gap in the snapshots is drawn as a gap, not a straight line;
 *   • longer buckets: the mean of the points that fall inside it.
 * A measure the provider did not supply stays null.
 */
function alignToBuckets(points, plan) {
  const pts = points.slice().sort((a, b) => a.validAt - b.validAt);
  const out = [];
  if (plan.bucketMs <= HOUR) {
    let j = 0;
    for (const t of plan.starts) {
      const mid = t + plan.bucketMs / 2;
      while (j < pts.length - 1 && pts[j + 1].validAt <= mid) j++;
      const a = pts[j];
      const b = pts[j + 1];
      const row = { t };
      for (const k of KEYS) {
        let v = null;
        if (a && a.validAt === mid && isNum(a[k])) v = a[k];
        else if (a && b && a.validAt <= mid && b.validAt >= mid && b.validAt - a.validAt <= 2 * HOUR && isNum(a[k]) && isNum(b[k])) {
          v = a[k] + ((b[k] - a[k]) * (mid - a.validAt)) / (b.validAt - a.validAt);
        }
        row[k] = v == null ? null : Math.round(v * 100) / 100;
      }
      out.push(row);
    }
    return out;
  }
  let j = 0;
  for (const t of plan.starts) {
    const end = t + plan.bucketMs;
    while (j < pts.length && pts[j].validAt < t) j++;
    const inside = [];
    for (let k = j; k < pts.length && pts[k].validAt < end; k++) inside.push(pts[k]);
    const row = { t };
    for (const k of KEYS) {
      const vs = inside.map((p) => p[k]).filter(isNum);
      row[k] = vs.length ? Math.round((vs.reduce((s, v) => s + v, 0) / vs.length) * 100) / 100 : null;
    }
    out.push(row);
  }
  return out;
}

// ── Storage ──────────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }

function storeSnapshot(provider, issuedAt, points) {
  const db = _db();
  let stored = 0;
  db.batchSaves(() => {
    for (const p of points) {
      stored += db.run(
        `INSERT OR IGNORE INTO weather_forecast_points
           (provider, issued_at, valid_at, temperature_c, humidity_pct, pressure_hpa, precip_mm, precip_prob)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [provider, issuedAt, p.validAt, p.temperatureC, p.humidityPct, p.pressureHpa, p.precipMm, p.precipProb]
      ).changes;
    }
  });
  return stored;
}

function lastIssued(provider) {
  const r = _db().get('SELECT MAX(issued_at) AS t FROM weather_forecast_points WHERE provider = ?', [provider]);
  return r && r.t != null ? r.t : null;
}

/**
 * Fetch and store one snapshot. Skips when the last one is under 45 minutes
 * old (a restart, a manual press and the hourly cron must not stack three
 * identical copies) unless `force`. Never throws.
 */
async function snapshot({ force = false, nowMs = Date.now() } = {}) {
  const name = providerName();
  if (!name) return { ok: false, why: `unknown WEATHER_FORECAST_PROVIDER "${process.env.WEATHER_FORECAST_PROVIDER}"` };
  try {
    const last = lastIssued(name);
    if (!force && last != null && nowMs - last < SNAPSHOT_MIN_GAP_MS) return { ok: true, skipped: true, provider: name, issuedAt: last };
    const p = PROVIDERS[name];
    let loc = null;
    if (p.needsLocation !== false) {
      loc = await location();
      if (!loc.known) return { ok: false, provider: name, why: 'no forecast location: ' + loc.why };
    }
    const points = await p.fetch(loc);
    if (!points.length) return { ok: false, provider: name, why: 'the provider returned no forecast points' };
    const issuedAt = Math.floor(nowMs / 60000) * 60000;
    const stored = storeSnapshot(name, issuedAt, points);
    return { ok: true, provider: name, issuedAt, stored };
  } catch (e) {
    return { ok: false, provider: name, why: e.message };
  }
}

/** Standing forecast points across a window. */
function standingBetween(fromMs, toMs, nowMs = Date.now()) {
  const name = providerName();
  if (!name) return { provider: null, points: [] };
  // The same rule as pickStanding, done in SQL so a yearly view returns one row
  // per hour rather than every snapshot ever taken (~1,700 rows a day). The
  // result still passes through pickStanding, which is the rule under test.
  const rows = _db().all(
    `SELECT f.issued_at, f.valid_at, f.temperature_c, f.humidity_pct, f.pressure_hpa, f.precip_mm, f.precip_prob
       FROM weather_forecast_points f
       JOIN (SELECT valid_at, MAX(issued_at) AS mi FROM weather_forecast_points
              WHERE provider = ? AND valid_at >= ? AND valid_at <= ?
                AND (issued_at <= valid_at OR valid_at > ?)
              GROUP BY valid_at) m
         ON f.valid_at = m.valid_at AND f.issued_at = m.mi
      WHERE f.provider = ?`,
    [name, fromMs - HOUR, toMs + HOUR, nowMs, name]
  );
  return { provider: name, label: PROVIDERS[name].label, points: pickStanding(rows, nowMs), lastIssuedAt: lastIssued(name) };
}

module.exports = {
  PROVIDERS, HOUR, SNAPSHOT_MIN_GAP_MS,
  shapeOpenMeteo, shapeHomeAssistant, pickStanding, alignToBuckets,
  providerName, snapshot, standingBetween, storeSnapshot,
};
