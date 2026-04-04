'use strict';

/**
 * Focus Route — GET /api/focus
 *
 * Returns a hard-limited, prioritised list of "what matters now".
 * Default: 3-5 items. Never more than 7.
 *
 * Uses the Decision Engine for signal collection, tier classification,
 * and suppression. No LLM calls.
 *
 * Query params:
 *   ?all=true  — bypass limits, return all candidates (for "view all" UI)
 */

const express = require('express');
const router = express.Router();
const engine = require('../services/decision-engine');
const workingMemory = require('../services/working-memory');

router.get('/', async (req, res) => {
  try {
    const showAll = req.query.all === 'true';
    const result = await engine.evaluate({ showAll });
    const ctx = await workingMemory.getContext();

    res.json({
      generatedAt: new Date().toISOString(),
      cacheAge: workingMemory.getCacheAge(),
      context: {
        isWeekend: ctx.timeContext.isWeekend,
        isWorkHours: ctx.timeContext.isWorkHours,
        standupDone: ctx.standupDone,
        eodDone: ctx.eodDone,
        queueTotal: ctx.queueSummary?.total || 0,
        planProgress: ctx.ninetyDayPlan?.progress || null,
      },
      // Focus metadata
      totalCandidates: result.totalCandidates,
      returned: result.returned,
      suppressed: result.suppressed,
      tiers: result.tiers,
      // The items
      items: result.items,
    });
  } catch (e) {
    console.error('[Focus] Error:', e);
    res.status(500).json({ error: 'Failed to build focus', detail: e.message });
  }
});

// POST /api/focus/dismiss — user dismisses an item from focus
router.post('/dismiss', (req, res) => {
  const { itemId } = req.body;
  if (!itemId) return res.status(400).json({ error: 'itemId required' });
  engine.dismiss(itemId);
  res.json({ ok: true, dismissed: itemId });
});

module.exports = router;
