<#
.SYNOPSIS
  Focus blocks on the laptop (1 Nov 2026): open the links NEURO built for the
  task Nick picked, and READ whether Windows' Do Not Disturb is on.
  Dot-sourced by neuro-desktop-agent.ps1.

.DESCRIPTION
  OPENING A LINK
  --------------
  NEURO may hand this agent an `open-url` intent: { id, app: 'open-url', url }.
  The URL is one NEURO built for the task (its vault note, its Jira ticket, its
  draft, or the task in NEURO). It is checked HERE again, against THIS
  machine's own list of hosts, before anything opens - so a server that
  widened its own list still could not widen what the laptop does:

      obsidian://open?vault=<this vault>&file=<path>           (only those two keys)
      https://<allowed host>/browse/<KEY-123>                   (no query)
      https://<allowed host>/?view=drafts | ?view=task&taskId=N

  Allowed hosts default to the Nurtur Jira site and the NEURO desktop app;
  "openUrlHosts" in %LOCALAPPDATA%\neuro\desktop-agent.json replaces the list,
  "obsidianVault" names the vault, "openUrl": false turns the whole thing off
  (the agent then stops declaring 'open-url' and NEURO hands it nothing).
  Never while the session is locked. Start-Process gets the URL and nothing
  else - no program name, no arguments; Windows' own handler opens it.

  DO NOT DISTURB - READ, NEVER SET
  --------------------------------
  Tested on Nick's machine (Windows 11 Pro 26200, 1 Nov 2026), non-admin:
    - Windows.UI.Shell.FocusSessionManager.TryStartFocusSession: refused,
      "Feature com.microsoft.windows.focussessionmanager.1 is not available"
      (a Limited Access Feature; needs a token Microsoft issues per app).
    - Writing WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED (NtUpdateWnfStateData):
      the value changes, but the shell does not follow - the tray bell kept its
      Do-Not-Disturb glyph and toasts behaved the same. A fake signal, not DND.
    - HKCU ...\Notifications\Settings NOC_GLOBAL_SETTING_TOASTS_ENABLED = 0:
      no live effect (ToastNotifier.Setting stayed Enabled), and when it does
      apply it DROPS notifications rather than holding them.
  So nothing here turns DND on. The agent READS the shell's published state
  (the same WNF name, read-only) and reports on / off / unknown, so the focus
  card can say whether the laptop is quiet. Reading changes nothing.

  TESTS: every effect goes through Invoke-NeuroOpenUrlNative, which REFUSES when
  NEURO_AGENT_TEST=1 or NEURO_WATCHLOCK_TEST=1. The pure halves take everything
  they need as arguments.
#>

$script:NeuroDefaultOpenHosts = @('nurturtech.atlassian.net', 'nuero.nickward.co.uk')
$script:NeuroDefaultVault = 'Nicks knowledge base'

# --- PURE ----------------------------------------------------------------------

function Get-NeuroQueryPairs([string]$query) {
  # '?a=1&b=2' -> ordered list of @{k; v} (decoded). $null on anything odd.
  $q = $query.TrimStart('?')
  if (-not $q) { return @() }
  $out = @()
  foreach ($part in $q.Split('&')) {
    $kv = $part.Split('=', 2)
    if ($kv.Count -ne 2 -or -not $kv[0]) { return $null }
    $out += , @{ k = [Uri]::UnescapeDataString($kv[0]); v = [Uri]::UnescapeDataString($kv[1].Replace('+', ' ')) }
  }
  return , $out
}

