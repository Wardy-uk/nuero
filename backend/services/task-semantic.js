'use strict';

/**
 * The semantic arm of task de-duplication (1 Nov 2026).
 *
 * task-dedupe's lexical matcher cannot see a reword that shares no vocabulary.
 * This module owns the NETWORK and the CACHE half of the fix; the admission rule,
 * cosine and the measured threshold live in task-dedupe.js (pure) so the ranking
 * still pins without a database or Voyage.
 *
 * Rules:
 *   - Each wording is embedded ONCE per model: `task_text_vectors` is keyed on a
 *     hash of the normalised text + the model. Texts no longer open are pruned.
 *   - A failure NEVER empties the result. The lexical answer stands and the
 *     caller reports `semantic: { available: false, reason }`.
 *   - It SUGGESTS, never merges — nothing here writes a task.
 *   - Capture-time checks use CACHED vectors for existing tasks and embed only
 *     the new text, under a short deadline; a miss falls back to lexical.
 *
 * Every Voyage request goes through providers/voyage-provider.js under the
 * AI-gate class `task_dedupe_embed`.
 */

const crypto = require('crypto');
const db = require('../db/database');
const dedupe = require('./task-dedupe');

// Measured: voyage-3.5 separated Nick's merged pairs from known-different ones
// better than voyage-3.5-lite (lite compresses everything into 0.70–0.98). The
// threshold in task-dedupe.SEMANTIC_MIN_SCORE was measured against THIS model;
// change one, re-measure the other.
const SEMANTIC_MODEL = 'voyage-3.5';
const BATCH_SIZE = 64;
const MAX_CHARS = 500;
const CANDIDATES_TIMEOUT_MS = 15000;
const CAPTURE_TIMEOUT_MS = 2500;

function enabled() {
  return String(process.env.TASK_SEMANTIC_DEDUPE_ENABLED || 'true').toLowerCase() !== 'false';
}

function hashOf(text) {
  return crypto.createHash('sha256').update(dedupe.normaliseForEmbedding(text)).digest('hex').slice(0, 32);
}

// ── cache ────────────────────────────────────────────────────────────────────

let _ready = false;
function ensureTable() {
  if (_ready) return;
  db.getDb().exec(`CREATE TABLE IF NOT EXISTS task_text_vectors (
    text_hash   TEXT NOT NULL,
    model       TEXT NOT NULL,
    dims        INTEGER NOT NULL,
    vector      BLOB NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (text_hash, model)
  )`);
  _ready = true;
}

function _toBlob(vec) { return Buffer.from(new Float32Array(vec).buffer); }
function _fromBlob(buf, dims) {
  const f = new Float32Array(buf.buffer, buf.byteOffset, dims);
  return Array.from(f);
}

function readCached(hashes, model = SEMANTIC_MODEL) {
  ensureTable();
  const out = new Map();
  if (!hashes.length) return out;
  const stmt = db.getDb().prepare('SELECT text_hash, dims, vector FROM task_text_vectors WHERE model = ? AND text_hash = ?');
  for (const h of hashes) {
    const row = stmt.get(model, h);
    if (row) out.set(h, _fromBlob(row.vector, row.dims));
  }
  return out;
}

function saveVector(hash, vec, model = SEMANTIC_MODEL) {
  ensureTable();
  db.getDb().prepare(`INSERT OR REPLACE INTO task_text_vectors (text_hash, model, dims, vector)
    VALUES (?, ?, ?, ?)`).run(hash, model, vec.length, _toBlob(vec));
}

/** Delete every vector that is not for a wording in `keepHashes` under the current model. */
function prune(keepHashes, model = SEMANTIC_MODEL) {
  ensureTable();
  const keep = new Set(keepHashes);
  const rows = db.getDb().prepare('SELECT text_hash, model FROM task_text_vectors').all();
  const del = db.getDb().prepare('DELETE FROM task_text_vectors WHERE text_hash = ? AND model = ?');
  let removed = 0;
  db.getDb().transaction(() => {
    for (const r of rows) {
      if (r.model === model && keep.has(r.text_hash)) continue;
      del.run(r.text_hash, r.model);
      removed++;
    }
  })();
  return removed;
}

function cacheSize() {
  ensureTable();
  return db.getDb().prepare('SELECT COUNT(*) AS n FROM task_text_vectors').get().n;
}

// ── provider ─────────────────────────────────────────────────────────────────

/**
 * Embed texts. Returns { ok:true, vectors:[...] } in input order, or
 * { ok:false, reason }. Never throws. A partial answer is a failure.
 */
async function voyageEmbed(texts, { timeoutMs = CANDIDATES_TIMEOUT_MS } = {}) {
  if (!process.env.VOYAGE_API_KEY) return { ok: false, reason: 'VOYAGE_API_KEY is not set' };
  try {
    const res = await require('./providers/voyage-provider').post({
      model: SEMANTIC_MODEL,
      input: texts.map(t => String(t).slice(0, MAX_CHARS)),
      input_type: 'document',
    }, { callClass: 'task_dedupe_embed', timeoutMs });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, reason: `Voyage answered ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}` };
    }
    const data = await res.json();
    const vectors = texts.map((_, i) => data && data.data && data.data[i] && data.data[i].embedding);
    if (!vectors.every(v => Array.isArray(v) && v.length > 0)) {
      return { ok: false, reason: `Voyage returned ${vectors.filter(Array.isArray).length}/${texts.length} vectors` };
    }
    return { ok: true, vectors };
  } catch (e) {
    return { ok: false, reason: `Voyage call failed: ${e.message}` };
  }
}

