'use strict';

/**
 * /api/life-loops — decisions look-back, people rhythm, letters to future me,
 * the weekly garden, and the logbook + Choose for me (services/life-loops.js).
 * Reads are open; every write is Nick's (machines refused here and in the
 * authority matrix).
 */

const express = require('express');
const L = require('../services/life-loops');

const router = express.Router();

function send(res, r) { res.status(r.ok ? 200 : (r.status || 500)).json(r); }
function nick(req, res) {
  if (req.apiClient) { res.status(403).json({ ok: false, error: 'Nick only' }); return false; }
  return true;
}
const wrap = (fn) => (req, res) => { try { fn(req, res); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } };

// GET /api/life-loops/decisions — decision log with look-back dates and verdicts (right / wrong / mixed), newest first.
router.get('/decisions', wrap((req, res) => res.json({ ok: true, decisions: L.listDecisions() })));
// POST /api/life-loops/decisions — log a decision. Body: { text, lookBackOn? (YYYY-MM-DD; default 30 days on) }.
router.post('/decisions', wrap((req, res) => { if (!nick(req, res)) return; const { text, lookBackOn } = req.body || {}; send(res, L.addDecision(text, { lookBackOn })); }));
// POST /api/life-loops/decisions/:id/look-back — set the day to look back on a decision. Body: { date }.
router.post('/decisions/:id/look-back', wrap((req, res) => { if (!nick(req, res)) return; const { date } = req.body || {}; send(res, L.setLookBack(Number(req.params.id), date)); }));
// POST /api/life-loops/decisions/:id/review — how a decision went. Body: { outcome: right|wrong|mixed|too-early, lesson? }.
router.post('/decisions/:id/review', wrap((req, res) => { if (!nick(req, res)) return; const { outcome, lesson } = req.body || {}; send(res, L.reviewDecision(Number(req.params.id), { outcome, lesson })); }));

// GET /api/life-loops/rhythm — people rhythm: how often Nick wants to see or call each person, and who is due.
router.get('/rhythm', wrap((req, res) => res.json({ ok: true, people: L.listRhythm() })));
// POST /api/life-loops/rhythm — set a person's rhythm. Body: { name, everyDays, askAbout?, lastAt? }.
router.post('/rhythm', wrap((req, res) => { if (!nick(req, res)) return; const { name, everyDays, askAbout, lastAt } = req.body || {}; send(res, L.setRhythm(name, { everyDays, askAbout, lastAt })); }));
// POST /api/life-loops/rhythm/caught-up — record catching up with a person today. Body: { name }.
router.post('/rhythm/caught-up', wrap((req, res) => { if (!nick(req, res)) return; send(res, L.caughtUp(String((req.body || {}).name || ''))); }));
// POST /api/life-loops/rhythm/remove — stop tracking a person's rhythm. Body: { name }.
router.post('/rhythm/remove', wrap((req, res) => { if (!nick(req, res)) return; send(res, L.removeRhythm(String((req.body || {}).name || ''))); }));

// GET /api/life-loops/letters — letters to future me; sealed ones carry no text until their day.
router.get('/letters', wrap((req, res) => res.json({ ok: true, letters: L.listLetters() })));
// POST /api/life-loops/letters — seal a letter to future me. Body: { body, openOn (YYYY-MM-DD, after today), replyTo? }.
router.post('/letters', wrap((req, res) => { if (!nick(req, res)) return; const { body, openOn, replyTo } = req.body || {}; send(res, L.writeLetter(body, { openOn, replyTo })); }));
// POST /api/life-loops/letters/:id/open — open a letter that has arrived.
router.post('/letters/:id/open', wrap((req, res) => { if (!nick(req, res)) return; send(res, L.openLetter(req.params.id)); }));
// POST /api/life-loops/letters/:id/keep — keep an arrived letter. Body: { kept }.
router.post('/letters/:id/keep', wrap((req, res) => { if (!nick(req, res)) return; send(res, L.keepLetter(req.params.id, (req.body || {}).kept !== false)); }));
// POST /api/life-loops/letters/:id/remove — remove a letter still sealed.
router.post('/letters/:id/remove', wrap((req, res) => { if (!nick(req, res)) return; send(res, L.removeLetter(req.params.id)); }));

// GET /api/life-loops/garden — this week's three old notes to revisit (garden).
router.get('/garden', wrap((req, res) => res.json(L.garden())));
// POST /api/life-loops/garden/done — mark a garden note as looked at this week. Body: { path }.
router.post('/garden/done', wrap((req, res) => { if (!nick(req, res)) return; send(res, L.gardenDone(String((req.body || {}).path || ''))); }));

// GET /api/life-loops/logbook — logbook of restaurants, films, books, coffee… Query: kind?
router.get('/logbook', wrap((req, res) => res.json({ ok: true, ...L.listLog({ kind: req.query.kind ? String(req.query.kind).toLowerCase() : null }) })));
// POST /api/life-loops/logbook — log something. Body: { kind, title, rating? (1–10), loggedOn?, place?, notes? }.
router.post('/logbook', wrap((req, res) => { if (!nick(req, res)) return; send(res, L.logEntry(req.body || {})); }));
// POST /api/life-loops/logbook/:id/remove — remove a logbook entry.
router.post('/logbook/:id/remove', wrap((req, res) => { if (!nick(req, res)) return; send(res, L.removeEntry(req.params.id)); }));
// GET /api/life-loops/choose — choose for me from my own ratings. Query: kind, minRating?, skipDays?, weight?, turn?
router.get('/choose', wrap((req, res) => send(res, L.chooseFor(req.query.kind, req.query))));

module.exports = router;
