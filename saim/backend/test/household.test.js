// The shared room screens' household door (22 Oct 2026), over real HTTP.
// What it opens, what it refuses, that the browser never holds the token, and
// that the session is asked for with the kiosk's credential and renewed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createRouter, isDoor } = require('../src/routes/household');

const ENV = { NEURO_BASE_URL: 'http://neuro.test:3001', NEURO_KIOSK_TOKEN: 'kiosk-tok', VESTA_SCREEN_ACCOUNT: 'family' };

function fakeNeuro() {
  const calls = [];
  let issued = 0;
  let reject = false;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const h = init.headers || {};
    if (url.endsWith('/api/capture-links/screen-session')) {
      if (h['x-neuro-kiosk-token'] !== 'kiosk-tok') return new Response(JSON.stringify({ ok: false }), { status: 403 });
      issued += 1;
      return new Response(JSON.stringify({ ok: true, token: `sess-${issued}` }), { status: 200 });
    }
    if (reject) { reject = false; return new Response(JSON.stringify({ ok: false }), { status: 401 }); }
    const auth = h.authorization || '';
    const headers = { 'content-type': 'application/json' };
    if (url.includes('/wall')) headers['x-vesta-session'] = 'sess-renewed';
    return new Response(JSON.stringify({ ok: true, auth, method: init.method, body: init.body || null }), { status: 200, headers });
  };
  return { fetchImpl, calls, failNext: () => { reject = true; } };
}

function serve(router) {
  const app = express();
  app.use(express.json());
  app.use('/api/v', router);
  const server = http.createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ server, call: (p, init) => fetch(base + p, init).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) })) });
  }));
}

test('the doors are exactly the wall, photos, household jobs and the family calendar', () => {
  assert.ok(isDoor('GET', '/wall'));
  assert.ok(isDoor('GET', '/photo/helen'));
  assert.ok(isDoor('POST', '/tasks'));
  assert.ok(isDoor('PATCH', '/tasks/12'));
  assert.ok(isDoor('DELETE', '/family-calendar/events/neuabc'));
  for (const [m, p] of [['GET', '/home'], ['POST', '/catalogue/kitchen/scan'], ['GET', '/hike'], ['POST', '/login'],
    ['DELETE', '/tasks/12'], ['GET', '/photo/../x'], ['GET', '/calendar']]) {
    assert.equal(isDoor(m, p), false, `${m} ${p} stays shut`);
  }
});

test('the wall additions (25 Oct 2026) are open by name, and only by name', () => {
  for (const [m, p] of [['GET', '/home-control'], ['POST', '/home-control'], ['POST', '/tea'], ['POST', '/notes'],
    ['POST', '/notes/a1b2c3d4e5f6/clear'], ['POST', '/countdowns'], ['POST', '/shopping/add'], ['POST', '/shopping/bought']]) {
    assert.ok(isDoor(m, p), `${m} ${p} opens`);
  }
  for (const [m, p] of [['DELETE', '/home-control'], ['GET', '/tea'], ['POST', '/notes/x/y/clear'], ['POST', '/notes/../clear'],
    ['POST', '/shopping/remove'], ['POST', '/catalogue/shopping/add'], ['POST', '/catalogue/kitchen/used'], ['GET', '/shopping']]) {
    assert.equal(isDoor(m, p), false, `${m} ${p} stays shut`);
  }
});

test('a home-control press goes through as the household with its body', async () => {
  const neuro = fakeNeuro();
  const { server, call } = await serve(createRouter({ fetchImpl: neuro.fetchImpl, env: ENV }));
  try {
    const r = await call('/api/v/home-control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entity: 'light.hall', action: 'on' }) });
    assert.equal(r.status, 200);
    assert.equal(r.json.auth, 'Bearer sess-1');
    assert.deepEqual(JSON.parse(r.json.body), { entity: 'light.hall', action: 'on' });
  } finally { server.close(); }
});

test('a read goes through as the household, with the kiosk asking for the session', async () => {
  const neuro = fakeNeuro();
  const { server, call } = await serve(createRouter({ fetchImpl: neuro.fetchImpl, env: ENV }));
  try {
    const r = await call('/api/v/wall?days=42', { headers: { authorization: 'Bearer from-browser' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.auth, 'Bearer sess-1', 'the server attaches its own session, never the browser’s');
    const ask = neuro.calls.find((c) => c.url.endsWith('/screen-session'));
    assert.deepEqual(JSON.parse(ask.init.body), { username: 'family' });
    // The renewal NEURO handed back is used next time.
    const again = await call('/api/v/wall');
    assert.equal(again.json.auth, 'Bearer sess-renewed');
  } finally { server.close(); }
});

test('a write carries its body; a refused door never reaches NEURO', async () => {
  const neuro = fakeNeuro();
  const { server, call } = await serve(createRouter({ fetchImpl: neuro.fetchImpl, env: ENV }));
  try {
    const r = await call('/api/v/tasks/7', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done: true }) });
    assert.equal(r.json.method, 'PATCH');
    assert.deepEqual(JSON.parse(r.json.body), { done: true });
    const before = neuro.calls.length;
    const shut = await call('/api/v/catalogue/kitchen/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(shut.status, 403);
    assert.equal(neuro.calls.length, before, 'nothing was sent');
  } finally { server.close(); }
});

test('a dead session is asked for again once', async () => {
  const neuro = fakeNeuro();
  const { server, call } = await serve(createRouter({ fetchImpl: neuro.fetchImpl, env: ENV }));
  try {
    await call('/api/v/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"x"}' });
    neuro.failNext();
    const r = await call('/api/v/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"y"}' });
    assert.equal(r.status, 200);
    assert.equal(r.json.auth, 'Bearer sess-2');
  } finally { server.close(); }
});
