#!/usr/bin/env python3
"""
Stand-alone Adversarial Test Harness for Milestone 2:
Live HTTP API Endpoint Stress, Downstream Volume Invariance, and Control Calibration.

Target Server: http://127.0.0.1:8095
Endpoints Tested:
  - /api/survey/gcp-qa
  - /api/survey/volume
  - /api/status

Run directly via:
  python c:\\Antigravity\\GatheringScans\\.agents\\teamwork\\challenger_m2_2\\test_m2_live_adversarial.py
"""

import unittest
import urllib.request
import urllib.error
import json
import math
import time

SERVER_URL = "http://127.0.0.1:8095"


def http_post_json(path: str, payload_dict_or_raw, timeout=10):
    url = f"{SERVER_URL}{path}"
    if isinstance(payload_dict_or_raw, (dict, list)):
        data = json.dumps(payload_dict_or_raw).encode("utf-8")
        headers = {"Content-Type": "application/json"}
    elif isinstance(payload_dict_or_raw, (bytes, bytearray)):
        data = payload_dict_or_raw
        headers = {"Content-Type": "application/json"}
    elif isinstance(payload_dict_or_raw, str):
        data = payload_dict_or_raw.encode("utf-8")
        headers = {"Content-Type": "application/json"}
    else:
        data = b"{}"
        headers = {"Content-Type": "application/json"}

    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            code = resp.getcode()
            body = resp.read().decode("utf-8")
            try:
                parsed = json.loads(body)
            except Exception:
                parsed = body
            return code, parsed
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = body
        return e.code, parsed
    except Exception as e:
        return 0, str(e)


def http_get_json(path: str, timeout=10):
    url = f"{SERVER_URL}{path}"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            code = resp.getcode()
            body = resp.read().decode("utf-8")
            return code, json.loads(body)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return e.code, body
    except Exception as e:
        return 0, str(e)


