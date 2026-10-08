'use strict';

/**
 * Build 21 — the Captur as a first-class Vehicle, and what NEURO can honestly
 * say about it.
 *
 *   entity       one row per real vehicle; unknown fields stay NULL
 *   mileage      odometer readings with provenance; current = latest
 *                TRUSTWORTHY reading (never the largest); implausible ones
 *                are kept and flagged for review, never corrected
 *   history      service / repairs / tyres … explicit only
 *   obligations  typed FACTS (MOT expiry, renewals). The action stays a task
 *                or reminder, linked; completing it never completes the fact
 *   official     what DVLA/DVSA (or gov.uk read by Nick) said, kept beside
 *                NEURO's value — a disagreement is shown, never overwritten
 *   metrics      fuel and ownership cost per mile, MPG — computed only from
 *                period-aligned, trustworthy inputs; otherwise a stated gap
 *
 * No manufacturer interval, tyre life, litre price or depreciation is assumed
 * anywhere. Machines may read; every write is Nick's (authority matrix).
 */

const crypto = require('crypto');

const OBLIGATION_TYPES = Object.freeze(['mot', 'insurance', 'service', 'warranty', 'breakdown_cover', 'tax']);
const OBLIGATION_LABELS = Object.freeze({ mot: 'MOT', insurance: 'Insurance', service: 'Service', warranty: 'Warranty', breakdown_cover: 'Breakdown cover', tax: 'Vehicle tax' });
const EVENT_TYPES = Object.freeze(['scheduled_service', 'repair', 'tyres', 'battery', 'brakes', 'exhaust', 'suspension', 'mot_work', 'other']);
const MILEAGE_SOURCES = Object.freeze(['manual', 'mot', 'service', 'tally', 'telemetry']);
const OFFICIAL_SOURCES = Object.freeze(['dvla-ves', 'dvsa-mot', 'gov-uk-by-hand']);
const KM_PER_MILE = 1.609344;
const LITRES_PER_UK_GALLON = 4.54609;

// NEURO's own presentation thresholds — stated, not manufacturer facts.
const UPCOMING_DAYS = 30;          // a dated obligation within 30 days is "upcoming"
const UPCOMING_MILES = 500;        // a mileage obligation within 500 miles is "upcoming"
const NEEDS_YOU_DAYS = 1;          // the existing personal-obligation rule (≤1 day ahead)
const PREP_NEEDS_YOU_DAYS = 2;     // the existing Radar prep rule (open prep ≤2 days out)
const MAX_MILES_PER_DAY = 1500;    // above this between two readings is not driving — needs review
const BOUNDARY_TOLERANCE_DAYS = 14; // a reading within 14 days of a period edge can stand for it
const PRESSURE_CHANGE = 0.2;       // ±20% …
const PRESSURE_MIN_PENCE = 10000;  // … and at least £100 between halves, to call cost "rising"/"falling"

