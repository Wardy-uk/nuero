import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp } from './app.js';
import { createVerifier } from './auth.js';
import { createBackend } from './backend.js';
import { readConfig } from './config.js';
import { toolDefinitions } from './tools.js';

const config = readConfig({ MCP_PUBLIC_URL: 'https://neuro.example/mcp', MCP_AUTH_ISSUER: 'https://auth.example/', MCP_AUTH_JWKS_URL: 'https://auth.example/jwks', MCP_AUTH_SUBJECT: 'nick', NEURO_API_TOKEN: 'upstream-secret', NEURO_VAULT_KEY: 'vault-secret' });
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = await exportJWK(publicKey);
const verify = createVerifier(config, createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256' }] }));
const token = (overrides = {}) => new SignJWT({ scope: 'neuro:read neuro:write', ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(overrides.iss || config.MCP_AUTH_ISSUER).setAudience(overrides.aud || config.MCP_PUBLIC_URL).setSubject(overrides.sub || 'nick').setIssuedAt().setExpirationTime(overrides.exp || '5m').sign(privateKey);
async function listen(server, t) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, options = {}) {
  const calls = []; let mode = 'ok';
  const upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    calls.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined });
    if (mode === 'timeout') return;
    if (mode === 'failure') { res.writeHead(503); return res.end('upstream-secret vault-secret stack trace'); }
    if (mode === 'invalid') return res.end('{bad-json');
    if (mode === 'oversize') return res.end('x'.repeat(1024 * 1024 + 1));
    let data = {};
    if (req.url.startsWith('/api/vault/search')) data = { results: [{ path: 'Notes/Test.md', name: 'Test', score: 0.9, excerpts: ['hello vault-secret'] }], health: { status: 'ok' } };
    if (req.url.startsWith('/api/vault/read')) data = { content: 'hello memory' };
    if (req.url === '/api/vault/write') data = { success: true };
    if (req.url === '/api/capture/note') data = { success: true, verified: true, filename: 'capture.md', path: '/private/absolute/path' };
    if (req.url === '/api/capture/todo') data = { success: true, taskId: 8, vault: { written: false } };
    if (req.url === '/api/capture/recent') data = { items: [] };
    if (req.url === '/api/activity/today') data = { events: [{ id: 1, event_type: 'capture', created_at: '2026-09-15 12:00:00', event_data: 'note' }] };
    if (req.url === '/api/signals/room') data = { known: false, room: null, why: 'no observations', api_key: 'vault-secret' };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data));
  });
  const upstreamUrl = await listen(upstream, t);
  const localConfig = { ...config, NEURO_API_URL: upstreamUrl, MCP_UPSTREAM_TIMEOUT_MS: 100, ...options };
  const logs = [];
  const url = await listen(http.createServer(createApp(localConfig, { verify, log: (event, fields) => logs.push({ event, ...fields }) })), t);
  const accessToken = await token();
  const client = new Client({ name: 'integration-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  t.after(() => client.close());
  return { client, url, calls, logs, accessToken, mode: value => { mode = value; }, config: localConfig };
}

test('unauthenticated MCP and readiness are denied; metadata and liveness are public', async t => {
  const f = await fixture(t);
  for (const path of ['/mcp', '/health/ready']) {
    const r = await fetch(f.url + path); assert.equal(r.status, 401); assert.match(r.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
  }
  assert.deepEqual(await (await fetch(f.url + '/health')).json(), { status: 'running' });
  const metadata = await (await fetch(f.url + '/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(metadata.resource, config.MCP_PUBLIC_URL);
  assert.equal((await fetch(f.url + '/health/ready', { headers: { Authorization: `Bearer ${f.accessToken}` } })).status, 200);
});
test('real SDK initialize, discovery, read, write and stateless reconnect', async t => {
  const f = await fixture(t); const tools = (await f.client.listTools()).tools;
  assert.equal(tools.length, 24);
  assert.ok(tools.every(v => v.inputSchema && v.outputSchema && v.annotations));
  assert.ok(!tools.some(v => /delete|approve|shell|http_request/.test(v.name)));
  const read = await f.client.callTool({ name: 'memory_search', arguments: { query: 'hello' } });
  assert.equal(read.structuredContent.results[0].id, 'Notes/Test.md'); assert.doesNotMatch(JSON.stringify(read), /vault-secret/);
  const write = await f.client.callTool({ name: 'memory_create', arguments: { title: 'Test', content: 'Remember this' } });
  assert.equal(write.structuredContent.saved, true);
  assert.match(write.structuredContent.id, /^MCP Memories\/[0-9a-f-]+\.md$/);
  const call = f.calls.find(v => v.url === '/api/vault/write');
  assert.equal(call.headers['x-neuro-api-token'], 'upstream-secret'); assert.equal(call.headers.authorization, undefined);
  const second = new Client({ name: 'second-client', version: '1' });
  t.after(() => second.close());
  await second.connect(new StreamableHTTPClientTransport(new URL(f.url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${f.accessToken}` } } }));
  assert.equal((await second.listTools()).tools.length, tools.length);
  assert.doesNotMatch(JSON.stringify(f.logs), /Remember this|upstream-secret|vault-secret|Bearer/);
});
test('all tool adapters execute with typed output; unknown context stays unknown', async t => {
  const f = await fixture(t);
  for (const tool of toolDefinitions(config, () => {})) {
    const args = tool.name === 'memory_update' ? { id: 'MCP Memories/12345678-1234-1234-1234-123456789abc.md', content: 'Updated' }
      : tool.name === 'memory_get' ? { id: 'Notes/Test.md' }
      : ['memory_search', 'neuro_search', 'events_search'].includes(tool.name) ? { query: 'note' }
      : ['memory_create', 'capture_memory', 'capture_note'].includes(tool.name) ? { title: 'Test', content: 'Test content' }
      : tool.name === 'capture_task' ? { text: 'Task' } : {};
    const result = await f.client.callTool({ name: tool.name, arguments: args });
    assert.equal(result.isError, undefined, `${tool.name}: ${JSON.stringify(result)}`);
    tool.output.parse(result.structuredContent);
    if (tool.name === 'presence_get') assert.equal(result.structuredContent.evidence.known, false);
    if (tool.name === 'capture_task') assert.equal(result.structuredContent.partial, true);
    if (tool.name === 'events_recent') assert.equal(result.structuredContent.results[0].timestamp, '2026-09-15T12:00:00Z');
  }
});
test('invalid inputs, traversal, unknown fields and out-of-scope updates fail before writes', async t => {
  const f = await fixture(t);
  for (const [name, args] of [['memory_search', { query: '', limit: 999 }], ['memory_get', { id: '../private.md' }], ['capture_note', { title: 'Test', content: 'body', extra: true }], ['memory_update', { id: 'Personal/private.md', content: 'replace' }]]) {
    const result = await f.client.callTool({ name, arguments: args }); assert.equal(result.isError, true);
  }
  assert.equal(f.calls.length, 0);
});
test('OAuth signature, issuer, audience, subject, expiry and scopes enforced', async t => {
  const f = await fixture(t);
  for (const bad of ['garbage', await token({ aud: 'https://other/' }), await token({ iss: 'https://other/' }), await token({ sub: 'other-user' }), await token({ exp: 1 }), await token({ scope: 'neuro:write' })]) {
    assert.equal((await fetch(f.url + '/mcp', { headers: { Authorization: `Bearer ${bad}` } })).status, 401);
  }
  const readClient = new Client({ name: 'read-only', version: '1' }); t.after(() => readClient.close());
  await readClient.connect(new StreamableHTTPClientTransport(new URL(f.url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${await token({ scope: 'neuro:read' })}` } } }));
  const denied = await readClient.callTool({ name: 'capture_note', arguments: { title: 'Test', content: 'body' } });
  assert.equal(denied.isError, true); assert.match(denied.content[0].text, /insufficient_scope/); assert.equal(f.calls.length, 0);
});
test('backend failure, timeout, malformed JSON and oversized responses have safe errors', async t => {
  const f = await fixture(t);
  for (const [mode, code] of [['failure', 'backend_unavailable'], ['timeout', 'backend_timeout'], ['invalid', 'backend_unavailable'], ['oversize', 'backend_response_too_large']]) {
    f.mode(mode);
    const result = await f.client.callTool({ name: 'memory_get', arguments: { id: 'Notes/Test.md' } });
    assert.equal(result.isError, true); assert.match(result.content[0].text, new RegExp(code));
    assert.doesNotMatch(JSON.stringify(result), /upstream-secret|vault-secret|stack trace/);
  }
  f.mode('failure');
  assert.equal((await fetch(f.url + '/health/ready', { headers: { Authorization: `Bearer ${f.accessToken}` } })).status, 503);
});
test('origin, malformed bodies and body limits enforced', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.url + '/mcp', { headers: { Origin: 'https://evil.example' } })).status, 403);
  const hostileStatus = await new Promise((resolve, reject) => {
    http.get(f.url + '/health', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(hostileStatus, 403);
  const headers = { Authorization: `Bearer ${f.accessToken}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(f.url + '/mcp', { method: 'POST', headers, body: '{bad' })).status, 400);
  assert.equal((await fetch(f.url + '/mcp', { method: 'POST', headers, body: JSON.stringify({ data: 'x'.repeat(7 * 1024 * 1024) }) })).status, 413);
});
test('rate limit returns 429', async t => {
  const url = await listen(http.createServer(createApp({ ...config, MCP_RATE_LIMIT: 2 }, { verify, log: () => {} })), t);
  await fetch(url + '/health'); await fetch(url + '/health');
  assert.equal((await fetch(url + '/health')).status, 429);
});
test('configuration rejects insecure public URLs, missing identity and credentials', () => {
  for (const override of [{ MCP_PUBLIC_URL: 'http://example/mcp' }, { MCP_AUTH_SUBJECT: '' }, { NEURO_API_TOKEN: '', NEURO_PIN: '' }, { MCP_MEMORY_DIR: '../secret' }]) assert.throws(() => readConfig({ ...config, ...override }));
});
test('legacy stdio discovery still works with updated locked dependencies', async t => {
  const client = new Client({ name: 'legacy-regression', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['index.js'], stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(v => v.name);
  for (const name of ['get_focus', 'search_vault', 'read_note', 'create_task', 'get_health']) assert.ok(names.includes(name));
});
test('partial context, bounded evidence and retrieval coverage are explicit', async () => {
  const api = async route => {
    if (route === '/api/device/status') throw new Error('upstream failed');
    if (route.startsWith('/api/vault/search')) return { results: [], health: { semanticAvailable: true, keywordComplete: true, semanticCoverageComplete: true, truncated: false } };
    return { known: false, observations: Array.from({ length: 50 }, () => 'x'.repeat(1000)) };
  };
  const tools = toolDefinitions(config, api);
  const context = await tools.find(v => v.name === 'context_current').run({});
  assert.equal(context.evidence.device.available, false);
  assert.equal(context.truncated, true);
  assert.ok(JSON.stringify(context).length < 23000);
  const result = await tools.find(v => v.name === 'memory_search').run({ query: 'test', limit: 5 });
  assert.equal(result.partial, false); assert.deepEqual(result.results, []);
  const unverified = toolDefinitions(config, async () => ({ results: [] }));
  assert.equal((await unverified.find(v => v.name === 'memory_search').run({ query: 'test', limit: 5 })).partial, true);
});