class TestM2LiveAdversarialStress(unittest.TestCase):
    """
    Suite 1: Live HTTP API Endpoint Stress & Adversarial Resilience
    Ensures zero HTTP 500 crashes under empty, malformed, hostile, and boundary inputs.
    """

    SCAN_ID = "quchi_20261005_merged"

    @classmethod
    def setUpClass(cls):
        code, resp = http_get_json("/api/status")
        if code != 200 or not isinstance(resp, dict) or resp.get("status") != "online":
            raise RuntimeError(f"Server at {SERVER_URL} is not online: code={code}, resp={resp}")

    def test_01_empty_payload_with_scan_id(self):
        """Send empty points with valid scan_id - returns HTTP 200 with auto-generated sample points, zero 500 crashes."""
        code, resp = http_post_json("/api/survey/gcp-qa", {"scan_id": self.SCAN_ID})
        self.assertEqual(code, 200, f"Expected 200, got {code}: {resp}")
        self.assertIsInstance(resp, dict)
        self.assertEqual(resp.get("status"), "ok")
        self.assertIn("gcp_residuals", resp)
        self.assertIn("rmse_3d", resp)
        self.assertGreaterEqual(resp.get("point_count"), 6)

    def test_02_completely_empty_payload_missing_scan_id(self):
        """Send empty JSON {} or 0-byte body - must return structured error (HTTP 400 or 404), NEVER crash with HTTP 500."""
        for empty_body in ({}, b"", "   "):
            with self.subTest(empty_body=str(empty_body)):
                code, resp = http_post_json("/api/survey/gcp-qa", empty_body)
                self.assertNotEqual(code, 500, f"Server crashed with HTTP 500 on {empty_body!r}")
                self.assertIn(code, (400, 404), f"Expected 400 or 404, got {code}: {resp}")
                self.assertIsInstance(resp, dict)
                self.assertIn("error", resp)

    def test_03_malformed_json_bytes(self):
        """Send malformed JSON syntax - must return structured HTTP 400 error, never HTTP 500."""
        malformed_cases = [
            b"{not valid json: true",
            b'{"points": [1, 2, 3,',
            b'{"scan_id": "test", "points": [{}',
            b"\x00\x01\x02\xff\xfe",
        ]
        for idx, raw_bytes in enumerate(malformed_cases):
            with self.subTest(case_idx=idx):
                code, resp = http_post_json("/api/survey/gcp-qa", raw_bytes)
                self.assertNotEqual(code, 500, f"Server crashed with HTTP 500 on malformed input {raw_bytes!r}")
                self.assertEqual(code, 400, f"Expected HTTP 400 for malformed JSON, got {code}: {resp}")
                self.assertIsInstance(resp, dict)
                self.assertIn("error", resp)

    def test_04_nonexistent_scan_id(self):
        """Send a completely fictional scan_id - must return structured 404 error, never crash with HTTP 500."""
        code, resp = http_post_json("/api/survey/gcp-qa", {
            "scan_id": "scan_completely_fictional_nonexistent_404_xyz",
            "points": [
                {"name": "CP-1", "e": 304950.0, "n": 2757080.0, "h_gcp": 120.0}
            ]
        })
        self.assertNotEqual(code, 500, f"Server crashed with 500 on nonexistent scan_id")
        self.assertEqual(code, 404, f"Expected 404 for nonexistent scan_id, got {code}: {resp}")
        self.assertIsInstance(resp, dict)
        self.assertIn("error", resp)
        self.assertIn("Scan not found", resp["error"])

    def test_05_hostile_point_types_and_tokens(self):
        """Send hostile tokens (strings, None, booleans, invalid numbers, whitespace) in points array."""
        hostile_payload = {
            "scan_id": self.SCAN_ID,
            "points": [
                None,
                "a string instead of a dict",
                12345,
                {"name": "Bad1_NaN", "e": "NaN", "n": 2757080.0, "h_gcp": 120.0},
                {"name": "Bad2_undefined", "e": 304950.0, "n": "undefined", "h_gcp": 120.0},
                {"name": "Bad3_null", "e": "null", "n": 2757080.0, "h_gcp": 120.0},
                {"name": "Bad4_None", "e": None, "n": None, "h_gcp": None},
                {"name": "Bad5_empty", "e": "", "n": "   ", "h_gcp": ""},
                # One good point
                {"name": "Good1", "e": 304952.4, "n": 2757084.2, "h_gcp": 124.8, "mesh_e": 304952.42, "mesh_n": 2757084.18, "mesh_h": 124.83},
            ]
        }
        code, resp = http_post_json("/api/survey/gcp-qa", hostile_payload)
        self.assertEqual(code, 200, f"Expected 200 for hostile points filtering, got {code}: {resp}")
        self.assertEqual(resp.get("status"), "ok")
        # All invalid Easting/Northing points must be filtered out, Good1 accepted
        self.assertEqual(resp.get("point_count"), 1)
        self.assertEqual(resp["gcp_residuals"][0]["name"], "Good1")

    def test_06_single_point_stdev_guard(self):
        """N=1 point must NOT trigger ZeroDivisionError in sample standard deviation (N-1 = 0)."""
        payload = {
            "scan_id": self.SCAN_ID,
            "points": [
                {"name": "SingleTarget", "e": 304950.0, "n": 2757080.0, "h_gcp": 120.0, "mesh_e": 304950.05, "mesh_n": 2757080.03, "mesh_h": 120.04}
            ]
        }
        code, resp = http_post_json("/api/survey/gcp-qa", payload)
        self.assertEqual(code, 200, f"Expected 200 on N=1, got {code}: {resp}")
        self.assertEqual(resp.get("point_count"), 1)
        self.assertEqual(resp.get("std_de_m"), 0.0)
        self.assertEqual(resp.get("std_dn_m"), 0.0)
        self.assertEqual(resp.get("std_dh_m"), 0.0)

    def test_07_extreme_boundary_coordinates(self):
        """Send extreme floating point coordinates (+-1e8) to verify no math overflow or crash."""
        payload = {
            "scan_id": self.SCAN_ID,
            "points": [
                {"name": "ExtremePos", "e": 1e8, "n": 1e8, "h_gcp": 1e4, "mesh_e": 1e8 + 0.05, "mesh_n": 1e8 - 0.02, "mesh_h": 1e4 + 0.01},
                {"name": "ExtremeNeg", "e": -1e6, "n": -1e6, "h_gcp": -50.0, "mesh_e": -1e6 - 0.04, "mesh_n": -1e6 + 0.03, "mesh_h": -50.02},
            ]
        }
        code, resp = http_post_json("/api/survey/gcp-qa", payload)
        self.assertEqual(code, 200, f"Expected 200 on extreme coords, got {code}: {resp}")
        self.assertEqual(resp.get("point_count"), 2)
        self.assertTrue(math.isfinite(resp.get("rmse_3d")))

    def test_08_empty_points_list_no_sample_generation(self):
        """points: [] with explicit points provided should return point_count: 0 and zero RMSEs, zero crashes."""
        payload = {
            "scan_id": self.SCAN_ID,
            "points": [],
            "generate_sample_points": False,
        }
        code, resp = http_post_json("/api/survey/gcp-qa", payload)
        self.assertEqual(code, 200, f"Expected 200 on empty list, got {code}: {resp}")
        self.assertEqual(resp.get("point_count"), 0)
        self.assertEqual(resp.get("rmse_e"), 0.0)
        self.assertEqual(resp.get("rmse_n"), 0.0)
        self.assertEqual(resp.get("rmse_h"), 0.0)
        self.assertEqual(resp.get("rmse_3d"), 0.0)


