'use strict';

// What SARA offers to do in a room she thinks Nick is in (12 Sep 2026).
//
// PURE. No DB, no network, no clock — `now` is passed in, the way
// `context-state`, `pi-health.assess()` and `pip-deliverables.assess()` are, so
// the judgement pins without a Home Assistant, a radiator or a time of day.
// The reader that feeds it lives in `ha-rooms.js`; this file decides.
//
// It PROPOSES. It never calls a service, and it holds no rung — `offers[].act`
// says whether this KIND of thing is allowed to act unattended and the caller
// decides what to do with that. Nothing here can turn anything on.
//
// ⚠ THE SPEC IS NICK'S, 12 Sep 2026, and the dark window is his:
//   "if I'm in a room, and time is 15 mins to sunset or later — or 15 mins to
//    sunrise or earlier — if I walk in and the lights are off, ask if I want
//    them on. [and again] if I'm in the room and we hit that time frame."
//   So it is ONE conjunction with TWO entry points — he walks into a dark room,
//   or the window arrives while he is already sitting in one. A rule written
//   only around arrival misses every evening he is already at the desk when the
//   sun goes down, which is most of them.
//
// ⚠ `sunrise - 15m` is deliberate and confirmed: the morning offer STOPS a
//   quarter of an hour BEFORE the sun is up, it does not run past it.
//
// ⚠ TEMPERATURE COMES FROM `climate.*` ATTRIBUTES, NEVER `sensor.*` ENTITIES.
//   Measured on the live house 12 Sep 2026: `climate.living_room_rad` reports
//   `current_temperature: 20.0` (°C) while `sensor.living_room_rad_current_temperature`
//   reports `68.0` with `unit_of_measurement: °F`, for the same radiator in the
//   same second — every Hive sensor entity is Fahrenheit and every climate
//   attribute is Celsius (53.6°F = 12°C and 44.6°F = 7°C match the setpoints
//   exactly). A rule fed the °F number compares 68 against 18, concludes the
//   room is warm, and NEVER FIRES AND NEVER ERRORS. `readingLooksFahrenheit`
//   below refuses such a reading by name rather than answering from it, because
//   the whole failure mode here is a confident silence.
//
// ⚠ THREE LIGHT STATES, NOT TWO. A smart bulb whose WALL SWITCH is off reads
//   `unavailable`, not `off` — 7 of the 14 lights in this house were
//   `unavailable` when probed. `off` means SARA can help and should offer;
//   `unavailable` means she CANNOT REACH IT, so she must stay quiet rather than
//   offer something that will fail. Offering to light a room she cannot light
//   is the fastest way to make her feel broken.
//
// ⚠ PRESENCE TRACKS THE WATCH, NOT NICK. Proven 31 Aug 2026: the watch sat on a
//   bedroom surface while he showered and read `bedroom / sure` confidently for
//   eight minutes. `subject` travels with every offer so nothing downstream can
//   quietly promote it, and it is the standing argument for lights ASKING
//   rather than acting — the cost of a wrong ask is a declined prompt, the cost
//   of a wrong act is a light on above a sleeping person.
//
// ⚠ ANYTHING BELOW `sure` IS NOT A ROOM. The classifier already refuses three
//   ways (uncalibrated / no match / too close to call) and renders those as
//   `unclear`; treating `unclear` as a room is how a confident wrong answer
//   gets acted on.
//
// ⚠ AN UNREADABLE ROOM IS A NAMED GAP, NEVER AN ABSENCE OF OFFERS. "I could not
//   see the living room" and "the living room needs nothing" license opposite
//   behaviour, and a quiet feed that means the first while looking like the
//   second is the failure this codebase refuses everywhere else.

// --- Tunables ---------------------------------------------------------------

// Minutes either side of the sun event. Nick's numbers, both of them.
const DARK_BEFORE_SUNSET_MIN = 15;
const DARK_BEFORE_SUNRISE_MIN = 15;

// Below this, a room he is sitting in counts as cool. **19 is Nick's number**
// (12 Sep 2026), not a derived one — comfort is a preference, and a threshold
// SARA picked would be one he has no reason to agree with.
//
// ⚠ Judged against COMFORT, never against the TRV's own current target. The
//   target is the thing an offer would CHANGE, so measuring against it makes
//   every room permanently correct and the rule can never fire. Every radiator
//   in this house sat at 7°C frost when this was written, which is exactly the
//   state that mistake would render invisible.
const COMFORT_C = 19;

