'use strict';

/**
 * The world model — Person and Meeting (Build 3C, 3 Oct 2026).
 *
 * The first projections about WHAT IS HAPPENING rather than whether a sensor
 * works. Builds 1–2 answered "is the calendar source healthy?"; this answers
 * "what meeting is on now, what is next, who is in it, and how do we know?".
 *
 * A transactional, replayable consumer of three event types:
 *
 *   observation.person.declared          a People note (Nick's own record)
 *   observation.calendar.event_observed  one calendar entry as a source showed it
 *   observation.calendar.event_removed   an entry a source stopped showing
 *
 * Everything in the wm_* tables is folded from those events and nothing else,
 * so a replay rebuilds it identically.
 *
 * ── Identity rules (conservative on purpose) ────────────────────────────────
 *
 *  • A PERSON is only ever created from a People note. An attendee address no
 *    note declares stays a participant with person_id NULL. Inventing a person
 *    per unknown address would turn a 300-person broadcast into 300 "people".
 *  • An address belongs to a person by EXACT, case-insensitive match against
 *    the note's `email:` — nothing fuzzy, no first names, no display names.
 *    The 15 Aug lesson stands: a bare first name once attributed one Lucy's
 *    commitments to four Lucys.
 *  • Two notes claiming one address is a CONFLICT: recorded, bound to neither.
 *  • Every binding change is written to wm_identity_log with its evidence
 *    event, so "why does this meeting say Naomi?" always has an answer.
 *
 * ── Meeting identity and dedupe ─────────────────────────────────────────────
 *
 *  • A meeting is keyed on its AUTHORITATIVE provider id: graph:<id>, else
 *    apple:<id>. Graph occurrence ids are per-occurrence and stable.
 *  • The phone and Graph share no identifier. A phone entry with the same
 *    start minute and title (case-insensitive) as a Graph meeting is the SAME
 *    meeting: attached as a SUPPORTING source, never a second meeting. If the
 *    phone copy arrived first, the Graph observation absorbs it (status
 *    `merged`, sources re-pointed). Graph wins because it carries the attendee
 *    list and response status — the same call apple-ingest already makes.
 *
 * ── Facts, observations, inferences ─────────────────────────────────────────
 *
 *  A declared person is a FACT (his own vault). A meeting's fields are
 *  OBSERVATIONS (what Graph or the phone said). `kind` (meeting | block |
 *  unknown) is an INFERENCE from the attendee list, and `unknown` is kept
 *  whenever the source could not tell — it is never collapsed into "block".
 */

const crypto = require('crypto');
const db = require('../db/database');
const bus = require('./event-bus');

const CONSUMER = 'world-model';
const TYPES = ['observation.person.declared', 'observation.calendar.event_observed', 'observation.calendar.event_removed',
  // Build 4B: tasks and commitments fold in the SAME consumer, so owners resolve
  // against exactly the people that existed at that point in the log.
  'observation.task.observed', 'observation.task.removed', 'observation.commitment.observed',
  // Build 5D: evidence about whether a commitment moved, folded beside it.
  'observation.progress.evidence',
  // Build 11E/F: the personal entities — Ember, and Nick's declared goals.
  'observation.companion.declared', 'intent.goal.declared',
  // Build 13H: who is home, from Home Assistant.
  'observation.presence.changed'];
const obligations = require('./world-obligations');
const progress = require('./progress-evidence');
const MAX_EVIDENCE = 10;
const TIMEZONE = process.env.NEURO_TIMEZONE || 'Europe/London';

// ── helpers ─────────────────────────────────────────────────────────────────

const lower = (s) => String(s || '').trim().toLowerCase();
const normTitle = (s) => lower(s).replace(/\s+/g, ' ');
// Wall-clock minute, sliced and never parsed: the sources already speak
// Europe/London wall-clock, and re-parsing is how BST events land an hour out.
const minuteOf = (s) => String(s || '').slice(0, 16);
const matchKey = (start, title) => `${minuteOf(start)}|${normTitle(title)}`;

