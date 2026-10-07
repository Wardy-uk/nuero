'use strict';

/**
 * Home Assistant presence on the event spine (Build 13G/H, 6 Oct 2026).
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * Every NEURO read of HA presence was a UI-time poll (ha.getPhoneStatus,
 * ha-rooms.readHouse, life-state): nothing reached the log, nothing had a
 * SourceHealth row, and "is Nick home / is anyone else in" existed only for
 * the instant a screen asked. A dead HA looked exactly like an empty house.
 *
 * This makes presence a SOURCE: `homeassistant.presence`, a pull source polled
 * every 2 minutes, publishing `observation.presence.changed` when an entity's
 * state changes, and projected into `wm_presence`.
 *
 * ── What it will and will not say ───────────────────────────────────────────
 *  • Only CONFIGURED entities (`HA_PRESENCE_ENTITIES`, default `person.nick`
 *    and the household sensor). No discovery, no identity merges: an HA entity
 *    is never bound to a People note here.
 *  • A person's state is reduced to a CLASS: home | away | work | zone |
 *    unavailable | unknown. A zone's NAME never enters the log (it is a place
 *    name), and no attribute — latitude, longitude, gps_accuracy, address — is
 *    ever copied. Work is recognised only from the configured work-zone list
 *    (`LIFE_WORK_ZONES`, the same list life-state uses).
 *  • The household sensor carries WHO HA says is home, as HA's own raw names.
 *    Nothing infers family, relationship or activity from co-presence.
 *  • observedAt is HA's `last_changed`; receivedAt is when NEURO read it.
 *    They are separate on purpose: a person home all day has an old
 *    last_changed and a fresh poll — that is quiet, not stale.
 *  • HA unreachable = a FAILED run (SourceHealth decides failing/stale). An
 *    entity HA reports `unavailable`/`unknown` (or does not have) is published
 *    as `unavailable` — "cannot tell", never "away".
 */

const crypto = require('crypto');
const db = require('../db/database');

const SOURCE_ID = 'homeassistant.presence';
const EVENT_TYPE = 'observation.presence.changed';
const EXPECTED_INTERVAL_MS = 2 * 60 * 1000;
const STALE_AFTER_MS = 30 * 60 * 1000;

function configuredEntities() {
  const raw = process.env.HA_PRESENCE_ENTITIES
    || `person.${process.env.HA_PERSON_ID || 'nick'},${process.env.HA_HOUSEHOLD_SENSOR || 'binary_sensor.household_others_home'}`;
  return raw.split(',').map((s) => s.trim()).filter((s) => /^(person|binary_sensor|device_tracker)\.[a-z0-9_]+$/.test(s));
}

function workZones() {
  return (process.env.LIFE_WORK_ZONES || 'Office,Work').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

const UNREADABLE = new Set(['unavailable', 'unknown', '', 'none', 'null']);

function _names(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).sort();
  if (typeof v === 'string' && v.trim()) return v.split(',').map((x) => x.trim()).filter(Boolean).sort();
  return [];
}

