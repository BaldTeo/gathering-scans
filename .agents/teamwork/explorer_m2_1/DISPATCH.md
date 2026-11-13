# Dispatch — explorer_m2_1 (GCP 3D Residuals & Accuracy Math Explorer)
Date: 2026-10-31T05:30:00Z
## 2026-10-31T05:27:50Z
Sender: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3
Content:
You are explorer_m2_1 (M2 GCP 3D Residuals & Accuracy Math Explorer).
Your working directory is: c:\Antigravity\GatheringScans\.agents\teamwork\explorer_m2_1\
Your parent is: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3

MANDATORY: Read c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md and c:\Antigravity\GatheringScans\.agents\teamwork\PROJECT.md before doing anything else.

MISSION:
Investigate Milestone 2 (M2: Control Alignment & 3D GCP Calibration) backend math, algorithms, and API structures.
Focus areas:
1. True 3D (E, N, H) GCP control target pairing:
   - Matching survey control points (provided by user via coordinates or file) against photogrammetric DSM elevation and point cloud coordinates in `pc_worker/surveying/dsm_and_volume.py` (`compute_gcp_accuracy_qa`) and `pc_worker/server_api_routes.py`.
2. 3D Residual Error Vectors:
   - Delta formulas: dE = E_scan - E_gcp, dN = N_scan - N_gcp, dH = H_scan - H_gcp, d2D = sqrt(dE^2 + dN^2), d3D = sqrt(dE^2 + dN^2 + dH^2).
   - Sign convention and civil engineering standards.
3. Statistical Accuracy QA Metrics:
   - Root Mean Square Error: RMSE_E, RMSE_N, RMSE_H, RMSE_2D, RMSE_3D = sqrt(RMSE_E^2 + RMSE_N^2 + RMSE_H^2).
   - Mean bias (dE_mean, dN_mean, dH_mean), standard deviations, min/max horizontal and vertical deviations.
   - Confidence intervals (e.g. 95% NSSDA / ASPRS positional accuracy standards: Accuracy_r = 1.7308 * RMSE_2D, Accuracy_z = 1.9600 * RMSE_H).
4. Edge cases & resilience:
   - Resiliency when points have missing/empty/non-numeric strings (ensure safe_float usage).
   - Handling point cloud vs DSM interpolation (bilinear or nearest neighbor elevation sampling).
   - Single point, collinear points, points outside scan bounding box.

CONSTRAINTS:
- You are a READ-ONLY explorer. DO NOT modify or create any source code, tests, or config files.
- Write your comprehensive findings to c:\Antigravity\GatheringScans\.agents\teamwork\explorer_m2_1\handoff.md.
- Follow the Handoff Protocol: Observation, Logic Chain, Caveats, Conclusion, Verification Method.
- Send a completion message via send_message to your parent when done.
