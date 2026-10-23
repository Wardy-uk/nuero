# Release candidate — AI gate, Settings, receipt truth, Holding the week (23 Oct 2026)

**Status:** DEPLOYED 23 Oct 2026, ~10:36 UTC, in shadow mode (Nick approved). NEURO `main` `11d0631f` (release `eb96f57c` plus the verifier fix `11d0631f`, after a second rebase onto `fdc7fe17`), VANTAGE `main` `fa2c890`. The Pi configuration was applied idempotently, with backups `*.env.bak-ai-gate-2026-10-23`. The live verifier passed: ✔ one shared ledger `f4388203…`, both apps registered, identity matched, lock probe passed. No rollback.

- NEURO branch `saim-budget-gate-slice` (worktree `.claude/worktrees/budget-gate`), rebased onto `main` **`93e6a04f`**. Head **`ca4064ad`**. The pre-rebase ref is kept as `saim-budget-gate-slice-prerebase-2026-10-23`.
- VANTAGE branch `ai-gate-radar` at **`fa2c890`**, already level with VANTAGE `main` (`836b388`, 0 behind).
- **Deploy both together.** They share one gate file and one ledger.

## What ships

| Part | What it does |
|---|---|
| A | One shared **AI gate** in front of every paid, metered and local model call, in both apps. It runs in shadow mode with no cap, and shows in Settings → AI budget and on VANTAGE Admin. |
| B | **Automatic context linking** can be switched on in Settings only; Brain Health is read-only. **It stays off.** |
| C | **Receipt truth.** A receipt says "Done" only when the result was verified. Drafts gains a Today history. |
| D | **Holding the week** cards each lead to a real place, with one primary action. |
| Ledger | An explicit `AI_GATE_DB_PATH` is mandatory, absolute and identical in both apps. It is checked at startup and proven shared by the ledger's own id. |

## Commits (NEURO, on `93e6a04f`)

| Commit | What |
|---|---|
| `a26452a6` | Context linking set in Settings only (B) |
| `4ffdfe03` | Shared AI gate, shadow (A) |
| `5aba24d6` `e530423f` `ba845e54` | Receipt truth; browser test; Today history (C) |
| `e9f50203` | Holding the week cards (D) |
| `e7fc8795` | Inventory, CLAUDE.md, handoff |
| `cbcec8bd` | Real shells for the width check; Electron drivers wait for each element and retry only on transport errors |
| `f71fecac` | Explicit shared ledger path, startup check, cross-app identity |
| `f95862db` `e7e61925` | Mistake log; **incident record** |
| `d8ba9243` | Vault snapshots detect every write again; tests read dependencies by path, never through a junction |
| `14eb753b` | Verifier: access, folder width, WAL, live identity, lock probe |
| `9291aac0` | Reviewed Pi contract (`0700`), docs |
| `ca4064ad` | Two-app race resolves its driver by path |

VANTAGE: `d89aa40` (the gate) and `fa2c890` (the ledger path).

## ⚠ Incident on 23 Oct, closed before this release

A cleanup deleted the laptop's main checkout (`backend/`, `frontend/`, part of `worker/`) through a `node_modules` junction. **It was the third time.** Full record: `docs/incident-2026-10-23-worktree-junction-deletion.md`.

**What came back:**
- All 1,389 tracked files were restored.

**The forensic audit:**
- No uncommitted source existed in those folders. Every session's status snapshot up to 28 minutes before the deletion shows none.
- All 230 recorded Claude edits there since 15 Oct are either present or were committed later.
- `.env`, `agent.db` and the token cache had already been gone since the 19 Oct incident, and nothing recreated them.
- The one unknown is a hand edit made outside Claude, which is unlikely.
- Shadow copies were not read; that needs elevation.

