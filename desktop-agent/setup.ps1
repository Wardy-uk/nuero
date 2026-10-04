<#
.SYNOPSIS
  NEURO set-up check for this Windows laptop. Checks what is not set up, offers
  to fix each thing, and reports the result to NEURO's Set up screen.

.DESCRIPTION
  Checks, in order:
    agent          the desktop activity agent is installed and running
    apps           apps.json tells the agent which browser / editor / music app to open
    saim-electron  the SAiM desktop window is installed, with a Desktop shortcut
    mcp            NEURO tools are configured for Claude (reported, not changed)
    neuro          NEURO answers with this machine's credential

  Nothing is changed without asking, unless -Yes is given. -Check only looks.
  Every fix is one of the steps already documented in this repo; this script
  just does them in order and says what it did.

  Windows PowerShell 5.1 compatible (no ?? or ternaries).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File desktop-agent\setup.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File desktop-agent\setup.ps1 -Check
#>
param(
  [switch]$Check,
  [switch]$Yes,
  [string]$BaseUrl,
  [string]$Token
)

$ErrorActionPreference = 'Stop'
$Repo        = Split-Path -Parent $PSScriptRoot
$TaskName    = 'NEURO Desktop Agent'
$ConfigPath  = Join-Path $env:LOCALAPPDATA 'neuro\desktop-agent.json'
$AppsDir     = Join-Path $env:LOCALAPPDATA 'neuro-agent'
$AppsPath    = Join-Path $AppsDir 'apps.json'
$ElectronDir = Join-Path $Repo 'saim\desktop-electron'
$Shortcut    = Join-Path ([Environment]::GetFolderPath('Desktop')) 'SAiM.lnk'
$results     = New-Object System.Collections.ArrayList

function Say($text, $colour) { if ($colour) { Write-Host $text -ForegroundColor $colour } else { Write-Host $text } }
function Ask($question) {
  if ($Check) { return $false }
  if ($Yes) { return $true }
  $a = Read-Host "$question [Y/n]"
  return ($a -eq '' -or $a -match '^[Yy]')
}
function Record($id, $ok, $detail) {
  [void]$results.Add(@{ id = $id; ok = [bool]$ok; detail = $detail })
  if ($ok) { Say "  OK   $id - $detail" Green } else { Say "  TODO $id - $detail" Yellow }
}

# The credential: the agent's own config, unless given.
$cfg = $null
if (Test-Path $ConfigPath) { try { $cfg = Get-Content -Raw $ConfigPath | ConvertFrom-Json } catch { $cfg = $null } }
if (-not $BaseUrl -and $cfg) { $BaseUrl = [string]$cfg.baseUrl }
if (-not $Token -and $cfg) { $Token = [string]$cfg.token }

Say "`nNEURO set-up check - $env:COMPUTERNAME`n" Cyan

# ── 1. Desktop agent ─────────────────────────────────────────────────────────
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task -and (Test-Path $ConfigPath)) {
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
  $running = $task.State -eq 'Running'
  if (-not $running -and (Ask 'The agent is installed but not running. Start it now?')) {
    Start-ScheduledTask -TaskName $TaskName; Start-Sleep -Seconds 3
    $running = (Get-ScheduledTask -TaskName $TaskName).State -eq 'Running'
  }
  $state = 'stopped'
  if ($running) { $state = 'running' }
  Record 'agent' $running "scheduled task $state"
} else {
  Say '  The desktop activity agent is not installed.'
  if ((Ask 'Install it now? (needs the NEURO address and API token)')) {
    if (-not $BaseUrl) { $BaseUrl = Read-Host 'NEURO address (e.g. https://pi5.tailecb90f.ts.net)' }
    if (-not $Token) { $sec = Read-Host 'NEURO API token' -AsSecureString; $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)) }
    & (Join-Path $PSScriptRoot 'install.ps1') -BaseUrl $BaseUrl -Token $Token
    $ok = [bool](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
    Record 'agent' $ok 'installed by install.ps1'
  } else {
    Record 'agent' $false 'not installed'
  }
}

