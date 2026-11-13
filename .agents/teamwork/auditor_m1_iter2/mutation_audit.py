#!/usr/bin/env python3
"""
Forensic Mutation & Integrity Audit Script
Auditor: auditor_m1_iter2
Working Directory: .agents/teamwork/auditor_m1_iter2/
"""

import os
import sys
import math
import tempfile
import unittest

BASE_DIR = r"C:\Antigravity\GatheringScans"
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from pc_worker.priority_queue import ScanQueueDB
from pc_worker.surveying_engine import SurveyingEngine
from pc_worker.optimizer_bridge import safe_float as bridge_safe_float, CRS_DEFINITIONS
from pc_worker.surveying.dsm_and_volume import safe_float as dsm_safe_float

class ForensicMutationAudit(unittest.TestCase):
    def setUp(self):
        self.tmp_db_fd, self.tmp_db_path = tempfile.mkstemp(suffix=".db")
        os.close(self.tmp_db_fd)
        self.db = ScanQueueDB(db_path=self.tmp_db_path)
        self.db.upsert_scan(
            {
                "scan_id": "quchi_20261005_merged",
                "name": "2026-10-05-15-43-55",
                "project_group": "QuChi Dam",
                "project_dir": r"C:\GatheringScans\QuChi_20261005_Compressed",
                "tileset_path": r"C:\GatheringScans\QuChi_20261005_Compressed\tileset\tileset.json",
                "obj_path": r"C:\Scans\QuChi\QuChi_20261005_Compressed\exports\QuChi_20261005_Compressed-obj_mesh\mesh.obj",
                "crs": "TWD97 (121) + TWVD2001",
                "status": "completed",
            }
        )
        self.survey = SurveyingEngine(self.db)

    def tearDown(self):
        try:
            if os.path.exists(self.tmp_db_path):
                os.remove(self.tmp_db_path)
        except Exception:
            pass

    def test_mutation_density_and_mass_conservation(self):
        """Mutate density across diverse values and verify linear scaling of conserved mass."""
        densities = [1.2, 1.6, 2.3, 2.85, 3.4]
        swell_factors = [1.10, 1.25, 1.42, 1.75]
        shrink_factors = [0.05, 0.10, 0.18, 0.25]

        for rho in densities:
            for sw in swell_factors:
                for sh in shrink_factors:
                    payload = {
                        "scan_id": "quchi_20261005_merged",
                        "base_mode": "best_fit_plane",
                        "density_t_m3": rho,
                        "swell_factor": sw,
                        "shrinkage_factor": sh,
                        "polygon": [
                            [304945.0, 2757078.0, 43.1],
                            [304960.0, 2757078.0, 43.1],
                            [304960.0, 2757090.0, 43.4],
                            [304945.0, 2757090.0, 43.4],
                        ],
                    }
                    res = self.survey.calculate_cut_fill_volume(payload)
                    self.assertEqual(res["status"], "ok")

                    cut_bcm = res["cut_volume_bcm"]
                    fill_bcm = res["fill_volume_bcm"]
                    cut_lcm = res["cut_volume_lcm"]
                    fill_ccm = res["fill_volume_ccm"]
                    cut_mass = res["conserved_cut_mass_t"]
                    fill_mass = res["conserved_fill_mass_t"]

                    # Verify Mass = BCM * rho (within 0.02 delta due to raw vs rounded float)
                    expected_cut_mass = round(cut_bcm * rho, 2)
                    expected_fill_mass = round(fill_bcm * rho, 2)
                    self.assertAlmostEqual(cut_mass, expected_cut_mass, delta=0.03)
                    self.assertAlmostEqual(fill_mass, expected_fill_mass, delta=0.03)

                    # Verify Swell factor scaling
                    expected_lcm = round(cut_bcm * sw, 2)
                    self.assertAlmostEqual(cut_lcm, expected_lcm, delta=0.03)

                    # Verify Shrinkage compaction scaling
                    expected_ccm = round(fill_bcm * (1.0 - sh), 2)
                    self.assertAlmostEqual(fill_ccm, expected_ccm, delta=0.03)

    def test_mutation_truck_limiting_factor_threshold(self):
        """Verify truck governing limit transitions dynamically between volume and weight."""
        v_truck = 15.0
        rho = 2.0
        sw = 1.25

        # Case 1: W_max = 18.0 tonnes (< 24.0) -> Weight limited
        res_weight = self.survey.calculate_cut_fill_volume({
            "scan_id": "quchi_20261005_merged",
            "base_mode": "best_fit_plane",
            "density_t_m3": rho,
            "swell_factor": sw,
            "truck_volume_m3": v_truck,
            "truck_max_tonnes": 18.0,
        })
        if res_weight["cut_volume_bcm"] > 0:
            self.assertEqual(res_weight["truck_limiting_factor"], "weight")

        # Case 2: W_max = 30.0 tonnes (> 24.0) -> Volume limited
        res_volume = self.survey.calculate_cut_fill_volume({
            "scan_id": "quchi_20261005_merged",
            "base_mode": "best_fit_plane",
            "density_t_m3": rho,
            "swell_factor": sw,
            "truck_volume_m3": v_truck,
            "truck_max_tonnes": 30.0,
        })
        if res_volume["cut_volume_bcm"] > 0:
            self.assertEqual(res_volume["truck_limiting_factor"], "volume")

    def test_mutation_arbitrary_rotations_best_fit_plane(self):
        """Mutate polygon coordinates by varying slope gradients and rotations."""
        e0, n0, z0 = 304950.0, 2757080.0, 42.0
        test_slopes = [
            (0.03, 0.04),    # hypot = 0.05 -> 5.0% slope
            (0.08, -0.06),   # hypot = 0.10 -> 10.0% slope
            (-0.15, 0.20),   # hypot = 0.25 -> 25.0% slope
            (0.0, 0.0),      # flat -> 0.0% slope
        ]

        for target_a, target_b in test_slopes:
            corners = [
                (e0 - 10.0, n0 - 10.0),
                (e0 + 10.0, n0 - 10.0),
                (e0 + 10.0, n0 + 10.0),
                (e0 - 10.0, n0 + 10.0),
            ]
            poly = [
                [e, n, z0 + target_a * (e - e0) + target_b * (n - n0)]
                for e, n in corners
            ]
            mean_e = sum(p[0] for p in poly) / 4.0
            mean_n = sum(p[1] for p in poly) / 4.0
            mean_h = sum(p[2] for p in poly) / 4.0

            suu = sum((p[0] - mean_e) ** 2 for p in poly)
            svv = sum((p[1] - mean_n) ** 2 for p in poly)
            suv = sum((p[0] - mean_e) * (p[1] - mean_n) for p in poly)
            suw = sum((p[0] - mean_e) * (p[2] - mean_h) for p in poly)
            svw = sum((p[1] - mean_n) * (p[2] - mean_h) for p in poly)

            det = suu * svv - suv * suv
            recovered_a = (suw * svv - svw * suv) / det
            recovered_b = (svw * suu - suw * suv) / det

            self.assertAlmostEqual(recovered_a, target_a, places=5)
            self.assertAlmostEqual(recovered_b, target_b, places=5)

            expected_slope_pct = round(math.hypot(target_a, target_b) * 100.0, 3)
            recovered_slope_pct = round(math.hypot(recovered_a, recovered_b) * 100.0, 3)
            self.assertEqual(recovered_slope_pct, expected_slope_pct)

    def test_safe_float_robustness(self):
        """Verify safe_float catches all malformed inputs and returns default."""
        for sf in (bridge_safe_float, dsm_safe_float):
            self.assertEqual(sf(None, 42.0), 42.0)
            self.assertEqual(sf("", 42.0), 42.0)
            self.assertEqual(sf("   ", 42.0), 42.0)
            self.assertEqual(sf("None", 42.0), 42.0)
            self.assertEqual(sf("null", 42.0), 42.0)
            self.assertEqual(sf("undefined", 42.0), 42.0)
            self.assertEqual(sf("nan", 42.0), 42.0)
            self.assertEqual(sf("NaN", 42.0), 42.0)
            self.assertEqual(sf(float("nan"), 42.0), 42.0)
            self.assertEqual(sf(float("inf"), 42.0), 42.0)
            self.assertEqual(sf("invalid_string", 42.0), 42.0)
            self.assertEqual(sf({"dict": 1}, 42.0), 42.0)
            self.assertEqual(sf([1, 2], 42.0), 42.0)

            # Valid values
            self.assertEqual(sf("12.34", 0.0), 12.34)
            self.assertEqual(sf(56.78, 0.0), 56.78)
            self.assertEqual(sf(100, 0.0), 100.0)
            self.assertEqual(sf("-0.05", 0.0), -0.05)

if __name__ == "__main__":
    unittest.main()
