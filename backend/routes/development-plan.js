'use strict';

/**
 * Development Plan routes.
 *   POST /api/development-plan  { action, person, goalNumber?, progressNote?, newGoal?, date? }
 *     action: 'read' | 'update_progress' | 'add_goal' | 'complete_goal'
 */

const express = require('express');
const router = express.Router();
const devPlan = require('../services/development-plan');

router.post('/', (req, res) => {
  try {
    const { action, person, goalNumber, progressNote, newGoal, date } = req.body || {};
    if (!action) return res.status(400).json({ ok: false, error: 'action is required' });
    if (!person) return res.status(400).json({ ok: false, error: 'person is required' });

    let result;
    switch (action) {
      case 'read':
        result = devPlan.readPlan(person);
        break;
      case 'update_progress':
        if (!goalNumber || !progressNote) {
          return res.status(400).json({ ok: false, error: 'goalNumber and progressNote required for update_progress' });
        }
        result = devPlan.updateProgress(person, goalNumber, progressNote, date);
        break;
      case 'add_goal':
        if (!newGoal) return res.status(400).json({ ok: false, error: 'newGoal required for add_goal' });
        result = devPlan.addGoal(person, newGoal, date);
        break;
      case 'complete_goal':
        if (!goalNumber) return res.status(400).json({ ok: false, error: 'goalNumber required for complete_goal' });
        result = devPlan.completeGoal(person, goalNumber, date);
        break;
      default:
        return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
    }

    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[development-plan]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
