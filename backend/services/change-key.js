'use strict';

/**
 * Change keys for producers that observe a record over and over (Build 5B).
 *
 * A producer re-reads a source (a calendar window, a People note, a task row)
 * and publishes an observation only when something CHANGED. The idempotency key
 * is what makes a retry fold, and it is also what decides whether a real change
 * is recorded at all, so it has to name the CHANGE, not the state.
 *
 *   state key       `<record>:<fingerprint>`
 *                   A→B→A: the return to A reproduces A's key, folds into the
 *                   first event, and the projection is left at B. The move
 *                   back is lost and the world model is now wrong.
 *
 *   held-fp key     `<record>:<held fingerprint> > <new fingerprint>` (Build 4)
 *                   Fixes A→B→A, and has the same hole one step deeper:
 *                   A→B→A→B reproduces `A>B`, which folds into the FIRST A→B,
 *                   and the projection is left at A.
 *
 *   change key      `<record>:<event that established the held state> > <new fingerprint>`
 *                   Every state the record has ever been in was put there by a
 *                   distinct event, so every genuine transition has a distinct
 *                   key, at any depth. A retry of the SAME transition (same held
 *                   event, same new content) reproduces the key and folds.
 *
 * "Held" is read from the EVENT LOG, never from a projection: the producer then
 * sees its own previous publication immediately, whatever a consumer has or has
 * not applied yet, and a replay of the log reproduces every transition because
 * each one is its own event. receivedAt is never part of a key: a source's
 * identity, never the clock, decides what is the same thing.
 *
 * An unchanged record publishes NOTHING (isUnchanged), so polling an unchanged
 * source adds no events at all, not even folded ones.
 */

const db = require('../db/database');

/**
 * The newest event about one subject, among `types`. Returns
 * { eventId, type, fingerprint, removed } or null when nothing was ever said.
 * `removedTypes` names the types that mean "no longer present".
 */
function latest(subjectType, subjectId, types, removedTypes = []) {
  if (!subjectId || !Array.isArray(types) || !types.length) return null;
  let row;
  try {
    row = db.get(
      `SELECT event_id, type, payload FROM event_log
        WHERE subject_id = ? AND subject_type = ? AND type IN (${types.map(() => '?').join(', ')})
        ORDER BY seq DESC LIMIT 1`,
      [String(subjectId), String(subjectType), ...types]
    );
  } catch { return null; }
  if (!row) return null;
  let fp = null;
  try { fp = JSON.parse(row.payload).fingerprint || null; } catch { fp = null; }
  return { eventId: row.event_id, type: row.type, fingerprint: fp, removed: removedTypes.includes(row.type) };
}

/** True when the newest event already says exactly this. Nothing to publish. */
function isUnchanged(held, fingerprint) {
  return !!held && !held.removed && held.fingerprint === fingerprint;
}

/** The token for "what it was before": the event that established it, or `new`. */
function prevToken(held) { return held ? held.eventId : 'new'; }

/** `<prefix>:<record>:<prev event>><new fingerprint>` */
function observationKey(prefix, record, held, fingerprint) {
  return `${prefix}:${record}:${prevToken(held)}>${fingerprint}`.slice(0, 512);
}

/**
 * One removal per PRESENCE: keyed on the event that made the record present.
 * A record that comes back and goes again is a new presence (a new observed
 * event), so its second removal is a second fact.
 */
function removalKey(prefix, record, held) {
  return `${prefix}:${record}@${prevToken(held)}`.slice(0, 512);
}

module.exports = { latest, isUnchanged, prevToken, observationKey, removalKey };
