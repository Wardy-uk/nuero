'use strict';

/**
 * weather-station — the outdoor weather station's minute-by-minute readings.
 *
 * ESP32-C3/BME280 → ESP-NOW → ESP32 receiver → USB on pi5 → `saim-weather-ingest`
 * (journals every accepted record, then forwards it here with retries from an
 * on-disk spool). This file owns the wire contract, the idempotency rule, and
 * the time-bucketed reads the Weather screen charts.
 *
 * Two halves, the `environment.js` split:
 *   • VALIDATION, BOOT ASSIGNMENT and BUCKET PLANNING are pure — no DB, no clock —
 *     so the contract pins without a database.
 *   • Storage and reads live at the bottom and require the DB lazily.
 *
 * ⚠ IDEMPOTENCY. The obvious key is (node_id, sequence) and it is wrong on the
 * first evening: the transmitter restarts its sequence at 1 on every reboot, so
 * the pair repeats. Two facts tell a retry from a reboot:
 *   • a RETRY carries the same sequence AND the same received_at (the Pi stamps
 *     it once, then the spool resends the identical payload) — so the same node +
 *     sequence within DUPLICATE_WINDOW_MS of a stored row is that row again;
 *   • a REBOOT is a NEWER reading whose sequence is at or below the last one seen
 *     — it opens the next `boot`, and (node_id, boot, sequence) is UNIQUE.
 */

const SCHEMA = 'saim.weather.v1';

// The Pi applies the same bounds before it forwards; restated here because a
// future forwarder must not be trusted to have.
const BOUNDS = { temp: [-80, 80], humidity: [0, 100], pressure: [800, 1200], battery: [0, 10000], rssi: [-150, 0] };

// ±5 min. The node reports once a minute, so the same sequence twice inside five
// minutes is only possible as a resend — a reboot cannot climb back to the same
// number that fast.
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

// A reading stamped further ahead than this is a broken clock on the Pi, not
// weather from the future.
const FUTURE_SKEW_MS = 5 * 60 * 1000;

// Once a minute; three missed minutes is a stale feed, not a slow one.
const STALE_AFTER_MS = 5 * 60 * 1000;

const MAX_BATCH = 500;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate one `saim.weather.v1` record. PURE.
 * @returns {{ok:true, obs:object} | {ok:false, reason:string}}
 */
function validateObservation(raw, nowMs) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'record must be an object' };
  if (raw.schema !== SCHEMA) return { ok: false, reason: `schema must be ${SCHEMA}` };
  const node = typeof raw.node_id === 'string' ? raw.node_id.trim() : '';
  if (!node || node.length > 64 || !/^[A-Za-z0-9._:-]+$/.test(node)) return { ok: false, reason: 'node_id must be a short identifier' };
  if (!Number.isInteger(raw.sequence) || raw.sequence < 0) return { ok: false, reason: 'sequence must be a non-negative integer' };

  for (const [k, b] of [['temperature_c', BOUNDS.temp], ['humidity_pct', BOUNDS.humidity], ['pressure_hpa', BOUNDS.pressure]]) {
    if (!isNum(raw[k])) return { ok: false, reason: `${k} must be a finite number` };
    if (raw[k] < b[0] || raw[k] > b[1]) return { ok: false, reason: `${k} outside ${b[0]}–${b[1]}` };
  }
  // Absent and out of range are different facts: no battery is not a fault.
  if (raw.battery_mv != null && (!Number.isInteger(raw.battery_mv) || raw.battery_mv < BOUNDS.battery[0] || raw.battery_mv > BOUNDS.battery[1])) {
    return { ok: false, reason: 'battery_mv must be an integer millivolt reading or null' };
  }
  if (raw.rssi != null && (!Number.isInteger(raw.rssi) || raw.rssi < BOUNDS.rssi[0] || raw.rssi > BOUNDS.rssi[1])) {
    return { ok: false, reason: 'rssi must be an integer dBm or null' };
  }

  // ⚠ received_at must say it is UTC. A naive timestamp would be read in the
  // server's zone, and the Pi may not run in the same one as whoever reads this.
  if (typeof raw.received_at !== 'string' || !/(Z|[+-]\d{2}:?\d{2})$/.test(raw.received_at)) {
    return { ok: false, reason: 'received_at must be an ISO timestamp with a zone' };
  }
  const t = Date.parse(raw.received_at);
  if (!Number.isFinite(t)) return { ok: false, reason: 'received_at is not a valid timestamp' };
  if (isNum(nowMs) && t > nowMs + FUTURE_SKEW_MS) return { ok: false, reason: 'received_at is in the future' };

  return {
    ok: true,
    obs: {
      nodeId: node,
      sequence: raw.sequence,
      observedAt: t,
      temperatureC: raw.temperature_c,
      humidityPct: raw.humidity_pct,
      pressureHpa: raw.pressure_hpa,
      batteryMv: raw.battery_mv ?? null,
      rssi: raw.rssi ?? null,
      schema: SCHEMA,
    },
  };
}

