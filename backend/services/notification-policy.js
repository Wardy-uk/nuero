'use strict';

/**
 * Notification policy (Build 12.3G/H) — which P0 items may interrupt, on what
 * channel, and under what identity.
 *
 * ⚠ ONE PLACE DECIDES. The watch, the phone and any future surface read
 *   `notification` off each P0 item and do what it says; none of them has a
 *   rule of its own about what deserves a buzz. "Urgent email = watch
 *   notification" written into UI code is the exact thing this file exists to
 *   prevent.
 * ⚠ IT NEVER CREATES URGENCY. The P0 list is the presentation's (attention's
 *   verdict, classified once in presentation-intent). This file only answers
 *   "of the things already P0, which may interrupt". Nothing that is not P0 is
 *   ever eligible.
 * ⚠ P0 IS WIDER THAN "WORTH A BUZZ", AND THAT WAS MEASURED. In decision-engine
 *   `critical` — which presentation-intent maps to P0 — also covers a meeting
 *   starting within ten minutes and the standup before 11:00. Both already have
 *   their own interruption (meeting_alert, the ritual channel), so this policy
 *   counts them in "Needs you" but does not notify for them a second time.
 * ⚠ URGENT EMAIL IS NOT ELIGIBLE LIVE, on purpose. The triage `urgent` lane is
 *   a classifier's call (AI + rules) and arrives as urgency `high`, never
 *   `critical`; it already drives the email nudge. An email card is eligible
 *   only when it arrives `critical`, which today only the synthetic fixture
 *   does. No keyword rule exists here or anywhere downstream of it.
 * ⚠ PURE. Item + card in, policy out.
 */

const CHANNEL_LOCAL = 'native-local';

// Interrupt kinds and what each is, in one table. `eligible` here is the
// default for that kind when it is P0; `existing` names a sender that already
// interrupts for it, so the policy can say why it adds nothing.
const KINDS = {
  approval: { eligible: true, ttlHours: 12, why: 'A governed draft is waiting for your approval code.' },
  escalation: { eligible: true, ttlHours: 24, why: 'A Jira escalation has no reply from you.', existing: 'web-push escalation_alert (PWA)' },
  email: { eligible: false, ttlHours: 6, why: 'The urgent-email lane is a classifier call, not a P0 verdict — it stays a nudge.', existing: 'email nudge' },
  meeting: { eligible: false, ttlHours: 1, why: 'A meeting about to start is a time cue — meeting_alert and the calendar already notify.', existing: 'meeting_alert' },
  nudge: { eligible: false, ttlHours: 6, why: 'A ritual nudge — the ritual channel already delivers it.', existing: 'ritual nudges' },
  source: { eligible: false, ttlHours: 12, why: 'A source going blind is shown, not buzzed, unless it is critical.' },
};

/** The card type behind a P0 presentation item. PURE. */
function kindOf(item, card) {
  if (item && item.kind === 'approval') return 'approval';
  const t = card && card.type;
  if (t === 'escalation') return 'escalation';
  if (t === 'email') return 'email';
  if (t === 'meeting') return 'meeting';
  if (t === 'nudge') return 'nudge';
  if (t === 'source-blind' || t === 'source') return 'source';
  return t || 'unknown';
}

/**
 * A SEMANTIC key: stable across polls, restarts and reconnects, and different
 * when the underlying thing is different. PURE.
 *   approvals  — the newest waiting draft (a new draft is news; the same set is not)
 *   escalation — the set of unseen ticket keys
 *   otherwise  — the attention record (one record per thing, per occurrence)
 */
