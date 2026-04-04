'use strict';

/**
 * Task Scoring — deterministic relevance scoring for vault tasks.
 *
 * Produces a score for each task that accounts for:
 *   - Priority (high/normal/low from vault sections)
 *   - Overdue severity (recently overdue > ancient overdue)
 *   - Strategic connection (90-day plan > vault > MS)
 *   - Freshness (recently created/touched > stale)
 *   - Source quality (Master Now > Master Soon > MS Planner backlog)
 *
 * Ancient stale MS Planner items sink. Recent plan-connected tasks rise.
 * The result is a sorted list suitable for Focus drill-downs.
 */

/**
 * Score a single task item (as returned by /api/todos).
 * Returns a number 0-100 where higher = more pressing.
 *
 * @param {object} task - { text, priority, due_date, source, done, planDay, ms_id }
 * @param {string} todayStr - YYYY-MM-DD
 * @returns {number}
 */
function scoreTask(task, todayStr) {
  let score = 0;
  const source = (task.source || '').toLowerCase();
  const priority = task.priority || 'normal';
  const dueStr = task.due_date ? task.due_date.split('T')[0] : null;

  // ── 1. Priority base (0-25) ──
  if (priority === 'high') score += 25;
  else if (priority === 'normal') score += 12;
  else score += 4;

  // ── 2. Source quality (0-20) ──
  if (source.includes('90-day plan')) score += 20;
  else if (source.includes('master') && source.includes('now')) score += 18;
  else if (source.includes('daily') && source.includes('focus')) score += 16;
  else if (source.includes('master') && source.includes('soon')) score += 12;
  else if (source.includes('daily')) score += 10;
  else if (source.includes('master') && source.includes('inbox')) score += 8;
  else if (source.includes('master')) score += 8;
  else if (source.includes('ms planner')) score += 5;
  else if (source.includes('ms todo')) score += 5;
  else score += 6;

  // ── 3. Overdue recency (0-30) ──
  // Recently overdue tasks are urgent. Ancient overdue tasks are stale.
  if (dueStr && dueStr < todayStr) {
    const daysOverdue = _daysBetween(dueStr, todayStr);

    if (daysOverdue <= 1) score += 30;       // overdue yesterday = very urgent
    else if (daysOverdue <= 3) score += 26;   // 2-3 days
    else if (daysOverdue <= 7) score += 20;   // within a week
    else if (daysOverdue <= 14) score += 14;  // 1-2 weeks
    else if (daysOverdue <= 30) score += 8;   // 2-4 weeks
    else if (daysOverdue <= 90) score += 4;   // 1-3 months — stale
    else score += 1;                           // ancient — nearly buried
  } else if (dueStr && dueStr === todayStr) {
    score += 28; // due today is almost as urgent as recently overdue
  } else if (dueStr) {
    // future due date — slight bump
    const daysUntil = _daysBetween(todayStr, dueStr);
    if (daysUntil <= 1) score += 22;
    else if (daysUntil <= 3) score += 15;
    else if (daysUntil <= 7) score += 8;
    else score += 2;
  }
  // No due date = no urgency bonus (score += 0)

  // ── 4. Staleness penalty for MS tasks ──
  // MS Planner/ToDo items that are very old and normal priority get actively penalised
  if ((source.includes('ms planner') || source.includes('ms todo')) && dueStr) {
    const daysOverdue = dueStr < todayStr ? _daysBetween(dueStr, todayStr) : 0;
    if (daysOverdue > 90 && priority !== 'high') {
      score -= 15; // heavily penalise ancient MS backlog
    } else if (daysOverdue > 30 && priority !== 'high') {
      score -= 8;
    }
  }

  // ── 5. Plan day proximity bonus (for 90-day plan tasks) ──
  if (task.planDay != null) {
    // Tasks near the current plan day are more relevant
    // planDay is set by the todos route; current day info is in the plan
    score += 5; // base bonus for being a plan task (already handled in source)
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Score and rank an array of task items.
 * Returns the same items with `_score` and `_scoreReason` fields added,
 * sorted by score descending.
 */
function rankTasks(tasks, todayStr) {
  if (!todayStr) todayStr = new Date().toISOString().split('T')[0];

  return tasks.map(task => {
    const _score = scoreTask(task, todayStr);
    const _scoreReason = _explainScore(task, _score, todayStr);
    return { ...task, _score, _scoreReason };
  }).sort((a, b) => b._score - a._score);
}

/**
 * Generate a short human-readable reason for why this task is ranked where it is.
 */
function _explainScore(task, score, todayStr) {
  const parts = [];
  const source = (task.source || '').toLowerCase();
  const dueStr = task.due_date ? task.due_date.split('T')[0] : null;

  if (source.includes('90-day plan')) parts.push('90-day plan');
  else if (source.includes('master') && source.includes('now')) parts.push('Now priority');
  else if (source.includes('daily') && source.includes('focus')) parts.push('Daily focus');

  if (task.priority === 'high') parts.push('high priority');

  if (dueStr) {
    if (dueStr === todayStr) {
      parts.push('due today');
    } else if (dueStr < todayStr) {
      const days = _daysBetween(dueStr, todayStr);
      if (days <= 7) parts.push(`${days}d overdue`);
      else if (days <= 30) parts.push(`${Math.round(days / 7)}w overdue`);
      else parts.push(`${Math.round(days / 30)}mo overdue`);
    }
  }

  if (score < 20) parts.push('stale backlog');

  return parts.join(' · ') || 'normal';
}

function _daysBetween(dateStr1, dateStr2) {
  const d1 = new Date(dateStr1 + 'T00:00:00');
  const d2 = new Date(dateStr2 + 'T00:00:00');
  return Math.round(Math.abs(d2 - d1) / (1000 * 60 * 60 * 24));
}

module.exports = { scoreTask, rankTasks };
