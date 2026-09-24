'use strict';

/**
 * People gap API.
 *   GET  /api/people-gap             — scan (read-only)
 *   POST /api/people-gap/report      — scan + write the Vault Audit report
 *   POST /api/people-gap/apply       — create stub People notes
 *   POST /api/people-gap/ignore      — never suggest this name again
 *   POST /api/people-gap/unignore    — the way back
 *   POST /api/people-gap/alias       — add a near miss as an alias of an existing person
 *
 * Apply is deliberately a separate call: the nightly pass only ever reports.
 *
 * ⚠ `/alias` and `/ignore` are SCOPED DOORS, each doing one thing, following
 * `waiting-on/chase/:actionId/recipient` and `todos/suggestions/:id/fields`.
 * `/alias` edits a hand-maintained People note, so it is not folded into a
 * general update route that a future caller could reach by accident.
 */

const express = require('express');
const router = express.Router();
const peopleGap = require('../services/people-gap');

router.get('/', (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 90, 365);
    const minSightings = Math.max(parseInt(req.query.minSightings, 10) || 2, 1);
    res.json(peopleGap.findGaps({ days, minSightings }));
  } catch (e) {
    console.error('[people-gap]', e);
    res.status(500).json({ status: 'error', error: e.message });
  }
});

router.post('/report', (req, res) => {
  try {
    res.json(peopleGap.runNightlyScan({ days: req.body?.days || 90 }));
  } catch (e) {
    console.error('[people-gap]', e);
    res.status(500).json({ status: 'error', error: e.message });
  }
});

router.post('/apply', (req, res) => {
  try {
    const { names, role, days = 90, minSightings = 2, dryRun = false } = req.body || {};
    res.json(peopleGap.createStubs({ names, role, days, minSightings, dryRun }));
  } catch (e) {
    console.error('[people-gap]', e);
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// POST /api/people-gap/ignore — record that a suggested name is not someone to
// file. Rooms and shared mailboxes came back every night with no way to say so.
router.post('/ignore', (req, res) => {
  try {
    const { name, reason = null } = req.body || {};
    if (!name) return res.status(400).json({ status: 'error', error: 'name is required' });
    const result = peopleGap.ignoreName(name, reason);
    res.status(result.status === 'error' ? 400 : 200).json(result);
  } catch (e) {
    console.error('[people-gap]', e);
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// POST /api/people-gap/unignore — undo. Every other decision here has a way back.
router.post('/unignore', (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ status: 'error', error: 'name is required' });
    const result = peopleGap.unignoreName(name);
    res.status(result.status === 'error' ? 400 : 200).json(result);
  } catch (e) {
    console.error('[people-gap]', e);
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// GET /api/people-gap/ignored — the Ignored (n) list.
// ⚠ Registered before nothing parameterised on this router, but declared as a
// literal path regardless: this codebase has shipped a literal swallowed as a
// parameter before.
router.get('/ignored', (req, res) => {
  try {
    res.json({ status: 'ok', ...peopleGap.listIgnored() });
  } catch (e) {
    console.error('[people-gap]', e);
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// POST /api/people-gap/alias — fold a near miss into an existing person.
// ⚠ `dryRun: true` returns the exact frontmatter line and writes NOTHING; that
// is what the card's confirm renders, because the write is into Nick's own
// second brain and there is no undo from a card.
router.post('/alias', (req, res) => {
  try {
    const { person, alias, dryRun = false } = req.body || {};
    if (!person || !alias) return res.status(400).json({ status: 'error', error: 'person and alias are required' });
    const result = peopleGap.addAlias({ person, alias, dryRun });
    // A refusal is an ANSWER, not a fault — 409, so the card can print the
    // reason rather than rendering a failed request.
    if (result.status === 'refused') return res.status(409).json(result);
    res.status(result.status === 'error' ? 400 : 200).json(result);
  } catch (e) {
    console.error('[people-gap]', e);
    res.status(500).json({ status: 'error', error: e.message });
  }
});

module.exports = router;
