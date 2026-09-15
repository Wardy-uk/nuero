'use strict';

/**
 * /api/signals — every sense SAiM has, and whether it is actually working.
 *
 * READ-ONLY. This page must never be the reason something changed.
 */

const express = require('express');
const router = express.Router();
const signals = require('../services/signals');

router.get('/', async (req, res) => {
  try {
    // The room sensors live on SAiM (:3005). Read ONCE here and hand the result to
    // the snapshot, which judges it purely — rather than a network call per row.
    // A failure is passed through as a failed read, never as "no sensors".
    let rooms = { ok: false, why: 'the room sensors were not read', sensors: [] };
    try {
      rooms = await require('../services/room-presence').sensors(new Date());
    } catch (e) {
      rooms = { ok: false, why: e.message, sensors: [] };
    }
    res.json(signals.snapshot(new Date(), { rooms }));
  } catch (e) {
    console.error('[Signals] snapshot failed:', e.message);
    // An error is NOT a healthy set of senses. A 200 with an empty list here
    // would render as "everything is fine", which is the exact failure this
    // whole page exists to make impossible.
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/signals/room — which room, and nothing else.
//
// Hung here rather than on a router of its own because it belongs to the same
// question this file already answers ("what can she sense") and because
// server.js is regularly held open by a concurrent session on this repo.
//
// ⚠ It exists so the header does not poll `/api/attention/context`, which runs
// a full gather — Home Assistant, the calendar, location, working days — on
// every call. A banner refreshing every half minute must cost approximately
// nothing; `room-presence` holds a 5s cache, so this is a memory read most times
// it is asked.
router.get('/room', async (req, res) => {
  try {
    const roomPresence = require('../services/room-presence');
    const whereabouts = require('../services/whereabouts');
    const r = await roomPresence.read();

    // The town-scale answers, for when the house-scale one cannot see him — a
    // named zone (the office zone is 150m wide and twenty miles away, so unlike
    // `home` it has no boundary problem), else the phone's town once he is out.
    // `fromPhone` drops either once it is stale.
    let zone = null;
    let away = null;
    try {
      const ha = require('../services/ha');
      if (ha.isConfigured()) {
        ({ zone, away } = whereabouts.fromPhone(await ha.getPhoneStatus()));
      }
    } catch { /* a missing zone is simply a coarser answer, never an error */ }

    const w = whereabouts.describe(r, zone, away);
    return res.json({ ...r, label: w.label, kind: w.kind, known: w.known, why: w.why });

  } catch (e) {
    res.status(500).json({ known: false, room: null, why: e.message });
  }
});

// GET /api/signals/meeting — is he in one, and when is it due to end?
//
// Hung here for the same reason `/room` is: it belongs to "what can she sense", and
// it must be CHEAP. `attention.currentMeetingEvent` reads the local calendar cache
// and nothing else — no Graph call, no gather — because the office screen asks this
// while Nick is away from his desk.
//
// ⚠ A REAL MEETING ONLY. `isRealMeeting` requires `attendeesOther === true`, so a
// solo focus block never becomes "back at 14:30" — half his diary is those.
//
// ⚠ "Due to end", never "back at" as a promise: the scheduled end is a fact about
// the diary, not about when a man will return to his chair.
router.get('/meeting', (req, res) => {
  try {
    const attention = require('../services/attention');
    const now = new Date();
    const event = attention.currentMeetingEvent(now);
    if (!event) return res.json({ known: true, inMeeting: false, endsAt: null });
    const endsAt = event.end || event.end_time || null;
    return res.json({
      known: true,
      inMeeting: true,
      // The subject is deliberately NOT returned: this feeds a screen on a desk in
      // an open-plan office, and a customer's name on it is the VESTA redaction
      // rule one building along.
      endsAt,
      minutesLeft: endsAt ? Math.round((new Date(endsAt).getTime() - now.getTime()) / 60000) : null,
    });
  } catch (e) {
    // Not knowing is its own answer — the screen then says he is away from the desk
    // and stops, rather than inventing a return time.
    res.status(200).json({ known: false, why: e.message });
  }
});

module.exports = router;
