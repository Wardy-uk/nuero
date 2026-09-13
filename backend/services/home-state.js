'use strict';

// The house, in words a model can answer with. PURE (13 Sep 2026).
//
// WHY IT EXISTS. The moment SARA became the voice agent in the living room, the
// most obvious thing to say to her became the one thing she could not answer:
//
//   "what is the living room temperature"
//   → "I don't have access to your smart home system or temperature sensors.
//      That's outside my tools."
//
// ⚠⚠ AND IT WAS NOT TRUE. `ha-rooms.readHouse()` has read every room's lights
//   and climate for weeks — the CHAT TOOLS simply did not expose it. A system
//   that owns a capability and tells its user it has none is worse than one
//   that never had it, because he stops asking.
//
// Split like `pi-health.assess()`: `ha-rooms` knows how to reach the house,
// this decides what is worth saying about it, and it pins without Home
// Assistant, a network or a clock.
//
// ⚠ NO ENTITY IDS EVER LEAVE THIS FILE. `climate.living_room_rad` identifies a
//   radiator to Home Assistant and to nobody else — the `candidate-provenance`
//   rule, where a review queue became unreadable because an opaque id was
//   rendered as a label. A model handed one WILL eventually say it out loud.
//
// ⚠ CELSIUS, AND ONLY FROM THE CLIMATE ATTRIBUTES. Hive's `sensor.*` entities
//   report FAHRENHEIT while `climate.*` attributes report Celsius — measured on
//   this house, same radiator, same second: 20.0 and 68.0. `ha-rooms` does not
//   read the sensor entities at all, and `readingLooksFahrenheit` is BORROWED
//   from `room-offers` rather than re-implemented, so both places refuse the
//   same suspicious reading. A 68 answered as "sixty-eight degrees" out loud is
//   the failure this guards.

const { readingLooksFahrenheit } = require('./room-offers');

