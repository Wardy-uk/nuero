'use strict';

/**
 * Source health — the first materialised world-state projection (Build 1).
 *
 * "Is each source actually working?" answered from the event log, so that
 * source blindness is first-class STATE rather than a log line or a guess. Two
 * halves:
 *
 *   beginSourceRun(sourceId)  what an ingestion path calls. Publishes
 *                             source.sync.started, then exactly one of
 *                             succeeded / failed. NEVER throws: the event layer
 *                             is additive, and a broken spine must not take the
 *                             calendar down with it.
 *
 *   the `source-health`       a transactional, replayable consumer that folds
 *   projector                 those events into the `source_health` table.
 *
 * ⚠ UNKNOWN IS NOT ZERO, AND IS NOT HEALTHY. A source the projection has never
 * heard from is `state: 'unknown', freshness: 'unknown'` — it is absent from
 * the table, and getSourceHealth() says so rather than listing nothing. A
 * source that has only ever failed stays `freshness: 'unknown'` (there has never
 * been data to be fresh or stale about), never 'fresh'.
 *
 * ⚠ THE PROJECTION IS A FUNCTION OF THE LOG AND NOTHING ELSE. Every column is
 * derived from event fields — including `updated_at`, which is the event's
 * received time and not the wall clock — so a replay produces the identical
 * table. Staleness is the one judgement that needs a clock, and it is made ONCE,
 * by checkStaleness(), and RECORDED as a source.sync.stale event; the projector
 * only applies it. Replaying it therefore reproduces the decision rather than
 * re-making it against a different "now".
 *
 * Compatible with, and deliberately not a replacement for, watchdog.js: the
 * watchdog keeps its own checks. A later build can have it read this projection
 * or publish into it.
 */

const crypto = require('crypto');
const db = require('../db/database');
const bus = require('./event-bus');

const CONSUMER = 'source-health';
const TYPES = ['source.sync.started', 'source.sync.succeeded', 'source.sync.failed', 'source.sync.stale',
  'source.observation.received'];
const SOURCE_ID = /^[a-z][a-z0-9_.-]{0,63}$/;

// ── the projector ────────────────────────────────────────────────────────────

function _row(sourceId) {
  return db.get('SELECT * FROM source_health WHERE source_id = ?', [sourceId]);
}

function _later(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a >= b ? a : b; // ISO-8601 UTC strings order lexically
}

/**
 * Fold one event into the projection. Synchronous: it runs inside the
 * transaction that advances the consumer's offset.
 *
 * Every branch is order-tolerant — an older outcome arriving after a newer one
 * never rolls the state back — which is what keeps the projection right if two
 * runs of one source overlap.
 */
