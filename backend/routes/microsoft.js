const express = require('express');
const router = express.Router();
const microsoft = require('../services/microsoft');

// GET /api/microsoft/status
router.get('/status', async (req, res) => {
  const configured = microsoft.isConfigured();
  const authenticated = configured ? await microsoft.isAuthenticated() : false;
  const bridgeConfigured = microsoft.isBridgeConfigured();
  let bridgeConnected = false;
  if (bridgeConfigured && !authenticated) {
    // Check if bridge is reachable by testing a lightweight call
    try {
      const result = await microsoft.fetchCalendarEvents();
      bridgeConnected = result !== null;
    } catch { bridgeConnected = false; }
  }
  // `signIn`: the device-code sign-in in progress and how the last one ended.
  // `authenticated` only means an account is in the cache — an EXPIRED one
  // counts — so it must never be read as "the sign-in finished".
  res.json({ configured, authenticated, bridgeConfigured, bridgeConnected, signIn: microsoft.signInState() });
});

// GET /api/microsoft/teams-send-status — is the Teams DM path live, or what is
// it waiting on? An unconsented scope is a normal, silent state (Q8); this makes
// it inspectable, which is exactly what NOVA's Teams path lacked while it sat
// dead for months looking built.
router.get('/teams-send-status', async (req, res) => {
  try {
    res.json(await require('../services/teams').getSendStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/microsoft/auth — start device code flow for Graph permissions
router.post('/auth', async (req, res) => {
  if (!microsoft.isConfigured()) {
    return res.status(400).json({ error: 'NOVA token cache not found' });
  }

  try {
    const result = await microsoft.startDeviceCodeFlow();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/microsoft/calendar
// `?source=msal` (NOVA's 1-2-1 calendar reads): own sign-in only, and a failed
// read is a 503 — not `events: []`, which reads as an empty diary.
router.get('/calendar', async (req, res) => {
  const { start, end } = req.query;
  try {
    if (req.query.source === 'msal') {
      const events = await microsoft.fetchCalendarEvents(start, end, { bridge: false });
      if (!events) return res.status(503).json({ error: 'NEURO is not signed in to Microsoft, or the calendar read failed' });
      return res.json({ events, source: 'msal', truncated: !!events.truncated });
    }
    const events = await microsoft.fetchCalendarEvents(start, end);
    res.json({ events: events || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The three /inbox routes here (list, scan, dismiss) were removed on 26 Aug
// 2026 with the inbox-scanner they served. No frontend had ever called any of
// them — which is why nothing could empty the table they wrote to, and why the
// urgent-email push spent twelve days counting mail Nick had already actioned.
// Inbox triage is `/api/email/triage/*` and nothing else.

// GET /api/microsoft/planner/tasks — fetch Planner tasks
router.get('/planner/tasks', async (req, res) => {
  try {
    const tasks = await microsoft.fetchPlannerTasks();
    res.json({ tasks: tasks || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/microsoft/todo/lists — fetch To-Do task lists
router.get('/todo/lists', async (req, res) => {
  try {
    const lists = await microsoft.fetchTodoLists();
    res.json({ lists: lists || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/microsoft/todo/tasks?listId=xxx — fetch To-Do tasks
router.get('/todo/tasks', async (req, res) => {
  try {
    const { listId } = req.query;
    if (!listId) return res.status(400).json({ error: 'listId required' });
    const tasks = await microsoft.fetchTodoTasks(listId);
    res.json({ tasks: tasks || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Build 14B: POST /todo/tasks and PATCH /todo/tasks/:id + /planner/tasks/:id are
// RETIRED. They forwarded the request body to NOVA's bridge unchecked — a "send
// whatever JSON to Microsoft via NOVA" primitive any machine client could reach,
// with no caller in any surface (and NOVA serves no /todo or /planner routes, so
// every call answered 401). The authority guard answers 410 and logs the attempt.
// Editing a Microsoft task is PATCH /api/todos/ms/:msId (title / due / notes,
// whitelisted, Planner guarded by If-Match); completing one is ms-complete.

// POST /api/microsoft/tasks/sync — sync MS tasks to Obsidian vault
router.post('/tasks/sync', async (req, res) => {
  try {
    const obsidian = require('../services/obsidian');
    const result = await obsidian.syncMicrosoftTasks();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
