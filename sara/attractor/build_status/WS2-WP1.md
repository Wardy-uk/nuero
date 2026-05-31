# Build Status — WS2-WP1: Mission Control v0 & view-system foundation

**Status: READY FOR EVALUATION.**

## Scope

Build the first usable SARA screen — **Mission Control v0** — on top of a
**many-views UI architecture** over the existing WS1 shared State Engine contract.
Only Mission Control is built; the other views are reserved as placeholders. The
WS1 backend contract (`/api/state`, `/api/health`, `state-engine-v1`) is **unchanged**
— all WS2 work is in the frontend plus the Pi desktop launcher path.

## What was added or changed

All changes are inside `sara/`. The backend (`server.js`, `src/state/*`,
`src/routes/*`) and the WS1 contract were **not touched**.

```
sara/frontend/
  index.html                      theme-color #0d0f14 -> #f4f7f8 (light UI)
  src/App.jsx                     REWRITTEN  thin shell: provider + switcher + router
  src/App.css                     REWRITTEN  calm light theme tokens + shell/switcher/planned
  src/state/                      NEW  the shared UI state/context layer
    saraState.jsx                 SaraStateProvider + useSaraState() — reads /api/state,
                                  holds a shared live clock and the current-view selection
    views.js                      SaraView registry + DEFAULT_VIEW (the "view type")
    presentation.js               placeholder UI-only content (What Matters Now / Up Next /
                                  Quick Actions), source:'placeholder', housed in shared state
  src/components/                 NEW
    ViewRouter.jsx                maps currentView -> screen (only Mission Control wired)
    ViewSwitcher.jsx              manual view selector (charter: user-selected view)
    PlannedView.jsx               calm placeholder for declared-but-unbuilt views
  src/screens/                    NEW  one folder per view
    mission-control/
      MissionControl.jsx          the first usable screen — reads only shared state
      MissionControl.css          calm/light/touch styling, teal #5ec1ca, ink #272c33
    executive-dashboard/README.md placeholder (planned view)
    presence/README.md            placeholder (planned view)
    focus/README.md               placeholder (planned view)
    companion/README.md           placeholder (planned view)
    stream-deck/README.md         placeholder (planned view)
sara/scripts/start-sara.sh        NEW  Pi desktop display launcher (opens UI full-screen)
sara/desktop/SARA.desktop         NEW  XDG desktop entry (the clickable icon)
sara/desktop/sara.svg             NEW  launcher icon
sara/desktop/README.md            NEW  install + usage instructions
sara/README.md                    + "Mission Control & the view system (WS2 scope)" section,
                                  updated layout tree
```

No new dependencies were added (React context only). Frontend stack is unchanged
(React 18 + Vite, plain JS/JSX). The build brief's suggested `.tsx`/`.ts` structure
is **adapted to JS** to match the existing converged runtime — the project has no
TypeScript toolchain, and adding one would be scope expansion. The "view type
definition" is expressed as the plain-JS `SARA_VIEWS` / `VIEW_REGISTRY` in
`views.js`.

## Where shared UI state lives

- **Authoritative state:** the WS1 State Engine model, fetched from `/api/state`. The
  frontend does not re-derive or own current state, location, confidence, or the
  current goal — it reads them.
- **In-app shared layer:** `frontend/src/state/saraState.jsx` — a single
  `SaraStateProvider` (consumed via `useSaraState()`) that assembles the engine model
  + the placeholder presentation layer + a shared live clock + the current-view
  selection into one read-only value every screen consumes.
- **Placeholder UI-only fields:** `frontend/src/state/presentation.js` holds *What
  Matters Now / Up Next / Quick Actions* as static content stamped
  `source: 'placeholder'`. They live in shared state, **not** inside the screen — the
  same swappable seam as the backend's `seed.js`.

## How Mission Control consumes that shared state

`screens/mission-control/MissionControl.jsx` calls `useSaraState()` and renders only
from it. It owns no data — it formats and orders shared state into the screen:

| Mission Control element | Source (all via `useSaraState()`) |
|---|---|
| SARA header / current state | `model.sara.status` (+ `dataSource` seed pill) |
| Current time | shared live clock `now` (ticked in the provider, not the screen) |
| Current location | `model.location.label` |
| Confidence | `model.confidence.level` + `.score` |
| Current goal | `model.domains.focus.current` (title + reason) |
| What Matters Now | `presentation.missionControl.whatMattersNow` (placeholder) |
| Up Next | `presentation.missionControl.upNext` (placeholder) |
| Quick Actions | `presentation.missionControl.quickActions` (placeholder) |

## What future-view scaffolding exists

