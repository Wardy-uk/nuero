# NEURO — Finished Product Build Plan

**Date:** 2026-03-23
**Status:** Execution-ready
**Repo:** `C:\Users\NickW\nick-agent`

---

## 1. Product Vision

NEURO is a personal second brain for a neurodivergent professional — an always-on external memory and executive function layer that captures anything instantly, retrieves anything without recall effort, structures knowledge automatically, and surfaces the right context at the right time. The user should never need to remember where they put something, never need to file anything manually, and never wonder whether they missed something important. It is the calm, trustworthy system that sits between a messy human brain and the demands of a senior leadership role.

---

## 2. Product Definition

### Primary User Promise
"Capture anything. Ask anything. Trust that nothing is lost."

### Core Workflows

| # | Workflow | What happens |
|---|----------|-------------|
| 1 | **Capture** | One-tap/one-type input of text, todos, photos, files, escalations. Lands in a universal inbox. Zero filing decisions. |
| 2 | **Ask** | Natural-language search/chat that draws on vault notes, calendar, queue, people, recent activity, decisions, and email. Returns grounded answers with sources. |
| 3 | **Review** | A daily/weekly rhythm surface that shows: what's due, what's overdue, what needs attention, what was decided, what should be followed up. Auto-populated, not manually assembled. |

### Mental Model
```
         ┌──────────┐
         │ CAPTURE  │   ← everything enters here
         └────┬─────┘
              │ auto-classify, extract entities, embed
              ▼
        ┌───────────┐
        │  VAULT    │   ← structured knowledge store
        │  + DB     │      (notes, people, meetings, tasks, decisions)
        └─────┬─────┘
              │
     ┌────────┼────────┐
     ▼        ▼        ▼
  ┌─────┐ ┌─────┐ ┌────────┐
  │ ASK │ │REVIEW│ │ NUDGE  │
  └─────┘ └─────┘ └────────┘
```

### In Scope
- Universal capture (text, todo, file, photo, escalation, voice transcript)
- AI chat with full vault/calendar/queue/people context
- Semantic + keyword + temporal retrieval over the entire vault
- Automatic entity extraction (people, meetings, tasks, decisions)
- Daily review / standup / EOD flows
- Push notifications and nudges
- Jira queue monitoring and escalation tracking
- Calendar integration (Microsoft 365)
- Email triage
- Vault sync (Obsidian git)
- Import classification and auto-filing
- Mobile-first PWA

### Should Be Removed, Hidden, or Merged

| Current Surface | Recommendation | Reason |
|----------------|---------------|--------|
| Dashboard | **Keep** — becomes the Review surface | Primary landing page |
| Chat | **Keep** — becomes the Ask surface | Core workflow |
| Capture | **Keep** — remains Capture | Core workflow |
| Standup | **Merge into Review** | Standup is a review sub-workflow, not a separate view |
| Todos | **Merge into Review** | Todos should surface in review, not require a separate panel |
| People | **Move to secondary nav** | Reference view, not daily workflow |
| Queue | **Move to secondary nav** | Monitoring view |
| Calendar | **Move to secondary nav** | Reference view |
| Inbox | **Move to secondary nav** | Review should surface urgent inbox items |
| 90-Day Plan | **Move to secondary nav** | Strategic reference, not daily |
| Journal | **Merge into Review** | Evening journal is a review sub-workflow |
| Vault | **Move to secondary nav** | Power-user reference view |
| Strava | **Remove from nav** | Move to Settings/Integrations |
| Imports | **Move to secondary nav** | Admin/processing view |
| Insights | **Move to secondary nav** | Analytics view |
| QA | **Remove** | Unclear purpose, low daily value |
| Recent | **Merge into Capture** | Recent captures should show in Capture panel |
| Settings/Admin | **Move to secondary nav** | Configuration |

### Resulting Nav Structure
```
PRIMARY (always visible):
  Review (home)     — dashboard + standup + todos + journal
  Ask               — chat/search
  Capture           — universal inbox

SECONDARY (collapsible):
  People
  Queue
  Calendar
  Inbox
  Plan
  Vault
  Imports
  Insights
  Settings
```

---

## 3. Build Strategy

