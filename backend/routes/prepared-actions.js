'use strict';

/**
 * Prepared actions — what NEURO has drafted for Nick to approve (Build 5E), the
 * one door through which an approved chase is SENT (Build 6), and since Build 7
 * the ONE queue for chases: risk-prepared and Chase-button drafts alike.
 *
 * ⚠ A4 APPROVAL NEEDS HUMAN PROOF (Build 7E). Holding NEURO's credentials is
 * not enough: an approval must carry a challenge this server issued for the
 * exact action/version/payload, plus Nick's approval code, which no client
 * stores and no route sets (services/approval-proof.js). The API token (n8n,
 * the remote MCP gateway) is refused outright; the PIN alone (the local MCP
 * server, any app) gets as far as the code prompt and no further.
 *
 * ⚠ Only a type the registry marks executable is sent (chase_commitment).
 * Approving anything else records the decision and sends nothing.
 */

const express = require('express');

const router = express.Router();
const pa = () => require('../services/prepared-actions');
const executor = () => require('../services/action-executor');
const proofs = () => require('../services/approval-proof');

const HUMAN_ONLY = 'Approving, editing or rejecting an A4 action needs Nick — a machine client cannot do it on his behalf.';

/** One queue, five views of it (7I). Pure: from the shaped actions. */
function buckets(actions) {
  const out = { needsApproval: [], approved: [], executing: [], needsReview: [], history: [] };
  for (const a of actions) {
    if (a.status === 'prepared') out.needsApproval.push(a.actionId);
    else if (a.status === 'approved') out.approved.push(a.actionId);
    else if (a.status === 'executing' || a.status === 'executed') out.executing.push(a.actionId);
    else if (a.status === 'execution_uncertain' || (a.status === 'failed' && a.retrySafe === true)) out.needsReview.push(a.actionId);
    else out.history.push(a.actionId);
  }
  return out;
}

