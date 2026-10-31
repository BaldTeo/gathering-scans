#!/usr/bin/env python3
"""
GC_ScanOptimizer Bridge for GatheringScans
Allows users on scans.gatheren.cloud to invoke real PC-side optimization actions in
c:\\Antigravity\\GC_ScanOptimizer:
1. Preset Compression ('quality', 'balanced', 'web', 'ultra_light') via TilesetOptimizer + gltfpack + PIL texture downscaling
2. Spatial 3D Polygon & Elevation Cropping ('keep_inside' / 'delete_inside') via SpatialCutter + trimesh/shapely
3. Coordinate Reference System Alignment to TWD97 (121) + TWVD2001
"""

import io
import os
import re
import sys
import json
import math
import time
import shutil
import struct
import threading
from datetime import datetime
from typing import Dict, Any, List, Optional, Tuple

import numpy as np

from pc_worker.config import (
    GC_SCAN_OPTIMIZER_DIR,
    LOCAL_SCANS_ROOT,
    PIX4DMATIC_TEXTURE_SIZE,
    TWD97_TWVD2001_SHORT,
)
from pc_worker.priority_queue import ScanQueueDB

if os.path.isdir(GC_SCAN_OPTIMIZER_DIR) and GC_SCAN_OPTIMIZER_DIR not in sys.path:
    sys.path.append(GC_SCAN_OPTIMIZER_DIR)


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


def _safe_parse_poly2d(poly: Any) -> Optional[List[List[float]]]:
    """Safely extracts a 2D polygon as a list of [x, y] floats, skipping invalid vertices."""
    if not isinstance(poly, (list, tuple)) or len(poly) < 3:
        return None
    pts: List[List[float]] = []
    for p in poly:
        if isinstance(p, (list, tuple)) and len(p) >= 2:
            x = safe_float(p[0])
            y = safe_float(p[1])
            if x is not None and y is not None:
                pts.append([x, y])
        elif isinstance(p, dict):
            x = safe_float(p.get("x", p.get("e")))
            y = safe_float(p.get("y", p.get("n", p.get("z"))))
            if x is not None and y is not None:
                pts.append([x, y])
    return pts if len(pts) >= 3 else None


CRS_DEFINITIONS: Dict[str, Dict[str, Any]] = {
    "TWD97_121_TWVD2001": {
        "code": "TWD97_121_TWVD2001",
        "label": "TWD97 (121) + TWVD2001",
        "full_name": "TWD97 / TM2 Zone 121 + TWVD2001 (EPSG:3826+8904)",
        "kind": "tm",
        "lon0_deg": 121.0,
        "false_easting": 250000.0,
        "k0": 0.9999,
        "f_inv": 298.257222101,
        "h_offset_from_twvd": 0.0,
    },
    "TWD97_119_TWVD2001": {
        "code": "TWD97_119_TWVD2001",
        "label": "TWD97 (119) + TWVD2001",
        "full_name": "TWD97 / TM2 Zone 119 + TWVD2001 (EPSG:3825+8904)",
        "kind": "tm",
        "lon0_deg": 119.0,
        "false_easting": 250000.0,
        "k0": 0.9999,
        "f_inv": 298.257222101,
        "h_offset_from_twvd": 0.0,
    },
    "WGS84_UTM51N": {
        "code": "WGS84_UTM51N",
        "label": "WGS84 / UTM 51N",
        "full_name": "WGS84 / UTM Zone 51N (EPSG:32651)",
        "kind": "tm",
        "lon0_deg": 123.0,
        "false_easting": 500000.0,
        "k0": 0.9996,
        "f_inv": 298.257223563,
        "h_offset_from_twvd": 17.20,
    },
    "WGS84_UTM50N": {
        "code": "WGS84_UTM50N",
        "label": "WGS84 / UTM 50N",
        "full_name": "WGS84 / UTM Zone 50N (EPSG:32650)",
        "kind": "tm",
        "lon0_deg": 117.0,
        "false_easting": 500000.0,
        "k0": 0.9996,
        "f_inv": 298.257223563,
        "h_offset_from_twvd": 16.80,
    },
    "LOCAL_ORIGIN": {
        "code": "LOCAL_ORIGIN",
        "label": "Local Origin (0,0,0)",
        "full_name": "Local Site Origin (0, 0, 0) Meters (BIM / CAD)",
        "kind": "local",
        "h_offset_from_twvd": 0.0,
    },
}


def _wgs84_to_tm(
    lat_deg: float,
    lon_deg: float,
    lon0_deg: float = 121.0,
    false_easting: float = 250000.0,
    k0: float = 0.9999,
    f_inv: float = 298.257222101,
) -> Tuple[float, float]:
    """Analytical Transverse Mercator forward projection (degrees -> Easting, Northing meters)."""
    a = 6378137.0
    f = 1.0 / f_inv
    e2 = 2.0 * f - f * f
    e_prime2 = e2 / (1.0 - e2)
    lon0 = math.radians(lon0_deg)
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)

    sin_lat = math.sin(lat)
    cos_lat = math.cos(lat)
    tan_lat = math.tan(lat)
    n = a / math.sqrt(1.0 - e2 * sin_lat * sin_lat)
    t = tan_lat * tan_lat
    c = e_prime2 * cos_lat * cos_lat
    A = cos_lat * (lon - lon0)

    M = a * (
        (1.0 - e2 / 4.0 - 3.0 * (e2 ** 2) / 64.0 - 5.0 * (e2 ** 3) / 256.0) * lat
        - (3.0 * e2 / 8.0 + 3.0 * (e2 ** 2) / 32.0 + 45.0 * (e2 ** 3) / 1024.0) * math.sin(2.0 * lat)
        + (15.0 * (e2 ** 2) / 256.0 + 45.0 * (e2 ** 3) / 1024.0) * math.sin(4.0 * lat)
        - (35.0 * (e2 ** 3) / 3072.0) * math.sin(6.0 * lat)
    )
    easting = false_easting + k0 * n * (
        A
        + (1.0 - t + c) * (A ** 3) / 6.0
        + (5.0 - 18.0 * t + t * t + 72.0 * c - 58.0 * e_prime2) * (A ** 5) / 120.0
    )
    northing = k0 * (
        M
        + n
        * tan_lat
        * (
            (A ** 2) / 2.0
            + (5.0 - t + 9.0 * c + 4.0 * c * c) * (A ** 4) / 24.0
            + (61.0 - 58.0 * t + t * t + 600.0 * c - 330.0 * e_prime2) * (A ** 6) / 720.0
        )
    )
    return easting, northing


def _tm_to_wgs84(
    easting: float,
    northing: float,
    lon0_deg: float = 121.0,
    false_easting: float = 250000.0,
    k0: float = 0.9999,
    f_inv: float = 298.257222101,
) -> Tuple[float, float]:
    """Analytical Transverse Mercator inverse projection (Easting, Northing meters -> lat, lon degrees)."""
    a = 6378137.0
    f = 1.0 / f_inv
    e = math.sqrt(2.0 * f - f * f)
    e2 = e * e / (1.0 - e * e)
    lon0 = math.radians(lon0_deg)

    x1 = (easting - false_easting) / k0
    m = northing / k0
    mu = m / (a * (1.0 - (e ** 2) / 4.0 - 3.0 * (e ** 4) / 64.0 - 5.0 * (e ** 6) / 256.0))
    e1 = (1.0 - math.sqrt(1.0 - e ** 2)) / (1.0 + math.sqrt(1.0 - e ** 2))
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
    cos_fp = max(1e-12, math.cos(fp))
    tan_fp = math.tan(fp)
    c1 = e2 * (cos_fp ** 2)
    t1 = tan_fp ** 2
    r1 = a * (1.0 - e ** 2) / ((1.0 - (e ** 2) * (sin_fp ** 2)) ** 1.5)
    n1 = a / math.sqrt(1.0 - (e ** 2) * (sin_fp ** 2))
    d = x1 / n1

    lat = fp - (n1 * tan_fp / r1) * (
        (d ** 2) / 2.0
        - (5.0 + 3.0 * t1 + 10.0 * c1 - 4.0 * (c1 ** 2) - 9.0 * e2) * (d ** 4) / 24.0
        + (61.0 + 90.0 * t1 + 298.0 * c1 + 45.0 * (t1 ** 2) - 252.0 * e2 - 3.0 * (c1 ** 2)) * (d ** 6) / 720.0
    )
    lon = lon0 + (
        d
        - (1.0 + 2.0 * t1 + c1) * (d ** 3) / 6.0
        + (5.0 - 2.0 * c1 + 28.0 * t1 - 3.0 * (c1 ** 2) + 8.0 * e2 + 24.0 * (t1 ** 2)) * (d ** 5) / 120.0
    ) / cos_fp
    return math.degrees(lat), math.degrees(lon)


def _infer_scan_crs_code(scan: Dict[str, Any], center_xyz: np.ndarray) -> str:
    crs_raw = str(scan.get("crs") or "").upper()
    if crs_raw in CRS_DEFINITIONS:
        return crs_raw
    if "LOCAL" in crs_raw or (abs(float(center_xyz[0])) < 50000.0 and abs(float(center_xyz[1])) < 50000.0):
        return "LOCAL_ORIGIN"
    if "UTM" in crs_raw and "50" in crs_raw:
        return "WGS84_UTM50N"
    if "UTM" in crs_raw or "32651" in crs_raw:
        return "WGS84_UTM51N"
    if "119" in crs_raw or "3825" in crs_raw:
        return "TWD97_119_TWVD2001"
    return "TWD97_121_TWVD2001"


