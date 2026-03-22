'use strict';

const express = require('express');
const router = express.Router();
const strava = require('../services/strava');

// GET /api/strava/status
router.get('/status', (req, res) => {
  res.json({
    configured: strava.isConfigured(),
    authenticated: strava.isAuthenticated()
  });
});

// GET /api/strava/auth — redirect to Strava OAuth
router.get('/auth', (req, res) => {
  const url = strava.getAuthUrl();
  if (!url) return res.status(500).json({ error: 'STRAVA_CLIENT_ID and STRAVA_REDIRECT_URI required' });
  res.redirect(url);
});

// GET /api/strava/callback — OAuth callback from Strava
router.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.send(`<html><body><h2>Strava auth failed: ${error || 'no code'}</h2>
      <p>You can close this tab and return to NEURO.</p></body></html>`);
  }
  try {
    await strava.exchangeCode(code);
    res.send(`<html><body>
      <h2>Strava connected</h2>
      <p>You can close this tab and return to NEURO.</p>
      <script>setTimeout(() => window.close(), 2000);</script>
    </body></html>`);
  } catch (e) {
    console.error('[Strava] Callback error:', e.message);
    res.send(`<html><body><h2>Strava auth error: ${e.message}</h2></body></html>`);
  }
});

// GET /api/strava/activities/today
router.get('/activities/today', async (req, res) => {
  try {
    const activities = await strava.getTodayActivities();
    res.json({ activities: activities || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/strava/disconnect
router.post('/disconnect', (req, res) => {
  strava.disconnect();
  res.json({ success: true });
});

module.exports = router;
