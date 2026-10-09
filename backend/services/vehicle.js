'use strict';

/**
 * Build 21 → Build 27 — the Captur as a first-class Vehicle, and what NEURO can
 * honestly say about it.
 *
 *   entity       one row per real vehicle; unknown fields stay NULL
 *   mileage      odometer readings with provenance; current = latest
 *                TRUSTWORTHY reading (never the largest); implausible ones
 *                are kept and flagged for review, never corrected. Never from
 *                GPS, routes or movement.
 *   history      service / repairs / tyres … explicit only; a cost is a
 *                reference to Tally (tally:<id>), never an amount held here
 *   obligations  typed FACTS (MOT expiry, renewals). The action stays a task
 *                or reminder, linked; completing it never completes the fact
 *   official     what DVLA/DVSA (or gov.uk read by Nick) said, kept beside
 *                NEURO's value — a disagreement is shown, never overwritten
 *   fuel         fills Nick records (litres, odometer, brim-full) → MPG only
 *                from that evidence; no litre price, no spec-sheet figure
 *
 * ⚠ BUILD 27 BOUNDARY: every financial number about the car is Tally's. NEURO
 * reads `vehicleFinance` from finance-intelligence-v1 (finance.js's stored
 * snapshot) and shows it unchanged. The ONE calculation here that touches money
 * is cost per mile, a composition: Tally's total for a window of complete months
 * divided by the miles NEURO's odometer readings measure over the same window —
 * refused when the readings do not reach its edges. No manufacturer interval,
 * tyre life, litre price or depreciation is assumed anywhere. Machines may read;
 * every write is Nick's (authority matrix).
 */

const crypto = require('crypto');

const OBLIGATION_TYPES = Object.freeze(['mot', 'insurance', 'service', 'warranty', 'breakdown_cover', 'tax']);
const OBLIGATION_LABELS = Object.freeze({ mot: 'MOT', insurance: 'Insurance', service: 'Service', warranty: 'Warranty', breakdown_cover: 'Breakdown cover', tax: 'Vehicle tax' });
const EVENT_TYPES = Object.freeze(['scheduled_service', 'repair', 'breakdown', 'battery', 'brakes', 'tyres', 'exhaust', 'fluids', 'suspension', 'inspection', 'mot_work', 'other']);
const TYRE_ACTIONS = Object.freeze(['fitted', 'replaced', 'repaired', 'puncture', 'inspection']);
const OUTCOMES = Object.freeze(['resolved', 'unresolved', 'monitoring']);
const REPAIR_KINDS = Object.freeze(['repair', 'breakdown', 'battery', 'brakes', 'exhaust', 'suspension']);
// Where an odometer reading may come from. NOT 'gps', 'route', 'location' or
// 'movement' — distance travelled is not what the odometer says (27I).
const MILEAGE_SOURCES = Object.freeze(['manual', 'mot', 'service', 'telemetry']);
const OFFICIAL_SOURCES = Object.freeze(['dvla-ves', 'dvsa-mot', 'gov-uk-by-hand']);
// Words that name each obligation type in a task — used only to OFFER a link.
const TYPE_WORDS = Object.freeze({
  mot: /\bMOT\b/i, tax: /\b(road|car|vehicle) tax\b|\btax\b/i, insurance: /\binsurance\b/i,
  service: /\bservic(e|ed|ing)\b/i, warranty: /\bwarranty\b/i, breakdown_cover: /\bbreakdown (cover|recovery)\b/i,
});
const KM_PER_MILE = 1.609344;
const LITRES_PER_UK_GALLON = 4.54609;

// NEURO's own presentation thresholds — stated, not manufacturer facts.
const UPCOMING_DAYS = 30;          // a dated obligation within 30 days is "upcoming"
const UPCOMING_MILES = 500;        // a mileage obligation within 500 miles is "upcoming"
const NEEDS_YOU_DAYS = 1;          // the existing personal-obligation rule (≤1 day ahead)
const PREP_NEEDS_YOU_DAYS = 2;     // the existing Radar prep rule (open prep ≤2 days out)
const MAX_MILES_PER_DAY = 1500;    // above this between two readings is not driving — needs review
const BOUNDARY_TOLERANCE_DAYS = 14; // a reading within 14 days of a period edge can stand for it
const ALIGNED_DAYS = 3;            // …and within 3 days the window counts as aligned, not approximate
const MPG_ROLLING_DAYS = 90;       // the rolling MPG window

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

