# NEURO Advanced Capabilities — Implementation Plan

## Pre-work
- [x] Read prompt in full
- [x] Read all 8 listed files
- [x] Create todo tracker

## Feature A — Proactive Meeting Prep Push
- [x] Create `backend/services/meeting-prep.js` — polls calendar, matches People notes, sends push
- [x] Add 5-min cron in `scheduler.js`
- **Files created:** meeting-prep.js
- **Files modified:** scheduler.js

## Feature B — Synthesis Mode in Chat
- [x] Add synthesis pattern detection in `claude.js` streamChat
- [x] Expand vault search to 12 results in synthesis mode
- [x] Append SYNTHESIS MODE instruction to system prompt
- **Files modified:** claude.js

## Feature C — Structured Document Export from Chat
- [x] Add POST `/api/vault/export-docx` route in `vault.js`
- [x] Add ExportButton component + detectExportIntent in `ChatPanel.jsx`
- [x] Add export CSS to `ChatPanel.css`
- **Files modified:** vault.js, ChatPanel.jsx, ChatPanel.css

## Feature D — Auto-linking: New Notes Mention Detection
- [x] Add `autoLink()` function to `obsidian.js`
- [x] Wire into `saveMeetingNoteFromChat` and `appendDecision`
- **Files modified:** obsidian.js

## Feature E — Orphan Detection in Weekly Review
- [x] Add `findOrphanedNotes()` to `obsidian.js`
- [x] Wire into `generateWeeklyReview` sections
- **Files modified:** obsidian.js

## Feature F — Temporal Retrieval: Date-Aware Search
- [x] Add GET `/api/vault/search/temporal` route in `vault.js`
- [x] Add `extractTemporalContext()` to `claude.js`
- [x] Wire temporal results into streamChat vault search
- **Files modified:** vault.js, claude.js

## Verification
- [x] node --check all backend files — all pass
- [x] npm run build frontend — clean
- [x] Commit and push
