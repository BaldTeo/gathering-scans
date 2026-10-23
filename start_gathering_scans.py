#!/usr/bin/env python3
"""
GatheringScans Master Launcher (Windows Workstation)
Starts:
1. GatheringScans Web & Range-Streaming Server (http://127.0.0.1:8095)
2. Periodic Google Drive Inbox Watcher (G:\\Shared drives\\6.軟體\\3. GatheringScans) & PIX4Dmatic Smart Queue Daemon
3. Auto-Reconnecting Reverse SSH Tunnel to Hostinger VPS (76.13.197.29:18095 -> 127.0.0.1:8095)
"""

import os
import glob
import time
import sys
import threading
import subprocess
from typing import Optional, Tuple

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
    LOCAL_SCANS_ROOT,
)
from server import (
    run_server,
    start_pc_reverse_tunnel_pool,
    DB,
    GCHAT,
    AUTH_SHARE,
    is_pc_daemon_running,
    mark_daemon_poll_completed,
    _DAEMON_WAKE_EVENT,
)
from pc_worker.gdrive_watcher import seed_and_discover_scans
from pc_worker.gdrive_cloud_sync import sync_all_scans_to_gdrive_and_vps
from pc_worker.pix4d_runner import (
    run_pix4dmatic_pipeline,
    parse_pix4dmatic_log_progress,
    postprocess_obj_to_tileset,
)


_INITIAL_DISCOVERY_DONE = threading.Event()


def _detect_running_pix4dmatic() -> Tuple[bool, str, str]:
    """
    Checks if PIX4Dmatic.exe is currently running on the workstation.
    Returns (is_running, inferred_scan_id, latest_log_path).
    """
    if os.name != "nt":
        return False, "", ""
    try:
        r = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq PIX4Dmatic.exe", "/NH"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if "PIX4Dmatic.exe" not in (r.stdout or ""):
            return False, "", ""
    except Exception:
        return False, "", ""

    # Find the most recently updated PIX4Dmatic project log
    all_scans = DB.list_scans()
    active_proc_ids = {s["scan_id"] for s in all_scans if s.get("status") == "processing"}
    candidate_logs = []
    for s in all_scans:
        sid = s["scan_id"]
        pdir = s.get("project_dir") or os.path.join(LOCAL_SCANS_ROOT, sid)
        log_dirs = [
            os.path.join(pdir, sid, "logs"),
            os.path.join(pdir, "project", "logs"),
            os.path.join(LOCAL_SCANS_ROOT, sid, sid, "logs"),
        ]
        if sid == "QuChi261016_Trees" and sid in active_proc_ids:
            log_dirs.append(os.path.join(LOCAL_SCANS_ROOT, "catch_QuChi261016", "catch_QuChi261016", "logs"))
        for ldir in log_dirs:
            if os.path.isdir(ldir):
                for lp in glob.glob(os.path.join(ldir, "*.txt")):
                    try:
                        is_active_Bonus = 1 if sid in active_proc_ids else 0
                        candidate_logs.append((os.path.getmtime(lp), is_active_Bonus, sid, lp))
                    except OSError:
                        pass
    if not candidate_logs:
        return True, "", ""
    candidate_logs.sort(key=lambda x: (x[0], x[1]))
    _, _, inferred_sid, latest_log = candidate_logs[-1]
    # Ensure no other scan is left with stale processing status
    for s in all_scans:
        if s.get("status") == "processing" and s["scan_id"] != inferred_sid:
            DB.update_job_progress(s["scan_id"], "completed", 100.0, "Completed")
    return True, inferred_sid, latest_log


