## 2026-10-31T05:39:00Z
You are worker_m2 (Milestone 2 Implementation Worker).
Your working directory is: c:\Antigravity\GatheringScans\.agents\teamwork\worker_m2\
Your parent is: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3

MANDATORY: Read c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md and c:\Antigravity\GatheringScans\.agents\teamwork\PROJECT.md before doing anything else.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

INPUTS & ARCHITECTURAL SPECIFICATIONS:
Read all 3 explorer handoff reports:
1. c:\Antigravity\GatheringScans\.agents\teamwork\explorer_m2_1\handoff.md (3D GCP residual math, target pairing, statistical QA metrics, ASPRS 95% confidence intervals, and backward-compatible schema)
2. c:\Antigravity\GatheringScans\.agents\teamwork\explorer_m2_2\handoff.md (1-click TBM datum calibration math, zero-destruction persistence in extra_json and scan_meta.json, downstream propagation)
3. c:\Antigravity\GatheringScans\.agents\teamwork\explorer_m2_3\handoff.md (Frontend delegation in 09-construction-survey-and-bim.js, 3D Studio Three.js vector helpers, and 5,000-line modular ceiling protection)

MISSION & TASKS:
Implement Milestone 2: Control Alignment & 3D GCP Calibration.

Task 1: Backend 3D Residuals & Statistical QA in `pc_worker/surveying/dsm_and_volume.py`:
- In `compute_gcp_accuracy_qa`:
  - Support both Paired Target Mode (extracting `mesh_e`/`e_scan`, `mesh_n`/`n_scan`, `mesh_h`/`h_scan` with `safe_float`) and Check Point Mode (sampling `h_scan` from DSM at reference ground coordinates, with dE=0, dN=0).
  - Compute 3D residuals: dE = E_scan - E_gcp, dN = N_scan - N_gcp, dH = H_scan - H_gcp, d2D = sqrt(dE^2 + dN^2), d3D = sqrt(dE^2 + dN^2 + dH^2).
  - Compute RMSE metrics: RMSE_E, RMSE_N, RMSE_H, RMSE_2D = sqrt(RMSE_E^2 + RMSE_N^2), RMSE_3D = sqrt(RMSE_2D^2 + RMSE_H^2).
  - Compute Mean Biases: mean_bias_e, mean_bias_n, mean_bias_h.
  - Compute Sample Standard Deviations: sigma_e, sigma_n, sigma_h (safeguarded for N=1 -> 0.0).
  - Compute ASPRS 2014 95% Positional Accuracies:
    - Accuracy_z = 1.9600 * RMSE_H
    - Accuracy_r = 1.7308 * RMSE_2D
    - Accuracy_3d = 1.6140 * RMSE_3D
  - Taiwan Surveying QA Grades: Grade A (<= 5cm), Grade B (<= 10cm), Grade C (> 10cm).
  - Preserve all legacy response keys: `points`, `rmse_z_m`, `rmse_z_cm`, `qa_grade`, `qa_grade_label`, `csv_url`, `html_url` alongside new 3D keys (`gcp_residuals`, `rmse_e`, `rmse_n`, `rmse_h`, `rmse_2d`, `rmse_3d`, `accuracy_z_95_m`, `accuracy_r_95_m`, `accuracy_3d_95_m`, `mean_bias_e`, `mean_bias_n`, `mean_bias_h`).

Task 2: 1-Click TBM Vertical Datum Calibration & Zero-Destruction Persistence:
- In `compute_gcp_accuracy_qa`:
  - Calculate proposed vertical datum shift:
    - If `selected_tbm_id` or point has `is_tbm=True`: shift = -dH_tbm = H_gcp_tbm - H_scan_tbm.
    - If no specific TBM: shift = -mean_bias_h = -(1/N) * sum(dH_i).
  - Calculate calibrated residuals: H_scan_cal = H_scan + shift, dH_cal = dH + shift, d3D_cal = sqrt(d2D^2 + dH_cal^2).
  - Calculate calibrated RMSE_H and calibrated RMSE_3D, and calibrated QA Grade.
  - When `apply_tbm_calibration: true`:
    - Persist calibration metadata (`tbm_calibration` dictionary containing `shift_m`, `applied_at`, `tbm_point_id`, `raw_rmse_h`, `calibrated_rmse_h`) and `vertical_datum_offset: shift_m` into scan's `extra_json` in SQLite DB, and write to `<project_dir>/scan_meta.json` (and `data/categorization_cache/`).
    - DO NOT modify raw `.las`, `.ply`, or DSM rasters on disk (Zero-Destruction).
