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
        twvd_h0 = float(c_src[2]) - float(sdef["h_offset_from_twvd"])
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
            h_dst = twvd_h0 + float(tdef["h_offset_from_twvd"])
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
                    if im.mode not in ("RGB", "L"):
                        im = im.convert("RGB")
                    if max(im.size) > tex_limit or len(chunk) > 250_000:
                        im.thumbnail((tex_limit, tex_limit), Image.Resampling.LANCZOS)
                        out_io = io.BytesIO()
                        im.save(out_io, format="JPEG", quality=jpeg_quality, optimize=True)
                        new_chunk = out_io.getvalue()
                        if len(new_chunk) < len(chunk):
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

            vis_only = bool(st.get("visible_only", True))
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
        min_elev = float(payload.get("min_elev", -9999.0))
        max_elev = float(payload.get("max_elev", 9999.0))
        mode = str(payload.get("mode", "keep_inside")).lower().strip()
        if mode not in ("keep_inside", "delete_inside"):
            mode = "keep_inside"

        if not frustum_strokes and len(raw_native_poly) < 3 and len(raw_polygon) < 3:
            raise ValueError("Lasso / Polygon crop requires either frustum_strokes or a polygon with at least 3 vertices.")

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
                    ts_cx, ts_cy, ts_cz = float(box[0]), float(box[1]), float(box[2])
            except Exception:
                pass

        scan_e = float(scan.get("twd97_e") or 0.0)
        scan_n = float(scan.get("twd97_n") or 0.0)
        scan_h = float(scan.get("twd97_h") or 0.0)

        native_poly: List[List[float]] = []
        twd_poly: List[List[float]] = []

        if len(raw_native_poly) >= 3:
            for pt in raw_native_poly:
                nx, ny = float(pt[0]), float(pt[1])
                native_poly.append([nx, ny])
                twd_poly.append([nx, ny])
        elif len(raw_polygon) >= 3:
            for pt in raw_polygon:
                px, py = float(pt[0]), float(pt[1])
                if abs(px) > 10000.0 and abs(py) > 100000.0:
                    dx = px - scan_e
                    dn = py - scan_n
                    twd_poly.append([px, py])
                else:
                    dx = px
                    dn = py
                    twd_poly.append([scan_e + dx, scan_n + dn])
                native_poly.append([ts_cx + dx, ts_cy + dn])

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
        crs_off_x = float(crs_cfg.get("offset_x") or 0.0)
        crs_off_y = float(crs_cfg.get("offset_y") or 0.0)
        crs_off_z = float(crs_cfg.get("offset_z") or 0.0)
        has_crs = bool(
            (target_crs_code and target_crs_code in CRS_DEFINITIONS)
            or abs(crs_off_x) > 1e-6
            or abs(crs_off_y) > 1e-6
            or abs(crs_off_z) > 1e-6
        )

        # Reference Z-up center (TWD97 Easting, Northing, TWVD2001 Elevation)
        ref_c = payload.get("ref_center_zup")
        if isinstance(ref_c, list) and len(ref_c) >= 3:
            c_ref = np.array([float(ref_c[0]), float(ref_c[1]), float(ref_c[2])], dtype=np.float64)
        else:
            c_ref = np.array(
                [
                    float(primary_scan["twd97_e"]) if primary_scan.get("twd97_e") is not None else 0.0,
                    float(primary_scan["twd97_n"]) if primary_scan.get("twd97_n") is not None else 0.0,
                    float(primary_scan["twd97_h"]) if primary_scan.get("twd97_h") is not None else 0.0,
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
            num_scans = len(resolved_layers)
            grid_g = max(1, int(math.ceil(math.sqrt(num_scans))))
            atlas_dim = 4096
            cell_px = atlas_dim // grid_g
            atlas_img = Image.new("RGB", (atlas_dim, atlas_dim), (128, 128, 128))

            all_v: List[np.ndarray] = []
            all_vt: List[np.ndarray] = []
            all_f: List[np.ndarray] = []
            v_offset = 0
            vt_offset = 0
            total_images = 0
            total_deleted_faces = 0
            merged_from_meta: List[Dict[str, Any]] = []
            applied_steps: List[str] = [f"Aligned & merged {num_scans} scans"]

            for idx, (ly, sc) in enumerate(resolved_layers):
                sid = sc["scan_id"]
                total_images += int(sc.get("image_count") or 0)
                col = idx % grid_g
                row_uv = idx // grid_g
                row_pil = grid_g - 1 - row_uv

                # Locate .obj path (or convert primary / leaf .glb tiles if needed)
                obj_p = surveying_engine._resolve_scan_obj_path(sc) if surveying_engine else sc.get("obj_path")
                if not (obj_p and os.path.isfile(obj_p)):
                    cand_obj = os.path.join(sc.get("project_dir") or "", "exports", "obj_mesh", "mesh.obj")
                    if os.path.isfile(cand_obj):
                        obj_p = cand_obj

                v_arr = None
                vt_arr = None
                f_arr = None
                tex_im = None
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
                    r_glb_check = os.path.join(os.path.dirname(ts_p_check), "tiles", "root.glb")
                    if os.path.isfile(r_glb_check) and os.path.getmtime(r_glb_check) > os.path.getmtime(obj_p) + 60.0:
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
                    for jpg_cand in ("mesh_0.jpg", "texture.jpg", "mesh.jpg", "mesh_0.png"):
                        jp = os.path.join(obj_dir, jpg_cand)
                        if os.path.isfile(jp):
                            try:
                                tex_im = Image.open(jp).convert("RGB")
                                break
                            except Exception:
                                pass
                    if tex_im is None:
                        import glob as _glob
                        jpgs = _glob.glob(os.path.join(obj_dir, "*.jpg")) + _glob.glob(os.path.join(obj_dir, "*.png"))
                        if jpgs:
                            try:
                                tex_im = Image.open(jpgs[0]).convert("RGB")
                            except Exception:
                                pass

                    with open(obj_p, "r", encoding="utf-8", errors="ignore") as f_in:
                        lines = f_in.read().splitlines()
                    v_lines = [ln[2:] for ln in lines if ln.startswith("v ")]
                    vt_lines = [ln[3:] for ln in lines if ln.startswith("vt ")]
                    f_lines = [ln[2:] for ln in lines if ln.startswith("f ")]

                    if v_lines and f_lines:
                        v_arr = np.fromstring(" ".join(v_lines), sep=" ", dtype=np.float64).reshape(-1, 3)
                        # Reject obj_p if its world coords (e.g. local 0,0,0 or UTM 51N 351xxx) disagree with scan's TWD97 center!
                        if rc_vec_check is not None and float(np.max(np.abs(rc_vec_check))) >= 50000.0:
                            eff_v_mid = ((v_arr.min(axis=0) + v_arr.max(axis=0)) * 0.5) + (
                                obj_offset_xyz if obj_offset_xyz is not None else np.zeros(3, dtype=np.float64)
                            )
                            if float(np.linalg.norm(eff_v_mid[:2] - rc_vec_check[:2])) > 2000.0:
                                v_arr = None
                                tex_im = None
                                obj_offset_xyz = None
                        if v_arr is not None:
                            if vt_lines:
                                vt_arr = np.fromstring(" ".join(vt_lines), sep=" ", dtype=np.float64).reshape(-1, 2)
                            else:
                                vt_arr = np.zeros((len(v_arr), 2), dtype=np.float64)

                            sample_f = f_lines[0].strip().split()[0]
                            slash_cnt = sample_f.count("/")
                            if slash_cnt == 1:
                                f_arr = np.fromstring(" ".join(f_lines).replace("/", " "), sep=" ", dtype=np.int64).reshape(-1, 6)
                            elif slash_cnt >= 2:
                                raw_f = np.fromstring(" ".join(f_lines).replace("//", "/0/").replace("/", " "), sep=" ", dtype=np.int64).reshape(-1, 9)
                                f_arr = raw_f[:, [0, 1, 3, 4, 6, 7]]
                            else:
                                raw_f = np.fromstring(" ".join(f_lines), sep=" ", dtype=np.int64).reshape(-1, 3)
                                f_arr = np.column_stack([raw_f[:, 0], raw_f[:, 0], raw_f[:, 1], raw_f[:, 1], raw_f[:, 2], raw_f[:, 2]])

                if v_arr is None or f_arr is None:
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
                                        cand_p = os.path.normpath(os.path.join(ts_base_dir, c_uri))
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
                                # Implicit tiling fallback: use preview_tileset.json or content/*.glb
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
                    tile_chunks: List[Tuple[np.ndarray, np.ndarray, np.ndarray, Optional[Image.Image]]] = []
                    for g_idx, (gp, tile_tf) in enumerate(glb_entries):
                        load_p = gp
                        tmp_dec = None
                        scene_or_mesh = None
                        try:
                            scene_or_mesh = trimesh.load(load_p, process=False)
                            has_verts = (
                                (isinstance(scene_or_mesh, trimesh.Trimesh) and len(scene_or_mesh.vertices) > 0)
                                or (isinstance(scene_or_mesh, trimesh.Scene) and any(len(g.vertices) > 0 for g in scene_or_mesh.geometry.values() if hasattr(g, "vertices")))
                            )
                            if not has_verts:
                                raise ValueError("Empty or meshopt-compressed GLB")
                        except Exception:
                            if os.path.isfile(GLTFPACK_EXE):
                                tmp_dec = os.path.join(work_proj_dir, f"_dec_{idx}_{g_idx}.glb")
                                _sp.run(
                                    [GLTFPACK_EXE, "-i", gp, "-o", tmp_dec, "-noq"],
                                    capture_output=True,
                                    timeout=45,
                                    creationflags=getattr(_sp, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0,
                                )
                                if os.path.isfile(tmp_dec):
                                    scene_or_mesh = trimesh.load(tmp_dec, process=False)
                        finally:
                            if tmp_dec and os.path.isfile(tmp_dec):
                                try:
                                    os.remove(tmp_dec)
                                except OSError:
                                    pass
                        if scene_or_mesh is None:
                            continue

                        geom_items: List[Tuple[Any, np.ndarray]] = []
                        if isinstance(scene_or_mesh, trimesh.Scene):
                            for g_name, geom in scene_or_mesh.geometry.items():
                                if not isinstance(geom, trimesh.Trimesh) or len(geom.vertices) == 0 or len(geom.faces) == 0:
                                    continue
                                xf = np.eye(4, dtype=np.float64)
                                try:
                                    nodes_for_g = scene_or_mesh.graph.geometry_nodes.get(g_name, [])
                                    if nodes_for_g:
                                        xf, _ = scene_or_mesh.graph.get(nodes_for_g[0])
                                except Exception:
                                    pass
                                geom_items.append((geom, xf))
                        elif isinstance(scene_or_mesh, trimesh.Trimesh) and len(scene_or_mesh.vertices) > 0 and len(scene_or_mesh.faces) > 0:
                            geom_items.append((scene_or_mesh, np.eye(4, dtype=np.float64)))

                        for geom, xf in geom_items:
                            gv = np.asarray(geom.vertices, dtype=np.float64) @ xf[:3, :3].T + xf[:3, 3]
                            if apply_y_to_z:
                                gv = np.column_stack([gv[:, 0], -gv[:, 2], gv[:, 1]])
                            gv = gv @ tile_tf[:3, :3].T + tile_tf[:3, 3]
                            gf = np.asarray(geom.faces, dtype=np.int64)
                            guv = (
                                np.asarray(geom.visual.uv, dtype=np.float64).copy()
                                if (hasattr(geom.visual, "uv") and geom.visual.uv is not None and len(geom.visual.uv) == len(gv))
                                else np.zeros((len(gv), 2), dtype=np.float64)
                            )
                            g_img = None
                            if hasattr(geom.visual, "material") and geom.visual.material is not None:
                                mat_obj = geom.visual.material
                                raw_tex = getattr(mat_obj, "baseColorTexture", None)
                                if raw_tex is None:
                                    raw_tex = getattr(mat_obj, "image", None)
                                if raw_tex is not None:
                                    try:
                                        g_img = raw_tex.convert("RGB")
                                    except Exception:
                                        g_img = None
                            tile_chunks.append((gv, guv, gf, g_img))

                    if not tile_chunks:
                        raise ValueError(f"Empty 3D mesh loaded for scan: {sid}")

                    # Pack sub-tile textures into scan i's cell_px x cell_px image so multi-tile meshes retain crisp UVs
                    sub_vs, sub_vts, sub_fs = [], [], []
                    sub_v_off = 0
                    imgs_present = [tc[3] for tc in tile_chunks if tc[3] is not None]
                    shared_single_atlas = False
                    if len(imgs_present) > 1:
                        try:
                            ref_im = imgs_present[0]
                            w0, h0 = ref_im.size
                            pts_chk = [(w0 // 2, h0 // 2), (w0 // 4, h0 // 4), ((w0 * 3) // 4, (h0 * 3) // 4)]
                            ref_sig = (w0, h0, tuple(ref_im.getpixel(pt) for pt in pts_chk))
                            shared_single_atlas = all(
                                im.size == (w0, h0) and tuple(im.getpixel(pt) for pt in pts_chk) == ref_sig[2]
                                for im in imgs_present[1:]
                            )
                        except Exception:
                            shared_single_atlas = False
                    if len(tile_chunks) == 1 or len(imgs_present) <= 1 or shared_single_atlas:
                        tex_im = imgs_present[0] if imgs_present else None
                        for gv, guv, gf, _ in tile_chunks:
                            gf1 = gf + 1 + sub_v_off
                            sub_vs.append(gv)
                            sub_vts.append(guv)
                            sub_fs.append(np.column_stack([gf1[:, 0], gf1[:, 0], gf1[:, 1], gf1[:, 1], gf1[:, 2], gf1[:, 2]]))
                            sub_v_off += len(gv)
                    else:
                        sub_g = max(1, min(16, int(math.ceil(math.sqrt(len(tile_chunks))))))
                        sub_px = max(16, cell_px // sub_g)
                        tex_im = Image.new("RGB", (sub_g * sub_px, sub_g * sub_px), (200, 200, 200))
                        for c_i, (gv, guv, gf, g_img) in enumerate(tile_chunks):
                            slot = c_i % (sub_g * sub_g)
                            scol = slot % sub_g
                            srow_uv = slot // sub_g
                            srow_pil = sub_g - 1 - srow_uv
                            if g_img is not None:
                                tex_im.paste(g_img.resize((sub_px, sub_px), Image.Resampling.BILINEAR), (scol * sub_px, srow_pil * sub_px))
                            u_clamped = np.clip(guv[:, 0], 0.002, 0.998)
                            v_clamped = np.clip(guv[:, 1], 0.002, 0.998)
                            mapped_uv = np.column_stack([(scol + u_clamped) / sub_g, (srow_uv + v_clamped) / sub_g])
                            gf1 = gf + 1 + sub_v_off
                            sub_vs.append(gv)
                            sub_vts.append(mapped_uv)
                            sub_fs.append(np.column_stack([gf1[:, 0], gf1[:, 0], gf1[:, 1], gf1[:, 1], gf1[:, 2], gf1[:, 2]]))
                            sub_v_off += len(gv)

                    v_arr = np.vstack(sub_vs)
                    vt_arr = np.vstack(sub_vts)
                    f_arr = np.vstack(sub_fs)
                    obj_offset_xyz = None

                if tex_im is not None:
                    tile_im = tex_im.resize((cell_px, cell_px), Image.Resampling.LANCZOS)
                    atlas_img.paste(tile_im, (col * cell_px, row_pil * cell_px))

                # Center scan i's vertices in Three.js zUpGroup frame (`v_twd_native - raw_center_zup` when available, else bbox midpoint)
                raw_cz = ly.get("raw_center_zup")
                if isinstance(raw_cz, list) and len(raw_cz) >= 3:
                    rc_vec = np.array([float(raw_cz[0]), float(raw_cz[1]), float(raw_cz[2])], dtype=np.float64)
                    if obj_offset_xyz is not None and float(np.max(np.abs(v_arr))) < 50000.0 and float(np.max(np.abs(rc_vec))) >= 50000.0:
                        v_centered = (v_arr + obj_offset_xyz) - rc_vec
                    elif float(np.max(np.abs(v_arr))) >= 50000.0 and float(np.max(np.abs(rc_vec))) >= 50000.0:
                        v_centered = v_arr - rc_vec
                    else:
                        v_mid = (v_arr.min(axis=0) + v_arr.max(axis=0)) * 0.5
                        v_centered = v_arr - v_mid
                else:
                    v_mid = (v_arr.min(axis=0) + v_arr.max(axis=0)) * 0.5
                    v_centered = v_arr - v_mid

                # Apply Multi-Scan Lasso / Plan-Polygon Deletions if staged
                if raw_deletions and len(f_arr) > 0:
                    f_v0_idx = np.clip(f_arr[:, [0, 2, 4]] - 1, 0, len(v_centered) - 1)
                    del_mask = _eval_multiscan_layer_delete_mask(v_centered, f_v0_idx, sid, raw_deletions)
                    n_del = int(del_mask.sum())
                    if n_del > 0:
                        total_deleted_faces += n_del
                        f_arr = f_arr[~del_mask]

                if len(f_arr) == 0:
                    continue

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

                # Transform into unified TWD97 Z-up coordinates, then subtract merged_offset
                v_twd97 = c_ref + d_zup + (v_centered @ r_zup.T)
                v_local_merged = (v_twd97 - merged_offset).astype(np.float32)

                # Map UV into quadrant (col, row_uv) of the unified texture atlas
                vt_clipped = np.clip(vt_arr, 0.0, 1.0).astype(np.float32)
                vt_mapped = np.empty_like(vt_clipped)
                vt_mapped[:, 0] = (float(col) + vt_clipped[:, 0]) / float(grid_g)
                vt_mapped[:, 1] = (float(row_uv) + vt_clipped[:, 1]) / float(grid_g)

                f_shifted = f_arr.copy()
                f_shifted[:, [0, 2, 4]] += v_offset
                f_shifted[:, [1, 3, 5]] += vt_offset

                all_v.append(v_local_merged)
                all_vt.append(vt_mapped)
                all_f.append(f_shifted)
                v_offset += len(v_local_merged)
                vt_offset += len(vt_mapped)

                merged_from_meta.append(
                    {
                        "scan_id": sid,
                        "name": sc.get("name") or sid,
                        "position_three": [round(tx, 4), round(ty, 4), round(tz, 4)],
                        "quaternion_three": [round(float(x), 6) for x in quat_three[:4]],
                        "euler_deg_three": [round(rx_deg, 2), round(ry_deg, 2), round(rz_deg, 2)],
                    }
                )

            if not all_f:
                raise ValueError("Lasso deletions removed 100% of triangles across all combined scans. Undo or adjust your marked regions.")

            if total_deleted_faces > 0:
                applied_steps.append(f"Deleted {total_deleted_faces:,} triangles via Lasso")

            v_merged = np.vstack(all_v)
            vt_merged = np.vstack(all_vt)
            f_merged = np.vstack(all_f)

            # Save unified texture atlas, .mtl, offset.xyz, and .obj inside work_proj_dir
            atlas_path = os.path.join(obj_work_dir, "mesh_0.jpg")
            atlas_img.save(atlas_path, format="JPEG", quality=target_jpeg_q, optimize=True)

            mtl_path = os.path.join(obj_work_dir, "mesh.mtl")
            with open(mtl_path, "w", encoding="utf-8") as mf:
                mf.write("newmtl mesh_0\nKd 1.000000 1.000000 1.000000\nillum 0\nmap_Kd mesh_0.jpg\n")

            off_path = os.path.join(obj_work_dir, "offset.xyz")
            with open(off_path, "w", encoding="utf-8") as of:
                of.write(f"{ox_m:.3f} {oy_m:.3f} {oz_m:.3f}\n")

            obj_work_path = os.path.join(obj_work_dir, "mesh.obj")
            with open(obj_work_path, "wb") as obj_f:
                obj_f.write(b"mtllib mesh.mtl\nusemtl mesh_0\n")
                np.savetxt(obj_f, v_merged, fmt="v %.4f %.4f %.4f")
                np.savetxt(obj_f, vt_merged, fmt="vt %.5f %.5f")
                np.savetxt(obj_f, f_merged, fmt="f %d/%d %d/%d %d/%d")

            # Build fast 3D Tileset (tileset/tiles/root.glb + tileset/tileset.json) via gltfpack
            total_faces = len(f_merged)
            root_glb_work = os.path.join(tiles_work_dir, "root.glb")
            base_ratio = min(1.0, max(0.08, 360000.0 / float(max(total_faces, 1))))
            if has_comp:
                ratio_full = max(0.05, min(0.98, base_ratio * comp_mult_map[raw_preset]))
                applied_steps.append(f"Optimized ({raw_preset}, {target_tex_res}px)")
            else:
                ratio_full = base_ratio
            tmp_root = root_glb_work + ".tmp.glb"
            subprocess.run(
                [
                    GLTFPACK_EXE,
                    "-i",
                    obj_work_path,
                    "-o",
                    tmp_root,
                    "-si",
                    f"{ratio_full:.4f}",
                    "-slb",
                    "-sv",
                    "-vp",
                    "14",
                    "-vt",
                    "12",
                    "-cc",
                ],
                capture_output=True,
                timeout=180,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0,
            )
            if os.path.isfile(tmp_root) and os.path.getsize(tmp_root) > 1024:
                with open(tmp_root, "rb") as tf:
                    raw_r = tf.read()
                os.remove(tmp_root)
                opt_r = _downscale_glb_textures(raw_r, max_dim=target_tex_res, jpeg_quality=target_jpeg_q)
                shifted_r = shift_glb_node_translation(opt_r, ox_m, oy_m, oz_m)
                with open(root_glb_work, "wb") as wf:
                    wf.write(shifted_r)

            used_v_idx = np.unique(f_merged[:, [0, 2, 4]] - 1)
            used_v_idx = np.clip(used_v_idx, 0, len(v_merged) - 1)
            v_surviving = v_merged[used_v_idx]
            vmin_twd = v_surviving.min(axis=0).astype(np.float64) + merged_offset
            vmax_twd = v_surviving.max(axis=0).astype(np.float64) + merged_offset
            bc = (vmin_twd + vmax_twd) * 0.5
            bh = (vmax_twd - vmin_twd) * 0.5
            diag = float(np.linalg.norm(vmax_twd - vmin_twd))

            ts_dict = {
                "asset": {
                    "version": "1.1",
                    "generator": "GatheringCloud Multi-Scan Unifier v1.1",
                    "gltfUpAxis": "Z",
                },
                "geometricError": round(max(1.0, diag / 16.0), 4),
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
                    "geometricError": 0.0,
                    "refine": "REPLACE",
                    "content": {"uri": "tiles/root.glb"},
                    "children": [],
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

            # Atomically publish hidden work_proj_dir -> out_proj_dir
            if os.path.isdir(out_proj_dir):
                shutil.rmtree(out_proj_dir, ignore_errors=True)
            os.replace(work_proj_dir, out_proj_dir)
            ts_out_path = os.path.join(out_proj_dir, "tileset", "tileset.json")
            obj_out_path = os.path.join(out_proj_dir, "exports", "obj_mesh", "mesh.obj")

            try:
                ensure_scan_low_quality_preview(ts_out_path, force=True)
                ensure_scan_full_quality_thumbnail(ts_out_path, new_scan_id, project_dir=out_proj_dir, force=True)
            except Exception as e:
                print(f"[OptimizerBridge] Warning generating preview/thumbnail for merged scan {new_scan_id}: {e}")

            # Compute 2D occupied footprint area in m^2 using 2m grid cells on surviving vertices
            gx = np.floor(v_surviving[:, 0] / 2.0).astype(np.int64)
            gy = np.floor(v_surviving[:, 1] / 2.0).astype(np.int64)
            unique_cells = len(np.unique(gx * 1000003 + gy))
            covered_area_m2 = round(max(float(unique_cells) * 4.0, float(bh[0] * bh[1] * 2.2)), 1)

            total_disk_bytes = 0
            for r_d, _, r_fs in os.walk(out_proj_dir):
                for fn in r_fs:
                    try:
                        total_disk_bytes += os.path.getsize(os.path.join(r_d, fn))
                    except OSError:
                        pass

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
                "size_bytes": max(total_disk_bytes, 1024),
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

            meta_file = os.path.join(out_proj_dir, "scan_meta.json")
            with open(meta_file, "w", encoding="utf-8") as mf:
                json.dump(scan_record, mf, indent=2, ensure_ascii=False)

            saved_scan = self.db.upsert_scan(scan_record)

            # Copy 3D geo-comments from source scans to the unified scan before moving originals to Trash Bin
            seen_src_ids = set()
            for _, src_sc in resolved_layers:
                src_sid = str(src_sc.get("scan_id") or "").strip()
                if src_sid and src_sid.lower() not in seen_src_ids:
                    seen_src_ids.add(src_sid.lower())
                    try:
                        self.db.clone_comments_to_scan(src_sid, new_scan_id)
                    except Exception:
                        pass

            archive_originals = payload.get("archive_originals_to_bin")
            if archive_originals is None:
                archive_originals = True
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
                if isinstance(poly, list) and len(poly) >= 3:
                    all_del_polys.append([[float(p[0]), float(p[1])] for p in poly])
            single_poly = batch.get("native_polygon")
            if isinstance(single_poly, list) and len(single_poly) >= 3:
                all_del_polys.append([[float(p[0]), float(p[1])] for p in single_poly])

        for st in payload.get("delete_frustum_strokes") or []:
            if isinstance(st, dict) and len(st.get("ndc_polygon") or []) >= 3:
                all_del_strokes.append(st)
        for poly in payload.get("delete_native_polygons") or []:
            if isinstance(poly, list) and len(poly) >= 3:
                all_del_polys.append([[float(p[0]), float(p[1])] for p in poly])

        has_deletions = bool(all_del_strokes or all_del_polys)

        # 2. Collect optional Crop Keep region(s)
        crop_keep = payload.get("crop_keep") if isinstance(payload.get("crop_keep"), dict) else {}
        keep_strokes = [
            st
            for st in (crop_keep.get("frustum_strokes") or [])
            if isinstance(st, dict) and len(st.get("ndc_polygon") or []) >= 3
        ]
        keep_polys = [
            [[float(p[0]), float(p[1])] for p in poly]
            for poly in (crop_keep.get("native_polygons") or [])
            if isinstance(poly, list) and len(poly) >= 3
        ]
        if isinstance(crop_keep.get("native_polygon"), list) and len(crop_keep["native_polygon"]) >= 3:
            keep_polys.append([[float(p[0]), float(p[1])] for p in crop_keep["native_polygon"]])
        keep_min_z = float(crop_keep.get("min_elev", -9999.0))
        keep_max_z = float(crop_keep.get("max_elev", 9999.0))
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
        off_x = float(crs_cfg.get("offset_x") or 0.0)
        off_y = float(crs_cfg.get("offset_y") or 0.0)
        off_z = float(crs_cfg.get("offset_z") or 0.0)
        has_crs = bool(
            (target_crs_code and target_crs_code in CRS_DEFINITIONS)
            or abs(off_x) > 1e-6
            or abs(off_y) > 1e-6
            or abs(off_z) > 1e-6
        )

        if not (has_deletions or has_crop_keep or has_compression or has_crs):
            raise ValueError(
                "Please stage at least one adjustment (Lasso Delete, Crop Keep, Mesh Compression, or Coordinate System) before generating a new scan."
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

            final_crs_label = str(source_scan.get("crs") or TWD97_TWVD2001_SHORT)
            lat_final = float(source_scan["lat"]) if source_scan.get("lat") is not None else None
            lon_final = float(source_scan["lon"]) if source_scan.get("lon") is not None else None

            if has_crs:
                crs_info = _transform_tileset_crs_in_place(
                    tileset_dir=tileset_work_dir,
                    source_scan=source_scan,
                    target_crs_code=target_crs_code,
                    custom_offset_xyz=(off_x, off_y, off_z),
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

            # Atomically publish hidden work_proj_dir -> out_proj_dir once tileset is 100% ready
            if os.path.isdir(out_proj_dir):
                shutil.rmtree(out_proj_dir, ignore_errors=True)
            os.replace(work_proj_dir, out_proj_dir)
            tileset_out_dir = os.path.join(out_proj_dir, "tileset")
            ts_out_path = os.path.join(tileset_out_dir, "tileset.json")

            with open(ts_out_path, "r", encoding="utf-8") as f_ts:
                final_ts_obj = json.load(f_ts)
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

            now_ts = time.time()
            summary_str = " · ".join(applied_steps) if applied_steps else "Saved Edited Scan"
            orig_capture_date = str(source_scan.get("capture_date") or "").strip() or datetime.now().strftime("%Y-%m-%d %H:%M")
            scan_record = {
                "scan_id": new_scan_id,
                "name": raw_name,
                "user_edited_name": 1,
                "project_group": proj_group,
                "project_name_zh": proj_zh,
                "capture_date": orig_capture_date,
                "uploaded_at": now_ts,
                "uploader_email": str(payload.get("actor_email") or source_scan.get("uploader_email") or "engineer@gatheren.cloud"),
                "uploader_name": str(payload.get("actor_name") or source_scan.get("uploader_name") or "Survey Engineer"),
                "source_zip_path": "",
                "project_dir": out_proj_dir,
                "tileset_path": ts_out_path,
                "obj_path": "",
                "cameras_dir": source_scan.get("cameras_dir") or "",
                "image_count": max(int(source_scan.get("image_count") or 1), 1),
                "size_bytes": max(int(total_disk_bytes), 1024),
                "covered_area_m2": covered_area_m2,
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
            }

            meta_file = os.path.join(out_proj_dir, "scan_meta.json")
            with open(meta_file, "w", encoding="utf-8") as mf:
                json.dump(scan_record, mf, indent=2, ensure_ascii=False)

            saved_scan = self.db.upsert_scan(scan_record)

            # Copy 3D geo-comments onto the saved edited scan before moving the original scan to Trash Bin
            try:
                self.db.clone_comments_to_scan(source_scan_id, new_scan_id)
            except Exception as ce:
                print(f"[OptimizerBridge] Note cloning comments from {source_scan_id} to {new_scan_id}: {ce}")

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
