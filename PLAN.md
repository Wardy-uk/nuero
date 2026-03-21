# NEURO — Snag List Implementation Plan

**Source:** `NEURO-claude-code-prompt.md`
**Updated:** 2026-03-21

---

## Execution Order

| # | Snag | Description | Files |
|---|------|-------------|-------|
| 1 | 007 | Apple Pencil / Scribble support in CapturePanel | CapturePanel.jsx, CapturePanel.css |
| 2 | 003 | Inbox scanner never starts | server.js |
| 3 | 004 | QA route mismatch — frontend calls endpoints that don't exist | routes/qa.js |
| 4 | 005 | Photo capture timestamp collision — two timestamp() calls diverge | routes/capture.js |
| 5 | 006 | Missing apple-touch-icon for iOS PWA | index.html, manifest.json, generate-icons.js |
| 6 | 008 | Missing env vars in .env.example | .env.example |
| 7 | 009 | Cache has no TTL — stale data served forever | cacheStore.js, useCachedFetch.js |
| 8 | 010 | Decisions have no read endpoint | routes/chat.js |

---

## Constraints

- Node.js CommonJS only, no ESM, no TypeScript
- No new npm packages unless explicitly noted
- React 18, Vite, no router — `activeView` state in App.jsx
- sql.js (not better-sqlite3)
- Do not commit — leave that for the user
