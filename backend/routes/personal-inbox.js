'use strict';

/**
 * /api/personal-inbox — nick@ and contact@ newest first (no AI), plus saim@
 * bounces and auto-replies. Separate from the work triage. A reply PREPARES a
 * governed reply_email from the same mailbox (sent on Nick's click, like the
 * Inbox composer); nothing here sends.
 */

const express = require('express');
const inbox = require('../services/personal-inbox');

const router = express.Router();

// GET /api/personal-inbox — the mailboxes (nick@, contact@, saim@ watched), counts and unread, and the last refresh. Keywords: personal email inbox, nick@nickward.co.uk, contact@.
router.get('/', (req, res) => {
  res.json({ ok: true, ...inbox.overview() });
});

// GET /api/personal-inbox/mail/:mailbox — one mailbox's messages, newest first. Keywords: personal inbox list.
router.get('/mail/:mailbox', (req, res) => {
  const items = inbox.list(req.params.mailbox, { limit: req.query.limit });
  if (!items) return res.status(404).json({ ok: false, error: 'no such mailbox' });
  res.json({ ok: true, mailbox: req.params.mailbox, items });
});

// POST /api/personal-inbox/refresh — read the personal mailboxes now (it also runs every 5 minutes). Sends nothing.
router.post('/refresh', async (req, res) => {
  try { res.json({ ok: true, ...(await inbox.refresh()) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/personal-inbox/message/:id — one message, read live from its mailbox (opening never marks it read), with the address a reply would go from.
router.get('/message/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const m = await inbox.readMessage(id);
    if (!m || !m.ok) return res.status(503).json({ ok: false, error: (m && m.error) || 'could not read the mailbox' });
    if (!m.exists) return res.status(404).json({ ok: false, error: 'that message is no longer in the mailbox' });
    const s = require('../services/mail-identity').forAction({ actionType: 'reply_email', target: { mailbox: m.mailbox } });
    res.json({ ok: true, message: { id, ...m }, sendsFrom: s ? { address: s.address, from: s.from, via: s.via } : null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/personal-inbox/message/:id/read — mark it read in the mailbox.
router.post('/message/:id/read', async (req, res) => {
  try {
    const r = await inbox.markRead(req.params.id);
    res.status(r.marked ? 200 : 502).json({ ok: r.marked, ...r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/personal-inbox/message/:id/delete — move it to that mailbox's Bin/Trash (recoverable there). Nick only.
router.post('/message/:id/delete', async (req, res) => {
  try {
    const r = await inbox.trash(req.params.id);
    res.status(r.deleted ? 200 : r.reason === 'not-found' ? 404 : 502).json({ ok: r.deleted, ...r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/personal-inbox/compose/options — the addresses a new email can come from (work, nick@, contact@, Gmail) and, for the recipients given, which one NEURO suggests and why. Query: to (comma-separated)
router.get('/compose/options', (req, res) => {
  const mi = require('../services/mail-identity');
  const pm = require('../services/personal-mail');
  const options = [{ key: 'work', address: mi.WORK_ADDRESS, via: 'Microsoft (Outlook)', ready: true }];
  for (const key of ['nick', 'contact', 'gmail']) {
    const address = pm.addressFor(key);
    if (address) options.push({ key, address, via: pm.PROVIDERS[pm.box(key).provider].label, ready: Boolean(pm.credentialFor(key)) });
  }
  const to = String(req.query.to || '').split(',').map((s) => s.trim()).filter(Boolean);
  const suggestion = to.length ? mi.decide({ kind: 'compose', recipients: to, lookups: mi.defaultLookups() }) : null;
  res.json({ ok: true, options, suggestion: suggestion ? { mailbox: suggestion.mailbox || null, ask: !!suggestion.ask, why: suggestion.why, recipients: (suggestion.recipients || []).map((r) => ({ address: r.address, sphere: r.sphere, why: r.why })) } : null });
});

// POST /api/personal-inbox/compose — prepare a NEW email from the chosen address (governed compose_email; nothing is sent here — it goes on Nick's click). Body: { from, to, cc, subject, body }
router.post('/compose', (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const { from, to, cc, subject, body } = b;
    const r = require('../services/prepared-actions').prepareCompose({ from, to, cc, subject, body, origin: 'composer' });
    if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error });
    res.json({ ok: true, prepared: true, action: r.action });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/personal-inbox/message/:id/reply — prepare a reply from the SAME mailbox (governed reply_email; nothing is sent here). Body: { body, replyAll }
router.post('/message/:id/reply', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { replyAll } = body;
    const text = String(body.body || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'the reply is empty' });
    const r = await require('../services/prepared-actions').prepareReply({
      emailId: req.params.id, body: text, mode: replyAll ? 'replyAll' : 'reply', origin: 'composer',
    });
    if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error, action: r.action || null });
    res.json({ ok: true, prepared: true, action: r.action });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
