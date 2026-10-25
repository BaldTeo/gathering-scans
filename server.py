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
import hashlib
import mimetypes
import threading
import http.client
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, Any, Optional, Tuple

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
    PC_SIMULATED_OFFLINE = not bool(running)
    if running:
        _DAEMON_WAKE_EVENT.set()
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
    entries = []
    for root_label, root_dir in (("local", LOCAL_SCANS_ROOT), ("gdrive_inputs", GDRIVE_INPUTS_DIR), ("gdrive", GDRIVE_INBOX_DIR)):
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
                    for sname in sub[:24]:
                        sfull = os.path.join(full, sname)
                        try:
                            if os.path.isdir(sfull):
                                ssub = sorted(os.listdir(sfull))[:8]
                                nested_parts.append(f"{sname}[{','.join(ssub)}]")
                            else:
                                nested_parts.append(sname)
                        except Exception:
                            nested_parts.append(sname)
                    entries.append(f"{root_label}:{name}:{','.join(nested_parts)}")
                elif os.path.isfile(full) and name.lower().endswith(".zip"):
                    try:
                        sz = os.path.getsize(full)
                    except Exception:
                        sz = 0
                    entries.append(f"{root_label}:{name}:{sz}")
        except Exception:
            pass
    return tuple(entries)


def sync_scans_with_filesystem(max_age_s: float = 1.5, force: bool = False) -> None:
    """Live filesystem sync: discovers new folders in C:\\GatheringScans and removes deleted folders."""
    global _LAST_FS_SYNC_TS, _LAST_FS_FINGERPRINT
    if os.name != "nt":
        return
    if not force and not is_pc_daemon_running():
        return
    now = time.time()
    if not force and (now - _LAST_FS_SYNC_TS < max_age_s):
        return
    with _FS_SYNC_LOCK:
        if not force and (time.time() - _LAST_FS_SYNC_TS < max_age_s):
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

# Simulated PC Online Toggle (synchronized with persistent daemon_state.json)
PC_SIMULATED_OFFLINE = not is_pc_daemon_running()

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


