#!/usr/bin/env python3
"""
GatheringScans (scans.gatheren.cloud) — Unified HTTP Range-Streaming & Civil Surveying Server
Streams 3D Tilesets (.json, .glb), .obj meshes, and RTK camera photos directly from the Windows PC
(C:\\Scans and GC_ScanOptimizer), exposes the Smart Priority Queue, PIX4Dmatic GST engine,
Civil Surveying & CAD Export APIs, Scoped External Share Links, and Client-Side Offline Cache manifests.
"""

import os
import re
import sys
import gzip
import json
import time
import queue
import select
import socket
import struct
import base64
import shutil
import html
import hashlib
import mimetypes
import threading
import http.client
import urllib.parse
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, Any, Optional, Tuple

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
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
    PUBLIC_BASE_URL,
    TUNNEL_SHARED_KEY,
    LOCAL_SCANS_ROOT,
    REPORTS_DIR,
    CONTOURS_DIR,
    GDRIVE_INBOX_DIR,
    GDRIVE_INPUTS_DIR,
    MATERIAL_CATALOG,
    TWD97_TWVD2001_LABEL,
    TWD97_TWVD2001_SHORT,
    PIX4DMATIC_TEXTURE_SIZE,
    GOOGLE_OAUTH_CLIENT_ID,
    GDRIVE_SERVICE_ACCOUNT_EMAIL,
    GDRIVE_SERVICE_ACCOUNT_PROJECT_ID,
    load_pix4d_settings,
    save_pix4d_settings,
    load_pix4d_settings_from_dict,
)
from pc_worker.priority_queue import ScanQueueDB
from pc_worker.gdrive_watcher import seed_and_discover_scans, extract_opf_zip_metadata
from pc_worker.pix4d_runner import (
    generate_pix4dmatic_gst_script,
    run_pix4dmatic_pipeline,
    parse_pix4dmatic_log_progress,
)
from pc_worker.optimizer_bridge import OptimizerBridge
from pc_worker.surveying_engine import SurveyingEngine
from pc_worker.auth_and_sharing import (
    AuthAndSharingManager,
    ROLE_LEVELS,
    ROLE_LABELS,
    normalize_role,
    get_role_permissions,
    verify_session_token,
    is_link_preview_bot,
    parse_user_agent,
)
from pc_worker.gchat_notifier import GoogleChatNotifier

DATA_DIR = os.path.join(BASE_DIR, "data")
WEB_DIR = os.path.join(BASE_DIR, "web")
THUMBS_DIR = os.path.join(DATA_DIR, "thumbnails")
GLB_CACHE_DIR = os.path.join(DATA_DIR, "glb_cache")
os.makedirs(WEB_DIR, exist_ok=True)
os.makedirs(THUMBS_DIR, exist_ok=True)
os.makedirs(GLB_CACHE_DIR, exist_ok=True)

# Initialize Singletons
DB = ScanQueueDB()
_FS_SYNC_LOCK = threading.Lock()
_LAST_FS_SYNC_TS = 0.0
_LAST_FS_FINGERPRINT: Optional[Tuple[str, ...]] = None

DAEMON_STATE_PATH = os.path.join(DATA_DIR, "daemon_state.json")
_DAEMON_PROCESS_START_TS = time.time()
_DAEMON_LAST_POLL_TS = 0.0
_DAEMON_WAKE_EVENT = threading.Event()
_PIX4D_WAKE_EVENT = threading.Event()


def load_pc_daemon_state() -> Dict[str, Any]:
    state: Dict[str, Any] = {
        "daemon_running": True,
        "updated_at": _DAEMON_PROCESS_START_TS,
        "updated_by": "system",
    }
    if os.path.isfile(DAEMON_STATE_PATH):
        try:
            with open(DAEMON_STATE_PATH, "r", encoding="utf-8") as f:
                saved = json.load(f)
            if isinstance(saved, dict):
                state["daemon_running"] = bool(saved.get("daemon_running", True))
                state["updated_at"] = float(saved.get("updated_at", _DAEMON_PROCESS_START_TS))
                state["updated_by"] = str(saved.get("updated_by", "system"))
        except Exception:
            pass
    return state


def is_pc_daemon_running() -> bool:
    return bool(load_pc_daemon_state().get("daemon_running", True))


def mark_daemon_poll_completed() -> None:
    global _DAEMON_LAST_POLL_TS
    _DAEMON_LAST_POLL_TS = time.time()


def set_pc_daemon_running(running: bool, actor_email: str = "admin") -> Dict[str, Any]:
    global PC_SIMULATED_OFFLINE
    state = {
        "daemon_running": bool(running),
        "updated_at": time.time(),
        "updated_by": actor_email or "admin",
    }
    try:
        with open(DAEMON_STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"[GatheringScans] Warning saving daemon_state.json: {e}")
    if running:
        PC_SIMULATED_OFFLINE = False
        _DAEMON_WAKE_EVENT.set()
        _PIX4D_WAKE_EVENT.set()
        if os.name == "nt":
            def _immediate_discover():
                try:
                    seed_and_discover_scans(DB)
                    mark_daemon_poll_completed()
                    if "AUTH_SHARE" in globals():
                        from pc_worker.gdrive_cloud_sync import sync_all_scans_to_gdrive_and_vps
                        sync_all_scans_to_gdrive_and_vps(DB, AUTH_SHARE, force=False)
                except Exception as ex:
                    print(f"[GatheringScans] Daemon start discovery note: {ex}")
            threading.Thread(target=_immediate_discover, daemon=True).start()
    return get_pc_daemon_status()


def set_pc_simulated_offline(offline: bool) -> Dict[str, Any]:
    """
    Toggles in-memory Browser Offline Cache testing mode without stopping or pausing
    the Windows Workstation background Inbox Watcher or PIX4Dmatic queue daemon.
    """
    global PC_SIMULATED_OFFLINE
    PC_SIMULATED_OFFLINE = bool(offline)
    return get_pc_daemon_status()


def get_pc_daemon_status() -> Dict[str, Any]:
    st = load_pc_daemon_state()
    running = bool(st.get("daemon_running", True))
    is_win = os.name == "nt"
    scans = DB.list_scans() if is_win else []
    processing = [s for s in scans if s.get("status") == "processing"]
    queued = [s for s in scans if s.get("status") in ("queued", "waiting_parts")]
    return {
        "status": "ok",
        "pc_online": is_win and (not PC_SIMULATED_OFFLINE),
        "pc_reachable": is_win,
        "daemon_running": running,
        "pid": os.getpid() if is_win else None,
        "uptime_seconds": round(max(0.0, time.time() - _DAEMON_PROCESS_START_TS), 1) if is_win else 0.0,
        "last_poll_at": _DAEMON_LAST_POLL_TS,
        "updated_at": st.get("updated_at", 0.0),
        "updated_by": st.get("updated_by", "system"),
        "inbox_dir": GDRIVE_INPUTS_DIR if is_win else "",
        "local_vault_dir": LOCAL_SCANS_ROOT if is_win else "",
        "active_job": processing[0] if processing else None,
        "queued_count": len(queued),
        "total_scans": len(scans),
    }


def _compute_scans_dir_fingerprint() -> Tuple[str, ...]:
    _KNOWN_OUTPUT_SUBDIRS = {"tileset", "exports", "ortho", "dsm", "3d_tiles", "mesh", "pointcloud"}
    _IGNORED_INTERNAL_SUBDIRS = {
        "logs",
        "temp",
        "processing",
        "inputs",
        "images",
        "project",
        "opf_files",
        "meshes",
        "point_clouds",
        "configs",
        "tileset_backup",
        "tileset_prev",
    }
    entries = []
    for root_label, root_dir in (("local", LOCAL_SCANS_ROOT), ("gdrive_inputs", GDRIVE_INPUTS_DIR)):
        if not root_dir or not os.path.isdir(root_dir):
            continue
        try:
            for name in sorted(os.listdir(root_dir)):
                if name.startswith(("_", ".")):
                    continue
                full = os.path.join(root_dir, name)
                if os.path.isdir(full):
                    try:
                        sub = sorted(os.listdir(full))
                    except Exception:
                        sub = []
                    nested_parts = []
                    name_low = name.lower()
                    for sname in sub:
                        if sname.startswith(("_", ".")):
                            continue
                        sname_low = sname.lower()
                        if sname_low == name_low or sname_low in _IGNORED_INTERNAL_SUBDIRS:
                            continue
                        sfull = os.path.join(full, sname)
                        try:
                            if os.path.isdir(sfull):
                                if root_label == "local" and sname_low not in _KNOWN_OUTPUT_SUBDIRS:
                                    continue
                                ssub = [
                                    x for x in sorted(os.listdir(sfull))
                                    if not x.startswith(("_", ".")) and x.lower() not in _IGNORED_INTERNAL_SUBDIRS
                                ][:8]
                                nested_parts.append(f"{sname}[{','.join(ssub)}]")
                            elif sname_low.endswith(".json"):
                                nested_parts.append(sname)
                        except Exception:
                            pass
                    entries.append(f"{root_label}:{name}:{','.join(nested_parts[:24])}")
                elif os.path.isfile(full) and name.lower().endswith(".zip"):
                    try:
                        sz = os.path.getsize(full)
                    except Exception:
                        sz = 0
                    entries.append(f"{root_label}:{name}:{sz}")
        except Exception:
            pass
    return tuple(entries)


