'use strict';

/**
 * Leisure & media (Build 30). Reads are open; every write is Nick's statement
 * and is refused to machine clients by the authority matrix.
 */

const express = require('express');
const leisure = require('../services/leisure');

const router = express.Router();
const send = (res, r) => res.status(r.ok ? 200 : r.status || 400).json(r);

// GET /api/leisure — Leisure: now playing, coming up, continue, recently enjoyed, hobbies, listening interest, likes/dislikes, sources.
router.get('/', (req, res) => {
  try {
    if (req.query.ask !== undefined && !['0', '1'].includes(String(req.query.ask))) return res.status(400).json({ ok: false, error: 'ask must be 0 or 1' });
    res.json(leisure.read({ asked: String(req.query.ask) === '1' }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/leisure/items/:ref — one leisure item or listening record, and why NEURO holds its state.
router.get('/items/:ref', (req, res) => {
  try { send(res, leisure.detail(req.params.ref)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/leisure/items — Nick adds a series, film, album, book, game, podcast, hobby or booking.
router.post('/items', (req, res) => {
  const { kind, title, creator, state, preference, progress, eventDate, eventKind, projectId, notes } = req.body || {};
  try { send(res, leisure.addItem({ kind, title, creator, state, preference, progress, eventDate, eventKind, projectId, notes })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/leisure/items/:itemId — Nick edits a leisure item (title, creator, state, progress, date, project, notes).
router.post('/items/:itemId', (req, res) => {
  const { kind, title, creator, state, preference, progress, eventDate, eventKind, projectId, notes } = req.body || {};
  try { send(res, leisure.updateItem(req.params.itemId, { kind, title, creator, state, preference, progress, eventDate, eventKind, projectId, notes })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/leisure/correct — Nick's correction on an item or listening record: liked, disliked, completed, dropped, not mine, this was me.
router.post('/correct', (req, res) => {
  const { ref, action } = req.body || {};
  if (typeof ref !== 'string' || typeof action !== 'string') return res.status(400).json({ ok: false, error: 'ref and action are required' });
  try { send(res, leisure.correct(ref, action)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
