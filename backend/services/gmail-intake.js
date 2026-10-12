'use strict';

/**
 * Reading Gmail (12 Oct 2026): message coordinates, the live read for the detail
 * view and for preparing a reply, and mark-read. WHICH Gmail mail is shown is
 * personal-inbox + gmail-rule's job; this module only reads.
 *
 * ⚠ Bodies are read with BODY.PEEK (imapflow download) — reading never marks a
 *   message read. Only an explicit Mark read sets Seen.
 */

const pm = require('./personal-mail');

// The Gmail tab's cursor on Gmail's INBOX (personal-inbox owns the pass). The
// old Important-folder watermark ('gmail_important_watermark') is abandoned.
const WATERMARK_KEY = 'gmail_inbox_cursor';
const STATUS_KEY = 'gmail_intake_status';
const PREVIEW_CHARS = 300;
const BODY_MAX = 200 * 1024;
const ID_PREFIX = 'gmail:';

function _db() { return require('../db/database'); }
function _readJson(key) { try { const v = _db().getState(key); return v ? JSON.parse(v) : null; } catch { return null; } }

function isGmailId(id) { return typeof id === 'string' && id.startsWith(ID_PREFIX); }

// ⚠ READ-ONLY by construction: this module loads the IMAP library and NEVER
// personal-mail-transport / smtp-mail / nodemailer (pinned) — prepared-actions
// reads Gmail through it to prepare a reply, and preparing must import no sender.
function _withDefaults(deps) {
  return { now: () => Date.now(), imap: (cfg) => new (require('imapflow').ImapFlow)(cfg), ...(deps || {}) };
}

async function _open(deps) {
  const cred = pm.credentialFor('gmail');
  if (!cred) return { error: 'not-configured' };
  const c = deps.imap(pm.imapConfig('gmail', cred));
  if (typeof c.on === 'function') c.on('error', () => {});
  await c.connect();
  return { c, cred };
}

async function _close(c) { try { await c.logout(); } catch { try { c.close(); } catch { /* gone */ } } }

const _addr = (list) => (list || []).map((a) => ({ name: a.name || '', email: String(a.address || '').toLowerCase() })).filter((a) => a.email);

/** Find the text of a message: text/plain first, else text/html stripped. */
function textPartOf(node) {
  const parts = [];
  const walk = (n) => {
    if (!n) return;
    if (n.childNodes && n.childNodes.length) { n.childNodes.forEach(walk); return; }
    const type = String(n.type || '').toLowerCase();
    if ((type === 'text/plain' || type === 'text/html') && String(n.disposition || '').toLowerCase() !== 'attachment') parts.push({ part: n.part || '1', type });
  };
  walk(node);
  return parts.find((p) => p.type === 'text/plain') || parts.find((p) => p.type === 'text/html') || null;
}

function hasAttachment(node) {
  if (!node) return false;
  if (node.childNodes && node.childNodes.length) return node.childNodes.some(hasAttachment);
  return String(node.disposition || '').toLowerCase() === 'attachment';
}

