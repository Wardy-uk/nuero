const fetch = require('node-fetch');
const db = require('../db/database');

function isConfigured() {
  return !!(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN && process.env.JIRA_PROJECT_KEY);
}

function getAuthHeader() {
  const token = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  return `Basic ${token}`;
}

async function jiraFetch(path) {
  const url = `${process.env.JIRA_BASE_URL.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': getAuthHeader(),
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira API error ${res.status}: ${body}`);
  }
  return res.json();
}

function extractSlaInfo(issue) {
  // Jira SLA fields are typically in a custom field
  // Common field patterns for JSM SLA
  const fields = issue.fields || {};
  let slaRemaining = null;
  let slaName = null;

  // Search for SLA fields — they vary by instance
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith('customfield_') && value && typeof value === 'object') {
      // JSM SLA structure: { ongoingCycle: { remainingTime: { millis } }, name }
      if (value.ongoingCycle && value.ongoingCycle.remainingTime) {
        slaRemaining = value.ongoingCycle.remainingTime.millis / 60000; // to minutes
        slaName = value.name || key;
        break;
      }
      // Alternative: completedCycles array
      if (value.completedCycles || value.ongoingCycle) {
        const cycle = value.ongoingCycle;
        if (cycle && cycle.remainingTime) {
          slaRemaining = cycle.remainingTime.millis / 60000;
          slaName = value.name || key;
          break;
        }
      }
    }
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

    // Fetch open issues for the project
    const jql = encodeURIComponent(`project = "${projectKey}" AND statusCategory != Done ORDER BY priority DESC, created ASC`);
    const data = await jiraFetch(`/rest/api/3/search?jql=${jql}&maxResults=100&expand=names`);

    db.clearStaleTickets();

    const issues = data.issues || [];
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

    db.setState('jira_status', 'ok');
    db.setState('jira_last_sync', new Date().toISOString());
    db.setState('jira_ticket_count', String(issues.length));
    console.log(`[Jira] Cached ${issues.length} tickets`);
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
