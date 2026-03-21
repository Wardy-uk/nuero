# NEURO — Claude Code Handoff Prompt

## Context

You are working on **NEURO** (Nick's Unified Executive Resource Orchestrator) — a personal AI agent running as a Node.js/Express backend on a Raspberry Pi, with a React/Vite PWA frontend deployed to Netlify. The frontend is also installed as a PWA on an iPhone and iPad.

**Project root:** `C:\Users\NickW\nick-agent`
**Structure:**
- `backend/` — Express API, sqlite via sql.js, routes/, services/
- `frontend/` — React 18 / Vite, served statically from Netlify, calls Pi via Tailscale URL

Read all relevant files before making changes. Do not guess at file contents.

---

## Your Mission

Work through the snag list below in order of priority. Each item tells you exactly what is broken, where to look, and what the fix should be. Some items have been deliberately excluded from the list — do not make changes outside these items without asking first.

**Important constraints:**
- Backend is Node.js CommonJS (`require`, not `import`). No ESM, no TypeScript.
- No new npm packages unless explicitly noted in the snag. If a snag says a package is already installed, it is.
- Frontend uses React 18, Vite, no router library — navigation is handled by `activeView` state in `App.jsx`.
- `sql.js` is the current database. Do not swap it out (that is a separate future task).
- Do not touch anything in `backend/node_modules/` or `frontend/node_modules/`.

---

## Snag List


### SNAG-003 — Inbox scanner never starts (CRITICAL)

**File:** `backend/server.js`

`backend/services/inbox-scanner.js` exports a `start()` function that schedules the inbox triage scan loop (30s startup delay, then every 10 minutes). This function is never called. The inbox scanner is completely non-functional.

**Fix:** In `backend/server.js`, inside the `start()` async function — after `webpushService.init()` and before `scheduler.start()` — add:

```js
const inboxScanner = require('./services/inbox-scanner');
inboxScanner.start();
```

That is the entire change. Do not alter inbox-scanner.js itself.

---

### SNAG-004 — QA route mismatch (CRITICAL)

**Files:** `backend/routes/qa.js`, `frontend/src/components/QATab.jsx`

`routes/qa.js` registers three routes: `/summary`, `/results`, `/agents`.
The `QATab` component (read it first) references `/api/qa/health` and `/api/qa/drift` which do not exist — these will 404.

**Fix:** Read `QATab.jsx` first. Then update `routes/qa.js` to add whatever route aliases are needed so that every endpoint QATab calls actually exists. If QATab calls `/api/qa/health`, add a route for it. If it calls `/api/qa/drift`, add that too. Map them to appropriate proxied calls using the existing `proxy()` helper pattern already in `qa.js`. Use your judgement on which upstream QA webhook paths to proxy to — or create stub routes that return `{ error: 'QA_WEBHOOK_BASE not configured' }` using the same pattern as the others if the upstream path is unclear.

---

### SNAG-005 — Photo capture timestamp collision bug

**File:** `backend/routes/capture.js`

In the `POST /api/capture/photo` handler, `timestamp()` is called twice: once to generate the image filename and once to generate the markdown note filename. Since `timestamp()` uses `new Date()` each call, the two filenames will have different timestamps. The markdown note contains `![[Files/${filename}]]` which references the *first* timestamp, but if the two calls resolve to different seconds, the link will point to a file that doesn't exist.

**Fix:** Call `timestamp()` once at the top of the handler, store it in a `const ts`, and use `ts` for both filenames:

```js
router.post('/photo', upload.single('file'), (req, res) => {
  if (!req.file) { ... }
  try {
    ensureDirs();
    const ts = timestamp(); // call once
    const ext = path.extname(req.file.originalname) || '.jpg';
    const filename = `${ts}-photo${ext}`;
    const filePath = path.join(getFilesDir(), filename);
    fs.writeFileSync(filePath, req.file.buffer);

    const mdFilename = `${ts}-photo-capture.md`; // same ts
    const mdPath = path.join(getImportsDir(), mdFilename);
    const mdContent = `${frontmatter('Photo capture')}![[Files/${filename}]]\n`;
    fs.writeFileSync(mdPath, mdContent, 'utf-8');
```


---

### SNAG-006 — Missing apple-touch-icon (PWA install on iOS/iPadOS)

**File:** `frontend/index.html`, `frontend/public/manifest.json`

The manifest only contains an SVG icon. iOS Safari ignores SVG icons for PWA installation — it requires a PNG `apple-touch-icon`. Without it, the Home Screen icon will be a blank screenshot or generic icon.

**Fix — Part A:** Add a `<link>` tag to `frontend/index.html` in the `<head>`, after the existing favicon link:

```html
<link rel="apple-touch-icon" href="/icon-192.png" />
```

**Fix — Part B:** Update `frontend/public/manifest.json` to add PNG icons alongside the existing SVG:

```json
{
  "name": "NEURO",
  "short_name": "NEURO",
  "description": "Nick's Unified Executive Resource Orchestrator",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0a0a0a",
  "theme_color": "#00ff88",
  "icons": [
    {
      "src": "/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    },
    {
      "src": "/favicon.svg",
      "sizes": "any",
      "type": "image/svg+xml"
    }
  ]
}
```

**Fix — Part C:** Create a `generate-icons.js` script at the project root that generates `frontend/public/icon-192.png` and `frontend/public/icon-512.png`. Use the `canvas` npm package if available, otherwise write raw PNG binary using only Node.js built-ins. The icons should have a dark background (`#0a0a0a`) with the letter "N" centred in brand green (`#00ff88`). After creating the script, run it to actually produce the PNG files.

---

### SNAG-007 — Apple Pencil / Scribble support in CapturePanel (NEW FEATURE)

**File:** `frontend/src/components/CapturePanel.jsx`, `frontend/src/components/CapturePanel.css`

When NEURO is running as a PWA on iPad, the user wants to write with Apple Pencil and have handwriting automatically converted to typed text in the Note capture textarea. Apple's Scribble feature (iPadOS 14+) does this natively — it intercepts Apple Pencil input on any focused text field and converts handwriting to text transparently, without any JavaScript API. No third-party library is needed.

**Changes required:**

1. In the Note tab `<textarea>`, add these attributes:
   - `inputMode="text"`
   - `autoComplete="off"`
   - `autoCorrect="off"`
   - `spellCheck={false}`
   - Keep existing `autoFocus`

2. In `CapturePanel.css`, add for `.capture-textarea`:

```css
@media (max-width: 768px) {
  .capture-textarea {
    min-height: 220px;
    font-size: 16px;
  }
}
```

3. Add a hint element below the textarea, inside the `mode === 'Note'` block:

```jsx
<p className="capture-pencil-hint">✎ Apple Pencil: write directly in the box above</p>
```

4. Add CSS for `.capture-pencil-hint`:

```css
.capture-pencil-hint {
  font-size: 11px;
  color: #666;
  margin: 4px 0 0;
  opacity: 0.6;
}
@media (hover: hover) {
  .capture-pencil-hint { display: none; }
}
```

5. Add `inputMode="text"` and `autoCorrect="off"` to the title `<input>` as well.

No backend changes. No new packages.


---

### SNAG-008 — Missing env vars in `.env.example`

**File:** `backend/.env.example`

Replace the entire contents with:

```
# Claude AI
ANTHROPIC_API_KEY=

# Jira Service Management (optional — n8n ingest path is preferred)
JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_EMAIL=your@email.com
JIRA_API_TOKEN=
JIRA_PROJECT_KEY=NT

# Obsidian vault path (on the Pi)
OBSIDIAN_VAULT_PATH=/home/nick/vault

# Microsoft 365 (optional — for calendar, inbox, tasks)
MS_CLIENT_ID=
MS_TENANT_ID=

# n8n
N8N_API_URL=https://n8n-dashboard.nurtur-ai.app
N8N_API_KEY=

# Web Push (VAPID keys — generate with: npx web-push generate-vapid-keys)
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=

# Security
INGEST_SECRET=
VAULT_API_KEY=

# QA dashboard webhook
QA_WEBHOOK_BASE=

# Ollama (local LLM fallback)
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:1.5b

# Claude model override
CLAUDE_MODEL=claude-sonnet-4-20250514

# Server
PORT=3001
```

---

### SNAG-009 — Cache has no TTL

**Files:** `frontend/src/cacheStore.js`, `frontend/src/useCachedFetch.js`

`cacheGet` returns any entry regardless of age. Add a `maxAgeMs` parameter.

**Fix — cacheStore.js:** Update `cacheGet` signature:

```js
export async function cacheGet(key, maxAgeMs = null) {
  try {
    const db = await getDb();
    const entry = await db.get(STORE_NAME, key);
    if (!entry) return null;
    if (maxAgeMs !== null && Date.now() - entry.ts > maxAgeMs) return null;
    return entry;
  } catch (_) {
    return null;
  }
}
```

**Fix — useCachedFetch.js:** Add `maxAgeMs` to the opts destructure (default 24 hours) and pass it to `cacheGet`:

```js
const { interval = null, transform = null, maxAgeMs = 24 * 60 * 60 * 1000 } = opts;
```

And in the catch block:

```js
const cached = await cacheGet(path, maxAgeMs);
```

---

### SNAG-010 — Decisions have no read endpoint

**File:** `backend/routes/chat.js`

Decisions are logged to the DB but there is no GET endpoint to read them back.

**Fix:** Add to `backend/routes/chat.js` (it already has `db` imported):

```js
// GET /api/chat/decisions — recent logged decisions
// TODO: surface in ChatPanel or a dedicated Decisions view
router.get('/decisions', (req, res) => {
  const stmt = db.getDb().prepare(
    'SELECT id, conversation_id, decision_text, created_at FROM decisions ORDER BY created_at DESC LIMIT 50'
  );
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  res.json({ decisions: rows });
});
```

---

## After completing all snags

1. Run `cd frontend && npm run build` and confirm it builds cleanly with no errors.
2. Confirm `backend/server.js` reads cleanly — all `require()` calls resolve to files that exist.
3. Summarise what you changed, file by file, with a one-line description of each change.
4. Flag any snag where you made a judgement call or deviated from the spec — explain why.
5. Do not commit to git. Leave that for the user.

---

## Tracking Documents

- **Plan:** `PLAN.md` — execution order and approach
- **Tasks:** `TODO.md` — per-snag task tracker

---

## Known issues deliberately NOT in this batch

Do not touch these:

- Jira SLA fabrication — requires Jira API field schema work, separate task
- sql.js → better-sqlite3 migration — separate task, needs full DB migration plan
- Ollama fallback reliability — acceptable current state, not blocking
- Microsoft Graph headless auth — already handled via device code flow in AdminPanel
