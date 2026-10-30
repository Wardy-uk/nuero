'use strict';

/**
 * The single capture box (30 Oct 2026) — services/capture-hub.js.
 *
 * Most chips are filed by the route that already owns that record; this router
 * only holds the chip list, the guess, the picker lists, and the doors that did
 * not exist for a PIN client (waiting-on, decision, memory, household job,
 * shopping, tea, wall note).
 */

const express = require('express');
const router = express.Router();
const hub = require('../services/capture-hub');

// GET /api/capture-hub/kinds — the capture box's chips (where a capture can go) and the fields each needs. Keywords: capture kinds, destinations.
router.get('/kinds', (req, res) => {
  res.json({ ok: true, kinds: hub.kinds() });
});

// GET /api/capture-hub/options — picker lists for the capture forms: people, vehicles, companions, projects, catalogues. An unreadable list is null, never [].
router.get('/options', (req, res) => {
  try { res.json({ ok: true, ...hub.options() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/capture-hub/classify — guess which chip a capture belongs to (rules, then AI when unsure; Note is the floor). Body: { text, ai }. Files nothing. Keywords: capture guess, classify.
router.post('/classify', async (req, res) => {
  const { text, ai } = req.body || {};
  try {
    res.json({ ok: true, ...(await hub.classify(text, { ai: ai !== false })) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/capture-hub/file — file a capture whose chip has no other door: waiting (person), decision, memory, household job, shopping, tea (date), wall note. Body: { kind, text, fields }. Keywords: capture, waiting on, decision log, remember, household, shopping, tea, wall note.
router.post('/file', (req, res) => {
  const { kind, text, fields } = req.body || {};
  try {
    const r = hub.file(kind, text, fields || {}, { by: req.apiClient ? `machine:${req.apiClient}` : 'nick' });
    if (!r.ok) return res.status(r.status || 400).json(r);
    res.json(r);
  } catch (e) {
    console.error('[CaptureHub] File failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
