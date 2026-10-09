'use strict';

/**
 * /api/finance — NEURO's finance domain over Tally's finance-intelligence-v1
 * contract (Build 26). Every figure is Tally's; NEURO adds operational meaning.
 *
 * Read-only towards Tally and towards money. Recurring, unusual and category
 * decisions moved to Tally in Build 26 and answer 410 here. The only finance
 * statements NEURO still takes are Nick's operational obligations, and the
 * authority matrix refuses machines on all of them. Literal paths first.
 */

const express = require('express');
const router = express.Router();

const fin = () => require('../services/finance');
const send = (res, out) => (out && out.ok === false ? res.status(out.status || 400).json(out) : res.json(out));
const fail = (res, e) => { console.error('[Finance]', e.message); res.status(500).json({ ok: false, error: e.message }); };
const hasBody = (req) => !!(req.body && typeof req.body === 'object');

// GET /api/finance — household finance from Tally: source health, position, forecast, pressure, major changes, upcoming money, what needs action, cross-domain links, obligations. Keywords: money, spending, bills, cashflow, finance, Tally.
router.get('/', (req, res) => {
  try { res.json(fin().read()); } catch (e) { fail(res, e); }
});

// GET /api/finance/monthly/:month — Tally's summary for one month (YYYY-MM): spending, money in and out, categories, coverage. Keywords: monthly spending.
router.get('/monthly/:month', (req, res) => {
  try {
    if (!/^\d{4}-\d{2}$/.test(req.params.month)) return res.status(400).json({ ok: false, error: 'month must be YYYY-MM' });
    const m = fin().monthly(req.params.month);
    if (!m) return res.status(404).json({ ok: false, error: 'no summary for that month' });
    res.json({ ok: true, summary: m });
  } catch (e) { fail(res, e); }
});

// GET /api/finance/reconnect — bank feed health per account, as Tally reports it. Keywords: TrueLayer, NatWest, reconnect.
router.get('/reconnect', (req, res) => {
  try { const r = fin().read(); res.json({ ok: true, health: r.health, lastRead: r.lastRead }); } catch (e) { fail(res, e); }
});

// POST /api/finance/sync — read Tally's finance contract now. Normally a scheduled job.
router.post('/sync', async (req, res) => {
  try { send(res, await fin().refresh()); } catch (e) { fail(res, e); }
});

// POST /api/finance/transactions/:txnId/decide — retired in Build 26: categories are set in Tally.
router.post('/transactions/:txnId/decide', (req, res) => send(res, fin().movedToTally('A transaction\'s category')));

// POST /api/finance/rules/:ruleId/retire — retired in Build 26: rules live in Tally.
router.post('/rules/:ruleId/retire', (req, res) => send(res, fin().movedToTally('A categorisation rule')));

// POST /api/finance/recurring/:seriesKey/decide — retired in Build 26: recurrence is decided in Tally.
router.post('/recurring/:seriesKey/decide', (req, res) => send(res, fin().movedToTally('Whether a payment recurs')));

// POST /api/finance/review/:itemKey/decide — retired in Build 26: unusual items are answered in Tally.
router.post('/review/:itemKey/decide', (req, res) => send(res, fin().movedToTally('An unusual-spend item')));

// POST /api/finance/obligations — Nick records a finance obligation (renewal, bill, annual fee). Body: kind, title, dueDate, expectedAmountPence, seriesKey, requiresDecision, scope, linkedTaskRef, linkedReminderRef.
router.post('/obligations', (req, res) => {
  try {
    if (!hasBody(req)) return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { kind, title, dueDate, expectedAmountPence, seriesKey, requiresDecision, scope, linkedTaskRef, linkedReminderRef } = req.body;
    send(res, fin().addObligation({ kind, title, dueDate, expectedAmountPence, seriesKey, requiresDecision, scope, linkedTaskRef, linkedReminderRef }));
  } catch (e) { fail(res, e); }
});

// POST /api/finance/obligations/:id/resolve — Nick resolves a finance obligation with evidence. Body: evidence (payment-seen|renewed|cancelled|statement), note. A ticked task is not evidence.
router.post('/obligations/:id/resolve', (req, res) => {
  try {
    if (!hasBody(req)) return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { evidence, note } = req.body;
    send(res, fin().resolveObligation(req.params.id, { evidence, note }));
  } catch (e) { fail(res, e); }
});

// POST /api/finance/obligations/:id — Nick changes a finance obligation or links its task/reminder. Body: title, dueDate, expectedAmountPence, requiresDecision, linkedTaskRef, linkedReminderRef, kind.
router.post('/obligations/:id', (req, res) => {
  try {
    if (!hasBody(req)) return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { title, dueDate, expectedAmountPence, requiresDecision, linkedTaskRef, linkedReminderRef, kind } = req.body;
    send(res, fin().updateObligation(req.params.id, { title, dueDate, expectedAmountPence, requiresDecision, linkedTaskRef, linkedReminderRef, kind }));
  } catch (e) { fail(res, e); }
});

module.exports = router;