class TestM2MathAndResidualInvariants(unittest.TestCase):
    """
    Suite 2: Mathematical Rigor & Mixed Mode Invariants
    Verifies Euclidean vector invariant d3D^2 = dE^2 + dN^2 + dH^2,
    RMSE invariant RMSE_3D^2 = RMSE_2D^2 + RMSE_H^2, and ASPRS 2014 standards.
    """

    SCAN_ID = "quchi_20261005_merged"

    def test_01_mixed_checkpoints_and_paired_targets(self):
        """
        Send mixed check points (only E, N, H) and paired targets (with mesh_e, mesh_n, mesh_h).
        Verify mathematical residual vectors and RMSE composition.
        """
        payload = {
            "scan_id": self.SCAN_ID,
            "points": [
                # Paired target 1
                {"name": "PT-01", "e": 304940.0, "n": 2757070.0, "h_gcp": 122.0, "mesh_e": 304940.03, "mesh_n": 2757069.96, "mesh_h": 122.05},
                # Paired target 2
                {"name": "PT-02", "e": 304960.0, "n": 2757090.0, "h_gcp": 125.0, "mesh_e": 304959.98, "mesh_n": 2757090.04, "mesh_h": 124.97},
                # Check point 1 (no mesh coords - sampled from DSM)
                {"name": "CP-01", "e": 304950.0, "n": 2757080.0, "h_gcp": 123.5},
            ]
        }
        code, resp = http_post_json("/api/survey/gcp-qa", payload)
        self.assertEqual(code, 200)
        self.assertEqual(resp.get("point_count"), 3)

        residuals = resp["gcp_residuals"]
        # Verify PT-01 exact math
        pt1 = residuals[0]
        self.assertAlmostEqual(pt1["de"], 0.03, places=3)
        self.assertAlmostEqual(pt1["dn"], -0.04, places=3)
        self.assertAlmostEqual(pt1["dh"], 0.05, places=3)
        expected_d2d_1 = math.hypot(0.03, -0.04)  # 0.05
        expected_d3d_1 = math.hypot(expected_d2d_1, 0.05)  # sqrt(0.0025 + 0.0025) = ~0.0707
        self.assertAlmostEqual(pt1["d2d"], expected_d2d_1, places=3)
        self.assertAlmostEqual(pt1["d3d"], expected_d3d_1, places=3)

        # Verify CP-01 check point mode has de=0, dn=0, d2d=0
        cp1 = residuals[2]
        self.assertAlmostEqual(cp1["de"], 0.0, places=3)
        self.assertAlmostEqual(cp1["dn"], 0.0, places=3)
        self.assertAlmostEqual(cp1["d2d"], 0.0, places=3)
        self.assertAlmostEqual(cp1["d3d"], abs(cp1["dh"]), places=3)

        # Verify global RMSE geometric invariant: RMSE_3D^2 = RMSE_2D^2 + RMSE_H^2
        rmse_2d = resp["rmse_2d"]
        rmse_h = resp["rmse_h"]
        rmse_3d = resp["rmse_3d"]
        self.assertAlmostEqual(rmse_3d, math.hypot(rmse_2d, rmse_h), places=3)

        # Verify ASPRS 2014 Positional Accuracies
        self.assertAlmostEqual(resp["accuracy_z_95_m"], round(1.9600 * rmse_h, 4), places=3)
        self.assertAlmostEqual(resp["accuracy_r_95_m"], round(1.7308 * rmse_2d, 4), places=3)
        self.assertAlmostEqual(resp["accuracy_3d_95_m"], round(1.6140 * rmse_3d, 4), places=3)

    def test_02_geoid_offset_override_invariance(self):
        """
        Verify that geoid_offset_override shifts the vertical elevations of scan surface
        and propagates to vertical residuals dh by exactly the override value.
        """
        base_payload = {
            "scan_id": self.SCAN_ID,
            "points": [
                {"name": "CP-1", "e": 304950.0, "n": 2757080.0, "h_gcp": 123.0}
            ]
        }
        _, resp_base = http_post_json("/api/survey/gcp-qa", base_payload)
        h_scan_base = resp_base["gcp_residuals"][0]["h_scan"]
        dh_base = resp_base["gcp_residuals"][0]["dh"]

        # Shift by +17.20m (UTM51N geoid offset)
        offset = 17.20
        override_payload = dict(base_payload)
        override_payload["geoid_offset_override"] = offset
        _, resp_offset = http_post_json("/api/survey/gcp-qa", override_payload)
        h_scan_offset = resp_offset["gcp_residuals"][0]["h_scan"]
        dh_offset = resp_offset["gcp_residuals"][0]["dh"]

        self.assertAlmostEqual(h_scan_offset, h_scan_base - offset, places=2)
        self.assertAlmostEqual(dh_offset, dh_base - offset, places=2)