### Phase 1: Product Safety and Trust Foundations
**Goal:** Fix every behaviour that could lose data, expose the vault, or confuse the user.

#### 1a. Vault Sync — Conflict Safety
**Problem:** `vault-sync.js:69-78` uses `git checkout --ours .` (local-wins) as conflict resolution. This silently discards remote changes — unacceptable for a second brain.

**Implementation:**
- Replace local-wins with a **conflict-preserving strategy**:
  - On conflict, abort the rebase
  - Create a `Conflicts/YYYY-MM-DD-HHmm-conflict.md` note containing both versions
  - Commit the local version but preserve the remote version in the conflict note
  - Push a notification: "Sync conflict detected — review in Conflicts/"
  - Never silently discard content
- Add a `/api/vault/conflicts` endpoint to list unresolved conflicts
- Add conflict count to the status dashboard

**Affected files:**
- `backend/services/vault-sync.js` — rewrite conflict resolution
- `backend/routes/vault.js` — add conflicts endpoint
- `backend/services/webpush.js` — conflict notification

**Definition of done:** No sync operation can ever discard content. All conflicts are preserved and surfaced.

#### 1b. Vault API Auth Hardening
**Problem:** `vault.js:11-17` `requireApiKey` allows all requests through if no API key header is sent. Any network-adjacent client can read/write the entire vault.

**Implementation:**
- Add a session token or shared secret that the frontend includes on every request
- At minimum: require `VAULT_API_KEY` env var to be set, reject all requests if not configured
- Add rate limiting on write endpoints
- Ensure `export-docx` route uses `safePath()` for the `subdir` parameter (currently it does not — line 186 uses raw `subdir` input)

**Affected files:**
- `backend/routes/vault.js` — auth middleware, safePath on export-docx
- `backend/server.js` — global auth middleware option
- `frontend/src/api.js` — include auth header

**Definition of done:** No unauthenticated vault access. All path inputs validated through `safePath()`.

#### 1c. ChatPanel Double-Mount Fix
**Problem:** `App.jsx:124` renders `<ChatPanel>` in the main view switch for `case 'chat'`, AND `App.jsx:142` always renders it inside `<aside>`. Two instances mount simultaneously, causing duplicate API calls, duplicate SSE streams, and confusing UX.

**Implementation:**
- Remove the `case 'chat'` from the main switch
- When user clicks "Chat" in sidebar, open the aside panel instead
- OR: render ChatPanel only once, conditionally in either the main area or the aside

**Affected files:**
- `frontend/src/App.jsx` — remove duplicate mount
- `frontend/src/components/Sidebar.jsx` — adjust chat navigation

**Definition of done:** Exactly one ChatPanel instance exists at any time.

#### 1d. Chat History Ordering Fix
**Problem:** `database.js:50-53` queries `ORDER BY created_at DESC` then reverses the result (line 60). `ChatPanel.jsx:230` then reverses again: `[...data.messages].reverse()`. Double-reverse = wrong order on reload.

**Implementation:**
- Remove the `.reverse()` in `ChatPanel.jsx:230` (the DB query + `.reverse()` in database.js already returns chronological order)
- OR: remove the `.reverse()` in database.js and keep the frontend one
- Pick one, test, verify chronological order on reload

**Affected files:**
- `frontend/src/components/ChatPanel.jsx` — line 230
- `backend/db/database.js` — line 60 (choose one to fix)

**Definition of done:** Chat history loads in correct chronological order (oldest first).

#### 1e. Path Traversal Audit
**Problem:** Several vault routes use `safePath()` correctly, but the `export-docx` endpoint at `vault.js:186` constructs `targetDir` from raw user input (`subdir`) without validation.

**Implementation:**
- Audit every vault route for `safePath()` usage
- Add `safePath()` to `export-docx` subdir parameter
- Add `safePath()` to `related` endpoint (line 223 uses raw `notePath`)

**Affected files:**
- `backend/routes/vault.js` — all endpoints

**Definition of done:** Every path derived from user input passes through `safePath()`.

---

### Phase 2: Retrieval and Context Intelligence
**Goal:** Make "Ask anything" actually work — the AI needs to find relevant notes regardless of where they live or how messy they are.