**The safeguard is now enforced, not just noted:**
- A user-level PreToolUse hook blocks every `git worktree remove` and any recursive delete that would go through a junction or symlink. It fails closed when it can't resolve a path.
- The safe route is `~/.claude/hooks/safe-remove.js`.
- The hook **blocked two real calls during this release check.**

## Release checks

1. **No sideways scroll** at 390 px (phone) or 1024×552 / 1280×720 (kiosk). The test mounts the real shells; the earlier 16 px overflow was a harness fault.
2. **Vault-isolation repair.** The weakened assertion is gone; every vault write is detected again.
   - **Abandon test** (`prepared-moves-private-draft`):
     - It compares every vault file, including the generated task export.
     - It drains task-store's debounced writer before each snapshot (`taskStore.flushExport()`).
     - The test now arms that writer itself on every run, so the 23 Oct race is reproduced deterministically, not only under load.
     - **Proof:** with draining disabled, the abandon test fails. Excluding the export again fails the new "snapshot sees the export" check.
     - 12 runs, 6 in parallel: 12/12 pass (31/31 each).
   - **Drafts browser test** (`real-shell-drafts-sections`):
     - The tick legitimately rewrites the export, so the export goes to an isolated location outside the vault (`NEURO_TASK_EXPORT_PATH`, honoured only as an absolute path; production is unchanged).
     - The vault comparison now covers every file, with no stripping.
     - A separate test proves the tick reached the export.
     - **Proof:** putting the export back in the vault fails both tests. 6/6 pass.
   - The browser tests now read the main checkout's dependencies by path (`mainCheckout()` from git's common dir) instead of a junction.
   - The load-retry and wait helpers are kept, because they handle readiness and hide nothing:
     - Retry covers transport errors only, at most 5 times, so a persistent failure still fails.
     - A missing element used to pass through silently into the click; it is now a named failure.
3. **Shared-ledger readiness** — see the Pi configuration below. The verifier reports, each by name:
   - unset, relative or different paths;
   - a missing, unwritable or too-wide folder;
   - an unwritable file;
   - no WAL;
   - an app that isn't registered;
   - a ledger-identity mismatch between the file and either running app;
   - a held lock.

   It has 9 tests, using separate processes, real stub apps and a real second process holding the lock. The identity, lock and folder-width rules are mutation-checked.
4. **Evidence from the rebased state** — below.

## Evidence (rebased branch, head `ca4064ad`)

- **NEURO full suite** (parallel, `ELECTRON_PATH` set): **7,867 tests — 7,843 pass, 4 fail, 20 skipped.**
  - The 4 failures are the clean-`main` ones below.
  - The 20 skips are all environmental:
    - 17 need a `nuero-ios` checkout beside this repo;
    - 1 needs file modes that Windows can't deny;
    - 1 needs symlinks not creatable here;
    - 1 is the opt-in Pi-snapshot parity run.
  - **No browser test skipped.**
  - An earlier run on the rebased branch also failed the two-app race. All 30 of VANTAGE's tickets came back degraded, because its worker found `better-sqlite3` only through the removed junction. The assertion caught it correctly. It now resolves by path (`ca4064ad`): **8/8**.
- **The 12 Electron browser suites, 80 tests, all in parallel, twice: 80/80 and 80/80.**
- **Two-app concurrency** (NEURO's gate and VANTAGE's own copy, $0.05 tickets under a $1 cap, enforce mode): exactly 20 allowed, total at or under the cap, 60 unique ids, every second settle refused — **8/8**.
- **VANTAGE suite: 310/310.**
- **Builds**, each into a temp folder: NEURO frontend ✔, SAiM app ✔, kiosk (`saim/frontend`) ✔, VANTAGE frontend ✔.
  - Dependencies are plain `npm ci --ignore-scripts` installs, scanned and found link-free.
  - VANTAGE's npm workspace adds one link, `node_modules/vantage-frontend`, pointing to its own `frontend/` inside the same worktree. That isn't the cross-checkout hazard, and the guard covers it.
