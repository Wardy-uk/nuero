const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const importsService = require('../services/imports');
const db = require('../db/database');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';

function isWithinVault(filePath) {
  return filePath.startsWith(path.resolve(VAULT_PATH));
}

// GET /api/imports/pending — list unprocessed files in Imports/
router.get('/pending', (req, res) => {
  try {
    const pending = importsService.getPending();
    res.json({ count: pending.length, files: pending });
  } catch (e) {
    console.error('[Imports] Error listing pending:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/imports/status — sweep status and pending count
router.get('/status', (req, res) => {
  try {
    const pending = importsService.getPending();
    const lastSweepRaw = db.getState('imports_last_sweep');
    const lastSweep = lastSweepRaw ? JSON.parse(lastSweepRaw) : null;
    res.json({ pendingCount: pending.length, lastSweep });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/imports/classify — classify a single file using Ollama
router.post('/classify', async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  if (!isWithinVault(filePath)) return res.status(403).json({ error: 'File must be within the vault' });

  try {
    const classification = await importsService.classifyFile(filePath);
    res.json(classification);
  } catch (e) {
    console.error('[Imports] Classify error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/imports/classify-all — trigger batch sweep
router.post('/classify-all', (req, res) => {
  // Fire and forget — don't wait for completion
  importsService.autoClassify().catch(e => {
    console.error('[Imports] Batch classify error:', e);
  });
  res.json({ started: true });
});

// POST /api/imports/route — move file to classified destination
router.post('/route', (req, res) => {
  const { filePath, destination, type } = req.body;
  if (!filePath || !destination) return res.status(400).json({ error: 'filePath and destination required' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  if (!isWithinVault(filePath)) return res.status(403).json({ error: 'File must be within the vault' });

  try {
    const newPath = importsService.routeFile(filePath, destination, type);
    console.log(`[Imports] Routed ${path.basename(filePath)} → ${newPath}`);
    res.json({ success: true, newPath });
  } catch (e) {
    console.error('[Imports] Route error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/imports/flag — mark file as needs-review
router.post('/flag', (req, res) => {
  const { filePath, reason } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  if (!isWithinVault(filePath)) return res.status(403).json({ error: 'File must be within the vault' });

  try {
    importsService.updateFrontmatter(filePath, {
      status: 'needs-review',
      'review-reason': reason || 'Flagged manually'
    });
    const dbFlag = require('../db/database');
    const relativePathFlag = require('path').relative(VAULT_PATH, filePath).replace(/\\/g, '/');
    dbFlag.deleteImportClassification(relativePathFlag);
    console.log(`[Imports] Flagged ${path.basename(filePath)} for review`);
    res.json({ success: true });
  } catch (e) {
    console.error('[Imports] Flag error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/imports/dismiss — mark file as processed without moving
router.post('/dismiss', (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  if (!isWithinVault(filePath)) return res.status(403).json({ error: 'File must be within the vault' });

  try {
    importsService.updateFrontmatter(filePath, { status: 'processed' });
    const dbDismiss = require('../db/database');
    const relativePathDismiss = require('path').relative(VAULT_PATH, filePath).replace(/\\/g, '/');
    dbDismiss.deleteImportClassification(relativePathDismiss);
    console.log(`[Imports] Dismissed ${path.basename(filePath)}`);
    res.json({ success: true });
  } catch (e) {
    console.error('[Imports] Dismiss error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
