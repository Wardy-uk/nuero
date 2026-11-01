'use strict';

/**
 * Personal automations (1 Nov 2026) — all PERSONAL, nothing sent anywhere.
 *   GET  /api/personal-auto                         everything below, in one read (Now, Outdoor, Personal Admin)
 *   GET  /api/personal-auto/renewals                the renewal watch: last pass + sources it could not read
 *   GET  /api/personal-auto/tea-shopping            tea → shopping switch and last pass
 *   POST /api/personal-auto/tea-shopping            switch it on/off. Body: { on: true|false }
 *   GET  /api/personal-auto/hike-suggestion         this weekend's suggestion (or why there is none)
 *   POST /api/personal-auto/hike-suggestion/dismiss "Not this weekend". Body: { weekend: 'YYYY-MM-DD' (Saturday) }
 *   GET  /api/personal-auto/gp-packs                GP packs ready for appointments still to come
 * Every POST is Nick's (machine-refused in the authority matrix, interactive on the MCP gateway).
 */

const express = require('express');
const router = express.Router();

function refuseMachine(req, res) {
  if (req.apiClient || req.get('X-Neuro-Machine-Client')) { res.status(403).json({ ok: false, error: 'This is Nick’s decision, made in NEURO.' }); return true; }
  return false;
}

function safe(fn) { try { return fn(); } catch (e) { return { ok: false, error: e.message }; } }

router.get('/', (req, res) => {
  res.json({
    ok: true,
    renewals: safe(() => require('../services/renewal-watch').status()),
    teaShopping: safe(() => require('../services/tea-shopping').status()),
    hike: safe(() => require('../services/hike-suggestion').read()),
    gpPacks: safe(() => require('../services/gp-pack').ready()),
  });
});

router.get('/renewals', (req, res) => res.json({ ok: true, ...require('../services/renewal-watch').status() }));

router.get('/tea-shopping', (req, res) => res.json({ ok: true, ...require('../services/tea-shopping').status() }));

// POST /api/personal-auto/tea-shopping — switch tea → shopping on or off. Body: { on }
router.post('/tea-shopping', (req, res) => {
  if (refuseMachine(req, res)) return;
  const { on } = req.body || {};
  const r = require('../services/tea-shopping').setEnabled(on, { by: 'nick' });
  res.status(r.ok ? 200 : (r.status || 400)).json(r);
});

router.get('/hike-suggestion', (req, res) => res.json(require('../services/hike-suggestion').read()));

// POST /api/personal-auto/hike-suggestion/dismiss — "Not this weekend". Body: { weekend }
router.post('/hike-suggestion/dismiss', (req, res) => {
  if (refuseMachine(req, res)) return;
  const { weekend } = req.body || {};
  const r = require('../services/hike-suggestion').dismiss(weekend);
  res.status(r.ok ? 200 : (r.status || 400)).json(r);
});

router.get('/gp-packs', (req, res) => res.json({ ok: true, packs: require('../services/gp-pack').ready() }));

module.exports = router;
