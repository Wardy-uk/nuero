'use strict';

// Room offers — what SARA would do in the room Nick is in.
//
// ⚠ ROUTE ORDER: the literal paths (`/history`) are registered ABOVE anything
//   parameterised. This router has `/:key/accept` and `/:key/decline`, and this
//   codebase has shipped a literal path swallowed as a parameter more than once
//   (`/triage/feedback` read as an email id, `/triage/muted` the same bug again
//   four months later). Pinned by a routing test.
//
// ⚠ ACCEPT IS A WRITE TO THE HOUSE and is the only one. The body is ignored
//   entirely — the key names an offer, and the service re-derives from a fresh
//   read what that offer actually was. A client cannot name an entity.

const express = require('express');
const router = express.Router();
const rooms = require('../services/rooms');

// GET /api/rooms — the current offers, and what has already been answered.
router.get('/', async (req, res) => {
  try {
    res.json(await rooms.snapshot({}));
  } catch (e) {
    console.error('[rooms] snapshot failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/rooms/history — every yes and no, newest first. The learning set.
router.get('/history', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  res.json(rooms.history(limit));
});

// POST /api/rooms/:key/accept — do it.
router.post('/:key/accept', async (req, res) => {
  try {
    const out = await rooms.act(req.params.key, {});
    // ⚠ A refusal is a 200 carrying ok:false, not a 500 — "that offer is no
    // longer on the table" is a normal outcome of a stale screen, not an error,
    // and a screen has to be able to tell the two apart.
    res.json(out);
  } catch (e) {
    console.error('[rooms] act failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/rooms/:key/decline — not this time. Asks again on the next visit.
router.post('/:key/decline', async (req, res) => {
  try {
    res.json(await rooms.decline(req.params.key, {}));
  } catch (e) {
    console.error('[rooms] decline failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
