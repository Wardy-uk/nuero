'use strict';

/**
 * /api/health/hume — Hume Band V1 captures from the NEURO iOS app (24 Oct 2026).
 * Everything here is EXPERIMENTAL Hume data, kept apart from HiLo/cuff BP.
 * See services/hume-band.js.
 */

const express = require('express');
const hume = require('../services/hume-band');

const router = express.Router();

function fail(res, e) {
  if (e instanceof hume.Refused) return res.status(400).json({ ok: false, error: e.message, problems: e.problems });
  console.error('[Hume]', e.message);
  return res.status(500).json({ ok: false, error: e.message });
}

// POST /api/health/hume/captures — one Hume band capture bundle (a foreground
// sync or a live measurement): raw packets + device + phone timezone. NEURO
// decodes and stores it; a re-upload of the same bundle folds. Keywords: hume,
// band, experimental blood pressure, capture upload, ble sync.
router.post('/captures', (req, res) => {
  const {
    bundleId, kind, status, device, phone, startedAt, finishedAt, error, pages, stopSent,
    liveDurationSeconds, decoderVersion, clientDecoded, packets,
  } = req.body || {};
  try {
    const result = hume.ingest({
      bundleId, kind, status, device, phone, startedAt, finishedAt, error, pages, stopSent,
      liveDurationSeconds, decoderVersion, clientDecoded, packets,
    }, { client: req.get('X-Neuro-Client') || req.apiClient || null });
    res.json(result);
  } catch (e) { fail(res, e); }
});

// GET /api/health/hume/status — what NEURO holds from the Hume band: devices,
// last sync, captured range, latest experimental BP. Keywords: hume, band status.
router.get('/status', (req, res) => {
  try { res.json(hume.status()); } catch (e) { fail(res, e); }
});

// GET /api/health/hume/records — decoded Hume history records (experimental),
// newest first. Query: from, to (ISO), limit (1-1000), deviceId.
router.get('/records', (req, res) => {
  try { res.json(hume.records({ deviceId: req.query.deviceId, from: req.query.from, to: req.query.to, limit: req.query.limit || 200 })); } catch (e) { fail(res, e); }
});

// GET /api/health/hume/runs — Hume sync runs and how each transfer ended.
router.get('/runs', (req, res) => {
  try { res.json(hume.runs({ limit: req.query.limit })); } catch (e) { fail(res, e); }
});

// GET /api/health/hume/live — Hume live measurement sessions (?updates=1 for each update).
router.get('/live', (req, res) => {
  try { res.json(hume.liveSessions({ limit: req.query.limit, withUpdates: req.query.updates === '1' })); } catch (e) { fail(res, e); }
});

// GET /api/health/hume/calibrations — Hume BP calibration as read at capture time.
router.get('/calibrations', (req, res) => {
  try { res.json(hume.calibrations({ limit: req.query.limit })); } catch (e) { fail(res, e); }
});

// GET /api/health/hume/captures/:bundleId/packets — the raw evidence of one capture.
router.get('/captures/:bundleId/packets', (req, res) => {
  try { res.json(hume.bundlePackets(req.params.bundleId)); } catch (e) { fail(res, e); }
});

module.exports = router;
