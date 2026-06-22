# SARA V1.5 — Claude Code Bootstrap Prompt

Paste this as your opening message when you open the NEURO repo in Claude Code:

---

Read CLAUDE-SARA.md and SARA-IOS-PROJECT.md before doing anything.

This is SARA V1.5 — we're enhancing the existing NEURO PWA with SARA's personality and a redesigned UX. The backend stays untouched. We're only changing the frontend and the system prompt sent to Ollama.

Before you write any code, do the following:

1. Read the existing frontend structure in `frontend/src/` — understand what components exist and how App.jsx routes between views
2. Read `backend/services/claude.js` — understand the current system prompt and how context is assembled
3. Read `backend/services/ollama-provider.js` — understand how Ollama calls are made
4. Read `frontend/src/api.js` — understand how the frontend talks to the backend
5. Read `frontend/src/App.jsx` — understand the current navigation and layout

Then give me a brief summary of what exists and a proposed plan for applying SARA V1.5 in phases, starting with the system prompt personality change and the Briefing (home) screen.

Do not start coding until I approve the plan.

---

That's it. One prompt. It'll read the specs, audit the codebase, and come back with a plan for you to approve before touching anything.
