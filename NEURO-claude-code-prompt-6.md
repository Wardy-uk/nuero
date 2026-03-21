# NEURO — Claude Code Handoff Prompt #6

## Context

NEURO codebase at `C:\Users\NickW\nick-agent`. Same constraints as always:
- Node.js CommonJS backend, React 18 / Vite frontend
- No new npm packages (Anthropic SDK already installed)
- Do not touch node_modules, do not commit to git
- Read ALL referenced files before making any changes

This prompt adds vault-aware context to NUERO's chat — so when you ask about something,
it searches your Obsidian vault and injects relevant notes into the prompt automatically.

---

## SNAG-016 — Vault search injection into chat context

### Overview

Currently `streamChat` in `backend/services/claude.js` builds a context block from fixed
sources: queue, daily note, standup, todos, 90-day plan, inbox. It has no awareness of
the rest of the vault.

The goal: before building the system prompt, search the vault for terms from the user's
message and inject any matching note excerpts as an additional context section. This is
Option A (vault search on demand) — simple, no new infrastructure, uses the existing
`/api/vault/search` logic but called directly as a service function rather than via HTTP.

Read `backend/services/obsidian.js` in full before starting — the `searchRecursive`
logic already exists in `backend/routes/vault.js`. You will extract it into obsidian.js
as a reusable service function.

---

### Step 1 — Add `searchVault` to `backend/services/obsidian.js`

Add the following function to `backend/services/obsidian.js`, before the `module.exports` block:

```js
// Search vault for a query string — returns up to maxResults matching files with excerpts
function searchVault(query, maxResults = 5) {
  if (!isConfigured() || !query || query.trim().length < 3) return [];

  const vaultPath = getVaultPath();
  const results = [];

  // Directories to skip — too noisy or not useful for chat context
  const SKIP_DIRS = new Set([
    'Daily', 'Scripts', 'Templates', '.obsidian', '.git', '.trash', 'Imports'
  ]);

  function searchDir(dirPath, depth) {
    if (depth > 4 || results.length >= maxResults) return;
    if (!fs.existsSync(dirPath)) return;

    let entries;
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        searchDir(path.join(dirPath, entry.name), depth + 1);
      } else if (entry.name.endsWith('.md')) {
        const fullPath = path.join(dirPath, entry.name);
        let content;
        try { content = fs.readFileSync(fullPath, 'utf-8'); }
        catch { continue; }

        if (!content.toLowerCase().includes(query.toLowerCase())) continue;

        // Strip frontmatter
        const body = content.replace(/^---[\s\S]*?---\n*/, '');
        const lines = body.split('\n');

        // Find matching lines and grab context around them
        const excerpts = [];
        for (let i = 0; i < lines.length && excerpts.length < 3; i++) {
          if (lines[i].toLowerCase().includes(query.toLowerCase())) {
            const start = Math.max(0, i - 1);
            const end = Math.min(lines.length - 1, i + 2);
            const excerpt = lines.slice(start, end + 1).join('\n').trim();
            if (excerpt) excerpts.push(excerpt);
          }
        }

        const relPath = path.relative(vaultPath, fullPath).replace(/\\/g, '/');
        results.push({
          path: relPath,
          name: entry.name.replace('.md', ''),
          excerpts
        });
      }
    }
  }

  searchDir(vaultPath, 0);
  return results;
}
```

Add `searchVault` to the `module.exports` at the bottom of `obsidian.js`.

---

### Step 2 — Extract search keywords from user message

Add this helper function to `backend/services/claude.js`, near the top after the constants:

```js
// Extract meaningful search keywords from a user message
// Strips common stop words and short tokens, returns the best 1-2 terms to search
function extractSearchTerms(message) {
  const STOP_WORDS = new Set([
    'what', 'when', 'where', 'who', 'why', 'how', 'is', 'are', 'was', 'were',
    'did', 'do', 'does', 'can', 'could', 'would', 'should', 'have', 'has',
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'my', 'me', 'i', 'you', 'we', 'it', 'this', 'that', 'about',
    'tell', 'show', 'find', 'get', 'give', 'help', 'please', 'need', 'want',
    'know', 'think', 'look', 'see', 'any', 'some', 'all', 'from', 'into'
  ]);

  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w));

  // Return up to 2 most meaningful terms (longer words tend to be more specific)
  return words
    .sort((a, b) => b.length - a.length)
    .slice(0, 2);
}
```

