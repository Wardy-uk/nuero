'use strict';

/**
 * Observation state — the latest native observation of each thing (Build 2A).
 *
 * A thin, event-derived projection beside the operational tables, NOT a
 * replacement for them: health_samples, device_status and location_points
 * stay the stores of record. What this adds is the shape the world model needs
 * and those tables do not carry together: for each assertion, its value, WHICH
 * producer said it, when it was OBSERVED versus RECEIVED, its provenance, the
 * event that is the evidence, and what it superseded.
 *
 *   health:<metric>        the newest reading of a metric (subject: nick)
 *   device:<deviceId>      the newest self-report of a phone
 *   location:<deviceId>    when that phone last fixed a position (never where)
 *
 * ⚠ THE NEWEST OBSERVATION WINS, NOT THE LATEST ARRIVAL. Offline queues drain
 * out of order and two apps post independently, so "the last event in seq
 * order" is regularly an older fact. An event observed earlier than the row it
 * would replace is counted (`older_ignored_count`) and kept out. A tie is kept
 * by the FIRST event (lowest seq), so the answer never depends on replay order.
 *
 * ⚠ CLOCK-FREE, so a replay produces the identical table. Freshness — the one
 * judgement needing "now" — is computed when the projection is READ, against
 * the same windows the existing feeds already use, and never stored.
 */

const db = require('../db/database');
const bus = require('./event-bus');

const CONSUMER = 'observation-state';
const TYPES = ['observation.health.recorded', 'observation.device.updated', 'observation.location.recorded'];

const MIN = 60 * 1000;
// Read-time freshness windows: "is this READING current?". Borrowed from the
// feeds that already answer it, never re-picked: device-status's 30-minute
// authority window, location-points' six hours, and signals.js's heart-rate
// (3h) and general health (12h) windows.
const FRESH_WINDOWS = {
  device: 30 * MIN,
  location: 360 * MIN,
  health: 720 * MIN,
  'health:heartRate': 180 * MIN,
};

function _assertion(ev) {
  const p = ev.payload;
  switch (ev.type) {
    case 'observation.health.recorded':
      return {
        key: `health:${p.metric}`, kind: 'health', subjectType: 'person', subjectId: 'nick',
        value: { metric: p.metric, value: p.value, unit: p.unit || null, recordId: p.recordId || null },
      };
    case 'observation.device.updated':
      return {
        key: `device:${p.deviceId}`, kind: 'device', subjectType: 'device', subjectId: p.deviceId,
        value: { deviceId: p.deviceId, ...(p.fields || {}) },
      };
    case 'observation.location.recorded':
      return {
        key: `location:${p.deviceId}`, kind: 'location', subjectType: 'device', subjectId: p.deviceId,
        value: { deviceId: p.deviceId, accuracyM: p.accuracyM == null ? null : p.accuracyM },
      };
    default:
      return null;
  }
}

/** Fold one event. Synchronous: runs in the offset's transaction. */
function applyEvent(ev) {
  const a = _assertion(ev);
  if (!a) return;
  const observedAt = ev.occurredAt;
  const sourceId = (ev.payload && ev.payload.sourceId) || ev.source.system;
  const cur = db.get('SELECT * FROM observation_latest WHERE assertion_key = ?', [a.key]);

  if (cur) {
    if (observedAt <= cur.observed_at) {
      // Observed no later than what we hold: a late arrival or a second
      // reader's copy. Kept out, and counted so the out-of-order drain is
      // visible rather than silent.
      db.run('UPDATE observation_latest SET older_ignored_count = older_ignored_count + 1, updated_at = ? WHERE assertion_key = ?',
        [ev.receivedAt, a.key]);
      return;
    }
    db.run(
      `UPDATE observation_latest SET value_json = ?, source_id = ?, observed_at = ?, received_at = ?,
         event_id = ?, event_seq = ?, provenance_kind = ?, confidence = ?, superseded_event_id = ?,
         superseded_count = superseded_count + 1, updated_at = ?
       WHERE assertion_key = ?`,
      [JSON.stringify(a.value), sourceId, observedAt, ev.receivedAt, ev.eventId, ev.seq,
        ev.provenance.kind, ev.provenance.confidence, cur.event_id, ev.receivedAt, a.key]
    );
    return;
  }

  db.run(
    `INSERT INTO observation_latest (assertion_key, kind, subject_type, subject_id, value_json, source_id,
       observed_at, received_at, event_id, event_seq, provenance_kind, confidence, superseded_event_id,
       superseded_count, older_ignored_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, ?)`,
    [a.key, a.kind, a.subjectType, a.subjectId, JSON.stringify(a.value), sourceId, observedAt,
      ev.receivedAt, ev.eventId, ev.seq, ev.provenance.kind, ev.provenance.confidence, ev.receivedAt]
  );
}

bus.registerConsumer({
  name: CONSUMER,
  types: TYPES,
  transactional: true,
  replayable: true, // writes only its own table
  handle: applyEvent,
  reset: () => db.run('DELETE FROM observation_latest'),
});

function _window(key, kind) {
  return FRESH_WINDOWS[key] || FRESH_WINDOWS[kind] || 720 * MIN;
}

function _shape(r, nowMs) {
  const ageMs = nowMs - Date.parse(r.observed_at);
  const windowMs = _window(r.assertion_key, r.kind);
  return {
    key: r.assertion_key,
    kind: r.kind,
    subject: r.subject_type ? { entityType: r.subject_type, entityId: r.subject_id } : null,
    value: JSON.parse(r.value_json),
    source: r.source_id,
    observedAt: r.observed_at,
    receivedAt: r.received_at,
    ageMs,
    freshness: ageMs <= windowMs ? 'fresh' : 'stale',
    freshWindowMs: windowMs,
    provenance: { kind: r.provenance_kind, confidence: r.confidence },
    evidence: { eventId: r.event_id, seq: r.event_seq },
    supersededEventId: r.superseded_event_id,
    supersededCount: r.superseded_count,
    olderIgnoredCount: r.older_ignored_count,
  };
}

/**
 * The projection, plus whether it is caught up. `kind` narrows. An assertion
 * that has never been observed is ABSENT, and `get()` says so explicitly.
 */
function list({ kind = null, now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const status = bus.getStatus().consumers.find((c) => c.name === CONSUMER) || null;
  const rows = kind
    ? db.all('SELECT * FROM observation_latest WHERE kind = ? ORDER BY assertion_key', [kind])
    : db.all('SELECT * FROM observation_latest ORDER BY assertion_key');
  return {
    projection: {
      consumer: CONSUMER,
      current: !!status && status.lag === 0 && status.retrying === 0,
      lag: status ? status.lag : null,
      deadLettered: status ? status.deadLettered : 0,
      lastProcessedAt: status ? status.lastProcessedAt : null,
    },
    assertions: rows.map((r) => _shape(r, nowMs)),
  };
}

function get(key, { now = Date.now() } = {}) {
  const r = db.get('SELECT * FROM observation_latest WHERE assertion_key = ?', [key]);
  if (!r) return { key, known: false, freshness: 'unknown' };
  return { ..._shape(r, now instanceof Date ? now.getTime() : now), known: true };
}

module.exports = { CONSUMER, TYPES, FRESH_WINDOWS, applyEvent, list, get };
