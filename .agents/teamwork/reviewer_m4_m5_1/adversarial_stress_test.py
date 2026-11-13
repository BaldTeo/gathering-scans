import os
import sys
import math
import numpy as np
import unittest

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from pc_worker.surveying.construction_qa import ConstructionQAMixin

class MockSurveyingEngine(ConstructionQAMixin):
    def __init__(self):
        self.db = None
    def _resolve_scan_record(self, scan_id):
        return {
            "scan_id": scan_id,
            "twd97_e": 300000.0,
            "twd97_n": 2700000.0,
            "twd97_h": 100.0,
        }
    def _load_or_build_scan_dsm(self, scan):
        return None

def run_adversarial_tests():
    engine = MockSurveyingEngine()
    results = []

    print("=================================================================")
    print("REVIEWER ADVERSARIAL STRESS TEST SUITE: M4 & M5 CONSTRUCTION QA")
    print("=================================================================")

    # Test 1: Zero deviation horizontal slab (division by zero guard in ASTM E1155)
    try:
        payload = {
            "scan_id": "test_adv_01",
            "reference_mode": "horizontal",
            "reference_elevation": 100.0,
            "points": [
                {"e": 300000.0, "n": 2700000.0, "h": 100.0},
                {"e": 300010.0, "n": 2700000.0, "h": 100.0},
                {"e": 300010.0, "n": 2700010.0, "h": 100.0},
                {"e": 300000.0, "n": 2700010.0, "h": 100.0},
            ]
        }
        res = engine.compute_surface_flatness_and_plumbness(payload)
        assert res["status"] == "ok"
        assert res["rms_dev_mm"] == 0.0
        assert res["pass_rate_pct"] == 100.0
        assert res["astm_e1155"]["ff_flatness"] == 115.0  # 115 / max(1.0, 0.0)
        assert res["astm_e1155"]["fl_levelness"] == 90.0
        results.append(("ASTM E1155 Zero-Deviation Division Guard", "PASS", "Safe handling of perfect flat slab"))
    except Exception as e:
        results.append(("ASTM E1155 Zero-Deviation Division Guard", "FAIL", str(e)))

    # Test 2: Perfect vertical wall (zero tilt angle division by zero guard)
    try:
        payload = {
            "scan_id": "test_adv_02",
            "reference_mode": "vertical",
            "wall_line": [{"e": 300000.0, "n": 2700000.0}, {"e": 300000.0, "n": 2700010.0}],
            "points": [
                {"e": 300000.0, "n": 2700000.0, "h": 100.0},
                {"e": 300000.0, "n": 2700010.0, "h": 100.0},
                {"e": 300000.0, "n": 2700000.0, "h": 105.0},
                {"e": 300000.0, "n": 2700010.0, "h": 105.0},
            ]
        }
        res = engine.compute_surface_flatness_and_plumbness(payload)
        assert res["status"] == "ok"
        assert res["plumb_tilt"]["tilt_angle_deg"] == 0.0
        assert res["plumb_tilt"]["plumb_mm_per_m"] == 0.0
        assert res["plumb_tilt"]["tilt_ratio_num"] == 999999.0
        assert "> 1:100,000" in res["plumb_tilt"]["tilt_ratio"]
        results.append(("Perfect Vertical Wall (Zero Tilt Guard)", "PASS", "Safe handling of perfect vertical wall without div/0"))
    except Exception as e:
        results.append(("Perfect Vertical Wall (Zero Tilt Guard)", "FAIL", str(e)))

    # Test 3: Horizontal slab evaluated under vertical mode (extreme 90-deg tilt)
    try:
        payload = {
            "scan_id": "test_adv_03",
            "reference_mode": "vertical",
            "points": [
                {"e": 300000.0, "n": 2700000.0, "h": 100.0},
                {"e": 300010.0, "n": 2700000.0, "h": 100.0},
                {"e": 300010.0, "n": 2700010.0, "h": 100.0},
                {"e": 300000.0, "n": 2700010.0, "h": 100.0},
            ]
        }
        res = engine.compute_surface_flatness_and_plumbness(payload)
        assert res["status"] == "ok"
        assert res["plumb_tilt"]["tilt_angle_deg"] == 90.0
        results.append(("Extreme 90-degree Out-Of-Plumb Lean", "PASS", "Handled 90-degree tilt gracefully without math domain error"))
    except Exception as e:
        results.append(("Extreme 90-degree Out-Of-Plumb Lean", "FAIL", str(e)))

    # Test 4: Degenerate wall line (p1 == p2)
    try:
        payload = {
            "scan_id": "test_adv_04",
            "reference_mode": "vertical",
            "wall_line": [{"e": 300000.0, "n": 2700000.0}, {"e": 300000.0, "n": 2700000.0}],
            "points": [
                {"e": 300000.0, "n": 2700000.0, "h": 100.0},
                {"e": 300000.0, "n": 2700010.0, "h": 100.0},
                {"e": 300000.0, "n": 2700000.0, "h": 105.0},
            ]
        }
        res = engine.compute_surface_flatness_and_plumbness(payload)
        assert res["status"] == "ok"
        results.append(("Degenerate Wall Baseline (p1 == p2)", "PASS", "Falls back to 2D PCA without zero-length line division"))
    except Exception as e:
        results.append(("Degenerate Wall Baseline (p1 == p2)", "FAIL", str(e)))

    # Test 5: Open-trench tracer with duplicate points (dx == 0)
    try:
        payload = {
            "scan_id": "test_adv_05",
            "pipe_type": "DRAIN",
            "pipe_diameter_mm": 400.0,
            "min_cover_m": 1.5,
            "trench_points": [
                {"e": 300000.0, "n": 2700000.0, "h": 98.0, "name": "P1"},
                {"e": 300000.0, "n": 2700000.0, "h": 98.0, "name": "P1_DUPE"},
                {"e": 300050.0, "n": 2700000.0, "h": 97.0, "name": "P2"},
            ]
        }
        res = engine.trace_open_trench_utility(payload)
        assert res["status"] == "ok"
        assert res["stations"][0]["seg_dist_2d"] == 0.0
        assert res["stations"][0]["slope_pct"] == 0.0
        assert res["stations"][1]["seg_dist_2d"] == 0.0
        assert res["stations"][1]["slope_pct"] == -2.0
        results.append(("Open-Trench Utility Duplicate Points (dx == 0)", "PASS", "Safe handling of co-located points without division by zero"))
    except Exception as e:
        results.append(("Open-Trench Utility Duplicate Points (dx == 0)", "FAIL", str(e)))

    # Test 6: Open-trench uphill backfall (reverse flow)
    try:
        payload = {
            "scan_id": "test_adv_06",
            "pipe_type": "SEWER",
            "trench_points": [
                {"e": 300000.0, "n": 2700000.0, "h": 95.0, "name": "MH-01"},
                {"e": 300020.0, "n": 2700000.0, "h": 96.0, "name": "MH-02"},
            ]
        }
        res = engine.trace_open_trench_utility(payload)
        assert res["status"] == "ok"
        assert res["stations"][0]["flow_dir"] == "Reverse"
        assert res["stations"][0]["slope_pct"] == 5.0
        results.append(("Open-Trench Reverse Flow Detection", "PASS", "Accurately flagged adverse slope (backfall) as Reverse flow"))
    except Exception as e:
        results.append(("Open-Trench Reverse Flow Detection", "FAIL", str(e)))

    # Test 7: Multi-Epoch Compare Volume with zero elevation difference (balanced site)
    try:
        payload = {
            "baseline_scan_id": "ep1",
            "compare_scan_id": "ep2",
            "polygon": [
                (300000.0, 2700000.0),
                (300020.0, 2700000.0),
                (300020.0, 2700020.0),
                (300000.0, 2700020.0),
            ],
            "truck_capacity_m3": 0.0,  # Boundary test: zero capacity
            "truck_payload_tonnes": 0.0, # Boundary test: zero payload
            "shrink_factor": 1.0, # Boundary test: extreme shrink
        }
        res = engine.compute_compare_volume_takeoff(payload)
        assert res["status"] == "ok"
        assert res["material_parameters"]["truck_capacity_m3"] >= 1.0  # Clamped to min 1.0
        assert res["material_parameters"]["shrink_factor"] <= 0.6  # Clamped to max 0.6
        results.append(("Compare Volume Zero Truck / Extreme Shrink Boundary", "PASS", "Clamped invalid engineering parameters and avoided div/0"))
    except Exception as e:
        results.append(("Compare Volume Zero Truck / Extreme Shrink Boundary", "FAIL", str(e)))

    # Test 8: RTK Stakeout Export strictly in E, N, Z order verification
    try:
        payload = {
            "scan_id": "test_adv_08",
            "project_name": "Test Site",
            "points": [
                {"id": "PT1", "e": 123456.789, "n": 987654.321, "z": 55.443, "code": "BENCHMARK"},
            ]
        }
        res = engine.generate_stakeout_export(payload)
        csv_body = [line for line in res["csv_export"].splitlines() if not line.startswith("#")][1]
        fields = csv_body.split(",")
        assert fields[0] == "PT1"
        assert fields[1] == "123456.789", f"Expected Easting 123456.789 in pos 1, got {fields[1]}"
        assert fields[2] == "987654.321", f"Expected Northing 987654.321 in pos 2, got {fields[2]}"
        assert fields[3] == "55.443", f"Expected Elevation 55.443 in pos 3, got {fields[3]}"
        assert fields[4] == "BENCHMARK"

        # Check TXT
        txt_line = [l for l in res["txt_export"].splitlines() if not l.startswith("#")][0]
        t_parts = txt_line.split()
        assert t_parts[1] == "123456.789"
        assert t_parts[2] == "987654.321"
        assert t_parts[3] == "55.443"

        # Check DXF
        dxf = res["dxf_export"]
        assert "10\n123456.789\n20\n987654.321\n30\n55.443" in dxf

        results.append(("RTK Stakeout Coordinate Axis Inversion Guard (E, N, Z)", "PASS", "Confirmed strict Easting, Northing, Elevation ordering in all formats"))
    except Exception as e:
        results.append(("RTK Stakeout Coordinate Axis Inversion Guard (E, N, Z)", "FAIL", str(e)))

    # Print summary
    print("\nAdversarial Stress Test Summary:")
    all_pass = True
    for name, status, detail in results:
        flag = "[PASS]" if status == "PASS" else "[FAIL]"
        print(f"  {flag} {name}: {detail}")
        if status != "PASS":
            all_pass = False

    if all_pass:
        print("\nALL 8 ADVERSARIAL STRESS TESTS PASSED WITH ZERO CRASHES OR VIOLATIONS.")
    else:
        print("\nSOME ADVERSARIAL STRESS TESTS FAILED!")

if __name__ == '__main__':
    run_adversarial_tests()
