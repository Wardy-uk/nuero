'use strict';

/**
 * "Who's in the house" — can NEURO actually tell? (31 Oct 2026)
 *
 * The household sensor (HA `binary_sensor.household_others_home`) can be
 * WRONG while looking fine, and on 31 Oct it was, twice in one afternoon:
 *
 *  1. HA restarted at 14:40 and the ASUS router integration came up
 *     `setup_error`. Every router tracker read `unavailable` for hours. The
 *     sensor stayed `on` because Helen's Life360 said home, so Isaac being
 *     unreadable was a side detail nobody read.
 *  2. At 18:43 the router started wedging (fork exhaustion). HA's router feed
 *     returned no clients and EVERY router tracker flipped to `not_home` at
 *     once — the wall tablets included, which never leave the house. Isaac,
 *     tracked by the router alone, read "Out" while he was upstairs. Note that
 *     is `away`, not unknown: a "resident unreadable" rule alone misses it.
 *
 * So this judges the FEED, not just the answer. PURE: states in, verdict out.
 *
 * ⚠ "Every router tracker not home" is the signature of a broken feed, not an
 *   empty house: the wall tablets and the bedroom sensor phone are on the
 *   Wi-Fi permanently. It needs at least MIN_ROUTER_TRACKERS so one tracker
 *   going quiet is never read as the whole router.
 */

const HOUSEHOLD_SENSOR = process.env.HA_HOUSEHOLD_SENSOR || 'binary_sensor.household_others_home';
const CACHE_STALE_MINUTES = 15;
const MIN_ROUTER_TRACKERS = 3;
const BLIND = new Set(['unavailable', 'unknown', '', 'none']);

function names(v) {
  return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
}

/**
 * @param {Array|null} states  HA states (ha.cachedStates()), or null if never read
 * @param {{ cachedAt?: number|null, now?: Date }} opts
 * @returns {{ state: 'live'|'stale'|'error', why?: string, detail?: string|null, ageMinutes?: number|null }}
 */
function assess(states, { cachedAt = null, now = new Date() } = {}) {
  if (!Array.isArray(states) || !states.length) {
    return { state: 'stale', ageMinutes: null, why: 'Home Assistant has not been read yet' };
  }
  const ageMinutes = Number.isFinite(cachedAt) ? Math.max(0, Math.round((now.getTime() - cachedAt) / 60000)) : null;
  if (ageMinutes != null && ageMinutes > CACHE_STALE_MINUTES) {
    return { state: 'stale', ageMinutes, why: `Home Assistant last answered ${ageMinutes} min ago` };
  }

  const router = states.filter((s) => s && String(s.entity_id).startsWith('device_tracker.')
    && s.attributes && s.attributes.source_type === 'router');
  if (router.length >= MIN_ROUTER_TRACKERS) {
    if (router.every((s) => BLIND.has(String(s.state)))) {
      return { state: 'error', ageMinutes, why: 'the router integration in Home Assistant is not running — nobody on the Wi-Fi can be seen',
        detail: 'Settings → Devices & services → ASUSWRT; the router watch on pi5 reloads it' };
    }
    if (router.every((s) => String(s.state) === 'not_home')) {
      return { state: 'error', ageMinutes, why: `the router says none of its ${router.length} devices are home, wall tablets included — its client list is broken (check the Home router row)`,
        detail: 'anyone tracked by Wi-Fi alone will read as out' };
    }
  }

  const sensor = states.find((s) => s && s.entity_id === HOUSEHOLD_SENSOR);
  if (!sensor) return { state: 'error', ageMinutes, why: `no ${HOUSEHOLD_SENSOR} in Home Assistant` };
  const a = sensor.attributes || {};
  const unreadable = names(a.unreadable);
  if (unreadable.length) {
    return { state: 'error', ageMinutes, why: `cannot tell whether ${unreadable.join(' and ')} ${unreadable.length > 1 ? 'are' : 'is'} in` };
  }
  if (BLIND.has(String(sensor.state))) {
    return { state: 'error', ageMinutes, why: `the household sensor is ${sensor.state}` };
  }
  const rotated = names(a.mac_rotated);
  if (rotated.length) {
    return { state: 'error', ageMinutes, why: `a phone has a new Wi-Fi address: ${rotated.join('; ')}`,
      detail: 'point the person at the new tracker in Home Assistant' };
  }
  const who = names(a.who_is_home);
  return { state: 'live', ageMinutes, detail: who.length ? `${who.join(', ')} in` : 'nobody else in' };
}

module.exports = { assess, CACHE_STALE_MINUTES, MIN_ROUTER_TRACKERS };
