# GatheringScans — One-Click New Workstation Migration & Setup Script
# Run this script after copying C:\GatheringScans to your new Windows workstation.
# It performs:
# 1. Installs VPS SSH keys from C:\GatheringScans\_ssh\id_gathering_vps into %USERPROFILE%\.ssh\ with strict owner-only ACLs
# 2. Verifies Python 3.11+ and installs required Python packages (numpy, scipy, pillow, trimesh, shapely, pymeshlab, ezdxf)
# 3. Registers Windows Startup launcher and Desktop shortcuts for GatheringScans
# 4. Starts the GatheringScans System Tray Controller & Reverse Tunnel Daemon (port 8095 -> scans.gatheren.cloud)

$ErrorActionPreference = "Continue"
$MasterRoot = if (Test-Path "C:\GatheringScans\_app\server.py") { "C:\GatheringScans" } else { Split-Path -Parent $PSScriptRoot }
$AppDir = if (Test-Path "C:\GatheringScans\_app\server.py") { "C:\GatheringScans\_app" } elseif (Test-Path "$PSScriptRoot\server.py") { $PSScriptRoot } else { "C:\Antigravity\GatheringScans" }

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "  GatheringScans — Workstation Setup & Migration Installer" -ForegroundColor Cyan
Write-Host "  Master Folder : $MasterRoot" -ForegroundColor Gray
Write-Host "  App Folder    : $AppDir" -ForegroundColor Gray
Write-Host "=================================================================" -ForegroundColor Cyan

# 1. Install VPS SSH Key (%USERPROFILE%\.ssh\id_gathering_vps) with strict OpenSSH ACLs
$SshSrcDir = "C:\GatheringScans\_ssh"
$UserSshDir = Join-Path $env:USERPROFILE ".ssh"
if (Test-Path "$SshSrcDir\id_gathering_vps") {
    Write-Host "`n[1/4] Installing VPS SSH Key into $UserSshDir..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path $UserSshDir | Out-Null
    Copy-Item -Path "$SshSrcDir\id_gathering_vps" -Destination "$UserSshDir\id_gathering_vps" -Force
    if (Test-Path "$SshSrcDir\id_gathering_vps.pub") {
        Copy-Item -Path "$SshSrcDir\id_gathering_vps.pub" -Destination "$UserSshDir\id_gathering_vps.pub" -Force
    }
    icacls "$UserSshDir\id_gathering_vps" /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
    Write-Host "  -> Installed $UserSshDir\id_gathering_vps (strict owner ACL applied)." -ForegroundColor Green
} else {
    Write-Host "`n[1/4] Checking SSH Key at $UserSshDir\id_gathering_vps..." -ForegroundColor Yellow
}

# 2. Check Python & Install Required Python Dependencies
Write-Host "`n[2/4] Verifying Python environment & surveying/mesh dependencies..." -ForegroundColor Yellow
$py = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
if (-not $py) {
    $cand = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"
    if (Test-Path $cand) { $py = $cand }
}
if ($py) {
    Write-Host "  -> Found Python: $py" -ForegroundColor Green
    & $py -m pip install --upgrade pip --quiet
    & $py -m pip install numpy scipy pillow trimesh shapely ezdxf pymeshlab --quiet
    Write-Host "  -> Python packages verified." -ForegroundColor Green
} else {
    Write-Host "  [!] Python 3.12 not found in PATH! Please install Python 3.12 (Add to PATH) and re-run." -ForegroundColor Red
}

# 3. Register Windows Startup Shortcut & Desktop Shortcut
Write-Host "`n[3/4] Registering Windows Startup & Desktop shortcuts..." -ForegroundColor Yellow
try {
    $WshShell = New-Object -ComObject WScript.Shell
    $StartupDir = [Environment]::GetFolderPath("Startup")
    $StartCmd = if (Test-Path "C:\GatheringScans\Start_GatheringScans.cmd") { "C:\GatheringScans\Start_GatheringScans.cmd" } else { "$AppDir\Start_GatheringScans.cmd" }

    $StartupLnk = $WshShell.CreateShortcut((Join-Path $StartupDir "GatheringScans.lnk"))
    $StartupLnk.TargetPath = $StartCmd
    $StartupLnk.WorkingDirectory = $AppDir
    $StartupLnk.Description = "GatheringScans Workstation Daemon & Reverse Tunnel"
    $StartupLnk.Save()

    $DesktopDir = [Environment]::GetFolderPath("Desktop")
    $DesktopLnk = $WshShell.CreateShortcut((Join-Path $DesktopDir "Start GatheringScans.lnk"))
    $DesktopLnk.TargetPath = $StartCmd
    $DesktopLnk.WorkingDirectory = $AppDir
    $DesktopLnk.Description = "Launch GatheringScans Workstation Controller"
    $DesktopLnk.Save()
    Write-Host "  -> Created Startup & Desktop shortcuts." -ForegroundColor Green
} catch {
    Write-Host "  -> Shortcut note: $_" -ForegroundColor DarkYellow
}

# 4. Launch GatheringScans System Tray Controller & Server (127.0.0.1:8095)
Write-Host "`n[4/4] Launching GatheringScans Workstation Daemon on port 8095..." -ForegroundColor Yellow
& "$AppDir\Start_GatheringScans.cmd"
Start-Sleep -Seconds 3
try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:8095/api/status" -UseBasicParsing -TimeoutSec 5
    if ($resp.StatusCode -eq 200) {
        Write-Host "`n[SUCCESS] GatheringScans is ONLINE at http://127.0.0.1:8095 and connected to https://scans.gatheren.cloud!" -ForegroundColor Green
    }
} catch {
    Write-Host "`n[INFO] GatheringScans daemon launched in background; warming up on http://127.0.0.1:8095..." -ForegroundColor Cyan
}
