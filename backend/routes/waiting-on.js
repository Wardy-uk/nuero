'use strict';

/**
 * Waiting-on API — what other people owe Nick.
 *
 * GET  /api/waiting-on            — open items, oldest first
 * GET  /api/waiting-on/by-person  — grouped, which is how a 1-2-1 is prepared
 * POST /api/waiting-on/:key/chase — PREPARE a governed chase for approval (never sends)
 * POST /api/waiting-on/:key/resolve — mark done or dropped
 * POST /api/waiting-on/:key/snooze  — hide until a date, or clear with no date
 */

const express = require('express');
const router = express.Router();
const waitingOn = require('../services/waiting-on');

router.get('/', (req, res) => {
  try {
    res.json({
      items: waitingOn.list({ status: req.query.status || 'open', person: req.query.person || null }),
      staleAfterDays: waitingOn.STALE_DAYS,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/by-person', (req, res) => {
  try {
    res.json({ people: waitingOn.byPerson() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/waiting-on/backfill — populate from meeting notes already on disk.
// The live path only sees new or changed notes, so without this the feature
// starts empty. Read-only over the vault; records nothing but waiting-on items.
router.post('/backfill', (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.body?.days, 10) || 120, 1), 365);
    res.json(require('../services/waiting-on').backfill({ days }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/waiting-on/:key/chase — the Chase button (chase someone, follow up, ask where it got to). Since Build 7 it PREPARES a governed chase_commitment in Actions → Drafted by NEURO: the exact email, to the one address NEURO resolved, waiting for Nick's approval. It sends nothing and calls no provider. Pressing it again while one is under way returns that one (already: true).
router.post('/:key/chase', (req, res) => {
  try {
    const r = require('../services/prepared-actions').prepareFromWaitingOn(decodeURIComponent(req.params.key));
    if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error, sent: false });
    res.json({
      ok: true, sent: false, already: !!r.already, actionId: r.action.actionId, status: r.action.status,
      notice: r.notice || 'Drafted — read and approve it in Actions → Drafted by NEURO. Nothing has been sent.',
      action: r.action,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, sent: false });
  }
});

// The two payload-editing doors on the retired legacy chase. A governed chase's
// recipient is resolved from the People note and cannot be typed in (a free
// address would bypass the target rule); its words are edited as a new version
// in Actions. 410 rather than 404, so a stale client is told why.
const RETIRED = 'Retired in Build 7: chases are drafted in Actions → Drafted by NEURO. The recipient comes from the person\'s People note (add email: there); the wording is edited on the draft.';
router.post('/chase/:actionId/recipient', (req, res) => res.status(410).json({ ok: false, error: RETIRED }));

// Snooze is not resolve: the commitment is still outstanding and still ages,
// it just stops being asked about until the date they actually gave.
router.post('/:key/snooze', (req, res) => {
  try {
    const item = require('../services/waiting-on')
      .snooze(decodeURIComponent(req.params.key), req.body?.until || null);
    if (!item) return res.status(404).json({ error: 'No such item' });
    res.json({ ok: true, item });
  } catch (e) {
    res.status(/must be YYYY-MM-DD/.test(e.message) ? 400 : 500).json({ error: e.message });
  }
});

router.post('/:key/resolve', (req, res) => {
  try {
    const item = waitingOn.resolve(decodeURIComponent(req.params.key), req.body?.status || 'done');
    if (!item) return res.status(404).json({ error: 'No such item' });
    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Retired with the legacy sender: a governed chase is email only (Build 6/7).
router.post('/chase/:actionId/channel', (req, res) => res.status(410).json({ ok: false, error: RETIRED }));

module.exports = router;
