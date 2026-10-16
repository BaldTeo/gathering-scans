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
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from pc_worker.config import (
    SERVER_HOST,
    SERVER_PORT,
    VPS_HOST,
    VPS_USER,
    VPS_SSH_KEY,
    VPS_REMOTE_TUNNEL_PORT,
    GDRIVE_INBOX_DIR,
)
from server import run_server, start_pc_reverse_tunnel_pool, DB, GCHAT
from pc_worker.gdrive_watcher import seed_and_discover_scans
from pc_worker.pix4d_runner import run_pix4dmatic_pipeline
from pc_worker.config import LOCAL_SCANS_ROOT


def inbox_watcher_loop():
    """
    Periodically polls C:\\GatheringScans and G:\\Shared drives\\6.軟體\\3. GatheringScans
    for new scan folders and Pix4DCatch .zip uploads, and automatically runs the
    PIX4Dmatic 2.11.0 + GC_ScanOptimizer pipeline on the highest-priority queued job.
    """
    while True:
        try:
            seed_and_discover_scans(DB)
            next_job = DB.pop_next_job()
            if next_job:
                sid = next_job["scan_id"]
                src_zip = next_job.get("source_zip_path") or ""
                if src_zip:
                    print(f"[InboxWatcher] Auto-starting PIX4Dmatic pipeline for {sid}: {src_zip}")
                    out_dir = os.path.join(LOCAL_SCANS_ROOT, sid)

                    def _on_progress(pct: float, stage: str):
                        DB.update_job_progress(sid, "processing", pct, stage)

                    res = run_pix4dmatic_pipeline(
                        scan_id=sid,
                        input_path=src_zip,
                        output_project_dir=out_dir,
                        progress_callback=_on_progress,
                    )
                    if res.get("success") and res.get("tileset_path"):
                        DB.update_job_progress(
                            sid,
                            "completed",
                            100.0,
                            "Completed (TWD97 + TWVD2001, 2K Web Tileset)",
                            tileset_path=res.get("tileset_path"),
                            obj_path=res.get("obj_path"),
                        )
                        try:
                            GCHAT.notify_scan_ready(sid)
                        except Exception as ge:
                            print(f"[InboxWatcher] Google Chat notify note: {ge}")
                        print(f"[InboxWatcher] Completed {sid} -> {res.get('tileset_path')}")
                    else:
                        DB.update_job_progress(
                            sid,
                            "failed",
                            0.0,
                            f"Pipeline error (exit {res.get('return_code')})",
                        )
        except Exception as e:
            print(f"[InboxWatcher] Poll warning: {e}")
        time.sleep(10)


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

    start_pc_reverse_tunnel_pool(local_port=SERVER_PORT)

    t_tunnel = threading.Thread(target=ssh_reverse_tunnel_loop, daemon=True)
    t_tunnel.start()

    try:
        run_server(host=SERVER_HOST, port=SERVER_PORT)
    except OSError as e:
        print(f"[GatheringScans] Port {SERVER_PORT} is already active ({e}). Keeping Inbox Watcher + VPS Tunnel Pool running...")
        while True:
            time.sleep(10)