function dedupeKeyFor(kind, item, card, extra = {}) {
  if (kind === 'approval') return `approvals:${extra.newestAt || item.count || 'x'}`;
  const meta = (card && card.meta) || {};
  const prefix = meta.synthetic ? `synthetic:${meta.syntheticId}:` : '';
  if (kind === 'escalation' && Array.isArray(meta.escalations) && meta.escalations.length) {
    const keys = meta.escalations.map((e) => e && e.key).filter(Boolean).sort();
    if (keys.length) return `${prefix}escalation:${keys.join(',')}`;
  }
  const rec = card && card.recordId;
  return `${prefix}${kind}:${rec || (card && card.id) || item.id}`;
}

/**
 * The policy for one P0 item. PURE.
 * @returns {{eligible, urgency, channels, reason, dedupeKey, ttl, escalationBehaviour, existingSender, synthetic}}
 */
function policyFor(item, card = null, extra = {}) {
  const kind = kindOf(item, card);
  const meta = (card && card.meta) || {};
  const synthetic = meta.synthetic === true;
  const base = KINDS[kind];
  const urgency = String((card && card.urgency) || (item && item.urgency) || '').toLowerCase();
  let eligible; let reason;
  if (!item || item.priority !== 'P0') { eligible = false; reason = 'Not P0 — nothing below P0 interrupts.'; }
  else if (!base) { eligible = false; reason = `No policy for "${kind}" — counted as needing you, never buzzed.`; }
  else if (kind === 'email' || kind === 'source') {
    // Eligible only on a CRITICAL card — the classifier's ceiling is `high`.
    eligible = urgency === 'critical';
    reason = eligible ? (kind === 'email' ? 'An email arrived marked critical.' : 'A source failure is blocking.') : base.why;
  } else { eligible = base.eligible; reason = base.why; }
  const ttlHours = synthetic ? 0.25 : (base ? base.ttlHours : 6);
  return {
    eligible,
    urgency: 'P0',
    channels: eligible ? [CHANNEL_LOCAL] : [],
    reason,
    dedupeKey: dedupeKeyFor(kind, item, card, extra),
    ttl: Math.round(ttlHours * 3600),
    // Once per key. A changed key (a new escalation joins the set, a new draft
    // arrives) is a new notification; the same key never re-notifies.
    escalationBehaviour: 'once-per-key',
    existingSender: base && base.existing ? base.existing : null,
    synthetic,
    kind,
  };
}

/**
 * The canonical P0 digest a watch and a phone count and notify from. PURE.
 * @param {object[]} entries [{ item, card }] already-P0 items in presentation order
 * @param {object}   opts    { known, complete, newestApprovalAt, asOf }
 */
function p0Digest(entries, { known = true, complete = true, newestApprovalAt = null, asOf = null } = {}) {
  const items = [];
  const seen = new Set();
  for (const { item, card } of entries) {
    if (!item || item.priority !== 'P0' || seen.has(item.id)) continue;
    seen.add(item.id);
    const meta = (card && card.meta) || {};
    const notification = policyFor(item, card, { newestAt: newestApprovalAt });
    items.push({
      id: item.id,
      // The decision-engine card id — what the phone's older speech nudge keys
      // on, so the two paths can recognise one card and never both buzz.
      cardId: (card && card.id) || (item.actionRef && item.actionRef.cardId) || null,
      kind: notification.kind,
      title: item.title,
      why: item.summary || notification.reason,
      source: notification.kind === 'approval' ? 'neuro-actions' : (card && card.type) || item.kind,
      since: (card && card.firstSeenAt) || null,
      tab: (card && card.tab) || (item.actionRef && item.actionRef.tab) || null,
      handOff: item.handOff || null,
      count: Number.isFinite(item.count) ? item.count : 1,
      synthetic: meta.synthetic === true,
      notification,
    });
  }
  // An aggregate (approvals: "2 drafts") stands for its count; nothing else does.
  const count = items.reduce((n, i) => n + Math.max(1, i.count || 1), 0);
  return { known, complete, count, items, asOf };
}

module.exports = { CHANNEL_LOCAL, KINDS, kindOf, dedupeKeyFor, policyFor, p0Digest };
