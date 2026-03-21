const express = require('express');
const router = express.Router();
const db = require('../db/database');
const nudges = require('../services/nudges');

// GET /api/nudges — active nudges + snooze state
router.get('/', (req, res) => {
  const active = db.getActiveNudges();
  const snoozeState = nudges.getSnoozeState();
  res.json({ nudges: active, snoozeState });
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
  const id = Number(req.params.id);
  // Look up nudge type before completing so we can log it
  const active = db.getActiveNudges();
  const nudge = active.find(n => n.id === id);
  db.completeNudge(id);
  if (nudge) {
    const activity = require('../services/activity');
    activity.trackNudgeDismiss(nudge.type);
  }
  res.json({ success: true });
});

// POST /api/nudges/:type/snooze — snooze a nudge for 30 minutes
router.post('/:type/snooze', (req, res) => {
  const { type } = req.params;
  const validTypes = ['standup', 'todo', 'eod', '121', 'plan_milestone'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: 'Invalid nudge type' });
  }
  nudges.snoozeNudge(type);
  res.json({ success: true, snoozed_for: '30 minutes' });
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
