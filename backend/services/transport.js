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

// How old the phone's last reading may be. iOS reports motion on CHANGE, so an
// "Automotive" reading can be the last thing it said before the car stopped.
const DRIVING_FRESH_MIN = 15;    // a vehicle reading this fresh = driving now
const RECENT_MAX_MIN = 120;      // older than fresh, up to 2h = "recently drove" (the phone's own last word)
const PARKED_FRESH_MIN = 120;    // a non-vehicle reading older than this says nothing about now

/**
 * Driving state from the phone. PURE.
 *   phone { activity, audioOutput, activityUpdatedAt, lastReportAt } from
 *   ha.getPhoneStatus() — or null. "Recently drove" is ONLY the phone's own last
 *   reading and its time; NEURO keeps no history to say it from otherwise.
 */
function drivingState(phone, now = Date.now()) {
  const note = 'NEURO keeps no record of drives, routes or where the car is; "recently" is only ever the phone\'s own last reading and its time';
  if (!phone) return { state: 'unknown', confidence: 'unknown', why: 'the phone\'s status could not be read', evidence: [], note, readingAt: null };
  const activity = String(phone.activity || '').toLowerCase();
  const audio = String(phone.audioOutput || '').toLowerCase();
  const times = [phone.activityUpdatedAt, phone.lastReportAt].map((t) => Date.parse(t || '')).filter(Number.isFinite);
  const at = times.length ? Math.max(...times) : null;
  const ageMin = at == null ? null : Math.max(0, Math.round((now - at) / 60000));
  const hhmm = at == null ? null : new Intl.DateTimeFormat('en-GB', { timeZone: process.env.NEURO_TIMEZONE || 'Europe/London', hour: '2-digit', minute: '2-digit' }).format(new Date(at));
  const readingAt = at == null ? null : new Date(at).toISOString();
  const evidence = [];
  if (activity === 'automotive') evidence.push('the phone says it is in a vehicle');
  if (audio.includes('carplay')) evidence.push('the phone is on CarPlay');
  if (evidence.length) {
    const why = `${evidence.join(' and ')}${hhmm ? ` (last reading ${hhmm}, ${ageMin} min ago)` : ' (the reading\'s time is not known)'}`;
    if (ageMin == null || ageMin <= DRIVING_FRESH_MIN) return { state: 'driving', confidence: evidence.length === 2 ? 'sure' : 'likely', why, evidence, note, readingAt };
    if (ageMin <= RECENT_MAX_MIN) return { state: 'recently_drove', confidence: 'likely', why: `${why}; it has not reported since, so it may have stopped`, evidence, note, readingAt };
    return { state: 'unknown', confidence: 'unknown', why: `the phone's last vehicle reading is ${ageMin} min old — too old to say anything about now`, evidence: [], note, readingAt };
  }
  if (activity && activity !== 'unknown' && activity !== 'unavailable') {
    if (ageMin != null && ageMin > PARKED_FRESH_MIN) return { state: 'unknown', confidence: 'unknown', why: `the phone's last motion reading is ${ageMin} min old`, evidence: [], note, readingAt };
    return { state: 'parked', confidence: 'likely', why: `the phone reports "${phone.activity}" and no CarPlay — not in a vehicle now`, evidence: [`motion: ${phone.activity}`], note, readingAt };
  }
  return { state: 'unknown', confidence: 'unknown', why: 'the phone reports no motion classification', evidence: [], note, readingAt };
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
  const driving = drivingState(p, now);
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
