@echo off
powershell -NoProfile -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '\"C:\Users\user\AppData\Local\Programs\Python\Python312\pythonw.exe\" \"c:\Antigravity\GatheringScans\pc_worker\daemon_watchdog.py\"'; CurrentDirectory = 'c:\Antigravity\GatheringScans' } | Out-Null"
