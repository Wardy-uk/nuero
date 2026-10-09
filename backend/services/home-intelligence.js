'use strict';

/**
 * Home Intelligence — Build 28 (9 Oct 2026).
 *
 * Home Assistant knows about devices; this is NEURO's attempt to understand the
 * HOME: what is happening, what is unusual, what needs Nick, and what NEURO can
 * safely do about it (nothing new — 28AC). Record: vault
 * `Projects/NEURO/NEURO-SAIM — Build 28 Home Intelligence`.
 *
 * Shape (the `pi-health.assess()` split):
 *   PURE  classifyEntity / audit / roomsFrom / heatingFrom / devicesFrom /
 *         batteriesFrom / hazardsFrom / networkFrom / appliancesFrom / energyFrom /
 *         weatherFrom / exceptionsFrom / trackExceptions / sourceHealthFrom /
 *         compose — over HA states plus HA's OWN history and long-term statistics.
 *   I/O   readRegistry / readStatistics / readBoilerHistory / refresh / read.
 *
 * ⚠ NO NEW STORE OF THE HOUSE. Persistence comes from Home Assistant's own
 *   evidence: `last_changed` for state durations (a socket offline for 40 min,
 *   a door open for an hour) and HA's hourly LONG-TERM STATISTICS for numeric
 *   persistence (three consecutive hours below target). NEURO keeps only:
 *   `home_intel_inputs` (the entity→area/device registry and the last 8 days of
 *   hourly CLIMATE means — temperature and humidity, never presence) and
 *   `home_intel_state` (the exceptions currently open, plus those resolved in
 *   the last 24h). Both are overwritten each pass — nothing accumulates.
 *
 * ⚠ PRIVACY (28AJ). Room presence is read as CURRENT state only, for context.
 *   No movement trail, no arrival/departure history, no guest tracking: nothing
 *   about where anyone is enters either stored key. Pinned by a test.
 *
 * ⚠ SILENCE IS NEVER SAFETY. A hazard class with no sensor is `absent`, never
 *   "safe"; an unreadable source keeps its exceptions OPEN as `unknown` rather
 *   than resolving them — a blind pass is not an all-clear.
 *
 * ⚠ UNITS ARE READ PER ENTITY. The 12 Sep note said Hive `sensor.*`
 *   temperatures were °F; on 9 Oct 2026 every one reported °C. `toCelsius`
 *   converts a declared °F and REFUSES an undeclared reading above 45 — the
 *   failure a fixed assumption in either direction would cause silently.
 */

const CONTRACT = 'home-intel-v1';
const MIN = 60000;
const HOUR = 3600000;

/**
 * Thresholds. Each is NEURO's rule, stated here once. None is a comfort
 * threshold: "below target" is measured against the room's OWN setpoint, and
 * "unusual" against the room's own last 7 days.
 */
const T = Object.freeze({
  // A Hive TRV at 7 °C is frost protection — the valve is effectively off.
  HEATING_ON_TARGET_C: 7.5,
  // Materially below its own setpoint, for three consecutive complete hours.
  BELOW_TARGET_C: 1.5, BELOW_TARGET_HOURS: 3,
  // Diverging from the rest of the house compared with its own usual offset.
  DIVERGE_MIN_C: 2, DIVERGE_HOURS: 3,
  // Any "relative to its own recent state" rule needs three days of baseline.
  BASELINE_MIN_HOURS: 72, BASELINE_DAYS: 7,
  // Humidity: four consecutive hours beyond the room's own p90/p10 by 5 points.
  RH_MARGIN: 5, RH_HOURS: 4,
  // Hive sensors report ON CHANGE: replayed over 2–9 Oct 2026 the Pantry sat at
  // 23.8 °C for 24 hours with nothing wrong. Two days with no update is a sensor
  // that stopped; 48 flat hours is a sensor that is stuck.
  STALE_MEASUREMENT_H: 48, STUCK_HOURS: 48,
  // Boiler runs measured 98 runs over 2–9 Oct 2026: median 6.5 min, p90 16,
  // longest 55. Long = beyond an hour, 2× its p90 AND 1.25× its longest run this
  // week, and only once there are 10 runs to compare with.
  RUN_MIN_MINUTES: 60, RUN_P90_FACTOR: 2, RUN_LONGEST_FACTOR: 1.25, RUN_MIN_SAMPLES: 10,
  DOOR_OPEN_MIN: 30, WINDOW_HEATING_MIN: 10,
  DEVICE_OFFLINE_MIN: 30, DEVICE_LONG_OFFLINE_DAYS: 7,
  // Home Assistant's own watchdog threshold (configuration.yaml), not a new one.
  BATTERY_LOW_PCT: 20,
  WAN_DOWN_MIN: 5, HUB_DOWN_MIN: 30,
  RESOLVED_KEEP_H: 24,
  REGISTRY_MAX_AGE_H: 6,
});

// Only these categories are worth a line in Activity (28AH): a fault or a source,
// never a temperature, a humidity, a door or a switch. Hazards are deliberately
// absent: Build 22's pass already logs them, and two lines for one alarm is noise.
const ACTIVITY_CATEGORIES = new Set(['heating', 'network', 'source']);

const HAZARD_CATEGORIES = Object.freeze([
  { id: 'smoke', label: 'smoke', classes: ['smoke'] },
  { id: 'carbon_monoxide', label: 'carbon monoxide', classes: ['carbon_monoxide'] },
  { id: 'gas', label: 'gas', classes: ['gas'] },
  { id: 'leak', label: 'water leak / flood', classes: ['moisture'] },
  { id: 'heat', label: 'heat alarm', classes: ['heat'] },
  { id: 'security', label: 'security / alarm', classes: ['tamper', 'safety'], domains: ['alarm_control_panel', 'siren', 'lock'] },
]);

const OPENING_CLASSES = new Set(['door', 'window', 'garage_door', 'opening']);
const APPLIANCE_WORDS = /\b(washer|washing|dryer|dishwasher|oven|freezer|fridge|refrigerator|boiler)\b/i;
const SYSTEM_DOMAINS = new Set(['automation', 'script', 'scene', 'tts', 'stt', 'conversation', 'event', 'timer', 'zone',
  'number', 'select', 'input_select', 'input_boolean', 'input_number', 'input_text', 'input_datetime', 'button', 'update',
  'todo', 'calendar', 'notify', 'assist_satellite', 'wake_word', 'image', 'camera', 'ai_task']);

// ── small pure helpers ──────────────────────────────────────────────────────

const dom = (id) => String(id || '').split('.')[0];
const attrs = (s) => (s && s.attributes) || {};
const dc = (s) => attrs(s).device_class || null;
const UNUSABLE = new Set(['unavailable', 'unknown', '']);
const usable = (s) => !!s && !UNUSABLE.has(String(s.state));
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const minutesSince = (iso, now) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? Math.max(0, (now - t) / MIN) : null; };
const label = (s) => attrs(s).friendly_name || String(s.entity_id).replace(/^[^.]+\./, '').replace(/_/g, ' ');
const round1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const isPhone = (s, meta = {}) => /iphone|ipad/i.test(s.entity_id) || /iphone|ipad/i.test(meta.device || '');

/** °C from a value and its declared unit; °F converted; an undeclared reading over 45 refused. */
function toCelsius(value, unit) {
  const v = num(value);
  if (v === null) return null;
  const u = String(unit === undefined || unit === null ? '' : unit).replace(/\s/g, '');
  if (u === '°F' || u === 'F') return round1((v - 32) * 5 / 9);
  if (u === '°C' || u === 'C') return v;
  if (u === '' && v <= 45) return v; // climate attributes carry no unit; HA runs metric
  return null;
}

function percentile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = Math.min(v.length - 1, Math.max(0, Math.round((p / 100) * (v.length - 1))));
  return v[i];
}
const median = (values) => percentile(values, 50);
function mad(values) {
  const m = median(values);
  if (m === null) return null;
  return median(values.map((x) => Math.abs(x - m)));
}

/**
 * Dew point (°C) — Magnus–Tetens with Sonntag (1990) constants b=17.62,
 * c=243.12 °C, valid −45..60 °C. Deterministic; CONTEXT ONLY — it never feeds
 * an exception and never becomes a mould or damp claim (28J).
 */
function dewPoint(tC, rh) {
  const t = num(tC); const h = num(rh);
  if (t === null || h === null || h <= 0 || h > 100 || t < -45 || t > 60) return null;
  const g = Math.log(h / 100) + (17.62 * t) / (243.12 + t);
  return round1((243.12 * g) / (17.62 - g));
}