#### 2a. Expand Embedding Scope
**Problem:** `embeddings.js:9` skips `Daily`, `Imports`, `Scripts`, `Templates`. Daily notes and imports are primary capture surfaces — excluding them means the AI can't recall what was captured or what happened on a given day.

**Implementation:**
- Remove `Daily` and `Imports` from `SKIP_DIRS`
- Keep `Scripts`, `Templates`, `.obsidian`, `.git`, `.trash` excluded
- Re-run embedding rebuild after change

**Affected files:**
- `backend/services/embeddings.js` — line 9

**Definition of done:** Daily notes and import captures are semantically searchable.

#### 2b. Multi-Chunk Embedding
**Problem:** `embeddings.js:193` only embeds `chunks[0]` — the first chunk of each note. Long notes (meeting notes, decision logs, daily notes) are only partially indexed.

**Implementation:**
- Store multiple chunks per file: modify DB schema to support `chunk_index` column
- Embed all chunks, not just the first
- On search, deduplicate results by file path (take highest-scoring chunk)
- Update `vault_embeddings` table: add `chunk_index INTEGER DEFAULT 0`
- Update `saveEmbedding`, `getEmbedding`, `getAllEmbeddings` queries

**Affected files:**
- `backend/db/schema.sql` — add chunk_index column
- `backend/db/database.js` — update embedding queries
- `backend/services/embeddings.js` — embed all chunks

**Definition of done:** Every chunk of every note is embedded and searchable.

#### 2c. Hybrid Retrieval (Keyword + Semantic + Temporal)
**Problem:** The chat service does keyword search and semantic search separately. There's no fusion/ranking strategy.

**Implementation:**
- Create a unified `backend/services/retrieval.js` service:
  - `search(query, options)` — runs keyword, semantic, and temporal search in parallel
  - Reciprocal Rank Fusion (RRF) to combine results
  - Options: `{ scope, timeRange, entityType, maxResults }`
- Integrate into `claude.js` context building

**Affected files:**
- New: `backend/services/retrieval.js`
- `backend/services/claude.js` — use retrieval service
- `backend/routes/vault.js` — expose unified search endpoint

**Definition of done:** A single search call returns fused results from keyword + semantic + temporal signals.

#### 2d. Scoped Retrieval
**Implementation:**
- Add scope parameter to retrieval: `person:Name`, `project:Name`, `meeting:Title`, `timerange:from-to`
- When user asks about a person, automatically scope search to People/ notes + mentions
- When discussing a meeting, scope to calendar + meeting notes + attendee notes

**Affected files:**
- `backend/services/retrieval.js` — scope filtering
- `backend/services/claude.js` — auto-scope detection

**Definition of done:** Queries like "what did I discuss with Heidi last week" search People/Heidi.md + Daily notes mentioning Heidi + meeting notes with Heidi as attendee.

---

### Phase 3: UX Simplification (Capture / Ask / Review)
**Goal:** Reduce cognitive load from 18 nav items to 3 primary + secondary.

#### 3a. Redesign Sidebar to 3 Primary Views
**Implementation:**
- Restructure `Sidebar.jsx` NAV_GROUPS:
  - Primary: Review, Ask, Capture (always visible, large touch targets)
  - Secondary: collapsible group with People, Queue, Calendar, Inbox, Plan, Vault, Imports, Insights, Settings
- Remove QA and Recent from nav (merge Recent into Capture, remove QA)
- Remove Strava from nav (move to Settings)

**Affected files:**
- `frontend/src/components/Sidebar.jsx`
- `frontend/src/App.jsx` — update renderView switch
- Remove or archive: `QATab.jsx`, `RecentPanel.jsx` (merge into others)

#### 3b. Build the Review Surface
**Implementation:**
- Redesign `Dashboard.jsx` as the Review surface:
  - Morning: standup template + today's calendar + urgent queue items + overdue todos
  - Afternoon: progress on today's tasks + new captures to review
  - Evening: journal prompt + EOD summary
  - Time-of-day awareness already exists (`useTimeHighlight` in Sidebar)
- Inline standup editing (currently a separate panel)
- Inline todo management
- Inline journal entry

