'use strict';

/**
 * Prepared-move RECORDS — durable, immutable, versioned (19 Oct 2026).
 *
 * A confirmation binds to a STORED packet version and the exact hash of the
 * writes one option would make — never to a server's memory. One row per
 * version; nothing is ever updated or deleted (SQLite triggers refuse both).
 * A changed packet for the same move is a NEW version, and only the latest
 * version of a move can be confirmed or executed, so a change invalidates any
 * confirmation minted for the old one.
 *
 * The table is created LAZILY by the first store() — nothing here runs at boot,
 * so a NEURO that never prepares a move has no table.
 *
 * Each row keeps the whole packet (evidence, freshness, authority, proposed
 * writes, verification plan) plus, per offered option, the write set's hash.
 */

const crypto = require('crypto');
const db = require('../db/database');

const CONTRACT = 'prepared-move-record-v1';
/** A record may be acted on for this long after the decision it came from. */
const EVIDENCE_LIFETIME_MS = 2 * 3600000;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

let _ready = false;
function ensure() {
  if (_ready) return;
  db.getDb().exec(`CREATE TABLE IF NOT EXISTS prepared_moves (
    id                   TEXT PRIMARY KEY,
    move_key             TEXT NOT NULL,
    version              INTEGER NOT NULL,
    contract             TEXT NOT NULL,
    packet_json          TEXT NOT NULL,
    packet_hash          TEXT NOT NULL,
    options_json         TEXT NOT NULL,
    decided_at           TEXT NOT NULL,
    evidence_expires_at  TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    UNIQUE (move_key, version)
  )`);
  db.getDb().exec(`CREATE TRIGGER IF NOT EXISTS prepared_moves_no_update BEFORE UPDATE ON prepared_moves
           BEGIN SELECT RAISE(ABORT, 'prepared_moves rows are immutable — store a new version'); END`);
  db.getDb().exec(`CREATE TRIGGER IF NOT EXISTS prepared_moves_no_delete BEFORE DELETE ON prepared_moves
           BEGIN SELECT RAISE(ABORT, 'prepared_moves rows are never deleted'); END`);
  _ready = true;
}