// ── dates (pure) ─────────────────────────────────────────────────────────────
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function _validDay(s) {
  if (typeof s !== 'string' || !ISO_DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function daysBetween(a, b) { return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000); }
function addDays(day, n) { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function addMonths(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}
function localDay(ms = Date.now()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.NEURO_TIMEZONE || 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
function toMiles(value, unit) { return unit === 'km' ? value / KM_PER_MILE : value; }

// ── mileage (pure) ───────────────────────────────────────────────────────────

/**
 * Judge a set of readings. PURE. Sorted by date (then entry order). A reading
 * lower than the last accepted one is a REGRESSION unless Nick marked it an
 * odometer correction; a jump implying >1,500 miles a day is implausible.
 * Flagged readings are kept and shown, never used, never corrected.
 *   readings [{ id, value, unit, observedOn, confidence, correction, source }]
 */
function judgeMileage(readings = []) {
  const sorted = [...readings].sort((a, b) => a.observedOn.localeCompare(b.observedOn) || a.id - b.id);
  const judged = [];
  let last = null;
  for (const r of sorted) {
    const miles = toMiles(Number(r.value), r.unit);
    let review = null;
    if (last && !r.correction) {
      const days = Math.max(daysBetween(last.observedOn, r.observedOn), 0);
      if (miles < last.miles) review = `lower than ${Math.round(last.miles)} mi on ${last.observedOn} — needs review (if the odometer was replaced or corrected, mark it as a correction)`;
      else if (days === 0 && miles - last.miles > MAX_MILES_PER_DAY) review = `${Math.round(miles - last.miles)} mi more on the same day as the last reading — needs review`;
      else if (days > 0 && (miles - last.miles) / days > MAX_MILES_PER_DAY) review = `${Math.round((miles - last.miles) / days)} mi a day since ${last.observedOn} is not plausible — needs review`;
    }
    const out = { ...r, miles: Math.round(miles), state: review ? 'needs-review' : 'accepted', review };
    judged.push(out);
    if (!review) last = { miles, observedOn: r.observedOn };
  }
  return judged;
}

/** The latest trustworthy reading. PURE. Latest by DATE, not largest value. */
function currentMileage(judged = []) {
  const ok = judged.filter((r) => r.state === 'accepted');
  if (!ok.length) return null;
  const r = ok[ok.length - 1];
  return { miles: r.miles, value: r.value, unit: r.unit, observedOn: r.observedOn, source: r.source, confidence: r.confidence, readingId: r.id };
}

/**
 * Miles driven between two days, from accepted readings within the boundary
 * tolerance of each edge. PURE. null (with why) when either edge is unknown.
 */
function milesBetween(judged, from, to) {
  const ok = judged.filter((r) => r.state === 'accepted');
  const near = (day) => ok.filter((r) => Math.abs(daysBetween(day, r.observedOn)) <= BOUNDARY_TOLERANCE_DAYS)
    .sort((a, b) => Math.abs(daysBetween(day, a.observedOn)) - Math.abs(daysBetween(day, b.observedOn)))[0];
  const a = near(from);
  const b = near(to);
  if (!a || !b) return { miles: null, why: `no odometer reading within ${BOUNDARY_TOLERANCE_DAYS} days of ${!a ? from : to}` };
  if (a.id === b.id || a.observedOn >= b.observedOn) return { miles: null, why: 'one reading cannot measure a distance' };
  return { miles: b.miles - a.miles, from: a.observedOn, to: b.observedOn, why: null };
}

// ── obligations (pure) ───────────────────────────────────────────────────────

/**
 * Where an obligation's due date/mileage comes from. PURE. Explicit values win;
 * an interval is used ONLY if Nick gave one (with its basis) and a matching
 * history event exists to count from. Nothing comes from the model name.
 */
function effectiveDue(ob, events = []) {
  const out = { date: ob.due_date || null, mileage: ob.due_mileage != null ? Number(ob.due_mileage) : null, derived: false, from: null };
  if ((out.date && out.mileage != null) || !ob.interval_basis) return out;
  const kinds = ob.type === 'service' ? ['scheduled_service'] : ob.type === 'mot' ? ['mot_work'] : [];
  const lastEv = events.filter((e) => kinds.includes(e.type) && !e.withdrawn_at).sort((a, b) => b.event_date.localeCompare(a.event_date))[0];
  if (!lastEv) return out;
  if (!out.date && ob.interval_months) { out.date = addMonths(lastEv.event_date, Number(ob.interval_months)); out.derived = true; }
  if (out.mileage == null && ob.interval_miles && lastEv.mileage != null) { out.mileage = Number(lastEv.mileage) + Number(ob.interval_miles); out.derived = true; }
  if (out.derived) out.from = { eventId: lastEv.event_id, date: lastEv.event_date, mileage: lastEv.mileage, basis: ob.interval_basis };
  return out;
}

/**
 * The state of one obligation. PURE.
 *   later | upcoming | preparation_open | needs_you | complete | overdue | unknown
 * "Whichever comes first": the date and the mileage are judged separately and
 * the more urgent answer wins (`dueBy` says which).
 *   task  the linked task/reminder's canonical state, or null
 */
function obligationState(ob, { today, mileage = null, due = null, task = null } = {}) {
  if (ob.status === 'complete') return { state: 'complete', why: `done${ob.completed_on ? ` ${ob.completed_on}` : ''}${ob.completion_evidence ? ` — ${ob.completion_evidence}` : ''}`, dueBy: null };
  if (ob.status === 'cancelled') return { state: 'complete', why: 'cancelled', dueBy: null };
  const d = due || { date: ob.due_date, mileage: ob.due_mileage };
  const days = d.date ? daysBetween(today, d.date) : null;
  const milesLeft = d.mileage != null && mileage ? Math.round(d.mileage - mileage.miles) : null;
  if (days === null && milesLeft === null) {
    return { state: 'unknown', why: d.mileage != null ? 'due by mileage, but no current mileage is recorded' : 'no due date or mileage is recorded', dueBy: null };
  }
  const prepOpen = !!(task && (task.state === 'open' || task.state === 'in-progress'));
  const rank = { overdue: 6, needs_you: 5, preparation_open: 4, upcoming: 3, later: 2 };
  const judge = (by) => {
    if (by === 'date') {
      if (days < 0) return { state: 'overdue', why: `${-days} day${days === -1 ? '' : 's'} past ${d.date}` };
      if (days <= NEEDS_YOU_DAYS) return { state: 'needs_you', why: days === 0 ? 'due today' : 'due tomorrow' };
      if (prepOpen && days <= PREP_NEEDS_YOU_DAYS) return { state: 'needs_you', why: `due in ${days} days and its task is still open` };
      if (prepOpen) return { state: 'preparation_open', why: `due ${d.date}; your linked task is open` };
      if (days <= UPCOMING_DAYS) return { state: 'upcoming', why: `due in ${days} days (${d.date})` };
      return { state: 'later', why: `due ${d.date}` };
    }
    if (milesLeft <= 0) return { state: 'overdue', why: `${-milesLeft} mi past ${d.mileage} mi` };
    if (prepOpen) return { state: 'preparation_open', why: `due at ${d.mileage} mi; your linked task is open` };
    if (milesLeft <= UPCOMING_MILES) return { state: 'upcoming', why: `${milesLeft} mi to go` };
    return { state: 'later', why: `${milesLeft} mi to go (due at ${d.mileage} mi)` };
  };
  const a = days !== null ? { ...judge('date'), dueBy: 'date' } : null;
  const b = milesLeft !== null ? { ...judge('mileage'), dueBy: 'mileage' } : null;
  const best = [a, b].filter(Boolean).sort((x, y) => rank[y.state] - rank[x.state])[0];
  if (d.mileage != null && milesLeft === null) best.why += '; also due by mileage, but no current mileage is recorded';
  return best;
}

/**
 * NEURO's date vs the official source's. PURE. Returns a conflict record or
 * null. Nothing is overwritten — both values travel with their provenance.
 */
function officialConflict(ob, check) {
  if (!check || check.outcome !== 'ok' || ob.status !== 'open' || !ob.due_date) return null;
  const official = ob.type === 'mot' ? check.mot_expiry_date : ob.type === 'tax' ? check.tax_due_date : null;
  if (!official || official === ob.due_date) return null;
  return {
    message: 'Vehicle record differs from official source',
    field: ob.type === 'mot' ? 'MOT expiry' : 'tax due date',
    neuro: { value: ob.due_date, source: ob.source, provenance: ob.provenance_json ? JSON.parse(ob.provenance_json) : null },
    official: { value: official, source: check.source, observedAt: check.checked_at, enteredBy: check.entered_by },
  };
}

/** How sure NEURO is of an obligation's date. PURE. */
function obligationConfidence(ob, check) {
  if (ob.status !== 'open') return 'n/a';
  if (!ob.due_date && ob.due_mileage == null) return 'unknown';
  if (officialConflict(ob, check)) return 'conflict';
  const official = check && check.outcome === 'ok' ? (ob.type === 'mot' ? check.mot_expiry_date : ob.type === 'tax' ? check.tax_due_date : null) : null;
  if (official && official === ob.due_date) return 'verified';
  return 'stated';
}

// ── money & distance (pure) ──────────────────────────────────────────────────

/**
 * Finance coverage of a period: does Tally's data reach across it? PURE.
 *   dataFrom/dataThrough — the first and last transaction dates Tally holds.
 */
function financeCoverage(period, { dataFrom = null, dataThrough = null } = {}) {
  if (!dataFrom || !dataThrough) return { complete: false, why: 'Tally has not been read' };
  if (period.from < dataFrom) return { complete: false, why: `Tally's data starts ${dataFrom}` };
  if (period.to > dataThrough) return { complete: false, why: `Tally's data stops ${dataThrough} (its bank sync has not delivered since)` };
  return { complete: true, why: null };
}

/** Totals by spend type within a period. PURE. Pence, positive = spent. */
function spendByType(spend = [], { from, to } = {}) {
  const by = {};
  for (const s of spend) {
    if (s.date < from || s.date > to) continue;
    const t = s.classification.spendType;
    by[t] = (by[t] || 0) + -s.amountPence;
  }
  return by;
}

/** Costs recorded on history events that are NOT already a Tally transaction. PURE. */
function eventCosts(events = [], { from, to } = {}) {
  const map = { scheduled_service: 'service', repair: 'repair', tyres: 'tyres', battery: 'repair', brakes: 'repair', exhaust: 'repair', suspension: 'repair', mot_work: 'mot', other: 'other' };
  const by = {};
  for (const e of events) {
    if (e.withdrawn_at || e.cost_pence == null || e.cost_ref || e.event_date < from || e.event_date > to) continue;
    const t = map[e.type] || 'other';
    by[t] = (by[t] || 0) + Number(e.cost_pence);
  }
  return by;
}

function _sum(obj, keys) { return keys.reduce((a, k) => a + (obj[k] || 0), 0); }

/**
 * Fuel cost per mile for a period. PURE. Needs period-aligned fuel spend with
 * complete finance coverage AND a measured distance. Otherwise null + why.
 */
function fuelCostPerMile({ period, spend, judged, coverage }) {
  const miles = milesBetween(judged, period.from, period.to);
  const fuel = spendByType(spend, period).fuel || 0;
  const out = { period, numeratorPence: fuel, denominatorMiles: miles.miles, coverage: coverage.complete ? 'complete' : 'partial' };
  if (!coverage.complete) return { ...out, value: null, confidence: 'none', why: coverage.why };
  if (miles.miles == null || miles.miles <= 0) return { ...out, value: null, confidence: 'none', why: miles.why || 'no distance measured' };
  return { ...out, value: Math.round((fuel / miles.miles) * 10) / 10, unit: 'pence per mile', confidence: 'medium', why: null };
}

/**
 * Rolling 12-month ownership cost (21AA). PURE. Category totals are always
 * shown; per-mile only with complete coverage and a measured distance.
 */
function ownershipCost({ today, spend, events, judged, coverage }) {
  const OWN = require('./tally-vehicle').OWNERSHIP_TYPES;
  const period = { from: addMonths(today, -12), to: today };
  const fromTally = spendByType(spend, period);
  const fromEvents = eventCosts(events, period);
  const byType = {};
  for (const k of new Set([...Object.keys(fromTally), ...Object.keys(fromEvents)])) byType[k] = (fromTally[k] || 0) + (fromEvents[k] || 0);
  const totalPence = _sum(byType, OWN);
  const excluded = Object.fromEntries(Object.entries(byType).filter(([k]) => !OWN.includes(k)));
  const miles = milesBetween(judged, period.from, period.to);
  const base = { period, byType, totalPence, excluded, excludedNote: 'parking is shown but not counted; loan or finance payments are never counted', coverage: coverage.complete ? 'complete' : 'partial', coverageWhy: coverage.why };
  if (!coverage.complete) return { ...base, perMile: null, why: `a 12-month figure needs 12 months of finance data — ${coverage.why}` };
  if (miles.miles == null || miles.miles <= 0) return { ...base, perMile: null, why: miles.why };
  return { ...base, perMile: Math.round((totalPence / miles.miles) * 10) / 10, miles: miles.miles, why: null };
}

/**
 * MPG (21X). PURE. Needs fuel QUANTITY over a period AND the distance over the
 * same period. Fuel cost alone never yields MPG; no litre price is assumed.
 *   fills [{ date, litres }]
 */
function mpg({ period, fills = [], judged }) {
  const inP = fills.filter((f) => f.date >= period.from && f.date <= period.to && Number(f.litres) > 0);
  if (!inP.length) return { value: null, why: 'Not enough data to calculate MPG — no fuel quantity (litres) is recorded anywhere; Tally stores cost only' };
  const miles = milesBetween(judged, period.from, period.to);
  if (miles.miles == null || miles.miles <= 0) return { value: null, why: `Not enough data to calculate MPG — ${miles.why}` };
  const litres = inP.reduce((a, f) => a + Number(f.litres), 0);
  return { value: Math.round((miles.miles / (litres / LITRES_PER_UK_GALLON)) * 10) / 10, miles: miles.miles, litres, why: null };
}

/**
 * Cost pressure (21AF). PURE. Compares the last six months with the six
 * before, ONLY when finance covers both halves. stable / rising / falling,
 * else 'insufficient data'. Never a recommendation.
 */
function costPressure({ today, spend, events, financeRange }) {
  const OWN = require('./tally-vehicle').OWNERSHIP_TYPES;
  const recent = { from: addMonths(today, -6), to: today };
  const prior = { from: addMonths(today, -12), to: addDays(addMonths(today, -6), -1) };
  const cov = [financeCoverage(recent, financeRange), financeCoverage(prior, financeRange)];
  if (!cov.every((c) => c.complete)) return { state: 'insufficient data', why: cov.find((c) => !c.complete).why, rule: `±${PRESSURE_CHANGE * 100}% and at least £${PRESSURE_MIN_PENCE / 100} between the last six months and the six before, with finance data covering both` };
  const total = (p) => _sum(spendByType(spend, p), OWN) + _sum(eventCosts(events, p), OWN);
  const a = total(prior);
  const b = total(recent);
  const diff = b - a;
  let state = 'stable';
  if (Math.abs(diff) >= PRESSURE_MIN_PENCE && a > 0 && Math.abs(diff) / a >= PRESSURE_CHANGE) state = diff > 0 ? 'rising' : 'falling';
  return { state, priorPence: a, recentPence: b, why: null, rule: `±${PRESSURE_CHANGE * 100}% and at least £${PRESSURE_MIN_PENCE / 100}` };
}

// ── store ────────────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }
function _log(kind, detail, { subjectId, actor = 'nick', now = Date.now(), dedupeKey } = {}) {
  return require('./personal-obligations').logEvent(kind, { subjectId, actor, detail, dedupeKey: dedupeKey || `${kind}:${subjectId}:${now}`, now });
}
const _txt = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function slugFor(model) {
  const s = String(model || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return s ? `vehicle:${s}` : null;
}

function listVehicles() { return _db().all('SELECT * FROM vehicles ORDER BY created_at'); }
function getVehicle(id) { return typeof id === 'string' ? _db().get('SELECT * FROM vehicles WHERE vehicle_id = ?', [id]) || null : null; }

/**
 * Nick creates (or re-states) a vehicle. A second vehicle of the same make and
 * model is refused as a duplicate; "car" is not a model and is refused while a
 * real vehicle is held — no generic car beside the Captur.
 */
function createVehicle(body = {}, { now = Date.now(), actor = 'nick' } = {}) {
  const make = _txt(body.make, 60);
  const model = _txt(body.model, 60);
  if (!make || !model) return { ok: false, status: 400, error: 'make and model are required' };
  if (/^(car|vehicle|van)$/i.test(model)) return { ok: false, status: 400, error: 'a model name is required (not "car")' };
  const id = slugFor(model);
  const held = listVehicles();
  const same = held.find((v) => v.vehicle_id === id || (String(v.make).toLowerCase() === make.toLowerCase() && String(v.model).toLowerCase() === model.toLowerCase()));
  if (same) return { ok: true, already: true, vehicle: same };
  const iso = new Date(now).toISOString();
  const fields = { plate_descriptor: _txt(body.plateDescriptor, 30), registration: _txt(body.registration, 12), variant: _txt(body.variant, 80), fuel_type: _txt(body.fuelType, 20) };
  if (fields.registration) fields.registration = fields.registration.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const provenance = { statedBy: actor, statedAt: iso, note: _txt(body.provenanceNote, 300), fields: ['make', 'model', ...Object.keys(fields).filter((k) => fields[k])] };
  _db().run(`INSERT INTO vehicles (vehicle_id, make, model, plate_descriptor, registration, variant, fuel_type, ownership_state, source, provenance_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'current', ?, ?, ?, ?)`,
  [id, make, model, fields.plate_descriptor, fields.registration, fields.variant, fields.fuel_type, actor === 'nick' ? 'nick-stated' : actor, JSON.stringify(provenance), iso, iso]);
  _log('vehicle-created', { vehicle: `${make} ${model}`, fields: provenance.fields }, { subjectId: id, actor, now, dedupeKey: `vehicle-created:${id}` });
  return { ok: true, vehicle: getVehicle(id) };
}

/** Nick fills in a field he now knows (registration, variant…). Explicit only. */
function updateVehicle(id, body = {}, { now = Date.now(), actor = 'nick' } = {}) {
  const v = getVehicle(id);
  if (!v) return { ok: false, status: 404, error: 'no such vehicle' };
  const allowed = { plateDescriptor: 'plate_descriptor', registration: 'registration', variant: 'variant', fuelType: 'fuel_type', ownershipState: 'ownership_state' };
  const sets = [];
  const vals = [];
  const changed = [];
  for (const [k, col] of Object.entries(allowed)) {
    if (!(k in body)) continue;
    let val = body[k] === null ? null : _txt(body[k], 80);
    if (k === 'registration' && val) val = val.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (k === 'ownershipState' && !['current', 'sold', 'scrapped', 'unknown'].includes(val)) return { ok: false, status: 400, error: 'ownershipState must be current, sold, scrapped or unknown' };
    sets.push(`${col} = ?`); vals.push(val); changed.push(k);
  }
  if (!sets.length) return { ok: false, status: 400, error: 'nothing to change' };
  const prov = v.provenance_json ? JSON.parse(v.provenance_json) : {};
  prov.updates = [...(prov.updates || []), { fields: changed, by: actor, at: new Date(now).toISOString() }].slice(-20);
  _db().run(`UPDATE vehicles SET ${sets.join(', ')}, provenance_json = ?, updated_at = ? WHERE vehicle_id = ?`, [...vals, JSON.stringify(prov), new Date(now).toISOString(), id]);
  _log('vehicle-configured', { vehicle: `${v.make} ${v.model}`, fields: changed }, { subjectId: id, actor, now });
  return { ok: true, vehicle: getVehicle(id) };
}

function _readings(vehicleId) {
  return _db().all('SELECT * FROM vehicle_mileage WHERE vehicle_id = ? AND withdrawn_at IS NULL ORDER BY observed_on, id', [vehicleId])
    .map((r) => ({ id: r.id, value: r.value, unit: r.unit, observedOn: r.observed_on, source: r.source, confidence: r.confidence, correction: !!r.correction, note: r.note, provenance: r.provenance_json ? JSON.parse(r.provenance_json) : null }));
}

function addMileage(vehicleId, body = {}, { now = Date.now(), actor = 'nick' } = {}) {
  if (!getVehicle(vehicleId)) return { ok: false, status: 404, error: 'no such vehicle' };
  const value = Number(body.value);
  if (!Number.isFinite(value) || value < 0 || value > 2000000) return { ok: false, status: 400, error: 'value must be an odometer reading' };
  const unit = body.unit === 'km' ? 'km' : body.unit === undefined || body.unit === 'mi' ? 'mi' : null;
  if (!unit) return { ok: false, status: 400, error: 'unit must be mi or km' };
  if (!_validDay(body.observedOn)) return { ok: false, status: 400, error: 'observedOn must be YYYY-MM-DD' };
  if (body.observedOn > localDay(now)) return { ok: false, status: 400, error: 'a reading cannot be in the future' };
  const source = body.source || 'manual';
  if (!MILEAGE_SOURCES.includes(source)) return { ok: false, status: 400, error: `source must be one of ${MILEAGE_SOURCES.join(', ')}` };
  const confidence = ['high', 'medium', 'low'].includes(body.confidence) ? body.confidence : source === 'mot' ? 'high' : 'medium';
  const iso = new Date(now).toISOString();
  const r = _db().run(`INSERT INTO vehicle_mileage (vehicle_id, value, unit, observed_on, source, provenance_json, confidence, correction, note, recorded_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [vehicleId, value, unit, body.observedOn, source, JSON.stringify({ enteredBy: actor, enteredAt: iso, from: _txt(body.from, 200) }), confidence, body.correction ? 1 : 0, _txt(body.note, 300), iso]);
  const judged = judgeMileage(_readings(vehicleId));
  const mine = judged.find((x) => x.id === Number(r.lastInsertRowid));
  _log('mileage-added', { value, unit, observedOn: body.observedOn, source, state: mine ? mine.state : null }, { subjectId: vehicleId, actor, now });
  return { ok: true, reading: mine || null, current: currentMileage(judged) };
}

function withdrawMileage(vehicleId, readingId, { now = Date.now() } = {}) {
  const r = _db().run('UPDATE vehicle_mileage SET withdrawn_at = ? WHERE vehicle_id = ? AND id = ? AND withdrawn_at IS NULL', [new Date(now).toISOString(), vehicleId, Number(readingId)]);
  return r && r.changes ? { ok: true } : { ok: false, status: 404, error: 'no such reading' };
}

function _events(vehicleId) { return _db().all('SELECT * FROM vehicle_events WHERE vehicle_id = ? AND withdrawn_at IS NULL ORDER BY event_date DESC, recorded_at DESC', [vehicleId]); }

/** Nick records a service, repair, tyre fit… Never created from a payment. */
function addEvent(vehicleId, body = {}, { now = Date.now(), actor = 'nick' } = {}) {
  if (!getVehicle(vehicleId)) return { ok: false, status: 404, error: 'no such vehicle' };
  if (!EVENT_TYPES.includes(body.type)) return { ok: false, status: 400, error: `type must be one of ${EVENT_TYPES.join(', ')}` };
  if (!_validDay(body.date)) return { ok: false, status: 400, error: 'date must be YYYY-MM-DD' };
  const description = _txt(body.description, 400);
  if (!description) return { ok: false, status: 400, error: 'a description is required' };
  const mileage = body.mileage == null || body.mileage === '' ? null : Number(body.mileage);
  if (mileage !== null && !(Number.isFinite(mileage) && mileage >= 0)) return { ok: false, status: 400, error: 'mileage must be a number' };
  let costPence = body.costPence == null || body.costPence === '' ? null : Math.round(Number(body.costPence));
  if (costPence !== null && !Number.isFinite(costPence)) return { ok: false, status: 400, error: 'costPence must be a number' };
  let costRef = null;
  if (body.costRef != null) {
    if (!/^tally:\d+$/.test(String(body.costRef))) return { ok: false, status: 400, error: 'costRef must be tally:<id>' };
    const t = _db().get('SELECT * FROM tally_vehicle_txns WHERE source_txn_id = ?', [Number(String(body.costRef).slice(6))]);
    if (!t) return { ok: false, status: 404, error: 'NEURO holds no such Tally transaction' };
    costRef = body.costRef;
    if (costPence === null) costPence = -t.amount_pence;
  }
  const detail = {};
  if (body.type === 'tyres') for (const k of ['axle', 'position', 'brand', 'model', 'count']) if (body[k] != null && body[k] !== '') detail[k] = _txt(String(body[k]), 60);
  const id = `vev:${crypto.randomUUID()}`;
  const iso = new Date(now).toISOString();
  _db().run(`INSERT INTO vehicle_events (event_id, vehicle_id, type, event_date, mileage, description, cost_pence, cost_ref, detail_json, source, provenance_json, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, vehicleId, body.type, body.date, mileage, description, costPence, costRef, Object.keys(detail).length ? JSON.stringify(detail) : null, costRef ? 'tally-linked' : 'manual',
    JSON.stringify({ enteredBy: actor, enteredAt: iso, costFrom: costRef ? 'the Tally transaction' : costPence !== null ? 'as you entered it' : null }), iso]);
  _log('maintenance-recorded', { type: body.type, date: body.date, description }, { subjectId: vehicleId, actor, now });
  return { ok: true, event: _db().get('SELECT * FROM vehicle_events WHERE event_id = ?', [id]) };
}

function withdrawEvent(vehicleId, eventId, { now = Date.now() } = {}) {
  const r = _db().run('UPDATE vehicle_events SET withdrawn_at = ? WHERE vehicle_id = ? AND event_id = ? AND withdrawn_at IS NULL', [new Date(now).toISOString(), vehicleId, eventId]);
  return r && r.changes ? { ok: true } : { ok: false, status: 404, error: 'no such event' };
}

const TASK_REF = /^task:[^\s]{3,300}$/;

/** Nick adds a typed obligation. One open obligation per type per vehicle. */
function addObligation(vehicleId, body = {}, { now = Date.now(), actor = 'nick' } = {}) {
  if (!getVehicle(vehicleId)) return { ok: false, status: 404, error: 'no such vehicle' };
  if (!OBLIGATION_TYPES.includes(body.type)) return { ok: false, status: 400, error: `type must be one of ${OBLIGATION_TYPES.join(', ')}` };
  if (body.dueDate != null && !_validDay(body.dueDate)) return { ok: false, status: 400, error: 'dueDate must be YYYY-MM-DD' };
  const dueMileage = body.dueMileage == null || body.dueMileage === '' ? null : Number(body.dueMileage);
  if (dueMileage !== null && !(Number.isFinite(dueMileage) && dueMileage > 0)) return { ok: false, status: 400, error: 'dueMileage must be a positive number' };
  if (dueMileage !== null && body.type !== 'service' && body.type !== 'warranty') return { ok: false, status: 400, error: 'only a service or warranty can be due by mileage' };
  const im = body.intervalMonths == null || body.intervalMonths === '' ? null : Number(body.intervalMonths);
  const imi = body.intervalMiles == null || body.intervalMiles === '' ? null : Number(body.intervalMiles);
  const basis = _txt(body.intervalBasis, 200);
  if ((im || imi) && !basis) return { ok: false, status: 400, error: 'an interval needs its basis (where it comes from, e.g. "service book", "garage invoice")' };
  if (im !== null && !(Number.isInteger(im) && im > 0 && im <= 60)) return { ok: false, status: 400, error: 'intervalMonths must be 1–60' };
  if (imi !== null && !(imi > 0 && imi <= 100000)) return { ok: false, status: 400, error: 'intervalMiles must be 1–100000' };
  for (const k of ['linkedTaskRef', 'linkedReminderRef']) if (body[k] != null && !TASK_REF.test(String(body[k]))) return { ok: false, status: 400, error: `${k} must be a task id (task:…)` };
  if (_db().get("SELECT 1 FROM vehicle_obligations WHERE vehicle_id = ? AND type = ? AND status = 'open'", [vehicleId, body.type])) {
    return { ok: false, status: 409, error: `an open ${OBLIGATION_LABELS[body.type]} obligation already exists — complete or edit that one` };
  }
  const id = `vob:${crypto.randomUUID()}`;
  const iso = new Date(now).toISOString();
  _db().run(`INSERT INTO vehicle_obligations (obligation_id, vehicle_id, type, due_date, due_mileage, interval_months, interval_miles, interval_basis, linked_task_ref, linked_reminder_ref, status, source, provenance_json, note, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'manual', ?, ?, ?, ?)`,
  [id, vehicleId, body.type, body.dueDate || null, dueMileage, im, imi, basis, body.linkedTaskRef || null, body.linkedReminderRef || null,
    JSON.stringify({ enteredBy: actor, enteredAt: iso, from: _txt(body.from, 200) }), _txt(body.note, 300), iso, iso]);
  _log('vehicle-obligation-added', { type: body.type, label: OBLIGATION_LABELS[body.type], dueDate: body.dueDate || null, dueMileage }, { subjectId: vehicleId, actor, now, dedupeKey: `vehicle-obligation-added:${id}` });
  return { ok: true, obligation: _db().get('SELECT * FROM vehicle_obligations WHERE obligation_id = ?', [id]) };
}

/** Edit date/mileage/links of an open obligation. History is in Activity. */
function updateObligation(obligationId, body = {}, { now = Date.now(), actor = 'nick' } = {}) {
  const ob = _db().get('SELECT * FROM vehicle_obligations WHERE obligation_id = ?', [obligationId]);
  if (!ob) return { ok: false, status: 404, error: 'no such obligation' };
  if (ob.status !== 'open') return { ok: false, status: 409, error: 'only an open obligation can be edited' };
  const sets = [];
  const vals = [];
  if ('dueDate' in body) { if (body.dueDate !== null && !_validDay(body.dueDate)) return { ok: false, status: 400, error: 'dueDate must be YYYY-MM-DD' }; sets.push('due_date = ?'); vals.push(body.dueDate); }
  if ('dueMileage' in body) { const m = body.dueMileage === null ? null : Number(body.dueMileage); if (m !== null && !(m > 0)) return { ok: false, status: 400, error: 'dueMileage must be positive' }; sets.push('due_mileage = ?'); vals.push(m); }
  for (const [k, col] of [['linkedTaskRef', 'linked_task_ref'], ['linkedReminderRef', 'linked_reminder_ref']]) {
    if (!(k in body)) continue;
    if (body[k] !== null && !TASK_REF.test(String(body[k]))) return { ok: false, status: 400, error: `${k} must be a task id (task:…)` };
    sets.push(`${col} = ?`); vals.push(body[k]);
  }
  if (!sets.length) return { ok: false, status: 400, error: 'nothing to change' };
  _db().run(`UPDATE vehicle_obligations SET ${sets.join(', ')}, updated_at = ? WHERE obligation_id = ?`, [...vals, new Date(now).toISOString(), obligationId]);
  return { ok: true, obligation: _db().get('SELECT * FROM vehicle_obligations WHERE obligation_id = ?', [obligationId]) };
}

/**
 * Nick says the real-world obligation is done ("MOT passed, new expiry …").
 * Evidence is required — ticking "Book MOT" is not this. A next due date, if
 * he gives one, opens the next obligation of the same type.
 */
function resolveObligation(obligationId, body = {}, { now = Date.now(), actor = 'nick' } = {}) {
  const ob = _db().get('SELECT * FROM vehicle_obligations WHERE obligation_id = ?', [obligationId]);
  if (!ob) return { ok: false, status: 404, error: 'no such obligation' };
  if (ob.status !== 'open') return { ok: false, status: 409, error: 'already resolved' };
  const outcome = body.outcome === 'cancelled' ? 'cancelled' : 'complete';
  const evidence = _txt(body.evidence, 300);
  if (outcome === 'complete' && !evidence) return { ok: false, status: 400, error: 'say what shows it is done (e.g. "MOT passed — certificate", "renewed with Admiral") — a ticked task is not evidence' };
  if (body.completedOn != null && !_validDay(body.completedOn)) return { ok: false, status: 400, error: 'completedOn must be YYYY-MM-DD' };
  if (body.nextDueDate != null && !_validDay(body.nextDueDate)) return { ok: false, status: 400, error: 'nextDueDate must be YYYY-MM-DD' };
  const iso = new Date(now).toISOString();
  _db().run('UPDATE vehicle_obligations SET status = ?, completed_on = ?, completion_evidence = ?, updated_at = ? WHERE obligation_id = ?',
    [outcome, body.completedOn || localDay(now), evidence, iso, obligationId]);
  _log('vehicle-obligation-resolved', { type: ob.type, label: OBLIGATION_LABELS[ob.type], outcome, evidence, nextDueDate: body.nextDueDate || null }, { subjectId: ob.vehicle_id, actor, now, dedupeKey: `vehicle-obligation-resolved:${obligationId}` });
  let next = null;
  if (outcome === 'complete' && (body.nextDueDate || body.nextDueMileage)) {
    const r = addObligation(ob.vehicle_id, { type: ob.type, dueDate: body.nextDueDate || null, dueMileage: body.nextDueMileage || null,
      intervalMonths: ob.interval_months, intervalMiles: ob.interval_miles, intervalBasis: ob.interval_basis, from: `stated when ${OBLIGATION_LABELS[ob.type]} was done` }, { now, actor });
    next = r.ok ? r.obligation : null;
  }
  return { ok: true, outcome, next };
}

// ── official sources ─────────────────────────────────────────────────────────

/**
 * DVLA Vehicle Enquiry Service. Needs DVLA_VES_API_KEY and the registration.
 * Registration for new keys was CLOSED when this was built (8 Oct 2026), so
 * the honest answer is usually 'unavailable' with the reason.
 */
async function dvlaCheck(vehicle, { fetchImpl = global.fetch, key = process.env.DVLA_VES_API_KEY } = {}) {
  if (!key) return { outcome: 'unavailable', reason: 'no DVLA_VES_API_KEY — DVLA was not accepting new API registrations on 8 Oct 2026' };
  if (!vehicle.registration) return { outcome: 'unavailable', reason: 'the registration is not recorded — add it to the vehicle' };
  let res;
  try {
    res = await fetchImpl('https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles', {
      method: 'POST', headers: { 'x-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ registrationNumber: vehicle.registration }),
    });
  } catch (e) { return { outcome: 'error', reason: `DVLA unreachable: ${e.message}` }; }
  if (res.status === 404) return { outcome: 'not-found', reason: 'DVLA has no vehicle with that registration' };
  if (!res.ok) return { outcome: 'error', reason: `DVLA answered ${res.status}` };
  const j = await res.json();
  return {
    outcome: 'ok',
    taxStatus: j.taxStatus || null, taxDueDate: _validDay(j.taxDueDate) ? j.taxDueDate : null,
    motStatus: j.motStatus || null, motExpiryDate: _validDay(j.motExpiryDate) ? j.motExpiryDate : null,
    raw: { make: j.make || null, fuelType: j.fuelType || null, yearOfManufacture: j.yearOfManufacture || null, monthOfFirstRegistration: j.monthOfFirstRegistration || null },
  };
}

function _recordCheck(vehicleId, source, r, { now = Date.now(), enteredBy = 'neuro' } = {}) {
  _db().run(`INSERT INTO vehicle_official_checks (vehicle_id, source, checked_at, outcome, tax_status, tax_due_date, mot_status, mot_expiry_date, reason, raw_json, entered_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [vehicleId, source, new Date(now).toISOString(), r.outcome, r.taxStatus || null, r.taxDueDate || null, r.motStatus || null, r.motExpiryDate || null, r.reason || null, r.raw ? JSON.stringify(r.raw) : null, enteredBy]);
}

/** Run the DVLA check (records the outcome, including 'unavailable'). */
async function runOfficialCheck(vehicleId, { now = Date.now(), fetchImpl, key } = {}) {
  const v = getVehicle(vehicleId);
  if (!v) return { ok: false, status: 404, error: 'no such vehicle' };
  const r = await dvlaCheck(v, { ...(fetchImpl ? { fetchImpl } : {}), ...(key !== undefined ? { key } : {}) });
  _recordCheck(vehicleId, 'dvla-ves', r, { now });
  _noteConflicts(vehicleId, { now });
  return { ok: true, check: r };
}

/** Nick records what gov.uk "Check MOT history" / "Check if a vehicle is taxed" showed. */
function recordOfficialByHand(vehicleId, body = {}, { now = Date.now(), actor = 'nick' } = {}) {
  if (!getVehicle(vehicleId)) return { ok: false, status: 404, error: 'no such vehicle' };
  for (const k of ['taxDueDate', 'motExpiryDate']) if (body[k] != null && !_validDay(body[k])) return { ok: false, status: 400, error: `${k} must be YYYY-MM-DD` };
  const r = { outcome: 'ok', taxStatus: _txt(body.taxStatus, 30), taxDueDate: body.taxDueDate || null, motStatus: _txt(body.motStatus, 30), motExpiryDate: body.motExpiryDate || null, reason: 'read from gov.uk by Nick' };
  if (!r.taxStatus && !r.taxDueDate && !r.motStatus && !r.motExpiryDate) return { ok: false, status: 400, error: 'give at least one of taxStatus, taxDueDate, motStatus, motExpiryDate' };
  _recordCheck(vehicleId, 'gov-uk-by-hand', r, { now, enteredBy: actor });
  _noteConflicts(vehicleId, { now });
  return { ok: true, check: r };
}

function _latestCheck(vehicleId) {
  return _db().get("SELECT * FROM vehicle_official_checks WHERE vehicle_id = ? AND outcome = 'ok' ORDER BY checked_at DESC, id DESC LIMIT 1", [vehicleId]) || null;
}

function _noteConflicts(vehicleId, { now }) {
  const check = _latestCheck(vehicleId);
  for (const ob of _db().all("SELECT * FROM vehicle_obligations WHERE vehicle_id = ? AND status = 'open'", [vehicleId])) {
    const c = officialConflict(ob, check);
    if (c) _log('official-conflict-found', { type: ob.type, field: c.field, neuro: c.neuro.value, official: c.official.value, source: c.official.source }, { subjectId: vehicleId, actor: 'neuro', now, dedupeKey: `official-conflict:${ob.obligation_id}:${c.official.value}` });
  }
}

// ── links & suggestions ──────────────────────────────────────────────────────

const LINKABLE = /^(task:|commitment:|meeting:)/;
// "breakdown" alone is too broad — live, it matched "send breakdown of Parsons
// contacts" (8 Oct 2026). Only the motoring phrases count.
const SUGGEST_RE = /\b(car|captur|mot|tyres?|breakdown (?:cover|recovery)|road tax|car tax|car insurance|v5c|dvla|service the car)\b/i;

/** Explicit links held for a vehicle (personal_links relation 'concerns'). */
function links(vehicleId) {
  return _db().all("SELECT entity_id, set_at FROM personal_links WHERE subject_id = ? AND relation = 'concerns' ORDER BY set_at", [vehicleId]).map((r) => ({ entityId: r.entity_id, setAt: r.set_at }));
}

/**
 * Open tasks whose words MIGHT concern the vehicle — shown as suggestions,
 * never linked. PURE over the task list and the existing links.
 */
function linkSuggestions(tasks = [], linkedIds = new Set()) {
  return tasks.filter((t) => (t.state === 'open' || t.state === 'in-progress') && !linkedIds.has(t.id) && SUGGEST_RE.test(t.description || ''))
    .slice(0, 10).map((t) => ({ id: t.id, description: t.description, why: `its words mention "${(t.description.match(SUGGEST_RE) || [])[0]}" — a mention, not a link` }));
}

// ── the read model ───────────────────────────────────────────────────────────

function _taskIndex() {
  try {
    const items = require('./canonical-read').tasks({ status: 'all', limit: 2000 }).items || [];
    return new Map(items.map((t) => [t.id, t]));
  } catch { return new Map(); }
}

function _financeRange() {
  const st = (() => { try { return JSON.parse(_db().getState('tally_vehicle_sync') || 'null'); } catch { return null; } })();
  // Tally's first and last transaction dates, recorded by the sync over ALL
  // rows (the held rows are only candidates, so their range would be wrong).
  return { dataFrom: (st && st.dataFrom) || null, dataThrough: (st && st.dataThrough) || null, state: st };
}

/** Everything about one vehicle, as surfaces see it. */
function read(vehicleId, { now = Date.now() } = {}) {
  const v = getVehicle(vehicleId);
  if (!v) return null;
  const today = localDay(now);
  const judged = judgeMileage(_readings(vehicleId));
  const current = currentMileage(judged);
  const events = _events(vehicleId);
  const check = _latestCheck(vehicleId);
  const lastChecks = _db().all('SELECT * FROM vehicle_official_checks WHERE vehicle_id = ? ORDER BY checked_at DESC, id DESC LIMIT 5', [vehicleId]);
  const taskIndex = _taskIndex();
  const obligations = _db().all('SELECT * FROM vehicle_obligations WHERE vehicle_id = ? ORDER BY status, due_date', [vehicleId]).map((ob) => {
    const due = effectiveDue(ob, events);
    const task = ob.linked_task_ref ? taskIndex.get(ob.linked_task_ref) || null : null;
    const reminder = ob.linked_reminder_ref ? taskIndex.get(ob.linked_reminder_ref) || null : null;
    const st = obligationState(ob, { today, mileage: current, due, task: task || reminder });
    const conflict = officialConflict(ob, check);
    const actionDone = [task, reminder].filter((t) => t && t.state === 'completed');
    return {
      id: ob.obligation_id, vehicleRef: ob.vehicle_id, type: ob.type, label: OBLIGATION_LABELS[ob.type],
      dueDate: due.date, dueMileage: due.mileage, dueDerived: due.derived ? due.from : null,
      interval: ob.interval_months || ob.interval_miles ? { months: ob.interval_months, miles: ob.interval_miles, basis: ob.interval_basis } : null,
      linkedTaskRef: ob.linked_task_ref, linkedReminderRef: ob.linked_reminder_ref,
      linkedTask: task ? { id: task.id, description: task.description, state: task.state } : null,
      linkedReminder: reminder ? { id: reminder.id, description: reminder.description, state: reminder.state } : null,
      actionNote: actionDone.length && ob.status === 'open' ? `"${actionDone[0].description}" is ticked — that is the action, not the ${OBLIGATION_LABELS[ob.type]} itself, which is still recorded as open` : null,
      status: st.state, statusWhy: st.why, dueBy: st.dueBy, recordStatus: ob.status,
      completedOn: ob.completed_on, completionEvidence: ob.completion_evidence,
      source: ob.source, provenance: ob.provenance_json ? JSON.parse(ob.provenance_json) : null,
      verifiedBy: obligationConfidence(ob, check) === 'verified' ? check.source : null,
      confidence: obligationConfidence(ob, check), conflict, lastCheckedAt: check ? check.checked_at : null, note: ob.note,
    };
  });
  const tv = require('./tally-vehicle');
  const spend = tv.vehicleSpend({ vehicleId });
  const range = _financeRange();
  const month = today.slice(0, 7);
  const monthPeriod = { from: `${month}-01`, to: today };
  const own = ownershipCost({ today, spend, events, judged, coverage: financeCoverage({ from: addMonths(today, -12), to: today }, range) });
  const linked = links(vehicleId);
  const linkedIds = new Set(linked.map((l) => l.entityId));
  for (const ob of obligations) for (const r of [ob.linkedTaskRef, ob.linkedReminderRef]) if (r) linkedIds.add(r);
  return {
    vehicle: {
      id: v.vehicle_id, type: 'vehicle', make: v.make, model: v.model, plateDescriptor: v.plate_descriptor, registration: v.registration,
      variant: v.variant, fuelType: v.fuel_type, ownershipState: v.ownership_state, source: v.source,
      provenance: v.provenance_json ? JSON.parse(v.provenance_json) : null, createdAt: v.created_at, updatedAt: v.updated_at,
      currentMileage: current ? current.miles : null, mileageObservedAt: current ? current.observedOn : null,
      // VIN and purchase date are not modelled at all — always unknown.
      unknown: [
        ...(!v.registration ? ['registration'] : []), ...(!v.variant ? ['engine/trim'] : []), ...(!v.plate_descriptor ? ['plate'] : []),
        ...(!v.fuel_type ? ['fuel type'] : []), 'VIN', 'purchase date', ...(!current ? ['mileage'] : []),
      ],
    },
    mileage: { current, readings: judged.slice().reverse(), needsReview: judged.filter((r) => r.state === 'needs-review').length },
    obligations,
    history: events.map((e) => ({ id: e.event_id, type: e.type, date: e.event_date, mileage: e.mileage, description: e.description, costPence: e.cost_pence, costRef: e.cost_ref,
      detail: e.detail_json ? JSON.parse(e.detail_json) : null, source: e.source, provenance: e.provenance_json ? JSON.parse(e.provenance_json) : null })),
    official: { latest: check, recent: lastChecks, sources: officialSources(v) },
    links: linked,
    linkSuggestions: linkSuggestions([...taskIndex.values()], linkedIds),
    finance: {
      source: 'Tally (read-only)', range: { from: range.dataFrom, through: range.dataThrough }, sync: range.state,
      month: { period: monthPeriod, byType: spendByType(spend, monthPeriod), coverage: financeCoverage(monthPeriod, range) },
      ownership12m: own,
      fuelCostPerMile: fuelCostPerMile({ period: { from: addMonths(today, -3), to: today }, spend, judged, coverage: financeCoverage({ from: addMonths(today, -3), to: today }, range) }),
      mpg: mpg({ period: { from: addMonths(today, -3), to: today }, fills: [], judged }),
    },
    health: health({ today, spend, events, judged, obligations, range }),
    today,
  };
}

/** What official verification is possible for this vehicle, and why not. PURE. */
function officialSources(v) {
  return [
    { source: 'dvla-ves', name: 'DVLA Vehicle Enquiry Service', gives: 'tax status + tax due date, MOT status (+ expiry where returned)',
      available: !!(process.env.DVLA_VES_API_KEY && v.registration),
      why: !process.env.DVLA_VES_API_KEY ? 'needs an API key — DVLA was not accepting new registrations on 8 Oct 2026' : !v.registration ? 'needs the registration' : null },
    { source: 'dvsa-mot', name: 'DVSA MOT History API', gives: 'MOT tests, expiry, mileage at each test', available: false,
      why: 'needs DVSA registration (client id/secret via Microsoft Entra + API key) and the registration; not built until access exists' },
    { source: 'gov-uk-by-hand', name: 'gov.uk read by you', gives: 'whatever you record from "Check MOT history" / "Check if a vehicle is taxed"', available: true, why: null },
  ];
}

/** The evidence-only health view (21AE). PURE apart from what it is handed. */
function health({ today, spend, events, judged, obligations, range }) {
  const yearAgo = addMonths(today, -12);
  const repairs = events.filter((e) => ['repair', 'brakes', 'exhaust', 'suspension', 'battery'].includes(e.type) && e.event_date >= yearAgo);
  const maint = events.filter((e) => ['scheduled_service', 'tyres', 'mot_work'].includes(e.type) && e.event_date >= yearAgo);
  const repairSpend = spend.filter((s) => s.classification.spendType === 'repair' && s.date >= yearAgo);
  const accepted = judged.filter((r) => r.state === 'accepted');
  const gaps = [];
  if (!accepted.length) gaps.push('no odometer reading — nothing per mile can be calculated');
  else if (accepted.length < 2) gaps.push('one odometer reading — distance needs two');
  if (!range.dataThrough) gaps.push('Tally has not been read');
  else if (daysBetween(range.dataThrough, today) > 14) gaps.push(`Tally's finance data stops ${range.dataThrough} — its bank sync has not delivered since`);
  if (!spend.length) gaps.push('no transaction is confirmed as Captur spend yet');
  if (!events.length) gaps.push('no service, repair or tyre history recorded');
  if (!obligations.some((o) => o.recordStatus === 'open')) gaps.push('no MOT, tax, insurance or service date recorded');
  gaps.push('no fuel quantity anywhere — MPG cannot be calculated');
  return {
    rollingCost: ownershipCost({ today, spend, events, judged, coverage: financeCoverage({ from: yearAgo, to: today }, range) }),
    repairs12m: { count: repairs.length + repairSpend.length, events: repairs.length, transactions: repairSpend.length },
    maintenance12m: { count: maint.length },
    costPressure: costPressure({ today, spend, events, financeRange: range }),
    upcomingMajor: obligations.filter((o) => o.recordStatus === 'open' && ['needs_you', 'overdue', 'upcoming', 'preparation_open'].includes(o.status)).map((o) => ({ label: o.label, status: o.status, why: o.statusWhy })),
    mileageTrend: accepted.map((r) => ({ date: r.observedOn, miles: r.miles })),
    gaps,
    stance: 'Evidence only. NEURO does not recommend replacing, selling or buying a vehicle.',
  };
}

/** One deterministic monthly summary (21AC). PURE over `read()`'s output. */
function monthlySummary(r, month) {
  const from = `${month}-01`;
  const to = addDays(addMonths(from, 1), -1);
  const tv = require('./tally-vehicle');
  const spend = tv.vehicleSpend({ vehicleId: r.vehicle.id });
  const by = spendByType(spend, { from, to });
  const evCost = eventCosts(r.history.map((h) => ({ event_date: h.date, cost_pence: h.costPence, cost_ref: h.costRef, type: h.type })), { from, to });
  const readings = (r.mileage.readings || []).filter((x) => x.state === 'accepted').slice().reverse();
  const added = milesBetween(readings, from, to);
  const cov = financeCoverage({ from, to }, { dataFrom: r.finance.range.from, dataThrough: r.finance.range.through });
  return {
    month, vehicleId: r.vehicle.id,
    latestMileage: r.mileage.current ? { miles: r.mileage.current.miles, observedOn: r.mileage.current.observedOn } : null,
    milesThisMonth: added.miles, milesWhy: added.why,
    fuelPence: by.fuel || 0,
    otherVehiclePence: Object.entries(by).filter(([k]) => k !== 'fuel').reduce((a, [, v]) => a + v, 0) + Object.values(evCost).reduce((a, v) => a + v, 0),
    fuelCostPerMile: added.miles && cov.complete ? Math.round(((by.fuel || 0) / added.miles) * 10) / 10 : null,
    ownershipCostPerMile12m: r.finance.ownership12m.perMile,
    maintenance: r.history.filter((h) => h.date >= from && h.date <= to).map((h) => ({ type: h.type, date: h.date, description: h.description })),
    upcoming: r.obligations.filter((o) => o.recordStatus === 'open' && o.status !== 'later').map((o) => ({ label: o.label, status: o.status, dueDate: o.dueDate, dueMileage: o.dueMileage })),
    financeCoverage: cov.complete ? 'complete' : `partial — ${cov.why}`,
    gaps: r.health.gaps,
  };
}

/** Radar items for vehicle obligations (21AH). PURE over `read()`. */
function radarItems(r, { today, last }) {
  const name = `${r.vehicle.make} ${r.vehicle.model}`;
  const map = { overdue: 'needs_you', needs_you: 'needs_you', preparation_open: 'preparation_open', upcoming: 'none', later: 'none', unknown: 'unknown' };
  const out = [];
  for (const o of r.obligations) {
    if (o.recordStatus !== 'open') continue;
    const actionState = map[o.status] || 'unknown';
    const inWindow = o.dueDate && o.dueDate >= today && o.dueDate <= last;
    if (!inWindow && actionState !== 'needs_you') continue;
    out.push({
      id: o.id, title: `${r.vehicle.model} — ${o.label}`, detail: o.dueMileage != null ? `or at ${o.dueMileage} mi, whichever comes first` : null,
      date: o.dueDate, kind: 'vehicle', obligationType: o.type, actionState, needsWhy: o.statusWhy,
      linkedTaskRefs: [o.linkedTaskRef, o.linkedReminderRef].filter(Boolean),
      whyVisible: [`a ${o.label} date you recorded for the ${name}`, o.statusWhy, o.conflict ? `${o.conflict.message} (${o.conflict.official.value})` : null].filter(Boolean),
      vehicle: { id: r.vehicle.id, name },
      confidence: o.confidence === 'conflict' ? 'low' : o.confidence === 'verified' ? 'high' : 'medium',
    });
  }
  return out;
}

/** Radar reader: every current vehicle. Errors are returned, never thrown. */
function radar({ today, last, now = Date.now() } = {}) {
  const items = [];
  try {
    for (const v of listVehicles().filter((x) => x.ownership_state === 'current')) items.push(...radarItems(read(v.vehicle_id, { now }), { today, last }));
  } catch (e) { return { items, error: e.message }; }
  return { items };
}

/**
 * The durable job body: read Tally, then — Mondays — refresh MPG readiness
 * and — on the 1st (or the first run of a month) — store last month's summary.
 * Activity only on meaningful change.
 */
async function refresh({ now = Date.now(), reader = null } = {}) {
  const tv = require('./tally-vehicle');
  const sync = await tv.sync({ now, reader });
  const out = { sync };
  const today = localDay(now);
  const prevMonth = addMonths(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
  for (const v of listVehicles().filter((x) => x.ownership_state === 'current')) {
    const r = read(v.vehicle_id, { now });
    // weekly MPG readiness — recorded quietly; never an Activity line or a push
    const mpgState = { at: new Date(now).toISOString(), value: r.finance.mpg.value, why: r.finance.mpg.why };
    _db().setState(`vehicle_mpg:${v.vehicle_id}`, JSON.stringify(mpgState));
    if (!_db().get('SELECT 1 FROM vehicle_monthly_summaries WHERE month = ? AND vehicle_id = ?', [prevMonth, v.vehicle_id]) && v.created_at.slice(0, 7) <= prevMonth) {
      const s = monthlySummary(r, prevMonth);
      _db().run('INSERT OR IGNORE INTO vehicle_monthly_summaries (month, vehicle_id, summary_json, produced_at) VALUES (?, ?, ?, ?)', [prevMonth, v.vehicle_id, JSON.stringify(s), new Date(now).toISOString()]);
      _log('vehicle-summary-produced', { month: prevMonth, vehicle: `${v.make} ${v.model}`, gaps: s.gaps.length }, { subjectId: v.vehicle_id, actor: 'neuro', now, dedupeKey: `vehicle-summary:${v.vehicle_id}:${prevMonth}` });
      out.summary = prevMonth;
    }
    // a material change in what is missing — one line, not one per pass
    const sig = r.health.gaps.map((g) => g.replace(/\d{4}-\d{2}-\d{2}/g, 'DATE')).join('|');
    const key = `vehicle_gaps:${v.vehicle_id}`;
    const prev = _db().getState(key);
    if (prev !== sig) {
      _db().setState(key, sig);
      if (prev !== null && prev !== undefined) _log('vehicle-gaps-changed', { vehicle: `${v.make} ${v.model}`, gaps: r.health.gaps }, { subjectId: v.vehicle_id, actor: 'neuro', now, dedupeKey: `vehicle-gaps:${v.vehicle_id}:${sig}` });
    }
  }
  if (sync && sync.ok === false) throw new Error(sync.error);
  return out;
}

function summaries(vehicleId) {
  return _db().all('SELECT * FROM vehicle_monthly_summaries WHERE vehicle_id = ? ORDER BY month DESC LIMIT 12', [vehicleId]).map((r) => ({ month: r.month, producedAt: r.produced_at, summary: JSON.parse(r.summary_json) }));
}

const TABLES = ['vehicles', 'vehicle_mileage', 'vehicle_events', 'vehicle_obligations', 'vehicle_official_checks', 'vehicle_monthly_summaries'];

module.exports = {
  OBLIGATION_TYPES, OBLIGATION_LABELS, EVENT_TYPES, MILEAGE_SOURCES, OFFICIAL_SOURCES, TABLES,
  UPCOMING_DAYS, UPCOMING_MILES, MAX_MILES_PER_DAY,
  // pure
  judgeMileage, currentMileage, milesBetween, effectiveDue, obligationState, officialConflict, obligationConfidence,
  financeCoverage, spendByType, eventCosts, fuelCostPerMile, ownershipCost, mpg, costPressure, linkSuggestions,
  monthlySummary, radarItems, officialSources, slugFor, localDay, addMonths,
  // official
  dvlaCheck, runOfficialCheck, recordOfficialByHand,
  // store
  listVehicles, getVehicle, createVehicle, updateVehicle, addMileage, withdrawMileage, addEvent, withdrawEvent,
  addObligation, updateObligation, resolveObligation, links, read, radar, refresh, summaries,
};
