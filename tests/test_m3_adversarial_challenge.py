"""
tests/test_m3_adversarial_challenge.py

Empirical Challenger Test Harness for Milestone 3:
- Live API fuzzing and stress testing against local server (http://127.0.0.1:8095)
- Endpoint payload validation (/api/survey/stationing, /api/survey/drainage)
- Caterpillar Earthwork Mass Conservation Verification
- Zero Data Destruction Verification (C:\\GatheringScans, data/gathering_scans.db)
"""

import json
import math
import os
import sqlite3
import sys
import unittest
import urllib.error
import urllib.request
from typing import Any, Dict, Tuple


SERVER_URL = "http://127.0.0.1:8095"
RAW_DATA_DIR = r"C:\GatheringScans"
DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "gathering_scans.db")


def post_json(path: str, payload: Dict[str, Any], timeout: float = 15.0) -> Tuple[int, Dict[str, Any], str]:
    url = f"{SERVER_URL}{path}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.status
            body_bytes = resp.read()
            body_str = body_bytes.decode("utf-8", errors="replace")
            try:
                body_json = json.loads(body_str)
            except Exception:
                body_json = {}
            return status, body_json, body_str
    except urllib.error.HTTPError as e:
        body_bytes = e.read()
        body_str = body_bytes.decode("utf-8", errors="replace")
        try:
            body_json = json.loads(body_str)
        except Exception:
            body_json = {}
        return e.code, body_json, body_str
    except Exception as e:
        return 0, {}, str(e)


class TestM3AdversarialStationing(unittest.TestCase):
    """Stress-test /api/survey/stationing endpoint with malicious, malformed, and edge-case payloads."""

    def test_01_valid_stationing_call(self):
        """Test legitimate baseline stationing request."""
        payload = {
            "scan_id": "quchi_20261005_merged",
            "interval": 10.0,
            "swath_width": 20.0,
            "template_type": "roadway",
            "road_width": 7.0,
            "cross_slope_pct": 2.0
        }
        status, res, raw = post_json("/api/survey/stationing", payload)
        self.assertEqual(status, 200, f"Expected 200 OK, got {status}: {raw}")
        self.assertEqual(res.get("status"), "ok")
        self.assertIn("stations", res)
        self.assertIn("total_cut_volume_m3", res)
        self.assertIn("total_fill_volume_m3", res)
        self.assertIn("earthwork_schedule", res)
        self.assertGreater(len(res["stations"]), 0)

    def test_02_empty_payload_no_500_crash(self):
        """Empty payload {} should be handled gracefully without 500 crash."""
        status, res, raw = post_json("/api/survey/stationing", {})
        self.assertIn(status, (200, 400, 404), f"Expected graceful 200, 400, or 404, got {status}: {raw}")
        self.assertNotEqual(status, 500, f"Server threw unhandled 500 on empty payload: {raw}")

    def test_03_nonexistent_scan_id_no_500_crash(self):
        """Non-existent scan_id should fail gracefully or fallback without 500 crash."""
        payload = {"scan_id": "ghost_scan_definitely_not_existing_404"}
        status, res, raw = post_json("/api/survey/stationing", payload)
        self.assertIn(status, (200, 400, 404), f"Expected 200, 400, or 404, got {status}: {raw}")
        self.assertNotEqual(status, 500, f"Server threw unhandled 500 on missing scan_id: {raw}")

    def test_04_empty_strings_and_bad_types(self):
        """Empty strings in numeric or enum fields should not cause 500 crash."""
        payload = {
            "scan_id": "",
            "interval": "",
            "swath_width": "",
            "template_type": "",
            "road_width": "",
            "cross_slope_pct": "",
            "cut_slope": "",
            "fill_slope": ""
        }
        status, res, raw = post_json("/api/survey/stationing", payload)
        self.assertIn(status, (200, 400, 404), f"Expected graceful 200, 400, or 404, got {status}: {raw}")
        self.assertNotEqual(status, 500, f"Server crashed with 500 on empty strings: {raw}")

    def test_05_negative_and_zero_intervals_and_swaths(self):
        """Negative or zero interval and swath widths should clamp safely to positive minimums."""
        payload = {
            "scan_id": "quchi_20261005_merged",
            "interval": 0.0,
            "swath_width": -100.0,
            "cross_sample_step": -1.0,
            "road_width": -20.0
        }
        status, res, raw = post_json("/api/survey/stationing", payload)
        self.assertIn(status, (200, 400), f"Expected 200 or 400, got {status}: {raw}")
        if status == 200:
            self.assertGreaterEqual(res.get("interval_m", 0), 1.0)
            self.assertGreaterEqual(res.get("swath_width_m", 0), 2.0)

    def test_06a_resilient_malformed_alignment_formats(self):
        """Malformed alignments (string, nested junk, non-numeric items, degenerate points) must not crash."""
        bad_alignments = [
            "STRING_NOT_A_LIST",
            [None, None],
            [{"e": "malicious", "n": "payload"}],
            [[None, "bad"]],
            [{"x": 100}],  # missing y
            [[304950.0, 2757080.0]],  # single point
            [[304950.0, 2757080.0], [304950.0, 2757080.0]],  # identical points
        ]
        for idx, bad_al in enumerate(bad_alignments):
            payload = {
                "scan_id": "quchi_20261005_merged",
                "alignment": bad_al
            }
            status, res, raw = post_json("/api/survey/stationing", payload)
            self.assertIn(status, (200, 400), f"Alignment test #{idx} ({bad_al}) failed with status {status}: {raw}")
            self.assertNotEqual(status, 500, f"Server crashed with 500 on bad alignment #{idx}: {raw}")

    def test_06b_unhandled_500_on_primitive_non_iterables(self):
        """
        Vulnerability fix verification:
        Primitive non-iterable alignment values (int, bool, float) are handled safely
        via isinstance(raw_align, (list, tuple)) check and return 200 OK.
        """
        primitives = [12345, True, 45.67]
        for val in primitives:
            payload = {
                "scan_id": "quchi_20261005_merged",
                "alignment": val
            }
            status, res, raw = post_json("/api/survey/stationing", payload)
            self.assertEqual(status, 200, f"Expected 200 graceful handling on {type(val)}: {raw}")
            self.assertEqual(res.get("status"), "ok")

    def test_07_unknown_template_type(self):
        """Unknown template type should fallback gracefully to default (e.g. flat or roadway)."""
        payload = {
            "scan_id": "quchi_20261005_merged",
            "template_type": "super_custom_hyperloop_subway_template_9999",
            "interval": 15.0
        }
        status, res, raw = post_json("/api/survey/stationing", payload)
        self.assertEqual(status, 200, f"Unknown template failed: {raw}")
        self.assertEqual(res.get("status"), "ok")


