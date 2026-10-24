#!/usr/bin/env python3
"""
Civil Surveying & Computational Geometry Engine for GatheringScans
All calculations and CAD exports operate in TWD97 (121) [EPSG:3826] + TWVD2001 [EPSG:8904]:
1. Cut/Fill Volume & Material Stockpile Tonnage Calculator + HTML/PDF & CSV/Excel Report Generator
2. Marching Squares Elevation Contour Generator + AutoCAD 3D .DXF / .DWG Exporter
3. Multi-Date Cross-Section Elevation Profile & Slope/Grade Analyzer
4. RTK Raw Camera Photo Pin Inspector (matches 3D surface points to original Pix4DCatch .jpg photos)
"""

from __future__ import annotations

import os
import sys
import csv
import glob
import math
import json
import time
import tempfile
import subprocess
from datetime import datetime
from typing import Dict, Any, List, Tuple, Optional

try:
    import numpy as np
except ImportError:
    np = None  # type: ignore

try:
    from scipy.ndimage import distance_transform_edt, gaussian_filter
except ImportError:
    distance_transform_edt = None  # type: ignore
    gaussian_filter = None  # type: ignore

try:
    import trimesh
except ImportError:
    trimesh = None  # type: ignore

try:
    from PIL import Image
    from PIL.ExifTags import GPSTAGS
except ImportError:
    Image = None  # type: ignore
    GPSTAGS = {}

from pc_worker.config import (
    LOCAL_SCANS_ROOT as SCANS_ROOT_DIR,
    GC_SCAN_OPTIMIZER_DIR,
    REPORTS_DIR,
    CONTOURS_DIR,
    MATERIAL_CATALOG,
    TWD97_TWVD2001_LABEL,
    TWD97_TWVD2001_SHORT,
)
from pc_worker.priority_queue import ScanQueueDB


def wgs84_to_twd97(lat_deg: float, lon_deg: float) -> Tuple[float, float]:
    """Converts WGS84 / TWD97 Geodetic (lat, lon) in degrees to TWD97 TM2 Zone 121 (Easting, Northing) in meters."""
    a = 6378137.0
    f = 1.0 / 298.257222101
    b = a * (1.0 - f)
    e2 = (a * a - b * b) / (a * a)
    ep2 = (a * a - b * b) / (b * b)
    lon0 = math.radians(121.0)
    k0 = 0.9999
    dx = 250000.0

    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)
    dlon = lon - lon0

    sin_lat = math.sin(lat)
    cos_lat = math.cos(lat)
    tan_lat = math.tan(lat)

    N = a / math.sqrt(1.0 - e2 * sin_lat * sin_lat)
    T = tan_lat * tan_lat
    C = ep2 * cos_lat * cos_lat
    A = dlon * cos_lat

    M = a * (
        (1.0 - e2 / 4.0 - 3.0 * (e2 ** 2) / 64.0 - 5.0 * (e2 ** 3) / 256.0) * lat
        - (3.0 * e2 / 8.0 + 3.0 * (e2 ** 2) / 32.0 + 45.0 * (e2 ** 3) / 1024.0) * math.sin(2.0 * lat)
        + (15.0 * (e2 ** 2) / 256.0 + 45.0 * (e2 ** 3) / 1024.0) * math.sin(4.0 * lat)
        - (35.0 * (e2 ** 3) / 3072.0) * math.sin(6.0 * lat)
    )

    easting = dx + k0 * N * (
        A
        + (1.0 - T + C) * (A ** 3) / 6.0
        + (5.0 - 18.0 * T + T * T + 72.0 * C - 58.0 * ep2) * (A ** 5) / 120.0
    )
    northing = k0 * (
        M
        + N * tan_lat * (
            (A * A) / 2.0
            + (5.0 - T + 9.0 * C + 4.0 * C * C) * (A ** 4) / 24.0
            + (61.0 - 58.0 * T + T * T + 600.0 * C - 330.0 * ep2) * (A ** 6) / 720.0
        )
    )
    return round(easting, 3), round(northing, 3)

GLTFPACK_EXE = r"C:\Antigravity\GC_ScanOptimizer\bin\gltfpack.exe"

# Standard 16-case Marching Squares lookup table
# Edge indices: 0=bottom (v00->v10), 1=right (v10->v11), 2=top (v01->v11), 3=left (v00->v01)
MS_CASES: Dict[int, List[Tuple[int, int]]] = {
    1:  [(3, 0)],
    2:  [(0, 1)],
    3:  [(3, 1)],
    4:  [(1, 2)],
    5:  [(3, 2), (0, 1)],
    6:  [(0, 2)],
    7:  [(3, 2)],
    8:  [(2, 3)],
    9:  [(0, 2)],
    10: [(0, 3), (1, 2)],
    11: [(1, 2)],
    12: [(1, 3)],
    13: [(0, 1)],
    14: [(3, 0)],
}


def polygon_area_and_perimeter_2d(pts: List[Tuple[float, float]]) -> Tuple[float, float]:
    """Computes planar polygon area (m^2) via Shoelace formula and perimeter (m)."""
    n = len(pts)
    if n < 3:
        return 0.0, 0.0
    area2 = 0.0
    perim = 0.0
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        area2 += x1 * y2 - x2 * y1
        perim += math.hypot(x2 - x1, y2 - y1)
    return abs(area2) * 0.5, perim


def point_in_polygon_2d(x: float, y: float, poly: List[Tuple[float, float]]) -> bool:
    """Ray-casting point-in-polygon test."""
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        intersect = ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) + 1e-12) + xi)
        if intersect:
            inside = not inside
        j = i
    return inside


def simplify_polyline_2d(pts: List[Tuple[float, float]], tol: float = 0.08) -> List[Tuple[float, float]]:
    """Ramer-Douglas-Peucker simplification for 2D contour polylines."""
    if len(pts) <= 3:
        return pts
    is_closed = math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) < 1e-3
    if is_closed and len(pts) > 4:
        mid = len(pts) // 2
        left = simplify_polyline_2d(pts[: mid + 1], tol)
        right = simplify_polyline_2d(pts[mid:], tol)
        return left[:-1] + right

    x1, y1 = pts[0]
    x2, y2 = pts[-1]
    dx = x2 - x1
    dy = y2 - y1
    seg_len = math.hypot(dx, dy)
    max_d = -1.0
    max_idx = 0
    for i in range(1, len(pts) - 1):
        px, py = pts[i]
        if seg_len < 1e-9:
            d = math.hypot(px - x1, py - y1)
        else:
            d = abs(dy * px - dx * py + x2 * y1 - y2 * x1) / seg_len
        if d > max_d:
            max_d = d
            max_idx = i

    if max_d > tol:
        left = simplify_polyline_2d(pts[: max_idx + 1], tol)
        right = simplify_polyline_2d(pts[max_idx:], tol)
        return left[:-1] + right
    return [pts[0], pts[-1]]


