# Build Status — WS5-WP1: Context Inference v0

**Status: READY FOR EVALUATION.**

## Scope

Add the first bounded context-inference layer over the converged SARA state and the
Home Assistant telemetry seam. SARA can now answer two questions from the one shared
model: **"what does it think Nick is doing right now?"** (a bounded activity/context
state) and **"which view would it recommend?"** (advisory only). Both carry **confidence
and reasons**, and **missing or contradictory inputs are surfaced honestly**.

This is a **state-layer slice**. Inference extends the one shared model — it is not a
second state owner. The WS1 State Engine remains the sole producer of the model. Home
Assistant stays a telemetry **bus** — its signals are one input to the inference, never a
decision engine. The recommendation is **advisory only**: it never auto-switches the UI.

## What was added or changed

```
sara/backend/src/state/
  inference.js       NEW  the bounded inference: pure, deterministic derivation of a
                          fixed activity enum (firefighting / away / focused-task /
                          team-attention / steady / unknown), one recommended view id
                          (advisory), derived confidence, reasons, contradictions, and an
                          honest `inputs` map. No I/O, no clock, no mutation of inputs.
  contract.js        EXTENDED  validate() now enforces the `inference` block shape AND
                          its advisory guarantee: `advisory` MUST be exactly `true`,
                          `recommendedView` is null or a string, `confidence`+`reasons`
                          are required. So the shared model itself contractually promises
                          a recommendation can never be exposed without its uncertainty,
                          and can never claim to be anything but advisory.
  stateEngine.js     EXTENDED  buildModel() folds inference in AFTER the rest of the model
                          is assembled, from the SAME inputs the model already carries
                          (domains, telemetry, location) — so inference extends the one
                          model rather than owning a parallel one. getHealth() echoes the
                          inference verdict (activity, recommendedView, advisory,
                          confidence) so state and health can't disagree. RUNTIME_LABEL
                          -> 'WS5-WP1'.
sara/backend/src/routes/
  inference.js       NEW  GET /api/inference — read-only operator/evidence surface
                          returning just the inference block (+ modelValid). Decides
                          nothing.
sara/backend/
  server.js          EXTENDED  wires /api/inference; updates the API hint line.
sara/backend/test/
  inference.test.js  NEW  12 tests: every activity branch, the away-vs-firefighting
                          contradiction (lowers confidence), malformed-input fallback
                          (unknown + null view + low confidence), the advisory contract
                          guarantee, model integration, health/state agreement.
sara/frontend/src/components/
  RecommendedView.jsx NEW  advisory inference strip in the app shell. Reads
                          model.inference read-only and surfaces activity summary,
                          recommended view, confidence, reasons (Why? toggle), and any
                          contradictions. A *manual* "Switch to X" button is the ONLY
                          path from recommendation to view change — there is no effect,
                          timer, or auto-call to setCurrentView anywhere.
  RecommendedView.css NEW  calm chrome using the shared theme tokens.
sara/frontend/src/
  App.jsx            EXTENDED  renders RecommendedView between the switcher and the view.
  state/views.js     EXTENDED  comment updated: recommended view now exists but is
                          advisory only; DEFAULT_VIEW/currentView are never set by it.
```

No new dependencies. CommonJS throughout the backend (NEURO convention). The WS1
`state-engine-v1` contract identity / `schemaVersion: 1` are unchanged — inference is an
additive, validated extension of the same shared model.

## How it works (the seam, preserved)

- **Where inference inputs come from** — `deriveInference()` reads only what the shared
  model already carries: the `queue` / `focus` / `people` domains, the `telemetry` block
  (HA presence/location/environment), and the situational `location`. Telemetry is one
  input among several; it is never asked to decide anything.
- **Where inference output lives** — inside the single `buildModel()` output as
  `model.inference`, validated by the same contract as the rest of the model. There is no
  second producer and no parallel state. `/api/state`, `/api/health` and `/api/inference`
  all derive from that one model.
- **The bounded logic** — a fixed priority resolution maps the strongest signal to one
  activity and one recommended view: breaching SLA → firefighting → Executive Dashboard;
  away (presence/location) → away → Presence; a current focus task on a calm queue →
  focused-task → Focus; a slipping report → team-attention → Executive Dashboard; nothing
  pressing → steady → Mission Control. Nothing is open-ended or auto-discovered.
- **How uncertainty / missing input is surfaced** — confidence is *derived*, not invented:
  seeded domains without live telemetry cap at `moderate`; live telemetry raises it; a
  contradiction (e.g. presence says away while the queue is breaching) is recorded in
  `contradictions` and lowers the score. If the domains are not contract-shaped, inference
  returns `activity: 'unknown'`, `recommendedView: null`, low confidence, and reasons that
  say why — it refuses to guess. `reasons[]` always explains the read in plain language.
