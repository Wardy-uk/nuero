'use strict';

/**
 * The meeting-promises shadow's NETWORK CONTRACT (19 Oct 2026).
 *
 * Every request made while a shadow pass is running — by the shadow itself or
 * by anything it calls, canonical Now included — is checked here BEFORE it
 * reaches the network. Only these exact local read operations are allowed:
 *
 *   ha.states          GET  http://localhost:8123/api/states
 *   ha.weather-state   GET  http://localhost:8123/api/states/<weather entity>
 *                           (HA_WEATHER_ENTITY, else weather.forecast_home)
 *   ha.history         GET  http://localhost:8123/api/history/period/<ISO instant>
 *                           query keys only filter_entity_id, end_time,
 *                           minimal_response, no_attributes
 *   ha.template        POST http://localhost:8123/api/template
 *                           body exactly {"template": "<string>"}, no query
 *   saim.room-presence GET  http://localhost:3005/api/presence/room
 *
 * Everything else is REFUSED, before any network: another host, scheme or
 * port, another method, any other Home Assistant path — and every
 * /api/services/* and /api/events/* call outright (a Home Assistant service
 * or action is how its state is changed). That includes the hourly
 * weather/get_forecasts call normal Now makes: it is a service call, so the
 * shadow's Now carries current conditions without the hourly outlook. The
 * outlook is presentation only and never reaches the promise gate.
 *
 * A template render cannot change Home Assistant state; it is allowed ONLY at
 * its exact endpoint with a body holding nothing but the template text.
 *
 * Enforced with AsyncLocalStorage: the fetch guard is installed by the first
 * shadow pass (so never while the flag is off) and only ever judges requests
 * made inside a pass. Requests made by the rest of the backend pass straight
 * through, untouched. A refusal throws a ShadowNetRefused carrying a CATEGORY
 * only — never the URL, a header, the token or a body — and is counted.
 * Pinned by promise-shadow-net.test.js.
 */

const { AsyncLocalStorage } = require('async_hooks');

const HA_ORIGIN = 'http://localhost:8123';
const PRESENCE_ORIGIN = 'http://localhost:3005';
const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;
const HISTORY_PARAMS = new Set(['filter_entity_id', 'end_time', 'minimal_response', 'no_attributes']);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const ALLOWED = Object.freeze(['ha.states', 'ha.weather-state', 'ha.history', 'ha.template', 'saim.room-presence']);

class ShadowNetRefused extends Error {
  constructor(category) {
    super(`shadow network contract: refused (${category})`);
    this.name = 'ShadowNetRefused';
    this.category = category;
  }
}

const weatherEntity = (env = process.env) => env.HA_WEATHER_ENTITY || 'weather.forecast_home';

function _method(init) { return String((init && init.method) || 'GET').toUpperCase(); }

function _bodyIsTemplateOnly(body) {
  if (typeof body !== 'string') return false;
  let v;
  try { v = JSON.parse(body); } catch { return false; }
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).length === 1 && typeof v.template === 'string';
}

/**
 * PURE. Judge one request: { ok: true, op } or { ok: false, category }. Takes
 * the same (input, init) fetch takes; never looks at headers.
 */
function check(input, init = {}, env = process.env) {
  let u;
  try { u = new URL(typeof input === 'string' ? input : (input && input.url) || String(input)); } catch { return { ok: false, category: 'unparseable-url' }; }
  const method = _method(init);
  if (u.username || u.password) return { ok: false, category: 'credentials-in-url' };
  if (u.hash) return { ok: false, category: 'fragment' };

  if (u.origin === PRESENCE_ORIGIN) {
    if (u.pathname !== '/api/presence/room') return { ok: false, category: 'presence-path' };
    if (method !== 'GET') return { ok: false, category: 'presence-method' };
    if (u.search) return { ok: false, category: 'presence-query' };
    if (init && init.body != null) return { ok: false, category: 'presence-body' };
    return { ok: true, op: 'saim.room-presence' };
  }

  if (u.origin !== HA_ORIGIN) return { ok: false, category: 'destination' };

  const p = u.pathname;
  if (p.startsWith('/api/services') || p.startsWith('/api/events')) return { ok: false, category: 'ha-service-or-event' };

  if (p === '/api/template') {
    if (method !== 'POST') return { ok: false, category: 'ha-template-method' };
    if (u.search) return { ok: false, category: 'ha-template-query' };
    if (!_bodyIsTemplateOnly(init && init.body)) return { ok: false, category: 'ha-template-body' };
    return { ok: true, op: 'ha.template' };
  }

  if (method !== 'GET') return { ok: false, category: 'ha-method' };
  if (init && init.body != null) return { ok: false, category: 'ha-body' };

  if (p === '/api/states') return u.search ? { ok: false, category: 'ha-states-query' } : { ok: true, op: 'ha.states' };
  if (p.startsWith('/api/states/')) {
    const id = decodeURIComponent(p.slice('/api/states/'.length));
    if (!ENTITY_ID.test(id) || id !== weatherEntity(env)) return { ok: false, category: 'ha-state-entity' };
    return u.search ? { ok: false, category: 'ha-state-query' } : { ok: true, op: 'ha.weather-state' };
  }
  if (p.startsWith('/api/history/period/')) {
    const from = decodeURIComponent(p.slice('/api/history/period/'.length));
    if (!ISO_INSTANT.test(from)) return { ok: false, category: 'ha-history-path' };
    for (const k of u.searchParams.keys()) if (!HISTORY_PARAMS.has(k)) return { ok: false, category: 'ha-history-query' };
    return { ok: true, op: 'ha.history' };
  }
  return { ok: false, category: 'ha-path' };
}

// ── Enforcement ──────────────────────────────────────────────────────────────

const _als = new AsyncLocalStorage();
const _counts = { allowed: {}, refused: {} };

/** Run fn as a shadow pass: every fetch inside it (and anything it starts) is judged. */
function run(fn) { install(); return _als.run({ shadow: true }, fn); }

function inShadow() { const s = _als.getStore(); return Boolean(s && s.shadow); }

/**
 * Wrap global fetch once. Outside a shadow pass the wrapper calls the original
 * unchanged. Re-installs if something has since replaced global fetch.
 */
function install() {
  const current = globalThis.fetch;
  if (typeof current !== 'function' || current.__promiseShadowGuard) return;
  const original = current;
  const guarded = function promiseShadowFetch(input, init) {
    if (!inShadow()) return original.call(this, input, init);
    const v = check(input, init);
    if (!v.ok) {
      _counts.refused[v.category] = (_counts.refused[v.category] || 0) + 1;
      return Promise.reject(new ShadowNetRefused(v.category));
    }
    _counts.allowed[v.op] = (_counts.allowed[v.op] || 0) + 1;
    return original.call(this, input, init);
  };
  guarded.__promiseShadowGuard = true;
  guarded.__original = original;
  globalThis.fetch = guarded;
}

function installed() { return Boolean(globalThis.fetch && globalThis.fetch.__promiseShadowGuard); }

/** Counts by operation / refusal category — never a URL. */
function counts() { return { allowed: { ..._counts.allowed }, refused: { ..._counts.refused } }; }
function _resetCounts() { _counts.allowed = {}; _counts.refused = {}; }

module.exports = { ALLOWED, HA_ORIGIN, PRESENCE_ORIGIN, ShadowNetRefused, check, run, inShadow, install, installed, counts, weatherEntity, _resetCounts };