**Affected files:**
- `frontend/src/components/Dashboard.jsx` — complete redesign
- `frontend/src/components/StandupEditor.jsx` — extract as embeddable component
- `frontend/src/components/TodoPanel.jsx` — extract as embeddable component
- `frontend/src/components/JournalPanel.jsx` — extract as embeddable component

#### 3c. Unify Ask Surface
**Implementation:**
- Rename ChatPanel to AskPanel
- Add a search bar at the top that works as both search and chat
- Short queries → show search results inline
- Long queries / questions → enter chat mode with streaming response
- Search results show vault notes, people, meetings, tasks with previews
- Clicking a result opens it in a detail view or vault browser

**Affected files:**
- `frontend/src/components/ChatPanel.jsx` → rename to `AskPanel.jsx`
- `frontend/src/App.jsx` — update imports

#### 3d. Capture Panel Simplification
**Implementation:**
- Default mode: just a text box. No mode picker visible initially.
- "Capture" button always visible
- Todo detection: if text starts with `- [ ]` or looks like a task, auto-classify as todo
- File/photo: accessible via an attachment icon, not a separate mode
- Escalation: move to Queue view or make it a button within Queue
- Show recent captures inline below the capture box

**Affected files:**
- `frontend/src/components/CapturePanel.jsx` — simplify

---

### Phase 4: Object Model and Automatic Structuring
**Goal:** First-class entities extracted automatically from captures and notes.

#### 4a. Entity Extraction Service
**Implementation:**
- Create `backend/services/entities.js`:
  - `extractEntities(text)` → `{ people: [], meetings: [], tasks: [], decisions: [], projects: [], sources: [] }`
  - Use Claude/Ollama to extract from messy text
  - Run on every new capture and import
- Store entities in new DB tables (see Domain Model section)

**Affected files:**
- New: `backend/services/entities.js`
- `backend/db/schema.sql` — new entity tables
- `backend/routes/capture.js` — trigger extraction after capture

#### 4b. Auto-Linking
**Implementation:**
- When a capture mentions a known person, project, or meeting → create bidirectional links
- Store links in DB: `entity_links(source_path, target_entity_type, target_entity_id)`
- Surface in vault browser: "This note mentions: Heidi Power, NT-12345"

**Affected files:**
- New: entity linking logic in `backend/services/entities.js`
- `backend/db/schema.sql` — entity_links table
- `frontend/src/components/VaultBrowser.jsx` — show linked entities

---

### Phase 5: Connection Intelligence and Proactive Support
**Goal:** The system actively connects information and surfaces things the user didn't ask for but needs.

#### 5a. Backlinks and Mentions
- For every entity (person, project, meeting), compute all notes that mention it
- Surface in People view: "Recent mentions of Heidi" with links to notes
- Surface in vault browser: backlinks panel on every note

#### 5b. Orphan Detection
- Identify captures that were never linked, classified, or acted on
- Surface in Review: "3 captures from last week haven't been reviewed"

#### 5c. Proactive Meeting Prep Enhancement
- Already exists in `meeting-prep.js` — enhance with:
  - Pull all notes mentioning each attendee
  - Show recent decisions involving attendees
  - Show open tasks related to attendees

#### 5d. Weekly Review Auto-Population
- Already exists in `scheduler.js` — enhance with:
  - Automatic wins/challenges detection from daily notes
  - Decision summary
  - Entity activity summary (who did you interact with most)

---

### Phase 6: Final Polish, Consistency, and Ship Readiness
**Goal:** Every interaction feels trustworthy, consistent, and low-friction.

#### 6a. Offline Resilience
- Capture already has offline queue — extend to all write operations
- Add service worker for full PWA offline support
- Show clear online/offline status

#### 6b. Error Handling Consistency
- Standardise error responses across all API routes
- Add toast notifications for all user-facing errors
- Never show raw error messages

#### 6c. Mobile UX Polish
- Touch target sizing (minimum 44px)
- Swipe gestures for common actions
- Bottom navigation for mobile (Capture / Ask / Review)

#### 6d. Performance
- Lazy-load secondary views
- Virtualize long lists (queue, vault browser)
- Cache embedding search results for repeated queries

---

## 4. Information Architecture

