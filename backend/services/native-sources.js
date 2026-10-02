'use strict';

/**
 * Native sources — who is sensing, under what identity, and how often they
 * should be heard from (Build 2). PURE: no DB, no network, no clock.
 *
 * ── The identity scheme ─────────────────────────────────────────────────────
 *
 *   <kind>.<client>      healthkit.neuro-ios   healthkit.saim-ios
 *                        healthkit.freereps-ios
 *                        device.neuro-ios      location.neuro-ios
 *                        eventkit.neuro-ios    eventkit.saim-ios
 *
 * The SOURCE is a sensor reached through one app. Two apps reading one
 * HealthKit store are two sources, because they go blind separately: SAiM's
 * signature can lapse while NEURO's still runs, and "iOS has gone quiet" would
 * not say which one to reinstall.
 *
 * ⚠ REDUNDANT SENSING IS FINE, AND DUPLICATE TRUTH IS NOT. Both apps keep their
 * own HealthKit anchors and re-send the same samples, and that is deliberate:
 * iOS wakes neither app reliably. So liveness is tracked PER SOURCE, while the
 * observation itself is keyed on the record (the HealthKit UUID) and folds.
 * These are two different questions, and they get two different keys.
 *
 * ── How the client is known ─────────────────────────────────────────────────
 *
 *   1. `X-Neuro-Client` header — explicit, sent by NeuroKit from Build 2 on
 *   2. a `client` field in the body — the calendar push has always sent one
 *   3. the User-Agent's first token — URLSession's default is
 *      "<ExecutableName>/<build> CFNetwork/… Darwin/…", so `Neuro/1`,
 *      `Saim/1` and `FreeReps/3` already tell the producers apart
 *
 * The third is what makes this work against the iOS builds already installed,
 * before anything is rebuilt on the Mac. `via` always says which one answered.
 * An unknown client is `unknown`, never a guess at one of the known ones.
 */

const CLIENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

// The User-Agent product token, lower-cased, onto a client id. Only names
// observed on the live Pi (2 Oct 2026) are listed; anything else is unknown.
const UA_CLIENTS = {
  neuro: 'neuro-ios',
  saim: 'saim-ios',
  freereps: 'freereps-ios',
};

// The calendar push's own `client` vocabulary (CalendarSync.swift, SaimState).
const BODY_CLIENTS = {
  neuro: 'neuro-ios',
  saim: 'saim-ios',
  'neuro-ios': 'neuro-ios',
  'saim-ios': 'saim-ios',
};

/**
 * Who sent this request. PURE — takes the headers object and an optional body
 * client string.
 *
 * Returns `{ client, via }` where client is a stable id or 'unknown', and via
 * is 'header' | 'body' | 'user-agent' | null.
 */
function resolveClient(headers = {}, bodyClient = null) {
  const h = headers || {};
  const explicit = typeof h['x-neuro-client'] === 'string' ? h['x-neuro-client'].trim().toLowerCase() : '';
  if (explicit && CLIENT_PATTERN.test(explicit)) return { client: explicit, via: 'header' };

  if (typeof bodyClient === 'string') {
    const mapped = BODY_CLIENTS[bodyClient.trim().toLowerCase()];
    if (mapped) return { client: mapped, via: 'body' };
  }

  const ua = typeof h['user-agent'] === 'string' ? h['user-agent'] : '';
  const token = ua.split(/[\s/]/)[0].toLowerCase();
  if (token && UA_CLIENTS[token]) return { client: UA_CLIENTS[token], via: 'user-agent' };

  return { client: 'unknown', via: null };
}

function sourceIdFor(kind, client) {
  return `${kind}.${client && CLIENT_PATTERN.test(client) ? client : 'unknown'}`;
}

// ── Cadence, importance and redundancy ──────────────────────────────────────
//
// ⚠ THESE THRESHOLDS ANSWER "HAS THE SENSOR GONE BLIND?", NOT "IS THIS READING
// CURRENT?". They are deliberately different questions. device-status keeps
// its 30-minute window for whether a self-report may override Home Assistant
// (unchanged), but the NEURO app only reports on a foreground or a
// background-refresh wake — measured once in 21 hours — so a 30-minute
// blindness threshold would call the phone blind every evening it sat in a
// pocket. Twelve hours is the existing `health` sense's threshold
// (signals.js) and the right order for "the app has stopped running at all",
// which is the failure that matters: a lapsed free-provisioning signature.
//
// Importance is a simple declared map (Build 2 brief §16), never dynamic:
//   high    SAiM's judgement rests on it and nothing else covers it
//   medium  it matters, and something partly covers it
//   low     redundant or enrichment-only
//
// `group` names redundant peers. A source whose group-mate is fresh has gone
// blind without the world model going blind, so its finding drops a level.