// ── 28A/28B: classification and audit ───────────────────────────────────────

/**
 * PURE. One entity → { category, role, alerting, cadenceH, why }.
 *   role: 'inference' (usable to infer household state) | 'context' |
 *         'redundant' (another entity already carries it) | 'noise' | 'system'
 *   alerting: whether it may ever drive an exception.
 * `meta` = { area, device, manufacturer, boiler } from the registry.
 */
function classifyEntity(s, meta = {}) {
  const id = s.entity_id;
  const d = dom(id);
  const cls = dc(s);
  const out = (category, role, alerting, why, cadenceH = null) => ({ category, role, alerting, why, cadenceH });
  if (SYSTEM_DOMAINS.has(d) || /^sensor\.backup_/.test(id)) return out('system', 'system', false, 'Home Assistant housekeeping');
  if (d === 'person') return out('people', 'inference', false, 'a household person (presence)');
  if (d === 'device_tracker') {
    if (/life360/.test(id)) return out('people', 'redundant', false, 'feeds person.* — the person entity is the authority');
    return out('network', 'noise', false, 'a device on the router — never a resident, never household intelligence');
  }
  if (isPhone(s, meta)) return out('phone', 'noise', false, "Nick's phone telemetry — its own source (health, location), not the house");
  if (/^sensor\.watchdog_/.test(id)) return out('device_health', 'context', false, "Home Assistant's own device watchdog");
  if (d === 'binary_sensor' && (cls === 'occupancy' || cls === 'presence')) return out('people', 'inference', false, 'household presence');
  if (d === 'sensor' && /_room$/.test(id) && !cls) return out('room_presence', 'context', false, "SAiM's room classifier (current only)");
  if (d === 'binary_sensor' && cls === 'motion') return out('room_presence', 'context', false, 'motion — current activity only, never a trail');
  for (const h of HAZARD_CATEGORIES) {
    if ((h.domains || []).includes(d) || (d === 'binary_sensor' && h.classes.includes(cls))) return out(`hazard:${h.id}`, 'inference', true, `${h.label} sensor`);
  }
  if (d === 'binary_sensor' && OPENING_CLASSES.has(cls)) return out('openings', 'inference', true, 'door / window contact');
  if (d === 'climate') return out('heating', 'inference', true, meta.boiler ? 'the boiler thermostat (Hive)' : 'radiator valve (setpoint + reading)', 2);
  if (meta.heatingDevice && d === 'binary_sensor' && /_state$/.test(id)) return out('heating', 'inference', true, 'call for heat');
  if (meta.heatingDevice && (/_boost$/.test(id) || /_mode$/.test(id) || /_target_temperature$/.test(id) || /_heat_on_demand$/.test(id))) return out('heating', 'redundant', false, 'the climate entity carries it');
  if (/weather_station/.test(id) || d === 'weather' || d === 'sun' || /^sensor\.sun_/.test(id)) return out('weather', 'context', false, 'outdoor / forecast');
  if (d === 'binary_sensor' && cls === 'connectivity') {
    if (/wan/.test(id)) return out('network', 'inference', true, "router's internet link");
    if (/hub/.test(id)) return out('network', 'inference', true, 'heating hub (Hive) — heating control depends on it');
    return out('network', 'noise', false, 'an integration connectivity flag');
  }
  if (d === 'sensor' && (cls === 'data_rate' || /devices_connected|external_ip/.test(id))) return out('network', 'noise', false, 'router telemetry — not household state');
  if (cls === 'battery' || /_battery_state$/.test(id)) return out('batteries', 'inference', true, 'device battery', 24 * 30);
  if (cls === 'temperature') return out(meta.heatingDevice ? 'heating' : 'temperature', meta.heatingDevice ? 'redundant' : 'inference', !meta.heatingDevice, meta.heatingDevice ? 'the climate entity carries it' : 'room temperature', T.STALE_MEASUREMENT_H);
  if (cls === 'humidity') return out('humidity', 'inference', true, 'room humidity', T.STALE_MEASUREMENT_H);
  if (cls === 'energy' || cls === 'power') return out('energy', 'context', false, 'a metered plug');
  if (APPLIANCE_WORDS.test(`${id} ${attrs(s).friendly_name || ''} ${meta.device || ''}`) && d !== 'climate') return out('appliances', 'inference', true, 'an appliance');
  if (d === 'light') return out('lights', 'context', false, 'a light (unavailable usually means off at the wall)');
  if (d === 'switch') return out('plugs', 'context', false, cls === 'outlet' ? 'a smart socket' : 'a switch');
  if (d === 'media_player' || d === 'remote') return out('media', 'noise', false, 'TV / speaker — not an appliance state worth modelling');
  if (d === 'sensor' && cls === 'enum') return out('unclassified', 'noise', false, 'an enum sensor with no household meaning found');
  return out('unclassified', 'noise', false, 'no household meaning found');
}

/** PURE. Registry map + states → per-entity meta (area, device, boiler, heatingDevice). */
function metaFor(states, registry = {}, boilerId = 'climate.thermostat_1') {
  const reg = registry || {};
  const devOf = (id) => (reg[id] && reg[id].device) || null;
  const heatingDevices = new Set();
  const boilerDevice = devOf(boilerId);
  for (const s of states || []) if (dom(s.entity_id) === 'climate' && devOf(s.entity_id)) heatingDevices.add(devOf(s.entity_id));
  const out = {};
  for (const s of states || []) {
    const r = reg[s.entity_id] || {};
    const dev = r.device || null;
    out[s.entity_id] = {
      area: r.area || null, device: dev, manufacturer: r.manufacturer || null,
      heatingDevice: !!(dev && heatingDevices.has(dev)),
      boiler: s.entity_id === boilerId || !!(dev && boilerDevice && dev === boilerDevice),
    };
  }
  return out;
}

/** PURE. 28A — count by category, what is meaningful, what is noise, freshness, gaps. */
function audit(states, meta, now = Date.now()) {
  const byCategory = {};
  const roles = { inference: 0, context: 0, redundant: 0, noise: 0, system: 0 };
  const freshness = {};
  const noisy = {};
  for (const s of states || []) {
    const c = classifyEntity(s, meta[s.entity_id] || {});
    byCategory[c.category] = (byCategory[c.category] || 0) + 1;
    roles[c.role] = (roles[c.role] || 0) + 1;
    if (c.role === 'noise' || c.role === 'redundant') noisy[c.why] = (noisy[c.why] || 0) + 1;
    if (c.role === 'inference') {
      const f = freshness[c.category] || (freshness[c.category] = { readable: 0, unavailable: 0, stale: 0 });
      if (!usable(s)) f.unavailable += 1;
      else if (c.cadenceH && minutesSince(s.last_updated, now) > c.cadenceH * 60) f.stale += 1;
      else f.readable += 1;
    }
  }
  const has = (cat) => (byCategory[cat] || 0) > 0;
  const gaps = [];
  for (const h of HAZARD_CATEGORIES) if (!has(`hazard:${h.id}`)) gaps.push(`no ${h.label} sensor`);
  if (!has('openings')) gaps.push('no door or window sensor');
  if (!has('appliances')) gaps.push('no appliance reports a useful state');
  return {
    total: (states || []).length, byCategory, roles, freshness,
    noisy: Object.entries(noisy).map(([why, n]) => ({ why, n })).sort((a, b) => b.n - a.n),
    gaps,
  };
}

// ── statistics helpers (HA long-term hourly statistics) ─────────────────────

/** rows [{start, mean, min, max}] → complete hours, oldest first, before `now`. */
function hoursOf(rows, now) {
  return (rows || [])
    .map((r) => ({ t: typeof r.start === 'number' ? (r.start > 1e12 ? r.start : r.start * 1000) : Date.parse(r.start), mean: num(r.mean), min: num(r.min), max: num(r.max) }))
    .filter((h) => Number.isFinite(h.t) && h.mean !== null && h.t + HOUR <= now)
    .sort((a, b) => a.t - b.t);
}
const lastN = (hours, n) => (hours.length >= n ? hours.slice(-n) : null);
/** The last n hours must be CONSECUTIVE — a gap is not persistence. */
function consecutive(hours) { for (let i = 1; i < hours.length; i++) if (hours[i].t - hours[i - 1].t !== HOUR) return false; return true; }

// ── 28E/28F/28AE: rooms ──────────────────────────────────────────────────────

