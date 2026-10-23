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
Health → Automatic context linking** say it is off until Nick enables it (the vault cleanup it
waited for was done on 22 Oct 2026). Enabling there is
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
title only, no preview stored. **Never** for a hard exclusion (below), not even as the origin.

**Hard exclusions (23 Oct 2026)** — `task-context-model.isHardExcluded`: `Security review/`,
an excluded folder (Archive, `_toDelete`, generated, infrastructure — but **not** `Personal/` /
`Private/`, which vault-exclusions also keeps out of entity extraction: those are *restricted*),
and a note whose own frontmatter says `neuro_context: exclude`. Never pinned by the scan (not
even as a task's origin), never linkable by hand or by MCP (400 with the reason), never offered
by search, and a legacy row pointing at one is title-only even for Nick — the note is never
read. Before this, a `Security review/` or `neuro_context: exclude` note could be pinned as an
origin (they screened as merely `restricted`), and search/manual link offered `Security review/`
and `Archive/` notes.

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
Machine output and hard exclusions cannot be linked; a `Personal/` or employment-sensitive note
links **restricted**.

## Who sees what of a restricted note (23 Oct 2026)

**Classification and viewer are separate.** Whether a link is restricted is the scan's call,
stored, and unchanged by this. What a screen may SHOW of it is decided per request by
`task-context.viewerOf(req)`, from the authenticated credential, never from a header the client
chooses about its surface:

| viewer | who | a restricted note shows |
|---|---|---|
| `owner` | a PIN session with no machine identity: NEURO desktop, the NEURO phone PWA, the SAiM phone | title, **provenance** ("Found automatically — this task was raised in this note."), the **restriction reason in words** (`restrictedSay`, e.g. "Contains personnel-sensitive material — colleagues are named alongside absence, health, conduct or performance."), a **task-bounded excerpt**, and **Open source note** (`open.path` + `open.obsidianUrl`); Remove stays |
| `limited` | the kiosk token (`attendedSurface`), the API token, any caller declaring `X-Neuro-Machine-Client` (the local MCP), and every in-process caller by default | title and "Restricted — shown as a title only on this screen." — `ref`, `open`, `preview` are null and no excerpt is sent |

**The excerpt** (`task-context-model.taskExcerpt`) is ONE line of the note, read at request
time, never stored, ≤240 characters, markdown stripped: the line carrying the task's own marker
(`<!--task:N-->`, `task #N`), else the line holding at least two and half of the task's words,
else nothing ("No line in this note could be matched to this task, so no excerpt is shown.") —
never a summary, never the surrounding text. The note is read only inside the vault root
(realpath-checked). Reading writes nothing.

**Honest limit:** a PIN holder that does not declare itself a machine cannot be told from Nick —
the same boundary every NEURO button has (intent grants say the same). The kiosk, the API token
and the local MCP are all told apart.

Live at the time of the fix (read-only diagnosis on pi5, 23 Oct): 39 links (24 suggested, 15
pinned); 10 pinned were restricted — all `nightly-scan` origin links to `Meetings/2026/…`
notes, 7 for `employee-cases-note` alone and 3 for `hr-wording` + `employee-cases-note`; no
manual restricted link; no link into `Security review/` or an excluded folder. No link was
changed and no scan was rerun for this — it is presentation only.

### Deployed (23 Oct 2026)

- **Commit:** `8baeccf6`, fast-forwarded onto `main` from `4839ae33`. Nothing had landed on `main` since review, so no rebase was needed.
- **Laptop tests before the push:** 86/86 focused route, screen and exclusion tests pass, including 5 Electron screen tests.
- **Pi tests:** 80 run, 75 pass, 0 fail. The 5 skipped are the Electron screen tests, which need a display; they ran on the laptop.
- **Builds:**
  - NEURO frontend `frontend/dist` (index-VAtp7eH9.js) and kiosk `saim/frontend/dist` (index-CweTM9iR.js) were rebuilt on pi5.
  - The SAiM phone app (sara.nickward.co.uk) autodeployed from `main`; its live bundle contains the new task-context code.
  - The kiosk on :3005 serves the new bundle.
- **Restarts:**
  - Only `neuro-backend` was restarted; `/api/auth/check` returns 200.
  - `saim-backend` and `vantage-backend` were left alone.
  - The MCP gateway was not rebuilt, because `mcp-server/remote/` did not change.
- **Production evidence for the ten affected pinned links** (tasks 344, 350, 189, 322, 369, 372, 442, 459, 460, 461):
  - **PIN session:** viewer `owner`. Every one of the 10 shows provenance, a plain restriction reason, a bounded excerpt (the task's own wording line, each ≤240 characters) and an open route with an `obsidian://` link.
  - **API token, PIN + `X-Neuro-Machine-Client: mcp-local`, kiosk token, and the kiosk proxy on :3005:** viewer `limited` for all ten. No `ref`, `open`, excerpt, reason codes, `obsidian://` link or `Meetings/` path.
  - **Chat:** chat reads no task context.
- **Hard exclusions:**
  - Searching task context for "Security review", "password", "Archive" and "credentials" returns no excluded note through any credential. The kiosk proxy refuses search outright (403).
  - Linking a real `Security review/` note → 400.
  - Linking an `Archive/` note → 400.
- **Links unchanged:** `task_context_links` holds 39 rows, and its sha256 is identical before and after the deploy. Linking stays on as it was, task-context runs are still 2, and no backfill was run.
- **Not checked:** the desktop and phone screens were verified through the API plus the Electron render tests of the same components, not with a production screenshot.
- **Not yet live in the laptop's local MCP:** it runs from the main checkout, which is on another branch with another session's uncommitted work. It picks up the new `contextLine` when that checkout moves to `main`. The NEURO API already sends it limited payloads.

## Consumers that read context for Nick: "Do this" (23 Oct 2026)

The task agent (`services/task-agent.js`, `docs/task-agent.md`) reads a task's context ONLY through
`forTask(id, { viewer: 'owner' })` — pinned items, Nick's own view. A restricted note gives it the
task-bounded excerpt and nothing more (no path, no full read); a hard exclusion gives it nothing, not
even the title. A full read goes through `readForAgent(rel)`, which applies this scan's own
`screenNote` (security, opted-out, Personal/, private, employment-sensitive, excluded) and refuses
anything restricted. It changes no link, runs no scan and does not touch the automatic-linking setting.

## Surfaces

- **NEURO task card** (list and Must Move lane, one place): editable.
- **Now**: compact, for the ONE task in focus (running session → running block task → a block's
  only task); nothing when it has none; suggestions never shown there.
- **Prepared moves / private drafts**: compact, from `move.taskId`; hidden when Now already
  shows that task's context.
- **Meeting prep**: open tasks raised in a note the prep shows, or naming an attendee in FULL,
  with their pinned items not already on the sheet (≤3 tasks; skipped above 8 attendees).
- **Kiosk**: read-only — a GET-only proxy door for `/task-context/tasks/<id>`; search, link,
  unlink and scan stay closed. Restricted notes are title-only there (limited viewer).
- **Meeting prep** passes the viewer of its own request (`_buildPrep(m, { viewer })`), so the
  kiosk's prep is limited and Nick's is owner.

## MCP

Remote gateway (Claude/ChatGPT desktop), from the inventory:

| operation | class |
|---|---|
| `get_task_context_tasks_by_taskId` · `get_task_context_search` · `get_task_context_suggestions` · `get_task_context_runs` | read |
| `post_task_context_tasks_by_taskId_links` (ONE item; `type`, `ref` only) | action |
| `post_task_context_tasks_by_taskId_links_by_linkId_remove` · `…_pin` · `…_question_dismiss` | action |
| `post_task_context_scan` | **interactive** (refused to machines in the authority matrix) |

Local MCP (Claude Code): `get_task_context`, `search_task_context`, `link_task_context`,
`unlink_task_context`. Every MCP read is the **limited** view: a restricted note is a title, no
path. Every write tool says: only on Nick's explicit word, one item, never bulk.
A body with any unnamed field (a list, an `items` array) is refused with 400.

## Backfill

Not run, and deployment cannot run it. It waits for the vault cleanup
(`docs/vault-cleanup-manifest-2026-10-22.md`) to be approved and done; then Nick enables
automatic context linking in Brain Health, which runs it.
