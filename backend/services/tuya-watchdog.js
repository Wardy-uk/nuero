'use strict';

/**
 * Notices when Home Assistant's Tuya integration has stopped hearing its devices,
 * and reloads it.
 *
 * 1 Nov 2026, 14:55: Tuya answered HA's MQTT re-connect with API_QPS_LIMIT_OR_DEGRADE.
 * The library HA ships (tuya_sharing) retries only a RequestException, so the plain
 * Exception killed the push thread for good. Commands still went out (a separate HTTP
 * path), state never came back, and HA logged one line. Every Tuya entity froze for
 * ~115 hours; the bedroom charger was switched off and HA kept saying "on" until the
 * Fire ran flat (6 Nov). Reloading the config entry restarts the thread.
 *
 * ⚠ The canaries are Tuya entities that report on their own: the three T&H sensors
 * (each changed at least every ~6h over the ten days before) and the Galaxy plug's
 * energy (hourly). The UNION of them is never quiet for long, so "every canary silent
 * for STALE_MS" is the signature — measured: all four stopped within a minute of
 * each other on 1 Nov. One quiet canary is a flat battery, not a dead integration.
 *
 * ⚠ UNKNOWN DOES NOTHING. HA unreachable, or no canary in its states, is not evidence
 * that Tuya is dead, and reloading on it would reload on every HA restart.
 *
 * Reload at most once per RELOAD_COOLDOWN_MS. If the canaries are still silent
 * STILL_DEAD_AFTER_MS after a reload, one push (sense_alert) per episode — that is the
 * case a reload cannot fix (Tuya account, token, the cloud itself). `assess` is PURE.
 */

const STATE_KEY = 'tuya_watchdog';
const CRON = '*/10 * * * *';
const STALE_MS = 3 * 60 * 60 * 1000;
const RELOAD_COOLDOWN_MS = 60 * 60 * 1000;
const STILL_DEAD_AFTER_MS = 30 * 60 * 1000;
const DEFAULT_CANARIES = [
  'sensor.office_sensor_temperature',
  'sensor.kitchen_sensor_temperature',
  'sensor.washroom_sensor_temperature',
  'sensor.smart_plug_total_energy',
];

function canaries(env = process.env) {
  const raw = String(env.TUYA_CANARY_ENTITIES || '').split(',').map((s) => s.trim()).filter(Boolean);
  return raw.length ? raw : DEFAULT_CANARIES;
}

function _heardAt(s) {
  const t = Date.parse((s && (s.last_reported || s.last_updated || s.last_changed)) || '');
  return Number.isFinite(t) ? t : null;
}

/**
 * Is the Tuya integration still hearing its devices? PURE.
 * @returns {{state: 'ok'|'stale'|'unknown', newestAt: number|null, why: string, seen: number}}
 */
function assess(states, now, { entities = DEFAULT_CANARIES, staleMs = STALE_MS } = {}) {
  if (!Array.isArray(states) || !states.length) return { state: 'unknown', newestAt: null, why: 'Home Assistant could not be read', seen: 0 };
  const byId = new Map(states.map((s) => [s.entity_id, s]));
  const heard = entities.map((e) => byId.get(e)).filter(Boolean).map(_heardAt).filter((t) => t !== null);
  if (!heard.length) return { state: 'unknown', newestAt: null, why: 'none of the Tuya canary entities are in Home Assistant', seen: 0 };
  const newestAt = Math.max(...heard);
  const age = now - newestAt;
  if (age > staleMs) {
    return { state: 'stale', newestAt, seen: heard.length, why: `no Tuya device has reported for ${Math.round(age / 60000)} minutes` };
  }
  return { state: 'ok', newestAt, seen: heard.length, why: 'Tuya devices are reporting' };
}

function _load(db) {
  try { return JSON.parse(db.getState(STATE_KEY) || '{}') || {}; } catch { return {}; }
}

