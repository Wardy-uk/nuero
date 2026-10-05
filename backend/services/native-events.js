'use strict';

/**
 * Native sensing → the event spine (Build 2A).
 *
 * The ingestion routes for the phone apps (health, device status, location,
 * the EventKit calendar push) call these AFTER their own writes have
 * committed. Every function here:
 *
 *  • NEVER THROWS. The spine is additive. A broken event table must cost the
 *    phone nothing: the route still answers exactly what it answered before,
 *    and the existing tables still hold the data (Build 1's rule, unchanged).
 *  • publishes TWO kinds of thing, keyed differently on purpose —
 *      a delivery heartbeat (`source.observation.received`), keyed on the
 *        SOURCE + delivery content: "is this sensor, through this app, alive?"
 *      domain observations (`observation.*`), keyed on the RECORD: "what was
 *        true?" — so the same HealthKit sample from two apps is one event.
 *    Redundant sensing is fine; duplicate truth is not.
 *
 * ⚠ What never enters the log: coordinates, SSIDs, geocoded place names, or
 * any sample content beyond the newest value of a metric. The log is
 * append-only and undeletable by trigger; the operational tables beside it
 * (location_points, device_status, health_samples) are where the detail lives,
 * and they can be pruned.
 */

const crypto = require('crypto');
const nativeSources = require('./native-sources');

function _bus() { return require('./event-bus'); }
function _db() { return require('../db/database'); }

/** health_samples' 'YYYY-MM-DD HH:MM:SS' is UTC with no marker — say so. */
function sqlUtcToIso(s) {
  if (typeof s !== 'string' || !s) return null;
  const ms = Date.parse(`${s.trim().replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function _hash(parts) {
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 24);
}

function _publish(input, nowMs) {
  try {
    const r = _bus().publishEvent(input, { now: nowMs });
    return { ok: true, duplicate: r.duplicate, conflict: r.conflict, event: r.event };
  } catch (e) {
    console.warn(`[NativeEvents] could not publish ${input && input.type}: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** An observation is never later than the moment it reached NEURO. */
function _clampToNow(iso, nowMs) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.min(ms, nowMs)).toISOString();
}

/**
 * Should this delivery be recorded as a heartbeat?
 *
 * The log records CHANGE, not polling (Build 1's calendar rule). FreeReps
 * re-sends the same 500-point chunks hundreds of times a day; recording each
 * as an event would put ~370 rows a day of nothing into an undeletable log.
 * So a heartbeat is skipped when it would tell SourceHealth nothing new:
 * the source is already healthy, this delivery observed nothing newer, and
 * the last heartbeat is younger than the source's expected interval (one
 * liveness tick per interval is still recorded, so "alive" stays provable).
 *
 * Reads the projection, which may be a moment behind the log. Being behind
 * can only cause an EXTRA heartbeat, never a missing one that mattered.
 */
function _heartbeatWanted(sourceId, newestObservedAt, nowMs, expectedIntervalMs) {
  let row = null;
  try { row = _db().get('SELECT state, last_observed_at, updated_at FROM source_health WHERE source_id = ?', [sourceId]); }
  catch { return true; }
  if (!row) return true;
  if (row.state !== 'healthy') return true;
  if (!row.last_observed_at || newestObservedAt > row.last_observed_at) return true;
  const since = nowMs - Date.parse(row.updated_at);
  return !(since < expectedIntervalMs);
}

