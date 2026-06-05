// SARA station registry — Tier-2 (fine-grained) location.
//
// Two-tier location model:
//   Tier 1 (zone)    — coarse GPS: Home / Work / elsewhere. Comes from the HA telemetry
//                      bridge (device_tracker / person). Already handled in stateEngine.
//   Tier 2 (station) — fine device-proximity: at desk / living-room / driving. Each
//                      TERMINAL that can detect you (this Pi via the watch-presence
//                      service, a future desk Pi, the car stereo) reports here whether it
//                      currently sees you.
//
// Architecture note (Stage 1 -> Stage 2): today SARA's backend and this terminal are the
// same Pi, but terminals report over HTTP exactly as a remote terminal would. When NEURO
// migrates to a central server (Stage 2), terminals just point at the new URL — no model
// change. This registry is the single source of truth for "which station currently sees
// you"; it does not decide anything, it only records reports and ages them out.
//
// CommonJS only (NEURO backend convention — no ESM).

// station name -> { station, present, source, rssi, detail, reportedAt(ISO), _mono }
const reports = new Map();

// A report older than this with no refresh is considered stale and ignored when picking
// the active station — so a crashed/disconnected terminal can't pin you "present" forever.
const STALE_MS = 90 * 1000;

function now() {
  return Date.now();
}

/**
 * Record a terminal's presence report. Idempotent per station name.
 * @param {object} r { station, present, source?, rssi?, detail? }
 * @returns {object} the stored record
 */
function report(r) {
  const station = String(r.station || '').trim();
  if (!station) throw new Error('station is required');
  const rec = {
    station,
    present: Boolean(r.present),
    source: r.source ? String(r.source) : 'unknown',
    rssi: typeof r.rssi === 'number' ? r.rssi : null,
    detail: r.detail ? String(r.detail) : null,
    reportedAt: new Date().toISOString(),
    _mono: now(),
  };
  reports.set(station, rec);
  return rec;
}

function isFresh(rec) {
  return now() - rec._mono <= STALE_MS;
}

/** All known stations with a `stale` flag, newest first. Public-shaped (no _mono). */
function list() {
  return [...reports.values()]
    .sort((a, b) => b._mono - a._mono)
    .map(({ _mono, ...pub }) => ({ ...pub, stale: !isFresh({ _mono }) }));
}

/**
 * The currently-active station: the most-recently-updated FRESH report that says
 * present. Null if no fresh terminal currently sees you. Multiple terminals seeing you
 * at once -> the most recent wins (you can only be at one station; the latest detector
 * is the best guess).
 */
function active() {
  let best = null;
  for (const rec of reports.values()) {
    if (rec.present && isFresh(rec)) {
      if (!best || rec._mono > best._mono) best = rec;
    }
  }
  if (!best) return null;
  const { _mono, ...pub } = best;
  return pub;
}

// Test/runtime helper.
function _reset() {
  reports.clear();
}

module.exports = { report, list, active, STALE_MS, _reset };
