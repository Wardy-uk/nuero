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
 *   business  the shop / car park / venue he stopped at, from OpenStreetMap
 *             downloaded for ALL of Great Britain once and kept on the Pi
 *             (backend/scripts/fetch-uk-pois.js) — the stop never leaves the Pi
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
function nameFor(end, { at, arrival = false, saved = [], events = [], index = null, pois = null } = {}) {
  if (!end) return { name: null, source: 'none' };
  if (end.place) return { name: end.place.charAt(0).toUpperCase() + end.place.slice(1), source: 'zone' };
  if (Number.isFinite(end.lat) && Number.isFinite(end.lon)) {
    const sp = savedPlaceAt(end, saved);
    if (sp) return { name: sp.name, source: 'saved' };
    if (arrival) {
      const ev = diaryEventAt(at, events);
      if (ev) return { name: ev.subject.trim(), source: 'diary' };
    }
    const poi = pois ? pickPoi(end, pois) : null;
    if (poi) return { name: poi.name, source: 'business', distanceM: poi.distanceM };
    const loc = nearestLocality(end, index);
    if (loc) return { name: `near ${loc.name}`, source: 'locality', distanceM: Math.round(loc.d) };
  }
  return { name: null, source: 'none' };
}

// ── the business the car stopped at (OpenStreetMap, kept on the Pi) ──────────
//
// Measured on 13 Oct against real stops: "near Breadsall Hilltop" was INSIDE the
// Morrisons store outline at The Meteor Centre; "near Breadsall" was inside
// Derby Garden Centre's car park. Three rules came out of that:
//   · measure to a feature's OUTLINE (0 inside), not its centre point;
//   · group by BRAND, so pharmacy + cafe + petrol station all vote "Morrisons";
//   · an outline wider than LARGE_M (a university campus, a whole industrial
//     estate) is never the place — inside it says almost nothing. A retail park
//     the car is inside is added as context ("Morrisons, The Meteor Centre").
const POI_MAX_M = 150;              // further than this from anything named: not "at" it
const LARGE_M = 600;                // an outline bigger than this is an area, not a place
const NOISE = new Set(['parcel_locker', 'atm', 'post_box', 'bicycle_parking', 'telephone', 'vending_machine', 'waste_basket',
  'recycling', 'bench', 'charging_station', 'bus_station', 'taxi', 'motorcycle_parking', 'shelter', 'toilets', 'drinking_water']);
const MAJOR_SHOPS = new Set(['supermarket', 'department_store', 'mall', 'doityourself', 'garden_centre', 'furniture', 'hardware',
  'trade', 'electronics', 'car', 'car_repair', 'tyres', 'wholesale', 'variety_store', 'outdoor', 'sports']);
const MAJOR_AMENITY = new Set(['fuel', 'hospital', 'school', 'college', 'university', 'cinema', 'theatre', 'library', 'townhall',
  'community_centre', 'place_of_worship', 'car_wash', 'veterinary', 'dentist', 'doctors', 'clinic', 'pub', 'restaurant']);

/** How much a feature counts as "where he went". 0 = never. PURE. */
function poiWeight(p) {
  const [key, val] = String(p.kind || '').split('=');
  if (key === 'amenity' && NOISE.has(val)) return 0;
  if (key === 'shop') return MAJOR_SHOPS.has(val) ? 5 : 2;
  if (key === 'amenity') return val === 'parking' ? 3 : MAJOR_AMENITY.has(val) ? 4 : 2;
  if (key === 'leisure' || key === 'tourism') return 4;
  if (key === 'office') return 2;
  if (key === 'building') return 1;
  if (key === 'landuse') return 0; // context only (see pickPoi)
  return 1;
}

function _extentM(p) {
  if (!Number.isFinite(p.minlat)) return 0;
  return haversineM({ lat: p.minlat, lon: p.minlon }, { lat: p.maxlat, lon: p.maxlon });
}
function _distTo(pt, p) {
  if (Number.isFinite(p.minlat)) {
    const lat = Math.min(Math.max(pt.lat, p.minlat), p.maxlat);
    const lon = Math.min(Math.max(pt.lon, p.minlon), p.maxlon);
    return haversineM(pt, { lat, lon });
  }
  return haversineM(pt, p);
}

