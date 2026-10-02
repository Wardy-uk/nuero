'use strict';

/**
 * The household board — what a HOME screen shows when Nick is not in its room.
 *
 * Nick, 2 Oct 2026: "the others are all at home — and if I'm not in the room
 * with it — it needs to display generic useful stuff." The home screens used to
 * fall back to a clock, which every microwave in the house already shows.
 *
 * ⚠ EVERYTHING HERE IS SAFE TO SHOW TO WHOEVER IS IN THE ROOM. That is the test
 * for adding a field: Helen, Isaac or a visitor may be the one reading it. So:
 *   - the diary goes through `vesta.redactDay` — a work event is "Busy" and its
 *     subject and location are ABSENT from the object, not hidden by CSS. One
 *     redaction rule, the one VESTA already uses on the public internet; a second
 *     copy here is how the two would come to disagree about a client name.
 *   - no tasks, no queue, no email, no people notes. Ever.
 *   - the house (temperatures, lights, weather, who is home) is what anyone
 *     standing in it can already see.
 *
 * ⚠ Each section is read independently and a failed one is a NAMED gap, never
 * an empty one: "couldn't read the house" and "every light is off" send whoever
 * is looking to different conclusions.
 *
 * CommonJS — NEURO backend convention.
 */

const db = require('../db/database');
const vesta = require('./vesta');
const rooms = require('./rooms');

const MAX_EVENTS = 4;

function pad(n) { return String(n).padStart(2, '0'); }
function dateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

/**
 * The rest of today's diary, redacted. PURE given the rows and the clock.
 * ⚠ Times are compared as wall-clock STRINGS — the cache holds Europe/London
 * wall-clock times, and re-parsing them is the BST bug.
 */
function restOfDay(rows, now) {
  const nowKey = `${dateKey(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return vesta.redactDay(rows || [])
    .filter((e) => e.allDay || String(e.end || '') > nowKey)
    .slice(0, MAX_EVENTS)
    .map((e) => ({
      title: e.title,
      personal: e.personal,
      allDay: e.allDay,
      start: e.allDay ? null : String(e.start || '').slice(11, 16) || null,
      end: e.allDay ? null : String(e.end || '').slice(11, 16) || null,
    }));
}

/** The house beyond this room, in one line's worth of facts. PURE. */
function houseSummary(house, thisArea) {
  if (!house || !house.known) return { known: false, why: 'the house could not be read' };
  const here = String(thisArea || '').toLowerCase();
  const lightsOn = (house.rooms || [])
    .filter((r) => String(r.area || '').toLowerCase() !== here)
    .filter((r) => (r.lights || []).some((l) => l.state === 'on'))
    .map((r) => r.area);
  const hh = house.household || {};
  return {
    known: true,
    lightsOnElsewhere: lightsOn,
    household: hh.known
      ? { known: true, othersHome: hh.othersHome, who: Array.isArray(hh.who) ? hh.who : [] }
      : { known: false },
  };
}

/** The weather, shaped for a wall. PURE. */
function weatherLines(weather, outlookFn, now) {
  if (!weather || !weather.known) return { known: false, why: (weather && weather.why) || 'no weather' };
  let tempC = typeof weather.tempC === 'number' ? weather.tempC : null;
  // HA reports in the unit it was set up with. Convert rather than show 68 as °C.
  if (tempC !== null && /F/i.test(String(weather.unit || ''))) tempC = Math.round(((tempC - 32) * 5) / 9 * 10) / 10;
  let lines = [];
  try { lines = (outlookFn(weather, weather.hours || [], now).lines) || []; } catch { lines = []; }
  return { known: true, condition: weather.condition || null, tempC, lines: lines.slice(0, 2) };
}

async function build({ area = null, now = new Date() } = {}) {
  const gaps = [];
  const haRooms = require('./ha-rooms');

  let house = null;
  try { house = await haRooms.readHouse(); } catch (e) { gaps.push('house'); }
  const room = area ? rooms.describeArea(house, area) : null;

  let weather = { known: false, why: 'not read' };
  try {
    const { outlook } = require('../../shared/weather-outlook.cjs');
    weather = weatherLines(await haRooms.readWeather(), outlook, now);
  } catch (e) { weather = { known: false, why: e.message }; }
  if (!weather.known) gaps.push('weather');

  let diary;
  try {
    const k = dateKey(now);
    diary = { known: true, events: restOfDay(db.getCalendarEvents(`${k}T00:00:00`, `${k}T23:59:59`), now) };
  } catch (e) {
    diary = { known: false, events: [] };
    gaps.push('diary');
  }

  const houseLine = houseSummary(house, area);
  if (!houseLine.known) gaps.push('house');

  return { area, room, weather, house: houseLine, diary, gaps: [...new Set(gaps)], at: now.toISOString() };
}

module.exports = { build, restOfDay, houseSummary, weatherLines, MAX_EVENTS };