function _appendEvidence(json, eventId) {
  let list = [];
  try { list = JSON.parse(json || '[]'); } catch { list = []; }
  if (!list.includes(eventId)) list.push(eventId);
  return JSON.stringify(list.slice(-MAX_EVIDENCE));
}

function _log(kind, value, personId, action, rule, ev, detail = null) {
  db.run(`INSERT INTO wm_identity_log (kind, value, person_id, action, rule, evidence_event_id, detail_json, at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  [kind, value, personId, action, rule, ev.eventId, detail ? JSON.stringify(detail) : null, ev.receivedAt]);
}

/** Point every participant row with this address at `personId` (or at nobody). */
function _relinkParticipants(email, personId, ev) {
  const r = db.run(`UPDATE wm_meeting_participants SET person_id = ?, link_method = ? WHERE email = ?`,
    [personId, personId ? 'exact-email' : null, email]);
  if (r.changes) _log('email', email, personId, 'participants-linked', personId ? 'exact-email' : 'unbound', ev, { rows: r.changes });
}

// ── people ──────────────────────────────────────────────────────────────────

function _claimantsOf(row) {
  if (!row) return [];
  if (row.person_id) return [row.person_id];
  try { return JSON.parse(row.conflict_json || '[]'); } catch { return []; }
}

function _setIdentity(email, claimants, ev) {
  const unique = [...new Set(claimants)].sort();
  if (!unique.length) {
    db.run('DELETE FROM wm_person_identities WHERE kind = ? AND value = ?', ['email', email]);
    _log('email', email, null, 'unbound', 'no-claimant', ev);
    _relinkParticipants(email, null, ev);
    return;
  }
  const owner = unique.length === 1 ? unique[0] : null;
  db.run(`INSERT INTO wm_person_identities (kind, value, person_id, method, conflict_json, evidence_event_id, observed_at)
          VALUES ('email', ?, ?, 'vault-declared', ?, ?, ?)
          ON CONFLICT(kind, value) DO UPDATE SET person_id = excluded.person_id, method = excluded.method,
            conflict_json = excluded.conflict_json, evidence_event_id = excluded.evidence_event_id,
            observed_at = excluded.observed_at`,
  [email, owner, owner ? null : JSON.stringify(unique), ev.eventId, ev.occurredAt]);
  if (owner) _log('email', email, owner, 'bound', 'vault-declared', ev);
  else _log('email', email, null, 'conflict', 'two-notes-one-address', ev, { claimants: unique });
  _relinkParticipants(email, owner, ev);
}

function _applyPerson(ev) {
  const p = ev.payload;
  const id = p.personId;
  const cur = db.get('SELECT * FROM wm_people WHERE person_id = ?', [id]);
  db.run(`INSERT INTO wm_people (person_id, display_name, note_path, role, team, direct_report, manager, status,
            aliases_json, provenance_kind, confidence, first_observed_at, last_observed_at, evidence_json, fingerprint, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'fact', 1, ?, ?, ?, ?, ?)
          ON CONFLICT(person_id) DO UPDATE SET display_name = excluded.display_name, note_path = excluded.note_path,
            role = excluded.role, team = excluded.team, direct_report = excluded.direct_report, manager = excluded.manager,
            status = excluded.status, aliases_json = excluded.aliases_json, last_observed_at = excluded.last_observed_at,
            evidence_json = excluded.evidence_json, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`,
  [id, p.displayName, p.notePath, p.role || null, p.team || null,
    typeof p.directReport === 'boolean' ? (p.directReport ? 1 : 0) : null, p.manager || null, p.status || null,
    JSON.stringify(Array.isArray(p.aliases) ? p.aliases : []),
    cur ? cur.first_observed_at : ev.occurredAt, ev.occurredAt,
    _appendEvidence(cur && cur.evidence_json, ev.eventId), p.fingerprint, ev.receivedAt]);
  // Build 11E: stated relationship to Nick (NULL = the note does not say).
  db.run('UPDATE wm_people SET relationship = ?, household = ? WHERE person_id = ?',
    [p.relationship || null, typeof p.household === 'boolean' ? (p.household ? 1 : 0) : null, id]);

  const wanted = new Set((Array.isArray(p.emails) ? p.emails : []).map(lower).filter((e) => e.includes('@')));
  // Addresses this person held (or contested) that the note no longer lists.
  for (const row of db.all(`SELECT * FROM wm_person_identities WHERE kind = 'email'`)) {
    const claimants = _claimantsOf(row);
    if (claimants.includes(id) && !wanted.has(row.value)) {
      _setIdentity(row.value, claimants.filter((c) => c !== id), ev);
    }
  }
  for (const email of wanted) {
    const row = db.get(`SELECT * FROM wm_person_identities WHERE kind = 'email' AND value = ?`, [email]);
    const claimants = _claimantsOf(row);
    if (claimants.length === 1 && claimants[0] === id) continue;
    _setIdentity(email, [...claimants, id], ev);
  }
}

// ── meetings ────────────────────────────────────────────────────────────────

function _status(p) {
  return p.isCancelled === true || p.showAs === 'cancelled' ? 'cancelled' : 'scheduled';
}

function _kind(p) {
  if (p.attendeesOther === true) return 'meeting';
  if (p.attendeesOther === false) return 'block';
  return 'unknown';
}

function _writeMeeting(meetingId, p, ev, prior) {
  db.run(`INSERT INTO wm_meetings (meeting_id, provider, provider_event_id, series_id, title, start_local, end_local,
            is_all_day, show_as, status, merged_into, response_status, is_organizer, kind, organizer_email, location_label,
            is_online, provenance_kind, confidence, observed_at, received_at, evidence_json, fingerprint, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'observation', 1, ?, ?, ?, ?, ?)
          ON CONFLICT(meeting_id) DO UPDATE SET series_id = excluded.series_id, title = excluded.title,
            start_local = excluded.start_local, end_local = excluded.end_local, is_all_day = excluded.is_all_day,
            show_as = excluded.show_as, status = excluded.status, merged_into = NULL,
            response_status = excluded.response_status, is_organizer = excluded.is_organizer, kind = excluded.kind,
            organizer_email = excluded.organizer_email, location_label = excluded.location_label,
            is_online = excluded.is_online, observed_at = excluded.observed_at, received_at = excluded.received_at,
            evidence_json = excluded.evidence_json, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`,
  [meetingId, p.provider, p.providerEventId, p.seriesId || null, p.title, minuteOf(p.start), minuteOf(p.end),
    p.isAllDay ? 1 : 0, p.showAs || null, _status(p), p.responseStatus || null,
    typeof p.isOrganizer === 'boolean' ? (p.isOrganizer ? 1 : 0) : null, _kind(p),
    p.organizer && p.organizer.email ? lower(p.organizer.email) : null, p.locationLabel || null,
    typeof p.isOnline === 'boolean' ? (p.isOnline ? 1 : 0) : null,
    ev.occurredAt, ev.receivedAt, _appendEvidence(prior && prior.evidence_json, ev.eventId), p.fingerprint, ev.receivedAt]);
  // Build 11C: the container, as observed. The KEY is derived (identifier
  // first, title only as a fallback); its classification is read, never stored.
  const cal = p.calendar || null;
  const key = p.provider === 'graph'
    ? require('./source-classification').GRAPH_PRIMARY
    : cal ? require('./source-classification').containerKey('calendar', { id: cal.id, title: cal.title }) : null;
  db.run('UPDATE wm_meetings SET calendar_key = ?, calendar_name = ? WHERE meeting_id = ?',
    [key, cal ? cal.title || null : (p.provider === 'graph' ? 'Outlook' : null), meetingId]);
}

function _writeParticipants(meetingId, p) {
  db.run('DELETE FROM wm_meeting_participants WHERE meeting_id = ?', [meetingId]);
  const seen = new Map();
  for (const a of Array.isArray(p.attendees) ? p.attendees : []) {
    const email = lower(a && a.email);
    if (!email.includes('@') || seen.has(email)) continue;
    seen.set(email, { email, name: a.name || null, response: a.status || null, organizer: 0 });
  }
  const org = p.organizer && lower(p.organizer.email);
  if (org && org.includes('@')) {
    const cur = seen.get(org) || { email: org, name: p.organizer.name || null, response: 'organizer' };
    seen.set(org, { ...cur, organizer: 1 });
  }
  for (const a of seen.values()) {
    const id = db.get(`SELECT person_id FROM wm_person_identities WHERE kind = 'email' AND value = ?`, [a.email]);
    const personId = id && id.person_id ? id.person_id : null;
    db.run(`INSERT INTO wm_meeting_participants (meeting_id, email, name, response, is_organizer, person_id, link_method)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [meetingId, a.email, a.name, a.response, a.organizer, personId, personId ? 'exact-email' : null]);
  }
}

