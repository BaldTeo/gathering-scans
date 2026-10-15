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
    MATERIAL_CATALOG,
    TWD97_TWVD2001_LABEL,
    TWD97_TWVD2001_SHORT,
    PIX4DMATIC_TEXTURE_SIZE,
    GOOGLE_OAUTH_CLIENT_ID,
)
from pc_worker.priority_queue import ScanQueueDB
from pc_worker.gdrive_watcher import seed_and_discover_scans, extract_opf_zip_metadata
from pc_worker.pix4d_runner import generate_pix4dmatic_gst_script, run_pix4dmatic_pipeline
from pc_worker.optimizer_bridge import OptimizerBridge
from pc_worker.surveying_engine import SurveyingEngine
from pc_worker.auth_and_sharing import AuthAndSharingManager
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


def _compute_scans_dir_fingerprint() -> Tuple[str, ...]:
    if not os.path.isdir(LOCAL_SCANS_ROOT):
        return ()
    entries = []
    try:
        for name in sorted(os.listdir(LOCAL_SCANS_ROOT)):
            full = os.path.join(LOCAL_SCANS_ROOT, name)
            if os.path.isdir(full):
                try:
                    sub = sorted(os.listdir(full))
                except Exception:
                    sub = []
                entries.append(f"{name}:{','.join(sub[:12])}")
    except Exception:
        pass
    return tuple(entries)


def sync_scans_with_filesystem(max_age_s: float = 1.5, force: bool = False) -> None:
    """Live filesystem sync: discovers new folders in C:\\GatheringScans and removes deleted folders."""
    global _LAST_FS_SYNC_TS, _LAST_FS_FINGERPRINT
    if os.name != "nt":
        return
    now = time.time()
    if not force and (now - _LAST_FS_SYNC_TS < max_age_s):
        return
    with _FS_SYNC_LOCK:
        if not force and (time.time() - _LAST_FS_SYNC_TS < max_age_s):
            return
        fp = _compute_scans_dir_fingerprint()
        if force or fp != _LAST_FS_FINGERPRINT:
            try:
                seed_and_discover_scans(DB)
                _LAST_FS_FINGERPRINT = fp
            except Exception as e:
                print(f"[GatheringScans] Live filesystem sync note: {e}")
        _LAST_FS_SYNC_TS = time.time()


sync_scans_with_filesystem(force=True)
OPTIMIZER = OptimizerBridge(DB)
SURVEY = SurveyingEngine(DB)
AUTH_SHARE = AuthAndSharingManager(DB)
GCHAT = GoogleChatNotifier(DB)

# Simulated PC Online Toggle (for testing Requirement 5 Offline Fallback in browser)
PC_SIMULATED_OFFLINE = False

