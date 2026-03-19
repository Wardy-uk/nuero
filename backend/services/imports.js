const fs = require('fs');
const path = require('path');

function getVaultPath() {
  return process.env.OBSIDIAN_VAULT_PATH || '';
}

function getImportsPath() {
  return path.join(getVaultPath(), 'Imports');
}

// Recursively list all .md files in Imports/ and subdirs
function listAllFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip .obsidian, .trash etc
      if (entry.name.startsWith('.')) continue;
      results.push(...listAllFiles(fullPath));
    } else if (entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

// Parse frontmatter from markdown content
function parseFrontmatter(content) {
  if (!content.startsWith('---')) return {};
  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return {};
  const fm = content.slice(3, endIdx).trim();
  const result = {};
  for (const line of fm.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    result[key] = val;
  }
  return result;
}

// Get pending (unprocessed) import files
function getPending() {
  const importsDir = getImportsPath();
  if (!fs.existsSync(importsDir)) return [];

  const allFiles = listAllFiles(importsDir);
  const pending = [];

  for (const filePath of allFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fm = parseFrontmatter(content);

    // Skip files already processed or marked needs-review
    if (fm.status === 'processed') continue;

    const relativePath = path.relative(getVaultPath(), filePath).replace(/\\/g, '/');
    const subdir = path.relative(importsDir, path.dirname(filePath)).replace(/\\/g, '/');
    const stats = fs.statSync(filePath);

    pending.push({
      filePath,
      relativePath,
      fileName: path.basename(filePath),
      subdir: subdir === '.' ? '' : subdir,
      status: fm.status || null,
      size: stats.size,
      modified: stats.mtime.toISOString(),
      preview: content.replace(/^---[\s\S]*?---\n*/, '').slice(0, 200)
    });
  }

  return pending.sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

module.exports = { getPending, getImportsPath };
