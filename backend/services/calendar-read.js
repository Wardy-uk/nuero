'use strict';

/**
 * READ-ONLY Microsoft calendar lookups (Build 11K). The calendar twin of
 * mail-read.js: preparing a move or a cancellation must read the event it is
 * about — its time, its attendees, whether Nick organises it — without the
 * module that can change it. This file makes GET requests ONLY, pinned by a
 * source scan in build11-personal-world.test.js.
 *
 * "Could not look" is never "gone": a 404 is `exists:false`; anything else
 * that is not a 200 is `ok:false`.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TIMEOUT_MS = 20000;
const TIMEZONE = process.env.NEURO_TIMEZONE || 'Europe/London';
// A named MAPI property in the PS_PUBLIC_STRINGS set: readable and filterable
// through Graph's singleValueExtendedProperties, invisible to the attendees.
const MARKER_PROP = 'String {00020329-0000-0000-C000-000000000046} Name neuroActionKey';

async function _req(method, urlPath) {
  if (method !== 'GET') throw new Error('calendar-read only reads');
  let token = null;
  try { token = await require('./microsoft').getAccessToken(); } catch { token = null; }
  if (!token) return { status: null, error: 'no-token', category: 'auth' };
  try {
    const res = await fetch(`${GRAPH}${urlPath}`, {
      method: 'GET',
      // Times back as wall clock in NEURO's zone — compared as strings, never
      // re-parsed (the BST bug).
      headers: { Authorization: `Bearer ${token}`, Prefer: `outlook.timezone="${TIMEZONE}"` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* empty / non-JSON */ }
    return { status: res.status, data, category: res.status === 401 ? 'auth' : res.status === 403 ? 'scope' : res.status >= 500 ? 'http_5xx' : null };
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { status: null, error: timedOut ? 'timeout' : 'network', category: timedOut ? 'timeout' : 'network' };
  }
}

const minute = (s) => String(s || '').replace(' ', 'T').slice(0, 16);
const lc = (s) => String(s || '').trim().toLowerCase();

/** Graph event → the comparable shape the executor judges. PURE. */
function normaliseEvent(e) {
  if (!e) return null;
  const marker = (e.singleValueExtendedProperties || []).find((p) => lc(p.id) === lc(MARKER_PROP));
  return {
    id: e.id || null,
    subject: e.subject || '',
    start: minute(e.start && e.start.dateTime),
    end: minute(e.end && e.end.dateTime),
    timeZone: (e.start && e.start.timeZone) || null,
    attendees: (e.attendees || []).map((a) => lc(a && a.emailAddress && a.emailAddress.address)).filter(Boolean).sort(),
    location: (e.location && e.location.displayName) || null,
    isOnline: e.isOnlineMeeting === true,
    isCancelled: e.isCancelled === true,
    isOrganizer: typeof e.isOrganizer === 'boolean' ? e.isOrganizer : null,
    organizer: lc(e.organizer && e.organizer.emailAddress && e.organizer.emailAddress.address) || null,
    recurrence: e.recurrence ? (e.recurrence.pattern && e.recurrence.pattern.type) || 'recurring' : null,
    marker: marker ? marker.value : null,
  };
}

const SELECT = 'id,subject,start,end,attendees,location,isOnlineMeeting,isCancelled,isOrganizer,organizer,recurrence';
const EXPAND = `singleValueExtendedProperties($filter=id eq '${MARKER_PROP}')`;

/** Find the event(s) carrying NEURO's marker. { ok, events } or { ok:false, category }. */
async function findByMarker(marker) {
  const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${MARKER_PROP}' and ep/value eq '${String(marker).replace(/'/g, "''")}')`;
  const r = await _req('GET', `/me/events?$filter=${encodeURIComponent(filter)}&$select=${SELECT}&$expand=${encodeURIComponent(EXPAND)}`);
  if (r.status === 200 && r.data && Array.isArray(r.data.value)) return { ok: true, events: r.data.value.map(normaliseEvent) };
  return { ok: false, status: r.status, category: r.category || 'unavailable' };
}

/** Read one event. { ok, exists, event } — a 404 is a definite answer (exists:false). */
async function readEvent(eventId) {
  const r = await _req('GET', `/me/events/${encodeURIComponent(eventId)}?$select=${SELECT}&$expand=${encodeURIComponent(EXPAND)}`);
  if (r.status === 200 && r.data) return { ok: true, exists: true, event: normaliseEvent(r.data) };
  if (r.status === 404) return { ok: true, exists: false, event: null };
  return { ok: false, status: r.status, category: r.category || 'unavailable' };
}

/** Events starting exactly at `start` (a minute window) — the "already booked?" check. */
async function eventsAt(start) {
  // ⚠ calendarView reads a bound with no offset as UTC, while `start` is
  // Europe/London wall clock. Rather than convert by hand (the BST bug), the
  // window is widened two hours each way and the answer — which comes back in
  // wall clock, via the Prefer header — is filtered on the exact minute.
  const shift = (min) => {
    const t = Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10), +start.slice(11, 13), +start.slice(14, 16)) + min * 60000;
    return new Date(t).toISOString().slice(0, 19);
  };
  const from = shift(-120);
  const to = shift(120);
  const r = await _req('GET', `/me/calendarView?startDateTime=${encodeURIComponent(from)}&endDateTime=${encodeURIComponent(to)}&$select=${SELECT}&$top=50`);
  if (r.status === 200 && r.data && Array.isArray(r.data.value)) return { ok: true, events: r.data.value.map(normaliseEvent).filter((e) => e.start === start) };
  return { ok: false, status: r.status, category: r.category || 'unavailable' };
}

module.exports = { TIMEZONE, MARKER_PROP, normaliseEvent, findByMarker, readEvent, eventsAt };
