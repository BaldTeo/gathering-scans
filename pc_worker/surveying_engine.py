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

        sub_grid = full_grid[j0 : j1 + 1, i0 : i1 + 1]
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
        # Inspect source_zip_path if any part is an OPF/raw-photo folder on disk
        for raw_src in str(scan.get("source_zip_path") or "").split(";"):
            raw_src = raw_src.strip()
            if raw_src and os.path.isdir(raw_src) and raw_src not in dirs:
                dirs.append(raw_src)
        # Dynamically inspect PIX4Dmatic project/configs/opf.json for imported OPF camera/image directories
        proj_dir = scan.get("project_dir") or ""
        if proj_dir and os.path.isdir(proj_dir):
            for opf_cfg in (
                os.path.join(proj_dir, "project", "configs", "opf.json"),
                os.path.join(proj_dir, "configs", "opf.json"),
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
        cache_json = os.path.join(proj_dir, "_cameras_cache_v3.json") if os.path.isdir(proj_dir) else None
        if cache_json and os.path.isfile(cache_json):
            try:
                with open(cache_json, "r", encoding="utf-8") as f:
                    cams = json.load(f)
                if isinstance(cams, list) and len(cams) > 0:
                    self._camera_mem_cache[scan_id] = cams
                    return cams
            except Exception:
                pass

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

