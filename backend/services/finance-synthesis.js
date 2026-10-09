'use strict';

/**
 * Build 26 — finance × the rest of Nick's world. PURE.
 *
 * NEURO adds MEANING to Tally's finance facts; it never calculates them. Every
 * item here cites exactly two facts and both are named in `facts`:
 *   • one from Tally's finance-intelligence-v1 contract (quoted, never recomputed), and
 *   • one from NEURO's non-finance world model (a vehicle obligation, for now).
 * A finance fact alone, or a world fact alone, produces nothing — the
 * relationship must be between two real facts, never invented from one.
 *
 * Rules (each says why it can be said):
 *   pinch-overlaps        Tally reads the next 30 days as tighter than usual or
 *                         stretched, AND a car obligation (MOT, service, tax,
 *                         insurance…) falls inside those 30 days.
 *   near-lowest-point     a car obligation falls within 3 days of the lowest
 *                         balance Tally projects in the next 30 days.
 *   car-costs-moving      Tally reports a material change in a motoring category
 *                         between two complete months AND NEURO holds a vehicle.
 * Nothing here is Needs You by itself: it is context beside the obligation,
 * which keeps its own action state.
 */

const MOTORING = /\b(fuel|transport|motoring|car|vehicle|parking)\b/i;
const day = (d) => Date.parse(`${d}T00:00:00Z`);
const daysBetween = (a, b) => Math.round((day(b) - day(a)) / 86400000);

/**
 * vehicles: [{ id, name, obligations: [{ id, type, label, dueDate, recordStatus }] }]
 */
function synthesise(contract, { today, vehicles = [] } = {}) {
  if (!contract || contract.contract !== 'finance-intelligence-v1') return [];
  const out = [];
  const pressure = contract.pressure || {};
  const d30 = ((contract.cashflow && contract.cashflow.horizons) || []).find((h) => h.days === 30) || null;
  const cfConfidence = contract.cashflow ? contract.cashflow.confidence : 'unavailable';
  const end = d30 ? d30.through : null;
  const carObligations = [];
  for (const v of vehicles) {
    for (const o of v.obligations || []) {
      if (o.recordStatus && o.recordStatus !== 'open') continue;
      if (!o.dueDate) continue;
      carObligations.push({ ...o, vehicleName: v.name, vehicleId: v.id });
    }
  }

  // pinch-overlaps
  if (['tighter_than_usual', 'stretched'].includes(pressure.state) && end) {
    for (const o of carObligations.filter((x) => x.dueDate >= today && x.dueDate <= end)) {
      out.push({
        id: `fs:pinch:${o.id}`, kind: 'pinch-overlaps', date: o.dueDate, vehicleRef: o.vehicleId, obligationRef: o.id,
        line: `Tally reads the next 30 days as ${pressure.state.replace(/_/g, ' ')}, and the ${o.vehicleName}'s ${o.label} is due ${o.dueDate}.`,
        facts: [
          { system: 'tally', section: 'pressure', statement: `pressure: ${pressure.state.replace(/_/g, ' ')}`, basis: (pressure.why || []).slice(0, 2) },
          { system: 'neuro', domain: 'vehicle', ref: o.id, statement: `${o.vehicleName} ${o.label} due ${o.dueDate}` },
        ],
      });
    }
  }

  // near-lowest-point
  if (d30 && cfConfidence !== 'unavailable' && d30.lowestPoint && d30.lowestPoint.date) {
    const low = d30.lowestPoint;
    for (const o of carObligations.filter((x) => x.dueDate >= today && x.dueDate <= end && Math.abs(daysBetween(x.dueDate, low.date)) <= 3)) {
      out.push({
        id: `fs:low:${o.id}`, kind: 'near-lowest-point', date: o.dueDate, vehicleRef: o.vehicleId, obligationRef: o.id,
        line: `The ${o.vehicleName}'s ${o.label} (${o.dueDate}) falls near the lowest balance Tally projects in the next 30 days (${low.date}, before day-to-day spending).`,
        facts: [
          { system: 'tally', section: 'cashflow', statement: `lowest projected balance on ${low.date} (${cfConfidence} confidence)` },
          { system: 'neuro', domain: 'vehicle', ref: o.id, statement: `${o.vehicleName} ${o.label} due ${o.dueDate}` },
        ],
      });
    }
  }

  // car-costs-moving
  const cats = contract.categories || {};
  if (cats.available && vehicles.length) {
    for (const t of (cats.trends || []).filter((x) => MOTORING.test(x.category) && /^materially_/.test(x.state))) {
      const v = vehicles[0];
      out.push({
        id: `fs:carcost:${t.category}:${contract.categories.meta && contract.categories.meta.period}`, kind: 'car-costs-moving', date: null, vehicleRef: v.id, obligationRef: null,
        line: `${t.line} (Tally, ${contract.categories.meta ? contract.categories.meta.period : 'latest complete months'}) — NEURO holds the ${v.name}.`,
        facts: [
          { system: 'tally', section: 'categories', statement: t.line },
          { system: 'neuro', domain: 'vehicle', ref: v.id, statement: `vehicle held: ${v.name}` },
        ],
      });
    }
  }
  return out;
}

module.exports = { synthesise, MOTORING };
