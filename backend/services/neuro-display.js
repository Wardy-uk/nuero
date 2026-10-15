'use strict';

/**
 * NEURO's human display fields for each candidate (C5, 15 Oct 2026). PURE.
 *
 *   display: { title, timing, explanation }   — each a safe string or null
 *
 * Built from structured fields only: what kind of record it is, its own times,
 * its stated subject or text, decision-engine's human reason. Never an id, an
 * ISO time or an internal type name (shared/display-text.cjs decides "safe"; an
 * unsafe string becomes null rather than being passed through). The raw fields
 * (`title`, `time`, `facts`) stay exactly as they are for the policy; `display`
 * is what a screen may show.
 */

const D = require('../../shared/display-text.cjs');

/** What a prepared action IS, in words — never its type id. */
const ACTION_WORDS = Object.freeze({
  chase_commitment: 'Chase',
  chase_agenda: 'Ask for an agenda',
  reply_email: 'Reply',
  compose_email: 'Email',
  send_weekly_risk_report: 'Send the weekly risk report',
  create_calendar_event: 'Book',
  reschedule_calendar_event: 'Move',
  cancel_calendar_event: 'Cancel',
});
const RITUAL_WORDS = Object.freeze({ standup: 'The standup', eod: 'The end-of-day wrap' });

const span = (t) => (t && t.start ? (t.end ? `${t.start}–${t.end}` : t.start) : null);

function dueText(due, daysLate, now) {
  if (!due) return null;
  // No lateness given (home obligations): work it out from the date itself, so a
  // past date never reads as merely "due" (found on live data: an MOT 3 days late).
  if (!Number.isFinite(daysLate)) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(due));
    if (m) {
      const n = new Date(now);
      daysLate = Math.round((Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86400000);
    }
  }
  if (Number.isFinite(daysLate) && daysLate > 0) return `${daysLate} day${daysLate === 1 ? '' : 's'} overdue`;
  const d = D.dateText(due, now);
  return d ? `due ${d}` : null;
}

/**
 * NEURO writes "Task block: <task>" as the calendar subject of its OWN task blocks
 * (task-blocks.js). That prefix is NEURO's bookkeeping, not what the thing is called,
 * so it never reaches a person. Only this exact prefix — Nick's own words are untouched.
 */
const OWN_SUBJECT_PREFIX = /^Task block:\s+/;
const ownSubject = (s) => String(s || '').replace(OWN_SUBJECT_PREFIX, '');

/**
 * @param {object} c       the candidate as composed
 * @param {object} extra   { subject } for approvals (the action's own subject), and `now`
 */
function displayFor(c, { subject = null, now = Date.now() } = {}) {
  const f = c.facts || {};
  const t = c.time || {};
  let title = null; let timing = null; let explanation = null;
  switch (c.kind) {
    case 'block': {
      const tasks = Array.isArray(f.tasks) ? f.tasks : [];
      title = tasks.length === 1 ? D.safe(tasks[0].text) : tasks.length > 1 ? `${tasks.length} tasks` : D.safe(c.title);
      timing = span(t);
      break;
    }
    case 'meeting':
      title = D.safe(ownSubject(c.title)) || 'A meeting';
      timing = span(t);
      explanation = f.othersAttending === true ? 'With other people' : null;
      break;
    case 'protected-time':
      title = D.safe(c.title) || 'Diary time';
      timing = span(t);
      break;
    case 'approval': {
      const verb = ACTION_WORDS[f.type] || 'An action';
      const subj = D.safe(subject);
      title = subj ? `${verb}: ${subj}` : (ACTION_WORDS[f.type] ? verb : 'An action waiting for your approval');
      const by = t.deadlineAt ? D.whenText(t.deadlineAt, now) : null;
      timing = by ? `expires ${by}` : null;
      explanation = 'Waiting for your approval in NEURO';
      break;
    }
    case 'attention-item':
      title = D.safe(ownSubject(c.title));
      timing = t.start ? (Number.isFinite(t.minutesAway) ? (t.minutesAway <= 0 ? `now (${t.start})` : `in ${t.minutesAway} min (${t.start})`) : t.start) : null;
      explanation = D.safe(f.reason);
      break;
    case 'ritual':
      title = RITUAL_WORDS[f.ritual] || 'A daily ritual';
      explanation = D.safe(f.reason);
      break;
    case 'commitment':
      title = D.safe(c.title);
      timing = dueText(t.due, f.daysLate, now);
      explanation = D.safe(f.counterpart) ? `You owe ${D.safe(f.counterpart)}` : null;
      break;
    case 'home':
      title = D.safe(c.title);
      timing = t.due ? dueText(t.due, null, now) : null;
      explanation = D.safe(f.why);
      break;
    case 'personal-date':
      title = D.safe(c.title);
      timing = t.date ? D.dateText(t.date, now) : null;
      break;
    case 'held':
      title = D.safe(c.title) || 'Held back';
      explanation = D.safe(f.why);
      break;
    default:
      title = D.safe(c.title);
  }
  return { title: title || null, timing: timing || null, explanation: explanation || null };
}

module.exports = { displayFor, ACTION_WORDS };
