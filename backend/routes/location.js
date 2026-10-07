'use strict';

const express = require('express');
const router = express.Router();
const location = require('../services/location');
const locationHistory = require('../services/location-history');
const db = require('../db/database');

// GET /api/location/today — today's dwell summary
router.get('/today', async (req, res) => {
  try {
    const dwells = await location.getCachedDwells();
    res.json({ dwells, configured: location.isConfigured() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/location/status
router.get('/status', (req, res) => {
  res.json({ configured: location.isConfigured() });
});

// ── Device-pushed position ───────────────────────────────────────────────────
//
// The door that lets a native iOS app be the position source, so the OwnTracks
// chain (app → Mosquitto → Recorder → poll) stops being load-bearing. Both
// paths are literal; registered together and before nothing in particular,
// since this router has no parameterised sibling at the top level — but see the
// route-order warning in `routes/mobile.js` before adding one.
//
// Auth is the app-level PIN / API-token middleware in server.js. Nothing here
// is exempted: unlike the `/api/v1` FreeReps mount, which had to fall back to a
// Tailscale-header source guard because that app has nowhere to put a
// credential, a native app holds one in the Keychain properly.

/**
 * POST /api/location/points — a batch of positions from a device.
 *
 * Body: `{ deviceId, points: [{ lat, lon, tst, acc? }], source? }`
 * `tst` is unix SECONDS (the OwnTracks convention the clustering expects).
 *
 * ⚠ 200 WITH A RECEIPT, even when individual points were rejected. The batch
 * was accepted and every point is accounted for; a non-2xx would make the phone
 * retry a queue it has already delivered, forever. Only a malformed BATCH is a
 * 400, and only a storage failure is a 503 — which the device must retry,
 * because in that case nothing was written.
 */
router.post('/points', (req, res) => {
  const locationPoints = require('../services/location-points');
  const body = req.body || {};

  const batch = locationPoints.validateBatch({
    deviceId: body.deviceId,
    points: body.points,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  const nativeEvents = require('../services/native-events');
  if (!batch.ok) {
    nativeEvents.recordDeliveryFailure({ kind: 'location', headers: req.headers, deviceId: body.deviceId, error: batch.reason, reason: 'malformed' });
    return res.status(400).json({ ok: false, error: batch.reason });
  }

  try {
    const { stored, duplicate } = locationPoints.store(batch.deviceId, batch.accepted, body.source);
    // Build 2: WHEN and how accurately — never where — onto the event spine,
    // after the write, and never able to fail it.
    nativeEvents.recordLocationBatch({ headers: req.headers, deviceId: batch.deviceId, accepted: batch.accepted, stored });
    // Build 16G: the phone's durable-queue report (counts only) — a late replay
    // or a quarantine becomes ONE Activity line, never one per upload.
    nativeEvents.recordQueueReport({ headers: req.headers, deviceId: batch.deviceId, report: body.queue,
      acceptedTsts: batch.accepted.map((p) => p.tst), stored });
    // Never log a coordinate. Counts describe the health of the feed without
    // writing where Nick was into the process log.
    if (stored > 0) console.log(`[Location] ${stored} new points from ${batch.deviceId}`);
    res.json({
      ok: true,
      received: batch.received,
      stored,
      duplicate,
      rejected: batch.rejected,
      rejectedReasons: batch.rejectedReasons,
    });
  } catch (e) {
    // Nothing was recorded, so the device must send this batch again.
    console.error('[Location] point ingest failed:', e.message);
    nativeEvents.recordDeliveryFailure({ kind: 'location', headers: req.headers, deviceId: batch.deviceId, error: e.message, reason: 'store-failed' });
    res.status(503).json({ ok: false, error: e.message, retryable: true });
  }
});

/**
 * GET /api/location/points/status — is the device feed alive?
 *
 * ⚠ This is the alarm for the free-provisioning 7-day expiry. When the app's
 * signature lapses iOS stops launching it and background location dies with no
 * error and no notification — the feed just goes quiet, which is exactly what a
 * day at home looks like. `stale` is what makes that loud.
 *
 * Three states stay distinct here: `known:false` (nothing has ever arrived —
 * never started, so no age is reported), `stale:true` (it worked and stopped),
 * and `readable:false` (the store could not be read at all, which is a
 * different fault from either).
 */
router.get('/points/status', (req, res) => {
  const locationPoints = require('../services/location-points');
  res.json({ ok: true, feed: locationPoints.freshness() });
});

// ── Visits and geofences (5 Oct 2026) ───────────────────────────────────────
//
// What the phone knows that a position point cannot carry: that he is STILL
// somewhere (an open CLVisit), and that he is inside one of his saved places
// (region monitoring). See services/place-sensing.js. Same receipt discipline
// as /points: a batch is 200 with every item accounted for, only a malformed
// batch is a 400, only a failed write is a 503. Nothing here logs a coordinate
// or a place name.

/**
 * POST /api/location/visits — CLVisit records from the phone.
 *
 * Body: `{ deviceId, visits: [{ lat, lon, arrival, departure, acc? }] }`,
 * times in unix SECONDS, `departure: null` while he is still there. The second
 * delivery of a visit (with its departure) updates the first.
 */
router.post('/visits', (req, res) => {
  const placeSensing = require('../services/place-sensing');
  const body = req.body || {};
  const batch = placeSensing.validateVisits({
    deviceId: body.deviceId, visits: body.visits, nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!batch.ok) return res.status(400).json({ ok: false, error: batch.reason });
  try {
    const r = placeSensing.storeVisits(batch.deviceId, batch.accepted);
    if (r.stored || r.updated) console.log(`[Location] visits from ${batch.deviceId}: ${r.stored} new, ${r.updated} closed`);
    res.json({ ok: true, received: batch.received, ...r, rejected: batch.rejected, rejectedReasons: batch.rejectedReasons });
  } catch (e) {
    console.error('[Location] visit ingest failed:', e.message);
    res.status(503).json({ ok: false, error: e.message, retryable: true });
  }
});

/**
 * GET /api/location/visits?hours=24 — visits in the window, plus whether he is
 * mid-visit now (`current`). `current.known:false` means no visit has arrived,
 * which is a different fact from `current.stay: null` (the last one closed).
 */
router.get('/visits', (req, res) => {
  const placeSensing = require('../services/place-sensing');
  const hours = req.query.hours === undefined ? 24 : Number(req.query.hours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 31) {
    return res.status(400).json({ ok: false, error: 'hours must be a number above 0 and at most 744' });
  }
  try {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const visits = placeSensing.visitsBetween(nowSeconds - Math.round(hours * 3600), nowSeconds);
    res.json({ ok: true, hours, visits, current: placeSensing.readCurrentStay() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/location/regions — the saved places the phone should geofence.
 *
 * `truncated` is how many saved places did NOT fit under iOS's 20-region cap,
 * so a place that is never monitored is visible rather than silently skipped.
 */
router.get('/regions', (req, res) => {
  const placeSensing = require('../services/place-sensing');
  const saved = placeSensing.savedPlaces();
  if (!saved.ok) return res.status(503).json({ ok: false, error: `could not read saved places: ${saved.why}` });
  res.json({ ok: true, ...placeSensing.monitorablePlaces(saved.places) });
});

/**
 * POST /api/location/regions/events — geofence crossings and determinations.
 *
 * Body: `{ deviceId, events: [{ place, kind: enter|exit|inside|outside, tst }] }`.
 * An event about a place that is not saved is refused by name.
 */
router.post('/regions/events', (req, res) => {
  const placeSensing = require('../services/place-sensing');
  const body = req.body || {};
  const saved = placeSensing.savedPlaces();
  if (!saved.ok) return res.status(503).json({ ok: false, error: `could not read saved places: ${saved.why}`, retryable: true });
  const batch = placeSensing.validateRegionEvents({
    deviceId: body.deviceId, events: body.events,
    placeNames: saved.places.map((p) => p.name), nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!batch.ok) return res.status(400).json({ ok: false, error: batch.reason });
  try {
    const r = placeSensing.storeRegionEvents(batch.deviceId, batch.accepted);
    res.json({ ok: true, received: batch.received, ...r, rejected: batch.rejected, rejectedReasons: batch.rejectedReasons });
  } catch (e) {
    console.error('[Location] region event ingest failed:', e.message);
    res.status(503).json({ ok: false, error: e.message, retryable: true });
  }
});

/** GET /api/location/regions/state — which saved place the phone says he is in. */
router.get('/regions/state', (req, res) => {
  const placeSensing = require('../services/place-sensing');
  res.json({ ok: true, ...placeSensing.readCurrentPlace() });
});

// GET /api/location/places — list saved named places
router.get('/places', (req, res) => {
  try {
    const raw = db.getState('saved_places');
    const places = raw ? JSON.parse(raw) : [];
    res.json({ places });
  } catch (e) {
    res.json({ places: [] });
  }
});

// POST /api/location/places — save a named place
router.post('/places', (req, res) => {
  const { name, lat, lng, kind, radius } = req.body;
  if (!name || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'name, lat, and lng required' });
  }
  // `kind` and `radius` are optional; OMITTED leaves what is stored alone, while
  // a present-but-invalid value is refused rather than quietly ignored. `kind`
  // is what lets a geofence say "work" — see place-sensing / life-state.
  const { PLACE_KINDS, MIN_RADIUS_M, MAX_RADIUS_M } = require('../services/place-sensing');
  if (kind !== undefined && kind !== null && !PLACE_KINDS.includes(kind)) {
    return res.status(400).json({ error: `kind must be one of ${PLACE_KINDS.join(', ')}` });
  }
  if (radius !== undefined && (typeof radius !== 'number' || !Number.isFinite(radius) || radius < MIN_RADIUS_M || radius > MAX_RADIUS_M)) {
    return res.status(400).json({ error: `radius must be a number of metres from ${MIN_RADIUS_M} to ${MAX_RADIUS_M}` });
  }

  try {
    const raw = db.getState('saved_places');
    const places = raw ? JSON.parse(raw) : [];

    // Update existing or add new
    const existing = places.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.lat = lat;
      existing.lng = lng;
      if (kind !== undefined) existing.kind = kind;
      if (radius !== undefined) existing.radius = radius;
      existing.updatedAt = new Date().toISOString();
    } else {
      places.push({
        name: name.trim(),
        lat,
        lng,
        radius: radius !== undefined ? radius : 200, // metres
        ...(kind ? { kind } : {}),
        createdAt: new Date().toISOString()
      });
    }

    db.setState('saved_places', JSON.stringify(places));
    console.log(`[Location] Saved place: ${name} (${lat}, ${lng})`);
    res.json({ ok: true, places });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/location/places/:name — remove a saved place
router.delete('/places/:name', (req, res) => {
  try {
    const raw = db.getState('saved_places');
    const places = raw ? JSON.parse(raw) : [];
    const filtered = places.filter(p => p.name.toLowerCase() !== req.params.name.toLowerCase());
    db.setState('saved_places', JSON.stringify(filtered));
    res.json({ ok: true, places: filtered });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/location/checkin — record that user is at a named place now
router.post('/checkin', (req, res) => {
  const { lat, lng } = req.body;
  if (lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'lat and lng required' });
  }

  try {
    const raw = db.getState('saved_places');
    const places = raw ? JSON.parse(raw) : [];

    // Find which saved place the user is near (within radius)
    const match = findNearestPlace(places, lat, lng);

    // Record the check-in
    const checkin = {
      lat,
      lng,
      place: match ? match.name : null,
      time: new Date().toISOString()
    };
    db.setState('last_checkin', JSON.stringify(checkin));

    // Log to activity
    try {
      require('../services/activity').trackTabOpen(`checkin:${match ? match.name : 'unknown'}`);
    } catch {}

    res.json({ ok: true, place: match ? match.name : null, checkin });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/location/dwell-check — check if user has been at current location long enough to prompt
router.get('/dwell-check', (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.json({ shouldPrompt: false });

  try {
    const raw = db.getState('saved_places');
    const places = raw ? JSON.parse(raw) : [];
    const match = findNearestPlace(places, parseFloat(lat), parseFloat(lng));

    if (match) {
      // Already a known place — no prompt needed
      return res.json({ shouldPrompt: false, knownPlace: match.name });
    }

    // Check if user has been near this location for > 30 min (based on last GPS update)
    const lastCheckinRaw = db.getState('last_checkin');
    const lastCheckin = lastCheckinRaw ? JSON.parse(lastCheckinRaw) : null;

    if (lastCheckin && !lastCheckin.place) {
      const dist = distanceMetres(parseFloat(lat), parseFloat(lng), lastCheckin.lat, lastCheckin.lng);
      const elapsed = Date.now() - new Date(lastCheckin.time).getTime();
      const minutesAtLocation = Math.floor(elapsed / 60000);

      if (dist < 300 && minutesAtLocation >= 30) {
        return res.json({
          shouldPrompt: true,
          minutesAtLocation,
          lat: parseFloat(lat),
          lng: parseFloat(lng)
        });
      }
    }

    // First time seeing this location — record it silently
    if (!lastCheckin || distanceMetres(parseFloat(lat), parseFloat(lng), lastCheckin.lat, lastCheckin.lng) > 300) {
      db.setState('last_checkin', JSON.stringify({
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        place: null,
        time: new Date().toISOString()
      }));
    }

    res.json({ shouldPrompt: false });
  } catch (e) {
    res.json({ shouldPrompt: false });
  }
});

// GET /api/location/history — location visit history
router.get('/history', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const summary = locationHistory.getHistorySummary(days);
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/location/frequent — frequently visited places
router.get('/frequent', (req, res) => {
  try {
    const frequent = db.getFrequentLocations(30, 2);
    const unnamed = locationHistory.getUnnamedFrequentLocations(3);
    res.json({ frequent, suggestNaming: unnamed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/location/record — manually trigger today's dwell recording
router.post('/record', async (req, res) => {
  try {
    const result = await locationHistory.recordTodaysDwells();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function distanceMetres(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearestPlace(places, lat, lng) {
  for (const place of places) {
    const dist = distanceMetres(lat, lng, place.lat, place.lng);
    if (dist <= (place.radius || 200)) {
      return place;
    }
  }
  return null;
}

module.exports = router;