function _heartbeat({ kind, client, via, deviceId, deliveryId, newestObservedAt, detail, nowMs }) {
  const sourceId = nativeSources.sourceIdFor(kind, client);
  const d = nativeSources.describe(sourceId);
  if (!newestObservedAt) return { sourceId, published: false, why: 'nothing observed' };
  if (!_heartbeatWanted(sourceId, newestObservedAt, nowMs, d.expectedIntervalMs)) {
    return { sourceId, published: false, why: 'nothing new since the last heartbeat' };
  }
  const source = { system: kind, recordId: deliveryId };
  if (deviceId) source.deviceId = deviceId;
  const r = _publish({
    type: 'source.observation.received',
    occurredAt: newestObservedAt,
    source,
    subject: { entityType: 'source', entityId: sourceId },
    idempotencyKey: `source-delivery:${sourceId}:${deliveryId}`,
    payload: {
      sourceId, deliveryId, newestObservedAt, client, clientVia: via,
      expectedIntervalMs: d.expectedIntervalMs, staleAfterMs: d.staleAfterMs,
      detail,
    },
  }, nowMs);
  return { sourceId, published: r.ok && !r.duplicate, duplicate: !!r.duplicate, event: r.event || null };
}

// ── Health ───────────────────────────────────────────────────────────────────

/**
 * Record a health delivery.
 *
 *   parsed    apple-health.parsePayload()'s output (all samples received)
 *   inserted  the samples the route actually stored as NEW in health_samples
 *
 * One observation per metric: the newest NEWLY STORED sample. A re-sent
 * sample was not stored, so it produces no observation — and if it somehow
 * were offered, its key (the HealthKit UUID) already exists and it folds.
 */
function recordHealthDelivery({ headers = {}, parsed, inserted = [], workoutsInserted = 0, now = Date.now() } = {}) {
  const out = { sourceId: null, heartbeat: null, observations: { published: 0, folded: 0, failed: 0 } };
  try {
    const nowMs = now instanceof Date ? now.getTime() : now;
    const { client, via } = nativeSources.resolveClient(headers);
    out.sourceId = nativeSources.sourceIdFor('healthkit', client);
    const samples = (parsed && parsed.samples) || [];

    // Newest observation across everything the sensor delivered — re-sends
    // included, because the app having them is still the sensor observing.
    let newest = null;
    const keys = [];
    for (const s of samples) {
      const iso = sqlUtcToIso(s.recordedAt);
      if (iso && (!newest || iso > newest)) newest = iso;
      keys.push(s.sourceUuid || `${s.metric}@${s.recordedAt}`);
    }
    for (const w of (parsed && parsed.workouts) || []) keys.push(`w:${w.sourceUuid || w.startedAt || ''}`);
    keys.sort();
    const deliveryId = _hash([out.sourceId, ...keys]);
    newest = newest ? _clampToNow(newest, nowMs) : null;

    out.heartbeat = _heartbeat({
      kind: 'healthkit', client, via, deliveryId, newestObservedAt: newest, nowMs,
      // ⚠ CONTENT-DERIVED ONLY. The key is a hash of what was delivered, so a
      // retry must carry an identical payload — "stored 2" on the first try and
      // "stored 0" on the retry would read as a source sending two different
      // things under one key (a conflict) when it is just a retry. What was
      // NEW is in the observation events, which is where it belongs.
      detail: {
        received: parsed ? parsed.received : 0,
        workouts: ((parsed && parsed.workouts) || []).length,
      },
    });

    // Newest newly-stored sample per metric.
    const latest = new Map();
    for (const s of inserted) {
      const prev = latest.get(s.metric);
      if (!prev || s.recordedAt > prev.recordedAt) latest.set(s.metric, s);
    }
    for (const s of latest.values()) {
      const observedAt = sqlUtcToIso(s.recordedAt);
      if (!observedAt) continue;
      const r = _publish({
        type: 'observation.health.recorded',
        occurredAt: observedAt,
        source: { system: 'healthkit', recordId: s.sourceUuid || undefined },
        subject: { entityType: 'person', entityId: 'nick' },
        // ⚠ The record's own identity, never the delivery's: two apps reading
        // one HealthKit store send the same UUID, and that must be one event.
        // No UUID (FreeReps, older payloads): the same (metric, instant) the
        // store itself dedupes on, so the log and the table agree on sameness.
        idempotencyKey: s.sourceUuid
          ? `healthkit-sample:${s.sourceUuid}`
          : `health-sample:${s.metric}:${observedAt}`,
        payload: {
          metric: s.metric, value: s.value, unit: s.units || null, observedAt,
          recordId: s.sourceUuid || null, sourceId: out.sourceId,
        },
      }, nowMs);
      if (!r.ok) out.observations.failed++;
      else if (r.duplicate) out.observations.folded++;
      else out.observations.published++;
    }
  } catch (e) {
    console.warn('[NativeEvents] health delivery not recorded:', e.message);
    out.error = e.message;
  }
  return out;
}

