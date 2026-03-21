# NEURO Build Plan — Master Prompt Implementation

## Analysis Summary

After reading all target files, several SNAGs are **already fully implemented** from prior sessions:

| SNAG | Description | Status | Reason |
|------|-------------|--------|--------|
| SNAG-016 | Vault search injection | **SKIP** | `searchVault` in obsidian.js, `extractSearchTerms` in claude.js, vault search in `streamChat`, `buildContextBlock` vault injection — all present |
| SNAG-5b | Nag messages + weekly shuffle | **SKIP** | 90 STANDUP_MESSAGES, 50 TODO_MESSAGES, `seededRandom`, `getWeekNumber`, `getWeeklyShuffledOrder`, `getNagMessage` — all present |
| SNAG-019 | 1-2-1 tracker | **TODO** | `getUpcoming121s`, `check121Nudges`, scheduler wiring, claude.js injection — none present |
| SNAG-020 | Weekly review | **TODO** | `generateWeeklyReview`, Friday cron, manual trigger endpoint — none present |
| SNAG-021 | Decision log context | **TODO** | `getRecentDecisions`, claude.js injection — none present |
| SNAG-022 | EOD ritual | **TODO** | `triggerEodNudge`, `markEodDone`, 5pm cron, EOD endpoint, EodCapture component — none present |
| SNAG-023 | Centralised snooze | **SKIP** | DB-backed snooze, `getSnoozeState`, routes, NudgeBanner all types — all present |
| SNAG-024 | Meeting prep injection | **SKIP** | `getMeetingPrepContext` in obsidian.js, claude.js injection — all present |
| SNAG-025 | PLAUD pipeline | **SKIP** | PLAUD sweep cron, push notification, `Imports/PLAUD/` in VALID_DESTINATIONS — all present |
| SNAG-Push | Push hardening | **PARTIAL** | nudges.js snooze check OK; server.js needs subscription count; push.js needs /subscriptions; sw.js needs PNG icon; AdminPanel.jsx needs overhaul; .env.example needs update |
| Task B | Master Todo updates | **TODO** | Three deferred feature items to add |

## Implementation Order

1. **SNAG-019** — 1-2-1 tracker intelligence (M)
   - Files: obsidian.js, nudges.js, scheduler.js, claude.js
   - Dependencies: obsidian.js being current (confirmed)
   - Add `getUpcoming121s` → `check121Nudges` → scheduler wire → claude.js context

2. **SNAG-020** — Weekly review automation (M)
   - Files: obsidian.js, scheduler.js, standup.js
   - Dependencies: obsidian.js, scheduler.js
   - Add `generateWeeklyReview` → Friday 4:30pm cron → POST /weekly-review endpoint

3. **SNAG-021** — Decision log context (S)
   - Files: obsidian.js, claude.js
   - Dependencies: obsidian.js, claude.js
   - Add `getRecentDecisions` → claude.js buildContextBlock injection

4. **SNAG-022** — EOD ritual (M)
   - Files: nudges.js, scheduler.js, standup.js, StandupEditor.jsx
   - Dependencies: nudges.js, standup.js, StandupEditor.jsx
   - Add `triggerEodNudge`/`markEodDone` → 5pm cron → POST /eod → EodCapture component

5. **SNAG-Push** — Push notification hardening (S)
   - Files: server.js, push.js, sw.js, AdminPanel.jsx, .env.example
   - nudges.js snooze check already correct — no change needed
   - Add subscription count to status → /subscriptions endpoint → PNG icons → AdminPanel overhaul → .env.example update

6. **Task B** — Master Todo deferred features (S)
   - File: Master Todo.md in vault
   - Add 3 NEURO items to Later/NOVA section
