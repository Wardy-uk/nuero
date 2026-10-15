'use strict';

/**
 * What kind of work a task is — its ACTIVITY — and where each claim about it
 * comes from (15 Oct 2026; Nick chose A + C + B, not D). PURE.
 *
 * Precedence, and it is the whole design:
 *
 *   1. NICK'S CHOICE is the only thing that SETS a task's activity. One per
 *      task, stored (task_activity), authoritative, his to change or clear.
 *      "Not sure" is a choice too: it means "open the task in NEURO" and is
 *      never read as "no answer".
 *   2. SUGGESTIONS never set anything. They ride beside the intent as
 *      `activitySuggestions`, each with its basis, for SAiM to offer first when
 *      it asks:
 *        source   — where the task came from (an email-promoted task → email).
 *                   A route, not a fact about the work.
 *        observed — app use the laptop saw during a focus session on the task.
 *                   Soft, reviewable evidence (task_activity_observations);
 *                   accepting one is Nick's choice, nothing is ever written
 *                   for him.
 *   3. NOTHING is parsed from a title, a note or a description (option D was
 *      declined).
 *
 * Which APP serves an activity on a given device stays SAiM's hand-off
 * judgement (saim/policy/handoff.cjs); this file never names an app.
 */

const { ACTIVITIES } = require('./attention-contracts.cjs');

/** What Nick can say: an activity, or "Not sure — open the task in NEURO". */
const UNSURE = 'unsure';
const CHOICES = Object.freeze([...ACTIVITIES, UNSURE]);
const SUGGESTION_BASES = Object.freeze(['source', 'observed']);

/** Where a task came from → what it suggests. Only routes that say something. */
const SOURCE_SUGGESTION = Object.freeze({
  'email-promotion': 'email',
  'personal-email-promotion': 'email',
});

/** sourceSuggestion({ source, originPath }) → activity | null. A suggestion, never an assertion. */
function sourceSuggestion(task) {
  if (!task) return null;
  if (SOURCE_SUGGESTION[task.source]) return SOURCE_SUGGESTION[task.source];
  if (typeof task.originPath === 'string' && task.originPath.startsWith('email:')) return 'email';
  return null;
}

/**
 * Laptop process names (desktop-activity's sanitised `app`, lowercased) → the
 * activity using that app is evidence for. Browsers, Teams and anything not
 * listed say nothing: one browser hosts every kind of work.
 */
const PROCESS_ACTIVITY = Object.freeze({
  winword: 'write', word: 'write', obsidian: 'write',
  excel: 'spreadsheet',
  outlook: 'email', olk: 'email', hxoutlook: 'email',
  code: 'code', 'code - insiders': 'code', devenv: 'code', ssms: 'code',
  claude: 'draft', chatgpt: 'draft',
});

/**
 * Active minutes per app inside [startMs, endMs], from desktop-activity samples
 * (newest first or any order). An interval belongs to the EARLIER sample; a gap
 * longer than `freshMinutes` is not time at the desk; idle or locked is not use.
 */
function observeWindow(samples, startMs, endMs, { freshMinutes = 8, idleAwayMinutes = 10 } = {}) {
  const pts = (samples || [])
    .map((s) => ({ t: Date.parse(s.at), app: s.app || null, idle: Number(s.idleSeconds) || 0, locked: !!s.locked }))
    .filter((s) => Number.isFinite(s.t) && s.t >= startMs && s.t <= endMs)
    .sort((a, b) => a.t - b.t);
  const minutes = {};
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const nextT = i + 1 < pts.length ? pts[i + 1].t : endMs;
    const gap = (nextT - a.t) / 60000;
    if (gap <= 0 || gap > freshMinutes) continue;
    if (!a.app || a.locked || a.idle >= idleAwayMinutes * 60) continue;
    minutes[a.app] = (minutes[a.app] || 0) + gap;
  }
  return Object.entries(minutes).map(([app, m]) => ({ app, minutes: Math.round(m * 10) / 10 })).sort((x, y) => y.minutes - x.minutes);
}

/** The activity an observation suggests: one activity holding ≥10 min AND ≥50% of active time; else none. */
const OBSERVATION_MIN_MINUTES = 10;
const OBSERVATION_MIN_SHARE = 0.5;
function observationSuggestion(apps) {
  const total = (apps || []).reduce((n, a) => n + (Number(a.minutes) || 0), 0);
  if (!total) return null;
  const by = {};
  for (const a of apps) {
    const act = PROCESS_ACTIVITY[String(a.app || '').toLowerCase()];
    if (act) by[act] = (by[act] || 0) + (Number(a.minutes) || 0);
  }
  const [activity, minutes] = Object.entries(by).sort((x, y) => y[1] - x[1])[0] || [];
  if (!activity) return null;
  const share = minutes / total;
  if (minutes < OBSERVATION_MIN_MINUTES || share < OBSERVATION_MIN_SHARE) return null;
  return { activity, minutes: Math.round(minutes * 10) / 10, share: Math.round(share * 100) / 100 };
}

/**
 * Apply the precedence. Inputs: Nick's stored choice (or null), the task's
 * source fields, and its PENDING observations (reviewed ones are already a
 * choice or a dismissal).
 * → { activity, basis, unsure, suggestions[] }   activity is set ONLY by a choice.
 */
function resolveActivity({ choice = null, task = null, observations = [] } = {}) {
  const suggestions = [];
  const src = sourceSuggestion(task);
  if (src) suggestions.push({ activity: src, basis: 'source' });
  for (const o of observations || []) {
    if (o && o.status === 'pending' && o.suggestedActivity && !suggestions.some((s) => s.activity === o.suggestedActivity && s.basis === 'observed')) {
      suggestions.push({ activity: o.suggestedActivity, basis: 'observed', ref: `observation:${o.id}` });
    }
  }
  if (choice && ACTIVITIES.includes(choice)) return { activity: choice, basis: 'stated', unsure: false, suggestions: [] };
  if (choice === UNSURE) return { activity: null, basis: 'stated', unsure: true, suggestions };
  return { activity: null, basis: null, unsure: false, suggestions };
}

module.exports = {
  UNSURE, CHOICES, SUGGESTION_BASES, SOURCE_SUGGESTION, PROCESS_ACTIVITY, OBSERVATION_MIN_MINUTES, OBSERVATION_MIN_SHARE,
  sourceSuggestion, observeWindow, observationSuggestion, resolveActivity,
};
