# Build Status — WS2A-WP1: Executive Dashboard v0 & Presence Mode v0

**Status: READY FOR EVALUATION.**

## Scope

Add the next two real SARA views — **Executive Dashboard v0** and **Presence Mode
v0** — on top of the converged WS2 many-views architecture, as interchangeable
representations of the one shared state model. No new authoritative data, no WS3 / Home
Assistant telemetry, no change to the WS1 state contract. All work is in
`sara/frontend/src/`.

## What was added or changed

All changes are inside `sara/frontend/src/`. The backend (`server.js`,
`src/state/*`, `src/routes/*`) and the WS1 `state-engine-v1` contract were **not
touched** — both new views read the existing `/api/state` payload only.

```
sara/frontend/src/
  state/
    presentation.js          GENERALISED  MISSION_CONTROL_PRESENTATION -> SHARED_PRESENTATION;
                             same three placeholder fields (What Matters Now / Up Next /
                             Quick Actions), now framed as the one view-neutral shared
                             placeholder layer every view reads. source:'placeholder' kept.
    saraState.jsx            exposes `presentation: SHARED_PRESENTATION` (flattened from the
                             old `{ missionControl: ... }` namespace). No new state, no new
                             fetch, no contract change.
    views.js                 executive-dashboard + presence flipped 'planned' -> 'available';
                             header comment updated. Focus / Companion / Stream Deck stay
                             'planned'.
  components/
    ViewRouter.jsx           + cases for EXECUTIVE_DASHBOARD and PRESENCE; everything else
                             still falls through to PlannedView.
  screens/
    mission-control/
      MissionControl.jsx     one line: `presentation.missionControl` -> `presentation`
                             (consumes the generalised shared layer). Otherwise unchanged.
    executive-dashboard/
      ExecutiveDashboard.jsx NEW  operational view — pure representation of shared state
      ExecutiveDashboard.css NEW  denser grid, shared App.css theme tokens
      README.md              updated: planned -> available (built in WS2A-WP1)
    presence/
      PresenceMode.jsx       NEW  calm ambient view — pure representation of shared state
      PresenceMode.css       NEW  large/low-clutter, shared App.css theme tokens
      README.md              updated: planned -> available (built in WS2A-WP1)
```

No new dependencies. Frontend stack unchanged (React 18 + Vite, plain JS/JSX). No
TypeScript introduced (the converged runtime has none).

## How both new views consume shared state (they own no data)

Both screens call `useSaraState()` and render only from it — the WS1 engine model, the
shared placeholder presentation, and the shared live clock. Neither re-derives, caches,
or duplicates state.

**Executive Dashboard** — the same state, expanded into operational depth:

| Element | Source (all via `useSaraState()`) |
|---|---|
| Header state / seed pill | `model.sara.status`, `model.dataSource` |
| Clock | shared `now` (provider-ticked, not screen-owned) |
| Confidence | `model.confidence.level` / `.score` |
| Briefing line | `model.briefing.line` (engine-derived, read verbatim) |
| KPI: Open tickets | `model.domains.queue.open` |
| KPI: Breaching SLA | `model.domains.queue.breaching` |
| KPI: People to watch | derived count over `model.domains.people.members` (display-only) |
| KPI: Notes to surface | `model.domains.vault.picks.length` |
| Queue (Act now / Today / Watch) | `model.domains.queue.sections.*` (key, summary, assignee, SLA, take) |
| People roster | `model.domains.people.members` (role, QA metric, status, flag) |
| What Matters Now | `presentation.whatMattersNow` (shared placeholder layer) |
| Current focus footer | `model.domains.focus.current` |

**Presence Mode** — the same state, subtracted to its calmest form:

| Element | Source (all via `useSaraState()`) |
|---|---|
| Large clock + date | shared `now` |
| Location | `model.location.label` |
| SARA status | `model.sara.status` |
| The one line | `model.briefing.line` |
| "Now" | `model.domains.focus.current.title` |
| "Next" | `presentation.upNext[0]` (shared placeholder layer) |

