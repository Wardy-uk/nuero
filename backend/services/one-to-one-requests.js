'use strict';

/**
 * NOVA asks, NEURO books, Nick taps (14 Oct 2026).
 *
 * When NOVA completes (or abandons) a 1-2-1 it creates the agent's NEXT session at
 * last + cadence. That session is a DUE DATE, not a meeting: nothing put it in the
 * diary. Before this, NOVA's day-before job then emailed the agent prep questions for
 * a 1-2-1 that did not exist (Luke Scaife, Abdi Mohamed, Hope Goodall — 14 Oct).
 *
 * Now NOVA tells NEURO the moment it creates one (`POST /api/1to1/booking-request`),
 * and a sweep reads NOVA's open sessions as the backstop. For each request:
 *
 *   1. A 1-2-1 with them already in the diary → that IS the answer: confirm it to NOVA
 *      (date + event id) and prepare nothing.
 *   2. A booking already prepared and not yet sent → nothing new; it is still waiting.
 *   3. Otherwise → find the first free slot on or after the date NOVA asked for, using
 *      the SAME rules as "Book now", and PREPARE the governed invite. Nick gets one
 *      push; one tap on the People board sends it.
 *
 * ⚠ NOTHING HERE SENDS AN INVITE. Nick's call (14 Oct 2026): one tap, not automatic.
 * The tap is the decision; it runs through the existing intent-grant path, and
 * `afterGovernedCalendar` confirms the real date and event id back to NOVA — which
 * moves NOVA's session to the booked day and re-arms prep for it.
 *
 * Origin is `1to1-book`, deliberately the same as the Book button: the slot is chosen
 * by exactly the same code and the decision is the same press. A second origin would
 * be a second set of mirrors (HUMAN_ORIGINS, DIRECT_ORIGINS, afterGovernedCalendar)
 * free to drift.
 */

const db = require('../db/database');

const LEDGER_KEY = 'one_to_one_requests';
const LEDGER_LIMIT = 200;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PENDING = new Set(['prepared', 'approved', 'executing', 'execution_uncertain']);

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readLedger() {
  try { return JSON.parse(db.getState(LEDGER_KEY) || '{}') || {}; } catch { return null; }
}

function writeLedger(ledger) {
  const keys = Object.keys(ledger);
  if (keys.length > LEDGER_LIMIT) {
    keys.sort((a, b) => String(ledger[a].at).localeCompare(String(ledger[b].at)))
      .slice(0, keys.length - LEDGER_LIMIT).forEach((k) => { delete ledger[k]; });
  }
  db.setState(LEDGER_KEY, JSON.stringify(ledger));
}

/**
 * A booking for this person already prepared and waiting for Nick, or sent for a
 * date still ahead. PURE over a list of shaped prepared actions.
 */
function pendingBookingFor(actions, person, today = todayStr()) {
  return (actions || []).find((a) => a.actionType === 'create_calendar_event'
    && a.origin === '1to1-book'
    && a.target && a.target.person === person
    && (PENDING.has(a.status)
      || (a.status === 'executed' && String((a.draft && a.draft.start) || '').slice(0, 10) >= today))) || null;
}

/**
 * Handle one request. Never throws. Returns what happened, in words a log line and
 * the route can both use.
 */
