<#
.SYNOPSIS
  Watch presence -> Windows lock, owned by the NEURO Desktop Agent (D-007,
  Build Brief 004, 24 Oct 2026). Dot-sourced by neuro-desktop-agent.ps1.

.DESCRIPTION
  A faithful port of saim/desktop-electron/presenceLock.js, which made the same
  decision inside the SAiM Electron window. The lock moves here because
  Electron's version only ran WHILE THAT WINDOW WAS OPEN, and nothing noticed
  when it was not.

  THE RULES, UNCHANGED FROM ELECTRON (and pinned by a parity test that runs the
  same scenarios through both):
    - A presence file older than 30 s, unreadable, undated or undecided is
      BLIND: nothing is locked and any countdown is abandoned. A dead reporter
      whose last word was "away" must never lock the machine for ever.
    - Two consecutive fresh "away" reads ARM a 5 s grace period; keyboard or
      mouse input inside 5 s cancels it. Only then does it lock.
    - It must have SEEN him present before the first lock (also after every
      lock, and after an agent restart).
    - Coming back to a machine it locked, it WAKES the display (a net-zero
      mouse nudge) so Windows Hello can sign him in. Nothing here unlocks
      anything or holds a credential.

  MODES (the agent's -WatchLock / desktop-agent.json "watchLock"):
    off     nothing is read or decided.
    shadow  DEFAULT. Decides every tick and REPORTS what it would have done;
            never locks, wakes or notifies. This is the soak: it runs beside
            Electron's lock without acting twice.
    on      decides and acts: warns (toast), locks, wakes.

  THIS FILE IS SPLIT IN TWO. The top half is PURE (no file, no clock, no
  Win32), so tests run it with injected time, idle and presence. The bottom
  half is the only place a real lock or wake can happen, and it refuses to do
  either when NEURO_WATCHLOCK_TEST=1.
#>

$script:WL_STALE_MS = 30000     # the reporter heartbeats ~6 s; 30 s old is a dead reporter
$script:WL_AWAY_STREAK = 2      # consecutive fresh "away" reads before a lock is armed
$script:WL_GRACE_MS = 5000      # warning time between arming and locking
$script:WL_INPUT_GRACE_S = 5    # input this recent means he is at the keyboard

# --- PURE ----------------------------------------------------------------------

function New-WatchLockState {
  @{ awayCount = 0; graceUntil = $null; lockedBySaim = $false; armed = $false }
}

function ConvertTo-WatchLockMs($value) {
  if ($null -eq $value) { return $null }
  try {
    if ($value -is [datetime]) { return [DateTimeOffset]::new($value.ToUniversalTime()).ToUnixTimeMilliseconds() }
    $dto = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse([string]$value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$dto)) {
      return $dto.ToUnixTimeMilliseconds()
    }
  } catch { }
  return $null
}

function Get-PresenceAssessment($payload, [long]$nowMs) {
  if ($null -eq $payload -or -not ($payload -is [psobject] -or $payload -is [hashtable])) { return @{ known = $false; why = 'unreadable' } }
  $updated = ConvertTo-WatchLockMs $payload.updated
  if ($null -eq $updated) { return @{ known = $false; why = 'no-timestamp' } }
  # A STALE FILE IS A BLIND READING, NEVER "AWAY" (see the header).
  if (($nowMs - $updated) -gt $script:WL_STALE_MS) { return @{ known = $false; why = 'stale'; ageMs = ($nowMs - $updated) } }
  if ($payload.status -eq 'away' -or $payload.away -eq $true) { return @{ known = $true; away = $true; ageMs = ($nowMs - $updated) } }
  if ($payload.status -eq 'present' -or $payload.present -eq $true) { return @{ known = $true; away = $false; ageMs = ($nowMs - $updated) } }
  return @{ known = $false; why = 'undecided'; ageMs = ($nowMs - $updated) }
}

<#
  One tick. Returns @{ state; action; assessment } where action is one of
  $null | 'warn' | 'cancel-warn' | 'lock' | 'wake'. Mirrors presenceLock.step.
#>
function Step-WatchLock([hashtable]$prev, $payload, [long]$nowMs, $idleS) {
  $s = @{ awayCount = $prev.awayCount; graceUntil = $prev.graceUntil; lockedBySaim = $prev.lockedBySaim; armed = $prev.armed }
  $r = Get-PresenceAssessment $payload $nowMs
  $inputFresh = ($null -ne $idleS) -and ([double]$idleS -lt $script:WL_INPUT_GRACE_S)
  $out = { param($a) @{ state = $s; action = $a; assessment = $r } }

  # Blind: act on nothing, and abandon any countdown — never lock on a guess.
  if (-not $r.known) {
    $s.awayCount = 0
    if ($null -ne $s.graceUntil) { $s.graceUntil = $null; return (& $out 'cancel-warn') }
    return (& $out $null)
  }

  if (-not $r.away) {
    $s.awayCount = 0
    $s.armed = $true
    if ($s.lockedBySaim) { $s.lockedBySaim = $false; return (& $out 'wake') }
    if ($null -ne $s.graceUntil) { $s.graceUntil = $null; return (& $out 'cancel-warn') }
    return (& $out $null)
  }

  # Away.
  if ($s.lockedBySaim -or -not $s.armed) { return (& $out $null) }

  # Fresh keyboard/mouse input overrides the Watch.
  if ($inputFresh) {
    $s.awayCount = 0
    if ($null -ne $s.graceUntil) { $s.graceUntil = $null; return (& $out 'cancel-warn') }
    return (& $out $null)
  }

  if ($null -ne $s.graceUntil) {
    if ($nowMs -ge $s.graceUntil) {
      $s.graceUntil = $null
      $s.awayCount = 0
      $s.lockedBySaim = $true
      $s.armed = $false   # re-arms only once he has been seen present again
      return (& $out 'lock')
    }
    return (& $out $null)
  }

  $s.awayCount = $s.awayCount + 1
  if ($s.awayCount -ge $script:WL_AWAY_STREAK) {
    $s.graceUntil = $nowMs + $script:WL_GRACE_MS
    return (& $out 'warn')
  }
  return (& $out $null)
}