- **How the recommendation stays advisory** — enforced in three places: (1) the contract
  requires `advisory === true`; (2) the engine never selects a view; (3) the frontend only
  changes `currentView` on an explicit user click (the switcher chip or the suggestion's
  "Switch" button). There is no `useEffect`/timer that acts on the recommendation.

## Verification performed (this session, Windows dev machine)

Gathered by building and running the system, not from inherited claims.

- **Tests:** `npm test` (`node --test`) in `backend/` — **29/29 pass** (17 prior + 12 new
  inference tests). The full WS1/WS3 suite still passes unchanged.
- **Live backend** (`node server.js`, port 3209, HA not configured):
  - `GET /api/inference` → `activity:"firefighting"`, `recommendedView:"executive-dashboard"`,
    `advisory:true`, `confidence:{level:"moderate",score:0.6}`, three `reasons` (incl. the
    honest "telemetry unavailable" note), `contradictions:[]`, `inputs.telemetryAvailable:false`,
    `modelValid:true`.
  - `GET /api/health` → `runtime:"WS5-WP1"`, `valid:true`, and an `inference` echo matching
    `/api/state` exactly (activity, recommendedView, advisory, confidence) — no split-brain.
- **Frontend build:** `npm run build` (Vite 5.4.21) — **51 modules transformed**, `dist/`
  emitted clean (~0.9s), no errors.
- **Frontend, live in browser** (Vite dev on 5176 proxying `/api` to the backend on 3005):
  - The advisory strip renders: "SARA THINKS — You look like you're firefighting — 2 tickets
    are breaching SLA", a "Moderate · 0.6" confidence badge, "Suggested view: **Executive
    Dashboard**", an "ADVISORY · WON'T AUTO-SWITCH" flag, and a "Why?" toggle.
  - **No auto-switch, proven visually:** with the recommendation pointing at Executive
    Dashboard, the active view remained **Mission Control**. The view changed to Executive
    Dashboard only after an explicit click on "Switch to Executive Dashboard"; the strip then
    correctly read "Executive Dashboard — you're already here" with the button gone.
  - "Why?" expands the three reasons; browser console clean (no errors/warnings).

## Convergence-criteria compliance

1. **Inferred context/activity state is exposed through the runtime** — `model.inference.activity`
   + `context` + `summary`, on `/api/state`, `/api/inference`, `/api/health`, and the UI strip. ✓
2. **Recommended view is exposed as advisory output** — `model.inference.recommendedView`,
   contractually `advisory: true`; surfaced as a suggestion with a manual switch only. ✓
3. **Confidence and reasons are exposed** — derived `confidence` (score/level/rationale/basis)
   and a `reasons[]` array accompany every inference, including the fallback. ✓
4. **Missing or contradictory input is surfaced honestly** — telemetry-unavailable lowers
   confidence and is stated in `reasons`; conflicts are recorded in `contradictions` and lower
   the score; malformed inputs yield `unknown` + `recommendedView: null` rather than a confident
   lie. ✓
5. **Existing screens remain functional and are not auto-switched** — frontend builds clean and
   runs; every prior screen is untouched and still reads the same shared state; the view only
   changes on user action. ✓

## Constraint compliance

- **Bounded inference layer only** — a fixed activity enum and a fixed activity→view map; no
  open-ended reasoning. ✓
- **Inference output in the shared state model** — folded into the single `buildModel()` output,
  validated by the same contract; State Engine remains the sole producer. ✓
- **Recommended view advisory only** — enforced by contract (`advisory === true`), engine (never
  selects), and frontend (manual click only). ✓
- **No automatic view switching** — verified visually (stayed on Mission Control despite the
  recommendation). ✓
- **No voice behaviour / no distributed-node work / no broad autonomous action** — none added. ✓
- **Home Assistant remains a telemetry bus only** — HA signals are an input to inference; the
  bridge still reads/normalises/caches and decides nothing. ✓
- **Evaluator holdouts not consumed** — no eval_output/holdout artefacts read or written.

## Known limitations (inside WS5-WP1 scope)

- Domain inputs remain seeded — inference is over seeded domains + (when configured) live HA
  telemetry, flagged honestly via root `dataSource:"seed"` and the inference `inputs` map.
- The activity set and activity→view map are deliberately small and rule-based (no learning,
  no weighting) — this is the v0 bounded slice, not a tuned policy.
- Live-telemetry corroboration of the inference was exercised via injected/mock HA snapshots
  (unit tests + the WS3 path); no production HA credentials in this dev environment.

**This work package is ready for evaluation.**
