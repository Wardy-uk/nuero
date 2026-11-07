'use strict';

/**
 * How much time NEURO saved Nick (7 Nov 2026, Nick: "show me the things it
 * saved me having to do, and tell me how much time it saved").
 *
 * Nothing measures the time a thing would have taken, so every figure is an
 * ESTIMATE per kind of action: the defaults below are NEURO's, and Nick can
 * change any of them (agent_state `time_saved_minutes`). Every surface says
 * "estimated" — a total that looked measured would be a claim nothing made.
 *
 * Keyed on neuro-weekly-report's area ids, so a count and its minutes come from
 * the same record. Informational areas (notifications, raw writes) save nothing.
 */

const db = require('../db/database');

const KEY = 'time_saved_minutes';
const MAX_MINUTES = 240;

const DEFAULTS = Object.freeze({
  'one-to-ones': { minutes: 5, what: 'finding a free slot and sending the invite' },
  'outlook-archive': { minutes: 0.15, what: 'opening and archiving a muted sender’s email' },
  'waiting-on': { minutes: 0.5, what: 'deciding a stale waiting-on item is dead' },
  spotted: { minutes: 0.25, what: 'reading and dismissing an old suggestion' },
  tickets: { minutes: 5, what: 'drafting a ticket reply or tracking a promised update' },
  'focus-blocks': { minutes: 3, what: 'planning and booking a focus block' },
  'leave-declines': { minutes: 2, what: 'declining a meeting that falls on your leave' },
  router: { minutes: 10, what: 'noticing the router has wedged and restarting it' },
  'self-heal': { minutes: 5, what: 'noticing a dead feed and kicking it back into life' },
  'standing-switch': { minutes: 4, what: 'writing and sending the email or booking yourself' },
});

function _overrides() {
  try { const v = JSON.parse(db.getState(KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/** Every estimate in force: default, override, and which one wins. */
function estimates() {
  const o = _overrides();
  return Object.entries(DEFAULTS).map(([id, d]) => {
    const set = Number.isFinite(o[id]) ? o[id] : null;
    return { id, what: d.what, defaultMinutes: d.minutes, minutes: set == null ? d.minutes : set, changed: set != null };
  });
}

function minutesFor(id) {
  const e = estimates().find((x) => x.id === id);
  return e ? e.minutes : null;
}

/**
 * Set or reset one estimate. `minutes` null = back to the default. Refused
 * (never clamped): an unknown area, a negative, non-numeric or > 240 value.
 */
function setEstimate(id, minutes) {
  if (!DEFAULTS[id]) { const e = new Error(`unknown area "${id}"`); e.status = 400; throw e; }
  const o = _overrides();
  if (minutes === null) delete o[id];
  else {
    const n = Number(minutes);
    if (typeof minutes === 'boolean' || minutes === '' || !Number.isFinite(n) || n < 0 || n > MAX_MINUTES) {
      const e = new Error(`minutes must be a number from 0 to ${MAX_MINUTES}, or null to reset`); e.status = 400; throw e;
    }
    o[id] = Math.round(n * 100) / 100;
  }
  db.setState(KEY, JSON.stringify(o));
  return estimates();
}

/** "2h 05m", "12 min", "under a minute". PURE. */
function words(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'no time';
  if (minutes < 1) return 'under a minute';
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * Add minutes to the report's areas and a total. PURE over the areas and the
 * estimates (pass them in tests).
 */
function apply(areas, ests = estimates()) {
  const by = new Map(ests.map((e) => [e.id, e]));
  let total = 0;
  const out = (areas || []).map((a) => {
    const e = by.get(a.id);
    if (!e || a.informational || !a.acted) return { ...a, minutesEach: e ? e.minutes : null, minutesSaved: 0 };
    const saved = a.acted * e.minutes;
    total += saved;
    return { ...a, minutesEach: e.minutes, minutesSaved: saved, savedWords: words(saved), savedWhat: e.what };
  });
  return { areas: out, timeSaved: { minutes: Math.round(total * 10) / 10, words: words(total), estimated: true } };
}

module.exports = { KEY, DEFAULTS, MAX_MINUTES, estimates, minutesFor, setEstimate, words, apply };
