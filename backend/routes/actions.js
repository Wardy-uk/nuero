'use strict';

/**
 * SARA Actions API — approve, reject, and list action suggestions.
 *
 * GET  /api/actions         — list pending + recent actions
 * POST /api/actions/:id/approve — execute an approved action
 * POST /api/actions/:id/reject  — reject and suppress an action
 */

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const suggestionEngine = require('../services/suggestion-engine');

// GET /api/actions — list pending actions + recent history
router.get('/', (req, res) => {
  try {
    const pending = db.getPendingSaraActions();
    const recent = db.getRecentSaraActions(10);
    res.json({ pending, recent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/actions/:id/approve — approve and execute
router.post('/:id/approve', (req, res) => {
  try {
    const action = db.getSaraAction(parseInt(req.params.id));
    if (!action) return res.status(404).json({ error: 'Action not found' });
    if (action.status !== 'pending') return res.status(400).json({ error: `Action is ${action.status}, not pending` });

    // Execute
    const result = suggestionEngine.executeAction(action);

    // Update status
    db.updateSaraActionStatus(action.id, result.ok ? 'executed' : 'failed');

    // Log
    suggestionEngine.logActionExecution(action, result);

    res.json({ ok: result.ok, detail: result.detail, action });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/actions/:id/reject — reject and optionally suppress
router.post('/:id/reject', (req, res) => {
  try {
    const action = db.getSaraAction(parseInt(req.params.id));
    if (!action) return res.status(404).json({ error: 'Action not found' });
    if (action.status !== 'pending') return res.status(400).json({ error: `Action is ${action.status}, not pending` });

    db.updateSaraActionStatus(action.id, 'rejected');

    // Log rejection to activity
    try {
      db.logActivity('sara_action_rejected', {
        actionId: action.id,
        type: action.type,
        reason: action.reason,
      });
    } catch {}

    res.json({ ok: true, rejected: action.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