def sync_scans_with_filesystem(max_age_s: float = 10.0, force: bool = False) -> None:
    """Live filesystem sync: discovers new folders in C:\\GatheringScans and removes deleted folders."""
    global _LAST_FS_SYNC_TS, _LAST_FS_FINGERPRINT
    if os.name != "nt":
        return
    if not force and not is_pc_daemon_running():
        return
    effective_age = max(10.0, float(max_age_s or 10.0))
    now = time.time()
    if not force and (now - _LAST_FS_SYNC_TS < effective_age):
        return
    with _FS_SYNC_LOCK:
        if not force and (time.time() - _LAST_FS_SYNC_TS < effective_age):
            return
        fp = _compute_scans_dir_fingerprint()
        prev_fp = _LAST_FS_FINGERPRINT
        if force or fp != prev_fp:
            try:
                seed_and_discover_scans(DB)
                mark_daemon_poll_completed()
                _LAST_FS_FINGERPRINT = fp
                if (force or (prev_fp is not None and fp != prev_fp)) and "AUTH_SHARE" in globals():
                    def _bg_cloud_sync():
                        try:
                            from pc_worker.gdrive_cloud_sync import sync_all_scans_to_gdrive_and_vps
                            sync_all_scans_to_gdrive_and_vps(DB, AUTH_SHARE, force=False)
                        except Exception:
                            pass
                    threading.Thread(target=_bg_cloud_sync, daemon=True).start()
            except Exception as e:
                print(f"[GatheringScans] Live filesystem sync note: {e}")
        _LAST_FS_SYNC_TS = time.time()


sync_scans_with_filesystem(force=True)
OPTIMIZER = OptimizerBridge(DB)
SURVEY = SurveyingEngine(DB)
AUTH_SHARE = AuthAndSharingManager(DB)
GCHAT = GoogleChatNotifier(DB)

# Simulated PC Online Toggle (strictly in-memory for browser cache testing; never pauses daemon_state.json)
PC_SIMULATED_OFFLINE = False


def is_pc_simulated_offline() -> bool:
    return bool(PC_SIMULATED_OFFLINE)

# Reverse Tunnel Socket Pool (used on Linux VPS to proxy /api/*, /stream/*, /s/* to Windows PC C:\GatheringScans)
VPS_TUNNEL_POOL: "queue.LifoQueue[Tuple[socket.socket, threading.Event, float, int]]" = queue.LifoQueue()
_VPS_RAM_FALLBACK_CACHE: Dict[str, Tuple[int, Dict[str, str], bytes]] = {}
_TUNNEL_POOL_STARTED = False

CLOUD_MANIFEST_PATH = (
    "/host_docker/gathering_scans/data/gdrive_cloud_manifest.json"
    if os.path.isdir("/host_docker/gathering_scans/data")
    else os.path.join(DATA_DIR, "gdrive_cloud_manifest.json")
)
CLOUD_AUTH_PATH = (
    "/host_docker/gathering_scans/data/gdrive_cloud_auth.json"
    if os.path.isdir("/host_docker/gathering_scans/data")
    else os.path.join(DATA_DIR, "gdrive_cloud_auth.json")
)
_CLOUD_MANIFEST_MEM: Optional[Dict[str, Any]] = None
_CLOUD_AUTH_MEM: Optional[Dict[str, Any]] = None


def _load_cloud_manifest() -> Dict[str, Any]:
    global _CLOUD_MANIFEST_MEM
    if _CLOUD_MANIFEST_MEM is not None:
        return _CLOUD_MANIFEST_MEM
    for cand in (CLOUD_MANIFEST_PATH, os.path.join(DATA_DIR, "gdrive_cloud_manifest.json")):
        if os.path.isfile(cand):
            try:
                with open(cand, "r", encoding="utf-8") as f:
                    _CLOUD_MANIFEST_MEM = json.load(f)
                    return _CLOUD_MANIFEST_MEM
            except Exception:
                pass
    return {}


def _save_cloud_manifest(manifest: Dict[str, Any]) -> None:
    global _CLOUD_MANIFEST_MEM
    _CLOUD_MANIFEST_MEM = manifest
    for cand in {CLOUD_MANIFEST_PATH, os.path.join(DATA_DIR, "gdrive_cloud_manifest.json")}:
        try:
            with open(cand, "w", encoding="utf-8") as f:
                json.dump(manifest, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"[GatheringScans] Cloud manifest save note: {e}")


def _load_cloud_auth() -> Dict[str, Any]:
    global _CLOUD_AUTH_MEM
    if _CLOUD_AUTH_MEM is not None:
        return _CLOUD_AUTH_MEM
    if os.path.isfile(CLOUD_AUTH_PATH):
        try:
            with open(CLOUD_AUTH_PATH, "r", encoding="utf-8") as f:
                _CLOUD_AUTH_MEM = json.load(f)
        except Exception:
            _CLOUD_AUTH_MEM = {}
    else:
        _CLOUD_AUTH_MEM = {}
    if not isinstance(_CLOUD_AUTH_MEM.get("service_account"), dict) or not _CLOUD_AUTH_MEM["service_account"].get("private_key"):
        try:
            from pc_worker.gdrive_cloud_sync import discover_service_account_json_on_disk

            sa_found = discover_service_account_json_on_disk()
            if isinstance(sa_found, dict) and sa_found.get("private_key"):
                _CLOUD_AUTH_MEM["service_account"] = sa_found
                _CLOUD_AUTH_MEM["auth_mode"] = "service_account"
        except Exception:
            pass
    _CLOUD_AUTH_MEM.setdefault("expected_service_account_email", GDRIVE_SERVICE_ACCOUNT_EMAIL)
    _CLOUD_AUTH_MEM.setdefault("expected_project_id", GDRIVE_SERVICE_ACCOUNT_PROJECT_ID)
    return _CLOUD_AUTH_MEM


def _save_cloud_auth(auth_data: Dict[str, Any]) -> None:
    global _CLOUD_AUTH_MEM
    merged = {**_load_cloud_auth(), **auth_data}
    merged.setdefault("expected_service_account_email", GDRIVE_SERVICE_ACCOUNT_EMAIL)
    merged.setdefault("expected_project_id", GDRIVE_SERVICE_ACCOUNT_PROJECT_ID)
    _CLOUD_AUTH_MEM = merged
    try:
        with open(CLOUD_AUTH_PATH, "w", encoding="utf-8") as f:
            json.dump(merged, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[GatheringScans] Cloud auth save note: {e}")


def _sign_rs256_jwt_assertion(sa: Dict[str, Any], scope: str = "https://www.googleapis.com/auth/drive") -> Optional[str]:
    """
    Signs an OAuth2 RS256 JWT assertion for `gcworker@modular-temple-508005-c4.iam.gserviceaccount.com`
    using Python `cryptography` (preferred on Windows & Linux) with fallback to `openssl` CLI.
    """
    import subprocess
    import tempfile

    client_email = str(sa.get("client_email") or GDRIVE_SERVICE_ACCOUNT_EMAIL).strip()
    private_key_pem = str(sa.get("private_key") or "").strip()
    if not client_email or not private_key_pem:
        return None
    if "\\n" in private_key_pem and "\n" not in private_key_pem:
        private_key_pem = private_key_pem.replace("\\n", "\n")

    def _b64u(b: bytes) -> str:
        return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")

    iat = int(time.time())
    hdr_obj: Dict[str, str] = {"alg": "RS256", "typ": "JWT"}
    if sa.get("private_key_id"):
        hdr_obj["kid"] = str(sa["private_key_id"])
    hdr = _b64u(json.dumps(hdr_obj, separators=(",", ":")).encode("utf-8"))
    claims = _b64u(
        json.dumps(
            {
                "iss": client_email,
                "scope": scope,
                "aud": str(sa.get("token_uri") or "https://oauth2.googleapis.com/token"),
                "iat": iat,
                "exp": iat + 3600,
            },
            separators=(",", ":"),
        ).encode("utf-8")
    )
    signing_input = f"{hdr}.{claims}".encode("ascii")

    # 1. Try native Python cryptography first
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding

        priv_key = serialization.load_pem_private_key(private_key_pem.encode("utf-8"), password=None)
        sig = priv_key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
        if sig:
            return f"{hdr}.{claims}.{_b64u(sig)}"
    except Exception:
        pass

    # 2. Fallback to openssl or Git for Windows openssl.exe
    openssl_bins = ["openssl", r"C:\Program Files\Git\usr\bin\openssl.exe"]
    with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False, encoding="utf-8") as kf:
        kf.write(private_key_pem)
        pem_path = kf.name
    try:
        for obin in openssl_bins:
            try:
                proc = subprocess.run(
                    [obin, "dgst", "-sha256", "-sign", pem_path],
                    input=signing_input,
                    capture_output=True,
                    timeout=5,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0,
                )
                if proc.returncode == 0 and proc.stdout:
                    return f"{hdr}.{claims}.{_b64u(proc.stdout)}"
            except Exception:
                continue
    finally:
        try:
            os.remove(pem_path)
        except OSError:
            pass
    return None


