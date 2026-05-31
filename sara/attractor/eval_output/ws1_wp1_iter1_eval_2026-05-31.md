# WS1-WP1-ITER1 Evaluation — location + confidence on State Engine v1

**Evaluator:** Evaluator Agent
**Date:** 2026-05-31
**Scope:** WS1-WP1-ITER1 only — the iteration that closes the prior `iterate` verdict's sole gap (criterion 2: location + confidence)
**Method:** Observable runtime behaviour only. Endpoints were probed against a live backend; the frontend was rendered in a real browser. Source was **not** used to decide correctness — the seed layer was read solely to craft a fault-injection input (same method as the WS1-WP1 eval), and every verdict below rests on observed behaviour.
**Governing handoff:** `sara/attractor/manager_log/ws1_eval_handoff_2026-05-31.md` — note this handoff **now exists** on disk, resolving the process gap flagged in the WS0 and WS1-WP1 evals.

---

## Overall recommendation: `converge`

The one criterion that held the prior verdict at `iterate` is closed. **Location** and **confidence** are now exposed consistently on both runtime surfaces (`/api/state` and `/api/health`) and rendered in the frontend, both honestly labelled, and confidence degrades in lockstep with the health/validity signal under fault. All previously passing WS1 behaviour (contract identity, seed honesty, derived briefing, honest degradation) remains passing. Nothing is broken, fabricated, or regressed.

---

## Required criteria

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Current **location** exposed consistently | **PASS** |
| 2 | Current **confidence** exposed consistently | **PASS** |
| 3 | Frontend runtime surface displays both values | **PASS** |
| 4 | Both values honestly labelled | **PASS** |
| 5 | Previously passing WS1 behaviour remains passing | **PASS** |

### 1. Location exposed consistently — PASS
- `GET /api/state` → `location: { source:"seed", label:"Office — Wilmslow", context:"on-site", since:"2026-05-31T08:40:00+01:00", summary:"On-site at the Wilmslow office since 08:40." }`
- `GET /api/health` → `location:"Office — Wilmslow"`
- The label served by `/api/health` is **identical** to the `location.label` served by `/api/state`. No backend↔health drift.

### 2. Confidence exposed consistently — PASS
- `GET /api/state` → `confidence: { source:"derived", score:0.6, level:"moderate", rationale:"All domains are contract-shaped, but inputs are seeded (hardcoded), not live.", basis:["contract-valid","inputs-seeded"] }`
- `GET /api/health` → `confidence:{ level:"moderate", score:0.6 }`
- Level and score **match** across both surfaces. Confidence is `derived` (not seeded), and its rationale is consistent with the actual run state.

### 3. Frontend displays both values — PASS
Rendered the production single-process runtime (backend serving the built `frontend/dist`) in a real browser. The runtime metadata list contains exactly these terms: `runtime, contract, valid, location, confidence, served at`. Observed values:
- **location** → `Office — Wilmslow`
- **confidence** → `moderate (0.6)`, carried in an element with class `sara__confidence sara__confidence--moderate` (a per-level colour cue is applied, `--high/moderate/low`).

Both are read from the same `/api/state` payload the backend serves. The headline state already validated in the prior eval (CONNECTED badge, derived briefing line, per-domain summaries, seed banner) is unchanged and still present.

### 4. Both values honestly labelled — PASS
- **Location** is stamped `source:"seed"` in the payload and sits under the page-wide banner *"Seed data — State Engine v1 contract is live, inputs are hardcoded (WS1 scope)."* It is not overstated as a live signal.
- **Confidence** is stamped `source:"derived"` with an explicit, truthful rationale (`"…inputs are seeded (hardcoded), not live."`). It honestly reflects that the model is structurally valid but running on seed data — `moderate`, not `high`. Nothing claims more certainty than the inputs justify.

### 5. Previously passing WS1 behaviour remains passing — PASS
- **Contract identity / real model (prior criterion 1):** `/api/state` still serves `contract:"state-engine-v1"`, `schemaVersion:1`, `dataSource:"seed"`, four populated domains, derived briefing, `meta` block. No `placeholder` flag. `/api/health` still reports `runtime:"WS1-WP1"`, `valid:true`.
- **Seed honesty (prior criterion 4):** root `dataSource:"seed"`; every domain `source:"seed"`; banner + footer unchanged.
- **Derived briefing:** still genuinely derived — `"2 tickets are breaching SLA. Nathan is slipping… Start with: Prep Willem's probation review."` with `derivedFrom:["queue","people","focus"]`, consistent with the underlying domain data.
- **Honest invalid-model handling (prior criterion 5):** re-verified under fault injection (below) — preserved and extended.
- **Contract tests:** `npm test` → **7/7 pass** (5 original + 2 new location/confidence tests), confirmed both before and after the fault-injection round-trip.

---

## Runtime-only evidence

