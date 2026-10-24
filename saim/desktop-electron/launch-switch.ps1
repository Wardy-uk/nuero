<#
.SYNOPSIS
  Reversibly disable or restore the standalone SAiM Electron window (Brief 004).

.DESCRIPTION
  -Status   Says what is in place: marker, shortcuts, whether a window is running,
            and the NEURO agent's Watch lock mode (from desktop-agent.json).
  -Disable  1. Refuses unless the agent's Watch lock is "on" — retiring the window
               while the agent is only in shadow would leave NOTHING locking.
               (-Force overrides, for a deliberate no-lock state.)
            2. Writes %LOCALAPPDATA%\neuro\saim-electron.disabled, which SAiM.vbs
               honours from ANY shortcut.
            3. MOVES (never deletes) the SAiM*.lnk shortcuts that point at
               SAiM.vbs/SARA.vbs from the Desktop and Start menu into
               %LOCALAPPDATA%\neuro\retired\electron\, with a manifest of where
               each came from.
            4. With -StopRunning, closes a running SAiM window (Electron started
               from this folder only).
  -Enable   Removes the marker and puts every moved shortcut back where the
            manifest says it came from.

  It never touches: the Watch reporter, its Startup shortcut, the NEURO desktop
  agent, saim/backend on the Pi, or any source. The Electron source and
  node_modules stay until release acceptance (Brief 004 boundary).
#>
[CmdletBinding(DefaultParameterSetName = 'status')]
param(
  [Parameter(ParameterSetName = 'disable')][switch]$Disable,
  [Parameter(ParameterSetName = 'disable')][switch]$StopRunning,
  [Parameter(ParameterSetName = 'disable')][switch]$Force,
  [Parameter(ParameterSetName = 'enable')][switch]$Enable,
  [Parameter(ParameterSetName = 'status')][switch]$Status
)
$ErrorActionPreference = 'Stop'

$neuroDir   = Join-Path $env:LOCALAPPDATA 'neuro'
$marker     = Join-Path $neuroDir 'saim-electron.disabled'
$retiredDir = Join-Path $neuroDir 'retired\electron'
$manifest   = Join-Path $retiredDir 'manifest.json'
$here       = $PSScriptRoot

function Get-AgentWatchLockMode {
  try { $c = Get-Content -Raw (Join-Path $neuroDir 'desktop-agent.json') | ConvertFrom-Json; if ($c.watchLock) { return [string]$c.watchLock } } catch { }
  return 'shadow (default — not set in desktop-agent.json)'
}

function Get-SaimShortcuts {
  $shell = New-Object -ComObject WScript.Shell
  $dirs = @(
    [Environment]::GetFolderPath('Desktop'),
    (Join-Path $env:USERPROFILE 'Desktop'),
    [Environment]::GetFolderPath('Programs')
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
  foreach ($d in $dirs) {
    Get-ChildItem -Path $d -Filter '*.lnk' -File -ErrorAction SilentlyContinue | ForEach-Object {
      $lnk = $shell.CreateShortcut($_.FullName)
      if ("$($lnk.TargetPath) $($lnk.Arguments)" -match '(SAiM|SARA)\.vbs') { $_.FullName }
    }
  }
}

# Windows PowerShell 5 wraps a piped array as {"value":[...],"Count":n} when it is
# serialised, and @(ConvertFrom-Json ...) of an array is ONE element (the array).
# Read either shape, and always write a plain array, or a second -Disable makes
# the manifest unreadable to -Enable and the shortcuts cannot be put back.
function Read-Manifest {
  if (-not (Test-Path $manifest)) { return @() }
  $raw = Get-Content -Raw $manifest | ConvertFrom-Json
  if ($null -ne $raw.value -and $null -eq $raw.from) { $raw = $raw.value }
  return @($raw | ForEach-Object { $_ } | Where-Object { $_.from -and $_.stored })
}
function Write-Manifest($items) {
  ConvertTo-Json -InputObject @($items) -Depth 3 | Set-Content -Path $manifest -Encoding UTF8
}

function Get-RunningWindow {
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$here*" }
}

if ($Enable) {
  if (Test-Path $marker) { Remove-Item $marker -Force; Write-Host "Removed $marker" }
  if (Test-Path $manifest) {
    $items = Read-Manifest
    foreach ($i in $items) {
      if (Test-Path $i.stored) {
        $dir = Split-Path $i.from -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        Move-Item -Path $i.stored -Destination $i.from -Force
        Write-Host "Restored $($i.from)"
      }
    }
    Remove-Item $manifest -Force
  }
  Write-Host 'The SAiM desktop window can be opened again.'
  return
}

if ($Disable) {
  $mode = Get-AgentWatchLockMode
  if ($mode -ne 'on' -and -not $Force) {
    throw "Refusing: the NEURO desktop agent's Watch lock is '$mode', not 'on'. Retiring the window now would leave nothing locking the laptop. Set ""watchLock"": ""on"" in $neuroDir\desktop-agent.json, restart the 'NEURO Desktop Agent' task, confirm Set up shows the Watch lock as done, then run this again (or pass -Force)."
  }
  New-Item -ItemType Directory -Force -Path $retiredDir | Out-Null
  Set-Content -Path $marker -Value "Retired $(Get-Date -Format o) by launch-switch.ps1. Restore: launch-switch.ps1 -Enable" -Encoding UTF8
  Write-Host "Wrote $marker"
  $moved = @(Read-Manifest)
  foreach ($f in @(Get-SaimShortcuts)) {
    $stored = Join-Path $retiredDir ("{0}-{1}" -f ([guid]::NewGuid().ToString('N').Substring(0, 8)), (Split-Path $f -Leaf))
    Move-Item -Path $f -Destination $stored
    $moved += [pscustomobject]@{ from = $f; stored = $stored }
    Write-Host "Moved $f -> $stored"
  }
  Write-Manifest $moved
  if ($StopRunning) {
    foreach ($p in @(Get-RunningWindow)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "Closed SAiM window process $($p.ProcessId)" }
  }
  Write-Host 'The SAiM desktop window is retired. Restore with: launch-switch.ps1 -Enable'
  return
}

# -Status (default)
[pscustomobject]@{
  retiredMarker      = (Test-Path $marker)
  shortcutsInPlace   = @(Get-SaimShortcuts)
  shortcutsRetired   = @(Read-Manifest | ForEach-Object { $_.from })
  windowRunning      = [bool](Get-RunningWindow)
  agentWatchLockMode = Get-AgentWatchLockMode
} | Format-List
