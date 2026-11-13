#!/usr/bin/env python3
"""
Adversarial Numerical Invariance & Stability Stress Test Harness
Agent: challenger_m2_1 (M2 Numerical Invariance & Stability Challenger)
Milestone: Milestone 2 (Control Alignment & 3D GCP Calibration)

Empirical Challenge Objectives:
1. Exact Pythagorean Invariants Verification:
   - Point-level: abs(d3D**2 - (d2D**2 + dH**2)), abs(d3D**2 - (dE**2 + dN**2 + dH**2))
   - Network RMSE: abs(rmse_3d**2 - (rmse_2d**2 + rmse_h**2)), abs(rmse_3d**2 - (rmse_e**2 + rmse_n**2 + rmse_h**2))
   - 10,000+ randomized synthetic coordinate configurations across centimeter, meter, kilometer, and mountainous terrain.
2. TBM Bias Elimination Theorem:
   - Calibrated mean error reduction under network mean TBM calibration.
   - Relationship between Calibrated RMSE_H and Sample StDev (div N-1) vs. Population StDev (div N).
   - 1,000+ synthetic biased networks.
3. Hostile Singularity & Stress Inputs:
   - N = 0 points (point_count=0, zero RMSEs, no ZeroDivisionError).
   - N = 1 point (std_dh_m=0.0000 without ZeroDivisionError).
   - Collinear control points across multiple angles (0 to 315 deg).
   - Hostile string inputs ("NaN", "inf", "-inf", "null", "undefined", garbage, empty).
   - Negative and extreme coordinates (> 1e7).
"""

import sys
import os
import math
import random
import unittest
import tempfile
from typing import Dict, Any, List, Tuple

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from pc_worker.priority_queue import ScanQueueDB
from pc_worker.surveying_engine import SurveyingEngine


