# Vault cleanup, pass 2 — 22 Oct 2026

**Status: vault cleanup APPLIED on Windows (canonical) and replicated to the Pi's Archive; code and
database migration deployed per "Deployment" below.** Approved by Nick (257 files requested).
Nothing was hard-deleted. Automatic task-context linking stays OFF; its backfill was not run.

The vault's own record — every path, reason and SHA-256 before/after — is
`Documents/System/Vault Audit/Vault Cleanup 2026-10-22 (pass 2).md`, with the machine-readable
`Scripts/.lint-backups/vault-cleanup-2026-10-22-pass2/cleanup-record.json`. This repo is public,
so this page names folders and groups, not personal paths.

## Totals

| | Requested | Archived | Preflight failures (left in place) |
|---|---|---|---|
| Empty, non-sensitive task-block outcome stubs | 85 | **82** | 3 |
| `Documents/emails/Untitled.md` | 1 | 0 | 1 |
| Duplicate `Ideas/Neuro-1792524622351.md` | 1 | **1** | 0 |
| `Projects/Support Hub` | 44 | **40** | 4 |
| One-off build prompts | 71 | **69** | 2 |
| Empty weekly reviews | 8 | **8** | 0 |
| `Documents/System/Vault Audit` reports | 47 | **47** | 0 |
| **Total** | **257** | **247** | **10** |

Plus: 1 note edited (two mistaken links removed — below), 1 empty folder removed (`Imports/Files`).
Active notes 1,883 → 1,637 (−247 archived, +1 cleanup record). Archived bytes: 1.8 MB.

Vault Audit breakdown, exactly as agreed: 15 dated Hygiene Sweeps, 14 Contextual Links Applied,
8 Lint Reports, 4 Connect Changelogs, 1 Alias Suggestions, 1 Contextual Linking Plan, 1 Fix Plan,
2 Lint Fix Changelogs, 1 PLAUD Missing Reconciliation. Kept: `Vault Cleanup 2026-10-22.md`,
`People gaps.md` (its fallback role is unchanged), and the new pass-2 record.

## Preflight failures — reported, not skipped, nothing substituted

1. **Outcome stub `2026-09-11 Focus block 1030 (2 tasks)`** — linked from a 1-2-1 meeting note
   (sensitive, out of scope to edit). Kept.
2. **Outcome stub for "Document the CI JIRA parent ticket…" (22 Oct)** — its task block (#134) is
   still *scheduled*. Kept.
3. **Outcome stub for "Document the types of tickets that are frequently blocked…" (22 Oct)** —
   block #135 still *scheduled*. Kept.
4. **`Documents/emails/Untitled.md`** — no longer exists. The whole `Documents/emails/` folder was
   removed outside this session between the triage (~14:30) and this pass, on Windows and on the
   Pi, and it is not in `.trash`. It was an empty note (frontmatter only); nothing to archive.
5–8. **Four Support Hub notes NEURO's own employment screen marks sensitive** —
   `Development Plans - 1-1 Findings`, `Development Plans - Requirements`, `Master Action Plan`,
   `Team Voice Survey - March 2026`. Sensitive material is out of scope, so they stay in
   `Projects/Support Hub/`.
9–10. **Two prompts in `Projects/Discovery`** (`Claude Code - KPI v2a vs v3.1 Comparison Prompt`,
   `Phase 06 - Grafana MCP Prompt`) — Discovery is to stay unchanged.

No prompt was created or modified on or after 8 Oct 2026 (all 69 last changed before it).

## How each item was handled

- **Every file** was moved to `Archive/<its original path>` (stubs under
  `Archive/Task outcome stubs (vault cleanup 2026-10-22, pass 2)/…`, the duplicate under
  `Archive/Vault cleanup (vault cleanup 2026-10-22, pass 2)/…`, Vault Audit reports into the
  existing `Archive/Vault Audit/`), after a hash-verified copy to
  `Scripts/.lint-backups/vault-cleanup-2026-10-22-pass2/`. Keeping the original path under
  `Archive/` means every remaining link still resolves: Obsidian matches a path link by suffix
  and a bare name anywhere.
- **The Pi.** Obsidian Sync on the Pi excludes `Archive/` (and dot-folders), so the Pi would have
  seen only deletions. The 247 archived files were copied into the Pi replica's own `Archive/` at
  the same paths (hash-verified 247/247) — which is what lets NEURO's database point at files that
  exist where NEURO runs — and the backups to `/mnt/data/backups/vault-cleanup-2026-10-22-pass2/`.
- **Task-block outcome stubs — one approach, tested on the real records.** `task_blocks.note_path`
  for the 85 block rows (82 notes; three notes were shared by two blocks) is repointed to the
  archive path, so each block's history names a file that exists. All 85 rows are closed
  (`released` / `dropped`); the migration refuses an open block and rolls back. In code,
  `task-blocks.isArchivedNote` makes a note under `Archive/` read-only: never written, never
  recreated on demand, and never "found" by a task-id search in its place. Dry-run and apply were
  run first against a copy of the live database: 85/85 rows repointed, statuses unchanged.
- **The duplicate.** `Ideas/Neuro.md` was re-checked: the archived copy's captured content (an iOS
  crash log) is contained byte-for-byte in `Ideas/Neuro.md`, which additionally carries NEURO's
  `## Mentioned [[NEURO]]` block. Its only link came from a Lint Report archived in the same pass.
