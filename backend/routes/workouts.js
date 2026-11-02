'use strict';

/**
 * A workout, looked at properly (2 Nov 2026) — `/api/workouts`. Reads are
 * open; adding a photo is the NEURO iOS app (PIN), removing one is Nick.
 * Literal paths are registered BEFORE `/:id`, which would otherwise swallow them.
 */

const express = require('express');
const view = require('../services/workout-view');

const router = express.Router();
const send = (res, r) => res.status(r.ok ? 200 : r.status || 400).json(r);

// GET /api/workouts — every workout with a watch GPS track (hikes, walks, runs, rides), newest first: distance, time, ascent, photo count, a thin line for a thumbnail map.
router.get('/', (req, res) => {
  try { res.json(view.list({ limit: req.query.limit ? Number(req.query.limit) : 200 })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/workouts/last-hike — the newest hike's whole page (Life → Outdoor's lead card).
router.get('/last-hike', (req, res) => {
  try { send(res, view.lastHike()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/workouts/photo-windows — for the iOS app: each tracked workout's start/end, which photos NEURO already holds and which Nick removed (never send those again).
router.get('/photo-windows', (req, res) => {
  try { res.json(view.photoWindows()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/workouts/photos/:photoId — one workout photo as a JPEG (?size=thumb for the small one).
router.get('/photos/:photoId', (req, res) => {
  const file = view.photoFile(req.params.photoId, req.query.size === 'thumb' ? 'thumb' : 'full');
  if (!file) return res.status(404).json({ ok: false, error: 'no such photo' });
  res.set('Cache-Control', 'private, max-age=604800, immutable');
  res.type('image/jpeg').sendFile(file);
});

// POST /api/workouts/photos/:photoId/remove — Nick removes a photo from a workout: the files are deleted and the phone never sends it again.
router.post('/photos/:photoId/remove', (req, res) => {
  try {
    const r = view.removePhoto(req.params.photoId);
    if (r.ok && r.workoutId) {
      try {
        const v = view.read(r.workoutId);
        if (v.ok) require('../services/workout-notes').dropMedia(v.workout.day, req.params.photoId);
        require('../services/workout-notes').syncOne(r.workoutId);
      } catch (e) { console.warn(`[Workouts] note refresh after photo removal failed: ${e.message}`); }
    }
    send(res, r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/workouts/notes/sync — write or refresh the hike notes in the vault (Personal/Hikes) now rather than at the next pass.
router.post('/notes/sync', (req, res) => {
  try { res.json(require('../services/workout-notes').sync({ max: 50 })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/workouts/:id — one workout's whole page: map track, watch and track figures, elevation profile, heart rate, splits, body, weather where he walked, the home station, the carried logger, Ember, route plan, hike verdict, same-route history, photos, vault note.
router.get('/:id', (req, res) => {
  try { send(res, view.read(req.params.id)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/workouts/:id/photos — the iOS app adds one photo taken during a workout (resized JPEG + thumbnail, base64). A re-send folds; a removed photo is refused.
router.post('/:id/photos', (req, res) => {
  const { assetId, takenAt, lat, lon, width, height, full, thumb } = req.body || {};
  try {
    const r = view.storePhoto(req.params.id, { assetId, takenAt, lat, lon, width, height, full, thumb });
    if (r.ok && !r.already) {
      // The vault note picks the new photo up on the next pass; nothing is waited for here.
      setImmediate(() => { try { require('../services/workout-notes').syncOne(Number(req.params.id)); } catch { /* next pass */ } });
    }
    send(res, r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/workouts/:id/send-to-site — send this hike to Walking with Ember as a DRAFT page (one commit to the site's main; home trimmed 400 m; photos cleaned of metadata). A re-send updates track/photos/weather and never touches the page text.
router.post('/:id/send-to-site', async (req, res) => {
  try {
    const r = await require('../services/wwe-send').send(req.params.id);
    send(res, r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