function _upsertSource(provider, providerEventId, meetingId, role, rule, ev) {
  db.run(`INSERT INTO wm_meeting_sources (provider, provider_event_id, meeting_id, role, match_rule, observed_at, evidence_event_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider, provider_event_id) DO UPDATE SET meeting_id = excluded.meeting_id, role = excluded.role,
            match_rule = excluded.match_rule, observed_at = excluded.observed_at, evidence_event_id = excluded.evidence_event_id`,
  [provider, providerEventId, meetingId, role, rule, ev.occurredAt, ev.eventId]);
}

function _applyObserved(ev) {
  const p = ev.payload;
  const key = matchKey(p.start, p.title);
  const existing = db.get('SELECT * FROM wm_meeting_sources WHERE provider = ? AND provider_event_id = ?',
    [p.provider, p.providerEventId]);

  if (p.provider === 'graph') {
    const meetingId = `graph:${p.providerEventId}`;
    const prior = db.get('SELECT * FROM wm_meetings WHERE meeting_id = ?', [meetingId]);
    _writeMeeting(meetingId, p, ev, prior);
    _upsertSource('graph', p.providerEventId, meetingId, 'authoritative', 'provider-id', ev);
    _writeParticipants(meetingId, p);
    // A phone copy of this meeting that arrived first becomes a supporting
    // source of it, and its own meeting row is marked merged — never deleted.
    for (const m of db.all(`SELECT * FROM wm_meetings WHERE provider = 'apple' AND status != 'merged'`)) {
      if (matchKey(m.start_local, m.title) !== key) continue;
      db.run(`UPDATE wm_meetings SET status = 'merged', merged_into = ?, updated_at = ? WHERE meeting_id = ?`,
        [meetingId, ev.receivedAt, m.meeting_id]);
      db.run(`UPDATE wm_meeting_sources SET meeting_id = ?, role = 'supporting', match_rule = 'start+title' WHERE meeting_id = ?`,
        [meetingId, m.meeting_id]);
    }
    return;
  }

  // A non-Graph source: is this a copy of a Graph meeting?
  const graph = db.all(`SELECT * FROM wm_meetings WHERE provider = 'graph' AND status IN ('scheduled', 'cancelled')
                        AND start_local = ?`, [minuteOf(p.start)])
    .find((m) => normTitle(m.title) === normTitle(p.title));
  if (graph) {
    _upsertSource(p.provider, p.providerEventId, graph.meeting_id, 'supporting', 'start+title', ev);
    // If it used to be its own meeting (moved onto a Graph time since), it is merged now.
    if (existing && existing.meeting_id !== graph.meeting_id) {
      db.run(`UPDATE wm_meetings SET status = 'merged', merged_into = ?, updated_at = ? WHERE meeting_id = ?`,
        [graph.meeting_id, ev.receivedAt, existing.meeting_id]);
    }
    return;
  }
  const meetingId = `${p.provider}:${p.providerEventId}`;
  const prior = db.get('SELECT * FROM wm_meetings WHERE meeting_id = ?', [meetingId]);
  _writeMeeting(meetingId, p, ev, prior);
  _upsertSource(p.provider, p.providerEventId, meetingId, 'authoritative', 'provider-id', ev);
  _writeParticipants(meetingId, p);
}

