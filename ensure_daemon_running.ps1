# GatheringScans Workstation Watchdog & Auto-Start Launcher
# Checks if GatheringScans (127.0.0.1:8095) is already listening; if not, launches
# start_gathering_scans.py via WMI Win32_Process Create so pythonw.exe persists outside
# any temporary PowerShell / Scheduled Task job object.

$ErrorActionPreference = "SilentlyContinue"
$WorkDir = "C:\Antigravity\GatheringScans"

$listening = Get-NetTCPConnection -LocalPort 8095 -State Listen -ErrorAction SilentlyContinue
if ($null -ne $listening) {
    exit 0
}

$pyw = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
if (-not $pyw) {
    $pyw = "pythonw.exe"
}

$cmdLine = "`"$pyw`" -u `"$WorkDir\start_gathering_scans.py`""
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $cmdLine
    CurrentDirectory = $WorkDir
} | Out-Null
