import numpy as np
import math
from pc_worker.surveying_engine import SurveyingEngine

print("=== FORENSIC MUTATION SENSITIVITY AUDIT ===")

from pc_worker.server_cloud_and_tunnel import DB

survey = SurveyingEngine(DB)

# -------------------------------------------------------------
# Test 1: Priority-Flood Hydrological Reconstruction Validation
# -------------------------------------------------------------

# 50x50 grid at 1.0m resolution
grid = np.full((50, 50), 10.0, dtype=float)
# Carve a known cone depression: radius 8m, max depth 2.0m at center (25, 25)
for r in range(15, 36):
    for c in range(15, 36):
        dist = math.hypot(r - 25, c - 25)
        if dist < 8.0:
            grid[r, c] = 10.0 - (8.0 - dist) * 0.25 # Center elevation = 8.0, spill = 10.0

mask = np.ones((50, 50), dtype=bool)

# Analytical cone volume = (1/3) * pi * R^2 * H = (1/3) * pi * 64 * 2 = 134.04 m3
dep_05 = survey._compute_surface_depressions_priority_flood(
    grid, mask, e_min=0, n_min=0, e_max=50, n_max=50, ce=25, cn=25, ch=10, min_depth_m=0.05
)
dep_50 = survey._compute_surface_depressions_priority_flood(
    grid, mask, e_min=0, n_min=0, e_max=50, n_max=50, ce=25, cn=25, ch=10, min_depth_m=0.50
)
dep_300 = survey._compute_surface_depressions_priority_flood(
    grid, mask, e_min=0, n_min=0, e_max=50, n_max=50, ce=25, cn=25, ch=10, min_depth_m=3.00
)

print(f"1. Priority-Flood Results:")
print(f"   min_depth=0.05m -> Count: {len(dep_05)}, Volume: {dep_05[0]['volume_m3']} m3, MaxDepth: {dep_05[0]['max_depth_m']} m, Spill: {dep_05[0]['spill_elevation_m']} m")
print(f"   min_depth=0.50m -> Count: {len(dep_50)}, Volume: {dep_50[0]['volume_m3']} m3, MaxDepth: {dep_50[0]['max_depth_m']} m")
print(f"   min_depth=3.00m -> Count: {len(dep_300)}")

assert len(dep_05) == 1, "Expected exactly 1 depression for cone basin"
assert len(dep_300) == 0, "Expected 0 depressions when threshold exceeds max depth"
assert abs(dep_05[0]["max_depth_m"] - 2.0) < 0.05, f"Expected ~2.0m max depth, got {dep_05[0]['max_depth_m']}"
assert abs(dep_05[0]["spill_elevation_m"] - 10.0) < 0.01, f"Expected 10.0m spill elevation, got {dep_05[0]['spill_elevation_m']}"
vol_cone = dep_05[0]["volume_m3"]
assert 120.0 < vol_cone < 150.0, f"Discretized cone volume {vol_cone} outside expected range [120, 150]"
print("   [PASS] Priority-Flood correctly computes pour spill points, depth map, and continuous volume integration.")

# -------------------------------------------------------------
# Test 2: Centerline Stationing & AEA Volume Quadrature
# -------------------------------------------------------------

scan_id = "edited_qihu_unified_merged_scan_4_scans__edited_372953"

# Baseline payload
base_payload = {
    "scan_id": scan_id,
    "alignment": [
        {"x": -20.0, "z": -15.0},
        {"x": 0.0, "z": 0.0},
        {"x": 20.0, "z": 15.0}
    ],
    "interval": 10.0,
    "swath_width": 14.0,
    "template_type": "roadway",
    "road_width": 6.0,
    "cross_slope_pct": 2.0
}

res_base = survey.compute_centerline_stationing_and_volume(base_payload)
print("\n2. Stationing Baseline (Interval=10m, Swath=14m, Roadway 6m):")
print(f"   Total Len: {res_base['total_length_m']}m, Station Count: {res_base['station_count']}")
print(f"   Cut Vol: {res_base['total_cut_volume_m3']} m3, Fill Vol: {res_base['total_fill_volume_m3']} m3, Net: {res_base['net_volume_m3']} m3")

# Mutation A: Halve interval to 5m (should increase station count)
mut_a_payload = dict(base_payload, interval=5.0)
res_mut_a = survey.compute_centerline_stationing_and_volume(mut_a_payload)
print(f"   Mutation A (Interval=5m) -> Station Count: {res_mut_a['station_count']} (vs base {res_base['station_count']})")
assert res_mut_a["station_count"] > res_base["station_count"] * 1.5, "Interval mutation did not scale station count"

# Mutation B: Increase road prism width from 6m to 12m (widens template formation bed)
mut_b_payload = dict(base_payload, road_width=12.0, swath_width=24.0)
res_mut_b = survey.compute_centerline_stationing_and_volume(mut_b_payload)
print(f"   Mutation B (Road Width=12m) -> Cut: {res_mut_b['total_cut_volume_m3']} m3 (vs base {res_base['total_cut_volume_m3']} m3)")
assert res_mut_b["total_cut_volume_m3"] > res_base["total_cut_volume_m3"] * 1.3, "Road width mutation did not scale volume"

# Mutation C: Switch template to trench with depth 3m
mut_c_payload = dict(base_payload, template_type="trench", trench_depth=3.0, bottom_width=2.0)
res_mut_c = survey.compute_centerline_stationing_and_volume(mut_c_payload)
print(f"   Mutation C (Trench depth=3m) -> Cut: {res_mut_c['total_cut_volume_m3']} m3, Fill: {res_mut_c['total_fill_volume_m3']} m3")
assert res_mut_c["total_cut_volume_m3"] > res_base["total_cut_volume_m3"], "Trench template did not increase cut volume"

# Mutation D: Translate alignment coordinates +10m East
mut_d_payload = dict(base_payload, alignment=[
    {"x": -10.0, "z": -15.0},
    {"x": 10.0, "z": 0.0},
    {"x": 30.0, "z": 15.0}
])
res_mut_d = survey.compute_centerline_stationing_and_volume(mut_d_payload)
print(f"   Mutation D (Translate +10m) -> Easting 1st station: {res_mut_d['stations'][0]['easting_m']} vs base {res_base['stations'][0]['easting_m']}")
assert abs(res_mut_d["stations"][0]["easting_m"] - (res_base["stations"][0]["easting_m"] + 10.0)) < 0.1, "Alignment translation not reflected in station coordinates"

print("   [PASS] All alignment and template mutations altered outputs deterministically and physically.")
print("\n=== ALL MUTATION SENSITIVITY CHECKS PASSED ===")
