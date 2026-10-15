'use strict';

/**
 * NEURO → VANTAGE, read-only, over VANTAGE's own HTTP API (15 Oct 2026).
 *
 * The SOAP report reads the Support Improvement Plan from VANTAGE rather than
 * re-parsing `SIP - Action Register.md` here: VANTAGE owns that parse (statuses,
 * Planner matching, drift), and a second copy in NEURO is two answers about one
 * plan. It is a GET with the same single credential the remote MCP gateway uses
 * (`X-Vantage-Pin`). It writes nothing, so it is not one of the five
 * VANTAGE → NEURO writes and does not touch that register.
 *
 * ⚠ An unconfigured client REFUSES before the network and says so — "never
 * told where VANTAGE is" and "VANTAGE is down" need different fixes.
 */

const TIMEOUT_MS = 15000;

function config() {
  return {
    url: String(process.env.VANTAGE_API_URL || '').replace(/\/$/, ''),
    pin: process.env.VANTAGE_PIN || '',
  };
}

function isConfigured() {
  const c = config();
  return Boolean(c.url && c.pin);
}

/** GET a VANTAGE route. Resolves to its `data`; throws with a reason otherwise. */
async function get(path, { timeoutMs = TIMEOUT_MS } = {}) {
  if (!isConfigured()) throw new Error('VANTAGE is not configured (VANTAGE_API_URL / VANTAGE_PIN)');
  const c = config();
  const res = await fetch(`${c.url}${path}`, {
    headers: { 'X-Vantage-Pin': c.pin, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload || payload.ok === false) {
    const err = new Error((payload && payload.error) || `VANTAGE GET ${path} failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return payload.data !== undefined ? payload.data : payload;
}

module.exports = { get, isConfigured, config };
