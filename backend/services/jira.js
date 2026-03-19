// Jira direct API calls removed — EPIPE crashes Node.js on Pi
// Tickets are now ingested via POST /api/queue/ingest from n8n
// This stub remains so existing require('./jira') calls don't break

function isConfigured() {
  // Jira is now fed externally via n8n ingest — always return false for direct config
  return false;
}

module.exports = {
  isConfigured
};