// ── Device ───────────────────────────────────────────────────────────────────

// What the device observation carries. ⚠ `ssid` and `geocodedLocation` are
// absent on purpose: an SSID and a place name do not belong in a log nothing
// can ever delete.
const DEVICE_FIELDS = ['batteryLevel', 'batteryState', 'connectionType', 'activity', 'activitySince',
  'steps', 'distanceM', 'floorsAscended', 'focusMode'];

/**
 * Record a device self-report. `status` is device-status.validate()'s output.
 * Published whether or not the row was stored: an OLDER report the table
 * correctly refused is still a real observation, and the projection — which
 * orders by observed time — is what decides it does not win.
 */
function recordDeviceReport({ headers = {}, status, stored = null, now = Date.now() } = {}) {
  const out = { sourceId: null, heartbeat: null, observation: null };
  try {
    const nowMs = now instanceof Date ? now.getTime() : now;
    const { client, via } = nativeSources.resolveClient(headers);
    out.sourceId = nativeSources.sourceIdFor('device', client);
    const observedAt = _clampToNow(status.reportedAt, nowMs);
    const fields = {};
    for (const f of DEVICE_FIELDS) if (status[f] !== null && status[f] !== undefined) fields[f] = status[f];

    const r = _publish({
      type: 'observation.device.updated',
      occurredAt: observedAt,
      source: { system: 'device', deviceId: status.deviceId },
      subject: { entityType: 'device', entityId: status.deviceId },
      // One report = one observation. reportedAt is the device's own stamp, so
      // a retry of the same report folds and two reports never collide.
      idempotencyKey: `device-status:${status.deviceId}:${status.reportedAt}`,
      payload: { deviceId: status.deviceId, observedAt, fields, sourceId: out.sourceId },
    }, nowMs);
    out.observation = r.ok ? { published: !r.duplicate, duplicate: !!r.duplicate } : { failed: true };

    out.heartbeat = _heartbeat({
      kind: 'device', client, via, deviceId: status.deviceId,
      deliveryId: _hash([out.sourceId, status.deviceId, status.reportedAt]),
      newestObservedAt: observedAt, nowMs,
      // Content-derived only (see the health heartbeat): whether THIS copy was
      // stored differs between a delivery and its retry.
      detail: { fields: Object.keys(fields).length },
    });
  } catch (e) {
    console.warn('[NativeEvents] device report not recorded:', e.message);
    out.error = e.message;
  }
  return out;
}

// ── Location ─────────────────────────────────────────────────────────────────

/**
 * Record a position batch. `accepted` are the validated points (unix-second
 * `tst`). Only the NEWEST fix's time and accuracy go into the log.
 */
function recordLocationBatch({ headers = {}, deviceId, accepted = [], stored = 0, now = Date.now() } = {}) {
  const out = { sourceId: null, heartbeat: null, observation: null };
  try {
    const nowMs = now instanceof Date ? now.getTime() : now;
    const { client, via } = nativeSources.resolveClient(headers);
    out.sourceId = nativeSources.sourceIdFor('location', client);
    if (!accepted.length) return out;
    let newest = accepted[0];
    for (const p of accepted) if (p.tst > newest.tst) newest = p;
    const observedAt = _clampToNow(new Date(newest.tst * 1000).toISOString(), nowMs);

    const r = _publish({
      type: 'observation.location.recorded',
      occurredAt: observedAt,
      source: { system: 'location', deviceId },
      subject: { entityType: 'device', entityId: deviceId },
      // location_points already dedupes on (device, tst): same rule here.
      idempotencyKey: `location-fix:${deviceId}:${newest.tst}`,
      payload: {
        deviceId, observedAt,
        accuracyM: newest.accuracy == null ? null : newest.accuracy,
        sourceId: out.sourceId,
      },
    }, nowMs);
    out.observation = r.ok ? { published: !r.duplicate, duplicate: !!r.duplicate } : { failed: true };

    out.heartbeat = _heartbeat({
      kind: 'location', client, via, deviceId,
      deliveryId: _hash([out.sourceId, deviceId, ...accepted.map((p) => String(p.tst)).sort()]),
      newestObservedAt: observedAt, nowMs,
      detail: { received: accepted.length },
    });
  } catch (e) {
    console.warn('[NativeEvents] location batch not recorded:', e.message);
    out.error = e.message;
  }
  return out;
}

