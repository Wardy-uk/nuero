'use strict';

/**
 * Suggestion Engine — generates concrete action suggestions from Focus items.
 *
 * Phase 5A: Deterministic, rule-based. No LLM.
 * Actions require user approval before execution.
 *
 * Supported action types:
 *   - create_task
 *   - draft_message
 *   - update_vault
 *   - nudge
 *
 * Output shape per suggestion:
 *   { id, type, confidence, reason, payload, autoExecutable: false }
 */

const db = require('../db/database');

const SARA_MODE = process.env.SARA_MODE || 'suggest';

// ── Signal type → action mapping ──

const SUGGESTION_RULES = [
  {
    // Overdue plan task → create a focused task in daily note
    match: (item) => item.type === 'todo' && item.id.includes('overdue') && item.meta?.overdueCount > 0,
    generate: (item) => ({
      type: 'update_vault',
      confidence: 0.8,
      reason: `You have ${item.meta.overdueCount} overdue tasks. Adding the top one to today's focus.`,
      payload: {
        action: 'append_daily',
        content: `- [ ] 🔴 ${_extractTopTask(item)} *(carried from overdue)*`,
      },
    }),
  },
  {
    // SLA breach → nudge to check queue
    match: (item) => item.type === 'jira_ticket' && (item._override === 'sla_critical' || item.urgency === 'critical'),
    generate: (item) => ({
      type: 'nudge',
      confidence: 0.9,
      reason: 'Critical SLA risk detected. Sending yourself a queue reminder.',
      payload: {
        nudgeType: 'queue_urgent',
        message: `SLA risk: ${item.title}. Check the queue now.`,
      },
    }),
  },
  {
    // Escalation unseen → create a task to respond
    match: (item) => item.type === 'escalation',
    generate: (item) => ({
      type: 'create_task',
      confidence: 0.85,
      reason: 'Unseen escalations need a response. Creating a task to track this.',
      payload: {
        text: `Review escalation${item.meta?.count > 1 ? 's' : ''}: ${item.title}`,
        priority: 'high',
      },
    }),
  },
  {
    // Meeting imminent → add prep note to daily
    match: (item) => item.type === 'meeting' && item.meta?.minutesAway != null && item.meta.minutesAway <= 15,
    generate: (item) => ({
      type: 'update_vault',
      confidence: 0.7,
      reason: `Meeting "${item.title}" starts soon. Adding a prep section to your daily note.`,
      payload: {
        action: 'append_daily',
        content: `\n### Meeting Prep: ${item.title}\n- [ ] Review agenda\n- [ ] Check attendee notes\n`,
      },
    }),
  },
  {
    // Standup not done (late) → nudge
    match: (item) => item.type === 'nudge' && item.meta?.type === 'standup' && (item.meta?.nagCount || 0) >= 3,
    generate: (item) => ({
      type: 'nudge',
      confidence: 0.75,
      reason: 'Standup has been pending a while. Quick nudge to get it done.',
      payload: {
        nudgeType: 'standup_reminder',
        message: 'Your standup is still pending. 2 minutes — just do it.',
      },
    }),
  },
  {
    // Urgent emails → create task to respond
    match: (item) => item.type === 'email' && item.meta?.count > 0,
    generate: (item) => ({
      type: 'create_task',
      confidence: 0.65,
      reason: `${item.meta.count} urgent email${item.meta.count > 1 ? 's' : ''} flagged. Creating a task to handle them.`,
      payload: {
        text: `Handle urgent inbox: ${item.title}`,
        priority: 'high',
      },
    }),
  },
];


/**
 * Generate suggestions from Focus shortlist items.
 * Returns max 2 highest-confidence suggestions.
 * Deduplicates against recent pending actions.
 *
 * @param {Array} focusItems - Decision engine output items
 * @returns {Array} Action suggestions (max 2)
 */
