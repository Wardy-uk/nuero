<#
.SYNOPSIS
  Reports what the laptop is doing to NEURO, so SAiM can tell working from
  not-working and four hours of one job from four hours of twelve.

.DESCRIPTION
  Posts one small sample every couple of minutes:

      { at, app, idleSeconds, locked, host }

  WHAT IT SENDS, AND WHAT IT DELIBERATELY DOES NOT
  ------------------------------------------------
  It sends the FOREGROUND PROCESS NAME and nothing else. Never the window
  title, never a file path, never a URL, never keystrokes.

  That is not caution for its own sake. A VS Code title carries the file and
  the workspace; a browser title carries the page; an Outlook title carries the
  SUBJECT LINE of whatever is open, which on this machine means customer names,
  ticket subjects and, on a bad day, the contents of a disciplinary folder.
  "Code" answers the question. "risk-assessment-naomi.docx - Word" does not
  answer it any better and cannot be un-sent.

  A LOCKED session reports `locked` and no app at all — what was open before
  walking away is not something to keep a record of.

  Nothing is stored locally. If NEURO is unreachable the sample is dropped, not
  queued: this is "what is he doing NOW", and a sample delivered an hour late
  answers a question nobody is asking.

.PARAMETER BaseUrl
  NEURO's API root, e.g. http://100.100.28.58:3001

.PARAMETER Token
  NEURO_API_TOKEN. Machine clients use the token, not the PIN.

.PARAMETER IntervalSeconds
  Seconds between samples. Default 120.

.PARAMETER Once
  Take a single sample, post it, and exit. Used by the installer to prove the
  whole path works before anything is scheduled.

.EXAMPLE
  .\neuro-desktop-agent.ps1 -BaseUrl http://100.100.28.58:3001 -Token xxx -Once
#>