class TestM2TbmCalibrationAndDownstreamPropagation(unittest.TestCase):
    """
    Suite 3: Live TBM Calibration Application & Downstream Invariance
    Tests the 1-Click TBM calibration against the live server, verifies vertical datum shift,
    and empirically confirms downstream cut/fill volume calculation invariance.
    """

    SCAN_ID = "quchi_20261005_merged"

    def setUp(self):
        http_post_json("/api/survey/gcp-qa", {
            "scan_id": self.SCAN_ID,
            "reset_calibration": True
        })

    def tearDown(self):
        http_post_json("/api/survey/gcp-qa", {
            "scan_id": self.SCAN_ID,
            "reset_calibration": True
        })

    def test_01_designated_tbm_calibration_application(self):
        """
        Apply TBM calibration with a designated benchmark point.
        Verify tbm_applied: True and tbm_shift_m == -dh_tbm.
        """
        payload = {
            "scan_id": self.SCAN_ID,
            "apply_tbm_calibration": True,
            "selected_tbm_id": "TBM-BENCHMARK",
            "points": [
                {"name": "TBM-BENCHMARK", "is_tbm": True, "e": 304950.0, "n": 2757080.0, "h_gcp": 125.00, "mesh_e": 304950.0, "mesh_n": 2757080.0, "mesh_h": 125.40},
                {"name": "CP-02", "e": 304960.0, "n": 2757090.0, "h_gcp": 124.00, "mesh_e": 304960.0, "mesh_n": 2757090.0, "mesh_h": 124.35},
            ]
        }
        code, resp = http_post_json("/api/survey/gcp-qa", payload)
        self.assertEqual(code, 200, f"Failed TBM apply: {resp}")
        self.assertTrue(resp.get("tbm_applied"), f"Expected tbm_applied=True, got: {resp}")
        self.assertAlmostEqual(resp.get("tbm_shift_m"), -0.40, places=3)

        # Calibrated residuals in active response must show TBM dh == 0.00
        tbm_res = next(p for p in resp["gcp_residuals"] if p["name"] == "TBM-BENCHMARK")
        self.assertAlmostEqual(tbm_res["dh"], 0.0, places=3)
        self.assertAlmostEqual(tbm_res["h_scan"], 125.00, places=3)

        # CP-02 calibrated dh must be 124.35 - 0.40 - 124.00 = -0.05m
        cp2_res = next(p for p in resp["gcp_residuals"] if p["name"] == "CP-02")
        self.assertAlmostEqual(cp2_res["dh"], -0.05, places=3)

    def test_03_network_mean_tbm_calibration_application(self):
        """
        Apply TBM calibration without designated TBM ID (network mean mode).
        Verify tbm_mode == 'network_mean', shift_m == -mean_dh, and calibrated mean_dh == 0.0.
        """
        payload = {
            "scan_id": self.SCAN_ID,
            "apply_tbm_calibration": True,
            "points": [
                {"name": "P-01", "e": 304950.0, "n": 2757080.0, "h_gcp": 120.00, "mesh_e": 304950.0, "mesh_n": 2757080.0, "mesh_h": 120.20},  # dh = +0.20
                {"name": "P-02", "e": 304960.0, "n": 2757090.0, "h_gcp": 120.00, "mesh_e": 304960.0, "mesh_n": 2757090.0, "mesh_h": 120.40},  # dh = +0.40
            ]
        }
        # Mean dh is (+0.20 + 0.40) / 2 = +0.30m. Proposed shift is -0.30m.
        code, resp = http_post_json("/api/survey/gcp-qa", payload)
        self.assertEqual(code, 200)
        self.assertTrue(resp.get("tbm_applied"))
        self.assertAlmostEqual(resp.get("tbm_shift_m"), -0.30, places=3)
        self.assertEqual(resp["tbm_calibration_preview"]["tbm_mode"], "network_mean")
        self.assertIsNone(resp["tbm_calibration_preview"]["tbm_point_id"])
        # Calibrated residuals must be: P-01 -> -0.10m, P-02 -> +0.10m (mean = 0.00)
        residuals = resp["gcp_residuals"]
        p1 = next(p for p in residuals if p["name"] == "P-01")
        p2 = next(p for p in residuals if p["name"] == "P-02")
        self.assertAlmostEqual(p1["dh"], -0.10, places=3)
        self.assertAlmostEqual(p2["dh"], 0.10, places=3)
        self.assertAlmostEqual(p1["dh"] + p2["dh"], 0.0, places=3)

    def test_02_downstream_cut_fill_volume_datum_invariance(self):
        """
        Empirically verify downstream propagation into /api/survey/volume:
        1. Query volume on uncalibrated scan with custom_plane at datum_z = 120.0m.
        2. Apply TBM calibration with a shift of -0.500m.
        3. Query volume on calibrated scan: surface z_surf must drop by exactly 0.500m,
           causing cut volume to decrease (or fill volume to increase) consistent with datum shift.
        """
        vol_req = {
            "scan_id": self.SCAN_ID,
            "base_mode": "custom_plane",
            "custom_elevation": 120.0,
            "polygon": [
                [304945.0, 2757075.0, 43.1],
                [304955.0, 2757075.0, 43.1],
                [304950.0, 2757085.0, 43.2],
            ],
            "density_t_m3": 1.80,
            "swell_factor": 1.20,
            "shrinkage_factor": 0.90,
            "truck_volume_m3": 15.0,
            "truck_max_tonnes": 24.0,
        }

        # Step 1: Baseline Volume (Uncalibrated)
        code_base, vol_base = http_post_json("/api/survey/volume", vol_req)
        self.assertEqual(code_base, 200, f"Volume baseline failed: {vol_base}")
        self.assertEqual(vol_base.get("status"), "ok")
        self.assertIn("planar_area_m2", vol_base)
        area_m2 = vol_base["planar_area_m2"]
        base_cut = vol_base["cut_volume_bcm"]
        base_fill = vol_base["fill_volume_bcm"]
        base_sample_z = vol_base["heatmap_cells"][0]["z_surf"]
        self.assertEqual(vol_base.get("vertical_datum_applied"), False)
        self.assertAlmostEqual(vol_base.get("vertical_datum_offset", 0.0), 0.0, places=3)

        # Step 2: Apply TBM calibration with shift of -0.500m
        tbm_shift = -0.500
        qa_req = {
            "scan_id": self.SCAN_ID,
            "apply_tbm_calibration": True,
            "selected_tbm_id": "TBM-01",
            "points": [
                {"name": "TBM-01", "is_tbm": True, "e": 304950.0, "n": 2757080.0, "h_gcp": 120.00, "mesh_e": 304950.0, "mesh_n": 2757080.0, "mesh_h": 120.50}
            ]
        }
        code_qa, resp_qa = http_post_json("/api/survey/gcp-qa", qa_req)
        self.assertEqual(code_qa, 200)
        self.assertTrue(resp_qa.get("tbm_applied"))
        self.assertAlmostEqual(resp_qa.get("tbm_shift_m"), tbm_shift, places=3)

        # Step 3: Calibrated Volume
        code_cal, vol_cal = http_post_json("/api/survey/volume", vol_req)
        self.assertEqual(code_cal, 200, f"Volume calibrated call failed: {vol_cal}")
        self.assertEqual(vol_cal.get("status"), "ok")
        self.assertEqual(vol_cal.get("vertical_datum_applied"), True)
        self.assertAlmostEqual(vol_cal.get("vertical_datum_offset"), tbm_shift, places=3)

        cal_sample_z = vol_cal["heatmap_cells"][0]["z_surf"]
        # Surface elevation MUST drop by exactly 0.500m
        self.assertAlmostEqual(cal_sample_z, base_sample_z + tbm_shift, places=2)

        # Verify volume changed
        delta_cut = vol_cal["cut_volume_bcm"] - base_cut
        delta_fill = vol_cal["fill_volume_bcm"] - base_fill
        self.assertTrue(
            abs(delta_cut) > 0.0 or abs(delta_fill) > 0.0,
            "Cut/fill volumes did not change after TBM vertical datum shift!"
        )

        # Step 4: Re-query GCP QA to verify persistence in scan record
        code_verify, resp_verify = http_post_json("/api/survey/gcp-qa", {
            "scan_id": self.SCAN_ID,
            "points": [
                {"name": "TBM-01", "is_tbm": True, "e": 304950.0, "n": 2757080.0, "h_gcp": 120.00, "mesh_e": 304950.0, "mesh_n": 2757080.0, "mesh_h": 120.50}
            ]
        })
        self.assertEqual(code_verify, 200)
        self.assertAlmostEqual(resp_verify["tbm_calibration_preview"]["shift_m"], tbm_shift, places=3)

        # Step 5: Reset calibration and verify volume returns to baseline
        code_rst, _ = http_post_json("/api/survey/gcp-qa", {
            "scan_id": self.SCAN_ID,
            "reset_calibration": True
        })
        self.assertEqual(code_rst, 200)

        code_restored, vol_restored = http_post_json("/api/survey/volume", vol_req)
        self.assertEqual(code_restored, 200)
        self.assertEqual(vol_restored.get("vertical_datum_applied"), False)
        self.assertAlmostEqual(vol_restored.get("vertical_datum_offset", 0.0), 0.0, places=3)
        self.assertAlmostEqual(vol_restored["heatmap_cells"][0]["z_surf"], base_sample_z, places=2)
        self.assertAlmostEqual(vol_restored["cut_volume_bcm"], base_cut, places=2)
        self.assertAlmostEqual(vol_restored["fill_volume_bcm"], base_fill, places=2)


