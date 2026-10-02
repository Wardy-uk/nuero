'use strict';

// Is anyone ELSE home? — read for one decision only: whether a home screen
// should show the household board while Nick is out, or go dark.
//
// Nick, 2 Oct 2026: a home screen he is not in the room with "needs to display
// generic useful stuff". When he is out of the house that is still true if
// Helen or Isaac is in — and a lit board in an empty house helps nobody.
//
// ⚠ `binary_sensor.household_others_home` is HA's (Life360 for who, the router
// for whether), and it goes `unavailable` rather than `off` whenever a resident
// could not be read. So only a literal `on` counts; anything else — off,
// unavailable, unreadable, not configured — keeps today's behaviour (screen off).
// Failing towards dark here costs nothing private and nothing anyone needs.
//
// Cached and refreshed in the background, never on the display poll.

const ENTITY = process.env.SAIM_HA_HOUSEHOLD_ENTITY || 'binary_sensor.household_others_home';
const TTL_MS = 60_000;

const cache = { othersHome: null, at: 0, inFlight: false };

function refresh(now = Date.now()) {
  if (cache.inFlight || now - cache.at < TTL_MS) return;
  const base = (process.env.SAIM_HA_BASE_URL || '').replace(/\/+$/, '');
  const token = process.env.SAIM_HA_TOKEN;
  if (!base || !token) { cache.at = now; return; }
  cache.inFlight = true;
  fetch(`${base}/api/states/${ENTITY}`, {
    headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(4000),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { cache.othersHome = d && d.state === 'on' ? true : (d && d.state === 'off' ? false : null); })
    .catch(() => { cache.othersHome = null; })
    .finally(() => { cache.at = Date.now(); cache.inFlight = false; });
}

/** true only when HA positively says someone else is home. */
function othersHome(now = Date.now()) {
  refresh(now);
  return cache.othersHome === true;
}

module.exports = { othersHome, _cache: cache };