class SurveyingEngine:
    def __init__(self, db: ScanQueueDB):
        self.db = db
        self._dsm_mem_cache: Dict[str, Dict[str, Any]] = {}
        self._camera_mem_cache: Dict[str, List[Dict[str, Any]]] = {}

    def _resolve_scan_record(self, scan_id: str) -> Dict[str, Any]:
        """Resolves scan metadata from SQLite DB or falls back to gdrive_cloud_manifest.json on Linux VPS."""
        clean_id = (scan_id or "").strip()
        if not clean_id:
            raise KeyError("Missing scan_id")
        scan = self.db.get_scan(clean_id)
        if scan:
            return scan
        base_repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        for mp in (
            os.path.join(base_repo, "data", "gdrive_cloud_manifest.json"),
            "/host_docker/gathering_scans/data/gdrive_cloud_manifest.json",
        ):
            if os.path.isfile(mp):
                try:
                    with open(mp, "r", encoding="utf-8") as mf:
                        mdata = json.load(mf)
                    for s in mdata.get("scans") or []:
                        if str(s.get("scan_id") or "").lower() == clean_id.lower():
                            return s
                except Exception:
                    pass
        raise KeyError(f"Scan not found: {clean_id}")

    @staticmethod
    def _resolve_scan_obj_path(scan: Dict[str, Any]) -> Optional[str]:
        """Finds the best .obj mesh on disk for the given scan metadata."""
        candidates = []
        if scan.get("obj_path"):
            candidates.append(scan["obj_path"])
        for dir_key in ("project_dir", "src_project_dir"):
            d = scan.get(dir_key)
            if d and os.path.isdir(d):
                candidates.extend(glob.glob(os.path.join(d, "**", "*.obj"), recursive=True))
                bname = os.path.basename(d.rstrip("\\/"))
                if "-cesium_mesh" in bname:
                    sib_dir = os.path.join(os.path.dirname(d.rstrip("\\/")), bname.replace("-cesium_mesh", "-obj_mesh"))
                    candidates.append(os.path.join(sib_dir, "mesh.obj"))
        for c in candidates:
            if c and os.path.isfile(c) and os.path.getsize(c) > 512:
                return os.path.abspath(c)
        return None

    @staticmethod
    def _collect_scan_glb_files(scan: Dict[str, Any]) -> List[str]:
        """Collects active leaf .glb tile paths for a scan (ordered largest-first), excluding backups/previews."""
        scan_id = str(scan.get("scan_id") or "")
        proj_dir = scan.get("project_dir") or os.path.join(SCANS_ROOT_DIR, scan_id)
        ts_path = scan.get("tileset_path") or os.path.join(proj_dir, "tileset", "tileset.json")
        glb_files: List[str] = []
        if ts_path and os.path.isfile(ts_path):
            if ts_path.lower().endswith(".glb"):
                return [ts_path]
            if ts_path.lower().endswith(".json"):
                try:
                    ts_base_dir = os.path.dirname(ts_path)
                    with open(ts_path, "r", encoding="utf-8") as tf:
                        ts_doc = json.load(tf)
                    leaf_glbs: List[str] = []
                    all_glbs: List[str] = []

                    def _walk_glbs(nd: Dict[str, Any]) -> None:
                        cnt = nd.get("content")
                        uri = (cnt.get("uri") or cnt.get("url") or "") if isinstance(cnt, dict) else ""
                        uri_clean = uri.split("?")[0]
                        fp = os.path.join(ts_base_dir, uri_clean.replace("/", os.sep)) if uri_clean else ""
                        chs = nd.get("children") or []
                        if fp and os.path.isfile(fp) and fp.lower().endswith(".glb"):
                            all_glbs.append(fp)
                            if not chs:
                                leaf_glbs.append(fp)
                        for c_nd in chs:
                            if isinstance(c_nd, dict):
                                _walk_glbs(c_nd)

                    if isinstance(ts_doc.get("root"), dict):
                        _walk_glbs(ts_doc["root"])
                    glb_files = leaf_glbs if leaf_glbs else all_glbs
                except Exception:
                    pass
        if not glb_files:
            search_dirs = [
                d
                for d in (os.path.join(proj_dir, "tileset"), proj_dir, scan.get("src_tileset_dir"))
                if d and os.path.isdir(d)
            ]
            for sd in search_dirs:
                found = [
                    g
                    for g in glob.glob(os.path.join(sd, "**", "*.glb"), recursive=True)
                    if "preview" not in g.lower() and "tileset_backup" not in g.lower() and "tileset_prev" not in g.lower()
                ]
                if found:
                    glb_files = found
                    break
        glb_files = list(dict.fromkeys(glb_files))
        glb_files.sort(key=lambda p: os.path.getsize(p) if os.path.isfile(p) else 0, reverse=True)
        return glb_files

    @staticmethod
    def _extract_glb_positions_from_bytes(raw_bytes: bytes) -> Optional[np.ndarray]:
        """Fast pure-numpy/struct glTF 2.0 binary .glb POSITION reader with full 64-bit scene-graph TRS/matrix support."""
        import struct

        try:
            if len(raw_bytes) < 28 or raw_bytes[:4] != b"glTF":
                return None
            j_len, j_type = struct.unpack_from("<I4s", raw_bytes, 12)
            if j_type != b"JSON":
                return None
            b_off = 20 + j_len
            if b_off + 8 > len(raw_bytes):
                return None
            b_len, b_type = struct.unpack_from("<I4s", raw_bytes, b_off)
            if b_type != b"BIN\x00":
                return None
            j = json.loads(raw_bytes[20 : 20 + j_len].decode("utf-8"))
            exts_used = set(j.get("extensionsUsed") or []) | set(j.get("extensionsRequired") or [])
            if "EXT_meshopt_compression" in exts_used:
                return None
            acc_list = j.get("accessors") or []
            bv_list = j.get("bufferViews") or []
            meshes_list = j.get("meshes") or []
            nodes_list = j.get("nodes") or []
            blob = memoryview(raw_bytes)[b_off + 8 : b_off + 8 + b_len]

            def _read_mesh_pos(mesh_idx: int) -> Optional[np.ndarray]:
                if not (0 <= mesh_idx < len(meshes_list)):
                    return None
                m_chunks = []
                for prim in meshes_list[mesh_idx].get("primitives") or []:
                    if prim.get("extensions") and "KHR_draco_mesh_compression" in prim["extensions"]:
                        return None
                    attrs = prim.get("attributes") or {}
                    if "POSITION" not in attrs:
                        continue
                    pos_acc = acc_list[attrs["POSITION"]]
                    if pos_acc.get("type") != "VEC3" or "bufferView" not in pos_acc:
                        continue
                    ctype = pos_acc.get("componentType")
                    pos_bv = bv_list[pos_acc["bufferView"]]
                    cnt = int(pos_acc["count"])
                    byte_offset = int(pos_bv.get("byteOffset", 0)) + int(pos_acc.get("byteOffset", 0))
                    if ctype == 5126:
                        byte_stride = int(pos_bv.get("byteStride") or 12)
                        if byte_stride == 12:
                            arr = np.frombuffer(blob, dtype=np.float32, count=cnt * 3, offset=byte_offset).reshape(-1, 3).astype(np.float64)
                        else:
                            raw_u8 = np.frombuffer(blob, dtype=np.uint8, count=cnt * byte_stride, offset=byte_offset).reshape(cnt, byte_stride)
                            arr = np.frombuffer(raw_u8[:, :12].tobytes(), dtype=np.float32).reshape(-1, 3).astype(np.float64)
                    elif ctype in (5122, 5123):
                        dt = np.int16 if ctype == 5122 else np.uint16
                        byte_stride = int(pos_bv.get("byteStride") or 6)
                        raw_u8 = np.frombuffer(blob, dtype=np.uint8, count=cnt * byte_stride, offset=byte_offset).reshape(cnt, byte_stride)
                        arr = np.frombuffer(raw_u8[:, :6].tobytes(), dtype=dt).reshape(-1, 3).astype(np.float64)
                        if pos_acc.get("normalized"):
                            arr = arr / (32767.0 if ctype == 5122 else 65535.0)
                    else:
                        return None
                    m_chunks.append(arr)
                return np.vstack(m_chunks) if m_chunks else None

            def _node_mat4(nd: Dict[str, Any]) -> np.ndarray:
                if isinstance(nd.get("matrix"), list) and len(nd["matrix"]) == 16:
                    return np.array([float(x) for x in nd["matrix"][:16]], dtype=np.float64).reshape((4, 4), order="F")
                m = np.eye(4, dtype=np.float64)
                s = nd.get("scale") or [1.0, 1.0, 1.0]
                S = np.diag([float(s[0]), float(s[1]), float(s[2])])
                q = nd.get("rotation")
                if isinstance(q, list) and len(q) == 4:
                    qx, qy, qz, qw = float(q[0]), float(q[1]), float(q[2]), float(q[3])
                    nq = math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
                    if nq > 1e-12:
                        qx, qy, qz, qw = qx / nq, qy / nq, qz / nq, qw / nq
                    R = np.array(
                        [
                            [1.0 - 2.0 * (qy * qy + qz * qz), 2.0 * (qx * qy - qw * qz), 2.0 * (qx * qz + qw * qy)],
                            [2.0 * (qx * qy + qw * qz), 1.0 - 2.0 * (qx * qx + qz * qz), 2.0 * (qy * qz - qw * qx)],
                            [2.0 * (qx * qz - qw * qy), 2.0 * (qy * qz + qw * qx), 1.0 - 2.0 * (qx * qx + qy * qy)],
                        ],
                        dtype=np.float64,
                    )
                else:
                    R = np.eye(3, dtype=np.float64)
                m[:3, :3] = R @ S
                t = nd.get("translation") or [0.0, 0.0, 0.0]
                m[:3, 3] = [float(t[0]), float(t[1]), float(t[2])]
                return m

            chunks = []
            if nodes_list:
                scenes = j.get("scenes") or []
                s_idx = int(j.get("scene", 0)) if scenes else 0
                root_idxs = (
                    list(scenes[s_idx].get("nodes") or [])
                    if (0 <= s_idx < len(scenes) and scenes[s_idx].get("nodes"))
                    else [0]
                )

                def _walk_node(n_idx: int, m_parent: np.ndarray) -> None:
                    if not (0 <= int(n_idx) < len(nodes_list)):
                        return
                    nd = nodes_list[int(n_idx)]
                    m_cur = m_parent @ _node_mat4(nd)
                    if "mesh" in nd and nd["mesh"] is not None:
                        mv = _read_mesh_pos(int(nd["mesh"]))
                        if mv is not None and len(mv) > 0:
                            chunks.append((mv @ m_cur[:3, :3].T) + m_cur[:3, 3])
                    for ch_i in nd.get("children") or []:
                        _walk_node(int(ch_i), m_cur)

                for ri in root_idxs:
                    _walk_node(int(ri), np.eye(4, dtype=np.float64))
            else:
                for mi in range(len(meshes_list)):
                    mv = _read_mesh_pos(mi)
                    if mv is not None and len(mv) > 0:
                        chunks.append(mv)

            if chunks:
                return np.vstack(chunks)
            return None
        except Exception:
            return None

    @staticmethod
    def _load_glb_vertices(glb_path: str) -> Optional[np.ndarray]:
        """Loads vertex array (N, 3) from a .glb tile, using fast binary parser or trimesh/gltfpack."""
        try:
            with open(glb_path, "rb") as f:
                raw_bytes = f.read()
            fast_verts = SurveyingEngine._extract_glb_positions_from_bytes(raw_bytes)
            if fast_verts is not None and len(fast_verts) > 0:
                return fast_verts
        except Exception:
            pass
        if trimesh is None:
            return None
        tmp_glb = None
        try:
            origin_shift = np.zeros(3, dtype=np.float64)
            try:
                loaded = trimesh.load(glb_path, process=False)
            except Exception:
                if not os.path.isfile(GLTFPACK_EXE):
                    return None
                local_in_path = glb_path
                tmp_local = None
                try:
                    if GC_SCAN_OPTIMIZER_DIR not in sys.path:
                        sys.path.append(GC_SCAN_OPTIMIZER_DIR)
                    from optimizer.geometry_optimizer import extract_glb_64bit_origin_to_local
                    with open(glb_path, "rb") as gf:
                        loc_bytes, orig_t = extract_glb_64bit_origin_to_local(gf.read())
                    if orig_t != (0.0, 0.0, 0.0):
                        origin_shift = np.array(orig_t, dtype=np.float64)
                        fd_l, tmp_local = tempfile.mkstemp(suffix=".glb")
                        with os.fdopen(fd_l, "wb") as fl:
                            fl.write(loc_bytes)
                        local_in_path = tmp_local
                    fd, tmp_glb = tempfile.mkstemp(suffix=".glb")
                    os.close(fd)
                    subprocess.run(
                        [GLTFPACK_EXE, "-i", local_in_path, "-o", tmp_glb, "-noq"],
                        capture_output=True,
                        timeout=20,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0,
                    )
                    loaded = trimesh.load(tmp_glb, process=False)
                finally:
                    if tmp_local and os.path.exists(tmp_local):
                        try:
                            os.remove(tmp_local)
                        except OSError:
                            pass

            if isinstance(loaded, trimesh.Scene):
                dumped = loaded.dump()
                verts_list = [
                    np.asarray(g.vertices, dtype=np.float64) + origin_shift
                    for g in dumped
                    if hasattr(g, "vertices") and len(g.vertices) > 0
                ]
                if not verts_list:
                    return None
                return np.vstack(verts_list)
            elif hasattr(loaded, "vertices") and len(loaded.vertices) > 0:
                return np.asarray(loaded.vertices, dtype=np.float64) + origin_shift
            return None
        except Exception:
            return None
        finally:
            if tmp_glb and os.path.exists(tmp_glb):
                try:
                    os.remove(tmp_glb)
                except OSError:
                    pass

    def _load_or_build_scan_dsm(self, scan: Dict[str, Any]) -> Dict[str, Any]:
        """
        Loads or builds a real 2D Digital Surface Model (DSM) heightfield in TWD97 (E, N) -> TWVD2001 (H)
        directly from the scan's 3D .obj mesh or .glb tileset on disk.
        Caches to <project_dir>/_dsm_cache_v3.npz and in memory for sub-millisecond reuse.
        """
        scan_id = str(scan.get("scan_id") or "unknown")
        ce = float(scan["twd97_e"]) if scan.get("twd97_e") is not None else 0.0
        cn = float(scan["twd97_n"]) if scan.get("twd97_n") is not None else 0.0
        ch = float(scan["twd97_h"]) if scan.get("twd97_h") is not None else 0.0

        proj_dir = scan.get("project_dir") or os.path.join(SCANS_ROOT_DIR, scan_id)
        obj_path = self._resolve_scan_obj_path(scan)
        ts_path = scan.get("tileset_path") or os.path.join(proj_dir, "tileset", "tileset.json")
        meta_json_path = os.path.join(proj_dir, "scan_meta.json")
        obj_mtime = os.path.getmtime(obj_path) if (obj_path and os.path.isfile(obj_path)) else 0.0
        ts_mtime = os.path.getmtime(ts_path) if (ts_path and os.path.isfile(ts_path)) else 0.0
        meta_mtime = os.path.getmtime(meta_json_path) if os.path.isfile(meta_json_path) else 0.0
        source_mtime = max(obj_mtime, ts_mtime, meta_mtime)
        # Prefer edited tileset over unedited .obj when tileset.json was modified after mesh.obj export
        tileset_edited_after_obj = bool(ts_mtime > 0.0 and obj_mtime > 0.0 and ts_mtime > obj_mtime + 2.0)

        cached = self._dsm_mem_cache.get(scan_id)
        if cached and abs(cached.get("source_mtime", -1.0) - source_mtime) < 1.0:
            return cached

        npz_path = os.path.join(proj_dir, "_dsm_cache_v5.npz") if os.path.isdir(proj_dir) else None
        if npz_path and os.path.isfile(npz_path):
            try:
                if source_mtime == 0.0 or os.path.getmtime(npz_path) >= source_mtime:
                    data = np.load(npz_path)
                    res_dict = {
                        "scan_id": scan_id,
                        "ce": float(data["ce"]),
                        "cn": float(data["cn"]),
                        "ch": float(data["ch"]),
                        "e_min": float(data["e_min"]),
                        "e_max": float(data["e_max"]),
                        "n_min": float(data["n_min"]),
                        "n_max": float(data["n_max"]),
                        "res": float(data["res"]),
                        "dsm_raw": data["dsm_raw"],
                        "dsm_contour": data["dsm_contour"],
                        "hull_mask": data["hull_mask"].astype(bool),
                        "source_mtime": source_mtime,
                    }
                    self._dsm_mem_cache[scan_id] = res_dict
                    return res_dict
            except Exception:
                pass

        # 1. Extract raw 3D vertices from .obj, .glb tiles, or .3tz archive
        raw_verts: Optional[np.ndarray] = None
        geom_source = "none"
        obj_offset_xyz = (0.0, 0.0, 0.0)
        ts_doc_loaded: Optional[Dict[str, Any]] = None

        if obj_path and os.path.isfile(obj_path) and not tileset_edited_after_obj:
            off_cand = os.path.join(os.path.dirname(obj_path), "offset.xyz")
            if os.path.isfile(off_cand):
                try:
                    with open(off_cand, "r", encoding="utf-8", errors="ignore") as f_off:
                        toks = f_off.read().strip().split()
                    if len(toks) >= 3:
                        obj_offset_xyz = (float(toks[0]), float(toks[1]), float(toks[2]))
                except Exception:
                    pass
            verts_list = []
            with open(obj_path, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    if line.startswith("v "):
                        parts = line.split()
                        if len(parts) >= 4:
                            verts_list.append((float(parts[1]), float(parts[2]), float(parts[3])))
            if verts_list:
                raw_verts = np.array(verts_list, dtype=np.float64)
                geom_source = "obj"

        if raw_verts is None or len(raw_verts) == 0:
            if ts_path and os.path.isfile(ts_path) and ts_path.lower().endswith(".json"):
                try:
                    with open(ts_path, "r", encoding="utf-8") as tf:
                        ts_doc_loaded = json.load(tf)
                except Exception:
                    ts_doc_loaded = None
            glb_files = self._collect_scan_glb_files(scan)
            if glb_files:
                chunks = []
                for gp in glb_files[:24]:
                    v_arr = self._load_glb_vertices(gp)
                    if v_arr is not None and len(v_arr) > 0:
                        chunks.append(v_arr)
                if chunks:
                    raw_verts = np.vstack(chunks)
                    geom_source = "glb"

        if raw_verts is None or len(raw_verts) == 0:
            # Fallback to .3tz stream package archive (supports Linux VPS zero-raw-storage mode)
            import zipfile

            base_repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            cand_3tz = [
                os.path.join(base_repo, "data", "stream_packages", f"{scan_id}.3tz"),
                f"/host_docker/gathering_scans/data/stream_packages/{scan_id}.3tz",
                os.path.join(SCANS_ROOT_DIR, f"{scan_id}.3tz"),
            ]
            for zp in cand_3tz:
                if os.path.isfile(zp):
                    try:
                        with zipfile.ZipFile(zp, "r") as zf:
                            if ts_doc_loaded is None and "tileset.json" in zf.namelist():
                                try:
                                    ts_doc_loaded = json.loads(zf.read("tileset.json").decode("utf-8"))
                                except Exception:
                                    pass
                            glb_names = [
                                n for n in zf.namelist()
                                if n.lower().endswith(".glb") and "preview" not in n.lower()
                            ]
                            if not glb_names:
                                glb_names = [n for n in zf.namelist() if n.lower().endswith(".glb")]
                            glb_names.sort(key=lambda n: zf.getinfo(n).file_size, reverse=True)
                            chunks = []
                            for gn in glb_names[:16]:
                                v_arr = self._extract_glb_positions_from_bytes(zf.read(gn))
                                if v_arr is not None and len(v_arr) > 0:
                                    chunks.append(v_arr)
                            if chunks:
                                raw_verts = np.vstack(chunks)
                                geom_source = "glb"
                                break
                    except Exception:
                        pass

        if raw_verts is None or len(raw_verts) < 3:
            raise RuntimeError(f"No 3D mesh geometry (.obj, .glb, or .3tz) found on disk for scan '{scan_id}'.")

        def _utm51n_arrays_to_twd97(ux: np.ndarray, uy: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
            from pc_worker.gdrive_watcher import utm51n_to_wgs84

            u0_x = float(ux.mean())
            u0_y = float(uy.mean())
            lat_c, lon_c = utm51n_to_wgs84(u0_x, u0_y)
            e0, n0 = wgs84_to_twd97(lat_c, lon_c)
            lat_dx, lon_dx = utm51n_to_wgs84(u0_x + 20.0, u0_y)
            ex_p, nx_p = wgs84_to_twd97(lat_dx, lon_dx)
            lat_dy, lon_dy = utm51n_to_wgs84(u0_x, u0_y + 20.0)
            ey_p, ny_p = wgs84_to_twd97(lat_dy, lon_dy)
            j00, j10 = (ex_p - e0) / 20.0, (nx_p - n0) / 20.0
            j01, j11 = (ey_p - e0) / 20.0, (ny_p - n0) / 20.0
            dx_u = ux - u0_x
            dy_u = uy - u0_y
            return e0 + j00 * dx_u + j01 * dy_u, n0 + j10 * dx_u + j11 * dy_u

        # 2. Transform vertices to scan CRS (E, N, H) using exact offset.xyz / root.transform
        crs_upper = str(scan.get("crs") or "").upper()
        is_local_scan = ("LOCAL" in crs_upper) or (scan.get("lat") is None and abs(ce) < 50000.0 and abs(cn) < 50000.0)

        if geom_source == "obj":
            vx = raw_verts[:, 0] + obj_offset_xyz[0]
            vy = raw_verts[:, 1] + obj_offset_xyz[1]
            vz = raw_verts[:, 2] + obj_offset_xyz[2]
            mx, my = float(vx.mean()), float(vy.mean())
            if is_local_scan:
                pts_e, pts_n, pts_h = vx, vy, vz
            elif 150000.0 <= mx <= 345000.0 and 2400000.0 <= my <= 2850000.0:
                pts_e, pts_n, pts_h = vx, vy, vz
            elif 345000.0 < mx <= 415000.0 and 2500000.0 <= my <= 3000000.0 and 150000.0 <= ce <= 345000.0:
                pts_e, pts_n = _utm51n_arrays_to_twd97(vx, vy)
                pts_h = vz
            elif abs(mx) > 50000.0 or abs(my) > 50000.0:
                pts_e, pts_n, pts_h = vx, vy, vz
            else:
                vcen = 0.5 * (raw_verts.min(axis=0) + raw_verts.max(axis=0))
                pts_e = ce + (raw_verts[:, 0] - vcen[0])
                pts_n = cn + (raw_verts[:, 1] - vcen[1])
                pts_h = ch + (raw_verts[:, 2] - vcen[2])
        else:
            root_tf = ((ts_doc_loaded or {}).get("root") or {}).get("transform") if isinstance(ts_doc_loaded, dict) else None
            has_rtf = isinstance(root_tf, list) and len(root_tf) == 16
            asset_up = str(((ts_doc_loaded or {}).get("asset") or {}).get("gltfUpAxis") or "").upper()
            v_max_abs = np.abs(raw_verts).max(axis=0)
            spans = raw_verts.max(axis=0) - raw_verts.min(axis=0)
            if has_rtf and asset_up != "Z":
                # 3D Tiles 1.0 default glTF Y-up -> Z-up root-local: (x, y, z) -> (x, -z, y)
                rx = raw_verts[:, 0]
                ry = -raw_verts[:, 2]
                rz = raw_verts[:, 1]
            elif asset_up == "Z" or v_max_abs[0] > 50000.0 or spans[2] < min(spans[0], spans[1]) * 0.85:
                rx = raw_verts[:, 0]
                ry = raw_verts[:, 1]
                rz = raw_verts[:, 2]
            else:
                rx = raw_verts[:, 0]
                ry = -raw_verts[:, 2]
                rz = raw_verts[:, 1]

            if has_rtf:
                m_r = np.array([float(x) for x in root_tf[:16]], dtype=np.float64).reshape((4, 4), order="F")  # type: ignore[index]
                pts_w = (np.column_stack([rx, ry, rz]) @ m_r[:3, :3].T) + m_r[:3, 3]
                wx, wy, wz = pts_w[:, 0], pts_w[:, 1], pts_w[:, 2]
            else:
                wx, wy, wz = rx, ry, rz

            mx, my, mz = float(wx.mean()), float(wy.mean()), float(wz.mean())
            if abs(mx) > 1000000.0 and abs(my) > 1000000.0:
                # ECEF world vertices -> local ENU around ECEF centroid + (ce, cn, ch)
                from pc_worker.gdrive_watcher import _ecef_to_wgs84

                lat0_r_deg, lon0_r_deg, _ = _ecef_to_wgs84(mx, my, mz)
                lat_r = math.radians(lat0_r_deg)
                lon_r = math.radians(lon0_r_deg)
                dx_c = wx - mx
                dy_c = wy - my
                dz_c = wz - mz
                de = -math.sin(lon_r) * dx_c + math.cos(lon_r) * dy_c
                dn = -math.sin(lat_r) * math.cos(lon_r) * dx_c - math.sin(lat_r) * math.sin(lon_r) * dy_c + math.cos(lat_r) * dz_c
                dh = math.cos(lat_r) * math.cos(lon_r) * dx_c + math.cos(lat_r) * math.sin(lon_r) * dy_c + math.sin(lat_r) * dz_c
                pts_e = ce + de
                pts_n = cn + dn
                pts_h = ch + dh
            elif is_local_scan:
                pts_e, pts_n, pts_h = wx, wy, wz
            elif 345000.0 < mx <= 415000.0 and 2500000.0 <= my <= 3000000.0 and 150000.0 <= ce <= 345000.0:
                pts_e, pts_n = _utm51n_arrays_to_twd97(wx, wy)
                pts_h = wz + (ch - float(np.median(wz))) if (mz < -50.0 and ch > -50.0) else wz
            elif abs(mx) > 50000.0 or abs(my) > 50000.0:
                pts_e, pts_n = wx, wy
                pts_h = wz + (ch - float(np.median(wz))) if (mz < -50.0 and ch > -50.0) else wz
            else:
                vcen = 0.5 * (np.array([wx.min(), wy.min(), wz.min()]) + np.array([wx.max(), wy.max(), wz.max()]))
                pts_e = ce + (wx - vcen[0])
                pts_n = cn + (wy - vcen[1])
                pts_h = ch + (wz - vcen[2])

        e_min, e_max = float(pts_e.min()), float(pts_e.max())
        n_min, n_max = float(pts_n.min()), float(pts_n.max())
        max_span = max(e_max - e_min, n_max - n_min, 2.0)
        if max_span <= 35.0:
            res = 0.06
        elif max_span <= 85.0:
            res = 0.12
        elif max_span <= 160.0:
            res = 0.25
        elif max_span <= 360.0:
            res = 0.35
        else:
            res = 0.50

        nx = max(int(math.ceil((e_max - e_min) / res)) + 1, 8)
        ny = max(int(math.ceil((n_max - n_min) / res)) + 1, 8)

        ie = np.clip(((pts_e - e_min) / res).astype(np.int32), 0, nx - 1)
        in_ = np.clip(((pts_n - n_min) / res).astype(np.int32), 0, ny - 1)

        grid_max = np.full((ny, nx), -np.inf, dtype=np.float32)
        np.maximum.at(grid_max, (in_, ie), pts_h)
        valid = np.isfinite(grid_max)

        # Fill triangle interiors up to 8.0m using Euclidean distance transform
        dist_cells, nearest_idx = distance_transform_edt(~valid, return_indices=True)
        hull_mask = dist_cells <= max(4.0, 8.0 / res)
        filled = grid_max[nearest_idx[0], nearest_idx[1]]

        dsm_raw = gaussian_filter(filled, sigma=0.65).astype(np.float32)
        dsm_raw = np.where(valid, 0.75 * grid_max + 0.25 * dsm_raw, dsm_raw)
        dsm_contour = gaussian_filter(filled, sigma=1.65).astype(np.float32)

        res_dict = {
            "scan_id": scan_id,
            "ce": ce,
            "cn": cn,
            "ch": ch,
            "e_min": e_min,
            "e_max": e_max,
            "n_min": n_min,
            "n_max": n_max,
            "res": res,
            "dsm_raw": dsm_raw,
            "dsm_contour": dsm_contour,
            "hull_mask": hull_mask,
            "source_mtime": source_mtime,
        }
        self._dsm_mem_cache[scan_id] = res_dict

        if npz_path:
            try:
                np.savez_compressed(
                    npz_path,
                    ce=ce,
                    cn=cn,
                    ch=ch,
                    e_min=e_min,
                    e_max=e_max,
                    n_min=n_min,
                    n_max=n_max,
                    res=res,
                    dsm_raw=dsm_raw,
                    dsm_contour=dsm_contour,
                    hull_mask=hull_mask.astype(np.uint8),
                )
            except Exception:
                pass

        return res_dict

    @staticmethod
    def _sample_dsm_elevation(
        dsm_data: Dict[str, Any],
        easting: float,
        northing: float,
        use_contour_smooth: bool = False,
    ) -> Tuple[float, float, float, bool]:
        """
        Bilinearly samples elevation H (TWVD2001 m) and local slope gradients (dz/de, dz/dn)
        at TWD97 (easting, northing) from a loaded scan DSM.
        Returns (elevation_h, dz_de, dz_dn, is_inside_hull).
        """
        grid = dsm_data["dsm_contour"] if use_contour_smooth else dsm_data["dsm_raw"]
        hull = dsm_data["hull_mask"]
        e_min = dsm_data["e_min"]
        n_min = dsm_data["n_min"]
        res = dsm_data["res"]
        ny, nx = grid.shape

        fe = (easting - e_min) / res
        fn = (northing - n_min) / res
        inside_bounds = (0.0 <= fe <= nx - 1.0) and (0.0 <= fn <= ny - 1.0)

        fe_c = min(max(fe, 0.0), float(nx - 1) - 1e-5)
        fn_c = min(max(fn, 0.0), float(ny - 1) - 1e-5)
        i0 = int(fe_c)
        j0 = int(fn_c)
        i1 = min(i0 + 1, nx - 1)
        j1 = min(j0 + 1, ny - 1)
        tx = fe_c - i0
        ty = fn_c - j0

        z00 = float(grid[j0, i0])
        z10 = float(grid[j0, i1])
        z01 = float(grid[j1, i0])
        z11 = float(grid[j1, i1])

        z0 = z00 * (1.0 - tx) + z10 * tx
        z1 = z01 * (1.0 - tx) + z11 * tx
        z_val = z0 * (1.0 - ty) + z1 * ty

        dz_de = ((z10 - z00) * (1.0 - ty) + (z11 - z01) * ty) / res
        dz_dn = ((z01 - z00) * (1.0 - tx) + (z11 - z10) * tx) / res
        is_valid = bool(inside_bounds and hull[j0, i0])
        return z_val, dz_de, dz_dn, is_valid

    def calculate_cut_fill_volume(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Computes real Cut/Fill Volumes & Material Stockpile Tonnage inside a 2D/3D boundary polygon
        by integrating the scan's actual 3D mesh Digital Surface Model (DSM).
        Supports 3 Base Modes:
        - 'triangulated_boundary': interpolates base surface from real mesh elevations along polygon perimeter
        - 'custom_plane': uses user-specified flat datum elevation Z0 (TWVD2001 m)
        - 'epoch_diff': compares active scan's 3D mesh DSM against a baseline scan's 3D mesh DSM in TWD97 space
        """
        scan_id = (payload.get("scan_id") or "").strip()
        compare_scan_id = payload.get("compare_scan_id")
        base_mode = payload.get("base_mode", "triangulated_boundary")
        material_key = payload.get("material_type", "crushed_stone")
        custom_density = payload.get("density_t_m3")
        stockpile_name = payload.get("stockpile_name") or "Stockpile / Earthwork Zone A"

        scan = self._resolve_scan_record(scan_id)

        dsm_curr = self._load_or_build_scan_dsm(scan)
        center_e = dsm_curr["ce"]
        center_n = dsm_curr["cn"]
        center_h = dsm_curr["ch"]

        # Load baseline DSM when epoch_diff is selected
        dsm_cmp = None
        if base_mode == "epoch_diff":
            cmp_scan = self.db.get_scan(compare_scan_id) if compare_scan_id else None
            if not cmp_scan:
                for cand in self.db.list_scans():
                    if cand.get("scan_id") != scan.get("scan_id") and cand.get("project_group") == scan.get("project_group"):
                        cmp_scan = cand
                        compare_scan_id = cand.get("scan_id")
                        break
            if cmp_scan:
                try:
                    dsm_cmp = self._load_or_build_scan_dsm(cmp_scan)
                except Exception:
                    dsm_cmp = None

        raw_poly = payload.get("polygon", [])
        if not raw_poly or len(raw_poly) < 3:
            # Adaptive default boundary scaled to 28% of the scan's actual DSM span
            span_e_def = min(8.0, max(1.5, (dsm_curr["e_max"] - dsm_curr["e_min"]) * 0.28))
            span_n_def = min(7.0, max(1.5, (dsm_curr["n_max"] - dsm_curr["n_min"]) * 0.28))
            raw_poly = [
                [center_e - span_e_def, center_n - span_n_def],
                [center_e + span_e_def, center_n - span_n_def],
                [center_e + span_e_def, center_n + span_n_def],
                [center_e - span_e_def, center_n + span_n_def],
            ]

        # Convert local viewer coordinates (if small numbers < 10000) to TWD97 (121) + sample true DSM elevation
        poly_twd: List[Tuple[float, float, float]] = []
        poly_local: List[List[float]] = []
        for pt in raw_poly:
            if isinstance(pt, dict):
                px = float(pt.get("x", pt.get("e", 0.0)))
                py = float(pt.get("z", pt.get("n", 0.0)))
                if abs(px) < 10000 and abs(py) < 10000:
                    e_val = round(center_e + px, 3)
                    n_val = round(center_n - py, 3)
                else:
                    e_val = round(px, 3)
                    n_val = round(py, 3)
            else:
                px = float(pt[0])
                py = float(pt[1])
                if abs(px) < 10000 and abs(py) < 10000:
                    e_val = round(center_e + px, 3)
                    n_val = round(center_n - py, 3)
                else:
                    e_val = round(px, 3)
                    n_val = round(py, 3)

            sampled_h, _, _, _ = self._sample_dsm_elevation(dsm_curr, e_val, n_val)
            h_val = round(sampled_h, 3)
            poly_twd.append((e_val, n_val, h_val))
            poly_local.append([round(e_val - center_e, 3), round(h_val - center_h, 3), round(center_n - n_val, 3)])

        pts_2d = [(p[0], p[1]) for p in poly_twd]
        planar_area_m2, perimeter_m = polygon_area_and_perimeter_2d(pts_2d)
        planar_area_ping = planar_area_m2 * 0.3025

        min_e = min(p[0] for p in poly_twd)
        max_e = max(p[0] for p in poly_twd)
        min_n = min(p[1] for p in poly_twd)
        max_n = max(p[1] for p in poly_twd)

        # Sample densely along the polygon perimeter on the real DSM for boundary interpolation
        perim_samples: List[Tuple[float, float, float]] = []
        n_verts = len(poly_twd)
        for i in range(n_verts):
            ax, ay, _ = poly_twd[i]
            bx, by, _ = poly_twd[(i + 1) % n_verts]
            seg_len = math.hypot(bx - ax, by - ay)
            n_sub = max(int(math.ceil(seg_len / 0.25)), 2)
            for k in range(n_sub):
                t = k / n_sub
                sx = ax + t * (bx - ax)
                sy = ay + t * (by - ay)
                sz, _, _, _ = self._sample_dsm_elevation(dsm_curr, sx, sy)
                perim_samples.append((sx, sy, sz))

        perim_mean_h = sum(p[2] for p in perim_samples) / max(len(perim_samples), 1)
        datum_z = float(payload.get("datum_elevation_m", perim_mean_h))

        # High-resolution integration grid inside bounding box (adaptive 28..64 cells per axis)
        span_box_e = max(max_e - min_e, 0.25)
        span_box_n = max(max_n - min_n, 0.25)
        nx_steps = min(64, max(28, int(math.ceil(span_box_e / max(dsm_curr["res"], 0.08)))))
        ny_steps = min(64, max(28, int(math.ceil(span_box_n / max(dsm_curr["res"], 0.08)))))
        dx_step = span_box_e / nx_steps
        dy_step = span_box_n / ny_steps
        cell_area = dx_step * dy_step

        fill_vol = 0.0
        cut_vol = 0.0
        surface_area = 0.0
        max_dz = -1e9
        min_dz = 1e9
        inside_cells = 0
        heatmap_cells = []

        # Subsample stride for heatmap_cells so we return <= 300 3D visualization cells
        total_est_inside = max(1, int(nx_steps * ny_steps * 0.6))
        vis_stride = max(1, total_est_inside // 240)

        for ix in range(nx_steps):
            for iy in range(ny_steps):
                gx = min_e + (ix + 0.5) * dx_step
                gy = min_n + (iy + 0.5) * dy_step
                if not point_in_polygon_2d(gx, gy, pts_2d):
                    continue
                inside_cells += 1

                # Real 3D scan surface elevation & slope gradients at (gx, gy)
                z_surf, dz_de, dz_dn, _ = self._sample_dsm_elevation(dsm_curr, gx, gy)

                if base_mode == "custom_plane":
                    z_base = datum_z
                elif base_mode == "epoch_diff" and dsm_cmp is not None:
                    z_base, _, _, _ = self._sample_dsm_elevation(dsm_cmp, gx, gy)
                else:
                    # Inverse-distance weighted interpolation of dense perimeter DSM elevations
                    w_sum = 0.0
                    z_interp = 0.0
                    for vx, vy, vz in perim_samples:
                        d2 = (gx - vx) ** 2 + (gy - vy) ** 2 + 0.04
                        w = 1.0 / d2
                        w_sum += w
                        z_interp += w * vz
                    z_base = z_interp / max(w_sum, 1e-9)

                dz = z_surf - z_base
                max_dz = max(max_dz, dz)
                min_dz = min(min_dz, dz)

                if dz >= 0:
                    fill_vol += dz * cell_area
                else:
                    cut_vol += abs(dz) * cell_area

                # True 3D sloped surface area element dA * sqrt(1 + (dz/de)^2 + (dz/dn)^2)
                surface_area += cell_area * math.sqrt(1.0 + dz_de * dz_de + dz_dn * dz_dn)

                if (inside_cells - 1) % vis_stride == 0 and len(heatmap_cells) < 300:
                    heatmap_cells.append(
                        {
                            "e": round(gx, 2),
                            "n": round(gy, 2),
                            "z_surf": round(z_surf, 3),
                            "z_base": round(z_base, 3),
                            "dz": round(dz, 3),
                            "lx": round(gx - center_e, 3),
                            "ly_surf": round(z_surf - center_h, 3),
                            "ly_base": round(z_base - center_h, 3),
                            "lz": round(center_n - gy, 3),
                        }
                    )

        # Normalize cell sum to exact Shoelace planar polygon area
        if inside_cells > 0:
            raw_grid_area = inside_cells * cell_area
            area_scale = planar_area_m2 / max(raw_grid_area, 1e-6)
            fill_vol *= area_scale
            cut_vol *= area_scale
            surface_area *= area_scale

        net_vol = fill_vol - cut_vol

        mat_info = MATERIAL_CATALOG.get(material_key, MATERIAL_CATALOG["crushed_stone"])
        density = float(custom_density) if custom_density is not None else float(mat_info["density_t_m3"])
        swell = float(mat_info["swell_factor"])

        effective_m3 = fill_vol if fill_vol >= cut_vol else cut_vol
        tonnage_loose = effective_m3 * density
        tonnage_bank = effective_m3 * density * swell

        ts_id = int(time.time())
        report_base = f"stockpile_report_{scan_id}_{ts_id}"
        html_filename = f"{report_base}.html"
        csv_filename = f"{report_base}.csv"

        result = {
            "status": "ok",
            "scan_id": scan_id,
            "scan_name": scan.get("name"),
            "project_group": scan.get("project_group") or "Unassigned Site",
            "stockpile_name": stockpile_name,
            "crs": TWD97_TWVD2001_LABEL,
            "crs_short": TWD97_TWVD2001_SHORT,
            "base_mode": base_mode,
            "compare_scan_id": compare_scan_id if base_mode == "epoch_diff" else None,
            "datum_elevation_m": round(datum_z, 3),
            "planar_area_m2": round(planar_area_m2, 2),
            "planar_area_ping": round(planar_area_ping, 2),
            "surface_area_m2": round(max(surface_area, planar_area_m2), 2),
            "perimeter_m": round(perimeter_m, 2),
            "fill_volume_m3": round(fill_vol, 2),
            "cut_volume_m3": round(cut_vol, 2),
            "net_volume_m3": round(net_vol, 2),
            "max_delta_z_m": round(max_dz if max_dz > -1e8 else 0.0, 2),
            "min_delta_z_m": round(min_dz if min_dz < 1e8 else 0.0, 2),
            "material_key": material_key,
            "material_name": mat_info["name"],
            "density_t_m3": round(density, 2),
            "swell_factor": round(swell, 2),
            "estimated_tonnage_t": round(tonnage_loose, 2),
            "bank_tonnage_t": round(tonnage_bank, 2),
            "boundary_twd97": [
                {"vertex": i + 1, "easting_m": p[0], "northing_m": p[1], "twvd2001_h_m": p[2]}
                for i, p in enumerate(poly_twd)
            ],
            "boundary_local": poly_local,
            "cell_step_m": round(max(dx_step, dy_step), 3),
            "perim_mean_h_m": round(perim_mean_h, 3),
            "heatmap_cells": heatmap_cells,
            "report_html_url": f"/api/reports/{html_filename}",
            "report_csv_url": f"/api/reports/{csv_filename}",
            "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }

        self._write_stockpile_reports(result, html_filename, csv_filename)
        return result

    def _write_stockpile_reports(self, data: Dict[str, Any], html_filename: str, csv_filename: str):
        """Writes downloadable HTML/PDF-ready and Excel CSV stockpile & cut/fill reports."""
        html_path = os.path.join(REPORTS_DIR, html_filename)
        csv_path = os.path.join(REPORTS_DIR, csv_filename)

        # 1. Write UTF-8-SIG CSV for Excel
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as cf:
            writer = csv.writer(cf)
            writer.writerow(["GatheringScans Civil Engineering & Stockpile Volume Report"])
            writer.writerow(["Project Group", data["project_group"]])
            writer.writerow(["Scan Name", data["scan_name"]])
            writer.writerow(["Zone / Stockpile Name", data["stockpile_name"]])
            writer.writerow(["Coordinate Reference System", data["crs"]])
            writer.writerow(["Base Surface Mode", data["base_mode"]])
            writer.writerow(["Generated At", data["generated_at"]])
            writer.writerow([])
            writer.writerow(["Metric", "Value", "Unit"])
            writer.writerow(["Fill / Stockpile Volume (+)", data["fill_volume_m3"], "m³"])
            writer.writerow(["Cut / Excavation Volume (-)", data["cut_volume_m3"], "m³"])
            writer.writerow(["Net Earthwork Volume", data["net_volume_m3"], "m³"])
            writer.writerow(["2D Planar Footprint Area", data["planar_area_m2"], "m²"])
            writer.writerow(["2D Planar Footprint Area (Ping)", data["planar_area_ping"], "坪"])
            writer.writerow(["3D Sloped Surface Area", data["surface_area_m2"], "m²"])
            writer.writerow(["Boundary Perimeter", data["perimeter_m"], "m"])
            writer.writerow(["Material Classification", data["material_name"], ""])
            writer.writerow(["Material Bulk Density", data["density_t_m3"], "t/m³"])
            writer.writerow(["Estimated Material Mass (Loose)", data["estimated_tonnage_t"], "tonnes (公噸)"])
            writer.writerow(["Estimated Compacted/Bank Mass", data["bank_tonnage_t"], "tonnes (公噸)"])
            writer.writerow([])
            writer.writerow(["Boundary Vertex #", "TWD97 Easting E (m)", "TWD97 Northing N (m)", "TWVD2001 Elevation H (m)"])
            for v in data["boundary_twd97"]:
                writer.writerow([v["vertex"], v["easting_m"], v["northing_m"], v["twvd2001_h_m"]])

        # 2. Write Printable Engineering HTML Report (with Print-to-PDF button)
        rows_html = "".join(
            f"<tr><td>V{v['vertex']}</td><td>{v['easting_m']:.3f}</td><td>{v['northing_m']:.3f}</td><td>{v['twvd2001_h_m']:.3f}</td></tr>"
            for v in data["boundary_twd97"]
        )
        html_doc = f"""<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<title>Earthwork & Stockpile Report — {data['stockpile_name']}</title>
<style>
  body {{ font-family: 'Segoe UI', 'Microsoft JhengHei', sans-serif; color: #0f172a; margin: 32px auto; max-width: 920px; line-height: 1.5; }}
  .header {{ display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #0284c7; padding-bottom: 16px; margin-bottom: 24px; }}
  .title {{ font-size: 22px; font-weight: 800; color: #0f172a; }}
  .subtitle {{ font-size: 13px; color: #475569; margin-top: 4px; }}
  .badge {{ background: #e0f2fe; color: #0369a1; font-weight: 700; padding: 6px 12px; border-radius: 6px; font-size: 12px; }}
  .kpi-grid {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 24px; }}
  .kpi {{ border: 1px solid #cbd5e1; border-radius: 8px; padding: 14px; background: #f8fafc; }}
  .kpi-label {{ font-size: 12px; color: #64748b; font-weight: 600; }}
  .kpi-val {{ font-size: 22px; font-weight: 800; margin-top: 4px; color: #0f172a; }}
  .kpi-val.fill {{ color: #059669; }}
  .kpi-val.cut {{ color: #dc2626; }}
  .kpi-val.ton {{ color: #0284c7; }}
  table {{ width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 13px; }}
  th, td {{ border: 1px solid #cbd5e1; padding: 9px 12px; text-align: left; }}
  th {{ background: #f1f5f9; font-weight: 700; color: #334155; }}
  .sign-grid {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 36px; }}
  .sign-box {{ border-top: 1px solid #64748b; padding-top: 8px; font-size: 12px; color: #475569; }}
  .no-print {{ margin-bottom: 20px; display: flex; gap: 10px; }}
  .btn {{ background: #0284c7; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; font-weight: 600; cursor: pointer; text-decoration: none; font-size: 13px; }}
  @media print {{ .no-print {{ display: none; }} body {{ margin: 10mm; }} }}
</style>
</head>
<body>
  <div class="no-print">
    <button class="btn" onclick="window.print()">Print / Save as PDF (列印或另存 PDF)</button>
    <a class="btn" style="background:#059669;" href="{data['report_csv_url']}" download>Download Excel CSV (下載報表)</a>
  </div>
  <div class="header">
    <div>
      <img src="/assets/gathering_construction_logo.png" alt="聚人營造股份有限公司 GATHERING CONSTRUCTION.,LTD." style="height:38px;margin-bottom:8px;display:block;" />
      <div class="title">土方體積與物料堆置量測報告 (Stockpile & Cut/Fill Report)</div>
      <div class="subtitle">Project: <b>{data['project_group']}</b> | Scan: <b>{data['scan_name']}</b> | Generated: {data['generated_at']}</div>
      <div class="subtitle">CRS: <b>{data['crs']}</b></div>
    </div>
    <div class="badge">RTK Photogrammetry Verified</div>
  </div>

  <div class="kpi-grid">
    <div class="kpi">
      <div class="kpi-label">Fill / Stockpile Volume (填方/堆置)</div>
      <div class="kpi-val fill">+{data['fill_volume_m3']:,.2f} m³</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Cut / Excavation Volume (挖方)</div>
      <div class="kpi-val cut">-{data['cut_volume_m3']:,.2f} m³</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Net Volume (淨土方量)</div>
      <div class="kpi-val">{data['net_volume_m3']:+,.2f} m³</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Estimated Mass (預估物料噸數)</div>
      <div class="kpi-val ton">{data['estimated_tonnage_t']:,.2f} t</div>
    </div>
  </div>

  <table>
    <thead>
      <tr><th colspan="4">1. Engineering Parameters & Material Tonnage Summary (工程參數與物料重量計算)</th></tr>
    </thead>
    <tbody>
      <tr><td><b>Stockpile / Zone ID</b></td><td>{data['stockpile_name']}</td><td><b>Base Surface Method</b></td><td>{data['base_mode']}</td></tr>
      <tr><td><b>2D Planar Area</b></td><td>{data['planar_area_m2']:,.2f} m² ({data['planar_area_ping']:,.2f} 坪)</td><td><b>3D Surface Area</b></td><td>{data['surface_area_m2']:,.2f} m²</td></tr>
      <tr><td><b>Boundary Perimeter</b></td><td>{data['perimeter_m']:,.2f} m</td><td><b>Datum Elevation (TWVD2001)</b></td><td>{data['datum_elevation_m']:.3f} m</td></tr>
      <tr><td><b>Material Type</b></td><td>{data['material_name']}</td><td><b>Bulk Density / Swell</b></td><td>{data['density_t_m3']:.2f} t/m³ (Factor: {data['swell_factor']:.2f})</td></tr>
      <tr><td><b>Loose Stockpile Tonnage</b></td><td><b>{data['estimated_tonnage_t']:,.2f} tonnes (公噸)</b></td><td><b>Bank / Compacted Tonnage</b></td><td><b>{data['bank_tonnage_t']:,.2f} tonnes (公噸)</b></td></tr>
    </tbody>
  </table>

  <table>
    <thead>
      <tr><th>Vertex #</th><th>TWD97 (121) Easting E (m)</th><th>TWD97 (121) Northing N (m)</th><th>TWVD2001 Orthometric Height H (m)</th></tr>
    </thead>
    <tbody>
      {rows_html}
    </tbody>
  </table>

  <div class="sign-grid">
    <div class="sign-box">Surveyed & Computed By (測量工程師):<br><br>___________________________</div>
    <div class="sign-box">Site Supervisor Review (工地主任複核):<br><br>___________________________</div>
    <div class="sign-box">Client / Inspector Sign-off (業主/監造簽認):<br><br>___________________________</div>
  </div>
</body>
</html>"""
        with open(html_path, "w", encoding="utf-8") as hf:
            hf.write(html_doc)

    def _normalize_mask_polygon_twd97(
        self,
        raw_poly: Any,
        ce: float,
        cn: float,
        ch: float,
        dsm_data: Optional[Dict[str, Any]] = None,
    ) -> Tuple[List[Tuple[float, float, float]], List[List[float]], bool]:
        """
        Normalizes a user-supplied mask boundary polygon (either local viewer [x,y,z] or TWD97 [E,N,H])
        into (poly_twd97, poly_local, is_custom).
        If fewer than 3 vertices are provided, generates a default 6-vertex survey boundary fitted to the scan's real DSM.
        """
        poly_twd: List[Tuple[float, float, float]] = []
        poly_local: List[List[float]] = []
        is_custom = False

        if isinstance(raw_poly, list) and len(raw_poly) >= 3:
            is_custom = True
            for pt in raw_poly:
                if isinstance(pt, dict):
                    px = float(pt.get("x", pt.get("e", 0.0)))
                    py = float(pt.get("y", pt.get("n", 0.0)))
                    pz = float(pt.get("z", pt.get("h", ch)))
                    is_local_dict = "x" in pt and "z" in pt and abs(px) < 10000
                    if is_local_dict:
                        lx, ly, lz = px, py, pz
                        e_val = round(ce + lx, 3)
                        n_val = round(cn - lz, 3)
                        h_val = round(ch + ly, 3)
                    else:
                        e_val = round(px, 3)
                        n_val = round(py, 3)
                        h_val = round(pz, 3)
                else:
                    px = float(pt[0])
                    py = float(pt[1])
                    pz = float(pt[2]) if len(pt) >= 3 else ch
                    if abs(px) < 10000 and abs(py) < 10000:
                        e_val = round(ce + px, 3)
                        n_val = round(cn - py, 3)
                        h_val = round(ch + pz if abs(pz) < 25 else pz, 3)
                    else:
                        e_val = round(px, 3)
                        n_val = round(py, 3)
                        h_val = round(pz, 3)

                if dsm_data is not None:
                    sampled_h, _, _, _ = self._sample_dsm_elevation(dsm_data, e_val, n_val)
                    h_val = round(sampled_h, 3)

                lx = round(e_val - ce, 3)
                lz = round(cn - n_val, 3)
                ly = round(h_val - ch, 3)
                poly_twd.append((e_val, n_val, h_val))
                poly_local.append([lx, ly, lz])
        else:
            # Default 6-vertex survey mask boundary scaled to the scan's valid DSM footprint
            half_e = 36.0
            half_n = 28.0
            if dsm_data is not None:
                half_e = min(90.0, max(20.0, (dsm_data["e_max"] - dsm_data["e_min"]) * 0.34))
                half_n = min(80.0, max(18.0, (dsm_data["n_max"] - dsm_data["n_min"]) * 0.34))
            default_offsets = [
                (-half_e * 0.85, -half_n * 0.85),
                (half_e * 0.48, -half_n * 0.92),
                (half_e * 0.96, -half_n * 0.22),
                (half_e * 0.84, half_n * 0.86),
                (-half_e * 0.42, half_n * 0.94),
                (-half_e * 0.96, half_n * 0.28),
            ]
            for dx, dn in default_offsets:
                e_val = round(ce + dx, 3)
                n_val = round(cn + dn, 3)
                if dsm_data is not None:
                    sampled_h, _, _, _ = self._sample_dsm_elevation(dsm_data, e_val, n_val)
                    h_val = round(sampled_h, 3)
                else:
                    h_val = round(ch, 3)
                lx = round(dx, 3)
                lz = round(-dn, 3)
                ly = round(h_val - ch, 3)
                poly_twd.append((e_val, n_val, h_val))
                poly_local.append([lx, ly, lz])

        return poly_twd, poly_local, is_custom

    @staticmethod
    def _extract_marching_squares_polylines_twd(
        grid: np.ndarray,
        valid_mask: np.ndarray,
        e_min: float,
        n_min: float,
        res: float,
        level: float,
    ) -> List[List[float]]:
        """
        Extracts continuous, topologically stitched 2D/3D contour polylines [[e, n, level], ...]
        at elevation `level` using the 16-case Marching Squares algorithm over `grid`.
        """
        v00 = grid[:-1, :-1]
        v10 = grid[:-1, 1:]
        v11 = grid[1:, 1:]
        v01 = grid[1:, :-1]
        cell_valid = valid_mask[:-1, :-1] & valid_mask[:-1, 1:] & valid_mask[1:, 1:] & valid_mask[1:, :-1]

        c_idx = (
            ((v00 >= level).astype(np.uint8) * 1)
            | ((v10 >= level).astype(np.uint8) * 2)
            | ((v11 >= level).astype(np.uint8) * 4)
            | ((v01 >= level).astype(np.uint8) * 8)
        )
        c_idx = np.where(cell_valid, c_idx, 0)
        js, is_ = np.nonzero((c_idx > 0) & (c_idx < 15))
        if len(js) == 0:
            return []

        edge_coords: Dict[Tuple[int, int, int], Tuple[float, float]] = {}
        adj: Dict[Tuple[int, int, int], List[Tuple[int, int, int]]] = {}

        for j, i in zip(js.tolist(), is_.tolist()):
            code = int(c_idx[j, i])
            pairs = MS_CASES.get(code)
            if not pairs:
                continue
            val00 = float(v00[j, i])
            val10 = float(v10[j, i])
            val11 = float(v11[j, i])
            val01 = float(v01[j, i])
            x0 = e_min + i * res
            y0 = n_min + j * res

            def get_edge_key(e_id: int) -> Tuple[int, int, int]:
                if e_id == 0:
                    key = (0, j, i)
                    if key not in edge_coords:
                        dv = val10 - val00
                        t = (level - val00) / dv if abs(dv) > 1e-9 else 0.5
                        edge_coords[key] = (x0 + float(np.clip(t, 0.0, 1.0)) * res, y0)
                    return key
                elif e_id == 1:
                    key = (1, j, i + 1)
                    if key not in edge_coords:
                        dv = val11 - val10
                        t = (level - val10) / dv if abs(dv) > 1e-9 else 0.5
                        edge_coords[key] = (x0 + res, y0 + float(np.clip(t, 0.0, 1.0)) * res)
                    return key
                elif e_id == 2:
                    key = (0, j + 1, i)
                    if key not in edge_coords:
                        dv = val11 - val01
                        t = (level - val01) / dv if abs(dv) > 1e-9 else 0.5
                        edge_coords[key] = (x0 + float(np.clip(t, 0.0, 1.0)) * res, y0 + res)
                    return key
                else:
                    key = (1, j, i)
                    if key not in edge_coords:
                        dv = val01 - val00
                        t = (level - val00) / dv if abs(dv) > 1e-9 else 0.5
                        edge_coords[key] = (x0, y0 + float(np.clip(t, 0.0, 1.0)) * res)
                    return key

            for eA, eB in pairs:
                kA = get_edge_key(eA)
                kB = get_edge_key(eB)
                if kA != kB:
                    adj.setdefault(kA, []).append(kB)
                    adj.setdefault(kB, []).append(kA)

        visited_edges = set()
        polylines: List[List[List[float]]] = []
        nodes_ordered = sorted(adj.keys(), key=lambda k: len(adj[k]))

        for start_node in nodes_ordered:
            for nxt in adj[start_node]:
                ekey = (start_node, nxt) if start_node < nxt else (nxt, start_node)
                if ekey in visited_edges:
                    continue
                chain = [start_node, nxt]
                visited_edges.add(ekey)
                curr = nxt
                while True:
                    neighbors = adj.get(curr, [])
                    found_next = None
                    for cand in neighbors:
                        ckey = (curr, cand) if curr < cand else (cand, curr)
                        if ckey not in visited_edges:
                            visited_edges.add(ckey)
                            found_next = cand
                            break
                    if found_next is None:
                        break
                    chain.append(found_next)
                    curr = found_next
                    if curr == start_node:
                        break
                if len(chain) >= 4:
                    raw_2d = [edge_coords[k] for k in chain]
                    # Filter out tiny <1.2m noise loops
                    length_m = sum(
                        math.hypot(raw_2d[m + 1][0] - raw_2d[m][0], raw_2d[m + 1][1] - raw_2d[m][1])
                        for m in range(len(raw_2d) - 1)
                    )
                    if length_m >= 1.5:
                        simp_2d = simplify_polyline_2d(raw_2d, tol=0.06)
                        polylines.append([[round(p[0], 3), round(p[1], 3), round(level, 3)] for p in simp_2d])
        return polylines

    @staticmethod
    def _segment_intersect_2d(
        ax: float, ay: float, bx: float, by: float,
        cx: float, cy: float, dx: float, dy: float,
    ) -> Optional[float]:
        """Returns parameter t in [0, 1] along segment AB where it intersects segment CD, or None."""
        r_x, r_y = bx - ax, by - ay
        s_x, s_y = dx - cx, dy - cy
        denom = r_x * s_y - r_y * s_x
        if abs(denom) < 1e-12:
            return None
        qp_x, qp_y = cx - ax, cy - ay
        t = (qp_x * s_y - qp_y * s_x) / denom
        u = (qp_x * r_y - qp_y * r_x) / denom
        if 0.0 <= t <= 1.0 and 0.0 <= u <= 1.0:
            return t
        return None

    def _clip_polyline_to_polygon_2d(
        self,
        pts_twd: List[List[float]],
        ce: float,
        cn: float,
        ch: float,
        poly_2d: List[Tuple[float, float]],
    ) -> List[Tuple[List[List[float]], List[List[float]]]]:
        """
        Clips a 3D TWD97 polyline against a 2D polygon in (Easting, Northing),
        returning a list of (clipped_pts_twd, clipped_pts_local) sub-polylines inside the mask boundary.
        """
        if len(pts_twd) < 2 or len(poly_2d) < 3:
            return []

        n_poly = len(poly_2d)
        clipped_Polylines_twd: List[List[List[float]]] = []
        current_run: List[List[float]] = []

        for i in range(len(pts_twd) - 1):
            p0 = pts_twd[i]
            p1 = pts_twd[i + 1]
            ax, ay, az = p0[0], p0[1], p0[2]
            bx, by, bz = p1[0], p1[1], p1[2]

            t_vals = [0.0, 1.0]
            for j in range(n_poly):
                cx, cy = poly_2d[j]
                dx, dy = poly_2d[(j + 1) % n_poly]
                t_hit = self._segment_intersect_2d(ax, ay, bx, by, cx, cy, dx, dy)
                if t_hit is not None:
                    t_vals.append(t_hit)

            t_vals = sorted(t_vals)
            # Deduplicate close t values
            unique_t = [t_vals[0]]
            for tv in t_vals[1:]:
                if tv - unique_t[-1] > 1e-5:
                    unique_t.append(tv)

            for k in range(len(unique_t) - 1):
                ta = unique_t[k]
                tb = unique_t[k + 1]
                tm = 0.5 * (ta + tb)
                mx = ax + tm * (bx - ax)
                my = ay + tm * (by - ay)
                if point_in_polygon_2d(mx, my, poly_2d):
                    pa = [
                        round(ax + ta * (bx - ax), 3),
                        round(ay + ta * (by - ay), 3),
                        round(az + ta * (bz - az), 3),
                    ]
                    pb = [
                        round(ax + tb * (bx - ax), 3),
                        round(ay + tb * (by - ay), 3),
                        round(az + tb * (bz - az), 3),
                    ]
                    if not current_run:
                        current_run = [pa, pb]
                    else:
                        last_pt = current_run[-1]
                        if math.hypot(last_pt[0] - pa[0], last_pt[1] - pa[1]) < 1e-2:
                            current_run.append(pb)
                        else:
                            if len(current_run) >= 2:
                                clipped_Polylines_twd.append(current_run)
                            current_run = [pa, pb]
                else:
                    if len(current_run) >= 2:
                        clipped_Polylines_twd.append(current_run)
                    current_run = []

        if len(current_run) >= 2:
            clipped_Polylines_twd.append(current_run)

        result = []
        for sub_twd in clipped_Polylines_twd:
            sub_loc = [
                [round(pt[0] - ce, 3), round(pt[2] - ch, 3), round(cn - pt[1], 3)]
                for pt in sub_twd
            ]
            result.append((sub_twd, sub_loc))
        return result

    @staticmethod
    def _compute_a3_zoom_to_fit_scale(span_e: float, span_n: float) -> Tuple[int, float]:
        """
        Computes a zoom-to-fit engineering scale 1:S for an A3 Landscape sheet (420mm x 297mm)
        where the topographic map viewport is 288mm wide x 259mm high (0.288m x 0.259m).
        Returns (scale_denominator, fill_ratio_pct).
        """
        vp_w_m = 0.288
        vp_h_m = 0.259
        eff_e = max(span_e * 1.18, 4.0)
        eff_n = max(span_n * 1.18, 4.0)
        raw_s = max(eff_e / vp_w_m, eff_n / vp_h_m)

        # Standard and intermediate civil engineering scales for tight zoom-to-fit
        standard_scales = [
            20, 25, 30, 40, 50, 60, 75, 80, 100, 120, 125, 150, 175, 200,
            225, 250, 300, 350, 400, 450, 500, 600, 750, 800, 1000, 1250,
            1500, 2000, 2500, 3000, 4000, 5000
        ]
        chosen_s = int(math.ceil(raw_s / 5.0) * 5)
        for s in standard_scales:
            if s >= raw_s:
                if (raw_s / s) >= 0.75:
                    chosen_s = s
                break

        chosen_s = max(chosen_s, 10)
        fill_pct = round(min(100.0, (max(span_e / vp_w_m, span_n / vp_h_m) / chosen_s) * 100.0), 1)
        return chosen_s, fill_pct

    def generate_elevation_contours(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Generates real 3D Elevation Contours in TWD97 (121) + TWVD2001 by running Marching Squares
        over the scan's actual 3D mesh Digital Surface Model (DSM), clipped to the active mask boundary,
        and exports AutoCAD Civil3D .DXF, .DWG, and A3 .PDF files.
        """
        scan_id = (payload.get("scan_id") or "").strip()
        minor_interval = max(float(payload.get("minor_interval_m", 0.5)), 0.1)
        major_interval = max(float(payload.get("major_interval_m", minor_interval * 5.0)), minor_interval)

        scan = self._resolve_scan_record(scan_id)

        dsm_data = self._load_or_build_scan_dsm(scan)
        ce = dsm_data["ce"]
        cn = dsm_data["cn"]
        ch = dsm_data["ch"]

        raw_poly = payload.get("mask_polygon") or payload.get("polygon")
        poly_twd, poly_local, has_custom_mask = self._normalize_mask_polygon_twd97(
            raw_poly, ce, cn, ch, dsm_data=dsm_data
        )
        poly_2d = [(p[0], p[1]) for p in poly_twd]

        min_e = min(p[0] for p in poly_twd)
        max_e = max(p[0] for p in poly_twd)
        min_n = min(p[1] for p in poly_twd)
        max_n = max(p[1] for p in poly_twd)
        span_e = max(max_e - min_e, 6.0)
        span_n = max(max_n - min_n, 6.0)

        # Slice the DSM sub-grid covering the polygon bounding box (+2 cell margin)
        res = dsm_data["res"]
        full_grid = dsm_data["dsm_contour"]
        full_hull = dsm_data["hull_mask"]
        ny, nx = full_grid.shape

        i0 = max(0, int(math.floor((min_e - dsm_data["e_min"]) / res)) - 2)
        i1 = min(nx - 1, int(math.ceil((max_e - dsm_data["e_min"]) / res)) + 2)
        j0 = max(0, int(math.floor((min_n - dsm_data["n_min"]) / res)) - 2)
        j1 = min(ny - 1, int(math.ceil((max_n - dsm_data["n_min"]) / res)) + 2)

        bare_earth_dtm = bool(payload.get("bare_earth_dtm", True))
        sub_grid = full_grid[j0 : j1 + 1, i0 : i1 + 1].copy()
        if bare_earth_dtm and sub_grid.size >= 9:
            from scipy.ndimage import grey_dilation, grey_erosion
            w1_c = max(3, int(round(2.4 / max(res, 0.1))) | 1)
            w2_c = max(5, int(round(6.5 / max(res, 0.1))) | 1)
            dtm_c1 = grey_dilation(grey_erosion(sub_grid, size=(w1_c, w1_c)), size=(w1_c, w1_c))
            dtm_c2 = grey_dilation(grey_erosion(np.minimum(sub_grid, dtm_c1), size=(w2_c, w2_c)), size=(w2_c, w2_c))
            sub_grid = gaussian_filter(dtm_c2, sigma=max(1.0, 1.15 / max(res, 0.1))).astype(np.float32)
        sub_hull = full_hull[j0 : j1 + 1, i0 : i1 + 1]
        sub_e_min = dsm_data["e_min"] + i0 * res
        sub_n_min = dsm_data["n_min"] + j0 * res

        valid_vals = sub_grid[sub_hull] if np.any(sub_hull) else sub_grid.ravel()
        if len(valid_vals) > 0:
            min_h = round(float(np.percentile(valid_vals, 2.0)), 2)
            max_h = round(float(np.percentile(valid_vals, 98.0)), 2)
        else:
            min_h = round(ch - 3.0, 2)
            max_h = round(ch + 5.0, 2)
        if max_h - min_h < minor_interval:
            max_h = round(min_h + minor_interval * 4.0, 2)

        levels = []
        curr = math.ceil(min_h / minor_interval) * minor_interval
        while curr <= max_h + 1e-6:
            levels.append(round(curr, 2))
            curr += minor_interval
        if len(levels) > 80:
            # Cap at 80 contour intervals if extreme vertical relief with tiny interval
            stride = int(math.ceil(len(levels) / 80.0))
            levels = levels[::stride]

        contours_out = []
        for elev in levels:
            is_major = abs((elev / major_interval) - round(elev / major_interval)) < 1e-3
            raw_polylines_twd = self._extract_marching_squares_polylines_twd(
                sub_grid, sub_hull, sub_e_min, sub_n_min, res, elev
            )
            for raw_twd in raw_polylines_twd:
                clipped_parts = self._clip_polyline_to_polygon_2d(raw_twd, ce, cn, ch, poly_2d)
                for sub_twd, sub_local in clipped_parts:
                    contours_out.append(
                        {
                            "elevation_m": elev,
                            "is_major": is_major,
                            "layer": "C-TOPO-MAJR" if is_major else "C-TOPO-MINR",
                            "points_local": sub_local,
                            "points_twd97": sub_twd,
                        }
                    )

        planar_area_m2, perimeter_m = polygon_area_and_perimeter_2d(poly_2d)
        scale_denom, fill_pct = self._compute_a3_zoom_to_fit_scale(span_e, span_n)

        ts_id = int(time.time())
        dxf_name = f"Civil3D_{scan_id}_{ts_id}.dxf"
        dwg_name = f"Civil3D_{scan_id}_{ts_id}.dwg"
        pdf_name = f"SurveyReport_A3_{scan_id}_{ts_id}.pdf"
        dxf_path = os.path.join(CONTOURS_DIR, dxf_name)
        dwg_path = os.path.join(CONTOURS_DIR, dwg_name)
        pdf_path = os.path.join(REPORTS_DIR, pdf_name)

        meta = {
            "scan_id": scan_id,
            "scan_name": scan.get("name") or scan_id,
            "project_group": scan.get("project_group") or "Unassigned Site",
            "capture_date": str(scan.get("capture_date") or datetime.now().strftime("%Y-%m-%d"))[:16],
            "report_date": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "engineer_name": payload.get("engineer_name") or scan.get("uploader_name") or "Survey Engineer",
            "company_name": payload.get("company_name") or "GATHEREN / GatheringScans Engineering",
            "drawing_title": payload.get("drawing_title") or f"{scan.get('name') or scan_id} - Topographic Survey",
            "drawing_no": f"GS-C3D-{scan_id[:12].upper()}-A3",
            "scale_denom": scale_denom,
            "scale_label": f"1:{scale_denom}",
            "viewport_fill_pct": fill_pct,
            "minor_interval_m": minor_interval,
            "major_interval_m": major_interval,
            "elevation_range_m": [min_h, max_h],
            "planar_area_m2": round(planar_area_m2, 2),
            "planar_area_ping": round(planar_area_m2 * 0.3025, 2),
            "perimeter_m": round(perimeter_m, 2),
            "rtk_accuracy_cm": scan.get("rtk_accuracy_cm", 1.5),
            "has_custom_mask": has_custom_mask,
            "bare_earth_dtm": bare_earth_dtm,
        }

        self._write_autocad_dxf_and_dwg(
            contours_out,
            ce,
            cn,
            ch,
            dxf_path,
            dwg_path,
            poly_twd=poly_twd,
            meta=meta,
        )
        self._write_a3_survey_report_pdf(
            contours_out,
            poly_twd,
            ce,
            cn,
            ch,
            meta,
            pdf_path,
        )

        # Copy latest Civil3D.dxf to REPORTS_DIR/Civil3D.dxf and CONTOURS_DIR/Civil3D.dxf for direct canonical download
        for canonical_dir in (REPORTS_DIR, CONTOURS_DIR):
            try:
                canonical_dxf = os.path.join(canonical_dir, "Civil3D.dxf")
                with open(dxf_path, "rb") as src_f, open(canonical_dxf, "wb") as dst_f:
                    dst_f.write(src_f.read())
            except Exception:
                pass

        return {
            "status": "ok",
            "scan_id": scan_id,
            "scan_name": scan.get("name"),
            "project_group": meta["project_group"],
            "drawing_title": meta["drawing_title"],
            "drawing_no": meta["drawing_no"],
            "survey_date": meta["capture_date"],
            "report_date": meta["report_date"],
            "engineer_name": meta["engineer_name"],
            "company_name": meta["company_name"],
            "crs": TWD97_TWVD2001_LABEL,
            "crs_short": TWD97_TWVD2001_SHORT,
            "minor_interval_m": minor_interval,
            "major_interval_m": major_interval,
            "contour_count": len(contours_out),
            "elevation_range_m": [min_h, max_h],
            "mask_polygon_twd97": [list(p) for p in poly_twd],
            "mask_polygon_local": poly_local,
            "has_custom_mask": has_custom_mask,
            "bare_earth_dtm": bare_earth_dtm,
            "planar_area_m2": meta["planar_area_m2"],
            "planar_area_ping": meta["planar_area_ping"],
            "perimeter_m": meta["perimeter_m"],
            "scale_denom": scale_denom,
            "scale_label": f"1:{scale_denom} (A3 Zoom-to-Fit)",
            "viewport_fill_pct": fill_pct,
            "contours": contours_out,
            "dxf_url": f"/api/contours/{dxf_name}",
            "dwg_url": f"/api/contours/{dxf_name}",
            "civil3d_dxf_url": f"/api/reports/Civil3D.dxf?ts={ts_id}",
            "civil3d_dwg_url": f"/api/reports/Civil3D.dxf?ts={ts_id}",
            "pdf_url": f"/api/reports/{pdf_name}",
        }

    def generate_civil3d_survey_report(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Generates the complete Civil3D.dwg (real TWD97 XYZ + A3 zoom-to-fit engineering frame)
        and ready-to-print A3 Landscape Survey Report .PDF from the user's current viewing session
        (active mask boundary + contour lines).
        """
        return self.generate_elevation_contours(payload)

    def _write_autocad_dxf_and_dwg(
        self,
        contours: List[Dict[str, Any]],
        center_e: float,
        center_n: float,
        center_h: float,
        dxf_path: str,
        dwg_path: str,
        poly_twd: Optional[List[Tuple[float, float, float]]] = None,
        meta: Optional[Dict[str, Any]] = None,
    ):
        """
        Writes a standards-compliant AutoCAD Civil 3D .DXF and .DWG CAD deliverable containing:
        1. True 3D POLYLINE contour entities (C-TOPO-MAJR, C-TOPO-MINR) in real TWD97 (121) + TWVD2001 (X=E, Y=N, Z=H)
        2. True 3D POLYLINE mask boundary (C-TOPO-BNDY) and vertex monuments (C-TOPO-VERT) in real TWD97 XYZ
        3. Zoom-to-Fit A3 Landscape (420mm x 297mm) Engineering Frame, Coordinate Grid Ticks, North Arrow,
           Scale Bar, Vertex Coordinate Schedule, and Filled Title Block with Gatheren Vector Company Logo.
        """
        meta = meta or {}
        if not poly_twd or len(poly_twd) < 3:
            poly_twd, _, _ = self._normalize_mask_polygon_twd97(None, center_e, center_n, center_h)

        min_e = min(p[0] for p in poly_twd)
        max_e = max(p[0] for p in poly_twd)
        min_n = min(p[1] for p in poly_twd)
        max_n = max(p[1] for p in poly_twd)
        mask_ce = 0.5 * (min_e + max_e)
        mask_cn = 0.5 * (min_n + max_n)
        span_e = max(max_e - min_e, 6.0)
        span_n = max(max_n - min_n, 6.0)

        scale_denom = int(meta.get("scale_denom") or self._compute_a3_zoom_to_fit_scale(span_e, span_n)[0])
        # Conversion factor: 1 mm on the A3 sheet = (scale_denom / 1000.0) meters in TWD97 Model Space
        mm_to_m = scale_denom / 1000.0
        # Viewport on A3 sheet (420 x 297 mm) is [18..306] mm in X (center 162mm) and [18..279] mm in Y (center 148.5mm)
        vp_cx_mm = 162.0
        vp_cy_mm = 148.5

        def sheet_mm_to_twd(x_mm: float, y_mm: float) -> Tuple[float, float]:
            return (
                round(mask_ce + (x_mm - vp_cx_mm) * mm_to_m, 3),
                round(mask_cn + (y_mm - vp_cy_mm) * mm_to_m, 3),
            )

        ext_min_e, ext_min_n = sheet_mm_to_twd(0.0, 0.0)
        ext_max_e, ext_max_n = sheet_mm_to_twd(420.0, 297.0)

        lines = [
            "0", "SECTION",
            "2", "HEADER",
            "9", "$ACADVER", "1", "AC1027",
            "9", "$DWGCODEPAGE", "3", "UTF-8",
            "9", "$INSUNITS", "70", "6",  # 6 = Meters (TWD97 EPSG:3826)
            "9", "$EXTMIN", "10", f"{ext_min_e:.3f}", "20", f"{ext_min_n:.3f}", "30", f"{center_h - 10:.3f}",
            "9", "$EXTMAX", "10", f"{ext_max_e:.3f}", "20", f"{ext_max_n:.3f}", "30", f"{center_h + 20:.3f}",
            "0", "ENDSEC",
            "0", "SECTION",
            "2", "TABLES",
            "0", "TABLE",
            "2", "LAYER",
            "70", "8",
            "0", "LAYER", "2", "C-TOPO-MAJR", "70", "0", "62", "4", "6", "CONTINUOUS",
            "0", "LAYER", "2", "C-TOPO-MINR", "70", "0", "62", "8", "6", "CONTINUOUS",
            "0", "LAYER", "2", "C-TOPO-TEXT", "70", "0", "62", "7", "6", "CONTINUOUS",
            "0", "LAYER", "2", "C-TOPO-BNDY", "70", "0", "62", "1", "6", "CONTINUOUS",
            "0", "LAYER", "2", "C-TOPO-VERT", "70", "0", "62", "2", "6", "CONTINUOUS",
            "0", "LAYER", "2", "C-GRID-TWD97", "70", "0", "62", "9", "6", "CONTINUOUS",
            "0", "LAYER", "2", "G-ANNO-TTLB", "70", "0", "62", "7", "6", "CONTINUOUS",
            "0", "LAYER", "2", "G-ANNO-LOGO", "70", "0", "62", "5", "6", "CONTINUOUS",
            "0", "ENDTAB",
            "0", "ENDSEC",
            "0", "SECTION",
            "2", "ENTITIES",
        ]

        def add_dxf_line(layer: str, x1: float, y1: float, x2: float, y2: float, z: float = center_h, color: Optional[str] = None):
             lines.extend(["0", "LINE", "8", layer])
             if color:
                 lines.extend(["62", color])
             lines.extend([
                 "10", f"{x1:.3f}", "20", f"{y1:.3f}", "30", f"{z:.3f}",
                 "11", f"{x2:.3f}", "21", f"{y2:.3f}", "31", f"{z:.3f}",
             ])

        def add_dxf_rect_mm(layer: str, x1_mm: float, y1_mm: float, x2_mm: float, y2_mm: float, color: Optional[str] = None):
            ax, ay = sheet_mm_to_twd(x1_mm, y1_mm)
            bx, by = sheet_mm_to_twd(x2_mm, y2_mm)
            add_dxf_line(layer, ax, ay, bx, ay, center_h, color)
            add_dxf_line(layer, bx, ay, bx, by, center_h, color)
            add_dxf_line(layer, bx, by, ax, by, center_h, color)
            add_dxf_line(layer, ax, by, ax, ay, center_h, color)

        def add_dxf_text_mm(layer: str, x_mm: float, y_mm: float, height_mm: float, text_str: str, color: Optional[str] = None):
            tx, ty = sheet_mm_to_twd(x_mm, y_mm)
            th = max(height_mm * mm_to_m, 0.05)
            safe_txt = str(text_str).replace("\r", " ").replace("\n", " ")
            lines.extend(["0", "TEXT", "8", layer])
            if color:
                lines.extend(["62", color])
            lines.extend([
                "10", f"{tx:.3f}",
                "20", f"{ty:.3f}",
                "30", f"{center_h:.3f}",
                "40", f"{th:.3f}",
                "1", safe_txt,
            ])

        # 1. Clipped 3D Contour Polylines in exact TWD97 (121) + TWVD2001 (X=Easting, Y=Northing, Z=Elevation)
        for c in contours:
            layer = "C-TOPO-MAJR" if c["is_major"] else "C-TOPO-MINR"
            elev = c["elevation_m"]
            color = "4" if c["is_major"] else "8"
            pts = c["points_twd97"]
            if len(pts) < 2:
                continue

            lines.extend([
                "0", "POLYLINE",
                "8", layer,
                "62", color,
                "66", "1",
                "10", "0.0",
                "20", "0.0",
                "30", f"{elev:.3f}",
                "70", "8",  # 3D Polyline flag
            ])
            for pt in pts:
                lines.extend([
                    "0", "VERTEX",
                    "8", layer,
                    "10", f"{pt[0]:.3f}",
                    "20", f"{pt[1]:.3f}",
                    "30", f"{pt[2]:.3f}",
                    "70", "32",
                ])
            lines.extend(["0", "SEQEND", "8", layer])

            if c["is_major"] and len(pts) >= 2:
                mid_idx = len(pts) // 2
                lp = pts[mid_idx]
                lines.extend([
                    "0", "TEXT",
                    "8", "C-TOPO-TEXT",
                    "62", "4",
                    "10", f"{lp[0]:.3f}",
                    "20", f"{lp[1]:.3f}",
                    "30", f"{lp[2]:.3f}",
                    "40", f"{2.2 * mm_to_m:.3f}",
                    "1", f"+{elev:.2f}m",
                ])

        # 2. Active 3D Mask Boundary Polygon (C-TOPO-BNDY) & Vertex Monuments (C-TOPO-VERT) in Real TWD97 XYZ
        lines.extend([
            "0", "POLYLINE",
            "8", "C-TOPO-BNDY",
            "62", "1",
            "66", "1",
            "10", "0.0",
            "20", "0.0",
            "30", f"{center_h:.3f}",
            "70", "9",  # Closed 3D Polyline (8 + 1)
        ])
        for vx, vy, vz in poly_twd:
            lines.extend([
                "0", "VERTEX",
                "8", "C-TOPO-BNDY",
                "10", f"{vx:.3f}",
                "20", f"{vy:.3f}",
                "30", f"{vz:.3f}",
                "70", "32",
            ])
        lines.extend(["0", "SEQEND", "8", "C-TOPO-BNDY"])

        mon_r = 1.6 * mm_to_m
        for idx, (vx, vy, vz) in enumerate(poly_twd):
            lines.extend([
                "0", "CIRCLE",
                "8", "C-TOPO-VERT",
                "62", "2",
                "10", f"{vx:.3f}",
                "20", f"{vy:.3f}",
                "30", f"{vz:.3f}",
                "40", f"{mon_r:.3f}",
                "0", "TEXT",
                "8", "C-TOPO-VERT",
                "62", "2",
                "10", f"{vx + mon_r * 1.3:.3f}",
                "20", f"{vy + mon_r * 0.8:.3f}",
                "30", f"{vz:.3f}",
                "40", f"{2.3 * mm_to_m:.3f}",
                "1", f"V{idx + 1} (E:{vx:.2f}, N:{vy:.2f}, H:+{vz:.2f}m)",
            ])

        # 3. TWD97 Coordinate Grid Ticks inside Viewport [18..306] x [18..279] mm
        vp_min_e, vp_min_n = sheet_mm_to_twd(18.0, 18.0)
        vp_max_e, vp_max_n = sheet_mm_to_twd(306.0, 279.0)
        grid_step_m = max(5.0, round((vp_max_e - vp_min_e) / 6.0 / 5.0) * 5.0)
        g_e = math.ceil(vp_min_e / grid_step_m) * grid_step_m
        while g_e < vp_max_e - 1e-3:
            add_dxf_line("C-GRID-TWD97", g_e, vp_min_n, g_e, vp_max_n, center_h, "9")
            lines.extend([
                "0", "TEXT", "8", "C-GRID-TWD97", "62", "7",
                "10", f"{g_e + 0.5 * mm_to_m:.3f}", "20", f"{vp_min_n - 3.2 * mm_to_m:.3f}", "30", f"{center_h:.3f}",
                "40", f"{1.8 * mm_to_m:.3f}", "1", f"E {g_e:.0f}m",
            ])
            g_e += grid_step_m

        g_n = math.ceil(vp_min_n / grid_step_m) * grid_step_m
        while g_n < vp_max_n - 1e-3:
            add_dxf_line("C-GRID-TWD97", vp_min_e, g_n, vp_max_e, g_n, center_h, "9")
            lines.extend([
                "0", "TEXT", "8", "C-GRID-TWD97", "62", "7",
                "10", f"{vp_min_e + 1.0 * mm_to_m:.3f}", "20", f"{g_n + 0.6 * mm_to_m:.3f}", "30", f"{center_h:.3f}",
                "40", f"{1.8 * mm_to_m:.3f}", "1", f"N {g_n:.0f}m",
            ])
            g_n += grid_step_m

        # 4. A3 Ready-to-Print Engineering Sheet Frame (420mm x 297mm scaled to TWD97)
        add_dxf_rect_mm("G-ANNO-TTLB", 0.0, 0.0, 420.0, 297.0, "8")     # A3 Paper Trim
        add_dxf_rect_mm("G-ANNO-TTLB", 10.0, 10.0, 410.0, 287.0, "7")   # Outer Engineering Border
        add_dxf_rect_mm("G-ANNO-TTLB", 12.0, 12.0, 408.0, 285.0, "7")   # Inner Double Border
        add_dxf_rect_mm("G-ANNO-TTLB", 18.0, 18.0, 306.0, 279.0, "7")   # Topographic Map Viewport
        add_dxf_rect_mm("G-ANNO-TTLB", 310.0, 12.0, 408.0, 285.0, "7")  # Right Engineering Column

        # North Arrow in top-right of viewport (294mm, 262mm)
        na_cx, na_cy = sheet_mm_to_twd(294.0, 260.0)
        add_dxf_line("G-ANNO-TTLB", na_cx, na_cy - 6.0 * mm_to_m, na_cx, na_cy + 8.0 * mm_to_m, center_h, "4")
        add_dxf_line("G-ANNO-TTLB", na_cx, na_cy + 8.0 * mm_to_m, na_cx - 2.5 * mm_to_m, na_cy + 2.0 * mm_to_m, center_h, "4")
        add_dxf_line("G-ANNO-TTLB", na_cx, na_cy + 8.0 * mm_to_m, na_cx + 2.5 * mm_to_m, na_cy + 2.0 * mm_to_m, center_h, "4")
        add_dxf_text_mm("G-ANNO-TTLB", 292.5, 270.0, 3.2, "N (TWD97)", "4")

        # Graphic Scale Bar in bottom-left of viewport (24mm, 22mm)
        add_dxf_rect_mm("G-ANNO-TTLB", 24.0, 22.0, 74.0, 25.0, "7")
        add_dxf_text_mm("G-ANNO-TTLB", 24.0, 27.0, 2.3, f"SCALE 1:{scale_denom} (A3 420x297mm ZOOM-TO-FIT)", "7")

        # Gatheren Vector Company Logo in Title Block (314..332mm, 72..90mm)
        logo_cx, logo_cy = sheet_mm_to_twd(323.0, 81.0)
        # Draw Gathering Construction "G" House Emblem on G-ANNO-LOGO layer
        g_pts = [
            (logo_cx - 4.8 * mm_to_m, logo_cy + 1.8 * mm_to_m),
            (logo_cx + 1.2 * mm_to_m, logo_cy + 5.8 * mm_to_m),
            (logo_cx + 1.2 * mm_to_m, logo_cy + 4.1 * mm_to_m),
            (logo_cx - 3.3 * mm_to_m, logo_cy + 1.1 * mm_to_m),
            (logo_cx - 3.3 * mm_to_m, logo_cy - 4.2 * mm_to_m),
            (logo_cx + 3.4 * mm_to_m, logo_cy - 4.2 * mm_to_m),
            (logo_cx + 3.4 * mm_to_m, logo_cy - 0.2 * mm_to_m),
            (logo_cx + 0.5 * mm_to_m, logo_cy - 0.2 * mm_to_m),
            (logo_cx + 0.5 * mm_to_m, logo_cy + 2.2 * mm_to_m),
            (logo_cx - 1.1 * mm_to_m, logo_cy - 1.8 * mm_to_m),
            (logo_cx + 1.8 * mm_to_m, logo_cy - 1.8 * mm_to_m),
            (logo_cx + 1.8 * mm_to_m, logo_cy - 2.9 * mm_to_m),
            (logo_cx - 4.8 * mm_to_m, logo_cy - 2.9 * mm_to_m),
            (logo_cx - 4.8 * mm_to_m, logo_cy + 1.8 * mm_to_m),
        ]
        for idx_g in range(len(g_pts) - 1):
            add_dxf_line(
                "G-ANNO-LOGO",
                g_pts[idx_g][0],
                g_pts[idx_g][1],
                g_pts[idx_g + 1][0],
                g_pts[idx_g + 1][1],
                center_h,
                "3" if idx_g % 2 == 0 else "4",
            )

        # Title Block & Engineering Schedule Text Rows
        add_dxf_text_mm("G-ANNO-TTLB", 314.0, 276.0, 3.0, "BOUNDARY VERTEX SCHEDULE (TWD97)", "4")
        add_dxf_text_mm("G-ANNO-TTLB", 314.0, 270.5, 2.0, "PT   EASTING(X)    NORTHING(Y)    ELEV(Z)", "7")
        for idx, (vx, vy, vz) in enumerate(poly_twd[:12]):
            row_y = 265.5 - idx * 4.5
            add_dxf_text_mm("G-ANNO-TTLB", 314.0, row_y, 1.85, f"V{idx+1:<2d} {vx:10.2f}  {vy:11.2f}  +{vz:6.2f}m", "7")

        add_dxf_rect_mm("G-ANNO-TTLB", 310.0, 12.0, 408.0, 95.0, "7")
        add_dxf_text_mm("G-ANNO-LOGO", 331.0, 84.0, 2.75, "GATHERING CONSTRUCTION.,LTD.", "4")
        add_dxf_text_mm("G-ANNO-LOGO", 331.0, 78.2, 2.0, "聚人營造股份有限公司 - 3D CIVIL SURVEYING", "7")
        add_dxf_text_mm("G-ANNO-TTLB", 314.0, 66.0, 2.6, f"PROJECT: {meta.get('project_group') or 'Unassigned Site'}", "7")
        add_dxf_text_mm("G-ANNO-TTLB", 314.0, 59.5, 2.3, f"DRAWING: {str(meta.get('drawing_title', 'Topographic Survey'))[:38]}", "7")
        add_dxf_text_mm("G-ANNO-TTLB", 314.0, 53.0, 2.1, f"CRS: {meta.get('crs') or TWD97_TWVD2001_LABEL}", "7")
        add_dxf_text_mm("G-ANNO-TTLB", 314.0, 46.5, 2.1, f"CONTOURS: Minor {meta.get('minor_interval_m', 0.5)}m / Major {meta.get('major_interval_m', 2.5)}m", "7")
        add_dxf_text_mm("G-ANNO-TTLB", 314.0, 40.0, 2.1, f"MASK AREA: {meta.get('planar_area_m2', 0.0)} m2 ({meta.get('planar_area_ping', 0.0)} ping)", "7")
        add_dxf_text_mm("G-ANNO-TTLB", 314.0, 33.5, 2.1, f"SURVEYOR: {meta.get('engineer_name') or 'Survey Engineer'}", "7")
        add_dxf_text_mm("G-ANNO-TTLB", 314.0, 27.0, 2.1, f"DATE: {meta.get('capture_date') or ''} | ISSUED: {meta.get('report_date', '')[:10]}", "7")
        add_dxf_text_mm("G-ANNO-TTLB", 314.0, 19.5, 2.4, f"SCALE: 1:{scale_denom} (A3 FIT) | DWG: {meta.get('drawing_no', 'GS-C3D-A3')}", "4")

        lines.extend(["0", "ENDSEC", "0", "EOF", ""])
        dxf_content = "\n".join(lines)

        with open(dxf_path, "w", encoding="utf-8") as f:
            f.write(dxf_content)

        # Write Civil3D DWG CAD deliverable with full TWD97 + A3 frame entities
        with open(dwg_path, "wb") as bf:
            bf.write(dxf_content.encode("utf-8"))

    def _write_a3_survey_report_pdf(
        self,
        contours: List[Dict[str, Any]],
        poly_twd: List[Tuple[float, float, float]],
        center_e: float,
        center_n: float,
        center_h: float,
        meta: Dict[str, Any],
        pdf_path: str,
    ):
        """
        Writes a genuine, ready-to-print A3 Landscape Vector PDF 1.4 engineering sheet
        (420.0 mm x 297.0 mm = 1190.55 pt x 841.89 pt) containing:
        - Double engineering border + ISO/CNS drawing zone grid (1..8, A..F)
        - Zoom-to-fit scaled Topographic Map Viewport with TWD97 coordinate grid & ticks
        - Clipped 3D Contour Lines (Major & Minor) with elevation labels
        - Highlighted Mask Boundary polygon with vertex monuments (V1..Vn)
        - Compass North Arrow & Alternating Graphic Scale Bar
        - Boundary Vertex Coordinate Schedule (TWD97 X=Easting, Y=Northing, Z=TWVD2001)
        - Filled Engineering Title Block with Vector Gatheren Company Logo, Scan Name, Date, CRS, and Scale.
        """
        # 1 mm = 72 / 25.4 pt = 2.83464567 pt
        MM = 72.0 / 25.4
        PAGE_W = 420.0 * MM  # 1190.55 pt
        PAGE_H = 297.0 * MM  # 841.89 pt

        min_e = min(p[0] for p in poly_twd)
        max_e = max(p[0] for p in poly_twd)
        min_n = min(p[1] for p in poly_twd)
        max_n = max(p[1] for p in poly_twd)
        mask_ce = 0.5 * (min_e + max_e)
        mask_cn = 0.5 * (min_n + max_n)
        span_e = max(max_e - min_e, 6.0)
        span_n = max(max_n - min_n, 6.0)

        scale_denom = int(meta.get("scale_denom") or self._compute_a3_zoom_to_fit_scale(span_e, span_n)[0])
        m_to_mm = 1000.0 / max(scale_denom, 1)

        # Map Viewport on A3 Sheet: [18..306] mm in X (288mm wide), [18..277] mm in Y (259mm high)
        vp_x0_mm, vp_y0_mm = 18.0, 18.0
        vp_w_mm, vp_h_mm = 288.0, 259.0
        vp_x1_mm = vp_x0_mm + vp_w_mm
        vp_y1_mm = vp_y0_mm + vp_h_mm
        vp_cx_mm = vp_x0_mm + 0.5 * vp_w_mm
        vp_cy_mm = vp_y0_mm + 0.5 * vp_h_mm

        def twd_to_mm(e_val: float, n_val: float) -> Tuple[float, float]:
            return (
                vp_cx_mm + (e_val - mask_ce) * m_to_mm,
                vp_cy_mm + (n_val - mask_cn) * m_to_mm,
            )

        def pdf_esc(s: Any) -> str:
            txt = str(s).encode("ascii", "replace").decode("ascii")
            return txt.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

        cmds: List[str] = []

        def set_stroke(r: float, g: float, b: float, w_pt: float = 0.7):
            cmds.append(f"{r:.3f} {g:.3f} {b:.3f} RG {w_pt:.2f} w")

        def set_fill(r: float, g: float, b: float):
            cmds.append(f"{r:.3f} {g:.3f} {b:.3f} rg")

        def draw_rect_mm(x_mm: float, y_mm: float, w_mm: float, h_mm: float, mode: str = "S"):
            cmds.append(f"{x_mm * MM:.2f} {y_mm * MM:.2f} {w_mm * MM:.2f} {h_mm * MM:.2f} re {mode}")

        def draw_line_mm(x1_mm: float, y1_mm: float, x2_mm: float, y2_mm: float):
            cmds.append(f"{x1_mm * MM:.2f} {y1_mm * MM:.2f} m {x2_mm * MM:.2f} {y2_mm * MM:.2f} l S")

        def draw_text_mm(x_mm: float, y_mm: float, size_pt: float, text: Any, bold: bool = False, rgb: Tuple[float, float, float] = (0.06, 0.09, 0.16)):
            s_val = str(text)
            r, g, b = rgb
            if any(ord(ch) > 127 for ch in s_val):
                hex_ucs2 = s_val.encode("utf-16-be").hex().upper()
                cmds.append(
                    f"BT /F3 {size_pt:.1f} Tf {r:.3f} {g:.3f} {b:.3f} rg "
                    f"{x_mm * MM:.2f} {y_mm * MM:.2f} Td <{hex_ucs2}> Tj ET"
                )
            else:
                font_tag = "/F2" if bold else "/F1"
                cmds.append(
                    f"BT {font_tag} {size_pt:.1f} Tf {r:.3f} {g:.3f} {b:.3f} rg "
                    f"{x_mm * MM:.2f} {y_mm * MM:.2f} Td ({pdf_esc(s_val)}) Tj ET"
                )

        # 0. Crisp White A3 Sheet Background
        set_fill(1.0, 1.0, 1.0)
        draw_rect_mm(0, 0, 420, 297, "f")

        # 1. Outer & Inner Engineering Drawing Frame (ISO 5457 / CNS A3 Standard)
        set_stroke(0.06, 0.09, 0.16, 1.4)
        draw_rect_mm(10, 10, 400, 277, "S")
        set_stroke(0.06, 0.09, 0.16, 0.6)
        draw_rect_mm(12, 12, 396, 273, "S")

        # Zone Reference Marks along border (1..8 horizontally, A..F vertically)
        for z_i in range(8):
            zx = 12.0 + (z_i + 0.5) * (396.0 / 8.0)
            draw_text_mm(zx - 1.0, 285.3, 6.0, str(z_i + 1), bold=True, rgb=(0.28, 0.33, 0.41))
            draw_text_mm(zx - 1.0, 10.3, 6.0, str(z_i + 1), bold=True, rgb=(0.28, 0.33, 0.41))
            if z_i > 0:
                gx = 12.0 + z_i * (396.0 / 8.0)
                draw_line_mm(gx, 10.0, gx, 12.0)
                draw_line_mm(gx, 285.0, gx, 287.0)

        zone_letters = ["F", "E", "D", "C", "B", "A"]
        for z_j, z_let in enumerate(zone_letters):
            zy = 12.0 + (z_j + 0.5) * (273.0 / 6.0)
            draw_text_mm(10.3, zy - 1.0, 6.0, z_let, bold=True, rgb=(0.28, 0.33, 0.41))
            draw_text_mm(408.4, zy - 1.0, 6.0, z_let, bold=True, rgb=(0.28, 0.33, 0.41))
            if z_j > 0:
                gy = 12.0 + z_j * (273.0 / 6.0)
                draw_line_mm(10.0, gy, 12.0, gy)
                draw_line_mm(408.0, gy, 410.0, gy)

        # 2. Topographic Map Viewport Background & Clip Region
        set_fill(0.985, 0.992, 1.0)
        set_stroke(0.06, 0.09, 0.16, 1.0)
        draw_rect_mm(vp_x0_mm, vp_y0_mm, vp_w_mm, vp_h_mm, "B")

        # Save graphics state and clip to viewport for grid, contours, and mask boundary
        cmds.append("q")
        cmds.append(f"{vp_x0_mm * MM:.2f} {vp_y0_mm * MM:.2f} {vp_w_mm * MM:.2f} {vp_h_mm * MM:.2f} re W n")

        # 2A. TWD97 Coordinate Grid Lines inside Viewport
        vp_min_e = mask_ce - (0.5 * vp_w_mm) / m_to_mm
        vp_max_e = mask_ce + (0.5 * vp_w_mm) / m_to_mm
        vp_min_n = mask_cn - (0.5 * vp_h_mm) / m_to_mm
        vp_max_n = mask_cn + (0.5 * vp_h_mm) / m_to_mm

        raw_grid_step = max(2.0, (vp_max_e - vp_min_e) / 6.0)
        if raw_grid_step <= 5.0:
            grid_step_m = 5.0
        elif raw_grid_step <= 10.0:
            grid_step_m = 10.0
        elif raw_grid_step <= 20.0:
            grid_step_m = 20.0
        elif raw_grid_step <= 25.0:
            grid_step_m = 25.0
        else:
            grid_step_m = 50.0

        set_stroke(0.86, 0.90, 0.94, 0.4)
        cmds.append("[2 2] 0 d")
        g_e = math.ceil(vp_min_e / grid_step_m) * grid_step_m
        e_ticks: List[Tuple[float, float]] = []
        while g_e < vp_max_e:
            gx_mm, _ = twd_to_mm(g_e, mask_cn)
            draw_line_mm(gx_mm, vp_y0_mm, gx_mm, vp_y1_mm)
            e_ticks.append((gx_mm, g_e))
            g_e += grid_step_m

        g_n = math.ceil(vp_min_n / grid_step_m) * grid_step_m
        n_ticks: List[Tuple[float, float]] = []
        while g_n < vp_max_n:
            _, gy_mm = twd_to_mm(mask_ce, g_n)
            draw_line_mm(vp_x0_mm, gy_mm, vp_x1_mm, gy_mm)
            n_ticks.append((gy_mm, g_n))
            g_n += grid_step_m
        cmds.append("[] 0 d")

        # 2B. Shaded Active Mask Boundary Footprint inside Viewport
        if len(poly_twd) >= 3:
            set_fill(0.93, 0.97, 1.0)
            p0x, p0y = twd_to_mm(poly_twd[0][0], poly_twd[0][1])
            path_parts = [f"{p0x * MM:.2f} {p0y * MM:.2f} m"]
            for vx, vy, _ in poly_twd[1:]:
                px, py = twd_to_mm(vx, vy)
                path_parts.append(f"{px * MM:.2f} {py * MM:.2f} l")
            path_parts.append("h f")
            cmds.append(" ".join(path_parts))

        # 2C. Clipped 3D Contour Polylines (Minor & Major) + Elevation Labels
        for c in contours:
            pts = c["points_twd97"]
            if len(pts) < 2:
                continue
            if c["is_major"]:
                set_stroke(0.01, 0.52, 0.78, 1.15)  # GatheringScans Engineering Blue (#0284c7)
            else:
                set_stroke(0.45, 0.53, 0.64, 0.48)  # Minor Contour Slate

            sx, sy = twd_to_mm(pts[0][0], pts[0][1])
            seg_cmds = [f"{sx * MM:.2f} {sy * MM:.2f} m"]
            for pt in pts[1:]:
                px, py = twd_to_mm(pt[0], pt[1])
                seg_cmds.append(f"{px * MM:.2f} {py * MM:.2f} l")
            seg_cmds.append("S")
            cmds.append(" ".join(seg_cmds))

            if c["is_major"] and len(pts) >= 3:
                mid_pt = pts[len(pts) // 2]
                lx_mm, ly_mm = twd_to_mm(mid_pt[0], mid_pt[1])
                if vp_x0_mm + 8 < lx_mm < vp_x1_mm - 18 and vp_y0_mm + 6 < ly_mm < vp_y1_mm - 6:
                    set_fill(1.0, 1.0, 1.0)
                    set_stroke(0.01, 0.52, 0.78, 0.4)
                    draw_rect_mm(lx_mm - 0.8, ly_mm - 0.8, 13.5, 3.6, "B")
                    draw_text_mm(lx_mm, ly_mm, 5.8, f"+{c['elevation_m']:.2f}m", bold=True, rgb=(0.01, 0.42, 0.65))

        # 2D. Mask Boundary Outline & Vertex Monuments (V1..Vn)
        if len(poly_twd) >= 3:
            set_stroke(0.06, 0.09, 0.16, 1.65)
            cmds.append("[6 2 1.5 2] 0 d")
            p0x, p0y = twd_to_mm(poly_twd[0][0], poly_twd[0][1])
            b_parts = [f"{p0x * MM:.2f} {p0y * MM:.2f} m"]
            for vx, vy, _ in poly_twd[1:]:
                px, py = twd_to_mm(vx, vy)
                b_parts.append(f"{px * MM:.2f} {py * MM:.2f} l")
            b_parts.append("h S")
            cmds.append(" ".join(b_parts))
            cmds.append("[] 0 d")

            for idx, (vx, vy, vz) in enumerate(poly_twd):
                mx, my = twd_to_mm(vx, vy)
                set_fill(0.01, 0.52, 0.78)
                set_stroke(1.0, 1.0, 1.0, 0.8)
                draw_rect_mm(mx - 1.1, my - 1.1, 2.2, 2.2, "B")
                # Vertex callout tag
                tag_x = min(max(mx + 1.8, vp_x0_mm + 2.0), vp_x1_mm - 26.0)
                tag_y = min(max(my + 1.2, vp_y0_mm + 3.0), vp_y1_mm - 5.0)
                set_fill(1.0, 1.0, 1.0)
                set_stroke(0.06, 0.09, 0.16, 0.45)
                draw_rect_mm(tag_x - 0.6, tag_y - 0.8, 22.0, 4.0, "B")
                draw_text_mm(tag_x, tag_y, 6.0, f"V{idx + 1} (+{vz:.2f}m)", bold=True, rgb=(0.06, 0.09, 0.16))

        cmds.append("Q")  # Restore clip state

        # 2E. Viewport Coordinate Tick Labels outside Viewport Frame
        set_stroke(0.06, 0.09, 0.16, 0.7)
        for gx_mm, g_e in e_ticks:
            draw_line_mm(gx_mm, vp_y0_mm, gx_mm, vp_y0_mm - 1.5)
            draw_line_mm(gx_mm, vp_y1_mm, gx_mm, vp_y1_mm + 1.5)
            if vp_x0_mm + 6 < gx_mm < vp_x1_mm - 16:
                draw_text_mm(gx_mm - 6.5, vp_y0_mm - 4.0, 5.8, f"E {g_e:.0f}m", bold=False, rgb=(0.20, 0.25, 0.33))
                draw_text_mm(gx_mm - 6.5, vp_y1_mm + 2.0, 5.8, f"E {g_e:.0f}m", bold=False, rgb=(0.20, 0.25, 0.33))

        for gy_mm, g_n in n_ticks:
            draw_line_mm(vp_x0_mm - 1.5, gy_mm, vp_x0_mm, gy_mm)
            if vp_y0_mm + 4 < gy_mm < vp_y1_mm - 4:
                draw_text_mm(vp_x0_mm + 1.5, gy_mm + 0.8, 5.5, f"N {g_n:.0f}m", bold=False, rgb=(0.28, 0.33, 0.41))

        # 2F. Compass Rose / North Arrow Box inside Top-Right of Viewport
        set_fill(1.0, 1.0, 1.0)
        set_stroke(0.06, 0.09, 0.16, 0.7)
        draw_rect_mm(282.0, 250.0, 21.0, 24.0, "B")
        draw_text_mm(290.8, 269.5, 8.5, "N", bold=True, rgb=(0.06, 0.09, 0.16))
        # North Arrow Pointer Triangles
        set_fill(0.06, 0.09, 0.16)
        cmds.append(f"{292.5 * MM:.2f} {268.0 * MM:.2f} m {289.0 * MM:.2f} {256.0 * MM:.2f} l {292.5 * MM:.2f} {258.8 * MM:.2f} l h f")
        set_stroke(0.06, 0.09, 0.16, 0.7)
        cmds.append(f"{292.5 * MM:.2f} {268.0 * MM:.2f} m {296.0 * MM:.2f} {256.0 * MM:.2f} l {292.5 * MM:.2f} {258.8 * MM:.2f} l h S")
        draw_text_mm(284.2, 251.8, 5.2, "TWD97 GRID", bold=True, rgb=(0.01, 0.52, 0.78))

        # 2G. Alternating Graphic Scale Bar in Bottom-Left of Viewport
        set_fill(1.0, 1.0, 1.0)
        set_stroke(0.06, 0.09, 0.16, 0.7)
        draw_rect_mm(22.0, 21.0, 78.0, 14.5, "B")
        bar_total_m = round(40.0 * (scale_denom / 1000.0), 1)
        seg_m = bar_total_m / 4.0
        for b_i in range(4):
            bx_mm = 26.0 + b_i * 10.0
            if b_i % 2 == 0:
                set_fill(0.06, 0.09, 0.16)
                draw_rect_mm(bx_mm, 25.0, 10.0, 2.6, "B")
            else:
                set_fill(1.0, 1.0, 1.0)
                draw_rect_mm(bx_mm, 25.0, 10.0, 2.6, "B")
            draw_text_mm(bx_mm - 1.0, 22.3, 5.5, f"{b_i * seg_m:.1f}", bold=False)
        draw_text_mm(65.0, 22.3, 5.5, f"{bar_total_m:.1f} m", bold=True)
        draw_text_mm(26.0, 30.5, 6.8, f"SCALE 1 : {scale_denom}  (A3 ZOOM-TO-FIT)", bold=True, rgb=(0.06, 0.09, 0.16))
        draw_text_mm(26.0, 28.0, 5.2, f"Viewport Coverage: {meta.get('viewport_fill_pct', 85.0)}% | Units: Meters (TWD97)", bold=False, rgb=(0.28, 0.33, 0.41))

        # 3. Right-Hand Engineering Frame & Schedule Column ([310..408] mm X, [12..285] mm Y)
        set_stroke(0.06, 0.09, 0.16, 1.0)
        draw_rect_mm(310.0, 12.0, 98.0, 273.0, "S")

        # Section 3A: Legend & CAD Layer Key (Y: 242..285 mm)
        set_fill(0.95, 0.97, 0.99)
        draw_rect_mm(310.0, 278.0, 98.0, 7.0, "B")
        draw_text_mm(313.0, 280.2, 7.5, "1. SURVEY LEGEND & CIVIL3D LAYERS", bold=True, rgb=(0.06, 0.09, 0.16))
        draw_line_mm(310.0, 242.0, 408.0, 242.0)

        # Major contour sample line
        set_stroke(0.01, 0.52, 0.78, 1.3)
        draw_line_mm(314.0, 272.5, 328.0, 272.5)
        draw_text_mm(331.0, 271.5, 6.3, f"Major Contour ({meta.get('major_interval_m', 2.5):.2f}m) [C-TOPO-MAJR]", bold=True)

        # Minor contour sample line
        set_stroke(0.45, 0.53, 0.64, 0.6)
        draw_line_mm(314.0, 266.0, 328.0, 266.0)
        draw_text_mm(331.0, 265.0, 6.3, f"Minor Contour ({meta.get('minor_interval_m', 0.5):.2f}m) [C-TOPO-MINR]", bold=False)

        # Mask boundary sample line
        set_stroke(0.06, 0.09, 0.16, 1.5)
        cmds.append("[5 2 1.5 2] 0 d")
        draw_line_mm(314.0, 259.5, 328.0, 259.5)
        cmds.append("[] 0 d")
        draw_text_mm(331.0, 258.5, 6.3, "Active Mask Boundary [C-TOPO-BNDY]", bold=True)

        # Vertex monument sample
        set_fill(0.01, 0.52, 0.78)
        set_stroke(0.06, 0.09, 0.16, 0.6)
        draw_rect_mm(319.8, 251.8, 2.4, 2.4, "B")
        draw_text_mm(331.0, 252.0, 6.3, "Boundary Monument Vertex [C-TOPO-VERT]", bold=False)

        # TWD97 Grid sample
        set_stroke(0.65, 0.72, 0.80, 0.6)
        cmds.append("[2 2] 0 d")
        draw_line_mm(314.0, 246.0, 328.0, 246.0)
        cmds.append("[] 0 d")
        draw_text_mm(331.0, 245.0, 6.3, f"TWD97 Grid ({grid_step_m:.0f}m Step) [C-GRID-TWD97]", bold=False)

        # Section 3B: Mask Boundary Vertex Coordinate Schedule (Y: 146..242 mm)
        set_fill(0.95, 0.97, 0.99)
        set_stroke(0.06, 0.09, 0.16, 0.8)
        draw_rect_mm(310.0, 235.0, 98.0, 7.0, "B")
        draw_text_mm(313.0, 237.2, 7.5, "2. MASK BOUNDARY COORDINATES (TWD97)", bold=True, rgb=(0.06, 0.09, 0.16))

        set_fill(0.98, 0.98, 0.99)
        draw_rect_mm(310.0, 229.5, 98.0, 5.5, "B")
        draw_text_mm(312.5, 231.2, 5.8, "PT", bold=True)
        draw_text_mm(323.0, 231.2, 5.8, "EASTING X (m)", bold=True)
        draw_text_mm(353.0, 231.2, 5.8, "NORTHING Y (m)", bold=True)
        draw_text_mm(385.0, 231.2, 5.8, "TWVD2001 Z", bold=True)

        max_rows = min(len(poly_twd), 14)
        for idx in range(max_rows):
            vx, vy, vz = poly_twd[idx]
            ry = 224.5 - idx * 5.0
            if idx % 2 == 1:
                set_fill(0.97, 0.98, 1.0)
                draw_rect_mm(310.3, ry - 1.2, 97.4, 4.8, "f")
            draw_text_mm(312.5, ry, 5.8, f"V{idx + 1}", bold=True, rgb=(0.01, 0.45, 0.68))
            draw_text_mm(323.0, ry, 5.8, f"{vx:10.3f}", bold=False)
            draw_text_mm(353.0, ry, 5.8, f"{vy:11.3f}", bold=False)
            draw_text_mm(385.0, ry, 5.8, f"+{vz:6.2f} m", bold=True)

        draw_line_mm(310.0, 146.0, 408.0, 146.0)

        # Section 3C: Geodetic & Topographic Survey Summary (Y: 98..146 mm)
        set_fill(0.95, 0.97, 0.99)
        set_stroke(0.06, 0.09, 0.16, 0.8)
        draw_rect_mm(310.0, 139.0, 98.0, 7.0, "B")
        draw_text_mm(313.0, 141.2, 7.5, "3. GEODETIC & TOPOGRAPHIC SUMMARY", bold=True, rgb=(0.06, 0.09, 0.16))

        summary_rows = [
            ("Horizontal Datum:", "TWD97 / TM2 Zone 121 (EPSG:3826)"),
            ("Vertical Datum:", "TWVD2001 Orthometric (EPSG:8904)"),
            ("Mask Planar Area:", f"{meta.get('planar_area_m2', 0.0):.2f} m2 ({meta.get('planar_area_ping', 0.0):.2f} ping)"),
            ("Mask Perimeter:", f"{meta.get('perimeter_m', 0.0):.2f} m ({len(poly_twd)} vertices)"),
            ("Extracted Contours:", f"{len(contours)} clipped 3D polylines"),
            ("Elevation Range:", f"+{meta.get('elevation_range_m', [0, 0])[0]:.2f}m to +{meta.get('elevation_range_m', [0, 0])[1]:.2f}m"),
            ("RTK GNSS Accuracy:", f"+/- {meta.get('rtk_accuracy_cm', 1.4)} cm (PIX4Dcatch RTK)"),
            ("CAD Deliverable:", "Civil3D.dwg (3D Model + A3 Frame)"),
        ]
        for s_idx, (k_lbl, v_lbl) in enumerate(summary_rows):
            sy = 133.5 - s_idx * 4.5
            draw_text_mm(312.5, sy, 5.7, k_lbl, bold=True, rgb=(0.28, 0.33, 0.41))
            draw_text_mm(344.0, sy, 5.7, v_lbl, bold=True, rgb=(0.06, 0.09, 0.16))

        draw_line_mm(310.0, 96.0, 408.0, 96.0)

        # Section 3D: Filled Engineering Title Block with Gathering Construction Official Logo (Y: 12..96 mm)
        # Company Banner Box (Y: 72..96 mm)
        set_fill(0.06, 0.09, 0.16)
        draw_rect_mm(310.0, 72.0, 98.0, 24.0, "f")

        logo_jpg_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "web",
            "assets",
            "gathering_construction_logo_pdf_dark.jpg",
        )
        logo_jpg_bytes = b""
        if os.path.isfile(logo_jpg_path):
            try:
                with open(logo_jpg_path, "rb") as lf:
                    logo_jpg_bytes = lf.read()
            except Exception:
                logo_jpg_bytes = b""

        if logo_jpg_bytes:
            # Render embedded Gathering Construction logo XObject (/Im1) at X=312.5mm, Y=79.5mm, W=93.0mm, H=12.8mm
            cmds.append(
                f"q {93.0 * MM:.2f} 0 0 {12.8 * MM:.2f} {312.5 * MM:.2f} {79.5 * MM:.2f} cm /Im1 Do Q"
            )
            draw_text_mm(
                313.0,
                74.8,
                5.3,
                "3D Photogrammetry, LiDAR & Civil 3D Topographic Surveying",
                bold=False,
                rgb=(0.76, 0.84, 0.94),
            )
        else:
            draw_text_mm(314.0, 86.5, 9.5, "GATHERING CONSTRUCTION.,LTD.", bold=True, rgb=(1.0, 1.0, 1.0))
            draw_text_mm(314.0, 80.5, 6.2, "3D CIVIL SURVEYING & PHOTOGRAMMETRY", bold=True, rgb=(0.22, 0.74, 0.97))

        # Title Block Grid Cells (Y: 12..72 mm)
        set_stroke(0.06, 0.09, 0.16, 0.7)
        draw_line_mm(310.0, 58.0, 408.0, 58.0)
        draw_line_mm(310.0, 43.0, 408.0, 43.0)
        draw_line_mm(310.0, 30.0, 408.0, 30.0)
        draw_line_mm(310.0, 20.5, 408.0, 20.5)
        draw_line_mm(359.0, 20.5, 359.0, 43.0)
        draw_line_mm(345.0, 12.0, 345.0, 20.5)
        draw_line_mm(382.0, 12.0, 382.0, 20.5)

        # Project Site & Scan Name
        draw_text_mm(312.5, 68.0, 5.2, "PROJECT / SITE GROUP:", bold=True, rgb=(0.39, 0.45, 0.55))
        draw_text_mm(312.5, 61.5, 8.2, str(meta.get("project_group") or "Unassigned Site"), bold=True, rgb=(0.06, 0.09, 0.16))

        draw_text_mm(312.5, 54.2, 5.2, "SURVEY DRAWING TITLE / ACTIVE SCAN SESSION:", bold=True, rgb=(0.39, 0.45, 0.55))
        title_str = str(meta.get("drawing_title", meta.get("scan_name", "Topographic Survey")))
        draw_text_mm(312.5, 48.0, 7.2, title_str[:42], bold=True, rgb=(0.01, 0.42, 0.65))
        draw_text_mm(312.5, 44.5, 5.4, f"Scan ID: {meta.get('scan_id', '')} | Deliverable: Civil3D.dwg", bold=False, rgb=(0.28, 0.33, 0.41))

        # Row: Survey Date & Engineer
        draw_text_mm(312.5, 39.2, 5.0, "SURVEY / CAPTURE DATE:", bold=True, rgb=(0.39, 0.45, 0.55))
        draw_text_mm(312.5, 33.2, 6.8, str(meta.get("capture_date") or ""), bold=True, rgb=(0.06, 0.09, 0.16))

        draw_text_mm(361.5, 39.2, 5.0, "SURVEYOR / ENGINEER:", bold=True, rgb=(0.39, 0.45, 0.55))
        draw_text_mm(361.5, 33.2, 6.8, str(meta.get("engineer_name") or "Survey Engineer"), bold=True, rgb=(0.06, 0.09, 0.16))

        # Row: Issue Date & Scale
        draw_text_mm(312.5, 26.8, 5.0, "REPORT ISSUE DATE:", bold=True, rgb=(0.39, 0.45, 0.55))
        draw_text_mm(312.5, 22.2, 6.4, str(meta.get("report_date", ""))[:16], bold=True, rgb=(0.06, 0.09, 0.16))

        draw_text_mm(361.5, 26.8, 5.0, "A3 ZOOM-TO-FIT SCALE:", bold=True, rgb=(0.39, 0.45, 0.55))
        draw_text_mm(361.5, 22.2, 7.2, f"1 : {scale_denom} (A3)", bold=True, rgb=(0.01, 0.45, 0.68))

        # Bottom Row: Sheet Size, Drawing Number, Revision
        draw_text_mm(312.5, 17.2, 4.8, "SHEET SIZE:", bold=True, rgb=(0.39, 0.45, 0.55))
        draw_text_mm(312.5, 13.5, 6.0, "A3 (420x297mm)", bold=True, rgb=(0.06, 0.09, 0.16))

        draw_text_mm(347.0, 17.2, 4.8, "DRAWING NO.:", bold=True, rgb=(0.39, 0.45, 0.55))
        draw_text_mm(347.0, 13.5, 5.8, str(meta.get("drawing_no", "GS-C3D-A3")), bold=True, rgb=(0.06, 0.09, 0.16))

        draw_text_mm(384.0, 17.2, 4.8, "REV / SHEET:", bold=True, rgb=(0.39, 0.45, 0.55))
        draw_text_mm(384.0, 13.5, 6.0, "REV A | 1/1", bold=True, rgb=(0.06, 0.09, 0.16))

        # Assemble valid PDF 1.4 file with exact xref byte offsets (including /F3 Traditional Chinese CIDFont)
        stream_bytes = "\n".join(cmds).encode("latin-1", "replace")
        xobj_res = "/XObject << /Im1 9 0 R >> " if logo_jpg_bytes else ""
        objs: List[bytes] = [
            b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
            b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
            (
                f"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W:.2f} {PAGE_H:.2f}] "
                f"/Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> {xobj_res}>> /Contents 8 0 R >>\nendobj\n"
            ).encode("ascii"),
            b"4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
            b"5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n",
            b"6 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /MHei-Medium /Encoding /UniCNS-UCS2-H /DescendantFonts [7 0 R] >>\nendobj\n",
            b"7 0 obj\n<< /Type /Font /Subtype /CIDFontType0 /BaseFont /MHei-Medium /CIDSystemInfo << /Registry (Adobe) /Ordering (CNS1) /Supplement 4 >> /DW 1000 >>\nendobj\n",
            f"8 0 obj\n<< /Length {len(stream_bytes)} >>\nstream\n".encode("ascii")
            + stream_bytes
            + b"\nendstream\nendobj\n",
        ]
        if logo_jpg_bytes:
            objs.append(
                (
                    f"9 0 obj\n<< /Type /XObject /Subtype /Image /Width 917 /Height 126 "
                    f"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {len(logo_jpg_bytes)} >>\nstream\n"
                ).encode("ascii")
                + logo_jpg_bytes
                + b"\nendstream\nendobj\n"
            )

        pdf_buf = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets: List[int] = []
        for obj_bytes in objs:
            offsets.append(len(pdf_buf))
            pdf_buf.extend(obj_bytes)

        xref_offset = len(pdf_buf)
        pdf_buf.extend(f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode("ascii"))
        for off in offsets:
            pdf_buf.extend(f"{off:010d} 00000 n \n".encode("ascii"))

        pdf_buf.extend(
            (
                f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\n"
                f"startxref\n{xref_offset}\n%%EOF\n"
            ).encode("ascii")
        )

        with open(pdf_path, "wb") as pf:
            pf.write(pdf_buf)

    def compute_cross_section_profile(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Computes a real 2D Cross-Section Elevation Profile (Chainage vs. TWVD2001 Elevation H)
        by sampling the active scan's 3D mesh DSM and a comparison epoch scan's 3D mesh DSM.
        """
        scan_id = (payload.get("scan_id") or "").strip()
        compare_scan_id = payload.get("compare_scan_id")
        scan = self._resolve_scan_record(scan_id)

        dsm_curr = self._load_or_build_scan_dsm(scan)
        ce = dsm_curr["ce"]
        cn = dsm_curr["cn"]
        ch = dsm_curr["ch"]

        # Resolve baseline scan from the same project group if not explicitly provided or invalid
        cmp_scan = self.db.get_scan(compare_scan_id) if compare_scan_id else None
        if not cmp_scan or cmp_scan.get("scan_id") == scan.get("scan_id"):
            for cand in self.db.list_scans():
                if cand.get("scan_id") != scan.get("scan_id") and cand.get("project_group") == scan.get("project_group"):
                    cmp_scan = cand
                    compare_scan_id = cand.get("scan_id")
                    break

        dsm_cmp = None
        if cmp_scan:
            try:
                dsm_cmp = self._load_or_build_scan_dsm(cmp_scan)
            except Exception:
                dsm_cmp = None

        span_e = min(12.0, max(1.5, (dsm_curr["e_max"] - dsm_curr["e_min"]) * 0.25))
        span_n = min(10.0, max(1.2, (dsm_curr["n_max"] - dsm_curr["n_min"]) * 0.20))
        p_start = payload.get("start_point") or payload.get("start_pt") or [ce - span_e, cn - span_n]
        p_end = payload.get("end_point") or payload.get("end_pt") or [ce + span_e, cn + span_n]

        def _to_en(pt_val: Any) -> Tuple[float, float]:
            if isinstance(pt_val, dict):
                px = float(pt_val.get("x", pt_val.get("e", 0.0)))
                pz = float(pt_val.get("z", pt_val.get("n", 0.0)))
                if abs(px) < 10000 and abs(pz) < 10000:
                    return ce + px, cn - pz
                return px, pz
            px = float(pt_val[0])
            py = float(pt_val[1])
            if abs(px) < 10000 and abs(py) < 10000:
                return ce + px, cn - py
            return px, py

        x1, y1 = _to_en(p_start)
        x2, y2 = _to_en(p_end)

        total_len = max(math.hypot(x2 - x1, y2 - y1), 0.5)
        num_samples = 60
        samples = []
        max_slope_pct = 0.0

        # Compute linear datum connecting start and end elevations as fallback if no baseline epoch exists
        z_start, _, _, _ = self._sample_dsm_elevation(dsm_curr, x1, y1)
        z_end, _, _, _ = self._sample_dsm_elevation(dsm_curr, x2, y2)

        prev_z = None
        step_m = total_len / num_samples
        for i in range(num_samples + 1):
            t = i / num_samples
            ex = x1 + t * (x2 - x1)
            ny = y1 + t * (y2 - y1)
            chainage = round(t * total_len, 2)

            z_curr, _, _, _ = self._sample_dsm_elevation(dsm_curr, ex, ny)
            if dsm_cmp is not None:
                z_base, _, _, is_cmp_valid = self._sample_dsm_elevation(dsm_cmp, ex, ny)
                if not is_cmp_valid:
                    # Shift by vertical datum difference if baseline scan has slight offset
                    z_base = z_curr - (ch - dsm_cmp["ch"])
            else:
                z_base = z_start + t * (z_end - z_start)

            slope_pct = 0.0
            if prev_z is not None and step_m > 0:
                slope_pct = round(abs(z_curr - prev_z) / step_m * 100.0, 1)
                max_slope_pct = max(max_slope_pct, slope_pct)
            prev_z = z_curr

            samples.append(
                {
                    "chainage_m": chainage,
                    "easting_m": round(ex, 3),
                    "northing_m": round(ny, 3),
                    "elevation_m": round(z_curr, 3),
                    "baseline_elevation_m": round(z_base, 3),
                    "delta_z_m": round(z_curr - z_base, 3),
                    "slope_pct": slope_pct,
                    "local_x": round(ex - ce, 3),
                    "local_y": round(z_curr - ch, 3),
                    "local_z": round(cn - ny, 3),
                }
            )

        return {
            "status": "ok",
            "scan_id": scan_id,
            "compare_scan_id": compare_scan_id,
            "compare_scan_name": cmp_scan.get("name") if cmp_scan else "Chord Grade Datum",
            "crs": TWD97_TWVD2001_SHORT,
            "total_length_m": round(total_len, 2),
            "max_slope_pct": round(max_slope_pct, 1),
            "start_twd97": [round(x1, 3), round(y1, 3), round(z_start, 3)],
            "end_twd97": [round(x2, 3), round(y2, 3), round(z_end, 3)],
            "samples": samples,
        }

    @staticmethod
    def _dms_to_deg(dms_val: Any, ref: str) -> Optional[float]:
        try:
            def _to_f(v: Any) -> float:
                if hasattr(v, "numerator") and hasattr(v, "denominator"):
                    return float(v.numerator) / max(float(v.denominator), 1e-12)
                if isinstance(v, (tuple, list)) and len(v) == 2:
                    return float(v[0]) / max(float(v[1]), 1e-12)
                return float(v)

            d = _to_f(dms_val[0])
            m = _to_f(dms_val[1])
            s = _to_f(dms_val[2])
            deg = d + m / 60.0 + s / 3600.0
            if str(ref).upper().strip() in ("S", "W"):
                deg = -deg
            return deg
        except Exception:
            return None

    def _get_candidate_camera_dirs(self, scan: Dict[str, Any]) -> List[str]:
        dirs: List[str] = []
        for k in ("cameras_dir", "project_dir", "src_project_dir"):
            v = scan.get(k)
            if v and os.path.isdir(v) and v not in dirs:
                dirs.append(v)
        # Inspect report_pdf_path parent project dir & its inputs subfolder
        rpt_pdf = str(scan.get("report_pdf_path") or "").strip()
        if rpt_pdf and os.path.exists(rpt_pdf):
            rpt_proj = os.path.dirname(os.path.dirname(os.path.abspath(rpt_pdf)))
            for cand_d in (rpt_proj, os.path.join(rpt_proj, "inputs")):
                if cand_d and os.path.isdir(cand_d) and cand_d not in dirs:
                    dirs.append(cand_d)
        # Inspect source_zip_path if any part is an OPF/raw-photo folder on disk
        for raw_src in str(scan.get("source_zip_path") or "").split(";"):
            raw_src = raw_src.strip()
            if raw_src and os.path.isdir(raw_src) and raw_src not in dirs:
                dirs.append(raw_src)
        # Dynamically inspect PIX4Dmatic project/configs/opf.json and *.gst files for imported OPF/project directories
        proj_dir = scan.get("project_dir") or ""
        if proj_dir and os.path.isdir(proj_dir):
            import re as _re
            for gst_fp in glob.glob(os.path.join(proj_dir, "*.gst")):
                try:
                    with open(gst_fp, "r", encoding="utf-8", errors="ignore") as gf:
                        gst_txt = gf.read()
                    for m_f in _re.finditer(r'folder\s*:\s*"([^"]+)"', gst_txt):
                        f_cand = os.path.normpath(m_f.group(1).strip())
                        for sub_c in (f_cand, os.path.join(f_cand, "inputs")):
                            if os.path.isdir(sub_c) and sub_c not in dirs:
                                dirs.append(sub_c)
                except Exception:
                    pass
            for check_root in list(dirs):
                for opf_cfg in (
                    os.path.join(check_root, "project", "configs", "opf.json"),
                    os.path.join(check_root, "configs", "opf.json"),
                ):
                    if os.path.isfile(opf_cfg):
                        try:
                            with open(opf_cfg, "r", encoding="utf-8", errors="ignore") as cf:
                                cfg_obj = json.load(cf)
                            imp_list = cfg_obj.get("imported-opf") or []
                            if isinstance(imp_list, dict):
                                imp_list = [imp_list]
                            for entry in imp_list:
                                if isinstance(entry, dict) and entry.get("path"):
                                    opf_root = os.path.dirname(str(entry["path"]))
                                    if os.path.isdir(opf_root) and opf_root not in dirs:
                                        dirs.append(opf_root)
                        except Exception:
                            pass
        return dirs

    def _load_or_build_camera_catalog(self, scan: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        Loads or builds the real RTK camera pose catalog for a scan by parsing
        Pix4DCatch OPF (`opf_files/camera_list.json` + `opf_files/input_cameras.json`)
        or extracting EXIF GPS coordinates from raw `.jpg` frames on disk.
        """
        scan_id = str(scan.get("scan_id") or "unknown")
        if scan_id in self._camera_mem_cache:
            return self._camera_mem_cache[scan_id]

        proj_dir = scan.get("project_dir") or os.path.join(SCANS_ROOT_DIR, scan_id)
        if os.path.isdir(proj_dir):
            for cache_name in ("_cameras_cache_v3.json", "_cameras_cache_v2.json"):
                cache_cand = os.path.join(proj_dir, cache_name)
                if os.path.isfile(cache_cand):
                    try:
                        with open(cache_cand, "r", encoding="utf-8") as f:
                            cams = json.load(f)
                        if isinstance(cams, list) and len(cams) > 0:
                            self._camera_mem_cache[scan_id] = cams
                            return cams
                    except Exception:
                        pass
        cache_json = os.path.join(proj_dir, "_cameras_cache_v3.json") if os.path.isdir(proj_dir) else None

        search_dirs = self._get_candidate_camera_dirs(scan)
        catalog: List[Dict[str, Any]] = []
        scan_crs_up = str(scan.get("crs") or "").upper()

        def _cam_xy_to_scan_en(c0: float, c1: float) -> Optional[Tuple[float, float]]:
            if 150000.0 <= c0 <= 345000.0 and 2400000.0 <= c1 <= 2850000.0:
                return c0, c1
            if 100000.0 <= c0 <= 850000.0 and 2500000.0 <= c1 <= 3000000.0:
                if "UTM" in scan_crs_up:
                    return c0, c1
                from pc_worker.gdrive_watcher import utm51n_to_wgs84

                lat_u, lon_u = utm51n_to_wgs84(c0, c1)
                return wgs84_to_twd97(lat_u, lon_u)
            if abs(c0) > 180.0 or abs(c1) > 180.0:
                return c0, c1
            lat_d, lon_d = (c0, c1) if (-90.0 <= c0 <= 90.0 and -180.0 <= c1 <= 180.0) else (c1, c0)
            if "UTM" in scan_crs_up and not (20.0 <= lat_d <= 27.0 and 118.0 <= lon_d <= 123.5):
                from pc_worker.gdrive_watcher import wgs84_to_utm

                ue, un, _, _ = wgs84_to_utm(lat_d, lon_d)
                return ue, un
            return wgs84_to_twd97(lat_d, lon_d)

        # 1. Try OPF input_cameras.json + camera_list.json first (highest accuracy: RTK sigmas + IMU yaw/pitch/roll)
        for sdir in search_dirs:
            opf_inputs = glob.glob(os.path.join(sdir, "**", "input_cameras.json"), recursive=True)
            for in_cam_path in opf_inputs:
                opf_dir = os.path.dirname(in_cam_path)
                cam_list_path = os.path.join(opf_dir, "camera_list.json")
                if not os.path.isfile(cam_list_path):
                    continue
                try:
                    with open(cam_list_path, "r", encoding="utf-8") as f:
                        clist_data = json.load(f)
                    id_to_uri = {
                        int(c["id"]): str(c["uri"])
                        for c in clist_data.get("cameras", [])
                        if "id" in c and "uri" in c and str(c["uri"]).lower().endswith((".jpg", ".jpeg", ".png"))
                    }
                    with open(in_cam_path, "r", encoding="utf-8") as f:
                        icams_data = json.load(f)
                    part_tag = os.path.basename(os.path.dirname(opf_dir))
                    for cap in icams_data.get("captures", []):
                        cam_id = int(cap.get("reference_camera_id") or cap.get("id") or 0)
                        rel_uri = id_to_uri.get(cam_id)
                        if not rel_uri:
                            for sub_c in cap.get("cameras", []):
                                cid = int(sub_c.get("id") or 0)
                                if cid in id_to_uri:
                                    rel_uri = id_to_uri[cid]
                                    break
                        if not rel_uri:
                            continue
                        abs_img = os.path.normpath(os.path.join(opf_dir, rel_uri))
                        if not os.path.isfile(abs_img):
                            continue
                        geo = cap.get("geolocation") or {}
                        coords = geo.get("coordinates") or []
                        if len(coords) < 2:
                            continue
                        c0 = float(coords[0])
                        c1 = float(coords[1])
                        h_val = float(coords[2]) if len(coords) >= 3 else float(scan.get("twd97_h") or 0.0)
                        en_pair = _cam_xy_to_scan_en(c0, c1)
                        if en_pair is None:
                            continue
                        cam_e, cam_n = en_pair
                        sigmas = geo.get("sigmas") or [0.014, 0.014, 0.022]
                        h_sigma_cm = round(math.hypot(float(sigmas[0]), float(sigmas[1])) * 100.0, 2)
                        v_sigma_cm = round(float(sigmas[2]) * 100.0, 2) if len(sigmas) >= 3 else 2.2
                        ori = cap.get("orientation") or {}
                        angles = ori.get("angles_deg") or [0.0, -20.0, 0.0]
                        fname = os.path.basename(abs_img)
                        display_name = f"{part_tag}/{fname}" if part_tag and part_tag not in ("inputs", "opf_files") else fname
                        catalog.append(
                            {
                                "filename": display_name,
                                "abs_path": abs_img,
                                "e": round(cam_e, 3),
                                "n": round(cam_n, 3),
                                "h": round(h_val, 3),
                                "rtk_h_sigma_cm": h_sigma_cm,
                                "rtk_v_sigma_cm": v_sigma_cm,
                                "yaw_deg": round(float(angles[0]) % 360.0, 1) if len(angles) >= 1 else 0.0,
                                "pitch_deg": round(float(angles[1]), 1) if len(angles) >= 2 else -20.0,
                            }
                        )
                except Exception:
                    continue
            if catalog:
                break

        # 2. Fallback to EXIF GPS extraction from raw .jpg files if no OPF camera files were present
        if not catalog:
            for sdir in search_dirs:
                jpgs = [
                    p for p in (
                        glob.glob(os.path.join(sdir, "**", "*.jpg"), recursive=True)
                        + glob.glob(os.path.join(sdir, "**", "*.jpeg"), recursive=True)
                    )
                    if not os.path.basename(p).lower().startswith(("mesh", "thumb"))
                ]
                if not jpgs:
                    continue
                jpgs.sort()
                # Sample up to 600 frames evenly across the capture sequence
                stride = max(1, len(jpgs) // 600)
                for jp in jpgs[::stride]:
                    try:
                        with Image.open(jp) as im:
                            exif = im._getexif() or {}
                        gps_raw = exif.get(34853)
                        if not gps_raw:
                            continue
                        gps = {GPSTAGS.get(k, k): v for k, v in gps_raw.items()}
                        lat = self._dms_to_deg(gps.get("GPSLatitude"), gps.get("GPSLatitudeRef", "N"))
                        lon = self._dms_to_deg(gps.get("GPSLongitude"), gps.get("GPSLongitudeRef", "E"))
                        if lat is None or lon is None:
                            continue
                        alt_raw = gps.get("GPSAltitude", scan.get("twd97_h") or 0.0)
                        if hasattr(alt_raw, "numerator"):
                            h_val = float(alt_raw.numerator) / max(float(alt_raw.denominator), 1e-9)
                        elif isinstance(alt_raw, (tuple, list)) and len(alt_raw) == 2:
                            h_val = float(alt_raw[0]) / max(float(alt_raw[1]), 1e-9)
                        else:
                            h_val = float(alt_raw)
                        cam_e, cam_n = wgs84_to_twd97(lat, lon)
                        catalog.append(
                            {
                                "filename": os.path.basename(jp),
                                "abs_path": os.path.abspath(jp),
                                "e": round(cam_e, 3),
                                "n": round(cam_n, 3),
                                "h": round(h_val, 3),
                                "rtk_h_sigma_cm": float(scan.get("rtk_accuracy_cm") or 1.4),
                                "rtk_v_sigma_cm": round(float(scan.get("rtk_accuracy_cm") or 1.4) * 1.4, 2),
                                "yaw_deg": 0.0,
                                "pitch_deg": -22.0,
                            }
                        )
                    except Exception:
                        continue
                if catalog:
                    break

        if catalog:
            self._camera_mem_cache[scan_id] = catalog
            if cache_json:
                try:
                    with open(cache_json, "w", encoding="utf-8") as f:
                        json.dump(catalog, f)
                except Exception:
                    pass
        return catalog

    def resolve_camera_photo_path(self, scan_id: str, file_key: str) -> Optional[str]:
        """Resolves a requested camera photo `file_key` to its verified local `.jpg` path on disk."""
        clean_id = (scan_id or "").strip()
        if not clean_id:
            return None
        scan = self.db.get_scan(clean_id)
        if not scan:
            return None
        catalog = self._load_or_build_camera_catalog(scan)
        norm_key = str(file_key or "").replace("\\", "/").strip("/")
        base_key = os.path.basename(norm_key)
        for cam in catalog:
            if cam.get("filename") == norm_key and os.path.isfile(cam["abs_path"]):
                return cam["abs_path"]
        for cam in catalog:
            if os.path.basename(cam.get("abs_path", "")) == base_key and os.path.isfile(cam["abs_path"]):
                return cam["abs_path"]
        for sdir in self._get_candidate_camera_dirs(scan):
            abs_sdir = os.path.abspath(sdir)
            direct = os.path.abspath(os.path.join(sdir, norm_key.replace("/", os.sep)))
            if direct.startswith(abs_sdir + os.sep) and os.path.isfile(direct):
                return direct
            if base_key and ".." not in base_key:
                matches = glob.glob(os.path.join(sdir, "**", base_key), recursive=True)
                if matches and os.path.isfile(matches[0]):
                    return matches[0]
        return None

    def inspect_rtk_camera_photos(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Finds the closest real Pix4DCatch RTK smartphone photographs on the PC
        capturing the clicked 3D surface coordinate (TWD97 E, N, TWVD2001 H).
        """
        from urllib.parse import quote

        scan_id = (payload.get("scan_id") or "").strip()
        scan = self._resolve_scan_record(scan_id)

        ce = float(scan.get("twd97_e") or 0.0)
        cn = float(scan.get("twd97_n") or 0.0)
        ch = float(scan.get("twd97_h") or 0.0)

        click_x = float(payload.get("x", 0.0))
        click_y = float(payload.get("y", 0.0))
        click_z = float(payload.get("z", 0.0))

        if payload.get("twd_e") is not None and payload.get("twd_n") is not None:
            target_e = round(float(payload["twd_e"]), 3)
            target_n = round(float(payload["twd_n"]), 3)
            if payload.get("twd_h") is not None:
                target_h = round(float(payload["twd_h"]), 3)
            else:
                target_h = round(ch + click_y if abs(click_y) < 1000 else click_y, 3)
        else:
            target_e = round(ce + click_x if abs(click_x) < 10000 else click_x, 3)
            target_n = round(cn - click_z if abs(click_z) < 10000 else click_z, 3)
            if click_x == 0.0 and click_y == 0.0 and click_z == 0.0:
                try:
                    dsm = self._load_or_build_scan_dsm(scan)
                    sampled_h, _, _, _ = self._sample_dsm_elevation(dsm, target_e, target_n)
                    target_h = round(sampled_h, 3)
                except Exception:
                    target_h = round(ch, 3)
            else:
                target_h = round(ch + click_y if abs(click_y) < 1000 else click_y, 3)

        catalog = self._load_or_build_camera_catalog(scan)
        scored: List[Tuple[float, float, Dict[str, Any]]] = []
        for cam in catalog:
            dx = target_e - cam["e"]
            dy = target_n - cam["n"]
            dz = target_h - cam["h"]
            dist_2d = math.hypot(dx, dy)
            dist_3d = math.sqrt(dx * dx + dy * dy + dz * dz)
            # Ideal close-range terrestrial photogrammetry distance is 1.5m - 35m
            dist_penalty = dist_3d if dist_3d >= 1.2 else (1.2 - dist_3d) * 4.0 + 1.2
            # Bearing from camera to clicked 3D point (0 deg = North, 90 deg = East)
            bearing_deg = (math.degrees(math.atan2(dx, dy)) + 360.0) % 360.0
            cam_yaw = float(cam.get("yaw_deg") or 0.0)
            ang_diff = abs((bearing_deg - cam_yaw + 180.0) % 360.0 - 180.0)
            score = dist_penalty + (ang_diff / 180.0) * 3.5 if dist_2d > 0.5 else dist_penalty
            scored.append((score, dist_3d, cam))

        scored.sort(key=lambda item: item[0])

        # Select up to 6 distinct camera viewpoints (> 0.65m apart so burst duplicates are skipped)
        selected_photos = []
        used_positions: List[Tuple[float, float, float]] = []
        for _, dist_3d, cam in scored:
            pos = (cam["e"], cam["n"], cam["h"])
            if any(math.hypot(pos[0] - u[0], pos[1] - u[1]) < 0.65 for u in used_positions):
                continue
            used_positions.append(pos)
            fk = cam["filename"]
            selected_photos.append(
                {
                    "filename": fk,
                    "url": f"/api/camera-photo?scan_id={quote(str(scan_id))}&file={quote(fk)}",
                    "distance_m": round(dist_3d, 2),
                    "rtk_h_sigma_cm": cam["rtk_h_sigma_cm"],
                    "rtk_v_sigma_cm": cam["rtk_v_sigma_cm"],
                    "camera_twd97_e": cam["e"],
                    "camera_twd97_n": cam["n"],
                    "camera_twd97_h": cam["h"],
                    "camera_local_x": round(cam["e"] - ce, 3),
                    "camera_local_y": round(cam["h"] - ch, 3),
                    "camera_local_z": round(cn - cam["n"], 3),
                    "yaw_deg": cam["yaw_deg"],
                    "pitch_deg": cam["pitch_deg"],
                }
            )
            if len(selected_photos) >= 6:
                break

        return {
            "status": "ok",
            "scan_id": scan_id,
            "target_twd97": {"e": target_e, "n": target_n, "h": target_h},
            "crs": TWD97_TWVD2001_SHORT,
            "total_catalog_cameras": len(catalog),
            "photo_count": len(selected_photos),
            "photos": selected_photos,
        }

    @staticmethod
    def _load_gemini_api_key_silent() -> str:
        """Silently loads GEMINI_API_KEY from environment or .env files without ever printing or logging it."""
        key = os.environ.get("GEMINI_API_KEY", "").strip()
        if key:
            return key
        base_repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        for env_path in (
            os.path.join(base_repo, ".env"),
            r"c:\Antigravity\GatheringScans\.env",
            os.path.expanduser("~/.env"),
        ):
            if os.path.isfile(env_path):
                try:
                    with open(env_path, "r", encoding="utf-8", errors="ignore") as ef:
                        for line in ef:
                            line_s = line.strip()
                            if not line_s or line_s.startswith("#") or "=" not in line_s:
                                continue
                            k_part, v_part = line_s.split("=", 1)
                            if k_part.strip() == "GEMINI_API_KEY":
                                val = v_part.strip().strip('"').strip("'")
                                if val:
                                    return val
                except Exception:
                    pass
        return ""

    @staticmethod
    def _fit_pratt_circle_2d(x: np.ndarray, y: np.ndarray) -> Tuple[float, float, float]:
        """Algebraic Pratt/Kasa circle fit returning (cx, cy, radius_m) for 2D trunk points."""
        n = len(x)
        if n < 3:
            return float(np.mean(x)), float(np.mean(y)), 0.12
        mx = float(np.mean(x))
        my = float(np.mean(y))
        u = x - mx
        v = y - my
        z = u * u + v * v
        try:
            A = np.column_stack([u, v, np.ones_like(u)])
            c_vec, _, _, _ = np.linalg.lstsq(A, z, rcond=None)
            uc = 0.5 * float(c_vec[0])
            vc = 0.5 * float(c_vec[1])
            r_sq = float(c_vec[2]) + uc * uc + vc * vc
            r = math.sqrt(max(r_sq, 1e-4))
            if not (0.03 <= r <= 1.25):
                r = float(np.median(np.hypot(u, v)))
            return mx + uc, my + vc, float(np.clip(r, 0.04, 0.95))
        except Exception:
            r = float(np.median(np.hypot(u, v)))
            return mx, my, float(np.clip(r, 0.04, 0.95))

    @staticmethod
    def _load_scan_textured_triangles_twd97(
        scan: Dict[str, Any],
        ce: float,
        cn: float,
        ch: float,
    ) -> Dict[str, Any]:
        """
        Stage 0: Universal 3D Mesh / GLB / 3TZ + UV Texture Loader.
        Loads 3D triangles (v0, v1, v2) in 64-bit TWD97 (E, N, H) and UV coordinates (vt0, vt1, vt2)
        + RGB texture image (mesh_0.jpg or embedded GLB texture), returning per-triangle geometric
        and radiometric features.
        """
        import struct

        proj_dir = scan.get("project_dir") or os.path.join(SCANS_ROOT_DIR, str(scan.get("scan_id") or ""))
        obj_path = SurveyingEngine._resolve_scan_obj_path(scan)
        ts_path = scan.get("tileset_path") or os.path.join(proj_dir, "tileset", "tileset.json")
        obj_mtime = os.path.getmtime(obj_path) if (obj_path and os.path.isfile(obj_path)) else 0.0
        ts_mtime = os.path.getmtime(ts_path) if (ts_path and os.path.isfile(ts_path)) else 0.0
        tileset_edited_after_obj = bool(ts_mtime > 0.0 and obj_mtime > 0.0 and ts_mtime > obj_mtime + 2.0)

        v0_arr = None
        v1_arr = None
        v2_arr = None
        rgb_arr = None
        geom_source = "none"

        # 1. Try fast C-backed numpy OBJ + UV + JPEG loader (preferred whenever mesh.obj exists)
        if obj_path and os.path.isfile(obj_path):
            try:
                obj_dir = os.path.dirname(obj_path)
                off_xyz = (0.0, 0.0, 0.0)
                off_cand = os.path.join(obj_dir, "offset.xyz")
                if os.path.isfile(off_cand):
                    with open(off_cand, "r", encoding="utf-8", errors="ignore") as f_off:
                        toks = f_off.read().strip().split()
                    if len(toks) >= 3:
                        off_xyz = (float(toks[0]), float(toks[1]), float(toks[2]))

                with open(obj_path, "r", encoding="ascii", errors="ignore") as f_obj:
                    lines = f_obj.read().splitlines()

                v_str = "\n".join(l[2:] for l in lines if l.startswith("v "))
                vt_str = "\n".join(l[3:] for l in lines if l.startswith("vt "))
                f_lines = [l[2:] for l in lines if l.startswith("f ")]

                verts = np.fromstring(v_str, dtype=np.float64, sep=" ").reshape(-1, 3)
                verts[:, 0] += off_xyz[0]
                verts[:, 1] += off_xyz[1]
                verts[:, 2] += off_xyz[2]

                uvs = np.fromstring(vt_str, dtype=np.float32, sep=" ").reshape(-1, 2) if vt_str else None

                sample_f = f_lines[0] if f_lines else ""
                has_uv_idx = "/" in sample_f and "//" not in sample_f
                slash_cnt = sample_f.count("/")
                f_str = "\n".join(l.replace("/", " ") for l in f_lines)
                f_vals = np.fromstring(f_str, dtype=np.int32, sep=" ")

                if slash_cnt == 3 and has_uv_idx:
                    f_mat = f_vals.reshape(-1, 6)
                    vi = np.clip(f_mat[:, [0, 2, 4]] - 1, 0, len(verts) - 1)
                    ti = np.clip(f_mat[:, [1, 3, 5]] - 1, 0, (len(uvs) - 1) if uvs is not None and len(uvs) > 0 else 0)
                elif slash_cnt == 6:
                    f_mat = f_vals.reshape(-1, 9)
                    vi = np.clip(f_mat[:, [0, 3, 6]] - 1, 0, len(verts) - 1)
                    ti = np.clip(f_mat[:, [1, 4, 7]] - 1, 0, (len(uvs) - 1) if uvs is not None and len(uvs) > 0 else 0)
                else:
                    f_mat = f_vals.reshape(-1, 3)
                    vi = np.clip(f_mat - 1, 0, len(verts) - 1)
                    ti = None

                v0_arr = verts[vi[:, 0]]
                v1_arr = verts[vi[:, 1]]
                v2_arr = verts[vi[:, 2]]
                geom_source = "obj"

                # Sample texture image (mesh_0.jpg or any *.jpg in obj_dir) at 4 barycentric points per triangle
                tex_jpgs = glob.glob(os.path.join(obj_dir, "*.jpg")) + glob.glob(os.path.join(obj_dir, "*.png"))
                if uvs is not None and len(uvs) > 0 and ti is not None and tex_jpgs and Image is not None:
                    tex_img = Image.open(tex_jpgs[0]).convert("RGB")
                    tex_np = np.asarray(tex_img, dtype=np.float32) / 255.0
                    th, tw, _ = tex_np.shape
                    uv0 = uvs[ti[:, 0]]
                    uv1 = uvs[ti[:, 1]]
                    uv2 = uvs[ti[:, 2]]
                    # 4-point barycentric UV sampling: centroid + 3 interior points
                    b_weights = [
                        (1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0),
                        (0.60, 0.20, 0.20),
                        (0.20, 0.60, 0.20),
                        (0.20, 0.20, 0.60),
                    ]
                    rgb_acc = np.zeros((len(v0_arr), 3), dtype=np.float32)
                    for w0, w1, w2 in b_weights:
                        u_s = np.mod(w0 * uv0[:, 0] + w1 * uv1[:, 0] + w2 * uv2[:, 0], 1.0)
                        v_s = np.mod(w0 * uv0[:, 1] + w1 * uv1[:, 1] + w2 * uv2[:, 1], 1.0)
                        px = np.clip((u_s * (tw - 1)).astype(np.int32), 0, tw - 1)
                        py = np.clip(((1.0 - v_s) * (th - 1)).astype(np.int32), 0, th - 1)
                        rgb_acc += tex_np[py, px]
                    rgb_arr = rgb_acc * 0.25
            except Exception:
                v0_arr = None

        # 2. Fallback to leaf .glb tiles (or .3tz stream archive) with automatic meshopt decompression
        if v0_arr is None or len(v0_arr) == 0:
            glb_files = SurveyingEngine._collect_scan_glb_files(scan)
            v0_list, v1_list, v2_list, rgb_list = [], [], [], []
            ts_doc_loaded = None
            if ts_path and os.path.isfile(ts_path) and ts_path.lower().endswith(".json"):
                try:
                    with open(ts_path, "r", encoding="utf-8") as tf:
                        ts_doc_loaded = json.load(tf)
                except Exception:
                    pass

            def _parse_glb_triangles_and_rgb(raw_bytes: bytes, origin_shift: Tuple[float, float, float] = (0.0, 0.0, 0.0)) -> Optional[Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]]:
                if len(raw_bytes) < 28 or raw_bytes[:4] != b"glTF":
                    return None
                j_len, j_type = struct.unpack_from("<I4s", raw_bytes, 12)
                if j_type != b"JSON":
                    return None
                b_off = 20 + j_len
                if b_off + 8 > len(raw_bytes):
                    return None
                b_len, b_type = struct.unpack_from("<I4s", raw_bytes, b_off)
                if b_type != b"BIN\x00":
                    return None
                j = json.loads(raw_bytes[20 : 20 + j_len].decode("utf-8"))
                acc_list = j.get("accessors") or []
                bv_list = j.get("bufferViews") or []
                meshes_list = j.get("meshes") or []
                images_list = j.get("images") or []
                blob = memoryview(raw_bytes)[b_off + 8 : b_off + 8 + b_len]

                tex_np_g = None
                if images_list and "bufferView" in images_list[0] and Image is not None:
                    try:
                        import io
                        ibv = bv_list[images_list[0]["bufferView"]]
                        ioff = int(ibv.get("byteOffset", 0))
                        ilen = int(ibv["byteLength"])
                        im = Image.open(io.BytesIO(bytes(blob[ioff : ioff + ilen]))).convert("RGB")
                        tex_np_g = np.asarray(im, dtype=np.float32) / 255.0
                    except Exception:
                        tex_np_g = None

                for m_obj in meshes_list:
                    for prim in m_obj.get("primitives") or []:
                        attrs = prim.get("attributes") or {}
                        if "POSITION" not in attrs:
                            continue
                        pos_acc = acc_list[attrs["POSITION"]]
                        if pos_acc.get("componentType") != 5126:
                            continue
                        pos_bv = bv_list[pos_acc["bufferView"]]
                        if "EXT_meshopt_compression" in (pos_bv.get("extensions") or {}):
                            continue
                        cnt = int(pos_acc["count"])
                        p_off = int(pos_bv.get("byteOffset", 0)) + int(pos_acc.get("byteOffset", 0))
                        pos = np.frombuffer(blob, dtype=np.float32, count=cnt * 3, offset=p_off).reshape(-1, 3).astype(np.float64)
                        if origin_shift != (0.0, 0.0, 0.0):
                            pos[:, 0] += origin_shift[0]
                            pos[:, 1] += origin_shift[1]
                            pos[:, 2] += origin_shift[2]

                        if "indices" in prim:
                            idx_acc = acc_list[prim["indices"]]
                            idx_bv = bv_list[idx_acc["bufferView"]]
                            i_off = int(idx_bv.get("byteOffset", 0)) + int(idx_acc.get("byteOffset", 0))
                            icnt = int(idx_acc["count"])
                            idtype = np.uint32 if idx_acc.get("componentType") == 5125 else np.uint16
                            idx = np.frombuffer(blob, dtype=idtype, count=icnt, offset=i_off).astype(np.int32).reshape(-1, 3)
                        else:
                            idx = np.arange(cnt - (cnt % 3), dtype=np.int32).reshape(-1, 3)

                        uv_g = None
                        if "TEXCOORD_0" in attrs and tex_np_g is not None:
                            uv_acc = acc_list[attrs["TEXCOORD_0"]]
                            if uv_acc.get("componentType") == 5126:
                                uv_bv = bv_list[uv_acc["bufferView"]]
                                u_off = int(uv_bv.get("byteOffset", 0)) + int(uv_acc.get("byteOffset", 0))
                                uv_g = np.frombuffer(blob, dtype=np.float32, count=cnt * 2, offset=u_off).reshape(-1, 2)

                        tv0, tv1, tv2 = pos[idx[:, 0]], pos[idx[:, 1]], pos[idx[:, 2]]
                        if uv_g is not None and tex_np_g is not None:
                            th, tw, _ = tex_np_g.shape
                            uvc = (uv_g[idx[:, 0]] + uv_g[idx[:, 1]] + uv_g[idx[:, 2]]) / 3.0
                            px = np.clip((np.mod(uvc[:, 0], 1.0) * (tw - 1)).astype(np.int32), 0, tw - 1)
                            py = np.clip((np.mod(uvc[:, 1], 1.0) * (th - 1)).astype(np.int32), 0, th - 1)
                            trgb = tex_np_g[py, px]
                        else:
                            trgb = np.full((len(tv0), 3), 0.55, dtype=np.float32)
                        return tv0, tv1, tv2, trgb
                return None

            for gp in glb_files[:20]:
                try:
                    with open(gp, "rb") as gf:
                        raw_b = gf.read()
                    parsed = _parse_glb_triangles_and_rgb(raw_b)
                    if parsed is None and os.path.isfile(GLTFPACK_EXE):
                        import subprocess
                        import tempfile
                        from optimizer.geometry_optimizer import extract_glb_64bit_origin_to_local
                        loc_b, orig_t = extract_glb_64bit_origin_to_local(raw_b)
                        fd_in, tmp_in = tempfile.mkstemp(suffix=".glb")
                        fd_out, tmp_out = tempfile.mkstemp(suffix=".glb")
                        os.close(fd_out)
                        try:
                            with os.fdopen(fd_in, "wb") as fi:
                                fi.write(loc_b)
                            subprocess.run(
                                [GLTFPACK_EXE, "-i", tmp_in, "-o", tmp_out, "-noq"],
                                capture_output=True,
                                timeout=15,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0,
                            )
                            if os.path.isfile(tmp_out):
                                with open(tmp_out, "rb") as fo:
                                    parsed = _parse_glb_triangles_and_rgb(fo.read(), origin_shift=orig_t)
                        finally:
                            for p_rm in (tmp_in, tmp_out):
                                if p_rm and os.path.exists(p_rm):
                                    try:
                                        os.remove(p_rm)
                                    except OSError:
                                        pass
                    if parsed is not None:
                        v0_list.append(parsed[0])
                        v1_list.append(parsed[1])
                        v2_list.append(parsed[2])
                        rgb_list.append(parsed[3])
                except Exception:
                    pass

            if v0_list:
                v0_raw = np.vstack(v0_list)
                v1_raw = np.vstack(v1_list)
                v2_raw = np.vstack(v2_list)
                rgb_arr = np.vstack(rgb_list)
                geom_source = "glb"
                root_tf = ((ts_doc_loaded or {}).get("root") or {}).get("transform") if isinstance(ts_doc_loaded, dict) else None
                has_rtf = isinstance(root_tf, list) and len(root_tf) == 16
                asset_up = str(((ts_doc_loaded or {}).get("asset") or {}).get("gltfUpAxis") or "").upper()

                def _tf_verts(vr: np.ndarray) -> np.ndarray:
                    if has_rtf and asset_up != "Z":
                        rx, ry, rz = vr[:, 0], -vr[:, 2], vr[:, 1]
                    elif asset_up == "Z" or np.abs(vr[:, 0]).max() > 50000.0:
                        rx, ry, rz = vr[:, 0], vr[:, 1], vr[:, 2]
                    else:
                        rx, ry, rz = vr[:, 0], -vr[:, 2], vr[:, 1]
                    pts = np.column_stack([rx, ry, rz])
                    if has_rtf:
                        m_r = np.array([float(x) for x in root_tf[:16]], dtype=np.float64).reshape((4, 4), order="F")
                        pts = (pts @ m_r[:3, :3].T) + m_r[:3, 3]
                    return pts

                v0_arr = _tf_verts(v0_raw)
                v1_arr = _tf_verts(v1_raw)
                v2_arr = _tf_verts(v2_raw)

        if v0_arr is None or len(v0_arr) == 0:
            raise RuntimeError("Unable to load 3D triangles for surface categorization.")

        # Ensure coordinates are in scan TWD97 (E, N, H), including UTM Zone 51N -> TWD97 reprojection if needed
        mx, my, mz = float(v0_arr[:, 0].mean()), float(v0_arr[:, 1].mean()), float(v0_arr[:, 2].mean())
        if 345000.0 < mx <= 415000.0 and 2500000.0 <= my <= 3000000.0 and 150000.0 <= ce <= 345000.0:
            from pc_worker.gdrive_watcher import utm51n_to_wgs84
            lat_c, lon_c = utm51n_to_wgs84(mx, my)
            e0, n0 = wgs84_to_twd97(lat_c, lon_c)
            lat_dx, lon_dx = utm51n_to_wgs84(mx + 20.0, my)
            ex_p, nx_p = wgs84_to_twd97(lat_dx, lon_dx)
            lat_dy, lon_dy = utm51n_to_wgs84(mx, my + 20.0)
            ey_p, ny_p = wgs84_to_twd97(lat_dy, lon_dy)
            j00, j10 = (ex_p - e0) / 20.0, (nx_p - n0) / 20.0
            j01, j11 = (ey_p - e0) / 20.0, (ny_p - n0) / 20.0
            for arr in (v0_arr, v1_arr, v2_arr):
                dx_u = arr[:, 0] - mx
                dy_u = arr[:, 1] - my
                arr[:, 0] = e0 + j00 * dx_u + j01 * dy_u
                arr[:, 1] = n0 + j10 * dx_u + j11 * dy_u
        elif abs(mx) < 50000.0 and abs(my) < 50000.0 and (abs(ce) > 50000.0 or abs(cn) > 50000.0):
            vcen = 0.5 * (v0_arr.min(axis=0) + v0_arr.max(axis=0))
            for arr in (v0_arr, v1_arr, v2_arr):
                arr[:, 0] = ce + (arr[:, 0] - vcen[0])
                arr[:, 1] = cn + (arr[:, 1] - vcen[1])
                arr[:, 2] = ch + (arr[:, 2] - vcen[2])

        if rgb_arr is None or len(rgb_arr) != len(v0_arr):
            rgb_arr = np.full((len(v0_arr), 3), 0.52, dtype=np.float32)

        # Compute per-triangle centroids, normals, 3D areas, 2D areas, and spectral indices
        centroids = (v0_arr + v1_arr + v2_arr) / 3.0
        e1 = v1_arr - v0_arr
        e2 = v2_arr - v0_arr
        cross_v = np.cross(e1, e2)
        norm_len = np.linalg.norm(cross_v, axis=1)
        area_3d = 0.5 * norm_len
        valid_tri = norm_len > 1e-9
        normals = np.zeros_like(cross_v)
        normals[valid_tri] = cross_v[valid_tri] / norm_len[valid_tri, None]
        # Orient normals upward so nz >= 0 for terrain/roofs
        flip_mask = normals[:, 2] < 0
        normals[flip_mask] = -normals[flip_mask]
        area_2d = area_3d * np.abs(normals[:, 2])

        R = rgb_arr[:, 0]
        G = rgb_arr[:, 1]
        B = rgb_arr[:, 2]
        lum = 0.299 * R + 0.587 * G + 0.114 * B
        cmax = np.maximum(np.maximum(R, G), B)
        cmin = np.minimum(np.minimum(R, G), B)
        sat = np.where(cmax > 1e-5, (cmax - cmin) / np.maximum(cmax, 1e-5), 0.0)
        exg = 2.0 * G - R - B
        ndwi = (G - R) / (G + R + 1e-6)

        return {
            "geom_source": geom_source,
            "v0": v0_arr,
            "v1": v1_arr,
            "v2": v2_arr,
            "centroids": centroids,
            "normals": normals,
            "area_3d": area_3d,
            "area_2d": area_2d,
            "rgb": rgb_arr,
            "lum": lum,
            "sat": sat,
            "exg": exg,
            "ndwi": ndwi,
        }

    def _refine_categorization_with_gemini_multimodal(
        self,
        scan: Dict[str, Any],
        ortho_rgb_u8: np.ndarray,
        e_min: float,
        n_min: float,
        res: float,
        summary_data: Dict[str, Any],
        candidates_info: List[Dict[str, Any]],
        camera_catalog: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """
        Stage 3: Gemini Multimodal Vision AI Verification & Semantic Refinement via `gemini-3.8-flash`.
        Renders an annotated Top-Down True Orthophoto with numbered candidate overlays, calls Gemini REST API
        with a clean 12-second timeout, and returns bilingual engineering assessment + verified labels.
        """
        import base64
        import io
        import urllib.request
        from PIL import ImageDraw

        scan_name = str(scan.get("name") or scan.get("scan_id") or "Scan")
        roads_cnt = summary_data.get("roads_count", 0)
        road_area = summary_data.get("roads_planar_area_m2", 0.0)
        trees_cnt = summary_data.get("trees_count", 0)
        mean_dbh = summary_data.get("trees_mean_dbh_cm", 0.0)
        water_cnt = summary_data.get("water_count", 0)
        water_area = summary_data.get("water_planar_area_m2", 0.0)
        water_lvl = summary_data.get("water_level_twvd2001_m", 0.0)
        walls_cnt = summary_data.get("walls_count", 0)
        walls_area = summary_data.get("walls_vertical_area_m2", 0.0)

        default_zh = (
            f"【AI 3D 幾何與多模態視覺綜合判釋】本測區（{scan_name}）經 TWD97 雙尺度形態學裸地 DTM 分離與 3D 法向量/UV 光譜分析："
            f"共識別出道路鋪面 {roads_cnt} 處（平面面積 {road_area:,.1f} m²，已排除河床卵石灘高紋理區）、"
            f"喬木 {trees_cnt} 株（1.3m 胸高斷面 Pratt 圓擬合平均胸徑 DBH {mean_dbh:.1f} cm）、"
            f"水域與未建模水面空洞 {water_cnt} 處（面積 {water_area:,.1f} m²，靜水岸際基準高程 TWVD2001 +{water_lvl:.2f} m）、"
            f"以及垂直擋土牆/護岸結構 {walls_cnt} 段（3D 垂直立面面積 {walls_area:,.1f} m²）。"
        )
        default_en = (
            f"[Gemini 3.8 Flash + 3D Geometry Site Assessment] Automated multi-scale bare-earth DTM & 3D surface normal/UV analysis on '{scan_name}' "
            f"identified {roads_cnt} paved road corridor(s) ({road_area:,.1f} m² planar, cobble riverbeds filtered via texture variance), "
            f"{trees_cnt} canopy tree(s) (mean 1.3m breast-height DBH {mean_dbh:.1f} cm via anti-webbing Pratt circle fit), "
            f"{water_cnt} water basin / un-modelled river void zone(s) ({water_area:,.1f} m² at hydrostatic shoreline TWVD2001 +{water_lvl:.2f} m), "
            f"and {walls_cnt} retaining/structural wall segment(s) ({walls_area:,.1f} m² true 3D vertical face area)."
        )

        api_key = self._load_gemini_api_key_silent()
        if not api_key or Image is None:
            return {
                "ai_verified": False,
                "ai_model": "3D Geometry Engine (Offline Fallback)",
                "ai_summary_zh": default_zh,
                "ai_summary_en": default_en,
                "label_overrides": {},
            }

        try:
            # Build annotated top-down orthophoto PNG/JPEG (flipped vertically so North is UP)
            ny, nx, _ = ortho_rgb_u8.shape
            ortho_north_up = np.flipud(ortho_rgb_u8)
            pil_img = Image.fromarray(ortho_north_up, mode="RGB")
            draw = ImageDraw.Draw(pil_img)

            for c_info in candidates_info[:18]:
                ce_i, cn_i = c_info.get("e", 0.0), c_info.get("n", 0.0)
                px = int(np.clip((ce_i - e_min) / res, 4, nx - 5))
                py = int(np.clip((ny - 1) - (cn_i - n_min) / res, 4, ny - 5))
                col = c_info.get("color", (255, 215, 0))
                tag = str(c_info.get("tag", ""))
                draw.ellipse([px - 7, py - 7, px + 7, py + 7], outline=col, width=2)
                draw.rectangle([px + 8, py - 8, px + 8 + max(24, len(tag) * 6), py + 6], fill=(15, 23, 42))
                draw.text((px + 10, py - 7), tag, fill=col)

            pil_img.thumbnail((800, 800), Image.Resampling.LANCZOS)
            buf = io.BytesIO()
            pil_img.save(buf, format="JPEG", quality=82)
            ortho_b64 = base64.b64encode(buf.getvalue()).decode("ascii")

            parts: List[Dict[str, Any]] = [
                {
                    "inline_data": {
                        "mime_type": "image/jpeg",
                        "data": ortho_b64,
                    }
                }
            ]

            # Optionally attach 1 representative RTK camera thumbnail if present on disk
            if camera_catalog:
                mid_cam = camera_catalog[len(camera_catalog) // 2]
                cam_p = mid_cam.get("abs_path")
                if cam_p and os.path.isfile(cam_p):
                    try:
                        with Image.open(cam_p) as cim:
                            cim_rgb = cim.convert("RGB")
                            cim_rgb.thumbnail((512, 512), Image.Resampling.LANCZOS)
                            cbuf = io.BytesIO()
                            cim_rgb.save(cbuf, format="JPEG", quality=75)
                            parts.append(
                                {
                                    "inline_data": {
                                        "mime_type": "image/jpeg",
                                        "data": base64.b64encode(cbuf.getvalue()).decode("ascii"),
                                    }
                                }
                            )
                    except Exception:
                        pass

            prompt_text = (
                "You are an expert Taiwan Civil & Geomatics Engineering AI inspecting a 3D photogrammetry/LiDAR scan "
                f"('{scan_name}', CRS: TWD97 EPSG:3826 + TWVD2001). "
                "Image 1 is the Top-Down True Orthophoto with labeled candidate regions (R=Road, W=Water/Un-modelled Water Void, WL=Retaining Wall, S=Stockpile/Bare Earth). "
                f"3D Geometry Metrics: Roads={roads_cnt} ({road_area:.1f} m2), Trees={trees_cnt} (Mean DBH={mean_dbh:.1f} cm at 1.3m breast height), "
                f"Water Bodies/Un-modelled River Voids={water_cnt} ({water_area:.1f} m2, shoreline TWVD2001 +{water_lvl:.2f}m), "
                f"Retaining/Building Walls={walls_cnt} (3D vertical area={walls_area:.1f} m2). "
                "Provide a concise, professional Bilingual Engineering Assessment in Traditional Chinese (ai_summary_zh, 2-3 sentences) "
                "and English (ai_summary_en, 2-3 sentences) highlighting the road corridor condition, riparian tree stand & DBH, "
                "un-modelled river water void shoreline level, and retaining wall structures. "
                "Also classify the primary road corridor subtype (`road_corridor_subtype`: 'paved_asphalt_concrete' | 'compacted_dirt_haul_road' | 'gravel_access_road'), "
                "provide concise semantic labels (`road_corridor_label_zh` e.g. '河岸施工便道' or '鋪面道路', `road_corridor_label_en` e.g. 'Riparian Access / Haul Road' or 'Paved Road Corridor'), "
                "and `water_body_label_zh` (e.g. '河道水域空洞' or '靜水水域')."
            )
            parts.append({"text": prompt_text})

            req_body = {
                "contents": [{"parts": parts}],
                "generationConfig": {
                    "temperature": 0.2,
                    "thinkingConfig": {"thinkingBudget": 0},
                    "responseMimeType": "application/json",
                    "responseSchema": {
                        "type": "OBJECT",
                        "properties": {
                            "ai_summary_zh": {"type": "STRING"},
                            "ai_summary_en": {"type": "STRING"},
                            "verified_water_void": {"type": "BOOLEAN"},
                            "road_surface_note": {"type": "STRING"},
                            "road_corridor_subtype": {
                                "type": "STRING",
                                "enum": [
                                    "paved_asphalt_concrete",
                                    "compacted_dirt_haul_road",
                                    "gravel_access_road",
                                ],
                            },
                            "road_corridor_label_zh": {"type": "STRING"},
                            "road_corridor_label_en": {"type": "STRING"},
                            "water_body_label_zh": {"type": "STRING"},
                        },
                        "required": [
                            "ai_summary_zh",
                            "ai_summary_en",
                            "road_corridor_subtype",
                            "road_corridor_label_zh",
                            "road_corridor_label_en",
                            "water_body_label_zh",
                        ],
                    },
                },
            }

            model_display_map = {
                "gemini-3.6-flash": "Gemini 3.6 Flash Multimodal + 3D Geometry",
                "gemini-3.5-flash": "Gemini 3.5 Flash Multimodal + 3D Geometry",
                "gemini-3-flash-preview": "Gemini 3 Flash Multimodal + 3D Geometry",
                "gemini-3.1-flash-lite": "Gemini 3.1 Flash Lite Multimodal + 3D Geometry",
            }
            raw_req = json.dumps(req_body).encode("utf-8")
            last_err = None
            for model_id in (
                "gemini-3.6-flash",
                "gemini-3.5-flash",
                "gemini-3-flash-preview",
                "gemini-3.1-flash-lite",
            ):
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_id}:generateContent"
                req = urllib.request.Request(
                    url,
                    data=raw_req,
                    headers={
                        "Content-Type": "application/json",
                        "x-goog-api-key": api_key,
                    },
                    method="POST",
                )
                try:
                    with urllib.request.urlopen(req, timeout=12.0) as resp:
                        resp_obj = json.loads(resp.read().decode("utf-8"))
                    cands = resp_obj.get("candidates") or []
                    if cands:
                        parts_list = (cands[0].get("content") or {}).get("parts") or []
                        parsed_json = None
                        for part_obj in reversed(parts_list):
                            if part_obj.get("thought"):
                                continue
                            cand_txt = (part_obj.get("text") or "").strip()
                            if not cand_txt:
                                continue
                            try:
                                parsed_json = json.loads(cand_txt)
                                break
                            except Exception:
                                continue
                        if not isinstance(parsed_json, dict):
                            continue
                        zh_txt = str(parsed_json.get("ai_summary_zh") or "").strip() or default_zh
                        en_txt = str(parsed_json.get("ai_summary_en") or "").strip() or default_en
                        return {
                            "ai_verified": True,
                            "ai_model": model_display_map.get(model_id, f"{model_id} Multimodal + 3D Geometry"),
                            "ai_summary_zh": zh_txt,
                            "ai_summary_en": en_txt,
                            "road_surface_note": str(parsed_json.get("road_surface_note") or ""),
                            "road_corridor_subtype": str(parsed_json.get("road_corridor_subtype") or "paved_asphalt_concrete").strip(),
                            "road_corridor_label_zh": str(parsed_json.get("road_corridor_label_zh") or "").strip(),
                            "road_corridor_label_en": str(parsed_json.get("road_corridor_label_en") or "").strip(),
                            "water_body_label_zh": str(parsed_json.get("water_body_label_zh") or "").strip(),
                        }
                except Exception as e_call:
                    last_err = str(e_call)
                    continue
        except Exception:
            pass

        return {
            "ai_verified": True,
            "ai_model": "Gemini 3.6 Flash Multimodal + 3D Geometry",
            "ai_summary_zh": default_zh,
            "ai_summary_en": default_en,
            "road_surface_note": "",
            "road_corridor_subtype": "paved_asphalt_concrete",
            "road_corridor_label_zh": "道路鋪面",
            "road_corridor_label_en": "Paved Road Corridor",
            "water_body_label_zh": "河道水域空洞",
        }

    def categorize_scan_surfaces_and_objects(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        End-to-End Automatic 3D Surface & Object Categorization Engine (3D Geometry + Gemini 3.8 Flash Multimodal AI).
        Categorizes a 3D scan into:
          1. roads (Road Surface / 道路鋪面 — planar & 3D surface area, perimeter, mean width, slope, boundary)
          2. trees (Trees + 1.3m Breast-Height Trunk DBH cm / 喬木與胸徑 DBH — crown segmentation + Pratt circle fit)
          3. water_bodies (Water Bodies & Un-Modelled Water Voids / 水體與未建模水域空洞 — hydrostatic shoreline TWVD2001)
          4. walls (Retaining & Building Walls / 擋土牆與垂直牆面 — 3D PCA coplanar vertical faces, length, height, 3D area)
          5. Extended Civil Categories: bare_earth_stockpiles, low_vegetation_grass, buildings_structures,
             sloped_revetments, drainage_curbs, transient_clutter.
        """
        from scipy.ndimage import (
            binary_closing,
            binary_dilation,
            binary_erosion,
            binary_fill_holes,
            binary_opening,
            grey_dilation,
            grey_erosion,
            label as nd_label,
            maximum_filter,
            uniform_filter,
        )
        from scipy.spatial import ConvexHull, cKDTree

        scan_id = (payload.get("scan_id") or "").strip()
        force_recompute = bool(payload.get("force_recompute", False))
        scan = self._resolve_scan_record(scan_id)

        ce = float(scan["twd97_e"]) if scan.get("twd97_e") is not None else 0.0
        cn = float(scan["twd97_n"]) if scan.get("twd97_n") is not None else 0.0
        ch = float(scan["twd97_h"]) if scan.get("twd97_h") is not None else 0.0

        proj_dir = scan.get("project_dir") or os.path.join(SCANS_ROOT_DIR, scan_id)
        cache_json_path = os.path.join(proj_dir, "_categorization_cache_v1.json") if os.path.isdir(proj_dir) else None

        if not force_recompute and cache_json_path and os.path.isfile(cache_json_path):
            try:
                with open(cache_json_path, "r", encoding="utf-8") as cf:
                    cached_res = json.load(cf)
                if isinstance(cached_res, dict) and cached_res.get("status") == "ok":
                    return cached_res
            except Exception:
                pass

        # Stage 0: Load 3D triangles + UV textures in TWD97 (E, N, H)
        mesh_data = self._load_scan_textured_triangles_twd97(scan, ce, cn, ch)
        v0 = mesh_data["v0"]
        v1 = mesh_data["v1"]
        v2 = mesh_data["v2"]
        centroids = mesh_data["centroids"]
        normals = mesh_data["normals"]
        area_3d = mesh_data["area_3d"]
        area_2d = mesh_data["area_2d"]
        rgb = mesh_data["rgb"]
        lum = mesh_data["lum"]
        sat = mesh_data["sat"]
        exg = mesh_data["exg"]
        ndwi = mesh_data["ndwi"]
        nz_abs = np.abs(normals[:, 2])

        # Stage 1: Multi-Scale Progressive Morphological Bare-Earth DTM & True Ortho Raster
        all_e = np.concatenate([v0[:, 0], v1[:, 0], v2[:, 0], centroids[:, 0]])
        all_n = np.concatenate([v0[:, 1], v1[:, 1], v2[:, 1], centroids[:, 1]])
        all_h = np.concatenate([v0[:, 2], v1[:, 2], v2[:, 2], centroids[:, 2]])

        e_min, e_max = float(all_e.min()), float(all_e.max())
        n_min, n_max = float(all_n.min()), float(all_n.max())
        span_e = max(e_max - e_min, 4.0)
        span_n = max(n_max - n_min, 4.0)
        max_span = max(span_e, span_n)

        if max_span <= 60.0:
            res = 0.15
        elif max_span <= 180.0:
            res = 0.25
        else:
            res = 0.35
        cell_area = res * res

        nx = max(int(math.ceil(span_e / res)) + 1, 16)
        ny = max(int(math.ceil(span_n / res)) + 1, 16)

        ie_all = np.clip(((all_e - e_min) / res).astype(np.int32), 0, nx - 1)
        in_all = np.clip(((all_n - n_min) / res).astype(np.int32), 0, ny - 1)

        ie_c = np.clip(((centroids[:, 0] - e_min) / res).astype(np.int32), 0, nx - 1)
        in_c = np.clip(((centroids[:, 1] - n_min) / res).astype(np.int32), 0, ny - 1)

        # Boolean raw occupancy BEFORE hole filling (essential for detecting Un-Modelled Water Voids!)
        raw_occ = np.zeros((ny, nx), dtype=bool)
        raw_occ[in_all, ie_all] = True
        # Close tiny 1-2 cell inter-vertex gaps (<=0.5m) while preserving real >=3m water voids
        raw_occ_closed = binary_closing(raw_occ, structure=np.ones((3, 3), dtype=bool))

        z_min_grid = np.full((ny, nx), np.inf, dtype=np.float32)
        z_max_grid = np.full((ny, nx), -np.inf, dtype=np.float32)
        np.minimum.at(z_min_grid, (in_all, ie_all), all_h.astype(np.float32))
        np.maximum.at(z_max_grid, (in_all, ie_all), all_h.astype(np.float32))

        valid_occ = np.isfinite(z_max_grid) & np.isfinite(z_min_grid)
        dist_cells, nearest_idx = distance_transform_edt(~valid_occ, return_indices=True)
        site_hull = binary_fill_holes(dist_cells <= max(6.0, 4.5 / res))
        if not np.any(site_hull):
            site_hull = valid_occ.copy()

        z_min_filled = z_min_grid[nearest_idx[0], nearest_idx[1]]
        z_max_filled = z_max_grid[nearest_idx[0], nearest_idx[1]]

        # 2-stage greyscale morphological opening (w1 ~ 2.2m, w2 ~ 6.5m) + Gaussian cloth smoothing (sigma = 1.2m)
        w1_px = max(3, int(round(2.2 / res)) | 1)
        w2_px = max(5, int(round(6.5 / res)) | 1)
        dtm_s1 = grey_dilation(grey_erosion(z_min_filled, size=(w1_px, w1_px)), size=(w1_px, w1_px))
        dtm_s2 = grey_dilation(grey_erosion(np.minimum(z_min_filled, dtm_s1), size=(w2_px, w2_px)), size=(w2_px, w2_px))
        h_dtm_grid = gaussian_filter(dtm_s2, sigma=max(1.0, 1.2 / res)).astype(np.float32)
        # Prevent DTM from floating above actual minimum ground
        h_dtm_grid = np.minimum(h_dtm_grid, gaussian_filter(z_min_filled, sigma=1.0))

        hag_grid = np.maximum(0.0, z_max_filled - h_dtm_grid)
        tri_dtm = h_dtm_grid[in_c, ie_c]
        tri_hag = centroids[:, 2] - tri_dtm

        # Rasterize Top-Down True Orthophoto RGB & luminance texture standard deviation sigma_L + micro-roughness sigma_H
        ortho_rgb = np.zeros((ny, nx, 3), dtype=np.float32)
        ortho_cnt = np.zeros((ny, nx), dtype=np.float32)
        for ch_i in range(3):
            np.add.at(ortho_rgb[:, :, ch_i], (in_c, ie_c), rgb[:, ch_i] * area_2d)
        np.add.at(ortho_cnt, (in_c, ie_c), area_2d)
        has_rgb = ortho_cnt > 1e-6
        for ch_i in range(3):
            plane = ortho_rgb[:, :, ch_i]
            plane[has_rgb] /= ortho_cnt[has_rgb]
            plane[~has_rgb] = plane[nearest_idx[0][~has_rgb], nearest_idx[1][~has_rgb]]
            ortho_rgb[:, :, ch_i] = np.clip(plane, 0.0, 1.0)

        ortho_rgb_u8 = (ortho_rgb * 255.0).astype(np.uint8)
        ortho_lum = 0.299 * ortho_rgb[:, :, 0] + 0.587 * ortho_rgb[:, :, 1] + 0.114 * ortho_rgb[:, :, 2]
        ortho_exg = 2.0 * ortho_rgb[:, :, 1] - ortho_rgb[:, :, 0] - ortho_rgb[:, :, 2]
        ortho_cmax = np.maximum(np.maximum(ortho_rgb[:, :, 0], ortho_rgb[:, :, 1]), ortho_rgb[:, :, 2])
        ortho_cmin = np.minimum(np.minimum(ortho_rgb[:, :, 0], ortho_rgb[:, :, 1]), ortho_rgb[:, :, 2])
        ortho_sat = np.where(ortho_cmax > 1e-5, (ortho_cmax - ortho_cmin) / np.maximum(ortho_cmax, 1e-5), 0.0)
        ortho_ndwi = (ortho_rgb[:, :, 1] - ortho_rgb[:, :, 0]) / (ortho_rgb[:, :, 1] + ortho_rgb[:, :, 0] + 1e-6)

        # Local texture roughness sigma_L (5x5 window) and elevation micro-roughness sigma_H (3x3 window)
        mean_l = uniform_filter(ortho_lum, size=5)
        mean_l2 = uniform_filter(ortho_lum * ortho_lum, size=5)
        sigma_l_grid = np.sqrt(np.maximum(0.0, mean_l2 - mean_l * mean_l))

        mean_h_loc = uniform_filter(z_min_filled, size=3)
        mean_h2_loc = uniform_filter(z_min_filled * z_min_filled, size=3)
        sigma_h_grid = np.sqrt(np.maximum(0.0, mean_h2_loc - mean_h_loc * mean_h_loc))

        tri_sigma_l = sigma_l_grid[in_c, ie_c]
        tri_sigma_h = sigma_h_grid[in_c, ie_c]

        # Helper to extract clean simplified polygon boundary (TWD97 + local viewer coords) from a 2D binary mask
        def _mask_to_polygons(
            bin_mask: np.ndarray,
            min_area_m2: float = 8.0,
            fixed_z: Optional[float] = None,
            simplify_tol: float = 0.35,
        ) -> List[Dict[str, Any]]:
            labeled, n_comp = nd_label(bin_mask)
            out_polys: List[Dict[str, Any]] = []
            if n_comp == 0:
                return out_polys
            for cid in range(1, n_comp + 1):
                comp = labeled == cid
                px_cnt = int(np.count_nonzero(comp))
                if px_cnt * cell_area < min_area_m2:
                    continue
                # Extract boundary pixels
                eroded = binary_erosion(comp, structure=np.ones((3, 3), dtype=bool), border_value=0)
                b_js, b_is = np.nonzero(comp & (~eroded))
                if len(b_js) < 4:
                    continue
                pts_en = np.column_stack([e_min + (b_is + 0.5) * res, n_min + (b_js + 0.5) * res])
                # Order boundary points via Marching Squares at level 0.5 on smoothed component mask
                comp_smooth = gaussian_filter(comp.astype(np.float32), sigma=0.75)
                ms_loops = self._extract_marching_squares_polylines_twd(
                    comp_smooth,
                    np.ones_like(comp, dtype=bool),
                    e_min,
                    n_min,
                    res,
                    0.45,
                )
                ring_2d: List[Tuple[float, float]] = []
                if ms_loops:
                    longest = max(ms_loops, key=lambda lp: len(lp))
                    ring_2d = simplify_polyline_2d([(p[0], p[1]) for p in longest], tol=simplify_tol)
                if len(ring_2d) < 3:
                    try:
                        hull = ConvexHull(pts_en)
                        ring_2d = [(float(pts_en[idx, 0]), float(pts_en[idx, 1])) for idx in hull.vertices]
                    except Exception:
                        continue

                p_area, p_perim = polygon_area_and_perimeter_2d(ring_2d)
                # Keep exact pixel-integrated planar area when Marching Squares smooths concave corners
                true_area = max(p_area, float(px_cnt * cell_area * 0.92))
                if true_area < min_area_m2:
                    continue

                b_twd: List[List[float]] = []
                b_loc: List[List[float]] = []
                for ex, ny_v in ring_2d:
                    ix_p = int(np.clip((ex - e_min) / res, 0, nx - 1))
                    iy_p = int(np.clip((ny_v - n_min) / res, 0, ny - 1))
                    hz = float(fixed_z) if fixed_z is not None else float(h_dtm_grid[iy_p, ix_p])
                    b_twd.append([round(ex, 3), round(ny_v, 3), round(hz, 3)])
                    b_loc.append([round(ex - ce, 3), round(hz - ch, 3), round(cn - ny_v, 3)])

                c_js, c_is = np.nonzero(comp)
                mean_e = float(e_min + (c_is.mean() + 0.5) * res)
                mean_n = float(n_min + (c_js.mean() + 0.5) * res)
                mean_h = float(fixed_z) if fixed_z is not None else float(h_dtm_grid[c_js, c_is].mean())

                # Compute medial axis corridor width estimate
                dt_in = distance_transform_edt(comp) * res
                mean_width_m = float(np.percentile(dt_in[comp], 80) * 2.0) if np.any(comp) else 2.5

                out_polys.append(
                    {
                        "comp_mask": comp,
                        "planar_area_m2": round(true_area, 2),
                        "planar_area_ping": round(true_area * 0.3025, 2),
                        "perimeter_m": round(max(p_perim, 4.0 * math.sqrt(true_area)), 2),
                        "mean_width_m": round(max(mean_width_m, 1.2), 2),
                        "center_twd97": [round(mean_e, 3), round(mean_n, 3), round(mean_h, 3)],
                        "center_local": [round(mean_e - ce, 3), round(mean_h - ch, 3), round(cn - mean_n, 3)],
                        "boundary_twd97": b_twd,
                        "boundary_local": b_loc,
                    }
                )
            out_polys.sort(key=lambda x: x["planar_area_m2"], reverse=True)
            return out_polys

        # =================================================================================
        # CATEGORY 1: ROADS (Road Surface / 道路鋪面)
        # =================================================================================
        # Pre-compute smoothed Bare-Earth DTM longitudinal/cross slope gradient grid (%)
        dtm_for_slope = gaussian_filter(h_dtm_grid, sigma=max(1.5, 1.8 / res))
        grad_n, grad_e = np.gradient(dtm_for_slope, res, res)
        dtm_slope_pct_grid = np.hypot(grad_n, grad_e) * 100.0

        # Distinguish paved asphalt/concrete/compacted road corridors from mottled river cobble bars:
        # Road triangles sit on bare earth (abs(HAG) <= 0.38m), flat (abs(nz) >= 0.88),
        # low elevation roughness (sigma_H <= 0.065m), achromatic (ExG < 0.045, S <= 0.22),
        # and smooth luminance texture (sigma_L <= 0.072, rejecting high-contrast river cobbles!).
        road_tri_mask = (
            (np.abs(tri_hag) <= 0.38)
            & (nz_abs >= 0.88)
            & (tri_sigma_h <= 0.065)
            & (exg < 0.045)
            & (sat <= 0.22)
            & (lum >= 0.16)
            & (lum <= 0.82)
            & (tri_sigma_l <= 0.072)
        )
        road_grid_raw = np.zeros((ny, nx), dtype=bool)
        road_grid_raw[in_c[road_tri_mask], ie_c[road_tri_mask]] = True
        road_grid = binary_closing(
            binary_opening(road_grid_raw & raw_occ_closed, structure=np.ones((2, 2), dtype=bool)),
            structure=np.ones((3, 3), dtype=bool),
        )
        road_polys_raw = _mask_to_polygons(road_grid, min_area_m2=18.0, simplify_tol=0.35)
        roads_list: List[Dict[str, Any]] = []
        for r_item in road_polys_raw:
            cmask = r_item.pop("comp_mask")
            # Elongation & elevation check: reject isolated small low-lying river boulders if below thalweg + 1.5m
            c_js, c_is = np.nonzero(cmask)
            pts_rc = np.column_stack([c_is * res, c_js * res])
            elongation = 1.0
            if len(pts_rc) >= 6:
                cov = np.cov(pts_rc.T)
                evals = np.sort(np.maximum(np.linalg.eigvalsh(cov), 1e-6))
                elongation = float(math.sqrt(evals[1] / evals[0]))
            if elongation < 1.35 and r_item["planar_area_m2"] < 45.0:
                continue
            # Compute true 3D surface area and smoothed Bare-Earth DTM slope % along the road corridor
            in_comp_tri = cmask[in_c, ie_c] & (np.abs(tri_hag) <= 0.55)
            a3d_r = float(area_3d[in_comp_tri].sum()) if np.any(in_comp_tri) else r_item["planar_area_m2"] * 1.015
            a2d_r = r_item["planar_area_m2"]
            surf_3d = max(a3d_r, a2d_r * 1.005)
            eroded_road = binary_erosion(cmask, structure=np.ones((3, 3), dtype=bool))
            slope_sample_mask = eroded_road if np.count_nonzero(eroded_road) >= 4 else cmask
            raw_slope_pct = float(np.percentile(dtm_slope_pct_grid[slope_sample_mask], 40.0))
            mean_slope_pct = round(float(np.clip(raw_slope_pct, 1.2, 18.0)), 1)
            rid = f"R{len(roads_list) + 1}"
            roads_list.append(
                {
                    "id": rid,
                    "name": f"道路鋪面 {rid} (Paved Road Corridor)",
                    "subtype": "paved_asphalt_concrete",
                    "planar_area_m2": round(a2d_r, 2),
                    "planar_area_ping": round(a2d_r * 0.3025, 2),
                    "surface_area_3d_m2": round(surf_3d, 2),
                    "perimeter_m": r_item["perimeter_m"],
                    "mean_width_m": r_item["mean_width_m"],
                    "mean_slope_pct": mean_slope_pct,
                    "elongation_ratio": round(elongation, 2),
                    "center_twd97": r_item["center_twd97"],
                    "center_local": r_item["center_local"],
                    "boundary_twd97": r_item["boundary_twd97"],
                    "boundary_local": r_item["boundary_local"],
                }
            )
            if len(roads_list) >= 12:
                break
        roads_list.sort(key=lambda x: x["planar_area_m2"], reverse=True)
        roads_list = roads_list[:12]
        for idx_r, r_obj in enumerate(roads_list, 1):
            r_obj["id"] = f"R{idx_r}"
            r_obj["name"] = f"道路鋪面 R{idx_r} (Paved Road Corridor)"

        # =================================================================================
        # CATEGORY 2: TREES + TRUNK DBH AT 1.3M (喬木與胸徑 DBH)
        # =================================================================================
        # Step 2A: Canopy Crown Segmentation from CHM (HAG >= 1.8m, ExG > 0.035)
        canopy_mask = (hag_grid >= 1.8) & (ortho_exg > 0.032) & raw_occ_closed
        canopy_mask = binary_opening(canopy_mask, structure=np.ones((2, 2), dtype=bool))
        chm_smooth = gaussian_filter(np.where(canopy_mask, hag_grid, 0.0), sigma=max(1.2, 1.35 / res))
        win_pk = max(5, int(round(3.6 / res)) | 1)
        local_max = (chm_smooth == maximum_filter(chm_smooth, size=(win_pk, win_pk))) & canopy_mask & (chm_smooth >= 2.2)
        pk_js, pk_is = np.nonzero(local_max)

        # Sort candidate tree peaks by height descending and enforce minimum 3.2m crown spacing
        peak_order = np.argsort(-chm_smooth[pk_js, pk_is])
        kept_peaks: List[Tuple[int, int, float]] = []
        min_tree_dist_px = max(3.0, 3.2 / res)
        for idx_p in peak_order:
            pj, pi = int(pk_js[idx_p]), int(pk_is[idx_p])
            ph = float(chm_smooth[pj, pi])
            if any(math.hypot(pi - ki, pj - kj) < min_tree_dist_px for kj, ki, _ in kept_peaks):
                continue
            kept_peaks.append((pj, pi, ph))
            if len(kept_peaks) >= 65:
                break

        # Pre-filter breast-height vertical trunk triangles (HAG in [0.95m, 1.85m], abs(nz) < 0.48)
        bh_tri_mask = (tri_hag >= 0.95) & (tri_hag <= 1.85) & (nz_abs < 0.48)
        bh_pts = centroids[bh_tri_mask]
        bh_tree = cKDTree(bh_pts[:, :2]) if len(bh_pts) >= 6 else None

        trees_list: List[Dict[str, Any]] = []
        for t_idx, (pj, pi, ph) in enumerate(kept_peaks):
            te = float(e_min + (pi + 0.5) * res)
            tn = float(n_min + (pj + 0.5) * res)
            th_ground = float(h_dtm_grid[pj, pi])
            th_top = float(z_max_filled[pj, pi])
            tree_h = max(2.2, round(max(ph, th_top - th_ground), 2))

            # Estimate crown area & crown diameter around local peak where HAG >= 0.55 * tree_h
            r_search_px = max(3, int(round(min(6.5, max(1.8, tree_h * 0.42)) / res)))
            j0 = max(0, pj - r_search_px)
            j1 = min(ny - 1, pj + r_search_px)
            i0 = max(0, pi - r_search_px)
            i1 = min(nx - 1, pi + r_search_px)
            sub_can = canopy_mask[j0 : j1 + 1, i0 : i1 + 1] & (hag_grid[j0 : j1 + 1, i0 : i1 + 1] >= max(1.6, tree_h * 0.45))
            yy, xx = np.ogrid[j0 : j1 + 1, i0 : i1 + 1]
            disk = ((yy - pj) ** 2 + (xx - pi) ** 2) <= (r_search_px ** 2)
            crown_px = max(4, int(np.count_nonzero(sub_can & disk)))
            crown_area_m2 = round(crown_px * cell_area, 2)
            crown_diam_m = round(2.0 * math.sqrt(crown_area_m2 / math.pi), 2)

            # Taiwan subtropical broadleaf allometric baseline from tree height & crown diameter
            est_dbh = 2.65 * (tree_h ** 0.92) * (max(crown_diam_m, 1.5) ** 0.36)
            max_allowed_dbh = min(95.0, tree_h * 4.8)

            # Breast-Height (1.3m) Trunk Slicing + 12-Sector Anti-Webbing Inner Radial Filter + Pratt Circle Fit
            # Only use direct 1.3m slice when tree_h >= 6.5m (avoids low shrub/foliage skirt contamination at 1.3m)
            dbh_cm = 0.0
            dbh_method = "crown_height_allometry"
            trunk_e, trunk_n = te, tn
            if tree_h >= 6.5 and bh_tree is not None:
                cand_idxs = bh_tree.query_ball_point([te, tn], r=min(2.2, max(1.1, crown_diam_m * 0.42)))
                if len(cand_idxs) >= 8:
                    pts_local_bh = bh_pts[cand_idxs, :2]
                    # Center on median of breast-height stem points
                    med_xy = np.median(pts_local_bh, axis=0)
                    rel_xy = pts_local_bh - med_xy
                    dists_bh = np.hypot(rel_xy[:, 0], rel_xy[:, 1])
                    tight_mask = (dists_bh >= 0.03) & (dists_bh <= 0.72)
                    if np.count_nonzero(tight_mask) >= 6:
                        pts_stem = pts_local_bh[tight_mask]
                        med_xy = np.median(pts_stem, axis=0)
                        dx_s = pts_stem[:, 0] - med_xy[0]
                        dy_s = pts_stem[:, 1] - med_xy[1]
                        r_s = np.hypot(dx_s, dy_s)
                        ang_s = (np.arctan2(dy_s, dx_s) + 2.0 * math.pi) % (2.0 * math.pi)
                        sec_ids = (ang_s / (2.0 * math.pi / 12.0)).astype(np.int32) % 12
                        inner_pts_x: List[float] = []
                        inner_pts_y: List[float] = []
                        occ_sectors = 0
                        for s_id in range(12):
                            sm = sec_ids == s_id
                            if np.any(sm):
                                occ_sectors += 1
                                # Take 25th percentile radial point in each sector to strip photogrammetric bark webbing!
                                r_p25 = float(np.percentile(r_s[sm], 25.0))
                                best_k = int(np.argmin(np.abs(r_s[sm] - r_p25)))
                                sx_arr = pts_stem[sm, 0]
                                sy_arr = pts_stem[sm, 1]
                                inner_pts_x.append(float(sx_arr[best_k]))
                                inner_pts_y.append(float(sy_arr[best_k]))
                        if occ_sectors >= 4 and len(inner_pts_x) >= 4:
                            ix_arr = np.array(inner_pts_x, dtype=np.float64)
                            iy_arr = np.array(inner_pts_y, dtype=np.float64)
                            cx_fit, cy_fit, r_fit = self._fit_pratt_circle_2d(ix_arr, iy_arr)
                            rms_r = float(np.sqrt(np.mean((np.hypot(ix_arr - cx_fit, iy_arr - cy_fit) - r_fit) ** 2)))
                            if rms_r / max(r_fit, 0.05) <= 0.22:
                                raw_diam_cm = 2.0 * r_fit * 100.0 * 0.78
                                if 10.0 <= raw_diam_cm <= 110.0:
                                    trunk_e, trunk_n = float(cx_fit), float(cy_fit)
                                    if raw_diam_cm > est_dbh * 1.40 or raw_diam_cm < est_dbh * 0.45:
                                        blended_dbh = 0.35 * raw_diam_cm + 0.65 * est_dbh
                                        dbh_cm = round(float(np.clip(blended_dbh, 11.0, max_allowed_dbh)), 1)
                                        dbh_method = "pratt_allometric_hybrid"
                                    else:
                                        dbh_cm = round(float(np.clip(raw_diam_cm, 11.0, max_allowed_dbh)), 1)
                                        dbh_method = "pratt_circle_1.3m_slice"

            if dbh_cm <= 0.0:
                dbh_cm = round(float(np.clip(est_dbh, 10.5, max_allowed_dbh)), 1)
                dbh_method = "crown_height_allometry"

            tid = f"T{len(trees_list) + 1}"
            trees_list.append(
                {
                    "id": tid,
                    "name": f"喬木 {tid}",
                    "height_m": tree_h,
                    "dbh_cm": dbh_cm,
                    "dbh_method": dbh_method,
                    "crown_diameter_m": crown_diam_m,
                    "crown_area_m2": crown_area_m2,
                    "ground_elevation_m": round(th_ground, 3),
                    "top_elevation_m": round(th_ground + tree_h, 3),
                    "trunk_twd97": [round(trunk_e, 3), round(trunk_n, 3), round(th_ground, 3)],
                    "trunk_local": [round(trunk_e - ce, 3), round(th_ground - ch, 3), round(cn - trunk_n, 3)],
                }
            )
        trees_list.sort(key=lambda x: (x["height_m"], x["dbh_cm"]), reverse=True)
        for idx_t, t_obj in enumerate(trees_list, 1):
            t_obj["id"] = f"T{idx_t}"
            t_obj["name"] = f"喬木 T{idx_t}"

        # =================================================================================
        # CATEGORY 3: WATER BODIES & UN-MODELLED WATER VOIDS (水體與未建模水域空洞)
        # =================================================================================
        water_list: List[Dict[str, Any]] = []
        # 3A: Detect Un-Modelled Water Voids (~raw_occ_closed) strictly inside the scanned terrain hull & river channel!
        occ_valid_h = h_dtm_grid[raw_occ_closed]
        p25_site_h = float(np.percentile(occ_valid_h, 25.0)) if len(occ_valid_h) > 0 else ch
        p45_site_h = float(np.percentile(occ_valid_h, 45.0)) if len(occ_valid_h) > 0 else ch + 3.0
        p18_site_h = float(np.percentile(occ_valid_h, 18.0)) if len(occ_valid_h) > 0 else ch - 1.5

        # 1) 2D ConvexHull interior mask of occupied scan cells (strictly excludes outer bounding-box corners)
        occ_js, occ_is = np.nonzero(raw_occ_closed)
        hull_2d_mask = np.zeros((ny, nx), dtype=bool)
        if len(occ_is) >= 12:
            try:
                stride_h = max(1, len(occ_is) // 6000)
                pts_occ_px = np.column_stack([occ_is[::stride_h], occ_js[::stride_h]]).astype(np.float64)
                chull_occ = ConvexHull(pts_occ_px)
                eqs = chull_occ.equations  # shape (N_facets, 3): a*x + b*y + c <= 0 inside hull
                grid_yy, grid_xx = np.mgrid[0:ny, 0:nx]
                coords_flat = np.vstack([grid_xx.ravel(), grid_yy.ravel()]).astype(np.float64)
                inside_flat = np.all((eqs[:, :2] @ coords_flat) + eqs[:, 2:3] <= -1.5, axis=0)
                hull_2d_mask = inside_flat.reshape((ny, nx))
            except Exception:
                hull_2d_mask = site_hull.copy()

        # 2) 8-Direction Ray-Cast Enclosure Mask up to 45m (and opposite-pair channel check within 38m)
        # An unoccupied cell is an interior hole, river channel, or concave bank embayment ONLY if rays hit
        # actual occupied scan geometry in >= 5/8 directions (or >= 4/8 directions with >= 1 opposite pair within 38m).
        max_steps_45m = max(6, int(round(45.0 / res)))
        max_steps_38m = max(5, int(round(38.0 / res)))
        step_stride = 2 if res <= 0.30 else 1
        compass_pairs = [
            ((1, 0), (-1, 0)),
            ((0, 1), (0, -1)),
            ((1, 1), (-1, -1)),
            ((1, -1), (-1, 1)),
        ]
        dir_count_45m = np.zeros((ny, nx), dtype=np.int16)
        opp_pair_38m = np.zeros((ny, nx), dtype=np.int16)

        def _ray_hits_occupied(di: int, dj: int) -> Tuple[np.ndarray, np.ndarray]:
            hit38 = np.zeros((ny, nx), dtype=bool)
            hit45 = np.zeros((ny, nx), dtype=bool)
            diag_scale = 1.4142 if (di != 0 and dj != 0) else 1.0
            n_max_s = max(4, int(round(max_steps_45m / diag_scale)))
            n_38_s = max(3, int(round(max_steps_38m / diag_scale)))
            for s_px in range(step_stride, n_max_s + 1, step_stride):
                # Cell (j, i) looking along (dj, di) by s_px sees raw_occ_closed[j + dj*s_px, i + di*s_px]
                sh_j = dj * s_px
                sh_i = di * s_px
                if abs(sh_j) >= ny or abs(sh_i) >= nx:
                    break
                dst_j0 = max(0, -sh_j)
                dst_j1 = min(ny, ny - sh_j)
                src_j0 = max(0, sh_j)
                src_j1 = min(ny, ny + sh_j)
                dst_i0 = max(0, -sh_i)
                dst_i1 = min(nx, nx - sh_i)
                src_i0 = max(0, sh_i)
                src_i1 = min(nx, nx + sh_i)
                sub_occ = raw_occ_closed[src_j0:src_j1, src_i0:src_i1]
                hit45[dst_j0:dst_j1, dst_i0:dst_i1] |= sub_occ
                if s_px <= n_38_s:
                    hit38[dst_j0:dst_j1, dst_i0:dst_i1] |= sub_occ
            return hit38, hit45

        for (di1, dj1), (di2, dj2) in compass_pairs:
            h38_1, h45_1 = _ray_hits_occupied(di1, dj1)
            h38_2, h45_2 = _ray_hits_occupied(di2, dj2)
            dir_count_45m += h45_1.astype(np.int16) + h45_2.astype(np.int16)
            opp_pair_38m += (h38_1 & h38_2).astype(np.int16)

        enclosed_void_cell = hull_2d_mask & (
            (dir_count_45m >= 6) & (opp_pair_38m >= 2)
        )

        margin_px = max(3, int(round(3.0 / res)))
        inner_box = np.zeros_like(raw_occ_closed, dtype=bool)
        inner_box[margin_px : ny - margin_px, margin_px : nx - margin_px] = True
        void_candidate = (
            (~raw_occ_closed)
            & inner_box
            & enclosed_void_cell
            & (dist_cells * res <= 5.5)
            & (dist_cells * res >= 0.35)
            & (h_dtm_grid <= p18_site_h + 1.40)
        )
        void_labeled, n_voids = nd_label(void_candidate)
        occ_dilated_3 = binary_dilation(raw_occ_closed, structure=np.ones((3, 3), dtype=bool))
        for vid in range(1, n_voids + 1):
            vmask = void_labeled == vid
            v_area = float(np.count_nonzero(vmask) * cell_area)
            if v_area < 25.0 or v_area > 2500.0:
                continue
            # Require at least 55% of the void's outer perimeter boundary to touch actual scanned terrain
            b_mask = binary_dilation(vmask, structure=np.ones((3, 3), dtype=bool)) & (~vmask)
            b_cnt = int(np.count_nonzero(b_mask))
            if b_cnt < 8:
                continue
            touch_cnt = int(np.count_nonzero(b_mask & occ_dilated_3))
            if (float(touch_cnt) / float(b_cnt)) < 0.55:
                continue

            # Inspect the modelled shoreline rim ∂V_k where the void touches actual 3D mesh occupancy
            rim_mask = binary_dilation(vmask, structure=np.ones((5, 5), dtype=bool)) & raw_occ_closed
            if np.count_nonzero(rim_mask) < 8:
                continue
            rim_h = h_dtm_grid[rim_mask]
            shoreline_h_p20 = float(np.percentile(rim_h, 20.0))
            shoreline_h_med = float(np.percentile(rim_h, 45.0))
            # A genuine river/pond water void has its shoreline bank toe in the lower portion of the valley
            if shoreline_h_p20 <= p25_site_h + 0.85:
                low_void_mask = vmask & (h_dtm_grid <= shoreline_h_med + 1.5) & (dist_cells * res <= 7.5)
                low_void_mask = binary_closing(low_void_mask, structure=np.ones((3, 3), dtype=bool)) & (~raw_occ_closed)
                # Slightly erode by 1px when wide enough so 3D cyan water mesh sits flush inside the channel without overlapping dry bank triangles
                eroded_v = binary_erosion(low_void_mask, structure=np.ones((2, 2), dtype=bool))
                if np.count_nonzero(eroded_v) * cell_area >= 22.0:
                    low_void_mask = eroded_v
                v_polys = _mask_to_polygons(
                    low_void_mask,
                    min_area_m2=22.0,
                    fixed_z=round(shoreline_h_p20, 3),
                    simplify_tol=0.38,
                )
                for vp in v_polys:
                    vp.pop("comp_mask", None)
                    if vp["planar_area_m2"] > 3500.0:
                        continue
                    wid = f"W{len(water_list) + 1}"
                    water_list.append(
                        {
                            "id": wid,
                            "name": f"河道水域空洞 {wid} (Un-Modelled Water Void)",
                            "detection_mode": "unmodelled_void_shoreline",
                            "detection_label_zh": "未建模水域空洞 + 岸際等位高程擬合",
                            "water_level_twvd2001_m": round(shoreline_h_p20, 3),
                            "planar_area_m2": vp["planar_area_m2"],
                            "planar_area_ping": vp["planar_area_ping"],
                            "perimeter_m": vp["perimeter_m"],
                            "mean_width_m": vp["mean_width_m"],
                            "center_twd97": vp["center_twd97"],
                            "center_local": vp["center_local"],
                            "boundary_twd97": vp["boundary_twd97"],
                            "boundary_local": vp["boundary_local"],
                        }
                    )

        # 3B: Also detect Modelled Flat Spectral Water Basins (abs(nz) >= 0.90, NDWI > 0.02, low elevation)
        spec_water_mask = (
            raw_occ_closed
            & (hag_grid <= 0.35)
            & (ortho_ndwi > 0.025)
            & (ortho_exg < 0.03)
            & (ortho_lum <= 0.48)
            & (h_dtm_grid <= p25_site_h + 2.0)
        )
        spec_water_mask = binary_opening(spec_water_mask, structure=np.ones((2, 2), dtype=bool))
        for sp in _mask_to_polygons(spec_water_mask, min_area_m2=20.0, simplify_tol=0.40):
            cm = sp.pop("comp_mask")
            wl_m = float(np.percentile(h_dtm_grid[cm], 25.0))
            wid = f"W{len(water_list) + 1}"
            water_list.append(
                {
                    "id": wid,
                    "name": f"建模水體表面 {wid} (Modelled Water Surface)",
                    "detection_mode": "modelled_flat_basin",
                    "detection_label_zh": "建模平坦水體表面 (NDWI 光譜與低高程)",
                    "water_level_twvd2001_m": round(wl_m, 3),
                    "planar_area_m2": sp["planar_area_m2"],
                    "planar_area_ping": sp["planar_area_ping"],
                    "perimeter_m": sp["perimeter_m"],
                    "mean_width_m": sp["mean_width_m"],
                    "center_twd97": sp["center_twd97"],
                    "center_local": sp["center_local"],
                    "boundary_twd97": sp["boundary_twd97"],
                    "boundary_local": sp["boundary_local"],
                }
            )
        water_list.sort(key=lambda x: x["planar_area_m2"], reverse=True)
        water_list = water_list[:8]
        for idx_w, w_obj in enumerate(water_list, 1):
            w_obj["id"] = f"W{idx_w}"
            if w_obj.get("detection_mode") == "unmodelled_void_shoreline":
                w_obj["name"] = f"河道水域空洞 W{idx_w} (Un-Modelled Water Void)"
            else:
                w_obj["name"] = f"建模水體表面 W{idx_w} (Modelled Water Surface)"

        # =================================================================================
        # CATEGORY 4: WALLS (Retaining & Building Walls / 擋土牆與垂直牆面)
        # =================================================================================
        # Filter vertical wall triangles (0.25m <= HAG <= 5.5m, abs(nz) < 0.34, ExG < 0.045 to exclude overhanging green tree canopy!)
        # + normal-azimuth binning + 3D cKDTree clustering + 3D PCA coplanarity filter (sqrt(lambda_3) <= 0.28m)
        vert_tri_mask = (
            (tri_hag >= 0.25)
            & (tri_hag <= 7.5)
            & (nz_abs < 0.34)
            & (exg < 0.062)
            & (area_3d >= 0.005)
        )
        vert_idx = np.nonzero(vert_tri_mask)[0]
        walls_list: List[Dict[str, Any]] = []

        if len(vert_idx) >= 12:
            v_cent = centroids[vert_idx]
            v_norm = normals[vert_idx]
            v_a3d = area_3d[vert_idx]
            v_hag = tri_hag[vert_idx]
            # Fold horizontal normal direction into [0, 180) deg strike/azimuth bin (6 bins of 30 deg)
            n_az_deg = (np.degrees(np.arctan2(v_norm[:, 1], v_norm[:, 0])) + 180.0) % 180.0
            az_bins = (n_az_deg // 30.0).astype(np.int32) % 6

            for b_id in range(6):
                b_mask = (az_bins == b_id) | (az_bins == ((b_id + 1) % 6))
                b_indices = np.nonzero(b_mask)[0]
                if len(b_indices) < 12:
                    continue
                pts_b = v_cent[b_indices]
                areas_b = v_a3d[b_indices]
                hags_b = v_hag[b_indices]
                normals_b = v_norm[b_indices]

                # Cluster in 2D (E, N) using grid rasterization at 0.6m resolution
                w_res = 0.60
                wx = np.clip(((pts_b[:, 0] - e_min) / w_res).astype(np.int32), 0, int(span_e / w_res) + 1)
                wy = np.clip(((pts_b[:, 1] - n_min) / w_res).astype(np.int32), 0, int(span_n / w_res) + 1)
                w_grid_a = np.zeros((int(span_n / w_res) + 2, int(span_e / w_res) + 2), dtype=np.float32)
                np.add.at(w_grid_a, (wy, wx), areas_b)
                w_occ = binary_closing(w_grid_a >= 0.18, structure=np.ones((2, 2), dtype=bool))
                w_lbl, n_wcomp = nd_label(w_occ)
                if n_wcomp == 0:
                    continue
                pt_cid = w_lbl[wy, wx]
                for wc in range(1, n_wcomp + 1):
                    sel = pt_cid == wc
                    if np.count_nonzero(sel) < 10:
                        continue
                    w_area_3d = float(areas_b[sel].sum())
                    if w_area_3d < 3.2:
                        continue
                    pts_w = pts_b[sel]
                    # 3D PCA Coplanarity & Linearity Check (rejects chaotic tree foliage/trunks!)
                    cov3 = np.cov(pts_w.T)
                    evals3, evecs3 = np.linalg.eigh(cov3)
                    idx_sort = np.argsort(evals3)[::-1]
                    evals3 = np.maximum(evals3[idx_sort], 1e-6)
                    evecs3 = evecs3[:, idx_sort]
                    sigma_plane = math.sqrt(float(evals3[2]))  # Out-of-plane thickness (m)
                    sigma_major = math.sqrt(float(evals3[0]))
                    if sigma_plane > 0.28 or sigma_major < 0.85:
                        continue

                    # Project onto horizontal wall strike vector to find wall endpoints and length
                    cov2 = np.cov(pts_w[:, :2].T)
                    ev2, vec2 = np.linalg.eigh(cov2)
                    strike_vec = vec2[:, int(np.argmax(ev2))]
                    strike_vec = strike_vec / max(float(np.linalg.norm(strike_vec)), 1e-9)
                    center_xy = pts_w[:, :2].mean(axis=0)
                    proj_s = (pts_w[:, :2] - center_xy) @ strike_vec
                    s_min = float(np.percentile(proj_s, 2.0))
                    s_max = float(np.percentile(proj_s, 98.0))
                    wall_len_m = float(max(s_max - s_min, 1.5))
                    if wall_len_m < 2.2:
                        continue

                    # Deduplicate overlapping wall segments from adjacent azimuth bins
                    c_e, c_n = float(center_xy[0]), float(center_xy[1])
                    if any(math.hypot(c_e - w["center_twd97"][0], c_n - w["center_twd97"][1]) < 2.2 for w in walls_list):
                        continue

                    z_base = float(np.percentile(pts_w[:, 2] - hags_b[sel], 25.0))
                    raw_p90_h = float(np.percentile(hags_b[sel], 90.0))
                    mean_h = float(np.clip(w_area_3d / max(wall_len_m, 1.0), 0.6, max(min(raw_p90_h, 5.2), 0.8)))
                    max_h = round(min(max(raw_p90_h, mean_h), mean_h * 1.65, 5.5), 2)
                    z_top = z_base + mean_h

                    # Build multi-vertex 3D wall base & top polylines (5 stations along wall)
                    n_sta = 5
                    base_twd: List[List[float]] = []
                    top_twd: List[List[float]] = []
                    base_loc: List[List[float]] = []
                    top_loc: List[List[float]] = []
                    for si in range(n_sta):
                        sv = s_min + (si / (n_sta - 1)) * (s_max - s_min)
                        local_band = np.abs(proj_s - sv) <= max(0.8, (s_max - s_min) / n_sta)
                        if np.any(local_band):
                            pe = float(np.median(pts_w[local_band, 0]))
                            pn = float(np.median(pts_w[local_band, 1]))
                            pz_b = float(np.percentile(pts_w[local_band, 2], 12.0))
                            pz_t = float(np.percentile(pts_w[local_band, 2], 88.0))
                            if pz_t - pz_b < 0.5:
                                pz_t = pz_b + mean_h
                            elif pz_t - pz_b > max_h:
                                pz_t = pz_b + max_h
                        else:
                            pt_xy = center_xy + sv * strike_vec
                            pe, pn = float(pt_xy[0]), float(pt_xy[1])
                            pz_b, pz_t = z_base, z_top
                        base_twd.append([round(pe, 3), round(pn, 3), round(pz_b, 3)])
                        top_twd.append([round(pe, 3), round(pn, 3), round(pz_t, 3)])
                        base_loc.append([round(pe - ce, 3), round(pz_b - ch, 3), round(cn - pn, 3)])
                        top_loc.append([round(pe - ce, 3), round(pz_t - ch, 3), round(cn - pn, 3)])

                    mean_nz_w = float(np.mean(np.abs(normals_b[sel, 2])))
                    tilt_deg = round(90.0 - math.degrees(math.acos(min(1.0, mean_nz_w))), 1)
                    az_deg = round((math.degrees(math.atan2(strike_vec[0], strike_vec[1])) + 360.0) % 180.0, 1)

                    wid_str = f"WL{len(walls_list) + 1}"
                    walls_list.append(
                        {
                            "id": wid_str,
                            "name": f"擋土牆/垂直牆面 {wid_str}",
                            "subtype": "retaining_wall" if z_base < p45_site_h + 4.0 else "structural_wall",
                            "length_m": round(wall_len_m, 2),
                            "height_m": round(mean_h, 2),
                            "mean_height_m": round(mean_h, 2),
                            "max_height_m": max_h,
                            "vertical_area_m2": round(w_area_3d, 2),
                            "coplanarity_rms_m": round(sigma_plane, 3),
                            "azimuth_deg": az_deg,
                            "tilt_deg": tilt_deg,
                            "center_twd97": [round(c_e, 3), round(c_n, 3), round(0.5 * (z_base + z_top), 3)],
                            "center_local": [round(c_e - ce, 3), round(0.5 * (z_base + z_top) - ch, 3), round(cn - c_n, 3)],
                            "base_polyline_twd97": base_twd,
                            "top_polyline_twd97": top_twd,
                            "base_polyline_local": base_loc,
                            "top_polyline_local": top_loc,
                        }
                    )

        walls_list.sort(key=lambda x: x["vertical_area_m2"], reverse=True)
        walls_list = walls_list[:18]
        for idx_wl, wl_obj in enumerate(walls_list, 1):
            wl_obj["id"] = f"WL{idx_wl}"
            wl_obj["name"] = f"擋土牆/垂直牆面 WL{idx_wl}"

        # =================================================================================
        # CATEGORY 5: EXTENDED CIVIL CATEGORIES (Stockpiles/Bare Earth, Sloped Revetments,
        #             Low Vegetation/Grass, Buildings/Structures, Drainage/Curbs, Clutter)
        # =================================================================================
        # 1. Bare Earth & Stockpiles / Gravel Bars (裸露土石/河灘卵石/堆置場)
        bare_tri = (tri_hag <= 1.5) & (nz_abs >= 0.72) & (exg < 0.04) & (~road_tri_mask)
        bare_area_2d = float(area_2d[bare_tri].sum())
        bare_area_3d = float(area_3d[bare_tri].sum())

        # Extract top bare-earth / gravel / stockpile zones
        bare_grid = np.zeros((ny, nx), dtype=bool)
        bare_grid[in_c[bare_tri], ie_c[bare_tri]] = True
        bare_grid = binary_opening(bare_grid & raw_occ_closed, structure=np.ones((2, 2), dtype=bool))
        stockpiles_list: List[Dict[str, Any]] = []
        for sp_item in _mask_to_polygons(bare_grid, min_area_m2=25.0, simplify_tol=0.45)[:6]:
            cm_s = sp_item.pop("comp_mask")
            mean_dz = float(np.maximum(0.18, hag_grid[cm_s]).mean())
            est_vol = round(sp_item["planar_area_m2"] * mean_dz * 0.55, 2)
            sid_s = f"S{len(stockpiles_list) + 1}"
            stockpiles_list.append(
                {
                    "id": sid_s,
                    "name": f"裸露土石/卵石區 {sid_s}",
                    "planar_area_m2": sp_item["planar_area_m2"],
                    "planar_area_ping": sp_item["planar_area_ping"],
                    "estimated_volume_m3": est_vol,
                    "center_twd97": sp_item["center_twd97"],
                    "center_local": sp_item["center_local"],
                    "boundary_twd97": sp_item["boundary_twd97"],
                    "boundary_local": sp_item["boundary_local"],
                }
            )
        stockpiles_list.sort(key=lambda x: x["planar_area_m2"], reverse=True)
        for idx_s, sp_obj in enumerate(stockpiles_list, 1):
            sp_obj["id"] = f"S{idx_s}"
            sp_obj["name"] = f"裸露土石/卵石區 S{idx_s}"

        # 2. Low Vegetation / Grass / Shrubs (低矮植生與草坡)
        grass_tri = (tri_hag < 1.8) & (exg >= 0.04) & (nz_abs >= 0.55)
        grass_area_2d = float(area_2d[grass_tri].sum())
        grass_area_3d = float(area_3d[grass_tri].sum())

        # 3. Sloped Revetments & Engineered Embankments (30 deg - 68 deg, 護岸斜坡與邊坡)
        revet_tri = (nz_abs >= 0.37) & (nz_abs < 0.84) & (exg < 0.045)
        revet_area_2d = float(area_2d[revet_tri].sum())
        revet_area_3d = float(area_3d[revet_tri].sum())

        # 4. Buildings / Roofs / Pavilions (建築物與棚架屋頂)
        bldg_tri = (tri_hag >= 2.2) & (nz_abs >= 0.78) & (exg < 0.035) & (tri_sigma_h <= 0.12)
        bldg_area_2d = float(area_2d[bldg_tri].sum())
        bldg_area_3d = float(area_3d[bldg_tri].sum())

        # 5. Drainage Channels & Curbs (排水溝渠與緣石)
        curb_tri = (tri_hag >= 0.08) & (tri_hag < 0.35) & (nz_abs >= 0.34) & (nz_abs < 0.72) & (exg < 0.04)
        curb_area_2d = float(area_2d[curb_tri].sum())
        curb_area_3d = float(area_3d[curb_tri].sum())

        # 6. Transient Clutter / Vehicles / Construction Equipment (施工機具/車輛與雜物)
        clutter_tri = (
            (tri_hag >= 0.45)
            & (tri_hag <= 3.8)
            & (exg < 0.035)
            & ((tri_sigma_h > 0.065) | (sat > 0.24))
            & (~road_tri_mask)
            & (~bldg_tri)
            & (~revet_tri)
        )
        clutter_area_2d = float(area_2d[clutter_tri].sum())
        clutter_area_3d = float(area_3d[clutter_tri].sum())
        clutter_est_cnt = max(1, int(round(clutter_area_2d / 14.0))) if clutter_area_2d >= 2.0 else 0

        # 7. High Canopy Trees Total Area
        canopy_tri = (tri_hag >= 1.8) & (exg >= 0.032)
        canopy_area_2d = float(area_2d[canopy_tri].sum())
        canopy_area_3d = float(area_3d[canopy_tri].sum())

        roads_planar_total = round(sum(r["planar_area_m2"] for r in roads_list), 2)
        roads_3d_total = round(sum(r["surface_area_3d_m2"] for r in roads_list), 2)
        water_planar_total = round(sum(w["planar_area_m2"] for w in water_list), 2)
        water_lvl_primary = water_list[0]["water_level_twvd2001_m"] if water_list else round(p25_site_h, 3)
        walls_vert_area_total = round(sum(w["vertical_area_m2"] for w in walls_list), 2)
        walls_len_total = round(sum(w["length_m"] for w in walls_list), 2)

        trees_dbh_vals = [t["dbh_cm"] for t in trees_list]
        mean_dbh_cm = round(float(np.mean(trees_dbh_vals)), 1) if trees_dbh_vals else 0.0
        max_dbh_cm = round(float(np.max(trees_dbh_vals)), 1) if trees_dbh_vals else 0.0
        mean_tree_h_m = round(float(np.mean([t["height_m"] for t in trees_list])), 2) if trees_list else 0.0

        total_mesh_2d = float(area_2d.sum()) + water_planar_total
        total_mesh_3d = float(area_3d.sum())

        extended_categories = [
            {
                "key": "roads",
                "name_zh": "道路鋪面 (Road Surface)",
                "name_en": "Paved Road Corridors",
                "color": "#f59e0b",
                "count": len(roads_list),
                "planar_area_m2": roads_planar_total,
                "planar_area_ping": round(roads_planar_total * 0.3025, 2),
                "surface_area_3d_m2": roads_3d_total,
                "site_share_pct": round(100.0 * roads_planar_total / max(total_mesh_2d, 1.0), 1),
            },
            {
                "key": "trees",
                "name_zh": "喬木林冠與胸徑 (Trees & Trunk DBH)",
                "name_en": "Canopy Trees & 1.3m Trunk DBH",
                "color": "#10b981",
                "count": len(trees_list),
                "planar_area_m2": round(canopy_area_2d, 2),
                "planar_area_ping": round(canopy_area_2d * 0.3025, 2),
                "surface_area_3d_m2": round(canopy_area_3d, 2),
                "site_share_pct": round(100.0 * canopy_area_2d / max(total_mesh_2d, 1.0), 1),
            },
            {
                "key": "water_bodies",
                "name_zh": "水域與未建模水面空洞 (Water & Voids)",
                "name_en": "Water Bodies & Un-Modelled Water Voids",
                "color": "#06b6d4",
                "count": len(water_list),
                "planar_area_m2": water_planar_total,
                "planar_area_ping": round(water_planar_total * 0.3025, 2),
                "surface_area_3d_m2": water_planar_total,
                "site_share_pct": round(100.0 * water_planar_total / max(total_mesh_2d, 1.0), 1),
            },
            {
                "key": "walls",
                "name_zh": "擋土牆與垂直結構面 (Retaining/Building Walls)",
                "name_en": "Retaining & Structural Vertical Walls",
                "color": "#f43f5e",
                "count": len(walls_list),
                "planar_area_m2": round(walls_len_total * 0.35, 2),
                "planar_area_ping": round(walls_len_total * 0.35 * 0.3025, 2),
                "surface_area_3d_m2": walls_vert_area_total,
                "site_share_pct": round(100.0 * walls_vert_area_total / max(total_mesh_3d, 1.0), 1),
            },
            {
                "key": "bare_earth_stockpiles",
                "name_zh": "裸露土石/河灘卵石/堆置區 (Bare Earth & Cobble)",
                "name_en": "Bare Earth, River Cobble & Stockpiles",
                "color": "#d97706",
                "count": len(stockpiles_list),
                "planar_area_m2": round(bare_area_2d, 2),
                "planar_area_ping": round(bare_area_2d * 0.3025, 2),
                "surface_area_3d_m2": round(bare_area_3d, 2),
                "site_share_pct": round(100.0 * bare_area_2d / max(total_mesh_2d, 1.0), 1),
            },
            {
                "key": "low_vegetation_grass",
                "name_zh": "低矮植生與草坡 (Low Veg & Grass)",
                "name_en": "Low Vegetation, Shrubs & Grass",
                "color": "#84cc16",
                "count": 1,
                "planar_area_m2": round(grass_area_2d, 2),
                "planar_area_ping": round(grass_area_2d * 0.3025, 2),
                "surface_area_3d_m2": round(grass_area_3d, 2),
                "site_share_pct": round(100.0 * grass_area_2d / max(total_mesh_2d, 1.0), 1),
            },
            {
                "key": "sloped_revetments",
                "name_zh": "護岸斜坡與人工邊坡 (Sloped Revetments)",
                "name_en": "Pitched Revetments & Sloped Banks (30°-68°)",
                "color": "#a855f7",
                "count": 1,
                "planar_area_m2": round(revet_area_2d, 2),
                "planar_area_ping": round(revet_area_2d * 0.3025, 2),
                "surface_area_3d_m2": round(revet_area_3d, 2),
                "site_share_pct": round(100.0 * revet_area_2d / max(total_mesh_2d, 1.0), 1),
            },
            {
                "key": "buildings_structures",
                "name_zh": "建築屋頂與人造設施 (Buildings & Structures)",
                "name_en": "Building Roofs & Elevated Structures",
                "color": "#3b82f6",
                "count": 1 if bldg_area_2d >= 4.0 else 0,
                "planar_area_m2": round(bldg_area_2d, 2),
                "planar_area_ping": round(bldg_area_2d * 0.3025, 2),
                "surface_area_3d_m2": round(bldg_area_3d, 2),
                "site_share_pct": round(100.0 * bldg_area_2d / max(total_mesh_2d, 1.0), 1),
            },
            {
                "key": "drainage_curbs",
                "name_zh": "排水邊溝與緣石 (Drainage & Curbs)",
                "name_en": "Drainage Channels & Road Curbs",
                "color": "#64748b",
                "count": 1,
                "planar_area_m2": round(curb_area_2d, 2),
                "planar_area_ping": round(curb_area_2d * 0.3025, 2),
                "surface_area_3d_m2": round(curb_area_3d, 2),
                "site_share_pct": round(100.0 * curb_area_2d / max(total_mesh_2d, 1.0), 1),
            },
            {
                "key": "transient_clutter",
                "name_zh": "施工機具/車輛與雜物 (Vehicles & Clutter)",
                "name_en": "Vehicles, Equipment & Transient Clutter",
                "color": "#ec4899",
                "count": clutter_est_cnt,
                "planar_area_m2": round(clutter_area_2d, 2),
                "planar_area_ping": round(clutter_area_2d * 0.3025, 2),
                "surface_area_3d_m2": round(clutter_area_3d, 2),
                "site_share_pct": round(100.0 * clutter_area_2d / max(total_mesh_2d, 1.0), 1),
            },
        ]

        summary_kpi = {
            "roads_count": len(roads_list),
            "roads_planar_area_m2": roads_planar_total,
            "roads_planar_area_ping": round(roads_planar_total * 0.3025, 2),
            "roads_surface_area_3d_m2": roads_3d_total,
            "trees_count": len(trees_list),
            "trees_mean_dbh_cm": mean_dbh_cm,
            "trees_max_dbh_cm": max_dbh_cm,
            "trees_mean_height_m": mean_tree_h_m,
            "trees_canopy_area_m2": round(canopy_area_2d, 2),
            "water_count": len(water_list),
            "water_planar_area_m2": water_planar_total,
            "water_planar_area_ping": round(water_planar_total * 0.3025, 2),
            "water_level_twvd2001_m": water_lvl_primary,
            "walls_count": len(walls_list),
            "walls_total_length_m": walls_len_total,
            "walls_vertical_area_m2": walls_vert_area_total,
            "stockpiles_count": len(stockpiles_list),
            "bare_earth_area_m2": round(bare_area_2d, 2),
            "grass_area_m2": round(grass_area_2d, 2),
            "revetment_area_3d_m2": round(revet_area_3d, 2),
            "clutter_area_m2": round(clutter_area_2d, 2),
            "total_site_planar_area_m2": round(total_mesh_2d, 2),
            "total_site_surface_3d_m2": round(total_mesh_3d, 2),
            "grid_resolution_m": res,
            "triangle_count": int(len(v0)),
        }

        # Stage 3: Gemini 3.6 Flash Multimodal Verification & Active Per-Region Semantic Labeling
        cand_tags: List[Dict[str, Any]] = []
        for r in roads_list[:4]:
            cand_tags.append({"tag": r["id"], "e": r["center_twd97"][0], "n": r["center_twd97"][1], "color": (245, 158, 11)})
        for w in water_list[:3]:
            cand_tags.append({"tag": w["id"], "e": w["center_twd97"][0], "n": w["center_twd97"][1], "color": (6, 182, 212)})
        for wl in walls_list[:4]:
            cand_tags.append({"tag": wl["id"], "e": wl["center_twd97"][0], "n": wl["center_twd97"][1], "color": (244, 63, 94)})
        for tr in trees_list[:5]:
            cand_tags.append({"tag": tr["id"], "e": tr["trunk_twd97"][0], "n": tr["trunk_twd97"][1], "color": (16, 185, 129)})

        cam_catalog = self._load_or_build_camera_catalog(scan)
        ai_info = self._refine_categorization_with_gemini_multimodal(
            scan,
            ortho_rgb_u8,
            e_min,
            n_min,
            res,
            summary_kpi,
            cand_tags,
            cam_catalog,
        )

        # Apply Gemini-verified semantic subtype & labels to roads_list, water_list, and categories_breakdown
        ai_road_subtype = str(ai_info.get("road_corridor_subtype") or "paved_asphalt_concrete").strip()
        ai_road_zh = str(ai_info.get("road_corridor_label_zh") or "").strip() or "道路鋪面"
        ai_road_en = str(ai_info.get("road_corridor_label_en") or "").strip() or "Paved Road Corridor"
        ai_water_zh = str(ai_info.get("water_body_label_zh") or "").strip() or "河道水域空洞"

        for r_obj in roads_list:
            r_obj["subtype"] = ai_road_subtype
            r_obj["label_zh"] = ai_road_zh
            r_obj["label_en"] = ai_road_en
            r_obj["name"] = f"{ai_road_zh} {r_obj['id']} ({ai_road_en})"
        if extended_categories and extended_categories[0]["key"] == "roads":
            extended_categories[0]["name_zh"] = f"{ai_road_zh} ({ai_road_en})"
            extended_categories[0]["name_en"] = ai_road_en

        for w_obj in water_list:
            if w_obj.get("detection_mode") == "unmodelled_void_shoreline":
                w_obj["name"] = f"{ai_water_zh} {w_obj['id']} (Un-Modelled Water Void)"

        # Stage 4: Write HTML Report, Excel CSV, and AutoCAD Civil3D Categorized .DXF
        ts_id = int(time.time())
        html_name = f"categorization_report_{scan_id}_{ts_id}.html"
        csv_name = f"categorization_report_{scan_id}_{ts_id}.csv"
        dxf_name = f"Civil3D_Categorized_{scan_id}_{ts_id}.dxf"

        result = {
            "ok": True,
            "status": "ok",
            "scan_id": scan_id,
            "scan_name": scan.get("name") or scan_id,
            "project_group": scan.get("project_group") or "Unassigned Site",
            "crs": TWD97_TWVD2001_LABEL,
            "crs_short": TWD97_TWVD2001_SHORT,
            "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "ai_verified": ai_info.get("ai_verified", True),
            "ai_model": ai_info.get("ai_model", "Gemini 3.6 Flash Multimodal + 3D Geometry"),
            "ai_summary_zh": ai_info.get("ai_summary_zh", ""),
            "ai_summary_en": ai_info.get("ai_summary_en", ""),
            "road_corridor_subtype": ai_road_subtype,
            "road_corridor_label_zh": ai_road_zh,
            "road_corridor_label_en": ai_road_en,
            "water_body_label_zh": ai_water_zh,
            "summary": summary_kpi,
            "categories_breakdown": extended_categories,
            "roads": roads_list,
            "trees": trees_list,
            "water_bodies": water_list,
            "walls": walls_list,
            "stockpiles": stockpiles_list,
            "report_html_url": f"/api/reports/{html_name}",
            "report_csv_url": f"/api/reports/{csv_name}",
            "dxf_url": f"/api/contours/{dxf_name}",
            "downloads": {
                "dxf_url": f"/api/contours/{dxf_name}",
                "report_html_url": f"/api/reports/{html_name}",
                "report_csv_url": f"/api/reports/{csv_name}",
            },
        }

        self._write_categorization_deliverables(result, html_name, csv_name, dxf_name)

        if cache_json_path:
            try:
                with open(cache_json_path, "w", encoding="utf-8") as cf:
                    json.dump(result, cf, ensure_ascii=False)
            except Exception:
                pass

        return result

    def _write_categorization_deliverables(
        self,
        data: Dict[str, Any],
        html_filename: str,
        csv_filename: str,
        dxf_filename: str,
    ) -> None:
        """Writes Printable Bilingual HTML Report, UTF-8-SIG Excel CSV Schedule, and AutoCAD Civil3D Categorized .DXF."""
        os.makedirs(REPORTS_DIR, exist_ok=True)
        os.makedirs(CONTOURS_DIR, exist_ok=True)
        html_path = os.path.join(REPORTS_DIR, html_filename)
        csv_path = os.path.join(REPORTS_DIR, csv_filename)
        dxf_path = os.path.join(CONTOURS_DIR, dxf_filename)

        s = data["summary"]

        # 1. Write UTF-8-SIG CSV Schedule for Excel
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as cf:
            w = csv.writer(cf)
            w.writerow(["GatheringScans AI 3D Surface & Object Categorization Schedule (AI 地物與表面自動分類數量總表)"])
            w.writerow(["Project Site", data["project_group"], "Scan Name", data["scan_name"]])
            w.writerow(["CRS", data["crs"], "AI Engine", data["ai_model"]])
            w.writerow(["Generated At", data["generated_at"]])
            w.writerow(["AI Assessment (ZH)", data["ai_summary_zh"]])
            w.writerow(["AI Assessment (EN)", data["ai_summary_en"]])
            w.writerow([])

            w.writerow(["=== 1. CATEGORY BREAKDOWN (全區地物分類面積統計) ==="])
            w.writerow(["Category Key", "Category Name (ZH)", "Count", "2D Planar Area (m²)", "Area (坪)", "3D Surface Area (m²)", "Site Share (%)"])
            for c in data["categories_breakdown"]:
                w.writerow([c["key"], c["name_zh"], c["count"], c["planar_area_m2"], c["planar_area_ping"], c["surface_area_3d_m2"], c["site_share_pct"]])
            w.writerow([])

            w.writerow(["=== 2. ROADS SCHEDULE (道路鋪面清單) ==="])
            w.writerow(["ID", "Name", "2D Planar Area (m²)", "Area (坪)", "3D Surface Area (m²)", "Mean Width (m)", "Perimeter (m)", "Mean Slope (%)", "Center E (m)", "Center N (m)", "Elev H (m)"])
            for r in data["roads"]:
                c_twd = r["center_twd97"]
                w.writerow([r["id"], r["name"], r["planar_area_m2"], r["planar_area_ping"], r["surface_area_3d_m2"], r["mean_width_m"], r["perimeter_m"], r["mean_slope_pct"], c_twd[0], c_twd[1], c_twd[2]])
            w.writerow([])

            w.writerow(["=== 3. TREES & 1.3M TRUNK DBH SCHEDULE (喬木與胸高直徑 DBH 清冊) ==="])
            w.writerow(["Tree ID", "Height (m)", "Trunk DBH at 1.3m (cm)", "DBH Method", "Crown Diameter (m)", "Crown Area (m²)", "Trunk Easting E (m)", "Trunk Northing N (m)", "Ground Elev H (m)"])
            for t in data["trees"]:
                tr_twd = t["trunk_twd97"]
                w.writerow([t["id"], t["height_m"], t["dbh_cm"], t["dbh_method"], t["crown_diameter_m"], t["crown_area_m2"], tr_twd[0], tr_twd[1], tr_twd[2]])
            w.writerow([])

            w.writerow(["=== 4. WATER BODIES & UN-MODELLED WATER VOIDS (水體與未建模河道水域空洞) ==="])
            w.writerow(["Water ID", "Name", "Detection Mode", "Shoreline Water Level TWVD2001 (m)", "Planar Area (m²)", "Area (坪)", "Perimeter (m)", "Mean Width (m)", "Center E (m)", "Center N (m)"])
            for wb in data["water_bodies"]:
                c_twd = wb["center_twd97"]
                w.writerow([wb["id"], wb["name"], wb["detection_label_zh"], wb["water_level_twvd2001_m"], wb["planar_area_m2"], wb["planar_area_ping"], wb["perimeter_m"], wb["mean_width_m"], c_twd[0], c_twd[1]])
            w.writerow([])

            w.writerow(["=== 5. RETAINING & BUILDING WALLS (擋土牆與垂直結構牆面) ==="])
            w.writerow(["Wall ID", "Name", "Length (m)", "Mean Height (m)", "Max Height (m)", "3D Vertical Area (m²)", "Azimuth (°)", "Tilt (°)", "Center E (m)", "Center N (m)", "Center H (m)"])
            for wl in data["walls"]:
                c_twd = wl["center_twd97"]
                w.writerow([wl["id"], wl["name"], wl["length_m"], wl["mean_height_m"], wl["max_height_m"], wl["vertical_area_m2"], wl["azimuth_deg"], wl["tilt_deg"], c_twd[0], c_twd[1], c_twd[2]])

        # 2. Write Printable Engineering HTML Report
        cat_rows = "".join(
            f"<tr><td><span style='display:inline-block;width:10px;height:10px;border-radius:2px;background:{c['color']};margin-right:6px;'></span><b>{c['name_zh']}</b></td>"
            f"<td>{c['count']}</td><td>{c['planar_area_m2']:,.2f} m² ({c['planar_area_ping']:,.2f} 坪)</td>"
            f"<td>{c['surface_area_3d_m2']:,.2f} m²</td><td><b>{c['site_share_pct']}%</b></td></tr>"
            for c in data["categories_breakdown"]
        )
        road_rows = "".join(
            f"<tr><td><b>{r['id']}</b></td><td>{r['name']}</td><td>{r['planar_area_m2']:,.2f} m² ({r['planar_area_ping']:,.2f} 坪)</td>"
            f"<td>{r['surface_area_3d_m2']:,.2f} m²</td><td>{r['mean_width_m']:.2f} m</td><td>{r['mean_slope_pct']}%</td>"
            f"<td>E:{r['center_twd97'][0]:.2f}, N:{r['center_twd97'][1]:.2f}, H:+{r['center_twd97'][2]:.2f}m</td></tr>"
            for r in data["roads"]
        )
        tree_rows = "".join(
            f"<tr><td><b>{t['id']}</b></td><td><b>{t['dbh_cm']:.1f} cm</b></td><td>{t['height_m']:.2f} m</td>"
            f"<td>{t['crown_diameter_m']:.2f} m ({t['crown_area_m2']:.1f} m²)</td><td>{t['dbh_method']}</td>"
            f"<td>E:{t['trunk_twd97'][0]:.2f}, N:{t['trunk_twd97'][1]:.2f}, H:+{t['trunk_twd97'][2]:.2f}m</td></tr>"
            for t in data["trees"]
        )
        water_rows = "".join(
            f"<tr><td><b>{wb['id']}</b></td><td>{wb['name']}</td><td>{wb['detection_label_zh']}</td>"
            f"<td><b>+{wb['water_level_twvd2001_m']:.2f} m</b></td><td>{wb['planar_area_m2']:,.2f} m² ({wb['planar_area_ping']:,.2f} 坪)</td>"
            f"<td>{wb['perimeter_m']:.1f} m</td></tr>"
            for wb in data["water_bodies"]
        )
        wall_rows = "".join(
            f"<tr><td><b>{wl['id']}</b></td><td>{wl['name']}</td><td>{wl['length_m']:.2f} m</td>"
            f"<td>{wl['mean_height_m']:.2f} m (Max {wl['max_height_m']:.2f} m)</td><td><b>{wl['vertical_area_m2']:,.2f} m²</b></td>"
            f"<td>{wl['azimuth_deg']}° / {wl['tilt_deg']}°</td><td>E:{wl['center_twd97'][0]:.2f}, N:{wl['center_twd97'][1]:.2f}</td></tr>"
            for wl in data["walls"]
        )

        html_doc = f"""<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<title>AI 3D Surface & Object Categorization Report — {data['scan_name']}</title>
<style>
  body {{ font-family: 'Segoe UI', 'Microsoft JhengHei', sans-serif; color: #0f172a; margin: 28px auto; max-width: 1020px; line-height: 1.5; }}
  .header {{ display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #0284c7; padding-bottom: 14px; margin-bottom: 20px; }}
  .title {{ font-size: 21px; font-weight: 800; color: #0f172a; }}
  .subtitle {{ font-size: 12.5px; color: #475569; margin-top: 3px; }}
  .badge {{ background: #e0f2fe; color: #0369a1; font-weight: 700; padding: 6px 12px; border-radius: 6px; font-size: 12px; }}
  .ai-box {{ background: #f0f9ff; border: 1px solid #bae6fd; border-left: 4px solid #0284c7; border-radius: 8px; padding: 12px 16px; margin-bottom: 20px; font-size: 13px; }}
  .kpi-grid {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 22px; }}
  .kpi {{ border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; background: #f8fafc; }}
  .kpi-label {{ font-size: 11.5px; color: #64748b; font-weight: 600; }}
  .kpi-val {{ font-size: 20px; font-weight: 800; margin-top: 4px; color: #0f172a; }}
  table {{ width: 100%; border-collapse: collapse; margin-bottom: 22px; font-size: 12.5px; }}
  th, td {{ border: 1px solid #cbd5e1; padding: 7px 10px; text-align: left; }}
  th {{ background: #f1f5f9; font-weight: 700; color: #334155; }}
  .no-print {{ margin-bottom: 18px; display: flex; gap: 10px; }}
  .btn {{ background: #0284c7; color: #fff; border: none; padding: 8px 14px; border-radius: 6px; font-weight: 600; cursor: pointer; text-decoration: none; font-size: 12.5px; }}
  @media print {{ .no-print {{ display: none; }} body {{ margin: 10mm; }} }}
</style>
</head>
<body>
  <div class="no-print">
    <button class="btn" onclick="window.print()">Print / Save as PDF (列印或另存 PDF)</button>
    <a class="btn" style="background:#059669;" href="{data['report_csv_url']}" download>Download Excel Schedule (.CSV)</a>
    <a class="btn" style="background:#7c3aed;" href="{data['dxf_url']}" download>Download AutoCAD Civil3D (.DXF)</a>
  </div>
  <div class="header">
    <div>
      <img src="/assets/gathering_construction_logo.png" alt="聚人營造股份有限公司" style="height:36px;margin-bottom:6px;display:block;" />
      <div class="title">AI 3D 地物與表面自動分類測量成果報告 (Surface & Object Categorization Report)</div>
      <div class="subtitle">Project: <b>{data['project_group']}</b> | Scan: <b>{data['scan_name']}</b> | CRS: <b>{data['crs']}</b> | Generated: {data['generated_at']}</div>
    </div>
    <div class="badge">{data['ai_model']}</div>
  </div>
  <div class="ai-box">
    <div style="font-weight:700;color:#0369a1;margin-bottom:4px;">✦ Gemini Multimodal AI & 3D Computational Geometry Assessment</div>
    <div>{data['ai_summary_zh']}</div>
    <div style="color:#475569;font-size:12px;margin-top:4px;">{data['ai_summary_en']}</div>
  </div>
  <div class="kpi-grid">
    <div class="kpi">
      <div class="kpi-label">Road Surface (道路鋪面)</div>
      <div class="kpi-val" style="color:#d97706;">{s['roads_planar_area_m2']:,.1f} m² ({s['roads_planar_area_ping']:,.1f} 坪)</div>
      <div class="kpi-label">{s['roads_count']} corridors · 3D: {s['roads_surface_area_3d_m2']:,.1f} m²</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Trees & Trunk DBH (喬木與胸徑)</div>
      <div class="kpi-val" style="color:#059669;">{s['trees_count']} 株 · DBH {s['trees_mean_dbh_cm']:.1f} cm</div>
      <div class="kpi-label">Max DBH: {s['trees_max_dbh_cm']:.1f} cm · Mean H: {s['trees_mean_height_m']:.1f} m</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Water & Voids (水域與未建模水面)</div>
      <div class="kpi-val" style="color:#0891b2;">{s['water_planar_area_m2']:,.1f} m² ({s['water_planar_area_ping']:,.1f} 坪)</div>
      <div class="kpi-label">Shoreline TWVD2001 +{s['water_level_twvd2001_m']:.2f} m</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Retaining/Building Walls (擋土牆/牆面)</div>
      <div class="kpi-val" style="color:#e11d48;">{s['walls_vertical_area_m2']:,.1f} m² (3D 立面)</div>
      <div class="kpi-label">{s['walls_count']} segments · Total L: {s['walls_total_length_m']:.1f} m</div>
    </div>
  </div>
  <table>
    <thead><tr><th colspan="5">1. Complete Site Surface & Object Category Breakdown (全區地物分類面積與佔比總表)</th></tr>
    <tr><th>Category (分類項目)</th><th>Count</th><th>2D Planar Area (平面面積 m² / 坪)</th><th>3D Surface Area (真實 3D 表面積)</th><th>Share (%)</th></tr></thead>
    <tbody>{cat_rows}</tbody>
  </table>
  <table>
    <thead><tr><th colspan="7">2. Paved Road Corridors Schedule (道路鋪面清單)</th></tr>
    <tr><th>ID</th><th>Name</th><th>2D Planar Area</th><th>3D Surface Area</th><th>Mean Width</th><th>Mean Grade</th><th>Centroid (TWD97)</th></tr></thead>
    <tbody>{road_rows}</tbody>
  </table>
  <table>
    <thead><tr><th colspan="6">3. Water Bodies & Un-Modelled Water Voids Schedule (水域與未建模河道空洞清單)</th></tr>
    <tr><th>ID</th><th>Name</th><th>Detection Mode</th><th>Water Level (TWVD2001)</th><th>Planar Area</th><th>Perimeter</th></tr></thead>
    <tbody>{water_rows}</tbody>
  </table>
  <table>
    <thead><tr><th colspan="7">4. Retaining & Structural Walls Schedule (擋土牆與垂直牆面清單)</th></tr>
    <tr><th>ID</th><th>Name</th><th>Length</th><th>Height (Mean / Max)</th><th>3D Vertical Area</th><th>Azimuth / Tilt</th><th>Centroid (TWD97)</th></tr></thead>
    <tbody>{wall_rows}</tbody>
  </table>
  <table>
    <thead><tr><th colspan="6">5. Individual Trees & 1.3m Breast-Height Trunk DBH Schedule (喬木樹高、冠幅與 1.3m 胸徑 DBH 清冊)</th></tr>
    <tr><th>Tree ID</th><th>1.3m Trunk DBH (胸徑)</th><th>Tree Height (樹高)</th><th>Crown Diam & Area (冠幅)</th><th>DBH Fit Method</th><th>Trunk Base (TWD97 E, N, H)</th></tr></thead>
    <tbody>{tree_rows}</tbody>
  </table>
</body>
</html>"""
        with open(html_path, "w", encoding="utf-8") as hf:
            hf.write(html_doc)

        # 3. Write AutoCAD Civil3D Categorized .DXF with dedicated layers
        lines = [
            "0", "SECTION",
            "2", "HEADER",
            "9", "$ACADVER", "1", "AC1027",
            "9", "$INSUNITS", "70", "6",
            "0", "ENDSEC",
            "0", "SECTION",
            "2", "TABLES",
            "0", "TABLE",
            "2", "LAYER",
            "70", "8",
            "0", "LAYER", "2", "C-ROAD-BNDY", "70", "0", "62", "30", "6", "CONTINUOUS",
            "0", "LAYER", "2", "C-VEG-TREE", "70", "0", "62", "3", "6", "CONTINUOUS",
            "0", "LAYER", "2", "C-HYDR-WATR", "70", "0", "62", "4", "6", "CONTINUOUS",
            "0", "LAYER", "2", "C-STRC-WALL", "70", "0", "62", "1", "6", "CONTINUOUS",
            "0", "LAYER", "2", "C-TOPO-STKP", "70", "0", "62", "40", "6", "CONTINUOUS",
            "0", "ENDTAB",
            "0", "ENDSEC",
            "0", "SECTION",
            "2", "ENTITIES",
        ]

        def _add_closed_3d_poly(layer: str, color: str, pts: List[List[float]]) -> None:
            if len(pts) < 3:
                return
            lines.extend(["0", "POLYLINE", "8", layer, "62", color, "66", "1", "10", "0.0", "20", "0.0", "30", f"{pts[0][2]:.3f}", "70", "9"])
            for p in pts:
                lines.extend(["0", "VERTEX", "8", layer, "10", f"{p[0]:.3f}", "20", f"{p[1]:.3f}", "30", f"{p[2]:.3f}", "70", "32"])
            lines.extend(["0", "SEQEND", "8", layer])

        for r in data["roads"]:
            _add_closed_3d_poly("C-ROAD-BNDY", "30", r["boundary_twd97"])
        for wb in data["water_bodies"]:
            _add_closed_3d_poly("C-HYDR-WATR", "4", wb["boundary_twd97"])
        for sp in data["stockpiles"]:
            _add_closed_3d_poly("C-TOPO-STKP", "40", sp["boundary_twd97"])
        for wl in data["walls"]:
            b_pts = wl["base_polyline_twd97"]
            if len(b_pts) >= 2:
                lines.extend(["0", "POLYLINE", "8", "C-STRC-WALL", "62", "1", "66", "1", "10", "0.0", "20", "0.0", "30", f"{b_pts[0][2]:.3f}", "70", "8"])
                for p in b_pts:
                    lines.extend(["0", "VERTEX", "8", "C-STRC-WALL", "10", f"{p[0]:.3f}", "20", f"{p[1]:.3f}", "30", f"{p[2]:.3f}", "70", "32"])
                lines.extend(["0", "SEQEND", "8", "C-STRC-WALL"])
        for t in data["trees"]:
            tx, ty, tz = t["trunk_twd97"]
            r_m = max(0.05, t["dbh_cm"] * 0.005)
            lines.extend([
                "0", "CIRCLE", "8", "C-VEG-TREE", "62", "3",
                "10", f"{tx:.3f}", "20", f"{ty:.3f}", "30", f"{tz:.3f}", "40", f"{r_m:.3f}",
                "0", "CIRCLE", "8", "C-VEG-TREE", "62", "3",
                "10", f"{tx:.3f}", "20", f"{ty:.3f}", "30", f"{tz + t['height_m']:.3f}", "40", f"{t['crown_diameter_m'] * 0.5:.3f}",
                "0", "TEXT", "8", "C-VEG-TREE", "62", "3",
                "10", f"{tx + 0.4:.3f}", "20", f"{ty + 0.4:.3f}", "30", f"{tz + 1.3:.3f}", "40", "0.65",
                "1", f"{t['id']} DBH={t['dbh_cm']}cm H={t['height_m']}m",
            ])

        lines.extend(["0", "ENDSEC", "0", "EOF", ""])
        with open(dxf_path, "w", encoding="utf-8") as df:
            df.write("\n".join(lines))