function applyEvent(ev) {
  const p = ev.payload;
  const sourceId = p.sourceId;
  if (typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId)) {
    throw new Error(`${ev.type} carries an unusable sourceId: ${JSON.stringify(sourceId)}`);
  }
  const at = ev.occurredAt;
  const cur = _row(sourceId) || {
    source_id: sourceId, state: 'unknown', freshness: 'unknown',
    last_attempt_at: null, last_success_at: null, last_failure_at: null, failure_detail: null,
    consecutive_failures: 0, expected_interval_ms: null, stale_after_ms: null, stale_since: null,
    last_detail: null, last_observed_at: null,
  };
  // A "never seen" stale verdict (Build 2B) is about a source with no row at
  // all. It changes nothing here — there is no success to be stale about, and
  // writing a row would turn "never heard from" into a known-but-unknown
  // source. Skipping is deterministic, so replay is unaffected.
  if (ev.type === 'source.sync.stale' && p.neverSeen === true && !_row(sourceId)) return;
  const next = { ...cur };
  const latestOutcome = _later(cur.last_success_at, cur.last_failure_at);

  switch (ev.type) {
    case 'source.sync.started':
      next.last_attempt_at = _later(cur.last_attempt_at, at);
      if (Number.isInteger(p.expectedIntervalMs) && p.expectedIntervalMs > 0) next.expected_interval_ms = p.expectedIntervalMs;
      if (Number.isInteger(p.staleAfterMs) && p.staleAfterMs > 0) next.stale_after_ms = p.staleAfterMs;
      break;

    case 'source.sync.succeeded':
      next.last_success_at = _later(cur.last_success_at, at);
      if (!latestOutcome || at >= latestOutcome) {
        next.state = 'healthy';
        next.consecutive_failures = 0;
        next.last_detail = p.detail === undefined ? null : JSON.stringify(p.detail);
      }
      // A success newer than the one the source went stale on makes it fresh.
      if (next.last_success_at === at) {
        next.freshness = 'fresh';
        next.stale_since = null;
      }
      break;

    case 'source.sync.failed':
      next.last_failure_at = _later(cur.last_failure_at, at);
      if (!latestOutcome || at >= latestOutcome) {
        next.state = 'failing';
        next.failure_detail = JSON.stringify({
          error: String(p.error).slice(0, 500),
          reason: p.reason || null,
          ambiguous: p.ambiguous === true,
        });
        next.consecutive_failures = (cur.consecutive_failures || 0) + 1;
      }
      break;

    case 'source.sync.stale':
      // ⚠ Only if it is about the basis we still hold. A stale verdict on a
      // success (or, for a push source, an observation) that has since been
      // superseded is out of date and changes nothing — otherwise a replay
      // would mark a fresh source stale.
      if (p.basis === 'observation') {
        if (cur.last_observed_at && p.lastObservedAt === cur.last_observed_at) {
          next.freshness = 'stale';
          next.stale_since = next.stale_since || at;
        }
      } else if (cur.last_success_at && p.lastSuccessAt === cur.last_success_at) {
        next.freshness = 'stale';
        next.stale_since = next.stale_since || at;
      }
      break;

    case 'source.observation.received': {
      // A push delivery (Build 2). TWO clocks, kept apart on purpose:
      //
      //  • the DELIVERY (receivedAt) is the outcome. It decides `state`, and is
      //    compared with failures on the same clock — a failed POST is stamped
      //    when it was refused, so ordering them by when the sensor observed
      //    something would let a draining queue roll a later failure back.
      //  • the newest OBSERVATION decides `freshness`. A phone emptying a
      //    six-hour-old queue delivered successfully and is still not telling
      //    NEURO anything current.
      const received = ev.receivedAt;
      const observed = p.newestObservedAt;
      next.last_attempt_at = _later(cur.last_attempt_at, received);
      next.last_success_at = _later(cur.last_success_at, received);
      if (!latestOutcome || received >= latestOutcome) {
        next.state = 'healthy';
        next.consecutive_failures = 0;
        next.last_detail = p.detail === undefined ? null : JSON.stringify(p.detail);
      }
      if (Number.isInteger(p.expectedIntervalMs) && p.expectedIntervalMs > 0) next.expected_interval_ms = p.expectedIntervalMs;
      if (Number.isInteger(p.staleAfterMs) && p.staleAfterMs > 0) next.stale_after_ms = p.staleAfterMs;
      if (typeof observed === 'string' && observed) {
        // Only something NEWER than what we hold makes it fresh. An older or
        // equal observation (a late chunk, a re-sent backlog) leaves a stale
        // verdict standing, because it adds nothing current.
        if (!cur.last_observed_at || observed > cur.last_observed_at) {
          next.last_observed_at = observed;
          next.freshness = 'fresh';
          next.stale_since = null;
        }
      }
      break;
    }

    default:
      return; // not ours; the consumer's type filter means this cannot happen
  }

  next.last_event_seq = ev.seq;
  next.updated_at = ev.receivedAt;
  db.run(
    `INSERT INTO source_health (source_id, state, freshness, last_attempt_at, last_success_at, last_failure_at,
       failure_detail, consecutive_failures, expected_interval_ms, stale_after_ms, stale_since, last_detail,
       last_event_seq, updated_at, last_observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id) DO UPDATE SET
       last_observed_at = excluded.last_observed_at,
       state = excluded.state, freshness = excluded.freshness, last_attempt_at = excluded.last_attempt_at,
       last_success_at = excluded.last_success_at, last_failure_at = excluded.last_failure_at,
       failure_detail = excluded.failure_detail, consecutive_failures = excluded.consecutive_failures,
       expected_interval_ms = excluded.expected_interval_ms, stale_after_ms = excluded.stale_after_ms,
       stale_since = excluded.stale_since, last_detail = excluded.last_detail,
       last_event_seq = excluded.last_event_seq, updated_at = excluded.updated_at`,
    [sourceId, next.state, next.freshness, next.last_attempt_at, next.last_success_at, next.last_failure_at,
      next.failure_detail, next.consecutive_failures, next.expected_interval_ms, next.stale_after_ms,
      next.stale_since, next.last_detail, next.last_event_seq, next.updated_at, next.last_observed_at || null]
  );
}