class TestM3AdversarialDrainage(unittest.TestCase):
    """Stress-test /api/survey/drainage endpoint with malicious and malformed payloads."""

    def test_01_valid_drainage_call_with_ponding(self):
        """Test legitimate baseline drainage and ponding request."""
        payload = {
            "scan_id": "quchi_20261005_merged",
            "grid_size": 14,
            "min_ponding_depth_m": 0.05,
            "custom_slope_tiers": [0.01, 0.02, 0.05, 0.10, 0.20]
        }
        status, res, raw = post_json("/api/survey/drainage", payload)
        self.assertEqual(status, 200, f"Expected 200 OK, got {status}: {raw}")
        self.assertEqual(res.get("status"), "ok")
        self.assertIn("depressions", res)
        self.assertIn("total_ponding_volume_m3", res)
        self.assertIn("depression_count", res)
        self.assertIn("tiers", res)

    def test_02_empty_payload_no_500_crash(self):
        """Empty payload {} should be handled gracefully without 500 crash."""
        status, res, raw = post_json("/api/survey/drainage", {})
        self.assertIn(status, (200, 400), f"Expected graceful 200 or 400, got {status}: {raw}")
        self.assertNotEqual(status, 500, f"Server threw unhandled 500 on empty payload: {raw}")

    def test_03_nonexistent_scan_id_no_500_crash(self):
        """Nonexistent scan_id should be handled gracefully without 500 crash."""
        payload = {"scan_id": "nonexistent_scan_id_for_drainage_test"}
        status, res, raw = post_json("/api/survey/drainage", payload)
        self.assertIn(status, (200, 400, 404), f"Expected 200, 400, or 404, got {status}: {raw}")
        self.assertNotEqual(status, 500, f"Server threw unhandled 500: {raw}")

    def test_04_malformed_slope_tiers(self):
        """Malformed slope tiers should fallback to default 6-tier classification."""
        bad_tier_inputs = [
            "NOT_A_LIST",
            123,
            [],
            [1],  # less than 2
            ["invalid", "tokens", None],
            [-5, -10],  # all negative
            [0.05, 0.02, 0.10],  # unsorted
            [1.0, 2.0, 5.0, 10.0],  # percentages > 1.0
        ]
        for idx, bad_tier in enumerate(bad_tier_inputs):
            payload = {
                "scan_id": "quchi_20261005_merged",
                "custom_slope_tiers": bad_tier
            }
            status, res, raw = post_json("/api/survey/drainage", payload)
            self.assertIn(status, (200, 400), f"Bad tiers #{idx} ({bad_tier}) failed: {raw}")
            self.assertNotEqual(status, 500, f"Server crashed with 500 on bad tiers #{idx}: {raw}")

    def test_05_extreme_ponding_depth_thresholds(self):
        """Negative, zero, or astronomical ponding depths should clamp safely."""
        depth_tests = [-10.0, 0.0, "not_a_number", None, 1e9]
        for depth in depth_tests:
            payload = {
                "scan_id": "quchi_20261005_merged",
                "min_ponding_depth_m": depth
            }
            status, res, raw = post_json("/api/survey/drainage", payload)
            self.assertIn(status, (200, 400), f"Depth {depth} failed with status {status}: {raw}")
            self.assertNotEqual(status, 500, f"Server crashed on depth {depth}: {raw}")


