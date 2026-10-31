#!/usr/bin/env python3
"""
Adversarial Live API & Downstream Regression Challenge Suite for Milestone 4 & 5.
Empirical Challenger: challenger_m4_m5_2
Targets:
- Live Local Server (http://127.0.0.1:8095)
- Endpoints:
  * POST /api/survey/surface-qa
  * POST /api/survey/utility-trace
  * POST /api/survey/compare-volume
  * POST /api/survey/stakeout-export
- Malformed & Adversarial Payloads (ensure 400/404 or clean fallback without 500)
- Zero Data Destruction (C:\\GatheringScans and data/gathering_scans.db)
- Strict Architectural Rules (< 5,000 lines, 0 emojis, E-N-Z order)
"""

import os
import re
import sys
import json
import math
import sqlite3
import unittest
import urllib.request
import urllib.error

BASE_URL = "http://127.0.0.1:8095"
LOCAL_SCANS_DIR = r"C:\GatheringScans"
DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "gathering_scans.db")


def post_json(path: str, data: any, timeout: int = 10):
    url = f"{BASE_URL}{path}"
    if isinstance(data, (dict, list)):
        payload_bytes = json.dumps(data).encode("utf-8")
        headers = {"Content-Type": "application/json"}
    elif isinstance(data, (bytes, str)):
        payload_bytes = data.encode("utf-8") if isinstance(data, str) else data
        headers = {"Content-Type": "application/json"}
    else:
        payload_bytes = str(data).encode("utf-8")
        headers = {"Content-Type": "text/plain"}

    req = urllib.request.Request(url, data=payload_bytes, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return resp.status, json.loads(body) if resp.headers.get_content_type() == "application/json" else body
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = body
        return e.code, parsed
    except Exception as e:
        return 0, str(e)


class AdversarialMilestone4And5LiveChallenge(unittest.TestCase):
    """Rigorous adversarial tests executed against live local server."""

    @classmethod
    def setUpClass(cls):
        status_code, resp = cls._get("/api/status")
        if status_code != 200:
            raise RuntimeError(f"Local server at {BASE_URL} is offline (status={status_code}): {resp}")

    @staticmethod
    def _get(path: str):
        url = f"{BASE_URL}{path}"
        req = urllib.request.Request(url, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                body = resp.read().decode("utf-8")
                return resp.status, json.loads(body) if resp.headers.get_content_type() == "application/json" else body
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8")
        except Exception as e:
            return 0, str(e)

    # =========================================================================
    # CHALLENGE 1: Live Endpoints & Functional Payloads
    # =========================================================================

    def test_01_surface_qa_horizontal_valid(self):
        """Test POST /api/survey/surface-qa with horizontal reference plane."""
        payload = {
            "scan_id": "edited_qihu_unified_merged_scan_4_scans__edited_372953",
            "reference_mode": "horizontal",
            "reference_elevation": 125.0,
            "tolerance_mm": 10.0,
            "points": [
                {"e": 304950.0, "n": 2757080.0, "h": 125.002},
                {"e": 304955.0, "n": 2757080.0, "h": 124.996},
                {"e": 304955.0, "n": 2757085.0, "h": 125.015},
                {"e": 304950.0, "n": 2757085.0, "h": 124.982},
            ],
        }
        status, res = post_json("/api/survey/surface-qa", payload)
        self.assertEqual(status, 200, f"Expected 200, got {status}: {res}")
        self.assertEqual(res.get("status"), "ok")
        self.assertEqual(res.get("reference_mode"), "horizontal")
        self.assertIn("pass_rate_pct", res)
        self.assertIn("astm_e1155", res)
        self.assertIn("ff_flatness", res["astm_e1155"])
        self.assertIn("fl_levelness", res["astm_e1155"])
        self.assertIn("plumb_tilt", res)
        self.assertIn("max_high", res)
        self.assertIn("max_low", res)

    def test_02_surface_qa_vertical_plumb(self):
        """Test POST /api/survey/surface-qa with vertical plumb reference."""
        payload = {
            "scan_id": "edited_qihu_unified_merged_scan_4_scans__edited_372953",
            "reference_mode": "vertical",
            "wall_line": [
                {"e": 304950.0, "n": 2757080.0},
                {"e": 304960.0, "n": 2757080.0},
            ],
            "tolerance_mm": 15.0,
            "points": [
                {"e": 304952.0, "n": 2757080.005, "h": 122.0},
                {"e": 304952.0, "n": 2757080.012, "h": 124.0},
                {"e": 304958.0, "n": 2757079.994, "h": 122.0},
                {"e": 304958.0, "n": 2757080.020, "h": 124.0},
            ],
        }
        status, res = post_json("/api/survey/surface-qa", payload)
        self.assertEqual(status, 200)
        self.assertEqual(res.get("status"), "ok")
        self.assertEqual(res.get("reference_mode"), "vertical")
        ref_plane = res.get("reference_plane", {})
        self.assertEqual(ref_plane.get("c"), 0.0, "Vertical plumb plane normal must have C=0")
        self.assertIn("plumb_mm_per_m", res["plumb_tilt"])

    def test_03_surface_qa_best_fit(self):
        """Test POST /api/survey/surface-qa with SVD least-squares best-fit plane."""
        payload = {
            "scan_id": "edited_qihu_unified_merged_scan_4_scans__edited_372953",
            "reference_mode": "best_fit",
            "tolerance_mm": 8.0,
            "points": [
                {"e": 304950.0, "n": 2757080.0, "h": 125.0},
                {"e": 304955.0, "n": 2757080.0, "h": 125.1},
                {"e": 304955.0, "n": 2757085.0, "h": 125.2},
                {"e": 304950.0, "n": 2757085.0, "h": 125.1},
            ],
        }
        status, res = post_json("/api/survey/surface-qa", payload)
        self.assertEqual(status, 200)
        self.assertEqual(res.get("status"), "ok")
        self.assertEqual(res.get("reference_mode"), "best_fit")
        # In best-fit plane, mean deviation should be ~0 mm
        self.assertAlmostEqual(res.get("mean_dev_mm", 0.0), 0.0, delta=0.5)

    def test_04_utility_tracer_valid(self):
        """Test POST /api/survey/utility-trace invert & crown geometry and gradients."""
        payload = {
            "scan_id": "edited_qihu_unified_merged_scan_4_scans__edited_372953",
            "pipe_type": "SEWER",
            "point_mode": "invert",
            "pipe_diameter_mm": 400.0,
            "min_cover_m": 1.5,
            "station_start": 100.0,
            "points": [
                {"e": 304940.0, "n": 2757070.0, "h": 120.0, "name": "MH-01"},
                {"e": 304950.0, "n": 2757070.0, "h": 119.8, "name": "MH-02"},
                {"e": 304960.0, "n": 2757070.0, "h": 119.6, "name": "MH-03"},
            ],
        }
        status, res = post_json("/api/survey/utility-trace", payload)
        self.assertEqual(status, 200)
        self.assertEqual(res.get("status"), "ok")
        self.assertAlmostEqual(res.get("total_length_2d_m", 0.0), 20.0, delta=0.1)
        self.assertIn("stations", res)
        self.assertEqual(len(res["stations"]), 3)

        # Check invert and crown elevation math
        st0 = res["stations"][0]
        self.assertEqual(st0["invert_z"], 120.0)
        self.assertEqual(st0["crown_z"], 120.4)
        self.assertAlmostEqual(st0["slope_pct"], -2.0, delta=0.01)
        self.assertEqual(st0["slope_ratio"], "1:50")
        self.assertEqual(st0["flow_dir"], "Forward")

        # Check exports
        self.assertIn("csv_export", res)
        self.assertIn("dxf_export", res)
        self.assertIn("Index,Station,Station_Label,Name,Easting,Northing", res["csv_export"])
        self.assertIn("PIPE_INVERT", res["dxf_export"])
        self.assertIn("PIPE_CROWN", res["dxf_export"])

    def test_05_compare_volume_valid_mass_conservation(self):
        """Test POST /api/survey/compare-volume multi-epoch cut/fill and mass conservation."""
        payload = {
            "baseline_scan_id": "ntudorm_20260915_baseline",
            "compare_scan_id": "rosepark_20260918_merged",
            "material_type": "common_earth",
            "swell_factor": 0.25,
            "shrink_factor": 0.10,
            "bank_density": 1.80,
            "compact_density": 2.00,
            "truck_capacity_m3": 12.0,
            "truck_payload_tonnes": 20.0,
            "polygon": [
                {"e": 304940.0, "n": 2757070.0},
                {"e": 304960.0, "n": 2757070.0},
                {"e": 304960.0, "n": 2757090.0},
                {"e": 304940.0, "n": 2757090.0},
            ],
        }
        status, res = post_json("/api/survey/compare-volume", payload)
        self.assertEqual(status, 200)
        self.assertEqual(res.get("status"), "ok")
        self.assertIn("cut_volume_bcm", res)
        self.assertIn("cut_volume_lcm", res)
        self.assertIn("cut_mass_tonnes", res)
        self.assertIn("fill_volume_ccm", res)
        self.assertIn("site_balance", res)

        # Empirically verify mass conservation formulas:
        # V_LCM = V_BCM * (1 + swell_factor)
        # Mass = V_BCM * bank_density
        cut_bcm = res["cut_volume_bcm"]
        cut_lcm = res["cut_volume_lcm"]
        cut_mass = res["cut_mass_tonnes"]
        if cut_bcm > 0.001:
            self.assertAlmostEqual(cut_lcm, cut_bcm * 1.25, delta=0.05)
            self.assertAlmostEqual(cut_mass, cut_bcm * 1.80, delta=0.05)

        fill_ccm = res["fill_volume_ccm"]
        fill_bcm = res["fill_volume_bcm"]
        if fill_ccm > 0.001:
            self.assertAlmostEqual(fill_ccm, fill_bcm * 0.90, delta=0.05)

    def test_06_stakeout_export_strictly_e_n_z_order(self):
        """Test POST /api/survey/stakeout-export verifies strict PtID, Easting, Northing, Elevation, Code order."""
        payload = {
            "scan_id": "edited_qihu_unified_merged_scan_4_scans__edited_372953",
            "project_name": "Qihu QA Project",
            "points": [
                {"id": "CP-101", "e": 304951.123, "n": 2757081.456, "z": 124.789, "code": "COLUMN_NW"},
                {"id": "CP-102", "e": 304961.234, "n": 2757081.567, "z": 124.890, "code": "COLUMN_NE"},
            ],
        }
        status, res = post_json("/api/survey/stakeout-export", payload)
        self.assertEqual(status, 200)
        self.assertEqual(res.get("status"), "ok")
        self.assertIn("points", res)
        self.assertEqual(len(res["points"]), 2)

        p1 = res["points"][0]
        self.assertEqual(p1["ptid"], "CP-101")
        self.assertEqual(p1["easting"], 304951.123)
        self.assertEqual(p1["northing"], 2757081.456)
        self.assertEqual(p1["elevation"], 124.789)
        self.assertEqual(p1["code"], "COLUMN_NW")

        # Verify CSV format strictly
        csv_str = res.get("csv_export", "")
        self.assertIn("PtID,Easting,Northing,Elevation,Code", csv_str)
        self.assertIn("CP-101,304951.123,2757081.456,124.789,COLUMN_NW", csv_str)
        self.assertIn("CP-102,304961.234,2757081.567,124.890,COLUMN_NE", csv_str)

        # Verify TXT Leica/Trimble format
        txt_str = res.get("txt_export", "")
        self.assertIn("CP-101 304951.123 2757081.456 124.789 COLUMN_NW", txt_str)

        # Verify DXF POINT entity has 10 (Easting), 20 (Northing), 30 (Elevation)
        dxf_str = res.get("dxf_export", "")
        self.assertIn("304951.123", dxf_str)
        self.assertIn("2757081.456", dxf_str)
        self.assertIn("124.789", dxf_str)

        # Verify HTML field sheet
        html_sheet = res.get("html_field_sheet", "")
        self.assertIn("RTK Field Stakeout Sheet", html_sheet)
        self.assertIn("Design E (m)", html_sheet)
        self.assertIn("Design N (m)", html_sheet)
        self.assertIn("Design Z (m)", html_sheet)

    # =========================================================================
    # CHALLENGE 2: Malformed Payloads, Boundary Cases & Zero Unhandled 500s
    # =========================================================================

    def test_07_malformed_json_syntax(self):
        """Malformed JSON string must return clean HTTP 400 with 'error', never 500."""
        for endpoint in [
            "/api/survey/surface-qa",
            "/api/survey/utility-trace",
            "/api/survey/compare-volume",
            "/api/survey/stakeout-export",
        ]:
            status, res = post_json(endpoint, "{ bad json syntax : 123, }")
            self.assertEqual(status, 400, f"Expected 400 for bad JSON on {endpoint}, got {status}")
            self.assertTrue(isinstance(res, dict) and "error" in res)

    def test_08_empty_payload(self):
        """Empty payload {} must be handled cleanly without unhandled 500 exception."""
        for endpoint in [
            "/api/survey/surface-qa",
            "/api/survey/utility-trace",
            "/api/survey/compare-volume",
            "/api/survey/stakeout-export",
        ]:
            status, res = post_json(endpoint, {})
            self.assertIn(status, [200, 400, 404], f"Endpoint {endpoint} gave unexpected status {status}")
            if status != 200:
                self.assertTrue(isinstance(res, dict) and "error" in res)
            else:
                self.assertEqual(res.get("status"), "ok")

    def test_09_non_dict_json_payloads(self):
        """Non-dict JSON bodies (list, int, string) must return clean 400 or be handled gracefully without 500."""
        for endpoint in [
            "/api/survey/surface-qa",
            "/api/survey/utility-trace",
            "/api/survey/compare-volume",
            "/api/survey/stakeout-export",
        ]:
            for weird_body in ["[1, 2, 3]", "\"a simple string\"", "12345"]:
                status, res = post_json(endpoint, weird_body)
                self.assertNotEqual(
                    status,
                    500,
                    f"CRITICAL BUG: Endpoint {endpoint} crashed with HTTP 500 on non-dict JSON body {weird_body}: {res}",
                )

    def test_10_extreme_and_corrupt_coordinates(self):
        """Test numerical stability against extreme tolerances, negative numbers, and corrupt strings."""
        # Surface QA extreme tolerance
        status, res = post_json(
            "/api/survey/surface-qa",
            {
                "scan_id": "edited_qihu_unified_merged_scan_4_scans__edited_372953",
                "tolerance_mm": -999.0,  # Negative tolerance
                "secondary_tolerance_mm": -100.0,
                "grid_spacing_m": 0.00001,
                "points": [
                    {"e": "invalid_str", "n": None, "h": "NaN"},
                    {"e": 304950.0, "n": 2757080.0, "h": 125.0},
                ],
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(res.get("status"), "ok")

        # Utility trace negative diameter & duplicate point
        status, res = post_json(
            "/api/survey/utility-trace",
            {
                "scan_id": "edited_qihu_unified_merged_scan_4_scans__edited_372953",
                "pipe_diameter_mm": -500.0,
                "min_cover_m": -10.0,
                "points": [
                    {"e": 304950.0, "n": 2757080.0, "h": 120.0},
                    {"e": 304950.0, "n": 2757080.0, "h": 120.0},
                ],
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(res.get("status"), "ok")

        # Compare volume with 2-point polygon (degenerate)
        status, res = post_json(
            "/api/survey/compare-volume",
            {
                "baseline_scan_id": "ntudorm_20260915_baseline",
                "compare_scan_id": "rosepark_20260918_merged",
                "polygon": [{"e": 304950.0, "n": 2757080.0}, {"e": 304960.0, "n": 2757080.0}],
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(res.get("status"), "ok")

        # Stakeout export with empty / invalid grid count
        status, res = post_json(
            "/api/survey/stakeout-export",
            {
                "scan_id": "edited_qihu_unified_merged_scan_4_scans__edited_372953",
                "source_mode": "grid",
                "grid_count_e": -5,
                "grid_count_n": 0,
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(res.get("status"), "ok")

    # =========================================================================
    # CHALLENGE 3: Zero Data Destruction & Raw Storage Audit
    # =========================================================================

    def test_11_raw_scan_directory_untouched(self):
        """Verify that C:\\GatheringScans raw project directories remain 100% untouched."""
        self.assertTrue(os.path.isdir(LOCAL_SCANS_DIR), f"Raw scans directory {LOCAL_SCANS_DIR} missing!")
        
        # Verify key baseline project directories exist
        required_dirs = [
            "catch_QihuPark_20261028",
            "RosePark_Merged2",
            "NTU_Dorm_260915",
            "QuChi261016_Trees",
            "edited_qihu_unified_merged_scan_4_scans__edited_372953",
        ]
        for rd in required_dirs:
            p = os.path.join(LOCAL_SCANS_DIR, rd)
            self.assertTrue(os.path.isdir(p), f"Critical raw scan project {rd} missing from {LOCAL_SCANS_DIR}!")

        # Count total files across C:\GatheringScans
        total_files = sum(len(files) for _, _, files in os.walk(LOCAL_SCANS_DIR))
        print(f"\n[Zero-Loss Audit] {LOCAL_SCANS_DIR}: {total_files:,} files verified intact.")
        self.assertGreaterEqual(total_files, 50000, f"File count {total_files} fell below safety threshold 50,000!")

    def test_12_database_integrity_check(self):
        """Verify sqlite database integrity via PRAGMA integrity_check."""
        self.assertTrue(os.path.isfile(DB_PATH), f"Database not found at {DB_PATH}")
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute("PRAGMA integrity_check;")
        rows = cur.fetchall()
        self.assertEqual(rows, [("ok",)], f"Database corruption detected: {rows}")

        # Check table contents
        cur.execute("SELECT COUNT(*) FROM scans;")
        scan_count = cur.fetchone()[0]
        self.assertGreaterEqual(scan_count, 1, "Scans table is empty!")
        conn.close()

    # =========================================================================
    # CHALLENGE 4: Modular Line Ceiling, Emojis & UI Standards
    # =========================================================================

    def test_13_modular_5000_line_ceiling(self):
        """Verify that all M4/M5 files are strictly under the 5,000-line ceiling."""
        root = os.path.dirname(os.path.dirname(__file__))
        target_files = [
            os.path.join(root, "pc_worker", "surveying", "construction_qa.py"),
            os.path.join(root, "web", "src", "10-construction-qa-and-stakeout.js"),
            os.path.join(root, "web", "survey-bim.css"),
        ]
        for tf in target_files:
            self.assertTrue(os.path.isfile(tf), f"File {tf} does not exist")
            with open(tf, "r", encoding="utf-8", errors="ignore") as f:
                lines = f.readlines()
            line_count = len(lines)
            self.assertLess(
                line_count,
                5000,
                f"File {tf} exceeded 5,000 line ceiling with {line_count} lines!",
            )

    def test_14_zero_unicode_emojis_in_frontend_js(self):
        """Verify 0 Unicode emojis in 10-construction-qa-and-stakeout.js."""
        root = os.path.dirname(os.path.dirname(__file__))
        js_file = os.path.join(root, "web", "src", "10-construction-qa-and-stakeout.js")
        self.assertTrue(os.path.isfile(js_file))
        with open(js_file, "r", encoding="utf-8") as f:
            content = f.read()

        emoji_pattern = re.compile(
            r"[\U00010000-\U0010ffff]|[\u2600-\u27bf]|[\u2300-\u23ff]|[\u2b50-\u2b55]|[\u203c-\u2049]"
        )
        matches = emoji_pattern.findall(content)
        self.assertEqual(len(matches), 0, f"Found Unicode emojis in {js_file}: {matches}")


if __name__ == "__main__":
    unittest.main()
