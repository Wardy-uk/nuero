'use strict';

/**
 * The Microsoft calendar transport for the governed executor (Build 11K/L).
 *
 * The email transport drafts first and sends second, so a message id exists
 * before anything leaves. A calendar create has no draft step — POST /me/events
 * with attendees IS the invitation — so the handle is made BEFORE the call,
 * by NEURO, and travels on the event itself:
 *
 *   • a Graph `transactionId` — Microsoft's own guard: a repeated POST with the
 *     same id does not create a second event
 *   • a NEURO marker in a single-value extended property — what verification
 *     SEARCHES for. Found → the event exists (and is read back); a successful
 *     search that finds nothing, long enough after the call → proven not made.
 *
 * Move and cancel act on an EXISTING event id, which is the handle.
 *
 * ⚠ Classification is the safety model, exactly as for email:
 *   accepted   2xx — transport evidence only, NOT verification
 *   rejected   a definitive refusal before processing (400/401/403/404/409) —
 *              proven not made
 *   uncertain  timeout, network, 5xx, 429, anything else — it MAY have
 *              happened, so it is verified, never retried
 *
 * ⚠ Nothing here logs a title, a body or an address. Ids and statuses only.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TIMEOUT_MS = 20000;
// The reads (and the event shape) live in calendar-read.js, GET-only, so the
// PREPARE half can read an event without importing anything that writes.
const reader = require('./calendar-read');
const { TIMEZONE, MARKER_PROP, normaliseEvent, findByMarker, readEvent, eventsAt } = reader;

const DEFINITIVE_REFUSALS = new Set([400, 401, 403, 404, 409]);

function _category(status, err) {
  if (err) return err === 'timeout' ? 'timeout' : 'network';
  if (status === 401) return 'auth';
  if (status === 403) return 'scope';
  if (status === 429) return 'throttled';
  if (status >= 500) return 'http_5xx';
  if (status >= 400) return 'http_4xx';
  return null;
}

async function _token() {
  try { return await require('./microsoft').getAccessToken(); } catch { return null; }
}

async function _req(method, urlPath, body) {
  const token = await _token();
  if (!token) return { status: null, error: 'no-token', category: 'auth' };
  try {
    const res = await fetch(`${GRAPH}${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        // Times back as wall clock in NEURO's zone — the format every row
        // holds, compared as strings, never re-parsed (the BST bug).
        Prefer: `outlook.timezone="${TIMEZONE}"`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* empty / non-JSON */ }
    return { status: res.status, data, category: _category(res.status) };
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { status: null, error: timedOut ? 'timeout' : 'network', category: _category(null, timedOut ? 'timeout' : 'network') };
  }
}

/** accepted | rejected | uncertain for a write. PURE. */
function classify(r) {
  if (r.status !== null && r.status !== undefined && r.status >= 200 && r.status < 300) return 'accepted';
  if (DEFINITIVE_REFUSALS.has(r.status)) return 'rejected';
  return 'uncertain';
}

/** The Graph body for a create. PURE — exported so a test can pin it. */
function createBody(draft, { transactionId, marker }) {
  const body = {
    subject: draft.subject,
    start: { dateTime: `${draft.start}:00`, timeZone: draft.timeZone || TIMEZONE },
    end: { dateTime: `${draft.end}:00`, timeZone: draft.timeZone || TIMEZONE },
    attendees: (draft.to || []).map((r) => ({ emailAddress: { address: r.email, name: r.name || undefined }, type: 'required' })),
    transactionId,
    singleValueExtendedProperties: [{ id: MARKER_PROP, value: marker }],
  };
  if (draft.body) body.body = { contentType: 'text', content: draft.body };
  if (draft.location) body.location = { displayName: draft.location };
  if (draft.isOnline) { body.isOnlineMeeting = true; body.onlineMeetingProvider = 'teamsForBusiness'; }
  return body;
}

/** Create the event (this IS the invitation). Returns { outcome, status, category, event }. */
async function createEvent(draft, { transactionId, marker }) {
  const path = draft.calendar && draft.calendar.id ? `/me/calendars/${encodeURIComponent(draft.calendar.id)}/events` : '/me/events';
  const r = await _req('POST', path, createBody(draft, { transactionId, marker }));
  return { outcome: classify(r), status: r.status, category: r.category || null, event: r.data ? normaliseEvent(r.data) : null };
}

/** Move an event: PATCH start/end only (Graph tells attendees it moved). */
async function moveEvent(eventId, { start, end, timeZone }) {
  const r = await _req('PATCH', `/me/events/${encodeURIComponent(eventId)}`, {
    start: { dateTime: `${start}:00`, timeZone: timeZone || TIMEZONE },
    end: { dateTime: `${end}:00`, timeZone: timeZone || TIMEZONE },
  });
  return { outcome: classify(r), status: r.status, category: r.category || null, event: r.data ? normaliseEvent(r.data) : null };
}

/** Cancel an event Nick organises (Graph sends attendees the cancellation, with the comment). */
async function cancelEvent(eventId, { comment = '' } = {}) {
  const r = await _req('POST', `/me/events/${encodeURIComponent(eventId)}/cancel`, { comment: String(comment || '').slice(0, 2000) });
  return { outcome: classify(r), status: r.status, category: r.category || null };
}

module.exports = {
  MARKER_PROP, TIMEZONE, classify, normaliseEvent, createBody,
  createEvent, findByMarker, readEvent, eventsAt, moveEvent, cancelEvent,
};
