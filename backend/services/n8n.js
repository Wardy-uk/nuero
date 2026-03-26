const https = require('https');
const http = require('http');

const N8N_API_URL = process.env.N8N_API_URL || 'https://n8n-dashboard.nurtur-ai.app';
const N8N_API_KEY = process.env.N8N_API_KEY;

// SUB - Performance Review Snapshot workflow ID
const WORKFLOW_121_ID = '8jHDT26KA6nf4QGD';

function isConfigured() {
  return !!N8N_API_KEY;
}

function httpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${N8N_API_URL}${path}`);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;

    const payload = body ? JSON.stringify(body) : null;

    const headers = { 'X-N8N-API-KEY': N8N_API_KEY };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers
    };

    const req = mod.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`n8n API ${res.statusCode}: ${data.substring(0, 500)}`));
          return;
        }
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: true }); }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('n8n API timeout')); });

    if (payload) req.write(payload);
    req.end();
  });
}

// Backwards-compatible POST helper
function apiCall(path, body) { return httpRequest('POST', path, body); }
function apiGet(path) { return httpRequest('GET', path); }

// --- Extract draft data from n8n execution result ---
function extractDraftFromExecution(execData) {
  // Try multiple paths — n8n response structure varies
  const runData = execData?.data?.resultData?.runData
    || execData?.resultData?.runData
    || {};

  const formatNode = runData['Format Performance Review Email'];
  if (formatNode?.[0]?.data?.main?.[0]?.[0]?.json) {
    return formatNode[0].data.main[0][0].json;
  }
  return null;
}

function extractExecutionId(result) {
  return result?.data?.executionId
    || result?.executionId
    || result?.data?.id
    || result?.id
    || '';
}

// --- Poll n8n execution API until draft is available ---
function pollForDraft(executionId, nameHint) {
  let attempts = 0;
  const maxAttempts = 36; // 36 * 5s = 3 minutes

  const poll = async () => {
    attempts++;
    if (attempts > maxAttempts) {
      console.log(`[n8n] Polling timeout for execution ${executionId} after ${maxAttempts} attempts`);
      return;
    }

    try {
      const exec = await apiGet(`/api/v1/executions/${executionId}`);
      const waitTill = exec?.waitTill || exec?.data?.waitTill;
      const status = exec?.status || exec?.data?.status;

      if (waitTill || status === 'waiting') {
        // Execution paused at Wait node — extract draft
        const draftData = extractDraftFromExecution(exec);
        if (draftData) {
          addPendingApproval({
            agentName: draftData.agentName || nameHint,
            agentEmail: draftData.agentEmail || '',
            subject: draftData.subject || draftData.draftSubject || '',
            draftHtml: draftData.draftHtml || draftData.html || '',
            markdown: draftData.markdown || '',
            executionId,
          });
          console.log(`[n8n] Draft captured via polling for ${nameHint} (execution ${executionId})`);
          return;
        }
      }

      if (status === 'error' || status === 'crashed' || status === 'canceled') {
        console.log(`[n8n] Execution ${executionId} ended with status: ${status}`);
        return;
      }

      // Still running — poll again
      setTimeout(poll, 5000);
    } catch (e) {
      console.log(`[n8n] Poll error for ${executionId}: ${e.message}`);
      if (attempts < maxAttempts) setTimeout(poll, 5000);
    }
  };

  // First poll after 10s (give workflow time to run DB queries + AI)
  setTimeout(poll, 10000);
}

// --- Main trigger ---
async function run121Snapshot(nameHint) {
  // Use the webhook URL directly (the /api/v1/workflows/{id}/run endpoint is not available)
  const result = await httpRequest('POST', '/webhook/perf-review-121', { nameHint });

  // Webhook returns immediately — need to find the executionId from recent executions
  let executionId = extractExecutionId(result);

  // If webhook didn't return an executionId, fetch the most recent execution for this workflow
  if (!executionId) {
    try {
      const execList = await apiGet(`/api/v1/executions?workflowId=${WORKFLOW_121_ID}&limit=1&status=running`);
      const latest = execList?.data?.[0] || execList?.results?.[0] || execList?.[0];
      if (latest) executionId = latest.id;
    } catch (e) {
      console.log('[n8n] Could not fetch recent executions:', e.message);
    }
  }

  // Try to extract draft from synchronous response (unlikely with webhook trigger)
  const draftData = extractDraftFromExecution(result);

  if (draftData && executionId) {
    addPendingApproval({
      agentName: draftData.agentName || nameHint,
      agentEmail: draftData.agentEmail || '',
      subject: draftData.subject || draftData.draftSubject || '',
      draftHtml: draftData.draftHtml || draftData.html || '',
      markdown: draftData.markdown || '',
      executionId,
    });
    return { success: true, message: `Review generated for ${nameHint}. Check the approval panel.` };
  }

  // Draft not in response — start background polling
  if (executionId) {
    console.log(`[n8n] Execution ${executionId} started, polling for draft...`);
    pollForDraft(executionId, nameHint);
    return { success: true, message: `Review triggered for ${nameHint}. It will appear in your approval panel shortly.` };
  }

  return { success: true, message: `Workflow triggered for ${nameHint}, but could not track execution.` };
}

// --- In-memory pending approval store ---
const pendingApprovals = new Map();

function addPendingApproval(data) {
  const id = `approval-${Date.now()}`;
  const entry = {
    id,
    agentName: data.agentName || '',
    agentEmail: data.agentEmail || '',
    subject: data.subject || '',
    draftHtml: data.draftHtml || '',
    markdown: data.markdown || '',
    executionId: data.executionId || '',
    receivedAt: new Date().toISOString(),
  };
  pendingApprovals.set(id, entry);
  console.log(`[n8n] Pending approval stored: ${id} for ${entry.agentName}`);
  return entry;
}

function getPendingApprovals() {
  return Array.from(pendingApprovals.values()).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

function getPendingApproval(id) {
  return pendingApprovals.get(id) || null;
}

function removePendingApproval(id) {
  return pendingApprovals.delete(id);
}

async function submitApproval(id, formData) {
  const approval = pendingApprovals.get(id);
  if (!approval) throw new Error('Approval not found');
  if (!approval.executionId) throw new Error('No executionId — cannot resume workflow');

  // POST to n8n Wait webhook to resume the workflow
  const resumePath = `/webhook-waiting/${approval.executionId}`;
  await apiCall(resumePath, {
    agentEmail: formData.agentEmail || approval.agentEmail,
    agentName: formData.agentName || approval.agentName,
    additionalSteps: formData.additionalSteps || '',
    worstQaCount: formData.worstQaCount || 0,
  });

  pendingApprovals.delete(id);
  console.log(`[n8n] Approval submitted and workflow resumed: ${id}`);
  return { success: true };
}

module.exports = {
  isConfigured,
  run121Snapshot,
  addPendingApproval,
  getPendingApprovals,
  getPendingApproval,
  removePendingApproval,
  submitApproval,
};