### Current State (18 surfaces, 3 groups)
```
NOW:       Dashboard, Standup, Chat, Capture, Todos (5)
WORK:      People, Queue, Calendar, Inbox, 90-Day Plan (5)
REFERENCE: Journal, Vault, Strava, Imports, Insights, QA, Recent, Settings (8)
```

### Target State (3 primary, 9 secondary)
```
PRIMARY:
  Review    ← Dashboard + Standup + Todos + Journal merged
  Ask       ← Chat + Search unified
  Capture   ← Capture + Recent merged, simplified

SECONDARY:
  People    ← remains
  Queue     ← remains
  Calendar  ← remains
  Inbox     ← remains
  Plan      ← remains (90-day)
  Vault     ← remains (power-user)
  Imports   ← remains (admin)
  Insights  ← remains (analytics)
  Settings  ← Admin + Strava config merged
```

### Surface Disposition Table

| Current | Action | Target | Rationale |
|---------|--------|--------|-----------|
| Dashboard | Expand | **Review** | Becomes the unified daily surface |
| Standup | Merge | Review (morning section) | Not worth its own panel |
| Chat | Rename | **Ask** | Search + chat unified |
| Capture | Simplify | **Capture** | Remove mode tabs, add auto-classification |
| Todos | Merge | Review (tasks section) | Tasks belong in the review flow |
| People | Keep | Secondary | Reference, not daily |
| Queue | Keep | Secondary | Monitoring, not daily |
| Calendar | Keep | Secondary | Reference |
| Inbox | Keep | Secondary | Urgent items surface in Review |
| 90-Day Plan | Keep | Secondary | Strategic reference |
| Journal | Merge | Review (evening section) | Part of the daily rhythm |
| Vault | Keep | Secondary | Power-user browsing |
| Strava | Remove | Settings sub-section | Not a primary surface |
| Imports | Keep | Secondary | Admin processing |
| Insights | Keep | Secondary | Analytics |
| QA | Remove | — | Unclear value, no daily use |
| Recent | Merge | Capture (bottom section) | Recent captures shown in capture |
| Settings | Keep | Secondary | Configuration |

---

## 5. Domain Model

### Person
- **Purpose:** Track team members, stakeholders, and contacts
- **Source inputs:** Vault People/ folder, meeting attendees, email senders, chat mentions, manual capture
- **Properties:** name, role, team, lastMeeting, lastMentioned, noteCount, openTasks
- **Relationships:** mentioned_in(Note), attended(Meeting), assigned(Task), involved_in(Decision)
- **Current codebase:** `backend/services/obsidian.js` (readPersonNote, updatePersonNote), `People/` vault folder
- **Enhancement needed:** Extract to `backend/services/entities.js`, add DB table for person metadata

### Meeting
- **Purpose:** Track meetings, their outcomes, and attendees
- **Source inputs:** Microsoft 365 calendar, `[MEETING NOTE]` markers in chat, meeting prep service
- **Properties:** title, datetime, attendees[], location, notes, decisions[], actionItems[]
- **Relationships:** attended_by(Person), produced(Decision), created(Task), linked_to(Note)
- **Current codebase:** `backend/db/schema.sql` calendar_cache table, `backend/services/meeting-prep.js`
- **Enhancement needed:** Promote from cache to first-class entity with outcomes tracking

### Task
- **Purpose:** Track action items from any source
- **Source inputs:** Capture panel, `[ADD TODO]` from chat, vault Master Todo.md, MS Planner/ToDo, daily note extraction
- **Properties:** text, priority, dueDate, source, status, linkedPerson, linkedMeeting
- **Relationships:** assigned_to(Person), from(Meeting), from(Decision), linked_to(Note)
- **Current codebase:** `backend/db/schema.sql` todos table, `Tasks/Master Todo.md`
- **Enhancement needed:** Unify DB todos and vault todos into single source of truth

### Decision
- **Purpose:** Track decisions made in conversations and meetings
- **Source inputs:** `[DECISION]` markers in chat, manual capture
- **Properties:** text, date, context, conversationId, linkedPeople[], linkedMeeting
- **Relationships:** made_with(Person), during(Meeting), resulted_in(Task)
- **Current codebase:** `backend/db/schema.sql` decisions table, `backend/services/claude.js` decision detection
- **Enhancement needed:** Link decisions to entities, surface in person/meeting views

