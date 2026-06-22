'use strict';

const express = require('express');
const router = express.Router();
const knowledgeMemory = require('../services/knowledge-memory');

router.get('/overview', async (req, res) => {
  try {
    const topic = req.query.topic ? String(req.query.topic) : undefined;
    const result = await knowledgeMemory.getOverview({ topic });
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

router.post('/promote', (req, res) => {
  try {
    const { sourcePath, domain, title } = req.body || {};
    const result = knowledgeMemory.promoteCandidate({ sourcePath, domain, title });
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
