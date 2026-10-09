'use strict';

/**
 * Build 27 — Life → Transport: what the car is, what it needs, what it costs,
 * and whether Nick needs to do anything. One bounded read, composed from:
 *
 *   vehicle.read()   identity, obligations, mileage, history, tyres, fuel/MPG,
 *                    health and replacement evidence (NEURO's facts)
 *   vehicle.read().finance   Tally's `vehicleFinance`, unchanged
 *   the phone        driving / parked / unknown RIGHT NOW — from the Companion
 *                    app's motion classification and CarPlay audio route.
 *
 * ⚠ PRIVACY (27R–T): NOTHING here stores a drive, a route, a fix, a place or a
 * trip. The driving state is computed on read and thrown away; "recently
 * drove" is never claimed because NEURO deliberately keeps no history to say
 * it from. Needs You is not decided here — it is the obligation states the
 * Radar and Personal Admin already act on, listed so this view says the same.
 */

const veh = () => require('./vehicle');

/**
 * Driving state from the phone, now. PURE.
 *   phone { activity, audioOutput } from ha.getPhoneStatus() — or null.
 */
function drivingState(phone) {
  const never = 'NEURO keeps no record of drives, routes or where the car is, so it never says you drove recently';
  if (!phone) return { state: 'unknown', confidence: 'unknown', why: 'the phone\'s status could not be read', evidence: [], note: never };
  const activity = String(phone.activity || '').toLowerCase();
  const audio = String(phone.audioOutput || '').toLowerCase();
  const evidence = [];
  if (activity === 'automotive') evidence.push('the phone says it is in a vehicle');
  if (audio.includes('carplay')) evidence.push('the phone is on CarPlay');
  if (evidence.length) return { state: 'driving', confidence: evidence.length === 2 ? 'sure' : 'likely', why: evidence.join(' and '), evidence, note: never };
  if (activity && activity !== 'unknown' && activity !== 'unavailable') {
    return { state: 'parked', confidence: 'likely', why: `the phone reports "${phone.activity}" and no CarPlay — not in a vehicle now`, evidence: [`motion: ${phone.activity}`], note: never };
  }
  return { state: 'unknown', confidence: 'unknown', why: 'the phone reports no motion classification', evidence: [], note: never };
}

const ageDays = (iso, now) => (iso ? Math.max(0, Math.floor((now - Date.parse(iso.length === 10 ? `${iso}T12:00:00Z` : iso)) / 86400000)) : null);

/** Each source on its own line — never collapsed into one "healthy" (27AA). PURE. */
function sources(r, { now, phoneRead, dvlaKey }) {
  const v = r.vehicle;
  const known = ['registration', 'variant', 'fuelType', 'plateDescriptor', 'vin', 'firstRegistered', 'ownershipStart'].filter((k) => v[k]).length;
  const lastOk = r.official.latest;
  const fin = r.finance;
  const mAge = r.mileage.current ? ageDays(r.mileage.current.observedOn, now) : null;
  const linked = r.links.length;
  const actions = r.obligations.filter((o) => o.recordStatus === 'open' && (o.linkedTaskRef || o.linkedReminderRef)).length;
  return [
    { id: 'vehicle-facts', label: 'Vehicle facts', state: v.unknown.length ? 'incomplete' : 'complete',
      why: `${known} of 7 identity fields recorded by you${v.unknown.length ? `; not known: ${v.unknown.join(', ')}` : ''}` },
    { id: 'official', label: 'Official checks (DVLA / DVSA)', state: lastOk ? 'checked' : dvlaKey && v.registration ? 'available' : 'unavailable',
      why: lastOk ? `last official reading ${lastOk.checked_at.slice(0, 10)} (${lastOk.source})` : r.official.sources.filter((s) => !s.available).map((s) => `${s.name}: ${s.why}`).join('; ') },
    { id: 'tally-vehicle-finance', label: 'Vehicle finance (Tally)', state: fin.state === 'read' ? (fin.freshness && fin.freshness.state) || 'read' : fin.state,
      why: fin.state === 'read'
        ? `${fin.classified.transactions} car transactions classified in Tally; read ${fin.fetchedAt ? fin.fetchedAt.slice(0, 16).replace('T', ' ') : 'unknown'}; bank feeds ${fin.freshness ? String(fin.freshness.state).replace(/_/g, ' ') : 'unknown'}${fin.review && fin.review.pending ? `; ${fin.review.pending} waiting for review in Tally` : ''}`
        : fin.why },
    { id: 'mileage', label: 'Mileage', state: !r.mileage.current ? 'none' : mAge > 60 ? 'old' : 'recorded',
      why: r.mileage.current ? `${r.mileage.current.miles.toLocaleString('en-GB')} mi on ${r.mileage.current.observedOn} (${mAge} day${mAge === 1 ? '' : 's'} ago, ${r.mileage.current.source})` : 'no odometer reading recorded — nothing per mile can be worked out' },
    { id: 'driving-context', label: 'iPhone driving context', state: phoneRead ? 'read' : 'unavailable',
      why: phoneRead ? 'motion and CarPlay read from the phone on demand; nothing stored' : 'the phone\'s status could not be read' },
    { id: 'tasks', label: 'Linked tasks and reminders', state: linked || actions ? 'linked' : 'none',
      why: `${linked} task${linked === 1 ? '' : 's'} linked to the ${v.model}; ${actions} date${actions === 1 ? '' : 's'} with a linked action` },
    { id: 'history', label: 'Maintenance history', state: r.history.length ? 'recorded' : 'none',
      why: r.history.length ? `${r.history.length} entr${r.history.length === 1 ? 'y' : 'ies'}, latest ${r.history[0].date}` : 'no service, repair or tyre history recorded' },
  ];
}

/** Needs You for transport = the existing obligation rule's answer, listed. PURE. */
function needsYou(r) {
  const out = [];
  for (const o of r.obligations) if (o.recordStatus === 'open' && (o.status === 'needs_you' || o.status === 'overdue')) out.push({ kind: 'obligation', id: o.id, line: `${o.label}: ${o.statusWhy}` });
  for (const a of r.health.attention) if (a.kind === 'repair-unresolved') out.push({ kind: 'repair', id: a.ref, line: a.line });
  return out;
}

/** The view. `phone` is injectable; production asks Home Assistant / the phone. */
async function read({ now = Date.now(), phone = undefined } = {}) {
  let p = phone;
  let phoneRead = phone !== undefined && phone !== null;
  if (phone === undefined) {
    try { p = await require('./ha').getPhoneStatus(); phoneRead = !!p; } catch { p = null; phoneRead = false; }
  }
  const driving = drivingState(p);
  const vehicles = veh().listVehicles().filter((x) => x.ownership_state === 'current').map((x) => veh().read(x.vehicle_id, { now })).filter(Boolean);
  return {
    ok: true,
    tallyUrl: String(process.env.TALLY_PUBLIC_URL || 'https://tally.nickward.co.uk').replace(/\/+$/, ''),
    driving,
    vehicles: vehicles.map((r) => ({ ...r, sources: sources(r, { now, phoneRead, dvlaKey: !!process.env.DVLA_VES_API_KEY }), needsYou: needsYou(r) })),
    rule: 'Transport shows what the car is, what it needs, and Tally\'s figures for what it costs. Needs You comes only from a real deadline or an unresolved repair you recorded — never from spend, mileage, age or a drive.',
  };
}

module.exports = { drivingState, sources, needsYou, read };