/**
 * Which boot does a NEW (non-duplicate) reading belong to? PURE.
 *
 * `node` is the stored cursor `{boot, lastSequence, lastObservedAt}` or null.
 * `earlier` is the stored row immediately BEFORE this reading in time, used only
 * for a reading that arrives out of order (older than the cursor).
 */
function assignBoot(node, obs, earlier = null) {
  if (!node) return { boot: 1, advancesCursor: true };
  if (obs.observedAt >= node.lastObservedAt) {
    // Newer reading. A sequence that did not climb means the node restarted.
    const restarted = node.lastSequence != null && obs.sequence <= node.lastSequence;
    return { boot: restarted ? node.boot + 1 : node.boot, advancesCursor: true, restarted };
  }
  // Older than the cursor — a spool draining late. It belongs with whichever
  // boot was running just before it, unless that boot had already passed this
  // sequence (then it was a boot of its own; give it the earlier row's boot
  // anyway and let the UNIQUE index refuse a genuine collision rather than guess).
  return { boot: earlier ? earlier.boot : node.boot, advancesCursor: false };
}

// ── Time ranges ──────────────────────────────────────────────────────────────
//
// "Hourly" is raw minutes. Longer ranges read AVERAGES over buckets sized so a
// chart lands between ~100 and ~370 points. The minute rows are never thinned.
// `aheadMs` is how far past now the window runs — forecast only, local is null.
const HOUR = 3600 * 1000;
const RANGES = Object.freeze({
  hour:  { label: 'Hourly',  spanMs: HOUR,            bucketMs: 60 * 1000,      aheadMs: 0 },
  day:   { label: 'Daily',   spanMs: 24 * HOUR,       bucketMs: 5 * 60 * 1000,  aheadMs: 12 * HOUR },
  week:  { label: 'Weekly',  spanMs: 7 * 24 * HOUR,   bucketMs: 30 * 60 * 1000, aheadMs: 0 },
  month: { label: 'Monthly', spanMs: 30 * 24 * HOUR,  bucketMs: 3 * HOUR,       aheadMs: 0 },
  year:  { label: 'Yearly',  spanMs: 365 * 24 * HOUR, bucketMs: 24 * HOUR,      aheadMs: 0 },
});

/**
 * The buckets for a range ending at `nowMs`. PURE. Buckets are aligned to the
 * bucket size on the epoch, so two requests a minute apart agree on edges.
 * ⚠ Day buckets are UTC days. For a yearly view that moves a midnight by an hour
 * in summer, which is invisible at that scale and not worth a zone-aware grid.
 */
function bucketPlan(range, nowMs) {
  const r = RANGES[range];
  if (!r) return null;
  const end = Math.ceil((nowMs + r.aheadMs) / r.bucketMs) * r.bucketMs;
  const start = Math.floor((nowMs - r.spanMs) / r.bucketMs) * r.bucketMs;
  const starts = [];
  for (let t = start; t < end; t += r.bucketMs) starts.push(t);
  return { range, label: r.label, bucketMs: r.bucketMs, fromMs: start, toMs: end, nowMs, starts };
}

