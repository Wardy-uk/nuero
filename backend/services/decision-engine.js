'use strict';

/**
 * Decision Engine — Rule-based signal evaluation with tier classification
 * and suppression logic.
 *
 * Collects signals from existing data sources, scores them deterministically,
 * classifies into tiers, and enforces hard limits.
 *
 * NO LLM calls. NO complex frameworks. Just rules.
 *
 * Tiers:
 *   Tier 1 — MUST ACT NOW (score >= 80)
 *   Tier 2 — SHOULD DO NEXT (score >= 50)
 *   Tier 3 — IGNORE FOR NOW (score < 50, suppressed from focus)
 *
 * Hard limits:
 *   Default: 5 items
 *   Max fallback: 7 items
 *   Never more than 7
 */

const db = require('../db/database');
const workingMemory = require('./working-memory');

// ── Tier thresholds ──
const TIER_1_MIN = 80;  // MUST ACT NOW
const TIER_2_MIN = 50;  // SHOULD DO NEXT
// Below 50 = Tier 3 (suppressed from default focus)

// ── Hard limits ──
const FOCUS_DEFAULT = 5;
const FOCUS_MAX = 7;

// ── Suppression: in-memory, keyed by item ID ──
// { [itemId]: { suppressedAt: timestamp, reason: string } }
const _suppressed = new Map();
const SUPPRESS_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// ── Signal Collectors ──
// Each returns an array of { id, type, title, reason, score, urgency, source, actionHint, meta? }

function collectEscalations(ctx) {
  const items = [];
  if (ctx.unseenEscalations > 0) {
    items.push({
      type: 'escalation',
      id: 'escalations-unseen',
      title: `${ctx.unseenEscalations} unseen escalation${ctx.unseenEscalations > 1 ? 's' : ''}`,
      reason: 'Escalations need your attention',
      score: 95,
      urgency: 'critical',
      source: 'jira',
      actionHint: 'Open Queue → Escalations',
    });
  }
  return items;
}

function collectSlaBreaches(ctx) {
  const items = [];
  if (!ctx.queueSummary) return items;

  const atRisk = ctx.queueSummary.at_risk_tickets || [];

  // Collapse multiple at-risk tickets into a single signal if > 3
  // Otherwise show individually
  if (atRisk.length > 3) {
    const p1s = atRisk.filter(t => _isP1(t));
    if (p1s.length > 0) {
      items.push({
        type: 'jira_ticket',
        id: 'jira-p1-summary',
        title: `${p1s.length} P1 ticket${p1s.length > 1 ? 's' : ''} at risk`,
        reason: `${p1s.map(t => t.ticket_key).join(', ')} — SLA breaching`,
        score: 92,
        urgency: 'critical',
        source: 'jira',
        actionHint: 'Check P1s immediately',
        meta: { keys: p1s.map(t => t.ticket_key) },
      });
    }
    const nonP1 = atRisk.filter(t => !_isP1(t));
    if (nonP1.length > 0) {
      items.push({
        type: 'jira_ticket',
        id: 'jira-atrisk-summary',
        title: `${nonP1.length} ticket${nonP1.length > 1 ? 's' : ''} at SLA risk`,
        reason: `${nonP1.slice(0, 3).map(t => t.ticket_key).join(', ')}${nonP1.length > 3 ? ` +${nonP1.length - 3} more` : ''}`,
        score: 82,
        urgency: 'high',
        source: 'jira',
        actionHint: 'Review queue',
        meta: { count: nonP1.length },
      });
    }
  } else {
    // Show individually if 3 or fewer
    for (const t of atRisk) {
      const isP1 = _isP1(t);
      const slaMin = Math.round(t.sla_remaining_minutes || 0);
      items.push({
        type: 'jira_ticket',
        id: `jira-${t.ticket_key}`,
        title: `${t.ticket_key}: ${t.summary}`,
        reason: isP1
          ? `P1 — ${slaMin} min SLA remaining`
          : `At risk — ${slaMin} min SLA remaining`,
        score: isP1 ? 92 : 82,
        urgency: isP1 ? 'critical' : 'high',
        source: 'jira',
        actionHint: 'Check ticket',
        meta: { key: t.ticket_key, assignee: t.assignee, priority: t.priority },
      });
    }
  }
  return items;
}

