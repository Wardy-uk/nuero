const express = require('express');
const router = express.Router();
const db = require('../db/database');
const microsoft = require('../services/microsoft');

// GET /api/microsoft/status
router.get('/status', (req, res) => {
  res.json({
    configured: microsoft.isConfigured(),
    authenticated: microsoft.isAuthenticated(),
    auth_status: db.getState('ms_auth_status') || 'none',
    last_sync: db.getState('ms_last_sync'),
    task_count: db.getState('ms_task_count'),
    device_code_message: db.getState('ms_device_code_message') || null,
    device_code_uri: db.getState('ms_device_code_uri') || null,
    device_code_usercode: db.getState('ms_device_code_usercode') || null
  });
});

// POST /api/microsoft/auth — start device code flow
router.post('/auth', async (req, res) => {
  if (!microsoft.isConfigured()) {
    return res.status(400).json({ error: 'MS_CLIENT_ID and MS_TENANT_ID not set in .env' });
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
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/microsoft/sync — manual task sync trigger
router.post('/sync', async (req, res) => {
  try {
    await microsoft.syncTasksToLocal();
    const todos = db.getActiveTodos();
    res.json({ success: true, count: todos.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