<# The session was locked by any means (Electron: powerMonitor 'lock-screen'). #>
function Set-WatchLockScreenLocked([hashtable]$prev) {
  $s = $prev.Clone(); $s.graceUntil = $null; $s.awayCount = 0; return $s
}

<# Windows was unlocked by any means (Hello, PIN): the lock is no longer ours. #>
function Set-WatchLockOSUnlocked([hashtable]$prev) {
  $s = $prev.Clone(); $s.lockedBySaim = $false; $s.graceUntil = $null; $s.awayCount = 0; return $s
}

# --- EFFECTS (the only place a lock or wake can happen) ------------------------

function Read-WatchPresence([string]$path) {
  # Read quickly and let go: the reporter's atomic replace is refused while any
  # reader holds the file (it retries and skips; a skipped write reads as stale).
  try { return ([IO.File]::ReadAllText($path) | ConvertFrom-Json) } catch { return $null }
}

function Invoke-WatchLockNative([string]$what) {
  if ($env:NEURO_WATCHLOCK_TEST -eq '1') { throw "refused: NEURO_WATCHLOCK_TEST=1 forbids a real $what" }
  if ($what -eq 'lock') {
    # user32!LockWorkStation, the same call Electron's win32 adapter made.
    Start-Process -FilePath 'rundll32.exe' -ArgumentList 'user32.dll,LockWorkStation' -WindowStyle Hidden | Out-Null
    return $true
  }
  if ($what -eq 'wake') {
    if (-not ('Neuro.WatchLockNative' -as [type])) {
      Add-Type -Namespace Neuro -Name WatchLockNative -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, System.IntPtr e);'
    }
    # Net-zero nudge: +1 then -1 (0xFFFFFFFF as a DWORD). The input event alone wakes the display.
    [Neuro.WatchLockNative]::mouse_event(1, 1, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [Neuro.WatchLockNative]::mouse_event(1, 4294967295, 0, 0, [IntPtr]::Zero)
    return $true
  }
  if ($what -eq 'warn') {
    try {
      [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
      $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
      $t = $xml.GetElementsByTagName('text')
      [void]$t.Item(0).AppendChild($xml.CreateTextNode('NEURO'))
      [void]$t.Item(1).AppendChild($xml.CreateTextNode('Your Watch has gone — locking in 5 seconds. Move the mouse to stop it.'))
      $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
      [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
      return $true
    } catch { return $false }   # a warning that cannot show must never stop the lock or the loop
  }
  return $false
}

<#
  Carry out (or, in shadow, only record) one decided action.
  -Native is injectable so tests record calls instead of touching Windows.
  Returns @{ acted; would } — what was done, and what would have been done.
#>
function Invoke-WatchLockAction([string]$mode, $action, [scriptblock]$Native = ${function:Invoke-WatchLockNative}) {
  if (-not $action -or $action -eq 'cancel-warn') { return @{ acted = $null; would = $action } }
  if ($mode -ne 'on') { return @{ acted = $null; would = $action } }
  $ok = $false
  try { $ok = [bool](& $Native $action) } catch { $ok = $false }
  return @{ acted = $(if ($ok) { $action } else { "$action-failed" }); would = $action }
}

<#
  What the agent tells NEURO about the lock (the `watchLock` field on every
  activity sample). Counts, states and timestamps only — never the RSSI, never
  the Watch's identity, never anything from the presence file but its verdict.
#>
function Get-WatchLockStatus([string]$mode, [hashtable]$assessment, [hashtable]$counters, [hashtable]$state, [datetime]$startedAt) {
  $presence = 'blind'
  if ($assessment -and $assessment.known) { $presence = $(if ($assessment.away) { 'away' } else { 'present' }) }
  $age = $null
  if ($assessment -and $null -ne $assessment.ageMs) { $age = [int][Math]::Round($assessment.ageMs / 1000) }
  [pscustomobject]@{
    mode         = $mode
    presence     = $presence
    why          = $(if ($assessment -and -not $assessment.known) { $assessment.why } else { $null })
    presenceAgeS = $age
    armed        = [bool]($state -and $state.armed)
    lockedByUs   = [bool]($state -and $state.lockedBySaim)
    locks        = [int]$counters.locks
    wouldLock    = [int]$counters.wouldLock
    wakes        = [int]$counters.wakes
    failures     = [int]$counters.failures
    lastAction   = $counters.lastAction
    lastActionAt = $counters.lastActionAt
    since        = $startedAt.ToUniversalTime().ToString('o')
  }
}