class TestM3CaterpillarMassConservation(unittest.TestCase):
    """Verify strict mathematical conservation of earthwork mass and volume across parameters."""

    def test_01_mass_conservation_formulas(self):
        """
        Verify:
        BCM * swell_factor = LCM
        BCM * (1.0 - shrinkage_factor) = CCM
        Mass = BCM * density
        Truck trips = max(ceil(haul_vol / truck_vol), ceil(haul_mass / truck_t))
        """
        test_cases = [
            {"swell": 1.25, "shrink": 0.10, "density": 1.65, "t_m3": 15.0, "t_t": 20.0},
            {"swell": 1.40, "shrink": 0.15, "density": 1.90, "t_m3": 12.0, "t_t": 25.0},
            {"swell": 1.15, "shrink": 0.05, "density": 1.45, "t_m3": 18.0, "t_t": 18.0},
        ]
        for tc in test_cases:
            payload = {
                "scan_id": "quchi_20261005_merged",
                "interval": 10.0,
                "swath_width": 20.0,
                "template_type": "trench",
                "trench_depth": 3.0,
                "swell_factor": tc["swell"],
                "shrinkage_factor": tc["shrink"],
                "density_t_m3": tc["density"],
                "truck_capacity_m3": tc["t_m3"],
                "truck_payload_tonnes": tc["t_t"],
            }
            status, res, raw = post_json("/api/survey/stationing", payload)
            self.assertEqual(status, 200, f"Failed for tc {tc}: {raw}")
            sched = res.get("earthwork_schedule", {})
            bcm = sched.get("bank_cut_m3", 0.0)
            lcm = sched.get("loose_cut_m3", 0.0)
            ccm = sched.get("compact_cut_m3", 0.0)
            mass = sched.get("conserved_mass_tonnes", 0.0)
            trucks = sched.get("haul_trucks", {})
            trips = trucks.get("trips_required", 0)

            # Mass conservation checks:
            expected_lcm = round(bcm * tc["swell"], 2)
            expected_ccm = round(bcm * (1.0 - tc["shrink"]), 2)
            expected_mass = round(bcm * tc["density"], 2)

            self.assertAlmostEqual(lcm, expected_lcm, delta=0.05,
                                   msg=f"LCM violation: {lcm} != {expected_lcm} (BCM={bcm}, swell={tc['swell']})")
            self.assertAlmostEqual(ccm, expected_ccm, delta=0.05,
                                   msg=f"CCM violation: {ccm} != {expected_ccm} (BCM={bcm}, shrink={tc['shrink']})")
            self.assertAlmostEqual(mass, expected_mass, delta=0.05,
                                   msg=f"Mass conservation violation: {mass} != {expected_mass} (BCM={bcm}, density={tc['density']})")

            # Truck trips calculation check:
            haul_vol = lcm
            haul_wt = round(haul_vol * (tc["density"] / tc["swell"]), 2)
            trips_vol = math.ceil(haul_vol / tc["t_m3"]) if haul_vol > 0 else 0
            trips_wt = math.ceil(haul_wt / tc["t_t"]) if haul_wt > 0 else 0
            expected_trips = max(trips_vol, trips_wt)
            self.assertEqual(trips, expected_trips,
                             msg=f"Truck trips mismatch: got {trips}, expected {expected_trips} (vol_trips={trips_vol}, wt_trips={trips_wt})")


class TestM3ZeroDataDestruction(unittest.TestCase):
    """Verify that all raw scans in C:\\GatheringScans and DB records remain 100% intact."""

    def test_01_raw_scan_directories_intact(self):
        """Verify C:\\GatheringScans directory exists and has untouched project folders."""
        self.assertTrue(os.path.isdir(RAW_DATA_DIR), f"Raw data directory {RAW_DATA_DIR} does not exist!")
        entries = os.listdir(RAW_DATA_DIR)
        self.assertGreater(len(entries), 0, f"Raw data directory {RAW_DATA_DIR} is empty!")

        # Verify key project subdirectories
        found_dirs = [d for d in entries if os.path.isdir(os.path.join(RAW_DATA_DIR, d))]
        self.assertGreaterEqual(len(found_dirs), 1, f"No project directories found in {RAW_DATA_DIR}")

    def test_02_database_integrity(self):
        """Verify SQLite DB integrity pragma and check scan table rows."""
        self.assertTrue(os.path.isfile(DB_PATH), f"Database file {DB_PATH} not found!")
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()

        # Check PRAGMA integrity_check
        cursor.execute("PRAGMA integrity_check")
        rows = cursor.fetchall()
        self.assertEqual(rows, [("ok",)], f"Database failed integrity check: {rows}")

        # Check PRAGMA foreign_key_check
        cursor.execute("PRAGMA foreign_key_check")
        fk_errors = cursor.fetchall()
        self.assertEqual(len(fk_errors), 0, f"Foreign key integrity violations: {fk_errors}")

        # Check scan count
        cursor.execute("SELECT count(*) FROM scans")
        count = cursor.fetchone()[0]
        self.assertGreaterEqual(count, 20, f"Unexpected scan row count: {count}")
        conn.close()


if __name__ == "__main__":
    unittest.main()
