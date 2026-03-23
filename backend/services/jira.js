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

// ── Fetch single ticket details ──

async function fetchTicketDetails(ticketKey) {
  const issue = await jiraRequest(
    `/rest/api/3/issue/${ticketKey}?fields=summary,status,priority,assignee,issuetype`
  );
  const fields = issue.fields || {};
  return {
    key: issue.key,
    summary: fields.summary || '',
    status: fields.status?.name || '',
    priority: fields.priority?.name || '',
    assignee: fields.assignee?.displayName || 'Unassigned',
    type: fields.issuetype?.name || ''
  };
}

// ── Escalation queue ──

// Fetch all open escalation tickets
async function fetchEscalationTickets() {
  const jql = `resolution = Unresolved AND "Request Type" in ("Escalation (NT)") AND status not in (CLOSED, Done, Resolved) ORDER BY created DESC`;

  const result = await jiraRequest('/rest/api/3/search/jql', {
    method: 'POST',
    body: {
      jql,
      fields: ['summary', 'status', 'priority', 'assignee', 'created', 'updated', 'comment'],
      maxResults: 50
    }
  });
  return result.issues || [];
}

// Check if Nick has commented on a ticket
// "Nick" = comment author email contains JIRA_EMAIL (nickw@nurtur.tech)
function nickHasCommented(issue) {
  const comments = issue.fields?.comment?.comments || [];
  const nickEmail = (JIRA_EMAIL || '').toLowerCase();
  return comments.some(c => {
    const authorEmail = (c.author?.emailAddress || '').toLowerCase();
    const authorName = (c.author?.displayName || '').toLowerCase();
    return authorEmail.includes(nickEmail) || authorName.includes('nick ward');
  });
}