class TestM2NumericalStressHarness(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        cls.tmp_db.close()
        cls.db = ScanQueueDB(cls.tmp_db.name)
        cls.scan_id = "test_numerical_stress_scan"
        cls.db.upsert_scan({
            "scan_id": cls.scan_id,
            "name": "M2 Numerical Stress Scan",
            "twd97_e": 304950.0,
            "twd97_n": 2757080.0,
            "twd97_h": 125.0,
            "status": "completed",
        })
        cls.survey = SurveyingEngine(cls.db)

    @classmethod
    def tearDownClass(cls):
        try:
            os.remove(cls.tmp_db.name)
        except OSError:
            pass

    # =========================================================================
    # 1. Exact Pythagorean Invariants Verification
    # =========================================================================
    def test_01_exact_pythagorean_invariants_10000_trials(self):
        """
        Stress-test exact Pythagorean invariants across 10,000+ randomized configurations.
        Evaluates:
        (A) API outputs with 4-decimal quantization bounds.
        (B) Unrounded analytical float64 relative and absolute machine precision.
        """
        random.seed(42)
        total_trials = 10000
        
        # Track errors in API outputs
        max_pt_api_diff_2d_dh = 0.0
        max_pt_api_diff_de_dn_dh = 0.0
        max_rmse_api_diff_2d_h = 0.0
        max_rmse_api_diff_e_n_h = 0.0
        
        # Track errors in unrounded math
        max_pt_unrounded_rel_diff = 0.0
        max_rmse_unrounded_rel_diff = 0.0
        max_pt_unrounded_abs_diff = 0.0
        max_rmse_unrounded_abs_diff = 0.0

        batch_size = 10
        num_batches = total_trials // batch_size

        for b in range(num_batches):
            pts = []
            pts_unrounded = []
            scale_choice = random.choice([0.05, 0.50, 5.0, 50.0, 500.0])
            for i in range(batch_size):
                e0 = 300000.0 + random.uniform(-10000.0, 10000.0)
                n0 = 2750000.0 + random.uniform(-10000.0, 10000.0)
                h0 = 100.0 + random.uniform(-50.0, 1000.0)

                de = random.uniform(-1.0, 1.0) * scale_choice
                dn = random.uniform(-1.0, 1.0) * scale_choice
                dh = random.uniform(-1.0, 1.0) * scale_choice

                pts.append({
                    "name": f"P-{b*batch_size+i}",
                    "e": e0,
                    "n": n0,
                    "h": h0,
                    "mesh_e": e0 + de,
                    "mesh_n": n0 + dn,
                    "mesh_h": h0 + dh,
                })
                pts_unrounded.append((de, dn, dh))

            res = self.survey.compute_gcp_accuracy_qa({
                "scan_id": self.scan_id,
                "points": pts,
            })
            self.assertEqual(res["status"], "ok")
            self.assertEqual(res["point_count"], batch_size)

            # Check point-level API residuals
            for p in res["gcp_residuals"]:
                d3d_sq = p["d3d"] ** 2
                sum_2d_dh_sq = p["d2d"] ** 2 + p["dh"] ** 2
                sum_xyz_sq = p["de"] ** 2 + p["dn"] ** 2 + p["dh"] ** 2

                diff_2d_dh = abs(d3d_sq - sum_2d_dh_sq)
                diff_xyz = abs(d3d_sq - sum_xyz_sq)

                if diff_2d_dh > max_pt_api_diff_2d_dh:
                    max_pt_api_diff_2d_dh = diff_2d_dh
                if diff_xyz > max_pt_api_diff_de_dn_dh:
                    max_pt_api_diff_de_dn_dh = diff_xyz

            # Check network-level API RMSE
            rmse_3d_sq = res["rmse_3d"] ** 2
            rmse_sum_2d_h_sq = res["rmse_2d"] ** 2 + res["rmse_h"] ** 2
            rmse_sum_e_n_h_sq = res["rmse_e"] ** 2 + res["rmse_n"] ** 2 + res["rmse_h"] ** 2

            diff_rmse_2d_h = abs(rmse_3d_sq - rmse_sum_2d_h_sq)
            diff_rmse_e_n_h = abs(rmse_3d_sq - rmse_sum_e_n_h_sq)

            if diff_rmse_2d_h > max_rmse_api_diff_2d_h:
                max_rmse_api_diff_2d_h = diff_rmse_2d_h
            if diff_rmse_e_n_h > max_rmse_api_diff_e_n_h:
                max_rmse_api_diff_e_n_h = diff_rmse_e_n_h

            # Unrounded analytical reference comparison
            for de, dn, dh in pts_unrounded:
                d2d_u = math.hypot(de, dn)
                d3d_u = math.hypot(d2d_u, dh)
                sq_sum = de**2 + dn**2 + dh**2
                diff_u = abs(d3d_u**2 - sq_sum)
                rel_diff_u = diff_u / max(1e-12, sq_sum)
                if diff_u > max_pt_unrounded_abs_diff:
                    max_pt_unrounded_abs_diff = diff_u
                if rel_diff_u > max_pt_unrounded_rel_diff:
                    max_pt_unrounded_rel_diff = rel_diff_u

            rmse_e_u = math.sqrt(sum(x[0]**2 for x in pts_unrounded) / batch_size)
            rmse_n_u = math.sqrt(sum(x[1]**2 for x in pts_unrounded) / batch_size)
            rmse_h_u = math.sqrt(sum(x[2]**2 for x in pts_unrounded) / batch_size)
            rmse_2d_u = math.hypot(rmse_e_u, rmse_n_u)
            rmse_3d_u = math.hypot(rmse_2d_u, rmse_h_u)
            sq_rmse_sum = rmse_e_u**2 + rmse_n_u**2 + rmse_h_u**2
            diff_rmse_u = abs(rmse_3d_u**2 - sq_rmse_sum)
            rel_diff_rmse_u = diff_rmse_u / max(1e-12, sq_rmse_sum)
            if diff_rmse_u > max_rmse_unrounded_abs_diff:
                max_rmse_unrounded_abs_diff = diff_rmse_u
            if rel_diff_rmse_u > max_rmse_unrounded_rel_diff:
                max_rmse_unrounded_rel_diff = rel_diff_rmse_u

        print(f"\n[Pythagorean Invariant 10,000 Trials Report]")
        print(f"API Point Max Error |d3d^2 - (d2d^2 + dh^2)|: {max_pt_api_diff_2d_dh:.8e}")
        print(f"API Point Max Error |d3d^2 - (de^2 + dn^2 + dh^2)|: {max_pt_api_diff_de_dn_dh:.8e}")
        print(f"API RMSE Max Error |rmse_3d^2 - (rmse_2d^2 + rmse_h^2)|: {max_rmse_api_diff_2d_h:.8e}")
        print(f"API RMSE Max Error |rmse_3d^2 - (rmse_e^2 + rmse_n^2 + rmse_h^2)|: {max_rmse_api_diff_e_n_h:.8e}")
        print(f"Unrounded Float64 Point Max Abs Error: {max_pt_unrounded_abs_diff:.8e}")
        print(f"Unrounded Float64 Point Max Rel Error: {max_pt_unrounded_rel_diff:.8e}")
        print(f"Unrounded Float64 RMSE Max Abs Error: {max_rmse_unrounded_abs_diff:.8e}")
        print(f"Unrounded Float64 RMSE Max Rel Error: {max_rmse_unrounded_rel_diff:.8e}")

        # In unrounded float64, relative error is strictly within machine epsilon (< 1e-14)
        self.assertLess(max_pt_unrounded_rel_diff, 1e-14, "Unrounded float64 point relative precision failed!")
        self.assertLess(max_rmse_unrounded_rel_diff, 1e-14, "Unrounded float64 RMSE relative precision failed!")

        # For API outputs, intermediate 4-decimal rounding (round(..., 4)) truncates at 0.1mm.
        # This mathematically proves that abs(d3D^2 - (d2D^2 + dH^2)) CANNOT be < 1e-10 when d >= 1m.
        # Under 4-decimal rounding, error is strictly bounded by 2 * max_D * 5e-5:
        self.assertLess(max_pt_api_diff_2d_dh, 0.15, "API point error breached analytical quantization ceiling!")
        self.assertLess(max_rmse_api_diff_2d_h, 0.15, "API RMSE error breached analytical quantization ceiling!")

    # =========================================================================
    # 2. TBM Bias Elimination Theorem
    # =========================================================================
    def test_02_tbm_bias_elimination_1000_networks(self):
        """
        Stress-test TBM Bias Elimination Theorem across 1,000+ synthetic biased networks:
        1. Inject systematic vertical bias (e.g. +0.50m) plus random Gaussian noise.
        2. Verify proposed shift equals -mean_dh.
        3. Evaluate residual mean error after calibration.
        4. Empirically verify the relationship between Calibrated RMSE_H and Sample StDev (div N-1)
           vs. Population StDev (div N).
        """
        random.seed(101)
        total_networks = 1000
        
        max_calibrated_mean_error = 0.0
        max_diff_rmse_vs_pop_std = 0.0
        max_diff_rmse_vs_sample_std = 0.0

        for trial in range(total_networks):
            n_pts = random.randint(3, 25)
            true_bias = random.uniform(-5.0, 5.0)
            noise_sigma = random.uniform(0.005, 0.050)

            pts = []
            dh_raw_list = []
            for i in range(n_pts):
                noise = random.gauss(0.0, noise_sigma)
                dh = true_bias + noise
                dh_raw_list.append(dh)
                pts.append({
                    "name": f"GCP-{i+1}",
                    "e": 304950.0 + i * 20.0,
                    "n": 2757080.0 + i * 20.0,
                    "h": 100.0,
                    "mesh_h": 100.0 + dh,
                })

            res = self.survey.compute_gcp_accuracy_qa({
                "scan_id": self.scan_id,
                "points": pts,
                "apply_tbm_calibration": True,
            })
            self.assertEqual(res["status"], "ok")
            self.assertTrue(res["tbm_applied"])

            cal_residuals = [p["dh"] for p in res["gcp_residuals"]]
            cal_mean_error = abs(sum(cal_residuals) / n_pts)
            if cal_mean_error > max_calibrated_mean_error:
                max_calibrated_mean_error = cal_mean_error

            cal_rmse_h = res["rmse_h"]
            pop_std = round(math.sqrt(sum((dh - res["mean_bias_h"])**2 for dh in dh_raw_list) / n_pts), 4)
            sample_std = res["std_dh_m"]

            diff_pop = abs(cal_rmse_h - pop_std)
            diff_sample = abs(cal_rmse_h - sample_std)

            if diff_pop > max_diff_rmse_vs_pop_std:
                max_diff_rmse_vs_pop_std = diff_pop
            if diff_sample > max_diff_rmse_vs_sample_std:
                max_diff_rmse_vs_sample_std = diff_sample

        print(f"\n[TBM Bias Elimination 1,000 Networks Report]")
        print(f"Max Calibrated Mean Error: {max_calibrated_mean_error:.8e} m")
        print(f"Max |Calibrated RMSE_H - Population StDev (div N)|: {max_diff_rmse_vs_pop_std:.8e} m")
        print(f"Max |Calibrated RMSE_H - Sample StDev (div N-1)|: {max_diff_rmse_vs_sample_std:.8e} m")

        # Mean residual after calibration is bounded by 4-decimal quantization: <= 0.0001m (0.1mm)
        self.assertLess(max_calibrated_mean_error, 0.0001, "Calibrated mean error exceeded quantization bound!")
        # Calibrated RMSE_H mathematically matches Population StDev (divisor N), NOT Sample StDev (divisor N-1)
        self.assertLess(max_diff_rmse_vs_pop_std, 0.0002, "Calibrated RMSE_H does not match Population StDev!")

    # =========================================================================
    # 3. Hostile Singularity & Stress Inputs
    # =========================================================================
    def test_03_singularity_n_zero(self):
        """Verify N = 0 points returns status 'ok', point_count = 0, zero RMSEs without ZeroDivisionError."""
        res = self.survey.compute_gcp_accuracy_qa({
            "scan_id": self.scan_id,
            "points": [],
        })
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["point_count"], 0)
        self.assertEqual(res["rmse_e"], 0.0)
        self.assertEqual(res["rmse_n"], 0.0)
        self.assertEqual(res["rmse_h"], 0.0)
        self.assertEqual(res["rmse_2d"], 0.0)
        self.assertEqual(res["rmse_3d"], 0.0)
        self.assertEqual(res["std_dh_m"], 0.0)
        self.assertFalse(res["tbm_applied"])

    def test_04_singularity_n_one(self):
        """Verify N = 1 point evaluates sample standard deviation as 0.0000 without ZeroDivisionError (N-1=0)."""
        res = self.survey.compute_gcp_accuracy_qa({
            "scan_id": self.scan_id,
            "points": [
                {"name": "SINGLE-CP", "e": 304950.0, "n": 2757080.0, "h": 125.0, "mesh_h": 125.035},
            ],
        })
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["point_count"], 1)
        self.assertEqual(res["std_de_m"], 0.0)
        self.assertEqual(res["std_dn_m"], 0.0)
        self.assertEqual(res["std_dh_m"], 0.0)
        self.assertAlmostEqual(res["rmse_h"], 0.035, places=3)
        self.assertAlmostEqual(res["rmse_3d"], 0.035, places=3)

    def test_05_collinear_control_points(self):
        """Verify collinear control points along horizontal, vertical, and arbitrary diagonal lines compute cleanly."""
        angles = [0.0, 30.0, 45.0, 60.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0]
        for ang in angles:
            rad = math.radians(ang)
            pts = []
            for k in range(5):
                dist = k * 25.0
                e = 304950.0 + dist * math.cos(rad)
                n = 2757080.0 + dist * math.sin(rad)
                pts.append({
                    "name": f"COL-{ang}-{k}",
                    "e": e,
                    "n": n,
                    "h": 100.0 + k * 1.5,
                    "mesh_e": e + 0.015,
                    "mesh_n": n - 0.020,
                    "mesh_h": 100.0 + k * 1.5 + 0.010,
                })
            res = self.survey.compute_gcp_accuracy_qa({
                "scan_id": self.scan_id,
                "points": pts,
            })
            self.assertEqual(res["status"], "ok")
            self.assertEqual(res["point_count"], 5)
            self.assertAlmostEqual(res["rmse_e"], 0.015, places=3)
            self.assertAlmostEqual(res["rmse_n"], 0.020, places=3)
            self.assertAlmostEqual(res["rmse_2d"], 0.025, places=3)
            self.assertAlmostEqual(res["rmse_h"], 0.010, places=3)
            self.assertAlmostEqual(res["rmse_3d"], math.hypot(0.025, 0.010), places=3)

    def test_06_hostile_string_inputs_filtering(self):
        """Verify hostile string tokens ('NaN', 'inf', '-inf', 'null', 'undefined', garbage, empty) are safely handled."""
        hostile_points = [
            {"name": "H-EMPTY", "e": "", "n": "  ", "h": ""},
            {"name": "H-NAN", "e": "NaN", "n": "nan", "h": "NAN"},
            {"name": "H-INF", "e": "inf", "n": "-inf", "h": "Infinity"},
            {"name": "H-NULL", "e": "null", "n": "undefined", "h": "None"},
            {"name": "H-GARBAGE", "e": "foo123", "n": "!@#$", "h": "bad_float"},
            # Valid point that must be preserved
            {"name": "VALID-01", "e": 304950.0, "n": 2757080.0, "h": 125.0, "mesh_e": 304950.02, "mesh_n": 2757080.01, "mesh_h": 125.03},
        ]
        res = self.survey.compute_gcp_accuracy_qa({
            "scan_id": self.scan_id,
            "points": hostile_points,
        })
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["point_count"], 1)
        self.assertEqual(res["gcp_residuals"][0]["name"], "VALID-01")
        self.assertAlmostEqual(res["rmse_e"], 0.020, places=3)
        self.assertAlmostEqual(res["rmse_n"], 0.010, places=3)
        self.assertAlmostEqual(res["rmse_h"], 0.030, places=3)

    def test_07_negative_and_extreme_coordinates_conditioning(self):
        """Verify negative coordinates and extreme coordinates (> 1e7) maintain numerical precision without overflow."""
        pts = [
            # Negative coordinates
            {"name": "NEG-1", "e": -500000.0, "n": -2000000.0, "h": -250.0, "mesh_e": -500000.02, "mesh_n": -2000000.01, "mesh_h": -250.03},
            {"name": "NEG-2", "e": -500100.0, "n": -2000100.0, "h": -240.0, "mesh_e": -500100.01, "mesh_n": -2000100.02, "mesh_h": -240.02},
            # Extreme coordinates
            {"name": "EXT-1", "e": 50000000.0, "n": 80000000.0, "h": 5000.0, "mesh_e": 50000000.03, "mesh_n": 80000000.04, "mesh_h": 5000.01},
            {"name": "EXT-2", "e": 50000100.0, "n": 80000100.0, "h": 5010.0, "mesh_e": 50000100.02, "mesh_n": 80000100.03, "mesh_h": 5010.02},
        ]
        res = self.survey.compute_gcp_accuracy_qa({
            "scan_id": self.scan_id,
            "points": pts,
        })
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["point_count"], 4)
        self.assertFalse(math.isnan(res["rmse_3d"]))
        self.assertFalse(math.isinf(res["rmse_3d"]))
        self.assertGreater(res["rmse_3d"], 0.0)


if __name__ == "__main__":
    unittest.main()
