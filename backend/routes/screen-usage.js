'use strict';

/**
 * GET /api/screen-usage — which screens get opened, across all three surfaces.
 *
 * READ-ONLY. This panel must never be the reason something changed
 * (`state-of-play`'s rule), and it records nothing of its own: the recording is
 * `POST /api/activity/tab`, which every surface already calls.
 */

const express = require('express');
const router = express.Router();
const screenUsage = require('../services/screen-usage');

router.get('/', (req, res) => {
  // A nonsense window falls back to the default rather than to the nearest
  // legal value — `limit=-5` clamping to 1 returns one column and looks like
  // the truth (`sent-replies`' rule).
  const raw = Number.parseInt(req.query.weeks, 10);
  const weeks = Number.isInteger(raw) && raw > 0 && raw <= 52 ? raw : undefined;

  try {
    res.json(screenUsage.build({ weeks }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
