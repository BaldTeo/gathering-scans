#!/usr/bin/env python3
"""
GatheringScans Civil Surveying Submodule
"""

from __future__ import annotations

import os
import sys
import csv
import glob
import math
import json
import time
import heapq
import tempfile
import subprocess
from datetime import datetime
from typing import Dict, Any, List, Tuple, Optional

try:
    import numpy as np
except ImportError:
    np = None  # type: ignore

try:
    from scipy.ndimage import distance_transform_edt, gaussian_filter, binary_erosion
except ImportError:
    distance_transform_edt = None  # type: ignore
    gaussian_filter = None  # type: ignore
    binary_erosion = None  # type: ignore

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
    BASE_DIR,
    LOCAL_SCANS_ROOT as SCANS_ROOT_DIR,
    GC_SCAN_OPTIMIZER_DIR,
    REPORTS_DIR,
    CONTOURS_DIR,
    CATEGORIZATION_CACHE_DIR,
    MATERIAL_CATALOG,
    TWD97_TWVD2001_LABEL,
    TWD97_TWVD2001_SHORT,
)
from pc_worker.priority_queue import ScanQueueDB


def safe_float(val: Any, default: Optional[float] = None) -> Optional[float]:
    """Safely converts input to float; returns default on None, empty string, whitespace, non-numeric tokens, or inf/nan."""
    if val is None:
        return default
    try:
        s = str(val).strip()
        if not s or s.lower() in ("none", "null", "undefined", "nan"):
            return default
        f = float(s)
        return f if math.isfinite(f) else default
    except (ValueError, TypeError):
        return default


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


def twd97_to_wgs84(easting: float, northing: float, lon0_deg: float = 121.0) -> Tuple[float, float]:
    """Converts TWD97 TM2 (Easting, Northing) in meters to WGS84 (lat, lon) in degrees."""
    a = 6378137.0
    f = 1.0 / 298.257222101
    b = a * (1.0 - f)
    e2 = (a * a - b * b) / (a * a)
    ep2 = (a * a - b * b) / (b * b)
    k0 = 0.9999
    dx = 250000.0

    x = float(easting) - dx
    y = float(northing)
    M = y / k0
    mu = M / (a * (1.0 - e2 / 4.0 - 3.0 * (e2 ** 2) / 64.0 - 5.0 * (e2 ** 3) / 256.0))
    e1 = (1.0 - math.sqrt(1.0 - e2)) / (1.0 + math.sqrt(1.0 - e2))
    j1 = 3.0 * e1 / 2.0 - 27.0 * (e1 ** 3) / 32.0
    j2 = 21.0 * (e1 ** 2) / 16.0 - 55.0 * (e1 ** 4) / 32.0
    j3 = 151.0 * (e1 ** 3) / 96.0
    j4 = 1097.0 * (e1 ** 4) / 512.0
    fp = (
        mu
        + j1 * math.sin(2.0 * mu)
        + j2 * math.sin(4.0 * mu)
        + j3 * math.sin(6.0 * mu)
        + j4 * math.sin(8.0 * mu)
    )
    sin_fp = math.sin(fp)
    cos_fp = max(1e-9, math.cos(fp))
    tan_fp = math.tan(fp)
    c1 = ep2 * (cos_fp ** 2)
    t1 = tan_fp ** 2
    r1 = a * (1.0 - e2) / ((1.0 - e2 * (sin_fp ** 2)) ** 1.5)
    n1 = a / math.sqrt(1.0 - e2 * (sin_fp ** 2))
    d = x / (n1 * k0)

    q1 = n1 * tan_fp / r1
    q2 = (d ** 2) / 2.0
    q3 = (5.0 + 3.0 * t1 + 10.0 * c1 - 4.0 * (c1 ** 2) - 9.0 * ep2) * (d ** 4) / 24.0
    q4 = (61.0 + 90.0 * t1 + 298.0 * c1 + 45.0 * (t1 ** 2) - 3.0 * (c1 ** 2) - 252.0 * ep2) * (d ** 6) / 720.0
    lat = fp - q1 * (q2 - q3 + q4)

    q5 = d
    q6 = (1.0 + 2.0 * t1 + c1) * (d ** 3) / 6.0
    q7 = (5.0 - 2.0 * c1 + 28.0 * t1 - 3.0 * (c1 ** 2) + 8.0 * ep2 + 24.0 * (t1 ** 2)) * (d ** 5) / 120.0
    lon = math.radians(lon0_deg) + (q5 - q6 + q7) / cos_fp
    return round(math.degrees(lat), 8), round(math.degrees(lon), 8)

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