class TestM2ScalingAndLoad(unittest.TestCase):
    """
    Suite 4: Scaling, Concurrency and Load
    Verifies that the live server handles rapid successive calls and large GCP point clouds.
    """

    SCAN_ID = "quchi_20261005_merged"

    def test_01_large_point_cloud_evaluation(self):
        """Send 250 GCP points in one payload - verify sub-second response time and correct aggregation."""
        points = []
        ce, cn, ch = 304952.4, 2757084.2, 124.8
        for i in range(250):
            de = (i % 20 - 10) * 2.0
            dn = (i // 20 - 6) * 2.0
            points.append({
                "name": f"GCP-{i+1:03d}",
                "e": round(ce + de, 3),
                "n": round(cn + dn, 3),
                "h_gcp": round(ch + 0.05 * (i % 5), 3),
                "mesh_e": round(ce + de + 0.01 * (i % 3 - 1), 3),
                "mesh_n": round(cn + dn - 0.01 * (i % 4 - 2), 3),
                "mesh_h": round(ch + 0.05 * (i % 5) + 0.02 * (i % 2 - 1), 3),
            })

        t0 = time.time()
        code, resp = http_post_json("/api/survey/gcp-qa", {
            "scan_id": self.SCAN_ID,
            "points": points,
        })
        elapsed = time.time() - t0

        self.assertEqual(code, 200)
        self.assertEqual(resp.get("point_count"), 250)
        self.assertLess(elapsed, 2.0, f"Evaluating 250 GCPs took too long: {elapsed:.3f}s")
        self.assertTrue(math.isfinite(resp["rmse_3d"]))

    def test_02_sequential_rapid_fire_requests(self):
        """Send 25 rapid fire requests to ensure no socket exhaustion or connection resets."""
        for i in range(25):
            code, resp = http_post_json("/api/survey/gcp-qa", {
                "scan_id": self.SCAN_ID,
                "points": [{"name": f"P-{i}", "e": 304950.0, "n": 2757080.0, "h_gcp": 124.0, "mesh_e": 304950.01, "mesh_n": 2757080.01, "mesh_h": 124.02}]
            })
            self.assertEqual(code, 200, f"Failed on request {i}: {resp}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
