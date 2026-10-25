'use strict';

/**
 * Home control from the family wall (25 Oct 2026).
 *
 * Nick: the wall's Home sheet controls lights, heat AND sockets. Heat = a Hive
 * boost to 21°C for one hour (Hive reverts it itself), and "Cancel boost" while
 * one runs. Sockets are household ones only — office, work, iPad and Ember are
 * excluded.
 *
 * ⚠ AN EXPLICIT ROOM MAP, NOT THE AREA REGISTRY. `ha-rooms` reads the topology
 *   from HA because it only ever OFFERS; this file WRITES, from a screen on the
 *   public internet, so what it may touch is a code constant. `allowedEntities()`
 *   rebuilds the allow-set from that constant on every request, and a body naming
 *   anything else is refused (403) before Home Assistant is asked anything.
 *
 * ⚠ NAMED DOORS ONLY: light/switch turn_on/turn_off and hive.boost_heating_on /
 *   _off. No generic service call, no brightness, no setpoints.
 *
 * ⚠ TEMPERATURES ARE climate.* `current_temperature` (°C). The Hive sensor.*
 *   entities are °F and are never read (see ha-rooms.js).
 *
 * ⚠ A WRITE IS READ BACK. HA accepting a call is not the light being on: the
 *   entity is polled (≤5 s) and the answer says `verified` true or false.
 *
 * ⚠ An unreachable HA is `known:false` with a reason, never an empty house.
 *
 * Every control is recorded in personal_ops_events (kind `wall-home-control`),
 * who / entity / action / outcome, and shows in NEURO → Activity.
 */

// ── The room map ─────────────────────────────────────────────────────────────
// `name` overrides HA's friendly_name (only where Nick gave one in the brief);
// `fallback` is used only when HA has no friendly_name.
const ROOM_MAP = Object.freeze([
  { id: 'living-room', name: 'Living room', entities: [
    { id: 'light.anwio_smart_light_3', name: 'Living room 1' },
    { id: 'light.living_room_2', fallback: 'Living room 2' },
    { id: 'light.living_room_3', fallback: 'Living room 3' },
    { id: 'climate.living_room_rad', fallback: 'Living room radiator' },
    { id: 'switch.living_room_extension_socket_1', fallback: 'TV & lamp sockets' },
  ] },
  { id: 'kitchen', name: 'Kitchen', entities: [
    { id: 'light.kitchen_1', fallback: 'Kitchen 1' },
    { id: 'light.kitchen_2', fallback: 'Kitchen 2' },
    { id: 'light.kitchen_3', fallback: 'Kitchen 3' },
    { id: 'climate.kitchen_rad', fallback: 'Kitchen radiator' },
    { id: 'switch.kitchen_side_socket', fallback: 'Kitchen side socket' },
    { id: 'switch.kitchen_sink_socket', fallback: 'Kitchen sink socket' },
  ] },
  { id: 'main-bedroom', name: 'Main bedroom', entities: [
    { id: 'light.mum', fallback: 'Bedroom light' },
    { id: 'climate.mums_rad', fallback: 'Bedroom radiator' },
    { id: 'switch.bedroom_socket_1', fallback: 'Bedroom TV' },
    { id: 'switch.bedroom_socket_2', fallback: 'Helen' },
    { id: 'switch.bedroom_socket_3', fallback: 'Charger' },
  ] },
  { id: 'isaacs-room', name: "Isaac's room", entities: [
    { id: 'light.girls', fallback: "Isaac's light" },
    { id: 'climate.girls_rad', fallback: "Isaac's radiator" },
  ] },
  { id: 'boys-room', name: "Boy's room", entities: [{ id: 'light.boy', fallback: "Boy's room light" }] },
  { id: 'lizzys-room', name: "Lizzy's room", entities: [{ id: 'climate.lizzy_s_room', fallback: "Lizzy's radiator" }] },
  { id: 'bathroom', name: 'Bathroom', entities: [
    { id: 'light.bathroom', fallback: 'Bathroom light' },
    { id: 'climate.bathroom_rad', fallback: 'Bathroom radiator' },
  ] },
  { id: 'hall-landing', name: 'Hall & landing', entities: [
    { id: 'light.hall', fallback: 'Hall' },
    { id: 'light.landing', fallback: 'Landing' },
  ] },
  { id: 'pantry', name: 'Pantry', entities: [{ id: 'light.pantry', fallback: 'Pantry' }] },
  { id: 'outside', name: 'Outside', entities: [{ id: 'light.outback', fallback: 'Outside light' }] },
  { id: 'office', name: 'Office', entities: [
    { id: 'light.office_1', fallback: 'Office 1' },
    { id: 'light.office_2', fallback: 'Office 2' },
    { id: 'light.office_3', fallback: 'Office 3' },
    { id: 'climate.office_rad', fallback: 'Office radiator' },
  ] },
]);

