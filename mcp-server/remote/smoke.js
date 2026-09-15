import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const endpoint = new URL(process.env.MCP_PUBLIC_URL);
if (endpoint.protocol !== 'https:') throw new Error('Smoke test requires HTTPS');
if (!process.env.MCP_SMOKE_ACCESS_TOKEN) throw new Error('Set MCP_SMOKE_ACCESS_TOKEN to a short-lived OAuth access token');
const unauthorized = await fetch(endpoint, { method: 'POST' });
assert.equal(unauthorized.status, 401);
const client = new Client({ name: 'neuro-smoke', version: '1' });
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_SMOKE_ACCESS_TOKEN}` } } }));
  assert.equal((await client.listTools()).tools.length, 24);
  const result = await client.callTool({ name: 'presence_get', arguments: {} });
  assert.ok(!result.isError);
  console.log('PASS: HTTPS rejection, authenticated initialization, discovery and presence read');
} finally { await client.close(); }
