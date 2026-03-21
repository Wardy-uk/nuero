const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const importsService = require('../services/imports');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:0.5b';
const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';

function isWithinVault(filePath) {
  return filePath.startsWith(path.resolve(VAULT_PATH));
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

// GET /api/imports/pending — list unprocessed files in Imports\
router.get('/pending', (req, res) => {
  try {
    const pending = importsService.getPending();
    res.json({ count: pending.length, files: pending });
  } catch (e) {
    console.error('[Imports] Error listing pending:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/imports/classify — classify a single file using Ollama
router.post('/classify', async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: 'filePath required' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  // Security: ensure filePath is within the vault
  if (!isWithinVault(filePath)) {
    return res.status(403).json({ error: 'File must be within the vault' });
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fileName = require('path').basename(filePath);

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

    // Parse the structured response
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

    // If confidence is low, override type to needs-review (bouncer rule)
    if (classification.confidence === 'low') {
      classification.type = 'needs-review';
    }

    res.json(classification);
  } catch (e) {
    console.error('[Imports] Classify error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/imports/route — move file to classified destination
router.post('/route', (req, res) => {
  const { filePath, destination, type } = req.body;
  if (!filePath || !destination) {
    return res.status(400).json({ error: 'filePath and destination required' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  if (!isWithinVault(filePath)) {
    return res.status(403).json({ error: 'File must be within the vault' });
  }

  try {
    // Update frontmatter before moving
    updateFrontmatter(filePath, {
      type: type || 'unknown',
      status: 'processed',
      'routed-date': new Date().toISOString().slice(0, 10)
    });

    // Build destination path within vault
    const destDir = path.resolve(VAULT_PATH, destination);
    if (!destDir.startsWith(path.resolve(VAULT_PATH))) {
      return res.status(403).json({ error: 'Destination must be within the vault' });
    }
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const fileName = path.basename(filePath);
    const newPath = path.join(destDir, fileName);

    // Handle name collision
    let finalPath = newPath;
    if (fs.existsSync(finalPath)) {
      const ext = path.extname(fileName);
      const base = path.basename(fileName, ext);
      finalPath = path.join(destDir, `${base}-${Date.now()}${ext}`);
    }

    fs.renameSync(filePath, finalPath);
    const relativePath = path.relative(VAULT_PATH, finalPath).replace(/\\/g, '/');
    console.log(`[Imports] Routed ${fileName} → ${relativePath}`);
    res.json({ success: true, newPath: relativePath });
  } catch (e) {
    console.error('[Imports] Route error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/imports/flag — mark file as needs-review
router.post('/flag', (req, res) => {
  const { filePath, reason } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: 'filePath required' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  if (!isWithinVault(filePath)) {
    return res.status(403).json({ error: 'File must be within the vault' });
  }

  try {
    updateFrontmatter(filePath, {
      status: 'needs-review',
      'review-reason': reason || 'Flagged manually'
    });
    console.log(`[Imports] Flagged ${path.basename(filePath)} for review`);
    res.json({ success: true });
  } catch (e) {
    console.error('[Imports] Flag error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/imports/dismiss — mark file as processed without moving
router.post('/dismiss', (req, res) => {
  const { filePath } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: 'filePath required' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  if (!isWithinVault(filePath)) {
    return res.status(403).json({ error: 'File must be within the vault' });
  }

  try {
    updateFrontmatter(filePath, { status: 'processed' });
    console.log(`[Imports] Dismissed ${path.basename(filePath)}`);
    res.json({ success: true });
  } catch (e) {
    console.error('[Imports] Dismiss error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
