'use strict';

/**
 * NEURO's half of the hand-off (15 Oct 2026): the STRUCTURED intent and the
 * canonical links on each neuro-candidates-v2 candidate. PURE — the composer
 * passes in what it already holds; nothing here reads a database or the clock.
 *
 * What NEURO says here is FACT, never recommendation. SAiM's resolver
 * (saim/policy/handoff.cjs) picks the app; NEURO only says what kind of thing
 * this is and which exact places hold it.
 *
 * Three rules:
 *   1. An intent comes from a STRUCTURED field — the candidate's kind, the
 *      decision-engine item TYPE, a ritual flag. Never from a title, subject,
 *      reason or description. A work step's `activity` comes only from a field
 *      that states it; nothing in NEURO states one for a task yet, so tasks get
 *      `activity: null` with the gap said.
 *   2. A link is emitted only if it opens the EXACT item or action, or the one
 *      place that is that item (e.g. the week's risk report, the Sources page).
 *      A page that merely contains it is NOT a canonical link — it is recorded
 *      as a gap, naming the nearest page, so a later decision can choose.
 *   3. Absence is EXPLICIT: `handoffGaps: [{ field, why }]` says what NEURO
 *      could not supply and why. Silence is never "nothing to supply".
 *
 * NEURO links use the `neuro:` scheme (`neuro:?view=sources`): relative to
 * wherever the client knows NEURO lives, so NEURO never has to know its own
 * public address and no host leaks into the payload.
 */

const neuro = (view) => `neuro:?view=${view}`;
const gap = (field, why) => ({ field, why });
const TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

/** Where NEURO shows which feed stopped — the place to look when SAiM is blind. */
const SOURCES = Object.freeze({ role: 'source', href: neuro('sources'), label: 'Sources in NEURO' });
function constraintTargets() { return [{ ...SOURCES }]; }

const NO_TASK_ACTIVITY = 'NEURO holds no structured activity for a task (no field states what kind of work it is)';
const NO_TASK_LINK = 'NEURO’s web app can’t open a single task from a link (nearest page: neuro:?view=todos)';
const NO_ACTION_LINK = 'NEURO’s web app can’t open a single approval from a link yet (nearest page: neuro:?view=actions)';
const NO_JOIN = 'the diary cache keeps no meeting join link';
const NO_PREP = 'NEURO’s meeting prep can’t be opened at one meeting from a link (nearest page: neuro:?view=meeting-prep)';
const NO_PROVIDER = 'the diary cache doesn’t record which meeting app hosts it';

/** Jira's own page for a ticket, from the configured base and a STRUCTURED key — never a parsed title. */
function jiraBrowse(jiraBase, key, given) {
  const base = String(jiraBase || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) return null;
  if (given && String(given).startsWith(`${base}/browse/`)) return String(given);
  return key && TICKET_KEY.test(String(key)) ? `${base}/browse/${key}` : null;
}

const workStep = (activity, basis, gaps) => ({ handoffIntent: { kind: 'work-step', activity, ...(basis ? { basis } : {}) }, targets: [], handoffGaps: gaps });

/**
 * The hand-off fields for one candidate.
 * @param {object} c        the candidate as composed (kind, id, facts)
 * @param {object|null} meta the decision-engine item's meta, for attention items
 * @param {{ jiraBase?: string }} opts
 * @returns {{ handoffIntent: object|null, targets: object[], handoffGaps: object[] }}
 */