def inbox_discovery_loop():
    """
    Polls G:\\Shared drives\\6.軟體\\3. GatheringScans and C:\\GatheringScans every 10s,
    copies completed scan folders from Google Drive to local disk, tiles standalone .obj
    meshes, and updates the SQLite index immediately without waiting for PIX4Dmatic jobs.
    Respects Admin Panel Start/Stop Daemon toggle (is_pc_daemon_running).
    """
    last_completed_sig = None
    while True:
        _DAEMON_WAKE_EVENT.clear()
        if is_pc_daemon_running():
            try:
                seed_and_discover_scans(DB)
                mark_daemon_poll_completed()
                cur_sig = tuple(
                    sorted(
                        (s["scan_id"], str(s.get("tileset_path") or ""))
                        for s in DB.list_scans()
                        if s.get("status") == "completed"
                    )
                )
                if cur_sig != last_completed_sig:
                    last_completed_sig = cur_sig
                    try:
                        sync_all_scans_to_gdrive_and_vps(DB, AUTH_SHARE, force=False)
                    except Exception as se:
                        print(f"[InboxDiscovery] Cloud sync note: {se}")
            except Exception as e:
                print(f"[InboxDiscovery] Poll warning: {e}")
            finally:
                _INITIAL_DISCOVERY_DONE.set()
        else:
            _INITIAL_DISCOVERY_DONE.set()
        _DAEMON_WAKE_EVENT.wait(timeout=10.0)


