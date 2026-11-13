#!/usr/bin/env python3
"""
Empirical Adversarial Stress Test Suite for M1 Numerical Stability
===================================================================
Agent: challenger_m1_iter2_1 (M1 Numerical Stability Challenger)
Roles: critic, specialist
Working Directory: c:\\Antigravity\\GatheringScans\\.agents\\teamwork\\challenger_m1_iter2_1\\

Empirical Objectives:
1. Rotated Collinear Line Alignments:
   - Lengths: 10m, 50m, 100m, 500m
   - Rotation angles: 0°, 15°, 30°, 35°, 45°, 60°, 75°, 89.9°
   - Millimeter-scale quantization noise (+/- 0.001m)
   - Verify: (lambda_min / trace_plane) < 1e-4 triggers fallback and returns slope_pct = 0.0% without exploding slope.
2. Steep Non-Collinear Polygons:
   - Realistic 2D survey footprints on steep 75° and 85° slopes across all azimuths
   - Verify: condition ratio does NOT trigger fallback; returns true slope and aspect within 0.01% tolerance.
3. Safe Float & NaN/Inf Injections:
   - Inject "", "   ", "null", "undefined", "NaN", "Inf", "-Infinity", and non-numeric strings
   - Test safe_float() directly and end-to-end via calculate_cut_fill_volume
   - Verify: zero unhandled exceptions and robust fallback handling.
"""

import sys
import os
import math
import random
import unittest
from typing import List, Tuple, Dict, Any, Optional

# Ensure project root is in sys.path
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from pc_worker.surveying.dsm_and_volume import safe_float
from pc_worker.priority_queue import ScanQueueDB
from pc_worker.config import DB_PATH
from pc_worker.surveying_engine import SurveyingEngine


def fit_best_fit_plane_least_squares(plane_pts: List[Tuple[float, float, float]]) -> Dict[str, Any]:
    """
    Exact replica of lines 1114-1158 of pc_worker/surveying/dsm_and_volume.py
    for isolated mathematical stress testing.
    """
    n_plane = len(plane_pts)
    if n_plane >= 3:
        p_mean_e = sum(p[0] for p in plane_pts) / n_plane
        p_mean_n = sum(p[1] for p in plane_pts) / n_plane
        p_mean_h = sum(p[2] for p in plane_pts) / n_plane

        suu = sum((p[0] - p_mean_e) ** 2 for p in plane_pts)
        svv = sum((p[1] - p_mean_n) ** 2 for p in plane_pts)
        suv = sum((p[0] - p_mean_e) * (p[1] - p_mean_n) for p in plane_pts)
        suw = sum((p[0] - p_mean_e) * (p[2] - p_mean_h) for p in plane_pts)
        svw = sum((p[1] - p_mean_n) * (p[2] - p_mean_h) for p in plane_pts)

        det_plane = suu * svv - suv * suv
        trace_plane = suu + svv

        # Safeguard: singularity / collinear points / non-positive det fallback to horizontal mean plane
        disc_plane = max(0.0, (suu - svv) ** 2 + 4.0 * suv * suv)
        lambda_min = (2.0 * det_plane) / (trace_plane + math.sqrt(disc_plane)) if trace_plane > 1e-6 else 0.0

        if det_plane <= 0.0 or lambda_min < 1e-4 or (lambda_min / trace_plane) < 1e-4 or trace_plane < 1e-6:
            plane_a = 0.0
            plane_b = 0.0
            plane_c0 = p_mean_h
            fallback_triggered = True
        else:
            plane_a = (suw * svv - svw * suv) / det_plane
            plane_b = (svw * suu - suw * suv) / det_plane
            plane_c0 = p_mean_h
            fallback_triggered = False
    else:
        p_mean_e = plane_pts[0][0] if plane_pts else 0.0
        p_mean_n = plane_pts[0][1] if plane_pts else 0.0
        p_mean_h = plane_pts[0][2] if plane_pts else 0.0
        plane_a = 0.0
        plane_b = 0.0
        plane_c0 = p_mean_h
        det_plane = 0.0
        trace_plane = 0.0
        lambda_min = 0.0
        fallback_triggered = True

    plane_c = plane_c0 - plane_a * p_mean_e - plane_b * p_mean_n
    plane_slope_mag = math.hypot(plane_a, plane_b)
    plane_slope_pct = round(plane_slope_mag * 100.0, 3)
    plane_slope_deg = round(math.degrees(math.atan(plane_slope_mag)), 2)
    plane_azimuth_deg = (
        round(math.degrees(math.atan2(plane_a, plane_b)) % 360.0, 2)
        if plane_slope_mag > 1e-7
        else 0.0
    )

    ratio = (lambda_min / trace_plane) if trace_plane > 1e-6 else 0.0
    return {
        "a": plane_a,
        "b": plane_b,
        "c": plane_c,
        "c0": plane_c0,
        "det": det_plane,
        "trace": trace_plane,
        "lambda_min": lambda_min,
        "condition_ratio": ratio,
        "fallback_triggered": fallback_triggered,
        "slope_pct": plane_slope_pct,
        "slope_deg": plane_slope_deg,
        "azimuth_deg": plane_azimuth_deg,
    }