const DEFAULT_ROOM_AREAS = { study: 'Office', bedroom: "Mum's Room", 'living room': 'Living Room', kitchen: 'Kitchen' };
function roomAreaMap(env = process.env) {
  const raw = env.HOME_ROOM_AREAS;
  if (!raw) return DEFAULT_ROOM_AREAS;
  const out = {};
  for (const pair of String(raw).split(';')) { const [k, v] = pair.split('='); if (k && v) out[k.trim().toLowerCase()] = v.trim(); }
  return out;
}

/**
 * PURE. Per HA area: temperature (best source, said), humidity, dew point,
 * heating (setpoint, valve demand), openings, and CURRENT presence context.
 */
function roomsFrom(states, meta, { now = Date.now(), nickRoom = null, roomAreas = DEFAULT_ROOM_AREAS } = {}) {
  const areas = new Map();
  const room = (a) => { if (!areas.has(a)) areas.set(a, { area: a, temps: [], rh: [], trvs: [], boiler: null, openings: [], motion: [] }); return areas.get(a); };
  const demandByDevice = new Map();
  for (const s of states || []) {
    const m = meta[s.entity_id] || {};
    if (m.heatingDevice && dom(s.entity_id) === 'binary_sensor' && /_state$/.test(s.entity_id)) demandByDevice.set(m.device, usable(s) ? s.state === 'on' : null);
  }
  for (const s of states || []) {
    const m = meta[s.entity_id] || {};
    if (!m.area) continue;
    const c = classifyEntity(s, m);
    const r = room(m.area);
    const at = attrs(s);
    if (dom(s.entity_id) === 'climate') {
      const entry = {
        id: s.entity_id, label: label(s), mode: usable(s) ? s.state : null, action: at.hvac_action || null,
        currentC: toCelsius(at.current_temperature, ''), targetC: toCelsius(at.temperature, ''),
        demand: demandByDevice.has(m.device) ? demandByDevice.get(m.device) : null,
        readable: usable(s), ageMin: round1(minutesSince(s.last_updated, now)), device: m.device,
      };
      if (m.boiler) r.boiler = entry; else r.trvs.push(entry);
    } else if (c.category === 'temperature' && c.role === 'inference') {
      r.temps.push({ id: s.entity_id, c: usable(s) ? toCelsius(s.state, at.unit_of_measurement) : null, device: m.device, ageMin: round1(minutesSince(s.last_updated, now)), source: 'room sensor' });
    } else if (c.category === 'humidity') {
      r.rh.push({ id: s.entity_id, pct: usable(s) ? num(s.state) : null, device: m.device, ageMin: round1(minutesSince(s.last_updated, now)) });
    } else if (c.category === 'openings') {
      r.openings.push(openingOf(s, m, now));
    } else if (dom(s.entity_id) === 'binary_sensor' && dc(s) === 'motion') {
      r.motion.push(usable(s) ? s.state === 'on' : null);
    }
  }
  const nickArea = nickRoom ? roomAreas[String(nickRoom).toLowerCase()] || null : null;
  const out = [];
  for (const r of areas.values()) {
    // An area holding only a TV or a light says nothing about the room.
    if (!r.temps.length && !r.rh.length && !r.trvs.length && !r.boiler && !r.openings.length && !r.motion.length) continue;
    // Room temperature: a standalone sensor beats a radiator valve (the valve
    // sits on the radiator and reads its warmth while heating).
    const sensorT = r.temps.find((t) => t.c !== null);
    const trvT = r.trvs.find((t) => t.currentC !== null);
    const boilerT = r.boiler && r.boiler.currentC !== null ? r.boiler : null;
    const temperature = sensorT ? { c: sensorT.c, source: 'room sensor', id: sensorT.id, ageMin: sensorT.ageMin }
      : trvT ? { c: trvT.currentC, source: 'radiator valve (reads the radiator’s warmth while heating)', id: trvT.id, ageMin: trvT.ageMin }
        : boilerT ? { c: boilerT.currentC, source: 'heating thermostat', id: boilerT.id, ageMin: boilerT.ageMin } : null;
    const rh = r.rh.find((h) => h.pct !== null) || null;
    // Dew point only from one device measuring both — never two sensors stitched together.
    const sameDevice = rh && sensorT && rh.device && rh.device === sensorT.device;
    const targets = r.trvs.filter((t) => t.targetC !== null && t.mode !== 'off').map((t) => t.targetC);
    const target = targets.length ? Math.max(...targets) : null;
    const heating = r.trvs.length ? {
      valves: r.trvs.length,
      targetC: target, wanted: target !== null && target > T.HEATING_ON_TARGET_C,
      demand: r.trvs.some((t) => t.demand === true) ? true : r.trvs.every((t) => t.demand === false) ? false : null,
      modes: [...new Set(r.trvs.map((t) => t.mode).filter(Boolean))],
    } : null;
    const motion = !r.motion.length ? null : r.motion.some((m) => m === true) ? 'active' : r.motion.every((m) => m === false) ? 'quiet' : null;
    out.push({
      area: r.area,
      temperature, humidity: rh ? { pct: rh.pct, id: rh.id, ageMin: rh.ageMin } : null,
      dewPointC: sameDevice ? dewPoint(sensorT.c, rh.pct) : null,
      heating, boiler: r.boiler ? { label: r.boiler.label, action: r.boiler.action } : null,
      openings: r.openings,
      presence: { nickHere: nickArea ? nickArea === r.area : null, motion },
    });
  }
  return out.sort((a, b) => a.area.localeCompare(b.area));
}

function openingOf(s, m, now) {
  const kind = dc(s) === 'window' ? 'window' : dc(s) === 'garage_door' ? 'garage' : dc(s) === 'door' ? 'door' : 'opening';
  const state = !usable(s) ? 'unknown' : s.state === 'on' ? 'open' : 'closed';
  return { id: s.entity_id, label: label(s), kind, state, forMin: state === 'open' ? round1(minutesSince(s.last_changed, now)) : null, area: m.area || null, device: m.device || null, exterior: null };
}

// ── 28G/28H: heating ────────────────────────────────────────────────────────

/** PURE. history [{state, last_changed}] → completed and current on-runs. */
function runsFrom(series, now = Date.now()) {
  const runs = [];
  let start = null;
  for (const row of series || []) {
    const t = Date.parse(row.last_changed || row.last_updated || '');
    if (!Number.isFinite(t)) continue;
    if (row.state === 'on' && start === null) start = t;
    else if (row.state !== 'on' && start !== null) { runs.push({ start, end: t, minutes: (t - start) / MIN }); start = null; }
  }
  return { runs, current: start !== null ? { start, minutes: (now - start) / MIN } : null };
}

/**
 * PURE. Is the heating on, which rooms are calling, how long has the boiler
 * run, and how does that compare with its own last week.
 */
function heatingFrom(states, rooms, { boilerId = 'climate.thermostat_1', boilerHistory = null, now = Date.now() } = {}) {
  const byId = new Map((states || []).map((s) => [s.entity_id, s]));
  const b = byId.get(boilerId);
  const stateBin = [...byId.values()].find((s) => s.entity_id === boilerId.replace(/^climate\./, 'binary_sensor.') + '_state');
  const known = usable(b);
  const action = known ? attrs(b).hvac_action || null : null;
  const firing = !known ? null : action === 'heating' || (usable(stateBin) && stateBin.state === 'on');
  const calling = (rooms || []).filter((r) => r.heating && r.heating.demand === true).map((r) => r.area);
  const wanted = (rooms || []).filter((r) => r.heating && r.heating.wanted).map((r) => r.area);
  let runs = null;
  if (Array.isArray(boilerHistory)) {
    const { runs: done, current } = runsFrom(boilerHistory, now);
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const todayMin = done.filter((r) => r.end > dayStart.getTime()).reduce((a, r) => a + (r.end - Math.max(r.start, dayStart.getTime())) / MIN, 0) + (current ? (now - Math.max(current.start, dayStart.getTime())) / MIN : 0);
    const lens = done.map((r) => r.minutes);
    runs = {
      completed: done.length, p90Minutes: round1(percentile(lens, 90)), medianMinutes: round1(median(lens)), longestMinutes: lens.length ? round1(Math.max(...lens)) : null,
      currentMinutes: current ? round1(current.minutes) : null, todayMinutes: Math.round(todayMin),
    };
  }
  return {
    known, firing, action, calling, wanted, runs,
    summary: !known ? 'Can’t read the boiler thermostat.' : firing ? `Heating is on${calling.length ? ` — ${calling.join(', ')} calling for heat` : ''}.` : `Heating is idle${wanted.length ? ` (${wanted.length} room${wanted.length === 1 ? '' : 's'} with a setpoint above frost protection)` : ''}.`,
  };
}

