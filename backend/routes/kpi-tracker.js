'use strict';

/**
 * The Daily KPI Tracker — the rows Nick reports to the business every day.
 *
 * ── Why NEURO reads NOVA DIRECTLY ───────────────────────────────────────────
 *
 * VANTAGE has the same screen, reading the same bridge route. This does NOT
 * proxy through VANTAGE, and that is deliberate: NEURO already holds the bridge
 * credential and already calls `/api/neuro-bridge/*` for the weekly risk
 * report, so going NEURO → VANTAGE → NOVA would add a hop, a second cache and a
 * second thing to be down — for numbers NEURO can fetch itself in one call.
 *
 * ⚠ TWO SCREENS, ON PURPOSE AND TEMPORARILY. Nick asked for it in both so he
 * can find out which one he actually opens (17 Sep 2026). That is a real
 * duplication and it should not survive the decision — when he knows, the other
 * one goes. Both read the same NOVA route, so they cannot disagree about the
 * numbers while they coexist; what they can disagree about is presentation, and
 * that is the cost being accepted.
 *
 * ── What it does not do ─────────────────────────────────────────────────────
 *
 * No detection, no drift judgement, no cards. VANTAGE owns that (`leading.js`,
 * detectors T1 and T2) and a second implementation would drift from the one
 * that produces the warnings. This renders the tracker; it does not have an
 * opinion about it.
 *
 * Read-only.
 */

const express = require('express');

const router = express.Router();
const nova = require('../services/nova-client');

/** Bump when NOVA's kpi-tracker shape changes. */
const BUILD_EXPECTED = '2026-09-17-intraday-a';

/**
 * GET /api/kpi-tracker?days=28
 *
 * Passes NOVA's answer through with the shape a screen needs, and says what it
 * could not get rather than returning a shorter list.
 */
router.get('/', async (req, res) => {
  if (!nova.isConfigured()) {
    res.json({
      ok: true,
      data: { available: false, reason: 'NOVA bridge is not configured (NOVA_BRIDGE_URL / NOVA_BRIDGE_SECRET)' },
    });
    return;
  }

  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 28, 1), 400);

  try {
    const raw = await nova.call(`/api/neuro-bridge/kpi-tracker?days=${days}`, { timeoutMs: 120_000 });

    // A build NEURO does not recognise may have renamed or dropped a field, and
    // a field read as `undefined` renders as a blank cell that looks like a
    // measured zero. Same refusal VANTAGE makes against the same route.
    if (raw.build !== BUILD_EXPECTED) {
      res.json({
        ok: true,
        data: {
          available: false,
          reason: `NOVA is on kpi-tracker build "${raw.build || 'unknown'}"; NEURO reads "${BUILD_EXPECTED}". Redeploy NOVA.`,
        },
      });
      return;
    }

    const rows = raw.rows || [];
    const live = new Map((raw.live?.items || []).map(i => [i.key, i]));

    // Days covered, so the screen can say whether the hourly baseline is ready
    // rather than leaving a reader to count rows.
    const intradayDays = new Set();
    for (const s of raw.intraday?.series || []) for (const p of s.points) intradayDays.add(p.day);

    res.json({
      ok: true,
      data: {
        available: true,
        asOf: new Date().toISOString(),
        // Every row, including the three NOVA cannot compute. They carry their
        // reason instead of being dropped: a view showing only the measurable
        // rows would quietly redefine the tracker as the subset NOVA knows.
        rows: rows.map(r => {
          const item = r.kpiKey ? live.get(r.kpiKey) : null;
          return {
            label: r.label,
            key: r.kpiKey,
            extra: r.extra === true,
            measured: Boolean(r.kpiKey),
            reason: r.kpiKey ? null : 'no KPI key in the NOVA tracker spec — not computed, so not watched',
            value: item ? item.value : null,
            rag: item?.rag ?? null,
            target: item?.target ?? null,
            unit: item?.unit ?? null,
          };
        }),
        live: {
          available: Boolean(raw.live && !raw.liveError),
          error: raw.liveError || null,
          day: raw.live?.day || null,
          ageSeconds: raw.live?.ageSeconds ?? null,
        },
        hourly: {
          available: Boolean(raw.intraday && !raw.intradayError),
          error: raw.intradayError || null,
          daysCovered: intradayDays.size,
        },
      },
    });
  } catch (e) {
    // Loud, and never an empty tracker. "Could not read" and "every KPI is
    // zero" are opposite messages.
    res.status(502).json({ ok: false, error: `Could not read the tracker from NOVA: ${e.message}` });
  }
});

module.exports = router;
