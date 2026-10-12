'use strict';

/**
 * Car journeys: detected from Home Assistant's Life360 history, approved by
 * Nick, and used ONLY for a running mileage estimate (12 Oct 2026).
 * The rules live in journey-model.js (pure); this file reads HA, stores and
 * decides nothing on Nick's behalf.
 *
 *   sync()     reads HA's recorded history for the Life360 tracker from a
 *              cursor (HA keeps ~10 days, so a Pi outage of a week loses
 *              nothing), stores each FINISHED journey as `pending`. A journey
 *              still going at the edge of the read is left for the next pass.
 *   approve()  Nick says it was the car (miles editable) → counts in the estimate.
 *   reject()   not the car / not a journey → kept, counts for nothing.
 *   reopen()   back to pending — every decision has a way back.
 *
 * ⚠ An approved journey is never written to vehicle_mileage. The odometer stays
 * the only fact about mileage (Build 27); this is an estimate on top of it.
 * ⚠ Tracking starts at the latest odometer reading when first switched on:
 * journeys before it could not change the estimate, so asking about them would
 * be a queue of questions with no answer worth having.
 * ⚠ HA unreadable = the pass FAILS and says so; it is never "no journeys".
 */

const model = require('./journey-model');

const SOURCE = 'life360';
const DEFAULT_ENTITY = 'device_tracker.life360_nick';
const OVERLAP_MS = 30 * 60000;           // re-read a little behind the cursor so a journey's start is never cut
const HA_RETENTION_MS = 9 * 86400000;    // HA keeps ~10 days; never ask for more than it has
const REJECT_REASONS = Object.freeze(['not-the-car', 'not-a-journey']);
const MAX_MILES = 1500;                  // vehicle.js's MAX_MILES_PER_DAY — one journey is not more than a day of driving

const K_SINCE = 'vehicle_journeys_since';
const K_CURSOR = 'vehicle_journeys_cursor';
const K_LAST = 'vehicle_journeys_last_sync';

function _db() { return require('../db/database'); }
function _veh() { return require('./vehicle'); }
function entity() { return process.env.JOURNEY_TRACKER_ENTITY || DEFAULT_ENTITY; }

/** End of the local day containing ms (Europe/London on the Pi). */
function endOfLocalDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
}
function dayNoonMs(day) { const [y, m, d] = String(day).split('-').map(Number); return new Date(y, m - 1, d, 12).getTime(); }

function _num(key) { const v = Number(_db().getState(key)); return Number.isFinite(v) && v > 0 ? v : null; }
function _lastSync() { try { return JSON.parse(_db().getState(K_LAST) || 'null'); } catch { return null; } }

/** The one current vehicle a journey belongs to, or null when there is none or more than one. */
function _onlyCurrentVehicle() {
  const cur = _veh().listVehicles().filter((v) => v.ownership_state === 'current');
  return cur.length === 1 ? cur[0].vehicle_id : null;
}

/** The latest trustworthy reading of a vehicle, with its provenance and a time. */
function _currentReading(vehicleId) {
  const v = _veh();
  const judged = v.judgeMileage(_db().all('SELECT * FROM vehicle_mileage WHERE vehicle_id = ? AND withdrawn_at IS NULL ORDER BY observed_on, id', [vehicleId])
    .map((r) => ({ id: r.id, value: r.value, unit: r.unit, observedOn: r.observed_on, source: r.source, confidence: r.confidence, correction: !!r.correction, provenance: r.provenance_json ? JSON.parse(r.provenance_json) : null })));
  const accepted = judged.filter((r) => r.state === 'accepted').map((r) => ({ ...r, observedMs: dayNoonMs(r.observedOn) }));
  return { accepted, current: accepted.length ? accepted[accepted.length - 1] : null };
}

function _row(r) {
  return {
    id: r.journey_id, vehicleId: r.vehicle_id, status: r.status, rejectReason: r.reject_reason, source: r.source,
    startedAt: r.started_at, endedAt: r.ended_at,
    start: { lat: r.start_lat, lon: r.start_lon, place: r.start_place }, end: { lat: r.end_lat, lon: r.end_lon, place: r.end_place },
    measuredMiles: r.measured_miles, miles: r.miles, edited: r.miles != null && r.miles !== r.measured_miles,
    movingMinutes: r.moving_minutes, peakKmh: r.peak_kmh, fixCount: r.fix_count, gapMinutes: r.gap_minutes,
    detectedAt: r.detected_at, decidedAt: r.decided_at, note: r.note,
  };
}

