// Windows lock adapter — dependency-free (no native modules, no compiler).
//   lock(): user32.LockWorkStation via rundll32.
//   wake(): net-zero mouse nudge via a PowerShell Add-Type P/Invoke, so a locked-but-
//           display-off machine wakes and Windows Hello's camera signs you back in.
//           Hello does the actual auth — we store/replay no credential.
//
// Both shell out, so they work the same on x64 and ARM64 with nothing to build.
// (Logic mirrors the standalone watch-lock tool, now living inside SARA.)
const { execFile } = require('child_process');

function lock() {
  return new Promise((resolve) => {
    execFile('rundll32.exe', ['user32.dll,LockWorkStation'], (err) => resolve(!err));
  });
}

// 0xFFFFFFFF (4294967295) as a DWORD = -1 relative move, cancelling the +1 -> cursor
// ends where it started; the input event alone is enough to wake the display.
const WAKE_PS = [
  "Add-Type -Namespace SaraNative -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,System.IntPtr e);';",
  '[SaraNative.U]::mouse_event(1,1,0,0,[System.IntPtr]::Zero);',
  'Start-Sleep -Milliseconds 40;',
  '[SaraNative.U]::mouse_event(1,4294967295,0,0,[System.IntPtr]::Zero);',
].join(' ');

function wake() {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WAKE_PS],
      (err) => resolve(!err),
    );
  });
}

module.exports = { lock, wake, canOSLock: true, name: 'win32' };