def _get_gdrive_bearer_token(force_refresh: bool = False) -> Optional[str]:
    """
    Returns an active Google Drive API v3 OAuth2 Bearer token, prioritizing the Google Service Account
    `gcworker@modular-temple-508005-c4.iam.gserviceaccount.com` (`service_account`).
    """
    import urllib.request

    auth = _load_cloud_auth()
    now = time.time()
    tok = auth.get("access_token")
    exp = float(auth.get("expires_at") or 0)
    if not force_refresh and tok and exp > now + 90 and auth.get("auth_mode") == "service_account":
        return str(tok)

    # 1. Prioritize Service Account RS256 JWT assertion (`gcworker@modular-temple-508005-c4.iam.gserviceaccount.com`)
    sa = auth.get("service_account")
    if isinstance(sa, dict) and sa.get("client_email") and sa.get("private_key"):
        try:
            jwt_assertion = _sign_rs256_jwt_assertion(sa, scope="https://www.googleapis.com/auth/drive")
            if jwt_assertion:
                token_uri = str(sa.get("token_uri") or "https://oauth2.googleapis.com/token")
                body = urllib.parse.urlencode(
                    {
                        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                        "assertion": jwt_assertion,
                    }
                ).encode("ascii")
                req = urllib.request.Request(
                    token_uri,
                    data=body,
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=8) as r:
                    resp = json.loads(r.read().decode("utf-8"))
                new_tok = resp.get("access_token")
                if new_tok:
                    _save_cloud_auth(
                        {
                            "access_token": new_tok,
                            "expires_at": now + float(resp.get("expires_in", 3500)),
                            "auth_mode": "service_account",
                            "active_service_account_email": sa.get("client_email"),
                        }
                    )
                    _GDRIVE_NEGATIVE_FID_CACHE.clear()
                    return str(new_tok)
        except Exception as e:
            print(f"[GatheringScans] Service account token refresh warning: {e}")

    if not force_refresh and tok and exp > now + 90:
        return str(tok)

    # 2. Try OAuth Refresh Token if present
    ref_tok = auth.get("oauth_refresh_token")
    cli_sec = auth.get("oauth_client_secret")
    cli_id = auth.get("oauth_client_id") or GOOGLE_OAUTH_CLIENT_ID
    if ref_tok and cli_sec:
        try:
            body = urllib.parse.urlencode(
                {
                    "client_id": cli_id,
                    "client_secret": cli_sec,
                    "refresh_token": ref_tok,
                    "grant_type": "refresh_token",
                }
            ).encode("ascii")
            req = urllib.request.Request(
                "https://oauth2.googleapis.com/token",
                data=body,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=8) as r:
                resp = json.loads(r.read().decode("utf-8"))
            new_tok = resp.get("access_token")
            if new_tok:
                _save_cloud_auth(
                    {
                        "access_token": new_tok,
                        "expires_at": now + float(resp.get("expires_in", 3500)),
                        "auth_mode": "oauth_refresh",
                    }
                )
                return str(new_tok)
        except Exception as e:
            print(f"[GatheringScans] OAuth refresh token warning: {e}")

    return str(tok) if (tok and exp > now) else None


