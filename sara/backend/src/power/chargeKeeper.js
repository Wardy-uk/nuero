'use strict';

/**
 * Keeps a wall-powered phone or tablet between sensible charge levels, through a Home
 * Assistant smart socket.
 *
 * Nick, 11 Sep 2026: an old phone left on charge at 100% for months is how a battery
 * swells — the P30 lite in the bedroom lives on a socket, so the socket is switched
 * instead: on below LOW, off above HIGH, left alone in between.
 *
 * ⚠ THE DEVICE REPORTS ITS OWN BATTERY, over the reading it already sends every few
 * seconds. Deliberately NOT Home Assistant's Companion app: that is a second app for
 * Huawei's power manager to kill, and a second login, for a number we already have.
 *
 * ⚠ UNKNOWN MEANS CHARGE. A stale reading, a battery the device could not read, a
 * sensor that has stopped — every one of those turns the socket ON. A flat phone is a
 * dead sensor and a dark screen, and "I cannot tell" must never leave it discharging.
 * The opposite failure (charging a little longer than ideal) costs almost nothing.
 *
 * ⚠ It acts only when the socket is not already where it should be, so an idle house
 * generates no service calls; and it re-asserts, so a socket switched off by hand while
 * the phone is low comes back on at the next tick.
 *
 * `parse` and `decide` are PURE.
 */

const store = require('../presence/store');

const TICK_MS = 60 * 1000;
// Past this a reading is not evidence about the battery now.
const STALE_MS = 5 * 60 * 1000;
const DEFAULT_LOW = 40;
const DEFAULT_HIGH = 80;

/**
 * "bedroom=switch.bedroom_socket_1:40:80,study=switch.x" -> Map. PURE.
 * Thresholds are optional. Anything malformed is dropped rather than guessed at.
 */
function parse(raw) {
  const out = new Map();
  for (const part of String(raw || '').split(',')) {
    const [room, spec] = part.split('=').map((s) => (s || '').trim());
    if (!/^[a-z0-9-]{1,40}$/.test(room || '') || !spec) continue;
    const [entity, lowRaw, highRaw] = spec.split(':');
    if (!/^switch\.[a-z0-9_]+$/.test(entity || '')) continue;
    const low = lowRaw === undefined || lowRaw === '' ? DEFAULT_LOW : Number(lowRaw);
    const high = highRaw === undefined || highRaw === '' ? DEFAULT_HIGH : Number(highRaw);
    if (!Number.isFinite(low) || !Number.isFinite(high) || low < 5 || high > 100 || low >= high) continue;
    out.set(room, { entity, low, high });
  }
  return out;
}

/**
 * Where should the socket be? PURE.
 * @returns {{desired: 'on'|'off'|null, why: string}} — null means leave it alone.
 */
function decide(reading, { low, high }, now = Date.now(), staleMs = STALE_MS) {
  if (!reading) return { desired: 'on', why: 'no reading from this room — charging' };
  const ageMs = reading.at ? now - new Date(reading.at).getTime() : NaN;
  if (!Number.isFinite(ageMs) || ageMs > staleMs) {
    return { desired: 'on', why: 'the sensor has gone quiet — charging' };
  }
  const pct = reading.batteryPct;
  if (!Number.isFinite(pct)) return { desired: 'on', why: 'battery not reported — charging' };
  if (pct <= low) return { desired: 'on', why: `battery ${pct}% — charging` };
  if (pct >= high) return { desired: 'off', why: `battery ${pct}% — holding` };
  return { desired: null, why: `battery ${pct}% — between ${low} and ${high}, leaving it` };
}

function createKeeper({ env = process.env, fetchImpl = (...a) => fetch(...a), log = console } = {}) {
  const keepers = parse(env.SARA_CHARGE_KEEPERS);
  const lastLogged = new Map();
  let timer = null;

  const base = () => (env.SARA_HA_BASE_URL || '').replace(/\/+$/, '');
  const token = () => env.SARA_HA_TOKEN || '';

  async function ha(path, init) {
    const res = await fetchImpl(`${base()}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
    return res.json().catch(() => null);
  }

  async function apply(room, { entity, low, high }, now = Date.now()) {
    const reading = store.all()[room] || null;
    const { desired, why } = decide(reading, { low, high }, now);
    if (!desired) return { room, entity, desired, why, changed: false };

    if (!base() || !token()) {
      log.warn(`[charge] ${room}: Home Assistant not configured — cannot switch ${entity}`);
      return { room, entity, desired, why, changed: false, error: 'ha-not-configured' };
    }
    try {
      const state = await ha(`/api/states/${entity}`);
      const current = state && typeof state.state === 'string' ? state.state : null;
      if (current === desired) {
        // Log a state only when it changes, or an always-on socket writes a line a minute.
        if (lastLogged.get(room) !== why) { log.log(`[charge] ${room}: ${why} (socket already ${desired})`); lastLogged.set(room, why); }
        return { room, entity, desired, why, changed: false };
      }
      await ha(`/api/services/switch/turn_${desired}`, { method: 'POST', body: JSON.stringify({ entity_id: entity }) });
      log.log(`[charge] ${room}: ${why} — switched ${entity} ${desired}${current ? ` (was ${current})` : ''}`);
      lastLogged.set(room, why);
      return { room, entity, desired, why, changed: true };
    } catch (e) {
      log.warn(`[charge] ${room}: ${e.message} — leaving ${entity} as it is`);
      return { room, entity, desired, why, changed: false, error: e.message };
    }
  }

  async function tick(now = Date.now()) {
    const out = [];
    for (const [room, cfg] of keepers) out.push(await apply(room, cfg, now));
    return out;
  }

  function start() {
    if (!keepers.size) {
      log.log('[charge] SARA_CHARGE_KEEPERS not set — battery keeping off');
      return false;
    }
    log.log(`[charge] keeping: ${[...keepers].map(([r, c]) => `${r} ${c.entity} ${c.low}-${c.high}%`).join(', ')}`);
    timer = setInterval(() => { tick().catch((e) => log.warn('[charge] tick failed: ' + e.message)); }, TICK_MS);
    if (timer.unref) timer.unref();
    tick().catch(() => {});
    return true;
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { start, stop, tick, apply, keepers };
}

module.exports = { createKeeper, parse, decide, TICK_MS, STALE_MS, DEFAULT_LOW, DEFAULT_HIGH };