class GatheringScansHandler(SimpleHTTPRequestHandler):
    extensions_map = SimpleHTTPRequestHandler.extensions_map.copy()
    extensions_map.update(
        {
            ".html": "text/html; charset=utf-8",
            ".htm": "text/html; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".ico": "image/x-icon",
            ".glb": "model/gltf-binary",
            ".gltf": "model/gltf+json",
            ".json": "application/json; charset=utf-8",
            ".subtree": "application/octet-stream",
            ".b3dm": "application/octet-stream",
            ".pnts": "application/octet-stream",
            ".wasm": "application/wasm",
            ".obj": "text/plain; charset=utf-8",
            ".mtl": "text/plain; charset=utf-8",
            ".dxf": "application/dxf",
            ".dwg": "application/acad",
            ".pdf": "application/pdf",
            ".csv": "text/csv; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
        }
    )

    def log_message(self, fmt: str, *args: Any):
        # Concise server logging
        pass

    def end_headers(self):
        origin = (self.headers.get("Origin") or "").strip()
        allowed_origin = "https://scans.gatheren.cloud"
        if origin:
            o_low = origin.lower()
            if (
                o_low in ("https://scans.gatheren.cloud", "https://gatheren.cloud")
                or (o_low.startswith("https://") and o_low.endswith(".gatheren.cloud"))
                or o_low.startswith("http://localhost:")
                or o_low.startswith("http://127.0.0.1:")
                or o_low in ("http://localhost", "http://127.0.0.1")
            ):
                allowed_origin = origin
        self.send_header("Access-Control-Allow-Origin", allowed_origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, X-Share-Token, X-Session-Token, X-Tunnel-Key, X-User-Email, X-User-Name, Range",
        )
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
        self.send_header("Alt-Svc", "clear")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_HEAD(self):
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        if path.startswith("/s/"):
            tok = path[len("/s/") :].strip("/")
            safe_tok = urllib.parse.quote(tok, safe="-_")
            self.send_response(302)
            self.send_header("Location", f"/?share={safe_tok}")
            self.end_headers()
            return
        super().do_HEAD()

    def send_json(self, data: Dict[str, Any], status: int = 200):
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _extract_share_token(self, query_params: Dict[str, list]) -> str:
        header_tok = self.headers.get("X-Share-Token", "").strip()
        if header_tok:
            return header_tok
        q_tok = query_params.get("share", [""])[0].strip()
        return q_tok

    _GZIP_FILE_CACHE: Dict[str, Tuple[float, bytes]] = {}
    _OPTIMIZED_TILESET_CACHE: Dict[str, Tuple[float, bytes]] = {}
    _SCAN_MESH_METRICS_CACHE: Dict[Tuple[str, str], Dict[str, Any]] = {}

    def _serve_optimized_tileset_json(self, ts_path: str):
        try:
            base_dir = os.path.dirname(ts_path)
            tiles_sub = os.path.join(base_dir, "tiles")
            mtime = os.path.getmtime(ts_path)
            if os.path.isdir(tiles_sub):
                try:
                    for fn_t in os.listdir(tiles_sub):
                        if fn_t.lower().endswith(".glb"):
                            mtime = max(mtime, os.path.getmtime(os.path.join(tiles_sub, fn_t)))
                except OSError:
                    pass
            cached = self._OPTIMIZED_TILESET_CACHE.get(ts_path)
            if cached and cached[0] == mtime:
                raw_json = cached[1]
            else:
                with open(ts_path, "r", encoding="utf-8") as f:
                    ts = json.load(f)
                root = ts.get("root") or {}
                if not root.get("transform"):
                    ts.setdefault("asset", {})["gltfUpAxis"] = "Z"
                r_content = root.get("content") or {}
                r_uri = r_content.get("uri") if isinstance(r_content, dict) else None
                if r_uri:
                    clean_r_uri = r_uri.split("?")[0]
                    r_file = os.path.join(base_dir, clean_r_uri)
                    if os.path.isfile(r_file):
                        r_content["uri"] = f"{clean_r_uri}?v={int(os.path.getmtime(r_file))}"
                    if os.path.isfile(r_file) and os.path.getsize(r_file) >= 800_000:
                        # Root .glb already contains the full-site mesh (~300k+ triangles)
                        root["geometricError"] = 0.0
                        root["children"] = []
                    else:
                        # Small root .glb (e.g. QuChi_1_20260921): cap at Depth 2
                        for c1 in root.get("children") or []:
                            c1_c = c1.get("content") or {}
                            if isinstance(c1_c, dict) and c1_c.get("uri"):
                                u1 = c1_c["uri"].split("?")[0]
                                f1 = os.path.join(base_dir, u1)
                                if os.path.isfile(f1):
                                    c1_c["uri"] = f"{u1}?v={int(os.path.getmtime(f1))}"
                            for c2 in c1.get("children") or []:
                                c2_c = c2.get("content") or {}
                                if isinstance(c2_c, dict) and c2_c.get("uri"):
                                    u2 = c2_c["uri"].split("?")[0]
                                    f2 = os.path.join(base_dir, u2)
                                    if os.path.isfile(f2):
                                        c2_c["uri"] = f"{u2}?v={int(os.path.getmtime(f2))}"
                                c2["geometricError"] = 0.0
                                c2["children"] = []
                else:
                    # PIX4Dmatic Cesium octree: prune each octant branch at its first content node (100k-300k triangles per tile)
                    def _prune_branch(node: dict, depth: int = 0) -> bool:
                        c = node.get("content") or {}
                        if isinstance(c, dict) and c.get("uri"):
                            u_clean = c["uri"].split("?")[0]
                            f_clean = os.path.join(base_dir, u_clean)
                            if os.path.isfile(f_clean):
                                c["uri"] = f"{u_clean}?v={int(os.path.getmtime(f_clean))}"
                            node["geometricError"] = 0.0
                            node["children"] = []
                            return True
                        if depth >= 2:
                            node["children"] = []
                            return False
                        kept = []
                        for ch in node.get("children") or []:
                            if _prune_branch(ch, depth + 1):
                                kept.append(ch)
                        # Prioritize children with direct level-1 content so main 100k-300k triangle meshes stream first
                        kept.sort(key=lambda x: 0 if isinstance(x.get("content"), dict) and x["content"].get("uri") else 1)
                        node["children"] = kept
                        return len(kept) > 0

                    _prune_branch(root, 0)
                raw_json = json.dumps(ts, separators=(",", ":")).encode("utf-8")
                self._OPTIMIZED_TILESET_CACHE[ts_path] = (mtime, raw_json)

            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw_json)))
            self.send_header("Cache-Control", "no-cache, must-revalidate")
            self.end_headers()
            self.wfile.write(raw_json)
        except Exception:
            self._serve_file_with_range(ts_path)

    @staticmethod
    def _optimize_cesium_glb_bytes(raw_bytes: bytes) -> bytes:
        """
        Fast watertight UV-preserving grid clustering + mantissa quantization + JPEG optimization
        for large uncompressed PIX4Dmatic Cesium .glb tiles (> 700 KB) to reduce transfer size by ~10x.
        """
        if len(raw_bytes) < 700_000 or raw_bytes[:4] != b"glTF":
            return raw_bytes
        try:
            import io
            import numpy as np

            magic, ver, _ = struct.unpack_from("<4sII", raw_bytes, 0)
            if ver != 2:
                return raw_bytes
            j_len, j_type = struct.unpack_from("<I4s", raw_bytes, 12)
            if j_type != b"JSON":
                return raw_bytes
            b_off = 20 + j_len
            if b_off + 8 > len(raw_bytes):
                return raw_bytes
            b_len, b_type = struct.unpack_from("<I4s", raw_bytes, b_off)
            if b_type != b"BIN\x00":
                return raw_bytes
            j = json.loads(raw_bytes[20 : 20 + j_len].decode("utf-8"))
            meshes = j.get("meshes") or []
            if len(meshes) != 1 or len(meshes[0].get("primitives") or []) != 1:
                return raw_bytes
            prim = meshes[0]["primitives"][0]
            attrs = prim.get("attributes") or {}
            if "POSITION" not in attrs or "TEXCOORD_0" not in attrs or "indices" not in prim:
                return raw_bytes
            acc_list = j.get("accessors") or []
            bv_list = j.get("bufferViews") or []
            idx_acc = acc_list[prim["indices"]]
            pos_acc = acc_list[attrs["POSITION"]]
            uv_acc = acc_list[attrs["TEXCOORD_0"]]
            if idx_acc.get("componentType") not in (5125, 5123) or idx_acc.get("count", 0) < 30000:
                return raw_bytes
            if pos_acc.get("componentType") != 5126 or uv_acc.get("componentType") != 5126:
                return raw_bytes

            blob = memoryview(raw_bytes)[b_off + 8 : b_off + 8 + b_len]
            idx_bv = bv_list[idx_acc["bufferView"]]
            pos_bv = bv_list[pos_acc["bufferView"]]
            uv_bv = bv_list[uv_acc["bufferView"]]

            idx_dtype = np.uint32 if idx_acc.get("componentType") == 5125 else np.uint16
            idx = np.frombuffer(
                blob,
                dtype=idx_dtype,
                count=idx_acc["count"],
                offset=idx_bv.get("byteOffset", 0) + idx_acc.get("byteOffset", 0),
            ).astype(np.uint32).reshape(-1, 3)
            pos = np.frombuffer(
                blob,
                dtype=np.float32,
                count=pos_acc["count"] * 3,
                offset=pos_bv.get("byteOffset", 0) + pos_acc.get("byteOffset", 0),
            ).reshape(-1, 3)
            uv = np.frombuffer(
                blob,
                dtype=np.float32,
                count=uv_acc["count"] * 2,
                offset=uv_bv.get("byteOffset", 0) + uv_acc.get("byteOffset", 0),
            ).reshape(-1, 2)

            pmin, pmax = pos.min(axis=0), pos.max(axis=0)
            diag = float(np.linalg.norm(pmax - pmin))
            if diag <= 1e-5:
                return raw_bytes
            step = diag / 105.0
            grid = np.floor((pos - pmin) / step).astype(np.int64)
            cell_hash = grid[:, 0] * 1000003 + grid[:, 1] * 1009 + grid[:, 2]
            _, first_idx, inv_cell = np.unique(cell_hash, return_index=True, return_inverse=True)
            snapped_pos = pos[first_idx][inv_cell]

            c0, c1, c2 = inv_cell[idx[:, 0]], inv_cell[idx[:, 1]], inv_cell[idx[:, 2]]
            keep = (c0 != c1) & (c1 != c2) & (c2 != c0)
            if np.count_nonzero(keep) < 800:
                return raw_bytes
            kept_tris = idx[keep]
            used_v, new_tris = np.unique(kept_tris, return_inverse=True)
            new_idx = new_tris.astype(np.uint32).ravel()
            new_pos = snapped_pos[used_v].astype(np.float32).copy()
            new_uv = uv[used_v].astype(np.float32).copy()
            new_pos.view(np.uint32)[:] &= 0xFFFFC000
            new_uv.view(np.uint32)[:] &= 0xFFFFE000

            images = j.get("images") or []
            img_bytes = b""
            if images and "bufferView" in images[0]:
                ibv = bv_list[images[0]["bufferView"]]
                ioff = ibv.get("byteOffset", 0)
                ilen = ibv["byteLength"]
                img_bytes = bytes(blob[ioff : ioff + ilen])
                if len(img_bytes) > 140_000:
                    try:
                        from PIL import Image

                        im = Image.open(io.BytesIO(img_bytes))
                        im.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
                        out_im = io.BytesIO()
                        im.save(out_im, format="JPEG", quality=72, optimize=True)
                        img_bytes = out_im.getvalue()
                        images[0]["mimeType"] = "image/jpeg"
                    except Exception:
                        pass

            b_idx = new_idx.tobytes()
            b_pos = new_pos.tobytes()
            b_uv = new_uv.tobytes()

            new_bin = bytearray()
            off_idx = 0
            new_bin.extend(b_idx)
            while len(new_bin) % 4:
                new_bin.append(0)
            off_pos = len(new_bin)
            new_bin.extend(b_pos)
            while len(new_bin) % 4:
                new_bin.append(0)
            off_uv = len(new_bin)
            new_bin.extend(b_uv)
            while len(new_bin) % 4:
                new_bin.append(0)
            off_img = len(new_bin)
            new_bin.extend(img_bytes)
            while len(new_bin) % 4:
                new_bin.append(0)

            new_bvs = [
                {"buffer": 0, "byteOffset": off_idx, "byteLength": len(b_idx), "target": 34963},
                {"buffer": 0, "byteOffset": off_pos, "byteLength": len(b_pos), "target": 34962},
                {"buffer": 0, "byteOffset": off_uv, "byteLength": len(b_uv), "target": 34962},
            ]
            if img_bytes:
                new_bvs.append({"buffer": 0, "byteOffset": off_img, "byteLength": len(img_bytes)})
                images[0]["bufferView"] = 3

            new_accs = [
                {"bufferView": 0, "componentType": 5125, "count": int(len(new_idx)), "type": "SCALAR"},
                {
                    "bufferView": 1,
                    "componentType": 5126,
                    "count": int(len(new_pos)),
                    "type": "VEC3",
                    "min": [float(x) for x in new_pos.min(axis=0)],
                    "max": [float(x) for x in new_pos.max(axis=0)],
                },
                {"bufferView": 2, "componentType": 5126, "count": int(len(new_uv)), "type": "VEC2"},
            ]
            prim["indices"] = 0
            prim["attributes"] = {"POSITION": 1, "TEXCOORD_0": 2}
            prim.pop("extensions", None)
            j.pop("extensions", None)
            for ext_list_key in ("extensionsUsed", "extensionsRequired"):
                if ext_list_key in j:
                    j[ext_list_key] = [
                        e for e in j[ext_list_key] if e not in ("EXT_mesh_features", "EXT_structural_metadata")
                    ]
                    if not j[ext_list_key]:
                        j.pop(ext_list_key, None)
            j["bufferViews"] = new_bvs
            j["accessors"] = new_accs
            j["buffers"] = [{"byteLength": len(new_bin)}]

            new_j_bytes = json.dumps(j, separators=(",", ":")).encode("utf-8")
            while len(new_j_bytes) % 4:
                new_j_bytes += b" "
            total = 12 + 8 + len(new_j_bytes) + 8 + len(new_bin)
            out = bytearray()
            out.extend(struct.pack("<4sII", b"glTF", 2, total))
            out.extend(struct.pack("<I4s", len(new_j_bytes), b"JSON"))
            out.extend(new_j_bytes)
            out.extend(struct.pack("<I4s", len(new_bin), b"BIN\x00"))
            out.extend(new_bin)
            return bytes(out)
        except Exception:
            return raw_bytes

    def _serve_file_with_range(
        self, file_path: str, content_type: Optional[str] = None, download_name: Optional[str] = None
    ):
        if not os.path.isfile(file_path):
            self.send_json({"error": f"File not found: {os.path.basename(file_path)}"}, status=404)
            return

        file_size = os.path.getsize(file_path)
        ext = os.path.splitext(file_path)[1].lower()
        guessed_type, _ = mimetypes.guess_type(file_path)
        ctype = content_type or self.extensions_map.get(ext) or guessed_type or "application/octet-stream"

        range_header = self.headers.get("Range")
        accept_enc = self.headers.get("Accept-Encoding", "").lower()

        norm_fp = file_path.replace("\\", "/").lower()
        if ext == ".glb" and not download_name and file_size > 700_000 and "/content/" in norm_fp and "preview_low" not in norm_fp:
            try:
                mtime = os.path.getmtime(file_path)
                os.makedirs(GLB_CACHE_DIR, exist_ok=True)
                key_hash = hashlib.md5(f"v2:{file_path}:{int(mtime)}:{file_size}".encode("utf-8")).hexdigest()
                opt_disk_path = os.path.join(GLB_CACHE_DIR, f"{key_hash}.glb")
                gz_disk_path = os.path.join(GLB_CACHE_DIR, f"{key_hash}.glb.gz")
                if not os.path.isfile(opt_disk_path) or not os.path.isfile(gz_disk_path):
                    with open(file_path, "rb") as f:
                        raw_bytes = f.read()
                    opt_bytes = self._optimize_cesium_glb_bytes(raw_bytes)
                    gz_bytes = gzip.compress(opt_bytes, compresslevel=6)
                    with open(opt_disk_path, "wb") as df:
                        df.write(opt_bytes)
                    with open(gz_disk_path, "wb") as df:
                        df.write(gz_bytes)
                if not range_header and "gzip" in accept_enc:
                    cached = self._GZIP_FILE_CACHE.get(gz_disk_path)
                    if cached and cached[0] == mtime:
                        gz_bytes = cached[1]
                    else:
                        with open(gz_disk_path, "rb") as df:
                            gz_bytes = df.read()
                        if len(self._GZIP_FILE_CACHE) < 256:
                            self._GZIP_FILE_CACHE[gz_disk_path] = (mtime, gz_bytes)
                    self.send_response(200)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Content-Encoding", "gzip")
                    self.send_header("Content-Length", str(len(gz_bytes)))
                    self.send_header("Cache-Control", "public, max-age=3600")
                    self.end_headers()
                    try:
                        self.wfile.write(gz_bytes)
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    return
                file_path = opt_disk_path
                file_size = os.path.getsize(file_path)
            except Exception:
                pass

        # Gzip-compress .json, .glb, .js, .css files for fast reverse-tunnel streaming
        if ext in (".json", ".glb", ".js", ".css") and not range_header and not download_name and "gzip" in accept_enc and 1024 < file_size <= 32 * 1024 * 1024:
            try:
                mtime = os.path.getmtime(file_path)
                cached = self._GZIP_FILE_CACHE.get(file_path)
                if cached and cached[0] == mtime:
                    gz_bytes = cached[1]
                else:
                    with open(file_path, "rb") as f:
                        raw_bytes = f.read()
                    gz_bytes = gzip.compress(raw_bytes, compresslevel=1)
                    if len(self._GZIP_FILE_CACHE) < 256:
                        self._GZIP_FILE_CACHE[file_path] = (mtime, gz_bytes)
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Encoding", "gzip")
                self.send_header("Content-Length", str(len(gz_bytes)))
                base_fn = os.path.basename(file_path).lower()
                no_cache_asset = ext in (".html", ".js", ".css") or base_fn in ("tileset.json", "preview_tileset.json")
                cc_val = "no-cache, must-revalidate" if no_cache_asset else "public, max-age=3600"
                self.send_header("Cache-Control", cc_val)
                self.end_headers()
                try:
                    self.wfile.write(gz_bytes)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return
            except Exception:
                pass

        start, end = 0, file_size - 1
        status_code = 200

        if range_header and range_header.startswith("bytes="):
            m = re.match(r"bytes=(\d*)-(\d*)", range_header)
            if m:
                s_str, e_str = m.groups()
                if s_str:
                    start = int(s_str)
                if e_str:
                    end = min(int(e_str), file_size - 1)
                if start <= end < file_size:
                    status_code = 206

        length = max(0, end - start + 1)
        self.send_response(status_code)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status_code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        if download_name:
            self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        else:
            base_fn = os.path.basename(file_path).lower()
            no_cache_asset = ext in (".html", ".js", ".css") or base_fn in ("tileset.json", "preview_tileset.json")
            cc_val = "no-cache, must-revalidate" if no_cache_asset else "public, max-age=3600"
            self.send_header("Cache-Control", cc_val)
        self.end_headers()

        with open(file_path, "rb") as f:
            f.seek(start)
            remaining = length
            chunk_size = 64 * 1024
            while remaining > 0:
                chunk = f.read(min(chunk_size, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
                remaining -= len(chunk)

    def _enrich_scan_urls(self, scan: Dict[str, Any], share_token: str = "") -> Dict[str, Any]:
        s = dict(scan)
        sid = s["scan_id"]
        ts_path = s.get("tileset_path") or ""
        q_suffix = f"?share={share_token}" if share_token else ""
        ver_hint = s.get("tileset_version") or ""
        if not ver_hint:
            try:
                pkg_meta = (_load_cloud_manifest().get("packages") or {}).get(sid) or {}
                pkg_mtime = int(float(pkg_meta.get("mtime") or 0) * 1000)
                pkg_sz = int(pkg_meta.get("size_bytes") or 0)
                if pkg_mtime > 0 or pkg_sz > 0:
                    ver_hint = f"{pkg_mtime}_{pkg_sz}"
                    s["tileset_version"] = pkg_mtime or pkg_sz
            except Exception:
                pass
        if not ver_hint:
            ver_hint = str(abs(hash(f"{sid}:{s.get('updated_at') or s.get('capture_date') or ''}:{s.get('twd97_h') or 0}")) % 1000000000)
        ts_ver = f"opt6_{ver_hint}"
        prev_ver = f"low3_{ver_hint}"
        if ts_path and ts_path[:2].upper() == "C:" and os.path.isfile(ts_path):
            try:
                bdir = os.path.dirname(ts_path)
                proj_dir = s.get("project_dir") or os.path.dirname(bdir)
                tiles_sub = os.path.join(bdir, "tiles")
                p_ts = os.path.join(bdir, "preview_tileset.json")
                p_glb = os.path.join(bdir, "preview_low", "tiles", "root.glb")
                max_tile_mt = os.path.getmtime(ts_path)
                if os.path.isdir(tiles_sub):
                    for fn_t in os.listdir(tiles_sub):
                        if fn_t.lower().endswith(".glb"):
                            max_tile_mt = max(max_tile_mt, os.path.getmtime(os.path.join(tiles_sub, fn_t)))
                m_ts = int(max(max_tile_mt, float(s.get("tileset_version") or 0) / 1000.0) * 1000)
                m_prev = int(
                    max(
                        os.path.getmtime(p_ts) if os.path.isfile(p_ts) else 0.0,
                        os.path.getmtime(p_glb) if os.path.isfile(p_glb) else 0.0,
                        os.path.getmtime(ts_path),
                    )
                    * 1000
                )
                ts_ver = f"opt6_{m_ts}"
                prev_ver = f"low3_{m_prev}"
                s["tileset_version"] = m_ts
                s["has_original_backup"] = os.path.isfile(os.path.join(proj_dir, "tileset_backup", "tileset.json"))
                s["has_undo"] = os.path.isfile(os.path.join(proj_dir, "tileset_prev", "tileset.json"))
            except Exception:
                pass
        if ts_path.lower().endswith(".glb"):
            s["stream_url"] = f"/stream/{sid}/{os.path.basename(ts_path)}{q_suffix}"
            s["stream_type"] = "glb"
            s["preview_stream_url"] = f"/stream/{sid}/preview_low.glb{q_suffix}"
            s["preview_stream_type"] = "glb"
        else:
            ts_q = f"?v={ts_ver}&share={share_token}" if share_token else f"?v={ts_ver}"
            prev_q = f"?v={prev_ver}&share={share_token}" if share_token else f"?v={prev_ver}"
            s["stream_url"] = f"/stream/{sid}/tileset.json{ts_q}"
            s["stream_type"] = "tileset"
            s["preview_stream_url"] = f"/stream/{sid}/preview_tileset.json{prev_q}"
            s["preview_stream_type"] = "tileset"
        s["download_3tz_url"] = f"/api/download?scan_id={sid}&type=3tz" + (f"&share={share_token}" if share_token else "")
        s["download_glb_url"] = f"/api/download?scan_id={sid}&type=glb" + (f"&share={share_token}" if share_token else "")
        s["download_obj_url"] = f"/api/download?scan_id={sid}&type=obj" + (f"&share={share_token}" if share_token else "")
        s["download_zip_url"] = f"/api/download?scan_id={sid}&type=zip" + (f"&share={share_token}" if share_token else "")
        thumb_q = f"?v={ts_ver}&share={share_token}" if share_token else f"?v={ts_ver}"
        s["thumbnail_url"] = f"/api/scans/{sid}/thumbnail{thumb_q}"

        # Enrich polygon count, texture size, and 3D scan size (MB) with fast mtime-keyed cache
        cache_key = (sid, ts_ver)
        cached_metrics = self._SCAN_MESH_METRICS_CACHE.get(cache_key)
        if cached_metrics is None:
            poly_count = int(s.get("poly_count") or 0)
            tex_res_default = int(s.get("texture_resolution") or PIX4DMATIC_TEXTURE_SIZE)
            tex_w = int(s.get("texture_width") or tex_res_default)
            tex_h = int(s.get("texture_height") or tex_w)
            tex_cnt = int(s.get("texture_count") or 1)
            tex_label = str(s.get("texture_size_label") or "")
            stream_mb = float(s.get("stream_size_mb") or 0.0)
            obj_mb = float(s.get("obj_size_mb") or 0.0)

            if ts_path and os.path.isfile(ts_path):
                try:
                    import io as _io
                    from PIL import Image as _Image

                    bdir_m = os.path.dirname(ts_path)
                    proj_dir_m = s.get("project_dir") or os.path.dirname(bdir_m)
                    leaf_glbs = []
                    if ts_path.lower().endswith(".glb"):
                        leaf_glbs = [ts_path]
                    else:
                        with open(ts_path, "r", encoding="utf-8") as _mf:
                            _tso = json.load(_mf)
                        _root = _tso.get("root") or {}
                        _rc = ((_root.get("content") or {}).get("uri") or "").split("?")[0]
                        _rf = os.path.join(bdir_m, _rc) if _rc else ""
                        if _rf and os.path.isfile(_rf) and os.path.getsize(_rf) >= 800_000:
                            leaf_glbs = [_rf]
                        else:
                            def _walk_m(node: dict, depth: int = 0):
                                _cu = ((node.get("content") or {}).get("uri") or "").split("?")[0]
                                if _cu:
                                    _cf = os.path.join(bdir_m, _cu)
                                    if os.path.isfile(_cf):
                                        leaf_glbs.append(_cf)
                                        return
                                if depth < 3:
                                    for _ch in node.get("children") or []:
                                        if isinstance(_ch, dict):
                                            _walk_m(_ch, depth + 1)
                            _walk_m(_root, 0)

                    tris_sum = 0
                    glb_bytes_sum = 0
                    tex_dims_list = []
                    for _gfp in leaf_glbs:
                        try:
                            glb_bytes_sum += os.path.getsize(_gfp)
                            with open(_gfp, "rb") as _gf:
                                _hdr = _gf.read(20)
                                if len(_hdr) == 20 and _hdr[:4] == b"glTF":
                                    _jlen = struct.unpack_from("<I", _hdr, 12)[0]
                                    _gj = json.loads(_gf.read(_jlen).decode("utf-8"))
                                    _accs = _gj.get("accessors") or []
                                    for _gm in _gj.get("meshes") or []:
                                        for _gp in _gm.get("primitives") or []:
                                            if "indices" in _gp and _gp["indices"] < len(_accs):
                                                tris_sum += int(_accs[_gp["indices"]].get("count", 0)) // 3
                                    _imgs = _gj.get("images") or []
                                    _bvs = _gj.get("bufferViews") or []
                                    if _imgs and "bufferView" in _imgs[0] and _imgs[0]["bufferView"] < len(_bvs):
                                        _bv = _bvs[_imgs[0]["bufferView"]]
                                        _gf.seek(20 + _jlen + 8 + int(_bv.get("byteOffset", 0)))
                                        _ib = _gf.read(min(int(_bv.get("byteLength", 0)), 65536))
                                        try:
                                            _im = _Image.open(_io.BytesIO(_ib))
                                            tex_dims_list.append((int(_im.width), int(_im.height)))
                                        except Exception:
                                            pass
                        except Exception:
                            pass

                    obj_dir_m = os.path.join(proj_dir_m, "exports", "obj_mesh")
                    if os.path.isdir(obj_dir_m):
                        obj_b_sum = 0
                        obj_tex_dims = []
                        for _ofn in sorted(os.listdir(obj_dir_m)):
                            _ofp = os.path.join(obj_dir_m, _ofn)
                            if os.path.isfile(_ofp):
                                obj_b_sum += os.path.getsize(_ofp)
                                if _ofn.lower().endswith((".jpg", ".jpeg", ".png")):
                                    try:
                                        with _Image.open(_ofp) as _oim:
                                            obj_tex_dims.append((int(_oim.width), int(_oim.height)))
                                    except Exception:
                                        pass
                        if obj_b_sum > 0:
                            obj_mb = round(obj_b_sum / (1024 * 1024), 2)
                        if not tex_dims_list and obj_tex_dims:
                            tex_dims_list = obj_tex_dims

                    if tris_sum > 0:
                        poly_count = tris_sum
                    if glb_bytes_sum > 0:
                        stream_mb = round(glb_bytes_sum / (1024 * 1024), 2)
                    if tex_dims_list:
                        tex_w = max(w for w, _ in tex_dims_list)
                        tex_h = max(h for _, h in tex_dims_list)
                        tex_cnt = len(tex_dims_list)
                except Exception:
                    pass

            if not tex_label:
                if tex_cnt > 1 and tex_cnt <= 8:
                    tex_label = f"{tex_w}\u00d7{tex_h} px (\u00d7{tex_cnt})"
                elif tex_cnt > 8:
                    tex_label = f"{tex_w}\u00d7{tex_h} px ({tex_cnt} tiles)"
                else:
                    tex_label = f"{tex_w}\u00d7{tex_h} px"

            total_mb = round(float(s.get("size_mb") or (float(s.get("size_bytes") or 0) / (1024 * 1024))), 2)
            scan_mb = stream_mb if stream_mb > 0 else total_mb
            cached_metrics = {
                "poly_count": poly_count,
                "texture_resolution": max(tex_w, tex_h),
                "texture_width": tex_w,
                "texture_height": tex_h,
                "texture_count": tex_cnt,
                "texture_size_label": tex_label,
                "stream_size_mb": stream_mb,
                "obj_size_mb": obj_mb,
                "scan_size_mb": scan_mb,
            }
            if poly_count > 0 or stream_mb > 0:
                self._SCAN_MESH_METRICS_CACHE[cache_key] = cached_metrics

        s.update(cached_metrics)
        try:
            saved_cat = SURVEY.get_saved_categorization(sid, s)
            if isinstance(saved_cat, dict) and saved_cat.get("status") == "ok":
                s["has_categorization"] = True
                s["categorization_overlay_visible_default"] = bool(saved_cat.get("overlay_visible_default", False))
                cat_sum = dict(saved_cat.get("summary") or {})
                cat_sum["generated_at"] = saved_cat.get("generated_at", "")
                cat_sum["overlay_visible_default"] = bool(saved_cat.get("overlay_visible_default", False))
                s["categorization_summary"] = cat_sum
            else:
                s["has_categorization"] = False
                s["categorization_overlay_visible_default"] = False
        except Exception:
            s["has_categorization"] = False
            s["categorization_overlay_visible_default"] = False
        return s

    def _build_projects_summary(self, scans: list) -> list:
        projects_map: Dict[str, Dict[str, Any]] = {}
        georef_accum: Dict[str, List[Tuple[float, float, float, float]]] = {}
        for s in scans:
            grp = s.get("project_group") or "Unassigned Site"
            if grp not in projects_map:
                projects_map[grp] = {
                    "project_group": grp,
                    "project_name_zh": s.get("project_name_zh") or "",
                    "scan_count": 0,
                    "lat": None,
                    "lon": None,
                    "twd97_e": 0.0,
                    "twd97_n": 0.0,
                    "has_georef": False,
                    "latest_date": s.get("capture_date") or "",
                    "scan_ids": [],
                }
                georef_accum[grp] = []
            entry = projects_map[grp]
            if not entry["project_name_zh"] and s.get("project_name_zh"):
                entry["project_name_zh"] = s.get("project_name_zh")
            entry["scan_count"] += 1
            entry["scan_ids"].append(s.get("scan_id"))
            cdate = str(s.get("capture_date") or "")
            if cdate > str(entry["latest_date"]):
                entry["latest_date"] = cdate

            crs_str = str(s.get("crs") or "").upper()
            raw_lat = s.get("lat")
            raw_lon = s.get("lon")
            if raw_lat is not None and raw_lon is not None and "LOCAL" not in crs_str:
                try:
                    flat = float(raw_lat)
                    flon = float(raw_lon)
                    if (abs(flat) > 0.001 or abs(flon) > 0.001) and -90.0 <= flat <= 90.0 and -180.0 <= flon <= 180.0:
                        fe = float(s.get("twd97_e") or 0.0)
                        fn = float(s.get("twd97_n") or 0.0)
                        georef_accum[grp].append((flat, flon, fe, fn))
                except (TypeError, ValueError):
                    pass

        for grp, entry in projects_map.items():
            pts = georef_accum.get(grp) or []
            if pts:
                n_pts = len(pts)
                entry["lat"] = round(sum(p[0] for p in pts) / n_pts, 6)
                entry["lon"] = round(sum(p[1] for p in pts) / n_pts, 6)
                entry["twd97_e"] = round(sum(p[2] for p in pts) / n_pts, 3)
                entry["twd97_n"] = round(sum(p[3] for p in pts) / n_pts, 3)
                entry["has_georef"] = True

        return sorted(projects_map.values(), key=lambda x: (-x["scan_count"], x["project_group"].lower()))

    def _resolve_scan_thumbnail_path(self, scan_id: str, scan: Optional[Dict[str, Any]] = None) -> Optional[str]:
        s = scan or DB.get_scan(scan_id) or (DB.get_trashed_scan(scan_id) if hasattr(DB, "get_trashed_scan") else None) or {}
        proj_dir = s.get("project_dir") or ""

        # 1. Check scan.project_dir/thumbnail.png dynamically inside C:\GatheringScans (flat or nested)
        if proj_dir and os.path.isdir(proj_dir):
            for fname in ("thumbnail.png", "preview.png", "thumbnail.jpg", "ortho_preview.png"):
                cand = os.path.join(proj_dir, fname)
                if os.path.isfile(cand) and os.path.getsize(cand) > 256:
                    return cand

        # 2. Check automatically captured WebGL screenshot in data/thumbnails/<scan_id>.png (exact & case-insensitive)
        captured_png = os.path.join(THUMBS_DIR, f"{scan_id}.png")
        if os.path.isfile(captured_png) and os.path.getsize(captured_png) > 512:
            return captured_png
        low_target = f"{scan_id.lower()}.png"
        if os.path.isdir(THUMBS_DIR):
            for fn in os.listdir(THUMBS_DIR):
                if fn.lower() == low_target:
                    cand = os.path.join(THUMBS_DIR, fn)
                    if os.path.isfile(cand) and os.path.getsize(cand) > 512:
                        return cand

        # 3. Dynamic sibling scan thumbnail lookup in the same project_group (supports 100+ projects)
        grp = s.get("project_group", "")
        if grp:
            for sib in DB.list_scans(project_group=grp):
                sib_dir = sib.get("project_dir") or ""
                if sib_dir and os.path.isdir(sib_dir):
                    sib_thumb = os.path.join(sib_dir, "thumbnail.png")
                    if os.path.isfile(sib_thumb) and os.path.getsize(sib_thumb) > 256:
                        return sib_thumb
                sib_id = sib.get("scan_id", "")
                sib_cap = os.path.join(THUMBS_DIR, f"{sib_id}.png")
                if os.path.isfile(sib_cap) and os.path.getsize(sib_cap) > 512:
                    return sib_cap

        return None

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
        exp = float(link.get("expires_at") or 0)
        if exp > 0 and time.time() > exp:
            return False, "This external share link has expired.", link, []
        allowed_ids = link.get("allowed_scan_ids") or []
        if isinstance(allowed_ids, str):
            try:
                allowed_ids = json.loads(allowed_ids)
            except Exception:
                allowed_ids = [x.strip() for x in allowed_ids.split(",") if x.strip()]
        scope_grp = link.get("project_group") or ""
        allowed_scans = []
        for s in scans:
            sid = s.get("scan_id")
            if allowed_ids and sid in allowed_ids:
                allowed_scans.append(s)
            elif not allowed_ids and scope_grp and s.get("project_group") == scope_grp:
                allowed_scans.append(s)
            elif not allowed_ids and not scope_grp:
                allowed_scans.append(s)
        if requested_scan_id and not any(s.get("scan_id") == requested_scan_id for s in allowed_scans):
            return False, f"Share token is not authorized for scan {requested_scan_id}.", link, []
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
            path in ("/api/scans", "/api/projects", "/api/status", "/api/pc/health", "/api/user-profiles")
            or path.endswith("/thumbnail")
            or path.endswith("/thumbnail.png")
            or path.endswith("/tileset.json")
            or path.endswith("/preview_tileset.json")
            or path.endswith(".glb")
        )
        if method == "POST" and path.endswith("/thumbnail"):
            for k in list(_VPS_RAM_FALLBACK_CACHE.keys()):
                if k.startswith(path):
                    _VPS_RAM_FALLBACK_CACHE.pop(k, None)
        if method in ("POST", "DELETE") and ("/rename" in path or "/delete" in path or "/bin" in path or "/rerun" in path or "/admin/users" in path or path == "/api/comments" or path.startswith("/api/comments/") or path.startswith("/api/optimizer/") or path in ("/api/scans/rename", "/api/scans/delete", "/api/scans/merge")):
            for k in list(_VPS_RAM_FALLBACK_CACHE.keys()):
                if k.startswith("/api/scans") or k.startswith("/api/projects") or k.startswith("/api/user-profiles") or k.startswith("/api/admin/users") or k.startswith("/stream/"):
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

        # 1b. Serve scan thumbnails directly from local VPS /app/data/thumbnails/ if available (24/7 instant PNG for Google Chat)
        if method == "GET" and path.startswith("/api/scans/") and (path.endswith("/thumbnail") or path.endswith("/thumbnail.png")):
            suffix = "/thumbnail.png" if path.endswith("/thumbnail.png") else "/thumbnail"
            req_sid = path[len("/api/scans/") : -len(suffix)].strip("/")
            local_vps_thumb = self._resolve_scan_thumbnail_path(req_sid)
            if local_vps_thumb and os.path.isfile(local_vps_thumb):
                self._serve_file_with_range(local_vps_thumb, content_type="image/png")
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

                buf_for_cache = bytearray() if (cacheable and status_code == 200) else None
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
            or path == "/api/scans/delete"
            or path.startswith("/api/scans/bin")
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

    def _resolve_request_role(
        self,
        payload: Optional[Dict[str, Any]] = None,
        query: Optional[Dict[str, Any]] = None,
        share_token: Optional[str] = None,
    ) -> Tuple[str, str, Dict[str, Any]]:
        """
        Resolves `(email, role, permissions)` for the current HTTP request across the 5 permission levels:
        1. Owner (`glibivanov@gatheren.com.tw`)
        2. Admin
        3. Editor
        4. Viewer
        5. Guest (scoped external share link or guest role)
        """
        if share_token:
            return ("guest@external", "guest", get_role_permissions("guest", True))

        # Allow trusted internal daemon/sync calls authenticated with TUNNEL_SHARED_KEY
        if self.headers.get("X-Tunnel-Key", "").strip() == TUNNEL_SHARED_KEY:
            raw_internal_email = (
                self.headers.get("X-User-Email")
                or (payload.get("actor_email") if isinstance(payload, dict) else None)
                or "glibivanov@gatheren.com.tw"
            )
            int_email = str(raw_internal_email).strip().lower()
            return (int_email, "owner", get_role_permissions("owner"))

        sess_tok = (
            self.headers.get("X-Session-Token")
            or (payload.get("session_token") if isinstance(payload, dict) else None)
            or ((query.get("session_token") or [None])[0] if isinstance(query, dict) else None)
            or ""
        ).strip()
        if not sess_tok:
            raw_cookie = self.headers.get("Cookie") or ""
            for c_part in raw_cookie.split(";"):
                c_kv = c_part.strip()
                if c_kv.startswith("gs_session_token="):
                    sess_tok = urllib.parse.unquote(c_kv[len("gs_session_token=") :].strip())
                    break
        verified_email = verify_session_token(sess_tok)
        if not verified_email or verified_email in ("guest", "guest@anonymous", "guest@external"):
            return ("guest@anonymous", "guest", get_role_permissions("guest"))

        if verified_email in ("glibivanov@gatheren.com.tw", "gleb.ivanov1999@gmail.com"):
            return (verified_email, "owner", get_role_permissions("owner"))
        profiles = AUTH_SHARE.list_user_profiles()
        matched = next((p for p in profiles if str(p.get("email", "")).lower() == verified_email), None)
        role = normalize_role(matched.get("role") if matched else "viewer", email=verified_email)
        return (verified_email, role, get_role_permissions(role))

    def do_GET(self):
        global PC_SIMULATED_OFFLINE
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)
        share_token = self._extract_share_token(query)

        # 0. Reverse Tunnel Registration from Windows PC
        if path == "/_pc_tunnel":
            self._handle_pc_tunnel_register()
            return

        # 0a. Google Drive .3tz Cloud Manifest Status & Service Account Live Test (served directly on both VPS and PC)
        if path == "/api/cloud-manifest/status":
            if os.name != "nt" and not (_load_cloud_manifest().get("packages")):
                self._proxy_via_pc_tunnel_if_vps("GET", path)
                return
            self.send_json(self._build_cloud_manifest_status())
            return

        if path == "/api/cloud-manifest/test-sa":
            _, _, sa_perms = self._resolve_request_role(None, query, share_token)
            if share_token or not sa_perms.get("can_manage_users"):
                self.send_json({"error": "Owner or Admin session required to test Service Account."}, status=403)
                return
            self.send_json(_test_gdrive_service_account())
            return

        # 0b. Scoped External Share Link Short URL: /s/<token> (handled directly in <1ms on both VPS and PC)
        if path.startswith("/s/"):
            tok = path[len("/s/") :].strip("/")
            safe_tok = urllib.parse.quote(tok, safe="-_")
            self.send_response(302)
            self.send_header("Location", f"/?share={safe_tok}")
            self.end_headers()
            return

        # 1. On Linux VPS, proxy dynamic API and 3D stream routes over Reverse Tunnel to Windows PC
        if os.name != "nt" and (path.startswith("/api/") or path.startswith("/stream/")):
            if self._proxy_via_pc_tunnel_if_vps("GET", path):
                return

        # 2. Health & Status API
        if path in ("/api/status", "/api/pc/health"):
            sync_scans_with_filesystem()
            scans = DB.list_scans()
            processing = [s for s in scans if s["status"] == "processing"]
            queued = [s for s in scans if s["status"] in ("queued", "waiting_parts")]
            d_running = is_pc_daemon_running()
            self.send_json(
                {
                    "status": "offline" if (PC_SIMULATED_OFFLINE or not d_running) else "online",
                    "pc_online": (not PC_SIMULATED_OFFLINE) and d_running,
                    "daemon_running": d_running,
                    "app": "GatheringScans",
                    "domain": "scans.gatheren.cloud",
                    "crs": TWD97_TWVD2001_LABEL,
                    "crs_short": TWD97_TWVD2001_SHORT,
                    "texture_limit": PIX4DMATIC_TEXTURE_SIZE,
                    "vps_raw_storage": "disabled (strictly 0 bytes on Linux VPS)",
                    "active_job": processing[0] if processing else None,
                    "queued_count": len(queued),
                    "total_scans": len(scans),
                }
            )
            return

        # 3. List Scans & Spatial Clusters (Enforces External Share Token if present)
        if path == "/api/scans":
            sync_scans_with_filesystem()
            if share_token:
                ok, reason, link, allowed_scans = AUTH_SHARE.validate_share_access(
                    share_token, increment_view=True
                )
                if not ok:
                    self.send_json({"error": reason, "revoked": True}, status=403)
                    return
                enriched = [self._enrich_scan_urls(s, share_token) for s in allowed_scans]
                self.send_json(
                    {
                        "status": "ok",
                        "mode": "external_share",
                        "share_link": link,
                        "scans": enriched,
                        "projects": self._build_projects_summary(enriched),
                        "materials": MATERIAL_CATALOG,
                        "google_client_id": GOOGLE_OAUTH_CLIENT_ID,
                    }
                )
                return

            project_group = query.get("group", [None])[0]
            scans = [self._enrich_scan_urls(s) for s in DB.list_scans(project_group=project_group)]
            bin_scans = DB.list_trashed_scans()
            d_running = is_pc_daemon_running()
            self.send_json(
                {
                    "status": "ok",
                    "mode": "internal",
                    "pc_online": (not PC_SIMULATED_OFFLINE) and d_running,
                    "daemon_running": d_running,
                    "crs": TWD97_TWVD2001_LABEL,
                    "scans": scans,
                    "projects": self._build_projects_summary(scans),
                    "bin_scans_count": len(bin_scans),
                    "materials": MATERIAL_CATALOG,
                    "google_client_id": GOOGLE_OAUTH_CLIENT_ID,
                }
            )
            return

        # 3a-0. Recycle Bin List Endpoint (/api/scans/bin)
        if path == "/api/scans/bin":
            bin_scans = DB.list_trashed_scans()
            self.send_json(
                {
                    "status": "ok",
                    "ok": True,
                    "count": len(bin_scans),
                    "bin_scans": bin_scans,
                }
            )
            return

        # 3a. Scalable Projects Catalog Endpoint (/api/projects)
        if path == "/api/projects":
            sync_scans_with_filesystem()
            scans = [self._enrich_scan_urls(s) for s in DB.list_scans()]
            projects = self._build_projects_summary(scans)
            self.send_json(
                {
                    "status": "ok",
                    "total_projects": len(projects),
                    "total_scans": len(scans),
                    "projects": projects,
                }
            )
            return

        # 3b. Scan Screenshot / Thumbnail Endpoint: /api/scans/<scan_id>/thumbnail(.png)
        if path.startswith("/api/scans/") and (path.endswith("/thumbnail") or path.endswith("/thumbnail.png")):
            suffix = "/thumbnail.png" if path.endswith("/thumbnail.png") else "/thumbnail"
            scan_id = path[len("/api/scans/") : -len(suffix)].strip("/")
            if share_token:
                ok, reason, _, _ = AUTH_SHARE.validate_share_access(
                    share_token, requested_scan_id=scan_id
                )
                if not ok:
                    self.send_json({"error": reason}, status=403)
                    return
            scan = DB.get_scan(scan_id) or (DB.get_trashed_scan(scan_id) if hasattr(DB, "get_trashed_scan") else None) or {}
            thumb_path = self._resolve_scan_thumbnail_path(scan_id, scan)
            if thumb_path and os.path.isfile(thumb_path):
                self._serve_file_with_range(thumb_path, content_type="image/png")
                return
            # Dynamic raster PNG preview fallback if no file exists on disk (Google Chat strictly requires raster image/png)
            png_bytes = b""
            try:
                import io
                from PIL import Image, ImageDraw

                img = Image.new("RGB", (640, 360), (15, 23, 42))
                drw = ImageDraw.Draw(img)
                drw.polygon([(40, 270), (190, 150), (330, 220), (470, 110), (600, 250)], fill=(14, 116, 144), outline=(56, 189, 248))
                title = str(scan.get("name") or scan_id)[:38]
                drw.text((28, 28), f"GatheringScans 3D: {title}", fill=(248, 250, 252))
                buf = io.BytesIO()
                img.save(buf, format="PNG")
                png_bytes = buf.getvalue()
            except Exception:
                png_bytes = base64.b64decode(
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
                )
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Cache-Control", "public, max-age=3600")
            self.send_header("Content-Length", str(len(png_bytes)))
            self.end_headers()
            self.wfile.write(png_bytes)
            return

        # 4. Single Scan Details (Enforces External Share Token if present)
        if path.startswith("/api/scans/"):
            scan_id = path[len("/api/scans/") :].strip("/")
            if share_token:
                ok, reason, link, _ = AUTH_SHARE.validate_share_access(
                    share_token, requested_scan_id=scan_id
                )
                if not ok:
                    self.send_json({"error": reason}, status=403)
                    return
            scan = DB.get_scan(scan_id)
            if not scan:
                self.send_json({"error": f"Scan not found: {scan_id}"}, status=404)
                return
            self.send_json({"status": "ok", "scan": self._enrich_scan_urls(scan, share_token)})
            return

        # 5. Smart Priority Queue Status (with Live PIX4Dmatic Log Progress & Tail)
        if path == "/api/queue/status":
            sync_scans_with_filesystem()
            if share_token:
                self.send_json({"error": "Queue status restricted to internal company users."}, status=403)
                return

            # Check if PIX4Dmatic.exe is actively running on Windows PC
            p4d_running = False
            if os.name == "nt":
                try:
                    import subprocess as _sp
                    tr = _sp.run(
                        ["tasklist", "/FI", "IMAGENAME eq PIX4Dmatic.exe", "/NH"],
                        capture_output=True,
                        text=True,
                        timeout=3,
                    )
                    p4d_running = "PIX4Dmatic.exe" in (tr.stdout or "")
                except Exception:
                    p4d_running = False

            all_scans = DB.list_scans()
            active_proc_ids = {s["scan_id"] for s in all_scans if s.get("status") == "processing"}
            live_log_info: Dict[str, Any] = {}
            candidate_logs = []
            for s in all_scans:
                sid = s["scan_id"]
                pdir = s.get("project_dir") or os.path.join(LOCAL_SCANS_ROOT, sid)
                log_dirs = [
                    os.path.join(pdir, sid, "logs"),
                    os.path.join(pdir, "project", "logs"),
                    os.path.join(LOCAL_SCANS_ROOT, sid, sid, "logs"),
                ]
                for candidate_dir in log_dirs:
                    if os.path.isdir(candidate_dir):
                        for f in os.listdir(candidate_dir):
                            if f.lower().endswith(".txt"):
                                full_lp = os.path.join(candidate_dir, f)
                                mtime = os.path.getmtime(full_lp)
                                if s.get("status") == "processing" or (p4d_running and (time.time() - mtime < 1800.0)):
                                    is_proc_bonus = 1 if sid in active_proc_ids else 0
                                    candidate_logs.append((mtime, is_proc_bonus, s, full_lp))

            if candidate_logs:
                candidate_logs.sort(key=lambda x: (x[0], x[1]))
                latest_mtime, _, active_scan, latest_log = candidate_logs[-1]
                sid = active_scan["scan_id"]

                info = parse_pix4dmatic_log_progress(latest_log)
                from pc_worker.pix4d_runner import get_live_system_cpu_ram
                _, _, live_os_cpu_ram = get_live_system_cpu_ram()
                log_age_s = time.time() - latest_mtime

                # Only show active PIX4Dmatic monitor if PIX4Dmatic.exe is actually running (or log updated within last 45s)
                if p4d_running or (active_scan.get("status") == "processing" and not info.get("is_finished") and log_age_s < 45.0):
                    stage_name = info.get("stage", "Processing")
                    cpu_ram = live_os_cpu_ram or info.get("cpu_ram", "")
                    est_pct = float(info.get("progress_pct", 12.0))
                    new_label = (
                        f"PIX4Dmatic: {stage_name} ({cpu_ram})"
                        if stage_name and cpu_ram
                        else f"PIX4Dmatic: {stage_name}"
                    )
                    active_scan["status"] = "processing"
                    active_scan["progress_pct"] = est_pct
                    active_scan["stage_label"] = new_label
                    DB.update_job_progress(sid, "processing", est_pct, new_label)
                    for other_s in all_scans:
                        if other_s["scan_id"] != sid and other_s.get("status") == "processing":
                            other_s["status"] = "queued"
                            other_s["progress_pct"] = 0.0
                            other_s["stage_label"] = "Queued for PIX4Dmatic"
                            DB.update_job_progress(other_s["scan_id"], "queued", 0.0, "Queued for PIX4Dmatic")
                    live_log_info = {
                        "scan_id": sid,
                        "scan_name": active_scan.get("name") or sid,
                        "log_path": latest_log,
                        "stage": stage_name,
                        "cpu_ram": cpu_ram,
                        "progress_pct": est_pct,
                        "tail_lines": info.get("tail_lines", [])[-10:],
                    }
                elif not p4d_running and active_scan.get("status") == "processing" and log_age_s >= 45.0:
                    # PIX4Dmatic.exe stopped before finishing: re-queue if no tileset exists yet so worker resumes it cleanly
                    ts_chk = active_scan.get("tileset_path") or ""
                    if not (ts_chk and os.path.isfile(ts_chk)):
                        active_scan["status"] = "queued"
                        active_scan["progress_pct"] = 0.0
                        active_scan["stage_label"] = "Queued (Resuming interrupted PIX4Dmatic job)"
                        DB.update_job_progress(sid, "queued", 0.0, "Queued (Resuming interrupted PIX4Dmatic job)")

            queued = [s for s in all_scans if s["status"] in ("queued", "waiting_parts")]
            queued.sort(key=lambda x: (0 if x["status"] == "queued" else 1, -float(x["priority_score"]), float(x["uploaded_at"])))
            processing = [s for s in all_scans if s["status"] == "processing"]
            completed = [s for s in all_scans if s["status"] == "completed"]
            p4d_cfg = load_pix4d_settings()
            self.send_json(
                {
                    "status": "ok",
                    "inbox_dir": GDRIVE_INPUTS_DIR,
                    "crs_enforced": TWD97_TWVD2001_LABEL,
                    "texture_size_enforced": p4d_cfg.get("texture_size", PIX4DMATIC_TEXTURE_SIZE),
                    "pix4d_settings": p4d_cfg,
                    "processing": processing,
                    "queued": queued,
                    "all_scans": all_scans,
                    "live_pix4d": live_log_info,
                    "completed_count": len(completed),
                    "gchat_webhook_url": GCHAT.get_webhook_url(),
                }
            )
            return

        if path == "/api/pix4d/settings":
            self.send_json({"status": "ok", "settings": load_pix4d_settings()})
            return

        # 6. GC_ScanOptimizer Presets & Backup Status
        if path == "/api/optimizer/presets":
            self.send_json({"status": "ok", "presets": OPTIMIZER.get_presets()})
            return

        if path == "/api/optimizer/backup-status":
            scan_id = (query.get("scan_id") or [""])[0].strip()
            self.send_json({"status": "ok", "scan_id": scan_id, **OPTIMIZER.get_backup_status(scan_id)})
            return

        if path == "/api/optimizer/crs-catalog":
            self.send_json({"status": "ok", "crs_catalog": OPTIMIZER.get_crs_catalog()})
            return

        # 6b. Saved AI Surface & Object Categorization Retrieval (GET /api/survey/categorize?scan_id=...)
        if path in ("/api/survey/categorize", "/api/surveying/categorize"):
            scan_id = (query.get("scan_id") or [""])[0].strip()
            if not scan_id:
                self.send_json({"error": "Missing required parameter: scan_id"}, status=400)
                return
            if share_token:
                ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(share_token, requested_scan_id=scan_id)
                if not ok_s or not (link_s and link_s.get("allow_measurements", True)):
                    self.send_json({"error": "Surface categorization is disabled for this external share link."}, status=403)
                    return
            saved_cat = SURVEY.get_saved_categorization(scan_id)
            if isinstance(saved_cat, dict) and saved_cat.get("status") == "ok":
                self.send_json(saved_cat)
            else:
                self.send_json(
                    {
                        "ok": True,
                        "status": "not_cached",
                        "has_categorization": False,
                        "saved_on_server": False,
                        "overlay_visible_default": False,
                        "scan_id": scan_id,
                    }
                )
            return

        # 7. External Share Links Management
        if path == "/api/share/list":
            if share_token:
                self.send_json({"error": "Forbidden for external guest token"}, status=403)
                return
            local_links = AUTH_SHARE.list_share_links()
            if os.name != "nt":
                by_tok = {str(l.get("token")): l for l in (_load_cloud_manifest().get("share_links") or []) if l.get("token")}
                for ll in local_links:
                    if ll.get("token"):
                        by_tok[str(ll["token"])] = ll
                merged_links = sorted(by_tok.values(), key=lambda x: str(x.get("created_at") or ""), reverse=True)
                self.send_json({"status": "ok", "links": merged_links})
                return
            self.send_json({"status": "ok", "links": local_links})
            return

        if path == "/api/share/verify":
            tok = query.get("token", [share_token])[0]
            scan_id = query.get("scan_id", [None])[0]
            ok, reason, link, allowed = AUTH_SHARE.validate_share_access(tok, requested_scan_id=scan_id)
            if not ok and os.name != "nt" and tok:
                ok, reason, link, allowed = self._validate_cloud_share_token(tok, requested_scan_id=scan_id)
            if not ok:
                self.send_json({"status": "denied", "error": reason, "link": link}, status=403)
                return
            self.send_json(
                {
                    "status": "ok",
                    "link": link,
                    "allowed_scan_ids": [s["scan_id"] for s in allowed],
                }
            )
            return

        # 8. Google Chat Notification History
        if path == "/api/gchat/history":
            self.send_json({"status": "ok", "notifications": GCHAT.list_notifications()})
            return

        # 9. User-Specific Offline Cache Settings & User Profiles (GatheringCloud OAuth Gate)
        if path == "/api/user/settings":
            email = (
                (query.get("email") or query.get("user_email") or [None])[0]
                or self.headers.get("X-User-Email")
                or "guest@anonymous"
            )
            self.send_json({"status": "ok", "settings": DB.get_user_settings(str(email).strip().lower())})
            return

        if path == "/api/admin/pc-daemon":
            if share_token:
                self.send_json({"error": "Forbidden for external guest link"}, status=403)
                return
            self.send_json(get_pc_daemon_status())
            return

        if path in ("/api/user-profiles", "/api/admin/users"):
            profiles = []
            for p in AUTH_SHARE.list_user_profiles():
                r_norm = normalize_role(p.get("role"), email=p.get("email", ""))
                profiles.append(
                    {
                        **p,
                        "role": r_norm,
                        "role_level": ROLE_LEVELS.get(r_norm, 2),
                        "role_label": ROLE_LABELS.get(r_norm, "Viewer"),
                        "permissions": get_role_permissions(r_norm),
                    }
                )
            self.send_json(
                {
                    "status": "ok",
                    "profiles": profiles,
                    "users": profiles,
                    "roles_catalog": [
                        {"role": k, "level": v, "label": ROLE_LABELS[k], "permissions": get_role_permissions(k)}
                        for k, v in sorted(ROLE_LEVELS.items(), key=lambda x: -x[1])
                    ],
                    "google_client_id": GOOGLE_OAUTH_CLIENT_ID,
                }
            )
            return

        # 10. Client-Side Offline Cache Manifest for a Scan
        if path.startswith("/api/cache/manifest/"):
            scan_id = path[len("/api/cache/manifest/") :].strip("/")
            if share_token:
                ok, reason, _, _ = AUTH_SHARE.validate_share_access(share_token, requested_scan_id=scan_id)
                if not ok:
                    self.send_json({"error": reason}, status=403)
                    return
            scan = DB.get_scan(scan_id)
            if not scan:
                self.send_json({"error": "Scan not found"}, status=404)
                return
            ts_path = scan.get("tileset_path") or ""
            urls = []
            if ts_path.lower().endswith(".glb") and os.path.isfile(ts_path):
                urls.append(f"/stream/{scan_id}/{os.path.basename(ts_path)}")
            elif os.path.isfile(ts_path):
                urls.append(f"/stream/{scan_id}/tileset.json")
                ts_dir = os.path.dirname(ts_path)
                prev_json = os.path.join(ts_dir, "preview_tileset.json")
                if os.path.isfile(prev_json):
                    urls.append(f"/stream/{scan_id}/preview_tileset.json")
                tiles_dir = os.path.join(ts_dir, "tiles")
                if os.path.isdir(tiles_dir):
                    for fn in sorted(os.listdir(tiles_dir)):
                        if fn == "root.glb" or fn.startswith("tile_l1_") or fn.startswith("tile_l2_"):
                            urls.append(f"/stream/{scan_id}/tiles/{fn}")
                subtrees_dir = os.path.join(ts_dir, "subtrees")
                if os.path.isdir(subtrees_dir):
                    for r_st, _, st_files in os.walk(subtrees_dir, followlinks=True):
                        rel_st = os.path.relpath(r_st, ts_dir).replace("\\", "/")
                        for fn in sorted(st_files)[:64]:
                            if fn.endswith(".subtree"):
                                urls.append(f"/stream/{scan_id}/{rel_st}/{fn}")
                for content_sub in ("preview_low/content", "content"):
                    c_dir = os.path.join(ts_dir, *content_sub.split("/"))
                    if os.path.isdir(c_dir):
                        c_files = sorted(f for f in os.listdir(c_dir) if f.lower().endswith(".glb"))
                        # For massive Cesium octrees (>200 tiles), cache coarse levels (0..4) + preview_low so offline load succeeds cleanly
                        if content_sub == "content" and len(c_files) > 200:
                            c_files = [f for f in c_files if f.split("_", 1)[0] in {"0", "1", "2", "3", "4"}][:200]
                        for fn in c_files:
                            urls.append(f"/stream/{scan_id}/{content_sub}/{fn}")
            self.send_json(
                {
                    "status": "ok",
                    "scan_id": scan_id,
                    "scan": self._enrich_scan_urls(scan, share_token),
                    "asset_urls": urls,
                }
            )
            return

        # 11. Stream 3D Tilesets & GLB Chunks Directly from Windows PC Hard Drive
        if path.startswith("/stream/"):
            if PC_SIMULATED_OFFLINE:
                self.send_json(
                    {
                        "error": "Processing PC is currently offline. Serving from Client-Side Browser Cache if enabled.",
                        "pc_online": False,
                    },
                    status=503,
                )
                return

            rel = path[len("/stream/") :]
            parts = rel.split("/", 1)
            if len(parts) < 2:
                self.send_json({"error": "Invalid stream path"}, status=400)
                return
            scan_id, sub_path = parts[0], parts[1]

            if share_token:
                ok, reason, _, _ = AUTH_SHARE.validate_share_access(share_token, requested_scan_id=scan_id)
                if not ok:
                    self.send_json({"error": reason}, status=403)
                    return

            scan = DB.get_scan(scan_id)
            if not scan:
                self.send_json({"error": f"Scan not found: {scan_id}"}, status=404)
                return

            ts_path = scan.get("tileset_path") or ""
            if sub_path in ("preview_tileset.json", "preview_low.glb") and os.path.isfile(ts_path):
                base_dir = os.path.dirname(ts_path)
                prev_target = os.path.join(base_dir, sub_path)
                if not os.path.isfile(prev_target):
                    try:
                        from pc_worker.preview_generator import ensure_scan_low_quality_preview

                        ensure_scan_low_quality_preview(ts_path, force=False)
                    except Exception:
                        pass
                if os.path.isfile(prev_target):
                    self._serve_file_with_range(prev_target)
                    return
                if sub_path == "preview_tileset.json":
                    self._serve_optimized_tileset_json(ts_path)
                    return
            if sub_path == "tileset.json" and os.path.isfile(ts_path):
                if query.get("full_octree", ["0"])[0] == "1":
                    self._serve_file_with_range(ts_path)
                else:
                    self._serve_optimized_tileset_json(ts_path)
                return
            base_dir = os.path.dirname(ts_path) if os.path.isfile(ts_path) else ts_path
            safe_sub = os.path.normpath(sub_path).lstrip("\\/")
            target_file = os.path.join(base_dir, safe_sub)
            if not os.path.abspath(target_file).startswith(os.path.abspath(base_dir)):
                self.send_json({"error": "Forbidden path traversal"}, status=403)
                return
            self._serve_file_with_range(target_file)
            return

        # 12. Download Real Raw .OBJ Mesh or Report from Windows PC
        if path == "/api/download":
            scan_id = (query.get("scan_id", [""])[0] or "").strip()
            if not scan_id:
                self.send_json({"error": "Missing scan_id parameter"}, status=400)
                return
            dtype = query.get("type", ["obj"])[0]
            if share_token:
                ok, reason, link, _ = AUTH_SHARE.validate_share_access(
                    share_token, requested_scan_id=scan_id
                )
                if not ok:
                    self.send_json({"error": reason}, status=403)
                    return
                if link and not link.get("allow_download", False):
                    self.send_json({"error": "Downloads are disabled for this external share link."}, status=403)
                    return
            else:
                _, _, actor_perms_dl = self._resolve_request_role(query=query, share_token=share_token)
                if not actor_perms_dl.get("can_download", False):
                    self.send_json({"error": "Downloads are disabled in Guest Mode. Sign in with Google to download .OBJ meshes."}, status=403)
                    return

            scan = DB.get_scan(scan_id)
            if not scan:
                self.send_json({"error": "Scan not found"}, status=404)
                return

            crs_upper = str(scan.get("crs") or "").upper()
            crs_tag = "LocalOrigin" if "LOCAL" in crs_upper else ("UTM" if "UTM" in crs_upper else "TWD97_TWVD2001")
            dl_obj_name = f"{scan_id}_{crs_tag}.obj"
            dtype_norm = str(dtype or "obj").strip().lower()

            ts_path_check = scan.get("tileset_path") or ""
            ts_mtime = os.path.getmtime(ts_path_check) if ts_path_check and os.path.isfile(ts_path_check) else 0.0
            proj_dir = scan.get("project_dir") or os.path.join(LOCAL_SCANS_ROOT, scan_id)
            if os.path.islink(proj_dir) or getattr(os.path, "isjunction", lambda p: False)(proj_dir):
                proj_dir = os.path.join(LOCAL_SCANS_ROOT, scan_id)
            conv_dir = os.path.join(proj_dir, "exports")
            os.makedirs(conv_dir, exist_ok=True)
            obj_path = SURVEY._resolve_scan_obj_path(scan)

            # A. Download .3tz (3D Tiles Archive Package)
            if dtype_norm in ("3tz", "t3z"):
                dl_3tz_name = f"{scan_id}_{crs_tag}.3tz"
                try:
                    from pc_worker.gdrive_cloud_sync import build_scan_3tz_package

                    pkg_info = build_scan_3tz_package(scan, force=False)
                    if pkg_info and pkg_info.get("pkg_path") and os.path.isfile(pkg_info["pkg_path"]):
                        self._serve_file_with_range(
                            pkg_info["pkg_path"],
                            content_type="application/octet-stream",
                            download_name=dl_3tz_name,
                        )
                        return
                except Exception as _e3tz:
                    print(f"[GatheringScans] .3tz package build note for {scan_id}: {_e3tz}")
                local_3tz = os.path.join(conv_dir, f"{scan_id}.3tz")
                if not os.path.isfile(local_3tz) or (ts_mtime > 0 and os.path.getmtime(local_3tz) < ts_mtime):
                    try:
                        import zipfile as _zf

                        with _zf.ZipFile(local_3tz, "w", compression=_zf.ZIP_STORED) as _z:
                            if ts_path_check and os.path.isfile(ts_path_check):
                                _bdir_z = os.path.dirname(ts_path_check)
                                for _root_z, _, _files_z in os.walk(_bdir_z):
                                    for _fn_z in _files_z:
                                        if _fn_z.lower().endswith((".json", ".glb", ".png", ".jpg", ".xyz")):
                                            _fp_z = os.path.join(_root_z, _fn_z)
                                            _rel_z = os.path.relpath(_fp_z, _bdir_z).replace("\\", "/")
                                            _z.write(_fp_z, _rel_z)
                    except Exception as _ez:
                        print(f"[GatheringScans] Local .3tz fallback error for {scan_id}: {_ez}")
                if os.path.isfile(local_3tz):
                    self._serve_file_with_range(
                        local_3tz,
                        content_type="application/octet-stream",
                        download_name=dl_3tz_name,
                    )
                    return

            # B. Download .glb (Self-Contained Binary glTF 2.0 3D Model with Embedded Textures)
            if dtype_norm == "glb":
                dl_glb_name = f"{scan_id}_{crs_tag}.glb"
                conv_glb = os.path.join(conv_dir, f"{scan_id}_export_v1.glb")
                if not os.path.isfile(conv_glb) or (ts_mtime > 0 and os.path.getmtime(conv_glb) < ts_mtime):
                    try:
                        import subprocess as _sp
                        from pc_worker.surveying_engine import GLTFPACK_EXE

                        leaf_glbs_dl = []
                        if ts_path_check and ts_path_check.lower().endswith(".glb") and os.path.isfile(ts_path_check):
                            leaf_glbs_dl = [ts_path_check]
                        elif ts_path_check and os.path.isfile(ts_path_check):
                            _bdir_g = os.path.dirname(ts_path_check)
                            with open(ts_path_check, "r", encoding="utf-8") as _gfh:
                                _gtso = json.load(_gfh)
                            _groot = _gtso.get("root") or {}
                            _grc = ((_groot.get("content") or {}).get("uri") or "").split("?")[0]
                            _grf = os.path.join(_bdir_g, _grc) if _grc else ""
                            if _grf and os.path.isfile(_grf) and os.path.getsize(_grf) >= 800_000:
                                leaf_glbs_dl = [_grf]
                            else:
                                def _walk_g_dl(node: dict, depth: int = 0):
                                    _cu = ((node.get("content") or {}).get("uri") or "").split("?")[0]
                                    if _cu:
                                        _cf = os.path.join(_bdir_g, _cu)
                                        if os.path.isfile(_cf):
                                            leaf_glbs_dl.append(_cf)
                                            return
                                    if depth < 3:
                                        for _ch in node.get("children") or []:
                                            if isinstance(_ch, dict):
                                                _walk_g_dl(_ch, depth + 1)
                                _walk_g_dl(_groot, 0)
                        if not leaf_glbs_dl:
                            leaf_glbs_dl = SURVEY._collect_scan_glb_files(scan)[:8]

                        if len(leaf_glbs_dl) == 1 and os.path.isfile(GLTFPACK_EXE):
                            _sp.run([GLTFPACK_EXE, "-i", leaf_glbs_dl[0], "-o", conv_glb, "-noq"], capture_output=True, timeout=45)
                        elif len(leaf_glbs_dl) >= 1:
                            c_bvs, c_accs, c_imgs, c_texs, c_mats, c_prims = [], [], [], [], [], []
                            c_bin = bytearray()
                            for _gfp in leaf_glbs_dl:
                                _tmp_g = os.path.join(conv_dir, f"_tmp_dl_{os.path.basename(_gfp)}")
                                _read_g = _gfp
                                if os.path.isfile(GLTFPACK_EXE):
                                    _sp.run([GLTFPACK_EXE, "-i", _gfp, "-o", _tmp_g, "-noq"], capture_output=True, timeout=45)
                                    if os.path.isfile(_tmp_g):
                                        _read_g = _tmp_g
                                try:
                                    with open(_read_g, "rb") as _rfg:
                                        _raw_g = _rfg.read()
                                finally:
                                    if os.path.isfile(_tmp_g):
                                        try:
                                            os.remove(_tmp_g)
                                        except OSError:
                                            pass
                                if len(_raw_g) < 28 or _raw_g[:4] != b"glTF":
                                    continue
                                _jlen_g = struct.unpack_from("<I", _raw_g, 12)[0]
                                _jg = json.loads(_raw_g[20 : 20 + _jlen_g].decode("utf-8"))
                                _boff_g = 20 + _jlen_g
                                _blen_g = struct.unpack_from("<I", _raw_g, _boff_g)[0]
                                _blob_g = _raw_g[_boff_g + 8 : _boff_g + 8 + _blen_g]
                                _base_off = len(c_bin)
                                c_bin.extend(_blob_g)
                                while len(c_bin) % 4:
                                    c_bin.append(0)
                                _bv_base = len(c_bvs)
                                for _bv in _jg.get("bufferViews") or []:
                                    _nbv = dict(_bv)
                                    _nbv["buffer"] = 0
                                    _nbv["byteOffset"] = int(_bv.get("byteOffset", 0)) + _base_off
                                    c_bvs.append(_nbv)
                                _acc_base = len(c_accs)
                                for _acc in _jg.get("accessors") or []:
                                    _nacc = dict(_acc)
                                    if "bufferView" in _nacc:
                                        _nacc["bufferView"] = int(_nacc["bufferView"]) + _bv_base
                                    c_accs.append(_nacc)
                                _mat_idx = len(c_mats)
                                _imgs = _jg.get("images") or []
                                if _imgs:
                                    _img_idx = len(c_imgs)
                                    _nimg = dict(_imgs[0])
                                    if "bufferView" in _nimg:
                                        _nimg["bufferView"] = int(_nimg["bufferView"]) + _bv_base
                                    c_imgs.append(_nimg)
                                    _tex_idx = len(c_texs)
                                    c_texs.append({"source": _img_idx})
                                    c_mats.append(
                                        {
                                            "pbrMetallicRoughness": {
                                                "baseColorTexture": {"index": _tex_idx},
                                                "metallicFactor": 0.0,
                                                "roughnessFactor": 1.0,
                                            },
                                            "doubleSided": True,
                                        }
                                    )
                                else:
                                    c_mats.append({"doubleSided": True})
                                for _gm in _jg.get("meshes") or []:
                                    for _gp in _gm.get("primitives") or []:
                                        _np_prim = {
                                            "attributes": {k: int(v) + _acc_base for k, v in (_gp.get("attributes") or {}).items()},
                                            "material": _mat_idx,
                                        }
                                        if "indices" in _gp:
                                            _np_prim["indices"] = int(_gp["indices"]) + _acc_base
                                        if "mode" in _gp:
                                            _np_prim["mode"] = _gp["mode"]
                                        c_prims.append(_np_prim)
                            if c_prims:
                                _cj = {
                                    "asset": {"version": "2.0", "generator": "GatheringScans GLB Exporter"},
                                    "scene": 0,
                                    "scenes": [{"nodes": [0]}],
                                    "nodes": [{"mesh": 0}],
                                    "meshes": [{"primitives": c_prims}],
                                    "materials": c_mats,
                                    "textures": c_texs,
                                    "images": c_imgs,
                                    "accessors": c_accs,
                                    "bufferViews": c_bvs,
                                    "buffers": [{"byteLength": len(c_bin)}],
                                }
                                _jb = json.dumps(_cj, separators=(",", ":")).encode("utf-8")
                                while len(_jb) % 4:
                                    _jb += b" "
                                _tot = 12 + 8 + len(_jb) + 8 + len(c_bin)
                                with open(conv_glb, "wb") as _fgo:
                                    _fgo.write(struct.pack("<4sII", b"glTF", 2, _tot))
                                    _fgo.write(struct.pack("<I4s", len(_jb), b"JSON"))
                                    _fgo.write(_jb)
                                    _fgo.write(struct.pack("<I4s", len(c_bin), b"BIN\x00"))
                                    _fgo.write(c_bin)
                    except Exception as _eglb:
                        print(f"[GatheringScans] GLB export error for {scan_id}: {_eglb}")
                if os.path.isfile(conv_glb):
                    self._serve_file_with_range(conv_glb, content_type="model/gltf-binary", download_name=dl_glb_name)
                    return

            # C. Download .zip (Textured .OBJ + .MTL + .JPG Textures + offset.xyz Bundle)
            if dtype_norm in ("zip", "obj_zip"):
                dl_zip_name = f"{scan_id}_{crs_tag}_OBJ_Textured.zip"
                conv_zip = os.path.join(conv_dir, f"{scan_id}_obj_textured_v1.zip")
                if not os.path.isfile(conv_zip) or (ts_mtime > 0 and os.path.getmtime(conv_zip) < ts_mtime):
                    try:
                        import zipfile as _zf

                        obj_dir_z = os.path.dirname(obj_path) if (obj_path and os.path.isfile(obj_path)) else ""
                        if obj_dir_z and os.path.isdir(obj_dir_z):
                            with _zf.ZipFile(conv_zip, "w", compression=_zf.ZIP_STORED) as _z:
                                for _fn_o in sorted(os.listdir(obj_dir_z)):
                                    _fp_o = os.path.join(obj_dir_z, _fn_o)
                                    if os.path.isfile(_fp_o) and _fn_o.lower().endswith((".obj", ".mtl", ".jpg", ".jpeg", ".png", ".xyz")):
                                        _z.write(_fp_o, _fn_o)
                    except Exception as _ezip:
                        print(f"[GatheringScans] Textured OBJ ZIP error for {scan_id}: {_ezip}")
                if os.path.isfile(conv_zip):
                    self._serve_file_with_range(conv_zip, content_type="application/zip", download_name=dl_zip_name)
                    return

            if dtype_norm == "obj" and obj_path and os.path.isfile(obj_path):
                # Only serve raw obj_path directly if it is already in world coordinates (no non-zero offset.xyz) and not older than tileset edits
                raw_obj_ok = ts_mtime <= os.path.getmtime(obj_path) + 2.0
                off_file = os.path.join(os.path.dirname(obj_path), "offset.xyz")
                if raw_obj_ok and os.path.isfile(off_file):
                    try:
                        with open(off_file, "r", encoding="utf-8") as _ofh:
                            _oparts = [float(x) for x in _ofh.read().strip().split()[:3]]
                        if len(_oparts) == 3 and any(abs(v) > 1e-3 for v in _oparts):
                            raw_obj_ok = False
                    except Exception:
                        raw_obj_ok = False
                if raw_obj_ok:
                    self._serve_file_with_range(obj_path, download_name=dl_obj_name)
                    return

            # Convert ALL leaf .glb tiles (with accumulated 4x4 tile transforms) into a world-georeferenced .obj on disk
            conv_obj = os.path.join(conv_dir, f"{scan_id}_world_export_v3.obj")
            if not os.path.isfile(conv_obj) or (ts_mtime > 0 and os.path.getmtime(conv_obj) < ts_mtime):
                # Fast path: if raw obj_path + offset.xyz exist and are up to date, shift vertices by offset.xyz in ~1.5s preserving UVs/materials
                if obj_path and os.path.isfile(obj_path) and (ts_mtime <= os.path.getmtime(obj_path) + 2.0):
                    try:
                        import io as _io
                        import numpy as _np

                        off_file_fast = os.path.join(os.path.dirname(obj_path), "offset.xyz")
                        ox_f, oy_f, oz_f = 0.0, 0.0, 0.0
                        if os.path.isfile(off_file_fast):
                            _op_f = [float(x) for x in open(off_file_fast, "r", encoding="utf-8").read().strip().split()[:3]]
                            if len(_op_f) == 3:
                                ox_f, oy_f, oz_f = _op_f[0], _op_f[1], _op_f[2]
                        with open(obj_path, "r", encoding="utf-8", errors="ignore") as _of_in:
                            _olines = _of_in.read().splitlines()
                        _v_lns = [ln[2:] for ln in _olines if ln.startswith("v ")]
                        _tail_lns = [ln for ln in _olines if not ln.startswith("v ")]
                        if _v_lns:
                            _v_arr = _np.fromstring(" ".join(_v_lns), sep=" ", dtype=_np.float64).reshape(-1, 3) + _np.array([ox_f, oy_f, oz_f], dtype=_np.float64)
                            _v_buf = _io.BytesIO()
                            _np.savetxt(_v_buf, _v_arr, fmt="v %.4f %.4f %.4f", newline="\n")
                            with open(conv_obj, "wb") as _of_out:
                                if _tail_lns and _tail_lns[0].startswith("mtllib "):
                                    _of_out.write((_tail_lns[0] + "\n").encode("utf-8"))
                                    _tail_lns = _tail_lns[1:]
                                _of_out.write(_v_buf.getvalue())
                                if _tail_lns:
                                    _of_out.write(("\n".join(_tail_lns) + "\n").encode("utf-8"))
                    except Exception as _fe:
                        print(f"[GatheringScans] Fast OBJ shift note for {scan_id}: {_fe}")

            if not os.path.isfile(conv_obj) or (ts_mtime > 0 and os.path.getmtime(conv_obj) < ts_mtime):
                try:
                    import numpy as _np
                    import trimesh
                    import subprocess as _sp
                    from pc_worker.surveying_engine import GLTFPACK_EXE

                    glb_entries = []
                    has_root_tf = False
                    up_axis = ""
                    if ts_path_check and ts_path_check.lower().endswith(".json") and os.path.isfile(ts_path_check):
                        with open(ts_path_check, "r", encoding="utf-8") as _tfh:
                            _ts_obj = json.load(_tfh)
                        up_axis = str((_ts_obj.get("asset") or {}).get("gltfUpAxis") or "").upper().strip()
                        has_root_tf = bool((_ts_obj.get("root") or {}).get("transform"))
                        _ts_base = os.path.dirname(ts_path_check)
                        _r_glb = os.path.join(_ts_base, "tiles", "root.glb")

                        def _walk_dl_leaves(node, p_tf, out_l):
                            c_tf = p_tf
                            ntf = node.get("transform")
                            if isinstance(ntf, list) and len(ntf) == 16:
                                c_tf = p_tf @ _np.array(ntf, dtype=_np.float64).reshape((4, 4), order="F")
                            ch_list = [c for c in (node.get("children") or []) if isinstance(c, dict)]
                            if ch_list:
                                for ch in ch_list:
                                    _walk_dl_leaves(ch, c_tf, out_l)
                            else:
                                uri = ((node.get("content") or {}).get("uri") or (node.get("content") or {}).get("url") or "")
                                if uri and "{level}" not in uri:
                                    cp = os.path.normpath(os.path.join(_ts_base, uri))
                                    if os.path.isfile(cp):
                                        out_l.append((cp, c_tf))

                        if os.path.isfile(_r_glb):
                            _rtf_l = (_ts_obj.get("root") or {}).get("transform")
                            _rtf_m = _np.array(_rtf_l, dtype=_np.float64).reshape((4, 4), order="F") if (isinstance(_rtf_l, list) and len(_rtf_l) == 16) else _np.eye(4, dtype=_np.float64)
                            glb_entries = [(_r_glb, _rtf_m)]
                        elif isinstance(_ts_obj.get("root"), dict):
                            _walk_dl_leaves(_ts_obj["root"], _np.eye(4, dtype=_np.float64), glb_entries)
                            if not glb_entries:
                                _prev_p = os.path.join(_ts_base, "preview_tileset.json")
                                if os.path.isfile(_prev_p):
                                    with open(_prev_p, "r", encoding="utf-8") as _pfh:
                                        _pts = json.load(_pfh)
                                    if isinstance(_pts.get("root"), dict):
                                        _walk_dl_leaves(_pts["root"], _np.eye(4, dtype=_np.float64), glb_entries)
                    if not glb_entries:
                        for gf_fb in SURVEY._collect_scan_glb_files(scan):
                            glb_entries.append((gf_fb, _np.eye(4, dtype=_np.float64)))

                    apply_y_to_z = (up_axis == "Y") or (up_axis == "" and has_root_tf)
                    meshes = []
                    for gf, tile_tf in glb_entries:
                        load_target = gf
                        tmp_gf = None
                        m = None
                        try:
                            loaded = trimesh.load(load_target, process=False)
                            m = loaded.to_geometry() if hasattr(loaded, "to_geometry") else (loaded.dump(concatenate=True) if isinstance(loaded, trimesh.Scene) else loaded)
                            if not hasattr(m, "vertices") or len(m.vertices) == 0:
                                raise ValueError("Empty GLB")
                        except Exception:
                            if os.path.isfile(GLTFPACK_EXE):
                                tmp_gf = os.path.join(conv_dir, f"_tmp_{os.path.basename(gf)}")
                                _sp.run([GLTFPACK_EXE, "-i", gf, "-o", tmp_gf, "-noq"], capture_output=True, timeout=45)
                                if os.path.isfile(tmp_gf):
                                    loaded = trimesh.load(tmp_gf, process=False)
                                    m = loaded.to_geometry() if hasattr(loaded, "to_geometry") else (loaded.dump(concatenate=True) if isinstance(loaded, trimesh.Scene) else loaded)
                        finally:
                            if tmp_gf and os.path.isfile(tmp_gf):
                                try:
                                    os.remove(tmp_gf)
                                except OSError:
                                    pass
                        if m is not None and hasattr(m, "vertices") and len(m.vertices) > 0:
                            verts = _np.asarray(m.vertices, dtype=_np.float64)
                            if apply_y_to_z:
                                verts = _np.column_stack([verts[:, 0], -verts[:, 2], verts[:, 1]])
                            verts = verts @ tile_tf[:3, :3].T + tile_tf[:3, 3]
                            m.vertices = verts
                            meshes.append(m)
                    if meshes:
                        combined = meshes[0] if len(meshes) == 1 else trimesh.util.concatenate(meshes)
                        combined.export(conv_obj, file_type="obj", include_texture=False)
                except Exception as e:
                    print(f"[GatheringScans] OBJ conversion error for {scan_id}: {e}")

            if os.path.isfile(conv_obj):
                self._serve_file_with_range(conv_obj, download_name=dl_obj_name)
                return

            self.send_json({"error": f"No mesh geometry found on disk for scan: {scan_id}"}, status=404)
            return

        # 13. Serve RTK Raw Camera Photo from Windows PC (or /cameras/<scan_id>/<file> route)
        if path == "/api/camera-photo" or path.startswith("/cameras/"):
            if path.startswith("/cameras/"):
                rel_cam = path[len("/cameras/") :].strip("/")
                parts_cam = rel_cam.split("/", 1)
                scan_id = parts_cam[0] if len(parts_cam) >= 1 else ""
                fname = os.path.basename(parts_cam[1]) if len(parts_cam) >= 2 else ""
            else:
                scan_id = query.get("scan_id", [""])[0]
                fname = os.path.basename(query.get("file", [""])[0])
            fpath = SURVEY.resolve_camera_photo_path(scan_id, fname) if fname else None
            if fpath and os.path.isfile(fpath):
                self._serve_file_with_range(fpath, content_type="image/jpeg")
                return
            self.send_json({"error": f"Camera photo not found on PC: {fname}"}, status=404)
            return

        # 14. Serve Generated Reports & Contours (.html, .csv, .pdf, .dxf, .dwg)
        if path.startswith("/api/reports/"):
            if share_token:
                ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(share_token)
                if not ok_s:
                    self.send_json({"error": reason_s}, status=403)
                    return
                if link_s and not link_s.get("allow_download", False):
                    self.send_json({"error": "Report downloads are disabled for this external share link."}, status=403)
                    return
            else:
                _, _, actor_perms_rep = self._resolve_request_role(query=query, share_token=share_token)
                if not actor_perms_rep.get("can_download", False):
                    self.send_json({"error": "Report downloads are disabled in Guest Mode."}, status=403)
                    return
            fname = os.path.basename(path[len("/api/reports/") :])
            fpath = os.path.join(REPORTS_DIR, fname)
            if not os.path.isfile(fpath) and os.path.isfile(os.path.join(CONTOURS_DIR, fname)):
                fpath = os.path.join(CONTOURS_DIR, fname)
            if not os.path.isfile(fpath) and fname.startswith("categorization_report_"):
                base_sid = re.sub(r"_\d{9,}$", "", os.path.splitext(fname[len("categorization_report_") :])[0])
                SURVEY.get_saved_categorization(base_sid)
            force_dl = query.get("download", ["0"])[0] == "1"
            dl = fname if (fname.endswith((".csv", ".dwg", ".dxf")) or force_dl) else None
            self._serve_file_with_range(fpath, download_name=dl)
            return

        if path.startswith("/api/contours/"):
            if share_token:
                ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(share_token)
                if not ok_s:
                    self.send_json({"error": reason_s}, status=403)
                    return
                if link_s and not link_s.get("allow_download", False):
                    self.send_json({"error": "CAD/Contour downloads are disabled for this external share link."}, status=403)
                    return
            else:
                _, _, actor_perms_cnt = self._resolve_request_role(query=query, share_token=share_token)
                if not actor_perms_cnt.get("can_download", False):
                    self.send_json({"error": "CAD/Contour downloads are disabled in Guest Mode."}, status=403)
                    return
            fname = os.path.basename(path[len("/api/contours/") :])
            fpath = os.path.join(CONTOURS_DIR, fname)
            if not os.path.isfile(fpath) and os.path.isfile(os.path.join(REPORTS_DIR, fname)):
                fpath = os.path.join(REPORTS_DIR, fname)
            if not os.path.isfile(fpath) and fname.startswith("Civil3D_Categorized_"):
                base_sid = re.sub(r"_\d{9,}$", "", os.path.splitext(fname[len("Civil3D_Categorized_") :])[0])
                SURVEY.get_saved_categorization(base_sid)
            self._serve_file_with_range(fpath, download_name=fname)
            return

        # 15. Serve Static Frontend Files from web/
        if path == "/" or path == "":
            rel_web = "index.html"
        else:
            rel_web = path.lstrip("/")
        web_target = os.path.join(WEB_DIR, os.path.normpath(rel_web))
        if os.path.isfile(web_target) and os.path.abspath(web_target).startswith(os.path.abspath(WEB_DIR)):
            self._serve_file_with_range(web_target)
            return

        self.send_json({"error": f"Not found: {path}"}, status=404)

    def do_POST(self):
        global PC_SIMULATED_OFFLINE
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)
        share_token = self._extract_share_token(query)

        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length > 0 else b"{}"

        if path == "/api/cloud-manifest/upload-3tz":
            t_key = self.headers.get("X-Tunnel-Key", "")
            if t_key != TUNNEL_SHARED_KEY:
                self.send_json({"error": "Invalid X-Tunnel-Key"}, status=403)
                return
            scan_id = re.sub(r"[^a-zA-Z0-9_\-]", "", (query.get("scan_id") or [""])[0].strip())
            if not scan_id or not body:
                self.send_json({"error": "scan_id and binary body required"}, status=400)
                return
            target_dirs = [os.path.join(DATA_DIR, "stream_packages")]
            if os.path.isdir("/host_docker/gathering_scans/data"):
                target_dirs.insert(0, "/host_docker/gathering_scans/data/stream_packages")
            saved_paths = []
            for td in target_dirs:
                try:
                    os.makedirs(td, exist_ok=True)
                    dst = os.path.join(td, f"{scan_id}.3tz")
                    with open(dst, "wb") as f:
                        f.write(body)
                    saved_paths.append(dst)
                except Exception:
                    pass
            _VPS_RAM_FALLBACK_CACHE.clear()
            self.send_json({"status": "ok", "scan_id": scan_id, "bytes": len(body), "saved": saved_paths})
            return

        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except Exception as e:
            self.send_json({"error": f"Invalid JSON: {e}"}, status=400)
            return

        # 0. Google Drive .3tz Cloud Manifest Sync & Auth (handled directly on both VPS and PC)
        if path == "/api/cloud-manifest/sync":
            t_key = self.headers.get("X-Tunnel-Key", "")
            if t_key != TUNNEL_SHARED_KEY:
                self.send_json({"error": "Invalid X-Tunnel-Key"}, status=403)
                return
            if payload.get("share_links_only") and isinstance(payload.get("share_links"), list):
                m_cur = _load_cloud_manifest()
                by_t = {str(x.get("token")): x for x in payload["share_links"] if isinstance(x, dict) and x.get("token")}
                if os.name != "nt":
                    for lx in AUTH_SHARE.list_share_links():
                        if lx.get("token") and str(lx["token"]) not in by_t:
                            by_t[str(lx["token"])] = lx
                m_cur["share_links"] = sorted(
                    by_t.values(), key=lambda x: str(x.get("created_at") or ""), reverse=True
                )
                m_cur["updated_at"] = int(time.time())
                _save_cloud_manifest(m_cur)
                _VPS_RAM_FALLBACK_CACHE.clear()
                self.send_json({"status": "ok", "share_links_count": len(m_cur["share_links"])})
                return
            missing_vps_pkgs = []
            if isinstance(payload.get("manifest"), dict):
                m_in = payload["manifest"]
                if os.name != "nt":
                    by_t = {str(x.get("token")): x for x in (m_in.get("share_links") or []) if isinstance(x, dict) and x.get("token")}
                    for lx in AUTH_SHARE.list_share_links():
                        if lx.get("token") and str(lx["token"]) not in by_t:
                            by_t[str(lx["token"])] = lx
                    m_in["share_links"] = sorted(
                        by_t.values(), key=lambda x: str(x.get("created_at") or ""), reverse=True
                    )
                _save_cloud_manifest(m_in)
                _VPS_RAM_FALLBACK_CACHE.clear()
                pkgs_in = m_in.get("packages") or {}
                trashed_keep = {str(x) for x in (m_in.get("trashed_scan_ids") or []) if x}
                pkg_dirs = [os.path.join(DATA_DIR, "stream_packages")]
                if os.path.isdir("/host_docker/gathering_scans/data"):
                    pkg_dirs.insert(0, "/host_docker/gathering_scans/data/stream_packages")
                for pd in pkg_dirs:
                    if os.path.isdir(pd):
                        for fn in os.listdir(pd):
                            if fn.endswith(".3tz"):
                                sid_f = fn[:-4]
                                if sid_f not in pkgs_in and sid_f not in trashed_keep:
                                    try:
                                        os.remove(os.path.join(pd, fn))
                                    except OSError:
                                        pass
                primary_pd = pkg_dirs[0]
                os.makedirs(primary_pd, exist_ok=True)
                for sid_k, p_info in pkgs_in.items():
                    expected_sz = int((p_info or {}).get("size_bytes") or 0)
                    cand_f = os.path.join(primary_pd, f"{sid_k}.3tz")
                    if not os.path.isfile(cand_f) or (expected_sz > 0 and os.path.getsize(cand_f) != expected_sz):
                        missing_vps_pkgs.append(sid_k)
            if isinstance(payload.get("auth"), dict) and payload["auth"]:
                _save_cloud_auth(payload["auth"])
            st_resp = self._build_cloud_manifest_status()
            st_resp["missing_vps_packages"] = missing_vps_pkgs
            self.send_json(st_resp)
            return

        if path == "/api/cloud-manifest/auth":
            _, _, auth_perms = self._resolve_request_role(payload, query, share_token)
            if share_token or not auth_perms.get("can_manage_users"):
                self.send_json({"error": "Owner or Admin session required to modify cloud auth."}, status=403)
                return
            auth_update: Dict[str, Any] = {}
            if payload.get("access_token"):
                exp_in = float(payload.get("expires_in", 3500))
                auth_update["access_token"] = str(payload["access_token"]).strip()
                auth_update["expires_at"] = time.time() + exp_in
                auth_update["auth_mode"] = "oauth_token"
            if payload.get("oauth_refresh_token"):
                auth_update["oauth_refresh_token"] = str(payload["oauth_refresh_token"]).strip()
                if payload.get("oauth_client_secret"):
                    auth_update["oauth_client_secret"] = str(payload["oauth_client_secret"]).strip()
                auth_update["auth_mode"] = "oauth_refresh"
            if isinstance(payload.get("service_account"), dict):
                auth_update["service_account"] = payload["service_account"]
                auth_update["auth_mode"] = "service_account"
            elif isinstance(payload.get("service_account_json"), str) and payload["service_account_json"].strip():
                try:
                    sa_parsed = json.loads(payload["service_account_json"])
                    if isinstance(sa_parsed, dict) and sa_parsed.get("client_email"):
                        auth_update["service_account"] = sa_parsed
                        auth_update["auth_mode"] = "service_account"
                except Exception as e:
                    self.send_json({"error": f"Invalid Service Account JSON: {e}"}, status=400)
                    return

            if auth_update:
                _save_cloud_auth(auth_update)
                # If on Windows PC, push updated auth + manifest to VPS immediately
                if os.name == "nt":
                    try:
                        from pc_worker.gdrive_cloud_sync import sync_all_scans_to_gdrive_and_vps

                        m = sync_all_scans_to_gdrive_and_vps(DB, AUTH_SHARE, force=False)
                        _save_cloud_manifest(m)
                    except Exception as e:
                        print(f"[GatheringScans] Auth sync to VPS note: {e}")
            self.send_json(self._build_cloud_manifest_status())
            return

        if path == "/api/cloud-manifest/test-sa":
            _, _, sa_perms = self._resolve_request_role(payload, query, share_token)
            if share_token or not sa_perms.get("can_manage_users"):
                self.send_json({"error": "Owner or Admin session required to test cloud service account."}, status=403)
                return
            custom_sa = None
            if isinstance(payload.get("service_account"), dict):
                custom_sa = payload["service_account"]
            elif isinstance(payload.get("service_account_json"), str) and payload["service_account_json"].strip():
                try:
                    custom_sa = json.loads(payload["service_account_json"])
                except Exception as e:
                    self.send_json({"error": f"Invalid Service Account JSON: {e}"}, status=400)
                    return
            test_res = _test_gdrive_service_account(custom_sa=custom_sa)
            if custom_sa and os.name == "nt":
                try:
                    from pc_worker.gdrive_cloud_sync import sync_all_scans_to_gdrive_and_vps

                    m = sync_all_scans_to_gdrive_and_vps(DB, AUTH_SHARE, force=False)
                    _save_cloud_manifest(m)
                except Exception:
                    pass
            self.send_json(test_res)
            return

        if os.name != "nt" and path.startswith("/api/"):
            if path.startswith("/api/scans/") and path.endswith("/thumbnail"):
                try:
                    scan_id_vps = re.sub(r"[^a-zA-Z0-9_\-]", "", path[len("/api/scans/") : -len("/thumbnail")].strip("/"))
                    data_url_vps = str(payload.get("data_url", "")).strip()
                    if scan_id_vps and "," in data_url_vps:
                        raw_vps = base64.b64decode(data_url_vps.split(",", 1)[1])
                        os.makedirs(THUMBS_DIR, exist_ok=True)
                        with open(os.path.join(THUMBS_DIR, f"{scan_id_vps}.png"), "wb") as vf:
                            vf.write(raw_vps)
                        with open(os.path.join(THUMBS_DIR, f"{scan_id_vps.lower()}.png"), "wb") as vf2:
                            vf2.write(raw_vps)
                except Exception:
                    pass
            if self._proxy_via_pc_tunnel_if_vps("POST", path, body):
                return

        try:
            actor_email, actor_role, actor_perms = self._resolve_request_role(payload, query, share_token)

            # 0b. Rebuild & Sync .3tz Packages on Google Drive + Push Manifest to VPS
            if path == "/api/cloud-manifest/rebuild":
                if share_token or not actor_perms.get("can_manage_users"):
                    self.send_json({"error": "Owner or Admin session required to rebuild cloud packages."}, status=403)
                    return
                from pc_worker.gdrive_cloud_sync import sync_all_scans_to_gdrive_and_vps

                sync_scans_with_filesystem(force=True)
                manifest = sync_all_scans_to_gdrive_and_vps(
                    DB, AUTH_SHARE, force=bool(payload.get("force", False))
                )
                _save_cloud_manifest(manifest)
                status_obj = self._build_cloud_manifest_status()
                status_obj["vps_synced"] = bool(manifest.get("vps_synced", False))
                self.send_json(status_obj)
                return

            # 1. Simulate PC Online / Offline Mode (for testing Requirement 5)
            if path == "/api/pc/simulate-offline":
                if not actor_perms.get("can_manage_users"):
                    self.send_json({"error": "Owner or Admin session required to toggle offline simulation."}, status=403)
                    return
                want_offline = bool(payload.get("offline", False))
                d_stat = set_pc_daemon_running(not want_offline, actor_email=actor_email)
                self.send_json({"status": "ok", "pc_online": d_stat["pc_online"], "daemon_running": d_stat["daemon_running"]})
                return

            if path == "/api/admin/pc-daemon":
                if not actor_perms.get("can_manage_users") and not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": "Only Owner, Admin, or Editor accounts can control the PC daemon."}, status=403)
                    return
                action = str(payload.get("action") or "").strip().lower()
                if action == "sync_now":
                    sync_scans_with_filesystem(force=True)
                    st_now = get_pc_daemon_status()
                    st_now["message"] = "Triggered immediate Google Drive Inbox discovery & .3tz Cloud Sync on PC."
                    self.send_json(st_now)
                    return
                if action == "start":
                    target_running = True
                elif action == "stop":
                    target_running = False
                elif "running" in payload:
                    target_running = bool(payload.get("running"))
                else:
                    target_running = not is_pc_daemon_running()
                st_res = set_pc_daemon_running(target_running, actor_email=actor_email)
                st_res["message"] = (
                    "Workstation Daemon STARTED (Google Drive Inbox Watcher + PIX4Dmatic Queue + 3D Tiler active)."
                    if target_running
                    else "Workstation Daemon STOPPED (Background inbox polling & PIX4Dmatic queue paused; tunnel remains on standby)."
                )
                self.send_json(st_res)
                return

            # 1b. Save Automatically Captured 3D Scan Screenshot Thumbnail
            if path.startswith("/api/scans/") and path.endswith("/thumbnail"):
                scan_id = re.sub(r"[^a-zA-Z0-9_\-]", "", path[len("/api/scans/") : -len("/thumbnail")].strip("/"))
                data_url = str(payload.get("data_url", "")).strip()
                if not scan_id or "," not in data_url:
                    self.send_json({"error": "Invalid scan_id or data_url"}, status=400)
                    return
                b64_part = data_url.split(",", 1)[1]
                raw_bytes = base64.b64decode(b64_part)
                out_file = os.path.join(THUMBS_DIR, f"{scan_id}.png")
                with open(out_file, "wb") as f:
                    f.write(raw_bytes)
                try:
                    with open(os.path.join(THUMBS_DIR, f"{scan_id.lower()}.png"), "wb") as f2:
                        f2.write(raw_bytes)
                except Exception:
                    pass
                scan_row = DB.get_scan(scan_id) or {}
                pdir = scan_row.get("project_dir") or ""
                if pdir and os.path.isdir(pdir):
                    try:
                        with open(os.path.join(pdir, "thumbnail.png"), "wb") as pf:
                            pf.write(raw_bytes)
                    except Exception:
                        pass
                self.send_json(
                    {
                        "status": "ok",
                        "scan_id": scan_id,
                        "bytes": len(raw_bytes),
                        "thumbnail_url": f"/api/scans/{scan_id}/thumbnail?t={int(time.time())}",
                    }
                )
                return

            # 1c. Edit and Save Scan Display Name (persists to SQLite + scan_meta.json on local disk)
            if path == "/api/scans/rename" or (path.startswith("/api/scans/") and path.endswith("/rename")):
                if not actor_perms.get("can_edit_names"):
                    self.send_json({"error": f"Role '{actor_role}' cannot rename scans (Editor, Admin, or Owner required)."}, status=403)
                    return
                if path == "/api/scans/rename":
                    scan_id = str(payload.get("scan_id") or (query.get("scan_id") or [""])[0]).strip()
                else:
                    scan_id = re.sub(r"[^a-zA-Z0-9_\-]", "", path[len("/api/scans/") : -len("/rename")].strip("/"))
                new_name = str(payload.get("name") or (query.get("name") or [""])[0]).strip()
                if not scan_id or not new_name:
                    self.send_json({"error": "scan_id and name are required"}, status=400)
                    return
                updated = DB.rename_scan(scan_id, new_name)
                if not updated:
                    self.send_json({"error": f"Scan not found: {scan_id}"}, status=404)
                    return
                for ck in list(_VPS_RAM_FALLBACK_CACHE.keys()):
                    if ck.startswith("/api/scans") or ck.startswith("/api/projects"):
                        _VPS_RAM_FALLBACK_CACHE.pop(ck, None)
                self.send_json({"status": "ok", "scan": self._enrich_scan_urls(updated)})
                return

            # 1c-2. Move Scan to Recycle Bin (/api/scans/delete or /api/scans/bin/trash)
            if path in ("/api/scans/delete", "/api/scans/bin/trash") or (path.startswith("/api/scans/") and path.endswith("/delete")):
                if not actor_perms.get("can_edit_names"):
                    self.send_json({"error": f"Role '{actor_role}' cannot move scans to the Bin (Editor, Admin, or Owner required)."}, status=403)
                    return
                if path in ("/api/scans/delete", "/api/scans/bin/trash"):
                    scan_id = str(payload.get("scan_id") or (query.get("scan_id") or [""])[0]).strip()
                else:
                    scan_id = re.sub(r"[^a-zA-Z0-9_\-]", "", path[len("/api/scans/") : -len("/delete")].strip("/"))
                if not scan_id:
                    self.send_json({"error": "scan_id is required"}, status=400)
                    return
                actor_name = str(payload.get("actor_name") or self.headers.get("X-User-Name") or actor_email or "User").strip()
                trashed_scan = DB.trash_scan(scan_id, actor_email=actor_email, actor_name=actor_name)
                if not trashed_scan:
                    self.send_json({"error": f"Scan not found: {scan_id}"}, status=404)
                    return
                _VPS_RAM_FALLBACK_CACHE.clear()
                if os.name == "nt":
                    def _bg_sync_after_trash():
                        try:
                            from pc_worker.gdrive_cloud_sync import sync_all_scans_to_gdrive_and_vps
                            sync_all_scans_to_gdrive_and_vps(DB, AUTH_SHARE, force=False)
                        except Exception:
                            pass
                    threading.Thread(target=_bg_sync_after_trash, daemon=True).start()
                all_scans = [self._enrich_scan_urls(s) for s in DB.list_scans()]
                bin_scans = DB.list_trashed_scans()
                self.send_json(
                    {
                        "status": "ok",
                        "ok": True,
                        "deleted_scan_id": scan_id,
                        "trashed": trashed_scan,
                        "scans": all_scans,
                        "projects": self._build_projects_summary(all_scans),
                        "bin_scans": bin_scans,
                        "bin_scans_count": len(bin_scans),
                    }
                )
                return

            # 1c-3. Recycle Bin Restore (/api/scans/bin/restore — Editor, Admin, or Owner)
            if path == "/api/scans/bin/restore":
                if not (actor_perms.get("can_edit_names") or actor_perms.get("can_manage_users")):
                    self.send_json({"error": f"Role '{actor_role}' cannot restore from the Recycle Bin (Editor, Admin, or Owner required)."}, status=403)
                    return
                raw_ids = payload.get("scan_ids")
                if not isinstance(raw_ids, list):
                    single_id = str(payload.get("scan_id") or "").strip()
                    raw_ids = [single_id] if single_id else []
                scan_ids = [str(x).strip() for x in raw_ids if str(x).strip()]
                if not scan_ids:
                    self.send_json({"error": "scan_ids is required"}, status=400)
                    return
                restored = DB.restore_trashed_scans(scan_ids)
                _VPS_RAM_FALLBACK_CACHE.clear()
                if os.name == "nt":
                    def _bg_sync_after_restore():
                        try:
                            from pc_worker.gdrive_cloud_sync import sync_all_scans_to_gdrive_and_vps
                            sync_all_scans_to_gdrive_and_vps(DB, AUTH_SHARE, force=False)
                        except Exception:
                            pass
                    threading.Thread(target=_bg_sync_after_restore, daemon=True).start()
                all_scans = [self._enrich_scan_urls(s) for s in DB.list_scans()]
                bin_scans = DB.list_trashed_scans()
                self.send_json(
                    {
                        "status": "ok",
                        "ok": True,
                        "restored_count": len(restored),
                        "restored": restored,
                        "scans": all_scans,
                        "projects": self._build_projects_summary(all_scans),
                        "bin_scans": bin_scans,
                        "bin_scans_count": len(bin_scans),
                    }
                )
                return

            # 1c-4. Admin-Only Recycle Bin Permanent Delete / Clear Bin (/api/scans/bin/purge, /api/scans/bin/empty, /api/scans/bin/clear)
            if path in ("/api/scans/bin/purge", "/api/scans/bin/empty", "/api/scans/bin/clear"):
                if not actor_perms.get("can_manage_users"):
                    self.send_json({"error": f"Role '{actor_role}' cannot permanently delete or clear the Recycle Bin (Admin or Owner required)."}, status=403)
                    return
                clear_all = bool(payload.get("clear_all") or path in ("/api/scans/bin/empty", "/api/scans/bin/clear"))
                raw_ids = payload.get("scan_ids")
                if not isinstance(raw_ids, list):
                    single_id = str(payload.get("scan_id") or "").strip()
                    raw_ids = [single_id] if single_id else []
                scan_ids = [str(x).strip() for x in raw_ids if str(x).strip()]
                if not clear_all and not scan_ids:
                    self.send_json({"error": "scan_ids or clear_all=true is required"}, status=400)
                    return
                purged_ids = DB.purge_trashed_scans(scan_ids=scan_ids, clear_all=clear_all)
                # Also remove purged scans from cloud manifest
                if purged_ids:
                    purged_lower = {p.lower() for p in purged_ids}
                    try:
                        m_cur = _load_cloud_manifest()
                        if isinstance(m_cur, dict):
                            if isinstance(m_cur.get("scans"), list):
                                m_cur["scans"] = [s for s in m_cur["scans"] if str(s.get("scan_id") or "").lower() not in purged_lower]
                            if isinstance(m_cur.get("packages"), dict):
                                for pk in list(m_cur["packages"].keys()):
                                    if pk.lower() in purged_lower:
                                        m_cur["packages"].pop(pk, None)
                            _save_cloud_manifest(m_cur)
                    except Exception as me:
                        print(f"[GatheringScans] Manifest cleanup warning during bin purge: {me}")
                _VPS_RAM_FALLBACK_CACHE.clear()
                if os.name == "nt":
                    def _bg_sync_after_purge():
                        try:
                            from pc_worker.gdrive_cloud_sync import sync_all_scans_to_gdrive_and_vps
                            sync_all_scans_to_gdrive_and_vps(DB, AUTH_SHARE, force=False)
                        except Exception:
                            pass
                    threading.Thread(target=_bg_sync_after_purge, daemon=True).start()
                all_scans = [self._enrich_scan_urls(s) for s in DB.list_scans()]
                bin_scans = DB.list_trashed_scans()
                self.send_json(
                    {
                        "status": "ok",
                        "ok": True,
                        "purged_scan_ids": purged_ids,
                        "scans": all_scans,
                        "projects": self._build_projects_summary(all_scans),
                        "bin_scans": bin_scans,
                        "bin_scans_count": len(bin_scans),
                    }
                )
                return

            # 1d. Edit and Save Site / Project Group Name (persists to SQLite + scan_meta.json + site_renames.json)
            if path in ("/api/projects/rename", "/api/sites/rename"):
                if not actor_perms.get("can_edit_names"):
                    self.send_json({"error": f"Role '{actor_role}' cannot rename sites (Editor, Admin, or Owner required)."}, status=403)
                    return
                old_group = str(payload.get("old_project_group") or payload.get("project_group") or "").strip()
                new_group = str(payload.get("new_project_group") or payload.get("name") or "").strip()
                new_zh = str(payload.get("new_project_name_zh") or payload.get("project_name_zh") or new_group).strip()
                if not old_group or not new_group:
                    self.send_json({"error": "old_project_group and new_project_group are required"}, status=400)
                    return
                res_rename = DB.rename_site(old_group, new_group, new_zh)
                if isinstance(res_rename, dict) and not res_rename.get("ok", True):
                    self.send_json({"error": res_rename.get("error", "Failed to rename site")}, status=404)
                    return
                updated_list = res_rename if isinstance(res_rename, list) else res_rename.get("updated_scans", [])
                for ck in list(_VPS_RAM_FALLBACK_CACHE.keys()):
                    if ck.startswith("/api/scans") or ck.startswith("/api/projects"):
                        _VPS_RAM_FALLBACK_CACHE.pop(ck, None)
                all_scans = [self._enrich_scan_urls(s) for s in DB.list_scans()]
                self.send_json(
                    {
                        "status": "ok",
                        "ok": True,
                        "old_project_group": old_group,
                        "new_project_group": new_group,
                        "new_project_name_zh": new_zh,
                        "updated_count": len(updated_list),
                        "projects": self._build_projects_summary(all_scans),
                        "scans": all_scans,
                    }
                )
                return

            # 2. Civil Surveying: Cut/Fill & Stockpile Volume + Report Generation
            if path in ("/api/survey/volume", "/api/surveying/volume"):
                if share_token:
                    ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(
                        share_token, requested_scan_id=payload.get("scan_id")
                    )
                    if not ok_s or not (link_s and link_s.get("allow_measurements", True)):
                        self.send_json({"error": "Measurements are disabled for this external share link."}, status=403)
                        return
                res = SURVEY.calculate_cut_fill_volume(payload)
                self.send_json(res)
                return

            # 3. Civil Surveying: Elevation Contours + Civil3D.dxf & A3 Survey Report .PDF Export
            if path in ("/api/survey/contours", "/api/survey/report", "/api/surveying/contours", "/api/surveying/report"):
                if share_token:
                    ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(
                        share_token, requested_scan_id=payload.get("scan_id")
                    )
                    if not ok_s or not (link_s and link_s.get("allow_measurements", True)):
                        self.send_json({"error": "Measurements are disabled for this external share link."}, status=403)
                        return
                res = SURVEY.generate_civil3d_survey_report(payload)
                self.send_json(res)
                return

            # 4. Civil Surveying: Cross-Section Profile
            if path in ("/api/survey/profile", "/api/surveying/profile"):
                if share_token:
                    ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(
                        share_token, requested_scan_id=payload.get("scan_id")
                    )
                    if not ok_s or not (link_s and link_s.get("allow_measurements", True)):
                        self.send_json({"error": "Measurements are disabled for this external share link."}, status=403)
                        return
                res = SURVEY.compute_cross_section_profile(payload)
                self.send_json(res)
                return

            # 5. Civil Surveying: RTK Raw Camera Photo Pin Inspector
            if path == "/api/survey/inspect-photos":
                if share_token:
                    ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(
                        share_token, requested_scan_id=payload.get("scan_id")
                    )
                    if not ok_s or not (link_s and link_s.get("allow_measurements", True)):
                        self.send_json({"error": "Photo inspection is disabled for this external share link."}, status=403)
                        return
                res = SURVEY.inspect_rtk_camera_photos(payload)
                self.send_json(res)
                return

            # 5b. Civil Surveying: AI + 3D Geometric Surface & Object Categorization
            if path in ("/api/survey/categorize", "/api/surveying/categorize"):
                if share_token:
                    ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(
                        share_token, requested_scan_id=payload.get("scan_id")
                    )
                    if not ok_s or not (link_s and link_s.get("allow_measurements", True)):
                        self.send_json({"error": "Surface categorization is disabled for this external share link."}, status=403)
                        return
                res = SURVEY.categorize_scan_surfaces_and_objects(payload)
                self.send_json(res)
                return

            # 6. GC_ScanOptimizer PC Actions & Multi-Scan Alignment Merge
            if path == "/api/optimizer/optimize":
                if not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": f"Role '{actor_role}' cannot run PC optimization workflows (Editor, Admin, or Owner required)."}, status=403)
                    return
                res = OPTIMIZER.run_optimize_action(payload)
                self._GZIP_FILE_CACHE.clear()
                self._OPTIMIZED_TILESET_CACHE.clear()
                _VPS_RAM_FALLBACK_CACHE.clear()
                for _inv_sid in {res.get("scan_id"), payload.get("scan_id")}:
                    if _inv_sid:
                        SURVEY._dsm_mem_cache.pop(str(_inv_sid), None)
                self.send_json(res)
                return

            if path == "/api/optimizer/crop":
                if not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": f"Role '{actor_role}' cannot run PC crop workflows (Editor, Admin, or Owner required)."}, status=403)
                    return
                res = OPTIMIZER.run_crop_action(payload)
                self._GZIP_FILE_CACHE.clear()
                self._OPTIMIZED_TILESET_CACHE.clear()
                _VPS_RAM_FALLBACK_CACHE.clear()
                if res.get("scan_id"):
                    SURVEY._dsm_mem_cache.pop(res["scan_id"], None)
                self.send_json(res)
                return

            if path == "/api/optimizer/restore":
                if not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": f"Role '{actor_role}' cannot restore scan backups on the PC (Editor, Admin, or Owner required)."}, status=403)
                    return
                res = OPTIMIZER.restore_scan_backup(payload)
                self._GZIP_FILE_CACHE.clear()
                self._OPTIMIZED_TILESET_CACHE.clear()
                _VPS_RAM_FALLBACK_CACHE.clear()
                if res.get("scan_id"):
                    SURVEY._dsm_mem_cache.pop(res["scan_id"], None)
                self.send_json(res)
                return

            if path == "/api/optimizer/restore-region":
                if not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": f"Role '{actor_role}' cannot restore scan regions on the PC (Editor, Admin, or Owner required)."}, status=403)
                    return
                res = OPTIMIZER.run_restore_region_action(payload)
                self._GZIP_FILE_CACHE.clear()
                self._OPTIMIZED_TILESET_CACHE.clear()
                _VPS_RAM_FALLBACK_CACHE.clear()
                if res.get("scan_id"):
                    SURVEY._dsm_mem_cache.pop(res["scan_id"], None)
                if isinstance(res.get("scan"), dict):
                    res["scan"] = self._enrich_scan_urls(res["scan"])
                all_scans = [self._enrich_scan_urls(s) for s in DB.list_scans()]
                res["scans"] = all_scans
                res["projects"] = self._build_projects_summary(all_scans)
                self.send_json(res)
                return

            if path == "/api/optimizer/generate-scan":
                if not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": f"Role '{actor_role}' cannot generate edited scans on the PC (Editor, Admin, or Owner required)."}, status=403)
                    return
                payload["actor_email"] = actor_email
                payload["actor_name"] = str(payload.get("actor_name") or self.headers.get("X-User-Name") or actor_email or "雲在天").strip()
                res = OPTIMIZER.run_generate_scan_action(payload)
                self._GZIP_FILE_CACHE.clear()
                self._OPTIMIZED_TILESET_CACHE.clear()
                _VPS_RAM_FALLBACK_CACHE.clear()
                if isinstance(res.get("scan"), dict):
                    res["scan"] = self._enrich_scan_urls(res["scan"])
                all_scans = [self._enrich_scan_urls(s) for s in DB.list_scans()]
                bin_scans = DB.list_trashed_scans()
                res["scans"] = all_scans
                res["projects"] = self._build_projects_summary(all_scans)
                res["bin_scans"] = bin_scans
                res["bin_scans_count"] = len(bin_scans)
                self.send_json(res)
                return

            if path in ("/api/scans/merge", "/api/optimizer/merge"):
                if not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": f"Role '{actor_role}' cannot merge scans on the PC (Editor, Admin, or Owner required)."}, status=403)
                    return
                payload["actor_email"] = actor_email
                payload["actor_name"] = str(payload.get("actor_name") or self.headers.get("X-User-Name") or actor_email or "雲在天").strip()
                res = OPTIMIZER.run_merge_scans_action(payload, surveying_engine=SURVEY)
                self._GZIP_FILE_CACHE.clear()
                self._OPTIMIZED_TILESET_CACHE.clear()
                _VPS_RAM_FALLBACK_CACHE.clear()
                if isinstance(res.get("scan"), dict):
                    res["scan"] = self._enrich_scan_urls(res["scan"])
                all_scans = [self._enrich_scan_urls(s) for s in DB.list_scans()]
                bin_scans = DB.list_trashed_scans()
                res["scans"] = all_scans
                res["projects"] = self._build_projects_summary(all_scans)
                res["bin_scans"] = bin_scans
                res["bin_scans_count"] = len(bin_scans)
                self.send_json(res)
                return

            # 7. Smart Queue & PIX4Dmatic Automation Actions (including Re-run from Original Photos)
            if path in ("/api/queue/scan-inbox", "/api/queue/rescan"):
                if not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": f"Role '{actor_role}' cannot trigger PC inbox rescans."}, status=403)
                    return
                self._GZIP_FILE_CACHE.clear()
                self._OPTIMIZED_TILESET_CACHE.clear()
                _VPS_RAM_FALLBACK_CACHE.clear()
                scans = seed_and_discover_scans(DB)
                self.send_json({"status": "ok", "inbox_dir": GDRIVE_INPUTS_DIR, "total_scans": len(scans)})
                return

            if path == "/api/pix4d/settings":
                if not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": f"Role '{actor_role}' cannot modify PIX4Dmatic settings."}, status=403)
                    return
                saved = save_pix4d_settings(payload.get("settings", payload) if isinstance(payload, dict) else {})
                self.send_json({"status": "ok", "settings": saved})
                return

            if path == "/api/queue/force-next":
                if not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": f"Role '{actor_role}' cannot reorder the PC processing queue."}, status=403)
                    return
                scan_id = payload.get("scan_id", "")
                updated = DB.set_force_next(scan_id, bool(payload.get("force", True)))
                _PIX4D_WAKE_EVENT.set()
                self.send_json({"status": "ok", "scan": updated})
                return

            if path in ("/api/scans/rerun", "/api/queue/enqueue", "/api/queue/reprocess"):
                if not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": f"Role '{actor_role}' cannot run or re-run scans on the PC (Editor, Admin, or Owner required)."}, status=403)
                    return
                scan_id = str(payload.get("scan_id", "")).strip()
                scan = DB.get_scan(scan_id)
                if not scan:
                    self.send_json({"error": f"Scan not found: {scan_id}"}, status=404)
                    return
                force = bool(payload.get("force_next", True if path == "/api/scans/rerun" else False))
                force_from_photos = bool(payload.get("force_from_photos", True if path == "/api/scans/rerun" else False))
                raw_custom = payload.get("settings") if isinstance(payload.get("settings"), dict) else {}
                p4d_cfg = load_pix4d_settings_from_dict({**load_pix4d_settings(), **raw_custom})
                for k_extra in ("mesh_quality", "vertex_density"):
                    if k_extra in raw_custom:
                        p4d_cfg[k_extra] = str(raw_custom[k_extra])
                tex_sz = int(p4d_cfg.get("texture_size", PIX4DMATIC_TEXTURE_SIZE))
                mesh_pipe = str(p4d_cfg.get("mesh_pipeline", "FixedSize"))
                mesh_qual = str(p4d_cfg.get("mesh_quality", "Standard"))

                proj_dir = scan.get("project_dir") or os.path.join(LOCAL_SCANS_ROOT, scan_id)
                os.makedirs(proj_dir, exist_ok=True)
                inputs_dir = os.path.join(proj_dir, "inputs")
                src_zip = str(scan.get("source_zip_path") or "")
                photo_files = []
                if os.path.isdir(inputs_dir):
                    for r_root, _, r_files in os.walk(inputs_dir):
                        for fn in r_files:
                            if fn.lower().endswith((".jpg", ".jpeg", ".png")):
                                photo_files.append(os.path.join(r_root, fn))
                has_photos = len(photo_files) > 0 or (bool(src_zip) and os.path.exists(src_zip))

                rerun_cfg_path = os.path.join(proj_dir, "rerun_settings.json")
                with open(rerun_cfg_path, "w", encoding="utf-8") as rf:
                    json.dump(
                        {
                            "scan_id": scan_id,
                            "force_from_photos": force_from_photos,
                            "settings": p4d_cfg,
                            "requested_by": actor_email,
                            "requested_at": time.time(),
                        },
                        rf,
                        ensure_ascii=False,
                        indent=2,
                    )

                label_mode = "Re-run from Original Photos" if force_from_photos else "Queued for PIX4Dmatic"
                DB.update_job_progress(
                    scan_id,
                    "queued",
                    0.0,
                    f"{label_mode} ({mesh_pipe}/{mesh_qual}, {tex_sz}px, TWD97)",
                )
                run_immediately = bool(payload.get("run_immediately", False))
                if force or run_immediately:
                    DB.set_force_next(scan_id, True)

                in_path = inputs_dir if os.path.isdir(inputs_dir) else (src_zip or proj_dir)
                gst_script = generate_pix4dmatic_gst_script(
                    project_p4m_path=f"C:/GatheringScans/{scan_id}/{scan_id}.p4m",
                    input_zip_or_folder=in_path,
                    export_dir=f"C:/GatheringScans/{scan_id}/exports",
                    texture_size=tex_sz,
                    pipeline_settings=p4d_cfg,
                )

                # Wake both inbox watcher and pix4d_worker_loop immediately so the single
                # authoritative queue worker picks up this job with proper arguments & progress tracking.
                _DAEMON_WAKE_EVENT.set()
                _PIX4D_WAKE_EVENT.set()

                self.send_json(
                    {
                        "status": "ok",
                        "scan": DB.get_scan(scan_id),
                        "force_from_photos": force_from_photos,
                        "has_original_photos": has_photos,
                        "original_photos_count": len(photo_files) or int(scan.get("total_photos") or 0),
                        "input_source": in_path,
                        "settings": p4d_cfg,
                        "gst_script": gst_script,
                    }
                )
                return

            if path == "/api/queue/preview-gst":
                scan_id = (payload.get("scan_id") or "").strip()
                if not scan_id:
                    self.send_json({"error": "Missing required parameter: scan_id"}, status=400)
                    return
                scan = DB.get_scan(scan_id)
                if not scan:
                    self.send_json({"error": f"Scan not found: {scan_id}"}, status=404)
                    return
                proj_dir = scan.get("project_dir") or os.path.join(LOCAL_SCANS_ROOT, scan_id)
                inputs_dir = os.path.join(proj_dir, "inputs")
                in_path = inputs_dir if os.path.isdir(inputs_dir) else (scan.get("source_zip_path") or proj_dir)
                raw_custom = payload.get("settings") if isinstance(payload.get("settings"), dict) else {}
                custom_cfg = {**load_pix4d_settings(), **raw_custom}
                gst_script = generate_pix4dmatic_gst_script(
                    project_p4m_path=f"C:/GatheringScans/{scan_id}/{scan_id}.p4m",
                    input_zip_or_folder=in_path,
                    export_dir=f"C:/GatheringScans/{scan_id}/exports",
                    texture_size=int(custom_cfg.get("texture_size", PIX4DMATIC_TEXTURE_SIZE)),
                    pipeline_settings=custom_cfg,
                )
                self.send_json(
                    {
                        "status": "ok",
                        "scan_id": scan_id,
                        "crs": TWD97_TWVD2001_LABEL,
                        "texture_size": int(custom_cfg.get("texture_size", PIX4DMATIC_TEXTURE_SIZE)),
                        "settings": custom_cfg,
                        "gst_script": gst_script,
                    }
                )
                return

            # 8. Comments API
            if path == "/api/comments":
                scan_id = payload.get("scan_id", "")
                if share_token:
                    ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(
                        share_token, requested_scan_id=scan_id
                    )
                    if not ok_s and os.name != "nt":
                        ok_s, reason_s, link_s, _ = self._validate_cloud_share_token(
                            share_token, requested_scan_id=scan_id
                        )
                    if not ok_s:
                        self.send_json({"error": reason_s}, status=403)
                        return
                    if not (link_s and link_s.get("allow_comments", False)):
                        self.send_json({"error": "Comments are disabled for this external share link."}, status=403)
                        return
                elif actor_role == "guest":
                    self.send_json({"error": "Read-only Guest Mode cannot post comments. Sign in with Google to comment."}, status=403)
                    return
                cmt = DB.add_comment(payload)
                _VPS_RAM_FALLBACK_CACHE.clear()
                self.send_json({"status": "ok", "comment": cmt})
                return

            # 9. Scoped External Share Link Creation & Revocation
            if path in ("/api/share/create", "/api/share/revoke", "/api/share/restore"):
                def _persist_share_links_cloud(updated_link: Optional[Dict[str, Any]] = None):
                    if os.name == "nt":
                        def _bg_sync_shares():
                            try:
                                from pc_worker.gdrive_cloud_sync import sync_share_links_to_vps_manifest
                                sync_share_links_to_vps_manifest(AUTH_SHARE)
                            except Exception:
                                pass
                        threading.Thread(target=_bg_sync_shares, daemon=True).start()
                    else:
                        try:
                            m_cur = _load_cloud_manifest()
                            by_t = {str(x.get("token")): x for x in (m_cur.get("share_links") or []) if x.get("token")}
                            for lx in AUTH_SHARE.list_share_links():
                                if lx.get("token"):
                                    by_t[str(lx["token"])] = lx
                            if updated_link and updated_link.get("token"):
                                by_t[str(updated_link["token"])] = updated_link
                            m_cur["share_links"] = sorted(
                                by_t.values(), key=lambda x: str(x.get("created_at") or ""), reverse=True
                            )
                            _save_cloud_manifest(m_cur)
                            _VPS_RAM_FALLBACK_CACHE.clear()
                        except Exception:
                            pass

                if path == "/api/share/create":
                    wants_dl = bool(payload.get("allow_download", False))
                    can_create = bool(actor_perms.get("can_manage_shares")) or (
                        bool(actor_perms.get("can_share")) and not wants_dl
                    )
                    if not can_create:
                        self.send_json({"error": f"Role '{actor_role}' cannot create this external share link."}, status=403)
                        return
                    if actor_email and not payload.get("created_by_email") and not payload.get("actor_email"):
                        payload["actor_email"] = actor_email
                    link = AUTH_SHARE.create_share_link(payload)
                    _persist_share_links_cloud(link)
                    self.send_json({"status": "ok", "link": link})
                    return

                if path == "/api/share/revoke":
                    if not actor_perms.get("can_manage_shares"):
                        self.send_json({"error": f"Role '{actor_role}' cannot revoke external share links."}, status=403)
                        return
                    token = payload.get("token", "")
                    link = AUTH_SHARE.revoke_share_link(token)
                    if not link and os.name != "nt" and token:
                        m_cur = _load_cloud_manifest()
                        for item in (m_cur.get("share_links") or []):
                            if item.get("token") == token:
                                item["revoked"] = True
                                link = item
                                break
                        if link:
                            _save_cloud_manifest(m_cur)
                            _VPS_RAM_FALLBACK_CACHE.clear()
                    if not link:
                        self.send_json({"error": "Share token not found"}, status=404)
                        return
                    _persist_share_links_cloud(link)
                    self.send_json({"status": "ok", "link": link})
                    return

                if path == "/api/share/restore":
                    if not actor_perms.get("can_manage_shares"):
                        self.send_json({"error": f"Role '{actor_role}' cannot restore external share links."}, status=403)
                        return
                    token = payload.get("token", "")
                    link = AUTH_SHARE.restore_share_link(token)
                    if not link and os.name != "nt" and token:
                        m_cur = _load_cloud_manifest()
                        for item in (m_cur.get("share_links") or []):
                            if item.get("token") == token:
                                item["revoked"] = False
                                item["revoked_at"] = ""
                                link = item
                                break
                        if link:
                            _save_cloud_manifest(m_cur)
                            _VPS_RAM_FALLBACK_CACHE.clear()
                    _persist_share_links_cloud(link)
                    self.send_json({"status": "ok", "link": link})
                    return

            # 10. Google Chat Notification Dispatch & Webhook Config
            if path == "/api/gchat/config":
                if not actor_perms.get("can_manage_users"):
                    self.send_json({"error": "Owner or Admin session required to configure webhooks."}, status=403)
                    return
                webhook = payload.get("webhook_url", "")
                up_email = payload.get("uploader_email", "")
                saved = GCHAT.set_webhook_url(webhook, uploader_email=up_email)
                self.send_json(
                    {
                        "status": "ok",
                        "webhook_url": saved,
                        "user_webhooks": GCHAT.user_webhooks,
                        "user_gchat_ids": GCHAT.user_gchat_ids,
                    }
                )
                return

            if path == "/api/gchat/notify":
                if not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": "Authenticated Editor, Admin, or Owner session required."}, status=403)
                    return
                scan_id = payload.get("scan_id", "")
                webhook = payload.get("webhook_url", "")
                if webhook and actor_perms.get("can_manage_users"):
                    GCHAT.set_webhook_url(webhook)
                res = GCHAT.notify_scan_ready(scan_id, custom_webhook_url=webhook)
                self.send_json(res)
                return

            # 11. User-Specific Offline Cache Settings & User Profiles Update / Admin Control Panel
            if path == "/api/user/settings":
                email = str(
                    payload.get("email")
                    or payload.get("user_email")
                    or actor_email
                    or "guest@anonymous"
                ).strip().lower()
                settings = DB.update_user_settings(email, payload)
                self.send_json({"status": "ok", "settings": settings})
                return

            if path == "/api/admin/users/save":
                res_admin = AUTH_SHARE.admin_save_user(
                    actor_email=actor_email,
                    target_email=str(payload.get("email") or payload.get("target_email") or ""),
                    name=str(payload.get("name") or ""),
                    zh_name=str(payload.get("zh_name") or ""),
                    role=str(payload.get("role") or "viewer"),
                    gchat_user_id=str(payload.get("gchat_user_id") or ""),
                )
                if not res_admin.get("ok"):
                    self.send_json({"error": res_admin.get("error", "Permission denied")}, status=403)
                    return
                self.send_json({"status": "ok", **res_admin})
                return

            if path == "/api/admin/users/delete":
                res_del = AUTH_SHARE.admin_delete_user(
                    actor_email=actor_email,
                    target_email=str(payload.get("email") or payload.get("target_email") or ""),
                )
                if not res_del.get("ok"):
                    self.send_json({"error": res_del.get("error", "Permission denied")}, status=403)
                    return
                self.send_json({"status": "ok", **res_del})
                return

            if path == "/api/user-profiles":
                if actor_role == "guest":
                    self.send_json({"error": "Authenticated Google session required to update user profiles."}, status=403)
                    return
                target_em = str(payload.get("email") or "").strip().lower()
                if not actor_perms.get("can_manage_users") and target_em != actor_email:
                    self.send_json({"error": "Only Owner or Admin accounts can modify other user profiles."}, status=403)
                    return
                safe_payload = dict(payload)
                if not actor_perms.get("can_manage_users"):
                    safe_payload.pop("role", None)
                    safe_payload.pop("isAdmin", None)
                    safe_payload.pop("isOwner", None)
                saved = AUTH_SHARE.upsert_user_profile(safe_payload, preserve_existing_role=not actor_perms.get("can_manage_users"))
                self.send_json(
                    {
                        "status": "ok",
                        "profile": saved,
                        "profiles": AUTH_SHARE.list_user_profiles(),
                    }
                )
                return

            # 12. Google OAuth Login Verification (Same Client ID as GatheringCloud)
            if path == "/api/auth/google":
                cred = payload.get("credential", "")
                fallback_profile = payload.get("profile") if isinstance(payload.get("profile"), dict) else None
                user = AUTH_SHARE.verify_google_oauth_credential(cred, fallback_profile=fallback_profile)
                self.send_json(
                    {
                        "status": "ok",
                        "user": user,
                        "profiles": AUTH_SHARE.list_user_profiles(),
                    }
                )
                return

            self.send_json({"error": f"Unknown endpoint: {path}"}, status=404)
        except KeyError as e:
            msg = e.args[0] if e.args else str(e)
            self.send_json({"error": str(msg)}, status=404)
        except ValueError as e:
            self.send_json({"error": str(e)}, status=400)
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)
        share_token = self._extract_share_token(query)
        if os.name != "nt" and path.startswith("/api/"):
            self._proxy_via_pc_tunnel_if_vps("DELETE", path)
            return
        if path.startswith("/api/comments/"):
            actor_email, actor_role, actor_perms = self._resolve_request_role(None, query, share_token)
            if not actor_perms.get("can_comment") or actor_role == "guest":
                self.send_json({"error": "Authenticated session required to delete spatial comments."}, status=403)
                return
            cid = path[len("/api/comments/") :].strip("/")
            existing_c = DB.get_comment(cid)
            if existing_c and not actor_perms.get("can_manage_users"):
                c_author = str(existing_c.get("author_email") or "").strip().lower()
                if c_author and c_author != actor_email:
                    self.send_json({"error": "You can only delete your own comments (or sign in as Admin/Owner)."}, status=403)
                    return
            deleted = DB.delete_comment(cid)
            self.send_json({"status": "ok", "deleted": deleted})
            return
        self.send_json({"error": "Unknown DELETE endpoint"}, status=404)


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


