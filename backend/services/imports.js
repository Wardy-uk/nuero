const fs = require('fs');
const path = require('path');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

function broadcast(event) {
  try {
    const nudges = require('./nudges');
    if (typeof nudges.broadcast === 'function') {
      nudges.broadcast(event);
    }
  } catch (e) {
    // nudges not yet initialised or circular dep — ignore
  }
}

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

  // Load stored classifications for cross-device display
  let storedClassifications = {};
  try {
    const db = require('../db/database');
    const allCls = db.getAllImportClassifications();
    for (const cls of allCls) {
      storedClassifications[cls.relative_path] = cls;
    }
  } catch (e) { /* non-fatal — classifications just won't show */ }

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
      preview: content.replace(/^---[\s\S]*?---\n*/, '').slice(0, 200),
      storedClassification: storedClassifications[relativePath] || null
    });
  }

  return pending.sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

function buildClassifyPrompt(fileName, content) {
  const body = content.replace(/^---[\s\S]*?---\n*/, '').slice(0, 400);
  return `You are a filing assistant for an Obsidian vault. Classify the note below and suggest which vault folder it belongs in.

VAULT FOLDERS (choose destination from this list only):
- Meetings/         → meeting notes, call notes, discussion summaries
- Calls/            → call notes (use when explicitly a phone or video call)
- People/           → notes about a specific person (1-2-1s, feedback, personal updates)
- Ideas/            → ideas, concepts, brainstorms, things to explore
- Projects/         → notes tied to a specific named project
- Areas/            → ongoing responsibilities (health, finance, leadership, team management)
- Decision Log/     → a decision that was made
- Reflections/      → personal reflections, journal entries, retrospectives
- Imports/PLAUD/    → voice recording transcripts from PLAUD device
- Archive/          → anything that doesn't fit elsewhere or is low value

TYPES (choose one):
meeting-note, call-note, action, decision, idea, reference, person-update, plaud-transcript, reflection, needs-review

RULES:
- If content is fewer than 10 meaningful words with no clear category, type MUST be needs-review
- destination MUST be exactly one folder name from the list above — nothing else
- confidence is high only if the type and destination are completely obvious
- If genuinely unsure, use needs-review with low confidence

Filename: ${fileName}
Content:
${body}

Respond in EXACTLY this format with no other text:
type: <type>
destination: <folder name>
confidence: <high|medium|low>
reason: <one sentence>`;
}

async function classifyWithClaude(fileName, content) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: buildClassifyPrompt(fileName, content)
    }]
  });

  return response.content[0]?.text || '';
}

async function classifyWithOllama(fileName, content) {
  const ollamaRes = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: buildClassifyPrompt(fileName, content),
      stream: false,
      options: { temperature: 0.1, num_predict: 256 }
    })
  });

  if (!ollamaRes.ok) {
    throw new Error(`Ollama error: ${ollamaRes.status}`);
  }

  const data = await ollamaRes.json();
  return data.response || '';
}

async function classifyFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const fileName = path.basename(filePath);
  const relativePath = path.relative(getVaultPath(), filePath).replace(/\\/g, '/');

  let responseText = '';
  let backend = 'claude';

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      responseText = await classifyWithClaude(fileName, content);
      console.log(`[Imports] Classified ${fileName} via Claude`);
    } catch (claudeErr) {
      console.warn(`[Imports] Claude classification failed, falling back to Ollama: ${claudeErr.message}`);
      backend = 'ollama';
      responseText = await classifyWithOllama(fileName, content);
      console.log(`[Imports] Classified ${fileName} via Ollama`);
    }
  } else {
    backend = 'ollama';
    console.log(`[Imports] No ANTHROPIC_API_KEY — using Ollama for ${fileName}`);
    responseText = await classifyWithOllama(fileName, content);
  }

  const typeMatch = responseText.match(/type:\s*(\S+)/i);
  const destMatch = responseText.match(/destination:\s*(.+)/i);
  const confMatch = responseText.match(/confidence:\s*(\S+)/i);
  const reasonMatch = responseText.match(/reason:\s*(.+)/i);

  const classification = {
    type: typeMatch ? typeMatch[1].replace(/[^a-z-]/g, '') : 'needs-review',
    destination: destMatch ? destMatch[1].trim() : null,
    confidence: confMatch ? confMatch[1].toLowerCase() : 'low',
    reason: reasonMatch ? reasonMatch[1].trim() : 'Could not parse classification',
    backend,
    rawResponse: responseText
  };

  // Force needs-review for low confidence or missing destination
  if (classification.confidence === 'low' || !classification.destination) {
    classification.type = 'needs-review';
  }

  // Validate destination is a real vault folder — reject invented paths
  const VALID_DESTINATIONS = [
    'Meetings/', 'Calls/', 'People/', 'Ideas/', 'Projects/',
    'Areas/', 'Decision Log/', 'Reflections/', 'Imports/PLAUD/', 'Archive/'
  ];
  if (classification.destination && !VALID_DESTINATIONS.some(d => classification.destination.startsWith(d.replace('/', '')))) {
    console.warn(`[Imports] Invalid destination "${classification.destination}" — forcing needs-review`);
    classification.type = 'needs-review';
    classification.confidence = 'low';
    classification.destination = null;
  }

  // Persist classification to DB for cross-device access
  try {
    const db = require('../db/database');
    db.saveImportClassification(relativePath, classification);
  } catch (e) {
    console.warn('[Imports] Failed to persist classification:', e.message);
  }

  broadcast({
    type: 'classification_ready',
    filePath: filePath,
    relativePath: relativePath,
    classification
  });

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

  broadcast({
    type: 'file_actioned',
    filePath: filePath,
    action: 'routed'
  });

  // Remove classification from DB — file has been actioned
  try {
    const db = require('../db/database');
    const relativePath = path.relative(vaultPath, filePath).replace(/\\/g, '/');
    db.deleteImportClassification(relativePath);
  } catch (e) { /* non-fatal */ }

  return path.relative(vaultPath, finalPath).replace(/\\/g, '/');
}