// GET /api/prepared-actions — the action queue for chases and drafted emails (prepared action, chase draft, approval queue, needs approval, action history): each draft with its exact words, payloadHash, status, origin and approval provenance; buckets by stage; legacy (old-queue chases, unverified); sending and approvalCode status. ?status=&limit=50
router.get('/', (req, res) => {
  try {
    const status = pa().STATUSES.includes(req.query.status) ? req.query.status : null;
    const page = pa().list({ status, limit: req.query.limit });
    // ⚠ Live rows are ALWAYS included, whatever the page size (Build 9): the
    // buckets used to be computed over the newest 50 only, so an older draft
    // still awaiting approval could vanish from "Needs approval". The page
    // limit now bounds HISTORY, never what is waiting on Nick.
    const seen = new Set();
    const actions = [];
    for (const a of [...(status ? [] : pa().listLive()), ...page]) {
      if (!a || seen.has(a.actionId)) continue;
      seen.add(a.actionId);
      actions.push(a);
    }
    res.json({
      ok: true,
      executableTypes: require('../services/action-registry').executableTypes(),
      counts: pa().countsByStatus(),
      actions,
      buckets: buckets(actions),
      needsYou: pa().needsYou(),
      legacy: pa().legacyHistory(),
      sending: { enabled: require('../services/feature-flags').isEnabled('governed_execution'),
        calendar: require('../services/feature-flags').isEnabled('governed_calendar') },
      approvalCode: proofs().codeStatus(),
      approvalLock: proofs().lockStatus(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/prepared-actions/status — the execution ledger at a glance (action ledger, execution status, stuck actions, uncertain sends, verification): counts by status, anything stuck, anything failed or uncertain that needs review, attempts made, sends requested
router.get('/status', (req, res) => {
  try {
    res.json({ ok: true, ...executor().status() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/prepared-actions/:id — one prepared action with its evidence, exact draft, payloadHash, approval and its provenance, decision history, execution attempts and Sent Items verifications
// POST /api/prepared-actions/approval-code — set Nick's approval code from Settings: the first time with no proof, afterwards only with the current code (wrong-code lockout applies). A forgotten code is reset on the Pi. Refuses machine clients. Keywords: set approval code, change approval code. Body: { newCode, currentCode }
router.post('/approval-code', (req, res) => {
  if (req.apiClient) return res.status(403).json({ ok: false, error: HUMAN_ONLY });
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { newCode, currentCode } = req.body;
    const r = proofs().setCodeFromScreen({ newCode: typeof newCode === 'string' ? newCode : '', currentCode: typeof currentCode === 'string' ? currentCode : null });
    if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/prepared-actions/trust-device — RETIRED 9 Oct 2026 (410). A trusted browser is no longer an approval proof: what Nick starts sends on his click (a one-use intent grant), what NEURO drafts needs the approval code.
router.post('/trust-device', (req, res) => res.status(410).json({ ok: false, retired: true,
  error: 'Retired: browsers are no longer trusted to send. What you start sends on your click; what NEURO drafted needs your approval code.' }));

// GET /api/prepared-actions/devices — LEGACY: browsers that were trusted before 9 Oct 2026, kept readable for audit. None of them can approve anything any more.
router.get('/devices', (req, res) => {
  try {
    const token = req.get('X-NEURO-SEND-DEVICE');
    res.json({ ok: true, devices: proofs().listDevices(), thisDevice: token ? proofs().deviceStatus(token) : { trusted: false } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/prepared-actions/devices/:deviceId/revoke — stop a trusted browser sending. Keywords: revoke device, untrust browser.
router.post('/devices/:deviceId/revoke', (req, res) => {
  if (req.apiClient) return res.status(403).json({ ok: false, error: HUMAN_ONLY });
  try {
    const r = proofs().revokeDevice(req.params.deviceId);
    if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/:id', (req, res) => {
  try {
    const a = pa().get(req.params.id);
    if (!a) return res.status(404).json({ ok: false, error: 'no such prepared action' });
    res.json({ ok: true, action: a, attempts: executor().attemptsFor(a.actionId), verifications: executor().verificationsFor(a.actionId) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/prepared-actions/:id/approval-challenge — step 1 of Nick approving a drafted action in NEURO: a single-use, five-minute challenge bound to this action's exact version and payload hash. Useless without Nick's approval code. Refuses machine clients, and refuses an executable type while sending is switched off.
router.post('/:id/approval-challenge', (req, res) => {
  if (req.apiClient) return res.status(403).json({ ok: false, error: HUMAN_ONLY });
  try {
    const a = pa().get(req.params.id);
    if (!a) return res.status(404).json({ ok: false, error: 'no such prepared action' });
    if (a.status !== 'prepared') return res.status(409).json({ ok: false, error: `it is ${a.status}; only a prepared action can be approved` });
    const reg = require('../services/action-registry');
    if (a.executes && !require('../services/feature-flags').isEnabled(reg.switchFor(a.actionType))) {
      return res.status(409).json({ ok: false, error: `"${reg.SWITCH_LABELS[reg.switchFor(a.actionType)]}" is switched off (Settings → Switches), so approving would change nothing. Turn it on first.` });
    }
    const r = proofs().issue({ actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, issuedTo: 'pin-session' });
    if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error });
    res.json({ ok: true, challengeId: r.challengeId, expiresAt: r.expiresAt, version: r.version, payloadHash: r.payloadHash });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/prepared-actions/:id/approve — step 2: Nick approves the EXACT draft he was shown, with the challenge from step 1 and his approval code. For chase_commitment this SENDS the email as Nick and then verifies it in Sent Items; other types record the approval only. Refuses machine clients; a PIN without the code cannot approve. Body: { payloadHash, challengeId, approvalCode, note? }
router.post('/:id/approve', async (req, res) => {
  if (req.apiClient) return res.status(403).json({ ok: false, error: HUMAN_ONLY, executed: false });
  try {
    const { payloadHash, challengeId, approvalCode, note } = req.body;
    // 9 Oct 2026: the X-NEURO-SEND-DEVICE header is ignored — a trusted browser
    // is no longer a proof. The code, or a grant via /execute-direct.
    const r = pa().approve(req.params.id, {
      payloadHash: typeof payloadHash === 'string' ? payloadHash : null,
      challengeId: typeof challengeId === 'string' ? challengeId : null,
      approvalCode: typeof approvalCode === 'string' ? approvalCode : null,
      approver: 'nick (approval code, signed in to NEURO)',
      note: typeof note === 'string' ? note.slice(0, 500) : null,
    });
    if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error, executed: false });
    if (!r.executable) {
      return res.json({ ok: true, already: !!r.already, executed: false, notice: r.notice, action: r.action });
    }
    // Event-triggered execution. Idempotent: a second approve, a double click
    // or the reconciler reaching it first all end at the same single claim.
    const x = await executor().execute(req.params.id);
    const action = pa().get(req.params.id);
    res.json({
      ok: true,
      already: !!r.already,
      executed: ['executed', 'verified', 'execution_uncertain'].includes(action.status),
      status: action.status,
      detail: x.detail || r.notice,
      notice: r.notice,
      action,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, executed: false });
  }
});

// POST /api/prepared-actions/:id/intent-grant — Nick-direct confirm, step 1: a one-use, 60-second intent grant for the exact action (id, version, payload hash) a NEURO screen is showing, minted when Nick presses the final button (Book, Move, Create). Only for actions a human button prepared; refuses machine clients (API token, MCP, X-Neuro-Machine-Client). Body: { version, payloadHash, surface, sessionId }
router.post('/:id/intent-grant', (req, res) => {
  if (req.apiClient) return res.status(403).json({ ok: false, error: HUMAN_ONLY });
  try {
    const grants = require('../services/intent-grants');
    const { version, payloadHash, surface, sessionId } = req.body || {};
    const r = grants.mint({ actionId: req.params.id, version, payloadHash, surface, sessionId, caller: grants.callerOf(req) });
    if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error, reason: r.reason, needsConfirm: r.reason === 'changed' });
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/prepared-actions/:id/execute-direct — Nick-direct confirm, step 2: spend the intent grant and make the change at once (no Actions card, no approval code), then verify it by read-back like any governed action. A spent, expired or mismatched grant is refused with needsConfirm. Refuses machine clients. Body: { grantId, payloadHash }
router.post('/:id/execute-direct', async (req, res) => {
  if (req.apiClient) return res.status(403).json({ ok: false, error: HUMAN_ONLY, executed: false });
  try {
    const { grantId, payloadHash } = req.body || {};
    const r = pa().approve(req.params.id, {
      payloadHash: typeof payloadHash === 'string' ? payloadHash : null,
      intentGrantId: typeof grantId === 'string' ? grantId : null,
      approver: 'nick (pressed it, signed in to NEURO)',
    });
    if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error, needsConfirm: !!r.needsConfirm, executed: false });
    // Same single-claim execution as an Actions approval: a double click or the
    // reconciler reaching it first all end at one attempt.
    const x = await executor().execute(req.params.id);
    const action = pa().get(req.params.id);
    res.json({
      ok: true,
      already: !!r.already,
      executed: ['executed', 'verified', 'execution_uncertain'].includes(action.status),
      status: action.status,
      detail: x.detail || null,
      action,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, executed: false });
  }
});

// POST /api/prepared-actions/:id/reject —Nick rejects a prepared action (reject draft); kept for audit with who rejected it, and NEURO will not prepare another for the same risk episode. Refuses machine clients. Body: { note? }
router.post('/:id/reject', (req, res) => {
  if (req.apiClient) return res.status(403).json({ ok: false, error: HUMAN_ONLY });
  try {
    const { note } = req.body;
    const r = pa().reject(req.params.id, { note: typeof note === 'string' ? note.slice(0, 500) : null, actor: 'nick (signed in to NEURO)' });
    if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error });
    res.json({ ok: true, already: !!r.already, action: r.action });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/prepared-actions/:id/edit — Nick edits a prepared draft's subject or body (edit draft, change wording, resend after a proven failure). Creates a NEW version that needs its own approval; the old one is superseded and never changed. The recipient cannot be edited. Refuses machine clients. Body: { payloadHash, subject?, body? }
router.post('/:id/edit', (req, res) => {
  if (req.apiClient) return res.status(403).json({ ok: false, error: HUMAN_ONLY });
  try {
    const { payloadHash, subject, body } = req.body;
    const r = pa().edit(req.params.id, {
      payloadHash: typeof payloadHash === 'string' ? payloadHash : null,
      subject: typeof subject === 'string' ? subject : undefined,
      body: typeof body === 'string' ? body : undefined,
      editor: 'nick (signed in to NEURO)',
    });
    if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error });
    res.json({ ok: true, action: r.action, supersedes: r.supersedes });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.buckets = buckets;
module.exports = router;
