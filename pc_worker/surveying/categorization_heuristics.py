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
from pc_worker.priority_queue import ScanQueueDB

from pc_worker.surveying.dsm_and_volume import (
    wgs84_to_twd97,
    GLTFPACK_EXE,
    MS_CASES,
    polygon_area_and_perimeter_2d,
    point_in_polygon_2d,
    simplify_polyline_2d,
    DsmAndVolumeMixin,
)
from pc_worker.surveying.categorization_io import CategorizationIoMixin


class CategorizationHeuristicsMixin:
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
        action = str(payload.get("action") or "").strip()
        if action in ("manual_remove", "manual_add", "manual_reset"):
            return self.modify_saved_categorization(scan_id, payload)

        force_recompute = bool(payload.get("force_recompute", False))
        reset_manual_overrides = bool(payload.get("reset_manual_overrides", False))
        cached_only = bool(payload.get("cached_only", False))
        only_update_filters = bool(
            payload.get("only_update_filters", False) or action == "save_visibility"
        )

        if only_update_filters:
            updated = self.save_categorization_visibility_prefs(
                scan_id,
                layer_filters=payload.get("layer_filters") if isinstance(payload.get("layer_filters"), dict) else None,
                overlay_visible_default=bool(payload.get("overlay_visible_default", False)),
            )
            if updated:
                return updated
            return {
                "ok": False,
                "status": "not_cached",
                "has_categorization": False,
                "saved_on_server": False,
                "overlay_visible_default": False,
                "scan_id": scan_id,
            }

        scan = self._resolve_scan_record(scan_id) if not cached_only else (self.db.get_scan(scan_id) or {})
        prev_cached = self.get_saved_categorization(scan_id, scan) if (not cached_only or not force_recompute) else None
        preserved_overrides = (
            dict(prev_cached.get("manual_overrides"))
            if isinstance(prev_cached, dict) and isinstance(prev_cached.get("manual_overrides"), dict) and not reset_manual_overrides
            else None
        )

        if not force_recompute:
            if isinstance(prev_cached, dict) and prev_cached.get("status") == "ok":
                return prev_cached
            if cached_only:
                return {
                    "ok": True,
                    "status": "not_cached",
                    "has_categorization": False,
                    "saved_on_server": False,
                    "overlay_visible_default": False,
                    "scan_id": scan_id,
                }

        scan = self._resolve_scan_record(scan_id)
        ce = float(scan["twd97_e"]) if scan.get("twd97_e") is not None else 0.0
        cn = float(scan["twd97_n"]) if scan.get("twd97_n") is not None else 0.0
        ch = float(scan["twd97_h"]) if scan.get("twd97_h") is not None else 0.0

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
        n_tris = len(centroids)
        tri_indices = np.arange(n_tris, dtype=np.int32)
        base_e = np.concatenate([v0[:, 0], v1[:, 0], v2[:, 0], centroids[:, 0]])
        base_n = np.concatenate([v0[:, 1], v1[:, 1], v2[:, 1], centroids[:, 1]])
        e_min, e_max = float(base_e.min()), float(base_e.max())
        n_min, n_max = float(base_n.min()), float(base_n.max())
        span_e = max(e_max - e_min, 4.0)
        span_n = max(n_max - n_min, 4.0)
        max_span = max(span_e, span_n)

        sp_e_list = [centroids[:, 0], v0[:, 0], v1[:, 0], v2[:, 0]]
        sp_n_list = [centroids[:, 1], v0[:, 1], v1[:, 1], v2[:, 1]]
        sp_h_list = [centroids[:, 2], v0[:, 2], v1[:, 2], v2[:, 2]]
        sp_t_list = [tri_indices, tri_indices, tri_indices, tri_indices]
        w_base = np.maximum(area_2d * 0.25, 1e-5).astype(np.float32)
        sp_w_list = [w_base, w_base, w_base, w_base]

        if max_span <= 180.0:
            med_mask = area_2d >= 0.018
            if np.any(med_mask):
                m_idx = tri_indices[med_mask]
                mv0, mv1, mv2 = v0[med_mask], v1[med_mask], v2[med_mask]
                mw = np.maximum(area_2d[med_mask] * (1.0 / 12.0), 1e-5).astype(np.float32)
                for bw0, bw1, bw2 in (
                    (0.5, 0.5, 0.0),
                    (0.5, 0.0, 0.5),
                    (0.0, 0.5, 0.5),
                    (0.6, 0.2, 0.2),
                    (0.2, 0.6, 0.2),
                    (0.2, 0.2, 0.6),
                    (0.75, 0.125, 0.125),
                    (0.125, 0.75, 0.125),
                    (0.125, 0.125, 0.75),
                    (0.4, 0.4, 0.2),
                    (0.4, 0.2, 0.4),
                    (0.2, 0.4, 0.4),
                ):
                    pts_m = bw0 * mv0 + bw1 * mv1 + bw2 * mv2
                    sp_e_list.append(pts_m[:, 0])
                    sp_n_list.append(pts_m[:, 1])
                    sp_h_list.append(pts_m[:, 2])
                    sp_t_list.append(m_idx)
                    sp_w_list.append(mw)

            lg_mask = area_2d >= 0.12
            if np.any(lg_mask):
                l_idx = tri_indices[lg_mask]
                lv0, lv1, lv2 = v0[lg_mask], v1[lg_mask], v2[lg_mask]
                lw = np.maximum(area_2d[lg_mask] * (1.0 / 9.0), 1e-5).astype(np.float32)
                for bw0, bw1, bw2 in (
                    (0.25, 0.75, 0.0),
                    (0.75, 0.25, 0.0),
                    (0.25, 0.0, 0.75),
                    (0.75, 0.0, 0.25),
                    (0.0, 0.25, 0.75),
                    (0.0, 0.75, 0.25),
                    (0.5, 0.25, 0.25),
                    (0.25, 0.5, 0.25),
                    (0.25, 0.25, 0.5),
                ):
                    pts_l = bw0 * lv0 + bw1 * lv1 + bw2 * lv2
                    sp_e_list.append(pts_l[:, 0])
                    sp_n_list.append(pts_l[:, 1])
                    sp_h_list.append(pts_l[:, 2])
                    sp_t_list.append(l_idx)
                    sp_w_list.append(lw)

        all_e = np.concatenate(sp_e_list)
        all_n = np.concatenate(sp_n_list)
        all_h = np.concatenate(sp_h_list)
        splat_t_idx = np.concatenate(sp_t_list)
        splat_w = np.concatenate(sp_w_list)

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

        # Terrace-aware local ground DTM (preserves raised sidewalks, plaza decks, and perimeter roads above excavation pits)
        h_dtm_local = np.minimum(gaussian_filter(dtm_s1, sigma=max(0.8, 0.8 / res)), z_min_filled).astype(np.float32)

        hag_grid = np.maximum(0.0, z_max_filled - h_dtm_grid)
        hag_local_grid = np.maximum(0.0, z_max_filled - h_dtm_local)
        tri_dtm = h_dtm_grid[in_c, ie_c]
        tri_hag = centroids[:, 2] - tri_dtm
        tri_hag_local = centroids[:, 2] - h_dtm_local[in_c, ie_c]

        # Rasterize Top-Down True Orthophoto RGB
        ortho_rgb = np.zeros((ny, nx, 3), dtype=np.float32)
        ortho_cnt = np.zeros((ny, nx), dtype=np.float32)
        if max_span <= 180.0:
            for ch_i in range(3):
                np.add.at(ortho_rgb[:, :, ch_i], (in_all, ie_all), rgb[splat_t_idx, ch_i] * splat_w)
            np.add.at(ortho_cnt, (in_all, ie_all), splat_w)
            has_rgb = ortho_cnt > 1e-7
            if np.any(has_rgb) and not np.all(has_rgb):
                _, nearest_rgb_idx = distance_transform_edt(~has_rgb, return_indices=True)
            else:
                nearest_rgb_idx = nearest_idx
            for ch_i in range(3):
                plane = ortho_rgb[:, :, ch_i]
                plane[has_rgb] /= ortho_cnt[has_rgb]
                if np.any(~has_rgb):
                    plane[~has_rgb] = plane[nearest_rgb_idx[0][~has_rgb], nearest_rgb_idx[1][~has_rgb]]
                ortho_rgb[:, :, ch_i] = np.clip(plane, 0.0, 1.0)
        else:
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
            z_ref_grid: Optional[np.ndarray] = None,
        ) -> List[Dict[str, Any]]:
            z_src = z_ref_grid if z_ref_grid is not None else h_dtm_grid
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
                # On urban/park scans (max_span <= 180m), use exact occupied pixel area so interior lawn/planter holes are never over-counted
                if max_span <= 180.0:
                    true_area = float(px_cnt * cell_area)
                else:
                    true_area = max(p_area, float(px_cnt * cell_area * 0.92))
                if true_area < min_area_m2:
                    continue

                b_twd: List[List[float]] = []
                b_loc: List[List[float]] = []
                for ex, ny_v in ring_2d:
                    ix_p = int(np.clip((ex - e_min) / res, 0, nx - 1))
                    iy_p = int(np.clip((ny_v - n_min) / res, 0, ny - 1))
                    hz = float(fixed_z) if fixed_z is not None else float(z_src[iy_p, ix_p])
                    b_twd.append([round(ex, 3), round(ny_v, 3), round(hz, 3)])
                    b_loc.append([round(ex - ce, 3), round(hz - ch, 3), round(cn - ny_v, 3)])

                # Extract interior hole rings (e.g. circular tree planters & central park lawns inside road/walkway networks)
                holes_twd_list: List[List[List[float]]] = []
                holes_loc_list: List[List[List[float]]] = []
                if max_span <= 180.0:
                    filled_comp = binary_fill_holes(comp)
                    holes_mask = filled_comp & (~comp)
                    if np.any(holes_mask):
                        h_lbl, n_holes = nd_label(holes_mask)
                        for hid in range(1, n_holes + 1):
                            h_comp = h_lbl == hid
                            h_px = int(np.count_nonzero(h_comp))
                            if h_px * cell_area < 1.1:
                                continue
                            h_smooth = gaussian_filter(h_comp.astype(np.float32), sigma=0.65)
                            h_loops = self._extract_marching_squares_polylines_twd(
                                h_smooth,
                                np.ones_like(h_comp, dtype=bool),
                                e_min,
                                n_min,
                                res,
                                0.45,
                            )
                            ring_h: List[Tuple[float, float]] = []
                            if h_loops:
                                longest_h = max(h_loops, key=lambda lp: len(lp))
                                ring_h = simplify_polyline_2d([(p[0], p[1]) for p in longest_h], tol=max(0.20, simplify_tol * 0.7))
                            if len(ring_h) < 3:
                                hj_s, hi_s = np.nonzero(h_comp)
                                if len(hj_s) >= 4:
                                    try:
                                        pts_hen = np.column_stack([e_min + (hi_s + 0.5) * res, n_min + (hj_s + 0.5) * res])
                                        hhull = ConvexHull(pts_hen)
                                        ring_h = [(float(pts_hen[idx, 0]), float(pts_hen[idx, 1])) for idx in hhull.vertices]
                                    except Exception:
                                        ring_h = []
                            if len(ring_h) >= 3:
                                htwd: List[List[float]] = []
                                hloc: List[List[float]] = []
                                for hex_v, hny_v in ring_h:
                                    ix_h = int(np.clip((hex_v - e_min) / res, 0, nx - 1))
                                    iy_h = int(np.clip((hny_v - n_min) / res, 0, ny - 1))
                                    hz_h = float(fixed_z) if fixed_z is not None else float(z_src[iy_h, ix_h])
                                    htwd.append([round(hex_v, 3), round(hny_v, 3), round(hz_h, 3)])
                                    hloc.append([round(hex_v - ce, 3), round(hz_h - ch, 3), round(cn - hny_v, 3)])
                                holes_twd_list.append(htwd)
                                holes_loc_list.append(hloc)

                c_js, c_is = np.nonzero(comp)
                mean_e = float(e_min + (c_is.mean() + 0.5) * res)
                mean_n = float(n_min + (c_js.mean() + 0.5) * res)
                mean_h = float(fixed_z) if fixed_z is not None else float(z_src[c_js, c_is].mean())

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
                        "holes_twd97": holes_twd_list,
                        "holes_local": holes_loc_list,
                    }
                )
            out_polys.sort(key=lambda x: x["planar_area_m2"], reverse=True)
            return out_polys

        # Pre-compute site elevation percentiles, slope grid, elevated canopy ExG, and building footprint mask
        occ_valid_h = h_dtm_grid[raw_occ_closed]
        p25_site_h = float(np.percentile(occ_valid_h, 25.0)) if len(occ_valid_h) > 0 else ch
        p45_site_h = float(np.percentile(occ_valid_h, 45.0)) if len(occ_valid_h) > 0 else ch + 3.0
        p18_site_h = float(np.percentile(occ_valid_h, 18.0)) if len(occ_valid_h) > 0 else ch - 1.5

        dtm_for_slope = gaussian_filter(h_dtm_grid if max_span > 180.0 else h_dtm_local, sigma=max(1.5, 1.8 / res))
        grad_n, grad_e = np.gradient(dtm_for_slope, res, res)
        dtm_slope_pct_grid = np.hypot(grad_n, grad_e) * 100.0

        rb_diff = rgb[:, 0] - rgb[:, 2]
        ortho_rb_diff = ortho_rgb[:, :, 0] - ortho_rgb[:, :, 2]

        hag_tree_grid = np.maximum(hag_grid, hag_local_grid)
        tri_hag_tree = np.maximum(tri_hag, tri_hag_local)
        elev_tri_mask = tri_hag_tree >= 1.15
        elev_exg_raw = np.full((ny, nx), -1.0, dtype=np.float32)
        if np.any(elev_tri_mask):
            el_sp = elev_tri_mask[splat_t_idx]
            np.maximum.at(elev_exg_raw, (in_all[el_sp], ie_all[el_sp]), exg[splat_t_idx[el_sp]].astype(np.float32))
        elev_exg_grid = grey_dilation(elev_exg_raw, size=(3, 3))

        # Steep green fraction & elevated canopy green fraction grids (prevent tree canopies from ever being classified as walls or roofs)
        steep_all = (tri_hag_tree >= 0.35) & (nz_abs < 0.45)
        steep_grn_a = np.zeros((ny, nx), dtype=np.float32)
        steep_tot_a = np.zeros((ny, nx), dtype=np.float32)
        if np.any(steep_all):
            np.add.at(steep_tot_a, (in_c[steep_all], ie_c[steep_all]), area_3d[steep_all].astype(np.float32))
            sg = steep_all & (exg >= 0.032)
            if np.any(sg):
                np.add.at(steep_grn_a, (in_c[sg], ie_c[sg]), area_3d[sg].astype(np.float32))
        steep_grn_frac_grid = uniform_filter(steep_grn_a, size=5) / np.maximum(uniform_filter(steep_tot_a, size=5), 1e-5)

        el_all = tri_hag_tree >= 1.20
        el_grn_a = np.zeros((ny, nx), dtype=np.float32)
        el_tot_a = np.zeros((ny, nx), dtype=np.float32)
        if np.any(el_all):
            np.add.at(el_tot_a, (in_c[el_all], ie_c[el_all]), area_3d[el_all].astype(np.float32))
            eg = el_all & (exg >= 0.030)
            if np.any(eg):
                np.add.at(el_grn_a, (in_c[eg], ie_c[eg]), area_3d[eg].astype(np.float32))
        canopy_grn_frac_grid = uniform_filter(el_grn_a, size=9) / np.maximum(uniform_filter(el_tot_a, size=9), 1e-5)

        # Upgraded Building Roof & Footprint Mask (captures park buildings >= 8.5 m2 like RosePark Toilet Building as well as multi-story dorms)
        bldg_roof_tri = (tri_hag_tree >= 1.85) & (nz_abs >= 0.78) & (exg < 0.025) & (sat < 0.22)
        bldg_occ_grid = np.zeros((ny, nx), dtype=bool)
        bldg_footprint_m2_grid = np.zeros((ny, nx), dtype=np.float32)
        if np.any(bldg_roof_tri):
            r_grid = np.zeros((ny, nx), dtype=np.float32)
            np.add.at(r_grid, (in_c[bldg_roof_tri], ie_c[bldg_roof_tri]), area_3d[bldg_roof_tri].astype(np.float32))
            br_sp = bldg_roof_tri[splat_t_idx]
            bldg_raw = np.zeros((ny, nx), dtype=bool)
            bldg_raw[in_all[br_sp], ie_all[br_sp]] = True
            bldg_raw = binary_closing(bldg_raw | (r_grid >= 0.04), structure=np.ones((5, 5), dtype=bool))
            b_lbl, n_bldg = nd_label(bldg_raw)
            for bid in range(1, n_bldg + 1):
                b_comp = b_lbl == bid
                comp_area_m2 = float(int(np.count_nonzero(b_comp)) * cell_area)
                if float(r_grid[b_comp].sum()) >= 8.5 and comp_area_m2 >= 6.0:
                    comp_sgrn = float(steep_grn_frac_grid[b_comp].mean())
                    comp_h75 = float(np.percentile(hag_tree_grid[b_comp], 75.0))
                    # Reject medium-height park tree canopy domes (3.8m < comp_h75 < 7.8m and comp_sgrn > 0.48) while keeping park buildings (<=3.8m) & multi-story dorm roofs (>=7.8m)
                    if not (3.8 < comp_h75 < 7.8 and comp_sgrn > 0.48):
                        filled_b = binary_fill_holes(b_comp)
                        bldg_occ_grid |= filled_b
                        dil_b = binary_dilation(filled_b, structure=np.ones((15, 15), dtype=bool))
                        bldg_footprint_m2_grid[dil_b] = np.maximum(bldg_footprint_m2_grid[dil_b], comp_area_m2)
            if np.any(bldg_occ_grid):
                bldg_occ_grid = binary_dilation(bldg_occ_grid, structure=np.ones((13, 13), dtype=bool))

        # =================================================================================
        # CATEGORY 4 (PRE-COMPUTED): WALLS (Retaining & Building Walls / 擋土牆與垂直牆面)
        # Pre-computed before Trees & Roads so retaining walls & building facades never trigger false trees!
        # =================================================================================
        in_bldg_c = bldg_occ_grid[in_c, ie_c]
        bldg_fp_c = bldg_footprint_m2_grid[in_c, ie_c]
        is_bright_white_wall = (sat < 0.082) & (lum > 0.52) & (exg < 0.058) & (rb_diff >= -0.085) & (rb_diff <= 0.050)
        is_achromatic_wall = ((sat < 0.138) & (exg < 0.026) & (rb_diff >= -0.115) & (rb_diff <= 0.048)) | is_bright_white_wall
        is_tall_facade = (tri_hag_tree >= 2.8) & (exg < 0.024) & (sat < 0.175)
        is_riverbank_wall = (max_span > 180.0) & (tri_hag_tree <= 6.5) & (exg < 0.028) & (sat < 0.20)
        steep_grn_c = steep_grn_frac_grid[in_c, ie_c]
        canopy_safe_achrom = (steep_grn_c < 0.26) | ((exg < 0.018) & (sat < 0.125)) | is_bright_white_wall
        vert_tri_mask = (
            (tri_hag_tree >= 0.22)
            & (tri_hag_tree <= 32.0)
            & (nz_abs < 0.38)
            & ((exg < 0.034) | is_bright_white_wall)
            & ((elev_exg_grid[in_c, ie_c] <= 0.052) | ((is_achromatic_wall | is_tall_facade) & canopy_safe_achrom) | in_bldg_c | is_riverbank_wall)
            & ((steep_grn_c < 0.26) | ((is_achromatic_wall | is_tall_facade) & canopy_safe_achrom) | in_bldg_c | is_riverbank_wall)
            & (area_3d >= 0.004)
        )
        vert_idx = np.nonzero(vert_tri_mask)[0]
        walls_list: List[Dict[str, Any]] = []

        if len(vert_idx) >= 12:
            v_cent = centroids[vert_idx]
            v_norm = normals[vert_idx]
            v_a3d = area_3d[vert_idx]
            v_hag = tri_hag_tree[vert_idx]
            v_bldg = in_bldg_c[vert_idx]
            v_bldg_fp = bldg_fp_c[vert_idx]
            v_cgrn = canopy_grn_frac_grid[in_c[vert_idx], ie_c[vert_idx]]
            v_exg = exg[vert_idx]
            v_sat = sat[vert_idx]
            v_lum = lum[vert_idx]
            strike_deg = (np.degrees(np.arctan2(v_norm[:, 0], -v_norm[:, 1])) + 180.0) % 180.0

            def _extract_coplanar_wall_segments(pts_c, areas_c, hags_c, norms_c, bldg_c, bldg_fp_arr, cgrn_c, exg_c, sat_c, lum_c, depth=0):
                out_segs = []
                tot_a_c = float(areas_c.sum())
                if len(pts_c) < 8 or tot_a_c < 2.2:
                    return out_segs
                center_xy = np.average(pts_c[:, :2], axis=0, weights=areas_c)
                dxy = pts_c[:, :2] - center_xy
                # Determine true wall normal & strike direction from triangle 3D surface normals
                n_xy = norms_c[:, :2]
                n_cov = (n_xy * areas_c[:, None]).T @ n_xy
                nev, nvec = np.linalg.eigh(n_cov)
                nv1 = nvec[:, int(np.argmax(nev))]
                nv1 = nv1 / max(float(np.linalg.norm(nv1)), 1e-9)
                # Candidate 2: 2D spatial PCA minor axis (used when corrugated metal fence normals oscillate)
                p_cov = (dxy * areas_c[:, None]).T @ dxy
                pev, pvec = np.linalg.eigh(p_cov)
                nv2 = pvec[:, int(np.argmin(pev))]
                nv2 = nv2 / max(float(np.linalg.norm(nv2)), 1e-9)

                best_inlier_a = -1.0
                norm_vec = nv1
                best_inlier_mask = None
                cand_normals = (nv1, nv2) if (float(np.median(sat_c)) < 0.088 and float(np.median(lum_c)) > 0.48 and tot_a_c >= 10.0) else (nv1,)
                for cand_nv in cand_normals:
                    pn_cand = dxy @ cand_nv
                    for q_p in (15.0, 25.0, 35.0, 45.0, 50.0, 55.0, 65.0, 75.0, 85.0):
                        nc_val = float(np.percentile(pn_cand, q_p))
                        inl_m = np.abs(pn_cand - nc_val) <= 0.32
                        ia_val = float(areas_c[inl_m].sum())
                        if ia_val > best_inlier_a:
                            best_inlier_a = ia_val
                            norm_vec = cand_nv
                            best_inlier_mask = inl_m

                strike_vec = np.array([-norm_vec[1], norm_vec[0]])
                proj_s = dxy @ strike_vec
                proj_n = dxy @ norm_vec
                sigma_n = float(np.sqrt(np.average(proj_n ** 2, weights=areas_c)))
                s_min, s_max = float(np.percentile(proj_s, 2.0)), float(np.percentile(proj_s, 98.0))
                span_s = s_max - s_min

                # If background clutter inflated sigma_n on a large bright achromatic fence/wall, strip outliers to the dominant +-0.32m slab
                if (
                    sigma_n > 0.24
                    and best_inlier_mask is not None
                    and tot_a_c >= 12.0
                    and best_inlier_a >= max(9.5, 0.62 * tot_a_c)
                    and best_inlier_a < 0.97 * tot_a_c
                    and np.count_nonzero(best_inlier_mask) >= 12
                    and 5.0 <= span_s <= 26.0
                    and float(np.median(sat_c[best_inlier_mask])) < 0.085
                    and float(np.median(lum_c[best_inlier_mask])) > 0.48
                ):
                    rem_mask = ~best_inlier_mask
                    out_segs.extend(
                        _extract_coplanar_wall_segments(
                            pts_c[best_inlier_mask],
                            areas_c[best_inlier_mask],
                            hags_c[best_inlier_mask],
                            norms_c[best_inlier_mask],
                            bldg_c[best_inlier_mask],
                            bldg_fp_arr[best_inlier_mask],
                            cgrn_c[best_inlier_mask],
                            exg_c[best_inlier_mask],
                            sat_c[best_inlier_mask],
                            lum_c[best_inlier_mask],
                            depth + 1,
                        )
                    )
                    if depth < 5 and np.count_nonzero(rem_mask) >= 12 and float(areas_c[rem_mask].sum()) >= 6.0:
                        out_segs.extend(
                            _extract_coplanar_wall_segments(
                                pts_c[rem_mask],
                                areas_c[rem_mask],
                                hags_c[rem_mask],
                                norms_c[rem_mask],
                                bldg_c[rem_mask],
                                bldg_fp_arr[rem_mask],
                                cgrn_c[rem_mask],
                                exg_c[rem_mask],
                                sat_c[rem_mask],
                                lum_c[rem_mask],
                                depth + 1,
                            )
                        )
                    return out_segs

                if sigma_n > 0.25 and depth < 6:
                    n_p10, n_p90 = float(np.percentile(proj_n, 10.0)), float(np.percentile(proj_n, 90.0))
                    n_span_80 = n_p90 - n_p10
                    if span_s >= 5.0 and (span_s >= 2.5 * n_span_80 or n_span_80 < 1.35):
                        mid_s = 0.5 * (s_min + s_max)
                        ms1 = proj_s <= mid_s
                        ms2 = proj_s > mid_s
                        if np.count_nonzero(ms1) >= 8 and np.count_nonzero(ms2) >= 8:
                            out_segs.extend(_extract_coplanar_wall_segments(pts_c[ms1], areas_c[ms1], hags_c[ms1], norms_c[ms1], bldg_c[ms1], bldg_fp_arr[ms1], cgrn_c[ms1], exg_c[ms1], sat_c[ms1], lum_c[ms1], depth + 1))
                            out_segs.extend(_extract_coplanar_wall_segments(pts_c[ms2], areas_c[ms2], hags_c[ms2], norms_c[ms2], bldg_c[ms2], bldg_fp_arr[ms2], cgrn_c[ms2], exg_c[ms2], sat_c[ms2], lum_c[ms2], depth + 1))
                            return out_segs
                    if n_span_80 >= 0.85:
                        mid_n = 0.5 * (n_p10 + n_p90)
                        m1 = proj_n <= mid_n
                        m2 = proj_n > mid_n
                        if np.count_nonzero(m1) >= 8 and np.count_nonzero(m2) >= 8:
                            out_segs.extend(_extract_coplanar_wall_segments(pts_c[m1], areas_c[m1], hags_c[m1], norms_c[m1], bldg_c[m1], bldg_fp_arr[m1], cgrn_c[m1], exg_c[m1], sat_c[m1], lum_c[m1], depth + 1))
                            out_segs.extend(_extract_coplanar_wall_segments(pts_c[m2], areas_c[m2], hags_c[m2], norms_c[m2], bldg_c[m2], bldg_fp_arr[m2], cgrn_c[m2], exg_c[m2], sat_c[m2], lum_c[m2], depth + 1))
                            return out_segs
                    if span_s >= 5.0:
                        mid_s = 0.5 * (s_min + s_max)
                        ms1 = proj_s <= mid_s
                        ms2 = proj_s > mid_s
                        if np.count_nonzero(ms1) >= 8 and np.count_nonzero(ms2) >= 8:
                            out_segs.extend(_extract_coplanar_wall_segments(pts_c[ms1], areas_c[ms1], hags_c[ms1], norms_c[ms1], bldg_c[ms1], bldg_fp_arr[ms1], cgrn_c[ms1], exg_c[ms1], sat_c[ms1], lum_c[ms1], depth + 1))
                            out_segs.extend(_extract_coplanar_wall_segments(pts_c[ms2], areas_c[ms2], hags_c[ms2], norms_c[ms2], bldg_c[ms2], bldg_fp_arr[ms2], cgrn_c[ms2], exg_c[ms2], sat_c[ms2], lum_c[ms2], depth + 1))
                            return out_segs
                if sigma_n > 0.34 or span_s < 2.0:
                    return out_segs
                has_bldg = float(np.mean(bldg_c)) >= 0.15
                bldg_fp_m2 = float(np.max(bldg_fp_arr)) if len(bldg_fp_arr) > 0 else 0.0
                med_cgrn = float(np.median(cgrn_c))
                med_w_exg = float(np.median(exg_c))
                med_w_sat = float(np.median(sat_c))
                med_w_lum = float(np.median(lum_c))
                hag_p15 = float(np.percentile(hags_c, 15.0))
                hag_p90 = float(np.percentile(hags_c, 90.0))
                if not has_bldg:
                    is_bright_white_seg = (med_w_sat < 0.078 and med_w_lum > 0.54 and med_w_exg < 0.055 and hag_p15 <= 0.90 and sigma_n <= 0.22 and tot_a_c >= 8.0)
                    is_ground_retaining = (
                        (max_span > 180.0 and hag_p90 <= 6.5 and sigma_n <= 0.32)
                        or (hag_p90 >= 7.5 and sigma_n <= 0.25 and tot_a_c >= 5.0 and med_cgrn < 0.38 and med_w_exg <= 0.015)
                        or is_bright_white_seg
                    )
                    if not is_ground_retaining:
                        if med_cgrn >= 0.22 and (hag_p15 > 0.95 or sigma_n > 0.26 or med_w_exg >= 0.020):
                            return out_segs
                        if med_cgrn >= 0.06 and hag_p15 > 1.15 and hag_p90 < 6.5:
                            return out_segs
                        if med_cgrn >= 0.06 and sigma_n > 0.25 and hag_p90 < 5.0:
                            return out_segs
                out_segs.append((pts_c, areas_c, hags_c, norms_c, strike_vec, center_xy, proj_s, s_min, s_max, sigma_n, has_bldg, bldg_fp_m2))
                return out_segs

            raw_wall_candidates: List[Dict[str, Any]] = []
            for shift_deg in (0.0, 15.0):
                s_bins = (((strike_deg + shift_deg) % 180.0) // 30.0).astype(np.int32) % 6
                for b_id in range(6):
                    b_indices = np.nonzero(s_bins == b_id)[0]
                    if len(b_indices) < 10:
                        continue
                    pts_b = v_cent[b_indices]
                    areas_b = v_a3d[b_indices]
                    hags_b = v_hag[b_indices]
                    normals_b = v_norm[b_indices]
                    bldg_b = v_bldg[b_indices]
                    bldg_fp_b = v_bldg_fp[b_indices]
                    cgrn_b = v_cgrn[b_indices]
                    exg_b = v_exg[b_indices]
                    sat_b = v_sat[b_indices]
                    lum_b = v_lum[b_indices]

                    w_res = 0.50
                    wx = np.clip(((pts_b[:, 0] - e_min) / w_res).astype(np.int32), 0, int(span_e / w_res) + 1)
                    wy = np.clip(((pts_b[:, 1] - n_min) / w_res).astype(np.int32), 0, int(span_n / w_res) + 1)
                    w_grid_a = np.zeros((int(span_n / w_res) + 2, int(span_e / w_res) + 2), dtype=np.float32)
                    np.add.at(w_grid_a, (wy, wx), areas_b)
                    w_occ = binary_closing(w_grid_a >= 0.10, structure=np.ones((3, 3), dtype=bool))
                    w_lbl, n_wcomp = nd_label(w_occ)
                    if n_wcomp == 0:
                        continue
                    pt_cid = w_lbl[wy, wx]
                    for wc in range(1, n_wcomp + 1):
                        sel = pt_cid == wc
                        for seg in _extract_coplanar_wall_segments(pts_b[sel], areas_b[sel], hags_b[sel], normals_b[sel], bldg_b[sel], bldg_fp_b[sel], cgrn_b[sel], exg_b[sel], sat_b[sel], lum_b[sel]):
                            pts_w, areas_w, hags_w, norms_w, strike_vec, center_xy, proj_s, s_min, s_max, sigma_plane, has_bldg_w, bldg_fp_w = seg
                            w_area_3d = float(areas_w.sum())
                            wall_len_m = float(max(s_max - s_min, 1.5))
                            if w_area_3d < 2.5 or wall_len_m < 2.2 or (w_area_3d / wall_len_m) < 0.55:
                                continue

                            c_e, c_n = float(center_xy[0]), float(center_xy[1])
                            z_base = float(np.percentile(pts_w[:, 2] - hags_w, 25.0))
                            raw_p90_h = float(np.percentile(hags_w, 90.0))
                            raw_p10_h = float(np.percentile(hags_w, 10.0))
                            span_h = max(0.8, raw_p90_h - min(raw_p10_h, 0.5))
                            mean_h = float(np.clip(max(w_area_3d / max(wall_len_m, 1.0), span_h * 0.78), 0.6, max(min(raw_p90_h, 30.0), 0.8)))
                            max_h = round(min(max(raw_p90_h, mean_h), mean_h * 1.65, 32.0), 2)
                            z_top = z_base + mean_h

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

                            mean_nz_w = float(np.mean(np.abs(norms_w[:, 2])))
                            tilt_deg = round(90.0 - math.degrees(math.acos(min(1.0, mean_nz_w))), 1)
                            az_deg = round((math.degrees(math.atan2(strike_vec[0], strike_vec[1])) + 360.0) % 180.0, 1)

                            raw_wall_candidates.append(
                                {
                                    "id": "WL0",
                                    "name": "擋土牆/垂直牆面 WL0",
                                    "subtype": "retaining_wall" if (z_base < p45_site_h + 4.0 and max_h <= 4.5) else "structural_wall",
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
                                    "_strike_vec": strike_vec,
                                    "_has_bldg": has_bldg_w,
                                    "_bldg_fp_m2": bldg_fp_w,
                                }
                            )

            raw_wall_candidates.sort(
                key=lambda x: x["vertical_area_m2"] * (1.75 if (x["mean_height_m"] >= 1.45 and x["length_m"] >= 3.2) else 0.72),
                reverse=True,
            )
            for rw in raw_wall_candidates:
                c_e, c_n = rw["center_twd97"][0], rw["center_twd97"][1]
                s_vec = rw.pop("_strike_vec")
                has_bldg_rw = rw.pop("_has_bldg", False)
                bldg_fp_rw = rw.pop("_bldg_fp_m2", 0.0)
                rw_b = rw.get("base_polyline_twd97") or []
                rw_p0 = np.array([rw_b[0][0], rw_b[0][1]]) if len(rw_b) >= 2 else np.array([c_e, c_n])
                rw_p1 = np.array([rw_b[-1][0], rw_b[-1][1]]) if len(rw_b) >= 2 else np.array([c_e, c_n])
                sa0, sa1 = sorted([float(rw_p0 @ s_vec), float(rw_p1 @ s_vec)])
                is_dup = False
                n_taller_outer_parallel = 0
                for dw in walls_list:
                    dc_e, dc_n = dw["center_twd97"][0], dw["center_twd97"][1]
                    d_cen = math.hypot(c_e - dc_e, c_n - dc_n)
                    ang_diff = abs(rw["azimuth_deg"] - dw["azimuth_deg"])
                    ang_diff = min(ang_diff, 180.0 - ang_diff)
                    if ang_diff <= 20.0:
                        dv = np.array([c_e - dc_e, c_n - dc_n])
                        perp_d = abs(float(dv[0] * (-s_vec[1]) + dv[1] * s_vec[0]))
                        dw_b = dw.get("base_polyline_twd97") or []
                        dw_p0 = np.array([dw_b[0][0], dw_b[0][1]]) if len(dw_b) >= 2 else np.array([dc_e, dc_n])
                        dw_p1 = np.array([dw_b[-1][0], dw_b[-1][1]]) if len(dw_b) >= 2 else np.array([dc_e, dc_n])
                        sb0, sb1 = sorted([float(dw_p0 @ s_vec), float(dw_p1 @ s_vec)])
                        ov_len = max(0.0, min(sa1, sb1) - max(sa0, sb0))
                        perp_thresh = 2.6 if max(rw["mean_height_m"], dw["mean_height_m"]) >= 5.5 else 1.65
                        if perp_d <= perp_thresh and ov_len >= 0.32 * min(rw["length_m"], dw["length_m"]):
                            is_dup = True
                            break
                        if (
                            has_bldg_rw
                            and 0.0 < bldg_fp_rw < 250.0
                            and rw["mean_height_m"] < 1.95
                            and dw["mean_height_m"] >= 2.00
                            and perp_d <= 6.5
                            and ov_len >= 0.25 * min(rw["length_m"], dw["length_m"])
                        ):
                            n_taller_outer_parallel += 1
                    elif d_cen < 1.25 and ang_diff <= 25.0:
                        is_dup = True
                        break
                if has_bldg_rw and 0.0 < bldg_fp_rw < 250.0 and rw["mean_height_m"] < 1.95 and n_taller_outer_parallel >= 1:
                    is_dup = True
                if not is_dup:
                    walls_list.append(rw)
                    if len(walls_list) >= 38:
                        break

        for idx_wl, wl_obj in enumerate(walls_list, 1):
            wl_obj["id"] = f"WL{idx_wl}"
            wl_obj["name"] = f"擋土牆/垂直牆面 WL{idx_wl}"

        wall_occ_grid = np.zeros((ny, nx), dtype=bool)
        if np.any(vert_tri_mask):
            vt_sp = vert_tri_mask[splat_t_idx]
            wall_occ_grid[in_all[vt_sp], ie_all[vt_sp]] = True
            wall_occ_grid = binary_dilation(wall_occ_grid, structure=np.ones((5, 5), dtype=bool))
        # Rasterize PCA-confirmed retaining & building walls into coplanar_wall_grid with 1.4m buffer
        coplanar_wall_grid = np.zeros((ny, nx), dtype=bool)
        for wl_o in walls_list:
            b_pts_w = wl_o.get("base_polyline_twd97") or []
            for k_w in range(len(b_pts_w) - 1):
                p0_w, p1_w = b_pts_w[k_w], b_pts_w[k_w + 1]
                n_s_w = max(4, int(math.hypot(p1_w[0] - p0_w[0], p1_w[1] - p0_w[1]) / (res * 0.5)) + 1)
                for ts_w in np.linspace(0.0, 1.0, n_s_w):
                    we = p0_w[0] + ts_w * (p1_w[0] - p0_w[0])
                    wn = p0_w[1] + ts_w * (p1_w[1] - p0_w[1])
                    wix = int(np.clip((we - e_min) / res, 0, nx - 1))
                    wiy = int(np.clip((wn - n_min) / res, 0, ny - 1))
                    coplanar_wall_grid[wiy, wix] = True
        if np.any(coplanar_wall_grid):
            w_dil_px = max(3, int(round(1.4 / res)) * 2 + 1)
            coplanar_wall_grid = binary_dilation(coplanar_wall_grid, structure=np.ones((w_dil_px, w_dil_px), dtype=bool))

        # Pre-compute terrace-aware ground & base road mask before Trees so plaza/road false-tree filtering can reference road_grid
        on_ground = (np.abs(tri_hag) <= 0.42) | (
            (np.abs(tri_hag_local) <= 0.25) & (tri_hag <= 2.4) & (nz_abs >= 0.88)
        )
        road_tri_mask = np.zeros(n_tris, dtype=bool)
        road_grid_base = np.zeros((ny, nx), dtype=bool)
        road_near_12m_grid = np.zeros((ny, nx), dtype=bool)
        if max_span <= 180.0:
            paved_tri_mask = (
                on_ground
                & (nz_abs >= 0.88)
                & (tri_sigma_h <= 0.068)
                & (exg < 0.040)
                & (rb_diff >= -0.035)
                & (rb_diff <= 0.076)
                & (lum >= 0.15)
                & (lum <= 0.88)
                & (
                    ((sat <= 0.20) & (tri_sigma_l <= 0.088))
                    | ((nz_abs >= 0.92) & (tri_sigma_h <= 0.045) & (tri_sigma_l <= 0.18) & (sat <= 0.45) & (lum >= 0.22))
                )
            )
            road_tri_mask = paved_tri_mask.copy()
            road_grid_raw = np.zeros((ny, nx), dtype=bool)
            road_sp_mask = paved_tri_mask[splat_t_idx]
            road_grid_raw[in_all[road_sp_mask], ie_all[road_sp_mask]] = True
            road_grid_closed = binary_closing(road_grid_raw & raw_occ_closed, structure=np.ones((5, 5), dtype=bool))
            road_grid_closed = binary_closing(road_grid_closed, structure=np.ones((3, 3), dtype=bool))
            road_grid_base = binary_opening(road_grid_closed, structure=np.ones((3, 3), dtype=bool))
            g_cnt = np.zeros((ny, nx), dtype=np.float32)
            g_exg_sum = np.zeros((ny, nx), dtype=np.float32)
            g_rb_sum = np.zeros((ny, nx), dtype=np.float32)
            g_lum_sum = np.zeros((ny, nx), dtype=np.float32)
            og_sp = on_ground[splat_t_idx]
            if np.any(og_sp):
                t_og = splat_t_idx[og_sp]
                np.add.at(g_cnt, (in_all[og_sp], ie_all[og_sp]), 1.0)
                np.add.at(g_exg_sum, (in_all[og_sp], ie_all[og_sp]), exg[t_og].astype(np.float32))
                np.add.at(g_rb_sum, (in_all[og_sp], ie_all[og_sp]), rb_diff[t_og].astype(np.float32))
                np.add.at(g_lum_sum, (in_all[og_sp], ie_all[og_sp]), lum[t_og].astype(np.float32))
                w_cnt = uniform_filter(g_cnt, size=9)
                g_exg_m9 = uniform_filter(g_exg_sum, size=9) / np.maximum(w_cnt, 1e-5)
                g_rb_m9 = uniform_filter(g_rb_sum, size=9) / np.maximum(w_cnt, 1e-5)
                g_lum_m9 = uniform_filter(g_lum_sum, size=9) / np.maximum(w_cnt, 1e-5)
                turf_bed_grid = (w_cnt > 0.05) & (g_rb_m9 >= 0.052) & (g_exg_m9 >= 0.004) & (g_lum_m9 <= 0.568)
                turf_bed_grid = binary_closing(turf_bed_grid, structure=np.ones((5, 5), dtype=bool))
                road_grid_base = road_grid_base & (~turf_bed_grid)
            if np.any(road_grid_base):
                r_dil_12 = max(3, int(round(1.2 / res)) * 2 + 1)
                road_near_12m_grid = binary_dilation(road_grid_base, structure=np.ones((r_dil_12, r_dil_12), dtype=bool))

        # =================================================================================
        # CATEGORY 2: TREES + TRUNK DBH AT 1.3M (喬木與胸徑 DBH)
        # =================================================================================
        all_xy_tree = cKDTree(centroids[:, :2]) if max_span <= 180.0 else None

        def _has_neck_gap_bollard_at(cx_q: float, cy_q: float, th_g_q: float, idx_arr_q: np.ndarray, c_q: np.ndarray) -> bool:
            dt_q = np.hypot(c_q[:, 0] - cx_q, c_q[:, 1] - cy_q)
            z_rel_q = c_q[:, 2] - th_g_q
            n_low_base = int(np.count_nonzero((dt_q <= 1.05) & (z_rel_q >= 0.18) & (z_rel_q <= 0.75)))
            n_neck_steep = int(np.count_nonzero((dt_q <= 0.65) & (z_rel_q >= 0.78) & (z_rel_q <= 1.18) & (nz_abs[idx_arr_q] < 0.55)))
            if n_low_base >= 180 and (n_neck_steep < 12 or n_neck_steep < 0.035 * n_low_base):
                return True
            return False

        if max_span > 180.0:
            # Wide river-valley / forestry scan (e.g. QuChi Dam): preserve exact 3.6m forestry CHM segmentation
            canopy_mask = (hag_grid >= 1.8) & (ortho_exg > 0.032) & raw_occ_closed
            canopy_mask = binary_opening(canopy_mask, structure=np.ones((2, 2), dtype=bool))
            chm_smooth = gaussian_filter(np.where(canopy_mask, hag_grid, 0.0), sigma=max(1.2, 1.35 / res))
            win_pk = max(5, int(round(3.6 / res)) | 1)
            local_max = (
                (chm_smooth == maximum_filter(chm_smooth, size=(win_pk, win_pk)))
                & canopy_mask
                & (chm_smooth >= 2.2)
            )
            min_tree_dist_px = max(3.0, 3.2 / res)
            tree_ground_grid = h_dtm_grid
        else:
            # Urban / Campus / Park scan: Green Canopy + Pruned/Columnar Urban Park Tree Stems (excluding buildings & retaining walls)
            green_canopy_mask = (
                (
                    (hag_tree_grid >= 1.8)
                    | ((hag_tree_grid >= 1.55) & ((elev_exg_grid >= 0.038) | (ortho_exg >= 0.038)))
                )
                & (hag_tree_grid <= 16.5)
                & ((elev_exg_grid > 0.022) | (ortho_exg > 0.025))
                & (~bldg_occ_grid)
                & (~coplanar_wall_grid)
                & raw_occ_closed
            )
            green_canopy_mask = binary_opening(
                binary_closing(green_canopy_mask, structure=np.ones((3, 3), dtype=bool)),
                structure=np.ones((2, 2), dtype=bool),
            )

            pruned_stem_mask = np.zeros((ny, nx), dtype=bool)
            verified_stem_centers: List[Tuple[float, float]] = []
            stem_tri_cand = (
                (((tri_hag >= 0.45) & (tri_hag <= 1.95)) | ((tri_hag_local >= 0.45) & (tri_hag_local <= 1.95)))
                & (nz_abs < 0.48)
                & (exg > -0.095)
                & (exg < 0.260)
                & ((rb_diff >= 0.024) | (exg >= 0.028))
            )
            if np.any(stem_tri_cand):
                st_idx = np.nonzero(stem_tri_cand)[0]
                st_pts = centroids[st_idx]
                st_norms = normals[st_idx]
                st_a3d = area_3d[st_idx]
                st_sat = sat[st_idx]
                st_rb = rb_diff[st_idx]
                st_exg = exg[st_idx]
                st_grid_cnt = np.zeros((ny, nx), dtype=np.int32)
                st_grid_a3d = np.zeros((ny, nx), dtype=np.float32)
                np.add.at(st_grid_cnt, (in_c[st_idx], ie_c[st_idx]), 1)
                np.add.at(st_grid_a3d, (in_c[st_idx], ie_c[st_idx]), st_a3d)
                st_occ = binary_closing((st_grid_cnt >= 3) | (st_grid_a3d >= 0.07), structure=np.ones((2, 2), dtype=bool))
                st_occ = st_occ & (~bldg_occ_grid) & (~coplanar_wall_grid) & (hag_tree_grid >= 1.55) & (hag_tree_grid <= 16.5)
                st_lbl, n_st = nd_label(st_occ)
                if n_st > 0:
                    pt_st_cid = st_lbl[in_c[st_idx], ie_c[st_idx]]
                    for sc_id in range(1, n_st + 1):
                        sc_sel = pt_st_cid == sc_id
                        n_sc_pts = int(np.count_nonzero(sc_sel))
                        pts_sc = st_pts[sc_sel, :2]
                        span_sc = float(math.hypot(np.ptp(pts_sc[:, 0]), np.ptp(pts_sc[:, 1]))) if n_sc_pts >= 2 else 0.0
                        med_sc_sat = float(np.median(st_sat[sc_sel])) if n_sc_pts > 0 else 0.0
                        med_sc_rb = float(np.median(st_rb[sc_sel])) if n_sc_pts > 0 else 0.0
                        med_sc_exg = float(np.median(st_exg[sc_sel])) if n_sc_pts > 0 else 0.0
                        is_warm_or_grn_sc = (med_sc_rb >= 0.042) or (med_sc_exg >= 0.032)
                        min_sc_pts = 8 if (span_sc <= 1.25 and is_warm_or_grn_sc) else 12
                        if n_sc_pts < min_sc_pts or n_sc_pts > 2500:
                            continue
                        sc_a3d_sum = float(st_a3d[sc_sel].sum())
                        min_sc_a3d = 0.09 if (span_sc <= 1.25 and is_warm_or_grn_sc) else 0.16
                        if sc_a3d_sum < min_sc_a3d or sc_a3d_sum > 14.0:
                            continue
                        if span_sc < 0.06 or span_sc > 3.60:
                            continue
                        # Reject achromatic grey metal/concrete poles
                        if med_sc_sat < 0.118 and med_sc_rb < 0.038 and med_sc_exg < 0.025:
                            continue
                        # Verify radial normal dispersion: reject 2-fold planar walls and 4-fold square pillars
                        nxy_sc = st_norms[sc_sel, :2]
                        ang2_sc = np.arctan2(nxy_sc[:, 1], nxy_sc[:, 0]) * 2.0
                        ang4_sc = ang2_sc * 2.0
                        r2_sc = float(math.hypot(float(np.mean(np.cos(ang2_sc))), float(np.mean(np.sin(ang2_sc)))))
                        r4_sc = float(math.hypot(float(np.mean(np.cos(ang4_sc))), float(np.mean(np.sin(ang4_sc)))))
                        cov_sc = np.cov(pts_sc.T)
                        ev_sc = np.sort(np.maximum(np.linalg.eigvalsh(cov_sc), 1e-6))
                        aspect_sc = float(math.sqrt(ev_sc[1] / ev_sc[0]))
                        max_aspect_sc = 4.6 if (span_sc <= 1.65 and r2_sc <= 0.26 and is_warm_or_grn_sc) else 2.55
                        if aspect_sc > max_aspect_sc:
                            continue
                        max_r2_sc = 0.33 if (is_warm_or_grn_sc and med_sc_sat >= 0.14) else 0.30
                        max_r4_sc = 0.38 if (r2_sc <= 0.23 and is_warm_or_grn_sc) else 0.30
                        if r2_sc > max_r2_sc or r4_sc > max_r4_sc:
                            continue
                        med_sc_xy = np.median(pts_sc, axis=0)
                        sc_e, sc_n = float(med_sc_xy[0]), float(med_sc_xy[1])
                        if all_xy_tree is not None:
                            near_sc = all_xy_tree.query_ball_point([sc_e, sc_n], r=2.65)
                            if len(near_sc) >= 20:
                                idx_sc = np.array(near_sc, dtype=np.int32)
                                c_sc = centroids[idx_sc]
                                d_sc = np.hypot(c_sc[:, 0] - sc_e, c_sc[:, 1] - sc_n)
                                pi_sc = int(np.clip((sc_e - e_min) / res, 0, nx - 1))
                                pj_sc = int(np.clip((sc_n - n_min) / res, 0, ny - 1))
                                ann_sc = (d_sc >= 1.15) & (d_sc <= 2.65) & (nz_abs[idx_sc] >= 0.78) & ((tri_hag[idx_sc] <= 1.80) | (tri_hag_local[idx_sc] <= 0.45))
                                if np.count_nonzero(ann_sc) < 5:
                                    ann_sc = (d_sc >= 1.15) & (d_sc <= 2.65) & (nz_abs[idx_sc] >= 0.78)
                                z_ann_sc = c_sc[ann_sc, 2] if np.count_nonzero(ann_sc) >= 5 else c_sc[:, 2]
                                p15_sc, p30_sc, p85_sc = np.percentile(z_ann_sc, [15.0, 30.0, 85.0])
                                th_g_sc = min(float(h_dtm_local[pj_sc, pi_sc]), float(p30_sc)) if (p85_sc - p15_sc) <= 1.55 else float(np.percentile(z_ann_sc, 65.0))
                                if _has_neck_gap_bollard_at(sc_e, sc_n, th_g_sc, idx_sc, c_sc):
                                    continue
                        pruned_stem_mask |= (st_lbl == sc_id)
                        verified_stem_centers.append((sc_e, sc_n))

            canopy_mask = green_canopy_mask | pruned_stem_mask
            chm_smooth = gaussian_filter(np.minimum(hag_tree_grid, 16.5), sigma=max(0.85, 0.55 / res))
            win_pk = max(3, int(round(1.65 / res)) | 1)
            local_max = (
                (chm_smooth == maximum_filter(chm_smooth, size=(win_pk, win_pk)))
                & canopy_mask
                & (chm_smooth >= 1.55)
                & (hag_tree_grid >= 1.55)
                & (hag_tree_grid <= 16.5)
            )
            # Ensure every verified cylindrical stem cluster contributes its local height apex and is never suppressed by Gaussian smoothing
            if np.any(pruned_stem_mask):
                ps_lbl, n_ps = nd_label(pruned_stem_mask)
                for ps_id in range(1, n_ps + 1):
                    ps_js, ps_is = np.nonzero(ps_lbl == ps_id)
                    if len(ps_js) > 0:
                        best_p = int(np.argmax(hag_tree_grid[ps_js, ps_is]))
                        bj, bi = int(ps_js[best_p]), int(ps_is[best_p])
                        local_max[bj, bi] = True
                        chm_smooth[bj, bi] = max(float(chm_smooth[bj, bi]), float(np.max(hag_tree_grid[ps_js, ps_is])) + 2.5)
            min_tree_dist_px = max(2.5, 1.35 / res)
            tree_ground_grid = h_dtm_local

        pk_js, pk_is = np.nonzero(local_max)

        # Sort candidate tree peaks by height descending and enforce minimum crown spacing
        peak_order = np.argsort(-chm_smooth[pk_js, pk_is])
        kept_peaks: List[Tuple[int, int, float]] = []
        max_cand_peaks = 95 if max_span > 180.0 else 280
        for idx_p in peak_order:
            pj, pi = int(pk_js[idx_p]), int(pk_is[idx_p])
            ph = float(chm_smooth[pj, pi])
            if any(math.hypot(pi - ki, pj - kj) < min_tree_dist_px for kj, ki, _ in kept_peaks):
                continue
            kept_peaks.append((pj, pi, ph))
            if len(kept_peaks) >= max_cand_peaks:
                break

        # Pre-filter breast-height vertical trunk triangles
        bh_tri_mask = (
            ((tri_hag >= 0.95) & (tri_hag <= 1.85) & (nz_abs < 0.48))
            if max_span > 180.0
            else ((tri_hag_tree >= 0.65) & (tri_hag_tree <= 1.95) & (nz_abs < 0.50))
        )
        bh_pts = centroids[bh_tri_mask]
        bh_tree = cKDTree(bh_pts[:, :2]) if len(bh_pts) >= 6 else None

        trees_list: List[Dict[str, Any]] = []
        for t_idx, (pj, pi, ph) in enumerate(kept_peaks):
            te = float(e_min + (pi + 0.5) * res)
            tn = float(n_min + (pj + 0.5) * res)
            th_ground = float(tree_ground_grid[pj, pi])
            th_top = float(z_max_filled[pj, pi])
            tree_h = max(2.2 if max_span > 180.0 else 1.60, round(max(min(ph, 16.5), th_top - th_ground if max_span > 180.0 else min(th_top - th_ground, 16.5)), 2))

            # Urban 3D geometry, annular ground datum & stem centering (eliminates terrace steps, lamp posts, pillars & retaining walls)
            pre_stem_xy: Optional[Tuple[float, float]] = None
            is_verified_cyl = False
            trunk_is_warm_or_green = False
            is_occluded_giant_canopy = False
            med_ts_sat = 0.0
            med_ts_rb = 0.0
            med_ts_exg = 0.0
            n_trunk_steep = 0
            r2_ts = 1.0
            if max_span <= 180.0 and all_xy_tree is not None:
                near26_idx = all_xy_tree.query_ball_point([te, tn], r=2.65)
                if len(near26_idx) < 25:
                    continue
                idx_arr26 = np.array(near26_idx, dtype=np.int32)
                c26 = centroids[idx_arr26]
                d26 = np.hypot(c26[:, 0] - te, c26[:, 1] - tn)

                # Annular ring (1.15m..2.65m) near-ground elevation distribution (excludes elevated tree canopy leaves!)
                ann_flat_mask = (
                    (d26 >= 1.15)
                    & (d26 <= 2.65)
                    & (nz_abs[idx_arr26] >= 0.78)
                    & ((tri_hag[idx_arr26] <= 1.80) | (tri_hag_local[idx_arr26] <= 0.45))
                )
                if np.count_nonzero(ann_flat_mask) < 5:
                    ann_flat_mask = (d26 >= 1.15) & (d26 <= 2.65) & (nz_abs[idx_arr26] >= 0.78)
                z_ann = c26[ann_flat_mask, 2] if np.count_nonzero(ann_flat_mask) >= 5 else c26[:, 2]
                p15_ann, p30_ann, p85_ann = np.percentile(z_ann, [15.0, 30.0, 85.0])
                ann_relief = float(p85_ann - p15_ann)
                if ann_relief <= 1.55:
                    th_ground = min(th_ground, float(p30_ann))
                else:
                    th_ground = float(np.percentile(z_ann, 65.0))
                tree_h = round(min(max(1.60, float(np.percentile(c26[d26 <= 1.15, 2], 97.0)) - th_ground if np.any(d26 <= 1.15) else min(ph, 16.5)), 16.5), 2)

                stem_11_mask = (d26 <= 1.15) & (c26[:, 2] >= th_ground + 0.40) & (c26[:, 2] <= th_ground + 2.65) & (nz_abs[idx_arr26] < 0.58)
                n_stem_11 = int(np.count_nonzero(stem_11_mask))
                n_band1 = int(np.count_nonzero((d26 <= 1.05) & (c26[:, 2] >= th_ground + 0.40) & (c26[:, 2] <= th_ground + 1.35) & (nz_abs[idx_arr26] < 0.55)))
                n_band2 = int(np.count_nonzero((d26 <= 1.05) & (c26[:, 2] > th_ground + 1.35) & (c26[:, 2] <= th_ground + 2.35) & (nz_abs[idx_arr26] < 0.58)))
                has_neck_gap_init = _has_neck_gap_bollard_at(te, tn, th_ground, idx_arr26, c26)

                # If peak is on an overhanging crown lobe (n_band1 < 5 or n_band2 < 5 or neck gap), snap to nearest unclaimed cylindrical stem center within 2.65m
                if (n_stem_11 < 10 or n_band1 < 5 or n_band2 < 5 or has_neck_gap_init) and verified_stem_centers:
                    best_sc = None
                    best_sc_d = 2.65
                    for sc_e, sc_n in verified_stem_centers:
                        d_sc = math.hypot(te - sc_e, tn - sc_n)
                        if d_sc < best_sc_d and not any(math.hypot(sc_e - k["trunk_twd97"][0], sc_n - k["trunk_twd97"][1]) < 1.35 for k in trees_list):
                            best_sc = (sc_e, sc_n)
                            best_sc_d = d_sc
                    if best_sc is not None:
                        te, tn = best_sc
                        pi = int(np.clip((te - e_min) / res, 0, nx - 1))
                        pj = int(np.clip((tn - n_min) / res, 0, ny - 1))
                        near26_idx = all_xy_tree.query_ball_point([te, tn], r=2.65)
                        if len(near26_idx) < 20:
                            continue
                        idx_arr26 = np.array(near26_idx, dtype=np.int32)
                        c26 = centroids[idx_arr26]
                        d26 = np.hypot(c26[:, 0] - te, c26[:, 1] - tn)
                        ann_flat_mask = (
                            (d26 >= 1.15)
                            & (d26 <= 2.65)
                            & (nz_abs[idx_arr26] >= 0.78)
                            & ((tri_hag[idx_arr26] <= 1.80) | (tri_hag_local[idx_arr26] <= 0.45))
                        )
                        if np.count_nonzero(ann_flat_mask) < 5:
                            ann_flat_mask = (d26 >= 1.15) & (d26 <= 2.65) & (nz_abs[idx_arr26] >= 0.78)
                        z_ann = c26[ann_flat_mask, 2] if np.count_nonzero(ann_flat_mask) >= 5 else c26[:, 2]
                        p15_ann, p30_ann, p85_ann = np.percentile(z_ann, [15.0, 30.0, 85.0])
                        ann_relief = float(p85_ann - p15_ann)
                        th_ground = min(float(h_dtm_local[pj, pi]), float(p30_ann)) if ann_relief <= 1.55 else float(np.percentile(z_ann, 65.0))
                        if np.any(d26 <= 1.25):
                            th_top = float(np.percentile(c26[d26 <= 1.25, 2], 97.0))
                        tree_h = round(min(max(1.60, th_top - th_ground), 16.5), 2)
                        stem_11_mask = (d26 <= 1.15) & (c26[:, 2] >= th_ground + 0.40) & (c26[:, 2] <= th_ground + 2.65) & (nz_abs[idx_arr26] < 0.58)
                        n_stem_11 = int(np.count_nonzero(stem_11_mask))
                        n_band1 = int(np.count_nonzero((d26 <= 1.05) & (c26[:, 2] >= th_ground + 0.40) & (c26[:, 2] <= th_ground + 1.35) & (nz_abs[idx_arr26] < 0.55)))
                        n_band2 = int(np.count_nonzero((d26 <= 1.05) & (c26[:, 2] > th_ground + 1.35) & (c26[:, 2] <= th_ground + 2.35) & (nz_abs[idx_arr26] < 0.58)))
                        has_neck_gap_init = _has_neck_gap_bollard_at(te, tn, th_ground, idx_arr26, c26)
                if has_neck_gap_init:
                    continue

                if n_stem_11 >= 8:
                    med_st = np.median(c26[stem_11_mask, :2], axis=0)
                    pre_stem_xy = (float(med_st[0]), float(med_st[1]))

                t_cx, t_cy = pre_stem_xy if pre_stem_xy is not None else (te, tn)
                if _has_neck_gap_bollard_at(t_cx, t_cy, th_ground, idx_arr26, c26):
                    continue
                dt_26 = np.hypot(c26[:, 0] - t_cx, c26[:, 1] - t_cy)
                z_rel_26 = c26[:, 2] - th_ground
                trunk_slice_m = (dt_26 <= 0.68) & (z_rel_26 >= 0.45) & (z_rel_26 <= 1.90) & (nz_abs[idx_arr26] < 0.48)
                n_trunk_steep = int(np.count_nonzero(trunk_slice_m))
                if n_trunk_steep >= 8:
                    ts_idx_pre = idx_arr26[trunk_slice_m]
                    med_ts_sat = float(np.median(sat[ts_idx_pre]))
                    med_ts_rb = float(np.median(rb_diff[ts_idx_pre]))
                    med_ts_exg = float(np.median(exg[ts_idx_pre]))

                # Check if giant wide-canopy tree with dense low-hanging foliage occluding lower stem
                # Never allow is_occluded_giant_canopy if >= 65 bare grey trunk triangles are visible (e.g. Qihu T20/T14 utility pole under neighbor canopy)
                can_26_mask = (c26[:, 2] >= th_ground + 1.80) & (d26 <= 2.40)
                n_grn_26 = int(np.count_nonzero(can_26_mask & (exg[idx_arr26] >= 0.038)))
                grn_frac_26 = float(n_grn_26 / max(int(np.count_nonzero(can_26_mask)), 1))
                is_occluded_giant_canopy = (
                    (tree_h >= 5.5)
                    and (n_grn_26 >= 180)
                    and (grn_frac_26 >= 0.65)
                    and (n_trunk_steep < 65 or med_ts_rb >= 0.035 or med_ts_exg >= 0.022)
                )

                # Reject terrace-step / stair artifacts, low road bollards under overhanging crowns, corrugated walls, and overhanging crown lobes
                n_band3 = int(np.count_nonzero((d26 <= 1.25) & (c26[:, 2] > th_ground + 2.35) & (c26[:, 2] <= th_ground + 4.00)))
                min_z_105 = float(np.percentile(c26[d26 <= 1.05, 2], 15.0)) - th_ground if np.any(d26 <= 1.05) else 0.0
                n_flat_under = int(
                    np.count_nonzero((d26 <= 1.05) & (nz_abs[idx_arr26] >= 0.80) & (c26[:, 2] <= th_ground + 0.38))
                )
                if not is_occluded_giant_canopy and (
                    (n_stem_11 < 10 and ann_relief > 1.50)
                    or n_band1 > 2200
                    or n_band2 < 4
                    or (tree_h >= 5.2 and n_band3 < 6)
                    or (n_flat_under >= 7 and (n_band1 < 5 or n_band2 < 5))
                    or (n_stem_11 < 6 and min_z_105 > 2.20)
                    or (n_stem_11 < 10 and any(math.hypot(te - k["trunk_twd97"][0], tn - k["trunk_twd97"][1]) < 3.6 for k in trees_list))
                ):
                    continue

                r18_mask = d26 <= 1.80
                if np.count_nonzero(r18_mask) < 20:
                    continue
                idx_arr18 = idx_arr26[r18_mask]
                c18 = c26[r18_mask]
                d18 = d26[r18_mask]
                r09_mask = d18 <= 0.95
                if not np.any(r09_mask):
                    continue
                dz_09 = float(np.ptp(c18[r09_mask, 2]))
                if dz_09 < max(1.45, tree_h * 0.45):
                    continue

                # Use 95th percentile of elevated triangles (z - med_local_ground >= 0.85m) within r <= 1.15m so ground points never drag down young trees
                flat_ground_mask = nz_abs[idx_arr18] >= 0.78
                med_local_ground = float(np.median(c18[flat_ground_mask, 2])) if np.count_nonzero(flat_ground_mask) >= 8 else th_ground
                base_ref_z = min(med_local_ground, th_ground)
                r12_el_z = c18[(d18 <= 1.15) & ((c18[:, 2] - base_ref_z) >= 0.85), 2]
                if len(r12_el_z) < 6 or (float(np.percentile(r12_el_z, 95.0)) - base_ref_z) < 1.55:
                    continue

                # Require steep elevated foliage/trunk faces (nz_abs < 0.75, H >= 0.95m above th_ground) with radial normal spread
                steep_el_mask = ((c18[:, 2] - th_ground) >= 0.95) & (nz_abs[idx_arr18] < 0.75)
                n_steep_el = int(np.count_nonzero(steep_el_mask))
                if n_steep_el < 24:
                    continue
                steep_idx = idx_arr18[steep_el_mask]
                nxy_el = normals[steep_idx, :2]
                ang2_el = np.arctan2(nxy_el[:, 1], nxy_el[:, 0]) * 2.0
                r_conc_el = float(math.hypot(float(np.mean(np.cos(ang2_el))), float(np.mean(np.sin(ang2_el)))))
                if r_conc_el >= 0.44:
                    continue

                # Rule 1 & Rule 2: Inspect trunk slice (0.45m .. 1.90m, r <= 0.68m) for square pillars (R4) / planar walls (R2) and achromatic grey metal/concrete poles
                is_verified_cyl = any(math.hypot(t_cx - sc_e, t_cy - sc_n) <= 1.25 for sc_e, sc_n in verified_stem_centers)
                if n_trunk_steep >= 8:
                    ts_idx = idx_arr26[trunk_slice_m]
                    nxy_ts = normals[ts_idx, :2]
                    ang2_ts = np.arctan2(nxy_ts[:, 1], nxy_ts[:, 0]) * 2.0
                    ang4_ts = ang2_ts * 2.0
                    r2_ts = float(math.hypot(float(np.mean(np.cos(ang2_ts))), float(np.mean(np.sin(ang2_ts)))))
                    r4_ts = float(math.hypot(float(np.mean(np.cos(ang4_ts))), float(np.mean(np.sin(ang4_ts)))))
                    # Rule 1: Never Square Pillar (r4 > 0.38, or r4 > 0.30 unless warm/green & r2 <= 0.25) or Planar Wall/Post (r2 > 0.30/0.33)
                    max_r2_ts = 0.33 if (med_ts_rb >= 0.045 and med_ts_sat >= 0.15) else 0.30
                    if not is_occluded_giant_canopy and (
                        r2_ts > max_r2_ts
                        or r4_ts > 0.38
                        or (r4_ts > 0.30 and ((med_ts_rb < 0.042 and med_ts_exg < 0.030) or r2_ts > 0.25))
                    ):
                        continue
                    # Rule 2: Never Achromatic Grey/Silver Metal Lamp Post or Concrete Column (e.g. Qihu R3 posts & T20/T14)
                    if (not is_occluded_giant_canopy or n_trunk_steep >= 65) and (
                        med_ts_sat < 0.118 and med_ts_rb < 0.038 and med_ts_exg < 0.025
                    ):
                        continue
                    if (med_ts_rb >= 0.038 and med_ts_sat >= 0.118) or med_ts_exg >= 0.028:
                        trunk_is_warm_or_green = True

                # Rule 3: Mandatory Green Foliage Directly Above Trunk (eliminates bare poles & utility posts near distant trees)
                core_can_m = (dt_26 <= 0.95) & (z_rel_26 >= 1.30)
                n_core_can = int(np.count_nonzero(core_can_m))
                core_grn_m = core_can_m & (exg[idx_arr26] >= 0.036)
                n_core_grn = int(np.count_nonzero(core_grn_m))
                grn_frac_core = float(n_core_grn / max(n_core_can, 1))
                p75_core_exg = float(np.percentile(exg[idx_arr26[core_can_m]], 75.0)) if n_core_can >= 4 else 0.0

                grn_frac_el = float(np.mean(exg[steep_idx] >= 0.035))
                has_valid_green_crown = (
                    (n_core_grn >= 16 and grn_frac_core >= 0.30 and p75_core_exg >= 0.046)
                    or (tree_h >= 5.0 and n_grn_26 >= 65 and grn_frac_26 >= 0.42 and n_core_grn >= 10)
                )
                if not has_valid_green_crown:
                    # Allow dormant/pruned woody park tree when verified cylindrical or warm brown cylindrical stem
                    med_rb_el = float(np.median(rb_diff[steep_idx]))
                    min_w_d = min(
                        (math.hypot(t_cx - bp[0], t_cy - bp[1]) for wl_o in walls_list for bp in (wl_o.get("base_polyline_twd97") or [])),
                        default=999.0,
                    )
                    is_warm_cyl_stem = is_verified_cyl or (n_trunk_steep >= 8 and med_ts_rb >= 0.045 and r2_ts <= 0.22)
                    if (
                        not is_warm_cyl_stem
                        or r_conc_el > 0.26
                        or (med_rb_el < 0.042 and p75_core_exg < 0.025)
                        or n_steep_el < 24
                        or min_w_d < 3.2
                        or (n_core_grn < 4 and med_rb_el < 0.045)
                    ):
                        continue

                # Rule 4: Reject Wide Low Bollards / Bases (e.g. RosePark T28)
                base_low_m = (dt_26 <= 1.05) & (z_rel_26 >= 0.20) & (z_rel_26 <= 0.85)
                if np.count_nonzero(base_low_m) >= 12:
                    b_idx = idx_arr26[base_low_m]
                    r_p85_base = float(np.percentile(dt_26[base_low_m], 85.0))
                    med_b_sat = float(np.median(sat[b_idx]))
                    med_b_nz = float(np.median(nz_abs[b_idx]))
                    upper_stem_m = (dt_26 <= 0.48) & (z_rel_26 >= 1.00) & (z_rel_26 <= 1.85) & (nz_abs[idx_arr26] < 0.45) & ((rb_diff[idx_arr26] >= 0.038) | (exg[idx_arr26] >= 0.032))
                    if r_p85_base > 0.72 and med_b_sat < 0.155 and med_b_nz > 0.38 and int(np.count_nonzero(upper_stem_m)) < 14:
                        continue

                # Young / small tree verification (1.60m <= tree_h < 3.5m)
                if tree_h < 3.5:
                    if not (is_verified_cyl or (trunk_is_warm_or_green and n_core_grn >= 12 and grn_frac_core >= 0.30)):
                        continue

            # Estimate crown area & crown diameter around local peak
            r_search_px = max(3, int(round(min(6.5, max(1.8 if max_span > 180.0 else 1.5, tree_h * 0.42)) / res)))
            j0 = max(0, pj - r_search_px)
            j1 = min(ny - 1, pj + r_search_px)
            i0 = max(0, pi - r_search_px)
            i1 = min(nx - 1, pi + r_search_px)
            hag_src_c = hag_grid if max_span > 180.0 else hag_tree_grid
            sub_can = canopy_mask[j0 : j1 + 1, i0 : i1 + 1] & (
                hag_src_c[j0 : j1 + 1, i0 : i1 + 1] >= max(1.6 if max_span > 180.0 else 1.35, tree_h * 0.45)
            )
            yy, xx = np.ogrid[j0 : j1 + 1, i0 : i1 + 1]
            disk = ((yy - pj) ** 2 + (xx - pi) ** 2) <= (r_search_px ** 2)
            crown_px = max(4, int(np.count_nonzero(sub_can & disk)))
            crown_area_m2 = round(crown_px * cell_area, 2)
            crown_diam_m = round(2.0 * math.sqrt(crown_area_m2 / math.pi), 2)
            if max_span <= 180.0:
                ref_cx, ref_cy = pre_stem_xy if pre_stem_xy is not None else (te, tn)
                el_crown_pts = c26[((c26[:, 2] - th_ground) >= max(1.05, tree_h * 0.38)) & (d26 <= 2.4)]
                if len(el_crown_pts) >= 6:
                    span_3d_crown = float(
                        np.percentile(np.hypot(el_crown_pts[:, 0] - ref_cx, el_crown_pts[:, 1] - ref_cy), 88.0) * 2.0
                    )
                    crown_diam_m = round(max(crown_diam_m, min(tree_h * 0.85, max(1.15, span_3d_crown))), 2)
                    crown_area_m2 = round(max(crown_area_m2, math.pi * ((crown_diam_m * 0.5) ** 2)), 2)
                if crown_diam_m < 0.75 and not is_verified_cyl and not trunk_is_warm_or_green:
                    continue

            # Taiwan subtropical broadleaf allometric baseline from tree height & crown diameter
            est_dbh = 2.65 * (tree_h ** 0.92) * (max(crown_diam_m, 1.5) ** 0.36)
            max_allowed_dbh = min(95.0, tree_h * 4.8)

            # Breast-Height (1.3m) Trunk Slicing + 12-Sector Anti-Webbing Inner Radial Filter + Pratt Circle Fit
            dbh_cm = 0.0
            dbh_method = "crown_height_allometry"
            trunk_e, trunk_n = pre_stem_xy if pre_stem_xy is not None else (te, tn)
            min_slice_h = 6.5 if max_span > 180.0 else 1.65
            min_cand_pts = 8 if max_span > 180.0 else 6
            if tree_h >= min_slice_h and bh_tree is not None:
                r_bh_q = 0.78 if (max_span <= 180.0 and pre_stem_xy is not None) else min(2.2, max(1.05, crown_diam_m * 0.42))
                cand_idxs = bh_tree.query_ball_point([trunk_e, trunk_n], r=r_bh_q)
                if len(cand_idxs) >= min_cand_pts:
                    pts_local_bh = bh_pts[cand_idxs, :2]
                    # Center on median of breast-height stem points
                    med_xy = np.median(pts_local_bh, axis=0)
                    rel_xy = pts_local_bh - med_xy
                    dists_bh = np.hypot(rel_xy[:, 0], rel_xy[:, 1])
                    tight_mask = (dists_bh >= 0.03) & (dists_bh <= 0.72)
                    if np.count_nonzero(tight_mask) >= 6:
                        pts_stem = pts_local_bh[tight_mask]
                        med_xy = np.median(pts_stem, axis=0)
                        if max_span <= 180.0:
                            trunk_e, trunk_n = float(med_xy[0]), float(med_xy[1])
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
                                if 8.0 <= raw_diam_cm <= 110.0:
                                    trunk_e, trunk_n = float(cx_fit), float(cy_fit)
                                    if raw_diam_cm > est_dbh * 1.40 or raw_diam_cm < est_dbh * 0.45:
                                        blended_dbh = 0.35 * raw_diam_cm + 0.65 * est_dbh
                                        dbh_cm = round(float(np.clip(blended_dbh, 7.5, max_allowed_dbh)), 1)
                                        dbh_method = "pratt_allometric_hybrid"
                                    else:
                                        dbh_cm = round(float(np.clip(raw_diam_cm, 7.5, max_allowed_dbh)), 1)
                                        dbh_method = "pratt_circle_1.3m_slice"

            if max_span <= 180.0 and bh_tree is not None and len(bh_tree.query_ball_point([trunk_e, trunk_n], r=0.95)) > 2200:
                continue
            # Ensure refined trunk_e, trunk_n is not inside a building or retaining wall
            ti_chk = int(np.clip((trunk_e - e_min) / res, 0, nx - 1))
            tj_chk = int(np.clip((trunk_n - n_min) / res, 0, ny - 1))
            if max_span <= 180.0 and (bldg_occ_grid[tj_chk, ti_chk] or coplanar_wall_grid[tj_chk, ti_chk]):
                continue
            # Post-Pratt verification on final (trunk_e, trunk_n): re-verify neck continuity, Rule 2, Rule 4, and paved plaza filter
            if max_span <= 180.0 and all_xy_tree is not None:
                if _has_neck_gap_bollard_at(trunk_e, trunk_n, th_ground, idx_arr26, c26):
                    continue
                dt_fin = np.hypot(c26[:, 0] - trunk_e, c26[:, 1] - trunk_n)
                z_rel_fin = c26[:, 2] - th_ground
                ts_fin_m = (dt_fin <= 0.68) & (z_rel_fin >= 0.45) & (z_rel_fin <= 1.90) & (nz_abs[idx_arr26] < 0.48)
                n_ts_fin = int(np.count_nonzero(ts_fin_m))
                med_fin_sat = float(np.median(sat[idx_arr26[ts_fin_m]])) if n_ts_fin > 0 else med_ts_sat
                med_fin_rb = float(np.median(rb_diff[idx_arr26[ts_fin_m]])) if n_ts_fin > 0 else med_ts_rb
                med_fin_exg = float(np.median(exg[idx_arr26[ts_fin_m]])) if n_ts_fin > 0 else med_ts_exg
                if n_ts_fin >= 8 and (not is_occluded_giant_canopy or n_ts_fin >= 65) and (
                    med_fin_sat < 0.118 and med_fin_rb < 0.038 and med_fin_exg < 0.025
                ):
                    continue
                base_fin_m = (dt_fin <= 1.05) & (z_rel_fin >= 0.20) & (z_rel_fin <= 0.85)
                if np.count_nonzero(base_fin_m) >= 12:
                    bf_idx = idx_arr26[base_fin_m]
                    r_p85_bf = float(np.percentile(dt_fin[base_fin_m], 85.0))
                    med_bf_sat = float(np.median(sat[bf_idx]))
                    med_bf_nz = float(np.median(nz_abs[bf_idx]))
                    up_fin_m = (dt_fin <= 0.48) & (z_rel_fin >= 1.00) & (z_rel_fin <= 1.85) & (nz_abs[idx_arr26] < 0.45) & ((rb_diff[idx_arr26] >= 0.038) | (exg[idx_arr26] >= 0.032))
                    if r_p85_bf > 0.72 and med_bf_sat < 0.155 and med_bf_nz > 0.38 and int(np.count_nonzero(up_fin_m)) < 14:
                        continue
                # Reject small non-Pratt structures on paved plazas / concrete bases (e.g. Qihu R3 T43 & T45)
                if tree_h < 4.2:
                    in_road_12 = bool(road_near_12m_grid[tj_chk, ti_chk])
                    base04_m = (dt_fin <= 0.85) & (z_rel_fin >= 0.0) & (z_rel_fin <= 0.45)
                    n_base04 = int(np.count_nonzero(base04_m))
                    has_grey_concrete_base = False
                    if n_base04 >= 75:
                        b04_idx = idx_arr26[base04_m]
                        if float(np.median(sat[b04_idx])) < 0.085 and float(np.median(rb_diff[b04_idx])) < 0.030:
                            has_grey_concrete_base = True
                    if in_road_12 or has_grey_concrete_base:
                        n_neck_fin = int(np.count_nonzero((dt_fin <= 0.65) & (z_rel_fin >= 0.78) & (z_rel_fin <= 1.18) & (nz_abs[idx_arr26] < 0.55)))
                        is_valid_small_park_stem = (
                            not has_grey_concrete_base
                            and is_verified_cyl
                            and med_fin_rb >= 0.036
                            and med_fin_exg >= 0.026
                            and med_fin_sat >= 0.105
                            and 4 <= n_neck_fin <= 45
                        )
                        if not (
                            is_valid_small_park_stem
                            or (
                                med_fin_rb >= 0.042
                                and med_fin_sat >= 0.125
                                and n_neck_fin >= 18
                                and dbh_method != "crown_height_allometry"
                            )
                        ):
                            continue

            nms_dist_m = 1.35 if (max_span <= 180.0 and pre_stem_xy is not None) else 1.85
            if max_span <= 180.0 and any(
                math.hypot(trunk_e - k["trunk_twd97"][0], trunk_n - k["trunk_twd97"][1]) < nms_dist_m for k in trees_list
            ):
                continue

            if dbh_cm <= 0.0:
                dbh_cm = round(float(np.clip(est_dbh, 7.5, max_allowed_dbh)), 1)
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
            if len(trees_list) >= 145:
                break
        trees_list.sort(key=lambda x: (x["height_m"], x["dbh_cm"]), reverse=True)
        for idx_t, t_obj in enumerate(trees_list, 1):
            t_obj["id"] = f"T{idx_t}"
            t_obj["name"] = f"喬木 T{idx_t}"

        # =================================================================================
        # CATEGORY 1: ROADS (Road Surface / 道路鋪面)
        # =================================================================================
        roads_list: List[Dict[str, Any]] = []
        road_grid = road_grid_base.copy()
        if max_span <= 180.0:
            r_planter_px = max(2, int(round(0.90 / res)))
            yy_grid, xx_grid = np.ogrid[0:ny, 0:nx]
            for t_obj in trees_list:
                te_p, tn_p, _ = t_obj["trunk_twd97"]
                pi_t = int(np.clip((te_p - e_min) / res, 0, nx - 1))
                pj_t = int(np.clip((tn_p - n_min) / res, 0, ny - 1))
                planter_disk = ((yy_grid - pj_t) ** 2 + (xx_grid - pi_t) ** 2) <= (r_planter_px ** 2)
                road_grid[planter_disk] = False
            road_polys_raw = _mask_to_polygons(road_grid, min_area_m2=18.0, simplify_tol=0.35, z_ref_grid=h_dtm_local)

            for r_item in road_polys_raw:
                cmask = r_item.pop("comp_mask")
                if r_item["mean_width_m"] > 22.0:
                    continue
                # Reject narrow wall-base/fence-footing artifacts (e.g. Qihu R4 18.12m2 / 1.2m W along bottom construction fence)
                if r_item["mean_width_m"] < 1.55 and r_item["planar_area_m2"] < 28.0:
                    continue
                med_rb = float(np.median(ortho_rb_diff[cmask]))
                med_sat = float(np.median(ortho_sat[cmask]))
                med_lum = float(np.median(ortho_lum[cmask]))
                # Reject brown bare-soil excavation pits AND bright/bluish waterproofing tarps inside fenced pits (e.g. R4/R6 in QiHu)
                if med_rb > 0.064 or med_rb < -0.015 or med_lum > 0.65:
                    continue
                c_js, c_is = np.nonzero(cmask)
                pts_rc = np.column_stack([c_is * res, c_js * res])
                elongation = 1.0
                if len(pts_rc) >= 6:
                    cov = np.cov(pts_rc.T)
                    evals = np.sort(np.maximum(np.linalg.eigvalsh(cov), 1e-6))
                    elongation = float(math.sqrt(evals[1] / evals[0]))
                if elongation < 1.32 and r_item["planar_area_m2"] < 45.0:
                    continue
                if med_rb >= 0.052 and med_lum <= 0.568 and elongation < 2.2:
                    continue
                sample_cmask = binary_dilation(cmask, structure=np.ones((5, 5), dtype=bool)) if r_item["planar_area_m2"] < 65.0 else cmask
                in_comp_tri = sample_cmask[in_c, ie_c] & on_ground & (exg < 0.040)
                if np.any(in_comp_tri):
                    tri_med_rb = float(np.median(rb_diff[in_comp_tri]))
                    tri_med_sat = float(np.median(sat[in_comp_tri]))
                    tri_med_lum = float(np.median(lum[in_comp_tri]))
                    # Reject shaded brown dirt/mulch beds under tree groves (e.g. RosePark R2/R5) while preserving bright pebble-wash park plazas (QiHu R2)
                    if (tri_med_rb >= 0.050 and tri_med_lum <= 0.575) or (tri_med_rb > 0.062 and tri_med_sat > 0.160):
                        continue
                    if r_item["planar_area_m2"] > 450.0 and tri_med_rb > 0.048 and tri_med_sat > 0.145:
                        continue
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
                        "holes_twd97": r_item.get("holes_twd97", []),
                        "holes_local": r_item.get("holes_local", []),
                    }
                )
                if len(roads_list) >= 12:
                    break

        # Stage 1B: Fallback for unpaved rural/mountain compacted access roads (e.g. QuChi Dam) when paved area < 25 m2
        if sum(r["planar_area_m2"] for r in roads_list) < 25.0:
            dirt_road_tri_mask = (
                (np.abs(tri_hag) <= 0.38)
                & (nz_abs >= 0.88)
                & (tri_sigma_h <= 0.065)
                & (exg < 0.045)
                & (sat <= 0.22)
                & (lum >= 0.16)
                & (lum <= 0.82)
                & (tri_sigma_l <= 0.072)
            )
            road_tri_mask = dirt_road_tri_mask
            road_grid_raw = np.zeros((ny, nx), dtype=bool)
            road_grid_raw[in_c[dirt_road_tri_mask], ie_c[dirt_road_tri_mask]] = True
            road_grid = binary_closing(
                binary_opening(road_grid_raw & raw_occ_closed, structure=np.ones((2, 2), dtype=bool)),
                structure=np.ones((3, 3), dtype=bool),
            )
            road_polys_fallback = _mask_to_polygons(road_grid, min_area_m2=18.0, simplify_tol=0.35)
            roads_list = []
            for r_item in road_polys_fallback:
                cmask = r_item.pop("comp_mask")
                c_js, c_is = np.nonzero(cmask)
                pts_rc = np.column_stack([c_is * res, c_js * res])
                elongation = 1.0
                if len(pts_rc) >= 6:
                    cov = np.cov(pts_rc.T)
                    evals = np.sort(np.maximum(np.linalg.eigvalsh(cov), 1e-6))
                    elongation = float(math.sqrt(evals[1] / evals[0]))
                if elongation < 1.35 and r_item["planar_area_m2"] < 45.0:
                    continue
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
                        "holes_twd97": r_item.get("holes_twd97", []),
                        "holes_local": r_item.get("holes_local", []),
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
        # CATEGORY 3: WATER BODIES & UN-MODELLED WATER VOIDS (水體與未建模水域空洞)
        # =================================================================================
        water_list: List[Dict[str, Any]] = []
        # 3A: Detect Un-Modelled Water Voids (~raw_occ_closed) on wide river-valley / hydraulic dam scans (max_span > 180.0m)
        # and depressed pond/moat water channels on medium-span terrain scans (120.0m < max_span <= 180.0m, e.g. QiHu moat)
        if max_span > 120.0:
            is_midspan_moat_scan = max_span <= 180.0
            occ_js, occ_is = np.nonzero(raw_occ_closed)
            hull_2d_mask = np.zeros((ny, nx), dtype=bool)
            if len(occ_is) >= 12:
                try:
                    stride_h = max(1, len(occ_is) // 6000)
                    pts_occ_px = np.column_stack([occ_is[::stride_h], occ_js[::stride_h]]).astype(np.float64)
                    chull_occ = ConvexHull(pts_occ_px)
                    eqs = chull_occ.equations
                    grid_yy, grid_xx = np.mgrid[0:ny, 0:nx]
                    coords_flat = np.vstack([grid_xx.ravel(), grid_yy.ravel()]).astype(np.float64)
                    inside_flat = np.all((eqs[:, :2] @ coords_flat) + eqs[:, 2:3] <= -1.5, axis=0)
                    hull_2d_mask = inside_flat.reshape((ny, nx))
                except Exception:
                    hull_2d_mask = site_hull.copy()

            max_steps_35m = max(6, int(round(35.0 / res)))
            max_steps_26m = max(4, int(round(26.0 / res)))
            step_stride = 2 if res <= 0.30 else 1
            compass_pairs = [
                ((1, 0), (-1, 0)),
                ((0, 1), (0, -1)),
                ((1, 1), (-1, -1)),
                ((1, -1), (-1, 1)),
            ]
            dir_count_35m = np.zeros((ny, nx), dtype=np.int16)
            opp_pair_26m = np.zeros((ny, nx), dtype=np.int16)

            def _ray_hits_occupied(di: int, dj: int) -> Tuple[np.ndarray, np.ndarray]:
                hit26 = np.zeros((ny, nx), dtype=bool)
                hit35 = np.zeros((ny, nx), dtype=bool)
                diag_scale = 1.4142 if (di != 0 and dj != 0) else 1.0
                n_max_s = max(4, int(round(max_steps_35m / diag_scale)))
                n_26_s = max(3, int(round(max_steps_26m / diag_scale)))
                for s_px in range(step_stride, n_max_s + 1, step_stride):
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
                    hit35[dst_j0:dst_j1, dst_i0:dst_i1] |= sub_occ
                    if s_px <= n_26_s:
                        hit26[dst_j0:dst_j1, dst_i0:dst_i1] |= sub_occ
                return hit26, hit35

            for (di1, dj1), (di2, dj2) in compass_pairs:
                h26_1, h35_1 = _ray_hits_occupied(di1, dj1)
                h26_2, h35_2 = _ray_hits_occupied(di2, dj2)
                dir_count_35m += h35_1.astype(np.int16) + h35_2.astype(np.int16)
                opp_pair_26m += (h26_1 & h26_2).astype(np.int16)

            enclosed_void_cell = hull_2d_mask & (
                (dir_count_35m >= 6) & (opp_pair_26m >= 2)
            )

            margin_px = max(3, int(round(3.0 / res)))
            inner_box = np.zeros_like(raw_occ_closed, dtype=bool)
            inner_box[margin_px : ny - margin_px, margin_px : nx - margin_px] = True
            max_void_dist_m = 8.5 if is_midspan_moat_scan else 5.5
            void_candidate = (
                (~raw_occ_closed)
                & inner_box
                & enclosed_void_cell
                & (dist_cells * res <= max_void_dist_m)
                & (dist_cells * res >= 0.35)
                & (h_dtm_grid <= p18_site_h + 1.40)
            )
            void_labeled, n_voids = nd_label(void_candidate)
            occ_dilated_3 = binary_dilation(raw_occ_closed, structure=np.ones((3, 3), dtype=bool))
            min_v_area = 45.0 if is_midspan_moat_scan else 25.0
            max_v_area = 1600.0 if is_midspan_moat_scan else 1250.0
            max_diag_span = 125.0 if is_midspan_moat_scan else 68.0
            min_fill_ratio = 0.16 if is_midspan_moat_scan else 0.22
            min_touch_ratio = 0.85 if is_midspan_moat_scan else 0.55
            max_rim_iqr = 3.35 if is_midspan_moat_scan else 1.75
            for vid in range(1, n_voids + 1):
                vmask = void_labeled == vid
                v_area = float(np.count_nonzero(vmask) * cell_area)
                if v_area < min_v_area or v_area > max_v_area:
                    continue
                v_js, v_is = np.nonzero(vmask)
                if len(v_is) < 8:
                    continue
                bbox_w = float((int(v_is.max()) - int(v_is.min()) + 1) * res)
                bbox_h = float((int(v_js.max()) - int(v_js.min()) + 1) * res)
                diag_span = math.hypot(bbox_w, bbox_h)
                fill_ratio = v_area / max(bbox_w * bbox_h, 1.0)
                if diag_span > max_diag_span or fill_ratio < min_fill_ratio:
                    continue

                b_mask = binary_dilation(vmask, structure=np.ones((3, 3), dtype=bool)) & (~vmask)
                b_cnt = int(np.count_nonzero(b_mask))
                if b_cnt < 8:
                    continue
                touch_cnt = int(np.count_nonzero(b_mask & occ_dilated_3))
                if (float(touch_cnt) / float(b_cnt)) < min_touch_ratio:
                    continue

                rim_mask = binary_dilation(vmask, structure=np.ones((5, 5), dtype=bool)) & raw_occ_closed
                if np.count_nonzero(rim_mask) < 8:
                    continue
                rim_h = h_dtm_grid[rim_mask]
                rim_iqr = float(np.percentile(rim_h, 75.0) - np.percentile(rim_h, 15.0))
                if rim_iqr > max_rim_iqr:
                    continue
                if is_midspan_moat_scan and float(np.median(hag_grid[rim_mask])) > 0.60:
                    continue
                shoreline_h_p20 = float(np.percentile(rim_h, 20.0))
                shoreline_h_med = float(np.percentile(rim_h, 45.0))
                shoreline_elev_ok = (
                    (shoreline_h_p20 <= p18_site_h - 1.10)
                    if is_midspan_moat_scan
                    else (shoreline_h_p20 <= p25_site_h + 0.85)
                )
                if shoreline_elev_ok:
                    h_margin = 2.2 if is_midspan_moat_scan else 1.5
                    dist_cap = 8.5 if is_midspan_moat_scan else 7.5
                    min_poly_area = 35.0 if is_midspan_moat_scan else 22.0
                    min_poly_fill = 0.15 if is_midspan_moat_scan else 0.22
                    low_void_mask = vmask & (h_dtm_grid <= shoreline_h_med + h_margin) & (dist_cells * res <= dist_cap)
                    low_void_mask = binary_closing(low_void_mask, structure=np.ones((3, 3), dtype=bool)) & (~raw_occ_closed)
                    eroded_v = binary_erosion(low_void_mask, structure=np.ones((2, 2), dtype=bool))
                    if np.count_nonzero(eroded_v) * cell_area >= min_poly_area:
                        low_void_mask = eroded_v
                    v_polys = _mask_to_polygons(
                        low_void_mask,
                        min_area_m2=min_poly_area,
                        fixed_z=round(shoreline_h_p20, 3),
                        simplify_tol=0.38,
                    )
                    for vp in v_polys:
                        vp_cm = vp.pop("comp_mask", None)
                        if vp["planar_area_m2"] > max_v_area:
                            continue
                        if vp_cm is not None:
                            pj, pi = np.nonzero(vp_cm)
                            if len(pi) >= 4:
                                pw = float((int(pi.max()) - int(pi.min()) + 1) * res)
                                ph = float((int(pj.max()) - int(pj.min()) + 1) * res)
                                if math.hypot(pw, ph) > max_diag_span or (vp["planar_area_m2"] / max(pw * ph, 1.0)) < min_poly_fill:
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

        # 3B: Detect Modelled Flat Spectral Water Basins (genuine cyan/blue water NDWI > 0.11, B > R, hydrostatically flat, non-road)
        spec_water_mask = (
            raw_occ_closed
            & (hag_grid <= 0.35)
            & (ortho_ndwi > 0.11)
            & (ortho_sat >= 0.14)
            & (ortho_rgb[:, :, 2] > ortho_rgb[:, :, 0])
            & (ortho_exg < 0.03)
            & (ortho_lum <= 0.48)
            & (~road_grid)
            & (h_dtm_grid <= p25_site_h + 2.0)
        )
        spec_water_mask = binary_opening(spec_water_mask, structure=np.ones((2, 2), dtype=bool))
        for sp in _mask_to_polygons(spec_water_mask, min_area_m2=35.0, simplify_tol=0.40):
            cm = sp.pop("comp_mask")
            if sp["mean_width_m"] < 2.8 or float(np.std(h_dtm_grid[cm])) > 0.12:
                continue
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
        # CATEGORY 5: EXTENDED CIVIL CATEGORIES (Stockpiles/Bare Earth, Sloped Revetments,
        #             Low Vegetation/Grass, Buildings/Structures, Drainage/Curbs, Clutter)
        # =================================================================================
        # 1. Bare Earth & Stockpiles / Gravel Bars (裸露土石/河灘卵石/堆置場)
        bare_tri = (tri_hag <= 1.5) & (nz_abs >= 0.72) & (exg < 0.04) & (~road_tri_mask)
        bare_area_2d = float(area_2d[bare_tri].sum())
        bare_area_3d = float(area_3d[bare_tri].sum())

        # Extract compact elevated Material Stockpile Mounds / Earthwork Pads (S1..S6), excluding terraces, walls, buildings & blue/white tarps
        stockpiles_list: List[Dict[str, Any]] = []
        if max_span > 180.0:
            mound_grid = (
                raw_occ_closed
                & (hag_grid >= 0.22)
                & (hag_grid <= 4.2)
                & (ortho_exg < 0.042)
                & (~road_grid)
            )
            mound_grid = binary_closing(
                binary_opening(mound_grid, structure=np.ones((2, 2), dtype=bool)),
                structure=np.ones((2, 2), dtype=bool),
            )
            for sp_item in _mask_to_polygons(mound_grid, min_area_m2=15.0, simplify_tol=0.40):
                cm_s = sp_item.pop("comp_mask")
                if sp_item["planar_area_m2"] < 15.0 or sp_item["planar_area_m2"] > 550.0:
                    continue
                est_vol = round(float(np.sum(np.clip(hag_grid[cm_s], 0.15, 3.5)) * cell_area * 0.65), 1)
                sid_s = f"S{len(stockpiles_list) + 1}"
                stockpiles_list.append(
                    {
                        "id": sid_s,
                        "name": f"土石堆置區 {sid_s} (Material Stockpile Mound)",
                        "planar_area_m2": sp_item["planar_area_m2"],
                        "planar_area_ping": sp_item["planar_area_ping"],
                        "estimated_volume_m3": est_vol,
                        "center_twd97": sp_item["center_twd97"],
                        "center_local": sp_item["center_local"],
                        "boundary_twd97": sp_item["boundary_twd97"],
                        "boundary_local": sp_item["boundary_local"],
                    }
                )
                if len(stockpiles_list) >= 8:
                    break
        else:
            mound_grid = (
                raw_occ_closed
                & (hag_local_grid >= 0.35)
                & (hag_local_grid <= 3.6)
                & (ortho_exg < 0.032)
                & (elev_exg_grid < 0.032)
                & (ortho_rb_diff >= -0.015)
                & (~road_grid)
                & (~canopy_mask)
                & (~wall_occ_grid)
                & (~bldg_occ_grid)
            )
            mound_grid = binary_closing(
                binary_opening(mound_grid, structure=np.ones((3, 3), dtype=bool)),
                structure=np.ones((3, 3), dtype=bool),
            )
            for sp_item in _mask_to_polygons(mound_grid, min_area_m2=15.0, simplify_tol=0.40, z_ref_grid=h_dtm_local):
                cm_s = sp_item.pop("comp_mask")
                if sp_item["planar_area_m2"] < 15.0 or sp_item["planar_area_m2"] > 280.0:
                    continue
                s_js, s_is = np.nonzero(cm_s)
                if len(s_is) < 8:
                    continue
                s_bw = float((int(s_is.max()) - int(s_is.min()) + 1) * res)
                s_bh = float((int(s_js.max()) - int(s_js.min()) + 1) * res)
                s_fill = sp_item["planar_area_m2"] / max(s_bw * s_bh, 1.0)
                if s_fill < 0.28:
                    continue
                pts_sc_m = np.column_stack([s_is * res, s_js * res])
                cov_sm = np.cov(pts_sc_m.T)
                ev_sm = np.sort(np.maximum(np.linalg.eigvalsh(cov_sm), 1e-6))
                elong_sm = float(math.sqrt(ev_sm[1] / ev_sm[0]))
                if elong_sm > 3.6:
                    continue
                # Require genuine 3D mound convexity: interior 75th-percentile height must rise >= +0.32m above outer toe rim
                rim_s = binary_dilation(cm_s, structure=np.ones((5, 5), dtype=bool)) & (~cm_s) & raw_occ_closed
                if np.count_nonzero(rim_s) < 6:
                    continue
                int_p75 = float(np.percentile(z_max_filled[cm_s], 75.0))
                rim_p35 = float(np.percentile(z_min_filled[rim_s], 35.0))
                if (int_p75 - rim_p35) < 0.32:
                    continue
                est_vol = round(float(np.sum(np.clip(hag_local_grid[cm_s], 0.15, 3.5)) * cell_area * 0.65), 1)
                sid_s = f"S{len(stockpiles_list) + 1}"
                stockpiles_list.append(
                    {
                        "id": sid_s,
                        "name": f"土石堆置區 {sid_s} (Material Stockpile Mound)",
                        "planar_area_m2": sp_item["planar_area_m2"],
                        "planar_area_ping": sp_item["planar_area_ping"],
                        "estimated_volume_m3": est_vol,
                        "center_twd97": sp_item["center_twd97"],
                        "center_local": sp_item["center_local"],
                        "boundary_twd97": sp_item["boundary_twd97"],
                        "boundary_local": sp_item["boundary_local"],
                    }
                )
                if len(stockpiles_list) >= 8:
                    break
        stockpiles_list.sort(key=lambda x: x["planar_area_m2"], reverse=True)
        stockpiles_list = stockpiles_list[:6]
        for idx_s, sp_obj in enumerate(stockpiles_list, 1):
            sp_obj["id"] = f"S{idx_s}"
            sp_obj["name"] = f"土石堆置區 S{idx_s} (Material Stockpile Mound)"

        # 2. Low Vegetation / Grass / Shrubs (低矮植生與草坡)
        grass_tri = (
            ((tri_hag < 1.8) & (exg >= 0.04) & (nz_abs >= 0.55))
            if max_span > 180.0
            else ((tri_hag_tree < 1.8) & (exg >= 0.032) & (nz_abs >= 0.55))
        )
        grass_area_2d = float(area_2d[grass_tri].sum())
        grass_area_3d = float(area_3d[grass_tri].sum())

        # 3. Sloped Revetments & Engineered Embankments (30 deg - 68 deg, 護岸斜坡與邊坡)
        revet_tri = (nz_abs >= 0.37) & (nz_abs < 0.84) & (exg < 0.045)
        revet_area_2d = float(area_2d[revet_tri].sum())
        revet_area_3d = float(area_3d[revet_tri].sum())

        # 4. Buildings / Roofs / Pavilions (建築物與棚架屋頂)
        bldg_tri = ((tri_hag if max_span > 180.0 else tri_hag_tree) >= 2.2) & (nz_abs >= 0.78) & (exg < 0.035) & (tri_sigma_h <= 0.12)
        bldg_area_2d = float(area_2d[bldg_tri].sum())
        bldg_area_3d = float(area_3d[bldg_tri].sum())

        # 5. Drainage Channels & Curbs (排水溝渠與緣石)
        hag_curb_src = tri_hag if max_span > 180.0 else tri_hag_local
        curb_tri = (hag_curb_src >= 0.08) & (hag_curb_src < 0.35) & (nz_abs >= 0.34) & (nz_abs < 0.72) & (exg < 0.04)
        curb_area_2d = float(area_2d[curb_tri].sum())
        curb_area_3d = float(area_3d[curb_tri].sum())

        # 6. Transient Clutter / Vehicles / Construction Equipment (施工機具/車輛與雜物)
        clutter_tri = (
            (hag_curb_src >= 0.45)
            & (hag_curb_src <= 3.8)
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
        if max_span > 180.0:
            canopy_tri = (tri_hag >= 1.8) & (exg >= 0.032)
            canopy_area_2d = float(area_2d[canopy_tri].sum())
            canopy_area_3d = float(area_3d[canopy_tri].sum())
        else:
            canopy_tri = (tri_hag_tree >= 1.8) & (exg >= 0.024)
            canopy_area_2d = max(float(area_2d[canopy_tri].sum()), float(sum(t["crown_area_m2"] for t in trees_list)))
            canopy_area_3d = max(float(area_3d[canopy_tri].sum()), canopy_area_2d * 1.35)

        roads_planar_total = round(sum(r["planar_area_m2"] for r in roads_list), 2)
        roads_3d_total = round(sum(r["surface_area_3d_m2"] for r in roads_list), 2)
        water_planar_total = round(sum(w["planar_area_m2"] for w in water_list), 2)
        water_lvl_primary = water_list[0]["water_level_twvd2001_m"] if water_list else None
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
        html_name = f"categorization_report_{scan_id}.html"
        csv_name = f"categorization_report_{scan_id}.csv"
        dxf_name = f"Civil3D_Categorized_{scan_id}.dxf"

        result = {
            "ok": True,
            "status": "ok",
            "has_categorization": True,
            "saved_on_server": True,
            "from_server_cache": False,
            "overlay_visible_default": False,
            "layer_filters": {
                "roads": True,
                "trees": True,
                "water": True,
                "walls": True,
                "stockpiles": True,
            },
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
            "manual_overrides": {
                "removed_ids": [],
                "removed_centers": [],
                "added_trees": [],
                "added_walls": [],
                "added_roads": [],
                "added_water": [],
            },
        }

        if preserved_overrides:
            result = self._apply_manual_overrides_to_categorization(scan_id, result, preserved_overrides)

        self._write_categorization_deliverables(result, html_name, csv_name, dxf_name)
        self._persist_categorization_result(scan_id, result, scan)

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

        water_kpi_sub = (
            f"Shoreline TWVD2001 +{float(s['water_level_twvd2001_m']):.2f} m"
            if s.get("water_level_twvd2001_m") is not None and s.get("water_count", 0) > 0
            else "無水域空洞 (No Water Bodies)"
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
      <div class="kpi-label">{water_kpi_sub}</div>
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



