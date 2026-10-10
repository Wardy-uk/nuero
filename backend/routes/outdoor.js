'use strict';

/**
 * Outdoor Life (Build 29). Reads are open; every write is Nick's statement
 * and is refused to machine clients by the authority matrix. Hike confirm /
 * not-a-hike stay on /api/loops/hiking — one place decides a hike.
 */

const express = require('express');
const outdoor = require('../services/outdoor');

const router = express.Router();
const send = (res, r) => res.status(r.ok ? 200 : r.status || 400).json(r);

// GET /api/outdoor — Outdoor Life: this week, Hike weekly goal state, confirmed hikes, walks, refused (not a hike), route plans, weather, outdoor sources.
router.get('/', (req, res) => {
  try {
    if (req.query.weeks !== undefined && (!/^\d{1,2}$/.test(String(req.query.weeks)) || +req.query.weeks < 1 || +req.query.weeks > 26)) {
      return res.status(400).json({ ok: false, error: 'weeks must be a whole number from 1 to 26' });
    }
    res.json(outdoor.read({ weeks: req.query.weeks === undefined ? 4 : Number(req.query.weeks) }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/outdoor/routes — Nick adds a route plan (hike or walk, by hand or GPX file). A plan, never activity.
router.post('/routes', (req, res) => {
  const { name, kind, plannedDate, distanceKm, elevationGainM, region, difficulty, notes, emberPlanned, status, gpx } = req.body || {};
  try { send(res, outdoor.createRoute({ name, kind, plannedDate, distanceKm, elevationGainM, region, difficulty, notes, emberPlanned, status, gpx })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/outdoor/routes/:routeId — Nick changes a route plan (date, name, notes, cancel or re-plan via status).
router.post('/routes/:routeId', (req, res) => {
  const { name, kind, plannedDate, distanceKm, elevationGainM, region, difficulty, notes, emberPlanned, status, gpx } = req.body || {};
  try { send(res, outdoor.updateRoute(req.params.routeId, { name, kind, plannedDate, distanceKm, elevationGainM, region, difficulty, notes, emberPlanned, status, gpx })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/outdoor/activities/:activityId/route — Nick links a hike/walk to the planned route it followed. Explicit only.
router.post('/activities/:activityId/route', (req, res) => {
  const { routeId } = req.body || {};
  if (typeof routeId !== 'string') return res.status(400).json({ ok: false, error: 'routeId is required' });
  try { send(res, outdoor.linkRoute(req.params.activityId, routeId)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/outdoor/activities/:activityId/route/remove — Nick unlinks a route from an activity.
router.post('/activities/:activityId/route/remove', (req, res) => {
  try { send(res, outdoor.unlinkRoute(req.params.activityId)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/outdoor/activities/:activityId/companion — Nick says Ember (a companion) came on this walk or hike.
router.post('/activities/:activityId/companion', (req, res) => {
  const { companionId } = req.body || {};
  if (typeof companionId !== 'string') return res.status(400).json({ ok: false, error: 'companionId is required' });
  try { send(res, outdoor.addCompanion(req.params.activityId, companionId)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/outdoor/activities/:activityId/companion/remove — Nick removes a companion (Ember) from an activity.
router.post('/activities/:activityId/companion/remove', (req, res) => {
  const { companionId } = req.body || {};
  if (typeof companionId !== 'string') return res.status(400).json({ ok: false, error: 'companionId is required' });
  try { send(res, outdoor.removeCompanion(req.params.activityId, companionId)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Hike safety ─────────────────────────────────────────────────────────────
// Arming, extending, cancelling, checking in and the contacts are Nick's; the
// authority matrix refuses every one to machine clients — an agent that could
// check him in could silence the alert.
const hike = require('../services/hike-safety');

// GET /api/outdoor/safety — hike safety: the armed walk (route card, alert time, trail ages), recent walks, who gets the alert.
router.get('/safety', (req, res) => {
  try { res.json(hike.read()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/outdoor/safety/contacts — who gets the overdue alert email (hike safety contacts).
router.post('/safety/contacts', (req, res) => {
  const { contacts } = req.body || {};
  try { send(res, hike.setContacts(contacts)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/outdoor/safety/trips — arm a walk: GPX + approx start/finish → route card; alert if no check-in.
router.post('/safety/trips', async (req, res) => {
  const { gpx, gpxName, routeId, name, plannedStart, plannedFinish, graceMinutes, emberPlanned, notes } = req.body || {};
  try { send(res, await hike.arm({ gpx, gpxName, routeId, name, plannedStart, plannedFinish, graceMinutes, emberPlanned, notes })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/outdoor/safety/trips/:tripId/checkin — hike check-in: back safe; sends an all-clear if an alert went.
router.post('/safety/trips/:tripId/checkin', async (req, res) => {
  const { via } = req.body || {};
  try { send(res, await hike.checkIn(req.params.tripId, { via })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/outdoor/safety/trips/:tripId/extend — hike running late: push the check-in time back.
router.post('/safety/trips/:tripId/extend', (req, res) => {
  const { minutes } = req.body || {};
  try { send(res, hike.extend(req.params.tripId, minutes)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/outdoor/safety/trips/:tripId/cancel — cancel an armed hike before anyone is alerted.
router.post('/safety/trips/:tripId/cancel', (req, res) => {
  try { send(res, hike.cancel(req.params.tripId)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
