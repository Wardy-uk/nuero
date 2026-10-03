'use strict';

/**
 * Build 9 — surface convergence, driven through the REAL routes against a real
 * scratch database. A green pure suite says nothing about wiring: the attention
 * block sits behind a never-fail guard, so a missing require would be swallowed
 * into `approvals: unknown` and every SAiM shell would quietly render nothing.
 *
 * What is pinned here:
 *   1. a draft waiting for approval stays in "Needs approval" however much
 *      newer history pushes it off the page (the buckets were page-bound);
 *   2. `/api/attention` carries the governed approval state, one sentence that
 *      names WHERE to approve, and goes silent when nothing waits;
 *   3. the sidebar's number and SAiM's sentence read the SAME summary.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b9-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const db = require('../db/database');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/attention', require('./attention'));
  app.use('/api/prepared-actions', require('./prepared-actions'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

function seed(id, type, createdIso, { commitment = `c-${id}` } = {}) {
  db.run(`INSERT INTO prepared_actions (action_id, idempotency_key, finding_id, commitment_id, subject_ref, action_type, version, target_json, reason,
          evidence_json, draft_json, payload_hash, authority_class, approval_required, status, created_at, history_json, updated_at)
          VALUES (?, ?, 'f', ?, null, ?, 1, '{"displayName":"Chris"}', 'r', '{}', '{"subject":"s","body":"b"}', ?, 'A4', 1, 'prepared', ?, '[]', ?)`,
  [id, `k-${id}`, commitment, type, `h-${id}`, createdIso, createdIso]);
}

const get = async (p) => {
  const res = await fetch(`${base}${p}`);
  assert.equal(res.status, 200, `${p} answers`);
  return res.json();
};

test('1. an old draft awaiting approval stays in Needs approval behind 60 newer history rows', async () => {
  seed('pa_old_waiting', 'send_weekly_risk_report', '2026-09-01T08:00:00.000Z');
  for (let i = 0; i < 60; i++) {
    const at = new Date(Date.UTC(2026, 8, 10, 8, i)).toISOString();
    seed(`pa_hist_${i}`, 'draft_update_email', at);
    db.run(`UPDATE prepared_actions SET status = 'rejected', decided_at = ?, updated_at = ? WHERE action_id = ?`, [at, at, `pa_hist_${i}`]);
  }
  // Positive control: the old row really is outside the newest-50 page.
  const newest = db.all('SELECT action_id FROM prepared_actions ORDER BY updated_at DESC LIMIT 50').map((r) => r.action_id);
  assert.ok(!newest.includes('pa_old_waiting'), 'fixture reaches the rule: the waiting row is off the page');

  const body = await get('/api/prepared-actions?limit=50');
  assert.ok(body.buckets.needsApproval.includes('pa_old_waiting'), 'still listed as needing approval');
  assert.ok(body.actions.some((a) => a.actionId === 'pa_old_waiting'), 'and its card data is present to render');
  assert.equal(body.needsYou.known, true);
  assert.equal(body.needsYou.needsApproval, 1);
});

test('2. /api/attention says a draft waits, names where, and offers nothing to press', async () => {
  const body = await get('/api/attention');
  const a = body.approvals;
  assert.ok(a, 'approvals is on the payload — not swallowed by the never-fail guard');
  assert.equal(a.known, true);
  assert.equal(a.needsApproval, 1);
  assert.match(a.say, /1 drafted email waits for your approval/);
  assert.match(a.say, /weekly risk report/);
  assert.match(a.say, /NEURO on the desktop/);
  // The sending switch defaults OFF in a fresh DB, and approval is refused while
  // it is — so the sentence must say so rather than send him to a dead button.
  assert.match(a.say, /switched off/);
});

test('3. the sidebar badge source and SAiM sentence read the same summary', async () => {
  const pa = await get('/api/prepared-actions?limit=1');
  const at = await get('/api/attention');
  assert.equal(pa.needsYou.needsApproval, at.approvals.needsApproval);
  assert.equal(pa.needsYou.say, at.approvals.say);
});

test('4. when the draft is decided, both go silent — silence, never "nothing to approve"', async () => {
  db.run(`UPDATE prepared_actions SET status = 'rejected', decided_at = ?, updated_at = ? WHERE action_id = 'pa_old_waiting'`,
    ['2026-10-03T09:00:00.000Z', '2026-10-03T09:00:00.000Z']);
  const at = await get('/api/attention');
  assert.equal(at.approvals.known, true);
  assert.equal(at.approvals.needsApproval, 0);
  assert.equal(at.approvals.say, null);
  const pa = await get('/api/prepared-actions?limit=50');
  assert.deepEqual(pa.buckets.needsApproval, []);
});
