'use strict';

/**
 * Focus Route — GET /api/focus
 *
 * Returns a single, prioritised list of "what matters now" by merging:
 *   - Overdue vault todos
 *   - At-risk Jira tickets
 *   - Upcoming meetings (next 2 hours)
 *   - Pending imports needing review
 *   - Unseen escalations
 *   - Active nudges
 *
 * Uses simple weighted scoring — no AI.
 */

const express = require('express');
const router = express.Router();
const workingMemory = require('../services/working-memory');

// Score weights — higher = more urgent
const WEIGHTS = {
  escalation: 95,
  p1_ticket: 90,
  at_risk_ticket: 85,
  overdue_todo_plan: 80,     // 90-day plan task overdue
  meeting_imminent: 75,      // < 30 min
  active_nudge_standup: 70,
  overdue_todo_vault: 65,
  meeting_soon: 60,          // 30min – 2hr
  pending_import_review: 40,
  active_nudge_other: 35,
  due_today_todo: 30,
};

router.get('/', async (req, res) => {
  try {
    const ctx = await workingMemory.getContext();
    const items = [];
    const now = new Date();

    // 1. Unseen escalations — always highest priority
    if (ctx.queueSummary && ctx.queueSummary.tickets) {
      // At-risk tickets
      const atRisk = ctx.queueSummary.at_risk_tickets || [];
      for (const t of atRisk) {
        const isP1 = (t.priority || '').toLowerCase().includes('1') ||
                      (t.priority || '').toLowerCase().includes('critical') ||
                      (t.priority || '').toLowerCase().includes('highest');
        items.push({
          type: 'jira_ticket',
          id: `jira-${t.ticket_key}`,
          title: `${t.ticket_key}: ${t.summary}`,
          reason: isP1
            ? `P1 — ${Math.round(t.sla_remaining_minutes || 0)} min SLA remaining`
            : `At risk — ${Math.round(t.sla_remaining_minutes || 0)} min SLA remaining`,
          score: isP1 ? WEIGHTS.p1_ticket : WEIGHTS.at_risk_ticket,
          urgency: isP1 ? 'critical' : 'high',
          source: 'jira',
          actionHint: 'Check ticket status',
          meta: { key: t.ticket_key, assignee: t.assignee, priority: t.priority },
        });
      }
    }

    // Unseen escalation count (adds a single summary item if > 0)
    if (ctx.unseenEscalations > 0) {
      items.push({
        type: 'escalation',
        id: 'escalations-unseen',
        title: `${ctx.unseenEscalations} unseen escalation${ctx.unseenEscalations > 1 ? 's' : ''}`,
        reason: 'Escalations need your attention',
        score: WEIGHTS.escalation,
        urgency: 'critical',
        source: 'jira',
        actionHint: 'Open Queue → Escalations',
      });
    }

    // 2. Upcoming meetings (next 2 hours)
    if (ctx.calendar && ctx.calendar.length > 0) {
      const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      for (const event of ctx.calendar) {
        const start = new Date(event.start_time);
        if (start > now && start <= twoHoursFromNow && !event.is_all_day) {
          const minutesAway = Math.round((start - now) / 60000);
          const imminent = minutesAway <= 30;
          items.push({
            type: 'meeting',
            id: `cal-${event.event_id}`,
            title: event.subject,
            reason: minutesAway <= 5
              ? 'Starting now'
              : `In ${minutesAway} min`,
            score: imminent ? WEIGHTS.meeting_imminent : WEIGHTS.meeting_soon,
            urgency: imminent ? 'high' : 'medium',
            source: 'calendar',
            actionHint: imminent ? 'Prep now' : 'Coming up',
            meta: { start: event.start_time, end: event.end_time, location: event.location },
          });
        }
      }
    }

    // 3. Overdue todos from vault
    if (ctx.todos && ctx.todos.active) {
      const todayStr = ctx.dateKey;
      for (const todo of ctx.todos.active) {
        if (!todo.due_date) continue;
        const dueStr = todo.due_date.split('T')[0];
        const isPlanTask = (todo.source || '').toLowerCase().includes('plan') ||
                           (todo.source || '').toLowerCase().includes('90');

        if (dueStr < todayStr) {
          // Overdue
          items.push({
            type: 'todo',
            id: `todo-${todo.text.substring(0, 40)}`,
            title: todo.text,
            reason: `Overdue (due ${dueStr})`,
            score: isPlanTask ? WEIGHTS.overdue_todo_plan : WEIGHTS.overdue_todo_vault,
            urgency: isPlanTask ? 'high' : 'medium',
            source: todo.source || 'vault',
            actionHint: 'Complete or reschedule',
            meta: { dueDate: dueStr, source: todo.source },
          });
        } else if (dueStr === todayStr) {
          // Due today
          items.push({
            type: 'todo',
            id: `todo-${todo.text.substring(0, 40)}`,
            title: todo.text,
            reason: 'Due today',
            score: isPlanTask ? WEIGHTS.overdue_todo_plan - 5 : WEIGHTS.due_today_todo,
            urgency: isPlanTask ? 'medium' : 'low',
            source: todo.source || 'vault',
            actionHint: 'Do today',
            meta: { dueDate: dueStr, source: todo.source },
          });
        }
      }
    }

    // 4. Active nudges
    for (const nudge of ctx.nudges) {
      const isStandup = nudge.type === 'standup';
      items.push({
        type: 'nudge',
        id: `nudge-${nudge.id}`,
        title: isStandup ? 'Standup not done' : `${nudge.type} reminder`,
        reason: nudge.message,
        score: isStandup ? WEIGHTS.active_nudge_standup : WEIGHTS.active_nudge_other,
        urgency: (nudge.nag_count || 0) >= 3 ? 'high' : 'medium',
        source: 'neuro',
        actionHint: isStandup ? 'Open Standup' : `Complete ${nudge.type}`,
        meta: { nagCount: nudge.nag_count, type: nudge.type },
      });
    }

    // 5. Pending imports needing review
    if (ctx.pendingImports > 0) {
      items.push({
        type: 'imports',
        id: 'imports-pending',
        title: `${ctx.pendingImports} file${ctx.pendingImports > 1 ? 's' : ''} awaiting review`,
        reason: 'Unclassified imports in vault',
        score: WEIGHTS.pending_import_review,
        urgency: 'low',
        source: 'imports',
        actionHint: 'Review & route',
      });
    }

    // Sort by score descending, deduplicate by id
    const seen = new Set();
    const deduped = [];
    items.sort((a, b) => b.score - a.score);
    for (const item of items) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        deduped.push(item);
      }
    }

    res.json({
      generatedAt: new Date().toISOString(),
      cacheAge: workingMemory.getCacheAge(),
      context: {
        isWeekend: ctx.timeContext.isWeekend,
        isWorkHours: ctx.timeContext.isWorkHours,
        standupDone: ctx.standupDone,
        eodDone: ctx.eodDone,
        queueTotal: ctx.queueSummary?.total || 0,
        planProgress: ctx.ninetyDayPlan?.progress || null,
      },
      items: deduped,
    });
  } catch (e) {
    console.error('[Focus] Error:', e);
    res.status(500).json({ error: 'Failed to build focus', detail: e.message });
  }
});

module.exports = router;
