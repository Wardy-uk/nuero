<#
.SYNOPSIS
  Give the Watch reporter a NEURO startup identity (Brief 004), reversibly.

.DESCRIPTION
  (default)  Creates Startup\NEURO Watch reporter.lnk -> start-watch-reporter.ps1
             (hidden). Starts the reporter now if it is not running.
  -RetireSaimShortcut
             Also MOVES Startup\SAiM.lnk (which ran saim\scripts\start-saim-windows.ps1
             and so the same reporter) to %LOCALAPPDATA%\neuro\retired\startup\.
             Only after the NEURO shortcut exists, so there is never a login
             with no reporter.
  -Restore   Puts Startup\SAiM.lnk back and removes the NEURO shortcut.

  The reporter's behaviour, environment, presence file and Pi sensor push are
  unchanged; both shortcuts start the same idempotent script.
#>
[CmdletBinding()]
param([switch]$RetireSaimShortcut, [switch]$Restore)
$ErrorActionPreference = 'Stop'

$startup  = [Environment]::GetFolderPath('Startup')
$neuroLnk = Join-Path $startup 'NEURO Watch reporter.lnk'
$saimLnk  = Join-Path $startup 'SAiM.lnk'
$retired  = Join-Path $env:LOCALAPPDATA 'neuro\retired\startup'
$stored   = Join-Path $retired 'SAiM.lnk'
$script   = Join-Path $PSScriptRoot 'start-watch-reporter.ps1'
$psExe    = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

if ($Restore) {
  if (Test-Path $stored) { Move-Item $stored $saimLnk -Force; Write-Host "Restored $saimLnk" }
  if (Test-Path $neuroLnk) { Remove-Item $neuroLnk -Force; Write-Host "Removed $neuroLnk" }
  return
}

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($neuroLnk)
$sc.TargetPath = $psExe
$sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$sc.WorkingDirectory = $PSScriptRoot
$sc.WindowStyle = 7
$sc.Description = 'NEURO Watch presence reporter (feeds the desktop agent''s Watch lock and the Pi''s shared presence)'
$sc.Save()
Write-Host "Installed: $neuroLnk"

& $script
Write-Host 'Reporter running (started now if it was not).'

if ($RetireSaimShortcut -and (Test-Path $saimLnk)) {
  New-Item -ItemType Directory -Force -Path $retired | Out-Null
  Move-Item $saimLnk $stored -Force
  Write-Host "Moved $saimLnk -> $stored (restore with -Restore)"
}