### Project
- **Purpose:** Group related work, notes, and tasks
- **Source inputs:** Vault folder structure, Jira projects, manual tagging
- **Properties:** name, status, notes[], tasks[], people[]
- **Relationships:** involves(Person), contains(Task), contains(Note), has(Decision)
- **Current codebase:** No explicit project entity exists
- **Enhancement needed:** Create project extraction from vault folder structure + Jira project mapping

### Source
- **Purpose:** Track external information sources (emails, documents, links)
- **Source inputs:** Email triage, file captures, web links in notes
- **Properties:** type, title, origin, date, linkedNote
- **Relationships:** referenced_in(Note), from(Person)
- **Current codebase:** `backend/services/email-triage.js`, `backend/routes/capture.js` file/photo
- **Enhancement needed:** Unified source tracking across email, files, and links

---

## 6. Retrieval Architecture

### Stack Design

```
User Query
    │
    ├─→ Keyword Search (vault file scan)
    │     - Full-text search across all .md files
    │     - Current: vault.js /search endpoint
    │
    ├─→ Semantic Search (embedding cosine similarity)
    │     - Vector similarity against all embedded chunks
    │     - Current: embeddings.js semanticSearch()
    │
    ├─→ Temporal Search (date-range filtering)
    │     - Filter by file modified date or daily note date
    │     - Current: vault.js /search/temporal endpoint
    │
    ├─→ Entity Search (structured data)
    │     - People by name, tasks by status, decisions by date
    │     - Current: partial (people notes, todos table)
    │
    └─→ Scoped Search (context-restricted)
          - "about Heidi" → People/Heidi.md + mentions
          - "from last week" → temporal constraint
          - "in the queue" → Jira data only

    All results → Reciprocal Rank Fusion (RRF) → Top-K
```

### Reciprocal Rank Fusion (RRF)
```
score(doc) = Σ 1 / (k + rank_i(doc))   for each retrieval method i
k = 60 (standard RRF constant)
```

### Indexing Scope
| Source | Currently Indexed | Should Be Indexed |
|--------|:-:|:-:|
| Vault root-level notes | Yes | Yes |
| Vault subfolder notes | Yes (depth 4) | Yes |
| Daily/ notes | **No** | **Yes** |
| Imports/ notes | **No** | **Yes** |
| People/ notes | Yes | Yes |
| Tasks/ notes | Depends on folder | Yes |
| Templates/ | No | No (skip) |
| Scripts/ | No | No (skip) |

