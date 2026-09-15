# SARA → SAiM — what the repo did, and what only you can do

**15 Sep 2026.** SARA is now **SAiM** — *Situational Awareness & Intelligence Module*, pronounced
"Sam". The rename swept **3,524 references across 532 files** and **324 file and directory paths** in
`nuero`, plus **758 references across 134 files** in `nuero-ios`.

The code is done and green. This file is the part that lives outside git.

---

## 1. The spelling rules the rename used

| Context | Becomes | Example |
|---|---|---|
| Prose, display, headings, kebab filenames | `SAiM` | `SAiM Insight`, `SAiM-IOS-PROJECT.md` |
| Env vars and `SCREAMING_SNAKE` constants | `SAIM` | `SAIM_HA_TOKEN`, `SAIM_LITE_TABS` |
| PascalCase identifiers | `Saim` | `resolveSaimLiteTab`, `SaimState.swift` |
| paths, slugs, snake_case, URLs | `saim` | `saim/app`, `saim_actions`, `saim.nickward.co.uk` |

⚠ **`sara` followed by `h` was never matched.** `sensor.sarahs_iphone_*` in
`ha-phone-prefix.test.js` is a real person's device, and the guard is in every rule rather than
bolted onto one.

---

## 2. What was deliberately NOT renamed

Each of these is **identity or stored state**, not branding. Renaming them does not fail loudly — it
fails silently, which is worse. Every one carries a comment at its site saying so.

| Kept as `sara` | Where | What breaks if you rename it |
|---|---|---|
| `uk.co.nickward.sara*` bundle ids | `nuero-ios` | iOS treats it as a NEW app: calendar, health and notification permissions reset, stored PIN gone |
| `group.uk.co.nickward.sara` | `nuero-ios` | App Group container orphaned — the widget's cached payload and shared state |
| `sara-outbox.json`, `sara-watch-outbox.json` | `Saim/SaimState.swift`, `SaimWatch/WatchState.swift` | ⚠ **Holds captures that have not reached NEURO.** A renamed file reads as an empty queue and the unsent captures are orphaned in the container |
| `sara-widget-snapshot.json`, `sara.voiceOut`, `sara.tts.voice`, `sara.nudge.*`, `sara.liveActivity.*` | `nuero-ios` | On-device state; a renamed key reads as absent and silently resets a choice you made |
| `applicationId = "uk.nickward.sara.sensor"` | `saim/android-sensor` | Installs alongside the existing app instead of upgrading it; Bluetooth/Location permissions and provisioning lost |
| `getSharedPreferences("sara_sensor")` | `Settings.kt` | Holds the tablet's provisioned NEURO token and room — it would come up unprovisioned and report nothing |
| `Documents/System/SARA Import Reports/` | the vault | Reports already written under that name; it stays in `vault-exclusions` so they are never indexed |

The Android `namespace` **was** renamed to `uk.nickward.saim.sensor` — that is the R-class/BuildConfig
package and is independent of `applicationId`. This is the normal Android split, and it means the new
build **upgrades the tablet app in place** and keeps its provisioning.

---

## 3. Backward compatibility that is now in the code

These exist because the old names are still in your live database, your vault and an iOS build that
has not been rebuilt. All are pinned by `backend/services/saim-rename-compat.test.js` (17 tests, four
of them mutation-checked) and all are **safe to delete later**.

- **`backend/db/database.js` → `renameSaraArtefacts()`** — runs **before** `schema.sql`, which is the
  whole mechanism. Run it after and `CREATE TABLE IF NOT EXISTS saim_actions` mints an empty table
  beside the real one, the rename then fails because the target exists, and the approval queue reads
  as nothing pending. Renames `sara_actions` → `saim_actions` with its rows and indexes, **copies**
  `agent_state` keys (`sara_greetings`, `ai_setting_sara_mode`), and moves `apns_tokens.app` from
  `sara` to `saim`.
- **`shared/legacy-env.cjs`** — carries `SARA_*` env vars over to `SAIM_*` at boot in both backends.
  See §4.1.
- **`backend/services/legacy-names.js`** — vault frontmatter keys, `## SARA Insight` /
  `## SARA Actions` headings, and `managed_by: sara-knowledge-memory` values. Without it every
  knowledge note reads as un-enriched and is re-enriched with a **paid model call**, and consolidated
  notes look unmanaged and get consolidated again.
- **`apns.validate`** accepts `app: 'sara'` and normalises it, because the installed iOS build sends
  it on every launch until the Mac rebuild.
