const express = require('express');
const router = express.Router();
const db = require('../db/database');
const jira = require('../services/jira');

// GET /api/queue
router.get('/', (req, res) => {
  const summary = db.getQueueSummary();
  const jiraStatus = db.getState('jira_status') || 'unknown';
  const lastSync = db.getState('jira_last_sync');

  res.json({
    status: jiraStatus,
    configured: jira.isConfigured(),
    last_sync: lastSync,
    ...summary
  });
});

module.exports = router;