function _applyRemoved(ev) {
  const p = ev.payload;
  const src = db.get('SELECT * FROM wm_meeting_sources WHERE provider = ? AND provider_event_id = ?',
    [p.provider, p.providerEventId]);
  if (!src) return;
  if (src.role === 'supporting') {
    db.run('DELETE FROM wm_meeting_sources WHERE provider = ? AND provider_event_id = ?', [p.provider, p.providerEventId]);
    return;
  }
  const m = db.get('SELECT * FROM wm_meetings WHERE meeting_id = ?', [src.meeting_id]);
  // ⚠ Only about the version we still hold. A removal of a fingerprint since
  // re-observed (it came back, or moved back into the window) changes nothing.
  if (!m || m.fingerprint !== p.lastFingerprint || m.status === 'merged') return;
  db.run(`UPDATE wm_meetings SET status = 'removed', observed_at = ?, received_at = ?, evidence_json = ?, updated_at = ?
          WHERE meeting_id = ?`,
  [ev.occurredAt, ev.receivedAt, _appendEvidence(m.evidence_json, ev.eventId), ev.receivedAt, m.meeting_id]);
}

function applyEvent(ev) {
  switch (ev.type) {
    case 'observation.person.declared': _applyPerson(ev); return obligations.relinkPeople(ev);
    case 'observation.task.observed': return obligations.applyTaskObserved(ev);
    case 'observation.task.removed': return obligations.applyTaskRemoved(ev);
    case 'observation.commitment.observed': return obligations.applyCommitmentObserved(ev);
    case 'observation.progress.evidence': return progress.applyEvidence(ev);
    case 'observation.calendar.event_observed': return _applyObserved(ev);
    case 'observation.calendar.event_removed': return _applyRemoved(ev);
    case 'observation.companion.declared': return require('./personal-world').applyCompanion(ev);
    case 'intent.goal.declared': return require('./personal-world').applyGoal(ev);
    case 'observation.presence.changed': return require('./ha-presence').applyPresence(ev);
    default: return undefined;
  }
}

