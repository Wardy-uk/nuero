const express = require('express');
const router = express.Router();
const plaudSync = require('../services/plaud-sync');

router.get('/status', (req, res) => {
  try {
    res.json(plaudSync.getStatus());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/sync', async (req, res) => {
  try {
    const result = await plaudSync.syncPlaudRecordings({
      incremental: req.body?.incremental !== false
    });
    res.json(result);
  } catch (error) {
    console.error('[PlaudSync] Manual sync failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.post('/cleanup', async (req, res) => {
  try {
    const importsService = require('../services/imports');
    const result = await importsService.backfillPlaudNotes({
      limit: req.body?.limit ? parseInt(req.body.limit, 10) : 500,
      dryRun: req.body?.dryRun === true,
      archiveDuplicates: req.body?.archiveDuplicates !== false
    });
    if (result.status === 'error') return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    console.error('[PlaudSync] Cleanup failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/plaud/reconcile  — read-only; find recordings with no active note
router.post('/reconcile', async (req, res) => {
  try {
    const result = await plaudSync.reconcilePlaudRecordings({
      minJaccard: req.body?.minJaccard != null ? Number(req.body.minJaccard) : undefined,
    });
    res.json(result);
  } catch (error) {
    console.error('[PlaudSync] Reconcile failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/plaud/repull  { ids?: string[], limit?: number }  — throttled, resumable
router.post('/repull', async (req, res) => {
  try {
    const result = await plaudSync.repullPlaudRecordings({
      ids: Array.isArray(req.body?.ids) ? req.body.ids : null,
      limit: req.body?.limit ? parseInt(req.body.limit, 10) : null,
    });
    res.json(result);
  } catch (error) {
    console.error('[PlaudSync] Re-pull failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/plaud/repull-stubs  { limit?: number }  — recover "No transcript returned" notes
router.post('/repull-stubs', async (req, res) => {
  try {
    const result = await plaudSync.repullStubTranscripts({
      limit: req.body?.limit ? parseInt(req.body.limit, 10) : null,
    });
    res.json(result);
  } catch (error) {
    console.error('[PlaudSync] Stub re-fetch failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Transcripts manager (14 Oct 2026) ──────────────────────────────────────
// One row per PLAUD transcript in the vault, whether it has a summary, and two
// actions: refresh in place (picks up speakers named in PLAUD later) and archive.
// Literal paths only, and none is a parameter, so nothing here can shadow another.

// GET /api/plaud/transcripts — list every plaud transcript, its summary status and unnamed speakers. Read-only.
router.get('/transcripts', (req, res) => {
  try {
    res.json(require('../services/plaud-transcripts').list());
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// POST /api/plaud/transcripts/refresh — repull / refresh one plaud transcript in place from PLAUD (speaker names); pulls a summary only if it has none.
router.post('/transcripts/refresh', async (req, res) => {
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'path is required' });
  const { path: notePath, pullSummary } = req.body;
  if (!notePath) return res.status(400).json({ error: 'path is required' });
  try {
    res.json(await require('../services/plaud-transcripts').refresh(notePath, { pullSummary: pullSummary === true }));
  } catch (error) {
    if (!error.status) console.error('[PlaudTranscripts] refresh failed:', error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// POST /api/plaud/transcripts/archive — delete / archive a plaud transcript (moves it, and optionally its summaries, under Archive/; nothing is unlinked).
router.post('/transcripts/archive', (req, res) => {
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'path is required' });
  const { path: notePath, withSummaries } = req.body;
  if (!notePath) return res.status(400).json({ error: 'path is required' });
  try {
    res.json(require('../services/plaud-transcripts').archive(notePath, { withSummaries: withSummaries === true }));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ── Admin blocks ────────────────────────────────────────────────────────────
// The 5-minute "process and update Plaud meeting for X" block after every real
// meeting. Lives here rather than in a router of its own because server.js is
// held by a concurrent session; /api/plaud is already mounted and this is
// squarely Plaud workflow. No parameterised sibling above, so no shadowing.

// GET /api/plaud/admin-blocks — what the ledger holds, and whether it is armed.
router.get('/admin-blocks', (req, res) => {
  try {
    res.json(require('../services/plaud-admin-blocks').status());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/plaud/admin-blocks/plan?days=14 — read-only. Creates nothing.
router.get('/admin-blocks/plan', async (req, res) => {
  try {
    const days = req.query.days ? parseInt(req.query.days, 10) : undefined;
    const result = await require('../services/plaud-admin-blocks').plan({
      // Nonsense falls back to the default rather than to the nearest legal
      // value — a window of 1 returned as if asked for reads as the truth.
      days: Number.isFinite(days) && days > 0 && days <= 60 ? days : undefined,
    });
    res.json(result);
  } catch (error) {
    console.error('[PlaudAdmin] Plan failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/plaud/admin-blocks/apply  { dryRun?: boolean, days?: number }
// dryRun defaults to TRUE — creating real calendar events is not the default
// answer to an empty body.
router.post('/admin-blocks/apply', async (req, res) => {
  try {
    const days = req.body?.days ? parseInt(req.body.days, 10) : undefined;
    const result = await require('../services/plaud-admin-blocks').apply({
      days: Number.isFinite(days) && days > 0 && days <= 60 ? days : undefined,
      dryRun: req.body?.dryRun !== false,
    });
    res.json(result);
  } catch (error) {
    console.error('[PlaudAdmin] Apply failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/plaud/admin-blocks/forget  { meetingId }
// Reconsider a meeting on the next pass — the way back from a block that was
// created wrongly and deleted.
router.post('/admin-blocks/forget', (req, res) => {
  try {
    const meetingId = req.body?.meetingId;
    if (!meetingId) return res.status(400).json({ error: 'meetingId is required' });
    res.json(require('../services/plaud-admin-blocks').forget(meetingId));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
