# NEURO — Claude Code Handoff Prompt #4

## Context

NEURO codebase at `C:\Users\NickW\nick-agent`. Same constraints as always:
- Node.js CommonJS backend only
- No new npm packages (Anthropic SDK is already installed at `backend/node_modules/@anthropic-ai/sdk`)
- Do not touch node_modules, do not commit to git
- Read files before editing

One file to change: `backend/services/imports.js`

---

## SNAG-014 — Switch imports classification from Ollama to Claude API, with Ollama 3b fallback

**File:** `backend/services/imports.js`

**What to do:** Rewrite the `classifyFile` function to use Claude API as primary, falling back to Ollama if the API key is not set or the Claude call fails. Also update the Ollama fallback model from `qwen2.5:1.5b` to `qwen2.5:3b`.

---

### Step 1 — Update the model constants at the top of the file

Find these lines:
```js
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:1.5b';
```

Replace with:
```js
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
```

---

### Step 2 — Add a shared prompt builder

The classification prompt is the same regardless of which backend runs it. Add this helper function before `classifyFile`:

```js
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
```

---

### Step 3 — Add a Claude classification function

Add this function after `buildClassifyPrompt`:

```js
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
```

---

### Step 4 — Add an Ollama classification function

Add this function after `classifyWithClaude`:

```js
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
```

---

### Step 5 — Rewrite `classifyFile` to use Claude first, Ollama as fallback

Replace the entire existing `classifyFile` function with:

```js
async function classifyFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const fileName = path.basename(filePath);

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

  return classification;
}
```

---

### Step 6 — Remove the old standalone prompt variable

The old `classifyFile` function contained a large `const prompt = ...` template string. That is now replaced entirely by `buildClassifyPrompt`. Make sure no orphaned `prompt` variable remains in the file after the rewrite.

---

## After the change

1. Confirm the four new/modified elements are in place:
   - `CLAUDE_MODEL` constant at top
   - `buildClassifyPrompt(fileName, content)` helper function
   - `classifyWithClaude(fileName, content)` function
   - `classifyWithOllama(fileName, content)` function
   - Rewritten `classifyFile` that calls Claude first, falls back to Ollama
2. Confirm `OLLAMA_MODEL` fallback is now `qwen2.5:3b`
3. Run `node --check backend/services/imports.js` to verify no syntax errors
4. Do not touch `autoClassify`, `routeFile`, `getPending`, `updateFrontmatter`, or anything else in the file
5. Do not touch any frontend files
6. Do not commit to git
7. Summary: one line per change

---

## Note for after deployment

On the Pi, ensure `qwen2.5:3b` is pulled before the Ollama fallback will work:
```bash
ollama pull qwen2.5:3b
```
This is ~2GB download. The 3b model needs around 2.5GB RAM — well within the 4GB Pi's capacity.
Claude API will handle classification in normal use; Ollama 3b is only the fallback when the API key is missing or credits are exhausted.