- **`.env.production`** lists **both** `sara.*` and `saim.*` in `VITE_ALLOWED_HOSTS`.
- `sara:` still works as a Capture prefix; `sara_voice_out` / `sara_tts_voice` still read from
  `localStorage`; `sara-capture` still resolves to a task provenance label; mutes recorded `by: sara`
  still read as SAiM having muted herself.

---

## 4. What only you can do

### 4.1 The Pi — `.env` files ⚠ do this with the deploy

`.env` is gitignored, so **the rename did not touch a single one**. `saim/backend/.env` on this laptop
has been updated; the Pi's has not.

```bash
# on pi5, after pulling
cd /mnt/data/nuero/saim/backend
sed -i.bak -E 's/^(\s*)SARA_/\1SAIM_/' .env
grep -oE '^[A-Za-z0-9_]+' .env      # confirm: SAIM_PORT, SAIM_HA_* …
# same for /mnt/data/nuero/backend/.env if it holds any SARA_* keys
```

`shared/legacy-env.cjs` means it keeps working if you forget — it copies the old names over at boot
and **logs which ones it carried, by name, never by value**. Treat that log line as a to-do, not a
resolution.

### 4.2 The Pi — the leftover `sara/` directory

`git mv` moves **tracked** files only, so after pulling, `sara/` still holds `node_modules`, `dist`,
`logs` and — the one that matters — **`sara/backend/.env`**.

```bash
cd /mnt/data/nuero
mv sara/backend/.env saim/backend/.env          # do this FIRST, it holds credentials
for d in app backend frontend; do [ -d sara/$d/node_modules ] && mv sara/$d/node_modules saim/$d/node_modules; done
mv sara/logs saim/logs 2>/dev/null
rm -rf sara
```

⚠ Do not leave a stray `.env` in an abandoned directory — it carries `NEURO_PIN` and
`NEURO_VAULT_KEY`.

### 4.3 The Pi — PM2

The running process is still called `sara-backend`; the ecosystem file now says `saim-backend`.
Starting the new one without deleting the old leaves **two processes on port 3005**.

```bash
pm2 delete sara-backend
pm2 start /mnt/data/nuero/saim/runtime/ecosystem.config.js
pm2 save
```

### 4.4 The Pi — systemd units

Installed units are still named `sara-*`. Rename or reinstall:
`saim-terminal.service`, `saim/sensor/saim-display-agent.service`, `saim/sensor/saim-room-sensor.service`.

```bash
sudo systemctl disable --now sara-display-agent.service sara-room-sensor.service
sudo cp saim/sensor/saim-*.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now saim-display-agent saim-room-sensor
```

### 4.5 Netlify ⚠ the next push fails without this

The site `sara-nickward` has its **base directory** set to `sara/app`. That path no longer exists, so
the build fails immediately.

⚠ **A green Netlify dashboard today proves nothing about this** (nuero-4a's point, and it is a good
one). Netlify keeps serving the last good build, so nothing breaks at the moment the path changes —
it breaks at the NEXT PUSH, possibly days later and attributed to whatever was pushed then. This is
the one item on the list that fails silently in the future rather than now.

**Done already (15 Sep, via the Netlify MCP):** the site is renamed `sara-nickward` →
**`saim-nickward`**, and it was confirmed to have **no UI environment variables**, so the committed
`.env.production` really is the single source of truth its comment claims. Only this one site is
affected — `nuero-app` (base `frontend`) and `vesta-nickward` (base `vesta`) sit on paths the rename
never touched.

**Left for you, and it genuinely cannot be automated:**

1. ✅ Site settings → Build & deploy → **Base directory** → `saim/app` — **done 15 Sep**, build green,
   `<title>SAiM Mobile</title>` serving.
2. ❌ **The custom domain is DELIBERATELY NOT MOVED.** Nick's call, 15 Sep 2026. It stays
   `sara.nickward.co.uk`, and `saim.nickward.co.uk` has no DNS record.

   ⚠ **This is a decision, not an outstanding task — do not "finish" it.** Netlify redirects a
   non-primary domain to the primary, so there is no way to serve both as real addresses: for
   `saim.` to be the address it must be primary, and `sara.` then redirects to it. That changes the
   PWA's **ORIGIN**, and `localStorage` and IndexedDB are per-origin — the stored PIN and, the one
   that matters, **anything unsent in the outbox** would be stranded somewhere no longer reachable.
   The whole benefit is a URL that reads better. Not worth spending a capture on.

   Consequences, all deliberate: `VITE_ALLOWED_HOSTS` keeps its three `sara.*` entries permanently;
   `VITE_CANONICAL_URL` stays `https://sara.nickward.co.uk`, because it is DeploymentGuard's
   "open the correct site" link and a dead host makes the one recovery route a dead end. Both are
   commented at their site. If the domain is ever actually moved, drain every device's outbox first.

