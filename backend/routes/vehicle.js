'use strict';

/**
 * Build 21 — /api/vehicle: the Captur, its dates, history and running costs,
 * and the review queue for Tally transactions that might be motoring.
 *
 * ⚠ Literal paths (/finance/…, /obligations/…) are registered BEFORE /:id —
 * Express matches in registration order. Every write here is Nick's: the
 * authority matrix refuses machines on all of them.
 */

const express = require('express');
const router = express.Router();

const veh = () => require('../services/vehicle');
const tv = () => require('../services/tally-vehicle');
const idOf = (raw) => { const s = String(raw || ''); return s.startsWith('vehicle:') ? s : `vehicle:${s}`; };
const send = (res, out) => (out && out.ok === false ? res.status(out.status || 400).json(out) : res.json(out));
const fail = (res, e) => { console.error('[Vehicle]', e.message); res.status(500).json({ ok: false, error: e.message }); };
const bodyOf = (req) => (req.body && typeof req.body === 'object' ? req.body : null);

// GET /api/vehicle — every vehicle NEURO holds with obligations, mileage, history, running costs and gaps. Keywords: car, Captur, MOT, vehicle.
router.get('/', (req, res) => {
  try {
    const v = veh();
    res.json({ ok: true, vehicles: v.listVehicles().map((x) => v.read(x.vehicle_id)), finance: tv().read().state });
  } catch (e) { fail(res, e); }
});

// POST /api/vehicle — Nick creates a vehicle he owns. Body: make, model, plateDescriptor, registration, variant, fuelType, provenanceNote. Refuses a generic "car" and a duplicate make+model.
router.post('/', (req, res) => {
  try {
    if (!bodyOf(req)) return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { make, model, plateDescriptor, registration, variant, fuelType, provenanceNote } = req.body;
    send(res, veh().createVehicle({ make, model, plateDescriptor, registration, variant, fuelType, provenanceNote }));
  } catch (e) { fail(res, e); }
});

// GET /api/vehicle/finance/review — Tally transactions that might be motoring, awaiting Nick, plus decided ones and rules. Read-only from Tally. Keywords: fuel spend, vehicle spend.
router.get('/finance/review', (req, res) => {
  try { res.json({ ok: true, ...tv().read() }); } catch (e) { fail(res, e); }
});

// GET /api/vehicle/finance/rules/preview — what a vehicle-spend rule would match before Nick confirms it. Query: matchKind, merchantKey, categoryName.
router.get('/finance/rules/preview', (req, res) => {
  try {
    const { matchKind, merchantKey, categoryName } = req.query;
    const bad = tv().validateRule({ matchKind, merchantKey, categoryName, spendType: 'other' });
    if (bad) return res.status(400).json({ ok: false, error: bad });
    res.json({ ok: true, ...tv().previewRule({ matchKind, merchantKey, categoryName }) });
  } catch (e) { fail(res, e); }
});

// POST /api/vehicle/finance/sync — read Tally now (read-only over ssh) and refresh the vehicle-spend candidates. Never writes to Tally.
router.post('/finance/sync', async (req, res) => {
  try { send(res, await tv().sync()); } catch (e) { fail(res, e); }
});

// POST /api/vehicle/finance/transactions/:txnId/decide — Nick classifies one Tally transaction. Body: decision (vehicle|not-vehicle|unknown), spendType, vehicleId, remember {matchKind, scope}.
router.post('/finance/transactions/:txnId/decide', (req, res) => {
  try {
    if (!bodyOf(req)) return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { decision, spendType, vehicleId, remember } = req.body;
    send(res, tv().decide(req.params.txnId, { decision, spendType, vehicleId: vehicleId ? idOf(vehicleId) : null, remember: remember || null }));
  } catch (e) { fail(res, e); }
});

// POST /api/vehicle/finance/rules/:ruleId/retire — stop a confirmed vehicle-spend rule matching new transactions. Decisions it made stay.
router.post('/finance/rules/:ruleId/retire', (req, res) => {
  try { send(res, tv().retireRule(req.params.ruleId)); } catch (e) { fail(res, e); }
});

// POST /api/vehicle/obligations/:obligationId — edit an open vehicle obligation's due date, due mileage or linked task/reminder. Body: dueDate, dueMileage, linkedTaskRef, linkedReminderRef.
router.post('/obligations/:obligationId', (req, res) => {
  try {
    if (!bodyOf(req)) return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { dueDate, dueMileage, linkedTaskRef, linkedReminderRef } = req.body;
    const patch = {};
    for (const [k, v] of Object.entries({ dueDate, dueMileage, linkedTaskRef, linkedReminderRef })) if (v !== undefined) patch[k] = v;
    send(res, veh().updateObligation(req.params.obligationId, patch));
  } catch (e) { fail(res, e); }
});

