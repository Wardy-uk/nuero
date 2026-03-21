# NEURO — Claude Code Handoff Prompt #3

## Context

NEURO codebase at `C:\Users\NickW\nick-agent`. Same constraints as always:
- Node.js CommonJS backend only
- No new npm packages
- Do not touch node_modules, do not commit to git
- Read files before editing

One file to change. This is a focused fix.

---

## SNAG-013 — Imports classification is producing garbage results

**File:** `backend/services/imports.js`

**Root causes (two, both in `classifyFile`):**

**1 — The prompt gives Ollama no vault structure to route into.**
The current prompt says "suggest the best destination folder" with zero context about what folders actually exist. Ollama invents paths like `actions/`, `/notes/2026-03-...` etc. because it has no idea what's real. The vault folder structure is:

```
Meetings/          ← meeting notes, call notes, discussion summaries
People/            ← notes about specific people (1-2-1s, feedback, personal notes)
Ideas/             ← ideas, concepts, brainstorms
Projects/          ← project-specific notes and reference
Areas/             ← ongoing areas of responsibility (health, finance, leadership, etc.)
Calls/             ← call notes specifically
Decision Log/      ← decisions made
Reflections/       ← personal reflections, journal-style entries
Imports/PLAUD/     ← voice recording transcripts from PLAUD device
Archive/           ← anything inactive or completed
```

**2 — The model default is `qwen2.5:0.5b` which is too small to reliably follow structured output instructions.**
The `.env` on the Pi has `OLLAMA_MODEL=qwen2.5:1.5b` but `imports.js` hardcodes its own fallback to `qwen2.5:0.5b` — so even if the env var is set correctly, `imports.js` may be ignoring it. Check the top of the file — it currently reads:

```js
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:0.5b';
```

Change the fallback to `qwen2.5:1.5b`:

```js
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:1.5b';
```

**The prompt fix:**

Replace the entire `prompt` template string inside `classifyFile` with this improved version that includes the real vault folder list and tighter instructions:

```js
  const prompt = `You are a filing assistant for an Obsidian vault. Classify the note below and suggest which vault folder it belongs in.

VAULT FOLDERS (choose destination from this list only):
- Meetings/         → meeting notes, call notes, discussion summaries  
- Calls/            → call notes (use this when explicitly a call/phone note)
- People/           → notes about a specific person (1-2-1s, feedback, personal updates)
- Ideas/            → ideas, concepts, brainstorms, things to explore
- Projects/         → notes tied to a specific project
- Areas/            → ongoing responsibilities (health, finance, leadership, team management)
- Decision Log/     → a decision that was made
- Reflections/      → personal reflections, journal entries, retrospectives
- Imports/PLAUD/    → voice recording transcripts from PLAUD device
- Archive/          → anything that doesn't fit elsewhere or is low value

TYPES (choose one):
meeting-note, call-note, action, decision, idea, reference, person-update, plaud-transcript, reflection, needs-review

RULES:
- If content is fewer than 10 words and has no clear category, type must be needs-review
- destination must be EXACTLY one of the folder names listed above, nothing else
- confidence must be high only if the type and destination are obvious from the content
- If unsure, use needs-review and low confidence

Filename: ${fileName}
Content:
${content.replace(/^---[\s\S]*?---\n*/, '').slice(0, 400)}

Respond in EXACTLY this format with no other text:
type: <type>
destination: <folder name>
confidence: <high|medium|low>
reason: <one sentence>`;
```

Note the key changes:
- Lists exact vault folder names so Ollama can only pick from real paths
- Strips frontmatter from content before sending (the `replace(/^---[\s\S]*?---\n*/, '')`) so Ollama doesn't waste tokens on YAML metadata
- Adds an explicit rule for short/ambiguous notes → `needs-review`
- Tightens the confidence rule
- Slightly shorter prompt = faster response on Pi

No other changes to the file. No frontend changes. No new packages.

---

## After the change

1. Confirm the `OLLAMA_MODEL` fallback is now `qwen2.5:1.5b`
2. Confirm the prompt template is updated as specified
3. Do not touch autoClassify, routeFile, getPending, or anything else in the file
4. Do not commit to git
5. One-line summary of what changed
