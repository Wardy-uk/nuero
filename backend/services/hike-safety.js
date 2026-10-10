'use strict';

/**
 * Hike safety — arm a walk, check in, or the people on the card are told
 * (10 Oct 2026). Life → Outdoor → Hike safety; routes in routes/outdoor.js.
 *
 *   arm()       Nick uploads a GPX (or names a walk) with an approximate start
 *               and finish. NEURO freezes a ROUTE CARD and the people to alert.
 *   tick()      the durable job `hike-safety`, every minute:
 *                 · keeps a breadcrumb trail from Home Assistant's trackers
 *                   (Life360, the HA phone app, Ember's collar if she is on
 *                   the card), each fix with its speed → walking / driving;
 *                 · at the planned finish: a push, "Back? Check in";
 *                 · 30 min before the alert: a push, "Alert goes at HH:MM";
 *                 · driving after the walk started: one push, "Back at the car?";
 *                 · at finish + grace (60 min default): the ALERT EMAIL.
 *   checkIn()   any surface. If an alert already went, an all-clear follows.
 *   extend() / cancel()
 *
 * ⚠⚠ THE ALERT IS SENT WITHOUT APPROVAL, AND THAT IS NICK'S DECISION
 *   (10 Oct 2026). Everything else NEURO emails to another person is A4 behind
 *   the approval code (Build 8). An overdue alert cannot wait for an approval —
 *   the person who would give it is the one missing. So ARMING is the approval:
 *   of this card, to these people, if and only if he is overdue. It is the one
 *   sender outside the governed executor (build7-convergence test 33 names it),
 *   on its own external-writes ledger entry, and nothing else can reach it.
 * ⚠ A DUPLICATE ALERT IS BETTER THAN NONE. The ledger is `idempotentTarget`:
 *   an unknown outcome is checked in Sent Items first, then re-attempted —
 *   the opposite of the governed executor's "uncertain is never resent", and
 *   deliberately so.
 * ⚠ Only a deliberate check-in closes a walk. Driving, a synced workout or the
 *   phone arriving home are prompts, never a check-in.
 * ⚠ Coordinates of where Nick went exist here and nowhere else, only for an
 *   armed walk, never on the event log, and are deleted 30 days after it closes.
 *   The map (route, trail, last positions) is in the read ONLY while a walk is
 *   live — for Nick's Hike safety page and Helen's VESTA tracker — and gone
 *   from both the moment he checks in.
 * ⚠ The honest limit: this runs on pi5. If the Pi, Microsoft sign-in or the
 *   house internet is down at the deadline, the alert does not go. Arming
 *   refuses when email cannot be sent; the 30-minute warning says so too.
 */

const crypto = require('crypto');
const model = require('./hike-safety-model');

const WRITER = 'hike.safety-alert';
const CONTACTS_KEY = 'hike_safety_contacts';
const POLL_KEY = 'hike_safety_last_poll';
const POLL_EVERY_MS = 4.5 * 60 * 1000;
const PURGE_AFTER_DAYS = 30;
const MAX_ALERT_ATTEMPTS = 60;
const MAX_GPX_ATTACH = 2.5 * 1024 * 1024;
const PUSH_TYPE = 'hike_checkin';
const PUSH_URL = '/?view=hike-safety';

function _db() { return require('../db/database'); }
const _iso = (ms) => new Date(ms).toISOString();
const _ms = (s) => (s ? Date.parse(s) : null);
const _json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const _now = (now) => (now instanceof Date ? now.getTime() : Number.isFinite(now) ? now : Date.now());

function _defaultDeps() {
  return {
    fetchStates: () => require('./ha').fetchStates(),
    // The type is written at the call so push-types.test sees what this sends.
    push: (title, body, data) => require('./webpush').sendToAll(title, body, { ...data, type: 'hike_checkin' }),
    mail: require('./action-mail'),
    mailReady: async () => { try { return !!(await require('./microsoft').getAccessToken()); } catch { return false; } },
  };
}

function _log(kind, subjectId, detail, nowMs) {
  try {
    return require('./personal-obligations').logEvent(kind, { subjectId, actor: kind === 'hike-armed' || kind === 'hike-checked-in' || kind === 'hike-extended' || kind === 'hike-cancelled' ? 'nick' : 'neuro', detail, dedupeKey: `${kind}:${subjectId}:${nowMs}:${crypto.randomBytes(3).toString('hex')}`, now: nowMs });
  } catch { return false; }
}