def pix4d_worker_loop():
    """
    Dedicated background worker thread that:
    1. Monitors any currently running PIX4Dmatic.exe process and synchronizes its live
       progress into ScanQueueDB so the Queue UI and API always reflect reality.
    2. Pops the highest-priority queued Pix4DCatch .zip / reprocess job and runs the
       PIX4Dmatic 2.11.0 + GC_ScanOptimizer pipeline.
    """
    _INITIAL_DISCOVERY_DONE.wait(timeout=60)
    adopted_sid: Optional[str] = None

    while True:
        if not is_pc_daemon_running():
            time.sleep(3)
            continue
        try:
            is_running, running_sid, latest_log = _detect_running_pix4dmatic()
            if is_running and running_sid:
                adopted_sid = running_sid
                info = parse_pix4dmatic_log_progress(latest_log)
                pct = float(info.get("progress_pct", 15.0))
                stg = info.get("stage", "Processing")
                cpu_ram = info.get("cpu_ram", "")
                label = f"PIX4Dmatic: {stg} ({cpu_ram})" if cpu_ram else f"PIX4Dmatic: {stg}"
                DB.update_job_progress(running_sid, "processing", pct, label)
                time.sleep(4)
                continue

            # Recover any orphaned "processing" job if PIX4Dmatic is not running
            if not adopted_sid:
                for s_row in DB.list_scans():
                    if s_row.get("status") == "processing":
                        adopted_sid = s_row["scan_id"]
                        break

            # If an adopted PIX4Dmatic job just finished, finalize its tileset, mark completed, and notify uploader on Google Chat
            if adopted_sid:
                fin_sid = adopted_sid
                adopted_sid = None
                scan_row = DB.get_scan(fin_sid) or {}
                proj_dir = scan_row.get("project_dir") or os.path.join(LOCAL_SCANS_ROOT, fin_sid)
                exp_dirs = [os.path.join(proj_dir, "exports")]
                if fin_sid == "catch_QuChi261016":
                    exp_dirs.append(os.path.join(LOCAL_SCANS_ROOT, "QuChi261016_Trees", "exports"))
                objs = []
                for exp_dir in exp_dirs:
                    if os.path.isdir(exp_dir):
                        for r_dir, _, r_files in os.walk(exp_dir):
                            for f in r_files:
                                if f.lower().endswith(".obj"):
                                    fp = os.path.join(r_dir, f)
                                    objs.append((os.path.getmtime(fp), fp))
                objs.sort(key=lambda x: x[0], reverse=True)
                newest_obj = objs[0][1] if objs else (scan_row.get("obj_path") or "")
                ts_path = scan_row.get("tileset_path") or os.path.join(proj_dir, "tileset", "tileset.json")
                if newest_obj and os.path.isfile(newest_obj):
                    # If OBJ is newer than tileset.json, rebuild tileset + preview + DSM
                    if not os.path.isfile(ts_path) or os.path.getmtime(newest_obj) > os.path.getmtime(ts_path):
                        DB.update_job_progress(
                            fin_sid, "processing", 96.0, "Building Hierarchical 3D Tileset in GC_ScanOptimizer..."
                        )
                        built_ts = postprocess_obj_to_tileset(fin_sid, proj_dir, newest_obj)
                        if built_ts:
                            ts_path = built_ts
                if os.path.isfile(ts_path) or (newest_obj and os.path.isfile(newest_obj)):
                    DB.update_job_progress(
                        fin_sid,
                        "completed",
                        100.0,
                        "Completed (TWD97 + TWVD2001, 4K Web Tileset)",
                        tileset_path=ts_path if os.path.isfile(ts_path) else None,
                        obj_path=newest_obj if os.path.isfile(newest_obj) else None,
                    )
                    try:
                        from pc_worker.gdrive_watcher import _discover_folder_scan_item
                        disc = _discover_folder_scan_item(proj_dir)
                        if disc:
                            cur_row = DB.get_scan(fin_sid) or {}
                            merged = dict(cur_row)
                            merged.update(disc)
                            merged["scan_id"] = fin_sid
                            merged["status"] = "completed"
                            merged["progress_pct"] = 100.0
                            if cur_row.get("source_zip_path"):
                                merged["source_zip_path"] = cur_row["source_zip_path"]
                            if cur_row.get("project_group") and cur_row["project_group"] != "General / Unassigned":
                                merged["project_group"] = cur_row["project_group"]
                            if cur_row.get("project_name_zh"):
                                merged["project_name_zh"] = cur_row["project_name_zh"]
                            if int(cur_row.get("image_count") or 0) > int(merged.get("image_count") or 0):
                                merged["image_count"] = int(cur_row["image_count"])
                            DB.upsert_scan(merged)
                    except Exception as de:
                        print(f"[InboxWatcher] Metadata refresh note for {fin_sid}: {de}")
                    try:
                        if not GCHAT.has_recent_notification(fin_sid, within_seconds=120.0):
                            GCHAT.notify_scan_ready(fin_sid)
                    except Exception as ge:
                        print(f"[InboxWatcher] Google Chat notify note for {fin_sid}: {ge}")
                    print(f"[InboxWatcher] Adopted PIX4Dmatic job {fin_sid} completed -> {ts_path}")
                else:
                    DB.update_job_progress(fin_sid, "queued", 0.0, "Queued (Awaiting PIX4Dmatic pipeline)")

            next_job = DB.pop_next_job()
            if next_job:
                sid = next_job["scan_id"]
                src_zip = next_job.get("source_zip_path") or ""
                out_dir = next_job.get("project_dir") or os.path.join(LOCAL_SCANS_ROOT, sid)

                print(f"[InboxWatcher] Auto-starting PIX4Dmatic pipeline for {sid}: {src_zip or out_dir}")

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
                        f"Completed (TWD97 + TWVD2001, {res.get('texture_size', 4096)}px Web Tileset)",
                        tileset_path=res.get("tileset_path"),
                        obj_path=res.get("obj_path"),
                    )
                    try:
                        from pc_worker.gdrive_watcher import _discover_folder_scan_item
                        disc = _discover_folder_scan_item(out_dir)
                        if disc:
                            cur_row = DB.get_scan(sid) or {}
                            merged = dict(cur_row)
                            merged.update(disc)
                            merged["scan_id"] = sid
                            merged["status"] = "completed"
                            merged["progress_pct"] = 100.0
                            merged["stage_label"] = f"Completed (TWD97 + TWVD2001, {res.get('texture_size', 4096)}px Web Tileset)"
                            if cur_row.get("source_zip_path"):
                                merged["source_zip_path"] = cur_row["source_zip_path"]
                            if cur_row.get("rtk_accuracy_cm"):
                                merged["rtk_accuracy_cm"] = cur_row["rtk_accuracy_cm"]
                            if cur_row.get("project_group") and cur_row["project_group"] != "General / Unassigned":
                                merged["project_group"] = cur_row["project_group"]
                            if cur_row.get("project_name_zh"):
                                merged["project_name_zh"] = cur_row["project_name_zh"]
                            if int(cur_row.get("image_count") or 0) > int(merged.get("image_count") or 0):
                                merged["image_count"] = int(cur_row["image_count"])
                            DB.upsert_scan(merged)
                    except Exception as de:
                        print(f"[InboxWatcher] Metadata refresh note for {sid}: {de}")
                    try:
                        GCHAT.notify_scan_ready(sid)
                    except Exception as ge:
                        print(f"[InboxWatcher] Google Chat notify note: {ge}")
                    print(f"[InboxWatcher] Completed {sid} -> {res.get('tileset_path')}")
                else:
                    err_detail = res.get("error") or f"exit {res.get('return_code')}"
                    DB.update_job_progress(
                        sid,
                        "failed",
                        0.0,
                        f"Pipeline error ({err_detail})",
                    )
        except Exception as e:
            print(f"[InboxWatcher] Worker warning: {e}")
        time.sleep(5)


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
    print(
        f"[Tunnel] Reverse SSH Tunnel manager started ({VPS_USER}@{VPS_HOST}:{VPS_REMOTE_TUNNEL_PORT} -> 127.0.0.1:{SERVER_PORT})"
    )
    while True:
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            proc.wait()
        except Exception as e:
            print(f"[Tunnel] Connection error: {e}")
        time.sleep(10)


