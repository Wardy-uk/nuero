// Jira fetch runs in a child process to isolate EPIPE crashes from the main server
const { fork } = require('child_process');
const path = require('path');
const db = require('../db/database');

function isConfigured() {
  return !!(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN && process.env.JIRA_PROJECT_KEY);
}

let fetching = false;

function fetchAndCacheTickets() {
  if (!isConfigured()) {
    console.log('[Jira] Not configured — skipping fetch');
    db.setState('jira_status', 'not_configured');
    return Promise.resolve();
  }

  if (fetching) {
    console.log('[Jira] Fetch already in progress — skipping');
    return Promise.resolve();
  }

  fetching = true;
  console.log('[Jira] Spawning worker to fetch tickets...');

  return new Promise((resolve) => {
    const worker = fork(path.join(__dirname, 'jira-worker.js'), [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    const timeout = setTimeout(() => {
      console.error('[Jira] Worker timed out after 60s — killing');
      worker.kill('SIGKILL');
    }, 60000);

    worker.on('message', (msg) => {
      if (msg.type === 'done') {
        // Write tickets to DB in the main process
        db.clearStaleTickets();
        for (const ticket of msg.tickets) {
          db.upsertTicket(ticket);
        }
        db.setState('jira_status', 'ok');
        db.setState('jira_last_sync', new Date().toISOString());
        db.setState('jira_ticket_count', String(msg.tickets.length));
        console.log(`[Jira] Cached ${msg.tickets.length} tickets`);
      } else if (msg.type === 'error') {
        console.error('[Jira] Worker error:', msg.message);
        db.setState('jira_status', 'error');
        db.setState('jira_last_error', msg.message);
      }
    });

    worker.on('exit', (code) => {
      clearTimeout(timeout);
      fetching = false;
      if (code !== 0) {
        console.error(`[Jira] Worker exited with code ${code}`);
        db.setState('jira_status', 'error');
        db.setState('jira_last_error', `Worker crashed (exit ${code})`);
      }
      resolve();
    });

    worker.on('error', (err) => {
      clearTimeout(timeout);
      fetching = false;
      console.error('[Jira] Worker spawn error:', err.message);
      resolve();
    });
  });
}

module.exports = {
  isConfigured,
  fetchAndCacheTickets
};
