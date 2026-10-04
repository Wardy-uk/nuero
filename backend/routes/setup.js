'use strict';

/**
 * /api/setup — the set-up wizard (services/setup-check.js). What has not been
 * set up, per device, judged from evidence, with how to fix each item.
 * Literal paths before parameterised ones.
 */

const express = require('express');
const setup = require('../services/setup-check');

const router = express.Router();
const fail = (res, e) => res.status(e.status || 500).json({ ok: false, error: e.message || String(e) });

// GET /api/setup — set-up wizard / onboarding checklist: what is not set up yet on the Pi, Windows laptop, iPhone NEURO and SAiM apps, Mac, life model and home screens, with the next step and how to fix each.
router.get('/', async (req, res) => {
  try { res.json(await setup.check()); } catch (e) { fail(res, e); }
});

// POST /api/setup/report — a device's own local set-up checks (setup.ps1 on Windows, the iOS Setup screen): platform (windows|ios|mac|watchos), app, host, checks[{id, ok, detail}].
router.post('/report', (req, res) => {
  try {
    const { platform, app, host, checks } = req.body || {};
    res.json({ ok: true, report: setup.report({ platform, app, host, checks }) });
  } catch (e) { fail(res, e); }
});

// POST /api/setup/skip/:id — mark a set-up item "not needed" (reversible; never marks it done).
router.post('/skip/:id', (req, res) => {
  try { setup.skip(String(req.params.id).slice(0, 80)); res.json({ ok: true }); } catch (e) { fail(res, e); }
});

// DELETE /api/setup/skip/:id — undo "not needed" on a set-up item.
router.delete('/skip/:id', (req, res) => {
  try { setup.unskip(String(req.params.id).slice(0, 80)); res.json({ ok: true }); } catch (e) { fail(res, e); }
});

module.exports = router;
