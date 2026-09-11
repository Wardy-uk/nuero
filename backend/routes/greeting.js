'use strict';

/**
 * POST /api/greeting — claim a greeting for Nick arriving in a room.
 *
 * Called by sara/backend's arrival detector with the machine token. It is a POST
 * because a real claim WRITES (the cooldown ledger); `preview: true` gates and
 * composes without recording, for checking the voice.
 *
 * Body: { room: "study", preview?: boolean }
 * 200:  { speak, why, text, workHours, preview }
 */

const express = require('express');
const router = express.Router();
const greeting = require('../services/greeting');

const ROOM_RE = /^[a-z0-9-]{1,40}$/;

router.post('/', express.json({ limit: '4kb' }), async (req, res) => {
  const room = String((req.body && req.body.room) || '').trim();
  if (!ROOM_RE.test(room)) {
    return res.status(400).json({ ok: false, error: 'room must be a sensor room id, e.g. "study"' });
  }
  try {
    const out = await greeting.claim({ room, preview: req.body.preview === true });
    res.json({ ok: true, room, ...out });
  } catch (e) {
    console.error('[Greeting] claim failed:', e.message);
    // Never a 200 with speak:false — "chose silence" and "broke" are different.
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
