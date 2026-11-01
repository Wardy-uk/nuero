'use strict';

/**
 * The semantic arm of task de-duplication (1 Nov 2026).
 *
 * The embedding provider is STUBBED with deterministic vectors so every cosine
 * is exact; the cache runs against a real scratch SQLite DB. The cosines used
 * for the threshold fixtures are the ones MEASURED on the live store with
 * voyage-3.5 (see task-dedupe.SEMANTIC_MIN_SCORE) — they pin the decision, so a
 * threshold moved without re-measuring fails here by name.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-task-semantic-'));
process.env.NEURO_DB_PATH = path.join(root, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Tasks'), { recursive: true });
delete process.env.TASK_SEMANTIC_DEDUPE_ENABLED;

const db = require('../db/database');
const taskStore = require('./task-store');
const dedupe = require('./task-dedupe');
const semantic = require('./task-semantic');

// ── deterministic vectors ────────────────────────────────────────────────────
//
// Each fixture pair gets two private dimensions: a = e_k, b = c·e_k + √(1−c²)·e_{k+1},
// so cos(a, b) is exactly c and every other pair is orthogonal (cos 0).
const DIMS = 64;
const table = new Map();
let nextDim = 0;
function unit(i) { const v = new Array(DIMS).fill(0); v[i] = 1; return v; }
function pairWith(aText, bText, c) {
  const k = nextDim; nextDim += 2;
  const b = new Array(DIMS).fill(0); b[k] = c; b[k + 1] = Math.sqrt(1 - c * c);
  table.set(dedupe.normaliseForEmbedding(aText), unit(k));
  table.set(dedupe.normaliseForEmbedding(bText), b);
}
function vecFor(text) {
  const key = dedupe.normaliseForEmbedding(text);
  if (!table.has(key)) { table.set(key, unit(nextDim)); nextDim++; }
  return table.get(key);
}

let calls = [];
function okProvider(texts) { calls.push(texts.slice()); return Promise.resolve({ ok: true, vectors: texts.map(vecFor) }); }
function failProvider() { calls.push('fail'); return Promise.resolve({ ok: false, reason: 'Voyage answered 503' }); }

// Measured on the live store, 1 Nov 2026 (voyage-3.5). TRUE = pairs Nick merged.
const TRUE_ABOVE = [
  ['Continue phone-answering coaching; complete session with remaining team', 'Continue coaching on phone answering; complete the planned session', 0.983],
  ['Flight risks identified and documented with action plans.', 'Flight risks identified and mitigated', 0.956],
  ['Prepare MyAudience vs iMail price comparisons (for Chris -> SLT)', 'Nick to prepare price comparisons between MyAudience and iMail', 0.924],
];
// Known DIFFERENT jobs — must never be offered on meaning.
const FALSE_BELOW = [
  ['Provide timescales for LSL and EXP dashboards', 'Compile list of EXP/LSL dashboard users to grant access', 0.876],
  ['Pull 5-day forecast from your existing weather station data, score for hiking', 'Weather API (you already have a weather station; use its data)', 0.896],
  ['Team satisfaction survey results reviewed — actions identified', 'Final team satisfaction pulse check — improvement vs Day 30 baseline?', 0.859],
  ['Career progression pathways defined by Day 45', 'Kayleigh Russell — career progression plans for DD team by Day 30', 0.810],
];
// The brief's own example. Measured 0.820 — deliberately NOT caught (see report).
const BRIEF = ['Work out who covers my role if I go under a bus', 'Succession plan', 0.820];

for (const [a, b, c] of [...TRUE_ABOVE, ...FALSE_BELOW, BRIEF]) pairWith(a, b, c);
// A no-shared-vocabulary pair that IS above the line, for the meaning-only path.
const REWORD = ['Sort out who looks after the rota when I am off', 'Holiday cover plan for the out of hours roster', 0.95];
pairWith(...REWORD);

function vectorsOf(texts) {
  const m = new Map();
  for (const t of texts) m.set(dedupe.normaliseForEmbedding(t), vecFor(t));
  return m;
}

test.before(async () => { await db.init(); });
test.beforeEach(() => { calls = []; semantic._setProvider(okProvider); });

// ── pure: admission, labels, thresholds ──────────────────────────────────────

test('the threshold is the measured one, and it sits above every known-different pair', () => {
  assert.equal(dedupe.SEMANTIC_MIN_SCORE, 0.9);
  for (const [a, b, c] of FALSE_BELOW) {
    assert.ok(c < dedupe.SEMANTIC_MIN_SCORE, `${a} / ${b} measured ${c} must stay under the line`);
  }
  for (const [, , c] of TRUE_ABOVE) assert.ok(c >= dedupe.SEMANTIC_MIN_SCORE);
});

test('a reword sharing no words is offered on MEANING and says so', () => {
  const [a, b] = REWORD;
  const pairs = dedupe.rankInternalCandidates({
    tasks: [{ id: 1, text: a }, { id: 2, text: b }],
    vectors: vectorsOf([a, b]),
  });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].why, 'meaning');
  assert.equal(pairs[0].whyLabel, 'Same meaning, 95%');
  assert.equal(pairs[0].semanticScore, 0.95);
  assert.equal(pairs[0].confidence, 'possible', 'meaning alone is never "likely"');
  assert.equal(pairs[0].pairKey, dedupe.internalPairKey(1, 2), 'same key, so dismissals keep working');
});

test('without vectors the same pair is NOT offered (lexical alone cannot see it)', () => {
  const [a, b] = REWORD;
  assert.equal(dedupe.rankInternalCandidates({ tasks: [{ id: 1, text: a }, { id: 2, text: b }] }).length, 0);
});

test('negatives: measured different-job pairs are not offered on meaning', () => {
  for (const [a, b] of FALSE_BELOW) {
    const pairs = dedupe.rankInternalCandidates({
      tasks: [{ id: 1, text: a }, { id: 2, text: b }],
      vectors: vectorsOf([a, b]),
    });
    assert.ok(!pairs.some(p => p.why === 'meaning'), `${a} / ${b} must not be offered on meaning`);
  }
});

test('the brief\'s own example (0.820) is under the line — a stated limit, pinned', () => {
  const [a, b] = BRIEF;
  const pairs = dedupe.rankCandidates({
    neuroTasks: [{ id: 1, text: a }], msTasks: [{ ms_id: 'm1', text: b }], vectors: vectorsOf([a, b]),
  });
  assert.equal(pairs.length, 0);
});

test('NEURO↔Microsoft: meaning pair offered, dismissed pair stays dismissed', () => {
  const [a, b] = TRUE_ABOVE[1];
  const args = { neuroTasks: [{ id: 7, text: a }], msTasks: [{ ms_id: 'mx', text: b }], vectors: vectorsOf([a, b]) };
  const pairs = dedupe.rankCandidates(args);
  assert.equal(pairs.length, 1);
  assert.ok(['meaning', 'both'].includes(pairs[0].why));
  assert.equal(dedupe.rankCandidates({ ...args, dismissed: new Set([dedupe.pairKey(7, 'mx')]) }).length, 0);
});

test('a lexical pair is "words" when there are no vectors and "both" when meaning agrees', () => {
  const a = 'Consult Annabelle for insights';
  const b = 'Nick Ward will consult Annabelle, who is further ahead in this process, for insights';
  const tasks = [{ id: 1, text: a }, { id: 2, text: b }];
  assert.equal(dedupe.rankInternalCandidates({ tasks })[0].why, 'words');
  assert.equal(dedupe.rankInternalCandidates({ tasks })[0].whyLabel, 'Same words');
  pairWith(a, b, 0.93);
  const both = dedupe.rankInternalCandidates({ tasks, vectors: vectorsOf([a, b]) })[0];
  assert.equal(both.why, 'both');
});

test('word matches rank ahead of meaning-only ones', () => {
  const a = 'Consult Annabelle for insights';
  const b = 'Nick Ward will consult Annabelle, who is further ahead in this process, for insights';
  const [c, d] = REWORD;
  const pairs = dedupe.rankInternalCandidates({
    tasks: [{ id: 1, text: a }, { id: 2, text: b }, { id: 3, text: c }, { id: 4, text: d }],
    vectors: vectorsOf([c, d]),
  });
  assert.deepEqual(pairs.map(p => p.why), ['words', 'meaning']);
});

// ── cache + provider (real DB) ───────────────────────────────────────────────

test('vectorsFor embeds each wording once, then reads the cache', async () => {
  const texts = ['Alpha task one', 'Beta task two', 'alpha   TASK one'];
  const first = await semantic.vectorsFor(texts);
  assert.equal(first.semantic.available, true);
  assert.equal(first.semantic.wordings, 2, 'case/whitespace fold to one wording');
  assert.equal(first.semantic.embedded, 2);
  assert.equal(calls.length, 1);

  calls = [];
  const again = await semantic.vectorsFor(texts);
  assert.equal(calls.length, 0, 'nothing re-embedded');
  assert.equal(again.semantic.cached, 2);
  assert.ok(again.vectors.get(dedupe.normaliseForEmbedding('Alpha task one')));
});

test('missing wordings are batched', async () => {
  const texts = Array.from({ length: semantic.BATCH_SIZE + 6 }, (_, i) => `Batch probe ${i}`);
  await semantic.vectorsFor(texts);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].length, semantic.BATCH_SIZE);
});

test('a failure is reported, keeps the cached vectors, and prunes NOTHING', async () => {
  await semantic.vectorsFor(['Cached before outage']);
  const before = semantic.cacheSize();
  semantic._setProvider(failProvider);
  const out = await semantic.vectorsFor(['Cached before outage', 'New during outage'], { pruneOthers: true });
  assert.equal(out.semantic.available, false);
  assert.match(out.semantic.reason, /503/);
  assert.equal(out.semantic.missing, 1);
  assert.ok(out.vectors.get(dedupe.normaliseForEmbedding('Cached before outage')), 'cached vector still used');
  assert.equal(semantic.cacheSize(), before, 'an outage must not throw paid-for vectors away');
});

test('a complete pass prunes vectors for wordings no longer open', async () => {
  await semantic.vectorsFor(['Keep me', 'Gone soon']);
  await semantic.vectorsFor(['Keep me'], { pruneOthers: true });
  const h = semantic.hashOf('Gone soon');
  assert.equal(semantic.readCached([h]).size, 0);
  assert.equal(semantic.readCached([semantic.hashOf('Keep me')]).size, 1);
});

test('switched off → no network, reported', async () => {
  process.env.TASK_SEMANTIC_DEDUPE_ENABLED = 'false';
  try {
    const out = await semantic.vectorsFor(['Anything']);
    assert.equal(out.vectors, null);
    assert.equal(out.semantic.available, false);
    assert.equal(calls.length, 0);
  } finally { delete process.env.TASK_SEMANTIC_DEDUPE_ENABLED; }
});

// ── capture-time ─────────────────────────────────────────────────────────────

test('capture: meaning match from CACHED existing vectors; only the new text is embedded', async () => {
  const [existing, fresh] = REWORD;
  const t = taskStore.createTask({ text: existing, source: 'test', skipExport: true });
  await semantic.vectorsFor([existing]);   // what the candidates screen does
  calls = [];
  const hit = await semantic.findSimilarSemantic(fresh);
  assert.ok(hit);
  assert.equal(hit.id, t.id);
  assert.equal(hit.why, 'meaning');
  assert.equal(hit.semanticScore, 0.95);
  assert.deepEqual(calls, [[fresh]], 'only the new text went to the provider');

  calls = [];
  await semantic.findSimilarSemantic(fresh);
  assert.equal(calls.length, 0, 'the new text\'s vector was kept');
  taskStore.updateTask(t.id, { status: 'dropped' });
});

test('capture: an existing task with no cached vector is never embedded at capture time', async () => {
  const [a, b] = TRUE_ABOVE[0];
  const t = taskStore.createTask({ text: a, source: 'test', skipExport: true });
  semantic.prune([]);
  calls = [];
  assert.equal(await semantic.findSimilarSemantic(b), null);
  assert.equal(calls.length, 0);
  taskStore.updateTask(t.id, { status: 'dropped' });
});

test('capture: a slow provider falls back to null inside the deadline', async () => {
  const [existing, fresh] = TRUE_ABOVE[2];
  const t = taskStore.createTask({ text: existing, source: 'test', skipExport: true });
  await semantic.vectorsFor([existing]);
  semantic._setProvider(() => new Promise(() => {}));
  const started = Date.now();
  assert.equal(await semantic.findSimilarSemantic(fresh, { timeoutMs: 100 }), null);
  assert.ok(Date.now() - started < 2000);
  taskStore.updateTask(t.id, { status: 'dropped' });
});

test('capture: words still answer first, and a measured different job is not a meaning hit', async () => {
  const [a, b] = FALSE_BELOW[0];
  const t = taskStore.createTask({ text: a, source: 'test', skipExport: true });
  await semantic.vectorsFor([a]);
  const hit = await semantic.findSimilarSemantic(b);
  assert.ok(!hit || hit.why === 'words', 'never offered on meaning');
  assert.equal(await semantic.findSimilarSemantic('x', { excludeId: t.id }), null);
  taskStore.updateTask(t.id, { status: 'dropped' });
});