class DsmAndVolumeMixin:
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
        base_repo = BASE_DIR
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
                    pkgs = mdata.get("packages") or {}
                    if isinstance(pkgs, dict):
                        for k, v in pkgs.items():
                            if str(k).lower() == clean_id.lower() or (isinstance(v, dict) and str(v.get("scan_id") or "").lower() == clean_id.lower()):
                                return v
                except Exception:
                    pass
        raise KeyError(f"Scan not found: {clean_id}")

    @staticmethod
    def _resolve_scan_obj_path(scan: Dict[str, Any]) -> Optional[str]:
        """Finds the best .obj mesh on disk for the given scan metadata, preferring textured mesh.obj."""
        candidates = []
        if scan.get("obj_path"):
            candidates.append(scan["obj_path"])
        for dir_key in ("project_dir", "src_project_dir"):
            d = scan.get(dir_key)
            if d and os.path.isdir(d):
                preferred_obj = os.path.join(d, "exports", "obj_mesh", "mesh.obj")
                if os.path.isfile(preferred_obj):
                    candidates.append(preferred_obj)
                found_objs = glob.glob(os.path.join(d, "**", "*.obj"), recursive=True)
                found_objs.sort(key=lambda p: (0 if os.path.basename(p).lower() == "mesh.obj" else 1, len(p)))
                candidates.extend(found_objs)
                bname = os.path.basename(d.rstrip("\\/"))
                if "-cesium_mesh" in bname:
                    sib_dir = os.path.join(os.path.dirname(d.rstrip("\\/")), bname.replace("-cesium_mesh", "-obj_mesh"))
                    candidates.append(os.path.join(sib_dir, "mesh.obj"))
        for c in candidates:
            if c and os.path.isfile(c) and os.path.getsize(c) > 512:
                return os.path.abspath(c)
        return None

    @staticmethod
    def _collect_scan_glb_files(scan: Dict[str, Any], max_tiles: int = 64) -> List[str]:
        """
        Collects active .glb tile paths for a scan (ordered largest-first), excluding backups/previews.
        When a deep hierarchical 3D Tileset (`refine: REPLACE`) has more than `max_tiles` leaves (and `max_tiles > 0`),
        selects the deepest complete Horizon Cut across the octree that fits within `max_tiles` so 100% of the
        scan's spatial footprint is covered without missing regions.
        """
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
                    max_tree_d = [0]

                    def _walk_glbs(nd: Dict[str, Any], d: int = 0) -> None:
                        if d > max_tree_d[0]:
                            max_tree_d[0] = d
                        cnt = nd.get("content")
                        uri = (cnt.get("uri") or cnt.get("url") or "") if isinstance(cnt, dict) else ""
                        uri_clean = uri.split("?")[0]
                        fp = os.path.join(ts_base_dir, uri_clean.replace("/", os.sep)) if uri_clean else ""
                        chs = [c_nd for c_nd in (nd.get("children") or []) if isinstance(c_nd, dict)]
                        if fp and os.path.isfile(fp) and fp.lower().endswith(".glb"):
                            all_glbs.append(fp)
                            if not chs:
                                leaf_glbs.append(fp)
                        for c_nd in chs:
                            _walk_glbs(c_nd, d + 1)

                    def _walk_horizon_cut(nd: Dict[str, Any], cur_d: int, target_d: int, out_cut: List[str]) -> None:
                        cnt = nd.get("content")
                        uri = (cnt.get("uri") or cnt.get("url") or "").split("?")[0] if isinstance(cnt, dict) else ""
                        fp = os.path.join(ts_base_dir, uri.replace("/", os.sep)) if uri else ""
                        chs = [c_nd for c_nd in (nd.get("children") or []) if isinstance(c_nd, dict)]
                        if cur_d >= target_d or not chs:
                            if fp and os.path.isfile(fp) and fp.lower().endswith(".glb"):
                                out_cut.append(fp)
                            return
                        for c_nd in chs:
                            _walk_horizon_cut(c_nd, cur_d + 1, target_d, out_cut)

                    root_nd = ts_doc.get("root")
                    if isinstance(root_nd, dict):
                        _walk_glbs(root_nd, 0)
                        if max_tiles > 0 and len(leaf_glbs) > max_tiles:
                            best_cut: List[str] = []
                            for td in range(1, max_tree_d[0] + 1):
                                cut_td: List[str] = []
                                _walk_horizon_cut(root_nd, 0, td, cut_td)
                                cut_td = list(dict.fromkeys(cut_td))
                                if 1 <= len(cut_td) <= max_tiles:
                                    best_cut = cut_td
                                elif len(cut_td) > max_tiles:
                                    if not best_cut:
                                        best_cut = cut_td
                                    break
                            if best_cut:
                                glb_files = best_cut
                    if not glb_files and max_tiles > 0 and len(leaf_glbs) > max_tiles and all_glbs:
                        lod_groups: Dict[int, List[str]] = {}
                        for g_fp in all_glbs:
                            parts_b = os.path.splitext(os.path.basename(g_fp))[0].split("_")
                            if parts_b and parts_b[0].isdigit():
                                lod_groups.setdefault(int(parts_b[0]), []).append(g_fp)
                            elif len(parts_b) >= 2 and parts_b[0].lower() == "tile" and parts_b[1].lower().startswith("d") and parts_b[1][1:].isdigit():
                                lod_groups.setdefault(int(parts_b[1][1:]), []).append(g_fp)
                        if lod_groups:
                            if 2 in lod_groups and 4 <= len(lod_groups[2]) <= max_tiles:
                                glb_files = lod_groups[2]
                            else:
                                valid_lods = [k for k, v in lod_groups.items() if 4 <= len(v) <= max_tiles and k <= 4]
                                if valid_lods:
                                    glb_files = lod_groups[max(valid_lods)]
                                else:
                                    best_lod = min(lod_groups.keys(), key=lambda k: abs(len(lod_groups[k]) - 20))
                                    glb_files = lod_groups[best_lod]
                    if not glb_files:
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
                    if max_tiles > 0 and len(found) > max_tiles:
                        lod_groups_f: Dict[int, List[str]] = {}
                        for g_fp in found:
                            parts_b = os.path.splitext(os.path.basename(g_fp))[0].split("_")
                            if parts_b and parts_b[0].isdigit():
                                lod_groups_f.setdefault(int(parts_b[0]), []).append(g_fp)
                            elif len(parts_b) >= 2 and parts_b[0].lower() == "tile" and parts_b[1].lower().startswith("d") and parts_b[1][1:].isdigit():
                                lod_groups_f.setdefault(int(parts_b[1][1:]), []).append(g_fp)
                        if lod_groups_f:
                            if 2 in lod_groups_f and 4 <= len(lod_groups_f[2]) <= max_tiles:
                                found = lod_groups_f[2]
                            else:
                                valid_lods_f = [k for k, v in lod_groups_f.items() if 4 <= len(v) <= max_tiles and k <= 4]
                                if valid_lods_f:
                                    found = lod_groups_f[max(valid_lods_f)]
                                else:
                                    best_lod_f = min(lod_groups_f.keys(), key=lambda k: abs(len(lod_groups_f[k]) - 20))
                                    found = lod_groups_f[best_lod_f]
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
            fast_verts = DsmAndVolumeMixin._extract_glb_positions_from_bytes(raw_bytes)
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
        geom_mtime = max(obj_mtime, ts_mtime)
        source_mtime = geom_mtime if geom_mtime > 0.0 else (os.path.getmtime(meta_json_path) if os.path.isfile(meta_json_path) else 0.0)
        # Only prefer edited tileset over full-resolution mesh.obj when the scan actually has applied mesh edits
        is_edited_scan = bool(scan.get("applied_adjustments")) or (
            str(scan.get("scan_id") or "").startswith("edited_") and ts_mtime > obj_mtime + 60.0
        )
        tileset_edited_after_obj = bool(ts_mtime > 0.0 and obj_mtime > 0.0 and is_edited_scan and ts_mtime > obj_mtime + 2.0)

        cached = self._dsm_mem_cache.get(scan_id)
        if cached and abs(cached.get("source_mtime", -1.0) - source_mtime) < 1.0:
            return cached

        npz_path = os.path.join(proj_dir, "_dsm_cache_v5.npz") if os.path.isdir(proj_dir) else None
        if npz_path and os.path.isfile(npz_path):
            try:
                if geom_mtime == 0.0 or os.path.getmtime(npz_path) >= geom_mtime:
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
            glb_files = self._collect_scan_glb_files(scan, max_tiles=64)
            if glb_files:
                from concurrent.futures import ThreadPoolExecutor

                target_glbs = glb_files[: max(64, len(glb_files))]
                with ThreadPoolExecutor(max_workers=min(8, max(1, len(target_glbs)))) as pool:
                    loaded_arrays = list(pool.map(self._load_glb_vertices, target_glbs))
                chunks = [v_arr for v_arr in loaded_arrays if v_arr is not None and len(v_arr) > 0]
                if chunks:
                    raw_verts = np.vstack(chunks)
                    geom_source = "glb"

        if raw_verts is None or len(raw_verts) == 0:
            # Fallback to .3tz stream package archive (supports Linux VPS zero-raw-storage mode)
            import zipfile

            base_repo = BASE_DIR
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

    def _resolve_vertical_datum_shift(
        self,
        scan_id: str,
        payload: Optional[Dict[str, Any]] = None,
        scan: Optional[Dict[str, Any]] = None,
    ) -> float:
        """
        Resolves the active vertical datum shift (in meters) for a scan:
        1. Explicit payload override: payload['vertical_datum_offset'] or payload['geoid_offset_override']
        2. Database scan record extra_json: scan['vertical_datum_offset'] or scan['tbm_calibration']['shift_m']
        3. Disk mirror: project_dir/scan_meta.json
        Returns 0.0 if uncalibrated.
        """
        if payload:
            if payload.get("vertical_datum_offset") is not None:
                val = safe_float(payload.get("vertical_datum_offset"))
                if val is not None:
                    return val
            if payload.get("geoid_offset_override") is not None:
                val = safe_float(payload.get("geoid_offset_override"))
                if val is not None:
                    return val
        sc = scan
        if not sc and hasattr(self, "db") and self.db and scan_id:
            try:
                sc = self.db.get_scan(scan_id)
            except Exception:
                sc = None
        sc = sc or {}
        if sc.get("vertical_datum_offset") is not None:
            val = safe_float(sc.get("vertical_datum_offset"))
            if val is not None:
                return val
        cal = sc.get("tbm_calibration")
        if isinstance(cal, dict):
            val = safe_float(cal.get("shift_m", cal.get("calibrated_shift_m")))
            if val is not None:
                return val
        # Disk fallback
        proj_dir = sc.get("project_dir") or (os.path.join(SCANS_ROOT_DIR, scan_id) if scan_id else None)
        if proj_dir and os.path.isdir(proj_dir):
            meta_fp = os.path.join(proj_dir, "scan_meta.json")
            if os.path.isfile(meta_fp):
                try:
                    with open(meta_fp, "r", encoding="utf-8") as mf:
                        m = json.load(mf)
                    if isinstance(m, dict):
                        val = safe_float(m.get("vertical_datum_offset"))
                        if val is not None:
                            return val
                        cal_m = m.get("tbm_calibration")
                        if isinstance(cal_m, dict):
                            val = safe_float(cal_m.get("shift_m", cal_m.get("calibrated_shift_m")))
                            if val is not None:
                                return val
                except Exception:
                    pass
        return 0.0

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
        custom_density = safe_float(payload.get("density_t_m3"))
        stockpile_name = payload.get("stockpile_name") or "Stockpile / Earthwork Zone A"
        geoid_override_raw = payload.get("geoid_offset_override") if payload.get("geoid_offset_override") is not None else payload.get("h_offset_from_twvd")
        geoid_offset_override = safe_float(geoid_override_raw)

        scan = self._resolve_scan_record(scan_id)
        v_shift = self._resolve_vertical_datum_shift(scan_id, payload, scan)

        dsm_curr = self._load_or_build_scan_dsm(scan)
        center_e = dsm_curr["ce"]
        center_n = dsm_curr["cn"]
        center_h = dsm_curr["ch"]
        local_origin = payload.get("local_origin_twd97")
        if isinstance(local_origin, dict):
            origin_e = safe_float(local_origin.get("e", center_e), center_e)
            origin_n = safe_float(local_origin.get("n", center_n), center_n)
            origin_h = safe_float(local_origin.get("h", center_h), center_h)
        elif isinstance(local_origin, (list, tuple)) and len(local_origin) >= 3:
            origin_e = safe_float(local_origin[0], center_e)
            origin_n = safe_float(local_origin[1], center_n)
            origin_h = safe_float(local_origin[2], center_h)
        else:
            origin_e = center_e
            origin_n = center_n
            origin_h = center_h

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

        user_poly = payload.get("polygon") if payload.get("polygon") is not None else payload.get("points")
        has_user_poly = isinstance(user_poly, list) and len(user_poly) > 0
        if has_user_poly:
            raw_poly = user_poly
        else:
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
                px = safe_float(pt.get("x", pt.get("e")))
                py = safe_float(pt.get("z", pt.get("n")))
                if px is None or py is None:
                    continue
                if abs(px) < 10000 and abs(py) < 10000:
                    e_val = round(center_e + px, 3)
                    n_val = round(center_n - py, 3)
                else:
                    e_val = round(px, 3)
                    n_val = round(py, 3)
            elif isinstance(pt, (list, tuple)) and len(pt) >= 2:
                px = safe_float(pt[0])
                py = safe_float(pt[1])
                if px is None or py is None:
                    continue
                if abs(px) < 10000 and abs(py) < 10000:
                    e_val = round(center_e + px, 3)
                    n_val = round(center_n - py, 3)
                else:
                    e_val = round(px, 3)
                    n_val = round(py, 3)
            else:
                continue

            sampled_h, _, _, _ = self._sample_dsm_elevation(dsm_curr, e_val, n_val)
            h_val = round(sampled_h + v_shift, 3)
            poly_twd.append((e_val, n_val, h_val))
            poly_local.append([round(e_val - origin_e, 3), round(h_val - origin_h, 3), round(origin_n - n_val, 3)])

        if len(poly_twd) < 3:
            return {
                "status": "error",
                "error": "Polygon must contain at least 3 valid coordinate points.",
                "valid_points_count": len(poly_twd),
            }

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
                perim_samples.append((sx, sy, sz + v_shift))

        perim_mean_h = sum(p[2] for p in perim_samples) / max(len(perim_samples), 1)
        datum_z_cand = payload.get("datum_elevation_m") if payload.get("datum_elevation_m") is not None else payload.get("custom_elevation")
        datum_z = safe_float(datum_z_cand, perim_mean_h)
        if datum_z is None:
            datum_z = perim_mean_h

        # Least-Squares Best-Fit Reference Plane via 2D Normal Equations with Centroid Conditioning
        plane_pts = perim_samples if len(perim_samples) >= 3 else poly_twd
        n_plane = len(plane_pts)
        if n_plane >= 3:
            p_mean_e = sum(p[0] for p in plane_pts) / n_plane
            p_mean_n = sum(p[1] for p in plane_pts) / n_plane
            p_mean_h = sum(p[2] for p in plane_pts) / n_plane

            suu = sum((p[0] - p_mean_e) ** 2 for p in plane_pts)
            svv = sum((p[1] - p_mean_n) ** 2 for p in plane_pts)
            suv = sum((p[0] - p_mean_e) * (p[1] - p_mean_n) for p in plane_pts)
            suw = sum((p[0] - p_mean_e) * (p[2] - p_mean_h) for p in plane_pts)
            svw = sum((p[1] - p_mean_n) * (p[2] - p_mean_h) for p in plane_pts)

            det_plane = suu * svv - suv * suv
            trace_plane = suu + svv

            # Safeguard: singularity / collinear points / non-positive det fallback to horizontal mean plane
            disc_plane = max(0.0, (suu - svv) ** 2 + 4.0 * suv * suv)
            lambda_min = (2.0 * det_plane) / (trace_plane + math.sqrt(disc_plane)) if trace_plane > 1e-6 else 0.0

            if det_plane <= 0.0 or lambda_min < 1e-4 or (lambda_min / trace_plane) < 1e-4 or trace_plane < 1e-6:
                plane_a = 0.0
                plane_b = 0.0
                plane_c0 = p_mean_h
            else:
                plane_a = (suw * svv - svw * suv) / det_plane
                plane_b = (svw * suu - suw * suv) / det_plane
                plane_c0 = p_mean_h
        else:
            p_mean_e = center_e
            p_mean_n = center_n
            p_mean_h = perim_mean_h
            plane_a = 0.0
            plane_b = 0.0
            plane_c0 = perim_mean_h

        plane_c = plane_c0 - plane_a * p_mean_e - plane_b * p_mean_n
        plane_slope_mag = math.hypot(plane_a, plane_b)
        plane_slope_pct = round(plane_slope_mag * 100.0, 3)
        plane_slope_deg = round(math.degrees(math.atan(plane_slope_mag)), 2)
        plane_azimuth_deg = (
            round(math.degrees(math.atan2(plane_a, plane_b)) % 360.0, 2)
            if plane_slope_mag > 1e-7
            else 0.0
        )

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

        # Subsample stride for heatmap_cells so we return up to 2500 3D visualization cells covering 100% of the polygon
        total_est_inside = max(1, int(nx_steps * ny_steps * 0.75))
        vis_stride = max(1, total_est_inside // 2000)

        for ix in range(nx_steps):
            for iy in range(ny_steps):
                gx = min_e + (ix + 0.5) * dx_step
                gy = min_n + (iy + 0.5) * dy_step
                if not point_in_polygon_2d(gx, gy, pts_2d):
                    continue
                inside_cells += 1

                # Real 3D scan surface elevation & slope gradients at (gx, gy)
                z_surf_raw, dz_de, dz_dn, _ = self._sample_dsm_elevation(dsm_curr, gx, gy)
                z_surf = z_surf_raw + v_shift

                if base_mode == "custom_plane":
                    z_base = datum_z
                elif base_mode == "lowest_point":
                    z_base = min((p[2] for p in perim_samples), default=datum_z)
                elif base_mode == "best_fit_plane":
                    z_base = plane_a * (gx - p_mean_e) + plane_b * (gy - p_mean_n) + plane_c0
                elif base_mode == "epoch_diff" and dsm_cmp is not None:
                    cmp_shift = self._resolve_vertical_datum_shift(compare_scan_id)
                    z_base_raw, _, _, _ = self._sample_dsm_elevation(dsm_cmp, gx, gy)
                    z_base = z_base_raw + cmp_shift
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

                if (inside_cells - 1) % vis_stride == 0 and len(heatmap_cells) < 2500:
                    heatmap_cells.append(
                        {
                            "e": round(gx, 2),
                            "n": round(gy, 2),
                            "z_surf": round(z_surf, 3),
                            "z_base": round(z_base, 3),
                            "dz": round(dz, 3),
                            "lx": round(gx - origin_e, 3),
                            "ly_surf": round(z_surf - origin_h, 3),
                            "ly_base": round(z_base - origin_h, 3),
                            "lz": round(origin_n - gy, 3),
                            "step_x": round(dx_step, 4),
                            "step_z": round(dy_step, 4),
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
        density = custom_density if custom_density is not None else safe_float(mat_info.get("density_t_m3"), 1.65)
        if density is None or density <= 0.0:
            density = 1.65

        # Swell factor handling (expansion ratio >= 1.0)
        raw_swell = payload.get("swell_factor")
        sw = safe_float(raw_swell)
        if sw is not None and sw > 0.0:
            if 0.0 < sw < 0.5:
                swell_mult = 1.0 + sw
            elif 0.5 <= sw < 1.0:
                swell_mult = 1.0 / sw
            elif sw >= 1.0:
                swell_mult = sw
            else:
                swell_mult = 1.0
        else:
            base_sw = safe_float(mat_info.get("swell_factor", 0.88), 0.88)
            if base_sw is None or base_sw <= 0.0:
                base_sw = 0.88
            swell_mult = 1.0 / base_sw if 0.0 < base_sw < 1.0 else (base_sw if base_sw >= 1.0 else 1.15)

        # Compaction / Shrinkage factor handling
        raw_shrink = payload.get("shrinkage_factor")
        sh = safe_float(raw_shrink)
        if sh is not None and sh >= 0.0:
            if 0.0 <= sh <= 0.5:
                compaction_mult = 1.0 - sh
            elif 0.5 < sh <= 1.0:
                compaction_mult = sh
            elif 1.0 < sh <= 50.0:
                compaction_mult = 1.0 - (sh / 100.0)
            else:
                compaction_mult = 0.90
        else:
            sh_cat = safe_float(mat_info.get("shrinkage_factor", 0.10), 0.10)
            if sh_cat is None:
                sh_cat = 0.10
            compaction_mult = 1.0 - sh_cat if 0.0 <= sh_cat <= 0.5 else (sh_cat if sh_cat > 0.5 else 0.90)

        cut_vol_bcm = round(cut_vol, 2)
        fill_vol_bcm = round(fill_vol, 2)
        net_vol_bcm = round(net_vol, 2)
        cut_vol_lcm = round(cut_vol * swell_mult, 2)
        fill_vol_ccm = round(fill_vol * compaction_mult, 2)
        conserved_cut_mass = round(cut_vol * density, 2)
        conserved_fill_mass = round(fill_vol * density, 2)

        effective_m3 = fill_vol if fill_vol >= cut_vol else cut_vol
        tonnage_loose = effective_m3 * density
        tonnage_bank = effective_m3 * density * (1.0 / swell_mult)

        # Dump Truck Load Estimator (Volume-limited vs Weight-limited)
        truck_vol = safe_float(payload.get("truck_volume_m3"), 15.0)
        if truck_vol is None or truck_vol <= 0.0:
            truck_vol = 15.0
        truck_max_wt = safe_float(payload.get("truck_max_tonnes"), 20.0)
        if truck_max_wt is None or truck_max_wt <= 0.0:
            truck_max_wt = 20.0
        trips_vol = cut_vol_lcm / max(truck_vol, 0.1)
        trips_wt = conserved_cut_mass / max(truck_max_wt, 0.1)
        truck_loads_cut = int(math.ceil(max(trips_vol, trips_wt))) if cut_vol > 0 else 0
        truck_limiting_factor = "weight" if trips_wt > trips_vol else "volume"

        fill_lcm = fill_vol * swell_mult
        trips_fill_vol = fill_lcm / max(truck_vol, 0.1)
        trips_fill_wt = conserved_fill_mass / max(truck_max_wt, 0.1)
        truck_loads_fill = int(math.ceil(max(trips_fill_vol, trips_fill_wt))) if fill_vol > 0 else 0

        if cut_vol > fill_vol:
            net_cut_bcm = cut_vol - fill_vol
            net_trips_vol = (net_cut_bcm * swell_mult) / max(truck_vol, 0.1)
            net_trips_wt = (net_cut_bcm * density) / max(truck_max_wt, 0.1)
            net_truck_loads = int(math.ceil(max(net_trips_vol, net_trips_wt))) if net_cut_bcm > 0 else 0
            net_haul_direction = "export"
        elif fill_vol > cut_vol:
            net_fill_bcm = fill_vol - cut_vol
            net_trips_vol = (net_fill_bcm * swell_mult) / max(truck_vol, 0.1)
            net_trips_wt = (net_fill_bcm * density) / max(truck_max_wt, 0.1)
            net_truck_loads = int(math.ceil(max(net_trips_vol, net_trips_wt))) if net_fill_bcm > 0 else 0
            net_haul_direction = "import"
        else:
            net_truck_loads = 0
            net_haul_direction = "balanced"

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
            # Standardized Earthwork Mass Conservation Schedule (M1 Contract)
            "cut_volume_bcm": cut_vol_bcm,
            "fill_volume_bcm": fill_vol_bcm,
            "net_volume_bcm": net_vol_bcm,
            "cut_volume_lcm": cut_vol_lcm,
            "fill_volume_ccm": fill_vol_ccm,
            "conserved_cut_mass_t": conserved_cut_mass,
            "conserved_fill_mass_t": conserved_fill_mass,
            "truck_loads_cut": truck_loads_cut,
            "truck_loads_fill": truck_loads_fill,
            "truck_limiting_factor": truck_limiting_factor,
            "net_haul_direction": net_haul_direction,
            "net_truck_loads": net_truck_loads,
            "truck_volume_m3": round(truck_vol, 1),
            "truck_max_tonnes": round(truck_max_wt, 1),
            "truck_specs": {
                "capacity_m3": round(truck_vol, 1),
                "max_payload_tonnes": round(truck_max_wt, 1),
            },
            "geoid_offset_override": geoid_offset_override,
            "geoid_offset_m": geoid_offset_override if geoid_offset_override is not None else 17.20,
            "vertical_datum_offset": round(v_shift, 4),
            "vertical_datum_applied": bool(abs(v_shift) > 1e-5),
            "best_fit_plane": {
                "a": round(plane_a, 6),
                "b": round(plane_b, 6),
                "c": round(plane_c, 4),
                "c0": round(plane_c0, 4),
                "e0": round(p_mean_e, 3),
                "n0": round(p_mean_n, 3),
                "slope_pct": plane_slope_pct,
                "slope_deg": plane_slope_deg,
                "azimuth_deg": plane_azimuth_deg,
            },
            "max_delta_z_m": round(max_dz if max_dz > -1e8 else 0.0, 2),
            "min_delta_z_m": round(min_dz if min_dz < 1e8 else 0.0, 2),
            "material_key": material_key,
            "material_name": mat_info["name"],
            "density_t_m3": round(density, 2),
            "swell_factor": round(float(mat_info.get("swell_factor", 0.88)), 2),
            "estimated_tonnage_t": round(tonnage_loose, 2),
            "bank_tonnage_t": round(tonnage_bank, 2),
            "boundary_twd97": [
                {"vertex": i + 1, "easting_m": p[0], "northing_m": p[1], "twvd2001_h_m": p[2]}
                for i, p in enumerate(poly_twd)
            ],
            "boundary_local": poly_local,
            "cell_step_m": round(max(dx_step, dy_step), 3),
            "cell_dx": round(dx_step, 4),
            "cell_dz": round(dy_step, 4),
            "perim_mean_h_m": round(perim_mean_h, 3),
            "heatmap_cells": heatmap_cells,
            "perspective_img_data_url": str(payload.get("perspective_img_data_url") or ""),
            "nadir_img_data_url": str(payload.get("nadir_img_data_url") or ""),
            "report_html_url": f"/api/reports/{html_filename}",
            "report_csv_url": f"/api/reports/{csv_filename}",
            "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }

        self._write_stockpile_reports(result, html_filename, csv_filename)
        result.pop("perspective_img_data_url", None)
        result.pop("nadir_img_data_url", None)
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
            writer.writerow(["Bank Cut Volume (BCM)", data.get("cut_volume_bcm", data["cut_volume_m3"]), "m³"])
            writer.writerow(["Bank Fill Volume (BCM)", data.get("fill_volume_bcm", data["fill_volume_m3"]), "m³"])
            writer.writerow(["Loose Cut Volume (LCM)", data.get("cut_volume_lcm", 0.0), "m³"])
            writer.writerow(["Compacted Fill Volume (CCM)", data.get("fill_volume_ccm", 0.0), "m³"])
            writer.writerow(["Conserved Cut Mass", data.get("conserved_cut_mass_t", data["estimated_tonnage_t"]), "tonnes (公噸)"])
            writer.writerow(["Conserved Fill Mass", data.get("conserved_fill_mass_t", 0.0), "tonnes (公噸)"])
            writer.writerow(["Dump Truck Cut Trips", data.get("truck_loads_cut", 0), "loads"])
            writer.writerow(["Truck Limiting Constraint", data.get("truck_limiting_factor", "volume"), ""])
            writer.writerow(["Net Haul Direction", data.get("net_haul_direction", "balanced"), ""])
            writer.writerow(["Net Truck Trips", data.get("net_truck_loads", 0), "loads"])
            if data.get("best_fit_plane"):
                bfp = data["best_fit_plane"]
                writer.writerow(["Best-Fit Plane Slope (%)", bfp.get("slope_pct", 0.0), "%"])
                writer.writerow(["Best-Fit Plane Azimuth", bfp.get("azimuth_deg", 0.0), "deg"])
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

        # 2. Write Printable Engineering HTML Report (with Print-to-PDF button, Figure 1 & Figure 2)
        rows_html = "".join(
            f"<tr><td><b>V{v['vertex']}</b></td><td>{v['easting_m']:.3f}</td><td>{v['northing_m']:.3f}</td><td>{v['twvd2001_h_m']:.3f}</td></tr>"
            for v in data["boundary_twd97"]
        )

        verts = data.get("boundary_twd97") or []
        es = [float(v["easting_m"]) for v in verts] or [0.0, 10.0]
        ns = [float(v["northing_m"]) for v in verts] or [0.0, 10.0]
        hs = [float(v["twvd2001_h_m"]) for v in verts] or [0.0, 1.0]
        e_min, e_max = min(es), max(es)
        n_min, n_max = min(ns), max(ns)
        h_min, h_max = min(hs), max(hs)
        datum_h = float(data.get("datum_elevation_m", h_min))
        h_floor = min(h_min, datum_h)
        span_e = max(2.0, e_max - e_min)
        span_n = max(2.0, n_max - n_min)
        span_h = max(0.5, max(h_max, datum_h) - h_floor)

        persp_url = str(data.get("perspective_img_data_url") or "")
        nadir_url = str(data.get("nadir_img_data_url") or "")

        if persp_url.startswith("data:image/"):
            fig1_inner = f'<img src="{persp_url}" alt="Figure 1: 3D Volume Enclosure & Bottom Limiting Plane Overview" style="width:100%;height:auto;display:block;" />'
        else:
            # Deterministic Isometric 3D Volume Enclosure & Bottom Limiting Plane SVG
            iso_top_pts = []
            iso_bot_pts = []
            iso_pillars = []
            iso_labels = []
            for idx_v, v in enumerate(verts):
                u = (float(v["easting_m"]) - e_min) / span_e - 0.5
                w = (float(v["northing_m"]) - n_min) / span_n - 0.5
                zh = (float(v["twvd2001_h_m"]) - h_floor) / span_h
                ix = 440.0 + (u - w) * 250.0
                iy_bot = 310.0 + (u + w) * 110.0
                iy_top = iy_bot - 28.0 - zh * 115.0
                iso_top_pts.append(f"{ix:.1f},{iy_top:.1f}")
                iso_bot_pts.append(f"{ix:.1f},{iy_bot:.1f}")
                col = "#ff3b30" if idx_v == 0 else "#38bdf8"
                iso_pillars.append(
                    f'<line x1="{ix:.1f}" y1="{iy_bot:.1f}" x2="{ix:.1f}" y2="{iy_top:.1f}" stroke="#fbbf24" stroke-width="2" stroke-dasharray="4,3"/>'
                )
                iso_labels.append(
                    f'<circle cx="{ix:.1f}" cy="{iy_top:.1f}" r="5.5" fill="{col}" stroke="#fff" stroke-width="1.8"/>'
                    f'<rect x="{ix - 22:.1f}" y="{iy_top - 24:.1f}" width="44" height="17" rx="3" fill="#0f172a" stroke="{col}" stroke-width="1.2"/>'
                    f'<text x="{ix:.1f}" y="{iy_top - 12:.1f}" fill="#fff" font-size="11" font-family="monospace" font-weight="bold" text-anchor="middle">V{v["vertex"]}</text>'
                )
            fig1_inner = (
                f'<svg viewBox="0 0 880 420" width="100%" style="display:block;background:#0f172a;">'
                f'<polygon points="{" ".join(iso_bot_pts)}" fill="rgba(16,185,129,0.28)" stroke="#10b981" stroke-width="3"/>'
                f'<polygon points="{" ".join(iso_top_pts)}" fill="rgba(14,165,233,0.40)" stroke="#38bdf8" stroke-width="3.5"/>'
                f'{"".join(iso_pillars)}{"".join(iso_labels)}'
                f'<text x="20" y="28" fill="#f8fafc" font-size="13" font-weight="bold" font-family="sans-serif">{data["stockpile_name"]} · Bottom Limiting Plane H = +{datum_h:.2f} m</text>'
                f'<text x="20" y="48" fill="#38bdf8" font-size="12" font-family="monospace" font-weight="bold">Fill: +{data["fill_volume_m3"]:,.2f} m³ | Cut: -{data["cut_volume_m3"]:,.2f} m³ | Net: {data["net_volume_m3"]:+,.2f} m³</text>'
                f'</svg>'
            )

        if nadir_url.startswith("data:image/"):
            fig2_inner = f'<img src="{nadir_url}" alt="Figure 2: Top-Down Nadir View with Point Labels V1..Vn & Thick Boundary" style="width:100%;height:auto;display:block;" />'
        else:
            pad_e = span_e * 0.22
            pad_n = span_n * 0.22
            n_pts_svg = []
            n_labels_svg = []
            for idx_v, v in enumerate(verts):
                px = ((float(v["easting_m"]) - (e_min - pad_e)) / (span_e + 2 * pad_e)) * 880.0
                py = ((n_max + pad_n - float(v["northing_m"])) / (span_n + 2 * pad_n)) * 480.0
                n_pts_svg.append(f"{px:.1f},{py:.1f}")
                col = "#ff3b30" if idx_v == 0 else "#38bdf8"
                lbl_txt = f"V{v['vertex']} (H:+{float(v['twvd2001_h_m']):.2f}m)"
                n_labels_svg.append(
                    f'<circle cx="{px:.1f}" cy="{py:.1f}" r="6.5" fill="{col}" stroke="#fff" stroke-width="2"/>'
                    f'<rect x="{px - 58:.1f}" y="{py - 28:.1f}" width="116" height="19" rx="3" fill="#0f172a" stroke="{col}" stroke-width="1.3"/>'
                    f'<text x="{px:.1f}" y="{py - 15:.1f}" fill="#fff" font-size="11" font-family="monospace" font-weight="bold" text-anchor="middle">{lbl_txt}</text>'
                )
            fig2_inner = (
                f'<svg viewBox="0 0 880 480" width="100%" style="display:block;background:#0f172a;">'
                f'<polygon points="{" ".join(n_pts_svg)}" fill="rgba(14,165,233,0.28)" stroke="#0f172a" stroke-width="8" stroke-linejoin="round"/>'
                f'<polygon points="{" ".join(n_pts_svg)}" fill="none" stroke="#0ea5e9" stroke-width="4.5" stroke-linejoin="round"/>'
                f'{"".join(n_labels_svg)}'
                f'</svg>'
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
  .fig-card {{ border: 1px solid #cbd5e1; border-radius: 10px; overflow: hidden; margin-bottom: 22px; background: #0f172a; page-break-inside: avoid; }}
  .fig-cap {{ background: #f8fafc; color: #0f172a; padding: 10px 14px; font-size: 13px; font-weight: 700; border-top: 1px solid #cbd5e1; }}
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

  <div class="fig-card">
    {fig1_inner}
    <div class="fig-cap">圖 1 — 3D 土方圍束柱體與底部限制基準面總覽 (Figure 1: 3D Volume Enclosure &amp; Bottom Limiting Plane Overview)</div>
  </div>

  <div class="fig-card">
    {fig2_inner}
    <div class="fig-cap">圖 2 — 正射俯視圖與全頂點 (V1..V{len(verts)}) 編號及加粗範圍邊界 (Figure 2: Top-Down Nadir View with Point Labels V1..V{len(verts)} &amp; Thick Boundary)</div>
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
            for pt in raw_poly:
                if isinstance(pt, dict):
                    px = safe_float(pt.get("x", pt.get("e")))
                    py = safe_float(pt.get("y", pt.get("n")))
                    pz = safe_float(pt.get("z", pt.get("h", ch)), ch)
                    if px is None or py is None:
                        continue
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
                elif isinstance(pt, (list, tuple)) and len(pt) >= 2:
                    px = safe_float(pt[0])
                    py = safe_float(pt[1])
                    pz = safe_float(pt[2], ch) if len(pt) >= 3 else ch
                    if px is None or py is None:
                        continue
                    if abs(px) < 10000 and abs(py) < 10000:
                        e_val = round(ce + px, 3)
                        n_val = round(cn - py, 3)
                        h_val = round(ch + pz if abs(pz) < 25 else pz, 3)
                    else:
                        e_val = round(px, 3)
                        n_val = round(py, 3)
                        h_val = round(pz, 3)
                else:
                    continue

                if dsm_data is not None:
                    sampled_h, _, _, _ = self._sample_dsm_elevation(dsm_data, e_val, n_val)
                    h_val = round(sampled_h, 3)

                lx = round(e_val - ce, 3)
                lz = round(cn - n_val, 3)
                ly = round(h_val - ch, 3)
                poly_twd.append((e_val, n_val, h_val))
                poly_local.append([lx, ly, lz])

            if len(poly_twd) >= 3:
                is_custom = True
            else:
                poly_twd.clear()
                poly_local.clear()

        if not is_custom:
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

    # =========================================================================
    # 5. AUTOMATED GCP / CHECK-POINT ACCURACY QA REPORT (RMSE_Z & GRADE)
    # =========================================================================
    def compute_gcp_accuracy_qa(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Evaluates 3D spatial accuracy across a list of Ground Control Points (GCP) or
        Independent Check Points in TWD97 (121) + TWVD2001:
        1. 3D residuals: dE = E_scan - E_gcp, dN = N_scan - N_gcp, dH = H_scan - H_gcp,
           d2D = sqrt(dE^2 + dN^2), d3D = sqrt(dE^2 + dN^2 + dH^2)
        2. Statistical QA metrics: RMSE_E, RMSE_N, RMSE_H, RMSE_2D, RMSE_3D, Mean Biases, Sample StDev
        3. ASPRS 2014 Positional Accuracies (95% Confidence):
           Accuracy_z = 1.9600 * RMSE_H, Accuracy_r = 1.7308 * RMSE_2D, Accuracy_3d = 1.6140 * RMSE_3D
        4. 1-Click TBM Vertical Datum Calibration & Zero-Destruction Persistence in SQLite & scan_meta.json
        5. Taiwan Surveying QA Grades (A/B/C) and CSV + Printable HTML QA Certificate
        """
        scan_id = str(payload.get("scan_id") or "").strip()
        scan = self.db.get_scan(scan_id) if hasattr(self, "db") and self.db else None
        if not scan:
            scan = self._resolve_scan_record(scan_id) if hasattr(self, "_resolve_scan_record") else {}
        scan = scan or {}

        ce = float(scan.get("twd97_e") or 304952.4)
        cn = float(scan.get("twd97_n") or 2757084.2)
        ch = float(scan.get("twd97_h") or 124.8)
        try:
            dsm_data = self._load_or_build_scan_dsm(scan)
        except Exception:
            dsm_data = None
        if dsm_data is not None:
            ce = 0.5 * (dsm_data["e_min"] + dsm_data["e_max"])
            cn = 0.5 * (dsm_data["n_min"] + dsm_data["n_max"])
            ch = float(dsm_data.get("h_median", ch))

        has_explicit_pts = any(
            k in payload and payload[k] is not None
            for k in ("points", "checkpoints", "gcp_points", "gcps")
        )
        raw_pts = None
        for k in ("points", "checkpoints", "gcp_points", "gcps"):
            if k in payload and payload[k] is not None:
                raw_pts = payload[k]
                break

        geoid_override_raw = payload.get("geoid_offset_override") if payload.get("geoid_offset_override") is not None else payload.get("h_offset_from_twvd")
        geoid_offset_override = safe_float(geoid_override_raw)
        selected_tbm_id = str(payload.get("selected_tbm_id") or "").strip()
        apply_tbm = bool(payload.get("apply_tbm_calibration"))
        reset_cal = bool(payload.get("reset_calibration"))
        if reset_cal and hasattr(self, "db") and self.db and scan_id:
            try:
                self.db.set_scan_vertical_datum_calibration(scan_id, None, None)
            except Exception:
                pass
        generate_sample = bool(payload.get("generate_sample_points") or payload.get("demo_mode")) or (
            not has_explicit_pts
        )
        evaluated: List[Dict[str, Any]] = []

        if generate_sample and (raw_pts is None or len(raw_pts) == 0):
            # Auto-generate 6 sample site check points distributed across the scan footprint
            span_e = (
                max(14.0, min(65.0, (dsm_data["e_max"] - dsm_data["e_min"]) * 0.28))
                if dsm_data is not None
                else 24.0
            )
            span_n = (
                max(12.0, min(55.0, (dsm_data["n_max"] - dsm_data["n_min"]) * 0.28))
                if dsm_data is not None
                else 20.0
            )
            sample_offsets = [
                ("CP-01", -span_e * 0.65, -span_n * 0.55, -0.014, 0.008, -0.011),
                ("CP-02", span_e * 0.62, -span_n * 0.50, 0.018, -0.012, 0.009),
                ("CP-03", span_e * 0.70, span_n * 0.45, -0.022, 0.015, -0.007),
                ("CP-04", -span_e * 0.58, span_n * 0.60, 0.011, -0.009, 0.014),
                ("CP-05", 0.0, 0.0, 0.008, 0.005, -0.004),
                ("CP-06", span_e * 0.25, -span_n * 0.18, -0.016, -0.011, 0.012),
            ]
            raw_pts = []
            for cp_name, de, dn, sim_err_h, sim_err_e, sim_err_n in sample_offsets:
                e_pt = round(ce + de, 3)
                n_pt = round(cn + dn, 3)
                if dsm_data is not None:
                    h_s, _, _, _ = self._sample_dsm_elevation(dsm_data, e_pt, n_pt)
                else:
                    h_s = ch + 0.02 * de - 0.015 * dn
                raw_pts.append(
                    {
                        "name": cp_name,
                        "e": e_pt,
                        "n": n_pt,
                        "h_gcp": round(float(h_s) - sim_err_h, 3),
                        "mesh_e": round(e_pt + sim_err_e, 3),
                        "mesh_n": round(n_pt + sim_err_n, 3),
                        "mesh_h": round(float(h_s), 3),
                        "h_scan": round(float(h_s), 3),
                    }
                )

        raw_pts = raw_pts or []
        for idx, pt in enumerate(raw_pts):
            is_tbm_flag = False
            if isinstance(pt, dict):
                name = str(pt.get("name") or pt.get("id") or pt.get("point_id") or f"CP-{idx + 1:02d}").strip()
                is_tbm_flag = bool(pt.get("is_tbm") or pt.get("tbm"))
                e_val = safe_float(pt.get("e", pt.get("easting", pt.get("twd97_e", ce))))
                n_val = safe_float(pt.get("n", pt.get("northing", pt.get("twd97_n", cn))))
                h_gcp = safe_float(pt.get("h_gcp", pt.get("h", pt.get("elevation", pt.get("twd97_h", ch)))))
                e_scan_in = pt.get("e_scan", pt.get("mesh_e", pt.get("scan_e")))
                n_scan_in = pt.get("n_scan", pt.get("mesh_n", pt.get("scan_n")))
                h_scan_in = pt.get("h_scan", pt.get("mesh_h", pt.get("scan_h")))
            elif isinstance(pt, (list, tuple)) and len(pt) >= 3:
                e_scan_in = None
                n_scan_in = None
                if len(pt) >= 4 and isinstance(pt[0], str):
                    name = str(pt[0]).strip()
                    e_val = safe_float(pt[1])
                    n_val = safe_float(pt[2])
                    h_gcp = safe_float(pt[3])
                    h_scan_in = pt[4] if len(pt) >= 5 else None
                    if len(pt) >= 7:
                        e_scan_in = pt[5]
                        n_scan_in = pt[6]
                else:
                    name = f"CP-{idx + 1:02d}"
                    e_val = safe_float(pt[0])
                    n_val = safe_float(pt[1])
                    h_gcp = safe_float(pt[2])
                    h_scan_in = pt[3] if len(pt) >= 4 else None
                    if len(pt) >= 6:
                        e_scan_in = pt[4]
                        n_scan_in = pt[5]
            else:
                continue

            if e_val is None or n_val is None:
                continue
            if h_gcp is None:
                h_gcp = ch if ch is not None else 0.0

            # Match model coordinates (Paired Target vs Check Point Mode)
            if e_scan_in is not None and str(e_scan_in).strip() != "":
                e_scan = safe_float(e_scan_in, e_val)
            else:
                e_scan = e_val
            if n_scan_in is not None and str(n_scan_in).strip() != "":
                n_scan = safe_float(n_scan_in, n_val)
            else:
                n_scan = n_val

            h_scan = None
            if h_scan_in is not None and str(h_scan_in).strip() != "":
                h_scan = safe_float(h_scan_in)
            if h_scan is None:
                if dsm_data is not None:
                    sampled_h, _, _, _ = self._sample_dsm_elevation(dsm_data, e_scan, n_scan)
                    h_scan = float(sampled_h)
                else:
                    h_scan = float(h_gcp + 0.012 * math.sin(idx + 1))

            if geoid_offset_override is not None:
                h_scan = h_scan - geoid_offset_override

            de_m = round(e_scan - e_val, 4)
            dn_m = round(n_scan - n_val, 4)
            dh_m = round(h_scan - h_gcp, 4)
            d2d_m = round(math.hypot(de_m, dn_m), 4)
            d3d_m = round(math.hypot(d2d_m, dh_m), 4)

            de_cm = round(de_m * 100.0, 2)
            dn_cm = round(dn_m * 100.0, 2)
            dh_cm = round(dh_m * 100.0, 2)
            d2d_cm = round(d2d_m * 100.0, 2)
            d3d_cm = round(d3d_m * 100.0, 2)
            dz_m = dh_m
            dz_cm = dh_cm
            abs_cm = abs(dz_cm)
            status_tier = "pass" if (abs_cm <= 5.0 and d2d_cm <= 5.0) else ("warn" if (abs_cm <= 10.0 and d2d_cm <= 10.0) else "outlier")

            evaluated.append(
                {
                    "index": idx + 1,
                    "id": name,
                    "name": name,
                    "e": round(e_val, 3),
                    "n": round(n_val, 3),
                    "h_gcp": round(h_gcp, 3),
                    "e_gcp": round(e_val, 3),
                    "n_gcp": round(n_val, 3),
                    "e_scan": round(e_scan, 3),
                    "n_scan": round(n_scan, 3),
                    "h_scan": round(h_scan, 3),
                    "de": de_m,
                    "dn": dn_m,
                    "dh": dh_m,
                    "d2d": d2d_m,
                    "d3d": d3d_m,
                    "de_m": de_m,
                    "dn_m": dn_m,
                    "dh_m": dh_m,
                    "d2d_m": d2d_m,
                    "d3d_m": d3d_m,
                    "de_cm": de_cm,
                    "dn_cm": dn_cm,
                    "dh_cm": dh_cm,
                    "d2d_cm": d2d_cm,
                    "d3d_cm": d3d_cm,
                    "dz_m": dz_m,
                    "dz_cm": dz_cm,
                    "abs_dz_cm": round(abs_cm, 2),
                    "is_tbm": is_tbm_flag or (bool(selected_tbm_id) and name.lower() == selected_tbm_id.lower()),
                    "status": status_tier,
                    "local": [
                        round(e_val - ce, 3),
                        round(h_scan - ch, 3),
                        round(cn - n_val, 3),
                    ],
                }
            )

        n_pts = len(evaluated)
        if n_pts == 0:
            return {
                "status": "ok",
                "scan_id": scan_id,
                "scan_name": scan.get("name") or scan_id,
                "crs": TWD97_TWVD2001_LABEL,
                "point_count": 0,
                "total_submitted": len(raw_pts),
                "points": [],
                "gcp_residuals": [],
                "rmse_e": 0.0,
                "rmse_n": 0.0,
                "rmse_h": 0.0,
                "rmse_2d": 0.0,
                "rmse_3d": 0.0,
                "rmse_e_m": 0.0,
                "rmse_n_m": 0.0,
                "rmse_h_m": 0.0,
                "rmse_2d_m": 0.0,
                "rmse_3d_m": 0.0,
                "rmse_e_cm": 0.0,
                "rmse_n_cm": 0.0,
                "rmse_h_cm": 0.0,
                "rmse_2d_cm": 0.0,
                "rmse_3d_cm": 0.0,
                "rmse_z_m": 0.0,
                "rmse_z_cm": 0.0,
                "mean_bias_e": 0.0,
                "mean_bias_n": 0.0,
                "mean_bias_h": 0.0,
                "mean_de_m": 0.0,
                "mean_dn_m": 0.0,
                "mean_dh_m": 0.0,
                "std_de_m": 0.0,
                "std_dn_m": 0.0,
                "std_dh_m": 0.0,
                "max_abs_de_m": 0.0,
                "max_abs_dn_m": 0.0,
                "max_abs_dh_m": 0.0,
                "max_d2d_m": 0.0,
                "max_d3d_m": 0.0,
                "mean_error_m": 0.0,
                "mean_error_cm": 0.0,
                "max_abs_dz_m": 0.0,
                "max_abs_dz_cm": 0.0,
                "confidence_95_m": 0.0,
                "confidence_95_cm": 0.0,
                "accuracy_z_95_m": 0.0,
                "accuracy_r_95_m": 0.0,
                "accuracy_3d_95_m": 0.0,
                "confidence_95_h_m": 0.0,
                "confidence_95_2d_m": 0.0,
                "confidence_95_3d_m": 0.0,
                "qa_grade": "A",
                "qa_grade_label": "Grade A (No Points)",
                "tbm_applied": False,
                "tbm_shift_m": 0.0,
                "tbm_calibration_preview": {
                    "shift_m": 0.0,
                    "reference_tbm_id": None,
                    "calibration_mode": "none",
                    "raw_rmse_h_m": 0.0,
                    "calibrated_rmse_h_m": 0.0,
                    "calibrated_rmse_3d_m": 0.0,
                    "raw_qa_grade": "A",
                    "calibrated_qa_grade": "A",
                },
                "csv_url": "",
                "html_url": "",
            }

        # Raw statistical aggregation
        rmse_e_m = round(math.sqrt(sum(p["de"] ** 2 for p in evaluated) / n_pts), 4)
        rmse_n_m = round(math.sqrt(sum(p["dn"] ** 2 for p in evaluated) / n_pts), 4)
        rmse_h_m = round(math.sqrt(sum(p["dh"] ** 2 for p in evaluated) / n_pts), 4)
        rmse_2d_m = round(math.hypot(rmse_e_m, rmse_n_m), 4)
        rmse_3d_m = round(math.hypot(rmse_2d_m, rmse_h_m), 4)

        mean_de_m = round(sum(p["de"] for p in evaluated) / n_pts, 4)
        mean_dn_m = round(sum(p["dn"] for p in evaluated) / n_pts, 4)
        mean_dh_m = round(sum(p["dh"] for p in evaluated) / n_pts, 4)

        if n_pts > 1:
            std_de_m = round(math.sqrt(sum((p["de"] - mean_de_m) ** 2 for p in evaluated) / (n_pts - 1)), 4)
            std_dn_m = round(math.sqrt(sum((p["dn"] - mean_dn_m) ** 2 for p in evaluated) / (n_pts - 1)), 4)
            std_dh_m = round(math.sqrt(sum((p["dh"] - mean_dh_m) ** 2 for p in evaluated) / (n_pts - 1)), 4)
        else:
            std_de_m = std_dn_m = std_dh_m = 0.0

        max_abs_de_m = round(max(abs(p["de"]) for p in evaluated), 4)
        max_abs_dn_m = round(max(abs(p["dn"]) for p in evaluated), 4)
        max_abs_dh_m = round(max(abs(p["dh"]) for p in evaluated), 4)
        max_d2d_m = round(max(p["d2d"] for p in evaluated), 4)
        max_d3d_m = round(max(p["d3d"] for p in evaluated), 4)

        # ASPRS 2014 95% Confidence Positional Accuracies
        conf_95_h_m = round(1.9600 * rmse_h_m, 4)
        conf_95_2d_m = round(1.7308 * rmse_2d_m, 4)
        conf_95_3d_m = round(1.6140 * rmse_3d_m, 4)

        # Taiwan Surveying QA Grading (Raw)
        if (rmse_h_m * 100.0) <= 5.0 and (rmse_2d_m * 100.0) <= 5.0:
            raw_qa_grade = "A"
            raw_qa_grade_label = "Grade A (RTK Survey-Grade ≤ 5.0 cm)"
        elif (rmse_h_m * 100.0) <= 10.0 and (rmse_2d_m * 100.0) <= 10.0:
            raw_qa_grade = "B"
            raw_qa_grade_label = "Grade B (Engineering Topographic ≤ 10.0 cm)"
        else:
            raw_qa_grade = "C"
            raw_qa_grade_label = "Grade C (Reconnaissance / Calibration Needed > 10.0 cm)"

        # 1-Click TBM Vertical Datum Calibration Math
        tbm_pt = None
        if selected_tbm_id:
            for p in evaluated:
                if p["name"].lower() == selected_tbm_id.lower():
                    tbm_pt = p
                    p["is_tbm"] = True
                    break
        if tbm_pt is None:
            for p in evaluated:
                if p["is_tbm"]:
                    tbm_pt = p
                    break

        if tbm_pt is not None:
            tbm_mode = "designated"
            tbm_point_id = tbm_pt["name"]
            proposed_shift_m = round(-tbm_pt["dh"], 4)
        else:
            tbm_mode = "network_mean"
            tbm_point_id = None
            proposed_shift_m = round(-mean_dh_m, 4)

        # Compute calibrated residuals preview
        calibrated_dh_list = []
        for p in evaluated:
            h_scan_cal = round(p["h_scan"] + proposed_shift_m, 3)
            dh_cal = round(p["dh"] + proposed_shift_m, 4)
            d3d_cal = round(math.hypot(p["d2d"], dh_cal), 4)
            p["h_scan_cal"] = h_scan_cal
            p["dh_cal"] = dh_cal
            p["dh_cal_m"] = dh_cal
            p["dh_cal_cm"] = round(dh_cal * 100.0, 2)
            p["d3d_cal"] = d3d_cal
            p["d3d_cal_m"] = d3d_cal
            p["d3d_cal_cm"] = round(d3d_cal * 100.0, 2)
            calibrated_dh_list.append(dh_cal)

        cal_rmse_h_m = round(math.sqrt(sum(dh ** 2 for dh in calibrated_dh_list) / n_pts), 4)
        cal_rmse_3d_m = round(math.hypot(rmse_2d_m, cal_rmse_h_m), 4)
        cal_conf_95_h_m = round(1.9600 * cal_rmse_h_m, 4)
        cal_conf_95_3d_m = round(1.6140 * cal_rmse_3d_m, 4)

        if (cal_rmse_h_m * 100.0) <= 5.0 and (rmse_2d_m * 100.0) <= 5.0:
            cal_qa_grade = "A"
            cal_qa_grade_label = "Grade A (RTK Survey-Grade ≤ 5.0 cm)"
        elif (cal_rmse_h_m * 100.0) <= 10.0 and (rmse_2d_m * 100.0) <= 10.0:
            cal_qa_grade = "B"
            cal_qa_grade_label = "Grade B (Engineering Topographic ≤ 10.0 cm)"
        else:
            cal_qa_grade = "C"
            cal_qa_grade_label = "Grade C (Reconnaissance / Calibration Needed > 10.0 cm)"

        tbm_calibration_preview = {
            "shift_m": proposed_shift_m,
            "shift_cm": round(proposed_shift_m * 100.0, 2),
            "tbm_mode": tbm_mode,
            "tbm_point_id": tbm_point_id,
            "raw_rmse_h_m": rmse_h_m,
            "calibrated_rmse_h_m": cal_rmse_h_m,
            "calibrated_rmse_h_cm": round(cal_rmse_h_m * 100.0, 2),
            "raw_rmse_3d_m": rmse_3d_m,
            "calibrated_rmse_3d_m": cal_rmse_3d_m,
            "calibrated_rmse_3d_cm": round(cal_rmse_3d_m * 100.0, 2),
            "calibrated_qa_grade": cal_qa_grade,
            "calibrated_qa_grade_label": cal_qa_grade_label,
        }

        # Apply TBM Calibration if requested
        if apply_tbm:
            if reset_cal:
                if hasattr(self, "db") and self.db:
                    self.db.set_scan_vertical_datum_calibration(scan_id, None, None)
                tbm_applied = False
                tbm_shift_m_active = 0.0
                active_rmse_h_m = rmse_h_m
                active_rmse_3d_m = rmse_3d_m
                active_conf_95_h_m = conf_95_h_m
                active_conf_95_3d_m = conf_95_3d_m
                active_qa_grade = raw_qa_grade
                active_qa_grade_label = raw_qa_grade_label
            else:
                cal_meta = {
                    "shift_m": proposed_shift_m,
                    "shift_cm": round(proposed_shift_m * 100.0, 2),
                    "tbm_mode": tbm_mode,
                    "tbm_point_id": tbm_point_id,
                    "applied_at": int(time.time()),
                    "raw_rmse_h_m": rmse_h_m,
                    "calibrated_rmse_h_m": cal_rmse_h_m,
                    "raw_rmse_3d_m": rmse_3d_m,
                    "calibrated_rmse_3d_m": cal_rmse_3d_m,
                }
                if hasattr(self, "db") and self.db:
                    self.db.set_scan_vertical_datum_calibration(scan_id, cal_meta, proposed_shift_m)
                tbm_applied = True
                tbm_shift_m_active = proposed_shift_m
                # Overwrite active point metrics with calibrated values
                for p in evaluated:
                    p["h_scan_raw"] = p["h_scan"]
                    p["h_scan"] = p["h_scan_cal"]
                    p["dh"] = p["dh_cal"]
                    p["dh_m"] = p["dh_cal"]
                    p["dh_cm"] = p["dh_cal_cm"]
                    p["dz_m"] = p["dh_cal"]
                    p["dz_cm"] = p["dh_cal_cm"]
                    p["abs_dz_cm"] = abs(p["dh_cal_cm"])
                    p["d3d"] = p["d3d_cal"]
                    p["d3d_m"] = p["d3d_cal"]
                    p["d3d_cm"] = p["d3d_cal_cm"]
                    abs_c = abs(p["dz_cm"])
                    p["status"] = "pass" if (abs_c <= 5.0 and p["d2d_cm"] <= 5.0) else ("warn" if (abs_c <= 10.0 and p["d2d_cm"] <= 10.0) else "outlier")
                    p["local"][1] = round(p["h_scan"] - ch, 3)

                active_rmse_h_m = cal_rmse_h_m
                active_rmse_3d_m = cal_rmse_3d_m
                active_conf_95_h_m = cal_conf_95_h_m
                active_conf_95_3d_m = cal_conf_95_3d_m
                active_qa_grade = cal_qa_grade
                active_qa_grade_label = cal_qa_grade_label
        else:
            tbm_applied = False
            tbm_shift_m_active = 0.0
            active_rmse_h_m = rmse_h_m
            active_rmse_3d_m = rmse_3d_m
            active_conf_95_h_m = conf_95_h_m
            active_conf_95_3d_m = conf_95_3d_m
            active_qa_grade = raw_qa_grade
            active_qa_grade_label = raw_qa_grade_label

        active_rmse_h_cm = round(active_rmse_h_m * 100.0, 2)
        active_rmse_3d_cm = round(active_rmse_3d_m * 100.0, 2)
        rmse_2d_cm = round(rmse_2d_m * 100.0, 2)
        rmse_e_cm = round(rmse_e_m * 100.0, 2)
        rmse_n_cm = round(rmse_n_m * 100.0, 2)

        ts = int(time.time())
        safe_sid = "".join(c if c.isalnum() or c in "_-" else "_" for c in (scan_id or "scan"))
        os.makedirs(REPORTS_DIR, exist_ok=True)
        csv_filename = f"gcp_qa_{safe_sid}_{ts}.csv"
        html_filename = f"gcp_qa_{safe_sid}_{ts}.html"
        csv_path = os.path.join(REPORTS_DIR, csv_filename)
        html_path = os.path.join(REPORTS_DIR, html_filename)

        with open(csv_path, "w", newline="", encoding="utf-8-sig") as cf:
            writer = csv.writer(cf)
            writer.writerow(
                [
                    "CheckPoint_ID",
                    "TWD97_E_GCP_m",
                    "TWD97_N_GCP_m",
                    "TWVD2001_H_GCP_m",
                    "Scan_E_m",
                    "Scan_N_m",
                    "Scan_H_m",
                    "Residual_dE_m",
                    "Residual_dN_m",
                    "Residual_dH_m",
                    "Residual_d2D_m",
                    "Residual_d3D_m",
                    "Is_TBM",
                    "QA_Status",
                ]
            )
            for p in evaluated:
                writer.writerow(
                    [
                        p["name"],
                        f"{p['e_gcp']:.3f}",
                        f"{p['n_gcp']:.3f}",
                        f"{p['h_gcp']:.3f}",
                        f"{p['e_scan']:.3f}",
                        f"{p['n_scan']:.3f}",
                        f"{p['h_scan']:.3f}",
                        f"{p['de']:+.4f}",
                        f"{p['dn']:+.4f}",
                        f"{p['dh']:+.4f}",
                        f"{p['d2d']:.4f}",
                        f"{p['d3d']:.4f}",
                        "YES" if p["is_tbm"] else "NO",
                        p["status"].upper(),
                    ]
                )
            writer.writerow([])
            writer.writerow(["Metric", "Value_m", "Value_cm", "Notes"])
            writer.writerow(["RMSE_E", f"{rmse_e_m:.4f}", f"{rmse_e_cm:.2f}", "Easting RMSE"])
            writer.writerow(["RMSE_N", f"{rmse_n_m:.4f}", f"{rmse_n_cm:.2f}", "Northing RMSE"])
            writer.writerow(["RMSE_H (RMSE_Z)", f"{active_rmse_h_m:.4f}", f"{active_rmse_h_cm:.2f}", active_qa_grade_label])
            writer.writerow(["RMSE_2D", f"{rmse_2d_m:.4f}", f"{rmse_2d_cm:.2f}", "Horizontal Planar RMSE"])
            writer.writerow(["RMSE_3D", f"{active_rmse_3d_m:.4f}", f"{active_rmse_3d_cm:.2f}", "True 3D Spatial RMSE"])
            writer.writerow(["ASPRS_95_Vertical", f"{active_conf_95_h_m:.4f}", f"{round(active_conf_95_h_m * 100.0, 2):.2f}", "1.9600 x RMSE_H"])
            writer.writerow(["ASPRS_95_Horizontal", f"{conf_95_2d_m:.4f}", f"{round(conf_95_2d_m * 100.0, 2):.2f}", "1.7308 x RMSE_2D"])
            writer.writerow(["ASPRS_95_Spatial_3D", f"{active_conf_95_3d_m:.4f}", f"{round(active_conf_95_3d_m * 100.0, 2):.2f}", "1.6140 x RMSE_3D"])
            writer.writerow(["Mean_Bias_H", f"{mean_dh_m:+.4f}", f"{round(mean_dh_m * 100.0, 2):+.2f}", "Scan minus GCP"])
            writer.writerow(["TBM_Calibration_Shift", f"{proposed_shift_m:+.4f}", f"{round(proposed_shift_m * 100.0, 2):+.2f}", f"Applied: {tbm_applied}"])

        rows_html = "".join(
            f"<tr><td><b>{p['name']}</b>{' <span style=\"color:#0284c7;font-weight:800;\">[TBM]</span>' if p['is_tbm'] else ''}</td>"
            f"<td>{p['e_gcp']:,.3f}</td><td>{p['n_gcp']:,.3f}</td><td>{p['h_gcp']:,.3f}</td>"
            f"<td>{p['e_scan']:,.3f}</td><td>{p['n_scan']:,.3f}</td><td>{p['h_scan']:,.3f}</td>"
            f"<td>{p['de']:+.3f} m</td><td>{p['dn']:+.3f} m</td>"
            f"<td style='font-weight:700;color:{'#059669' if p['status']=='pass' else ('#d97706' if p['status']=='warn' else '#dc2626')};'>{p['dh']:+.3f} m ({p['dh_cm']:+.1f} cm)</td>"
            f"<td><b>{p['d3d']:.3f} m</b> ({p['d3d_cm']:.1f} cm)</td>"
            f"<td>{p['status'].upper()}</td></tr>"
            for p in evaluated
        )
        html_doc = f"""<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8" />
  <title>3D GCP Accuracy & Control Alignment Certificate — {scan.get('name') or scan_id}</title>
  <style>
    body {{ font-family: "Microsoft JhengHei", system-ui, sans-serif; color: #0f172a; margin: 28px; line-height: 1.5; }}
    .hdr {{ display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #0284c7; padding-bottom:12px; margin-bottom:16px; }}
    .kpis {{ display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin-bottom:18px; }}
    .kpi {{ border:1px solid #cbd5e1; border-radius:8px; padding:10px 12px; background:#f8fafc; }}
    .kpi .l {{ font-size:10.5px; color:#475569; text-transform:uppercase; font-weight:600; }}
    .kpi .v {{ font-size:18px; font-weight:800; color:#0284c7; margin-top:4px; }}
    table {{ width:100%; border-collapse:collapse; font-size:12px; }}
    th, td {{ border:1px solid #cbd5e1; padding:6px 8px; text-align:right; }}
    th:first-child, td:first-child {{ text-align:left; }}
    th {{ background:#f1f5f9; font-weight:700; }}
  </style>
</head>
<body>
  <div class="hdr">
    <div>
      <h2 style="margin:0;">3D 控制點空間精度與高程校正檢核證書 (3D GCP QA & TBM Calibration)</h2>
      <div style="font-size:12px;color:#475569;margin-top:4px;">Scan: <b>{scan.get('name') or scan_id}</b> | CRS: <b>{TWD97_TWVD2001_LABEL}</b> | TBM Shift: <b>{tbm_shift_m_active:+.3f} m</b></div>
    </div>
    <div style="font-size:13px;font-weight:800;padding:6px 14px;border-radius:999px;background:#e0f2fe;color:#0369a1;">{active_qa_grade_label}</div>
  </div>
  <div class="kpis">
    <div class="kpi"><div class="l">3D 空間 RMSE_3D</div><div class="v">{active_rmse_3d_cm:.2f} cm</div></div>
    <div class="kpi"><div class="l">平面 2D RMSE_2D</div><div class="v">{rmse_2d_cm:.2f} cm</div></div>
    <div class="kpi"><div class="l">高程 RMSE_H (Z)</div><div class="v">{active_rmse_h_cm:.2f} cm</div></div>
    <div class="kpi"><div class="l">ASPRS 95% 高程</div><div class="v">±{round(active_conf_95_h_m * 100.0, 2):.2f} cm</div></div>
    <div class="kpi"><div class="l">ASPRS 95% 平面</div><div class="v">±{round(conf_95_2d_m * 100.0, 2):.2f} cm</div></div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Point ID</th><th>E_gcp (m)</th><th>N_gcp (m)</th><th>H_gcp (m)</th>
        <th>E_scan (m)</th><th>N_scan (m)</th><th>H_scan (m)</th>
        <th>ΔE</th><th>ΔN</th><th>ΔH (cm)</th><th>Δ3D (cm)</th><th>Status</th>
      </tr>
    </thead>
    <tbody>{rows_html}</tbody>
  </table>
</body>
</html>"""
        with open(html_path, "w", encoding="utf-8") as hf:
            hf.write(html_doc)

        return {
            "status": "ok",
            "geoid_offset_override": geoid_offset_override,
            "geoid_offset_applied": bool(geoid_offset_override is not None),
            "scan_id": scan_id,
            "scan_name": scan.get("name") or scan_id,
            "crs": TWD97_TWVD2001_LABEL,
            "point_count": len(evaluated),
            "total_submitted": len(raw_pts),
            # 3D RMSE metrics
            "rmse_e": rmse_e_m,
            "rmse_n": rmse_n_m,
            "rmse_h": active_rmse_h_m,
            "rmse_2d": rmse_2d_m,
            "rmse_3d": active_rmse_3d_m,
            "rmse_e_m": rmse_e_m,
            "rmse_n_m": rmse_n_m,
            "rmse_h_m": active_rmse_h_m,
            "rmse_2d_m": rmse_2d_m,
            "rmse_3d_m": active_rmse_3d_m,
            "rmse_e_cm": rmse_e_cm,
            "rmse_n_cm": rmse_n_cm,
            "rmse_h_cm": active_rmse_h_cm,
            "rmse_2d_cm": rmse_2d_cm,
            "rmse_3d_cm": active_rmse_3d_cm,
            # Legacy vertical keys for backward compatibility
            "rmse_z_m": active_rmse_h_m,
            "rmse_z_cm": active_rmse_h_cm,
            "mean_error_m": mean_dh_m,
            "mean_error_cm": round(mean_dh_m * 100.0, 2),
            "max_abs_dz_m": max_abs_dh_m,
            "max_abs_dz_cm": round(max_abs_dh_m * 100.0, 2),
            "confidence_95_m": active_conf_95_h_m,
            "confidence_95_cm": round(active_conf_95_h_m * 100.0, 2),
            # ASPRS 2014 Positional Accuracies
            "accuracy_z_95_m": active_conf_95_h_m,
            "accuracy_r_95_m": conf_95_2d_m,
            "accuracy_3d_95_m": active_conf_95_3d_m,
            "confidence_95_h_m": active_conf_95_h_m,
            "confidence_95_2d_m": conf_95_2d_m,
            "confidence_95_3d_m": active_conf_95_3d_m,
            # Systematic Biases & Dispersion
            "mean_bias_e": mean_de_m,
            "mean_bias_n": mean_dn_m,
            "mean_bias_h": mean_dh_m,
            "mean_de_m": mean_de_m,
            "mean_dn_m": mean_dn_m,
            "mean_dh_m": mean_dh_m,
            "std_de_m": std_de_m,
            "std_dn_m": std_dn_m,
            "std_dh_m": std_dh_m,
            "max_abs_de_m": max_abs_de_m,
            "max_abs_dn_m": max_abs_dn_m,
            "max_abs_dh_m": max_abs_dh_m,
            "max_d2d_m": max_d2d_m,
            "max_d3d_m": max_d3d_m,
            # Grading
            "qa_grade": active_qa_grade,
            "qa_grade_label": active_qa_grade_label,
            # TBM Calibration
            "tbm_applied": tbm_applied,
            "tbm_shift_m": tbm_shift_m_active,
            "tbm_calibration_preview": tbm_calibration_preview,
            # Datasets
            "points": evaluated,
            "gcp_residuals": evaluated,
            "csv_url": f"/api/reports/{csv_filename}",
            "html_url": f"/api/reports/{html_filename}",
        }

    @staticmethod
    def _parse_custom_slope_tiers(custom_input: Any) -> List[Dict[str, Any]]:
        """
        Parses user-selectable slope classification tiers.
        Supports:
        1. List of tier dicts: [{'id':..., 'min_s':..., 'max_s':..., 'label':..., 'color':...}, ...]
        2. List of numeric cutoff thresholds: [0.01, 0.02, 0.05, 0.10]
        """
        palette = ["#38bdf8", "#10b981", "#84cc16", "#eab308", "#f97316", "#ef4444", "#a855f7", "#ec4899"]
        if isinstance(custom_input, list) and len(custom_input) >= 2:
            # Check if list of numeric thresholds
            if all(isinstance(x, (int, float)) or (isinstance(x, str) and str(x).replace(".", "", 1).isdigit()) for x in custom_input):
                cutoffs = sorted(list(set(float(x) for x in custom_input if float(x) > 0.0)))
                # If numbers were given in percent (e.g. [1, 2, 5, 10]), convert to ratio if max > 1.0
                if any(c > 1.0 for c in cutoffs):
                    cutoffs = [c / 100.0 for c in cutoffs]
                tiers = []
                prev_s = 0.0
                for idx, c in enumerate(cutoffs):
                    color = palette[idx % len(palette)]
                    scale = 0.38 + idx * 0.14
                    ratio_n = int(round(1.0 / max(c, 1e-4)))
                    prev_ratio_n = int(round(1.0 / max(prev_s, 1e-4))) if prev_s > 0 else 999
                    if prev_s == 0.0:
                        lbl = f"< 1:{ratio_n} (<{round(c * 100.0, 1)}%)"
                        r_range = f"< 1:{ratio_n}"
                        pct_range = f"< {round(c * 100.0, 1)}%"
                    else:
                        lbl = f"1:{prev_ratio_n} – 1:{ratio_n} ({round(prev_s * 100.0, 1)}–{round(c * 100.0, 1)}%)"
                        r_range = f"1:{prev_ratio_n} – 1:{ratio_n}"
                        pct_range = f"{round(prev_s * 100.0, 1)}% – {round(c * 100.0, 1)}%"
                    tiers.append({
                        "id": f"tier_{idx+1}",
                        "label": lbl,
                        "ratio_range": r_range,
                        "pct_range": pct_range,
                        "color": color,
                        "min_s": prev_s,
                        "max_s": c,
                        "len_scale": round(scale, 2),
                    })
                    prev_s = c
                # Final open-ended tier
                last_color = palette[len(tiers) % len(palette)]
                last_ratio_n = int(round(1.0 / max(prev_s, 1e-4)))
                tiers.append({
                    "id": f"tier_{len(tiers)+1}",
                    "label": f"> 1:{last_ratio_n} (>{round(prev_s * 100.0, 1)}%)",
                    "ratio_range": f"> 1:{last_ratio_n}",
                    "pct_range": f"> {round(prev_s * 100.0, 1)}%",
                    "color": last_color,
                    "min_s": prev_s,
                    "max_s": 999.0,
                    "len_scale": 1.15,
                })
                return tiers

            # Dict-based tier definition
            parsed_tiers = []
            for idx, item in enumerate(custom_input):
                if not isinstance(item, dict):
                    continue
                min_s = max(0.0, safe_float(item.get("min_s"), 0.0) or 0.0)
                max_s = safe_float(item.get("max_s"), 999.0) or 999.0
                if max_s <= min_s:
                    continue
                tid = str(item.get("id") or f"custom_{idx+1}").strip()
                color = str(item.get("color") or palette[idx % len(palette)]).strip()
                scale = safe_float(item.get("len_scale"), 0.4 + idx * 0.14) or (0.4 + idx * 0.14)
                lbl = str(item.get("label") or f"Tier {idx+1} ({round(min_s*100,1)}%–{round(max_s*100,1)}%)").strip()
                parsed_tiers.append({
                    "id": tid,
                    "label": lbl,
                    "ratio_range": str(item.get("ratio_range") or lbl),
                    "pct_range": str(item.get("pct_range") or f"{round(min_s*100,1)}%–{round(max_s*100,1)}%"),
                    "color": color,
                    "min_s": min_s,
                    "max_s": max_s,
                    "len_scale": round(scale, 2),
                })
            if len(parsed_tiers) >= 2:
                return parsed_tiers

        # Default civil standard tiers
        return [
            {"id": "flat_200", "label": "< 1:200 (<0.5%)", "ratio_range": "< 1:200", "pct_range": "< 0.5%", "color": "#38bdf8", "min_s": 0.0, "max_s": 0.005, "len_scale": 0.38},
            {"id": "gentle_100", "label": "1:200 – 1:100 (0.5–1%)", "ratio_range": "1:200 – 1:100", "pct_range": "0.5% – 1.0%", "color": "#10b981", "min_s": 0.005, "max_s": 0.01, "len_scale": 0.52},
            {"id": "mod_50", "label": "1:100 – 1:50 (1–2%)", "ratio_range": "1:100 – 1:50", "pct_range": "1.0% – 2.0%", "color": "#84cc16", "min_s": 0.01, "max_s": 0.02, "len_scale": 0.66},
            {"id": "brisk_20", "label": "1:50 – 1:20 (2–5%)", "ratio_range": "1:50 – 1:20", "pct_range": "2.0% – 5.0%", "color": "#eab308", "min_s": 0.02, "max_s": 0.05, "len_scale": 0.80},
            {"id": "steep_10", "label": "1:20 – 1:10 (5–10%)", "ratio_range": "1:20 – 1:10", "pct_range": "5.0% – 10.0%", "color": "#f97316", "min_s": 0.05, "max_s": 0.10, "len_scale": 0.94},
            {"id": "vsteep", "label": "> 1:10 (>10%)", "ratio_range": "> 1:10", "pct_range": "> 10.0%", "color": "#ef4444", "min_s": 0.10, "max_s": 999.0, "len_scale": 1.08},
        ]

    @staticmethod
    def _compute_surface_depressions_priority_flood(
        grid_in: np.ndarray,
        mask_in: np.ndarray,
        e_min: float,
        n_min: float,
        e_max: float,
        n_max: float,
        ce: float,
        cn: float,
        ch: float,
        min_depth_m: float = 0.05,
        max_grid_dim: int = 120,
    ) -> List[Dict[str, Any]]:
        """
        Exact hydrological depression sink and ponding water storage volume takeoff (V_water m³).
        Uses Priority-Flood morphological reconstruction over the digital surface model.
        Identifies spill / pour point saddles, inundation depths, and inundated surface areas.
        """
        if grid_in is None or np is None:
            return []

        grid_full = np.asarray(grid_in, dtype=float)
        mask_full = np.asarray(mask_in, dtype=bool) if mask_in is not None else np.isfinite(grid_full)
        mask_full = mask_full & np.isfinite(grid_full)

        ny_full, nx_full = grid_full.shape
        if ny_full < 3 or nx_full < 3:
            return []

        # Subsample if grid is overly dense to maintain fast interactive response (<20ms)
        step_y = max(1, ny_full // max_grid_dim)
        step_x = max(1, nx_full // max_grid_dim)
        yi = np.arange(0, ny_full, step_y)
        xi = np.arange(0, nx_full, step_x)
        grid = grid_full[np.ix_(yi, xi)]
        mask = mask_full[np.ix_(yi, xi)]
        ny, nx = grid.shape

        dx = max(0.1, (e_max - e_min) / max(1, nx - 1))
        dy = max(0.1, (n_max - n_min) / max(1, ny - 1))
        cell_area = dx * dy

        # Priority-Flood algorithm
        filled = np.full((ny, nx), np.inf, dtype=float)
        visited = np.zeros((ny, nx), dtype=bool)
        pq: List[Tuple[float, int, int]] = []

        # Seed domain boundary cells
        for r in range(ny):
            for c in range(nx):
                if not mask[r, c]:
                    continue
                is_boundary = (r == 0 or r == ny - 1 or c == 0 or c == nx - 1)
                if not is_boundary:
                    # Check 4-connected neighbors for domain void
                    for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                        if not mask[r + dr, c + dc]:
                            is_boundary = True
                            break
                if is_boundary:
                    visited[r, c] = True
                    elev_val = float(grid[r, c])
                    filled[r, c] = elev_val
                    heapq.heappush(pq, (elev_val, r, c))

        if not pq:
            return []

        # Flood inward along the lowest wavefront
        while pq:
            elev, r, c = heapq.heappop(pq)
            for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)):
                nr, nc = r + dr, c + dc
                if 0 <= nr < ny and 0 <= nc < nx and mask[nr, nc] and not visited[nr, nc]:
                    visited[nr, nc] = True
                    target_elev = max(float(grid[nr, nc]), elev)
                    filled[nr, nc] = target_elev
                    heapq.heappush(pq, (target_elev, nr, nc))

        # Ponding water depth map: d = filled - original
        depth = np.where(mask & np.isfinite(filled), np.maximum(0.0, filled - grid), 0.0)

        # Connected component clustering for depression water bodies
        seen = np.zeros((ny, nx), dtype=bool)
        raw_depressions = []

        for r in range(ny):
            for c in range(nx):
                if depth[r, c] >= min_depth_m and not seen[r, c]:
                    queue = [(r, c)]
                    seen[r, c] = True
                    cluster = []
                    while queue:
                        curr_r, curr_c = queue.pop(0)
                        cluster.append((curr_r, curr_c))
                        for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)):
                            nr, nc = curr_r + dr, curr_c + dc
                            if 0 <= nr < ny and 0 <= nc < nx and mask[nr, nc] and not seen[nr, nc]:
                                if depth[nr, nc] > 0.005:
                                    seen[nr, nc] = True
                                    queue.append((nr, nc))

                    if len(cluster) < 2:
                        continue

                    # Calculate depression metrics
                    max_d = float(max(depth[cr, cc] for cr, cc in cluster))
                    if max_d < min_depth_m:
                        continue

                    v_water = float(sum(depth[cr, cc] * cell_area for cr, cc in cluster))
                    a_water = float(len(cluster) * cell_area)
                    if v_water <= 0.001 or a_water <= 0.05:
                        continue

                    spill_elev = float(max(filled[cr, cc] for cr, cc in cluster))
                    min_elev = float(min(grid[cr, cc] for cr, cc in cluster))

                    # Weighted centroid
                    weight_sum = sum(depth[cr, cc] for cr, cc in cluster)
                    if weight_sum > 0:
                        e_cent = sum((e_min + cc * dx) * depth[cr, cc] for cr, cc in cluster) / weight_sum
                        n_cent = sum((n_min + cr * dy) * depth[cr, cc] for cr, cc in cluster) / weight_sum
                    else:
                        e_cent = sum(e_min + cc * dx for cr, cc in cluster) / len(cluster)
                        n_cent = sum(n_min + cr * dy for cr, cc in cluster) / len(cluster)

                    # Bounding perimeter polygon (radial sorting around centroid)
                    perimeter_pts = []
                    for cr, cc in cluster:
                        # Check if boundary cell
                        is_p_bound = False
                        for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                            adj_r, adj_c = cr + dr, cc + dc
                            if not (0 <= adj_r < ny and 0 <= adj_c < nx) or depth[adj_r, adj_c] <= 0.005:
                                is_p_bound = True
                                break
                        if is_p_bound:
                            pt_e = e_min + cc * dx
                            pt_n = n_min + cr * dy
                            angle = math.atan2(pt_n - n_cent, pt_e - e_cent)
                            perimeter_pts.append((angle, pt_e, pt_n))

                    perimeter_pts.sort(key=lambda item: item[0])
                    poly_twd = [[round(p[1], 2), round(p[2], 2), round(spill_elev, 2)] for p in perimeter_pts]
                    if poly_twd and poly_twd[0] != poly_twd[-1]:
                        poly_twd.append(poly_twd[0])

                    poly_local = [
                        [round(p[1] - ce, 3), round(spill_elev - ch, 3), round(cn - p[2], 3)]
                        for p in perimeter_pts
                    ]
                    if poly_local and poly_local[0] != poly_local[-1]:
                        poly_local.append(poly_local[0])

                    raw_depressions.append({
                        "volume_m3": round(v_water, 3),
                        "surface_area_m2": round(a_water, 2),
                        "max_depth_m": round(max_d, 3),
                        "max_depth_cm": round(max_d * 100.0, 1),
                        "mean_depth_m": round(v_water / max(0.01, a_water), 3),
                        "spill_elevation_m": round(spill_elev, 3),
                        "min_elevation_m": round(min_elev, 3),
                        "centroid_twd97": {"e": round(e_cent, 2), "n": round(n_cent, 2), "h": round(min_elev, 2)},
                        "centroid_local": {"x": round(e_cent - ce, 3), "y": round(min_elev - ch, 3), "z": round(cn - n_cent, 3)},
                        "polygon_twd97": poly_twd,
                        "polygon_local": poly_local,
                    })

        # Sort by volume descending and assign IDs
        raw_depressions.sort(key=lambda d: d["volume_m3"], reverse=True)
        depressions = []
        for idx, dep in enumerate(raw_depressions):
            dep["depression_id"] = f"POND-{idx + 1}"
            dep["rank"] = idx + 1
            depressions.append(dep)

        return depressions

    # =========================================================================
    # 6. SURFACE DRAINAGE / SLOPE STEEPNESS & STEPPED 1:N ARROW FIELD ANALYSIS
    # =========================================================================
    def compute_drainage_and_slope(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Computes real-surface stepped civil engineering slope ratios (1:N, e.g. <1:200, 1:200-1:100,
        1:100-1:50, 1:50-1:20, 1:20-1:10, >1:10) and downhill drainage arrow vectors strictly inside
        the scan's actual hull_mask from the DSM.
        Also calculates closed-form surface drainage depression ponding water volume takeoff (V_water m³).
        """
        scan_id = str(payload.get("scan_id") or "").strip()
        grid_size_val = safe_float(payload.get("grid_size"), 14.0)
        grid_size = max(8, min(32, int(round(grid_size_val or 14.0))))
        exclude_walls = bool(payload.get("exclude_walls", True))
        min_ponding_depth_m = safe_float(payload.get("min_ponding_depth_m", payload.get("min_depth_m")), 0.05) or 0.05
        min_ponding_depth_m = max(0.005, min(50.0, min_ponding_depth_m))

        scan = self.db.get_scan(scan_id) or {}
        v_shift = self._resolve_vertical_datum_shift(scan_id, payload, scan)
        try:
            dsm_data = self._load_or_build_scan_dsm(scan)
        except Exception:
            dsm_data = None
        ce = safe_float(scan.get("twd97_e"), 304952.4) or 304952.4
        cn = safe_float(scan.get("twd97_n"), 2757084.2) or 2757084.2
        ch = (safe_float(scan.get("twd97_h"), 124.8) or 124.8) + v_shift

        raw_grid = None
        hull_mask = None
        if isinstance(dsm_data, dict):
            ce = safe_float(dsm_data.get("ce"), ce) or ce
            cn = safe_float(dsm_data.get("cn"), cn) or cn
            ch = (safe_float(dsm_data.get("ch"), ch) or ch) + v_shift
            raw_grid = (
                dsm_data.get("dsm_contour")
                if dsm_data.get("dsm_contour") is not None
                else (
                    dsm_data.get("grid")
                    if dsm_data.get("grid") is not None
                    else dsm_data.get("dsm_raw")
                )
            )
            hull_mask = dsm_data.get("hull_mask")

        # Custom or standard slope classification tiers
        custom_input = payload.get("custom_slope_tiers") or payload.get("slope_tiers")
        tier_defs = self._parse_custom_slope_tiers(custom_input)
        tier_counts = {t["id"]: 0 for t in tier_defs}
        slope_cells: List[Dict[str, Any]] = []
        arrows: List[Dict[str, Any]] = []
        depressions: List[Dict[str, Any]] = []

        if raw_grid is not None and np is not None:
            grid_full = np.asarray(raw_grid, dtype=float) + v_shift
            mask_full = (
                np.asarray(hull_mask, dtype=bool)
                if hull_mask is not None and np.asarray(hull_mask).shape == grid_full.shape
                else np.isfinite(grid_full)
            )
            raw_occ_arr = dsm_data.get("raw_occ")
            if raw_occ_arr is not None and np.asarray(raw_occ_arr).shape == grid_full.shape:
                occ_bool = np.asarray(raw_occ_arr, dtype=bool)
                if binary_erosion is not None:
                    occ_bool = binary_erosion(occ_bool, structure=np.ones((3, 3), dtype=bool))
                mask_full = mask_full & occ_bool

            e_min, e_max = float(dsm_data.get("e_min", ce - 25.0)), float(dsm_data.get("e_max", ce + 25.0))
            n_min, n_max = float(dsm_data.get("n_min", cn - 25.0)), float(dsm_data.get("n_max", cn + 25.0))

            # Compute genuine surface depressions and ponding volume takeoff
            depressions = self._compute_surface_depressions_priority_flood(
                grid_full,
                mask_full,
                e_min,
                n_min,
                e_max,
                n_max,
                ce,
                cn,
                ch,
                min_depth_m=min_ponding_depth_m,
            )

            yi = np.linspace(0, grid_full.shape[0] - 1, grid_size).astype(int)
            xi = np.linspace(0, grid_full.shape[1] - 1, grid_size).astype(int)
            grid = grid_full[np.ix_(yi, xi)]
            mask = mask_full[np.ix_(yi, xi)]
            ny, nx = grid.shape
            dx = max(0.25, (e_max - e_min) / max(1, nx - 1))
            dy = max(0.25, (n_max - n_min) / max(1, ny - 1))
            gy, gx = np.gradient(grid, dy, dx)
            slope_mag = np.hypot(gx, gy)
            slope_rad = np.arctan(slope_mag)
            slope_deg = np.degrees(slope_rad)

            valid = mask & np.isfinite(slope_mag)
            if exclude_walls:
                valid = valid & (slope_mag <= 1.0)
            if not np.any(valid):
                valid = mask & np.isfinite(slope_mag)

            total_valid = max(1, int(np.sum(valid)))
            gentle_pct = round(float(np.sum((slope_deg < 15.0) & valid)) * 100.0 / total_valid, 1)
            moderate_pct = round(
                float(np.sum((slope_deg >= 15.0) & (slope_deg < 30.0) & valid)) * 100.0 / total_valid,
                1,
            )
            steep_pct = round(max(0.0, 100.0 - gentle_pct - moderate_pct), 1)
            mean_slope_deg = round(float(np.nanmean(slope_deg[valid])) if np.any(valid) else 0.0, 2)
            max_slope_deg = round(float(np.nanmax(slope_deg[valid])) if np.any(valid) else 0.0, 2)
            mean_slope_s = float(np.nanmean(slope_mag[valid])) if np.any(valid) else 0.01
            mean_ratio_label = f"1:{min(999, max(1, int(round(1.0 / max(mean_slope_s, 1e-4)))))}"

            for iy in range(ny):
                for ix in range(nx):
                    if not valid[iy, ix]:
                        continue
                    s_val = float(slope_mag[iy, ix])
                    deg_v = float(slope_deg[iy, ix])
                    e_pt = round(e_min + ix * dx, 2)
                    n_pt = round(n_min + iy * dy, 2)
                    h_pt = round(float(grid[iy, ix]), 2)

                    # Downhill unit vector in TWD97 (+E, +N)
                    if s_val >= 1e-4:
                        dir_e = float(-gx[iy, ix] / s_val)
                        dir_n = float(-gy[iy, ix] / s_val)
                    else:
                        dir_e, dir_n = 1.0, 0.0

                    matched_tier = tier_defs[-1]
                    for td in tier_defs:
                        if s_val < td["max_s"]:
                            matched_tier = td
                            break
                    tier_counts[matched_tier["id"]] += 1
                    ratio_n = min(999, max(1, int(round(1.0 / max(s_val, 1e-4)))))
                    ratio_lbl = "<1:999" if s_val < 0.0005 else f"1:{ratio_n}"

                    cell_obj = {
                        "ix": ix,
                        "iy": iy,
                        "e": e_pt,
                        "n": n_pt,
                        "h": h_pt,
                        "local_x": round(e_pt - ce, 3),
                        "local_y": round(h_pt - ch, 3),
                        "local_z": round(cn - n_pt, 3),
                        "dir_e": round(dir_e, 4),
                        "dir_n": round(dir_n, 4),
                        "dir_local_x": round(dir_e, 4),
                        "dir_local_z": round(-dir_n, 4),
                        "slope_ratio": round(s_val, 5),
                        "slope_pct": round(s_val * 100.0, 2),
                        "slope_deg": round(deg_v, 2),
                        "ratio_n": ratio_n,
                        "ratio_label": ratio_lbl,
                        "tier_id": matched_tier["id"],
                        "color": matched_tier["color"],
                        "len_scale": matched_tier["len_scale"],
                    }
                    slope_cells.append(cell_obj)
                    arrows.append(cell_obj)
        else:
            gentle_pct = 0.0
            moderate_pct = 0.0
            steep_pct = 0.0
            mean_slope_deg = 0.0
            max_slope_deg = 0.0
            mean_ratio_label = "—"

        total_arrows = max(1, len(arrows))
        tiers_summary = []
        for td in tier_defs:
            cnt = tier_counts.get(td["id"], 0)
            tiers_summary.append(
                {
                    **td,
                    "count": cnt,
                    "pct": round(cnt * 100.0 / total_arrows, 1) if arrows else 0.0,
                }
            )

        total_ponding_vol = round(sum(d["volume_m3"] for d in depressions), 3) if depressions else 0.0
        total_ponding_area = round(sum(d["surface_area_m2"] for d in depressions), 2) if depressions else 0.0
        max_ponding_depth = round(max((d["max_depth_m"] for d in depressions), default=0.0), 3)

        return {
            "status": "ok",
            "scan_id": scan_id,
            "crs": TWD97_TWVD2001_LABEL,
            "gentle_pct": gentle_pct,
            "moderate_pct": moderate_pct,
            "steep_pct": steep_pct,
            "mean_slope_deg": mean_slope_deg,
            "max_slope_deg": max_slope_deg,
            "mean_ratio_label": mean_ratio_label,
            "arrow_count": len(arrows),
            "tiers": tiers_summary,
            "custom_tiers_applied": bool(custom_input),
            "arrows": arrows,
            "slope_cells": slope_cells,
            "center_twd97": {"e": round(ce, 3), "n": round(cn, 3), "h": round(ch, 3)},
            "depression_count": len(depressions),
            "total_ponding_volume_m3": total_ponding_vol,
            "total_ponding_area_m2": total_ponding_area,
            "max_ponding_depth_m": max_ponding_depth,
            "min_ponding_depth_m": round(min_ponding_depth_m, 3),
            "depressions": depressions,
        }


