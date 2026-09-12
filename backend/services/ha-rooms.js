'use strict';

// Reading the house by ROOM (12 Sep 2026).
//
// The other half of `room-offers.js`: this file READS, that file DECIDES. It
// holds no rules and makes no judgements — it turns Home Assistant into the
// shape `assess()` takes, and says honestly what it could not read.
//
// ⚠ THE TOPOLOGY IS READ, NEVER TYPED. Which lights and radiators are in the
//   living room is a fact about the house that changes when Nick moves a plug,
//   so it comes from HA's AREA REGISTRY every time. A hardcoded map is wrong
//   the first week and silently wrong for ever after — the same rule as "who
//   reports to Nick is READ, not typed" and "a catalogue declares its own
//   sections".
//
// ⚠ THE REST API HAS NO AREA ENDPOINT. `/api/states` knows nothing about
//   rooms. The only way to the registry over HTTP is `POST /api/template`
//   rendering `areas()` / `area_entities()`, which is what this does — one
//   template call for the topology, one `/api/states` call for the values,
//   joined locally. (`chr` is not available in HA's Jinja sandbox; emit JSON
//   with `to_json` rather than trying to build delimited text.)
//
// ⚠⚠ TEMPERATURE COMES FROM `climate.*` ATTRIBUTES, NEVER `sensor.*` ENTITIES.
//   Measured live: `climate.living_room_rad.attributes.current_temperature` is
//   `20.0` (°C) while `sensor.living_room_rad_current_temperature` is `68.0`
//   with `unit_of_measurement: °F`, same radiator, same second. Every Hive
//   sensor entity in this house is Fahrenheit. A reader that grabs the
//   obvious-looking sensor hands `assess()` a number that is never below the
//   comfort threshold, so the heating rule NEVER FIRES AND NEVER ERRORS.
//   `room-offers.readingLooksFahrenheit` is the second line of defence; this is
//   the first, and the reason the sensor entities are not read at all.
//
// ⚠ AN UNREACHABLE HA IS `known: false`, NEVER AN EMPTY HOUSE. `services/ha.js`
//   returns `[]` from `getStates()` on failure, which is correct for a context
//   block and catastrophic here: no rooms reads as "nothing needs anything".
//   This file does its own fetch precisely so a failure can be reported as one.

const HA_URL = (process.env.HA_URL || 'http://localhost:8123').replace(/\/$/, '');
const HA_TOKEN = process.env.HA_TOKEN || '';

// Which room NEURO/SARA thinks he is in. Written by the REST sensor in HA's
// configuration.yaml, which reads SARA's own classifier — HA does no
// classifying and neither does this.
const ROOM_SENSOR = process.env.HA_ROOM_SENSOR || 'sensor.nick_room';

const TIMEOUT_MS = Number(process.env.HA_ROOMS_TIMEOUT_MS) || 6000;

// One template render gives the whole area registry. `to_json` because HA's
// Jinja sandbox has no `chr` and delimited text is a parsing problem we do not
// need to have.
const AREA_TEMPLATE = [
  '{% set ns = namespace(out=[]) %}',
  '{% for a in areas() %}',
  "{% set ns.out = ns.out + [{'area': area_name(a), 'entities': area_entities(a)}] %}",
  '{% endfor %}',
  '{{ ns.out | to_json }}',
].join('');

function isConfigured() {
  return Boolean(HA_URL && HA_TOKEN);
}

