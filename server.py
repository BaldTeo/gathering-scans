#!/usr/bin/env python3
"""
GatheringScans (scans.gatheren.cloud) — Unified HTTP Range-Streaming & Civil Surveying Server
Modular Architecture (< 2,650 lines per file):
- pc_worker/server_cloud_and_tunnel.py: Daemon state, GDrive .3tz Cloud Range Streaming, Reverse Socket Tunnel Pool & Caddy Watchdog
- pc_worker/server_api_routes.py: POST & DELETE API Route Handlers Mixin
- server.py: GatheringScansHandler Core, GET/Stream Static & Dynamic Routes, and Server Entrypoint
"""

import os
import re
import sys
import gzip
import json
import time
import queue
import socket
import struct
import base64
import shutil
import html
import hashlib
import mimetypes
import threading
import urllib.parse
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, Any, Optional, Tuple, List

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
from pc_worker.pix4d_runner import (
    generate_pix4dmatic_gst_script,
    parse_pix4dmatic_log_progress,
)
from pc_worker.auth_and_sharing import (
    ROLE_LEVELS,
    ROLE_LABELS,
    normalize_role,
    get_role_permissions,
    verify_session_token,
    is_link_preview_bot,
    parse_user_agent,
)
from pc_worker.server_cloud_and_tunnel import (
    DATA_DIR,
    WEB_DIR,
    THUMBS_DIR,
    GLB_CACHE_DIR,
    DB,
    OPTIMIZER,
    SURVEY,
    AUTH_SHARE,
    GCHAT,
    DAEMON_STATE_PATH,
    _DAEMON_WAKE_EVENT,
    _PIX4D_WAKE_EVENT,
    VPS_TUNNEL_POOL,
    _VPS_RAM_FALLBACK_CACHE,
    CLOUD_MANIFEST_PATH,
    CLOUD_AUTH_PATH,
    load_pc_daemon_state,
    is_pc_daemon_running,
    is_pc_simulated_offline,
    mark_daemon_poll_completed,
    set_pc_daemon_running,
    get_pc_daemon_status,
    sync_scans_with_filesystem,
    _load_cloud_manifest,
    _save_cloud_manifest,
    _load_cloud_auth,
    _save_cloud_auth,
    _get_gdrive_bearer_token,
    _test_gdrive_service_account,
    _fetch_gdrive_byte_slice,
    _recv_exact,
    _acquire_vps_tunnel_socket,
    start_pc_reverse_tunnel_pool,
    _ensure_vps_caddy_route,
    _vps_caddy_watchdog_loop,
    _pc_cloud_manifest_sync_loop,
    CloudAndTunnelHandlerMixin,
)
from pc_worker.server_api_routes import ServerWriteRoutesMixin


