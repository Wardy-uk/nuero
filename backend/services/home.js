'use strict';

/**
 * Household / Home — one bounded read model (Build 22, 8 Oct 2026).
 *
 * It COMPOSES what NEURO already holds and adds no store of its own:
 *   occupancy   ← household.read()         (presence spine, Build 13H + 7 Oct roster)
 *   obligations ← personal-obligations     (open items whose domain is HOME)
 *   upcoming    ← future-radar             (dated items whose domain is HOME)
 *   devices     ← Home Assistant's OWN watchdog template sensors
 *   safety      ← hazard-class sensors (smoke / gas / CO / water leak), if any exist
 *   sources     ← the health of each of the above, kept apart from "nothing happened"
 *
 * ⚠ NOT A SENSOR DASHBOARD. The audit (8 Oct 2026) found 252 HA entities; this
 *   reads two template sensors and the device classes of the rest. Room climate
 *   already reaches Nick as SAiM's heating offer and is deliberately not repeated.
 *
 * ⚠ OCCUPANCY IS CONSERVATIVE. Occupied = someone tracked is positively home.
 *   Empty = Nick AND every resident are positively away. Anything else is
 *   UNKNOWN — a failing presence source, an untracked resident or a visitor's
 *   phone never makes the house "empty". Nobody arriving or leaving is ever a
 *   reason to interrupt (22D); nothing here is about WHERE anyone is.
 *
 * ⚠ DEVICES ARE HA'S JUDGEMENT, NOT NEURO'S. `sensor.watchdog_offline_devices`
 *   and `sensor.watchdog_low_batteries` are curated in configuration.yaml (lights
 *   excluded, because a bulb switched off at the wall is unavailable and healthy;
 *   phone health sensors excluded). They claim NO duration, and neither does this.
 *   HA already pushes them at 09:00, so they are CONTEXT here, never Needs You —
 *   one alarm, not two. An offline plug may be deliberately unplugged.
 *
 * ⚠ "NOTHING HAPPENED" ≠ "CANNOT SEE". A battery sensor that has not changed in
 *   23 days is QUIET (Hive reports on change), not stale. Zero offline devices
 *   read from a working watchdog is a fact; a missing watchdog sensor is
 *   `known:false`. No safety sensor at all is `capability: 'none'`, never "safe".
 */

const CONTRACT = 'home-v1';
const WATCHDOG_OFFLINE = 'sensor.watchdog_offline_devices';
const WATCHDOG_BATTERIES = 'sensor.watchdog_low_batteries';
// Hazards only. Doors/windows ("opening") are not safety; nothing here is security.
const HAZARD_CLASSES = new Set(['smoke', 'gas', 'carbon_monoxide', 'moisture']);
const HAZARD_WORDS = { smoke: 'smoke', gas: 'gas', carbon_monoxide: 'carbon monoxide', moisture: 'water leak' };
const UPCOMING_DAYS = 14;

const isHome = (domains) => (domains || []).some((d) => (d && (d.domain || d)) === 'home');

/** PURE. household.read() → occupancy. */
function occupancyFrom(household) {
  const h = household || {};
  const src = h.source || {};
  if (!h.known) {
    return { state: 'unknown', who: [], why: h.why || 'presence could not be read', freshness: src.freshness || 'unknown' };
  }
  if (src.state === 'failing' || src.freshness === 'stale') {
    return { state: 'unknown', who: [], why: `presence source is ${src.state === 'failing' ? 'failing' : 'stale'}`, freshness: src.freshness || 'unknown' };
  }
  const people = (h.members || []).filter((m) => m.role !== 'companion');
  const home = people.filter((m) => m.state === 'home');
  if (home.length) {
    return { state: 'occupied', who: home.map((m) => m.name), why: `${home.map((m) => m.name).join(' and ')} ${home.length === 1 ? 'is' : 'are'} home`, freshness: src.freshness || 'fresh' };
  }
  const core = people.filter((m) => m.role === 'self' || m.role === 'resident');
  if (core.length && core.every((m) => m.state === 'away')) {
    return { state: 'empty', who: [], why: 'Nick and everyone who lives here are away', freshness: src.freshness || 'fresh' };
  }
  const unsure = core.filter((m) => m.state !== 'away').map((m) => m.name);
  return { state: 'unknown', who: [], why: unsure.length ? `can't tell where ${unsure.join(' and ')} ${unsure.length === 1 ? 'is' : 'are'}` : 'no residents are tracked', freshness: src.freshness || 'unknown' };
}

const _list = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

