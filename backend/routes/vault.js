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

// GET /api/vault/search/temporal?query=X&from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/search/temporal', async (req, res) => {
  const { query, from, to, limit = 5 } = req.query;
  if (!query) return res.status(400).json({ error: 'query required' });

  const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const toDate = to ? new Date(to) : new Date();

  const results = [];
  const SKIP_DIRS = new Set(['.obsidian', '.git', '.trash', 'Imports']);

  function walk(dir, depth) {
    if (depth > 4 || results.length >= parseInt(limit) * 3) return;
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(fullPath, depth + 1);
      } else if (entry.name.endsWith('.md')) {
        const stat = fs.statSync(fullPath);
        const modified = new Date(stat.mtime);
        if (modified < fromDate || modified > toDate) continue;

        const content = fs.readFileSync(fullPath, 'utf-8');
        if (!content.toLowerCase().includes(query.toLowerCase())) continue;

        const relPath = path.relative(VAULT_PATH, fullPath).replace(/\\/g, '/');
        const body = content.replace(/^---[\s\S]*?---\n*/, '');
        const lines = body.split('\n');
        const excerpts = [];
        for (let i = 0; i < lines.length && excerpts.length < 2; i++) {
          if (lines[i].toLowerCase().includes(query.toLowerCase())) {
            excerpts.push(lines[i].substring(0, 200));
          }
        }
        results.push({
          path: relPath,
          name: entry.name.replace('.md', ''),
          modified: stat.mtime,
          excerpts
        });
      }
    }
  }

  walk(VAULT_PATH, 0);
  results.sort((a, b) => new Date(b.modified) - new Date(a.modified));

  res.json({ results: results.slice(0, parseInt(limit)), from: fromDate, to: toDate });
});

// POST /api/vault/export-docx — create a Word doc from markdown content
router.post('/export-docx', async (req, res) => {
  const { content, filename, subdir } = req.body;
  if (!content || !filename) {
    return res.status(400).json({ error: 'content and filename required' });
  }

  const safeName = filename.replace(/[^a-z0-9\s\-_]/gi, '').trim() || 'export';
  const docxName = safeName.endsWith('.docx') ? safeName : `${safeName}.docx`;

  const targetDir = path.join(VAULT_PATH, subdir || 'Exports');
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, docxName);

  const mdContent = `---\ntype: export\nexported: ${new Date().toISOString()}\noriginal_format: docx\n---\n\n${content}`;
  const mdPath = path.join(targetDir, docxName.replace('.docx', '.md'));
  fs.writeFileSync(mdPath, mdContent, 'utf-8');

  const relPath = path.relative(VAULT_PATH, mdPath).replace(/\\/g, '/');

  // Try Pandoc conversion if available
  const { execSync } = require('child_process');
  let converted = false;
  try {
    execSync(`pandoc "${mdPath}" -o "${targetPath}" --from markdown`, { timeout: 10000 });
    converted = true;
    console.log(`[Vault] Pandoc converted to docx: ${targetPath}`);
  } catch {
    console.log('[Vault] Pandoc not available — saved as markdown');
  }

  res.json({
    ok: true,
    path: relPath,
    docxPath: converted ? path.relative(VAULT_PATH, targetPath).replace(/\\/g, '/') : null,
    filename: docxName,
    converted,
    vaultUrl: `/vault?open=${encodeURIComponent(relPath)}`
  });
});

// GET /api/vault/related?path=relative/path&limit=3
router.get('/related', async (req, res) => {
  try {
    const { path: notePath, limit = 3 } = req.query;
    if (!notePath) return res.status(400).json({ error: 'path required' });

    const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
    const fullPath = path.join(vaultPath, notePath);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Note not found' });
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    const body = content.replace(/^---[\s\S]*?---\n*/, '').substring(0, 500);

    const obsidian = require('../services/obsidian');
    const results = await obsidian.searchVaultSemantic(body, parseInt(limit) + 1);

    // Exclude the note itself from results
    const related = (results || [])
      .filter(r => r.path !== notePath)
      .slice(0, parseInt(limit));

    res.json({ related });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
