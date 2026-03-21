# NEURO Build Todo

## SNAG-016 — Vault search injection
- [x] obsidian.js: `searchVault` — SKIPPED (already exists)
- [x] claude.js: `extractSearchTerms` — SKIPPED (already exists)
- [x] claude.js: vault search in `streamChat` — SKIPPED (already exists)
- [x] claude.js: `buildContextBlock` vault results — SKIPPED (already exists)

## SNAG-5b — Nag messages + weekly shuffle
- [x] nudges.js: 90 STANDUP_MESSAGES — SKIPPED (already exists)
- [x] nudges.js: 50 TODO_MESSAGES — SKIPPED (already exists)
- [x] nudges.js: `seededRandom`, `getWeekNumber`, `getWeeklyShuffledOrder`, `getNagMessage` — SKIPPED (already exists)

## SNAG-019 — 1-2-1 tracker intelligence
- [x] obsidian.js: Add `getUpcoming121s` + export
- [x] nudges.js: Add `check121Nudges` + export
- [x] scheduler.js: Wire 1-2-1 check (9:10am cron + startup)
- [x] claude.js: Inject upcoming 1-2-1s into `buildContextBlock`

## SNAG-020 — Weekly review automation
- [x] obsidian.js: Add `generateWeeklyReview` + export
- [x] scheduler.js: Friday 4:30pm cron
- [x] standup.js: POST /weekly-review endpoint

## SNAG-021 — Decision log context
- [x] obsidian.js: Add `getRecentDecisions` + export
- [x] claude.js: Inject recent decisions into `buildContextBlock`

## SNAG-022 — EOD ritual
- [x] nudges.js: Add `triggerEodNudge` + `markEodDone` + export
- [x] scheduler.js: 5pm weekday cron
- [x] standup.js: POST /eod endpoint
- [x] StandupEditor.jsx: Add EodCapture component + EOD button + state/effect

## SNAG-023 — Centralised snooze
- [x] nudges.js: DB-backed snooze — SKIPPED (already exists)
- [x] nudges.js: `getSnoozeState` — SKIPPED (already exists)
- [x] routes/nudges.js: Return snoozeState, accept all types — SKIPPED (already exists)
- [x] NudgeBanner.jsx: Seed snooze from server, handle all types — SKIPPED (already exists)

## SNAG-024 — Meeting prep injection
- [x] obsidian.js: `getMeetingPrepContext` — SKIPPED (already exists)
- [x] claude.js: Meeting prep in `buildContextBlock` — SKIPPED (already exists)

## SNAG-025 — PLAUD pipeline wiring
- [x] scheduler.js: PLAUD sweep cron — SKIPPED (already exists)
- [x] imports.js: PLAUD push notification — SKIPPED (already exists)
- [x] imports.js: `Imports/PLAUD/` in VALID_DESTINATIONS — SKIPPED (already exists)

## SNAG-Push — Push notification hardening
- [x] nudges.js: Snooze check before push — SKIPPED (already correct)
- [x] server.js: Add subscription count to push status
- [x] routes/push.js: Add /subscriptions diagnostic endpoint
- [x] sw.js: Use PNG icon instead of SVG
- [x] AdminPanel.jsx: Push section overhaul
- [x] .env.example: Update VAPID comment

## Task B — Master Todo
- [x] Master Todo.md: Add 3 deferred NEURO feature items to Later/NOVA section

## Final Verification
- [x] node --check all modified backend files — ALL PASS
- [x] cd frontend && npm run build — CLEAN (231 modules, 1.93s)