/**
 * The named place a stop was at, from nearby OSM features. PURE.
 *   pois: [{ name, brand, kind:'shop=supermarket', lat, lon, minlat?, maxlat?, minlon?, maxlon? }]
 * Returns { name, distanceM } or null.
 */
function pickPoi(point, pois = []) {
  const votes = new Map();
  let context = null;
  for (const p of pois) {
    if (!p || !p.name) continue;
    const d = _distTo(point, p);
    const ext = _extentM(p);
    if (ext > LARGE_M * 3) continue;
    // A retail park he is inside is context for whatever wins, not the answer.
    if (String(p.kind).startsWith('landuse=retail')) { if (d === 0) context = p.name; continue; }
    if (ext > LARGE_M) continue;
    if (d > POI_MAX_M) continue;
    const w = poiWeight(p);
    if (!w) continue;
    const key = (p.brand || p.name).trim();
    const v = votes.get(key) || { name: key, score: 0, d: Infinity, parking: true };
    v.score += w / (d + 15);
    v.d = Math.min(v.d, d);
    if (p.kind !== 'amenity=parking') v.parking = false;
    votes.set(key, v);
  }
  const best = [...votes.values()].sort((a, b) => b.score - a.score)[0];
  if (!best) return null;
  let name = best.name;
  if (best.parking && !/\b(car ?park|parking)\b/i.test(name)) name = `${name} car park`;
  if (context && context.toLowerCase() !== name.toLowerCase()) name = `${name}, ${context}`;
  return { name, distanceM: Math.round(best.d) };
}

function poisFile() {
  return process.env.NEURO_POIS_DB || path.join(__dirname, '..', 'data', 'pois-gb.db');
}
let _poiDb = null; // a read-only connection | false when there is no file
function poisNear(point, radiusM = LARGE_M) {
  if (_poiDb === null) {
    try {
      if (!fs.existsSync(poisFile())) { _poiDb = false; } else {
        const Database = require('better-sqlite3');
        _poiDb = new Database(poisFile(), { readonly: true, fileMustExist: true });
      }
    } catch { _poiDb = false; }
  }
  if (!_poiDb || !point || !Number.isFinite(point.lat)) return null;
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((point.lat * Math.PI) / 180));
  try {
    return _poiDb.prepare('SELECT name, brand, kind, lat, lon, minlat, maxlat, minlon, maxlon FROM poi WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?')
      .all(point.lat - dLat, point.lat + dLat, point.lon - dLon, point.lon + dLon);
  } catch { return null; }
}
function _resetPois() { if (_poiDb) { try { _poiDb.close(); } catch { /* */ } } _poiDb = null; }

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
    startLabel: nameFor(j.start, { at: j.startedAt, arrival: false, saved, index, pois: j.start && !j.start.place ? poisNear(j.start) : null }),
    endLabel: nameFor(j.end, { at: j.endedAt, arrival: true, saved, events, index, pois: j.end && !j.end.place ? poisNear(j.end) : null }),
  }));
}

function status() {
  const idx = localityIndex();
  poisNear({ lat: 54, lon: -2 }, 1); // opens the business file if it exists
  return { localities: idx ? idx.count : 0, file: idx ? 'loaded' : 'missing', businesses: _poiDb ? 'loaded' : 'missing',
    attribution: 'Place names © GeoNames (CC BY 4.0); businesses © OpenStreetMap contributors (ODbL)' };
}

module.exports = {
  DIARY_LEAD_MS, LOCALITY_MAX_M,
  nameFor, nearestLocality, savedPlaceAt, diaryEventAt, labelJourneys, status, savedPlaces, pickPoi, poiWeight,
  localityIndex, _resetIndex, _resetPois, _parseWall,
};