// ── 28M/28N: devices and batteries ──────────────────────────────────────────

const DEVICE_DOMAINS = new Set(['sensor', 'binary_sensor', 'switch', 'climate']);

/**
 * PURE. Devices grouped from their entities. Offline = EVERY readable-domain
 * entity of the device unavailable/unknown, for at least DEVICE_OFFLINE_MIN
 * (HA's own last_changed). Healthy devices are counted, never listed.
 * Lights, TVs, phones and router clients are not judged: a bulb switched off at
 * the wall is unavailable and healthy.
 */
function devicesFrom(states, meta, { now = Date.now(), watchdog = null } = {}) {
  const devices = new Map();
  for (const s of states || []) {
    const m = meta[s.entity_id] || {};
    if (!m.device || !DEVICE_DOMAINS.has(dom(s.entity_id)) || isPhone(s, m)) continue;
    const c = classifyEntity(s, m);
    if (c.role === 'system') continue;
    const d = devices.get(m.device) || { device: m.device, area: m.area, entities: [] };
    if (!d.area && m.area) d.area = m.area;
    d.entities.push(s);
    devices.set(m.device, d);
  }
  const offline = []; const longOffline = []; let healthy = 0; let stale = 0; const staleList = [];
  for (const d of devices.values()) {
    const down = d.entities.every((s) => !usable(s));
    if (down) {
      const since = Math.max(...d.entities.map((s) => Date.parse(s.last_changed || '') || 0));
      const forMin = since ? (now - since) / MIN : null;
      if (forMin === null || forMin < T.DEVICE_OFFLINE_MIN) { healthy += 1; continue; } // a blip, not a finding
      const row = { device: d.device, area: d.area || null, since: new Date(since).toISOString(), forMin: Math.round(forMin) };
      if (forMin >= T.DEVICE_LONG_OFFLINE_DAYS * 1440) longOffline.push(row); else offline.push(row);
      continue;
    }
    const measured = d.entities.filter((s) => { const c = classifyEntity(s, meta[s.entity_id] || {}); return (c.category === 'temperature' || c.category === 'humidity') && usable(s); });
    if (measured.length && measured.every((s) => minutesSince(s.last_updated, now) > T.STALE_MEASUREMENT_H * 60)) {
      stale += 1; staleList.push({ device: d.device, area: d.area || null, lastMin: Math.round(Math.min(...measured.map((s) => minutesSince(s.last_updated, now)))) });
      continue;
    }
    healthy += 1;
  }
  const wd = watchdog && watchdog.known ? { offline: watchdog.offline || [], count: (watchdog.offline || []).length } : null;
  return { known: devices.size > 0, judged: devices.size, healthy, offline, longOffline, stale: staleList, staleCount: stale, watchdog: wd };
}

/** PURE. Batteries: HA's own <20% rule or a device reporting `low`; unreadable is never low. */
function batteriesFrom(states, meta) {
  const low = []; const unreadable = []; let ok = 0;
  const seen = new Set();
  for (const s of states || []) {
    const m = meta[s.entity_id] || {};
    const c = classifyEntity(s, m);
    if (c.category !== 'batteries') continue;
    const who = m.device || label(s);
    if (seen.has(who)) continue;
    seen.add(who);
    if (!usable(s)) { unreadable.push({ device: who, area: m.area || null }); continue; }
    const pct = num(s.state);
    const isLow = pct !== null ? pct < T.BATTERY_LOW_PCT : String(s.state).toLowerCase() === 'low';
    if (isLow) low.push({ device: who, area: m.area || null, level: pct !== null ? `${pct}%` : 'low' });
    else ok += 1;
  }
  return { low, unreadable, ok, rule: `under ${T.BATTERY_LOW_PCT}% (Home Assistant's own watchdog threshold) or the device saying “low”` };
}

// ── 28O/28P: hazards ────────────────────────────────────────────────────────

/** PURE. Per hazard class: present / absent / unknown / stale, and anything reporting. */
function hazardsFrom(states) {
  if (!Array.isArray(states) || !states.length) {
    return { known: false, categories: HAZARD_CATEGORIES.map((h) => ({ id: h.id, label: h.label, capability: 'unknown', sensors: 0, active: [], unavailable: [] })) };
  }
  const categories = HAZARD_CATEGORIES.map((h) => {
    const sensors = states.filter((s) => (h.domains || []).includes(dom(s.entity_id)) || (dom(s.entity_id) === 'binary_sensor' && h.classes.includes(dc(s))));
    if (!sensors.length) return { id: h.id, label: h.label, capability: 'absent', sensors: 0, active: [], unavailable: [] };
    const alarming = (s) => (dom(s.entity_id) === 'alarm_control_panel' ? s.state === 'triggered' : dom(s.entity_id) === 'lock' ? s.state === 'jammed' : s.state === 'on');
    const active = sensors.filter((s) => usable(s) && alarming(s)).map(label);
    const unavailable = sensors.filter((s) => !usable(s)).map(label);
    return { id: h.id, label: h.label, capability: unavailable.length === sensors.length ? 'stale' : 'present', sensors: sensors.length, active, unavailable };
  });
  return { known: true, categories, rule: 'A missing sensor is “absent”, never safe. Only a hazard sensor’s own state can raise a hazard — never temperature, humidity, occupancy or silence.' };
}

// ── 28Q/28R: network ────────────────────────────────────────────────────────

function networkFrom(states, { now = Date.now(), haReachable = true, notRead = false } = {}) {
  if (!haReachable) return { ha: notRead ? 'not-read' : 'unreachable', wan: null, hub: null };
  const pick = (re) => (states || []).find((s) => dom(s.entity_id) === 'binary_sensor' && dc(s) === 'connectivity' && re.test(s.entity_id));
  const shape = (s) => (!s ? null : { label: label(s), state: !usable(s) ? 'unknown' : s.state === 'on' ? 'up' : 'down', forMin: round1(minutesSince(s.last_changed, now)) });
  return {
    ha: 'reachable',
    wan: shape(pick(/wan/)),
    hub: shape(pick(/hub/)),
    note: 'The router’s WAN link is the link to the upstream (ISP) router — it is the best internet signal Home Assistant has, not proof of the wider internet.',
  };
}

// ── 28S/28T, 28V, 28U ───────────────────────────────────────────────────────

function appliancesFrom(states, meta) {
  const items = (states || []).filter((s) => classifyEntity(s, meta[s.entity_id] || {}).category === 'appliances')
    .map((s) => ({ label: label(s), state: usable(s) ? s.state : 'unknown', fault: dom(s.entity_id) === 'binary_sensor' && dc(s) === 'problem' && s.state === 'on' }));
  return { capability: items.length ? 'present' : 'absent', items, rule: 'An appliance finishing is never a notification. Only a reported fault becomes an exception.' };
}

/** A whole-house meter only — never an energy model from switch states. */
function energyFrom(states) {
  const meters = (states || []).filter((s) => dom(s.entity_id) === 'sensor' && dc(s) === 'energy');
  const house = meters.find((s) => /grid|house|home|whole|mains|meter|consumption/i.test(`${s.entity_id} ${attrs(s).friendly_name || ''}`));
  if (!house) return { available: false, why: meters.length ? `Only ${meters.length} smart plug${meters.length === 1 ? '' : 's'} meter${meters.length === 1 ? 's' : ''} energy — there is no whole-house meter, so NEURO reports no household usage.` : 'No energy meter in Home Assistant.', pluginMeters: meters.length };
  return { available: true, label: label(house), kWh: usable(house) ? num(house.state) : null };
}

/** Outdoor context, from the weather station already in HA (never a second weather engine). */
function weatherFrom(states, { stats = {}, now = Date.now(), raining = null } = {}) {
  const st = (states || []).find((s) => s.entity_id === 'sensor.weather_station_temperature');
  const fc = (states || []).find((s) => dom(s.entity_id) === 'weather');
  const outC = usable(st) && minutesSince(st.last_updated, now) < 60 ? toCelsius(st.state, attrs(st).unit_of_measurement) : null;
  const hours = hoursOf(stats['sensor.weather_station_temperature'], now).filter((h) => h.t >= now - T.BASELINE_DAYS * 24 * HOUR);
  const weekMean = hours.length >= 24 ? round1(hours.reduce((a, h) => a + h.mean, 0) / hours.length) : null;
  return {
    outdoorC: outC, source: outC !== null ? 'garden weather station' : null,
    weekMeanC: weekMean, forecast: usable(fc) ? fc.state : null, raining,
    line: outC === null ? null : `Outside ${outC} °C${weekMean !== null ? ` (this week’s average ${weekMean} °C)` : ''}.`,
  };
}

