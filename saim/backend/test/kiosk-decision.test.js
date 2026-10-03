// Build 10I — the kiosk renders NEURO's decision; it has no decision of its own.
//
// The kiosk used to run a second engine (stateEngine / inference / seed) that
// ranked an "urgent snapshot" beside NEURO's attention decision. That stack is
// retired. What is pinned here:
//   1. the attention passthrough hands NEURO's ranking over UNCHANGED — order,
//      urgency and suppression are NEURO's, not the kiosk's;
//   2. the new /context passthrough (the banner's one question) keeps the same
//      failure vocabulary, so "NEURO is down" and "misconfigured" stay distinct;
//   3. none of the retired routes is mounted, and their files are gone.
//
//   run: npm test   (from saim/backend)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const { createRouter } = require('../src/routes/attention');

const CONFIGURED = { NEURO_BASE_URL: 'http://neuro.test:3001', NEURO_API_TOKEN: 'tok' };

function serve(options) {
  const app = express();
  app.use('/api/attention', createRouter(options));
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, get: async (p) => { const res = await fetch(base + p); return { status: res.status, body: await res.json() }; } });
    });
  });
}

const reply = (body, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('16. the kiosk does not re-rank: NEURO\'s order, urgency and suppression arrive unchanged', async () => {
  // Deliberately "wrong" by any local heuristic: a low card leads, a critical
  // one is second, and one is held. A client that re-sorted would move them.
  const decision = {
    generatedAt: '2026-10-03T10:00:00.000Z',
    primary: { kind: 'item', id: 'a', title: 'Low thing NEURO chose', urgency: 'low' },
    // ⚠ Medium BEFORE critical: any urgency sort would swap these, so the test
    // cannot pass when the kiosk re-ranks (the first fixture could — a mutation
    // that sorted by urgency left critical-then-medium exactly as it was).
    secondary: [{ kind: 'item', id: 'c', title: 'Medium second', urgency: 'medium' }, { kind: 'item', id: 'b', title: 'Critical third', urgency: 'critical' }],
    dropped: [{ id: 'd', why: 'in a meeting' }],
    quiet: true,
    poolAvailable: true,
  };
  const h = await serve({ env: CONFIGURED, fetchImpl: reply(decision) });
  try {
    const { body } = await h.get('/api/attention');
    assert.equal(body.available, true);
    assert.equal(body.primary.id, 'a');
    assert.deepEqual(body.secondary.map((s) => s.id), ['c', 'b']);
    assert.deepEqual(body.dropped, decision.dropped);
    assert.equal(body.quiet, true, 'the interrupt decision is NEURO\'s');
  } finally { h.server.close(); }
});

test('the banner\'s context read: live when NEURO answers, named reasons when it does not', async () => {
  const live = await serve({ env: CONFIGURED, fetchImpl: reply({ context: { activity: 'steady', label: 'Steady' }, gaps: [] }) });
  try {
    const { body } = await live.get('/api/attention/context');
    assert.equal(body.available, true);
    assert.equal(body.context.label, 'Steady');
  } finally { live.server.close(); }

  const unconfigured = await serve({ env: {}, fetchImpl: async () => { throw new Error('must not be called'); } });
  try {
    const { body } = await unconfigured.get('/api/attention/context');
    assert.equal(body.available, false);
    assert.equal(body.reason, 'not-configured', 'refused before the network');
  } finally { unconfigured.server.close(); }

  const down = await serve({ env: CONFIGURED, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  try {
    assert.equal((await down.get('/api/attention/context')).body.reason, 'unreachable');
  } finally { down.server.close(); }

  const odd = await serve({ env: CONFIGURED, fetchImpl: reply({ hello: 'login page' }) });
  try {
    assert.equal((await odd.get('/api/attention/context')).body.reason, 'unexpected-shape', 'a 200 that is not a context is not an answer');
  } finally { odd.server.close(); }
});

test('15. the retired engine is gone — not mounted, not on disk', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.match(server, /app\.use\('\/api', neuroProxyRoute\)/); // positive control
  for (const mount of ['/api/state', '/api/inference', '/api/focus', '/api/actions']) {
    assert.ok(!server.includes(`app.use('${mount}'`), `${mount} is still mounted`);
  }
  for (const f of ['src/state/stateEngine.js', 'src/state/inference.js', 'src/state/seed.js', 'src/state/provenance.js', 'src/state/contract.js',
    'src/routes/state.js', 'src/routes/inference.js', 'src/routes/focus.js', 'src/routes/actions.js']) {
    assert.equal(fs.existsSync(path.join(__dirname, '..', f)), false, `${f} is still on disk`);
  }
  // /api/health no longer builds a model to answer "is SAiM up?".
  const health = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'health.js'), 'utf8');
  assert.doesNotMatch(health, /stateEngine|buildModel/);
});
