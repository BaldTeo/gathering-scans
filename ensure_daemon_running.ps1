# GatheringScans Workstation Watchdog & Auto-Start Launcher
# Checks if GatheringScans (127.0.0.1:8095) is already listening; if not, synchronizes
# C:\GatheringScans\_app and launches start_gathering_scans.py via WMI Win32_Process Create.

$ErrorActionPreference = "SilentlyContinue"
$WorkDir = if (Test-Path "C:\GatheringScans\_app\start_gathering_scans.py") {
    "C:\GatheringScans\_app"
} elseif ($PSScriptRoot -and (Test-Path "$PSScriptRoot\start_gathering_scans.py")) {
    $PSScriptRoot
} else {
    "C:\Antigravity\GatheringScans"
}

# Keep master portable folder C:\GatheringScans\_app synchronized when running on dev PC
if ((Test-Path "C:\Antigravity\GatheringScans\server.py") -and (Test-Path "C:\GatheringScans")) {
    New-Item -ItemType Directory -Force -Path "C:\GatheringScans\_app" | Out-Null
    robocopy "C:\Antigravity\GatheringScans" "C:\GatheringScans\_app" /E /XO /R:1 /W:1 /XD "__pycache__" "glb_cache" "backups" ".agents" "target" /NFL /NDL /NJH /NJS /NP | Out-Null
}

$listening = Get-NetTCPConnection -LocalPort 8095 -State Listen -ErrorAction SilentlyContinue
if ($null -ne $listening) {
    exit 0
}

$pyw = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
if (-not $pyw) {
    $cand = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\pythonw.exe"
    $pyw = if (Test-Path $cand) { $cand } else { "pythonw.exe" }
}

$cmdLine = "`"$pyw`" -u `"$WorkDir\start_gathering_scans.py`""
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $cmdLine
    CurrentDirectory = $WorkDir
} | Out-Null
