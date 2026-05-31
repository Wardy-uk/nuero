# Build Status — WS3-WP1: Home Assistant Telemetry Bridge v0

**Status: READY FOR EVALUATION.**

## Scope

Connect a bounded set of Home Assistant telemetry signals into SARA's one shared
state model through the existing State Engine / provider seam. This is a **telemetry
and provider slice, not a screen slice**: Home Assistant acts as a telemetry **bus**,
the WS1 State Engine remains the sole producer of the shared model, and no new screens
or automatic view selection were added. All work is in `sara/backend/`.

## What was added or changed

```
sara/backend/src/telemetry/
  homeAssistant.js   NEW  the telemetry bridge: env config, bounded HA REST reads,
                          pure normalisation, cached snapshot, honest unavailability,
                          background polling lifecycle (start/stop). HA-bus only — it
                          decides nothing and owns no shared state.
sara/backend/src/state/
  contract.js        EXTENDED  validate() now enforces the situational `telemetry`
                          block shape (source string + available boolean + signals
                          object), so state and health can never disagree about live
                          vs unavailable telemetry. Signals may be null (honest "no
                          live signal"); existing contract rules are unchanged.
  stateEngine.js     EXTENDED  buildModel() reads the cached HA snapshot synchronously
                          and folds it in: `location` flips to HA when a live location
                          signal exists (source 'home-assistant'), else falls back to
                          the seed reader (source 'seed'); a new `telemetry` block
                          exposes the signals + availability + freshness (ageMs).
                          getHealth() carries the same telemetry verdict + locationSource.
                          RUNTIME_LABEL -> 'WS3-WP1'.
sara/backend/src/routes/
  telemetry.js       NEW  GET /api/telemetry — operator/evidence surface returning the
                          raw bridge snapshot (read-only).
sara/backend/
  server.js          EXTENDED  wires /api/telemetry and calls ha.start() after listen
                          (no-op + log when HA is not configured).
  .env.example       EXTENDED  documents the HA config (base URL, token, the three
                          bounded entity slots, poll/timeout) — all optional.
sara/backend/test/
  homeAssistant.test.js  NEW  6 bridge tests (honest unavailability + pure mapping).
  stateEngine.test.js    EXTENDED  +4 engine tests (telemetry block, seed fallback,
                          live-injection feeds the model, contract rejects no telemetry).
```

No new dependencies. CommonJS throughout (NEURO backend convention). Native `fetch` +
`AbortSignal.timeout` only. **No frontend files were changed**, and the WS1
`state-engine-v1` contract identity / `schemaVersion: 1` are unchanged — the telemetry
block is an additive, validated extension of the same shared model.

## How it works (the seam, preserved)

- **Configuration & connection path** — `homeAssistant.js` reads `SARA_HA_BASE_URL`,
  `SARA_HA_TOKEN`, and three bounded entity ids (`SARA_HA_LOCATION_ENTITY`,
  `SARA_HA_PRESENCE_ENTITY`, `SARA_HA_ENV_ENTITY`) from env. It polls each entity via
  HA's REST API (`GET /api/states/<entity_id>`) on an interval (`unref`'d, default 30s).
- **Bounded telemetry ingestion** — exactly three signal slots (spec scope): current
  location/zone, a simple presence/activity signal, and one environment signal to prove
  the seam. Nothing is auto-discovered.
- **Provider / State Engine seam** — the bridge caches a snapshot; the engine reads it
  **synchronously** via `getTelemetry()`. A slow or unreachable HA never blocks model
  assembly. HA telemetry feeds the shared model in two honest ways: it drives
  `location` when a live location signal exists, and it populates the `telemetry` block;
  domains stay seeded (this slice does not integrate domain data).
- **Honest fallback** — if HA is not configured, not yet polled, or unreachable,
  `getTelemetry()` returns `{ available: false, reason }` (`not-configured` /
  `awaiting-first-poll` / `unreachable` / `no-signals` / `partial`). Location falls back
  to the seed reader; `/api/state` and `/api/health` both report telemetry unavailable.
  Nothing throws into the engine, so existing screens keep working.

