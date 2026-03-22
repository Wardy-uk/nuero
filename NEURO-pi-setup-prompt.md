# NEURO — Pi Configuration & Strava Debug Handoff

## Context

NEURO backend runs on a Raspberry Pi accessible via Tailscale at:
- IP: 100.69.158.50
- Hostname: pi-dev.tailecb90f.ts.net
- Port: 3001

The `/api/status` endpoint was checked from iPhone and returned the following issues:
- `strava: { configured: true, authenticated: false }` — Strava keys present but OAuth not complete
- `obsidian: { configured: false }` — vault path is a Windows path, doesn't exist on Pi
- `push: { configured: false }` — VAPID keys missing
- `vaultSync: { vaultExists: false }` — confirms vault path wrong on Pi

The `.env` on the Windows laptop (`C:\Users\NickW\nick-agent\backend\.env`) has been
updated with Strava keys. The Pi has its own `.env` which is a SEPARATE file and has
NOT been updated yet.

The codebase on the Windows machine is the source of truth. The Pi runs its own copy.

---

## Your tasks — work through these in order

### Task 1 — Read the current Pi .env

SSH into the Pi and read the current backend .env:
```bash
cat ~/nick-agent/backend/.env
```

Document what's there vs what's missing compared to the Windows .env at
`C:\Users\NickW\nick-agent\backend\.env`.

---

### Task 2 — Fix the vault path on the Pi

The Pi's .env has `OBSIDIAN_VAULT_PATH=C:\Users\NickW\Documents\Nicks knowledge base`
which is a Windows path that doesn't exist on the Pi.

The vault needs to be accessible from the Pi. There are two options:

**Option A — Pi has its own clone of the vault (preferred)**
Check if the vault already exists on the Pi:
```bash
ls ~/obsidian-vault 2>/dev/null || ls ~/vault 2>/dev/null || find ~ -name "*.md" -path "*/Daily/*" 2>/dev/null | head -5
```

If a vault clone exists, update `OBSIDIAN_VAULT_PATH` in the Pi's .env to point to it.

If no vault exists on the Pi, clone it from the existing git remote:
```bash
# Check what remote the Windows vault uses
# The vault git remote should be github.com/Wardy-uk/obsidian (private repo)
git clone git@github.com:Wardy-uk/obsidian.git ~/obsidian-vault
```
Then set `OBSIDIAN_VAULT_PATH=/home/[username]/obsidian-vault`

**Option B — Mount the Windows vault over the network**
Only use this if the Pi and Windows machine are on the same LAN. SMB or NFS mount.
This is fragile — prefer Option A.

Document which option you chose and what the new path is.

---

### Task 3 — Add missing Strava keys to Pi .env

The Windows .env now has:
```
STRAVA_CLIENT_ID=214901
STRAVA_CLIENT_SECRET=1a24b2230dfb845eba586ea663822725f0528b28
STRAVA_ACCESS_TOKEN=a8c6f86161baab9aa4aee3fcef53988936d6e0f7
STRAVA_REFRESH_TOKEN=b90c92b28afdc2ec3bedce4c78c9c24c516f0337
STRAVA_REDIRECT_URI=http://pi-dev.tailecb90f.ts.net:3001/api/strava/callback
```

Add all five to the Pi's .env. Do not overwrite existing values — append or edit
carefully.

---

### Task 4 — Seed Strava tokens into the database

The `strava.js` service reads tokens from `agent_state` (SQLite DB), not from .env.
The .env tokens won't be used automatically — we need to seed them into the DB.

Read `backend/services/strava.js` in full first.

Add a startup seed function that runs once on server start. In `strava.js`, add
before `module.exports`:

```js
// Seed tokens from env into DB if DB is empty (first-time setup)
function seedTokensFromEnv() {
  try {
    const existing = db.getState('strava_access_token');
    if (existing) return; // already have tokens in DB

    const accessToken = process.env.STRAVA_ACCESS_TOKEN;
    const refreshToken = process.env.STRAVA_REFRESH_TOKEN;
    if (!accessToken || !refreshToken) return;

    db.setState('strava_access_token', accessToken);
    db.setState('strava_refresh_token', refreshToken);
    // Set expiry to 1 hour from now — will trigger a refresh on first use
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    db.setState('strava_token_expiry', String(expiry));
    console.log('[Strava] Seeded tokens from environment variables');
  } catch (e) {
    console.error('[Strava] Failed to seed tokens:', e.message);
  }
}
```

Add `seedTokensFromEnv` to `module.exports`.

Then read `backend/server.js`. In the `start()` function, after `db.init()`, add:
```js
  // Seed Strava tokens from env if not already in DB
  require('./services/strava').seedTokensFromEnv();
```

`node --check backend/services/strava.js`
`node --check backend/server.js`

---

### Task 5 — Generate and add VAPID keys for push notifications

On the Pi:
```bash
cd ~/nick-agent
npx web-push generate-vapid-keys
```

This outputs a public and private key. Add them to the Pi's .env:
```
VAPID_PUBLIC_KEY=[generated public key]
VAPID_PRIVATE_KEY=[generated private key]
VAPID_SUBJECT=mailto:nickw@nurtur.tech
```

---

### Task 6 — Restart NEURO on the Pi

```bash
pm2 restart neuro
pm2 logs neuro --lines 30 --nostream
```

Look for:
- `[Strava] Seeded tokens from environment variables` — confirms Task 4 worked
- `[Server] NUERO running on 0.0.0.0:3001` — server started
- Any errors related to vault path, database, or Strava

---

### Task 7 — Verify Strava is now authenticated

From the Pi, test the Strava status:
```bash
curl http://localhost:3001/api/strava/status
```

Should return `{ "configured": true, "authenticated": true }`.

If `authenticated` is still false, check the logs for why the token seeding failed.

Also test that today's activities can be fetched:
```bash
curl http://localhost:3001/api/strava/activities/today
```

---

### Task 8 — Verify obsidian is now configured

```bash
curl http://localhost:3001/api/status | python3 -m json.tool | grep -A2 obsidian
```

Should show `configured: true`.

Also test the vault is readable:
```bash
curl http://localhost:3001/api/standup/ritual-state
```

---

### Task 9 — Check timezone

```bash
timedatectl
```

If timezone is NOT Europe/London:
```bash
sudo timedatectl set-timezone Europe/London
pm2 restart neuro
```

This is important — if Pi is on UTC, all cron times (9am standup, 5pm EOD, 9pm journal)
fire 1 hour late during BST.

---

### Task 10 — Full status check

Hit the status endpoint and document the result:
```bash
curl http://localhost:3001/api/status | python3 -m json.tool
```

Every service should now show as configured. Document any remaining gaps in
`NEURO-pi-setup-results.md`.

---

### Task 11 — Update the Windows .env to match

Once the Pi .env is correct, read it and update the Windows .env at
`C:\Users\NickW\nick-agent\backend\.env` to match (except for path differences).

Specifically add:
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`

to the Windows .env so they're in sync for future reference.

---

## After all tasks

Write `NEURO-pi-setup-results.md` with:
- Vault path used (Option A or B, what path)
- Strava: authenticated yes/no
- Push: VAPID configured yes/no
- Timezone: confirmed Europe/London yes/no
- Any remaining issues

Do not commit to git.