// ── EventKit calendar push ───────────────────────────────────────────────────

/**
 * Record a calendar push. A whole-state snapshot, so the "observation" is the
 * push itself, as of when it arrived. A push the ingest REFUSED because the
 * phone could see no calendars is a FAILURE here, by name — that exact state
 * ran for six days in September while every light stayed green.
 */
function recordEventKitPush({ headers = {}, body = {}, result = {}, now = Date.now() } = {}) {
  const out = { sourceId: null, heartbeat: null, failure: null };
  try {
    const nowMs = now instanceof Date ? now.getTime() : now;
    const { client, via } = nativeSources.resolveClient(headers, body.client);
    out.sourceId = nativeSources.sourceIdFor('eventkit', client);
    // apple-ingest answers ok:false for a refused push (`no-calendar-access`)
    // and for a malformed one; both mean nothing current reached the diary.
    if (!result || result.ok !== true) {
      out.failure = recordDeliveryFailure({
        kind: 'eventkit', headers, bodyClient: body.client,
        error: (result && result.error) || 'push refused',
        reason: (result && result.reason) || 'rejected', now: nowMs,
      });
      return out;
    }
    const nowIso = new Date(nowMs).toISOString();
    const events = Array.isArray(body.events) ? body.events : [];
    out.heartbeat = _heartbeat({
      kind: 'eventkit', client, via,
      deliveryId: _hash([out.sourceId, String(body.from || ''), String(body.to || ''),
        ...events.map((e) => `${e && e.id}@${e && e.start}`).sort()]),
      newestObservedAt: nowIso, nowMs,
      detail: { events: events.length, calendars: Array.isArray(body.calendars) ? body.calendars.length : null },
    });
  } catch (e) {
    console.warn('[NativeEvents] calendar push not recorded:', e.message);
    out.error = e.message;
  }
  return out;
}

// ── Reminders push (Build 11D) ───────────────────────────────────────────────

/**
 * Record a Reminders push — its OWN source, `reminders.<client>`, beside the
 * calendar's `eventkit.<client>`. One push carrying both used to be judged by
 * the calendar alone, so a reminders sync that had stopped (no list access, an
 * app build that never sends them) was invisible behind a healthy diary.
 * A push the ingest could not use is a FAILURE here, by name.
 */
