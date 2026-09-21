'use strict';

/**
 * POST /api/greeting — claim a greeting for Nick arriving.
 *
 * Called by saim/backend's arrival detector with the machine token, and by an
 * app on its own launch with the PIN. It is a POST because a real claim WRITES
 * (the cooldown ledger); `preview: true` gates and composes without recording,
 * for checking the voice.
 *
 * Body: { room: "study" } | { client: "saim-ios" }, plus optional preview
 * 200:  { speak, why, text, workHours, preview }
 *
 * ⚠ A ROOM OR A CLIENT, NEVER BOTH. They are two kinds of arrival with two
 * cooldowns (see `decide`), and a caller sending both has not decided which one
 * it is — answered as a 400 rather than by picking for it.
 */

const express = require('express');
const router = express.Router();
const greeting = require('../services/greeting');

const ROOM_RE = /^[a-z0-9-]{1,40}$/;
// ⚠ Deliberately the same shape as a room id — it is an id in a ledger either
// way, and a second, looser pattern is a second chance to admit something odd.
const CLIENT_RE = /^[a-z0-9-]{1,40}$/;

router.post('/', express.json({ limit: '4kb' }), async (req, res) => {
  const room = String((req.body && req.body.room) || '').trim();
  const client = String((req.body && req.body.client) || '').trim();

  if (room && client) {
    return res.status(400).json({ ok: false, error: 'send room or client, not both' });
  }
  if (!room && !client) {
    return res.status(400).json({ ok: false, error: 'room (e.g. "study") or client (e.g. "saim-ios") is required' });
  }
  if (room && !ROOM_RE.test(room)) {
    return res.status(400).json({ ok: false, error: 'room must be a sensor room id, e.g. "study"' });
  }
  if (client && !CLIENT_RE.test(client)) {
    return res.status(400).json({ ok: false, error: 'client must be an app id, e.g. "saim-ios"' });
  }

  try {
    const out = await greeting.claim({
      room: room || null,
      client: client || null,
      preview: req.body.preview === true,
    });
    res.json({ ok: true, ...(room ? { room } : { client }), ...out });
  } catch (e) {
    console.error('[Greeting] claim failed:', e.message);
    // Never a 200 with speak:false — "chose silence" and "broke" are different.
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
