# Handoff Report — Milestone 2: Control Alignment & 3D GCP Calibration

**Agent**: `worker_m2`  
**Date**: 2026-10-31  
**Working Directory**: `c:\Antigravity\GatheringScans\.agents\teamwork\worker_m2\`  
**Target Recipient / Parent**: `35a7b3c4-959a-4d2b-a4b5-21fb2891dea3`  
**Milestone**: Milestone 2 (Control Alignment & 3D GCP Calibration)  
**Status**: Completed (Hard Handoff)

---

## 1. Observation

### 1.1 Architecture & Headroom Analysis
- Inspected the primary civil surveying files prior to modification:
  - `web/src/03-studio-core.js`: 4,996 lines
  - `web/src/05-studio-civil-inspectors.js`: 4,987 lines
  - `web/src/08-advanced-surveying-and-qa.js`: 4,851 lines
  - `pc_worker/surveying/dsm_and_volume.py`: 2,628 lines
  - `pc_worker/surveying/contours_and_cad.py`: 2,775 lines
  - `pc_worker/priority_queue.py`: 2,739 lines
- Verified that adding large UI components directly to `03-studio-core.js`, `05-studio-civil-inspectors.js`, or `08-advanced-surveying-and-qa.js` would breach the mandatory 5,000-line ceiling enforced by `test_07_modular_architecture_strict_5000_line_ceiling`.

### 1.2 Mathematical Specifications & Standards
- ASPRS 2014 Positional Accuracy Standards for Digital Geospatial Data:
  - Vertical Accuracy (95% Confidence): $\text{Accuracy}_z = 1.9600 \times \text{RMSE}_H$
  - Horizontal Radial Accuracy (95% Confidence): $\text{Accuracy}_r = 1.7308 \times \text{RMSE}_{2D} = 1.7308 \times \sqrt{\text{RMSE}_E^2 + \text{RMSE}_N^2}$
  - 3D Spherical Radial Accuracy (95% Confidence): $\text{Accuracy}_{3D} = 1.6140 \times \text{RMSE}_{3D} = 1.6140 \times \sqrt{\text{RMSE}_{2D}^2 + \text{RMSE}_H^2}$
- Taiwan Surveying QA Grades (MOI Land Surveying Bureau):
  - Grade A: $\text{RMSE}_H \le 5.0\text{ cm}$ and $\text{RMSE}_{2D} \le 5.0\text{ cm}$ (RTK Survey-Grade)
  - Grade B: $\text{RMSE}_H \le 10.0\text{ cm}$ and $\text{RMSE}_{2D} \le 10.0\text{ cm}$ (Engineering Topographic)
  - Grade C: $\text{RMSE}_H > 10.0\text{ cm}$ or $\text{RMSE}_{2D} > 10.0\text{ cm}$ (Reconnaissance / Calibration Needed)
- Sign Convention:
  - Residual: $\Delta E = E_{\text{scan}} - E_{\text{gcp}}, \Delta N = N_{\text{scan}} - N_{\text{gcp}}, \Delta H = H_{\text{scan}} - H_{\text{gcp}}$
  - Proposed Datum Shift: $\text{shift} = -\Delta H_{\text{tbm}}$ or $\text{shift} = -\mu_H = -\frac{1}{N}\sum \Delta H_i$
  - Calibrated Scan Elevation: $H_{\text{scan, cal}} = H_{\text{scan}} + \text{shift}$

### 1.3 Verified Tool Commands and Test Executions
1. `python -m unittest tests/test_civil_surveying_e2e.py`
   ```
   ............................
   ----------------------------------------------------------------------
   Ran 28 tests in 1.010s
   OK
   ```
2. `python -m unittest tests/test_gathering_scans_suite.py`
   ```
   ...................................
   ----------------------------------------------------------------------
   Ran 35 tests in 11.944s
   OK
   ```
3. Combined full test suite:
   ```
   ...............................................................
   ----------------------------------------------------------------------
   Ran 63 tests in 11.340s
   OK
   ```
4. Git Commit & Push:
   - Commit: `3d56be2` — `"Milestone 2: Implement 3D GCP residuals, 1-click TBM vertical datum calibration, and 3D Studio error vectors (v219)"`
   - Push: `To https://github.com/BaldTeo/gathering-scans.git main -> main` (Fast-forward verified)
