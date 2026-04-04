'use strict';

/**
 * Focus Route — GET /api/focus
 *
 * Phase 4A: Fingerprint-cached. Skips decision engine + AI if nothing changed.
 *
 * Query params:
 *   ?all=true  — bypass limits, return all candidates
 *   ?noai=true — skip AI enhancement (return deterministic only)
 *   ?nocache=true — force full recomputation
 */

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const engine = require('../services/decision-engine');
const workingMemory = require('../services/working-memory');
const aiProvider = require('../services/ai-provider');
const vaultCache = require('../services/vault-cache');

// ── Full response cache (fingerprinted) ──
let _responseCache = { fingerprint: null, response: null, at: 0 };
const RESPONSE_CACHE_TTL = 3 * 60 * 1000; // 3 minutes

// ── AI enhancement cache ──
let _aiCache = { hash: null, data: null, at: 0 };
const AI_CACHE_TTL = 3 * 60 * 1000;

/**
 * Build a fingerprint from all inputs that could change the focus output.
 * If this hasn't changed, the result is identical — skip everything.
 */
function _buildFingerprint(ctx) {
  const parts = [
    // Queue state
    ctx.queueSummary?.total || 0,
    (ctx.queueSummary?.at_risk_tickets || []).length,
    ctx.unseenEscalations || 0,
    // Nudge state
    (ctx.nudges || []).map(n => `${n.id}:${n.nag_count}`).join(','),
    // Calendar next 2h
    (ctx.calendar || []).filter(e => {
      const start = new Date(e.start_time);
      return start > new Date() && start < new Date(Date.now() + 2 * 60 * 60 * 1000) && !e.is_all_day;
    }).map(e => e.event_id).join(','),
    // Todo state (mtime-based — changes when files change)
    vaultCache.getStats().misses, // bumps when vault files change
    // Activity state
    ctx.standupDone ? 'sd' : '',
    ctx.eodDone ? 'ed' : '',
    ctx.pendingImports || 0,
    // Observations count (changes trigger different tone)
    (ctx.observations || []).length,
    ctx.snoozeCount || 0,
    ctx.dismissCount || 0,
  ];

  return crypto.createHash('md5').update(parts.join('|')).digest('hex').substring(0, 12);
}

function _itemsHash(items) {
  return items.map(i => i.id + ':' + i.score).join('|');
}

router.get('/', async (req, res) => {
  const t0 = Date.now();

  try {
    const showAll = req.query.all === 'true';
    const noAi = req.query.noai === 'true';
    const noCache = req.query.nocache === 'true';

    // ── Check fingerprint cache (skip everything if unchanged) ──
    if (!showAll && !noCache) {
      const ctx = await workingMemory.getContext();
      const fingerprint = _buildFingerprint(ctx);
      const now = Date.now();

      if (_responseCache.fingerprint === fingerprint &&
          _responseCache.response &&
          (now - _responseCache.at) < RESPONSE_CACHE_TTL) {
        // Full cache hit — return immediately
        console.log(`[Focus] Cache HIT (${Date.now() - t0}ms, fp=${fingerprint.substring(0, 6)})`);
        return res.json(_responseCache.response);
      }
    }

    // ── Cache miss — run full pipeline ──
    const result = await engine.evaluate({ showAll });
    const ctx = await workingMemory.getContext();
    const tone = aiProvider.getTone(ctx);

    console.log(`[Focus] Engine: ${Date.now() - t0}ms`);

    // ── SARA block (always present) ──
    let sara = null;
    if (!showAll && result.items.length > 0) {
      const hash = _itemsHash(result.items);
      const now = Date.now();

      // Check AI cache first
      if (!noAi && _aiCache.hash === hash && _aiCache.data && (now - _aiCache.at) < AI_CACHE_TTL) {
        sara = _aiCache.data;
      }

      // If no cached AI result, use deterministic fallback (always instant)
      if (!sara) {
        sara = aiProvider.buildDeterministicSara(result.items, tone);
      }

      // Trigger async AI pre-generation for NEXT request (non-blocking)
      if (!noAi && _aiCache.hash !== hash) {
        aiProvider.enhanceFocus({
          items: result.items,
          context: ctx,
          tone,
          primaryItem: result.primaryItem,
        }).then(aiSara => {
          if (aiSara) {
            _aiCache = { hash, data: aiSara, at: Date.now() };
            console.log(`[Focus] AI SARA pre-generated (${aiSara.provider})`);
          }
        }).catch(e => {
          console.warn('[Focus] Async AI pre-generation failed:', e.message);
        });
      }
    }

    // ── Generate suggestions (max 2, deterministic, no AI) ──
    let suggestions = [];
    if (!showAll && result.items.length > 0) {
      try {
        const suggestionEngine = require('../services/suggestion-engine');
        const raw = suggestionEngine.generateSuggestions(result.items);
        suggestions = suggestionEngine.persistSuggestions(raw);
      } catch (e) {
        console.warn('[Focus] Suggestion generation failed:', e.message);
      }
    }

    const response = {
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
      sara: sara || null,
      suggestions,
      items: result.items,
    };

    // ── Store in fingerprint cache ──
    if (!showAll) {
      const fingerprint = _buildFingerprint(ctx);
      _responseCache = { fingerprint, response, at: Date.now() };
      console.log(`[Focus] Built in ${Date.now() - t0}ms (fp=${fingerprint.substring(0, 6)}, items=${result.items.length}, sara=${sara ? 'yes' : 'no'})`);
    }

    res.json(response);
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
  // Invalidate all caches on dismiss
  _responseCache = { fingerprint: null, response: null, at: 0 };
  _aiCache = { hash: null, data: null, at: 0 };
  res.json({ ok: true, dismissed: itemId });
});

module.exports = router;