function stripHtml(s) {
  return String(s || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

async function _readText(c, uid, bodyStructure, maxBytes) {
  const tp = textPartOf(bodyStructure);
  if (!tp) return '';
  const r = await c.download(String(uid), tp.part, { uid: true, maxBytes });
  if (!r || !r.content) return '';
  const chunks = [];
  for await (const chunk of r.content) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return tp.type === 'text/html' ? stripHtml(text) : text.trim();
}

/** A Gmail message in the SAME shape as microsoft.fetchRecentEmailsDetailed, plus where it lives. PURE. */
function toTriageEmail(msg, { path, uidValidity, text = '' }) {
  const env = msg.envelope || {};
  const from = (env.from && env.from[0]) || {};
  const flags = msg.flags instanceof Set ? msg.flags : new Set(msg.flags || []);
  const received = msg.internalDate ? new Date(msg.internalDate).toISOString() : (env.date ? new Date(env.date).toISOString() : null);
  return {
    id: `${ID_PREFIX}${msg.emailId || `${uidValidity}-${msg.uid}`}`,
    subject: env.subject || '(No subject)',
    from: from.name || from.address || 'Unknown',
    fromEmail: String(from.address || '').toLowerCase(),
    received,
    isRead: flags.has('\\Seen'),
    importance: 'normal',
    isFlagged: flags.has('\\Flagged'),
    preview: String(text || '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS),
    hasAttachments: hasAttachment(msg.bodyStructure),
    source: 'gmail',
    to: _addr(env.to), cc: _addr(env.cc),
    gmail: {
      uid: msg.uid, uidValidity: String(uidValidity), path,
      threadId: msg.threadId ? String(msg.threadId) : null,
      messageId: env.messageId || null,
      emailId: msg.emailId ? String(msg.emailId) : null,
    },
  };
}

function status() {
  return {
    configured: Boolean(pm.credentialFor('gmail')),
    watermark: _readJson(WATERMARK_KEY),
    last: _readJson(STATUS_KEY),
  };
}

// Where a Gmail message's coordinates live: the Personal inbox since Gmail moved
// there (12 Oct 2026); the work triage store for anything from before.
function _entry(emailId) {
  try {
    const p = require('./personal-inbox').gmailEntry(emailId);
    if (p) return p;
  } catch { /* fall through */ }
  const t = require('./email-triage').getStoredTriage();
  return t.find((e) => e.id === emailId) || null;
}

/** Open the message's folder, check it is still the same numbering, run fn. */
async function _withMessage(entry, fn, deps) {
  deps = _withDefaults(deps);
  if (!entry || !entry.gmail) return { ok: false, reason: 'not-a-gmail-entry' };
  let c;
  try {
    const o = await _open(deps);
    if (o.error) return { ok: false, reason: o.error };
    c = o.c;
    const lock = await c.getMailboxLock(entry.gmail.path);
    try {
      if (String((c.mailbox || {}).uidValidity) !== String(entry.gmail.uidValidity)) return { ok: false, reason: 'renumbered' };
      return await fn(c);
    } finally { lock.release(); }
  } catch (e) {
    return { ok: false, reason: pm.classifyError(e).kind, error: pm.classifyError(e).error };
  } finally { if (c) await _close(c); }
}

/** Mark it read in Gmail. Same answer shape as microsoft.markEmailRead: { marked, reason }. */
async function markRead(emailId, { deps } = {}) {
  const entry = _entry(emailId);
  const r = await _withMessage(entry, async (c) => {
    await c.messageFlagsAdd(String(entry.gmail.uid), ['\\Seen'], { uid: true });
    return { ok: true };
  }, deps);
  return r.ok ? { marked: true } : { marked: false, reason: r.reason || 'error' };
}

/**
 * The live message, for the detail view and for preparing a reply:
 * { ok, exists, from, fromName, subject, to, cc, body, conversationId (Gmail
 *   thread), internetMessageId, references, received }. "Could not look" is
 *   ok:false — never exists:false.
 */
async function readMessage(emailId, { deps } = {}) {
  const entry = _entry(emailId);
  if (!entry) return { ok: true, exists: false };
  const r = await _withMessage(entry, async (c) => {
    const m = await c.fetchOne(String(entry.gmail.uid), { uid: true, envelope: true, bodyStructure: true, threadId: true, internalDate: true, headers: ['references'] }, { uid: true });
    if (!m || !m.envelope) return { ok: true, exists: false };
    let body = '';
    try { body = await _readText(c, m.uid, m.bodyStructure, BODY_MAX); } catch { /* headers are still the message */ }
    const env = m.envelope;
    const from = (env.from && env.from[0]) || {};
    const refs = m.headers ? String(m.headers).replace(/^references:\s*/i, '').replace(/\r?\n\s+/g, ' ').trim() : '';
    return {
      ok: true, exists: true,
      from: String(from.address || '').toLowerCase(), fromName: from.name || '',
      subject: env.subject || '', to: _addr(env.to), cc: _addr(env.cc), body,
      conversationId: m.threadId ? String(m.threadId) : null,
      internetMessageId: env.messageId || null,
      references: refs || null,
      received: m.internalDate ? new Date(m.internalDate).toISOString() : null,
    };
  }, deps);
  if (r.ok === false && r.reason === 'renumbered') return { ok: true, exists: false };
  return r;
}

module.exports = {
  WATERMARK_KEY, STATUS_KEY, ID_PREFIX, isGmailId,
  markRead, readMessage, status,
  toTriageEmail, textPartOf, hasAttachment, stripHtml,
};
