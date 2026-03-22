# NEURO Improvement Todo

Last updated: 2026-03-22 (All improvements IMP-01 through IMP-11 complete)

## IMP-01 — Dashboard today's calendar ✓
- [x] Reused existing `/api/obsidian/calendar` endpoint via useCachedFetch (no new backend route needed)
- [x] Created inline CalendarStrip in Dashboard.jsx (compact timeline, up to 5 events, NOW indicator)
- [x] Click on strip navigates to Calendar tab
- [x] Styled for mobile
- [x] npm run build — passes clean
- **Judgement call:** No new backend route created. The existing `/api/obsidian/calendar?start=&end=` serves exactly the right data.

## IMP-02 — Standup yesterday carry-forward ✓
- [x] Added `GET /api/standup/carry-forward` endpoint — extracts `[ ]` and `[>]` items from yesterday's Focus Today and Carry sections
- [x] Updated StandupEditor.jsx — fetches carry-forwards via useCachedFetch, shows removable items
- [x] "Add all to Today" button injects carry-overs into standup template's Today section
- [x] node --check backend — passes
- [x] npm run build — passes clean
- **Judgement call:** Reused `readPreviousDailyNote()` which already handles Monday→Friday lookback. Strips `#hashtags` from carry-over text to keep it clean.

## IMP-03 — Vault markdown preview ✓
- [x] Added Edit/Preview toggle button to VaultBrowser editor header
- [x] Added ReactMarkdown preview mode (react-markdown already installed)
- [x] Wiki-links `[[Note Name]]` render as bold spans (non-clickable)
- [x] Dataview/dataviewjs blocks render as code fences
- [x] Styled toggle button, preview pane (headers, tables, blockquotes, code, lists)
- [x] npm run build — passes clean
- **Judgement call:** Rendered wiki-links as `**bold**` rather than styled spans — simpler, visually distinct, no extra component needed.

## IMP-04 — People note write-back ✓
- [x] Added `updatePersonNote()` to obsidian service — updates/inserts frontmatter fields, appends dated notes block
- [x] Added `POST /api/obsidian/people/:name/update` endpoint
- [x] Added UpdateForm component to PeopleBoard with date pickers and notes textarea
- [x] "Update 1-2-1" button on each person card (only if vault note exists)
- [x] Auto-refreshes person data after save
- [x] node --check backend — passes
- [x] npm run build — passes clean
- **Judgement call:** Only surface (a) the form on PeopleBoard is implemented here. Surface (b) the chat command `[UPDATE PERSON: Name]` is deferred to IMP-10 as specified in the plan.

## IMP-05 — Chat conversation continuity ✓
- [x] History endpoint already existed at `GET /api/chat/history/:conversationId`
- [x] Added `GET /api/chat/conversations` endpoint — groups by conversation_id, returns last 5 with preview
- [x] Added `getRecentConversations()` to database.js
- [x] ConversationId stored in localStorage, restored on mount
- [x] Last conversation messages auto-loaded on mount
- [x] Clickable conversation list in chat header (click NUERO title to toggle)
- [x] "New" button always visible, starts fresh conversation
- [x] Conversation list refreshes after each message exchange
- [x] node --check backend — passes
- [x] npm run build — passes clean
- **Judgement call:** Made the "New" button always visible (not just when messages exist) for better discoverability. Conversation list toggled by clicking the NUERO title to avoid extra UI chrome.

## IMP-06 — Inbox persistence and dismiss ✓
- [x] Added `inbox_items` table to schema.sql (email_id UNIQUE, dismissed flag, dismissed_at timestamp)
- [x] Added DB helpers: `upsertInboxItem()`, `getActiveInboxItems()`, `dismissInboxItem()`, `cleanupOldDismissed()`, `clearStaleInboxItems()`
- [x] Rewrote inbox-scanner.js — persists items to DB via `upsertInboxItem()` instead of in-memory array; preserves dismissed state on re-scan
- [x] `getFlaggedItems()` now reads from DB — items survive Pi restart
- [x] Added `POST /api/microsoft/inbox/dismiss` endpoint
- [x] Added dismiss (×) button on each inbox item in InboxPanel.jsx
- [x] Auto-cleanup of dismissed items older than 7 days runs on each scan
- [x] node --check backend — passes
- [x] npm run build — passes clean
- **Judgement call:** Used `INSERT OR REPLACE` with COALESCE subqueries to preserve dismissed state when a re-scan upserts the same email_id. Dismiss tracked as `inbox` type in activity log.

## IMP-07 — PLAUD → People / Meeting note pipeline ✓
- [x] Created `backend/services/transcript-processor.js` — uses Claude to extract people, action items, key topics, meeting date, and 1-2-1 detection
- [x] Matches extracted people names against vault People/ notes (first/last name fuzzy match)
- [x] Auto-updates `last-1-2-1` on matched person note if transcript is a 1-2-1
- [x] Results persisted to `agent_state` for cross-session retrieval
- [x] Wired into `autoClassify()` in imports.js — runs after routing a `plaud-transcript` type file
- [x] Push notification includes summary, action count, and any person updates
- [x] Added `GET /api/imports/transcript/:fileName` endpoint to retrieve stored results
- [x] ImportsPanel shows "Recent Transcript Extractions" section via SSE `transcript_processed` events
- [x] Extraction UI shows: matched/unmatched people, action items list, key topic tags
- [x] node --check backend — passes
- [x] npm run build — passes clean
- **Judgement call:** Transcript content truncated to 8000 chars for Claude API call to stay within reasonable token usage. Falls back gracefully if Claude API key missing or transcript too short (<50 chars).

