'use strict';

/**
 * Setting MoSCoW / priority / due date on a suggestion before approving it.
 *
 * Nick's ask (23 Sep 2026): each card in "Spotted, waiting on you" gets the three
 * triage fields, individually or across a multi-select, and "leaving any
 * unselected should apply the current default".
 *
 * The contract these pin:
 *   - an omitted field is left alone, so the executor's existing defaults apply
 *     (MoSCoW classifier, priorityFromMoscow, commitment-due's stated-date-else-
 *     ten-days) — the defaults are NOT re-implemented here;
 *   - an explicit null CLEARS back to the default, which is a different request
 *     from omitting it;
 *   - an unrecognised value is REFUSED, never normalised to null — null means
 *     "use the default", so a typo would look like it worked;
 *   - only a PENDING capture_todo can be edited. This is a scoped door, and
 *     `/api/actions/:id/approve` stays a plain approve with no payload-edit,
 *     because it approves action types that send email as Nick.
 *
 * Real HTTP through real SQLite: a green service suite says nothing about
 * routing, and this router already carries `/ms/:msId` style paths.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-sugg-fields-'));
process.env.NEURO_DB_PATH = path.join(root, 'sugg.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const express = require('express');
const db = require('../db/database');

let server, base;

async function req(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body is fine */ }
  return { status: res.status, json };
}

function newSuggestion(text = 'Nick to review the escalation policy') {
  return db.createSaimAction('capture_todo', { text, metadata: {} }, 0.8, 'spotted in a meeting note');
}

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/todos', require('./todos'));
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

test('sets all three fields onto the pending action payload', async () => {
  const id = newSuggestion('Nick to compile the productivity stats');
  const r = await req('POST', `/api/todos/suggestions/${id}/fields`,
    { moscow: 'must', priority: 3, dueDate: '2026-10-01' });

  assert.equal(r.status, 200, JSON.stringify(r.json));
  const action = db.getSaimAction(id);
  assert.equal(action.payload.metadata.moscow, 'must');
  assert.equal(action.payload.metadata.priority, 3);
  assert.equal(action.payload.metadata.dueDate, '2026-10-01');
});

test('an OMITTED field is left alone, so the default still applies', async () => {
  const id = newSuggestion('Nick to book the risk review');
  await req('POST', `/api/todos/suggestions/${id}/fields`, { moscow: 'should' });

  const md = db.getSaimAction(id).payload.metadata;
  assert.equal(md.moscow, 'should');
  // The executor reads `payload.metadata.dueDate || payload.dueDate ||
  // commitment-due.resolveDueDate(...)`. Absent means the default is reached.
  assert.ok(!('dueDate' in md), 'an omitted due date must not be written');
  assert.ok(!('priority' in md), 'an omitted priority must not be written');
});

test('an explicit null CLEARS back to the default', async () => {
  const id = newSuggestion('Nick to chase the Lomond invoice');
  await req('POST', `/api/todos/suggestions/${id}/fields`, { moscow: 'must', dueDate: '2026-10-05' });
  const r = await req('POST', `/api/todos/suggestions/${id}/fields`, { dueDate: null });

  assert.equal(r.status, 200);
  const md = db.getSaimAction(id).payload.metadata;
  assert.equal(md.moscow, 'must', 'clearing one field must not touch another');
  assert.ok(!('dueDate' in md), 'null must remove it so the default applies again');
});

test('an unrecognised value is REFUSED, not silently defaulted', async () => {
  const id = newSuggestion('Nick to draft the SLT wording');

  const m = await req('POST', `/api/todos/suggestions/${id}/fields`, { moscow: 'urgent' });
  assert.equal(m.status, 400, 'a MoSCoW typo must not pass as "use the default"');
  assert.match(m.json.error, /moscow/i);

  const p = await req('POST', `/api/todos/suggestions/${id}/fields`, { priority: 9 });
  assert.equal(p.status, 400, 'priority is 1-3');

  const d = await req('POST', `/api/todos/suggestions/${id}/fields`, { dueDate: '01/10/2026' });
  assert.equal(d.status, 400, 'a due date must be YYYY-MM-DD, never reparsed');

  const md = db.getSaimAction(id).payload.metadata || {};
  assert.deepEqual(md, {}, 'a refused request must write nothing at all');
});

test('refuses an action that is not a pending capture_todo', async () => {
  const other = db.createSaimAction('draft_reply', { text: 'hi', emailId: 'x' }, 0.8, 'urgent email');
  const wrongType = await req('POST', `/api/todos/suggestions/${other}/fields`, { moscow: 'must' });
  assert.equal(wrongType.status, 400, 'this door is capture_todo only');

  const done = newSuggestion('Nick to send the Monday email');
  db.updateSaimActionStatus(done, 'executed');
  const settled = await req('POST', `/api/todos/suggestions/${done}/fields`, { moscow: 'must' });
  assert.equal(settled.status, 409, 'editing a settled action would rewrite history');

  const missing = await req('POST', '/api/todos/suggestions/99999/fields', { moscow: 'must' });
  assert.equal(missing.status, 404);
});

test('an empty body is refused rather than reported as a no-op success', async () => {
  const id = newSuggestion('Nick to update the org chart');
  const r = await req('POST', `/api/todos/suggestions/${id}/fields`, {});
  assert.equal(r.status, 400, 'nothing to set is a caller error, not a success');
});
