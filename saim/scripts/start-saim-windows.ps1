# start-saim-windows.ps1 — the login launcher behind Startup\SAiM.lnk (kept for that shortcut).
#
# ⚠ Brief 004 (24 Oct 2026): what this starts is NEURO's, not SAiM's.
#   1. The Watch presence reporter — now started by
#      windows-watch-lock\start-watch-reporter.ps1 (NEURO-owned; it feeds the
#      NEURO Desktop Agent's Watch lock and the Pi's shared presence). This file
#      only calls it, so the existing Startup\SAiM.lnk keeps working until
#      windows-watch-lock\install-startup.ps1 replaces it with
#      Startup\NEURO Watch reporter.lnk.
#   2. The local saim/backend on :3005 — only with SAIM_LOCAL_BACKEND=1
#      (kiosk development). Off by default since the 21 Oct 2026 cutover.
#
# It never starts the Electron window (see the note at the end). Every step is
# guarded, so running this twice is harmless.

$ErrorActionPreference = 'SilentlyContinue'
$root = 'C:\Users\NickW\Claude\nuero'
$logDir = Join-Path $root 'saim\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# 1. Backend (:3005) — skip if something already holds the port.
# ⚠ 21 Oct 2026 cutover: the desktop window opens the ONE canonical SAiM
# (https://sara.nickward.co.uk), so the local saim/backend on :3005 — the old
# local shell — is no longer started by default. Set SAIM_LOCAL_BACKEND=1 to
# bring it back (kiosk development). The Watch reporter below is unchanged: it
# feeds the Pi and Electron's own lock, not the local backend.
if ($env:SAIM_LOCAL_BACKEND -eq '1' -and -not (Get-NetTCPConnection -LocalPort 3005 -State Listen -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath 'node' -ArgumentList '--env-file=.env', 'server.js' `
    -WorkingDirectory (Join-Path $root 'saim\backend') `
    -RedirectStandardOutput (Join-Path $logDir 'backend.out.log') `
    -RedirectStandardError  (Join-Path $logDir 'backend.err.log') `
    -WindowStyle Hidden
}

# Wait up to ~30s for the backend to listen before launching the UI.
for ($i = 0; $i -lt 60 -and $env:SAIM_LOCAL_BACKEND -eq '1'; $i++) {
  if (Get-NetTCPConnection -LocalPort 3005 -State Listen -ErrorAction SilentlyContinue) { break }
  Start-Sleep -Milliseconds 500
}

# 2. Watch presence reporter — NEURO's, started by its own script (idempotent;
#    identical environment, Pi sensor URL and room as before).
& (Join-Path $root 'windows-watch-lock\start-watch-reporter.ps1')

# 3. The Electron window is deliberately NOT started here.
#
# ⚠ IT USED TO BE, and it fought the desktop shortcut. This script launched
# Electron with SAIM_URL=http://localhost:3005/ (the kiosk build), while the
# shortcut asks for https://saim.nickward.co.uk (the phone build). main.js holds
# a single-instance lock, so whichever starts FIRST wins the URL and the second
# launch silently focuses the existing window — after a login, clicking the
# shortcut got Nick the kiosk and no indication why.
#
# Two launchers, one window, and the loser fails quietly. So this script now
# starts only what has no other way of starting: the backend that serves :3005
# and answers /api/presence, and the Watch reporter that feeds it. Opening SAiM
# is a thing Nick does deliberately, from `saim/desktop-electron/SAiM.vbs` —
# which takes the URL as an argument and needs no console to set it.
#
# If you ever want her up at login again, add a shortcut to SAiM.vbs in the
# Startup folder rather than putting Electron back here: that way there is still
# exactly one thing that decides which SAiM opens.