function _save(db, s) {
  try { db.setState(STATE_KEY, JSON.stringify(s)); } catch (e) { console.warn('[TuyaWatchdog] could not save state:', e.message); }
}

function _log(kind, detail) {
  try { require('./personal-obligations').logEvent(kind, { subjectId: 'tuya', actor: 'neuro', detail }); }
  catch (e) { console.warn('[TuyaWatchdog] activity log failed:', e.message); }
}

/**
 * One pass. Everything with a side effect is injectable so tests touch no network.
 */
async function tick({
  now = Date.now(),
  db = require('../db/database'),
  fetchStates = () => require('./ha').fetchStates(),
  reload = _reload,
  push = (t, b, d) => require('./webpush').sendToAll(t, b, d),
  log = _log,
  env = process.env,
} = {}) {
  let states = null;
  try { states = await fetchStates(); } catch { states = null; }
  const entities = canaries(env);
  const a = assess(states, now, { entities });
  const s = _load(db);

  if (a.state === 'unknown') return { ...a, acted: null };

  if (a.state === 'ok') {
    if (s.episodeAt) {
      log('tuya-push-recovered', { silentSince: s.silentSince || null, reloads: s.reloads || 0 });
      _save(db, { lastOkAt: now });
      return { ...a, acted: 'recovered' };
    }
    if (!s.lastOkAt || now - s.lastOkAt > 60 * 60 * 1000) _save(db, { ...s, lastOkAt: now });
    return { ...a, acted: null };
  }

  // Stale.
  const next = { ...s, episodeAt: s.episodeAt || now, silentSince: a.newestAt };
  if (!s.lastReloadAt || now - s.lastReloadAt >= RELOAD_COOLDOWN_MS) {
    let ok = false; let why = null;
    try { await reload(entities[0], env); ok = true; } catch (e) { why = e.message; }
    next.lastReloadAt = now;
    next.reloads = (s.reloads || 0) + 1;
    log(ok ? 'tuya-push-reloaded' : 'tuya-push-reload-failed', { why: a.why, error: why, silentSince: a.newestAt });
    console.warn(`[TuyaWatchdog] ${a.why} — ${ok ? 'reloaded the Tuya integration' : `reload failed: ${why}`}`);
    _save(db, next);
    return { ...a, acted: ok ? 'reloaded' : 'reload-failed', error: why };
  }
  if (!s.alertedAt && now - s.lastReloadAt >= STILL_DEAD_AFTER_MS) {
    next.alertedAt = now;
    _save(db, next);
    log('tuya-push-still-dead', { why: a.why, reloads: next.reloads || 0 });
    try {
      await push('⚠ Tuya devices have gone quiet',
        `${a.why}. NEURO reloaded the Tuya integration and it has not come back — check Home Assistant's Tuya integration. Plugs, bulbs and the charger sockets may not be doing what HA says.`,
        { type: 'sense_alert', key: 'tuya-push-dead' });
    } catch (e) { console.warn('[TuyaWatchdog] push failed:', e.message); }
    return { ...a, acted: 'alerted' };
  }
  _save(db, next);
  return { ...a, acted: null };
}

async function _reload(entityId, env = process.env) {
  if (env.NODE_TEST_CONTEXT) throw new Error('refusing to reload Home Assistant from a test');
  const base = (env.HA_URL || 'http://localhost:8123').replace(/\/$/, '');
  const res = await fetch(`${base}/api/services/homeassistant/reload_config_entry`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.HA_TOKEN || ''}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ entity_id: entityId }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
}

function register({ schedule = null } = {}) {
  const sched = schedule || require('./cron-once').createCron(require('node-cron')).schedule;
  return sched(CRON, () => { tick().catch((e) => console.warn('[TuyaWatchdog] tick failed:', e.message)); }, { timezone: 'Europe/London' });
}

module.exports = { assess, tick, register, canaries, CRON, STALE_MS, RELOAD_COOLDOWN_MS, STILL_DEAD_AFTER_MS, DEFAULT_CANARIES, STATE_KEY };
