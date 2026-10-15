'use strict';

/**
 * The SOAP report — the Monday debrief for Ricky and Chris (services/soap-report.js).
 *
 * Nothing here sends. Queue send PREPARES a governed `send_soap_report`, which
 * Nick approves in Actions with his approval code; the executor sends it at
 * Monday 08:00 only if Monday's full-week verdicts still match.
 */

const express = require('express');
const soap = require('../services/soap-report');

const router = express.Router();
const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = new Set(['provisional', 'final']);

function _sendFor(weekFrom) {
  try { return require('../services/prepared-actions').soapReportFor(weekFrom); } catch { return null; }
}

// GET /api/soap — the newest SOAP report (final, else provisional), the weeks held, whether Nick is off on Monday, the recipients and the send.
router.get('/', (req, res) => {
  try {
    const latest = soap.latest();
    const v = latest ? soap.view(latest.from, latest.kind) : null;
    const { recipients, problems } = soap.resolveRecipients();
    let offMonday = null;
    try { offMonday = soap.offOnMonday(new Date()); } catch (e) { offMonday = { off: false, known: false, detail: e.message }; }
    res.json({ ok: true, current: v, weeks: soap.list(), offMonday, recipients, recipientProblems: problems, send: latest ? _sendFor(latest.from) : null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/soap/build — build (or rebuild) the SOAP report now. Body: { kind: 'provisional' (this week so far) | 'final' (last full week) }.
router.post('/build', async (req, res) => {
  const { kind } = req.body || {};
  if (!KINDS.has(kind)) return res.status(400).json({ ok: false, error: 'kind must be provisional or final' });
  try {
    const report = await soap.build({ kind });
    res.json({ ok: true, view: soap.view(report.from, kind) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/soap/:weekFrom/:kind — one SOAP report with Nick's words, its markdown and what still blocks sending.
router.get('/:weekFrom/:kind', (req, res) => {
  const { weekFrom, kind } = req.params;
  if (!WEEK_RE.test(weekFrom) || !KINDS.has(kind)) return res.status(400).json({ ok: false, error: 'expected /YYYY-MM-DD/provisional|final' });
  const v = soap.view(weekFrom, kind);
  if (!v) return res.status(404).json({ ok: false, error: 'no report for that week' });
  res.json({ ok: true, view: v, send: _sendFor(weekFrom) });
});

// POST /api/soap/:weekFrom/manual — save Nick's words on a SOAP report: what he will do about each red, why a carried red is still red and its consequences, commentary on the weakest agent, notes. Omitted fields are left alone.
router.post('/:weekFrom/manual', (req, res) => {
  const { weekFrom } = req.params;
  if (!WEEK_RE.test(weekFrom)) return res.status(400).json({ ok: false, error: 'weekFrom must be YYYY-MM-DD' });
  const { reds, carried, weakest, notes } = req.body || {};
  try {
    const manual = soap.setManual(weekFrom, { reds, carried, weakest, notes });
    res.json({ ok: true, manual });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// POST /api/soap/:weekFrom/queue-send — prepare the provisional SOAP report as a governed email to Ricky and Chris for Monday 08:00. Sends nothing; approve it in Actions.
router.post('/:weekFrom/queue-send', (req, res) => {
  const { weekFrom } = req.params;
  if (!WEEK_RE.test(weekFrom)) return res.status(400).json({ ok: false, error: 'weekFrom must be YYYY-MM-DD' });
  const r = soap.queueSend(weekFrom);
  if (!r.ok) return res.status(r.code || 409).json(r);
  res.json(r);
});

module.exports = router;
