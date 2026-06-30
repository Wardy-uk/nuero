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

module.exports = router;