const ACTIONS = Object.freeze(['on', 'off', 'boost', 'boost-off', 'all-lights-off']);
const BOOST = Object.freeze({ time_period: '01:00:00', temperature: 21 });
const BOOST_MS = 3600 * 1000;
const BOOSTS_KEY = 'home_control_boosts';

const domainOf = (id) => String(id || '').split('.')[0];

/** The allow-set, rebuilt from the constant on every call. */
function allowedEntities() {
  const m = new Map();
  for (const room of ROOM_MAP) for (const e of room.entities) m.set(e.id, { ...e, room: room.id, roomName: room.name });
  return m;
}

// ── HA transport (env read at call time) ─────────────────────────────────────
function _cfg() {
  return {
    url: String(process.env.HA_URL || 'http://localhost:8123').replace(/\/$/, ''),
    token: process.env.HA_TOKEN || '',
    timeout: Number(process.env.HA_ROOMS_TIMEOUT_MS) || 6000,
  };
}
function isConfigured() { const c = _cfg(); return Boolean(c.url && c.token); }

async function _get(path) {
  const c = _cfg();
  const res = await fetch(c.url + path, { headers: { Authorization: 'Bearer ' + c.token }, signal: AbortSignal.timeout(c.timeout) });
  if (!res.ok) throw new Error('HA ' + path + ' -> ' + res.status);
  return res.json();
}
async function _service(domain, service, data) {
  const c = _cfg();
  const res = await fetch(c.url + '/api/services/' + domain + '/' + service, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(c.timeout),
  });
  if (!res.ok) throw new Error('HA ' + domain + '.' + service + ' -> ' + res.status);
  return res.json().catch(() => null);
}

// ── Boost end times (ours: HA does not say when a Hive boost ends) ───────────
function _db() { return require('../db/database'); }
function _boosts() { try { return JSON.parse(_db().getState(BOOSTS_KEY) || '{}') || {}; } catch { return {}; } }
function _setBoosts(v) { try { _db().setState(BOOSTS_KEY, JSON.stringify(v)); } catch (e) { console.warn('[HomeControl] boost end not recorded:', e.message); } }

function _hhmm(ms) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

// ── Shaping (PURE) ───────────────────────────────────────────────────────────
const _num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function switchState(s) { return s && (s.state === 'on' || s.state === 'off') ? s.state : 'unavailable'; }
function isBoosting(s) { return !!(s && s.attributes && s.attributes.preset_mode === 'boost'); }
function climateUsable(s) { return !!(s && s.state && s.state !== 'unavailable' && s.state !== 'unknown'); }
function nameFor(entry, s) {
  if (entry.name) return entry.name;
  const fn = s && s.attributes && typeof s.attributes.friendly_name === 'string' ? s.attributes.friendly_name.trim() : '';
  return fn || entry.fallback || entry.id;
}

/**
 * The rooms from a state list. PURE. An entity HA does not have is left out; a
 * room with nothing left in it is left out. `boosts` = { entity: untilMs }.
 */
function shapeRooms(states, { boosts = {}, nowMs = Date.now() } = {}) {
  const byId = new Map((states || []).map((s) => [s.entity_id, s]));
  const rooms = [];
  let lightsOn = 0;
  for (const room of ROOM_MAP) {
    const lights = []; const sockets = [];
    let climate = null; let tempC = null; let targetC = null; let boost = { on: false, untilHHMM: null };
    let any = false;
    for (const e of room.entities) {
      const s = byId.get(e.id);
      if (!s) continue;
      any = true;
      const d = domainOf(e.id);
      if (d === 'light') {
        const st = switchState(s);
        if (st === 'on') lightsOn += 1;
        lights.push({ entity: e.id, name: nameFor(e, s), state: st });
      } else if (d === 'switch') {
        sockets.push({ entity: e.id, name: nameFor(e, s), state: switchState(s) });
      } else if (d === 'climate') {
        const a = s.attributes || {};
        tempC = _num(a.current_temperature);
        targetC = _num(a.temperature);
        if (climateUsable(s)) {
          climate = e.id;
          const on = isBoosting(s);
          const until = Number(boosts[e.id]);
          boost = { on, untilHHMM: on && Number.isFinite(until) && until > nowMs ? _hhmm(until) : null };
        }
      }
    }
    if (any) rooms.push({ id: room.id, name: room.name, tempC, targetC, boost, climate, lights, sockets });
  }
  return { rooms, lightsOn };
}