bus.registerConsumer({
  name: CONSUMER,
  types: TYPES,
  transactional: true,
  replayable: true, // writes only its own table; no external effect
  handle: applyEvent,
  reset: () => db.run('DELETE FROM source_health'),
});

// ── the publishing half ──────────────────────────────────────────────────────

function _safePublish(input) {
  try {
    return bus.publishEvent(input).event;
  } catch (e) {
    console.warn(`[SourceHealth] could not publish ${input && input.type}: ${e.message}`);
    return null;
  }
}

/**
 * Start one run of a source. Returns a handle with succeed / fail / publish.
 *
 *   sourceId          stable id, e.g. 'microsoft.calendar'
 *   system            the source system for the envelope, e.g. 'microsoft-graph'
 *   expectedIntervalMs / staleAfterMs   carried on the started event so the
 *                     projection never needs a config file to judge freshness
 *
 * ⚠ Never throws, and every method is a no-op returning null if publishing
 * fails. The ingestion path it wraps must behave exactly as it did before.
 */
function beginSourceRun(sourceId, opts = {}) {
  const runId = opts.runId || crypto.randomUUID();
  const correlationId = opts.correlationId || runId;
  const system = opts.system || sourceId.split('.')[0];
  const started = Date.now();
  let startedEvent = null;
  let finished = false;

  const base = (type, payload, extra = {}) => ({
    type,
    occurredAt: new Date(extra.at || Date.now()).toISOString(),
    source: { system, recordId: runId },
    subject: { entityType: 'source', entityId: sourceId },
    correlationId,
    causationId: startedEvent ? startedEvent.eventId : null,
    idempotencyKey: extra.key,
    payload,
  });

  if (!SOURCE_ID.test(sourceId)) {
    console.warn(`[SourceHealth] refusing unusable source id ${JSON.stringify(sourceId)}`);
  } else {
    const payload = { sourceId, runId };
    if (Number.isInteger(opts.expectedIntervalMs)) payload.expectedIntervalMs = opts.expectedIntervalMs;
    if (Number.isInteger(opts.staleAfterMs)) payload.staleAfterMs = opts.staleAfterMs;
    startedEvent = _safePublish(base('source.sync.started', payload, {
      key: `source-run:${sourceId}:${runId}:started`, at: started,
    }));
  }

  // ⚠ ONE outcome per run, enforced twice: locally, and by the two outcomes
  // sharing an idempotency key — so a run cannot be recorded as both.
  const outcome = (type, payload) => {
    if (finished || !startedEvent) return null;
    finished = true;
    return _safePublish(base(type, { sourceId, runId, durationMs: Date.now() - started, ...payload }, {
      key: `source-run:${sourceId}:${runId}:outcome`,
    }));
  };

  return {
    runId,
    correlationId,
    get startedEvent() { return startedEvent; },
    succeed(detail) {
      return outcome('source.sync.succeeded', detail === undefined ? {} : { detail });
    },
    fail(error, extra = {}) {
      const message = String((error && error.message) || error || 'unknown failure');
      return outcome('source.sync.failed', { error: message, ...extra });
    },
    /** A domain event belonging to this run: correlated to it, caused by its start. */
    publish(input) {
      if (!startedEvent) return null;
      return _safePublish({
        ...input,
        source: input.source || { system, recordId: runId },
        correlationId,
        causationId: startedEvent.eventId,
      });
    },
  };
}

// ── staleness ────────────────────────────────────────────────────────────────

/**
 * Decide which sources have gone stale, and RECORD it.
 *
 * A source is stale when its last success is older than the stale threshold
 * its own started events declared. One stale event per success: the key is the
 * success time, so a check every five minutes during a day-long outage still
 * writes one event, and the next success clears it.
 *
 * Returns the sources newly marked stale.
 */
