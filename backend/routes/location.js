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
  const { name, lat, lng } = req.body;
  if (!name || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'name, lat, and lng required' });
  }

  try {
    const raw = db.getState('saved_places');
    const places = raw ? JSON.parse(raw) : [];

    // Update existing or add new
    const existing = places.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.lat = lat;
      existing.lng = lng;
      existing.updatedAt = new Date().toISOString();
    } else {
      places.push({
        name: name.trim(),
        lat,
        lng,
        radius: 200, // metres
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
