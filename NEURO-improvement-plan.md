# NEURO Improvement Plan

Deep-dive audit completed 21 March 2026. 10 improvements identified, prioritised by
value-to-effort ratio. Features are grouped into three tiers.

CC instructions: When starting work, create `NEURO-improvement-todo.md` using the
template at the bottom of this file. Update both files as you complete each item —
mark tasks done in the todo, update status in this plan. Do not mark anything complete
until `node --check` passes on all modified backend files and `npm run build` passes clean.

---

## Tier 1 — High value, contained (build these first)

### IMP-01 — Dashboard today's calendar
**Status:** Complete
**Summary:** Added calendar strip to Dashboard between stats and 90-day bar. Reuses existing `/api/obsidian/calendar` endpoint via useCachedFetch (2min interval). Shows up to 5 events with NOW indicator. Clicking navigates to Calendar tab.
**Priority:** 1 — first thing you see every morning should include today's meetings
**Effort:** S

Surface today's calendar events inline on the Dashboard, between the stat cards and
the task list. Use the existing `fetchCalendarEvents` service — just call it from the
dashboard route and render a compact timeline. No new infrastructure needed.

Files: `backend/routes/obsidian.js` or new `backend/routes/dashboard.js`,
`frontend/src/components/Dashboard.jsx`, `frontend/src/components/Dashboard.css`

Acceptance: Dashboard shows today's meetings with times. Clicking navigates to Calendar tab.

---

### IMP-02 — Standup yesterday carry-forward
**Status:** Complete
**Summary:** New `/api/standup/carry-forward` endpoint extracts `[ ]` and `[>]` items from yesterday's Focus Today / Carry sections. StandupEditor shows removable carry-over items with "Add all to Today" button that injects them into the template.
**Priority:** 2 — removes the biggest daily friction point
**Effort:** S

StandupEditor currently loads the STANDUP.md template cold every morning. It should
pre-fill from yesterday's daily note: pull the "## Focus Today" items that were NOT
completed (status `[ ]` or `[>]`), surface them as "Carry-overs from yesterday", and
pre-populate the "Today" section with them.

Files: `backend/routes/standup.js`, `frontend/src/components/StandupEditor.jsx`

Acceptance: On opening Standup tab, incomplete items from yesterday's daily note appear
as carry-overs. User can remove any before saving.

---

### IMP-03 — Vault markdown preview
**Status:** Complete
**Summary:** Added Edit/Preview toggle to VaultBrowser editor. Preview uses ReactMarkdown with wiki-link rendering as bold spans and dataview blocks as code fences. Full styling for headers, tables, blockquotes, code blocks.
**Priority:** 3 — notes are unreadable in raw form
**Effort:** S

VaultBrowser editor is a raw textarea. Add a toggle between Edit (current textarea)
and Preview (ReactMarkdown render). ReactMarkdown is already installed in the frontend.
Wiki-links `[[Note Name]]` should render as non-clickable spans (full link resolution
is out of scope).

Files: `frontend/src/components/VaultBrowser.jsx`, `frontend/src/components/VaultBrowser.css`

Acceptance: Toggle button in editor header switches between raw markdown and rendered
preview. Dataview blocks render as code fences (not executed).

---

### IMP-04 — People note write-back
**Status:** Complete
**Summary:** New `POST /api/obsidian/people/:name/update` endpoint updates frontmatter fields (last-1-2-1, next-1-2-1-due) and appends dated notes blocks. "Update 1-2-1" button on each person card opens inline form. Auto-refreshes card data after save.
**Priority:** 4 — closes the most critical data loop
**Effort:** M

After a 1-2-1, NEURO should be able to update the Person's vault note: set
`last-1-2-1`, set `next-1-2-1-due`, and append a notes block. Two surfaces:
(a) a form on the PeopleBoard card — quick post-meeting update, and (b) a chat command
"[UPDATE PERSON: Name]" that triggers structured extraction and writes back.

Backend: new `POST /api/obsidian/people/:name/update` endpoint in `backend/routes/obsidian.js`
that writes frontmatter fields and appends a notes block.
Frontend: add an "Update" form to each person card in PeopleBoard.

Files: `backend/routes/obsidian.js`, `backend/services/obsidian.js`,
`frontend/src/components/PeopleBoard.jsx`, `frontend/src/components/PeopleBoard.css`

Acceptance: Tapping "Update 1-2-1" on a person card shows a small form: last date,
next date, notes. Submitting writes to the vault note frontmatter and appends a dated
notes block.

---