def _compute_tileset_world_bounds(ts_obj: Dict[str, Any]) -> Tuple[Optional[np.ndarray], Optional[List[float]]]:
    """
    Computes tight world-space center [cx, cy, cz] and half-extents [hx, hy, hz] from a 3D Tileset JSON,
    accumulating all column-major 4x4 tile `transform` matrices down to leaf content nodes.
    """
    root = ts_obj.get("root") if isinstance(ts_obj, dict) else None
    if not isinstance(root, dict):
        return None, None

    by_depth: Dict[int, List[Tuple[np.ndarray, np.ndarray]]] = {}

    def _walk(node: Any, m_parent: np.ndarray, depth: int) -> None:
        if not isinstance(node, dict) or depth > 8:
            return
        tf = node.get("transform")
        if isinstance(tf, list) and len(tf) == 16:
            m_node = np.array([float(v or 0.0) for v in tf[:16]], dtype=np.float64).reshape((4, 4), order="F")
            m_cur = m_parent @ m_node
        else:
            m_cur = m_parent

        content = node.get("content") or {}
        uri = (content.get("uri") or content.get("url")) if isinstance(content, dict) else None
        bv = node.get("boundingVolume") or {}
        box = bv.get("box") if isinstance(bv, dict) else None
        if uri and isinstance(box, list) and len(box) >= 12:
            b = np.array([float(v or 0.0) for v in box[:12]], dtype=np.float64)
            wc = (m_cur[:3, :3] @ b[0:3]) + m_cur[:3, 3]
            wu = np.abs(m_cur[:3, :3] @ b[3:6])
            wv = np.abs(m_cur[:3, :3] @ b[6:9])
            ww = np.abs(m_cur[:3, :3] @ b[9:12])
            wh = wu + wv + ww
            by_depth.setdefault(depth, []).append((wc, wh))

        for ch in node.get("children") or []:
            _walk(ch, m_cur, depth + 1)

    _walk(root, np.eye(4, dtype=np.float64), 0)
    if by_depth:
        max_d = max(by_depth.keys())
        items = by_depth[max_d]
        xs = [float(c[0]) for c, _ in items]
        ys = [float(c[1]) for c, _ in items]
        zs = sorted(float(c[2]) for c, _ in items)
        cx = (min(xs) + max(xs)) * 0.5
        cy = (min(ys) + max(ys)) * 0.5
        cz = zs[len(zs) // 2]
        min_x = min(float(c[0] - h[0]) for c, h in items)
        max_x = max(float(c[0] + h[0]) for c, h in items)
        min_y = min(float(c[1] - h[1]) for c, h in items)
        max_y = max(float(c[1] + h[1]) for c, h in items)
        min_z = min(float(c[2] - h[2]) for c, h in items)
        max_z = max(float(c[2] + h[2]) for c, h in items)
        he = [
            max((max_x - min_x) * 0.5, 0.5),
            max((max_y - min_y) * 0.5, 0.5),
            max((max_z - min_z) * 0.5, 0.5),
        ]
        return np.array([cx, cy, cz], dtype=np.float64), he

    tf_r = root.get("transform")
    m_root = (
        np.array([float(v or 0.0) for v in tf_r[:16]], dtype=np.float64).reshape((4, 4), order="F")
        if (isinstance(tf_r, list) and len(tf_r) == 16)
        else np.eye(4, dtype=np.float64)
    )
    r_box = (root.get("boundingVolume") or {}).get("box")
    if isinstance(r_box, list) and len(r_box) >= 12:
        b = np.array([float(v or 0.0) for v in r_box[:12]], dtype=np.float64)
        wc = (m_root[:3, :3] @ b[0:3]) + m_root[:3, 3]
        wh = np.abs(m_root[:3, :3] @ b[3:6]) + np.abs(m_root[:3, :3] @ b[6:9]) + np.abs(m_root[:3, :3] @ b[9:12])
        he = [max(float(wh[0]), 0.5), max(float(wh[1]), 0.5), max(float(wh[2]), 0.5)]
        return wc, he
    return None, None


def _transform_tileset_crs_in_place(
    tileset_dir: str,
    source_scan: Dict[str, Any],
    target_crs_code: str,
    custom_offset_xyz: Tuple[float, float, float] = (0.0, 0.0, 0.0),
    geoid_offset_override: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Zero-loss 64-bit CRS & datum transformation across all GLB root scene nodes and tileset.json OBBs.
    Updates root.transform (when present) or node TRS / boundingVolume.box without re-quantizing binary vertex buffers.
    """
    from optimizer.geometry_optimizer import parse_glb_chunks, pack_glb_chunks

    ts_path = os.path.join(tileset_dir, "tileset.json")
    if not os.path.isfile(ts_path):
        raise FileNotFoundError(f"tileset.json not found in {tileset_dir}")

    with open(ts_path, "r", encoding="utf-8") as f:
        ts_obj = json.load(f)

    c_src_opt, _ = _compute_tileset_world_bounds(ts_obj)
    if c_src_opt is not None:
        c_src = c_src_opt
    else:
        c_src = np.array(
            [
                float(source_scan["twd97_e"]) if source_scan.get("twd97_e") is not None else 0.0,
                float(source_scan["twd97_n"]) if source_scan.get("twd97_n") is not None else 0.0,
                float(source_scan["twd97_h"]) if source_scan.get("twd97_h") is not None else 0.0,
            ],
            dtype=np.float64,
        )

    src_code = _infer_scan_crs_code(source_scan, c_src)
    tgt_code = str(target_crs_code or src_code).strip().upper()
    if tgt_code not in CRS_DEFINITIONS:
        tgt_code = src_code
    sdef = CRS_DEFINITIONS[src_code]
    tdef = CRS_DEFINITIONS[tgt_code]

    raw_src_lat = source_scan.get("lat")
    raw_src_lon = source_scan.get("lon")
    has_src_georef = (
        raw_src_lat is not None
        and raw_src_lon is not None
        and (abs(float(raw_src_lat)) > 1e-4 or abs(float(raw_src_lon)) > 1e-4)
    )

    lat0: Optional[float] = None
    lon0_wgs: Optional[float] = None
    if sdef["kind"] == "tm":
        lat0, lon0_wgs = _tm_to_wgs84(
            float(c_src[0]),
            float(c_src[1]),
            sdef["lon0_deg"],
            sdef["false_easting"],
            sdef["k0"],
            sdef["f_inv"],
        )
        geoid_override_float = safe_float(geoid_offset_override)
        src_h_off = (
            geoid_override_float
            if geoid_override_float is not None and sdef["code"].startswith("WGS84_UTM")
            else float(sdef["h_offset_from_twvd"])
        )
        twvd_h0 = float(c_src[2]) - src_h_off
        has_src_georef = True
    else:
        if tdef["kind"] == "tm" and not has_src_georef:
            raise ValueError(
                "Cannot convert an un-georeferenced Local Origin scan to a projected CRS without geographic reference coordinates; "
                "apply custom ΔX / ΔY / ΔZ offsets in Local Origin (0,0,0) instead."
            )
        if has_src_georef:
            lat0 = float(raw_src_lat)  # type: ignore[arg-type]
            lon0_wgs = float(raw_src_lon)  # type: ignore[arg-type]
        twvd_h0 = float(source_scan.get("elev_m") if source_scan.get("elev_m") is not None else c_src[2])

    offset_vec = np.array(
        [float(custom_offset_xyz[0]), float(custom_offset_xyz[1]), float(custom_offset_xyz[2])],
        dtype=np.float64,
    )

    if tgt_code == src_code:
        k_xy = 1.0
        rot_z_rad = 0.0
        c_dst = c_src + offset_vec
    else:
        if has_src_georef and lat0 is not None and lon0_wgs is not None:
            # Compute exact conformal Jacobian J_dst @ inv(J_src) at (lat0, lon0_wgs)
            a_wgs = 6378137.0
            e2_wgs = 0.00669438002290
            s_lat = math.sin(math.radians(lat0))
            c_lat = max(1e-8, math.cos(math.radians(lat0)))
            m_rad = a_wgs * (1.0 - e2_wgs) / ((1.0 - e2_wgs * s_lat * s_lat) ** 1.5)
            p_rad = (a_wgs / math.sqrt(1.0 - e2_wgs * s_lat * s_lat)) * c_lat
            d_lat_10m = math.degrees(10.0 / m_rad)
            d_lon_10m = math.degrees(10.0 / p_rad)

            def _crs_jac_2x2(code_key: str) -> np.ndarray:
                cd = CRS_DEFINITIONS[code_key]
                if cd["kind"] == "local":
                    return np.eye(2, dtype=np.float64)
                assert lat0 is not None and lon0_wgs is not None
                e_p, n_p = _wgs84_to_tm(lat0, lon0_wgs + d_lon_10m, cd["lon0_deg"], cd["false_easting"], cd["k0"], cd["f_inv"])
                e_m, n_m = _wgs84_to_tm(lat0, lon0_wgs - d_lon_10m, cd["lon0_deg"], cd["false_easting"], cd["k0"], cd["f_inv"])
                e_np, n_np = _wgs84_to_tm(lat0 + d_lat_10m, lon0_wgs, cd["lon0_deg"], cd["false_easting"], cd["k0"], cd["f_inv"])
                e_nm, n_nm = _wgs84_to_tm(lat0 - d_lat_10m, lon0_wgs, cd["lon0_deg"], cd["false_easting"], cd["k0"], cd["f_inv"])
                return np.array(
                    [
                        [(e_p - e_m) / 20.0, (e_np - e_nm) / 20.0],
                        [(n_p - n_m) / 20.0, (n_np - n_nm) / 20.0],
                    ],
                    dtype=np.float64,
                )

            j_rel = _crs_jac_2x2(tgt_code) @ np.linalg.inv(_crs_jac_2x2(src_code))
            rot_z_rad = math.atan2(float(j_rel[1, 0] - j_rel[0, 1]), float(j_rel[0, 0] + j_rel[1, 1]))
            k_xy = float(math.sqrt(max(1e-12, abs(float(np.linalg.det(j_rel))))))
        else:
            k_xy = 1.0
            rot_z_rad = 0.0

        if tdef["kind"] == "local":
            c_dst = np.array([0.0, 0.0, 0.0], dtype=np.float64) + offset_vec
        else:
            assert lat0 is not None and lon0_wgs is not None
            e_dst, n_dst = _wgs84_to_tm(
                lat0,
                lon0_wgs,
                tdef["lon0_deg"],
                tdef["false_easting"],
                tdef["k0"],
                tdef["f_inv"],
            )
            geoid_override_float = safe_float(geoid_offset_override)
            tgt_h_off = (
                geoid_override_float
                if geoid_override_float is not None and tdef["code"].startswith("WGS84_UTM")
                else float(tdef["h_offset_from_twvd"])
            )
            h_dst = twvd_h0 + tgt_h_off
            c_dst = np.array([e_dst, n_dst, h_dst], dtype=np.float64) + offset_vec

    cos_z = math.cos(rot_z_rad)
    sin_z = math.sin(rot_z_rad)
    L = np.array(
        [
            [k_xy * cos_z, -k_xy * sin_z, 0.0],
            [k_xy * sin_z, k_xy * cos_z, 0.0],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    A_world = np.eye(4, dtype=np.float64)
    A_world[:3, :3] = L
    A_world[:3, 3] = c_dst - (L @ c_src)

    root_node = ts_obj.get("root") if isinstance(ts_obj.get("root"), dict) else {}
    has_root_transform = isinstance(root_node.get("transform"), list) and len(root_node["transform"]) == 16

    glb_updated = 0
    if has_root_transform:
        # 3D Tilesets with root.transform (e.g. PIX4Dmatic Cesium octrees with Y-up GLBs and root-local boundingVolume.box):
        # Pre-multiplying root.transform by A_world transforms every octree bounding box and GLB vertex in 64-bit world space
        # without corrupting Y-up GLB axes or root-local child bounding volumes.
        m_root_old = np.array([float(x) for x in root_node["transform"][:16]], dtype=np.float64).reshape((4, 4), order="F")
        m_root_new = A_world @ m_root_old
        root_node["transform"] = [round(float(x), 8) for x in m_root_new.reshape(16, order="F")]

        prev_ts_path = os.path.join(tileset_dir, "preview_tileset.json")
        if os.path.isfile(prev_ts_path):
            try:
                with open(prev_ts_path, "r", encoding="utf-8") as f_prev:
                    prev_ts_obj = json.load(f_prev)
                prev_root = prev_ts_obj.get("root") if isinstance(prev_ts_obj.get("root"), dict) else None
                if prev_root and isinstance(prev_root.get("transform"), list) and len(prev_root["transform"]) == 16:
                    mp_old = np.array([float(x) for x in prev_root["transform"][:16]], dtype=np.float64).reshape((4, 4), order="F")
                    mp_new = A_world @ mp_old
                    prev_root["transform"] = [round(float(x), 8) for x in mp_new.reshape(16, order="F")]
                    with open(prev_ts_path, "w", encoding="utf-8") as wf_prev:
                        json.dump(prev_ts_obj, wf_prev, indent=2)
            except Exception:
                pass
    else:
        ts_obj.setdefault("asset", {})["gltfUpAxis"] = "Z"

        def _quat_mat3(q: List[float]) -> np.ndarray:
            qx, qy, qz, qw = float(q[0]), float(q[1]), float(q[2]), float(q[3])
            n_q = math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
            if n_q < 1e-12:
                return np.eye(3, dtype=np.float64)
            qx, qy, qz, qw = qx / n_q, qy / n_q, qz / n_q, qw / n_q
            return np.array(
                [
                    [1.0 - 2.0 * (qy * qy + qz * qz), 2.0 * (qx * qy - qw * qz), 2.0 * (qx * qz + qw * qy)],
                    [2.0 * (qx * qy + qw * qz), 1.0 - 2.0 * (qx * qx + qz * qz), 2.0 * (qy * qz - qw * qx)],
                    [2.0 * (qx * qz - qw * qy), 2.0 * (qy * qz + qw * qx), 1.0 - 2.0 * (qx * qx + qy * qy)],
                ],
                dtype=np.float64,
            )

        for r_dir, sub_dirs, files in os.walk(tileset_dir):
            sub_dirs[:] = [d for d in sub_dirs if d.lower() != "preview_low"]
            for fn in files:
                if not fn.lower().endswith(".glb"):
                    continue
                fp = os.path.join(r_dir, fn)
                with open(fp, "rb") as gf:
                    raw_b = gf.read()
                j_obj, bin_b = parse_glb_chunks(raw_b)
                nodes = j_obj.get("nodes") or []
                if not nodes:
                    continue
                scenes = j_obj.get("scenes") or []
                s_idx = int(j_obj.get("scene", 0)) if scenes else 0
                root_idxs = (
                    list(scenes[s_idx].get("nodes") or [])
                    if (0 <= s_idx < len(scenes) and scenes[s_idx].get("nodes"))
                    else [0]
                )
                for r_idx in root_idxs:
                    if not (0 <= int(r_idx) < len(nodes)):
                        continue
                    nd = nodes[int(r_idx)]
                    has_mat = isinstance(nd.get("matrix"), list) and len(nd["matrix"]) == 16
                    rot_q = nd.get("rotation")
                    is_z_only_rot = (
                        rot_q is None
                        or (
                            isinstance(rot_q, list)
                            and len(rot_q) == 4
                            and abs(float(rot_q[0])) < 1e-9
                            and abs(float(rot_q[1])) < 1e-9
                        )
                    )
                    if not has_mat and is_z_only_rot:
                        t_old_list = nd.get("translation") or [0.0, 0.0, 0.0]
                        t_old = np.array([float(t_old_list[0]), float(t_old_list[1]), float(t_old_list[2])], dtype=np.float64)
                        t_new = L @ (t_old - c_src) + c_dst
                        s_old_list = nd.get("scale") or [1.0, 1.0, 1.0]
                        sx, sy, sz = float(s_old_list[0]), float(s_old_list[1]), float(s_old_list[2])
                        old_ang = (
                            2.0 * math.atan2(float(rot_q[2]), float(rot_q[3]))
                            if isinstance(rot_q, list) and len(rot_q) == 4
                            else 0.0
                        )
                        new_ang = old_ang + rot_z_rad
                        nd["translation"] = [float(t_new[0]), float(t_new[1]), float(t_new[2])]
                        new_s = [float(k_xy * sx), float(k_xy * sy), float(sz)]
                        if "scale" in nd or any(abs(v - 1.0) > 1e-12 for v in new_s):
                            nd["scale"] = new_s
                        if abs(new_ang) > 1e-10:
                            nd["rotation"] = [0.0, 0.0, math.sin(0.5 * new_ang), math.cos(0.5 * new_ang)]
                        else:
                            nd.pop("rotation", None)
                    else:
                        if has_mat:
                            m_old = np.array(nd["matrix"], dtype=np.float64).reshape((4, 4), order="F")
                        else:
                            m_old = np.eye(4, dtype=np.float64)
                            s_l = nd.get("scale") or [1.0, 1.0, 1.0]
                            S_m = np.diag([float(s_l[0]), float(s_l[1]), float(s_l[2])])
                            R_m = _quat_mat3(rot_q) if (isinstance(rot_q, list) and len(rot_q) == 4) else np.eye(3, dtype=np.float64)
                            m_old[:3, :3] = R_m @ S_m
                            t_l = nd.get("translation") or [0.0, 0.0, 0.0]
                            m_old[:3, 3] = [float(t_l[0]), float(t_l[1]), float(t_l[2])]
                        t_new = L @ (m_old[:3, 3] - c_src) + c_dst
                        a_new = L @ m_old[:3, :3]
                        m_new = np.eye(4, dtype=np.float64)
                        m_new[:3, :3] = a_new
                        m_new[:3, 3] = t_new
                        nd.pop("translation", None)
                        nd.pop("rotation", None)
                        nd.pop("scale", None)
                        nd["matrix"] = [float(x) for x in m_new.reshape(16, order="F")]
                with open(fp, "wb") as wf:
                    wf.write(pack_glb_chunks(j_obj, bin_b))
                glb_updated += 1

        def _transform_tile_bv(tile_node: Dict[str, Any]) -> None:
            if not isinstance(tile_node, dict):
                return
            bv = tile_node.get("boundingVolume")
            if isinstance(bv, dict):
                if isinstance(bv.get("box"), list) and len(bv["box"]) >= 12:
                    b = np.array([float(x) for x in bv["box"][:12]], dtype=np.float64)
                    bc_new = L @ (b[0:3] - c_src) + c_dst
                    bu_new = L @ b[3:6]
                    bv_new = L @ b[6:9]
                    bw_new = L @ b[9:12]
                    bv["box"] = [
                        round(float(bc_new[0]), 4),
                        round(float(bc_new[1]), 4),
                        round(float(bc_new[2]), 4),
                        round(float(bu_new[0]), 4),
                        round(float(bu_new[1]), 4),
                        round(float(bu_new[2]), 4),
                        round(float(bv_new[0]), 4),
                        round(float(bv_new[1]), 4),
                        round(float(bv_new[2]), 4),
                        round(float(bw_new[0]), 4),
                        round(float(bw_new[1]), 4),
                        round(float(bw_new[2]), 4),
                    ]
                elif isinstance(bv.get("sphere"), list) and len(bv["sphere"]) >= 4:
                    s = np.array([float(x) for x in bv["sphere"][:4]], dtype=np.float64)
                    sc_new = L @ (s[0:3] - c_src) + c_dst
                    bv["sphere"] = [
                        round(float(sc_new[0]), 4),
                        round(float(sc_new[1]), 4),
                        round(float(sc_new[2]), 4),
                        round(float(s[3]) * max(k_xy, 1.0), 4),
                    ]
            for ch in tile_node.get("children") or []:
                _transform_tile_bv(ch)

        if isinstance(ts_obj.get("root"), dict):
            _transform_tile_bv(ts_obj["root"])

    with open(ts_path, "w", encoding="utf-8") as wf_ts:
        json.dump(ts_obj, wf_ts, indent=2)

    with open(os.path.join(tileset_dir, "offset.xyz"), "w", encoding="utf-8") as wf_off:
        wf_off.write(f"{float(c_dst[0]):.3f} {float(c_dst[1]):.3f} {float(c_dst[2]):.3f}\n")

    out_lat: Optional[float] = None
    out_lon: Optional[float] = None
    if tdef["kind"] == "tm":
        lat_out_f, lon_out_f = _tm_to_wgs84(
            float(c_dst[0]),
            float(c_dst[1]),
            tdef["lon0_deg"],
            tdef["false_easting"],
            tdef["k0"],
            tdef["f_inv"],
        )
        out_lat = round(float(lat_out_f), 6)
        out_lon = round(float(lon_out_f), 6)

    return {
        "source_crs_code": src_code,
        "target_crs_code": tgt_code,
        "crs_label": tdef["label"],
        "crs_full": tdef["full_name"],
        "center_xyz": [round(float(c_dst[0]), 3), round(float(c_dst[1]), 3), round(float(c_dst[2]), 2)],
        "lat": out_lat,
        "lon": out_lon,
        "scale_xy": round(k_xy, 8),
        "convergence_deg": round(math.degrees(rot_z_rad), 5),
        "custom_offset_xyz": [round(float(x), 3) for x in offset_vec],
        "glb_tiles_updated": glb_updated,
    }


def transform_scan_crs(
    tileset_dir: str,
    source_scan: Dict[str, Any],
    target_crs_code: str,
    custom_offset_xyz: Tuple[float, float, float] = (0.0, 0.0, 0.0),
    geoid_offset_override: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Public API wrapper for _transform_tileset_crs_in_place supporting geoid_offset_override
    and user-specified TWVD2001 / WGS84 vertical datum shifts.
    """
    return _transform_tileset_crs_in_place(
        tileset_dir=tileset_dir,
        source_scan=source_scan,
        target_crs_code=target_crs_code,
        custom_offset_xyz=custom_offset_xyz,
        geoid_offset_override=geoid_offset_override,
    )


def _downscale_glb_embedded_textures(glb_path: str, tex_limit: int = 2048, jpeg_quality: int = 78) -> int:
    """
    Downscales embedded JPEG/PNG images inside a .glb file (including EXT_meshopt_compression GLBs)
    so that max dimension <= tex_limit and re-encodes with optimized JPEG quality.
    Returns the final file size in bytes.
    """
    if not os.path.isfile(glb_path):
        return 0
    orig_size = os.path.getsize(glb_path)
    if orig_size < 32768:
        return orig_size
    try:
        from PIL import Image

        with open(glb_path, "rb") as f:
            raw = f.read()
        if raw[:4] != b"glTF":
            return orig_size
        magic, ver, _ = struct.unpack_from("<4sII", raw, 0)
        if ver != 2:
            return orig_size
        j_len, j_type = struct.unpack_from("<I4s", raw, 12)
        if j_type != b"JSON":
            return orig_size
        b_off = 20 + j_len
        if b_off + 8 > len(raw):
            return orig_size
        b_len, b_type = struct.unpack_from("<I4s", raw, b_off)
        if b_type != b"BIN\x00":
            return orig_size

        j = json.loads(raw[20 : 20 + j_len].decode("utf-8"))
        images = j.get("images") or []
        bvs = j.get("bufferViews") or []
        if not images or not bvs:
            return orig_size

        blob = raw[b_off + 8 : b_off + 8 + b_len]
        img_bv_indices = {img["bufferView"]: img for img in images if "bufferView" in img}
        if not img_bv_indices:
            return orig_size

        # Rebuild binary buffer(0) segments while updating byteOffsets
        # Collect all segments referencing buffer 0 (either directly or via EXT_meshopt_compression)
        segments = []
        for idx, bv in enumerate(bvs):
            ext_mc = (bv.get("extensions") or {}).get("EXT_meshopt_compression")
            if ext_mc and ext_mc.get("buffer", 0) == 0:
                segments.append(("meshopt", idx, int(ext_mc.get("byteOffset", 0)), int(ext_mc["byteLength"]), ext_mc))
            elif bv.get("buffer", 0) == 0 and not ext_mc:
                segments.append(("direct", idx, int(bv.get("byteOffset", 0)), int(bv["byteLength"]), bv))

        if not segments:
            return orig_size

        segments.sort(key=lambda x: x[2])
        new_bin = bytearray()
        modified_any = False

        for kind, bv_idx, old_off, old_len, target_dict in segments:
            chunk = blob[old_off : old_off + old_len]
            if kind == "direct" and bv_idx in img_bv_indices:
                img_obj = img_bv_indices[bv_idx]
                try:
                    im = Image.open(io.BytesIO(chunk))
                    orig_fmt = (im.format or "").upper()
                    w_im, h_im = im.size
                    need_downscale = (
                        max(w_im, h_im) > tex_limit
                        or orig_fmt != "JPEG"
                        or (jpeg_quality < 82 and len(chunk) > 600_000)
                    )
                    if need_downscale:
                        if im.mode not in ("RGB", "L"):
                            im = im.convert("RGB")
                        if max(w_im, h_im) > tex_limit:
                            im.thumbnail((tex_limit, tex_limit), Image.Resampling.LANCZOS)
                        out_io = io.BytesIO()
                        im.save(out_io, format="JPEG", quality=jpeg_quality, optimize=True)
                        new_chunk = out_io.getvalue()
                        if max(w_im, h_im) > tex_limit or orig_fmt != "JPEG" or len(new_chunk) < len(chunk):
                            chunk = new_chunk
                            img_obj["mimeType"] = "image/jpeg"
                            modified_any = True
                except Exception:
                    pass

            while len(new_bin) % 4 != 0:
                new_bin.append(0)
            new_off = len(new_bin)
            new_bin.extend(chunk)
            target_dict["byteOffset"] = new_off
            target_dict["byteLength"] = len(chunk)

        if not modified_any:
            return orig_size

        while len(new_bin) % 4 != 0:
            new_bin.append(0)
        if j.get("buffers"):
            j["buffers"][0]["byteLength"] = len(new_bin)

        new_j = json.dumps(j, separators=(",", ":")).encode("utf-8")
        while len(new_j) % 4 != 0:
            new_j += b" "

        total_len = 12 + 8 + len(new_j) + 8 + len(new_bin)
        out_glb = bytearray()
        out_glb.extend(struct.pack("<4sII", b"glTF", 2, total_len))
        out_glb.extend(struct.pack("<I4s", len(new_j), b"JSON"))
        out_glb.extend(new_j)
        out_glb.extend(struct.pack("<I4s", len(new_bin), b"BIN\x00"))
        out_glb.extend(new_bin)

        with open(glb_path, "wb") as wf:
            wf.write(out_glb)
        return len(out_glb)
    except Exception:
        return orig_size


def _fill_depth_grid_3x3_np(grid_1d: np.ndarray, g_size: int) -> np.ndarray:
    """Fills 0-valued empty cells in a GxG frontmost depth grid using 3x3 minimum neighbor dilation."""
    grid = grid_1d.reshape((g_size, g_size)).astype(np.float64)
    inf_v = 1e30
    work = np.where(grid > 0.0, grid, inf_v)
    padded = np.pad(work, 1, mode="constant", constant_values=inf_v)
    min_nb = np.minimum.reduce(
        [
            padded[0:g_size, 0:g_size],
            padded[0:g_size, 1 : g_size + 1],
            padded[0:g_size, 2 : g_size + 2],
            padded[1 : g_size + 1, 0:g_size],
            padded[1 : g_size + 1, 1 : g_size + 1],
            padded[1 : g_size + 1, 2 : g_size + 2],
            padded[2 : g_size + 2, 0:g_size],
            padded[2 : g_size + 2, 1 : g_size + 1],
            padded[2 : g_size + 2, 2 : g_size + 2],
        ]
    )
    out = np.where(grid > 0.0, grid, np.where(min_nb < 1e29, min_nb, 0.0))
    return out.ravel()


def _apply_slope_preserving_flatten_zones_to_tileset(
    tileset_dir: str,
    flatten_zones: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """
    Applies Two-Pass Global Slope-Preserving Mesh Flattening (`Z_plane(E,N) = a*(E-cE) + b*(N-cN) + c`)
    inside user-defined polygon zones across all .glb tiles in `tileset_dir`:
      - Pass 1: Collects ground vertices inside each polygon zone and fits a robust IRLS (Huber)
        sloped plane that preserves the real overall drainage grade while rejecting vertical walls/curbs/trees.
      - Pass 2: Modifies vertex elevations in place across all overlapping .glb tiles with smooth boundary
        feathering (`feather_m`) so fake photogrammetric holes and hills are damped without tile seams or edge cliffs.
    """
    import subprocess
    import tempfile
    import shapely
    from shapely.geometry import Polygon as ShapelyPolygon
    from optimizer.geometry_optimizer import (
        find_gltfpack_binary,
        parse_glb_chunks,
        pack_glb_chunks,
        extract_glb_64bit_origin_to_local,
        restore_glb_64bit_origin,
    )
    from cutter.spatial_cutter import _build_gltf_mesh_transforms

    ts_path = os.path.join(tileset_dir, "tileset.json")
    gltf_up = "Z"
    if os.path.isfile(ts_path):
        try:
            ts_j = json.load(open(ts_path, "r", encoding="utf-8"))
            gltf_up = str((ts_j.get("asset") or {}).get("gltfUpAxis") or "Z").upper().strip()
        except Exception:
            gltf_up = "Z"

    # Parse valid polygon zones
    parsed_zones: List[Dict[str, Any]] = []
    for z_idx, z_item in enumerate(flatten_zones or []):
        if not isinstance(z_item, dict):
            continue
        raw_strength = safe_float(z_item.get("strength"))
        if raw_strength is None and z_item.get("keep_residual_ratio") is not None:
            kr = safe_float(z_item.get("keep_residual_ratio"), 0.15)
            raw_strength = 1.0 - (kr if kr is not None else 0.15)
        strength = max(0.05, min(1.0, float(raw_strength if raw_strength is not None else 0.90)))
        raw_max_res = safe_float(z_item.get("max_residual_m"))
        if raw_max_res is None:
            raw_max_res = safe_float(z_item.get("max_dev_m"))
        max_res_m = max(0.08, min(3.0, float(raw_max_res if raw_max_res is not None else 0.45)))
        feather_m = max(0.0, min(10.0, float(safe_float(z_item.get("feather_m"), 1.2) or 1.2)))
        min_z = safe_float(z_item.get("min_z"), -9999.0) or -9999.0
        max_z = safe_float(z_item.get("max_z"), 9999.0) or 9999.0

        raw_polys = []
        if isinstance(z_item.get("native_polygons"), list) and z_item["native_polygons"]:
            raw_polys.extend(z_item["native_polygons"])
        elif z_item.get("native_polygon"):
            raw_polys.append(z_item["native_polygon"])
        elif z_item.get("polygon_native"):
            raw_polys.append(z_item["polygon_native"])
        elif isinstance(z_item.get("polygons_twd97"), list) and z_item["polygons_twd97"]:
            raw_polys.extend(z_item["polygons_twd97"])
        elif z_item.get("polygon_twd97"):
            raw_polys.append(z_item["polygon_twd97"])

        for rp in raw_polys:
            pts2d = _safe_parse_poly2d(rp)
            if not pts2d or len(pts2d) < 3:
                continue
            try:
                sp = ShapelyPolygon(pts2d)
                if not sp.is_valid:
                    sp = sp.buffer(0)
                if sp.is_empty:
                    continue
                parsed_zones.append(
                    {
                        "zone_idx": len(parsed_zones) + 1,
                        "poly": sp,
                        "ext_ring": sp.exterior,
                        "bounds": sp.bounds,
                        "strength": strength,
                        "max_res_m": max_res_m,
                        "feather_m": feather_m,
                        "min_z": min_z,
                        "max_z": max_z,
                        "sample_pts": [],
                    }
                )
            except Exception:
                continue

    if not parsed_zones:
        return {"zones_applied": 0, "vertices_flattened": 0, "tiles_updated": 0, "zone_reports": []}

    gltfpack = find_gltfpack_binary()
    glb_files: List[str] = []
    for r_d, sub_d, f_list in os.walk(tileset_dir):
        sub_d[:] = [d for d in sub_d if d.lower() != "preview_low"]
        for fn in sorted(f_list):
            if fn.lower().endswith(".glb"):
                glb_files.append(os.path.join(r_d, fn))

    # Cache decoded uncompressed GLB data per tile that intersects any zone XY bbox
    decoded_tiles: List[Dict[str, Any]] = []
    with tempfile.TemporaryDirectory() as tmp_d:
        for t_idx, fp in enumerate(glb_files):
            try:
                raw_b = open(fp, "rb").read()
                loc_b, orig_64 = extract_glb_64bit_origin_to_local(raw_b)
                p_in = os.path.join(tmp_d, f"in_{t_idx}.glb")
                p_unc = os.path.join(tmp_d, f"unc_{t_idx}.glb")
                open(p_in, "wb").write(loc_b)
                proc = subprocess.run([gltfpack, "-i", p_in, "-o", p_unc, "-noq"], capture_output=True, timeout=60)
                unc_b = open(p_unc, "rb").read() if (proc.returncode == 0 and os.path.isfile(p_unc)) else loc_b
                j_u, b_u = parse_glb_chunks(unc_b)
                mt = _build_gltf_mesh_transforms(j_u)
                ox, oy, oz = orig_64
                orig_vec = np.array([ox, oy, oz], dtype=np.float64)

                prim_records = []
                tile_intersects = False
                for m_i, m_obj in enumerate(j_u.get("meshes") or []):
                    m_mat = mt.get(m_i, np.eye(4, dtype=np.float64))
                    R_m, t_m = m_mat[:3, :3], m_mat[:3, 3]
                    for p_i, prim in enumerate(m_obj.get("primitives") or []):
                        attrs = prim.get("attributes") or {}
                        if int(prim.get("mode", 4)) != 4 or "POSITION" not in attrs:
                            continue
                        acc_idx = int(attrs["POSITION"])
                        acc = j_u["accessors"][acc_idx]
                        if int(acc.get("componentType", 0)) != 5126:
                            continue
                        bv = j_u["bufferViews"][int(acc["bufferView"])]
                        off = int(bv.get("byteOffset", 0)) + int(acc.get("byteOffset", 0))
                        stride = int(bv.get("byteStride") or 12)
                        cnt = int(acc["count"])
                        if cnt == 0:
                            continue
                        raw_rows = np.frombuffer(b_u, dtype=np.uint8, count=cnt * stride, offset=off).reshape(cnt, stride)
                        pos_f32 = np.frombuffer(raw_rows[:, :12].tobytes(), dtype=np.float32).reshape(cnt, 3)
                        pos_g = pos_f32.astype(np.float64) @ R_m.T + t_m + orig_vec
                        if gltf_up != "Z":
                            pos_zup = np.column_stack([pos_g[:, 0], -pos_g[:, 2], pos_g[:, 1]])
                        else:
                            pos_zup = pos_g

                        px_min, py_min = float(pos_zup[:, 0].min()), float(pos_zup[:, 1].min())
                        px_max, py_max = float(pos_zup[:, 0].max()), float(pos_zup[:, 1].max())
                        prim_hits_any = False
                        for zn in parsed_zones:
                            zminx, zminy, zmaxx, zmaxy = zn["bounds"]
                            if px_max < zminx or px_min > zmaxx or py_max < zminy or py_min > zmaxy:
                                continue
                            cand_m = (
                                (pos_zup[:, 0] >= zminx)
                                & (pos_zup[:, 0] <= zmaxx)
                                & (pos_zup[:, 1] >= zminy)
                                & (pos_zup[:, 1] <= zmaxy)
                                & (pos_zup[:, 2] >= zn["min_z"])
                                & (pos_zup[:, 2] <= zn["max_z"])
                            )
                            c_idx = np.where(cand_m)[0]
                            if len(c_idx) == 0:
                                continue
                            in_p = np.asarray(shapely.contains_xy(zn["poly"], pos_zup[c_idx, 0], pos_zup[c_idx, 1]), dtype=bool)
                            hit_idx = c_idx[in_p]
                            if len(hit_idx) > 0:
                                zn["sample_pts"].append(pos_zup[hit_idx])
                                prim_hits_any = True
                                tile_intersects = True
                        if prim_hits_any:
                            prim_records.append(
                                {
                                    "acc_idx": acc_idx,
                                    "off": off,
                                    "stride": stride,
                                    "cnt": cnt,
                                    "R_m": R_m,
                                    "t_m": t_m,
                                    "pos_zup": pos_zup,
                                }
                            )
                if tile_intersects and prim_records:
                    decoded_tiles.append(
                        {
                            "fp": fp,
                            "orig_64": orig_64,
                            "orig_vec": orig_vec,
                            "j_u": j_u,
                            "b_u": bytearray(b_u),
                            "prims": prim_records,
                        }
                    )
            except Exception as te:
                print(f"[SlopeFlatten] Tile decode note on {fp}: {te}")

        # Pass 1: Fit Global Robust IRLS (Huber) Sloped Plane for each zone
        zone_reports: List[Dict[str, Any]] = []
        active_zones: List[Dict[str, Any]] = []
        for zn in parsed_zones:
            if not zn["sample_pts"]:
                continue
            pts_all = np.vstack(zn["sample_pts"])
            if len(pts_all) < 6:
                continue
            # Subsample up to 40,000 points for fast IRLS plane fitting
            stride_s = max(1, len(pts_all) // 40000)
            pts_fit = pts_all[::stride_s]
            cx, cy = float(pts_fit[:, 0].mean()), float(pts_fit[:, 1].mean())
            dx = pts_fit[:, 0] - cx
            dy = pts_fit[:, 1] - cy
            z_v = pts_fit[:, 2]
            # Anchor initial height near the median ground level (filtering tall roofs/trees)
            z_med = float(np.percentile(z_v, 35))
            w = np.where(np.abs(z_v - z_med) <= max(1.5, zn["max_res_m"] * 3.0), 1.0, 0.05)
            A = np.column_stack([dx, dy, np.ones_like(dx)])
            coef = np.array([0.0, 0.0, z_med], dtype=np.float64)
            for _ in range(8):
                Aw = A * w[:, None]
                coef, _, _, _ = np.linalg.lstsq(Aw, z_v * w, rcond=None)
                res = z_v - (A @ coef)
                inliers = np.abs(res) <= zn["max_res_m"]
                if int(inliers.sum()) < 6:
                    inliers = np.abs(res) <= max(1.2, zn["max_res_m"] * 2.5)
                mad = float(np.median(np.abs(res[inliers] - np.median(res[inliers])))) * 1.4826 + 1e-4 if np.any(inliers) else 0.1
                w = np.where(inliers, 1.0 / np.maximum(1.0, np.abs(res) / (1.345 * mad)), 0.0)

            res_all = pts_all[:, 2] - (coef[0] * (pts_all[:, 0] - cx) + coef[1] * (pts_all[:, 1] - cy) + coef[2])
            g_mask = np.abs(res_all) <= zn["max_res_m"]
            g_res = res_all[g_mask] if np.any(g_mask) else res_all
            rmse_before_cm = round(float(np.sqrt(np.mean(g_res ** 2))) * 100.0, 2)
            p95_before_cm = round(float(np.percentile(np.abs(g_res), 95)) * 100.0, 2)
            rmse_after_cm = round(rmse_before_cm * (1.0 - zn["strength"]), 2)
            p95_after_cm = round(p95_before_cm * (1.0 - zn["strength"]), 2)
            slope_pct = round(float(math.hypot(coef[0], coef[1])) * 100.0, 2)

            zn["cx"] = cx
            zn["cy"] = cy
            zn["coef"] = coef
            active_zones.append(zn)
            zone_reports.append(
                {
                    "zone_index": zn["zone_idx"],
                    "center_xy": [round(cx, 3), round(cy, 3)],
                    "plane_a_dx": round(float(coef[0]), 6),
                    "plane_b_dy": round(float(coef[1]), 6),
                    "plane_c_z": round(float(coef[2]), 3),
                    "preserved_slope_pct": slope_pct,
                    "strength": zn["strength"],
                    "rmse_before_cm": rmse_before_cm,
                    "rmse_after_cm": rmse_after_cm,
                    "p95_before_cm": p95_before_cm,
                    "p95_after_cm": p95_after_cm,
                }
            )

        # Pass 2: Apply Slope-Preserving Flatten across all intersecting tiles & re-pack
        total_verts_flattened = 0
        tiles_updated = 0
        for t_rec in decoded_tiles:
            tile_mod = False
            b_mut = t_rec["b_u"]
            j_u = t_rec["j_u"]
            orig_vec = t_rec["orig_vec"]
            for p_rec in t_rec["prims"]:
                pos_zup = p_rec["pos_zup"].copy()
                prim_mod = False
                for zn in active_zones:
                    zminx, zminy, zmaxx, zmaxy = zn["bounds"]
                    cand_m = (
                        (pos_zup[:, 0] >= zminx)
                        & (pos_zup[:, 0] <= zmaxx)
                        & (pos_zup[:, 1] >= zminy)
                        & (pos_zup[:, 1] <= zmaxy)
                        & (pos_zup[:, 2] >= zn["min_z"])
                        & (pos_zup[:, 2] <= zn["max_z"])
                    )
                    c_idx = np.where(cand_m)[0]
                    if len(c_idx) == 0:
                        continue
                    in_p = np.asarray(shapely.contains_xy(zn["poly"], pos_zup[c_idx, 0], pos_zup[c_idx, 1]), dtype=bool)
                    hit_idx = c_idx[in_p]
                    if len(hit_idx) == 0:
                        continue
                    hx = pos_zup[hit_idx, 0]
                    hy = pos_zup[hit_idx, 1]
                    hz = pos_zup[hit_idx, 2]
                    coef = zn["coef"]
                    z_plane = coef[0] * (hx - zn["cx"]) + coef[1] * (hy - zn["cy"]) + coef[2]
                    res_h = z_plane - hz
                    # Smooth vertical weight so obstacles/walls above max_res_m are untouched
                    abs_r = np.abs(res_h)
                    v_weight = np.where(
                        abs_r <= zn["max_res_m"],
                        1.0,
                        np.clip(1.0 - (abs_r - zn["max_res_m"]) / 0.25, 0.0, 1.0),
                    )
                    # Smooth boundary feathering weight over feather_m
                    if zn["feather_m"] > 0.05 and hasattr(shapely, "points"):
                        pts_geom = shapely.points(hx, hy)
                        d_edge = np.asarray(shapely.distance(zn["ext_ring"], pts_geom), dtype=np.float64)
                        f_weight = np.clip(d_edge / zn["feather_m"], 0.15, 1.0)
                    else:
                        f_weight = 1.0
                    eff_alpha = zn["strength"] * v_weight * f_weight
                    active_v = eff_alpha > 0.001
                    if np.any(active_v):
                        pos_zup[hit_idx, 2] = hz + eff_alpha * res_h
                        total_verts_flattened += int(np.count_nonzero(active_v))
                        prim_mod = True

                if prim_mod:
                    tile_mod = True
                    if gltf_up != "Z":
                        pos_g_new = np.column_stack([pos_zup[:, 0], pos_zup[:, 2], -pos_zup[:, 1]])
                    else:
                        pos_g_new = pos_zup
                    R_inv = np.linalg.inv(p_rec["R_m"])
                    pos_f32_new = ((pos_g_new - orig_vec - p_rec["t_m"]) @ R_inv.T).astype(np.float32)
                    acc = j_u["accessors"][p_rec["acc_idx"]]
                    acc["min"] = [float(x) for x in pos_f32_new.min(axis=0)]
                    acc["max"] = [float(x) for x in pos_f32_new.max(axis=0)]
                    cnt = p_rec["cnt"]
                    stride = p_rec["stride"]
                    off = p_rec["off"]
                    arr_view = np.frombuffer(b_mut, dtype=np.uint8, count=cnt * stride, offset=off).reshape(cnt, stride)
                    arr_view[:, :12] = pos_f32_new.view(np.uint8).reshape(cnt, 12)

            if tile_mod:
                for ext_k in ("extensionsUsed", "extensionsRequired"):
                    if ext_k in j_u and isinstance(j_u[ext_k], list):
                        j_u[ext_k] = [e for e in j_u[ext_k] if e not in ("EXT_meshopt_compression", "KHR_mesh_quantization")]
                        if not j_u[ext_k]:
                            del j_u[ext_k]
                mod_loc_b = pack_glb_chunks(j_u, bytes(b_mut))
                p_mod = os.path.join(tmp_d, f"mod_{tiles_updated}.glb")
                p_cmp = os.path.join(tmp_d, f"cmp_{tiles_updated}.glb")
                open(p_mod, "wb").write(mod_loc_b)
                proc_c = subprocess.run(
                    [gltfpack, "-i", p_mod, "-o", p_cmp, "-cc", "-vp", "16", "-vt", "16", "-vn", "8", "-vc", "8"],
                    capture_output=True,
                    timeout=90,
                )
                out_loc_b = open(p_cmp, "rb").read() if (proc_c.returncode == 0 and os.path.isfile(p_cmp)) else mod_loc_b
                final_b = restore_glb_64bit_origin(out_loc_b, t_rec["orig_64"]) if t_rec["orig_64"] != (0.0, 0.0, 0.0) else out_loc_b
                with open(t_rec["fp"], "wb") as wf:
                    wf.write(final_b)
                tiles_updated += 1

    return {
        "zones_applied": len(zone_reports),
        "vertices_flattened": total_verts_flattened,
        "tiles_updated": tiles_updated,
        "zone_reports": zone_reports,
    }


def _eval_multiscan_layer_delete_mask(
    v_centered: np.ndarray,
    f_v0_idx: np.ndarray,
    scan_id: str,
    deletions: List[Dict[str, Any]],
) -> np.ndarray:
    """
    Evaluates staged Multi-Scan 3D Lasso frustum strokes & 2D Plan Polygons on a single scan layer's
    centered Z-up mesh (`v_centered`, `f_v0_idx`), returning a boolean mask of faces to delete.
    """
    num_faces = len(f_v0_idx)
    overall_del = np.zeros(num_faces, dtype=bool)
    if num_faces == 0 or not deletions:
        return overall_del

    import shapely
    from shapely.geometry import Polygon as ShapelyPolygon

    p0 = v_centered[f_v0_idx[:, 0]]
    p1 = v_centered[f_v0_idx[:, 1]]
    p2 = v_centered[f_v0_idx[:, 2]]
    pc = (p0 + p1 + p2) * (1.0 / 3.0)

    for batch in deletions:
        if not isinstance(batch, dict):
            continue
        batch_mask = np.zeros(num_faces, dtype=bool)

        for st in batch.get("frustum_strokes") or []:
            if not isinstance(st, dict):
                continue
            lmap = st.get("layer_zup_to_clip")
            if not isinstance(lmap, dict) or scan_id not in lmap:
                continue
            mat16 = lmap.get(scan_id)
            ndc_pts = st.get("ndc_polygon") or []
            if not isinstance(mat16, list) or len(mat16) != 16 or len(ndc_pts) < 3:
                continue
            try:
                poly = ShapelyPolygon(ndc_pts)
                if not poly.is_valid:
                    poly = poly.buffer(0)
                if poly.is_empty:
                    continue
            except Exception:
                continue

            b_min_x, b_min_y, b_max_x, b_max_y = poly.bounds
            m_col = np.asarray(mat16, dtype=np.float64).reshape((4, 4), order="F")
            is_sub = str(st.get("op") or "add") == "sub"

            cw0 = p0 @ m_col[3, :3] + m_col[3, 3]
            cw1 = p1 @ m_col[3, :3] + m_col[3, 3]
            cw2 = p2 @ m_col[3, :3] + m_col[3, 3]
            valid_idx = np.flatnonzero((cw0 > 0.05) & (cw1 > 0.05) & (cw2 > 0.05) & (batch_mask if is_sub else ~batch_mask))
            if len(valid_idx) == 0:
                continue

            p0_v = p0[valid_idx]
            p1_v = p1[valid_idx]
            p2_v = p2[valid_idx]
            pc_v = pc[valid_idx]
            raw_sb = st.get("section_box")
            wmap = st.get("layer_zup_to_world")
            if (
                isinstance(raw_sb, dict)
                and isinstance(raw_sb.get("center"), list)
                and len(raw_sb["center"]) >= 3
                and isinstance(raw_sb.get("half"), list)
                and len(raw_sb["half"]) >= 3
                and isinstance(wmap, dict)
                and isinstance(wmap.get(scan_id), list)
                and len(wmap[scan_id]) == 16
            ):
                mw_col = np.asarray(wmap[scan_id], dtype=np.float64).reshape((4, 4), order="F")
                rw, tw = mw_col[:3, :3], mw_col[:3, 3]
                yaw_r = float(raw_sb.get("yaw_rad") or 0.0)
                cos_y, sin_y = float(np.cos(yaw_r)), float(np.sin(yaw_r))
                sb_cx, sb_cy, sb_cz = float(raw_sb["center"][0]), float(raw_sb["center"][1]), float(raw_sb["center"][2])
                sb_hx, sb_hy, sb_hz = max(0.05, float(raw_sb["half"][0])), max(0.05, float(raw_sb["half"][1])), max(0.05, float(raw_sb["half"][2]))

                def _in_sb(pts_l: np.ndarray) -> np.ndarray:
                    pts_w = pts_l @ rw.T + tw
                    dy = np.abs(pts_w[:, 1] - sb_cy) <= (sb_hy + 1e-4)
                    dx = pts_w[:, 0] - sb_cx
                    dz = pts_w[:, 2] - sb_cz
                    lx = np.abs(dx * cos_y - dz * sin_y) <= (sb_hx + 1e-4)
                    lz = np.abs(dx * sin_y + dz * cos_y) <= (sb_hz + 1e-4)
                    return dy & lx & lz

                sb_keep = _in_sb(pc_v) | ((_in_sb(p0_v).astype(np.int8) + _in_sb(p1_v).astype(np.int8) + _in_sb(p2_v).astype(np.int8)) >= 2)
                valid_idx = valid_idx[sb_keep]
                if len(valid_idx) == 0:
                    continue
                p0_v = p0[valid_idx]
                p1_v = p1[valid_idx]
                p2_v = p2[valid_idx]
                pc_v = pc[valid_idx]
            w0 = cw0[valid_idx]
            w1 = cw1[valid_idx]
            w2 = cw2[valid_idx]
            wc = (w0 + w1 + w2) * (1.0 / 3.0)

            nx0 = (p0_v @ m_col[0, :3] + m_col[0, 3]) / w0
            ny0 = (p0_v @ m_col[1, :3] + m_col[1, 3]) / w0
            nx1 = (p1_v @ m_col[0, :3] + m_col[0, 3]) / w1
            ny1 = (p1_v @ m_col[1, :3] + m_col[1, 3]) / w1
            nx2 = (p2_v @ m_col[0, :3] + m_col[0, 3]) / w2
            ny2 = (p2_v @ m_col[1, :3] + m_col[1, 3]) / w2
            nxc = (pc_v @ m_col[0, :3] + m_col[0, 3]) / wc
            nyc = (pc_v @ m_col[1, :3] + m_col[1, 3]) / wc

            in_bbox = (
                (np.maximum.reduce([nx0, nx1, nx2, nxc]) >= b_min_x)
                & (np.minimum.reduce([nx0, nx1, nx2, nxc]) <= b_max_x)
                & (np.maximum.reduce([ny0, ny1, ny2, nyc]) >= b_min_y)
                & (np.minimum.reduce([ny0, ny1, ny2, nyc]) <= b_max_y)
            )
            sub_idx = np.flatnonzero(in_bbox)
            if len(sub_idx) == 0:
                continue

            hit_c = shapely.contains_xy(poly, nxc[sub_idx], nyc[sub_idx])
            rem = np.flatnonzero(~hit_c)
            if len(rem) > 0:
                r_idx = sub_idx[rem]
                v_cnt = (
                    shapely.contains_xy(poly, nx0[r_idx], ny0[r_idx]).astype(np.int8)
                    + shapely.contains_xy(poly, nx1[r_idx], ny1[r_idx]).astype(np.int8)
                    + shapely.contains_xy(poly, nx2[r_idx], ny2[r_idx]).astype(np.int8)
                )
                hit_c[rem] = v_cnt >= 2

            hit_local = sub_idx[hit_c]
            if len(hit_local) == 0:
                continue

            vis_only = bool(st.get("visible_only", False))
            g_sz = int(st.get("depth_grid_size") or 0)
            raw_dg = st.get("depth_grid")
            if vis_only and g_sz >= 8 and isinstance(raw_dg, list) and len(raw_dg) == g_sz * g_sz:
                dg_arr = np.asarray(raw_dg, dtype=np.float64)
                pos_vals = dg_arr[dg_arr > 0.0]
                if len(pos_vals) > 0:
                    max_valid_w = float(pos_vals.max())
                    dg_filled = _fill_depth_grid_3x3_np(dg_arr, g_sz)
                    tol_m = float(st.get("depth_tolerance_m") or 0.85)
                    gx = np.clip(np.floor((nxc[hit_local] * 0.5 + 0.5) * g_sz).astype(np.int64), 0, g_sz - 1)
                    gy = np.clip(np.floor((nyc[hit_local] * 0.5 + 0.5) * g_sz).astype(np.int64), 0, g_sz - 1)
                    cell_w = dg_filled[gy * g_sz + gx]
                    eff_front_w = np.where(cell_w > 0.0, cell_w, max_valid_w)
                    tol = np.maximum(tol_m, 0.03 * eff_front_w)
                    tri_near_w = np.minimum.reduce([wc[hit_local], w0[hit_local], w1[hit_local], w2[hit_local]])
                    vis_keep = tri_near_w <= (eff_front_w + tol)
                    hit_local = hit_local[vis_keep]

            if len(hit_local) > 0:
                target_faces = valid_idx[hit_local]
                batch_mask[target_faces] = False if is_sub else True

        poly_map = batch.get("layer_centered_polygons")
        if isinstance(poly_map, dict) and isinstance(poly_map.get(scan_id), list):
            for raw_p in poly_map[scan_id]:
                if not isinstance(raw_p, list) or len(raw_p) < 3:
                    continue
                try:
                    p2d = ShapelyPolygon([(float(pt[0]), float(pt[1])) for pt in raw_p])
                    if not p2d.is_valid:
                        p2d = p2d.buffer(0)
                    if not p2d.is_empty:
                        batch_mask |= shapely.contains_xy(p2d, pc[:, 0], pc[:, 1])
                except Exception:
                    pass

        overall_del |= batch_mask

    return overall_del


def _trim_multiscan_overlap_skirts(
    parts_list: List[Dict[str, Any]],
    cell_m: float = 0.5,
    border_m: float = 4.0,
    safety_margin_m: float = 1.5,
    max_z_diff_m: float = 4.5,
) -> int:
    """
    Removes noisy outer photogrammetry boundary 'skirt' triangles in overlap zones between aligned scans.
    A perimeter triangle of scan `s` (`dist_from_outer_edge <= border_m`) is trimmed ONLY when another
    scan `j` covers that exact XY location strictly deeper inside its interior
    (`dist_j >= max(2.5m, dist_s + safety_margin_m)`) within `max_z_diff_m` vertical separation.
    Because the scan with strictly maximum interior distance at any cell can never satisfy
    `dist_other >= dist_self + safety_margin_m`, zero gaps can ever open between adjacent scans.
    """
    scan_ids_unique = sorted({int(p["scan_idx"]) for p in parts_list if len(p.get("f", ())) > 0})
    if len(scan_ids_unique) < 2:
        return 0
    try:
        from scipy import ndimage as _ndi
    except Exception:
        return 0

    xmin, ymin = 1e30, 1e30
    xmax, ymax = -1e30, -1e30
    for p in parts_list:
        f_p = p.get("f")
        v_p = p.get("v_local")
        if f_p is None or v_p is None or len(f_p) == 0:
            continue
        used_idx = np.clip(np.unique(f_p[:, [0, 2, 4]] - 1), 0, len(v_p) - 1)
        vs = v_p[used_idx]
        xmin = min(xmin, float(vs[:, 0].min()))
        ymin = min(ymin, float(vs[:, 1].min()))
        xmax = max(xmax, float(vs[:, 0].max()))
        ymax = max(ymax, float(vs[:, 1].max()))

    span_x = max(1.0, xmax - xmin)
    span_y = max(1.0, ymax - ymin)
    eff_cell = max(cell_m, max(span_x, span_y) / 2200.0)
    pad_m = eff_cell * 3.0
    x0 = xmin - pad_m
    y0 = ymin - pad_m
    nx = int(math.ceil((xmax + pad_m - x0) / eff_cell)) + 1
    ny = int(math.ceil((ymax + pad_m - y0) / eff_cell)) + 1
    if nx < 8 or ny < 8:
        return 0

    dist_by_scan: Dict[int, np.ndarray] = {}
    z_by_scan: Dict[int, np.ndarray] = {}
    close_struct = np.ones((3, 3), dtype=bool)

    for s_idx in scan_ids_unique:
        occ = np.zeros((ny, nx), dtype=bool)
        z_sum = np.zeros((ny, nx), dtype=np.float64)
        z_cnt = np.zeros((ny, nx), dtype=np.int32)
        for p in parts_list:
            if int(p["scan_idx"]) != s_idx or len(p["f"]) == 0:
                continue
            v_p = p["v_local"]
            f_p = p["f"]
            i0 = np.clip(f_p[:, 0] - 1, 0, len(v_p) - 1)
            i1 = np.clip(f_p[:, 2] - 1, 0, len(v_p) - 1)
            i2 = np.clip(f_p[:, 4] - 1, 0, len(v_p) - 1)
            p0, p1, p2 = v_p[i0], v_p[i1], v_p[i2]
            samples = np.vstack(
                [
                    p0,
                    p1,
                    p2,
                    (p0 + p1) * 0.5,
                    (p1 + p2) * 0.5,
                    (p2 + p0) * 0.5,
                    (p0 + p1 + p2) * (1.0 / 3.0),
                ]
            )
            gx = np.clip(((samples[:, 0] - x0) / eff_cell).astype(np.int32), 0, nx - 1)
            gy = np.clip(((samples[:, 1] - y0) / eff_cell).astype(np.int32), 0, ny - 1)
            occ[gy, gx] = True
            np.add.at(z_sum, (gy, gx), samples[:, 2].astype(np.float64))
            np.add.at(z_cnt, (gy, gx), 1)

        occ_closed = _ndi.binary_closing(occ, structure=close_struct)
        dist_m = _ndi.distance_transform_edt(occ_closed).astype(np.float32) * float(eff_cell)
        z_grid = np.full((ny, nx), np.nan, dtype=np.float32)
        valid_z = z_cnt > 0
        z_grid[valid_z] = (z_sum[valid_z] / z_cnt[valid_z]).astype(np.float32)
        if np.any(~valid_z & occ_closed):
            _, nearest_idx = _ndi.distance_transform_edt(~valid_z, return_indices=True)
            z_grid = z_grid[nearest_idx[0], nearest_idx[1]]
        dist_by_scan[s_idx] = dist_m
        z_by_scan[s_idx] = z_grid

    total_trimmed = 0
    for p in parts_list:
        s_idx = int(p["scan_idx"])
        f_p = p["f"]
        v_p = p["v_local"]
        if len(f_p) < 32:
            continue
        i0 = np.clip(f_p[:, 0] - 1, 0, len(v_p) - 1)
        i1 = np.clip(f_p[:, 2] - 1, 0, len(v_p) - 1)
        i2 = np.clip(f_p[:, 4] - 1, 0, len(v_p) - 1)
        p0, p1, p2 = v_p[i0], v_p[i1], v_p[i2]
        cent = (p0 + p1 + p2) * (1.0 / 3.0)

        gx_c = np.clip(((cent[:, 0] - x0) / eff_cell).astype(np.int32), 0, nx - 1)
        gy_c = np.clip(((cent[:, 1] - y0) / eff_cell).astype(np.int32), 0, ny - 1)
        gx_0 = np.clip(((p0[:, 0] - x0) / eff_cell).astype(np.int32), 0, nx - 1)
        gy_0 = np.clip(((p0[:, 1] - y0) / eff_cell).astype(np.int32), 0, ny - 1)
        gx_1 = np.clip(((p1[:, 0] - x0) / eff_cell).astype(np.int32), 0, nx - 1)
        gy_1 = np.clip(((p1[:, 1] - y0) / eff_cell).astype(np.int32), 0, ny - 1)
        gx_2 = np.clip(((p2[:, 0] - x0) / eff_cell).astype(np.int32), 0, nx - 1)
        gy_2 = np.clip(((p2[:, 1] - y0) / eff_cell).astype(np.int32), 0, ny - 1)

        d_map_self = dist_by_scan[s_idx]
        d_self = np.minimum.reduce(
            [
                d_map_self[gy_c, gx_c],
                d_map_self[gy_0, gx_0],
                d_map_self[gy_1, gx_1],
                d_map_self[gy_2, gx_2],
            ]
        )

        best_other_d = np.zeros(len(f_p), dtype=np.float32)
        best_other_z = np.full(len(f_p), np.nan, dtype=np.float32)
        for j_idx in scan_ids_unique:
            if j_idx == s_idx:
                continue
            dj = dist_by_scan[j_idx][gy_c, gx_c]
            zj = z_by_scan[j_idx][gy_c, gx_c]
            better = dj > best_other_d
            best_other_d = np.where(better, dj, best_other_d)
            best_other_z = np.where(better, zj, best_other_z)

        dz_ok = np.isnan(best_other_z) | (np.abs(cent[:, 2] - best_other_z) <= float(max_z_diff_m))
        drop_mask = (
            (d_self <= float(border_m))
            & (best_other_d >= np.maximum(2.5, d_self + float(safety_margin_m)))
            & dz_ok
        )
        n_drop = int(drop_mask.sum())
        if n_drop > 0 and n_drop > int(len(f_p) * 0.40):
            # Safety guard: only trim the outermost perimeter triangles up to 40% of a scan part
            cand_idx = np.flatnonzero(drop_mask)
            order = np.argsort(d_self[cand_idx])
            keep_limit = int(len(f_p) * 0.40)
            drop_mask[:] = False
            drop_mask[cand_idx[order[:keep_limit]]] = True
            n_drop = int(drop_mask.sum())

        if n_drop > 0 and (len(f_p) - n_drop) >= 16:
            p["f"] = f_p[~drop_mask]
            total_trimmed += n_drop

    return total_trimmed


class OptimizerBridge:
    def __init__(self, db: ScanQueueDB):
        self.db = db
        self.exports_dir = os.path.join(GC_SCAN_OPTIMIZER_DIR, "exports")
        os.makedirs(self.exports_dir, exist_ok=True)

    def get_presets(self) -> Dict[str, Any]:
        try:
            from optimizer.presets import PRESETS
            return PRESETS
        except Exception:
            return {
                "quality": {
                    "label": "High Fidelity (2K KTX2)",
                    "target_triangle_ratio": 0.75,
                    "texture_limit": 2048,
                    "description": "Preserves fine structural details with 2K BasisU textures.",
                },
                "balanced": {
                    "label": "Balanced Web Stream (Default)",
                    "target_triangle_ratio": 0.50,
                    "texture_limit": 2048,
                    "description": "Optimal balance of fast web streaming and crisp 2K textures.",
                },
                "web": {
                    "label": "Fast Mobile / Field Tablet",
                    "target_triangle_ratio": 0.35,
                    "texture_limit": 1024,
                    "description": "High frame-rate streaming for 4G/5G field devices.",
                },
                "ultra_light": {
                    "label": "Ultra-Light Browser Offline Cache",
                    "target_triangle_ratio": 0.20,
                    "texture_limit": 1024,
                    "description": "Compact footprint ideal for client-side browser offline caching.",
                },
            }

    def get_backup_status(self, scan_id: str) -> Dict[str, Any]:
        scan = self.db.get_scan(scan_id) or {}
        ts_path = scan.get("tileset_path") or ""
        in_dir = os.path.dirname(ts_path) if (ts_path and os.path.isfile(ts_path)) else ts_path
        proj_dir = scan.get("project_dir") or (os.path.dirname(in_dir) if in_dir else "")
        if not proj_dir or not os.path.isdir(proj_dir):
            return {"has_original_backup": False, "has_undo": False}
        orig_bk = os.path.join(proj_dir, "tileset_backup")
        prev_bk = os.path.join(proj_dir, "tileset_prev")
        has_orig = os.path.isfile(os.path.join(orig_bk, "tileset.json"))
        has_undo = os.path.isfile(os.path.join(prev_bk, "tileset.json"))
        return {
            "has_original_backup": has_orig,
            "has_undo": has_undo,
            "original_backup_mtime": round(os.path.getmtime(os.path.join(orig_bk, "tileset.json")), 2) if has_orig else 0.0,
            "undo_mtime": round(os.path.getmtime(os.path.join(prev_bk, "tileset.json")), 2) if has_undo else 0.0,
        }

    @staticmethod
    def _is_junc_or_link(path: str) -> bool:
        return bool(os.path.islink(path) or getattr(os.path, "isjunction", lambda p: False)(path))

    @staticmethod
    def _is_sacred_source_path(path: str) -> bool:
        if not path:
            return False
        rp = os.path.realpath(path).replace("/", "\\").lower()
        return rp.startswith("c:\\scans\\") or rp == "c:\\scans" or rp.startswith("g:\\shared drives\\")

    def _create_pre_edit_backups(self, proj_dir: str, in_dir: str) -> None:
        """
        Ensures EVERY destructive edit creates:
        1. `<proj_dir>/tileset_backup`: Pristine original scan tileset (created before the first edit and never overwritten).
        2. `<proj_dir>/tileset_prev`: 1-step Undo snapshot right before the current edit.
        """
        if not proj_dir or not in_dir or not os.path.isdir(in_dir):
            return
        if self._is_sacred_source_path(proj_dir) or self._is_junc_or_link(proj_dir):
            proj_dir = os.path.dirname(os.path.abspath(in_dir))
        if self._is_sacred_source_path(proj_dir):
            return
        # Skip multi-GB copytree backup if in_dir contains junctions into sacred C:\Scans (C:\Scans already holds pristine originals!)
        for entry in os.listdir(in_dir):
            ep = os.path.join(in_dir, entry)
            if self._is_junc_or_link(ep) and self._is_sacred_source_path(ep):
                return
        os.makedirs(proj_dir, exist_ok=True)
        orig_bk = os.path.join(proj_dir, "tileset_backup")
        prev_bk = os.path.join(proj_dir, "tileset_prev")

        def _ignore_preview(cur_d, names):
            return [n for n in names if n.lower() in {"preview_low", "preview_tileset.json"}]

        if not os.path.isfile(os.path.join(orig_bk, "tileset.json")):
            if os.path.isdir(orig_bk):
                shutil.rmtree(orig_bk, ignore_errors=True)
            shutil.copytree(in_dir, orig_bk, ignore=_ignore_preview)

        prev_tmp = os.path.join(proj_dir, f"tileset_prev_tmp_{int(time.time() * 1000)}")
        shutil.copytree(in_dir, prev_tmp, ignore=_ignore_preview)
        if os.path.isdir(prev_bk):
            shutil.rmtree(prev_bk, ignore_errors=True)
        os.replace(prev_tmp, prev_bk)

    def _replace_tileset_cleanly_and_refresh(
        self,
        scan: Dict[str, Any],
        src_tileset_dir: str,
        in_dir: str,
        new_size_bytes: int,
        extra_updates: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Atomically replaces `in_dir` (`tileset/`) with `src_tileset_dir` so pruned `.glb` files
        are completely removed (preventing orphaned tiles from polluting DSM or disk), bumps mtime
        for cache-busting, and regenerates `preview_tileset.json`, `thumbnail.png`, and `.3tz`.
        """
        scan_id = scan["scan_id"]
        proj_dir = scan.get("project_dir") or os.path.dirname(in_dir)
        if self._is_sacred_source_path(proj_dir) or self._is_junc_or_link(proj_dir):
            proj_dir = os.path.dirname(os.path.abspath(in_dir))

        # Detach top-level junction before any file cleanup so C:\Scans is NEVER touched
        if self._is_junc_or_link(in_dir):
            os.rmdir(in_dir)
            os.makedirs(in_dir, exist_ok=True)
        elif self._is_sacred_source_path(in_dir):
            raise RuntimeError(f"Refusing to modify sacred source directory: {in_dir}")
        elif os.path.isdir(in_dir):
            for entry in os.listdir(in_dir):
                ep = os.path.join(in_dir, entry)
                if self._is_junc_or_link(ep):
                    try:
                        os.rmdir(ep)
                    except OSError:
                        os.unlink(ep)
                elif self._is_sacred_source_path(ep):
                    continue
                elif os.path.isdir(ep):
                    shutil.rmtree(ep, ignore_errors=True)
                else:
                    try:
                        os.remove(ep)
                    except OSError:
                        pass
        else:
            os.makedirs(in_dir, exist_ok=True)

        now_ts = time.time()
        for r_root, r_dirs, r_files in os.walk(src_tileset_dir):
            r_dirs[:] = [d for d in r_dirs if d.lower() != "preview_low"]
            rel_r = os.path.relpath(r_root, src_tileset_dir)
            dst_r = in_dir if rel_r == "." else os.path.join(in_dir, rel_r)
            os.makedirs(dst_r, exist_ok=True)
            for fn in r_files:
                if fn.lower() == "preview_tileset.json":
                    continue
                dst_fp = os.path.join(dst_r, fn)
                shutil.copy2(os.path.join(r_root, fn), dst_fp)
                try:
                    os.utime(dst_fp, (now_ts, now_ts))
                except OSError:
                    pass

        ts_path = os.path.join(in_dir, "tileset.json")
        try:
            os.utime(ts_path, (now_ts, now_ts))
        except OSError:
            pass

        # Invalidate ALL DSM disk caches (_dsm_cache_*.npz)
        import glob as _glob_dsm
        for search_d in {proj_dir, in_dir}:
            if search_d and os.path.isdir(search_d) and not self._is_sacred_source_path(search_d):
                for cp in _glob_dsm.glob(os.path.join(search_d, "_dsm_cache_*.npz")):
                    try:
                        os.remove(cp)
                    except OSError:
                        pass

        # Regenerate low-quality preview tileset & thumbnail synchronously so immediate UI reload sees edited mesh
        try:
            from pc_worker.preview_generator import (
                ensure_scan_low_quality_preview,
                ensure_scan_full_quality_thumbnail,
            )
            ensure_scan_low_quality_preview(ts_path, force=True)
            ensure_scan_full_quality_thumbnail(ts_path, scan_id, project_dir=proj_dir, force=True)
        except Exception as pe:
            print(f"[OptimizerBridge] Preview/thumbnail refresh note for {scan_id}: {pe}")

        tileset_ver_ms = int(now_ts * 1000)
        scan_upd = dict(scan)
        if new_size_bytes > 0:
            scan_upd["size_bytes"] = max(int(new_size_bytes), 1024)
        scan_upd["tileset_path"] = ts_path
        scan_upd["tileset_version"] = tileset_ver_ms
        if extra_updates:
            scan_upd.update(extra_updates)
        self.db.upsert_scan(scan_upd)

        # Persist tileset_version in scan_meta.json as well
        meta_fp = os.path.join(proj_dir, "scan_meta.json")
        if os.path.isfile(meta_fp):
            try:
                with open(meta_fp, "r", encoding="utf-8") as mf:
                    m_obj = json.load(mf)
                if isinstance(m_obj, dict):
                    m_obj["size_bytes"] = scan_upd.get("size_bytes", m_obj.get("size_bytes"))
                    m_obj["covered_area_m2"] = scan_upd.get("covered_area_m2", m_obj.get("covered_area_m2"))
                    m_obj["tileset_version"] = tileset_ver_ms
                    with open(meta_fp, "w", encoding="utf-8") as mf:
                        json.dump(m_obj, mf, ensure_ascii=False, indent=2)
            except Exception:
                pass

        # Rebuild .3tz package & push cloud manifest asynchronously so HTTP response returns immediately
        def _bg_sync_3tz():
            try:
                from pc_worker.gdrive_cloud_sync import build_scan_3tz_package, sync_all_scans_to_gdrive_and_vps
                build_scan_3tz_package(
                    {"scan_id": scan_id, "tileset_path": ts_path, "project_dir": proj_dir},
                    force=True,
                )
                sync_all_scans_to_gdrive_and_vps(self.db, None, force=False)
            except Exception as ce:
                print(f"[OptimizerBridge] Background .3tz rebuild note for {scan_id}: {ce}")

        threading.Thread(target=_bg_sync_3tz, daemon=True).start()
        return scan_upd

    def restore_scan_backup(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Restores a scan's `tileset/` from either:
          - `target="undo"` (`<proj_dir>/tileset_prev` — 1-step Undo Last Edit)
          - `target="original"` (`<proj_dir>/tileset_backup` — Pristine Original Scan)
        """
        scan_id = str(payload.get("scan_id") or "").strip()
        target = str(payload.get("target") or "original").lower().strip()
        scan = self.db.get_scan(scan_id)
        if not scan:
            raise ValueError(f"Scan not found: {scan_id}")

        ts_path = scan.get("tileset_path") or ""
        in_dir = os.path.dirname(ts_path) if (ts_path and os.path.isfile(ts_path)) else ts_path
        proj_dir = scan.get("project_dir") or (os.path.dirname(in_dir) if in_dir else "")
        if not proj_dir or not in_dir:
            raise FileNotFoundError(f"Project/tileset directory not found for {scan_id}")

        orig_bk = os.path.join(proj_dir, "tileset_backup")
        prev_bk = os.path.join(proj_dir, "tileset_prev")
        src_bk = prev_bk if target in ("undo", "prev", "undo_last") else orig_bk
        if not os.path.isfile(os.path.join(src_bk, "tileset.json")):
            raise FileNotFoundError(
                f"No {'Undo snapshot' if src_bk == prev_bk else 'Original Scan backup'} exists for {scan_id}."
            )

        t0 = time.time()
        # Copy source backup to temp dir first so restoring 'undo' or swapping 'prev' is 100% atomic
        stage_restore = os.path.join(proj_dir, f"_restore_stage_{int(t0 * 1000)}")
        shutil.copytree(src_bk, stage_restore)
        try:
            # Save current state into tileset_prev so even Restore Original can be undone if clicked accidentally
            if os.path.isfile(os.path.join(in_dir, "tileset.json")):
                def _ignore_preview(cur_d, names):
                    return [n for n in names if n.lower() in {"preview_low", "preview_tileset.json"}]
                swap_prev = os.path.join(proj_dir, f"_prev_swap_{int(t0 * 1000)}")
                shutil.copytree(in_dir, swap_prev, ignore=_ignore_preview)
                if os.path.isdir(prev_bk):
                    shutil.rmtree(prev_bk, ignore_errors=True)
                os.replace(swap_prev, prev_bk)

            restored_bytes = sum(
                os.path.getsize(os.path.join(r, fn))
                for r, _, files in os.walk(stage_restore)
                for fn in files
            )
            self._replace_tileset_cleanly_and_refresh(scan, stage_restore, in_dir, restored_bytes)
        finally:
            if os.path.isdir(stage_restore):
                shutil.rmtree(stage_restore, ignore_errors=True)

        bk_state = self.get_backup_status(scan_id)
        return {
            "status": "ok",
            "action": "restore_backup",
            "scan_id": scan_id,
            "target": "undo" if src_bk == prev_bk else "original",
            "restored_mb": round(restored_bytes / (1024 * 1024), 2),
            "duration_s": round(time.time() - t0, 2),
            **bk_state,
        }

    def run_optimize_action(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Invokes the real GC_ScanOptimizer TilesetOptimizer on the selected scan's 3D Tileset.
        Performs real gltfpack mesh decimation, 64-bit origin-safe attribute quantization, and embedded texture resizing.
        """
        scan_id = (payload.get("scan_id") or "").strip()
        preset_name = str(payload.get("preset", "balanced")).lower().strip()
        preset_key = "ultra" if preset_name == "ultra_light" else preset_name
        if preset_key not in ("quality", "balanced", "web", "ultra"):
            preset_key = "balanced"

        scan = self.db.get_scan(scan_id)
        if not scan:
            raise ValueError(f"Scan not found: {scan_id}")

        ts_path = scan.get("tileset_path") or ""
        if not ts_path or not os.path.exists(ts_path):
            raise FileNotFoundError(f"Tileset path not found on PC: {ts_path}")

        t0 = time.time()
        out_folder_name = payload.get("output_name") or f"{scan_id}_{preset_name}_opt_{int(t0)}"
        out_dir = os.path.join(self.exports_dir, out_folder_name)
        if os.path.isdir(out_dir):
            shutil.rmtree(out_dir, ignore_errors=True)
        os.makedirs(out_dir, exist_ok=True)

        in_dir = os.path.dirname(ts_path) if os.path.isfile(ts_path) else ts_path
        if not os.path.isdir(in_dir):
            raise FileNotFoundError(f"Input tileset directory not found: {in_dir}")
        proj_dir = scan.get("project_dir") or os.path.dirname(in_dir)

        from optimizer.tileset_optimizer import TilesetOptimizer

        opt = TilesetOptimizer(
            input_dir=in_dir,
            output_dir=out_dir,
            preset_name=preset_key,
            resume=False,
        )
        stats = opt.run()

        tex_limit_map = {"quality": 2048, "balanced": 1536, "web": 1024, "ultra": 768}
        jpeg_qual_map = {"quality": 85, "balanced": 76, "web": 68, "ultra": 58}
        target_tex = tex_limit_map.get(preset_key, 1536)
        target_qual = jpeg_qual_map.get(preset_key, 75)

        comp_bytes = 0
        for r, _, files in os.walk(out_dir):
            for fn in files:
                fp = os.path.join(r, fn)
                if fn.lower().endswith(".glb"):
                    comp_bytes += _downscale_glb_embedded_textures(fp, tex_limit=target_tex, jpeg_quality=target_qual)
                else:
                    comp_bytes += os.path.getsize(fp)

        orig_bytes = int(stats.get("original_bytes") or scan.get("size_bytes") or 1)
        saved_bytes = max(0, orig_bytes - comp_bytes)
        reduction_pct = round((saved_bytes / max(1, orig_bytes)) * 100.0, 1)
        duration_s = round(time.time() - t0, 2)

        if payload.get("apply_to_scan", True) and os.path.isdir(out_dir) and os.path.isdir(in_dir):
            try:
                self._create_pre_edit_backups(proj_dir, in_dir)
                self._replace_tileset_cleanly_and_refresh(
                    scan,
                    out_dir,
                    in_dir,
                    comp_bytes,
                    extra_updates={"texture_resolution": target_tex},
                )
            except Exception as e:
                print(f"[OptimizerBridge] Warning applying optimized tiles to scan {scan_id}: {e}")

        bk_state = self.get_backup_status(scan_id)
        return {
            "status": "ok",
            "action": "optimize",
            "scan_id": scan_id,
            "scan_name": scan.get("name"),
            "preset": preset_name,
            "texture_limit": target_tex,
            "crs": TWD97_TWVD2001_SHORT,
            "output_dir": out_dir,
            "tiles_processed": int(stats.get("tiles_processed", 0)),
            "original_mb": round(orig_bytes / (1024 * 1024), 2),
            "compressed_mb": round(comp_bytes / (1024 * 1024), 2),
            "saved_mb": round(saved_bytes / (1024 * 1024), 2),
            "reduction_pct": reduction_pct,
            "duration_s": duration_s,
            **bk_state,
        }

    def run_crop_action(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Invokes the Zero-Loss Binary GLB SpatialCutter on the PC.
        Supports:
          1. `frustum_strokes`: True 3D camera-frustum screen-space lasso strokes with view-depth occlusion protection
          2. `native_polygon`: Exact tileset-native XY polygon coordinates mapped directly from Studio's active tilesCenter
          3. `polygon`: Legacy TWD97 / local polygon fallback
        Automatically snapshots `<proj_dir>/tileset_backup` (original) and `<proj_dir>/tileset_prev` (1-step undo)
        before cleanly updating `tileset/`.
        """
        scan_id = (payload.get("scan_id") or "").strip()
        frustum_strokes = payload.get("frustum_strokes") if isinstance(payload.get("frustum_strokes"), list) else []
        raw_native_poly = payload.get("native_polygon") if isinstance(payload.get("native_polygon"), list) else []
        raw_polygon = payload.get("polygon") if isinstance(payload.get("polygon"), list) else []
        min_elev = safe_float(payload.get("min_elev"), -9999.0)
        if min_elev is None:
            min_elev = -9999.0
        max_elev = safe_float(payload.get("max_elev"), 9999.0)
        if max_elev is None:
            max_elev = 9999.0
        mode = str(payload.get("mode", "keep_inside")).lower().strip()
        if mode not in ("keep_inside", "delete_inside"):
            mode = "keep_inside"

        scan = self.db.get_scan(scan_id)
        if not scan:
            raise ValueError(f"Scan not found: {scan_id}")

        ts_path = scan.get("tileset_path") or ""
        if not ts_path or not os.path.exists(ts_path):
            raise FileNotFoundError(f"Tileset path not found on PC: {ts_path}")

        in_dir = os.path.dirname(ts_path) if os.path.isfile(ts_path) else ts_path
        proj_dir = scan.get("project_dir") or os.path.dirname(in_dir)

        ts_cx, ts_cy, ts_cz = 0.0, 0.0, 0.0
        if os.path.isfile(ts_path) and ts_path.lower().endswith(".json"):
            try:
                with open(ts_path, "r", encoding="utf-8") as f:
                    ts_data = json.load(f)
                box = ((ts_data.get("root") or {}).get("boundingVolume") or {}).get("box")
                if isinstance(box, list) and len(box) >= 3:
                    ts_cx = safe_float(box[0], 0.0) or 0.0
                    ts_cy = safe_float(box[1], 0.0) or 0.0
                    ts_cz = safe_float(box[2], 0.0) or 0.0
            except Exception:
                pass

        scan_e = safe_float(scan.get("twd97_e"), 0.0) or 0.0
        scan_n = safe_float(scan.get("twd97_n"), 0.0) or 0.0
        scan_h = safe_float(scan.get("twd97_h"), 0.0) or 0.0

        native_poly: List[List[float]] = []
        twd_poly: List[List[float]] = []

        parsed_native = _safe_parse_poly2d(raw_native_poly)
        parsed_poly = _safe_parse_poly2d(raw_polygon)
        if parsed_native is not None:
            native_poly = list(parsed_native)
            twd_poly = list(parsed_native)
        elif parsed_poly is not None:
            for pt in parsed_poly:
                px, py = pt[0], pt[1]
                if abs(px) > 10000.0 and abs(py) > 100000.0:
                    dx = px - scan_e
                    dn = py - scan_n
                    twd_poly.append([px, py])
                else:
                    dx = px
                    dn = py
                    twd_poly.append([scan_e + dx, scan_n + dn])
                native_poly.append([ts_cx + dx, ts_cy + dn])

        if not frustum_strokes and not native_poly:
            raise ValueError("Lasso / Polygon crop requires either frustum_strokes or a polygon with at least 3 vertices.")

        if payload.get("elev_is_native"):
            native_min_z = min_elev
            native_max_z = max_elev
        elif abs(ts_cz - scan_h) > 15.0 and min_elev > -1000.0 and max_elev < 1000.0:
            native_min_z = ts_cz + (min_elev - scan_h)
            native_max_z = ts_cz + (max_elev - scan_h)
        else:
            native_min_z = min_elev
            native_max_z = max_elev

        t0 = time.time()
        out_name = payload.get("output_name") or f"{scan_id}_crop_{int(t0 * 1000)}"
        out_dir = os.path.join(self.exports_dir, out_name)
        os.makedirs(out_dir, exist_ok=True)

        from cutter.spatial_cutter import SpatialCutter

        cutter = SpatialCutter(
            input_tileset_dir=in_dir,
            output_tileset_dir=out_dir,
            polygon_coords=native_poly if not frustum_strokes else None,
            min_elev=native_min_z,
            max_elev=native_max_z,
            up_axis="z",
            compress_output=True,
            mode=mode,
            frustum_strokes=frustum_strokes if frustum_strokes else None,
        )
        stats = cutter.run()

        area_m2 = 0.0
        n = len(twd_poly)
        if n >= 3:
            for i in range(n):
                x1, y1 = twd_poly[i][0], twd_poly[i][1]
                x2, y2 = twd_poly[(i + 1) % n][0], twd_poly[(i + 1) % n][1]
                area_m2 += x1 * y2 - x2 * y1
            area_m2 = round(abs(area_m2) * 0.5, 2)

        if payload.get("apply_to_scan", True) and os.path.isdir(out_dir) and os.path.isdir(in_dir):
            self._create_pre_edit_backups(proj_dir, in_dir)
            extra_upd: Dict[str, Any] = {}
            if mode == "keep_inside" and area_m2 > 0:
                extra_upd["covered_area_m2"] = area_m2
            self._replace_tileset_cleanly_and_refresh(
                scan,
                out_dir,
                in_dir,
                int(stats.get("output_size_bytes") or 0),
                extra_updates=extra_upd,
            )

        bk_state = self.get_backup_status(scan_id)
        return {
            "status": "ok",
            "action": "spatial_crop",
            "scan_id": scan_id,
            "scan_name": scan.get("name"),
            "mode": mode,
            "selection_type": "frustum_lasso" if frustum_strokes else "polygon",
            "vertex_count": sum(len(s.get("ndc_polygon") or []) for s in frustum_strokes) if frustum_strokes else len(native_poly),
            "cropped_area_m2": area_m2,
            "z_range_m": [round(min_elev, 2), round(max_elev, 2)],
            "tiles_sliced": int(stats.get("tiles_sliced", 0)),
            "tiles_retained": int(stats.get("tiles_fully_retained", 0)),
            "tiles_pruned": int(stats.get("tiles_pruned", 0)),
            "triangles_deleted": int(stats.get("triangles_deleted", 0)),
            "triangles_kept": int(stats.get("triangles_kept", 0)),
            "output_mb": round(float(stats.get("output_size_bytes", 0)) / (1024 * 1024), 2),
            "crs": TWD97_TWVD2001_SHORT,
            "output_dir": out_dir,
            "output_tileset_path": stats.get("output_tileset_path", os.path.join(out_dir, "tileset.json")),
            "duration_s": round(float(stats.get("duration_s") or (time.time() - t0)), 2),
            **bk_state,
        }

    def run_merge_scans_action(self, payload: Dict[str, Any], surveying_engine: Any = None) -> Dict[str, Any]:
        """
        Merges 2 to 8 aligned scans (each with user-adjusted 3D Gizmo translation and rotation
        and locked orientation) into a single unified georeferenced 3D Scan in C:\\GatheringScans.
        Produces:
          - Unified exports/obj_mesh/mesh.obj + mesh.mtl + 4K texture atlas mesh_0.jpg + offset.xyz
          - Unified tileset/tileset.json + tileset/tiles/root.glb + preview_tileset.json + thumbnail.png
          - Full SQLite scan record + scan_meta.json compatible with Optimizer, Spatial Crop, Volume,
            Contours, Cross-Section Profile, and CAD/PDF exports.
        """
        import re
        import math
        import shutil
        import subprocess
        import numpy as np
        from datetime import datetime
        from PIL import Image
        from pc_worker.config import LOCAL_SCANS_ROOT
        from pc_worker.gdrive_watcher import twd97_to_wgs84
        from pc_worker.preview_generator import (
            GLTFPACK_EXE,
            _downscale_glb_textures,
            replace_glb_single_image_bytes,
            shift_glb_node_translation,
            ensure_scan_low_quality_preview,
            ensure_scan_full_quality_thumbnail,
        )

        t0 = time.time()
        layers = payload.get("layers") or payload.get("scans") or []
        if not isinstance(layers, list) or len(layers) < 2:
            raise ValueError("Merging requires at least 2 scan layers in the alignment workspace.")

        unlocked = [str(ly.get("scan_id") or f"Layer #{idx+1}") for idx, ly in enumerate(layers) if not ly.get("locked", False)]
        if unlocked:
            raise ValueError(
                f"All scan orientations must be locked before merging. Unlocked: {', '.join(unlocked)}"
            )

        resolved_layers: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
        for ly in layers:
            sid = str(ly.get("scan_id") or "").strip()
            sc = self.db.get_scan(sid)
            if not sc:
                raise ValueError(f"Scan not found in catalog: {sid}")
            resolved_layers.append((ly, sc))

        primary_ly, primary_scan = resolved_layers[0]
        raw_name = str(payload.get("new_scan_name") or payload.get("name") or "").strip()
        if not raw_name:
            base_n = str(primary_scan.get("name") or primary_scan["scan_id"]).strip()
            raw_name = f"{base_n}_Unified_{len(resolved_layers)}Scans"

        proj_group = str(payload.get("project_group") or primary_scan.get("project_group") or "Unassigned Site").strip()
        proj_zh = str(payload.get("project_name_zh") or primary_scan.get("project_name_zh") or f"{proj_group} 工程掃描群組").strip()

        clean_slug = re.sub(r"[^a-z0-9_]+", "_", raw_name.lower()).strip("_")[:48]
        if not clean_slug:
            clean_slug = f"unified_{int(t0)}"
        new_scan_id = f"merged_{clean_slug}_{int(t0) % 100000}"
        out_proj_dir = os.path.join(LOCAL_SCANS_ROOT, new_scan_id)
        work_proj_dir = os.path.join(LOCAL_SCANS_ROOT, f"_merging_{new_scan_id}")
        if os.path.isdir(work_proj_dir):
            shutil.rmtree(work_proj_dir, ignore_errors=True)
        obj_work_dir = os.path.join(work_proj_dir, "exports", "obj_mesh")
        tiles_work_dir = os.path.join(work_proj_dir, "tileset", "tiles")
        os.makedirs(obj_work_dir, exist_ok=True)
        os.makedirs(tiles_work_dir, exist_ok=True)

        raw_deletions = payload.get("deletions") if isinstance(payload.get("deletions"), list) else []
        raw_preset = str(payload.get("compression_preset") or payload.get("preset") or "").strip().lower()
        comp_mult_map = {"quality": 0.75, "balanced": 0.50, "web": 0.35, "ultra_light": 0.20, "ultra": 0.20}
        tex_res_map = {"quality": 2048, "balanced": 1536, "web": 1024, "ultra_light": 768, "ultra": 768}
        jpeg_q_map = {"quality": 85, "balanced": 78, "web": 70, "ultra_light": 60, "ultra": 60}
        has_comp = raw_preset in comp_mult_map
        target_tex_res = tex_res_map.get(raw_preset, PIX4DMATIC_TEXTURE_SIZE)
        target_jpeg_q = jpeg_q_map.get(raw_preset, 88)

        crs_cfg = payload.get("crs_config") if isinstance(payload.get("crs_config"), dict) else {}
        target_crs_code = str(crs_cfg.get("target_crs") or "").strip().upper()
        crs_off_x = safe_float(crs_cfg.get("offset_x"), 0.0) or 0.0
        crs_off_y = safe_float(crs_cfg.get("offset_y"), 0.0) or 0.0
        crs_off_z = safe_float(crs_cfg.get("offset_z"), 0.0) or 0.0
        geoid_override_raw = crs_cfg.get("geoid_offset_override") if crs_cfg.get("geoid_offset_override") is not None else crs_cfg.get("h_offset_from_twvd")
        geoid_override_val = safe_float(geoid_override_raw)
        has_crs = bool(
            (target_crs_code and target_crs_code in CRS_DEFINITIONS)
            or abs(crs_off_x) > 1e-6
            or abs(crs_off_y) > 1e-6
            or abs(crs_off_z) > 1e-6
            or geoid_override_val is not None
        )

        # Reference Z-up center (TWD97 Easting, Northing, TWVD2001 Elevation)
        ref_c = payload.get("ref_center_zup")
        if isinstance(ref_c, (list, tuple)) and len(ref_c) >= 3:
            r0 = safe_float(ref_c[0])
            r1 = safe_float(ref_c[1])
            r2 = safe_float(ref_c[2])
            if r0 is not None and r1 is not None and r2 is not None:
                c_ref = np.array([r0, r1, r2], dtype=np.float64)
            else:
                c_ref = np.array(
                    [
                        safe_float(primary_scan.get("twd97_e"), 0.0) or 0.0,
                        safe_float(primary_scan.get("twd97_n"), 0.0) or 0.0,
                        safe_float(primary_scan.get("twd97_h"), 0.0) or 0.0,
                    ],
                    dtype=np.float64,
                )
        else:
            c_ref = np.array(
                [
                    safe_float(primary_scan.get("twd97_e"), 0.0) or 0.0,
                    safe_float(primary_scan.get("twd97_n"), 0.0) or 0.0,
                    safe_float(primary_scan.get("twd97_h"), 0.0) or 0.0,
                ],
                dtype=np.float64,
            )

        merged_offset = np.round(c_ref, 0)
        ox_m, oy_m, oz_m = float(merged_offset[0]), float(merged_offset[1]), float(merged_offset[2])

        # Change-of-basis matrices between Three.js Y-up (X=East, Y=Up, Z=South) and TWD97 Z-up (X=East, Y=North, Z=Up)
        # zUpGroup in Three.js rotates -90 deg on X: (x_zup, y_zup, z_zup) -> (x_zup, z_zup, -y_zup)
        r_x_neg90 = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]], dtype=np.float64)
        r_x_pos90 = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]], dtype=np.float64)

        def _quat_to_mat3(qx: float, qy: float, qz: float, qw: float) -> np.ndarray:
            n = math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
            if n < 1e-12:
                return np.eye(3, dtype=np.float64)
            qx, qy, qz, qw = qx / n, qy / n, qz / n, qw / n
            xx, yy, zz = qx * qx, qy * qy, qz * qz
            xy, xz, yz = qx * qy, qx * qz, qy * qz
            wx, wy, wz = qw * qx, qw * qy, qw * qz
            return np.array(
                [
                    [1.0 - 2.0 * (yy + zz), 2.0 * (xy - wz), 2.0 * (xz + wy)],
                    [2.0 * (xy + wz), 1.0 - 2.0 * (xx + zz), 2.0 * (yz - wx)],
                    [2.0 * (xz - wy), 2.0 * (yz + wx), 1.0 - 2.0 * (xx + yy)],
                ],
                dtype=np.float64,
            )

        try:
            import hashlib

            num_scans = len(resolved_layers)
            if has_comp:
                target_tex_res = tex_res_map.get(raw_preset, 1536)
            else:
                target_tex_res = PIX4DMATIC_TEXTURE_SIZE

            total_images = 0
            total_deleted_faces = 0
            merged_from_meta: List[Dict[str, Any]] = []
            layer_transforms_by_sid: Dict[str, Dict[str, Any]] = {}
            applied_steps: List[str] = [f"Aligned & merged {num_scans} scans (4K multi-tile)"]
            merged_parts: List[Dict[str, Any]] = []

            def _parse_face_lines_to_nx6(flist: List[str]) -> np.ndarray:
                sample_tok = flist[0].strip().split()[0]
                scnt = sample_tok.count("/")
                if scnt == 1:
                    return np.fromstring(" ".join(flist).replace("/", " "), sep=" ", dtype=np.int64).reshape(-1, 6)
                if scnt >= 2:
                    rf = np.fromstring(" ".join(flist).replace("//", "/0/").replace("/", " "), sep=" ", dtype=np.int64).reshape(-1, 9)
                    return rf[:, [0, 1, 3, 4, 6, 7]]
                rf = np.fromstring(" ".join(flist), sep=" ", dtype=np.int64).reshape(-1, 3)
                return np.column_stack([rf[:, 0], rf[:, 0], rf[:, 1], rf[:, 1], rf[:, 2], rf[:, 2]])

            for idx, (ly, sc) in enumerate(resolved_layers):
                sid = sc["scan_id"]
                total_images += int(sc.get("image_count") or 0)

                # Locate .obj path (or convert primary / leaf .glb tiles if needed)
                obj_p = surveying_engine._resolve_scan_obj_path(sc) if surveying_engine else sc.get("obj_path")
                if not (obj_p and os.path.isfile(obj_p)):
                    cand_obj = os.path.join(sc.get("project_dir") or "", "exports", "obj_mesh", "mesh.obj")
                    if os.path.isfile(cand_obj):
                        obj_p = cand_obj

                scan_raw_parts: List[Dict[str, Any]] = []
                obj_offset_xyz: Optional[np.ndarray] = None

                ts_p_check = sc.get("tileset_path") or ""
                raw_cz = ly.get("raw_center_zup")
                rc_vec_check = (
                    np.array([float(raw_cz[0]), float(raw_cz[1]), float(raw_cz[2])], dtype=np.float64)
                    if (isinstance(raw_cz, list) and len(raw_cz) >= 3)
                    else None
                )
                # Prefer tileset .glb ONLY when an in-place edit backup (`tileset_backup`) exists and tileset is newer than obj_p
                has_inplace_bk = os.path.isdir(os.path.join(sc.get("project_dir") or "", "tileset_backup"))
                if has_inplace_bk and obj_p and os.path.isfile(obj_p) and ts_p_check and os.path.isfile(ts_p_check):
                    tiles_check_dir = os.path.join(os.path.dirname(ts_p_check), "tiles")
                    newest_glb_mt = os.path.getmtime(ts_p_check)
                    if os.path.isdir(tiles_check_dir):
                        for fn_chk in os.listdir(tiles_check_dir):
                            if fn_chk.lower().endswith(".glb"):
                                newest_glb_mt = max(newest_glb_mt, os.path.getmtime(os.path.join(tiles_check_dir, fn_chk)))
                    if newest_glb_mt > os.path.getmtime(obj_p) + 60.0:
                        obj_p = ""

                if obj_p and os.path.isfile(obj_p):
                    obj_dir = os.path.dirname(obj_p)
                    off_cand = os.path.join(obj_dir, "offset.xyz")
                    if os.path.isfile(off_cand):
                        try:
                            with open(off_cand, "r", encoding="utf-8") as f_off:
                                parts_off = f_off.read().strip().split()
                            if len(parts_off) >= 3:
                                obj_offset_xyz = np.array(
                                    [float(parts_off[0]), float(parts_off[1]), float(parts_off[2])],
                                    dtype=np.float64,
                                )
                        except Exception:
                            pass

                    with open(obj_p, "r", encoding="utf-8", errors="ignore") as f_in:
                        lines = f_in.read().splitlines()

                    v_lines: List[str] = []
                    vt_lines: List[str] = []
                    f_groups: Dict[str, List[str]] = {}
                    cur_mtl = "__default__"
                    mtl_filename = "mesh.mtl"
                    for ln in lines:
                        if ln.startswith("v "):
                            v_lines.append(ln[2:])
                        elif ln.startswith("vt "):
                            vt_lines.append(ln[3:])
                        elif ln.startswith("f "):
                            f_groups.setdefault(cur_mtl, []).append(ln[2:])
                        elif ln.startswith("usemtl "):
                            cur_mtl = ln[7:].strip() or "__default__"
                        elif ln.startswith("mtllib "):
                            mtl_filename = ln[7:].strip() or "mesh.mtl"

                    if v_lines and f_groups:
                        v_arr_obj = np.fromstring(" ".join(v_lines), sep=" ", dtype=np.float64).reshape(-1, 3)
                        # Reject obj_p if its world coords (e.g. local 0,0,0 or UTM 51N 351xxx) disagree with scan's TWD97 center!
                        if rc_vec_check is not None and float(np.max(np.abs(rc_vec_check))) >= 50000.0:
                            eff_v_mid = ((v_arr_obj.min(axis=0) + v_arr_obj.max(axis=0)) * 0.5) + (
                                obj_offset_xyz if obj_offset_xyz is not None else np.zeros(3, dtype=np.float64)
                            )
                            if float(np.linalg.norm(eff_v_mid[:2] - rc_vec_check[:2])) > 2000.0:
                                v_arr_obj = None
                                obj_offset_xyz = None

                        if v_arr_obj is not None:
                            vt_arr_obj = (
                                np.fromstring(" ".join(vt_lines), sep=" ", dtype=np.float64).reshape(-1, 2)
                                if vt_lines
                                else np.zeros((len(v_arr_obj), 2), dtype=np.float64)
                            )
                            mtl_tex_map: Dict[str, str] = {}
                            mtl_p = os.path.join(obj_dir, mtl_filename)
                            if os.path.isfile(mtl_p):
                                try:
                                    active_m = ""
                                    with open(mtl_p, "r", encoding="utf-8", errors="ignore") as mf_in:
                                        for mln in mf_in:
                                            ms = mln.strip()
                                            if ms.startswith("newmtl "):
                                                active_m = ms[7:].strip()
                                            elif ms.lower().startswith("map_kd ") and active_m:
                                                mtl_tex_map[active_m] = ms[7:].strip()
                                except Exception:
                                    pass

                            def _load_obj_tex_pair(m_key: str) -> Tuple[Optional[bytes], Optional[Image.Image]]:
                                cand_paths: List[str] = []
                                if m_key in mtl_tex_map:
                                    cand_paths.append(os.path.join(obj_dir, mtl_tex_map[m_key]))
                                for jc in ("mesh_0.jpg", "texture.jpg", "mesh.jpg", "mesh_0.png"):
                                    cand_paths.append(os.path.join(obj_dir, jc))
                                for cp in cand_paths:
                                    if os.path.isfile(cp):
                                        try:
                                            with open(cp, "rb") as tf_b:
                                                rb = tf_b.read()
                                            if rb[:2] == b"\xff\xd8":
                                                return rb, None
                                            return None, Image.open(io.BytesIO(rb)).convert("RGB")
                                        except Exception:
                                            pass
                                import glob as _glob
                                jpgs = _glob.glob(os.path.join(obj_dir, "*.jpg")) + _glob.glob(os.path.join(obj_dir, "*.png"))
                                if jpgs:
                                    try:
                                        with open(jpgs[0], "rb") as tf_b:
                                            rb = tf_b.read()
                                        if rb[:2] == b"\xff\xd8":
                                            return rb, None
                                        return None, Image.open(io.BytesIO(rb)).convert("RGB")
                                    except Exception:
                                        pass
                                return None, None

                            for m_key, flist in f_groups.items():
                                if not flist:
                                    continue
                                f_grp = _parse_face_lines_to_nx6(flist)
                                raw_jb, pil_im = _load_obj_tex_pair(m_key)
                                scan_raw_parts.append(
                                    {
                                        "v": v_arr_obj,
                                        "vt": vt_arr_obj,
                                        "f": f_grp,
                                        "raw_jpeg": raw_jb,
                                        "pil_img": pil_im,
                                        "obj_offset": obj_offset_xyz,
                                    }
                                )

                if not scan_raw_parts:
                    # Fallback: load from root.glb OR leaf .glb tiles via trimesh (+ gltfpack -noq for meshopt), accumulating 4x4 tile transforms
                    import subprocess as _sp
                    import trimesh
                    from pc_worker.surveying_engine import GLTFPACK_EXE

                    ts_p = sc.get("tileset_path") or ""
                    ts_base_dir = os.path.dirname(ts_p) if ts_p else ""
                    r_glb = os.path.join(ts_base_dir, "tiles", "root.glb") if ts_base_dir else ""
                    glb_entries: List[Tuple[str, np.ndarray]] = []
                    has_root_tf = False
                    gltf_up_axis = ""
                    if ts_p and os.path.isfile(ts_p) and ts_p.lower().endswith(".json"):
                        try:
                            with open(ts_p, "r", encoding="utf-8") as f_tsj:
                                tsj = json.load(f_tsj)
                            gltf_up_axis = str((tsj.get("asset") or {}).get("gltfUpAxis") or "").upper().strip()
                            has_root_tf = bool((tsj.get("root") or {}).get("transform"))

                            def _collect_leaf_glbs(node: Dict[str, Any], parent_tf: np.ndarray, out_list: List[Tuple[str, np.ndarray]]):
                                cur_tf = parent_tf
                                ntf = node.get("transform")
                                if isinstance(ntf, list) and len(ntf) == 16:
                                    cur_tf = parent_tf @ np.array(ntf, dtype=np.float64).reshape((4, 4), order="F")
                                children = node.get("children") or []
                                valid_child = False
                                for ch in children:
                                    if isinstance(ch, dict):
                                        valid_child = True
                                        _collect_leaf_glbs(ch, cur_tf, out_list)
                                if not valid_child:
                                    c_uri = ((node.get("content") or {}).get("uri") or (node.get("content") or {}).get("url") or "")
                                    if c_uri and "{level}" not in c_uri:
                                        cand_p = os.path.normpath(os.path.join(ts_base_dir, c_uri.split("?")[0]))
                                        if os.path.isfile(cand_p):
                                            out_list.append((cand_p, cur_tf))

                            root_has_children = bool([c for c in ((tsj.get("root") or {}).get("children") or []) if isinstance(c, dict)])
                            if isinstance(tsj.get("root"), dict) and root_has_children:
                                _collect_leaf_glbs(tsj["root"], np.eye(4, dtype=np.float64), glb_entries)
                            if not glb_entries and r_glb and os.path.isfile(r_glb):
                                rtf_raw = (tsj.get("root") or {}).get("transform")
                                rtf = (
                                    np.array(rtf_raw, dtype=np.float64).reshape((4, 4), order="F")
                                    if (isinstance(rtf_raw, list) and len(rtf_raw) == 16)
                                    else np.eye(4, dtype=np.float64)
                                )
                                glb_entries = [(r_glb, rtf)]
                            elif not glb_entries and isinstance(tsj.get("root"), dict):
                                _collect_leaf_glbs(tsj["root"], np.eye(4, dtype=np.float64), glb_entries)
                                if not glb_entries:
                                    prev_ts = os.path.join(ts_base_dir, "preview_tileset.json")
                                    if os.path.isfile(prev_ts):
                                        with open(prev_ts, "r", encoding="utf-8") as fp_ts:
                                            ptsj = json.load(fp_ts)
                                        if isinstance(ptsj.get("root"), dict):
                                            _collect_leaf_glbs(ptsj["root"], np.eye(4, dtype=np.float64), glb_entries)
                                    if not glb_entries:
                                        rtf_raw = (tsj.get("root") or {}).get("transform")
                                        rtf = (
                                            np.array(rtf_raw, dtype=np.float64).reshape((4, 4), order="F")
                                            if (isinstance(rtf_raw, list) and len(rtf_raw) == 16)
                                            else np.eye(4, dtype=np.float64)
                                        )
                                        c_dir = os.path.join(ts_base_dir, "content")
                                        if os.path.isdir(c_dir):
                                            for fn_g in sorted(os.listdir(c_dir)):
                                                if fn_g.lower().endswith(".glb"):
                                                    glb_entries.append((os.path.join(c_dir, fn_g), rtf))
                        except Exception:
                            pass
                    elif r_glb and os.path.isfile(r_glb):
                        glb_entries = [(r_glb, np.eye(4, dtype=np.float64))]

                    if not glb_entries:
                        raise FileNotFoundError(f"Could not resolve 3D mesh (.obj or .glb tiles) for scan: {sid}")

                    apply_y_to_z = (gltf_up_axis == "Y") or (gltf_up_axis == "" and has_root_tf)
                    from optimizer.geometry_optimizer import extract_glb_64bit_origin_to_local, parse_glb_chunks

                    tile_chunks: List[Tuple[np.ndarray, np.ndarray, np.ndarray, Optional[bytes], Optional[Image.Image], str]] = []
                    for g_idx, (gp, tile_tf) in enumerate(glb_entries):
                        tmp_loc = None
                        tmp_dec = None
                        scene_or_mesh = None
                        origin_64 = (0.0, 0.0, 0.0)
                        khr_tf_by_mat: List[Optional[Dict[str, Any]]] = []
                        raw_jpeg_by_mat: List[Optional[bytes]] = []
                        try:
                            with open(gp, "rb") as f_gp:
                                raw_gp_bytes = f_gp.read()
                            # Strip 64-bit TWD97/ECEF translation BEFORE gltfpack -noq so float32 never truncates to 25cm steps!
                            loc_gp_bytes, origin_64 = extract_glb_64bit_origin_to_local(raw_gp_bytes)

                            # Extract untouched embedded JPEG streams directly from binary GLB bufferViews BEFORE trimesh/PIL!
                            try:
                                j_loc, bin_loc = parse_glb_chunks(loc_gp_bytes)
                                loc_texs = j_loc.get("textures") or []
                                loc_imgs = j_loc.get("images") or []
                                loc_bvs = j_loc.get("bufferViews") or []
                                for m_def in j_loc.get("materials") or []:
                                    raw_ib: Optional[bytes] = None
                                    bct_l = (m_def.get("pbrMetallicRoughness") or {}).get("baseColorTexture") or {}
                                    t_idx_l = bct_l.get("index")
                                    if t_idx_l is not None and 0 <= int(t_idx_l) < len(loc_texs):
                                        t_obj_l = loc_texs[int(t_idx_l)]
                                        s_idx_l = t_obj_l.get("source")
                                        if s_idx_l is None:
                                            s_idx_l = ((t_obj_l.get("extensions") or {}).get("EXT_texture_webp") or {}).get("source")
                                        if s_idx_l is not None and 0 <= int(s_idx_l) < len(loc_imgs):
                                            im_obj_l = loc_imgs[int(s_idx_l)]
                                            bv_i_l = im_obj_l.get("bufferView")
                                            if bv_i_l is not None and 0 <= int(bv_i_l) < len(loc_bvs):
                                                bv_o_l = loc_bvs[int(bv_i_l)]
                                                bo_l = int(bv_o_l.get("byteOffset") or 0)
                                                bl_l = int(bv_o_l.get("byteLength") or 0)
                                                if bl_l > 0 and bo_l + bl_l <= len(bin_loc):
                                                    cand_b = bytes(bin_loc[bo_l : bo_l + bl_l])
                                                    if cand_b[:2] == b"\xff\xd8":
                                                        raw_ib = cand_b
                                    raw_jpeg_by_mat.append(raw_ib)
                                if not any(raw_jpeg_by_mat) and len(loc_imgs) == 1:
                                    bv_i0 = loc_imgs[0].get("bufferView")
                                    if bv_i0 is not None and 0 <= int(bv_i0) < len(loc_bvs):
                                        bv_o0 = loc_bvs[int(bv_i0)]
                                        bo0 = int(bv_o0.get("byteOffset") or 0)
                                        bl0 = int(bv_o0.get("byteLength") or 0)
                                        if bl0 > 0 and bo0 + bl0 <= len(bin_loc):
                                            cand_b0 = bytes(bin_loc[bo0 : bo0 + bl0])
                                            if cand_b0[:2] == b"\xff\xd8":
                                                raw_jpeg_by_mat = [cand_b0]
                            except Exception:
                                raw_jpeg_by_mat = []

                            tmp_loc = os.path.join(work_proj_dir, f"_loc_{idx}_{g_idx}.glb")
                            with open(tmp_loc, "wb") as f_loc:
                                f_loc.write(loc_gp_bytes)

                            active_glb_bytes = loc_gp_bytes
                            try:
                                scene_or_mesh = trimesh.load(tmp_loc, process=False)
                                has_verts = (
                                    (isinstance(scene_or_mesh, trimesh.Trimesh) and len(scene_or_mesh.vertices) > 0)
                                    or (
                                        isinstance(scene_or_mesh, trimesh.Scene)
                                        and any(len(g.vertices) > 0 for g in scene_or_mesh.geometry.values() if hasattr(g, "vertices"))
                                    )
                                )
                                if not has_verts:
                                    raise ValueError("Empty or meshopt-compressed GLB")
                            except Exception:
                                if os.path.isfile(GLTFPACK_EXE):
                                    tmp_dec = os.path.join(work_proj_dir, f"_dec_{idx}_{g_idx}.glb")
                                    _sp.run(
                                        [GLTFPACK_EXE, "-i", tmp_loc, "-o", tmp_dec, "-noq"],
                                        capture_output=True,
                                        timeout=45,
                                        creationflags=getattr(_sp, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0,
                                    )
                                    if os.path.isfile(tmp_dec):
                                        with open(tmp_dec, "rb") as f_dec_b:
                                            active_glb_bytes = f_dec_b.read()
                                        scene_or_mesh = trimesh.load(tmp_dec, process=False)

                            try:
                                j_hdr, _ = parse_glb_chunks(active_glb_bytes)
                                for m_def in j_hdr.get("materials") or []:
                                    bct = (m_def.get("pbrMetallicRoughness") or {}).get("baseColorTexture") or {}
                                    khr_tf_by_mat.append((bct.get("extensions") or {}).get("KHR_texture_transform"))
                            except Exception:
                                khr_tf_by_mat = []
                        finally:
                            for p_rm in (tmp_loc, tmp_dec):
                                if p_rm and os.path.isfile(p_rm):
                                    try:
                                        os.remove(p_rm)
                                    except OSError:
                                        pass
                        if scene_or_mesh is None:
                            continue

                        geom_items: List[Tuple[Any, np.ndarray, int]] = []
                        if isinstance(scene_or_mesh, trimesh.Scene):
                            for m_ord, (g_name, geom) in enumerate(scene_or_mesh.geometry.items()):
                                if not isinstance(geom, trimesh.Trimesh) or len(geom.vertices) == 0 or len(geom.faces) == 0:
                                    continue
                                xf = np.eye(4, dtype=np.float64)
                                try:
                                    nodes_for_g = scene_or_mesh.graph.geometry_nodes.get(g_name, [])
                                    if nodes_for_g:
                                        xf, _ = scene_or_mesh.graph.get(nodes_for_g[0])
                                except Exception:
                                    pass
                                geom_items.append((geom, xf, m_ord))
                        elif isinstance(scene_or_mesh, trimesh.Trimesh) and len(scene_or_mesh.vertices) > 0 and len(scene_or_mesh.faces) > 0:
                            geom_items.append((scene_or_mesh, np.eye(4, dtype=np.float64), 0))

                        origin_vec64 = np.array(origin_64, dtype=np.float64)
                        for geom, xf, m_ord in geom_items:
                            gv = (np.asarray(geom.vertices, dtype=np.float64) @ xf[:3, :3].T + xf[:3, 3]) + origin_vec64
                            if apply_y_to_z:
                                gv = np.column_stack([gv[:, 0], -gv[:, 2], gv[:, 1]])
                            gv = gv @ tile_tf[:3, :3].T + tile_tf[:3, 3]
                            gf = np.asarray(geom.faces, dtype=np.int64)
                            guv = (
                                np.asarray(geom.visual.uv, dtype=np.float64).copy()
                                if (hasattr(geom.visual, "uv") and geom.visual.uv is not None and len(geom.visual.uv) == len(gv))
                                else np.zeros((len(gv), 2), dtype=np.float64)
                            )
                            # Apply glTF KHR_texture_transform (offset/scale/rotation in top-left UV frame) ignored by trimesh
                            khr_tf = (
                                khr_tf_by_mat[m_ord]
                                if m_ord < len(khr_tf_by_mat)
                                else (khr_tf_by_mat[0] if khr_tf_by_mat else None)
                            )
                            if isinstance(khr_tf, dict) and len(guv) > 0:
                                off_uv = khr_tf.get("offset") or [0.0, 0.0]
                                scl_uv = khr_tf.get("scale") or [1.0, 1.0]
                                rot_uv = float(khr_tf.get("rotation") or 0.0)
                                ug = guv[:, 0] * float(scl_uv[0])
                                vg = (1.0 - guv[:, 1]) * float(scl_uv[1])
                                if abs(rot_uv) > 1e-9:
                                    c_r, s_r = math.cos(rot_uv), math.sin(rot_uv)
                                    ug, vg = ug * c_r + vg * s_r, -ug * s_r + vg * c_r
                                ug += float(off_uv[0])
                                vg += float(off_uv[1])
                                guv[:, 0] = ug
                                guv[:, 1] = 1.0 - vg

                            raw_jb_chunk = (
                                raw_jpeg_by_mat[m_ord]
                                if m_ord < len(raw_jpeg_by_mat)
                                else (raw_jpeg_by_mat[0] if raw_jpeg_by_mat else None)
                            )
                            g_img = None
                            if raw_jb_chunk is None and hasattr(geom.visual, "material") and geom.visual.material is not None:
                                mat_obj = geom.visual.material
                                raw_tex = getattr(mat_obj, "baseColorTexture", None)
                                if raw_tex is None:
                                    raw_tex = getattr(mat_obj, "image", None)
                                if raw_tex is not None:
                                    try:
                                        g_img = raw_tex.convert("RGB")
                                    except Exception:
                                        g_img = None

                            if raw_jb_chunk is not None:
                                tex_key = hashlib.sha256(raw_jb_chunk).hexdigest()
                            elif g_img is not None:
                                tex_key = f"pil_{g_img.size[0]}x{g_img.size[1]}_{hashlib.sha256(g_img.tobytes()[:65536]).hexdigest()[:16]}"
                            else:
                                tex_key = "notex"
                            tile_chunks.append((gv, guv, gf, raw_jb_chunk, g_img, tex_key))

                    if not tile_chunks:
                        raise ValueError(f"Empty 3D mesh loaded for scan: {sid}")

                    # Group chunks by exact texture SHA256 so shared-atlas tiles stay unified and distinct 4K scan tiles stay separate!
                    grouped_by_tex: Dict[str, List[Tuple[np.ndarray, np.ndarray, np.ndarray, Optional[bytes], Optional[Image.Image]]]] = {}
                    for gv, guv, gf, rjb, gim, tkey in tile_chunks:
                        grouped_by_tex.setdefault(tkey, []).append((gv, guv, gf, rjb, gim))

                    def _weld_and_append_group(
                        grp_items: List[Tuple[np.ndarray, np.ndarray, np.ndarray, Optional[bytes], Optional[Image.Image]]],
                        grp_raw_jpeg: Optional[bytes],
                        grp_pil_img: Optional[Image.Image],
                    ) -> None:
                        sub_vs, sub_vts, sub_fs = [], [], []
                        sub_v_off = 0
                        for gv_i, guv_i, gf_i, _, _ in grp_items:
                            gf1 = gf_i + 1 + sub_v_off
                            sub_vs.append(gv_i)
                            sub_vts.append(guv_i)
                            sub_fs.append(np.column_stack([gf1[:, 0], gf1[:, 0], gf1[:, 1], gf1[:, 1], gf1[:, 2], gf1[:, 2]]))
                            sub_v_off += len(gv_i)
                        v_raw_g = np.vstack(sub_vs)
                        vt_g = np.vstack(sub_vts)
                        f_g = np.vstack(sub_fs)
                        v_quant_g = np.round(v_raw_g * 2000.0).astype(np.int64)
                        _, unique_v_first, inverse_v_map = np.unique(
                            v_quant_g, axis=0, return_index=True, return_inverse=True
                        )
                        v_welded = v_raw_g[unique_v_first]
                        f_g[:, 0] = inverse_v_map[f_g[:, 0] - 1] + 1
                        f_g[:, 2] = inverse_v_map[f_g[:, 2] - 1] + 1
                        f_g[:, 4] = inverse_v_map[f_g[:, 4] - 1] + 1
                        scan_raw_parts.append(
                            {
                                "v": v_welded,
                                "vt": vt_g,
                                "f": f_g,
                                "raw_jpeg": grp_raw_jpeg,
                                "pil_img": grp_pil_img,
                                "obj_offset": None,
                            }
                        )

                    def _maybe_upgrade_to_gen0_jpeg(leaf_jb: Optional[bytes]) -> Optional[bytes]:
                        if not leaf_jb or leaf_jb[:2] != b"\xff\xd8":
                            return leaf_jb
                        try:
                            im_leaf = Image.open(io.BytesIO(leaf_jb)).convert("RGB")
                            thumb_leaf = np.asarray(
                                im_leaf.resize((128, 128), Image.Resampling.BILINEAR), dtype=np.float32
                            )
                        except Exception:
                            return leaf_jb

                        cand_jpegs: List[bytes] = []
                        if r_glb and os.path.isfile(r_glb):
                            try:
                                jr, br = parse_glb_chunks(open(r_glb, "rb").read())
                                for im_d in jr.get("images") or []:
                                    bv_i = im_d.get("bufferView")
                                    bvs_r = jr.get("bufferViews") or []
                                    if bv_i is not None and 0 <= int(bv_i) < len(bvs_r):
                                        bv_r = bvs_r[int(bv_i)]
                                        bo_r = int(bv_r.get("byteOffset") or 0)
                                        bl_r = int(bv_r.get("byteLength") or 0)
                                        cb = bytes(br[bo_r : bo_r + bl_r])
                                        if cb[:2] == b"\xff\xd8" and len(cb) > len(leaf_jb):
                                            cand_jpegs.append(cb)
                            except Exception:
                                pass

                        cand_scans: List[Dict[str, Any]] = []
                        deriv_id = str(sc.get("derived_from_scan_id") or "").strip()
                        if deriv_id:
                            d_sc = db.get_scan(deriv_id)
                            if d_sc:
                                cand_scans.append(d_sc)
                        pg_cur = str(sc.get("project_group") or "").strip().lower()
                        for sib in db.list_scans():
                            if sib.get("scan_id") == sid:
                                continue
                            if pg_cur and str(sib.get("project_group") or "").strip().lower() == pg_cur:
                                cand_scans.append(sib)
                        for c_sc in cand_scans:
                            c_pdir = str(c_sc.get("project_dir") or "")
                            c_obj_dir = os.path.join(c_pdir, "exports", "obj_mesh")
                            if os.path.isdir(c_obj_dir):
                                for fn_j in sorted(os.listdir(c_obj_dir)):
                                    if fn_j.lower().endswith((".jpg", ".jpeg")):
                                        jp_full = os.path.join(c_obj_dir, fn_j)
                                        try:
                                            if os.path.getsize(jp_full) > len(leaf_jb):
                                                with open(jp_full, "rb") as fj_c:
                                                    cand_jpegs.append(fj_c.read())
                                        except Exception:
                                            pass

                        best_jb = leaf_jb
                        for cb in cand_jpegs:
                            if len(cb) <= len(best_jb) or cb[:2] != b"\xff\xd8":
                                continue
                            try:
                                im_c = Image.open(io.BytesIO(cb)).convert("RGB")
                                if im_c.size != im_leaf.size:
                                    continue
                                thumb_c = np.asarray(
                                    im_c.resize((128, 128), Image.Resampling.BILINEAR), dtype=np.float32
                                )
                                if float(np.mean(np.abs(thumb_c - thumb_leaf))) < 3.0:
                                    best_jb = cb
                            except Exception:
                                continue
                        return best_jb

                    if len(grouped_by_tex) <= 8:
                        for _, grp_items in grouped_by_tex.items():
                            upgraded_jb = _maybe_upgrade_to_gen0_jpeg(grp_items[0][3])
                            _weld_and_append_group(grp_items, upgraded_jb, grp_items[0][4])
                    else:
                        # Rare fallback (>8 tiny per-octant unique textures without .obj): pack into 4096px atlas
                        sub_g = max(1, min(16, int(math.ceil(math.sqrt(len(tile_chunks))))))
                        sub_px = max(32, 4096 // sub_g)
                        atlas_fb = Image.new("RGB", (sub_g * sub_px, sub_g * sub_px), (200, 200, 200))
                        packed_items: List[Tuple[np.ndarray, np.ndarray, np.ndarray, Optional[bytes], Optional[Image.Image]]] = []
                        for c_i, (gv, guv, gf, rjb, gim, _) in enumerate(tile_chunks):
                            slot = c_i % (sub_g * sub_g)
                            scol = slot % sub_g
                            srow_uv = slot // sub_g
                            srow_pil = sub_g - 1 - srow_uv
                            im_use = gim
                            if im_use is None and rjb is not None:
                                try:
                                    im_use = Image.open(io.BytesIO(rjb)).convert("RGB")
                                except Exception:
                                    im_use = None
                            if im_use is not None:
                                atlas_fb.paste(im_use.resize((sub_px, sub_px), Image.Resampling.LANCZOS), (scol * sub_px, srow_pil * sub_px))
                            u_w = np.mod(guv[:, 0], 1.0)
                            v_w = np.mod(guv[:, 1], 1.0)
                            u_clamped = np.clip(u_w, 0.002, 0.998)
                            v_clamped = np.clip(v_w, 0.002, 0.998)
                            mapped_uv = np.column_stack([(scol + u_clamped) / sub_g, (srow_uv + v_clamped) / sub_g])
                            packed_items.append((gv, mapped_uv, gf, None, None))
                        _weld_and_append_group(packed_items, None, atlas_fb)

                # Extract Three.js translation & rotation (quaternion or Euler XYZ in degrees) from alignment layer
                pos_three = ly.get("position_three")
                if isinstance(pos_three, list) and len(pos_three) >= 3:
                    tx, ty, tz = float(pos_three[0]), float(pos_three[1]), float(pos_three[2])
                else:
                    tx = float(ly.get("tx") or 0.0)
                    ty = float(ly.get("ty") or 0.0)
                    tz = float(ly.get("tz") or 0.0)

                rx_deg = float(ly.get("rx_deg") or (ly.get("euler_deg_three") or [0.0, 0.0, 0.0])[0] or 0.0)
                ry_deg = float(ly.get("ry_deg") or (ly.get("euler_deg_three") or [0.0, 0.0, 0.0])[1] or 0.0)
                rz_deg = float(ly.get("rz_deg") or (ly.get("euler_deg_three") or [0.0, 0.0, 0.0])[2] or 0.0)

                quat_three = ly.get("quaternion_three")
                if isinstance(quat_three, list) and len(quat_three) >= 4:
                    r_three = _quat_to_mat3(
                        float(quat_three[0]),
                        float(quat_three[1]),
                        float(quat_three[2]),
                        float(quat_three[3]),
                    )
                else:
                    rx_r = math.radians(rx_deg)
                    ry_r = math.radians(ry_deg)
                    rz_r = math.radians(rz_deg)
                    cx, sx = math.cos(rx_r), math.sin(rx_r)
                    cy, sy = math.cos(ry_r), math.sin(ry_r)
                    cz, sz = math.cos(rz_r), math.sin(rz_r)
                    r_x = np.array([[1.0, 0.0, 0.0], [0.0, cx, -sx], [0.0, sx, cx]], dtype=np.float64)
                    r_y = np.array([[cy, 0.0, sy], [0.0, 1.0, 0.0], [-sy, 0.0, cy]], dtype=np.float64)
                    r_z = np.array([[cz, -sz, 0.0], [sz, cz, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64)
                    r_three = r_x @ r_y @ r_z
                    quat_three = [0.0, 0.0, 0.0, 1.0]

                r_zup = r_x_pos90 @ r_three @ r_x_neg90
                d_zup = np.array([tx, -tz, ty], dtype=np.float64)

                # Compute shared native_anchor_twd across all parts of scan idx (for multi-material consistency)
                all_part_world_mins = []
                all_part_world_maxs = []
                for rp in scan_raw_parts:
                    off_v = rp["obj_offset"] if rp["obj_offset"] is not None else np.zeros(3, dtype=np.float64)
                    all_part_world_mins.append(rp["v"].min(axis=0) + off_v)
                    all_part_world_maxs.append(rp["v"].max(axis=0) + off_v)
                scan_wmin = np.min(np.vstack(all_part_world_mins), axis=0)
                scan_wmax = np.max(np.vstack(all_part_world_maxs), axis=0)
                scan_wmid = (scan_wmin + scan_wmax) * 0.5

                raw_cz = ly.get("raw_center_zup")
                if isinstance(raw_cz, list) and len(raw_cz) >= 3:
                    rc_vec = np.array([float(raw_cz[0]), float(raw_cz[1]), float(raw_cz[2])], dtype=np.float64)
                    if float(np.max(np.abs(scan_wmid))) >= 50000.0 and float(np.max(np.abs(rc_vec))) >= 50000.0:
                        native_anchor_twd = rc_vec
                    else:
                        native_anchor_twd = scan_wmid
                else:
                    native_anchor_twd = scan_wmid

                merged_anchor_twd = c_ref + d_zup
                scan_kept_any = False

                for rp in scan_raw_parts:
                    v_arr = rp["v"]
                    vt_arr = rp["vt"]
                    f_arr = rp["f"].copy()
                    off_v = rp["obj_offset"]
                    if off_v is not None and float(np.max(np.abs(v_arr))) < 50000.0 and float(np.max(np.abs(native_anchor_twd))) >= 50000.0:
                        v_centered = (v_arr + off_v) - native_anchor_twd
                    else:
                        v_centered = v_arr - native_anchor_twd

                    if raw_deletions and len(f_arr) > 0:
                        f_v0_idx = np.clip(f_arr[:, [0, 2, 4]] - 1, 0, len(v_centered) - 1)
                        del_mask = _eval_multiscan_layer_delete_mask(v_centered, f_v0_idx, sid, raw_deletions)
                        n_del = int(del_mask.sum())
                        if n_del > 0:
                            total_deleted_faces += n_del
                            f_arr = f_arr[~del_mask]

                    if len(f_arr) == 0:
                        continue

                    v_twd97 = merged_anchor_twd + (v_centered @ r_zup.T)
                    v_local_merged = (v_twd97 - merged_offset).astype(np.float32)
                    vt_float32 = vt_arr.astype(np.float32)

                    merged_parts.append(
                        {
                            "scan_idx": idx,
                            "scan_id": sid,
                            "v_local": v_local_merged,
                            "vt": vt_float32,
                            "f": f_arr,
                            "raw_jpeg": rp["raw_jpeg"],
                            "pil_img": rp["pil_img"],
                        }
                    )
                    scan_kept_any = True

                if scan_kept_any:
                    layer_transforms_by_sid[sid] = {
                        "na": native_anchor_twd.copy(),
                        "ma": merged_anchor_twd.copy(),
                        "R": r_zup.copy(),
                        "sc": sc,
                    }

                    def _extract_sc_merged_from(s_obj: Dict[str, Any], _seen: Optional[set] = None) -> List[Dict[str, Any]]:
                        if not isinstance(s_obj, dict):
                            return []
                        seen_s = set(_seen) if _seen else set()
                        mf_l = s_obj.get("merged_from")
                        if isinstance(mf_l, list) and mf_l:
                            return [x for x in mf_l if isinstance(x, dict)]
                        ex_r = s_obj.get("extra_json")
                        ex_d = json.loads(ex_r) if isinstance(ex_r, str) and ex_r.strip() else (ex_r if isinstance(ex_r, dict) else {})
                        if isinstance(ex_d.get("merged_from"), list) and ex_d["merged_from"]:
                            return [x for x in ex_d["merged_from"] if isinstance(x, dict)]
                        p_id = str(s_obj.get("derived_from_scan_id") or ex_d.get("derived_from_scan_id") or "").strip()
                        if p_id and p_id not in seen_s:
                            seen_s.add(p_id)
                            p_sc = self.db.get_scan(p_id)
                            if p_sc:
                                return _extract_sc_merged_from(p_sc, seen_s)
                        return []

                    sub_mf_list = _extract_sc_merged_from(sc)
                    if sub_mf_list:
                        for sub_mf in sub_mf_list:
                            na_1 = np.array(
                                sub_mf.get("native_anchor_zup")
                                if isinstance(sub_mf.get("native_anchor_zup"), (list, tuple)) and len(sub_mf["native_anchor_zup"]) >= 3
                                else native_anchor_twd,
                                dtype=np.float64,
                            )
                            ma_1 = np.array(
                                sub_mf.get("merged_anchor_zup")
                                if isinstance(sub_mf.get("merged_anchor_zup"), (list, tuple)) and len(sub_mf["merged_anchor_zup"]) >= 3
                                else native_anchor_twd,
                                dtype=np.float64,
                            )
                            rm_1_raw = sub_mf.get("r_zup_rowmajor")
                            R_1 = (
                                np.array(rm_1_raw[:9], dtype=np.float64).reshape(3, 3)
                                if isinstance(rm_1_raw, (list, tuple)) and len(rm_1_raw) >= 9
                                else np.eye(3, dtype=np.float64)
                            )
                            ma_comp = merged_anchor_twd + (r_zup @ (ma_1 - native_anchor_twd))
                            R_comp = r_zup @ R_1
                            merged_from_meta.append(
                                {
                                    "scan_id": str(sub_mf.get("scan_id") or ""),
                                    "derived_from_scan_id": str(sub_mf.get("derived_from_scan_id") or ""),
                                    "name": sub_mf.get("name") or sub_mf.get("scan_id") or sid,
                                    "position_three": [round(tx, 4), round(ty, 4), round(tz, 4)],
                                    "quaternion_three": [round(float(x), 6) for x in quat_three[:4]],
                                    "euler_deg_three": [round(rx_deg, 2), round(ry_deg, 2), round(rz_deg, 2)],
                                    "native_anchor_zup": [round(float(x), 4) for x in na_1],
                                    "merged_anchor_zup": [round(float(x), 4) for x in ma_comp],
                                    "zup_shift": [round(float(x), 4) for x in (ma_comp - na_1)],
                                    "r_zup_rowmajor": [round(float(x), 8) for x in R_comp.ravel()],
                                }
                            )
                    else:
                        merged_from_meta.append(
                            {
                                "scan_id": sid,
                                "derived_from_scan_id": str(sc.get("derived_from_scan_id") or ""),
                                "name": sc.get("name") or sid,
                                "position_three": [round(tx, 4), round(ty, 4), round(tz, 4)],
                                "quaternion_three": [round(float(x), 6) for x in quat_three[:4]],
                                "euler_deg_three": [round(rx_deg, 2), round(ry_deg, 2), round(rz_deg, 2)],
                                "native_anchor_zup": [round(float(x), 4) for x in native_anchor_twd],
                                "merged_anchor_zup": [round(float(x), 4) for x in merged_anchor_twd],
                                "zup_shift": [round(float(x), 4) for x in (merged_anchor_twd - native_anchor_twd)],
                                "r_zup_rowmajor": [round(float(x), 8) for x in r_zup.ravel()],
                            }
                        )

            if not merged_parts:
                raise ValueError("Lasso deletions removed 100% of triangles across all combined scans. Undo or adjust your marked regions.")

            if total_deleted_faces > 0:
                applied_steps.append(f"Deleted {total_deleted_faces:,} triangles via Lasso")

            # Clean noisy outer photogrammetry boundary skirts in overlap zones where an adjacent scan has deep interior coverage
            if payload.get("clean_overlap_skirts", True):
                skirt_trimmed = _trim_multiscan_overlap_skirts(merged_parts)
                if skirt_trimmed > 0:
                    applied_steps.append(f"Trimmed {skirt_trimmed:,} overlap skirt tris")

            # Compact each part's surviving vertices & UVs, write multi-material mesh.obj + mesh_{p}.jpg, and build per-part tile_s{p}.glb
            all_v_compact: List[np.ndarray] = []
            all_vt_compact: List[np.ndarray] = []
            all_f_blocks: List[Tuple[str, np.ndarray]] = []
            mtl_blocks: List[str] = []
            child_tile_nodes: List[Dict[str, Any]] = []
            v_global_off = 0
            vt_global_off = 0

            if has_comp:
                applied_steps.append(f"Optimized ({raw_preset}, {target_tex_res}px/scan)")

            for p_idx, part in enumerate(merged_parts):
                f_p = part["f"]
                if len(f_p) == 0:
                    continue
                v_p = part["v_local"]
                vt_p = part["vt"]

                used_v, inv_v = np.unique(np.clip(f_p[:, [0, 2, 4]] - 1, 0, len(v_p) - 1), return_inverse=True)
                used_vt, inv_vt = np.unique(np.clip(f_p[:, [1, 3, 5]] - 1, 0, len(vt_p) - 1), return_inverse=True)
                v_comp = v_p[used_v]
                vt_comp = vt_p[used_vt]
                inv_v_2d = inv_v.reshape(-1, 3) + 1
                inv_vt_2d = inv_vt.reshape(-1, 3) + 1
                f_local_1based = np.column_stack(
                    [
                        inv_v_2d[:, 0],
                        inv_vt_2d[:, 0],
                        inv_v_2d[:, 1],
                        inv_vt_2d[:, 1],
                        inv_v_2d[:, 2],
                        inv_vt_2d[:, 2],
                    ]
                )

                mtl_name = f"mesh_{p_idx}"
                jpg_name = f"mesh_{p_idx}.jpg"
                jpg_path = os.path.join(obj_work_dir, jpg_name)
                raw_jb = part.get("raw_jpeg")
                pil_im = part.get("pil_img")
                exact_jpeg_for_glb: Optional[bytes] = None

                if not has_comp and raw_jb is not None and raw_jb[:2] == b"\xff\xd8":
                    # Zero-reencode pass-through: bit-identical 4096x4096 JPEG bytes!
                    with open(jpg_path, "wb") as jf:
                        jf.write(raw_jb)
                    exact_jpeg_for_glb = raw_jb
                else:
                    if pil_im is None and raw_jb is not None:
                        try:
                            pil_im = Image.open(io.BytesIO(raw_jb)).convert("RGB")
                        except Exception:
                            pil_im = None
                    if pil_im is None:
                        pil_im = Image.new("RGB", (64, 64), (160, 160, 160))
                    else:
                        pil_im = pil_im.convert("RGB")
                    if has_comp and max(pil_im.size) > target_tex_res:
                        pil_im = pil_im.copy()
                        pil_im.thumbnail((target_tex_res, target_tex_res), Image.Resampling.LANCZOS)
                    q_use = target_jpeg_q if has_comp else 95
                    out_jb = io.BytesIO()
                    pil_im.save(out_jb, format="JPEG", quality=q_use, optimize=True)
                    exact_jpeg_for_glb = out_jb.getvalue()
                    with open(jpg_path, "wb") as jf:
                        jf.write(exact_jpeg_for_glb)

                mtl_blocks.append(f"newmtl {mtl_name}\nKd 1.000000 1.000000 1.000000\nillum 0\nmap_Kd {jpg_name}\n")

                # Build dedicated per-part 3D tile `tileset/tiles/tile_s{p_idx}.glb`
                tmp_part_mtl = os.path.join(obj_work_dir, f"_tmp_part_{p_idx}.mtl")
                tmp_part_obj = os.path.join(obj_work_dir, f"_tmp_part_{p_idx}.obj")
                tile_rel_uri = f"tiles/tile_s{p_idx}.glb"
                tile_out_path = os.path.join(tiles_work_dir, f"tile_s{p_idx}.glb")
                tmp_tile_glb = tile_out_path + ".tmp.glb"
                try:
                    with open(tmp_part_mtl, "w", encoding="utf-8") as pmf:
                        pmf.write(f"newmtl {mtl_name}\nKd 1.000000 1.000000 1.000000\nillum 0\nmap_Kd {jpg_name}\n")
                    with open(tmp_part_obj, "wb") as pof:
                        pof.write(f"mtllib _tmp_part_{p_idx}.mtl\nusemtl {mtl_name}\n".encode("utf-8"))
                        np.savetxt(pof, v_comp, fmt="v %.4f %.4f %.4f")
                        np.savetxt(pof, vt_comp, fmt="vt %.6f %.6f")
                        np.savetxt(pof, f_local_1based, fmt="f %d/%d %d/%d %d/%d")

                    gp_cmd = [
                        GLTFPACK_EXE,
                        "-i",
                        tmp_part_obj,
                        "-o",
                        tmp_tile_glb,
                        "-vp",
                        "16",
                        "-vt",
                        "16",
                        "-vn",
                        "8",
                        "-cc",
                    ]
                    if has_comp:
                        ratio_p = max(0.08, min(0.98, float(comp_mult_map[raw_preset])))
                        gp_cmd.extend(["-si", f"{ratio_p:.4f}", "-slb", "-sv"])

                    subprocess.run(
                        gp_cmd,
                        capture_output=True,
                        timeout=180,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0,
                    )
                    if os.path.isfile(tmp_tile_glb) and os.path.getsize(tmp_tile_glb) > 256:
                        with open(tmp_tile_glb, "rb") as tf_g:
                            raw_tile_b = tf_g.read()
                        if exact_jpeg_for_glb:
                            raw_tile_b = replace_glb_single_image_bytes(raw_tile_b, exact_jpeg_for_glb, "image/jpeg")
                        shifted_tile_b = shift_glb_node_translation(raw_tile_b, ox_m, oy_m, oz_m)
                        with open(tile_out_path, "wb") as wf_g:
                            wf_g.write(shifted_tile_b)
                finally:
                    for p_clean in (tmp_part_mtl, tmp_part_obj, tmp_tile_glb):
                        if os.path.isfile(p_clean):
                            try:
                                os.remove(p_clean)
                            except OSError:
                                pass

                p_vmin_twd = v_comp.min(axis=0).astype(np.float64) + merged_offset
                p_vmax_twd = v_comp.max(axis=0).astype(np.float64) + merged_offset
                p_bc = (p_vmin_twd + p_vmax_twd) * 0.5
                p_bh = (p_vmax_twd - p_vmin_twd) * 0.5
                if os.path.isfile(tile_out_path):
                    child_tile_nodes.append(
                        {
                            "boundingVolume": {
                                "box": [
                                    round(float(p_bc[0]), 4),
                                    round(float(p_bc[1]), 4),
                                    round(float(p_bc[2]), 4),
                                    round(max(float(p_bh[0]), 0.5), 4),
                                    0.0,
                                    0.0,
                                    0.0,
                                    round(max(float(p_bh[1]), 0.5), 4),
                                    0.0,
                                    0.0,
                                    0.0,
                                    round(max(float(p_bh[2]), 0.5), 4),
                                ]
                            },
                            "geometricError": 0.0,
                            "refine": "REPLACE",
                            "content": {"uri": tile_rel_uri},
                            "children": [],
                        }
                    )

                f_global = f_local_1based.copy()
                f_global[:, [0, 2, 4]] += v_global_off
                f_global[:, [1, 3, 5]] += vt_global_off
                all_v_compact.append(v_comp)
                all_vt_compact.append(vt_comp)
                all_f_blocks.append((mtl_name, f_global))
                v_global_off += len(v_comp)
                vt_global_off += len(vt_comp)

            if not all_v_compact or not child_tile_nodes:
                raise RuntimeError("Failed to generate 3D tile meshes for merged scan.")

            v_merged = np.vstack(all_v_compact)
            vt_merged = np.vstack(all_vt_compact)
            f_merged = np.vstack([blk[1] for blk in all_f_blocks])

            mtl_path = os.path.join(obj_work_dir, "mesh.mtl")
            with open(mtl_path, "w", encoding="utf-8") as mf:
                mf.write("\n".join(mtl_blocks))

            off_path = os.path.join(obj_work_dir, "offset.xyz")
            with open(off_path, "w", encoding="utf-8") as of:
                of.write(f"{ox_m:.3f} {oy_m:.3f} {oz_m:.3f}\n")

            obj_work_path = os.path.join(obj_work_dir, "mesh.obj")
            with open(obj_work_path, "wb") as obj_f:
                obj_f.write(b"mtllib mesh.mtl\n")
                np.savetxt(obj_f, v_merged, fmt="v %.4f %.4f %.4f")
                np.savetxt(obj_f, vt_merged, fmt="vt %.6f %.6f")
                for mtl_nm, f_blk in all_f_blocks:
                    obj_f.write(f"usemtl {mtl_nm}\n".encode("utf-8"))
                    np.savetxt(obj_f, f_blk, fmt="f %d/%d %d/%d %d/%d")

            v_surviving = v_merged
            vmin_twd = v_surviving.min(axis=0).astype(np.float64) + merged_offset
            vmax_twd = v_surviving.max(axis=0).astype(np.float64) + merged_offset
            bc = (vmin_twd + vmax_twd) * 0.5
            bh = (vmax_twd - vmin_twd) * 0.5
            diag = float(np.linalg.norm(vmax_twd - vmin_twd))
            root_geom_err = round(max(500.0, diag * 8.0), 4)

            ts_dict = {
                "asset": {
                    "version": "1.1",
                    "generator": "GatheringCloud Multi-Scan Unifier v2.0 (Zero-Loss Multi-Tile 4K)",
                    "gltfUpAxis": "Z",
                },
                "geometricError": root_geom_err,
                "root": {
                    "boundingVolume": {
                        "box": [
                            round(float(bc[0]), 4),
                            round(float(bc[1]), 4),
                            round(float(bc[2]), 4),
                            round(max(float(bh[0]), 0.5), 4),
                            0.0,
                            0.0,
                            0.0,
                            round(max(float(bh[1]), 0.5), 4),
                            0.0,
                            0.0,
                            0.0,
                            round(max(float(bh[2]), 0.5), 4),
                        ]
                    },
                    "geometricError": root_geom_err,
                    "refine": "ADD",
                    "children": child_tile_nodes,
                },
            }
            ts_work_dir = os.path.join(work_proj_dir, "tileset")
            ts_work_path = os.path.join(ts_work_dir, "tileset.json")
            with open(ts_work_path, "w", encoding="utf-8") as tf_out:
                json.dump(ts_dict, tf_out, indent=2)
            with open(os.path.join(ts_work_dir, "offset.xyz"), "w", encoding="utf-8") as off_ts:
                off_ts.write(f"{ox_m:.3f} {oy_m:.3f} {oz_m:.3f}\n")

            prim_crs_upper = str(primary_scan.get("crs") or "").upper()
            is_local_merge = ("LOCAL" in prim_crs_upper) or (
                primary_scan.get("lat") is None and abs(float(bc[0])) < 50000.0 and abs(float(bc[1])) < 50000.0
            )
            if is_local_merge:
                lat_m: Optional[float] = None
                lon_m: Optional[float] = None
                final_crs_label = CRS_DEFINITIONS["LOCAL_ORIGIN"]["label"]
            else:
                lat_m, lon_m = twd97_to_wgs84(float(bc[0]), float(bc[1]))
                final_crs_label = TWD97_TWVD2001_SHORT
            if has_crs:
                merged_src_ref = {
                    **primary_scan,
                    "crs": final_crs_label,
                    "lat": lat_m,
                    "lon": lon_m,
                    "twd97_e": float(bc[0]),
                    "twd97_n": float(bc[1]),
                    "twd97_h": float(bc[2]),
                }
                crs_info = _transform_tileset_crs_in_place(
                    tileset_dir=ts_work_dir,
                    source_scan=merged_src_ref,
                    target_crs_code=target_crs_code,
                    custom_offset_xyz=(crs_off_x, crs_off_y, crs_off_z),
                    geoid_offset_override=geoid_override_val,
                )
                final_crs_label = crs_info["crs_label"]
                lat_m = crs_info["lat"]
                lon_m = crs_info["lon"]
                with open(ts_work_path, "r", encoding="utf-8") as f_ts_post:
                    post_ts = json.load(f_ts_post)
                post_bc, post_bh = _compute_tileset_world_bounds(post_ts)
                if post_bc is not None and post_bh is not None:
                    bc = post_bc
                    bh = np.array(post_bh, dtype=np.float64)
                off_note = (
                    f" + Δ({crs_off_x:+.2f}, {crs_off_y:+.2f}, {crs_off_z:+.2f})m"
                    if (abs(crs_off_x) > 1e-4 or abs(crs_off_y) > 1e-4 or abs(crs_off_z) > 1e-4)
                    else ""
                )
                applied_steps.append(f"CRS -> {final_crs_label}{off_note}")

            # Compute 2D occupied footprint area in m^2 using 2m grid cells on surviving vertices
            gx = np.floor(v_surviving[:, 0] / 2.0).astype(np.int64)
            gy = np.floor(v_surviving[:, 1] / 2.0).astype(np.int64)
            unique_cells = len(np.unique(gx * 1000003 + gy))
            covered_area_m2 = round(max(float(unique_cells) * 4.0, float(bh[0] * bh[1] * 2.2)), 1)

            ts_out_path = os.path.join(out_proj_dir, "tileset", "tileset.json")
            obj_out_path = os.path.join(out_proj_dir, "exports", "obj_mesh", "mesh.obj")
            now_ts = time.time()
            summary_str = " · ".join(applied_steps)
            scan_record = {
                "scan_id": new_scan_id,
                "name": raw_name,
                "user_edited_name": 1,
                "project_group": proj_group,
                "project_name_zh": proj_zh,
                "capture_date": datetime.now().strftime("%Y-%m-%d %H:%M"),
                "uploaded_at": now_ts,
                "uploader_email": str(payload.get("actor_email") or primary_scan.get("uploader_email") or "glibivanov@gatheren.com.tw"),
                "uploader_name": str(payload.get("actor_name") or primary_scan.get("uploader_name") or "雲在天"),
                "source_zip_path": "",
                "project_dir": out_proj_dir,
                "tileset_path": ts_out_path,
                "obj_path": obj_out_path,
                "cameras_dir": primary_scan.get("cameras_dir") or "",
                "image_count": max(total_images, 1),
                "size_bytes": 1024,
                "covered_area_m2": covered_area_m2,
                "rtk_accuracy_cm": float(primary_scan.get("rtk_accuracy_cm") or 1.5),
                "crs": final_crs_label,
                "texture_resolution": target_tex_res,
                "lat": lat_m,
                "lon": lon_m,
                "elev_m": round(float(bc[2]), 2),
                "twd97_e": round(float(bc[0]), 3),
                "twd97_n": round(float(bc[1]), 3),
                "twd97_h": round(float(bc[2]), 2),
                "bounding_box": {
                    "center": [round(float(bc[0]), 3), round(float(bc[1]), 3), round(float(bc[2]), 2)],
                    "half_extents": [round(float(bh[0]), 2), round(float(bh[1]), 2), round(float(bh[2]), 2)],
                },
                "tileset_version": int(now_ts * 1000),
                "status": "completed",
                "progress_pct": 100.0,
                "stage_label": f"Unified ({summary_str})"[:180],
                "notes": f"Unified scan merged from {', '.join(m['scan_id'] for m in merged_from_meta)} ({summary_str})",
                "merged_from": merged_from_meta,
                "applied_adjustments": applied_steps,
            }

            # Write scan_meta.json BEFORE publishing work_proj_dir so InboxDiscovery never clobbers it!
            with open(os.path.join(work_proj_dir, "scan_meta.json"), "w", encoding="utf-8") as mf_pre:
                json.dump(scan_record, mf_pre, indent=2, ensure_ascii=False)

            # Atomically publish hidden work_proj_dir -> out_proj_dir
            if os.path.isdir(out_proj_dir):
                shutil.rmtree(out_proj_dir, ignore_errors=True)
            os.replace(work_proj_dir, out_proj_dir)

            try:
                ensure_scan_low_quality_preview(ts_out_path, force=True)
                ensure_scan_full_quality_thumbnail(ts_out_path, new_scan_id, project_dir=out_proj_dir, force=True)
            except Exception as e:
                print(f"[OptimizerBridge] Warning generating preview/thumbnail for merged scan {new_scan_id}: {e}")

            total_disk_bytes = 0
            for r_d, _, r_fs in os.walk(out_proj_dir):
                for fn in r_fs:
                    try:
                        total_disk_bytes += os.path.getsize(os.path.join(r_d, fn))
                    except OSError:
                        pass

            scan_record["size_bytes"] = max(total_disk_bytes, 1024)
            meta_file = os.path.join(out_proj_dir, "scan_meta.json")
            with open(meta_file, "w", encoding="utf-8") as mf:
                json.dump(scan_record, mf, indent=2, ensure_ascii=False)

            saved_scan = self.db.upsert_scan(scan_record)

            # Copy 3D geo-comments, measurement bookmarks, and categorization manual_overrides from source scans to the unified scan
            seen_src_ids = set()
            merged_cat_overrides: Dict[str, Any] = {
                "removed_ids": [],
                "removed_centers": [],
                "added_trees": [],
                "added_walls": [],
                "added_roads": [],
                "added_water": [],
            }
            has_any_cat_override = False
            new_ce, new_cn, new_ch = float(bc[0]), float(bc[1]), float(bc[2])

            for _, src_sc in resolved_layers:
                src_sid = str(src_sc.get("scan_id") or "").strip()
                if src_sid and src_sid.lower() not in seen_src_ids:
                    seen_src_ids.add(src_sid.lower())
                    ltf = layer_transforms_by_sid.get(src_sid)
                    src_e = float(src_sc.get("twd97_e") or 0.0)
                    src_n = float(src_sc.get("twd97_n") or 0.0)
                    src_h = float(src_sc.get("twd97_h") or 0.0)

                    def _make_layer_tx(ltf_info, se, sn, sh):
                        def _tx(px: float, py: float, pz: float, ce_in: float, cn_in: float, ch_in: float):
                            old_e = float(ce_in) if abs(float(ce_in)) > 100.0 else (se + float(px))
                            old_n = float(cn_in) if abs(float(cn_in)) > 100.0 else (sn - float(pz))
                            old_h = float(ch_in) if abs(float(ch_in)) > 0.001 or abs(sh) < 0.001 else (sh + float(py))
                            if ltf_info is not None:
                                na_v = ltf_info["na"]
                                ma_v = ltf_info["ma"]
                                R_v = ltf_info["R"]
                                d_v = np.array([old_e - float(na_v[0]), old_n - float(na_v[1]), old_h - float(na_v[2])], dtype=np.float64)
                                rot_v = R_v @ d_v
                                te = float(ma_v[0] + rot_v[0])
                                tn = float(ma_v[1] + rot_v[1])
                                th = float(ma_v[2] + rot_v[2])
                            else:
                                te, tn, th = old_e, old_n, old_h
                            if has_crs:
                                te += crs_off_x
                                tn += crs_off_y
                                th += crs_off_z
                            npx = round(te - new_ce, 3)
                            npy = round(th - new_ch, 3)
                            npz = round(new_cn - tn, 3)
                            return npx, npy, npz, round(te, 3), round(tn, 3), round(th, 3)
                        return _tx

                    tx_fn = _make_layer_tx(ltf, src_e, src_n, src_h)
                    try:
                        self.db.clone_comments_to_scan(src_sid, new_scan_id, transform_fn=tx_fn)
                    except Exception:
                        pass
                    try:
                        self.db.clone_measurement_bookmarks_to_scan(src_sid, new_scan_id, transform_fn=tx_fn)
                    except Exception:
                        pass
                    try:
                        if surveying_engine and hasattr(surveying_engine, "_load_existing_manual_overrides"):
                            ov = surveying_engine._load_existing_manual_overrides(src_sid, src_sc)
                            if isinstance(ov, dict):
                                for rid in ov.get("removed_ids") or []:
                                    if rid not in merged_cat_overrides["removed_ids"]:
                                        merged_cat_overrides["removed_ids"].append(rid)
                                        has_any_cat_override = True
                                for rc in ov.get("removed_centers") or []:
                                    if isinstance(rc, dict) and "e" in rc and "n" in rc:
                                        _, _, _, te_r, tn_r, _ = tx_fn(0.0, 0.0, 0.0, float(rc["e"]), float(rc["n"]), src_h)
                                        rc_c = dict(rc)
                                        rc_c["e"], rc_c["n"] = te_r, tn_r
                                        merged_cat_overrides["removed_centers"].append(rc_c)
                                        has_any_cat_override = True
                                for k_add in ("added_trees", "added_walls", "added_roads", "added_water"):
                                    for item_a in ov.get(k_add) or []:
                                        if not isinstance(item_a, dict):
                                            continue
                                        it_c = dict(item_a)
                                        for pt_k, loc_k in (("trunk_twd97", "trunk_local"), ("center_twd97", "center_local")):
                                            pt_v = it_c.get(pt_k)
                                            if isinstance(pt_v, (list, tuple)) and len(pt_v) >= 3:
                                                lx, ly, lz, te_p, tn_p, th_p = tx_fn(0.0, 0.0, 0.0, float(pt_v[0]), float(pt_v[1]), float(pt_v[2]))
                                                it_c[pt_k] = [te_p, tn_p, th_p]
                                                it_c[loc_k] = [lx, ly, lz]
                                        for poly_k, ploc_k in (("base_polyline_twd97", "base_polyline_local"), ("top_polyline_twd97", "top_polyline_local"), ("boundary_twd97", "boundary_local")):
                                            if isinstance(it_c.get(poly_k), list):
                                                new_twd_l, new_loc_l = [], []
                                                for p_i in it_c[poly_k]:
                                                    if isinstance(p_i, (list, tuple)) and len(p_i) >= 3:
                                                        lx, ly, lz, te_p, tn_p, th_p = tx_fn(0.0, 0.0, 0.0, float(p_i[0]), float(p_i[1]), float(p_i[2]))
                                                        new_twd_l.append([te_p, tn_p, th_p])
                                                        new_loc_l.append([lx, ly, lz])
                                                it_c[poly_k] = new_twd_l
                                                it_c[ploc_k] = new_loc_l
                                        merged_cat_overrides[k_add].append(it_c)
                                        has_any_cat_override = True
                    except Exception:
                        pass

            if has_any_cat_override:
                scan_record["categorization_manual_overrides"] = merged_cat_overrides
                with open(meta_file, "w", encoding="utf-8") as mf:
                    json.dump(scan_record, mf, indent=2, ensure_ascii=False)
            saved_scan = self.db.get_scan(new_scan_id) or saved_scan

            # Multi-scan merge NEVER deletes/trashes individual source scans unless explicitly requested (`True`)
            archive_originals = payload.get("archive_originals_to_bin")
            if archive_originals is None:
                archive_originals = False
            trashed_backups: List[Dict[str, Any]] = []
            if bool(archive_originals):
                actor_em = str(payload.get("actor_email") or "")
                actor_nm = str(payload.get("actor_name") or actor_em or "Editor")
                trashed_seen = set()
                for _, src_sc in resolved_layers:
                    src_sid = str(src_sc.get("scan_id") or "").strip()
                    if not src_sid or src_sid.lower() in trashed_seen or src_sid.lower() == new_scan_id.lower():
                        continue
                    trashed_seen.add(src_sid.lower())
                    src_nm = str(src_sc.get("name") or src_sid).strip()
                    tb = self.db.trash_scan(
                        src_sid,
                        actor_email=actor_em,
                        actor_name=actor_nm,
                        backup_name_override=f"{src_nm} (Pre-Merge Backup)",
                        replaced_by_scan_id=new_scan_id,
                    )
                    if tb:
                        trashed_backups.append(tb)

            def _bg_sync_merged_scan():
                try:
                    from pc_worker.gdrive_cloud_sync import build_scan_3tz_package, sync_all_scans_to_gdrive_and_vps
                    build_scan_3tz_package(
                        {"scan_id": new_scan_id, "tileset_path": ts_out_path, "project_dir": out_proj_dir},
                        force=True,
                    )
                    sync_all_scans_to_gdrive_and_vps(self.db, None, force=False)
                except Exception as ce:
                    print(f"[OptimizerBridge] Background .3tz sync note for merged scan {new_scan_id}: {ce}")

            threading.Thread(target=_bg_sync_merged_scan, daemon=True).start()

            duration_s = round(time.time() - t0, 2)
            out_mb = round(total_disk_bytes / (1024 * 1024), 2)

            return {
                "status": "ok",
                "action": "merge_scans",
                "scan_id": new_scan_id,
                "scan": saved_scan,
                "merged_count": num_scans,
                "deleted_faces": total_deleted_faces,
                "applied_adjustments": applied_steps,
                "archived_to_bin_count": len(trashed_backups),
                "trashed_backups": trashed_backups,
                "crs": final_crs_label,
                "total_vertices": int(len(v_merged)),
                "total_faces": int(len(f_merged)),
                "covered_area_m2": covered_area_m2,
                "output_mb": out_mb,
                "glb_size_mb": out_mb,
                "duration_s": duration_s,
            }
        except Exception:
            try:
                self.db.delete_scan(new_scan_id)
            except Exception:
                pass
            if os.path.isdir(work_proj_dir):
                shutil.rmtree(work_proj_dir, ignore_errors=True)
            if os.path.isdir(out_proj_dir):
                shutil.rmtree(out_proj_dir, ignore_errors=True)
            raise

    def get_crs_catalog(self) -> List[Dict[str, Any]]:
        return list(CRS_DEFINITIONS.values())

    def run_generate_scan_action(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Generates a brand-new scan in C:\\GatheringScans\\<new_scan_id> from a source scan while leaving
        the source scan 100% untouched on disk. Applies all staged adjustments in a single pass:
          1. Multi-region Lasso / Plan-Polygon Deletion (`deletions`)
          2. Optional Crop Keep (`crop_keep`)
          3. Optional Mesh & Texture Compression (`compression_preset`: quality | balanced | web | ultra_light)
          4. Optional Coordinate Reference System & Datum Offset (`crs_config`: target_crs + offset_x/y/z)
        """
        from pc_worker.preview_generator import (
            ensure_scan_low_quality_preview,
            ensure_scan_full_quality_thumbnail,
        )
        from pc_worker.gdrive_watcher import _compute_scan_covered_area_m2

        t0 = time.time()
        source_scan_id = str(payload.get("scan_id") or "").strip()
        if not source_scan_id:
            raise ValueError("Missing source scan_id.")

        source_scan = self.db.get_scan(source_scan_id)
        if not source_scan:
            raise ValueError(f"Source scan not found: {source_scan_id}")

        src_ts_path = source_scan.get("tileset_path") or ""
        if not src_ts_path or not os.path.exists(src_ts_path):
            raise FileNotFoundError(f"Source tileset path not found on PC: {src_ts_path}")
        in_dir = os.path.dirname(src_ts_path) if os.path.isfile(src_ts_path) else src_ts_path
        if not os.path.isdir(in_dir):
            raise FileNotFoundError(f"Source tileset directory not found: {in_dir}")

        # 1. Collect staged deletions (multiple lasso frustum strokes + multiple 2D plan polygons)
        all_del_strokes: List[Dict[str, Any]] = []
        all_del_polys: List[List[List[float]]] = []
        raw_deletions = payload.get("deletions") if isinstance(payload.get("deletions"), list) else []
        for batch in raw_deletions:
            if not isinstance(batch, dict):
                continue
            for st in batch.get("frustum_strokes") or []:
                if isinstance(st, dict) and len(st.get("ndc_polygon") or []) >= 3:
                    all_del_strokes.append(st)
            for poly in batch.get("native_polygons") or []:
                p_clean = _safe_parse_poly2d(poly)
                if p_clean is not None:
                    all_del_polys.append(p_clean)
            single_poly = batch.get("native_polygon")
            if single_poly:
                p_clean = _safe_parse_poly2d(single_poly)
                if p_clean is not None:
                    all_del_polys.append(p_clean)

        for st in payload.get("delete_frustum_strokes") or []:
            if isinstance(st, dict) and len(st.get("ndc_polygon") or []) >= 3:
                all_del_strokes.append(st)
        for poly in payload.get("delete_native_polygons") or []:
            p_clean = _safe_parse_poly2d(poly)
            if p_clean is not None:
                all_del_polys.append(p_clean)

        has_deletions = bool(all_del_strokes or all_del_polys)

        # 2. Collect optional Crop Keep region(s)
        crop_keep = payload.get("crop_keep") if isinstance(payload.get("crop_keep"), dict) else {}
        keep_strokes = [
            st
            for st in (crop_keep.get("frustum_strokes") or [])
            if isinstance(st, dict) and len(st.get("ndc_polygon") or []) >= 3
        ]
        keep_polys: List[List[List[float]]] = []
        for poly in (crop_keep.get("native_polygons") or []):
            p_clean = _safe_parse_poly2d(poly)
            if p_clean is not None:
                keep_polys.append(p_clean)
        if crop_keep.get("native_polygon"):
            p_clean = _safe_parse_poly2d(crop_keep.get("native_polygon"))
            if p_clean is not None:
                keep_polys.append(p_clean)
        keep_min_z = safe_float(crop_keep.get("min_elev"), -9999.0)
        if keep_min_z is None:
            keep_min_z = -9999.0
        keep_max_z = safe_float(crop_keep.get("max_elev"), 9999.0)
        if keep_max_z is None:
            keep_max_z = 9999.0
        has_crop_keep = bool(keep_strokes or keep_polys)

        # 3. Collect optional Compression preset
        raw_preset = str(payload.get("compression_preset") or "").lower().strip()
        if raw_preset in ("", "none", "off", "skip", "original"):
            preset_name = ""
            preset_key = ""
        else:
            preset_name = raw_preset
            preset_key = "ultra" if raw_preset == "ultra_light" else raw_preset
            if preset_key not in ("quality", "balanced", "web", "ultra"):
                preset_key = "balanced"
                preset_name = "balanced"
        has_compression = bool(preset_key)

        # 4. Collect optional Coordinate System & Datum Offset
        crs_cfg = payload.get("crs_config") if isinstance(payload.get("crs_config"), dict) else {}
        target_crs_code = str(crs_cfg.get("target_crs") or "").strip().upper()
        off_x = safe_float(crs_cfg.get("offset_x"), 0.0) or 0.0
        off_y = safe_float(crs_cfg.get("offset_y"), 0.0) or 0.0
        off_z = safe_float(crs_cfg.get("offset_z"), 0.0) or 0.0
        geoid_override_raw = crs_cfg.get("geoid_offset_override") if crs_cfg.get("geoid_offset_override") is not None else crs_cfg.get("h_offset_from_twvd")
        geoid_override_val = safe_float(geoid_override_raw)
        has_crs = bool(
            (target_crs_code and target_crs_code in CRS_DEFINITIONS)
            or abs(off_x) > 1e-6
            or abs(off_y) > 1e-6
            or abs(off_z) > 1e-6
            or geoid_override_val is not None
        )

        # 5. Collect optional Slope-Preserving Flatten Zones
        raw_flatten_zones = payload.get("flatten_zones") if isinstance(payload.get("flatten_zones"), list) else []
        has_flatten = len(raw_flatten_zones) > 0

        if not (has_deletions or has_crop_keep or has_compression or has_crs or has_flatten):
            raise ValueError(
                "Please stage at least one adjustment (Lasso Delete, Crop Keep, Slope Flatten, Mesh Compression, or Coordinate System) before generating a new scan."
            )

        base_name = str(source_scan.get("name") or source_scan_id).strip()
        raw_name = str(payload.get("new_scan_name") or payload.get("name") or "").strip()
        if not raw_name:
            raw_name = base_name

        proj_group = str(payload.get("project_group") or source_scan.get("project_group") or "Unassigned Site").strip()
        proj_zh = str(payload.get("project_name_zh") or source_scan.get("project_name_zh") or f"{proj_group} 工程掃描群組").strip()

        clean_slug = re.sub(r"[^a-z0-9_]+", "_", raw_name.lower()).strip("_")[:48]
        if not clean_slug:
            clean_slug = f"scan_{int(t0)}"
        new_scan_id = f"edited_{clean_slug}_{int(t0 * 10) % 1000000}"
        out_proj_dir = os.path.join(LOCAL_SCANS_ROOT, new_scan_id)
        work_proj_dir = os.path.join(LOCAL_SCANS_ROOT, f"_generating_{new_scan_id}")
        if os.path.isdir(work_proj_dir):
            shutil.rmtree(work_proj_dir, ignore_errors=True)
        os.makedirs(work_proj_dir, exist_ok=True)

        del_stats: Dict[str, Any] = {}
        keep_stats: Dict[str, Any] = {}
        opt_stats: Dict[str, Any] = {}
        flatten_stats: Dict[str, Any] = {}
        crs_info: Dict[str, Any] = {}
        applied_steps: List[str] = []

        try:
            cur_dir = in_dir

            if has_deletions:
                from cutter.spatial_cutter import SpatialCutter

                stage_del = os.path.join(work_proj_dir, "_stage_del")
                os.makedirs(stage_del, exist_ok=True)
                cutter_del = SpatialCutter(
                    input_tileset_dir=cur_dir,
                    output_tileset_dir=stage_del,
                    up_axis="z",
                    compress_output=not has_compression,
                    mode="delete_inside",
                    frustum_strokes=all_del_strokes if all_del_strokes else None,
                    polygons_list=all_del_polys if all_del_polys else None,
                )
                del_stats = cutter_del.run()
                if not os.path.isfile(os.path.join(stage_del, "tileset.json")):
                    raise ValueError(
                        "The marked deletion regions removed 100% of the scan mesh. Undo or adjust your marked regions and try again."
                    )
                cur_dir = stage_del
                applied_steps.append(
                    f"Deleted {len(all_del_strokes) + len(all_del_polys)} region(s) ({int(del_stats.get('triangles_deleted', 0)):,} tris)"
                )

            if has_crop_keep:
                from cutter.spatial_cutter import SpatialCutter

                stage_keep = os.path.join(work_proj_dir, "_stage_keep")
                os.makedirs(stage_keep, exist_ok=True)
                cutter_keep = SpatialCutter(
                    input_tileset_dir=cur_dir,
                    output_tileset_dir=stage_keep,
                    min_elev=keep_min_z,
                    max_elev=keep_max_z,
                    up_axis="z",
                    compress_output=not has_compression,
                    mode="keep_inside",
                    frustum_strokes=keep_strokes if keep_strokes else None,
                    polygons_list=keep_polys if keep_polys else None,
                )
                keep_stats = cutter_keep.run()
                if not os.path.isfile(os.path.join(stage_keep, "tileset.json")):
                    raise ValueError(
                        "The Crop Keep boundary excluded 100% of the scan mesh. Adjust your keep boundary and try again."
                    )
                cur_dir = stage_keep
                applied_steps.append(f"Cropped to {len(keep_strokes) + len(keep_polys)} keep region(s)")

            target_tex_res = int(source_scan.get("texture_resolution") or PIX4DMATIC_TEXTURE_SIZE)
            if has_compression:
                from optimizer.tileset_optimizer import TilesetOptimizer

                stage_opt = os.path.join(work_proj_dir, "_stage_opt")
                os.makedirs(stage_opt, exist_ok=True)
                opt_engine = TilesetOptimizer(
                    input_dir=cur_dir,
                    output_dir=stage_opt,
                    preset_name=preset_key,
                    resume=False,
                )
                opt_stats = opt_engine.run()
                tex_limit_map = {"quality": 2048, "balanced": 1536, "web": 1024, "ultra": 768}
                jpeg_qual_map = {"quality": 85, "balanced": 76, "web": 68, "ultra": 58}
                target_tex_res = tex_limit_map.get(preset_key, 1536)
                target_qual = jpeg_qual_map.get(preset_key, 75)
                for r_d, _, r_fs in os.walk(stage_opt):
                    for fn in r_fs:
                        if fn.lower().endswith(".glb"):
                            _downscale_glb_embedded_textures(
                                os.path.join(r_d, fn),
                                tex_limit=target_tex_res,
                                jpeg_quality=target_qual,
                            )
                cur_dir = stage_opt
                applied_steps.append(f"Optimized ({preset_name}, {target_tex_res}px)")

            tileset_work_dir = os.path.join(work_proj_dir, "tileset")
            if os.path.isdir(tileset_work_dir):
                shutil.rmtree(tileset_work_dir, ignore_errors=True)

            def _ignore_preview(cur_d, names):
                return [n for n in names if n.lower() in {"preview_low", "preview_tileset.json"}]

            if os.path.abspath(cur_dir) == os.path.abspath(in_dir):
                shutil.copytree(in_dir, tileset_work_dir, ignore=_ignore_preview)
            else:
                shutil.copytree(cur_dir, tileset_work_dir, ignore=_ignore_preview)

            for stage_tmp in ("_stage_del", "_stage_keep", "_stage_opt"):
                sp = os.path.join(work_proj_dir, stage_tmp)
                if os.path.isdir(sp):
                    shutil.rmtree(sp, ignore_errors=True)

            ts_work_path = os.path.join(tileset_work_dir, "tileset.json")
            if not os.path.isfile(ts_work_path):
                raise FileNotFoundError(f"Generated scan is missing tileset.json at {ts_work_path}")

            if has_flatten:
                flatten_stats = _apply_slope_preserving_flatten_zones_to_tileset(
                    tileset_dir=tileset_work_dir,
                    flatten_zones=raw_flatten_zones,
                )
                z_rpts = flatten_stats.get("zone_reports") or []
                if z_rpts:
                    r0 = z_rpts[0]
                    applied_steps.append(
                        f"Slope-Flattened {len(z_rpts)} zone(s) ({int(flatten_stats.get('vertices_flattened', 0)):,} verts, slope {r0.get('preserved_slope_pct')}% preserved, RMSE {r0.get('rmse_before_cm')}->{r0.get('rmse_after_cm')}cm)"
                    )

            final_crs_label = str(source_scan.get("crs") or TWD97_TWVD2001_SHORT)
            lat_final = float(source_scan["lat"]) if source_scan.get("lat") is not None else None
            lon_final = float(source_scan["lon"]) if source_scan.get("lon") is not None else None

            if has_crs:
                crs_info = _transform_tileset_crs_in_place(
                    tileset_dir=tileset_work_dir,
                    source_scan=source_scan,
                    target_crs_code=target_crs_code,
                    custom_offset_xyz=(off_x, off_y, off_z),
                    geoid_offset_override=geoid_override_val,
                )
                final_crs_label = crs_info["crs_label"]
                lat_final = crs_info["lat"]
                lon_final = crs_info["lon"]
                off_note = (
                    f" + Δ({off_x:+.2f}, {off_y:+.2f}, {off_z:+.2f})m"
                    if (abs(off_x) > 1e-4 or abs(off_y) > 1e-4 or abs(off_z) > 1e-4)
                    else ""
                )
                applied_steps.append(f"CRS -> {final_crs_label}{off_note}")

            with open(ts_work_path, "r", encoding="utf-8") as f_ts_pre:
                final_ts_obj = json.load(f_ts_pre)
            bc_arr, bh_list = _compute_tileset_world_bounds(final_ts_obj)
            if bc_arr is not None and bh_list is not None:
                bc = [float(bc_arr[0]), float(bc_arr[1]), float(bc_arr[2])]
                bh = [float(bh_list[0]), float(bh_list[1]), float(bh_list[2])]
            else:
                bc = [
                    float(source_scan["twd97_e"]) if source_scan.get("twd97_e") is not None else 0.0,
                    float(source_scan["twd97_n"]) if source_scan.get("twd97_n") is not None else 0.0,
                    float(source_scan["twd97_h"]) if source_scan.get("twd97_h") is not None else 0.0,
                ]
                bh = [60.0, 60.0, 15.0]

            tileset_out_dir = os.path.join(out_proj_dir, "tileset")
            ts_out_path = os.path.join(tileset_out_dir, "tileset.json")
            now_ts = time.time()
            summary_str = " · ".join(applied_steps) if applied_steps else "Saved Edited Scan"
            orig_capture_date = str(source_scan.get("capture_date") or "").strip() or datetime.now().strftime("%Y-%m-%d %H:%M")
            from pc_worker.gdrive_watcher import normalize_gatheren_uploader
            orig_up_name, orig_up_email = normalize_gatheren_uploader(
                str(source_scan.get("uploader_name") or ""),
                str(source_scan.get("uploader_email") or payload.get("actor_email") or "glibivanov@gatheren.com.tw"),
                str(source_scan.get("source_zip_path") or source_scan.get("name") or source_scan_id),
            )
            scan_record = {
                "scan_id": new_scan_id,
                "name": raw_name,
                "user_edited_name": 1,
                "project_group": proj_group,
                "project_name_zh": proj_zh,
                "capture_date": orig_capture_date,
                "uploaded_at": now_ts,
                "uploader_email": orig_up_email,
                "uploader_name": orig_up_name,
                "source_zip_path": str(source_scan.get("source_zip_path") or ""),
                "project_dir": out_proj_dir,
                "tileset_path": ts_out_path,
                "obj_path": "",
                "cameras_dir": source_scan.get("cameras_dir") or "",
                "image_count": max(int(source_scan.get("image_count") or 1), 1),
                "size_bytes": 1024,
                "covered_area_m2": float(source_scan.get("covered_area_m2") or 1000.0),
                "rtk_accuracy_cm": float(source_scan.get("rtk_accuracy_cm") or 1.5),
                "crs": final_crs_label,
                "texture_resolution": target_tex_res,
                "lat": lat_final,
                "lon": lon_final,
                "elev_m": round(float(bc[2]), 2),
                "twd97_e": round(float(bc[0]), 3),
                "twd97_n": round(float(bc[1]), 3),
                "twd97_h": round(float(bc[2]), 2),
                "bounding_box": {
                    "center": [round(float(bc[0]), 3), round(float(bc[1]), 3), round(float(bc[2]), 2)],
                    "half_extents": [round(float(bh[0]), 2), round(float(bh[1]), 2), round(float(bh[2]), 2)],
                },
                "tileset_version": int(now_ts * 1000),
                "status": "completed",
                "progress_pct": 100.0,
                "stage_label": f"Edited ({summary_str})"[:180],
                "notes": f"Edited from {source_scan_id} (backup moved to Trash Bin): {summary_str}",
                "derived_from_scan_id": source_scan_id,
                "applied_adjustments": applied_steps,
                **({"merged_from": source_scan["merged_from"]} if source_scan.get("merged_from") else {}),
            }

            with open(os.path.join(work_proj_dir, "scan_meta.json"), "w", encoding="utf-8") as mf_pre:
                json.dump(scan_record, mf_pre, indent=2, ensure_ascii=False)

            # Atomically publish hidden work_proj_dir -> out_proj_dir once tileset + scan_meta.json are 100% ready
            if os.path.isdir(out_proj_dir):
                shutil.rmtree(out_proj_dir, ignore_errors=True)
            os.replace(work_proj_dir, out_proj_dir)

            try:
                ensure_scan_low_quality_preview(ts_out_path, force=True)
                ensure_scan_full_quality_thumbnail(ts_out_path, new_scan_id, project_dir=out_proj_dir, force=True)
            except Exception as pe:
                print(f"[OptimizerBridge] Preview/thumbnail note for generated scan {new_scan_id}: {pe}")

            total_disk_bytes = 0
            for r_d, _, r_fs in os.walk(out_proj_dir):
                for fn in r_fs:
                    try:
                        total_disk_bytes += os.path.getsize(os.path.join(r_d, fn))
                    except OSError:
                        pass

            try:
                covered_area_m2 = round(float(_compute_scan_covered_area_m2(out_proj_dir, ts_out_path, bh)), 1)
            except Exception:
                covered_area_m2 = float(source_scan.get("covered_area_m2") or 1000.0)
            if covered_area_m2 <= 0.0:
                covered_area_m2 = float(source_scan.get("covered_area_m2") or 1000.0)

            scan_record["size_bytes"] = max(int(total_disk_bytes), 1024)
            scan_record["covered_area_m2"] = covered_area_m2
            meta_file = os.path.join(out_proj_dir, "scan_meta.json")
            with open(meta_file, "w", encoding="utf-8") as mf:
                json.dump(scan_record, mf, indent=2, ensure_ascii=False)

            saved_scan = self.db.upsert_scan(scan_record)

            # Copy 3D geo-comments and measurement bookmarks onto the saved edited scan before moving the original scan to Trash Bin
            src_e = float(source_scan.get("twd97_e") or 0.0)
            src_n = float(source_scan.get("twd97_n") or 0.0)
            src_h = float(source_scan.get("twd97_h") or 0.0)
            new_ce, new_cn, new_ch = float(bc[0]), float(bc[1]), float(bc[2])

            def _tx_edited_coords(px: float, py: float, pz: float, ce_in: float, cn_in: float, ch_in: float):
                te = (float(ce_in) if abs(float(ce_in)) > 100.0 else (src_e + float(px))) + (off_x if has_crs else 0.0)
                tn = (float(cn_in) if abs(float(cn_in)) > 100.0 else (src_n - float(pz))) + (off_y if has_crs else 0.0)
                th = (float(ch_in) if abs(float(ch_in)) > 0.001 or abs(src_h) < 0.001 else (src_h + float(py))) + (off_z if has_crs else 0.0)
                return round(te - new_ce, 3), round(th - new_ch, 3), round(new_cn - tn, 3), round(te, 3), round(tn, 3), round(th, 3)

            try:
                self.db.clone_comments_to_scan(source_scan_id, new_scan_id, transform_fn=_tx_edited_coords)
            except Exception as ce:
                print(f"[OptimizerBridge] Note cloning comments from {source_scan_id} to {new_scan_id}: {ce}")
            try:
                self.db.clone_measurement_bookmarks_to_scan(source_scan_id, new_scan_id, transform_fn=_tx_edited_coords)
            except Exception:
                pass
            saved_scan = self.db.get_scan(new_scan_id) or saved_scan

            archive_original = payload.get("archive_original_to_bin")
            if archive_original is None:
                archive_original = True
            trashed_backup = None
            if bool(archive_original):
                actor_em = str(payload.get("actor_email") or "")
                actor_nm = str(payload.get("actor_name") or actor_em or "Editor")
                trashed_backup = self.db.trash_scan(
                    source_scan_id,
                    actor_email=actor_em,
                    actor_name=actor_nm,
                    backup_name_override=f"{base_name} (Original Backup)",
                    replaced_by_scan_id=new_scan_id,
                )

            def _bg_sync_new_scan():
                try:
                    from pc_worker.gdrive_cloud_sync import build_scan_3tz_package, sync_all_scans_to_gdrive_and_vps
                    build_scan_3tz_package(
                        {"scan_id": new_scan_id, "tileset_path": ts_out_path, "project_dir": out_proj_dir},
                        force=True,
                    )
                    sync_all_scans_to_gdrive_and_vps(self.db, None, force=False)
                except Exception as ce:
                    print(f"[OptimizerBridge] Background .3tz sync note for generated scan {new_scan_id}: {ce}")

            threading.Thread(target=_bg_sync_new_scan, daemon=True).start()

            duration_s = round(time.time() - t0, 2)
            out_mb = round(total_disk_bytes / (1024 * 1024), 2)
            return {
                "status": "ok",
                "action": "generate_scan",
                "source_scan_id": source_scan_id,
                "scan_id": new_scan_id,
                "scan": saved_scan,
                "archived_to_bin": bool(trashed_backup),
                "trashed_backup": trashed_backup,
                "applied_adjustments": applied_steps,
                "delete_stats": del_stats,
                "crop_keep_stats": keep_stats,
                "optimize_stats": opt_stats,
                "flatten_stats": flatten_stats,
                "crs_info": crs_info,
                "crs": final_crs_label,
                "output_mb": out_mb,
                "duration_s": duration_s,
            }
        except Exception:
            try:
                self.db.delete_scan(new_scan_id)
            except Exception:
                pass
            if os.path.isdir(work_proj_dir):
                shutil.rmtree(work_proj_dir, ignore_errors=True)
            if os.path.isdir(out_proj_dir):
                shutil.rmtree(out_proj_dir, ignore_errors=True)
            raise

    def run_restore_region_action(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Restores accidentally deleted triangles inside one or more 3D Lasso frustum strokes or 2D
        polygons directly from the scan's untouched original/parent source scan(s) (`merged_from` or
        `derived_from_scan_id`), preserving Generation-0 4K JPEGs and sub-millimeter 6-DOF alignment.
        """
        import copy
        import subprocess
        from collections import deque
        from scipy.spatial import cKDTree
        from cutter.spatial_cutter import SpatialCutter
        from pc_worker.preview_generator import (
            GLTFPACK_EXE,
            replace_glb_single_image_bytes,
            shift_glb_node_translation,
            ensure_scan_low_quality_preview,
            ensure_scan_full_quality_thumbnail,
        )

        t0 = time.time()
        scan_id = str(payload.get("scan_id") or "").strip()
        if not scan_id:
            raise ValueError("Missing scan_id.")
        scan = self.db.get_scan(scan_id)
        if not scan:
            raise ValueError(f"Scan not found: {scan_id}")

        raw_strokes = payload.get("frustum_strokes") if isinstance(payload.get("frustum_strokes"), list) else []
        raw_polys = payload.get("native_polygons") if isinstance(payload.get("native_polygons"), list) else []
        connected_only = bool(payload.get("connected_only", True))

        # Convert strokes to Z-up tileset evaluation (up_matrix = identity, visible_only = False over empty holes)
        zup_strokes: List[Dict[str, Any]] = []
        eye16 = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]
        for st in raw_strokes:
            if isinstance(st, dict) and len(st.get("ndc_polygon") or []) >= 3:
                st_c = dict(st)
                st_c["up_matrix"] = eye16
                st_c["visible_only"] = False
                zup_strokes.append(st_c)

        clean_polys: List[List[List[float]]] = []
        for poly in raw_polys:
            p_clean = _safe_parse_poly2d(poly)
            if p_clean is not None:
                clean_polys.append(p_clean)

        if not zup_strokes and not clean_polys:
            raise ValueError("Mark the missing gap with Freehand 3D Lasso or Plan Polygon first.")

        proj_dir = str(scan.get("project_dir") or os.path.join(LOCAL_SCANS_ROOT, scan_id))
        ts_path = str(scan.get("tileset_path") or os.path.join(proj_dir, "tileset", "tileset.json"))
        ts_dir = os.path.dirname(ts_path)
        tiles_dir = os.path.join(ts_dir, "tiles")

        cutter_eval = SpatialCutter(
            input_tileset_dir=ts_dir,
            output_tileset_dir=ts_dir,
            up_axis="z",
            mode="keep_inside",
            frustum_strokes=zup_strokes if zup_strokes else None,
            polygons_list=clean_polys if clean_polys else None,
        )

        def _load_raw_obj_source(cand_sid: str) -> Optional[Tuple[np.ndarray, np.ndarray, np.ndarray, bytes, str]]:
            visited = set()
            cur_sid = str(cand_sid or "").strip()
            for _ in range(8):
                if not cur_sid or cur_sid in visited:
                    break
                visited.add(cur_sid)
                c_sc = self.db.get_scan(cur_sid)
                c_pdir = str((c_sc or {}).get("project_dir") or os.path.join(LOCAL_SCANS_ROOT, cur_sid))
                c_odir = os.path.join(c_pdir, "exports", "obj_mesh")
                m_obj = os.path.join(c_odir, "mesh.obj")
                m_jpg = os.path.join(c_odir, "mesh_0.jpg")
                if os.path.isfile(m_obj) and os.path.isfile(m_jpg):
                    off_f = os.path.join(c_odir, "offset.xyz")
                    if os.path.isfile(off_f):
                        ox_c, oy_c, oz_c = [float(x) for x in open(off_f, encoding="utf-8").read().split()[:3]]
                        off_v = np.array([ox_c, oy_c, oz_c], dtype=np.float64)
                    else:
                        off_v = np.zeros(3, dtype=np.float64)
                    with open(m_obj, "r", encoding="utf-8", errors="ignore") as f_o:
                        lns = f_o.read().splitlines()
                    v_nat = np.fromstring(" ".join(ln[2:] for ln in lns if ln.startswith("v ")), sep=" ", dtype=np.float64).reshape(-1, 3) + off_v
                    vt_nat = np.fromstring(" ".join(ln[3:] for ln in lns if ln.startswith("vt ")), sep=" ", dtype=np.float64).reshape(-1, 2)
                    f_nat = np.fromstring(" ".join(ln[2:] for ln in lns if ln.startswith("f ")).replace("/", " "), sep=" ", dtype=np.int64).reshape(-1, 6)
                    jb_nat = open(m_jpg, "rb").read()
                    return v_nat, vt_nat, f_nat, jb_nat, m_jpg
                cur_sid = str((c_sc or {}).get("derived_from_scan_id") or "").strip()
            return None

        mf_list = scan.get("merged_from") if isinstance(scan.get("merged_from"), list) else []
        obj_dir = os.path.join(proj_dir, "exports", "obj_mesh")
        cur_obj_p = os.path.join(obj_dir, "mesh.obj")
        total_restored = 0

        # Case 1: Multi-Tile Unified Merged Scan with multi-material exports/obj_mesh/mesh.obj
        if mf_list and os.path.isfile(cur_obj_p) and os.path.isfile(os.path.join(obj_dir, "offset.xyz")):
            ox_m, oy_m, oz_m = [float(x) for x in open(os.path.join(obj_dir, "offset.xyz"), encoding="utf-8").read().split()[:3]]
            off_m = np.array([ox_m, oy_m, oz_m], dtype=np.float64)
            with open(cur_obj_p, "r", encoding="utf-8", errors="ignore") as fm:
                mlines = fm.read().splitlines()
            v_cur_local = np.fromstring(" ".join(ln[2:] for ln in mlines if ln.startswith("v ")), sep=" ", dtype=np.float64).reshape(-1, 3)
            vt_cur = np.fromstring(" ".join(ln[3:] for ln in mlines if ln.startswith("vt ")), sep=" ", dtype=np.float64).reshape(-1, 2)

            blocks_cur: List[Tuple[str, np.ndarray]] = []
            cur_mtl = "mesh_0"
            cur_fl: List[str] = []
            for ln in mlines:
                if ln.startswith("usemtl "):
                    if cur_fl:
                        blocks_cur.append((cur_mtl, np.fromstring(" ".join(cur_fl).replace("/", " "), sep=" ", dtype=np.int64).reshape(-1, 6)))
                        cur_fl = []
                    cur_mtl = ln.split()[1].strip()
                elif ln.startswith("f "):
                    cur_fl.append(ln[2:])
            if cur_fl:
                blocks_cur.append((cur_mtl, np.fromstring(" ".join(cur_fl).replace("/", " "), sep=" ", dtype=np.int64).reshape(-1, 6)))

            ts_dict = json.load(open(ts_path, encoding="utf-8"))
            updated_parts: List[Tuple[str, np.ndarray, np.ndarray, np.ndarray]] = []

            # Build per-scan existing centroids across ALL scan tiles so trimmed overlap skirts from
            # secondary scans are never re-stacked on top of another scan's existing surface
            all_cur_cents_list: List[np.ndarray] = []
            for _, f_blk_c in blocks_cur:
                fv_g = f_blk_c[:, [0, 2, 4]] - 1
                all_cur_cents_list.append((v_cur_local[fv_g] + off_m).mean(axis=1))

            for p_idx, (mtl_nm, f_blk) in enumerate(blocks_cur):
                uv_i, inv_vi = np.unique(f_blk[:, [0, 2, 4]] - 1, return_inverse=True)
                uvt_i, inv_vti = np.unique(f_blk[:, [1, 3, 5]] - 1, return_inverse=True)
                v_ex_loc = v_cur_local[uv_i]
                vt_ex = vt_cur[uvt_i]
                fv_ex = inv_vi.reshape(-1, 3)
                fvt_ex = inv_vti.reshape(-1, 3)

                mf_entry = mf_list[p_idx] if p_idx < len(mf_list) else None
                raw_loaded = None
                if isinstance(mf_entry, dict):
                    raw_loaded = _load_raw_obj_source(str(mf_entry.get("derived_from_scan_id") or "")) or _load_raw_obj_source(str(mf_entry.get("scan_id") or ""))

                if raw_loaded is not None and isinstance(mf_entry, dict):
                    v_nat, vt_nat, f_nat, jb_nat, _ = raw_loaded
                    if isinstance(mf_entry.get("r_zup_rowmajor"), list) and len(mf_entry["r_zup_rowmajor"]) == 9:
                        R_p = np.array(mf_entry["r_zup_rowmajor"], dtype=np.float64).reshape(3, 3)
                    else:
                        R_p = np.eye(3, dtype=np.float64)
                    na_p = np.array(mf_entry.get("native_anchor_zup") or [0.0, 0.0, 0.0], dtype=np.float64)
                    ma_p = np.array(mf_entry.get("merged_anchor_zup") or [0.0, 0.0, 0.0], dtype=np.float64)
                    v_raw_twd = ma_p + (v_nat - na_p) @ R_p.T if np.linalg.norm(ma_p) > 1.0 else v_nat

                    fv_raw = f_nat[:, [0, 2, 4]] - 1
                    inside_m = cutter_eval._compute_inside_mask_for_triangles(
                        v_raw_twd[fv_raw[:, 0]], v_raw_twd[fv_raw[:, 1]], v_raw_twd[fv_raw[:, 2]], np.eye(4, dtype=np.float64)
                    )
                    cand_faces = np.where(inside_m)[0]
                    if len(cand_faces) > 0:
                        cents_ex = (v_ex_loc + off_m)[fv_ex].mean(axis=1)
                        tree_ex = cKDTree(cents_ex)
                        cents_cand = v_raw_twd[fv_raw[cand_faces]].mean(axis=1)
                        d_ex, _ = tree_ex.query(cents_cand, k=1)
                        other_cents_l = [c_arr for ci, c_arr in enumerate(all_cur_cents_list) if ci != p_idx and len(c_arr) > 0]
                        if other_cents_l:
                            other_cents = np.vstack(other_cents_l)
                            tree_other_xy = cKDTree(other_cents[:, :2])
                            d_oxy, idx_oxy = tree_other_xy.query(cents_cand[:, :2], k=1)
                            dz_other = np.abs(cents_cand[:, 2] - other_cents[idx_oxy, 2])
                            not_covered_by_other = (d_oxy > 0.30) | (dz_other > 1.5)
                            missing_loc = (d_ex > 0.015) & not_covered_by_other
                        else:
                            missing_loc = d_ex > 0.015

                        if int(missing_loc.sum()) > 0:
                            rest_idxs = cand_faces[missing_loc]
                            if connected_only:
                                c_min = cents_cand.min(axis=0) - 1.5
                                c_max = cents_cand.max(axis=0) + 1.5
                                all_c = v_raw_twd[fv_raw].mean(axis=1)
                                near_zone = np.where(
                                    (all_c[:, 0] >= c_min[0]) & (all_c[:, 0] <= c_max[0]) &
                                    (all_c[:, 1] >= c_min[1]) & (all_c[:, 1] <= c_max[1])
                                )[0]
                                d_nz, _ = tree_ex.query(all_c[near_zone], k=1)
                                seed_present = d_nz <= 0.025
                                allowed_set = set(rest_idxs.tolist())
                                vq_r = np.round(v_raw_twd * 1000.0).astype(np.int64)
                                _, _, wid_r = np.unique(vq_r, axis=0, return_index=True, return_inverse=True)
                                v2f_nz: Dict[int, List[int]] = {}
                                for li_z, fi_z in enumerate(near_zone):
                                    if seed_present[li_z] or (int(fi_z) in allowed_set):
                                        for vi_z in fv_raw[fi_z]:
                                            v2f_nz.setdefault(int(wid_r[vi_z]), []).append(li_z)
                                vis_nz = np.zeros(len(near_zone), dtype=bool)
                                q_bfs = deque()
                                for li_s in np.where(seed_present)[0]:
                                    vis_nz[li_s] = True
                                    q_bfs.append(int(li_s))
                                while q_bfs:
                                    cli = q_bfs.popleft()
                                    for vi_z in fv_raw[near_zone[cli]]:
                                        for nli in v2f_nz.get(int(wid_r[vi_z]), ()):
                                            if not vis_nz[nli]:
                                                vis_nz[nli] = True
                                                q_bfs.append(nli)
                                conn_faces = [int(near_zone[li_z]) for li_z in np.where(vis_nz & (~seed_present))[0] if int(near_zone[li_z]) in allowed_set]
                                rest_idxs = np.array(conn_faces, dtype=np.int64)

                            if len(rest_idxs) > 0:
                                new_rest_cents = v_raw_twd[fv_raw[rest_idxs]].mean(axis=1)
                                if p_idx < len(all_cur_cents_list):
                                    all_cur_cents_list[p_idx] = np.vstack([all_cur_cents_list[p_idx], new_rest_cents])
                                else:
                                    all_cur_cents_list.append(new_rest_cents)
                                f_r = f_nat[rest_idxs]
                                u_vr, inv_vr = np.unique(f_r[:, [0, 2, 4]] - 1, return_inverse=True)
                                u_vtr, inv_vtr = np.unique(f_r[:, [1, 3, 5]] - 1, return_inverse=True)
                                v_comb = np.vstack([v_ex_loc, v_raw_twd[u_vr] - off_m])
                                vt_comb = np.vstack([vt_ex, vt_nat[u_vtr]]).astype(np.float32)
                                fv_comb = np.vstack([fv_ex, inv_vr.reshape(-1, 3) + len(v_ex_loc)])
                                fvt_comb = np.vstack([fvt_ex, inv_vtr.reshape(-1, 3) + len(vt_ex)])
                                vq_c = np.round((v_comb + off_m) * 2000.0).astype(np.int64)
                                _, u_w, inv_w = np.unique(vq_c, axis=0, return_index=True, return_inverse=True)
                                v_ex_loc = v_comb[u_w]
                                vt_ex = vt_comb
                                fv_ex = inv_w[fv_comb]
                                fvt_ex = fvt_comb
                                total_restored += len(rest_idxs)

                                # Rebuild tile_s{p_idx}.glb
                                f_loc_1b = np.column_stack([
                                    fv_ex[:, 0] + 1, fvt_ex[:, 0] + 1,
                                    fv_ex[:, 1] + 1, fvt_ex[:, 1] + 1,
                                    fv_ex[:, 2] + 1, fvt_ex[:, 2] + 1,
                                ])
                                tmp_m = os.path.join(obj_dir, f"_rst_{p_idx}.mtl")
                                tmp_o = os.path.join(obj_dir, f"_rst_{p_idx}.obj")
                                tile_out = os.path.join(tiles_dir, f"tile_s{p_idx}.glb")
                                tmp_g = tile_out + ".tmp.glb"
                                try:
                                    with open(tmp_m, "w", encoding="utf-8") as mf_t:
                                        mf_t.write(f"newmtl {mtl_nm}\nKd 1.0 1.0 1.0\nillum 0\nmap_Kd {mtl_nm}.jpg\n")
                                    with open(tmp_o, "wb") as of_t:
                                        of_t.write(f"mtllib _rst_{p_idx}.mtl\nusemtl {mtl_nm}\n".encode("utf-8"))
                                        np.savetxt(of_t, v_ex_loc.astype(np.float32), fmt="v %.4f %.4f %.4f")
                                        np.savetxt(of_t, vt_ex.astype(np.float32), fmt="vt %.6f %.6f")
                                        np.savetxt(of_t, f_loc_1b, fmt="f %d/%d %d/%d %d/%d")
                                    subprocess.run(
                                        [GLTFPACK_EXE, "-i", tmp_o, "-o", tmp_g, "-vp", "16", "-vt", "16", "-vn", "8", "-cc"],
                                        capture_output=True,
                                        check=True,
                                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0,
                                    )
                                    jpg_disk = os.path.join(obj_dir, f"{mtl_nm}.jpg")
                                    raw_jb_use = open(jpg_disk, "rb").read() if os.path.isfile(jpg_disk) else jb_nat
                                    rb_new = replace_glb_single_image_bytes(open(tmp_g, "rb").read(), raw_jb_use, "image/jpeg")
                                    with open(tile_out, "wb") as wf_t:
                                        wf_t.write(shift_glb_node_translation(rb_new, ox_m, oy_m, oz_m))
                                finally:
                                    for prm in (tmp_m, tmp_o, tmp_g):
                                        if os.path.isfile(prm):
                                            os.remove(prm)

                                p_vmin = v_ex_loc.min(axis=0) + off_m
                                p_vmax = v_ex_loc.max(axis=0) + off_m
                                p_bc, p_bh = (p_vmin + p_vmax) * 0.5, (p_vmax - p_vmin) * 0.5
                                if p_idx < len(ts_dict.get("root", {}).get("children") or []):
                                    ts_dict["root"]["children"][p_idx]["boundingVolume"]["box"] = [
                                        round(float(p_bc[0]), 4), round(float(p_bc[1]), 4), round(float(p_bc[2]), 4),
                                        round(max(float(p_bh[0]), 0.5), 4), 0.0, 0.0,
                                        0.0, round(max(float(p_bh[1]), 0.5), 4), 0.0,
                                        0.0, 0.0, round(max(float(p_bh[2]), 0.5), 4),
                                    ]

                f_part_1b = np.column_stack([
                    fv_ex[:, 0] + 1, fvt_ex[:, 0] + 1,
                    fv_ex[:, 1] + 1, fvt_ex[:, 1] + 1,
                    fv_ex[:, 2] + 1, fvt_ex[:, 2] + 1,
                ])
                updated_parts.append((mtl_nm, v_ex_loc.astype(np.float32), vt_ex.astype(np.float32), f_part_1b))

            if total_restored == 0:
                raise ValueError("No missing original triangles were found inside your marked Lasso / Polygon area.")

            # Save updated multi-material mesh.obj & tileset.json
            v_all_l, vt_all_l, f_blks_out = [], [], []
            vo, vto = 0, 0
            for m_nm, vc, vtc, fl1 in updated_parts:
                fg = fl1.copy()
                fg[:, [0, 2, 4]] += vo
                fg[:, [1, 3, 5]] += vto
                v_all_l.append(vc)
                vt_all_l.append(vtc)
                f_blks_out.append((m_nm, fg))
                vo += len(vc)
                vto += len(vtc)
            v_tot = np.vstack(v_all_l)
            vt_tot = np.vstack(vt_all_l)
            with open(cur_obj_p, "wb") as obj_f:
                obj_f.write(b"mtllib mesh.mtl\n")
                np.savetxt(obj_f, v_tot, fmt="v %.4f %.4f %.4f")
                np.savetxt(obj_f, vt_tot, fmt="vt %.6f %.6f")
                for m_nm, fg in f_blks_out:
                    obj_f.write(f"usemtl {m_nm}\n".encode("utf-8"))
                    np.savetxt(obj_f, fg, fmt="f %d/%d %d/%d %d/%d")

            r_vmin = v_tot.min(axis=0).astype(np.float64) + off_m
            r_vmax = v_tot.max(axis=0).astype(np.float64) + off_m
            r_bc, r_bh = (r_vmin + r_vmax) * 0.5, (r_vmax - r_vmin) * 0.5
            ts_dict["root"]["boundingVolume"]["box"] = [
                round(float(r_bc[0]), 4), round(float(r_bc[1]), 4), round(float(r_bc[2]), 4),
                round(max(float(r_bh[0]), 0.5), 4), 0.0, 0.0,
                0.0, round(max(float(r_bh[1]), 0.5), 4), 0.0,
                0.0, 0.0, round(max(float(r_bh[2]), 0.5), 4),
            ]
            json.dump(ts_dict, open(ts_path, "w", encoding="utf-8"), indent=2)

        # Case 2: Edited Single Scan or Multi-Gen Edited Scan -> append lightweight zero-loss ADD patch tile(s)
        else:
            src_specs: List[Dict[str, Any]] = []
            if mf_list:
                for mf_e in mf_list:
                    if isinstance(mf_e, dict):
                        src_specs.append(mf_e)
            else:
                deriv_sid = str(scan.get("derived_from_scan_id") or "").strip()
                if deriv_sid:
                    src_specs.append({"scan_id": deriv_sid})

            if not src_specs:
                raise ValueError("This scan has no raw original source scan (`derived_from_scan_id` / `merged_from`) to restore missing triangles from.")

            # Collect existing triangle centroids from leaf .glb tiles to avoid duplicating existing faces
            ex_cents_list: List[np.ndarray] = []
            try:
                import trimesh
                ts_cur_j = json.load(open(ts_path, encoding="utf-8"))
                gltf_up = str((ts_cur_j.get("asset") or {}).get("gltfUpAxis") or "").upper().strip()
                leaf_glbs: List[Tuple[str, np.ndarray]] = []

                def _gather_leaves(nd: Dict[str, Any], p_tf: np.ndarray):
                    c_tf = p_tf
                    ntf = nd.get("transform")
                    if isinstance(ntf, list) and len(ntf) == 16:
                        c_tf = p_tf @ np.array(ntf, dtype=np.float64).reshape((4, 4), order="F")
                    chs = [c for c in (nd.get("children") or []) if isinstance(c, dict)]
                    if chs:
                        for ch in chs:
                            _gather_leaves(ch, c_tf)
                    else:
                        uri_c = ((nd.get("content") or {}).get("uri") or "").split("?")[0]
                        if uri_c and "{level}" not in uri_c:
                            gp = os.path.normpath(os.path.join(ts_dir, uri_c))
                            if os.path.isfile(gp):
                                leaf_glbs.append((gp, c_tf))

                if isinstance(ts_cur_j.get("root"), dict):
                    _gather_leaves(ts_cur_j["root"], np.eye(4, dtype=np.float64))

                tmp_dec_dir = os.path.join(proj_dir, "_tmp_dec_ex")
                os.makedirs(tmp_dec_dir, exist_ok=True)
                try:
                    for gi, (gp, gtf) in enumerate(leaf_glbs):
                        dec_p = os.path.join(tmp_dec_dir, f"d_{gi}.glb")
                        r_dec = subprocess.run(
                            [GLTFPACK_EXE, "-i", gp, "-o", dec_p, "-noq"],
                            capture_output=True,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0,
                        )
                        load_p = dec_p if (r_dec.returncode == 0 and os.path.isfile(dec_p)) else gp
                        sc_tm = trimesh.load(load_p, force="scene")
                        for geom_nm, geom in sc_tm.geometry.items():
                            if not hasattr(geom, "vertices") or len(geom.faces) == 0:
                                continue
                            nd_tfs = [sc_tm.graph.get(n)[0] for n in sc_tm.graph.nodes_geometry if sc_tm.graph.get(n)[1] == geom_nm]
                            m_tf = nd_tfs[0] if nd_tfs else np.eye(4, dtype=np.float64)
                            vh = np.hstack([np.asarray(geom.vertices, dtype=np.float64), np.ones((len(geom.vertices), 1), dtype=np.float64)])
                            vw = (vh @ m_tf.T)
                            if gltf_up != "Z":
                                # glTF Y-up -> Z-up before applying tileset transform
                                vw_z = np.column_stack([vw[:, 0], -vw[:, 2], vw[:, 1], vw[:, 3]])
                            else:
                                vw_z = vw
                            vz = (vw_z @ gtf.T)[:, :3]
                            ex_cents_list.append(vz[np.asarray(geom.faces)].mean(axis=1))
                finally:
                    shutil.rmtree(tmp_dec_dir, ignore_errors=True)
            except Exception as ex_e:
                print(f"[OptimizerBridge] Existing centroid scan note: {ex_e}")

            tree_ex_all = cKDTree(np.vstack(ex_cents_list)) if ex_cents_list else None
            patch_nodes: List[Dict[str, Any]] = []
            os.makedirs(tiles_dir, exist_ok=True)

            for s_idx, sp_e in enumerate(src_specs):
                raw_loaded_s = _load_raw_obj_source(str(sp_e.get("derived_from_scan_id") or "")) or _load_raw_obj_source(str(sp_e.get("scan_id") or ""))
                if raw_loaded_s is None:
                    # Fallback for 9-Level Native Octree scans without mesh.obj: restore directly from tileset_backup or parent scan leaf .glb tiles
                    cand_bkp_dirs = [
                        os.path.join(proj_dir, "tileset_backup"),
                        os.path.join(proj_dir, "tileset_prev"),
                    ]
                    p_sid = str(sp_e.get("derived_from_scan_id") or scan.get("derived_from_scan_id") or "").strip()
                    if not p_sid and "daan" in scan_id.lower():
                        p_sid = "catch_DaAn"
                    if p_sid:
                        cand_bkp_dirs.append(os.path.join(LOCAL_SCANS_ROOT, p_sid, "tileset"))
                    bkp_ts_dir = next((d for d in cand_bkp_dirs if os.path.isfile(os.path.join(d, "tileset.json"))), "")
                    if bkp_ts_dir:
                        try:
                            from optimizer.geometry_optimizer import extract_glb_64bit_origin_to_local
                            bkp_ts_j = json.load(open(os.path.join(bkp_ts_dir, "tileset.json"), encoding="utf-8"))
                            bkp_leaves: List[str] = []

                            def _walk_bkp_leaves(nd_b: Dict[str, Any]):
                                chs_b = [c for c in (nd_b.get("children") or []) if isinstance(c, dict)]
                                if chs_b:
                                    for ch_b in chs_b:
                                        _walk_bkp_leaves(ch_b)
                                else:
                                    u_b = ((nd_b.get("content") or {}).get("uri") or "").split("?")[0]
                                    if u_b:
                                        fp_b = os.path.normpath(os.path.join(bkp_ts_dir, u_b))
                                        if os.path.isfile(fp_b):
                                            bkp_leaves.append(fp_b)

                            if isinstance(bkp_ts_j.get("root"), dict):
                                _walk_bkp_leaves(bkp_ts_j["root"])
                            for bi, b_gp in enumerate(bkp_leaves):
                                with open(b_gp, "rb") as _rf_b:
                                    loc_b, orig_b = extract_glb_64bit_origin_to_local(_rf_b.read())
                                tmp_bin_p = os.path.join(proj_dir, f"_tmp_bkp_in_{bi}.glb")
                                tmp_bout_p = os.path.join(proj_dir, f"_tmp_bkp_out_{bi}.glb")
                                try:
                                    with open(tmp_bin_p, "wb") as _wf_b:
                                        _wf_b.write(loc_b)
                                    subprocess.run([GLTFPACK_EXE, "-i", tmp_bin_p, "-o", tmp_bout_p, "-noq"], capture_output=True, timeout=30)
                                    if os.path.isfile(tmp_bout_p) and os.path.getsize(tmp_bout_p) > 28:
                                        with open(tmp_bout_p, "rb") as _rfo_b:
                                            loc_b = _rfo_b.read()
                                finally:
                                    for _rm_b in (tmp_bin_p, tmp_bout_p):
                                        if os.path.isfile(_rm_b):
                                            try:
                                                os.remove(_rm_b)
                                            except OSError:
                                                pass
                                j_len_b, _ = struct.unpack_from("<I4s", loc_b, 12)
                                b_off_b = 20 + j_len_b
                                b_len_b, _ = struct.unpack_from("<I4s", loc_b, b_off_b)
                                j_b = json.loads(loc_b[20 : 20 + j_len_b].decode("utf-8"))
                                blob_b = memoryview(loc_b)[b_off_b + 8 : b_off_b + 8 + b_len_b]
                                accs_b = j_b.get("accessors") or []
                                bvs_b = j_b.get("bufferViews") or []
                                imgs_b = j_b.get("images") or []
                                mats_b = j_b.get("materials") or []
                                prims_b = ((j_b.get("meshes") or [{}])[0]).get("primitives") or []
                                if not prims_b or not imgs_b or "bufferView" not in imgs_b[0]:
                                    continue
                                pr_b = prims_b[0]
                                at_b = pr_b.get("attributes") or {}
                                if "POSITION" not in at_b or "TEXCOORD_0" not in at_b or "indices" not in pr_b:
                                    continue
                                p_acc_b = accs_b[at_b["POSITION"]]
                                if p_acc_b.get("componentType") != 5126:
                                    continue
                                cnt_b = int(p_acc_b["count"])
                                p_bv_b = bvs_b[p_acc_b["bufferView"]]
                                p_off_b = int(p_bv_b.get("byteOffset", 0)) + int(p_acc_b.get("byteOffset", 0))
                                v_b_twd = np.frombuffer(blob_b, dtype=np.float32, count=cnt_b * 3, offset=p_off_b).reshape(-1, 3).astype(np.float64) + np.array(orig_b, dtype=np.float64)
                                i_acc_b = accs_b[pr_b["indices"]]
                                i_bv_b = bvs_b[i_acc_b["bufferView"]]
                                i_off_b = int(i_bv_b.get("byteOffset", 0)) + int(i_acc_b.get("byteOffset", 0))
                                idtype_b = np.uint32 if i_acc_b.get("componentType") == 5125 else np.uint16
                                fv_b = np.frombuffer(blob_b, dtype=idtype_b, count=int(i_acc_b["count"]), offset=i_off_b).astype(np.int64).reshape(-1, 3)
                                in_b = cutter_eval._compute_inside_mask_for_triangles(v_b_twd[fv_b[:, 0]], v_b_twd[fv_b[:, 1]], v_b_twd[fv_b[:, 2]], np.eye(4, dtype=np.float64))
                                cand_b = np.where(in_b)[0]
                                if len(cand_b) == 0:
                                    continue
                                if tree_ex_all is not None:
                                    d_ex_b, _ = tree_ex_all.query(v_b_twd[fv_b[cand_b]].mean(axis=1), k=1)
                                    cand_b = cand_b[d_ex_b > 0.015]
                                if len(cand_b) == 0:
                                    continue
                                u_acc_b = accs_b[at_b["TEXCOORD_0"]]
                                u_bv_b = bvs_b[u_acc_b["bufferView"]]
                                u_off_b = int(u_bv_b.get("byteOffset", 0)) + int(u_acc_b.get("byteOffset", 0))
                                vt_b = np.frombuffer(blob_b, dtype=np.float32, count=cnt_b * 2, offset=u_off_b).reshape(-1, 2).copy()
                                if mats_b:
                                    bct_b = ((mats_b[0].get("pbrMetallicRoughness") or {}).get("baseColorTexture") or {})
                                    khr_b = (bct_b.get("extensions") or {}).get("KHR_texture_transform")
                                    if isinstance(khr_b, dict):
                                        sc_b = khr_b.get("scale") or [1.0, 1.0]
                                        of_b = khr_b.get("offset") or [0.0, 0.0]
                                        vt_b[:, 0] = vt_b[:, 0] * float(sc_b[0]) + float(of_b[0])
                                        vt_b[:, 1] = vt_b[:, 1] * float(sc_b[1]) + float(of_b[1])
                                vt_b[:, 1] = 1.0 - vt_b[:, 1]
                                im_bv_b = bvs_b[imgs_b[0]["bufferView"]]
                                jb_b = bytes(blob_b[int(im_bv_b.get("byteOffset", 0)) : int(im_bv_b.get("byteOffset", 0)) + int(im_bv_b["byteLength"])])
                                total_restored += len(cand_b)
                                f_sel_b = fv_b[cand_b]
                                u_vb, inv_vb = np.unique(f_sel_b, return_inverse=True)
                                vp_twd_b = v_b_twd[u_vb]
                                off_pb = np.round(vp_twd_b.mean(axis=0))
                                vp_loc_b = (vp_twd_b - off_pb).astype(np.float32)
                                vtp_b = vt_b[u_vb].astype(np.float32)
                                iv_b = inv_vb.reshape(-1, 3) + 1
                                fl_b = np.column_stack([iv_b[:, 0], iv_b[:, 0], iv_b[:, 1], iv_b[:, 1], iv_b[:, 2], iv_b[:, 2]])
                                patch_fn_b = f"tile_s_patch_{s_idx}_{bi}_{int(time.time() * 1000) % 1000000}.glb"
                                patch_rel_b = f"tiles/{patch_fn_b}"
                                patch_out_b = os.path.join(tiles_dir, patch_fn_b)
                                tmp_dir_pb = os.path.join(proj_dir, f"_tmp_patch_{s_idx}_{bi}")
                                os.makedirs(tmp_dir_pb, exist_ok=True)
                                try:
                                    with open(os.path.join(tmp_dir_pb, "mesh_0.jpg"), "wb") as _jf_b:
                                        _jf_b.write(jb_b)
                                    with open(os.path.join(tmp_dir_pb, "p.mtl"), "w", encoding="utf-8") as mf_pb:
                                        mf_pb.write("newmtl m0\nKd 1.0 1.0 1.0\nillum 0\nmap_Kd mesh_0.jpg\n")
                                    with open(os.path.join(tmp_dir_pb, "p.obj"), "wb") as of_pb:
                                        of_pb.write(b"mtllib p.mtl\nusemtl m0\n")
                                        np.savetxt(of_pb, vp_loc_b, fmt="v %.4f %.4f %.4f")
                                        np.savetxt(of_pb, vtp_b, fmt="vt %.6f %.6f")
                                        np.savetxt(of_pb, fl_b, fmt="f %d/%d %d/%d %d/%d")
                                    tmp_gpb = os.path.join(tmp_dir_pb, "p.glb")
                                    subprocess.run([GLTFPACK_EXE, "-i", os.path.join(tmp_dir_pb, "p.obj"), "-o", tmp_gpb, "-vp", "16", "-vt", "16", "-vn", "8", "-cc"], capture_output=True, check=True)
                                    rb_pb = replace_glb_single_image_bytes(open(tmp_gpb, "rb").read(), jb_b, "image/jpeg")
                                    with open(patch_out_b, "wb") as wf_pb:
                                        wf_pb.write(shift_glb_node_translation(rb_pb, float(off_pb[0]), float(off_pb[1]), float(off_pb[2])))
                                finally:
                                    shutil.rmtree(tmp_dir_pb, ignore_errors=True)
                                p_vmin_b, p_vmax_b = vp_twd_b.min(axis=0), vp_twd_b.max(axis=0)
                                p_bc_b, p_bh_b = (p_vmin_b + p_vmax_b) * 0.5, (p_vmax_b - p_vmin_b) * 0.5
                                patch_nodes.append({
                                    "boundingVolume": {"box": [round(float(p_bc_b[0]), 4), round(float(p_bc_b[1]), 4), round(float(p_bc_b[2]), 4), round(max(float(p_bh_b[0]), 0.5), 4), 0.0, 0.0, 0.0, round(max(float(p_bh_b[1]), 0.5), 4), 0.0, 0.0, 0.0, round(max(float(p_bh_b[2]), 0.5), 4)]},
                                    "geometricError": 0.0,
                                    "refine": "ADD",
                                    "content": {"uri": patch_rel_b},
                                    "children": [],
                                })
                        except Exception as bkp_rest_err:
                            print(f"[OptimizerBridge] GLB backup region restore note: {bkp_rest_err}")
                    continue
                v_nat, vt_nat, f_nat, jb_nat, src_jpg_path = raw_loaded_s
                if isinstance(sp_e.get("r_zup_rowmajor"), list) and len(sp_e["r_zup_rowmajor"]) == 9:
                    R_s = np.array(sp_e["r_zup_rowmajor"], dtype=np.float64).reshape(3, 3)
                else:
                    R_s = np.eye(3, dtype=np.float64)
                na_s = np.array(sp_e.get("native_anchor_zup") or [0.0, 0.0, 0.0], dtype=np.float64)
                ma_s = np.array(sp_e.get("merged_anchor_zup") or [0.0, 0.0, 0.0], dtype=np.float64)
                v_s_twd = ma_s + (v_nat - na_s) @ R_s.T if np.linalg.norm(ma_s) > 1.0 else v_nat

                fv_raw = f_nat[:, [0, 2, 4]] - 1
                inside_m = cutter_eval._compute_inside_mask_for_triangles(
                    v_s_twd[fv_raw[:, 0]], v_s_twd[fv_raw[:, 1]], v_s_twd[fv_raw[:, 2]], np.eye(4, dtype=np.float64)
                )
                cand_faces = np.where(inside_m)[0]
                if len(cand_faces) == 0:
                    continue
                if tree_ex_all is not None:
                    d_ex_s, _ = tree_ex_all.query(v_s_twd[fv_raw[cand_faces]].mean(axis=1), k=1)
                    cand_faces = cand_faces[d_ex_s > 0.015]
                if len(cand_faces) == 0:
                    continue

                total_restored += len(cand_faces)
                f_r = f_nat[cand_faces]
                u_vr, inv_vr = np.unique(f_r[:, [0, 2, 4]] - 1, return_inverse=True)
                u_vtr, inv_vtr = np.unique(f_r[:, [1, 3, 5]] - 1, return_inverse=True)
                vp_twd = v_s_twd[u_vr]
                off_p = np.round(vp_twd.mean(axis=0))
                vp_loc = (vp_twd - off_p).astype(np.float32)
                vtp = vt_nat[u_vtr].astype(np.float32)
                iv2 = inv_vr.reshape(-1, 3) + 1
                ivt2 = inv_vtr.reshape(-1, 3) + 1
                fl_1b = np.column_stack([iv2[:, 0], ivt2[:, 0], iv2[:, 1], ivt2[:, 1], iv2[:, 2], ivt2[:, 2]])

                patch_fn = f"tile_s_patch_{s_idx}_{int(time.time() * 1000) % 1000000}.glb"
                patch_rel = f"tiles/{patch_fn}"
                patch_out = os.path.join(tiles_dir, patch_fn)
                tmp_dir_p = os.path.join(proj_dir, f"_tmp_patch_{s_idx}")
                os.makedirs(tmp_dir_p, exist_ok=True)
                try:
                    shutil.copyfile(src_jpg_path, os.path.join(tmp_dir_p, "mesh_0.jpg"))
                    with open(os.path.join(tmp_dir_p, "p.mtl"), "w", encoding="utf-8") as mf_p:
                        mf_p.write("newmtl m0\nKd 1.0 1.0 1.0\nillum 0\nmap_Kd mesh_0.jpg\n")
                    with open(os.path.join(tmp_dir_p, "p.obj"), "wb") as of_p:
                        of_p.write(b"mtllib p.mtl\nusemtl m0\n")
                        np.savetxt(of_p, vp_loc, fmt="v %.4f %.4f %.4f")
                        np.savetxt(of_p, vtp, fmt="vt %.6f %.6f")
                        np.savetxt(of_p, fl_1b, fmt="f %d/%d %d/%d %d/%d")
                    tmp_gp = os.path.join(tmp_dir_p, "p.glb")
                    subprocess.run(
                        [GLTFPACK_EXE, "-i", os.path.join(tmp_dir_p, "p.obj"), "-o", tmp_gp, "-vp", "16", "-vt", "16", "-vn", "8", "-cc"],
                        capture_output=True,
                        check=True,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0,
                    )
                    rb_p = replace_glb_single_image_bytes(open(tmp_gp, "rb").read(), jb_nat, "image/jpeg")
                    with open(patch_out, "wb") as wf_p:
                        wf_p.write(shift_glb_node_translation(rb_p, float(off_p[0]), float(off_p[1]), float(off_p[2])))
                finally:
                    shutil.rmtree(tmp_dir_p, ignore_errors=True)

                p_vmin, p_vmax = vp_twd.min(axis=0), vp_twd.max(axis=0)
                p_bc, p_bh = (p_vmin + p_vmax) * 0.5, (p_vmax - p_vmin) * 0.5
                patch_nodes.append({
                    "boundingVolume": {
                        "box": [
                            round(float(p_bc[0]), 4), round(float(p_bc[1]), 4), round(float(p_bc[2]), 4),
                            round(max(float(p_bh[0]), 0.5), 4), 0.0, 0.0,
                            0.0, round(max(float(p_bh[1]), 0.5), 4), 0.0,
                            0.0, 0.0, round(max(float(p_bh[2]), 0.5), 4),
                        ]
                    },
                    "geometricError": 0.0,
                    "refine": "ADD",
                    "content": {"uri": patch_rel},
                    "children": [],
                })

            if total_restored == 0 or not patch_nodes:
                raise ValueError("No missing original triangles were found inside your marked Lasso / Polygon area.")

            ts_dict = json.load(open(ts_path, encoding="utf-8"))
            old_root = copy.deepcopy(ts_dict.get("root") or {})
            if str(old_root.get("refine") or "").upper() == "ADD" and not old_root.get("content"):
                old_root.setdefault("children", []).extend(patch_nodes)
                ts_dict["root"] = old_root
            else:
                ts_dict["root"] = {
                    "boundingVolume": copy.deepcopy(old_root.get("boundingVolume") or patch_nodes[0]["boundingVolume"]),
                    "geometricError": max(float(old_root.get("geometricError") or 500.0), 500.0),
                    "refine": "ADD",
                    "children": [old_root, *patch_nodes],
                }
            json.dump(ts_dict, open(ts_path, "w", encoding="utf-8"), indent=2)

        ensure_scan_low_quality_preview(ts_path, force=True)
        ensure_scan_full_quality_thumbnail(ts_path, scan_id, project_dir=proj_dir, force=True)

        now_ts = time.time()
        scan_upd = dict(scan)
        scan_upd["tileset_version"] = int(now_ts * 1000)
        scan_upd["uploaded_at"] = now_ts
        scan_upd["size_bytes"] = sum(os.path.getsize(os.path.join(rd, fn)) for rd, _, rfs in os.walk(proj_dir) for fn in rfs)
        adj_l = list(scan_upd.get("applied_adjustments") or [])
        adj_l.append(f"Restored {total_restored:,} tris from original")
        scan_upd["applied_adjustments"] = adj_l
        meta_p = os.path.join(proj_dir, "scan_meta.json")
        json.dump(scan_upd, open(meta_p, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
        saved_scan = self.db.upsert_scan(scan_upd)

        def _bg_sync_restored():
            try:
                from pc_worker.gdrive_cloud_sync import build_scan_3tz_package, sync_all_scans_to_gdrive_and_vps
                build_scan_3tz_package({"scan_id": scan_id, "tileset_path": ts_path, "project_dir": proj_dir}, force=True)
                sync_all_scans_to_gdrive_and_vps(self.db, None, force=False)
            except Exception as ce:
                print(f"[OptimizerBridge] Background .3tz sync note after restore-region on {scan_id}: {ce}")

        threading.Thread(target=_bg_sync_restored, daemon=True).start()

        return {
            "status": "ok",
            "action": "restore_region",
            "scan_id": scan_id,
            "scan": saved_scan,
            "restored_triangles": total_restored,
            "duration_s": round(time.time() - t0, 2),
        }
