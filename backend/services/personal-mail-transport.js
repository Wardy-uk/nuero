'use strict';

/**
 * Personal mailboxes — the network half: check a login, send a TEST, read it back.
 *
 * ⚠ This is the ONLY module that loads nodemailer (pinned by build7 test 33).
 * Its one send is `sendTest`, and a test goes ONLY to another of Nick's own
 * mailboxes — the same rule as email-sender.sendMail being self-only. Sending
 * to anyone else from a personal identity is a later build, and goes through
 * the governed executor like every other outbound email.
 *
 * Why read it back: SMTP's "250 accepted" says nothing about whether SPF, DKIM
 * and DMARC passed. The receiving server writes that verdict into the message's
 * Authentication-Results header, so NEURO fetches the test from the mailbox it
 * was sent to and reports the receiver's own words, plus the folder it landed in
 * (a pass that lands in Spam is not a pass).
 */

const crypto = require('crypto');
const pm = require('./personal-mail');

const READBACK_ATTEMPTS = 9;
const READBACK_GAP_MS = 10_000;

function defaultDeps() {
  return {
    smtp: (cfg) => require('nodemailer').createTransport(cfg),
    imap: (cfg) => new (require('imapflow').ImapFlow)(cfg),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

function _withDefaults(deps) {
  return { ...defaultDeps(), ...(deps || {}) };
}

function smtpConfig(key, cred) {
  const p = pm.PROVIDERS[pm.box(key).provider].smtp;
  return {
    host: p.host, port: p.port, secure: p.secure,
    auth: { user: cred.address, pass: cred.password },
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  };
}

function imapConfig(key, cred) {
  const p = pm.PROVIDERS[pm.box(key).provider].imap;
  return {
    host: p.host, port: p.port, secure: p.secure,
    auth: { user: cred.address, pass: cred.password },
    logger: false, emitLogs: false,
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000,
  };
}

async function _openImap(key, cred, deps) {
  const client = deps.imap(imapConfig(key, cred));
  // An unhandled 'error' event on a socket would take the process down.
  if (typeof client.on === 'function') client.on('error', () => {});
  await client.connect();
  return client;
}

async function _close(client) {
  try { await client.logout(); } catch { try { client.close(); } catch { /* already gone */ } }
}

/** Log in to IMAP (and SMTP, for a mailbox that sends). Records and returns the result. */
async function check(key, deps) {
  deps = _withDefaults(deps);
  const b = pm.box(key);
  if (!b) return { ok: false, status: 404, error: `No mailbox called "${key}".` };
  const cred = pm.credentialFor(key);
  if (!cred) return { ok: false, status: 409, error: 'No password saved for this mailbox yet.' };

  const result = { at: new Date(deps.now()).toISOString(), imap: null, smtp: null };
  try {
    const c = await _openImap(key, cred, deps);
    try {
      const inbox = await c.status('INBOX', { messages: true, unseen: true }).catch(() => null);
      result.imap = { ok: true, inbox: inbox ? { messages: inbox.messages ?? null, unseen: inbox.unseen ?? null } : null };
      if (b.provider === 'gmail') {
        // Gmail's Important view is what later builds read; say now whether it is there.
        const list = await c.list().catch(() => []);
        const imp = list.find((m) => m.specialUse === '\\Important');
        result.imap.important = imp ? imp.path : null;
      }
    } finally { await _close(c); }
  } catch (e) {
    result.imap = { ok: false, ...pm.classifyError(e) };
  }
  if (b.sends) {
    try {
      const t = deps.smtp(smtpConfig(key, cred));
      await t.verify();
      if (typeof t.close === 'function') t.close();
      result.smtp = { ok: true };
    } catch (e) {
      result.smtp = { ok: false, ...pm.classifyError(e) };
    }
  }
  result.ok = Boolean(result.imap && result.imap.ok && (!b.sends || (result.smtp && result.smtp.ok)));
  pm.recordCheck(key, result);
  return { ok: true, key, result };
}

/** Find one message by Message-ID in a mailbox; return its headers + where it landed. */
async function findByMessageId(key, cred, messageId, deps) {
  const b = pm.box(key);
  const c = await _openImap(key, cred, deps);
  try {
    const list = await c.list().catch(() => []);
    const special = (flag) => (list.find((m) => m.specialUse === flag) || {}).path || null;
    const places = b.provider === 'gmail'
      ? [{ path: special('\\All'), label: 'All Mail', gm: true }, { path: special('\\Junk'), label: 'Spam', gm: true }]
      : [{ path: 'INBOX', label: 'Inbox' }, { path: special('\\Junk'), label: 'Junk' }];
    for (const place of places.filter((p) => p.path)) {
      const lock = await c.getMailboxLock(place.path);
      try {
        const id = messageId.replace(/^<|>$/g, '');
        const query = place.gm ? { gmraw: `rfc822msgid:${id}` } : { header: { 'message-id': id } };
        const uids = await c.search(query, { uid: true });
        if (uids && uids.length) {
          const msg = await c.fetchOne(String(uids[uids.length - 1]), { headers: true, labels: Boolean(place.gm) }, { uid: true });
          let folder = place.label;
          if (place.gm && place.label === 'All Mail') {
            const labels = msg && msg.labels ? [...msg.labels] : [];
            folder = labels.includes('\\Inbox') ? 'Inbox' : 'All Mail (not in the inbox)';
          }
          return { found: true, folder, headers: msg && msg.headers ? msg.headers.toString('utf8') : '' };
        }
      } finally { lock.release(); }
    }
    return { found: false };
  } finally { await _close(c); }
}

async function readBack(entry, toKey, deps) {
  deps = _withDefaults(deps);
  const cred = pm.credentialFor(toKey);
  if (!cred) { pm.recordTest({ id: entry.id, readback: 'error', readbackError: 'The receiving mailbox has no password any more.' }); return; }
  let lastError = null;
  for (let i = 0; i < READBACK_ATTEMPTS; i++) {
    if (i > 0) await deps.sleep(READBACK_GAP_MS);
    try {
      const r = await findByMessageId(toKey, cred, entry.messageId, deps);
      if (r.found) {
        const verdict = pm.parseAuthResults(r.headers);
        pm.recordTest({
          id: entry.id, readback: 'found', folder: r.folder, verdict,
          summary: pm.verdictSummary(verdict), checkedAt: new Date(deps.now()).toISOString(),
        });
        return;
      }
      lastError = null;
    } catch (e) {
      lastError = pm.classifyError(e).error;
    }
  }
  pm.recordTest({
    id: entry.id,
    readback: lastError ? 'error' : 'not-found',
    readbackError: lastError || `Not in ${toKey}'s inbox or junk after ${Math.round((READBACK_ATTEMPTS - 1) * READBACK_GAP_MS / 1000)}s — it may still be on its way, or it was refused.`,
    checkedAt: new Date(deps.now()).toISOString(),
  });
}

/**
 * Send a test from one personal mailbox to ANOTHER of Nick's own, then read it
 * back in the background. Returns as soon as the server has answered the send.
 */
async function sendTest(fromKey, toKey, deps) {
  deps = _withDefaults(deps);
  const from = pm.box(fromKey);
  if (!from) return { ok: false, status: 404, error: `No mailbox called "${fromKey}".` };
  if (!from.sends) return { ok: false, status: 400, error: `${fromKey} does not send mail.` };
  const cred = pm.credentialFor(fromKey);
  if (!cred) return { ok: false, status: 409, error: `No password saved for ${from.address || fromKey}.` };

  const allowed = pm.testTargets(fromKey, pm.configuredKeys());
  const target = toKey || allowed[0];
  if (!target || !allowed.includes(target)) {
    return { ok: false, status: 400, error: 'A test goes only to another of your own mailboxes that has a password saved here.', allowed };
  }
  const sender = pm.senderFor(fromKey, cred.address);
  const to = pm.addressFor(target);
  const id = crypto.randomBytes(8).toString('hex');
  const domain = cred.address.split('@')[1];
  const messageId = `<neuro-test-${id}@${domain}>`;
  const sentAt = new Date(deps.now()).toISOString();

  const entry = { id, messageId, fromMailbox: fromKey, toMailbox: target, from: sender.from, replyTo: sender.replyTo, to, sentAt, readback: 'pending' };
  let info;
  try {
    const t = deps.smtp(smtpConfig(fromKey, cred));
    info = await t.sendMail({
      from: sender.from,
      replyTo: sender.replyTo || undefined,
      to,
      subject: `NEURO test from ${sender.address} (${id.slice(0, 6)})`,
      text: [
        `This is a test from NEURO, sent from ${sender.address} to ${to}.`,
        sender.replyTo ? `Replies should go to ${sender.replyTo}.` : '',
        '',
        'NEURO will read this message back and report the SPF, DKIM and DMARC verdict the receiving server gave it. Nothing else depends on it; you can delete it.',
      ].filter((l, i, a) => l || a[i - 1]).join('\n'),
      messageId,
    });
    if (typeof t.close === 'function') t.close();
  } catch (e) {
    const c = pm.classifyError(e);
    pm.recordTest({ ...entry, sent: false, error: c.error, readback: 'skipped' });
    return { ok: false, status: 502, error: c.error, test: { ...entry, sent: false } };
  }
  const accepted = Array.isArray(info && info.accepted) && info.accepted.length > 0;
  const done = { ...entry, sent: accepted, serverResponse: String((info && info.response) || '').slice(0, 160) };
  if (!accepted) done.readback = 'skipped';
  pm.recordTest(done);
  if (accepted) {
    const p = readBack(done, target, deps).catch((e) => pm.recordTest({ id, readback: 'error', readbackError: pm.classifyError(e).error }));
    if (deps.awaitReadback) await p;
  }
  return { ok: accepted, status: accepted ? 200 : 502, test: done, ...(accepted ? {} : { error: 'The server did not accept the message.' }) };
}

module.exports = { check, sendTest, readBack, findByMessageId, smtpConfig, imapConfig, defaultDeps, READBACK_ATTEMPTS, READBACK_GAP_MS };
