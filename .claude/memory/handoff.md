# Session Handoff — 2026-06-19 19:15

Session was **Pi estate cleanup** + **SARA surface onto Pi 4** (not NEURO/SARA app code).

## SARA now runs on the Pi 4 touchscreen (NEW)
- **Surface/brain split**: `sara-backend` stays on pi5:3005 (coupled to HA/watch/neuro); Pi 4 runs a Chromium **kiosk** on its DSI screen pointed at **`http://100.100.28.58:3005/`** (pi5 tailnet IP — sidesteps pi-dev's broken MagicDNS that makes pi5's `:8443` unreachable).
- Launcher `sara/scripts/start-sara-frontend.sh` (deployed to pi-dev `~/sara-frontend/`); autostart via `~/.config/autostart/sara-kiosk.desktop` (`lwrespawn` keep-alive). **Verified survives reboot** — SARA up ~9s after desktop loads. Details: memory `sara-frontend-node-pidev`.
- `start-sara-frontend.sh` is NEW + uncommitted in the nuero repo (offered to commit).

## What was done (earlier — Pi estate cleanup)
- Confirmed **pi5 = canonical NEURO brain**. pi-dev's duplicate `neuro-backend` was a misconfigured zombie → **stopped + pm2 saved**.
- **Migrated tally off pi5 → pi-dev** (app + SQLite + receipts/backups). pm2 on pi-dev:3003, saved, autostarts. Public edge = pi-dev's **own** Tailscale Funnel `/tally`. Netlify (`tally-nickward`, siteId `4c29f4a7-…`) redeployed → points at pi-dev.
- **Fixed canonical netlify.toml** in `C:\Users\NickW\Claude\finance` (repo `Wardy-uk/tally`): pi5→pi-dev, commit `0228c1f`, pushed to main.
- **pi5 cleanup**: deleted dead `quest`; removed orphaned `/tally` Funnel mount; made pi5 **headless** (lightdm disabled, `multi-user.target`). pi5 pm2 now = neuro-backend + sara-backend only.
- Enabled **persistent journald on pi-dev** (`Storage=persistent`).

## What's still pending
- **Delete once happy**: pi5 old `/home/nickw/tally` + DB; local `C:\tmp\tally-deploy`.
- **Step 6** — re-check Ollama perf on pi5 (the real load; the "kiosk" never existed).
- **Pi 3 utility node** — "later", not started.
- Pre-existing SARA TODOs (from 06-12 session, untouched): PWA Phase 2 mobile-responsive layout; Focus Enforced port into SARA.

## Key decisions
- **Do NOT move sara-backend off pi5** — bolted to pi5-local HA (`:8123`), watch-irk BLE presence, NEURO (`:3001`). Cross-tailnet hops for an 83MB process = fragile. Correct where it is.
- Tally used **Full move (A)**, not the planned "Hybrid" — Tailscale Serve is localhost-only (see mistakes.md).

## Gotchas for next session
- **pi-dev's frequent reboots = Nick installing stuff**, NOT hardware. No PSU concern.
- **pi-dev owns the DSI SARA touchscreen** (`card1-DSI-1 connected`) — its desktop GUI is needed; do NOT headless it like pi5.
- pi-dev SSH: `ssh -o BatchMode=yes -o ConnectTimeout=12 pi`; pm2 needs `bash -ic` (node 22 via nvm). pi5: `ssh pi5`.
- Memory written: `tally-on-pi-dev`, `tailscale-serve-localhost-only`. mistakes.md: Serve-localhost-only; always `pm2 save` after start.
