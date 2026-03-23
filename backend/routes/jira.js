const express = require('express');
const router = express.Router();
const jira = require('../services/jira');
const db = require('../db/database');

// GET /api/jira/escalations/unseen — count for sidebar badge
router.get('/escalations/unseen', (req, res) => {
  try {
    const count = jira.getUnseenEscalationCount();
    res.json({ count });
  } catch (e) {
    res.json({ count: 0 });
  }
});

// POST /api/jira/escalations/seen — mark all as seen when queue tab opened
router.post('/escalations/seen', async (req, res) => {
  try {
    jira.markEscalationsSeen();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/jira/escalations — full escalation list for queue panel
router.get('/escalations', async (req, res) => {
  try {
    const raw = db.getState('escalation_seen');
    const known = raw ? JSON.parse(raw) : {};
    const tickets = Object.entries(known).map(([key, v]) => ({
      key,
      summary: v.summary,
      created: v.created,
      hasComment: v.hasComment,
      seen: v.seen
    }));
    res.json({ tickets, total: tickets.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/jira/ticket/:ticketKey — fetch basic ticket details
router.get('/ticket/:ticketKey', async (req, res) => {
  const { ticketKey } = req.params;
  if (!ticketKey.match(/^[A-Z]+-\d+$/)) {
    return res.status(400).json({ ok: false, error: 'Invalid ticket key format' });
  }
  try {
    const result = await jira.fetchTicketDetails(ticketKey);
    res.json({ ok: true, ticket: result });
  } catch (e) {
    res.status(404).json({ ok: false, error: e.message });
  }
});

// GET /api/jira/flagged — get all informally flagged tickets
router.get('/flagged', (req, res) => {
  try {
    const tickets = jira.getFlaggedTickets();
    res.json({ tickets, total: tickets.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/jira/flagged/:ticketKey — flag a ticket (adds neuro-escalation label)
router.post('/flagged/:ticketKey', async (req, res) => {
  const { ticketKey } = req.params;
  const { note } = req.body;
  try {
    const result = await jira.flagTicket(ticketKey, note || null);
    try { require('../services/activity').trackEscalationRaised(ticketKey); } catch {}
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /api/jira/flagged/:ticketKey — unflag a ticket (removes label)
router.delete('/flagged/:ticketKey', async (req, res) => {
  const { ticketKey } = req.params;
  try {
    const result = await jira.unflagTicket(ticketKey);
    try { require('../services/activity').trackEscalationResolved(ticketKey); } catch {}
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/jira/flagged/:ticketKey/note — update note on a flagged ticket
router.post('/flagged/:ticketKey/note', (req, res) => {
  const { ticketKey } = req.params;
  const { note } = req.body;
  try {
    const tickets = jira.getFlaggedTickets();
    const ticket = tickets.find(t => t.key === ticketKey);
    if (!ticket) return res.status(404).json({ ok: false, error: 'Ticket not flagged' });

    const raw = db.getState('flagged_tickets');
    const known = raw ? JSON.parse(raw) : {};
    if (known[ticketKey]) {
      known[ticketKey].note = note || null;
      db.setState('flagged_tickets', JSON.stringify(known));
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
