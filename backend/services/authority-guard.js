'use strict';

/**
 * The authority guard — authority-matrix.js, enforced (Build 14C).
 *
 * Mounted on `/api` immediately after authentication and BEFORE every router,
 * so a machine caller is judged by the matrix whatever the route's own code
 * remembers to check. The per-route `if (req.apiClient)` refusals stay: they
 * are the second lock, and they say a more specific sentence.
 *
 * ── Who is a machine ────────────────────────────────────────────────────────
 *   • the API token (server.js sets `req.apiClient`), or
 *   • a caller that DECLARES itself one with `X-Neuro-Machine-Client`.
 * The header can only ever REDUCE authority: anyone can send it, so it is
 * believed when it says "I am a machine" and ignored otherwise. The local MCP
 * server authenticates with the PIN (it runs on Nick's laptop for Claude Code),
 * which the backend cannot tell from Nick — it now declares itself.
 *
 * ⚠ It is NOT `X-Neuro-Client`: the phone apps send that (Build 2) to name
 * which app a sensor reading came from, and they are not machines.
 *
 * ── Refusals are logged ─────────────────────────────────────────────────────
 * Every refused machine request is recorded (activity `authority_refused`,
 * route + capability only — never the body), so an agent probing the edges is
 * visible rather than silent.
 */

const matrix = require('./authority-matrix');

const MACHINE_HEADER = 'x-neuro-machine-client';

function machineName(req) {
  if (req.apiClient) return String(req.apiClient);
  const declared = req.headers && req.headers[MACHINE_HEADER];
  if (declared && String(declared).trim()) return String(declared).trim().slice(0, 40);
  return null;
}

function _record(entry) {
  try {
    require('../db/database').logActivity('authority_refused', entry);
  } catch { /* a bookkeeping failure must not turn a refusal into an error */ }
  console.warn(`[authority] refused ${entry.machine} ${entry.method} ${entry.path} (${entry.capability || 'unmapped'}): ${entry.status}`);
}

function guard(req, res, next) {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  const machine = machineName(req);
  // A retired route answers 410 to EVERYONE — retiring it for machines alone
  // would leave the arbitrary-body forwarder one PIN away.
  const r = matrix.resolve(req.method, path);
  if (r.capability && matrix.CAPABILITIES[r.capability].machine === 'retired') {
    _record({ machine: machine || 'human', method: req.method, path, capability: r.capability, status: 410 });
    return res.status(410).json({ ok: false, retired: true, error: matrix.machineDecision(req.method, path).reason });
  }
  if (!machine) return next();
  // The machine's own identity is now known to every route, whichever way it
  // arrived, so the existing per-route checks also catch a declared machine.
  if (!req.apiClient) req.apiClient = machine;
  const d = matrix.machineDecision(req.method, path);
  if (d.allow) {
    req.authority = { capability: d.capability, mode: d.mode, machine };
    return next();
  }
  _record({ machine, method: req.method, path, capability: d.capability, status: d.status });
  return res.status(d.status).json({ ok: false, error: d.reason, capability: d.capability, authority: d.capability ? matrix.CAPABILITIES[d.capability].authority : null });
}

module.exports = { guard, machineName, MACHINE_HEADER };
