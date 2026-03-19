// Jira fetch worker — runs in a child process to isolate EPIPE crashes
// Sends results back to parent via IPC (does NOT write to DB directly)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

function getAuthHeader() {
  const token = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  return `Basic ${token}`;
}

async function jiraFetch(apiPath, options = {}) {
  const url = `${process.env.JIRA_BASE_URL.replace(/\/$/, '')}${apiPath}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        'Authorization': getAuthHeader(),
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Jira API error ${res.status}: ${body}`);
    }
    return res.json();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

function extractSlaInfo(issue) {
  const fields = issue.fields || {};
  let slaRemaining = null;
  let slaName = null;

  for (const [key, value] of Object.entries(fields)) {
    if (!key.startsWith('customfield_') || !value || typeof value !== 'object') continue;
    if (!value.name || (!value.ongoingCycle && !value.completedCycles)) continue;

    const isResolution = (value.name || '').toLowerCase().includes('resolution');

    if (value.ongoingCycle && value.ongoingCycle.remainingTime) {
      slaRemaining = value.ongoingCycle.remainingTime.millis / 60000;
      slaName = value.name;
      if (isResolution) break;
    }

    if (value.ongoingCycle && value.ongoingCycle.breachTime) {
      const breachMs = value.ongoingCycle.breachTime.epochMillis;
      const remaining = (breachMs - Date.now()) / 60000;
      if (slaRemaining === null || isResolution) {
        slaRemaining = remaining;
        slaName = value.name;
        if (isResolution) break;
      }
    }
  }

  return { slaRemaining, slaName };
}

async function run() {
  const projectKey = process.env.JIRA_PROJECT_KEY;
  const jql = `project = ${projectKey} AND statusCategory != Done ORDER BY priority DESC, created ASC`;

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
  } while (nextPageToken);

  // Send parsed tickets back to parent for DB insertion
  const tickets = allIssues.map(issue => {
    const { slaRemaining, slaName } = extractSlaInfo(issue);
    return {
      ticket_key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status ? issue.fields.status.name : null,
      priority: issue.fields.priority ? issue.fields.priority.name : null,
      assignee: issue.fields.assignee ? issue.fields.assignee.displayName : 'Unassigned',
      sla_remaining_minutes: slaRemaining,
      sla_name: slaName,
      at_risk: slaRemaining !== null && slaRemaining < 120,
      raw_json: JSON.stringify(issue)
    };
  });

  process.send({ type: 'done', tickets });
}

run().catch(err => {
  process.send({ type: 'error', message: err.message });
  process.exit(1);
});