// ── money: Tally's, never NEURO's (pure) ─────────────────────────────────────

/**
 * This vehicle's finance exactly as Tally's `vehicleFinance` section says. PURE
 * over finance.js's stored snapshot ({ fetchedAt, contract }). No figure is
 * made here; a missing section or vehicle says why.
 */
function tallyVehicleFinance(snapshot, vehicleId) {
  const base = { source: 'Tally', reviewIn: 'Tally → Outlook → Motoring', fetchedAt: (snapshot && snapshot.fetchedAt) || null };
  if (!snapshot || !snapshot.contract) return { ...base, available: false, state: 'unread', why: 'Tally has not been read yet' };
  const vf = snapshot.contract.vehicleFinance;
  if (!vf || !Array.isArray(vf.vehicles)) return { ...base, available: false, state: 'not-offered', why: "Tally's finance contract has no vehicleFinance section — Tally needs Build 27" };
  const mine = vf.vehicles.find((v) => v.vehicleRef === vehicleId) || null;
  const unassigned = vf.vehicles.find((v) => v.vehicleRef == null) || null;
  const out = {
    ...base, reviewIn: vf.reviewIn || base.reviewIn, freshness: vf.meta.freshness, review: vf.review, rules: vf.rules,
    unassigned: unassigned ? { transactions: unassigned.classified.transactions, why: 'classified as motoring in Tally without saying which vehicle' } : null,
  };
  if (!mine) return { ...out, available: false, state: 'nothing-classified', confidence: vf.meta.confidence, explanation: vf.meta.explanation, why: `nothing in Tally is classified as this vehicle's yet${vf.review && vf.review.pending ? ` — ${vf.review.pending} transaction(s) wait for review in Tally` : ''}` };
  return {
    ...out, available: true, state: 'read', confidence: mine.confidence, explanation: [...vf.meta.explanation, ...mine.explanation], why: null,
    classified: mine.classified, currentMonth: mine.currentMonth, latestCompleteMonth: mine.latestCompleteMonth, months: mine.months,
    last3CompleteMonths: mine.last3CompleteMonths, last6CompleteMonths: mine.last6CompleteMonths, rolling12m: mine.rolling12m, trend: mine.trend,
  };
}

/**
 * Cost per mile (27P) — the one composition. PURE. Numerator: Tally's total
 * for a window of complete months, passed through unchanged. Denominator: miles
 * measured by accepted odometer readings at that window's edges. The longest
 * Tally window with a measured distance wins; readings more than
 * BOUNDARY_TOLERANCE_DAYS from an edge cannot measure it (refused), more than
 * ALIGNED_DAYS marks it approximate.
 */
function costPerMile(fin, judged) {
  if (!fin || !fin.available) return { value: null, state: 'unavailable', why: fin ? fin.why : 'no finance read' };
  const windows = [fin.rolling12m, fin.last6CompleteMonths, fin.last3CompleteMonths].filter((w) => w && w.available);
  if (!windows.length) return { value: null, state: 'insufficient_data', why: `Tally has no complete window of months yet — ${(fin.last3CompleteMonths && fin.last3CompleteMonths.why) || 'no complete month'}` };
  for (const w of windows) {
    const m = milesBetween(judged, w.from, w.to);
    if (m.miles == null || m.miles <= 0) continue;
    const off = Math.max(Math.abs(daysBetween(w.from, m.from)), Math.abs(daysBetween(w.to, m.to)));
    const aligned = off <= ALIGNED_DAYS;
    return {
      value: Math.round((w.totalVehicleSpendPence / m.miles) * 10) / 10,
      fuelValue: Math.round((w.fuelSpendPence / m.miles) * 10) / 10,
      unit: 'pence per mile', state: aligned ? 'aligned' : 'partial',
      numerator: { totalPence: w.totalVehicleSpendPence, fuelPence: w.fuelSpendPence, from: w.from, to: w.to, months: w.months, source: 'Tally' },
      denominator: { miles: m.miles, from: m.from, to: m.to, source: 'your odometer readings' },
      why: aligned ? null : `odometer readings sit up to ${off} days from Tally's window (${w.from} – ${w.to}) — approximate`,
    };
  }
  return { value: null, state: 'insufficient_data', why: `no two odometer readings within ${BOUNDARY_TOLERANCE_DAYS} days of the edges of a complete Tally window (${windows.map((w) => `${w.from} – ${w.to}`).join(', ')})` };
}