/** GET /api/v/home-control. Never throws. */
async function read({ now = Date.now() } = {}) {
  if (!isConfigured()) return { ok: true, known: false, rooms: null, lightsOn: null, why: "the house isn't connected" };
  try {
    const states = await _get('/api/states');
    if (!Array.isArray(states)) return { ok: true, known: false, rooms: null, lightsOn: null, why: "can't see the house right now" };
    const { rooms, lightsOn } = shapeRooms(states, { boosts: _boosts(), nowMs: now });
    return { ok: true, known: true, rooms, lightsOn, why: null };
  } catch (e) {
    console.warn('[HomeControl] read failed:', e.message);
    return { ok: true, known: false, rooms: null, lightsOn: null, why: "can't see the house right now" };
  }
}

// ── Writes ───────────────────────────────────────────────────────────────────

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function _readbackMs() { const v = Number(process.env.HOME_CONTROL_READBACK_MS); return Number.isFinite(v) && v >= 0 ? v : 5000; }
function _pollMs() { const v = Number(process.env.HOME_CONTROL_POLL_MS); return Number.isFinite(v) && v > 0 ? v : 500; }

/** Poll until `match(states)` or the read-back window closes. */
async function _readBack(ids, match) {
  const deadline = Date.now() + _readbackMs();
  let last = null;
  for (;;) {
    try {
      last = await Promise.all(ids.map((id) => _get('/api/states/' + encodeURIComponent(id))));
      if (match(last)) return { verified: true, states: last };
    } catch { /* keep polling until the window closes */ }
    if (Date.now() >= deadline) return { verified: false, states: last };
    await _sleep(_pollMs());
  }
}

function _log(detail, { by, now }) {
  try {
    require('./personal-obligations').logEvent('wall-home-control', {
      subjectId: detail.entity ? 'entity:' + detail.entity : 'house:lights',
      actor: by ? 'vesta:' + by : 'vesta',
      detail,
      dedupeKey: `wall-home-control:${detail.entity || 'all-lights'}:${detail.action}:${now}:${Math.random().toString(36).slice(2, 8)}`,
      now,
    });
  } catch (e) { console.warn('[HomeControl] not recorded:', e.message); }
}

/**
 * POST /api/v/home-control. Returns `{ status, body }`:
 *   400 bad action / wrong action for the entity / entity given with all-lights-off
 *   403 an entity not in the room map
 *   200 { ok, verified, state, say }  (ok:false = a refusal or HA error)
 */