- **Context linking stays off:**
  - The Settings browser test asserts no POST and no backfill on load.
  - The task-context suite pins the off-by-default contract: no scan, link, receipt or table until it is enabled.
  - No allowance was granted and no real governed action ran.

## Known failures on clean current `main` (not this branch)

Each was reproduced in the main checkout at **`93e6a04f`**, and `git diff origin/main` shows the branch touches none of these files.

| Test | Cause |
|---|---|
| `5. Ask and Capture are unchanged…` (quick-log-routing) | Byte-identity check against CRLF line endings in this Windows checkout |
| `the executor records a governed send…` (soap-report) | A regex that does not allow for CRLF |
| `the real October report parses completely` (hilo-import) | Reads a HiLo PDF that exists only on the laptop (it now holds 692 readings against the pinned 438) |
| `route: the real PDF posted as application/pdf…` (hilo-import) | Same laptop-only PDF |

## Pi configuration — reviewed, NOT applied

Measured read-only on pi5:

| | NEURO | VANTAGE |
|---|---|---|
| PM2 | `neuro-backend` | `vantage-backend` |
| Runs as | `nickw` (uid 1000), umask 0022 | `nickw` (uid 1000), umask 0022 |
| Working directory | `/mnt/data/nuero/backend` | `/mnt/data/vantage` |
| Env file it loads | `/mnt/data/nuero/backend/.env` (`dotenv.config()`, relative to the working directory) | `/mnt/data/vantage/backend/.env` (explicit `__dirname`) |
| `AI_GATE_*` today | none | none |
| Peer-check keys | `VANTAGE_API_URL` and `VANTAGE_PIN` set | — |

- `/mnt/data` is `nickw:nickw 755` on ext4.
- Both apps run as one user, so the narrowest folder that works is **owner-only `0700`**. No group bit, no setgid, no sudo. That replaces the earlier `2775` proposal.
- Bare `node` over ssh is **v20**, so the verifier must run on Node 22.

Before deploying, as `nickw` on pi5:

```bash
install -d -m 0700 /mnt/data/ai-gate
cp -p /mnt/data/nuero/backend/.env   /mnt/data/nuero/backend/.env.bak-ai-gate-2026-10-23
cp -p /mnt/data/vantage/backend/.env /mnt/data/vantage/backend/.env.bak-ai-gate-2026-10-23
printf '\nAI_GATE_DB_PATH=/mnt/data/ai-gate/ledger.db\n' >> /mnt/data/nuero/backend/.env
printf '\nAI_GATE_DB_PATH=/mnt/data/ai-gate/ledger.db\n' >> /mnt/data/vantage/backend/.env
grep -H '^AI_GATE_DB_PATH=' /mnt/data/nuero/backend/.env /mnt/data/vantage/backend/.env
stat -c '%U %a' /mnt/data/ai-gate        # expect: nickw 700
```

Then deploy both apps and run `pm2 restart neuro-backend vantage-backend`. `saim-backend` is unaffected.

Wait at least 60 seconds after the restart, then verify:

```bash
cd /mnt/data/nuero && PATH=$HOME/.nvm/versions/node/v22.22.2/bin:$PATH \
  node backend/scripts/ai-gate-verify.js --live --lock-probe
```

- It must end `✔ NEURO and VANTAGE write the one shared ledger.`
- Settings → AI budget must read "VANTAGE writes the same ledger ✓".
- The verifier writes no data and never prints a PIN.

**Rollback:** redeploy the previous commits; older code ignores the variable.

## Not changed

- Context linking stays off: no scan, backfill or write.
- No allowance granted, no Pi lock altered, no real action executed.
- The cap and enforce mode remain unset. Both are Nick's decision.

## Deployment record (23 Oct 2026)

