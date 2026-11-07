#!/usr/bin/env python3
"""
GatheringScans — Bulletproof Python <-> Rust Native Acceleration Bridge (`gathering_scans_rs`)
File: pc_worker/surveying/rust_accel.py
Compliance: Strictly under 5,000 lines modular ceiling (AGENTS.md Rule 4).

Provides zero-failure FFI wrappers with contiguous buffer validation and automatic fallback
to pure-Python/NumPy whenever `gathering_scans_rs` is unavailable or raises any exception.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

try:
    import numpy as np
except ImportError:
    np = None  # type: ignore

try:
    import gathering_scans_rs as _rs  # type: ignore

    HAS_RUST_CORE: bool = True
    RUST_CORE_VERSION: str = str(getattr(_rs, "__version__", "0.1.0"))
except Exception:
    _rs = None
    HAS_RUST_CORE = False
    RUST_CORE_VERSION = "disabled"


def get_cut_fill_max_grid_steps() -> int:
    """Returns 256 (up to 65,536 integration cells) when Rust core is active, or 64 in pure Python."""
    return 256 if (HAS_RUST_CORE and _rs is not None) else 64


def get_rust_status() -> Dict[str, Any]:
    """Returns live telemetry dictionary for `/api/status` and `/api/admin/pc-daemon`."""
    enabled = bool(HAS_RUST_CORE and _rs is not None)
    info: Dict[str, Any] = {}
    if enabled:
        try:
            info = dict(_rs.rust_core_info())
        except Exception:
            info = {}
    return {
        "rust_core_enabled": enabled,
        "rust_core_version": RUST_CORE_VERSION if enabled else "disabled",
        "cut_fill_max_grid_steps": 256 if enabled else 64,
        "rayon_threads": int(info.get("rayon_threads", 0)) if enabled else 0,
    }


def parse_obj_vertices_fast(
    obj_path: str,
    offset_xyz: Tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> Optional["np.ndarray"]:
    """
    Parses `.obj` vertex lines (`v x y z`) in parallel via Rayon and returns an `(N, 3)` float64 ndarray,
    or `None` if Rust acceleration is disabled or encounters any error.
    """
    if not HAS_RUST_CORE or _rs is None or np is None:
        return None
    try:
        ox, oy, oz = float(offset_xyz[0]), float(offset_xyz[1]), float(offset_xyz[2])
        raw_bytes: bytes = _rs.parse_obj_vertices_fast(str(obj_path), (ox, oy, oz))
        if not raw_bytes or len(raw_bytes) < 24:
            return None
        arr = np.frombuffer(raw_bytes, dtype="<f8").reshape(-1, 3).copy()
        return arr if len(arr) > 0 else None
    except Exception:
        return None


def extract_glb_positions_fast(raw_bytes: bytes) -> Optional["np.ndarray"]:
    """
    Parses glTF 2.0 binary `.glb` vertex positions with full 64-bit node TRS/matrix transforms in Rust.
    Returns `(N, 3)` float64 ndarray, or `None` to trigger Python/gltfpack fallback.
    """
    if not HAS_RUST_CORE or _rs is None or np is None:
        return None
    try:
        if not raw_bytes or len(raw_bytes) < 28:
            return None
        out_bytes: Optional[bytes] = _rs.extract_glb_positions_fast(bytes(raw_bytes))
        if not out_bytes or len(out_bytes) < 24:
            return None
        arr = np.frombuffer(out_bytes, dtype="<f8").reshape(-1, 3).copy()
        return arr if len(arr) > 0 else None
    except Exception:
        return None


def integrate_cut_fill_grid(
    dsm_curr: Dict[str, Any],
    v_shift: float,
    poly_2d: Sequence[Tuple[float, float]],
    perim_samples: Sequence[Tuple[float, float, float]],
    base_mode: str,
    datum_z: float,
    plane_params: Tuple[float, float, float, float, float],
    origin_enh: Tuple[float, float, float],
    max_grid_steps: int = 256,
    dsm_cmp: Optional[Dict[str, Any]] = None,
    cmp_shift: float = 0.0,
) -> Optional[Dict[str, Any]]:
    """
    High-precision parallel Rayon Cut/Fill & IDW surface integrator (up to 256x256 = 65,536 cells).
    Returns dict with `fill_vol`, `cut_vol`, `surface_area`, `max_dz`, `min_dz`, `inside_cells`,
    `nx_steps`, `ny_steps`, `cell_area`, `heatmap_cells`, or `None` on fallback.
    """
    if not HAS_RUST_CORE or _rs is None or np is None:
        return None
    try:
        grid = np.ascontiguousarray(dsm_curr["dsm_raw"], dtype="<f4")
        ny, nx = grid.shape
        dsm_bytes = grid.tobytes()

        cmp_bytes: Optional[bytes] = None
        cmp_dims: Optional[Tuple[int, int, float, float, float, float]] = None
        if base_mode == "epoch_diff" and isinstance(dsm_cmp, dict) and "dsm_raw" in dsm_cmp:
            c_grid = np.ascontiguousarray(dsm_cmp["dsm_raw"], dtype="<f4")
            c_ny, c_nx = c_grid.shape
            cmp_bytes = c_grid.tobytes()
            cmp_dims = (
                int(c_nx),
                int(c_ny),
                float(dsm_cmp["e_min"]),
                float(dsm_cmp["n_min"]),
                float(dsm_cmp["res"]),
                float(cmp_shift),
            )

        clean_poly = [(float(p[0]), float(p[1])) for p in poly_2d]
        clean_perim = [(float(p[0]), float(p[1]), float(p[2])) for p in perim_samples]
        clean_plane = (
            float(plane_params[0]),
            float(plane_params[1]),
            float(plane_params[2]),
            float(plane_params[3]),
            float(plane_params[4]),
        )
        clean_origin = (float(origin_enh[0]), float(origin_enh[1]), float(origin_enh[2]))

        res = _rs.integrate_cut_fill_grid(
            dsm_bytes,
            int(nx),
            int(ny),
            float(dsm_curr["e_min"]),
            float(dsm_curr["n_min"]),
            float(dsm_curr["res"]),
            float(v_shift),
            clean_poly,
            clean_perim,
            str(base_mode),
            float(datum_z),
            clean_plane,
            clean_origin,
            int(max_grid_steps),
            cmp_bytes,
            cmp_dims,
        )
        return dict(res) if res is not None else None
    except Exception:
        return None


def extract_and_clip_contours_parallel(
    sub_grid: "np.ndarray",
    sub_hull: "np.ndarray",
    sub_e_min: float,
    sub_n_min: float,
    res: float,
    levels: Sequence[float],
    major_interval: float,
    ce: float,
    cn: float,
    ch: float,
    poly_2d: Sequence[Tuple[float, float]],
) -> Optional[List[Dict[str, Any]]]:
    """
    Runs 16-case Marching Squares, topological chain stitching, Ramer-Douglas-Peucker simplification,
    and 2D polygon clipping across all contour elevation levels in parallel via Rayon.
    """
    if not HAS_RUST_CORE or _rs is None or np is None:
        return None
    try:
        grid_c = np.ascontiguousarray(sub_grid, dtype="<f4")
        hull_c = np.ascontiguousarray(sub_hull.astype(np.uint8), dtype=np.uint8)
        ny, nx = grid_c.shape
        if nx < 2 or ny < 2:
            return []
        clean_levels = [float(lv) for lv in levels]
        clean_poly = [(float(p[0]), float(p[1])) for p in poly_2d]

        out = _rs.extract_and_clip_contours_parallel(
            grid_c.tobytes(),
            hull_c.tobytes(),
            int(nx),
            int(ny),
            float(sub_e_min),
            float(sub_n_min),
            float(res),
            clean_levels,
            float(major_interval),
            float(ce),
            float(cn),
            float(ch),
            clean_poly,
        )
        return list(out) if out is not None else None
    except Exception:
        return None


def compute_voxel_tensor_features(
    centroids: "np.ndarray",
    normals: "np.ndarray",
    area_3d: "np.ndarray",
    voxel_size: float = 0.25,
) -> Optional[Dict[str, Any]]:
    """
    Quantizes 3D triangle centroids into `0.25m` voxels, builds a spatial hash grid,
    accumulates area-weighted 3x3 covariance matrices and folded normal vectors within `r=0.85m`,
    and solves symmetric 3x3 eigenvalues in parallel across Rayon threads.
    """
    if not HAS_RUST_CORE or _rs is None or np is None:
        return None
    try:
        n_tris = len(centroids)
        if n_tris < 12:
            return None
        c_bytes = np.ascontiguousarray(centroids, dtype="<f8").tobytes()
        n_bytes = np.ascontiguousarray(normals, dtype="<f8").tobytes()
        a_bytes = np.ascontiguousarray(area_3d, dtype="<f8").tobytes()

        raw = _rs.compute_voxel_tensor_features(c_bytes, n_bytes, a_bytes, float(voxel_size))
        if not raw:
            return None

        n_vox = int(raw["n_vox"])
        return {
            "tri_r_normal": np.frombuffer(raw["tri_r_normal"], dtype="<f4").copy(),
            "tri_sigma_n": np.frombuffer(raw["tri_sigma_n"], dtype="<f4").copy(),
            "tri_linearity": np.frombuffer(raw["tri_linearity"], dtype="<f4").copy(),
            "tri_planarity": np.frombuffer(raw["tri_planarity"], dtype="<f4").copy(),
            "tri_scattering": np.frombuffer(raw["tri_scattering"], dtype="<f4").copy(),
            "voxel_centroids": np.frombuffer(raw["voxel_centroids"], dtype="<f8").reshape(n_vox, 3).copy(),
            "voxel_normals": np.frombuffer(raw["voxel_normals"], dtype="<f8").reshape(n_vox, 3).copy(),
            "voxel_areas": np.frombuffer(raw["voxel_areas"], dtype="<f8").copy(),
            "voxel_linearity": np.frombuffer(raw["voxel_linearity"], dtype="<f4").copy(),
            "voxel_e1_dirs": np.frombuffer(raw["voxel_e1_dirs"], dtype="<f4").reshape(n_vox, 3).copy(),
            "inv_voxel_idx": np.frombuffer(raw["inv_voxel_idx"], dtype="<i4").copy(),
        }
    except Exception:
        return None
