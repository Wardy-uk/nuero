'use strict';

/**
 * A personal mailbox as the governed executor's mail API (12 Oct 2026). The
 * SAME methods action-mail.js gives the executor for Microsoft, so a reply's
 * approval, one-attempt ledger, recipient read-back, "never resend uncertain"
 * and Sent verification are unchanged whichever mailbox sends:
 *
 *   readMessage            the email being answered (Gmail: gmail-intake)
 *   sentInConversationSince  has Nick replied in this thread since? (Gmail
 *                          thread search) — null = could not look, so the
 *                          executor WAITS; it never sends on a guess
 *   createReplyDraft       an outbox draft threaded under the original
 *                          (In-Reply-To + References), recipients EMPTY until
 *   patchDraft             sets exactly the approved to/cc/subject and reports
 *                          what the draft now holds (the executor compares)
 *   createDraft / sendDraft / draftState / deleteDraft   smtp-mail
 *   findSent               the mailbox's Sent, with the envelope and thread the
 *                          executor's judgeSentItem checks
 *   signedInAddress        the mailbox's own address
 *
 * ⚠ Only mailboxes the registry allows for a type ever reach here
 *   (`personalMailboxes` on reply_email — commonChecks refuses anything else).
 */

const pm = require('./personal-mail');

const QUOTE_MAX = 4000;

function _quote(orig) {
  const body = String(orig.body || '').slice(0, QUOTE_MAX).replace(/\r\n/g, '\n');
  if (!body.trim()) return '';
  const who = orig.fromName ? `${orig.fromName} <${orig.from}>` : orig.from;
  const when = orig.received ? new Date(orig.received).toUTCString() : 'earlier';
  return `\n\nOn ${when}, ${who} wrote:\n${body.split('\n').map((l) => `> ${l}`).join('\n')}`;
}

function forMailbox(key, deps = {}) {
  const box = pm.box(key);
  if (!box || !box.sends) throw new Error(`${key} is not a sending mailbox`);
  const gmail = box.provider === 'gmail';
  const adapter = require('./smtp-mail').forMailbox(key, deps.smtp || {});
  // Gmail mail comes through the Gmail intake; nick@ / contact@ through the
  // personal inbox. Both readers are read-only and answer the same shape.
  const reader = deps.reader || (gmail ? require('./gmail-intake') : require('./personal-inbox'));
  const transport = deps.transport || require('./personal-mail-transport');

  async function readMessage(emailId) {
    return reader.readMessage(emailId, { deps: deps.readDeps });
  }

  return {
    mailbox: key,
    providerLabel: pm.PROVIDERS[box.provider].label,
    readMessage,
    signedInAddress: async () => pm.addressFor(key),
    // Gmail: a thread search. Fasthosts (no search, no thread id): its Sent
    // envelopes scanned for In-Reply-To = the original's Message-ID. null =
    // could not look, so the executor waits rather than sending.
    sentInConversationSince: async (threadId, sinceIso) => transport.sentInThreadSince(key, threadId, sinceIso, deps.transportDeps),
    sentToSince: async () => null,
    readEvent: async () => ({ ok: false, category: 'unsupported' }),
    async createReplyDraft(emailId, { mode = 'reply', comment = '' } = {}) {
      const orig = await readMessage(emailId);
      if (!orig || !orig.ok) return { ok: false, status: null, category: (orig && orig.category) || 'unavailable' };
      if (!orig.exists) return { ok: false, status: 404, category: 'http_4xx' };
      const references = [orig.references, orig.internetMessageId].filter(Boolean).join(' ') || null;
      const d = adapter.createDraft({
        to: [], cc: [], subject: '', body: `${comment}${_quote(orig)}`, contentType: 'Text',
        inReplyTo: orig.internetMessageId || null, references,
      });
      return d.ok ? { ...d, conversationId: orig.conversationId || null, mode } : d;
    },
    patchDraft: (id, fields) => adapter.patchDraft(id, fields),
    createDraft: (m) => adapter.createDraft(m),
    addAttachments: (id, files) => adapter.addAttachments(id, files),
    listAttachments: (id) => adapter.listAttachments(id),
    sendDraft: (id) => adapter.sendDraft(id),
    draftState: (id) => adapter.draftState(id),
    deleteDraft: (id) => adapter.deleteDraft(id),
    findSent: (mid) => transport.findInSent(key, mid, deps.transportDeps),
  };
}

module.exports = { forMailbox };
