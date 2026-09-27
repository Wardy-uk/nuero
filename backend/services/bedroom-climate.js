'use strict';

/**
 * bedroom-climate — the bedroom's temperature, hour by hour, from the radiator
 * valve Home Assistant already has.
 *
 * The weather logger's first months were no use for "does the room affect how I
 * sleep": it was in a freezer, a cool room and briefly somewhere at 5 °C. The
 * radiator valve in the bedroom (`climate.mums_rad`, HA area "Mum's Room" — the
 * room Nick sleeps in) has been there all along, and HA keeps its LONG-TERM
 * STATISTICS — hourly mean/min/max — indefinitely, while its ordinary history is
 * purged after about ten days. Measured 27 Sep 2026: 2,561 hours back to 31 May.
 *
 * So this copies those hourly statistics into NEURO (`room_climate_hourly`) and
 * keeps them topped up. The copy is the point: NEURO's analysis then does not
 * depend on HA being reachable, and nothing is lost if HA's statistics are ever
 * reset.
 *
 * ⚠ THE SENSOR IS ON THE RADIATOR. With the heating on it reads the valve's own
 * warmth, not quite the room's, and it measures no humidity. Every consumer says
 * so rather than presenting it as a room thermometer.
 *
 * ⚠ `sensor.*_current_temperature`, NOT `climate.*`: long-term statistics exist
 * only for entities with a state_class, and the climate entity has none. The two
 * were checked to agree (20.0 vs 20.0) — the old Hive-°F trap noted in
 * ha-rooms.js does not apply to these sensors today, and `unit` is still read
 * and refused if it is not °C.
 */

const ENTITY = process.env.HA_BEDROOM_TEMP_SENSOR || 'sensor.mums_rad_current_temperature';
const LABEL = process.env.HA_BEDROOM_LABEL || 'bedroom';
const SINCE = '2024-01-01T00:00:00Z';

// ── Pure ─────────────────────────────────────────────────────────────────────

/**
 * HA statistics rows → storable hours. PURE. Anything outside 0–40 °C is a unit
 * or a fault, not a bedroom, and is dropped rather than stored.
 */
function shapeStats(rows) {
  return (rows || [])
    .map((r) => ({
      hourStart: Math.floor((typeof r.start === 'number' ? r.start : Date.parse(r.start)) / 1000),
      mean: Number(r.mean),
      min: Number(r.min),
      max: Number(r.max),
    }))
    .filter((h) => Number.isFinite(h.hourStart) && Number.isFinite(h.mean) && h.mean > 0 && h.mean < 40);
}

/** Stored hours → the readings shape performance-insights.overnightRoom reads. */
function asReadings(hours) {
  // Each hourly mean stands at the middle of its hour.
  return (hours || []).map((h) => ({ t: h.hour_start + 1800, temperature_c: h.mean }));
}

// ── Home Assistant ───────────────────────────────────────────────────────────

/** Long-term hourly statistics over HA's websocket (Node 22 has WebSocket). */
function fetchStatistics({ url, token, entity = ENTITY, since = SINCE, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === 'undefined') return reject(new Error('this Node has no WebSocket'));
    const ws = new WebSocket(`${url.replace(/^http/, 'ws').replace(/\/$/, '')}/api/websocket`);
    const timer = setTimeout(() => { try { ws.close(); } catch { /* */ } reject(new Error('HA statistics timed out')); }, timeoutMs);
    const done = (fn, v) => { clearTimeout(timer); try { ws.close(); } catch { /* */ } fn(v); };
    ws.onerror = () => done(reject, new Error('HA websocket error'));
    ws.onmessage = (m) => {
      let d;
      try { d = JSON.parse(m.data); } catch { return; }
      if (d.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      else if (d.type === 'auth_invalid') done(reject, new Error('HA rejected the token'));
      else if (d.type === 'auth_ok') {
        ws.send(JSON.stringify({ id: 1, type: 'recorder/statistics_during_period', start_time: since,
          statistic_ids: [entity], period: 'hour', types: ['mean', 'min', 'max'] }));
      } else if (d.id === 1) {
        if (!d.success) return done(reject, new Error((d.error && d.error.message) || 'statistics refused'));
        done(resolve, (d.result || {})[entity] || []);
      }
    };
  });
}

// ── Storage ──────────────────────────────────────────────────────────────────

/**
 * Pull and store. `days` bounds the request (the hourly job asks for three);
 * omitted, it takes everything HA has. Idempotent — hours are keyed.
 */
async function sync({ days = null } = {}) {
  const url = process.env.HA_URL;
  const token = process.env.HA_TOKEN;
  if (!url || !token) return { ok: false, stored: 0, why: 'Home Assistant is not configured (HA_URL / HA_TOKEN)' };
  const since = days ? new Date(Date.now() - days * 86400000).toISOString() : SINCE;
  const rows = shapeStats(await fetchStatistics({ url, token, since }));
  const db = require('../db/database');
  let stored = 0;
  db.batchSaves(() => {
    for (const h of rows) {
      const info = db.run(
        `INSERT INTO room_climate_hourly (entity_id, hour_start, mean_c, min_c, max_c)
           VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(entity_id, hour_start) DO UPDATE SET mean_c = excluded.mean_c, min_c = excluded.min_c, max_c = excluded.max_c`,
        [ENTITY, h.hourStart, h.mean, h.min, h.max]
      );
      stored += info.changes;
    }
  });
  return { ok: true, stored, hours: rows.length, entity: ENTITY };
}

function hoursSince(unixSeconds) {
  const db = require('../db/database');
  return db.all(
    'SELECT hour_start, mean_c AS mean FROM room_climate_hourly WHERE entity_id = ? AND hour_start >= ? ORDER BY hour_start',
    [ENTITY, unixSeconds]
  );
}

function coverage() {
  const db = require('../db/database');
  const r = db.get('SELECT COUNT(*) AS n, MIN(hour_start) AS first, MAX(hour_start) AS last FROM room_climate_hourly WHERE entity_id = ?', [ENTITY]);
  return {
    entity: ENTITY,
    label: LABEL,
    hours: r ? r.n : 0,
    from: r && r.first ? new Date(r.first * 1000).toISOString() : null,
    to: r && r.last ? new Date(r.last * 1000).toISOString() : null,
  };
}

module.exports = { ENTITY, LABEL, shapeStats, asReadings, fetchStatistics, sync, hoursSince, coverage };
