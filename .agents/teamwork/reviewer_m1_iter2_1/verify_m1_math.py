#!/usr/bin/env python3
import math
import sys
import os

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from pc_worker.priority_queue import ScanQueueDB
from pc_worker.config import DB_PATH
from pc_worker.surveying_engine import SurveyingEngine

db = ScanQueueDB(DB_PATH)
survey = SurveyingEngine(db)

print("=== 1. Collinear Alignments at Arbitrary Azimuths (100m long) ===")
angles = [0.0, 15.0, 30.0, 35.0, 45.0, 60.0, 89.0, 90.0, 120.0, 135.0, 180.0, 225.0, 270.0, 315.0]
collinear_failures = []
for angle_deg in angles:
    rad = math.radians(angle_deg)
    dx, dy = math.cos(rad), math.sin(rad)
    pts = [
        [304900.0 + (k / 9.0 - 0.5) * 100.0 * dx, 2757000.0 + (k / 9.0 - 0.5) * 100.0 * dy, 40.0 + 0.1 * (k / 9.0 - 0.5) * 100.0]
        for k in range(10)
    ]
    res = survey.calculate_cut_fill_volume({
        "scan_id": "quchi_20261005_merged",
        "base_mode": "best_fit_plane",
        "polygon": pts
    })
    bfp = res.get("best_fit_plane", {})
    slope = bfp.get("slope_pct")
    a = bfp.get("a")
    b = bfp.get("b")
    print(f"Azimuth {angle_deg:5.1f}°: slope_pct = {slope}, a = {a}, b = {b}")
    if slope != 0.0 or a != 0.0 or b != 0.0:
        collinear_failures.append((angle_deg, slope, a, b))

print(f"Collinear test failures count: {len(collinear_failures)}")

print("\n=== 2. Non-Collinear 2D Polygons (Pads, Corridors, Steep Slopes) ===")
# A. Small building pad: 5m x 5m
pad_pts = [
    [304950.0, 2757080.0, 42.0],
    [304955.0, 2757080.0, 42.25],
    [304955.0, 2757085.0, 42.50],
    [304950.0, 2757085.0, 42.25],
]
res_pad = survey.calculate_cut_fill_volume({
    "scan_id": "quchi_20261005_merged",
    "base_mode": "best_fit_plane",
    "polygon": pad_pts
})
bfp_pad = res_pad.get("best_fit_plane", {})
print(f"5m x 5m pad slope: {bfp_pad.get('slope_pct')}% (expected > 0%, valid fit)")

# B. Road corridor: 100m long x 5m wide (20:1 aspect ratio)
corr_pts = [
    [304900.0, 2757000.0, 40.0],
    [305000.0, 2757000.0, 45.0],
    [305000.0, 2757005.0, 45.25],
    [304900.0, 2757005.0, 40.25],
]
res_corr = survey.calculate_cut_fill_volume({
    "scan_id": "quchi_20261005_merged",
    "base_mode": "best_fit_plane",
    "polygon": corr_pts
})
bfp_corr = res_corr.get("best_fit_plane", {})
print(f"100m x 5m corridor slope: {bfp_corr.get('slope_pct')}% (expected ~5.0%, valid fit)")

# C. Road corridor: 100m long x 2m wide (50:1 aspect ratio)
corr2_pts = [
    [304900.0, 2757000.0, 40.0],
    [305000.0, 2757000.0, 45.0],
    [305000.0, 2757002.0, 45.10],
    [304900.0, 2757002.0, 40.10],
]
res_corr2 = survey.calculate_cut_fill_volume({
    "scan_id": "quchi_20261005_merged",
    "base_mode": "best_fit_plane",
    "polygon": corr2_pts
})
bfp_corr2 = res_corr2.get("best_fit_plane", {})
print(f"100m x 2m corridor slope: {bfp_corr2.get('slope_pct')}% (expected ~5.0%, valid fit)")

# D. Steep 80° slope on synthetic DSM
print("\n=== 3. Mass Conservation & Truck Haul Logic Verification ===")
# Call volume endpoint with custom earthwork parameters
res_mass = survey.calculate_cut_fill_volume({
    "scan_id": "quchi_20261005_merged",
    "base_mode": "custom_plane",
    "datum_elevation_m": 40.0,
    "density_t_m3": 1.70,
    "swell_factor": 1.25,
    "shrinkage_factor": 0.15,
    "truck_volume_m3": 14.0,
    "truck_max_tonnes": 20.0,
    "polygon": [
        [304940.0, 2757070.0],
        [304970.0, 2757070.0],
        [304970.0, 2757100.0],
        [304940.0, 2757100.0],
    ]
})

cut_bcm = res_mass.get("cut_volume_bcm", 0.0)
fill_bcm = res_mass.get("fill_volume_bcm", 0.0)
cut_lcm = res_mass.get("cut_volume_lcm", 0.0)
fill_ccm = res_mass.get("fill_volume_ccm", 0.0)
cut_mass_t = res_mass.get("conserved_cut_mass_t", 0.0)
fill_mass_t = res_mass.get("conserved_fill_mass_t", 0.0)
truck_loads = res_mass.get("truck_loads_cut", 0)
limiting_factor = res_mass.get("truck_limiting_factor")

print(f"Cut BCM: {cut_bcm} m³")
print(f"Cut LCM (swell=1.25): {cut_lcm} m³ (ratio: {cut_lcm / max(cut_bcm, 1e-6):.3f})")
print(f"Fill BCM: {fill_bcm} m³")
print(f"Fill CCM (shrink=0.15 -> 0.85): {fill_ccm} m³ (ratio: {fill_ccm / max(fill_bcm, 1e-6):.3f})")
print(f"Cut Mass: {cut_mass_t} tonnes (density=1.70, ratio: {cut_mass_t / max(cut_bcm, 1e-6):.3f})")
print(f"Truck loads cut: {truck_loads}, limiting: {limiting_factor}")

# Verify math
expected_lcm = round(cut_bcm * 1.25, 2)
expected_ccm = round(fill_bcm * 0.85, 2)
expected_cut_mass = round(cut_bcm * 1.70, 2)
trips_vol = cut_lcm / 14.0
trips_wt = cut_mass_t / 20.0
expected_truck_loads = int(math.ceil(max(trips_vol, trips_wt))) if cut_bcm > 0 else 0
expected_limiting = "weight" if trips_wt > trips_vol else "volume"

print(f"Verification: LCM match: {abs(cut_lcm - expected_lcm) < 0.05}")
print(f"Verification: CCM match: {abs(fill_ccm - expected_ccm) < 0.05}")
print(f"Verification: Cut Mass match: {abs(cut_mass_t - expected_cut_mass) < 0.05}")
print(f"Verification: Truck loads match: {truck_loads == expected_truck_loads}")
print(f"Verification: Limiting factor match: {limiting_factor == expected_limiting}")