// ── 28W/28X: exceptions ─────────────────────────────────────────────────────

const exc = (o) => ({ confidence: 'high', actionability: 'context', context: null, ...o });

/**
 * PURE. Every exception, each with what / where / since / evidence / confidence
 * / persistence / why it matters / actionability. Duplicate evidence collapses
 * by key. Nothing here pushes: needs_you only marks what the existing Needs You
 * surfaces may show (28Z).
 */
function exceptionsFrom(p, { now = Date.now() } = {}) {
  const out = new Map();
  const add = (e) => { if (!out.has(e.key)) out.set(e.key, e); else out.get(e.key).evidence.push(...e.evidence.filter((x) => !out.get(e.key).evidence.includes(x))); };
  const stats = p.stats || {};
  const occ = (p.occupancy && p.occupancy.state) || 'unknown';
  const weatherCtx = p.weather && p.weather.outdoorC !== null && p.weather.weekMeanC !== null && p.weather.outdoorC <= p.weather.weekMeanC - 3
    ? `It is ${round1(p.weather.weekMeanC - p.weather.outdoorC)} °C colder outside than this week’s average, which may explain it.` : null;

  // ── climate: below its own setpoint, three consecutive hours ──
  for (const r of p.rooms || []) {
    if (!r.heating || !r.temperature) continue;
    const trv = (p.trvTargets || {})[r.area];
    if (!trv) continue;
    const tHours = hoursOf(stats[r.temperature.id], now);
    const gHours = hoursOf(stats[trv], now);
    const gBy = new Map(gHours.map((h) => [h.t, h.mean]));
    const last = lastN(tHours, T.BELOW_TARGET_HOURS);
    if (!last || !consecutive(last)) continue;
    const ok = last.every((h) => gBy.has(h.t) && gBy.get(h.t) > T.HEATING_ON_TARGET_C && h.mean <= gBy.get(h.t) - T.BELOW_TARGET_C);
    if (!ok || occ === 'empty') continue;
    const avgT = round1(last.reduce((a, h) => a + h.mean, 0) / last.length);
    const avgG = round1(last.reduce((a, h) => a + gBy.get(h.t), 0) / last.length);
    add(exc({ key: `climate:below-target:${r.area}`, category: 'climate', what: `${r.area} is well below its own setpoint`, where: r.area,
      since: new Date(last[0].t).toISOString(), evidence: [`Averaged ${avgT} °C against a setpoint of ${avgG} °C for the last ${last.length} hours (${r.temperature.source}).`],
      persistence: `${T.BELOW_TARGET_HOURS} consecutive hours ≥${T.BELOW_TARGET_C} °C below target`,
      whyItMatters: occ === 'occupied' ? 'Someone is home and the room is not reaching the temperature it is set to.' : 'The room is not reaching the temperature it is set to (can’t tell if anyone is home).',
      context: weatherCtx }));
  }

  // ── climate: diverging from the rest of the house, vs its own usual offset ──
  const roomHours = (p.rooms || []).filter((r) => r.temperature).map((r) => ({ area: r.area, hours: hoursOf(stats[r.temperature.id], now).filter((h) => h.t >= now - T.BASELINE_DAYS * 24 * HOUR) }));
  if (roomHours.length >= 3) {
    const byHour = new Map();
    for (const rh of roomHours) for (const h of rh.hours) { if (!byHour.has(h.t)) byHour.set(h.t, new Map()); byHour.get(h.t).set(rh.area, h.mean); }
    for (const rh of roomHours) {
      const offsets = [];
      for (const h of rh.hours) {
        const others = [...byHour.get(h.t).entries()].filter(([a]) => a !== rh.area).map(([, v]) => v);
        if (others.length >= 2) offsets.push({ t: h.t, off: h.mean - median(others) });
      }
      if (offsets.length < T.BASELINE_MIN_HOURS + T.DIVERGE_HOURS) continue;
      const recent = offsets.slice(-T.DIVERGE_HOURS);
      if (!consecutive(recent)) continue;
      const base = offsets.slice(0, -T.DIVERGE_HOURS).map((o) => o.off);
      const bm = median(base); const spread = Math.max(T.DIVERGE_MIN_C, 3 * 1.4826 * (mad(base) || 0));
      const dev = recent.map((o) => o.off - bm);
      if (dev.every((d) => d < -spread) || dev.every((d) => d > spread)) {
        const colder = dev[0] < 0;
        add(exc({ key: `climate:diverging:${rh.area}`, category: 'climate', what: `${rh.area} is ${colder ? 'colder' : 'warmer'} than usual compared with the rest of the house`, where: rh.area,
          since: new Date(recent[0].t).toISOString(), evidence: [`Usually ${round1(bm)} °C from the house median; for the last ${recent.length} hours ${round1(recent[recent.length - 1].off)} °C.`],
          persistence: `${T.DIVERGE_HOURS} consecutive hours beyond max(${T.DIVERGE_MIN_C} °C, 3×MAD) of its own 7-day offset`,
          whyItMatters: 'One room drifting from the others while they hold steady can mean a valve, a window, or a radiator problem.', context: colder ? weatherCtx : null, confidence: 'medium' }));
      }
    }
  }

  // ── stale / stuck room sensors ──
  for (const r of p.rooms || []) {
    for (const [kind, reading] of [['temperature', r.temperature], ['humidity', r.humidity]]) {
      if (!reading || !reading.id) continue;
      if (reading.ageMin !== null && reading.ageMin > T.STALE_MEASUREMENT_H * 60) {
        add(exc({ key: `source:stale:${reading.id}`, category: 'source', what: `${r.area} ${kind} sensor has stopped reporting`, where: r.area, since: new Date(now - reading.ageMin * MIN).toISOString(),
          evidence: [`No new ${kind} reading for ${Math.round(reading.ageMin / 60)} hours.`], persistence: `>${T.STALE_MEASUREMENT_H}h without an update`, whyItMatters: `NEURO cannot see the ${r.area} ${kind} — readings shown are old.`, confidence: 'medium' }));
        continue;
      }
      const last = lastN(hoursOf(stats[reading.id], now), T.STUCK_HOURS);
      if (last && consecutive(last) && last.every((h) => h.min === last[0].min && h.max === last[0].min && h.mean === last[0].min)) {
        add(exc({ key: `source:stuck:${reading.id}`, category: 'source', what: `${r.area} ${kind} reading has not moved in a day`, where: r.area, since: new Date(last[0].t).toISOString(),
          evidence: [`Exactly ${last[0].mean} for ${T.STUCK_HOURS} consecutive hours.`], persistence: `${T.STUCK_HOURS} flat hours`, whyItMatters: 'A reading that never changes is usually a sensor that has stuck, not a room that has.', confidence: 'medium' }));
      }
    }
  }

  // ── humidity: persistently beyond the room's own range ──
  for (const r of p.rooms || []) {
    if (!r.humidity || !r.humidity.id) continue;
    const hours = hoursOf(stats[r.humidity.id], now).filter((h) => h.t >= now - T.BASELINE_DAYS * 24 * HOUR);
    if (hours.length < T.BASELINE_MIN_HOURS + T.RH_HOURS) continue;
    const recent = hours.slice(-T.RH_HOURS);
    if (!consecutive(recent)) continue;
    const base = hours.slice(0, -T.RH_HOURS).map((h) => h.mean);
    const hi = percentile(base, 90) + T.RH_MARGIN; const lo = percentile(base, 10) - T.RH_MARGIN;
    const high = recent.every((h) => h.mean > hi); const low = recent.every((h) => h.mean < lo);
    if (!high && !low) continue;
    add(exc({ key: `humidity:${high ? 'high' : 'low'}:${r.area}`, category: 'humidity', where: r.area,
      what: `Humidity has stayed unusually ${high ? 'high' : 'low'} for ${r.area}`,
      since: new Date(recent[0].t).toISOString(), evidence: [`${Math.round(recent[recent.length - 1].mean)}% for ${recent.length} hours; this room’s usual range is ${Math.round(percentile(base, 10))}–${Math.round(percentile(base, 90))}%.`],
      persistence: `${T.RH_HOURS} consecutive hours beyond its own 7-day p${high ? 90 : 10} ${high ? '+' : '−'}${T.RH_MARGIN} points`,
      whyItMatters: high ? 'Unusual for this room. Humidity alone says nothing about damp or mould.' : 'Unusual for this room.', confidence: 'medium' }));
  }

  // ── heating: a run unusually long against its own last week ──
  const h = p.heating;
  if (h && h.known && h.firing && h.runs && h.runs.currentMinutes !== null && h.runs.completed >= T.RUN_MIN_SAMPLES) {
    const limit = Math.max(T.RUN_MIN_MINUTES, T.RUN_P90_FACTOR * (h.runs.p90Minutes || 0), T.RUN_LONGEST_FACTOR * (h.runs.longestMinutes || 0));
    if (h.runs.currentMinutes > limit) {
      add(exc({ key: 'heating:long-run', category: 'heating', what: 'The boiler has been running unusually long', where: 'Boiler',
        since: new Date(now - h.runs.currentMinutes * MIN).toISOString(),
        evidence: [`On for ${Math.round(h.runs.currentMinutes)} min; this week its runs were usually under ${Math.round(h.runs.p90Minutes)} min (p90 of ${h.runs.completed}), the longest ${Math.round(h.runs.longestMinutes || 0)} min.`,h.calling.length ? `Calling for heat: ${h.calling.join(', ')}.` : 'No radiator valve reports calling for heat.'],
        persistence: `continuous run > max(${T.RUN_MIN_MINUTES} min, ${T.RUN_P90_FACTOR}× its own 7-day p90)`,
        whyItMatters: 'Heating that will not reach temperature costs money and can mean a valve or boiler fault.', context: weatherCtx }));
    }
  }
  if (h && !h.known && p.haReachable) {
    add(exc({ key: 'source:boiler-unreadable', category: 'source', what: 'The heating thermostat cannot be read', where: 'Heating', since: null,
      evidence: ['Home Assistant reports the boiler thermostat unavailable.'], persistence: 'current', whyItMatters: 'NEURO cannot tell whether the heating is on.' }));
  }

  // ── openings ──
  for (const r of p.rooms || []) {
    for (const o of r.openings || []) {
      if (o.state !== 'open' || o.forMin === null) continue;
      const heatingHere = (r.heating && r.heating.demand === true) || (h && h.firing === true);
      if (o.kind === 'window' && heatingHere && o.forMin >= T.WINDOW_HEATING_MIN) {
        add(exc({ key: `opening:window-heating:${o.id}`, category: 'opening', what: `${o.label} is open while the heating is on`, where: r.area,
          since: new Date(now - o.forMin * MIN).toISOString(), evidence: [`Open ${Math.round(o.forMin)} min; ${r.heating && r.heating.demand ? `${r.area} is calling for heat` : 'the boiler is running'}.`],
          persistence: `open ≥${T.WINDOW_HEATING_MIN} min while heating`, whyItMatters: 'Heat going out of the window.', context: p.weather && p.weather.raining === true ? 'It is raining.' : null }));
      }
      if (o.forMin >= T.DOOR_OPEN_MIN && o.kind !== 'window') {
        const empty = occ === 'empty';
        add(exc({ key: `opening:open-long:${o.id}`, category: 'opening', what: `${o.label} has been open ${Math.round(o.forMin)} min`, where: r.area,
          since: new Date(now - o.forMin * MIN).toISOString(), evidence: [`Its sensor has read open since ${new Date(now - o.forMin * MIN).toISOString()}.`, empty ? 'Nick and everyone who lives here are away.' : `Occupancy: ${occ}.`],
          persistence: `open ≥${T.DOOR_OPEN_MIN} min`, whyItMatters: empty ? 'A door open with nobody home.' : 'Open for a long time.',
          actionability: empty ? 'needs_you' : 'context' }));
      }
    }
  }

  // ── devices ──
  for (const d of (p.devices && p.devices.offline) || []) {
    add(exc({ key: `device:offline:${d.device}`, category: 'device', what: `${d.device} is offline`, where: d.area || 'no room', since: d.since,
      evidence: [`Every entity of the device has been unavailable for ${Math.round(d.forMin / 60) >= 1 ? `${Math.round(d.forMin / 60)} h` : `${d.forMin} min`}.`],
      persistence: `all entities unavailable ≥${T.DEVICE_OFFLINE_MIN} min`, whyItMatters: 'It may be unplugged on purpose; if not, it has dropped off.', confidence: 'medium' }));
  }
  for (const b of (p.batteries && p.batteries.low) || []) {
    add(exc({ key: `device:battery:${b.device}`, category: 'device', what: `${b.device} needs a battery (${b.level})`, where: b.area || 'no room', since: null,
      evidence: [`Battery ${b.level} — ${p.batteries.rule}.`], persistence: 'reported by the device', whyItMatters: 'It will stop reporting when it runs out.' }));
  }

  // ── hazards: immediate, authoritative only ──
  for (const c of (p.hazards && p.hazards.categories) || []) {
    for (const a of c.active) add(exc({ key: `hazard:${c.id}:${a}`, category: 'hazard', what: `${a}: ${c.label} detected`, where: a, since: null, evidence: [`The ${c.label} sensor is reporting.`], persistence: 'immediate — an authoritative hazard sensor', whyItMatters: 'A household hazard.', actionability: 'needs_you' }));
    for (const u of c.unavailable) add(exc({ key: `hazard-blind:${c.id}:${u}`, category: 'hazard', what: `Can’t reach ${u}`, where: u, since: null, evidence: [`The ${c.label} sensor is unavailable.`], persistence: 'current', whyItMatters: `NEURO cannot see the ${c.label} sensor.`, actionability: 'needs_you' }));
  }

  // ── network ──
  const n = p.network || {};
  if (n.ha === 'unreachable') {
    add(exc({ key: 'source:ha-unreachable', category: 'source', what: 'Home Assistant is unreachable', where: 'Home Assistant', since: null, evidence: ['The live read failed. This is Home Assistant, not the internet.'], persistence: 'current', whyItMatters: 'Everything about the house reads as unknown until it returns.' }));
  }
  if (n.wan && n.wan.state === 'down' && n.wan.forMin >= T.WAN_DOWN_MIN) {
    add(exc({ key: 'network:wan-down', category: 'network', what: 'The router reports its internet link down', where: 'Router', since: new Date(now - n.wan.forMin * MIN).toISOString(),
      evidence: [`${n.wan.label} down for ${Math.round(n.wan.forMin)} min.`], persistence: `down ≥${T.WAN_DOWN_MIN} min (shorter drops ignored)`, whyItMatters: 'Cloud devices (Hive, Tuya) and remote access stop working.' }));
  }
  if (n.hub && n.hub.state === 'down' && n.hub.forMin >= T.HUB_DOWN_MIN) {
    add(exc({ key: 'heating:hub-offline', category: 'heating', what: 'The heating hub is offline', where: 'Hive hub', since: new Date(now - n.hub.forMin * MIN).toISOString(),
      evidence: [`${n.hub.label} down for ${Math.round(n.hub.forMin)} min.`], persistence: `down ≥${T.HUB_DOWN_MIN} min`, whyItMatters: 'Heating schedules and radiator valves cannot be controlled or read.', actionability: 'needs_you' }));
  }

  // ── appliances ──
  for (const a of (p.appliances && p.appliances.items) || []) {
    if (a.fault) add(exc({ key: `appliance:fault:${a.label}`, category: 'appliance', what: `${a.label} reports a fault`, where: a.label, since: null, evidence: ['The appliance’s own problem sensor is on.'], persistence: 'reported by the appliance', whyItMatters: 'A fault the appliance itself is reporting.' }));
  }

  return [...out.values()].map((e) => ({ ...e, actionState: e.actionability === 'needs_you' ? 'needs_you' : 'context' }));
}