### Chunking Strategy
- **Current:** Split on `\n\n`, max 1500 chars, only embed first chunk
- **Target:** Split on `\n\n`, max 1500 chars, embed ALL chunks
- Add chunk overlap: 200 chars from previous chunk prepended (for context continuity)
- Store chunk_index in DB for ordering
- For daily notes: also extract and embed each section (## heading) as a separate chunk

### Embedding Model
- **Current:** Voyage 3.5 Lite (voyage-3.5-lite) with simple-vector fallback
- **Keep:** This is a reasonable choice. 1024-dim vectors, good quality/cost ratio.
- **Enhancement:** Cache query embeddings for repeated similar queries (TTL 5 min)

### Stale/Missing Embedding Handling
- On query: if semantic search returns no results, fall back to keyword search transparently
- Nightly rebuild already exists (2am cron) — keep this
- Add incremental embedding: when a file is saved via capture/vault API, embed immediately
- Track embedding freshness: if `embedded_at` is >24h behind `file_modified`, flag for re-embedding

---

## 7. AI Interaction Model

### Universal Ask/Search
The Ask surface is a single input that handles:

| Input Type | Behaviour |
|-----------|-----------|
| Short keyword query ("heidi notes") | Show search results inline |
| Question ("what did I decide about the QA framework?") | Semantic search → AI answer with sources |
| Command ("[ADD TODO: call Heidi]") | Execute action, confirm |
| Temporal query ("what happened last Tuesday") | Temporal + keyword search → summary |
| Scoped query ("meetings with Heidi this month") | Entity-scoped temporal search |

### Scoped Context Workflows
When the user opens a Person, Meeting, or Project view, the Ask surface automatically scopes to that entity:

- **Person view open → Ask scoped to person:** "draft a message to them" uses person context
- **Meeting view open → Ask scoped to meeting:** "what were the action items?" searches meeting notes
- **Queue view open → Ask scoped to queue:** "which tickets are at risk?" uses Jira data

### Structured Transformations
The AI should proactively offer to transform messy captures:

| Capture Type | Offered Transformation |
|-------------|----------------------|
| Long rambling text | "Extract 3 action items from this?" |
| Meeting transcript | "Create meeting note with decisions and actions?" |
| Photo of whiteboard | "Transcribe and extract key points?" |
| Email paste | "Summarise and extract action items?" |

### Save/Apply Flows
Every AI output that suggests an action should have a one-tap apply:

- `[ADD TODO: text]` → "Added to Master Todo" confirmation
- `[MEETING NOTE: Title]` → "Saved to vault" confirmation
- `[DECISION: text]` → "Decision logged" confirmation
- `[UPDATE PERSON: Name]` → "Person note updated" confirmation

**Current state:** These markers already exist in `claude.js` and `ChatPanel.jsx`. Enhancement: make the confirmations more visible and add undo.

### Low Ambiguity
- Always show what context the AI used: "Based on your notes from March 15 and Heidi's person note..."
- Never hallucinate sources — if the vault doesn't contain relevant information, say so
- Show source links in responses (clickable vault paths)

---

## 8. Immediate Product Blockers

These must be fixed before any further feature work:

### CRITICAL — Data Safety

| # | Issue | Location | Risk |
|---|-------|----------|------|
| 1 | **Vault sync discards remote changes** | `vault-sync.js:69-78` | Silent data loss |
| 2 | **Vault API has no real auth** | `vault.js:11-17` | Any LAN client can read/write vault |
| 3 | **export-docx path traversal** | `vault.js:186` | `subdir` not validated through `safePath()` |
| 4 | **related endpoint path traversal** | `vault.js:223` | `notePath` not validated through `safePath()` |

### HIGH — UX Correctness

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 5 | **ChatPanel mounted twice** | `App.jsx:124,142` | Duplicate API calls, confused state, doubled SSE streams |
| 6 | **Chat history order wrong on reload** | `ChatPanel.jsx:230` + `database.js:60` | Double-reverse = newest-first display |

### MEDIUM — Retrieval Quality

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 7 | **Daily notes excluded from embeddings** | `embeddings.js:9` | Can't recall what happened on a given day |
| 8 | **Imports excluded from embeddings** | `embeddings.js:9` | Can't find captured messy notes |
| 9 | **Only first chunk embedded** | `embeddings.js:193` | Long notes only partially searchable |

---

## 9. Top 15 Build Tasks

### 1. Fix vault sync conflict resolution
**Why:** Silent data loss is the #1 trust destroyer.
**Files:** `backend/services/vault-sync.js`
**Outcome:** Conflicts preserved in `Conflicts/` folder, push notification sent, never silent discard.

### 2. Fix ChatPanel double-mount
**Why:** Two chat instances cause duplicate API calls, doubled SSE streams, and UI confusion.
**Files:** `frontend/src/App.jsx`
**Outcome:** Exactly one ChatPanel renders at any time.

### 3. Fix chat history ordering
**Why:** Messages appearing in wrong order on reload destroys trust in conversation continuity.
**Files:** `frontend/src/components/ChatPanel.jsx` (remove line 230 `.reverse()`)
**Outcome:** Chat history loads chronologically (oldest first).

### 4. Harden vault API auth
**Why:** Unauthenticated vault access on the LAN is a security risk.
**Files:** `backend/routes/vault.js`, `frontend/src/api.js`
**Outcome:** All vault requests require auth token. No key = no access.

### 5. Fix path traversal in export-docx and related endpoints
**Why:** Arbitrary file read/write outside vault.
**Files:** `backend/routes/vault.js` — lines 186, 223
**Outcome:** All user-supplied paths validated through `safePath()`.

### 6. Expand embedding scope to include Daily/ and Imports/
**Why:** The two highest-volume capture surfaces are invisible to semantic search.
**Files:** `backend/services/embeddings.js` — line 9
**Outcome:** Daily notes and imports are embedded and searchable.

### 7. Implement multi-chunk embedding
**Why:** Long notes are only partially searchable (first 1500 chars).
**Files:** `backend/services/embeddings.js`, `backend/db/schema.sql`, `backend/db/database.js`
**Outcome:** All chunks of every note are embedded.

### 8. Create unified retrieval service
**Why:** Keyword, semantic, and temporal search are currently separate with no fusion.
**Files:** New `backend/services/retrieval.js`, modify `backend/services/claude.js`
**Outcome:** Single `search()` call returns fused results from all retrieval methods.

### 9. Redesign sidebar to 3 primary + secondary nav
**Why:** 18 nav items creates decision paralysis for ADHD user.
**Files:** `frontend/src/components/Sidebar.jsx`, `frontend/src/App.jsx`
**Outcome:** 3 primary buttons (Review, Ask, Capture) + collapsible secondary group.

### 10. Build the Review surface (merge Dashboard + Standup + Todos + Journal)
**Why:** The core daily rhythm should be one surface, not four separate panels.
**Files:** `frontend/src/components/Dashboard.jsx` (redesign as ReviewPanel)
**Outcome:** Single time-aware view that shows the right content at the right time of day.

### 11. Simplify Capture panel
**Why:** 5 mode buttons is too many choices for "dump this thought quickly."
**Files:** `frontend/src/components/CapturePanel.jsx`
**Outcome:** Default to text box. Auto-detect type. File upload via icon. Escalation moved to Queue.

### 12. Incremental embedding on capture
**Why:** Notes captured during the day aren't searchable until 2am rebuild.
**Files:** `backend/routes/capture.js`, `backend/services/embeddings.js`
**Outcome:** Every new capture is embedded immediately after save.

### 13. Add scoped retrieval for person/meeting context
**Why:** "What did I discuss with Heidi?" should search Heidi-scoped context, not the whole vault.
**Files:** `backend/services/retrieval.js`, `backend/services/claude.js`
**Outcome:** AI can scope searches to specific people, meetings, or time ranges.

### 14. Entity extraction on capture
**Why:** Automatically identifying people, tasks, and decisions from messy captures is core to the "organize later" promise.
**Files:** New `backend/services/entities.js`, `backend/routes/capture.js`
**Outcome:** Captures are auto-tagged with extracted people, tasks, and decisions.

### 15. Conflict UI and notification
**Why:** Vault sync conflicts need to be visible and reviewable.
**Files:** `backend/routes/vault.js` (new endpoint), `frontend/src/components/Dashboard.jsx` (conflict banner)
**Outcome:** User sees conflict count in Review and can resolve conflicts from the UI.

---

## 10. Build Recommendation

### If we are building this now, start here:

**Week 1: Safety Sprint (Tasks 1-5)**
Fix the five things that can lose data or break trust:
1. Vault sync conflict resolution → `vault-sync.js`
2. ChatPanel double-mount → `App.jsx`
3. Chat history ordering → `ChatPanel.jsx`
4. Vault API auth → `vault.js`
5. Path traversal fixes → `vault.js`

**Week 2: Retrieval Sprint (Tasks 6-8, 12)**
Make the AI actually able to find things:
6. Expand embedding scope (Daily + Imports)
7. Multi-chunk embedding
8. Unified retrieval service with RRF
12. Incremental embedding on capture

**Week 3: UX Sprint (Tasks 9-11)**
Simplify the interface to three workflows:
9. Redesign sidebar (3 primary + secondary)
10. Build Review surface
11. Simplify Capture

**Week 4: Intelligence Sprint (Tasks 13-15)**
Make the system smarter:
13. Scoped retrieval
14. Entity extraction
15. Conflict UI

This sequence ensures safety first, then capability, then simplification, then intelligence. Each week produces a deployable improvement. The user gets immediate trust gains in week 1, better recall in week 2, lower cognitive load in week 3, and smarter behaviour in week 4.

**First commit:** Fix vault sync conflict resolution. It's the single highest-risk behaviour in the product and the change is isolated to one file.