// ── contacts ────────────────────────────────────────────────────────────────
// ⚠ No default in code: the repo is public and a default here would publish a
//   personal email address. Until a contacts store exists, the list is one
//   setting, set from Life → Outdoor → Hike safety.

function contacts() {
  const v = model.validateContacts(_json(_db().getState(CONTACTS_KEY), null));
  return v.contacts || [];
}

function setContacts(list, { now = Date.now() } = {}) {
  const v = model.validateContacts(list);
  if (v.error) return { ok: false, status: 400, error: v.error };
  _db().setState(CONTACTS_KEY, JSON.stringify(v.contacts));
  _log('hike-contacts-set', 'hike-safety', { count: v.contacts.length, names: v.contacts.map((c) => c.name) }, _now(now));
  return { ok: true, contacts: v.contacts };
}

// ── the trip row ───────────────────────────────────────────────────────────

function _shape(r) {
  if (!r) return null;
  return {
    tripId: r.trip_id, routeId: r.route_id, name: r.name, status: r.status,
    startMs: _ms(r.planned_start), finishMs: _ms(r.planned_finish), extendedUntilMs: _ms(r.extended_until),
    graceMin: r.grace_minutes, ember: r.ember === 1, companion: r.companion, notes: r.notes,
    recipients: _json(r.recipients_json, []), card: r.card_text, cardHash: r.card_hash, gpxName: r.gpx_name,
    remindedAt: r.reminded_at, warnedAt: r.warned_at, drivingPromptAt: r.driving_prompt_at,
    alertStatus: r.alert_status, alertAt: r.alert_at, alertAttempts: r.alert_attempts, alertError: r.alert_error,
    allClearStatus: r.all_clear_status, checkedInAt: r.checked_in_at, checkedInVia: r.checked_in_via,
    cancelledAt: r.cancelled_at, armedAt: r.armed_at, closedAt: r.closed_at,
  };
}

const _get = (id) => _db().get('SELECT * FROM hike_trips WHERE trip_id = ?', [id]);
function _set(id, fields) {
  const keys = Object.keys(fields);
  _db().run(`UPDATE hike_trips SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE trip_id = ?`, [...Object.values(fields), id]);
}

function _vehicleLine() {
  try {
    const v = _db().get("SELECT make, model, registration FROM vehicles WHERE ownership_state = 'current' AND registration IS NOT NULL ORDER BY updated_at DESC LIMIT 1");
    return v ? `${[v.make, v.model].filter(Boolean).join(' ') || 'His car'}, registration ${v.registration}` : null;
  } catch { return null; }
}

function _companionName(ember) {
  if (!ember) return null;
  try { const c = require('./personal-world').listCompanions()[0]; return c ? c.name : 'Ember'; } catch { return 'Ember'; }
}

// ── arm / check in / extend / cancel ───────────────────────────────────────

/**
 * Arm a walk. `body`: { gpx?, gpxName?, routeId?, name?, plannedStart,
 * plannedFinish, graceMinutes?, emberPlanned?, notes? }. A GPX also becomes a
 * route plan (outdoor.createRoute) — one route model, not two.
 */
