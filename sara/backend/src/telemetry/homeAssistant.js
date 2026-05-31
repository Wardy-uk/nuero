// SARA Home Assistant telemetry bridge — v0 (WS3-WP1).
//
// Protected principle: Home Assistant is a TELEMETRY BUS, not a decision engine.
// This module does exactly one thing — read a bounded set of HA entity states over
// HA's REST API, normalise them into a telemetry snapshot, and cache the latest
// snapshot. It makes no decisions and owns no shared state. The State Engine reads
// this snapshot synchronously (`getTelemetry()`) and remains the sole producer of
// the one shared model. Swapping HA for another telemetry source later changes this
// module only — not the engine and not the contract. That is the seam.
//
// Honest fallback is a first-class outcome here, not an error path: if HA is not
// configured, not yet polled, or unreachable, `getTelemetry()` returns a snapshot
// with `available: false` and a machine-readable `reason`. Nothing throws into the
// engine, so existing screens keep working when HA is absent.
//
// Bounded v0 signal scope (spec): current location/zone, a simple presence/activity
// signal, and one environment signal to prove the seam. Each maps to one configurable
// HA entity id. Nothing is auto-discovered — the scope stays exactly these three.
//
// CommonJS only (NEURO backend convention — no ESM).

const TELEMETRY_SOURCE = 'home-assistant';

// The bounded signal slots and the env var that names each slot's HA entity.
const SIGNAL_SLOTS = {
  location: 'SARA_HA_LOCATION_ENTITY', // e.g. person.nick / device_tracker.nick_phone
  presence: 'SARA_HA_PRESENCE_ENTITY', // e.g. binary_sensor.office_occupancy / person.nick
  environment: 'SARA_HA_ENV_ENTITY', // e.g. sensor.office_temperature
  // Proximity drives SARA's "walked away" auto-lock. It is deliberately source-agnostic
  // so the trigger can be UPGRADED without code change (charter seam): point it at a
  // categorical tracker today (device_tracker.nicks_iphone -> home/not_home) and at a
  // Private BLE distance sensor later (sensor.<device>_estimated_distance, metres) for
  // true desk-level ranging from the iPhone, then the Apple Watch. The numeric away
  // threshold (metres) is read from SARA_HA_PROXIMITY_AWAY_M when the state is numeric.
  proximity: 'SARA_HA_PROXIMITY_ENTITY',
};

/** Read runtime config from env each call (no hidden caching of config). */
function config() {
  const entities = {};
  for (const [slot, envVar] of Object.entries(SIGNAL_SLOTS)) {
    entities[slot] = process.env[envVar] || null;
  }
  return {
    baseUrl: (process.env.SARA_HA_BASE_URL || '').replace(/\/+$/, ''), // e.g. http://homeassistant.local:8123
    token: process.env.SARA_HA_TOKEN || null, // HA long-lived access token
    entities,
    pollMs: Number(process.env.SARA_HA_POLL_MS) || 30000,
    timeoutMs: Number(process.env.SARA_HA_TIMEOUT_MS) || 4000,
    // Metres beyond which a numeric (BLE distance) proximity signal counts as "away".
    proximityAwayM: Number(process.env.SARA_HA_PROXIMITY_AWAY_M) || 8,
  };
}

/** Configured == we have a base URL, a token, and at least one entity to read. */
function isConfigured(cfg = config()) {
  return Boolean(cfg.baseUrl && cfg.token && Object.values(cfg.entities).some(Boolean));
}

function unavailable(reason, detail) {
  return {
    source: TELEMETRY_SOURCE,
    available: false,
    reason,
    detail: detail || null,
    polledAt: null,
    signals: { location: null, presence: null, environment: null, proximity: null },
  };
}

// Latest cached snapshot. Until the first successful poll it honestly reports why no
// telemetry is live yet, so a consumer reading it before/without polling still gets a
// truthful "unavailable" answer rather than stale or invented data.
let snapshot = unavailable(isConfigured() ? 'awaiting-first-poll' : 'not-configured');

function getTelemetry() {
  return snapshot;
}

// --- Normalisation (pure) ---------------------------------------------------
// Map a raw HA entity state object into a SARA telemetry signal. Kept pure and
// exported so the mapping is unit-testable without a live HA. HA `person` /
// `device_tracker` states are zone names ('home', 'not_home', or a custom zone).

function mapLocation(ha) {
  if (!ha || typeof ha.state !== 'string') return null;
  const zone = ha.state;
  let label;
  if (zone === 'home') label = 'Home';
  else if (zone === 'not_home') label = 'Away';
  else label = ha.attributes?.friendly_name || zone;
  return { entityId: ha.entity_id || null, state: zone, zone, label };
}

function mapPresence(ha) {
  if (!ha || typeof ha.state !== 'string') return null;
  const s = ha.state.toLowerCase();
  const present = ['on', 'home', 'true', 'detected', 'occupied', 'active'].includes(s);
  return {
    entityId: ha.entity_id || null,
    state: ha.state,
    present,
    label: ha.attributes?.friendly_name || ha.entity_id || 'presence',
  };
}

function mapEnvironment(ha) {
  if (!ha || typeof ha.state === 'undefined') return null;
  const unit = ha.attributes?.unit_of_measurement || null;
  const name = ha.attributes?.friendly_name || ha.entity_id || 'environment';
  return {
    entityId: ha.entity_id || null,
    state: ha.state,
    unit,
    label: unit ? `${name}: ${ha.state}${unit}` : `${name}: ${ha.state}`,
  };
}

