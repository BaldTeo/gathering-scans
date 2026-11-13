"""
Milestone 2 Forensic Mutation Sensitivity Audit
Author: auditor_m2
Purpose: Verify that GCP QA and TBM Datum Calibration in pc_worker/surveying/dsm_and_volume.py
         perform 100% genuine dynamic calculations and exhibit zero hardcoding or fixed responses
         under coordinate and elevation mutations.
"""
import sys
import os
import math
import copy
import shutil
import tempfile

# Ensure GatheringScans root is on sys.path
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from pc_worker.priority_queue import ScanQueueDB
from pc_worker.surveying_engine import SurveyingEngine


def run_mutation_audit():
    print("=== Starting Milestone 2 Mutation Sensitivity Audit ===")
    tmp_dir = tempfile.mkdtemp()
    tmp_db_path = os.path.join(tmp_dir, "test_m2_audit.db")
    try:
        db = ScanQueueDB(db_path=tmp_db_path)
        engine = SurveyingEngine(db)

        scan_id = "audit_scan_m2"
        scan_dir = os.path.join(tmp_dir, scan_id)
        os.makedirs(scan_dir, exist_ok=True)
        db.upsert_scan({
            "scan_id": scan_id,
            "name": "Audit M2 Scan",
            "project_group": "Audit Group",
            "twd97_e": 304950.0,
            "twd97_n": 2757080.0,
            "twd97_h": 125.0,
            "project_dir": scan_dir,
        })

        base_points = [
            {"id": "GCP-01", "name": "GCP-01", "e": 304950.0, "n": 2757080.0, "h_gcp": 120.0, "mesh_e": 304950.020, "mesh_n": 2757080.015, "mesh_h": 120.030, "is_tbm": False},
            {"id": "GCP-02", "name": "GCP-02", "e": 304960.0, "n": 2757085.0, "h_gcp": 121.0, "mesh_e": 304959.980, "mesh_n": 2757085.025, "mesh_h": 120.980, "is_tbm": False},
            {"id": "GCP-03", "name": "GCP-03", "e": 304970.0, "n": 2757090.0, "h_gcp": 122.0, "mesh_e": 304970.010, "mesh_n": 2757089.990, "mesh_h": 122.040, "is_tbm": False},
            {"id": "GCP-04", "name": "GCP-04", "e": 304980.0, "n": 2757095.0, "h_gcp": 123.0, "mesh_e": 304979.995, "mesh_n": 2757095.010, "mesh_h": 122.970, "is_tbm": False},
            {"id": "TBM-01", "name": "TBM-01", "e": 304990.0, "n": 2757100.0, "h_gcp": 124.0, "mesh_e": 304990.005, "mesh_n": 2757100.005, "mesh_h": 124.050, "is_tbm": True},
        ]

        # --- 1. BASELINE EXECUTION ---
        print("\n--- Phase 1: Baseline Evaluation ---")
        payload_base = {
            "scan_id": scan_id,
            "points": copy.deepcopy(base_points),
            "selected_tbm_id": "TBM-01",
            "apply_tbm_calibration": False,
        }
        res_base = engine.compute_gcp_accuracy_qa(payload_base)
        assert res_base["status"] == "ok", f"Baseline failed: {res_base}"
        print(f"Base RMSE_H: {res_base['rmse_h']:.4f} m, RMSE_2D: {res_base['rmse_2d']:.4f} m, RMSE_3D: {res_base['rmse_3d']:.4f} m")
        print(f"Base Mean Biases: dE={res_base['mean_bias_e']:.4f}, dN={res_base['mean_bias_n']:.4f}, dH={res_base['mean_bias_h']:.4f}")
        tbm_preview_base = res_base["tbm_calibration_preview"]
        print(f"Base TBM Proposed Shift: {tbm_preview_base['shift_m']:.4f} m (TBM dh was {base_points[4]['mesh_h'] - base_points[4]['h_gcp']:.4f})")
        assert abs(tbm_preview_base["shift_m"] - (-0.0500)) < 1e-4, f"Expected shift -0.0500, got {tbm_preview_base['shift_m']}"

        # Verify baseline mathematical invariants
        for p in res_base["gcp_residuals"]:
            exp_de = round(p["e_scan"] - p["e_gcp"], 4)
            exp_dn = round(p["n_scan"] - p["n_gcp"], 4)
            exp_dh = round(p["h_scan"] - p["h_gcp"], 4)
            exp_d2d = round(math.hypot(exp_de, exp_dn), 4)
            exp_d3d = round(math.hypot(exp_d2d, exp_dh), 4)
            assert abs(p["de"] - exp_de) < 1e-4, f"de mismatch for {p['id']}: {p['de']} vs {exp_de}"
            assert abs(p["dn"] - exp_dn) < 1e-4, f"dn mismatch for {p['id']}: {p['dn']} vs {exp_dn}"
            assert abs(p["dh"] - exp_dh) < 1e-4, f"dh mismatch for {p['id']}: {p['dh']} vs {exp_dh}"
            assert abs(p["d2d"] - exp_d2d) < 1e-4, f"d2d mismatch for {p['id']}: {p['d2d']} vs {exp_d2d}"
            assert abs(p["d3d"] - exp_d3d) < 1e-4, f"d3d mismatch for {p['id']}: {p['d3d']} vs {exp_d3d}"

        # --- 2. MUTATION A: +0.10m Elevation Perturbation ---
        print("\n--- Phase 2: Mutation A (+0.10m Elevation to all GCPs) ---")
        pts_mut_a = copy.deepcopy(base_points)
        delta_h_perturb = 0.100
        for p in pts_mut_a:
            p["h_gcp"] = round(p["h_gcp"] + delta_h_perturb, 3)

        res_mut_a = engine.compute_gcp_accuracy_qa({
            "scan_id": scan_id,
            "points": pts_mut_a,
            "selected_tbm_id": "TBM-01",
        })
        print(f"Mut A RMSE_H: {res_mut_a['rmse_h']:.4f} m (Base was {res_base['rmse_h']:.4f} m)")
        print(f"Mut A Mean Bias dH: {res_mut_a['mean_bias_h']:.4f} m (Base was {res_base['mean_bias_h']:.4f} m)")
        print(f"Mut A TBM Proposed Shift: {res_mut_a['tbm_calibration_preview']['shift_m']:.4f} m")

        # The elevation error dH = H_scan - H_gcp, so if H_gcp increases by +0.10, dH MUST decrease by exactly 0.100!
        expected_mean_dh_a = round(res_base["mean_bias_h"] - delta_h_perturb, 4)
        assert abs(res_mut_a["mean_bias_h"] - expected_mean_dh_a) < 1e-4, \
            f"INTEGRITY VIOLATION: Mean dH failed to shift by exactly -0.10m: {res_mut_a['mean_bias_h']} vs {expected_mean_dh_a}"

        # TBM shift = -dH_tbm, so it MUST increase by +0.10m
        expected_tbm_shift_a = round(tbm_preview_base["shift_m"] + delta_h_perturb, 4)
        assert abs(res_mut_a["tbm_calibration_preview"]["shift_m"] - expected_tbm_shift_a) < 1e-4, \
            f"INTEGRITY VIOLATION: TBM shift failed to adjust dynamically: {res_mut_a['tbm_calibration_preview']['shift_m']} vs {expected_tbm_shift_a}"
        print(">> Mutation A: PASSED. Math is genuinely dynamic and responsive.")

        # --- 3. MUTATION B: +0.05m Easting Perturbation ---
        print("\n--- Phase 3: Mutation B (+0.05m Easting to all GCPs) ---")
        pts_mut_b = copy.deepcopy(base_points)
        delta_e_perturb = 0.050
        for p in pts_mut_b:
            p["e"] = round(p["e"] + delta_e_perturb, 3)

        res_mut_b = engine.compute_gcp_accuracy_qa({
            "scan_id": scan_id,
            "points": pts_mut_b,
            "selected_tbm_id": "TBM-01",
        })
        print(f"Mut B RMSE_E: {res_mut_b['rmse_e']:.4f} m (Base was {res_base['rmse_e']:.4f} m)")
        print(f"Mut B Mean Bias dE: {res_mut_b['mean_bias_e']:.4f} m (Base was {res_base['mean_bias_e']:.4f} m)")
        expected_mean_de_b = round(res_base["mean_bias_e"] - delta_e_perturb, 4)
        assert abs(res_mut_b["mean_bias_e"] - expected_mean_de_b) < 1e-4, \
            f"INTEGRITY VIOLATION: Mean dE failed to shift by exactly -0.05m: {res_mut_b['mean_bias_e']} vs {expected_mean_de_b}"
        print(">> Mutation B: PASSED. Easting response verified.")

        # --- 4. MUTATION C: TBM Height Modified by +0.05m ---
        print("\n--- Phase 4: Mutation C (Only TBM height modified by +0.05m) ---")
        pts_mut_c = copy.deepcopy(base_points)
        # TBM is index 4
        pts_mut_c[4]["h_gcp"] = round(pts_mut_c[4]["h_gcp"] + 0.050, 3)

        res_mut_c = engine.compute_gcp_accuracy_qa({
            "scan_id": scan_id,
            "points": pts_mut_c,
            "selected_tbm_id": "TBM-01",
        })
        tbm_shift_c = res_mut_c["tbm_calibration_preview"]["shift_m"]
        print(f"Mut C TBM Proposed Shift: {tbm_shift_c:.4f} m (Base was {tbm_preview_base['shift_m']:.4f} m)")
        # Since H_gcp increased by 0.05m, dH_tbm = H_scan - H_gcp decreased by 0.05m (from +0.050 to 0.000).
        # Proposed shift = -dH_tbm = 0.0000 m.
        # Therefore shift changed from -0.0500 to 0.0000 (+0.0500m change).
        assert abs(tbm_shift_c - (tbm_preview_base["shift_m"] + 0.050)) < 1e-4, \
            f"INTEGRITY VIOLATION: Modifying TBM height did not shift proposed datum by exactly +0.05m! Got {tbm_shift_c}"
        print(">> Mutation C: PASSED. TBM single-point calibration responds exactly to designated TBM height.")

        # --- 5. MUTATION D: Arbitrary Random Perturbations & Independent Full Recomputation ---
        print("\n--- Phase 5: Mutation D (Non-uniform arbitrary perturbations with independent mathematical ground truth) ---")
        import random
        rng = random.Random(42)
        pts_mut_d = []
        for i in range(12):
            eg = 300000.0 + rng.uniform(-100.0, 100.0)
            ng = 2700000.0 + rng.uniform(-100.0, 100.0)
            hg = 100.0 + rng.uniform(-20.0, 50.0)
            es = eg + rng.uniform(-0.08, 0.08)
            ns = ng + rng.uniform(-0.08, 0.08)
            hs = hg + rng.uniform(-0.12, 0.12)
            pts_mut_d.append({
                "id": f"P-{i+1:02d}",
                "name": f"P-{i+1:02d}",
                "e": round(eg, 3),
                "n": round(ng, 3),
                "h_gcp": round(hg, 3),
                "mesh_e": round(es, 3),
                "mesh_n": round(ns, 3),
                "mesh_h": round(hs, 3),
                "is_tbm": (i == 3),
            })

        res_mut_d = engine.compute_gcp_accuracy_qa({
            "scan_id": scan_id,
            "points": pts_mut_d,
            "selected_tbm_id": "P-04",
        })

        # Independent ground-truth computation from scratch
        raw_eval = []
        for p in pts_mut_d:
            de = round(p["mesh_e"] - p["e"], 4)
            dn = round(p["mesh_n"] - p["n"], 4)
            dh = round(p["mesh_h"] - p["h_gcp"], 4)
            d2d = round(math.hypot(de, dn), 4)
            d3d = round(math.hypot(d2d, dh), 4)
            raw_eval.append((de, dn, dh, d2d, d3d))

        n = len(raw_eval)
        gt_rmse_e = round(math.sqrt(sum(x[0]**2 for x in raw_eval) / n), 4)
        gt_rmse_n = round(math.sqrt(sum(x[1]**2 for x in raw_eval) / n), 4)
        gt_rmse_h = round(math.sqrt(sum(x[2]**2 for x in raw_eval) / n), 4)
        gt_rmse_2d = round(math.hypot(gt_rmse_e, gt_rmse_n), 4)
        gt_rmse_3d = round(math.hypot(gt_rmse_2d, gt_rmse_h), 4)
        gt_asprs_z = round(1.9600 * gt_rmse_h, 4)
        gt_asprs_r = round(1.7308 * gt_rmse_2d, 4)
        gt_asprs_3d = round(1.6140 * gt_rmse_3d, 4)

        assert abs(res_mut_d["rmse_e"] - gt_rmse_e) < 1e-4, f"RMSE_E mismatch: {res_mut_d['rmse_e']} vs {gt_rmse_e}"
        assert abs(res_mut_d["rmse_n"] - gt_rmse_n) < 1e-4, f"RMSE_N mismatch: {res_mut_d['rmse_n']} vs {gt_rmse_n}"
        assert abs(res_mut_d["rmse_h"] - gt_rmse_h) < 1e-4, f"RMSE_H mismatch: {res_mut_d['rmse_h']} vs {gt_rmse_h}"
        assert abs(res_mut_d["rmse_2d"] - gt_rmse_2d) < 1e-4, f"RMSE_2D mismatch: {res_mut_d['rmse_2d']} vs {gt_rmse_2d}"
        assert abs(res_mut_d["rmse_3d"] - gt_rmse_3d) < 1e-4, f"RMSE_3D mismatch: {res_mut_d['rmse_3d']} vs {gt_rmse_3d}"
        assert abs(res_mut_d["accuracy_z_95_m"] - gt_asprs_z) < 1e-4, f"ASPRS Z mismatch: {res_mut_d['accuracy_z_95_m']} vs {gt_asprs_z}"
        assert abs(res_mut_d["accuracy_r_95_m"] - gt_asprs_r) < 1e-4, f"ASPRS R mismatch: {res_mut_d['accuracy_r_95_m']} vs {gt_asprs_r}"
        assert abs(res_mut_d["accuracy_3d_95_m"] - gt_asprs_3d) < 1e-4, f"ASPRS 3D mismatch: {res_mut_d['accuracy_3d_95_m']} vs {gt_asprs_3d}"
        print(f">> Mutation D: PASSED. All 12-point arbitrary metrics match exact independent mathematical ground truth.")

        # --- 6. DOWNSTREAM CONSUMPTION CHECK ---
        print("\n--- Phase 6: Downstream Volume & Elevation Shift Propagation ---")
        shift_test = 0.1234
        resolved = engine._resolve_vertical_datum_shift("any_scan", payload={"vertical_datum_offset": shift_test})
        assert abs(resolved - shift_test) < 1e-4, f"Failed payload shift resolution: {resolved} vs {shift_test}"
        print(f">> Downstream Shift Resolution: PASSED. Correctly resolves {resolved} m.")

        print("\n=== ALL MUTATION SENSITIVITY AUDIT CHECKS PASSED: ZERO FACADES DETECTED ===")
        return True
    finally:
        try:
            shutil.rmtree(tmp_dir)
        except OSError:
            pass


if __name__ == "__main__":
    success = run_mutation_audit()
    if not success:
        sys.exit(1)