async function arm(body = {}, { now = Date.now(), deps = _defaultDeps() } = {}) {
  const nowMs = _now(now);
  const v = model.validateTrip(body, { nowMs });
  if (v.error) return { ok: false, status: 400, error: v.error };
  const people = contacts();
  if (!people.length) return { ok: false, status: 409, error: 'nobody to alert yet — add who gets the alert first' };
  const live = _db().get("SELECT trip_id, name FROM hike_trips WHERE status IN ('armed','alerted')");
  if (live) return { ok: false, status: 409, error: `“${live.name}” is still armed — check in or cancel it first` };
  if (!(await deps.mailReady())) {
    return { ok: false, status: 409, error: 'NEURO cannot send email right now (Microsoft sign-in) — the alert could not go, so the walk is not armed. Tell someone directly.' };
  }

  let route = null; let routeId = null;
  if (body.gpx) {
    const g = require('./outdoor-model').parseGpx(body.gpx);
    if (!g.ok) return { ok: false, status: 400, error: g.error };
    route = g;
    const created = require('./outdoor').createRoute({ name: v.fields.name || g.name || 'Walk', kind: 'hike', plannedDate: model.msToLocal(v.fields.startMs).slice(0, 10), emberPlanned: v.fields.ember, gpx: body.gpx }, { now: nowMs });
    if (created.ok) routeId = created.routeId;
  } else if (body.routeId) {
    const r = _db().get('SELECT * FROM outdoor_routes WHERE route_id = ?', [body.routeId]);
    if (!r) return { ok: false, status: 404, error: 'no such route' };
    routeId = r.route_id;
    route = { distanceKm: r.distance_km, elevationGainM: r.elevation_gain_m, geometry: _json(r.geometry_json, []), highest: null, name: r.name };
  }
  const name = v.fields.name || (route && route.name) || 'Walk';
  if (body.gpxName !== undefined && (typeof body.gpxName !== 'string' || body.gpxName.length > 120)) return { ok: false, status: 400, error: 'gpxName must be a file name' };
  const gpxName = body.gpx ? (body.gpxName && body.gpxName.trim()) || `${name.replace(/[^\w -]+/g, '').trim() || 'route'}.gpx` : null;
  const companion = _companionName(v.fields.ember);
  const card = model.routeCard({ name, startMs: v.fields.startMs, finishMs: v.fields.finishMs, graceMin: v.fields.grace, route, ember: v.fields.ember, companion, vehicle: _vehicleLine(), notes: v.fields.notes, gpxName: gpxName && body.gpx.length <= MAX_GPX_ATTACH ? gpxName : null });
  const tripId = `hike:${crypto.randomUUID()}`;
  _db().run(`INSERT INTO hike_trips (trip_id, route_id, name, status, planned_start, planned_finish, grace_minutes, ember, companion, notes,
      recipients_json, card_text, card_hash, gpx_name, gpx_text, armed_at) VALUES (?, ?, ?, 'armed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [tripId, routeId, name, _iso(v.fields.startMs), _iso(v.fields.finishMs), v.fields.grace, v.fields.ember ? 1 : 0, companion, v.fields.notes,
    JSON.stringify(people), card, crypto.createHash('sha256').update(card).digest('hex'), gpxName,
    body.gpx && body.gpx.length <= MAX_GPX_ATTACH ? body.gpx : null, _iso(nowMs)]);
  _log('hike-armed', tripId, { name, start: model.msToLocal(v.fields.startMs), finish: model.msToLocal(v.fields.finishMs), graceMin: v.fields.grace, alerting: people.map((p) => p.name) }, nowMs);
  return { ok: true, trip: view(_shape(_get(tripId)), { nowMs }) };
}

async function checkIn(tripId, { via = null, now = Date.now(), deps = _defaultDeps() } = {}) {
  const nowMs = _now(now);
  const r = _get(tripId);
  if (!r) return { ok: false, status: 404, error: 'no such walk' };
  if (r.status === 'checked_in') return { ok: true, already: true, trip: view(_shape(r), { nowMs }) };
  if (r.status === 'cancelled') return { ok: false, status: 409, error: 'that walk was cancelled' };
  const wasAlerted = r.status === 'alerted' || ['sending', 'sent', 'confirmed', 'uncertain'].includes(r.alert_status);
  _set(tripId, { status: 'checked_in', checked_in_at: _iso(nowMs), checked_in_via: via ? String(via).slice(0, 40) : null, closed_at: _iso(nowMs) });
  _log('hike-checked-in', tripId, { name: r.name, via: via || null, afterAlert: wasAlerted }, nowMs);
  let allClear = null;
  if (wasAlerted) allClear = await _sendAllClear(_shape(_get(tripId)), { nowMs, deps, via });
  return { ok: true, allClear, trip: view(_shape(_get(tripId)), { nowMs }) };
}

function extend(tripId, minutes, { now = Date.now() } = {}) {
  const nowMs = _now(now);
  const r = _get(tripId);
  if (!r) return { ok: false, status: 404, error: 'no such walk' };
  if (r.status !== 'armed') return { ok: false, status: 409, error: r.status === 'alerted' ? 'the alert has already gone — check in instead' : `that walk is ${r.status.replace('_', ' ')}` };
  const m = Number(minutes);
  if (!Number.isInteger(m) || m < model.EXTEND_RANGE[0] || m > model.EXTEND_RANGE[1]) return { ok: false, status: 400, error: `minutes must be a whole number from ${model.EXTEND_RANGE[0]} to ${model.EXTEND_RANGE[1]}` };
  const { dueMs } = model.times(_shape(r));
  const until = Math.max(dueMs, nowMs) + m * 60000;
  // A new due time earns its own reminder and warning.
  _set(tripId, { extended_until: _iso(until), reminded_at: null, warned_at: null });
  _log('hike-extended', tripId, { name: r.name, minutes: m, until: model.msToLocal(until) }, nowMs);
  return { ok: true, trip: view(_shape(_get(tripId)), { nowMs }) };
}

function cancel(tripId, { now = Date.now() } = {}) {
  const nowMs = _now(now);
  const r = _get(tripId);
  if (!r) return { ok: false, status: 404, error: 'no such walk' };
  if (r.status === 'cancelled') return { ok: true, already: true };
  if (r.status === 'alerted') return { ok: false, status: 409, error: 'the alert has already gone — check in so they get the all-clear' };
  if (r.status !== 'armed') return { ok: false, status: 409, error: `that walk is ${r.status.replace('_', ' ')}` };
  _set(tripId, { status: 'cancelled', cancelled_at: _iso(nowMs), closed_at: _iso(nowMs) });
  _log('hike-cancelled', tripId, { name: r.name }, nowMs);
  return { ok: true };
}

// ── the trail ──────────────────────────────────────────────────────────────

function _crumbs(tripId) {
  return _db().all('SELECT * FROM hike_breadcrumbs WHERE trip_id = ? ORDER BY observed_at', [tripId]).map((c) => ({
    source: c.source, role: c.role, observedMs: c.observed_at, lat: c.lat, lon: c.lon, accuracyM: c.accuracy_m,
    speedKmh: c.speed_kmh, mode: c.mode, battery: c.battery, receivedMs: c.received_at,
  }));
}

/** Which HA trackers to read: Nick's person entity's own trackers, plus Ember's collar if she is on the card. */
function _trackerFixes(states, trip) {
  if (!Array.isArray(states)) return [];
  const byId = new Map(states.filter(Boolean).map((s) => [s.entity_id, s]));
  const person = byId.get(`person.${process.env.HA_PERSON_ID || 'nick'}`);
  const mine = (person && person.attributes && Array.isArray(person.attributes.device_trackers)) ? person.attributes.device_trackers : [];
  const out = [];
  for (const id of mine) { const f = model.fixFromState(byId.get(id), { role: 'nick' }); if (f) out.push(f); }
  if (trip.ember) {
    const slug = String(trip.companion || 'Ember').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const f = model.fixFromState(byId.get(`device_tracker.${slug}_tracker`), { role: 'ember' });
    if (f) out.push(f);
  }
  return out;
}

function _record(trip, fixes, nowMs) {
  let added = 0;
  for (const f of fixes) {
    if (f.observedMs < trip.startMs - 15 * 60000) continue; // a stale fix from before the walk is not part of it
    const prev = _db().get('SELECT * FROM hike_breadcrumbs WHERE trip_id = ? AND source = ? ORDER BY observed_at DESC LIMIT 1', [trip.tripId, f.source]);
    const speed = f.speedKmh != null ? f.speedKmh
      : model.speedBetween(prev && { lat: prev.lat, lon: prev.lon, observedMs: prev.observed_at, accuracyM: prev.accuracy_m }, f);
    const mode = model.modeOf({ speedKmh: speed, driving: f.driving });
    const r = _db().run(`INSERT OR IGNORE INTO hike_breadcrumbs (trip_id, source, role, observed_at, lat, lon, accuracy_m, speed_kmh, mode, battery, received_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [trip.tripId, f.source, f.role, f.observedMs, f.lat, f.lon, f.accuracyM, speed, mode, f.battery, nowMs]);
    if (r && r.changes) added += 1;
  }
  return added;
}

