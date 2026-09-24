'use strict';

const express = require('express');
const router = express.Router();
const knowledgeMemory = require('../services/knowledge-memory');

// ⚠ `daysBack` is how the BACK CATALOGUE is reached — the queue defaults to 21 days, so
// without it 775 of the vault's 814 candidates are unreachable rather than low-ranked.
// ⚠ A JUNK VALUE IS REFUSED, NEVER CLAMPED (`temporal-range`'s rule): clamping answers a
// question nobody asked while looking like it answered the one they did, and here the
// difference is "this week" versus "everything since 2019".
router.get('/overview', async (req, res) => {
  try {
    const topic = req.query.topic ? String(req.query.topic) : undefined;
    let daysBack;
    if (req.query.daysBack !== undefined) {
      daysBack = Number(req.query.daysBack);
      if (!Number.isInteger(daysBack) || daysBack < 1 || daysBack > 3650) {
        return res.status(400).json({
          ok: false,
          error: 'daysBack must be a whole number of days between 1 and 3650'
        });
      }
    }
    const result = await knowledgeMemory.getOverview({ topic, daysBack });
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[knowledge-memory/overview]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/active-context', async (req, res) => {
  try {
    const topic = req.query.topic ? String(req.query.topic) : undefined;
    const maxResults = req.query.maxResults ? parseInt(req.query.maxResults, 10) : 5;
    const context = await knowledgeMemory.getActiveContext({ topic, maxResults });
    res.json({ ok: true, topic: topic || null, context });
  } catch (e) {
    console.error('[knowledge-memory/active-context]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ⚠ `/dismissed` is a LITERAL path on a router that also carries `/promote` and
// `/dismiss`; it is registered before them out of habit rather than necessity (none of
// these are parameterised today), but this codebase has shipped a literal path
// swallowed by a sibling `/:param` twice — `/triage/feedback` and `/triage/muted` —
// so the order is deliberate and a parameterised route added later must go below it.
router.get('/dismissed', (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    const result = knowledgeMemory.listDismissed({ limit });
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[knowledge-memory/dismissed]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/domains', (req, res) => {
  try {
    const result = knowledgeMemory.listDomains();
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[knowledge-memory/domains]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/dismiss', (req, res) => {
  try {
    const { sourcePath, reason } = req.body || {};
    const result = knowledgeMemory.dismissCandidate({ sourcePath, reason });
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[knowledge-memory/dismiss]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// The way back. Not optional — see dismissCandidate's header.
router.post('/undismiss', (req, res) => {
  try {
    const { sourcePath } = req.body || {};
    const result = knowledgeMemory.undismissCandidate({ sourcePath });
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[knowledge-memory/undismiss]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ⚠ SPENDS MODEL CALLS, one per unenriched note, so it is bounded and never scheduled.
// Kicking it off from a screen is deliberate: the cost should be a decision someone
// makes, not something a cron quietly runs up against the daily budget.
router.post('/enrich-candidates', async (req, res) => {
  try {
    const limit = req.body?.limit ? parseInt(req.body.limit, 10) : 25;
    const result = await knowledgeMemory.enrichPromotionCandidates({ limit });
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[knowledge-memory/enrich-candidates]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// An open loop is debt to chase, not knowledge. ⚠ Attended only — one press, one
// task. There is deliberately no sweep: a pass that turned every loop into a task is
// how the review queue reached 364 items nobody read.
router.post('/loop-to-task', (req, res) => {
  try {
    const { sourcePath, loopIndex, origin } = req.body || {};
    const result = knowledgeMemory.loopToTask({ sourcePath, loopIndex, origin });
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[knowledge-memory/loop-to-task]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/promote', (req, res) => {
  try {
    const { sourcePath, domain, title, insightIndexes, loopIndexes } = req.body || {};
    const result = knowledgeMemory.promoteCandidate({ sourcePath, domain, title, insightIndexes, loopIndexes });
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[knowledge-memory/promote]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/reflection', (req, res) => {
  try {
    const topic = req.query.topic ? String(req.query.topic) : undefined;
    const write = req.query.write === 'true';
    const result = knowledgeMemory.generateReflection({ topic, write });
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[knowledge-memory/reflection]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/consolidate', async (req, res) => {
  try {
    const limit = req.body?.limit ? parseInt(req.body.limit, 10) : 25;
    const includeConsolidatedPlaud = req.body?.includeConsolidatedPlaud === true;
    const result = await knowledgeMemory.consolidateAllImports({ limit, includeConsolidatedPlaud });
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[knowledge-memory/consolidate]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/refresh-plaud', async (req, res) => {
  try {
    const limit = req.body?.limit ? parseInt(req.body.limit, 10) : 500;
    const result = await knowledgeMemory.refreshAllPlaudConsolidations({ limit });
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[knowledge-memory/refresh-plaud]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/enrich-managed', async (req, res) => {
  try {
    const limit = req.body?.limit ? parseInt(req.body.limit, 10) : 25;
    const result = await knowledgeMemory.enrichManagedNotes({ limit });
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[knowledge-memory/enrich-managed]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/daily-report', (req, res) => {
  try {
    const date = req.query.date ? String(req.query.date) : new Date().toISOString().slice(0, 10);
    const write = req.query.write === 'true';
    const result = write
      ? knowledgeMemory.writeDailyImportReport(date)
      : { status: 'ok', markdown: knowledgeMemory.buildDailyImportReport(date) };
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, date, ...result });
  } catch (e) {
    console.error('[knowledge-memory/daily-report]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/ensure-docs', (req, res) => {
  try {
    const result = knowledgeMemory.ensureVaultOperatingModelDoc();
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[knowledge-memory/ensure-docs]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
