# NUERO

**Nick's Unified Executive Resource Orchestrator**

Personal AI chief of staff. Self-hosted ops dashboard with Jira queue monitoring, Obsidian vault integration, and LLM-powered conversational AI.

## Prerequisites

- Node.js 18+ (tested on ARM64/Snapdragon, portable to Raspberry Pi)
- Ollama running locally (or Claude API key for reasoning tasks)
- (Optional) Jira Service Management instance with API token access

## Setup

1. **Clone and install:**

```bash
git clone https://github.com/Wardy-uk/neuro.git
cd neuro
npm install
```

2. **Configure environment:**

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` with your credentials:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `OLLAMA_URL` | Ollama endpoint (default: `http://localhost:11434`) |
| `OLLAMA_MODEL` | Ollama model for classification (default: `qwen2.5:1.5b`) |
| `JIRA_BASE_URL` | e.g. `https://yourcompany.atlassian.net` |
| `JIRA_EMAIL` | Email used for Jira authentication |
| `JIRA_API_TOKEN` | Jira API token |
| `JIRA_PROJECT_KEY` | The project key for your support queue (e.g. `SUP`) |
| `OBSIDIAN_VAULT_PATH` | Full path to your Obsidian vault |
| `PORT` | Backend port (default: 3001) |

The app starts cleanly even without Jira credentials — the dashboard will show "not configured" state.

3. **Run:**

```bash
npm run dev
```

This starts:
- Backend on `http://localhost:3001`
- Frontend on `http://localhost:5173` (proxies API calls to backend)

For production:

```bash
cd frontend && npm run build
cd ../backend && npm start
```

## Architecture

- **Backend:** Node.js + Express (CommonJS)
- **Frontend:** React + Vite
- **LLM:** Ollama (classification) + Claude API (reasoning)
- **Queue data:** Jira REST API v3, polled every 5 minutes via node-cron
- **Storage:** SQLite at `backend/db/agent.db`
- **Knowledge base:** Direct filesystem reads/writes to Obsidian vault
- **Nudges:** Proactive standup/todo reminders via SSE, escalating nag messages

## Key features

- **Live SLA monitoring** — tickets flagged at-risk when SLA < 2 hours
- **Chat with context** — LLM receives queue state, daily note, and standup template with every message
- **Decision logging** — when the LLM flags `[DECISION]`, it's auto-logged to the Obsidian vault
- **Standup drafts** — edit and save standup notes directly to your Obsidian daily note
- **Nudge system** — 9am standup check, escalating nags every 15 min, snooze, auto-clear
- **People board** — team cards pull from Obsidian vault notes with frontmatter/tag support
- **90-day plan tracker** — visual progress against your leadership transition plan

## Project structure

```
neuro/
  backend/
    server.js           # Express entry point
    routes/             # API route handlers
    services/           # Business logic (Jira, LLM, Obsidian, scheduler, nudges)
    db/                 # SQLite database + schema
  frontend/
    src/
      App.jsx           # Root layout
      components/       # UI components
  package.json          # Workspace root
```
