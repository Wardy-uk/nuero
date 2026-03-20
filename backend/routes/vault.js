const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';

// API key auth for external callers (n8n, etc.)
// If no key is sent, allow through (frontend / same-origin).
// If a key IS sent, it must match.
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) return next(); // no key sent = frontend request, allow
  const expected = process.env.VAULT_API_KEY;
  if (expected && key !== expected) return res.status(401).json({ error: 'Invalid API key' });
  next();
}

router.use(requireApiKey);

// Resolve and validate path stays within vault
function safePath(relativePath) {
  if (relativePath === undefined || relativePath === null) return null;
  const resolved = path.resolve(VAULT_PATH, relativePath);
  if (!resolved.startsWith(path.resolve(VAULT_PATH))) return null; // path traversal guard
  return resolved;
}

// GET /api/vault/read?path=relative/path.md
router.get('/read', (req, res) => {
  const filePath = safePath(req.query.path);
  if (!filePath) return res.status(400).json({ error: 'Invalid or missing path' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found', path: req.query.path });
  const content = fs.readFileSync(filePath, 'utf-8');
  res.json({ path: req.query.path, content });
});

// POST /api/vault/write  { path: "relative/path.md", content: "..." }
router.post('/write', (req, res) => {
  const { path: relPath, content } = req.body;
  if (!relPath || content === undefined) return res.status(400).json({ error: 'path and content required' });
  const filePath = safePath(relPath);
  if (!filePath) return res.status(400).json({ error: 'Invalid path' });
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  res.json({ success: true, path: relPath });
});

// POST /api/vault/append  { path: "relative/path.md", content: "..." }
router.post('/append', (req, res) => {
  const { path: relPath, content } = req.body;
  if (!relPath || !content) return res.status(400).json({ error: 'path and content required' });
  const filePath = safePath(relPath);
  if (!filePath) return res.status(400).json({ error: 'Invalid path' });
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  fs.writeFileSync(filePath, existing + content, 'utf-8');
  res.json({ success: true, path: relPath });
});

// GET /api/vault/list?dir=relative/dir
router.get('/list', (req, res) => {
  const dirPath = safePath(req.query.dir || '');
  if (!dirPath) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(dirPath)) return res.status(404).json({ error: 'Directory not found' });
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = entries.map(e => ({
    name: e.name,
    type: e.isDirectory() ? 'directory' : 'file'
  }));
  res.json({ dir: req.query.dir || '', files });
});

// GET /api/vault/search?query=term&dir=optional/subdir
router.get('/search', (req, res) => {
  const { query, dir } = req.query;
  if (!query) return res.status(400).json({ error: 'query required' });

  const searchDir = safePath(dir || '');
  if (!searchDir) return res.status(400).json({ error: 'Invalid path' });

  const results = [];
  const maxResults = 20;

  function searchRecursive(dirPath, depth) {
    if (depth > 4 || results.length >= maxResults) return;
    if (!fs.existsSync(dirPath)) return;

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        searchRecursive(fullPath, depth + 1);
      } else if (entry.name.endsWith('.md')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (content.toLowerCase().includes(query.toLowerCase())) {
          const relPath = path.relative(VAULT_PATH, fullPath).replace(/\\/g, '/');
          // Find matching lines for context
          const lines = content.split('\n');
          const matches = [];
          for (let i = 0; i < lines.length && matches.length < 3; i++) {
            if (lines[i].toLowerCase().includes(query.toLowerCase())) {
              matches.push({ line: i + 1, text: lines[i].substring(0, 200) });
            }
          }
          results.push({ path: relPath, matches });
        }
      }
    }
  }

  searchRecursive(searchDir, 0);
  res.json({ query, results });
});

module.exports = router;
