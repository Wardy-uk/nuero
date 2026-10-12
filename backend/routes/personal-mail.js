'use strict';

/**
 * /api/mail — the personal mailboxes (Settings). Work mail is NOT here (Graph).
 * Passwords go in and never come out. A test send goes only to another of
 * Nick's own mailboxes. Machine clients are refused by the authority matrix
 * (config.security).
 */

const express = require('express');
const pm = require('../services/personal-mail');
const transport = require('../services/personal-mail-transport');

const router = express.Router();

// GET /api/mail/accounts — the five personal mailboxes: job, hosts, whether a password is saved, the last connection check, and the From / Reply-To each sends as. Never a password. Keywords: personal email, mailbox settings, nick@ saim@ contact@ neuro@ Gmail.
router.get('/accounts', (req, res) => {
  let gmailIntake = null;
  try { gmailIntake = require('../services/gmail-intake').status(); } catch { /* shown as unknown */ }
  res.json({ ok: true, ...pm.status(), gmailIntake });
});

// GET /api/mail/tests — recent test emails and the SPF / DKIM / DMARC verdict the receiving server gave each. Keywords: email authentication test, DKIM pass.
router.get('/tests', (req, res) => {
  res.json({ ok: true, tests: pm.tests() });
});

// POST /api/mail/accounts/:key/credential — save a mailbox password (Gmail: address + app password). The value is never returned. Body: { password, address }
router.post('/accounts/:key/credential', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { password, address } = body;
  const r = pm.setCredential(req.params.key, { password, address });
  if (!r.ok) return res.status(pm.box(req.params.key) ? 400 : 404).json(r);
  res.json({ ok: true, ...pm.status() });
});

// DELETE /api/mail/accounts/:key/credential — forget a mailbox password. Keywords: remove mailbox password.
router.delete('/accounts/:key/credential', (req, res) => {
  const r = pm.clearCredential(req.params.key);
  if (!r.ok) return res.status(404).json(r);
  res.json({ ok: true, ...pm.status() });
});

// POST /api/mail/accounts/:key/check — log in to the mailbox over IMAP (and SMTP if it sends) and report what happened. Sends nothing.
router.post('/accounts/:key/check', async (req, res) => {
  try {
    const r = await transport.check(req.params.key);
    res.status(r.ok ? 200 : r.status || 500).json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: pm.classifyError(e).error });
  }
});

// POST /api/mail/accounts/:key/test-send — send a test email to another of Nick's own mailboxes and read it back for its SPF / DKIM / DMARC verdict. Body: { to }
router.post('/accounts/:key/test-send', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { to } = body;
  try {
    const r = await transport.sendTest(req.params.key, typeof to === 'string' ? to : null);
    res.status(r.ok ? 200 : r.status || 500).json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: pm.classifyError(e).error });
  }
});

module.exports = router;