// POST /api/vehicle/obligations/:obligationId/resolve — Nick says an MOT/insurance/service/tax is actually done (evidence required — a ticked task is not evidence). Body: outcome, evidence, completedOn, nextDueDate, nextDueMileage.
router.post('/obligations/:obligationId/resolve', (req, res) => {
  try {
    if (!bodyOf(req)) return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { outcome, evidence, completedOn, nextDueDate, nextDueMileage } = req.body;
    send(res, veh().resolveObligation(req.params.obligationId, { outcome, evidence, completedOn, nextDueDate, nextDueMileage }));
  } catch (e) { fail(res, e); }
});

// GET /api/vehicle/:id — one vehicle: obligations, mileage, history, official checks, running costs, health evidence.
router.get('/:id', (req, res) => {
  try {
    const r = veh().read(idOf(req.params.id));
    return r ? res.json({ ok: true, ...r }) : res.status(404).json({ ok: false, error: 'no such vehicle' });
  } catch (e) { fail(res, e); }
});

// GET /api/vehicle/:id/summaries — the stored monthly vehicle summaries, newest first.
router.get('/:id/summaries', (req, res) => {
  try { res.json({ ok: true, summaries: veh().summaries(idOf(req.params.id)) }); } catch (e) { fail(res, e); }
});

// POST /api/vehicle/:id — Nick fills in what he knows about a vehicle. Body: plateDescriptor, registration, variant, fuelType, ownershipState.
router.post('/:id', (req, res) => {
  try {
    if (!bodyOf(req)) return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { plateDescriptor, registration, variant, fuelType, ownershipState } = req.body;
    const patch = {};
    for (const [k, v] of Object.entries({ plateDescriptor, registration, variant, fuelType, ownershipState })) if (v !== undefined) patch[k] = v;
    send(res, veh().updateVehicle(idOf(req.params.id), patch));
  } catch (e) { fail(res, e); }
});

// POST /api/vehicle/:id/mileage — Nick records an odometer reading. Body: value, unit (mi|km), observedOn, source, confidence, correction, note. Implausible readings are kept and flagged.
router.post('/:id/mileage', (req, res) => {
  try {
    if (!bodyOf(req)) return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { value, unit, observedOn, source, confidence, correction, note, from } = req.body;
    send(res, veh().addMileage(idOf(req.params.id), { value, unit, observedOn, source, confidence, correction, note, from }));
  } catch (e) { fail(res, e); }
});

// POST /api/vehicle/:id/mileage/:readingId/withdraw — take back an odometer reading entered in error.
router.post('/:id/mileage/:readingId/withdraw', (req, res) => {
  try { send(res, veh().withdrawMileage(idOf(req.params.id), req.params.readingId)); } catch (e) { fail(res, e); }
});

// POST /api/vehicle/:id/events — Nick records a service, repair, tyres or other maintenance. Body: type, date, mileage, description, costPence, costRef (tally:<id>), axle, position, brand, model.
router.post('/:id/events', (req, res) => {
  try {
    if (!bodyOf(req)) return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { type, date, mileage, description, costPence, costRef, axle, position, brand, model, count } = req.body;
    send(res, veh().addEvent(idOf(req.params.id), { type, date, mileage, description, costPence, costRef, axle, position, brand, model, count }));
  } catch (e) { fail(res, e); }
});

// POST /api/vehicle/:id/events/:eventId/withdraw — take back a history entry recorded in error.
router.post('/:id/events/:eventId/withdraw', (req, res) => {
  try { send(res, veh().withdrawEvent(idOf(req.params.id), req.params.eventId)); } catch (e) { fail(res, e); }
});

// POST /api/vehicle/:id/obligations — Nick records an MOT, insurance, service, warranty, breakdown cover or tax date. Body: type, dueDate, dueMileage, intervalMonths, intervalMiles, intervalBasis, linkedTaskRef, linkedReminderRef, note.
router.post('/:id/obligations', (req, res) => {
  try {
    if (!bodyOf(req)) return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { type, dueDate, dueMileage, intervalMonths, intervalMiles, intervalBasis, linkedTaskRef, linkedReminderRef, note, from } = req.body;
    send(res, veh().addObligation(idOf(req.params.id), { type, dueDate, dueMileage, intervalMonths, intervalMiles, intervalBasis, linkedTaskRef, linkedReminderRef, note, from }));
  } catch (e) { fail(res, e); }
});

// POST /api/vehicle/:id/official-check — ask DVLA (Vehicle Enquiry Service) for MOT and tax status. Needs DVLA_VES_API_KEY and the registration; records 'unavailable' otherwise.
router.post('/:id/official-check', async (req, res) => {
  try { send(res, await veh().runOfficialCheck(idOf(req.params.id))); } catch (e) { fail(res, e); }
});

// POST /api/vehicle/:id/official-by-hand — Nick records what gov.uk showed (Check MOT history / Check if a vehicle is taxed). Body: motStatus, motExpiryDate, taxStatus, taxDueDate.
router.post('/:id/official-by-hand', (req, res) => {
  try {
    if (!bodyOf(req)) return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { motStatus, motExpiryDate, taxStatus, taxDueDate } = req.body;
    send(res, veh().recordOfficialByHand(idOf(req.params.id), { motStatus, motExpiryDate, taxStatus, taxDueDate }));
  } catch (e) { fail(res, e); }
});

module.exports = router;