function recordRemindersPush({ headers = {}, body = {}, result = {}, now = Date.now() } = {}) {
  const out = { sourceId: null, heartbeat: null, failure: null };
  try {
    const nowMs = now instanceof Date ? now.getTime() : now;
    const { client, via } = nativeSources.resolveClient(headers, body.client);
    out.sourceId = nativeSources.sourceIdFor('reminders', client);
    if (!result || result.ok !== true) {
      out.failure = recordDeliveryFailure({
        kind: 'reminders', headers, bodyClient: body.client,
        error: (result && result.error) || 'push refused', reason: 'rejected', now: nowMs,
      });
      return out;
    }
    const reminders = Array.isArray(body.reminders) ? body.reminders : [];
    // The key carries the HOUR as well as the list. Keyed on the list alone, an
    // unchanged set of reminders folded every later push into the first one, so
    // a phone pushing on every wake read STALE after 12h (5 Oct 2026). The hour
    // bucket is also the observed time, so a retry inside the hour folds with an
    // identical payload rather than reporting a conflict.
    const hour = Math.floor(nowMs / 3600000) * 3600000;
    out.heartbeat = _heartbeat({
      kind: 'reminders', client, via,
      deliveryId: _hash([out.sourceId, String(hour), ...reminders.map((r) => `${r && (r.id || r.title)}@${r && r.isCompleted ? 1 : 0}`).sort()]),
      newestObservedAt: new Date(hour).toISOString(), nowMs,
      detail: { reminders: reminders.length, projected: result.projected || 0, unidentified: result.unidentified || 0,
        lists: Array.isArray(body.lists) ? body.lists.length : null, complete: !!result.complete },
    });
  } catch (e) {
    console.warn('[NativeEvents] reminders push not recorded:', e.message);
    out.error = e.message;
  }
  return out;
}

// ── Desktop agent (Build 11M) ────────────────────────────────────────────────

/**
 * The laptop's activity reporter onto the spine. Build 10 named it off-spine:
 * its health was judged only by NEURO Health's older check, so Sources could
 * say nothing about it. One source, `desktop.agent`, judged on the newest
 * SAMPLE time (a reporter draining a backlog after sleep is late, not live).
 * The sample's contents (app names) never enter the event — only that the
 * sensor reported, and when.
 */
function recordDesktopSample({ samples = [], now = Date.now() } = {}) {
  try {
    const nowMs = now instanceof Date ? now.getTime() : now;
    const times = (samples || []).map((s) => Date.parse(s && (s.at || s.ts || s.time))).filter(Number.isFinite);
    const newest = times.length ? new Date(Math.min(Math.max(...times), nowMs)).toISOString() : new Date(nowMs).toISOString();
    const hosts = [...new Set((samples || []).map((s) => (s && s.host ? String(s.host).toLowerCase() : 'unknown')))];
    return _heartbeat({
      kind: 'desktop', client: 'agent', via: 'route',
      deliveryId: _hash(['desktop.agent', newest, ...hosts]),
      newestObservedAt: newest, nowMs,
      detail: { samples: (samples || []).length, hosts: hosts.length },
    });
  } catch (e) {
    console.warn('[NativeEvents] desktop sample not recorded:', e.message);
    return { error: e.message };
  }
}

// ── Failures ─────────────────────────────────────────────────────────────────

/**
 * A delivery NEURO could not take (malformed, or the store refused). Stamped
 * when it was refused. A fresh delivery id per attempt: a retry that fails
 * again is a second failure, and counting it is the point.
 */
function recordDeliveryFailure({ kind, headers = {}, bodyClient = null, deviceId = null, error, reason = null, now = Date.now() } = {}) {
  try {
    const nowMs = now instanceof Date ? now.getTime() : now;
    const { client } = nativeSources.resolveClient(headers, bodyClient);
    const sourceId = nativeSources.sourceIdFor(kind, client);
    const runId = crypto.randomUUID();
    const source = { system: kind, recordId: runId };
    if (deviceId) source.deviceId = deviceId;
    const r = _publish({
      type: 'source.sync.failed',
      occurredAt: new Date(nowMs).toISOString(),
      source,
      subject: { entityType: 'source', entityId: sourceId },
      idempotencyKey: `source-delivery-failed:${sourceId}:${runId}`,
      payload: { sourceId, runId, error: String(error || 'unknown failure').slice(0, 500), reason, client },
    }, nowMs);
    return { sourceId, published: r.ok };
  } catch (e) {
    console.warn('[NativeEvents] failure not recorded:', e.message);
    return { sourceId: null, published: false, error: e.message };
  }
}

module.exports = {
  DEVICE_FIELDS,
  sqlUtcToIso,
  recordHealthDelivery,
  recordDeviceReport,
  recordLocationBatch,
  recordEventKitPush,
  recordRemindersPush,
  recordDesktopSample,
  recordDeliveryFailure,
};
