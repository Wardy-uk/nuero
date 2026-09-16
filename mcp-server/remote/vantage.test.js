import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { inspectVantage, vantageRoot } from '../scripts/inspect-api.js';
import { vantageOperations, bindVantage, vantageTools } from './vantage-catalogue.js';
import * as policy from './vantage-policy.js';
import { createVantageBackend } from './backend.js';
import { createResultStore } from './results.js';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { redact } from './tools.js';

const base = { MCP_PUBLIC_URL: 'https://neuro.example/mcp', MCP_AUTH_ISSUER: 'https://auth.example/', MCP_AUTH_JWKS_URL: 'https://auth.example/jwks', MCP_AUTH_SUBJECT: 'nick', NEURO_API_TOKEN: 'neuro-test-secret', NEURO_VAULT_KEY: 'vault-test-secret', VANTAGE_PIN: 'vantage-test-pin' };
const config = readConfig(base);
const all = { scopes: ['neuro:read', 'neuro:write', 'neuro:action', 'neuro:admin'] };
const readOnly = { scopes: ['neuro:read'] };
const ok = async () => ({ format: 'json', data: { ok: true, data: [] }, backend_ok: true });
const tools = (cfg, api, auth = all) => Object.fromEntries(vantageTools(cfg, api, auth, createResultStore(), v => redact(v, cfg)).map(t => [t.name, t]));
async function listen(server, t) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('every VANTAGE route is inventoried; a new route cannot silently leave MCP behind', t => {
  if (!fs.existsSync(path.join(vantageRoot, 'server.js'))) return t.skip(`no VANTAGE checkout at ${vantageRoot} (set VANTAGE_REPO)`);
  const stored = JSON.parse(fs.readFileSync(new URL('./vantage-inventory.json', import.meta.url)));
  const contract = ({ line, description, ...op }) => op;
  assert.deepEqual(stored.map(contract), inspectVantage().map(contract));
});

test('every operation has an EXPLICIT tier, and the policy names nothing that does not exist', () => {
  assert.ok(vantageOperations.length >= 40);
  for (const op of vantageOperations) assert.ok(['read', 'write', 'action', 'admin'].includes(op.classification), `${op.id} is unclassified`);
  const ids = new Set(vantageOperations.map(o => o.id));
  for (const id of [...Object.keys(policy.classification), ...Object.keys(policy.actionQuery), ...policy.privateOperations, ...Object.keys(policy.paramEnums), ...Object.keys(policy.notes)]) assert.ok(ids.has(id), `policy names unknown operation ${id}`);
  // Anything that leaves VANTAGE must never be reachable with only a write scope.
  for (const id of ['vantage_post_findings_by_id_neuro', 'vantage_post_findings_auto_push', 'vantage_post_plan_by_id_task', 'vantage_post_plan_by_id_planner', 'vantage_post_findings_by_id_draft', 'vantage_post_coach_sessions_by_id_messages']) assert.equal(policy.classification[id], 'action', id);
  assert.equal(policy.classification.vantage_get_findings_auto_push, 'read');
  assert.equal(policy.classification.vantage_post_settings_pin, 'admin');
});

test('the private half is WITHHELD by default: discoverable, never fetched', async () => {
  const calls = [];
  const t1 = tools(config, async (...a) => { calls.push(a); return ok(); });
  const out = await t1.vantage_read.run({ operation: 'vantage_get_self' });
  assert.equal(out.status, 'withheld');
  assert.equal(calls.length, 0);
  const listed = (await t1.vantage_capabilities.run({ query: 'self', offset: 0, limit: 30, describe: false })).capabilities.find(c => c.operation === 'vantage_get_self');
  assert.match(listed.withheld, /VANTAGE_MCP_PRIVATE/);
  // Non-private reads are unaffected.
  assert.equal((await t1.vantage_read.run({ operation: 'vantage_get_findings' })).status, 'completed');
  assert.equal(calls.length, 1);
  // Nick's explicit switch releases it.
  const opened = tools(readConfig({ ...base, VANTAGE_MCP_PRIVATE: 'true' }), async (...a) => { calls.push(a); return ok(); });
  assert.equal((await opened.vantage_read.run({ operation: 'vantage_get_self' })).status, 'completed');
  assert.equal(calls.length, 2);
});

test('a refresh switch is refused on the read tool, not silently dropped', async () => {
  const calls = [];
  const t1 = tools(config, async (route) => { calls.push(route); return ok(); });
  await assert.rejects(t1.vantage_read.run({ operation: 'vantage_get_radar', query: { refresh: '1' } }), { code: 'refresh_requires_vantage_action' });
  assert.equal(calls.length, 0);
  assert.equal((await t1.vantage_read.run({ operation: 'vantage_get_radar', query: { refresh: '0' } })).status, 'completed');
  assert.equal((await t1.vantage_action.run({ operation: 'vantage_get_radar', query: { refresh: '1' } })).status, 'completed');
  assert.deepEqual(calls, ['/api/radar?refresh=0', '/api/radar?refresh=1']);
  // The action tool must not become a back door for plain reads.
  await assert.rejects(t1.vantage_action.run({ operation: 'vantage_get_radar' }), { code: 'wrong_operation_classification' });
  // Nor can a read-tier token run an action.
  const ro = tools(config, async () => ok(), readOnly);
  await assert.rejects(ro.vantage_action.run({ operation: 'vantage_post_plan_by_id_task', params: { id: 'A1' }, body: {} }), { code: 'insufficient_scope' });
});

