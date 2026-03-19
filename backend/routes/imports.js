const express = require('express');
const router = express.Router();
const fs = require('fs');
const importsService = require('../services/imports');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:0.5b';

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
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!filePath.startsWith(vaultPath)) {
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

module.exports = router;
