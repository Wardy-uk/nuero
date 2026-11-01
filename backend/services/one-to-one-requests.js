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
 *
 * -- Auto-booking (1 Nov 2026) ---------------------------------------------------
 * Nick approved 32 of 32 of these in 60 days, so behind the Settings switch
 * `one_to_one_auto_book` (default ON) step 3 BOOKS instead of preparing -- but only
 * when everything is certain (`autoBlockedBy`): a slot under every findSlot rule,
 * leave KNOWN for both Nick and the person for that date, one resolved address, the
 * calendar switch on, and no automatic booking for this person undone recently.
 * Anything else falls back to the tap card above, unchanged.
 *
 * It is NOT a second write path: the action is prepared by book() with origin
 * `1to1-auto` (the one deliberate second origin -- provenance must say Nick did not
 * press anything), approved by the switch (prepared-actions.approve standingSwitch,
 * authority_proof `standing_switch`, initiated_by `neuro_autonomous`), then run by the
 * SAME executor: preflight, one claim, ledger, read-back, never-resend-uncertain, and
 * afterGovernedCalendar (1-2-1-booked stamp + NOVA's date and event id). One push says
 * what was booked; Undo is the existing governed cancel on People (Nick's press).
 */

const db = require('../db/database');

const LEDGER_KEY = 'one_to_one_requests';
const LEDGER_LIMIT = 200;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PENDING = new Set(['prepared', 'approved', 'executing', 'execution_uncertain']);
const BOOK_ORIGINS = new Set(['1to1-book', '1to1-auto']);
const AUTO_FLAG = 'one_to_one_auto_book';
const AUTO_ORIGIN = '1to1-auto';
const UNDONE_KEY = 'one_to_one_auto_undone';
const UNDONE_DAYS = 45;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
    && BOOK_ORIGINS.has(a.origin)
    && a.target && a.target.person === person
    && (PENDING.has(a.status)
      || (['executed', 'verified'].includes(a.status) && String((a.draft && a.draft.start) || '').slice(0, 10) >= today))) || null;
}

/** PURE. "Tue 3 Nov 14:00" from a wall-clock string -- sliced, never a parsed instant. */
function whenWords(start) {
  const s = String(start || '');
  const y = +s.slice(0, 4); const m = +s.slice(5, 7); const d = +s.slice(8, 10);
  if (!y || !m || !d) return s;
  const dow = new Date(y, m - 1, d).getDay();
  return `${DAY_NAMES[dow]} ${d} ${MONTHS[m - 1]} ${s.slice(11, 16)}`;
}