## Verification performed (this session, Windows dev machine)

Gathered by building and running the system, not from inherited claims.

- **Tests:** `npm test` (`node --test`) in `backend/` — **17/17 pass** (7 prior + 6 new
  bridge + 4 new engine telemetry tests; the original WS1 suite still passes unchanged).
- **Fallback path, live backend** (`node server.js`, port 3199, HA **not** configured):
  - Boot log: `[SARA HA] telemetry bridge idle — not configured. Screens use fallback`.
  - `GET /api/health` → `runtime:"WS3-WP1"`, `valid:true`, `locationSource:"seed"`,
    `telemetry:{available:false, reason:"not-configured"}`.
  - `GET /api/state` → `location.source:"seed"` (honest fallback, `telemetry:"fallback"`),
    `telemetry.available:false`, `meta.valid:true`.
  - `GET /api/telemetry` → `{source:"home-assistant", available:false, reason:"not-configured", signals:{location:null,presence:null,environment:null}}`.
- **Live ingestion path, end-to-end** (SARA on port 3200 pointed at a mock HA serving
  `person.nick=home`, `binary_sensor.occ=on`, `sensor.temp=21.4°C`, 1s poll):
  - `GET /api/state` → `location.source:"home-assistant"`, `label:"Home"`,
    `telemetry.available:true`, all three signals populated, `ageMs` computed,
    `meta.valid:true`.
  - `GET /api/health` → `locationSource:"home-assistant"`, `telemetry.available:true` —
    health agrees with state about liveness (no split-brain).
- **Frontend build:** `npm run build` (Vite 5.4.21) — **49 modules transformed**, `dist/`
  emitted clean (~0.88s), no errors. (Frontend unchanged; existing screens consume the
  same `/api/state` payload, which stays contract-valid in both HA states.)

## Convergence-criteria compliance

1. **HA telemetry is ingested through the runtime** — proven end-to-end against a live
   (mock) HA over REST; three bounded signals ingested and exposed. ✓
2. **The shared state model reflects that telemetry** — `location` flips to the HA source
   when live and the `telemetry` block carries the signals, both inside the one
   `buildModel()` output; contract-valid. ✓
3. **Telemetry absence or failure is surfaced honestly** — `available:false` + a
   machine-readable `reason` for every unavailable case; verified on the not-configured
   path and unit-tested for unreachable/partial/no-signals. ✓
4. **Existing screens remain functional** — frontend untouched and builds clean; the
   engine never blocks or throws on absent HA; location/`/api/state` stay contract-valid
   with HA off, so every screen reads exactly what it did at WS2A. ✓

## Constraint compliance

- **HA as telemetry bus, not decision engine** — the bridge only reads/normalises/caches;
  the State Engine remains the sole producer; presence/environment are surfaced, not used
  to drive briefing, confidence, or view selection. ✓
- **One shared state model** — telemetry folds into the single `buildModel()` output;
  `/api/health`, `/api/state`, `/api/telemetry` all derive from it. ✓
- **No new screens / no automatic view selection** — none added; no frontend changes. ✓
- **Existing screens work if HA unavailable** — verified (fallback path + clean build). ✓
- **No expansion into voice / distributed nodes / broad inference** — none added. ✓
- **Evaluator holdouts not consumed** — no eval_output/holdout artefacts read or written.

## Known limitations (inside WS3-WP1 scope)

- Domain inputs remain seeded — this slice integrates telemetry only, flagged honestly
  via root `dataSource:"seed"` (location/telemetry carry their own live source).
- HA auth is a long-lived token in env; the SARA backend itself still has no PIN/token
  middleware (reachable only over the private Tailscale network, unchanged from WS1).
- Live ingestion was proven against a local mock HA, not the production HA instance
  (no production HA credentials in this dev environment); the bridge is fully wired and
  the path is exercised end-to-end.

**This work package is ready for evaluation.**
