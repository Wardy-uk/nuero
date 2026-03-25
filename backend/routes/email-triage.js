const express = require('express');
const router = express.Router();
const emailTriage = require('../services/email-triage');

// GET /api/email/triage — get classified inbox
router.get('/triage', async (req, res) => {
  try {
    const data = emailTriage.getTriageByCategory();
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/email/triage/run — trigger a fresh triage cycle
router.post('/triage/run', async (req, res) => {
  try {
    const result = await emailTriage.runTriage();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/email/triage/dismiss/:emailId — dismiss an email from triage
router.post('/triage/dismiss/:emailId', (req, res) => {
  try {
    emailTriage.dismissEmail(decodeURIComponent(req.params.emailId));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/email/triage/clear — clear all cached triage data and re-scan
router.post('/triage/clear', async (req, res) => {
  try {
    emailTriage.clearDismissed();
    const db = require('../db/database');
    db.setState('email_triage', '[]');
    db.clearStaleInboxItems();
    // Also clear inbox scanner items
    const stmt = db.getDb().prepare('DELETE FROM inbox_items');
    stmt.step();
    stmt.free();
    db.setState('email_triage_time', '0');
    console.log('[EmailTriage] All triage data cleared');
    // Run fresh scan
    const result = await emailTriage.runTriage();
    res.json({ ok: true, cleared: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
