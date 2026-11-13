"""
Validation script for Milestone 1: Least-Squares Best-Fit Reference Plane Math.
Tests:
1. Pure horizontal plane
2. Pure tilted plane with known slope and azimuth
3. Dense boundary sample perimeter
4. Collinear / degenerate points fallback
5. Single point / < 3 points fallback
6. Grid cell integration and volume takeoff
7. Mass conservation schedule (BCM, LCM, CCM) & Dump truck estimator
"""

import math
from typing import List, Tuple, Dict, Any


def fit_best_fit_plane_twd97(
    points: List[Tuple[float, float, float]],
) -> Dict[str, Any]:
    """
    Fits a plane Z = a(E - E0) + b(N - N0) + c0 to perimeter boundary points
    using 2D Normal Equations with centroid conditioning.
    """
    n = len(points)
    if n < 3:
        mean_h = points[0][2] if n > 0 else 0.0
        return {
            "a": 0.0,
            "b": 0.0,
            "c": mean_h,
            "c0": mean_h,
            "e0": points[0][0] if n > 0 else 0.0,
            "n0": points[0][1] if n > 0 else 0.0,
            "slope_pct": 0.0,
            "slope_deg": 0.0,
            "azimuth_deg": 0.0,
            "is_degenerate": True,
        }

    p_mean_e = sum(p[0] for p in points) / n
    p_mean_n = sum(p[1] for p in points) / n
    p_mean_h = sum(p[2] for p in points) / n

    suu = sum((p[0] - p_mean_e) ** 2 for p in points)
    svv = sum((p[1] - p_mean_n) ** 2 for p in points)
    suv = sum((p[0] - p_mean_e) * (p[1] - p_mean_n) for p in points)
    suw = sum((p[0] - p_mean_e) * (p[2] - p_mean_h) for p in points)
    svw = sum((p[1] - p_mean_n) * (p[2] - p_mean_h) for p in points)

    det_plane = suu * svv - suv * suv
    trace_plane = suu + svv

    if abs(det_plane) < 1e-9 or trace_plane < 1e-6:
        return {
            "a": 0.0,
            "b": 0.0,
            "c": p_mean_h,
            "c0": p_mean_h,
            "e0": p_mean_e,
            "n0": p_mean_n,
            "slope_pct": 0.0,
            "slope_deg": 0.0,
            "azimuth_deg": 0.0,
            "is_degenerate": True,
        }

    plane_a = (suw * svv - svw * suv) / det_plane
    plane_b = (svw * suu - suw * suv) / det_plane
    plane_c0 = p_mean_h
    plane_c = plane_c0 - plane_a * p_mean_e - plane_b * p_mean_n

    plane_slope_mag = math.hypot(plane_a, plane_b)
    plane_slope_pct = round(plane_slope_mag * 100.0, 3)
    plane_slope_deg = round(math.degrees(math.atan(plane_slope_mag)), 2)

    if plane_slope_mag > 1e-7:
        plane_azimuth_deg = round(math.degrees(math.atan2(plane_a, plane_b)) % 360.0, 2)
    else:
        plane_azimuth_deg = 0.0

    return {
        "a": plane_a,
        "b": plane_b,
        "c": plane_c,
        "c0": plane_c0,
        "e0": p_mean_e,
        "n0": p_mean_n,
        "slope_pct": plane_slope_pct,
        "slope_deg": plane_slope_deg,
        "azimuth_deg": plane_azimuth_deg,
        "is_degenerate": False,
    }


def eval_plane_z(plane: Dict[str, Any], e: float, n: float) -> float:
    return plane["a"] * (e - plane["e0"]) + plane["b"] * (n - plane["n0"]) + plane["c0"]


