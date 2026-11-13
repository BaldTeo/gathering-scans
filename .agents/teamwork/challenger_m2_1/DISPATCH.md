## 2026-10-31T06:15:06Z
You are challenger_m2_1 (M2 Numerical Invariance & Stability Challenger).
Your working directory is: c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m2_1\
Your parent is: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3

MANDATORY: Read c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md and c:\Antigravity\GatheringScans\.agents\teamwork\PROJECT.md before doing anything else.

INPUTS:
- Worker Handoff: c:\Antigravity\GatheringScans\.agents\teamwork\worker_m2\handoff.md
- Codebase files: `pc_worker/surveying/dsm_and_volume.py`

MISSION:
Act as an adversarial numerical critic. Write a dedicated standalone test harness (e.g. `c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m2_1\test_m2_numerical_stress.py`) and empirically stress-test the Milestone 2 mathematical implementation:
1. Exact Pythagorean Invariants Verification:
   - For every individual point: assert that `abs(d3D**2 - (d2D**2 + dH**2)) < 1e-10` and `abs(d3D**2 - (dE**2 + dN**2 + dH**2)) < 1e-10`.
   - For aggregate network RMSE: assert that `abs(rmse_3d**2 - (rmse_2d**2 + rmse_h**2)) < 1e-8` and `abs(rmse_3d**2 - (rmse_e**2 + rmse_n**2 + rmse_h**2)) < 1e-8`.
   - Run across 10,000+ randomized synthetic coordinate configurations (small centimeter errors, huge kilometer spans, steep mountainous terrain).
2. TBM Bias Elimination Theorem:
   - For any network with systematic vertical bias (e.g. delta_H_mean = +0.50m) plus random noise:
     - Applying network mean TBM calibration must reduce calibrated mean error to 0.0000m (+/- 1e-10).
     - Calibrated RMSE_H must drop to exactly the sample standard deviation sigma_H (random noise floor).
     - Test across 1,000+ synthetic biased networks.
3. Hostile Singularity & Stress Inputs:
   - N = 0 points: must return status "ok" with point_count = 0, zero RMSEs, without ZeroDivisionError.
   - N = 1 point: sample standard deviation must evaluate to 0.0000 without ZeroDivisionError (denominator N-1 = 0).
   - Collinear control points: verify horizontal and vertical RMSEs compute cleanly.
   - Hostile string inputs: empty strings, whitespace, non-numeric tokens ("NaN", "inf", "null", "undefined", garbage strings) in coordinates.
   - Negative coordinates and extreme coordinates (E > 1e7, N > 1e7).

CRITERIA:
- Explicit verdict: APPROVE or REQUEST_CHANGES in handoff.md.
- Write your full report to c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m2_1\handoff.md following the Handoff Protocol.
- Send a completion message via send_message to your parent when done.
