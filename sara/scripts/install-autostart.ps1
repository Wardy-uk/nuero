# install-autostart.ps1 — register SARA to launch at login (Windows).
#
# Drops a single shortcut in the current user's Startup folder that runs
# start-sara-windows.ps1 hidden. Re-run to refresh; delete the shortcut to disable:
#   Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\SARA.lnk"

$root = 'C:\Users\NickW\Claude\nuero'
$launcher = Join-Path $root 'sara\scripts\start-sara-windows.ps1'
$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'SARA.lnk'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnkPath)
$sc.TargetPath = $psExe
$sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
$sc.WorkingDirectory = $root
$sc.WindowStyle = 7   # minimized — no flashing console
$sc.Description = 'Launch the SARA desktop stack (backend + Watch presence reporter + Electron) at login'
$sc.Save()

Write-Output "Installed: $lnkPath"
Write-Output "  -> $psExe $($sc.Arguments)"
