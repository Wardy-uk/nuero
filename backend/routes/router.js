'use strict';

/**
 * /api/router — where the pi5 watcher posts the home router's vitals.
 *
 * The same shape as /api/desktop: an outbound-only agent samples a machine
 * NEURO cannot otherwise see, and posts what it found. Nothing here reaches
 * back to the router, and nothing here can change it.
 *
 * ⚠ The sample carries NUMBERS and PROCESS NAMES only — load, task counts,
 * D-state count, free memory, nvram headroom. Never a client list, never a MAC,
 * never a hostname off the LAN. The question this answers is "is the router
 * healthy", and who is connected to it is a different question with a very
 * different privacy weight.
 *
 * Machine client: authenticated by the app-level NEURO_API_TOKEN header like
 * n8n and the other scheduled callers, not by the PIN.
 */

const express = require('express');
const router = express.Router();
const routerHealth = require('../services/router-health');

// POST /api/router/sample — one reading from the watcher.
router.post('/sample', (req, res) => {
  try {
    const stored = routerHealth.record(req.body || {});
    const assessment = routerHealth.current();

    // ⚠ The alert rides the RESPONSE decision, not a timer: this is the only
    // moment new evidence exists, so it is the only moment worth judging. A
    // failure to notify must never cost the sample that was just stored.
    let announced = false;
    try {
      if (routerHealth.shouldAnnounce(assessment.state)) {
        const line = routerHealth.headline(assessment);
        if (line) {
          // Deliberately NOT in ALWAYS_DELIVER: this respects quiet hours. The
          // failure takes ~18 days to build and the weekly reboot is the safety
          // net, so there is nothing Nick can usefully do about it at 03:00 —
          // and nudge volume is the one budget allowed to argue against
          // building more.
          // ⚠ POSITIONAL: sendToAll(title, body, data). Passing one object put
          // the object in the TITLE slot, so every router alert arrived as
          // "[object Object]" with an empty body and no `type` — which also
          // cost it the classification `router_health` was written for. Live on
          // 21 Sep 2026, on a morning the router was genuinely wedging.
          require('../services/webpush').sendToAll(
            'SAiM — Router',
            line,
            { type: 'router_health' }
          );
          announced = true;
        }
      }
    } catch (e) {
      console.warn('[Router] could not raise alert:', e.message);
    }

    res.json({ ok: true, sample: stored, state: assessment.state, announced });
  } catch (e) {
    console.error('[Router] record failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/router/health — the current read. Read-only; nothing notifies.
router.get('/health', (req, res) => {
  try {
    const a = routerHealth.current();
    res.json({
      state: a.state,
      why: a.why || null,
      issues: a.issues,
      headline: routerHealth.headline(a),
      ageMinutes: a.ageMinutes ?? null,
      sampleCount: a.sampleCount,
      latest: a.latest,
      // ⚠ Two data points is not an onset curve. No screen may present these
      // thresholds as measured until a real build-up has been captured.
      provisional: a.provisional,
    });
  } catch (e) {
    console.error('[Router] health failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
