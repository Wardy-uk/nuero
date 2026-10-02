'use strict';

/**
 * The registered event types — the vocabulary of the nervous system.
 *
 * ⚠ AN UNREGISTERED TYPE IS REFUSED, NOT STORED. A log anyone can write any
 * string into is an activity feed, which is what NEURO already had (several of
 * them) and what the gap analysis scored 1/5. "Typed" means a consumer can rely
 * on what a type promises: its payload carries these keys, at this version, with
 * this provenance unless told otherwise.
 *
 * Adding a type is one entry here. Changing what a type's payload MEANS is a new
 * `version`, never an edit in place: events already in the log were written
 * against the old meaning and are immutable, so a consumer must be able to tell
 * which one it is reading (`schemaVersion` on the envelope is the envelope's
 * version; `version` here is the payload's).
 *
 * Naming: `<domain>.<noun>.<past-tense verb>` — an event is a fact about
 * something that already happened, never a command.
 */

const TYPES = Object.freeze({
  // ── Source health: is each source actually working? ────────────────────────
  // One run of a source = started, then exactly ONE of succeeded / failed (the
  // two share an idempotency key per run, so a second outcome folds into the
  // first rather than contradicting it).
  'source.sync.started': {
    version: 1,
    provenance: 'observation',
    required: ['sourceId', 'runId'],
    // expectedIntervalMs / staleAfterMs ride on this event so the SourceHealth
    // projection can be rebuilt from the log alone, with no config to consult.
  },
  'source.sync.succeeded': {
    version: 1,
    provenance: 'observation',
    required: ['sourceId', 'runId'],
  },
  'source.sync.failed': {
    version: 1,
    provenance: 'observation',
    required: ['sourceId', 'runId', 'error'],
  },
  // NEURO concluding that no success has arrived in time. An INFERENCE — it is
  // drawn from the absence of an event plus the clock — and recorded as an event
  // precisely so a replay reproduces it rather than re-deciding it against a
  // different "now".
  'source.sync.stale': {
    version: 1,
    provenance: 'inference',
    required: ['sourceId', 'lastSuccessAt', 'staleAfterMs'],
  },

  // A PUSH source delivered observations (Build 2). Push sources — the phone
  // apps — have no "run": nothing on the server starts them, so a fake
  // `source.sync.started` would be a story told about a session that never
  // existed. This is the honest equivalent: "client X delivered, and the newest
  // thing it had observed was at T". `occurredAt` IS that newest observation
  // time, so freshness is judged on what the sensor saw, not on when its queue
  // happened to drain. Carries expectedIntervalMs / staleAfterMs for the same
  // reason the started event does: the projection needs no config to rebuild.
  //
  // A failed delivery is `source.sync.failed` with `runId` = the delivery id.
  'source.observation.received': {
    version: 1,
    provenance: 'observation',
    required: ['sourceId', 'deliveryId', 'newestObservedAt'],
  },

  // ── Domain observations ────────────────────────────────────────────────────

  // Native sensing (Build 2). Small on purpose: one type per thing observed,
  // never one per metric or per field.
  //
  // The newest NEWLY-STORED HealthKit sample of one metric in one delivery —
  // NOT every sample. Health arrives at ~1,000–1,400 samples a day and the log
  // is undeletable by design; health_samples stays the store of record, and
  // this is the change notification the world model is projected from. Keyed
  // on the sample's own HealthKit UUID, so the same sample arriving from both
  // apps (each keeps its own anchors and re-sends) is ONE event.
  'observation.health.recorded': {
    version: 1,
    provenance: 'observation',
    required: ['metric', 'value', 'observedAt'],
  },
  // A device self-report (battery, motion activity, connectivity, steps).
  // ⚠ Never carries the SSID or a geocoded place name — those stay in
  // device_status, which can be cleared; this log cannot.
  'observation.device.updated': {
    version: 1,
    provenance: 'observation',
    required: ['deviceId', 'observedAt'],
  },
  // The newest position fix in a delivery — WHEN and HOW ACCURATE, never WHERE.
  // Coordinates stay in location_points. The world model needs "when did NEURO
  // last know where he was, and from which device"; an immutable record of his
  // movements is a different thing that nobody asked for.
  'observation.location.recorded': {
    version: 1,
    provenance: 'observation',
    required: ['deviceId', 'observedAt'],
  },
  // What the Graph calendar window looked like on a successful sync. Keyed on a
  // fingerprint of the window's content, so re-observing an unchanged diary
  // folds into the existing event: the log records CHANGE, not polling.
  'observation.calendar.window_synced': {
    version: 1,
    provenance: 'observation',
    required: ['window', 'count', 'fingerprint'],
  },
});

const PROVENANCE_KINDS = Object.freeze(['fact', 'observation', 'inference']);

function getType(type) {
  return Object.prototype.hasOwnProperty.call(TYPES, type) ? TYPES[type] : null;
}

function listTypes() {
  return Object.keys(TYPES);
}

module.exports = { TYPES, PROVENANCE_KINDS, getType, listTypes };