1. **Rebased again before deploying.** `main` had gained `6cc08e13` and `fdc7fe17`. On the new head `eb96f57c`, the full suite ran 7,868 tests: 7,844 pass, the same 4 clean-`main` failures, 20 skips. The Electron browser suites passed 80/80.
2. **Pi configuration**, as `nickw`. A second run changed nothing.
   - `/mnt/data/ai-gate` was created at `0700`.
   - Both `.env` files were backed up with their modes preserved (`664` / `600`).
   - Each `.env` gained exactly one line, `AI_GATE_DB_PATH=/mnt/data/ai-gate/ledger.db` (verified with `diff`).
3. **Fast-forward pushes:** NEURO `fdc7fe17..eb96f57c`, VANTAGE `836b388..fa2c890`.
4. **Pi build and test** (Node 22):
   - NEURO frontend, kiosk (`saim/frontend`) and VANTAGE all built; lockfiles were unchanged.
   - Backend suite on the Pi: 7,868 tests, 7,764 pass, **0 fail**, 104 skipped (no Electron or iOS checkout on the Pi).
   - Netlify published the SAiM PWA (`eb96f57c`) and VANTAGE (`fa2c890`).
   - The MCP gateway container was rebuilt for the new route inventory.
5. **Restarts:** `neuro-backend`, then `vantage-backend`, both on Node 22. ⚠ `pm2 restart neuro-backend vantage-backend` restarted only the first name, so VANTAGE was restarted on its own. `saim-backend` was not restarted; it serves the kiosk build statically.
6. **The first verifier run reported VANTAGE "no ledger id". That was a verifier bug, not a ledger fault.**
   - VANTAGE wraps every response as `{ ok, data }`, and the verifier read the top level. The test stub had returned the unwrapped shape I intended, not the real one.
   - Independent proof that the ledger was shared all along: VANTAGE's raw profile reported the same `f4388203…`, both apps had registered rows, and NEURO's own peer check said **match**. So there was no rollback.
   - Fixed in `11d0631f`: the verifier now unwraps like `vantage-client`, the stub uses the real envelope, and the mutant is caught. Deployed as a CLI-only pull, with no restart.
   - The second verifier run passed.
7. **Health:** all 200.
   - NEURO `/api/status` and `/api/canonical/now`; the frontend served the new bundle `index-B5aUr9Su.js`.
   - SAiM backend `/api/health`; the kiosk served the new bundle `index-3bgYhba6.js`.
   - VANTAGE `/api/health`, `/api/leading` and `/api/findings`.
8. **Live UI**, checked read-only in a real browser against production. Screenshots are in the session scratchpad.
   - **Settings → AI budget:** "Shadow mode. No daily cap — Nick has not chosen one… nothing is blocked."; ledger id `f4388203` registered by neuro and vantage; "VANTAGE writes the same ledger ✓".
   - **Holding the week:** all four cards (Keeping my word, Monday report, Next, Needs your judgement) open their detail sheets in place, with no error.
   - **Drafts → Today:** renders on desktop and phone.
   - **No horizontal overflow:** desktop at 1440, phone at 390 (Surface, Now, Drafts), kiosk at 1024×552 and 1280×720.
9. ⚠ **Automatic context linking was already ON before this release.** Nick enabled it from Brain Health on 22 Oct at 15:59, and its backfill (run 1) ran then. The release did not change it:
   - the activation record's hash is identical before and after;
   - there are still two runs (that backfill and last night's 03:40 run) and 39 links;
   - no new run happened.
   Settings now shows it **On**, with "Turn automatic linking off" available. It was left untouched.
10. **Governed state unchanged** against the pre-deploy baseline:
    - prepared actions 61, attempts 47, external-write ledger 143, authority grants 3, authority events 6, intent grants 43;
    - the `SAIM_PREPARED_MOVE_EXECUTION` line and the `governed_execution` flag are unchanged;
    - no new message, calendar write, allowance or authority change;
    - the only gate tickets are 4 shadow-admitted `embeddings_index` calls (normal indexing).
