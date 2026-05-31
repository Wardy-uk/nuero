# SARA Runtime

Systematic Action & Response Agent — the directive/interaction layer of NEURO.

This directory is the **SARA runtime foundation** delivered by work package
`WS0-WP1`. It is a small, honest slice: enough to boot on the Pi 5, start a
frontend and backend, and prove the two talk to each other. It is **not** the
full feature set — but it now includes the converged shared-state runtime, the
many-views UI foundation, Home Assistant telemetry, bounded inference, and a
text chat bridge back into the existing NEURO backend. Voice and the broader
NEURO screen set still arrive in later work packages.

## Layout

```
sara/
  backend/                 Express (CommonJS) runtime backend
    server.js              boot, /api routes, serves built frontend in prod
    src/state/             the single shared State Engine (v1 contract — WS1)
      contract.js          state-engine-v1 contract + validate()
      seed.js              hardcoded domain inputs (the swappable layer)
      stateEngine.js       the engine: assemble -> derive briefing -> validate
    src/routes/            /api/health, /api/state, /api/chat, /api/telemetry, /api/inference
    test/                  node --test contract smoke tests
  frontend/                React + Vite UI (one state, many views — WS2)
    src/App.jsx            app shell: shared-state provider + view switcher + router
    src/state/             shared UI state/context (the in-app source of truth)
      saraState.jsx        SaraStateProvider + useSaraState() — reads /api/state,
                          live clock, current-view selection
      views.js             SaraView registry + current-view default (the view "type")
      presentation.js      placeholder UI-only content (What Matters Now / Up Next /
                          Quick Actions), housed in shared state — NOT in the screen
    src/components/        ViewRouter, ViewSwitcher, PlannedView
    src/screens/           one folder per view; only Mission Control is built
      mission-control/     MissionControl.jsx + .css (the first usable screen)
      executive-dashboard/ presence/ focus/ companion/ stream-deck/  (placeholders)
  scripts/
    start-sara.sh          Pi desktop display launcher (opens the UI full-screen)
  desktop/
    SARA.desktop           desktop icon (XDG entry) + sara.svg + install README
  runtime/
    ecosystem.config.js    PM2 process definition (boot persistence)
    start.sh               one-command runtime bring-up on the Pi
  attractor/
    build_status/          factual per-work-package build reports
```

## The runtime path

Frontend and backend talk over **`/api`**:

- `GET /api/health` — liveness (used by PM2/operators)
- `GET /api/state` — the single shared state model
- `GET /api/chat` — honest NEURO chat-bridge availability
- `POST /api/chat` — pass a prompt through to the existing NEURO chat endpoint

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

SARA's situational state is exposed consistently on both surfaces (`/api/state` and
`/api/health`) and in the UI: **current state** (`sara.status`), **current location**
(`location` — seeded in WS1, the swappable layer, like the domains), and
**confidence** (`confidence` — *derived* by the engine from domain conformance and
data source: `moderate` while inputs are seeded, dropping to `low` when a domain
fails its contract, in step with degraded health).

Inputs are **seeded (hardcoded)** in WS1 — flagged `dataSource: 'seed'` at the root
and `source: 'seed'` on every domain. `seed.js` is the swappable layer: a later work
package replaces each provider with a live reader (Jira, do-next, people notes, vault)
without changing the engine or the contract.

## Mission Control & the view system (WS2 scope)

The frontend is now a **view-based UI over one shared state model** (charter
principle 7: *one state, many views*). The first usable screen — **Mission Control
v0** — renders the SARA header, current time, current state, location, confidence,
current goal, *What Matters Now*, *Up Next*, and *Quick Actions*.

- **Shared state, not screen state.** Every screen reads from
  `frontend/src/state/saraState.jsx` (`useSaraState()`). That context assembles the
  WS1 State Engine model (`/api/state` — current state / location / confidence /
  current goal) plus a placeholder presentation layer (`presentation.js`) for the
  new UI-only fields, plus a shared live clock. No screen owns data.
- **Current-view architecture.** `views.js` declares the `SaraView` registry and the
  current-view default; `ViewRouter` maps the current view to a screen; `ViewSwitcher`
  lets you select one manually. Mission Control is built; Executive Dashboard,
  Presence, Focus, Companion and Stream Deck are reserved as `planned` views (their
  `screens/<id>/` folders hold README placeholders only). The app is **not** hardcoded
  to a single home screen.
- **Honest placeholders.** *What Matters Now / Up Next / Quick Actions* are static
  placeholder content stamped `source: 'placeholder'`, living in shared state so a
  later work package can derive them from the engine without changing the screen.
- **Companion bridge.** The Companion view now sends text prompts through the backend's
  `/api/chat` bridge into the existing NEURO chat path when `NEURO_BASE_URL` and
  `NEURO_PIN` are configured. If that upstream is absent, the UI surfaces the gap
  plainly instead of faking a reply.

### Launch on the Pi desktop

Mission Control opens full-screen from a desktop icon. The runtime stays alive under
PM2 (`runtime/start.sh`); the desktop icon only *displays* the UI:

```bash
cd /mnt/data/nuero/sara
chmod +x scripts/start-sara.sh
cp desktop/SARA.desktop ~/Desktop/ && chmod +x ~/Desktop/SARA.desktop
```

Full install/usage notes: [`desktop/README.md`](desktop/README.md). Or launch from a
terminal: `bash scripts/start-sara.sh`.

## Known limitations (WS1 scope)

- Domain inputs are hardcoded, not live. The shape and engine are real; the data is
  seed data, surfaced honestly as `dataSource: 'seed'`.
- No auth on the SARA backend yet (NEURO's PIN/token middleware is not ported).
  Only reachable over the private Tailscale network.
- The Companion screen is text-chat only. Voice I/O, nudges streaming, and the broader
  NEURO screen set still need dedicated work.
- Contract smoke tests only (`npm test` in `backend/`); no CI wired.