/**
 * MPG from recorded fills (27N/O). PURE. MEASURED only between two brim-full
 * fills with the odometer read at both (every fill between needs its litres);
 * ESTIMATED between consecutive fills with odometers when no brim-full pair
 * exists (it assumes the tank was filled to the same level); otherwise
 * insufficient_data with the reason. No litres → no MPG, ever.
 *   fills [{ id, filledOn, litres, odometer, odometerUnit, fullTank }]
 */
function mpgFromFills(fills = [], { today } = {}) {
  const live = fills.filter((f) => Number(f.litres) > 0).sort((a, b) => a.filledOn.localeCompare(b.filledOn) || (a.odometer || 0) - (b.odometer || 0));
  const none = (why) => ({ state: 'insufficient_data', why, latest: null, rolling: null, segments: 0 });
  if (!fills.length) return none('no fuel fill is recorded — MPG needs litres and the odometer at the pump');
  if (!live.length) return none('no fill has litres recorded');
  const miles = (f) => (f.odometer == null ? null : toMiles(Number(f.odometer), f.odometerUnit));
  const segs = [];
  let lastFull = null;
  for (let i = 0; i < live.length; i++) {
    const f = live[i];
    if (f.fullTank && miles(f) != null) {
      if (lastFull) {
        const between = live.slice(lastFull.i + 1, i + 1);
        const d = miles(f) - miles(lastFull.f);
        if (d > 0) segs.push({ from: lastFull.f.filledOn, to: f.filledOn, miles: d, litres: between.reduce((a, x) => a + Number(x.litres), 0), quality: 'measured' });
      }
      lastFull = { f, i };
    }
  }
  if (!segs.length) {
    const odo = live.filter((f) => miles(f) != null);
    for (let i = 1; i < odo.length; i++) {
      const d = miles(odo[i]) - miles(odo[i - 1]);
      if (d > 0) segs.push({ from: odo[i - 1].filledOn, to: odo[i].filledOn, miles: d, litres: Number(odo[i].litres), quality: 'estimated' });
    }
  }
  if (!segs.length) return none('needs two fills with the odometer read at each (brim-full at both for a measured figure)');
  const mpgOf = (m, l) => Math.round((m / (l / LITRES_PER_UK_GALLON)) * 10) / 10;
  const last = segs[segs.length - 1];
  const since = today ? addDays(today, -MPG_ROLLING_DAYS) : null;
  const recent = since ? segs.filter((x) => x.to >= since) : segs;
  const rm = recent.reduce((a, x) => a + x.miles, 0);
  const rl = recent.reduce((a, x) => a + x.litres, 0);
  return {
    state: last.quality, why: last.quality === 'estimated' ? 'no two brim-full fills with odometer readings — estimated from consecutive fills, assuming the tank was filled to the same level' : null,
    latest: { mpg: mpgOf(last.miles, last.litres), from: last.from, to: last.to, miles: Math.round(last.miles), litres: Math.round(last.litres * 100) / 100, quality: last.quality },
    rolling: recent.length ? { mpg: mpgOf(rm, rl), days: MPG_ROLLING_DAYS, segments: recent.length, quality: recent.every((x) => x.quality === 'measured') ? 'measured' : 'estimated' } : null,
    segments: segs.length,
  };
}

/**
 * Evidence-only health (27U). PURE. attention_needed only for a real fault:
 * an overdue MOT, expired tax or insurance, an overdue EXPLICIT service, or a
 * repair recorded as unresolved. incomplete_data when the core dates are not
 * recorded. Age, mileage and cost never make a car unhealthy.
 */