// ── sending ────────────────────────────────────────────────────────────────

async function _push(deps, title, body, extra = {}) {
  try { await deps.push(title, body, { type: PUSH_TYPE, url: PUSH_URL, ...extra }); return true; } catch (e) { console.warn(`[HikeSafety] push failed: ${e.message}`); return false; }
}

async function _sendAlert(trip, { nowMs, deps }) {
  const key = `hike-alert:${trip.tripId}`;
  const ew = require('./external-writes');
  const row = _get(trip.tripId);
  const recipients = trip.recipients;
  const to = recipients.map((c) => ({ email: c.email, name: c.name }));

  // An earlier attempt whose outcome is unknown: look before sending again.
  if (row.alert_message_id && ['sending', 'uncertain', 'sent'].includes(row.alert_status)) {
    const found = await deps.mail.findSent(row.alert_message_id);
    if (found && found.ok && found.messages.length) {
      _set(trip.tripId, { alert_status: 'confirmed' });
      const e = ew.byKey(key); if (e) ew.settle(e.id, { status: 'confirmed', readback: 'found in Sent Items', now: nowMs });
      return { ok: true, outcome: 'confirmed' };
    }
    if (row.alert_status === 'sent') return { ok: true, outcome: 'sent' }; // accepted; Sent Items has not caught up yet
    if (row.alert_draft_id) {
      const st = await deps.mail.draftState(row.alert_draft_id);
      if (st === 'not-draft' || st === 'gone') {
        _set(trip.tripId, { alert_status: 'sent' });
        const e = ew.byKey(key); if (e) ew.settle(e.id, { status: 'applied-unverified', readback: `draft ${st}`, now: nowMs });
        return { ok: true, outcome: 'sent' };
      }
    }
  }
  if (row.alert_attempts >= MAX_ALERT_ATTEMPTS) return { ok: false, outcome: 'gave-up' };

  const b = ew.begin({ writer: WRITER, key, target: recipients.map((c) => c.email).join(', '), request: { tripId: trip.tripId, cardHash: trip.cardHash, recipients: recipients.map((c) => c.name) }, initiatedBy: 'timer:armed-by-nick', now: nowMs });
  if (!b.ok && b.duplicate) { _set(trip.tripId, { alert_status: 'confirmed' }); return { ok: true, outcome: 'already' }; }
  if (!b.ok) return { ok: false, outcome: 'refused', why: b.why };

  const { subject, body } = model.alertEmail({ trip, card: trip.card, fixes: _crumbs(trip.tripId), nowMs, recipients });
  _set(trip.tripId, { alert_status: 'sending', alert_attempts: row.alert_attempts + 1, alert_at: row.alert_at || _iso(nowMs) });
  let draftId = row.alert_draft_id;
  if (!draftId || (await deps.mail.draftState(draftId)) !== 'draft') {
    const attachments = row.gpx_text && row.gpx_name ? [{ name: row.gpx_name, contentType: 'application/gpx+xml', text: row.gpx_text }] : [];
    const d = await deps.mail.createDraft({ to, subject, body, contentType: 'Text', attachments });
    if (!d || !d.ok) {
      _set(trip.tripId, { alert_status: 'failed', alert_error: `could not create the email (${(d && d.category) || 'unknown'})` });
      ew.settle(b.entry.id, { status: 'failed', result: { stage: 'draft', category: d && d.category }, now: nowMs });
      return { ok: false, outcome: 'failed' };
    }
    draftId = d.id;
    _set(trip.tripId, { alert_draft_id: d.id, alert_message_id: d.internetMessageId || null });
  }
  const s = await deps.mail.sendDraft(draftId);
  if (s.outcome === 'accepted') {
    _set(trip.tripId, { alert_status: 'sent', alert_error: null });
    ew.settle(b.entry.id, { status: 'applied-unverified', result: { status: s.status }, readback: 'accepted by Microsoft; verified against Sent Items on the next pass', now: nowMs });
    _log('hike-alert-sent', trip.tripId, { name: trip.name, to: recipients.map((c) => c.name) }, nowMs);
    return { ok: true, outcome: 'sent' };
  }
  if (s.outcome === 'rejected') {
    _set(trip.tripId, { alert_status: 'failed', alert_error: `Microsoft refused the send (${s.category || s.status})` });
    ew.settle(b.entry.id, { status: 'failed', result: { status: s.status, category: s.category }, now: nowMs });
    _log('hike-alert-failed', trip.tripId, { name: trip.name, why: s.category || s.status }, nowMs);
    return { ok: false, outcome: 'failed' };
  }
  _set(trip.tripId, { alert_status: 'uncertain', alert_error: `send outcome unknown (${s.category || 'unknown'}) — checking Sent Items` });
  ew.settle(b.entry.id, { status: 'uncertain', result: { status: s.status, category: s.category }, now: nowMs });
  return { ok: false, outcome: 'uncertain' };
}