/** PURE. HA states (or null when HA could not be read) → device health. */
function devicesFrom(states) {
  if (!Array.isArray(states) || !states.length) {
    return { known: false, offline: [], lowBatteries: [], unreadableBatteries: 0, why: 'Home Assistant could not be read', source: 'home-assistant watchdog' };
  }
  const by = new Map(states.map((s) => [s.entity_id, s]));
  const off = by.get(WATCHDOG_OFFLINE);
  const bat = by.get(WATCHDOG_BATTERIES);
  const usable = (s) => s && !['unavailable', 'unknown'].includes(String(s.state));
  if (!usable(off) && !usable(bat)) {
    return { known: false, offline: [], lowBatteries: [], unreadableBatteries: 0, why: 'Home Assistant has no device watchdog sensors', source: 'home-assistant watchdog' };
  }
  const attrs = (s) => (s && s.attributes) || {};
  return {
    known: true,
    offline: usable(off) ? _list(attrs(off).devices) : [],
    offlineKnown: usable(off),
    lowBatteries: usable(bat) ? _list(attrs(bat).batteries) : [],
    batteriesKnown: usable(bat),
    unreadableBatteries: usable(bat) ? _list(attrs(bat).unreadable).length : 0,
    why: null,
    source: 'home-assistant watchdog',
    claimsDuration: false,
  };
}

/** PURE. HA states → whether any hazard sensor exists, and what it says. */
function safetyFrom(states) {
  if (!Array.isArray(states) || !states.length) {
    return { capability: 'unknown', sensors: 0, active: [], unavailable: [], why: 'Home Assistant could not be read' };
  }
  const hazard = states.filter((s) => /^binary_sensor\./.test(s.entity_id) && HAZARD_CLASSES.has((s.attributes || {}).device_class));
  if (!hazard.length) {
    return { capability: 'none', sensors: 0, active: [], unavailable: [], why: 'Home Assistant has no smoke, gas, carbon monoxide or water-leak sensor, so NEURO cannot see household hazards' };
  }
  const label = (s) => (s.attributes && s.attributes.friendly_name) || s.entity_id.replace(/^binary_sensor\./, '').replace(/_/g, ' ');
  const active = hazard.filter((s) => s.state === 'on').map((s) => ({ label: label(s), hazard: HAZARD_WORDS[s.attributes.device_class] }));
  const unavailable = hazard.filter((s) => ['unavailable', 'unknown'].includes(s.state)).map((s) => ({ label: label(s), hazard: HAZARD_WORDS[s.attributes.device_class] }));
  return { capability: 'present', sensors: hazard.length, active, unavailable, why: null };
}

/** PURE. Shaped personal obligations → the household ones (domain HOME). */
function homeObligations(items) {
  return (items || []).filter((o) => isHome(o.domains)).map((o) => ({
    id: o.id, what: o.what, due: o.due || null, source: o.source || null,
    actionState: o.actionState || null, needsNow: o.needsNow === true, why: o.needsWhy || o.why || null,
  }));
}

/** PURE. Radar items → dated household items. HA telemetry never appears here. */
function upcomingFrom(radarItems) {
  return (radarItems || []).filter((i) => isHome(i.domains)).map((i) => ({
    id: i.id, title: i.title, kind: i.kind, date: i.date || null, when: i.when || null, actionState: i.actionState || null,
  }));
}

/**
 * PURE. Each input's state — and, crucially, the difference between
 * "nothing happened" and "this capability is unavailable".
 */
function sourcesFrom({ household, devices, safety, remindersHealth = [] } = {}) {
  const out = [];
  const hs = (household && household.source) || {};
  out.push({
    id: 'presence', label: 'Who is home',
    verdict: !household || !household.known ? 'unavailable' : hs.state === 'failing' ? 'failing' : hs.freshness === 'stale' ? 'stale' : 'seeing',
    why: !household || !household.known ? 'presence could not be read' : null,
  });
  out.push({
    id: 'devices', label: 'Device health (Home Assistant watchdog)',
    verdict: devices && devices.known ? 'seeing' : 'unavailable',
    why: devices && devices.known ? null : (devices && devices.why) || 'not read',
  });
  out.push({
    id: 'safety', label: 'Household hazards',
    verdict: safety.capability === 'present' ? (safety.unavailable.length ? 'partial' : 'seeing') : safety.capability === 'none' ? 'no-capability' : 'unavailable',
    why: safety.why || (safety.unavailable.length ? `${safety.unavailable.length} hazard sensor(s) unreachable` : null),
  });
  const rem = remindersHealth.filter((h) => !/unknown$/.test(h.sourceId));
  const fresh = rem.some((h) => h.freshness === 'fresh');
  out.push({
    id: 'reminders', label: 'Household reminders',
    verdict: !rem.length ? 'unavailable' : fresh ? 'seeing' : rem.some((h) => h.state === 'failing') ? 'failing' : 'stale',
    why: !rem.length ? 'no phone has pushed Reminders' : fresh ? null : 'no app has pushed Reminders recently',
  });
  return out;
}

