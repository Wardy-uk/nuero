# install-autostart.ps1 — register SAiM to launch at login (Windows).
#
# Drops a single shortcut in the current user's Startup folder that runs
# start-saim-windows.ps1 hidden. Re-run to refresh; delete the shortcut to disable:
#   Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\SAiM.lnk"

$root = 'C:\Users\NickW\Claude\nuero'
$launcher = Join-Path $root 'saim\scripts\start-saim-windows.ps1'
$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'SAiM.lnk'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnkPath)
$sc.TargetPath = $psExe
$sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
$sc.WorkingDirectory = $root
$sc.WindowStyle = 7   # minimized — no flashing console
# Brief 004: this starts NEURO's Watch reporter (and the local backend only with
# SAIM_LOCAL_BACKEND=1) — never the Electron window. Superseded by
# windows-watch-lock\install-startup.ps1, which installs the NEURO-named shortcut.
$sc.Description = 'Start the NEURO Watch presence reporter at login (via start-saim-windows.ps1)'
$sc.Save()

Write-Output "Installed: $lnkPath"
Write-Output "  -> $psExe $($sc.Arguments)"