async function _sendAllClear(trip, { nowMs, deps, via }) {
  const ew = require('./external-writes');
  const b = ew.begin({ writer: WRITER, key: `hike-allclear:${trip.tripId}`, target: trip.recipients.map((c) => c.email).join(', '), request: { tripId: trip.tripId, kind: 'all-clear' }, initiatedBy: 'nick', now: nowMs });
  if (!b.ok) return { outcome: b.duplicate ? 'already' : 'refused' };
  const { subject, body } = model.allClearEmail({ trip, nowMs, recipients: trip.recipients, via });
  const d = await deps.mail.createDraft({ to: trip.recipients.map((c) => ({ email: c.email, name: c.name })), subject, body, contentType: 'Text' });
  if (!d || !d.ok) { ew.settle(b.entry.id, { status: 'failed', now: nowMs }); _set(trip.tripId, { all_clear_status: 'failed' }); return { outcome: 'failed' }; }
  const s = await deps.mail.sendDraft(d.id);
  const status = s.outcome === 'accepted' ? 'sent' : s.outcome === 'rejected' ? 'failed' : 'uncertain';
  ew.settle(b.entry.id, { status: status === 'sent' ? 'applied-unverified' : status, result: { status: s.status }, now: nowMs });
  _set(trip.tripId, { all_clear_status: status });
  _log('hike-all-clear', trip.tripId, { name: trip.name, outcome: status }, nowMs);
  return { outcome: status };
}

