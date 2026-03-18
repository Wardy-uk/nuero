const https = require('https');
const http = require('http');

const N8N_API_URL = process.env.N8N_API_URL || 'https://n8n-dashboard.nurtur-ai.app';
const N8N_API_KEY = process.env.N8N_API_KEY;

// SUB - Performance Review Snapshot workflow ID
const WORKFLOW_121_ID = '8jHDT26KA6nf4QGD';

function isConfigured() {
  return !!N8N_API_KEY;
}

function apiCall(path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${N8N_API_URL}${path}`);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;

    const payload = JSON.stringify(body);

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-N8N-API-KEY': N8N_API_KEY
      }
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
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('n8n API timeout')); });

    req.write(payload);
    req.end();
  });
}

async function run121Snapshot(nameHint) {
  await apiCall(`/api/v1/workflows/${WORKFLOW_121_ID}/run`, {
    runData: {
      'NICK-AGENT Webhook': [{ json: { nameHint } }]
    },
    startNodes: ['NICK-AGENT Webhook']
  });
  return { success: true, message: `1-2-1 snapshot triggered for ${nameHint}. Check your email for the draft preview.` };
}

module.exports = {
  isConfigured,
  run121Snapshot
};