---

### Step 3 — Add vault search to `streamChat` in `backend/services/claude.js`

In the `streamChat` function, after all the existing context-gathering try/catch blocks
(after `ninetyDayPlan` is fetched, before `buildContextBlock` is called), add:

```js
  // Vault search — find relevant notes based on user's message
  let vaultSearchResults = [];
  try {
    const terms = extractSearchTerms(userMessage);
    if (terms.length > 0) {
      // Search for each term, merge results, deduplicate by path
      const seen = new Set();
      for (const term of terms) {
        const hits = obsidian.searchVault(term, 4);
        for (const hit of hits) {
          if (!seen.has(hit.path)) {
            seen.add(hit.path);
            vaultSearchResults.push(hit);
          }
        }
      }
      if (vaultSearchResults.length > 0) {
        console.log(`[Context] Vault search for "${terms.join(', ')}" → ${vaultSearchResults.length} hits`);
      }
    }
  } catch (e) {
    console.warn('[Context] Vault search error:', e.message);
  }
```

---

### Step 4 — Pass vault results into `buildContextBlock`

Update the `buildContextBlock` function signature to accept an optional `vaultResults` parameter:

```js
function buildContextBlock(queueSummary, dailyNote, previousNote, standupContent, todos, ninetyDayPlan, weekend = false, vaultResults = []) {
```

At the **end** of the non-weekend path in `buildContextBlock` (after the inbox block, before
`console.log('[Context] Sources:', ...)`), add:

```js
  // Vault search results
  if (vaultResults && vaultResults.length > 0) {
    const vaultBlock = `## Relevant Vault Notes\n` +
      vaultResults.map(r =>
        `### ${r.name} (${r.path})\n${r.excerpts.join('\n...\n')}`
      ).join('\n\n');
    parts.push(vaultBlock);
    diagnostics.push(`vault: ${vaultResults.length} notes`);
  }
```

Also add it to the **weekend path** — at the end of the weekend block, after the personal todos section, before `return`:

```js
    if (vaultResults && vaultResults.length > 0) {
      parts.push(`## Relevant Vault Notes\n` +
        vaultResults.map(r => `### ${r.name}\n${r.excerpts.join('\n...\n')}`).join('\n\n')
      );
    }
    return parts.join('\n\n---\n\n') || '(Weekend — no work context loaded)';
```

(Remove the existing bare `return` at the end of the weekend path and replace with this.)

---

### Step 5 — Pass vaultSearchResults into the buildContextBlock call

Find the line in `streamChat` that calls `buildContextBlock`:

```js
  const contextBlock = buildContextBlock(queueSummary, dailyNote, previousNote, standupContent, todos, ninetyDayPlan, weekend);
```

Replace with:

```js
  const contextBlock = buildContextBlock(queueSummary, dailyNote, previousNote, standupContent, todos, ninetyDayPlan, weekend, vaultSearchResults);
```

---

## Important behaviour notes for CC

- The vault search runs on EVERY message. It's fast (synchronous filesystem reads) and
  the Pi's vault is small enough that this won't be a bottleneck.
- `SKIP_DIRS` excludes Daily, Imports, Scripts, Templates — these are too noisy. Meeting
  notes, People, Ideas, Projects, Areas, Reflections are all searched.
- If no terms are extracted (message is too short or all stop words), `vaultSearchResults`
  stays empty and nothing changes in the prompt.
- Max 5 vault results injected per message to keep token usage reasonable.
- This does NOT replace the existing fixed context — it's additive.

---

## After the changes

1. Run `node --check backend/services/claude.js` — no syntax errors
2. Run `node --check backend/services/obsidian.js` — no syntax errors
3. Confirm `searchVault` is exported in `module.exports` of obsidian.js
4. Confirm `extractSearchTerms` is defined in claude.js
5. Do not touch any frontend files
6. Do not touch any other backend files
7. Do not commit to git
8. Summary: one line per change, file by file
