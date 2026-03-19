# NEURO Build — Task Tracker

## Priority 1 — Jira fix via n8n ingest

- [x] Add POST /api/queue/ingest with X-Ingest-Secret auth
- [x] Strip jira.js to stub (remove fetchAndCacheTickets, child process code)
- [x] Delete jira-worker.js
- [x] Clean up scheduler.js (remove dead Jira references)
- [x] Remove node-fetch from backend/package.json
- [x] Update .env.example with INGEST_SECRET
- [x] Build n8n workflow: Jira poll → POST to ingest endpoint (ID: 59Seb6rw2noE7lYy)
- [ ] Test: queue data appears in NEURO without Pi→Atlassian calls (needs INGEST_SECRET on Pi + n8n workflow secret)
- [x] Verify clean build (npm run dev)

## Priority 2 — Web Push notifications (iOS PWA)

- [x] npm install web-push
- [x] Generate VAPID keys, add to .env.example
- [x] Create routes/push.js (subscribe + vapid-public-key endpoints + POST /test)
- [x] Create services/webpush.js (sendToAll with auto-cleanup of expired subs)
- [x] Wire into nudges.js broadcast() (standup, todo, nag escalation)
- [x] Create frontend/public/sw.js (service worker + notification click → navigate)
- [x] Push subscription registration in frontend (usePushNotifications hook, auto-subscribe)
- [x] iOS Safari install banner (InstallBanner component, session-dismissable)
- [x] PWA manifest.json + apple meta tags in index.html
- [ ] Test: nudge on iPhone lock screen (needs VAPID keys in Pi .env)

## Priority 3 — Weekend / backup standup button

- [x] GET /api/standup/ritual-state endpoint (reads ritual-state.json from vault)
- [x] POST /api/standup/backup endpoint (Ritual 5 — max 3 focus items, carry-overs from previous day)
- [x] Read STANDUP.md for Ritual 5 format
- [x] Frontend: BackupStandup component with auto-show logic (weekends + weekdays after 09:30)
- [x] "Quick backup" button in StandupEditor header
- [ ] Test: button appears on weekends / after 09:30 with no standup

## Priority 4 — Imports sweep

- [x] GET /api/imports/pending endpoint (recursive scan, skips status:processed)
- [x] POST /api/imports/classify endpoint (Ollama classification with bouncer rule)
- [x] Frontend: ImportsPanel with classify buttons + classification display
- [x] Sidebar: Imports nav item with unprocessed count badge
- [ ] Test: unprocessed files surfaced, classification works (needs Ollama on Pi)

## Deployment checklist (all priorities)

- [ ] Add to Pi .env: INGEST_SECRET=<random>, VAPID_PUBLIC_KEY=..., VAPID_PRIVATE_KEY=...
- [ ] Delete backend/db/agent.db on Pi (schema changed — push_subscriptions table added)
- [ ] git push, SSH to Pi, git pull, npm install, npm run build, pm2 restart
- [ ] Set X-Ingest-Secret in n8n workflow "POST to NEURO Ingest" node to match Pi .env
- [ ] Activate n8n workflow "NEURO — Jira Queue Ingest" (ID: 59Seb6rw2noE7lYy)
- [ ] Open nuero.nickward.co.uk on iPhone Safari → Add to Home Screen
- [ ] Verify: queue populates, push notification arrives, backup standup works, imports badge shows
