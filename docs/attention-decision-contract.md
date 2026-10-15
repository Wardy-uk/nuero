# attention-decision-v1 — SUPERSEDED

> **Superseded 15 Oct 2026** by [saim-attention-policy-contract.md](saim-attention-policy-contract.md): NEURO supplies facts (`neuro-candidates-v1`), SAiM owns the judgement (`saim/policy/attention-policy.cjs`, `saim-attention-v1`). The code this described was removed before it shipped. Kept for the 17:11 trace and the reasoning.

**Status:** defined in NEURO (`backend/services/attention-decision.js`), composed onto
`GET /api/canonical/now` as `decision`. **No surface consumes it yet**, and it is **not
deployed**. Wiring the live control and SAiM Alt to it is the next step.

## Why

At 17:11 on 14 Oct 2026 one `/api/canonical/now` payload held three different leads:

| Selector | Where it runs | It picked |
|---|---|---|
| `attention.gate` → `primary` | NEURO | EOD ritual context card |
| `presentation-intent` → `mode` / `situation` | NEURO, rendered by the live control | "Something needs you" (any pending approval makes the mode `needs-attention`) |
| `workingView` | SAiM Alt's own client model | the running 16:00–17:30 task block |

Surfaces may differ in layout. They may not pick a different primary. From now on NEURO
decides once and every surface renders that decision.

## Shape

```
decision: {
  contract: 'attention-decision-v1',
  decidedAt,
  primary:   { kind, rule, id, title, reason, start?, end?, stale?, handOff?, actions: [{ say, intent }] },
  context:   { activity, doing, meeting, block, ritual, protected, place, desk },
  secondary: { held: [...], next, after, judgement, corrections: [{ taskId, reason }] },
  known:     { blocks, agenda, approvals },
  trace:     [{ rule, applies, why }]
}
```

- **`primary.kind`** is one of: `blind`, `item`, `meeting`, `needs-you`, `block`, `protected`, `ritual` or `none`.
- **`context`** is kept whether or not it won. A ritual that lost to a block is still context.
- **`secondary.held`** is everything the primary displaced: a ritual, attention's top item, overdue and due-today tasks, and the gate's dropped items.
- **`secondary.next`** is the first thing starting later today. A solo task block counts.
- **`secondary.judgement`** is waiting approvals when they are not the primary.
- **`trace`** lists every rule considered, in order, up to and including the one that chose.

## Precedence

The first rule that applies wins the primary:

1. **P1 blind** — the attention pool could not be read.
2. **P2 critical** — an attention item rated `critical`, such as a breaching escalation.
3. **P3 meeting** — a running meeting with other people in it.
4. **P4 deadline** — a governed approval whose window closes within 60 minutes (`APPROVAL_INTERRUPT_MINUTES`).
5. **P5 block** — a running task block. It outranks rituals, due-today work, ordinary items and approvals that still have time.
6. **P6 approvals** — a waiting approval, when no block is protecting the time.
7. **P7 item** — attention's top item (decision-engine's ranking).
8. **P8 protected** — a running solo diary entry that is not a task block.
9. **P9 upcoming** — a task block inside its lead window.
10. **P10 ritual** — the standup or end-of-day wrap, or a meeting about to start.
11. **P11 none** — nothing applies. Said honestly, never padded.

## The approval decision (Nick asked for it, 14 Oct 2026)

**A drafted agenda request does not interrupt an active task block.** While the block is
protected, it stays visible as `secondary.judgement`. It becomes primary only in two cases:

- no block is running (P6), or
- its own window closes within 60 minutes (P4).

Why:
- An approval is a hand-off to the desktop that can wait for a block to end. Build 9 kept it out of the decision pool and the operation phases for that reason.
- The block is what Nick has already decided to be doing, and his difficulty is starting, not knowing.

The window is `prepared_actions.expires_at`, carried as `approvals.soonestExpiresAt`. On
14 Oct the agenda request expires at 06:00 the next morning, 768 minutes after 17:11.

## Live trace, 14 Oct 2026 17:11 BST (one capture, three selectors)

| | Live control (today) | SAiM Alt (today) | `attention-decision-v1` |
|---|---|---|---|
| Primary | "Something needs you" — the agenda-request approval | Active 16:00–17:30, NT-24162 | **block 115, NT-24162 (rule P5)** |
| Rule | presentation mode: `needsYou.length > 0` | client `workingView`: running meeting, then block | P1–P4 do not apply; P5 applies |
| Ritual (EOD) | not shown | held | context + held |
| Approval | primary | judgement card | `secondary.judgement` (deadline in 768 min) |
| Due today | NEXT list, "today · planned date" | held | held (West Hants flagged as stale wording) |
| Next | Tomorrow 09:00 London Office Regroup | none today | none today |

The source payloads are in the session's trace capture. Reproduce with `canonical/now`,
`adhd`, `task-blocks`, `session` and `prepared_actions.expires_at` from the same minute.

## Not yet done (needs Nick's go-ahead, because it changes the production control)

1. Deploy the backend so that `decision` exists on the Pi.
2. **Control.** `presentation-intent` takes its mode, headline and summary from `decision.primary`, so the live Surface leads with what the decision chose. Layout stays the same.
3. **Alt.** `workingView` renders `decision` and stops choosing its own primary.
4. A parity test fails if either surface's lead differs from `decision.primary` for the same payload.
