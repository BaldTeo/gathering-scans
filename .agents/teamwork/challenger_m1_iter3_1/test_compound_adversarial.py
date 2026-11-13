#!/usr/bin/env python3
"""
Compound Input Adversarial Stress Test Suite (challenger_m1_iter3_1)
Adversarial test battery verifying input hardening across M1 surveying and optimizer endpoints:
1. /api/survey/gcp-qa (compute_gcp_accuracy_qa)
2. /api/survey/volume (calculate_cut_fill_volume)
3. /api/survey/contours (generate_elevation_contours)
4. /api/survey/profile (compute_cross_section_profile)
5. /api/survey/inspect-photos (inspect_rtk_camera_photos)
6. /api/optimizer/generate-scan (run_generate_scan_action)
Both direct Python engine mixin level and live HTTP server level.
"""

import unittest
import os
import sys
import json
import urllib.request
import urllib.error
import tempfile
import time

# Ensure project root in sys.path
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from pc_worker.priority_queue import ScanQueueDB
from pc_worker.surveying_engine import SurveyingEngine
from pc_worker.optimizer_bridge import OptimizerBridge


class CompoundInputAdversarialTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp_db_fd, cls.tmp_db_path = tempfile.mkstemp(suffix=".db")
        os.close(cls.tmp_db_fd)
        cls.db = ScanQueueDB(db_path=cls.tmp_db_path)
        cls.scan_id = "quchi_20261005_merged"
        cls.db.upsert_scan(
            {
                "scan_id": cls.scan_id,
                "name": "2026-10-05-15-43-55",
                "project_group": "QuChi Dam",
                "project_dir": r"C:\GatheringScans\QuChi_20261005_Compressed",
                "tileset_path": r"C:\GatheringScans\QuChi_20261005_Compressed\tileset\tileset.json",
                "obj_path": r"C:\Scans\QuChi\QuChi_20261005_Compressed\exports\QuChi_20261005_Compressed-obj_mesh\mesh.obj",
                "crs": "TWD97 (121) + TWVD2001",
                "status": "completed",
            }
        )
        cls.survey = SurveyingEngine(cls.db)
        cls.opt = OptimizerBridge(cls.db)
        cls.server_url = "http://127.0.0.1:8095"

    @classmethod
    def tearDownClass(cls):
        try:
            os.remove(cls.tmp_db_path)
        except OSError:
            pass

    # -------------------------------------------------------------------------
    # Battery 1: /api/survey/gcp-qa (compute_gcp_accuracy_qa)
    # -------------------------------------------------------------------------
    def test_01_gcp_qa_empty_points(self):
        """Test GCP QA with empty points array - should auto-sample or return clean status."""
        res = self.survey.compute_gcp_accuracy_qa(
            {"scan_id": self.scan_id, "points": []}
        )
        self.assertEqual(res["status"], "ok")
        self.assertGreater(res["point_count"], 0)

    def test_02_gcp_qa_all_invalid_points(self):
        """Test GCP QA with hostile points containing empty strings, whitespace, and garbage tokens."""
        hostile_points = [
            {"name": "BAD_EMPTY", "e": "", "n": "  ", "h_gcp": "null", "h_scan": "undefined"},
            {"name": "BAD_NAN", "e": "NaN", "n": "inf", "h_gcp": "-inf", "h_scan": "none"},
            {"name": "BAD_GARBAGE", "e": "$%^#@", "n": "abc123", "h_gcp": "invalid", "h_scan": ""},
            {"name": "BAD_NULL", "e": None, "n": None, "h_gcp": None, "h_scan": None},
            {"name": "BAD_WHITESPACE", "e": "\t\r\n", "n": "   ", "h_gcp": "   "},
        ]
        res = self.survey.compute_gcp_accuracy_qa(
            {"scan_id": self.scan_id, "points": hostile_points}
        )
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["point_count"], 0)
        self.assertEqual(len(res["points"]), 0)

    def test_03_gcp_qa_mixed_valid_invalid_points(self):
        """Test GCP QA with a mixture of hostile invalid points and valid coordinate points."""
        mixed_points = [
            {"name": "BAD_1", "e": "", "n": "  ", "h_gcp": "null"},
            {"name": "VALID_1", "e": 304952.0, "n": 2757084.0, "h_gcp": 124.5, "h_scan": "124.55"},
            {"name": "BAD_2", "e": "none", "n": "null", "h_gcp": ""},
            {"name": "VALID_2", "e": 304960.0, "n": 2757090.0, "h_gcp": 125.0, "h_scan": "125.02"},
            {"name": "BAD_3", "e": "garbage", "n": 2757084.0, "h_gcp": "invalid"},
        ]
        res = self.survey.compute_gcp_accuracy_qa(
            {
                "scan_id": self.scan_id,
                "points": mixed_points,
                "geoid_offset_override": "   ",  # Hostile whitespace in override
            }
        )
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["point_count"], 2)
        valid_names = [p["name"] for p in res["points"]]
        self.assertIn("VALID_1", valid_names)
        self.assertIn("VALID_2", valid_names)

    def test_04_gcp_qa_tuple_list_representations(self):
        """Test GCP QA when points are supplied as list-of-lists or tuples."""
        list_points = [
            ["CP_BAD", "", "  ", "null", "none"],
            ["CP_VALID", 304952.0, 2757084.0, 124.5, 124.53],
        ]
        res = self.survey.compute_gcp_accuracy_qa(
            {"scan_id": self.scan_id, "points": list_points}
        )
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["point_count"], 1)

    # -------------------------------------------------------------------------
    # Battery 2: /api/survey/volume (calculate_cut_fill_volume)
    # -------------------------------------------------------------------------
    def test_05_volume_empty_polygon(self):
        """Test volume calculation with empty polygon [] - falls back cleanly to default boundary."""
        res = self.survey.calculate_cut_fill_volume(
            {"scan_id": self.scan_id, "polygon": []}
        )
        self.assertEqual(res["status"], "ok")
        self.assertGreater(res["planar_area_m2"], 0.0)

    def test_06_volume_1_point_hostile_polygon(self):
        """Test volume calculation with 1 hostile point -> clean status: error, valid_points < 3."""
        res = self.survey.calculate_cut_fill_volume(
            {"scan_id": self.scan_id, "polygon": [{"x": "", "z": "  "}]}
        )
        self.assertEqual(res["status"], "error")
        self.assertIn("at least 3 valid coordinate points", res["error"])
        self.assertEqual(res["valid_points_count"], 0)

    def test_07_volume_1_point_valid_polygon(self):
        """Test volume calculation with 1 valid point -> clean status: error, valid_points < 3."""
        res = self.survey.calculate_cut_fill_volume(
            {"scan_id": self.scan_id, "polygon": [{"x": 10.0, "z": 20.0}]}
        )
        self.assertEqual(res["status"], "error")
        self.assertIn("at least 3 valid coordinate points", res["error"])
        self.assertEqual(res["valid_points_count"], 1)

    def test_08_volume_2_points_polygon(self):
        """Test volume calculation with 2 points -> clean status: error, valid_points < 3."""
        res = self.survey.calculate_cut_fill_volume(
            {
                "scan_id": self.scan_id,
                "polygon": [{"x": 10.0, "z": 20.0}, {"x": "  ", "z": "bad"}, {"x": 30.0, "z": 40.0}],
            }
        )
        self.assertEqual(res["status"], "error")
        self.assertIn("at least 3 valid coordinate points", res["error"])
        self.assertEqual(res["valid_points_count"], 2)

    def test_09_volume_mixed_points_ge_3_valid(self):
        """Test volume calculation with >= 3 valid points among hostile tokens -> status: ok."""
        hostile_poly = [
            {"x": "", "z": ""},
            {"x": -5.0, "z": -5.0},
            {"x": "bad", "z": "junk"},
            {"x": 5.0, "z": -5.0},
            {"x": "none", "z": "null"},
            {"x": 0.0, "z": 5.0},
            {"x": "  ", "z": " "},
        ]
        res = self.survey.calculate_cut_fill_volume(
            {
                "scan_id": self.scan_id,
                "polygon": hostile_poly,
                "swell_factor": "",
                "shrinkage_factor": "   ",
                "truck_volume_m3": "bad",
                "truck_max_tonnes": "null",
                "geoid_offset_override": "undefined",
            }
        )
        self.assertEqual(res["status"], "ok")
        self.assertGreater(res["planar_area_m2"], 0.0)
        self.assertIn("cut_volume_bcm", res)
        self.assertIn("fill_volume_bcm", res)
        self.assertIn("conserved_cut_mass_t", res)
        self.assertIn("truck_loads_cut", res)
        self.assertIn("truck_specs", res)

    def test_10_volume_list_of_lists_representation(self):
        """Test volume calculation with list-of-lists polygon containing garbage."""
        hostile_poly = [
            ["", " "],
            [-5.0, -5.0],
            ["bad", "token"],
            [5.0, -5.0],
            [0.0, 5.0],
        ]
        res = self.survey.calculate_cut_fill_volume(
            {"scan_id": self.scan_id, "polygon": hostile_poly}
        )
        self.assertEqual(res["status"], "ok")
        self.assertGreater(res["planar_area_m2"], 0.0)

    # -------------------------------------------------------------------------
    # Battery 3: /api/survey/contours (generate_elevation_contours)
    # -------------------------------------------------------------------------
    def test_11_contours_empty_whitespace_intervals(self):
        """Test contours with empty strings and whitespace in intervals -> safe fallback to defaults."""
        res = self.survey.generate_elevation_contours(
            {
                "scan_id": self.scan_id,
                "minor_interval_m": "",
                "major_interval_m": "   ",
            }
        )
        self.assertEqual(res["status"], "ok")
        self.assertGreaterEqual(res["minor_interval_m"], 0.1)
        self.assertGreaterEqual(res["major_interval_m"], res["minor_interval_m"])

    def test_12_contours_negative_intervals(self):
        """Test contours with negative interval values -> fallback / clamped to positive."""
        res = self.survey.generate_elevation_contours(
            {
                "scan_id": self.scan_id,
                "minor_interval_m": -5.0,
                "major_interval_m": -25.0,
            }
        )
        self.assertEqual(res["status"], "ok")
        self.assertGreaterEqual(res["minor_interval_m"], 0.1)
        self.assertGreaterEqual(res["major_interval_m"], res["minor_interval_m"])

    def test_13_contours_garbage_tokens_and_hostile_mask(self):
        """Test contours with non-numeric tokens and hostile mask polygon."""
        res = self.survey.generate_elevation_contours(
            {
                "scan_id": self.scan_id,
                "minor_interval_m": "NaN",
                "major_interval_m": "none",
                "mask_polygon": [{"x": "", "z": "  "}, {"x": "bad", "z": 10}],
            }
        )
        self.assertEqual(res["status"], "ok")
        self.assertGreaterEqual(res["minor_interval_m"], 0.1)
        self.assertGreaterEqual(res["major_interval_m"], res["minor_interval_m"])

    # -------------------------------------------------------------------------
    # Battery 4: /api/survey/profile (compute_cross_section_profile)
    # -------------------------------------------------------------------------
    def test_14_profile_empty_whitespace_endpoints(self):
        """Test cross-section profile with empty strings and whitespace in start/end points."""
        res = self.survey.compute_cross_section_profile(
            {
                "scan_id": self.scan_id,
                "start_point": {"x": "", "z": "  "},
                "end_point": {"x": "  ", "z": ""},
            }
        )
        self.assertEqual(res["status"], "ok")
        self.assertGreater(len(res["samples"]), 0)

    def test_15_profile_garbage_and_none_endpoints(self):
        """Test cross-section profile with garbage strings and None endpoints."""
        res = self.survey.compute_cross_section_profile(
            {
                "scan_id": self.scan_id,
                "start_point": ["bad_coord", "none"],
                "end_point": {"x": "undefined", "z": "null"},
            }
        )
        self.assertEqual(res["status"], "ok")
        self.assertGreater(len(res["samples"]), 0)

    # -------------------------------------------------------------------------
    # Battery 5: /api/survey/inspect-photos (inspect_rtk_camera_photos)
    # -------------------------------------------------------------------------
    def test_16_inspect_photos_empty_whitespace_coords(self):
        """Test RTK camera photo inspection with empty strings and whitespace coordinates."""
        res = self.survey.inspect_rtk_camera_photos(
            {
                "scan_id": self.scan_id,
                "x": "",
                "y": "  ",
                "z": "\t",
                "max_radius_m": "   ",
                "limit": "",
            }
        )
        self.assertEqual(res["status"], "ok")

    def test_17_inspect_photos_garbage_tokens_and_negative_radius(self):
        """Test RTK photo inspection with non-numeric tokens and negative radius/limit."""
        res = self.survey.inspect_rtk_camera_photos(
            {
                "scan_id": self.scan_id,
                "x": "bad",
                "y": "null",
                "z": "undefined",
                "max_radius_m": -100.0,
                "limit": -10,
                "twd_e": "",
                "twd_n": "  ",
                "twd_h": "invalid",
            }
        )
        self.assertEqual(res["status"], "ok")

    # -------------------------------------------------------------------------
    # Battery 6: /api/optimizer/generate-scan (run_generate_scan_action)
    # -------------------------------------------------------------------------
    def test_18_optimizer_crop_keep_empty_and_garbage_elev(self):
        """Test optimizer crop_keep with empty strings and non-numeric tokens in min/max elev."""
        # Should NOT crash with ValueError: could not convert string to float.
        # Should raise validation ValueError (staged adjustment required) cleanly.
        with self.assertRaises(ValueError) as cm:
            self.opt.run_generate_scan_action(
                {
                    "scan_id": self.scan_id,
                    "crop_keep": {"min_elev": "", "max_elev": "bad"},
                }
            )
        self.assertIn("Please stage at least one adjustment", str(cm.exception))

    def test_19_optimizer_crop_keep_with_malformed_polygons(self):
        """Test optimizer crop_keep with malformed polygon coordinates."""
        with self.assertRaises(ValueError) as cm:
            self.opt.run_generate_scan_action(
                {
                    "scan_id": self.scan_id,
                    "crop_keep": {
                        "min_elev": "null",
                        "max_elev": "undefined",
                        "native_polygons": [["bad", "coord"], ["", ""]],
                    },
                }
            )
        self.assertIn("Please stage at least one adjustment", str(cm.exception))

    # -------------------------------------------------------------------------
    # Live HTTP Server Battery (http://127.0.0.1:8095)
    # -------------------------------------------------------------------------
    def _http_post(self, path: str, payload: dict, headers: dict = None) -> tuple[int, dict]:
        url = f"{self.server_url}{path}"
        req_headers = {"Content-Type": "application/json"}
        if headers:
            req_headers.update(headers)
        data_bytes = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data_bytes, headers=req_headers)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8")
            try:
                parsed = json.loads(body)
            except Exception:
                parsed = {"raw": body}
            return e.code, parsed

    def test_20_http_gcp_qa_hostile_points(self):
        """HTTP: /api/survey/gcp-qa returns HTTP 200 with hostile points array."""
        payload = {
            "scan_id": self.scan_id,
            "points": [
                {"name": "CP_EMPTY", "e": "", "n": "  ", "h_gcp": "null", "h_scan": "undefined"},
                {"name": "CP_GARBAGE", "e": "none", "n": "NaN", "h_gcp": "junk"},
            ],
        }
        status_code, body = self._http_post("/api/survey/gcp-qa", payload)
        self.assertEqual(status_code, 200)
        self.assertEqual(body.get("status"), "ok")
        self.assertEqual(body.get("point_count"), 0)

    def test_21_http_volume_1_point_hostile_polygon(self):
        """HTTP: /api/survey/volume returns HTTP 200 with status: error on hostile 1-point polygon."""
        payload = {
            "scan_id": self.scan_id,
            "polygon": [{"x": "", "z": "  "}],
        }
        status_code, body = self._http_post("/api/survey/volume", payload)
        self.assertEqual(status_code, 200)
        self.assertEqual(body.get("status"), "error")
        self.assertIn("at least 3 valid coordinate points", body.get("error", ""))
        self.assertEqual(body.get("valid_points_count"), 0)

    def test_22_http_volume_mixed_polygon_ge_3_valid(self):
        """HTTP: /api/survey/volume returns HTTP 200 status: ok with mixed valid/hostile polygon."""
        payload = {
            "scan_id": self.scan_id,
            "polygon": [
                {"x": "", "z": "bad"},
                {"x": -5.0, "z": -5.0},
                {"x": "null", "z": "none"},
                {"x": 5.0, "z": -5.0},
                {"x": 0.0, "z": 5.0},
            ],
        }
        status_code, body = self._http_post("/api/survey/volume", payload)
        self.assertEqual(status_code, 200)
        self.assertEqual(body.get("status"), "ok")
        self.assertGreater(body.get("planar_area_m2", 0.0), 0.0)

    def test_23_http_contours_negative_and_empty_intervals(self):
        """HTTP: /api/survey/contours returns HTTP 200 with negative and empty intervals."""
        payload = {
            "scan_id": self.scan_id,
            "minor_interval_m": "",
            "major_interval_m": -10.0,
        }
        status_code, body = self._http_post("/api/survey/contours", payload)
        self.assertEqual(status_code, 200)
        self.assertEqual(body.get("status"), "ok")
        self.assertGreaterEqual(body.get("minor_interval_m", 0.0), 0.1)

    def test_24_http_profile_empty_start_end(self):
        """HTTP: /api/survey/profile returns HTTP 200 with empty start and end points."""
        payload = {
            "scan_id": self.scan_id,
            "start_point": {"x": "", "z": "  "},
            "end_point": {"x": "invalid", "z": ""},
        }
        status_code, body = self._http_post("/api/survey/profile", payload)
        self.assertEqual(status_code, 200)
        self.assertEqual(body.get("status"), "ok")
        self.assertGreater(len(body.get("samples", [])), 0)

    def test_25_http_inspect_photos_garbage_coords(self):
        """HTTP: /api/survey/inspect-photos returns HTTP 200 with garbage coords and radius."""
        payload = {
            "scan_id": self.scan_id,
            "x": "",
            "y": "  ",
            "z": "bad",
            "max_radius_m": "",
            "limit": "   ",
        }
        status_code, body = self._http_post("/api/survey/inspect-photos", payload)
        self.assertEqual(status_code, 200)
        self.assertEqual(body.get("status"), "ok")

    def test_26_http_optimizer_generate_scan_empty_elev_returns_clean_400(self):
        """HTTP: /api/optimizer/generate-scan returns clean HTTP 400 (not 500) on empty elev tokens."""
        payload = {
            "scan_id": self.scan_id,
            "crop_keep": {"min_elev": "", "max_elev": "bad"},
        }
        status_code, body = self._http_post(
            "/api/optimizer/generate-scan",
            payload,
            headers={
                "X-Tunnel-Key": "gs_tunnel_gatheren_2026_twd97",
                "X-User-Email": "glibivanov@gatheren.com.tw",
            },
        )
        self.assertEqual(status_code, 400)
        self.assertIn("Please stage at least one adjustment", body.get("error", ""))


if __name__ == "__main__":
    unittest.main()
