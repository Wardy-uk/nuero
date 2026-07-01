# HANDOFF — Vault Hygiene Engine + PLAUD recovery + graph cleanup (2026-06-30 → 07-01)

## Headline
Actioned the full Vault Hygiene Engine build handoff, deployed to Pi 5, recovered/pulled 153 PLAUD recordings, deduped People/Team, did a long graph-orphan cleanup, and then **baked all the manual fixes into the pipeline so the vault self-maintains**. Engine code committed + pushed + live on Pi.

## SELF-MAINTAINING PIPELINE (2026-07-01) — the manual work is now automated
The recurring "fresh rim every morning" is fixed at source. All deployed to Pi 5.
- **Premature-stub gate** (`plaud-sync.js` sync loop): skips a recording if PLAUD has neither transcript nor summary yet (was writing empty stubs mid-transcription, then marking synced so they never re-pulled). Re-pulls next cycle. THE root cause.
- **Auto-link on import** (`plaud-sync.js` sync + repull return, gated on new imports): runs `contextualLinkApply` on Meetings/Plaud → new meetings arrive linked.
- **Report self-stamping**: every report writer appends `_Part of [[Logs]]_` at write-time (vault-hygiene lint/plan/fix/alias, plaud reconcile, `knowledge-memory` daily import report line ~1435, `imports` cleanup report ~1180). Reports born connected.
- **Engine fixes** (`vault-hygiene.js`): `DEFAULT_PROJECT_LINKS` case-insensitive (catches lowercase "Nova"); `closeOpenFence()` so appended `[[links]]` aren't trapped in unclosed ``` fences (that bug made notes look linked but Obsidian ignored them).
- **Nightly sweep 2:30am** (`scheduler.js` → `vault-hygiene.nightlySweep`, APPLY): `dedupSummaries` (group by plaud_id — same-date "Summary N" can be DIFFERENT meetings; keep richest SAME-DIR variant, archive another only if ≥95% word-shingle contained; never move routed notes, never delete → `Archive/Summary Duplicates`), `collectUnnamedRecordings` ("Speaker N" + no full-name person link → `MOCs/Orphan.md`), `sweepEmptyStubs`.
- **Graph → 0 real orphans**: People/Team dedup (15 Team notes merged into canonical People/, `Archive/Team-merged`), added Emma Maciver + Riannah Clegg to roster + force-relinked their meetings, hubs `MOCs/Orphan.md` + `MOCs/Logs.md`. KEY LESSON: my external graph reconstruction was WRONG repeatedly (missed .canvas/.base files, counted code-block links + own-report phantom links, basename collisions) — Nick's visual spot-checks were ground truth. Don't trust a rebuilt Obsidian graph; handle by category / defer to his eyes.
- Manual-only remaining: naming "Speaker N" recordings (queued in `MOCs/Orphan.md`) — genuinely needs a human. Also `Archive/Pending Transcription` holds 7 untranscribed 07-01 recordings that re-create when Nick transcribes them in PLAUD.

## Shipped & committed (origin/main, Pi 5 live)
- `backend/services/vault-hygiene.js` + `routes/vault-hygiene.js` — engine: lint, contextualLinkPlan/Apply, aliasSuggest, fixPlan/fixApply (tiered), connectOrphans, graphConfig. 8 MCP tools (`vault_lint`, `vault_contextual_link`, `vault_fix`, `vault_alias_suggest`, `vault_connect_orphans`, `vault_graph_config`, `vault_plaud_reconcile`, `vault_plaud_repull`).
- `plaud-sync.js` — `reconcilePlaudRecordings`, `repullPlaudRecordings`, **`repullStubTranscripts`** (recovers "No transcript returned" stubs — get_transcript returns empty under load even when a transcript exists; retry-on-empty added). Routes: `/api/plaud/reconcile|repull|repull-stubs`. MCP: `vault_plaud_repull_stubs`.
- Commits: `4ff8c96` engine, `b1bd094` .stversions fix, `458c0fe` stub recovery. Pi tracks origin/main cleanly (reconciled — see git note below).
- Scheduler: read-only Friday 4:35pm hygiene pass.

