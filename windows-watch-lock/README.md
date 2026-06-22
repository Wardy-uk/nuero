# Watch Lock (Windows)

Locks Windows when your Apple Watch leaves the room and wakes the screen when it
returns, so **Windows Hello** logs you straight back in — hands-free.

It reuses the BLE presence engine from the SARA work (`../watch_presence.py`): it
resolves the Watch's rotating BLE address against your captured **IRK** and treats
"detections stopped" — not RSSI — as the "you've left" signal.

## What it does (and what it deliberately doesn't)

| Event | Action | Mechanism |
|-------|--------|-----------|
| Watch leaves | Locks the workstation | `LockWorkStation()` |
| Watch returns | Wakes the display → Hello scans your face → you're in | mouse nudge |

It does **not** unlock Windows itself. Windows has no supported presence-unlock API;
the only way to bypass the lock screen by proximity is a custom Credential Provider
that stores a *replayable* copy of your login — the exact thing Windows Hello avoids.
So Hello does the actual auth (TPM-backed, no stored secret); the Watch just supplies
the *wake* you currently do by hand. This is the "auto-lock + quick Hello unlock"
combo — secure, and ~90% of the walk-up feel.

## Setup (run from source)

```powershell
cd "C:\Users\NickW\Claude\nuero\windows-watch-lock"
py -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
py watch_lock.py
```

A tray icon appears (grey=unknown, green=present, red=away). First run writes
`config.json`. The log goes to `watch_lock.log` next to the script.

On start it runs an **IRK self-test** against a known live address — watch the log
for `IRK self-test: PASS`. If it fails, fix `irk_hex` / `selftest_rpa` in config.

## config.json

```json
{
  "irk_hex": "2dbfa199fa42d060551738470e010f2e",
  "selftest_rpa": "4B:7F:44:E3:37:88",
  "present_window_s": 15,
  "away_timeout_s": 25,
  "scan_mode": "active",
  "auto_lock": true,
  "wake_on_return": true
}
```

- `away_timeout_s` — raise it if it locks too eagerly when the Watch advert is briefly
  missed; lower it for a snappier lock. 25s is a sane start.
- `scan_mode` — `active` is the safe default. Try `passive` if your radio supports it
  and you want lower power; if adverts stop resolving, switch back.

## Build a single .exe

```powershell
.\build.ps1          # -> dist\WatchLock.exe
```

Keep `config.json` in the **same folder** as the .exe (it's read at runtime, not baked
in). To autostart: press `Win+R`, run `shell:startup`, and drop a shortcut to
`WatchLock.exe` in there.

## The one thing to verify on your machine: wake-on-return

The mouse-nudge reliably wakes a monitor that's **off due to idle** (the common
"screen off, lid open, session locked" state) — that's the case that works.

If the laptop has gone into **deep sleep / Modern Standby** (lid closed, or after a
long idle), Windows suspends background BLE scanning and input injection — nothing in
user space can wake it. That's a power-state wall, not a bug.

To keep it in the wakeable state, set (Settings → Power, or `powercfg`):
- **On AC: never sleep**, display off after e.g. 5 min.
- Optionally disable lid-close sleep while docked.

Then: lock (Win+L) or walk away, wait for display-off, walk back with the Watch —
the screen should wake and Hello should sign you in. Tune `present_window_s` /
`away_timeout_s` to taste.

## Troubleshooting

- **Never sees the Watch** — confirm Bluetooth is on; check `watch_lock.log` for
  detections. The engine is identical to `watch_presence.py`, which you've already
  proven works on this Watch/IRK.
- **Locks too often** — raise `away_timeout_s`.
- **Wake does nothing** — you're likely in deep sleep, not display-off (see above).
- **.exe behaves differently from `py watch_lock.py`** — a PyInstaller hidden-import
  gap; run from source and share the error.