## IMP-08 — Insights → actionable interventions ✓
- [x] Added `detectPatterns()` to activity.js — analyzes 14-day summaries for 5 behavioral patterns
- [x] Pattern: 3+ consecutive late standups (after 10am) → suggests moving nudge to 08:45
- [x] Pattern: High todo snooze count (avg >2/day over 5 days) → flags avoidance pattern
- [x] Pattern: Standup snoozed 3+ times today → high severity immediate prompt
- [x] Pattern: EOD skipped 3+ consecutive days → gentle reminder
- [x] Pattern: No chat messages for 3+ days → engagement prompt
- [x] Added `applySuggestion()` — persists custom standup nudge time to agent_state
- [x] Added 8:45am cron job in scheduler.js — fires early standup nudge if custom time configured
- [x] Added `GET /api/activity/suggestions` and `POST /api/activity/suggestions/apply` endpoints
- [x] InsightsPanel shows "Suggestions" section with severity-colored cards, dismiss buttons, and one-click action buttons
- [x] Navigation actions (Open Todos, Do standup now, Open chat) route to relevant tabs via `onNavigate` prop
- [x] Passed `onNavigate={handleNavigate}` to InsightsPanel in App.jsx
- [x] node --check backend — passes
- [x] npm run build — passes clean
- **Judgement call:** Custom nudge time stored in agent_state rather than env vars — allows runtime changes without server restart. Only added 8:45am cron (not fully dynamic) to keep scheduler simple.

## Prompt #17 — Manual route picker for imports ✓
- [x] Add `reviewReason` field to pending file object in `backend/services/imports.js`
- [x] Add `VAULT_FOLDERS` constant and `manualRoute` handler in `ImportsPanel.jsx`
- [x] Add `ManualRoutePicker` component in `ImportsPanel.jsx`
- [x] Wire picker into card render for needs-review and low-confidence files
- [x] Add manual route picker styles to `ImportsPanel.css`
- [x] node --check backend/services/imports.js
- [x] npm run build — passes clean

## Prompt #18 — Journal + Strava + Apple Health ✓
- [x] Step 2: Add journal nudge to `nudges.js` (triggerJournalNudge, markJournalDone)
- [x] Step 3: Wire journal cron into `scheduler.js`
- [x] Step 4: Create `backend/routes/journal.js` (prompts + save + settings endpoints)
- [x] Step 5: Create `frontend/src/components/JournalPanel.jsx`
- [x] Step 6: Create `frontend/src/components/JournalPanel.css`
- [x] Step 7: Wire JournalPanel into `App.jsx`, `Sidebar.jsx`, `NudgeBanner.jsx`
- [x] Step 8: Add Strava env vars to `.env.example`
- [x] Step 9: Create `backend/services/strava.js`
- [x] Step 10: Create `backend/routes/strava.js`, register in server.js
- [x] Step 11: Inject Strava context into journal prompts
- [x] Step 12: Inject Strava into Claude chat context (make buildContextBlock async)
- [x] Step 13: Add Strava to AdminPanel settings and /api/status
- [x] Step 14: Create `backend/routes/health.js` (ingest + today + history + status)
- [x] Step 15: Create `backend/services/health.js` (context blocks for Claude + journal)
- [x] Step 16: Inject health data into journal prompts
- [x] Step 17: Inject health data into Claude chat context
- [x] Step 18: Add health status to AdminPanel and /api/status
- [x] Step 19: Document Shortcut JSON payload in `.env.example`
- [x] node --check all new/modified backend files
- [x] npm run build — passes clean

## IMP-11 — Chat todo extraction ✓
- [x] Add `extractActionableItems()` helper to ChatPanel.jsx
- [x] Add `TodoSaveButton` component to ChatPanel.jsx
- [x] Wire TodoSaveButton into assistant message rendering
- [x] Add chat-todo styles to ChatPanel.css
- [x] npm run build — passes clean

## IMP-09 — Semantic search (RAG) ✓
- [x] Step 1: Add `vault_embeddings` table to schema.sql
- [x] Step 2: Add embedding DB helpers to database.js
- [x] Step 3: Create `backend/services/embeddings.js`
- [x] Step 4: Add `searchVaultSemantic` to obsidian.js
- [x] Step 5: Update claude.js to use semantic search
- [x] Step 6: Wire nightly rebuild into scheduler.js
- [x] Step 7: Add manual rebuild endpoint to activity.js
- [x] node --check all modified backend files
- [x] npm run build — passes clean
- **Judgement call:** The installed `@anthropic-ai/sdk` does not expose `client.embeddings.create()` — the Voyage embeddings API requires a separate SDK or endpoint. The fallback TF-IDF style 128-dim word-hash vector is active. This provides better-than-keyword results for topically similar content but is not true semantic search. When/if Anthropic adds native embeddings to the SDK, the code will automatically use it (the try/catch checks for the method).

## IMP-10 — Chat-driven vault writes ✓
- [x] Step 1: Add `addTodoFromChat` and `saveMeetingNoteFromChat` to obsidian.js
- [x] Step 2: Extend `handleResponse` in claude.js for new markers ([ADD TODO], [MEETING NOTE], [UPDATE PERSON])
- [x] Step 3: Add vault write confirmation UI to ChatPanel.jsx (confirmation state + useEffect marker detection)
- [x] Step 4: Update SYSTEM_PROMPT in claude.js with chat command docs
- [x] Add vault write confirmation styles to ChatPanel.css
- [x] node --check backend files
- [x] npm run build — passes clean
- **Judgement call:** `[UPDATE PERSON: Name]` is UI-only (no automatic vault write) — writing to a person note without confirmation is too risky. The marker is detected client-side and shows a prompt to open the People tab manually.