- Implement `_resolve_vertical_datum_shift(scan_id, payload=None, scan=None)` helper in `dsm_and_volume.py`:
  - Consumes user `geoid_offset_override` if provided, otherwise active `vertical_datum_offset` from TBM calibration.
  - Wire this helper into volume, contours, profile, and drainage calculations where elevation datum applies.

Task 3: Modular Frontend Implementation in `web/src/09-construction-survey-and-bim.js` & `web/survey-bim.css`:
- CRITICAL ARCHITECTURAL CEILING: DO NOT add lines to `web/src/03-studio-core.js` (4,997 lines), `web/src/05-studio-civil-inspectors.js` (4,988 lines), or `web/src/08-advanced-surveying-and-qa.js` (4,852 lines).
- In `web/src/09-construction-survey-and-bim.js`:
  - Override/attach `window.openGcpAccuracyQaInspector(qaResult)`.
  - Build the enhanced GCP QA UI modal/drawer:
    1. Header with QA Grade badge.
    2. KPI Cards: RMSE_E, RMSE_N, RMSE_H, RMSE_2D, RMSE_3D, ASPRS 95% Vertical & Horizontal Accuracies.
    3. 1-Click TBM Calibration Card: Displays active reference point/mean bias, proposed shift, live calibrated RMSE preview, and "套用 TBM 高程校正" button that invokes `/api/survey/gcp-qa` with `apply_tbm_calibration: true`.
    4. 3D Residuals Table: PtID, E_gcp, N_gcp, H_gcp, E_scan, N_scan, H_scan, dE, dN, dH, d2D, d3D, TBM radio button, and status color badges.
    5. 3D Studio Three.js Visual Overlays: Implement `window.renderGcpQaMarkers3D(points)` and `window.clearGcpQaMarkers3D()`, creating `THREE.ArrowHelper` vectors showing 3D error vectors in Three.js Studio mode with user-selectable exaggeration multiplier (1x, 10x, 20x, 50x, 100x), ground target reticles, diamond TBM badges, and hover billboard labels.
    6. Export: CSV download (with UTF-8 BOM) and printable HTML QA certificate.
- In `web/survey-bim.css`:
  - Add styles for the GCP table, TBM badge, KPI metrics grid, and 3D vector legend.
- In `web/index.html` and `web/sw.js`:
  - Link `/survey-bim.css` in `web/index.html`.
  - Bump asset cache version to `?v=20261031_v219` in `web/index.html` and `web/sw.js`.

Task 4: Automated Tests & Synchronization:
- In `tests/test_civil_surveying_e2e.py` and `tests/test_gathering_scans_suite.py`:
  - Add test methods verifying:
    - 3D GCP pairing and residuals (dE, dN, dH, d2D, d3D).
    - Statistical RMSEs, mean biases, and ASPRS 95% positional accuracies.
    - 1-Click TBM calibration (both designated TBM point and network mean bias).
    - Calibration persistence in `extra_json` and downstream volume/contour consumption.
    - Zero HTTP 500 errors on empty/malformed GCP coordinate arrays.
    - Strict 5,000-line ceiling compliance across all repository files.
- Execute full test suite (`python -m unittest tests/test_gathering_scans_suite.py` and `python -m unittest tests/test_civil_surveying_e2e.py`).
- Pre-flight git merge from origin/main, commit & push, reload local daemon (`ensure_daemon_running.ps1` at `127.0.0.1:8095`), and reload live Hostinger VPS container (`docker restart gathering_scans_web` on `76.13.197.29`). Verify 200 OK on both.


## 2026-10-31T05:39:12Z
**Context**: User Requirement Directive — Web UI Screenshot Capture
**Content**: Parent/User directive: Once the frontend UI cards, residual tables, and TBM calibration controls are running on the local server (`http://127.0.0.1:8095`), you MUST capture real `.png` screenshots of the web interface (e.g. using headless Chrome command, Playwright, or a python script using webdriver/chrome) displaying the newly added GCP QA modal, TBM calibration card, and 3D Studio overlays. Save the screenshot files into `c:\Antigravity\GatheringScans\.agents\teamwork\screenshots\` (e.g. `m2_gcp_qa_inspector.png`) and report their exact file paths in your `handoff.md` and completion message.
**Action**: Implement screenshot capture alongside your testing and verification steps.
