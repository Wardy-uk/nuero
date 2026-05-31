# Build Status — WS1-WP1: State Engine v1 contract

**Status: READY FOR EVALUATION.**

## Scope

Replace the WS0 placeholder stub with a **real State Engine v1 contract**. Still
allowed to use hardcoded inputs — the deliverable is a real contract and a real
engine, not real integrations. The one shared runtime model is exposed over the
**existing** backend path (`/api/state`, `/api/health`) — the path is unchanged;
only what the engine returns has changed.

## What was added or changed

All changes are inside `sara/`. Nothing in the existing NEURO `backend/`,
`frontend/`, or `worker/` was touched. The `/api` runtime path and the
server/route wiring are unchanged.

```
sara/backend/src/state/
  contract.js        NEW  state-engine-v1 contract: CONTRACT, SCHEMA_VERSION,
                          DOMAINS, DOMAIN_CONTRACTS, validate(model)
  seed.js            NEW  hardcoded domain inputs (queue/focus/people/vault),
                          every domain stamped source:'seed' — the swappable layer
  stateEngine.js     REWRITTEN  the real engine: assemble domains -> derive
                          briefing -> self-validate; getState()/getHealth()
sara/backend/test/
  stateEngine.test.js NEW  node --test contract smoke tests (zero deps)
sara/backend/package.json   + "test": "node --test"
sara/frontend/src/App.jsx   updated to render the v1 model (briefing + per-domain
                          summary); seed banner replaces the WS0 placeholder flag;
                          WS0 duplicated-footer nit fixed
sara/frontend/src/App.css   + .sara__briefing / .sara__domains styles
sara/README.md              State Engine v1 section + updated limitations
```

### The contract (what makes it "real", not a stub)

- **Identity + version:** `contract: "state-engine-v1"`, `schemaVersion: 1`
  (WS0 was `schemaVersion: 0`, `domains: {}`, `placeholder: true`).
- **Enforced shape:** `validate(model)` checks the root keys, the `sara` block, a
  non-empty derived `briefing.line`, and the per-domain backbone in
  `DOMAIN_CONTRACTS` (each of `queue/focus/people/vault` must carry its required
  keys plus `source`/`summary`). Unexpected domains are rejected.
- **One engine, real work:** `buildModel()` assembles the single model from named
  providers and **derives** SARA's briefing line from the assembled data (not a
  hardcoded sentence). `getHealth()` derives from the *same* model, so health and
  state cannot disagree, and reports `degraded` if the model fails its own
  contract.

### Honesty about hardcoded inputs

- Root `dataSource: 'seed'`; every domain `source: 'seed'`; `sara.note` states the
  inputs are seeded and not yet wired to real sources.
- `seed.js` is isolated as the swappable layer — WS2+ replaces each provider with
  a live reader without changing `stateEngine.js` or `contract.js`.

## Verification performed (this session, Windows dev machine, Node v25.6.1)

All gathered by running the system, not from inherited claims:

- **Contract tests:** `npm test` (`node --test`) in `backend/` — **5/5 pass**
  (model conforms to contract; `getState` exposes the contract + seed flags;
  briefing is derived from data; health derives from the same model; `validate`
  rejects a model with a missing domain).
- **Live backend** (`node server.js`, `SARA_PORT=3066`):
  - `GET /api/health` -> `{"status":"ok","runtime":"WS1-WP1","contract":"state-engine-v1","schemaVersion":1,"dataSource":"seed","valid":true,...}`
  - `GET /api/state` -> contract `state-engine-v1` v1, `dataSource:"seed"`,
    `meta.valid:true` (0 errors), domains `queue, focus, people, vault`,
    `queue.open/breaching = 4/2`.
  - Derived briefing: *"2 tickets are breaching SLA. Nathan is slipping — no ticket
    response logged since Wednesday. Start with: Prep Willem's probation review."*
  - `GET /api/does-not-exist` -> `404` (API namespace still does not leak the SPA).
- **Production single-process path** (`SARA_PORT=3067`): `GET /` -> `200 text/html`,
  SPA fallback `GET /briefing` -> `200 text/html`, `GET /api/state` ->
  `200 application/json`.
- **Frontend build:** `npm run build` — Vite 5.4.21, 31 modules transformed,
  `dist/` re-emitted clean (~0.8s).

## Protected-principle compliance

- One SARA, one shared state model: all state flows through the single
  `stateEngine.js`; `/api/health` and `/api/state` derive from the same
  `buildModel()` output.
- Forward-compatible seam preserved: the WS0 eval called `schemaVersion:0` /
  `domains:{}` "a clean seam for the central State Engine to land against in WS1."
  WS1 lands on exactly that seam — `schemaVersion:1`, domains populated, inputs
  isolated in `seed.js` for live swap-in.
- Honest labelling kept: `placeholder` is gone (the contract is real), replaced by
  `dataSource:'seed'` / `source:'seed'` so consumers still know the data is not
  live.
- Slice kept small and surgical: existing NEURO code untouched; runtime path,
  server boot, PM2 config, and `start.sh` unchanged.

## Known limitations (inside WS1 scope)

- Domain inputs are hardcoded (seed), not live integrations — flagged honestly.
- No auth on the SARA backend yet (NEURO's PIN/token middleware not ported).
  Reachable only over the private Tailscale network.
- Contract smoke tests only; no CI. Systemd->PM2 boot hook still asserted from
  config, not executed off-platform (unchanged from WS0).

**This work package is ready for evaluation.**