function health({ obligations = [], events = [], today }) {
  const open = obligations.filter((o) => o.recordStatus === 'open');
  const attention = [];
  for (const o of open) {
    if (o.status !== 'overdue') continue;
    const word = o.type === 'insurance' || o.type === 'tax' || o.type === 'breakdown_cover' || o.type === 'warranty' ? 'expired' : 'overdue';
    attention.push({ kind: `${o.type}-${word}`, line: `${o.label} ${word} — ${o.statusWhy}`, ref: o.id });
  }
  for (const e of events) {
    const d = e.detail_json ? JSON.parse(e.detail_json) : {};
    if (REPAIR_KINDS.includes(e.type) && d.outcome === 'unresolved') attention.push({ kind: 'repair-unresolved', line: `Unresolved: ${e.description} (${e.event_date})`, ref: e.event_id });
  }
  const missing = ['mot', 'tax', 'insurance'].filter((t) => !open.some((o) => o.type === t && (o.dueDate || o.dueMileage != null)));
  const state = attention.length ? 'attention_needed' : missing.length ? 'incomplete_data' : 'current';
  return {
    state, attention,
    missing: missing.map((t) => `no ${OBLIGATION_LABELS[t]} date recorded`),
    why: attention.length ? attention.map((a) => a.line) : missing.length ? [`Cannot say the car is current: ${missing.map((t) => OBLIGATION_LABELS[t]).join(', ')} not recorded.`] : ['MOT, tax and insurance are recorded and in date; nothing recorded is unresolved.'],
    rule: 'Only an overdue MOT, expired tax or insurance, an overdue service you recorded, or a repair you marked unresolved needs attention. Age, mileage and cost never do.',
  };
}