def run_server(host: str = SERVER_HOST, port: int = SERVER_PORT):
    if os.name != "nt":
        # Mirror fresh GitHub-synced WEB_DIR out to host backup directories (never overwrite newer WEB_DIR with stale host files)
        for host_web_dir in ("/host_opt/gathering_scans/web", "/host_docker/gathering_scans/web"):
            if os.path.isdir(os.path.dirname(host_web_dir)):
                try:
                    shutil.copytree(WEB_DIR, host_web_dir, dirs_exist_ok=True)
                except Exception as e:
                    print(f"[GatheringScans] Host web mirror note ({host_web_dir}): {e}")
    _ensure_vps_caddy_route()
    if os.name != "nt":
        t_cw = threading.Thread(target=_vps_caddy_watchdog_loop, daemon=True)
        t_cw.start()
    if os.name == "nt":
        start_pc_reverse_tunnel_pool(local_port=port)
        t_cm = threading.Thread(target=_pc_cloud_manifest_sync_loop, daemon=True)
        t_cm.start()
    server = ThreadingHTTPServer((host, port), GatheringScansHandler)
    print(f"[GatheringScans] Server listening on http://{host}:{port} (CRS: {TWD97_TWVD2001_SHORT}, 2K Textures, Root: {LOCAL_SCANS_ROOT})")
    server.serve_forever()


if __name__ == "__main__":
    run_server()

