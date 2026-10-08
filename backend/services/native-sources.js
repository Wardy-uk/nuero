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
  // ⚠ RETIRED, NOT DELETED (Build 3B, 3 Oct 2026). Nick deleted the FreeReps
  // app; the NEURO and SAiM apps both read HealthKit. Its history stays in the
  // log and in source_health and is still queryable — a retired source simply
  // stops being EXPECTED: no stale verdicts, no blindness findings, and it no
  // longer counts against current health. If it ever reports again the
  // delivery is recorded as normal; only the expectation has gone.
  'healthkit.freereps-ios': {
    label: 'Health data from FreeReps',
    what: 'nothing on its own — it re-sends what the NEURO apps already send',
    importance: 'low', group: 'health', lifecycle: 'retired', push: true,
    lifecycleSince: '2026-10-03T00:00:00.000Z',
    lifecycleReason: 'FreeReps app deleted; HealthKit is covered by the NEURO and SAiM apps',
    expectedIntervalMs: 1 * HOUR, staleAfterMs: 12 * HOUR,
  },
  'device.neuro-ios': {
    label: 'Phone self-report (NEURO app)',
    what: 'battery, motion and connectivity — Home Assistant covers some of it',
    importance: 'medium', group: 'phone-self-report', expected: true, push: true,
    expectedIntervalMs: 2 * HOUR, staleAfterMs: 12 * HOUR,
  },
  // 5 Oct 2026: SAiM reports the phone's self-status too (shared
  // DeviceReporter in NeuroKit), because SAiM is the app Nick opens most and a
  // report only arrives when an app is awake. Grouped with the NEURO app's: one
  // phone, two reporters — either one being heard means the sense is not blind.
  // ⚠ EXPECTED from 8 Oct 2026, on evidence (Build 18I): SAiM build 241
  // (77f90fc) has reported device status since 7 Oct and the source is fresh.
  // Grouped with the NEURO app's, so one silent reporter drops a level.
  'device.saim-ios': {
    label: 'Phone self-report (SAiM app)',
    what: 'battery, motion and connectivity — Home Assistant covers some of it',
    importance: 'medium', group: 'phone-self-report', lifecycle: 'expected', push: true,
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
    // ⚠ Build 3B. LocationTracker.swift reports ONLY on a significant change
    // (~500m) or a visit — it never asks for a fix on wake. So a phone that
    // has not moved sends NO location at all, however alive it is, and an old
    // fix is not evidence of a dead sensor. Blindness is therefore judged on
    // the APP being heard from (any NEURO-app channel), not on the fix's age;
    // an old fix from a live app is `quiet` — plausibly still current.
    // Movement is the counter-check: a vehicle-scale motion report with no fix
    // after it is suspicious however recently the app spoke.
    liveness: {
      peers: ['device.neuro-ios', 'healthkit.neuro-ios', 'eventkit.neuro-ios'],
      movementFrom: 'device.neuro-ios',
      // CoreMotion reports "Walking" for walking round the house, which never
      // moves 500m — only vehicle-scale motion is evidence a fix is owed.
      movingActivities: ['Automotive', 'Cycling'],
      movingFixGraceMs: 45 * 60 * 1000,
    },
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
  // Build 11D. Reminders are their OWN source: a calendar push that works says
  // nothing about whether reminders reach NEURO. ⚠ OPTIONAL until the iOS
  // Build 11 apps are built and installed — the builds on the phone today send
  // reminders WITHOUT ids (not projectable) from the "Reminders" list only, and
  // judging that as blind would be an alarm about a build nobody has made yet.
  // Flip to expected once the rebuilt app is pushing (one line, here).
  // ⚠ EXPECTED from Build 13 (6 Oct 2026), on evidence: both rebuilt apps
  // have pushed reminders WITH ids from every list since 4 Oct (source_health
  // fresh for both, 7 lists seen by id), which is the condition this comment
  // used to wait for.
  'reminders.neuro-ios': {
    label: 'Phone reminders push (NEURO app)',
    what: 'your reminders, as tasks with their due dates',
    importance: 'medium', group: 'personal-reminders', lifecycle: 'expected', push: true,
    expectedIntervalMs: 2 * HOUR, staleAfterMs: 12 * HOUR,
  },
  'reminders.saim-ios': {
    label: 'Phone reminders push (SAiM app)',
    what: 'your reminders, as tasks with their due dates',
    importance: 'medium', group: 'personal-reminders', lifecycle: 'expected', push: true,
    expectedIntervalMs: 2 * HOUR, staleAfterMs: 12 * HOUR,
  },
  // ⚠ RETIRED (Build 13, 6 Oct 2026). Deliveries from builds that sent no
  // X-Neuro-Client and no recognisable User-Agent were bucketed as
  // `<kind>.unknown`. Every installed build now identifies itself (both apps
  // have pushed as neuro-ios / saim-ios since 4 Oct), so these buckets can
  // never be heard from again — and judged as expected-by-default they were
  // the only ACTIVE blindness findings on the live Pi (64 shadow decisions
  // each, about a client that no longer exists). History is kept.
  'eventkit.unknown': {
    label: 'Phone calendar push (unidentified old build)',
    what: 'nothing now — superseded by the NEURO and SAiM app sources',
    importance: 'low', group: 'personal-calendar', lifecycle: 'retired', push: true,
    lifecycleSince: '2026-10-06T00:00:00.000Z',
    lifecycleReason: 'pre-identity app builds; every installed build now sends its client id',
    expectedIntervalMs: 2 * HOUR, staleAfterMs: 12 * HOUR,
  },
  'reminders.unknown': {
    label: 'Phone reminders push (unidentified old build)',
    what: 'nothing now — superseded by the NEURO and SAiM app sources',
    importance: 'low', group: 'personal-reminders', lifecycle: 'retired', push: true,
    lifecycleSince: '2026-10-06T00:00:00.000Z',
    lifecycleReason: 'pre-identity app builds; every installed build now sends its client id',
    expectedIntervalMs: 2 * HOUR, staleAfterMs: 12 * HOUR,
  },
  // Build 13G: Home Assistant presence, a PULL source (polled every 2 min).
  // Grouped with nothing: the phone apps say where the PHONE is, this says what
  // the house's own trackers (router + Life360) decided about the people.
  'homeassistant.presence': {
    label: 'Home Assistant presence',
    what: 'whether you are home, and whether anyone else is in',
    importance: 'medium', group: null, expected: true, push: false,
    expectedIntervalMs: 2 * 60 * 1000, staleAfterMs: 30 * 60 * 1000,
  },
  // External weather (7 Oct 2026, weather-ea.js). The EA gauge is EXPECTED:
  // live telemetry publishes every 15 min, and silence for three hours is a
  // stopped feed, not a dry spell (a dry gauge still reports zeros). LOW
  // importance: nothing about Nick's day rests on it, so a finding never
  // interrupts. The qualified record is optional — it arrives on the EA's
  // schedule, not ours.
  'weather.ea-3641': {
    label: 'EA rain gauge (Mount St Bernards) — live',
    what: 'local rainfall every 15 minutes',
    importance: 'low', group: 'local-weather', expected: true, push: false,
    expectedIntervalMs: 15 * 60 * 1000, staleAfterMs: 3 * HOUR,
  },
  'weather.ea-3641-qualified': {
    label: 'EA rain gauge (Mount St Bernards) — qualified record',
    what: 'the quality-checked rainfall history',
    importance: 'low', group: 'local-weather', lifecycle: 'optional', push: false,
    expectedIntervalMs: 24 * HOUR, staleAfterMs: 72 * HOUR,
  },
  // Build 15L: a canary PULL source (selftest-source.js) whose only purpose is
  // to let self-healing be proven in production without breaking a real sense.
  // Expected, so a fault on it is investigated like any other; LOW importance,
  // so a finding about it can never interrupt (the source-blind rule refuses
  // low severity).
  'neuro.selftest': {
    label: 'NEURO self-test',
    what: 'nothing about you — it proves NEURO can notice, diagnose and fix a stopped source',
    importance: 'low', group: null, expected: true, push: false,
    expectedIntervalMs: 1 * HOUR, staleAfterMs: 3 * HOUR,
  },
  // Build 11M: the laptop activity reporter, moved onto the spine. OPTIONAL: a
  // laptop asleep for a weekend, or left at work on holiday, is not a blind
  // sense — and the attention veto that matters ("is he at the laptop") is
  // already judged by desktop-activity's own freshness.
  'desktop.agent': {
    label: 'Desktop activity agent',
    what: 'whether you are working at the laptop, and on what',
    importance: 'low', group: null, lifecycle: 'optional', push: true,
    expectedIntervalMs: 10 * 60 * 1000, staleAfterMs: 24 * HOUR,
  },
});