async function haPost(path, body) {
  const res = await fetch(HA_URL + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + HA_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('HA ' + path + ' -> ' + res.status);
  return res.text();
}

async function haGet(path) {
  const res = await fetch(HA_URL + path, {
    headers: { Authorization: 'Bearer ' + HA_TOKEN },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('HA ' + path + ' -> ' + res.status);
  return res.json();
}

// --- Pure shapers -----------------------------------------------------------

/**
 * Join the area registry to the state list.
 *
 * ⚠ Only `light.*` and `climate.*` are carried. Everything else in an area is
 * noise for this purpose, and a narrow payload is what keeps the offer rule
 * from quietly growing opinions about sockets.
 */
function shapeRooms(areas, states) {
  const byId = new Map();
  for (const s of states || []) byId.set(s.entity_id, s);

  const rooms = [];
  for (const a of areas || []) {
    if (!a || !a.area) continue;
    const lights = [];
    const climate = [];
    for (const id of a.entities || []) {
      const s = byId.get(id);
      if (!s) continue;
      const domain = id.split('.')[0];
      if (domain === 'light') {
        lights.push({ entity_id: id, state: s.state });
      } else if (domain === 'climate') {
        const at = s.attributes || {};
        climate.push({
          entity_id: id,
          state: s.state,
          // ⚠ Celsius, from the climate attributes. See the header.
          currentC: typeof at.current_temperature === 'number' ? at.current_temperature : null,
          targetC: typeof at.temperature === 'number' ? at.temperature : null,
        });
      }
    }
    rooms.push({ area: a.area, lights, climate });
  }
  return rooms;
}

/**
 * Presence, as SARA reported it.
 *
 * ⚠ `subject` is hardcoded `watch` and that is not laziness — the sensor tracks
 * an Apple Watch, proven to sit on a bedroom surface reading `bedroom / sure`
 * for eight minutes while Nick showered. Nothing downstream may promote it.
 * ⚠ `unavailable` (SARA unreachable) is a FOURTH fact, distinct from `unclear`,
 * and is NOT "he has left the room".
 */
function shapePresence(state) {
  if (!state) return null;
  const raw = String(state.state || '');
  const at = state.attributes || {};
  if (raw === 'unavailable' || raw === 'unknown') {
    return { room: null, confidence: null, subject: 'watch', since: null, why: 'presence feed ' + raw };
  }
  if (raw === 'unclear') {
    return { room: null, confidence: 'unclear', subject: 'watch', since: state.last_changed || null };
  }
  return {
    room: raw,
    confidence: at.confidence || 'sure',
    subject: 'watch',
    since: state.last_changed || null,
    margin: at.margin ?? null,
  };
}

function shapeSun(state) {
  const at = (state && state.attributes) || {};
  return {
    state: state ? state.state : null,
    nextSetting: at.next_setting || null,
    nextRising: at.next_rising || null,
  };
}

// --- The read ---------------------------------------------------------------

/**
 * @returns {{ known:boolean, rooms:Array|null, presence:object|null, sun:object, gaps:string[] }}
 */
async function readHouse() {
  const gaps = [];
  if (!isConfigured()) {
    return { known: false, rooms: null, presence: null, sun: {}, gaps: ['Home Assistant is not configured (HA_URL / HA_TOKEN)'] };
  }

  let areas = null;
  let states = null;
  try {
    const raw = await haPost('/api/template', { template: AREA_TEMPLATE });
    areas = JSON.parse(raw);
  } catch (e) {
    gaps.push('could not read the room layout from Home Assistant: ' + e.message);
  }
  try {
    states = await haGet('/api/states');
  } catch (e) {
    gaps.push('could not read entity states from Home Assistant: ' + e.message);
  }

  // ⚠ Either half missing means the house was NOT read. Returning the half we
  // got would present a partial house as a whole one.
  if (!Array.isArray(areas) || !Array.isArray(states)) {
    return { known: false, rooms: null, presence: null, sun: {}, gaps };
  }

  const byId = new Map(states.map(s => [s.entity_id, s]));
  const presence = shapePresence(byId.get(ROOM_SENSOR));
  if (!byId.has(ROOM_SENSOR)) {
    gaps.push('no room-presence sensor (' + ROOM_SENSOR + ') in Home Assistant');
  }
  const sun = shapeSun(byId.get('sun.sun'));
  if (!sun.nextSetting && !sun.nextRising) gaps.push('sun.sun carries no sunrise/sunset times');

  return { known: true, rooms: shapeRooms(areas, states), presence, sun, gaps };
}

// --- Writing (the only writes NEURO makes to the house) ----------------------
//
// ⚠ NAMED DOORS, NOT A GENERIC `callService`. A general "call any HA service"
//   helper is an open proxy into a house: it can unlock a door, disarm an alarm,
//   or switch off a freezer, and every caller that ever touches it inherits that
//   reach. These two functions are the entire write surface, they take entity
//   ids and nothing else, and anything not expressible through them is not
//   something NEURO can do. Same rule as `sara/backend`'s capture bridge being a
//   named door rather than a passthrough.
//
// ⚠ The CALLER must never pass an entity id it received from a client. The
//   offer is re-derived server-side from the room reading; see `rooms.js`.

async function haService(domain, service, data) {
  const res = await fetch(HA_URL + '/api/services/' + domain + '/' + service, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + HA_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('HA ' + domain + '.' + service + ' -> ' + res.status);
  return res.json();
}

/** Turn on specific light entities. Nothing else, no brightness, no colour. */
async function turnOnLights(entityIds) {
  const ids = (entityIds || []).filter(id => typeof id === 'string' && id.startsWith('light.'));
  if (!ids.length) return { ok: false, reason: 'no light entities given' };
  if (!isConfigured()) return { ok: false, reason: 'not-configured' };
  try {
    await haService('light', 'turn_on', { entity_id: ids });
    return { ok: true, entities: ids };
  } catch (e) {
    return { ok: false, reason: e.message, entities: ids };
  }
}

/**
 * Raise (or lower) one radiator's target.
 *
 * ⚠ Celsius, because `climate.set_temperature` speaks the unit system's own
 * scale and HA is configured °C here. Passing a Fahrenheit number would set a
 * radiator to 68 degrees Celsius, which is the Fahrenheit trap in its most
 * expensive direction — so the value is range-checked before it is sent.
 */
async function setClimateTarget(entityId, celsius) {
  if (typeof entityId !== 'string' || !entityId.startsWith('climate.')) {
    return { ok: false, reason: 'not a climate entity' };
  }
  if (typeof celsius !== 'number' || !Number.isFinite(celsius) || celsius < 5 || celsius > 30) {
    return { ok: false, reason: 'target ' + celsius + ' is outside 5-30°C — refusing rather than sending it' };
  }
  if (!isConfigured()) return { ok: false, reason: 'not-configured' };
  try {
    await haService('climate', 'set_temperature', { entity_id: entityId, temperature: celsius });
    return { ok: true, entity: entityId, targetC: celsius };
  } catch (e) {
    return { ok: false, reason: e.message, entity: entityId };
  }
}

module.exports = {
  readHouse,
  turnOnLights,
  setClimateTarget,
  isConfigured,
  // pure, so each shaper pins on its own
  shapeRooms,
  shapePresence,
  shapeSun,
  AREA_TEMPLATE,
  ROOM_SENSOR,
};
