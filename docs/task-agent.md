# "Do this" — the task agent (23 Oct 2026)

Pressing **Do this** on a task means: *NEURO, take this as far as it safely can.* It
gathers the context Nick can already see, drafts, plans, researches and prepares, and
asks him only for a real ambiguity, a missing fact, a manual step only he can do, or
authority only he can give. It never ticks the task: the tick stays Nick's statement
that the work is done.

Branch `task-agent-do-this`. **Not pushed to GitHub, not deployed.** No AI budget,
enforcement, linking setting or backfill was changed, and no real governed write was made.

## Which surfaces get it

| Surface | What it is | Do this? | Why — the access model, not a header |
|---|---|---|---|
| NEURO desktop (browser) | `frontend/`, task card `TaskEditPanel` | **Yes**, on every open NEURO task | PIN session → `viewerOf` = owner |
| NEURO phone PWA | the same `frontend/` build | **Yes** | PIN session → owner |
| SAiM phone app | `saim/app`, `views/Tasks.jsx` | **Yes** | PIN session, direct to NEURO → owner |
| **SAiM desktop (Electron)** | `saim/desktop-electron` — loads the SAME `saim/app` from `https://sara.nickward.co.uk` (`target.js`); `window.saimNative` marks it | **Yes** (the first pass excluded it — that was a bug, fixed) | PIN session, direct to NEURO → owner |
| Kiosk / wall screens | `saim/frontend` (declares `kiosk`), talks only through `saim/backend` | **No** — the component renders nothing | the kiosk credential is an attended surface → `viewerOf` = limited → 403; and `saim/backend`'s proxy has no `task-agent` door (`isAllowed` false for every path and method, tested) |
| MCP (gateway + local), n8n, API token | machine clients | **No** | API token / `X-Neuro-Machine-Client` → limited → 403 at the route, and matrix `task-agent.run` machine: refuse; every operation `interactive` in the gateway |
| Chat clients | declare themselves machines | **No** | as above |
| Background automation | in-process | **No** | there is no caller; `viewerOf` defaults to limited |

`viewerOf` can only DOWNGRADE on a header; nothing a browser sends can make it "owner".
The honest limit is unchanged: a PIN holder that does not declare itself a machine looks
like Nick.

## Where it is

| Piece | File |
|---|---|
| The agent (run store, tools, transactional turn, save, Claude handoff, budget line) | `backend/services/task-agent.js` |
| Routes (all owner-only) | `backend/routes/task-agent.js` → `/api/task-agent/…` |
| Draft → existing project-note prepared move | `planAgentOutput` in `backend/services/prepared-move-planner.js` |
| Full-note reader with the scan's own screen | `task-context.readForAgent(rel)` |
| AI-gate class + Settings limit | `task_agent` in `backend/services/ai-gate-classes.js` (`setClassLimit`, `limitOf`); `POST /api/ai-gate/class-limit`; `classLimits` on `GET /api/ai-gate/profile` |
| Settings control | `TaskAgentLimit` in `frontend/src/components/AiBudgetCard.jsx` |
| Provider | `anthropic-provider._create` passes `options.requestOptions` (timeout, retries) to the SDK |
| UI (shared) | `saim/shared-ui/TaskAgent.jsx` + `.css` |
| Drafts | `AgentWork` in `saim/app/src/views/Drafts.jsx` |

Routes: `GET tasks/:id`, `GET active`, `POST tasks/:id/start` (`fresh`), `POST tasks/:id/answer`,
`POST tasks/:id/stop`, `POST tasks/:id/outputs/:outputId/save`,
`GET tasks/:id/handoff/preview` (`includeDrafts=1`), `POST tasks/:id/handoff`.

## The provider path (reused, nothing bypassed)

