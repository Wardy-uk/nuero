'use strict';

/**
 * The family Google calendar — Settings → Integrations (18 Oct 2026).
 * Behind the PIN. No route returns the client secret or a token.
 * See services/google-calendar.js.
 */

const express = require('express');
const gcal = require('../services/google-calendar');

const router = express.Router();

// GET /api/google-calendar — family Google calendar connection status (no secrets)
router.get('/', (req, res) => {
  res.json({ ok: true, status: gcal.status(), redirectUri: gcal.REDIRECT_URI, scope: gcal.SCOPE });
});

// POST /api/google-calendar/client — save the Google OAuth client { clientId, clientSecret } (desktop app type); never returned
router.post('/client', (req, res) => {
  const { clientId, clientSecret } = req.body || {};
  const r = gcal.setClient({ clientId, clientSecret });
  res.status(r.ok ? 200 : 400).json({ ...r, status: gcal.status() });
});

// POST /api/google-calendar/target — which Google calendar the family wall writes to { calendarId }
router.post('/target', (req, res) => {
  const { calendarId } = req.body || {};
  const r = gcal.setTarget(calendarId);
  res.status(r.ok ? 200 : 400).json({ ...r, status: gcal.status() });
});

// POST /api/google-calendar/connect — start Google sign-in: returns the address to open
router.post('/connect', (req, res) => {
  const r = gcal.authUrl();
  res.status(r.ok ? 200 : 400).json(r);
});

// POST /api/google-calendar/finish — finish Google sign-in with the pasted http://127.0.0.1 address { pasted }
router.post('/finish', async (req, res) => {
  const { pasted } = req.body || {};
  try {
    const r = await gcal.finish(pasted);
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) {
    res.status(502).json({ ok: false, error: `Google did not answer: ${e.message}` });
  }
});

// POST /api/google-calendar/disconnect — forget the Google sign-in (stored events are kept until the next sign-in)
router.post('/disconnect', (req, res) => {
  res.json({ ...gcal.disconnect(), status: gcal.status() });
});

// POST /api/google-calendar/sync — re-read the family Google calendar now
router.post('/sync', async (req, res) => {
  const r = await gcal.syncNow().catch((e) => ({ ok: false, error: e.message }));
  res.status(r.ok ? 200 : 502).json({ ...r, status: gcal.status() });
});

module.exports = router;
