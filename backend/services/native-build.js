'use strict';

/**
 * Which native build is talking (Build 18D/U/Y, 7 Oct 2026).
 *
 * "Was this actually deployed?" had no answer from the server. Every iOS app
 * build sent `Neuro/1` or `Saim/1` as its User-Agent — the number after the
 * slash IS CFBundleVersion, and it has been 1 on every build ever made — so
 * the phone running 58df50a and the phone running dbf53da looked identical.
 * Six builds' worth of native work (13–17) were "committed, unbuilt" with
 * nothing on the server able to say which of them was installed.
 *
 * ── The header ──────────────────────────────────────────────────────────────
 *   X-Neuro-Build: v=1.4;b=58;c=dbf53da;p=18;cap=durable-location-queue,…
 *     v    marketing version (CFBundleShortVersionString)
 *     b    build number (CFBundleVersion)
 *     c    git commit, when the build stamped one (short hex) — else absent
 *     p    protocol: the NEURO build whose contract the app speaks
 *     cap  the capabilities this binary has, by name
 * The client id itself comes from `X-Neuro-Client` (native-sources.resolveClient)
 * — one identity, never two that could disagree.
 *
 * ⚠ NOTHING ELSE. No device name, serial, vendor id or user identifier: a
 *   build is a fact about a BINARY, and this is the only thing it may describe.
 *   Unknown keys are dropped, every value is length- and charset-bounded.
 * ⚠ A MISSING HEADER IS "UNKNOWN", NEVER "OLD". A build without it predates
 *   this, so it cannot have any Build 18 capability — but it may well have the
 *   Build 16/17 ones. So it says "NEURO can't confirm", not "it lacks".
 * ⚠ CAPABILITIES ARE DECLARED BY THE BINARY, NOT INFERRED FROM VERSION
 *   NUMBERS. A version string says nothing about what code is in it; a
 *   capability name is written beside the code that provides it.
 */

const db = require('../db/database');

const CLIENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CAP_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_CAPS = 32;
// A seen build is re-stamped at most this often per process — the header rides
// on EVERY request, and a write per request would make the bookkeeping cost
// more than the call.
const TOUCH_EVERY_MS = 10 * 60 * 1000;

/**
 * The capability vocabulary, and the build that introduced each. Declared
 * here so a capability nobody has defined cannot quietly satisfy a requirement.
 */
const CAPABILITIES = Object.freeze({
  'build-report': { since: 18, what: 'reports its own build to NEURO' },
  'outbox-quarantine': { since: 13, what: 'quarantines a corrupt queued item instead of losing the queue' },
  'durable-location-queue': { since: 16, what: 'keeps location, visits and geofence events on disk until NEURO acknowledges them' },
  'place-visits': { since: 16, what: 'sends iOS visits (arrival and departure)' },
  geofence: { since: 16, what: 'monitors saved places and sends enter/exit' },
  'device-status': { since: 16, what: 'reports the phone\'s own status (battery, motion, focus)' },
  'workout-route-summary': { since: 17, what: 'sends a GPS route SUMMARY with hiking/walking workouts (count and times, never coordinates)' },
  'calendar-window-60d': { since: 18, what: 'pushes 60 days of the phone diary ahead, not 14' },
  'calendar-types': { since: 18, what: 'reports each calendar\'s kind (local, subscribed, birthdays…)' },
  'route-permission-report': { since: 18, what: 'reports whether workout-route access was ever asked for' },
});

/**
 * What each source needs from the build behind it to be trusted at full
 * strength. A source that is reporting from a build missing one of these is
 * REPORTING but not HEALTHY in the way Build 16/17/18 promised (18U).
 */
const REQUIREMENTS = Object.freeze({
  'location.neuro-ios': ['durable-location-queue', 'place-visits', 'geofence'],
  'device.neuro-ios': ['device-status'],
  'device.saim-ios': ['device-status'],
  'healthkit.neuro-ios': ['workout-route-summary'],
  'healthkit.saim-ios': ['workout-route-summary'],
  'eventkit.neuro-ios': ['calendar-window-60d'],
  'eventkit.saim-ios': ['calendar-window-60d'],
});