/**
 * PURE. Fold this pass's exceptions into what was held: since = earliest seen,
 * resolved = held but no longer present (only when its category could be READ
 * this pass — a blind pass keeps it open as `unknown`), recently resolved kept
 * 24h for the "resolved" state.
 */
function trackExceptions(held, current, { now = Date.now(), blindCategories = new Set() } = {}) {
  const prev = (held && held.open) || {};
  const open = {}; const opened = []; const resolvedNow = [];
  for (const e of current) {
    const was = prev[e.key];
    const firstSeenAt = was ? was.firstSeenAt : new Date(now).toISOString();
    open[e.key] = { ...e, since: e.since || firstSeenAt, firstSeenAt };
    if (!was) opened.push(open[e.key]);
  }
  for (const [key, e] of Object.entries(prev)) {
    if (open[key]) continue;
    if (blindCategories.has(e.category)) { open[key] = { ...e, actionState: 'unknown', unknownWhy: 'its source could not be read this pass — not resolved' }; continue; }
    resolvedNow.push({ ...e, actionState: 'resolved', resolvedAt: new Date(now).toISOString() });
  }
  const keepFrom = now - T.RESOLVED_KEEP_H * HOUR;
  const resolved = [...resolvedNow, ...((held && held.resolved) || []).filter((r) => Date.parse(r.resolvedAt) >= keepFrom && !open[r.key])]
    .filter((r, i, all) => all.findIndex((x) => x.key === r.key) === i);
  return { open, resolved, opened, resolvedNow };
}

