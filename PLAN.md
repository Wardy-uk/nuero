# NEURO Build Plan

**Created:** 2026-03-19
**Status:** All 4 priorities built — pending deployment + testing

---

## Priority 1 — Jira fix via n8n ingest

**Problem:** Pi cannot make HTTPS calls to Atlassian (EPIPE crashes Node.js). All direct Jira API code must be removed.

**Solution:** n8n polls Jira on a schedule, POSTs pre-fetched ticket JSON to NEURO's new ingest endpoint.

### Steps:
1. **Backend: Add POST /api/queue/ingest endpoint** (`routes/queue.js`)
   - Accepts `{ tickets: [...] }` JSON body
   - Validates `X-Ingest-Secret` header against `INGEST_SECRET` env var
   - Calls `db.clearStaleTickets()` then `db.upsertTicket()` for each ticket
   - Updates jira_status, jira_last_sync, jira_ticket_count in agent_state

2. **Backend: Remove dead Jira code**
   - Delete `backend/services/jira-worker.js`
   - Gut `backend/services/jira.js` — keep `isConfigured()` (returns false now), remove `fetchAndCacheTickets()`
   - Remove Jira cron from `scheduler.js` (already commented out, clean up fully)
   - Remove `node-fetch` from backend/package.json (unused after jira-worker removal)

3. **Update .env.example** — add `INGEST_SECRET=`

4. **Build n8n workflow** (via n8n MCP):
   - Schedule trigger: every 5 minutes
   - HTTP Request node: POST to Jira REST API `/rest/api/3/search/jql`
   - Code node: map Jira fields to NEURO schema (ticket_key, summary, status, priority, assignee, sla fields)
   - HTTP Request node: POST to `https://pi-dev.tailecb90f.ts.net/api/queue/ingest` with `X-Ingest-Secret` header

5. **Test:** Queue data appears in NEURO UI without any Pi→Atlassian calls

### Files changed:
- `backend/routes/queue.js` — add POST /ingest
- `backend/services/jira.js` — strip to stub
- `backend/services/jira-worker.js` — DELETE
- `backend/services/scheduler.js` — remove dead Jira references
- `backend/.env.example` — add INGEST_SECRET

---

## Priority 2 — Web Push notifications (iOS PWA) DONE

### Built:
- `npm install web-push` in backend
- `services/webpush.js` — VAPID-based push, auto-cleanup of expired subscriptions
- `routes/push.js` — POST /subscribe, GET /vapid-public-key, POST /test
- Wired into `nudges.js` — standup nudge, todo nudge, and nag escalation all send push
- `frontend/public/sw.js` — service worker handles push events, click navigates to relevant view
- `frontend/src/usePushNotifications.js` — auto-registers SW and subscribes on app load
- `frontend/src/components/InstallBanner.jsx` — iOS Safari "Add to Home Screen" prompt
- `frontend/public/manifest.json` + apple meta tags in index.html for PWA
- DB: `push_subscriptions` table added to schema.sql
- .env.example: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY added

### VAPID keys generated:
- Public: `BFOhLQLIeROCj4PRvlUBUUV56uSRXgkBh1um2d9U8tOxBE-3vn5K-wmVGt90LG_-MD3Qy6ViPk3LWBEAQ_Zd7gU`
- Private: `Bs_0zGEr5F-NHlfDx-4Z888L9iOewhxXGrCsZCakSJI`

---

## Priority 3 — Weekend / backup standup button DONE

### Built:
- `obsidian.js` — `readRitualState()` reads `Scripts/ritual-state.json`, `readPreviousDailyNote()`
- `routes/standup.js` — GET /ritual-state, POST /backup (Ritual 5 format, max 3 items, carry-overs)
- `StandupEditor.jsx` — BackupStandup component with auto-show (weekends + weekdays after 09:30)
- "Quick backup" button always available in standup header

---

## Priority 4 — Imports sweep DONE

### Built:
- `services/imports.js` — recursive file scan of Imports/, skips `status: processed`, returns preview
- `routes/imports.js` — GET /pending, POST /classify (Ollama classification with bouncer rule)
- `ImportsPanel.jsx` + CSS — card-based UI with classify buttons, classification display
- `Sidebar.jsx` — "Imports" nav item with badge showing unprocessed count (polls every 60s)
- Bouncer rule: low-confidence items forced to `needs-review`
- Does NOT auto-move files — surfaces for Nick's confirmation only