### IMP-05 — Chat conversation continuity
**Status:** Complete
**Summary:** ConversationId persisted in localStorage; last conversation auto-loads on mount. New `GET /api/chat/conversations` endpoint lists last 5 conversations with preview. Clickable conversation list in chat header. "New" button always visible.
**Priority:** 5 — conversations vanish on close
**Effort:** M

The DB already stores full conversation history keyed by `conversationId`. The frontend
discards it by generating a new `conv_${Date.now()}` on every mount. Fix: store the
last `conversationId` in localStorage, reload the last N messages on mount, show a
"New conversation" button to start fresh. Add a minimal conversation list (last 5) in
the chat header.

Files: `frontend/src/components/ChatPanel.jsx`, `backend/routes/chat.js` (new GET endpoint
to retrieve conversation history)

Acceptance: Reopening the chat panel shows the last conversation. "New" button starts
a fresh one. Last 5 conversation stubs visible in a small list.

---

## Tier 2 — High value, more involved

### IMP-06 — Inbox persistence and dismiss
**Status:** Complete
**Summary:** New `inbox_items` table in schema.sql. Scanner persists items to DB via `upsertInboxItem()` instead of in-memory array. Items survive restart. Dismiss button on each inbox card calls `POST /api/microsoft/inbox/dismiss`. Dismissed items hidden but kept 7 days. Auto-cleanup of old dismissed items on each scan.
**Priority:** 6 — inbox resets on every Pi restart
**Effort:** M

`flaggedItems` in `inbox-scanner.js` is a module-level in-memory array. Restart the Pi,
inbox triage gone. It needs to persist to the DB (`agent_state` or a new
`inbox_items` table). InboxPanel also has no way to dismiss individual items — you can
read triage but can't mark anything as handled.

Files: `backend/services/inbox-scanner.js`, `backend/db/schema.sql`,
`backend/db/database.js`, `backend/routes/` (new inbox route or extend existing),
`frontend/src/components/InboxPanel.jsx`

Acceptance: Flagged items survive Pi restart. Each item has a Dismiss button.
Dismissed items are hidden from the panel but kept in DB for 7 days.

---

### IMP-07 — PLAUD → People / Meeting note pipeline
**Status:** Complete
**Summary:** New `transcript-processor.js` service uses Claude to extract people, action items, key topics, and meeting date from PLAUD transcripts. Runs automatically after `autoClassify` routes a plaud-transcript. Matches extracted names against People/ vault notes. Auto-updates `last-1-2-1` on matched person if it's a 1-2-1. Results persisted to agent_state and broadcast via SSE. ImportsPanel shows "Recent Transcript Extractions" with people (matched/linked), action items, and topics.
**Priority:** 7 — transcripts land but nothing is extracted
**Effort:** M

When a PLAUD transcript is routed to Meetings/, Claude should extract:
- Any people mentioned by name → link to their People notes
- Any action items → offer to add to Master Todo
- The meeting date → set as `last-1-2-1` on the relevant Person note if it's a 1-2-1

This runs as a post-route processing step after `autoClassify` routes a
`plaud-transcript` type file.

Files: `backend/services/imports.js`, `backend/services/obsidian.js`,
new `backend/services/transcript-processor.js`

Acceptance: After a PLAUD transcript is routed, a push notification arrives with a
summary and any extracted action items. Opening the Imports panel shows extracted
entities. People notes are updated automatically if a name matches.

---

### IMP-08 — Insights → actionable interventions
**Status:** Complete
**Summary:** `detectPatterns()` in activity.js analyzes 14-day summaries for 5 patterns: consecutive late standups, high todo snooze count, standup snooze streak, EOD ritual drop-off, low NEURO engagement. Each pattern generates a suggestion with severity and one-click action. "Move nudge to 08:45" persists custom time to agent_state; scheduler checks for early nudge at 8:45am. InsightsPanel shows "Suggestions" section above Today card with dismiss and action buttons. Navigation actions route to relevant tabs.
**Priority:** 8 — data exists but nothing closes the loop
**Effort:** M

The Insights panel shows patterns (standup late 4 days in a row, high snooze count)
but offers no intervention. Add pattern detection that:
- Detects 3+ consecutive late standups → suggests moving nudge to 8:45am
- Detects high todo snooze count → flags specific todo items as avoidance targets
- Surfaces to NEURO chat context with a "suggested action" line

Files: `backend/services/activity.js`, `backend/services/nudges.js`,
`frontend/src/components/InsightsPanel.jsx`

Acceptance: InsightsPanel shows a "Suggestions" section when patterns are detected.
Suggestions include a one-click action (e.g. "Move standup nudge to 08:45") that
actually changes the scheduler.

---

