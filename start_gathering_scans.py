#!/usr/bin/env python3
"""
GatheringScans Master Launcher (Windows Workstation)
Starts:
1. GatheringScans Web & Range-Streaming Server (http://127.0.0.1:8095)
2. Periodic Google Drive Inbox Watcher (G:\\My Drive\\SCANS TEST) & PIX4Dmatic Smart Queue Daemon
3. Auto-Reconnecting Reverse SSH Tunnel to Hostinger VPS (76.13.197.29:18095 -> 127.0.0.1:8095)
"""

import os
import sys
import time
import threading
import subprocess

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from pc_worker.config import (
    SERVER_HOST,
    SERVER_PORT,
    VPS_HOST,
    VPS_USER,
    VPS_SSH_KEY,
    VPS_REMOTE_TUNNEL_PORT,
    GDRIVE_INBOX_DIR,
)
from server import run_server, DB
from pc_worker.gdrive_watcher import seed_and_discover_scans


def inbox_watcher_loop():
    """Periodically polls G:\\My Drive\\SCANS TEST for new Pix4DCatch .zip uploads."""
    while True:
        try:
            seed_and_discover_scans(DB)
        except Exception as e:
            print(f"[InboxWatcher] Poll warning: {e}")
        time.sleep(30)


def ssh_reverse_tunnel_loop():
    """Maintains persistent auto-reconnecting Reverse SSH Tunnel to Hostinger Linux VPS."""
    if not os.path.isfile(VPS_SSH_KEY):
        print(f"[Tunnel] SSH key not found at {VPS_SSH_KEY}; skipping remote tunnel.")
        return

    cmd = [
        "ssh",
        "-i",
        VPS_SSH_KEY,
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ExitOnForwardFailure=yes",
        "-N",
        "-R",
        f"0.0.0.0:{VPS_REMOTE_TUNNEL_PORT}:127.0.0.1:{SERVER_PORT}",
        f"{VPS_USER}@{VPS_HOST}",
    ]
    print(f"[Tunnel] Reverse SSH Tunnel manager started ({VPS_USER}@{VPS_HOST}:{VPS_REMOTE_TUNNEL_PORT} -> 127.0.0.1:{SERVER_PORT})")
    while True:
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            proc.wait()
        except Exception as e:
            print(f"[Tunnel] Connection error: {e}")
        time.sleep(10)



if __name__ == "__main__":
    t_watcher = threading.Thread(target=inbox_watcher_loop, daemon=True)
    t_watcher.start()

    t_tunnel = threading.Thread(target=ssh_reverse_tunnel_loop, daemon=True)
    t_tunnel.start()

    try:
        run_server(host=SERVER_HOST, port=SERVER_PORT)
    except OSError as e:
        print(f"[GatheringScans] Port {SERVER_PORT} is already active ({e}). Keeping Inbox Watcher + VPS Tunnel running...")
        while True:
            time.sleep(10)

