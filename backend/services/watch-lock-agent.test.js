'use strict';

/**
 * Build Brief 004 (D-007) — the Watch auto-lock, now owned by the NEURO
 * Desktop Agent (desktop-agent/watch-lock.ps1).
 *
 * The PowerShell port is run in a REAL Windows PowerShell with injected time,
 * idle and presence, and with NEURO_WATCHLOCK_TEST=1, which makes the native
 * lock/wake REFUSE; every effect goes to a recording stub. Nothing here can lock
 * the machine it runs on.
 *
 * PARITY: every scenario runs through BOTH the old Electron decision
 * (saim/desktop-electron/presenceLock.js) and the new port, and the action
 * sequences must be identical. The safety behaviour is preserved by
 * construction, not by re-reading it.
 *
 * Skips, saying so, where there is no Windows PowerShell (the Pi, CI).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MODULE = path.join(ROOT, 'desktop-agent', 'watch-lock.ps1');
const AGENT = path.join(ROOT, 'desktop-agent', 'neuro-desktop-agent.ps1');
const PL = require(path.join(ROOT, 'saim', 'desktop-electron', 'presenceLock.js'));
const PS = process.platform === 'win32' ? 'powershell.exe' : null;
const skip = !PS && 'no Windows PowerShell here — the agent port was NOT exercised';

const T0 = Date.parse('2026-10-24T09:00:00Z');
const at = (s) => T0 + s * 1000;
const fresh = (status, nowS, ageS = 1) => ({ status, away: status === 'away', present: status === 'present', updated: new Date(at(nowS - ageS)).toISOString(), rssi: -60 });

// A tick: { t (seconds), p (payload or null), idle (seconds), ev ('locked'|'unlocked') }
const SCENARIOS = {
  'away then lock, then wake on return': [
    { t: 0, p: fresh('present', 0), idle: 60 },
    { t: 2, p: fresh('away', 2), idle: 60 },
    { t: 4, p: fresh('away', 4), idle: 60 },         // second away: arm (warn)
    { t: 6, p: fresh('away', 6), idle: 60 },         // inside grace: nothing
    { t: 10, p: fresh('away', 10), idle: 60 },       // grace elapsed: lock
    { t: 12, ev: 'locked', p: fresh('away', 12), idle: 60 },
    { t: 30, p: fresh('present', 30), idle: 60 },    // back: wake
    { t: 32, ev: 'unlocked', p: fresh('present', 32), idle: 0 },
  ],
  'present all along: never locks': [0, 2, 4, 6, 8, 10].map((t) => ({ t, p: fresh('present', t), idle: 300 })),
  'stale file saying away: blind, never locks': [
    { t: 0, p: fresh('present', 0), idle: 60 },
    ...[2, 4, 6, 8, 10, 12].map((t) => ({ t, p: fresh('away', t, 45), idle: 60 })),
  ],
  'goes stale mid-countdown: cancels, never locks': [
    { t: 0, p: fresh('present', 0), idle: 60 },
    { t: 2, p: fresh('away', 2), idle: 60 },
    { t: 4, p: fresh('away', 4), idle: 60 },        // warn
    { t: 6, p: fresh('away', 6, 40), idle: 60 },    // stale → cancel-warn
    { t: 10, p: fresh('away', 10, 44), idle: 60 },
  ],
  'unreadable / undecided / undated: blind': [
    { t: 0, p: fresh('present', 0), idle: 60 },
    { t: 2, p: null, idle: 60 },
    { t: 4, p: { status: 'searching', updated: new Date(at(4)).toISOString() }, idle: 60 },
    { t: 6, p: { status: 'away' }, idle: 60 },
    { t: 8, p: null, idle: 60 },
  ],
  'never seen present (fresh start / agent restart): away does not lock': [2, 4, 6, 10, 14].map((t) => ({ t, p: fresh('away', t), idle: 60 })),
  'keyboard input cancels the countdown': [
    { t: 0, p: fresh('present', 0), idle: 60 },
    { t: 2, p: fresh('away', 2), idle: 60 },
    { t: 4, p: fresh('away', 4), idle: 60 },         // warn
    { t: 6, p: fresh('away', 6), idle: 1 },          // input → cancel
    { t: 10, p: fresh('away', 10), idle: 2 },
  ],
  'manual Win+L then walk away, as Electron did': [
    { t: 0, p: fresh('present', 0), idle: 60 },
    { t: 2, ev: 'locked', p: fresh('present', 2), idle: 60 },
    { t: 4, p: fresh('away', 4), idle: 60 },
    { t: 6, p: fresh('away', 6), idle: 60 },
    { t: 12, p: fresh('away', 12), idle: 60 },
    { t: 40, p: fresh('present', 40), idle: 60 },
  ],
};

function electronActions(ticks) {
  let s = PL.initialState();
  const out = [];
  for (const k of ticks) {
    if (k.ev === 'locked') s = { ...s, graceUntil: null, awayCount: 0 };
    if (k.ev === 'unlocked') s = PL.onOSUnlocked(s);
    const r = PL.step(s, { payload: k.p, now: at(k.t), idleS: k.idle });
    s = r.state;
    out.push(r.action);
  }
  return out;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-lock-'));
// ⚠ A SECOND, INDEPENDENT GUARD. Every harness process shadows Start-Process
//   and Add-Type with functions that throw, so even a module whose
//   NEURO_WATCHLOCK_TEST guard was broken (or removed by a mutation check)
//   cannot lock or wake this machine. Added after exactly that mutation
//   locked the developer's laptop on 24 Oct 2026. Functions beat cmdlets.
const BLOCKERS = [
  "function global:Start-Process { throw 'test harness: Start-Process is blocked' }",
  "function global:Add-Type { throw 'test harness: Add-Type is blocked' }",
].join('\n');

function runPs(script) {
  const file = path.join(tmp, `h${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(file, BLOCKERS + '\n' + script, 'utf8');
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
    encoding: 'utf8', env: { ...process.env, NEURO_WATCHLOCK_TEST: '1' }, timeout: 60000,
  });
  if (r.status !== 0) throw new Error(`powershell failed (${r.status}): ${r.stderr || r.stdout}`);
  const line = r.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith('JSON:')).pop();
  return JSON.parse(line.slice(5));
}
const q = (p) => `'${p.replace(/'/g, "''")}'`;

function portActions(scenarios) {
  const json = path.join(tmp, 'scenarios.json');
  fs.writeFileSync(json, JSON.stringify(Object.fromEntries(Object.entries(scenarios).map(([k, ticks]) => [k, ticks.map((x) => ({ ...x, now: at(x.t) }))]))), 'utf8');
  return runPs(`
$ErrorActionPreference = 'Stop'
. ${q(MODULE)}
$all = Get-Content -Raw ${q(json)} | ConvertFrom-Json
$out = @{}
foreach ($prop in $all.PSObject.Properties) {
  $s = New-WatchLockState; $acts = @()
  foreach ($k in $prop.Value) {
    if ($k.ev -eq 'locked') { $s = Set-WatchLockScreenLocked $s }
    if ($k.ev -eq 'unlocked') { $s = Set-WatchLockOSUnlocked $s }
    $r = Step-WatchLock $s $k.p ([long]$k.now) $k.idle
    $s = $r.state; $acts += ,$r.action
  }
  $out[$prop.Name] = $acts
}
Write-Output ('JSON:' + ($out | ConvertTo-Json -Compress -Depth 5))
`);
}

let port = null;
test.before(() => { if (!skip) port = portActions(SCENARIOS); });

for (const [name, ticks] of Object.entries(SCENARIOS)) {
  test(`parity — ${name}`, { skip }, () => {
    const want = electronActions(ticks);
    const got = (port[name] || []).map((a) => (a === undefined ? null : a));
    assert.deepEqual(got, want, `agent port disagrees with Electron for "${name}"`);
  });
}

test('the scenarios really exercise the rules (positive control on the Electron side)', () => {
  const a = electronActions(SCENARIOS['away then lock, then wake on return']);
  assert.deepEqual(a.filter(Boolean), ['warn', 'lock', 'wake']);
  assert.ok(!electronActions(SCENARIOS['present all along: never locks']).includes('lock'));
  assert.ok(!electronActions(SCENARIOS['stale file saying away: blind, never locks']).includes('lock'));
  assert.ok(!electronActions(SCENARIOS['never seen present (fresh start / agent restart): away does not lock']).includes('lock'));
  assert.deepEqual(electronActions(SCENARIOS['goes stale mid-countdown: cancels, never locks']).filter(Boolean), ['warn', 'cancel-warn']);
});

test('modes: shadow records but never calls native; on calls the (stubbed) native; failures are reported', { skip }, () => {
  const r = runPs(`
$ErrorActionPreference = 'Stop'
. ${q(MODULE)}
$calls = New-Object System.Collections.ArrayList
$rec = { param($what) [void]$calls.Add($what); $true }
$bad = { param($what) throw 'boom' }
$o = @{
  shadowLock = Invoke-WatchLockAction 'shadow' 'lock' $rec
  shadowWake = Invoke-WatchLockAction 'shadow' 'wake' $rec
  callsAfterShadow = @($calls).Count
  onLock = Invoke-WatchLockAction 'on' 'lock' $rec
  onWake = Invoke-WatchLockAction 'on' 'wake' $rec
  onCancel = Invoke-WatchLockAction 'on' 'cancel-warn' $rec
  onFail = Invoke-WatchLockAction 'on' 'lock' $bad
  offLock = Invoke-WatchLockAction 'off' 'lock' $rec
}
$o.calls = @($calls)
Write-Output ('JSON:' + ($o | ConvertTo-Json -Compress -Depth 5))
`);
  assert.equal(r.callsAfterShadow, 0, 'shadow never touches Windows');
  assert.equal(r.shadowLock.acted, null); assert.equal(r.shadowLock.would, 'lock');
  assert.equal(r.onLock.acted, 'lock'); assert.equal(r.onWake.acted, 'wake');
  assert.equal(r.onCancel.acted, null);
  assert.equal(r.onFail.acted, 'lock-failed', 'a native failure is reported, not swallowed');
  assert.equal(r.offLock.acted, null);
  assert.deepEqual(r.calls, ['lock', 'wake', 'lock'].slice(0, 2), 'only the two "on" actions reached native');
});

test('the harness itself blocks Start-Process and Add-Type (checked with harmless calls only)', { skip }, () => {
  const r = runPs(`
$res = @{}
try { Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','exit' | Out-Null; $res.start = 'RAN' } catch { $res.start = $_.Exception.Message }
try { Add-Type -TypeDefinition 'public class NeuroHarnessProbe {}' ; $res.add = 'RAN' } catch { $res.add = $_.Exception.Message }
Write-Output ('JSON:' + ($res | ConvertTo-Json -Compress))
`);
  assert.match(r.start, /harness: Start-Process is blocked/);
  assert.match(r.add, /harness: Add-Type is blocked/);
});

test('the REAL native lock refuses under NEURO_WATCHLOCK_TEST=1 (the safety seam itself)', { skip }, () => {
  const r = runPs(`
. ${q(MODULE)}
$res = @{}
foreach ($w in 'lock','wake') { try { Invoke-WatchLockNative $w | Out-Null; $res[$w] = 'RAN' } catch { $res[$w] = $_.Exception.Message } }
Write-Output ('JSON:' + ($res | ConvertTo-Json -Compress))
`);
  assert.match(r.lock, /refused: NEURO_WATCHLOCK_TEST=1/);
  assert.match(r.wake, /refused: NEURO_WATCHLOCK_TEST=1/);
});

test('status telemetry: mode, verdict and counts only — never the RSSI or the Watch identity', { skip }, () => {
  const r = runPs(`
. ${q(MODULE)}
$a = Get-PresenceAssessment ([pscustomobject]@{ status = 'away'; updated = (Get-Date).AddSeconds(-90).ToUniversalTime().ToString('o'); rssi = -61; irk = 'secret' }) ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
$st = Get-WatchLockStatus 'shadow' $a @{ locks = 0; wouldLock = 3; wakes = 0; failures = 0; lastAction = 'would-lock'; lastActionAt = '2026-10-24T09:00:00Z' } (New-WatchLockState) (Get-Date)
Write-Output ('JSON:' + ($st | ConvertTo-Json -Compress))
`);
  assert.equal(r.mode, 'shadow'); assert.equal(r.presence, 'blind'); assert.equal(r.why, 'stale');
  assert.ok(r.presenceAgeS >= 89 && r.presenceAgeS <= 92);
  assert.equal(r.wouldLock, 3); assert.equal(r.armed, false);
  assert.ok(!JSON.stringify(r).match(/rssi|irk|secret|-61/i), 'nothing from the presence file but its verdict');
});

test('source: a real lock/wake exists only inside Invoke-WatchLockNative; -Once never acts; the agent dot-sources the module', () => {
  const mod = fs.readFileSync(MODULE, 'utf8');
  const nativeStart = mod.indexOf('function Invoke-WatchLockNative');
  const nativeEnd = mod.indexOf('function Invoke-WatchLockAction');
  assert.ok(nativeStart > 0 && nativeEnd > nativeStart);
  const outside = mod.slice(0, nativeStart) + mod.slice(nativeEnd);
  assert.doesNotMatch(outside.replace(/^\s*#.*$/gm, ''), /LockWorkStation|mouse_event\(1/, 'no lock/wake outside the native function');
  const agent = fs.readFileSync(AGENT, 'utf8');
  assert.match(agent, /\. \(Join-Path \$PSScriptRoot 'watch-lock\.ps1'\)/);
  assert.doesNotMatch(agent, /LockWorkStation|rundll32/, 'the agent never locks directly');
  const once = agent.slice(agent.indexOf('if ($Once) {'), agent.indexOf('Write-Host "NEURO desktop agent ->'));
  assert.doesNotMatch(once, /Invoke-WatchLockAction|Invoke-WatchLockTick|Invoke-WatchLockNative/, '-Once never acts');
  assert.match(agent, /\[string\]\$WatchLock = 'shadow'/, 'shadow is the default');
  assert.match(agent, /watchLock\s+= Get-WatchLockReport/, 'status rides on every sample');
  // Recovery: a failing tick is counted and the loop keeps going; a restart starts unarmed
  // (the "never seen present" parity scenario), so it cannot lock until it has seen him.
  assert.match(agent, /try \{ Invoke-WatchLockTick \} catch \{ \$script:WLCounters\.failures\+\+/);
  assert.match(agent, /\$script:WL = New-WatchLockState/);
});
