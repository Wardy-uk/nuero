// SARA Context Inference — v0 (WS5-WP1).
//
// Protected principle: there is ONE SARA and ONE shared state model, and the State
// Engine remains its sole producer. This module does NOT own state and is NOT a
// second decision engine. It is a bounded, pure derivation: given the already-
// assembled domains, telemetry, and location from the shared model, it infers a
// small, honest answer to two questions —
//   1. "what does SARA think Nick is doing right now?" (a bounded activity/context)
//   2. "which view would SARA recommend?" (advisory only)
// — together with the confidence and the reasons behind both.
//
// Hard boundaries for this slice (build brief / behavioural spec):
//   * Recommendation is ADVISORY ONLY. The contract enforces `advisory: true`. This
//     module never switches a view; nothing here touches the frontend's currentView.
//   * Telemetry is an INPUT, not a decision engine. Home Assistant presence/location
//     signals only feed the inference like any other input; HA stays a telemetry bus.
//   * Honest uncertainty is a first-class outcome. Missing or contradictory inputs
//     lower confidence and are surfaced in `reasons`/`contradictions`, and can yield
//     `activity: 'unknown'` with `recommendedView: null` rather than a confident lie.
//
// Bounded scope: a fixed enum of activity states and a fixed map from activity to one
// recommended view id. Nothing is open-ended or auto-discovered.
//
// CommonJS only (NEURO backend convention — no ESM).

const { DOMAINS, DOMAIN_CONTRACTS } = require('./contract');

// The bounded set of view ids this layer may recommend. Mirrors the frontend
// SARA_VIEWS registry (frontend/src/state/views.js); kept as a small backend-local
// constant so the inference is self-contained and the recommendation can never name
// a view the runtime doesn't have. Adding a view means adding it here intentionally.
const RECOMMENDABLE_VIEWS = {
  MISSION_CONTROL: 'mission-control',
  EXECUTIVE_DASHBOARD: 'executive-dashboard',
  PRESENCE: 'presence',
  FOCUS: 'focus',
  COMPANION: 'companion',
  STREAM_DECK: 'stream-deck',
};

// The bounded activity/context enum. Each value is one honest label for what SARA
// believes is going on, in priority order of urgency (resolved top-down below).
const ACTIVITY = {
  UNKNOWN: 'unknown', // inputs incomplete/malformed — cannot infer reliably
  FIREFIGHTING: 'firefighting', // queue is breaching SLA — work is the priority
  AWAY: 'away', // presence/location says Nick is away
  FOCUSED_TASK: 'focused-task', // a current do-next is set, queue is calm
  TEAM_ATTENTION: 'team-attention', // a report is slipping / needs a look
  STEADY: 'steady', // nothing pressing — calm default
};

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Reuse the contract's domain-shape rule so "inputs malformed" means exactly what it
// means everywhere else in the engine (same fault the degraded-health path surfaces).
function malformedDomains(domains) {
  if (!isObject(domains)) return [...DOMAINS];
  return DOMAINS.filter((name) => {
    const d = domains[name];
    return !isObject(d) || !DOMAIN_CONTRACTS[name].every((k) => k in d);
  });
}

// Is Nick away, per the situational inputs? Telemetry presence is the strongest
// signal; location context ('away') is a secondary one. Either alone is enough to
// consider "away" — but it is only an INPUT to the priority resolution below.
function readAway(telemetry, location) {
  const presence = telemetry && telemetry.available ? telemetry.signals?.presence : null;
  const byPresence = presence && presence.present === false;
  const byLocation = location && location.context === 'away';
  return { away: Boolean(byPresence || byLocation), byPresence: Boolean(byPresence), byLocation: Boolean(byLocation) };
}

