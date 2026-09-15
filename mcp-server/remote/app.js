import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createVerifier } from './auth.js';
import { createBackend } from './backend.js';
import { createToolServer } from './tools.js';
import { createResultStore } from './results.js';

export function createApp(config, { verify = createVerifier(config), api = createBackend(config), log = (event, fields = {}) => {
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
    if (req.headers.origin && req.headers.origin !== publicUrl.origin) return res.status(403).json({ error: 'origin_denied' });
    next();
  });
  app.use(rateLimit({ windowMs: 60000, limit: config.MCP_RATE_LIMIT, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'rate_limited' } }));
  app.get('/health', (_req, res) => res.json({ status: 'running' }));
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => res.json({
    resource: config.MCP_PUBLIC_URL, authorization_servers: [config.MCP_AUTH_ISSUER], scopes_supported: ['neuro:read', 'neuro:write', 'neuro:action', 'neuro:admin'], bearer_methods_supported: ['header'],
  }));
  const authorize = async (req, res, next) => {
    try {
      const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
      if (!match || match[1].length > 16000) throw new Error('Unauthorized');
      req.neuroAuth = await verify(match[1]); next();
    } catch {
      log('authentication_failure', { request_id: req.requestId });
      res.set('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}", scope="neuro:read", error="invalid_token"`);
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
    const server = createToolServer(config, api, req.neuroAuth, (event, fields) => log(event, { request_id: req.requestId, ...fields }), resultStore);
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