async function checkStaleness(opts = {}) {
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : (typeof opts.now === 'number' ? opts.now : Date.now());
  // Judge the CURRENT projection, not one that is behind the log.
  await bus.pumpConsumer(CONSUMER, { now: nowMs });
  const marked = [];
  const rows = db.all(`SELECT * FROM source_health WHERE stale_after_ms IS NOT NULL
                       AND (last_success_at IS NOT NULL OR last_observed_at IS NOT NULL) AND freshness != 'stale'`);
  for (const r of rows) {
    // A push source is judged on its newest OBSERVATION; a pull source on its
    // last success, exactly as in Build 1 (same key, same payload).
    const byObservation = !!r.last_observed_at;
    const basis = byObservation ? r.last_observed_at : r.last_success_at;
    const ageMs = nowMs - Date.parse(basis);
    if (!(ageMs > r.stale_after_ms)) continue;
    const payload = { sourceId: r.source_id, lastSuccessAt: r.last_success_at, staleAfterMs: r.stale_after_ms, ageMs };
    if (byObservation) Object.assign(payload, { basis: 'observation', lastObservedAt: basis });
    const ev = _safePublish({
      type: 'source.sync.stale',
      occurredAt: new Date(nowMs).toISOString(),
      source: { system: 'neuro', recordId: r.source_id },
      subject: { entityType: 'source', entityId: r.source_id },
      idempotencyKey: byObservation
        ? `source-stale:${r.source_id}:obs:${basis}`
        : `source-stale:${r.source_id}:${r.last_success_at}`,
      payload,
    });
    if (ev) {
      marked.push(r.source_id);
      console.warn(`[SourceHealth] ${r.source_id} is STALE — last ${byObservation ? 'observation' : 'success'} ${Math.round(ageMs / 60000)} min ago (threshold ${Math.round(r.stale_after_ms / 60000)} min)`);
    }
  }
  if (marked.length) await bus.pumpConsumer(CONSUMER, { now: nowMs });
  return marked;
}

// ── reading ──────────────────────────────────────────────────────────────────

function _shape(r, nowMs) {
  const latestOutcome = _later(r.last_success_at, r.last_failure_at);
  return {
    sourceId: r.source_id,
    state: r.state,
    freshness: r.freshness,
    lastAttemptAt: r.last_attempt_at,
    lastSuccessAt: r.last_success_at,
    lastFailureAt: r.last_failure_at,
    failure: r.failure_detail ? JSON.parse(r.failure_detail) : null,
    consecutiveFailures: r.consecutive_failures,
    expectedIntervalMs: r.expected_interval_ms,
    staleAfterMs: r.stale_after_ms,
    staleSince: r.stale_since,
    lastDetail: r.last_detail ? JSON.parse(r.last_detail) : null,
    successAgeMs: r.last_success_at ? nowMs - Date.parse(r.last_success_at) : null,
    // Build 2: push sources. `freshnessBasis` says which clock freshness is
    // judged on, so a reader never compares a delivery time with a threshold
    // meant for an observation time.
    lastObservedAt: r.last_observed_at || null,
    observationAgeMs: r.last_observed_at ? nowMs - Date.parse(r.last_observed_at) : null,
    freshnessBasis: r.last_observed_at ? 'observation' : (r.last_success_at ? 'success' : null),
    // Started after the last outcome: a run in progress, or one that died
    // mid-way. Which of the two is for the stale check to say, not this flag.
    inProgress: !!(r.last_attempt_at && (!latestOutcome || r.last_attempt_at > latestOutcome)),
    lastEventSeq: r.last_event_seq,
  };
}

/**
 * The projection, plus whether it is caught up with the log. `current: false`
 * means events exist that it has not applied yet — read it as a little behind,
 * never as the whole truth.
 */
function getSourceHealth(opts = {}) {
  const nowMs = typeof opts.now === 'number' ? opts.now : Date.now();
  const status = bus.getStatus().consumers.find(c => c.name === CONSUMER) || null;
  const sources = db.all('SELECT * FROM source_health ORDER BY source_id').map(r => _shape(r, nowMs));
  return {
    projection: {
      consumer: CONSUMER,
      current: !!status && status.lag === 0 && status.retrying === 0,
      lag: status ? status.lag : null,
      retrying: status ? status.retrying : 0,
      deadLettered: status ? status.deadLettered : 0,
      lastProcessedAt: status ? status.lastProcessedAt : null,
    },
    sources,
  };
}

/** One source's health, or an explicit unknown — never null, never "healthy". */
function getSource(sourceId, opts = {}) {
  const r = _row(sourceId);
  if (!r) return { sourceId, state: 'unknown', freshness: 'unknown', known: false };
  return { ..._shape(r, typeof opts.now === 'number' ? opts.now : Date.now()), known: true };
}

module.exports = {
  CONSUMER,
  TYPES,
  applyEvent,
  beginSourceRun,
  checkStaleness,
  getSourceHealth,
  getSource,
};
