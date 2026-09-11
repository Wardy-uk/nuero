'use strict';

/**
 * What `/api/todos/focus` carries — specifically the two fields it dropped.
 *
 * `toTodoShape` has always carried `moscow` and `estimateMinutes`. The /focus
 * mapping is a SECOND whitelist over the same rows, and it listed neither, so
 * every focus card arrived unranked and unestimated. Nothing noticed while the
 * only consumer rendered a title and a due date — the phone's field editor then
 * seeded its draft from this payload and showed a task ranked Should as
 * unranked, and an hour's estimate as absent.
 *
 * Editing against a baseline the screen invented is worse than not offering the
 * edit at all, which is why this is a routing test rather than a service one:
 * the drop was in the route's own object literal, and a service suite would
 * have stayed green through all of it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-focus-')), 'a.db');

const db = require('../db/database');
const taskStore = require('../services/task-store');

// ⚠ THE VAULT IS STUBBED, AND ONLY THE VAULT. /focus reads its rows through
// `vaultCache.getTodos()`, which parses the Obsidian vault and merges the DB
// tasks in — with no VAULT_PATH in a test process it returns nothing at all, so
// without this the route answers an empty list and every assertion below passes
// vacuously. Feeding it the store's own active rows leaves the route's object
// literal as the only thing under test, which is exactly where the drop was.
const vaultCache = require('../services/vault-cache');
vaultCache.getTodos = () => ({ active: taskStore.activeTodos(), done: [] });
// ⚠ And the score cache is bypassed, not disabled elsewhere: it keys on vault
// mtimes, which a DB write does not change, so the second test would be served
// the first one's list and pass against a row it never created.
vaultCache.getScoredTasks = (filter, build) => build();

const router = require('./todos');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/todos', router);
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

async function focusRows() {
  const res = await fetch(`${base}/api/todos/focus?filter=all&limit=50`);
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.items || [];
}

test('a ranked, estimated task keeps both fields through /focus', async () => {
  const text = 'Send Zoe the ring-every-ticket results';
  const { id } = taskStore.createTask({ text });
  taskStore.updateTask(id, { moscow: 'should', estimateMinutes: 60 });

  const row = (await focusRows()).find(t => t.text === text);
  assert.ok(row, 'the task did not reach /focus at all');

  // ⚠ The two that were dropped. `undefined` here is the original bug: the
  // editor reads it as "not set" and offers to set what is already set.
  assert.equal(row.moscowSet, 'should');
  assert.equal(row.estimateMinutes, 60);
});

test('an unranked task says null, which is different from the field being missing', async () => {
  const text = 'Book the MOT';
  taskStore.createTask({ text });

  const row = (await focusRows()).find(t => t.text === text);
  assert.ok(row);
  // ⚠ Explicitly null rather than absent. A client cannot tell "this task has
  // no MoSCoW" from "this payload does not carry MoSCoW" when the key simply
  // is not there — and it is the second that makes an editor lie.
  assert.ok('moscowSet' in row, 'moscowSet key missing entirely');
  assert.ok('estimateMinutes' in row, 'estimateMinutes key missing entirely');
  assert.equal(row.moscowSet, null);
  assert.equal(row.estimateMinutes, null);

  // ⚠ AND `moscow` IS NOT null here — decorateTask has classified it. That is
  // the whole reason the two are separate keys: this row reads as something,
  // and Nick has decided nothing about it.
  assert.ok(row.moscow, 'expected a classified moscow to still be present');
});

test('a PROPOSED moscow is flagged as proposed, not presented as his decision', async () => {
  // ⚠ The flag is the difference between "NEURO thinks this is a Must" and
  // "Nick said this is a Must". A screen that renders the first as the second
  // quietly attributes the brain's ranking to him — and `updateTask` clears
  // the flag the moment he sets one by hand, precisely so the two stay apart.
  const text = 'Draft the board update';
  const { id } = taskStore.createTask({ text });
  taskStore.updateTask(id, { moscow: 'must' });

  const row = (await focusRows()).find(t => t.text === text);
  assert.ok(row);
  assert.equal(row.moscowSet, 'must');
  assert.equal(row.moscowProposed, false, 'setting it by hand should clear the proposal flag');
});
