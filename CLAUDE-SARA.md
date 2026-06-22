# CLAUDE.md — NEURO / SARA

## Project
NEURO is a personal operating system. SARA (Systematic Action & Response Agent) is the directive and interaction layer — the voice, the nudge, the challenge.

This is V1.5: enhancing the existing React/Vite PWA with SARA's personality, screens, and UX. No new infrastructure. Same backend on Pi 5.

Read `SARA-IOS-PROJECT.md` for full product spec, personality guide, screens, and version roadmap.

## Stack
- React 18, Vite, PWA
- Node.js/Express backend (DO NOT MODIFY unless explicitly asked)
- Backend at `http://100.69.158.50:3001/api/` with `x-neuro-pin` auth
- SSE streaming on `/api/chat` and `/api/nudges/stream`

## SARA Personality (critical — read full guide in SARA-IOS-PROJECT.md)
- Decisive, grounded, challenging, present, controlled
- Never opens with "Sure!", "Of course!", "Absolutely!"
- Never hedges when she has a recommendation
- Short sentences when driving action
- Picks a direction, doesn't present menus
- Acknowledges wins without ceremony ("That's done. Nice.")
- Will call out avoidance, drift, weak decisions

## Design Rules
- Dark mode ONLY — no light mode
- Background: `#0d0f14`
- Accent: `#4f9cf9`
- Warning: `#f0a040`
- Danger: `#e05555`
- Success: `#40c97a`
- IBM Plex Mono for data/labels, IBM Plex Sans / system font for body
- No rounded corners except 4-6px on cards
- No gradients
- Dense, information-rich layout — ops dashboard not consumer app
- Every screen must work for a 3-second glance

## V1.5 Screens (10 screens)
1. Briefing (Home) — SARA's opening line + priority action cards + quick stats
2. SARA (Chat + Voice) — SSE streaming chat, Web Speech API voice I/O
3. Standup — guided morning flow
4. Queue (Jira) — SARA's triage: act now / today / watch
5. Team (People Board) — grid with SARA status words
6. Focus (Do Next) — one task, escalating defer language
7. Todos — full CRUD backlog
8. Vault — browse/search/read with SARA's contextual picks
9. Capture — text, todo, dictation
10. Settings — Pi connection, SARA personality dial, notifications

## DO NOT
- Modify the backend unless explicitly instructed
- Use light mode anywhere
- Make SARA sound like a generic AI assistant
- Add analytics or tracking
- Hardcode PIN or base URL

## Build Order
1. SARA personality layer (system prompt update, microcopy)
2. Briefing screen
3. SARA chat with voice
4. Queue with triage ordering
5. Team with SARA assessments
6. Focus with defer escalation
7. Remaining screens (Standup, Todos, Vault, Capture, Journal)
8. Web Push notifications for SARA nudges
9. Dark mode redesign
10. Settings + polish