function generateSuggestions(focusItems) {
  if (SARA_MODE === 'off') return [];
  if (!focusItems || focusItems.length === 0) return [];

  const suggestions = [];
  const pendingActions = db.getPendingSaraActions();
  const pendingTypes = new Set(pendingActions.map(a => `${a.type}:${a.focus_item_id}`));

  for (const item of focusItems) {
    for (const rule of SUGGESTION_RULES) {
      if (!rule.match(item)) continue;

      const suggestion = rule.generate(item);
      if (!suggestion) continue;

      // Deduplicate: don't suggest if similar action is already pending
      const dedupeKey = `${suggestion.type}:${item.id}`;
      if (pendingTypes.has(dedupeKey)) continue;

      suggestions.push({
        ...suggestion,
        focusItemId: item.id,
        focusItemTitle: item.title,
        autoExecutable: false,
      });

      break; // One suggestion per focus item
    }
  }

  // Return top 2 by confidence
  suggestions.sort((a, b) => b.confidence - a.confidence);
  return suggestions.slice(0, 2);
}

/**
 * Persist suggestions to the database.
 * Returns the created action objects with IDs.
 */
function persistSuggestions(suggestions) {
  const created = [];
  for (const s of suggestions) {
    const id = db.createSaraAction(s.type, s.payload, s.confidence, s.reason, s.focusItemId);
    created.push({ ...s, id, status: 'pending' });
  }
  return created;
}

/**
 * Execute an approved action.
 * @param {object} action - Action from sara_actions table
 * @returns {{ ok: boolean, detail: string }}
 */
function executeAction(action) {
  const payload = action.payload;

  switch (action.type) {
    case 'create_task': {
      const obsidian = require('./obsidian');
      const text = payload.text || 'Untitled task';
      obsidian.addTodoFromChat(text);
      return { ok: true, detail: `Task created: ${text}` };
    }

    case 'update_vault': {
      const obsidian = require('./obsidian');
      if (payload.action === 'append_daily') {
        obsidian.appendToDailyNote(payload.content || '');
        return { ok: true, detail: 'Appended to daily note' };
      }
      return { ok: false, detail: `Unknown vault action: ${payload.action}` };
    }

    case 'nudge': {
      const nudges = require('./nudges');
      const dateKey = new Date().toISOString().split('T')[0];
      db.createNudge(payload.nudgeType || 'sara', payload.message || 'SARA reminder', dateKey);
      nudges.broadcast({ type: 'nudge', nudge_type: payload.nudgeType || 'sara', message: payload.message, nag_count: 0 });
      return { ok: true, detail: `Nudge sent: ${payload.message}` };
    }

    case 'draft_message': {
      // Placeholder — log intent but don't send
      return { ok: true, detail: `Draft prepared: ${payload.subject || 'message'}` };
    }

    default:
      return { ok: false, detail: `Unknown action type: ${action.type}` };
  }
}

/**
 * Log an executed action to activity log and daily note.
 */
function logActionExecution(action, result) {
  // Activity log
  try {
    db.logActivity('sara_action', {
      actionId: action.id,
      type: action.type,
      status: result.ok ? 'executed' : 'failed',
      detail: result.detail,
    });
  } catch {}

  // Append to daily note
  if (result.ok) {
    try {
      const obsidian = require('./obsidian');
      const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const line = `- ${time} — ${action.type}: ${result.detail}`;

      const daily = obsidian.readTodayDailyNote() || '';
      if (daily.includes('## SARA Actions')) {
        obsidian.appendToDailyNote(line + '\n');
      } else {
        obsidian.appendToDailyNote(`\n\n## SARA Actions\n${line}\n`);
      }
    } catch {}
  }
}

function _extractTopTask(item) {
  // Extract task text from the collapsed summary reason
  const reasonMatch = (item.reason || '').match(/Top:\s*(.+)/);
  if (reasonMatch) return reasonMatch[1].substring(0, 80);
  return item.title.substring(0, 80);
}

module.exports = {
  generateSuggestions,
  persistSuggestions,
  executeAction,
  logActionExecution,
};
