'use strict';

/**
 * The event bus — NEURO's nervous system (Build 1, 2 Oct 2026).
 *
 * A durable, typed, append-only event log in the same SQLite file as everything
 * else, plus a simple durable consumer model on top of it. It sits BENEATH the
 * existing runtime: the scheduler, watchdog, decision engine and attention gate
 * are unchanged and remain the authorities they were. Sources publish here; a
 * projector consumes from here; later builds hang evaluators off the same
 * consumers.
 *
 *   publishEvent(input)          → { event, duplicate, conflict }
 *   getEvents({ afterSeq, ... }) → read the log
 *   registerConsumer(def)        → a named, durable reader with an offset
 *   pumpConsumer(name)           → process what it has not yet seen
 *   replayConsumer(name)         → reset its projection and rebuild from seq 0
 *   getStatus()                  → counts, lag, failures, dead letters
 *
 * This is the ONLY module that writes event_log / event_consumers /
 * event_failures. Application code publishes through `publishEvent`.
 *
 * Deliberately NOT Kafka-shaped. One process on one Pi, one SQLite file:
 * `seq` (AUTOINCREMENT) is the total order and a consumer's offset is one
 * integer. Simple and reliable beats clever.
 *
 * ── The guarantees, and where each one lives ────────────────────────────────
 *
 *  • Durable: an event is in SQLite (WAL, synchronous=NORMAL) before
 *    publishEvent returns. A restart loses nothing that was acknowledged.
 *  • Idempotent publication: `idempotency_key` is UNIQUE. A second delivery of
 *    the same source item returns the FIRST event with `duplicate: true`. A
 *    re-delivery whose payload DIFFERS is still folded (the log is immutable —
 *    there is nothing to update) but is reported `conflict: true` and logged,
 *    because a source sending two different things under one key is a bug in
 *    that source, and silently keeping the first would hide it.
 *  • Immutable: SQLite triggers refuse UPDATE and DELETE on event_log, and the
 *    payloads handed to consumers are deep-frozen.
 *  • At-least-once to consumers, EXACTLY-ONCE EFFECT for transactional ones:
 *    a `transactional` consumer's handler runs inside the same transaction that
 *    advances its offset, so "applied it" and "recorded that I applied it" are
 *    one commit. An async (non-transactional) consumer is at-least-once and its
 *    handler must be idempotent.
 *  • Ordered: a consumer that fails on event N is held AT N — it does not skip
 *    ahead. A projection that applied N+1 without N is wrong in a way nothing
 *    would notice.
 *  • Bounded failure: after `maxAttempts` the event is DEAD-LETTERED — the
 *    consumer moves past it so one poison event cannot stall it for ever, and
 *    the failure row is KEPT (status 'dead') as the record that it happened.
 */

const crypto = require('crypto');
const db = require('../db/database');
const eventTypes = require('./event-types');

const SCHEMA_VERSION = 1;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_KEY_LENGTH = 512;
const DEFAULT_MAX_ATTEMPTS = 5;
// 30s, 2m, 10m, 1h, then 1h. A source of transient failure (a locked file, a
// half-mounted vault) usually clears in seconds; a real bug does not clear at
// all, and five attempts over ~1h15 is enough to tell the two apart.
const DEFAULT_BACKOFF_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000, 60 * 60 * 1000];
const DEFAULT_BATCH = 500;
const DEFAULT_PUMP_INTERVAL_MS = 60 * 1000;

class EventValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EventValidationError';
  }
}

