# Pi Cleanup Handoff — 2026-06-19

## Goal

Clean up the Raspberry Pi estate so:

- `pi5` is the primary NUERO brain and stays as clean as possible
- `pi-dev` (Pi 4) carries frontend / worker / support services
- Pi 3 can be introduced later as a utility node

## Confirmed Hosts

### `pi5`

- Hostname: `pi5`
- Model: `Raspberry Pi 5 Model B Rev 1.1`
- Reachable via:
  - LAN: `192.168.1.17`
  - Tailscale: `100.100.28.58`

### `pi` alias

- The working SSH alias `pi` connects to:
  - Hostname: `pi-dev`
  - Model: `Raspberry Pi 4 Model B Rev 1.2`
  - Tailscale: `100.69.158.50`
  - LAN: `192.168.1.64`
  - Wi-Fi: `192.168.1.65`

Important:

- Use `ssh -o BatchMode=yes -o ConnectTimeout=8 pi '...'`
- Do not use `ssh pi-dev` from this machine
- `pi-dev` LAN alias/key auth was previously failing, while `pi` works

## SSH Notes

- This Windows machine has no SSH agent running
- Rely on the on-disk key: `~/.ssh/id_ed25519`
- `pi` works key-only over Tailscale
- `pi5` works

## Pi 4 Wi-Fi Status

This was fixed during this session.

Root cause:

- `/boot/firmware/config.txt` on `pi-dev` contained:
  - `dtoverlay=disable-wifi`

Action already taken:

- removed `dtoverlay=disable-wifi`
- rebooted `pi-dev`

Current result:

- `wlan0` exists and is up
- active Wi-Fi connection:
  - `netplan-wlan0-ward_home_primary_5G`

## What Is Running

### `pi5`

Confirmed services:

- `neuro-backend` via PM2 on `:3001`
- `sara-backend` via PM2 on `:3005`
- `tally` via PM2 on `:3003`
- Ollama on `:11434`
- Home Assistant on `:8123`
- Chromium kiosk / UI processes
- watch presence service

Observed heavy consumers on `pi5`:

- Chromium GPU process
- multiple Ollama runners
- `neuro-backend`

### `pi-dev` (Pi 4)

Confirmed services:

- `neuro-backend` via PM2 on `:3001`
- `neuro-worker` via PM2 on `:3002`
- Ollama on `:11434`
- OwnTracks recorder on `:8083`
- `n8n` running directly
- Docker / Portainer
- VS Code tunnel
- desktop shell components (`labwc`, `pcmanfm`, `wf-panel-pi`)

## Tally Placement

`Tally` is currently on `pi5`.

Confirmed:

- PM2 app: `tally`
- Port: `3003`
- Repo path: `/home/nickw/tally`

AI detail:

- `Tally` does **not** use Ollama
- It uses cloud OpenAI via the `openai` package
- Default model in code: `gpt-4o-mini`

Implication:

- `Tally` is safe to move off `pi5`
- It does not need to stay beside Ollama

## Recommended Target Layout

### `pi5` — core brain

Keep on `pi5`:

- primary `neuro-backend`
- Ollama
- Plaud sync
- vault processing
- knowledge-memory
- AI enrichment
- anything latency-sensitive or stateful

Move off `pi5`:

- `sara-backend`
- Chromium/kiosk UI
- `tally`
- optional non-core support services

### `pi-dev` (Pi 4) — face + services

Target role:

- SARA frontend / kiosk / browser UI
- `neuro-worker`
- `n8n`
- OwnTracks recorder
- Docker / Portainer
- `tally`

Decision needed:

- whether to keep the old `neuro-backend` on Pi 4 at all
- likely answer: no, if Pi 5 is canonical

### Pi 3 — utility node (later)

Good uses:

- monitors / heartbeat
- notifications
- backup cron jobs
- tiny relay services
- watchdog tasks

Do not use as:

- primary frontend
- Ollama host
- core backend

## Important Duplication To Resolve

There are two `neuro-backend` instances in the estate:

- `pi5` has a live `neuro-backend`
- `pi-dev` also has `neuro-backend`

This should be cleaned up deliberately.

Recommended direction:

- keep `pi5` as canonical backend
- demote/remove `neuro-backend` from `pi-dev`
- keep `neuro-worker` on `pi-dev`

## Suggested Cleanup Order

1. Confirm which backend is authoritative for live NUERO traffic
2. Stop duplicate `neuro-backend` on `pi-dev` if Pi 5 is canonical
3. Move `sara-backend` from `pi5` to `pi-dev`
4. Move `tally` from `pi5` to `pi-dev`
5. Remove kiosk / Chromium UI load from `pi5`
6. Re-check Ollama performance on `pi5`
7. Only after that, decide whether Pi 3 should take a helper role

## Useful Commands

### Pi 4

```bash
ssh -o BatchMode=yes -o ConnectTimeout=8 pi 'hostname && hostname -I'
ssh -o BatchMode=yes -o ConnectTimeout=8 pi 'bash -ic "pm2 list"'
ssh -o BatchMode=yes -o ConnectTimeout=8 pi 'nmcli dev status'
```

### Pi 5

```bash
ssh pi5 'hostname && hostname -I'
ssh pi5 'bash -ic "pm2 list"'
ssh pi5 'ss -tulpn | egrep "(:3001|:3003|:3005|:11434|:8123|:22)" || true'
```

## Non-Goals For This Handoff

This handoff is about Pi role cleanup only.

Do not mix in:

- Microsoft auth cleanup
- deeper knowledge-memory AI tuning
- Plaud sync logic changes

Those are separate tracks.
