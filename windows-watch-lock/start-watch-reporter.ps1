# start-watch-reporter.ps1 — start NEURO's Watch presence reporter on this laptop.
#
# OWNED BY NEURO (Brief 004, D-007, 24 Oct 2026). The reporter is a NEURO
# background reporter, not part of the SAiM desktop window, and it has TWO
# consumers that must both keep working:
#   1. presence.json beside this script, read by the NEURO Desktop Agent's Watch
#      auto-lock (desktop-agent/watch-lock.ps1). Until the soak completes the
#      SAiM Electron window still reads it too.
#   2. the Pi's shared presence: it pushes this laptop to saim-backend
#      (pi5 :3005 /api/presence/sensor, room "laptop") as a MOBILE sensor, which
#      the kiosk, the wall and the greeter use. Unchanged by this brief.
#
# Idempotent: starts the reporter only if it is not already running.
#
# Tuned presence config (decided empirically 2026-06-12, see watch-irk-RESULTS / handoff):
#   passive scan; "near" = >=2 of last 8 one-second samples stronger than -78 dBm; fused
#   with system-wide keyboard/mouse idle (5s grace). These RSSI numbers are tuned to
#   Nick's desk; a very different spot may need a re-tune (WATCH_RSSI_NEAR / WATCH_RSSI_NEEDED).
#
# Installed at login by install-startup.ps1 (Startup\NEURO Watch reporter.lnk). The
# older Startup\SAiM.lnk -> saim\scripts\start-saim-windows.ps1 calls this same
# script, so either shortcut starts exactly one reporter.

$ErrorActionPreference = 'SilentlyContinue'
$here = $PSScriptRoot
$root = Split-Path $here -Parent
$logDir = Join-Path $root 'saim\logs'   # kept where the reporter has always logged
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$reporter = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -match 'watch-presence-reporter' }
if ($reporter) { return }

$env:WATCH_SCAN_MODE   = 'passive'
$env:WATCH_RSSI_NEAR   = '-78'
$env:WATCH_RSSI_WINDOW = '8'
$env:WATCH_RSSI_NEEDED = '2'
$env:WATCH_INPUT_GRACE_S = '5'
$env:WATCH_TICK_S      = '1'
# This laptop as a MOBILE sensor for the Pi's shared presence (14 Sep 2026): the
# fixed desk tablet hearing the Watch means he is AT his desk; only the laptop
# hearing it means he is about, with the laptop. Additive, and never allowed to
# affect the local lock. (The variable names stay SAIM_* — they are the Pi
# service's contract, which this brief does not change.)
if (-not $env:SAIM_SENSOR_URL) { $env:SAIM_SENSOR_URL = 'http://100.100.28.58:3005/api/presence/sensor' }
if (-not $env:SAIM_SENSOR_ROOM) { $env:SAIM_SENSOR_ROOM = 'laptop' }
Start-Process -FilePath (Join-Path $here 'venv\Scripts\python.exe') `
  -ArgumentList 'watch-presence-reporter.py' `
  -WorkingDirectory $here `
  -RedirectStandardOutput (Join-Path $logDir 'watch-reporter.out.log') `
  -RedirectStandardError  (Join-Path $logDir 'watch-reporter.err.log') `
  -WindowStyle Hidden
