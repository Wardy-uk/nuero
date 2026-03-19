const express = require('express');
const router = express.Router();
const db = require('../db/database');
const jira = require('../services/jira');

// GET /api/queue?assignee=nick
router.get('/', (req, res) => {
  const summary = db.getQueueSummary();
  const jiraStatus = db.getState('jira_status') || 'unknown';
  const lastSync = db.getState('jira_last_sync');
  const assigneeFilter = req.query.assignee;

  let tickets = summary.tickets;
  if (assigneeFilter) {
    const filter = assigneeFilter.toLowerCase();
    tickets = tickets.filter(t =>
      (t.assignee || '').toLowerCase().includes(filter)
    );
  }

  res.json({
    status: jiraStatus,
    configured: jira.isConfigured(),
    last_sync: lastSync,
    total: tickets.length,
    at_risk_count: tickets.filter(t => t.at_risk).length,
    open_p1s: tickets.filter(t => {
      const p = (t.priority || '').toLowerCase();
      return p.includes('highest') || p === 'p1' || p === 'critical';
    }).length,
    at_risk_tickets: tickets.filter(t => t.at_risk),
    tickets
  });
});

module.exports = router;
