// NOVA snapshot bridge — bounded read-only seam into the NOVA KPI backend.
//
// Mirrors neuroSnapshot.js: polls a small set of NOVA endpoints, caches the latest
// successful payloads, exposes the snapshot synchronously for stateEngine#buildNova to
// fold into model.nova. Makes NO decisions and owns NO shared state.
//
// AUTH: NOVA (daypilot) gates /api/* behind a JWT Bearer token (middleware/auth.ts:
// `jwt.verify(token, secret)`). So NOVA_API_TOKEN must be a valid NOVA JWT; without it
// the API returns 401 "Not authenticated" and the At Work cards stay honestly empty.
// (NOVA also exposes PUBLIC routes mounted before the auth gate — /api/public/wallboard
// and /api/neuro-bridge — which may be a cleaner token-free integration path to explore.)

const NOVA_SOURCE = 'nova';
const DEFAULT_BASE_URL = 'https://nova.nurtur.tech';

const ENDPOINTS = {
  // Pending AI approvals — the one AUTH-gated call (sara service-account JWT in
  // NOVA_API_TOKEN). Returns { ok, data: { items: [...], canInteract } }.
  approvals: '/api/approvals?status=pending',
  // Overdue + queue health come from NOVA's PUBLIC wallboard (no auth needed — the same
  // endpoints NOVA's own MCP uses). breached = per-agent SLA board; team-kpis = KPI RAG.
  breached: '/api/public/wallboard/breached',
  teamKpis: '/api/public/wallboard/team-kpis',
};

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function config(env = process.env) {
  return {
    baseUrl: trimSlash(env.NOVA_BASE_URL || DEFAULT_BASE_URL),
    token: env.NOVA_API_TOKEN || null, // a NOVA JWT (Bearer)
    pollMs: Number(env.SARA_NOVA_POLL_MS) || 60000,
    timeoutMs: Number(env.SARA_NOVA_TIMEOUT_MS) || 6000,
  };
}

function isConfigured(cfg = config()) {
  return Boolean(cfg.baseUrl);
}

function unavailable(reason, detail) {
  return {
    source: NOVA_SOURCE,
    available: false,
    reason,
    detail: detail || null,
    polledAt: null,
    data: { approvals: null, breached: null, teamKpis: null },
    errors: {},
  };
}

let snapshot = unavailable(isConfigured() ? 'awaiting-first-poll' : 'not-configured');

function getSnapshot() {
  return snapshot;
}

function buildUrl(baseUrl, path) {
  return new URL(path.startsWith('/') ? path : `/${path}`, `${baseUrl}/`).toString();
}

async function fetchJson(cfg, path) {
  const headers = { Accept: 'application/json' };
  // NOVA validates a JWT Bearer token; NOVA_API_TOKEN must be a valid NOVA JWT.
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const res = await fetch(buildUrl(cfg.baseUrl, path), {
    headers,
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

async function refresh() {
  const cfg = config();
  if (!isConfigured(cfg)) {
    snapshot = unavailable('not-configured', 'NOVA base URL is not set.');
    return snapshot;
  }

  const data = Object.fromEntries(Object.keys(ENDPOINTS).map((k) => [k, null]));
  const errors = {};
  await Promise.all(
    Object.entries(ENDPOINTS).map(async ([key, path]) => {
      try {
        data[key] = await fetchJson(cfg, path);
      } catch (error) {
        errors[key] = error.message;
      }
    })
  );

  const successes = Object.values(data).filter(Boolean).length;
  if (!successes) {
    // Most likely 401 without a NOVA JWT — surface it honestly.
    const first = Object.values(errors)[0] || `No NOVA endpoint readable from ${cfg.baseUrl}`;
    snapshot = unavailable(/401/.test(first) ? 'unauthorized' : 'unreachable', first);
    snapshot.errors = errors;
    return snapshot;
  }

  snapshot = {
    source: NOVA_SOURCE,
    available: true,
    reason: successes < Object.keys(ENDPOINTS).length ? 'partial' : null,
    detail: null,
    polledAt: new Date().toISOString(),
    data,
    errors,
  };
  return snapshot;
}

let timer = null;

function start() {
  if (timer) return true;
  const cfg = config();
  if (!isConfigured(cfg)) {
    console.log('[SARA NOVA] snapshot bridge idle — no base URL.');
    return false;
  }
  refresh().catch(() => {});
  timer = setInterval(() => refresh().catch(() => {}), cfg.pollMs);
  if (timer.unref) timer.unref();
  const auth = cfg.token ? 'with token' : 'NO token (expect 401)';
  console.log(`[SARA NOVA] snapshot polling every ${cfg.pollMs}ms against ${cfg.baseUrl} ${auth}`);
  return true;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function _setSnapshotForTest(next) {
  snapshot = next || unavailable('not-configured');
}

module.exports = {
  NOVA_SOURCE,
  ENDPOINTS,
  config,
  isConfigured,
  getSnapshot,
  refresh,
  start,
  stop,
  unavailable,
  buildUrl,
  _setSnapshotForTest,
};
