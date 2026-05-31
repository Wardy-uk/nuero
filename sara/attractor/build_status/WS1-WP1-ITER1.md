# Build Status — WS1-WP1-ITER1: location + confidence on the State Engine v1 contract

**Status: READY FOR EVALUATION.**

## Why this iteration exists

The WS1-WP1 evaluation (`attractor/eval_output/ws1_wp1_eval_2026-05-31.md`) returned
`iterate`. The slice was real, honest, and degraded well under fault — it failed on
**one** criterion only:

> **Criterion 2** — *current state, current location, **and** confidence all exposed
> consistently.* State was exposed consistently across backend and frontend, but
> **location and confidence were absent everywhere** (`/api/state`, `/api/health`,
> and the UI).

This iteration closes **exactly** that gap. Nothing else in the slice was changed.

## Artefact note (process finding, carried forward)

The two artefacts named in the build instruction —
`attractor/spec/ws1_iteration1_build_brief.md` and
`attractor/spec/ws1_iteration1_convergence_definition.md` — **do not exist on disk**
(there is no `attractor/spec/` directory). The manager handoff
(`attractor/manager_log/ws1_eval_handoff_2026-05-31.md`) the WS1 eval flagged as
missing is **still absent**. The only governing artefact present is the WS1-WP1 eval
report, which defines the gap precisely. This iteration was therefore scoped against
the eval report's literal wording of criterion 2. The location/confidence-vs-deferral
decision the eval asked the manager to record was resolved here by **adding** both
fields (the eval's first option), not by recording a deferral.

## Scope (what changed, and the line not crossed)

Close the missing **location** and **confidence** signal so SARA's situational state
(state + location + confidence) is exposed consistently on both runtime surfaces and
in the UI. All changes are inside `sara/`. The `/api` runtime path, server boot, route
wiring, PM2 config, and `start.sh` are unchanged. No NEURO `backend/`/`frontend/`/
`worker/` code was touched. **No WS2 dashboard work** — the UI change is the minimum
to surface the two new fields next to the existing ones, not a new view.

```
sara/backend/src/state/
  contract.js     + validate() now enforces the SHAPE of model.location
                    (source + label strings) and model.confidence (numeric score +
                    level string). Additive — the existing checks are untouched, so
                    the invalid-model path is preserved.
  seed.js         + location() provider, stamped source:'seed'. Added to module
                    exports. It is the swappable layer (same seam as the domain
                    providers): a later WP swaps it for a live reader (OwnTracks /
                    calendar) without touching the engine or the contract.
  stateEngine.js  + location attached from the seed provider.
                  + confidence DERIVED by the engine (not seeded): deriveConfidence()
                    reads domain conformance + dataSource → `moderate` (0.6) while
                    inputs are seeded, `low` (0.3) when a domain is not contract-shaped,
                    `high` (0.9) once inputs are live. getHealth() now also carries
                    location (label) and confidence (level/score).
sara/backend/test/
  stateEngine.test.js  + 2 tests: state exposes location (seed) + confidence (derived,
                    moderate); health carries both consistently. (now 7 tests.)
sara/frontend/src/App.jsx   + location and confidence rows in the runtime metadata,
                    read from the same /api/state payload.
sara/frontend/src/App.css   + .sara__confidence--high/moderate/low colour cues.
sara/README.md              State Engine v1 section notes location + confidence.
```

## What "location" and "confidence" mean here

- **Location** — SARA's current situational location. A **seeded** input in WS1
  (`source:'seed'`, `label:'Office — Wilmslow'`, plus `context`/`since`/`summary`),
  honestly flagged like every other seed input. It sits in the swappable layer so WS2+
  can wire a live reader without changing the engine or contract.
- **Confidence** — how much the engine trusts the assembled model. **Derived**, not
  seeded (`source:'derived'`), from two honest signals: whether every domain is
  contract-shaped, and whether inputs are live or seeded. This deliberately ties
  confidence to the *same* condition the existing health/validation path keys on — a
  malformed domain drops confidence to `low` in step with `/api/health` going
  `degraded` — so confidence cannot contradict the validity signal.

## Verification performed (this session, Windows dev machine, Node v25.6.1)

All gathered by running the system.

- **Contract tests:** `npm test` (`node --test`) in `backend/` — **7/7 pass**
  (5 original + 2 new for location/confidence on state and health).
- **Live backend** (`node server.js`):
  - `GET /api/state` → `location` (`source:'seed'`, `label:'Office — Wilmslow'`) and
    `confidence` (`source:'derived'`, `level:'moderate'`, `score:0.6`) both present;
    `meta.valid:true`, 0 errors.
  - `GET /api/health` → carries `location:"Office — Wilmslow"` and
    `confidence:{level:"moderate",score:0.6}` alongside the existing fields —
    **same values as `/api/state`** (no backend↔health drift).
- **Invalid-model behaviour preserved (criterion 5) + extended honestly:**
  fault-injected an invalid `queue` domain via the seed seam (then reverted):
  - `/api/health` → `status:"degraded"`, `valid:false`.
  - `/api/state` → `meta.valid:false`, precise error `domains.queue.open is missing`.
  - `confidence` correctly degraded to `low` (`0.3`) on **both** surfaces, with the
    honest rationale *"Model is degraded — queue domain is not contract-shaped."*
    Confidence and health agree under fault; no crash; nothing fabricated.
- **Frontend build:** `npm run build` — Vite, 31 modules transformed, `dist/`
  re-emitted clean; old asset hashes removed.
- **Production single-process path** (`SARA_PORT` set, serving built `dist/`):
  `GET /` → `200 text/html`; `index.html` references the rebuilt bundle; the
  confidence-level styling is present in the emitted JS (the new fields are rendered,
  not just present in the API).

## Constraint compliance

- **Closed only the location/confidence gap.** Criteria 1, 3, 4, 5 behaviour is
  unchanged; the briefing, seed honesty, and contract identity are as evaluated.
- **Governed runtime seam preserved.** Location was added as a seed provider on the
  same swappable layer as the domains; the engine↔contract boundary and the `/api`
  path are untouched. WS2 can land live providers without touching the engine.
- **Honest invalid-model behaviour preserved.** The `validate()` additions are
  shape-only and additive; the degraded path still surfaces precise errors and does
  not crash — and confidence now degrades in lockstep with it.
- **No WS2 dashboard work.** The frontend change is two metadata rows on the existing
  surface, not a new view.

## Readiness declaration

Location and confidence are now exposed **consistently on backend (`/api/state` and
`/api/health`) and frontend** in this governed workspace, with confidence derived and
honest under both healthy and degraded conditions. The sole basis for the prior
`iterate` verdict (criterion 2) is closed.

**This work package iteration is ready for evaluation.**