function collectMeetings(ctx) {
  const items = [];
  if (!ctx.calendar || ctx.calendar.length === 0) return items;

  const now = new Date();
  const twoHours = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  for (const event of ctx.calendar) {
    if (event.is_all_day) continue;
    const start = new Date(event.start_time);
    if (start <= now || start > twoHours) continue;

    const minutesAway = Math.round((start - now) / 60000);

    // Only surface meetings within 60 min — 2hr meetings are noise
    if (minutesAway > 60) continue;

    const imminent = minutesAway <= 15;
    const soon = minutesAway <= 30;

    items.push({
      type: 'meeting',
      id: `cal-${event.event_id}`,
      title: event.subject,
      reason: minutesAway <= 5 ? 'Starting now' : `In ${minutesAway} min`,
      score: imminent ? 88 : soon ? 72 : 55,
      urgency: imminent ? 'critical' : soon ? 'high' : 'medium',
      source: 'calendar',
      actionHint: imminent ? 'Join / prep now' : 'Coming up',
      meta: { start: event.start_time, end: event.end_time, location: event.location },
    });
  }
  return items;
}

function collectOverdueTodos(ctx) {
  const items = [];
  if (!ctx.todos || !ctx.todos.active) return items;

  const todayStr = ctx.dateKey;
  let overdueCount = 0;
  let dueTodayCount = 0;
  let topOverdue = null;
  let topDueToday = null;

  for (const todo of ctx.todos.active) {
    if (!todo.due_date) continue;
    const dueStr = todo.due_date.split('T')[0];
    const isPlanTask = (todo.source || '').toLowerCase().includes('plan') ||
                       (todo.source || '').toLowerCase().includes('90');

    if (dueStr < todayStr) {
      overdueCount++;
      // Track the single highest-priority overdue item
      const score = isPlanTask ? 85 : 65;
      if (!topOverdue || score > topOverdue.score) {
        topOverdue = { text: todo.text, dueStr, isPlanTask, score, source: todo.source };
      }
    } else if (dueStr === todayStr) {
      dueTodayCount++;
      const score = isPlanTask ? 68 : 45;
      if (!topDueToday || score > topDueToday.score) {
        topDueToday = { text: todo.text, dueStr, isPlanTask, score, source: todo.source };
      }
    }
  }

  // Collapse overdue into 1-2 items max
  if (overdueCount > 0 && topOverdue) {
    if (overdueCount === 1) {
      items.push({
        type: 'todo',
        id: `todo-overdue-top`,
        title: topOverdue.text,
        reason: `Overdue (due ${topOverdue.dueStr})`,
        score: topOverdue.score,
        urgency: topOverdue.isPlanTask ? 'high' : 'medium',
        source: topOverdue.source || 'vault',
        actionHint: 'Complete or reschedule',
        meta: { dueDate: topOverdue.dueStr, overdueCount },
      });
    } else {
      // Summarise: show count + top item
      items.push({
        type: 'todo',
        id: `todo-overdue-summary`,
        title: `${overdueCount} overdue task${overdueCount > 1 ? 's' : ''}`,
        reason: `Top: ${topOverdue.text.substring(0, 60)}`,
        score: topOverdue.score,
        urgency: topOverdue.isPlanTask ? 'high' : 'medium',
        source: 'vault',
        actionHint: 'Review todos',
        meta: { overdueCount },
      });
    }
  }

  // Collapse due-today similarly — but lower priority
  if (dueTodayCount > 0 && topDueToday) {
    if (dueTodayCount === 1) {
      items.push({
        type: 'todo',
        id: `todo-today-top`,
        title: topDueToday.text,
        reason: 'Due today',
        score: topDueToday.score,
        urgency: topDueToday.isPlanTask ? 'medium' : 'low',
        source: topDueToday.source || 'vault',
        actionHint: 'Do today',
        meta: { dueDate: topDueToday.dueStr, dueTodayCount },
      });
    } else {
      items.push({
        type: 'todo',
        id: `todo-today-summary`,
        title: `${dueTodayCount} task${dueTodayCount > 1 ? 's' : ''} due today`,
        reason: `Top: ${topDueToday.text.substring(0, 60)}`,
        score: topDueToday.score,
        urgency: 'low',
        source: 'vault',
        actionHint: 'Review todos',
        meta: { dueTodayCount },
      });
    }
  }

  return items;
}

