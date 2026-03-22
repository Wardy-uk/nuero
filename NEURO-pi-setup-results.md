# NEURO Pi Setup Results — 2026-03-22

## Vault
- **Option A** — Pi has its own clone at `/home/nickw/nuero-vault`
- Remote: `git@github.com:Wardy-uk/obsidian.git` (main)
- VaultSync watcher active — debounce 30s, pull every 5m
- `OBSIDIAN_VAULT_PATH=/home/nickw/nuero-vault`

## Strava
- **Authenticated: YES**
- Tokens seeded from .env into DB on startup
- `seedTokensFromEnv()` added to strava.js, called in server.js after db.init()
- Activities endpoint returns empty array (no activity today — correct)

## Push Notifications
- **VAPID configured: YES**
- Keys generated on Pi and added to both Pi and Windows .env
- 1 subscription registered
- `VAPID_SUBJECT=mailto:nickw@nurtur.tech`

## Timezone
- **Europe/London: YES** (GMT, +0000 — will auto-shift to BST)

## Full Status
| Service | Status |
|---|---|
| Claude AI | configured |
| Jira | configured, syncing (12 tickets) |
| Obsidian | configured |
| Microsoft 365 | configured, NOT authenticated (needs device code flow) |
| n8n | configured |
| Push | configured, 1 subscription |
| Strava | configured, authenticated |
| Health | no data yet (iOS Shortcut not set up) |
| VaultSync | enabled, watching, synced |

## Remaining Gaps
- **Microsoft 365**: configured but not authenticated — needs device code auth flow from NEURO Settings
- **Apple Health**: no data — requires iOS Shortcut setup (optional)