/** Automatic bookings Nick undid, by person (each kept UNDONE_DAYS). null = unreadable. */
function readUndone() {
  try { const v = JSON.parse(db.getState(UNDONE_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return null; }
}

/**
 * The automatic booking for this person Nick undid recently: the record
 * ({ at, eventId, actionId, start }), false when none, null when unreadable.
 */
function undoneFor(person, nowMs = Date.now()) {
  const all = readUndone();
  if (!all) return null;
  const u = all[person];
  if (!u || !u.at) return false;
  return nowMs - Date.parse(u.at) < UNDONE_DAYS * 86400000 ? u : false;
}

/** PURE. YYYY-MM-DD one day after a wall-clock date. */
function dayAfter(ymd) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  const n = new Date(y, m - 1, d + 1);
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

/**
 * Called when a governed 1-2-1 cancel has HAPPENED (afterGovernedCalendar). If the
 * event it cancelled was booked automatically, that is Nick undoing the switch's
 * decision: this person is not booked automatically again for UNDONE_DAYS -- the tap
 * card comes back instead, so a sweep cannot quietly re-book what he just undid.
 * Never throws.
 */
function noteCancelled(person, eventId) {
  if (!person || !eventId) return false;
  try {
    const row = db.get(`SELECT p.action_id, p.draft_json FROM prepared_actions p JOIN action_attempts t ON t.action_id = p.action_id
                         WHERE p.origin = ? AND t.draft_id = ? LIMIT 1`, [AUTO_ORIGIN, eventId]);
    if (!row) return false;
    const all = readUndone() || {};
    let start = null;
    try { start = JSON.parse(row.draft_json || '{}').start || null; } catch { start = null; }
    all[person] = { at: new Date().toISOString(), eventId, actionId: row.action_id, start };
    db.setState(UNDONE_KEY, JSON.stringify(all));
    return true;
  } catch (e) { console.warn('[1-2-1 auto] could not record the undo:', e.message); return false; }
}

/**
 * PURE. Why this proposal may NOT be booked without Nick's press, or null when
 * everything is certain. Every unknown is a reason -- the fallback is the tap card.
 */
function autoBlockedBy(proposal, { flagOn, calendarOn, undone } = {}) {
  if (!flagOn) return 'switch-off';
  if (!calendarOn) return 'calendar-switch-off';
  if (undone !== false) return undone ? 'undone-recently' : 'undo-record-unreadable';
  if (!proposal || !proposal.ok || !proposal.start || !proposal.end) return 'no-slot';
  if (proposal.awayCheck !== 'checked') return 'leave-unknown';
  if (!proposal.attendee || !proposal.attendee.email) return 'no-address';
  return null;
}

/**
 * The automatic booking. Returns { booked } once the switch's approval was given
 * (the outcome, good or bad, is then the executor's and is reported), or
 * { fallback } when nothing was approved and the tap card should be prepared.
 */
async function autoBook({ person, proposal, notBefore, sessionId, notify, execDeps }) {
  const booking = require('./one-to-one-booking');
  const pa = require('./prepared-actions');
  const r = await booking.book({
    person, start: proposal.start, end: proposal.end, email: proposal.attendee.email,
    subject: proposal.subject, durationMinutes: proposal.durationMinutes, origin: AUTO_ORIGIN,
  });
  if (!r.ok) return { fallback: `auto-prepare-failed: ${r.error}` };
  const action = pa.get(r.actionId);
  // The same slot already prepared by hand (or by an earlier tap-card pass) is
  // Nick's card to tap -- the switch never approves another origin's action.
  if (!action || action.origin !== AUTO_ORIGIN) return { fallback: 'slot-already-prepared-for-a-tap' };
  if (action.status === 'prepared') {
    const ok = pa.approve(action.actionId, {
      payloadHash: action.payloadHash, standingSwitch: AUTO_FLAG,
      approver: 'the one_to_one_auto_book switch (Settings -> Switches)',
    });
    if (!ok.ok) {
      pa.reject(action.actionId, { note: `not approved by the switch: ${ok.error}`, actor: 'NEURO (auto-book fell back to the tap card)' });
      return { fallback: `switch-approval-refused: ${ok.error}` };
    }
  }
  const x = await require('./action-executor').execute(action.actionId, execDeps ? { deps: execDeps } : {});
  const after = pa.get(action.actionId);
  const status = after ? after.status : (x && x.status);
  const booked = ['executed', 'verified'].includes(status);
  const uncertain = status === 'execution_uncertain';
  // Still approved = a check could not be made (calendar unreadable, switch off a
  // moment ago): the executor's reconciler retries it, so it is NOT a failure.
  const waiting = status === 'approved';

  const ledger = readLedger();
  const key = `${person}|${sessionId || notBefore || 'sweep'}`;
  const seen = ledger && ledger[key] && ledger[key].actionId === action.actionId;
  if (ledger) {
    ledger[key] = { actionId: action.actionId, start: proposal.start, at: new Date().toISOString(), auto: true, status };
    try { writeLedger(ledger); } catch (e) { console.warn('[1-2-1 auto] ledger write failed:', e.message); }
  }
  const when = whenWords(proposal.start);
  const why = (after && after.outcomeDetail) || (x && x.detail) || 'it was not sent';
  if (notify && !seen) {
    const title = booked ? `Booked your 1-2-1 with ${person} — ${when}`
      : uncertain ? `1-2-1 with ${person} — checking it booked`
        : waiting ? `Booking your 1-2-1 with ${person} — ${when}`
          : `Could not book your 1-2-1 with ${person}`;
    const body = booked ? `NOVA had it due${notBefore ? ` ${notBefore}` : ''}. The invite went as you and was read back from Outlook. Wrong time? Undo it on People.`
      : uncertain ? `Outlook gave no definite answer for ${when}. NEURO is reading the calendar and will not send it twice.`
        : waiting ? `Not sent yet — ${why}`
          : `${why}. Book it on People.`;
    Promise.resolve()
      .then(() => require('./webpush').sendToAll(title, body, {
        type: '121', url: '/?view=people', key: `121-auto:${action.actionId}`,
        undo: booked ? { actionId: action.actionId, person } : null,
      }))
      .catch((e) => console.warn('[1-2-1 auto] push failed:', e.message));
  }
  return { booked: {
    ok: booked || uncertain || waiting, person,
    action: booked ? 'auto-booked' : uncertain ? 'auto-uncertain' : waiting ? 'auto-approved-waiting' : 'auto-failed',
    actionId: action.actionId, status, start: proposal.start, end: proposal.end,
    error: booked || uncertain || waiting ? undefined : why,
  } };
}

/**
 * Handle one request. Never throws. Returns what happened, in words a log line and
 * the route can both use.
 */
async function handleRequest({ agentName, date = null, sessionId = null, notify = true, execDeps = null } = {}) {
  const person = String(agentName || '').trim();
  if (!person) return { ok: false, error: 'agentName is required' };
  let notBefore = ISO.test(String(date || '')) ? String(date) : null;

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

  // 3. Find the slot and prepare the invite. After Nick undid an automatic booking,
  // never offer that same day again: he undid it because it was wrong, and the
  // undone booking still owns that slot in the governed ledger (a card for it
  // would fold into the cancelled booking and never appear).
  const undone = undoneFor(person);
  if (undone && undone.start) {
    const after = dayAfter(undone.start);
    if (!notBefore || notBefore < after) notBefore = after;
  }
  const proposal = await booking.propose(person, { notBefore });
  if (!proposal.ok) return { ok: false, person, action: 'no-slot', error: proposal.error };
  if (!proposal.attendee || !proposal.attendee.email) {
    return { ok: false, person, action: 'no-address', error: `No email for ${person} — add one to their People note` };
  }

  // 3a. Book it outright when everything is certain and the switch says so.
  const flags = require('./feature-flags');
  const blocked = autoBlockedBy(proposal, {
    flagOn: flags.isEnabled(AUTO_FLAG),
    calendarOn: flags.isEnabled('governed_calendar'),
    undone,
  });
  let autoFallback = blocked;
  if (!blocked) {
    const auto = await autoBook({ person, proposal, notBefore, sessionId, notify, execDeps });
    if (auto.booked) return auto.booked;
    autoFallback = auto.fallback;
    console.warn(`[1-2-1 auto] ${person}: fell back to the tap card -- ${autoFallback}`);
  }

  // 3b. Prepare the invite for Nick's tap.
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

  return { ok: true, person, action: r.already ? 'already-prepared' : 'prepared', actionId: r.actionId, start: proposal.start, end: proposal.end, autoBlockedBy: autoFallback };
}

/**
 * Automatic bookings still ahead, for the People board's "Booked automatically ·
 * Undo" rows. `undone` once a governed cancel of that event has happened.
 * null = could not read (never an empty list).
 */
function autoBooked({ today = todayStr() } = {}) {
  try {
    const rows = db.all(`SELECT action_id, status, draft_json, target_json FROM prepared_actions
                          WHERE origin = ? AND action_type = 'create_calendar_event'
                            AND status IN ('executed', 'verified', 'execution_uncertain')
                          ORDER BY updated_at DESC LIMIT 50`, [AUTO_ORIGIN]);
    const booking = require('./one-to-one-booking');
    return rows.map((r) => {
      const draft = JSON.parse(r.draft_json || '{}');
      const target = JSON.parse(r.target_json || '{}');
      const eventId = booking.createdEventIdFor(r.action_id);
      const cancel = eventId ? db.get(`SELECT status FROM prepared_actions WHERE action_type = 'cancel_calendar_event' AND commitment_id = ?
                                         AND status IN ('executed', 'verified', 'execution_uncertain') LIMIT 1`, [`calendar-event:${eventId}`]) : null;
      return { actionId: r.action_id, status: r.status, person: target.person || null, start: draft.start || null, end: draft.end || null,
        subject: draft.subject || null, eventId, when: whenWords(draft.start), undone: !!cancel };
    }).filter((x) => String(x.start || '').slice(0, 10) >= today);
  } catch (e) {
    console.warn('[1-2-1 auto] could not list automatic bookings:', e.message);
    return null;
  }
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

module.exports = { handleRequest, sweep, pendingBookingFor, autoBlockedBy, whenWords, dayAfter, noteCancelled, undoneFor, autoBooked, AUTO_FLAG, AUTO_ORIGIN };
