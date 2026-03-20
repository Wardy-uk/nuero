const https = require('https');
const db = require('../db/database');

const JIRA_BASE_URL = process.env.JIRA_BASE_URL || '';
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || '';
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'NT';

// Poll interval: 5 minutes
const POLL_INTERVAL_MS = 5 * 60 * 1000;
let pollTimer = null;

function isConfigured() {
  return !!(JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN);
}

// ── HTTPS request with timeout and error handling ──

function jiraRequest(urlPath, options = {}) {
  const { method = 'GET', body = null, timeoutMs = 15000 } = options;

  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, JIRA_BASE_URL);
    const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');

    const reqOptions = {
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json'
      },
      timeout: timeoutMs
    };

    if (body) {
      reqOptions.headers['Content-Type'] = 'application/json';
    }

    const req = https.request(url, reqOptions, (res) => {
      if (res.statusCode >= 400) {
        let responseBody = '';
        res.on('data', c => responseBody += c);
        res.on('end', () => reject(new Error(`Jira API ${res.statusCode}: ${responseBody.substring(0, 200)}`)));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON from Jira: ${e.message}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Jira request failed: ${err.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Jira request timed out'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ── Fetch open tickets from JSM ──

async function fetchOpenTickets() {
  // New /search/jql endpoint (POST-based, replaces deprecated GET /search)
  const jql = `project = ${JIRA_PROJECT_KEY} AND statusCategory != Done AND assignee = currentUser() ORDER BY priority ASC, created DESC`;

  const result = await jiraRequest('/rest/api/3/search/jql', {
    method: 'POST',
    body: {
      jql,
      fields: ['summary', 'status', 'priority', 'assignee', 'created', 'updated'],
      maxResults: 100
    }
  });
  return result.issues || [];
}

// ── Map Jira issue to our ticket format ──

function mapIssueToTicket(issue) {
  const fields = issue.fields || {};
  const priorityName = fields.priority?.name || 'Medium';

  // Determine at-risk based on priority
  const isHighPriority = ['Highest', 'High', 'Critical', 'Blocker', 'P1'].some(
    p => priorityName.toLowerCase().includes(p.toLowerCase())
  );

  // Calculate a rough SLA estimate based on priority and age
  const created = new Date(fields.created);
  const ageHours = (Date.now() - created.getTime()) / (1000 * 60 * 60);

  // Simple SLA thresholds: P1=4h, P2=8h, P3=24h, P4=48h
  let slaTarget;
  if (priorityName.toLowerCase().includes('highest') || priorityName.toLowerCase() === 'p1') slaTarget = 4;
  else if (priorityName.toLowerCase().includes('high') || priorityName.toLowerCase() === 'p2') slaTarget = 8;
  else if (priorityName.toLowerCase().includes('medium') || priorityName.toLowerCase() === 'p3') slaTarget = 24;
  else slaTarget = 48;

  const slaRemainingMinutes = Math.max(0, (slaTarget - ageHours) * 60);
  const atRisk = slaRemainingMinutes < 120; // less than 2 hours remaining

  return {
    ticket_key: issue.key,
    summary: fields.summary || '(no summary)',
    status: fields.status?.name || 'Unknown',
    priority: priorityName,
    assignee: fields.assignee?.displayName || 'Unassigned',
    sla_remaining_minutes: Math.round(slaRemainingMinutes),
    sla_name: `${slaTarget}h target`,
    at_risk: atRisk,
    raw_json: JSON.stringify(issue)
  };
}

// ── Main sync function ──

async function syncTickets() {
  if (!isConfigured()) {
    console.warn('[Jira] Not configured — skipping sync');
    return { ok: false, reason: 'not configured' };
  }

  try {
    console.log('[Jira] Fetching open tickets...');
    const issues = await fetchOpenTickets();
    console.log(`[Jira] Received ${issues.length} issues`);

    db.clearStaleTickets();

    for (const issue of issues) {
      const ticket = mapIssueToTicket(issue);
      db.upsertTicket(ticket);
    }

    db.setState('jira_status', 'ok');
    db.setState('jira_last_sync', new Date().toISOString());
    db.setState('jira_ticket_count', String(issues.length));
    db.setState('jira_last_error', '');

    console.log(`[Jira] Synced ${issues.length} tickets`);
    return { ok: true, count: issues.length };
  } catch (err) {
    console.error('[Jira] Sync failed:', err.message);
    db.setState('jira_status', 'error');
    db.setState('jira_last_error', err.message);
    return { ok: false, error: err.message };
  }
}

// ── Polling ──

function startPolling() {
  if (!isConfigured()) {
    console.log('[Jira] Not configured — polling disabled');
    return;
  }

  // Initial sync after a short delay (let server finish starting)
  setTimeout(() => {
    syncTickets().catch(err => console.error('[Jira] Initial sync error:', err.message));
  }, 5000);

  // Then poll every 5 minutes
  pollTimer = setInterval(() => {
    syncTickets().catch(err => console.error('[Jira] Poll error:', err.message));
  }, POLL_INTERVAL_MS);

  console.log(`[Jira] Polling started — every ${POLL_INTERVAL_MS / 1000}s`);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('[Jira] Polling stopped');
  }
}

module.exports = {
  isConfigured,
  syncTickets,
  startPolling,
  stopPolling
};
