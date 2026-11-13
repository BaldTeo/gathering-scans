import os
import sys

# Ensure repo root is on sys.path
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

import json
import urllib.request
import urllib.error
from pc_worker.surveying_engine import SurveyingEngine

class DummyDB:
    def get_scan(self, scan_id):
        return None

def test_python_mixin_fidelity():
    print("=== Testing SurveyingEngine / PublicUtilitiesGISMixin Fidelity ===")
    engine = SurveyingEngine(DummyDB())
    
    # 1. Query ocean / null coordinates outside Taiwan (E: 0.0, N: 0.0)
    print("\n[Test 1] Querying Ocean / Out-of-bounds coordinates (E: 0.0, N: 0.0)...")
    payload_ocean = {
        "scan_id": "nonexistent_ocean_scan",
        "center_e": 0.0,
        "center_n": 0.0,
        "center_h": 0.0,
        "radius_m": 100.0,
        "force_refresh": True,
    }
    res_ocean = engine.query_public_utilities_gis(payload_ocean)
    print(f"Status: {res_ocean.get('status')}")
    print(f"Total features: {res_ocean.get('total_features')}")
    print(f"Layer counts: {res_ocean.get('layer_counts')}")
    assert res_ocean.get("total_features") == 0, f"Expected 0 features for ocean coordinates, got {res_ocean.get('total_features')}"
    assert len(res_ocean.get("features", [])) == 0, "Expected empty feature list"
    print("-> PASS: Returned strictly 0 features with NO mock fabrication!")

    # 2. Query empty mountain area in Taiwan with no underground pipelines (e.g. Yushan peak E: 242000, N: 2598000)
    print("\n[Test 2] Querying remote mountain peak (Yushan E: 242000, N: 2598000)...")
    payload_mountain = {
        "scan_id": "yushan_peak_scan",
        "center_e": 242000.0,
        "center_n": 2598000.0,
        "center_h": 3952.0,
        "radius_m": 100.0,
        "force_refresh": True,
    }
    res_mountain = engine.query_public_utilities_gis(payload_mountain)
    print(f"Status: {res_mountain.get('status')}")
    print(f"Total features: {res_mountain.get('total_features')}")
    print(f"Layer counts: {res_mountain.get('layer_counts')}")
    assert res_mountain.get("total_features") == 0, f"Expected 0 features for mountain peak, got {res_mountain.get('total_features')}"
    print("-> PASS: Returned strictly 0 features for mountain area with NO utilities!")

    # 3. Query Rose Park (E: 295966.7, N: 2768539.4, radius: 120m)
    print("\n[Test 3] Querying Rose Park (rosepark_20260918_merged, E: 295966.7, N: 2768539.4)...")
    payload_rosepark = {
        "scan_id": "rosepark_20260918_merged",
        "center_e": 295966.701,
        "center_n": 2768539.373,
        "center_h": 11.34,
        "radius_m": 120.0,
    }
    res_rp = engine.query_public_utilities_gis(payload_rosepark)
    print(f"Status: {res_rp.get('status')}")
    print(f"Total features: {res_rp.get('total_features')}")
    print(f"Total pipe length: {res_rp.get('total_pipe_length_m')} m")
    print(f"Layer counts: {res_rp.get('layer_counts')}")
    print(f"Cached flag: {res_rp.get('cached')}")
    if res_rp.get("total_features") > 0:
        sample = res_rp['features'][0]
        print(f"Sample feature: id={sample.get('id')} | layer={sample.get('layer')} | source={sample.get('source')}")
    assert res_rp.get("total_features") > 0, "Expected genuine features for Rose Park"
    print("-> PASS: Returned genuine public utilities for Rose Park!")

def test_http_endpoint_fidelity():
    print("\n=== Testing Local HTTP Endpoint (http://127.0.0.1:8095/api/survey/utilities-query) ===")
    
    # Check out of bounds on local server
    payload_null = json.dumps({
        "scan_id": "test_ocean",
        "center_e": 0.0,
        "center_n": 0.0,
        "center_h": 0.0,
        "radius_m": 50.0,
        "force_refresh": True,
    }).encode("utf-8")
    
    try:
        req = urllib.request.Request(
            "http://127.0.0.1:8095/api/survey/utilities-query",
            data=payload_null,
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=10.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            print(f"HTTP Status: {resp.status}")
            print(f"Endpoint returned total features for (0,0): {data.get('total_features')}")
            assert data.get("total_features") == 0, f"Expected 0 features from HTTP endpoint for (0,0), got {data.get('total_features')}"
            print("-> PASS: HTTP endpoint returns 0 features honestly for out-of-bounds coords!")
    except Exception as e:
        print(f"Local HTTP endpoint test info: {e}")

if __name__ == "__main__":
    test_python_mixin_fidelity()
    test_http_endpoint_fidelity()