def _test_gdrive_service_account(custom_sa: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    End-to-end live test of the Google Cloud Service Account (`gcworker@modular-temple-508005-c4.iam.gserviceaccount.com`)
    for all Google Drive interactions:
      1. Verifies RS256 private key presence & JWT signing
      2. Exchanges JWT for OAuth2 Bearer token at `https://oauth2.googleapis.com/token`
      3. Queries Drive API v3 `/drive/v3/about` for identity & quota
      4. Queries Drive API v3 `/drive/v3/files` on the `StreamPackages` folder (`supportsAllDrives=true`)
      5. Tests a 64-byte HTTP Range read (`bytes=0-63`) from a `.3tz` package via Drive API v3
    """
    import urllib.error
    import urllib.request

    if isinstance(custom_sa, dict) and custom_sa.get("private_key") and custom_sa.get("client_email"):
        _save_cloud_auth({"service_account": custom_sa, "auth_mode": "service_account"})

    global _CLOUD_AUTH_MEM
    _CLOUD_AUTH_MEM = None
    auth = _load_cloud_auth()
    manifest = _load_cloud_manifest()
    sa = auth.get("service_account") if isinstance(auth.get("service_account"), dict) else {}
    folder_id = str(manifest.get("shared_drive_folder_id") or manifest.get("my_drive_folder_id") or "1scUD9IQWsAJjg296pecxFYqhoVm4mpjs")

    report: Dict[str, Any] = {
        "expected_service_account": GDRIVE_SERVICE_ACCOUNT_EMAIL,
        "expected_project_id": GDRIVE_SERVICE_ACCOUNT_PROJECT_ID,
        "configured_service_account": sa.get("client_email") or GDRIVE_SERVICE_ACCOUNT_EMAIL,
        "private_key_loaded": bool(sa.get("private_key")),
        "private_key_id": sa.get("private_key_id", ""),
        "stream_packages_folder_id": folder_id,
        "jwt_signed": False,
        "oauth_token_acquired": False,
        "drive_about_ok": False,
        "folder_access_ok": False,
        "range_read_ok": False,
        "files_visible_count": 0,
        "visible_files": [],
    }

    if not sa.get("private_key"):
        report["status"] = "missing_private_key"
        report["message"] = (
            f"Service account email '{GDRIVE_SERVICE_ACCOUNT_EMAIL}' (project '{GDRIVE_SERVICE_ACCOUNT_PROJECT_ID}') is configured as the mandatory GDrive identity, "
            f"but its JSON private key file has not been uploaded/dropped into data/gdrive_cloud_auth.json yet. "
            f"In Google Cloud Console -> IAM & Admin -> Service Accounts -> {GDRIVE_SERVICE_ACCOUNT_EMAIL} -> Keys -> Add Key -> Create new key (JSON), "
            f"then upload or paste the JSON key in Settings -> Google Service Account."
        )
        return report

    jwt_assertion = _sign_rs256_jwt_assertion(sa, scope="https://www.googleapis.com/auth/drive")
    if not jwt_assertion:
        report["status"] = "jwt_sign_failed"
        report["message"] = "Failed to sign RS256 JWT with the provided private_key."
        return report
    report["jwt_signed"] = True

    bearer = _get_gdrive_bearer_token(force_refresh=True)
    if not bearer:
        report["status"] = "token_exchange_failed"
        report["message"] = "Google OAuth2 token endpoint rejected the JWT assertion (check private_key validity and system clock)."
        return report
    report["oauth_token_acquired"] = True

    # Test 1: /drive/v3/about
    try:
        req_about = urllib.request.Request(
            "https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress),storageQuota",
            headers={"Authorization": f"Bearer {bearer}"},
            method="GET",
        )
        with urllib.request.urlopen(req_about, timeout=8) as r:
            about_data = json.loads(r.read().decode("utf-8"))
        report["drive_about_ok"] = True
        report["drive_user"] = about_data.get("user", {})
    except Exception as e:
        report["drive_about_error"] = str(e)

    # Test 2: List StreamPackages folder (and fallback to all visible files across Shared Drives)
    try:
        q = urllib.parse.quote(f"'{folder_id}' in parents and trashed = false")
        url_list = (
            f"https://www.googleapis.com/drive/v3/files?q={q}"
            f"&corpora=allDrives&supportsAllDrives=true&includeItemsFromAllDrives=true"
            f"&pageSize=50&fields=files(id,name,size,mimeType)"
        )
        req_list = urllib.request.Request(
            url_list,
            headers={"Authorization": f"Bearer {bearer}"},
            method="GET",
        )
        with urllib.request.urlopen(req_list, timeout=10) as r:
            list_data = json.loads(r.read().decode("utf-8"))
        files = list_data.get("files") or []
        if not files:
            url_any = (
                "https://www.googleapis.com/drive/v3/files?"
                "q=trashed%3Dfalse&corpora=allDrives&supportsAllDrives=true&includeItemsFromAllDrives=true"
                "&pageSize=25&fields=files(id,name,size,mimeType)"
            )
            req_any = urllib.request.Request(
                url_any,
                headers={"Authorization": f"Bearer {bearer}"},
                method="GET",
            )
            with urllib.request.urlopen(req_any, timeout=10) as r_any:
                files = (json.loads(r_any.read().decode("utf-8")).get("files") or [])
        report["folder_access_ok"] = True
        report["files_visible_count"] = len(files)
        report["visible_files"] = files[:15]

        # Test 3: Range slice read on first .3tz file (or first package in manifest)
        test_fid = ""
        for f in files:
            if str(f.get("name", "")).endswith(".3tz"):
                test_fid = str(f.get("id") or "")
                break
        if not test_fid:
            for p in (manifest.get("packages") or {}).values():
                if p.get("file_id"):
                    test_fid = str(p["file_id"])
                    break
        if test_fid:
            slice_bytes = _fetch_gdrive_byte_slice([test_fid], 0, 64)
            if slice_bytes and len(slice_bytes) == 64:
                report["range_read_ok"] = True
                report["range_test_file_id"] = test_fid
                report["range_test_magic_hex"] = slice_bytes[:4].hex()
    except Exception as e:
        report["folder_access_error"] = str(e)

    if report["oauth_token_acquired"] and report["folder_access_ok"]:
        report["ok"] = True
        report["status"] = "ok"
        report["message"] = (
            f"Service Account {sa.get('client_email')} authenticated and verified! "
            f"Visible Drive files: {report['files_visible_count']}."
        )
    else:
        report["ok"] = bool(report["oauth_token_acquired"])
        report["status"] = "partial"
        report["message"] = (
            f"Service Account {sa.get('client_email')} authenticated, but ensure folder {folder_id} "
            f"(3. GatheringScans / StreamPackages) is shared with {sa.get('client_email')}."
        )
    return report


_GDRIVE_NEGATIVE_FID_CACHE: Dict[str, float] = {}


def _fetch_gdrive_byte_slice(file_ids: list, start_byte: int, length: int) -> Optional[bytes]:
    """
    Fetches an exact byte slice `[start_byte, start_byte + length - 1]` from a `.3tz` package
    on Google Drive at datacenter speed (300+ Mbps).
    Tries Drive API v3 (if Bearer token available) and direct `drive.usercontent.google.com`
    (for link-shared `StreamPackages` folders).
    """
    import urllib.request

    if length <= 0:
        return None
    clean_ids = [str(fid).strip() for fid in file_ids if fid and not str(fid).startswith("local")]
    if not clean_ids:
        return None

    now = time.time()
    end_byte = start_byte + length - 1
    range_hdr = f"bytes={start_byte}-{end_byte}"
    bearer = _get_gdrive_bearer_token()

    for fid in clean_ids:
        neg_key = f"{fid}:{'auth' if bearer else 'anon'}"
        if now - _GDRIVE_NEGATIVE_FID_CACHE.get(neg_key, 0.0) < 300.0:
            continue
        urls_to_try = []
        if bearer:
            urls_to_try.append(
                (
                    f"https://www.googleapis.com/drive/v3/files/{fid}?alt=media&supportsAllDrives=true",
                    {"Authorization": f"Bearer {bearer}", "Range": range_hdr},
                )
            )
        urls_to_try.append(
            (
                f"https://drive.usercontent.google.com/download?id={fid}&export=download&confirm=t",
                {"Range": range_hdr, "User-Agent": "GatheringScans-CloudStreamer/2.0"},
            )
        )
        got_slice = False
        for url, hdrs in urls_to_try:
            try:
                req = urllib.request.Request(url, headers=hdrs, method="GET")
                with urllib.request.urlopen(req, timeout=8) as r:
                    ctype = (r.headers.get("Content-Type") or "").lower()
                    if ctype.startswith("text/html"):
                        continue
                    data = r.read(length + 64)
                    if len(data) == length:
                        got_slice = True
                        return data
            except Exception:
                continue
        if not got_slice:
            _GDRIVE_NEGATIVE_FID_CACHE[neg_key] = now
    return None



def _recv_exact(sock: socket.socket, n: int) -> Optional[bytes]:
    buf = bytearray()
    while len(buf) < n:
        try:
            chunk = sock.recv(n - len(buf))
        except Exception:
            return None
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def _acquire_vps_tunnel_socket(timeout: float = 6.0) -> Tuple[Optional[socket.socket], Optional[threading.Event], int]:
    deadline = time.time() + timeout
    while True:
        rem = deadline - time.time()
        if rem <= 0:
            return None, None, 0
        try:
            sock, done_evt, ts, proto_ver = VPS_TUNNEL_POOL.get(timeout=min(rem, 0.25))
        except queue.Empty:
            if time.time() >= deadline:
                return None, None, 0
            continue
        max_idle = 210.0 if proto_ver >= 2 else 42.0
        if done_evt.is_set() or (time.time() - ts > max_idle):
            done_evt.set()
            continue
        try:
            rlist, _, xlist = select.select([sock], [], [sock], 0)
            if rlist or xlist:
                done_evt.set()
                continue
        except Exception:
            done_evt.set()
            continue
        return sock, done_evt, proto_ver


def start_pc_reverse_tunnel_pool(local_port: int = SERVER_PORT, pool_size: int = 48):
    """On Windows PC, maintains a pool of persistent reverse TCP sockets to Hostinger VPS (76.13.197.29:8095)."""
    global _TUNNEL_POOL_STARTED
    if os.name != "nt" or _TUNNEL_POOL_STARTED:
        return
    _TUNNEL_POOL_STARTED = True

    def _worker(worker_id: int):
        # Stagger initial connection slightly to prevent synchronized rotation
        time.sleep((worker_id % 16) * 0.04)
        while True:
            s: Optional[socket.socket] = None
            try:
                s = socket.create_connection((VPS_HOST, 8095), timeout=8.0)
                s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                s.settimeout(900.0)
                handshake = (
                    f"GET /_pc_tunnel HTTP/1.1\r\n"
                    f"Host: {VPS_HOST}:8095\r\n"
                    f"X-Tunnel-Key: {TUNNEL_SHARED_KEY}\r\n"
                    f"X-Tunnel-Proto: 2\r\n"
                    f"Connection: keep-alive\r\n\r\n"
                ).encode("ascii")
                s.sendall(handshake)

                # Read HTTP response header until \r\n\r\n
                resp_buf = b""
                while b"\r\n\r\n" not in resp_buf:
                    chunk = s.recv(1024)
                    if not chunk:
                        break
                    resp_buf += chunk
                    if len(resp_buf) > 8192:
                        break
                if b"200 OK" not in resp_buf or (b"X-Tunnel-Ready: 1" not in resp_buf and b"X-Tunnel-Ready: 2" not in resp_buf):
                    s.close()
                    time.sleep(1.0)
                    continue

                is_v2 = b"X-Tunnel-Ready: 2" in resp_buf

                # Serve multiple requests over the same socket when v2 is active
                while True:
                    len_bytes = _recv_exact(s, 4)
                    if not len_bytes:
                        break
                    (frame_len,) = struct.unpack("!I", len_bytes)
                    if frame_len == 0:
                        # Heartbeat ping
                        continue
                    if frame_len < 0 or frame_len > 64 * 1024 * 1024:
                        break
                    req_raw = _recv_exact(s, frame_len)
                    if not req_raw:
                        break
                    req_info = json.loads(req_raw.decode("utf-8"))
                    method = req_info.get("method", "GET")
                    path = req_info.get("path", "/")
                    req_headers = req_info.get("headers") or {}
                    body_b64 = req_info.get("body_b64", "")
                    body_bytes = base64.b64decode(body_b64) if body_b64 else None

                    conn: Optional[http.client.HTTPConnection] = None
                    try:
                        is_long_local = (
                            method == "POST"
                            and (path.startswith("/api/optimizer/") or path in ("/api/scans/merge", "/api/optimizer/merge"))
                        ) or path.startswith("/api/download")
                        conn = http.client.HTTPConnection(
                            "127.0.0.1", local_port, timeout=900.0 if is_long_local else 90.0
                        )
                        fwd_headers = {"Connection": "close"}
                        for hk, hv in req_headers.items():
                            if hk.lower() not in ("host", "connection", "transfer-encoding"):
                                fwd_headers[hk] = hv
                        conn.request(method, path, body=body_bytes, headers=fwd_headers)
                        resp = conn.getresponse()

                        resp_headers = {k: v for k, v in resp.getheaders()}
                        resp_meta = json.dumps(
                            {
                                "status": resp.status,
                                "headers": resp_headers,
                                "chunked_v2": is_v2,
                            }
                        ).encode("utf-8")
                        s.sendall(struct.pack("!I", len(resp_meta)) + resp_meta)

                        while True:
                            chunk = resp.read(65536)
                            if not chunk:
                                break
                            if is_v2:
                                s.sendall(struct.pack("!I", len(chunk)) + chunk)
                            else:
                                s.sendall(chunk)
                        if is_v2:
                            s.sendall(struct.pack("!I", 0))
                    finally:
                        if conn is not None:
                            try:
                                conn.close()
                            except Exception:
                                pass

                    if not is_v2:
                        try:
                            s.shutdown(socket.SHUT_WR)
                        except Exception:
                            pass
                        break
                s.close()
            except Exception:
                if s:
                    try:
                        s.close()
                    except Exception:
                        pass
                time.sleep(0.25)

    for idx in range(pool_size):
        t = threading.Thread(target=_worker, args=(idx,), daemon=True)
        t.start()

    def _warm_all_scans_loop():
        time.sleep(3.5)
        while True:
            try:
                if os.name == "nt" and is_pc_daemon_running():
                    try:
                        from pc_worker.gdrive_cloud_sync import sync_all_scans_to_gdrive_and_vps

                        sync_all_scans_to_gdrive_and_vps(DB, AUTH_SHARE, force=False)
                    except Exception as ge:
                        print(f"[GatheringScans] GDrive .3tz cloud sync note: {ge}")
            except Exception:
                pass
            time.sleep(90.0)

    threading.Thread(target=_warm_all_scans_loop, daemon=True).start()
    print(f"[GatheringScans] Started {pool_size} persistent reverse tunnel sockets to {VPS_HOST}:8095 -> 127.0.0.1:{local_port} ({LOCAL_SCANS_ROOT})", flush=True)




class CloudAndTunnelHandlerMixin:
    def _handle_pc_tunnel_register(self):
        """Accepts a persistent reverse TCP socket from the Windows PC on the Linux VPS."""
        key = self.headers.get("X-Tunnel-Key", "").strip()
        if key != TUNNEL_SHARED_KEY:
            self.send_json({"error": "Forbidden tunnel key"}, status=403)
            return
        proto_hdr = self.headers.get("X-Tunnel-Proto", "1").strip()
        proto_ver = 2 if proto_hdr == "2" else 1
        try:
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self.connection.sendall(
                f"HTTP/1.1 200 OK\r\nX-Tunnel-Ready: {proto_ver}\r\nContent-Length: 0\r\n\r\n".encode("ascii")
            )
        except Exception:
            self.close_connection = True
            return

        done_evt = threading.Event()
        VPS_TUNNEL_POOL.put((self.connection, done_evt, time.time(), proto_ver))
        # Hold handler thread open while persistent socket serves requests in the pool
        done_evt.wait(timeout=240.0 if proto_ver >= 2 else 45.0)
        done_evt.set()
        self.close_connection = True

    def _validate_cloud_share_token(
        self, share_token: str, requested_scan_id: Optional[str] = None
    ) -> Tuple[bool, str, Optional[Dict[str, Any]], list]:
        manifest = _load_cloud_manifest()
        links = manifest.get("share_links") or []
        scans = manifest.get("scans") or []
        link = next((l for l in links if l.get("token") == share_token), None)
        if not link:
            return False, "Invalid external share link token.", None, []
        if link.get("revoked"):
            return False, "This external share link has been revoked.", link, []
        raw_exp = str(link.get("expires_at") or "").strip()
        if raw_exp:
            try:
                if raw_exp.replace(".", "", 1).isdigit():
                    if float(raw_exp) > 0 and time.time() > float(raw_exp):
                        return False, "This external share link has expired.", link, []
                else:
                    exp_dt = datetime.fromisoformat(raw_exp.replace("Z", "+00:00"))
                    if datetime.now(timezone.utc) > exp_dt:
                        return False, "This external share link has expired.", link, []
            except Exception:
                pass

        scope_type = str(link.get("scope_type") or "").strip().lower()
        target_id = str(link.get("target_id") or "").strip()
        allowed_ids = link.get("allowed_scan_ids") or []
        if isinstance(allowed_ids, str):
            try:
                allowed_ids = json.loads(allowed_ids)
            except Exception:
                allowed_ids = [x.strip() for x in allowed_ids.split(",") if x.strip()]
        scope_grp = link.get("project_group") or ""

        allowed_scans = []
        for s in scans:
            sid = str(s.get("scan_id") or "")
            sgrp = str(s.get("project_group") or "")
            if scope_type == "scan" and target_id:
                if sid == target_id:
                    allowed_scans.append(s)
            elif scope_type == "group" and target_id:
                if sgrp == target_id:
                    allowed_scans.append(s)
            elif allowed_ids and sid in allowed_ids:
                allowed_scans.append(s)
            elif not allowed_ids and scope_grp and sgrp == scope_grp:
                allowed_scans.append(s)
        if requested_scan_id and not any(str(s.get("scan_id")) == requested_scan_id for s in allowed_scans):
            return False, f"Forbidden: Scan '{requested_scan_id}' is outside the authorized scope of this share link.", link, []
        return True, "", link, allowed_scans

    def _serve_from_gdrive_cloud_if_available(self, path: str, share_token: str = "") -> bool:
        """
        Streams `.glb` tiles, `tileset.json`, `preview_tileset.json`, and `thumbnail.png`
        directly from the scan's single-file `.3tz` package on Google Drive at datacenter
        speed (300+ Mbps), using 0% of the office workstation's upload bandwidth.
        """
        manifest = _load_cloud_manifest()
        pkgs = manifest.get("packages") or {}
        if not pkgs:
            return False

        scan_id = ""
        inner_path = ""
        ctype = "application/octet-stream"

        if path.startswith("/stream/"):
            rel = path[len("/stream/") :]
            parts = rel.split("/", 1)
            if len(parts) < 2:
                return False
            scan_id, sub_path = parts[0], parts[1]
            inner_path = sub_path.split("?")[0].replace("\\", "/").lstrip("/")
            ext = os.path.splitext(inner_path)[1].lower()
            ctype = self.extensions_map.get(ext, "application/octet-stream")
        elif path.startswith("/api/scans/") and (path.endswith("/thumbnail") or path.endswith("/thumbnail.png")):
            suffix = "/thumbnail.png" if path.endswith("/thumbnail.png") else "/thumbnail"
            scan_id = path[len("/api/scans/") : -len(suffix)].strip("/")
            inner_path = "thumbnail.png"
            ctype = "image/png"
        else:
            return False

        if share_token:
            ok, reason, _, _ = self._validate_cloud_share_token(share_token, requested_scan_id=scan_id)
            if not ok:
                self.send_json({"error": reason}, status=403)
                return True

        pkg = pkgs.get(scan_id)
        if not isinstance(pkg, dict):
            return False
        toc = pkg.get("toc") or {}
        toc_entry = toc.get(inner_path)
        if not isinstance(toc_entry, dict) and inner_path == "preview_tileset.json":
            toc_entry = toc.get("tileset.json")
        if not isinstance(toc_entry, dict):
            return False

        file_ids = [pkg.get("file_id"), pkg.get("my_drive_file_id")]
        accept_enc = (self.headers.get("Accept-Encoding") or "").lower()
        range_hdr = self.headers.get("Range")

        use_gzip = (
            "gzip" in accept_enc
            and not range_hdr
            and "gz_offset" in toc_entry
            and "gz_size" in toc_entry
        )
        if use_gzip:
            start_b = int(toc_entry["gz_offset"])
            len_b = int(toc_entry["gz_size"])
        else:
            start_b = int(toc_entry["offset"])
            len_b = int(toc_entry["size"])

        data: Optional[bytes] = None
        for local_pkg_cand in (
            f"/host_docker/gathering_scans/data/stream_packages/{scan_id}.3tz",
            os.path.join(DATA_DIR, "stream_packages", f"{scan_id}.3tz"),
            pkg.get("pkg_path") or "",
        ):
            if local_pkg_cand and os.path.isfile(local_pkg_cand):
                try:
                    with open(local_pkg_cand, "rb") as pf:
                        pf.seek(start_b)
                        buf = pf.read(len_b)
                        if len(buf) == len_b:
                            data = buf
                            break
                except Exception:
                    pass

        if data is None:
            data = _fetch_gdrive_byte_slice(file_ids, start_b, len_b)
        if data is None:
            return False
        if not use_gzip and toc_entry.get("gzip_only"):
            try:
                data = gzip.decompress(data)
            except Exception:
                pass

        hdrs: Dict[str, str] = {
            "Content-Type": ctype,
            "Content-Length": str(len(data)),
            "Cache-Control": "public, max-age=3600" if not inner_path.endswith(".json") else "no-cache, must-revalidate",
            "X-Stream-Source": "GoogleDrive-3TZ-Cloud",
        }
        if use_gzip:
            hdrs["Content-Encoding"] = "gzip"

        if len(data) <= 12 * 1024 * 1024:
            if len(_VPS_RAM_FALLBACK_CACHE) > 2000:
                _VPS_RAM_FALLBACK_CACHE.clear()
            _VPS_RAM_FALLBACK_CACHE[self.path] = (200, hdrs, data)

        self.send_response(200)
        for hk, hv in hdrs.items():
            self.send_header(hk, hv)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass
        return True

    def _proxy_via_pc_tunnel_if_vps(self, method: str, path: str, body: bytes = b"") -> bool:
        """
        When running on the Linux VPS (os.name != 'nt'):
        1. Serves cached `.glb` / `.json` / `/thumbnail` hits from volatile RAM in <0.2ms.
        2. Streams `.3tz` byte ranges directly from Google Drive's servers at 300+ Mbps (0% workstation upload).
        3. Proxies dynamic surveying/queue API requests over the reverse socket pool to the Windows PC.
        4. Serves scan catalog & external guest share links 24/7 from `gdrive_cloud_manifest.json` even when the PC is offline.
        """
        if os.name == "nt":
            return False

        parsed_q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        share_token = self._extract_share_token(parsed_q)

        cacheable = method == "GET" and (
            path in ("/api/scans", "/api/projects", "/api/status", "/api/pc/health")
            or path.endswith("/thumbnail")
            or path.endswith("/thumbnail.png")
            or path.endswith("/tileset.json")
            or path.endswith("/preview_tileset.json")
            or path.endswith(".glb")
            or path == "/api/comment-photo"
            or path.startswith("/api/comments/photo/")
            or path.startswith("/api/survey/cameras")
            or path in ("/api/camera-photo", "/api/photo-file")
            or path.startswith("/cameras/")
        )
        is_comment_photo_upload = method == "POST" and path in ("/api/comments/upload-photo", "/api/comments/upload_photo")
        if method == "POST" and path.endswith("/thumbnail"):
            for k in list(_VPS_RAM_FALLBACK_CACHE.keys()):
                if k.startswith(path):
                    _VPS_RAM_FALLBACK_CACHE.pop(k, None)
        if method in ("POST", "DELETE") and ("/rename" in path or "/delete" in path or "/bin" in path or "/rerun" in path or "/admin/users" in path or "/user/" in path or "/user-profiles" in path or "/auth/" in path or path == "/api/comments" or path.startswith("/api/comments/") or path.startswith("/api/measurements/") or path.startswith("/api/optimizer/") or path in ("/api/scans/rename", "/api/scans/delete", "/api/scans/merge")):
            if method == "POST" and body and path in ("/api/user/settings", "/api/user/preferences"):
                try:
                    p_u = json.loads(body.decode("utf-8"))
                    u_em = str(p_u.get("email") or p_u.get("user_email") or self.headers.get("X-User-Email") or "").strip().lower()
                    if u_em and u_em != "guest@anonymous":
                        DB.update_user_settings(u_em, p_u)
                except Exception:
                    pass
            for k in list(_VPS_RAM_FALLBACK_CACHE.keys()):
                if k.startswith("/api/scans") or k.startswith("/api/projects") or k.startswith("/api/user-profiles") or k.startswith("/api/user/") or k.startswith("/api/auth/") or k.startswith("/api/admin/users") or k.startswith("/stream/"):
                    _VPS_RAM_FALLBACK_CACHE.pop(k, None)
        if method == "POST" and path in ("/api/queue/scan-inbox", "/api/queue/rescan", "/api/admin/pc-daemon", "/api/pc/simulate-offline"):
            _VPS_RAM_FALLBACK_CACHE.clear()

        # 1. Serve immutable binary .glb tiles, thumbnails, and tileset.json from volatile RAM if already cached
        cache_hit_key = self.path if self.path in _VPS_RAM_FALLBACK_CACHE else (path if path in _VPS_RAM_FALLBACK_CACHE else None)
        if (
            method == "GET"
            and (
                path.endswith(".glb")
                or path.endswith("/thumbnail")
                or path.endswith("/thumbnail.png")
                or path.endswith("/tileset.json")
                or path.endswith("/preview_tileset.json")
            )
            and cache_hit_key
        ):
            c_status, c_hdrs, c_body = _VPS_RAM_FALLBACK_CACHE[cache_hit_key]
            self.send_response(c_status)
            for hk, hv in c_hdrs.items():
                self.send_header(hk, hv)
            self.end_headers()
            try:
                self.wfile.write(c_body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return True

        # 1b. Serve scan thumbnails and true-nadir orthomosaics directly from local VPS /app/data/thumbnails/ if available
        if method == "GET" and path.startswith("/api/scans/") and (path.endswith("/thumbnail") or path.endswith("/thumbnail.png")):
            suffix = "/thumbnail.png" if path.endswith("/thumbnail.png") else "/thumbnail"
            req_sid = path[len("/api/scans/") : -len(suffix)].strip("/")
            local_vps_thumb = self._resolve_scan_thumbnail_path(req_sid)
            if local_vps_thumb and os.path.isfile(local_vps_thumb):
                self._serve_file_with_range(local_vps_thumb, content_type="image/png")
                return True

        if method == "GET" and path.startswith("/api/scans/") and path.endswith("/ortho-meta"):
            req_sid = path[len("/api/scans/") : -len("/ortho-meta")].strip("/")
            saved_ortho = SURVEY.get_saved_ortho_meta(req_sid)
            if isinstance(saved_ortho, dict) and saved_ortho.get("north_lat") is not None:
                clean_bounds = {k: v for k, v in saved_ortho.items() if k not in ("png_path", "json_path")}
                self.send_json(
                    {
                        "status": "ok",
                        "ok": True,
                        "scan_id": req_sid,
                        "ortho_bounds": clean_bounds,
                        "ortho_url": f"/api/scans/{req_sid}/ortho",
                    }
                )
                return True

        if method == "GET" and path.startswith("/api/scans/") and (path.endswith("/ortho") or path.endswith("/ortho.png")):
            suffix = "/ortho.png" if path.endswith("/ortho.png") else "/ortho"
            req_sid = path[len("/api/scans/") : -len(suffix)].strip("/")
            saved_ortho = SURVEY.get_saved_ortho_meta(req_sid)
            if isinstance(saved_ortho, dict) and saved_ortho.get("png_path") and os.path.isfile(saved_ortho["png_path"]):
                self._serve_file_with_range(saved_ortho["png_path"], content_type="image/png")
                return True

        # 1c. Serve saved AI Surface & Object Categorization directly from local VPS cache if available
        if path in ("/api/survey/categorize", "/api/surveying/categorize"):
            req_sid = ""
            force_rec = False
            only_upd = False
            req_filters = None
            req_vis_def = False
            if method == "GET":
                req_sid = (parsed_q.get("scan_id") or [""])[0].strip()
            elif method == "POST" and body:
                try:
                    p_obj = json.loads(body.decode("utf-8"))
                    req_sid = str(p_obj.get("scan_id") or "").strip()
                    force_rec = bool(p_obj.get("force_recompute", False))
                    only_upd = bool(p_obj.get("only_update_filters", False) or p_obj.get("action") == "save_visibility")
                    if isinstance(p_obj.get("layer_filters"), dict):
                        req_filters = p_obj["layer_filters"]
                    req_vis_def = bool(p_obj.get("overlay_visible_default", False))
                except Exception:
                    pass
            if req_sid and not force_rec:
                if only_upd:
                    upd_cat = SURVEY.save_categorization_visibility_prefs(req_sid, req_filters, req_vis_def)
                    if isinstance(upd_cat, dict):
                        self.send_json(upd_cat)
                        return True
                else:
                    local_cat = SURVEY.get_saved_categorization(req_sid)
                    if isinstance(local_cat, dict) and local_cat.get("status") == "ok":
                        self.send_json(local_cat)
                        return True

        # 1d. Serve uploaded comment photos directly from local VPS disk if already mirrored
        if method == "GET" and (path == "/api/comment-photo" or path.startswith("/api/comments/photo/")):
            if path.startswith("/api/comments/photo/"):
                rel_cp = path[len("/api/comments/photo/") :].strip("/")
                parts_cp = rel_cp.split("/", 1)
                cp_sid = re.sub(r"[^A-Za-z0-9._-]+", "_", parts_cp[0]) if len(parts_cp) >= 1 else "general"
                cp_fname = os.path.basename(parts_cp[1]) if len(parts_cp) >= 2 else ""
            else:
                cp_sid = re.sub(r"[^A-Za-z0-9._-]+", "_", (parsed_q.get("scan_id", ["general"])[0] or "general"))
                cp_fname = os.path.basename((parsed_q.get("file", [""])[0] or ""))
            if cp_fname:
                for cp_root in (os.path.join(DATA_DIR, "comment_photos"), os.path.join(DATA_DIR, "gdrive_comment_photos")):
                    cp_fp = os.path.join(cp_root, cp_sid, cp_fname)
                    if os.path.isfile(cp_fp):
                        ext_low = os.path.splitext(cp_fname)[1].lower()
                        cp_mime = (
                            "image/png"
                            if ext_low == ".png"
                            else "image/webp"
                            if ext_low == ".webp"
                            else "image/gif"
                            if ext_low == ".gif"
                            else "image/jpeg"
                        )
                        self._serve_file_with_range(cp_fp, content_type=cp_mime)
                        return True

        # 2. Try Direct Google Drive .3tz Cloud Range Streaming (300+ Mbps, 0% PC Upload) BEFORE using PC tunnel
        if method == "GET" and (
            path.startswith("/stream/") or path.endswith("/thumbnail") or path.endswith("/thumbnail.png")
        ):
            if self._serve_from_gdrive_cloud_if_available(path, share_token=share_token):
                return True

        # 3. Try up to 4 sockets from the PC reverse tunnel pool (single 900s pass for long optimizer/merge POSTs or large downloads)
        is_long_post = (
            method == "POST"
            and (path.startswith("/api/optimizer/") or path in ("/api/scans/merge", "/api/optimizer/merge"))
        ) or path.startswith("/api/download")
        for _attempt in range(1 if is_long_post else 4):
            tun_sock, done_evt, proto_ver = _acquire_vps_tunnel_socket(timeout=5.0)
            if not tun_sock or not done_evt:
                break
            try:
                tun_sock.settimeout(900.0 if is_long_post else 60.0)
                req_headers = {k: v for k, v in self.headers.items()}
                if "X-Client-IP" not in req_headers and "x-client-ip" not in {k.lower() for k in req_headers}:
                    req_headers["X-Client-IP"] = self._extract_client_ip()
                envelope = json.dumps(
                    {
                        "method": method,
                        "path": self.path,
                        "headers": req_headers,
                        "body_b64": base64.b64encode(body).decode("ascii") if body else "",
                    }
                ).encode("utf-8")
                tun_sock.sendall(struct.pack("!I", len(envelope)) + envelope)

                len_bytes = _recv_exact(tun_sock, 4)
                if not len_bytes:
                    done_evt.set()
                    continue
                (meta_len,) = struct.unpack("!I", len_bytes)
                meta_raw = _recv_exact(tun_sock, meta_len)
                if not meta_raw:
                    done_evt.set()
                    continue
                resp_meta = json.loads(meta_raw.decode("utf-8"))
                status_code = int(resp_meta.get("status", 200))
                resp_headers = resp_meta.get("headers") or {}
                chunked_v2 = bool(resp_meta.get("chunked_v2", False))

                self.send_response(status_code)
                skip_hdrs = {
                    "server",
                    "date",
                    "transfer-encoding",
                    "connection",
                    "access-control-allow-origin",
                    "access-control-allow-methods",
                    "access-control-allow-headers",
                    "access-control-expose-headers",
                }
                filtered_hdrs: Dict[str, str] = {}
                for hk, hv in resp_headers.items():
                    if hk.lower() not in skip_hdrs:
                        self.send_header(hk, hv)
                        filtered_hdrs[hk] = hv
                self.end_headers()

                buf_for_cache = bytearray() if ((cacheable or is_comment_photo_upload) and status_code == 200) else None
                client_Write_ok = True
                stream_clean = True

                if chunked_v2:
                    while True:
                        clen_bytes = _recv_exact(tun_sock, 4)
                        if not clen_bytes:
                            stream_clean = False
                            break
                        (clen,) = struct.unpack("!I", clen_bytes)
                        if clen == 0:
                            break
                        chunk = _recv_exact(tun_sock, clen)
                        if chunk is None:
                            stream_clean = False
                            break
                        if buf_for_cache is not None:
                            if len(buf_for_cache) + len(chunk) <= 12 * 1024 * 1024:
                                buf_for_cache.extend(chunk)
                            else:
                                buf_for_cache = None
                        if client_Write_ok:
                            try:
                                self.wfile.write(chunk)
                            except (BrokenPipeError, ConnectionResetError):
                                client_Write_ok = False
                    if stream_clean and not done_evt.is_set():
                        # Return socket immediately to pool for reuse by next request
                        VPS_TUNNEL_POOL.put((tun_sock, done_evt, time.time(), proto_ver))
                    else:
                        done_evt.set()
                else:
                    while True:
                        chunk = tun_sock.recv(65536)
                        if not chunk:
                            break
                        if buf_for_cache is not None:
                            if len(buf_for_cache) + len(chunk) <= 12 * 1024 * 1024:
                                buf_for_cache.extend(chunk)
                            else:
                                buf_for_cache = None
                        try:
                            self.wfile.write(chunk)
                        except (BrokenPipeError, ConnectionResetError):
                            break
                    done_evt.set()

                if buf_for_cache is not None and stream_clean:
                    if is_comment_photo_upload and body:
                        try:
                            from pc_worker.gdrive_cloud_sync import save_and_sync_comment_photo_to_gdrive

                            req_json = json.loads(body.decode("utf-8"))
                            raw_resp = bytes(buf_for_cache)
                            if filtered_hdrs.get("Content-Encoding", "").lower() == "gzip" or filtered_hdrs.get("content-encoding", "").lower() == "gzip":
                                raw_resp = gzip.decompress(raw_resp)
                            resp_json = json.loads(raw_resp.decode("utf-8"))
                            resp_photos = resp_json.get("photos") if isinstance(resp_json.get("photos"), list) else ([resp_json["photo"]] if isinstance(resp_json.get("photo"), dict) else [])
                            req_items = req_json.get("photos") if isinstance(req_json.get("photos"), list) else [req_json]
                            up_sid = str(resp_json.get("scan_id") or req_json.get("scan_id") or "general").strip() or "general"
                            for idx_p, item_p in enumerate(req_items):
                                if not isinstance(item_p, dict):
                                    continue
                                b64_s = str(item_p.get("data_base64") or item_p.get("data_url") or item_p.get("base64") or item_p.get("content_base64") or "").strip()
                                if b64_s.startswith("data:"):
                                    _, _, b64_s = b64_s.partition(",")
                                if not b64_s:
                                    continue
                                raw_img = base64.b64decode(b64_s.strip())
                                rp_meta = resp_photos[idx_p] if idx_p < len(resp_photos) and isinstance(resp_photos[idx_p], dict) else {}
                                stored_fn = str(rp_meta.get("stored_filename") or os.path.basename(str(rp_meta.get("url") or "")) or "").strip()
                                save_and_sync_comment_photo_to_gdrive(
                                    scan_id=up_sid,
                                    filename=str(item_p.get("filename") or rp_meta.get("filename") or "comment_photo.jpg"),
                                    raw_bytes=raw_img,
                                    content_type=str(item_p.get("content_type") or rp_meta.get("mime_type") or "image/jpeg"),
                                    camera_meta=item_p,
                                    forced_stored_name=stored_fn or None,
                                )
                        except Exception as vps_up_err:
                            print(f"[GatheringScans] VPS comment photo mirror note: {vps_up_err}")
                    elif method == "GET" and (path == "/api/comment-photo" or path.startswith("/api/comments/photo/")):
                        try:
                            if path.startswith("/api/comments/photo/"):
                                rel_cp = path[len("/api/comments/photo/") :].strip("/")
                                parts_cp = rel_cp.split("/", 1)
                                cp_sid = re.sub(r"[^A-Za-z0-9._-]+", "_", parts_cp[0]) if len(parts_cp) >= 1 else "general"
                                cp_fname = os.path.basename(parts_cp[1]) if len(parts_cp) >= 2 else ""
                            else:
                                cp_sid = re.sub(r"[^A-Za-z0-9._-]+", "_", (parsed_q.get("scan_id", ["general"])[0] or "general"))
                                cp_fname = os.path.basename((parsed_q.get("file", [""])[0] or ""))
                            if cp_fname and len(buf_for_cache) > 0:
                                for cp_root in (os.path.join(DATA_DIR, "comment_photos"), os.path.join(DATA_DIR, "gdrive_comment_photos")):
                                    cp_dir = os.path.join(cp_root, cp_sid)
                                    os.makedirs(cp_dir, exist_ok=True)
                                    with open(os.path.join(cp_dir, cp_fname), "wb") as cpf:
                                        cpf.write(bytes(buf_for_cache))
                        except Exception:
                            pass
                    if cacheable:
                        if len(_VPS_RAM_FALLBACK_CACHE) > 2000:
                            _VPS_RAM_FALLBACK_CACHE.clear()
                        _VPS_RAM_FALLBACK_CACHE[self.path] = (status_code, filtered_hdrs, bytes(buf_for_cache))
                    if path == "/api/scans":
                        try:
                            raw_payload = bytes(buf_for_cache)
                            if filtered_hdrs.get("Content-Encoding", "").lower() == "gzip" or filtered_hdrs.get("content-encoding", "").lower() == "gzip":
                                raw_payload = gzip.decompress(raw_payload)
                            scan_data = json.loads(raw_payload.decode("utf-8"))
                            live_ids = {s.get("scan_id") for s in (scan_data.get("scans") or []) if s.get("scan_id")}
                            for ck in list(_VPS_RAM_FALLBACK_CACHE.keys()):
                                if ck.startswith("/stream/"):
                                    parts = ck.split("/")
                                    if len(parts) > 2 and parts[2] not in live_ids:
                                        _VPS_RAM_FALLBACK_CACHE.pop(ck, None)
                        except Exception:
                            pass
                return True
            except Exception:
                done_evt.set()
                continue

        # 4. Serve from in-memory fallback cache if available during momentary tunnel reconnect
        if self.path in _VPS_RAM_FALLBACK_CACHE:
            c_status, c_hdrs, c_body = _VPS_RAM_FALLBACK_CACHE[self.path]
            if path == "/api/scans":
                try:
                    c_json = json.loads(c_body.decode("utf-8"))
                    if isinstance(c_json, dict):
                        actor_em_c, _, _ = self._resolve_request_role(None, parsed_q, share_token)
                        pref_em_c = (
                            actor_em_c
                            if (actor_em_c and actor_em_c not in ("guest", "guest@anonymous", "guest@external", "guest@gatheren.cloud"))
                            else str(self.headers.get("X-User-Email") or (parsed_q.get("user_email") or [None])[0] or "").strip().lower()
                        )
                        c_json["user_settings"] = (
                            DB.get_user_settings(pref_em_c)
                            if (pref_em_c and pref_em_c not in ("guest", "guest@anonymous", "guest@external", "guest@gatheren.cloud"))
                            else None
                        )
                        self.send_json(c_json, status=c_status)
                        return True
                except Exception:
                    pass
            self.send_response(c_status)
            for hk, hv in c_hdrs.items():
                self.send_header(hk, hv)
            self.end_headers()
            try:
                self.wfile.write(c_body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return True

        # 5. PC is offline: serve catalog, projects, and share links 24/7 from synced Google Drive Cloud Manifest
        manifest = _load_cloud_manifest()
        cloud_scans = manifest.get("scans") or []
        if path in ("/api/status", "/api/pc/health"):
            self.send_json(
                {
                    "status": "cloud_standby" if cloud_scans else "offline",
                    "pc_online": False,
                    "gdrive_cloud_active": bool(manifest.get("packages")),
                    "app": "GatheringScans",
                    "domain": "scans.gatheren.cloud",
                    "crs": TWD97_TWVD2001_LABEL,
                    "crs_short": TWD97_TWVD2001_SHORT,
                    "texture_limit": PIX4DMATIC_TEXTURE_SIZE,
                    "vps_raw_storage": "disabled (strictly 0 bytes on Linux VPS; streaming .3tz from Google Drive)",
                    "active_job": None,
                    "queued_count": 0,
                    "total_scans": len(cloud_scans),
                }
            )
            return True
        if path == "/api/scans":
            if share_token:
                ok, reason, link, allowed_scans = self._validate_cloud_share_token(share_token)
                if not ok:
                    self.send_json({"error": reason, "revoked": True}, status=403)
                    return True
                enriched = [self._enrich_scan_urls(s, share_token) for s in allowed_scans]
                self.send_json(
                    {
                        "status": "ok",
                        "mode": "external_share",
                        "pc_online": False,
                        "gdrive_cloud_active": True,
                        "share_link": link,
                        "scans": enriched,
                        "projects": self._build_projects_summary(enriched),
                        "materials": MATERIAL_CATALOG,
                        "google_client_id": GOOGLE_OAUTH_CLIENT_ID,
                    }
                )
                return True
            enriched = [self._enrich_scan_urls(s) for s in cloud_scans]
            actor_em_fb, _, _ = self._resolve_request_role(None, parsed_q, share_token)
            pref_em_fb = (
                actor_em_fb
                if (actor_em_fb and actor_em_fb not in ("guest", "guest@anonymous", "guest@external", "guest@gatheren.cloud"))
                else str(self.headers.get("X-User-Email") or (parsed_q.get("user_email") or [None])[0] or "").strip().lower()
            )
            fb_user_settings = (
                DB.get_user_settings(pref_em_fb)
                if (pref_em_fb and pref_em_fb not in ("guest", "guest@anonymous", "guest@external", "guest@gatheren.cloud"))
                else None
            )
            self.send_json(
                {
                    "status": "ok",
                    "mode": "internal",
                    "pc_online": False,
                    "gdrive_cloud_active": bool(manifest.get("packages")),
                    "crs": TWD97_TWVD2001_LABEL,
                    "scans": enriched,
                    "projects": self._build_projects_summary(enriched),
                    "materials": MATERIAL_CATALOG,
                    "google_client_id": GOOGLE_OAUTH_CLIENT_ID,
                    "user_settings": fb_user_settings,
                }
            )
            return True
        if path == "/api/projects":
            enriched = [self._enrich_scan_urls(s) for s in cloud_scans]
            projects = self._build_projects_summary(enriched)
            self.send_json(
                {
                    "status": "ok",
                    "total_projects": len(projects),
                    "total_scans": len(enriched),
                    "projects": projects,
                }
            )
            return True
        if method == "GET" and path.startswith("/api/scans/") and "/" not in path[len("/api/scans/") :].strip("/"):
            req_sid = path[len("/api/scans/") :].strip("/")
            if share_token:
                ok_c, reason_c, _, _ = self._validate_cloud_share_token(share_token, requested_scan_id=req_sid)
                if not ok_c:
                    self.send_json({"error": reason_c, "revoked": True}, status=403)
                    return True
            matched_scan = next((dict(s) for s in cloud_scans if str(s.get("scan_id")) == req_sid), None)
            if not matched_scan:
                self.send_json({"error": f"Scan not found: {req_sid}"}, status=404)
                return True
            by_cid = {str(c.get("comment_id")): c for c in (matched_scan.get("comments") or []) if isinstance(c, dict) and c.get("comment_id")}
            for vc in DB.list_comments(req_sid):
                if vc.get("comment_id"):
                    by_cid[str(vc["comment_id"])] = vc
            merged_cmts = sorted(by_cid.values(), key=lambda x: str(x.get("created_at") or ""), reverse=True)
            matched_scan["comments"] = merged_cmts
            matched_scan["comment_count"] = len(merged_cmts)
            self.send_json({"status": "ok", "scan": self._enrich_scan_urls(matched_scan, share_token)})
            return True
        # 6. Allow surveying (volume, profile, contours/reports), comments, share links, and user/admin routes to execute locally on VPS from .3tz packages when tunnel is unavailable
        if (
            path.startswith("/api/survey/")
            or path.startswith("/api/surveying/")
            or path.startswith("/api/reports/")
            or path.startswith("/api/contours/")
            or path.startswith("/api/admin/")
            or path.startswith("/api/user-profiles")
            or path.startswith("/api/auth/")
            or path.startswith("/api/user/")
            or path.startswith("/api/share/")
            or path == "/api/comments"
            or path.startswith("/api/comments/")
            or path.startswith("/api/measurements/")
            or path == "/api/scans/delete"
            or path.startswith("/api/scans/bin")
            or path.endswith("/thumbnail")
            or path.endswith("/thumbnail.png")
            or path.endswith("/ortho")
            or path.endswith("/ortho.png")
            or path.endswith("/ortho-meta")
        ):
            return False

        self.send_json(
            {
                "error": "Windows Processing PC (C:\\GatheringScans) is currently offline. Serving from Google Drive .3tz Cloud & Browser Cache.",
                "pc_online": False,
            },
            status=503,
        )
        return True

    def _build_cloud_manifest_status(self) -> Dict[str, Any]:
        manifest = _load_cloud_manifest()
        auth = _load_cloud_auth()
        pkgs = manifest.get("packages") or {}
        if os.name == "nt" and pkgs:
            # Refresh DriveFS cloud IDs if any package was recently created
            missing_ids = any(not p.get("file_id") or not p.get("my_drive_file_id") for p in pkgs.values())
            if missing_ids:
                try:
                    from pc_worker.gdrive_cloud_sync import query_drivefs_cloud_ids

                    dfs = query_drivefs_cloud_ids()
                    changed = False
                    for sid, p in pkgs.items():
                        sd = (dfs.get("files_shared_drive") or {}).get(sid)
                        md = (dfs.get("files_my_drive") or {}).get(sid)
                        if sd and sd.get("file_id") and p.get("file_id") != sd["file_id"]:
                            p["file_id"] = sd["file_id"]
                            changed = True
                        if md and md.get("file_id") and p.get("my_drive_file_id") != md["file_id"]:
                            p["my_drive_file_id"] = md["file_id"]
                            changed = True
                    if dfs.get("shared_drive_folder_id"):
                        manifest["shared_drive_folder_id"] = dfs["shared_drive_folder_id"]
                    if dfs.get("my_drive_folder_id"):
                        manifest["my_drive_folder_id"] = dfs["my_drive_folder_id"]
                    if changed:
                        _save_cloud_manifest(manifest)
                except Exception:
                    pass

        sd_fid = str(manifest.get("shared_drive_folder_id") or "")
        md_fid = str(manifest.get("my_drive_folder_id") or "")
        pkg_list = []
        synced_sd = 0
        synced_md = 0
        total_bytes = 0
        for sid, p in sorted(pkgs.items()):
            fid = str(p.get("file_id") or "")
            mfid = str(p.get("my_drive_file_id") or "")
            sz = int(p.get("size_bytes") or 0)
            total_bytes += sz
            if fid:
                synced_sd += 1
            if mfid:
                synced_md += 1
            pkg_list.append(
                {
                    "scan_id": sid,
                    "size_bytes": sz,
                    "size_mb": round(sz / (1024 * 1024), 2),
                    "file_id": fid,
                    "my_drive_file_id": mfid,
                    "mtime": p.get("mtime", 0),
                    "files_count": len(p.get("toc") or {}),
                }
            )
        bearer_ok = bool(_get_gdrive_bearer_token())
        sa = auth.get("service_account") if isinstance(auth.get("service_account"), dict) else {}
        return {
            "status": "ok",
            "updated_at": manifest.get("updated_at", 0),
            "shared_drive_dir": manifest.get("shared_drive_dir", ""),
            "my_drive_dir": manifest.get("my_drive_dir", ""),
            "shared_drive_folder_id": sd_fid,
            "my_drive_folder_id": md_fid,
            "shared_drive_url": f"https://drive.google.com/drive/folders/{sd_fid}" if sd_fid else "",
            "my_drive_url": f"https://drive.google.com/drive/folders/{md_fid}" if md_fid else "",
            "total_packages": len(pkg_list),
            "synced_shared_drive_count": synced_sd,
            "synced_my_drive_count": synced_md,
            "total_size_mb": round(total_bytes / (1024 * 1024), 2),
            "auth_configured": bearer_ok,
            "has_credentials": bool(sa.get("private_key")),
            "auth_mode": auth.get("auth_mode") or ("service_account" if bearer_ok else "service_account_pending_key"),
            "service_account_email": sa.get("client_email") or GDRIVE_SERVICE_ACCOUNT_EMAIL,
            "expected_service_account_email": GDRIVE_SERVICE_ACCOUNT_EMAIL,
            "expected_project_id": GDRIVE_SERVICE_ACCOUNT_PROJECT_ID,
            "private_key_loaded": bool(sa.get("private_key")),
            "private_key_id": sa.get("private_key_id", ""),
            "google_client_id": GOOGLE_OAUTH_CLIENT_ID,
            "packages": pkg_list,
        }



def _ensure_vps_caddy_route():
    """When running inside the VPS Docker container, ensures scans.gatheren.cloud is registered in Caddyfile."""
    if os.name == "nt":
        return
    import glob
    candidate_paths = [
        "/host_docker/gatheringcloud_prod/Caddyfile",
        "/host_opt/gatheringcloud/Caddyfile",
    ]
    for hc_path in glob.glob("/host_containers/*/hostconfig.json"):
        try:
            with open(hc_path, "r", encoding="utf-8") as f:
                hc = json.load(f)
            for bind in hc.get("Binds") or []:
                if "/etc/caddy/Caddyfile" in bind:
                    host_src = bind.split(":")[0]
                    for prefix, mapped in [("/docker/", "/host_docker/"), ("/opt/", "/host_opt/"), ("/tmp/", "/host_tmp/")]:
                        if host_src.startswith(prefix):
                            candidate_paths.insert(0, mapped + host_src[len(prefix):])
        except Exception as e:
            print(f"[GatheringScans] hostconfig scan warning: {e}")

    # Also discover live Caddy process via /proc when pid: host is enabled
    caddy_pids = []
    for cmd_path in glob.glob("/proc/[0-9]*/cmdline"):
        try:
            with open(cmd_path, "rb") as f:
                raw_cmd = f.read()
            if b"caddy\x00run" in raw_cmd or b"caddy\x00" in raw_cmd and b"Caddyfile" in raw_cmd:
                pid_str = cmd_path.split("/")[2]
                if pid_str.isdigit():
                    caddy_pids.append(int(pid_str))
                    proc_cf = f"/proc/{pid_str}/root/etc/caddy/Caddyfile"
                    if os.path.isfile(proc_cf) and proc_cf not in candidate_paths:
                        candidate_paths.insert(0, proc_cf)
        except Exception:
            pass

    block = (
        "\nscans.gatheren.cloud {\n"
        "    encode zstd gzip\n"
        "    reverse_proxy gathering_scans_web:8095\n"
        "}\n"
    )
    active_caddyfile_content = None
    for cpath in candidate_paths:
        if os.path.isfile(cpath):
            try:
                with open(cpath, "r", encoding="utf-8") as f:
                    content = f.read()
                if "scans.gatheren.cloud" not in content:
                    content = content.rstrip() + "\n" + block
                    with open(cpath, "w", encoding="utf-8") as f:
                        f.write(content)
                    print(f"[GatheringScans] Added scans.gatheren.cloud block to {cpath}")
                if active_caddyfile_content is None:
                    active_caddyfile_content = content
            except Exception as e:
                print(f"[GatheringScans] Failed updating {cpath}: {e}")

    # Hot-reload live Caddy Admin API (127.0.0.1:2019/load) inside Caddy's network namespace
    if active_caddyfile_content and caddy_pids:
        import subprocess
        helper_code = (
            "import os, sys, http.client\n"
            "pid = int(sys.argv[1])\n"
            "cf = sys.stdin.read()\n"
            "fd = os.open(f'/proc/{pid}/ns/net', os.O_RDONLY)\n"
            "if hasattr(os, 'setns'):\n"
            "    os.setns(fd, getattr(os, 'CLONE_NEWNET', 0x40000000))\n"
            "else:\n"
            "    import ctypes\n"
            "    ctypes.CDLL('libc.so.6').setns(fd, 0x40000000)\n"
            "os.close(fd)\n"
            "conn = http.client.HTTPConnection('127.0.0.1', 2019, timeout=5)\n"
            "conn.request('GET', '/config/')\n"
            "r = conn.getresponse()\n"
            "cfg = r.read().decode('utf-8', 'ignore')\n"
            "if 'scans.gatheren.cloud' not in cfg:\n"
            "    conn2 = http.client.HTTPConnection('127.0.0.1', 2019, timeout=10)\n"
            "    conn2.request('POST', '/load', body=cf.encode('utf-8'), headers={'Content-Type': 'text/caddyfile', 'Cache-Control': 'must-revalidate'})\n"
            "    r2 = conn2.getresponse()\n"
            "    print(f'[GatheringScans] Hot-reloaded Caddy (PID {pid}): HTTP {r2.status} {r2.read().decode()}')\n"
        )
        for cpid in caddy_pids:
            try:
                subprocess.run(
                    [sys.executable, "-c", helper_code, str(cpid)],
                    input=active_caddyfile_content,
                    text=True,
                    timeout=15,
                )
                break
            except Exception as e:
                print(f"[GatheringScans] Caddy netns hot-reload warning (PID {cpid}): {e}")


def _vps_caddy_watchdog_loop():
    while True:
        try:
            _ensure_vps_caddy_route()
        except Exception as e:
            print(f"[GatheringScans] Caddy watchdog error: {e}")
        time.sleep(20)


def _pc_cloud_manifest_sync_loop():
    """
    On the Windows Workstation, periodically checks if any newly completed scan needs a `.3tz`
    package on Google Drive or if DriveFS has assigned new Google Drive File IDs, and pushes
    the updated manifest to the Hostinger VPS.
    """
    time.sleep(2.0)
    while True:
        try:
            if is_pc_daemon_running():
                from pc_worker.gdrive_cloud_sync import sync_all_scans_to_gdrive_and_vps

                manifest = sync_all_scans_to_gdrive_and_vps(DB, AUTH_SHARE, force=False)
                _save_cloud_manifest(manifest)
        except Exception as e:
            print(f"[GatheringScans] Background .3tz cloud sync note: {e}")
        time.sleep(60.0)


