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

  // A push source's newest observation is old, BUT the app that sends it is
  // demonstrably alive on another channel (Build 3B). For a significant-change
  // sensor that is the normal shape of a day spent in one place: the fix is
  // old because he has not moved, not because the sensor is blind. An
  // INFERENCE, recorded once per transition for the same reason staleness is
  // — a replay must reproduce it, not re-judge it against a different "now".
  'source.observation.quiet': {
    version: 1,
    provenance: 'inference',
    required: ['sourceId', 'lastObservedAt', 'transportAliveAt', 'transportSourceId'],
  },
  // Whether NEURO should EXPECT to hear from a source (Build 3B): expected |
  // optional | retired. A declaration, not an observation — recorded in the log
  // so source health and source blindness read retirement from the same place
  // they read everything else, and a replay reproduces it. Retiring a source
  // deletes nothing: its history stays and remains queryable.
  'source.lifecycle.changed': {
    version: 1,
    provenance: 'fact',
    required: ['sourceId', 'lifecycle'],
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

  // ── Runtime (Build 3A): scheduled work that did NOT happen ─────────────────
  // Only the two outcomes worth an immutable record. Routine successes live in
  // runtime_job_runs, not here — hundreds a day of "the timer worked" would be
  // noise in a log nothing can delete.
  //
  // A run that failed for good: every attempt used.
  'runtime.job.failed': {
    version: 1,
    provenance: 'observation',
    required: ['job', 'runId', 'scheduledFor', 'attempts', 'error'],
  },
  // A due run that was deliberately NOT run: too late to be worth running
  // (`stale`), or one of many slots lost to an outage longer than the lookback
  // (`gap`). Superseded slots are not recorded here — a newer run covered them.
  'runtime.job.skipped': {
    version: 1,
    provenance: 'observation',
    required: ['job', 'runId', 'scheduledFor', 'reason'],
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
  // ── The world model (Build 3C) ─────────────────────────────────────────────
  //
  // ONE calendar entry as a source showed it — subject, times, status and the
  // attendee list. Keyed on a fingerprint of that content, so an unchanged
  // meeting re-observed every twenty minutes FOLDS: the log records change,
  // not polling (the window_synced rule, one level down).
  //
  // ⚠ A deliberate privacy decision, written down: unlike location (no
  // coordinates, ever), a meeting's subject and its attendees' names and
  // addresses DO enter the log, because "who is in the 14:00 and what is it
  // about" is the fact the world model exists to hold — and calendar_history
  // already keeps the same content permanently. What stays out: the body, the
  // join link (it carries tokens), free-text notes.
  'observation.calendar.event_observed': {
    version: 1,
    provenance: 'observation',
    required: ['provider', 'providerEventId', 'title', 'start', 'end', 'fingerprint'],
  },
  // A calendar entry that a source previously showed inside its sync window
  // and no longer does — cancelled and deleted, or moved out of the window.
  // The source cannot say which, so neither does this.
  'observation.calendar.event_removed': {
    version: 1,
    provenance: 'observation',
    required: ['provider', 'providerEventId', 'lastFingerprint'],
  },
  // A person as Nick's own vault declares them (People/<name>.md): name,
  // addresses, aliases and only the relationship fields the note states
  // EXPLICITLY. A FACT — it is his own record — keyed on its content so an
  // unchanged note folds. Nothing is inferred about anyone.
  'observation.person.declared': {
    version: 1,
    provenance: 'fact',
    required: ['personId', 'displayName', 'emails', 'notePath', 'fingerprint'],
  },

  // ── Obligations (Build 4B) ─────────────────────────────────────────────────
  //
  // ONE task record as the store that OWNS it holds it right now: NEURO's own
  // `tasks` table, or a Microsoft Planner / To Do task as Graph returned it.
  // A FACT: each system is the authority on its own records (a tick in NEURO
  // is Nick's statement; `completedDateTime` from Planner is Microsoft's).
  // Keyed on a fingerprint of that state, so a reconcile pass that finds
  // nothing changed folds — the log records change, not polling. Transitions
  // (created / completed / reopened) are DERIVED by the projector from
  // consecutive observations and kept in wm_obligation_history, so a change is
  // one fact in the log, not two.
  'observation.task.observed': {
    version: 1,
    provenance: 'fact',
    required: ['system', 'recordId', 'title', 'status', 'fingerprint'],
  },
  // A task a source held and, on a COMPLETE read, no longer does. The source
  // cannot say whether it was completed or deleted (To Do only ever lists open
  // tasks), so neither does this — it never means "completed".
  'observation.task.removed': {
    version: 1,
    provenance: 'observation',
    required: ['system', 'recordId', 'lastFingerprint'],
  },
  // An obligation one person took on, as a store derived from Nick's notes
  // records it — today the waiting_on table (what somebody else said they
  // would do, extracted from a meeting write-up). An OBSERVATION: it is a
  // parse of a note, not the promisor's own record.
  'observation.commitment.observed': {
    version: 1,
    provenance: 'observation',
    required: ['system', 'recordId', 'description', 'status', 'fingerprint'],
  },
  // Build 5D: one thing NEURO SAW that bears on whether a commitment moved — an
  // email Nick sent to its counterparty about it, or a later note line that
  // matches it — with the exact rule that matched. An OBSERVATION, never a
  // completion: `likely_fulfilled` is derived from these at read time and
  // never changes a commitment's status. Sent mail enters as metadata only
  // (subject, one recipient, time), and only when it matched a commitment.
  'observation.progress.evidence': {
    version: 1,
    provenance: 'observation',
    required: ['commitmentId', 'kind', 'ref', 'at', 'polarity', 'strength', 'fingerprint'],
  },

  // What the Graph calendar window looked like on a successful sync. Keyed on a
  // fingerprint of the window's content, so re-observing an unchanged diary
  // folds into the existing event: the log records CHANGE, not polling.
  'observation.calendar.window_synced': {
    version: 1,
    provenance: 'observation',
    required: ['window', 'count', 'fingerprint'],
  },

  // ── Build 6: the lifecycle of a governed action ────────────────────────────
  // Facts about NEURO's own acts and Nick's decisions on them. ⚠ REFERENCES
  // ONLY: action id, type, version, the target's PERSON id, a short hash of the
  // provider message id. Never the recipient address, the subject or the body —
  // the log is immutable, and a message's words belong in the one row Nick
  // approved, not in an undeletable stream. One event per transition, keyed
  // `action:<id>:<status>`, so a repeated transition folds.
  ...Object.fromEntries([
    'action.prepared', 'action.approved', 'action.rejected', 'action.superseded',
    'action.execution.started', 'action.execution.uncertain', 'action.executed',
    'action.verified', 'action.failed', 'action.expired', 'action.cancelled',
  ].map((t) => [t, { version: 1, provenance: 'fact', required: ['actionId', 'actionType', 'version'] }])),

  // ── Build 7: the human-approval code ───────────────────────────────────────
  // WHEN Nick's approval code was set or replaced — never the code or its hash.
  // The only defence against someone with a shell on the Pi quietly setting a
  // code of their own is that the change is visible; this is that record.
  'action.approval_code.set': {
    version: 1,
    provenance: 'fact',
    required: ['setAt', 'replaced'],
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