bus.registerConsumer({
  name: CONSUMER,
  types: TYPES,
  transactional: true,
  replayable: true, // writes only wm_* tables
  handle: applyEvent,
  reset: () => {
    for (const t of ['wm_people', 'wm_person_identities', 'wm_identity_log', 'wm_meetings', 'wm_meeting_sources', 'wm_meeting_participants']) {
      db.run(`DELETE FROM ${t}`);
    }
    obligations.reset();
    progress.reset();
    require('./personal-world').reset();
    require('./ha-presence').reset();
  },
});

// ── reading ─────────────────────────────────────────────────────────────────

/** Wall-clock minute in NEURO's zone — the format the meeting rows hold. */
function localMinute(now = Date.now()) {
  const ms = now instanceof Date ? now.getTime() : now;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Minutes between two wall-clock minute strings (b - a). Both in one zone, so a plain difference. */
function minutesBetween(a, b) {
  const t = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16));
  return Math.round((t(b) - t(a)) / 60000);
}

function _person(id) {
  const r = id ? db.get('SELECT * FROM wm_people WHERE person_id = ?', [id]) : null;
  if (!r) return null;
  return {
    personId: r.person_id, displayName: r.display_name, notePath: r.note_path, role: r.role, team: r.team,
    directReport: r.direct_report === null ? null : r.direct_report === 1, manager: r.manager, status: r.status,
    relationship: r.relationship || null, household: r.household === null || r.household === undefined ? null : r.household === 1,
    aliases: JSON.parse(r.aliases_json), emails: db.all(`SELECT value FROM wm_person_identities WHERE person_id = ?`, [id]).map((x) => x.value),
    provenance: { kind: r.provenance_kind, confidence: r.confidence, evidence: JSON.parse(r.evidence_json), notePath: r.note_path },
    firstObservedAt: r.first_observed_at, lastObservedAt: r.last_observed_at,
  };
}