/** The median, so one odd radiator in a room of three does not become the room. */
function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function round1(n) {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/**
 * Count the light states in a room.
 *
 * ⚠ THREE STATES, NEVER TWO. A smart bulb switched off at the WALL reads
 *   `unavailable` — 7 of 14 in this house when it was first probed. `off`
 *   means she can help; `unavailable` means she CANNOT REACH IT, and folding
 *   the second into the first is how "shall I put the lights on?" becomes an
 *   offer that fails on acceptance.
 */
function countLights(lights) {
  const out = { on: 0, off: 0, unreachable: 0 };
  for (const l of lights || []) {
    const state = String((l && l.state) || '').toLowerCase();
    if (state === 'on') out.on += 1;
    else if (state === 'off') out.off += 1;
    else out.unreachable += 1;
  }
  return out;
}

/**
 * One room, as a fact rather than a row of entities.
 *
 * ⚠ A room with nothing readable in it still APPEARS, with nulls. Dropping it
 *   would let "which rooms are cold" answer confidently over a house it only
 *   partly read.
 */
function describeRoom(room) {
  const readings = (room.climate || [])
    .map(c => (c && typeof c.currentC === 'number' ? c.currentC : null))
    .filter(v => Number.isFinite(v))
    // Defence in depth: `ha-rooms` reads Celsius attributes only, and a value
    // that still looks like Fahrenheit is refused rather than answered.
    .filter(v => !readingLooksFahrenheit(v));

  const targets = (room.climate || [])
    .map(c => (c && typeof c.targetC === 'number' ? c.targetC : null))
    .filter(v => Number.isFinite(v))
    .filter(v => !readingLooksFahrenheit(v));

  const lights = countLights(room.lights);

  return {
    room: room.area,
    temperatureC: round1(median(readings)),
    targetC: round1(median(targets)),
    // How many radiators actually answered, so "the house is cold" can be told
    // apart from "one radiator answered and it is cold".
    thermostats: readings.length,
    lights,
    // A plain sentence for the room, so every surface and the model itself say
    // it the same way rather than each inventing phrasing.
    summary: roomSentence(room.area, round1(median(readings)), lights),
  };
}

function roomSentence(area, tempC, lights) {
  const bits = [];
  if (Number.isFinite(tempC)) bits.push(`${tempC}°`);
  if (lights.on > 0) bits.push(`${lights.on} light${lights.on === 1 ? '' : 's'} on`);
  else if (lights.off > 0) bits.push('lights off');
  // ⚠ Unreachable is SAID, not hidden. "I can't reach two of the lights" is a
  //   fact he can act on (a wall switch); silence about them is not.
  if (lights.unreachable > 0) {
    bits.push(`${lights.unreachable} light${lights.unreachable === 1 ? '' : 's'} I can’t reach`);
  }
  if (!bits.length) return `${area}: nothing readable`;
  return `${area}: ${bits.join(', ')}`;
}

/**
 * The whole house, for a model to answer from.
 *
 * @param {object} house `ha-rooms.readHouse()`'s shape
 * @returns {{ known, rooms, whereHeIs, othersHome, who, gaps }}
 */
function describeHouse(house) {
  // ⚠ UNREADABLE IS NOT AN EMPTY HOUSE. "I couldn't read the house" and
  //   "everything is off" are opposite facts and only one of them is an
  //   all-clear — the rule every provenance block in this codebase enforces.
  if (!house || house.known !== true || !Array.isArray(house.rooms)) {
    return {
      known: false,
      rooms: [],
      whereHeIs: null,
      othersHome: null,
      who: [],
      gaps: (house && Array.isArray(house.gaps) && house.gaps.length)
        ? house.gaps.slice()
        : ['could not read Home Assistant'],
    };
  }

  const rooms = house.rooms.map(describeRoom);

  // ⚠ PRESENCE TRACKS THE WATCH, NOT NICK — proven by a watch reading
  //   "bedroom / sure" for eight minutes while he showered. It is offered as
  //   where the WATCH is, and `unclear` is not a room.
  const p = house.presence || {};
  const room = typeof p.room === 'string' && p.room && p.room !== 'unclear' ? p.room : null;

  const hh = house.household || {};

  return {
    known: true,
    rooms,
    whereHeIs: room,
    // Three-valued: true / false / null for "the sensor could not be read".
    // Null must never be spoken as "nobody is home".
    othersHome: hh.known === true ? Boolean(hh.othersHome) : null,
    who: hh.known === true && Array.isArray(hh.who) ? hh.who.slice() : [],
    // Named, never counted — a model told "3 gaps" can say nothing useful.
    gaps: Array.isArray(house.gaps) ? house.gaps.slice() : [],
  };
}

/**
 * Is this a question about the HOUSE? PURE, deterministic, no model call.
 *
 * WARNING-WARNING  THIS EXISTS BECAUSE THE PROMPT RULE WAS NOT ENOUGH. Asked
 *   "is anyone else home", SARA answered **"No"** with NO TOOL CALL AT ALL -
 *   measured against the backend log on 13 Sep 2026, while
 *   `binary_sensor.household_others_home` read `on` with
 *   `who_is_home: ['Helen','Isaac']`. A fabricated answer about his own house,
 *   spoken aloud in the room, seconds after a correct one about the same
 *   house. Naming the house in the no-guessing rule fixed the temperature
 *   phrasings and did nothing for this one.
 *
 *   That is `checkSaraGrounding`'s lesson repeating: a prompt instruction is
 *   NECESSARY AND NOT SUFFICIENT, because a model asked for an answer can
 *   always produce one. So the house is READ BEFORE THE MODEL on a question
 *   like this and put in front of it - `event-parser`'s regex-first rule and
 *   `surfaceForQuestion`'s: instant, free, identical every time, and it works
 *   with the Pi's models offline.
 *
 * WARNING  IT ERRS TOWARDS READING. A false positive costs one local Home
 *   Assistant call and a few tokens of context; a false negative is a
 *   confident wrong answer said out loud to someone standing next to the
 *   radiator.
 */
const HOUSE_NOUNS =
  /\b(temperature|thermostat|radiator|heating|heater|warm|cold|chilly|freezing|degrees|lights?|lamp|lit)\b/i;

// WARNING  'home' and 'house' are the ambiguous ones and are matched NARROWLY.
//   "I'm working from home" and "on my way home" are not questions about the
//   house, and injecting a room-by-room reading into those would have SARA
//   answering a question nobody asked.
const PRESENCE_ASK = /\b(any\s?(one|body)|who|is\s+\w+)\b[^?]*\b(home|in|downstairs|upstairs)\b/i;
const HOUSE_ASK = /\b(the\s+)?(house|flat|downstairs|upstairs)\b/i;
const ASKING = /\b(is|are|how|what|whats|any)\b/i;

function looksLikeHouseQuestion(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (HOUSE_NOUNS.test(t)) return true;
  // A house word on its own ('the house') only counts alongside asking about it.
  if (HOUSE_ASK.test(t) && ASKING.test(t)) return true;
  return PRESENCE_ASK.test(t);
}

/**
 * The house as a short block to put in front of the model.
 *
 * WARNING  AN UNREADABLE HOUSE STILL PRODUCES A BLOCK, saying so. Silence would
 *   leave the model free to fall back on exactly the invention this exists to
 *   stop.
 */
function houseBriefing(state) {
  if (!state || state.known !== true) {
    const why = (state && state.gaps && state.gaps[0]) || 'Home Assistant did not answer';
    return 'THE HOUSE RIGHT NOW: could not be read - ' + why
      + '. Say you could not look. Do NOT say anything is on, off, warm or cold.';
  }
  const lines = state.rooms.map(r => '- ' + r.summary);
  const others = state.othersHome === true
    ? 'Others home: yes' + (state.who.length ? ' (' + state.who.join(', ') + ')' : '')
    : state.othersHome === false
      ? 'Others home: no'
      : 'Others home: COULD NOT BE READ - do not say nobody is home';
  const head = 'THE HOUSE RIGHT NOW (read just now, Celsius):';
  return [head].concat(lines).concat([others]).join(String.fromCharCode(10));
}

module.exports = {
  describeHouse,
  describeRoom,
  countLights,
  roomSentence,
  looksLikeHouseQuestion,
  houseBriefing,
};
