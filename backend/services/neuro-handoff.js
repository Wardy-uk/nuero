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

const LINKS = require('../../shared/neuro-links.cjs');

const neuro = (view) => `neuro:?view=${view}`;
/** An exact-item link target, or null when the id is not a valid one for the kind. */
const exact = (role, kind, id, label) => { const href = id == null ? null : LINKS.linkFor(kind, String(id)); return href ? { role, href, label } : null; };
const gap = (field, why) => ({ field, why });
const TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

/** Where NEURO shows which feed stopped — the place to look when SAiM is blind. */
const SOURCES = Object.freeze({ role: 'source', href: neuro('sources'), label: 'Sources in NEURO' });
function constraintTargets() { return [{ ...SOURCES }]; }

const NO_TASK_ACTIVITY = 'NEURO holds no structured activity for a task (no field states what kind of work it is)';
const NO_TASK_LINK = 'the card carries no NEURO task id to link to';
const NO_BLOCK_TASK = 'a block of several tasks (or none) has no single task record to link to';
const NO_ACTION_LINK = 'the approval carries no valid action id';
const NO_JOIN = 'the diary cache keeps no meeting join link';
const NO_PREP = 'the meeting carries no diary event id to open its prep at';
const NO_PROVIDER = 'the diary cache doesn’t record which meeting app hosts it';

/** Jira's own page for a ticket, from the configured base and a STRUCTURED key — never a parsed title. */
function jiraBrowse(jiraBase, key, given) {
  const base = String(jiraBase || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) return null;
  if (given && String(given).startsWith(`${base}/browse/`)) return String(given);
  return key && TICKET_KEY.test(String(key)) ? `${base}/browse/${key}` : null;
}

/**
 * The ticket's own page, as a CONTROL target (16 Oct 2026) — Jira is where a ticket is
 * worked. From the STRUCTURED `jira` fact the composer set (shared/jira-key.cjs): the
 * ledger link, or a strictly recognised key. Never from wording here.
 */
function jiraTarget(j, jiraBase) {
  if (!j || !TICKET_KEY.test(String(j.key || ''))) return null;
  const href = jiraBrowse(jiraBase, j.key, j.url || null);
  return href ? { role: 'control', href, label: `${j.key} in Jira`, provider: 'jira', key: j.key, basis: j.basis || null } : null;
}

const workStep = (activity, basis, gaps, targets = []) => ({ handoffIntent: { kind: 'work-step', activity, ...(basis ? { basis } : {}) }, targets: targets.filter(Boolean), handoffGaps: gaps });
/**
 * A task work step. The activity is NICK'S CHOICE or nothing (shared/task-activity.cjs):
 * `act` is resolveActivity()'s answer for this task. Suggestions (source, observed)
 * never fill `activity` — they travel as `activitySuggestions`.
 */
const taskStep = (taskId, noLinkWhy, act = null, jira = null) => {
  const t = exact('canonical', 'task', taskId, 'This task in NEURO');
  const a = act || null;
  const activity = a && a.activity ? a.activity : null;
  const intent = { kind: 'work-step', activity, ...(a && a.basis ? { basis: a.basis } : {}), ...(a && a.unsure ? { unsure: true } : {}) };
  const gaps = activity ? [] : [gap('activity', a && a.unsure ? 'Nick said he isn’t sure what this needs' : NO_TASK_ACTIVITY)];
  return {
    handoffIntent: intent,
    targets: [...(jira ? [jira] : []), ...(t ? [t] : [])],
    handoffGaps: t ? gaps : [...gaps, gap('canonical', noLinkWhy)],
    activitySuggestions: a && !activity ? a.suggestions.map((s) => ({ ...s })) : [],
  };
};
/** A meeting: prep at the exact diary event when NEURO holds its id. */
const meetingStep = (eventId) => {
  const prep = exact('prep', 'meeting-prep', eventId, 'Meeting prep');
  return { handoffIntent: { kind: 'meeting', provider: null }, targets: prep ? [prep] : [], handoffGaps: [gap('join', NO_JOIN), ...(prep ? [] : [gap('prep', NO_PREP)]), gap('provider', NO_PROVIDER)] };
};