async function _fetchHistory(fromMs, toMs, { fetchImpl = global.fetch } = {}) {
  const url = process.env.HA_URL;
  const token = process.env.HA_TOKEN;
  if (!url || !token) { const e = new Error('Home Assistant is not configured (HA_URL / HA_TOKEN)'); e.code = 'not-configured'; throw e; }
  const q = `${url}/api/history/period/${encodeURIComponent(new Date(fromMs).toISOString())}?filter_entity_id=${encodeURIComponent(entity())}&end_time=${encodeURIComponent(new Date(toMs).toISOString())}`;
  const res = await fetchImpl(q, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Home Assistant history answered ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Home Assistant history was not a list');
  return Array.isArray(data[0]) ? data[0] : [];
}

/**
 * Read HA from the cursor, store finished journeys as pending. dryRun stores
 * nothing and moves nothing; `from` (ms) overrides the window for a look back.
 */
async function sync({ now = Date.now(), fetchImpl, dryRun = false, from = null } = {}) {
  const db = _db();
  let since = _num(K_SINCE);
  if (since == null && !dryRun) {
    // First run: start at the latest odometer reading, or now.
    const vid = _onlyCurrentVehicle();
    const cur = vid ? _currentReading(vid).current : null;
    since = cur ? model.readingMoment(cur, { endOfLocalDay }) : now;
    since = Math.min(since, now);
    db.setState(K_SINCE, String(since));
    db.setState(K_CURSOR, String(since));
  }
  const cursor = from != null ? from : (_num(K_CURSOR) || since || now - HA_RETENTION_MS);
  let fromMs = cursor - OVERLAP_MS;
  const notes = [];
  if (fromMs < now - HA_RETENTION_MS) { fromMs = now - HA_RETENTION_MS; notes.push('history older than Home Assistant keeps could not be read'); }
  const record = (o) => { if (!dryRun) db.setState(K_LAST, JSON.stringify(o)); return o; };
  let rows;
  try { rows = await _fetchHistory(fromMs, now, { fetchImpl }); } catch (e) {
    return record({ ok: false, at: now, error: e.message, reason: e.code || 'unreachable', from: fromMs });
  }
  const fixes = model.fixesFromHistory(rows);
  const segs = model.segment(fixes, { readEndMs: now });
  const vehicleId = _onlyCurrentVehicle();
  const out = { ok: true, at: now, from: fromMs, fixes: fixes.length, detected: [], skipped: { open: 0, truncated: 0, existing: 0, beforeTracking: 0, tooShort: 0, tooSlow: 0 }, notes, dryRun };
  let openStart = null;
  for (const s of segs) {
    // A drive the read window cut in half was seen whole by an earlier pass
    // (the cursor never passes a journey still going), which stored it or
    // decided not to. Re-reading its tail as a new journey invented one live
    // on 12 Oct 2026: the commute's last 4.5 mi, after the 15-minute job had
    // rightly skipped the whole commute as before tracking.
    if (s.truncated && !s.open) { out.skipped.truncated++; continue; }
    if (s.open) { out.skipped.open++; openStart = openStart == null ? s.startedAt : Math.min(openStart, s.startedAt); continue; }
    const why = model.rejectReason(s);
    if (why) { out.skipped[why === 'too-short' ? 'tooShort' : 'tooSlow']++; continue; }
    if (since != null && s.startedAt < since && from == null) { out.skipped.beforeTracking++; continue; }
    const clash = db.get('SELECT journey_id FROM vehicle_journeys WHERE source = ? AND started_at <= ? AND ended_at >= ?', [SOURCE, s.endedAt, s.startedAt]);
    if (clash) { out.skipped.existing++; continue; }
    const id = `vj:${SOURCE}:${s.startedAt}`;
    out.detected.push({ id, ...s });
    if (!dryRun) {
      db.run(`INSERT OR IGNORE INTO vehicle_journeys (journey_id, vehicle_id, status, source, started_at, ended_at, start_lat, start_lon, end_lat, end_lon,
                start_place, end_place, measured_miles, moving_minutes, peak_kmh, fix_count, gap_minutes, detected_at)
              VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, vehicleId, SOURCE, s.startedAt, s.endedAt, s.start.lat, s.start.lon, s.end.lat, s.end.lon, s.start.place, s.end.place,
        s.measuredMiles, s.movingMinutes, s.peakKmh, s.fixCount, s.gapMinutes, new Date(now).toISOString()]);
    }
  }
  if (!dryRun && from == null) {
    // Next read starts at a journey still going, else just behind now.
    const next = openStart != null ? openStart - 60000 : now - model.STOP_GAP_MS;
    db.setState(K_CURSOR, String(Math.max(next, fromMs)));
  }
  out.detectedCount = out.detected.length;
  if (out.detected.length && !dryRun) console.log(`[Journeys] ${out.detected.length} journey(s) detected, waiting for approval`);
  return record({ ...out, detected: undefined, detectedCount: out.detected.length, ...(dryRun ? { journeys: out.detected } : {}) });
}

function _get(id) { return _db().get('SELECT * FROM vehicle_journeys WHERE journey_id = ?', [id]) || null; }
function _log(kind, detail, id, now) {
  try { require('./personal-obligations').logEvent(kind, { subjectId: id, actor: 'nick', detail, dedupeKey: `${kind}:${id}:${now}`, now }); } catch { /* audit is never allowed to fail the decision */ }
}

function approve(id, body = {}, { now = Date.now() } = {}) {
  const r = _get(id);
  if (!r) return { ok: false, status: 404, error: 'no such journey' };
  if (r.status === 'approved') return { ok: true, already: true, journey: _row(r) };
  let miles = r.measured_miles;
  if (body.miles !== undefined && body.miles !== null && body.miles !== '') {
    miles = Number(body.miles);
    if (!Number.isFinite(miles) || miles <= 0 || miles > MAX_MILES) return { ok: false, status: 400, error: `miles must be a number above 0 and at most ${MAX_MILES}` };
    miles = Math.round(miles * 10) / 10;
  }
  let vehicleId = r.vehicle_id;
  if (body.vehicleId) {
    if (!_veh().getVehicle(body.vehicleId)) return { ok: false, status: 404, error: 'no such vehicle' };
    vehicleId = body.vehicleId;
  }
  if (!vehicleId) vehicleId = _onlyCurrentVehicle();
  if (!vehicleId) return { ok: false, status: 400, error: 'which vehicle? more than one (or no) current vehicle is recorded — send vehicleId' };
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 200) : r.note;
  _db().run("UPDATE vehicle_journeys SET status = 'approved', reject_reason = NULL, miles = ?, vehicle_id = ?, note = ?, decided_at = ? WHERE journey_id = ?",
    [miles, vehicleId, note, new Date(now).toISOString(), id]);
  _log('vehicle-journey-approved', { miles, measured: r.measured_miles }, id, now);
  return { ok: true, journey: _row(_get(id)) };
}

function reject(id, body = {}, { now = Date.now() } = {}) {
  const r = _get(id);
  if (!r) return { ok: false, status: 404, error: 'no such journey' };
  if (!REJECT_REASONS.includes(body.reason)) return { ok: false, status: 400, error: `reason must be one of: ${REJECT_REASONS.join(', ')}` };
  _db().run("UPDATE vehicle_journeys SET status = 'rejected', reject_reason = ?, miles = NULL, decided_at = ? WHERE journey_id = ?", [body.reason, new Date(now).toISOString(), id]);
  _log('vehicle-journey-rejected', { reason: body.reason }, id, now);
  return { ok: true, journey: _row(_get(id)) };
}

function reopen(id, { now = Date.now() } = {}) {
  const r = _get(id);
  if (!r) return { ok: false, status: 404, error: 'no such journey' };
  _db().run("UPDATE vehicle_journeys SET status = 'pending', reject_reason = NULL, miles = NULL, decided_at = NULL WHERE journey_id = ?", [id]);
  _log('vehicle-journey-reopened', {}, id, now);
  return { ok: true, journey: _row(_get(id)) };
}

function list({ status = 'pending', limit = 50 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = status === 'all'
    ? _db().all('SELECT * FROM vehicle_journeys ORDER BY started_at DESC LIMIT ?', [lim])
    : _db().all('SELECT * FROM vehicle_journeys WHERE status = ? ORDER BY started_at DESC LIMIT ?', [status, lim]);
  return rows.map(_row);
}

/**
 * The journeys block on a vehicle's read model. Reads only — writes nothing
 * (Build 27's read test counts every table before and after).
 */
function forVehicle(vehicleId) {
  const since = _num(K_SINCE);
  const last = _lastSync();
  const rows = _db().all('SELECT * FROM vehicle_journeys WHERE (vehicle_id = ? OR vehicle_id IS NULL) ORDER BY started_at DESC LIMIT 400', [vehicleId]).map(_row);
  const { accepted, current } = _currentReading(vehicleId);
  return {
    tracking: since != null ? { since, source: SOURCE, entity: entity() } : null,
    lastSync: last ? { at: last.at, ok: last.ok, error: last.error || null, detected: last.detectedCount || 0 } : null,
    estimate: model.estimate(current, rows, { endOfLocalDay }),
    reconciliation: model.reconcile(accepted, rows, { trackingSince: since, endOfLocalDay }).slice(0, 3),
    pending: rows.filter((j) => j.status === 'pending').reverse(),
    recent: rows.filter((j) => j.status !== 'pending').slice(0, 10),
  };
}

module.exports = { SOURCE, REJECT_REASONS, sync, approve, reject, reopen, list, forVehicle, endOfLocalDay, _fetchHistory };