// Anything not declared: low importance, no group, not expected, with a
// conservative twelve-hour push cadence. A new client appearing is a fact to
// record, not a reason to raise an alarm about it.
const DEFAULT = Object.freeze({
  label: null, what: null, importance: 'low', group: null, expected: false, push: true,
  expectedIntervalMs: 1 * HOUR, staleAfterMs: 12 * HOUR,
});

// ── Lifecycle (Build 3B) ────────────────────────────────────────────────────
//
//   expected  NEURO should hear from it; silence is blindness
//   optional  recorded when it reports; silence is not a finding
//   retired   history kept and queryable; never judged stale, never a
//             finding, never counted against current health
//
// The declared lifecycle is RECORDED as a source.lifecycle.changed event
// (source-health.syncLifecycle) so every projection reads it from the log.
const LIFECYCLES = ['expected', 'optional', 'retired'];

function lifecycleOf(d) {
  if (d && LIFECYCLES.includes(d.lifecycle)) return d.lifecycle;
  return d && d.expected ? 'expected' : 'optional';
}

function describe(sourceId) {
  const d = SOURCES[sourceId] || DEFAULT;
  const lifecycle = lifecycleOf(d);
  return { sourceId, ...d, lifecycle, expected: lifecycle === 'expected', label: d.label || sourceId, declared: !!SOURCES[sourceId] };
}

