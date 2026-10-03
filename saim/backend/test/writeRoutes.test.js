'use strict';

// Nothing that LEAVES THE BUILDING is reachable through saim/backend — including
// by a route mounted AHEAD of the allowlist.
//
// ⚠ Found 11 Sep 2026. `neuroProxy.test.js` proved the PROXY refuses
// `/api/actions/:id/approve`, and it did — but `server.js` mounted
// `routes/actions.js` before the proxy, and that router forwarded approve and
// reject to NEURO with SAiM's own credential. Approving a queued action sends
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

test('⚠ there is no actions router at all (Build 10I) — nothing to approve through', () => {
  // It used to keep one write — POST /focus/dismiss, a suppression timer on the
  // retired /api/focus. With that retired there is nothing left for the router
  // to do, so it is gone, and with it any route that could grow an approve.
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'routes', 'actions.js')), false);
  const src = fs.readFileSync(SERVER, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(src, /app\.use\('\/api\/actions'/);
});

test('⚠ the kiosk frontend holds no approve/reject call anywhere', () => {
  const root = path.join(__dirname, '..', '..', 'frontend', 'src');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (/\.(jsx?|mjs)$/.test(e.name)) files.push(p);
    }
  }(root));
  assert.ok(files.length > 5, 'positive control: the kiosk source was scanned');
  for (const f of files) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\/approve`|\/reject`|\/approve'|\/reject'/, `${f} can approve or reject`);
  }
});