async function handleRequest({ agentName, date = null, sessionId = null, notify = true } = {}) {
  const person = String(agentName || '').trim();
  if (!person) return { ok: false, error: 'agentName is required' };
  const notBefore = ISO.test(String(date || '')) ? String(date) : null;

  const booking = require('./one-to-one-booking');
  const detect = require('./one-to-one-detect');
  const sync = require('./nova-121-sync');

  const known = (detect.getIndex().people || []).find((p) => p.name === person);
  if (!known) return { ok: false, person, unknownAgent: true, error: `${person} has no People note NEURO can book against` };
  if (!known.bookable) return { ok: true, person, action: 'off-cadence' };

  // 1. Already in the diary — the booking exists, NOVA just did not know.
  const found = await booking.findOneToOne(person);
  if (found.ok && found.event && String(found.event.start || '').slice(0, 10) >= todayStr()) {
    const day = String(found.event.start).slice(0, 10);
    const pushed = await sync.pushBooking(person, day, { outlookEventId: found.addressable ? found.event.id : null });
    try { require('./obsidian').updatePersonNote(person, { booked121: day }); } catch { /* the stamp is bookkeeping */ }
    return { ok: true, person, action: 'already-in-diary', date: day, novaConfirmed: !!pushed.ok };
  }

  // 2. Already prepared and waiting for the tap.
  const pa = require('./prepared-actions');
  const waiting = pendingBookingFor(pa.listLive(), person);
  if (waiting) {
    return { ok: true, person, action: 'already-prepared', actionId: waiting.actionId, start: waiting.draft && waiting.draft.start };
  }

  // 3. Find the slot and prepare the invite.
  const proposal = await booking.propose(person, { notBefore });
  if (!proposal.ok) return { ok: false, person, action: 'no-slot', error: proposal.error };
  if (!proposal.attendee || !proposal.attendee.email) {
    return { ok: false, person, action: 'no-address', error: `No email for ${person} — add one to their People note` };
  }
  const r = await booking.book({
    person, start: proposal.start, end: proposal.end, email: proposal.attendee.email,
    subject: proposal.subject, durationMinutes: proposal.durationMinutes,
  });
  if (!r.ok) return { ok: false, person, action: 'prepare-failed', error: r.error };

  const ledger = readLedger();
  const key = `${person}|${sessionId || notBefore || 'sweep'}`;
  const seen = ledger && ledger[key] && ledger[key].actionId === r.actionId;
  if (ledger) {
    ledger[key] = { actionId: r.actionId, start: proposal.start, at: new Date().toISOString() };
    try { writeLedger(ledger); } catch (e) { console.warn('[1-2-1 request] ledger write failed:', e.message); }
  }

  // One push per prepared booking, never per sweep pass.
  if (notify && !r.already && !seen) {
    const when = `${proposal.start.slice(8, 10)}/${proposal.start.slice(5, 7)} ${proposal.start.slice(11, 16)}`;
    Promise.resolve()
      .then(() => require('./webpush').sendToAll(
        `1-2-1 to book — ${person}`,
        `NOVA has ${person} due${notBefore ? ` ${notBefore}` : ''}. First free slot: ${when}. One tap on People sends the invite.`,
        { type: '121', url: '/people', key: `121-request:${r.actionId}` },
      ))
      .catch((e) => console.warn('[1-2-1 request] push failed:', e.message));
  }

  return { ok: true, person, action: r.already ? 'already-prepared' : 'prepared', actionId: r.actionId, start: proposal.start, end: proposal.end };
}

/**
 * The backstop: every open NOVA session with no calendar event behind it is a
 * request that has not been answered. Read-only against NOVA; a NOVA that cannot
 * be read prepares nothing (never "nothing to book").
 */
async function sweep({ notify = true } = {}) {
  const nova = require('./nova-client');
  if (!nova.isConfigured()) return { ok: false, error: 'NOVA bridge not configured', results: [] };
  let state;
  try { state = await nova.get121State({ days: 60 }); } catch (e) { return { ok: false, error: e.message, results: [] }; }
  // nova-client.call returns the payload's `data` and throws on ok:false.
  const agents = state && Array.isArray(state.agents) ? state.agents : null;
  if (!agents) return { ok: false, error: 'NOVA answered without an agent list', results: [] };

  const results = [];
  for (const a of agents) {
    if (a.planStatus !== 'active' || !a.sessionId || a.outlookEventId || !a.booked) continue;
    if (a.sessionStatus === 'in_progress') continue; // the 1-2-1 is happening
    results.push(await handleRequest({ agentName: a.agentName, date: a.booked, sessionId: a.sessionId, notify }));
  }
  return { ok: true, results };
}

module.exports = { handleRequest, sweep, pendingBookingFor };
