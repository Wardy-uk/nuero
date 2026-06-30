# HANDOFF — Vault Hygiene Engine productionised (2026-06-30)

## What this session did
Actioned `Projects/NEURO/Vault Hygiene Engine — Build Handoff (Claude Code).md` in full —
ported the throwaway `Scripts/_*.js` prototypes into NEURO as first-class capabilities
(backend service + route + MCP tools + scheduler). **All §1 + §9 capabilities built and
validated read-only/dry-run against the live Windows vault.** Nothing of Nick's was mutated
except generated reports (lint audit). No git commits made.

### New files
- `backend/services/vault-hygiene.js` — deterministic engine (pure CommonJS, takes vault root → runs in-process OR standalone via `node`). Exports: `lint`, `contextualLinkPlan`/`Apply`, `aliasSuggest`, `fixPlan`/`fixApply`, `connectOrphans`, `graphConfig`.
- `backend/routes/vault-hygiene.js` — `/api/vault-hygiene/*` (lint, contextual-link/plan+apply, fix/plan+apply, connect-orphans, graph-config, alias-suggest). Wired in `server.js`. Mutating routes re-index touched files via `vault-hooks`.

### Edited
- `mcp-server/index.js` — 8 new MCP tools: vault_lint, vault_contextual_link (mode plan/apply), vault_alias_suggest, vault_fix (mode plan/apply, tiered), vault_connect_orphans, vault_graph_config, vault_plaud_reconcile, vault_plaud_repull.
- `backend/services/plaud-sync.js` — added `reconcilePlaudRecordings()` (read-only, §9.1) + `repullPlaudRecordings({ids?,limit?})` (§9.2) + jitter on the existing `withRetry`. **KEY: NEURO's plaud-sync ALREADY had the throttle/429-backoff/per-recording-ledger §9.3 demanded — the "no throttling" lesson was about the SEPARATE Obsidian plaud-mcp-sync plugin.**
- `backend/routes/plaud.js` — `/api/plaud/reconcile` + `/api/plaud/repull`.
- `backend/services/scheduler.js` — Friday 4:35pm READ-ONLY weekly hygiene pass (lint + contextual cards, never applies) + push (§7.6).
- `CLAUDE.md` — documented the engine, tools, patterns.

## Validation (all read-only / write:false against live vault)
- **lint:** 800 notes; 45 distinct broken links (deduped from 65), 5 orphans (one a real sync-conflict file), 19 under-linked People. Report written: `Documents/System/Vault Audit/Lint Report 2026-06-30.md`.
- **contextual proposer:** deterministic (re-derived existing `## Mentioned` on 26/30 stamped notes; the 4 diffs are project-link subsets = more conservative). **0 bare-first-name mislinks** (full-name rule holds). Idempotent (marker skip). The 4 ctx roots are already fully stamped from 29 Jun → plan returns 0 there (correct).
- **alias_suggest:** 2 genuine candidates (Lucy Reid/Lucy Reed → Lucy Read). Abdi/Naomi already aliased → correctly excluded.
- **fix plan:** conservative=0 (exact-only → safe no-op), moderate=6/aggressive=7 all fuzzy. Reproduced the §3.6 hazard exactly (top aggressive match = wrong-DATE stand-up 06-17→06-25) and correctly quarantined behind aggressive tier.
- **connect_orphans:** 95/95 dailies already chained, 0 NOVA orphans → idempotent no-op.
- **graph_config:** read returns 10 canonical colour groups + Obsidian-overwrite warning.
- **plaud reconcile:** match logic validated (486 dated active notes / 116 active plaud_ids; token-echo→present, unrelated→missing, timestamp-name→date-only, no-notes-date→missing). Live PLAUD list only runs on Pi.

## NOT DONE / next steps
1. **Deploy to Pi 5** — none of this is live yet. Needs: git commit + push, `ssh nickw@100.100.28.58`, pull, restart NEURO (pm2) + MCP server. Memory `pi5-deployment` has process names/paths.
2. **Run the real workflows (Nick to trigger, with sign-off):**
   - `vault_lint` for a fresh audit (45 broken links genuinely actionable — mostly Decision Log → renamed/binned meeting notes).
   - `vault_contextual_link mode=plan` over WIDER roots than the 4 already-stamped (e.g. People, Projects, Ideas) to surface fresh cards.
   - `vault_fix mode=apply links=conservative` is safe (0 here). Fuzzy stays review-only.
   - `vault_plaud_reconcile` then `vault_plaud_repull limit=20` (batched) for the ~178 binned recordings. Reference list: `Documents/System/Vault Audit/PLAUD Missing Reconciliation.md`.
3. **apply paths NOT run live** (correct — need per-step sign-off): contextual apply, fix apply, connect, graph apply, plaud repull. Logic proven; just unrun against the live vault.

---

## Carried over from 2026-06-19 (SARA / Pi estate — still pending)
- **Delete once happy**: pi5 old `/home/nickw/tally` + DB; local `C:\tmp\tally-deploy`.
- **Ollama perf recheck on pi5** (the real load).
- **Pi 3 utility node** — "later", not started.
- SARA TODOs (from 06-12, untouched): PWA Phase 2 mobile-responsive layout; Focus Enforced port into SARA.
- `sara/scripts/start-sara-frontend.sh` is NEW + uncommitted in the nuero repo (offered to commit).
- Memories: `tally-on-pi-dev`, `tailscale-serve-localhost-only`, `sara-frontend-node-pidev`.
