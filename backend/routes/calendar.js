const express = require('express');
const router = express.Router();
const microsoft = require('../services/microsoft');
const eventParser = require('../services/event-parser');
const contacts = require('../services/contact-directory');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

// Graph failure reasons → something Nick can act on.
const FAIL_MESSAGES = {
  auth: 'Not signed in to Microsoft — reconnect in settings.',
  scope: 'Calendars.ReadWrite permission not granted — re-consent to Microsoft (POST /api/microsoft/auth).',
  no_subject: 'Give the meeting a title.',
  no_times: 'Start and end times are required.',
};

// POST /api/calendar/parse — free text → a draft to confirm. Creates nothing.
router.post('/parse', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'text required' });

    const result = await eventParser.parseEventText(text, {
      useAi: req.body?.useAi !== false,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/calendar/resolve?q=abdi — name → address, for the attendee field
router.get('/resolve', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ ok: false, error: 'q required' });
    res.json({ ok: true, ...(await contacts.resolveName(q)) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/calendar/events — create the event. Sends invites, so it only ever
// runs off an explicit confirm in the UI, never straight off a parse.
router.post('/events', async (req, res) => {
  // Build 8: a machine client (the API token: n8n, the remote MCP gateway) may
  // not make Graph email invites to real people. Nick, in NEURO, still can.
  if (req.apiClient && Array.isArray(req.body?.attendees) && req.body.attendees.length) return res.status(403).json({ ok: false, sent: false, error: "Sending calendar invites as Nick needs Nick, in NEURO - a machine client cannot do it on his behalf (Build 8)." });
  try {
    const {
      subject, date, startTime, endTime,
      attendees = [], location = null, body = null,
      isAllDay = false, isOnline = false,
    } = req.body || {};

    if (!subject || !String(subject).trim()) {
      return res.status(400).json({ ok: false, error: 'subject required' });
    }
    if (!DATE_RE.test(date || '')) {
      return res.status(400).json({ ok: false, error: 'date must be YYYY-MM-DD' });
    }

    let start;
    let end;
    if (isAllDay) {
      // Graph wants all-day events midnight-to-midnight on date boundaries.
      const next = new Date(`${date}T00:00:00`);
      next.setDate(next.getDate() + 1);
      const p = (n) => String(n).padStart(2, '0');
      start = `${date}T00:00:00`;
      end = `${next.getFullYear()}-${p(next.getMonth() + 1)}-${p(next.getDate())}T00:00:00`;
    } else {
      if (!TIME_RE.test(startTime || '') || !TIME_RE.test(endTime || '')) {
        return res.status(400).json({ ok: false, error: 'startTime and endTime must be HH:MM' });
      }
      if (endTime <= startTime) {
        return res.status(400).json({ ok: false, error: 'End time must be after start time' });
      }
      start = `${date}T${startTime}:00`;
      end = `${date}T${endTime}:00`;
    }

    const invalid = attendees
      .map((a) => (typeof a === 'string' ? a : a?.email))
      .filter((e) => !String(e || '').includes('@'));
    if (invalid.length) {
      return res.status(400).json({ ok: false, error: `Unresolved attendee: ${invalid.join(', ')}` });
    }

    const result = await microsoft.createCalendarEvent({
      subject, start, end, attendees, location, body, isAllDay, isOnline,
    });

    if (!result.created) {
      return res.status(502).json({
        ok: false,
        reason: result.reason,
        error: FAIL_MESSAGES[result.reason] || `Could not create the event (${result.reason})`,
      });
    }

    res.json({ ok: true, event: result.event });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Meeting triage ───────────────────────────────────────────────────────────

// GET /api/calendar/agenda-check — what would be chased, and why each one was
// skipped. Read-only: a dry run, so the rules can be inspected before anything
// is queued. The skip reasons are the useful half when tuning them.
router.get('/agenda-check', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 21);
    res.json(await require('../services/meeting-triage').scanUpcoming({ days, dryRun: true }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/calendar/agenda-check — queue chasers for approval. Queues only:
// these are emails to real colleagues, so nothing sends without an approval.
router.post('/agenda-check', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.body?.days, 10) || 7, 1), 21);
    res.json(await require('../services/meeting-triage').scanUpcoming({ days }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// It queued a `respond_meeting` action whose approval made Graph send the
// organiser a response (with any comment) as Nick — an outbound message on a
// PIN-only approve, no ledger, no verification. It had never been used (0 rows
// on the live Pi, 3 Oct 2026), so it is retired rather than migrated: adding a
// governed type for it would be a new outbound capability, which Build 8 does
// not add. Nothing is queued and nothing is sent.
//
// POST /api/calendar/events/:id/respond — RETIRED in Build 8 (answers 410 Gone, meeting response, decline, accept). Respond to meeting invites in Outlook.
router.post('/events/:id/respond', (req, res) => {
  res.status(410).json({ ok: false, sent: false, error: require('../services/legacy-outbound').RETIRED.respond_meeting });
});

module.exports = router;
