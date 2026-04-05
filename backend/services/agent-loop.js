'use strict';

/**
 * Agent Loop — Phase 6A
 *
 * Lightweight, deterministic background loop that:
 *   1. Evaluates current state via decision engine
 *   2. Runs safe auto-actions (no user approval needed)
 *   3. Prepares the next primary action for when the user looks at Focus
 *   4. Logs everything to activity_log + daily note
 *
 * Runs every 10 minutes during work hours (8am-6pm weekdays).
 * Does NOT use LLM — purely deterministic.
 *
 * This is NOT a chatbot or autonomous agent. It's a focused
 * background evaluator that pre-computes what the user should
 * do next and handles safe housekeeping automatically.
 */

const workingMemory = require('./working-memory');
const engine = require('./decision-engine');
const nextActionEngine = require('./next-action-engine');
const db = require('../db/database');

let _lastRun = null;
let _lastResult = null;
let _running = false;

/**
 * Run one agent loop cycle.
 * Returns { autoExecuted, primaryAction, secondaryAction, canWait, skipped }
 */
async function runCycle() {
  if (_running) {
    console.log('[AgentLoop] Already running, skipping');
    return { skipped: true };
  }

  _running = true;
  const t0 = Date.now();

  try {
    // Check if we should run (work hours, weekday unless overridden)
    if (!_shouldRun()) {
      return { skipped: true, reason: 'outside_hours' };
    }

    // 1. Get fresh context
    const ctx = await workingMemory.getContext();

    // 2. Run decision engine
    const result = await engine.evaluate({ showAll: false });

    // 3. Compute next actions (includes auto-execution of safe actions)
    const actions = nextActionEngine.computeNextActions(result.items, ctx);

    // 4. Log auto-executed actions
    if (actions.autoExecuted.length > 0) {
      console.log(`[AgentLoop] Auto-executed ${actions.autoExecuted.length} safe action(s): ${actions.autoExecuted.map(a => a.type).join(', ')}`);
    }

    // 5. Cache result for Focus endpoint to pick up
    _lastResult = {
      ...actions,
      mode: result.mode,
      tone: require('./ai-provider').getTone(ctx),
      items: result.items,
      totalCandidates: result.totalCandidates,
      suppressed: result.suppressed,
      tiers: result.tiers,
      computedAt: new Date().toISOString(),
    };
    _lastRun = Date.now();

    const elapsed = Date.now() - t0;
    console.log(`[AgentLoop] Cycle complete in ${elapsed}ms — primary: ${actions.primaryAction?.label || 'none'}, auto: ${actions.autoExecuted.length}, canWait: ${actions.canWait.length}`);

    return _lastResult;
  } catch (e) {
    console.error('[AgentLoop] Cycle failed:', e.message);
    return { skipped: true, error: e.message };
  } finally {
    _running = false;
  }
}

/**
 * Get the last computed result (used by Focus route for instant response).
 */
function getLastResult() {
  return _lastResult;
}

/**
 * Get time since last run in ms.
 */
function getLastRunAge() {
  return _lastRun ? Date.now() - _lastRun : null;
}

/**
 * Check if agent loop should run right now.
 * Runs 8am-6pm weekdays by default.
 */
function _shouldRun() {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();

  // Weekend check — but respect work override
  if (day === 0 || day === 6) {
    try {
      const override = db.getState('weekend_work_override');
      if (override !== 'true') return false;
    } catch {
      return false;
    }
  }

  // Work hours: 8am-6pm
  return hour >= 8 && hour < 18;
}

module.exports = {
  runCycle,
  getLastResult,
  getLastRunAge,
};