// ── the job ────────────────────────────────────────────────────────────────

async function tick({ now = Date.now(), deps = _defaultDeps() } = {}) {
  const nowMs = _now(now);
  const db = _db();
  const out = { trips: 0, crumbs: 0, pushed: [], alerts: [] };
  const trips = db.all("SELECT * FROM hike_trips WHERE status IN ('armed','alerted')").map(_shape);
  const lastPoll = Number(db.getState(POLL_KEY)) || 0;
  let states = null;
  for (const trip of trips) {
    out.trips += 1;
    const p = model.plan(trip, nowMs);
    if (p.track && nowMs - lastPoll >= POLL_EVERY_MS) {
      if (states === null) {
        try { states = await deps.fetchStates(); } catch (e) { states = []; console.warn(`[HikeSafety] Home Assistant unreadable: ${e.message}`); }
        db.setState(POLL_KEY, String(nowMs));
      }
      out.crumbs += _record(trip, _trackerFixes(states, trip), nowMs);
    }
    const { deadlineMs } = model.times(trip);
    if (trip.status === 'armed' && !trip.drivingPromptAt && model.drivingLately(_crumbs(trip.tripId), { trip, nowMs })) {
      _set(trip.tripId, { driving_prompt_at: _iso(nowMs) });
      await _push(deps, 'Back at the car?', `You seem to be driving. Check in from ${trip.name} so ${trip.recipients[0].name} isn’t alerted at ${model.hhmm(deadlineMs)}.`, { tripId: trip.tripId });
      out.pushed.push('driving');
    }
    if (p.remind) {
      _set(trip.tripId, { reminded_at: _iso(nowMs) });
      await _push(deps, 'Back from your walk?', `Check in from ${trip.name}. If you don’t, ${trip.recipients.map((c) => c.name).join(' and ')} get an alert at ${model.hhmm(deadlineMs)}.`, { tripId: trip.tripId });
      out.pushed.push('remind');
    }
    if (p.warn) {
      _set(trip.tripId, { warned_at: _iso(nowMs) });
      const ready = await deps.mailReady();
      await _push(deps, `Alert in ${Math.round((deadlineMs - nowMs) / 60000)} min`, `No check-in from ${trip.name} yet. The alert goes at ${model.hhmm(deadlineMs)}. Check in, or extend if you’re running late.${ready ? '' : ' ⚠ NEURO cannot send email right now — the alert may not go. Tell someone directly.'}`, { tripId: trip.tripId });
      out.pushed.push('warn');
    }
    if (p.alert) {
      if (trip.status === 'armed') _set(trip.tripId, { status: 'alerted' });
      const r = await _sendAlert(_shape(_get(trip.tripId)), { nowMs, deps });
      out.alerts.push({ tripId: trip.tripId, ...r });
      if (r.outcome === 'sent' && trip.alertStatus !== 'sent') {
        await _push(deps, `Alert sent to ${trip.recipients.map((c) => c.name).join(' and ')}`, `You hadn’t checked in from ${trip.name}. Check in now and they get the all-clear.`, { tripId: trip.tripId });
      }
    }
  }
  out.purged = purge({ now: nowMs });
  return out;
}

