'use strict';

/**
 * A READ-ONLY pass (19 Oct 2026): everything that runs inside `run(fn)` may
 * READ, and may not WRITE or make an unlisted network request.
 *
 * Why it exists: SAiM's prepared-move read (GET /api/prepared-moves/current)
 * computes the current decision through canonical Now. Even with
 * `readOnly: true`, that path refreshes the location dwell cache in
 * agent_state and reverse-geocodes with Nominatim (found on 19 Oct by a
 * before/after fingerprint once the cache was stale). A read Nick's screen
 * makes on every load must not write a row or send his position anywhere.
 *
 * ISOLATION — per async context, never a process-wide mode:
 *   - the pass lives in an AsyncLocalStorage store, so only work that descends
 *     from `run(fn)` sees it; a request running at the same time does not;
 *   - the store is CLOSED when `run` settles (resolve, throw or reject), so a
 *     timer, promise or callback created inside the pass that fires later does
 *     NOT inherit read-only status — it behaves like any other code.
 *
 * Inside an OPEN pass:
 *   - `db.run` (and so `db.setState`) refuses — a write throws;
 *   - `fetch` is allowed ONLY for the exact local reads the read-only Now is
 *     known to make, judged by `promise-shadow-net.check` (the same contract the
 *     meeting-promises shadow runs its read-only Now under, unchanged):
 *       GET  http://localhost:8123/api/states                (no query)
 *       GET  http://localhost:8123/api/states/<HA_WEATHER_ENTITY or weather.forecast_home>
 *       GET  http://localhost:8123/api/history/period/<ISO instant>
 *            (query keys filter_entity_id, end_time, minimal_response, no_attributes only)
 *       POST http://localhost:8123/api/template               (body exactly {"template": "…"})
 *       GET  http://localhost:3005/api/presence/room          (no query, no body)
 *     Everything else — Nominatim, Graph, any public or non-local host, any
 *     other port, 127.0.0.1 spelled differently, any other path or method — is
 *     refused BEFORE the request leaves the process;
 *   - `http.request` / `https.request` / `.get` and `WebSocket` are refused
 *     outright (the read-only Now needs neither);
 *   - location's dwell cache answers from what it holds, without refreshing.
 * Each refusal is counted on the pass, by category only (never a URL or body).
 */

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
let installed = false;

/** The open pass for the CURRENT async context, or null. */
function active() {
  const s = als.getStore();
  return s && s.open ? s : null;
}

function _count(s, why) { s.refused[why] = (s.refused[why] || 0) + 1; }

/** PURE. null = allowed; otherwise the refusal category. */
function netDecision(input, init = {}) {
  const c = require('./promise-shadow-net').check(input, init || {});
  return c.ok ? null : c.category;
}

function _install() {
  if (installed) return;
  installed = true;
  const innerFetch = global.fetch;
  global.fetch = function readOnlyAwareFetch(input, init) {
    const s = active();
    if (s) {
      const why = netDecision(input, init);
      if (why) { _count(s, why); return Promise.reject(new Error(`network refused in a read-only pass (${why})`)); }
    }
    return innerFetch.apply(this, arguments);
  };
  for (const name of ['http', 'https']) {
    const mod = require(name);
    for (const fn of ['request', 'get']) {
      const inner = mod[fn];
      mod[fn] = function readOnlyAware(...args) {
        const s = active();
        if (s) { _count(s, `${name}-module`); throw new Error(`network refused in a read-only pass (${name}-module)`); }
        return inner.apply(this, args);
      };
    }
  }
  if (typeof global.WebSocket === 'function') {
    const Inner = global.WebSocket;
    global.WebSocket = new Proxy(Inner, {
      construct(target, args, newTarget) {
        const s = active();
        if (s) { _count(s, 'websocket'); throw new Error('network refused in a read-only pass (websocket)'); }
        return Reflect.construct(target, args, newTarget);
      },
    });
  }
}

/**
 * Run `fn` as a read-only pass. Resolves to { result, refused, writesRefused }.
 * The pass is closed when `fn` settles, whatever the outcome, and a rejection
 * propagates unchanged.
 */
async function run(fn) {
  _install();
  const store = { open: true, refused: {}, writesRefused: 0 };
  try {
    const result = await als.run(store, fn);
    return { result, refused: store.refused, writesRefused: store.writesRefused };
  } finally {
    store.open = false;
  }
}

/** Called by db.run: inside an open pass, a write is refused. */
function refuseWrite(sql) {
  const s = active();
  if (!s) return;
  s.writesRefused += 1;
  throw new Error(`write refused in a read-only pass (${String(sql).trim().split(/\s+/)[0].toUpperCase()})`);
}

module.exports = { run, active, refuseWrite, netDecision };
