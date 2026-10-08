'use strict';

/**
 * Medical records — test results, diagnoses and prescriptions from the NHS app.
 * The rules live in services/medical-records.js; this file is transport.
 *
 * ⚠ Screenshots are never logged, stored or echoed back — not in an error
 * message either.
 *
 * CommonJS — NEURO backend convention.
 */

const express = require('express');
const medical = require('../services/medical-records');

const router = express.Router();

// Who entered a record: Nick through the PIN, or a machine client (the gateway's
// API token / a declared machine). `client` in the body is a self-declared
// label ("chatgpt") kept beside it, never trusted as identity.
function _enteredBy(req, client) {
  const label = typeof client === 'string' ? client.replace(/[^a-z0-9._-]/gi, '').slice(0, 30) : '';
  const who = req.apiClient ? `machine:${req.apiClient}` : 'nick';
  return label ? `${who} (${label})` : who;
}

// GET /api/medical/records — Nick's NHS medical record: test results, diagnoses, prescriptions, newest first, with counts. Keywords: medical, NHS, GP record, blood test, diagnosis, prescription, medication. Query: kind (test_result|diagnosis|prescription), name, from, to, limit
router.get('/records', (req, res) => {
  try {
    const kind = req.query.kind ? String(req.query.kind) : null;
    if (kind && !medical.KINDS.includes(kind)) {
      return res.status(400).json({ ok: false, error: `kind must be one of ${medical.KINDS.join(', ')}` });
    }
    const out = medical.list({
      kind,
      name: req.query.name ? String(req.query.name) : null,
      from: req.query.from ? String(req.query.from) : null,
      to: req.query.to ? String(req.query.to) : null,
      limit: req.query.limit,
    });
    res.json({ ok: true, ...out, summary: medical.summary() });
  } catch (e) {
    console.error('[Medical] list failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/medical/tests/:name — every reading of one test over time (oldest first), for a trend: e.g. HbA1c, cholesterol, eGFR, vitamin D. Keywords: medical, NHS, test result history, blood test trend.
router.get('/tests/:name', (req, res) => {
  try {
    res.json({ ok: true, name: req.params.name, readings: medical.testHistory(req.params.name) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/medical/records — save parsed NHS app records. record: {kind: test_result|diagnosis|prescription, name, date YYYY-MM-DD, value, unit, referenceRange, flag (if shown), status, followUp (GP comment e.g. "No further action"), panel, dose, directions, quantity, notes}. Copy exactly; resends fold. Keywords: medical, NHS, blood test, prescription. Body: { records: [record], client }
router.post('/records', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { records, client, via } = req.body;
    const result = medical.upsert(records, {
      via: via === 'screenshot' ? 'screenshot' : 'structured',
      by: _enteredBy(req, client),
    });
    if (!result.ok) return res.status(400).json({ ok: false, error: result.why });
    res.json(result);
  } catch (e) {
    console.error('[Medical] save failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/medical/scan — read up to 8 NHS app screenshots with a vision model and PROPOSE medical records. Saves nothing, keeps no image; save the chosen ones via POST /api/medical/records. Keywords: medical, NHS, screenshot, OCR, test results, prescription. Body: { images: [{ imageBase64, mediaType }] }
router.post('/scan', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { images } = req.body;
    const result = await medical.proposeFromScreenshots({ images });
    if (!result.ok) return res.status(422).json({ ok: false, error: result.why });
    res.json(result);
  } catch (e) {
    console.error('[Medical] scan failed:', e.message);
    res.status(500).json({ ok: false, error: 'the screenshots could not be read' });
  }
});

// DELETE /api/medical/records/:id — remove one medical record (Nick only, in NEURO → Medical).
router.delete('/records/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: 'not a record id' });
    if (!medical.remove(id)) return res.status(404).json({ ok: false, error: 'no such record' });
    res.json({ ok: true, deleted: id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
