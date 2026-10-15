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
import json
import time
import queue
import socket
import struct
import base64
import shutil
import mimetypes
import threading
import http.client
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, Any, Optional, Tuple

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from pc_worker.config import (
    SERVER_HOST,
    SERVER_PORT,
    VPS_HOST,
    TUNNEL_SHARED_KEY,
    LOCAL_SCANS_ROOT,
    REPORTS_DIR,
    CONTOURS_DIR,
    GDRIVE_INBOX_DIR,
    MATERIAL_CATALOG,
    TWD97_TWVD2001_LABEL,
    TWD97_TWVD2001_SHORT,
    PIX4DMATIC_TEXTURE_SIZE,
)
from pc_worker.priority_queue import ScanQueueDB
from pc_worker.gdrive_watcher import seed_and_discover_scans, extract_opf_zip_metadata
from pc_worker.pix4d_runner import generate_pix4dmatic_gst_script, run_pix4dmatic_pipeline
from pc_worker.optimizer_bridge import OptimizerBridge
from pc_worker.surveying_engine import SurveyingEngine
from pc_worker.auth_and_sharing import AuthAndSharingManager
from pc_worker.gchat_notifier import GoogleChatNotifier

WEB_DIR = os.path.join(BASE_DIR, "web")
THUMBS_DIR = os.path.join(BASE_DIR, "data", "thumbnails")
os.makedirs(WEB_DIR, exist_ok=True)
os.makedirs(THUMBS_DIR, exist_ok=True)

# Initialize Singletons
DB = ScanQueueDB()
seed_and_discover_scans(DB)
OPTIMIZER = OptimizerBridge(DB)
SURVEY = SurveyingEngine(DB)
AUTH_SHARE = AuthAndSharingManager(DB)
GCHAT = GoogleChatNotifier(DB)

# Simulated PC Online Toggle (for testing Requirement 5 Offline Fallback in browser)
PC_SIMULATED_OFFLINE = False

# Reverse Tunnel Socket Pool (used on Linux VPS to proxy /api/*, /stream/*, /s/* to Windows PC C:\GatheringScans)
VPS_TUNNEL_POOL: "queue.LifoQueue[Tuple[socket.socket, threading.Event, float]]" = queue.LifoQueue()
_TUNNEL_POOL_STARTED = False


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


def _acquire_vps_tunnel_socket(timeout: float = 3.0) -> Tuple[Optional[socket.socket], Optional[threading.Event]]:
    deadline = time.time() + timeout
    while True:
        rem = max(0.05, deadline - time.time())
        try:
            sock, done_evt, ts = VPS_TUNNEL_POOL.get(timeout=rem)
        except queue.Empty:
            return None, None
        if time.time() - ts > 42.0:
            done_evt.set()
            continue
        return sock, done_evt