/**
 * PURE. What, about the home, needs Nick. Deliberately narrow (22F):
 *   - a household obligation the obligations rule already says needs him now
 *     (a stated or set date ≤1 day away or ≤14 days past) — never a placeholder;
 *   - a hazard sensor positively reporting (smoke / gas / CO / leak);
 *   - a hazard sensor he HAS that cannot be reached (a smoke alarm NEURO cannot
 *     see is a source failure that affects something important).
 * NOT: arrivals/departures, offline plugs, low batteries (HA pushes those),
 * quiet sensors, or having no hazard sensors at all.
 */
function needsYouFrom({ obligations = [], safety } = {}) {
  const out = [];
  for (const o of obligations) if (o.needsNow) out.push({ kind: 'obligation', id: o.id, title: o.what, why: o.why || (o.due && o.due.label) || 'due now' });
  for (const a of (safety && safety.active) || []) out.push({ kind: 'hazard', id: `hazard:${a.label}`, title: `${a.label}: ${a.hazard} detected`, why: 'a household hazard sensor is reporting' });
  for (const u of (safety && safety.unavailable) || []) out.push({ kind: 'hazard-blind', id: `hazard-blind:${u.label}`, title: `Can't reach ${u.label}`, why: `NEURO cannot see the ${u.hazard} sensor` });
  return out;
}

/** PURE. The whole read model. */
function compose({ household = null, states = null, obligations = [], radarItems = [], remindersHealth = [], gaps = [], now = Date.now() } = {}) {
  const occupancy = occupancyFrom(household);
  const devices = devicesFrom(states);
  const safety = safetyFrom(states);
  const obl = homeObligations(obligations);
  const upcoming = upcomingFrom(radarItems);
  const needsYou = needsYouFrom({ obligations: obl, safety });
  const sources = sourcesFrom({ household, devices, safety, remindersHealth });
  const summary = [
    occupancy.state === 'occupied' ? `Home is occupied — ${occupancy.why}.` : occupancy.state === 'empty' ? 'Home is empty.' : `Can't tell if anyone is home (${occupancy.why}).`,
    obl.length ? `${obl.length} household ${obl.length === 1 ? 'thing' : 'things'} to do.` : null,
    upcoming.length ? `${upcoming.length} household ${upcoming.length === 1 ? 'item' : 'items'} in the next ${UPCOMING_DAYS} days.` : null,
    devices.known && devices.lowBatteries.length ? `${devices.lowBatteries.length} ${devices.lowBatteries.length === 1 ? 'device needs' : 'devices need'} a battery.` : null,
  ].filter(Boolean);
  return {
    ok: true, contract: CONTRACT, asOf: new Date(now).toISOString(),
    occupancy, obligations: obl, upcoming, devices, safety, needsYou, sources, summary, gaps,
    rule: 'Composed from what NEURO already holds. Occupied only when someone is positively home, empty only when everyone who lives here is positively away. Household tasks are reminders/tasks you classified as Home. Device health is Home Assistant\'s own watchdog, claiming no duration. Nothing here is a reason to notify you about someone arriving or leaving.',
  };
}

// ── reader ────────────────────────────────────────────────────────────────────

function _remindersHealth() {
  try {
    return require('../db/database').all("SELECT source_id, state, freshness, last_observed_at FROM source_health WHERE source_id LIKE 'reminders.%'")
      .map((h) => ({ sourceId: h.source_id, state: h.state, freshness: h.freshness, lastObservedAt: h.last_observed_at }));
  } catch { return []; }
}

/**
 * `states`: pass HA states, or omit and say how to get them:
 *   { live: true }  → fetch (the route; 60s cache in ha.js)
 *   default         → ha.cachedStates(), no network (Now, which is polled)
 */
async function read({ now = Date.now(), live = false, states } = {}) {
  const gaps = [];
  let household = null;
  try { household = require('./household').read(); } catch (e) { gaps.push({ input: 'household', why: e.message }); }
  let st = states;
  if (st === undefined) {
    const ha = require('./ha');
    if (live) { try { st = await ha.getStates(); } catch (e) { st = null; gaps.push({ input: 'home-assistant', why: e.message }); } }
    else st = ha.cachedStates();
  }
  return compose({ ..._readLocal(now, gaps), household, states: st, gaps, now });
}

