const express = require('express');
const router = express.Router();
const db = require('../db/database');

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
    configured: !!(db.getState('jira_last_sync')),
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

// POST /api/queue/ingest — accepts pre-fetched ticket JSON from n8n
// Protected by X-Ingest-Secret header matched against INGEST_SECRET env var
router.post('/ingest', (req, res) => {
  const secret = process.env.INGEST_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'INGEST_SECRET not configured on server' });
  }

  const provided = req.headers['x-ingest-secret'];
  if (provided !== secret) {
    return res.status(401).json({ error: 'Invalid or missing X-Ingest-Secret' });
  }

  const { tickets } = req.body;
  if (!Array.isArray(tickets)) {
    return res.status(400).json({ error: 'tickets must be an array' });
  }

  try {
    db.clearStaleTickets();
    for (const ticket of tickets) {
      db.upsertTicket({
        ticket_key: ticket.ticket_key,
        summary: ticket.summary || '(no summary)',
        status: ticket.status || 'Unknown',
        priority: ticket.priority || 'Medium',
        assignee: ticket.assignee || 'Unassigned',
        sla_remaining_minutes: ticket.sla_remaining_minutes != null ? ticket.sla_remaining_minutes : null,
        sla_name: ticket.sla_name || null,
        at_risk: ticket.at_risk || false,
        raw_json: ticket.raw_json || null
      });
    }
    db.setState('jira_status', 'ok');
    db.setState('jira_last_sync', new Date().toISOString());
    db.setState('jira_ticket_count', String(tickets.length));
    console.log(`[Queue] Ingested ${tickets.length} tickets from n8n`);
    res.json({ ok: true, count: tickets.length });
  } catch (e) {
    console.error('[Queue] Ingest error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/queue/sync — trigger immediate Jira sync
router.post('/sync', async (req, res) => {
  try {
    const jira = require('../services/jira');
    if (!jira.isConfigured()) {
      return res.status(400).json({ error: 'Jira not configured — check JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN' });
    }
    const result = await jira.syncTickets();
    res.json(result);
  } catch (e) {
    console.error('[Queue] Sync error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
