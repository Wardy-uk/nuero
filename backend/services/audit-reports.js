'use strict';

/**
 * Where vault-hygiene and PLAUD reconciliation reports live (22 Oct 2026, second
 * vault cleanup): in NEURO's database, NOT as dated notes in
 * `Documents/System/Vault Audit/`.
 *
 * Every run used to write a new dated page into the vault — 78 of them by the
 * first cleanup, read back by nothing, synced to every device and its backups,
 * and (once) carrying the start of a secret. A report is a record of what NEURO
 * did, so it belongs with NEURO's other records: one row per report in
 * `vault_audit_reports`, plus a `vault_audit_report` activity event, readable at
 * GET /api/vault-hygiene/reports[/:id] and on Brain Health.
 *
 * The callers keep returning a string where they used to return a vault path:
 * `neuro:vault-audit/<id>`. It names the report without pretending a file exists.
 *
 * Lazily creates its table on the first write; reads never create it.
 */

const KEEP_PER_KIND = 60; // older rows of the same kind are pruned on write

function _db() { return require('../db/database'); }

function _ensure() {
  _db().run(`CREATE TABLE IF NOT EXISTS vault_audit_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    markdown TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  _db().run('CREATE INDEX IF NOT EXISTS idx_vault_audit_reports_kind ON vault_audit_reports(kind, id)');
}

function _exists() {
  try { return !!_db().get("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'vault_audit_reports'"); } catch { return false; }
}

const ref = (id) => `neuro:vault-audit/${id}`;

/**
 * Store a report. Never throws: a report that cannot be stored must not fail the
 * run that produced it (the run's own changes and backups already happened).
 * Returns the reference string, or null when it could not be stored.
 */
function record({ kind, title, markdown }) {
  try {
    if (!kind || !title) throw new Error('kind and title are required');
    _ensure();
    // The same report title (it carries the date) REPLACES the earlier one, as
    // the dated vault file used to: Brain Health scans on every open, and a row
    // per open would be the vault noise moved into the database.
    const same = _db().get('SELECT id FROM vault_audit_reports WHERE kind = ? AND title = ? ORDER BY id DESC LIMIT 1', [String(kind), String(title)]);
    let id;
    if (same) {
      _db().run("UPDATE vault_audit_reports SET markdown = ?, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", [String(markdown || ''), same.id]);
      id = same.id;
    } else {
      _db().run('INSERT INTO vault_audit_reports (kind, title, markdown) VALUES (?, ?, ?)', [String(kind), String(title), String(markdown || '')]);
      const row = _db().get('SELECT id FROM vault_audit_reports WHERE kind = ? ORDER BY id DESC LIMIT 1', [String(kind)]);
      id = row && row.id;
    }
    try {
      _db().run(`DELETE FROM vault_audit_reports WHERE kind = ? AND id NOT IN (SELECT id FROM vault_audit_reports WHERE kind = ? ORDER BY id DESC LIMIT ${KEEP_PER_KIND})`, [String(kind), String(kind)]);
    } catch { /* pruning is housekeeping */ }
    if (!same) { try { _db().logActivity('vault_audit_report', { kind, title, id }); } catch { /* the row is the record */ } }
    return id ? ref(id) : null;
  } catch (e) {
    console.warn(`[AuditReports] could not store "${title}": ${e.message}`);
    return null;
  }
}

/** Newest first, without the bodies. */
function list({ kind = null, limit = 50 } = {}) {
  if (!_exists()) return [];
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  return kind
    ? _db().all('SELECT id, kind, title, created_at, length(markdown) AS bytes FROM vault_audit_reports WHERE kind = ? ORDER BY id DESC LIMIT ?', [kind, n])
    : _db().all('SELECT id, kind, title, created_at, length(markdown) AS bytes FROM vault_audit_reports ORDER BY id DESC LIMIT ?', [n]);
}

function get(id) {
  if (!_exists()) return null;
  return _db().get('SELECT id, kind, title, markdown, created_at FROM vault_audit_reports WHERE id = ?', [Number(id)]) || null;
}

module.exports = { record, list, get, ref, KEEP_PER_KIND };
