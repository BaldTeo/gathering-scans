#!/usr/bin/env python3
"""
Adversarial Empirical Stress Harness for Milestone 1 (M1)
Review Scope: `pc_worker/surveying/dsm_and_volume.py` (calculate_cut_fill_volume & least-squares plane)
Role: Teamwork Challenger (critic, specialist)
"""

import math
import sys
import os
import unittest
from typing import List, Tuple, Dict, Any
import numpy as np

# Ensure project root is in sys.path
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from pc_worker.priority_queue import ScanQueueDB
from pc_worker.config import DB_PATH
from pc_worker.surveying_engine import SurveyingEngine


def solve_least_squares_plane(plane_pts: List[Tuple[float, float, float]]) -> Dict[str, Any]:
    """
    Exact mathematical replica of lines 1096-1138 of pc_worker/surveying/dsm_and_volume.py
    for isolated numerical analysis and oracle comparison.
    """
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

        # Safeguard: singularity / collinear points fallback to horizontal mean plane
        if abs(det_plane) < 1e-9 or trace_plane < 1e-6:
            plane_a = 0.0
            plane_b = 0.0
            plane_c0 = p_mean_h
        else:
            plane_a = (suw * svv - svw * suv) / det_plane
            plane_b = (svw * suu - suw * suv) / det_plane
            plane_c0 = p_mean_h
    else:
        p_mean_e = plane_pts[0][0] if plane_pts else 0.0
        p_mean_n = plane_pts[0][1] if plane_pts else 0.0
        p_mean_h = plane_pts[0][2] if plane_pts else 0.0
        plane_a = 0.0
        plane_b = 0.0
        plane_c0 = p_mean_h
        det_plane = 0.0
        trace_plane = 0.0

    plane_c = plane_c0 - plane_a * p_mean_e - plane_b * p_mean_n
    plane_slope_mag = math.hypot(plane_a, plane_b)
    plane_slope_pct = round(plane_slope_mag * 100.0, 3)
    plane_slope_deg = round(math.degrees(math.atan(plane_slope_mag)), 2)
    plane_azimuth_deg = (
        round(math.degrees(math.atan2(plane_a, plane_b)) % 360.0, 2)
        if plane_slope_mag > 1e-7
        else 0.0
    )

    return {
        "a": plane_a,
        "b": plane_b,
        "c": plane_c,
        "c0": plane_c0,
        "e0": p_mean_e,
        "n0": p_mean_n,
        "det": det_plane,
        "trace": trace_plane,
        "slope_pct": plane_slope_pct,
        "slope_deg": plane_slope_deg,
        "azimuth_deg": plane_azimuth_deg,
    }


