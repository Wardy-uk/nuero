'use strict';

/**
 * energy — home energy: Bright supplies the readings, NEURO owns the history,
 * the costs, the intelligence and what every surface shows.
 *
 *   energy-glowmarkt.js  the API adapter (auth, discovery, readings, tariffs)
 *   energy-model.js      PURE: London days/DST, units, tariffs, rollups, fits
 *   energy-weather.js    outdoor daily means from the existing weather stores
 *   energy.js            THIS: storage, sync, backfill, read model, alert pass
 *
 * Three refusals carry the design:
 *  • a slot Bright has no reading for is stored NULL and is MISSING, never 0;
 *  • a day is costed only from a tariff NEURO holds — never an invented rate —
 *    and every £ figure is labelled ESTIMATED (Bright's own cost series is kept
 *    beside it as a cross-check, and a disagreement is shown, never averaged);
 *  • "Bright answered" is not "Bright's history is complete": the backfill
 *    re-checks the first available reading and revisits gaps.
 */

const glow = require('./energy-glowmarkt');
const model = require('./energy-model');

const SLOT_S = model.SLOT_S;
const FUELS = ['electricity', 'gas'];
const HEALTH = { electricity: 'energy.bright-electricity', gas: 'energy.bright-gas' };
const K_SETTINGS = 'energy_settings';
const K_ALERTS = 'energy_alerts_sent';

const BACKFILL_CHUNK_DAYS = 9;          // inside PT30M's 10-day limit
const RECHECK_WINDOW_S = 3 * 86400;     // re-read the last 3 days every pass: DCC data arrives late and gets revised
const CATCHUP_EVERY_MS = 30 * 60 * 1000;
const FIRST_TIME_RECHECK_MS = 24 * 3600 * 1000;
const GAP_MAX_TRIES = 10;
// How far behind "now" each fuel's newest reading usually is. A starting
// assumption, stated on screen as such, and measured against once live.
const USUAL_LAG_H = { electricity: 26, gas: 50 };

function _db() { return require('../db/database'); }
function _json(k, fb) { try { const v = _db().getState(k); return v ? JSON.parse(v) : fb; } catch { return fb; } }
function _setJson(k, v) { _db().setState(k, JSON.stringify(v)); }

function settings() { return _json(K_SETTINGS, {}) || {}; }

// ── Resources ────────────────────────────────────────────────────────────────

function resources({ fuel, kind } = {}) {
  const rows = _db().all('SELECT * FROM energy_resources WHERE active = 1 ORDER BY fuel, kind, resource_id');
  return rows.filter((r) => (!fuel || r.fuel === fuel) && (!kind || r.kind === kind));
}

function saveResources(list, nowMs = Date.now()) {
  const db = _db();
  db.batchSaves(() => {
    for (const r of list) {
      db.run(`INSERT INTO energy_resources (resource_id, ve_id, fuel, kind, classifier, name, base_unit, active, discovered_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(resource_id) DO UPDATE SET ve_id=excluded.ve_id, fuel=excluded.fuel, kind=excluded.kind, classifier=excluded.classifier,
                name=excluded.name, base_unit=excluded.base_unit, active=excluded.active, updated_at=excluded.updated_at`,
      [r.resourceId, r.veId || null, r.fuel, r.kind, r.classifier, r.name || null, r.baseUnit || null, r.active === false ? 0 : 1, nowMs, nowMs]);
    }
  });
}

// ── Readings store ───────────────────────────────────────────────────────────

/**
 * Store half-hour rows for one resource. Outcomes per row:
 *   stored  — new slot (with a value)       missing — new slot, Bright had nothing
 *   filled  — a NULL slot now has a value   duplicate — same as held
 *   revised — a held value changed (previous_value keeps the old one)
 *   kept    — Bright now says nothing for a slot we hold a value for: we keep
 *             ours (Bright going quiet is not evidence the reading was wrong)
 */