⚠ **Why the base directory is not done for you.** Two independent reasons, both checked rather
than assumed: the Netlify MCP exposes six write operations — project name, env vars, forms, visitor
access, create-project and deploy-site — and **build settings are not among them**; and it cannot go
in the repo's root `netlify.toml` either, because that file is **shared by several sites** and says
so in its own comment (`nuero-app → base: frontend | saim-nickward → base: saim/app`). Setting
`base` there would repoint `nuero-app` at the wrong directory.

Until you do 2 and 3, the old hostnames are still in `VITE_ALLOWED_HOSTS`, so the installed PWA keeps
loading. **Take the three `sara.*` entries out of `.env.production` once the move is done** — leaving
them is how a host guard quietly stops guarding anything.

### 4.6 Home Assistant ⚠ the voice pipeline stops until this is done

The custom component's directory and domain are now `saim`, so HA cannot load the existing config
entry and `conversation.sara` disappears.

1. Copy `homeassistant/custom_components/saim/` to the HA config dir; delete the old `sara/` folder.
2. Restart HA.
3. Settings → Devices & Services → remove the old **SARA** integration, add **SAiM** (it will ask for
   the NEURO base URL and token again — they are in the config entry, not the repo).
4. ⚠ Settings → Voice assistants → the **SAiM watch** pipeline → set the conversation agent to
   **SAiM** (`conversation.saim`). A pipeline's agent must be changed **through the UI or the
   websocket API** — HA holds `.storage` in memory and rewrites it, so a hand edit under a running
   instance is silently discarded.
5. The bare **Home Assistant** pipeline stays on HA's own agent — that is the way back.

### 4.7 iOS — rebuild on the Mac

**Its own handoff: `HANDOFF-SAiM-rename.md` in the `nuero-ios` repo.** That is where the build order,
the identity exceptions and the on-device checks live.

Bundle ids are unchanged, so this **upgrades in place**: permissions, the App Group container and the
outbox all survive. Nothing is required before the rebuild — the backend accepts the old build's
`app: 'sara'` registration in the meantime.

### 4.8 Windows — the desktop app

⚠ SAiM desktop is **running right now from `sara/desktop-electron`**, which is why that one
`node_modules` could not be moved. Close it, then:

What is left in `sara/` locally is that locked `node_modules` plus `sara/logs` (four pm2 log
files). The `.env`, the other three `node_modules`, `dist` and `.netlify` are already moved.

```powershell
# close SAiM desktop first, then:
Move-Item "C:\Users\NickW\Claude\nuero\sara\logs" "C:\Users\NickW\Claude\nuero\saim\logs"
Remove-Item -Recurse -Force "C:\Users\NickW\Claude\nuero\sara"
cd "C:\Users\NickW\Claude\nuero\saim\desktop-electron"; npm install
```

Repoint the Desktop shortcut / `SAiM.vbs` at `saim\desktop-electron`.

### 4.9 The vault

Nothing needs doing. `Documents/System/SARA Import Reports/` stays where it is and stays excluded
from indexing; new reports go to `SAiM Import Reports/`. Notes are not rewritten — see
`Projects/NEURO/SARA is now SAiM.md`.

---

## 5. Known-good state at handover

- `backend` — **3,855 tests, 3,854 pass, 1 skipped, 0 fail** (six consecutive clean runs).
- `saim/backend` — 240 tests, 238 pass, **2 fail**. ⚠ Both are `approach-eclipse.test.js` CSS
  assertions about `max-height` on `.approach--quiet .approach__row`. **They fail identically on
  pristine `HEAD`** (verified in a detached worktree) — pre-existing, unrelated to the rename, and
  left alone rather than quietly "fixed" as part of it.
- `homeassistant` — 25 tests, all pass.
- `saim/desktop-electron` — 9 tests, all pass.
- Builds: `saim/app`, `saim/frontend`, `frontend`, `vesta` all build clean.
- Not run here: the Android unit tests (no JDK/Gradle on this machine) and the Swift tests (no Mac).
