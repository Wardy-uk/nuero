'use strict';

/**
 * Build 12.3K/N — a synthetic P0 through the REAL path, over real HTTP and a
 * real scratch database: inject → decision-engine pool → attention gate and
 * lifecycle → presentation P0 → digest + policy → the notification ledger →
 * clear. Nothing writes to a complication store or a digest directly; the
 * only way in is the route a person would use.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b123-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const db = require('../db/database');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  // The real server marks a machine-token request this way (server.js).
  app.use((req, res, next) => { if (req.headers['x-test-api-client']) req.apiClient = 'n8n'; next(); });
  app.use('/api/canonical', require('./canonical'));
  app.use('/api/setup', require('./setup'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

const req = async (method, p, body, headers = {}) => {
  const res = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
};

let escalation;

test('17/18a. the synthetic injector refuses the machine API token', async () => {
  const r = await req('POST', '/api/canonical/needs-you/synthetic', { kind: 'escalation' }, { 'x-test-api-client': '1' });
  assert.equal(r.status, 403);
  const before = await req('GET', '/api/canonical/needs-you');
  assert.equal(before.json.p0.items.filter((i) => i.synthetic).length, 0, 'nothing was injected');
});

test('18. a synthetic escalation travels the attention path and arrives as ONE eligible P0', async () => {
  const before = await req('GET', '/api/canonical/needs-you');
  assert.equal(before.status, 200);
  const baseCount = before.json.p0.count;

  const inj = await req('POST', '/api/canonical/needs-you/synthetic', { kind: 'escalation' });
  assert.equal(inj.status, 200);
  const id = inj.json.synthetic.id;

  const after = await req('GET', '/api/canonical/needs-you');
  const synth = after.json.p0.items.filter((i) => i.synthetic);
  assert.equal(synth.length, 1);
  escalation = synth[0];
  assert.equal(after.json.p0.count, baseCount + 1);
  assert.equal(escalation.kind, 'escalation');
  assert.match(escalation.title, /^Test — TEST-/);
  assert.equal(escalation.notification.eligible, true);
  assert.equal(escalation.notification.dedupeKey, `synthetic:${id}:escalation:TEST-${id}`);
  // It reached P0 through the attention LIFECYCLE: it has a record and an age.
  assert.ok(escalation.since, 'stamped by the lifecycle with firstSeenAt');

  // The same item through the full presentation, so the phone and the watch
  // read one answer.
  const pres = await req('GET', '/api/canonical/presentation');
  assert.equal(pres.json.presentation.p0.count, after.json.p0.count);
  assert.equal(pres.json.presentation.mode, 'needs-attention');
  assert.ok(pres.json.presentation.synthesis.themes.length <= 1, 'P0 shrinks the themes');
});

test('12/13. one P0 yields one notification: the first claim wins, a repeat poll is refused', async () => {
  const body = { dedupeKey: escalation.notification.dedupeKey, deviceId: 'iphone-test', channel: 'native-local', itemId: escalation.id, synthetic: true };
  const first = await req('POST', '/api/canonical/needs-you/notifications/claim', body);
  assert.equal(first.json.claim, true);
  const again = await req('POST', '/api/canonical/needs-you/notifications/claim', body);
  assert.equal(again.json.claim, false);
  assert.equal(again.json.already.outcome, 'claimed');
  const acc = await req('POST', '/api/canonical/needs-you/notifications/event', { ...body, event: 'accepted' });
  assert.equal(acc.json.notification.outcome, 'accepted');
  // A different DEVICE (the watch, say) has its own claim — per-device, not global.
  const other = await req('POST', '/api/canonical/needs-you/notifications/claim', { ...body, deviceId: 'other-device' });
  assert.equal(other.json.claim, true);
});

test('14. a RESTART does not duplicate: a second process sees the claim', () => {
  const script = `
    process.env.NEURO_DB_PATH = ${JSON.stringify(process.env.NEURO_DB_PATH)};
    const db = require(${JSON.stringify(path.join(__dirname, '..', 'db', 'database'))});
    db.init().then(() => {
      const an = require(${JSON.stringify(path.join(__dirname, '..', 'services', 'attention-notifications'))});
      const r = an.claim({ dedupeKey: ${JSON.stringify(escalation.notification.dedupeKey)}, deviceId: 'iphone-test', channel: 'native-local' });
      process.stdout.write('RESULT:' + JSON.stringify(r) + '\\n');
    });`;
  const stdout = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  const line = stdout.split('\n').find((l) => l.startsWith('RESULT:'));
  assert.ok(line, `child printed a result: ${stdout.slice(0, 200)}`);
  const out = JSON.parse(line.slice('RESULT:'.length));
  assert.equal(out.claim, false);
  assert.equal(out.already.outcome, 'accepted');
});

test('13b. a FAILED post releases the claim so the next wake may try again', async () => {
  const body = { dedupeKey: 'synthetic:z:escalation:TEST-z', deviceId: 'iphone-test', channel: 'native-local', synthetic: true };
  assert.equal((await req('POST', '/api/canonical/needs-you/notifications/claim', body)).json.claim, true);
  await req('POST', '/api/canonical/needs-you/notifications/event', { ...body, event: 'failed', detail: 'Banner Style is NONE' });
  assert.equal((await req('POST', '/api/canonical/needs-you/notifications/claim', body)).json.claim, true);
});

test('25. setup is proven only after the synthetic alert is OPENED', async () => {
  const before = (await req('GET', '/api/setup')).json.items.find((i) => i.id === 'watch.alerts-proven');
  assert.notEqual(before.status, 'done', 'accepted is not proof');
  const body = { dedupeKey: escalation.notification.dedupeKey, deviceId: 'iphone-test', channel: 'native-local', event: 'opened' };
  await req('POST', '/api/canonical/needs-you/notifications/event', body);
  const after = (await req('GET', '/api/setup')).json.items.find((i) => i.id === 'watch.alerts-proven');
  assert.equal(after.status, 'done');
});

test('17. a synthetic urgent EMAIL meets the attention gate’s verdict: P0 on a working day, HELD on a day off', async () => {
  const inj = await req('POST', '/api/canonical/needs-you/synthetic', { kind: 'email' });
  assert.equal(inj.status, 200);
  const attention = require('../services/attention');
  const canonical = require('../services/canonical-read');
  const at = async (iso) => {
    const now = new Date(iso);
    const decision = await attention.build({ now });
    const out = await canonical.now({ now: now.getTime(), decision });
    return { decision, p0: out.presentation.p0 };
  };
  // Tuesday 11:00 BST — a working day: it reaches P0 and is eligible.
  const tue = await at('2026-10-06T10:00:00Z');
  const email = tue.p0.items.filter((i) => i.synthetic && i.kind === 'email');
  assert.equal(email.length, 1);
  assert.equal(email[0].notification.eligible, true);
  assert.equal(email[0].notification.reason, 'An email arrived marked critical.');
  // Sunday — the gate holds work; the digest does not override it.
  const sun = await at('2026-10-04T10:00:00Z');
  assert.ok(sun.decision.dropped.some((d) => /^synthetic-email-/.test(d.id)), 'held, and named as held');
  assert.equal(sun.p0.items.filter((i) => i.synthetic && i.kind === 'email').length, 0);
  // Positive control: the unsuppressable escalation still gets through on Sunday.
  assert.equal(sun.p0.items.filter((i) => i.synthetic && i.kind === 'escalation').length, 1);
});

test('15. clearing the synthetic items removes them from the count', async () => {
  const del = await req('DELETE', '/api/canonical/needs-you/synthetic');
  assert.equal(del.json.cleared, 2);
  const after = await req('GET', '/api/canonical/needs-you');
  assert.equal(after.json.p0.items.filter((i) => i.synthetic).length, 0);
});

test('synthetic items expire on their own and refuse nonsense', async () => {
  const sa = require('../services/synthetic-attention');
  const e = sa.inject({ kind: 'escalation', ttlMinutes: 1 }, { now: Date.now() - 5 * 60000 });
  assert.equal(sa.active().some((x) => x.id === e.id), false, 'a lapsed entry is not live');
  assert.equal((await req('POST', '/api/canonical/needs-you/synthetic', { kind: 'pager' })).status, 400);
  assert.equal((await req('POST', '/api/canonical/needs-you/synthetic', { kind: 'email', ttlMinutes: -1 })).status, 400);
  await req('DELETE', '/api/canonical/needs-you/synthetic');
});
