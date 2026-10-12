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
