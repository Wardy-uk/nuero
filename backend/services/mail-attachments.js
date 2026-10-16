'use strict';

/**
 * Files attached to an email NEURO sends for Nick (16 Oct 2026).
 *
 * The bytes live HERE, content-addressed by SHA-256 — never in the prepared
 * action's payload, which is read by every screen that lists actions. The
 * draft carries only { sha256, name, contentType, size }, and payloadHash
 * binds that list, so an approval names the exact bytes: swapping a file
 * changes its hash, the recomputed payload hash and the approval no longer
 * matches. The executor loads the bytes by hash and re-hashes them before
 * anything is sent.
 *
 * Limits are the smaller of what Microsoft and the personal SMTP servers take
 * once base64 has added its third: 10 files, 20 MB in all.
 *
 * ⚠ Nothing here logs a file name or content. Hashes and sizes only.
 */

const crypto = require('crypto');

function _db() { return require('../db/database'); }

const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const RETAIN_DAYS = 14;
// Refused by name rather than left for Exchange or Gmail to bounce later.
const BLOCKED_EXT = new Set(['exe', 'bat', 'cmd', 'com', 'scr', 'msi', 'vbs', 'vbe', 'js', 'jse', 'ws', 'wsf', 'ps1', 'jar', 'cpl', 'hta', 'pif', 'lnk', 'reg']);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** A safe display name: no path, no control characters, bounded. */
function cleanName(name) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '').trim();
  if (!base || base === '.' || base === '..') return null;
  if (base.length <= 150) return base;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 && base.length - dot <= 12 ? base.slice(dot) : '';
  return base.slice(0, 150 - ext.length) + ext;
}

const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };
const cleanType = (t) => (/^[\w.+-]+\/[\w.+-]+$/.test(String(t || '')) ? String(t).toLowerCase() : 'application/octet-stream');

/**
 * Check uploads before anything is stored. PURE.
 * `uploads`: [{ name, contentType, dataBase64 }]. Returns
 * { ok, files: [{ name, contentType, buf }] } or { ok:false, error }.
 * Omitted / empty is a valid "no attachments".
 */
function validate(uploads) {
  if (uploads === undefined || uploads === null) return { ok: true, files: [] };
  if (!Array.isArray(uploads)) return { ok: false, error: 'attachments must be a list' };
  if (uploads.length > MAX_FILES) return { ok: false, error: `at most ${MAX_FILES} attachments` };
  const files = [];
  let total = 0;
  for (const u of uploads) {
    const name = cleanName(u && u.name);
    if (!name) return { ok: false, error: 'an attachment has no usable file name' };
    if (BLOCKED_EXT.has(extOf(name))) return { ok: false, error: `"${name}" is a program or script — mail servers refuse those, so it was not attached` };
    const b64 = String((u && u.dataBase64) || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { ok: false, error: `"${name}" could not be read` };
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return { ok: false, error: `"${name}" is empty` };
    total += buf.length;
    if (total > MAX_TOTAL_BYTES) return { ok: false, error: `attachments may total at most ${MAX_TOTAL_BYTES / 1024 / 1024} MB` };
    files.push({ name, contentType: cleanType(u.contentType), buf });
  }
  return { ok: true, files };
}

/**
 * Store validated files and return the references the draft carries.
 * Identical bytes are stored once.
 */
function store(files, { now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  const refs = [];
  for (const f of files || []) {
    const hash = sha256(f.buf);
    _db().run(`INSERT INTO mail_attachments (sha256, size, content, created_at) VALUES (?, ?, ?, ?)
               ON CONFLICT(sha256) DO UPDATE SET created_at = excluded.created_at`, [hash, f.buf.length, f.buf, at]);
    refs.push({ sha256: hash, name: f.name, contentType: f.contentType, size: f.buf.length });
  }
  try { prune({ now }); } catch (e) { console.warn(`[MailAttachments] prune failed: ${e.message}`); }
  return refs;
}

/** validate + store in one. Returns { ok, refs } or { ok:false, error }. */
function accept(uploads, opts) {
  const v = validate(uploads);
  if (!v.ok) return v;
  return { ok: true, refs: store(v.files, opts) };
}

/**
 * The bytes for a reference, re-hashed. null when missing or when the stored
 * bytes no longer match — never a "close enough" file.
 */
function load(ref) {
  if (!ref || !/^[0-9a-f]{64}$/.test(String(ref.sha256 || ''))) return null;
  const row = _db().get('SELECT content FROM mail_attachments WHERE sha256 = ?', [ref.sha256]);
  if (!row || !row.content) return null;
  const buf = Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
  return sha256(buf) === ref.sha256 ? buf : null;
}

/**
 * Drop bytes older than RETAIN_DAYS that no live action still needs. A sent
 * email's copy is in the mailbox's Sent folder; NEURO does not keep a second.
 */
function prune({ now = Date.now() } = {}) {
  const cutoff = new Date(now - RETAIN_DAYS * 86400000).toISOString();
  const old = _db().all('SELECT sha256 FROM mail_attachments WHERE created_at < ?', [cutoff]);
  let removed = 0;
  for (const { sha256: h } of old) {
    const live = _db().get(`SELECT 1 FROM prepared_actions WHERE status IN ('prepared','approved','executing','execution_uncertain','executed')
                            AND draft_json LIKE ? LIMIT 1`, [`%${h}%`]);
    if (live) continue;
    _db().run('DELETE FROM mail_attachments WHERE sha256 = ?', [h]);
    removed += 1;
  }
  return removed;
}

module.exports = { validate, store, accept, load, prune, cleanName, MAX_FILES, MAX_TOTAL_BYTES, BLOCKED_EXT };
