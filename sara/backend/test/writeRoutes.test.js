'use strict';

// Nothing that LEAVES THE BUILDING is reachable through sara/backend — including
// by a route mounted AHEAD of the allowlist.
//
// ⚠ Found 11 Sep 2026. `neuroProxy.test.js` proved the PROXY refuses
// `/api/actions/:id/approve`, and it did — but `server.js` mounted
// `routes/actions.js` before the proxy, and that router forwarded approve and
// reject to NEURO with SARA's own credential. Approving a queued action sends
// email as Nick. `routes/email.js` and `routes/jira.js` sat beside it, reading
// email-triage summaries and ticket details and writing (run triage, dismiss mail,
// mark escalations seen) to anything on the tailnet, on a server bound to 0.0.0.0
// with no auth of its own. The proxy's test could never see any of it, because it
// tested the proxy on its own. So these test the MOUNT LIST and the routers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const SERVER = path.join(__dirname, '..', 'server.js');

function serve(router, mount) {
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  const server = http.createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('⚠ server.js mounts no email or jira router ahead of the allowlist', () => {
  const src = fs.readFileSync(SERVER, 'utf8');
  // positive control: this is the file that wires the proxy
  assert.match(src, /app\.use\('\/api', neuroProxyRoute\)/);
  assert.doesNotMatch(src, /app\.use\('\/api\/email'/);
  assert.doesNotMatch(src, /app\.use\('\/api\/jira'/);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'routes', 'email.js')), false);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'routes', 'jira.js')), false);
});

test('⚠ the actions router has NO approve, reject or pending-list route', async () => {
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => { seen.push(url); return realFetch(url, init); };
  const server = await serve(require('../src/routes/actions'), '/api/actions');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [method, p] of [['POST', '/api/actions/12/approve'], ['POST', '/api/actions/12/reject'], ['GET', '/api/actions']]) {
      const res = await realFetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      assert.equal(res.status, 404, `${method} ${p} still answers`);
    }
    // The one write kept is internal and reversible (a suppression timer), and it
    // still validates rather than forwarding blind.
    const kept = await realFetch(base + '/api/actions/focus/dismiss', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(kept.status, 400);
  } finally {
    server.close();
    global.fetch = realFetch;
  }
  assert.equal(seen.filter((u) => !String(u).startsWith(base)).length, 0, 'a refused route still reached NEURO');
});

test('⚠ the kiosk frontend holds no approve/reject call to bring the route back for', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'state', 'saraState.jsx'), 'utf8');
  assert.match(src, /\/api\/actions\/focus\/dismiss/); // positive control
  assert.doesNotMatch(src, /\/approve`|\/reject`/);
});