function deriveConfidence({ malformed, activity, telemetryAvailable, contradictions }) {
  if (malformed) {
    return {
      source: 'derived',
      score: 0.3,
      level: 'low',
      rationale: 'Inference inputs are incomplete — one or more domains are not contract-shaped, so context cannot be inferred reliably.',
      basis: ['inputs-incomplete'],
    };
  }

  const basis = ['domain-signal'];
  // Domains are the base evidence. Seeded domains are honest but not live, so the
  // ceiling without live corroboration is moderate.
  let score = 0.6;

  if (telemetryAvailable) {
    score += 0.15;
    basis.push('telemetry-live');
  } else {
    basis.push('telemetry-unavailable');
  }

  // The calm default ('steady') is a weak-signal recommendation by nature — say so.
  if (activity === ACTIVITY.STEADY) {
    score -= 0.1;
    basis.push('weak-signal-default');
  }

  if (contradictions.length) {
    score -= 0.2;
    basis.push('contradiction-present');
  }

  score = Math.max(0.2, Math.min(0.95, Number(score.toFixed(2))));
  const level = score >= 0.75 ? 'high' : score >= 0.5 ? 'moderate' : 'low';

  let rationale;
  if (!telemetryAvailable) {
    rationale = 'Inferred from seeded domain signals only — presence/location telemetry is unavailable, so the read cannot be corroborated live.';
  } else if (contradictions.length) {
    rationale = 'Live telemetry is present but disagrees with the domain signal; confidence is reduced and the conflict is surfaced.';
  } else {
    rationale = 'Domain signals are corroborated by live telemetry.';
  }
  if (activity === ACTIVITY.STEADY) {
    rationale += ' No pressing signal stood out, so the recommendation is a calm default.';
  }

  return { source: 'derived', score, level, rationale, basis };
}

/**
 * Derive the bounded context inference from the already-assembled shared-model
 * inputs. Pure: no I/O, no clock, no mutation of its inputs. Returns the `inference`
 * block the State Engine folds into the one shared model.
 *
 * @param {object} args
 * @param {object} args.domains    the assembled domain block (queue/focus/people/vault)
 * @param {object} args.telemetry  the assembled telemetry block (HA snapshot, shaped)
 * @param {object} args.location   the assembled situational location block
 * @returns {object} inference block
 */
