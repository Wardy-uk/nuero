# Plaud transcript repair: Phase 1 report

**Status:** Phase 1 complete (read-only). Nothing has been written to the vault, NEURO's database or Plaud. **This needs your approval before Phase 2.**
**Date:** 2026-10-08 · **Session:** nuero-1f (coordinated with nuero-6d / Build 23, which works in a separate worktree, with no shared files)

## TL;DR

- **The writer is NEURO's `plaud-sync.js`, not the Obsidian plugin.** The plugin is dormant: auto-sync is off and it last ran on 30 Jun 2026.
- **Root cause, proven on the live API.** `fetchTranscriptSegments` pages by sending `offset`, but PLAUD's `get_transcript` (`@plaud-ai/mcp` 0.3.14) has **no `offset` parameter**. It ignores the argument and returns page 1 every time. The loop then counts its own offset up to `total`, so it writes the first 50 segments `ceil(total/50)` times.
- **It isn't one file. It's 145 of the 263 transcripts in the vault**, about 85 hours of meetings. 84 of them fall in the last 60 days. Every transcript over 50 segments written since 28 Aug is affected. The other 118 match PLAUD's segment totals exactly.
- **Task risk is lower than the brief assumed.** Task discovery has never read `Plaud/` (`action-candidates.shouldSkipPath`). No task or action in the DB points at a transcript. A transcript-only repair can't create, reopen or revive a task, by construction.
- **There is a downstream copy outside the vault.** NOVA holds 24 of the corrupt transcripts (1-2-1s). A vault repair won't refresh those (see section 4).

## 1. Which component wrote the file

| Check | Finding |
|---|---|
| Frontmatter | `speakers_named: true`. This field is written only by NEURO's speaker-naming gate (`plaud-sync.js`, `assessSpeakerNaming`). |
| Location | `Plaud/Transcripts/`. This is NEURO's configured `PLAUD_TRANSCRIPT_FOLDER` on the Pi (documented in CLAUDE.md), not only the plugin's output path. |
| Sync ledger | 139 of the 144 corrupt ids in the ledger list the corrupt file as their `transcriptRelativePath`. Sync stamps run from 12 Aug to 7 Oct 2026. |
| Plugin (`.obsidian/plugins/plaud-mcp-sync/data.json`) | It's enabled, and its `transcriptFolder` is also `Plaud/Transcripts`. But `autoSyncOnStartup: false`, `lastSuccessfulSyncAt: 2026-06-30`, and `overwriteExisting: false`. It wrote none of these files. |

Recordings from before 28 Aug (back to May) are corrupt too. They were rewritten after 28 Aug by the stub-refetch and repull paths, which call the same `fetchTranscriptSegments`.

## 2. The bug

`backend/services/plaud-sync.js`, `fetchTranscriptSegments` (lines 1583–1610), introduced in `e0f5b8e` on 2026-08-28 ("read the new transcript shape, and follow its pagination"):

```js
const args = offset ? { file_id: id, offset } : { file_id: id };   // line 1589: `offset` is not a parameter
...
const next = offset + batch.length;
if (!Number.isFinite(total) || next >= total) break;               // line 1600: stops on our own counter
offset = next;
```

Live schema: `get_transcript { file_id, block, cursor, limit (1–500, default 50) }`. The description says: "call again with the returned `next_cursor` to fetch the next page."

Probe of `of_b373bdaac13401a8dc4430dcf7a8e971` (total 697):

| Call | Server `offset` | First segment start | `next_cursor` |
|---|---|---|---|
| `{file_id}` | 0 | 880 ms | `eyJvIjo1MH0` (= `{"o":50}`) |
| `{file_id, offset: 50}` | **0** (ignored) | **880 ms** | `eyJvIjo1MH0` |
| `{file_id, cursor: "eyJvIjo1MH0"}` | 50 | 452,630 ms | `eyJvIjoxMDB9` |

So 697 segments means 14 calls of page 1, giving 700 rendered segments covering 00:00–07:26. That matches the file exactly. Across all 145 files, the number of copies equals `ceil(total/50)` without exception.

Why it went unnoticed: the loop stops "on the totals rather than on the cursor alone", so a server that ignored the paging argument looked like a successful paged fetch. The file has the right size and no errors are raised. The client runs `@plaud-ai/mcp@latest`, so the tool's surface can change without any commit on our side. Whether `offset` was ever honoured is unknown; it isn't now.

**A second, related hazard.** `repullStubTranscripts` (and anything else that fetches by the frontmatter `plaud_id`) passes the **bare** id. PLAUD now answers a bare id with `404 Not Found` and only accepts the `of_`-prefixed id that `list_files` returns. The repair must fetch with the API id, never the canonical one.

## 3. Scope of the damage

Scan of every note with `plaud_id` + `type: transcript` (the whole vault except Archive), with each id checked against PLAUD's `total` (`get_transcript` with `limit: 1`, read-only):

| | Count |
|---|---|
| Transcripts in vault | 263 (262 in `Plaud/Transcripts`, 1 in `Meetings/1-2-1`) |
| **Corrupt** (repeated 50-segment block) | **145**, all in `Plaud/Transcripts` |
| Truncated without repeats | 0 |
| Healthy (unique segments = PLAUD total) | 118 (74 of them over 50 segments, all written before 28 Aug) |
| Corrupt, last 60 days (≥ 2026-08-09) | 84 |
| Corrupt by recording month | May 1 · Jul 60 · Aug 44 · Sep 28 · Oct 12 |
| Meeting time affected | ~84.9 h |
| No sync-ledger summary path | 5 (listed under the table) |

The matching meeting summaries in `Meetings/` come from PLAUD's own summary of the full recording, so they're unaffected. That's consistent with the brief's observation.

## 4. Tasks and other downstream effects

**Task discovery never reads transcripts.** `action-candidates.shouldSkipPath` rejects everything under `Plaud/` (line 116). Live DB:

- `tasks.origin_path LIKE 'Plaud/%'`: **0**
- `saim_actions` with a `sourcePath` under `Plaud/Transcripts`: **0** (the 68 under `Plaud/` are old `Plaud/Summaries` candidates: 67 rejected, 1 executed)