**Clean run** (`node server.js`, fresh instance):
- `/api/health` → `{"status":"ok", "valid":true, "location":"Office — Wilmslow", "confidence":{"level":"moderate","score":0.6}, …}`
- `/api/state` → location + confidence objects as quoted under criteria 1–2; `meta.valid:true`, `errors:[]`, `domainCount:4`.
- `GET /` → `200 text/html`; backend serves the built bundle (single-process production path).
- Browser render → metadata rows for `location` and `confidence` present and populated (accessibility-tree snapshot + DOM eval).

**Faulted run** (invalid `queue` domain injected via the swappable seed seam — `queue.open` removed — on a separate backend instance, then reverted):
- `/api/health` → `status:"degraded"`, `valid:false`.
- `/api/state` → `meta.valid:false`, precise error `["domains.queue.open is missing"]`; engine did **not** crash; served the invalid model transparently.
- **confidence degraded in lockstep:** `{ source:"derived", score:0.3, level:"low", rationale:"Model is degraded — queue domain is not contract-shaped.", basis:["domain-structure-incomplete"] }` on `/api/state`, and `{"level":"low","score":0.3}` on `/api/health` — **same values on both surfaces.**
- **location persisted** under fault (`Office — Wilmslow`, unchanged) — a degraded model does not blank the situational location.

---

## Holdout findings

| Holdout | Result |
|---------|--------|
| Inconsistent field presence between backend, health, and frontend views | **PASS** — location + confidence present and equal across `/api/state`, `/api/health`, and the rendered UI. No drift. |
| Partially missing / malformed domain data | **PASS** — single injected invalid domain degrades that domain honestly; the other three and the situational fields (location, confidence) stay intact. |
| Stale or contradictory confidence vs. state/health | **PASS** — confidence cannot contradict validity: it is `moderate` when `valid:true`, drops to `low` exactly when health goes `degraded`. Both surfaces agree under both conditions. This was the central maturing-state-engine risk and it holds. |
| Invalid model handling + honest health surfacing | **PASS** — precise error, no crash, transparent service, confidence rationale names the real cause. |

---

## Scoped regressions / non-blocking nits

No correctness regressions found.

1. **Carried-forward nit (prior eval #1), not re-triggered here:** `briefing.derivedFrom` still lists all contributing domains by name regardless of whether a clause was dropped. In this iteration's fault (removing only `queue.open`, leaving `breaching`) the briefing's queue clause still had data, so no over-claim was observed. The underlying cosmetic provenance issue is unchanged and remains non-blocking.
2. **Degraded-state UI prominence (prior eval #2) — partially improved, not directly re-observed.** The new per-level confidence colour cue (`--low`) means a degraded run would now render the confidence row in its low-confidence colour, a cheap and material improvement over the prior "only a small `valid:false` field" signal. I confirmed the `--low` class exists and the backend serves `level:"low"` under fault, but I rendered the faulted state only at the API/DOM-class level, **not** as a full browser screenshot — so the visual degraded render is inferred, not directly photographed. Non-blocking; worth a quick visual confirm in a later WP that owns the operator view.
3. **Frontend still shows domain summaries only** (not full ticket/roster/vault detail). Unchanged from prior eval; fine for a proof surface; noted for whichever WP owns the real SARA view.

---

## Is WS1 now sufficient to unlock WS2 planning?

**Yes.** The sole blocker the WS1-WP1 eval raised — criterion 2's missing location and confidence — is closed, exposed consistently on both surfaces and the UI, derived honestly, and stable under fault. The two process gaps that eval flagged are also resolved: the manager handoff (`manager_log/ws1_eval_handoff_2026-05-31.md`) now exists, and the location/confidence decision was made explicitly (added to the contract, not deferred).

The engine, the enforced `state-engine-v1` contract, the swappable seed→live provider seam (now including location), and the honest health/validation/confidence path are all real and working — a clean foundation WS2 can land live data providers against without touching the engine or the contract. Confidence is already wired to flip to `high` once inputs are live, so WS2's provider swaps will exercise that path naturally.

---

## Evaluator process note

While crafting the fault-injection input, I initially reverted my one-line perturbation with `git checkout -- seed.js`. Because the iteration's `location()` work was uncommitted in the working tree (the repo's `seed.js` was `M` against HEAD), the checkout reverted past my edit to the committed HEAD and removed the build agent's location provider. I detected this immediately, restored the `location()` function and its export exactly from the pre-edit file content, and re-verified with `npm test` (7/7) and a clean `git diff` showing only the intended location addition. **No build-agent work was lost; the working tree is intact.** This did not affect any verdict above — all evidence was gathered before the revert, and the restored state reproduces it. Logged to `.claude/memory/mistakes.md` for future runs (perturbations should be reversed with a targeted edit, never `git checkout` on a file carrying uncommitted work).