function deriveInference({ domains, telemetry, location }) {
  const malformed = malformedDomains(domains);
  const telemetryAvailable = Boolean(telemetry && telemetry.available);

  // Honest fallback: if the inputs are not contract-shaped we cannot infer context.
  // We say so plainly rather than guessing — recommendedView is null.
  if (malformed.length) {
    const reasons = [
      `Cannot infer context: ${malformed.join(', ')} ${malformed.length === 1 ? 'is' : 'are'} not contract-shaped.`,
      'No view is recommended while inputs are incomplete.',
    ];
    return {
      source: 'derived',
      advisory: true,
      activity: ACTIVITY.UNKNOWN,
      context: 'Unknown — inputs incomplete',
      summary: "Not enough signal to say what you're doing right now.",
      recommendedView: null,
      confidence: deriveConfidence({ malformed: true, activity: ACTIVITY.UNKNOWN, telemetryAvailable, contradictions: [] }),
      reasons,
      contradictions: [],
      inputs: {
        queue: !malformed.includes('queue'),
        focus: !malformed.includes('focus'),
        people: !malformed.includes('people'),
        telemetryAvailable,
        locationSource: (location && location.source) || null,
      },
      derivedFrom: ['domains'],
    };
  }

  const queue = domains.queue;
  const focus = domains.focus;
  const people = domains.people;

  const breaching = Number(queue.breaching) || 0;
  const focusTask = isObject(focus.current) ? focus.current : null;
  const slipping = Array.isArray(people.members)
    ? people.members.filter((m) => m && (m.status === 'slipping' || m.status === 'watch'))
    : [];
  const { away, byPresence, byLocation } = readAway(telemetry, location);

  const reasons = [];
  const contradictions = [];
  const derivedFrom = [];

  // Note conflicts up front so confidence and reasons reflect them regardless of which
  // activity wins the priority resolution below.
  if (away && breaching > 0) {
    contradictions.push('Presence/location suggests you are away, but the queue is breaching SLA — the work signal takes priority.');
  }

  let activity;
  let recommendedView;
  let context;
  let summary;

  // Priority resolution — most urgent / most actionable signal wins. Each branch is a
  // bounded activity -> one recommended view. This is the whole inference surface.
  if (breaching > 0) {
    activity = ACTIVITY.FIREFIGHTING;
    recommendedView = RECOMMENDABLE_VIEWS.EXECUTIVE_DASHBOARD;
    context = 'Firefighting the queue';
    summary = `You look like you're firefighting — ${breaching} ${breaching === 1 ? 'ticket is' : 'tickets are'} breaching SLA.`;
    reasons.push(`${breaching} ${breaching === 1 ? 'ticket is' : 'tickets are'} breaching SLA — queue depth is the priority right now.`);
    reasons.push('Executive Dashboard shows queue and SLA at depth, so it is the suggested view.');
    derivedFrom.push('queue');
  } else if (away) {
    activity = ACTIVITY.AWAY;
    recommendedView = RECOMMENDABLE_VIEWS.PRESENCE;
    context = 'Away';
    summary = 'You seem to be away — keeping things calm.';
    if (byPresence) reasons.push('Presence telemetry reports you are not present.');
    if (byLocation) reasons.push(`Location context is "${location.context}".`);
    reasons.push('Presence is the calm ambient view, so it is the suggested view while you are away.');
    derivedFrom.push(byPresence ? 'telemetry' : 'location');
  } else if (focusTask) {
    activity = ACTIVITY.FOCUSED_TASK;
    recommendedView = RECOMMENDABLE_VIEWS.FOCUS;
    context = 'Focused work';
    summary = `You're set up for focused work${focusTask.title ? `: ${focusTask.title}.` : '.'}`;
    reasons.push(`A current focus task is set${focusTask.title ? `: "${focusTask.title}"` : ''} and the queue is calm.`);
    reasons.push('Focus shows one timeboxed thing, so it is the suggested view.');
    derivedFrom.push('focus');
  } else if (slipping.length) {
    activity = ACTIVITY.TEAM_ATTENTION;
    recommendedView = RECOMMENDABLE_VIEWS.EXECUTIVE_DASHBOARD;
    context = 'Team needs a look';
    const names = slipping.map((m) => m.name).filter(Boolean).join(', ');
    summary = `Team signals need a look${names ? ` — ${names}` : ''}.`;
    reasons.push(`${slipping.length} ${slipping.length === 1 ? 'report needs' : 'reports need'} attention${names ? ` (${names})` : ''}.`);
    reasons.push('Executive Dashboard surfaces people and metrics, so it is the suggested view.');
    derivedFrom.push('people');
  } else {
    activity = ACTIVITY.STEADY;
    recommendedView = RECOMMENDABLE_VIEWS.MISSION_CONTROL;
    context = 'Steady';
    summary = 'Things look steady right now.';
    reasons.push('Nothing is breaching, no focus task is set, and no report is slipping.');
    reasons.push('Mission Control is the at-a-glance default, so it is the suggested view.');
    derivedFrom.push('queue', 'focus', 'people');
  }

  // Always be honest about whether telemetry could corroborate the read.
  if (telemetryAvailable) {
    derivedFrom.push('telemetry');
  } else {
    reasons.push('Presence/location telemetry is unavailable, so this is inferred from domain signals only.');
  }

  const confidence = deriveConfidence({ malformed: false, activity, telemetryAvailable, contradictions });

  return {
    source: 'derived',
    advisory: true,
    activity,
    context,
    summary,
    recommendedView,
    confidence,
    reasons,
    contradictions,
    inputs: {
      queue: true,
      focus: true,
      people: true,
      telemetryAvailable,
      locationSource: (location && location.source) || null,
    },
    derivedFrom: [...new Set(derivedFrom)],
  };
}

module.exports = { deriveInference, RECOMMENDABLE_VIEWS, ACTIVITY };
