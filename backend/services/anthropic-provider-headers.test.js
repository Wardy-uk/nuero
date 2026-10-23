'use strict';

/**
 * The REAL Anthropic SDK (no injected client) through the REAL provider and the
 * REAL Do this connection test, against a local capture server standing in for
 * api.anthropic.com (ANTHROPIC_BASE_URL). Proves what actually goes on the wire:
 *
 *  - every request carries `anthropic-version` — the value the installed SDK
 *    sets itself (read from the SDK, never restated here) — and the saved key in
 *    `x-api-key`, never ANTHROPIC_API_KEY;
 *  - the connection test sends ONE bounded request and reports Anthropic's own
 *    error type and message for a 400, with the key removed and no raw body.
 *
 * 24 Oct 2026: the live test failed with HTTP 400 and the header was suspected.
 * This is the check that settles it on the real client rather than a mock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anthropic-headers-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
process.env.ANTHROPIC_API_KEY = 'env-key-other-features-only';
process.env.AI_MODE = 'hybrid';
delete process.env.AI_GATE_MODE;

const KEY = 'sk-ant-api03-HEADER-test-key-WWWW-31z9q';
const seen = [];
let answer = null; // (req) => { status, body }
const server = http.createServer((req, res) => {
  let s = ''; req.on('data', (d) => { s += d; });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: s ? JSON.parse(s) : null });
    const a = answer ? answer(req) : { status: 200, body: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 31, output_tokens: 2 } } };
    res.writeHead(a.status, { 'content-type': 'application/json', 'request-id': 'req_test' });
    res.end(JSON.stringify(a.body));
  });
});

let db; let settings; let anthropic;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });
  db = require('../db/database');
  await db.init();
  settings = require('./task-agent-settings');
  anthropic = require('./providers/anthropic-provider');
  anthropic._internals.setClient(null); // the real SDK
  settings.save({ apiKey: KEY, dailyUsd: 5, dailyRuns: 10 });
});
test.after(async () => { await new Promise((r) => server.close(r)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

function sdkVersionHeader() {
  // The value the installed SDK itself sends — read from its source, not restated.
  const dir = path.dirname(require.resolve('@anthropic-ai/sdk'));
  for (const f of ['client.js', 'index.js', 'core.js']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, 'utf8').match(/'anthropic-version':\s*'([^']+)'/);
    if (m) return m[1];
  }
  return null;
}

test('the real SDK sends anthropic-version and the SAVED key on the connection test — one bounded request', async () => {
  const expected = sdkVersionHeader();
  assert.ok(expected, 'found the version the installed SDK sets');
  const n0 = seen.length;
  const r = await settings.testConnection({ confirm: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(seen.length, n0 + 1, 'exactly one request');
  const req = seen[seen.length - 1];
  assert.equal(req.method, 'POST');
  assert.match(req.url, /\/v1\/messages$/);
  assert.equal(req.headers['anthropic-version'], expected);
  assert.equal(req.headers['x-api-key'], KEY);
  assert.notEqual(req.headers['x-api-key'], process.env.ANTHROPIC_API_KEY);
  assert.ok(req.body.max_tokens <= 16, 'bounded output');
  assert.equal(r.promptTokens, 31);
  assert.equal(r.completionTokens, 2);
});

test('an ordinary provider call carries the header too', async () => {
  const n0 = seen.length;
  await anthropic.chat('sys', [{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-6', maxTokens: 20, callClass: 'chat_sync', apiKey: KEY });
  assert.equal(seen[n0].headers['anthropic-version'], sdkVersionHeader());
});

test('a real 400 from the API: Anthropic\'s type and message are reported, the key is not', async () => {
  answer = () => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: `max_tokens: something about ${KEY} is wrong` }, request_id: 'req_x' } });
  try {
    const r = await settings.testConnection({ confirm: true });
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, 400);
    assert.equal(r.anthropic.type, 'invalid_request_error');
    assert.match(r.anthropic.message, /^max_tokens: something about/);
    const out = JSON.stringify(r);
    assert.ok(!out.includes(KEY) && !out.includes(KEY.slice(-4)), 'no key, not even its last four');
    assert.equal(settings.read().enabled, false);
  } finally { answer = null; }
});
