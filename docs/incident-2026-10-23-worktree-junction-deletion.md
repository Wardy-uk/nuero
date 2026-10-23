# Incident — main checkout deleted through a node_modules junction (23 Oct 2026)

**Status:** closed. Tracked files restored and audited; nothing recoverable is missing; safeguard enforced.
**Severity:** laptop working tree only. The Pi, git history, origin, the vault and VANTAGE were never touched.
**This was the third time.** The same mechanism deleted the same folders on 19 Oct (session 180e9495) and
damaged `node_modules` on 20 Oct. A line in `mistakes.md` and a memory note did not prevent a repeat, so the
fix this time is an enforced guard, not another note.

## What happened

| Time (UTC) | Event |
|---|---|
| 08:55:03 | This session made a temporary baseline worktree at `%TEMP%\neuro-baseline` and junctioned its `node_modules` and `saim/app/node_modules` to the MAIN checkout's. |
| 09:07:13 | Cleanup ran `cmd //c rmdir` on the junctions (the quoting failed silently, so they stayed), then `git worktree remove --force` on the baseline. |
| 09:07:13–:27 | The removal followed the junction into `nuero/node_modules`, whose npm-workspace links (`neuro-backend`, `neuro-frontend`) point at `backend/` and `frontend/`, and deleted them. |
| 09:08:01 | `git restore --source=HEAD --worktree -- backend frontend worker` (HEAD was `0d808f66`). |
| 09:09–09:14 | `npm ci` failed (node-gyp, no ARM64 v143 toolset); `npm ci --ignore-scripts` succeeded (better-sqlite3 13 ships a win32-arm64 prebuild); `saim/app` `npm ci`. |

## Exact affected paths

- `C:\Users\NickW\Claude\nuero\backend\` and `frontend\` — whole trees, tracked and ignored.
- `C:\Users\NickW\Claude\nuero\worker\` — partially (tracked files restored).
- `C:\Users\NickW\Claude\nuero\node_modules\` and `saim\app\node_modules\` — dependencies.

Nothing outside those paths was affected: `saim/`, `vesta/`, `docs/`, `CLAUDE.md` and `.claude/` were intact (the
other session's uncommitted `mistakes.md` entries and `vesta/package-lock.json` change survived and are still uncommitted).

## Restored

- All 1,389 tracked files, from HEAD. Post-restore, six test files show `M` with identical blob hashes (stat/CRLF only, no content change).
- Root and `saim/app` dependencies. better-sqlite3 loads; a 70-test sample and the frontend build pass.

## Provably absent — not lost on 23 Oct

| Item | Evidence |
|---|---|
| **`backend/.env`, `backend/db/agent.db`, `backend/.ms365-token-cache.json`** | Deleted on **19 Oct** by the earlier incident: that session's `ls` at 07:34Z returned "No such file" for all three, and Nick was told. A scan of every Claude transcript from 19 Oct 07:35Z to 23 Oct 09:07Z finds nothing that recreated them in the main checkout (no write, copy or local NEURO start there). No other checkout of this repo holds any of them. The real `.env` and database live on the Pi. |
| **Uncommitted source edits** | Every `git status` snapshot of the main checkout recorded by any session, from 22 Oct 09:10Z to **23 Oct 08:38:53Z** (28 min before the deletion), shows only `.claude/memory/mistakes.md` and `vesta/package-lock.json` modified — nothing under `backend/`, `frontend/` or `worker/`. The one other session active in the main checkout that morning (cfe470d2) edited only `saim/` and `CLAUDE.md`, all committed by 09:01:42Z. |
| **Earlier Claude edits** | All 230 Edit/Write calls any session made to main-checkout `backend/`, `frontend/` and `worker/` since 15 Oct were checked against the restored files: 216 present verbatim; the other 14 were all committed later in revised form (e.g. `clock.js` in `d21d3a1c`, `neuro-candidates.js` in `182cfadb`, `webpush.js` in `aa0a9dda`). None was lost. |
| **Staged work** | `git fsck --dangling` (read-only): no dangling object created on 23 Oct; the dangling commits are other sessions' stashes from 22 Oct. The index matched HEAD. |

## Unknowable

- Edits made **by hand outside Claude** in `backend/`, `frontend/` or `worker/` and not committed. VS Code Local History holds no entry for this checkout after 15 Sep, and the status snapshots above show nothing uncommitted 28 minutes before, so this is unlikely — but it cannot be proven.
- Ignored files under `worker/` (none are listed by `.gitignore` other than `.env`/`node_modules`; the worker is retired).

## Recovery sources checked (all non-destructive)

| Source | Result |
|---|---|
| Recycle Bin | 41 items, none from `nuero` (`rmdir`/git deletes bypass it). |
| Shadow copies / Previous Versions / System Restore | Not readable without elevation (`vssadmin`: access denied). **Not attempted** — needs Nick. |
| File History | Not configured. |
| VS Code Local History | 8 files tracked; none under the main checkout after 15 Sep. |
| Other worktrees and sibling checkouts | No `.env`, `agent.db`, token cache, places/POI data in any. |
| Claude transcripts | Used for every finding above. |

No invasive undelete tool was run.

## Safeguard now enforced (user-level, all repos, all sessions)

- `C:\Users\NickW\.claude\hooks\guard-link-delete.js` — a **PreToolUse hook on Bash and PowerShell** in `~/.claude/settings.json` (backup: `settings.json.bak-2026-10-23-linkguard`; only `hooks` changed, verified).
  - Blocks **every** `git worktree remove`, forced or not. The plain form also deletes ignored contents.
  - Blocks every recursive delete whose target **is or contains** a junction or symlink, and names the links:
    - `rm -r/-rf/--recursive`;
    - `Remove-Item`/`ri`/`rm`/`del`/`erase`/`rmdir`/`rd -Recurse`;
    - `rmdir`/`rd /s`, including inside `cmd /c`;
    - globs.
  - **Fails closed.** It blocks when it can't make the target a literal path (a variable it can't see, `$(…)`, or a `cd` it can't follow), when a scan is incomplete, or when it errors. `onFailure: block` covers a hook crash or timeout.
- `C:\Users\NickW\.claude\hooks\safe-remove.js <path> [--worktree] [--force] [--dry-run]` — the way to remove instead:
  1. Unlinks each link.
  2. Proves the link is gone and its target is unchanged.
  3. Re-scans for links.
  4. Only then deletes, or runs `git worktree remove`.
  - It refuses the drive root, home, `~/Claude` and the main checkout.
- `guard-link-delete.test.js` builds a real junction to a temp "victim" folder: 5/5 pass, and two mutants are caught (a blind link scan; the worktree rule removed). The guard **blocked a live call in this session.**
- Not covered: deletes run inside interpreter one-liners (`node -e "fs.rmSync…"`, `python -c "shutil.rmtree…"`). They are rare, and the guard says nothing about them.

## Rule going forward

Never junction or symlink `node_modules` into a worktree. Run tests with `NODE_PATH` pointing at the main checkout's `node_modules`. If a link exists anyway, remove the worktree with `safe-remove.js --worktree`.