const HOUR = 60 * 60 * 1000;

const SOURCES = Object.freeze({
  'microsoft.calendar': {
    label: 'Outlook calendar sync',
    what: 'meetings, and whether now is a good moment',
    importance: 'medium', group: null, expected: true, push: false,
  },
  'healthkit.neuro-ios': {
    label: 'Health data from the NEURO app',
    what: 'sleep, heart rate, HRV and activity',
    importance: 'medium', group: 'health', expected: true, push: true,
    expectedIntervalMs: 1 * HOUR, staleAfterMs: 12 * HOUR,
  },
  'healthkit.saim-ios': {
    label: 'Health data from the SAiM app',
    what: 'sleep, heart rate, HRV and activity',
    importance: 'medium', group: 'health', expected: true, push: true,
    expectedIntervalMs: 1 * HOUR, staleAfterMs: 12 * HOUR,
  },
  'healthkit.freereps-ios': {
    label: 'Health data from FreeReps',
    what: 'nothing on its own — it re-sends what the NEURO apps already send',
    importance: 'low', group: 'health', expected: false, push: true,
    expectedIntervalMs: 1 * HOUR, staleAfterMs: 12 * HOUR,
  },
  'device.neuro-ios': {
    label: 'Phone self-report (NEURO app)',
    what: 'battery, motion and connectivity — Home Assistant covers some of it',
    importance: 'medium', group: null, expected: true, push: true,
    expectedIntervalMs: 2 * HOUR, staleAfterMs: 12 * HOUR,
  },
  'location.neuro-ios': {
    label: 'Phone location (NEURO app)',
    what: 'where you are, independent of Home Assistant',
    importance: 'medium', group: null, expected: true, push: true,
    // Significant-change monitoring: a day at home is legitimately silent for
    // hours. The existing position feed calls six hours stale; blindness is
    // judged at twelve so a quiet day at home is not an alarm.
    expectedIntervalMs: 6 * HOUR, staleAfterMs: 12 * HOUR,
  },
  'eventkit.neuro-ios': {
    label: 'Phone calendar push (NEURO app)',
    what: 'your personal diary and reminders',
    importance: 'medium', group: 'personal-calendar', expected: true, push: true,
    expectedIntervalMs: 2 * HOUR, staleAfterMs: 12 * HOUR,
  },
  'eventkit.saim-ios': {
    label: 'Phone calendar push (SAiM app)',
    what: 'your personal diary and reminders',
    importance: 'medium', group: 'personal-calendar', expected: true, push: true,
    expectedIntervalMs: 2 * HOUR, staleAfterMs: 12 * HOUR,
  },
});

// Anything not declared: low importance, no group, not expected, with a
// conservative twelve-hour push cadence. A new client appearing is a fact to
// record, not a reason to raise an alarm about it.
const DEFAULT = Object.freeze({
  label: null, what: null, importance: 'low', group: null, expected: false, push: true,
  expectedIntervalMs: 1 * HOUR, staleAfterMs: 12 * HOUR,
});

function describe(sourceId) {
  const d = SOURCES[sourceId] || DEFAULT;
  return { sourceId, ...d, label: d.label || sourceId, declared: !!SOURCES[sourceId] };
}

function expectedSources() {
  return Object.keys(SOURCES).filter((id) => SOURCES[id].expected);
}

function groupPeers(sourceId) {
  const d = SOURCES[sourceId];
  if (!d || !d.group) return [];
  return Object.keys(SOURCES).filter((id) => id !== sourceId && SOURCES[id].group === d.group);
}

const IMPORTANCE_ORDER = ['low', 'medium', 'high'];

function lowerImportance(level) {
  const i = IMPORTANCE_ORDER.indexOf(level);
  return i <= 0 ? 'low' : IMPORTANCE_ORDER[i - 1];
}

module.exports = {
  SOURCES,
  IMPORTANCE_ORDER,
  resolveClient,
  sourceIdFor,
  describe,
  expectedSources,
  groupPeers,
  lowerImportance,
};
