# GatheringScans Master PowerShell Launcher (Standalone — c:\Antigravity\GatheringScans)
# Starts:
# 1. GatheringScans HTTP Range-Streaming Server (http://127.0.0.1:8095)
# 2. Periodic Google Drive Inbox Watcher (G:\My Drive\SCANS TEST) & PIX4Dmatic 2.11.0 Smart Queue
# 3. Auto-Reconnecting Reverse SSH Tunnel (76.13.197.29:18095 -> 127.0.0.1:8095)

Set-Location -Path $PSScriptRoot
Write-Host "=== Starting GatheringScans (http://127.0.0.1:8095 + VPS Reverse Tunnel 76.13.197.29:18095) ===" -ForegroundColor Cyan
python "$PSScriptRoot\start_gathering_scans.py"
