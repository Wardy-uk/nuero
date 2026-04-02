# NEURO — Snag List Task Tracker

**Updated:** 2026-03-23

---

## Pending — Due 2026-04-06

- [ ] AI cost reduction — Phase 2 (Pi 5 8GB — when hardware arrives)
  - Pull qwen2.5:7b on new Pi
  - Swap OLLAMA_TRIAGE_MODEL=qwen2.5:7b in .env
  - Move transcript-processor.js to Ollama (7B handles structured JSON from transcripts)
  - Add intent-based chat routing: simple factual queries → Ollama, complex/drafting → Claude
  - Test quality of all Ollama services vs Claude baseline
  - Review Claude spend — target under $0.50/day

---

## Completed

- [x] SNAG-007 — Apple Pencil / Scribble support in CapturePanel
- [x] SNAG-003 — Wire inbox-scanner.start() in server.js
- [x] SNAG-004 — Add /health and /drift route aliases to QA routes
- [x] SNAG-005 — Fix photo + file capture timestamp collision
- [x] SNAG-006 — Add apple-touch-icon and PNG icons for iOS PWA
- [x] SNAG-008 — Update .env.example with all env vars
- [x] SNAG-009 — Add cache TTL to cacheStore and useCachedFetch
- [x] SNAG-010 — Add decisions GET endpoint to chat routes
- [x] Ollama cost reduction Phase 1 — email triage, inbox scanner, journal prompts, standup, context scoping

---

## Post-Implementation

- [x] Run `cd frontend && npm run build` — clean (231 modules, 1.94s)
- [x] All `require()` calls in server.js resolve (inbox-scanner added)