```
task-agent._turn
  → refuse before any call if: no key · the model has no gate price · ai-routing.isCloudAllowed('task_agent') is false
  → anthropic-provider.chatWithTools(…, { callClass: 'task_agent', model, maxTokens: 4000, maxRounds: 12,
                                          requestOptions: { timeout: 90 s, maxRetries: 0 } })
       → _create → gate-call.open/close    ONE AI-gate ticket per model request, on the shared ledger
  → ai-routing.recordUsage(usage, { provider: 'anthropic', model, taskType: 'task_agent' })   ai_calls cost ledger
  → ai-cost.resolveCost → run.usage.costUsd   (unpriced = "cost not known", never $0)
```

- **Model.** Default `claude-sonnet-4-6` (`TASK_AGENT_MODEL` overrides). It is in the
  installed `@anthropic-ai/sdk`'s own model list and priced in BOTH the gate's table
  ($3 / $15 per Mtok) and `ai-cost` — pinned by a test. The first pass defaulted to
  `claude-sonnet-5`, which the installed SDK does not list; that was changed. An override
  the gate cannot price is refused before any request.
- **Cost.** A typical 3–4 request run is ~5–6k input + ~1.4k output tokens ≈ **$0.04**;
  the ceiling is 12 requests × 4k output.
- **No hidden retries.** `maxRetries: 0`; a retry is Nick's press.
- **The API key never reaches a browser.**

### Budget — the corrected statement

- **The AI gate is in SHADOW mode in production and has NO daily cap.** It records every
  `task_agent` request on the shared ledger and blocks nothing.
- **New: a Do this limit — model requests per day — in Settings → AI budget**
  (`POST /api/ai-gate/class-limit`, owner-only, machine-refused, gateway interactive).
  **None is set.** It is NEURO's class registry's `maxPerDay` for `task_agent` (the shared
  `ai-gate.js`, byte-identical with VANTAGE, is untouched): past the limit the gate records
  a `volume` refusal. **In shadow mode that is recorded and the run still goes ahead; only
  `AI_GATE_MODE=enforce` refuses** — and then the run fails before any request with nothing
  kept and a message pointing to Settings. Both proven in tests.
- Every run shows the gate line in words: *"Recorded by the AI gate in shadow mode. No Do
  this limit is set, so it is not budget-blocked by the gate."*
- **Separately, NEURO's own `ai-routing` daily call/token limits and `AI_MODE` still apply**
  (they are what `isCloudAllowed` checks). pi5 (read-only check, 23 Oct): `AI_MODE=hybrid`,
  an Anthropic key is set. Anthropic account credit was NOT inspected.

## The run

One attempt per task in `agent_state` (`task_agent_run:<taskId>`; history of five in
`task_agent_history:<taskId>`). **The prompt is never stored.** Every run ends in one of:

| End state | Status | What Nick sees |
|---|---|---|
| 1. completed private work, retained | `ready` | the outputs, each with **Save to vault…** and **Copy**, plus "The task stays open until you tick it" |
| 2. a governed action prepared at its normal boundary | `ready` | "Ready for your confirmation" → **Review on Actions** (email) / the save confirmation |
| 3. one precise question or manual step | `needs-answer` / `needs-manual` / `needs-decision` | one question, why it matters, options; **Tell NEURO** / **I've done it — carry on** |
| 4. an evidenced inability to proceed | `blocked` (nothing produced) or `failed` (provider/gate/model) | the reason in words; Do this — continue / Start a fresh attempt |

**Transactional turns.** A turn works on a COPY of the run. Only a completed turn is
committed. A provider failure, timeout, exhausted credit, overload or gate refusal
leaves the stored run exactly as it was: no partial draft, no step's output, and **no
prepared email**. The email tool only validates and queues during the turn, and the
email is prepared once, after the turn completes. The next press resumes from the last
committed state with one clean turn. Errors are classed
(`credit` / `timeout` / `overloaded` / `budget` / `error`) and said in words.

**Idempotency.** A press while running/awaiting/settled returns the same attempt (no
model call). A repeated answer costs nothing. A repeated **Save to vault…** returns the
same prepared-move record. A repeated Claude handoff with the same prompt is the same
handoff, with no second desk request. A run interrupted by a restart resumes once.