class AdversarialM1TestSuite(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = ScanQueueDB(DB_PATH)
        cls.survey = SurveyingEngine(cls.db)

    # =========================================================================
    # Category 1: Extreme Slopes (89.9-degree near-vertical terrain & cliffs)
    # =========================================================================
    def test_cat1_extreme_slope_89_9_degrees_all_azimuths(self):
        """Test extreme 89.9-degree near-vertical terrain across 8 compass azimuths."""
        target_deg = 89.9
        slope_mag = math.tan(math.radians(target_deg))  # ~572.957795
        expected_slope_pct = round(slope_mag * 100.0, 3)

        for az_deg in [0.0, 45.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0]:
            rad = math.radians(az_deg)
            expected_a = slope_mag * math.sin(rad)
            expected_b = slope_mag * math.cos(rad)

            pts = []
            for dx in [-10.0, 0.0, 10.0]:
                for dy in [-10.0, 0.0, 10.0]:
                    e = 300000.0 + dx
                    n = 2700000.0 + dy
                    h = 100.0 + expected_a * dx + expected_b * dy
                    pts.append((e, n, h))

            fit = solve_least_squares_plane(pts)

            self.assertFalse(math.isnan(fit["a"]), f"NaN in a at az={az_deg}")
            self.assertFalse(math.isnan(fit["b"]), f"NaN in b at az={az_deg}")
            self.assertFalse(math.isnan(fit["slope_deg"]), f"NaN in slope_deg at az={az_deg}")
            self.assertAlmostEqual(fit["a"], expected_a, places=5)
            self.assertAlmostEqual(fit["b"], expected_b, places=5)
            self.assertAlmostEqual(fit["slope_deg"], target_deg, places=2)
            self.assertAlmostEqual(fit["slope_pct"], expected_slope_pct, places=1)
            self.assertAlmostEqual(fit["azimuth_deg"] % 360.0, az_deg % 360.0, places=1)

    def test_cat1_extreme_slope_89_99_degree_cliff(self):
        """Test 89.99-degree extreme cliff (slope = 5729.58, >570,000%)."""
        target_deg = 89.99
        slope_mag = math.tan(math.radians(target_deg))  # ~5729.5779
        pts = [
            (300000.0, 2700000.0, 100.0),
            (300010.0, 2700000.0, 100.0 + slope_mag * 10.0),  # Pure East cliff
            (300010.0, 2700010.0, 100.0 + slope_mag * 10.0),
            (300000.0, 2700010.0, 100.0),
        ]
        fit = solve_least_squares_plane(pts)
        self.assertAlmostEqual(fit["slope_deg"], target_deg, places=2)
        self.assertAlmostEqual(fit["azimuth_deg"], 90.0, places=1)
        self.assertFalse(math.isnan(fit["c"]))

    def test_cat1_end_to_end_extreme_slope_on_synthetic_scan(self):
        """End-to-end calculate_cut_fill_volume on synthetic 89.9-degree terrain."""
        target_deg = 89.9
        slope_mag = math.tan(math.radians(target_deg))

        nx, ny = 100, 100
        res = 0.2
        e_min, n_min = 300000.0, 2700000.0
        grid = np.zeros((ny, nx), dtype=np.float64)
        for iy in range(ny):
            for ix in range(nx):
                grid[iy, ix] = 100.0 + slope_mag * (ix * res)

        synthetic_dsm = {
            "scan_id": "synth_steep_cliff",
            "ce": 300010.0,
            "cn": 2700010.0,
            "ch": 100.0,
            "e_min": e_min,
            "e_max": e_min + nx * res,
            "n_min": n_min,
            "n_max": n_min + ny * res,
            "res": res,
            "dsm_raw": grid,
            "dsm_contour": grid,
            "hull_mask": np.ones((ny, nx), dtype=bool),
            "source_mtime": 0.0,
        }

        self.survey._dsm_mem_cache["synth_steep_cliff"] = synthetic_dsm
        orig_resolve = self.survey._resolve_scan_record
        self.survey._resolve_scan_record = lambda sid: {"scan_id": sid, "name": "Synthetic Cliff", "project_group": "Test"} if sid == "synth_steep_cliff" else orig_resolve(sid)

        try:
            vol = self.survey.calculate_cut_fill_volume({
                "scan_id": "synth_steep_cliff",
                "base_mode": "best_fit_plane",
                "polygon": [
                    [300005.0, 2700005.0],
                    [300015.0, 2700005.0],
                    [300015.0, 2700015.0],
                    [300005.0, 2700015.0],
                ],
            })
            self.assertEqual(vol["status"], "ok")
            bfp = vol["best_fit_plane"]
            self.assertAlmostEqual(bfp["slope_deg"], 89.9, places=1)
            self.assertAlmostEqual(bfp["azimuth_deg"], 90.0, places=1)
            self.assertGreater(vol["surface_area_m2"], 50000.0)
            self.assertEqual(vol["cut_volume_bcm"], 0.0)
            self.assertEqual(vol["fill_volume_bcm"], 0.0)
        finally:
            self.survey._resolve_scan_record = orig_resolve

    # =========================================================================
    # Category 2: Collinear & Near-Collinear Points (Determinant Collapse)
    # =========================================================================
    def test_cat2_ten_collinear_points_horizontal(self):
        """10 perfectly collinear points along E axis (det_plane == 0.0)."""
        pts = [(300000.0 + i * 5.0, 2700000.0, 50.0 + i * 0.5) for i in range(10)]
        fit = solve_least_squares_plane(pts)
        self.assertLess(abs(fit["det"]), 1e-9)
        self.assertEqual(fit["a"], 0.0)
        self.assertEqual(fit["b"], 0.0)
        self.assertEqual(fit["slope_pct"], 0.0)
        self.assertEqual(fit["slope_deg"], 0.0)
        self.assertEqual(fit["azimuth_deg"], 0.0)
        mean_h = sum(p[2] for p in pts) / 10
        self.assertAlmostEqual(fit["c0"], mean_h, places=5)

    def test_cat2_ten_collinear_points_arbitrary_angle(self):
        """10 collinear points along line 3E - 4N = const."""
        pts = [(300000.0 + 4.0 * i, 2700000.0 + 3.0 * i, 100.0 + i * 2.0) for i in range(10)]
        fit = solve_least_squares_plane(pts)
        self.assertLess(abs(fit["det"]), 1e-9)
        self.assertEqual(fit["a"], 0.0)
        self.assertEqual(fit["b"], 0.0)
        self.assertEqual(fit["slope_pct"], 0.0)

    def test_cat2_three_points_179_999_degree_angle(self):
        """3 points forming an almost straight line (179.999-degree angle)."""
        offset_m = 50.0 * math.tan(math.radians(0.0005))
        pts = [
            (300000.0, 2700000.0, 50.0),
            (300050.0, 2700000.0 + offset_m, 50.5),
            (300100.0, 2700000.0, 51.0),
        ]
        fit = solve_least_squares_plane(pts)
        self.assertFalse(math.isnan(fit["a"]))
        self.assertFalse(math.isnan(fit["b"]))
        self.assertFalse(math.isinf(fit["a"]))
        self.assertFalse(math.isinf(fit["b"]))

    def test_cat2_identical_coincident_points(self):
        """Points that are all identical (trace_plane == 0)."""
        pts = [(300000.0, 2700000.0, 50.0)] * 5
        fit = solve_least_squares_plane(pts)
        self.assertEqual(fit["a"], 0.0)
        self.assertEqual(fit["b"], 0.0)
        self.assertEqual(fit["c0"], 50.0)

    def test_cat2_end_to_end_collinear_polygon_on_scan(self):
        """End-to-end calculate_cut_fill_volume with collinear points on real scan."""
        vol = self.survey.calculate_cut_fill_volume({
            "scan_id": "quchi_20261005_merged",
            "base_mode": "best_fit_plane",
            "polygon": [
                [304940.0, 2757070.0, 42.0],
                [304950.0, 2757070.0, 42.5],
                [304960.0, 2757070.0, 43.0],
                [304970.0, 2757070.0, 43.5],
            ],
        })
        self.assertEqual(vol["status"], "ok")
        bfp = vol["best_fit_plane"]
        self.assertEqual(bfp["slope_pct"], 0.0)
        self.assertEqual(bfp["a"], 0.0)
        self.assertEqual(bfp["b"], 0.0)

    # =========================================================================
    # Adversarial Flaw Reproductions (Collinear Safeguard Vulnerability)
    # =========================================================================
    def test_cat2_adversarial_finding_100m_collinear_negative_det_leak(self):
        """
        FINDING 1: On a 100m collinear alignment at 35 degrees, float64 noise makes
        det = -7.45e-9. Because abs(det) = 7.45e-9 > 1e-9, the safeguard FAILS to trigger,
        producing a phantom plane with slope = 8.839% instead of 0.0%!
        """
        angle = math.radians(35.0)
        dx, dy = math.cos(angle), math.sin(angle)
        pts = [
            (300000.0 + (k / 9.0 - 0.5) * 100.0 * dx, 2700000.0 + (k / 9.0 - 0.5) * 100.0 * dy, 50.0 + 0.1 * (k / 9.0 - 0.5) * 100.0)
            for k in range(10)
        ]
        fit = solve_least_squares_plane(pts)
        # Demonstrates the empirical vulnerability in line 1114
        self.assertLess(fit["det"], 0.0, "Determinant is negative due to floating-point cancellation")
        self.assertGreater(abs(fit["det"]), 1e-9, "abs(det) exceeds 1e-9 threshold")
        # Because of the bug, slope_pct is not 0.0
        self.assertGreater(fit["slope_pct"], 0.0, "Spurious non-zero slope generated on collinear points")

    def test_cat2_adversarial_finding_10m_179_999_deg_submillimeter_anomaly(self):
        """
        FINDING 2: 3 points forming a 179.999-degree angle (0.0436 mm lateral deviation)
        with a 10m baseline and 5cm elevation difference produces det = 6.35e-8 > 1e-9.
        The safeguard fails and computes a 114,591% slope (89.95 degrees)!
        """
        offset = 5.0 * math.tan(math.radians(0.0005))  # 0.0436 mm
        pts = [
            (300000.0, 2700000.0, 50.0),
            (300005.0, 2700000.0 + offset, 50.05),
            (300010.0, 2700000.0, 50.0),
        ]
        fit = solve_least_squares_plane(pts)
        self.assertGreater(fit["det"], 1e-9, "det exceeds 1e-9 despite points being collinear to 0.04mm")
        self.assertGreater(fit["slope_pct"], 100000.0, "Slope explodes to >100,000%")

    # =========================================================================
    # Category 3: Scale Extremes (Micro 0.0001 m^2 to Giant 10km x 10km)
    # =========================================================================
    def test_cat3_micro_polygon_least_squares(self):
        """Micro-polygon 0.0001 m^2 (1cm x 1cm) least-squares fitting."""
        pts = [
            (300000.0, 2700000.0, 50.0),
            (300000.01, 2700000.0, 50.0002),
            (300000.01, 2700000.01, 50.0005),
            (300000.0, 2700000.01, 50.0003),
        ]
        fit = solve_least_squares_plane(pts)
        self.assertFalse(math.isnan(fit["a"]))
        self.assertFalse(math.isnan(fit["b"]))
        self.assertFalse(math.isnan(fit["c"]))

    def test_cat3_micro_polygon_end_to_end(self):
        """Micro-polygon 0.0001 m^2 in calculate_cut_fill_volume (verifies no crash and safe formatting)."""
        vol = self.survey.calculate_cut_fill_volume({
            "scan_id": "quchi_20261005_merged",
            "base_mode": "best_fit_plane",
            "polygon": [
                [304950.0, 2757080.0],
                [304950.01, 2757080.0],
                [304950.01, 2757080.01],
                [304950.0, 2757080.01],
            ],
        })
        self.assertEqual(vol["status"], "ok")
        # Formatted to 2 decimal places per survey standard (0.0001 rounds to 0.00 m^2)
        self.assertEqual(vol["planar_area_m2"], 0.0)
        self.assertIn("best_fit_plane", vol)
        bfp = vol["best_fit_plane"]
        self.assertFalse(math.isnan(bfp["slope_pct"]))
        self.assertFalse(math.isnan(bfp["azimuth_deg"]))
        self.assertEqual(vol["cut_volume_bcm"], 0.0)
        self.assertEqual(vol["fill_volume_bcm"], 0.0)

    def test_cat3_giant_polygon_10km_x_10km(self):
        """Giant polygon 10km x 10km (100,000,000 m^2)."""
        pts = [
            (300000.0, 2700000.0, 50.0),
            (310000.0, 2700000.0, 250.0),
            (310000.0, 2710000.0, 450.0),
            (300000.0, 2710000.0, 250.0),
        ]
        fit = solve_least_squares_plane(pts)
        self.assertFalse(math.isnan(fit["a"]))
        self.assertFalse(math.isnan(fit["b"]))
        self.assertFalse(math.isnan(fit["det"]))
        self.assertAlmostEqual(fit["a"], 0.02, places=6)
        self.assertAlmostEqual(fit["b"], 0.02, places=6)
        expected_slope_pct = math.hypot(0.02, 0.02) * 100.0
        self.assertAlmostEqual(fit["slope_pct"], round(expected_slope_pct, 3), places=2)

    def test_cat3_giant_polygon_end_to_end(self):
        """Giant 10km x 10km polygon in calculate_cut_fill_volume (grid capped, terminates fast)."""
        import time
        t0 = time.time()
        vol = self.survey.calculate_cut_fill_volume({
            "scan_id": "quchi_20261005_merged",
            "base_mode": "best_fit_plane",
            "polygon": [
                [300000.0, 2750000.0],
                [310000.0, 2750000.0],
                [310000.0, 2760000.0],
                [300000.0, 2760000.0],
            ],
        })
        elapsed = time.time() - t0
        self.assertEqual(vol["status"], "ok")
        self.assertLess(elapsed, 2.0, "Giant polygon integration must finish in < 2 seconds")
        self.assertAlmostEqual(vol["planar_area_m2"], 100000000.0, delta=100.0)

    # =========================================================================
    # Category 4: Large Coordinate Offsets (Float64 Catastrophic Cancellation)
    # =========================================================================
    def test_cat4_large_coordinate_offsets_3M_27M(self):
        """Easting at 3,000,000 and Northing at 27,000,000. Check float64 cancellation."""
        e_base = 3000000.0
        n_base = 27000000.0
        a_true = 0.03
        b_true = 0.04
        h0_true = 120.0

        pts = []
        for de in [0.0, 25.0, 50.0, 75.0, 100.0]:
            for dn in [0.0, 25.0, 50.0, 75.0, 100.0]:
                e = e_base + de
                n = n_base + dn
                h = h0_true + a_true * de + b_true * dn
                pts.append((e, n, h))

        fit = solve_least_squares_plane(pts)

        self.assertAlmostEqual(fit["a"], a_true, places=10)
        self.assertAlmostEqual(fit["b"], b_true, places=10)
        self.assertAlmostEqual(fit["slope_pct"], 5.0, places=3)
        self.assertAlmostEqual(fit["slope_deg"], round(math.degrees(math.atan(0.05)), 2), places=2)

        for de in [10.0, 30.0, 70.0]:
            for dn in [15.0, 45.0, 85.0]:
                e_test = e_base + de
                n_test = n_base + dn
                h_exact = h0_true + a_true * de + b_true * dn

                z_centered = fit["a"] * (e_test - fit["e0"]) + fit["b"] * (n_test - fit["n0"]) + fit["c0"]
                self.assertAlmostEqual(z_centered, h_exact, places=8)

                z_uncentered = fit["a"] * e_test + fit["b"] * n_test + fit["c"]
                self.assertAlmostEqual(z_uncentered, h_exact, places=5)

    def test_cat4_extreme_offset_1e14(self):
        """Coordinate offset at 1e14 meters (astronomical scale stress test)."""
        e_base = 1e14
        n_base = 2e14
        pts = [
            (e_base, n_base, 10.0),
            (e_base + 10.0, n_base, 10.5),
            (e_base + 10.0, n_base + 10.0, 11.0),
            (e_base, n_base + 10.0, 10.5),
        ]
        fit = solve_least_squares_plane(pts)
        self.assertFalse(math.isnan(fit["a"]))
        self.assertFalse(math.isnan(fit["b"]))
        self.assertAlmostEqual(fit["a"], 0.05, places=4)
        self.assertAlmostEqual(fit["b"], 0.05, places=4)

    # =========================================================================
    # Category 5: Independent Trigonometric Oracles for Azimuth & Slope %
    # =========================================================================
    def test_cat5_trigonometric_oracle_360_degrees(self):
        """Verify azimuth and slope percentage against independent trigonometric oracle across all 360 degrees."""
        slope_pct_target = 7.5  # 7.5% grade
        slope_mag = slope_pct_target / 100.0

        for deg in range(0, 360):
            azimuth_rad = math.radians(deg)
            oracle_a = slope_mag * math.sin(azimuth_rad)
            oracle_b = slope_mag * math.cos(azimuth_rad)

            pts = []
            for de in [-20.0, 0.0, 20.0]:
                for dn in [-20.0, 0.0, 20.0]:
                    h = 100.0 + oracle_a * de + oracle_b * dn
                    pts.append((300000.0 + de, 2700000.0 + dn, h))

            fit = solve_least_squares_plane(pts)

            self.assertAlmostEqual(fit["a"], oracle_a, places=7)
            self.assertAlmostEqual(fit["b"], oracle_b, places=7)
            self.assertAlmostEqual(fit["slope_pct"], slope_pct_target, places=3)
            self.assertAlmostEqual(fit["azimuth_deg"] % 360.0, deg % 360.0, places=1)

    def test_cat5_cardinal_directions_oracle(self):
        """Test exact cardinal directions: North (0 deg), East (90 deg), South (180 deg), West (270 deg)."""
        cardinals = [
            ("North", 0.0, 0.0, 0.05),
            ("East", 90.0, 0.05, 0.0),
            ("South", 180.0, 0.0, -0.05),
            ("West", 270.0, -0.05, 0.0),
        ]
        for name, expected_az, a_val, b_val in cardinals:
            pts = [
                (300000.0, 2700000.0, 100.0),
                (300010.0, 2700000.0, 100.0 + 10.0 * a_val),
                (300010.0, 2700010.0, 100.0 + 10.0 * a_val + 10.0 * b_val),
                (300000.0, 2700010.0, 100.0 + 10.0 * b_val),
            ]
            fit = solve_least_squares_plane(pts)
            self.assertAlmostEqual(fit["a"], a_val, places=7, msg=f"Failed a on {name}")
            self.assertAlmostEqual(fit["b"], b_val, places=7, msg=f"Failed b on {name}")
            self.assertAlmostEqual(fit["azimuth_deg"], expected_az, places=1, msg=f"Failed azimuth on {name}")
            self.assertAlmostEqual(fit["slope_pct"], 5.0, places=3, msg=f"Failed slope on {name}")


if __name__ == "__main__":
    unittest.main()
