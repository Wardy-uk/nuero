# Task context (22 Oct 2026)

Every open task can carry a small, inspectable layer of related vault material — a **note**, a
**project** or an **area** — with the reason it is there and who put it there. It is shown
wherever the task is worked on. It is not a knowledge graph.

Code: `backend/services/task-context-model.js` (PURE judgement), `task-context.js` (store, scan,
manual links, reads), `routes/task-context.js` (`/api/task-context`), `saim/shared-ui/TaskContext.jsx`.

## The record

`task_context_links` — one row per (task, source type, source ref), in NEURO's DB (created by
the first scan or link; reads never create it):

| field | meaning |
|---|---|
| `source_type` / `source_ref` | `note` + vault path · `project` + `Projects/<Folder>` · `area` + `Areas/<Name>` |
| `title`, `preview` | captured at link/refresh time; `preview` is **null for a restricted note** (never stored) |
| `origin` | `nightly-scan` · `manual` (Nick in NEURO) · `mcp` (a chat, on his explicit word) |
| `state` | `pinned` · `suggested` · `stale` (with `stale_from`, `stale_reason`: gone / no-longer-matches / excluded) · `removed` |
| `confidence`, `reasons_json` | automatic links only: each reason a code + a sentence |
| `scope_json` | project/area: the ≤3 most relevant notes inside it (never the whole folder) |
| `source_hash`, `source_mtime`, `source_changed_at` | change detection |
| `removed_at`, `removed_by` | a removal is kept, so the scan never re-adds it |

Also `task_context_runs` (compact receipts, last 60) and `task_context_questions` (when the scan
must ask rather than guess). **Nothing is ever written to the vault** — not by a scan, a read,
a link, or an empty run.

## The nightly scan

Durable job `task-context-scan`, **03:40 every night** (catch-up `latest`), registered in
`scheduler.start()` beside the other whole-vault/external jobs. Idempotent: an unchanged vault and
task list change no row.

⚠ **OFF BY DEFAULT — deploying never performs the backfill.** Until Nick enables it
(`agent_state.task_context_activation`), the job returns `{ skipped: 'not-enabled' }` and every
scan door (`runScan`, `POST /scan`) refuses with 409 — no scan, no pin, no suggestion, no stale
mark, no run receipt, not even a table. `GET /api/task-context/status` and NEURO → **Brain
Health → Automatic context linking** say it is waiting for the vault cleanup. Enabling there is
two steps (the second quotes exactly what happens and needs the "cleanup is done" tick) →
`POST /api/task-context/activate {confirm: true}` turns it on and runs **the backfill** at once;
if the backfill fails nothing is enabled. Then 03:40 nightly. `POST /deactivate` turns it off;
links stay. Activate, deactivate and scan are machine-refused and interactive in the gateway.
Manual links and removals made before activation are kept by the backfill.

**Pinned automatically** (explicit evidence, or a title with independent support):
- the note the task was **raised in** (`origin_path`);
- a note that **names the task** (`<!--task:N-->`, `task #N`);
- a note the task's wording **links to** (`[[Note]]`);
- a **title** match (≥2 distinctive words, ≥75% of the title; a one-word title only if rare)
  **plus** one of: the same project folder, a shared tag, or the body agreeing;
- the project/area folder the task came from, or a project Nick linked it to in NEURO.

**Suggested, never pinned:** a title match alone; body overlap + same project/tag; a
project/area the task's wording names. **Nothing:** body overlap alone, at any score. Words in
more than 15% of notes carry no evidence; document-kind words (draft, notes, summary…) do not
count in a title. Limits: 4 automatic pins, 5 suggestions per task.

**Never pulled in by the scan** (counted in the receipt with the reason): machine output
(`Documents/System/`, `Scripts/`, `Tasks/`, `Notion/` mirrors, `Templates/`), daily notes,
raw Plaud transcripts, People notes, MOCs, unprocessed imports, reflections/journals,
`Personal/` and `private: true` notes, **employment-sensitive** notes (prepared-move's
`employmentScreen`), `" 2.md"` duplicates (only when the original exists), sync conflicts,
untitled/generic notes, empty or unreadable notes, and anything across the work/personal line.
The **one exception**: a task's own origin note when it is sensitive is pinned **restricted** —
title only, no preview stored.

**Ambiguity asks:** two or more projects named by the wording → one question
("Which project is this task part of?"), nothing pinned. Answered by linking one, or "Neither".

**Staleness:** a vanished note → `stale: gone`; changed and no longer matching → `stale:
no-longer-matches`; changed and still matching → refreshed (title, preview, `source_changed_at`);
restored → back to its previous state. ⚠ A vault that reads **empty or under half of the last
good run** (unmounted, mid-sync) marks **nothing** stale and says so (`receipt.shrunk`) — found
by the test, where it had marked every link "gone".

Calibration on the live vault (22 Oct): 2,021 notes indexed in 1.8 s; 778 eligible; 245 withheld
as employment-sensitive; zero false pins across 17 real tasks (pins come mainly from origin notes).

## Manual linking

On the NEURO task card (expanded) → **Context** → **Add context**: choose a note, project or
area, search, pick. Each item shows title, type, one-line reason, **Found automatically / Linked
by you / Linked from a chat**, and Open / Remove. Suggestions are folded ("N suggestions — not
pinned") with **Pin it / Not related**. A name that fits several things comes back as a choice.
Machine output cannot be linked; a `Personal/` or employment-sensitive note links **restricted**.

## Surfaces

- **NEURO task card** (list and Must Move lane, one place): editable.
- **Now**: compact, for the ONE task in focus (running session → running block task → a block's
  only task); nothing when it has none; suggestions never shown there.
- **Prepared moves / private drafts**: compact, from `move.taskId`; hidden when Now already
  shows that task's context.
- **Meeting prep**: open tasks raised in a note the prep shows, or naming an attendee in FULL,
  with their pinned items not already on the sheet (≤3 tasks; skipped above 8 attendees).
- **Kiosk**: read-only — a GET-only proxy door for `/task-context/tasks/<id>`; search, link,
  unlink and scan stay closed.

## MCP

Remote gateway (Claude/ChatGPT desktop), from the inventory:

| operation | class |
|---|---|
| `get_task_context_tasks_by_taskId` · `get_task_context_search` · `get_task_context_suggestions` · `get_task_context_runs` | read |
| `post_task_context_tasks_by_taskId_links` (ONE item; `type`, `ref` only) | action |
| `post_task_context_tasks_by_taskId_links_by_linkId_remove` · `…_pin` · `…_question_dismiss` | action |
| `post_task_context_scan` | **interactive** (refused to machines in the authority matrix) |

Local MCP (Claude Code): `get_task_context`, `search_task_context`, `link_task_context`,
`unlink_task_context`. Every write tool says: only on Nick's explicit word, one item, never bulk.
A body with any unnamed field (a list, an `items` array) is refused with 400.

## Backfill

Not run, and deployment cannot run it. It waits for the vault cleanup
(`docs/vault-cleanup-manifest-2026-10-22.md`) to be approved and done; then Nick enables
automatic context linking in Brain Health, which runs it.
