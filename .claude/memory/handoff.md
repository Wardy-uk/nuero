# Session Handoff — 2026-09-24 15:14

## What was done
Knowledge Memory promotion queue, four commits (`0bfd938` → `101661f`), **all deployed to pi5 and verified live**.
- **Ranked the queue on the signal it already parsed.** `promotionSignal` has read topics / follow-ups / duration / conclusion since it was written and `scorePromotionCandidate` ignored all of it. Biggest tied block 189 → 87, distinct scores 5 → 14.
- **Opened the back catalogue.** Queue defaulted to 21 days while `enrichPromotionCandidates` used 3650 — 775 notes were unreachable, not low-ranked. `daysBack` + a Last 21 days / All time toggle; default still 21.
- **Knowledge only** (Nick's call): `## Open Loops` deleted from the promotion path — prompt, scoring arm, value shape, `## Still Open` in promoted notes, `loopToTask`, `POST /loop-to-task`, the card's origin question. Pinned as an absence.
- **Insight cap 2 → 6**, and `PROMPT_VERSION` folded into the skip hash so the change reaches already-enriched notes.
- **Added the enrich button** — the pass had no caller anywhere (no scheduler, no UI, MCP only).

## What's still pending
- **Nothing has been enriched yet.** All-time shows `243 of 243 summaries not yet read` (the PROMPT_VERSION bump correctly invalidated all 88 prior enrichments). ~10 presses at 25/press, spread over hours as the hourly cap rolls. Nick presses it; it is deliberately not scheduled.
- **`enrichManagedNotes` still asks for open loops** — consolidated-notes path, different surface, no card. Left alone deliberately.
- **The ranking is a measured proxy, not a measurement.** The model is never asked *how good* a note is, only for bullets. Asking for a 0–10 rating is what would make it real; costs another full re-enrich, so it is Nick's call.

## Key decisions made
- Signal bands are **percentiles of the live corpus, NOT outcome-validated** — the validation cannot be run (see mistakes.md, the degenerate `durable` count). Said so in the source rather than implying it was tested.
- Signal arm **capped at 5 against the evidence arm's 8**, so a note something has read still outranks one that merely looks big.
- Removing loops is safe because **`action-candidates` already mines the same notes for commitments** — it was a second extraction of the same material, not a unique capability.

## Files changed
- `backend/services/knowledge-memory.js` — `signalScore`, `needsEnrichment`, `PROMPT_VERSION`, loops removed, `daysBack`
- `backend/routes/knowledge-memory.js` — `daysBack` on overview + enrich, `/loop-to-task` deleted
- `frontend/src/components/InsightsPanel.{jsx,css}` — window toggle, enrich bar, loops block removed
- 4 new test files (`knowledge-signal-rank`, `knowledge-window-source`, `knowledge-enrich-target`, `routes/knowledge-window-routing`); `knowledge-value.test.js` rewritten where it pinned loops

## Gotchas for next session
- **`npm run catalogue:refresh` rewrites VANTAGE's inventory too** — `git checkout -- mcp-server/remote/vantage-inventory.json` after, every time. Hit it twice this session.
- **Two invented fixtures were caught by tests**: `note_type: "meeting-summary"` is NOT a summary (live notes use `"summary"` + `plaud_summary_type`), and no transcript anywhere carries `plaud_summary_type`. Copy fixtures off the live vault.
- `backend/services/task-blocks.js` + its test were **already dirty on arrival** and are not mine — still uncommitted.
- Python heredocs mangle `\n` inside JS template literals; use `chr(92)` or line-anchored edits.