5. Local Server Restart & Verification:
   - Port 8095 listener restarted via `ensure_daemon_running.ps1`.
   - `http://127.0.0.1:8095/api/status` responded:
     `{ "status": "online", "pc_online": true, "daemon_running": true, "total_scans": 27 }`
6. Hostinger VPS Sync & Verification:
   - Container `gathering_scans_web` on `76.13.197.29` restarted via SSH.
   - `https://scans.gatheren.cloud/api/status` responded:
     `{ "status": "online", "pc_online": true, "daemon_running": true, "total_scans": 27 }`
   - Verified that `https://scans.gatheren.cloud` serves `/survey-bim.css?v=20261031_v219` and `/src/09-construction-survey-and-bim.js?v=20261031_v219`.
7. Real Web UI Screenshot Capture:
   - `c:\Antigravity\GatheringScans\.agents\teamwork\screenshots\m2_gcp_qa_inspector.png` (1,740,353 bytes)
   - `c:\Antigravity\GatheringScans\.agents\teamwork\screenshots\m2_gcp_qa_panel_zoom.png` (330,121 bytes)
   - `c:\Antigravity\GatheringScans\.agents\teamwork\screenshots\m2_gcp_qa_tbm_card.png` (330,122 bytes)

---

## 2. Logic Chain

1. **Headroom Protection & Architectural Compliance**:
   Because `03-studio-core.js`, `05-studio-civil-inspectors.js`, and `08-advanced-surveying-and-qa.js` are all within 150 lines of the 5,000-line limit, all new UI rendering, Three.js 3D error vector helpers, TBM calibration UI, and CSV export logic were encapsulated in `web/src/09-construction-survey-and-bim.js` (856 lines) and `web/survey-bim.css` (250 lines). In `web/index.html`, `09-construction-survey-and-bim.js` loads immediately after `08`, safely overriding `window.openGcpAccuracyQaInspector`, `window.renderGcpQaMarkers3D`, `window.clearGcpQaMarkers3D`, and `window.handleGcpQa3DPick`.

2. **Backend 3D Spatial Math & Invariants**:
   In `pc_worker/surveying/dsm_and_volume.py`:
   - `compute_gcp_accuracy_qa` supports both Check Point mode (DSM sampling) and Paired Target mode (extracting `mesh_e`/`mesh_n`/`mesh_h`).
   - Residual vectors satisfy the Euclidean invariant: $d3D^2 = dE^2 + dN^2 + dH^2$.
   - RMSE metrics satisfy the geometric invariant: $\text{RMSE}_{3D}^2 = \text{RMSE}_{2D}^2 + \text{RMSE}_H^2 = \text{RMSE}_E^2 + \text{RMSE}_N^2 + \text{RMSE}_H^2$.
   - Sample standard deviations ($\sigma_E, \sigma_N, \sigma_H$) are calculated with $N-1$ degrees of freedom and protected with an $N=1$ guard to prevent division by zero.
   - Positional accuracies strictly follow ASPRS 2014 formulas (1.9600 for vertical, 1.7308 for horizontal, 1.6140 for 3D).
   - All legacy response keys (`points`, `rmse_z_m`, `rmse_z_cm`, `qa_grade`, `qa_grade_label`, `csv_url`, `html_url`) are preserved alongside new 3D fields (`gcp_residuals`, `rmse_e`, `rmse_n`, `rmse_h`, `rmse_2d`, `rmse_3d`, `accuracy_z_95_m`, `accuracy_r_95_m`, `accuracy_3d_95_m`, `mean_bias_e`, `mean_bias_n`, `mean_bias_h`, `tbm_calibration_preview`).

3. **1-Click TBM Vertical Datum Calibration & Zero-Destruction Persistence**:
   - The user selects a designated TBM point or falls back to network mean bias.
   - The proposed vertical datum shift is calculated as $-\Delta H$.
   - A live preview calculates calibrated residuals ($dH_{\text{cal}} = dH + \text{shift}$), calibrated RMSE_H, calibrated RMSE_3D, and calibrated QA grade without touching disk storage.
   - When `apply_tbm_calibration: true` is sent, `priority_queue.py` persists the calibration metadata dictionary and `vertical_datum_offset: shift` into SQLite `scans.extra_json` and updates `<project_dir>/scan_meta.json`.
   - No raw `.las`, `.ply`, `.obj`, `.glb`, or `.npz` files are overwritten (Zero-Destruction Principle).
   - Downstream functions (`calculate_cut_fill_volume`, `generate_elevation_contours`, `compute_cross_section_profile`) consume `_resolve_vertical_datum_shift` to automatically adjust vertical heights.

