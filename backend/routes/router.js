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

/**
 * Close the attention records of an episode that has ended, so they leave
 * Controls and the next wedge is unambiguously a new one. Also closes the
 * single shared record every alert used before 15 Oct 2026 — the one that
 * silenced the 12-14 Oct wedge. Never throws: recovery must not fail a sample.
 */
function closeAlerts(startedAt) {
  try {
    const db = require('../db/database');
    const lifecycle = require('../services/attention-lifecycle');
    const refs = [...routerHealth.episodeAlertKeys(startedAt), routerHealth.LEGACY_ALERT_REF];
    for (const ref of refs) {
      const row = db.getOpenAttentionRecord(lifecycle.dedupeKeyForPush('router_health', ref));
      if (row) lifecycle.act(row.id, 'resolve', { resolution: 'gone', note: 'router recovered' });
    }
  } catch (e) {
    console.warn('[Router] could not close alerts:', e.message);
  }
}

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
      const ep = routerHealth.episode(assessment.state);
      if (ep && ep.key) {
        const line = routerHealth.headline(assessment);
        if (line) {
          // ⚠ SENT ON EVERY UNHEALTHY SAMPLE, deliberately. The key names the
          // episode and its level, and the attention lifecycle lets the first
          // one through and refuses the rest — so one push per wedge, plus one
          // more if it escalates from building to down. A push held by quiet
          // hours or the hourly cap is retried on the next sample instead of
          // being lost to a latch.
          //
          // Deliberately NOT in ALWAYS_DELIVER: nothing can be done at 03:00
          // and the weekly reboot is the net. A held alert arrives at 07:00.
          //
          // ⚠ POSITIONAL: sendToAll(title, body, data).
          require('../services/webpush')
            .sendToAll('SAiM — Router', line, { type: 'router_health', key: ep.key })
            .catch((e) => console.warn('[Router] alert failed:', e.message));
          announced = true;
        }
      } else if (ep && 'ended' in ep) {
        closeAlerts(ep.ended);
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
