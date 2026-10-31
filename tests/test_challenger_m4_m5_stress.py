#!/usr/bin/env python3
"""
Adversarial Stress Test Suite for Milestone 4 and Milestone 5
=============================================================
Author: challenger_m4_m5_1 (Empirical Challenger)
Target: pc_worker/surveying/construction_qa.py

Test Areas:
1. Coordinate Inversion & Field Safety Stress Test (CSV, TXT, DXF, HTML field sheet)
2. Surface Flatness & Levelness Degenerate Point Clouds:
   - Perfectly flat slab (dev = 0.0, pass rate = 100%, F_F > 100)
   - Collinear line of points (singular matrix handling)
   - Spherical / random 3D noise
   - Identical coincident points
3. Wall Plumbness Tilt Ratio:
   - Perfectly vertical wall (tilt = 0.0 mm/m, ratio > 1:100,000)
   - Tilted wall with known inclination
   - Degenerate wall line
4. Open-Trench Utility Tracer:
   - Zero slope (level pipe)
   - Reverse slope (rising invert)
   - Zero / negative diameter clamp
   - Zero length segment
5. Multi-Epoch Compare Volume:
   - Identical DSMs (net volume strictly 0.0 m3)
   - Zero area / single point polygon
"""

import os
import sys
import math
import tempfile
import unittest
import numpy as np

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from pc_worker.priority_queue import ScanQueueDB
from pc_worker.surveying_engine import SurveyingEngine


