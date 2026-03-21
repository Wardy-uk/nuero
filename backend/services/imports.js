const fs = require('fs');
const path = require('path');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:0.5b';

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

// Update or add frontmatter fields to a markdown file
function updateFrontmatter(filePath, fields) {
  let content = fs.readFileSync(filePath, 'utf-8');
  let fm = {};
  let body = content;

  if (content.startsWith('---')) {
    const endIdx = content.indexOf('---', 3);
    if (endIdx !== -1) {
      const fmBlock = content.slice(3, endIdx).trim();
      body = content.slice(endIdx + 3).replace(/^\n+/, '');
      for (const line of fmBlock.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;
        fm[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
      }
    }
  }

  Object.assign(fm, fields);
  const fmStr = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  const newContent = `---\n${fmStr}\n---\n${body}`;
  fs.writeFileSync(filePath, newContent, 'utf-8');
  return newContent;
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

// Classify a single file using Ollama
async function classifyFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const fileName = path.basename(filePath);

  const prompt = `Classify this note for filing into an Obsidian vault. Based on the filename and content, choose ONE type from this list:

- meeting-note: Meeting notes, call notes, discussion summaries
- action: A task, to-do, or action item
- decision: A decision that was made
- idea: An idea, concept, or brainstorm
- reference: Reference material, documentation, how-to
- person-update: Notes about a specific person (1-2-1, feedback, etc.)
- plaud-transcript: Voice recording transcript
- needs-review: Cannot classify with confidence

Also suggest the best destination folder.

Filename: ${fileName}
Content (first 500 chars):
${content.slice(0, 500)}

Respond in exactly this format (no other text):
type: <type>
destination: <folder path>
confidence: <high|medium|low>
reason: <one sentence>`;

  const ollamaRes = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.1 }
    })
  });

  if (!ollamaRes.ok) {
    throw new Error(`Ollama error: ${ollamaRes.status}`);
  }

  const data = await ollamaRes.json();
  const response = data.response || '';

  const typeMatch = response.match(/type:\s*(\S+)/i);
  const destMatch = response.match(/destination:\s*(.+)/i);
  const confMatch = response.match(/confidence:\s*(\S+)/i);
  const reasonMatch = response.match(/reason:\s*(.+)/i);

  const classification = {
    type: typeMatch ? typeMatch[1].replace(/[^a-z-]/g, '') : 'needs-review',
    destination: destMatch ? destMatch[1].trim() : null,
    confidence: confMatch ? confMatch[1].toLowerCase() : 'low',
    reason: reasonMatch ? reasonMatch[1].trim() : 'Could not parse classification',
    rawResponse: response
  };

  if (classification.confidence === 'low') {
    classification.type = 'needs-review';
  }

  return classification;
}

// Route a file to its destination
function routeFile(filePath, destination, type) {
  const vaultPath = getVaultPath();

  updateFrontmatter(filePath, {
    type: type || 'unknown',
    status: 'processed',
    'routed-date': new Date().toISOString().slice(0, 10)
  });

  const destDir = path.resolve(vaultPath, destination);
  if (!destDir.startsWith(path.resolve(vaultPath))) {
    throw new Error('Destination outside vault');
  }
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const fileName = path.basename(filePath);
  let finalPath = path.join(destDir, fileName);
  if (fs.existsSync(finalPath)) {
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    finalPath = path.join(destDir, `${base}-${Date.now()}${ext}`);
  }

  fs.renameSync(filePath, finalPath);
  return path.relative(vaultPath, finalPath).replace(/\\/g, '/');
}

// Batch classify and route all pending imports
async function autoClassify() {
  const db = require('../db/database');
  const pending = getPending().filter(f => f.status !== 'needs-review');

  if (pending.length === 0) {
    console.log('[Imports] No pending files to classify');
    return { routed: 0, flagged: 0, errors: 0 };
  }

  console.log(`[Imports] Auto-classifying ${pending.length} files...`);
  let routed = 0, flagged = 0, errors = 0;

  for (const file of pending) {
    try {
      const cls = await classifyFile(file.filePath);
      console.log(`[Imports] ${file.fileName}: ${cls.type} (${cls.confidence}) → ${cls.destination}`);

      if ((cls.confidence === 'high' || cls.confidence === 'medium') && cls.destination) {
        const newPath = routeFile(file.filePath, cls.destination, cls.type);
        console.log(`[Imports] Routed → ${newPath}`);
        routed++;
      } else {
        updateFrontmatter(file.filePath, {
          status: 'needs-review',
          'review-reason': cls.reason || 'Low confidence classification'
        });
        flagged++;
      }
    } catch (e) {
      console.error(`[Imports] Error classifying ${file.fileName}:`, e.message);
      errors++;
    }

    // 500ms between files — Ollama needs breathing room on Pi
    await new Promise(r => setTimeout(r, 500));
  }

  const summary = { routed, flagged, errors, timestamp: new Date().toISOString() };
  console.log(`[Imports] Sweep complete: ${routed} routed, ${flagged} flagged, ${errors} errors`);
  db.setState('imports_last_sweep', JSON.stringify(summary));

  return summary;
}

module.exports = { getPending, getImportsPath, classifyFile, routeFile, updateFrontmatter, autoClassify };