4. **Robustness & Adversarial Resilience**:
   - Empty input arrays (`points: []`) return `point_count: 0` with zero division guards and `rmse_3d: 0.0`.
   - Auto-generated sample points are provided when `generate_sample_points: true` is requested or on demo initial load.
   - Malformed strings, non-numeric values, and empty coordinates are safely filtered out by `safe_float`.
   - Calibration reset (`reset_calibration: true`) executes immediately even when `points: []` is submitted.

5. **Visual Verification**:
   - Automated CDP script launched headless Chrome on `http://127.0.0.1:8095/?scan=quchi_20261005_merged&tool=gcp_qa`, dismissed guest auth, requested sample point evaluation, waited for WebGL rendering, and captured real PNG screenshots verifying the full 3D scene, KPI cards, TBM calibration card, and 3D residuals table.

---

## 3. Caveats

- **No Caveats**: All dispatch requirements for Milestone 2 have been implemented and independently verified with passing tests, genuine math, live server status 200 OK, and real visual UI captures.

---

## 4. Conclusion

Milestone 2 (Control Alignment & 3D GCP Calibration) is fully implemented, verified, committed, and deployed to production:
- Backend 3D GCP residuals and statistical QA metrics are mathematically rigorous and ASPRS 2014 compliant.
- 1-Click TBM vertical datum calibration operates with zero data destruction and propagates seamlessly downstream.
- Modular frontend architecture strictly maintains all files under the 5,000-line ceiling.
- Real web screenshots are captured and cataloged in `.agents/teamwork/screenshots/`.
- Local PC server (`127.0.0.1:8095`) and live Hostinger VPS container (`scans.gatheren.cloud`) are online with 200 OK serving asset version `20261031_v219`.

---

## 5. Verification Method

### 5.1 Test Commands
Execute the automated test suites:
```powershell
python -m unittest tests/test_civil_surveying_e2e.py
python -m unittest tests/test_gathering_scans_suite.py
```
Expected result: `Ran 28 tests ... OK` and `Ran 35 tests ... OK` (Total 63 tests passing).

### 5.2 Server Health & Deployment Checks
```powershell
# Local Windows PC server
Invoke-RestMethod -Uri 'http://127.0.0.1:8095/api/status'

# Live Hostinger VPS server
Invoke-RestMethod -Uri 'https://scans.gatheren.cloud/api/status'
```
Expected result: Both endpoints return HTTP 200 with `"status": "online"` and `"daemon_running": true`.

### 5.3 Modular Architecture Ceiling Verification
```powershell
python -c "
import os
for root, dirs, files in os.walk('.'):
    if any(p in root for p in ('.git', '.agents', '__pycache__', 'node_modules')):
        continue
    for f in files:
        if f.endswith(('.py', '.js', '.css', '.html')):
            with open(os.path.join(root, f), 'r', encoding='utf-8', errors='ignore') as fp:
                cnt = sum(1 for _ in fp)
            if cnt >= 5000:
                print(f'VIOLATION: {cnt} lines in {os.path.join(root, f)}')
"
```
Expected result: 0 violations.

### 5.4 Screenshot Artifact Inspection
Inspect the generated PNG screenshots:
- `c:\Antigravity\GatheringScans\.agents\teamwork\screenshots\m2_gcp_qa_inspector.png`
- `c:\Antigravity\GatheringScans\.agents\teamwork\screenshots\m2_gcp_qa_panel_zoom.png`
- `c:\Antigravity\GatheringScans\.agents\teamwork\screenshots\m2_gcp_qa_tbm_card.png`

### 5.5 Invalidation Conditions
- Any source file exceeding 5,000 lines.
- Overwriting or corrupting raw geometry files (`.obj`, `.glb`, `.las`, `.ply`) during calibration.
- Inconsistent sign convention where proposed shift does not equal $-\Delta H$.
