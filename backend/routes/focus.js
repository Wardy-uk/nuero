'use strict';

/**
 * Focus Route — GET /api/focus
 *
 * Phase 3A Activation: Returns decision output with AI-enriched
 * primary directive, per-item guidance, and ignore summary.
 *
 * Query params:
 *   ?all=true  — bypass limits, return all candidates
 *   ?noai=true — skip AI enhancement (return deterministic only)
 */

const express = require('express');
const router = express.Router();
const engine = require('../services/decision-engine');
const workingMemory = require('../services/working-memory');
const aiProvider = require('../services/ai-provider');

// ── AI enhancement cache (short-lived, 3 minutes) ──
let _aiCache = { hash: null, data: null, at: 0 };
const AI_CACHE_TTL = 3 * 60 * 1000;

function _itemsHash(items) {
  return items.map(i => i.id + ':' + i.score).join('|');
}

router.get('/', async (req, res) => {
  try {
    const showAll = req.query.all === 'true';
    const noAi = req.query.noai === 'true';
    const result = await engine.evaluate({ showAll });
    const ctx = await workingMemory.getContext();

    // ── Tone selection (deterministic) ──
    const tone = aiProvider.getTone(ctx);

    // ── AI enhancement (cached, non-blocking) ──
    let sara = null;
    if (!showAll && !noAi && result.items.length > 0) {
      const hash = _itemsHash(result.items);
      const now = Date.now();

      if (_aiCache.hash === hash && _aiCache.data && (now - _aiCache.at) < AI_CACHE_TTL) {
        // Cache hit
        sara = _aiCache.data;
      } else {
        // Cache miss — run AI enhancement with timeout
        try {
          const enhancePromise = aiProvider.enhanceFocus({
            items: result.items,
            context: ctx,
            tone,
            primaryItem: result.primaryItem,
          });

          // Race against a 15-second timeout — Pi 5 Ollama can be slow on first call
          const timeout = new Promise(resolve => setTimeout(() => resolve(null), 15000));
          sara = await Promise.race([enhancePromise, timeout]);

          if (sara) {
            _aiCache = { hash, data: sara, at: Date.now() };
          }
        } catch (e) {
          console.warn('[Focus] AI enhancement failed:', e.message);
          // sara stays null — deterministic fallback
        }
      }
    }

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
      totalCandidates: result.totalCandidates,
      returned: result.returned,
      suppressed: result.suppressed,
      tiers: result.tiers,
      mode: result.mode,
      tone,
      primaryItem: result.primaryItem || null,
      // AI enhancement (null if unavailable — frontend falls back gracefully)
      sara: sara || null,
      items: result.items,
    });
  } catch (e) {
    console.error('[Focus] Error:', e);
    res.status(500).json({ error: 'Failed to build focus', detail: e.message });
  }
});

// POST /api/focus/dismiss
router.post('/dismiss', (req, res) => {
  const { itemId, itemType } = req.body;
  if (!itemId) return res.status(400).json({ error: 'itemId required' });
  engine.dismiss(itemId, itemType);
  // Invalidate AI cache on dismiss
  _aiCache = { hash: null, data: null, at: 0 };
  res.json({ ok: true, dismissed: itemId });
});

module.exports = router;