function _clip(v, n, re) {
  const s = String(v == null ? '' : v).trim().slice(0, n);
  return s && re.test(s) ? s : null;
}

/**
 * Parse the header. PURE. Returns null when there is no usable header at all
 * (an older build), never a half-invented object.
 */
function parseBuildHeader(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1200) return null;
  const parts = {};
  for (const seg of raw.split(';')) {
    const i = seg.indexOf('=');
    if (i <= 0) continue;
    const k = seg.slice(0, i).trim().toLowerCase();
    if (!['v', 'b', 'c', 'p', 'cap', 'd'].includes(k) || k in parts) continue;
    parts[k] = seg.slice(i + 1).trim();
  }
  const version = _clip(parts.v, 24, /^[0-9A-Za-z.+-]+$/);
  const build = _clip(parts.b, 24, /^[0-9A-Za-z.+-]+$/);
  if (!version && !build) return null;
  const commit = _clip(parts.c, 40, /^[0-9a-f]{7,40}$/i);
  const p = Number.parseInt(parts.p, 10);
  const protocol = Number.isInteger(p) && p > 0 && p < 1000 ? p : null;
  const caps = String(parts.cap || '').split(',').map((c) => c.trim().toLowerCase())
    .filter((c) => CAP_PATTERN.test(c));
  return {
    version, build, commit: commit ? commit.toLowerCase() : null, protocol,
    // Built from a working tree with uncommitted changes: the commit is then
    // where it STARTED, not what it is — and the label says so.
    dirty: parts.d === '1',
    capabilities: [...new Set(caps)].sort().slice(0, MAX_CAPS),
  };
}

/** PURE. The id a build row is keyed on. */
function buildKey(client, b) {
  return `${client}|${b.version || ''}|${b.build || ''}|${b.commit || ''}${b.dirty ? '+dirty' : ''}`;
}

/** PURE. "1.4 (58) · dbf53da" — never an empty string. */
function label(b) {
  if (!b) return 'unknown build';
  const head = [b.version, b.build ? `(${b.build})` : null].filter(Boolean).join(' ');
  return `${head || 'unversioned'}${b.commit ? ` · ${b.commit.slice(0, 7)}${b.dirty ? ' + uncommitted changes' : ''}` : ''}`;
}

/**
 * PURE. Does the build behind a source have what the source needs?
 *   state 'current'  — every required capability declared
 *   state 'old'      — the build REPORTED and lacks something (definite)
 *   state 'unknown'  — no build reported (predates Build 18): cannot confirm
 *   state 'n/a'      — the source has no requirements
 */
function assessSource(sourceId, build) {
  const need = REQUIREMENTS[sourceId] || [];
  if (!need.length) return { state: 'n/a', missing: [], line: null };
  if (!build) {
    return { state: 'unknown', missing: need,
      line: `NEURO can't tell which build this is (it predates build reporting), so it can't confirm: ${need.map((c) => CAPABILITIES[c].what).join('; ')}.` };
  }
  const have = new Set(build.capabilities || []);
  const missing = need.filter((c) => !have.has(c));
  if (!missing.length) return { state: 'current', missing: [], line: null };
  return { state: 'old', missing,
    line: `Reporting, but this build (${label(build)}) predates: ${missing.map((c) => CAPABILITIES[c].what).join('; ')}.` };
}

// ── storage ─────────────────────────────────────────────────────────────────

const _touched = new Map();

/**
 * Record a build seen on a request. Never throws — a bookkeeping failure must
 * never fail the request it rode in on. Returns 'new' | 'touched' | 'skipped'.
 */
