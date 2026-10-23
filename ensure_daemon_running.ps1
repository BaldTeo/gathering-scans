# GatheringScans Workstation Watchdog & Auto-Start Launcher
# Checks if GatheringScans (127.0.0.1:8095) is already listening; if not, launches
# start_gathering_scans.py in a hidden background window logging to data\daemon.log.

$ErrorActionPreference = "SilentlyContinue"
$WorkDir = "C:\Antigravity\GatheringScans"
$LogOut = Join-Path $WorkDir "data\daemon.log"
$LogErr = Join-Path $WorkDir "data\daemon.err.log"

$listening = Get-NetTCPConnection -LocalPort 8095 -State Listen -ErrorAction SilentlyContinue
if ($null -ne $listening) {
    exit 0
}

$env:PYTHONUNBUFFERED = "1"
Set-Location -Path $WorkDir
Start-Process -FilePath "python" `
    -ArgumentList "-u `"$WorkDir\start_gathering_scans.py`"" `
    -WorkingDirectory $WorkDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $LogOut `
    -RedirectStandardError $LogErr
