#!/usr/bin/env python3
"""
GatheringScans Per-Vertex Terrain & Government DEM Draping Engine for Public Utilities
(pc_worker/surveying/utilities_elevation.py)
======================================================================================
Provides multi-source bare-earth terrain elevation sampling and topological 3D draping
for 2D/3D public and user-imported utilities:
1. Scan Bare-Earth DTM Grid extraction from `_dsm_cache_v5.npz` (with morphological lower-envelope
   canopy/roof removal and categorized road/waterway constraints).
2. Spatial Government Elevation API Grid:
   - Taipei City official 3D Bare-Earth Elevation API (`3dgis.reac.taipei/sgwptools/API3D/get3dz.ashx`)
   - Taiwan-wide batch 30m DEM API (`api.open-meteo.com/v1/elevation`) calibrated to the scan's
     local TWVD2001 bare-earth ground reference datum.
   - Surveyed Government Manhole Rim Elevations (`MH_TOPEL`).
3. Per-vertex polyline draping, long-segment terrain subdivision, and manhole-to-pipe node locking.
"""

from __future__ import annotations

import os
import json
import math
import ssl
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, Any, List, Tuple, Optional, Callable

import numpy as np
try:
    from scipy.ndimage import (
        percentile_filter,
        gaussian_filter,
        distance_transform_edt,
    )
    _HAS_SCIPY = True