// Sync escalation queue — store seen/unseen state in agent_state
async function syncEscalations() {
  if (!isConfigured()) return { ok: false, reason: 'not configured' };

  try {
    const issues = await fetchEscalationTickets();

    // Load known ticket keys
    let known = {};
    try {
      const raw = db.getState('escalation_seen');
      known = raw ? JSON.parse(raw) : {};
    } catch { known = {}; }

    let newUnseen = 0;
    const updated = { ...known };

    for (const issue of issues) {
      const key = issue.key;
      const hasComment = nickHasCommented(issue);

      if (!updated[key]) {
        // First time seeing this ticket
        updated[key] = {
          seen: false,
          hasComment,
          summary: issue.fields?.summary || '',
          created: issue.fields?.created
        };
        if (!hasComment) {
          newUnseen++;
          console.log(`[Jira] New escalation without Nick comment: ${key}`);
        }
      } else {
        // Update comment status (Nick may have commented since last check)
        updated[key].hasComment = hasComment;
      }
    }

    // Remove tickets no longer in the queue
    const activeKeys = new Set(issues.map(i => i.key));
    for (const key of Object.keys(updated)) {
      if (!activeKeys.has(key)) delete updated[key];
    }

    db.setState('escalation_seen', JSON.stringify(updated));
    db.setState('escalation_last_sync', new Date().toISOString());
    db.setState('escalation_count', String(issues.length));

    // Trigger nudge if new unseen escalations
    if (newUnseen > 0) {
      try {
        const nudges = require('./nudges');
        const unseenList = Object.entries(updated)
          .filter(([, v]) => !v.hasComment && !v.seen)
          .slice(0, 3)
          .map(([k, v]) => `${k}: ${v.summary}`)
          .join('; ');
        const msg = `${newUnseen} new escalation${newUnseen > 1 ? 's' : ''} need${newUnseen === 1 ? 's' : ''} your attention: ${unseenList}`;
        nudges.broadcast({ type: 'nudge', nudge_type: 'escalation', message: msg, nag_count: 0 });
        const webpush = require('./webpush');
        webpush.sendToAll('NEURO — New Escalation', msg, { type: 'escalation', url: '/queue' }).catch(() => {});
        console.log(`[Jira] Escalation nudge sent: ${newUnseen} new`);
      } catch (e) {
        console.warn('[Jira] Failed to send escalation nudge:', e.message);
      }
    }

    return { ok: true, total: issues.length, newUnseen };
  } catch (err) {
    console.error('[Jira] Escalation sync failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// Mark escalation ticket as seen by Nick (called when he opens the queue tab)
function markEscalationsSeen() {
  try {
    const raw = db.getState('escalation_seen');
    const known = raw ? JSON.parse(raw) : {};
    for (const key of Object.keys(known)) {
      known[key].seen = true;
    }
    db.setState('escalation_seen', JSON.stringify(known));
  } catch {}
}

// Count unseen escalations (tickets Nick hasn't commented on AND hasn't opened)
function getUnseenEscalationCount() {
  try {
    const raw = db.getState('escalation_seen');
    const known = raw ? JSON.parse(raw) : {};
    return Object.values(known).filter(v => !v.hasComment && !v.seen).length;
  } catch { return 0; }
}

// ── Informal escalation flagging (neuro-escalation label) ──

// Fetch tickets with neuro-escalation label
async function fetchFlaggedTickets() {
  const jql = `labels = "neuro-escalation" AND resolution = Unresolved ORDER BY updated DESC`;

  const result = await jiraRequest('/rest/api/3/search/jql', {
    method: 'POST',
    body: {
      jql,
      fields: ['summary', 'status', 'priority', 'assignee', 'created', 'updated',
               'labels', 'comment'],
      maxResults: 50
    }
  });
  return result.issues || [];
}

// Add neuro-escalation label to a Jira ticket
async function addEscalationLabel(ticketKey) {
  const issue = await jiraRequest(`/rest/api/3/issue/${ticketKey}?fields=labels`);
  const currentLabels = issue.fields?.labels || [];

  if (currentLabels.includes('neuro-escalation')) {
    return { ok: true, alreadyLabelled: true };
  }

  await jiraRequest(`/rest/api/3/issue/${ticketKey}`, {
    method: 'PUT',
    body: {
      fields: {
        labels: [...currentLabels, 'neuro-escalation']
      }
    }
  });

  console.log(`[Jira] Added neuro-escalation label to ${ticketKey}`);
  return { ok: true };
}

// Remove neuro-escalation label from a Jira ticket
async function removeEscalationLabel(ticketKey) {
  const issue = await jiraRequest(`/rest/api/3/issue/${ticketKey}?fields=labels`);
  const currentLabels = issue.fields?.labels || [];
  const newLabels = currentLabels.filter(l => l !== 'neuro-escalation');

  await jiraRequest(`/rest/api/3/issue/${ticketKey}`, {
    method: 'PUT',
    body: { fields: { labels: newLabels } }
  });

  console.log(`[Jira] Removed neuro-escalation label from ${ticketKey}`);
  removeFlaggedTicketLocal(ticketKey);
  return { ok: true };
}

// Sync flagged tickets — poll Jira for neuro-escalation label
async function syncFlaggedTickets() {
  if (!isConfigured()) return { ok: false, reason: 'not configured' };

  try {
    const issues = await fetchFlaggedTickets();

    let known = {};
    try {
      const raw = db.getState('flagged_tickets');
      known = raw ? JSON.parse(raw) : {};
    } catch { known = {}; }

    const updated = { ...known };

    for (const issue of issues) {
      const key = issue.key;
      const hasComment = nickHasCommented(issue);
      const fields = issue.fields || {};

      if (!updated[key]) {
        updated[key] = {
          summary: fields.summary || '',
          status: fields.status?.name || '',
          priority: fields.priority?.name || '',
          assignee: fields.assignee?.displayName || 'Unassigned',
          hasComment,
          flaggedAt: new Date().toISOString(),
          flaggedVia: 'jira',
          note: null
        };
        console.log(`[Jira] New flagged ticket detected: ${key}`);
      } else {
        updated[key].status = fields.status?.name || updated[key].status;
        updated[key].assignee = fields.assignee?.displayName || 'Unassigned';
        updated[key].hasComment = hasComment;
      }
    }

    // Remove tickets no longer labelled
    const activeKeys = new Set(issues.map(i => i.key));
    for (const key of Object.keys(updated)) {
      if (!activeKeys.has(key)) {
        console.log(`[Jira] Flagged ticket ${key} — label removed, dropping from list`);
        delete updated[key];
      }
    }

    db.setState('flagged_tickets', JSON.stringify(updated));
    db.setState('flagged_last_sync', new Date().toISOString());

    return { ok: true, total: issues.length };
  } catch (err) {
    console.error('[Jira] Flagged ticket sync failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// Flag a ticket from NEURO — adds label to Jira AND stores local metadata
async function flagTicket(ticketKey, note = null) {
  await addEscalationLabel(ticketKey);

  let summary = ticketKey, status = '', priority = '', assignee = 'Unassigned';
  try {
    const issue = await jiraRequest(
      `/rest/api/3/issue/${ticketKey}?fields=summary,status,priority,assignee`
    );
    summary = issue.fields?.summary || ticketKey;
    status = issue.fields?.status?.name || '';
    priority = issue.fields?.priority?.name || '';
    assignee = issue.fields?.assignee?.displayName || 'Unassigned';
  } catch (e) {
    console.warn(`[Jira] Could not fetch details for ${ticketKey}:`, e.message);
  }

  let known = {};
  try {
    const raw = db.getState('flagged_tickets');
    known = raw ? JSON.parse(raw) : {};
  } catch {}

  known[ticketKey] = {
    summary,
    status,
    priority,
    assignee,
    hasComment: false,
    flaggedAt: new Date().toISOString(),
    flaggedVia: 'neuro',
    note: note || null
  };

  db.setState('flagged_tickets', JSON.stringify(known));
  console.log(`[Jira] Ticket ${ticketKey} flagged via NEURO`);
  return { ok: true, key: ticketKey, summary };
}

// Unflag a ticket — removes label from Jira and local store
async function unflagTicket(ticketKey) {
  await removeEscalationLabel(ticketKey);
  return { ok: true };
}

function removeFlaggedTicketLocal(ticketKey) {
  try {
    const raw = db.getState('flagged_tickets');
    const known = raw ? JSON.parse(raw) : {};
    delete known[ticketKey];
    db.setState('flagged_tickets', JSON.stringify(known));
  } catch {}
}

// Get all flagged tickets from local store
function getFlaggedTickets() {
  try {
    const raw = db.getState('flagged_tickets');
    const known = raw ? JSON.parse(raw) : {};
    return Object.entries(known).map(([key, v]) => ({ key, ...v }));
  } catch { return []; }
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
  stopPolling,
  fetchTicketDetails,
  fetchEscalationTickets,
  syncEscalations,
  markEscalationsSeen,
  getUnseenEscalationCount,
  fetchFlaggedTickets,
  addEscalationLabel,
  removeEscalationLabel,
  syncFlaggedTickets,
  flagTicket,
  unflagTicket,
  getFlaggedTickets
};
