# BRIEFING — 2026-10-31T05:35:00Z

## Mission
Investigate Milestone 2 (M2: Control Alignment & 3D GCP Calibration) backend math, algorithms, and API structures.

## 🔒 My Identity
- Archetype: explorer
- Roles: investigator, math & algorithms analyst
- Working directory: c:\Antigravity\GatheringScans\.agents\teamwork\explorer_m2_1\
- Original parent: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3
- Milestone: Milestone 2 (M2)

## 🔒 Key Constraints
- Read-only investigation — do NOT implement
- Do NOT modify or create any source code, tests, or config files
- Write findings to c:\Antigravity\GatheringScans\.agents\teamwork\explorer_m2_1\handoff.md
- Follow Handoff Protocol (Observation, Logic Chain, Caveats, Conclusion, Verification Method)
- Send completion message to parent (35a7b3c4-959a-4d2b-a4b5-21fb2891dea3) via send_message

## Current Parent
- Conversation ID: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3
- Updated: 2026-10-31T05:35:00Z

## Investigation State
- **Explored paths**:
  - `pc_worker/surveying/dsm_and_volume.py`: `compute_gcp_accuracy_qa`, `_sample_dsm_elevation`, `safe_float`
  - `pc_worker/server_api_routes.py`: `/api/survey/gcp-qa` endpoint binding
  - `tests/test_gathering_scans_suite.py`: lines 673-706 (`test_08_...`), line 2589-2649 (`test_33_...`, `test_34_...`)
  - `web/src/08-advanced-surveying-and-qa.js`: existing `renderGcpAccuracyReport`
  - `web/src/09-construction-survey-and-bim.js`: architectural home for M2 UI extensions
- **Key findings**:
  - Current `compute_gcp_accuracy_qa` in `dsm_and_volume.py` only computes vertical residual `dz_m` and simulated check points. It extracts `mesh_h` but ignores `mesh_e` and `mesh_n`.
  - True 3D GCP pairing requires extracting `(e_scan, n_scan, h_scan)` alongside `(e_gcp, n_gcp, h_gcp)` with Check Point fallback (`e_scan = e_gcp, n_scan = n_gcp`).
  - Standard civil surveying residual sign convention is Model minus Reference ($\Delta E = E_{scan} - E_{gcp}$, $\Delta N = N_{scan} - N_{gcp}$, $\Delta H = H_{scan} - H_{gcp}$).
  - 3D residual metrics: RMSE_E, RMSE_N, RMSE_H, RMSE_2D ($\sqrt{\text{RMSE}_E^2 + \text{RMSE}_N^2}$), and RMSE_3D ($\sqrt{\text{RMSE}_{2D}^2 + \text{RMSE}_H^2}$).
  - NSSDA / ASPRS 95% Positional Accuracy: $\text{Accuracy}_r = 1.7308 \times \text{RMSE}_{2D}$ (Horizontal), $\text{Accuracy}_z = 1.9600 \times \text{RMSE}_H$ (Vertical), and $\text{Accuracy}_{3D} \approx 1.6140 \times \text{RMSE}_{3D}$.
  - Backward compatibility: Must retain all existing return keys (`rmse_z_m`, `rmse_z_cm`, `points`, `qa_grade`) while adding new 3D fields (`rmse_e`, `rmse_n`, `rmse_h`, `rmse_2d`, `rmse_3d`, `gcp_residuals`, `tbm_applied`, `tbm_shift_m`).
  - Edge cases: Malformed inputs (safe_float), single point $N=1$ (zero division guard on $\sigma$), collinear points (invariant RMSE, warning flag), points outside scan footprint (clean exclusion with no-coverage status).
- **Unexplored areas**: None for M2 backend math scope. Ready to author comprehensive handoff.md.

## Key Decisions Made
- Fully specified mathematical formulas, sign conventions, standard statistical QA metrics, and edge-case handling for implementer.
- Formulated exact response payload schema guaranteeing 100% backward compatibility with existing tests.

## Artifact Index
- DISPATCH.md — record of incoming dispatch messages
- BRIEFING.md — persistent working memory
- progress.md — liveness heartbeat
- handoff.md — final analysis report
