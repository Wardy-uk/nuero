'use strict';

/**
 * A personal mailbox as a mail transport (12 Oct 2026) — the SAME interface as
 * action-mail.js (Graph): createDraft → sendDraft → findSent / draftState /
 * deleteDraft. A caller that holds the ledger (hike-safety, later the governed
 * executor) cannot tell the two apart, which is the point: its send-once and
 * verify rules do not change with the identity.
 *
 * SMTP has no server-side draft, so the "draft" is a row in `smtp_outbox`:
 * composed, with its Message-ID, BEFORE the network. Then:
 *   sendDraft   marks the row `sending` FIRST, so a process killed mid-send
 *               leaves "unknown", never "unsent"; then SMTP.
 *   draftState  draft/refused → 'draft' (proven unsent), sent → 'not-draft',
 *               sending → 'unavailable' (it MAY have gone), deleted → 'gone'.
 *   findSent    the mailbox's Sent folder, by Message-ID. Gmail files SMTP sends
 *               itself; on Fasthosts the copy is NEURO's own and `evidence` says so.
 */

const crypto = require('crypto');
const pm = require('./personal-mail');

function _db() { return require('../db/database'); }
const _now = () => new Date().toISOString();
const _transport = (deps) => (deps && deps.transport) || require('./personal-mail-transport');

const _addr = (list) => (list || []).map((x) => ({ name: x.name || '', address: String(x.email || x.address || '').trim() })).filter((x) => x.address);

function forMailbox(key, deps = {}) {
  const box = pm.box(key);
  if (!box || !box.sends) throw new Error(`${key} is not a sending mailbox`);

  function createDraft({ to, cc = [], subject, body, contentType = 'Text', attachments = [], inReplyTo = null, references = null }) {
    const cred = pm.credentialFor(key);
    if (!cred) return { ok: false, status: null, category: 'auth' };
    const sender = pm.senderFor(key, cred.address);
    const id = `smtp:${crypto.randomUUID()}`;
    const messageId = `<neuro-${crypto.randomBytes(12).toString('hex')}@${cred.address.split('@')[1]}>`;
    const message = {
      from: sender.from, replyTo: sender.replyTo || undefined,
      to: _addr(to), cc: _addr(cc), subject: subject || '',
      [contentType === 'HTML' ? 'html' : 'text']: body || '',
      attachments: (attachments || []).filter((a) => a && a.name && typeof a.text === 'string')
        .map((a) => ({ filename: a.name, content: a.text, contentType: a.contentType || 'application/octet-stream' })),
      inReplyTo: inReplyTo || undefined, references: references || undefined,
      date: new Date(),
    };
    _db().run(`INSERT INTO smtp_outbox (id, mailbox, message_id, message_json, state, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'draft', ?, ?)`, [id, key, messageId, JSON.stringify(message), _now(), _now()]);
    return { ok: true, id, internetMessageId: messageId, status: 201 };
  }

  async function sendDraft(id) {
    const row = _db().get('SELECT * FROM smtp_outbox WHERE id = ? AND mailbox = ?', [id, key]);
    if (!row) return { outcome: 'rejected', status: 404, category: 'http_4xx' };
    if (row.state === 'sent') return { outcome: 'accepted', status: 250 };
    if (row.state === 'sending') return { outcome: 'uncertain', status: null, category: 'unknown' };
    if (row.state === 'deleted') return { outcome: 'rejected', status: 404, category: 'http_4xx' };
    // The ledger-before-network rule: "sending" is written first.
    _db().run("UPDATE smtp_outbox SET state = 'sending', updated_at = ? WHERE id = ?", [_now(), id]);
    const message = { ...JSON.parse(row.message_json), messageId: row.message_id };
    if (message.date) message.date = new Date(message.date);
    let r;
    try { r = await _transport(deps).smtpSend(key, message, deps.transportDeps); } catch (e) { r = { outcome: 'uncertain', category: 'unknown', response: String(e && e.message || '').slice(0, 160) }; }
    if (r.outcome === 'accepted') {
      _db().run("UPDATE smtp_outbox SET state = 'sent', sent_at = ?, server_response = ?, appended = ?, updated_at = ? WHERE id = ?",
        [_now(), r.response || null, r.appended ? 1 : 0, _now(), id]);
    } else if (r.outcome === 'rejected') {
      _db().run("UPDATE smtp_outbox SET state = 'refused', server_response = ?, updated_at = ? WHERE id = ?", [r.response || null, _now(), id]);
    } // uncertain: stays 'sending' — it may have gone.
    return { outcome: r.outcome, status: r.status || null, category: r.category || null };
  }

  async function findSent(internetMessageId) {
    if (!internetMessageId) return { ok: false, category: 'no-handle' };
    return _transport(deps).findInSent(key, internetMessageId, deps.transportDeps);
  }

  async function draftState(id) {
    if (!id) return 'unavailable';
    const row = _db().get('SELECT state FROM smtp_outbox WHERE id = ? AND mailbox = ?', [id, key]);
    if (!row || row.state === 'deleted') return 'gone';
    if (row.state === 'draft' || row.state === 'refused') return 'draft';
    if (row.state === 'sent') return 'not-draft';
    return 'unavailable';
  }

  async function deleteDraft(id) {
    if ((await draftState(id)) !== 'draft') return false;
    _db().run("UPDATE smtp_outbox SET state = 'deleted', updated_at = ? WHERE id = ?", [_now(), id]);
    return true;
  }

  return { mailbox: key, createDraft, sendDraft, findSent, draftState, deleteDraft };
}

module.exports = { forMailbox };