function handoffFor(c, meta = null, { jiraBase = null } = {}) {
  const m = meta || {};
  switch (c.kind) {
    case 'block':
      return workStep(null, null, [gap('activity', NO_TASK_ACTIVITY), gap('canonical', NO_TASK_LINK)]);
    case 'commitment':
      return workStep(null, null, [gap('activity', NO_TASK_ACTIVITY), gap('canonical', NO_TASK_LINK)]);
    case 'meeting':
      return { handoffIntent: { kind: 'meeting', provider: null }, targets: [], handoffGaps: [gap('join', NO_JOIN), gap('prep', NO_PREP), gap('provider', NO_PROVIDER)] };
    case 'protected-time':
      return { handoffIntent: null, targets: [], handoffGaps: [gap('intent', 'a solo diary entry states no purpose — no task block says what it’s for')] };
    case 'approval':
      return { handoffIntent: { kind: 'approval' }, targets: [], handoffGaps: [gap('canonical', NO_ACTION_LINK)] };
    case 'ritual':
      return { handoffIntent: { kind: 'none', basis: 'the ritual happens in SAiM' }, targets: [], handoffGaps: [] };
    case 'home': {
      const k = c.facts && c.facts.homeKind;
      if (k === 'hazard') {
        return { handoffIntent: { kind: 'risk' }, targets: [], handoffGaps: [
          gap('control', 'no browser address for Home Assistant is configured for NEURO to link to'),
          gap('canonical', 'NEURO’s Home page lists hazards but can’t open one from a link (nearest page: neuro:?view=home)'),
        ] };
      }
      if (k === 'obligation') return workStep(null, null, [gap('activity', NO_TASK_ACTIVITY), gap('canonical', NO_TASK_LINK)]);
      return { handoffIntent: null, targets: [], handoffGaps: [gap('intent', `no hand-off is defined for a household ${k || 'item'}`)] };
    }
    case 'attention-item':
      return itemHandoff(c.facts && c.facts.type, m, jiraBase);
    case 'held':
    case 'personal-date':
    default:
      return { handoffIntent: null, targets: [], handoffGaps: [gap('intent', `no hand-off is defined for a ${c.kind} candidate`)] };
  }
}

/** By decision-engine item TYPE — a structured field, never the card's wording. */
function itemHandoff(type, m, jiraBase) {
  switch (type) {
    case 'escalation': {
      // decision-engine sets ticket_key only when exactly one escalation is unseen.
      if (m.ticket_key) {
        const href = jiraBrowse(jiraBase, m.ticket_key, m.url);
        return href
          ? { handoffIntent: { kind: 'risk' }, targets: [{ role: 'control', href, label: 'Jira', provider: 'jira' }], handoffGaps: [] }
          : { handoffIntent: { kind: 'risk' }, targets: [], handoffGaps: [gap('control', 'no Jira address or ticket key to link to')] };
      }
      // The card IS "these unseen escalations"; NEURO's Escalations page is exactly that list.
      return { handoffIntent: { kind: 'risk' }, targets: [{ role: 'canonical', href: neuro('escalations'), label: 'Escalations in NEURO' }], handoffGaps: [] };
    }
    case 'nova_flag': {
      const href = jiraBrowse(jiraBase, m.ticketKey, null);
      return href
        ? { handoffIntent: { kind: 'risk' }, targets: [{ role: 'control', href, label: 'Jira', provider: 'jira' }], handoffGaps: [] }
        : { handoffIntent: { kind: 'risk' }, targets: [], handoffGaps: [gap('control', 'no Jira address or ticket key to link to')] };
    }
    case 'weekly_risk':
    case 'weekly-risk':
      // One report per week: the Weekly risk page is that report.
      return { handoffIntent: { kind: 'risk' }, targets: [{ role: 'canonical', href: neuro('weekly-risk'), label: 'Weekly risk in NEURO' }], handoffGaps: [] };
    case 'source-blind':
      return { handoffIntent: { kind: 'risk' }, targets: [{ role: 'canonical', href: neuro('sources'), label: 'Sources in NEURO' }], handoffGaps: [] };
    case 'email':
      return workStep('email', 'item-type', [gap('canonical', 'NEURO’s web app can’t open a single email from a link (nearest page: neuro:?view=inbox)')]);
    case 'todo':
      return workStep(null, null, [gap('activity', NO_TASK_ACTIVITY), gap('canonical', NO_TASK_LINK)]);
    case 'meeting':
      return { handoffIntent: { kind: 'meeting', provider: null }, targets: [], handoffGaps: [gap('join', NO_JOIN), gap('prep', NO_PREP), gap('provider', NO_PROVIDER)] };
    default:
      return { handoffIntent: null, targets: [], handoffGaps: [gap('intent', `no hand-off is defined for a "${type || 'unknown'}" item`)] };
  }
}

module.exports = { handoffFor, constraintTargets, jiraBrowse, SOURCES };