class GatheringScansHandler(CloudAndTunnelHandlerMixin, ServerWriteRoutesMixin, SimpleHTTPRequestHandler):
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
            "Content-Type, Authorization, X-Share-Token, X-Session-Token, X-Telemetry-Session, X-Client-IP, X-Tunnel-Key, X-User-Email, X-User-Name, Range",
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
            ua = self.headers.get("User-Agent", "")
            if is_link_preview_bot(ua):
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                return
            self.send_response(302)
            self.send_header("Location", f"/?share={safe_tok}")
            self.end_headers()
            return
        if path.startswith("/api/scans/") and (path.endswith("/thumbnail") or path.endswith("/thumbnail.png")):
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Cache-Control", "public, max-age=3600")
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

    def _extract_client_ip(self) -> str:
        for hdr in ("CF-Connecting-IP", "True-Client-IP", "X-Real-IP"):
            val = (self.headers.get(hdr) or "").strip()
            if val:
                return val.split(",")[0].strip()
        xff = (self.headers.get("X-Forwarded-For") or "").strip()
        if xff:
            parts = [p.strip() for p in xff.split(",") if p.strip()]
            for p in parts:
                if not p.startswith(("127.", "10.", "172.16.", "172.17.", "172.18.", "172.19.", "172.2", "172.30.", "172.31.", "192.168.", "::1")):
                    return p
            if parts:
                return parts[0]
        xci = (self.headers.get("X-Client-IP") or "").strip()
        if xci:
            return xci.split(",")[0].strip()
        try:
            return str(self.client_address[0] or "")
        except Exception:
            return ""

    def _resolve_public_origin(self) -> str:
        fwd_proto = (self.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
        host_hdr = (self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or "").split(",")[0].strip()
        if host_hdr and not host_hdr.startswith(("127.0.0.1", "localhost", "0.0.0.0")):
            scheme = fwd_proto if fwd_proto in ("http", "https") else "https"
            return f"{scheme}://{host_hdr}".rstrip("/")
        return PUBLIC_BASE_URL.rstrip("/")

    def _build_share_preview_meta(self, share_token: str) -> Dict[str, str]:
        tok = (share_token or "").strip()
        safe_tok = urllib.parse.quote(tok, safe="-_")
        origin = self._resolve_public_origin()
        share_url = f"{origin}/s/{safe_tok}" if safe_tok else origin
        default_img = f"{origin}/assets/gathering_cloud_logo.png"

        ok, _, link, allowed_scans = AUTH_SHARE.validate_share_access(tok, increment_view=False)
        if not ok and tok:
            ok_c, _, link_c, allowed_c = self._validate_cloud_share_token(tok)
            if ok_c:
                ok, link, allowed_scans = ok_c, link_c, allowed_c
            elif link_c and not link:
                link = link_c

        if not ok or not link:
            return {
                "title": "GatheringCloud 3D Scan · Link Inactive",
                "description": "This shared 3D scan link is inactive or has been revoked.",
                "image": default_img,
                "url": share_url,
                "redirect_url": f"/?share={safe_tok}" if safe_tok else "/",
            }

        allow_meas = bool(link.get("allow_measurements", False))
        allow_cmts = bool(link.get("allow_comments", False))
        allow_dl = bool(link.get("allow_download", False))
        if allow_meas and allow_cmts and allow_dl:
            perms_short = "View, Measure, Comment & Download"
        elif allow_meas and allow_cmts:
            perms_short = "View, Measure & Comment"
        elif not allow_meas and allow_cmts and not allow_dl:
            perms_short = "View & Comment"
        elif allow_meas and not allow_cmts:
            perms_short = "View & Measure"
        else:
            perms_short = "3D View"

        scope_type = str(link.get("scope_type") or "scan").lower()
        target_id = str(link.get("target_id") or "")

        # Fallback scan lookup from cloud manifest if PC/VPS DB didn't return scan rows
        if not allowed_scans:
            m_scans = (_load_cloud_manifest().get("scans") or [])
            if scope_type == "scan":
                allowed_scans = [s for s in m_scans if str(s.get("scan_id")) == target_id]
            else:
                allowed_scans = [s for s in m_scans if str(s.get("project_group")) == target_id]

        lead_scan = allowed_scans[0] if allowed_scans else None
        if lead_scan and lead_scan.get("scan_id"):
            lead_sid = urllib.parse.quote(str(lead_scan["scan_id"]), safe="-_")
            img_url = f"{origin}/api/scans/{lead_sid}/thumbnail.png?share={safe_tok}"
        else:
            img_url = default_img

        if scope_type == "group":
            n_scans = len(allowed_scans)
            count_txt = f"{n_scans} Scans" if n_scans != 1 else "1 Scan"
            title = f"{target_id} ({count_txt}) · 3D Site"
            desc = f"Interactive 3D site ({count_txt.lower()}) · {perms_short} · Tap to explore in 3D."
        else:
            scan_name = str((lead_scan or {}).get("name") or link.get("label") or target_id).strip()
            if scan_name.startswith("View & Comment — "):
                scan_name = scan_name[len("View & Comment — ") :].strip()
            elif scan_name.startswith("External View — "):
                scan_name = scan_name[len("External View — ") :].strip()
            site_grp = str((lead_scan or {}).get("project_group") or "").strip()
            cap_date = str((lead_scan or {}).get("capture_date") or "").strip()
            title = f"{scan_name} · 3D Scan"
            meta_bits = ["Interactive 3D scan"]
            if site_grp and site_grp.lower() not in scan_name.lower():
                meta_bits.append(f"Site: {site_grp}")
            elif cap_date:
                meta_bits.append(cap_date)
            meta_bits.append(perms_short)
            desc = " · ".join(meta_bits) + ". Tap to explore in 3D."

        return {
            "title": title[:95],
            "description": desc[:160],
            "image": img_url,
            "url": share_url,
            "redirect_url": f"/?share={safe_tok}",
        }

    def _render_share_og_tags_block(self, meta: Dict[str, str]) -> str:
        t = html.escape(meta.get("title") or "GatheringCloud 3D Scans", quote=True)
        d = html.escape(meta.get("description") or "Interactive 3D site scan on GatheringCloud.", quote=True)
        im = html.escape(meta.get("image") or "", quote=True)
        u = html.escape(meta.get("url") or PUBLIC_BASE_URL, quote=True)
        return (
            f"  <title>{t}</title>\n"
            f'  <meta name="description" content="{d}" />\n'
            f'  <meta property="og:site_name" content="GatheringCloud 3D Scans" />\n'
            f'  <meta property="og:type" content="website" />\n'
            f'  <meta property="og:title" content="{t}" />\n'
            f'  <meta property="og:description" content="{d}" />\n'
            f'  <meta property="og:url" content="{u}" />\n'
            f'  <meta property="og:image" content="{im}" />\n'
            f'  <meta property="og:image:type" content="image/png" />\n'
            f'  <meta property="og:image:width" content="640" />\n'
            f'  <meta property="og:image:height" content="360" />\n'
            f'  <meta name="twitter:card" content="summary_large_image" />\n'
            f'  <meta name="twitter:title" content="{t}" />\n'
            f'  <meta name="twitter:description" content="{d}" />\n'
            f'  <meta name="twitter:image" content="{im}" />'
        )

    def _record_and_forward_bot_unfurl(self, token: str):
        tok = (token or "").strip()
        if not tok:
            return
        ip_addr = self._extract_client_ip()
        ua_str = self.headers.get("User-Agent", "")
        ref_str = self.headers.get("Referer", "")
        entry_u = self.path
        try:
            AUTH_SHARE.record_bot_unfurl(tok, ip_address=ip_addr, user_agent=ua_str, referrer=ref_str, entry_url=entry_u)
        except Exception:
            pass
        if os.name != "nt":
            def _bg_fwd():
                tun_sock, done_evt, proto_ver = _acquire_vps_tunnel_socket(timeout=1.5)
                if not tun_sock or not done_evt:
                    return
                try:
                    tun_sock.settimeout(5.0)
                    ua_info = parse_user_agent(ua_str)
                    ua_browser = ua_info.get("browser") or "Bot"
                    bucket = int(time.time() // 30)
                    bot_sid = f"bot_{hashlib.sha1(f'{tok}|{ip_addr}|{ua_str}|{bucket}'.encode('utf-8')).hexdigest()[:16]}"
                    bot_vid = f"bot_{hashlib.sha1(f'{ip_addr}|{ua_browser}'.encode('utf-8')).hexdigest()[:12]}"
                    body_bytes = json.dumps(
                        {
                            "token": tok,
                            "session_id": bot_sid,
                            "visitor_id": bot_vid,
                            "viewer_name": ua_browser if ua_browser != "Bot" else "Link Preview Bot",
                            "is_bot": True,
                            "entry_url": entry_u,
                            "events": [{"t": 0, "type": "preview_unfurl", "detail": f"Link preview fetched ({ua_browser})"}],
                        }
                    ).encode("utf-8")
                    env = json.dumps(
                        {
                            "method": "POST",
                            "path": "/api/share/telemetry",
                            "headers": {
                                "Content-Type": "application/json",
                                "User-Agent": ua_str,
                                "Referer": ref_str,
                                "X-Client-IP": ip_addr,
                                "X-Share-Token": tok,
                            },
                            "body_b64": base64.b64encode(body_bytes).decode("ascii"),
                        }
                    ).encode("utf-8")
                    tun_sock.sendall(struct.pack("!I", len(env)) + env)
                    lb = _recv_exact(tun_sock, 4)
                    if lb:
                        (ml,) = struct.unpack("!I", lb)
                        mr = _recv_exact(tun_sock, ml)
                        if mr:
                            rm = json.loads(mr.decode("utf-8"))
                            if rm.get("chunked_v2"):
                                while True:
                                    cb = _recv_exact(tun_sock, 4)
                                    if not cb:
                                        break
                                    (cl,) = struct.unpack("!I", cb)
                                    if cl == 0:
                                        break
                                    _recv_exact(tun_sock, cl)
                                VPS_TUNNEL_POOL.put((tun_sock, done_evt, time.time(), proto_ver))
                                return
                    done_evt.set()
                except Exception:
                    done_evt.set()

            threading.Thread(target=_bg_fwd, daemon=True).start()

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
                    valid_c1 = []
                    for c1 in root.get("children") or []:
                        if not isinstance(c1, dict):
                            continue
                        c1_c = c1.get("content") or {}
                        if isinstance(c1_c, dict) and c1_c.get("uri"):
                            u1 = c1_c["uri"].split("?")[0]
                            f1 = os.path.join(base_dir, u1)
                            if os.path.isfile(f1):
                                c1_c["uri"] = f"{u1}?v={int(os.path.getmtime(f1))}"
                        valid_c2 = []
                        for c2 in c1.get("children") or []:
                            if not isinstance(c2, dict):
                                continue
                            c2_c = c2.get("content") or {}
                            if isinstance(c2_c, dict) and c2_c.get("uri"):
                                u2 = c2_c["uri"].split("?")[0]
                                f2 = os.path.join(base_dir, u2)
                                if os.path.isfile(f2):
                                    c2_c["uri"] = f"{u2}?v={int(os.path.getmtime(f2))}"
                            c2["geometricError"] = 0.0
                            c2["children"] = []
                            valid_c2.append(c2)
                        c1["children"] = valid_c2
                        if valid_c2:
                            c1["geometricError"] = max(float(c1.get("geometricError") or 0.0), 8.0)
                        else:
                            c1["geometricError"] = 0.0
                        valid_c1.append(c1)
                    if valid_c1:
                        root["children"] = valid_c1
                        root["geometricError"] = max(float(root.get("geometricError") or 0.0), 24.0)
                        ts["geometricError"] = max(float(ts.get("geometricError") or 0.0), float(root["geometricError"]))
                    else:
                        root["geometricError"] = 0.0
                        root["children"] = []
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
                        if not (_root.get("children")) and _rf and os.path.isfile(_rf):
                            leaf_glbs = [_rf]
                        else:
                            def _walk_m(node: dict, depth: int = 0):
                                _chs = [c for c in (node.get("children") or []) if isinstance(c, dict)]
                                if _chs and depth < 2:
                                    for _ch in _chs:
                                        _walk_m(_ch, depth + 1)
                                    return
                                _cu = ((node.get("content") or {}).get("uri") or "").split("?")[0]
                                if _cu:
                                    _cf = os.path.join(bdir_m, _cu)
                                    if os.path.isfile(_cf):
                                        leaf_glbs.append(_cf)
                            _walk_m(_root, 0)
                            if not leaf_glbs and _rf and os.path.isfile(_rf):
                                leaf_glbs = [_rf]

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
        s["ortho_url"] = f"/api/scans/{sid}/ortho{thumb_q}"
        try:
            saved_ortho = SURVEY.get_saved_ortho_meta(sid, s)
            if isinstance(saved_ortho, dict) and saved_ortho.get("north_lat") is not None:
                s["ortho_bounds"] = {
                    "north_lat": saved_ortho["north_lat"],
                    "south_lat": saved_ortho["south_lat"],
                    "west_lon": saved_ortho["west_lon"],
                    "east_lon": saved_ortho["east_lon"],
                    "min_e": saved_ortho.get("min_e"),
                    "max_e": saved_ortho.get("max_e"),
                    "min_n": saved_ortho.get("min_n"),
                    "max_n": saved_ortho.get("max_n"),
                    "width": saved_ortho.get("width"),
                    "height": saved_ortho.get("height"),
                    "resolution_m": saved_ortho.get("resolution_m"),
                }
        except Exception:
            pass
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

    def _sanitize_single_profile(
        self, prof: Optional[Dict[str, Any]], is_admin: bool = False
    ) -> Optional[Dict[str, Any]]:
        if not isinstance(prof, dict):
            return None
        out = dict(prof)
        if not is_admin:
            out.pop("googleSub", None)
            out.pop("google_sub", None)
            out.pop("gchat_user_id", None)
            out.pop("allowedProjects", None)
        return out

    def _filter_profiles_for_caller(
        self,
        profiles_list: List[Dict[str, Any]],
        actor_email: str,
        is_admin: bool = False,
    ) -> List[Dict[str, Any]]:
        if is_admin:
            return list(profiles_list or [])
        clean_em = (actor_email or "").strip().lower()
        if not clean_em or clean_em in ("guest", "guest@anonymous", "guest@external"):
            return []
        out = []
        for p in profiles_list or []:
            if str(p.get("email") or "").strip().lower() == clean_em:
                san = self._sanitize_single_profile(p, is_admin=False)
                if san:
                    out.append(san)
        return out

    def do_GET(self):
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
            _, _, cm_perms = self._resolve_request_role(None, query, share_token)
            if share_token or not cm_perms.get("can_manage_users"):
                self.send_json({"error": "Owner or Admin session required to inspect Cloud Service Account status."}, status=403)
                return
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

        # 0b. Scoped External Share Link Short URL: /s/<token>
        # Serves rich, short Open Graph / Twitter Card HTML directly to chat link-preview crawlers
        # (LINE, WhatsApp, Slack, Telegram, Discord, iMessage, etc.) while 302-redirecting browsers in <1ms.
        if path.startswith("/s/"):
            tok = path[len("/s/") :].strip("/")
            safe_tok = urllib.parse.quote(tok, safe="-_")
            ua_hdr = self.headers.get("User-Agent", "")
            if is_link_preview_bot(ua_hdr):
                self._record_and_forward_bot_unfurl(tok)
                meta = self._build_share_preview_meta(tok)
                og_block = self._render_share_og_tags_block(meta)
                redir_u = html.escape(meta.get("redirect_url") or f"/?share={safe_tok}", quote=True)
                safe_title = html.escape(meta.get("title") or "GatheringCloud 3D Scans")
                safe_desc = html.escape(meta.get("description") or "")
                bot_html = (
                    "<!DOCTYPE html>\n"
                    '<html lang="zh-Hant">\n'
                    "<head>\n"
                    '  <meta charset="UTF-8" />\n'
                    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n'
                    f"{og_block}\n"
                    f'  <meta http-equiv="refresh" content="0;url={redir_u}" />\n'
                    "</head>\n"
                    "<body>\n"
                    f"  <h1>{safe_title}</h1>\n"
                    f"  <p>{safe_desc}</p>\n"
                    f'  <script>window.location.replace("{redir_u}");</script>\n'
                    "</body>\n"
                    "</html>\n"
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(bot_html)))
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(bot_html)
                return
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
                    "status": "offline" if (is_pc_simulated_offline() or not d_running) else "online",
                    "pc_online": (not is_pc_simulated_offline()) and d_running,
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
                is_bg_poll = (query.get("bg", ["0"])[0] == "1")
                has_telem_hdr = bool(self.headers.get("X-Telemetry-Session", "").strip())
                ua_scan = self.headers.get("User-Agent", "")
                inc_view = (not is_bg_poll) and (not has_telem_hdr) and (not is_link_preview_bot(ua_scan))
                ok, reason, link, allowed_scans = AUTH_SHARE.validate_share_access(
                    share_token, increment_view=inc_view
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
            actor_em, _, _ = self._resolve_request_role(None, query, share_token)
            pref_em = (
                actor_em
                if (actor_em and actor_em not in ("guest", "guest@anonymous", "guest@external", "guest@gatheren.cloud"))
                else str(self.headers.get("X-User-Email") or (query.get("user_email") or [None])[0] or "").strip().lower()
            )
            user_settings = (
                DB.get_user_settings(pref_em)
                if (pref_em and pref_em not in ("guest", "guest@anonymous", "guest@external", "guest@gatheren.cloud"))
                else None
            )
            self.send_json(
                {
                    "status": "ok",
                    "mode": "internal",
                    "pc_online": (not is_pc_simulated_offline()) and d_running,
                    "daemon_running": d_running,
                    "crs": TWD97_TWVD2001_LABEL,
                    "scans": scans,
                    "projects": self._build_projects_summary(scans),
                    "bin_scans_count": len(bin_scans),
                    "materials": MATERIAL_CATALOG,
                    "google_client_id": GOOGLE_OAUTH_CLIENT_ID,
                    "user_settings": user_settings,
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

        # 3c. True-Nadir Transparent RGBA Orthomosaic & Geographic Bounds Endpoints:
        # GET /api/scans/<scan_id>/ortho-meta and GET /api/scans/<scan_id>/ortho(.png)
        if path.startswith("/api/scans/") and path.endswith("/ortho-meta"):
            scan_id = path[len("/api/scans/") : -len("/ortho-meta")].strip("/")
            if share_token:
                ok, reason, _, _ = AUTH_SHARE.validate_share_access(share_token, requested_scan_id=scan_id)
                if not ok:
                    self.send_json({"error": reason}, status=403)
                    return
            meta = SURVEY.get_or_generate_true_nadir_ortho(scan_id, force=False)
            if isinstance(meta, dict) and meta.get("north_lat") is not None:
                clean_bounds = {k: v for k, v in meta.items() if k not in ("png_path", "json_path")}
                self.send_json(
                    {
                        "status": "ok",
                        "ok": True,
                        "scan_id": scan_id,
                        "ortho_bounds": clean_bounds,
                        "ortho_url": f"/api/scans/{scan_id}/ortho",
                    }
                )
            else:
                self.send_json({"error": f"True-nadir orthomosaic not available for scan: {scan_id}"}, status=404)
            return

        if path.startswith("/api/scans/") and (path.endswith("/ortho") or path.endswith("/ortho.png")):
            suffix = "/ortho.png" if path.endswith("/ortho.png") else "/ortho"
            scan_id = path[len("/api/scans/") : -len(suffix)].strip("/")
            if share_token:
                ok, reason, _, _ = AUTH_SHARE.validate_share_access(share_token, requested_scan_id=scan_id)
                if not ok:
                    self.send_json({"error": reason}, status=403)
                    return
            meta = SURVEY.get_or_generate_true_nadir_ortho(scan_id, force=False)
            if isinstance(meta, dict) and meta.get("png_path") and os.path.isfile(meta["png_path"]):
                self._serve_file_with_range(meta["png_path"], content_type="image/png")
                return
            self.send_json({"error": f"True-nadir orthomosaic PNG not available for scan: {scan_id}"}, status=404)
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
            _, _, q_perms = self._resolve_request_role(None, query, share_token)
            is_q_admin = bool(q_perms.get("can_manage_users"))
            self.send_json(
                {
                    "status": "ok",
                    "inbox_dir": GDRIVE_INPUTS_DIR if is_q_admin else "",
                    "crs_enforced": TWD97_TWVD2001_LABEL,
                    "texture_size_enforced": p4d_cfg.get("texture_size", PIX4DMATIC_TEXTURE_SIZE),
                    "pix4d_settings": p4d_cfg,
                    "processing": processing,
                    "queued": queued,
                    "all_scans": all_scans,
                    "live_pix4d": live_log_info,
                    "completed_count": len(completed),
                    "gchat_webhook_url": GCHAT.get_webhook_url() if is_q_admin else "",
                }
            )
            return

        if path == "/api/pix4d/settings":
            _, _, p4d_perms = self._resolve_request_role(None, query, share_token)
            if share_token or not (p4d_perms.get("can_manage_users") or p4d_perms.get("can_run_workflows")):
                self.send_json({"error": "Editor, Admin, or Owner session required to inspect pipeline settings."}, status=403)
                return
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

        # 6c. Saved Measurement Bookmarks Retrieval (GET /api/measurements/bookmarks?scan_id=...)
        if path == "/api/measurements/bookmarks":
            scan_id = (query.get("scan_id") or [""])[0].strip()
            if not scan_id:
                self.send_json({"error": "Missing required parameter: scan_id"}, status=400)
                return
            if share_token:
                ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(share_token, requested_scan_id=scan_id)
                if not ok_s or not (link_s and link_s.get("allow_measurements", True)):
                    self.send_json({"error": "Measurements are disabled for this external share link."}, status=403)
                    return
            bms = DB.list_measurement_bookmarks(scan_id)
            self.send_json({"status": "ok", "scan_id": scan_id, "bookmarks": bms})
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

        if path == "/api/share/analytics":
            if share_token:
                self.send_json({"error": "Forbidden for external guest token"}, status=403)
                return
            _, actor_role_an, actor_perms_an = self._resolve_request_role(None, query, share_token)
            if not actor_perms_an.get("can_share"):
                self.send_json({"error": f"Role '{actor_role_an}' cannot inspect share link analytics."}, status=403)
                return
            tok_q = (query.get("token") or [""])[0].strip()
            try:
                lim_q = max(10, min(500, int((query.get("limit") or ["200"])[0])))
            except Exception:
                lim_q = 200
            analytics_res = AUTH_SHARE.get_share_analytics(token=tok_q or None, limit=lim_q)
            if os.name != "nt" and tok_q and not analytics_res.get("link"):
                m_links = _load_cloud_manifest().get("share_links") or []
                m_match = next((l for l in m_links if l.get("token") == tok_q), None)
                if m_match:
                    analytics_res["link"] = m_match
            self.send_json(analytics_res)
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

        # 8. Google Chat Notification History, Interactive Mesh Island Decision & App Connection Status
        if path == "/api/gchat/island-decision":
            from pc_worker.pix4d_runner import apply_mesh_island_decision

            sid = str((query.get("scan_id") or [""])[0] or "").strip()
            dec = str((query.get("decision") or [""])[0] or "").strip()
            tok = str((query.get("token") or [""])[0] or "").strip()
            fmt = str((query.get("format") or [""])[0] or "").strip().lower()
            if not sid or not dec:
                self.send_json({"error": "scan_id and decision ('split' or 'combine') required"}, status=400)
                return
            try:
                res_dec = apply_mesh_island_decision(sid, dec, token=tok)
                if fmt == "json" or "application/json" in str(self.headers.get("Accept") or ""):
                    self.send_json(res_dec)
                    return
                label_zh = "拆分為 2 個獨立掃描 (Yes — Create 2 Separate Scans)" if res_dec.get("decision") == "split" else "保留為 1 個合併掃描 (No — Keep 1 Combined Scan)"
                html_body = (
                    "<!DOCTYPE html><html><head><meta charset='utf-8'>"
                    "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                    "<title>GatheringScans — 網格區塊處理確認</title>"
                    "<style>body{background:#0f172a;color:#f8fafc;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:92vh;margin:0;padding:16px}"
                    ".card{background:#1e293b;border:1px solid #334155;border-radius:14px;max-width:480px;padding:28px;box-shadow:0 12px 32px rgba(0,0,0,0.4)}"
                    "h2{margin:0 0 12px;color:#38bdf8;font-size:20px}p{line-height:1.6;color:#cbd5e1;font-size:15px}"
                    ".badge{display:inline-block;background:#0284c7;color:#fff;padding:6px 12px;border-radius:8px;font-weight:600;margin:8px 0}"
                    "a.btn{display:inline-block;margin-top:16px;padding:10px 18px;background:#38bdf8;color:#0f172a;text-decoration:none;border-radius:8px;font-weight:600}</style>"
                    f"</head><body><div class='card'><h2>✅ 已收到您的確認！</h2>"
                    f"<p>掃描 ID：<b>{sid}</b></p>"
                    f"<div class='badge'>{label_zh}</div>"
                    "<p>系統正在背景執行您選擇的網格處理方式，完成後將於 Google Chat 發送通知。</p>"
                    "<a class='btn' href='/'>開啟 GatheringScans 平台</a></div></body></html>"
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(html_body)))
                self.end_headers()
                self.wfile.write(html_body)
            except Exception as e:
                self.send_json({"error": str(e)}, status=400)
            return

        if path == "/api/gchat/test-app":
            actor_em_g, _, gc_perms = self._resolve_request_role(None, query, share_token)
            if share_token or not gc_perms.get("can_manage_users"):
                self.send_json({"error": "Owner or Admin session required to test Google Chat app."}, status=403)
                return
            test_em = str((query.get("email") or [actor_em_g])[0] or "").strip()
            self.send_json(GCHAT.test_chat_app_connection(test_email=test_em))
            return

        if path == "/api/gchat/history":
            _, _, gc_perms = self._resolve_request_role(None, query, share_token)
            if share_token or not gc_perms.get("can_manage_users"):
                self.send_json({"error": "Owner or Admin session required to view Google Chat notification history."}, status=403)
                return
            self.send_json({"status": "ok", "notifications": GCHAT.list_notifications()})
            return

        # 9. User-Specific Offline Cache Settings, Language Preferences & User Profiles (GatheringCloud OAuth Gate)
        if path in ("/api/user/settings", "/api/user/preferences"):
            actor_em_s, _, actor_p_s = self._resolve_request_role(None, query, share_token)
            is_admin_s = bool(actor_p_s.get("can_manage_users"))
            email = str(
                (query.get("email") or query.get("user_email") or [None])[0]
                or self.headers.get("X-User-Email")
                or actor_em_s
                or "guest@anonymous"
            ).strip().lower()
            settings = DB.get_user_settings(email)
            prof = AUTH_SHARE.get_user_profile(email) if (email != "guest@anonymous" and (is_admin_s or email == actor_em_s)) else None
            safe_prof = self._sanitize_single_profile(prof, is_admin=is_admin_s)
            lang_val = str(
                settings.get("language")
                or (prof and prof.get("language"))
                or "zh-TW"
            ).strip()
            if lang_val not in ("zh-TW", "en"):
                lang_val = "zh-TW"
            settings["language"] = lang_val
            self.send_json(
                {
                    "status": "ok",
                    "ok": True,
                    "email": email,
                    "language": lang_val,
                    "settings": settings,
                    "preferences": {
                        "email": email,
                        "language": lang_val,
                        "theme_preference": settings.get("theme_preference", "auto"),
                    },
                    "profile": safe_prof,
                }
            )
            return

        if path in ("/api/auth/session", "/api/auth/roster"):
            actor_em, actor_r, actor_p = self._resolve_request_role(None, query, share_token)
            is_admin_sess = bool(actor_p.get("can_manage_users"))
            req_em = str(
                actor_em if (actor_em and actor_r != "guest") else ""
            ).strip().lower()
            profiles = []
            for p in AUTH_SHARE.list_user_profiles():
                r_norm = normalize_role(p.get("role"), email=p.get("email", ""))
                em_p = str(p.get("email") or "").strip().lower()
                u_set = DB.get_user_settings(em_p) if em_p else {}
                p_lang = str(u_set.get("language") or p.get("language") or "zh-TW")
                if p_lang not in ("zh-TW", "en"):
                    p_lang = "zh-TW"
                profiles.append(
                    {
                        **p,
                        "role": r_norm,
                        "role_level": ROLE_LEVELS.get(r_norm, 2),
                        "role_label": ROLE_LABELS.get(r_norm, "Viewer"),
                        "permissions": get_role_permissions(r_norm),
                        "language": p_lang,
                    }
                )
            matched_prof = next((x for x in profiles if str(x.get("email", "")).lower() == req_em), None) if req_em else None
            safe_matched = self._sanitize_single_profile(matched_prof, is_admin=is_admin_sess)
            visible_profiles = self._filter_profiles_for_caller(profiles, req_em, is_admin=is_admin_sess)
            u_settings = DB.get_user_settings(req_em) if req_em else {"language": "zh-TW"}
            active_lang = str((matched_prof and matched_prof.get("language")) or u_settings.get("language") or "zh-TW")
            if active_lang not in ("zh-TW", "en"):
                active_lang = "zh-TW"
            self.send_json(
                {
                    "status": "ok",
                    "authenticated": bool(matched_prof or (actor_em and actor_r != "guest")),
                    "email": req_em,
                    "role": (matched_prof and matched_prof.get("role")) or actor_r,
                    "permissions": (matched_prof and matched_prof.get("permissions")) or actor_p,
                    "language": active_lang,
                    "user": safe_matched,
                    "profile": safe_matched,
                    "roster": visible_profiles,
                    "profiles": visible_profiles,
                    "google_client_id": GOOGLE_OAUTH_CLIENT_ID,
                }
            )
            return

        if path == "/api/admin/pc-daemon":
            _, _, pd_perms = self._resolve_request_role(None, query, share_token)
            if share_token or not pd_perms.get("can_manage_users"):
                self.send_json({"error": "Owner or Admin session required to inspect PC daemon status."}, status=403)
                return
            self.send_json(get_pc_daemon_status())
            return

        if path in ("/api/user-profiles", "/api/admin/users"):
            actor_em_u, _, actor_p_u = self._resolve_request_role(None, query, share_token)
            is_admin_u = bool(actor_p_u.get("can_manage_users"))
            if path == "/api/admin/users" and (share_token or not is_admin_u):
                self.send_json({"error": "Owner or Admin session required to access user roles & permissions."}, status=403)
                return
            profiles = []
            for p in AUTH_SHARE.list_user_profiles():
                r_norm = normalize_role(p.get("role"), email=p.get("email", ""))
                em_p = str(p.get("email") or "").strip().lower()
                u_set = DB.get_user_settings(em_p) if em_p else {}
                p_lang = str(u_set.get("language") or p.get("language") or "zh-TW")
                if p_lang not in ("zh-TW", "en"):
                    p_lang = "zh-TW"
                profiles.append(
                    {
                        **p,
                        "role": r_norm,
                        "role_level": ROLE_LEVELS.get(r_norm, 2),
                        "role_label": ROLE_LABELS.get(r_norm, "Viewer"),
                        "permissions": get_role_permissions(r_norm),
                        "language": p_lang,
                    }
                )
            visible_profiles = self._filter_profiles_for_caller(profiles, actor_em_u, is_admin=is_admin_u)
            self.send_json(
                {
                    "status": "ok",
                    "profiles": visible_profiles,
                    "users": visible_profiles,
                    "roles_catalog": (
                        [
                            {"role": k, "level": v, "label": ROLE_LABELS[k], "permissions": get_role_permissions(k)}
                            for k, v in sorted(ROLE_LEVELS.items(), key=lambda x: -x[1])
                        ]
                        if is_admin_u
                        else []
                    ),
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
            if is_pc_simulated_offline():
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
                            if not (_groot.get("children")) and _grf and os.path.isfile(_grf):
                                leaf_glbs_dl = [_grf]
                            else:
                                def _walk_g_dl(node: dict, depth: int = 0):
                                    _chs = [c for c in (node.get("children") or []) if isinstance(c, dict)]
                                    if _chs and depth < 2:
                                        for _ch in _chs:
                                            _walk_g_dl(_ch, depth + 1)
                                        return
                                    _cu = ((node.get("content") or {}).get("uri") or "").split("?")[0]
                                    if _cu:
                                        _cf = os.path.join(_bdir_g, _cu)
                                        if os.path.isfile(_cf):
                                            leaf_glbs_dl.append(_cf)
                                _walk_g_dl(_groot, 0)
                                if not leaf_glbs_dl and _grf and os.path.isfile(_grf):
                                    leaf_glbs_dl = [_grf]
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

        # 13. Serve RTK Raw Camera Photo & Calibrated Camera Catalog
        if path in ("/api/survey/cameras", "/api/surveying/cameras"):
            sid_c, fmt_c = query.get("scan_id", [""])[0], query.get("format", ["json"])[0].lower()
            res_c = SURVEY.get_scan_cameras_response(sid_c, limit=int(query.get("limit", ["10000"])[0] or 10000), fmt=fmt_c)
            if fmt_c == "csv" and isinstance(res_c, str):
                raw_csv = res_c.encode("utf-8-sig")
                self.send_response(200)
                for hk, hv in (("Content-Type", "text/csv; charset=utf-8"), ("Content-Disposition", f'attachment; filename="{sid_c or "scan"}_calibrated_cameras.csv"'), ("Content-Length", str(len(raw_csv)))):
                    self.send_header(hk, hv)
                self.end_headers()
                self.wfile.write(raw_csv)
            else:
                self.send_json(res_c)
            return
        if path in ("/api/camera-photo", "/api/photo-file") or path.startswith("/cameras/"):
            parts_cam = path[len("/cameras/") :].strip("/").split("/", 1) if path.startswith("/cameras/") else []
            scan_id = (parts_cam[0] if parts_cam else "") if path.startswith("/cameras/") else query.get("scan_id", [""])[0]
            fname = (parts_cam[1] if len(parts_cam) >= 2 else "") if path.startswith("/cameras/") else query.get("file", [""])[0]
            fpath = SURVEY.resolve_camera_photo_path(scan_id, fname) if fname else None
            if fpath and os.path.isfile(fpath):
                self._serve_file_with_range(fpath, content_type="image/jpeg")
                return
            self.send_json({"error": f"Camera photo not found on PC: {fname}"}, status=404)
            return

        # 13b. Serve Uploaded Comment Photo (from local data/comment_photos or Google Drive CommentPhotos mirror)
        if path == "/api/comment-photo" or path.startswith("/api/comments/photo/"):
            if path.startswith("/api/comments/photo/"):
                rel_cp = path[len("/api/comments/photo/") :].strip("/")
                parts_cp = rel_cp.split("/", 1)
                scan_id = re.sub(r"[^A-Za-z0-9._-]+", "_", parts_cp[0]) if len(parts_cp) >= 1 else "general"
                fname = os.path.basename(parts_cp[1]) if len(parts_cp) >= 2 else ""
            else:
                scan_id = re.sub(r"[^A-Za-z0-9._-]+", "_", (query.get("scan_id", ["general"])[0] or "general"))
                fname = os.path.basename(query.get("file", [""])[0])
            if not fname:
                self.send_json({"error": "Missing comment photo filename"}, status=400)
                return
            cand_roots = [
                os.path.join(DATA_DIR, "comment_photos"),
                os.path.join(DATA_DIR, "gdrive_comment_photos"),
                r"G:\Shared drives\6.軟體\3. GatheringScans\CommentPhotos",
                r"G:\My Drive\Scans\CommentPhotos",
            ]
            for c_root in cand_roots:
                try:
                    cand_fp = os.path.join(c_root, scan_id, fname)
                    if os.path.isfile(cand_fp):
                        ext_low = os.path.splitext(fname)[1].lower()
                        c_mime = (
                            "image/png"
                            if ext_low == ".png"
                            else "image/webp"
                            if ext_low == ".webp"
                            else "image/gif"
                            if ext_low == ".gif"
                            else "image/jpeg"
                        )
                        self._serve_file_with_range(cand_fp, content_type=c_mime)
                        return
                except Exception:
                    continue

            # Fallback: fetch directly from Google Drive API v3 if gdrive_file_id is available
            gdrive_fid = (query.get("gdrive_file_id", [""])[0] or "").strip()
            expected_sz = 0
            if not gdrive_fid and scan_id:
                try:
                    for c_row in DB.list_comments(scan_id):
                        for p_row in (c_row.get("photos") or []):
                            if not isinstance(p_row, dict):
                                continue
                            if p_row.get("stored_filename") == fname or str(p_row.get("url") or "").endswith("/" + fname):
                                gdrive_fid = str(p_row.get("gdrive_file_id") or "").strip()
                                expected_sz = int(p_row.get("size_bytes") or 0)
                                break
                        if gdrive_fid:
                            break
                except Exception:
                    pass
            if gdrive_fid:
                try:
                    from pc_worker.server_cloud_and_tunnel import _fetch_gdrive_byte_slice

                    raw_gd = _fetch_gdrive_byte_slice([gdrive_fid], 0, expected_sz if expected_sz > 0 else 15 * 1024 * 1024)
                    if raw_gd:
                        cache_dir = os.path.join(DATA_DIR, "comment_photos", scan_id)
                        os.makedirs(cache_dir, exist_ok=True)
                        cache_fp = os.path.join(cache_dir, fname)
                        with open(cache_fp, "wb") as cf:
                            cf.write(raw_gd)
                        ext_low = os.path.splitext(fname)[1].lower()
                        c_mime = "image/png" if ext_low == ".png" else "image/webp" if ext_low == ".webp" else "image/gif" if ext_low == ".gif" else "image/jpeg"
                        self._serve_file_with_range(cache_fp, content_type=c_mime)
                        return
                except Exception:
                    pass

            self.send_json({"error": f"Comment photo not found: {fname}"}, status=404)
            return

        # 14. Serve Generated Reports & Contours (.html, .csv, .pdf, .dxf, .dwg)
        if path.startswith("/api/reports/") or path.startswith("/exports/reports/"):
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
            prefix_len = len("/exports/reports/") if path.startswith("/exports/reports/") else len("/api/reports/")
            fname = os.path.basename(path[prefix_len:])
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

        # 15. Serve Static Frontend Files from web/ (with dynamic Open Graph / Link Preview meta for ?share=<token>)
        if path == "/" or path == "":
            rel_web = "index.html"
        else:
            rel_web = path.lstrip("/")
        web_target = os.path.join(WEB_DIR, os.path.normpath(rel_web))
        if os.path.isfile(web_target) and os.path.abspath(web_target).startswith(os.path.abspath(WEB_DIR)):
            if rel_web == "index.html" and share_token:
                ua_idx = self.headers.get("User-Agent", "")
                if is_link_preview_bot(ua_idx):
                    self._record_and_forward_bot_unfurl(share_token)
                try:
                    with open(web_target, "r", encoding="utf-8") as f_html:
                        raw_html = f_html.read()
                    meta = self._build_share_preview_meta(share_token)
                    og_block = self._render_share_og_tags_block(meta)
                    if "<!-- GS_SHARE_OG_START -->" in raw_html and "<!-- GS_SHARE_OG_END -->" in raw_html:
                        s_idx = raw_html.index("<!-- GS_SHARE_OG_START -->")
                        e_idx = raw_html.index("<!-- GS_SHARE_OG_END -->") + len("<!-- GS_SHARE_OG_END -->")
                        raw_html = (
                            raw_html[:s_idx]
                            + "<!-- GS_SHARE_OG_START -->\n"
                            + og_block
                            + "\n  <!-- GS_SHARE_OG_END -->"
                            + raw_html[e_idx:]
                        )
                    else:
                        raw_html = re.sub(
                            r"<title>.*?</title>",
                            og_block,
                            raw_html,
                            count=1,
                            flags=re.DOTALL,
                        )
                    html_bytes = raw_html.encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(html_bytes)))
                    self.send_header("Cache-Control", "no-cache")
                    self.end_headers()
                    self.wfile.write(html_bytes)
                    return
                except Exception:
                    pass
            self._serve_file_with_range(web_target)
            return

        self.send_json({"error": f"Not found: {path}"}, status=404)



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