// ── 28AI: source health ─────────────────────────────────────────────────────

function sourceHealthFrom(p) {
  const v = (id, labelText, verdict, why = null) => ({ id, label: labelText, verdict, why });
  if (!p.haReachable && p.notRead) return [v('ha', 'Home Assistant', 'unknown', 'not read yet in this process — nothing below is judged')];
  if (!p.haReachable) return [v('ha', 'Home Assistant', 'unavailable', 'the live read failed — every household capability below reads as unknown')];
  const temps = (p.rooms || []).filter((r) => r.temperature);
  const staleTemps = temps.filter((r) => r.temperature.ageMin > T.STALE_MEASUREMENT_H * 60).length;
  const occ = p.occupancy || {};
  const haz = (p.hazards && p.hazards.categories) || [];
  return [
    v('ha', 'Home Assistant', 'seeing'),
    v('presence', 'Who is home', occ.state === 'unknown' && /source|could not/.test(occ.why || '') ? 'unavailable' : 'seeing', occ.state === 'unknown' ? occ.why : null),
    v('climate', 'Room temperatures', !temps.length ? 'no-capability' : staleTemps ? 'partial' : 'seeing', staleTemps ? `${staleTemps} room sensor(s) stopped reporting` : null),
    v('heating', 'Heating', p.heating && p.heating.known ? (p.network && p.network.hub && p.network.hub.state === 'down' ? 'failing' : 'seeing') : 'unavailable', p.heating && p.heating.known ? null : 'boiler thermostat unreadable'),
    v('statistics', 'Climate history (HA statistics)', p.statsKnown ? 'seeing' : 'unavailable', p.statsKnown ? null : 'persistence for temperature and humidity cannot be judged without it'),
    v('openings', 'Doors and windows', (p.rooms || []).some((r) => r.openings.length) ? 'seeing' : 'no-capability', (p.rooms || []).some((r) => r.openings.length) ? null : 'no door or window sensor in Home Assistant'),
    v('hazards', 'Hazard sensors', haz.some((c) => c.capability === 'present') ? (haz.some((c) => c.capability === 'stale') ? 'partial' : 'seeing') : haz.some((c) => c.capability === 'stale') ? 'failing' : 'no-capability', haz.every((c) => c.capability === 'absent') ? 'no smoke, CO, gas, leak, heat or alarm sensor — absence is not safety' : null),
    v('devices', 'Devices', p.devices && p.devices.known ? 'seeing' : 'unavailable'),
    v('network', 'Router / hub', p.network && p.network.wan ? (p.network.wan.state === 'down' ? 'failing' : 'seeing') : 'no-capability'),
    v('weather', 'Outdoor (weather station)', p.weather && p.weather.outdoorC !== null ? 'seeing' : 'stale'),
    v('energy', 'Whole-house energy', p.energy && p.energy.available ? 'seeing' : 'no-capability', p.energy && !p.energy.available ? p.energy.why : null),
  ];
}

/** Which categories' sources were blind this pass (their exceptions must not resolve). */
function blindCategoriesFrom(p) {
  const b = new Set();
  if (!p.haReachable) ['climate', 'humidity', 'heating', 'opening', 'device', 'hazard', 'network', 'appliance', 'source'].forEach((c) => b.add(c));
  if (!p.statsKnown) { b.add('climate'); b.add('humidity'); }
  if (!p.heatingHistoryKnown) b.add('heating');
  return b;
}

// ── composition ─────────────────────────────────────────────────────────────

/**
 * PURE. The Home Intelligence model.
 *   states        HA states (null = Home Assistant unreachable)
 *   registry      { entity_id: { area, device, manufacturer } }
 *   stats         { statistic_id: hourly rows } (null = unreadable)
 *   boilerHistory [{state,last_changed}] for the boiler call-for-heat (null = unreadable)
 *   occupancy     home.occupancyFrom(...)
 *   held          the previous tracked exceptions (pure: nothing is written here)
 */
function compose({ states = null, registry = {}, stats = null, boilerHistory = null, occupancy = null, watchdog = null, raining = null, held = null, haStatus, now = Date.now(), env = process.env } = {}) {
  const haReachable = Array.isArray(states) && states.length > 0;
  // 'not-read' (Now's cache never filled) is not an outage: no exception, nothing resolves.
  const notRead = !haReachable && haStatus === 'not-read';
  const st = haReachable ? states : [];
  const boilerId = env.HOME_BOILER_CLIMATE || 'climate.thermostat_1';
  const meta = metaFor(st, registry, boilerId);
  const nickRoomState = st.find((s) => s.entity_id === (env.HA_ROOM_SENSOR || 'sensor.nick_room'));
  const nickRoom = usable(nickRoomState) && nickRoomState.state !== 'unclear' ? nickRoomState.state : null;
  const rooms = roomsFrom(st, meta, { now, nickRoom, roomAreas: roomAreaMap(env) });
  // TRV setpoint statistics, per room — the `_target_temperature` sensor of a valve in it.
  const trvTargets = {};
  for (const s of st) {
    const m = meta[s.entity_id] || {};
    if (m.area && m.heatingDevice && !m.boiler && /_target_temperature$/.test(s.entity_id) && !trvTargets[m.area]) trvTargets[m.area] = s.entity_id;
  }
  const heating = heatingFrom(st, rooms, { boilerId, boilerHistory, now });
  const devices = devicesFrom(st, meta, { now, watchdog });
  const batteries = batteriesFrom(st, meta);
  const hazards = haReachable ? hazardsFrom(st) : hazardsFrom(null);
  const network = networkFrom(st, { now, haReachable, notRead });
  const appliances = appliancesFrom(st, meta);
  const energy = energyFrom(st);
  const weather = weatherFrom(st, { stats: stats || {}, now, raining });
  const parts = { rooms, trvTargets, heating, devices, batteries, hazards, network, appliances, energy, weather, occupancy, stats: stats || {}, haReachable, notRead, statsKnown: !!stats, heatingHistoryKnown: Array.isArray(boilerHistory) };
  const current = exceptionsFrom(parts, { now });
  const tracked = trackExceptions(held, current, { now, blindCategories: blindCategoriesFrom(parts) });
  const exceptions = Object.values(tracked.open).sort((a, b) => (a.actionState === 'needs_you' ? 0 : 1) - (b.actionState === 'needs_you' ? 0 : 1) || String(a.category).localeCompare(String(b.category)));
  const humidityRooms = rooms.filter((r) => r.humidity).map((r) => ({ area: r.area, pct: r.humidity.pct, dewPointC: r.dewPointC }));
  return {
    contract: CONTRACT, asOf: new Date(now).toISOString(), known: haReachable,
    audit: haReachable ? audit(st, meta, now) : null,
    rooms: rooms.map((r) => ({ ...r, exceptions: exceptions.filter((e) => e.where === r.area).map((e) => e.key) })),
    climate: {
      rooms: rooms.filter((r) => r.temperature).length,
      line: rooms.filter((r) => r.temperature).length ? `${rooms.filter((r) => r.temperature).length} rooms with a temperature reading.` : 'No room temperature readings.',
    },
    heating,
    air: { rooms: humidityRooms, rule: 'Relative humidity is shown as read. NEURO never infers damp or mould from it; “unusual” means beyond this room’s own last 7 days for 4+ hours.' },
    openings: { capability: rooms.some((r) => r.openings.length) ? 'present' : 'absent', items: rooms.flatMap((r) => r.openings), why: rooms.some((r) => r.openings.length) ? null : 'Home Assistant has no door or window sensor, so NEURO cannot see openings.' },
    devices, batteries, appliances, hazards, network, weather, energy,
    exceptions, resolved: tracked.resolved,
    needsYou: exceptions.filter((e) => e.actionState === 'needs_you'),
    sourceHealth: sourceHealthFrom({ ...parts }),
    thresholds: T,
    _tracked: tracked,
  };
}