// Batch classify and route all pending imports
async function autoClassify() {
  const db = require('../db/database');

  // Prevent concurrent sweeps
  const sweepRunning = db.getState('imports_sweep_running');
  if (sweepRunning === 'true') {
    console.log('[Imports] Sweep already running — skipping');
    return { routed: 0, flagged: 0, errors: 0, skipped: true };
  }
  db.setState('imports_sweep_running', 'true');

  try {
    const pending = getPending().filter(f => f.status !== 'needs-review');

    if (pending.length === 0) {
      console.log('[Imports] No pending files to classify');
      db.setState('imports_sweep_running', 'false');
      const empty = { routed: 0, flagged: 0, errors: 0, timestamp: new Date().toISOString() };
      broadcast({ type: 'sweep_complete', ...empty });
      return empty;
    }

    console.log(`[Imports] Auto-classifying ${pending.length} files...`);
    broadcast({ type: 'sweep_started', total: pending.length });
    let routed = 0, flagged = 0, errors = 0;
    let fileIndex = 0;

    // Process in batches of 3 concurrently (Claude API handles parallel requests well)
    // Ollama fallback still needs sequential — detect which backend we're using
    const useConcurrent = !!process.env.ANTHROPIC_API_KEY;
    const BATCH_SIZE = useConcurrent ? 3 : 1;

    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);

      await Promise.allSettled(batch.map(async (file) => {
        try {
          const cls = await classifyFile(file.filePath);
          console.log(`[Imports] ${file.fileName}: ${cls.type} (${cls.confidence}) → ${cls.destination}`);

          broadcast({
            type: 'sweep_progress',
            file: file.fileName,
            relativePath: file.relativePath,
            index: fileIndex++,
            total: pending.length,
            classification: cls
          });

          if ((cls.confidence === 'high' || cls.confidence === 'medium') && cls.destination) {
            const newPath = routeFile(file.filePath, cls.destination, cls.type);
            console.log(`[Imports] Routed → ${newPath}`);
            routed++;
            if (cls.type === 'plaud-transcript') {
              const webpush = require('./webpush');
              webpush.sendToAll(
                'NEURO — PLAUD Transcript Ready',
                `Transcript filed to ${cls.destination}. Ready to review.`,
                { type: 'plaud', url: '/vault' }
              ).catch(() => {});
            }
          } else {
            updateFrontmatter(file.filePath, {
              status: 'needs-review',
              'review-reason': cls.reason || 'Low confidence classification'
            });
            // Remove any stored classification — file is flagged, will show as needs-review
            try {
              const db = require('../db/database');
              db.deleteImportClassification(file.relativePath);
            } catch (e) { /* non-fatal */ }
            flagged++;
          }
        } catch (e) {
          console.error(`[Imports] Error classifying ${file.fileName}:`, e.message);
          errors++;
        }
      }));

      // Brief pause between batches — respect rate limits
      if (i + BATCH_SIZE < pending.length) {
        await new Promise(r => setTimeout(r, useConcurrent ? 200 : 500));
      }
    }

    const summary = { routed, flagged, errors, timestamp: new Date().toISOString() };
    console.log(`[Imports] Sweep complete: ${routed} routed, ${flagged} flagged, ${errors} errors`);
    db.setState('imports_last_sweep', JSON.stringify(summary));
    db.setState('imports_sweep_running', 'false');
    broadcast({ type: 'sweep_complete', ...summary });

    return summary;
  } finally {
    db.setState('imports_sweep_running', 'false');
  }
}

module.exports = { getPending, getImportsPath, classifyFile, routeFile, updateFrontmatter, autoClassify };