function storeReadings(resource, rows, { unit = null, nowMs = Date.now() } = {}) {
  const db = _db();
  const out = { stored: 0, missing: 0, filled: 0, duplicate: 0, revised: 0, kept: 0, newestValueTs: null };
  const u = unit || resource.base_unit || null;
  const s = settings();
  db.batchSaves(() => {
    for (const r of rows) {
      if (!Number.isInteger(r.startTs) || r.startTs % SLOT_S !== 0) continue;
      const v = r.value;
      const kwh = resource.kind === 'consumption' ? model.toKwh(v, u, { gasCalorificValue: s.gasCalorificValue }).kwh : null;
      const pence = resource.kind === 'cost' && v != null ? v : null;
      const held = db.get('SELECT value FROM energy_readings WHERE resource_id = ? AND period_s = ? AND start_ts = ?', [resource.resource_id, SLOT_S, r.startTs]);
      if (v != null && (out.newestValueTs == null || r.startTs > out.newestValueTs)) out.newestValueTs = r.startTs;
      if (!held) {
        db.run(`INSERT INTO energy_readings (resource_id, period_s, start_ts, value, unit, kwh, pence, received_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`, [resource.resource_id, SLOT_S, r.startTs, v, u, kwh, pence, nowMs, nowMs]);
        out[v == null ? 'missing' : 'stored'] += 1;
      } else if (held.value == null && v == null) {
        out.duplicate += 1;
      } else if (held.value == null) {
        db.run('UPDATE energy_readings SET value=?, unit=?, kwh=?, pence=?, updated_at=? WHERE resource_id=? AND period_s=? AND start_ts=?',
          [v, u, kwh, pence, nowMs, resource.resource_id, SLOT_S, r.startTs]);
        out.filled += 1;
      } else if (v == null) {
        out.kept += 1;
      } else if (Math.abs(held.value - v) > 1e-9) {
        db.run(`UPDATE energy_readings SET value=?, unit=?, kwh=?, pence=?, updated_at=?, revision=revision+1, previous_value=?
                WHERE resource_id=? AND period_s=? AND start_ts=?`, [v, u, kwh, pence, nowMs, held.value, resource.resource_id, SLOT_S, r.startTs]);
        out.revised += 1;
      } else {
        out.duplicate += 1;
      }
    }
  });
  return out;
}

/** Recompute kWh for held consumption slots (after a calorific value is set). */
function renormalise() {
  const s = settings();
  const db = _db();
  let n = 0;
  db.batchSaves(() => {
    for (const r of db.all(`SELECT r.resource_id, r.start_ts, r.value, r.unit FROM energy_readings r
        JOIN energy_resources e ON e.resource_id = r.resource_id WHERE e.kind = 'consumption' AND r.value IS NOT NULL`)) {
      const kwh = model.toKwh(r.value, r.unit, { gasCalorificValue: s.gasCalorificValue }).kwh;
      db.run('UPDATE energy_readings SET kwh = ? WHERE resource_id = ? AND period_s = ? AND start_ts = ?', [kwh, r.resource_id, SLOT_S, r.start_ts]);
      n += 1;
    }
  });
  return n;
}

// ── Sync state ───────────────────────────────────────────────────────────────

function syncState(resourceId) {
  const r = _db().get('SELECT * FROM energy_sync WHERE resource_id = ?', [resourceId]);
  if (!r) return { resourceId, backfill: null, consecutiveFailures: 0 };
  return {
    resourceId, lastAttemptAt: r.last_attempt_at, lastSuccessAt: r.last_success_at, lastFailureAt: r.last_failure_at,
    lastError: r.last_error, consecutiveFailures: r.consecutive_failures, retryAfter: r.retry_after,
    newestValueTs: r.newest_value_ts, lastCatchupAt: r.last_catchup_at,
    backfill: r.backfill_state ? JSON.parse(r.backfill_state) : null,
  };
}

function _ensureSync(id) { _db().run('INSERT OR IGNORE INTO energy_sync (resource_id) VALUES (?)', [id]); }

function _ok(id, nowMs, newestValueTs) {
  _ensureSync(id);
  _db().run(`UPDATE energy_sync SET last_attempt_at=?, last_success_at=?, consecutive_failures=0, retry_after=NULL, last_error=NULL,
     newest_value_ts = MAX(COALESCE(newest_value_ts,0), COALESCE(?,0)) WHERE resource_id=?`, [nowMs, nowMs, newestValueTs, id]);
}

function _fail(id, nowMs, err) {
  _ensureSync(id);
  const cur = syncState(id);
  const n = (cur.consecutiveFailures || 0) + 1;
  const backoff = Math.min(5 * 60 * 1000 * 2 ** (n - 1), 6 * 3600 * 1000);
  _db().run('UPDATE energy_sync SET last_attempt_at=?, last_failure_at=?, last_error=?, consecutive_failures=?, retry_after=? WHERE resource_id=?',
    [nowMs, nowMs, String((err && err.message) || err).slice(0, 300), n, nowMs + backoff, id]);
}

function _setBackfill(id, state) {
  _ensureSync(id);
  _db().run('UPDATE energy_sync SET backfill_state = ? WHERE resource_id = ?', [JSON.stringify(state), id]);
}

const _floorSlot = (sec) => Math.floor(sec / SLOT_S) * SLOT_S;

// ── Discovery ────────────────────────────────────────────────────────────────

async function discover(opts = {}) {
  const r = await glow.discover(opts);
  saveResources(r.resources, opts.nowMs);
  return { ok: true, resources: r.resources.length, fuels: [...new Set(r.resources.map((x) => x.fuel))], ignored: r.ignored };
}

