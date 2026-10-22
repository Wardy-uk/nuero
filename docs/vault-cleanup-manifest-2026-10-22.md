# Vault cleanup manifest — 22 Oct 2026 (AUDIT ONLY)

**Status: proposal. Nothing has been deleted, moved, rewritten, archived or consolidated.**
The task-context backfill waits until Nick approves this manifest and the cleanup is done.

Measured read-only against the Windows vault (`C:\Users\NickW\Documents\Nicks knowledge base`,
canonical) on 22 Oct 2026: 2,210 files, 2,021 markdown notes. Reproduce with
`vault_audit.py` (kept with the session; it opens files read-only and writes only its own JSON).

Legend for **Action**: `delete` (move to `Archive/` first — this repo never hard-deletes a
note), `consolidate`, `retain briefly` (keep N days, then delete), `replace` (stop writing it to
the vault; keep the record in NEURO's DB instead), `retain`.

---

## 1. Empty daily import reports — `Documents/System/SAiM Import Reports/`

**Writer:** `knowledge-memory.writeDailyImportReport()`, every night at 23:40
(`scheduler.js:1038`), **unconditionally** — it writes a report whether or not anything
happened. Also written after each consolidation run.

**Findings.**
- 38 reports, 15 Sep → 22 Oct 2026.
- **27 are empty:** 0 consolidated, 0 enrichments, 0 needing review. 24 of those record only "Import routes: N".
- `2026-09-17.md` lists the same consolidation **7 times**. Seven identical "Created …" lines all point at one meeting note — a duplicate-write signal in the consolidation pass, worth its own look.

**Empty — exact paths** (all under `Documents/System/SAiM Import Reports/`):
2026-09-15, 09-19, 09-20, 09-22, 09-23, 09-25, 09-27, 09-28, 09-29, 09-30, 10-01, 10-02, 10-03,
10-05, 10-06, 10-09, 10-10, 10-11, 10-12, 10-13, 10-14, 10-15, 10-16, 10-17, 10-20, 10-21, 10-22 (`.md`).

**Non-empty** (keep for now): 2026-09-16 (89 enrichments), 09-17 (7 consolidations, 6 duplicate
lines), 09-18, 09-21, 09-24, 09-26, 10-04, 10-07, 10-08, 10-18, 10-19.

| | |
|---|---|
| Why noise | A dated page that says "nothing happened" carries no information and accrues one file a day. |
| Action | **delete** the 27 empty ones; **retain briefly** (30 days) the non-empty ones. |
| What breaks | Nothing reads them as data. `GET /api/knowledge-memory/report` *rebuilds* a report from `activity_log`; it does not read the file. They are already in `vault-exclusions` `GENERATED_DIRS` (not indexed). `Documents/Vault/Logs.md` links some old **SARA-era** reports by path — those links are already stale (see 6). |
| Replacement rule | Change the writer to skip the file when every count is zero, and keep the report in `activity_log` (it already is). Retention: delete reports older than 30 days. The run receipt belongs in NEURO's DB, as task-context's `task_context_runs` does. |

## 2. Generated "SAiM Actions" lines in Daily notes — `Daily/*.md`

**Writers:**
- `next-action-engine._appendToDailySection('## SAiM Actions', …)` for meeting-prep logs, the EOD observation log, executed actions and `logOutcome`.
- `suggestion-engine` for executed suggestions.

**Findings.**
- **63 daily notes** carry the section: **763 lines**, **144** of them exact repeats once the time is stripped.
- Make-up:
  - 468 meeting-prep logs
  - 266 executed-action lines
  - 29 "Completed:" outcomes
- Worst days:
  - `Daily/2026-09-16.md`: 50 lines, 26 repeats
  - `2026-08-27`: 42 lines, 19 repeats
  - `2026-08-12`: 29 lines, **28 identical** "Checkbox task found in note"
  - `2026-07-10`: 14 lines, 13 repeats
- **Still being written:** 17 lines on 20 Oct, 14 on 21 Oct, 7 so far today. Examples of the noise:
  - "Meeting prep: Plaud admin — Sprint Planning" logged at 10, 5 and 1 minutes out. The 30-minute cooldown does not hold across those windows.
  - Prep logged for "Take a break" (15 times across the vault).
  - Prep logged for task blocks and Plaud admin blocks, none of which is a meeting.

**Exact paths:** `Daily/2026-` + 04-04, 04-06, 04-07, 04-10, 07-09, 07-10, 08-12, 08-13, 08-14,
08-15, 08-17, 08-18, 08-19, 08-20, 08-21, 08-24, 08-25, 08-26, 08-27, 08-28, 09-01, 09-02, 09-03,
09-04, 09-05, 09-07, 09-08, 09-09, 09-10, 09-11, 09-13, 09-14, 09-15, 09-16, 09-17, 09-18, 09-21,
09-22, 09-23, 09-24, 09-25, 09-28, 09-29, 09-30, 10-01, 10-02, 10-05, 10-06, 10-07, 10-08, 10-09,
10-10, 10-12, 10-13, 10-14, 10-15, 10-16, 10-17, 10-18, 10-19, 10-20, 10-21, 10-22 (`.md`).

| | |
|---|---|
| Why noise | A machine log interleaved with Nick's own daily note. Nothing reads the lines back: the only readers check that the **heading exists** (`suggestion-engine.js:885`, `next-action-engine.js:304`), and `standup-session` merely preserves the section. Every line is already in `activity_log` (`saim_auto_action`, `saim_action`, `saim_outcome`) and visible in NEURO → Activity. |
| Action | **replace**: stop writing the section (the writers keep their `activity_log` rows). Then **remove the section** from the 63 notes. This is a surgical edit of one section per note; the rest of each note is untouched, and the original is backed up to `Scripts/.lint-backups/`. |
| What breaks | Nothing that reads data. The heading-presence checks become no-ops. The standup's merge keeps working (it preserves whatever sections exist). Obsidian Sync carries the edit to the Pi. |
| Replacement rule | No machine-written lines in Daily notes. If Nick wants a day's SAiM log, NEURO renders it from `activity_log` on demand. It is never persisted into his note. |

## 3. Vault-hygiene reports — `Documents/System/Vault Audit/`

78 files, 1.1 MB:
- 30 Hygiene Sweep (one a night, 21 Sep → 22 Oct)
- 14 Contextual Links Applied
- 10 Lint Report
- 8 Contextual Linking Plan
- 4 PLAUD Missing Reconciliation
- 4 Connect Changelog
- 3 Fix Plan
- 2 Lint Fix Changelog
- 2 Alias Suggestions
- `People gaps.md` (rolling)

| Candidate | Why | Action | What breaks | Rule |
|---|---|---|---|---|
| `Hygiene Sweep YYYY-MM-DD.md` ×30 | A nightly page, mostly "0 / 0 / 0" plus the same "Kept — unique content" list repeated every night | **replace** with ONE rolling `Hygiene Sweep.md` (overwritten), as `People gaps.md` already is; **delete** the dated ones older than 14 days | Nothing reads them | Rolling file; nothing written on a no-change night |
| `Lint Report`, `Contextual Linking Plan`, `Fix Plan`, `Alias Suggestions` | Superseded by the next run | **retain briefly** (latest of each + 30 days) | Nothing reads them | Keep the latest + 30 days |
| `Contextual Links Applied`, `Connect Changelog`, `Lint Fix Changelog` | **Audit trails of vault writes**: the record of what was changed, and how to reverse it, alongside `Scripts/.lint-backups/` | **retain** | Losing them loses the undo trail | Keep while the matching backup exists |
| `PLAUD Missing Reconciliation` ×4 | One-off recovery reports | **retain briefly** (30 days) | Nothing | — |

## 4. Duplicate or obsolete notes

| Path | Why | Action | What breaks |
|---|---|---|---|
| `Reflections/2026-04-14 – Heidi Power 30-Day Performance Review.md` | Byte-identical body to `Documents/HR/2026-04-14 – Heidi Power 30-Day Performance Review.md`, and an HR document sitting in a journal folder | **delete** the Reflections copy (Archive first); keep `Documents/HR/` | Links pointing at the Reflections path (check first) |
| `Decision Log/Untitled.md`, `Ideas/Neuro-1791455106470.md`, `Ideas/Neuro.md` | Three identical bodies, two of them untitled or auto-named | **consolidate** into `Ideas/Neuro.md`; archive the other two | Nothing obvious; check backlinks |
| `Meetings/2026/06/2026-06-17 – 1-1 Team Performance, Dev Escalation, and AI-Enabled Workflow 2.md` | A `" 2"` twin of a 1-2-1 that has a note of record under `Meetings/1-2-1/Sebastian Broome/` | **retain** until checked. The nightly hygiene sweep already reviews it and keeps it as "unique content". Nick to decide which copy is canonical | Plaud ledger is keyed on `plaud_id`, not the path |
| 20 recordings with more than one non-transcript note (e.g. a `Plaud/Recordings/… Summary.md` beside its `Meetings/` note) | Plaud summaries that were never routed or consolidated | **retain**. This is the Plaud consolidation decision already recorded as unmade in CLAUDE.md ("a decision, not a bug fix") | Moving them changes what consolidation would write |
| `Projects/D&D/Notion/D&D Campaign/Sessions/2026-08-31 – Session 2.md` | **Not** a duplicate: a real "Session 2" | **retain** (listed so it is not swept by a `" 2"` rule) | — |

## 5. Empty mirrored pages — `Notion/`

11 notes are frontmatter only, 168 bytes each:
- `Notion/Aquarium/`: Current Issues, Livestock, Plants, Tank Profiles
- `Notion/Hiking/`: Kit Inventory, Planned Trips, Preferences, Routes
- `Notion/Nick/`: Important Context, Preferences, Profile

| | |
|---|---|
| Why | **Pull-only** Notion mirrors of pages that are empty in Notion |
| Action | **retain**. Deleting the vault copy is undone by the next pull; the fix is in Notion (fill or delete the pages) or the mapping |
| What breaks | Nothing |
| Rule | Leave pull mirrors to the Notion sync |

## 6. Stale index note — `Documents/Vault/Logs.md`

A hand-maintained MOC whose "Import / cleanup logs (10)" section links **SARA Import Reports**
paths from June, one of them a `.sync-conflict-` file. Every report since links `[[Logs]]` in
its footer, so the MOC claims to collect logs and lists none of the 38 current ones.

| | |
|---|---|
| Action | **replace** the hand-listed links with a sentence pointing at the folder, or delete the section; stop writing `_Part of [[Logs]]_` into generated reports |
| What breaks | Backlinks from reports to `Logs` (only decorative) |

---

## Proposed order once approved

1. Stop the writers first, so the cleanup is not refilled the next night:
   - empty import reports (1)
   - `## SAiM Actions` (2)
   - dated hygiene sweeps (3)
2. Archive (never hard-delete) the candidates in 1, 3, 4, with a changelog in `Vault Audit/` and backups in `Scripts/.lint-backups/`. The surgical section removal in 2 is done the same way.
3. Then run the task-context backfill: `POST /api/task-context/scan` from NEURO, which writes NEURO tables only.

⚠ The vault is synced (Obsidian Sync, Windows canonical). Do the cleanup **on Windows**.
Keep any bulk edit out of `action-candidates` extraction: a bulk machine write through
vault-hooks once raised 108 spurious candidates (15 Oct 2026).
