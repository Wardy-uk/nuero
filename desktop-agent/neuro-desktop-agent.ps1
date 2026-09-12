<#
.SYNOPSIS
  Reports what the laptop is doing to NEURO, so SARA can tell working from
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

function Get-Sample {
  $locked = Test-SessionLocked
  [pscustomobject]@{
    at          = (Get-Date).ToUniversalTime().ToString('o')
    # A locked session sends no app at all, not even a stripped one.
    app         = if ($locked) { $null } else { Get-ForegroundProcessName }
    idleSeconds = Get-IdleSeconds
    locked      = $locked
    host        = $env:COMPUTERNAME
  }
}

function Send-Sample($sample) {
  $body = $sample | ConvertTo-Json -Compress
  Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/desktop/activity" `
    -Headers @{ 'X-NEURO-API-TOKEN' = $Token } `
    -ContentType 'application/json' -Body $body -TimeoutSec 10
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
    foreach ($k in $AppCommands.Keys.Clone()) {
      if ($o.PSObject.Properties.Name -contains $k -and $o.$k) { $AppCommands[$k] = [string]$o.$k }
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

function Invoke-DeskIntents($response) {
  if (-not $response) { return }
  $intents = $response.intents
  if (-not $intents) { return }
  foreach ($i in @($intents)) {
    if ($i -and $i.id -and $i.app) { Invoke-DeskIntent $i }
  }
}
if ($Once) {
  $s = Get-Sample
  # Printed so the installer can show what would be sent BEFORE it is sent —
  # the privacy claim above should be checkable, not taken on trust.
  Write-Host "Sample: $($s | ConvertTo-Json -Compress)"
  $result = Send-Sample $s
  Write-Host "NEURO stored: $($result | ConvertTo-Json -Compress)"
  return
}

Write-Host "NEURO desktop agent -> $BaseUrl, every ${IntervalSeconds}s. Ctrl+C to stop."
while ($true) {
  try {
    # The response is no longer discarded: it is how this machine learns it
    # has been asked to open something.
    $resp = Send-Sample (Get-Sample)
    Invoke-DeskIntents $resp
  } catch {
    # Dropped, never queued. This answers "what is he doing NOW", and a sample
    # delivered an hour late answers a question nobody is asking.
    Write-Warning "post failed: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds $IntervalSeconds
}