# ── 2. apps.json ─────────────────────────────────────────────────────────────
function Resolve-App($cmd) {
  if (-not $cmd) { return $false }
  if ($cmd -like 'shell:*') { return $true }               # a Store app AUMID; Start-Process takes it as-is
  if (Test-Path $cmd) { return $true }
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { return $true }
  # Start-Process also finds programs registered under App Paths (how 'chrome'
  # launches without being on PATH), so a check that ignored it would call a
  # working entry broken.
  $exe = $cmd
  if ($exe -notlike '*.exe') { $exe = "$cmd.exe" }
  foreach ($root in @('HKCU:', 'HKLM:')) {
    if (Test-Path "$root\Software\Microsoft\Windows\CurrentVersion\App Paths\$exe") { return $true }
  }
  return $false
}
function Find-First($candidates) {
  foreach ($c in $candidates) { if ($c -and (Resolve-App $c)) { return $c } }
  return $null
}
$apps = $null
if (Test-Path $AppsPath) { try { $apps = Get-Content -Raw $AppsPath | ConvertFrom-Json } catch { $apps = $null } }
$missing = @()
if ($apps) {
  foreach ($k in @('browser', 'code', 'music', 'terminal')) {
    if ($apps.PSObject.Properties.Name -contains $k -and -not (Resolve-App ([string]$apps.$k))) { $missing += $k }
  }
}
if ($apps -and $missing.Count -eq 0) {
  Record 'apps' $true ("apps.json: " + (($apps.PSObject.Properties | ForEach-Object { $_.Name }) -join ', '))
} else {
  $why = 'no apps.json'
  if ($apps) { $why = "these do not resolve: $($missing -join ', ')" }
  Say "  apps.json: $why"
  $found = [ordered]@{
    browser  = Find-First @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", 'chrome', 'msedge')
    code     = Find-First @('code', "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe")
    music    = $null
    terminal = Find-First @('wt', 'powershell')
  }
  $am = Get-StartApps -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'Apple Music' } | Select-Object -First 1
  if ($am) { $found.music = "shell:AppsFolder\$($am.AppID)" } else { $found.music = Find-First @('spotify', 'iTunes') }
  $write = [ordered]@{}
  foreach ($k in $found.Keys) { if ($found[$k]) { $write[$k] = $found[$k] } }
  Say ("  Found: " + (($write.Keys | ForEach-Object { "$_ = $($write[$_])" }) -join '; '))
  if ($write.Count -gt 0 -and (Ask "Write $AppsPath with these?")) {
    if (-not (Test-Path $AppsDir)) { New-Item -ItemType Directory -Path $AppsDir -Force | Out-Null }
    $write | ConvertTo-Json | Set-Content -Path $AppsPath -Encoding UTF8
    Say '  Written. The agent reads it on its next start; restarting it now.'
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*neuro-desktop-agent.ps1*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      Start-ScheduledTask -TaskName $TaskName
    }
    Record 'apps' $true ("apps.json: " + ($write.Keys -join ', '))
  } else {
    Record 'apps' $false $why
  }
}

# ── 3. SAiM desktop window ───────────────────────────────────────────────────
$hasModules = Test-Path (Join-Path $ElectronDir 'node_modules\electron')
$hasShortcut = Test-Path $Shortcut
if (-not $hasModules -and (Test-Path $ElectronDir) -and (Ask 'SAiM desktop dependencies are missing. Run npm install there?')) {
  Push-Location $ElectronDir
  try { npm install --no-fund --no-audit | Out-Host } finally { Pop-Location }
  $hasModules = Test-Path (Join-Path $ElectronDir 'node_modules\electron')
}
if (-not $hasShortcut -and (Test-Path (Join-Path $ElectronDir 'SAiM.vbs')) -and (Ask 'No SAiM shortcut on the Desktop. Create one?')) {
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($Shortcut)
  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $lnk.Arguments = '"' + (Join-Path $ElectronDir 'SAiM.vbs') + '"'
  $lnk.WorkingDirectory = $ElectronDir
  $lnk.Description = 'SAiM'
  $lnk.Save()
  $hasShortcut = Test-Path $Shortcut
}
$detail = @()
if ($hasModules) { $detail += 'installed' } else { $detail += 'dependencies missing' }
if ($hasShortcut) { $detail += 'Desktop shortcut' } else { $detail += 'no shortcut' }
Record 'saim-electron' ($hasModules -and $hasShortcut) ($detail -join ', ')

# ── 4. NEURO tools in Claude (report only) ───────────────────────────────────
$mcpFound = @()
foreach ($p in @((Join-Path $env:USERPROFILE '.claude.json'), (Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'))) {
  if (Test-Path $p) {
    try {
      $j = Get-Content -Raw $p | ConvertFrom-Json
      if ($j.mcpServers) {
        $names = $j.mcpServers.PSObject.Properties | ForEach-Object { $_.Name } | Where-Object { $_ -match 'neuro' }
        if ($names) { $mcpFound += "$((Split-Path -Leaf $p)): $($names -join ', ')" }
      }
    } catch { }
  }
}
if ($mcpFound.Count -gt 0) { Record 'mcp' $true ($mcpFound -join '; ') }
else { Record 'mcp' $false "none configured - claude mcp add neuro -- node `"$Repo\mcp-server\index.js`"" }

# ── 5. NEURO reachable, and the report ───────────────────────────────────────
if ($BaseUrl -and $Token) {
  $hdr = @{ 'X-NEURO-API-TOKEN' = $Token }
  try {
    $setup = Invoke-RestMethod -Uri "$BaseUrl/api/setup" -Headers $hdr -TimeoutSec 15
    Record 'neuro' $true "$BaseUrl answered"
    $body = @{ platform = 'windows'; host = $env:COMPUTERNAME; checks = @($results) } | ConvertTo-Json -Depth 4
    Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/setup/report" -Headers $hdr -ContentType 'application/json' -Body $body -TimeoutSec 15 | Out-Null
    Say "`nReported to NEURO's Set up screen." Cyan
    $open = @($setup.items | Where-Object { $_.status -eq 'todo' -or $_.status -eq 'attention' })
    if ($open.Count -gt 0) {
      Say "`nStill to do elsewhere ($($open.Count)):" Cyan
      foreach ($i in $open) { Say "  - [$($i.surface)] $($i.title)" }
    }
  } catch {
    Record 'neuro' $false "could not reach $BaseUrl ($($_.Exception.Message))"
  }
} else {
  Record 'neuro' $false 'no address or token - install the agent first, or pass -BaseUrl and -Token'
}

$todo = @($results | Where-Object { -not $_.ok }).Count
if ($todo -eq 0) { Say "`nThis laptop is set up." Green } else { Say "`n$todo thing(s) on this laptop still to do. Re-run any time." Yellow }
