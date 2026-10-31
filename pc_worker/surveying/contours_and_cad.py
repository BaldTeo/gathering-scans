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
import struct
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

CAMERAS_CACHE_DIR = os.path.join(BASE_DIR, "data", "cameras_cache")
os.makedirs(CAMERAS_CACHE_DIR, exist_ok=True)
from pc_worker.priority_queue import ScanQueueDB

from pc_worker.surveying.dsm_and_volume import (
    safe_float,
    wgs84_to_twd97,
    GLTFPACK_EXE,
    MS_CASES,
    polygon_area_and_perimeter_2d,
    point_in_polygon_2d,
    simplify_polyline_2d,
    DsmAndVolumeMixin,
)


class ContoursAndCadMixin:
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
        minor_raw = safe_float(payload.get("minor_interval_m"), 0.5)
        minor_interval = max(minor_raw if minor_raw is not None and minor_raw > 0 else 0.5, 0.1)
        major_raw = safe_float(payload.get("major_interval_m"), minor_interval * 5.0)
        major_interval = max(major_raw if major_raw is not None and major_raw > 0 else minor_interval * 5.0, minor_interval)

        scan = self._resolve_scan_record(scan_id)
        v_shift = self._resolve_vertical_datum_shift(scan_id, payload, scan) if hasattr(self, "_resolve_vertical_datum_shift") else 0.0

        dsm_data = self._load_or_build_scan_dsm(scan)
        ce = dsm_data["ce"]
        cn = dsm_data["cn"]
        ch = dsm_data["ch"] + v_shift

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
        if abs(v_shift) > 1e-6:
            sub_grid = sub_grid + v_shift
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
            BASE_DIR,
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

        def _to_en(pt_val: Any, default_x: float, default_y: float) -> Tuple[float, float]:
            if isinstance(pt_val, dict):
                px = safe_float(pt_val.get("x", pt_val.get("e")))
                pz = safe_float(pt_val.get("z", pt_val.get("n")))
                if px is None:
                    px = default_x
                if pz is None:
                    pz = default_y
                if abs(px) < 10000 and abs(pz) < 10000:
                    return ce + px, cn - pz
                return px, pz
            if isinstance(pt_val, (list, tuple)) and len(pt_val) >= 2:
                px = safe_float(pt_val[0])
                py = safe_float(pt_val[1])
                if px is None:
                    px = default_x
                if py is None:
                    py = default_y
                if abs(px) < 10000 and abs(py) < 10000:
                    return ce + px, cn - py
                return px, py
            return default_x, default_y

        x1, y1 = _to_en(p_start, -span_e, -span_n)
        x2, y2 = _to_en(p_end, span_e, span_n)

        total_len = max(math.hypot(x2 - x1, y2 - y1), 0.5)
        num_samples = 60
        samples = []
        max_slope_pct = 0.0
        v_shift_curr = self._resolve_vertical_datum_shift(scan_id, payload, scan) if hasattr(self, "_resolve_vertical_datum_shift") else 0.0
        v_shift_cmp = self._resolve_vertical_datum_shift(compare_scan_id) if hasattr(self, "_resolve_vertical_datum_shift") and compare_scan_id else 0.0

        # Compute linear datum connecting start and end elevations as fallback if no baseline epoch exists
        z_start_raw, _, _, _ = self._sample_dsm_elevation(dsm_curr, x1, y1)
        z_end_raw, _, _, _ = self._sample_dsm_elevation(dsm_curr, x2, y2)
        z_start = z_start_raw + v_shift_curr
        z_end = z_end_raw + v_shift_curr

        prev_z = None
        step_m = total_len / num_samples
        for i in range(num_samples + 1):
            t = i / num_samples
            ex = x1 + t * (x2 - x1)
            ny = y1 + t * (y2 - y1)
            chainage = round(t * total_len, 2)

            z_curr_raw, _, _, _ = self._sample_dsm_elevation(dsm_curr, ex, ny)
            z_curr = z_curr_raw + v_shift_curr
            if dsm_cmp is not None:
                z_base_raw, _, _, is_cmp_valid = self._sample_dsm_elevation(dsm_cmp, ex, ny)
                if not is_cmp_valid:
                    # Shift by vertical datum difference if baseline scan has slight offset
                    z_base = z_curr - (ch - dsm_cmp["ch"])
                else:
                    z_base = z_base_raw + v_shift_cmp
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

        overall_dh = round(float(z_end - z_start), 3)
        overall_slope_pct = round(abs(overall_dh) / max(total_len, 0.01) * 100.0, 1)
        if abs(overall_dh) < 1e-3:
            overall_slope_dhl = "0:1"
        else:
            ratio = max(total_len, 0.001) / abs(overall_dh)
            ratio_str = str(int(round(ratio))) if ratio >= 10.0 else f"{ratio:.1f}".rstrip("0").rstrip(".")
            overall_slope_dhl = f"1:{ratio_str}"

        return {
            "status": "ok",
            "scan_id": scan_id,
            "compare_scan_id": compare_scan_id,
            "compare_scan_name": cmp_scan.get("name") if cmp_scan else "Chord Grade Datum",
            "crs": TWD97_TWVD2001_SHORT,
            "total_length_m": round(total_len, 2),
            "max_slope_pct": round(max_slope_pct, 1),
            "overall_dh_m": overall_dh,
            "overall_slope_pct": overall_slope_pct,
            "overall_slope_dhl": overall_slope_dhl,
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

    def _get_single_scan_camera_dirs(self, scan: Dict[str, Any]) -> List[str]:
        dirs: List[str] = []
        if not isinstance(scan, dict):
            return dirs
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

    def _extract_merged_from_list(self, scan: Dict[str, Any]) -> List[Dict[str, Any]]:
        if not isinstance(scan, dict):
            return []
        mf = scan.get("merged_from")
        if isinstance(mf, list) and mf:
            return [x for x in mf if isinstance(x, dict)]
        extra_raw = scan.get("extra_json")
        extra_obj: Dict[str, Any] = {}
        if isinstance(extra_raw, dict):
            extra_obj = extra_raw
        elif isinstance(extra_raw, str) and extra_raw.strip():
            try:
                extra_obj = json.loads(extra_raw)
            except Exception:
                extra_obj = {}
        mf_extra = extra_obj.get("merged_from")
        if isinstance(mf_extra, list) and mf_extra:
            return [x for x in mf_extra if isinstance(x, dict)]
        parent_id = str(scan.get("derived_from_scan_id") or extra_obj.get("derived_from_scan_id") or "").strip()
        if parent_id and parent_id != str(scan.get("scan_id") or ""):
            parent_scan = self.db.get_scan(parent_id)
            if parent_scan:
                return self._extract_merged_from_list(parent_scan)
        return []

    def _flatten_merged_from_leaves(
        self, merged_from_list: List[Dict[str, Any]], _visited: Optional[set] = None
    ) -> List[Dict[str, Any]]:
        if not isinstance(merged_from_list, list) or not merged_from_list:
            return []
        visited = set(_visited) if _visited else set()

        def _mat3_mul(a: List[float], b: List[float]) -> List[float]:
            return [
                round(a[0] * b[0] + a[1] * b[3] + a[2] * b[6], 8),
                round(a[0] * b[1] + a[1] * b[4] + a[2] * b[7], 8),
                round(a[0] * b[2] + a[1] * b[5] + a[2] * b[8], 8),
                round(a[3] * b[0] + a[4] * b[3] + a[5] * b[6], 8),
                round(a[3] * b[1] + a[4] * b[4] + a[5] * b[7], 8),
                round(a[3] * b[2] + a[4] * b[5] + a[5] * b[8], 8),
                round(a[6] * b[0] + a[7] * b[3] + a[8] * b[6], 8),
                round(a[6] * b[1] + a[7] * b[4] + a[8] * b[7], 8),
                round(a[6] * b[2] + a[7] * b[5] + a[8] * b[8], 8),
            ]

        leaves: List[Dict[str, Any]] = []
        for mf in merged_from_list:
            if not isinstance(mf, dict):
                continue
            sub_sid = str(mf.get("scan_id") or "").strip()
            base_sid = str(mf.get("derived_from_scan_id") or "").strip()
            child_mf_list: List[Dict[str, Any]] = []
            for check_sid in (sub_sid, base_sid):
                if not check_sid or check_sid in visited:
                    continue
                s_rec = self.db.get_scan(check_sid)
                if s_rec:
                    extracted = self._extract_merged_from_list(s_rec)
                    if extracted:
                        visited.add(check_sid)
                        child_mf_list = self._flatten_merged_from_leaves(extracted, visited)
                        break
            if child_mf_list:
                na_2 = mf.get("native_anchor_zup")
                ma_2 = mf.get("merged_anchor_zup")
                rm_2 = [
                    float(x)
                    for x in (
                        mf.get("r_zup_rowmajor")
                        if isinstance(mf.get("r_zup_rowmajor"), (list, tuple)) and len(mf.get("r_zup_rowmajor")) >= 9
                        else [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
                    )[:9]
                ]
                for c_mf in child_mf_list:
                    comp = dict(c_mf)
                    na_1 = c_mf.get("native_anchor_zup")
                    ma_1 = c_mf.get("merged_anchor_zup")
                    rm_1 = [
                        float(x)
                        for x in (
                            c_mf.get("r_zup_rowmajor")
                            if isinstance(c_mf.get("r_zup_rowmajor"), (list, tuple)) and len(c_mf.get("r_zup_rowmajor")) >= 9
                            else [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
                        )[:9]
                    ]
                    if (
                        isinstance(na_1, (list, tuple))
                        and len(na_1) >= 3
                        and isinstance(ma_1, (list, tuple))
                        and len(ma_1) >= 3
                        and isinstance(na_2, (list, tuple))
                        and len(na_2) >= 3
                        and isinstance(ma_2, (list, tuple))
                        and len(ma_2) >= 3
                    ):
                        dx = float(ma_1[0]) - float(na_2[0])
                        dy = float(ma_1[1]) - float(na_2[1])
                        dz = float(ma_1[2]) - float(na_2[2])
                        ma_comp = [
                            round(float(ma_2[0]) + rm_2[0] * dx + rm_2[1] * dy + rm_2[2] * dz, 4),
                            round(float(ma_2[1]) + rm_2[3] * dx + rm_2[4] * dy + rm_2[5] * dz, 4),
                            round(float(ma_2[2]) + rm_2[6] * dx + rm_2[7] * dy + rm_2[8] * dz, 4),
                        ]
                        na_comp = [round(float(na_1[0]), 4), round(float(na_1[1]), 4), round(float(na_1[2]), 4)]
                        rm_comp = _mat3_mul(rm_2, rm_1)
                        comp["native_anchor_zup"] = na_comp
                        comp["merged_anchor_zup"] = ma_comp
                        comp["r_zup_rowmajor"] = rm_comp
                        comp["zup_shift"] = [
                            round(ma_comp[0] - na_comp[0], 4),
                            round(ma_comp[1] - na_comp[1], 4),
                            round(ma_comp[2] - na_comp[2], 4),
                        ]
                    leaves.append(comp)
            else:
                leaves.append(dict(mf))
        return leaves

    def _get_candidate_camera_dirs(self, scan: Dict[str, Any]) -> List[str]:
        dirs: List[str] = []
        for d in self._get_single_scan_camera_dirs(scan):
            if d not in dirs:
                dirs.append(d)
        extra_raw = scan.get("extra_json")
        extra_obj: Dict[str, Any] = {}
        if isinstance(extra_raw, dict):
            extra_obj = extra_raw
        elif isinstance(extra_raw, str) and extra_raw.strip():
            try:
                extra_obj = json.loads(extra_raw)
            except Exception:
                extra_obj = {}
        deriv_id = str(scan.get("derived_from_scan_id") or extra_obj.get("derived_from_scan_id") or "").strip()
        if deriv_id:
            d_scan = self.db.get_scan(deriv_id)
            if d_scan:
                for d in self._get_single_scan_camera_dirs(d_scan):
                    if d not in dirs:
                        dirs.append(d)
        for mf in self._flatten_merged_from_leaves(self._extract_merged_from_list(scan)):
            for sid_key in ("scan_id", "derived_from_scan_id"):
                sid = str(mf.get(sid_key) or "").strip()
                if not sid:
                    continue
                sub_scan = self.db.get_scan(sid)
                if sub_scan:
                    for d in self._get_single_scan_camera_dirs(sub_scan):
                        if d not in dirs:
                            dirs.append(d)
                for fallback_d in (os.path.join(SCANS_ROOT_DIR, sid), os.path.join(SCANS_ROOT_DIR, sid, "inputs")):
                    if os.path.isdir(fallback_d) and fallback_d not in dirs:
                        dirs.append(fallback_d)
        return dirs

    @staticmethod
    def _decode_cbor_bytes(data: bytes) -> Any:
        """Pure-Python RFC 8949 CBOR decoder for Pix4Dmatic `root.p4m` payloads."""
        pos = 0
        n_len = len(data)

        def _read() -> Any:
            nonlocal pos
            if pos >= n_len:
                return None
            ib = data[pos]
            pos += 1
            mt = ib >> 5
            ai = ib & 0x1F
            if ai < 24:
                val: Optional[int] = ai
            elif ai == 24:
                val = data[pos]
                pos += 1
            elif ai == 25:
                val = struct.unpack(">H", data[pos : pos + 2])[0]
                pos += 2
            elif ai == 26:
                val = struct.unpack(">I", data[pos : pos + 4])[0]
                pos += 4
            elif ai == 27:
                val = struct.unpack(">Q", data[pos : pos + 8])[0]
                pos += 8
            elif ai == 31:
                val = None
            else:
                val = 0
            if mt == 0:
                return val or 0
            if mt == 1:
                return -1 - (val or 0)
            if mt == 2:
                ln = val or 0
                b = data[pos : pos + ln]
                pos += ln
                return b
            if mt == 3:
                ln = val or 0
                b = data[pos : pos + ln]
                pos += ln
                return b.decode("utf-8", errors="replace")
            if mt == 4:
                if val is None:
                    arr = []
                    while pos < n_len and data[pos] != 0xFF:
                        arr.append(_read())
                    pos += 1
                    return arr
                return [_read() for _ in range(val)]
            if mt == 5:
                if val is None:
                    d = {}
                    while pos < n_len and data[pos] != 0xFF:
                        k = _read()
                        d[k] = _read()
                    pos += 1
                    return d
                d = {}
                for _ in range(val):
                    k = _read()
                    d[k] = _read()
                return d
            if mt == 6:
                return _read()
            if mt == 7:
                if ai == 20:
                    return False
                if ai == 21:
                    return True
                if ai in (22, 23):
                    return None
                if ai == 25:
                    return struct.unpack(">e", struct.pack(">H", val or 0))[0]
                if ai == 26:
                    return struct.unpack(">f", struct.pack(">I", val or 0))[0]
                if ai == 27:
                    return struct.unpack(">d", struct.pack(">Q", val or 0))[0]
                return val
            return None

        return _read()

    @staticmethod
    def _norm3(v: List[float]) -> List[float]:
        ln = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
        if ln <= 1e-12:
            return [0.0, 1.0, 0.0]
        return [v[0] / ln, v[1] / ln, v[2] / ln]

    def _load_or_build_camera_catalog(self, scan: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        Loads or builds the calibrated Pix4Dmatic (`root.p4m`) / OPF (`input_cameras.json`)
        camera pose catalog (`_cameras_cache_v6.json`, superseding `_cameras_cache_v4.json`)
        for a scan in exact TWD97 + TWVD2001 coordinates, including canonical
        upright image basis (`right`, `down`, `forward`) and normalized focal lengths (`fx_norm`, `fy_norm`).
        """
        scan_id = str(scan.get("scan_id") or "unknown")
        if scan_id in self._camera_mem_cache:
            return self._camera_mem_cache[scan_id]

        proj_dir = scan.get("project_dir") or os.path.join(SCANS_ROOT_DIR, scan_id)
        portable_cache = os.path.join(CAMERAS_CACHE_DIR, f"{scan_id}_cameras_v7.json")
        proj_cache = os.path.join(proj_dir, "_cameras_cache_v7.json") if os.path.isdir(proj_dir) else None

        for cache_cand in (proj_cache, portable_cache):
            if cache_cand and os.path.isfile(cache_cand):
                try:
                    with open(cache_cand, "r", encoding="utf-8") as f:
                        cams = json.load(f)
                    if isinstance(cams, list) and len(cams) > 0:
                        self._camera_mem_cache[scan_id] = cams
                        return cams
                except Exception:
                    pass

        merged_from_list = self._flatten_merged_from_leaves(self._extract_merged_from_list(scan))
        source_specs: List[Tuple[str, List[str], Optional[Dict[str, Any]]]] = []
        source_name_map: Dict[str, str] = {}
        if merged_from_list:
            for idx_m, mf in enumerate(merged_from_list):
                sub_sid = str(mf.get("scan_id") or "").strip()
                base_sid = str(mf.get("derived_from_scan_id") or "").strip()
                nested_sid = ""
                sub_dirs: List[str] = []
                resolved_name = ""
                for sid in (sub_sid, base_sid):
                    if not sid:
                        continue
                    s_rec = self.db.get_scan(sid)
                    if s_rec:
                        if not resolved_name and s_rec.get("name"):
                            resolved_name = str(s_rec.get("name")).strip()
                        for d in self._get_single_scan_camera_dirs(s_rec):
                            if d not in sub_dirs:
                                sub_dirs.append(d)
                        s_extra = s_rec.get("extra_json")
                        if isinstance(s_extra, str) and s_extra.strip():
                            try:
                                s_extra_d = json.loads(s_extra)
                            except Exception:
                                s_extra_d = {}
                        elif isinstance(s_extra, dict):
                            s_extra_d = s_extra
                        else:
                            s_extra_d = {}
                        nested_deriv = str(s_rec.get("derived_from_scan_id") or s_extra_d.get("derived_from_scan_id") or "").strip()
                        if nested_deriv:
                            if not nested_sid:
                                nested_sid = nested_deriv
                            nd_rec = self.db.get_scan(nested_deriv)
                            if nd_rec:
                                if nd_rec.get("name"):
                                    resolved_name = str(nd_rec.get("name")).strip()
                                for d in self._get_single_scan_camera_dirs(nd_rec):
                                    if d not in sub_dirs:
                                        sub_dirs.append(d)
                            for fb_nd in (os.path.join(SCANS_ROOT_DIR, nested_deriv), os.path.join(SCANS_ROOT_DIR, nested_deriv, "inputs")):
                                if os.path.isdir(fb_nd) and fb_nd not in sub_dirs:
                                    sub_dirs.append(fb_nd)
                    for fb_d in (os.path.join(SCANS_ROOT_DIR, sid), os.path.join(SCANS_ROOT_DIR, sid, "inputs")):
                        if os.path.isdir(fb_d) and fb_d not in sub_dirs:
                            sub_dirs.append(fb_d)
                tag = base_sid or nested_sid or sub_sid or f"part_{idx_m + 1}"
                clean_nm = resolved_name or str(mf.get("name") or tag).strip()
                if clean_nm.endswith("_Edited"):
                    clean_nm = clean_nm[:-7]
                source_name_map[tag] = clean_nm
                if sub_dirs:
                    source_specs.append((tag, sub_dirs, mf))
        if not source_specs:
            source_name_map[scan_id] = str(scan.get("name") or scan_id).strip()
            source_specs.append(("", self._get_candidate_camera_dirs(scan), None))

        catalog: List[Dict[str, Any]] = []
        seen_source_keys: set = set()
        scan_crs_up = str(scan.get("crs") or "").upper()
        scan_h_ref = float(scan.get("twd97_h") or 0.0)

        def _cam_xy_to_scan_en(c0: float, c1: float, force_utm51n: bool = False) -> Optional[Tuple[float, float]]:
            if not force_utm51n and 150000.0 <= c0 <= 335000.0 and 2400000.0 <= c1 <= 2850000.0:
                return c0, c1
            if force_utm51n or (100000.0 <= c0 <= 850000.0 and 2500000.0 <= c1 <= 3000000.0):
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

        def _apply_subscan_pose_transform(
            cam_e: float,
            cam_n: float,
            h_val: float,
            u_right: List[float],
            v_down: List[float],
            f_vec: List[float],
            mf_spec: Optional[Dict[str, Any]],
        ) -> Tuple[float, float, float, List[float], List[float], List[float]]:
            if not isinstance(mf_spec, dict):
                return cam_e, cam_n, h_val, u_right, v_down, f_vec
            na = mf_spec.get("native_anchor_zup")
            ma = mf_spec.get("merged_anchor_zup")
            rm = mf_spec.get("r_zup_rowmajor")
            if (
                isinstance(na, (list, tuple))
                and len(na) >= 3
                and isinstance(ma, (list, tuple))
                and len(ma) >= 3
                and isinstance(rm, (list, tuple))
                and len(rm) >= 9
            ):
                r00, r01, r02 = float(rm[0]), float(rm[1]), float(rm[2])
                r10, r11, r12 = float(rm[3]), float(rm[4]), float(rm[5])
                r20, r21, r22 = float(rm[6]), float(rm[7]), float(rm[8])
                dx = cam_e - float(na[0])
                dy = cam_n - float(na[1])
                dz = h_val - float(na[2])
                te = float(ma[0]) + r00 * dx + r01 * dy + r02 * dz
                tn = float(ma[1]) + r10 * dx + r11 * dy + r12 * dz
                th = float(ma[2]) + r20 * dx + r21 * dy + r22 * dz

                def _rot(v: List[float]) -> List[float]:
                    return self._norm3(
                        [
                            r00 * v[0] + r01 * v[1] + r02 * v[2],
                            r10 * v[0] + r11 * v[1] + r12 * v[2],
                            r20 * v[0] + r21 * v[1] + r22 * v[2],
                        ]
                    )

                return te, tn, th, _rot(u_right), _rot(v_down), _rot(f_vec)
            zs = mf_spec.get("zup_shift")
            if isinstance(zs, (list, tuple)) and len(zs) >= 3:
                return cam_e + float(zs[0]), cam_n + float(zs[1]), h_val + float(zs[2]), u_right, v_down, f_vec
            return cam_e, cam_n, h_val, u_right, v_down, f_vec

        def _canonicalize_p4m_basis(
            r0: List[float], r1: List[float], f_vec: List[float], f_long: float, f_short: float
        ) -> Tuple[List[float], List[float], List[float], float, float, float]:
            r0_n = self._norm3(r0)
            r1_n = self._norm3(r1)
            f_n = self._norm3(f_vec)
            if abs(r0_n[2]) > abs(r1_n[2]):
                # Portrait capture (displayed 3:4 upright image)
                fx_norm = f_short
                fy_norm = f_long
                aspect = 0.75
                if r0_n[2] < 0.0:
                    # EXIF Orientation 6 (90 deg CW): displayed right = -r1, displayed down = +r0
                    u_right = [-r1_n[0], -r1_n[1], -r1_n[2]]
                    v_down = [r0_n[0], r0_n[1], r0_n[2]]
                else:
                    # EXIF Orientation 8 (90 deg CCW): displayed right = +r1, displayed down = -r0
                    u_right = [r1_n[0], r1_n[1], r1_n[2]]
                    v_down = [-r0_n[0], -r0_n[1], -r0_n[2]]
            else:
                # Landscape capture (displayed 4:3 upright image)
                fx_norm = f_long
                fy_norm = f_short
                aspect = round(4.0 / 3.0, 4)
                if r1_n[2] < 0.0:
                    u_right = [r0_n[0], r0_n[1], r0_n[2]]
                    v_down = [r1_n[0], r1_n[1], r1_n[2]]
                else:
                    u_right = [-r0_n[0], -r0_n[1], -r0_n[2]]
                    v_down = [-r1_n[0], -r1_n[1], -r1_n[2]]
            return u_right, v_down, f_n, round(fx_norm, 5), round(fy_norm, 5), aspect

        def _basis_from_euler(yaw_deg: float, pitch_deg: float) -> Tuple[List[float], List[float], List[float]]:
            yr = math.radians(yaw_deg)
            pr = math.radians(pitch_deg)
            cp = math.cos(pr)
            sp = math.sin(pr)
            sy = math.sin(yr)
            cy = math.cos(yr)
            f_vec = self._norm3([sy * cp, cy * cp, sp])
            u_right = self._norm3([cy, -sy, 0.0])
            # v_down = f x u_right so (u_right, v_down, f) is right-handed with v_down pointing -Z
            v_down = self._norm3(
                [
                    f_vec[1] * u_right[2] - f_vec[2] * u_right[1],
                    f_vec[2] * u_right[0] - f_vec[0] * u_right[2],
                    f_vec[0] * u_right[1] - f_vec[1] * u_right[0],
                ]
            )
            if v_down[2] > 0.0:
                v_down = [-v_down[0], -v_down[1], -v_down[2]]
            return u_right, v_down, f_vec

        # Iterate over each source_spec: Priority 1 = Pix4Dmatic root.p4m calibratedCameras; Priority 2 = OPF input_cameras.json; Priority 3 = EXIF
        for src_tag, sdirs, mf_spec in source_specs:
            src_found_p4m = False
            p4m_candidates: List[str] = []
            ordered_sdirs = ([proj_dir] if (not merged_from_list and proj_dir and os.path.isdir(proj_dir)) else []) + list(sdirs)
            for sdir in ordered_sdirs:
                for root_cand in (sdir, os.path.dirname(sdir.rstrip("\\/")) if os.path.basename(sdir.rstrip("\\/")).lower() == "inputs" else sdir):
                    if not root_cand or not os.path.isdir(root_cand):
                        continue
                    base_rc = os.path.basename(root_cand.rstrip("\\/"))
                    for direct_p4m in (
                        os.path.join(root_cand, "project", "root.p4m"),
                        os.path.join(root_cand, base_rc, "root.p4m"),
                        os.path.join(root_cand, "root.p4m"),
                    ):
                        if os.path.isfile(direct_p4m) and direct_p4m not in p4m_candidates:
                            p4m_candidates.append(direct_p4m)
                    if not p4m_candidates:
                        for gp in glob.glob(os.path.join(root_cand, "*", "root.p4m")):
                            if os.path.isfile(gp) and gp not in p4m_candidates:
                                p4m_candidates.append(gp)

            # Build a fast basename -> abs_path lookup inside sdirs in case root.p4m references moved image paths
            local_jpg_map: Dict[str, str] = {}
            for sdir in sdirs:
                if not os.path.isdir(sdir):
                    continue
                for jp in glob.glob(os.path.join(sdir, "**", "*.jp*g"), recursive=True):
                    bname = os.path.basename(jp)
                    if bname not in local_jpg_map:
                        local_jpg_map[bname] = os.path.normpath(jp)

            for p4m_path in p4m_candidates:
                try:
                    with open(p4m_path, "rb") as pf:
                        raw_p4m = pf.read()
                    cbor_idx = raw_p4m.find(b"creationSoftwareVersion")
                    if cbor_idx < 2:
                        continue
                    p4m_obj = self._decode_cbor_bytes(raw_p4m[cbor_idx - 2 :])
                    if not isinstance(p4m_obj, dict):
                        continue
                    state = p4m_obj.get("state") or {}
                    buckets = state.get("buckets") or []
                    if not buckets:
                        continue
                    cal_node = (((buckets[0].get("bucket") or {}).get("calibratedCameras") or {}).get("data") or {}).get("data")
                    if not isinstance(cal_node, dict):
                        continue
                    cam_array = cal_node.get("cameraArray") or {}
                    p4m_cams = cam_array.get("cameras") or []
                    if not p4m_cams:
                        continue

                    # Extract intrinsics (fpx, width, height)
                    f_long = round(1334.5 / 1920.0, 5)
                    f_short = round(1334.5 / 1440.0, 5)
                    params_list = cam_array.get("parameters") or []
                    if not params_list:
                        src_models = cal_node.get("sourceInputCameraModels") or []
                        if src_models and isinstance(src_models[0], (list, tuple)) and len(src_models[0]) >= 2:
                            params_list = [src_models[0][1]]
                    if params_list and isinstance(params_list[0], dict):
                        intr = params_list[0].get("intrinsicParameters") or {}
                        w_px = float(intr.get("width") or 1920.0)
                        h_px = float(intr.get("height") or 1440.0)
                        persp = (intr.get("modelSpecificParameters") or {}).get("perspectiveParameters") or {}
                        f_px = float(persp.get("fpx") or 1334.5)
                        long_side = max(w_px, h_px, 1.0)
                        short_side = max(min(w_px, h_px), 1.0)
                        f_long = f_px / long_side
                        f_short = f_px / short_side

                    # Determine scene -> TWD97 + TWVD2001 transformation for this p4m project
                    p4m_proj_root = os.path.dirname(os.path.dirname(os.path.abspath(p4m_path)))
                    tile_transform_twd: Optional[List[float]] = None
                    for ts_cand in (
                        os.path.join(p4m_proj_root, "tileset", "tileset.json"),
                        os.path.join(proj_dir, "tileset", "tileset.json") if not merged_from_list else "",
                    ):
                        if ts_cand and os.path.isfile(ts_cand):
                            try:
                                with open(ts_cand, "r", encoding="utf-8") as tf:
                                    ts_obj = json.load(tf)
                                tr_m = (ts_obj.get("root") or {}).get("transform")
                                if (
                                    isinstance(tr_m, list)
                                    and len(tr_m) == 16
                                    and 150000.0 <= float(tr_m[12]) <= 400000.0
                                    and 2400000.0 <= float(tr_m[13]) <= 2900000.0
                                ):
                                    tile_transform_twd = [float(x) for x in tr_m]
                                    break
                            except Exception:
                                pass

                    ref_frame = state.get("refFrame") or {}
                    rf_wkt2 = str(ref_frame.get("wkt2") or "").upper()
                    is_p4m_utm = "UTM" in rf_wkt2
                    rf_shift = ref_frame.get("shift") or [0.0, 0.0, 0.0]
                    ox, oy, oz = -float(rf_shift[0]), -float(rf_shift[1]), -float(rf_shift[2])
                    for off_cand in (
                        os.path.join(p4m_proj_root, "tileset", "offset.xyz"),
                        os.path.join(p4m_proj_root, "exports", "obj_mesh", "offset.xyz"),
                    ):
                        if os.path.isfile(off_cand):
                            try:
                                parts_off = open(off_cand, "r", encoding="utf-8").read().strip().split()
                                if len(parts_off) >= 3 and abs(float(parts_off[0])) > 100.0 and abs(float(parts_off[1])) > 100.0:
                                    ox, oy, oz = float(parts_off[0]), float(parts_off[1]), float(parts_off[2])
                                    is_p4m_utm = ox > 335000.0
                                    break
                            except Exception:
                                pass

                    p4m_entries: List[Dict[str, Any]] = []
                    for c_rec in p4m_cams:
                        if not isinstance(c_rec, (list, tuple)) or len(c_rec) < 6:
                            continue
                        pos_dict = c_rec[4]
                        rot_dict = c_rec[5]
                        if not isinstance(pos_dict, dict) or not isinstance(rot_dict, dict):
                            continue
                        coords_s = pos_dict.get("coordinates")
                        mat_s = rot_dict.get("matrix")
                        if not isinstance(coords_s, (list, tuple)) or len(coords_s) < 3 or not isinstance(mat_s, (list, tuple)) or len(mat_s) < 9:
                            continue
                        raw_img_str = str(c_rec[1] or "").strip()
                        if not raw_img_str:
                            continue
                        norm_raw_img = raw_img_str.replace("\\", "/")
                        fname = os.path.basename(norm_raw_img)
                        parent_2 = os.path.basename(os.path.dirname(os.path.dirname(norm_raw_img)))
                        has_multipart_sub = ("of" in parent_2.lower()) and (parent_2.lower() not in ("inputs", "images", "opf_files", src_tag.lower()))
                        rel_fname = f"{parent_2}/{fname}" if has_multipart_sub else fname
                        abs_img = os.path.normpath(raw_img_str)
                        if not os.path.isfile(abs_img) and fname in local_jpg_map:
                            abs_img = local_jpg_map[fname]
                        dedup_key = f"{src_tag}:{rel_fname}" if src_tag else os.path.normcase(abs_img)
                        if dedup_key in seen_source_keys:
                            continue
                        seen_source_keys.add(dedup_key)

                        xs, ys, zs = float(coords_s[0]), float(coords_s[1]), float(coords_s[2])
                        r0 = [float(mat_s[0]), float(mat_s[1]), float(mat_s[2])]
                        r1 = [float(mat_s[3]), float(mat_s[4]), float(mat_s[5])]
                        f_vec = [float(mat_s[6]), float(mat_s[7]), float(mat_s[8])]

                        if tile_transform_twd is not None:
                            m = tile_transform_twd
                            cam_e = m[0] * xs + m[4] * ys + m[8] * zs + m[12]
                            cam_n = m[1] * xs + m[5] * ys + m[9] * zs + m[13]
                            cam_h = m[2] * xs + m[6] * ys + m[10] * zs + m[14]

                            def _rot_tile(v: List[float]) -> List[float]:
                                return [
                                    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
                                    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
                                    m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
                                ]

                            r0 = _rot_tile(r0)
                            r1 = _rot_tile(r1)
                            f_vec = _rot_tile(f_vec)
                        else:
                            raw_x = ox + xs
                            raw_y = oy + ys
                            cam_h = oz + zs
                            en_pair = _cam_xy_to_scan_en(raw_x, raw_y, force_utm51n=is_p4m_utm)
                            if en_pair is None:
                                continue
                            cam_e, cam_n = en_pair

                        u_right, v_down, f_n, fx_norm, fy_norm, aspect = _canonicalize_p4m_basis(r0, r1, f_vec, f_long, f_short)
                        cam_e, cam_n, cam_h, u_right, v_down, f_n = _apply_subscan_pose_transform(
                            cam_e, cam_n, cam_h, u_right, v_down, f_n, mf_spec
                        )

                        yaw_deg = (math.degrees(math.atan2(f_n[0], f_n[1])) + 360.0) % 360.0
                        pitch_deg = math.degrees(math.asin(max(-1.0, min(1.0, f_n[2]))))
                        roll_deg = math.degrees(math.atan2(u_right[2], -v_down[2]))

                        acc = pos_dict.get("accuracies") or [0.012, 0.012, 0.018]
                        if (not isinstance(acc, (list, tuple)) or len(acc) < 3) and isinstance(c_rec[2], (list, tuple)) and len(c_rec[2]) >= 2:
                            acc = c_rec[2][1]
                        h_sigma_cm = round(math.hypot(float(acc[0]), float(acc[1])) * 100.0, 2) if isinstance(acc, (list, tuple)) and len(acc) >= 2 else 1.4
                        v_sigma_cm = round(float(acc[2]) * 100.0, 2) if isinstance(acc, (list, tuple)) and len(acc) >= 3 else 2.0

                        display_name = f"{src_tag}/{rel_fname}" if src_tag else rel_fname
                        eff_sub = src_tag or scan_id
                        p4m_entries.append(
                            {
                                "filename": display_name,
                                "sub_scan": eff_sub,
                                "source_scan_id": eff_sub,
                                "source_scan_name": source_name_map.get(eff_sub) or eff_sub,
                                "abs_path": abs_img,
                                "e": round(cam_e, 3),
                                "n": round(cam_n, 3),
                                "h": round(cam_h, 3),
                                "rtk_h_sigma_cm": h_sigma_cm,
                                "rtk_v_sigma_cm": v_sigma_cm,
                                "yaw_deg": round(yaw_deg, 2),
                                "pitch_deg": round(pitch_deg, 2),
                                "roll_deg": round(roll_deg, 2),
                                "right": [round(x, 6) for x in u_right],
                                "down": [round(x, 6) for x in v_down],
                                "forward": [round(x, 6) for x in f_n],
                                "fx_norm": fx_norm,
                                "fy_norm": fy_norm,
                                "aspect": aspect,
                                "calibrated": True,
                                "pose_source": "pix4dmatic_p4m",
                            }
                        )
                    if p4m_entries:
                        # If a non-merged scan had ellipsoidal vertical shift in root.p4m without tileset.json transform, align to scan.twd97_h
                        if not mf_spec and tile_transform_twd is None and scan_h_ref > 0.0:
                            hs_sorted = sorted(e["h"] for e in p4m_entries)
                            med_h = hs_sorted[len(hs_sorted) // 2]
                            if med_h - scan_h_ref > 12.0:
                                h_corr = (scan_h_ref + 1.5) - med_h
                                for e in p4m_entries:
                                    e["h"] = round(e["h"] + h_corr, 3)
                        catalog.extend(p4m_entries)
                        src_found_p4m = True
                        break
                except Exception:
                    continue

            if src_found_p4m:
                continue

            # 2. Fallback: OPF input_cameras.json + camera_list.json across sdirs
            src_found_opf = False
            opf_entries: List[Dict[str, Any]] = []
            for sdir in sdirs:
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
                            fname = os.path.basename(abs_img)
                            prefix_tag = src_tag or (part_tag if part_tag and part_tag not in ("inputs", "opf_files") else "")
                            dedup_key = f"{prefix_tag}:{fname}" if prefix_tag else os.path.normcase(os.path.abspath(abs_img))
                            if dedup_key in seen_source_keys:
                                continue
                            seen_source_keys.add(dedup_key)
                            geo = cap.get("geolocation") or {}
                            coords = geo.get("coordinates") or []
                            if len(coords) < 2:
                                continue
                            c0 = float(coords[0])
                            c1 = float(coords[1])
                            h_val = float(coords[2]) if len(coords) >= 3 else scan_h_ref
                            en_pair = _cam_xy_to_scan_en(c0, c1)
                            if en_pair is None:
                                continue
                            cam_e, cam_n = en_pair
                            sigmas = geo.get("sigmas") or [0.014, 0.014, 0.022]
                            h_sigma_cm = round(math.hypot(float(sigmas[0]), float(sigmas[1])) * 100.0, 2)
                            v_sigma_cm = round(float(sigmas[2]) * 100.0, 2) if len(sigmas) >= 3 else 2.2
                            ori = cap.get("orientation") or {}
                            angles = ori.get("angles_deg") or [0.0, -20.0, 0.0]
                            raw_yaw = (float(angles[0]) - 90.0) % 360.0 if len(angles) >= 1 else 0.0
                            raw_pitch = float(angles[1]) if len(angles) >= 2 and -89.0 <= float(angles[1]) <= 89.0 else -15.0
                            u_right, v_down, f_n = _basis_from_euler(raw_yaw, raw_pitch)
                            cam_e, cam_n, h_val, u_right, v_down, f_n = _apply_subscan_pose_transform(
                                cam_e, cam_n, h_val, u_right, v_down, f_n, mf_spec
                            )
                            adj_yaw = (math.degrees(math.atan2(f_n[0], f_n[1])) + 360.0) % 360.0
                            adj_pitch = math.degrees(math.asin(max(-1.0, min(1.0, f_n[2]))))
                            display_name = f"{prefix_tag}/{fname}" if prefix_tag else fname
                            eff_sub = prefix_tag or scan_id
                            opf_entries.append(
                                {
                                    "filename": display_name,
                                    "sub_scan": eff_sub,
                                    "source_scan_id": eff_sub,
                                    "source_scan_name": source_name_map.get(eff_sub) or eff_sub,
                                    "abs_path": abs_img,
                                    "e": round(cam_e, 3),
                                    "n": round(cam_n, 3),
                                    "h": round(h_val, 3),
                                    "rtk_h_sigma_cm": h_sigma_cm,
                                    "rtk_v_sigma_cm": v_sigma_cm,
                                    "yaw_deg": round(adj_yaw, 2),
                                    "pitch_deg": round(adj_pitch, 2),
                                    "roll_deg": 0.0,
                                    "right": [round(x, 6) for x in u_right],
                                    "down": [round(x, 6) for x in v_down],
                                    "forward": [round(x, 6) for x in f_n],
                                    "fx_norm": 0.92674,
                                    "fy_norm": 0.69505,
                                    "aspect": 0.75,
                                    "calibrated": False,
                                    "pose_source": "opf_input_cameras",
                                }
                            )
                            src_found_opf = True
                    except Exception:
                        continue
            if opf_entries:
                if scan_h_ref > 0.0:
                    hs_sorted = sorted(e["h"] for e in opf_entries)
                    med_h = hs_sorted[len(hs_sorted) // 2]
                    if med_h - scan_h_ref > 10.0:
                        h_corr = (scan_h_ref + 1.5) - med_h
                        for e in opf_entries:
                            e["h"] = round(e["h"] + h_corr, 3)
                catalog.extend(opf_entries)

            # 3. Per-source fallback to EXIF GPS extraction from raw .jpg files if no p4m or OPF camera files were present
            if not src_found_opf:
                exif_entries: List[Dict[str, Any]] = []
                for sdir in sdirs:
                    jpgs = [
                        p
                        for p in (
                            glob.glob(os.path.join(sdir, "**", "*.jpg"), recursive=True)
                            + glob.glob(os.path.join(sdir, "**", "*.jpeg"), recursive=True)
                        )
                        if not os.path.basename(p).lower().startswith(("mesh", "thumb", "ortho"))
                    ]
                    if not jpgs:
                        continue
                    jpgs.sort()
                    stride = max(1, len(jpgs) // 600)
                    for jp in jpgs[::stride]:
                        try:
                            fname = os.path.basename(jp)
                            dedup_key = f"{src_tag}:{fname}" if src_tag else os.path.normcase(os.path.abspath(jp))
                            if dedup_key in seen_source_keys:
                                continue
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
                            seen_source_keys.add(dedup_key)
                            alt_raw = gps.get("GPSAltitude", scan_h_ref)
                            if hasattr(alt_raw, "numerator"):
                                h_val = float(alt_raw.numerator) / max(float(alt_raw.denominator), 1e-9)
                            elif isinstance(alt_raw, (tuple, list)) and len(alt_raw) == 2:
                                h_val = float(alt_raw[0]) / max(float(alt_raw[1]), 1e-9)
                            else:
                                h_val = float(alt_raw)
                            cam_e, cam_n = wgs84_to_twd97(lat, lon)
                            u_right, v_down, f_n = _basis_from_euler(0.0, -18.0)
                            cam_e, cam_n, h_val, u_right, v_down, f_n = _apply_subscan_pose_transform(
                                cam_e, cam_n, h_val, u_right, v_down, f_n, mf_spec
                            )
                            adj_yaw = (math.degrees(math.atan2(f_n[0], f_n[1])) + 360.0) % 360.0
                            display_name = f"{src_tag}/{fname}" if src_tag else fname
                            eff_sub = src_tag or scan_id
                            exif_entries.append(
                                {
                                    "filename": display_name,
                                    "sub_scan": eff_sub,
                                    "source_scan_id": eff_sub,
                                    "source_scan_name": source_name_map.get(eff_sub) or eff_sub,
                                    "abs_path": os.path.abspath(jp),
                                    "e": round(cam_e, 3),
                                    "n": round(cam_n, 3),
                                    "h": round(h_val, 3),
                                    "rtk_h_sigma_cm": float(scan.get("rtk_accuracy_cm") or 1.4),
                                    "rtk_v_sigma_cm": round(float(scan.get("rtk_accuracy_cm") or 1.4) * 1.4, 2),
                                    "yaw_deg": round(adj_yaw, 2),
                                    "pitch_deg": -18.0,
                                    "roll_deg": 0.0,
                                    "right": [round(x, 6) for x in u_right],
                                    "down": [round(x, 6) for x in v_down],
                                    "forward": [round(x, 6) for x in f_n],
                                    "fx_norm": 0.92674,
                                    "fy_norm": 0.69505,
                                    "aspect": 0.75,
                                    "calibrated": False,
                                    "pose_source": "exif_gps",
                                }
                            )
                        except Exception:
                            continue
                if exif_entries:
                    if scan_h_ref > 0.0:
                        hs_sorted = sorted(e["h"] for e in exif_entries)
                        med_h = hs_sorted[len(hs_sorted) // 2]
                        if med_h - scan_h_ref > 10.0:
                            h_corr = (scan_h_ref + 1.5) - med_h
                            for e in exif_entries:
                                e["h"] = round(e["h"] + h_corr, 3)
                    catalog.extend(exif_entries)

        if catalog:
            self._camera_mem_cache[scan_id] = catalog
            for save_path in (proj_cache, portable_cache):
                if save_path:
                    try:
                        with open(save_path, "w", encoding="utf-8") as f:
                            json.dump(catalog, f)
                    except Exception:
                        pass
        return catalog

    def resolve_camera_photo_path(self, scan_id: str, file_key: str) -> Optional[str]:
        """Resolves a requested camera photo `file_key` (including `<sub_scan>/Image_XXXXXX.jpg`) to its verified `.jpg` path on disk."""
        clean_id = (scan_id or "").strip()
        if not clean_id:
            return None
        scan = self.db.get_scan(clean_id)
        if not scan:
            return None
        catalog = self._load_or_build_camera_catalog(scan)
        norm_key = str(file_key or "").replace("\\", "/").strip("/")
        base_key = os.path.basename(norm_key)
        sub_prefix = os.path.dirname(norm_key).strip("/") if "/" in norm_key else ""

        # 1. Exact filename match in catalog (e.g. "catch_QiHuTender_4/Image_001068.jpg")
        for cam in catalog:
            if cam.get("filename") == norm_key and os.path.isfile(cam.get("abs_path", "")):
                return cam["abs_path"]

        # 2. If sub_prefix was specified (e.g. "edited_qihutender_1_edited_346774" or "catch_QiHuTender_4"), match sub_scan or abs_path containing sub_prefix
        if sub_prefix:
            sub_low = sub_prefix.lower()
            for cam in catalog:
                if os.path.basename(cam.get("filename", "")) != base_key:
                    continue
                c_sub = str(cam.get("sub_scan") or "").lower()
                c_abs = str(cam.get("abs_path") or "").replace("\\", "/").lower()
                if (c_sub == sub_low or sub_low in c_abs or ("qihutender_1" in sub_low and "qihutender_1" in c_sub)) and os.path.isfile(cam.get("abs_path", "")):
                    return cam["abs_path"]
            for sdir in self._get_candidate_camera_dirs(scan):
                if sub_low in sdir.replace("\\", "/").lower():
                    matches = glob.glob(os.path.join(sdir, "**", base_key), recursive=True)
                    if matches and os.path.isfile(matches[0]):
                        return matches[0]

        # 3. Fallback to basename match only when no sub_prefix was provided (or sub_prefix wasn't found)
        for cam in catalog:
            if os.path.basename(cam.get("abs_path", "")) == base_key and os.path.isfile(cam.get("abs_path", "")):
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
        Finds the calibrated Pix4Dmatic / RTK smartphone photographs whose 3D camera frustum
        actually observes the clicked 3D surface coordinate (TWD97 E, N, TWVD2001 H), projecting
        the 3D point onto each upright image plane `(proj_u, proj_v)`.
        """
        from urllib.parse import quote

        scan_id = (payload.get("scan_id") or "").strip()
        scan = self._resolve_scan_record(scan_id)

        ce = float(scan.get("twd97_e") or 0.0)
        cn = float(scan.get("twd97_n") or 0.0)
        ch = float(scan.get("twd97_h") or 0.0)

        catalog = self._load_or_build_camera_catalog(scan)
        pinned_filename = str(payload.get("camera_filename") or "").replace("\\", "/").strip("/")
        pinned_cam: Optional[Dict[str, Any]] = None
        if pinned_filename:
            for c in catalog:
                if c.get("filename") == pinned_filename or os.path.basename(c.get("filename", "")) == pinned_filename:
                    pinned_cam = c
                    break

        click_x = safe_float(payload.get("x"), 0.0) or 0.0
        click_y = safe_float(payload.get("y"), 0.0) or 0.0
        click_z = safe_float(payload.get("z"), 0.0) or 0.0

        use_camera_ray_dsm = bool(payload.get("use_camera_ray_dsm"))
        twd_e_safe = safe_float(payload.get("twd_e"))
        twd_n_safe = safe_float(payload.get("twd_n"))
        if not use_camera_ray_dsm and twd_e_safe is not None and twd_n_safe is not None:
            target_e = round(twd_e_safe, 3)
            target_n = round(twd_n_safe, 3)
            twd_h_safe = safe_float(payload.get("twd_h"))
            if twd_h_safe is not None:
                target_h = round(twd_h_safe, 3)
            else:
                target_h = round(ch + click_y if abs(click_y) < 1000 else click_y, 3)
        elif pinned_cam is not None and (
            use_camera_ray_dsm
            or (payload.get("twd_e") is None and click_x == 0.0 and click_y == 0.0 and click_z == 0.0)
        ):
            # Raycast along the pinned camera's calibrated optical axis against the scan DSM surface
            f_vec = pinned_cam.get("forward") or [0.0, 1.0, -0.25]
            cam_e = safe_float(pinned_cam.get("e"), ce) or ce
            cam_n = safe_float(pinned_cam.get("n"), cn) or cn
            cam_h = safe_float(pinned_cam.get("h"), ch) or ch
            est_dist = 4.5
            if f_vec[2] < -0.08:
                est_dist = max(1.5, min(18.0, 1.55 / (-f_vec[2])))
            target_e = round(cam_e + f_vec[0] * est_dist, 3)
            target_n = round(cam_n + f_vec[1] * est_dist, 3)
            target_h = round(cam_h + f_vec[2] * est_dist, 3)
            try:
                dsm = self._load_or_build_scan_dsm(scan)
                hit_found = False
                step_m = 0.35
                dist_m = 0.5
                while dist_m <= 35.0:
                    ray_e = cam_e + f_vec[0] * dist_m
                    ray_n = cam_n + f_vec[1] * dist_m
                    ray_h = cam_h + f_vec[2] * dist_m
                    dsm_z, _, _, is_valid = self._sample_dsm_elevation(dsm, ray_e, ray_n)
                    if is_valid and math.isfinite(dsm_z) and ray_h <= dsm_z:
                        target_e = round(ray_e, 3)
                        target_n = round(ray_n, 3)
                        target_h = round(float(dsm_z), 3)
                        hit_found = True
                        break
                    dist_m += step_m
                if not hit_found:
                    sampled_h, _, _, _ = self._sample_dsm_elevation(dsm, target_e, target_n)
                    if math.isfinite(sampled_h):
                        target_h = round(float(sampled_h), 3)
            except Exception:
                pass
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

        max_rad = safe_float(payload.get("max_radius_m"), 45.0)
        max_radius_m = max_rad if max_rad is not None and max_rad > 0 else 45.0
        lim_photos = safe_float(payload.get("limit"), 6.0)
        limit_photos = max(1, min(24, int(round(lim_photos or 6.0))))

        fov_candidates: List[Tuple[float, float, float, float, bool, Dict[str, Any]]] = []
        near_fallback: List[Tuple[float, float, float, float, bool, Dict[str, Any]]] = []

        for cam in catalog:
            c_e = safe_float(cam.get("e"))
            c_n = safe_float(cam.get("n"))
            c_h = safe_float(cam.get("h"))
            if c_e is None or c_n is None or c_h is None:
                continue
            dx = target_e - c_e
            dy = target_n - c_n
            dz = target_h - c_h
            dist_3d = math.sqrt(dx * dx + dy * dy + dz * dz)
            if dist_3d > max_radius_m or dist_3d < 0.2:
                continue

            r_vec = cam.get("right")
            d_vec = cam.get("down")
            f_vec = cam.get("forward")
            if not (isinstance(r_vec, list) and isinstance(d_vec, list) and isinstance(f_vec, list) and len(f_vec) == 3):
                yr = math.radians(float(cam.get("yaw_deg") or 0.0))
                pr = math.radians(float(cam.get("pitch_deg") or -18.0))
                f_vec = [math.sin(yr) * math.cos(pr), math.cos(yr) * math.cos(pr), math.sin(pr)]
                r_vec = [math.cos(yr), -math.sin(yr), 0.0]
                d_vec = [
                    f_vec[1] * r_vec[2] - f_vec[2] * r_vec[1],
                    f_vec[2] * r_vec[0] - f_vec[0] * r_vec[2],
                    f_vec[0] * r_vec[1] - f_vec[1] * r_vec[0],
                ]

            zc = dx * f_vec[0] + dy * f_vec[1] + dz * f_vec[2]
            if zc <= 0.25:
                continue
            xc = dx * r_vec[0] + dy * r_vec[1] + dz * r_vec[2]
            yc = dx * d_vec[0] + dy * d_vec[1] + dz * d_vec[2]
            fx_n = float(cam.get("fx_norm") or 0.92674)
            fy_n = float(cam.get("fy_norm") or 0.69505)
            u = 0.5 + fx_n * (xc / zc)
            v = 0.5 + fy_n * (yc / zc)
            off_center = math.hypot(u - 0.5, v - 0.5)
            dist_eff = dist_3d if dist_3d >= 1.1 else 1.1 + (1.1 - dist_3d) * 3.0
            in_fov = 0.02 <= u <= 0.98 and 0.02 <= v <= 0.98
            if in_fov:
                score = dist_eff * (1.0 + 1.8 * off_center)
                fov_candidates.append((score, dist_3d, u, v, True, cam))
            elif -0.35 <= u <= 1.35 and -0.35 <= v <= 1.35:
                score = dist_eff * (2.5 + 3.0 * off_center) + 15.0
                near_fallback.append((score, dist_3d, max(0.02, min(0.98, u)), max(0.02, min(0.98, v)), False, cam))

        fov_candidates.sort(key=lambda item: item[0])
        near_fallback.sort(key=lambda item: item[0])
        ranked = fov_candidates + near_fallback

        def _format_photo_item(dist_3d: float, u: float, v: float, in_fov: bool, cam: Dict[str, Any]) -> Dict[str, Any]:
            fk = str(cam["filename"])
            return {
                "filename": fk,
                "sub_scan": cam.get("sub_scan") or "",
                "url": f"/api/camera-photo?scan_id={quote(str(scan_id))}&file={quote(fk)}",
                "distance_m": round(dist_3d, 2),
                "rtk_h_sigma_cm": cam.get("rtk_h_sigma_cm", 1.4),
                "rtk_v_sigma_cm": cam.get("rtk_v_sigma_cm", 2.0),
                "camera_twd97_e": cam["e"],
                "camera_twd97_n": cam["n"],
                "camera_twd97_h": cam["h"],
                "camera_local_x": round(cam["e"] - ce, 3),
                "camera_local_y": round(cam["h"] - ch, 3),
                "camera_local_z": round(cn - cam["n"], 3),
                "yaw_deg": cam.get("yaw_deg", 0.0),
                "pitch_deg": cam.get("pitch_deg", -15.0),
                "roll_deg": cam.get("roll_deg", 0.0),
                "right": cam.get("right"),
                "down": cam.get("down"),
                "forward": cam.get("forward"),
                "fx_norm": cam.get("fx_norm", 0.92674),
                "fy_norm": cam.get("fy_norm", 0.69505),
                "aspect": cam.get("aspect", 0.75),
                "proj_u": round(float(u), 4),
                "proj_v": round(float(v), 4),
                "in_fov": bool(in_fov),
                "calibrated": bool(cam.get("calibrated", False)),
                "pose_source": cam.get("pose_source", "pix4dmatic_p4m"),
            }

        selected_photos: List[Dict[str, Any]] = []
        used_positions: List[Tuple[float, float, float]] = []
        used_filenames: set = set()

        if pinned_cam is not None:
            dx = target_e - float(pinned_cam["e"])
            dy = target_n - float(pinned_cam["n"])
            dz = target_h - float(pinned_cam["h"])
            d3 = math.sqrt(dx * dx + dy * dy + dz * dz)
            r_v = pinned_cam.get("right") or [1.0, 0.0, 0.0]
            d_v = pinned_cam.get("down") or [0.0, 0.0, -1.0]
            f_v = pinned_cam.get("forward") or [0.0, 1.0, 0.0]
            zc = max(0.25, dx * f_v[0] + dy * f_v[1] + dz * f_v[2])
            u_p = max(0.02, min(0.98, 0.5 + float(pinned_cam.get("fx_norm") or 0.92674) * ((dx * r_v[0] + dy * r_v[1] + dz * r_v[2]) / zc)))
            v_p = max(0.02, min(0.98, 0.5 + float(pinned_cam.get("fy_norm") or 0.69505) * ((dx * d_v[0] + dy * d_v[1] + dz * d_v[2]) / zc)))
            selected_photos.append(_format_photo_item(d3, u_p, v_p, True, pinned_cam))
            used_positions.append((pinned_cam["e"], pinned_cam["n"], pinned_cam["h"]))
            used_filenames.add(pinned_cam["filename"])

        for _, dist_3d, u, v, in_fov, cam in ranked:
            if cam["filename"] in used_filenames:
                continue
            pos = (cam["e"], cam["n"], cam["h"])
            if any(math.hypot(pos[0] - up[0], pos[1] - up[1]) < 0.65 for up in used_positions):
                continue
            used_positions.append(pos)
            used_filenames.add(cam["filename"])
            selected_photos.append(_format_photo_item(dist_3d, u, v, in_fov, cam))
            if len(selected_photos) >= limit_photos:
                break

        return {
            "status": "ok",
            "scan_id": scan_id,
            "target_twd97": {"e": target_e, "n": target_n, "h": target_h},
            "crs": TWD97_TWVD2001_SHORT,
            "total_catalog_cameras": len(catalog),
            "fov_match_count": len(fov_candidates),
            "photo_count": len(selected_photos),
            "photos": selected_photos,
        }

    inspect_photos_at_point = inspect_rtk_camera_photos

    def get_scan_cameras_response(self, scan_id: str, limit: int = 10000, fmt: str = "json") -> Any:
        """
        Returns all calibrated camera positions and orientations for a scan in TWD97 + TWVD2001
        (for 3D trajectory rendering, clickable 3D camera markers, and CSV/JSON export).
        """
        from urllib.parse import quote

        scan = self._resolve_scan_record(scan_id)
        resolved_id = str(scan.get("scan_id") or scan_id)
        ce = float(scan.get("twd97_e") or 0.0)
        cn = float(scan.get("twd97_n") or 0.0)
        ch = float(scan.get("twd97_h") or 0.0)
        catalog = self._load_or_build_camera_catalog(scan)
        total = len(catalog)

        if str(fmt or "").lower() == "csv":
            lines = ["filename,sub_scan,twd97_e,twd97_n,twd2001_h,yaw_deg,pitch_deg,roll_deg,rtk_h_sigma_cm,rtk_v_sigma_cm,calibrated,pose_source"]
            for c in catalog:
                lines.append(
                    f"\"{c.get('filename','')}\",\"{c.get('sub_scan','')}\",{c.get('e',0):.3f},{c.get('n',0):.3f},{c.get('h',0):.3f},"
                    f"{c.get('yaw_deg',0):.2f},{c.get('pitch_deg',0):.2f},{c.get('roll_deg',0):.2f},"
                    f"{c.get('rtk_h_sigma_cm',1.4)},{c.get('rtk_v_sigma_cm',2.0)},{bool(c.get('calibrated',False))},{c.get('pose_source','')}"
                )
            return "\n".join(lines) + "\n"

        max_items = max(1, min(25000, int(limit or 10000)))
        stride = max(1, math.ceil(total / max_items)) if total > max_items else 1
        sampled = catalog[::stride][:max_items]
        sub_scans_counts: Dict[str, int] = {}
        sub_scan_names: Dict[str, str] = {}
        for c in catalog:
            st = str(c.get("sub_scan") or resolved_id)
            sub_scans_counts[st] = sub_scans_counts.get(st, 0) + 1
            if st not in sub_scan_names and c.get("source_scan_name"):
                sub_scan_names[st] = str(c["source_scan_name"])

        cameras_out = []
        for c in sampled:
            fk = str(c.get("filename") or "")
            st = str(c.get("sub_scan") or resolved_id)
            cameras_out.append(
                {
                    "filename": fk,
                    "sub_scan": st,
                    "source_scan_id": c.get("source_scan_id") or st,
                    "source_scan_name": c.get("source_scan_name") or sub_scan_names.get(st) or st,
                    "url": f"/api/camera-photo?scan_id={quote(resolved_id)}&file={quote(fk)}",
                    "e": c["e"],
                    "n": c["n"],
                    "h": c["h"],
                    "local_x": round(c["e"] - ce, 3),
                    "local_y": round(c["h"] - ch, 3),
                    "local_z": round(cn - c["n"], 3),
                    "yaw_deg": c.get("yaw_deg", 0.0),
                    "pitch_deg": c.get("pitch_deg", -15.0),
                    "roll_deg": c.get("roll_deg", 0.0),
                    "right": c.get("right"),
                    "down": c.get("down"),
                    "forward": c.get("forward"),
                    "fx_norm": c.get("fx_norm", 0.92674),
                    "fy_norm": c.get("fy_norm", 0.69505),
                    "aspect": c.get("aspect", 0.75),
                    "rtk_h_sigma_cm": c.get("rtk_h_sigma_cm", 1.4),
                    "rtk_v_sigma_cm": c.get("rtk_v_sigma_cm", 2.0),
                    "calibrated": bool(c.get("calibrated", False)),
                    "pose_source": c.get("pose_source", "pix4dmatic_p4m"),
                }
            )

        return {
            "status": "ok",
            "scan_id": resolved_id,
            "crs": TWD97_TWVD2001_SHORT,
            "anchor_twd97": {"e": ce, "n": cn, "h": ch},
            "total_cameras": total,
            "returned_cameras": len(cameras_out),
            "stride": stride,
            "sub_scans": sub_scans_counts,
            "cameras": cameras_out,
        }

