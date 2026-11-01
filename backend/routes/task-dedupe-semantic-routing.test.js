'use strict';

/**
 * The semantic arm over real HTTP (1 Nov 2026): /api/task-dedupe/candidates
 * carries a meaning-only pair with its reason, keeps the word pairs when the
 * embedding provider fails and SAYS so, and /api/capture/todo reports a meaning
 * match at capture time. The provider is stubbed; the DB, cache and routers are
 * real — the candidates route is async now, and only HTTP proves it answers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-dedupe-sem-route-'));
process.env.NEURO_DB_PATH = path.join(root, 'a.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Tasks'), { recursive: true });
delete process.env.TASK_SEMANTIC_DEDUPE_ENABLED;

const express = require('express');
const db = require('../db/database');
const taskStore = require('../services/task-store');
const dedupe = require('../services/task-dedupe');
const semantic = require('../services/task-semantic');

// No shared vocabulary; cosine 0.95 by construction.
const A = 'Sort out who looks after the rota when I am off';
const B = 'Holiday cover plan for the out of hours roster';
const C = 'Order new chairs for the meeting room';
const B2 = 'Cover plan for when I am on holiday, out of hours roster';
const D = 32;
const assigned = new Map();
function vecFor(text) {
  const n = dedupe.normaliseForEmbedding(text);
  const v = new Array(D).fill(0);
  if (n === dedupe.normaliseForEmbedding(A)) { v[0] = 1; return v; }
  if (n === dedupe.normaliseForEmbedding(B) || n === dedupe.normaliseForEmbedding(B2)) {
    v[0] = 0.95; v[1] = Math.sqrt(1 - 0.95 * 0.95); return v;
  }
  // Every other wording gets a private dimension: orthogonal to everything.
  if (!assigned.has(n)) assigned.set(n, 2 + assigned.size);
  v[assigned.get(n)] = 1;
  return v;
}
const ok = (texts) => Promise.resolve({ ok: true, vectors: texts.map(vecFor) });
const down = () => Promise.resolve({ ok: false, reason: 'Voyage answered 503' });

let server; let base;
test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/task-dedupe', require('./task-dedupe'));
  app.use('/api/capture', require('./capture'));
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { semantic._setProvider(null); return new Promise(r => server.close(r)); });

async function call(p, body) {
  const res = await fetch(base + p, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test('provider down: word pairs still come back, and the response says meaning did not run', async () => {
  semantic._setProvider(down);
  taskStore.createTask({ text: 'Consult Annabelle for insights', source: 'test' });
  taskStore.createTask({ text: 'Nick Ward will consult Annabelle, who is further ahead in this process, for insights', source: 'test' });
  const { status, json } = await call('/api/task-dedupe/candidates');
  assert.equal(status, 200);
  assert.equal(json.semantic.available, false);
  assert.match(json.semantic.reason, /503/);
  assert.equal(json.internal.length, 1, 'the lexical pair stands');
  assert.equal(json.internal[0].why, 'words');
});

test('candidates: a meaning-only pair is offered with its reason; dismissing it uses the same key', async () => {
  semantic._setProvider(ok);
  const a = taskStore.createTask({ text: A, source: 'test' });
  const b = taskStore.createTask({ text: B, source: 'test' });
  taskStore.createTask({ text: C, source: 'test' });
  const { status, json } = await call('/api/task-dedupe/candidates');
  assert.equal(status, 200);
  assert.equal(json.semantic.available, true);
  assert.equal(json.semantic.threshold, dedupe.SEMANTIC_MIN_SCORE);
  assert.equal(json.defaultSemanticMinScore, 0.9);
  const meaning = json.internal.find(p => p.why === 'meaning');
  assert.ok(meaning, 'meaning pair present');
  assert.equal(meaning.whyLabel, 'Same meaning, 95%');
  assert.equal(meaning.pairKey, dedupe.internalPairKey(a.id, b.id));
  assert.ok(!json.internal.some(p => [p.keep.text, p.drop.text].includes(C)), 'an unrelated task is not offered');

  dedupe.dismissInternalPair(a.id, b.id);
  const after = await call('/api/task-dedupe/candidates');
  assert.ok(!after.json.internal.some(p => p.pairKey === meaning.pairKey), 'dismissal holds');
  dedupe.undismissInternalPair(a.id, b.id);
  taskStore.updateTask(b.id, { status: 'dropped' });
});

test('capture: a new wording that MEANS an open task is reported as similar', async () => {
  semantic._setProvider(ok);
  await call('/api/task-dedupe/candidates');   // caches the open tasks' vectors
  const { status, json } = await call('/api/capture/todo', { text: B2 });
  assert.equal(status, 200);
  assert.ok(json.similar, 'similar reported');
  assert.equal(json.similar.why, 'meaning');
  assert.equal(json.similar.text, A);
});

test('capture: provider down → capture still succeeds, no meaning claim', async () => {
  semantic._setProvider(down);
  const { status, json } = await call('/api/capture/todo', { text: 'Holiday cover rota for the summer, second pass' });
  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.ok(!json.similar || json.similar.why === 'words');
});