// ── readers ─────────────────────────────────────────────────────────────────

const INPUTS_KEY = 'home_intel_inputs';
const STATE_KEY = 'home_intel_state';
const REGISTRY_TEMPLATE = "{% set ns = namespace(o=[]) %}{% for s in states %}{% set ns.o = ns.o + [[s.entity_id, area_name(s.entity_id) or '', device_attr(s.entity_id,'name_by_user') or device_attr(s.entity_id,'name') or '', device_attr(s.entity_id,'manufacturer') or '']] %}{% endfor %}{{ ns.o | tojson }}";

function _ha() { return { url: (process.env.HA_URL || '').replace(/\/$/, ''), token: process.env.HA_TOKEN || '' }; }

async function readRegistry({ fetchImpl = fetch } = {}) {
  const { url, token } = _ha();
  if (!url || !token) throw new Error('Home Assistant is not configured');
  const res = await fetchImpl(`${url}/api/template`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ template: REGISTRY_TEMPLATE }), signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HA template ${res.status}`);
  const rows = JSON.parse(await res.text());
  const out = {};
  for (const [id, area, device, manufacturer] of rows) {
    // Only household entities are kept: people, trackers, the room classifier
    // and the phone have no business in a stored map of the house (28AJ).
    if (/^(person|device_tracker)\./.test(id) || /^sensor\.[a-z0-9_]*_room$/.test(id) || /iphone|ipad/i.test(`${id} ${device}`)) continue;
    if (!area && !device) continue;
    out[id] = { area: area || null, device: device || null, manufacturer: manufacturer || null };
  }
  return out;
}

/** HA history: end_time is REQUIRED — without it HA returns one day from the start. */
async function readBoilerHistory({ boilerId = process.env.HOME_BOILER_CLIMATE || 'climate.thermostat_1', now = Date.now(), fetchImpl = fetch } = {}) {
  const { url, token } = _ha();
  const id = boilerId.replace(/^climate\./, 'binary_sensor.') + '_state';
  const from = new Date(now - (T.BASELINE_DAYS + 1) * 24 * HOUR).toISOString();
  const res = await fetchImpl(`${url}/api/history/period/${encodeURIComponent(from)}?filter_entity_id=${encodeURIComponent(id)}&end_time=${encodeURIComponent(new Date(now).toISOString())}&minimal_response&no_attributes`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HA history ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) && data.length ? data[0] : [];
}

/** Which numeric entities persistence needs: room temperature/humidity, TRV setpoints, outdoor. */
function statisticIds(states, registry) {
  const meta = metaFor(states, registry);
  const ids = new Set(['sensor.weather_station_temperature']);
  for (const s of states) {
    const m = meta[s.entity_id] || {};
    if (!m.area || dom(s.entity_id) !== 'sensor') continue;
    const c = classifyEntity(s, m);
    if ((c.category === 'temperature' || c.category === 'humidity') && c.role === 'inference') ids.add(s.entity_id);
    if (m.heatingDevice && (/_target_temperature$/.test(s.entity_id) || /_current_temperature$/.test(s.entity_id))) ids.add(s.entity_id);
  }
  return [...ids];
}

/** The climate-only part of statistics we keep: complete hours, 8 days, mean/min/max. */
function trimStats(raw, now) {
  const out = {};
  for (const [id, rows] of Object.entries(raw || {})) {
    out[id] = (rows || []).map((r) => ({ start: typeof r.start === 'number' ? r.start : Date.parse(r.start), mean: round1(num(r.mean)), min: round1(num(r.min)), max: round1(num(r.max)) }))
      .filter((r) => Number.isFinite(r.start) && r.start >= now - (T.BASELINE_DAYS + 1) * 24 * HOUR);
  }
  return out;
}

function _load(key) { try { return JSON.parse(require('../db/database').getState(key) || 'null'); } catch { return null; } }
function _raining() { const w = _load('weather_nowcast_home'); return w && typeof w.raining === 'boolean' ? w.raining : null; }

/**
 * Compose over states the caller already holds, with the inputs the last pass
 * stored. SYNCHRONOUS and writes NOTHING (28AJ / test 50): `refresh()` is the
 * only writer. `states: null` from a cache that was never filled is "not read",
 * not "Home Assistant is down" — pass haStatus to say which.
 */
function readWith({ states = null, occupancy = null, watchdog = null, haStatus, now = Date.now() } = {}) {
  const inputs = _load(INPUTS_KEY) || {};
  return compose({ states, registry: inputs.registry || {}, stats: inputs.stats || null, boilerHistory: inputs.boilerHistory || null, occupancy, watchdog, raining: _raining(), held: _load(STATE_KEY), haStatus, now });
}

/**
 * The durable pass (inside `personal-ops`, every 30 min): one live read, fresh
 * registry/statistics/boiler history, then record what changed. The ONLY writer
 * of `home_intel_inputs` / `home_intel_state`; returns the Activity lines for
 * the caller to log (heating / network / hazard / source only).
 */
async function refresh({ now = Date.now(), occupancy = null, watchdog = null, deps = {} } = {}) {
  const db = deps.db || require('../db/database');
  const ha = deps.ha || require('./ha');
  const gaps = [];
  let states = null;
  try { states = await ha.fetchStates(); } catch (e) { gaps.push({ input: 'home-assistant', why: e.message }); }
  const prevInputs = _load(INPUTS_KEY) || {};
  let registry = prevInputs.registry || {};
  let stats = null; let boilerHistory = null;
  if (Array.isArray(states) && states.length) {
    const regAge = prevInputs.registryAt ? now - Date.parse(prevInputs.registryAt) : Infinity;
    if (!Object.keys(registry).length || regAge > T.REGISTRY_MAX_AGE_H * HOUR) {
      try { registry = await (deps.readRegistry || readRegistry)(); prevInputs.registryAt = new Date(now).toISOString(); } catch (e) { gaps.push({ input: 'registry', why: e.message }); }
    }
    try {
      const { url, token } = _ha();
      const raw = await (deps.readStatistics || ((ids) => require('./bedroom-climate').fetchStatisticsMany({ url, token, entities: ids, since: new Date(now - (T.BASELINE_DAYS + 1) * 24 * HOUR).toISOString() })))(statisticIds(states, registry));
      stats = trimStats(raw, now);
    } catch (e) { gaps.push({ input: 'statistics', why: e.message }); }
    try { boilerHistory = (await (deps.readBoilerHistory || readBoilerHistory)({ now })).map((r) => ({ state: r.state, last_changed: r.last_changed })); } catch (e) { gaps.push({ input: 'boiler-history', why: e.message }); }
  }
  const held = _load(STATE_KEY);
  const model = compose({ states, registry, stats, boilerHistory, occupancy, watchdog, raining: _raining(), held, now });
  db.setState(INPUTS_KEY, JSON.stringify({ at: new Date(now).toISOString(), registryAt: prevInputs.registryAt || null, registry, stats, boilerHistory }));
  db.setState(STATE_KEY, JSON.stringify({ at: new Date(now).toISOString(), open: model._tracked.open, resolved: model._tracked.resolved }));
  const activity = [
    ...model._tracked.opened.filter((e) => ACTIVITY_CATEGORIES.has(e.category)).map((e) => ({ kind: 'home-exception-opened', e })),
    ...model._tracked.resolvedNow.filter((e) => ACTIVITY_CATEGORIES.has(e.category)).map((e) => ({ kind: 'home-exception-resolved', e })),
  ];
  return { ok: true, gaps, model, activity, baseline: !held };
}

module.exports = {
  CONTRACT, T, HAZARD_CATEGORIES, ACTIVITY_CATEGORIES, INPUTS_KEY, STATE_KEY,
  // pure
  toCelsius, dewPoint, classifyEntity, metaFor, audit, roomsFrom, runsFrom, heatingFrom, devicesFrom, batteriesFrom,
  hazardsFrom, networkFrom, appliancesFrom, energyFrom, weatherFrom, exceptionsFrom, trackExceptions,
  sourceHealthFrom, blindCategoriesFrom, statisticIds, trimStats, compose, roomAreaMap, percentile,
  // I/O
  readRegistry, readBoilerHistory, readWith, refresh,
};
