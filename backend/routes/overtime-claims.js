'use strict';

// Overtime claims from NOVA — Nick's half, behind the PIN (29 Oct 2026). See
// services/overtime-claims.js. Deciding, opt-outs and the payroll send are machine-refused
// in the authority matrix and refused in the MCP gateway: they are Nick's.

const express = require('express');
const ot = require('../services/overtime-claims');

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

// GET /api/overtime-claims/:id/check — live: the agent's Jira/NOVA activity in the window and the Working Time read.
router.get('/:id/check', wrap(async (req, res) => send(res, await ot.check(Number(req.params.id)))));

// POST /api/overtime-claims/:id/decide — approve or reject a claim (decision, note, overrideReason).
router.post('/:id/decide', wrap(async (req, res) => {
  const { decision, note, overrideReason } = req.body;
  send(res, await ot.decide(Number(req.params.id), { decision, note, overrideReason }));
}));

module.exports = router;
