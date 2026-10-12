'use strict';

const express = require('express');
const router = express.Router();
const briefings = require('../services/briefings');

// ⚠ Literal paths are registered BEFORE '/:id' — Express matches in order and a
// literal registered after a parameter is read as that parameter.

// GET /api/briefings — daily and weekly briefing history, newest first
router.get('/', (req, res) => {
  try {
    const kind = req.query.kind === 'daily' || req.query.kind === 'weekly' ? req.query.kind : null;
    const rows = briefings.list({ kind, limit: req.query.limit });
    res.json({
      ok: true,
      briefings: rows.map((b) => ({
        id: b.id, kind: b.kind, date: b.date, dayType: b.dayType,
        dayLabel: b.payload?.dayLabel || null,
        needsYouCount: b.payload?.needsYouCount ?? null,
        gaps: (b.payload?.gaps || []).length,
        delivery: b.delivery,
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/briefings/latest?kind=daily|weekly — the most recent briefing of a kind
router.get('/latest', (req, res) => {
  const kind = req.query.kind === 'weekly' ? 'weekly' : 'daily';
  try {
    const [b] = briefings.list({ kind, limit: 1 });
    res.json({ ok: true, briefing: b || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/briefings/run — build a daily or weekly briefing now (briefing run rebuild); delivers only when asked
router.post('/run', async (req, res) => {
  const { kind, deliver, force } = req.body || {};
  if (kind !== 'daily' && kind !== 'weekly') return res.status(400).json({ ok: false, error: 'kind must be daily or weekly' });
  try {
    const b = await briefings.run(kind, { deliver: deliver === true, force: force === true });
    res.json({ ok: true, briefing: b });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// POST /api/briefings/feedback — mark a kind of briefing item not useful (or undo); lowers its rank, bounded
router.post('/feedback', (req, res) => {
  const { kind, undo } = req.body || {};
  try {
    res.json({ ok: true, ...briefings.recordFeedback({ kind, undo: undo === true }) });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// GET /api/briefings/:id — one stored briefing in full
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'id must be a positive integer' });
  const b = briefings.getById(id);
  if (!b) return res.status(404).json({ ok: false, error: 'no such briefing' });
  res.json({ ok: true, briefing: b });
});

module.exports = router;