async function control({ entity, action } = {}, { by = null, label = null, now = Date.now() } = {}) {
  if (!ACTIONS.includes(action)) return { status: 400, body: { ok: false, error: `action must be one of ${ACTIONS.join(', ')}` } };

  if (action === 'all-lights-off') {
    if (entity !== undefined && entity !== null) return { status: 400, body: { ok: false, error: 'all-lights-off takes no entity' } };
    return { status: 200, body: await _allLightsOff({ by, label, now }) };
  }

  const allowed = allowedEntities();
  if (typeof entity !== 'string' || !allowed.has(entity)) {
    return { status: 403, body: { ok: false, error: 'That is not something the wall can control.' } };
  }
  const entry = allowed.get(entity);
  const d = domainOf(entity);
  const fits = (d === 'light' || d === 'switch') ? (action === 'on' || action === 'off') : (action === 'boost' || action === 'boost-off');
  if (!fits) return { status: 400, body: { ok: false, error: `${action} does not apply to that` } };
  if (!isConfigured()) return { status: 200, body: { ok: false, verified: false, state: null, say: "The house isn't connected." } };

  let before;
  try { before = await _get('/api/states/' + encodeURIComponent(entity)); } catch (e) {
    return { status: 200, body: { ok: false, verified: false, state: null, say: "Can't reach the house right now." } };
  }
  const name = nameFor(entry, before);
  if (d !== 'climate' && switchState(before) === 'unavailable') {
    return { status: 200, body: { ok: false, verified: false, state: 'unavailable', say: `${name} is off at the wall — switch it on there first.` } };
  }
  if (d === 'climate' && !climateUsable(before)) {
    return { status: 200, body: { ok: false, verified: false, state: 'unavailable', say: `${name} isn't answering.` } };
  }

  const detail = { entity, action, name, room: entry.roomName, by: label || by || null };
  try {
    if (d === 'climate') {
      if (action === 'boost') await _service('hive', 'boost_heating_on', { entity_id: entity, ...BOOST });
      else await _service('hive', 'boost_heating_off', { entity_id: entity });
    } else {
      await _service(d, action === 'on' ? 'turn_on' : 'turn_off', { entity_id: entity });
    }
  } catch (e) {
    console.warn('[HomeControl] write refused:', e.message);
    _log({ ...detail, ok: false, verified: false, reason: 'home assistant refused' }, { by, now });
    return { status: 200, body: { ok: false, verified: false, state: null, say: `The house didn't take that — ${name} is unchanged.` } };
  }

  if (d === 'climate') {
    const want = action === 'boost';
    const boosts = _boosts();
    if (want) boosts[entity] = now + BOOST_MS; else delete boosts[entity];
    _setBoosts(boosts);
    const rb = await _readBack([entity], ([s]) => isBoosting(s) === want);
    const state = rb.states && rb.states[0] ? (isBoosting(rb.states[0]) ? 'boost' : 'normal') : null;
    const say = rb.verified
      ? (want ? `${name} boosted to ${BOOST.temperature}° until ${_hhmm(now + BOOST_MS)}.` : `Boost cancelled on ${name}.`)
      : `Asked the house — ${name} hasn't confirmed yet.`;
    _log({ ...detail, ok: true, verified: rb.verified }, { by, now });
    return { status: 200, body: { ok: true, verified: rb.verified, state, say } };
  }

  const target = action;
  const rb = await _readBack([entity], ([s]) => switchState(s) === target);
  const state = rb.states && rb.states[0] ? switchState(rb.states[0]) : null;
  const say = rb.verified ? `${name} is ${target}.` : `Asked the house — ${name} hasn't confirmed yet.`;
  _log({ ...detail, ok: true, verified: rb.verified }, { by, now });
  return { status: 200, body: { ok: true, verified: rb.verified, state, say } };
}

async function _allLightsOff({ by, label, now }) {
  if (!isConfigured()) return { ok: false, verified: false, state: null, say: "The house isn't connected." };
  let states;
  try { states = await _get('/api/states'); } catch { return { ok: false, verified: false, state: null, say: "Can't reach the house right now." }; }
  const allowed = allowedEntities();
  const on = (Array.isArray(states) ? states : [])
    .filter((s) => allowed.has(s.entity_id) && domainOf(s.entity_id) === 'light' && s.state === 'on')
    .map((s) => s.entity_id);
  if (!on.length) return { ok: true, verified: true, state: 'off', count: 0, say: 'No lights are on.' };
  const detail = { entity: null, action: 'all-lights-off', entities: on, by: label || by || null };
  try { await _service('light', 'turn_off', { entity_id: on }); } catch (e) {
    console.warn('[HomeControl] all-lights-off refused:', e.message);
    _log({ ...detail, ok: false, verified: false, reason: 'home assistant refused' }, { by, now });
    return { ok: false, verified: false, state: null, say: "The house didn't take that — the lights are unchanged." };
  }
  const rb = await _readBack(on, (ss) => ss.every((s) => switchState(s) !== 'on'));
  _log({ ...detail, ok: true, verified: rb.verified }, { by, now });
  return {
    ok: true, verified: rb.verified, state: rb.verified ? 'off' : null, count: on.length,
    say: rb.verified ? `Turned off ${on.length} light${on.length === 1 ? '' : 's'}.` : 'Asked the house — not every light has confirmed yet.',
  };
}

module.exports = {
  ROOM_MAP, ACTIONS, BOOST, BOOSTS_KEY,
  allowedEntities, shapeRooms, switchState, isBoosting, nameFor,
  read, control, isConfigured,
};