The "People to watch" KPI is a display-only count over the shared `members` array — it
adds no field to the model and is not persisted anywhere; the same pattern Mission
Control already uses to tone its items.

## Verification performed (this session, Windows dev machine)

Gathered by building and running the system, not from inherited claims.

- **Frontend build:** `npm run build` (Vite 5.4.21) — **43 modules transformed** (was
  39 at WS2; +4 for the two new screens' JSX+CSS), `dist/` emitted clean (~0.93s), no
  errors.
- **Backend serving the build** (`node server.js`, port 3005 via the preview launcher):
  - `GET /api/health` → `{"status":"ok","contract":"state-engine-v1","schemaVersion":1,"dataSource":"seed","valid":true,...}`.
  - `GET /api/state` → contract valid, `dataSource:"seed"`, briefing line derived from
    the queue/people/focus domains.
- **Mission Control still works:** loads as the default view and renders all nine
  elements from shared state (SARA / ONLINE / SEED DATA, clock, location, confidence,
  current goal, What Matters Now ×3, Up Next ×3, Quick Actions ×4) — unchanged by the
  presentation-layer generalisation.
- **Executive Dashboard renders** (accessibility snapshot of the running page): header
  with view tag + confidence, engine briefing line, four KPI tiles (Open 4 / Breaching 2
  / People to watch 2 / Notes 2), the full queue broken into **Act now (2) / Today (1) /
  Watch (1)** with per-ticket key, summary, assignee, human SLA (2h / 45m / 10h / 3d) and
  take, the four-person roster with role / QA metric / status / flag, and What Matters
  Now from the shared layer.
- **Presence Mode renders** (DOM assertions on the running page): large clock `10:36`,
  location `Office — Wilmslow`, the engine briefing line, "Now" = `Prep Willem's
  probation review`, "Next · 11:00" = `Stand-up with the support team` (from the shared
  Up Next placeholder).
- **Current-view system (runtime):** the switcher lists all six views; Executive
  Dashboard and Presence now appear **without** the `SOON` tag (Focus / Companion /
  Stream Deck keep it). Selecting Executive Dashboard mounts `.ed` and unmounts Mission
  Control; selecting Presence mounts `.presence`; selecting Mission Control restores
  `.mc` and unmounts Presence — verified the round-trip in both directions, proving the
  app is **not** locked to a single home screen.
- **Console:** no warnings or errors across all three views.

> Note (carried from WS2-WP1, same cause): `preview_screenshot` times out — the 1-second
> shared clock interval keeps the renderer from reaching the idle state that tool waits
> for. Verification used the accessibility snapshot + DOM/computed assertions on the
> running page instead, which confirm structure, content and view-switching directly.

## Convergence-criteria compliance

1. **Executive Dashboard renders** — verified at runtime. ✓
2. **Presence Mode renders** — verified at runtime. ✓
3. **Both selectable through the current-view system** — both wired in `ViewRouter`,
   selectable via `ViewSwitcher`, marked `available` in the registry; round-trip
   switching verified. ✓
4. **Both read shared state, owning no authoritative state** — both are pure
   `useSaraState()` consumers; the only "new" UI fields are the shared placeholder
   presentation, housed in `state/presentation.js`, read identically by all three
   screens. No screen-local data, no second source of truth. ✓
5. **Mission Control still works** — verified unchanged at runtime. ✓

## Failure-condition compliance

- **Neither new screen fails to render** — both verified rendering populated. ✓
- **View switching not broken** — three real screens switch cleanly in all directions. ✓
- **State not duplicated into screens** — placeholder content stays in the shared layer;
  screens format/order only. ✓
- **No quiet WS3 dependency** — every value comes from the existing WS1 `/api/state`
  contract; no Home Assistant / telemetry field is read or assumed. The seed pill is
  shown, consistent with WS1's honesty about seeded inputs. ✓

## Out of scope (deliberately not built)

Home Assistant / WS3 telemetry, changes to the WS1 state contract for new live data,
automatic recommended-view logic, voice, swipe navigation, distributed nodes, and the
remaining planned views (Focus / Companion / Stream Deck — still `planned`
placeholders).

**This work package is ready for evaluation.**