- `views.js` declares six views: `mission-control` (`available`) and
  `executive-dashboard`, `presence`, `focus`, `companion`, `stream-deck` (all
  `planned`).
- `ViewRouter` switches on `currentView`; `ViewSwitcher` sets it manually; planned
  views fall through to `PlannedView`. Verified at runtime: selecting a planned view
  unmounts Mission Control and mounts the placeholder; selecting Mission Control
  restores it (proof the app is **not** locked to one home screen).
- Each future view has a `screens/<id>/README.md` placeholder only — no screens built.
- Deliberately **not** built (out of scope): the other screens, automatic
  recommended-view logic, swipe navigation, plugin runtime.

## How the Pi desktop launcher works

- **`desktop/SARA.desktop`** — an XDG desktop entry (icon `desktop/sara.svg`) whose
  `Exec=` runs `scripts/start-sara.sh`. Assumes the Pi 5 deployment path
  `/mnt/data/nuero/sara`.
- **`scripts/start-sara.sh`** — the *display* launcher. It health-checks
  `/api/health`, nudges PM2 if the runtime is down (and waits up to ~10s), then opens
  the UI full-screen — Chromium `--kiosk --app`, falling back to `firefox --kiosk`
  then `xdg-open`. The runtime itself is still owned by PM2 (`runtime/start.sh` +
  `runtime/ecosystem.config.js`); the launcher only displays it.
- **`desktop/README.md`** — install/usage instructions (`chmod +x`, copy to
  `~/Desktop` and `~/.local/share/applications`, `SARA_URL` override, leaving kiosk
  mode). The `sara/README.md` "Launch on the Pi desktop" section links to it.

## Verification performed (this session, Windows dev machine, Node v25.6.1)

Gathered by building and running the system, not from inherited claims:

- **Frontend build:** `npm run build` (Vite 5.4.21) — **39 modules transformed**,
  `dist/` emitted clean (~0.84s), no errors.
- **Backend serving the build** (`node server.js`, port 3005 via the preview launcher):
  - `GET /api/health` -> `{"status":"ok","contract":"state-engine-v1","schemaVersion":1,"dataSource":"seed","valid":true,"location":"Office — Wilmslow","confidence":{"level":"moderate","score":0.6}}`.
  - `GET /api/state` -> contract valid, `dataSource:"seed"`, focus goal "Prep Willem's
    probation review".
  - `GET /` -> `200 text/html`; SPA fallback `GET /mission-control` -> `200 text/html`;
    `/api` namespace does not leak the SPA.
- **Rendered UI** (accessibility snapshot of the running page): all nine required
  Mission Control elements present and populated from shared state — SARA header +
  `ONLINE` state + `SEED DATA` pill, live clock `09:34` / `Sunday 31 May`, location
  `Office — Wilmslow`, confidence `Moderate · 0.6`, current goal + reason, What
  Matters Now (3 items), Up Next (3 items), Quick Actions (4 buttons). View switcher
  shows all six views with planned ones marked `SOON`. **No console warnings or errors.**
- **Current-view architecture (runtime):** clicking `Stream Deck` unmounts
  Mission Control and mounts `PlannedView` ("Planned view" / "Stream Deck"); clicking
  `Mission Control` restores it.
- **Touchscreen/responsive (viewport 375px):** What Matters Now / Up Next collapse to
  one column, Quick Actions to a 2-up grid, quick-action tap targets measure 84px tall
  (above the 44px touch minimum).

> Note: `preview_screenshot` timed out (the 1s shared clock interval keeps the
> renderer from reaching the idle state that tool waits for). Verification used the
> accessibility snapshot + computed-style/DOM assertions instead, which confirm
> structure, content, view-switching, and responsive layout directly.

## Protected-principle compliance

- **One state, many views (principle 7):** every screen reads the one shared
  `useSaraState()` value; the view system (`views.js` + `ViewRouter` + `ViewSwitcher`)
  makes views interchangeable representations of that state.
- **No screen owns data:** Mission Control reads only from shared state; even the
  current time comes from the shared provider, not a screen-local timer. Placeholder
  UI fields live in `presentation.js`, not the screen.
- **Not hardcoded to one home screen:** six declared views with a working manual
  switch, verified by unmounting/remounting Mission Control at runtime.
- **Honest placeholders:** the new UI-only fields are stamped `source:'placeholder'`
  and the seed-data pill is shown, consistent with WS1's honesty about seeded inputs.
- **No scope leak:** backend/contract untouched; no Home Assistant, voice, automatic
  view recommendation, swipe navigation, or plugin runtime; no WS3+ work.

**This work package is ready for evaluation.**