- **Weekly reviews.** Their only link from a note that stays active was in
  `Projects/NOVA/NOVA Backlog - Prioritised.md`: two `[[W24-2026-review]]` links that an automated
  lint fix had wrongly repointed on 14 Sep (from a dead `[[NOVA_REVIEW_2026-04-27]]`). Both were
  replaced with the original reference as plain text, `NOVA_REVIEW_2026-04-27`. The reviews are
  not runtime input to NEURO: `obsidian.generateWeeklyReview` only checks whether the CURRENT
  week's file exists and links to the newest earlier one, which still exists.
- **Links.** 23 archived notes (mostly Support Hub documents) are still linked from notes that
  stay active, chiefly meeting notes (sensitive, not edited). Those links resolve into `Archive/`
  on Windows and on the Pi. Unresolved links in active notes: **355 before → 285 after, 0 new**
  (the 70 that went were inside the archived notes themselves).

## Database pointers

A read-only scan of every text column in NEURO's database found the archived paths in:
`task_blocks.note_path` (85 rows → repointed), `vault_embeddings` (929 rows), `extracted_entities`
(1,178), `note_links` as source (923) — derived index rows, deleted (Archive/ is excluded from
indexing, so the nightly rebuild would drop them anyway) — `note_links` as target (4 → repointed to
the archive path), and four `note_action_review:*` keys in `agent_state` (deleted). No task's
`origin_path` named any archived note. The two derived caches `embeddings_truncated` /
`embeddings_coverage` are recomputed by NEURO (hourly coverage refresh).

## Writers: dated Vault Audit reports cannot come back

Every report now lives in NEURO's database — `services/audit-reports.js`, table
`vault_audit_reports`, a `vault_audit_report` activity event, `GET /api/vault-hygiene/reports[/:id]`,
and **Brain Health → Reports**. Nothing writes into `Documents/System/Vault Audit` any more:
lint, contextual linking plan, contextual links applied (written after every PLAUD sync), fix plan,
lint-fix and connect changelogs, alias suggestions, the nightly hygiene sweep (only on a night it
changed something), PLAUD summary rename, and the PLAUD missing reconciliation. The same report on
the same day replaces the earlier row (Brain Health scans on every open). The machine-readable fix
plan stays at `Scripts/.lint-plan.json` because the apply step reads it. `People gaps.md` is
unchanged. Pinned by `backend/services/vault-cleanup-pass2.test.js` (8; four guards
mutation-checked: the archived-note read, the checklist write, same-day replacement and the
no-vault-write rule; the stub-writer guard is a stated second guard behind `createNote`).

## Not done here (by scope)

The 20 Plaud/Meeting duplicate candidates, all Plaud source material, parked projects,
capture/scratch notes, `Security review/`, sensitive material, `Projects/Discovery`, the 90 Day Plan
documents, `.trash`, `.obsidian-pi-sync`, `Archive/SAiM Import Reports`, `Focus Sessions`, the vault's
`.git`. Writers outside Vault Audit are unchanged: task blocks still create an outcome stub per
block, and the Friday weekly review still creates a page with placeholders.

## Deployment (22 Oct 2026, after this report)

- `main` at `c9399b16` (code `f006e0eb` + this report) on pi5: frontend built, backend suite
  **7,779 tests, 0 failures**, `neuro-backend` restarted, MCP gateway rebuilt (healthy; inventory now
  has the report routes). Automatic task-context linking still **off**; nothing called it.
- Live database backed up first to `/mnt/data/backups/vault-cleanup-2026-10-22-pass2/agent-before-migration.db`.
  Migration dry run, then apply: 85 task_blocks repointed, 929 embedding / 1,178 entity / 923
  note-link rows removed, 4 note-link targets repointed, 4 extraction-memory keys removed
  (`Ideas/Neuro-1792524622351.md`, W28/W35/W37 reviews). One stale entry in NEURO's
  over-long-notes cache (`embeddings_truncated`, Support Hub's AI Agent spec) removed and index
  coverage recomputed.
- Re-scan of every text column afterwards: no table points at an old path; the only remaining
  matches are the new archive paths themselves and two notes whose TEXT mentions a Support Hub
  path (`Projects/_about.md`, `Decision Log/vault-moves.md`) — mentions, not pointers.
- Live checks: a scan through `/api/vault-hygiene/lint` stored `neuro:vault-audit/1`, a second scan
  replaced it, and `Documents/System/Vault Audit` stayed at 3 files; asking NEURO to recreate an
  archived block's note answers "archived" and writes nothing (the archived file's SHA-256 is
  unchanged). Behaviour snapshot before/after deploy **identical**: open task blocks, task list,
  Drafts sections, Now, projects (39), task-context off.
- Sync: the Windows Obsidian client stalled with 78 moves unsent (no push for ~30 min — the known
  silent-wedge failure). It was restarted after backing up the only two files changed since the
  stall (both NEURO-generated task mirrors); the backlog drained in under a minute and Windows and
  the Pi agree (no original reappeared).