const round = (v, dp) => (isNum(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null);

// ── Storage ──────────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }

function _node(db, nodeId) {
  const r = db.get('SELECT boot, last_sequence, last_observed_at FROM weather_nodes WHERE node_id = ?', [nodeId]);
  return r ? { boot: r.boot, lastSequence: r.last_sequence, lastObservedAt: r.last_observed_at } : null;
}

/**
 * Store a batch. Each record gets its own outcome so the forwarder knows which
 * spool rows to drop: `stored` and `duplicate` are both DONE; `rejected` is a
 * permanent no (resending will not help); `conflict` is a collision the boot
 * rule could not resolve — kept by the forwarder for a human, logged here.
 *
 * ⚠ SYNCHRONOUS from the cursor read to the cursor write. better-sqlite3 is
 * synchronous and this is one Node process, so two batches cannot interleave
 * between "which boot is this" and "remember it" (`mobile-sync`'s rule).
 */
function ingest(records, { source = null, nowMs = Date.now() } = {}) {
  if (!Array.isArray(records)) return { ok: false, reason: 'observations must be an array' };
  if (records.length > MAX_BATCH) return { ok: false, reason: `too many observations — max ${MAX_BATCH} per request` };
  const db = _db();
  const results = [];
  const counts = { stored: 0, duplicate: 0, rejected: 0, conflict: 0 };
  const src = typeof source === 'string' ? source.slice(0, 64) : null;

  db.batchSaves(() => {
    for (const raw of records) {
      const v = validateObservation(raw, nowMs);
      const ref = raw && typeof raw === 'object' ? { node_id: raw.node_id ?? null, sequence: raw.sequence ?? null } : {};
      if (!v.ok) { counts.rejected++; results.push({ ...ref, outcome: 'rejected', reason: v.reason }); continue; }
      const o = v.obs;

      const dup = db.get(
        `SELECT id FROM weather_observations
          WHERE node_id = ? AND sequence = ? AND observed_at BETWEEN ? AND ? LIMIT 1`,
        [o.nodeId, o.sequence, o.observedAt - DUPLICATE_WINDOW_MS, o.observedAt + DUPLICATE_WINDOW_MS]
      );
      if (dup) { counts.duplicate++; results.push({ ...ref, outcome: 'duplicate', id: dup.id }); continue; }

      const node = _node(db, o.nodeId);
      const earlier = node && o.observedAt < node.lastObservedAt
        ? db.get('SELECT boot FROM weather_observations WHERE node_id = ? AND observed_at < ? ORDER BY observed_at DESC LIMIT 1', [o.nodeId, o.observedAt])
        : null;
      const b = assignBoot(node, o, earlier);

      const info = db.run(
        `INSERT OR IGNORE INTO weather_observations
           (node_id, boot, sequence, observed_at, temperature_c, humidity_pct, pressure_hpa,
            battery_mv, rssi, schema_version, source, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [o.nodeId, b.boot, o.sequence, o.observedAt, o.temperatureC, o.humidityPct, o.pressureHpa,
          o.batteryMv, o.rssi, o.schema, src, nowMs]
      );
      if (!info.changes) {
        counts.conflict++;
        console.warn(`[Weather] ${o.nodeId} seq ${o.sequence} at ${new Date(o.observedAt).toISOString()} collides with boot ${b.boot} — not stored`);
        results.push({ ...ref, outcome: 'conflict', reason: 'sequence already used in this boot' });
        continue;
      }
      if (b.advancesCursor) {
        db.run(
          `INSERT INTO weather_nodes (node_id, boot, last_sequence, last_observed_at, first_seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(node_id) DO UPDATE SET boot = excluded.boot, last_sequence = excluded.last_sequence,
             last_observed_at = excluded.last_observed_at, updated_at = excluded.updated_at`,
          [o.nodeId, b.boot, o.sequence, o.observedAt, nowMs, nowMs]
        );
        if (b.restarted) console.log(`[Weather] ${o.nodeId} restarted — sequence ${o.sequence} opens boot ${b.boot}`);
      }
      counts.stored++;
      results.push({ ...ref, outcome: 'stored', id: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null, boot: b.boot });
    }
  });
  return { ok: true, received: records.length, ...counts, results };
}

/** Every node that has reported, newest first. */
function nodes() {
  return _db().all('SELECT node_id, boot, last_sequence, last_observed_at, first_seen_at FROM weather_nodes ORDER BY last_observed_at DESC', [])
    .map((r) => ({ nodeId: r.node_id, boot: r.boot, lastSequence: r.last_sequence, lastObservedAt: r.last_observed_at, firstSeenAt: r.first_seen_at }));
}

/** The node to show when none is named: the one that reported most recently. */
function defaultNode() {
  const n = nodes();
  return n.length ? n[0].nodeId : null;
}

function latest(nodeId, nowMs = Date.now()) {
  if (!nodeId) return null;
  const r = _db().get(
    `SELECT observed_at, temperature_c, humidity_pct, pressure_hpa, battery_mv, rssi, sequence, boot
       FROM weather_observations WHERE node_id = ? ORDER BY observed_at DESC LIMIT 1`, [nodeId]);
  if (!r) return null;
  const ageMs = nowMs - r.observed_at;
  return {
    observedAt: r.observed_at,
    temperatureC: r.temperature_c,
    humidityPct: r.humidity_pct,
    pressureHpa: r.pressure_hpa,
    batteryMv: r.battery_mv,
    rssi: r.rssi,
    sequence: r.sequence,
    boot: r.boot,
    ageMs,
    stale: ageMs > STALE_AFTER_MS,
  };
}

/**
 * Bucketed averages over a plan. Done in SQL on the (node_id, observed_at)
 * index rather than by reading a year of minutes into JS.
 * Returns one entry per bucket start; a bucket with no reading is null-valued,
 * never zero — the chart breaks its line there.
 */
function buckets(nodeId, plan) {
  const out = new Map();
  if (nodeId) {
    const rows = _db().all(
      `SELECT CAST((observed_at - ?) / ? AS INTEGER) AS b, COUNT(*) AS n,
              AVG(temperature_c) AS t, AVG(humidity_pct) AS h, AVG(pressure_hpa) AS p,
              MIN(temperature_c) AS tmin, MAX(temperature_c) AS tmax
         FROM weather_observations
        WHERE node_id = ? AND observed_at >= ? AND observed_at < ?
        GROUP BY b`,
      [plan.fromMs, plan.bucketMs, nodeId, plan.fromMs, Math.min(plan.toMs, plan.nowMs + 1)]
    );
    // ⚠ CAST, not bare `/`: better-sqlite3 binds JS numbers as REAL, so the
    //   division is floating-point and no bucket index would match a start.
    for (const r of rows) out.set(plan.fromMs + r.b * plan.bucketMs, r);
  }
  return plan.starts.map((t) => {
    const r = out.get(t);
    return {
      t,
      n: r ? r.n : 0,
      temperatureC: r ? round(r.t, 2) : null,
      humidityPct: r ? round(r.h, 1) : null,
      pressureHpa: r ? round(r.p, 2) : null,
      temperatureMinC: r ? round(r.tmin, 2) : null,
      temperatureMaxC: r ? round(r.tmax, 2) : null,
    };
  });
}

/** Raw minutes in a window, oldest first — what the trend logic reads. */
function recent(nodeId, fromMs, toMs) {
  if (!nodeId) return [];
  return _db().all(
    `SELECT observed_at AS t, temperature_c AS temperatureC, humidity_pct AS humidityPct, pressure_hpa AS pressureHpa
       FROM weather_observations WHERE node_id = ? AND observed_at >= ? AND observed_at <= ? ORDER BY observed_at`,
    [nodeId, fromMs, toMs]
  );
}

function count(nodeId) {
  if (!nodeId) return 0;
  const r = _db().get('SELECT COUNT(*) AS n, MIN(observed_at) AS first FROM weather_observations WHERE node_id = ?', [nodeId]);
  return r ? { n: r.n, firstObservedAt: r.first } : { n: 0, firstObservedAt: null };
}

module.exports = {
  SCHEMA, BOUNDS, DUPLICATE_WINDOW_MS, STALE_AFTER_MS, MAX_BATCH, RANGES,
  validateObservation, assignBoot, bucketPlan,
  ingest, nodes, defaultNode, latest, buckets, recent, count,
};
