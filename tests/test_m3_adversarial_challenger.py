"""
Empirical Adversarial Verification & Stress Test Suite for Milestone 3:
- Centerline Stationing & Average-End-Area (AEA) Cut/Fill Volume Takeoff
- Priority-Flood Surface Depression Ponding Takeoff & Custom Slope Tiers

Agent: challenger_m3_1
"""

import math
import os
import shutil
import tempfile
import unittest
import urllib.request
import json
import numpy as np

from pc_worker.surveying_engine import SurveyingEngine
from pc_worker.priority_queue import ScanQueueDB


class TestMilestone3AdversarialChallenger(unittest.TestCase):
    """
    Adversarial numerical invariance, degenerate alignment, extreme boundary,
    and synthetic ground profile test suite for Milestone 3.
    """

    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp(prefix="gs_test_m3_challenger_")
        self.scan_id = "test_m3_challenger_scan"
        self.scan_dir = os.path.join(self.tmp_dir, self.scan_id)
        os.makedirs(self.scan_dir, exist_ok=True)
        with open(os.path.join(self.scan_dir, "model.obj"), "w", encoding="utf-8") as f:
            f.write("# dummy mesh\nv 0 0 0\n")

        self.db = ScanQueueDB(db_path=os.path.join(self.tmp_dir, "test_queue.db"))
        self.db.upsert_scan({
            "scan_id": self.scan_id,
            "project_name": "M3 Adversarial Stress",
            "project_group": "M3_Testing",
            "project_dir": self.scan_dir,
            "twd97_e": 304950.0,
            "twd97_n": 2757080.0,
            "twd97_h": 100.0,
            "crs": "TWD97 / TM2 zone 121 + TWVD 2001 height - EPSG:3826+8904",
        })
        self.survey = SurveyingEngine(self.db)

    def tearDown(self):
        try:
            shutil.rmtree(self.tmp_dir)
        except OSError:
            pass

    def _create_synthetic_dsm(self, grid, e_min, e_max, n_min, n_max, res, ce=304950.0, cn=2757080.0, ch=100.0):
        ny, nx = grid.shape
        hull_mask = np.ones((ny, nx), dtype=bool)
        npz_path = os.path.join(self.scan_dir, "_dsm_cache_v5.npz")
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
            dsm_raw=grid.astype(np.float32),
            dsm_contour=grid.astype(np.float32),
            hull_mask=hull_mask,
        )
        if hasattr(self.survey, "_dsm_mem_cache"):
            self.survey._dsm_mem_cache.pop(self.scan_id, None)

    # =========================================================================
    # CHALLENGE 1: Priority-Flood Synthetic Bowl (Analytical V = 1/2 * pi * r^2 * h)
    # =========================================================================
    def test_01_priority_flood_synthetic_bowl_analytical_volume(self):
        """
        Stress test Priority-Flood depression volume against synthetic paraboloid bowl:
        z(r) = z_rim - h * (1 - (r/R)^2) for r <= R, else z_rim.
        Analytical volume: V = 1/2 * pi * R^2 * h.
        Verify numerical volume matches analytical expectation within 1.0%!
        Verify max depth matches h within discretization tolerance.
        Verify spill elevation equals z_rim.
        Verify pour-point spill elevation >= min(z).
        """
        R = 15.0   # Radius 15m
        h = 3.0    # Depth 3m
        z_rim = 100.0
        res = 0.5  # 0.5m grid resolution
        e_min, e_max = 304900.0, 305000.0  # 100m span
        n_min, n_max = 2757030.0, 2757130.0  # 100m span
        ce, cn, ch = 304950.0, 2757080.0, 100.0

        nx = int(round((e_max - e_min) / res)) + 1
        ny = int(round((n_max - n_min) / res)) + 1
        x = np.linspace(e_min, e_max, nx)
        y = np.linspace(n_min, n_max, ny)
        xx, yy = np.meshgrid(x, y)
        rr = np.hypot(xx - ce, yy - cn)

        grid = np.full((ny, nx), z_rim, dtype=np.float32)
        bowl_mask = rr <= R
        grid[bowl_mask] = z_rim - h * (1.0 - (rr[bowl_mask] / R) ** 2)

        v_analytical = 0.5 * math.pi * (R ** 2) * h  # 0.5 * pi * 225 * 3 = 1060.2875 m³

        self._create_synthetic_dsm(grid, e_min, e_max, n_min, n_max, res, ce, cn, ch)

        # Run via compute_drainage_and_slope
        res_drainage = self.survey.compute_drainage_and_slope({
            "scan_id": self.scan_id,
            "min_ponding_depth_m": 0.05,
        })
        self.assertEqual(res_drainage["status"], "ok")
        self.assertEqual(res_drainage["depression_count"], 1)

        dep = res_drainage["depressions"][0]
        v_num = dep["volume_m3"]
        err_pct = abs(v_num - v_analytical) / v_analytical * 100.0

        # Empirical challenge: verify numerical volume matches analytical expectation within 1%
        self.assertLess(err_pct, 1.0, f"Numerical volume {v_num} m³ deviates by {err_pct:.3f}% from analytical {v_analytical} m³ (> 1.0%)")

        # Verify max depth matches h within 0.05m
        self.assertAlmostEqual(dep["max_depth_m"], h, delta=0.05)

        # Verify spill elevation equals z_rim
        self.assertAlmostEqual(dep["spill_elevation_m"], z_rim, delta=0.05)

        # Verify min elevation equals z_rim - h
        self.assertAlmostEqual(dep["min_elevation_m"], z_rim - h, delta=0.05)

        # Verify pour-point spill elevation is strictly >= min(z)
        self.assertGreaterEqual(dep["spill_elevation_m"], dep["min_elevation_m"])

    # =========================================================================
    # CHALLENGE 2: Priority-Flood Flat Plane Invariance (Volume strictly 0.0 m³)
    # =========================================================================
    def test_02_priority_flood_flat_plane_strictly_zero(self):
        """
        Stress test Priority-Flood on a perfectly flat horizontal plane:
        Verify depression count is strictly 0 and total depression volume is strictly 0.0 m³.
        """
        res = 1.0
        e_min, e_max = 304900.0, 305000.0
        n_min, n_max = 2757030.0, 2757130.0
        nx = int((e_max - e_min) / res)
        ny = int((n_max - n_min) / res)
        grid = np.full((ny, nx), 125.0, dtype=np.float32)

        self._create_synthetic_dsm(grid, e_min, e_max, n_min, n_max, res)

        res_drainage = self.survey.compute_drainage_and_slope({
            "scan_id": self.scan_id,
            "min_ponding_depth_m": 0.05,
        })
        self.assertEqual(res_drainage["status"], "ok")
        self.assertEqual(res_drainage["depression_count"], 0)
        self.assertEqual(res_drainage["total_ponding_volume_m3"], 0.0)
        self.assertEqual(len(res_drainage["depressions"]), 0)

    # =========================================================================
    # CHALLENGE 3: Priority-Flood Extreme Slope Plane (No spurious depressions)
    # =========================================================================
    def test_03_priority_flood_extreme_slope_no_spurious_depressions(self):
        """
        Stress test Priority-Flood on an extreme steep sloping plane (45° / 100% grade):
        Verify no spurious depressions are generated on runoff slopes.
        """
        res = 1.0
        e_min, e_max = 304900.0, 305000.0
        n_min, n_max = 2757030.0, 2757130.0
        nx = int((e_max - e_min) / res)
        ny = int((n_max - n_min) / res)

        # 45-degree slope (dz/de = 1.0, dz/dn = 1.0)
        x = np.linspace(0, 100, nx)
        y = np.linspace(0, 100, ny)
        xx, yy = np.meshgrid(x, y)
        grid = 100.0 + xx + yy  # monotonic steep incline

        self._create_synthetic_dsm(grid, e_min, e_max, n_min, n_max, res)

        res_drainage = self.survey.compute_drainage_and_slope({
            "scan_id": self.scan_id,
            "min_ponding_depth_m": 0.05,
        })
        self.assertEqual(res_drainage["status"], "ok")
        self.assertEqual(res_drainage["depression_count"], 0)
        self.assertEqual(res_drainage["total_ponding_volume_m3"], 0.0)

    # =========================================================================
    # CHALLENGE 4: Priority-Flood Saddle Pour-Point Elevation >= min(z)
    # =========================================================================
    def test_04_priority_flood_saddle_spill_elevation_invariance(self):
        """
        Verify that for multiple irregular depressions with varying saddle spill levels:
        spill_elevation_m is strictly >= min_elevation_m in every depression,
        and max_depth_m equals spill_elevation_m - min_elevation_m within numerical discretization.
        """
        res = 0.5
        e_min, e_max = 304900.0, 305000.0
        n_min, n_max = 2757030.0, 2757130.0
        nx = int((e_max - e_min) / res)
        ny = int((n_max - n_min) / res)
        grid = np.full((ny, nx), 110.0, dtype=np.float32)

        # Sink 1: depth 4.0m, rim 110.0m
        grid[20:50, 20:50] = 106.0
        # Sink 2: depth 2.5m, rim 110.0m
        grid[100:140, 100:140] = 107.5
        # Sink 3: stepped terrace sink with low saddle (spill at 108.0)
        grid[140:180, 20:60] = 105.0
        grid[140:180, 59:61] = 108.0  # saddle spill lip

        self._create_synthetic_dsm(grid, e_min, e_max, n_min, n_max, res)

        res_drainage = self.survey.compute_drainage_and_slope({
            "scan_id": self.scan_id,
            "min_ponding_depth_m": 0.10,
        })
        self.assertEqual(res_drainage["status"], "ok")
        self.assertGreaterEqual(res_drainage["depression_count"], 2)

        for dep in res_drainage["depressions"]:
            self.assertGreaterEqual(dep["spill_elevation_m"], dep["min_elevation_m"])
            calc_depth = dep["spill_elevation_m"] - dep["min_elevation_m"]
            self.assertAlmostEqual(dep["max_depth_m"], calc_depth, delta=0.1)
            self.assertGreater(dep["volume_m3"], 0.0)
            self.assertGreater(dep["surface_area_m2"], 0.0)

    # =========================================================================
    # CHALLENGE 5: Degenerate Centerline Alignments Handling
    # =========================================================================
    def test_05_degenerate_centerline_alignments(self):
        """
        Adversarial stress test on degenerate centerline alignment inputs:
        - Single point alignment
        - Collinear points (3 identical slope segments along same line)
        - Zero-length segment / duplicate identical points
        - Alignments completely outside DSM grid bounds
        Verify that none crash, all return valid responses with status 'ok' and clean geometry.
        """
        # Baseline flat DSM at Z = 100.0m
        res = 1.0
        e_min, e_max = 304900.0, 305000.0
        n_min, n_max = 2757030.0, 2757130.0
        nx = int((e_max - e_min) / res)
        ny = int((n_max - n_min) / res)
        grid = np.full((ny, nx), 100.0, dtype=np.float32)
        self._create_synthetic_dsm(grid, e_min, e_max, n_min, n_max, res)

        # 1. Single point alignment
        res_single = self.survey.compute_centerline_stationing_and_volume({
            "scan_id": self.scan_id,
            "alignment": [[304950.0, 2757080.0]],
        })
        self.assertEqual(res_single["status"], "ok")
        self.assertGreater(res_single["total_length_m"], 0.0)
        self.assertGreaterEqual(res_single["station_count"], 2)

        # 2. Collinear points along same easting
        res_collinear = self.survey.compute_centerline_stationing_and_volume({
            "scan_id": self.scan_id,
            "alignment": [
                [304920.0, 2757050.0],
                [304940.0, 2757050.0],
                [304960.0, 2757050.0],
                [304980.0, 2757050.0],
            ],
            "interval": 10.0,
            "swath_width": 10.0,
        })
        self.assertEqual(res_collinear["status"], "ok")
        self.assertAlmostEqual(res_collinear["total_length_m"], 60.0, places=2)
        self.assertEqual(res_collinear["station_count"], 7)  # 0, 10, 20, 30, 40, 50, 60

        # 3. Duplicate identical points (zero-length segment)
        res_duplicate = self.survey.compute_centerline_stationing_and_volume({
            "scan_id": self.scan_id,
            "alignment": [
                [304930.0, 2757060.0],
                [304930.0, 2757060.0],  # duplicate
                [304960.0, 2757060.0],
            ],
            "interval": 10.0,
            "swath_width": 8.0,
        })
        self.assertEqual(res_duplicate["status"], "ok")
        self.assertAlmostEqual(res_duplicate["total_length_m"], 30.0, places=2)

        # What if ALL points are identical?
        res_all_identical = self.survey.compute_centerline_stationing_and_volume({
            "scan_id": self.scan_id,
            "alignment": [
                [304930.0, 2757060.0],
                [304930.0, 2757060.0],
            ],
        })
        self.assertEqual(res_all_identical["status"], "ok")
        self.assertGreater(res_all_identical["total_length_m"], 0.0)

        # 4. Alignment completely outside DSM grid bounds
        res_out_of_bounds = self.survey.compute_centerline_stationing_and_volume({
            "scan_id": self.scan_id,
            "alignment": [
                [500000.0, 3000000.0],
                [500080.0, 3000000.0],
            ],
            "interval": 20.0,
            "swath_width": 10.0,
        })
        self.assertEqual(res_out_of_bounds["status"], "ok")
        self.assertAlmostEqual(res_out_of_bounds["total_length_m"], 80.0, places=2)
        self.assertEqual(res_out_of_bounds["station_count"], 5)
        # Elevations clamped gracefully to nearest border
        for st in res_out_of_bounds["stations"]:
            self.assertAlmostEqual(st["cl_ground_z"], 100.0, delta=0.1)

    # =========================================================================
    # CHALLENGE 6: Extreme Swath Widths and Interval Resolutions
    # =========================================================================
    def test_06_extreme_swath_widths_and_intervals(self):
        """
        Stress test extreme parameter bounds:
        - Swath width: 0.01m (clamped to safe min 2.0m) vs 500m (huge swath)
        - Interval resolution: 0.1m (clamped to safe min 1.0m) vs 50m (sparse interval)
        Verify no division-by-zero, no infinite loops, clean numerical convergence.
        """
        res = 1.0
        e_min, e_max = 304900.0, 305000.0
        n_min, n_max = 2757030.0, 2757130.0
        nx = int((e_max - e_min) / res)
        ny = int((n_max - n_min) / res)
        grid = np.full((ny, nx), 100.0, dtype=np.float32)
        self._create_synthetic_dsm(grid, e_min, e_max, n_min, n_max, res)

        align = [[304920.0, 2757060.0], [304960.0, 2757060.0]]  # 40m

        # Extreme min swath width 0.01m
        res_min_swath = self.survey.compute_centerline_stationing_and_volume({
            "scan_id": self.scan_id,
            "alignment": align,
            "swath_width": 0.01,
        })
        self.assertEqual(res_min_swath["status"], "ok")
        self.assertGreaterEqual(res_min_swath["swath_width_m"], 2.0)

        # Extreme large swath width 500m
        res_large_swath = self.survey.compute_centerline_stationing_and_volume({
            "scan_id": self.scan_id,
            "alignment": align,
            "swath_width": 500.0,
        })
        self.assertEqual(res_large_swath["status"], "ok")
        self.assertEqual(res_large_swath["swath_width_m"], 500.0)

        # Extreme min interval 0.1m
        res_min_interval = self.survey.compute_centerline_stationing_and_volume({
            "scan_id": self.scan_id,
            "alignment": align,
            "interval": 0.1,
        })
        self.assertEqual(res_min_interval["status"], "ok")
        self.assertGreaterEqual(res_min_interval["interval_m"], 1.0)
        self.assertLessEqual(res_min_interval["station_count"], 45)  # 40m / 1m + 1 = 41 stations

        # Extreme large interval 50m (larger than alignment length 40m)
        res_large_interval = self.survey.compute_centerline_stationing_and_volume({
            "scan_id": self.scan_id,
            "alignment": align,
            "interval": 50.0,
        })
        self.assertEqual(res_large_interval["status"], "ok")
        self.assertEqual(res_large_interval["station_count"], 2)  # start and end

    # =========================================================================
    # CHALLENGE 7: AEA Trapezoidal Quadrature & Zero-Crossing Linear Interpolation
    # =========================================================================
    def test_07_trapezoidal_quadrature_and_zero_crossing_linear_interpolation(self):
        """
        Stress test trapezoidal quadrature and zero-crossing linear interpolation against
        known analytical geometry:

        Part A — Simple Linear Grade with Uniform Cut:
        Terrain flat at Z = 100.0m. Alignment L = 40.0m.
        Design template: flat bed B = 10.0m at fixed Z = 96.0m (depth = 4.0m cut).
        Swath width = 10.0m (vertical sidewalls).
        Analytical cross-section cut area: A_cut = 10.0 * 4.0 = 40.0 m².
        Analytical total cut volume: V_cut = 40.0 m² * 40.0 m = 1600.0 m³.
        Fill volume: strictly 0.0 m³.

        Part B — Transverse Cross-Slope with Dual Cut & Fill Zero-Crossing:
        Terrain has a linear transverse slope across swath u in [-5, +5]:
        z_ground(u) = 100.0 + 2.0 * u.
        Design template: flat bed at Z = 100.0m across swath [-5, +5].
        dz(u) = 2.0 * u:
        - For u in [-5, 0]: dz <= 0 -> FILL triangle: base = 5m, height = 10m -> A_fill = 0.5 * 5 * 10 = 25.0 m²
        - For u in [0, +5]: dz >= 0 -> CUT triangle: base = 5m, height = 10m -> A_cut = 0.5 * 5 * 10 = 25.0 m²
        Analytical AEA volumes across L = 40.0m:
        V_cut = 25.0 m² * 40.0 m = 1000.0 m³.
        V_fill = 25.0 m² * 40.0 m = 1000.0 m³.
        V_net = 0.0 m³.
        Verify that zero-crossing linear interpolation computes BOTH Cut and Fill without cross-cancellation!
        """
        res = 0.5
        e_min, e_max = 304900.0, 305000.0
        n_min, n_max = 2757030.0, 2757130.0
        nx = int((e_max - e_min) / res)
        ny = int((n_max - n_min) / res)

        # Part A: Flat ground
        grid_flat = np.full((ny, nx), 100.0, dtype=np.float32)
        self._create_synthetic_dsm(grid_flat, e_min, e_max, n_min, n_max, res)

        payload_part_a = {
            "scan_id": self.scan_id,
            "alignment": [[304920.0, 2757070.0], [304960.0, 2757070.0]],
            "interval": 10.0,
            "swath_width": 10.0,
            "template_type": "flat",
            "bed_width": 10.0,
            "design_elevation": 96.0,
        }
        res_a = self.survey.compute_centerline_stationing_and_volume(payload_part_a)
        self.assertEqual(res_a["status"], "ok")
        self.assertAlmostEqual(res_a["total_length_m"], 40.0, places=2)

        for st in res_a["stations"]:
            self.assertAlmostEqual(st["cut_area_m2"], 40.0, delta=0.5)
            self.assertAlmostEqual(st["fill_area_m2"], 0.0, delta=0.01)

        self.assertAlmostEqual(res_a["total_cut_volume_m3"], 1600.0, delta=20.0)
        self.assertAlmostEqual(res_a["total_fill_volume_m3"], 0.0, delta=0.5)

        # Part B: Transverse slope with zero-crossing
        # Alignment is along east-west line N = 2757080.0
        # u is orthogonal (along North-South axis: +u is North, -u is South)
        # We construct ground: z(N) = 100.0 + 2.0 * (N - 2757080.0)
        grid_slope = np.zeros((ny, nx), dtype=np.float32)
        for r in range(ny):
            y_n = n_min + r * res
            grid_slope[r, :] = 100.0 + 2.0 * (y_n - 2757080.0)

        self._create_synthetic_dsm(grid_slope, e_min, e_max, n_min, n_max, res)

        payload_part_b = {
            "scan_id": self.scan_id,
            "alignment": [[304930.0, 2757080.0], [304970.0, 2757080.0]],  # L = 40m along N=2757080
            "interval": 10.0,
            "swath_width": 10.0,
            "template_type": "flat",
            "bed_width": 10.0,
            "design_elevation": 100.0,
        }
        res_b = self.survey.compute_centerline_stationing_and_volume(payload_part_b)
        self.assertEqual(res_b["status"], "ok")
        self.assertAlmostEqual(res_b["total_length_m"], 40.0, places=2)

        # Check that each station has cut area ~ 25 m² and fill area ~ 25 m²
        for st in res_b["stations"]:
            self.assertAlmostEqual(st["cut_area_m2"], 25.0, delta=1.5)
            self.assertAlmostEqual(st["fill_area_m2"], 25.0, delta=1.5)

        # Check total volumes: V_cut ~ 1000 m³, V_fill ~ 1000 m³, net ~ 0.0 m³
        self.assertAlmostEqual(res_b["total_cut_volume_m3"], 1000.0, delta=50.0)
        self.assertAlmostEqual(res_b["total_fill_volume_m3"], 1000.0, delta=50.0)
        self.assertAlmostEqual(res_b["net_volume_m3"], 0.0, delta=10.0)

        # Part C: Parabolic ditch with known analytical volume
        # Terrain has a parabolic ditch across N-axis: z(u) = 100.0 - h * (1 - (u/W)^2)
        # With h = 3.0m, W = 5.0m across swath [-5, +5].
        # Template is flat at Z = 100.0m.
        # Analytical Fill Area: A_fill = 4/3 * h * W = 4/3 * 3 * 5 = 20.0 m².
        # Total Fill Volume across L = 40.0m: V_fill = 20.0 * 40.0 = 800.0 m³.
        grid_parabola = np.zeros((ny, nx), dtype=np.float32)
        for r in range(ny):
            y_n = n_min + r * res
            u_dist = y_n - 2757080.0
            if abs(u_dist) <= 5.0:
                grid_parabola[r, :] = 100.0 - 3.0 * (1.0 - (u_dist / 5.0) ** 2)
            else:
                grid_parabola[r, :] = 100.0

        self._create_synthetic_dsm(grid_parabola, e_min, e_max, n_min, n_max, res)

        payload_part_c = {
            "scan_id": self.scan_id,
            "alignment": [[304930.0, 2757080.0], [304970.0, 2757080.0]],  # L = 40m
            "interval": 10.0,
            "swath_width": 10.0,
            "template_type": "flat",
            "bed_width": 10.0,
            "design_elevation": 100.0,
        }
        res_c = self.survey.compute_centerline_stationing_and_volume(payload_part_c)
        self.assertEqual(res_c["status"], "ok")
        for st in res_c["stations"]:
            self.assertAlmostEqual(st["fill_area_m2"], 20.0, delta=0.5)
            self.assertAlmostEqual(st["cut_area_m2"], 0.0, delta=0.01)

        self.assertAlmostEqual(res_c["total_fill_volume_m3"], 800.0, delta=20.0)
        self.assertAlmostEqual(res_c["total_cut_volume_m3"], 0.0, delta=1.0)

    # =========================================================================
    # CHALLENGE 8: Live Server HTTP Endpoints Sanity Check
    # =========================================================================
    def test_08_live_server_endpoints(self):
        """
        Verify live server HTTP endpoints:
        - http://127.0.0.1:8095/api/survey/stationing
        - http://127.0.0.1:8095/api/survey/drainage
        Respond with 200 OK and valid JSON data on a real local scan.
        """
        try:
            req_status = urllib.request.Request("http://127.0.0.1:8095/api/status")
            with urllib.request.urlopen(req_status, timeout=3) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                self.assertEqual(data.get("status"), "online")
        except Exception as e:
            self.skipTest(f"Local server 127.0.0.1:8095 not running: {e}")

        # Test live stationing endpoint
        req_st = urllib.request.Request(
            "http://127.0.0.1:8095/api/survey/stationing",
            data=json.dumps({
                "scan_id": "quchi_20261005_merged",
                "interval": 10.0,
                "swath_width": 16.0,
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req_st, timeout=10) as resp:
            self.assertEqual(resp.status, 200)
            res_json = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(res_json.get("status"), "ok")
            self.assertGreater(res_json.get("total_length_m", 0), 0)
            self.assertGreater(res_json.get("station_count", 0), 1)

        # Test live drainage & ponding endpoint
        req_dr = urllib.request.Request(
            "http://127.0.0.1:8095/api/survey/drainage",
            data=json.dumps({
                "scan_id": "quchi_20261005_merged",
                "min_ponding_depth_m": 0.10,
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req_dr, timeout=10) as resp:
            self.assertEqual(resp.status, 200)
            res_json = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(res_json.get("status"), "ok")
            self.assertIn("depressions", res_json)
            self.assertIn("tiers", res_json)


if __name__ == "__main__":
    unittest.main()
