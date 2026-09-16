'use strict';

/**
 * What Nick has DECIDED about a carried commitment, recorded the moment he says it.
 *
 * ⚠ Before this (16 Sep 2026), a `resolve_commitment` decision lived in the
 * SESSION and nowhere else. The only durable trace was a `## Decided` line the
 * morning note rendered at finish — and nothing ever read that section back.
 * Carry-forwards are rebuilt from daily-note checkbox lines over a 14-day
 * window, so an item marked "already done" on 11 Sep and AGAIN on 14 Sep was
 * still open on 16 Sep: its newest READABLE mention was an unticked line from
 * 11 Sep. The EOD was worse: its renderer ignored decisions entirely, so the
 * standup could tell Nick something was "cleared" and write nothing at all.
 *
 * So a closing decision is written here immediately, by the tool that records
 * it — not at finish, because a session that is never finished still held a
 * real decision. `standup-accountability` reads it as one of the closure
 * sources, and that function is the ONE answer to "is this commitment live".
 *
 * KV rather than a table, following the session store: one small bounded
 * document, and a migration on the live DB buys nothing here.
 */

const STATE_KEY = 'standup_commitment_resolutions';
// Only decisions that END a carry. `today` and `carry` keep it live.
const CLOSING = new Set(['done', 'dropped', 'scheduled']);
// Carry-forwards look back 14 days; 60 keeps every decision that could still
// matter with room to spare, and stops the document growing for ever.
const RETAIN_DAYS = 60;
const MAX_ENTRIES = 500;

function _db() { return require('../db/database'); }

/**
 * Read the ledger. An unreadable store returns [] — which means "nothing is
 * closed by the ledger", so a failure shows Nick an item again rather than
 * hiding one. That is the visible direction, and the right one to fail in.
 */
function list() {
  try {
    const raw = _db().getState(STATE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(e => e && e.key && e.date && CLOSING.has(e.decision)) : [];
  } catch (e) {
    console.warn('[CommitmentLedger] Unreadable, treating as empty:', e.message);
    return [];
  }
}

function _write(entries, today) {
  const cutoff = new Date(`${today}T00:00:00`);
  cutoff.setDate(cutoff.getDate() - RETAIN_DAYS);
  const cut = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
  const kept = entries.filter(e => e.date >= cut).slice(-MAX_ENTRIES);
  _db().setState(STATE_KEY, JSON.stringify(kept));
}

/**
 * Record a decision about `key` made on `date`. A closing decision is stored
 * (replacing any earlier one for that key on that date); a non-closing one
 * REMOVES that day's closing entry, because changing your mind in the same
 * conversation ("actually no, I'm doing it today") must not leave it closed.
 */
function record({ key, text = null, decision, date, taskId = null, source = 'standup' }) {
  if (!key || !date || !decision) return false;
  const entries = list().filter(e => !(e.key === key && e.date === date));
  if (CLOSING.has(decision)) {
    entries.push({ key, text, decision, date, taskId: taskId || null, source, at: new Date().toISOString() });
  }
  _write(entries, date);
  return true;
}

module.exports = { list, record, CLOSING, STATE_KEY };
