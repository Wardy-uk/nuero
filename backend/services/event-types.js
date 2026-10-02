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

  // ── Domain observations ────────────────────────────────────────────────────
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