/** A UK plate age identifier → the registration window it implies. PURE. "65-plate" → Sep 2015 – Feb 2016. */
function plateWindow(descriptor) {
  const m = String(descriptor || '').match(/\b(\d{2})\s*-?\s*plate\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (n >= 2 && n <= 49) return { from: `20${String(n).padStart(2, '0')}-03`, to: `20${String(n).padStart(2, '0')}-08`, basis: `a ${m[1]} plate` };
  if (n >= 51 && n <= 99) { const y = 2000 + n - 50; return { from: `${y}-09`, to: `${y + 1}-02`, basis: `a ${m[1]} plate` }; }
  return null;
}

/**
 * Replacement evidence (27V). PURE. Lists what is KNOWN — age, mileage, repair
 * history, running-cost trend (Tally's word), finance repayments (Tally's) —
 * and never recommends. state: evidence_available | insufficient_data.
 */
function replacementEvidence({ vehicle, current, events = [], fin, today }) {
  const yearAgo = addMonths(today, -12);
  const plate = vehicle.first_registered ? { from: vehicle.first_registered.slice(0, 7), to: vehicle.first_registered.slice(0, 7), basis: 'first registration you recorded' } : plateWindow(vehicle.plate_descriptor);
  const repairs12 = events.filter((e) => REPAIR_KINDS.includes(e.type) && e.event_date >= yearAgo);
  const unresolved = events.filter((e) => REPAIR_KINDS.includes(e.type) && (e.detail_json ? JSON.parse(e.detail_json).outcome === 'unresolved' : false));
  const maint24 = events.filter((e) => ['scheduled_service', 'tyres', 'mot_work', 'fluids', 'inspection'].includes(e.type) && e.event_date >= addMonths(today, -24));
  const lc = fin && fin.available ? fin.latestCompleteMonth : null;
  const items = [
    { key: 'age', known: !!plate, value: plate ? `registered ${plate.from === plate.to ? plate.from : `${plate.from} – ${plate.to}`} (${plate.basis})` : null, why: plate ? null : 'no plate or first registration recorded' },
    { key: 'mileage', known: !!current, value: current ? `${current.miles.toLocaleString('en-GB')} mi on ${current.observedOn}` : null, why: current ? null : 'no odometer reading recorded' },
    { key: 'repairs', known: events.length > 0, value: events.length ? `${repairs12.length} repair${repairs12.length === 1 ? '' : 's'} in 12 months${unresolved.length ? `, ${unresolved.length} unresolved` : ''}` : null, why: events.length ? null : 'no service or repair history recorded' },
    { key: 'maintenance', known: events.length > 0, value: events.length ? `${maint24.length} maintenance entr${maint24.length === 1 ? 'y' : 'ies'} in 24 months` : null, why: events.length ? null : 'no history recorded' },
    { key: 'runningCostTrend', known: !!(fin && fin.available && fin.trend && fin.trend.state !== 'insufficient_data'), value: fin && fin.available && fin.trend && fin.trend.state !== 'insufficient_data' ? `Tally: ${String(fin.trend.state).replace(/_/g, ' ')}` : null, why: fin && fin.available ? (fin.trend && fin.trend.why) || null : (fin ? fin.why : 'no finance read') },
    { key: 'finance', known: !!(lc && lc.financeRepaymentsPence > 0), value: lc && lc.financeRepaymentsPence > 0 ? 'finance repayments classified as the car\'s in Tally' : null, why: 'unknown — no finance repayment is classified as the car\'s in Tally (that is not the same as having none)' },
  ];
  const known = items.filter((i) => i.known).length;
  return { state: known >= 3 ? 'evidence_available' : 'insufficient_data', items, known, stance: 'Evidence only. NEURO makes no keep, sell, replace or buy recommendation unless you ask for one.' };
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
  const allowed = { plateDescriptor: 'plate_descriptor', registration: 'registration', variant: 'variant', fuelType: 'fuel_type', ownershipState: 'ownership_state',
    vin: 'vin', firstRegistered: 'first_registered', ownershipStart: 'ownership_start' };
  const sets = [];
  const vals = [];
  const changed = [];
  for (const [k, col] of Object.entries(allowed)) {
    if (!(k in body)) continue;
    let val = body[k] === null ? null : _txt(body[k], 80);
    if (k === 'registration' && val) val = val.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (k === 'ownershipState' && !['current', 'sold', 'scrapped', 'unknown'].includes(val)) return { ok: false, status: 400, error: 'ownershipState must be current, sold, scrapped or unknown' };
    if (k === 'vin' && val) { val = val.toUpperCase().replace(/\s+/g, ''); if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(val)) return { ok: false, status: 400, error: 'a VIN is 17 letters and digits (no I, O or Q)' }; }
    if ((k === 'firstRegistered' || k === 'ownershipStart') && val && !(/^\d{4}-\d{2}$/.test(val) || _validDay(val))) return { ok: false, status: 400, error: `${k} must be YYYY-MM or YYYY-MM-DD` };
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
  if (/^(gps|route|routes|location|movement|trip|carplay)$/i.test(String(source))) return { ok: false, status: 400, error: 'distance travelled is not an odometer reading — record what the dashboard or a document says' };
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

/**
 * Nick records a service, repair, tyre fit… Never created from a payment, and
 * never holds an amount: what it cost is Tally's, linked by `costRef`
 * (tally:<transaction id>) when Nick knows it.
 */
function addEvent(vehicleId, body = {}, { now = Date.now(), actor = 'nick' } = {}) {
  if (!getVehicle(vehicleId)) return { ok: false, status: 404, error: 'no such vehicle' };
  if (!EVENT_TYPES.includes(body.type)) return { ok: false, status: 400, error: `type must be one of ${EVENT_TYPES.join(', ')}` };
  if (!_validDay(body.date)) return { ok: false, status: 400, error: 'date must be YYYY-MM-DD' };
  if (body.date > localDay(now)) return { ok: false, status: 400, error: 'history is what happened — a date in the future is an obligation' };
  const description = _txt(body.description, 400);
  if (!description) return { ok: false, status: 400, error: 'a description is required' };
  const mileage = body.mileage == null || body.mileage === '' ? null : Number(body.mileage);
  if (mileage !== null && !(Number.isFinite(mileage) && mileage >= 0)) return { ok: false, status: 400, error: 'mileage must be a number' };
  if (body.costPence != null && body.costPence !== '') return { ok: false, status: 400, error: 'what it cost is recorded in Tally — link the transaction instead (costRef tally:<id>)' };
  const costRef = body.costRef == null || body.costRef === '' ? null : String(body.costRef);
  if (costRef !== null && !/^tally:\d+$/.test(costRef)) return { ok: false, status: 400, error: 'costRef must be tally:<transaction id>' };
  const detail = {};
  if (body.type === 'tyres') {
    if (body.action != null && body.action !== '' && !TYRE_ACTIONS.includes(body.action)) return { ok: false, status: 400, error: `a tyre action is one of ${TYRE_ACTIONS.join(', ')}` };
    for (const k of ['action', 'axle', 'position', 'brand', 'model', 'count']) if (body[k] != null && body[k] !== '') detail[k] = _txt(String(body[k]), 60);
  }
  if (body.outcome != null && body.outcome !== '') {
    if (!OUTCOMES.includes(body.outcome)) return { ok: false, status: 400, error: `outcome must be one of ${OUTCOMES.join(', ')}` };
    detail.outcome = body.outcome;
  }
  const id = `vev:${crypto.randomUUID()}`;
  const iso = new Date(now).toISOString();
  _db().run(`INSERT INTO vehicle_events (event_id, vehicle_id, type, event_date, mileage, description, cost_ref, detail_json, source, provenance_json, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, vehicleId, body.type, body.date, mileage, description, costRef, Object.keys(detail).length ? JSON.stringify(detail) : null, 'manual',
    JSON.stringify({ enteredBy: actor, enteredAt: iso, costFrom: costRef ? 'linked Tally transaction (the amount stays in Tally)' : null }), iso]);
  const kind = body.type === 'tyres' ? 'tyre-recorded' : REPAIR_KINDS.includes(body.type) ? 'repair-recorded' : 'maintenance-recorded';
  _log(kind, { type: body.type, date: body.date, description, action: detail.action || null, outcome: detail.outcome || null }, { subjectId: vehicleId, actor, now });
  return { ok: true, event: _db().get('SELECT * FROM vehicle_events WHERE event_id = ?', [id]) };
}

// ── fuel fills (litres and the odometer; never the amount) ────────────────────

function _fills(vehicleId) {
  return _db().all('SELECT * FROM vehicle_fuel_fills WHERE vehicle_id = ? AND withdrawn_at IS NULL ORDER BY filled_on, recorded_at', [vehicleId])
    .map((f) => ({ id: f.fill_id, filledOn: f.filled_on, litres: f.litres, odometer: f.odometer, odometerUnit: f.odometer_unit, fullTank: !!f.full_tank, note: f.note }));
}

function addFuelFill(vehicleId, body = {}, { now = Date.now(), actor = 'nick' } = {}) {
  if (!getVehicle(vehicleId)) return { ok: false, status: 404, error: 'no such vehicle' };
  if (!_validDay(body.filledOn)) return { ok: false, status: 400, error: 'filledOn must be YYYY-MM-DD' };
  if (body.filledOn > localDay(now)) return { ok: false, status: 400, error: 'a fill cannot be in the future' };
  const litres = Number(body.litres);
  if (!(Number.isFinite(litres) && litres > 0 && litres <= 200)) return { ok: false, status: 400, error: 'litres must be the litres on the pump receipt (0–200)' };
  if (body.amountPence != null || body.costPence != null) return { ok: false, status: 400, error: 'what a fill cost is Tally\'s — record the litres here' };
  const odometer = body.odometer == null || body.odometer === '' ? null : Number(body.odometer);
  if (odometer !== null && !(Number.isFinite(odometer) && odometer >= 0 && odometer <= 2000000)) return { ok: false, status: 400, error: 'odometer must be the reading at the pump' };
  const unit = body.odometerUnit === 'km' ? 'km' : 'mi';
  const id = `vfill:${crypto.randomUUID()}`;
  const iso = new Date(now).toISOString();
  _db().run(`INSERT INTO vehicle_fuel_fills (fill_id, vehicle_id, filled_on, litres, odometer, odometer_unit, full_tank, note, provenance_json, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, vehicleId, body.filledOn, litres, odometer, unit, body.fullTank ? 1 : 0, _txt(body.note, 200), JSON.stringify({ enteredBy: actor, enteredAt: iso }), iso]);
  return { ok: true, fill: _fills(vehicleId).find((f) => f.id === id), mpg: mpgFromFills(_fills(vehicleId), { today: localDay(now) }) };
}

function withdrawFuelFill(vehicleId, fillId, { now = Date.now() } = {}) {
  const r = _db().run('UPDATE vehicle_fuel_fills SET withdrawn_at = ? WHERE vehicle_id = ? AND fill_id = ? AND withdrawn_at IS NULL', [new Date(now).toISOString(), vehicleId, fillId]);
  return r && r.changes ? { ok: true } : { ok: false, status: 404, error: 'no such fill' };
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
    if (obligationConfidence(ob, check) === 'verified') _log('vehicle-obligation-verified', { type: ob.type, label: OBLIGATION_LABELS[ob.type], value: ob.due_date, source: check.source }, { subjectId: vehicleId, actor: 'neuro', now, dedupeKey: `vehicle-verified:${ob.obligation_id}:${ob.due_date}:${check.source}` });
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

function _financeSnapshot() {
  try { return JSON.parse(_db().getState(require('./finance').SNAPSHOT_KEY) || 'null'); } catch { return null; }
}

/** Everything about one vehicle, as surfaces see it. Finance is Tally's, unchanged. */
function read(vehicleId, { now = Date.now(), snapshot = undefined } = {}) {
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
  const fin = tallyVehicleFinance(snapshot === undefined ? _financeSnapshot() : snapshot, vehicleId);
  const fills = _fills(vehicleId);
  const linked = links(vehicleId);
  const linkedIds = new Set(linked.map((l) => l.entityId));
  for (const ob of obligations) for (const r of [ob.linkedTaskRef, ob.linkedReminderRef]) if (r) linkedIds.add(r);
  // A task Nick linked to the car whose words name EXACTLY ONE obligation type,
  // and that type is open with no action yet, is OFFERED as its action — never
  // linked for him (27E). A task naming several (live #383: "registration,
  // current mileage, MOT, tax and insurance") is data entry, not the booking.
  const actionSuggestions = [];
  for (const l of linked) {
    const t = taskIndex.get(l.entityId);
    if (!t || !(t.state === 'open' || t.state === 'in-progress')) continue;
    const named = OBLIGATION_TYPES.filter((ty) => TYPE_WORDS[ty].test(t.description || ''));
    if (named.length !== 1) continue;
    const ob = obligations.find((o) => o.recordStatus === 'open' && !o.linkedTaskRef && o.type === named[0]);
    if (ob) actionSuggestions.push({ obligationId: ob.id, label: ob.label, taskId: t.id, description: t.description, why: `you linked it to the ${v.model} and it names the ${ob.label} — a suggestion, not a link` });
  }
  return {
    vehicle: {
      id: v.vehicle_id, type: 'vehicle', make: v.make, model: v.model, plateDescriptor: v.plate_descriptor, registration: v.registration,
      variant: v.variant, fuelType: v.fuel_type, ownershipState: v.ownership_state, source: v.source,
      vin: v.vin || null, firstRegistered: v.first_registered || null, ownershipStart: v.ownership_start || null,
      registeredWindow: v.first_registered ? null : plateWindow(v.plate_descriptor),
      provenance: v.provenance_json ? JSON.parse(v.provenance_json) : null, createdAt: v.created_at, updatedAt: v.updated_at,
      currentMileage: current ? current.miles : null, mileageObservedAt: current ? current.observedOn : null,
      unknown: [
        ...(!v.registration ? ['registration'] : []), ...(!v.variant ? ['engine/trim'] : []), ...(!v.plate_descriptor && !v.first_registered ? ['first registration'] : []),
        ...(!v.fuel_type ? ['fuel type'] : []), ...(!v.vin ? ['VIN'] : []), ...(!v.ownership_start ? ['ownership start'] : []), ...(!current ? ['mileage'] : []),
      ],
    },
    mileage: { current, readings: judged.slice().reverse(), needsReview: judged.filter((r) => r.state === 'needs-review').length },
    obligations,
    nextObligation: obligations.filter((o) => o.recordStatus === 'open' && o.dueDate).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0] || null,
    history: events.map((e) => ({ id: e.event_id, type: e.type, date: e.event_date, mileage: e.mileage, description: e.description, costRef: e.cost_ref,
      detail: e.detail_json ? JSON.parse(e.detail_json) : null, source: e.source, provenance: e.provenance_json ? JSON.parse(e.provenance_json) : null })),
    tyres: events.filter((e) => e.type === 'tyres').map((e) => ({ id: e.event_id, date: e.event_date, mileage: e.mileage, description: e.description, ...(e.detail_json ? JSON.parse(e.detail_json) : {}) })),
    official: { latest: check, recent: lastChecks, sources: officialSources(v) },
    links: linked,
    linkSuggestions: linkSuggestions([...taskIndex.values()], linkedIds),
    actionSuggestions,
    finance: fin,
    costPerMile: costPerMile(fin, judged),
    fuel: { fills: fills.slice().reverse().slice(0, 12), count: fills.length, mpg: mpgFromFills(fills, { today }) },
    health: health({ obligations, events, today }),
    replacement: replacementEvidence({ vehicle: v, current, events, fin, today }),
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
 * The durable job body (06:37). Reads nothing outside NEURO: Tally's figures
 * arrive through finance.js's own refresh. Records — once per change, never
 * per pass — when Tally's vehicle finance becomes readable or stops being, and
 * when what is missing about the car changes.
 */
async function refresh({ now = Date.now() } = {}) {
  const out = { vehicles: 0 };
  const snap = _financeSnapshot();
  for (const v of listVehicles().filter((x) => x.ownership_state === 'current')) {
    out.vehicles++;
    const r = read(v.vehicle_id, { now, snapshot: snap });
    const name = `${v.make} ${v.model}`;
    const finKey = `vehicle_finance_state:${v.vehicle_id}`;
    const was = _db().getState(finKey);
    const is = r.finance.state;
    if (was !== is) {
      _db().setState(finKey, is);
      if (was !== null && was !== undefined) {
        if (is === 'read') _log('vehicle-finance-source-recovered', { vehicle: name, was }, { subjectId: v.vehicle_id, actor: 'neuro', now, dedupeKey: `vehicle-finance:${v.vehicle_id}:read:${now}` });
        else if (was === 'read') _log('vehicle-finance-source-lost', { vehicle: name, why: r.finance.why }, { subjectId: v.vehicle_id, actor: 'neuro', now, dedupeKey: `vehicle-finance:${v.vehicle_id}:${is}:${now}` });
      }
    }
    const gaps = [...r.health.missing, ...(r.mileage.current ? [] : ['no odometer reading'])];
    const sig = gaps.join('|');
    const key = `vehicle_gaps:${v.vehicle_id}`;
    const prev = _db().getState(key);
    if (prev !== sig) {
      _db().setState(key, sig);
      if (prev !== null && prev !== undefined) _log('vehicle-gaps-changed', { vehicle: name, gaps }, { subjectId: v.vehicle_id, actor: 'neuro', now, dedupeKey: `vehicle-gaps:${v.vehicle_id}:${sig}` });
    }
  }
  return out;
}

const TABLES = ['vehicles', 'vehicle_mileage', 'vehicle_events', 'vehicle_obligations', 'vehicle_official_checks', 'vehicle_fuel_fills'];

module.exports = {
  OBLIGATION_TYPES, OBLIGATION_LABELS, EVENT_TYPES, TYRE_ACTIONS, OUTCOMES, MILEAGE_SOURCES, OFFICIAL_SOURCES, TABLES,
  UPCOMING_DAYS, UPCOMING_MILES, MAX_MILES_PER_DAY, BOUNDARY_TOLERANCE_DAYS, ALIGNED_DAYS,
  // pure
  judgeMileage, currentMileage, milesBetween, effectiveDue, obligationState, officialConflict, obligationConfidence,
  tallyVehicleFinance, costPerMile, mpgFromFills, health, replacementEvidence, plateWindow, linkSuggestions,
  radarItems, officialSources, slugFor, localDay, addMonths,
  // official
  dvlaCheck, runOfficialCheck, recordOfficialByHand,
  // store
  listVehicles, getVehicle, createVehicle, updateVehicle, addMileage, withdrawMileage, addEvent, withdrawEvent,
  addFuelFill, withdrawFuelFill, addObligation, updateObligation, resolveObligation, links, read, radar, refresh,
};
