# SARA Runtime

Systematic Action & Response Agent — the directive/interaction layer of NEURO.

This directory is the **SARA runtime foundation** delivered by work package
`WS0-WP1`. It is a small, honest slice: enough to boot on the Pi 5, start a
frontend and backend, and prove the two talk to each other. It is **not** the
feature set — no intelligence, no Jira/vault/voice yet. Those arrive in later
work packages.

## Layout

```
sara/
  backend/                 Express (CommonJS) runtime backend
    server.js              boot, /api routes, serves built frontend in prod
    src/state/             the single shared State Engine (v1 contract — WS1)
      contract.js          state-engine-v1 contract + validate()
      seed.js              hardcoded domain inputs (the swappable layer)
      stateEngine.js       the engine: assemble -> derive briefing -> validate
    src/routes/            /api/health, /api/state
    test/                  node --test contract smoke tests
  frontend/                React + Vite connectivity-proof UI
    src/App.jsx            reads /api/state, reports runtime health
  runtime/
    ecosystem.config.js    PM2 process definition (boot persistence)
    start.sh               one-command bring-up on the Pi
  attractor/
    build_status/          factual per-work-package build reports
```

## The runtime path

Frontend and backend talk over **`/api`**:

- `GET /api/health` — liveness (used by PM2/operators)
- `GET /api/state` — the single shared state model

In **dev**, Vite serves the frontend on port 5174 and proxies `/api` to the
backend (default port 3005). In **production**, `vite build` emits
`frontend/dist`, which the backend serves directly — so the whole runtime is a
single process on one port.

## Run it locally (dev)

```bash
cd sara
npm run install:all
# terminal 1
npm run dev:backend       # http://localhost:3005
# terminal 2
npm run dev:frontend      # http://localhost:5174  (proxies /api -> 3005)
```

Open http://localhost:5174 — the header dot goes green when the frontend has
read state from the backend.

## Run it on the Pi 5 (auto-start on boot)

The Pi 5 already runs PM2 under systemd (`pm2-nickw.service`). Registering SARA
with PM2 and saving makes it start automatically after a reboot — no manual app
launch.

```bash
cd /mnt/data/nuero/sara
bash runtime/start.sh        # installs deps, builds frontend, starts under PM2, pm2 save
```

Then:

```bash
curl http://localhost:3005/api/health      # {"status":"ok",...}
```

Open `http://100.100.28.58:3005/` (or `http://pi5.tailecb90f.ts.net:3005/`)
over Tailscale to see the runtime UI.

`runtime/start.sh` is safe to re-run after a `git pull`: it reinstalls, rebuilds,
and restarts the PM2 process.

## Configuration

`backend/.env.example` documents the (currently only) setting:

- `SARA_PORT` — backend port, default **3005** (kept off NEURO's 3001).

## State Engine v1 (WS1 scope)

The State Engine now exposes a **real, enforced contract** (`state-engine-v1`,
`schemaVersion: 1`) over the same `/api` path. The engine assembles the one shared
model from per-domain inputs (`queue`, `focus`, `people`, `vault`), derives SARA's
briefing line from that model, and self-validates against the contract — `/api/health`
reports `degraded` if the model ever fails its own contract.

Inputs are **seeded (hardcoded)** in WS1 — flagged `dataSource: 'seed'` at the root
and `source: 'seed'` on every domain. `seed.js` is the swappable layer: a later work
package replaces each provider with a live reader (Jira, do-next, people notes, vault)
without changing the engine or the contract.

## Known limitations (WS1 scope)

- Domain inputs are hardcoded, not live. The shape and engine are real; the data is
  seed data, surfaced honestly as `dataSource: 'seed'`.
- No auth on the SARA backend yet (NEURO's PIN/token middleware is not ported).
  Only reachable over the private Tailscale network.
- Contract smoke tests only (`npm test` in `backend/`); no CI wired.