function collectUrgentEmails(ctx) {
  const items = [];
  try {
    const scanner = require('./inbox-scanner');
    const inbox = scanner.getFlaggedItems();
    const highItems = (inbox.items || []).filter(i => i.urgency === 'high');
    if (highItems.length > 0) {
      // Collapse to single item
      items.push({
        type: 'email',
        id: 'email-urgent',
        title: highItems.length === 1
          ? highItems[0].subject
          : `${highItems.length} urgent email${highItems.length > 1 ? 's' : ''}`,
        reason: highItems.length === 1
          ? `From ${highItems[0].from}`
          : `${highItems.slice(0, 2).map(e => e.from?.split(' ')[0] || 'Unknown').join(', ')}${highItems.length > 2 ? ` +${highItems.length - 2}` : ''}`,
        score: 70,
        urgency: 'high',
        source: 'email',
        actionHint: 'Check inbox',
        meta: { count: highItems.length },
      });
    }
  } catch {}
  return items;
}

function collectNudges(ctx) {
  const items = [];
  for (const nudge of (ctx.nudges || [])) {
    const isStandup = nudge.type === 'standup';
    const isEod = nudge.type === 'eod';
    const nagCount = nudge.nag_count || 0;

    // Standup/EOD nudges are important; others are lower
    const score = isStandup ? 72 + Math.min(nagCount * 3, 15) :
                  isEod ? 65 + Math.min(nagCount * 3, 10) :
                  40 + Math.min(nagCount * 2, 10);

    items.push({
      type: 'nudge',
      id: `nudge-${nudge.id}`,
      title: isStandup ? 'Standup not done' :
             isEod ? 'End-of-day not done' :
             `${nudge.type} reminder`,
      reason: nudge.message,
      score,
      urgency: nagCount >= 4 ? 'high' : nagCount >= 2 ? 'medium' : 'low',
      source: 'neuro',
      actionHint: isStandup ? 'Open Standup' : isEod ? 'Open EOD' : `Complete ${nudge.type}`,
      meta: { nagCount, type: nudge.type },
    });
  }
  return items;
}

function collectImports(ctx) {
  const items = [];
  if (ctx.pendingImports > 0) {
    items.push({
      type: 'imports',
      id: 'imports-pending',
      title: `${ctx.pendingImports} file${ctx.pendingImports > 1 ? 's' : ''} awaiting review`,
      reason: 'Unclassified imports in vault',
      score: 35,
      urgency: 'low',
      source: 'imports',
      actionHint: 'Review & route',
    });
  }
  return items;
}


// ── Tier Classification ──

function classifyTier(score) {
  if (score >= TIER_1_MIN) return 1;
  if (score >= TIER_2_MIN) return 2;
  return 3;
}


// ── Suppression Logic ──

function isSuppressed(itemId) {
  const entry = _suppressed.get(itemId);
  if (!entry) return false;
  if (Date.now() - entry.suppressedAt > SUPPRESS_WINDOW_MS) {
    _suppressed.delete(itemId);
    return false;
  }
  return true;
}

function suppressItem(itemId, reason) {
  _suppressed.set(itemId, { suppressedAt: Date.now(), reason });
}

function clearExpiredSuppressions() {
  const now = Date.now();
  for (const [id, entry] of _suppressed) {
    if (now - entry.suppressedAt > SUPPRESS_WINDOW_MS) {
      _suppressed.delete(id);
    }
  }
}


// ── Main Evaluation ──

/**
 * Evaluate all signals and return focus items.
 *
 * @param {object} options
 * @param {boolean} options.showAll - If true, return all candidates (for "view all" mode)
 * @returns {{ items, totalCandidates, returned, suppressed, tiers }}
 */