function record(client, parsed, { now = Date.now() } = {}) {
  try {
    // A SECOND guard (stated, not mutation-checked): the middleware already
    // drops an `unknown` client before calling this. Kept for other callers.
    if (!parsed || !client || !CLIENT_PATTERN.test(client)) return 'skipped';
    const key = buildKey(client, parsed);
    const last = _touched.get(key);
    if (last && now - last < TOUCH_EVERY_MS) return 'skipped';
    _touched.set(key, now);
    const at = new Date(now).toISOString();
    const r = db.run(`INSERT OR IGNORE INTO native_builds (build_key, client, version, build, git_commit, dirty, protocol, capabilities_json, first_seen_at, last_seen_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [key, client, parsed.version, parsed.build, parsed.commit, parsed.dirty ? 1 : 0, parsed.protocol, JSON.stringify(parsed.capabilities), at, at]);
    if (r.changes) return 'new';
    db.run('UPDATE native_builds SET last_seen_at = ?, capabilities_json = ? WHERE build_key = ?', [at, JSON.stringify(parsed.capabilities), key]);
    return 'touched';
  } catch (e) {
    return 'skipped';
  }
}

function _row(r) {
  return { client: r.client, version: r.version, build: r.build, commit: r.git_commit, dirty: r.dirty === 1, protocol: r.protocol,
    capabilities: (() => { try { return JSON.parse(r.capabilities_json || '[]'); } catch { return []; } })(),
    firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at };
}

/** The newest build each client has reported, keyed by client. */
function current() {
  const out = {};
  try {
    for (const r of db.all('SELECT * FROM native_builds ORDER BY last_seen_at DESC')) {
      if (!out[r.client]) out[r.client] = { ..._row(r), label: label({ version: r.version, build: r.build, commit: r.git_commit, dirty: r.dirty === 1 }) };
    }
  } catch { /* table missing → nothing reported */ }
  return out;
}

function history({ limit = 50 } = {}) {
  try { return db.all('SELECT * FROM native_builds ORDER BY first_seen_at DESC LIMIT ?', [limit]).map(_row); } catch { return []; }
}

/**
 * Express middleware: any request carrying X-Neuro-Build is recorded under its
 * client. Runs after auth, so an unauthenticated caller can never plant a
 * build. Never blocks, never fails the request.
 */
function middleware(req, res, next) {
  try {
    const raw = req.headers['x-neuro-build'];
    if (raw) {
      const parsed = parseBuildHeader(raw);
      if (parsed) {
        const { client } = require('./native-sources').resolveClient(req.headers, null);
        if (client && client !== 'unknown') record(client, parsed);
      }
    }
  } catch { /* never the reason a request fails */ }
  next();
}

const APPS = Object.freeze({ 'neuro-ios': 'NEURO iOS', 'saim-ios': 'SAiM iOS', 'saim-watch': 'SAiM Watch', 'saim-widgets': 'SAiM widgets' });

/**
 * The "what build am I running" view (18Y): every native app, its newest
 * reported build, and each of its sources' capability assessment.
 */
function status({ sources = null } = {}) {
  const builds = current();
  let spine = sources;
  if (!spine) { try { spine = require('./canonical-read').sources({}).spine || []; } catch { spine = []; } }
  const apps = ['neuro-ios', 'saim-ios'].map((client) => {
    const b = builds[client] || null;
    const mine = Object.keys(REQUIREMENTS).filter((id) => id.endsWith(`.${client}`));
    const heard = (spine || []).filter((s) => String(s.sourceId || '').endsWith(`.${client}`) && s.transport && s.transport.lastSuccessAt)
      .map((s) => s.transport.lastSuccessAt).sort().pop() || null;
    return {
      client, app: APPS[client], build: b, buildLabel: b ? b.label : null,
      reported: !!b, lastHeardAt: heard,
      line: b ? `${APPS[client]} ${b.label} — first seen ${b.firstSeenAt.slice(0, 16).replace('T', ' ')}, last ${b.lastSeenAt.slice(0, 16).replace('T', ' ')}.`
        : heard ? `${APPS[client]} is talking to NEURO but has never said which build it is — it predates build reporting (Build 18).`
          : `${APPS[client]} has not been heard from.`,
      sources: mine.map((id) => ({ sourceId: id, ...assessSource(id, b) })),
    };
  });
  return { apps, others: Object.values(builds).filter((b) => !['neuro-ios', 'saim-ios'].includes(b.client)), capabilities: CAPABILITIES };
}

module.exports = {
  CAPABILITIES, REQUIREMENTS, TOUCH_EVERY_MS, APPS,
  parseBuildHeader, buildKey, label, assessSource,
  record, current, history, middleware, status,
  _reset: () => _touched.clear(),
};