/** Delete the trail (and the stored GPX) 30 days after a walk closed. */
function purge({ now = Date.now() } = {}) {
  const nowMs = _now(now);
  const cutoff = _iso(nowMs - PURGE_AFTER_DAYS * 24 * 3600 * 1000);
  const due = _db().all("SELECT trip_id FROM hike_trips WHERE closed_at IS NOT NULL AND closed_at < ? AND trail_purged_at IS NULL", [cutoff]);
  for (const r of due) {
    _db().run('DELETE FROM hike_breadcrumbs WHERE trip_id = ?', [r.trip_id]);
    _set(r.trip_id, { gpx_text: null, trail_purged_at: _iso(nowMs) });
  }
  return due.length;
}

// ── read ───────────────────────────────────────────────────────────────────

/** A trip for the screen. Trail as counts, ages and modes — never the points. */
function view(trip, { nowMs }) {
  if (!trip) return null;
  const { dueMs, deadlineMs } = model.times(trip);
  const crumbs = _crumbs(trip.tripId);
  const latest = new Map();
  for (const c of crumbs) latest.set(c.source, c);
  return {
    tripId: trip.tripId, name: trip.name, status: trip.status, routeId: trip.routeId,
    start: model.msToLocal(trip.startMs), finish: model.msToLocal(trip.finishMs), due: model.msToLocal(dueMs), alertAt: model.msToLocal(deadlineMs),
    extended: !!trip.extendedUntilMs, graceMin: trip.graceMin, ember: trip.ember,
    minutesToAlert: Math.round((deadlineMs - nowMs) / 60000),
    alerting: trip.recipients.map((c) => c.name),
    alert: { status: trip.alertStatus, at: trip.alertAt, error: trip.alertError, allClear: trip.allClearStatus },
    checkedInAt: trip.checkedInAt ? model.msToLocal(_ms(trip.checkedInAt)) : null, checkedInVia: trip.checkedInVia,
    card: trip.card, gpxAttached: !!trip.gpxName,
    map: ['armed', 'alerted'].includes(trip.status) ? _mapData(trip, nowMs) : null,
    trail: {
      points: crumbs.length,
      sources: [...latest.values()].map((c) => ({ label: model.sourceLabel(c.source, c.role), lastSeen: model.ago(c.observedMs, nowMs), mode: c.mode, modeWords: model.MODE_WORDS[c.mode], battery: c.battery })),
    },
  };
}

function read({ now = Date.now() } = {}) {
  const nowMs = _now(now);
  const db = _db();
  const active = db.get("SELECT * FROM hike_trips WHERE status IN ('armed','alerted') ORDER BY planned_start LIMIT 1");
  const recent = db.all("SELECT * FROM hike_trips WHERE status IN ('checked_in','cancelled') ORDER BY armed_at DESC LIMIT 5");
  const people = contacts();
  return {
    ok: true, contract: 'hike-safety-v1',
    active: active ? view(_shape(active), { nowMs }) : null,
    recent: recent.map((r) => ({ tripId: r.trip_id, name: r.name, status: r.status, start: model.msToLocal(_ms(r.planned_start)), checkedInAt: r.checked_in_at ? model.msToLocal(_ms(r.checked_in_at)) : null, alert: r.alert_status })),
    contacts: people.map((c) => ({ name: c.name, email: c.email })),
    defaults: { graceMinutes: model.DEFAULT_GRACE_MIN, graceRange: model.GRACE_RANGE, extendRange: model.EXTEND_RANGE },
    rule: `If you have not checked in by your finish time plus ${model.DEFAULT_GRACE_MIN} minutes, NEURO emails the route card and your last known positions to the people listed — no approval needed; arming the walk is the approval. Only a check-in closes a walk. The trail is kept only for an armed walk and deleted ${PURGE_AFTER_DAYS} days after it ends.`,
    limits: 'This runs on NEURO’s Pi at home. If the Pi, Microsoft sign-in or the house internet is down at the alert time, the alert does not go — still tell someone your plan.',
  };
}