# Reverse Tunnel Socket Pool (used on Linux VPS to proxy /api/*, /stream/*, /s/* to Windows PC C:\GatheringScans)
VPS_TUNNEL_POOL: "queue.LifoQueue[Tuple[socket.socket, threading.Event, float, int]]" = queue.LifoQueue()
_VPS_RAM_FALLBACK_CACHE: Dict[str, Tuple[int, Dict[str, str], bytes]] = {}
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
                s.settimeout(240.0)
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
                        conn = http.client.HTTPConnection("127.0.0.1", local_port, timeout=30.0)
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
        import urllib.request

        time.sleep(3.5)
        warmed_uris = set()
        while True:
            try:
                r = json.loads(
                    urllib.request.urlopen(f"http://127.0.0.1:{local_port}/api/scans", timeout=8).read().decode("utf-8")
                )
                scans = r.get("scans") or []
                for s in scans:
                    sid = s.get("scan_id")
                    if not sid:
                        continue
                    # 1. Warm local disk cache first
                    ts_local = json.loads(
                        urllib.request.urlopen(
                            f"http://127.0.0.1:{local_port}/stream/{sid}/tileset.json?v=opt4", timeout=8
                        )
                        .read()
                        .decode("utf-8")
                    )
                    uris = []

                    def _collect(node):
                        u = (node.get("content") or {}).get("uri")
                        if u:
                            uris.append(u)
                        for ch in node.get("children") or []:
                            _collect(ch)

                    _collect(ts_local.get("root") or {})
                    for u in uris:
                        local_u = f"http://127.0.0.1:{local_port}/stream/{sid}/{u}"
                        if local_u not in warmed_uris:
                            req = urllib.request.Request(local_u, headers={"Accept-Encoding": "gzip"})
                            urllib.request.urlopen(req, timeout=15).read()
                            warmed_uris.add(local_u)
                    # 2. Warm VPS volatile RAM cache
                    vps_ts = f"https://scans.gatheren.cloud/stream/{sid}/tileset.json?v=opt4"
                    if vps_ts not in warmed_uris:
                        urllib.request.urlopen(
                            urllib.request.Request(vps_ts, headers={"Accept-Encoding": "gzip"}), timeout=12
                        ).read()
                        warmed_uris.add(vps_ts)
                    vps_thumb = f"https://scans.gatheren.cloud/api/scans/{sid}/thumbnail"
                    if vps_thumb not in warmed_uris:
                        try:
                            urllib.request.urlopen(vps_thumb, timeout=10).read()
                            warmed_uris.add(vps_thumb)
                        except Exception:
                            pass
                    for u in uris:
                        vps_u = f"https://scans.gatheren.cloud/stream/{sid}/{u}"
                        if vps_u not in warmed_uris:
                            req = urllib.request.Request(vps_u, headers={"Accept-Encoding": "gzip"})
                            urllib.request.urlopen(req, timeout=20).read()
                            warmed_uris.add(vps_u)
            except Exception:
                pass
            time.sleep(45.0)

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

    _GZIP_FILE_CACHE: Dict[str, Tuple[float, bytes]] = {}
    _OPTIMIZED_TILESET_CACHE: Dict[str, Tuple[float, bytes]] = {}

    def _serve_optimized_tileset_json(self, ts_path: str):
        try:
            mtime = os.path.getmtime(ts_path)
            cached = self._OPTIMIZED_TILESET_CACHE.get(ts_path)
            if cached and cached[0] == mtime:
                raw_json = cached[1]
            else:
                with open(ts_path, "r", encoding="utf-8") as f:
                    ts = json.load(f)
                base_dir = os.path.dirname(ts_path)
                root = ts.get("root") or {}
                if not root.get("transform"):
                    ts.setdefault("asset", {})["gltfUpAxis"] = "Z"
                r_content = root.get("content") or {}
                r_uri = r_content.get("uri") if isinstance(r_content, dict) else None
                if r_uri:
                    r_file = os.path.join(base_dir, r_uri)
                    if os.path.isfile(r_file) and os.path.getsize(r_file) >= 800_000:
                        # Root .glb already contains the full-site 2K mesh (~318k triangles)
                        root["geometricError"] = 0.0
                        root["children"] = []
                    else:
                        # Small root .glb (e.g. QuChi_1_20260921): cap at Depth 2
                        for c1 in root.get("children") or []:
                            for c2 in c1.get("children") or []:
                                c2["geometricError"] = 0.0
                                c2["children"] = []
                else:
                    # PIX4Dmatic Cesium octree: prune each octant branch at its first content node (100k-300k triangles per tile)
                    def _prune_branch(node: dict, depth: int = 0) -> bool:
                        c = node.get("content") or {}
                        if isinstance(c, dict) and c.get("uri"):
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
            self.send_header("Cache-Control", "no-cache")
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
            if idx_acc.get("componentType") != 5125 or idx_acc.get("count", 0) < 30000:
                return raw_bytes
            if pos_acc.get("componentType") != 5126 or uv_acc.get("componentType") != 5126:
                return raw_bytes

            blob = memoryview(raw_bytes)[b_off + 8 : b_off + 8 + b_len]
            idx_bv = bv_list[idx_acc["bufferView"]]
            pos_bv = bv_list[pos_acc["bufferView"]]
            uv_bv = bv_list[uv_acc["bufferView"]]

            idx = np.frombuffer(
                blob,
                dtype=np.uint32,
                count=idx_acc["count"],
                offset=idx_bv.get("byteOffset", 0) + idx_acc.get("byteOffset", 0),
            ).reshape(-1, 3)
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

        if ext == ".glb" and not download_name and file_size > 700_000:
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
        if ext in (".json", ".glb", ".js", ".css") and not range_header and not download_name and "gzip" in accept_enc and 1024 < file_size <= 16 * 1024 * 1024:
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
                self.send_header("Cache-Control", "public, max-age=3600")
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
            ts_q = f"?v=opt4&share={share_token}" if share_token else "?v=opt4"
            s["stream_url"] = f"/stream/{sid}/tileset.json{ts_q}"
            s["stream_type"] = "tileset"
        s["download_obj_url"] = f"/api/download?scan_id={sid}&type=obj" + (f"&share={share_token}" if share_token else "")
        s["thumbnail_url"] = f"/api/scans/{sid}/thumbnail{q_suffix}"
        return s

    def _build_projects_summary(self, scans: list) -> list:
        projects_map: Dict[str, Dict[str, Any]] = {}
        for s in scans:
            grp = s.get("project_group") or "Unassigned Site"
            if grp not in projects_map:
                projects_map[grp] = {
                    "project_group": grp,
                    "project_name_zh": s.get("project_name_zh") or "",
                    "scan_count": 0,
                    "lat": s.get("lat") or 24.92032,
                    "lon": s.get("lon") or 121.54351,
                    "twd97_e": s.get("twd97_e") or 304952.6,
                    "twd97_n": s.get("twd97_n") or 2757084.9,
                    "latest_date": s.get("capture_date") or "",
                    "scan_ids": [],
                }
            entry = projects_map[grp]
            entry["scan_count"] += 1
            entry["scan_ids"].append(s.get("scan_id"))
            cdate = str(s.get("capture_date") or "")
            if cdate > str(entry["latest_date"]):
                entry["latest_date"] = cdate
        return sorted(projects_map.values(), key=lambda x: (-x["scan_count"], x["project_group"].lower()))

    def _resolve_scan_thumbnail_path(self, scan_id: str, scan: Optional[Dict[str, Any]] = None) -> Optional[str]:
        s = scan or DB.get_scan(scan_id) or {}
        proj_dir = s.get("project_dir") or ""

        # 1. Check scan.project_dir/thumbnail.png dynamically inside C:\GatheringScans (flat or nested)
        if proj_dir and os.path.isdir(proj_dir):
            for fname in ("thumbnail.png", "preview.png", "thumbnail.jpg", "ortho_preview.png"):
                cand = os.path.join(proj_dir, fname)
                if os.path.isfile(cand) and os.path.getsize(cand) > 256:
                    return cand

        # 2. Check automatically captured WebGL screenshot in data/thumbnails/<scan_id>.png
        captured_png = os.path.join(THUMBS_DIR, f"{scan_id}.png")
        if os.path.isfile(captured_png) and os.path.getsize(captured_png) > 512:
            return captured_png

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

    def _proxy_via_pc_tunnel_if_vps(self, method: str, path: str, body: bytes = b"") -> bool:
        """
        When running on the Linux VPS (os.name != 'nt'), proxies all /api/*, /stream/*, and /s/* requests
        through the reverse socket pool directly to the Windows PC (C:\\GatheringScans).
        Zero scan files are stored on the Linux VPS disk.
        """
        if os.name == "nt":
            return False

        cacheable = method == "GET" and (
            path in ("/api/scans", "/api/projects", "/api/status", "/api/pc/health", "/api/user-profiles")
            or path.endswith("/thumbnail")
            or path.endswith("/thumbnail.png")
            or path.endswith("/tileset.json")
            or path.endswith(".glb")
        )
        if method == "POST" and path.endswith("/thumbnail"):
            for k in list(_VPS_RAM_FALLBACK_CACHE.keys()):
                if k.startswith(path):
                    _VPS_RAM_FALLBACK_CACHE.pop(k, None)

        # Serve immutable binary .glb tiles, thumbnails, and tileset.json from volatile RAM if already pulled from PC while tunnel is online
        if (
            method == "GET"
            and (path.endswith(".glb") or path.endswith("/thumbnail") or path.endswith("/tileset.json"))
            and not VPS_TUNNEL_POOL.empty()
            and self.path in _VPS_RAM_FALLBACK_CACHE
        ):
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

        # Try up to 4 sockets from the pool
        for _attempt in range(4):
            tun_sock, done_evt, proto_ver = _acquire_vps_tunnel_socket(timeout=5.0)
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
                            if len(buf_for_cache) + len(chunk) <= 8 * 1024 * 1024:
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
                            if len(buf_for_cache) + len(chunk) <= 8 * 1024 * 1024:
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

        # Serve from in-memory fallback cache if available during momentary tunnel reconnect
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
            sync_scans_with_filesystem()
            scans = DB.list_scans()
            processing = [s for s in scans if s["status"] == "processing"]
            queued = [s for s in scans if s["status"] in ("queued", "waiting_parts")]
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
            self.send_json(
                {
                    "status": "ok",
                    "mode": "internal",
                    "pc_online": not PC_SIMULATED_OFFLINE,
                    "crs": TWD97_TWVD2001_LABEL,
                    "scans": scans,
                    "projects": self._build_projects_summary(scans),
                    "materials": MATERIAL_CATALOG,
                    "google_client_id": GOOGLE_OAUTH_CLIENT_ID,
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
            sync_scans_with_filesystem()
            if share_token:
                self.send_json({"error": "Queue status restricted to internal company users."}, status=403)
                return
            all_scans = DB.list_scans()
            queued = [s for s in all_scans if s["status"] in ("queued", "waiting_parts")]
            queued.sort(key=lambda x: (0 if x["status"] == "queued" else 1, -float(x["priority_score"]), float(x["uploaded_at"])))
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

        # 9. User-Specific Offline Cache Settings & User Profiles (GatheringCloud OAuth Gate)
        if path == "/api/user/settings":
            email = query.get("email", ["glibivanov@gatheren.com.tw"])[0]
            self.send_json({"status": "ok", "settings": DB.get_user_settings(email)})
            return

        if path == "/api/user-profiles":
            self.send_json(
                {
                    "status": "ok",
                    "profiles": AUTH_SHARE.list_user_profiles(),
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

        # 14. Serve Generated Reports & Contours (.html, .csv, .pdf, .dxf, .dwg)
        if path.startswith("/api/reports/"):
            fname = os.path.basename(path[len("/api/reports/") :])
            fpath = os.path.join(REPORTS_DIR, fname)
            if not os.path.isfile(fpath) and os.path.isfile(os.path.join(CONTOURS_DIR, fname)):
                fpath = os.path.join(CONTOURS_DIR, fname)
            force_dl = query.get("download", ["0"])[0] == "1"
            dl = fname if (fname.endswith((".csv", ".dwg", ".dxf")) or force_dl) else None
            self._serve_file_with_range(fpath, download_name=dl)
            return

        if path.startswith("/api/contours/"):
            fname = os.path.basename(path[len("/api/contours/") :])
            fpath = os.path.join(CONTOURS_DIR, fname)
            if not os.path.isfile(fpath) and os.path.isfile(os.path.join(REPORTS_DIR, fname)):
                fpath = os.path.join(REPORTS_DIR, fname)
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

            # 3. Civil Surveying: Elevation Contours + Civil3D.dwg & A3 Survey Report .PDF Export
            if path in ("/api/survey/contours", "/api/survey/report"):
                if share_token:
                    ok, reason, _, _ = AUTH_SHARE.validate_share_access(
                        share_token, requested_scan_id=payload.get("scan_id")
                    )
                    if not ok:
                        self.send_json({"error": reason}, status=403)
                        return
                res = SURVEY.generate_civil3d_survey_report(payload)
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

            # 11. User-Specific Offline Cache Settings & User Profiles Update
            if path == "/api/user/settings":
                email = payload.get("email", "glibivanov@gatheren.com.tw")
                settings = DB.update_user_settings(email, payload)
                self.send_json({"status": "ok", "settings": settings})
                return

            if path == "/api/user-profiles":
                saved = AUTH_SHARE.upsert_user_profile(payload)
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
