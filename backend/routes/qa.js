const express = require('express');
const router = express.Router();

const BASE = (process.env.QA_WEBHOOK_BASE || '').replace(/\/$/, '');

async function proxy(path, query, res) {
  if (!BASE) {
    return res.status(503).json({ error: 'QA_WEBHOOK_BASE not configured' });
  }
  try {
    const params = new URLSearchParams(query);
    const url = `${BASE}${path}?${params}`;
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(response.status).json({ error: `Upstream error ${response.status}` });
    }
    const data = await response.json();
    res.json(data);
  } catch (e) {
    console.error('[QA]', path, e.message);
    res.status(500).json({ error: 'QA data unavailable' });
  }
}

router.get('/summary', (req, res) => proxy('/qa-summary', req.query, res));
router.get('/results', (req, res) => proxy('/qa-results', req.query, res));
router.get('/agents',  (req, res) => proxy('/qa-agents',  req.query, res));
router.get('/health',  (req, res) => proxy('/qa-health',  req.query, res));
router.get('/drift',   (req, res) => proxy('/qa-drift',   req.query, res));

module.exports = router;