// A reading above this is not a room temperature in Celsius. 45°C is hotter
// than any living space and cooler than every Fahrenheit room reading in this
// house (66–75°F), so it separates the two cleanly. See the header.
const FAHRENHEIT_SUSPICION_C = 45;

// How far a "next" sun time may sit in the past before the entity counts as
// stale. HA rolls next_setting AT sunset, so a few seconds of negative is real.
const STALE_GRACE_MS = 120_000;

// Climate modes in which a raise is meaningless or rude to propose.
const CLIMATE_UNREADY = new Set(['unavailable', 'unknown']);

// --- Pure helpers -----------------------------------------------------------

function toTime(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Is `now` inside the dark window?
 *
 * Returns { dark, known, why }. `known:false` whenever the sun times cannot be
 * read — and an unknown sun yields NO OFFER rather than a guess, because the
 * whole rule is "it is getting dark" and nothing else here can establish that.
 */
function isDark(sun, now, opts = {}) {
  const beforeSet = opts.beforeSunsetMin ?? DARK_BEFORE_SUNSET_MIN;
  const beforeRise = opts.beforeSunriseMin ?? DARK_BEFORE_SUNRISE_MIN;
  const at = toTime(now);
  if (!at) return { dark: false, known: false, why: 'no readable clock' };

  const setting = toTime(sun && sun.nextSetting);
  const rising = toTime(sun && sun.nextRising);
  const horizon = String((sun && sun.state) || '').toLowerCase();

  const msToSet = setting ? setting.getTime() - at.getTime() : null;
  const msToRise = rising ? rising.getTime() - at.getTime() : null;

  // ⚠ A "next" TIME THAT HAS ALREADY PASSED MEANS THE SUN ENTITY IS STALE,
  //   and a stale entity must not be read as an answer. Found by running the
  //   live snapshot forward through an evening: `next_setting` went negative
  //   and `msToSet <= 15 min` is TRUE OF EVERY NEGATIVE NUMBER, so every hour
  //   after dusk reported "within 15 minutes of sunset" — including the
  //   following morning. Live that is masked because HA rolls the timestamp at
  //   the moment of sunset, which is exactly the kind of masking that leaves a
  //   rule permanently wrong the day the feed stops. STALE_GRACE_MS tolerates
  //   the genuine few seconds around the rollover and nothing more.
  const staleSet = msToSet !== null && msToSet < -STALE_GRACE_MS;
  const staleRise = msToRise !== null && msToRise < -STALE_GRACE_MS;
  if (staleSet || staleRise) {
    return { dark: false, known: false, why: 'sun times are in the past — the sun entity is stale' };
  }

  // ⚠ `sun.sun`'s own state is the AUTHORITY on whether the sun is up. It is
  //   a direct fact rather than a subtraction, so it cannot be got wrong by
  //   arithmetic, by a rollover or by British Summer Time. The timestamps are
  //   used only for the 15-minute LEAD either side of it.
  if (horizon === 'below_horizon') {
    if (msToRise !== null && msToRise <= beforeRise * 60_000) {
      return { dark: false, known: true, why: 'within ' + beforeRise + ' min of sunrise — window closed' };
    }
    return { dark: true, known: true, why: 'sun is down' };
  }

  if (horizon === 'above_horizon') {
    if (msToSet !== null && msToSet <= beforeSet * 60_000) {
      return { dark: true, known: true, why: 'within ' + beforeSet + ' min of sunset' };
    }
    if (msToSet === null) {
      return { dark: false, known: false, why: 'sun is up but no sunset time to measure the lead from' };
    }
    return { dark: false, known: true, why: 'daylight' };
  }

  // No horizon state at all — fall back to the timestamps, which are now known
  // to be in the future. Between a future sunrise and a further-off sunset, we
  // are in the night half.
  if (!setting && !rising) {
    return { dark: false, known: false, why: 'sun times unreadable' };
  }
  if (msToSet !== null && msToSet <= beforeSet * 60_000) {
    return { dark: true, known: true, why: 'within ' + beforeSet + ' min of sunset' };
  }
  if (msToRise !== null && (msToSet === null || msToRise < msToSet)) {
    if (msToRise > beforeRise * 60_000) {
      return { dark: true, known: true, why: 'night — more than ' + beforeRise + ' min before sunrise' };
    }
    return { dark: false, known: true, why: 'within ' + beforeRise + ' min of sunrise — window closed' };
  }
  return { dark: false, known: true, why: 'daylight' };
}

/**
 * Fold a room's lights into one answer.
 *
 * ⚠ `off` and `unavailable` are NOT the same fact and are counted separately.
 * An offer is only made when at least one light is genuinely `off` (reachable)
 * and none is `on` — "the lights are off" means the room is dark, so one lamp
 * already lit is a room he has already sorted.
 */
function lightsState(lights = []) {
  const on = [];
  const off = [];
  const unreachable = [];
  for (const l of lights) {
    if (!l || !l.entity_id) continue;
    const s = String(l.state || '').toLowerCase();
    if (s === 'on') on.push(l.entity_id);
    else if (s === 'off') off.push(l.entity_id);
    else unreachable.push(l.entity_id);
  }
  return {
    on,
    off,
    unreachable,
    total: on.length + off.length + unreachable.length,
    allDark: on.length === 0 && off.length > 0,
    noneReachable: off.length === 0 && on.length === 0,
  };
}

/** Does this look like a Fahrenheit number wearing a Celsius label? */
function readingLooksFahrenheit(c) {
  return typeof c === 'number' && Number.isFinite(c) && c > FAHRENHEIT_SUSPICION_C;
}

/**
 * The coolest readable radiator in the room, in Celsius, or a stated reason.
 *
 * Coolest rather than average: a room with two radiators and one of them off is
 * a room with a cold half, and averaging hides exactly that.
 */
function temperatureReading(climate = []) {
  let best = null;
  const suspect = [];
  const unready = [];
  for (const c of climate) {
    if (!c || !c.entity_id) continue;
    if (CLIMATE_UNREADY.has(String(c.state || '').toLowerCase())) {
      unready.push(c.entity_id);
      continue;
    }
    const cur = typeof c.currentC === 'number' && Number.isFinite(c.currentC) ? c.currentC : null;
    if (cur === null) {
      unready.push(c.entity_id);
      continue;
    }
    if (readingLooksFahrenheit(cur)) {
      suspect.push(c.entity_id);
      continue;
    }
    if (!best || cur < best.currentC) best = { ...c, currentC: cur };
  }
  if (best) return { reading: best, known: true, suspect, unready, why: null };
  if (suspect.length) {
    return {
      reading: null,
      known: false,
      suspect,
      unready,
      why: 'temperature reading above ' + FAHRENHEIT_SUSPICION_C + '°C — refusing it as Fahrenheit rather than reading the room as warm',
    };
  }
  if (unready.length) {
    return { reading: null, known: false, suspect, unready, why: 'no radiator in this room is reporting' };
  }
  return { reading: null, known: false, suspect, unready, why: 'no radiator in this room' };
}

/** Stable, room-scoped key. The EPISODE is the caller's to close; see header. */
function offerKey(kind, area) {
  const slug = String(area || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return 'room:' + slug + ':' + kind;
}

// --- The judgement ----------------------------------------------------------

/**
 * @param {object} input
 *   rooms    [{ area, lights, climate }]            — as read from HA
 *   presence { room, confidence, subject, since }   — sensor.nick_room
 *   sun      { nextSetting, nextRising }            — sun.sun attributes
 *   household { known, othersHome, who }            — binary_sensor.household_others_home
 *   now      Date
 *   gaps     string[]                               — what the READER could not read
 * @returns { offers, gaps, considered }
 */
// --- May this act without being asked? ---------------------------------------
//
// Nick's rule, and the one thing promotion to acting was blocked on: NEVER ACT
// WHEN SOMEONE ELSE IS HOME. Until 13 Sep 2026 HA knew exactly one human, so it
// was unbuildable; `binary_sensor.household_others_home` is the signal.
//
// ⚠ THIS GATES THE UNATTENDED PATH ONLY, NEVER AN EXPLICIT PRESS. `rooms.act()`
//   has one caller — POST /:key/accept — and a press is attended by definition:
//   if Nick taps "yes" while Helen is in the room, he has asked, and refusing
//   him because a family member is in the house would be the feature arguing
//   with the person using it. What must never happen is the house acting on its
//   own around other people.
//
// ⚠ IT FAILS CLOSED, like the decision memory and unlike `attention.gate`. An
//   unreadable household is NOT an empty one. Between withholding an automatic
//   action and taking one around someone who is actually there, the expensive
//   failure is obvious, and it is the one direction that cannot be undone by
//   asking.
//
// ⚠ `act` IS THE EFFECTIVE PERMISSION AND `actRating` IS THE KIND'S OWN RATING.
//   Deliberately this way round: a caller that reads `act` and knows nothing
//   about households still gets the safe answer. Keeping `act` as the rating and
//   adding a separate permission would make the unsafe reading the shorter one,
//   which is how a gate comes to be walked past.
function householdPermitsActing(household) {
  if (!household || household.known !== true) {
    return { permitted: false, why: 'household presence unreadable — ' + ((household && household.why) || 'no reading') };
  }
  if (household.othersHome) {
    const names = Array.isArray(household.who) ? household.who.filter(Boolean) : [];
    if (!names.length) return { permitted: false, why: 'someone else is home' };
    const who = names.length === 1
      ? names[0]
      : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
    return { permitted: false, why: who + (names.length === 1 ? ' is' : ' are') + ' home' };
  }
  return { permitted: true, why: null };
}

function assess(input = {}) {
  const { rooms, presence, sun, now, household } = input;
  const options = input.options || {};
  const gaps = Array.isArray(input.gaps) ? [...input.gaps] : [];
  const offers = [];
  const considered = [];

  if (!Array.isArray(rooms)) {
    gaps.push('room readings unavailable — this is not "nothing to do"');
    return { offers, gaps, considered };
  }

  // ⚠ Presence gates EVERYTHING here. Every offer is about a room he is in.
  const room = presence && presence.confidence === 'sure' ? presence.room : null;
  const subject = (presence && presence.subject) || 'watch';
  if (!room) {
    const why = !presence
      ? 'no presence reading'
      : presence.confidence === null || presence.confidence === undefined
        ? 'presence unreadable'
        : 'presence is "' + presence.confidence + '", which is not a room';
    gaps.push(why + ' — no room offers made');
    return { offers, gaps, considered };
  }

  const here = rooms.find(r => r && slugEq(r.area, room));
  if (!here) {
    gaps.push('he is in "' + room + '" and nothing was read for that area');
    return { offers, gaps, considered };
  }

  const mayAct = householdPermitsActing(household);

  const dark = isDark(sun, now, options);
  const lights = lightsState(here.lights);
  const temp = temperatureReading(here.climate);
  considered.push({ area: here.area, dark, lights, temperature: temp });

  if (!dark.known) gaps.push('could not tell whether it is dark — ' + dark.why);

  // --- Lights -------------------------------------------------------------
  // PROPOSE only. Never acts, at any rung, until the asking has earned it.
  if (dark.known && dark.dark) {
    if (lights.allDark) {
      offers.push({
        kind: 'lights-on',
        key: offerKey('lights-on', here.area),
        area: here.area,
        act: false,
        actRating: false,
        actWhy: 'lights always ask',
        subject,
        episode: (presence && presence.since) || null,
        entities: lights.off,
        say: 'Want the ' + here.area.toLowerCase() + ' lights on?',
        why: dark.why,
      });
    } else if (lights.noneReachable && lights.total > 0) {
      // Named, not silent: "every bulb in here is off at the wall" is a fact
      // worth being able to see, and it is NOT "the room is fine".
      gaps.push(here.area + ': no light is reachable (' + lights.unreachable.length + ' off at the wall or offline) — nothing to offer');
    }
  }

  // --- Heating ------------------------------------------------------------
  // `act: true` — an objective rule, and being wrong costs pennies and is
  // invisible, unlike a light. The caller still owns the rung.
  if (temp.known && temp.reading) {
    const cur = temp.reading.currentC;
    const comfort = options.comfortC ?? COMFORT_C;
    if (cur < comfort) {
      offers.push({
        kind: 'warm-room',
        key: offerKey('warm-room', here.area),
        area: here.area,
        act: mayAct.permitted,
        actRating: true,
        actWhy: mayAct.why,
        subject,
        episode: (presence && presence.since) || null,
        entities: [temp.reading.entity_id],
        currentC: cur,
        targetC: comfort,
        say: 'The ' + here.area.toLowerCase() + ' is ' + cur.toFixed(1) + '°C. Warm it up?',
        why: 'below ' + comfort + '°C',
      });
    }
  } else if (temp.why) {
    gaps.push(here.area + ': ' + temp.why);
  }

  return { offers, gaps, considered };
}

function slugEq(a, b) {
  const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return norm(a) === norm(b);
}

module.exports = {
  assess,
  // pure helpers, exported so each pins on its own
  isDark,
  lightsState,
  temperatureReading,
  readingLooksFahrenheit,
  offerKey,
  slugEq,
  householdPermitsActing,
  // constants
  DARK_BEFORE_SUNSET_MIN,
  DARK_BEFORE_SUNRISE_MIN,
  COMFORT_C,
  FAHRENHEIT_SUSPICION_C,
  STALE_GRACE_MS,
};
