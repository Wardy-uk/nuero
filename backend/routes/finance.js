'use strict';

/**
 * Build 23 — /api/finance: the household Finance domain over Tally.
 *
 * Read-only towards Tally and towards money: nothing here pays, moves,
 * cancels or edits anything. Every write is a statement Nick makes about how
 * NEURO should read his finances, and the authority matrix refuses machines on
 * all of them. Literal paths are registered before parameterised ones.
 */

const express = require('express');
const router = express.Router();

const fin = () => require('../services/finance');
const send = (res, out) => (out && out.ok === false ? res.status(out.status || 400).json(out) : res.json(out));
const fail = (res, e) => { console.error('[Finance]', e.message); res.status(500).json({ ok: false, error: e.message }); };
const hasBody = (req) => !!(req.body && typeof req.body === 'object');

// GET /api/finance — household finance: bank-feed health, coverage, monthly summaries, recurring payments, upcoming money out, unusual items, category quality, obligations. Keywords: money, spending, bills, budget, finance, Tally.
router.get('/', (req, res) => {
  try { res.json(fin().read()); } catch (e) { fail(res, e); }
});

// GET /api/finance/monthly/:month — the stored summary for one month (YYYY-MM): spending by domain, money out, income, coverage. Keywords: monthly spending, month summary.
router.get('/monthly/:month', (req, res) => {
  try {
    if (!/^\d{4}-\d{2}$/.test(req.params.month)) return res.status(400).json({ ok: false, error: 'month must be YYYY-MM' });
    const m = fin().monthly(req.params.month);
    if (!m) return res.status(404).json({ ok: false, error: 'no summary for that month' });
    res.json({ ok: true, summary: m });
  } catch (e) { fail(res, e); }
});

// GET /api/finance/reconnect — after a bank reconnect in Tally: accounts relinked, newest and oldest backfilled transactions, gap left, double imports. Keywords: TrueLayer, NatWest, reconnect.
router.get('/reconnect', (req, res) => {
  try { const r = fin().read(); res.json({ ok: true, health: r.health, reconnect: r.reconnect || null, lastRead: r.lastRead }); } catch (e) { fail(res, e); }
});

// POST /api/finance/sync — read Tally now (read-only) and rebuild the finance view. Normally a scheduled job.
router.post('/sync', async (req, res) => {
  try { send(res, await fin().refresh()); } catch (e) { fail(res, e); }
});

// POST /api/finance/transactions/:txnId/decide — Nick sets the domain of one transaction in the review list. Body: decision (confirm|reject|unknown), domain, remember ({matchKind: merchant|merchant+category}).
router.post('/transactions/:txnId/decide', async (req, res) => {
  try {
    if (!hasBody(req)) return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { decision, domain, remember } = req.body;
    send(res, await fin().decide(req.params.txnId, { decision, domain, remember }));
  } catch (e) { fail(res, e); }
});

// POST /api/finance/rules/:ruleId/retire — Nick retires a finance classification rule. Decisions it made stop applying on the next read.
router.post('/rules/:ruleId/retire', async (req, res) => {
  try { send(res, await fin().retireRule(req.params.ruleId)); } catch (e) { fail(res, e); }
});

// POST /api/finance/recurring/:seriesKey/decide — Nick says a payment series is (or is not) recurring. Body: decision (recurring|not-recurring|clear).
router.post('/recurring/:seriesKey/decide', async (req, res) => {
  try {
    if (!hasBody(req)) return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { decision } = req.body;
    send(res, await fin().decideRecurring(req.params.seriesKey, { decision }));
  } catch (e) { fail(res, e); }
});

// POST /api/finance/review/:itemKey/decide — Nick answers an unusual-spend or possible-duplicate item. Body: decision (expected|not-duplicate|leave|look-into-it). Nothing is disputed.
router.post('/review/:itemKey/decide', async (req, res) => {
  try {
    if (!hasBody(req)) return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { decision } = req.body;
    send(res, await fin().decideReview(req.params.itemKey, { decision }));
  } catch (e) { fail(res, e); }
});

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