/** The map of a live walk: the planned route, the trails, each tracker's last position. Live walks only. */
function _mapData(trip, nowMs) {
  const db = _db();
  let route = [];
  if (trip.routeId) {
    try { route = _json(db.get('SELECT geometry_json FROM outdoor_routes WHERE route_id = ?', [trip.routeId]).geometry_json, []); } catch { route = []; }
  }
  const crumbs = _crumbs(trip.tripId);
  const latest = new Map();
  for (const c of crumbs) latest.set(c.source, c);
  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  return {
    route: _thin(route, MAX_ROUTE_PTS),
    trail: _thin(crumbs.filter((c) => c.role === 'nick').map((c) => [r5(c.lat), r5(c.lon)]), MAX_TRAIL_PTS),
    emberTrail: _thin(crumbs.filter((c) => c.role === 'ember').map((c) => [r5(c.lat), r5(c.lon)]), MAX_TRAIL_PTS),
    positions: [...latest.values()].sort((a, b) => (a.role === b.role ? b.observedMs - a.observedMs : a.role === 'nick' ? -1 : 1)).map((c) => ({
      who: c.role, label: c.role === 'ember' ? `${trip.companion || 'Ember'}’s collar` : model.sourceLabel(c.source, c.role),
      lat: r5(c.lat), lon: r5(c.lon),
      at: model.msToLocal(c.observedMs), ago: model.ago(c.observedMs, nowMs), minutesAgo: Math.round((nowMs - c.observedMs) / 60000),
      accuracyM: c.accuracyM, mode: c.mode, modeWords: model.MODE_WORDS[c.mode], battery: c.battery,
      gridRef: model.gridRef(c.lat, c.lon), maps: model.mapsLink(c.lat, c.lon),
    })),
  };
}

/**
 * The walk as VESTA shows it (the `hike` scope) — Helen's route tracker.
 *
 * ⚠ POSITIONS ONLY WHILE A WALK IS ARMED OR OVERDUE. The moment he checks in
 *   the answer drops to "back at HH:MM" with no coordinates at all: she needs
 *   to know where he is on the hill, not where he walked last Tuesday. Nothing
 *   at all is returned when no walk is live or recent — a public mount says
 *   nothing it does not need to.
 * ⚠ Each tracker is its own row with its own age — never merged into one dot.
 */
const RECENT_BACK_MS = 6 * 3600 * 1000;
const MAX_ROUTE_PTS = 200;
const MAX_TRAIL_PTS = 300;

function _thin(points, max) {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out = [];
  for (let i = 0; i < max - 1; i += 1) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

function householdView({ now = Date.now() } = {}) {
  const nowMs = _now(now);
  const db = _db();
  const live = db.get("SELECT * FROM hike_trips WHERE status IN ('armed','alerted') ORDER BY planned_start LIMIT 1");
  if (!live) {
    const back = db.get("SELECT * FROM hike_trips WHERE status = 'checked_in' AND checked_in_at >= ? ORDER BY checked_in_at DESC LIMIT 1", [_iso(nowMs - RECENT_BACK_MS)]);
    if (!back) return { active: false };
    return { active: false, back: { name: back.name, checkedInAt: model.msToLocal(_ms(back.checked_in_at)) } };
  }
  const trip = _shape(live);
  const { dueMs, deadlineMs } = model.times(trip);
  const started = nowMs >= trip.startMs;
  const map = _mapData(trip, nowMs);
  return {
    active: true,
    name: trip.name,
    state: trip.status === 'alerted' ? 'overdue' : started ? 'out' : 'not-started',
    start: model.msToLocal(trip.startMs), due: model.msToLocal(dueMs), alertAt: model.msToLocal(deadlineMs),
    extended: !!trip.extendedUntilMs, ember: trip.ember, companion: trip.companion,
    minutesLate: trip.status === 'alerted' ? Math.max(0, Math.round((nowMs - dueMs) / 60000)) : null,
    alerted: trip.status === 'alerted' ? { at: trip.alertAt ? model.msToLocal(_ms(trip.alertAt)) : null, sent: ['sent', 'confirmed'].includes(trip.alertStatus) } : null,
    ...map,
    card: trip.card,
  };
}

const TABLES = ['hike_trips', 'hike_breadcrumbs'];

module.exports = { WRITER, CONTACTS_KEY, PUSH_TYPE, TABLES, contacts, setContacts, arm, checkIn, extend, cancel, tick, purge, read, view, householdView };
