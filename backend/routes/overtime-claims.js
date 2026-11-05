'use strict';

// Overtime claims from NOVA — Nick's half, behind the PIN (29 Oct 2026). See
// services/overtime-claims.js. Deciding, opt-outs and the payroll send are machine-refused
// in the authority matrix and refused in the MCP gateway: they are Nick's.

const express = require('express');
const ot = require('../services/overtime-claims');
const signoff = require('../services/overtime-signoff');

const router = express.Router();
const send = (res, r, body) => (r.ok ? res.json(body || r) : res.status(r.code || 400).json(r));
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
};

// GET /api/overtime-claims?status=&month= — overtime claims agents made in NOVA.
router.get('/', wrap(async (req, res) => {
  const { status, month } = req.query;
  send(res, await ot.claims({ status: status || undefined, month: month || undefined }));
}));

// GET /api/overtime-claims/agents — NOVA's active agents, to pick who a manual overtime line is for.
router.get('/agents', wrap(async (req, res) => send(res, await ot.agents())));

// POST /api/overtime-claims/manual — add a missed overtime line for an agent (agentEmail, date, start, end, reason, overrideReason); created approved in NOVA, goes in the next payroll file.
router.post('/manual', wrap(async (req, res) => {
  const { agentEmail, date, start, end, reason, overrideReason } = req.body;
  send(res, await ot.addManual({ agentEmail, date, start, end, reason, overrideReason }));
}));

// GET /api/overtime-claims/optouts — recorded 48-hour Working Time opt-outs.
router.get('/optouts', wrap(async (req, res) => send(res, await ot.optOuts())));

// POST /api/overtime-claims/optouts — record a signed 48-hour opt-out (agentEmail, agentName, optedOutOn, documentRef).
router.post('/optouts', wrap(async (req, res) => {
  const { agentEmail, agentName, optedOutOn, documentRef } = req.body;
  send(res, await ot.recordOptOut({ agentEmail, agentName, optedOutOn, documentRef }));
}));

// POST /api/overtime-claims/optouts/:id/withdraw — the agent withdrew their opt-out (withdrawnOn).
router.post('/optouts/:id/withdraw', wrap(async (req, res) => {
  const { withdrawnOn } = req.body;
  send(res, await ot.withdrawOptOut(Number(req.params.id), withdrawnOn));
}));

// GET /api/overtime-claims/payroll?month=YYYY-MM — the month's approved, unsent claims and past sends.
router.get('/payroll', wrap(async (req, res) => send(res, await ot.payrollMonth(String(req.query.month || '')))));

// GET /api/overtime-claims/payroll/file?month=YYYY-MM — download the payroll spreadsheet.
router.get('/payroll/file', wrap(async (req, res) => {
  const r = await ot.payrollFile(String(req.query.month || ''));
  if (!r.ok) return send(res, r);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${r.filename.replace(/"/g, '')}"`);
  res.end(r.buf);
}));

// POST /api/overtime-claims/payroll/prepare — prepare the email to payroll with the month's file (month); the screen sends it with one press.
router.post('/payroll/prepare', wrap(async (req, res) => {
  const { month } = req.body;
  send(res, await ot.preparePayroll(String(month || '')));
}));

// POST /api/overtime-claims/payroll/test-send — email Nick (and only Nick) a [TEST] copy of the month's payroll email with the file (month); payroll gets nothing and no claim is marked.
router.post('/payroll/test-send', wrap(async (req, res) => {
  const { month } = req.body;
  send(res, await ot.testPayroll(String(month || '')));
}));

// ── Chris's weekly sign-off and the cut-off (5 Nov 2026) — services/overtime-signoff.js ──

// GET /api/overtime-claims/signoff — overtime sign-off by Chris: the cut-off, the current payroll period, and the sign-off emails with his replies.
router.get('/signoff', wrap(async (req, res) => send(res, signoff.view())));

// POST /api/overtime-claims/signoff/cutoff — set the overtime cut-off day (day 1-28) and per-month overrides ({ 'YYYY-MM': 'YYYY-MM-DD' or null to clear }).
router.post('/signoff/cutoff', wrap(async (req, res) => {
  const { day, overrides } = req.body;
  send(res, signoff.setCutoff({ day, overrides }));
}));

// POST /api/overtime-claims/signoff/record — record that Chris signed off these claims outside email (claimIds, note: how he did it).
router.post('/signoff/record', wrap(async (req, res) => {
  const { claimIds, note } = req.body;
  send(res, signoff.recordByHand(claimIds, note));
}));

// POST /api/overtime-claims/signoff/:id/confirm — confirm what Chris's reply signed off (sign: claim ids, approveOwn, rejectOwn, rejectNote, hold, note).
router.post('/signoff/:id/confirm', wrap(async (req, res) => {
  const { sign, approveOwn, rejectOwn, rejectNote, hold, note } = req.body;
  const ids = (a) => (Array.isArray(a) ? a.map(Number) : []);
  send(res, await signoff.applyAnswer(Number(req.params.id), {
    sign: ids(sign), approveOwn: ids(approveOwn), rejectOwn: ids(rejectOwn), rejectNote, hold: hold === true, note, by: 'nick',
  }));
}));

// POST /api/overtime-claims/:id/manual-edit — correct an overtime line Nick added (agentEmail, date, start, end, reason, overrideReason); only before payroll has it; re-checked in NOVA.
router.post('/:id/manual-edit', wrap(async (req, res) => {
  const { agentEmail, date, start, end, reason, overrideReason } = req.body;
  send(res, await ot.editManual(Number(req.params.id), { agentEmail, date, start, end, reason, overrideReason }));
}));

// POST /api/overtime-claims/:id/manual-delete — delete an overtime line Nick added, before payroll has it.
router.post('/:id/manual-delete', wrap(async (req, res) => send(res, await ot.deleteManual(Number(req.params.id)))));

// GET /api/overtime-claims/:id/check — live: the agent's Jira/NOVA activity in the window and the Working Time read.
router.get('/:id/check', wrap(async (req, res) => send(res, await ot.check(Number(req.params.id)))));

// POST /api/overtime-claims/:id/decide — approve or reject a claim (decision, note, overrideReason).
router.post('/:id/decide', wrap(async (req, res) => {
  const { decision, note, overrideReason } = req.body;
  send(res, await ot.decide(Number(req.params.id), { decision, note, overrideReason }));
}));

module.exports = router;
