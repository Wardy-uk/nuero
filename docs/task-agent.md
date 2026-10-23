# "Do this" — the task agent (23 Oct 2026)

Pressing **Do this** on a task means: *NEURO, take this as far as it safely can.* It
gathers the context Nick can already see, drafts, plans, researches and prepares, and
asks him only for a real ambiguity, a missing fact, a manual step only he can do, or
authority only he can give. It never ticks the task: the tick stays Nick's statement
that the work is done.

Branch `task-agent-do-this`. **Not deployed.** No AI budget, enforcement, linking
setting or backfill was changed.

## Where it is

| Piece | File |
|---|---|
| The agent (run store, tools, turn loop) | `backend/services/task-agent.js` |
| Routes (all owner-only) | `backend/routes/task-agent.js`, mounted at `/api/task-agent` |
| Full-note reader with the scan's own screen | `task-context.readForAgent(rel)` in `backend/services/task-context.js` |
| AI-gate call class | `task_agent` in `backend/services/ai-gate-classes.js` |
| Authority | capability `task-agent.run` (A1, machine: refuse) + five route rows in `authority-matrix.js` |
| MCP gateway | all five operations `interactive` in `mcp-server/remote/api-policy.js` |
| Kiosk | `task-agent` is `CLOSED_ON_PURPOSE` (not a proxy door); the component renders nothing when read-only |
| The workspace UI (shared) | `saim/shared-ui/TaskAgent.jsx` + `.css` |
| Desktop / NEURO phone PWA | `TaskEditPanel` in `frontend/src/components/TodoPanel.jsx` (open NEURO tasks only) |
| SAiM phone | `TaskPanel` in `saim/app/src/views/Tasks.jsx` (only when `platformNow() === 'phone-app'`) |
| Drafts | `AgentWork` in `saim/app/src/views/Drafts.jsx`, read from `GET /api/task-agent/active` (never on the kiosk) |

## The provider path (what was reused, nothing bypassed)

```
task-agent._turn
  → ai-routing.isCloudAllowed('task_agent')        (AI_MODE + daily call/token budgets + hourly cap; refused = no call, run says why)
  → anthropic-provider.chatWithTools(…, { callClass: 'task_agent', model, maxTokens: 4000, maxRounds: 12 })
       → anthropic-provider._create → gate-call.open/close   (ONE AI-gate ticket per round, shared ledger, shadow mode)
  → ai-routing.recordUsage(usage, { provider: 'anthropic', model, taskType: 'task_agent' })   (ai_calls cost ledger + daily budget)
  → ai-cost.resolveCost → run.usage.costUsd (null-safe: an unpriced model is "cost not known", never $0)
```

- The API key stays server-side (`ANTHROPIC_API_KEY`); the browser only talks to `/api/task-agent`.
- Model: `TASK_AGENT_MODEL`, default `claude-sonnet-5` (priced in `ai-cost` at $2 / $10 per Mtok).
- **Cost per press, measured in the tests' token shapes:** a 3–4 round run is ~4–6k input + ~1–1.5k output tokens, about **$0.02–0.03**; a run that reads several notes and saves several outputs is larger (≤12 rounds, ≤4k output each). There is no per-class cap: `task_agent` has no `maxPerDay`, deliberately, like every other class.
- ⚠ `recordUsage` counts a whole turn as ONE call against the daily call budget (the chat-tools precedent), while the AI gate records every round as its own ticket.
- Audit: `activity_log` rows `task_agent` (start / turn / answer / stop / refused / failed) carry task id, run id, status, model, tokens, cost and the KEYS of sources used — never prompt text or output bodies.

## The run

One attempt per task, in `agent_state` under `task_agent_run:<taskId>` (the
standup-session precedent: a workspace, not a second task store). Statuses:
`running`, `needs-answer` (ambiguity / missing), `needs-manual`, `needs-decision`
(authority), `ready`, `failed`, `interrupted`, `stopped`.

What is stored is what Nick sees: understanding, sources (title, provenance, kind,
used/available), steps, outputs, handoffs, the open question and his answers, usage.
**The prompt is never stored** — each turn rebuilds it from the task, the context and
the run's own outputs.