// Thrown inside a consumer's transaction when its offset is not where this
// process believed it was — another process (the replay CLI) moved it. The
// transaction rolls back and the pump stops; nothing is applied twice.
class PositionMoved extends Error {
  constructor(name) {
    super(`consumer ${name}: offset moved underneath this pump`);
    this.name = 'PositionMoved';
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function nowMsOf(opts) {
  const n = opts && opts.now;
  if (n instanceof Date) return n.getTime();
  if (typeof n === 'number' && Number.isFinite(n)) return n;
  return Date.now();
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.getPrototypeOf(v) === Object.prototype;
}

/**
 * JSON with object keys sorted at every level. The stored payload is this
 * string and the hash is taken over it, so two deliveries of the same content
 * hash identically however their keys happened to be ordered.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => canonicalJson(v === undefined ? null : v)).join(',') + ']';
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

// A full timestamp, never a bare date: `new Date('2026-10-02')` is midnight UTC,
// which is the previous evening west of here and has caught this codebase out
// three times. An event's time must say what instant it means.
const FULL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function toIso(value, field) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new EventValidationError(`${field} is an invalid date`);
    return value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && FULL_TIMESTAMP.test(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  throw new EventValidationError(`${field} must be a full ISO-8601 timestamp (got ${JSON.stringify(value)})`);
}

function optString(v, field, max = 256) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !v.trim() || v.length > max) {
    throw new EventValidationError(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return v;
}

// ── the envelope ─────────────────────────────────────────────────────────────

/**
 * Validate a publish request and build the immutable envelope. Pure apart from
 * id generation and the clock, both of which can be injected for tests.
 *
 * Input:
 *   { type, occurredAt, source: { system, deviceId?, recordId? },
 *     subject?: { entityType, entityId }, correlationId?, causationId?,
 *     idempotencyKey, payload, provenance?: { kind, confidence } }
 */
function buildEnvelope(input, opts = {}) {
  if (!isPlainObject(input)) throw new EventValidationError('event must be an object');

  const def = eventTypes.getType(input.type);
  if (!def) throw new EventValidationError(`unregistered event type: ${JSON.stringify(input.type)}`);

  const key = input.idempotencyKey;
  if (typeof key !== 'string' || !key.trim() || key.length > MAX_KEY_LENGTH) {
    throw new EventValidationError(`idempotencyKey must be a non-empty string of at most ${MAX_KEY_LENGTH} characters`);
  }

  if (!isPlainObject(input.source)) throw new EventValidationError('source must be an object');
  const source = { system: optString(input.source.system, 'source.system', 64) };
  if (!source.system) throw new EventValidationError('source.system is required');
  const deviceId = optString(input.source.deviceId, 'source.deviceId');
  const recordId = optString(input.source.recordId, 'source.recordId', MAX_KEY_LENGTH);
  if (deviceId) source.deviceId = deviceId;
  if (recordId) source.recordId = recordId;

  let subject = null;
  if (input.subject !== undefined && input.subject !== null) {
    if (!isPlainObject(input.subject)) throw new EventValidationError('subject must be an object');
    subject = {
      entityType: optString(input.subject.entityType, 'subject.entityType', 64),
      entityId: optString(input.subject.entityId, 'subject.entityId'),
    };
    if (!subject.entityType || !subject.entityId) {
      throw new EventValidationError('subject needs both entityType and entityId');
    }
  }

  if (!isPlainObject(input.payload)) throw new EventValidationError('payload must be a plain object');
  for (const k of def.required) {
    if (input.payload[k] === undefined) throw new EventValidationError(`${input.type} payload is missing ${k}`);
  }
  let payloadJson;
  try { payloadJson = canonicalJson(input.payload); } catch (e) {
    throw new EventValidationError(`payload is not serialisable: ${e.message}`);
  }
  if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new EventValidationError(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes — store a reference, not the content`);
  }

  const prov = input.provenance === undefined ? {} : input.provenance;
  if (!isPlainObject(prov)) throw new EventValidationError('provenance must be an object');
  const kind = prov.kind === undefined ? def.provenance : prov.kind;
  if (!eventTypes.PROVENANCE_KINDS.includes(kind)) {
    throw new EventValidationError(`provenance.kind must be one of ${eventTypes.PROVENANCE_KINDS.join('|')}`);
  }
  let confidence = prov.confidence === undefined ? 1 : prov.confidence;
  if (confidence !== null && (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1))) {
    throw new EventValidationError('provenance.confidence must be a number between 0 and 1, or null');
  }

  if (input.occurredAt === undefined || input.occurredAt === null) {
    throw new EventValidationError('occurredAt is required — when it happened is not the same fact as when NEURO heard');
  }

  const newId = opts.newId || (() => crypto.randomUUID());
  const eventId = newId();
  return {
    eventId,
    schemaVersion: SCHEMA_VERSION,
    type: input.type,
    typeVersion: def.version,
    occurredAt: toIso(input.occurredAt, 'occurredAt'),
    receivedAt: new Date(nowMsOf(opts)).toISOString(),
    source,
    subject,
    // A new correlation id starts a new story; an event with none is the root
    // of its own. Its id doubles as the root, which is what lets a chain be
    // walked back to where it began.
    correlationId: optString(input.correlationId, 'correlationId') || eventId,
    causationId: optString(input.causationId, 'causationId'),
    idempotencyKey: key,
    payloadJson,
    payloadHash: sha256(payloadJson),
    provenance: { kind, confidence },
  };
}

function rowToEvent(row) {
  if (!row) return null;
  const subject = row.subject_type ? { entityType: row.subject_type, entityId: row.subject_id } : null;
  return deepFreeze({
    seq: row.seq,
    eventId: row.event_id,
    schemaVersion: row.schema_version,
    type: row.type,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    source: JSON.parse(row.source_json),
    subject,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    idempotencyKey: row.idempotency_key,
    payload: JSON.parse(row.payload),
    provenance: { kind: row.provenance_kind, confidence: row.provenance_confidence },
  });
}

// ── publication ──────────────────────────────────────────────────────────────

/**
 * Append an event. Returns { event, duplicate, conflict }.
 *
 * Throws EventValidationError on a malformed request — a caller that cannot
 * build a valid event has a bug worth hearing about. Callers on an ingestion
 * path that must never fail (calendar sync) go through `source-health`, which
 * catches and logs.
 */
function publishEvent(input, opts = {}) {
  const env = buildEnvelope(input, opts);
  const res = db.run(
    `INSERT INTO event_log (event_id, schema_version, type, occurred_at, received_at,
       source_system, source_json, subject_type, subject_id, correlation_id, causation_id,
       idempotency_key, payload, payload_hash, provenance_kind, provenance_confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(idempotency_key) DO NOTHING`,
    [env.eventId, env.schemaVersion, env.type, env.occurredAt, env.receivedAt,
      env.source.system, JSON.stringify(env.source),
      env.subject ? env.subject.entityType : null, env.subject ? env.subject.entityId : null,
      env.correlationId, env.causationId, env.idempotencyKey,
      env.payloadJson, env.payloadHash, env.provenance.kind, env.provenance.confidence]
  );

  if (res.changes === 1) {
    _schedulePump();
    return { event: getEvent(Number(res.lastInsertRowid)), duplicate: false, conflict: false };
  }

  // The key already exists: this is a re-delivery. Return what is on record.
  const existing = rowToEvent(db.get('SELECT * FROM event_log WHERE idempotency_key = ?', [env.idempotencyKey]));
  if (!existing) {
    // ON CONFLICT only swallows the idempotency key. Anything else reaching
    // here means the insert failed for a reason nobody anticipated — say so.
    throw new Error(`event_log insert for ${env.idempotencyKey} wrote nothing and no prior event exists`);
  }
  const existingHash = db.get('SELECT payload_hash FROM event_log WHERE seq = ?', [existing.seq]).payload_hash;
  const conflict = existingHash !== env.payloadHash || existing.type !== env.type;
  if (conflict) {
    console.warn(`[EventBus] idempotency key ${env.idempotencyKey} re-delivered with a DIFFERENT ${existing.type !== env.type ? 'type' : 'payload'} — kept the first (seq ${existing.seq})`);
  }
  return { event: existing, duplicate: true, conflict };
}

function getEvent(seq) {
  return rowToEvent(db.get('SELECT * FROM event_log WHERE seq = ?', [seq]));
}

function getEventById(eventId) {
  return rowToEvent(db.get('SELECT * FROM event_log WHERE event_id = ?', [eventId]));
}

/** Read the log in order. `types` narrows; `limit` is capped at 1000. */
function getEvents({ afterSeq = 0, limit = 100, types = null, correlationId = null } = {}) {
  const lim = Math.max(1, Math.min(1000, Number.isInteger(limit) ? limit : 100));
  const where = ['seq > ?'];
  const params = [Number.isInteger(afterSeq) ? afterSeq : 0];
  if (Array.isArray(types) && types.length) {
    where.push(`type IN (${types.map(() => '?').join(',')})`);
    params.push(...types);
  }
  if (correlationId) { where.push('correlation_id = ?'); params.push(correlationId); }
  params.push(lim);
  return db.all(`SELECT * FROM event_log WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`, params).map(rowToEvent);
}

// ── consumers ────────────────────────────────────────────────────────────────

const registry = new Map();
const running = new Set();

/**
 * Register a durable consumer.
 *
 *   name          stable id (the offset is stored under it — renaming one is a
 *                 new consumer starting from seq 0)
 *   handle(ev)    the work. A `transactional` handler must be SYNCHRONOUS: it
 *                 runs inside the transaction that advances the offset.
 *   types         event types it reads; others are never offered
 *   transactional true → exactly-once effect; false → at-least-once, handler
 *                 must be idempotent and may be async
 *   replayable    true only if handle() has no external effect, so running it
 *                 again over the whole log is safe. Required for replay.
 *   reset()       clears what the consumer owns, before a replay
 */
function registerConsumer(def) {
  if (!def || typeof def.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(def.name)) {
    throw new Error('consumer needs a lower-case kebab name');
  }
  if (typeof def.handle !== 'function') throw new Error(`consumer ${def.name} needs handle()`);
  if (def.replayable && typeof def.reset !== 'function') {
    throw new Error(`consumer ${def.name} is replayable and so needs reset()`);
  }
  if (def.types) {
    for (const t of def.types) {
      if (!eventTypes.getType(t)) throw new Error(`consumer ${def.name} reads unregistered type ${t}`);
    }
  }
  const normalised = Object.freeze({
    name: def.name,
    handle: def.handle,
    types: def.types ? Object.freeze([...def.types]) : null,
    transactional: def.transactional === true,
    replayable: def.replayable === true,
    reset: def.reset || null,
    maxAttempts: Number.isInteger(def.maxAttempts) && def.maxAttempts > 0 ? def.maxAttempts : DEFAULT_MAX_ATTEMPTS,
    backoffMs: Array.isArray(def.backoffMs) && def.backoffMs.length ? def.backoffMs : DEFAULT_BACKOFF_MS,
  });
  registry.set(def.name, normalised);
  return normalised;
}

// The built-in consumers. Required lazily because they require this module to
// publish — a top-level require would be a cycle.
let builtinsLoaded = false;
function _loadBuiltins() {
  if (builtinsLoaded) return;
  builtinsLoaded = true;
  require('./source-health');
}

function getConsumer(name) {
  _loadBuiltins();
  return registry.get(name) || null;
}

function listConsumers() {
  _loadBuiltins();
  return [...registry.values()];
}

function _ensureRow(name, nowIso) {
  db.run('INSERT OR IGNORE INTO event_consumers (name, position, updated_at) VALUES (?, 0, ?)', [name, nowIso]);
  return db.get('SELECT * FROM event_consumers WHERE name = ?', [name]);
}

function _nextBatch(def, afterSeq, limit) {
  if (def.types) {
    return db.all(
      `SELECT * FROM event_log WHERE seq > ? AND type IN (${def.types.map(() => '?').join(',')}) ORDER BY seq LIMIT ?`,
      [afterSeq, ...def.types, limit]
    );
  }
  return db.all('SELECT * FROM event_log WHERE seq > ? ORDER BY seq LIMIT ?', [afterSeq, limit]);
}

function _advance(name, expected, seq, nowIso) {
  // Guarded on the position this pump believes it holds. If anything else
  // moved it (a replay from the CLI, a second process), this changes nothing
  // and the caller rolls the whole step back.
  const r = db.run(
    'UPDATE event_consumers SET position = ?, last_processed_at = ?, updated_at = ? WHERE name = ? AND position = ?',
    [seq, nowIso, nowIso, name, expected]
  );
  if (r.changes !== 1) throw new PositionMoved(name);
}

function _openFailure(name, seq) {
  return db.get(`SELECT * FROM event_failures WHERE consumer = ? AND seq = ? AND status = 'retrying'`, [name, seq]);
}

function _resolveFailure(failure, resolution, nowIso) {
  if (!failure) return;
  db.run(`UPDATE event_failures SET status = 'resolved', resolved_at = ?, resolution = ? WHERE id = ?`,
    [nowIso, resolution, failure.id]);
}

/**
 * Record a failed attempt. Returns 'retrying' or 'dead'.
 * A 'dead' outcome also advances the offset past the event, in the same
 * transaction, so the consumer is not stalled by one poison event.
 */
function _recordFailure(def, seq, expected, err, nowMs) {
  const nowIso = new Date(nowMs).toISOString();
  const message = String((err && err.message) || err).slice(0, 2000);
  return db.batchSaves(() => {
    const prior = db.get('SELECT * FROM event_failures WHERE consumer = ? AND seq = ?', [def.name, seq]);
    const attempts = (prior && prior.status === 'retrying' ? prior.attempts : 0) + 1;
    const dead = attempts >= def.maxAttempts;
    const wait = def.backoffMs[Math.min(attempts - 1, def.backoffMs.length - 1)];
    const next = dead ? null : new Date(nowMs + wait).toISOString();
    if (prior) {
      db.run(`UPDATE event_failures SET status = ?, attempts = ?, last_error = ?, last_failed_at = ?,
                next_attempt_at = ?, resolved_at = NULL, resolution = NULL WHERE id = ?`,
      [dead ? 'dead' : 'retrying', attempts, message, nowIso, next, prior.id]);
    } else {
      db.run(`INSERT INTO event_failures (consumer, seq, status, attempts, last_error, first_failed_at, last_failed_at, next_attempt_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [def.name, seq, dead ? 'dead' : 'retrying', attempts, message, nowIso, nowIso, next]);
    }
    db.run('UPDATE event_consumers SET last_error = ?, last_error_at = ?, updated_at = ? WHERE name = ?',
      [message, nowIso, nowIso, def.name]);
    if (dead) _advance(def.name, expected, seq, nowIso);
    return dead ? 'dead' : 'retrying';
  });
}

/**
 * Process everything the consumer has not yet handled, in order.
 *
 * Returns { processed, deadLettered, blocked, waitingUntil, position, skipped }.
 * `blocked` means it is holding at a failed event until its retry is due.
 */
async function pumpConsumer(name, opts = {}) {
  const def = getConsumer(name);
  if (!def) throw new Error(`no such consumer: ${name}`);
  if (running.has(name)) return { skipped: 'already running', processed: 0, deadLettered: 0, blocked: false };
  running.add(name);
  const result = { processed: 0, deadLettered: 0, blocked: false, waitingUntil: null, position: 0 };
  try {
    const limit = Number.isInteger(opts.batch) && opts.batch > 0 ? opts.batch : DEFAULT_BATCH;
    let pos = _ensureRow(name, new Date(nowMsOf(opts)).toISOString()).position;
    outer: for (;;) {
      const rows = _nextBatch(def, pos, limit);
      if (!rows.length) break;
      for (const row of rows) {
        const nowMs = nowMsOf(opts);
        const nowIso = new Date(nowMs).toISOString();
        const failure = _openFailure(name, row.seq);
        if (failure && failure.next_attempt_at && Date.parse(failure.next_attempt_at) > nowMs) {
          result.blocked = true;
          result.waitingUntil = failure.next_attempt_at;
          break outer;
        }
        const event = rowToEvent(row);
        try {
          if (def.transactional) {
            db.batchSaves(() => {
              const out = def.handle(event, { now: nowMs });
              if (out && typeof out.then === 'function') {
                throw new Error(`transactional consumer ${name} returned a promise — its handler must be synchronous`);
              }
              _advance(name, pos, row.seq, nowIso);
              _resolveFailure(failure, 'processed', nowIso);
            });
          } else {
            await def.handle(event, { now: nowMs });
            db.batchSaves(() => {
              _advance(name, pos, row.seq, nowIso);
              _resolveFailure(failure, 'processed', nowIso);
            });
          }
          pos = row.seq;
          result.processed++;
        } catch (e) {
          if (e instanceof PositionMoved) {
            console.warn(`[EventBus] ${e.message} — stopping this pass`);
            result.skipped = 'position moved';
            break outer;
          }
          let outcome;
          try { outcome = _recordFailure(def, row.seq, pos, e, nowMs); } catch (e2) {
            if (e2 instanceof PositionMoved) { result.skipped = 'position moved'; break outer; }
            throw e2;
          }
          if (outcome === 'dead') {
            console.error(`[EventBus] ${name} DEAD-LETTERED seq ${row.seq} (${row.type}) after ${def.maxAttempts} attempts: ${e.message}`);
            pos = row.seq;
            result.deadLettered++;
            continue;
          }
          console.warn(`[EventBus] ${name} failed on seq ${row.seq} (${row.type}): ${e.message} — will retry`);
          result.blocked = true;
          result.waitingUntil = _openFailure(name, row.seq)?.next_attempt_at || null;
          break outer;
        }
      }
      if (rows.length < limit) break;
    }
    result.position = pos;
    return result;
  } finally {
    running.delete(name);
  }
}

async function pumpAll(opts = {}) {
  const out = {};
  for (const def of listConsumers()) {
    try {
      out[def.name] = await pumpConsumer(def.name, opts);
    } catch (e) {
      console.error(`[EventBus] pump of ${def.name} threw:`, e.message);
      out[def.name] = { error: e.message };
    }
  }
  return out;
}

/**
 * Rebuild a consumer from the start of the log.
 *
 * Refused unless the consumer is declared `replayable` — i.e. its handler has
 * no external effect. A replay re-runs the HANDLER over existing events; it
 * never re-publishes anything, so publication idempotency is not bypassed, and
 * the consumer's own reset() is what stops the rebuild doubling its state.
 *
 * Open failures for the consumer are marked resolved('replay') rather than
 * deleted: they are history, and the replay re-attempts those events anyway.
 */
async function replayConsumer(name, opts = {}) {
  const def = getConsumer(name);
  if (!def) throw new Error(`no such consumer: ${name}`);
  if (!def.replayable) throw new Error(`consumer ${name} is not declared replayable — refusing`);
  if (running.has(name)) throw new Error(`consumer ${name} is running — try again`);
  running.add(name);
  const nowIso = new Date(nowMsOf(opts)).toISOString();
  try {
    db.batchSaves(() => {
      _ensureRow(name, nowIso);
      def.reset();
      db.run(`UPDATE event_failures SET status = 'resolved', resolved_at = ?, resolution = 'replay'
              WHERE consumer = ? AND status IN ('retrying', 'dead')`, [nowIso, name]);
      db.run(`UPDATE event_consumers SET position = 0, last_error = NULL, last_error_at = NULL,
              replayed_at = ?, updated_at = ? WHERE name = ?`, [nowIso, nowIso, name]);
    });
  } finally {
    running.delete(name);
  }
  const res = await pumpConsumer(name, opts);
  console.log(`[EventBus] replayed ${name}: ${res.processed} event(s), ${res.deadLettered} dead-lettered`);
  return res;
}

// ── observability ────────────────────────────────────────────────────────────

function _lag(def, position) {
  if (def && def.types) {
    return db.get(
      `SELECT COUNT(*) AS n FROM event_log WHERE seq > ? AND type IN (${def.types.map(() => '?').join(',')})`,
      [position, ...def.types]
    ).n;
  }
  return db.get('SELECT COUNT(*) AS n FROM event_log WHERE seq > ?', [position]).n;
}

function getFailures({ consumer = null, status = null, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (consumer) { where.push('consumer = ?'); params.push(consumer); }
  if (status) { where.push('status = ?'); params.push(status); }
  params.push(Math.max(1, Math.min(500, limit)));
  return db.all(
    `SELECT * FROM event_failures ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY last_failed_at DESC LIMIT ?`,
    params
  );
}

/**
 * The operational picture: is the spine taking events, and is every consumer
 * keeping up? Reads only — counts, never payloads.
 */
function getStatus() {
  const totals = db.get(`SELECT COUNT(*) AS n, MAX(seq) AS newestSeq, MAX(received_at) AS newestAt,
                         MIN(received_at) AS oldestAt FROM event_log`);
  const byType = {};
  for (const r of db.all('SELECT type, COUNT(*) AS n FROM event_log GROUP BY type ORDER BY type')) byType[r.type] = r.n;
  const fail = {};
  for (const r of db.all('SELECT status, COUNT(*) AS n FROM event_failures GROUP BY status')) fail[r.status] = r.n;

  const rows = new Map(db.all('SELECT * FROM event_consumers').map(r => [r.name, r]));
  const names = new Set([...rows.keys(), ...listConsumers().map(d => d.name)]);
  const consumers = [...names].sort().map(name => {
    const def = registry.get(name) || null;
    const row = rows.get(name) || null;
    const position = row ? row.position : 0;
    const counts = {};
    for (const r of db.all('SELECT status, COUNT(*) AS n FROM event_failures WHERE consumer = ? GROUP BY status', [name])) counts[r.status] = r.n;
    return {
      name,
      registered: !!def,
      position,
      lag: _lag(def, position),
      lastProcessedAt: row ? row.last_processed_at : null,
      lastError: row ? row.last_error : null,
      lastErrorAt: row ? row.last_error_at : null,
      replayedAt: row ? row.replayed_at : null,
      retrying: counts.retrying || 0,
      deadLettered: counts.dead || 0,
      running: running.has(name),
    };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    events: {
      count: totals.n,
      newestSeq: totals.newestSeq || 0,
      newestAt: totals.newestAt || null,
      oldestAt: totals.oldestAt || null,
      byType,
    },
    failures: { retrying: fail.retrying || 0, dead: fail.dead || 0, resolved: fail.resolved || 0 },
    consumers,
    autoPump: started,
  };
}

// ── runtime ──────────────────────────────────────────────────────────────────
// The bus is hosted by the existing backend process; scheduler.start() calls
// start(). Tests never do, so in a test nothing runs unless the test pumps.

let started = false;
let pumpTimer = null;
let pumpQueued = false;

function _schedulePump() {
  if (!started || pumpQueued) return;
  pumpQueued = true;
  setImmediate(() => {
    pumpQueued = false;
    pumpAll().catch(e => console.error('[EventBus] pump failed:', e.message));
  });
}

/**
 * Start consuming. Publishing pumps immediately; the interval is the recovery
 * path — it is what resumes a consumer after a restart and what retries a
 * failure once its back-off has passed.
 */
function start({ intervalMs = DEFAULT_PUMP_INTERVAL_MS } = {}) {
  if (started) return;
  started = true;
  _loadBuiltins();
  pumpTimer = setInterval(() => {
    pumpAll().catch(e => console.error('[EventBus] pump failed:', e.message));
  }, intervalMs);
  if (pumpTimer.unref) pumpTimer.unref();
  _schedulePump();
  console.log(`[EventBus] started — ${listConsumers().length} consumer(s), pump every ${Math.round(intervalMs / 1000)}s`);
}

function stop() {
  started = false;
  if (pumpTimer) clearInterval(pumpTimer);
  pumpTimer = null;
}

module.exports = {
  SCHEMA_VERSION,
  EventValidationError,
  buildEnvelope,
  canonicalJson,
  publishEvent,
  getEvent,
  getEventById,
  getEvents,
  registerConsumer,
  getConsumer,
  listConsumers,
  pumpConsumer,
  pumpAll,
  replayConsumer,
  getFailures,
  getStatus,
  start,
  stop,
};
