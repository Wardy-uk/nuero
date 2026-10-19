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
  const first = exec.writesFor(packet, (packet.selected.decision.slots || [])[0] && packet.selected.decision.slots[0].id);
  if (!first.ok) return { ok: false, why: first.reasons.join(' ') };
  const options = {};
  for (const slot of packet.selected.decision.slots || []) {
    const w = exec.writesFor(packet, slot.id);
    if (w.ok) options[slot.id] = { writeHash: w.writeHash, slot: { date: slot.date, start: slot.start, end: slot.end } };
  }
  const decidedAt = (packet.decision || {}).decidedAt;
  const decidedMs = Date.parse(decidedAt);
  if (!Number.isFinite(decidedMs)) return { ok: false, why: 'the packet has no decision time' };
  ensure();
  const hash = packetHash(packet);
  const latest = db.get(`SELECT * FROM prepared_moves WHERE move_key = ? ORDER BY version DESC LIMIT 1`, [first.moveKey]);
  if (latest && latest.packet_hash === hash) return { ok: true, created: false, record: _shape(latest) };
  const version = latest ? latest.version + 1 : 1;
  const id = `pm_${crypto.randomBytes(10).toString('hex')}`;
  db.run(`INSERT INTO prepared_moves (id, move_key, version, contract, packet_json, packet_hash, options_json, decided_at, evidence_expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, first.moveKey, version, CONTRACT, JSON.stringify(packet), hash, JSON.stringify(options),
    new Date(decidedMs).toISOString(), new Date(decidedMs + EVIDENCE_LIFETIME_MS).toISOString(), new Date(now).toISOString()]);
  return { ok: true, created: true, record: get(id) };
}

function get(id) {
  if (!_exists()) return null;
  return _shape(db.get(`SELECT * FROM prepared_moves WHERE id = ?`, [id]));
}

function latest(moveKey) {
  if (!_exists()) return null;
  return _shape(db.get(`SELECT * FROM prepared_moves WHERE move_key = ? ORDER BY version DESC LIMIT 1`, [moveKey]));
}

/** Is this record the move's newest version? An older one can never be confirmed or run. */
function isLatest(record) {
  const l = record && latest(record.moveKey);
  return Boolean(l && l.id === record.id);
}

module.exports = { CONTRACT, EVIDENCE_LIFETIME_MS, ensure, store, get, latest, isLatest, packetHash };