## Tier 3 — High value, significant build

### IMP-09 — Semantic search (RAG)
**Status:** Complete
**Priority:** 9 — keyword search misses most of what's in the vault
**Effort:** L

Replace keyword-based `searchVault` with semantic similarity search using the
Anthropic embeddings API. Store embeddings in SQLite as JSON blobs. Rebuild embeddings
nightly for changed files. At chat time, embed the user's query and find the top-K
most similar vault notes.

This is the single biggest lever for making NEURO feel like it actually knows what
you know rather than just text-matching.

Files: new `backend/services/embeddings.js`, `backend/services/obsidian.js`,
`backend/db/schema.sql` (new `vault_embeddings` table), `backend/services/claude.js`,
`backend/services/scheduler.js`

Acceptance: Chat queries like "what have I been thinking about team capability?" return
semantically relevant vault notes even without exact keyword matches.

---

### IMP-10 — Chat-driven vault writes
**Status:** Complete
**Priority:** 10 — closes the last major data loop
**Effort:** L

Allow structured commands in chat that write back to the vault:
- `[UPDATE PERSON: Name]` — extract structured update from conversation, write to People note
- `[MEETING NOTE: Title]` — save the current conversation summary as a meeting note
- `[ADD TODO: text]` — add to Master Todo inbox
- `[DECIDE: text]` — already works via [DECISION], ensure it's reliable

The parser already handles [DECISION]. Extend the same post-response handler in
`handleResponse` in `claude.js` to also handle these new markers.

Files: `backend/services/claude.js`, `backend/services/obsidian.js`,
`frontend/src/components/ChatPanel.jsx` (visual confirmation when a write happens)

Acceptance: Typing "please note that Heidi's next 1-2-1 is 8 April [UPDATE PERSON: Heidi Power]"
updates Heidi's People note frontmatter and confirms in the chat UI.

---

### IMP-11 — Chat todo extraction
**Status:** Complete
**Priority:** 11 — closes loop between Claude suggesting actions and them being captured
**Effort:** S

When Claude mentions action items in chat, there's no way to capture them without
manually copying. On iPhone this friction means they get lost.

A "→ Todo" button appears on assistant messages containing actionable language.
Tapping saves the suggested action to Master Todo inbox. Uses existing
POST /api/capture/todo endpoint.

Files: frontend/src/components/ChatPanel.jsx, backend/routes/capture.js (already exists)

Acceptance: Assistant messages with task-like content show a small "→ Todo" button.
Tapping saves to Master Todo inbox. Confirmation shown inline.

---

## Summary table

| # | Feature | Priority | Effort | Status |
|---|---|---|---|---|
| IMP-01 | Dashboard today's calendar | 1 | S | Complete |
| IMP-02 | Standup yesterday carry-forward | 2 | S | Complete |
| IMP-03 | Vault markdown preview | 3 | S | Complete |
| IMP-04 | People note write-back | 4 | M | Complete |
| IMP-05 | Chat conversation continuity | 5 | M | Complete |
| IMP-06 | Inbox persistence and dismiss | 6 | M | Complete |
| IMP-07 | PLAUD → People/Meeting pipeline | 7 | M | Complete |
| IMP-08 | Insights → actionable interventions | 8 | M | Complete |
| IMP-09 | Semantic search (RAG) | 9 | L | Complete |
| IMP-10 | Chat-driven vault writes | 10 | L | Complete |
| IMP-11 | Chat todo extraction | 11 | S | Complete |

---

## Instructions for CC — how to work through this plan

1. Read this file and `NEURO-improvement-todo.md` at the start of every session
2. Work through items in priority order (IMP-01 first)
3. Before starting each item, document your implementation plan as sub-tasks in the todo file
4. After completing each item:
   - Run `node --check` on all modified backend files
   - Run `cd frontend && npm run build` — must pass clean
   - Update the todo file (tick completed tasks)
   - Update the status in this plan file (change "Not started" to "Complete" or "In progress")
   - Add a one-line summary of what changed under the item in this file
5. Do not commit to git
6. If you hit a judgement call, document it in the todo file under the relevant item

---

## Todo file template

When starting work, create `NEURO-improvement-todo.md` with this structure:

```markdown
# NEURO Improvement Todo

Last updated: [date]

## IMP-01 — Dashboard today's calendar
- [ ] Add calendar fetch to dashboard backend route
- [ ] Add CalendarStrip component to Dashboard.jsx
- [ ] Style for mobile
- [ ] node --check backend
- [ ] npm run build

## IMP-02 — Standup yesterday carry-forward
...

(Continue for each IMP item being worked on)
```
