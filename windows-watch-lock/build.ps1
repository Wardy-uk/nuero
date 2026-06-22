# Build a single-file WatchLock.exe with PyInstaller.
# Run from this folder:  .\build.ps1
$ErrorActionPreference = "Stop"

py -m pip install --prefer-binary -r requirements.txt pyinstaller

py -m PyInstaller --noconfirm --onefile --windowed `
  --name WatchLock `
  --collect-all bleak `
  --collect-all winrt `
  watch_lock.py

Write-Host ""
Write-Host "Built: dist\WatchLock.exe"
Write-Host "config.json is read from the SAME folder as the .exe at runtime."
Write-Host "If the exe can't see the Watch but 'py watch_lock.py' can, it's a missing"
Write-Host "hidden import — run from source and tell Claude the error."
