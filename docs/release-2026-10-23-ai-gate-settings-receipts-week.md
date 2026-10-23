# Release candidate — AI gate, Settings, receipt truth, Holding the week (23 Oct 2026)

**Status:** built and tested locally. Nothing pushed, deployed or restarted. Waiting for Nick's approval.

NEURO branch `saim-budget-gate-slice` (worktree `.claude/worktrees/budget-gate`).
VANTAGE branch `ai-gate-radar` (worktree `Service Desk Continual Improvement/.claude/worktrees/ai-gate`).
Both apps must be deployed together, because they share one gate file and one ledger.

## What ships

| Part | What it does |
|---|---|
| A | One shared **AI gate** in front of every paid, metered and local model call, in both apps. It runs in shadow mode and has no cap. It is shown in Settings → AI budget (shadow) and on the VANTAGE Admin page. |
| B | **Automatic context linking** is switched on in Settings only. Brain Health is now read-only. The switch stays off. |
| C | **Receipt truth.** A receipt says "Done" only when the result was verified. Drafts gains a Today history list. |
| D | **Holding the week** cards each lead to a real place, with one primary action. |
| Release checks | The items below. |

## Release checks (23 Oct 2026)

1. **16px sideways scroll on phone and kiosk.** This was a fault in the test harness, not the app. The harness mounted the Surface outside `.app__view`, so the Surface's negative margin had no padding to cancel. The Holding-the-week browser test now mounts the real shell containers and stylesheets. It asserts there is no sideways scroll at 390px phone, 1024×552 kiosk and 1280×720 kiosk. The real phone App also gets the same check in `real-shell-drafts`. Mutation check: mounting the Surface bare fails the test.
2. **Parallel-only failures.** Both were nondeterministic test setup, and both are fixed.
   - Electron drivers sometimes failed their first `loadURL` with ERR_FAILED under load. They also clicked elements that had not rendered yet, because the wait gave up silently after 15 seconds. All eight server-backed drivers now share `services/electron-driver-support.js`. It retries a load on a transport error only. Each click now waits up to 45 seconds and names what it waited for. Result: the 12 Electron suites passed 79/79, twice, in parallel.
   - `Drafts: abandoning…` failed once in a full parallel run. Task-store's 3-second debounced export (`Tasks/NEURO Tasks (export).md`, stamped with "last exported") fired inside that test's "nothing written to the vault" snapshot. That write came from earlier tests' task changes, not from abandoning a draft. The snapshot now leaves out that one generated file, and the comment says why. The test passes alone on both clean `main` and this branch.
3. **Shared AI ledger: deployment-safe.**
   - NEURO and VANTAGE must both set **`AI_GATE_DB_PATH`** to the same absolute file. There is no home-directory default: that would split the ledger the day the two apps run as different users.
   - Both servers refuse to start, naming the problem, when the path is unset, relative, its folder is missing or not a folder, or the folder or file is not readable and writable. Verified by starting each server with a bad configuration.
   - The ledger mints its own id inside the file. Each app registers itself at startup with its path, real path, host and pid.
   - NEURO compares its id with VANTAGE's (`/api/ai-gate/profile`) 45 seconds after start and then hourly. A mismatch is logged and shown in Settings. VANTAGE Admin warns when NEURO is not registered on its ledger.
   - A two-process test runs NEURO's gate and VANTAGE's own copy against one ledger. They race $0.05 tickets under a $1 cap in enforce mode. Result: exactly 20 allowed, total at or under the cap, 60 unique ids, and every second settle refused and recorded. It was repeated 8 times.
   - A measured note: a DEFERRED transaction does not overspend either, because SQLite WAL refuses the stale write. But that refusal came back as a degraded ticket that was still admitted, so IMMEDIATE is pinned by a source check.
4. **Regression evidence.** Listed below.

## Pi configuration — do this BEFORE the code deploys

```bash
sudo install -d -o nickw -g nickw -m 2775 /mnt/data/ai-gate
echo 'AI_GATE_DB_PATH=/mnt/data/ai-gate/ledger.db' >> /mnt/data/nuero/backend/.env
echo 'AI_GATE_DB_PATH=/mnt/data/ai-gate/ledger.db' >> /mnt/data/vantage/backend/.env
```

Neither `.env` contains `AI_GATE_DB_PATH` today (checked read-only on 23 Oct). **Without these lines both servers refuse to start.** That is by design.

If the apps ever run as different users: put both users in one group that owns `/mnt/data/ai-gate`, keep the folder at `2775`, and run each app with `umask 0002`.

## Post-deploy verification (read-only)

Restart both apps, then run:

```bash
cd /mnt/data/nuero && node backend/scripts/ai-gate-verify.js
```

It must end with `✔ NEURO and VANTAGE write the one shared ledger.` It checks that:

- both `.env` files name the same absolute path (after realpath);
- the file exists and opens read-only;
- NEURO and VANTAGE have each registered on it from a running process.

It also prints today's counts. Any problem exits 1 and names the problem. It writes nothing.

## Evidence

- **NEURO full suite**, with `ELECTRON_PATH` set so no browser test skips, in parallel. Two complete runs after the changes:
  - first run: 7,855 tests, 7,830 pass, 5 fail, 20 skipped. The extra failure was the export-debounce race, fixed above.
  - second run: **7,855 tests, 7,831 pass, 4 fail, 20 skipped.** The 4 are exactly the clean-main failures below.
- **Every skip has an environmental reason**: no `nuero-ios` checkout beside this repo (17), symlinks and file modes on Windows (2), and an opt-in Pi-snapshot parity run (1). **No Electron test skipped.**
- **The 12 Electron suites alone** (79 tests): 79/79 in parallel, twice.
- **Real-browser coverage at phone and desktop widths**:
  - Settings, including the disabled backfill control and no POST or backfill;
  - receipt truth and Drafts → Today history;
  - every Holding-the-week card in the calm, held, prepared, verified and no-data states;
  - kiosk read-only behaviour at 1024×552 and 1280×720.
- **VANTAGE suite** (`NODE_PATH` set to NEURO's `node_modules` for better-sqlite3): **310/310**.
- **Builds**: NEURO frontend, SAiM app, kiosk (`saim/frontend`) and VANTAGE frontend all build.
- **AI-gate tests**:
  - ledger-config: 12 (one skipped on Windows);
  - two-app race: 1, repeated 8×;
  - verify script: 4;
  - render: 4.
  - Mutation checks: removing the cap rule fails 2 tests, and IMMEDIATE is source-pinned (see above).

## Known failures on clean main (not this branch)

Each was reproduced on a clean `main` worktree at `f8f22ca6`. The branch touches none of these files.

| Test | Cause |
|---|---|
| `5. Ask and Capture are unchanged…` (quick-log-routing) | Byte-identity check against CRLF line endings in this Windows checkout |
| `the executor records a governed send…` (soap-report) | A regex that does not allow for CRLF |
| `the real October report parses completely` (hilo-import) | Reads a HiLo PDF that exists only on the laptop |
| `route: the real PDF posted as application/pdf…` (hilo-import) | Same laptop-only PDF |

## Not changed

- The context-linking switch stays off.
- No scan, backfill or database write happens on load; the Settings browser test asserts there is no POST and no backfill.
- No allowance was granted, no Pi lock was altered, and no real governed action ran.
- The cap and enforce mode remain unset. Both are Nick's decision.