[CmdletBinding()]
param(
  [string]$BaseUrl = $env:NEURO_BASE_URL,
  [string]$Token = $env:NEURO_API_TOKEN,
  [int]$IntervalSeconds = 120,
  # How often to ASK whether a button has been pressed.
  #
  # WARNING  THIS IS NOT THE SAMPLE INTERVAL AND MUST NOT BE FOLDED INTO IT.
  #   Sampling answers "what is he doing", which does not need asking often.
  #   A launch button answers "do this now", and at the sample cadence it
  #   measured 111 seconds to open Chrome, with the next press expiring
  #   unfired. Two different questions, two cadences. The claim call stores
  #   nothing and carries no sample, so asking often is cheap.
  [int]$ClaimSeconds = 5,
  # Watch auto-lock (D-007, Brief 004): this agent owns it now. See watch-lock.ps1.
  #   off     not read, not decided.
  #   shadow  DEFAULT. Decides every tick and REPORTS what it would do; never
  #           locks, wakes or notifies. The soak runs this beside Electron.
  #   on      decides and acts.
  [ValidateSet('off', 'shadow', 'on')]
  [string]$WatchLock = 'shadow',
  # The Watch reporter's file. Default: the repo's windows-watch-lock folder,
  # the same file the Electron lock read.
  [string]$PresenceFile = $env:WATCH_STATUS_FILE,
  [int]$WatchLockSeconds = 2,
  [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $BaseUrl) { throw 'BaseUrl is required (or set NEURO_BASE_URL).' }
if (-not $Token)   { throw 'Token is required (or set NEURO_API_TOKEN).' }
$BaseUrl = $BaseUrl.TrimEnd('/')

# --- Win32: idle time and the foreground process ---------------------------
#
# GetLastInputInfo is keyboard + mouse across the whole session, so reading a
# document counts as idle. That is why the server's "away" threshold tolerates
# a long think rather than a short one.
if (-not ('Neuro.Win32' -as [type])) {
  Add-Type -Namespace Neuro -Name Win32 -MemberDefinition @'
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    [DllImport("kernel32.dll")]
    public static extern uint GetTickCount();

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
'@
}

# --- Watch auto-lock (owned here since Brief 004) ----------------------------
# The mode lives in desktop-agent.json ("watchLock"), so switching it is an
# edit and a task restart: the installed runner never needs regenerating. An
# explicit -WatchLock wins; anything unrecognised leaves the safe default.
if (-not $PSBoundParameters.ContainsKey('WatchLock')) {
  try {
    $wlCfg = Get-Content -Raw (Join-Path $env:LOCALAPPDATA 'neuro\desktop-agent.json') | ConvertFrom-Json
    if ($wlCfg.watchLock -in @('off', 'shadow', 'on')) { $WatchLock = $wlCfg.watchLock }
  } catch { }
}
. (Join-Path $PSScriptRoot 'watch-lock.ps1')
if (-not $PresenceFile) { $PresenceFile = Join-Path (Split-Path $PSScriptRoot -Parent) 'windows-watch-lock\presence.json' }
$script:WL = New-WatchLockState
$script:WLAssessment = $null
$script:WLWasLocked = $false
$script:WLCounters = @{ locks = 0; wouldLock = 0; wakes = 0; failures = 0; lastAction = $null; lastActionAt = $null }
$script:WLStarted = Get-Date
$script:WLLastWhy = '(start)'

function Invoke-WatchLockTick {
  if ($WatchLock -eq 'off') { return }
  $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  # Session lock transitions, as Electron's powerMonitor reported them.
  $lockedNow = Test-SessionLocked
  if ($lockedNow -and -not $script:WLWasLocked) { $script:WL = Set-WatchLockScreenLocked $script:WL }
  if (-not $lockedNow -and $script:WLWasLocked) { $script:WL = Set-WatchLockOSUnlocked $script:WL }
  $script:WLWasLocked = $lockedNow
  $r = Step-WatchLock $script:WL (Read-WatchPresence $PresenceFile) $nowMs (Get-IdleSeconds)
  $script:WL = $r.state
  $script:WLAssessment = $r.assessment
  # Say once when presence goes blind or comes back, so a dead reporter is
  # findable in the log rather than being a lock that simply never happens.
  $why = $(if ($r.assessment.known) { $null } else { $r.assessment.why })
  if ($why -ne $script:WLLastWhy) { Write-Host "watch-lock: presence $(if ($why) { "blind: $why" } else { 'reading' })"; $script:WLLastWhy = $why }
  if (-not $r.action -or $r.action -eq 'cancel-warn') { return }
  $done = Invoke-WatchLockAction $WatchLock $r.action
  $stamp = (Get-Date).ToUniversalTime().ToString('o')
  if ($WatchLock -ne 'on') {
    if ($r.action -eq 'lock') { $script:WLCounters.wouldLock++ }
    $script:WLCounters.lastAction = "would-$($r.action)"; $script:WLCounters.lastActionAt = $stamp
    Write-Host "watch-lock ($WatchLock): would $($r.action)"
    return
  }
  if ($done.acted -eq 'lock') { $script:WLCounters.locks++ }
  elseif ($done.acted -eq 'wake') { $script:WLCounters.wakes++ }
  elseif ($done.acted -like '*-failed') { $script:WLCounters.failures++ }
  $script:WLCounters.lastAction = $done.acted; $script:WLCounters.lastActionAt = $stamp
  Write-Host "watch-lock: $($done.acted)"
}

function Get-WatchLockReport {
  if ($WatchLock -eq 'off') { return [pscustomobject]@{ mode = 'off' } }
  return Get-WatchLockStatus $WatchLock $script:WLAssessment $script:WLCounters $script:WL $script:WLStarted
}

function Get-IdleSeconds {
  $info = New-Object Neuro.Win32+LASTINPUTINFO
  $info.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($info)
  if (-not [Neuro.Win32]::GetLastInputInfo([ref]$info)) { return 0 }
  $ticks = [Neuro.Win32]::GetTickCount()
  # GetTickCount wraps roughly every 49 days. A wrap would otherwise produce a
  # huge negative idle time and read as "he has been away since 1994".
  if ($ticks -lt $info.dwTime) { return 0 }
  return [int](($ticks - $info.dwTime) / 1000)
}

function Test-SessionLocked {
  # LogonUI owns the screen whenever the session is locked or on the login
  # screen. Cheaper and more reliable than the session-notification APIs, and
  # it needs no elevation.
  return [bool](Get-Process -Name 'LogonUI' -ErrorAction SilentlyContinue)
}

function Get-ForegroundProcessName {
  $hwnd = [Neuro.Win32]::GetForegroundWindow()
  if ($hwnd -eq [IntPtr]::Zero) { return $null }
  $procId = 0
  [void][Neuro.Win32]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  if ($procId -eq 0) { return $null }
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if (-not $proc) { return $null }
  # ⚠ ProcessName ONLY. Never $proc.MainWindowTitle — see the header.
  return $proc.ProcessName
}

# -- Opening something, when NEURO is asked to ---------------------------------
#
# WARNING  THIS AGENT STAYS OUTBOUND-ONLY. Nothing listens here and nothing on
#   the network can reach this machine. Anything to be done arrives on the
#   RESPONSE to the POST above - a connection this script opened itself.
#
# WARNING  THE SERVER SENDS AN ID, NEVER A COMMAND. The mapping from id to an
#   actual program lives HERE, on this laptop, in $AppCommands. The Pi cannot
#   name a path, cannot pass arguments, and cannot invent a new app by sending
#   a different string: an id that is not a key below is refused locally,
#   before anything runs, and reported as refused. Adding a program is a
#   deliberate edit on THIS machine.
#
# WARNING  NO ARGUMENTS ARE EVER PASSED. Start-Process is called with the
#   command and nothing else. The moment a caller can supply an argument, an
#   allowlist of programs stops being a meaningful boundary - 'browser' plus
#   an arbitrary URL, or 'terminal' plus a command, is arbitrary execution
#   wearing an allowlist's clothes.

$AppCommands = @{
  music    = 'iTunes'
  code     = 'code'
  terminal = 'wt'
  browser  = 'msedge'
}

# Overrides live beside the token, so the real paths on this machine are not
# in a repo. Same file, same permissions, same reasoning.
$AppOverridePath = Join-Path $env:LOCALAPPDATA 'neuro-agent\apps.json'
if (Test-Path $AppOverridePath) {
  try {
    $o = Get-Content -Raw $AppOverridePath | ConvertFrom-Json
    # The file both OVERRIDES the built-ins and ADDS ids (13 Oct 2026). Adding
    # is still a deliberate edit on THIS machine — the Pi cannot write here —
    # and the server only ever hands out ids in its own APPS list, so an id
    # here that NEURO does not know is simply never offered. A key must look
    # like an id, and the value is still only ever a bare command: no arguments.
    foreach ($p in $o.PSObject.Properties) {
      $k = [string]$p.Name
      if ($k -cmatch '^[a-z][a-z0-9-]{0,23}$' -and $p.Value -is [string] -and $p.Value) {
        $AppCommands[$k] = [string]$p.Value
      }
    }
  } catch {
    Write-Warning "could not read $AppOverridePath - using built-in app commands"
  }
}

function Report-Intent($id, $ok, $detail) {
  try {
    $b = @{ ok = [bool]$ok; detail = $detail } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/desktop/intents/$id/done" `
      -Headers @{ 'X-NEURO-API-TOKEN' = $Token } `
      -ContentType 'application/json' -Body $b -TimeoutSec 10 | Out-Null
  } catch {
    # Best effort. A lost receipt leaves the request reading 'claimed', which
    # is honest - it says the laptop took it, not that it worked.
    Write-Warning "could not report intent ${id}: $($_.Exception.Message)"
  }
}

function Invoke-DeskIntent($intent) {
  $id = $intent.id
  $app = [string]$intent.app
  if (-not $AppCommands.ContainsKey($app)) {
    # Refused HERE, independently of the server's own refusal. Two locks.
    Write-Warning "refused unknown app id '$app'"
    Report-Intent $id $false "this machine has no '$app'"
    return
  }
  $cmd = $AppCommands[$app]
  try {
    Start-Process -FilePath $cmd -ErrorAction Stop
    Write-Host "opened $app ($cmd)"
    Report-Intent $id $true $cmd
  } catch {
    Write-Warning "could not open ${app}: $($_.Exception.Message)"
    Report-Intent $id $false $_.Exception.Message
  }
}

function Get-DeskIntents {
  # Ask whether anything is waiting. Outbound-only, exactly like the sample
  # post: this machine opens the connection and the answer comes back on it.
  #
  # WARNING  `canOpen` travels here TOO. The server refuses to hand an intent
  #   to an agent that has not said what it understands, and this route is no
  #   exception - a claim without it would be a way round the guard.
  try {
    $b = @{ host = $env:COMPUTERNAME; canOpen = @($AppCommands.Keys | Sort-Object) } | ConvertTo-Json -Compress
    return Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/desktop/intents/claim" `
      -Headers @{ 'X-NEURO-API-TOKEN' = $Token } `
      -ContentType 'application/json' -Body $b -TimeoutSec 10
  } catch {
    # Silent by design: this runs every few seconds, and a warning per failure
    # would fill the log with one outage. The sample post still reports.
    return $null
  }
}

function Invoke-DeskIntents($response) {
  if (-not $response) { return }
  $intents = $response.intents
  if (-not $intents) { return }
  foreach ($i in @($intents)) {
    if ($i -and $i.id -and $i.app) { Invoke-DeskIntent $i }
  }
}
# -- What is playing (16 Oct 2026) ---------------------------------------------
#
# Read from Windows' media controls (the API behind the volume flyout), which
# a music app reports to on its own. Sent to NEURO's now-playing route - the
# same one the iPhone uses - tagged client 'desktop'. Nick's call: the track is
# his own data; the window-title rule above is about OTHER people's data, which
# a song title does not carry.
#
# WARNING  ONLY THE MUSIC APPS BELOW. Chrome and Edge report to the same API,
#   so reading every session would put YouTube videos and Teams calls into the
#   leisure ledger as songs. An app not listed here is never reported.
#
# WARNING  Needs Windows PowerShell 5.1 (the scheduled task's powershell.exe).
#   PowerShell 7 cannot load these Windows APIs, so there it reports nothing
#   rather than failing the agent.
$MusicApps = [ordered]@{
  'AppleInc.AppleMusicWin' = 'Apple Music'
  'SpotifyAB.SpotifyMusic' = 'Spotify'
  'Spotify.exe'            = 'Spotify'
}
$MediaSeconds = 15
# A playing track is re-reported this often even when nothing changed, because
# NEURO treats a "playing" report older than 15 minutes as no longer current.
$MediaHeartbeatSeconds = 600

$script:MediaReady = $false
$script:MediaAsTask = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $script:MediaAsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  $script:MediaReady = [bool]$script:MediaAsTask
} catch {
  Write-Warning "media controls unavailable ($($_.Exception.Message)) - music will not be reported"
}

function Wait-WinRt($op, [Type]$type) {
  $task = $script:MediaAsTask.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(5000)) { throw 'timed out' }
  return $task.Result
}

function Get-NowPlaying {
  # Returns the best music session as { state, title, artist, album, app }, or
  # $null when no listed music app has a session. A PLAYING session beats a
  # paused one, so a paused Spotify cannot hide a playing Apple Music.
  if (-not $script:MediaReady) { return $null }
  $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
  $mgr = Wait-WinRt ($mgrType::RequestAsync()) $mgrType
  $best = $null
  foreach ($s in $mgr.GetSessions()) {
    $aumid = [string]$s.SourceAppUserModelId
    $name = $null
    foreach ($k in $MusicApps.Keys) { if ($aumid.StartsWith($k, [StringComparison]::OrdinalIgnoreCase)) { $name = $MusicApps[$k]; break } }
    if (-not $name) { continue }
    $status = [string]$s.GetPlaybackInfo().PlaybackStatus
    $state = switch ($status) { 'Playing' { 'playing' } 'Paused' { 'paused' } default { 'stopped' } }
    $p = Wait-WinRt ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    # Apple Music puts "Artist — Album" in the artist field and leaves the
    # album empty; split it so the artist key NEURO folds on stays the artist.
    $artist = [string]$p.Artist; $album = [string]$p.AlbumTitle
    # WARNING  [char]0x2014, NOT '—' in the pattern - verified on this machine
    #   that Windows PowerShell's -match does not match the escape. Apple Music
    #   for Windows sends exactly this shape ("AaRON — Blouson Noir ... - Single").
    if (-not $album -and $artist -match ('^(.+?) ' + [char]0x2014 + ' (.+)$')) { $artist = $Matches[1]; $album = $Matches[2] }
    $item = [pscustomobject]@{ state = $state; title = [string]$p.Title; artist = $artist; album = $album; app = $name }
    if (-not $best -or ($state -eq 'playing' -and $best.state -ne 'playing')) { $best = $item }
  }
  return $best
}

$script:LastMedia = $null       # the last report SENT, as a comparable string
$script:LastMediaState = $null
$script:LastMediaApp = $null
$script:LastMediaAt = [datetime]::MinValue

function Send-NowPlaying {
  $np = $null
  try { $np = Get-NowPlaying } catch { return }  # unreadable is not "stopped"
  if (-not $np) {
    # The app closed. Say "stopped" ONCE, and only if we last said it was
    # playing - otherwise there is nothing on NEURO to correct.
    if ($script:LastMediaState -ne 'playing') { return }
    $np = [pscustomobject]@{ state = 'stopped'; title = $null; artist = $null; album = $null; app = $script:LastMediaApp }
  }
  # WARNING  A PAUSED OR IDLE LAPTOP SAYS NOTHING unless it is correcting its
  #   own "playing". NEURO keeps ONE now-playing record and the newest report
  #   wins, so an idle Apple Music window posting "stopped" every time the
  #   agent starts would hide a track the PHONE is playing. Found live on the
  #   first run, 16 Oct 2026.
  if ($np.state -ne 'playing' -and $script:LastMediaState -ne 'playing') { return }
  $sig = "$($np.state)|$($np.title)|$($np.artist)|$($np.album)|$($np.app)"
  $due = $np.state -eq 'playing' -and ((Get-Date) - $script:LastMediaAt).TotalSeconds -ge $MediaHeartbeatSeconds
  if ($sig -eq $script:LastMedia -and -not $due) { return }
  $body = @{
    state = $np.state; title = $np.title; artist = $np.artist; album = $np.album; app = $np.app
    client = 'desktop'; at = (Get-Date).ToUniversalTime().ToString('o')
  } | ConvertTo-Json -Compress
  try {
    Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/device/now-playing" `
      -Headers @{ 'X-NEURO-API-TOKEN' = $Token } `
      -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 10 | Out-Null
    $script:LastMedia = $sig; $script:LastMediaState = $np.state; $script:LastMediaApp = $np.app; $script:LastMediaAt = Get-Date
  } catch {
    # Not remembered as sent, so the next pass tries again.
    Write-Warning "now-playing post failed: $($_.Exception.Message)"
  }
}

function Get-Sample {
  $locked = Test-SessionLocked
  [pscustomobject]@{
    at          = (Get-Date).ToUniversalTime().ToString('o')
    # A locked session sends no app at all, not even a stripped one.
    app         = if ($locked) { $null } else { Get-ForegroundProcessName }
    idleSeconds = Get-IdleSeconds
    locked      = $locked
    host        = $env:COMPUTERNAME
    # WARNING  THE AGENT DECLARES WHAT IT UNDERSTANDS. Claiming an intent is a
    #   SERVER-side act, so a version of this script that knows nothing about
    #   intents would still cause one to be claimed - and would then discard it
    #   with the response, losing it silently. Nick would have pressed a button
    #   and nothing would ever happen. So the server only hands intents to an
    #   agent that says it can act on them. Same rule as refusing a NOVA bridge
    #   that predates a field: a reader older than its writer must announce
    #   itself rather than be assumed capable.
    canOpen     = @($AppCommands.Keys | Sort-Object)
    # The Watch lock's own health (Brief 004): mode, presence verdict and
    # counts only. Lets NEURO's Set up tell a running lock from a missing one.
    watchLock   = Get-WatchLockReport
  }
}

function Send-Sample($sample) {
  $body = $sample | ConvertTo-Json -Compress
  Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/desktop/activity" `
    -Headers @{ 'X-NEURO-API-TOKEN' = $Token } `
    -ContentType 'application/json' -Body $body -TimeoutSec 10
}


if ($Once) {
  # One read of the Watch, never an action: -Once must not lock the machine.
  if ($WatchLock -ne 'off') {
    $script:WLAssessment = Get-PresenceAssessment (Read-WatchPresence $PresenceFile) ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    Write-Host "Watch lock: mode $WatchLock, presence file $PresenceFile"
  }
  $s = Get-Sample
  # Printed so the installer can show what would be sent BEFORE it is sent —
  # the privacy claim above should be checkable, not taken on trust.
  Write-Host "Sample: $($s | ConvertTo-Json -Compress)"
  $result = Send-Sample $s
  Write-Host "NEURO stored: $($result | ConvertTo-Json -Compress)"
  # WARNING  -Once runs intents too. A check mode that skips the interesting
  #   half is a check that proves the boring half.
  Invoke-DeskIntents $result
  $np = $null; try { $np = Get-NowPlaying } catch { }
  Write-Host "Now playing: $(if ($np) { $np | ConvertTo-Json -Compress } else { 'no music app session' })"
  Send-NowPlaying
  return
}

Write-Host "NEURO desktop agent -> $BaseUrl. Sampling every ${IntervalSeconds}s, checking for launches every ${ClaimSeconds}s, Watch lock '$WatchLock' every ${WatchLockSeconds}s. Ctrl+C to stop."
$nextSample = [datetime]::MinValue
$nextMedia = [datetime]::MinValue
$nextClaim = [datetime]::MinValue
$nextLock = [datetime]::MinValue
while ($true) {
  # The WATCH LOCK, on the fastest clock (Electron ticked every 2 s). Never
  # allowed to stop the loop: a broken lock is reported, the agent keeps going.
  if ((Get-Date) -ge $nextLock) {
    try { Invoke-WatchLockTick } catch { $script:WLCounters.failures++; Write-Warning "watch-lock tick failed: $($_.Exception.Message)" }
    $nextLock = (Get-Date).AddSeconds($WatchLockSeconds)
  }

  # What is PLAYING, on a third clock. Never allowed to stop the loop.
  if ((Get-Date) -ge $nextMedia) {
    Send-NowPlaying
    $nextMedia = (Get-Date).AddSeconds($MediaSeconds)
  }

  # The SAMPLE, on its own slow clock.
  if ((Get-Date) -ge $nextSample) {
    try {
      # The response is still read: a sample post can also carry an intent,
      # so a press is never lost even if the claim poll is failing.
      $resp = Send-Sample (Get-Sample)
      Invoke-DeskIntents $resp
    } catch {
      # Dropped, never queued. This answers "what is he doing NOW", and a
      # sample delivered an hour late answers a question nobody is asking.
      Write-Warning "post failed: $($_.Exception.Message)"
    }
    $nextSample = (Get-Date).AddSeconds($IntervalSeconds)
  }

  # The BUTTON, on its own fast one.
  if ((Get-Date) -ge $nextClaim) {
    Invoke-DeskIntents (Get-DeskIntents)
    $nextClaim = (Get-Date).AddSeconds($ClaimSeconds)
  }

  Start-Sleep -Seconds 1
}