async function _ensureResources(opts) {
  if (resources().length) return;
  await discover(opts);
}

// ── Incremental sync ─────────────────────────────────────────────────────────

/**
 * Re-read the recent window for every resource: from three days before the
 * newest held reading (DCC data is late and gets revised) to now. Ask Bright
 * to catch up from the DCC at most every half hour. Each fuel is its own
 * source-health run, so a gas failure never marks electricity down.
 */
async function syncRecent(opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const blocked = glow.blockedReason(opts.env);
  if (blocked) return { ok: false, blocked: true, reason: blocked };
  await _ensureResources(opts);
  const out = {};
  for (const fuel of FUELS) {
    const list = resources({ fuel });
    if (!list.length) { out[fuel] = { ok: true, skipped: 'no meter' }; continue; }
    const run = require('./source-health').beginSourceRun(HEALTH[fuel], {
      system: 'glowmarkt', expectedIntervalMs: 30 * 60 * 1000, staleAfterMs: 6 * 3600 * 1000,
    });
    const stats = { stored: 0, missing: 0, filled: 0, revised: 0, duplicate: 0, kept: 0 };
    let failed = null;
    for (const res of list) {
      const st = syncState(res.resource_id);
      if (!opts.force && st.retryAfter && st.retryAfter > nowMs) continue;
      try {
        if (res.kind === 'consumption' && (!st.lastCatchupAt || nowMs - st.lastCatchupAt >= CATCHUP_EVERY_MS)) {
          try { await glow.catchup(res.resource_id, opts); } catch (e) { console.warn(`[Energy] catchup ${fuel} failed: ${e.message}`); }
          _ensureSync(res.resource_id);
          _db().run('UPDATE energy_sync SET last_catchup_at = ? WHERE resource_id = ?', [nowMs, res.resource_id]);
        }
        const nowS = _floorSlot(Math.floor(nowMs / 1000));
        const anchor = st.newestValueTs ? st.newestValueTs : nowS - 2 * 86400;
        let from = _floorSlot(Math.max(anchor - RECHECK_WINDOW_S, nowS - 30 * 86400));
        let newest = null;
        while (from < nowS) {
          const to = Math.min(from + BACKFILL_CHUNK_DAYS * 86400, nowS + SLOT_S);
          const r = await glow.readings(res.resource_id, from * 1000, to * 1000, opts);
          const s = storeReadings(res, r.rows, { unit: r.units, nowMs });
          for (const k of Object.keys(stats)) stats[k] += s[k] || 0;
          if (s.newestValueTs && (!newest || s.newestValueTs > newest)) newest = s.newestValueTs;
          from = to;
        }
        _ok(res.resource_id, nowMs, newest);
      } catch (e) {
        _fail(res.resource_id, nowMs, e);
        if (res.kind === 'consumption') failed = e;
        console.warn(`[Energy] ${fuel} ${res.kind} sync failed: ${e.message}`);
      }
    }
    // An all-NULL answer is NOT a failure: Bright's DCC data is delayed by design.
    if (failed) run.fail(failed, { reason: failed.code === 'auth' ? 'auth' : failed.status ? `http-${failed.status}` : failed.code || 'network' });
    else run.succeed(stats);
    out[fuel] = { ok: !failed, ...stats, error: failed ? failed.message : undefined };
  }
  return { ok: Object.values(out).every((x) => x.ok), ...out };
}

// ── Backfill ─────────────────────────────────────────────────────────────────

/**
 * One step of the historical walk, per resource: newest-first, nine days per
 * call, cursor persisted after every chunk. When the cursor reaches the first
 * available reading it does NOT declare the history finished for good: once a
 * day it asks Bright for the first reading again — Bright is still populating
 * from the DCC — and walks further back if it moved.
 */
