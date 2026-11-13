import os
import sys
import math

BASE_DIR = r"c:\Antigravity\GatheringScans"
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from pc_worker.surveying_engine import SurveyingEngine
from pc_worker.priority_queue import ScanQueueDB
from pc_worker.config import DB_PATH

db = ScanQueueDB(DB_PATH)
survey = SurveyingEngine(db)

print("=== ADVERSARIAL STRESS TEST ===")

polys = {
    "empty": [],
    "1_pt": [[304950.0, 2757080.0, 43.0]],
    "2_pts": [[304950.0, 2757080.0, 43.0], [304960.0, 2757090.0, 43.0]],
    "identical_pts": [[304950.0, 2757080.0, 43.0]] * 4,
    "collinear_vertical": [[304950.0, 2757080.0, 40.0], [304950.0, 2757080.0, 41.0], [304950.0, 2757080.0, 42.0]],
}

for name, poly in polys.items():
    try:
        res = survey.calculate_cut_fill_volume({
            "scan_id": "quchi_20261005_merged",
            "base_mode": "best_fit_plane",
            "polygon": poly,
        })
        print(f"Poly [{name}]: status={res.get('status')} slope={res.get('best_fit_plane', {}).get('slope_pct')}")
    except Exception as e:
        print(f"Poly [{name}]: CRASH {type(e).__name__}: {e}")

truck_cases = [
    {"truck_volume_m3": 0.0, "truck_max_tonnes": 0.0},
    {"truck_volume_m3": -10.0, "truck_max_tonnes": -5.0},
    {"truck_volume_m3": 1e6, "truck_max_tonnes": 1e6},
]
for tc in truck_cases:
    try:
        res = survey.calculate_cut_fill_volume({
            "scan_id": "quchi_20261005_merged",
            "base_mode": "best_fit_plane",
            **tc
        })
        print(f"Truck {tc}: loads={res.get('truck_loads_cut')} limit={res.get('truck_limiting_factor')}")
    except Exception as e:
        print(f"Truck {tc}: CRASH {type(e).__name__}: {e}")

factors = [
    {"swell_factor": 0.0},
    {"swell_factor": -0.5},
    {"swell_factor": 100.0},
    {"shrinkage_factor": 0.0},
    {"shrinkage_factor": -0.5},
    {"shrinkage_factor": 100.0},
]
for f in factors:
    try:
        res = survey.calculate_cut_fill_volume({
            "scan_id": "quchi_20261005_merged",
            "base_mode": "best_fit_plane",
            **f
        })
        print(f"Factor {f}: cut_lcm={res.get('cut_volume_lcm')} fill_ccm={res.get('fill_volume_ccm')}")
    except Exception as e:
        print(f"Factor {f}: CRASH {type(e).__name__}: {e}")

# String inputs that could be sent by web clients:
bad_string_inputs = [
    {"geoid_offset_override": ""},
    {"geoid_offset_override": "   "},
    {"geoid_offset_override": "undefined"},
    {"geoid_offset_override": "NaN"},
    {"swell_factor": ""},
    {"shrinkage_factor": ""},
    {"density_t_m3": ""},
    {"truck_volume_m3": ""},
    {"truck_max_tonnes": ""},
]

print("\n--- Testing Bad String Inputs ---")
for inp in bad_string_inputs:
    try:
        res = survey.calculate_cut_fill_volume({
            "scan_id": "quchi_20261005_merged",
            "base_mode": "best_fit_plane",
            **inp
        })
        print(f"Input {inp}: OK (status={res.get('status')})")
    except Exception as e:
        print(f"Input {inp}: CRASH {type(e).__name__}: {e}")

print("=== COMPLETED ADVERSARIAL STRESS TEST ===")