async function evaluate(options = {}) {
  const { showAll = false } = options;
  const ctx = await workingMemory.getContext();

  // Collect all signals
  const allSignals = [
    ...collectEscalations(ctx),
    ...collectSlaBreaches(ctx),
    ...collectMeetings(ctx),
    ...collectOverdueTodos(ctx),
    ...collectUrgentEmails(ctx),
    ...collectNudges(ctx),
    ...collectImports(ctx),
  ];

  // Deduplicate by id
  const seen = new Set();
  const candidates = [];
  for (const item of allSignals) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    candidates.push({
      ...item,
      tier: classifyTier(item.score),
    });
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  const totalCandidates = candidates.length;

  // Clean up old suppressions
  clearExpiredSuppressions();

  if (showAll) {
    // View-all mode: return everything, still sorted, with tier labels
    return {
      items: candidates,
      totalCandidates,
      returned: candidates.length,
      suppressed: 0,
      tiers: _countTiers(candidates),
    };
  }

  // Apply suppression + tier filtering
  const focused = [];
  let suppressedCount = 0;

  for (const item of candidates) {
    // Tier 3 is always suppressed from default focus
    if (item.tier === 3) {
      suppressedCount++;
      continue;
    }

    // Check time-based suppression (same item shown recently)
    if (isSuppressed(item.id)) {
      suppressedCount++;
      continue;
    }

    // Items with no urgency and no clear deadline get suppressed
    if (item.urgency === 'low' && !item.meta?.dueDate && item.type !== 'nudge') {
      suppressedCount++;
      continue;
    }

    focused.push(item);

    // Hard cap
    if (focused.length >= FOCUS_MAX) break;
  }

  // Apply default limit (prefer FOCUS_DEFAULT, allow up to FOCUS_MAX only for tier 1)
  let finalItems;
  if (focused.length <= FOCUS_DEFAULT) {
    finalItems = focused;
  } else {
    // Keep all tier 1 items (up to FOCUS_MAX), then fill with tier 2 up to FOCUS_DEFAULT
    const tier1 = focused.filter(i => i.tier === 1);
    const tier2 = focused.filter(i => i.tier === 2);

    if (tier1.length >= FOCUS_MAX) {
      // Even tier 1 alone exceeds max — take top FOCUS_MAX by score
      finalItems = tier1.slice(0, FOCUS_MAX);
    } else if (tier1.length >= FOCUS_DEFAULT) {
      // Tier 1 fills the default — only add tier 2 if there's room up to max
      finalItems = [...tier1, ...tier2.slice(0, FOCUS_MAX - tier1.length)];
    } else {
      // Tier 1 is small — fill to FOCUS_DEFAULT with tier 2
      finalItems = [...tier1, ...tier2.slice(0, FOCUS_DEFAULT - tier1.length)];
    }
  }

  suppressedCount += (focused.length - finalItems.length);
  suppressedCount += (totalCandidates - focused.length - suppressedCount);
  // Correct: suppressed = total - returned
  const actualSuppressed = totalCandidates - finalItems.length;

  return {
    items: finalItems,
    totalCandidates,
    returned: finalItems.length,
    suppressed: actualSuppressed,
    tiers: _countTiers(candidates),
  };
}

/**
 * Manually suppress an item (e.g. user dismissed it).
 */
function dismiss(itemId) {
  suppressItem(itemId, 'user-dismissed');
}

function _isP1(ticket) {
  const p = (ticket.priority || '').toLowerCase();
  return p.includes('1') || p.includes('critical') || p.includes('highest');
}

function _countTiers(items) {
  const tiers = { tier1: 0, tier2: 0, tier3: 0 };
  for (const item of items) {
    if (item.tier === 1) tiers.tier1++;
    else if (item.tier === 2) tiers.tier2++;
    else tiers.tier3++;
  }
  return tiers;
}

module.exports = {
  evaluate,
  dismiss,
  FOCUS_DEFAULT,
  FOCUS_MAX,
};