function _sourceFreshness(provider, nowMs) {
  try {
    const sh = require('./source-health');
    if (provider === 'graph') {
      const s = sh.getSource('microsoft.calendar', { now: nowMs });
      return { sourceId: 'microsoft.calendar', freshness: s.freshness, lastSuccessAt: s.lastSuccessAt || null };
    }
    const cands = ['eventkit.neuro-ios', 'eventkit.saim-ios'].map((id) => sh.getSource(id, { now: nowMs }))
      .filter((s) => s.known).sort((a, b) => String(b.lastObservedAt || '').localeCompare(String(a.lastObservedAt || '')));
    const s = cands[0];
    return s ? { sourceId: s.sourceId, freshness: s.freshness, lastSuccessAt: s.lastSuccessAt || null }
      : { sourceId: null, freshness: 'unknown', lastSuccessAt: null };
  } catch { return { sourceId: null, freshness: 'unknown', lastSuccessAt: null }; }
}

function shapeMeeting(m, nowMs = Date.now()) {
  if (!m) return null;
  const participants = db.all('SELECT * FROM wm_meeting_participants WHERE meeting_id = ? ORDER BY is_organizer DESC, email', [m.meeting_id])
    .map((p) => {
      const person = p.person_id ? db.get('SELECT display_name FROM wm_people WHERE person_id = ?', [p.person_id]) : null;
      return { email: p.email, name: p.name, response: p.response, organizer: p.is_organizer === 1,
        personId: p.person_id, displayName: person ? person.display_name : null, linkMethod: p.link_method };
    });
  const sources = db.all('SELECT * FROM wm_meeting_sources WHERE meeting_id = ? ORDER BY role, provider', [m.meeting_id])
    .map((s) => ({ provider: s.provider, providerEventId: s.provider_event_id, role: s.role, matchRule: s.match_rule,
      observedAt: s.observed_at, evidenceEventId: s.evidence_event_id }));
  return {
    meetingId: m.meeting_id,
    title: m.title,
    start: m.start_local,
    end: m.end_local,
    isAllDay: m.is_all_day === 1,
    status: m.status,
    showAs: m.show_as,
    responseStatus: m.response_status,
    isOrganizer: m.is_organizer === null ? null : m.is_organizer === 1,
    // An INFERENCE from the attendee list; `unknown` when the source could not tell.
    kind: m.kind,
    // Build 11C: what kind of diary entry this is in plain words. A phone
    // entry whose attendees could not be judged is an EVENT (a dentist, a
    // birthday), never forced into "meeting" or "block" semantics.
    entryKind: m.kind === 'meeting' ? 'meeting' : m.kind === 'block' ? 'block' : (m.provider === 'apple' ? 'event' : 'unknown'),
    provider: m.provider,
    calendar: m.calendar_key ? { key: m.calendar_key, name: m.calendar_name || null } : null,
    seriesId: m.series_id,
    location: m.location_label,
    isOnline: m.is_online === null ? null : m.is_online === 1,
    participants,
    people: participants.filter((p) => p.personId).map((p) => ({ personId: p.personId, displayName: p.displayName })),
    unresolvedParticipants: participants.filter((p) => !p.personId).length,
    sources,
    provenance: { kind: m.provenance_kind, confidence: m.confidence, evidence: JSON.parse(m.evidence_json) },
    observedAt: m.observed_at,
    receivedAt: m.received_at,
    freshness: _sourceFreshness(m.provider, nowMs),
  };
}

// Entries that occupy time: not all-day, not marked free, not cancelled/removed/merged.
// Build 16I: `free` is availability, not absence. A free entry Nick organises
// with other people in it (kind 'meeting' = attendees_other exactly true) is
// still a meeting — context-state.heldDespiteFree is the same rule on the cache.
const LIVE = `status = 'scheduled' AND is_all_day = 0 AND COALESCE(show_as, 'busy') <> 'cancelled'
  AND (COALESCE(show_as, 'busy') <> 'free' OR (kind = 'meeting' AND is_organizer = 1))`;

