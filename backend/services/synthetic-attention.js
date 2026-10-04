'use strict';

/**
 * Synthetic P0 (Build 12.3K) — a safe test item that travels the REAL path.
 *
 * Proving the watch end to end needs something genuinely P0, and waiting for a
 * real escalation is not a test. Writing straight into the complication store
 * would prove the complication can draw a number and nothing else. So this
 * puts a candidate into decision-engine's pool — the same pool every real
 * escalation enters — and from there it is gated by attention, stamped by the
 * lifecycle, classified P0 by presentation-intent, counted in the P0 digest and
 * judged by the notification policy, exactly like the real thing.
 *
 * ⚠ IT CONTACTS NOTHING. No Jira, no Graph, no mail: the candidate is built
 *   from this module's own store. Its ticket key is `TEST-…`, which matches no
 *   project, and its title starts "Test —" on every surface.
 * ⚠ IT EXPIRES. A synthetic item that outlived its test would sit in "Needs
 *   you" claiming something is wrong. TTL is 15 minutes, capped at 60, and an
 *   expired entry is dropped on read, never resurrected.
 * ⚠ PIN ONLY. The route refuses the machine API token: a test that interrupts
 *   Nick's wrist is his to start.
 */

const KEY = 'synthetic_attention';
const KINDS = ['escalation', 'email'];
const DEFAULT_TTL_MIN = 15;
const MAX_TTL_MIN = 60;
const MAX_ACTIVE = 3;

function _db() { return require('../db/database'); }
function _read() {
  try { const v = _db().getState(KEY); const a = v ? JSON.parse(v) : []; return Array.isArray(a) ? a : []; } catch { return []; }
}
function _write(list) { _db().setState(KEY, JSON.stringify(list)); }

/** Live (unexpired) entries. PURE given a list and a clock. */
function live(list, now = Date.now()) {
  return (Array.isArray(list) ? list : []).filter((e) => e && Date.parse(e.expiresAt) > now);
}

function active({ now = Date.now() } = {}) { return live(_read(), now); }

function inject({ kind = 'escalation', ttlMinutes = DEFAULT_TTL_MIN } = {}, { now = Date.now() } = {}) {
  if (!KINDS.includes(kind)) throw Object.assign(new Error(`kind must be one of ${KINDS.join(', ')}`), { status: 400 });
  const ttl = Number(ttlMinutes);
  if (!Number.isFinite(ttl) || ttl <= 0) throw Object.assign(new Error('ttlMinutes must be a positive number'), { status: 400 });
  const list = live(_read(), now);
  if (list.length >= MAX_ACTIVE) throw Object.assign(new Error(`already ${MAX_ACTIVE} synthetic items live — clear one first`), { status: 409 });
  const id = `${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const entry = {
    id, kind,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.min(ttl, MAX_TTL_MIN) * 60000).toISOString(),
  };
  list.push(entry);
  _write(list);
  return entry;
}

function clear(id, { now = Date.now() } = {}) {
  const before = live(_read(), now);
  const after = id ? before.filter((e) => e.id !== id) : [];
  _write(after);
  return { cleared: before.length - after.length };
}

/** The pool candidates for live entries — decision-engine's shape. PURE. */
function candidates(list) {
  return list.map((e) => {
    const isEsc = e.kind === 'escalation';
    return {
      type: e.kind,
      id: `synthetic-${e.kind}-${e.id}`,
      title: isEsc ? `Test — TEST-${e.id}: synthetic escalation` : 'Test — synthetic urgent email',
      reason: 'A synthetic P0 for checking the watch. Nothing is wrong.',
      score: 99,
      urgency: 'critical',
      source: isEsc ? 'jira' : 'email',
      actionHint: 'Clear the test when done',
      // ⚠ NO `_unsuppressable` here, on purpose: decision-engine's own
      //   `_applyOverrides` marks every escalation-typed item unsuppressable,
      //   so the synthetic one meets the same day-off verdict as a real one
      //   (passes) and the synthetic email meets a real email's (held).
      meta: {
        synthetic: true,
        syntheticId: e.id,
        expiresAt: e.expiresAt,
        ...(isEsc ? { escalations: [{ key: `TEST-${e.id}`, summary: 'synthetic escalation' }], ticket_key: `TEST-${e.id}` } : { count: 1, emailId: null }),
      },
    };
  });
}

/** decision-engine's collector. Never throws into the pool. */
function collect({ now = Date.now() } = {}) {
  try { return candidates(active({ now })); } catch { return []; }
}

module.exports = { KEY, KINDS, DEFAULT_TTL_MIN, MAX_TTL_MIN, MAX_ACTIVE, live, active, inject, clear, candidates, collect };
