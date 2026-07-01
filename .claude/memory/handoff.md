# HANDOFF — Next mission: define NEURO vs SARA, then rebuild NEURO app light-touch (2026-07-01)

## THIS SESSION'S MISSION (do these two, in order)
1. **Define what NEURO and SARA actually are** — nail the concepts with Nick, then document them in the vault (a canonical definition note, e.g. `Projects/NEURO/NEURO & SARA — What They Are.md`, linked from the NEURO/SARA project MOCs). This is a thinking/writing task first, code second.
2. **Rebuild the NEURO app as a LIGHT-TOUCH app** that complements SARA. The new model: **NEURO = the brain** (data + intelligence + APIs), **SARA = the interface** to that brain. The current heavy NEURO React PWA gets slimmed to a light-touch companion; SARA becomes the rich interface.

Start by reading the Session Start Ritual files (below), then talk through Task 1 with Nick BEFORE writing definitions — don't assume the framing.

## Starting hypothesis for Task 1 (refine WITH Nick, don't impose)
- **NEURO** ("Nick's Executive Utility & Reasoning Orchestrator") = the **brain**. Backend/service layer: aggregates Jira queue, Obsidian vault, Microsoft 365, Strava, location, AI (Claude + Ollama). Owns data, reasoning, integrations, the vault, and the APIs. Increasingly headless — a service other things consume.
- **SARA** = the **interface / ambient surface** (the face of the brain). Already runs as kiosk/desktop views on the Pi (Mission Control, Executive Dashboard, Presence, Focus, Stream Deck, Companion), presence-aware (HA telemetry) + context-inferring (WS5). Reads NEURO's API. Going cross-platform via Electron on Windows. **Confirm the SARA acronym/definition with Nick — it isn't pinned down in the repo.**
- **Relationship:** NEURO is the brain; SARA is how you see/talk to it. The NEURO PWA becomes light-touch (mobile capture / quick glance / chat), not a full dashboard — because SARA is the dashboard now.

## Current state (what's live — background for the rebuild)
- **NEURO backend** (`backend/`, the brain): Express 4 CommonJS on Pi 5 (`/mnt/data/nuero`, PM2 `neuro-backend`, port 3001). ~45 services, ~40 routes. sql.js in-memory DB. Auth: PIN (`X-NEURO-PIN`) + vault key (`X-Api-Key` for `/api/vault/*`) + `X-NEURO-API-TOKEN` for machine clients. This is the "brain" — KEEP it; the rebuild is the FRONTEND.
- **NEURO app** (`frontend/`, React 19 + Vite + per-component CSS): the heavy PWA to be rebuilt light-touch. ~35 view components. This is the target of Task 2.
- **NEURO worker** (`worker/`): stateless Pi-4 Ollama tasks.
- **NEURO MCP server** (`mcp-server/`): 9 tools inc. the vault-hygiene suite.
- **SARA** (`sara/` in the same repo): runtime at `/mnt/data/nuero/sara`, port 3005, PM2 `sara-backend`. Backend serves its built frontend. Kiosk on Pi 4 DSI → pi5:3005. Memories: `sara-cross-platform-electron`, `sara-frontend-node-pidev`, `sara-pi-display-touch`. SARA→NEURO bridge needs `NEURO_BASE_URL=http://100.100.28.58:3001` + PIN + `NEURO_VAULT_KEY` (see `pi5-deployment` memory — the default host serves the SPA and 404s the API).
- **Vault** is healthy + self-maintaining (see below). Windows canonical, Pi replica, Syncthing.

## DONE last session (self-maintaining vault-hygiene — background, don't redo)
Built the Vault Hygiene Engine (`services/vault-hygiene.js` + route + 9 MCP tools), recovered 153 PLAUD recordings, deduped People/Team, cleaned graph to 0 orphans, then automated it all so the vault self-maintains:
- Premature-stub gate + auto-link meetings on import + reports self-stamp `[[Logs]]` + nightly 2:30am sweep (dedup/orphan-collect/archive). All deployed + committed (origin/main up to the graph-prettify work).
- Graph now nebula-styled (`.obsidian/graph.json` + `snippets/graph-space.css`). Hubs: `MOCs/Logs.md`, `MOCs/Orphan.md` (holds "Speaker N" recordings awaiting Nick to name — the only recurring manual task).
- KEY LESSON: external graph reconstruction was repeatedly WRONG (missed .canvas/.base, code-block links, own-report phantom links, basename collisions). Nick's visual spot-checks were ground truth. Trust his eyes over a rebuilt graph.

## Task 2 considerations (the light-touch rebuild)
- **Keep the brain, rebuild the face.** Don't touch the backend brain except to expose what the light app + SARA need.
- Decide with Nick: what is the light-touch NEURO app FOR that SARA isn't? Likely: mobile-first quick capture, on-the-go chat to the brain, glanceable focus/queue — the things you want in your pocket vs. SARA's ambient/desktop surface.
- Avoid duplicating SARA. Define the split (NEURO app = pocket/capture, SARA = ambient/command-centre) before building.
- Respect repo rules: backend CommonJS (no ESM), per-component CSS (no Tailwind), don't rename the `nuero` repo (historical typo).

## Session Start Ritual (from CLAUDE.md — do first)
1. Read `.claude/memory/handoff.md` (this file) 2. `mistakes.md` 3. `patterns.md`. Repo `Wardy-uk/nuero`. Pi 5 = `nickw@100.100.28.58`. Deploy = commit+push, then `git pull --ff-only` on Pi + `pm2 restart neuro-backend --update-env` (PATH export needed — see `pi5-deployment` memory).

---
## Carried over (SARA / Pi estate — still pending, low priority)
- Delete once happy: pi5 old `/home/nickw/tally` + DB; local `C:\tmp\tally-deploy`. Ollama perf recheck on pi5. Pi 3 utility node (not started).
- `Archive/Pending Transcription/` holds 7 untranscribed 07-01 recordings — they re-create when Nick transcribes them in PLAUD.