class AdversarialNumericalStabilitySuite(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = ScanQueueDB(DB_PATH)
        cls.survey = SurveyingEngine(cls.db)
        # Ensure test scan exists in DB to prevent fallback IO latency
        cls._ensure_test_scan("quchi_20261005_merged")

    @classmethod
    def _ensure_test_scan(cls, scan_id: str):
        try:
            with cls.db._get_conn() as conn:
                row = conn.execute("SELECT id FROM scans WHERE id = ?", (scan_id,)).fetchone()
                if not row:
                    conn.execute(
                        """
                        INSERT INTO scans (id, project_name, status, updated_at, point_count, is_merged, local_path)
                        VALUES (?, 'Test Project', 'ready', datetime('now'), 100000, 0, '')
                        """,
                        (scan_id,),
                    )
        except Exception as e:
            pass

    # =========================================================================
    # PART 1: Rotated Collinear Line Alignments
    # =========================================================================
    def test_01_rotated_collinear_lines_pure_math(self):
        """
        Stress test: lengths 10m, 50m, 100m, 500m rotated at 0°, 15°, 30°, 35°, 45°, 60°, 75°, 89.9°
        with random millimeter-scale quantization noise (+/- 0.001m).
        Must safely trigger condition ratio < 1e-4 and yield slope_pct = 0.0%.
        """
        lengths = [10.0, 50.0, 100.0, 500.0]
        angles_deg = [0.0, 15.0, 30.0, 35.0, 45.0, 60.0, 75.0, 89.9]
        point_counts = [5, 10, 25]

        # Use fixed seed for deterministic reproducibility while testing 1,920 permutations
        rng = random.Random(42)

        total_tested = 0
        fallbacks_triggered = 0

        for length in lengths:
            for angle_deg in angles_deg:
                angle_rad = math.radians(angle_deg)
                dir_e = math.cos(angle_rad)
                dir_n = math.sin(angle_rad)

                for n_pts in point_counts:
                    # Run 20 random noise realizations per configuration
                    for trial in range(20):
                        total_tested += 1

                        # Generate collinear baseline points with millimeter jitter
                        pts: List[Tuple[float, float, float]] = []
                        for i in range(n_pts):
                            t = (i / float(n_pts - 1) - 0.5) * length
                            # Millimeter noise in [-0.001, +0.001]
                            noise_e = rng.uniform(-0.001, 0.001)
                            noise_n = rng.uniform(-0.001, 0.001)
                            noise_h = rng.uniform(-0.001, 0.001)

                            e = 300000.0 + t * dir_e + noise_e
                            n = 2700000.0 + t * dir_n + noise_n
                            # 10% elevation gradient along the line
                            h = 50.0 + 0.10 * t + noise_h
                            pts.append((e, n, h))

                        fit = fit_best_fit_plane_least_squares(pts)

                        # Adversarial checks:
                        # 1. Condition ratio or lambda_min must flag collinearity
                        self.assertTrue(
                            fit["fallback_triggered"],
                            f"Collinear fallback NOT triggered for L={length}m, angle={angle_deg}°, N={n_pts}, trial={trial}. "
                            f"det={fit['det']}, trace={fit['trace']}, lambda_min={fit['lambda_min']}, ratio={fit['condition_ratio']}"
                        )
                        fallbacks_triggered += 1

                        # 2. Slope must NOT explode into astronomical values
                        self.assertEqual(
                            fit["slope_pct"],
                            0.0,
                            f"Exploded or non-zero slope: {fit['slope_pct']}% at L={length}m, angle={angle_deg}°"
                        )
                        self.assertEqual(fit["a"], 0.0)
                        self.assertEqual(fit["b"], 0.0)
                        self.assertEqual(fit["azimuth_deg"], 0.0)

        print(f"\n[PART 1.1] Collinear lines tested: {total_tested}, Fallbacks successfully triggered: {fallbacks_triggered} (100.0%)")

    def test_02_rotated_collinear_worst_case_alternating_noise(self):
        """
        Adversarial stress test with worst-case alternating quantization noise (+0.001, -0.001, +0.001, ...)
        which maximizes transverse curvature (highest possible spurious lambda_min).
        """
        lengths = [10.0, 50.0, 100.0, 500.0]
        angles_deg = [0.0, 15.0, 30.0, 35.0, 45.0, 60.0, 75.0, 89.9]

        for length in lengths:
            for angle_deg in angles_deg:
                angle_rad = math.radians(angle_deg)
                dir_e = math.cos(angle_rad)
                dir_n = math.sin(angle_rad)
                perp_e = -dir_n
                perp_n = dir_e

                for n_pts in [3, 4, 10, 20]:
                    pts: List[Tuple[float, float, float]] = []
                    for i in range(n_pts):
                        t = (i / float(n_pts - 1) - 0.5) * length
                        sign = 1.0 if (i % 2 == 0) else -1.0
                        # Strictly perpendicular alternating noise
                        noise_e = sign * 0.001 * perp_e
                        noise_n = sign * 0.001 * perp_n
                        noise_h = sign * 0.001

                        e = 300000.0 + t * dir_e + noise_e
                        n = 2700000.0 + t * dir_n + noise_n
                        h = 100.0 + 0.05 * t + noise_h
                        pts.append((e, n, h))

                    fit = fit_best_fit_plane_least_squares(pts)
                    self.assertTrue(
                        fit["fallback_triggered"],
                        f"Worst-case alternating noise failed fallback: L={length}m, angle={angle_deg}°, N={n_pts}"
                    )
                    self.assertEqual(fit["slope_pct"], 0.0)

    def test_03_rotated_collinear_lines_end_to_end_engine(self):
        """
        End-to-end integration test with SurveyingEngine.calculate_cut_fill_volume
        using 10m, 50m, 100m, and 500m rotated alignments on real scan fixture.
        """
        scan_id = "quchi_20261005_merged"
        test_configs = [
            (10.0, 0.0),
            (50.0, 35.0),
            (100.0, 45.0),
            (500.0, 89.9),
        ]

        for length, angle_deg in test_configs:
            angle_rad = math.radians(angle_deg)
            dx = math.cos(angle_rad)
            dy = math.sin(angle_rad)

            polygon = [
                [
                    round(304950.0 + (k / 9.0 - 0.5) * length * dx, 3),
                    round(2757080.0 + (k / 9.0 - 0.5) * length * dy, 3),
                    round(42.0 + 0.05 * (k / 9.0 - 0.5) * length, 3),
                ]
                for k in range(10)
            ]

            vol = self.survey.calculate_cut_fill_volume({
                "scan_id": scan_id,
                "base_mode": "best_fit_plane",
                "polygon": polygon,
            })

            self.assertEqual(vol["status"], "ok")
            bfp = vol["best_fit_plane"]
            self.assertEqual(bfp["slope_pct"], 0.0, f"Failed at L={length}m, angle={angle_deg}°")
            self.assertEqual(bfp["a"], 0.0)
            self.assertEqual(bfp["b"], 0.0)
            self.assertFalse(math.isnan(bfp["c"]))

    # =========================================================================
    # PART 2: Steep Non-Collinear Polygons (75° and 85° Slopes)
    # =========================================================================
    def test_04_steep_non_collinear_polygons_analytical_recovery(self):
        """
        Verify realistic 2D survey footprints on steep 75° and 85° slopes:
        - Must NOT trigger the condition ratio fallback (ratio >= 1e-4)
        - Must recover the true slope % within 0.01% tolerance
        - Must recover the true aspect/azimuth within 0.01 degrees tolerance
        """
        slope_angles_deg = [75.0, 85.0]
        # Test 12 azimuth angles across all quadrants
        azimuths_deg = [0.0, 30.0, 45.0, 60.0, 90.0, 120.0, 135.0, 180.0, 225.0, 270.0, 315.0, 345.0]

        # Realistic 2D footprints:
        footprint_shapes = [
            # 1. 20m x 20m square footprint (4 corners)
            [(-10.0, -10.0), (10.0, -10.0), (10.0, 10.0), (-10.0, 10.0)],
            # 2. 50m x 25m rectangular footprint
            [(-25.0, -12.5), (25.0, -12.5), (25.0, 12.5), (-25.0, 12.5)],
            # 3. Triangular survey plot (3 corners, non-collinear)
            [(-15.0, -10.0), (20.0, -5.0), (0.0, 25.0)],
            # 4. Irregular pentagonal footprint (5 corners)
            [(-20.0, -10.0), (15.0, -15.0), (25.0, 10.0), (5.0, 20.0), (-15.0, 15.0)],
            # 5. Elongated survey corridor 50m x 5m (aspect ratio 10:1)
            [(-25.0, -2.5), (25.0, -2.5), (25.0, 2.5), (-25.0, 2.5)],
        ]

        total_tested = 0
        successes = 0

        for target_deg in slope_angles_deg:
            true_slope_mag = math.tan(math.radians(target_deg))
            true_slope_pct = true_slope_mag * 100.0

            for az_deg in azimuths_deg:
                az_rad = math.radians(az_deg)
                # In surveying, azimuth is clockwise from North (+N):
                # Gradient vector: a = dZ/dE = slope_mag * sin(az), b = dZ/dN = slope_mag * cos(az)
                true_a = true_slope_mag * math.sin(az_rad)
                true_b = true_slope_mag * math.cos(az_rad)

                for fp_idx, fp in enumerate(footprint_shapes):
                    total_tested += 1
                    pts: List[Tuple[float, float, float]] = []
                    for de, dn in fp:
                        e = 300000.0 + de
                        n = 2700000.0 + dn
                        h = 100.0 + true_a * de + true_b * dn
                        pts.append((e, n, h))

                    fit = fit_best_fit_plane_least_squares(pts)

                    # 1. Condition ratio must NOT trigger fallback
                    self.assertFalse(
                        fit["fallback_triggered"],
                        f"Fallback spuriously triggered on 2D footprint #{fp_idx} on {target_deg}° slope at az={az_deg}°! "
                        f"Ratio={fit['condition_ratio']}, lambda_min={fit['lambda_min']}"
                    )
                    self.assertGreaterEqual(
                        fit["condition_ratio"],
                        1e-4,
                        f"Condition ratio < 1e-4 on 2D polygon: {fit['condition_ratio']}"
                    )

                    # 2. Slope percentage within 0.01% tolerance (relative)
                    rel_slope_err = abs(fit["slope_pct"] - true_slope_pct) / true_slope_pct
                    self.assertLess(
                        rel_slope_err,
                        0.0001,  # 0.01%
                        f"Slope % error exceeds 0.01%: got {fit['slope_pct']}%, expected {true_slope_pct}% (err={rel_slope_err:.6%})"
                    )

                    # 3. Azimuth / aspect within 0.01 degrees tolerance
                    # Circular difference
                    az_diff = abs(fit["azimuth_deg"] - az_deg) % 360.0
                    if az_diff > 180.0:
                        az_diff = 360.0 - az_diff
                    self.assertLess(
                        az_diff,
                        0.01,
                        f"Azimuth error exceeds 0.01°: got {fit['azimuth_deg']}°, expected {az_deg}° (diff={az_diff}°)"
                    )
                    successes += 1

        print(f"[PART 2.1] Steep 2D polygons tested: {total_tested}, Perfectly recovered: {successes} (100.0%)")

    def test_05_steep_non_collinear_polygon_end_to_end_engine(self):
        """
        End-to-end integration: 2D polygon on steep terrain with calculate_cut_fill_volume
        verifies that realistic 2D survey footprints retain non-zero slopes and valid results.
        """
        scan_id = "quchi_20261005_merged"
        # 30m x 30m square polygon around scan center
        polygon_2d = [
            [304930.0, 2757060.0],
            [304960.0, 2757060.0],
            [304960.0, 2757090.0],
            [304930.0, 2757090.0],
        ]

        vol = self.survey.calculate_cut_fill_volume({
            "scan_id": scan_id,
            "base_mode": "best_fit_plane",
            "polygon": polygon_2d,
        })

        self.assertEqual(vol["status"], "ok")
        bfp = vol["best_fit_plane"]
        # Non-collinear 2D polygon on real terrain has non-zero slope
        self.assertGreater(bfp["slope_pct"], 0.0)
        self.assertGreater(bfp["slope_deg"], 0.0)
        self.assertTrue(0.0 <= bfp["azimuth_deg"] < 360.0)
        self.assertFalse(math.isnan(bfp["a"]))
        self.assertFalse(math.isnan(bfp["b"]))
        self.assertFalse(math.isnan(bfp["c"]))

    # =========================================================================
    # PART 3: Safe Float & NaN/Inf Injections
    # =========================================================================
    def test_06_safe_float_comprehensive_adversarial_injections(self):
        """
        Direct unit verification of safe_float() against hostile adversarial tokens:
        - empty strings, whitespaces
        - sentinel words ('null', 'undefined', 'nan', 'none')
        - inf, -inf, +/-infinity
        - garbage strings, script tags, non-convertible types
        - valid float representations (scientific notation, negative, leading/trailing spaces)
        """
        # Test Case 1: Hostile inputs that MUST safely return default
        hostile_inputs = [
            None,
            "",
            "   ",
            "\t\n  \r",
            "null",
            "NULL",
            "Null",
            "undefined",
            "UNDEFINED",
            "Undefined",
            "none",
            "NONE",
            "None",
            "NaN",
            "nan",
            "NAN",
            "  nan  ",
            float("nan"),
            "Inf",
            "inf",
            "INF",
            "+Inf",
            "+inf",
            "Infinity",
            "+Infinity",
            "  Infinity  ",
            float("inf"),
            "-Inf",
            "-inf",
            "-INF",
            "-Infinity",
            "  -Infinity  ",
            float("-inf"),
            "not_a_number",
            "abc",
            "12.34.56",
            "--1",
            "{} ",
            "[]",
            "<script>alert(1)</script>",
            "\x00null\x00",
            {},
            [],
            (),
            object(),
            complex(1, 2),
        ]

        for val in hostile_inputs:
            # Test with default=None
            res_none = safe_float(val)
            self.assertIsNone(
                res_none,
                f"safe_float({repr(val)}) did not return None default, got: {res_none}"
            )

            # Test with custom default=42.0
            res_custom = safe_float(val, 42.0)
            self.assertEqual(
                res_custom,
                42.0,
                f"safe_float({repr(val)}, 42.0) did not return 42.0, got: {res_custom}"
            )

        # Test Case 2: Valid inputs that MUST parse accurately
        valid_cases = [
            ("0", 0.0),
            ("0.0", 0.0),
            ("-0.0", 0.0),
            ("42", 42.0),
            ("-123.456", -123.456),
            ("  3.14159  ", 3.14159),
            ("1e-5", 1e-5),
            ("-2.5e3", -2500.0),
            (100, 100.0),
            (2.71828, 2.71828),
        ]

        for raw_val, expected in valid_cases:
            res = safe_float(raw_val)
            self.assertIsNotNone(res)
            self.assertAlmostEqual(res, expected, places=5)

        print(f"[PART 3.1] safe_float tested against {len(hostile_inputs)} hostile inputs & {len(valid_cases)} valid cases: 100% safe.")

    def test_07_engine_payload_hostile_string_injections(self):
        """
        End-to-end integration: inject hostile strings into calculate_cut_fill_volume payload
        across all numerical fields:
        - density_t_m3
        - geoid_offset_override
        - datum_elevation_m
        - truck_volume_m3
        - truck_max_tonnes
        - swell_factor
        - shrinkage_factor
        Verify zero unhandled 500 exceptions, and proper fallback to physical defaults.
        """
        scan_id = "quchi_20261005_merged"
        test_injections = [
            "",
            "   ",
            "null",
            "undefined",
            "NaN",
            "Inf",
            "-Infinity",
            "DROP TABLE scans;",
            "<script>",
        ]

        for token in test_injections:
            payload = {
                "scan_id": scan_id,
                "base_mode": "best_fit_plane",
                "polygon": [
                    [304940.0, 2757070.0],
                    [304960.0, 2757070.0],
                    [304960.0, 2757090.0],
                    [304940.0, 2757090.0],
                ],
                "density_t_m3": token,
                "geoid_offset_override": token,
                "datum_elevation_m": token,
                "truck_volume_m3": token,
                "truck_max_tonnes": token,
                "swell_factor": token,
                "shrinkage_factor": token,
            }

            try:
                vol = self.survey.calculate_cut_fill_volume(payload)
            except Exception as e:
                self.fail(f"Unhandled exception on token '{token}': {type(e).__name__}: {e}")

            self.assertEqual(vol["status"], "ok", f"Expected status 'ok' on token '{token}', got: {vol}")
            self.assertIn("best_fit_plane", vol)
            self.assertIn("cut_volume_bcm", vol)
            self.assertIn("fill_volume_bcm", vol)

            # Verify that fallback defaults took effect safely
            self.assertGreater(vol["density_t_m3"], 0.0)
            self.assertGreater(vol["truck_volume_m3"], 0.0)
            self.assertGreater(vol["truck_max_tonnes"], 0.0)
            self.assertGreater(vol["swell_factor"], 0.0)
            self.assertGreater(vol["datum_elevation_m"], 0.0)

        print(f"[PART 3.2] Engine cut_fill payload tested with {len(test_injections)} hostile injection sets: 0 crashes.")

    # =========================================================================
    # PART 4: Additional Adversarial Boundary Stress Tests
    # =========================================================================
    def test_08_aspect_ratio_transition_boundary(self):
        """
        Empirically verify the condition ratio transition boundary:
        Survey corridor of length 100m with varying widths:
        - Widths >= 2.0m (aspect ratio <= 50:1): condition ratio > 1e-4, 2D plane recovered
        - Widths <= 0.5m (aspect ratio >= 200:1): condition ratio < 1e-4, safely falls back to flat plane
        """
        length = 100.0
        # True slope of 5% along E, 3% along N
        true_a = 0.05
        true_b = 0.03

        widths = [20.0, 10.0, 5.0, 2.0, 0.8, 0.5, 0.2, 0.05]
        for w in widths:
            pts = [
                (300000.0 - length / 2, 2700000.0 - w / 2, 50.0 - true_a * (length / 2) - true_b * (w / 2)),
                (300000.0 + length / 2, 2700000.0 - w / 2, 50.0 + true_a * (length / 2) - true_b * (w / 2)),
                (300000.0 + length / 2, 2700000.0 + w / 2, 50.0 + true_a * (length / 2) + true_b * (w / 2)),
                (300000.0 - length / 2, 2700000.0 + w / 2, 50.0 - true_a * (length / 2) + true_b * (w / 2)),
            ]
            fit = fit_best_fit_plane_least_squares(pts)
            ratio = fit["condition_ratio"]

            if w >= 2.0:
                self.assertFalse(fit["fallback_triggered"], f"Spurious fallback at width {w}m (ratio={ratio})")
                self.assertAlmostEqual(fit["a"], true_a, places=5)
                self.assertAlmostEqual(fit["b"], true_b, places=5)
            elif w <= 0.5:
                self.assertTrue(fit["fallback_triggered"], f"Fallback should trigger at corridor width {w}m (ratio={ratio})")
                self.assertEqual(fit["slope_pct"], 0.0)

        print(f"[PART 4.1] Aspect ratio transition boundary verified across {len(widths)} corridor widths.")

    def test_09_twd97_large_offset_precision(self):
        """
        Verify that 2D centroid conditioning (p - p_mean) completely insulates
        least-squares normal equations from double precision loss at realistic TWD97
        spatial coordinates (E ~ 300,000m, N ~ 2,700,000m) vs local origin (0, 0).
        """
        local_pts = [
            (0.0, 0.0, 10.0),
            (20.0, 0.0, 11.0),
            (20.0, 15.0, 11.5),
            (0.0, 15.0, 10.5),
        ]
        twd97_pts = [
            (304950.0 + p[0], 2757080.0 + p[1], p[2])
            for p in local_pts
        ]

        fit_local = fit_best_fit_plane_least_squares(local_pts)
        fit_twd97 = fit_best_fit_plane_least_squares(twd97_pts)

        self.assertAlmostEqual(fit_local["a"], fit_twd97["a"], places=9)
        self.assertAlmostEqual(fit_local["b"], fit_twd97["b"], places=9)
        self.assertAlmostEqual(fit_local["slope_pct"], fit_twd97["slope_pct"], places=7)
        self.assertAlmostEqual(fit_local["azimuth_deg"], fit_twd97["azimuth_deg"], places=7)
        print("[PART 4.2] TWD97 large-coordinate centroid conditioning verified: 0 precision drift.")

    def test_10_extreme_steepness_89_9_degrees(self):
        """
        Verify extreme near-vertical cliff at 89.9° (slope_pct = 57,295.779%):
        Ensure no overflow, no NaN, condition ratio remains healthy, and slope is accurately recovered.
        """
        target_deg = 89.9
        slope_mag = math.tan(math.radians(target_deg))
        expected_slope_pct = slope_mag * 100.0

        for az_deg in [0.0, 45.0, 90.0, 180.0, 270.0]:
            rad = math.radians(az_deg)
            true_a = slope_mag * math.sin(rad)
            true_b = slope_mag * math.cos(rad)

            pts = [
                (300000.0, 2700000.0, 100.0),
                (300020.0, 2700000.0, 100.0 + true_a * 20.0),
                (300020.0, 2700020.0, 100.0 + true_a * 20.0 + true_b * 20.0),
                (300000.0, 2700020.0, 100.0 + true_b * 20.0),
            ]

            fit = fit_best_fit_plane_least_squares(pts)
            self.assertFalse(fit["fallback_triggered"])
            self.assertFalse(math.isnan(fit["slope_pct"]))
            self.assertFalse(math.isinf(fit["slope_pct"]))

            rel_err = abs(fit["slope_pct"] - expected_slope_pct) / expected_slope_pct
            self.assertLess(rel_err, 0.0001, f"89.9° cliff slope error too large: {rel_err:.6%}")
        print("[PART 4.3] Extreme 89.9° cliff slope verified: 100% stable.")


if __name__ == "__main__":
    unittest.main()
