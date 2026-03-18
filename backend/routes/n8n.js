const express = require('express');
const router = express.Router();
const n8n = require('../services/n8n');

// POST /api/n8n/121 — run 1-2-1 snapshot for an agent
router.post('/121', async (req, res) => {
  if (!n8n.isConfigured()) {
    return res.status(400).json({ error: 'n8n API key not configured (N8N_API_KEY)' });
  }

  const { nameHint } = req.body;
  if (!nameHint) {
    return res.status(400).json({ error: 'nameHint is required' });
  }

  try {
    const result = await n8n.run121Snapshot(nameHint);
    res.json(result);
  } catch (err) {
    console.error('[n8n] 1-2-1 execution error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/n8n/status
router.get('/status', (req, res) => {
  res.json({ configured: n8n.isConfigured() });
});

module.exports = router;
