'use strict';

/**
 * Which app OWNS a push notification (Nick, 1 Nov 2026).
 *
 * NEURO is the only sender, and both the NEURO PWA and the SAiM PWA register a
 * push subscription on the same phone — so every push arrived TWICE. Nick's
 * call: both apps may notify, but each only for what it owns.
 *
 *   SAiM  — something about his day needs him (comes to him).
 *   NEURO — something about the system, or a report/review is ready (he goes
 *           looking).
 *
 * A subscription states its app (`push_subscriptions.app`); sendToAll sends a
 * push only to subscriptions of the owning app. A subscription that has not yet
 * said which app it is (registered before this existed) still receives
 * everything, so nothing goes silent before both apps re-register.
 *
 * ⚠ An UNLISTED type defaults to SAiM — the phone is where Nick will see it.
 * push-types.test.js fails on any sent type not named here, so the default is a
 * safety net, not a decision.
 */

const SAIM = 'saim';
const NEURO = 'neuro';
const APPS = new Set([SAIM, NEURO]);

const OWNERS = Object.freeze({
  // ── SAiM: his day needs him ────────────────────────────────────────────────
  meeting_alert: SAIM,
  meeting_prep: SAIM,
  escalation_alert: SAIM,
  escalation: SAIM,
  sentiment_escalation: SAIM,
  watched_reply: SAIM,
  ticket_commitment: SAIM,
  email: SAIM,
  standup: SAIM,
  eod: SAIM,
  food_log: SAIM,
  journal: SAIM,
  todo: SAIM,
  '121': SAIM,
  day_plan: SAIM,
  brief: SAIM,
  hike_checkin: SAIM,
  ambient: SAIM,
  room_offer: SAIM,
  router_restart: SAIM,
  uat_volunteers: SAIM,
  // A meeting follow-up drafted automatically (1 Nov 2026): Nick's press sends it.
  meeting_followup: SAIM,
  capture_failed: SAIM,
  needs_you: SAIM,
  approvals: SAIM,
  teams_mention: SAIM,
  nudge_cleared: SAIM,
  plan_milestone: SAIM,
  team_cover: SAIM,
  // Focus blocks (1 Nov 2026): the start, its check-ins, and the held summary.
  block_start: SAIM,
  block_two_minute: SAIM,
  block_wind_down: SAIM,
  block_end: SAIM,
  block_summary: SAIM,
  // Pushes held for a better moment and released together (push-moment, 7 Nov 2026).
  held_summary: SAIM,

  // ── NEURO: the system, and reports/reviews ready ───────────────────────────
  router_health: NEURO,
  system_alert: NEURO,
  sense_alert: NEURO,
  vault_hygiene: NEURO,
  knowledge_reflection: NEURO,
  capability_suggestions: NEURO,
  plaud: NEURO,
  sweep_complete: NEURO,
  journeys: NEURO,
  // Chris's weekly overtime sign-off (5 Nov 2026): reports, read on the desk.
  overtime_signoff: NEURO,
  leave_declined: NEURO,
  leave_clashes: NEURO,
  energy_unusual: NEURO,
  weekly_risk: NEURO,
  soap_report: NEURO,
  weekly_review: NEURO,
});

/** The owning app for a push type. Never null. */
function ownerOf(type) {
  return OWNERS[type] || SAIM;
}

/** True when `type` has an explicit owner (used by the source-scan test). */
function isClassified(type) {
  return Object.prototype.hasOwnProperty.call(OWNERS, type);
}

/** Normalise a client-sent app id; unknown → undefined (refused by the route). */
function normaliseApp(app) {
  const v = String(app || '').trim().toLowerCase();
  return APPS.has(v) ? v : undefined;
}

/**
 * Which subscriptions a push of `type` goes to. PURE.
 *
 * - Owner-app subscriptions get it; the other app's do not.
 * - Subscriptions with no stated app (legacy) always get it.
 * - ⚠ If NO subscription can take it (owner app not installed / never
 *   registered, and no legacy ones), it falls back to the OTHER app rather than
 *   going nowhere — a push for an app he has not installed is not a reason to
 *   tell him nothing. `fellBack` says so, for push_log.
 * - A test probe goes everywhere (it exists to prove the transport).
 */
function routeByOwner(subscriptions, type, { probe = false } = {}) {
  if (probe) return { subscriptions, owner: null, fellBack: false, skipped: 0 };
  const owner = ownerOf(type);
  const chosen = subscriptions.filter(s => !s.app || s.app === owner);
  if (chosen.length) {
    return { subscriptions: chosen, owner, fellBack: false, skipped: subscriptions.length - chosen.length };
  }
  return { subscriptions, owner, fellBack: subscriptions.length > 0, skipped: 0 };
}

module.exports = { OWNERS, SAIM, NEURO, ownerOf, isClassified, normaliseApp, routeByOwner };