function expectedSources() {
  return Object.keys(SOURCES).filter((id) => lifecycleOf(SOURCES[id]) === 'expected');
}

function declaredLifecycles() {
  return Object.keys(SOURCES).map((id) => ({
    sourceId: id,
    lifecycle: lifecycleOf(SOURCES[id]),
    since: SOURCES[id].lifecycleSince || null,
    reason: SOURCES[id].lifecycleReason || null,
  }));
}

// ── Observation freshness vs transport liveness (Build 3B) ──────────────────

/**
 * Is a push source with a `liveness` rule blind, quiet, or fine? PURE.
 *
 *   row          its source_health row (last_observed_at, last_success_at,
 *                stale_after_ms)
 *   peerDeliveries  { sourceId: lastSuccessAt } for its liveness peers
 *   movingSince  the first vehicle-scale motion report observed AFTER the
 *                newest fix, or null
 *
 * Returns { verdict: 'fresh' | 'quiet' | 'stale', reason, transportAliveAt,
 * transportSourceId }. Unknown stays unknown: no fix ever and no row is
 * 'fresh' here only because there is nothing to judge — the never-seen path
 * owns that case.
 */
function judgeObservationFreshness({ sourceId, row, peerDeliveries = {}, movingSince = null, now }) {
  const d = describe(sourceId);
  const rule = d.liveness;
  const nowMs = now instanceof Date ? now.getTime() : now;
  const staleAfter = row.stale_after_ms || d.staleAfterMs;
  const basis = row.last_observed_at;
  if (!basis) return { verdict: 'fresh', reason: 'nothing observed yet' };

  // Transport: the newest delivery from the source itself or any peer app channel.
  let aliveAt = row.last_success_at || null;
  let aliveFrom = aliveAt ? sourceId : null;
  for (const [peer, at] of Object.entries(peerDeliveries)) {
    if (at && (!aliveAt || at > aliveAt)) { aliveAt = at; aliveFrom = peer; }
  }
  const transportAlive = !!aliveAt && nowMs - Date.parse(aliveAt) <= staleAfter;
  const ageMs = nowMs - Date.parse(basis);

  if (rule && movingSince && Date.parse(movingSince) > Date.parse(basis)
      && nowMs - Date.parse(movingSince) >= rule.movingFixGraceMs) {
    return { verdict: 'stale', reason: 'moving-without-fix', movingSince, transportAliveAt: aliveAt, transportSourceId: aliveFrom };
  }
  if (!(ageMs > staleAfter)) return { verdict: 'fresh', reason: 'recent observation' };
  if (rule && transportAlive) {
    return { verdict: 'quiet', reason: 'transport-alive', transportAliveAt: aliveAt, transportSourceId: aliveFrom };
  }
  return { verdict: 'stale', reason: rule ? 'transport-silent' : 'observation-old', transportAliveAt: aliveAt, transportSourceId: aliveFrom };
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
  LIFECYCLES,
  declaredLifecycles,
  judgeObservationFreshness,
  IMPORTANCE_ORDER,
  resolveClient,
  sourceIdFor,
  describe,
  expectedSources,
  groupPeers,
  lowerImportance,
};