## Next steps for finished work (no parallel stores, confirmations or executors)

- **Save private draft to vault.** `POST …/outputs/:id/save` → `planAgentOutput` stores the
  EXISTING `project-note` prepared move:
  - same `moveKey` (`task:<id>`);
  - same destination rule: one evidenced project folder, else `Projects/Working`, never
    creating any other folder;
  - same note shape;
  - an optional solo block, only when the run left work only Nick can do, through the
    same slot finder and leave checks.

  The card then mounts saim/app's own `PreparedMove` for that record (desktop via
  `desktopCall`, SAiM via its transport). Saving happens only through
  `/api/prepared-moves/request` → `/confirm` → the executor, behind its existing
  boundaries in order: the device lock, the off-duty hold (a non-private project-note
  save is held in the evening, by the existing rule), today's allowance, then the
  one-use confirmation.
- **Email** → a governed `compose_email` (origin `task-agent` → `neuro_autonomous` → the
  approval code on Actions). One per run; a recipient resolves to one People-note address,
  or is an address that appears verbatim in what the agent was given.
- **Task state.** Never changed. The card says the task stays open until Nick ticks it.
- **Drafts.** "Do this — NEURO working on your tasks" lists runs with outputs, a handoff or
  a question, with **Open the task**. A saved draft's proposal also appears under Drafts →
  "Needs your confirmation" (it IS a prepared move).
- **A people matter** cannot be saved (service and planner both refuse — two independent
  guards) and is copied by hand if Nick wants it.

## "Continue this with Claude on desktop"

The agent calls `recommend_claude_desktop {why, done_when}` when the task needs code
changes, debugging, a repository, long-form documents or tools NEURO lacks. The run
then shows the route prominently; it is otherwise available as a quiet button.

1. **Preview** (`GET …/handoff/preview`), before anything else, shows:
   - why Claude;
   - exactly what is included and what is never included;
   - the destination project, if one is evidenced;
   - the prompt, which Nick can edit;
   - *"Nothing is sent to Claude until you press the button. Pressing it copies this
     prompt for you to paste into Claude on your desktop; it does not send it anywhere."*
