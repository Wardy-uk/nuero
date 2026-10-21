'use strict';

/**
 * What SAiM may do (20 Oct 2026) — the human control for SAiM's authority
 * budget (services/authority-budget.js). EVERY route is human-only: machine
 * callers are refused here, by the authority matrix (saim.authority, machine:
 * refuse) and by the MCP gateway (interactive).
 *
 *   GET  /status          — the two gates, today's allowance, the active move,
 *                           past receipts, and whether everything is stopped.
 *   POST /grant/preview   — exactly what an allowance would let SAiM do, with a
 *                           one-use two-minute confirmation for those terms.
 *   POST /grant           — grant exactly what was shown (spends that token).
 *   POST /revoke          — take today's allowance away. Immediate.
 *   POST /stop            — stop every SAiM action now. Immediate.
 *   POST /resume/preview  — what resuming means, with its own confirmation.
 *   POST /resume          — resume (spends that token).
 *
 * ⚠ This never opens the device lock (SAIM_PREPARED_MOVE_EXECUTION on the Pi)
 * and changing that lock never creates an allowance. Both must be open.
 * ⚠ Not a generic settings door: a body carrying any field the route does not
 * name is REFUSED. Reducing authority (revoke, stop) needs no confirmation;
 * granting or resuming always does.
 */

const express = require('express');
const router = express.Router();

const budget = () => require('../services/authority-budget');
const HUMAN_ONLY = 'Only Nick, in SAiM, can change what SAiM is allowed to do — a machine client cannot.';
const TOKEN_RE = /^ac_[0-9a-f]{20}$/;

function strict(body, allowed) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  return extra.length ? `this takes only ${allowed.length ? allowed.join(', ') : 'nothing'} — refused: ${extra.join(', ')}` : null;
}
const machine = (req) => Boolean(req.apiClient) || Boolean(require('../services/intent-grants').callerOf(req).machine);
const send = (res, r) => (r.ok ? res.json(r) : res.status(r.code || 409).json({ ...r, code: undefined, error: r.why || r.error }));

// GET /api/saim-authority/status — what SAiM may do (human only, interactive): whether carrying out moves is switched on (SAiM is ready), today's allowance (up to three prepared moves, or none), what is left, the active prepared move, past receipts, and whether all SAiM actions are stopped. Refuses machine clients.
router.get('/status', (req, res) => {
  if (machine(req)) return res.status(403).json({ ok: false, error: HUMAN_ONLY });
  try { res.json(budget().status()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/saim-authority/grant/preview — allowance, step 1 (human only, interactive): show exactly what allowing SAiM one calendar block and one note for a day would permit, with a one-use two-minute confirmation for those terms. Grants nothing. Body: { day, blockMinutes }
router.post('/grant/preview', (req, res) => {
  if (machine(req)) return res.status(403).json({ ok: false, error: HUMAN_ONLY });
  const bad = strict(req.body, ['day', 'blockMinutes']);
  if (bad) return res.status(400).json({ ok: false, error: bad });
  const { day, blockMinutes } = req.body || {};
  try { send(res, budget().previewGrant({ ...(day == null ? {} : { day }), ...(blockMinutes == null ? {} : { blockMinutes }) })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/saim-authority/grant — allowance, step 2 (human only, interactive): grant exactly the allowance shown by grant/preview (spends its one-use confirmation). Never opens the device lock. Body: { confirmToken }
router.post('/grant', (req, res) => {
  if (machine(req)) return res.status(403).json({ ok: false, error: HUMAN_ONLY });
  const bad = strict(req.body, ['confirmToken']);
  if (bad) return res.status(400).json({ ok: false, error: bad });
  const { confirmToken } = req.body || {};
  if (typeof confirmToken !== 'string' || !TOKEN_RE.test(confirmToken)) return res.status(400).json({ ok: false, error: 'a confirmation from the preview is required' });
  try { send(res, budget().grant({ confirmToken })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/saim-authority/revoke — take today's allowance away (human only, interactive). Immediate. Body: none
router.post('/revoke', (req, res) => {
  if (machine(req)) return res.status(403).json({ ok: false, error: HUMAN_ONLY });
  const bad = strict(req.body, []);
  if (bad) return res.status(400).json({ ok: false, error: bad });
  try { send(res, budget().revoke({})); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/saim-authority/stop — stop all SAiM actions now, emergency stop (human only, interactive). Immediate; blocks every execution path, mid-action included. Body: none
router.post('/stop', (req, res) => {
  if (machine(req)) return res.status(403).json({ ok: false, error: HUMAN_ONLY });
  const bad = strict(req.body, []);
  if (bad) return res.status(400).json({ ok: false, error: bad });
  try { send(res, budget().stop({})); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/saim-authority/resume/preview — resume SAiM actions after a stop, step 1 (human only, interactive): what resuming means, with a one-use confirmation. Body: none
router.post('/resume/preview', (req, res) => {
  if (machine(req)) return res.status(403).json({ ok: false, error: HUMAN_ONLY });
  const bad = strict(req.body, []);
  if (bad) return res.status(400).json({ ok: false, error: bad });
  try { send(res, budget().previewResume({})); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/saim-authority/resume — resume SAiM actions after a stop, step 2 (human only, interactive). Body: { confirmToken }
router.post('/resume', (req, res) => {
  if (machine(req)) return res.status(403).json({ ok: false, error: HUMAN_ONLY });
  const bad = strict(req.body, ['confirmToken']);
  if (bad) return res.status(400).json({ ok: false, error: bad });
  const { confirmToken } = req.body || {};
  if (typeof confirmToken !== 'string' || !TOKEN_RE.test(confirmToken)) return res.status(400).json({ ok: false, error: 'a confirmation from the preview is required' });
  try { send(res, budget().resume({ confirmToken })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
