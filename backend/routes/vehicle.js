'use strict';

/**
 * Build 21 → 27 — /api/vehicle: the Captur, its dates, mileage, history and
 * fuel fills. Its running costs are Tally's (finance-intelligence-v1), shown
 * unchanged; the Build 21 review of Tally transactions moved INTO Tally in
 * Build 27, so those routes answer 410 and say where it went.
 *
 * ⚠ Literal paths (/finance/…, /obligations/…) are registered BEFORE /:id —
 * Express matches in registration order. Every write here is Nick's: the
 * authority matrix refuses machines on all of them.
 */

const express = require('express');
const router = express.Router();

const veh = () => require('../services/vehicle');
const moved = (what) => require('../services/finance').movedToTally(`${what} (Outlook → Motoring)`);
const idOf = (raw) => { const s = String(raw || ''); return s.startsWith('vehicle:') ? s : `vehicle:${s}`; };
const send = (res, out) => (out && out.ok === false ? res.status(out.status || 400).json(out) : res.json(out));
const fail = (res, e) => { console.error('[Vehicle]', e.message); res.status(500).json({ ok: false, error: e.message }); };
const bodyOf = (req) => (req.body && typeof req.body === 'object' ? req.body : null);

// GET /api/vehicle — every vehicle NEURO holds with obligations, mileage, history, running costs and gaps. Keywords: car, Captur, MOT, vehicle.
router.get('/', (req, res) => {
  try {
    const v = veh();
    res.json({ ok: true, vehicles: v.listVehicles().map((x) => v.read(x.vehicle_id)) });
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

// GET /api/vehicle/finance/review — retired in Build 27: which transactions are the car's is decided in Tally.
router.get('/finance/review', (req, res) => send(res, moved('Which transactions are the car\'s')));

// GET /api/vehicle/finance/rules/preview — retired in Build 27: vehicle-spend rules live in Tally.
router.get('/finance/rules/preview', (req, res) => send(res, moved('A vehicle-spend rule')));

// POST /api/vehicle/finance/sync — retired in Build 27: NEURO no longer reads Tally's database.
router.post('/finance/sync', (req, res) => send(res, moved('Reading vehicle spend')));

// POST /api/vehicle/finance/transactions/:txnId/decide — retired in Build 27: decided in Tally.
router.post('/finance/transactions/:txnId/decide', (req, res) => send(res, moved('Whether a transaction is the car\'s')));

// POST /api/vehicle/finance/rules/:ruleId/retire — retired in Build 27: rules live in Tally.
router.post('/finance/rules/:ruleId/retire', (req, res) => send(res, moved('A vehicle-spend rule')));

const jr = () => require('../services/vehicle-journeys');

// GET /api/vehicle/journeys — car journeys detected from Life360. Query: status (pending|approved|rejected|all, default pending), limit. Keywords: journey, trip, drive, mileage, approve.
router.get('/journeys', (req, res) => {
  try {
    const status = String(req.query.status || 'pending');
    if (!['pending', 'approved', 'rejected', 'all'].includes(status)) return res.status(400).json({ ok: false, error: 'status must be pending, approved, rejected or all' });
    res.json({ ok: true, status, journeys: jr().list({ status, limit: req.query.limit }) });
  } catch (e) { fail(res, e); }
});

// POST /api/vehicle/journeys/sync — read Home Assistant's Life360 history now and store finished journeys as pending. Body: dryRun (stores nothing), fromDays (look back, dry run only). Keywords: journey detect.
router.post('/journeys/sync', async (req, res) => {
  try {
    const { dryRun, fromDays } = req.body;
    if (fromDays !== undefined && !dryRun) return res.status(400).json({ ok: false, error: 'fromDays is for a dry run only — the live pass reads from its cursor' });
    let from = null;
    if (fromDays !== undefined) {
      const d = Number(fromDays);
      if (!Number.isFinite(d) || d <= 0 || d > 9) return res.status(400).json({ ok: false, error: 'fromDays must be between 1 and 9 (Home Assistant keeps about ten days)' });
      from = Date.now() - d * 86400000;
    }
    const out = await jr().sync({ dryRun: !!dryRun, from });
    res.status(out.ok ? 200 : 502).json(out);
  } catch (e) { fail(res, e); }
});

// POST /api/vehicle/journeys/:journeyId/approve — Nick says this journey was the car. Body: miles (optional correction), vehicleId (when more than one), note. Counts in the mileage estimate, never as an odometer reading.
router.post('/journeys/:journeyId/approve', (req, res) => {
  try {
    const { miles, vehicleId, note } = req.body;
    send(res, jr().approve(req.params.journeyId, { miles, vehicleId: vehicleId ? idOf(vehicleId) : undefined, note }));
  } catch (e) { fail(res, e); }
});

// POST /api/vehicle/journeys/:journeyId/reject — not the car, or not a journey. Body: reason (not-the-car|not-a-journey). Kept, counts for nothing.
router.post('/journeys/:journeyId/reject', (req, res) => {
  try {
    const { reason } = req.body;
    send(res, jr().reject(req.params.journeyId, { reason }));
  } catch (e) { fail(res, e); }
});

// POST /api/vehicle/journeys/:journeyId/name-place — Nick names where a journey started or ended. Body: which (start|end), name. Saved from the journey's own position; every later drive there carries the name. Keywords: name place, label, location, journey.
router.post('/journeys/:journeyId/name-place', (req, res) => {
  try {
    const { which, name } = req.body;
    send(res, jr().namePlace(req.params.journeyId, { which, name }));
  } catch (e) { fail(res, e); }
});

// POST /api/vehicle/journeys/:journeyId/merge-next — join this pending journey with the next one (one drive that detection split, e.g. a crawl through traffic). Both must be pending, under an hour apart and within 2 km. Keywords: merge, join, combine journeys.
router.post('/journeys/:journeyId/merge-next', (req, res) => {
  try { send(res, jr().mergeWithNext(req.params.journeyId)); } catch (e) { fail(res, e); }
});

// POST /api/vehicle/journeys/:journeyId/reopen — undo an approval or rejection; the journey is pending again.
router.post('/journeys/:journeyId/reopen', (req, res) => {
  try { send(res, jr().reopen(req.params.journeyId)); } catch (e) { fail(res, e); }
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

// POST /api/vehicle/:id — Nick fills in what he knows about a vehicle. Body: plateDescriptor, registration, variant, fuelType, ownershipState, vin, firstRegistered, ownershipStart.
router.post('/:id', (req, res) => {
  try {
    if (!bodyOf(req)) return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { plateDescriptor, registration, variant, fuelType, ownershipState, vin, firstRegistered, ownershipStart } = req.body;
    const patch = {};
    for (const [k, v] of Object.entries({ plateDescriptor, registration, variant, fuelType, ownershipState, vin, firstRegistered, ownershipStart })) if (v !== undefined) patch[k] = v;
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

// POST /api/vehicle/:id/events — Nick records a service, repair, tyre or other maintenance event. Body: type, date, mileage, description, costRef (tally:<id>; amounts live in Tally), action, axle, position, brand, model, count, outcome.
router.post('/:id/events', (req, res) => {
  try {
    if (!bodyOf(req)) return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { type, date, mileage, description, costPence, costRef, action, axle, position, brand, model, count, outcome } = req.body;
    send(res, veh().addEvent(idOf(req.params.id), { type, date, mileage, description, costPence, costRef, action, axle, position, brand, model, count, outcome }));
  } catch (e) { fail(res, e); }
});

// POST /api/vehicle/:id/events/:eventId/withdraw — take back a history entry recorded in error.
router.post('/:id/events/:eventId/withdraw', (req, res) => {
  try { send(res, veh().withdrawEvent(idOf(req.params.id), req.params.eventId)); } catch (e) { fail(res, e); }
});

// POST /api/vehicle/:id/fuel — Nick records a fuel fill for MPG. Body: filledOn, litres, odometer, odometerUnit (mi|km), fullTank, note. Never an amount — that is Tally's.
router.post('/:id/fuel', (req, res) => {
  try {
    if (!bodyOf(req)) return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { filledOn, litres, odometer, odometerUnit, fullTank, note, amountPence, costPence } = req.body;
    send(res, veh().addFuelFill(idOf(req.params.id), { filledOn, litres, odometer, odometerUnit, fullTank, note, amountPence, costPence }));
  } catch (e) { fail(res, e); }
});

// POST /api/vehicle/:id/fuel/:fillId/withdraw — take back a fuel fill recorded in error.
router.post('/:id/fuel/:fillId/withdraw', (req, res) => {
  try { send(res, veh().withdrawFuelFill(idOf(req.params.id), req.params.fillId)); } catch (e) { fail(res, e); }
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
