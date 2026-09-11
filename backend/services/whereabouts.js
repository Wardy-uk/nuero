'use strict';

/**
 * One phrase for where Nick is, whichever scale the answer happens to be at.
 *
 * The room sensors answer at house scale; Home Assistant's zones answer at town
 * scale. They are not competing readings — they are the same question at
 * different resolutions — so this picks the finest one that is actually known
 * and says which it used.
 *
 * `describe()` is PURE (takes the two reads, no I/O, no clock), so the rules pin
 * without a house or a Home Assistant.
 *
 * ── Why `home` is deliberately NOT rendered ─────────────────────────────────
 *
 * ⚠ THE HOME GEOFENCE IS MEASURABLY BROKEN and must not be used to say anything.
 * Measured 31 Aug 2026: `zone.home` is a 100m circle whose centre is 90m from
 * where Nick actually sits, so he lives on its edge and ordinary GPS jitter
 * reports `not_home` while he is at home — with the phone on the home wifi and
 * geocoded to his own address. Rendering "Out" from that would tell his family
 * he had left the house while he sat in the living room.
 *
 * So: a named zone that is NOT home is trustworthy (the office zone is 150m
 * wide and twenty miles away — no boundary problem), and `home` / `not_home`
 * are treated as no answer at all. That asymmetry is not tidiness, it is the
 * only honest reading of the evidence.
 *
 * ── Out of the house: the phone's town (11 Sep 2026) ────────────────────────
 *
 * Nick: "if I'm in the house, which room — if I'm out, my location from the
 * phone." So below the room and the named zone there is a third, coarsest
 * answer: the TOWN from the Companion app's reverse geocode. Three rules keep it
 * inside the refusal above rather than breaking it:
 *
 *  - ⚠ It is a PLACE NAME, never "Out". When the geofence jitters at home, the
 *    town it shows is his own town, which is still true. What the refusal above
 *    forbids is claiming he LEFT, and a town name claims no such thing.
 *  - ⚠ The TOWN, never the address. The geocoded state is a full street address;
 *    only the `Locality` attribute is ever rendered.
 *  - ⚠ STALE IS UNKNOWN. HA serves the last known value identically whether it is
 *    a minute or a month old — it once answered "Office" from a fix 33 days old —
 *    so past PHONE_STALE_HOURS (attention's bar for the same judgement) the town
 *    AND the zone render nothing.
 *
 * ⚠ It is OPT-IN by argument. VESTA calls `describe(room, zone)` with no third
 * argument and is unchanged: a town on a surface Nick's family reads is a
 * decision for that surface, not a side effect of this one.
 *
 * ⚠ And silence beats a hedge. Everything unknown returns `known: false` with a
 * reason, and every surface renders NOTHING rather than "unknown" — a banner
 * that permanently says it does not know is one nobody reads by week two.
 *
 * CommonJS — NEURO backend convention.
 */

// Zones whose name is not what a person would say out loud. Anything not listed
// renders as "At <Zone>", which is why the map is small and stays small.
const ZONE_PHRASING = {
  office: 'At Work',
  work: 'At Work',
};

// Not places. HA uses these for "in the home zone" and "in no zone at all", and
// both are unusable here for the reason above.
const NON_PLACES = new Set(['home', 'not_home', 'unknown', 'unavailable', '']);

/** "living-room" is a sensor id; a person reads "Living Room". */
function roomLabel(room) {
  if (!room) return null;
  return String(room)
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function zoneLabel(zone) {
  const key = String(zone || '').trim().toLowerCase();
  if (!key || NON_PLACES.has(key)) return null;
  if (ZONE_PHRASING[key]) return ZONE_PHRASING[key];
  // Title-case whatever the zone is actually called, so a zone Nick adds later
  // works without a code change.
  return `At ${key.charAt(0).toUpperCase() + key.slice(1)}`;
}

// Past this a phone reading is unknown, not a place. Matches attention.js.
const PHONE_STALE_HOURS = 6;

function isFresh(ageHours) {
  // An age we could not read is NOT fresh: "no idea how old" must not render.
  return Number.isFinite(ageHours) && ageHours >= 0 && ageHours <= PHONE_STALE_HOURS;
}

/** The town, or null for anything that is not a usable place name. */
function townLabel(locality) {
  const s = String(locality == null ? '' : locality).trim();
  if (!s || s.length > 60 || s.includes('\n')) return null;
  if (NON_PLACES.has(s.toLowerCase()) || /^(n\/a|none)$/i.test(s)) return null;
  return s;
}

/**
 * @param {object} room  `room-presence.read()` shape — `{ known, room, why }`
 * @param {string} zone  the HA zone name, or null
 * @param {object} [away]  opt-in town fallback — `{ presence, locality, ageHours }`
 *   from the phone. Omitted by VESTA, deliberately.
 * @returns {{known, label, kind, room, subject, why}}
 *   kind: 'room' | 'zone' | 'town' | null
 */
function describe(room, zone, away = null) {
  // Finest first. A room reading beats a zone because being in the kitchen is
  // strictly more informative than being at home, and the room sensors cannot
  // hear him at all unless he is in the house.
  if (room && room.known && room.room) {
    return {
      known: true,
      label: roomLabel(room.room),
      kind: 'room',
      room: room.room,
      // ⚠ It measured the WATCH. Carried so nothing downstream can quietly
      // promote it to a claim about where the man is.
      subject: room.subject || 'watch',
      why: null,
    };
  }

  const zl = zoneLabel(zone);
  if (zl) {
    return { known: true, label: zl, kind: 'zone', room: null, subject: 'phone', why: null };
  }

  // Coarsest: the phone's town, only when HA says he is outside the home zone,
  // and only while the geocode is fresh.
  if (away && String(away.presence || '').trim().toLowerCase() === 'not_home' && isFresh(away.ageHours)) {
    const town = townLabel(away.locality);
    if (town) {
      return { known: true, label: town, kind: 'town', room: null, subject: 'phone', why: null };
    }
  }

  return {
    known: false,
    label: null,
    kind: null,
    room: null,
    subject: null,
    // The room reader's own words where it has them — it knows whether it was
    // uncalibrated, unsure, or unable to reach SARA.
    why: (room && room.why) || 'no location signal',
  };
}

/**
 * The zone and town inputs from `ha.getPhoneStatus()`, with staleness applied.
 * PURE. A stale presence drops the ZONE too — the frozen "At Work" is exactly the
 * 33-days-old failure — and the town carries its own age, because the geocode
 * and the zone are separate entities that go quiet separately.
 */
function fromPhone(phone) {
  if (!phone) return { zone: null, away: null };
  const presenceFresh = isFresh(phone.presenceAgeHours);
  return {
    zone: presenceFresh && phone.presence ? phone.presence : null,
    away: {
      presence: presenceFresh ? phone.presence : null,
      locality: phone.geocodedLocality,
      ageHours: phone.geocodedAgeHours,
    },
  };
}

module.exports = {
  describe, roomLabel, zoneLabel, townLabel, isFresh, fromPhone,
  ZONE_PHRASING, NON_PLACES, PHONE_STALE_HOURS,
};
