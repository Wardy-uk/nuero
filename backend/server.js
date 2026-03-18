require('dotenv').config();

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
const microsoftRoutes = require('./routes/microsoft');
const n8nRoutes = require('./routes/n8n');
const vaultRoutes = require('./routes/vault');
const contextRoutes = require('./routes/context');
const qaRoutes = require('./routes/qa');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// API routes
app.use('/api/chat', chatRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/obsidian', obsidianRoutes);
app.use('/api/standup', standupRoutes);
app.use('/api/nudges', nudgeRoutes);
app.use('/api/todos', todoRoutes);
app.use('/api/microsoft', microsoftRoutes);
app.use('/api/n8n', n8nRoutes);
app.use('/api/vault', vaultRoutes);
app.use('/api/context', contextRoutes);
app.use('/api/qa', qaRoutes);

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
    agent: 'NICK-AGENT',
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
      authenticated: msAuthenticated
    },
    n8n: {
      configured: n8nService.isConfigured()
    }
  });
});

// Initialize database then start
async function start() {
  await db.init();

  scheduler.start();

  app.listen(PORT, () => {
    console.log(`[Server] NICK-AGENT running on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('[Server] Fatal:', err);
  process.exit(1);
});