def prestage_queued_inputs_loop():
    """
    Background pre-staging worker: while PIX4Dmatic is busy processing the current job,
    pre-extracts `.zip` archives or fast-copies uncompressed Google Drive folders for
    any `queued` jobs onto local SSD (`C:\\GatheringScans\\<scan_id>\\inputs\\`) so the
    next job starts PIX4Dmatic with zero Google Drive staging delay.
    """
    _INITIAL_DISCOVERY_DONE.wait(timeout=60)
    from pc_worker.pix4d_runner import prestage_input_to_local_ssd

    while True:
        if not is_pc_daemon_running():
            time.sleep(5)
            continue
        try:
            scans = DB.list_scans()
            for row in scans:
                if row.get("status") != "queued":
                    continue
                sid = row.get("scan_id") or ""
                src = row.get("source_zip_path") or ""
                out_dir = row.get("project_dir") or os.path.join(LOCAL_SCANS_ROOT, sid)
                if sid and src:
                    if prestage_input_to_local_ssd(src, out_dir):
                        print(f"[PreStager] Pre-staged {sid} inputs to local SSD: {out_dir}\\inputs")
        except Exception as e:
            print(f"[PreStager] Warning: {e}")
        time.sleep(10)


if __name__ == "__main__":
    t_discovery = threading.Thread(target=inbox_discovery_loop, daemon=True)
    t_discovery.start()

    t_worker = threading.Thread(target=pix4d_worker_loop, daemon=True)
    t_worker.start()

    t_prestager = threading.Thread(target=prestage_queued_inputs_loop, daemon=True)
    t_prestager.start()

    start_pc_reverse_tunnel_pool(local_port=SERVER_PORT)

    t_tunnel = threading.Thread(target=ssh_reverse_tunnel_loop, daemon=True)
    t_tunnel.start()

    try:
        run_server(host=SERVER_HOST, port=SERVER_PORT)
    except OSError as e:
        print(
            f"[GatheringScans] Port {SERVER_PORT} is already active ({e}). Keeping Inbox Watcher + VPS Tunnel Pool running..."
        )
        while True:
            time.sleep(10)
