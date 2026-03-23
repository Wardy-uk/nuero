# NOVA → NEURO O365 Bridge Results — 2026-03-23

## Changes Made

### NOVA side (C:\Users\NickW\Claude\windows automation\daypilot)
- `.env` — added `NEURO_BRIDGE_SECRET=neuro-nova-bridge-2026`
- `src/server/routes/neuro-bridge.ts` — NEW: bridge endpoints (status, calendar, mail, planner, todo) with shared-secret auth
- `src/server/index.ts` — imported and registered bridge routes at `/api/neuro-bridge` (no JWT middleware)
- `npm run build` — clean (vite + tsc)

### NEURO side (nick-agent)
- `backend/.env` — added `NOVA_BRIDGE_URL=http://localhost:3001` and `NOVA_BRIDGE_SECRET`
- `backend/services/microsoft.js` — added `novaBridgeFetch()` and `isBridgeConfigured()` helpers; `fetchCalendarEvents` and `fetchRecentEmails` now try MSAL first, fall back to NOVA bridge

### Pi (.env)
- Added `NOVA_BRIDGE_URL=http://100.65.153.14:3001` (Windows Tailscale IP) and `NOVA_BRIDGE_SECRET`

## Status
- NOVA build: clean
- NEURO `node --check`: passes
- Bridge NOT tested yet — NOVA not running locally (port conflict with NEURO dev on 3001). Needs NOVA restart on work server.

## Not committed to git
