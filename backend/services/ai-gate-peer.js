'use strict';

/**
 * Do NEURO and VANTAGE write the SAME shared AI ledger? (23 Oct 2026)
 *
 * Two absolute paths in two .env files can still name two different files (a
 * typo, a different mount, another machine). The ledger mints its own id inside
 * the file, so the check is: VANTAGE's /api/ai-gate/profile reports its ledger
 * id, and it must equal NEURO's. A GET over the existing NEURO → VANTAGE read
 * path — no new write between the two systems.
 *
 * Result states: match / mismatch / unreachable / not-configured / unknown.
 * A mismatch is logged loudly and shown in Settings → AI budget. It does not
 * stop NEURO: the gate is in shadow, and VANTAGE being down or misconfigured must
 * not take NEURO down with it. The deploy-time check that DOES fail is
 * `backend/scripts/ai-gate-verify.js`.
 */

const gate = require('./ai-gate');
const vantage = require('./vantage-client');

let _last = { state: 'unknown', say: 'Not checked yet.', checkedAt: null };
let _timer = null;

async function check({ now = Date.now() } = {}) {
  const mine = gate.ledgerInfo();
  let out;
  if (!vantage.isConfigured()) {
    out = { state: 'not-configured', say: 'VANTAGE_API_URL / VANTAGE_PIN are not set, so VANTAGE’s ledger could not be compared.' };
  } else {
    try {
      const body = await vantage.get('/api/ai-gate/profile');
      out = gate.sameLedger(mine, body && body.ledger);
      out.theirs = body && body.ledger ? { id: body.ledger.id, path: body.ledger.path } : null;
    } catch (e) {
      out = { state: 'unreachable', say: `VANTAGE could not be asked (${e.message}).` };
    }
  }
  out.mine = mine ? { id: mine.id, path: mine.path } : null;
  out.checkedAt = new Date(now).toISOString();
  if (out.state === 'mismatch') console.error(`[ai-gate] ⚠ ${out.say}`);
  _last = out;
  return out;
}

function last() { return _last; }

function start() {
  if (_timer) return;
  setTimeout(() => { check().catch(() => {}); }, 45_000).unref();
  _timer = setInterval(() => { check().catch(() => {}); }, 60 * 60 * 1000);
  _timer.unref();
}

module.exports = { check, last, start };