**Idempotency.** A press while a run is running or awaiting an answer returns it — no
model call, no draft, no prepared action. A settled run (`ready`) is returned as it
is. `interrupted` (a `running` run whose process died: no heartbeat for 10 minutes and
not in this process's in-flight map) and `failed` resume with one new turn. Only an
explicit **Start a fresh attempt** archives the run (`task_agent_history:<taskId>`,
last 5) and starts again. A repeated answer to an already-answered question costs
nothing.

## Tools — the whole of its power

| Tool | Effect |
|---|---|
| `search_vault` | `retrieval.searchWithHealth`, every hit re-screened by `readForAgent`; restricted / excluded notes never appear |
| `read_note` | only a path offered by a linked source or a search hit, re-screened, ≤8,000 chars |
| `save_output` | a private working output (draft, plan, brief, checklist, agenda, breakdown, investigation, answer, notes) in the run — not the vault |
| `prepare_email` | `prepared-actions.prepareCompose` with origin `task-agent` → a governed `compose_email` at status `prepared`, waiting on the existing Actions screen with the approval code (`intent-grants`: `task-agent` → `neuro_autonomous`). One per run. Recipient must resolve to ONE address from People notes, or be an address that appears verbatim in what the agent was given. Refused outright on a people matter. |
| `ask_nick` | one question (ambiguity / missing / manual / authority), why it matters, options |
| `finish` | understanding, completed, remaining |

There is **no** tool to tick or edit a task, write the vault, change the calendar,
change an allowance, confirm anything, or contact a person. Those are not refused at
run time; they do not exist here. A vault save, calendar block or send still goes only
through the existing confirmation routes.

## Context and privacy

- Context = `task-context.forTask(id, { viewer: 'owner' })`, pinned items only — Nick's
  own view, never wider.
- A **restricted** note contributes only its task-bounded excerpt; it gets no path and
  cannot be read in full. A restricted note with no excerpt contributes nothing.
- A **hard exclusion** (Security review/, Archive, generated, `neuro_context: exclude`)
  contributes nothing — not even its title — including a legacy row pointing at one.
- `readForAgent` applies the scan's own `screenNote` (security, opted-out, Personal/,
  private, employment-sensitive, excluded) before any full read.
- Kiosk, the API token (MCP gateway, n8n), any `X-Neuro-Machine-Client` (local MCP,
  chat clients) and in-process callers get 403 on every route, reads included —
  `task-context.viewerOf(req)` decides, and it only ever downgrades on a header.
- The UI lists every source with its provenance and whether it was used.

## People / employment matters

`sensitivityOf(task, context)`: the task's wording matches `promise-ledger.hrSensitivity`
(e.g. "end date"), or a pinned note is restricted as `employee-cases-note` /
`hr-wording` / `pip-deliverable`. Then:

- the system prompt tells the model to prepare a private decision brief and ask for the decision;
- `prepare_email` is refused;
- **server-enforced:** a turn that ends without an authority question still ends in
  `needs-decision` with a fixed question — NEURO never closes a people matter as "ready".

For "Set and confirm Heidi's end date…": it reads the excerpt Nick can see, writes the
brief (facts, options, risks, questions), and stops at his decision. It does not
decide, contact, promise or change anything.

## Proof (all local; nothing deployed)

| Test | What |
|---|---|
| `backend/routes/task-agent.test.js` (19) | real HTTP + api-auth + authority guard + task store + task-context over a temp vault + the REAL Anthropic provider and AI gate with only the SDK client scripted + the REAL `prepareCompose`; network blocked |
| `backend/services/task-agent-render.test.js` (7) | real render (esbuild + renderToString) of every state; kiosk renders `''`; both shells mount it |
| `backend/services/task-agent-browser.test.js` (6) | Electron, the REAL expanded TodoItem at 1440×900 and 390×844 and the SAiM phone mount at 390×844 over the real route; the press is clicked in the browser; screenshots with `TA_SHOTS` |

Covered: an ordinary task completes several steps without asking (reads the linked
note, saves a plan and a checklist, finishes); linked context shown with provenance;
the people matter prepares the brief from the excerpt only, refuses the email and stops
at `needs-decision`; one ambiguity question with options, answered, run continues; a
manual step, then "I've done it" resumes; an email prepared to `status: prepared`,
`origin: task-agent`, needing the approval code, with no attempt / approval / ledger /
grant / intent row and no network; refresh, three concurrent presses, an awaiting press
and a settled press all return the same attempt with one model loop; an interrupted run
resumes once; kiosk, API token, local MCP and a chat client get 403 on all five routes
with no output; Security review/ content and the rest of the restricted note never
reach any prompt or screen; the vault, tasks, calendar cache, allowances, intents and
ledger are byte-identical before and after.

**Mutation checks — 13 of 13 caught:** route owner check removed; hard exclusion kept in
sources; restricted source given a readable path; `readForAgent` letting restricted notes
through; search keeping refused notes; a settled press re-running; an awaiting press
re-running; the people-matter email guard removed; people matter not forced to decision;
an invented address accepted; a second email allowed; a repeat answer re-running; the
budget check skipped.

## Decisions still Nick's

1. **Deploy or not.** Needs: backend restart, NEURO frontend build, saim/app (Netlify
   autodeploys from main), MCP gateway rebuild (`docker compose up -d --build gateway`).
2. **Model and spend.** Default `claude-sonnet-5`. Each press can spend roughly two to a
   few pence, counted against the existing daily cloud budgets; no per-class cap was set
   (that is your decision, as for every class).
3. **Anthropic credit.** The key is set on pi5 and `AI_MODE=hybrid`, so it is allowed to
   run; whether the Anthropic account has credit was not checked. If it does not, every
   press ends `failed` with the provider's message and nothing else happens.
4. **Saving an output to the vault.** Outputs stay private in the run. Turning one into a
   vault note today is copy-paste; wiring "Save to vault" through the prepared-move
   confirmation is a follow-up, not built.