/** What is on right now. Real meetings first; a solo block is still an answer, labelled as one. */
function currentMeetings({ now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const t = localMinute(nowMs);
  return db.all(`SELECT * FROM wm_meetings WHERE ${LIVE} AND start_local <= ? AND end_local > ?
                 ORDER BY CASE kind WHEN 'meeting' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END, start_local`, [t, t])
    .map((m) => shapeMeeting(m, nowMs));
}

/** What starts next (after now). `kinds` narrows, e.g. ['meeting']. */
function nextMeetings({ now = Date.now(), limit = 3, kinds = null, withinMinutes = null } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const t = localMinute(nowMs);
  return db.all(`SELECT * FROM wm_meetings WHERE ${LIVE} AND start_local > ? ORDER BY start_local LIMIT 200`, [t])
    .filter((m) => !kinds || kinds.includes(m.kind))
    .filter((m) => withinMinutes === null || minutesBetween(t, m.start_local) <= withinMinutes)
    .slice(0, limit)
    .map((m) => shapeMeeting(m, nowMs));
}

/**
 * The materialised answer to "what is happening": current, next, and how much
 * of it to believe. `projection.current` false means events exist the
 * projector has not applied yet — read it as a little behind.
 */
function meetingState({ now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const st = bus.getStatus().consumers.find((c) => c.name === CONSUMER) || null;
  return {
    asOf: localMinute(nowMs),
    projection: { consumer: CONSUMER, current: !!st && st.lag === 0 && st.retrying === 0, lag: st ? st.lag : null },
    current: currentMeetings({ now: nowMs }),
    next: nextMeetings({ now: nowMs, limit: 3 }),
    nextMeeting: nextMeetings({ now: nowMs, limit: 1, kinds: ['meeting'] })[0] || null,
    sources: { graph: _sourceFreshness('graph', nowMs), apple: _sourceFreshness('apple', nowMs) },
  };
}

function getPerson(personId) { return _person(personId); }

function listPeople() {
  return db.all('SELECT person_id FROM wm_people ORDER BY display_name').map((r) => _person(r.person_id));
}

/** Exact-address lookup. null = no declared person owns it (or it is contested). */
function personByEmail(email) {
  const r = db.get(`SELECT person_id FROM wm_person_identities WHERE kind = 'email' AND value = ?`, [lower(email)]);
  return r && r.person_id ? _person(r.person_id) : null;
}

function identityConflicts() {
  return db.all(`SELECT value, conflict_json FROM wm_person_identities WHERE person_id IS NULL`)
    .map((r) => ({ email: r.value, claimants: JSON.parse(r.conflict_json || '[]') }));
}

function identityLog({ limit = 100 } = {}) {
  return db.all('SELECT * FROM wm_identity_log ORDER BY id DESC LIMIT ?', [Math.max(1, Math.min(1000, limit))]);
}

/** The previous meetings in the same series (Graph seriesMasterId), or same title, before `before`. */
function previousInSeries(meeting, { limit = 3 } = {}) {
  if (!meeting) return [];
  const rows = meeting.seriesId
    ? db.all(`SELECT * FROM wm_meetings WHERE series_id = ? AND start_local < ? AND status = 'scheduled'
              ORDER BY start_local DESC LIMIT ?`, [meeting.seriesId, meeting.start, limit])
    : db.all(`SELECT * FROM wm_meetings WHERE lower(title) = ? AND start_local < ? AND status = 'scheduled'
              ORDER BY start_local DESC LIMIT ?`, [normTitle(meeting.title), meeting.start, limit]);
  return rows.map((m) => shapeMeeting(m));
}

function fingerprintOf(obj) {
  return crypto.createHash('sha256').update(bus.canonicalJson(obj)).digest('hex').slice(0, 32);
}

module.exports = {
  CONSUMER, TYPES, applyEvent,
  localMinute, minutesBetween, matchKey, fingerprintOf,
  currentMeetings, nextMeetings, meetingState, shapeMeeting, previousInSeries,
  getPerson, listPeople, personByEmail, identityConflicts, identityLog,
};
