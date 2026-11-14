#!/usr/bin/env python3
"""
GatheringScans — Rust Native Extension (`gathering_scans_rs`) Parity, High-Precision & Fallback Test Suite
File: tests/test_rust_core_parity.py
"""

from __future__ import annotations

import json
import math
import os
import struct
import tempfile
import time
import unittest
from unittest.mock import patch

import numpy as np

from pc_worker.surveying import rust_accel
from pc_worker.surveying.bim_geometry_extractor import compute_mesh_eigenvalue_features
from pc_worker.surveying.contours_and_cad import ContoursAndCadMixin
from pc_worker.surveying.dsm_and_volume import DsmAndVolumeMixin
from pc_worker.surveying_engine import SurveyingEngine


def _build_synthetic_glb(verts_local: np.ndarray, translation=(250100.0, 2770200.0, 45.5)) -> bytes:
    """Builds a valid glTF 2.0 binary .glb with node TRS translation for testing."""
    v_f32 = np.ascontiguousarray(verts_local, dtype="<f4")
    bin_blob = v_f32.tobytes()
    while len(bin_blob) % 4 != 0:
        bin_blob += b"\x00"

    gltf_dict = {
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [
            {
                "mesh": 0,
                "translation": [float(translation[0]), float(translation[1]), float(translation[2])],
                "rotation": [0.0, 0.0, 0.0, 1.0],
                "scale": [1.0, 1.0, 1.0],
            }
        ],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "accessors": [
            {
                "bufferView": 0,
                "byteOffset": 0,
                "componentType": 5126,
                "count": int(len(v_f32)),
                "type": "VEC3",
            }
        ],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(v_f32) * 12}],
        "buffers": [{"byteLength": len(bin_blob)}],
    }
    json_bytes = json.dumps(gltf_dict).encode("utf-8")
    while len(json_bytes) % 4 != 0:
        json_bytes += b" "

    total_len = 12 + 8 + len(json_bytes) + 8 + len(bin_blob)
    header = struct.pack("<4sII", b"glTF", 2, total_len)
    json_hdr = struct.pack("<I4s", len(json_bytes), b"JSON")
    bin_hdr = struct.pack("<I4s", len(bin_blob), b"BIN\x00")
    return header + json_hdr + json_bytes + bin_hdr + bin_blob


