'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';
const SKIP_DIRS = new Set(['Daily', 'Scripts', 'Templates', '.obsidian', '.git', '.trash', 'Imports']);
const MAX_CHUNK_CHARS = 1500; // keep well within token limits

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function contentHash(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function stripFrontmatter(content) {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('---', 3);
  if (end === -1) return content;
  return content.slice(end + 3).replace(/^\n+/, '');
}

function chunkText(text) {
  // Split on paragraph breaks — keep chunks under MAX_CHUNK_CHARS
  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let current = '';
  for (const para of paragraphs) {
    if (current.length + para.length > MAX_CHUNK_CHARS && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(c => c.length > 20);
}

async function getEmbedding(text) {
  // Try Anthropic embeddings API first
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Check if embeddings endpoint exists on the client
    if (typeof client.embeddings?.create === 'function') {
      const response = await client.embeddings.create({
        model: 'voyage-3',
        input: [text],
        input_type: 'document'
      });
      return response.embeddings?.[0]?.embedding || null;
    }
  } catch (e) {
    console.warn('[Embeddings] Anthropic embeddings API not available:', e.message);
  }

  // Fallback: use Claude to generate a semantic summary vector approximation
  // This produces a 128-dim vector from a TF-IDF style word frequency approach
  // Not true semantic embeddings but much better than pure keyword matching
  return computeSimpleVector(text);
}

// Simple TF-IDF style vector — 128 dimensions based on word hashing
// Used as fallback when embeddings API unavailable
function computeSimpleVector(text) {
  const STOP_WORDS = new Set(['the','a','an','and','or','but','in','on','at','to','for',
    'of','with','is','are','was','were','it','this','that','be','have','has','had']);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));

  const vector = new Array(128).fill(0);
  for (const word of words) {
    // Hash word to bucket
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = (hash * 31 + word.charCodeAt(i)) & 0x7fffffff;
    }
    vector[hash % 128] += 1;
  }
  // Normalize
  const magnitude = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
  return vector.map(v => v / magnitude);
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

async function embedVaultFile(relativePath, fullPath) {
  let content;
  try { content = fs.readFileSync(fullPath, 'utf-8'); }
  catch { return false; }

  const body = stripFrontmatter(content);
  if (body.trim().length < 20) return false;

  const hash = contentHash(body);
  const stats = fs.statSync(fullPath);
  const modified = stats.mtime.toISOString();

  // Check if already embedded with same content
  const existing = db.getEmbedding(relativePath);
  if (existing && existing.content_hash === hash) return false; // unchanged

  // Embed first chunk only for now (sufficient for search)
  const chunks = chunkText(body);
  if (chunks.length === 0) return false;

  const primaryChunk = chunks[0];
  const embedding = await getEmbedding(primaryChunk);
  if (!embedding) return false;

  db.saveEmbedding(relativePath, hash, embedding, primaryChunk, modified);
  return true;
}

function listVaultFiles() {
  if (!VAULT_PATH) return [];
  const results = [];

  function walk(dir, depth) {
    if (depth > 4) return;
    if (!fs.existsSync(dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(fullPath, depth + 1);
      } else if (entry.name.endsWith('.md')) {
        const relativePath = path.relative(VAULT_PATH, fullPath).replace(/\\/g, '/');
        results.push({ relativePath, fullPath });
      }
    }
  }

  walk(VAULT_PATH, 0);
  return results;
}

async function rebuildEmbeddings(onProgress) {
  if (!isConfigured()) {
    console.log('[Embeddings] No API key — using simple vector fallback');
  }

  const files = listVaultFiles();
  console.log(`[Embeddings] Rebuilding — ${files.length} files to check`);

  let updated = 0, skipped = 0, errors = 0;

  for (let i = 0; i < files.length; i++) {
    const { relativePath, fullPath } = files[i];
    try {
      const changed = await embedVaultFile(relativePath, fullPath);
      if (changed) updated++;
      else skipped++;
    } catch (e) {
      console.error(`[Embeddings] Error embedding ${relativePath}:`, e.message);
      errors++;
    }

    // Brief pause every 10 files to avoid hammering the API
    if (i % 10 === 9) {
      await new Promise(r => setTimeout(r, 200));
    }

    if (onProgress) onProgress({ i: i + 1, total: files.length, updated, skipped });
  }

  console.log(`[Embeddings] Done — ${updated} updated, ${skipped} unchanged, ${errors} errors`);
  return { updated, skipped, errors };
}

async function semanticSearch(query, maxResults = 5) {
  // Get all stored embeddings
  const allEmbeddings = db.getAllEmbeddings();
  if (allEmbeddings.length === 0) {
    console.log('[Embeddings] No embeddings yet — falling back to keyword search');
    return null; // caller should fall back to keyword search
  }

  // Embed the query
  const queryEmbedding = await getEmbedding(query);
  if (!queryEmbedding) return null;

  // Score all embeddings
  const scored = allEmbeddings
    .map(row => {
      let embedding;
      try { embedding = JSON.parse(row.embedding); }
      catch { return null; }
      const score = cosineSimilarity(queryEmbedding, embedding);
      return { relativePath: row.relative_path, chunkText: row.chunk_text, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .filter(r => r.score > 0.1); // minimum relevance threshold

  return scored.map(r => ({
    path: r.relativePath,
    name: path.basename(r.relativePath, '.md'),
    excerpts: [r.chunkText ? r.chunkText.slice(0, 300) : ''],
    score: r.score
  }));
}

module.exports = {
  isConfigured,
  rebuildEmbeddings,
  semanticSearch,
  embedVaultFile,
  listVaultFiles
};