test('binding: fixed routes, closed enums, injection and credentials refused', () => {
  for (const op of vantageOperations) {
    const params = Object.fromEntries(op.params.map(k => [k, policy.paramEnums[op.id]?.[k]?.[0] ?? '7']));
    const bound = bindVantage(op.id, { params });
    assert.ok(bound.route.startsWith('/api/') && !bound.route.includes(':'));
  }
  assert.throws(() => bindVantage('vantage_post_settings_test_by_what', { params: { what: 'shell' } }));
  for (const bad of ['..', 'a/b', 'a\\b']) assert.throws(() => bindVantage('vantage_put_findings_by_id', { params: { id: bad } }));
  assert.throws(() => bindVantage('vantage_get_findings', { query: { pin: 'x' } }));
  assert.throws(() => bindVantage('get_tasks', {}), { code: 'unknown_operation' });
});

test('real HTTP: VANTAGE gets its PIN and never NEURO credentials; the PIN never comes back', async t => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, data: [{ id: 1, note: 'echo vantage-test-pin' }] }));
  });
  const url = await listen(upstream, t);
  const cfg = readConfig({ ...base, VANTAGE_API_URL: url });
  const out = await tools(cfg, createVantageBackend(cfg)).vantage_read.run({ operation: 'vantage_get_findings', query: { status: 'open' } });
  assert.equal(seen[0]['x-vantage-pin'], 'vantage-test-pin');
  assert.equal(seen[0]['x-neuro-api-token'], undefined);
  assert.equal(seen[0]['x-api-key'], undefined);
  assert.ok(!out.result.text.includes('vantage-test-pin'));
  // Unconfigured refuses before the network.
  const bare = readConfig({ ...base, VANTAGE_API_URL: url, VANTAGE_PIN: '' });
  await assert.rejects(createVantageBackend(bare)('/api/findings'), { code: 'vantage_not_configured' });
  assert.equal(seen.length, 1);
});

test('an MCP client discovers the vantage tools beside NEURO\'s', async t => {
  const upstream = http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true,"data":[]}'); });
  const up = await listen(upstream, t);
  const cfg = readConfig({ ...base, VANTAGE_API_URL: up, NEURO_API_URL: up });
  const url = await listen(http.createServer(createApp(cfg, { verify: async () => all, log: () => {} })), t);
  const client = new Client({ name: 'vantage-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer test', Host: 'neuro.example' } } }));
  t.after(() => client.close());
  const names = (await client.listTools()).tools.map(v => v.name);
  for (const name of ['vantage_capabilities', 'vantage_read', 'vantage_write', 'vantage_action', 'vantage_admin', 'neuro_read']) assert.ok(names.includes(name), name);
  const res = await client.callTool({ name: 'vantage_read', arguments: { operation: 'vantage_get_plan' } });
  assert.equal(res.isError, undefined);
  assert.equal(res.structuredContent.status, 'completed');
});

// Nick enabled the private half for his gateway (16 Sep 2026). What that switch
// must NOT buy: reading his coaching data does not imply writing, acting or
// sending, and none of it may surface anywhere a token is not required.
test('private released: a read-only token reads it, and gains nothing else', async () => {
  const cfg = readConfig({ ...base, VANTAGE_MCP_PRIVATE: 'true' });
  const calls = [];
  const ro = tools(cfg, async route => { calls.push(route); return { format: 'json', data: { ok: true, data: { note: 'private coaching observation' } }, backend_ok: true }; }, readOnly);
  for (const operation of ['vantage_get_coach_brief', 'vantage_get_coach_sessions', 'vantage_get_self', 'vantage_get_observations']) assert.equal((await ro[`vantage_read`].run({ operation })).status, 'completed', operation);
  assert.equal(calls.length, 4);
  await assert.rejects(ro.vantage_write.run({ operation: 'vantage_post_observations', body: { text: 'x' } }), { code: 'insufficient_scope' });
  await assert.rejects(ro.vantage_action.run({ operation: 'vantage_post_coach_sessions_by_id_messages', params: { id: '1' }, body: { content: 'x' } }), { code: 'insufficient_scope' });
  await assert.rejects(ro.vantage_action.run({ operation: 'vantage_post_findings_by_id_neuro', params: { id: '1' }, body: {} }), { code: 'insufficient_scope' });
  assert.equal(calls.length, 4, 'a refused write or action must never reach VANTAGE');
});

test('private released: nothing without a token reaches VANTAGE or returns its data', async t => {
  const hits = [];
  const upstream = http.createServer((req, res) => { hits.push(req.url); res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true,"data":{"note":"PRIVATE-MARKER"}}'); });
  const up = await listen(upstream, t);
  const cfg = readConfig({ ...base, VANTAGE_MCP_PRIVATE: 'true', VANTAGE_API_URL: up, NEURO_API_URL: up });
  const url = await listen(http.createServer(createApp(cfg, { verify: async () => { throw Object.assign(new Error('no'), { reason: 'invalid_token' }); }, log: () => {} })), t);
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vantage_read', arguments: { operation: 'vantage_get_self' } } };
  for (const [path, init] of [
    ['/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(call) }],
    ['/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer forged' }, body: JSON.stringify(call) }],
    ['/health', {}], ['/health/ready', {}], ['/.well-known/oauth-protected-resource/mcp', {}], ['/vantage/api/self', {}], ['/api/self', {}],
  ]) {
    const res = await fetch(url + path, init);
    assert.ok(!(await res.text()).includes('PRIVATE-MARKER'), path);
  }
  assert.deepEqual(hits, [], 'no unauthenticated request may reach an upstream');
});

