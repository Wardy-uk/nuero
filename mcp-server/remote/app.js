import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createVerifier } from './auth.js';
import { createBackend, createVantageBackend } from './backend.js';
import { createToolServer } from './tools.js';
import { createResultStore } from './results.js';

export function createApp(config, { verify = createVerifier(config), api = createBackend(config), vantageApi = createVantageBackend(config), log = (event, fields = {}) => {
  const failed = event === 'authentication_failure' || (fields.code && fields.code !== 'ok') || fields.status >= 400;
  if (config.LOG_LEVEL === 'silent' || (config.LOG_LEVEL === 'error' && !failed)) return;
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }));
} } = {}) {
  const app = express();
  const resultStore = createResultStore();
  app.disable('x-powered-by');
  app.set('trust proxy', config.MCP_TRUST_PROXY === 'false' ? false : config.MCP_TRUST_PROXY);
  const publicUrl = new URL(config.MCP_PUBLIC_URL);
  const metadataUrl = `${publicUrl.origin}/.well-known/oauth-protected-resource/mcp`;
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Request-Id': req.requestId });
    res.on('finish', () => log('request', { request_id: req.requestId, method: req.method, status: res.statusCode }));
    const localHosts = ['127.0.0.1', 'localhost', '[::1]', 'gateway'];
    let host;
    try { host = new URL(`http://${req.headers.host}`).hostname; } catch { return res.status(400).json({ error: 'invalid_host' }); }
    if (host !== publicUrl.hostname && !localHosts.includes(host)) return res.status(403).json({ error: 'host_denied' });
    // HTTP is allowed only at the private origin. The ingress MUST redirect HTTP
    // to HTTPS. Never expose this listener to the internet.
    //
    // ⚠ CROSS-ORIGIN IS ALLOWED, AND THE HOST CHECK ABOVE IS WHY THAT IS SAFE.
    // This API authenticates with a Bearer token and nothing else: no cookie, no
    // session, and Access-Control-Allow-Credentials is NEVER sent, so a browser
    // attaches no ambient credential to a cross-origin call. A hostile page gets
    // the same 401 as anyone holding no token, and Origin buys nothing against a
    // caller that HAS one. The DNS-rebinding guard that does matter is Host,
    // which the browser sets and script cannot forge.
    //
    // Refusing cross-origin broke ChatGPT Web while leaving Claude Code working,
    // and the asymmetry is the whole diagnosis: Claude Code is a Node process and
    // sends no Origin at all, so it never met this line. ChatGPT is browser-based
    // and sends Origin: https://chatgpt.com, which 403'd BEFORE authentication
    // ran -- so the connector could not even reach the 401 that starts OAuth.
    // Measured against the live gateway, 15 Sep 2026.
    const origin = req.headers.origin;
    if (origin) res.set({
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      // Without Expose-Headers a browser HIDES WWW-Authenticate from the client,
      // so it can never read the challenge and never discovers the authorization
      // server. The 401 arrives looking like an unexplained failure, which is
      // exactly how "couldn't connect" reads on screen.
      'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id, X-Request-Id',
    });
    // A preflight carries no Authorization header by definition, so it must be
    // answered here rather than 401'd by the auth middleware below.
    if (req.method === 'OPTIONS') {
      res.set({
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id',
        'Access-Control-Max-Age': '600',
      });
      return res.status(204).end();
    }
    next();
  });
  app.use(rateLimit({ windowMs: 60000, limit: config.MCP_RATE_LIMIT, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'rate_limited' } }));
  app.get('/health', (_req, res) => res.json({ status: 'running' }));
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => res.json({
    resource: config.MCP_PUBLIC_URL, authorization_servers: [config.MCP_AUTH_ISSUER], scopes_supported: ['neuro:read', 'neuro:write', 'neuro:action', 'neuro:admin'], bearer_methods_supported: ['header'],
  }));
  const authorize = async (req, res, next) => {
    // The match is read OUTSIDE the try so "no Authorization header at all" can
    // be told apart from "a token that failed verification". That distinction is
    // the whole diagnosis when a client silently declines to start OAuth: a
    // client sending nothing is waiting to be challenged, while one sending a
    // stale token thinks it is already authenticated and never will be.
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
    try {
      if (!match) throw Object.assign(new Error('Unauthorized'), { reason: 'no_bearer_header' });
      if (match[1].length > 16000) throw Object.assign(new Error('Unauthorized'), { reason: 'token_too_large' });
      req.neuroAuth = await verify(match[1]); next();
    } catch (error) {
      // jose reports a failed claim in `code`; ours arrive as `reason`. Neither
      // carries a value, so this is safe to log.
      const reason = error?.reason || error?.code || 'invalid_token';
      log('authentication_failure', { request_id: req.requestId, reason });
      res.set('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}", scope="neuro:read neuro:write neuro:action neuro:admin", error="invalid_token"`);
      res.status(401).json({ error: 'unauthorized' });
    }
  };
  app.get('/health/ready', authorize, async (_req, res) => {
    const dependencies = await Promise.allSettled([api('/api/status'), api('/api/vault/list'), api('/api/signals')]);
    const [backend, vault, saim] = dependencies.map(r => r.status === 'fulfilled');
    res.status(backend && vault && saim ? 200 : 503).json({ status: backend && vault && saim ? 'ready' : 'degraded', backend, vault, saim });
  });
  app.use('/mcp', authorize);
  app.post('/mcp', express.json({ limit: '6mb' }), async (req, res) => {
    const server = createToolServer(config, api, req.neuroAuth, (event, fields) => log(event, { request_id: req.requestId, ...fields }), resultStore, vantageApi);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ error: 'mcp_request_failed' }); }
  });
  app.all('/mcp', (_req, res) => res.set('Allow', 'POST').status(405).json({ error: 'method_not_allowed' }));
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((error, _req, res, _next) => res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'invalid_request' }));
  return app;
}