/**
 * The hand-off fields for one candidate.
 * @param {object} c        the candidate as composed (kind, id, facts)
 * @param {object|null} meta the decision-engine item's meta, for attention items
 * @param {{ jiraBase?: string }} opts
 * @returns {{ handoffIntent: object|null, targets: object[], handoffGaps: object[] }}
 */
function handoffFor(c, meta = null, { jiraBase = null, taskActivity = null } = {}) {
  const m = meta || {};
  const actFor = (id) => (taskActivity && id != null && taskActivity.get(Number(id))) || null;
  switch (c.kind) {
    case 'block': {
      const tasks = (c.facts && Array.isArray(c.facts.tasks)) ? c.facts.tasks : [];
      const one = tasks.length === 1 ? tasks[0].taskId : null;
      return taskStep(one, NO_BLOCK_TASK, actFor(one), one != null ? jiraTarget(tasks[0].jira, jiraBase) : null);
    }
    case 'commitment':
      return taskStep(c.taskId, NO_TASK_LINK, actFor(c.taskId), jiraTarget(c.facts && c.facts.jira, jiraBase));
    case 'meeting':
      return meetingStep(c.eventId);
    case 'protected-time':
      return { handoffIntent: null, targets: [], handoffGaps: [gap('intent', 'a solo diary entry states no purpose — no task block says what it’s for')] };
    case 'approval': {
      const t = exact('canonical', 'action', String(c.id || '').replace(/^approval:/, ''), 'This action in NEURO');
      return { handoffIntent: { kind: 'approval' }, targets: t ? [t] : [], handoffGaps: t ? [] : [gap('canonical', NO_ACTION_LINK)] };
    }
    case 'ritual':
      return { handoffIntent: { kind: 'none', basis: 'the ritual happens in SAiM' }, targets: [], handoffGaps: [] };
    case 'home': {
      const k = c.facts && c.facts.homeKind;
      if (k === 'hazard') {
        const t = exact('canonical', 'hazard', c.facts.entityId, 'This hazard in NEURO');
        return { handoffIntent: { kind: 'risk' }, targets: t ? [t] : [], handoffGaps: [
          gap('control', 'no browser address for Home Assistant is configured for NEURO to link to'),
          ...(t ? [] : [gap('canonical', 'the hazard carries no sensor id to link to')]),
        ] };
      }
      if (k === 'obligation') return taskStep(c.taskId, NO_TASK_LINK, actFor(c.taskId));
      return { handoffIntent: null, targets: [], handoffGaps: [gap('intent', `no hand-off is defined for a household ${k || 'item'}`)] };
    }
    case 'attention-item':
      return itemHandoff(c.facts && c.facts.type, m, jiraBase, actFor);
    case 'held':
    case 'personal-date':
    default:
      return { handoffIntent: null, targets: [], handoffGaps: [gap('intent', `no hand-off is defined for a ${c.kind} candidate`)] };
  }
}

/** By decision-engine item TYPE — a structured field, never the card's wording. */
function itemHandoff(type, m, jiraBase, actFor = () => null) {
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
    case 'email': {
      const t = exact('canonical', 'email', m.emailId, 'This email in NEURO');
      return workStep('email', 'item-type', t ? [] : [gap('canonical', 'the card carries no email id to link to')], [t]);
    }
    case 'todo':
      // decision-engine's todo cards carry a slug, not a task id.
      return taskStep(m.taskId, NO_TASK_LINK, actFor(m.taskId));
    case 'meeting':
      // decision-engine names a meeting item `cal-<event id>` — a structured id, not wording.
      return meetingStep(typeof m.engineId === 'string' && m.engineId.startsWith('cal-') ? m.engineId.slice(4) : null);
    default:
      return { handoffIntent: null, targets: [], handoffGaps: [gap('intent', `no hand-off is defined for a "${type || 'unknown'}" item`)] };
  }
}

module.exports = { handoffFor, constraintTargets, jiraBrowse, jiraTarget, SOURCES };
