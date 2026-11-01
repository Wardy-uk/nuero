'use strict';

/**
 * Calendar care routes (1 Nov 2026) — see services/calendar-care.js.
 *   GET  /api/calendar-care                   the three offers (read-only)
 *   POST /api/calendar-care/week/protect      { weekKey }        create the protected block
 *   POST /api/calendar-care/week/dismiss      { weekKey }        "Not this week"
 *   POST /api/calendar-care/agenda/refresh                       run the agenda pass now (reads invite bodies)
 *   POST /api/calendar-care/agenda/add        { key, text }      PREPARE the governed agenda (the screen confirms it)
 *   POST /api/calendar-care/agenda/done       { key }            record a confirmed agenda
 *   POST /api/calendar-care/agenda/dismiss    { key }
 *   POST /api/calendar-care/series/decline    { key, note? }     decline a series (ledgered, read back)
 *   POST /api/calendar-care/series/cancel     { key, note? }     PREPARE the governed cancel of his own series
 *   POST /api/calendar-care/series/answer     { key, answer }    keep | remind | cancelled
 * Every POST refuses machine clients (and the authority matrix says so too).
 */

const express = require('express');
const router = express.Router();
const care = require('../services/calendar-care');

const refuseMachine = (req, res) => {
  if (req.apiClient) { res.status(403).json({ ok: false, error: 'This changes Nick’s calendar or what NEURO offers him — it needs him, in NEURO.' }); return true; }
  return false;
};
const send = (res, r) => res.status(r.ok ? 200 : (r.status || 409)).json(r);

// GET /api/calendar-care — calendar care: the coming week's meeting load (protect an afternoon), meetings Nick organises with no agenda, and recurring meetings he never attends (leave the series).
router.get('/', (req, res) => {
  try { res.json(care.read()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/calendar-care/week/protect — protect a meeting-free afternoon in a week over 60% meetings: creates an attendee-free "Protected — no meetings" block. Refuses machine clients. Body: { weekKey }
router.post('/week/protect', async (req, res) => {
  if (refuseMachine(req, res)) return;
  try { const { weekKey } = req.body || {}; send(res, await care.protect({ weekKey })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/calendar-care/week/dismiss — "Not this week": no protected-time offer for that week. Refuses machine clients. Body: { weekKey }
router.post('/week/dismiss', (req, res) => {
  if (refuseMachine(req, res)) return;
  try { const { weekKey } = req.body || {}; send(res, care.dismissWeek({ weekKey })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/calendar-care/agenda/refresh — look again for meetings Nick organises in the next 24h whose invite has no agenda (reads invite bodies; changes nothing). Refuses machine clients.
router.post('/agenda/refresh', async (req, res) => {
  if (refuseMachine(req, res)) return;
  try { send(res, await care.agendaPass()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/calendar-care/agenda/add — add the agenda (meeting agenda, invite body) Nick confirmed: PREPARES a governed update of the event body only, for the screen to confirm with one press. Refuses machine clients. Body: { key, text }
router.post('/agenda/add', async (req, res) => {
  if (refuseMachine(req, res)) return;
  try { const { key, text } = req.body || {}; send(res, await care.prepareAgenda({ key, text })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/calendar-care/agenda/done — record that a confirmed agenda went onto the meeting. Refuses machine clients. Body: { key }
router.post('/agenda/done', (req, res) => {
  if (refuseMachine(req, res)) return;
  try { const { key } = req.body || {}; send(res, care.agendaDone({ key })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/calendar-care/agenda/dismiss — no agenda for this meeting. Refuses machine clients. Body: { key }
router.post('/agenda/dismiss', (req, res) => {
  if (refuseMachine(req, res)) return;
  try { const { key } = req.body || {}; send(res, care.dismissAgenda({ key })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/calendar-care/series/decline — leave a recurring meeting (series) Nick has missed the last three times: declines every future occurrence, the organiser is told, read back. Refuses machine clients. Body: { key, note? }
router.post('/series/decline', async (req, res) => {
  if (refuseMachine(req, res)) return;
  try { const { key, note } = req.body || {}; send(res, await care.declineSeries({ key, note })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/calendar-care/series/cancel — cancel a recurring meeting (series) Nick organises and has missed the last three times: PREPARES a governed cancel for the screen to confirm. Refuses machine clients. Body: { key, note? }
router.post('/series/cancel', async (req, res) => {
  if (refuseMachine(req, res)) return;
  try { const { key, note } = req.body || {}; send(res, await care.prepareSeriesCancel({ key, note })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/calendar-care/series/answer — keep a series, remind in a month, or record a confirmed cancellation. Refuses machine clients. Body: { key, answer: keep|remind|cancelled }
router.post('/series/answer', (req, res) => {
  if (refuseMachine(req, res)) return;
  try { const { key, answer } = req.body || {}; send(res, care.seriesAnswer({ key, answer })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
