"""
Empirical Challenger Stress Harness for Milestone 2 GCP Accuracy QA & TBM Datum Bias.
Agent: challenger_m2_iter2
"""

import unittest
import urllib.request
import json
import sqlite3
import os


class TestGcpQaLiveApiEmpiricalStress(unittest.TestCase):
    BASE_URL = "http://127.0.0.1:8095"
    SCAN_ID = "quchi_20261005_merged"
    DB_PATH = "data/gathering_scans.db"

    @classmethod
    def setUpClass(cls):
        # Verify server is live
        req = urllib.request.Request(f"{cls.BASE_URL}/api/status")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("status") != "online":
                raise RuntimeError(f"Server is not online: {data}")

    def post_json(self, path, payload):
        req = urllib.request.Request(
            f"{self.BASE_URL}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))

    def tearDown(self):
        # Always reset calibration after each test so scan data remains clean
        try:
            self.post_json(
                "/api/survey/gcp-qa",
                {
                    "scan_id": self.SCAN_ID,
                    "reset_calibration": True,
                    "apply_tbm_calibration": True,
                },
            )
        except Exception:
            pass

    def test_01_valid_6_gcp_sample_points(self):
        status, res = self.post_json(
            "/api/survey/gcp-qa",
            {"scan_id": self.SCAN_ID, "generate_sample_points": True},
        )
        self.assertEqual(status, 200)
        self.assertEqual(res.get("status"), "ok")
        pts = res.get("gcp_residuals", [])
        self.assertEqual(len(pts), 6)
        self.assertIn(res.get("qa_grade"), ("A", "B", "C"))
        self.assertGreater(res.get("rmse_3d_m"), 0.0)
        self.assertGreater(res.get("rmse_h_m"), 0.0)
        self.assertGreater(res.get("rmse_2d_m"), 0.0)
        self.assertIn("tbm_calibration_preview", res)
        self.assertFalse(res.get("tbm_applied"))

    def test_02_designated_tbm_point_calibration(self):
        # Designate CP-01 as TBM and apply calibration
        status, res = self.post_json(
            "/api/survey/gcp-qa",
            {
                "scan_id": self.SCAN_ID,
                "generate_sample_points": True,
                "selected_tbm_id": "CP-01",
                "apply_tbm_calibration": True,
            },
        )
        self.assertEqual(status, 200)
        self.assertTrue(res.get("tbm_applied"))
        prev = res.get("tbm_calibration_preview", {})
        self.assertEqual(prev.get("tbm_point_id"), "CP-01")
        shift_m = prev.get("shift_m")

        # Find CP-01 in residuals
        cp01 = next((p for p in res.get("gcp_residuals", []) if p.get("name") == "CP-01"), None)
        self.assertIsNotNone(cp01)
        self.assertTrue(cp01.get("is_tbm"))
        # Calibrated residual for CP-01 must be 0
        self.assertAlmostEqual(cp01.get("dh"), 0.0, places=3)

    def test_03_singularity_zero_points(self):
        status, res = self.post_json(
            "/api/survey/gcp-qa",
            {
                "scan_id": self.SCAN_ID,
                "points": [],
                "generate_sample_points": False,
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(res.get("point_count"), 0)
        self.assertEqual(res.get("rmse_3d"), 0.0)
        self.assertEqual(res.get("qa_grade"), "A")
        self.assertFalse(res.get("tbm_applied"))

    def test_04_singularity_single_point(self):
        # 1 point should not cause division by zero in sample std dev (n-1)
        status, res = self.post_json(
            "/api/survey/gcp-qa",
            {
                "scan_id": self.SCAN_ID,
                "points": [
                    {
                        "name": "P-ONLY",
                        "e": 304952.0,
                        "n": 2757084.0,
                        "h_gcp": 45.0,
                        "h_scan": 45.03,
                    }
                ],
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(res.get("point_count"), 1)
        self.assertEqual(res.get("std_dh_m"), 0.0)
        self.assertAlmostEqual(res.get("rmse_h_m"), 0.03, places=2)

    def test_05_collinear_points(self):
        status, res = self.post_json(
            "/api/survey/gcp-qa",
            {
                "scan_id": self.SCAN_ID,
                "points": [
                    {"name": "L1", "e": 304900.0, "n": 2757000.0, "h_gcp": 40.0, "h_scan": 40.01},
                    {"name": "L2", "e": 304950.0, "n": 2757050.0, "h_gcp": 41.0, "h_scan": 41.02},
                    {"name": "L3", "e": 305000.0, "n": 2757100.0, "h_gcp": 42.0, "h_scan": 42.03},
                ],
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(res.get("point_count"), 3)
        self.assertGreater(res.get("rmse_3d_m"), 0.0)

    def test_06_malformed_and_none_points(self):
        status, res = self.post_json(
            "/api/survey/gcp-qa",
            {
                "scan_id": self.SCAN_ID,
                "points": [
                    {"name": "BAD_E", "e": "not_a_number", "n": 2757080.0},
                    {"name": "BAD_N", "e": 304950.0, "n": None},
                    {"name": "BAD_STR", "e": None, "n": "bad"},
                    "bad_string_element",
                    ["incomplete_pair", 123.4],
                    {"name": "GOOD1", "e": 304950.0, "n": 2757080.0, "h_gcp": 45.0, "h_scan": 45.02},
                ],
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(res.get("point_count"), 1)
        self.assertEqual(res["gcp_residuals"][0]["name"], "GOOD1")

    def test_07_tbm_persistence_in_sqlite_and_volume_propagation(self):
        # 1. Reset calibration first
        self.post_json(
            "/api/survey/gcp-qa",
            {"scan_id": self.SCAN_ID, "reset_calibration": True, "apply_tbm_calibration": True},
        )

        # 2. Get baseline volume
        status, vol_base = self.post_json(
            "/api/survey/volume",
            {
                "scan_id": self.SCAN_ID,
                "ref_plane_mode": "custom",
                "custom_plane_h": 40.0,
            },
        )
        self.assertEqual(status, 200)
        base_v_offset = vol_base.get("vertical_datum_offset", 0.0)
        self.assertEqual(base_v_offset, 0.0)

        # 3. Apply TBM calibration with a known offset (CP-01 designated)
        status, qa_res = self.post_json(
            "/api/survey/gcp-qa",
            {
                "scan_id": self.SCAN_ID,
                "generate_sample_points": True,
                "selected_tbm_id": "CP-01",
                "apply_tbm_calibration": True,
            },
        )
        self.assertEqual(status, 200)
        applied_shift = qa_res.get("tbm_shift_m")

        # 4. Check SQLite extra_json persistence
        conn = sqlite3.connect(self.DB_PATH)
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT extra_json FROM scans WHERE scan_id = ?", (self.SCAN_ID,)).fetchone()
        conn.close()
        self.assertIsNotNone(row)
        extra = json.loads(row["extra_json"])
        self.assertIn("tbm_calibration", extra)
        self.assertIn("vertical_datum_offset", extra)
        self.assertAlmostEqual(extra["vertical_datum_offset"], applied_shift, places=3)

        # 5. Check volume calculation picks up persisted vertical_datum_offset
        status, vol_cal = self.post_json(
            "/api/survey/volume",
            {
                "scan_id": self.SCAN_ID,
                "ref_plane_mode": "custom",
                "custom_plane_h": 40.0,
            },
        )
        self.assertEqual(status, 200)
        cal_v_offset = vol_cal.get("vertical_datum_offset", 0.0)
        self.assertAlmostEqual(cal_v_offset, applied_shift, places=3)

        # 6. Reset calibration and verify extra_json cleared
        self.post_json(
            "/api/survey/gcp-qa",
            {"scan_id": self.SCAN_ID, "reset_calibration": True, "apply_tbm_calibration": True},
        )
        conn = sqlite3.connect(self.DB_PATH)
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT extra_json FROM scans WHERE scan_id = ?", (self.SCAN_ID,)).fetchone()
        conn.close()
        extra_cleared = json.loads(row["extra_json"])
        self.assertNotIn("tbm_calibration", extra_cleared)
        self.assertNotIn("vertical_datum_offset", extra_cleared)


if __name__ == "__main__":
    unittest.main()