Tasks link to a recording through its summary note in `Meetings/` (`tasks.origin_path`; there's no recording-id column, but the summary path is a 1:1 join through the sync ledger). Across the 140 corrupt recordings with a summary: **29 tasks (22 done, 7 open)** on 14 recordings, and **640 candidates** (51 executed, 144 superseded, 445 rejected). The table lists them per recording. A transcript-only repair doesn't touch any of these files.

**Other things that do read transcripts:**

| Consumer | Effect today | After repair |
|---|---|---|
| Embeddings / search / chat RAG (368 indexed transcript files) | Semantic search over these meetings only reaches the first 2–10 minutes | The vault hook re-embeds each repaired file (hash change) |
| Entities (3,722 rows from transcripts) | Mention counts are inflated by the repeats (a name in minute 1 counts ×N) and miss everyone who spoke later | Re-extracted on write |
| `knowledge-memory` raw intake / promotion | Reads `Plaud/Transcripts`; signal and excerpts are computed from the repeated fragment | Correct on its next pass |
| `transcript-processor` | Moves `last-1-2-1` forward only; harmless | Not re-run by a transcript-only repair (not needed) |
| **NOVA 1-2-1 transcripts** | **NOVA holds 24 of the corrupt transcripts.** Its extractor matches 1-2-1 actions against transcript text, so it has seen only the opening minutes of those conversations | **Not fixed by a vault repair**: `nova-121-transcripts` skips anything NOVA already knows. Needs either a NOVA-side re-fetch or a one-off "re-offer these 24" path. Your call, and probably a NOVA change |

## 5. Proposed fix (Phase 2), all in `backend/services/plaud-sync.js` on branch `fix/plaud-transcript-paging`

1. **Page by cursor.** Send `{ file_id, cursor: next_cursor }`. Stop when `next_cursor` is absent, or when the collected count reaches `total`. Request `limit: 500` to cut calls ~10× (the schema allows it; I'll verify against the server and fall back to the default if it refuses).
2. **Detect a server that ignores the cursor.** Fail if a page's server-reported `offset` doesn't equal what we've collected, or its first segment repeats one already held. A fetch that can't prove progress throws. It never writes.
3. **Write guard (`assertTranscriptComplete`, pure).** Refuse to write, log `[PlaudSync] REFUSED transcript …` and record the recording as failed (not synced) when any of these hold: unique segments < `total`; any duplicate `(start_time, speaker, content)`; or the last segment's start < 95% of the recording `duration` when known. The duration rule is applied with care: the last utterance legitimately ends a few seconds before the recording does, so it's a ratio on start time, and it's skipped when the duration is unknown. Every write path goes through it: routine sync, repull, and stub-refetch.
4. **Fetch with the API id** (`of_…` from `list_files`) everywhere, never the canonical frontmatter id.
5. **Tests** (`backend/services/plaud-transcript-paging.test.js`):
   - a multi-page mock honouring `cursor` assembles all pages in order with no repeats
   - a mock that **ignores** the cursor (today's server behaviour with `offset`) is refused rather than written. This is the regression test for this exact bug.
   - the guard refuses duplicates, a short count and a short duration
   - mutation-checked against the current `offset` loop
6. No plugin change is needed: it didn't write these files. *Optional, your call:* point the plugin's `transcriptFolder` somewhere other than NEURO's folder, so a manual plugin run can never share a directory with NEURO. `overwriteExisting: false` already stops it clobbering anything.

## 6. Proposed repull plan (Phase 3)

A dedicated **transcript-only** repair, modelled on the existing `repullStubTranscripts`. It deliberately does **not** use `repullPlaudRecordings`, which re-pulls the summary note too and would re-trigger routing and task discovery on intact `Meetings/` notes.

For each of the 145:

- Fetch with the fixed path and run it through the write guard.
- **Dry run first** (`dryRun: true` by default). For each file it reports: path, current segments/coverage → new segments/coverage, and bytes. Downstream notes changed: **none** by construction (only the `## Transcript` section of the `Plaud/Transcripts` file is rewritten; frontmatter, title and the `Summary:` link are kept byte-for-byte).
- On approval:
  1. Copy each file to `Imports/_Backups/plaud-repair-2026-10-08/<same relative path>`.
  2. Rewrite it in place. Same name, same location, so wikilinks keep working.
  3. Fire `vault-hooks.onVaultWrite` so embeddings and entities refresh.
  4. Throttle at the existing 750 ms gap, sequentially.
  5. Write per-file results back into this report.
- **Idempotent.** A second run finds each file complete (unique = total, no repeats) and skips it. I'll show this in a dry run after the real one, which should report `0 to repair`.
- **No duplicate tasks:** see section 4. The repaired files sit under `Plaud/`, which task discovery skips, and no summary note is written. If you want the newly visible text (for example the last 79 minutes of the 7 Oct meeting) **mined** for new commitments, that's a separate, opt-in step. I'd propose: extract candidates from the repaired transcripts; match each against the recording's existing tasks and candidates (shown in the table, including done, rejected and superseded) using `task-dedupe` scoring ≥ 0.85; list only the unmatched ones in this report for your review. Nothing goes into the queue automatically.
- Deploy order: merge the fix → deploy (after checking with nuero-6d) → dry run → your approval → repair.

## 7. Decisions needed from you

1. **Approve Phase 2** (the fix + guard + tests on a branch, for your review before merge).
2. **Repull scope:** all 145, or only the 84 from the last 60 days? I'd recommend all 145. The damage is identical and the older ones are still searched and quoted.
3. **NOVA's 24:** leave them as they are, or add a re-offer path (and/or ask NOVA to re-fetch)?
4. **Mining the recovered text for new tasks:** skip, or do it as the opt-in review list described above?

## Affected recordings (145)

"Covered to" is the last timestamp in the vault file (mm:ss). "Segments" is lines in the file / unique lines / PLAUD's total. "Tasks" and "Candidates" are linked through the recording's summary note in `Meetings/`.

| # | Date | Title | Plaud ID | Duration | Covered to | Segments (file / unique / PLAUD) | Copies | Tasks on summary | Candidates on summary | NOVA holds |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-05-27 | 1 2 1 Luke Scaife | `51a86e6d9b9f797a9e38f3c835150e1a` | 0:34:40 | 18:34 | 100 / 50 / 90 | 2 | — | 1 executed, 15 superseded, 5 rejected | **yes** |
| 2 | 2026-07-01 | Consultation Workplace Adjustments and Onboarding Automation for Digit | `586d81520e3c6a659a6c1f58dab1f8dc` | 0:43:14 | 18:49 | 150 / 50 / 105 | 3 | — | 1 executed | **yes** |
| 3 | 2026-07-01 | Meeting Escalation Framework Onboarding Protection Partner Engagement  | `a1604b65c9e6c597c246e9e4575eaef8` | 0:25:46 | 13:27 | 100 / 50 / 93 | 2 | — | 1 executed | no |
| 4 | 2026-07-01 | Performance Review Zoe Rees Workload Support and KPIs | `9337d924fd193eff66f52dfe512a9e78` | 0:29:33 | 10:51 | 150 / 50 / 121 | 3 | — | 1 executed, 15 superseded, 5 rejected | **yes** |
| 5 | 2026-07-01 | Weekly Meeting Website Backlog and Platform Migration Plan | `94df3ce1ad5389425c0034de3cfdc5c9` | 0:26:51 | 15:02 | 100 / 50 / 94 | 2 | — | 10 rejected, 27 superseded | no |
| 6 | 2026-07-02 | Implementing a Standardized SLA Framework in Jira to Objectively Measu | `18e300dcf17e2d1745fb7a55ff27067d` | 0:26:56 | 09:44 | 200 / 50 / 153 | 4 | — | 1 executed | no |
| 7 | 2026-07-02 | Meeting BYM Cancellation Data Scope Gilbert Media Refresh and Ticket F | `669a0b58eb8b1ccc66b667b66be94f0e` | 0:11:56 | 07:07 | 100 / 50 / 82 | 2 | — | 7 rejected, 12 superseded | no |
| 8 | 2026-07-02 | Meeting Nova AI Performance Feedback Feature Demo Team Changes and Gui | `f10ce41ce2b36da828077ad518213508` | 0:24:17 | 13:20 | 100 / 50 / 100 | 2 | — | 1 executed, 3 superseded, 1 rejected | no |
| 9 | 2026-07-02 | Meeting Role Redefinition and AI Support Strategy for Nova | `b7ce474ab7b5bb13bfee8cf505150299` | 0:21:30 | 17:58 | 100 / 50 / 59 | 2 | — | 3 rejected, 6 superseded | no |
| 10 | 2026-07-02 | Meeting Tribes and Squads Reorganization Customer Centric Discipline K | `9e7e1f3d1a34bb1bf55086ad11dfc71e` | 0:58:00 | 28:08 | 150 / 50 / 113 | 3 | — | 1 rejected | no |
| 11 | 2026-07-03 | Meeting Return to Work Plan Flexible Schedule WFH Approval Childcare a | `be3e0a36661980f0c8c9bec7094c451d` | 0:12:48 | 08:48 | 100 / 50 / 80 | 2 | — | 3 rejected, 4 superseded | no |
| 12 | 2026-07-03 | Meeting Support Team Return to Office Mandate and Performance Improvem | `02e8bfdba066f45501a2d4779ab0e4b2` | 0:24:15 | 05:58 | 200 / 50 / 161 | 4 | — | 1 executed | no |
| 13 | 2026-07-03 | Nick 1 2 1 Meeting Organizational Restructure and Support Team Perform | `9266126ddb9383bba0c7b0d5a11e7077` | 0:58:33 | 17:06 | 200 / 50 / 165 | 4 | 1 done | 2 executed, 24 superseded, 7 rejected | **yes** |
| 14 | 2026-07-03 | Weekly Meeting Flexible Work Role Evolution and Resource Planning | `eccce4b47c45418909836992fc3d1d48` | 0:21:38 | 05:20 | 150 / 50 / 147 | 3 | — | 1 executed, 8 superseded, 4 rejected | no |
| 15 | 2026-07-03 | Weekly Meeting Team Performance Blockers and Sales Updates | `6876fcabcd8351cf7988d3ca4eab68cc` | 0:23:54 | 09:02 | 100 / 50 / 99 | 2 | — | 1 rejected | no |
| 16 | 2026-07-03 | Weekly Meeting Ticket Prioritization and Queue Review | `22d55e0fa79e0ceef16d410cc1838919` | 0:06:37 | 06:28 | 100 / 50 / 51 | 2 | — | 3 rejected, 4 superseded | no |
| 17 | 2026-07-06 | Meeting Squad Structure Customer Care and Team Alignment | `63c195e33f69e2e98c9e700b00fc11dc` | 0:25:19 | 10:41 | 150 / 50 / 133 | 3 | — | 1 executed, 24 superseded, 8 rejected | no |
| 18 | 2026-07-06 | Meeting Ticket Backlog Jira Outage and Integration Blockers | `2bc1f81f20fd7abd23b143097c8b273a` | 0:28:23 | 08:21 | 200 / 50 / 185 | 4 | — | 1 rejected | no |
| 19 | 2026-07-06 | Weekly Meeting Department Updates Lead Generation and Backlog Manageme | `fb7540f1e43d61f5a34c21e72949c586` | 0:16:43 | 07:24 | 150 / 50 / 109 | 3 | — | 1 rejected | no |
| 20 | 2026-07-07 | Meeting Major Customer Ticketing Overhaul Business Critical Escalation | `e708f8736d7007c151491654ffe5a6d0` | 0:31:10 | 08:51 | 200 / 50 / 197 | 4 | — | 1 executed | no |
| 21 | 2026-07-08 | Weekly Meeting Project Backlog Customer Metrics and Development Update | `d47366cc77be1c824fa931f1350984a4` | 0:19:57 | 08:18 | 150 / 50 / 101 | 3 | — | 2 rejected | no |
| 22 | 2026-07-08 | Weekly Meeting Ticket Review and Process Updates | `38bef0a4855dc2c10c21b6cb156e3ea3` | 0:35:05 | 07:07 | 250 / 50 / 227 | 5 | — | 6 rejected | no |
| 23 | 2026-07-09 | Formal Disciplinary Hearing on Overtime Approval Working Time Complian | `8740bcf8105e284b261f0a278f2b4180` | 0:32:04 | 18:32 | 100 / 50 / 78 | 2 | — | — | no |
| 24 | 2026-07-09 | Meeting Email Proofing Workflow Workload Allocation and Comms Feedback | `6c637635cd2155ebd21b784bd1f3e44d` | 0:11:41 | 08:09 | 100 / 50 / 69 | 2 | — | 3 rejected | no |
| 25 | 2026-07-09 | Meeting Reapit Integration Support Tickets and AFE Development | `465457b25568f5db1cad77b74d9fcba2` | 0:42:55 | 11:21 | 200 / 50 / 177 | 4 | — | 3 rejected | no |
| 26 | 2026-07-10 | Customer Consultation Estate Agency Website Issues and Service Failure | `be1238990a0bc2acca6d2fb1c3c762fc` | 0:24:59 | 18:22 | 100 / 50 / 80 | 2 | — | — | no |
| 27 | 2026-07-10 | Team Meeting Service Desk Performance and Ticket Review | `84ebee00902f42f4463fd4a2b0991c5e` | 0:39:41 | 11:06 | 250 / 50 / 210 | 5 | — | — | no |
| 28 | 2026-07-10 | Weekly Meeting Sales Performance Marketing Updates and Departmental St | `25075c7c91dcdcfeeec796caa8dbc3ee` | 0:14:29 | 12:55 | 100 / 50 / 58 | 2 | — | — | no |
| 29 | 2026-07-13 | Monthly Meeting Delivery Status Customer Success and Resource Manageme | `de5286dc196e1fdad49cd55ddb9ab4e8` | 0:34:17 | 14:08 | 150 / 50 / 141 | 3 | — | 4 rejected | no |
| 30 | 2026-07-13 | Weekly Meeting Ticket Queue Review and Blockers | `82832ad2a893af5d6a413ee20ebfd879` | 0:17:18 | 08:33 | 100 / 50 / 93 | 2 | — | — | no |
| 31 | 2026-07-14 | Meeting LSL and EXP Dashboards Prioritization UTC Time Issue and Resou | `3f8dca790fdac9f1a23119ae421b8daf` | 0:09:43 | 07:37 | 100 / 50 / 62 | 2 | — | 1 rejected | no |
| 32 | 2026-07-15 | Consultation Nick Ward Occupational Health Support for ADHD Traits Anx | `a99c61aa5283d71b96910abc7c8d95a3` | 0:20:32 | 10:11 | 100 / 50 / 87 | 2 | — | — | no |
| 33 | 2026-07-15 | Weekly Meeting Invoicing Automation Support Backlog Website Performanc | `dff7856653a79466788ed9e63ce6e391` | 0:30:30 | 09:22 | 150 / 50 / 119 | 3 | — | — | no |
| 34 | 2026-07-16 | Weekly Meeting Team Charters Resource Allocation Jira Consolidation No | `d3da92799e329f12518e36ff71afb582` | 0:35:36 | 10:58 | 150 / 50 / 133 | 3 | — | 4 rejected | no |
| 35 | 2026-07-16 | Weekly Meeting Ticket Backlog Status and Priorities | `4a410b007147f97739f5cd7766f1e9df` | 0:17:49 | 08:13 | 150 / 50 / 115 | 3 | — | — | no |
| 36 | 2026-07-16 | Weekly Meeting Ticket Management Client Issues and Migration Planning | `6791193d66a391eb1a74b9c9390896cc` | 0:19:15 | 15:13 | 100 / 50 / 69 | 2 | — | 8 rejected | no |
| 37 | 2026-07-20 | Meeting Project Pipeline Customer Success Cadence Support Escalations  | `31d32544210b2ef5eb0b2a583173ba8f` | 0:21:21 | 12:24 | 150 / 50 / 107 | 3 | — | 5 rejected | no |
| 38 | 2026-07-20 | Weekly Meeting Ticket Escalations Blockers and Integration Issues | `633f11d2da34937fa81effe2cb1d0990` | 0:17:21 | 07:49 | 100 / 50 / 100 | 2 | — | 3 rejected | no |
| 39 | 2026-07-21 | Meeting Client Risks AFE MVP TPFG Deliverables Support Capacity and On | `2ddd67f1083ff03796876a30184b17f3` | 1:05:59 | 06:06 | 450 / 50 / 429 | 9 | — | 4 rejected | no |
| 40 | 2026-07-22 | Team Meeting KPI Review Ticket Management and Process Improvements | `f15f43b4c66c3a6e4b16d07c0e94268b` | 1:01:21 | 07:24 | 400 / 50 / 352 | 8 | — | 25 rejected | no |
| 41 | 2026-07-22 | Weekly Meeting Project Delivery Customer Success and Technical Support | `66389e9004d2fb64cf2f026f396ad40e` | 0:27:50 | 14:09 | 100 / 50 / 90 | 2 | — | 1 rejected | no |
| 42 | 2026-07-23 | Internal Meeting Role Transition M365 Handover and CRM Feedback | `7bdddaecd7770429c5d35fbd8a915464` | 0:25:40 | 08:30 | 200 / 50 / 165 | 4 | — | 6 rejected | no |
| 43 | 2026-07-23 | Weekly Meeting System Issues Ticket Review and Escalations | `13920d3ef33884e92beb826bb721fe46` | 0:27:48 | 11:01 | 200 / 50 / 151 | 4 | — | 12 rejected | no |
| 44 | 2026-07-23 | Weekly Meeting Team Restructuring Client Management and Cross Departme | `27342a1906f7f72ab2a67067a1959344` | 0:39:58 | 20:57 | 150 / 50 / 115 | 3 | — | 4 rejected | no |
| 45 | 2026-07-27 | Meeting Performance Improvement Plan and Team Management | `56a37f844f30aeab5dd146d9d63784d1` | 0:38:00 | 08:55 | 250 / 50 / 212 | 5 | — | — | no |
| 46 | 2026-07-27 | Meeting Support Onboarding Portal Walkthrough Dashboard Metrics and Pr | `9550e2a2001ddbd35f84abd53eba2e9e` | 0:40:11 | 08:12 | 200 / 50 / 180 | 4 | — | 12 rejected | no |
| 47 | 2026-07-27 | Meeting Ticket Triage Dev Escalations and Customer Follow ups | `76f1f7f74abfde857de7a4c20aa79083` | 0:19:24 | 08:27 | 150 / 50 / 102 | 3 | — | 1 rejected | no |
| 48 | 2026-07-27 | Weekly Meeting Department Updates Performance and Recruitment | `6d479ba7eb5d3bbc63d008b02c07b557` | 0:22:44 | 14:26 | 100 / 50 / 73 | 2 | — | — | no |
| 49 | 2026-07-28 | Meeting At Risk Accounts TPFG Releases Client Escalations QA Process a | `8f0c02b5ff49a755158f68d76b31fe7d` | 1:00:56 | 05:22 | 400 / 50 / 384 | 8 | — | 13 rejected | no |
| 50 | 2026-07-28 | Meeting Squad Models Data Gaps and SLT Alignment | `375a043cfb01cfeafaf91e01c5eb7efe` | 0:13:55 | 11:13 | 100 / 50 / 67 | 2 | — | 2 rejected | no |
| 51 | 2026-07-29 | Accommodation vs Uniform Policy Targeted WFH and Neurodivergent Suppor | `cfab412afc314b9c10f9e2235f494908` | 0:16:55 | 12:48 | 100 / 50 / 82 | 2 | — | — | no |
| 52 | 2026-07-29 | Employee Retention Discussion Addressing Burnout and Systemic Issues | `b57b8a652f13006c9d12a3ade85ab7b1` | 0:31:54 | 13:50 | 150 / 50 / 128 | 3 | — | — | **yes** |
| 53 | 2026-07-29 | Employee Support and Performance Discussion | `cb2b5ec0de0a5f1c439f29350be7d374` | 0:25:42 | 14:35 | 100 / 50 / 89 | 2 | — | — | **yes** |
| 54 | 2026-07-29 | Weekly Meeting AI Analysis Sales Updates and Client Issues | `6db3c1effa6330b04a2c0ec7a2c67f90` | 0:13:15 | 11:16 | 100 / 50 / 65 | 2 | — | 2 rejected | no |
| 55 | 2026-07-29 | Weekly Meeting Ticket Backlog Escalations Zoopla Listing Issue Cancell | `7cc7092cbc1d772fe0744c88d4472be4` | 0:28:02 | 07:18 | 200 / 50 / 173 | 4 | — | — | no |
| 56 | 2026-07-30 | Meeting Trialing Phone First Customer Support | `487ddb0f9176159ce343f34590efb396` | 0:12:45 | 06:49 | 100 / 50 / 94 | 2 | — | 2 rejected | no |
| 57 | 2026-07-30 | Weekly Meeting CRM Release Issues and Ticket Review | `fedce2e026e9f2f55c3bbe4af4150a08` | 0:27:23 | 09:45 | 200 / 50 / 153 | 4 | — | 3 rejected | no |
| 58 | 2026-07-30 | Weekly Meeting Queue Management Ticket Hygiene and Staffing | `2ee37a9a81bfe2b0e8f740cb2e3d0b40` | 0:24:01 | 10:44 | 150 / 50 / 124 | 3 | — | — | no |
| 59 | 2026-07-30 | Workplace Dynamics and Personal Updates | `78dc4b30e8f3f29b06337be1d9ea224b` | 0:39:54 | 10:16 | 200 / 50 / 173 | 4 | — | — | no |
| 60 | 2026-07-31 | Meeting Fine Country Lead Routing and API Issues | `660d7ac094f8cf6c852c709a33dd16a5` | 0:16:22 | 08:48 | 100 / 50 / 85 | 2 | — | 1 rejected | no |
| 61 | 2026-07-31 | Weekly Meeting Team Check in and Ticket Review | `1e73871643f55edca97b49618eeb7af5` | 0:30:45 | 11:09 | 200 / 50 / 168 | 4 | — | 3 rejected | no |
| 62 | 2026-08-10 | Weekly Meeting Departmental Performance and Competitor Strategy | `17c6892d2926cfa95952e1786acaf430` | 0:34:21 | 10:35 | 150 / 50 / 145 | 3 | — | 1 rejected | no |
| 63 | 2026-08-11 | Meeting Experience Enablement Charter Squad Resourcing Ticket Reductio | `08330db9b31c0ce0f18fbd7f5b205d28` | 0:42:10 | 14:17 | 150 / 50 / 128 | 3 | — | 3 rejected, 1 superseded | no |
| 64 | 2026-08-11 | Meeting Experience Enablement Charter Squad Structure Ticket Reduction | `b913bad3a2ed36b8d9bde9cc32ef3c9e` | 0:43:36 | 15:29 | 150 / 50 / 123 | 3 | — | 2 rejected | no |
| 65 | 2026-08-11 | Meeting Lomond Account Status TPFG Priorities Yomdel V2 Deployment Sup | `5ea9877163af2e0616aff282bbc1a721` | 0:50:09 | 09:08 | 300 / 50 / 256 | 6 | — | 21 rejected | no |
| 66 | 2026-08-11 | Meeting Team Feedback Capacity Planning Ticket Ownership and Tooling D | `d26d4b94c9244dd2ad72ed4f240249d8` | 0:31:04 | 20:14 | 100 / 50 / 79 | 2 | — | 5 rejected | no |
| 67 | 2026-08-12 | Meeting Team Performance KPI Revisions WFH Policy Budget and Retention | `29fa63dfa8308e2edaa4b6e2f8256fee` | 0:50:07 | 15:55 | 200 / 50 / 186 | 4 | — | 7 rejected | no |
| 68 | 2026-08-13 | Meeting Support Team Process Overhaul Communication Alignment and Tool | `445c135377a852d20cdc7796c43a2c9e` | 0:58:17 | 27:06 | 150 / 50 / 121 | 3 | — | 9 rejected | no |
| 69 | 2026-08-13 | Weekly Meeting Stand up Feedback and Team Improvement Strategy | `6b40443e6710e108b652a8b2fb725aec` | 0:50:58 | 08:58 | 250 / 50 / 233 | 5 | — | 3 rejected | no |
| 70 | 2026-08-17 | Meeting Event Log Enhancements Ticket Hygiene Lead Routing and Integra | `d5be74d4f288c4ee058243880e914e40` | 0:29:04 | 11:56 | 150 / 50 / 131 | 3 | — | 2 rejected | no |
| 71 | 2026-08-17 | Weekly Meeting Customer Service Improvement Strategy | `7937081e97031c11bd71fb7d15256107` | 0:50:03 | 15:45 | 200 / 50 / 166 | 4 | — | — | no |
| 72 | 2026-08-17 | Weekly Meeting Jira Service Management and Ticketing System Strategy | `6caf84316347453f1f77a0e6213a2fe1` | 1:51:09 | 11:10 | 450 / 50 / 445 | 9 | — | 5 rejected | no |
| 73 | 2026-08-17 | 2026 08 17 Weekly Sync Support Ticket Consolidation Helpdesk Architect | `58c3b0e910e057125087e8aa8d7d534e` | 1:21:11 | 05:33 | 500 / 50 / 495 | 10 | — | — | no |
| 74 | 2026-08-18 | 1 2 1 Meeting Team KPIs Ticket Management AI Tooling and Escalation Wo | `018da2d8158fbdbfa4c0325cb5af42d2` | 1:10:37 | 08:32 | 400 / 50 / 367 | 8 | 4 done | 7 executed, 1 rejected | **yes** |
| 75 | 2026-08-18 | Meeting Team KPIs Ticket Management AI Tooling and Escalation Workflow | `018da2d8158fbdbfa4c0325cb5af42d2` | 1:10:37 | 08:32 | 400 / 50 / 367 | 8 | 4 done | 7 executed, 1 rejected | **yes** |
| 76 | 2026-08-18 | One on One Performance and Productivity Expectations | `3893db5003eec20c19a680097058c8f4` | 0:13:30 | 05:05 | 150 / 50 / 105 | 3 | — | 2 rejected | **yes** |
| 77 | 2026-08-18 | One on One Zoe Rees Performance Review and Development | `1aad302a9725812f59bcfba06d0675d9` | 0:30:10 | 12:39 | 100 / 50 / 98 | 2 | — | 2 rejected | **yes** |
| 78 | 2026-08-18 | Performance Intervention Note Call Handling Deficit and Accountability | `bb7426627d360b97ee343b8f1f6ab22e` | 0:19:33 | 14:12 | 100 / 50 / 68 | 2 | — | — | **yes** |
| 79 | 2026-08-18 | Weekly Meeting Loop API Integration EXP Portal and Customer Issues | `69809ed2319924ff81cf2f34a785b7f7` | 0:27:14 | 08:09 | 250 / 50 / 209 | 5 | — | 5 rejected | no |
| 80 | 2026-08-18 | Weekly Meeting Ticket Status Review and Integration Issues | `537f4884cc7689fdf1114962a0bb5285` | 0:20:07 | 04:15 | 200 / 50 / 154 | 4 | — | — | no |
| 81 | 2026-08-18 | Weekly Meeting TLO Website Crisis Resource Gaps and Client Escalation | `991d348774f0366a8463dc4ced31a25b` | 0:58:48 | 14:20 | 200 / 50 / 195 | 4 | — | 5 rejected | no |
| 82 | 2026-08-19 | 1 2 1 Meeting KPI Review SLA Backlog and AI ClaudeNova Adoption with N | `6f2711bdc5e3ce8b2415f4f6e0cd23bc` | 0:34:07 | 05:55 | 300 / 50 / 253 | 6 | — | — | **yes** |
| 83 | 2026-08-19 | Customer Consultation Nurture Print Deliverability Royal Mail SLA Impr | `5f731b98f7a1469954c185e8f3543817` | 0:20:19 | 13:22 | 100 / 50 / 85 | 2 | — | — | no |
| 84 | 2026-08-19 | Meeting Heidi Powers Performance Review and KPI Discussion | `3727889681820688a055bb37ddde13df` | 0:32:28 | 09:26 | 200 / 50 / 189 | 4 | — | — | **yes** |
| 85 | 2026-08-19 | Meeting Service Packaging Strategy Feature Toggling Limits Custom Bill | `837bcb88a0ccd879496a02ba2fbd0241` | 0:53:15 | 06:20 | 500 / 50 / 491 | 10 | — | 3 rejected | no |
| 86 | 2026-08-19 | Weekly Meeting LeadPro Package Feasibility for Knight Frank | `4dcc9565d4d29b1ad135d5a51db94e75` | 0:36:47 | 07:47 | 300 / 50 / 268 | 6 | — | 21 rejected | no |
| 87 | 2026-08-20 | 1 2 1 Meeting Knowledge Base Initiative SLA Breaches and AI Tool Adopt | `f465a735a4ad8d0a8872a2b1c1c922be` | 0:45:01 | 13:18 | 200 / 50 / 200 | 4 | — | 1 rejected | **yes** |
| 88 | 2026-08-20 | Establishing a New Workflow for Prioritized Maintenance Tickets | `65bf7ce75e89618cb8f1c1f2cd345fcb` | 0:24:21 | 10:12 | 150 / 50 / 119 | 3 | — | — | **yes** |
| 89 | 2026-08-20 | Meeting Communication Workflow and Ticket Management | `2f2ce52d91059e2373901c074161c53e` | 1:09:46 | 11:22 | 400 / 50 / 381 | 8 | — | 2 rejected | no |
| 90 | 2026-08-20 | Meeting New System Overview for Support Feed System and CMS | `ef7b8942e9db2a9157a9d4c3e12d80de` | 0:22:56 | 09:32 | 200 / 50 / 164 | 4 | — | — | no |
| 91 | 2026-08-20 | Meeting One to One Reset on KPIs SLA Compliance Ticket Standardization | `1b05c912fab5bba0bdc29a209182f329` | 0:59:26 | 08:20 | 350 / 50 / 319 | 7 | — | 8 rejected | **yes** |
| 92 | 2026-08-20 | One to One Meeting Maria KPIs Knowledge Base Ownership and AI Support  | `c322b181cb653eb05e26571dac495689` | 0:46:33 | 09:16 | 250 / 50 / 249 | 5 | — | 2 rejected | **yes** |
| 93 | 2026-08-20 | 2026 08 20 1 2 1 Review KPI Redesign and Team Productivity | `4e39c3acc5bf0e7ac4d8031692f6e6a6` | 0:40:38 | 09:49 | 250 / 50 / 226 | 5 | — | — | **yes** |
| 94 | 2026-08-20 | 2026 08 20 Review LSL Ticket Tracker and NHM Data Discrepancies | `f8b4e6efe792ddba72cd8959469fda26` | 0:17:38 | 04:38 | 150 / 50 / 143 | 3 | — | — | no |
| 95 | 2026-08-24 | 1 2 1 Meeting Kayleighs Wellbeing Comms Coverage End Date Onboarding T | `76c7c35c482cc4c75ab9dec962336a32` | 1:08:59 | 11:24 | 300 / 50 / 283 | 6 | — | 8 rejected | **yes** |
| 96 | 2026-08-24 | Support Process Meeting Ticket Ownership Routing and Escalation | `3c39671e18ff71b6d5f34478bdbfe329` | 1:29:52 | 11:34 | 450 / 50 / 426 | 9 | — | 14 rejected | no |
| 97 | 2026-08-25 | Performance Review Nick Ward and Nathan Rutland on KPIs Team Performan | `328e42f448cbe1d8c532d430f05c9779` | 0:54:40 | 10:45 | 300 / 50 / 277 | 6 | — | — | **yes** |
| 98 | 2026-08-25 | Post Incident Review of Failed Jobs Process Breakdown and New Operatin | `b3e5b8a68bc82401daefe9d65ce1340a` | 0:10:18 | 09:44 | 100 / 50 / 53 | 2 | — | — | no |
| 99 | 2026-08-25 | Weekly Meeting Bug Fixes Ticket Status and Integrations | `cf85e97b173e9937b4099d4864eaeeea` | 0:23:26 | 06:46 | 150 / 50 / 150 | 3 | — | 1 superseded | no |
| 100 | 2026-08-25 | Weekly Meeting Employee Well being Burnout and Performance Review | `3ba0910988a1e7f45ea6c42956db6242` | 0:46:00 | 14:06 | 150 / 50 / 121 | 3 | — | 4 rejected | no |
| 101 | 2026-08-25 | 2026 08 25 Performance Review Isabel Busk KPIs Workflows and Operation | `05c90384b8b342d976f683bde0f25eb1` | 0:28:40 | 07:43 | 200 / 50 / 167 | 4 | — | — | **yes** |
| 102 | 2026-08-25 | 2026 08 25 Weekly Sync Client Risks and Platform Governance | `1dedc89aaa7e714f4763fce8adbe6a2b` | 0:53:21 | 07:00 | 350 / 50 / 312 | 7 | — | — | no |
| 103 | 2026-08-26 | Meeting WhatsApp Integration Omnichannel Journeys Pricing Strategy and | `of_adcfa8c1ed03d05c976da1c68ff7fbb9` | 0:22:09 | 10:55 | 150 / 50 / 149 | 3 | — | — | no |
| 104 | 2026-08-26 | Sprint Forecast Meeting Team Updates Process Feedback and Project Spik | `61cdcb3d1ae531a3b8c406841b7d1cc1` | 0:31:06 | 06:16 | 200 / 50 / 197 | 4 | — | 3 rejected | no |
| 105 | 2026-08-27 | Weekly Meeting Ticket Review Development Blockers and Process Improvem | `75c13291ae3a80a06ad6850f048f9e1f` | 0:41:56 | 08:04 | 350 / 50 / 301 | 7 | — | 13 rejected | no |
| 106 | 2026-09-01 | Meeting LeadPro Strategy Client Risks IVT Issues and MobileApp Roadmap | `c992588e643c90ca10bed833f27b010d` | 0:57:34 | 07:05 | 500 / 50 / 499 | 10 | — | 4 rejected | no |
| 107 | 2026-09-01 | Weekly Meeting Ticket Health AI Integration and Team Performance | `of_72165d8ac64feab88e7709545eff00a2` | 1:04:12 | 08:41 | 400 / 50 / 352 | 8 | — | — | no |
| 108 | 2026-09-02 | Meeting Support Team Performance Morale Knowledge Base Updates Budget  | `81ca0bef53ec0ec37e2a3b05933d36ea` | 0:28:15 | 12:49 | 150 / 50 / 113 | 3 | — | 2 rejected | no |
| 109 | 2026-09-02 | Meeting WFH Policy Performance and Employee Accommodations | `of_2e0503f40e4c6e460c7db690fe9cd65c` | 1:01:31 | 08:53 | 350 / 50 / 339 | 7 | — | — | no |
| 110 | 2026-09-02 | Systemic HR Failure Unresolved Flexible Work Request Creates Legal Ris | `e8380e111e2e7fad4204872d4b14973f` | 0:09:19 | 07:33 | 100 / 50 / 64 | 2 | — | — | no |
| 111 | 2026-09-02 | Weekly Meeting Claude MCPs for Support Team | `of_7b3f3658f04fdceee0d4356be623fd37` | 0:34:34 | 10:37 | 250 / 50 / 235 | 5 | — | — | no |
| 112 | 2026-09-04 | Internal Partner Meetings on Workload Services and Personal Matters | `of_85c7436a07048b47e208db73abc7409c` | 0:32:41 | 12:26 | 200 / 50 / 163 | 4 | — | — | no |
| 113 | 2026-09-04 | Meeting Return to Work Workload and Career Path | `dc8ae471cc1c8339601f14c007608f43` | 0:20:15 | 09:01 | 150 / 50 / 118 | 3 | — | 1 rejected | no |
| 114 | 2026-09-05 | Medical Consultation Chronic Headaches and Neurological Symptoms | `4d0827de3b27c5a7c2e92808a8b186a4` | 0:19:29 | 06:37 | 150 / 50 / 140 | 3 | — | — | no |
| 115 | 2026-09-07 | Tech Leadship Meeting Ticket Volume SLAs and TPJ Issues | `523a9f96bc1fbae257bb1ae65f9f7a87` | 1:55:48 | 06:41 | 650 / 50 / 605 | 13 | — | 1 executed, 8 rejected | no |
| 116 | 2026-09-08 | Consultation Nick Ward Postal Pricing and Service Reliability | `4ee1152d870dd54856e994c76f8f229e` | 0:14:47 | 13:03 | 100 / 50 / 63 | 2 | — | — | no |
| 117 | 2026-09-08 | Meeting Data Sync History Scope Concerns and Compliance Risks | `3cfce28aea96b154bcab460f4ae2a819` | 0:30:29 | 10:36 | 150 / 50 / 141 | 3 | — | 1 executed, 2 rejected | no |
| 118 | 2026-09-08 | Meeting Support Team Performance Scope Definition AI Adoption and Orga | `41398094581f2599521918ba483e3fc2` | 1:20:15 | 07:12 | 400 / 50 / 376 | 8 | — | 9 rejected | no |
| 119 | 2026-09-08 | Weekly Meeting Integrations Account Risks and Process Gaps | `221e01b9a0f7ad384cf16d0da1a3fd91` | 0:37:28 | 07:42 | 300 / 50 / 276 | 6 | — | 7 rejected | no |
| 120 | 2026-09-13 | Consultation Nick Ward Multifocal Contact Lens Fitting Astigmatism and | `d9abe8a0a4ca5fd1b0e66f664256534f` | 0:22:30 | 08:09 | 150 / 50 / 135 | 3 | — | 2 rejected | no |
| 121 | 2026-09-14 | Weekly Meeting Sprint Planning Reporting Issues and Platform Strategy | `a9bf223d6fa5587fd07b3f2f485878b8` | 0:51:02 | 12:19 | 300 / 50 / 280 | 6 | 1 done | 13 rejected, 1 executed | no |
| 122 | 2026-09-17 | 1 2 1 Meeting AI Driven Ticket Management KPI Review and Escalation Pr | `a78a9afe2373c0f1ad25248fd78e3683` | 0:19:04 | 07:15 | 150 / 50 / 123 | 3 | — | — | no |
| 123 | 2026-09-17 | 1 2 1 Meeting Call Handling Balance QANova Scoring AI Claude Adoption  | `bbc5acb8548b2c8ebbf8fb32f9a48847` | 0:41:32 | 09:43 | 250 / 50 / 218 | 5 | 2 done | 7 rejected, 2 executed | **yes** |
| 124 | 2026-09-17 | 1 2 1 Meeting Team Sentiment AI in Support Workflow Ticket KPIs QA Rev | `61c70d6a9dd25ed84118bc043a023d88` | 0:23:31 | 07:55 | 200 / 50 / 164 | 4 | 1 done | 4 rejected, 1 executed | **yes** |
| 125 | 2026-09-17 | Meeting Tier 2 SLA Improvements QA Refinements AI in Tickets Policy an | `bc48dc9e3cd8210c6eb1602fa5c05d3b` | 0:40:56 | 10:07 | 250 / 50 / 222 | 5 | — | 3 rejected, 3 executed | **yes** |
| 126 | 2026-09-17 | Weekly Meeting AI in Support and Customer Care Ticket Prioritization | `0d10621612f3304d8b8eeec8103269f9` | 0:34:12 | 07:22 | 250 / 50 / 236 | 5 | 1 done | 4 rejected, 1 executed | no |
| 127 | 2026-09-18 | Meeting Support Operations Performance Call Routing Issues SLA Complia | `38c1ff5ec99245b470ae064a1cfd2cf2` | 0:38:47 | 09:20 | 300 / 50 / 256 | 6 | 2 done, 2 open | 4 executed | no |
| 128 | 2026-09-21 | Meeting Cancelled Customer Instance Remediation | `3e8e8a36fc866c1195d196644880bfc5` | 0:19:43 | 12:05 | 150 / 50 / 103 | 3 | 1 done | 1 executed | no |
| 129 | 2026-09-21 | Weekly Meeting Ticket Queue Management and System Issues | `5965df882010590fe0e5510b6dd77ba6` | 0:49:22 | 06:54 | 250 / 50 / 247 | 5 | 2 done | 2 executed | no |
| 130 | 2026-09-28 | Daily Stand up Ticket Review and Blockers | `2e2122a15d856617416465d18e3471af` | 0:24:43 | 06:16 | 200 / 50 / 177 | 4 | — | — | no |
| 131 | 2026-09-28 | Tech Leadership Team Meeting Sprint Planning TPJ Support Resourcing an | `731be35d279479229c905f12396309e6` | 0:32:35 | 08:23 | 250 / 50 / 214 | 5 | — | — | no |
| 132 | 2026-09-29 | Daily Stand Up Technical Issues Integrations and Ticket Review | `3a4a084ee603fe1144f14a09ef766961` | 0:21:13 | 09:30 | 150 / 50 / 119 | 3 | — | 10 rejected | no |
| 133 | 2026-09-29 | Weekly Meeting At Risk Customers AFE Adoption and Project Status | `5a45abd2b3db606e927affc3aa5f6c3f` | 0:42:02 | 03:42 | 500 / 50 / 480 | 10 | — | — | no |
| 134 | 2026-10-01 | Daily Standup Ticket Backlog Reduction Blockers TPJTPFGAlto SharePoint | `5892cde2b756fc11c52dc2f1e178200d` | 0:24:06 | 08:48 | 150 / 50 / 139 | 3 | — | — | no |
| 135 | 2026-10-02 | Daily Standup Nova Deployment KPIs CIJIRA Process Data Feed Blockages  | `d26505b74476a6c0b8823ead49143435` | 0:46:03 | 06:47 | 300 / 50 / 288 | 6 | 1 open | 1 executed, 12 rejected | no |
| 136 | 2026-10-02 | Support Leadership Meeting Guide Creation Team Performance and Ticket  | `f028c119b31186979e3134cb4ab92eb0` | 0:40:12 | 06:32 | 300 / 50 / 295 | 6 | — | — | no |
| 137 | 2026-10-02 | Weekly KPI Meeting Dev Ticket Escalations GDPR Unsubscribe Risk Billin | `ea2112d4610b5601ef93fb25625843d6` | 0:26:41 | 07:49 | 200 / 50 / 176 | 4 | — | — | no |
| 138 | 2026-10-05 | Meeting Client Communication Issue Tracking and Technical Challenges | `19742f733a4ddebbaed83f031714ca22` | 0:08:36 | 07:38 | 100 / 50 / 60 | 2 | 2 done | 2 executed, 1 rejected | no |
| 139 | 2026-10-05 | Meeting Onboarding Automation Alignment CRM Orchestration Instance Set | `0b4c1678bff8bbc45249395d33e37ba9` | 0:16:52 | 09:01 | 100 / 50 / 84 | 2 | — | 1 rejected | no |
| 140 | 2026-10-05 | The London Office Meeting Feed Processing Delays Support Backlog Sprin | `071a500274e2f64193c400e82cef9fad` | 0:35:13 | 07:10 | 250 / 50 / 243 | 5 | — | — | no |
| 141 | 2026-10-05 | Weekly Meeting Support Performance Dependency Tech Leadership Meeting  | `b382e909f267bd7c94a55eece5ad84aa` | 0:45:47 | 16:30 | 250 / 50 / 245 | 5 | — | — | no |
| 142 | 2026-10-06 | Daily Standup Round Robin Assignment Fixes HR Alignment Ticket Hygiene | `e61a5033455de609aed8ae4a97ae7052` | 0:27:42 | 04:30 | 300 / 50 / 255 | 6 | 1 done | 1 executed | no |
| 143 | 2026-10-06 | Risk Meeting Risk Register Overhaul Customer Escalations and CRM Strat | `f409a69f2ec46c0a1287866959090079` | 0:24:37 | 04:43 | 350 / 50 / 303 | 7 | — | 8 rejected | no |
| 144 | 2026-10-06 | 2026 10 06 Incident Briefing Property feed and My Account Outage | `14f79d8652e38dfa5e5f1b935fd02d5f` | 0:21:31 | 05:34 | 200 / 50 / 194 | 4 | — | 3 rejected | no |
| 145 | 2026-10-07 | Support Teams Consolidation Meeting Jira Support Unification Intellige | `b373bdaac13401a8dc4430dcf7a8e971` | 1:26:29 | 07:26 | 700 / 50 / 697 | 14 | 4 open | 1 rejected, 4 executed | no |

**No summary path in the sync ledger (5):** these transcripts are in the vault but have no `summaryRelativePath`, so no task linkage was computed. They'll be repaired the same way.
- `Plaud/Transcripts/2026-08-26 08-26-Meeting-WhatsApp-Integration-Omnichannel-Journeys-Pricing-Strategy-and-Legal-Marketing-Compliance.md`
- `Plaud/Transcripts/2026-09-01 09-01-Weekly-Meeting-Ticket-Health-AI-Integration-and-Team-Performance.md`
- `Plaud/Transcripts/2026-09-02 09-02-Meeting-WFH-Policy-Performance-and-Employee-Accommodations.md`
- `Plaud/Transcripts/2026-09-02 09-02-Weekly-Meeting-Claude-MCPs-for-Support-Team.md`
- `Plaud/Transcripts/2026-09-04 09-04-Internal-Partner-Meetings-on-Workload-Services-and-Personal-Matters.md`

## Method (reproducible, read-only)

- Vault scan: a regex over `**Speaker** \`mm:ss\`  text` lines, counting total, unique and copies of the first line.
- PLAUD: `list_files` (all pages) for ids and durations, plus `get_transcript {file_id, limit: 1}` for `total`, on pi5 through the same `npx @plaud-ai/mcp@latest` the sync uses. The output was metadata only; no transcript text was printed.
- DB: `better-sqlite3` opened `readonly` against `/mnt/data/nuero/backend/db/agent.db`.
- The scripts are in `/tmp/plaud-*.{js,mjs}` on pi5 and in the session scratchpad. None of them were placed in the repo.

---

## Phase 2 status (2026-10-08): built, committed locally, not merged or deployed

Your decisions: (1) Phase 2 yes; (2) repull **all 145**; (3) **one-off re-send** to NOVA; (4) **review list** for new task suggestions.

| Repo | Branch / commit | What |
|---|---|---|
| NEURO (worktree `C:\Users\NickW\Claude\nuero-plaud`) | `fix/plaud-transcript-paging` @ `15c66eb` (off `f0901b9`) | Cursor paging, guards, h:mm:ss, stub-refetch `of_` id, repair script, NOVA correction sweep, tests |
| NOVA (worktree `...\windows automation\daypilot-121-transcript`) | `fix/121-transcript-correction` @ `4432d0c` (off `nova-codex` `873bc3d`) | `POST /api/neuro-bridge/121/transcript-correction` + pure `assessCorrection` + tests |

**Verified**
- Live PLAUD, fixed fetch on `of_b373…`: **697 segments, 697 unique, to `1:26:24` "Yeah. Thank you. Bye."**
- NEURO: 13 new tests. Five guards mutation-checked: offset paging, advance check, repeat check, short total, hour format. Full suite on a pi5 scratch tree built from `git archive`: **5,768 tests with 1 failure, the same failure as on base `f0901b9`** (MCP gateway vs authority matrix, which is pre-existing and not mine).
- NOVA: 7 tests. The same-recording rule is mutation-checked. Server type-check is clean for the touched files (the rest of the local NOVA tree lacks `@azure/msal-node` and `@anthropic-ai/sdk`, which is pre-existing).

**Two deviations from the brief, both measured:**
- **Duration guard.** A hard 95% rule would refuse 16 of the 118 healthy transcripts. So under 95% only logs, and the hard refusals are the exact ones (count = PLAUD total, no repeats) plus under 50% on a recording of at least 10 minutes.
- **Backups go to `Scripts/.lint-backups/plaud-repair-<date>/`, not `Imports/_Backups/`.** The import pipeline walks `Imports/` recursively and would route all 145 copies back in as new notes.

**NOVA detail.** Of the 24 corrupt transcripts NOVA holds, 18 are approved and 6 rejected. Rejected ones are never read. Pending ones refresh themselves on the next normal sweep once the vault is repaired. NOVA's extractor de-duplicates actions on the **exact** description only, so the correction **does not re-extract**: re-reading the full text would reword and duplicate existing actions. Whether to mine those 18 for new NOVA actions is a separate question for later, through a review list, never automatic.

### Remaining steps (each needs your go-ahead)
1. **Review and merge** `fix/plaud-transcript-paging` → deploy NEURO to pi5. Build 23 (nuero-6d) is deploying now; I'll wait for its all-clear.
2. **Phase 3 dry run** on the Pi: `node scripts/plaud-repair-transcripts.js --out /tmp/plaud-repair-dry.json`. Reads PLAUD and the vault, writes nothing. The per-file before/after goes into this report.
3. **Apply** after your approval (`--apply`), then a second dry run to prove `found 0`.
4. **NOVA:** merge `fix/121-transcript-correction` into `nova-codex` and deploy (`-Branch nova-codex`, from azdo). The `package.json` version bump is left for merge time, to avoid colliding with other NOVA branches. Then `node scripts/nova-transcript-corrections.js` (dry run) → `--apply`.
5. **Review list (decision 4):** extract candidate commitments from the repaired transcripts, match them against each recording's existing tasks and candidates (done, rejected and superseded included), and list only the unmatched ones here. Nothing is queued.

---

## Phase 3 dry run (2026-10-08 15:09, pi5, code at `2d402b3`)

`node scripts/plaud-repair-transcripts.js --out /tmp/plaud-repair-dry.json`: read-only against the vault and PLAUD. The PLAUD run lock was taken and released (`running: false` afterwards).

| | Result |
|---|---|
| Found / scanned | 145 / 145 |
| Would repair | **145** |
| Refused by the guard | 0 |
| Failed | 0 |
| Repaired segment count = PLAUD `total`, no repeats | 145 / 145 |
| Coverage (last utterance ÷ duration) | min 0.968 · p10 0.984 · median 0.996 · none under 0.95 |
| Size | 5.4 MB → 4.8 MB (the repeats removed) |
| Downstream notes changed | none (only the segment lines of each `Plaud/Transcripts` file) |
| Backups (on apply) | `Scripts/.lint-backups/plaud-repair-2026-10-08/` |

| # | File | Before (lines / unique, to) | After (lines, to) | Coverage |
|---|---|---|---|---|
| 1 | 2026-05-27 05-27-1-2-1-Luke-Scaife | 100 / 50, 18:34 | 90, 34:28 | 0.995 |
| 2 | 2026-07-01 07-01-Consultation-Workplace-Adjustments-and-Onboarding-Automation-fo | 150 / 50, 18:49 | 105, 42:52 | 0.992 |
| 3 | 2026-07-01 07-01-Meeting-Escalation-Framework-Onboarding-Protection-Partner-Enga | 100 / 50, 13:27 | 93, 25:37 | 0.994 |
| 4 | 2026-07-01 07-01-Performance-Review-Zoe-Rees-Workload-Support-and-KPIs | 150 / 50, 10:51 | 121, 29:25 | 0.996 |
| 5 | 2026-07-01 07-01-Weekly-Meeting-Website-Backlog-and-Platform-Migration-Plan | 100 / 50, 15:02 | 94, 26:24 | 0.984 |
| 6 | 2026-07-02 07-02-Implementing-a-Standardized-SLA-Framework-in-Jira-to-Objectivel | 200 / 50, 09:44 | 153, 26:52 | 0.998 |
| 7 | 2026-07-02 07-02-Meeting-BYM-Cancellation-Data-Scope-Gilbert-Media-Refresh-and-T | 100 / 50, 07:07 | 82, 11:49 | 0.99 |
| 8 | 2026-07-02 07-02-Meeting-Nova-AI-Performance-Feedback-Feature-Demo-Team-Changes- | 100 / 50, 13:20 | 100, 24:12 | 0.997 |
| 9 | 2026-07-02 07-02-Meeting-Role-Redefinition-and-AI-Support-Strategy-for-Nova | 100 / 50, 17:58 | 59, 21:29 | 0.999 |
| 10 | 2026-07-02 07-02-Meeting-Tribes-and-Squads-Reorganization-Customer-Centric-Disci | 150 / 50, 28:08 | 113, 57:05 | 0.984 |
| 11 | 2026-07-03 07-03-Meeting-Return-to-Work-Plan-Flexible-Schedule-WFH-Approval-Chil | 100 / 50, 08:48 | 80, 12:42 | 0.993 |
| 12 | 2026-07-03 07-03-Meeting-Support-Team-Return-to-Office-Mandate-and-Performance-I | 200 / 50, 05:58 | 161, 24:10 | 0.997 |
| 13 | 2026-07-03 07-03-Nick-1-2-1-Meeting-Organizational-Restructure-and-Support-Team- | 200 / 50, 17:06 | 165, 58:19 | 0.996 |
| 14 | 2026-07-03 07-03-Weekly-Meeting-Flexible-Work-Role-Evolution-and-Resource-Planni | 150 / 50, 05:20 | 147, 21:31 | 0.995 |
| 15 | 2026-07-03 07-03-Weekly-Meeting-Team-Performance-Blockers-and-Sales-Updates | 100 / 50, 09:02 | 99, 23:26 | 0.981 |
| 16 | 2026-07-03 07-03-Weekly-Meeting-Ticket-Prioritization-and-Queue-Review | 100 / 50, 06:28 | 51, 06:30 | 0.983 |
| 17 | 2026-07-06 07-06-Meeting-Squad-Structure-Customer-Care-and-Team-Alignment | 150 / 50, 10:41 | 133, 25:14 | 0.997 |
| 18 | 2026-07-06 07-06-Meeting-Ticket-Backlog-Jira-Outage-and-Integration-Blockers | 200 / 50, 08:21 | 185, 28:18 | 0.997 |
| 19 | 2026-07-06 07-06-Weekly-Meeting-Department-Updates-Lead-Generation-and-Backlog-M | 150 / 50, 07:24 | 109, 16:37 | 0.994 |
| 20 | 2026-07-07 07-07-Meeting-Major-Customer-Ticketing-Overhaul-Business-Critical-Esc | 200 / 50, 08:51 | 197, 31:08 | 0.999 |
| 21 | 2026-07-08 07-08-Weekly-Meeting-Project-Backlog-Customer-Metrics-and-Development | 150 / 50, 08:18 | 101, 19:51 | 0.996 |
| 22 | 2026-07-08 07-08-Weekly-Meeting-Ticket-Review-and-Process-Updates | 250 / 50, 07:07 | 227, 34:57 | 0.996 |
| 23 | 2026-07-09 07-09-Formal-Disciplinary-Hearing-on-Overtime-Approval-Working-Time-C | 100 / 50, 18:32 | 78, 31:21 | 0.978 |
| 24 | 2026-07-09 07-09-Meeting-Email-Proofing-Workflow-Workload-Allocation-and-Comms-F | 100 / 50, 08:09 | 69, 11:36 | 0.994 |
| 25 | 2026-07-09 07-09-Meeting-Reapit-Integration-Support-Tickets-and-AFE-Development | 200 / 50, 11:21 | 177, 42:34 | 0.992 |
| 26 | 2026-07-10 07-10-Customer-Consultation-Estate-Agency-Website-Issues-and-Service- | 100 / 50, 18:22 | 80, 24:53 | 0.996 |
| 27 | 2026-07-10 07-10-Team-Meeting-Service-Desk-Performance-and-Ticket-Review | 250 / 50, 11:06 | 210, 39:06 | 0.985 |
| 28 | 2026-07-10 07-10-Weekly-Meeting-Sales-Performance-Marketing-Updates-and-Departme | 100 / 50, 12:55 | 58, 14:24 | 0.994 |
| 29 | 2026-07-13 07-13-Monthly-Meeting-Delivery-Status-Customer-Success-and-Resource-M | 150 / 50, 14:08 | 141, 34:02 | 0.993 |
| 30 | 2026-07-13 07-13-Weekly-Meeting-Ticket-Queue-Review-and-Blockers | 100 / 50, 08:33 | 93, 17:07 | 0.99 |
| 31 | 2026-07-14 07-14-Meeting-LSL-and-EXP-Dashboards-Prioritization-UTC-Time-Issue-an | 100 / 50, 07:37 | 62, 09:37 | 0.991 |
| 32 | 2026-07-15 07-15-Consultation-Nick-Ward-Occupational-Health-Support-for-ADHD-Tra | 100 / 50, 10:11 | 87, 20:27 | 0.997 |
| 33 | 2026-07-15 07-15-Weekly-Meeting-Invoicing-Automation-Support-Backlog-Website-Per | 150 / 50, 09:22 | 119, 30:22 | 0.996 |
| 34 | 2026-07-16 07-16-Weekly-Meeting-Team-Charters-Resource-Allocation-Jira-Consolida | 150 / 50, 10:58 | 133, 35:30 | 0.998 |
| 35 | 2026-07-16 07-16-Weekly-Meeting-Ticket-Backlog-Status-and-Priorities | 150 / 50, 08:13 | 115, 17:17 | 0.971 |
| 36 | 2026-07-16 07-16-Weekly-Meeting-Ticket-Management-Client-Issues-and-Migration-Pl | 100 / 50, 15:13 | 69, 19:08 | 0.994 |
| 37 | 2026-07-20 07-20-Meeting-Project-Pipeline-Customer-Success-Cadence-Support-Escal | 150 / 50, 12:24 | 107, 21:13 | 0.994 |
| 38 | 2026-07-20 07-20-Weekly-Meeting-Ticket-Escalations-Blockers-and-Integration-Issu | 100 / 50, 07:49 | 100, 16:56 | 0.977 |
| 39 | 2026-07-21 07-21-Meeting-Client-Risks-AFE-MVP-TPFG-Deliverables-Support-Capacity | 450 / 50, 06:06 | 429, 1:05:45 | 0.997 |
| 40 | 2026-07-22 07-22-Team-Meeting-KPI-Review-Ticket-Management-and-Process-Improveme | 400 / 50, 07:24 | 352, 1:01:18 | 0.999 |
| 41 | 2026-07-22 07-22-Weekly-Meeting-Project-Delivery-Customer-Success-and-Technical- | 100 / 50, 14:09 | 90, 27:45 | 0.998 |
| 42 | 2026-07-23 07-23-Internal-Meeting-Role-Transition-M365-Handover-and-CRM-Feedback | 200 / 50, 08:30 | 165, 25:35 | 0.997 |
| 43 | 2026-07-23 07-23-Weekly-Meeting-System-Issues-Ticket-Review-and-Escalations | 200 / 50, 11:01 | 151, 27:46 | 0.999 |
| 44 | 2026-07-23 07-23-Weekly-Meeting-Team-Restructuring-Client-Management-and-Cross-D | 150 / 50, 20:57 | 115, 39:43 | 0.994 |
| 45 | 2026-07-27 07-27-Meeting-Performance-Improvement-Plan-and-Team-Management | 250 / 50, 08:55 | 212, 37:56 | 0.998 |
| 46 | 2026-07-27 07-27-Meeting-Support-Onboarding-Portal-Walkthrough-Dashboard-Metrics | 200 / 50, 08:12 | 180, 40:03 | 0.997 |
| 47 | 2026-07-27 07-27-Meeting-Ticket-Triage-Dev-Escalations-and-Customer-Follow-ups | 150 / 50, 08:27 | 102, 19:11 | 0.989 |
| 48 | 2026-07-27 07-27-Weekly-Meeting-Department-Updates-Performance-and-Recruitment | 100 / 50, 14:26 | 73, 22:30 | 0.99 |
| 49 | 2026-07-28 07-28-Meeting-At-Risk-Accounts-TPFG-Releases-Client-Escalations-QA-Pr | 400 / 50, 05:22 | 384, 1:00:51 | 0.999 |
| 50 | 2026-07-28 07-28-Meeting-Squad-Models-Data-Gaps-and-SLT-Alignment | 100 / 50, 11:13 | 67, 13:40 | 0.983 |
| 51 | 2026-07-29 07-29-Accommodation-vs-Uniform-Policy-Targeted-WFH-and-Neurodivergent | 100 / 50, 12:48 | 82, 16:53 | 0.998 |
| 52 | 2026-07-29 07-29-Employee-Retention-Discussion-Addressing-Burnout-and-Systemic-I | 150 / 50, 13:50 | 128, 31:49 | 0.998 |
| 53 | 2026-07-29 07-29-Employee-Support-and-Performance-Discussion | 100 / 50, 14:35 | 89, 25:14 | 0.982 |
| 54 | 2026-07-29 07-29-Weekly-Meeting-AI-Analysis-Sales-Updates-and-Client-Issues | 100 / 50, 11:16 | 65, 13:12 | 0.997 |
| 55 | 2026-07-29 07-29-Weekly-Meeting-Ticket-Backlog-Escalations-Zoopla-Listing-Issue- | 200 / 50, 07:18 | 173, 27:49 | 0.992 |
| 56 | 2026-07-30 07-30-Meeting-Trialing-Phone-First-Customer-Support | 100 / 50, 06:49 | 94, 12:41 | 0.996 |
| 57 | 2026-07-30 07-30-Weekly-Meeting-CRM-Release-Issues-and-Ticket-Review | 200 / 50, 09:45 | 153, 27:09 | 0.992 |
| 58 | 2026-07-30 07-30-Weekly-Meeting-Queue-Management-Ticket-Hygiene-and-Staffing | 150 / 50, 10:44 | 124, 23:42 | 0.987 |
| 59 | 2026-07-30 07-30-Workplace-Dynamics-and-Personal-Updates | 200 / 50, 10:16 | 173, 39:39 | 0.994 |
| 60 | 2026-07-31 07-31-Meeting-Fine-Country-Lead-Routing-and-API-Issues | 100 / 50, 08:48 | 85, 16:16 | 0.994 |
| 61 | 2026-07-31 07-31-Weekly-Meeting-Team-Check-in-and-Ticket-Review | 200 / 50, 11:09 | 168, 30:36 | 0.995 |
| 62 | 2026-08-10 08-10-Weekly-Meeting-Departmental-Performance-and-Competitor-Strategy | 150 / 50, 10:35 | 145, 34:14 | 0.997 |
| 63 | 2026-08-11 08-11-Meeting-Experience-Enablement-Charter-Squad-Resourcing-Ticket-R | 150 / 50, 14:17 | 128, 41:59 | 0.996 |
| 64 | 2026-08-11 08-11-Meeting-Experience-Enablement-Charter-Squad-Structure-Ticket-Re | 150 / 50, 15:29 | 123, 43:25 | 0.996 |
| 65 | 2026-08-11 08-11-Meeting-Lomond-Account-Status-TPFG-Priorities-Yomdel-V2-Deploym | 300 / 50, 09:08 | 256, 50:03 | 0.998 |
| 66 | 2026-08-11 08-11-Meeting-Team-Feedback-Capacity-Planning-Ticket-Ownership-and-To | 100 / 50, 20:14 | 79, 30:49 | 0.992 |
| 67 | 2026-08-12 08-12-Meeting-Team-Performance-KPI-Revisions-WFH-Policy-Budget-and-Re | 200 / 50, 15:55 | 186, 50:05 | 1 |
| 68 | 2026-08-13 08-13-Meeting-Support-Team-Process-Overhaul-Communication-Alignment-a | 150 / 50, 27:06 | 121, 58:07 | 0.997 |
| 69 | 2026-08-13 08-13-Weekly-Meeting-Stand-up-Feedback-and-Team-Improvement-Strategy | 250 / 50, 08:58 | 233, 50:57 | 1 |
| 70 | 2026-08-17 08-17-Meeting-Event-Log-Enhancements-Ticket-Hygiene-Lead-Routing-and- | 150 / 50, 11:56 | 131, 28:51 | 0.993 |
| 71 | 2026-08-17 08-17-Weekly-Meeting-Customer-Service-Improvement-Strategy | 200 / 50, 15:45 | 166, 49:54 | 0.997 |
| 72 | 2026-08-17 08-17-Weekly-Meeting-Jira-Service-Management-and-Ticketing-System-Str | 450 / 50, 11:10 | 445, 1:50:54 | 0.998 |
| 73 | 2026-08-17 Weekly-Sync-Support-Ticket-Consolidation-Helpdesk-Architectural-Revie | 500 / 50, 05:33 | 495, 1:21:10 | 1 |
| 74 | 2026-08-18 08-18-1-2-1-Meeting-Team-KPIs-Ticket-Management-AI-Tooling-and-Escala | 400 / 50, 08:32 | 367, 1:10:05 | 0.993 |
| 75 | 2026-08-18 08-18-Meeting-Team-KPIs-Ticket-Management-AI-Tooling-and-Escalation-W | 400 / 50, 08:32 | 367, 1:10:05 | 0.993 |
| 76 | 2026-08-18 08-18-One-on-One-Performance-and-Productivity-Expectations | 150 / 50, 05:05 | 105, 13:17 | 0.984 |
| 77 | 2026-08-18 08-18-One-on-One-Zoe-Rees-Performance-Review-and-Development | 100 / 50, 12:39 | 98, 29:54 | 0.991 |
| 78 | 2026-08-18 08-18-Performance-Intervention-Note-Call-Handling-Deficit-and-Account | 100 / 50, 14:12 | 68, 19:23 | 0.992 |
| 79 | 2026-08-18 08-18-Weekly-Meeting-Loop-API-Integration-EXP-Portal-and-Customer-Iss | 250 / 50, 08:09 | 209, 26:49 | 0.985 |
| 80 | 2026-08-18 08-18-Weekly-Meeting-TLO-Website-Crisis-Resource-Gaps-and-Client-Esca | 200 / 50, 14:20 | 195, 58:41 | 0.998 |
| 81 | 2026-08-18 08-18-Weekly-Meeting-Ticket-Status-Review-and-Integration-Issues | 200 / 50, 04:15 | 154, 19:43 | 0.981 |
| 82 | 2026-08-19 08-19-1-2-1-Meeting-KPI-Review-SLA-Backlog-and-AI-ClaudeNova-Adoption | 300 / 50, 05:55 | 253, 33:58 | 0.996 |
| 83 | 2026-08-19 08-19-Customer-Consultation-Nurture-Print-Deliverability-Royal-Mail-S | 100 / 50, 13:22 | 85, 19:59 | 0.984 |
| 84 | 2026-08-19 08-19-Meeting-Heidi-Powers-Performance-Review-and-KPI-Discussion | 200 / 50, 09:26 | 189, 32:27 | 1 |
| 85 | 2026-08-19 08-19-Meeting-Service-Packaging-Strategy-Feature-Toggling-Limits-Cust | 500 / 50, 06:20 | 491, 53:09 | 0.998 |
| 86 | 2026-08-19 08-19-Weekly-Meeting-LeadPro-Package-Feasibility-for-Knight-Frank | 300 / 50, 07:47 | 268, 36:43 | 0.998 |
| 87 | 2026-08-20 08-20-1-2-1-Meeting-Knowledge-Base-Initiative-SLA-Breaches-and-AI-Too | 200 / 50, 13:18 | 200, 44:53 | 0.997 |
| 88 | 2026-08-20 08-20-Establishing-a-New-Workflow-for-Prioritized-Maintenance-Tickets | 150 / 50, 10:12 | 119, 24:13 | 0.995 |
| 89 | 2026-08-20 08-20-Meeting-Communication-Workflow-and-Ticket-Management | 400 / 50, 11:22 | 381, 1:09:09 | 0.991 |
| 90 | 2026-08-20 08-20-Meeting-New-System-Overview-for-Support-Feed-System-and-CMS | 200 / 50, 09:32 | 164, 22:52 | 0.997 |
| 91 | 2026-08-20 08-20-Meeting-One-to-One-Reset-on-KPIs-SLA-Compliance-Ticket-Standard | 350 / 50, 08:20 | 319, 59:25 | 1 |
| 92 | 2026-08-20 08-20-One-to-One-Meeting-Maria-KPIs-Knowledge-Base-Ownership-and-AI-S | 250 / 50, 09:16 | 249, 46:29 | 0.999 |
| 93 | 2026-08-20 1-2-1-Review-KPI-Redesign-and-Team-Productivity | 250 / 50, 09:49 | 226, 40:31 | 0.997 |
| 94 | 2026-08-20 Review-LSL-Ticket-Tracker-and-NHM-Data-Discrepancies | 150 / 50, 04:38 | 143, 17:27 | 0.99 |
| 95 | 2026-08-24 08-24-1-2-1-Meeting-Kayleighs-Wellbeing-Comms-Coverage-End-Date-Onboa | 300 / 50, 11:24 | 283, 1:08:52 | 0.998 |
| 96 | 2026-08-24 08-24-Support-Process-Meeting-Ticket-Ownership-Routing-and-Escalation | 450 / 50, 11:34 | 426, 1:29:51 | 1 |
| 97 | 2026-08-25 08-25-Performance-Review-Nick-Ward-and-Nathan-Rutland-on-KPIs-Team-Pe | 300 / 50, 10:45 | 277, 54:27 | 0.996 |
| 98 | 2026-08-25 08-25-Post-Incident-Review-of-Failed-Jobs-Process-Breakdown-and-New-O | 100 / 50, 09:44 | 53, 10:12 | 0.991 |
| 99 | 2026-08-25 08-25-Weekly-Meeting-Bug-Fixes-Ticket-Status-and-Integrations | 150 / 50, 06:46 | 150, 23:14 | 0.992 |
| 100 | 2026-08-25 08-25-Weekly-Meeting-Employee-Well-being-Burnout-and-Performance-Revi | 150 / 50, 14:06 | 121, 45:09 | 0.982 |
| 101 | 2026-08-25 Performance-Review-Isabel-Busk-KPIs-Workflows-and-Operational-Plannin | 200 / 50, 07:43 | 167, 28:31 | 0.995 |
| 102 | 2026-08-25 Weekly-Sync-Client-Risks-and-Platform-Governance | 350 / 50, 07:00 | 312, 53:17 | 0.999 |
| 103 | 2026-08-26 08-26-Meeting-WhatsApp-Integration-Omnichannel-Journeys-Pricing-Strat | 150 / 50, 10:55 | 149, 22:04 | 0.997 |
| 104 | 2026-08-26 08-26-Sprint-Forecast-Meeting-Team-Updates-Process-Feedback-and-Proje | 200 / 50, 06:16 | 197, 30:59 | 0.996 |
| 105 | 2026-08-27 08-27-Weekly-Meeting-Ticket-Review-Development-Blockers-and-Process-I | 350 / 50, 08:04 | 301, 41:50 | 0.998 |
| 106 | 2026-09-01 09-01-Meeting-LeadPro-Strategy-Client-Risks-IVT-Issues-and-MobileApp- | 500 / 50, 07:05 | 499, 57:32 | 1 |
| 107 | 2026-09-01 09-01-Weekly-Meeting-Ticket-Health-AI-Integration-and-Team-Performanc | 400 / 50, 08:41 | 352, 1:04:05 | 0.998 |
| 108 | 2026-09-02 09-02-Meeting-Support-Team-Performance-Morale-Knowledge-Base-Updates- | 150 / 50, 12:49 | 113, 28:12 | 0.998 |
| 109 | 2026-09-02 09-02-Meeting-WFH-Policy-Performance-and-Employee-Accommodations | 350 / 50, 08:53 | 339, 1:01:25 | 0.999 |
| 110 | 2026-09-02 09-02-Systemic-HR-Failure-Unresolved-Flexible-Work-Request-Creates-Le | 100 / 50, 07:33 | 64, 09:14 | 0.992 |
| 111 | 2026-09-02 09-02-Weekly-Meeting-Claude-MCPs-for-Support-Team | 250 / 50, 10:37 | 235, 34:26 | 0.996 |
| 112 | 2026-09-04 09-04-Internal-Partner-Meetings-on-Workload-Services-and-Personal-Mat | 200 / 50, 12:26 | 163, 32:30 | 0.995 |
| 113 | 2026-09-04 09-04-Meeting-Return-to-Work-Workload-and-Career-Path | 150 / 50, 09:01 | 118, 20:13 | 0.999 |
| 114 | 2026-09-05 09-05-Medical-Consultation-Chronic-Headaches-and-Neurological-Symptom | 150 / 50, 06:37 | 140, 19:25 | 0.997 |
| 115 | 2026-09-07 09-07-Tech-Leadship-Meeting-Ticket-Volume-SLAs-and-TPJ-Issues | 650 / 50, 06:41 | 605, 1:55:37 | 0.999 |
| 116 | 2026-09-08 09-08-Consultation-Nick-Ward-Postal-Pricing-and-Service-Reliability | 100 / 50, 13:03 | 63, 14:38 | 0.99 |
| 117 | 2026-09-08 09-08-Meeting-Data-Sync-History-Scope-Concerns-and-Compliance-Risks | 150 / 50, 10:36 | 141, 30:21 | 0.996 |
| 118 | 2026-09-08 09-08-Meeting-Support-Team-Performance-Scope-Definition-AI-Adoption-a | 400 / 50, 07:12 | 376, 1:20:08 | 0.999 |
| 119 | 2026-09-08 09-08-Weekly-Meeting-Integrations-Account-Risks-and-Process-Gaps | 300 / 50, 07:42 | 276, 37:23 | 0.998 |
| 120 | 2026-09-13 09-13-Consultation-Nick-Ward-Multifocal-Contact-Lens-Fitting-Astigmat | 150 / 50, 08:09 | 135, 21:47 | 0.968 |
| 121 | 2026-09-14 09-14-Weekly-Meeting-Sprint-Planning-Reporting-Issues-and-Platform-St | 300 / 50, 12:19 | 280, 50:52 | 0.997 |
| 122 | 2026-09-17 09-17-1-2-1-Meeting-AI-Driven-Ticket-Management-KPI-Review-and-Escala | 150 / 50, 07:15 | 123, 19:01 | 0.998 |
| 123 | 2026-09-17 09-17-1-2-1-Meeting-Call-Handling-Balance-QANova-Scoring-AI-Claude-Ad | 250 / 50, 09:43 | 218, 41:28 | 0.999 |
| 124 | 2026-09-17 09-17-1-2-1-Meeting-Team-Sentiment-AI-in-Support-Workflow-Ticket-KPIs | 200 / 50, 07:55 | 164, 23:26 | 0.997 |
| 125 | 2026-09-17 09-17-Meeting-Tier-2-SLA-Improvements-QA-Refinements-AI-in-Tickets-Po | 250 / 50, 10:07 | 222, 40:53 | 0.999 |
| 126 | 2026-09-17 09-17-Weekly-Meeting-AI-in-Support-and-Customer-Care-Ticket-Prioritiz | 250 / 50, 07:22 | 236, 34:09 | 0.999 |
| 127 | 2026-09-18 09-18-Meeting-Support-Operations-Performance-Call-Routing-Issues-SLA- | 300 / 50, 09:20 | 256, 38:31 | 0.993 |
| 128 | 2026-09-21 09-21-Meeting-Cancelled-Customer-Instance-Remediation | 150 / 50, 12:05 | 103, 19:36 | 0.995 |
| 129 | 2026-09-21 09-21-Weekly-Meeting-Ticket-Queue-Management-and-System-Issues | 250 / 50, 06:54 | 247, 47:53 | 0.97 |
| 130 | 2026-09-28 09-28-Daily-Stand-up-Ticket-Review-and-Blockers | 200 / 50, 06:16 | 177, 24:33 | 0.993 |
| 131 | 2026-09-28 09-28-Tech-Leadership-Team-Meeting-Sprint-Planning-TPJ-Support-Resour | 250 / 50, 08:23 | 214, 32:30 | 0.998 |
| 132 | 2026-09-29 09-29-Daily-Stand-Up-Technical-Issues-Integrations-and-Ticket-Review | 150 / 50, 09:30 | 119, 21:04 | 0.993 |
| 133 | 2026-09-29 09-29-Weekly-Meeting-At-Risk-Customers-AFE-Adoption-and-Project-Statu | 500 / 50, 03:42 | 480, 41:51 | 0.996 |
| 134 | 2026-10-01 10-01-Daily-Standup-Ticket-Backlog-Reduction-Blockers-TPJTPFGAlto-Sha | 150 / 50, 08:48 | 139, 23:55 | 0.992 |
| 135 | 2026-10-02 10-02-Daily-Standup-Nova-Deployment-KPIs-CIJIRA-Process-Data-Feed-Blo | 300 / 50, 06:47 | 288, 45:56 | 0.998 |
| 136 | 2026-10-02 10-02-Support-Leadership-Meeting-Guide-Creation-Team-Performance-and- | 300 / 50, 06:32 | 295, 39:59 | 0.995 |
| 137 | 2026-10-02 10-02-Weekly-KPI-Meeting-Dev-Ticket-Escalations-GDPR-Unsubscribe-Risk | 200 / 50, 07:49 | 176, 26:35 | 0.997 |
| 138 | 2026-10-05 10-05-Meeting-Client-Communication-Issue-Tracking-and-Technical-Chall | 100 / 50, 07:38 | 60, 08:34 | 0.997 |
| 139 | 2026-10-05 10-05-Meeting-Onboarding-Automation-Alignment-CRM-Orchestration-Insta | 100 / 50, 09:01 | 84, 16:47 | 0.995 |
| 140 | 2026-10-05 10-05-The-London-Office-Meeting-Feed-Processing-Delays-Support-Backlo | 250 / 50, 07:10 | 243, 35:08 | 0.998 |
| 141 | 2026-10-05 10-05-Weekly-Meeting-Support-Performance-Dependency-Tech-Leadership-M | 250 / 50, 16:30 | 245, 45:38 | 0.997 |
| 142 | 2026-10-06 10-06-Daily-Standup-Round-Robin-Assignment-Fixes-HR-Alignment-Ticket- | 300 / 50, 04:30 | 255, 27:22 | 0.988 |
| 143 | 2026-10-06 10-06-Risk-Meeting-Risk-Register-Overhaul-Customer-Escalations-and-CR | 350 / 50, 04:43 | 303, 24:34 | 0.998 |
| 144 | 2026-10-06 Incident-Briefing-Property-feed-and-My-Account-Outage | 200 / 50, 05:34 | 194, 21:30 | 0.999 |
| 145 | 2026-10-07 10-07-Support-Teams-Consolidation-Meeting-Jira-Support-Unification-In | 700 / 50, 07:26 | 697, 1:26:24 | 0.999 |

---

## Phase 3 applied (2026-10-08, pi5)

`node scripts/plaud-repair-transcripts.js --apply`: **found 145, repaired 145, refused 0, failed 0.**

| Check | Result |
|---|---|
| Second dry run (idempotency) | `found 0, would repair 0` |
| Backups | 145 files in `Scripts/.lint-backups/plaud-repair-2026-10-08/` (same relative paths) |
| 7 Oct meeting | Ends `**Chris Middleton** \`1:26:24\`  Yeah. Thank you. Bye.` — 101,920 → 81,672 bytes |
| Windows vault after Obsidian Sync (full re-scan) | 263 transcripts · **0 repeated · 0 short of PLAUD total** |
| Search index / entities | 145 / 145 re-embedded and re-extracted (the last file's async hook was cut off by the script exiting; re-run by hand, and the script now waits — `e1fa481`) |
| Summary notes, tasks, candidates | untouched |

**Rollback:** copy `Scripts/.lint-backups/plaud-repair-2026-10-08/Plaud/Transcripts/*` back over `Plaud/Transcripts/`.

**Noted, not changed:** five recordings (e.g. `of_ef13…`, `of_23a6…`) have been reported "not ready" 52–74 times each, because PLAUD holds no transcript or summary for them. Every sync re-asks about them. That's harmless, but it's wasted calls. This morning's 10:01 recording is also still empty on PLAUD's side.

---

## Step 4: NOVA re-send (2026-10-08)

**Deploy:** NOVA v1.1.715 (`5e92db1` on `nova-codex`, pushed to azdo + origin), deployed manually by Nick. It shipped together with `873bc3d` (v1.1.714, daypilot-b3's Jira status guard; kill switch `jira_status_guard_enabled=false`). Route verified live: an empty POST to `/121/transcript-correction` answered `400 plaudId and transcript are required`.

**Correction to Phase 1:** the "18 approved" was **17 distinct recordings**. `018da2d8…` has two transcript files in the vault and was counted twice.

`node scripts/nova-transcript-corrections.js --ids <17> --apply`, limited to the corrupt ones (NOVA holds 46 approved recordings; the other 29 were never touched):

| | Result |
|---|---|
| Recordings corrected | **16** |
| Unchanged | 1. Luke Scaife 27 May: NOVA's session #10 has no stored transcript text, so the route correctly refused to *attach* one (that's approval's job) |
| NOVA rows rewritten | **45**: 29 candidate rows, 13 1-2-1 sessions, 3 conversation records |
| Refused as a mismatch | **0** |
| Second run | corrected 0, unchanged 17 (idempotent) |
| Actions re-extracted | none. `extracted_at` was untouched, so no duplicate actions |

**Open, for later:** those 13 sessions and 3 conversations now hold the full conversation, but NOVA's actions were extracted from the first few minutes only. Mining the rest for new NOVA actions would need a review list, the same as step 5, because NOVA's extractor only de-duplicates on exact wording.

---

## Step 5: trial on 3 repaired transcripts (2026-10-08)

Commitments were extracted from each full transcript (NEURO `transcript_processing` route → Claude Haiku, **$0.061 for all three**), then compared with NEURO's dedupe matcher against that meeting's **summary note** and every suggestion and task already on record. Nothing was written to tasks or the queue.

| Recording | Extracted | Already in the summary note | Not matched |
|---|---|---|---|
| 7 Oct Support Teams Consolidation (1h26) | 23 | 12 | 11, of which about 5 are paraphrases of summary lines (score 0.30–0.42, e.g. "Chris to schedule follow-ups early week of Oct 12") |
| 25 Aug Isabel Busk performance review | 13 | 11 | 2, both paraphrases of the summary's "AI productivity tools" item |
| 25 Aug Nathan Rutland performance review | 27 | 23 | 4, all paraphrases of summary lines ("Nathan to run the daily stand-ups…") |

**Finding:** PLAUD's summary notes were written from the full recordings and already carry almost every commitment. The two 1-2-1s were completely covered. Only the long 7 Oct meeting yielded a handful of genuinely unlisted items, and most of those belong to other people or were same-day ("meet Siraj this afternoon"). The repaired transcripts are valuable for **search, chat and NOVA's read of the 1-2-1s**. They aren't a hidden backlog of missed tasks.

**Recommendation:** skip the full run over the other 142 (it would cost about $3). Separately, two oddities surfaced:
- 1-2-1 summary notes aren't where the sync ledger says they are. They were renamed or moved after routing, which is harmless here.
- The trial ran on Claude Haiku, NEURO's routing backstop, rather than OpenRouter.

### The 7 Oct items not found in its summary (for your eye only, nothing raised)
- [Nick] Map the current Jira setup and which ticket types/workflows move to NT (due tomorrow)
- [Nick] Review and document issues in the Yomdel / TPJ / Starberry projects so their inefficiencies aren't copied (w/c 12 Oct)
- [Nick] Execute the migration of Yomdel, TPJ and Starberry tickets to NT (by 26 Oct)
- [Nick] Talk to Lucy Read about the finer details of the project migration (this week)
- [Siraj Basha] Nominate a team member to work with Nick during his absence (today)
- [Lucy Read] Document current portal form requirements for translation to NOVA (this week)
- [Chris Middleton] Take the tiered "can you just" and global credit proposals to SLT (next SLT)