function Test-NeuroOpenUrl([string]$Url, [string[]]$Hosts = $script:NeuroDefaultOpenHosts, [string]$Vault = $script:NeuroDefaultVault) {
  if (-not $Url -or $Url.Length -gt 600) { return $false }
  foreach ($ch in $Url.ToCharArray()) {
    $c = [int]$ch
    if ($c -le 0x20 -or $c -eq 0x7f -or '"<>`\'.Contains([string]$ch)) { return $false }
  }
  if ($Url -cmatch '^obsidian://open\?(?<q>[^#]*)$') {
    $pairs = Get-NeuroQueryPairs $Matches['q']
    if ($null -eq $pairs -or $pairs.Count -ne 2) { return $false }
    $keys = @($pairs | ForEach-Object { $_.k })
    if (-not ($keys -contains 'vault' -and $keys -contains 'file')) { return $false }
    $gotVault = ($pairs | Where-Object { $_.k -eq 'vault' }).v
    $file = ($pairs | Where-Object { $_.k -eq 'file' }).v
    if ($gotVault -cne $Vault -or -not $file) { return $false }
    if (@(($file -split '[/\\]') | Where-Object { $_ -eq '..' }).Count) { return $false }
    return $true
  }
  $u = $null
  if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$u)) { return $false }
  if ($u.Scheme -ne 'https' -or -not $u.IsDefaultPort -or $u.UserInfo -or $u.Fragment) { return $false }
  if (-not (@($Hosts | ForEach-Object { ([string]$_).ToLowerInvariant() }) -contains $u.Host.ToLowerInvariant())) { return $false }
  $path = $u.AbsolutePath
  if ($path -cmatch '^/browse/[A-Z][A-Z0-9]+-\d+$') { return (-not $u.Query) }
  if ($path -ne '/') { return $false }
  return ($u.Query -cmatch '^\?view=drafts$' -or $u.Query -cmatch '^\?view=task&taskId=\d{1,9}$')
}

function ConvertTo-NeuroDndState($value) {
  # The shell's active quiet-hours profile: 0 = off, 1 = priority only (what
  # Windows 11 calls Do not disturb), 2 = alarms only. Anything else: unknown.
  if ($null -eq $value) { return 'unknown' }
  switch ([int]$value) { 0 { return 'off' } 1 { return 'on' } 2 { return 'on' } default { return 'unknown' } }
}

# Decide what to do with one open-url intent. Effects go through $Native and
# $IsLocked, so tests run it with stubs.
function Invoke-NeuroOpenUrlIntent($Intent, [string[]]$Hosts, [string]$Vault, [scriptblock]$IsLocked, [scriptblock]$Native) {
  $url = [string]$Intent.url
  if (-not (Test-NeuroOpenUrl $url $Hosts $Vault)) { return @{ ok = $false; detail = 'refused: not a link this laptop opens' } }
  if (& $IsLocked) { return @{ ok = $false; detail = 'the laptop is locked' } }
  try { & $Native $url | Out-Null; return @{ ok = $true; detail = 'opened' } }
  catch { return @{ ok = $false; detail = $_.Exception.Message } }
}

# --- NATIVE (the only places with an effect, or a Win32 read) -------------------

function Invoke-NeuroOpenUrlNative([string]$Url) {
  if ($env:NEURO_AGENT_TEST -eq '1' -or $env:NEURO_WATCHLOCK_TEST -eq '1') { throw 'refused: test mode forbids a real open' }
  # The URL is the whole command line: Windows' registered handler for the
  # scheme opens it. No program name, no arguments from anywhere.
  Start-Process -FilePath $Url -ErrorAction Stop | Out-Null
  return $true
}

function Read-WindowsDndState {
  # READ-ONLY: NtQueryWnfStateData on WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED.
  try {
    if (-not ('Neuro.Wnf' -as [type])) {
      Add-Type -Namespace Neuro -Name Wnf -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtQueryWnfStateData(ref ulong StateName, IntPtr TypeId, IntPtr ExplicitScope, out uint ChangeStamp, byte[] Buffer, ref uint BufferSize);'
    }
    $name = [uint64]'0x0D83063EA3BF1C75'
    $buf = New-Object byte[] 8
    $size = [uint32]8
    $stamp = [uint32]0
    $r = [Neuro.Wnf]::NtQueryWnfStateData([ref]$name, [IntPtr]::Zero, [IntPtr]::Zero, [ref]$stamp, $buf, [ref]$size)
    if ($r -ne 0 -or $size -lt 4) { return 'unknown' }
    return ConvertTo-NeuroDndState ([BitConverter]::ToInt32($buf, 0))
  } catch { return 'unknown' }
}