except ImportError:
    _HAS_SCIPY = False

    def percentile_filter(arr, percentile=22, size=5):
        from numpy.lib.stride_tricks import sliding_window_view
        pad = max(1, int(size) // 2)
        padded = np.pad(arr, pad, mode="edge")
        win = sliding_window_view(padded, (2 * pad + 1, 2 * pad + 1))
        return np.percentile(win, percentile, axis=(-2, -1)).astype(np.float32)

    def gaussian_filter(arr, sigma=1.0):
        # Fast 3x3 separable box blur approximation
        padded = np.pad(arr, 1, mode="edge")
        return (
            padded[:-2, :-2] + 2 * padded[:-2, 1:-1] + padded[:-2, 2:]
            + 2 * padded[1:-1, :-2] + 4 * padded[1:-1, 1:-1] + 2 * padded[1:-1, 2:]
            + padded[2:, :-2] + 2 * padded[2:, 1:-1] + padded[2:, 2:]
        ).astype(np.float32) / 16.0

    def distance_transform_edt(mask_inv, return_indices=False):
        ny, nx = mask_inv.shape
        dist = np.where(mask_inv, 25.0, 0.0).astype(np.float32)
        if not return_indices:
            return dist
        iy, ix = np.indices((ny, nx))
        return dist, np.stack([iy, ix], axis=0)

from pc_worker.config import DATA_DIR, LOCAL_SCANS_ROOT as SCANS_ROOT_DIR
from pc_worker.surveying.dsm_and_volume import safe_float, twd97_to_wgs84

UTILITIES_CACHE_DIR = os.path.join(DATA_DIR, "utilities_cache")
GOV_DEM_CACHE_FILE = os.path.join(UTILITIES_CACHE_DIR, "_gov_dem_cache_v1.json")

# In-memory caches for sub-millisecond repeat queries
_GOV_DEM_MEM_CACHE: Optional[Dict[str, float]] = None
_BARE_EARTH_DTM_MEM_CACHE: Dict[str, Tuple[float, Dict[str, Any]]] = {}


def _load_gov_dem_disk_cache() -> Dict[str, float]:
    global _GOV_DEM_MEM_CACHE
    if _GOV_DEM_MEM_CACHE is not None:
        return _GOV_DEM_MEM_CACHE
    _GOV_DEM_MEM_CACHE = {}
    if os.path.isfile(GOV_DEM_CACHE_FILE):
        try:
            with open(GOV_DEM_CACHE_FILE, "r", encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict):
                for k, v in raw.items():
                    fv = safe_float(v)
                    if fv is not None:
                        _GOV_DEM_MEM_CACHE[str(k)] = round(fv, 3)
        except Exception:
            pass
    return _GOV_DEM_MEM_CACHE


def _save_gov_dem_disk_cache() -> None:
    if _GOV_DEM_MEM_CACHE is None:
        return
    try:
        os.makedirs(UTILITIES_CACHE_DIR, exist_ok=True)
        with open(GOV_DEM_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(_GOV_DEM_MEM_CACHE, f, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        pass


def _query_taipei_3d_elevation_pt(e_twd: float, n_twd: float) -> Optional[float]:
    """Queries Taipei City 3dgis.reac.taipei get3dz.ashx bare-earth elevation with disk cache."""
    if not (296000.0 <= e_twd <= 318000.0 and 2762000.0 <= n_twd <= 2789000.0):
        return None
    cache = _load_gov_dem_disk_cache()
    qe = int(round(e_twd / 25.0) * 25)
    qn = int(round(n_twd / 25.0) * 25)
    key = f"tpe_{qe}_{qn}"
    if key in cache:
        return cache[key]
    url = f"https://3dgis.reac.taipei/sgwptools/API3D/get3dz.ashx?E={qe:.2f}&N={qn:.2f}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "GatheringScans-Civil-GIS/3.0"})
        with urllib.request.urlopen(req, timeout=2.5) as resp:
            txt = resp.read().decode("utf-8", errors="ignore").strip()
        val = safe_float(txt)
        if val is not None and -15.0 <= val <= 1500.0:
            res_v = round(val, 3)
            cache[key] = res_v
            return res_v
    except Exception:
        pass
    return None


def _query_open_meteo_dem_batch(pts_twd: List[Tuple[float, float]]) -> List[Optional[float]]:
    """
    Queries Taiwan-wide 30m SRTM/ALOS terrain elevations in a single batch HTTP request
    via api.open-meteo.com/v1/elevation, with persistent disk caching.
    """
    if not pts_twd:
        return []
    cache = _load_gov_dem_disk_cache()
    results: List[Optional[float]] = [None] * len(pts_twd)
    missing_indices: List[int] = []
    missing_lats: List[str] = []
    missing_lons: List[str] = []
    missing_keys: List[str] = []

    for idx, (e_val, n_val) in enumerate(pts_twd):
        qe = int(round(e_val / 40.0) * 40)
        qn = int(round(n_val / 40.0) * 40)
        key = f"dem_{qe}_{qn}"
        if key in cache:
            results[idx] = cache[key]
        else:
            lat, lon = twd97_to_wgs84(float(qe), float(qn))
            missing_indices.append(idx)
            missing_lats.append(f"{lat:.6f}")
            missing_lons.append(f"{lon:.6f}")
            missing_keys.append(key)

    if missing_indices:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        dirty = False
        # Batch up to 64 points per HTTP request
        for b_start in range(0, len(missing_indices), 64):
            b_idx = missing_indices[b_start : b_start + 64]
            b_lats = missing_lats[b_start : b_start + 64]
            b_lons = missing_lons[b_start : b_start + 64]
            b_keys = missing_keys[b_start : b_start + 64]
            url = (
                "https://api.open-meteo.com/v1/elevation?"
                f"latitude={','.join(b_lats)}&longitude={','.join(b_lons)}"
            )
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "GatheringScans-Civil-GIS/3.0"})
                with urllib.request.urlopen(req, context=ctx, timeout=3.2) as resp:
                    if resp.status == 200:
                        doc = json.loads(resp.read().decode("utf-8", errors="ignore"))
                        elevs = doc.get("elevation") if isinstance(doc, dict) else None
                        if isinstance(elevs, list) and len(elevs) == len(b_idx):
                            for sub_i, orig_i in enumerate(b_idx):
                                ev = safe_float(elevs[sub_i])
                                if ev is not None and -50.0 <= ev <= 4000.0:
                                    rv = round(ev, 3)
                                    results[orig_i] = rv
                                    cache[b_keys[sub_i]] = rv
                                    dirty = True
            except Exception:
                pass
        if dirty:
            _save_gov_dem_disk_cache()

    return results


class UtilitiesElevationMixin:
    """
    Mixin providing multi-source bare-earth DSM + Government DEM elevation sampling
    and per-vertex 3D topological utility draping.
    """

    def _build_scan_bare_earth_dtm(
        self,
        scan_id: str,
        scan: Optional[Dict[str, Any]],
        ce: float,
        cn: float,
        ch: float,
        cat_data: Optional[Dict[str, Any]],
        min_street_floor_h: Optional[float] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Extracts a bare-earth Digital Terrain Model (DTM) heightfield from the scan's `_dsm_cache_v5.npz`
        by applying a morphological lower-percentile canopy/building filter and anchoring to categorized roads.
        """
        if not scan_id:
            return None
        sc = dict(scan) if isinstance(scan, dict) else {}
        if not sc.get("project_dir") and hasattr(self, "_resolve_scan_record"):
            try:
                sc = self._resolve_scan_record(scan_id) or sc
            except Exception:
                pass

        proj_dir = sc.get("project_dir") or os.path.join(SCANS_ROOT_DIR, scan_id)
        npz_path = os.path.join(proj_dir, "_dsm_cache_v5.npz") if (proj_dir and os.path.isdir(proj_dir)) else ""
        mtime = os.path.getmtime(npz_path) if (npz_path and os.path.isfile(npz_path)) else 0.0
        floor_key = round(min_street_floor_h, 2) if min_street_floor_h is not None else -999.0
        cache_key = f"{scan_id}_{floor_key}"

        cached = _BARE_EARTH_DTM_MEM_CACHE.get(cache_key)
        if cached is not None and abs(cached[0] - mtime) < 1e-3:
            return cached[1]

        dsm_data: Optional[Dict[str, Any]] = None
        if npz_path and os.path.isfile(npz_path):
            try:
                z = np.load(npz_path)
                dsm_data = {
                    "e_min": float(z["e_min"]),
                    "e_max": float(z["e_max"]),
                    "n_min": float(z["n_min"]),
                    "n_max": float(z["n_max"]),
                    "res": float(z["res"]),
                    "dsm_raw": z["dsm_raw"].astype(np.float32),
                    "hull_mask": z["hull_mask"].astype(bool),
                }
            except Exception:
                dsm_data = None

        if not dsm_data:
            return None

        raw = np.asarray(dsm_data["dsm_raw"], dtype=np.float32)
        hull = np.asarray(dsm_data["hull_mask"], dtype=bool)
        e_min = float(dsm_data["e_min"])
        e_max = float(dsm_data["e_max"])
        n_min = float(dsm_data["n_min"])
        n_max = float(dsm_data["n_max"])
        res = max(0.04, float(dsm_data["res"]))
        ny, nx = raw.shape
        if ny < 4 or nx < 4 or not np.any(hull):
            return None

        valid_vals = raw[hull]
        p03, p18, p50 = [float(v) for v in np.percentile(valid_vals, [3, 18, 50])]
        # Reject extreme downward reconstruction noise spikes below p03 - 1.5m
        floor_clip = p03 - 1.5
        if min_street_floor_h is not None:
            floor_clip = max(floor_clip, min_street_floor_h)
        clean_raw = np.clip(raw, floor_clip, p50 + 60.0)

        # Downsample to ~1.5m coarse grid for fast morphological bare-earth lower envelope
        step = max(1, int(round(1.5 / res)))
        coarse_raw = clean_raw[::step, ::step]
        coarse_hull = hull[::step, ::step]
        # Replace outside-hull cells with nearest valid inside-hull value so filters don't bleed at edges
        if not np.all(coarse_hull):
            _, nearest_idx = distance_transform_edt(~coarse_hull, return_indices=True)
            coarse_filled = coarse_raw[nearest_idx[0], nearest_idx[1]]
        else:
            coarse_filled = coarse_raw.copy()

        # Window ~ 7.5m (5 coarse cells): 20th percentile strips trees, vehicles, and small roofs
        win_c = max(3, int(round(7.5 / (res * step))) | 1)
        lower_env = percentile_filter(coarse_filled, percentile=22, size=win_c)
        lower_env = gaussian_filter(lower_env, sigma=1.35).astype(np.float32)

        # Upsample coarse bare-earth envelope back to full DSM resolution
        iy_idx = np.minimum((np.arange(ny) // step), lower_env.shape[0] - 1)
        ix_idx = np.minimum((np.arange(nx) // step), lower_env.shape[1] - 1)
        env_full = lower_env[iy_idx[:, None], ix_idx[None, :]]

        # Where actual surface is near bare-earth envelope ([-0.35m, +0.65m]), preserve local road crown/grade;
        # where surface jumps above bare-earth envelope (> +0.65m: trees, cars, roofs), clamp to bare-earth envelope
        diff = clean_raw - env_full
        bare_full = np.where(
            diff <= 0.65,
            0.55 * np.maximum(clean_raw, env_full - 0.35) + 0.45 * env_full,
            env_full + 0.25,
        ).astype(np.float32)
        if min_street_floor_h is not None:
            bare_full = np.maximum(bare_full, float(min_street_floor_h))

        # Fill outside-hull cells with nearest boundary bare-earth elevation + compute distance outside hull (m)
        dist_out_cells, nearest_in = distance_transform_edt(~hull, return_indices=True)
        bare_filled = bare_full[nearest_in[0], nearest_in[1]]
        bare_smooth = gaussian_filter(bare_filled, sigma=max(0.8, 1.2 / res)).astype(np.float32)
        if min_street_floor_h is not None:
            bare_smooth = np.maximum(bare_smooth, float(min_street_floor_h))
        dist_out_m = (dist_out_cells * res).astype(np.float32)

        # Build compact downsampled terrain_grid (max 44x44) for client-side O(1) bilinear lookup
        max_dim = 44
        sub_y = max(1, int(math.ceil(ny / max_dim)))
        sub_x = max(1, int(math.ceil(nx / max_dim)))
        y_indices = np.linspace(0, ny - 1, min(ny, max_dim)).round().astype(int)
        x_indices = np.linspace(0, nx - 1, min(nx, max_dim)).round().astype(int)
        sub_bare = bare_smooth[np.ix_(y_indices, x_indices)]
        sub_hull = hull[np.ix_(y_indices, x_indices)]

        inside_bare = bare_smooth[hull]
        scan_ground_ref_h = float(np.percentile(inside_bare, 35)) if len(inside_bare) > 0 else p18
        if min_street_floor_h is not None:
            scan_ground_ref_h = max(scan_ground_ref_h, float(min_street_floor_h))

        terrain_grid_payload = {
            "e_min": round(e_min, 2),
            "e_max": round(e_max, 2),
            "n_min": round(n_min, 2),
            "n_max": round(n_max, 2),
            "nx": int(len(x_indices)),
            "ny": int(len(y_indices)),
            "z_grid": [round(float(v), 2) for v in sub_bare.ravel()],
            "hull_grid": [1 if bool(v) else 0 for v in sub_hull.ravel()],
            "scan_ground_ref_h": round(scan_ground_ref_h, 3),
            "min_bare_h": round(float(inside_bare.min()), 2) if len(inside_bare) > 0 else round(p03, 2),
            "max_bare_h": round(float(inside_bare.max()), 2) if len(inside_bare) > 0 else round(p50, 2),
        }

        dtm_obj = {
            "scan_id": scan_id,
            "e_min": e_min,
            "e_max": e_max,
            "n_min": n_min,
            "n_max": n_max,
            "res": res,
            "nx": nx,
            "ny": ny,
            "bare_grid": bare_smooth,
            "hull_mask": hull,
            "dist_out_m": dist_out_m,
            "scan_ground_ref_h": round(scan_ground_ref_h, 3),
            "terrain_grid": terrain_grid_payload,
        }
        _BARE_EARTH_DTM_MEM_CACHE[cache_key] = (mtime, dtm_obj)
        return dtm_obj

    @staticmethod
    def _sample_bare_earth_dtm(dtm: Optional[Dict[str, Any]], e_pt: float, n_pt: float) -> Tuple[Optional[float], float]:
        """
        Bilinearly samples `(bare_earth_z, dist_outside_hull_m)` at `(e_pt, n_pt)`.
        When inside the scan hull, `dist_outside_hull_m == 0.0`.
        """
        if not dtm:
            return None, 1e9
        e_min = dtm["e_min"]
        n_min = dtm["n_min"]
        res = dtm["res"]
        nx = dtm["nx"]
        ny = dtm["ny"]
        grid = dtm["bare_grid"]
        dist_out_m = dtm["dist_out_m"]

        fe = (e_pt - e_min) / res
        fn = (n_pt - n_min) / res

        # Extra Euclidean distance if outside bounding box [e_min..e_max, n_min..n_max]
        dx_box = 0.0
        if e_pt < e_min:
            dx_box = e_min - e_pt
        elif e_pt > dtm["e_max"]:
            dx_box = e_pt - dtm["e_max"]
        dy_box = 0.0
        if n_pt < n_min:
            dy_box = n_min - n_pt
        elif n_pt > dtm["n_max"]:
            dy_box = n_pt - dtm["n_max"]
        box_dist = math.hypot(dx_box, dy_box)

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

        d_hull = float(dist_out_m[j0, i0]) + box_dist
        return round(z_val, 3), d_hull

    def _build_multi_source_ground_sampler(
        self,
        scan_id: str,
        scan: Dict[str, Any],
        ce: float,
        cn: float,
        ch: float,
    ) -> Tuple[Callable[..., float], Optional[Dict[str, Any]], float, Optional[Dict[str, Any]]]:
        """
        Builds a unified, multi-source ground elevation sampler `sample_ground_z(e, n, mode="hybrid")`
        combining:
        1. Actual Scan Bare-Earth DTM Grid (`_dsm_cache_v5.npz` + morphological canopy removal)
        2. Categorized 3D Road & Ground Surfaces (`_categorization_cache_v3.json`)
        3. Official Government Elevation APIs:
           - Taipei City 3D Bare-Earth API (`3dgis.reac.taipei get3dz.ashx`)
           - Taiwan-Wide 30m DEM Grid (`api.open-meteo.com/v1/elevation` calibrated to scan TWVD2001 datum)
        Returns `(sample_ground_z, cat_data, base_ground_z, dtm_obj)`.
        """
        cat_data = self._load_scan_categorization_data(scan_id, scan, ce, cn)
        cat_samples: List[Tuple[float, float, float, float]] = []  # (e, n, h, weight)
        road_hs: List[float] = []

        has_detention_pond = False
        primary_road_h: Optional[float] = None
        if isinstance(cat_data, dict):
            raw_roads = [r for r in (cat_data.get("roads") or []) if isinstance(r, dict)]
            raw_wbs = [wb for wb in (cat_data.get("water_bodies") or []) if isinstance(wb, dict)]
            has_detention_pond = len(raw_wbs) >= 2
            max_road_area = max((safe_float(r.get("planar_area_m2"), 0.0) or 0.0 for r in raw_roads), default=0.0)
            primary_hs: List[float] = []
            for r in raw_roads:
                r_area = safe_float(r.get("planar_area_m2"), 100.0) or 100.0
                if r_area < 0.20 * max_road_area:
                    continue
                b_zs = sorted(
                    [
                        float(pt[2])
                        for pt in (r.get("boundary_twd97") or [])
                        if isinstance(pt, list) and len(pt) >= 3 and safe_float(pt[2]) is not None
                    ]
                )
                if len(b_zs) >= 4:
                    primary_hs.append(b_zs[min(len(b_zs) - 1, int(len(b_zs) * 0.65))])
                else:
                    rc = r.get("center_twd97")
                    if isinstance(rc, list) and len(rc) >= 3 and safe_float(rc[2]) is not None:
                        primary_hs.append(float(rc[2]))
            primary_road_h = (sum(primary_hs) / len(primary_hs)) if primary_hs else None

            for r in raw_roads:
                r_area = safe_float(r.get("planar_area_m2"), 100.0) or 100.0
                rc = r.get("center_twd97")
                rh_center = safe_float(rc[2]) if (isinstance(rc, list) and len(rc) >= 3) else None
                # Only skip minor sunken detention-basin footpaths (<20% of main road area in multi-pond parks)
                if (
                    has_detention_pond
                    and primary_road_h is not None
                    and r_area < 0.20 * max_road_area
                    and rh_center is not None
                    and (primary_road_h - rh_center) > 0.85
                ):
                    continue
                area_w = max(1.0, min(4.0, (r_area / max(200.0, max_road_area)) * 4.0))
                if isinstance(rc, list) and len(rc) >= 3:
                    re_v, rn_v, rh_v = safe_float(rc[0]), safe_float(rc[1]), safe_float(rc[2])
                    if re_v is not None and rn_v is not None and rh_v is not None:
                        eff_rh = (
                            max(rh_v, primary_road_h - 0.35)
                            if (has_detention_pond and primary_road_h is not None)
                            else rh_v
                        )
                        cat_samples.append((re_v, rn_v, eff_rh, 5.0 * area_w))
                        road_hs.append(eff_rh)
                b_pts = r.get("boundary_twd97") or []
                stride = max(1, len(b_pts) // 36)
                for pt in b_pts[::stride]:
                    if isinstance(pt, list) and len(pt) >= 3:
                        pe, pn, ph = safe_float(pt[0]), safe_float(pt[1]), safe_float(pt[2])
                        if pe is not None and pn is not None and ph is not None:
                            if has_detention_pond and primary_road_h is not None and (primary_road_h - ph) > 0.85:
                                continue
                            cat_samples.append((pe, pn, ph, 2.5 * area_w))
                            road_hs.append(ph)

            road_ref_h = (sum(road_hs) / len(road_hs)) if road_hs else primary_road_h
            for t in (cat_data.get("trees") or []):
                tc = t.get("trunk_twd97") or t.get("base_twd97") or t.get("center_twd97")
                if isinstance(tc, list) and len(tc) >= 3:
                    te, tn, th = safe_float(tc[0]), safe_float(tc[1]), safe_float(tc[2])
                    if te is not None and tn is not None and th is not None:
                        if not has_detention_pond or road_ref_h is None or abs(th - road_ref_h) <= 0.65:
                            cat_samples.append((te, tn, th, 0.8))

        # Protect multi-pond detention park scans from dragging street utilities into pond bottoms
        min_street_floor_h = (
            (primary_road_h - 0.95)
            if (has_detention_pond and primary_road_h is not None)
            else None
        )

        dtm_obj = self._build_scan_bare_earth_dtm(
            scan_id, scan, ce, cn, ch, cat_data, min_street_floor_h=min_street_floor_h
        )

        # Determine canonical reference ground elevation at scan center
        if primary_road_h is not None and has_detention_pond:
            base_ground_z = round(primary_road_h, 3)
        elif dtm_obj is not None:
            z_c, d_c = self._sample_bare_earth_dtm(dtm_obj, ce, cn)
            if z_c is not None and d_c <= 25.0:
                base_ground_z = round(
                    0.55 * z_c + 0.45 * (primary_road_h if primary_road_h is not None else z_c),
                    3,
                )
            else:
                base_ground_z = round(primary_road_h if primary_road_h is not None else dtm_obj["scan_ground_ref_h"], 3)
        elif cat_samples:
            w_tot = sum(s[3] for s in cat_samples)
            base_ground_z = round(sum(s[2] * s[3] for s in cat_samples) / max(w_tot, 1e-6), 3)
        else:
            base_ground_z = round(ch, 3)

        # Query spatial Government DEM grid across the surrounding 1km area
        gov_samples: List[Tuple[float, float, float, float]] = []
        in_taipei = 296000.0 <= ce <= 318000.0 and 2762000.0 <= cn <= 2789000.0
        if in_taipei:
            grid_offsets = [
                (0.0, 0.0),
                (100.0, 0.0), (-100.0, 0.0), (0.0, 100.0), (0.0, -100.0),
                (100.0, 100.0), (100.0, -100.0), (-100.0, 100.0), (-100.0, -100.0),
                (220.0, 0.0), (-220.0, 0.0), (0.0, 220.0), (0.0, -220.0),
                (220.0, 220.0), (220.0, -220.0), (-220.0, 220.0), (-220.0, -220.0),
                (400.0, 0.0), (-400.0, 0.0), (0.0, 400.0), (0.0, -400.0),
            ]
            tpe_coords = [(ce + dx, cn + dy) for dx, dy in grid_offsets]
            cache = _load_gov_dem_disk_cache()
            need_net = any(
                f"tpe_{int(round(pe / 25.0) * 25)}_{int(round(pn / 25.0) * 25)}" not in cache
                for pe, pn in tpe_coords
            )
            if need_net:
                with ThreadPoolExecutor(max_workers=6) as pool:
                    tpe_zs = list(pool.map(lambda p: _query_taipei_3d_elevation_pt(p[0], p[1]), tpe_coords))
                _save_gov_dem_disk_cache()
            else:
                tpe_zs = [_query_taipei_3d_elevation_pt(pe, pn) for pe, pn in tpe_coords]

            for (pe, pn), gz in zip(tpe_coords, tpe_zs):
                if gz is not None:
                    eff_gz = max(gz, min_street_floor_h) if min_street_floor_h is not None else gz
                    gov_samples.append((pe, pn, eff_gz, 3.5))

        # Always supplement non-Taipei sites (or sparse Taipei edge sites) with calibrated 30m DEM batch grid
        if len(gov_samples) < 6:
            dem_offsets = [(0.0, 0.0)]
            for step_r in (90.0, 200.0, 350.0, 550.0):
                for dx_s in (-step_r, 0.0, step_r):
                    for dy_s in (-step_r, 0.0, step_r):
                        if dx_s == 0.0 and dy_s == 0.0:
                            continue
                        dem_offsets.append((dx_s, dy_s))
            dem_pts = [(ce + dx, cn + dy) for dx, dy in dem_offsets]
            dem_zs = _query_open_meteo_dem_batch(dem_pts)
            center_dem = dem_zs[0] if dem_zs else None
            # Calibrate global DEM datum offset to scan's local TWVD2001 ground reference at (ce, cn)
            datum_shift = (base_ground_z - center_dem) if center_dem is not None else 0.0
            for (pe, pn), dz in zip(dem_pts, dem_zs):
                if dz is not None:
                    cal_z = round(dz + datum_shift, 3)
                    if min_street_floor_h is not None:
                        cal_z = max(cal_z, min_street_floor_h)
                    gov_samples.append((pe, pn, cal_z, 2.5))

        if has_detention_pond and primary_road_h is not None:
            base_ground_z = round(max(base_ground_z, primary_road_h), 3)

        idw_cell_cache: Dict[Tuple[int, int, int], Optional[float]] = {}

        def _eval_idw(pts_list: List[Tuple[float, float, float, float]], e_q: float, n_q: float, smooth_d2: float = 225.0) -> Optional[float]:
            if not pts_list:
                return None
            ck = (id(pts_list), int(round(e_q * 0.3333)), int(round(n_q * 0.3333)))
            if ck in idw_cell_cache:
                return idw_cell_cache[ck]
            w_sum = 0.0
            zh_sum = 0.0
            for se, sn, sh, sw in pts_list:
                d2 = (e_q - se) ** 2 + (n_q - sn) ** 2
                # Localized inverse-distance power 2.4 prevents far-away points from flattening local slopes
                w = sw / ((d2 + smooth_d2) ** 1.2)
                w_sum += w
                zh_sum += w * sh
            res_v = round(zh_sum / w_sum, 3) if w_sum > 1e-12 else None
            idw_cell_cache[ck] = res_v
            return res_v

        all_hybrid_samples = cat_samples + gov_samples

        def sample_ground_z(e_pt: float, n_pt: float, mode: str = "hybrid") -> float:
            if mode == "flat":
                return base_ground_z

            if mode == "gov_only":
                gv = _eval_idw(gov_samples, e_pt, n_pt, smooth_d2=400.0)
                if gv is not None:
                    return max(gv, min_street_floor_h) if min_street_floor_h is not None else gv
                return base_ground_z

            z_dtm, d_out = self._sample_bare_earth_dtm(dtm_obj, e_pt, n_pt)
            if mode == "scan_only":
                if z_dtm is not None:
                    return max(z_dtm, min_street_floor_h) if min_street_floor_h is not None else z_dtm
                cv = _eval_idw(cat_samples, e_pt, n_pt, smooth_d2=144.0)
                return cv if cv is not None else base_ground_z

            # Default "hybrid": Scan Bare-Earth DTM inside scan hull, smooth 30m transition into Gov DEM + Road samples outside
            if z_dtm is not None:
                if d_out <= 0.5:
                    # Inside scan hull: use actual scan bare-earth DTM
                    res_z = z_dtm
                elif d_out <= 35.0:
                    # Smooth 35m transition zone outside scan hull boundary
                    alpha = min(1.0, max(0.0, (d_out - 0.5) / 34.5))
                    ext_z = _eval_idw(all_hybrid_samples, e_pt, n_pt, smooth_d2=320.0)
                    res_z = (1.0 - alpha) * z_dtm + alpha * (ext_z if ext_z is not None else z_dtm)
                else:
                    ext_z = _eval_idw(all_hybrid_samples, e_pt, n_pt, smooth_d2=400.0)
                    res_z = ext_z if ext_z is not None else z_dtm
            else:
                ext_z = _eval_idw(all_hybrid_samples, e_pt, n_pt, smooth_d2=320.0)
                res_z = ext_z if ext_z is not None else base_ground_z

            if min_street_floor_h is not None:
                res_z = max(res_z, min_street_floor_h)
            return round(res_z, 3)

        return sample_ground_z, cat_data, base_ground_z, dtm_obj

    def _redrape_utilities_features_to_terrain(
        self,
        features: List[Dict[str, Any]],
        sample_ground_z: Callable[..., float],
        dtm_obj: Optional[Dict[str, Any]] = None,
        ce: float = 0.0,
        cn: float = 0.0,
    ) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        """
        Re-drapes 2D/3D utility features onto the active scan's bare-earth DTM + Government DEM:
        - Evaluates local ground elevation at every vertex `(e, n)` in `hybrid`, `scan_only`, and `gov_only` modes.
        - Subdivides long 2D pipe segments (`> 22m` near the scan) so pipes curve smoothly with sloped roads.
        - Locks pipe endpoint ground elevations to spatially coincident manhole `rim_h` values (`<= 0.85m`).
        """
        if not features:
            return [], {"min_ground_h": 0.0, "max_ground_h": 0.0, "relief_m": 0.0, "scan_dtm_active": bool(dtm_obj)}

        # Pass 1: Drape point structures (manholes, catch basins, hydrants, poles) and build O(1) 2m spatial manhole grid
        mh_grid: Dict[Tuple[str, int, int], List[Tuple[float, float, float]]] = {}
        all_ground_hs: List[float] = []
        draped_features: List[Dict[str, Any]] = []

        for raw_f in features:
            if not isinstance(raw_f, dict):
                continue
            f = dict(raw_f)
            ftype = str(f.get("type") or "")
            lyr = str(f.get("layer") or "storm")

            if ftype in ("manhole", "catch_basin", "hydrant", "pole", "point") or (
                not f.get("coords") and isinstance(f.get("coord"), list)
            ):
                coord = f.get("coord")
                if isinstance(coord, list) and len(coord) >= 2:
                    pe, pn = float(coord[0]), float(coord[1])
                    old_rim = safe_float(f.get("rim_h"))
                    old_inv = safe_float(f.get("invert_h"))
                    if old_inv is None and len(coord) >= 3:
                        old_inv = safe_float(coord[2])
                    raw_dep = safe_float(f.get("depth_m"))
                    if raw_dep is not None and 0.3 <= raw_dep <= 16.0:
                        dep_m = raw_dep
                    elif old_rim is not None and old_inv is not None and 0.3 <= (old_rim - old_inv) <= 16.0:
                        dep_m = round(old_rim - old_inv, 2)
                    else:
                        dep_m = 1.2 if ftype in ("hydrant", "pole") else 1.8

                    g_hyb = sample_ground_z(pe, pn, "hybrid")
                    g_scan = sample_ground_z(pe, pn, "scan_only")
                    g_gov = sample_ground_z(pe, pn, "gov_only")
                    inv_h = round(g_hyb - dep_m, 3)

                    f["rim_h"] = round(g_hyb, 3)
                    f["ground_h"] = round(g_hyb, 3)
                    f["scan_ground_h"] = round(g_scan, 3)
                    f["gov_ground_h"] = round(g_gov, 3)
                    f["invert_h"] = inv_h
                    f["depth_m"] = round(dep_m, 2)
                    f["coord"] = [round(pe, 3), round(pn, 3), inv_h]
                    all_ground_hs.append(g_hyb)
                    if ftype in ("manhole", "catch_basin"):
                        gx, gy = int(pe // 2.0), int(pn // 2.0)
                        mh_grid.setdefault((lyr, gx, gy), []).append((pe, pn, g_hyb))
            draped_features.append(f)

        def _snap_mh_rim(lyr_k: str, pe_q: float, pn_q: float, def_g: float) -> float:
            gx, gy = int(pe_q // 2.0), int(pn_q // 2.0)
            best_d2 = 0.72  # 0.85m radius squared
            best_rim = def_g
            for dx_g in (-1, 0, 1):
                for dy_g in (-1, 0, 1):
                    bucket = mh_grid.get((lyr_k, gx + dx_g, gy + dy_g))
                    if not bucket:
                        continue
                    for me, mn, mrim in bucket:
                        d2 = (pe_q - me) ** 2 + (pn_q - mn) ** 2
                        if d2 <= best_d2:
                            best_d2 = d2
                            best_rim = mrim
            return best_rim

        # Pass 2: Drape linear features (pipes & box culverts) per-vertex with terrain subdivision & manhole snapping
        final_features: List[Dict[str, Any]] = []
        for f in draped_features:
            cs = f.get("coords")
            if not isinstance(cs, list) or len(cs) < 2:
                final_features.append(f)
                continue

            # Preserve user-traced open-trench as-built pipes untouched
            if f.get("layer") == "as_built" and f.get("origin_class") == "user_or_scan_to_bim":
                final_features.append(f)
                continue

            lyr = str(f.get("layer") or "storm")
            is_open_ch = bool(f.get("is_open_channel"))
            hm = float(f.get("height_m") or (float(f.get("diameter_mm") or 300) / 1000.0))
            d1 = float(f.get("start_depth_m") or f.get("depth_m") or (0.45 if is_open_ch else 1.5))
            d2 = float(f.get("end_depth_m") or f.get("depth_m") or d1)
            if is_open_ch:
                hm = min(hm, 0.80)
                d1 = min(d1, 0.50)
                d2 = min(d2, 0.55)
                f["height_m"] = round(hm, 2)
                f["start_depth_m"] = round(d1, 2)
                f["end_depth_m"] = round(d2, 2)
                f["depth_m"] = round(0.5 * (d1 + d2), 2)

            # Subdivide long 2D segments (> 22m) within 260m of scan center so pipes follow sloped terrain
            pts_2d: List[Tuple[float, float]] = []
            for idx_c in range(len(cs)):
                p_cur = cs[idx_c]
                if not isinstance(p_cur, (list, tuple)) or len(p_cur) < 2:
                    continue
                e_cur, n_cur = float(p_cur[0]), float(p_cur[1])
                if not pts_2d:
                    pts_2d.append((e_cur, n_cur))
                else:
                    e_prev, n_prev = pts_2d[-1]
                    seg_d = math.hypot(e_cur - e_prev, n_cur - n_prev)
                    mid_dist_c = math.hypot(0.5 * (e_cur + e_prev) - ce, 0.5 * (n_cur + n_prev) - cn) if ce > 0 else 0.0
                    if seg_d > 22.0 and mid_dist_c <= 260.0 and len(pts_2d) < 32:
                        n_sub = min(6, max(2, int(math.ceil(seg_d / 16.0))))
                        for s_i in range(1, n_sub + 1):
                            t_s = s_i / n_sub
                            pts_2d.append((e_prev + t_s * (e_cur - e_prev), n_prev + t_s * (n_cur - n_prev)))
                    else:
                        pts_2d.append((e_cur, n_cur))

            if len(pts_2d) < 2:
                final_features.append(f)
                continue

            cum_lens: List[float] = [0.0]
            for i in range(1, len(pts_2d)):
                cum_lens.append(
                    cum_lens[-1] + math.hypot(pts_2d[i][0] - pts_2d[i - 1][0], pts_2d[i][1] - pts_2d[i - 1][1])
                )
            tot_len = cum_lens[-1]

            new_coords: List[List[float]] = []
            v_ground_hs: List[float] = []
            v_scan_hs: List[float] = []
            v_gov_hs: List[float] = []

            for i, (pe, pn) in enumerate(pts_2d):
                frac = (cum_lens[i] / tot_len) if tot_len > 1e-6 else (i / max(1, len(pts_2d) - 1))
                dep_i = d1 + frac * (d2 - d1)
                g_hyb = sample_ground_z(pe, pn, "hybrid")
                g_scan = sample_ground_z(pe, pn, "scan_only")
                g_gov = sample_ground_z(pe, pn, "gov_only")
                if i == 0 or i == len(pts_2d) - 1:
                    g_hyb = _snap_mh_rim(lyr, pe, pn, g_hyb)
                inv_i = round(g_hyb - dep_i, 3)
                new_coords.append([round(pe, 3), round(pn, 3), inv_i])
                v_ground_hs.append(round(g_hyb, 3))
                v_scan_hs.append(round(g_scan, 3))
                v_gov_hs.append(round(g_gov, 3))

            all_ground_hs.extend(v_ground_hs)
            z_start = new_coords[0][2]
            z_end = new_coords[-1][2]
            g_start = v_ground_hs[0]
            g_end = v_ground_hs[-1]

            f["coords"] = new_coords
            f["start_coord"] = new_coords[0]
            f["end_coord"] = new_coords[-1]
            f["vertex_ground_hs"] = v_ground_hs
            f["vertex_scan_ground_hs"] = v_scan_hs
            f["vertex_gov_ground_hs"] = v_gov_hs
            f["start_ground_h"] = g_start
            f["end_ground_h"] = g_end
            f["start_rim_h"] = g_start
            f["end_rim_h"] = g_end
            f["start_invert_h"] = z_start
            f["end_invert_h"] = z_end
            f["start_crown_h"] = round(z_start + hm, 3)
            f["end_crown_h"] = round(z_end + hm, 3)
            min_cov = 0.0 if is_open_ch else 0.1
            f["start_cover_m"] = round(max(min_cov, d1 - hm), 2)
            f["end_cover_m"] = round(max(min_cov, d2 - hm), 2)
            if tot_len > 0.2:
                f["length_m"] = round(tot_len, 2)
                raw_sl = ((z_start - z_end) / tot_len) * 100.0
                f["slope_pct"] = round(max(-24.5, min(24.5, raw_sl)), 2)

            final_features.append(f)

        if all_ground_hs:
            min_gh = round(min(all_ground_hs), 2)
            max_gh = round(max(all_ground_hs), 2)
        else:
            min_gh, max_gh = 0.0, 0.0

        summary = {
            "mode": "hybrid",
            "scan_dtm_active": bool(dtm_obj),
            "min_ground_h": min_gh,
            "max_ground_h": max_gh,
            "relief_m": round(max_gh - min_gh, 2),
        }
        return final_features, summary
