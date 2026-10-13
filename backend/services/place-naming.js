'use strict';

/**
 * What to call where a journey started or ended (13 Oct 2026). Nick: a drive
 * can end at the shops, a client, a Peak District car park — "somewhere" is not
 * an answer. Decided at READ time, so naming a place renames every drive there.
 *
 * Order, strongest evidence first:
 *   zone      the Home Assistant zone Life360 reported (home, Office)
 *   saved     a place Nick saved in NEURO, within its own radius
 *   diary     a calendar event (not free, not all-day) under way, or starting
 *             within 45 min, when he arrived — a client visit names itself
 *   locality  the nearest town/village from GeoNames' UK file, kept ON THE PI
 *             (Nick's call: nothing leaves the Pi; no online lookup). Within
 *             5 km it is "near X"; further, NO name rather than a misleading one
 *   null      unnamed — said as such, never "somewhere"
 *
 * ⚠ A diary match only names an ARRIVAL (`end`). A meeting running when he
 *   set off says nothing about where he set off from.
 * Place names © GeoNames, CC BY 4.0.
 */

const fs = require('fs');
const path = require('path');
const { haversineM } = require('./journey-model');

const DIARY_LEAD_MS = 45 * 60000;   // arriving up to 45 min before an event starts is arriving for it
const LOCALITY_MAX_M = 5000;        // beyond 5 km "near X" stops being true
const CELL = 0.05;                  // grid cell in degrees (~5.5 km N-S) for the locality index

function placesFile() {
  return process.env.NEURO_PLACES_FILE || path.join(__dirname, '..', 'data', 'places-gb.tsv');
}

let _index = null;          // { cells: Map, count } | false when the file is absent
function localityIndex() {
  if (_index !== null) return _index || null;
  try {
    const text = fs.readFileSync(placesFile(), 'utf8');
    const cells = new Map();
    let count = 0;
    for (const line of text.split('\n')) {
      const [name, la, lo] = line.split('\t');
      const lat = Number(la); const lon = Number(lo);
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const key = `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push({ name, lat, lon });
      count++;
    }
    _index = count ? { cells, count } : false;
  } catch {
    _index = false;
  }
  return _index || null;
}
function _resetIndex() { _index = null; }

/** Nearest locality to a point, or null. PURE given an index. */
function nearestLocality(point, index) {
  if (!index || !point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return null;
  const ci = Math.floor(point.lat / CELL);
  const cj = Math.floor(point.lon / CELL);
  let best = null;
  // ±2 cells covers well beyond LOCALITY_MAX_M in every direction at UK latitudes.
  for (let di = -2; di <= 2; di++) {
    for (let dj = -3; dj <= 3; dj++) {
      const list = index.cells.get(`${ci + di}:${cj + dj}`);
      if (!list) continue;
      for (const p of list) {
        const d = haversineM(point, p);
        if (!best || d < best.d) best = { name: p.name, d };
      }
    }
  }
  return best && best.d <= LOCALITY_MAX_M ? best : null;
}

/** A saved place whose radius contains the point (nearest first). PURE. */
function savedPlaceAt(point, saved = []) {
  let best = null;
  for (const p of saved) {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    const d = haversineM(point, { lat: p.lat, lon: p.lng });
    const r = Number.isFinite(p.radius) ? p.radius : 200;
    if (d <= r && (!best || d < best.d)) best = { name: p.name, d };
  }
  return best;
}

/** The diary event he arrived for, or null. PURE. events: [{subject,start,end,allDay,showAs}] with start/end ms. */
function diaryEventAt(arrivalMs, events = []) {
  // A solo block (Task block, Plaud admin) is busy and has nobody in it — it says
  // what he planned to DO, not where he went. Only an event with other people
  // in it, or one that states a location, can name a place.
  const live = events.filter((e) => e && !e.allDay && e.showAs !== 'free' && (e.withOthers === true || (typeof e.location === 'string' && e.location.trim()))
    && Number.isFinite(e.start) && Number.isFinite(e.end)
    && arrivalMs >= e.start - DIARY_LEAD_MS && arrivalMs <= e.end && typeof e.subject === 'string' && e.subject.trim());
  if (!live.length) return null;
  // The one that starts closest to the arrival is the one he came for.
  live.sort((a, b) => Math.abs(a.start - arrivalMs) - Math.abs(b.start - arrivalMs));
  return live[0];
}

/**
 * Name one end of a journey. PURE.
 *   end: { lat, lon, place }   at: ms of the arrival/departure   arrival: bool
 * Returns { name, source, distanceM? } — name null when nothing applies.
 */
function nameFor(end, { at, arrival = false, saved = [], events = [], index = null } = {}) {
  if (!end) return { name: null, source: 'none' };
  if (end.place) return { name: end.place.charAt(0).toUpperCase() + end.place.slice(1), source: 'zone' };
  if (Number.isFinite(end.lat) && Number.isFinite(end.lon)) {
    const sp = savedPlaceAt(end, saved);
    if (sp) return { name: sp.name, source: 'saved' };
    if (arrival) {
      const ev = diaryEventAt(at, events);
      if (ev) return { name: ev.subject.trim(), source: 'diary' };
    }
    const loc = nearestLocality(end, index);
    if (loc) return { name: `near ${loc.name}`, source: 'locality', distanceM: Math.round(loc.d) };
  }
  return { name: null, source: 'none' };
}

// ── readers ──────────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }

function savedPlaces() {
  try { const raw = _db().getState('saved_places'); const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v : []; } catch { return []; }
}

/** Calendar rows overlapping [from, to], as ms. Times are wall-clock Europe/London strings. */
function eventsBetween(fromMs, toMs) {
  try {
    const rows = _db().all('SELECT subject, start_time, end_time, is_all_day, show_as, location, attendees_other FROM calendar_cache WHERE start_time <= ? AND end_time >= ?',
      [_wall(toMs + DIARY_LEAD_MS), _wall(fromMs)]);
    return rows.map((r) => ({ subject: r.subject, start: _parseWall(r.start_time), end: _parseWall(r.end_time), allDay: !!r.is_all_day, showAs: r.show_as,
      location: r.location || null, withOthers: r.attendees_other === 1 }));
  } catch { return []; }
}
// calendar_cache holds Europe/London wall-clock strings; the Pi runs Europe/London.
function _wall(ms) { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function _parseWall(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || ''));
  if (!m) return NaN;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(String(s))) return Date.parse(s);
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
}

/** Label both ends of a list of journeys (adds startLabel / endLabel). Reads only. */
function labelJourneys(journeys = []) {
  if (!journeys.length) return journeys;
  const saved = savedPlaces();
  const index = localityIndex();
  const from = Math.min(...journeys.map((j) => j.startedAt));
  const to = Math.max(...journeys.map((j) => j.endedAt));
  const events = eventsBetween(from, to);
  return journeys.map((j) => ({
    ...j,
    startLabel: nameFor(j.start, { at: j.startedAt, arrival: false, saved, index }),
    endLabel: nameFor(j.end, { at: j.endedAt, arrival: true, saved, events, index }),
  }));
}

function status() {
  const idx = localityIndex();
  return { localities: idx ? idx.count : 0, file: idx ? 'loaded' : 'missing', attribution: 'Place names © GeoNames (CC BY 4.0)' };
}

module.exports = {
  DIARY_LEAD_MS, LOCALITY_MAX_M,
  nameFor, nearestLocality, savedPlaceAt, diaryEventAt, labelJourneys, status, savedPlaces,
  localityIndex, _resetIndex, _parseWall,
};
