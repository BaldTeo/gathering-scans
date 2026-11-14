# GatheringScans Workstation Watchdog & Auto-Start Launcher
# Checks if GatheringScans (127.0.0.1:8095) is already listening; if not, synchronizes
# <MasterRoot>\_app and launches start_gathering_scans.py via WMI Win32_Process Create.

$ErrorActionPreference = "SilentlyContinue"
$OverrideJson = Join-Path $env:LOCALAPPDATA "GatheringScans\$env:COMPUTERNAME\data\local_workstation_override.json"
$ConfiguredRoot = ""
if (Test-Path $OverrideJson) {
    try {
        $ov = Get-Content $OverrideJson -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($ov.root_dir -and (Test-Path (Split-Path -Qualifier $ov.root_dir))) {
            $ConfiguredRoot = [string]$ov.root_dir
        }
    } catch {}
}
$MasterRoot = if ($ConfiguredRoot) {
    $ConfiguredRoot
} elseif ($env:LOCAL_SCANS_ROOT -and (Test-Path (Split-Path -Qualifier $env:LOCAL_SCANS_ROOT))) {
    $env:LOCAL_SCANS_ROOT
} elseif ($env:COMPUTERNAME -eq "DESKTOP-ETIHJO1" -and (Test-Path "D:\")) {
    "D:\GatheringScans"
} elseif ($env:COMPUTERNAME -eq "DESKTOP-OEBISC7" -and (Test-Path "C:\GatheringScans")) {
    "C:\GatheringScans"
} elseif (Test-Path "D:\GatheringScans") {
    "D:\GatheringScans"
} elseif (Test-Path "C:\GatheringScans") {
    "C:\GatheringScans"
} else {
    "C:\GatheringScans"
}
$WorkDir = if (Test-Path "$MasterRoot\_app\start_gathering_scans.py") {
    "$MasterRoot\_app"
} elseif ($PSScriptRoot -and (Test-Path "$PSScriptRoot\start_gathering_scans.py")) {
    $PSScriptRoot
} else {
    "C:\Antigravity\GatheringScans"
}

# Keep master portable folder <MasterRoot>\_app synchronized when running on dev PC
if ((Test-Path "C:\Antigravity\GatheringScans\server.py") -and (Test-Path $MasterRoot)) {
    New-Item -ItemType Directory -Force -Path "$MasterRoot\_app" | Out-Null
    robocopy "C:\Antigravity\GatheringScans" "$MasterRoot\_app" /E /XO /R:1 /W:1 /XD "data" "__pycache__" "glb_cache" "backups" ".agents" "target" ".git" /XF ".env" "gathering_scans.db" /NFL /NDL /NJH /NJS /NP | Out-Null
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