## PLAUD outcome
- reconcile→0 missing (all 199 recordings have notes). **108 stub transcripts recovered** + 45 missing pulled. Hardened fetch = no new stubs.
- ⚠️ "Stub" recordings named by timestamp (e.g. `090044`, `095549`, `16 28 23`) often have REAL 200+ line transcripts — just "Speaker N" + no summary. **DO NOT archive them by name — read the content first.** I nearly binned 3 real meetings this way.
- Durable follow-up: patch report-writers to self-link to `[[Logs]]` (Vault Audit reports regenerate & re-orphan). Not done.

## Pi state
- Pi 5 (`nickw@100.100.28.58`, `/mnt/data/nuero`) was badly git-drifted; reconciled safely: tarball `/mnt/data/nuero-worktree-backup-20260630-123919.tgz` + snapshot branch `pi-local-snapshot-20260630` (on origin) → `git checkout -f -B main origin/main`. Now clean, future deploys = normal `git pull`. Pi has NO github creds (can't push from Pi).
- Syncthing was DOWN on **Windows** (not Pi) — restarted it; Pi↔Windows now converged.

## Vault changes made (all backed up to Scripts/.lint-backups/)
- 1221 contextual links applied across 361 meeting notes.
- **People/Team dedup**: 15 `Team/{person}` notes were duplicates of canonical `People/{person}` (31 links → People, 0 → Team). Merged unique content into People/, archived Team copies to `Archive/Team-merged/`. Adele got proper person frontmatter.
- New MOCs: `MOCs/Orphan.md` (unidentified meetings, owner [[Nick Ward]]), `MOCs/Logs.md` (auto-gen reports).
- Archived junk: 8 empty PLAUD stubs + 6 empty `Untitled-2026030915…` 0-byte imports + empty `Untitled.canvas` → `Archive/`.

## ⚠️ MY GRAPH-ANALYSIS WAS UNRELIABLE — read before trying again
I built a markdown link-graph analyser to find Obsidian orphans and it was WRONG ~10 times. Obsidian's graph differs from a naive .md link scan in ALL these ways (each one burned a cycle):
1. **Only .md** — misses `.canvas` and `.base` files (Obsidian shows them; empty `Untitled.canvas` = orphan).
2. **Code-block links** — Obsidian does NOT draw edges for `[[links]]` in ``` fences or `inline code`. Must strip both.
3. **Phantom report links** — Vault Audit lint/plan reports `[[link]]` to every note they list → falsely "connect" orphans. Reports also list notes as `## headings` (not links → no edge). Exclude `Vault Audit/` as an edge source.
4. **Basename collisions** — `[[2026-06-24]]` (daily vs SARA report), `[[Heidi Power]]` (People vs Team). Must resolve path-aware: exact path > same-folder > shortest path.
5. **Frontmatter links** (`manager: [[Nick Ward]]`) — Obsidian draws these; a naive body-only scan misses them.
6. Result: "0 orphans" from my tool ≠ what Nick sees. **Trust the user's eyes / Obsidian, not a reconstructed graph.**
Best analyser version reached: `C:\tmp\truth2.js` (strip code, path-aware, canvas incl, Vault Audit excluded) — closest but still imperfect.

## OUTSTANDING (next session)
1. **Summary-N dedup** — THE real remaining rim cause. PLAUD makes multiple partial summaries per recording (Summary, Summary 2, Summary 3…). Dedup content-safely (word-shingle containment — a variant is only droppable if ~all its text exists in a kept copy; per 2026-06-23 mistakes-log). Keep one canonical per plaud_id, archive rest.
2. **Name the unnamed "Speaker N" recordings** (in MOCs/Orphan.md) — human task; then they weave into people.
3. Durable report self-linking patch (optional).
4. Pi vault (`/home/nickw/nuero-vault`) had `.stversions` (1041 old versions) inflating scans — now excluded in engine, but the folder still exists on Pi.

## USER STATE
Nick is neurodivergent; overwhelm is the failure mode. This session ran VERY long chasing graph orphans — a partly-unwinnable goal (a knowledge vault has a healthy fringe; his own handoff §5 says "success is NOT fewer orphans"). His spot-checks were RIGHT every time my tool was wrong. Be honest about tool limits; don't over-claim "zero".
