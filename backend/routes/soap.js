'use strict';

/**
 * The SOAP report — the Monday debrief for Chris, Ricky and Liam (services/soap-report.js).
 *
 * The same controls as the Weekly Risk report: save, publish to vault, test send
 * to Nick, queue the send, record a send made by hand, reopen a sent week.
 * Nothing here sends to anyone else: Queue send PREPARES a governed
 * `send_soap_report`, approved in Actions with Nick's approval code; Test send is
 * self-only (email-sender refuses any other recipient).
 */

const express = require('express');
const soap = require('../services/soap-report');

const router = express.Router();
const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = new Set(['provisional', 'final']);

function _sendFor(weekFrom) {
  try { return require('../services/prepared-actions').soapReportFor(weekFrom); } catch { return null; }
}
const bad = (res, msg) => res.status(400).json({ ok: false, error: msg });

// GET /api/soap — the newest SOAP report (final, else provisional), the weeks held, the recipients and the send.
router.get('/', (req, res) => {
  try {
    const latest = soap.latest();
    const v = latest ? soap.view(latest.from, latest.kind) : null;
    const { recipients, problems } = soap.resolveRecipients();
    res.json({ ok: true, current: v, weeks: soap.list(), recipients, recipientProblems: problems, send: latest ? _sendFor(latest.from) : null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/soap/recipients — the SOAP distribution list: the People-note names, the address each resolves to, and any name that does not resolve.
router.get('/recipients', (req, res) => {
  const { recipients, problems } = soap.resolveRecipients();
  res.json({ ok: true, names: soap.recipientNames(), recipients, problems, max: require('../services/action-registry').policyFor('send_soap_report').maxRecipients });
});

// POST /api/soap/recipients — set the SOAP distribution list. Body: { names: ['Chris Middleton', ...] } — People-note names, never addresses. Nick only; refused to machine clients.
router.post('/recipients', (req, res) => {
  const { names } = req.body || {};
  try {
    soap.setRecipientNames(names);
    const { recipients, problems } = soap.resolveRecipients();
    res.json({ ok: true, names: soap.recipientNames(), recipients, problems });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// POST /api/soap/build — build (or rebuild) the SOAP report now. Body: { kind: 'provisional' (this week so far) | 'final' (last full week) }. Refused while the week is sent and frozen.
router.post('/build', async (req, res) => {
  const { kind } = req.body || {};
  if (!KINDS.has(kind)) return bad(res, 'kind must be provisional or final');
  try {
    const report = await soap.build({ kind });
    res.json({ ok: true, view: soap.view(report.from, kind) });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// GET /api/soap/:weekFrom/:kind — one SOAP report with Nick's words, its markdown (the sent words once sent), what still blocks sending, and its publish/sent state.
router.get('/:weekFrom/:kind', (req, res) => {
  const { weekFrom, kind } = req.params;
  if (!WEEK_RE.test(weekFrom) || !KINDS.has(kind)) return bad(res, 'expected /YYYY-MM-DD/provisional|final');
  const v = soap.view(weekFrom, kind);
  if (!v) return res.status(404).json({ ok: false, error: 'no report for that week' });
  res.json({ ok: true, view: v, send: _sendFor(weekFrom) });
});

// POST /api/soap/:weekFrom/manual — save Nick's words on a SOAP report: what he will do about each red, why a carried red is still red and its consequences, commentary on the weakest agent, notes. Omitted fields are left alone.
router.post('/:weekFrom/manual', (req, res) => {
  const { weekFrom } = req.params;
  if (!WEEK_RE.test(weekFrom)) return bad(res, 'weekFrom must be YYYY-MM-DD');
  const { reds, carried, weakest, notes } = req.body || {};
  if (soap.isLocked(weekFrom)) return res.status(409).json({ ok: false, error: 'that week was sent and is frozen — reopen it to change it' });
  try {
    const manual = soap.setManual(weekFrom, { reds, carried, weakest, notes });
    res.json({ ok: true, manual });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// POST /api/soap/:weekFrom/publish — write the SOAP report to the vault (Projects/SOAP Reports). Body: { kind }. Publishing is not sending.
router.post('/:weekFrom/publish', (req, res) => {
  const { weekFrom } = req.params;
  const { kind } = req.body || {};
  if (!WEEK_RE.test(weekFrom) || !KINDS.has(kind)) return bad(res, 'expected a week and kind provisional|final');
  const r = soap.publish(weekFrom, kind);
  if (!r.ok) return res.status(r.code || 409).json(r);
  res.json(r);
});

// POST /api/soap/:weekFrom/test-send — email Nick (and only Nick) a test copy of the SOAP report to see how it lands. Body: { kind }. Unfinished sections are listed in a banner.
router.post('/:weekFrom/test-send', async (req, res) => {
  const { weekFrom } = req.params;
  const { kind } = req.body || {};
  if (!WEEK_RE.test(weekFrom) || !KINDS.has(kind)) return bad(res, 'expected a week and kind provisional|final');
  try {
    const r = await soap.testSend(weekFrom, kind);
    if (!r.ok) return res.status(r.code || 502).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/soap/:weekFrom/queue-send — prepare the SOAP report as a governed email to Chris, Ricky and Liam. Body: { kind: 'provisional' (goes Monday 08:00 if the verdicts hold) | 'final' (goes on approval) }. Sends nothing; approve it in Actions.
router.post('/:weekFrom/queue-send', (req, res) => {
  const { weekFrom } = req.params;
  const { kind } = req.body || {};
  if (!WEEK_RE.test(weekFrom)) return bad(res, 'weekFrom must be YYYY-MM-DD');
  const r = soap.queueSend(weekFrom, { kind: KINDS.has(kind) ? kind : 'provisional' });
  if (!r.ok) return res.status(r.code || 409).json(r);
  res.json(r);
});

// POST /api/soap/:weekFrom/mark-sent — record a SOAP report Nick sent himself (from Outlook). Body: { kind, sentAt? }. Records only; sends nothing. Freezes the week.
router.post('/:weekFrom/mark-sent', (req, res) => {
  const { weekFrom } = req.params;
  const { kind, sentAt } = req.body || {};
  if (!WEEK_RE.test(weekFrom) || !KINDS.has(kind)) return bad(res, 'expected a week and kind provisional|final');
  const r = soap.markSentByHand(weekFrom, kind, { sentAt: sentAt || null });
  if (!r.ok) return res.status(r.code || 409).json(r);
  res.json(r);
});

// POST /api/soap/:weekFrom/reopen — unfreeze a sent SOAP week so it can be rebuilt and sent again. Keeps the record that it was sent.
router.post('/:weekFrom/reopen', (req, res) => {
  const { weekFrom } = req.params;
  if (!WEEK_RE.test(weekFrom)) return bad(res, 'weekFrom must be YYYY-MM-DD');
  const r = soap.reopen(weekFrom);
  if (!r.ok) return res.status(r.code || 409).json(r);
  res.json(r);
});

module.exports = router;