// Proximity → SARA's "are you here?" signal for auto-lock. Source-agnostic by design:
//   * NUMERIC state (e.g. Private BLE `..._estimated_distance` in metres): away when the
//     distance exceeds the configured threshold. This is the desk-level upgrade path.
//   * CATEGORICAL state (device_tracker home/not_home, person, binary_sensor on/off):
//     away when the state reads as not-present. Works today with zero extra setup.
// `away` is the single boolean the frontend lock logic consumes; `present` is its inverse
// only when presence is known (null state -> both null, so the lock never fires blind).
const AWAY_WORDS = ['not_home', 'away', 'off', 'false', 'not_connected', 'disconnected', 'none', 'unavailable', 'unknown'];
const HOME_WORDS = ['home', 'on', 'true', 'connected', 'present', 'detected', 'occupied', 'active'];

function mapProximity(ha, cfg = config()) {
  if (!ha || typeof ha.state === 'undefined' || ha.state === null) return null;
  const raw = String(ha.state);
  const num = Number(raw);
  const isNumeric = raw.trim() !== '' && !Number.isNaN(num);

  let away = null;
  let distanceM = null;
  if (isNumeric) {
    distanceM = num;
    away = num > cfg.proximityAwayM;
  } else {
    const s = raw.toLowerCase();
    if (AWAY_WORDS.includes(s)) away = true;
    else if (HOME_WORDS.includes(s)) away = false;
    else away = null; // unknown categorical -> don't guess, never lock blind
  }

  return {
    entityId: ha.entity_id || null,
    state: raw,
    mode: isNumeric ? 'distance' : 'categorical',
    distanceM,
    awayThresholdM: isNumeric ? cfg.proximityAwayM : null,
    away,
    present: away === null ? null : !away,
    label: ha.attributes?.friendly_name || ha.entity_id || 'proximity',
  };
}

const SLOT_MAPPERS = {
  location: mapLocation,
  presence: mapPresence,
  environment: mapEnvironment,
  proximity: mapProximity,
};

/**
 * Build a telemetry snapshot from raw HA states keyed by slot. Pure; no I/O.
 * @param {object} statesBySlot e.g. { location: <haState>|null, presence: ... }
 * @param {object} cfg the active config (used to know which slots were requested)
 * @param {string} polledAt ISO timestamp of the poll
 */
function mapStatesToTelemetry(statesBySlot, cfg, polledAt) {
  const signals = { location: null, presence: null, environment: null, proximity: null };
  for (const slot of Object.keys(SLOT_MAPPERS)) {
    if (statesBySlot[slot]) signals[slot] = SLOT_MAPPERS[slot](statesBySlot[slot], cfg);
  }
  const requested = Object.values(cfg.entities).filter(Boolean).length;
  const got = Object.values(signals).filter(Boolean).length;
  let reason = null;
  if (got === 0) reason = 'no-signals';
  else if (got < requested) reason = 'partial'; // honest: HA up, some entities missing
  return {
    source: TELEMETRY_SOURCE,
    available: got > 0,
    reason,
    detail: null,
    polledAt,
    signals,
  };
}

// --- Live read --------------------------------------------------------------

async function fetchEntity(cfg, entityId) {
  const res = await fetch(`${cfg.baseUrl}/api/states/${encodeURIComponent(entityId)}`, {
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) throw new Error(`HA ${entityId} -> HTTP ${res.status}`);
  return res.json();
}

/**
 * Poll HA once and replace the cached snapshot. Never throws: a failure becomes an
 * honest `available: false` snapshot. Returns the new snapshot.
 */
async function refresh() {
  const cfg = config();
  if (!isConfigured(cfg)) {
    snapshot = unavailable('not-configured');
    return snapshot;
  }
  const slots = Object.entries(cfg.entities).filter(([, id]) => id);
  try {
    const statesBySlot = {};
    let anyReached = false;
    await Promise.all(
      slots.map(async ([slot, id]) => {
        try {
          statesBySlot[slot] = await fetchEntity(cfg, id);
          anyReached = true;
        } catch {
          statesBySlot[slot] = null; // this entity failed; others may still succeed
        }
      })
    );
    if (!anyReached) {
      snapshot = unavailable('unreachable', `no configured HA entity could be read from ${cfg.baseUrl}`);
      return snapshot;
    }
    snapshot = mapStatesToTelemetry(statesBySlot, cfg, new Date().toISOString());
  } catch (e) {
    snapshot = unavailable('unreachable', e.message);
  }
  return snapshot;
}

// --- Polling lifecycle ------------------------------------------------------

let timer = null;

/**
 * Start background polling if HA is configured. Idempotent. If HA is not configured
 * the bridge stays idle and the engine simply uses its honest fallback — this is a
 * normal, supported state, not an error.
 * @returns {boolean} whether polling was started
 */
function start() {
  if (timer) return true;
  const cfg = config();
  if (!isConfigured(cfg)) {
    console.log('[SARA HA] telemetry bridge idle — not configured. Screens use fallback (location from seed).');
    return false;
  }
  refresh().catch(() => {});
  timer = setInterval(() => refresh().catch(() => {}), cfg.pollMs);
  if (timer.unref) timer.unref(); // never hold the process open just for polling
  console.log(`[SARA HA] telemetry polling every ${cfg.pollMs}ms against ${cfg.baseUrl}`);
  return true;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

// Test hook: inject a snapshot so the engine's live/fallback branches are testable
// without a running Home Assistant. Not used in production code paths.
function _setSnapshotForTest(next) {
  snapshot = next || unavailable('not-configured');
}

module.exports = {
  TELEMETRY_SOURCE,
  SIGNAL_SLOTS,
  config,
  isConfigured,
  getTelemetry,
  refresh,
  start,
  stop,
  mapStatesToTelemetry,
  mapLocation,
  mapPresence,
  mapEnvironment,
  mapProximity,
  unavailable,
  _setSnapshotForTest,
};