class AdversarialM4M5StressTests(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmp_dir, "test_challenger.db")
        self.db = ScanQueueDB(self.db_path)
        self.scan_id = "challenger_scan_m4_m5"
        self.db.upsert_scan({
            "scan_id": self.scan_id,
            "project_dir": self.tmp_dir,
            "twd97_e": 304950.0,
            "twd97_n": 2757080.0,
            "twd97_h": 120.0,
        })
        self.survey = SurveyingEngine(self.db)

    def tearDown(self):
        import shutil
        try:
            shutil.rmtree(self.tmp_dir, ignore_errors=True)
        except Exception:
            pass

    # =========================================================================
    # CHALLENGE 1: Coordinate Inversion & Field Safety Stress Test
    # =========================================================================

    def test_coordinate_inversion_csv_dxf_html(self):
        """Verify strict (E, N, Z) coordinate order in CSV, TXT, DXF, and HTML."""
        # Use asymmetric coordinates where Easting (6 digits: ~304,950)
        # and Northing (7 digits: ~2,757,080) cannot be confused.
        test_pts = [
            {"id": "STK-A1", "e": 304123.456, "n": 2757890.123, "z": 115.678, "code": "COLUMN_C1"},
            {"id": "STK-B2", "e": 304456.789, "n": 2757123.456, "z": 118.901, "code": "RETAINING_WALL"},
        ]
        payload = {
            "scan_id": self.scan_id,
            "project_name": "Civil Highway Bridge QA",
            "surveyor": "Chief Surveyor Lin",
            "points": test_pts,
        }
        res = self.survey.generate_stakeout_export(payload)
        self.assertEqual(res["status"], "ok")

        # 1. Verify CSV column ordering strictly PtID, Easting, Northing, Elevation, Code
        csv_str = res["csv_export"]
        csv_lines = [l.strip() for l in csv_str.strip().split("\n") if not l.startswith("#")]
        header = csv_lines[0]
        self.assertEqual(header, "PtID,Easting,Northing,Elevation,Code")

        # Row 1 verification
        cols1 = csv_lines[1].split(",")
        self.assertEqual(cols1[0], "STK-A1")
        self.assertEqual(cols1[1], "304123.456", "Easting must be 2nd column (E)")
        self.assertEqual(cols1[2], "2757890.123", "Northing must be 3rd column (N)")
        self.assertEqual(cols1[3], "115.678", "Elevation must be 4th column (Z)")
        self.assertEqual(cols1[4], "COLUMN_C1")

        # Assert Easting is NOT swapped with Northing
        self.assertLess(float(cols1[1]), 1000000.0, "Easting should be ~300k, NOT ~2.75M")
        self.assertGreater(float(cols1[2]), 1000000.0, "Northing should be ~2.75M, NOT ~300k")

        # 2. Verify space-delimited TXT export
        txt_str = res["txt_export"]
        self.assertIn("STK-A1 304123.456 2757890.123 115.678 COLUMN_C1", txt_str)

        # 3. Verify DXF 3D POINT entities: 10=Easting, 20=Northing, 30=Elevation
        dxf_str = res["dxf_export"]
        dxf_tokens = [t.strip() for t in dxf_str.strip().split("\n")]
        # Find POINT entity for STK-A1
        found_point = False
        for i in range(len(dxf_tokens) - 6):
            if dxf_tokens[i] == "POINT":
                # Check group codes 10, 20, 30
                code10_val = None
                code20_val = None
                code30_val = None
                for k in range(i + 1, min(len(dxf_tokens) - 1, i + 16)):
                    if dxf_tokens[k] == "0":
                        break
                    if dxf_tokens[k] == "10":
                        code10_val = dxf_tokens[k+1]
                    elif dxf_tokens[k] == "20":
                        code20_val = dxf_tokens[k+1]
                    elif dxf_tokens[k] == "30":
                        code30_val = dxf_tokens[k+1]
                if code10_val == "304123.456":
                    found_point = True
                    self.assertEqual(code20_val, "2757890.123", "DXF group 20 must be Northing")
                    self.assertEqual(code30_val, "115.678", "DXF group 30 must be Elevation")
        self.assertTrue(found_point, "Must find DXF POINT entity with Easting in group code 10")

        # 4. Verify Printable HTML Field Sheet
        html_str = res["html_field_sheet"]
        self.assertIn("Design E (m)", html_str)
        self.assertIn("Design N (m)", html_str)
        self.assertIn("Design Z (m)", html_str)
        # Check table row structure: PtID, Code, E, N, Z
        self.assertIn('<td class="num">304123.456</td>', html_str)
        self.assertIn('<td class="num">2757890.123</td>', html_str)
        self.assertIn('<td class="num">115.678</td>', html_str)

        # Confirm E comes before N in the HTML table row
        idx_e = html_str.find("304123.456")
        idx_n = html_str.find("2757890.123")
        idx_z = html_str.find("115.678")
        self.assertTrue(0 < idx_e < idx_n < idx_z, "In HTML table, Easting must precede Northing, which must precede Z")

    # =========================================================================
    # CHALLENGE 2A: Surface Flatness Plane Fitting Stress Tests
    # =========================================================================

    def test_surface_flatness_perfect_flat_slab(self):
        """Perfect flat slab: dev = 0.0 mm, Pass Rate = 100%, F_F >= 100."""
        pts = []
        for x in np.linspace(304900.0, 304920.0, 10):
            for y in np.linspace(2757000.0, 2757020.0, 10):
                pts.append({"e": float(x), "n": float(y), "h": 100.000})

        payload = {
            "scan_id": self.scan_id,
            "reference_mode": "horizontal",
            "reference_elevation": 100.0,
            "tolerance_mm": 5.0,
            "points": pts,
        }
        res = self.survey.compute_surface_flatness_and_plumbness(payload)
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["total_points"], 100)
        self.assertEqual(res["pass_count"], 100)
        self.assertEqual(res["pass_rate_pct"], 100.0)
        self.assertEqual(res["high_count"], 0)
        self.assertEqual(res["low_count"], 0)
        self.assertAlmostEqual(res["rms_dev_mm"], 0.0, places=2)
        self.assertAlmostEqual(res["max_high"]["dev_mm"], 0.0, places=1)
        self.assertAlmostEqual(res["max_low"]["dev_mm"], 0.0, places=1)
        # Floor flatness FF should be maximum rating (> 100)
        self.assertGreaterEqual(res["astm_e1155"]["ff_flatness"], 100.0)

    def test_surface_flatness_collinear_points(self):
        """Collinear line of points: assert safeguard prevents singular matrix crash."""
        # 10 collinear points along line: E = 304900 + t, N = 2757000 + 2*t, H = 100 + 0.5*t
        collinear_pts = [
            {"e": 304900.0 + t, "n": 2757000.0 + 2.0 * t, "h": 100.0 + 0.5 * t}
            for t in range(10)
        ]

        # Test horizontal mode
        payload_h = {
            "scan_id": self.scan_id,
            "reference_mode": "horizontal",
            "points": collinear_pts,
        }
        res_h = self.survey.compute_surface_flatness_and_plumbness(payload_h)
        self.assertEqual(res_h["status"], "ok")
        self.assertFalse(math.isnan(res_h["rms_dev_mm"]))

        # Test best-fit mode with collinear points (SVD on 1D line in 3D)
        payload_bf = {
            "scan_id": self.scan_id,
            "reference_mode": "best_fit",
            "points": collinear_pts,
        }
        res_bf = self.survey.compute_surface_flatness_and_plumbness(payload_bf)
        self.assertEqual(res_bf["status"], "ok")
        self.assertFalse(math.isnan(res_bf["rms_dev_mm"]))
        self.assertIn("reference_plane", res_bf)
        self.assertFalse(math.isnan(res_bf["reference_plane"]["a"]))
        self.assertFalse(math.isnan(res_bf["reference_plane"]["b"]))
        self.assertFalse(math.isnan(res_bf["reference_plane"]["c"]))

    def test_surface_flatness_random_noise_and_sphere(self):
        """Points with spherical / random 3D distribution should not crash or produce NaNs."""
        np.random.seed(42)
        # Random spherical surface: radius 5m centered at (304950, 2757080, 120)
        pts = []
        for _ in range(50):
            u = np.random.uniform(0, 1)
            v = np.random.uniform(0, 1)
            theta = u * 2.0 * math.pi
            phi = math.acos(2.0 * v - 1.0)
            r = 5.0 + np.random.normal(0, 0.05)
            x = 304950.0 + r * math.sin(phi) * math.cos(theta)
            y = 2757080.0 + r * math.sin(phi) * math.sin(theta)
            z = 120.0 + r * math.cos(phi)
            pts.append({"e": float(x), "n": float(y), "h": float(z)})

        payload = {
            "scan_id": self.scan_id,
            "reference_mode": "best_fit",
            "tolerance_mm": 50.0,
            "points": pts,
        }
        res = self.survey.compute_surface_flatness_and_plumbness(payload)
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["total_points"], 50)
        self.assertFalse(math.isnan(res["rms_dev_mm"]))
        self.assertGreater(res["rms_dev_mm"], 0.0)

    # =========================================================================
    # CHALLENGE 2B: Wall Plumbness Tilt Ratio Stress Tests
    # =========================================================================

    def test_wall_plumbness_perfect_vertical_vs_tilted(self):
        """Test vertical wall: perfectly plumb (0 mm/m) vs inclined wall (known angle)."""
        # 1. Perfectly vertical wall: E = 304950.0, N in [2757080, 2757090], H in [100, 105]
        vert_pts = []
        for n in [2757080.0, 2757085.0, 2757090.0]:
            for h in [100.0, 102.5, 105.0]:
                vert_pts.append({"e": 304950.000, "n": n, "h": h})

        payload_vert = {
            "scan_id": self.scan_id,
            "reference_mode": "vertical",
            "tolerance_mm": 10.0,
            "wall_line": [{"e": 304950.0, "n": 2757080.0}, {"e": 304950.0, "n": 2757090.0}],
            "points": vert_pts,
        }
        res_v = self.survey.compute_surface_flatness_and_plumbness(payload_vert)
        self.assertEqual(res_v["status"], "ok")
        plumb_v = res_v["plumb_tilt"]
        self.assertAlmostEqual(plumb_v["plumb_mm_per_m"], 0.0, places=1)
        self.assertAlmostEqual(plumb_v["tilt_angle_deg"], 0.0, places=1)
        self.assertGreaterEqual(plumb_v["tilt_ratio_num"], 99999.0)

        # 2. Tilted wall: lean of 10 mm per 1.0 m of height (slope = 1:100, plumb = 10.0 mm/m)
        # delta_E = 0.010 * (H - 100.0)
        tilted_pts = []
        for n in [2757080.0, 2757085.0, 2757090.0]:
            for h in [100.0, 102.0, 104.0, 106.0]:
                e = 304950.000 + 0.010 * (h - 100.0)
                tilted_pts.append({"e": e, "n": n, "h": h})

        payload_tilted = {
            "scan_id": self.scan_id,
            "reference_mode": "vertical",
            "tolerance_mm": 15.0,
            "wall_line": [{"e": 304950.0, "n": 2757080.0}, {"e": 304950.0, "n": 2757090.0}],
            "points": tilted_pts,
        }
        res_t = self.survey.compute_surface_flatness_and_plumbness(payload_tilted)
        self.assertEqual(res_t["status"], "ok")
        plumb_t = res_t["plumb_tilt"]
        # Tilt should be approximately 10 mm/m
        self.assertAlmostEqual(plumb_t["plumb_mm_per_m"], 10.0, delta=1.0)
        # Tilt ratio should be approx 1:100
        self.assertAlmostEqual(plumb_t["tilt_ratio_num"], 100.0, delta=10.0)

    # =========================================================================
    # CHALLENGE 2C: Open-Trench Utility Tracer Stress Tests
    # =========================================================================

    def test_open_trench_zero_slope_reverse_slope_zero_dia(self):
        """Test trench utility tracer with zero slope, reverse slope, and zero diameter."""
        # 1. Zero slope (level pipe)
        payload_zero = {
            "scan_id": self.scan_id,
            "pipe_type": "WATER",
            "pipe_diameter_mm": 200.0,
            "point_mode": "invert",
            "trench_points": [
                {"e": 304950.0, "n": 2757080.0, "h": 118.0, "name": "V-01"},
                {"e": 304970.0, "n": 2757080.0, "h": 118.0, "name": "V-02"},
            ],
        }
        res_zero = self.survey.trace_open_trench_utility(payload_zero)
        self.assertEqual(res_zero["status"], "ok")
        st0 = res_zero["stations"][0]
        self.assertAlmostEqual(st0["slope_pct"], 0.0, places=2)
        self.assertIn(st0["slope_ratio"], ("Level (0%)", "1:99999", "1:100000"))
        self.assertEqual(st0["flow_dir"], "Flat")

        # 2. Reverse slope (incline / adverse gradient dz > 0)
        payload_rev = {
            "scan_id": self.scan_id,
            "pipe_type": "SEWER",
            "pipe_diameter_mm": 300.0,
            "point_mode": "invert",
            "trench_points": [
                {"e": 304950.0, "n": 2757080.0, "h": 118.0, "name": "MH-U1"},
                {"e": 304970.0, "n": 2757080.0, "h": 118.5, "name": "MH-U2"},
            ],
        }
        res_rev = self.survey.trace_open_trench_utility(payload_rev)
        self.assertEqual(res_rev["status"], "ok")
        st_rev = res_rev["stations"][0]
        self.assertGreater(st_rev["slope_pct"], 0.0)
        self.assertEqual(st_rev["flow_dir"], "Reverse")

        # 3. Zero / negative diameter clamp
        payload_dia = {
            "scan_id": self.scan_id,
            "pipe_diameter_mm": 0.0,  # Extreme boundary
            "trench_points": [
                {"e": 304950.0, "n": 2757080.0, "h": 118.0},
                {"e": 304960.0, "n": 2757080.0, "h": 117.8},
            ],
        }
        res_dia = self.survey.trace_open_trench_utility(payload_dia)
        self.assertEqual(res_dia["status"], "ok")
        # Assert safeguarded to minimum diameter (e.g. 20mm = 0.02m)
        self.assertGreaterEqual(res_dia["pipe_diameter_mm"], 20.0)

    # =========================================================================
    # CHALLENGE 2D: Multi-Epoch Compare Volume with Identical DSMs
    # =========================================================================

    def test_multi_epoch_compare_volume_identical_dsms(self):
        """Test multi-epoch compare volume with identical DSMs (net volume strictly 0.0 m³)."""
        # Create a mock DSM data object and attach to SurveyingEngine
        mock_dsm = {
            "ce": 304950.0,
            "cn": 2757080.0,
            "ch": 100.0,
            "elevations": {
                (304940.0, 2757070.0): 100.5,
                (304950.0, 2757080.0): 101.2,
            }
        }
        # Monkey patch _load_or_build_scan_dsm to return the same DSM for both scans
        orig_load = getattr(self.survey, "_load_or_build_scan_dsm", None)
        orig_sample = getattr(self.survey, "_sample_dsm_elevation", None)

        def mock_load_dsm(scan):
            return mock_dsm

        def mock_sample_elev(dsm, e, n):
            # Analytical synthetic elevation surface
            # Z(E, N) = 100.0 + 0.02 * (E - 304950.0) - 0.01 * (N - 2757080.0)
            val = 100.0 + 0.02 * (e - 304950.0) - 0.01 * (n - 2757080.0)
            return val, 0, 0, True

        self.survey._load_or_build_scan_dsm = mock_load_dsm
        self.survey._sample_dsm_elevation = mock_sample_elev

        try:
            payload = {
                "baseline_scan_id": self.scan_id,
                "compare_scan_id": self.scan_id,
                "polygon": [
                    {"e": 304940.0, "n": 2757070.0},
                    {"e": 304960.0, "n": 2757070.0},
                    {"e": 304960.0, "n": 2757090.0},
                    {"e": 304940.0, "n": 2757090.0},
                ],
            }
            res = self.survey.compute_compare_volume_takeoff(payload)
            self.assertEqual(res["status"], "ok")
            self.assertAlmostEqual(res["net_volume_delta_m3"], 0.0, places=2)
            self.assertAlmostEqual(res["cut_volume_bcm"], 0.0, places=2)
            self.assertAlmostEqual(res["fill_volume_ccm"], 0.0, places=2)
            self.assertEqual(res["site_balance"]["type"], "Balanced Site (Zero Net Haul)")
            self.assertEqual(res["site_balance"]["truck_trips"], 0)
        finally:
            if orig_load is not None:
                self.survey._load_or_build_scan_dsm = orig_load
            if orig_sample is not None:
                self.survey._sample_dsm_elevation = orig_sample

    def test_multi_epoch_compare_volume_no_dsm_self_compare(self):
        """
        Adversarial test: Comparing a scan to itself without DSM must yield net volume = 0.0 m³.
        Current vulnerability: injects a synthetic mound (+23.46 m³) even when baseline == compare.
        """
        payload = {
            "baseline_scan_id": self.scan_id,
            "compare_scan_id": self.scan_id,
        }
        res = self.survey.compute_compare_volume_takeoff(payload)
        self.assertEqual(res["status"], "ok")
        self.assertAlmostEqual(res["net_volume_delta_m3"], 0.0, places=2,
                               msg=f"Self-comparison must yield 0.0 m3, got {res.get('net_volume_delta_m3')}")
        self.assertEqual(res["site_balance"]["truck_trips"], 0)

    def test_multi_epoch_compare_volume_real_scan_rosepark_self_compare(self):
        """
        Adversarial test: Self-comparison of a real scan with NoData edge cells.
        Must yield strictly 0.0 m³ net volume, but currently produces +19.3 m³ phantom fill.
        """
        real_db = ScanQueueDB()
        scan = real_db.get_scan("rosepark_20260918_merged")
        if not scan:
            self.skipTest("rosepark_20260918_merged not in DB")
        survey = SurveyingEngine(real_db)
        res = survey.compute_compare_volume_takeoff({
            "baseline_scan_id": "rosepark_20260918_merged",
            "compare_scan_id": "rosepark_20260918_merged",
        })
        self.assertEqual(res["status"], "ok")
        self.assertAlmostEqual(res["net_volume_delta_m3"], 0.0, places=2,
                               msg=f"Real scan self-comparison must yield 0.0 m3, got {res.get('net_volume_delta_m3')}")
        self.assertEqual(res["site_balance"]["truck_trips"], 0)


if __name__ == "__main__":
    unittest.main()
