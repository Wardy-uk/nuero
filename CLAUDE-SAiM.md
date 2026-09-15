# CLAUDE.md — NEURO / SAiM

## Project
NEURO is a personal operating system. SAiM (Systematic Action & Response Agent) is the directive and interaction layer — the voice, the nudge, the challenge.

This is V1.5: enhancing the existing React/Vite PWA with SAiM's personality, screens, and UX. No new infrastructure. Same backend on Pi 5.

Read `SAiM-IOS-PROJECT.md` for full product spec, personality guide, screens, and version roadmap.

## Stack
- React 18, Vite, PWA
- Node.js/Express backend (DO NOT MODIFY unless explicitly asked)
- Backend at `http://100.69.158.50:3001/api/` with `x-neuro-pin` auth
- SSE streaming on `/api/chat` and `/api/nudges/stream`

## SAiM Personality (critical — read full guide in SAiM-IOS-PROJECT.md)
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
1. Briefing (Home) — SAiM's opening line + priority action cards + quick stats
2. SAiM (Chat + Voice) — SSE streaming chat, Web Speech API voice I/O
3. Standup — guided morning flow
4. Queue (Jira) — SAiM's triage: act now / today / watch
5. Team (People Board) — grid with SAiM status words
6. Focus (Do Next) — one task, escalating defer language
7. Todos — full CRUD backlog
8. Vault — browse/search/read with SAiM's contextual picks
9. Capture — text, todo, dictation
10. Settings — Pi connection, SAiM personality dial, notifications

## DO NOT
- Modify the backend unless explicitly instructed
- Use light mode anywhere
- Make SAiM sound like a generic AI assistant
- Add analytics or tracking
- Hardcode PIN or base URL

## Build Order
1. SAiM personality layer (system prompt update, microcopy)
2. Briefing screen
3. SAiM chat with voice
4. Queue with triage ordering
5. Team with SAiM assessments
6. Focus with defer escalation
7. Remaining screens (Standup, Todos, Vault, Capture, Journal)
8. Web Push notifications for SAiM nudges
9. Dark mode redesign
10. Settings + polish
