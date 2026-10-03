'use strict';

/**
 * The legacy `saim_actions` queue's OUTBOUND sender, and why it no longer
 * sends (Build 7 for chases, Build 8 for everything else). PURE — no DB, no
 * network — because three places must say the same thing and two of them
 * (action-presenter, its parity test) must not pull in the database:
 *
 *   suggestion-engine.executeAction  refuses the type, reaching no sender
 *   routes/actions approve           answers 410 with this text
 *   action-presenter                 renders it as the card's blocker
 *
 * ⚠ There is deliberately NO flag that restores any of these. Every email
 * NEURO can send as Nick goes through prepared-actions → human-proof approval
 * → action-executor, which keeps a ledger and verifies in Sent Items.
 */

const RETIRED = Object.freeze({
  chase_commitment: 'Retired in Build 7: chases are approved in Actions → Drafted by NEURO. Press Chase on the People board to draft one.',
  reply_email: 'Retired in Build 8: replies are no longer sent from this queue. Write it in the Inbox composer (or approve a drafted reply) — it lands in Actions → Drafted by NEURO, where you approve the exact email with your approval code.',
  send_weekly_risk_report: 'Retired in Build 8: the weekly report is no longer sent from this queue. Press Queue send on the Weekly Risk panel — it prepares the exact report for you to approve with your approval code.',
  chase_agenda: 'Retired in Build 8: agenda requests are no longer sent from this queue. Meeting triage now drafts them into Actions → Drafted by NEURO.',
  respond_meeting: 'Retired in Build 8: meeting responses are no longer sent from this queue. Respond in Outlook.',
  schedule_focus_block_invite: 'Retired in Build 8: a block with attendees emails real people, and this queue no longer sends anything outbound. Book it without attendees, or invite people from Outlook.',
});

/** Types whose every legacy row is retired (regardless of payload). */
const RETIRED_TYPES = Object.freeze(['chase_commitment', 'reply_email', 'send_weekly_risk_report', 'chase_agenda', 'respond_meeting']);

/** The retirement reason for a legacy action, or null when it may still run. PURE. */
function legacyRetired(action) {
  if (!action) return null;
  if (RETIRED_TYPES.includes(action.type)) return RETIRED[action.type];
  const p = action.payload || {};
  if (action.type === 'schedule_focus_block' && Array.isArray(p.attendees) && p.attendees.length) return RETIRED.schedule_focus_block_invite;
  return null;
}

module.exports = { RETIRED, RETIRED_TYPES, legacyRetired };
