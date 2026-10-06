'use strict';

/**
 * "Is the provider answering NOW?" — the one network read an investigation
 * may make (Build 15K), kept OUT of investigations.js on purpose: that module
 * is pinned never to import a personal-data service or call fetch.
 *
 * Narrow by construction, and pinned by self-heal.test.js:
 *   • only the retryable pull sources have a check;
 *   • exactly two fixed URLs — Home Assistant's `/api/` and Graph's
 *     `/me?$select=id` — no parameters from anywhere;
 *   • it reads the STATUS CODE only, never a response body;
 *   • one attempt, bounded by a timeout, never throws.
 *
 * Returns { answering: true | false | null, auth: 'refused' | null, status }.
 */

const TIMEOUT_MS = 1800;
const HA_PATH = '/api/';
const GRAPH_URL = 'https://graph.microsoft.com/v1.0/me?$select=id';

function classify(status) {
  if (status >= 200 && status < 300) return { answering: true, auth: null, status };
  if (status === 401 || status === 403) return { answering: null, auth: 'refused', status };
  return { answering: false, auth: null, status };
}

async function check(sourceId, { fetchImpl = global.fetch, getToken = () => require('./microsoft').getAccessToken() } = {}) {
  try {
    if (sourceId === 'neuro.selftest') {
      // The canary's provider is this process: answering the probe IS the answer.
      return { answering: true, auth: null, status: 'in-process' };
    }
    if (sourceId === 'homeassistant.presence') {
      const url = (process.env.HA_URL || 'http://localhost:8123').replace(/\/$/, '');
      if (!process.env.HA_TOKEN) return { answering: null, auth: null, status: 'not-configured' };
      const r = await fetchImpl(`${url}${HA_PATH}`, { headers: { Authorization: `Bearer ${process.env.HA_TOKEN}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return classify(r.status);
    }
    if (sourceId === 'microsoft.calendar') {
      const token = await getToken();
      if (!token) return { answering: null, auth: 'refused', status: 'no-token' };
      const r = await fetchImpl(GRAPH_URL, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return classify(r.status);
    }
    return { answering: null, auth: null, status: 'no-check-for-source' };
  } catch (e) {
    return { answering: false, auth: null, status: /timeout|abort/i.test(String((e && e.name) || e)) ? 'timeout' : 'unreachable' };
  }
}

module.exports = { TIMEOUT_MS, HA_PATH, GRAPH_URL, classify, check };