function _exists() {
  try { return Boolean(db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='prepared_moves'`)); } catch { return false; }
}

function _shape(r) {
  if (!r) return null;
  return {
    id: r.id, moveKey: r.move_key, version: r.version, contract: r.contract,
    packet: JSON.parse(r.packet_json), packetHash: r.packet_hash,
    options: JSON.parse(r.options_json),
    decidedAt: r.decided_at, evidenceExpiresAt: r.evidence_expires_at, createdAt: r.created_at,
  };
}

/** What identifies the packet's substance — everything a confirmation relies on. */
function packetHash(packet) {
  const s = packet.selected || {};
  // v2 (21 Oct 2026): versioned on SUBSTANCE only — the evidence, the draft, the
  // writes, the questions — never on when it was decided, so a scan that finds
  // the same proposal again refreshes its check stamp instead of minting a new
  // version (and a new confirmation) every half hour.
  if (packet.contract === 'prepared-move-v2') {
    return sha(JSON.stringify({
      contract: packet.contract, moveKey: s.moveKey, plan: s.plan, evidenceHash: s.evidenceHash || null,
      screens: s.screens || null, decision: s.decision || null,
      draft: ((s.preparation || []).find((p) => p.draft) || {}).draft || null,
      ask: s.ask || null, deliverable: s.deliverable || null,
    }));
  }
  return sha(JSON.stringify({
    decidedAt: (packet.decision || {}).decidedAt || null,
    record: s.record || null,
    screens: s.screens || null,
    decision: s.decision || null,
    draft: ((s.preparation || []).find((p) => p.draft) || {}).draft || null,
    authority: s.authority || null,
    verification: s.verification || null,
    observed: (s.observed || []).map((o) => [o.fact, o.source && o.source.ref]),
  }));
}

/**
 * Store a packet's prepared move as a new version — or return the latest one
 * unchanged if the packet is identical. Refuses a packet with no move.
 */
function store(packet, { now = Date.now() } = {}) {
  const exec = require('./prepared-move-exec');
  if (!packet || !packet.selected) return { ok: false, why: 'there is no prepared move in this packet' };
  const isAsk = packet.contract === 'prepared-move-v2' && packet.selected.plan === 'ask';
  // A question for Nick is stored too (so it can be shown and answered) — it
  // has no options, so nothing can ever be confirmed against it.
  const first = isAsk
    ? (packet.selected.moveKey && /^saim-move:v2:/.test(packet.selected.moveKey) && packet.selected.ask && (packet.selected.ask.questions || []).length ? { ok: true, moveKey: packet.selected.moveKey } : { ok: false, reasons: ['a question with nothing to ask'] })
    : exec.writesFor(packet, (packet.selected.decision.slots || [])[0] && packet.selected.decision.slots[0].id);
  if (!first.ok) return { ok: false, why: first.reasons.join(' ') };
  const options = {};
  for (const slot of isAsk ? [] : packet.selected.decision.slots || []) {
    const w = exec.writesFor(packet, slot.id);
    if (w.ok) options[slot.id] = { writeHash: w.writeHash, slot: { date: slot.date, start: slot.start, end: slot.end } };
  }
  const decidedAt = (packet.decision || {}).decidedAt;
  const decidedMs = Date.parse(decidedAt);
  if (!Number.isFinite(decidedMs)) return { ok: false, why: 'the packet has no decision time' };
  ensure();
  const hash = packetHash(packet);
  const latest = db.get(`SELECT * FROM prepared_moves WHERE move_key = ? ORDER BY version DESC LIMIT 1`, [first.moveKey]);
  if (latest && latest.packet_hash === hash) {
    if (packet.contract === 'prepared-move-v2') markChecked(latest.id, now);
    return { ok: true, created: false, record: get(latest.id) };
  }
  const version = latest ? latest.version + 1 : 1;
  const id = `pm_${crypto.randomBytes(10).toString('hex')}`;
  db.run(`INSERT INTO prepared_moves (id, move_key, version, contract, packet_json, packet_hash, options_json, decided_at, evidence_expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, first.moveKey, version, CONTRACT, JSON.stringify(packet), hash, JSON.stringify(options),
    new Date(decidedMs).toISOString(), new Date(decidedMs + EVIDENCE_LIFETIME_MS).toISOString(), new Date(now).toISOString()]);
  return { ok: true, created: true, record: get(id) };
}

// ── v2 side records (21 Oct 2026) ────────────────────────────────────────────
// The proposal rows stay immutable. What CHANGES about a proposal lives beside
// it: when it was last re-checked (so unchanged evidence keeps it fresh
// without a new version), Nick's responses (defer / decline / restore), and
// his answers to what SAiM asked. All append-only except the check stamp.

let _sideReady = false;
function ensureSide() {
  if (_sideReady) return;
  ensure();
  const d = db.getDb();
  d.exec(`CREATE TABLE IF NOT EXISTS prepared_move_checks (record_id TEXT PRIMARY KEY, checked_at TEXT NOT NULL)`);
  d.exec(`CREATE TABLE IF NOT EXISTS prepared_move_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT, move_key TEXT NOT NULL, record_id TEXT, version INTEGER,
    response TEXT NOT NULL CHECK (response IN ('defer', 'decline', 'restore')),
    reason TEXT, until TEXT, by TEXT NOT NULL, at TEXT NOT NULL)`);
  d.exec(`CREATE TABLE IF NOT EXISTS prepared_move_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, move_key TEXT NOT NULL, record_id TEXT, version INTEGER,
    question_id TEXT NOT NULL, text TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL)`);
  for (const t of ['prepared_move_responses', 'prepared_move_answers']) {
    d.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END`);
    d.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END`);
  }
  _sideReady = true;
}
const _sideExists = () => { try { return Boolean(db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='prepared_move_checks'`)); } catch { return false; } };

/** A v2 proposal whose evidence was re-read and found unchanged at `now`. */
function markChecked(recordId, now = Date.now()) {
  if (!recordId) return;
  ensureSide();
  db.run(`INSERT INTO prepared_move_checks (record_id, checked_at) VALUES (?, ?) ON CONFLICT(record_id) DO UPDATE SET checked_at = excluded.checked_at`, [recordId, new Date(now).toISOString()]);
}

function _withCheck(rec) {
  if (!rec || rec.contract !== CONTRACT || !rec.packet || rec.packet.contract !== 'prepared-move-v2' || !_sideExists()) return rec;
  const c = db.get(`SELECT checked_at FROM prepared_move_checks WHERE record_id = ?`, [rec.id]);
  if (!c) return rec;
  const extended = Date.parse(c.checked_at) + EVIDENCE_LIFETIME_MS;
  return extended > Date.parse(rec.evidenceExpiresAt) ? { ...rec, checkedAt: c.checked_at, evidenceExpiresAt: new Date(extended).toISOString() } : { ...rec, checkedAt: c.checked_at };
}

/** Bounded defer choices — never an open-ended snooze. */
const DEFER_DAYS = Object.freeze([1, 3, 7]);
const DEFER_REASONS = Object.freeze(['not-now', 'waiting-on-someone', 'need-more-info', 'other']);
const DECLINE_REASONS = Object.freeze(['not-mine', 'already-done', 'not-useful', 'other']);

/**
 * Nick's response to a proposal. defer: hidden until `until` (1, 3 or 7 days),
 * with a reason; decline: never offered again for that SOURCE (that email,
 * that task, that meeting) — a different source is a different move; restore:
 * undoes either. Refused, never clamped.
 */
function respond({ recordId, version, response, reason = null, days = null, by = 'nick', now = Date.now() } = {}) {
  const rec = get(recordId);
  if (!rec) return { ok: false, code: 404, why: 'no such prepared move' };
  if (Number(version) !== rec.version) return { ok: false, code: 409, why: 'this move has changed since it was shown' };
  if (!['defer', 'decline', 'restore'].includes(response)) return { ok: false, code: 400, why: 'response must be defer, decline or restore' };
  let until = null;
  if (response === 'defer') {
    if (!DEFER_DAYS.includes(Number(days))) return { ok: false, code: 400, why: `days must be one of ${DEFER_DAYS.join(', ')}` };
    if (!DEFER_REASONS.includes(reason)) return { ok: false, code: 400, why: `reason must be one of ${DEFER_REASONS.join(', ')}` };
    until = new Date(now + Number(days) * 86400000).toISOString();
  }
  if (response === 'decline' && reason != null && !DECLINE_REASONS.includes(reason)) return { ok: false, code: 400, why: `reason must be one of ${DECLINE_REASONS.join(', ')}` };
  if (response === 'restore' && reason != null) return { ok: false, code: 400, why: 'restore takes no reason' };
  ensureSide();
  db.run(`INSERT INTO prepared_move_responses (move_key, record_id, version, response, reason, until, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [rec.moveKey, rec.id, rec.version, response, reason, until, String(by || 'nick').slice(0, 80), new Date(now).toISOString()]);
  return { ok: true, response, until, moveKey: rec.moveKey, suppression: suppression(rec.moveKey, now) };
}

/** What stands between a move and being offered: null, or { response, until, say }. */
function suppression(moveKey, now = Date.now()) {
  if (!moveKey || !_sideExists()) return null;
  const r = db.get(`SELECT response, reason, until, at FROM prepared_move_responses WHERE move_key = ? ORDER BY id DESC LIMIT 1`, [moveKey]);
  if (!r || r.response === 'restore') return null;
  if (r.response === 'decline') return { response: 'declined', reason: r.reason, at: r.at, say: 'You said no to this one, so SAiM won’t offer it again.' };
  if (Date.parse(r.until) > now) return { response: 'deferred', reason: r.reason, until: r.until, say: `You put this off until ${r.until.slice(0, 10)}.` };
  return null;
}

/** Nick's answer to one of SAiM's questions. Bounded, plain text, kept as his words. */
function addAnswer({ recordId, version, questionId, text, by = 'nick', now = Date.now() } = {}) {
  const rec = get(recordId);
  if (!rec) return { ok: false, code: 404, why: 'no such prepared move' };
  if (Number(version) !== rec.version) return { ok: false, code: 409, why: 'this move has changed since it was shown' };
  const qs = askedQuestions(rec);
  if (!qs.some((q) => q.id === questionId)) return { ok: false, code: 400, why: 'that is not a question this move asked' };
  const t = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!t) return { ok: false, code: 400, why: 'the answer is empty' };
  if (t.length > 1000) return { ok: false, code: 400, why: 'the answer must be at most 1000 characters' };
  ensureSide();
  db.run(`INSERT INTO prepared_move_answers (move_key, record_id, version, question_id, text, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [rec.moveKey, rec.id, rec.version, questionId, t, String(by || 'nick').slice(0, 80), new Date(now).toISOString()]);
  return { ok: true, record: rec };
}

/**
 * Withdraw an earlier answer (25 Oct 2026) — APPEND-ONLY: a `withdraw` row
 * naming the question, so the earlier answer is kept for the record and no
 * longer counts. Only a question this move's history actually answered.
 */
function withdrawAnswer({ moveKey, questionId, by = 'nick', now = Date.now() } = {}) {
  if (!moveKey || !/^[a-z]{1,20}$/.test(String(questionId || ''))) return { ok: false, code: 400, why: 'which answer to withdraw is required' };
  if (!_sideExists()) return { ok: true, already: true };
  const last = db.get(`SELECT id, record_id, version, question_id, text FROM prepared_move_answers WHERE move_key = ? AND (question_id = ? OR (question_id = 'withdraw' AND text = ?)) ORDER BY id DESC LIMIT 1`, [moveKey, questionId, questionId]);
  if (!last || last.question_id === 'withdraw') return { ok: true, already: true };
  db.run(`INSERT INTO prepared_move_answers (move_key, record_id, version, question_id, text, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [moveKey, last.record_id, last.version, 'withdraw', questionId, String(by || 'nick').slice(0, 80), new Date(now).toISOString()]);
  return { ok: true, withdrawn: { questionId, text: last.text } };
}

/** The questions a stored move is asking: its ask, or (a private draft) its interview's. */
function askedQuestions(rec) {
  const s = (rec && rec.packet && rec.packet.selected) || {};
  return [...((s.ask || {}).questions || []), ...((s.interview || {}).questions || [])];
}

/**
 * Park an interview question (26 Oct 2026) — Nick's explicit "not now".
 * APPEND-ONLY: a `park` row naming the question, by whom and when; the draft
 * then states it is unresolved. Answering it later un-parks it (latest wins).
 */
function parkQuestion({ recordId, version, questionId, by = 'nick', now = Date.now() } = {}) {
  const rec = get(recordId);
  if (!rec) return { ok: false, code: 404, why: 'no such prepared move' };
  if (Number(version) !== rec.version) return { ok: false, code: 409, why: 'this move has changed since it was shown' };
  const q = (((rec.packet.selected || {}).interview || {}).questions || []).find((x) => x.id === questionId);
  if (!q) return { ok: false, code: 400, why: 'that is not a question this draft is asking' };
  if (q.state === 'parked') return { ok: true, already: true, record: rec };
  ensureSide();
  db.run(`INSERT INTO prepared_move_answers (move_key, record_id, version, question_id, text, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [rec.moveKey, rec.id, rec.version, 'park', questionId, String(by || 'nick').slice(0, 80), new Date(now).toISOString()]);
  return { ok: true, record: rec };
}

function answersFor(moveKey) {
  if (!moveKey || !_sideExists()) return [];
  return db.all(`SELECT question_id, text, by, at FROM prepared_move_answers WHERE move_key = ? ORDER BY id`, [moveKey]).map((r) => ({ questionId: r.question_id, text: r.text, by: r.by, at: r.at }));
}

/** Was this move carried out — a COMPLETE receipt on record? Read only. */
function completedMove(moveKey) {
  if (!moveKey) return false;
  try { const r = JSON.parse(db.getState(`saim_move_receipt:${moveKey}`) || 'null'); return Boolean(r && r.complete === true && r.target !== 'sandbox'); } catch { return false; }
}

/**
 * Is this move's private review/work block BOOKED? (24 Oct 2026) Only when a
 * LIVE confirm wrote the calendar block AND read it back — the receipt's
 * calendar step is `done` or `already-done` (prepared-move-exec writes those
 * statuses only after the read-back matched, and the external-write ledger
 * holds the same step). A proposed or suggested slot is NOT scheduled; a
 * sandbox (practice) run is not; a failed, unverified or removed block is not.
 * → { date, start, end } | null. Read only.
 */
const CAL_TARGET = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})–(\d{2}:\d{2})/;
function scheduledFor(moveKey) {
  if (!moveKey) return null;
  let r;
  try { r = JSON.parse(db.getState(`saim_move_receipt:${moveKey}`) || 'null'); } catch { return null; }
  if (!r || r.target === 'sandbox') return null;
  const cal = (r.steps || []).find((x) => x && x.step === 'calendar' && (x.status === 'done' || x.status === 'already-done'));
  if (!cal) return null;
  const m = CAL_TARGET.exec(String(cal.target || ''));
  return m ? { date: m[1], start: m[2], end: m[3], at: r.at } : { date: null, start: null, end: null, at: r.at };
}

/** PURE. Does a stored v2 proposal need a private review/work block to finish? */
function needsBlock(record) {
  const s = record && record.packet && record.packet.selected;
  return Boolean(s && s.plan === 'draft' && ((s.decision || {}).proposedWrites || []).some((w) => w.kind === 'calendar.solo'));
}

/**
 * The v2 proposals that could be shown now: each move's NEWEST version, not
 * deferred or declined, evidence still within its lifetime, newest check first.
 */
function activeV2({ now = Date.now(), limit = 5 } = {}) {
  if (!_exists()) return [];
  const rows = db.all(`SELECT m.* FROM prepared_moves m JOIN (SELECT move_key, MAX(version) v FROM prepared_moves WHERE move_key LIKE 'saim-move:v2:%' GROUP BY move_key) x ON x.move_key = m.move_key AND x.v = m.version ORDER BY m.created_at DESC LIMIT 50`);
  return rows.map(_shape).map(_withCheck)
    .filter((r) => !suppression(r.moveKey, now) && !completedMove(r.moveKey) && Date.parse(r.evidenceExpiresAt) > now)
    .sort((a, b) => Date.parse(b.checkedAt || b.createdAt) - Date.parse(a.checkedAt || a.createdAt))
    .slice(0, limit);
}

function get(id) {
  if (!_exists()) return null;
  return _withCheck(_shape(db.get(`SELECT * FROM prepared_moves WHERE id = ?`, [id])));
}

function latest(moveKey) {
  if (!_exists()) return null;
  return _withCheck(_shape(db.get(`SELECT * FROM prepared_moves WHERE move_key = ? ORDER BY version DESC LIMIT 1`, [moveKey])));
}

/** Is this record the move's newest version? An older one can never be confirmed or run. */
function isLatest(record) {
  const l = record && latest(record.moveKey);
  return Boolean(l && l.id === record.id);
}

module.exports = { withdrawAnswer, parkQuestion, askedQuestions,
  CONTRACT, EVIDENCE_LIFETIME_MS, ensure, store, get, latest, isLatest, packetHash,
  markChecked, respond, suppression, addAnswer, answersFor, activeV2, completedMove, scheduledFor, needsBlock, DEFER_DAYS, DEFER_REASONS, DECLINE_REASONS,
};