async function backfillStep(opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const maxChunks = opts.maxChunks || 6;
  const blocked = glow.blockedReason(opts.env);
  if (blocked) return { ok: false, blocked: true, reason: blocked };
  await _ensureResources(opts);
  const out = {};
  for (const res of resources()) {
    const id = res.resource_id;
    const st = syncState(id);
    let bf = st.backfill || { cursor: null, floor: null, floorSource: null, chunks: 0, rows: 0, complete: false, firstCheckedAt: null };
    try {
      if (!bf.firstCheckedAt || nowMs - bf.firstCheckedAt >= FIRST_TIME_RECHECK_MS || bf.floor == null) {
        let first = null;
        try { first = await glow.firstTime(id, opts); } catch (e) { if (e.code !== 'not-found') throw e; }
        const floor = first ? _floorSlot(first) : _floorSlot(Math.floor(nowMs / 1000) - 400 * 86400);
        if (bf.floor != null && floor < bf.floor) bf.complete = false; // Bright found older history
        bf = { ...bf, floor, floorSource: first ? 'bright-first-time' : 'assumed-400-days', firstCheckedAt: nowMs };
        _db().run('UPDATE energy_resources SET first_ts = ? WHERE resource_id = ?', [first, id]);
      }
      if (bf.cursor == null) bf.cursor = _floorSlot(Math.floor(nowMs / 1000) - RECHECK_WINDOW_S);
      let chunks = 0;
      while (!bf.complete && chunks < maxChunks) {
        if (bf.cursor <= bf.floor) { bf.complete = true; bf.completedAt = nowMs; break; }
        const from = Math.max(bf.floor, bf.cursor - BACKFILL_CHUNK_DAYS * 86400);
        const r = await glow.readings(id, from * 1000, bf.cursor * 1000, opts);
        const s = storeReadings(res, r.rows, { unit: r.units, nowMs });
        bf.rows += (s.stored || 0) + (s.filled || 0);
        bf.chunks += 1;
        bf.cursor = from;
        bf.lastChunkAt = nowMs;
        bf.lastError = null;
        chunks += 1;
        _setBackfill(id, bf); // checkpoint after EVERY chunk
        if (opts.sleep) await opts.sleep(1000);
        else await new Promise((rs) => setTimeout(rs, 1000));
      }
      _setBackfill(id, bf);
      out[`${res.fuel}-${res.kind}`] = { cursor: bf.cursor, floor: bf.floor, complete: bf.complete, rows: bf.rows };
    } catch (e) {
      bf.lastError = e.message;
      _setBackfill(id, bf);
      out[`${res.fuel}-${res.kind}`] = { error: e.message };
      console.warn(`[Energy] backfill ${res.fuel} ${res.kind} failed: ${e.message}`);
    }
  }
  return { ok: true, ...out };
}

/**
 * Revisit held slots that are still NULL and older than two days (Bright may
 * have them now). One request per gap day, at most `maxDays` a pass, each day
 * tried at most GAP_MAX_TRIES times — then reported as a persistent gap.
 */
async function revisitGaps(opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const maxDays = opts.maxDays || 10;
  if (glow.blockedReason(opts.env)) return { ok: false, blocked: true };
  const cutoff = Math.floor(nowMs / 1000) - 2 * 86400;
  const out = { revisited: 0, filled: 0, persistent: 0 };
  for (const res of resources({ kind: 'consumption' })) {
    const st = syncState(res.resource_id);
    const bf = st.backfill || {};
    const tries = bf.gapTries || {};
    const rows = _db().all(`SELECT start_ts FROM energy_readings WHERE resource_id = ? AND period_s = ? AND value IS NULL AND start_ts < ? ORDER BY start_ts DESC LIMIT 2000`,
      [res.resource_id, SLOT_S, cutoff]);
    const days = [...new Set(rows.map((r) => model.londonDay(r.start_ts * 1000)))];
    let done = 0;
    for (const day of days) {
      if (done >= maxDays) break;
      const t = tries[day] || { n: 0, at: 0 };
      if (t.n >= GAP_MAX_TRIES) { out.persistent += 1; continue; }
      if (nowMs - t.at < 20 * 3600 * 1000) continue;
      try {
        const a = model.londonMidnightMs(day);
        const b = model.londonMidnightMs(model.addDays(day, 1));
        const r = await glow.readings(res.resource_id, a, b, opts);
        const s = storeReadings(res, r.rows, { unit: r.units, nowMs });
        out.filled += s.filled;
      } catch (e) { console.warn(`[Energy] gap revisit ${day} failed: ${e.message}`); }
      tries[day] = { n: t.n + 1, at: nowMs };
      out.revisited += 1;
      done += 1;
    }
    _setBackfill(res.resource_id, { ...bf, gapTries: tries });
  }
  return { ok: true, ...out };
}

// ── Tariffs ──────────────────────────────────────────────────────────────────

function tariffs({ includeRemoved = false } = {}) {
  return _db().all('SELECT * FROM energy_tariffs ORDER BY fuel, effective_from')
    .filter((r) => includeRemoved || !r.removed_at)
    .map((r) => ({
      id: r.id, fuel: r.fuel, source: r.source, effectiveFrom: r.effective_from, unitRateP: r.unit_rate_p,
      standingPDay: r.standing_p_day, flat: !!r.flat, label: r.label, removedAt: r.removed_at,
    }));
}

