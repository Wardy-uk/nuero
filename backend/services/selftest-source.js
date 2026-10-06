'use strict';

/**
 * NEURO self-test — a canary SOURCE that exists so self-healing can be proven
 * end to end in production without breaking a real sense (Build 15L).
 *
 * It is a pull source like the calendar: every run publishes started +
 * succeeded through the same `beginSourceRun` handle, so SourceHealth, source
 * blindness and investigations treat it exactly as they treat a real one. It
 * reads nothing and writes nothing outside the event spine.
 *
 * ── The fault ───────────────────────────────────────────────────────────────
 * `agent_state.selftest_fault` = { failuresRemaining, reason } makes the next
 * N runs FAIL with that reason, then it heals by itself. It is set ONLY by
 * `backend/scripts/selftest-outage.js` from a shell on the Pi — there is no
 * route, because a route that fakes an outage is a way for a machine client
 * to make NEURO act. The canary is `low` importance, so its findings can never
 * interrupt Nick (the source-blind attention rule refuses low severity).
 */

const db = require('../db/database');

const SOURCE_ID = 'neuro.selftest';
const EXPECTED_INTERVAL_MS = 60 * 60 * 1000;
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;
const FAULT_KEY = 'selftest_fault';
const MAX_FAILURES = 10;

function _fault() {
  try {
    const raw = db.getState(FAULT_KEY);
    if (!raw) return null;
    const f = JSON.parse(raw);
    return f && Number.isInteger(f.failuresRemaining) && f.failuresRemaining > 0 ? f : null;
  } catch { return null; }
}

/** Arm the fault (script only). Bounded so a typo cannot fail it for ever. */
function armFault({ failures = 3, reason = 'simulated upstream outage: HTTP 503' } = {}) {
  const n = Math.max(1, Math.min(MAX_FAILURES, Number(failures) || 3));
  db.setState(FAULT_KEY, JSON.stringify({ failuresRemaining: n, reason: String(reason).slice(0, 200), armedAt: new Date().toISOString() }));
  return { failuresRemaining: n };
}

function clearFault() { db.setState(FAULT_KEY, ''); }

/** One run. Never throws — a failure is published as one, exactly like a real source. */
async function sync() {
  const run = require('./source-health').beginSourceRun(SOURCE_ID, {
    system: 'neuro', expectedIntervalMs: EXPECTED_INTERVAL_MS, staleAfterMs: STALE_AFTER_MS,
  });
  const f = _fault();
  if (f) {
    const left = f.failuresRemaining - 1;
    db.setState(FAULT_KEY, left > 0 ? JSON.stringify({ ...f, failuresRemaining: left }) : '');
    run.fail(f.reason, { reason: 'selftest-fault' });
    return { ok: false, error: f.reason, failuresRemaining: left };
  }
  run.succeed({ canary: true });
  return { ok: true };
}

module.exports = { SOURCE_ID, EXPECTED_INTERVAL_MS, STALE_AFTER_MS, FAULT_KEY, sync, armFault, clearFault };
