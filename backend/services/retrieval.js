'use strict';

const fs = require('fs');
const path = require('path');
const embeddings = require('./embeddings');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';
const RRF_K = 60; // standard RRF constant

/**
 * Unified retrieval — runs keyword, semantic, and temporal search in parallel,
 * fuses results using Reciprocal Rank Fusion (RRF).
 *
 * @param {string} query - search query
 * @param {object} options
 * @param {number} options.maxResults - max results to return (default 5)
 * @param {string} options.scope - optional scope filter: "person:Name", "folder:Path"
 * @param {string} options.from - temporal start date (YYYY-MM-DD)
 * @param {string} options.to - temporal end date (YYYY-MM-DD)
 * @returns {Promise<Array<{path, name, excerpts, score, sources}>>}
 */
async function search(query, options = {}) {
  const { maxResults = 5, scope, from, to } = options;

  // Run all retrieval methods in parallel
  const [keywordResults, semanticResults, temporalResults] = await Promise.all([
    keywordSearch(query, { scope, maxResults: maxResults * 2 }),
    semanticSearchWrapper(query, { maxResults: maxResults * 2 }),
    (from || to) ? temporalSearch(query, { from, to, maxResults: maxResults * 2 }) : Promise.resolve([])
  ]);

  // Fuse with RRF
  const fused = rrfFuse([
    { results: keywordResults, weight: 1.0 },
    { results: semanticResults, weight: 1.2 },  // slight boost for semantic
    { results: temporalResults, weight: 0.8 }
  ]);

  return fused.slice(0, maxResults);
}

/**
 * Reciprocal Rank Fusion — combines ranked lists into a single ranked list.
 * score(doc) = Σ weight_i / (K + rank_i(doc))
 */
function rrfFuse(rankedLists) {
  const scores = new Map(); // path → { score, data }

  for (const { results, weight } of rankedLists) {
    for (let rank = 0; rank < results.length; rank++) {
      const item = results[rank];
      const rrfScore = weight / (RRF_K + rank + 1);
      const existing = scores.get(item.path);
      if (existing) {
        existing.score += rrfScore;
        existing.sources.push(...(item.sources || []));
        // Merge excerpts (deduplicated)
        for (const exc of (item.excerpts || [])) {
          if (!existing.excerpts.includes(exc)) {
            existing.excerpts.push(exc);
          }
        }
      } else {
        scores.set(item.path, {
          path: item.path,
          name: item.name,
          excerpts: [...(item.excerpts || [])],
          score: rrfScore,
          sources: [...(item.sources || [])],
          modified: item.modified || null
        });
      }
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(r => ({
      ...r,
      excerpts: r.excerpts.slice(0, 3),
      sources: [...new Set(r.sources)]
    }));
}

/**
 * Keyword search — scans vault files for exact keyword matches.
 */
async function keywordSearch(query, options = {}) {
  const { scope, maxResults = 10 } = options;
  if (!VAULT_PATH || !query) return [];

  const searchTerms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
  if (searchTerms.length === 0) return [];

  const results = [];
  const SKIP = new Set(['.obsidian', '.git', '.trash', 'Scripts', 'Templates']);

  function walk(dir, depth) {
    if (depth > 4 || results.length >= maxResults * 2) return;
    if (!fs.existsSync(dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        // Scope filtering
        if (scope && scope.startsWith('folder:')) {
          const scopeFolder = scope.slice(7);
          const relDir = path.relative(VAULT_PATH, fullPath).replace(/\\/g, '/');
          if (!relDir.startsWith(scopeFolder) && !scopeFolder.startsWith(relDir)) continue;
        }
        walk(fullPath, depth + 1);
      } else if (entry.name.endsWith('.md')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const lower = content.toLowerCase();
        const matchCount = searchTerms.filter(t => lower.includes(t)).length;
        if (matchCount === 0) continue;

        // Scope: person filter
        if (scope && scope.startsWith('person:')) {
          const personName = scope.slice(7).toLowerCase();
          if (!lower.includes(personName)) continue;
        }

        const relPath = path.relative(VAULT_PATH, fullPath).replace(/\\/g, '/');
        const body = content.replace(/^---[\s\S]*?---\n*/, '');
        const lines = body.split('\n');
        const excerpts = [];
        for (let i = 0; i < lines.length && excerpts.length < 2; i++) {
          const ll = lines[i].toLowerCase();
          if (searchTerms.some(t => ll.includes(t))) {
            excerpts.push(lines[i].substring(0, 200));
          }
        }

        const stat = fs.statSync(fullPath);
        results.push({
          path: relPath,
          name: entry.name.replace('.md', ''),
          excerpts,
          score: matchCount / searchTerms.length,
          sources: ['keyword'],
          modified: stat.mtime.toISOString()
        });
      }
    }
  }

  walk(VAULT_PATH, 0);
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}

/**
 * Semantic search wrapper — calls embeddings service.
 */
async function semanticSearchWrapper(query, options = {}) {
  const { maxResults = 10 } = options;
  try {
    const results = await embeddings.semanticSearch(query, maxResults);
    if (!results) return [];
    return results.map(r => ({
      ...r,
      sources: ['semantic']
    }));
  } catch (e) {
    console.warn('[Retrieval] Semantic search failed:', e.message);
    return [];
  }
}

/**
 * Temporal search — finds notes modified within a date range that match query.
 */
async function temporalSearch(query, options = {}) {
  const { from, to, maxResults = 10 } = options;
  if (!VAULT_PATH) return [];

  const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const toDate = to ? new Date(to) : new Date();

  const searchTerms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
  const results = [];
  const SKIP = new Set(['.obsidian', '.git', '.trash', 'Scripts', 'Templates']);

  function walk(dir, depth) {
    if (depth > 4 || results.length >= maxResults * 2) return;
    if (!fs.existsSync(dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        walk(fullPath, depth + 1);
      } else if (entry.name.endsWith('.md')) {
        const stat = fs.statSync(fullPath);
        const modified = new Date(stat.mtime);
        if (modified < fromDate || modified > toDate) continue;

        // Also check daily note filenames (YYYY-MM-DD.md)
        const dateMatch = entry.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
        if (dateMatch) {
          const noteDate = new Date(dateMatch[1]);
          if (noteDate < fromDate || noteDate > toDate) continue;
        }

        const content = fs.readFileSync(fullPath, 'utf-8');
        const lower = content.toLowerCase();
        const matchCount = searchTerms.length > 0
          ? searchTerms.filter(t => lower.includes(t)).length
          : 1; // If no search terms (pure temporal), include all files in range
        if (searchTerms.length > 0 && matchCount === 0) continue;

        const relPath = path.relative(VAULT_PATH, fullPath).replace(/\\/g, '/');
        const body = content.replace(/^---[\s\S]*?---\n*/, '');
        const excerpts = [];
        const lines = body.split('\n');
        for (let i = 0; i < lines.length && excerpts.length < 2; i++) {
          if (searchTerms.length === 0 || searchTerms.some(t => lines[i].toLowerCase().includes(t))) {
            if (lines[i].trim()) excerpts.push(lines[i].substring(0, 200));
          }
        }

        results.push({
          path: relPath,
          name: entry.name.replace('.md', ''),
          excerpts,
          score: matchCount / Math.max(searchTerms.length, 1),
          sources: ['temporal'],
          modified: stat.mtime.toISOString()
        });
      }
    }
  }

  walk(VAULT_PATH, 0);
  results.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  return results.slice(0, maxResults);
}

module.exports = { search, keywordSearch, semanticSearch: semanticSearchWrapper, temporalSearch };