async function syncTariffs(opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  if (glow.blockedReason(opts.env)) return { ok: false, blocked: true };
  let added = 0; let updated = 0;
  for (const res of resources({ kind: 'cost' })) {
    const list = await glow.tariffList(res.resource_id, opts);
    for (const entry of list) {
      const t = model.parseBrightTariff(entry);
      if (!t) continue;
      const held = _db().get(`SELECT id, unit_rate_p, standing_p_day, flat FROM energy_tariffs WHERE source='meter' AND fuel=? AND provider_id=? AND effective_from=?`,
        [res.fuel, t.providerId, t.effectiveFrom]);
      if (!held) {
        _db().run(`INSERT INTO energy_tariffs (fuel, source, provider_id, effective_from, unit_rate_p, standing_p_day, flat, label, raw_json, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, [res.fuel, 'meter', t.providerId, t.effectiveFrom, t.unitRateP, t.standingPDay, t.flat ? 1 : 0, t.label, JSON.stringify(entry), nowMs]);
        added += 1;
      } else if (held.unit_rate_p !== t.unitRateP || held.standing_p_day !== t.standingPDay || !!held.flat !== t.flat) {
        _db().run('UPDATE energy_tariffs SET unit_rate_p=?, standing_p_day=?, flat=?, label=?, raw_json=? WHERE id=?',
          [t.unitRateP, t.standingPDay, t.flat ? 1 : 0, t.label, JSON.stringify(entry), held.id]);
        updated += 1;
      }
    }
  }
  return { ok: true, added, updated };
}

function addManualTariff(input, nowMs = Date.now()) {
  const v = model.validateManualTariff(input);
  if (!v.ok) return { ok: false, error: v.reason };
  const t = v.tariff;
  const r = _db().run(`INSERT INTO energy_tariffs (fuel, source, effective_from, unit_rate_p, standing_p_day, flat, label, created_at)
    VALUES (?,?,?,?,?,1,?,?)`, [t.fuel, 'manual', t.effectiveFrom, t.unitRateP, t.standingPDay, t.label, nowMs]);
  return { ok: true, id: Number(r.lastInsertRowid) };
}

/** Manual tariffs only; kept with removed_at so the change is visible. */
function removeManualTariff(id, nowMs = Date.now()) {
  const row = _db().get('SELECT source, removed_at FROM energy_tariffs WHERE id = ?', [id]);
  if (!row) return { ok: false, status: 404, error: 'no such tariff' };
  if (row.source !== 'manual') return { ok: false, status: 409, error: 'a meter-reported tariff cannot be removed — add a manual one to override it' };
  if (row.removed_at) return { ok: true, already: true };
  _db().run('UPDATE energy_tariffs SET removed_at = ? WHERE id = ?', [nowMs, id]);
  return { ok: true };
}

function setGasCalorificValue(cv) {
  if (cv === null) { _setJson(K_SETTINGS, { ...settings(), gasCalorificValue: null }); return { ok: true, renormalised: renormalise() }; }
  const n = Number(cv);
  if (!Number.isFinite(n) || n < 30 || n > 45) return { ok: false, error: 'calorific value must be MJ/m³ between 30 and 45 (it is on your gas bill, usually ~39)' };
  _setJson(K_SETTINGS, { ...settings(), gasCalorificValue: n });
  return { ok: true, renormalised: renormalise() };
}

// ── Read model ───────────────────────────────────────────────────────────────

/** Half-hour map (startTs → value) for a fuel/kind, summed across resources. */
function _slots(fuel, kind, fromS, toS) {
  const ids = resources({ fuel, kind }).map((r) => r.resource_id);
  const m = new Map();
  if (!ids.length) return m;
  const col = kind === 'cost' ? 'pence' : 'kwh';
  const rows = _db().all(`SELECT start_ts, ${col} AS v FROM energy_readings WHERE period_s = ? AND start_ts >= ? AND start_ts < ?
     AND resource_id IN (${ids.map(() => '?').join(',')})`, [SLOT_S, fromS, toS, ...ids]);
  for (const r of rows) {
    if (r.v == null) { if (!m.has(r.start_ts)) m.set(r.start_ts, null); continue; }
    m.set(r.start_ts, (m.get(r.start_ts) || 0) + r.v);
  }
  return m;
}

/**
 * One row per London day for a fuel: kWh, completeness, estimated cost (with
 * the tariff it came from), Bright's own cost as a check, and for gas the
 * outdoor temperature and heating degree days.
 */
function daily(fuel, fromDay, toDay) {
  const fromS = model.londonMidnightMs(fromDay) / 1000;
  const toS = model.londonMidnightMs(model.addDays(toDay, 1)) / 1000;
  const slots = _slots(fuel, 'consumption', fromS, toS);
  const costSlots = _slots(fuel, 'cost', fromS, toS);
  const rows = model.rollupDays(slots, fromDay, toDay);
  const brightRows = model.rollupDays(costSlots, fromDay, toDay);
  const tlist = tariffs();
  const temps = fuel === 'gas' ? require('./energy-weather').dailyMeans(fromDay, toDay) : new Map();
  return rows.map((r, i) => {
    const t = model.tariffOn(tlist, fuel, r.day);
    const c = r.present ? model.costOfDay(r.kwh, t) : { pence: null, why: 'no usage for this date' };
    const b = brightRows[i];
    const temp = temps.get(r.day);
    return {
      ...r,
      costP: model.round(c.pence, 1), unitsP: model.round(c.unitsP, 1), standingP: c.standingP ?? null, costWhy: c.why || null,
      tariff: t ? { source: t.source, from: t.effectiveFrom } : null,
      costComplete: r.complete && c.pence != null,
      brightP: b.present ? model.round(b.kwh, 1) : null,
      tMean: temp ? temp.tMean : null, tSource: temp ? temp.source : null,
      hdd: temp ? model.round(model.hdd(temp.tMean), 2) : null,
    };
  });
}

function _today(nowMs) { return model.londonDay(nowMs); }

function _summ(rows) {
  const kwh = model.sum(rows, 'kwh');
  const costP = model.sum(rows, 'costP');
  return {
    kwh: model.round(kwh, 2), costP: model.round(costP, 1),
    days: rows.length, completeDays: rows.filter((r) => r.complete).length,
    costedDays: rows.filter((r) => r.costP != null).length,
  };
}

function _freshness(fuel, newestTs, nowMs) {
  if (!newestTs) return { state: 'none', newestAt: null, ageHours: null, usualLagHours: USUAL_LAG_H[fuel] };
  const end = (newestTs + SLOT_S) * 1000;
  const ageH = Math.round(((nowMs - end) / 3600000) * 10) / 10;
  const lag = USUAL_LAG_H[fuel];
  const state = ageH <= lag ? 'usual' : ageH <= 3 * lag ? 'late' : 'stalled';
  return { state, newestAt: end, ageHours: ageH, usualLagHours: lag };
}

function _backfillSummary(fuel) {
  const res = resources({ fuel, kind: 'consumption' });
  if (!res.length) return null;
  const st = syncState(res[0].resource_id);
  const bf = st.backfill || {};
  const held = _db().get('SELECT MIN(start_ts) AS a, MAX(start_ts) AS b, COUNT(*) AS n, SUM(value IS NULL) AS nulls FROM energy_readings WHERE resource_id = ?', [res[0].resource_id]) || {};
  // Walked share of [floor, newest]: how much of the available history is in.
  const top = st.newestValueTs || bf.cursor;
  const progress = bf.complete ? 100
    : bf.floor != null && bf.cursor != null && top > bf.floor ? Math.round(((top - bf.cursor) / (top - bf.floor)) * 100) : null;
  return {
    complete: !!bf.complete, earliestAvailable: bf.floor ? bf.floor * 1000 : null, floorSource: bf.floorSource || null,
    cursor: bf.cursor ? bf.cursor * 1000 : null, oldestHeld: held.a ? held.a * 1000 : null,
    slotsHeld: held.n || 0, slotsMissing: held.nulls || 0,
    progressPct: progress == null ? null : Math.max(0, Math.min(100, progress)),
    lastError: bf.lastError || null,
  };
}

/** The Energy page: `energy-v1`. Reads write nothing. */
function read({ nowMs = Date.now(), days = 30 } = {}) {
  const today = _today(nowMs);
  const yesterday = model.addDays(today, -1);
  const monthStart = `${today.slice(0, 8)}01`;
  const lastMonthStart = model.addDays(monthStart, -1).slice(0, 8) + '01';
  const lastMonthEnd = model.addDays(monthStart, -1);
  const from = [model.addDays(today, -(days - 1)), lastMonthStart].sort()[0];
  const fuels = {};
  for (const fuel of FUELS) {
    const res = resources({ fuel, kind: 'consumption' });
    if (!res.length) { fuels[fuel] = { present: false }; continue; }
    const rows = daily(fuel, from, today);
    const by = new Map(rows.map((r) => [r.day, r]));
    const st = syncState(res[0].resource_id);
    const sameDayLastMonth = model.addDays(lastMonthStart, Number(today.slice(8)) - 1);
    fuels[fuel] = {
      present: true,
      today: by.get(today) || null,
      yesterday: by.get(yesterday) || null,
      month: _summ(rows.filter((r) => r.day >= monthStart)),
      lastMonthToDate: _summ(rows.filter((r) => r.day >= lastMonthStart && r.day <= sameDayLastMonth && r.day <= lastMonthEnd)),
      lastMonth: _summ(rows.filter((r) => r.day >= lastMonthStart && r.day <= lastMonthEnd)),
      days: rows.filter((r) => r.day > model.addDays(today, -days)),
      freshness: _freshness(fuel, st.newestValueTs, nowMs),
      sync: { lastSuccessAt: st.lastSuccessAt || null, lastError: st.lastError || null, consecutiveFailures: st.consecutiveFailures || 0 },
      backfill: _backfillSummary(fuel),
      tariff: model.tariffOn(tariffs(), fuel, today),
    };
  }
  const both = FUELS.filter((f) => fuels[f].present);
  const combine = (key) => {
    const vals = both.map((f) => fuels[f][key] && fuels[f][key].costP).filter((v) => v != null);
    return vals.length === both.length && vals.length ? model.round(vals.reduce((a, b) => a + b, 0), 1) : null;
  };
  return {
    contract: 'energy-v1',
    today, yesterday,
    connection: glow.authState(),
    fuels,
    household: { monthCostP: combine('month'), lastMonthCostP: combine('lastMonth') },
    labels: {
      cost: 'Estimated from the tariff NEURO holds — not a bill.',
      lag: 'Smart-meter half-hours reach Bright from the DCC with a delay; today is normally partial and gas can be a day or two behind.',
    },
  };
}

/** Half-hours for one fuel and London day. */
function halfHourly(fuel, day) {
  const slots = model.slotsOfDay(day);
  const m = _slots(fuel, 'consumption', slots[0], slots[slots.length - 1] + SLOT_S);
  return slots.map((t) => ({ start: t * 1000, kwh: m.has(t) ? model.round(m.get(t), 3) : null, held: m.has(t) }));
}

/** Analysis: baselines, weather fit, unusual days, trends, missing data. */
function insights({ nowMs = Date.now(), lookbackDays = 365 } = {}) {
  const today = _today(nowMs);
  const from = model.addDays(today, -lookbackDays);
  const out = { contract: 'energy-insights-v1', today, fuels: {} };
  for (const fuel of FUELS) {
    if (!resources({ fuel, kind: 'consumption' }).length) continue;
    const rows = daily(fuel, from, model.addDays(today, -1));
    const complete = rows.filter((r) => r.complete);
    const recent = complete.slice(-28);
    const f = {
      completeDays: complete.length,
      baselineKwhPerDay: model.round(model.median(recent.map((r) => r.kwh)), 2),
      weekly: _weeks(rows).slice(-8),
      missing: _missing(rows.slice(-60)),
      unusual: [],
    };
    if (fuel === 'electricity') {
      const fromS = model.londonMidnightMs(model.addDays(today, -28)) / 1000;
      const slots = _slots(fuel, 'consumption', fromS, model.londonMidnightMs(today) / 1000);
      const kw = model.dayRange(model.addDays(today, -28), model.addDays(today, -1)).map((d) => model.overnightBaseKw(slots, d)).filter((x) => x != null);
      f.alwaysOnKw = model.round(model.median(kw), 3);
      f.alwaysOnNote = 'Median of the four lowest half-hours between midnight and 5am, over the last 28 days.';
      for (const d of complete.slice(-14)) {
        const j = model.judgeElectricityDay(d, complete);
        if (j.unusual) f.unusual.push({ day: d.day, ...j });
      }
    } else {
      const fit = model.fitGasWeather(rows);
      f.weather = fit ? { ...fit, note: 'How gas use has tracked outdoor temperature in this house — a correlation, not a cause.' } : null;
      if (fit) {
        f.normalised = complete.slice(-14).map((d) => {
          const exp = model.expectedGas(fit, d.hdd);
          return { day: d.day, kwh: d.kwh, hdd: d.hdd, expected: model.round(exp, 1), ratio: exp ? model.round(d.kwh / exp, 2) : null };
        });
        for (const d of complete.slice(-14)) {
          const j = model.judgeGasDay(d, fit);
          if (j.unusual) f.unusual.push({ day: d.day, ...j });
        }
        // Efficiency trend: kWh per degree-day, last 90 days vs the 90 before.
        const a = model.fitGasWeather(rows.slice(-90), { minDays: 28 });
        const b = model.fitGasWeather(rows.slice(-180, -90), { minDays: 28 });
        f.efficiency = a && b ? {
          recentKwhPerDegreeDay: a.kwhPerDegreeDay, previousKwhPerDegreeDay: b.kwhPerDegreeDay,
          changePct: b.kwhPerDegreeDay ? Math.round(((a.kwhPerDegreeDay - b.kwhPerDegreeDay) / b.kwhPerDegreeDay) * 100) : null,
          note: 'A change can be the boiler, the thermostat, who is home or the season — this says that it changed, not why.',
        } : null;
      } else {
        f.weather = null;
        f.weatherWhy = `Needs at least 28 complete days with an outdoor temperature (have ${rows.filter((r) => r.complete && r.hdd != null).length}).`;
      }
    }
    out.fuels[fuel] = f;
  }
  return out;
}

function _isoWeekStart(day) {
  const [y, m, d] = day.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
  return model.addDays(day, 1 - dow);
}

function _weeks(rows) {
  const by = new Map();
  for (const r of rows) {
    const w = _isoWeekStart(r.day);
    if (!by.has(w)) by.set(w, []);
    by.get(w).push(r);
  }
  return [...by.entries()].map(([week, rs]) => ({
    week, kwh: model.round(model.sum(rs, 'kwh'), 1), costP: model.round(model.sum(rs, 'costP'), 0),
    complete: rs.length === 7 && rs.every((r) => r.complete),
  }));
}

function _missing(rows) {
  const gaps = rows.filter((r) => !r.complete);
  return { incompleteDays: gaps.length, days: gaps.slice(-10).map((r) => ({ day: r.day, present: r.present, expected: r.expected })) };
}

// ── Other surfaces ───────────────────────────────────────────────────────────

/** VESTA (`energy` scope): coarse, read-only, no half-hours, no tariff detail. */
function householdView({ nowMs = Date.now() } = {}) {
  const r = read({ nowMs, days: 30 });
  const fuels = {};
  for (const fuel of FUELS) {
    const f = r.fuels[fuel];
    if (!f || !f.present) continue;
    fuels[fuel] = {
      yesterday: f.yesterday ? { kwh: f.yesterday.kwh, costP: f.yesterday.costP, complete: f.yesterday.complete } : null,
      month: { kwh: f.month.kwh, costP: f.month.costP },
      days: f.days.map((d) => ({ day: d.day, kwh: d.kwh, complete: d.complete })),
      freshness: { state: f.freshness.state, newestAt: f.freshness.newestAt },
    };
  }
  return {
    connected: r.connection.configured && r.connection.state !== 'rejected',
    fuels, monthCostP: r.household.monthCostP,
    note: 'Costs are estimates, not the bill. Recent days fill in as the meter reports.',
  };
}

/** For chat / MCP: the facts a question about energy needs, with caveats. */
function chatView({ nowMs = Date.now() } = {}) {
  const r = read({ nowMs, days: 62 });
  const i = insights({ nowMs });
  return { ...r, insights: i };
}

/** Compact line for the Home card. */
function homeLine({ nowMs = Date.now() } = {}) {
  const r = read({ nowMs, days: 3 });
  const parts = [];
  for (const fuel of FUELS) {
    const f = r.fuels[fuel];
    if (!f || !f.present || !f.yesterday || f.yesterday.kwh == null) continue;
    parts.push({ fuel, kwh: f.yesterday.kwh, costP: f.yesterday.costP, complete: f.yesterday.complete });
  }
  return { day: r.yesterday, parts, connected: r.connection.configured };
}

// ── Alerts (Nick's call, 17 Oct 2026: push when CLEARLY unusual) ─────────────

/**
 * Judge yesterday and the day before for each fuel; push once per fuel per
 * day. Only a COMPLETE day is ever judged, so a late or partial day can never
 * look "low" or "high" by accident. Nothing is pushed before there is a month
 * of history (the judges refuse without it).
 */
async function alertPass({ nowMs = Date.now(), push } = {}) {
  const send = push || ((t, b, d) => require('./webpush').sendToAll(t, b, d));
  const sent = _json(K_ALERTS, {}) || {};
  const today = _today(nowMs);
  const out = [];
  const ins = insights({ nowMs, lookbackDays: 200 });
  for (const fuel of FUELS) {
    const f = ins.fuels[fuel];
    if (!f) continue;
    for (const u of f.unusual) {
      if (u.day < model.addDays(today, -3)) continue;
      const key = `${fuel}:${u.day}`;
      if (sent[key]) continue;
      const body = `${model.unusualSentence(fuel, u.day, u)} Home → Energy.`;
      try {
        await send(fuel === 'gas' ? 'Gas use was unusually high' : 'Electricity use was unusually high', body, { type: 'energy_unusual', url: '/?view=energy' });
        sent[key] = nowMs;
        out.push({ fuel, day: u.day });
      } catch (e) { console.warn(`[Energy] alert push failed: ${e.message}`); }
    }
  }
  for (const k of Object.keys(sent)) if (sent[k] < nowMs - 45 * 86400 * 1000) delete sent[k];
  _setJson(K_ALERTS, sent);
  return { ok: true, sent: out };
}

module.exports = {
  FUELS, HEALTH, USUAL_LAG_H,
  settings, setGasCalorificValue, resources, saveResources, storeReadings, renormalise, syncState,
  discover, syncRecent, backfillStep, revisitGaps,
  tariffs, syncTariffs, addManualTariff, removeManualTariff,
  daily, halfHourly, read, insights, householdView, chatView, homeLine, alertPass,
};
