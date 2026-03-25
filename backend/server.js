require('dotenv').config();

// Prevent EPIPE errors from crashing the process
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
    console.error(`[Server] Ignored ${err.code}:`, err.message);
    return;
  }
  console.error('[Server] Uncaught exception:', err);
  process.exit(1);
});

const path = require('path');
const express = require('express');
const cors = require('cors');

const db = require('./db/database');
const scheduler = require('./services/scheduler');

const chatRoutes = require('./routes/chat');
const queueRoutes = require('./routes/queue');
const obsidianRoutes = require('./routes/obsidian');
const standupRoutes = require('./routes/standup');
const nudgeRoutes = require('./routes/nudges');
const todoRoutes = require('./routes/todos');
const doNextRoutes = require('./routes/do-next');
const microsoftRoutes = require('./routes/microsoft');
const n8nRoutes = require('./routes/n8n');
const vaultRoutes = require('./routes/vault');
const contextRoutes = require('./routes/context');
const qaRoutes = require('./routes/qa');
const pushRoutes = require('./routes/push');
const importsRoutes = require('./routes/imports');
const captureRoutes = require('./routes/capture');
const journalRoutes = require('./routes/journal');
const stravaRoutes = require('./routes/strava');
const healthRoutes = require('./routes/health');
const locationRoutes = require('./routes/location');
const jiraRoutes = require('./routes/jira');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// App-level auth — PIN required for all API access
// Set NEURO_PIN in .env. If not set, auth is disabled (dev mode).
app.use('/api', (req, res, next) => {
  const expectedPin = process.env.NEURO_PIN;
  if (!expectedPin) return next(); // no PIN configured = open access

  // Allow auth check endpoint without PIN
  if (req.path === '/auth/check' || req.path === '/auth/login') return next();

  // Allow push subscription endpoint (service worker can't send custom headers)
  if (req.path.startsWith('/push/')) return next();

  // Allow SSE streams (nudges/stream) — they use EventSource which can't set headers
  if (req.path === '/nudges/stream') return next();

  const provided = req.headers['x-neuro-pin'] || req.query.pin;
  if (!provided || provided !== expectedPin) {
    return res.status(401).json({ error: 'PIN required' });
  }
  next();
});

// Auth endpoints (outside PIN middleware)
app.post('/api/auth/login', (req, res) => {
  const { pin } = req.body;
  const expected = process.env.NEURO_PIN;
  if (!expected) return res.json({ ok: true }); // no PIN = always ok
  if (pin === expected) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: 'Wrong PIN' });
});

app.get('/api/auth/check', (req, res) => {
  const expected = process.env.NEURO_PIN;
  if (!expected) return res.json({ required: false });
  const provided = req.headers['x-neuro-pin'] || req.query.pin;
  res.json({ required: true, authenticated: provided === expected });
});

// API routes
app.use('/api/chat', chatRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/obsidian', obsidianRoutes);
app.use('/api/standup', standupRoutes);
app.use('/api/nudges', nudgeRoutes);
app.use('/api/todos', todoRoutes);
app.use('/api/do-next', doNextRoutes);
app.use('/api/microsoft', microsoftRoutes);
app.use('/api/n8n', n8nRoutes);
app.use('/api/vault', vaultRoutes);
app.use('/api/context', contextRoutes);
app.use('/api/qa', qaRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/imports', importsRoutes);
app.use('/api/capture', captureRoutes);
app.use('/api/journal', journalRoutes);
app.use('/api/strava', stravaRoutes);
app.use('/api/health', healthRoutes);
app.use('/api/location', locationRoutes);
app.use('/api/jira', jiraRoutes);
app.use('/api/activity', require('./routes/activity'));
app.use('/api/email', require('./routes/email-triage'));

// Health / status endpoint
app.get('/api/status', async (req, res) => {
  const jiraService = require('./services/jira');
  const claudeService = require('./services/claude');
  const obsidianService = require('./services/obsidian');
  const microsoftService = require('./services/microsoft');

  const n8nService = require('./services/n8n');
  const msConfigured = microsoftService.isConfigured();
  const msAuthenticated = msConfigured ? await microsoftService.isAuthenticated() : false;

  res.json({
    agent: 'NUERO',
    version: '1.0.0',
    uptime: process.uptime(),
    jira: {
      configured: jiraService.isConfigured(),
      status: db.getState('jira_status') || 'unknown',
      last_sync: db.getState('jira_last_sync'),
      last_error: db.getState('jira_last_error')
    },
    claude: {
      configured: claudeService.isConfigured()
    },
    obsidian: {
      configured: obsidianService.isConfigured()
    },
    microsoft: {
      configured: msConfigured,
      authenticated: msAuthenticated,
      bridge: microsoftService.isBridgeConnected(),
      source: msAuthenticated ? 'msal' : microsoftService.isBridgeConnected() ? 'nova-bridge' : 'none'
    },
    n8n: {
      configured: n8nService.isConfigured()
    },
    push: {
      configured: require('./services/webpush').isConfigured(),
      subscriptions: db.getAllPushSubscriptions().length
    },
    strava: {
      configured: require('./services/strava').isConfigured(),
      authenticated: require('./services/strava').isAuthenticated()
    },
    health: {
      hasToday: (() => {
        try {
          return require('./services/health').getTodayData() !== null;
        } catch { return false; }
      })(),
      latestDate: (() => {
        try {
          const raw = require('./db/database').getState('health_latest');
          return raw ? JSON.parse(raw).date : null;
        } catch { return null; }
      })()
    },
    location: {
      configured: require('./services/location').isConfigured(),
      recorderUrl: process.env.OWNTRACKS_RECORDER_URL || null
    },
    vaultSync: (() => {
      try { return require('./services/vault-sync').getStatus(); }
      catch { return { enabled: false }; }
    })()
  });
});

// Serve frontend static files (production — built frontend alongside backend)
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
// Hashed assets (js/css) — long cache. Everything else — no cache.
app.use('/assets', express.static(path.join(frontendDist, 'assets'), { maxAge: '1y', immutable: true }));
app.use(express.static(frontendDist, { maxAge: 0, etag: false }));
// SPA fallback — any non-API route serves index.html with no-cache
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.sendFile(path.join(frontendDist, 'index.html'));
});

// Initialize database then start
async function start() {
  await db.init();
  db.setState('imports_sweep_running', 'false');

  // Seed Strava tokens from env if not already in DB
  require('./services/strava').seedTokensFromEnv();

  const webpushService = require('./services/webpush');
  webpushService.init();

  const inboxScanner = require('./services/inbox-scanner');
  inboxScanner.start();

  scheduler.start();

  // Start vault git sync (replaces Windows Task Scheduler VaultSync job)
  const vaultSync = require('./services/vault-sync');
  vaultSync.start();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] NUERO running on 0.0.0.0:${PORT}`);
  });
}

start().catch(err => {
  console.error('[Server] Fatal:', err);
  process.exit(1);
});
