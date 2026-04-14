'use strict';

/**
 * Person Profile routes.
 *   POST /api/person-profile  { action, person, ... }
 */

const express = require('express');
const router = express.Router();
const personProfile = require('../services/person-profile');

router.post('/', (req, res) => {
  try {
    const result = personProfile.managePersonProfile(req.body || {});
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[person-profile]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
