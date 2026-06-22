# Skill: Session Handoff

When a session is ending (context getting long, task switching, or Nick says "write a handoff"), create or update `.claude/memory/handoff.md` with a structured summary.

## Format

```markdown
# Session Handoff — YYYY-MM-DD HH:MM

## What was done
- [completed item 1]
- [completed item 2]

## What's still pending
- [pending item 1 — where it's at, what's left]
- [pending item 2]

## Key decisions made
- [decision and why]

## Files changed
- `path/to/file.js` — [what changed]

## Gotchas for next session
- [anything the next session needs to know that isn't in mistakes.md or patterns.md]
```

## Rules

- Overwrite the previous handoff — this is a snapshot, not a log. Only the latest matters.
- Keep it under 40 lines. If you can't, you're including too much detail.
- Don't duplicate what's already in `mistakes.md` or `patterns.md` — reference those instead.
