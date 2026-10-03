'use strict';

/**
 * What in the governed queue is waiting on Nick, as counts and ONE sentence
 * (Build 9). PURE: rows in, summary out — no DB, no clock, no flag read.
 *
 * Why it exists. Since Build 6 every outbound email is a prepared action that
 * needs Nick's approval code, and NOTHING outside the Actions screen knew one
 * was waiting: the sidebar badge counted the legacy saim_actions queue only,
 * and `/api/attention` — which every SAiM shell renders — carried no approval
 * state at all. So the Monday weekly-risk report could sit prepared all
 * morning while every surface Nick actually looks at said nothing.
 *
 * ⚠ IT SAYS WHERE, AND OFFERS NO BUTTON. Approval is desktop-only and needs a
 *   human proof (Build 7): the PIN every app holds proves nothing about a
 *   human. So SAiM renders this as a statement — "something needs you, in
 *   NEURO" — never as a control. An ambient surface that can send is one that
 *   can send by accident.
 *
 * ⚠ NOTHING WAITING IS SILENCE (`say: null`), never "nothing to approve" on
 *   every screen all day: a line that is always there is one nobody reads.
 *   An UNREADABLE queue is `known:false` with its own words — "I could not
 *   look" is not "there is nothing there".
 *
 * ⚠ NOT A PHASE. This deliberately does not feed `attention-operation`'s
 *   `awaiting_authorisation`: that phase is a physical write held for one word
 *   in the room, and a draft can legitimately wait hours for a desk. Lighting
 *   the crown for that is the always-on warning this codebase has paid for.
 */

const TYPE_NOUN = {
  chase_commitment: 'chase',
  reply_email: 'reply',
  chase_agenda: 'agenda request',
  send_weekly_risk_report: 'weekly risk report',
};

const WHERE = 'Actions, in NEURO on the desktop';

/** Statuses that mean "Nick must look", matching the route's buckets. */
function classify(row) {
  if (!row) return null;
  if (row.status === 'prepared') return 'approval';
  if (row.status === 'execution_uncertain') return 'review';
  if (row.status === 'failed' && (row.retrySafe === true || row.retry_safe === 1)) return 'review';
  return null;
}

function _list(nouns) {
  if (nouns.length === 0) return '';
  if (nouns.length === 1) return nouns[0];
  return `${nouns.slice(0, -1).join(', ')} and ${nouns[nouns.length - 1]}`;
}

/**
 * @param {Array<{actionType|action_type, status, retrySafe|retry_safe, createdAt|created_at}>} rows
 * @param {{sendingEnabled?: boolean|null}} opts
 */
function summarise(rows, { sendingEnabled = null } = {}) {
  const byType = {};
  let needsApproval = 0;
  let needsReview = 0;
  let oldestAt = null;
  for (const r of Array.isArray(rows) ? rows : []) {
    const c = classify(r);
    if (!c) continue;
    const type = r.actionType || r.action_type || 'unknown';
    if (c === 'approval') {
      needsApproval++;
      byType[type] = (byType[type] || 0) + 1;
      const at = r.createdAt || r.created_at || null;
      if (at && (!oldestAt || at < oldestAt)) oldestAt = at;
    } else {
      needsReview++;
    }
  }

  const parts = [];
  if (needsApproval > 0) {
    // Name the kinds only when there are few enough to read in one breath; a
    // fourth noun turns a sentence into a list nobody finishes.
    const nouns = [];
    for (const [t, n] of Object.entries(byType)) {
      const noun = TYPE_NOUN[t] || 'email';
      nouns.push(n === 1 ? `a ${noun}` : `${n} ${noun}${noun.endsWith('s') ? '' : 's'}`);
    }
    const kinds = nouns.length <= 3 ? ` (${_list(nouns)})` : '';
    parts.push(`${needsApproval} drafted email${needsApproval === 1 ? '' : 's'} wait${needsApproval === 1 ? 's' : ''} for your approval${kinds} — ${WHERE}.`);
    // ⚠ While the switch is off, approval is REFUSED before the code is asked
    // for (Build 7). Saying so here saves a walk to the desk to find that out.
    if (sendingEnabled === false) parts.push('Sending approved emails is switched off.');
  }
  if (needsReview > 0) {
    parts.push(`${needsReview} send${needsReview === 1 ? '' : 's'} need${needsReview === 1 ? 's' : ''} checking — NEURO couldn't confirm ${needsReview === 1 ? 'it' : 'they'} went.`);
  }

  return {
    known: true,
    needsApproval,
    needsReview,
    byType,
    oldestAt,
    sendingEnabled: sendingEnabled === null ? null : sendingEnabled === true,
    where: WHERE,
    say: parts.length ? parts.join(' ') : null,
  };
}

/** The shape for "I could not look". Never zeros. */
function unknown(why) {
  return {
    known: false,
    needsApproval: null,
    needsReview: null,
    byType: {},
    oldestAt: null,
    sendingEnabled: null,
    where: WHERE,
    why: why || 'could not read the approval queue',
    say: "Couldn't check whether anything is waiting for your approval.",
  };
}

module.exports = { summarise, unknown, classify, TYPE_NOUN, WHERE };
