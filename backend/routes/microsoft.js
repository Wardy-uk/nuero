const express = require('express');
const router = express.Router();
const microsoft = require('../services/microsoft');

// GET /api/microsoft/status
router.get('/status', async (req, res) => {
  const configured = microsoft.isConfigured();
  const authenticated = configured ? await microsoft.isAuthenticated() : false;
  res.json({ configured, authenticated });
});

// POST /api/microsoft/auth — start device code flow for Graph permissions
router.post('/auth', async (req, res) => {
  if (!microsoft.isConfigured()) {
    return res.status(400).json({ error: 'NOVA token cache not found' });
  }

  try {
    const result = await microsoft.startDeviceCodeFlow();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/microsoft/calendar
router.get('/calendar', async (req, res) => {
  const { start, end } = req.query;
  try {
    const events = await microsoft.fetchCalendarEvents(start, end);
    res.json({ events: events || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/microsoft/inbox — flagged items from inbox scanner
router.get('/inbox', (req, res) => {
  const scanner = require('../services/inbox-scanner');
  res.json(scanner.getFlaggedItems());
});

// POST /api/microsoft/inbox/scan — trigger manual scan
router.post('/inbox/scan', async (req, res) => {
  const scanner = require('../services/inbox-scanner');
  scanner.scanInbox(); // fire and forget
  res.json({ success: true, message: 'Scan started' });
});

module.exports = router;
