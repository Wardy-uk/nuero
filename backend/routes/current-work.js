'use strict';

// What he is working on, and what else shares its context.
//
// Read-only. There is no write here at all: this suggests, and every way of
// acting on a suggestion (start a session, tick a task, block time) already has
// its own route with its own rules. A second door onto those would be a second
// set of rules to keep in step.

const express = require('express');
const router = express.Router();

// GET /api/current-work — the resolver's answer on its own.
router.get('/', (req, res) => {
  try {
    res.json(require('../services/current-work').current(new Date()));
  } catch (e) {
    console.error('[current-work] resolve failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/current-work/while-here — plus the other tasks worth doing alongside.
router.get('/while-here', (req, res) => {
  try {
    res.json(require('../services/while-here').whileHere({ now: new Date() }));
  } catch (e) {
    console.error('[current-work] while-here failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
