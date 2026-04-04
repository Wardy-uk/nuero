'use strict';

/**
 * Working Memory — persistent context cache with TTL.
 *
 * Instead of rebuilding the full context snapshot from scratch on every
 * chat message / focus request, this service maintains a cached snapshot
 * that refreshes on a 10-minute TTL or on explicit invalidation.
 *
 * This is Phase 1 working memory — simple, explicit, no AI.
 */

const db = require('../db/database');

const TTL_MS = 10 * 60 * 1000; // 10 minutes

let _cache = null;
let _lastRefresh = 0;
let _refreshing = false;

/**
 * Get the current working context, refreshing if stale.
 * Returns a plain object with queue, todos, plan, calendar, nudges, patterns.
 */
async function getContext() {
  const now = Date.now();
  if (_cache && (now - _lastRefresh) < TTL_MS) {
    return _cache;
  }
  return refresh();
}

/**
 * Force a full refresh of the working context.
 */
async function refresh() {
  if (_refreshing) {
    // Avoid concurrent refreshes — return stale cache or empty
    return _cache || _buildEmpty();
  }

  _refreshing = true;
  try {
    const obsidian = require('./obsidian');

    const now = new Date();
    const dateKey = now.toISOString().split('T')[0];
    const hour = now.getHours();
    const day = now.getDay();
    const isWeekend = day === 0 || day === 6;
    const isWorkHours = !isWeekend && hour >= 8 && hour <= 18;

    // Queue summary (fast — reads from SQLite cache)
    let queueSummary = null;
    try { queueSummary = db.getQueueSummary(); } catch {}

    // Vault todos (parses Master Todo + Microsoft Tasks + Daily notes)
    let todos = null;
    try { todos = obsidian.parseVaultTodos(); } catch {}

    // 90-day plan
    let ninetyDayPlan = null;
    try { ninetyDayPlan = obsidian.parseNinetyDayPlan(); } catch {}

    // Today's calendar (from DB cache)
    let calendar = [];
    try {
      const todayStr = dateKey;
      const tomorrowStr = new Date(now.getTime() + 86400000).toISOString().split('T')[0];
      calendar = db.getCalendarEvents(todayStr, tomorrowStr);
    } catch {}

    // Active nudges
    let nudges = [];
    try { nudges = db.getActiveNudges(); } catch {}

    // Today's activity (for pattern awareness)
    let todayActivity = [];
    try { todayActivity = db.getActivityForDate(dateKey); } catch {}

    // Daily note existence
    let dailyNote = null;
    try { dailyNote = obsidian.readTodayDailyNote(); } catch {}

    // Escalation count
    let unseenEscalations = 0;
    try {
      const jira = require('./jira');
      unseenEscalations = jira.getUnseenEscalationCount ? jira.getUnseenEscalationCount() : 0;
    } catch {}

    // Pending imports count
    let pendingImports = 0;
    try {
      const imports = require('./imports');
      const pending = imports.getPending();
      pendingImports = pending.length;
    } catch {}

    _cache = {
      refreshedAt: Date.now(),
      dateKey,
      timeContext: { hour, day, isWeekend, isWorkHours },
      queueSummary,
      todos,
      ninetyDayPlan,
      calendar,
      nudges,
      todayActivity,
      dailyNote: dailyNote ? true : false, // boolean only — the full note is too large to cache
      unseenEscalations,
      pendingImports,
      userActiveToday: todayActivity.length > 0,
      standupDone: todayActivity.some(a => a.event_type === 'standup_done'),
      eodDone: todayActivity.some(a => a.event_type === 'eod_done'),
    };

    _lastRefresh = Date.now();
    console.log('[WorkingMemory] Context refreshed');
    return _cache;
  } catch (e) {
    console.error('[WorkingMemory] Refresh failed:', e.message);
    return _cache || _buildEmpty();
  } finally {
    _refreshing = false;
  }
}

/**
 * Invalidate the cache — next getContext() call will force a refresh.
 * Call this when something significant changes (vault write, queue sync, etc.)
 */
function invalidate(reason) {
  _lastRefresh = 0;
  if (reason) {
    console.log(`[WorkingMemory] Invalidated: ${reason}`);
  }
}

/**
 * Get the cache age in milliseconds, or null if no cache exists.
 */
function getCacheAge() {
  if (!_cache) return null;
  return Date.now() - _lastRefresh;
}

function _buildEmpty() {
  return {
    refreshedAt: 0,
    dateKey: new Date().toISOString().split('T')[0],
    timeContext: { hour: new Date().getHours(), day: new Date().getDay(), isWeekend: false, isWorkHours: false },
    queueSummary: null,
    todos: null,
    ninetyDayPlan: null,
    calendar: [],
    nudges: [],
    todayActivity: [],
    dailyNote: false,
    unseenEscalations: 0,
    pendingImports: 0,
    userActiveToday: false,
    standupDone: false,
    eodDone: false,
  };
}

module.exports = {
  getContext,
  refresh,
  invalidate,
  getCacheAge,
};
