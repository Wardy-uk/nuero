'use strict';

/**
 * Answer a Google Calendar invitation from its email (3 Nov 2026).
 *
 * Nick: "this is an actual calendar invite — but I can't accept/decline it".
 * Accept / Maybe / Decline existed for work Outlook invites only. A Google
 * invitation arrives in Gmail as "Invitation: <title> @ <when> (<calendar>)",
 * and the event is already in the calendar NEURO reads (google-calendar.js
 * syncs ward.nickj@ as a read-only extra calendar).
 *
 * ⚠ The event is found by the calendar the subject NAMES + its exact title +
 *   its day, in the synced store — never by a guess. More than one match, or
 *   none, answers "can't find it" and offers nothing.
 * ⚠ The event and Nick's own attendee entry are read LIVE from Google before
 *   anything is shown or sent; the answer is a PATCH of that one attendee's
 *   responseStatus (the rest of the list is sent back exactly as read), with
 *   sendUpdates=all so the organiser is told, and it is READ BACK.
 * ⚠ Only an invite where Nick is an attendee (self) and not the organiser can
 *   be answered. Same answer vocabulary as the Outlook InviteBar.
 *
 * CommonJS — NEURO backend convention.
 */

const gcal = require('./google-calendar');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const RESPONSES = { accept: 'accepted', tentative: 'tentative', decline: 'declined' };
// The Outlook InviteBar's vocabulary.
const TO_CARD = { accepted: 'accepted', tentative: 'tentativelyAccepted', declined: 'declined', needsAction: 'notResponded' };
const SAY = { accepted: 'Accepted — the organiser has been told.', tentative: 'Maybe — the organiser has been told.', declined: 'Declined — the organiser has been told.' };

/** PURE. "Invitation: hiking? @ Sun 15 Nov 2026 (ward.nickj@gmail.com)" → { title, date, calendar } or null. */
function parseInviteSubject(subject) {
  const m = String(subject || '').match(/^\s*(?:updated invitation|invitation)(?: with note)?:\s*(.+?)\s+@\s+(.+?)\s*\(([^()\s]+@[^()\s]+)\)\s*$/i);
  if (!m) return null;
  const d = m[2].match(/\b(\d{1,2})\s+([a-z]{3})[a-z]*\s+(\d{4})\b/i);
  const mo = d ? MONTHS[d[2].toLowerCase()] : null;
  const date = d && mo ? `${d[3]}-${String(mo).padStart(2, '0')}-${String(Number(d[1])).padStart(2, '0')}` : null;
  return { title: m[1].trim(), date, calendar: m[3].trim().toLowerCase() };
}

function _db() { return require('../db/database'); }

function _locate(emailId) {
  const row = _db().get('SELECT subject FROM personal_inbox WHERE id = ?', [emailId]);
  if (!row) return { ok: false, why: 'That email is no longer in the inbox.' };
  const p = parseInviteSubject(row.subject);
  if (!p) return { ok: true, isInvite: false };
  if (!p.date) return { ok: true, isInvite: true, note: 'This invitation doesn’t name a day NEURO can read.' };
  gcal._ensureTable();
  const hits = _db().all(
    'SELECT DISTINCT google_id FROM google_calendar_events WHERE lower(calendar_id) = ? AND subject = ? AND substr(start_time, 1, 10) = ?',
    [p.calendar, p.title, p.date],
  );
  if (hits.length !== 1) {
    return { ok: true, isInvite: true, note: hits.length ? 'More than one event matches this invitation — answer it in Google Calendar.' : 'NEURO hasn’t seen this event in the calendar yet — answer it in Google Calendar, or try after the next sync.' };
  }
  return { ok: true, isInvite: true, calendar: p.calendar, googleId: hits[0].google_id };
}

