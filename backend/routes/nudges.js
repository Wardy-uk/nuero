const express = require('express');
const router = express.Router();
const db = require('../db/database');
const nudges = require('../services/nudges');

// GET /api/nudges — active nudges
router.get('/', (req, res) => {
  const active = db.getActiveNudges();
  res.json({ nudges: active });
});

// SSE stream for real-time nudges
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  nudges.addClient(res);
});

// POST /api/nudges/:id/complete
router.post('/:id/complete', (req, res) => {
  db.completeNudge(Number(req.params.id));
  res.json({ success: true });
});

// POST /api/nudges/trigger-standup — manual trigger for testing
router.post('/trigger-standup', (req, res) => {
  nudges.triggerStandupNudge();
  res.json({ success: true });
});

// POST /api/nudges/trigger-todo — manual trigger for testing
router.post('/trigger-todo', (req, res) => {
  nudges.triggerTodoNudge();
  res.json({ success: true });
});

module.exports = router;