let _provider = voyageEmbed;
/** Tests only: swap the embedding provider. Pass null to restore Voyage. */
function _setProvider(fn) { _provider = fn || voyageEmbed; }

// ── the two entry points ─────────────────────────────────────────────────────

/**
 * Vectors for a set of texts, keyed by normalised text (what task-dedupe's pure
 * ranking reads). Missing wordings are embedded in batches; a failure stops the
 * batching, keeps whatever is cached, and is reported.
 *
 * Returns { vectors: Map|null, semantic: { available, reason, model, threshold,
 *           wordings, cached, embedded, missing } }.
 */
async function vectorsFor(texts, { timeoutMs = CANDIDATES_TIMEOUT_MS, pruneOthers = false } = {}) {
  const semantic = {
    available: false, reason: null, model: SEMANTIC_MODEL,
    threshold: dedupe.SEMANTIC_MIN_SCORE, wordings: 0, cached: 0, embedded: 0, missing: 0,
  };
  if (!enabled()) {
    semantic.reason = 'switched off (TASK_SEMANTIC_DEDUPE_ENABLED=false)';
    return { vectors: null, semantic };
  }
  try {
    const byHash = new Map();
    for (const t of texts) {
      const norm = dedupe.normaliseForEmbedding(t);
      if (!norm) continue;
      const h = hashOf(t);
      if (!byHash.has(h)) byHash.set(h, { norm, raw: String(t) });
    }
    semantic.wordings = byHash.size;
    const hashes = [...byHash.keys()];
    const cached = readCached(hashes);
    semantic.cached = cached.size;

    const missing = hashes.filter(h => !cached.has(h));
    let failure = null;
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const batch = missing.slice(i, i + BATCH_SIZE);
      const out = await _provider(batch.map(h => byHash.get(h).raw), { timeoutMs });
      if (!out || !out.ok) { failure = (out && out.reason) || 'embedding failed'; break; }
      batch.forEach((h, j) => { saveVector(h, out.vectors[j]); cached.set(h, out.vectors[j]); });
      semantic.embedded += batch.length;
    }

    const vectors = new Map();
    for (const [h, v] of cached) vectors.set(byHash.get(h).norm, v);
    semantic.missing = byHash.size - vectors.size;
    if (failure) {
      semantic.reason = `${failure} — ${semantic.missing} of ${byHash.size} wordings have no vector; matching on words for those`;
    } else {
      semantic.available = true;
      if (pruneOthers) semantic.pruned = prune(hashes);
    }
    return { vectors, semantic };
  } catch (e) {
    console.warn('[TaskSemantic] vectors failed:', e.message);
    semantic.reason = `semantic check failed: ${e.message}`;
    return { vectors: null, semantic };
  }
}

function _openRows(excludeId) {
  return db.listTaskRows({ status: 'all', includeDone: false })
    .filter(r => r.id !== excludeId && (r.status === 'open' || r.status === 'in-progress'));
}

/**
 * Capture-time "do I already have this?", with meaning as well as words.
 *
 * Lexical first (task-store.findSimilar, instant). Only if that finds nothing:
 * existing tasks are compared from the CACHE (never embedded here — that is the
 * candidates screen's job), the new text is embedded under a short deadline,
 * and its vector is kept (it is about to be a task). Any miss → null, which is
 * the lexical answer. Never throws: not knowing must never cost the capture.
 *
 * Returns the findSimilar shape plus `why` ('words' | 'meaning') and
 * `semanticScore`, or null.
 */
async function findSimilarSemantic(text, { excludeId = null, timeoutMs = CAPTURE_TIMEOUT_MS } = {}) {
  const query = String(text || '').trim();
  if (!query) return null;
  try {
    const lexical = require('./task-store').findSimilar(query, { excludeId });
    if (lexical) return { ...lexical, why: 'words', semanticScore: null };
    if (!enabled()) return null;

    const rows = _openRows(excludeId);
    if (!rows.length) return null;
    const cached = readCached(rows.map(r => hashOf(r.text)));
    if (!cached.size) return null;

    const qHash = hashOf(query);
    let qVec = readCached([qHash]).get(qHash);
    if (!qVec) {
      let timer;
      const out = await Promise.race([
        _provider([query], { timeoutMs }),
        new Promise(r => { timer = setTimeout(() => r({ ok: false, reason: 'timeout' }), timeoutMs + 200); }),
      ]).finally(() => clearTimeout(timer));
      if (!out || !out.ok) {
        console.warn(`[TaskSemantic] capture check fell back to words: ${out && out.reason}`);
        return null;
      }
      qVec = out.vectors[0];
      try { saveVector(qHash, qVec); } catch { /* cache is an optimisation */ }
    }

    let best = null;
    for (const r of rows) {
      const v = cached.get(hashOf(r.text));
      const c = dedupe.cosine(qVec, v);
      if (c == null || c < dedupe.SEMANTIC_MIN_SCORE) continue;
      if (!best || c > best.c) best = { r, c };
    }
    if (!best) return null;
    const score = Number(best.c.toFixed(3));
    return {
      id: best.r.id,
      text: best.r.text,
      status: best.r.status,
      due_date: best.r.due_date || null,
      moscow: best.r.moscow || null,
      score,
      sharedWords: [],
      why: 'meaning',
      semanticScore: score,
    };
  } catch (e) {
    console.warn('[TaskSemantic] capture check failed:', e.message);
    return null;
  }
}

module.exports = {
  SEMANTIC_MODEL,
  BATCH_SIZE,
  CAPTURE_TIMEOUT_MS,
  hashOf,
  readCached,
  saveVector,
  prune,
  cacheSize,
  vectorsFor,
  findSimilarSemantic,
  _setProvider,
};