/** A Google dateTime (any offset) as a London wall-clock string; an all-day date as is. */
function _london(v) {
  if (!v || !/T/.test(v)) return v || null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return v;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

function _card(ev) {
  const self = (ev.attendees || []).find((a) => a.self);
  const start = _london(ev.start && (ev.start.dateTime || ev.start.date));
  const end = _london(ev.end && (ev.end.dateTime || ev.end.date));
  return {
    subject: ev.summary || '',
    start, end,
    isCancelled: ev.status === 'cancelled',
    isOrganizer: !!(ev.organizer && ev.organizer.self),
    response: self ? (TO_CARD[self.responseStatus] || self.responseStatus) : 'none',
    organizer: ev.organizer ? (ev.organizer.displayName || ev.organizer.email || null) : null,
  };
}

/**
 * Can NEURO's Google sign-in change events in this calendar? (3 Nov 2026: the
 * sign-in is the family account, a READER of ward.nickj@ — `self` on an
 * attendee marks whose calendar the copy is in, not who is signed in, so it
 * proved nothing and every answer came back 403.) Read from the events list's
 * own accessRole; unknown is treated as "can't".
 */
async function _canWrite(calendar) {
  const r = await gcal._api('GET', `/calendars/${encodeURIComponent(calendar)}/events`, { query: { maxResults: '1' }, account: gcal.accountFor(calendar) });
  const role = r.status === 200 && r.json ? r.json.accessRole : null;
  return { ok: role === 'writer' || role === 'owner', role };
}

const READ_ONLY_NOTE = (cal) => `NEURO can only read ${cal}’s calendar, so it can’t answer this — answer it in Google Calendar, or sign in for its calendar in Settings → Personal email → ${cal} → Calendar.`;

/** The meeting behind an invitation email, read live. */
async function read(emailId) {
  const loc = _locate(emailId);
  if (!loc.ok) return { ok: false, error: loc.why };
  if (!loc.isInvite) return { ok: true, isInvite: false };
  if (!loc.googleId) return { ok: true, isInvite: true, event: null, note: loc.note };
  if (!gcal.status().connected) return { ok: true, isInvite: true, event: null, note: 'Google Calendar isn’t connected — answer it in Google Calendar.' };
  const r = await gcal._api('GET', `/calendars/${encodeURIComponent(loc.calendar)}/events/${encodeURIComponent(loc.googleId)}`, { query: { timeZone: 'Europe/London' }, account: gcal.accountFor(loc.calendar) });
  if (r.status !== 200 || !r.json) return { ok: false, error: `Google didn’t give the event back (${r.status}).` };
  const card = _card(r.json);
  const self = (r.json.attendees || []).find((a) => a.self);
  const write = self && !card.isOrganizer && !card.isCancelled ? await _canWrite(loc.calendar) : { ok: true };
  return {
    ok: true, isInvite: true, event: card,
    canAnswer: !!self && !card.isOrganizer && !card.isCancelled && write.ok,
    note: !self ? 'You aren’t listed as a guest on this event, so there’s nothing to answer.'
      : !write.ok ? READ_ONLY_NOTE(loc.calendar) : null,
  };
}

/** Answer it: accept | tentative | decline. Read back before saying so. */
async function respond(emailId, response) {
  const status = RESPONSES[response];
  if (!status) return { ok: false, status: 400, error: 'response must be accept, tentative or decline' };
  const loc = _locate(emailId);
  if (!loc.ok) return { ok: false, status: 404, error: loc.why };
  if (!loc.googleId) return { ok: false, status: 409, error: loc.note || 'This isn’t an invitation NEURO can answer.' };
  const path = `/calendars/${encodeURIComponent(loc.calendar)}/events/${encodeURIComponent(loc.googleId)}`;
  if (!(await _canWrite(loc.calendar)).ok) return { ok: false, status: 409, error: READ_ONLY_NOTE(loc.calendar) };
  const account = gcal.accountFor(loc.calendar);
  const cur = await gcal._api('GET', path, { account });
  if (cur.status !== 200 || !cur.json) return { ok: false, status: 502, error: `Google didn’t give the event back (${cur.status}).` };
  const attendees = cur.json.attendees || [];
  const self = attendees.find((a) => a.self);
  if (!self) return { ok: false, status: 409, error: 'You aren’t a guest on this event.' };
  if (cur.json.organizer && cur.json.organizer.self) return { ok: false, status: 409, error: 'It’s your own event — there’s nothing to answer.' };
  // ⚠ A guest may change only their OWN answer. Sending back the whole guest
  // list (organiser included) with sendUpdates=all is an organiser's edit and
  // Google answers 403 Forbidden (3 Nov 2026, Lizzy's "hiking?"). So send just
  // Nick's entry, marked attendeesOmitted; Google records the answer and the
  // organiser sees it on the event.
  const r = await gcal._api('PATCH', path, { query: { sendUpdates: 'all' }, body: { attendeesOmitted: true, attendees: [{ email: self.email, responseStatus: status }] }, account });
  if (r.status !== 200) return { ok: false, status: 502, error: `Google refused it (${(r.json && r.json.error && r.json.error.message) || r.status}).` };
  const back = await gcal._api('GET', path, { query: { timeZone: 'Europe/London' }, account });
  const now = back.json && (back.json.attendees || []).find((a) => a.self);
  if (!now || now.responseStatus !== status) return { ok: false, status: 502, error: 'Google took it but the event doesn’t show your answer yet — check Google Calendar.' };
  return { ok: true, response: TO_CARD[status], say: SAY[status], event: _card(back.json) };
}

module.exports = { parseInviteSubject, read, respond, _london };
