# SAiM Desktop (Electron shell)

Makes SAiM a cross-platform desktop app and gives it **OS-level lock/wake** where the
platform supports it. Phase 1: Windows gets a real `LockWorkStation` + Windows-Hello
wake; the Pi kiosk is unchanged (overlay-only).

## How it fits

- **Window:** loads the existing SAiM frontend from `SAIM_URL` (default
  `http://localhost:3005/`). No frontend changes beyond the lock hook.
- **Native bridge:** `preload.js` exposes `window.saimNative` to the renderer.
  `usePresenceLock` calls it *in addition to* its in-app LockScreen overlay — guarded,
  so a plain browser or the Pi (where `canOSLock` is false) behaves exactly as before.
- **Lock adapters** (`lock/`), selected by `process.platform`:
  | Platform | lock() | wake() | canOSLock |
  |---|---|---|---|
  | win32 | `rundll32 user32.dll,LockWorkStation` | PowerShell mouse-nudge → Hello | true |
  | linux | no-op (overlay is the lock) | no-op | false |
  | other | no-op | no-op | false |

  All adapters shell out — **no native modules, no compiler** — so they work on
  Windows ARM64 with nothing to build.

## Run (Windows) — use `SAiM.vbs`

Double-click **`SAiM.vbs`**, or make a shortcut to it and point the icon at
`saim/desktop/saim-desktop.ico`.

⚠ **Do NOT launch it with `npm start` day to day.** Nick, 1 Sep 2026: *"SAiM is
loading with 2 windows."* The second was never a SAiM window — it was the
`cmd.exe` console running `npm start`, which on Windows is the PARENT of the
Electron process, so it cannot close while SAiM is open. It sits in the taskbar
all day looking like a second app, and closing it kills her.

`npm start` spawns a shell → `electron.cmd` (itself a batch file) → another
shell → `electron.exe`. Every one of those needs a console. `SAiM.vbs` runs
`electron.exe` **directly**, so the console is not hidden — it is never created.
It inherits the environment, so `SAIM_URL` works exactly as it does from a
console; set it in the user environment rather than baking a URL into a file
that lives in a public repo.

`npm start` is still the right thing for development, where you want the logs.

## Run for development (Windows)

The SAiM backend must be reachable first (Phase 2 will spawn it from here):

```powershell
# terminal 1 — SAiM backend (from saim/)
cd ..\backend ; node server.js          # serves http://localhost:3005

# terminal 2 — desktop shell
cd saim\desktop-electron
npm install
npm start
```

Env:
- `SAIM_URL` — where the frontend is served (default `http://localhost:3005/`).
- `SAIM_FULLSCREEN=1` — borderless fullscreen (wall-display mode).

## Verifying the lock seam

With the shell running, trigger an away-lock (walk off with the Watch, or use the
manual lock): on Windows the workstation locks. Walk back: the display wakes and Hello
signs you in. The behaviour is driven entirely by the existing presence pipeline
(`/api/presence`) — Phase 2 wires the Watch engine as the Windows presence sidecar.
