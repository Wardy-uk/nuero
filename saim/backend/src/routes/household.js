'use strict';

// The household half of the shared room screens (22 Oct 2026).
//
// Nick: the living room and the bedroom show the family wall (VESTA's cinema
// view) fused with SAiM, and they act as THE HOUSEHOLD — not as him. So the
// wall's reads and writes go to NEURO's public VESTA mount (`/api/v`) as the
// household account (`VESTA_SCREEN_ACCOUNT`, default `family`), never on his
// PIN: the same scopes, the same redaction and the same read-back the kitchen
// iPad has. Anything he would not want a visitor to see is absent from those
// answers before they leave NEURO.
//
// ⚠ THE BROWSER HOLDS NO TOKEN. The session is asked for here, from NEURO's
// `/api/capture-links/screen-session` with the kiosk's own credential, kept in
// memory, renewed from NEURO's `X-Vesta-Session` header, and asked for again on
// a 401. No PIN is stored for it anywhere.
//
// ⚠ A NAMED SET OF DOORS, NOT `/api/v`. The wall needs its read, the photos, the
// household jobs and the family calendar — nothing else on the public mount
// (the kitchen, the photo scan that spends money, the hike tracker) is reachable
// from a room screen.

const express = require('express');
const neuroConfig = require('../integrations/neuroConfig');

const DOORS = [
  { method: 'GET', re: /^\/wall$/ },
  { method: 'GET', re: /^\/photo\/[A-Za-z0-9_-]{1,80}$/ },
  { method: 'POST', re: /^\/tasks$/ },
  { method: 'PATCH', re: /^\/tasks\/[A-Za-z0-9_-]{1,80}$/ },
  { method: 'POST', re: /^\/family-calendar\/events$/ },
  { method: 'PATCH', re: /^\/family-calendar\/events\/[A-Za-z0-9_-]{1,200}$/ },
  { method: 'DELETE', re: /^\/family-calendar\/events\/[A-Za-z0-9_-]{1,200}$/ },
];

function isDoor(method, path) {
  const p = String(path || '');
  if (p.includes('..') || p.includes('\\')) return false;
  return DOORS.some((d) => d.method === method && d.re.test(p));
}

function createRouter(options = {}) {
  const router = express.Router();
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const env = options.env || process.env;
  const timeoutMs = Number(env.SAIM_NEURO_TIMEOUT_MS) || 60000;
  const account = String(env.VESTA_SCREEN_ACCOUNT || 'family').trim().toLowerCase();

  let token = null;
  let failedAt = 0;
  let lastError = null;

  async function session(force = false) {
    if (token && !force) return token;
    // A refused ask is not repeated for a minute: the screens poll, and a
    // revoked account must not turn into a request a second.
    if (!force && failedAt && Date.now() - failedAt < 60_000) return null;
    const base = neuroConfig.getBaseUrl(env);
    try {
      const r = await fetchImpl(`${base}/api/capture-links/screen-session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...neuroConfig.authHeaders(env) },
        body: JSON.stringify({ username: account }),
        signal: AbortSignal.timeout(10000),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok || !d.token) {
        token = null; failedAt = Date.now(); lastError = d.error || `HTTP ${r.status}`;
        return null;
      }
      token = d.token; failedAt = 0; lastError = null;
      return token;
    } catch (e) {
      token = null; failedAt = Date.now(); lastError = e.message;
      return null;
    }
  }

  async function forward(req, tok) {
    const base = neuroConfig.getBaseUrl(env);
    const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method);
    return fetchImpl(`${base}/api/v${req.url}`, {
      method: req.method,
      headers: {
        accept: req.path.startsWith('/photo/') ? 'image/*' : 'application/json',
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        // The browser's own Authorization (it has none) is never passed on.
        authorization: `Bearer ${tok}`,
      },
      body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  router.use(async (req, res) => {
    if (!isDoor(req.method, req.path)) {
      return res.status(403).json({ ok: false, error: 'The room screens do not open that.' });
    }
    const ready = neuroConfig.readiness(env);
    if (!ready.baseUrlConfigured || !ready.credentialConfigured) {
      return res.status(503).json({ ok: false, error: 'This screen has not been told where home is.' });
    }
    try {
      let tok = await session();
      if (!tok) return res.status(503).json({ ok: false, error: `This screen cannot sign in to the household right now (${lastError || 'no session'}).` });
      let upstream = await forward(req, tok);
      // A session that died (revoked and restored, re-keyed, expired): ask once
      // more, then give up and say so.
      if (upstream.status === 401) {
        tok = await session(true);
        if (!tok) return res.status(503).json({ ok: false, error: `This screen cannot sign in to the household right now (${lastError || 'no session'}).` });
        upstream = await forward(req, tok);
      }
      const fresh = upstream.headers.get('x-vesta-session');
      if (fresh) token = fresh;
      const body = Buffer.from(await upstream.arrayBuffer());
      res.status(upstream.status);
      res.type(upstream.headers.get('content-type') || 'application/json');
      // Photos are fetched once and kept by the browser.
      if (req.path.startsWith('/photo/')) res.set('cache-control', 'private, max-age=86400');
      return res.send(body);
    } catch (e) {
      const aborted = e.name === 'AbortError' || e.name === 'TimeoutError';
      return res.status(504).json({ ok: false, error: aborted ? 'No answer from home in time — it may or may not have saved.' : "I can't reach home right now." });
    }
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
module.exports.isDoor = isDoor;
