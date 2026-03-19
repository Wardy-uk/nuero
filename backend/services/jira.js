const fetch = require('node-fetch');
const http = require('http');
const https = require('https');
const AbortController = globalThis.AbortController || require('abort-controller');
const db = require('../db/database');

// Disable keep-alive to prevent EPIPE on reused sockets
const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

function isConfigured() {
  return !!(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN && process.env.JIRA_PROJECT_KEY);
}

function getAuthHeader() {
  const token = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  return `Basic ${token}`;
}

async function jiraFetch(path, options = {}) {
  const url = `${process.env.JIRA_BASE_URL.replace(/\/$/, '')}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Authorization': getAuthHeader(),
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: controller.signal,
    agent: url.startsWith('https') ? httpsAgent : httpAgent
  });
  clearTimeout(timeout);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira API error ${res.status}: ${body}`);
  }
  return res.json();
}

function extractSlaInfo(issue) {
  const fields = issue.fields || {};
  let slaRemaining = null;
  let slaName = null;

  for (const [key, value] of Object.entries(fields)) {
    if (!key.startsWith('customfield_') || !value || typeof value !== 'object') continue;
    if (!value.name || (!value.ongoingCycle && !value.completedCycles)) continue;

    // Prefer "Resolution" SLA, fall back to any SLA
    const isResolution = (value.name || '').toLowerCase().includes('resolution');

    // Check ongoingCycle first (active SLA)
    if (value.ongoingCycle && value.ongoingCycle.remainingTime) {
      slaRemaining = value.ongoingCycle.remainingTime.millis / 60000;
      slaName = value.name;
      if (isResolution) break; // prefer resolution, stop looking
    }

    // If no ongoing cycle, check if there's a breach time we can calculate from
    if (value.ongoingCycle && value.ongoingCycle.breachTime) {
      const breachMs = value.ongoingCycle.breachTime.epochMillis;
      const remaining = (breachMs - Date.now()) / 60000;
      if (slaRemaining === null || isResolution) {
        slaRemaining = remaining;
        slaName = value.name;
        if (isResolution) break;
      }
    }

    // Fall back: if no ongoing but has completed cycles, SLA is met — skip
  }

  return { slaRemaining, slaName };
}

async function fetchAndCacheTickets() {
  if (!isConfigured()) {
    console.log('[Jira] Not configured — skipping fetch');
    db.setState('jira_status', 'not_configured');
    return;
  }

  try {
    console.log('[Jira] Fetching open tickets...');
    const projectKey = process.env.JIRA_PROJECT_KEY;

    // Fetch open issues via the new /search/jql endpoint (POST)
    const jql = `project = ${projectKey} AND statusCategory != Done ORDER BY priority DESC, created ASC`;

    db.clearStaleTickets();

    let allIssues = [];
    let nextPageToken = null;

    do {
      const body = {
        jql,
        maxResults: 100,
        fields: ['summary', 'status', 'priority', 'assignee', '*all']
      };
      if (nextPageToken) body.nextPageToken = nextPageToken;

      const data = await jiraFetch('/rest/api/3/search/jql', {
        method: 'POST',
        body
      });

      const issues = data.issues || [];
      allIssues = allIssues.concat(issues);
      nextPageToken = data.nextPageToken || null;

      for (const issue of issues) {
        const { slaRemaining, slaName } = extractSlaInfo(issue);
        const atRisk = slaRemaining !== null && slaRemaining < 120; // < 2 hours

        db.upsertTicket({
          ticket_key: issue.key,
          summary: issue.fields.summary,
          status: issue.fields.status ? issue.fields.status.name : null,
          priority: issue.fields.priority ? issue.fields.priority.name : null,
          assignee: issue.fields.assignee ? issue.fields.assignee.displayName : 'Unassigned',
          sla_remaining_minutes: slaRemaining,
          sla_name: slaName,
          at_risk: atRisk,
          raw_json: JSON.stringify(issue)
        });
      }
    } while (nextPageToken);

    db.setState('jira_status', 'ok');
    db.setState('jira_last_sync', new Date().toISOString());
    db.setState('jira_ticket_count', String(allIssues.length));
    console.log(`[Jira] Cached ${allIssues.length} tickets`);
  } catch (err) {
    console.error('[Jira] Fetch error:', err.message);
    db.setState('jira_status', 'error');
    db.setState('jira_last_error', err.message);
  }
}

module.exports = {
  isConfigured,
  fetchAndCacheTickets
};