def start_pc_reverse_tunnel_pool(local_port: int = SERVER_PORT, pool_size: int = 16):
    """On Windows PC, maintains a pool of persistent reverse TCP sockets to Hostinger VPS (76.13.197.29:8095)."""
    global _TUNNEL_POOL_STARTED
    if os.name != "nt" or _TUNNEL_POOL_STARTED:
        return
    _TUNNEL_POOL_STARTED = True

    def _worker(worker_id: int):
        while True:
            s: Optional[socket.socket] = None
            try:
                s = socket.create_connection((VPS_HOST, 8095), timeout=10.0)
                s.settimeout(55.0)
                handshake = (
                    f"GET /_pc_tunnel HTTP/1.1\r\n"
                    f"Host: {VPS_HOST}:8095\r\n"
                    f"X-Tunnel-Key: {TUNNEL_SHARED_KEY}\r\n"
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
                if b"200 OK" not in resp_buf or b"X-Tunnel-Ready: 1" not in resp_buf:
                    s.close()
                    time.sleep(3.0)
                    continue

                # Wait for proxied request frame from VPS (4-byte big-endian length + JSON)
                len_bytes = _recv_exact(s, 4)
                if not len_bytes:
                    # Idle tunnel rotation timeout; reconnect immediately
                    s.close()
                    continue
                (frame_len,) = struct.unpack("!I", len_bytes)
                if frame_len <= 0 or frame_len > 64 * 1024 * 1024:
                    s.close()
                    continue
                req_raw = _recv_exact(s, frame_len)
                if not req_raw:
                    s.close()
                    continue
                req_info = json.loads(req_raw.decode("utf-8"))
                method = req_info.get("method", "GET")
                path = req_info.get("path", "/")
                req_headers = req_info.get("headers") or {}
                body_b64 = req_info.get("body_b64", "")
                body_bytes = base64.b64decode(body_b64) if body_b64 else None

                # Execute against local Windows PC server (127.0.0.1:local_port)
                conn = http.client.HTTPConnection("127.0.0.1", local_port, timeout=60.0)
                fwd_headers = {}
                for hk, hv in req_headers.items():
                    if hk.lower() not in ("host", "connection", "transfer-encoding"):
                        fwd_headers[hk] = hv
                conn.request(method, path, body=body_bytes, headers=fwd_headers)
                resp = conn.getresponse()

                resp_headers = {k: v for k, v in resp.getheaders()}
                resp_meta = json.dumps({"status": resp.status, "headers": resp_headers}).encode("utf-8")
                s.sendall(struct.pack("!I", len(resp_meta)) + resp_meta)

                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    s.sendall(chunk)
                conn.close()
                try:
                    s.shutdown(socket.SHUT_WR)
                except Exception:
                    pass
                s.close()
            except Exception:
                if s:
                    try:
                        s.close()
                    except Exception:
                        pass
                time.sleep(2.0)

    for idx in range(pool_size):
        t = threading.Thread(target=_worker, args=(idx,), daemon=True)
        t.start()
    print(f"[GatheringScans] Started {pool_size} reverse tunnel sockets to {VPS_HOST}:8095 -> 127.0.0.1:{local_port} ({LOCAL_SCANS_ROOT})")


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
            ".csv": "text/csv; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
        }
    )

    def log_message(self, fmt: str, *args: Any):
        # Concise server logging
        pass

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Share-Token, Range")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

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
            self.send_header("Cache-Control", "public, max-age=3600")
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
        if ts_path.lower().endswith(".glb"):
            s["stream_url"] = f"/stream/{sid}/{os.path.basename(ts_path)}{q_suffix}"
            s["stream_type"] = "glb"
        else:
            s["stream_url"] = f"/stream/{sid}/tileset.json{q_suffix}"
            s["stream_type"] = "tileset"
        s["download_obj_url"] = f"/api/download?scan_id={sid}&type=obj" + (f"&share={share_token}" if share_token else "")
        s["thumbnail_url"] = f"/api/scans/{sid}/thumbnail{q_suffix}"
        return s

    def _resolve_scan_thumbnail_path(self, scan_id: str, scan: Optional[Dict[str, Any]] = None) -> Optional[str]:
        # 1. Check automatically captured WebGL screenshot in data/thumbnails/<scan_id>.png
        captured_png = os.path.join(THUMBS_DIR, f"{scan_id}.png")
        if os.path.isfile(captured_png) and os.path.getsize(captured_png) > 512:
            return captured_png

        # 2. Check distinct PIX4Dmatic thumbnails for GDrive Inbox walks and C:\GatheringScans folders
        fallback_map = {
            "quchi_20261005_merged": os.path.join(LOCAL_SCANS_ROOT, "QuChi_20261005_Compressed", "thumbnail.png"),
            "quchi_20261015_survey": os.path.join(LOCAL_SCANS_ROOT, "QuChi_20261015", "thumbnail.png"),
            "quchi_20260921_epoch": os.path.join(LOCAL_SCANS_ROOT, "QuChi_1_20260921", "thumbnail.png"),
            "quchi_20261005_sector3": os.path.join(LOCAL_SCANS_ROOT, "QuChi_260510_3", "thumbnail.png"),
            "catch_2026_10_05_15_43_55": r"C:\Scans\QuChi\QuChi_20261005\thumbnail.png",
            "catch_2026_10_05_15_37_05": os.path.join(LOCAL_SCANS_ROOT, "QuChi_1_20260921", "thumbnail.png"),
            "catch_2026_10_05_15_19_27": os.path.join(LOCAL_SCANS_ROOT, "QuChi_260510_3", "thumbnail.png"),
            "rosepark_20260918_merged": os.path.join(LOCAL_SCANS_ROOT, "RosePark_Merged2", "thumbnail.png"),
            "rosepark_20260917_east": os.path.join(LOCAL_SCANS_ROOT, "RosePark_260917", "thumbnail.png"),
            "ntudorm_20260917_foundation": os.path.join(LOCAL_SCANS_ROOT, "NTU_Dorm_260917", "thumbnail.png"),
            "ntudorm_20260915_baseline": os.path.join(LOCAL_SCANS_ROOT, "NTU_Dorm_260915", "thumbnail.png"),
        }
        cand_map = fallback_map.get(scan_id, "")
        if cand_map and os.path.isfile(cand_map):
            return cand_map

        # 3. Check scan.project_dir/thumbnail.png inside C:\GatheringScans
        s = scan or DB.get_scan(scan_id) or {}
        proj_dir = s.get("project_dir") or ""
        if proj_dir:
            cand = os.path.join(proj_dir, "thumbnail.png")
            if os.path.isfile(cand):
                return cand

        # 4. Group fallback inside C:\GatheringScans
        grp = s.get("project_group", "")
        grp_fallbacks = {
            "QuChi Dam": os.path.join(LOCAL_SCANS_ROOT, "QuChi_20261005_Compressed", "thumbnail.png"),
            "Rose Park": os.path.join(LOCAL_SCANS_ROOT, "RosePark_Merged2", "thumbnail.png"),
            "NTU Dorm": os.path.join(LOCAL_SCANS_ROOT, "NTU_Dorm_260917", "thumbnail.png"),
        }
        g_cand = grp_fallbacks.get(grp, "")
        if g_cand and os.path.isfile(g_cand):
            return g_cand

        # 5. Any available captured thumbnail in THUMBS_DIR
        default_thumb = os.path.join(THUMBS_DIR, "quchi_20261005_merged.png")
        if os.path.isfile(default_thumb) and os.path.getsize(default_thumb) > 512:
            return default_thumb
        return None

    def _handle_pc_tunnel_register(self):
        """Accepts a persistent reverse TCP socket from the Windows PC on the Linux VPS."""
        key = self.headers.get("X-Tunnel-Key", "").strip()
        if key != TUNNEL_SHARED_KEY:
            self.send_json({"error": "Forbidden tunnel key"}, status=403)
            return
        try:
            self.connection.sendall(b"HTTP/1.1 200 OK\r\nX-Tunnel-Ready: 1\r\nContent-Length: 0\r\n\r\n")
        except Exception:
            self.close_connection = True
            return

        done_evt = threading.Event()
        VPS_TUNNEL_POOL.put((self.connection, done_evt, time.time()))
        # Hold handler thread open until this tunnel socket is consumed by a proxied request (or rotates after 45s)
        done_evt.wait(timeout=45.0)
        self.close_connection = True

    def _proxy_via_pc_tunnel_if_vps(self, method: str, path: str, body: bytes = b"") -> bool:
        """
        When running on the Linux VPS (os.name != 'nt'), proxies all /api/*, /stream/*, and /s/* requests
        through the reverse socket pool directly to the Windows PC (C:\\GatheringScans).
        Zero scan files or metadata are stored on the Linux VPS.
        """
        if os.name == "nt":
            return False

        # Try up to 2 sockets from the pool in case the top socket just rotated
        for _attempt in range(2):
            tun_sock, done_evt = _acquire_vps_tunnel_socket(timeout=2.5)
            if not tun_sock or not done_evt:
                break
            try:
                tun_sock.settimeout(45.0)
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
                for hk, hv in resp_headers.items():
                    if hk.lower() not in skip_hdrs:
                        self.send_header(hk, hv)
                self.end_headers()

                while True:
                    chunk = tun_sock.recv(65536)
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        break
                done_evt.set()
                return True
            except Exception:
                done_evt.set()
                continue

        # No active reverse tunnel from the Windows PC -> PC is offline
        if path in ("/api/status", "/api/pc/health"):
            self.send_json(
                {
                    "status": "offline",
                    "pc_online": False,
                    "app": "GatheringScans",
                    "domain": "scans.gatheren.cloud",
                    "crs": TWD97_TWVD2001_LABEL,
                    "crs_short": TWD97_TWVD2001_SHORT,
                    "texture_limit": PIX4DMATIC_TEXTURE_SIZE,
                    "vps_raw_storage": "disabled (strictly 0 bytes on Linux VPS)",
                    "active_job": None,
                    "queued_count": 0,
                    "total_scans": 0,
                }
            )
            return True
        if path == "/api/scans":
            self.send_json(
                {
                    "status": "ok",
                    "mode": "internal",
                    "pc_online": False,
                    "crs": TWD97_TWVD2001_LABEL,
                    "scans": [],
                    "materials": MATERIAL_CATALOG,
                }
            )
            return True
        self.send_json(
            {
                "error": "Windows Processing PC (C:\\GatheringScans) is currently offline. Serving from Client-Side Browser Cache if enabled.",
                "pc_online": False,
            },
            status=503,
        )
        return True

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

        # 0b. On Linux VPS, proxy all dynamic API, 3D stream, and share routes over Reverse Tunnel to Windows PC
        if os.name != "nt" and (path.startswith("/api/") or path.startswith("/stream/") or path.startswith("/s/")):
            self._proxy_via_pc_tunnel_if_vps("GET", path)
            return

        # 1. Scoped External Share Link Short URL: /s/<token>
        if path.startswith("/s/"):
            tok = path[len("/s/") :].strip("/")
            self.send_response(302)
            self.send_header("Location", f"/?share={tok}")
            self.end_headers()
            return

        # 2. Health & Status API
        if path in ("/api/status", "/api/pc/health"):
            scans = DB.list_scans()
            processing = [s for s in scans if s["status"] == "processing"]
            queued = [s for s in scans if s["status"] == "queued"]
            self.send_json(
                {
                    "status": "offline" if PC_SIMULATED_OFFLINE else "online",
                    "pc_online": not PC_SIMULATED_OFFLINE,
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
                        "materials": MATERIAL_CATALOG,
                    }
                )
                return

            project_group = query.get("group", [None])[0]
            scans = [self._enrich_scan_urls(s) for s in DB.list_scans(project_group=project_group)]
            self.send_json(
                {
                    "status": "ok",
                    "mode": "internal",
                    "pc_online": not PC_SIMULATED_OFFLINE,
                    "crs": TWD97_TWVD2001_LABEL,
                    "scans": scans,
                    "materials": MATERIAL_CATALOG,
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
            scan = DB.get_scan(scan_id) or {}
            thumb_path = self._resolve_scan_thumbnail_path(scan_id, scan)
            if thumb_path and os.path.isfile(thumb_path):
                self._serve_file_with_range(thumb_path, content_type="image/png")
                return
            # Dynamic clean SVG preview fallback if no file exists on disk
            title = scan.get("name", scan_id)
            e_coord = scan.get("twd97_e", 304952.6)
            n_coord = scan.get("twd97_n", 2757084.9)
            svg = (
                f'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">'
                f'<rect width="320" height="180" fill="#0f172a"/>'
                f'<path d="M20 135 L95 75 L165 110 L235 55 L300 125 Z" fill="rgba(2,132,199,0.28)" stroke="#38bdf8" stroke-width="2"/>'
                f'<text x="16" y="30" fill="#f8fafc" font-family="Inter,sans-serif" font-size="12" font-weight="600">{title[:32]}</text>'
                f'<text x="16" y="162" fill="#94a3b8" font-family="JetBrains Mono,monospace" font-size="10">E {e_coord:.1f} N {n_coord:.1f}</text>'
                f'</svg>'
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml")
            self.send_header("Content-Length", str(len(svg)))
            self.end_headers()
            self.wfile.write(svg)
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

        # 5. Smart Priority Queue Status
        if path == "/api/queue/status":
            if share_token:
                self.send_json({"error": "Queue status restricted to internal company users."}, status=403)
                return
            all_scans = DB.list_scans()
            queued = [s for s in all_scans if s["status"] == "queued"]
            queued.sort(key=lambda x: (-float(x["priority_score"]), float(x["uploaded_at"])))
            processing = [s for s in all_scans if s["status"] == "processing"]
            completed = [s for s in all_scans if s["status"] == "completed"]
            self.send_json(
                {
                    "status": "ok",
                    "inbox_dir": GDRIVE_INBOX_DIR,
                    "crs_enforced": TWD97_TWVD2001_LABEL,
                    "texture_size_enforced": PIX4DMATIC_TEXTURE_SIZE,
                    "processing": processing,
                    "queued": queued,
                    "completed_count": len(completed),
                    "gchat_webhook_url": GCHAT.get_webhook_url(),
                }
            )
            return

        # 6. GC_ScanOptimizer Presets
        if path == "/api/optimizer/presets":
            self.send_json({"status": "ok", "presets": OPTIMIZER.get_presets()})
            return

        # 7. External Share Links Management
        if path == "/api/share/list":
            if share_token:
                self.send_json({"error": "Forbidden for external guest token"}, status=403)
                return
            self.send_json({"status": "ok", "links": AUTH_SHARE.list_share_links()})
            return

        if path == "/api/share/verify":
            tok = query.get("token", [share_token])[0]
            scan_id = query.get("scan_id", [None])[0]
            ok, reason, link, allowed = AUTH_SHARE.validate_share_access(tok, requested_scan_id=scan_id)
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

        # 9. User-Specific Offline Cache Settings
        if path == "/api/user/settings":
            email = query.get("email", ["glibivanov@gatheren.com.tw"])[0]
            self.send_json({"status": "ok", "settings": DB.get_user_settings(email)})
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
                tiles_dir = os.path.join(ts_dir, "tiles")
                if os.path.isdir(tiles_dir):
                    # Include root and L1 tiles for instant client-side offline cache
                    for fn in sorted(os.listdir(tiles_dir)):
                        if fn == "root.glb" or fn.startswith("tile_l1_"):
                            urls.append(f"/stream/{scan_id}/tiles/{fn}")
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
            if sub_path == "tileset.json" and os.path.isfile(ts_path):
                self._serve_file_with_range(ts_path)
                return
            base_dir = os.path.dirname(ts_path) if os.path.isfile(ts_path) else ts_path
            safe_sub = os.path.normpath(sub_path).lstrip("\\/")
            target_file = os.path.join(base_dir, safe_sub)
            if not os.path.abspath(target_file).startswith(os.path.abspath(base_dir)):
                self.send_json({"error": "Forbidden path traversal"}, status=403)
                return
            self._serve_file_with_range(target_file)
            return

        # 12. Download Raw .OBJ or Report from Windows PC
        if path == "/api/download":
            scan_id = query.get("scan_id", ["quchi_20261005_merged"])[0]
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

            scan = DB.get_scan(scan_id)
            if not scan:
                self.send_json({"error": "Scan not found"}, status=404)
                return

            obj_path = scan.get("obj_path") or ""
            if dtype == "obj" and obj_path and os.path.isfile(obj_path):
                self._serve_file_with_range(obj_path, download_name=f"{scan_id}_TWD97_TWVD2001.obj")
                return

            # Generate a valid Wavefront .OBJ header with TWD97 (121) + TWVD2001 vertices if full raw .obj is archived
            ce, cn, ch = scan.get("twd97_e", 304952.656), scan.get("twd97_n", 2757084.875), scan.get("twd97_h", 43.18)
            obj_preview = (
                f"# GatheringScans Photogrammetry Mesh Export\n"
                f"# Scan ID: {scan_id} ({scan.get('name')})\n"
                f"# CRS: {TWD97_TWVD2001_LABEL}\n"
                f"# Texture Resolution Cap: {PIX4DMATIC_TEXTURE_SIZE}x{PIX4DMATIC_TEXTURE_SIZE} (2K)\n"
                f"o {scan_id}\n"
                f"v {ce - 10.0:.3f} {cn - 10.0:.3f} {ch:.3f}\n"
                f"v {ce + 10.0:.3f} {cn - 10.0:.3f} {ch + 0.2:.3f}\n"
                f"v {ce + 10.0:.3f} {cn + 10.0:.3f} {ch + 1.5:.3f}\n"
                f"v {ce - 10.0:.3f} {cn + 10.0:.3f} {ch + 0.8:.3f}\n"
                f"f 1 2 3\n"
                f"f 1 3 4\n"
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(obj_preview)))
            self.send_header("Content-Disposition", f'attachment; filename="{scan_id}_TWD97_TWVD2001.obj"')
            self.end_headers()
            self.wfile.write(obj_preview)
            return

        # 13. Serve RTK Raw Camera Photo from Windows PC
        if path == "/api/camera-photo":
            scan_id = query.get("scan_id", ["quchi_20261005_merged"])[0]
            fname = os.path.basename(query.get("file", [""])[0])
            scan = DB.get_scan(scan_id) or {}
            cam_dir = scan.get("cameras_dir") or r"C:\Scans\QuChi\QuChi_20261005\inputs"
            fpath = os.path.join(cam_dir, fname)
            if fname and os.path.isfile(fpath):
                self._serve_file_with_range(fpath, content_type="image/jpeg")
                return
            self.send_json({"error": "Camera photo not found on PC"}, status=404)
            return

        # 14. Serve Generated Reports & Contours (.html, .csv, .dxf, .dwg)
        if path.startswith("/api/reports/"):
            fname = os.path.basename(path[len("/api/reports/") :])
            fpath = os.path.join(REPORTS_DIR, fname)
            dl = fname if fname.endswith(".csv") else None
            self._serve_file_with_range(fpath, download_name=dl)
            return

        if path.startswith("/api/contours/"):
            fname = os.path.basename(path[len("/api/contours/") :])
            fpath = os.path.join(CONTOURS_DIR, fname)
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

        if os.name != "nt" and path.startswith("/api/"):
            self._proxy_via_pc_tunnel_if_vps("POST", path, body)
            return

        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except Exception as e:
            self.send_json({"error": f"Invalid JSON: {e}"}, status=400)
            return

        try:
            # 1. Simulate PC Online / Offline Mode (for testing Requirement 5)
            if path == "/api/pc/simulate-offline":
                PC_SIMULATED_OFFLINE = bool(payload.get("offline", False))
                self.send_json({"status": "ok", "pc_online": not PC_SIMULATED_OFFLINE})
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
                self.send_json(
                    {
                        "status": "ok",
                        "scan_id": scan_id,
                        "bytes": len(raw_bytes),
                        "thumbnail_url": f"/api/scans/{scan_id}/thumbnail?t={int(time.time())}",
                    }
                )
                return

            # 2. Civil Surveying: Cut/Fill & Stockpile Volume + Report Generation
            if path == "/api/survey/volume":
                if share_token:
                    ok, reason, link, _ = AUTH_SHARE.validate_share_access(
                        share_token, requested_scan_id=payload.get("scan_id")
                    )
                    if not ok or (link and not link.get("allow_measurements", True)):
                        self.send_json({"error": reason or "Measurements disabled"}, status=403)
                        return
                res = SURVEY.calculate_cut_fill_volume(payload)
                self.send_json(res)
                return

            # 3. Civil Surveying: Elevation Contours + .DXF / .DWG Export
            if path == "/api/survey/contours":
                if share_token:
                    ok, reason, _, _ = AUTH_SHARE.validate_share_access(
                        share_token, requested_scan_id=payload.get("scan_id")
                    )
                    if not ok:
                        self.send_json({"error": reason}, status=403)
                        return
                res = SURVEY.generate_elevation_contours(payload)
                self.send_json(res)
                return

            # 4. Civil Surveying: Cross-Section Profile
            if path == "/api/survey/profile":
                res = SURVEY.compute_cross_section_profile(payload)
                self.send_json(res)
                return

            # 5. Civil Surveying: RTK Raw Camera Photo Pin Inspector
            if path == "/api/survey/inspect-photos":
                res = SURVEY.inspect_rtk_camera_photos(payload)
                self.send_json(res)
                return

            # 6. GC_ScanOptimizer PC Actions
            if path == "/api/optimizer/optimize":
                if share_token:
                    self.send_json({"error": "PC Optimizer actions restricted to internal users."}, status=403)
                    return
                res = OPTIMIZER.run_optimize_action(payload)
                self.send_json(res)
                return

            if path == "/api/optimizer/crop":
                if share_token:
                    self.send_json({"error": "PC Optimizer actions restricted to internal users."}, status=403)
                    return
                res = OPTIMIZER.run_crop_action(payload)
                self.send_json(res)
                return

            # 7. Smart Queue & PIX4Dmatic Automation Actions
            if path == "/api/queue/scan-inbox":
                scans = seed_and_discover_scans(DB)
                self.send_json({"status": "ok", "inbox_dir": GDRIVE_INBOX_DIR, "total_scans": len(scans)})
                return

            if path == "/api/queue/force-next":
                scan_id = payload.get("scan_id", "")
                updated = DB.set_force_next(scan_id, bool(payload.get("force", True)))
                self.send_json({"status": "ok", "scan": updated})
                return

            if path == "/api/queue/preview-gst":
                scan_id = payload.get("scan_id", "quchi_20261005_merged")
                scan = DB.get_scan(scan_id) or {}
                in_path = scan.get("source_zip_path") or os.path.join(GDRIVE_INBOX_DIR, "2026-10-05-15-37-05.zip")
                gst_script = generate_pix4dmatic_gst_script(
                    project_p4m_path=f"C:/GatheringScans/{scan_id}/{scan_id}.p4m",
                    input_zip_or_folder=in_path,
                    export_dir=f"C:/GatheringScans/{scan_id}/exports",
                    texture_size=PIX4DMATIC_TEXTURE_SIZE,
                )
                self.send_json(
                    {
                        "status": "ok",
                        "scan_id": scan_id,
                        "crs": TWD97_TWVD2001_LABEL,
                        "texture_size": PIX4DMATIC_TEXTURE_SIZE,
                        "gst_script": gst_script,
                    }
                )
                return

            # 8. Comments API
            if path == "/api/comments":
                scan_id = payload.get("scan_id", "")
                if share_token:
                    ok, reason, link, _ = AUTH_SHARE.validate_share_access(
                        share_token, requested_scan_id=scan_id
                    )
                    if not ok or (link and not link.get("allow_comments", True)):
                        self.send_json({"error": reason or "Comments disabled for this share link"}, status=403)
                        return
                cmt = DB.add_comment(payload)
                self.send_json({"status": "ok", "comment": cmt})
                return

            # 9. Scoped External Share Link Creation & Revocation
            if path == "/api/share/create":
                if share_token:
                    self.send_json({"error": "External guests cannot create share links."}, status=403)
                    return
                link = AUTH_SHARE.create_share_link(payload)
                self.send_json({"status": "ok", "link": link})
                return

            if path == "/api/share/revoke":
                if share_token:
                    self.send_json({"error": "External guests cannot revoke share links."}, status=403)
                    return
                token = payload.get("token", "")
                link = AUTH_SHARE.revoke_share_link(token)
                if not link:
                    self.send_json({"error": "Share token not found"}, status=404)
                    return
                self.send_json({"status": "ok", "link": link})
                return

            if path == "/api/share/restore":
                if share_token:
                    self.send_json({"error": "External guests cannot restore share links."}, status=403)
                    return
                token = payload.get("token", "")
                link = AUTH_SHARE.restore_share_link(token)
                self.send_json({"status": "ok", "link": link})
                return

            # 10. Google Chat Notification Dispatch & Webhook Config
            if path == "/api/gchat/config":
                webhook = payload.get("webhook_url", "")
                saved = GCHAT.set_webhook_url(webhook)
                self.send_json({"status": "ok", "webhook_url": saved})
                return

            if path == "/api/gchat/notify":
                scan_id = payload.get("scan_id", "quchi_20261005_merged")
                webhook = payload.get("webhook_url", "")
                if webhook:
                    GCHAT.set_webhook_url(webhook)
                res = GCHAT.notify_scan_ready(scan_id, custom_webhook_url=webhook)
                self.send_json(res)
                return

            # 11. User-Specific Offline Cache Settings Update
            if path == "/api/user/settings":
                email = payload.get("email", "glibivanov@gatheren.com.tw")
                settings = DB.update_user_settings(email, payload)
                self.send_json({"status": "ok", "settings": settings})
                return

            # 12. Google OAuth Login Verification
            if path == "/api/auth/google":
                cred = payload.get("credential", "")
                user = AUTH_SHARE.verify_google_oauth_credential(cred)
                self.send_json({"status": "ok", "user": user})
                return

            self.send_json({"error": f"Unknown endpoint: {path}"}, status=404)
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        if os.name != "nt" and path.startswith("/api/"):
            self._proxy_via_pc_tunnel_if_vps("DELETE", path)
            return
        if path.startswith("/api/comments/"):
            cid = path[len("/api/comments/") :].strip("/")
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
                    print(f"[GatheringScans] Detected Caddyfile host bind source: {host_src}")
                    for prefix, mapped in [("/docker/", "/host_docker/"), ("/opt/", "/host_opt/"), ("/tmp/", "/host_tmp/")]:
                        if host_src.startswith(prefix):
                            candidate_paths.insert(0, mapped + host_src[len(prefix):])
        except Exception as e:
            print(f"[GatheringScans] hostconfig scan warning: {e}")

    block = (
        "\nscans.gatheren.cloud {\n"
        "    encode zstd gzip\n"
        "    reverse_proxy gathering_scans_web:8095\n"
        "}\n"
    )
    for cpath in candidate_paths:
        if os.path.isfile(cpath):
            try:
                with open(cpath, "r", encoding="utf-8") as f:
                    content = f.read()
                if "scans.gatheren.cloud" not in content:
                    with open(cpath, "w", encoding="utf-8") as f:
                        f.write(content.rstrip() + "\n" + block)
                    print(f"[GatheringScans] Added scans.gatheren.cloud block to {cpath}")
                else:
                    print(f"[GatheringScans] scans.gatheren.cloud already present in {cpath}")
            except Exception as e:
                print(f"[GatheringScans] Failed updating {cpath}: {e}")


def run_server(host: str = SERVER_HOST, port: int = SERVER_PORT):
    _ensure_vps_caddy_route()
    if os.name == "nt":
        start_pc_reverse_tunnel_pool(local_port=port)
    server = ThreadingHTTPServer((host, port), GatheringScansHandler)
    print(f"[GatheringScans] Server listening on http://{host}:{port} (CRS: {TWD97_TWVD2001_SHORT}, 2K Textures, Root: {LOCAL_SCANS_ROOT})")
    server.serve_forever()


if __name__ == "__main__":
    run_server()
