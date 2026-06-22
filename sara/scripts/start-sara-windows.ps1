# start-sara-windows.ps1 — bring up the full SARA desktop stack on Windows (ARM64).
#
# Order matters: backend first (the UI + /api/presence live here), then wait for it to
# listen, then the Watch presence reporter (feeds /api/presence), then the Electron shell
# (loads the backend URL). Every step is guarded, so running this twice is harmless — it
# only starts what isn't already up. Registered to run at login by install-autostart.ps1.
#
# Tuned presence config (decided empirically 2026-06-12, see watch-irk-RESULTS / handoff):
#   passive scan; "near" = >=2 of last 8 one-second samples stronger than -78 dBm; fused
#   with system-wide keyboard/mouse idle (5s grace). Lock = Watch signal gone weak AND no
#   input. These RSSI numbers are tuned to Nick's desk; a very different spot may need a
#   re-tune (WATCH_RSSI_NEAR / WATCH_RSSI_NEEDED).

$ErrorActionPreference = 'SilentlyContinue'
$root = 'C:\Users\NickW\Claude\nuero'
$logDir = Join-Path $root 'sara\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# 1. Backend (:3005) — skip if something already holds the port.
if (-not (Get-NetTCPConnection -LocalPort 3005 -State Listen -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath 'node' -ArgumentList '--env-file=.env', 'server.js' `
    -WorkingDirectory (Join-Path $root 'sara\backend') `
    -RedirectStandardOutput (Join-Path $logDir 'backend.out.log') `
    -RedirectStandardError  (Join-Path $logDir 'backend.err.log') `
    -WindowStyle Hidden
}

# Wait up to ~30s for the backend to listen before launching the UI.
for ($i = 0; $i -lt 60; $i++) {
  if (Get-NetTCPConnection -LocalPort 3005 -State Listen -ErrorAction SilentlyContinue) { break }
  Start-Sleep -Milliseconds 500
}

# 2. Watch presence reporter — skip if already running.
$reporter = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -match 'watch-presence-reporter' }
if (-not $reporter) {
  $env:WATCH_SCAN_MODE   = 'passive'
  $env:WATCH_RSSI_NEAR   = '-78'
  $env:WATCH_RSSI_WINDOW = '8'
  $env:WATCH_RSSI_NEEDED = '2'
  $env:WATCH_INPUT_GRACE_S = '5'
  $env:WATCH_TICK_S      = '1'
  Start-Process -FilePath (Join-Path $root 'windows-watch-lock\venv\Scripts\python.exe') `
    -ArgumentList 'watch-presence-reporter.py' `
    -WorkingDirectory (Join-Path $root 'windows-watch-lock') `
    -RedirectStandardOutput (Join-Path $logDir 'watch-reporter.out.log') `
    -RedirectStandardError  (Join-Path $logDir 'watch-reporter.err.log') `
    -WindowStyle Hidden
}

# 3. Electron shell — its single-instance guard means a second launch just focuses the
# existing window, so this is safe even if SARA is already open.
$env:SARA_URL = 'http://localhost:3005/'
Start-Process -FilePath (Join-Path $root 'sara\desktop-electron\node_modules\electron\dist\electron.exe') `
  -ArgumentList '.' `
  -WorkingDirectory (Join-Path $root 'sara\desktop-electron') `
  -WindowStyle Hidden