2. **The prompt** contains:
   - the objective;
   - why it is with Claude;
   - constraints: any NEURO change returns through NEURO's own confirmation, and Claude
     contacts nobody;
   - each non-restricted source's title and provenance, with a ≤300-char excerpt;
   - a count of restricted sources, with nothing of them — not even the title;
   - what NEURO already did, and draft titles (draft text only if Nick ticks "Include my
     drafts in full");
   - what is still open;
   - a "Done when" line.

   For a people matter there are no excerpts and no drafts, ever.
3. **The press** (`POST …/handoff`) screens the prompt as Nick left it. It is refused,
   with the reason, if it contains:
   - a `Security review/` or `Archive/` path;
   - a password, key, token or private key;
   - any restricted excerpt;
   - a draft he did not choose to include.

   The prompt is recorded by hash and length only (never stored), written to activity
   without its text, and returned for the device to copy. "Also open Claude on my laptop"
   uses the EXISTING desk intent (`desk-intents.queue('claude')`, which carries no
   arguments) at most once per handoff.
4. **Status** is on the task attempt: "Handed to Claude <time> — prompt copied; laptop:
   requested".

**Why copy, not send.** There is no existing approved mechanism that hands a prompt to
Claude/Codex on the laptop. The desk-intent agent deliberately opens allow-listed apps
with no arguments. So NEURO generates and copies the prompt, and does not attempt an
undocumented external write. Claude may prepare work; any NEURO-governed write still goes
through NEURO's own confirmation and authority routes.

## Context and privacy

- **Context.** `task-context.forTask(id, { viewer: 'owner' })`, pinned items only. A
  restricted note contributes only its task-bounded excerpt and has no path. A hard
  exclusion (`Security review/`, Archive, generated, `neuro_context: exclude`) contributes
  nothing, not even its title.
- **Full reads.** These go only through `readForAgent`, which applies the scan's
  `screenNote`.
- **Saved notes** quote only non-restricted sources the run actually used.
- **Activity.** `task_agent` rows: start / turn / answer / stop / refused / failed /
  save-prepared / claude-handoff. They carry ids, status, model, tokens, cost, error class
  and source keys — never prompt text, output bodies or handoff prompts.

## Proof (local only)

| Test | What |
|---|---|
| `routes/task-agent.test.js` (19) | first pass: ordinary multi-step, context, people matter, ambiguity, manual step, email to Actions, idempotency/restart, limited surfaces, hard exclusions, no writes |
| `routes/task-agent-next.test.js` (15) | second pass: save via the real prepared move + real `/request` through its boundaries (device lock → allowance → confirmation shown, never confirmed); people matter cannot be saved or handed off with any excerpt/draft/restricted title; Claude preview/sanitisation/confirmation/idempotency/one desk request; credit / timeout / overload failures keep nothing and resume once; email prepared only at the end of a completed turn; class limit Settings-only, recorded in shadow, refused under enforce; unpriced model refused; blocked end state; default model verified; limited surfaces 403 on the new routes; kiosk proxy never forwards any task-agent path |
| `services/task-agent-render.test.js` (10) | real render of every state incl. save, Claude preview, blocked, budget line; kiosk renders `''`; both shells mount it, SAiM read-only on the kiosk ONLY |
| `services/task-agent-browser.test.js` (8, Electron) | the real TodoItem (1440, 390) and the SAiM mount as phone, as the Electron desktop and as the kiosk: press → ready; Save to vault → the real Confirm VISIBLE and never pressed, vault byte-identical; Claude preview + recorded handoff; question; people matter; email; kiosk renders nothing |
| `services/task-agent-live.test.js` (1) | the real Anthropic API on a disposable key — **NOT RUN** (see below) |

Mutation checks: first pass 13 of 13 caught; second pass 19 of 20. The second pass broke
transactional turns, email-after-commit, each handoff screen, restricted-source exclusion,
handoff and desk-request idempotency, the planner's employment refusal, the class limit
and its owner check, the unpriced-model refusal, the blocked state, the request timeout,
credit naming, the new routes' owner check, the Electron fix and the open-while-saving
fold. The one survivor is a stated second guard: a repeated save is also deduped by the
planner's own evidence hash. Mutation also found that the browser test's first visibility
check passed on a hidden confirmation (Chromium gives content inside a closed `<details>`
layout rects). It now uses `checkVisibility()` plus a not-inside-a-closed-fold check, and
catches it.

### The real-provider proof — not run

It needs a key Nick provides for testing. The production key is never read: the test
deletes `ANTHROPIC_API_KEY` from its own process, and the clone it was built in has no
`backend/.env`. Run:

```
TASK_AGENT_LIVE_ANTHROPIC_KEY=<disposable key> node --test backend/services/task-agent-live.test.js
```

The run uses a throwaway DB, vault and gate ledger, one synthetic task, and
`claude-haiku-4-5-20251001` (≈ $0.01). It asserts:

- a real 401 failure keeps nothing;
- the real run records tokens and cost on the run AND on the gate ledger, under $0.25;
- a repeat press makes no further call.

Timeouts and exhausted credit cannot be forced safely against the real API; they are
proven with the SDK client scripted to throw the real error shapes.

## Decisions still Nick's

1. **Deploy.** Backend restart, NEURO frontend build, saim/app (Netlify, on merge), MCP
   gateway rebuild.
2. **A disposable Anthropic key** for the live test, or approval to use the production one.
3. **A Do this limit** in Settings → AI budget, and whether to turn on gate enforcement.
   Neither is set.
4. **Evening saves.** The existing off-duty rule holds a non-private project-note save in
   the evening; widening it is a policy change.
