"""
Empirical Mutation & Adversarial Fuzzing Audit for Milestone 1 Iteration 3 (Commit 8a029ff).
This test directly stresses mathematical parsing, bounds handling, and error contracts.
"""
import math
import os
import sys
import unittest
from typing import Any, List, Dict

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..")))
from pc_worker.surveying.dsm_and_volume import safe_float as safe_float_dsm
from pc_worker.optimizer_bridge import safe_float as safe_float_opt, _safe_parse_poly2d
from pc_worker.priority_queue import ScanQueueDB
from pc_worker.surveying_engine import SurveyingEngine
from pc_worker.optimizer_bridge import OptimizerBridge


class MutationAuditSuite(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = ScanQueueDB()
        cls.survey = SurveyingEngine(cls.db)
        cls.opt = OptimizerBridge(cls.db)
        # Ensure test scan exists
        cls.scan_id = "quchi_20261005_merged"
        cls.scan = cls.db.get_scan(cls.scan_id)
        if not cls.scan:
            cls.db.upsert_scan({
                "scan_id": cls.scan_id,
                "project_id": "test_project",
                "name": "Quchi Test Scan",
                "twd97_e": 304952.4,
                "twd97_n": 2757084.2,
                "twd97_h": 124.8,
                "status": "ready",
            })

    # ==========================================
    # 1. safe_float MUTATION TESTS
    # ==========================================
    def test_01_safe_float_mutation_and_edge_cases(self):
        """Stress safe_float with extreme, malformed, and non-numeric inputs."""
        for sf in (safe_float_dsm, safe_float_opt):
            # Normal conversions
            self.assertEqual(sf(0), 0.0)
            self.assertEqual(sf(123.456), 123.456)
            self.assertEqual(sf("-42.5"), -42.5)
            self.assertEqual(sf("  +999.123  \n"), 999.123)

            # Null / empty / whitespace
            self.assertIsNone(sf(None))
            self.assertIsNone(sf(""))
            self.assertIsNone(sf("    \t\r\n"))
            self.assertEqual(sf(None, 42.0), 42.0)
            self.assertEqual(sf("", 42.0), 42.0)
            self.assertEqual(sf("  ", 42.0), 42.0)

            # Non-numeric string tokens
            self.assertIsNone(sf("none"))
            self.assertIsNone(sf("NONE"))
            self.assertIsNone(sf("null"))
            self.assertIsNone(sf("undefined"))
            self.assertIsNone(sf("nan"))
            self.assertIsNone(sf("NaN"))
            self.assertIsNone(sf("invalid_number_token"))
            self.assertIsNone(sf("1,000.50"))
            self.assertIsNone(sf("0x10"))

            # Default value substitution on bad tokens
            self.assertEqual(sf("nan", -1.0), -1.0)
            self.assertEqual(sf("null", 0.0), 0.0)
            self.assertEqual(sf("undefined", 99.0), 99.0)

            # Infs and NaNs (finite check)
            self.assertIsNone(sf(float("inf")))
            self.assertIsNone(sf(float("-inf")))
            self.assertIsNone(sf(float("nan")))
            self.assertIsNone(sf("inf"))
            self.assertIsNone(sf("-Infinity"))
            self.assertEqual(sf(float("inf"), 10.0), 10.0)

            # Extreme finite values
            self.assertEqual(sf("1e-10"), 1e-10)
            self.assertEqual(sf("1e+20"), 1e+20)

            # Compound objects (should not crash)
            self.assertIsNone(sf([]))
            self.assertIsNone(sf({}))
            self.assertIsNone(sf(object()))

    # ==========================================
    # 2. _safe_parse_poly2d MUTATION TESTS
    # ==========================================
    def test_02_safe_parse_poly2d_mutations(self):
        """Stress _safe_parse_poly2d with mixed valid/invalid vertices and varying formats."""
        # Non-iterable or too few items
        self.assertIsNone(_safe_parse_poly2d(None))
        self.assertIsNone(_safe_parse_poly2d(123))
        self.assertIsNone(_safe_parse_poly2d([]))
        self.assertIsNone(_safe_parse_poly2d([[0, 0], [1, 1]]))

        # Valid list of lists
        raw_valid = [[10.0, 20.0], [30.0, 40.0], [50.0, 60.0]]
        parsed = _safe_parse_poly2d(raw_valid)
        self.assertIsNotNone(parsed)
        self.assertEqual(len(parsed), 3)
        self.assertEqual(parsed[0], [10.0, 20.0])

        # Mixed valid and garbage
        raw_mixed = [
            [10.0, 20.0],
            "invalid",
            None,
            [],
            [1],  # length < 2
            {"x": "bad", "y": 10},
            {"x": "15.5", "y": "25.5"},  # valid dict
            {"e": 35.0, "n": 45.0},      # valid dict with e/n
            [50.0, 60.0],
            {"x": None, "y": None},
        ]
        parsed_mixed = _safe_parse_poly2d(raw_mixed)
        self.assertIsNotNone(parsed_mixed)
        self.assertEqual(len(parsed_mixed), 4)
        self.assertEqual(parsed_mixed[0], [10.0, 20.0])
        self.assertEqual(parsed_mixed[1], [15.5, 25.5])
        self.assertEqual(parsed_mixed[2], [35.0, 45.0])
        self.assertEqual(parsed_mixed[3], [50.0, 60.0])

        # Filtered down to < 3 vertices
        raw_insufficient = [
            [10.0, 20.0],
            "bad",
            {"x": 15.0, "y": 25.0},
            None,
        ]
        self.assertIsNone(_safe_parse_poly2d(raw_insufficient))

    # ==========================================
    # 3. /api/survey/volume MUTATION TESTS
    # ==========================================
    def test_03_calculate_cut_fill_volume_mutations(self):
        """Mutate polygon coordinates in volume calculation and verify mathematical outputs."""
        # 3.1 Insufficient vertices (fewer than 3 valid points)
        res_2pts = self.survey.calculate_cut_fill_volume({
            "scan_id": self.scan_id,
            "polygon": [{"x": 10.0, "z": 20.0}, {"x": 30.0, "z": 40.0}]
        })
        self.assertEqual(res_2pts["status"], "error")
        self.assertIn("at least 3 valid coordinate points", res_2pts["error"])
        self.assertEqual(res_2pts["valid_points_count"], 2)

        # 3.2 Corrupted vertices mixed with 4 valid vertices forming a 10m x 10m square
        res_mixed_sq = self.survey.calculate_cut_fill_volume({
            "scan_id": self.scan_id,
            "polygon": [
                {"x": -5.0, "z": -5.0},
                {"x": "corrupted", "z": "bad"},
                {"x": 5.0, "z": -5.0},
                None,
                {"x": 5.0, "z": 5.0},
                [],
                {"x": -5.0, "z": 5.0},
            ]
        })
        self.assertEqual(res_mixed_sq["status"], "ok")
        # 10m x 10m = 100 m²
        self.assertAlmostEqual(res_mixed_sq["planar_area_m2"], 100.0, delta=1.0)
        self.assertIn("cut_volume_m3", res_mixed_sq)
        self.assertIn("fill_volume_m3", res_mixed_sq)
        self.assertIn("cut_volume_bcm", res_mixed_sq)
        self.assertIn("fill_volume_bcm", res_mixed_sq)
        self.assertIn("cut_volume_lcm", res_mixed_sq)
        self.assertIn("fill_volume_ccm", res_mixed_sq)
        self.assertIn("conserved_cut_mass_t", res_mixed_sq)
        self.assertIn("conserved_fill_mass_t", res_mixed_sq)
        self.assertIn("truck_loads_cut", res_mixed_sq)

    # ==========================================
    # 4. /api/survey/gcp-qa MUTATION TESTS
    # ==========================================
    def test_04_gcp_accuracy_qa_mutations(self):
        """Mutate GCP QA inputs: test mathematical residual formulas and corrupt token resilience."""
        pts = [
            # Corrupted entries that must be cleanly skipped
            {"name": "CP_JUNK1", "e": "", "n": "2757080.0", "h_gcp": "125.0"},
            {"name": "CP_JUNK2", "e": "none", "n": "null", "h_gcp": ""},
            {"name": "CP_JUNK3", "e": "bad", "n": "bad"},
            # Valid GCP points with known coordinates
            {"name": "CP01", "e": 304940.0, "n": 2757070.0, "h_gcp": 120.0, "h_scan": "120.05"},
            {"name": "CP02", "e": 304960.0, "n": 2757090.0, "h_gcp": 122.0, "h_scan": 121.92},
            {"name": "CP03", "e": "304955.0", "n": "2757085.0", "h_gcp": "121.5", "h_scan": "121.58"},
        ]
        res = self.survey.compute_gcp_accuracy_qa({
            "scan_id": self.scan_id,
            "points": pts,
        })
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["point_count"], 3)
        self.assertEqual([p["name"] for p in res["points"]], ["CP01", "CP02", "CP03"])

        # Check mathematical residuals for CP01:
        # h_gcp = 120.0, h_scan = 120.05 -> dz = 120.05 - 120.0 = +0.05
        cp1 = res["points"][0]
        self.assertAlmostEqual(cp1["dz_m"], 0.05, places=2)
        # Check CP02: h_gcp = 122.0, h_scan = 121.92 -> dz = 121.92 - 122.0 = -0.08
        cp2 = res["points"][1]
        self.assertAlmostEqual(cp2["dz_m"], -0.08, places=2)
        # Check CP03: h_gcp = 121.5, h_scan = 121.58 -> dz = 121.58 - 121.5 = +0.08
        cp3 = res["points"][2]
        self.assertAlmostEqual(cp3["dz_m"], 0.08, places=2)

        # RMSE calculations:
        # dz values: [0.05, -0.08, 0.08]
        # mean_sq = (0.0025 + 0.0064 + 0.0064) / 3 = 0.0153 / 3 = 0.0051
        # rmse_z_m = sqrt(0.0051) ~= 0.0714
        expected_rmse_z = math.sqrt((0.05**2 + (-0.08)**2 + 0.08**2) / 3.0)
        self.assertAlmostEqual(res["rmse_z_m"], expected_rmse_z, places=2)

    # ==========================================
    # 5. /api/survey/contours MUTATION TESTS
    # ==========================================
    def test_05_generate_elevation_contours_mutations(self):
        """Mutate contour intervals with unusual values, verify clamping and safe fallback."""
        cases = [
            # (minor_input, major_input, expected_min_minor, expected_min_major)
            ("", "", 0.1, 0.5),
            ("-10.0", "-50.0", 0.1, 0.5),
            ("0.0", "0.0", 0.1, 0.5),
            ("0.25", "1.0", 0.25, 1.0),
            ("1.0", "0.5", 1.0, 1.0),  # major < minor clamped to minor
            ("invalid", "invalid", 0.1, 0.5),
        ]
        for m_in, maj_in, exp_minor, exp_major in cases:
            res = self.survey.generate_elevation_contours({
                "scan_id": self.scan_id,
                "minor_interval_m": m_in,
                "major_interval_m": maj_in,
            })
            self.assertEqual(res["status"], "ok")
            self.assertGreaterEqual(res["minor_interval_m"], exp_minor)
            self.assertGreaterEqual(res["major_interval_m"], exp_major)
            self.assertGreaterEqual(res["major_interval_m"], res["minor_interval_m"])

    # ==========================================
    # 6. /api/survey/profile MUTATION TESTS
    # ==========================================
    def test_06_cross_section_profile_mutations(self):
        """Mutate profile endpoints with incomplete dictionaries and tuples."""
        # Partially empty start and end points
        res = self.survey.compute_cross_section_profile({
            "scan_id": self.scan_id,
            "start_point": {"x": "", "z": "bad"},
            "end_point": ["  ", None],
        })
        self.assertEqual(res["status"], "ok")
        self.assertIn("samples", res)
        self.assertIn("start_twd97", res)
        self.assertIn("end_twd97", res)
        self.assertIn("total_length_m", res)

    # ==========================================
    # 7. /api/survey/inspect-photos MUTATION TESTS
    # ==========================================
    def test_07_inspect_photos_mutations(self):
        """Mutate click coordinates and query radius."""
        res = self.survey.inspect_rtk_camera_photos({
            "scan_id": self.scan_id,
            "x": "  -10.5  ",
            "y": "bad",
            "z": "15.2",
            "max_radius_m": "0",  # 0 falls back to 45.0
            "limit": "-5",         # clamped to min 1
        })
        self.assertEqual(res["status"], "ok")
        self.assertIn("photos", res)

    # ==========================================
    # 8. OPTIMIZER BRIDGE MUTATION TESTS
    # ==========================================
    def test_08_optimizer_crop_and_generate_mutations(self):
        """Mutate optimizer crop, merge, and generation actions with adversarial inputs."""
        # 8.1 run_generate_scan_action: Empty strings & invalid tokens in crop_keep
        with self.assertRaises(ValueError) as cm:
            self.opt.run_generate_scan_action({
                "scan_id": self.scan_id,
                "crop_keep": {
                    "min_elev": "bad_elevation",
                    "max_elev": "   ",
                    "native_polygons": [
                        [{"x": "corrupted", "y": "bad"}, ["invalid"]],
                    ]
                }
            })
        self.assertIn("Please stage at least one adjustment", str(cm.exception))

        # 8.2 run_crop_action: Malformed polygon vertices and elevation
        with self.assertRaises(ValueError) as cm:
            self.opt.run_crop_action({
                "scan_id": self.scan_id,
                "min_elev": "nan",
                "max_elev": "undefined",
                "polygon": [{"x": "", "y": "   "}, ["bad", "coords"]],
            })
        self.assertIn("requires either frustum_strokes or a polygon with at least 3 vertices", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