/** The synchronous half, shared by read() and readCached(). */
function _readLocal(now, gaps) {
  let obligations = [];
  try { obligations = require('./personal-obligations').read({ now }).items || []; } catch (e) { gaps.push({ input: 'obligations', why: e.message }); }
  let radarItems = [];
  try { radarItems = require('./future-radar').read({ now, horizonDays: UPCOMING_DAYS }).items || []; } catch (e) { gaps.push({ input: 'radar', why: e.message }); }
  return { obligations, radarItems, remindersHealth: _remindersHealth() };
}

/** Synchronous, no network: for Now. Reuses a radar already read when given. */
function readCached({ now = Date.now(), radarItems = null } = {}) {
  const gaps = [];
  let household = null;
  try { household = require('./household').read(); } catch (e) { gaps.push({ input: 'household', why: e.message }); }
  let obligations = [];
  try { obligations = require('./personal-obligations').read({ now }).items || []; } catch (e) { gaps.push({ input: 'obligations', why: e.message }); }
  let states = null;
  try { states = require('./ha').cachedStates(); } catch { states = null; }
  return compose({ household, states, obligations, radarItems: radarItems || [], remindersHealth: _remindersHealth(), gaps, now });
}

// ── Activity (22J) ───────────────────────────────────────────────────────────

/**
 * PURE. What CHANGED that is worth a line in Activity. Never raw telemetry, never
 * an arrival/departure, never an offline plug (HA reports those daily itself).
 *   held   the previous snapshot (null = first run → baseline, nothing logged)
 *   next   { haReadable, presence, lowBatteries[], hazards[], hazardBlind[] }
 */
function changesBetween(held, next) {
  if (!held) return [];
  const out = [];
  if (held.haReadable && !next.haReadable) out.push({ kind: 'home-source-lost', detail: { source: 'Home Assistant' } });
  if (!held.haReadable && next.haReadable) out.push({ kind: 'home-source-restored', detail: { source: 'Home Assistant' } });
  const bad = (v) => v === 'failing' || v === 'unavailable';
  if (!bad(held.presence) && bad(next.presence)) out.push({ kind: 'home-source-lost', detail: { source: 'presence' } });
  if (bad(held.presence) && !bad(next.presence)) out.push({ kind: 'home-source-restored', detail: { source: 'presence' } });
  const added = (a, b) => (b || []).filter((x) => !(a || []).includes(x));
  // Only judged while HA was readable both times: a blind read is not "all fixed".
  if (held.haReadable && next.haReadable) {
    for (const d of added(held.lowBatteries, next.lowBatteries)) out.push({ kind: 'home-battery-low', detail: { device: d } });
    for (const h of added(held.hazards, next.hazards)) out.push({ kind: 'home-hazard', detail: { sensor: h } });
    for (const h of added(next.hazards, held.hazards)) out.push({ kind: 'home-hazard-cleared', detail: { sensor: h } });
    for (const h of added(held.hazardBlind, next.hazardBlind)) out.push({ kind: 'home-hazard-blind', detail: { sensor: h } });
  }
  return out;
}

/** PURE. The part of the model Activity compares between passes. */
function snapshotOf(model) {
  return {
    haReadable: !!(model.devices && model.devices.known) || model.safety.capability !== 'unknown',
    presence: (model.sources.find((s) => s.id === 'presence') || {}).verdict || 'unavailable',
    lowBatteries: model.devices.lowBatteries || [],
    hazards: (model.safety.active || []).map((a) => a.label),
    hazardBlind: (model.safety.unavailable || []).map((a) => a.label),
  };
}

/** Durable pass (inside `personal-ops`): one live read, log what changed. */
async function refresh({ now = Date.now() } = {}) {
  const db = require('../db/database');
  const po = require('./personal-obligations');
  const KEY = 'home_ops_state';
  let held = null;
  try { held = JSON.parse(db.getState(KEY) || 'null'); } catch { held = null; }
  const model = await read({ now, live: true });
  const next = snapshotOf(model);
  let logged = 0;
  for (const c of changesBetween(held, next)) {
    const subject = c.detail.device || c.detail.sensor || c.detail.source;
    logged += po.logEvent(c.kind, { subjectId: `home:${subject}`, detail: c.detail, dedupeKey: `${c.kind}:${subject}:${now}`, now }) ? 1 : 0;
  }
  db.setState(KEY, JSON.stringify(next));
  return { ok: true, baseline: !held, logged, occupancy: model.occupancy.state };
}

module.exports = {
  CONTRACT, WATCHDOG_OFFLINE, WATCHDOG_BATTERIES, HAZARD_CLASSES, UPCOMING_DAYS,
  // pure
  occupancyFrom, devicesFrom, safetyFrom, homeObligations, upcomingFrom, sourcesFrom, needsYouFrom, compose, changesBetween, snapshotOf,
  // readers
  read, readCached, refresh,
};