class TestRustCoreParityAndPrecision(unittest.TestCase):
    def test_01_rust_core_loaded_and_telemetry(self):
        self.assertTrue(rust_accel.HAS_RUST_CORE, "gathering_scans_rs native module must be active")
        st = rust_accel.get_rust_status()
        self.assertTrue(st["rust_core_enabled"])
        self.assertEqual(st["rust_core_version"], "0.1.0")
        self.assertEqual(st["cut_fill_max_grid_steps"], 256)
        self.assertGreaterEqual(st["rayon_threads"], 1)

    def test_02_obj_and_glb_vertex_parsers_parity_and_edge_cases(self):
        rng = np.random.default_rng(42)
        pts = rng.uniform(-50.0, 50.0, size=(2500, 3)).astype(np.float64)

        with tempfile.NamedTemporaryFile("w", suffix=".obj", delete=False, encoding="utf-8") as tf:
            obj_path = tf.name
            tf.write("# Synthetic OBJ mesh\no TestMesh\n")
            for x, y, z in pts:
                tf.write(f"v {x:.8f} {y:.8f} {z:.8f}\n")
            tf.write("vn 0.0 0.0 1.0\nf 1 2 3\n")

        try:
            offset = (302500.0, 2769800.0, 18.25)
            rs_verts = rust_accel.parse_obj_vertices_fast(obj_path, offset)
            self.assertIsNotNone(rs_verts)
            expected = pts + np.array(offset, dtype=np.float64)
            np.testing.assert_allclose(rs_verts, expected, rtol=1e-7, atol=1e-6)
        finally:
            if os.path.exists(obj_path):
                os.remove(obj_path)

        # Missing file edge case returns None cleanly
        self.assertIsNone(rust_accel.parse_obj_vertices_fast("non_existent_mesh_12345.obj"))

        # GLB binary parser parity
        glb_bytes = _build_synthetic_glb(pts, translation=(302100.5, 2765100.25, 12.75))
        rs_glb = rust_accel.extract_glb_positions_fast(glb_bytes)
        self.assertIsNotNone(rs_glb)

        with patch.object(rust_accel, "HAS_RUST_CORE", False):
            py_glb = DsmAndVolumeMixin._extract_glb_positions_from_bytes(glb_bytes)
        self.assertIsNotNone(py_glb)
        np.testing.assert_allclose(rs_glb, py_glb, rtol=1e-6, atol=1e-5)

        # Malformed GLB edge cases return None without raising
        self.assertIsNone(rust_accel.extract_glb_positions_fast(b""))
        self.assertIsNone(rust_accel.extract_glb_positions_fast(b"glTF_corrupted_bytes_12345678901234567890"))

    def test_03_cut_fill_volume_parity_and_256x256_high_precision(self):
        # Construct a synthetic 0.08m resolution DSM with a smooth Gaussian/paraboloid stockpile mound
        res = 0.08
        nx, ny = 240, 240
        e_min, n_min = 302000.0, 2770000.0
        xs = e_min + np.arange(nx, dtype=np.float64) * res
        ys = n_min + np.arange(ny, dtype=np.float64) * res
        xx, yy = np.meshgrid(xs, ys)
        cx, cy = e_min + 9.6, n_min + 9.6
        r2 = (xx - cx) ** 2 + (yy - cy) ** 2
        # Mound of radius 5.0m, peak height 3.2m over base 20.0m
        mound = np.maximum(0.0, 3.2 * (1.0 - r2 / 25.0))
        dsm_raw = (20.0 + mound).astype(np.float32)
        dsm_cmp_raw = np.full((ny, nx), 20.0, dtype=np.float32)
        hull_mask = np.ones((ny, nx), dtype=bool)

        dsm_curr = {
            "scan_id": "synthetic_mound",
            "ce": cx,
            "cn": cy,
            "ch": 20.0,
            "e_min": e_min,
            "e_max": float(xs[-1]),
            "n_min": n_min,
            "n_max": float(ys[-1]),
            "res": res,
            "dsm_raw": dsm_raw,
            "dsm_contour": dsm_raw,
            "hull_mask": hull_mask,
            "source_mtime": time.time(),
        }
        dsm_cmp = dict(dsm_curr, dsm_raw=dsm_cmp_raw, dsm_contour=dsm_cmp_raw)

        poly_2d = [
            (cx - 6.0, cy - 6.0),
            (cx + 6.0, cy - 6.0),
            (cx + 6.0, cy + 6.0),
            (cx - 6.0, cy + 6.0),
        ]
        perim_samples = [(px, py, 20.0) for (px, py) in poly_2d]

        # 1. Verify exact numerical parity at identical 64x64 grid resolution across all base modes
        for mode in ("triangulated_boundary", "custom_plane", "lowest_point", "best_fit_plane", "epoch_diff"):
            rs_64 = rust_accel.integrate_cut_fill_grid(
                dsm_curr=dsm_curr,
                v_shift=0.0,
                poly_2d=poly_2d,
                perim_samples=perim_samples,
                base_mode=mode,
                datum_z=20.0,
                plane_params=(0.0, 0.0, 20.0, cx, cy),
                origin_enh=(cx, cy, 20.0),
                max_grid_steps=64,
                dsm_cmp=dsm_cmp,
                cmp_shift=0.0,
            )
            self.assertIsNotNone(rs_64)
            # Analytic volume of paraboloid V = 0.5 * pi * R^2 * H = 0.5 * pi * 25 * 3.2 = 125.6637 m^3
            self.assertAlmostEqual(rs_64["fill_vol"], 125.66, delta=1.5)
            self.assertAlmostEqual(rs_64["cut_vol"], 0.0, delta=1e-4)

        # 2. Verify high-precision 256x256 grid evaluates >10,000 cells in <25ms and converges closer to analytic integral
        t0 = time.perf_counter()
        rs_256 = rust_accel.integrate_cut_fill_grid(
            dsm_curr=dsm_curr,
            v_shift=0.0,
            poly_2d=poly_2d,
            perim_samples=perim_samples,
            base_mode="custom_plane",
            datum_z=20.0,
            plane_params=(0.0, 0.0, 20.0, cx, cy),
            origin_enh=(cx, cy, 20.0),
            max_grid_steps=256,
        )
        dt_ms = (time.perf_counter() - t0) * 1000.0
        self.assertIsNotNone(rs_256)
        self.assertGreater(rs_256["inside_cells"], 15000)
        self.assertLessEqual(len(rs_256["heatmap_cells"]), 2500)
        analytic_v = 0.5 * math.pi * 25.0 * 3.2
        self.assertAlmostEqual(rs_256["fill_vol"], analytic_v, delta=0.35)
        self.assertLess(dt_ms, 100.0)

    def test_04_marching_squares_and_clipping_parity(self):
        res = 0.20
        nx, ny = 90, 90
        e_min, n_min = 302100.0, 2770100.0
        xs = e_min + np.arange(nx, dtype=np.float64) * res
        ys = n_min + np.arange(ny, dtype=np.float64) * res
        xx, yy = np.meshgrid(xs, ys)
        cx, cy = e_min + 9.0, n_min + 9.0
        sub_grid = (15.0 + 4.0 * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / 18.0)).astype(np.float32)
        sub_hull = np.ones((ny, nx), dtype=bool)
        levels = [15.5, 16.0, 16.5, 17.0, 17.5, 18.0, 18.5]
        poly_2d = [
            (e_min + 1.0, n_min + 1.0),
            (e_min + 17.0, n_min + 1.0),
            (e_min + 17.0, n_min + 17.0),
            (e_min + 1.0, n_min + 17.0),
        ]

        rs_contours = rust_accel.extract_and_clip_contours_parallel(
            sub_grid=sub_grid,
            sub_hull=sub_hull,
            sub_e_min=e_min,
            sub_n_min=n_min,
            res=res,
            levels=levels,
            major_interval=1.0,
            ce=cx,
            cn=cy,
            ch=15.0,
            poly_2d=poly_2d,
        )
        self.assertIsNotNone(rs_contours)
        self.assertEqual(len(rs_contours), len(levels))

        mixin = ContoursAndCadMixin()
        py_contours = []
        for elev in levels:
            is_major = abs((elev / 1.0) - round(elev / 1.0)) < 1e-3
            raw_polylines = mixin._extract_marching_squares_polylines_twd(
                sub_grid, sub_hull, e_min, n_min, res, elev
            )
            for raw_twd in raw_polylines:
                for sub_twd, sub_loc in mixin._clip_polyline_to_polygon_2d(raw_twd, cx, cy, 15.0, poly_2d):
                    py_contours.append(
                        {
                            "elevation_m": elev,
                            "is_major": is_major,
                            "layer": "C-TOPO-MAJR" if is_major else "C-TOPO-MINR",
                            "points_local": sub_loc,
                            "points_twd97": sub_twd,
                        }
                    )

        self.assertEqual(len(rs_contours), len(py_contours))
        for rc, pc in zip(rs_contours, py_contours):
            self.assertEqual(rc["elevation_m"], pc["elevation_m"])
            self.assertEqual(rc["is_major"], pc["is_major"])
            self.assertEqual(rc["layer"], pc["layer"])
            self.assertEqual(len(rc["points_twd97"]), len(pc["points_twd97"]))

    def test_05_voxel_tensor_eigenvalues_parity(self):
        rng = np.random.default_rng(99)
        # Create 600 planar horizontal triangles + 300 vertical wall triangles
        c_horiz = np.column_stack([
            rng.uniform(0.0, 8.0, 600),
            rng.uniform(0.0, 8.0, 600),
            rng.normal(2.0, 0.01, 600),
        ])
        n_horiz = np.tile([0.0, 0.0, 1.0], (600, 1))
        c_wall = np.column_stack([
            rng.normal(4.0, 0.01, 300),
            rng.uniform(0.0, 8.0, 300),
            rng.uniform(2.0, 6.0, 300),
        ])
        n_wall = np.tile([1.0, 0.0, 0.0], (300, 1))

        centroids = np.vstack([c_horiz, c_wall]).astype(np.float64)
        normals = np.vstack([n_horiz, n_wall]).astype(np.float64)
        area_3d = rng.uniform(0.02, 0.15, size=len(centroids)).astype(np.float64)

        rs_out = compute_mesh_eigenvalue_features(centroids, normals, area_3d, voxel_size=0.25)
        with patch.object(rust_accel, "HAS_RUST_CORE", False):
            py_out = compute_mesh_eigenvalue_features(centroids, normals, area_3d, voxel_size=0.25)

        np.testing.assert_array_equal(rs_out["inv_voxel_idx"], py_out["inv_voxel_idx"])
        np.testing.assert_allclose(rs_out["voxel_centroids"], py_out["voxel_centroids"], atol=1e-6)
        np.testing.assert_allclose(rs_out["voxel_areas"], py_out["voxel_areas"], atol=1e-6)
        np.testing.assert_allclose(rs_out["voxel_normals"], py_out["voxel_normals"], atol=1e-6)
        np.testing.assert_allclose(rs_out["tri_r_normal"], py_out["tri_r_normal"], atol=1e-4)
        np.testing.assert_allclose(rs_out["tri_sigma_n"], py_out["tri_sigma_n"], atol=1e-4)
        np.testing.assert_allclose(rs_out["tri_linearity"], py_out["tri_linearity"], atol=1e-3)
        np.testing.assert_allclose(rs_out["tri_planarity"], py_out["tri_planarity"], atol=1e-3)
        np.testing.assert_allclose(rs_out["tri_scattering"], py_out["tri_scattering"], atol=1e-3)

    def test_06_graceful_fallback_when_rust_disabled(self):
        from pc_worker.priority_queue import ScanQueueDB

        engine = SurveyingEngine(ScanQueueDB())
        scans = [
            s
            for s in engine.db.list_scans()
            if s.get("status") == "completed" and s.get("tileset_path") and os.path.isfile(s["tileset_path"])
        ]
        if not scans:
            self.skipTest("No completed scans with tileset in DB")
        scan_id = scans[0]["scan_id"]

        res_rust = engine.calculate_cut_fill_volume({"scan_id": scan_id, "base_mode": "triangulated_boundary"})
        self.assertEqual(res_rust["status"], "ok")
        self.assertEqual(res_rust["integration_engine"], "rust_rayon_256")

        with patch.object(rust_accel, "HAS_RUST_CORE", False):
            res_py = engine.calculate_cut_fill_volume({"scan_id": scan_id, "base_mode": "triangulated_boundary"})
        self.assertEqual(res_py["status"], "ok")
        self.assertEqual(res_py["integration_engine"], "python_64")
        self.assertEqual(res_rust["planar_area_m2"], res_py["planar_area_m2"])

    def test_07_adversarial_edge_cases_cyclic_glb_nonconvex_polygon_collinear_and_nan(self):
        # 1. Cyclic GLB node graph (node 0 -> child 1 -> child 0) + zero-count primitive must not hang or crash
        pts = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0], [7.0, 8.0, 9.0]], dtype=np.float32)
        bin_blob = pts.tobytes()
        cyclic_gltf = {
            "asset": {"version": "2.0"},
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [
                {"mesh": 0, "children": [1]},
                {"children": [0]},
            ],
            "meshes": [
                {
                    "primitives": [
                        {"attributes": {"POSITION": 0}},
                        {"attributes": {"POSITION": 1}},
                    ]
                }
            ],
            "accessors": [
                {"bufferView": 0, "byteOffset": 0, "componentType": 5126, "count": 0, "type": "VEC3"},
                {"bufferView": 0, "byteOffset": 0, "componentType": 5126, "count": 3, "type": "VEC3"},
            ],
            "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(bin_blob)}],
            "buffers": [{"byteLength": len(bin_blob)}],
        }
        jb = json.dumps(cyclic_gltf).encode("utf-8")
        while len(jb) % 4 != 0:
            jb += b" "
        glb_cyclic = (
            struct.pack("<4sII", b"glTF", 2, 20 + len(jb) + 8 + len(bin_blob))
            + struct.pack("<I4s", len(jb), b"JSON")
            + jb
            + struct.pack("<I4s", len(bin_blob), b"BIN\x00")
            + bin_blob
        )
        rs_cyc = rust_accel.extract_glb_positions_fast(glb_cyclic)
        self.assertIsNotNone(rs_cyc)
        self.assertEqual(rs_cyc.shape, (3, 3))
        with patch.object(rust_accel, "HAS_RUST_CORE", False):
            py_cyc = DsmAndVolumeMixin._extract_glb_positions_from_bytes(glb_cyclic)
        self.assertIsNotNone(py_cyc)
        np.testing.assert_allclose(rs_cyc, py_cyc)

        # 2. Narrow non-convex / L-shaped polygon on 256x256 grid must not starve heatmap_cells
        nx, ny = 200, 200
        res = 0.10
        e_min, n_min = 302000.0, 2770000.0
        dsm_raw = np.full((ny, nx), 25.0, dtype=np.float32)
        dsm_curr = {
            "e_min": e_min,
            "n_min": n_min,
            "res": res,
            "dsm_raw": dsm_raw,
        }
        # Thin L-shaped trench covering ~6% of its 18m x 18m bounding box
        l_poly = [
            (e_min + 1.0, n_min + 1.0),
            (e_min + 19.0, n_min + 1.0),
            (e_min + 19.0, n_min + 1.6),
            (e_min + 1.6, n_min + 1.6),
            (e_min + 1.6, n_min + 19.0),
            (e_min + 1.0, n_min + 19.0),
        ]
        perim = [(x, y, 20.0) for (x, y) in l_poly]
        rs_l = rust_accel.integrate_cut_fill_grid(
            dsm_curr=dsm_curr,
            v_shift=0.0,
            poly_2d=l_poly,
            perim_samples=perim,
            base_mode="custom_plane",
            datum_z=20.0,
            plane_params=(0.0, 0.0, 20.0, e_min + 10.0, n_min + 10.0),
            origin_enh=(e_min + 10.0, n_min + 10.0, 20.0),
            max_grid_steps=256,
        )
        self.assertIsNotNone(rs_l)
        self.assertGreater(rs_l["inside_cells"], 2000)
        # Previously this was starved to ~150 cells; now it must return >= 1500 heatmap cells
        self.assertGreaterEqual(len(rs_l["heatmap_cells"]), 1500)
        self.assertLessEqual(len(rs_l["heatmap_cells"]), 2500)

        # 3. Degenerate collinear 1D triangle line & NaN/invalid voxel_size handling in compute_voxel_tensor_features
        t_vals = np.linspace(0.0, 5.0, 60)
        c_collinear = np.column_stack([t_vals, t_vals, t_vals]).astype(np.float64)
        n_collinear = np.tile([0.0, 0.0, 1.0], (60, 1)).astype(np.float64)
        a_tiny = np.full(60, 1e-6, dtype=np.float64)
        rs_tiny = rust_accel.compute_voxel_tensor_features(c_collinear, n_collinear, a_tiny, voxel_size=0.25)
        with patch.object(rust_accel, "HAS_RUST_CORE", False):
            py_tiny = compute_mesh_eigenvalue_features(c_collinear, n_collinear, a_tiny, voxel_size=0.25)
        self.assertIsNotNone(rs_tiny)
        np.testing.assert_allclose(rs_tiny["tri_linearity"], py_tiny["tri_linearity"], atol=1e-5)

        a_collinear = np.full(60, 0.05, dtype=np.float64)
        rs_col = rust_accel.compute_voxel_tensor_features(c_collinear, n_collinear, a_collinear, voxel_size=0.25)
        self.assertIsNotNone(rs_col)
        # Collinear points along (1, 1, 1) must have high linearity (> 0.99) and zero NaNs
        self.assertFalse(np.any(np.isnan(rs_col["tri_linearity"])))
        self.assertGreater(float(np.mean(rs_col["tri_linearity"])), 0.99)

        # Invalid voxel_size or NaN centroids must return None cleanly without panic
        self.assertIsNone(rust_accel.compute_voxel_tensor_features(c_collinear, n_collinear, a_collinear, voxel_size=-1.0))
        c_nan = c_collinear.copy()
        c_nan[5, 0] = np.nan
        self.assertIsNone(rust_accel.compute_voxel_tensor_features(c_nan, n_collinear, a_collinear, voxel_size=0.25))

        # 4. Marching Squares with NaN grid cell inside hull_mask and self-intersecting polygon clipping
        sub_grid = np.full((30, 30), 10.0, dtype=np.float32)
        sub_grid[10:20, 10:20] = 14.0
        sub_grid[12, 12] = np.nan
        sub_hull = np.ones((30, 30), dtype=bool)
        bowtie_poly = [
            (e_min + 0.5, n_min + 0.5),
            (e_min + 5.5, n_min + 5.5),
            (e_min + 5.5, n_min + 0.5),
            (e_min + 0.5, n_min + 5.5),
        ]
        rs_ms = rust_accel.extract_and_clip_contours_parallel(
            sub_grid=sub_grid,
            sub_hull=sub_hull,
            sub_e_min=e_min,
            sub_n_min=n_min,
            res=0.20,
            levels=[12.0],
            major_interval=0.0,
            ce=e_min + 3.0,
            cn=n_min + 3.0,
            ch=10.0,
            poly_2d=bowtie_poly,
        )
        self.assertIsNotNone(rs_ms)
        for c_item in rs_ms:
            for pt in c_item["points_twd97"]:
                self.assertTrue(all(math.isfinite(v) for v in pt))


if __name__ == "__main__":
    unittest.main()