// 7 Oct 2026: the sensor names everyone it counts, with a role and a state
// CLASS (never a place). Anything not in that shape is dropped, not guessed.
const MEMBER_ROLES = new Set(['resident', 'visitor']);
const MEMBER_STATES = new Set(['home', 'away', 'unknown']);
function _members(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((m) => m && typeof m.name === 'string' && m.name.trim() && MEMBER_ROLES.has(m.role) && MEMBER_STATES.has(m.state))
    .map((m) => ({ name: m.name.trim().slice(0, 40), role: m.role, state: m.state }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * PURE. One HA state object → the presence observation, or null if the entity
 * is not presence-shaped. Copies nothing it does not name.
 */
function shape(entityId, st) {
  const domain = entityId.split('.')[0];
  if (!st) {
    return { entityId, subjectKind: domain === 'binary_sensor' ? 'household' : 'person', stateClass: 'unavailable', who: [], unreadable: [], unreadableVisitors: [], members: [], observedAt: null, why: 'entity not found in Home Assistant' };
  }
  const raw = String(st.state || '').trim().toLowerCase();
  const observedAt = st.last_changed || st.last_updated || null;
  if (domain === 'binary_sensor') {
    const a = st.attributes || {};
    const stateClass = raw === 'on' ? 'others-home' : raw === 'off' ? 'nobody-else' : 'unavailable';
    return { entityId, subjectKind: 'household', stateClass, who: stateClass === 'others-home' ? _names(a.who_is_home) : [],
      unreadable: _names(a.unreadable), unreadableVisitors: _names(a.unreadable_visitors), members: _members(a.members), observedAt, why: null };
  }
  let stateClass;
  if (UNREADABLE.has(raw)) stateClass = 'unavailable';
  else if (raw === 'home') stateClass = 'home';
  else if (raw === 'not_home' || raw === 'away') stateClass = 'away';
  else if (workZones().includes(raw)) stateClass = 'work';
  else stateClass = 'zone'; // a configured HA zone; its name stays out of the log
  return { entityId, subjectKind: 'person', stateClass, who: [], unreadable: [], unreadableVisitors: [], members: [], observedAt, why: null };
}

function idempotencyKey(o) {
  const members = (o.members || []).map((m) => `${m.name}:${m.role}:${m.state}`).join('|');
  const who = crypto.createHash('sha1').update(o.who.join('|') + '#' + o.unreadable.join('|') + '#' + (o.unreadableVisitors || []).join('|') + '#' + members).digest('hex').slice(0, 10);
  return `ha-presence:${o.entityId}:${o.observedAt || 'never'}:${o.stateClass}:${who}`;
}

/**
 * One poll. Never throws. `deps.fetchStates` and `deps.now` for tests.
 * @returns {{ ok, published, folded, entities, error? }}
 */
async function poll({ now = Date.now(), deps = {} } = {}) {
  const ha = require('./ha');
  const fetchStates = deps.fetchStates || ha.fetchStates;
  const configured = deps.isConfigured ? deps.isConfigured() : ha.isConfigured();
  let run = { succeed() {}, fail() {} };
  try {
    run = require('./source-health').beginSourceRun(SOURCE_ID, { system: 'homeassistant', expectedIntervalMs: EXPECTED_INTERVAL_MS, staleAfterMs: STALE_AFTER_MS });
  } catch (e) { console.warn('[HaPresence] source-health unavailable:', e.message); }
  if (!configured) { run.fail('Home Assistant is not configured', { reason: 'not-configured' }); return { ok: false, error: 'not-configured', published: 0, folded: 0, entities: [] }; }
  let states;
  try { states = await fetchStates(); } catch (e) {
    run.fail(e, { reason: 'unreachable' });
    return { ok: false, error: e.message, published: 0, folded: 0, entities: [] };
  }
  if (!Array.isArray(states) || !states.length) {
    run.fail('Home Assistant returned no states', { reason: 'empty', ambiguous: true });
    return { ok: false, error: 'empty', published: 0, folded: 0, entities: [] };
  }
  const byId = new Map(states.map((s) => [s.entity_id, s]));
  const bus = require('./event-bus');
  const receivedAt = new Date(now).toISOString();
  let published = 0; let folded = 0;
  const entities = [];
  for (const id of configuredEntities()) {
    const o = shape(id, byId.get(id));
    entities.push({ entityId: id, stateClass: o.stateClass });
    try {
      const r = bus.publishEvent({
        type: EVENT_TYPE,
        occurredAt: o.observedAt || receivedAt,
        source: { system: 'homeassistant', recordId: id },
        subject: { entityType: 'presence', entityId: id },
        idempotencyKey: idempotencyKey(o),
        payload: { entityId: id, subjectKind: o.subjectKind, state: o.stateClass, who: o.who, unreadable: o.unreadable,
          unreadableVisitors: o.unreadableVisitors || [], members: o.members || [], observedAt: o.observedAt, why: o.why },
        provenance: { kind: 'observation', confidence: o.stateClass === 'unavailable' ? 0 : 0.8 },
      });
      if (r && r.duplicate) folded += 1; else published += 1;
    } catch (e) {
      console.warn(`[HaPresence] could not publish ${id}: ${e.message}`);
    }
  }
  run.succeed({ entities: entities.length, published, folded });
  return { ok: true, published, folded, entities };
}

// ── projection (inside the world-model consumer) ─────────────────────────────

function applyPresence(ev) {
  const p = ev.payload || {};
  if (!p.entityId) return;
  const held = db.get('SELECT observed_at FROM wm_presence WHERE entity_id = ?', [p.entityId]);
  const obs = p.observedAt || ev.occurredAt;
  // An older observation never overwrites a newer one (late delivery, replay).
  if (held && held.observed_at && obs && obs < held.observed_at) return;
  // Same last_changed with a newer roster still lands (members change while
  // the on/off state does not) — the guard above is `<`, not `<=`.
  db.run(`INSERT INTO wm_presence (entity_id, subject_kind, state, who_json, unreadable_json, members_json, observed_at, received_at, event_id, why)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(entity_id) DO UPDATE SET subject_kind = excluded.subject_kind, state = excluded.state,
            who_json = excluded.who_json, unreadable_json = excluded.unreadable_json, members_json = excluded.members_json,
            observed_at = excluded.observed_at, received_at = excluded.received_at, event_id = excluded.event_id, why = excluded.why`,
  [p.entityId, p.subjectKind || 'person', p.state, JSON.stringify(p.who || []), JSON.stringify([...(p.unreadable || []), ...(p.unreadableVisitors || [])]),
    JSON.stringify(p.members || []), obs, ev.receivedAt, ev.eventId, p.why || null]);
}

function reset() { db.run('DELETE FROM wm_presence'); }

/**
 * The canonical household read: what the projection holds, judged against the
 * SOURCE's health. A healthy source with an old last_changed is current (Nick
 * has simply been home all day); a failing or stale source makes every answer
 * `unknown`, whatever the last row said.
 */
function read({ now = Date.now() } = {}) {
  let source = null;
  try { source = require('./source-health').getSource(SOURCE_ID); } catch { source = null; }
  const sourceOk = !!(source && source.known && source.state === 'healthy' && source.freshness !== 'stale');
  const rows = db.all('SELECT * FROM wm_presence ORDER BY entity_id');
  const parse = (s) => { try { return JSON.parse(s); } catch { return []; } };
  const subjects = rows.map((r) => {
    const current = sourceOk && r.state !== 'unavailable';
    return {
      entityId: r.entity_id,
      subjectKind: r.subject_kind,
      state: current ? r.state : 'unknown',
      heldState: r.state,
      who: current ? parse(r.who_json) : [],
      // A member's state is only as good as the source: unknown when it is not.
      members: parse(r.members_json || '[]').map((m) => ({ ...m, state: current ? m.state : 'unknown' })),
      unreadable: parse(r.unreadable_json),
      since: r.observed_at,
      lastRead: source ? source.lastSuccessAt || null : null,
      why: !sourceOk ? 'Home Assistant has not answered recently — this is not "away"' : r.state === 'unavailable' ? (r.why || 'Home Assistant cannot tell') : null,
    };
  });
  const nick = subjects.find((s) => s.subjectKind === 'person' && s.entityId === `person.${process.env.HA_PERSON_ID || 'nick'}`) || null;
  const household = subjects.find((s) => s.subjectKind === 'household') || null;
  return {
    at: new Date(now).toISOString(),
    source: source ? { state: source.state, freshness: source.freshness, lastSuccessAt: source.lastSuccessAt || null } : { state: 'unknown', freshness: 'unknown' },
    nick: nick ? nick.state : 'unknown',
    householdOthers: household ? household.state : 'unknown',
    householdWho: household ? household.who : [],
    householdMembers: household ? household.members : [],
    nickSince: nick ? nick.since : null,
    subjects,
  };
}

module.exports = { SOURCE_ID, EVENT_TYPE, EXPECTED_INTERVAL_MS, STALE_AFTER_MS, configuredEntities, shape, idempotencyKey, poll, applyPresence, reset, read };