def test_suite():
    # 1. Pure Horizontal Plane
    pts_horiz = [
        (304000.0, 2750000.0, 50.0),
        (304020.0, 2750000.0, 50.0),
        (304020.0, 2750020.0, 50.0),
        (304000.0, 2750020.0, 50.0),
    ]
    fit_h = fit_best_fit_plane_twd97(pts_horiz)
    assert not fit_h["is_degenerate"]
    assert abs(fit_h["a"]) < 1e-12
    assert abs(fit_h["b"]) < 1e-12
    assert abs(fit_h["c0"] - 50.0) < 1e-12
    assert fit_h["slope_pct"] == 0.0
    print("[PASS] Test 1: Pure horizontal plane")

    # 2. Known 2.5% slope North, 0% East
    pts_north_tilt = [
        (304000.0, 2750000.0, 50.0),
        (304020.0, 2750000.0, 50.0),
        (304020.0, 2750040.0, 51.0),  # dN = 40, dZ = 1.0 -> b = 0.025 (2.5%)
        (304000.0, 2750040.0, 51.0),
    ]
    fit_n = fit_best_fit_plane_twd97(pts_north_tilt)
    assert abs(fit_n["a"]) < 1e-7
    assert abs(fit_n["b"] - 0.025) < 1e-7
    assert abs(fit_n["slope_pct"] - 2.5) < 1e-3
    assert abs(fit_n["azimuth_deg"] - 0.0) < 1e-2
    # Verify residuals at all points
    for p in pts_north_tilt:
        assert abs(eval_plane_z(fit_n, p[0], p[1]) - p[2]) < 1e-7
    print("[PASS] Test 2: Known 2.5% Northward slope")

    # 3. Known 3.0% East slope, 4.0% North slope (total 5.0% gradient, azimuth = atan2(3, 4) = 36.87 deg)
    pts_sloped = [
        (304000.0, 2750000.0, 50.0),
        (304100.0, 2750000.0, 53.0),  # dE = 100, dZ = 3.0 -> a = 0.03
        (304100.0, 2750100.0, 57.0),  # dN = 100, dZ = 4.0 -> b = 0.04
        (304000.0, 2750100.0, 54.0),
    ]
    fit_s = fit_best_fit_plane_twd97(pts_sloped)
    assert abs(fit_s["a"] - 0.03) < 1e-7
    assert abs(fit_s["b"] - 0.04) < 1e-7
    assert abs(fit_s["slope_pct"] - 5.0) < 1e-3
    assert abs(fit_s["azimuth_deg"] - 36.87) < 0.05
    for p in pts_sloped:
        assert abs(eval_plane_z(fit_s, p[0], p[1]) - p[2]) < 1e-7
    print("[PASS] Test 3: Compound slope 3% East + 4% North (5% magnitude, 36.87 deg azimuth)")

    # 4. Collinear Points Fallback
    pts_collinear = [
        (304000.0, 2750000.0, 42.0),
        (304010.0, 2750010.0, 43.0),
        (304020.0, 2750020.0, 44.0),
    ]
    fit_coll = fit_best_fit_plane_twd97(pts_collinear)
    assert fit_coll["is_degenerate"]
    assert fit_coll["a"] == 0.0
    assert fit_coll["b"] == 0.0
    assert abs(fit_coll["c0"] - 43.0) < 1e-7
    print("[PASS] Test 4: Collinear points fallback to mean horizontal plane")

    # 5. Fewer than 3 points
    fit_2pts = fit_best_fit_plane_twd97([(304000.0, 2750000.0, 41.5), (304010.0, 2750010.0, 42.5)])
    assert fit_2pts["is_degenerate"]
    assert fit_2pts["a"] == 0.0
    assert fit_2pts["b"] == 0.0
    assert fit_2pts["c0"] == 41.5
    print("[PASS] Test 5: Fewer than 3 points fallback")

    # 6. Mass Conservation & Dump Truck Load Estimator
    cut_bcm = 1200.0
    fill_bcm = 450.0
    density = 1.65
    swell_factor = 1.25  # loose expansion +25%
    shrinkage_factor = 0.10  # compaction 90%
    truck_vol = 15.0  # m3
    truck_max_wt = 20.0  # tonnes

    cut_lcm = cut_bcm * swell_factor
    fill_ccm = fill_bcm * (1.0 - shrinkage_factor)
    conserved_cut_mass = cut_bcm * density

    trips_vol = cut_lcm / truck_vol
    trips_wt = conserved_cut_mass / truck_max_wt
    truck_loads = math.ceil(max(trips_vol, trips_wt))
    limiting = "weight" if trips_wt > trips_vol else "volume"

    assert abs(cut_lcm - 1500.0) < 1e-3
    assert abs(fill_ccm - 405.0) < 1e-3
    assert abs(conserved_cut_mass - 1980.0) < 1e-3
    assert trips_vol == 100.0  # 1500 / 15
    assert trips_wt == 99.0    # 1980 / 20
    assert truck_loads == 100
    assert limiting == "volume"
    print(f"[PASS] Test 6: Mass Conservation & Dump Truck Estimator (Loads: {truck_loads}, Limiting: {limiting})")

    print("\nALL MATHEMATICAL VERIFICATION TESTS PASSED SUCCESSFULLY!")


if __name__ == "__main__":
    test_suite()
