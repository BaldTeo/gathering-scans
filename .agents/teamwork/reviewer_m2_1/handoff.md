# Quality & Adversarial Review Report — Milestone 2: 3D GCP Residuals, TBM Calibration & Downstream Propagation

**Reviewer**: `reviewer_m2_1` (M2 Math & Downstream Propagation Reviewer)  
**Roles**: `reviewer`, `critic`  
**Date**: 2026-10-31  
**Working Directory**: `c:\Antigravity\GatheringScans\.agents\teamwork\reviewer_m2_1\`  
**Target Recipient / Parent**: `35a7b3c4-959a-4d2b-a4b5-21fb2891dea3`  
**Target Commit**: `3d56be2`  
**Verdict**: **APPROVE**  

---

## 1. Observation

### 1.1 Direct Inspection of Mathematical Implementation (`pc_worker/surveying/dsm_and_volume.py`)
- **3D Spatial Residual Math** (Lines 2001–2014):
  ```python
  de_m = round(e_scan - e_val, 4)
  dn_m = round(n_scan - n_val, 4)
  dh_m = round(h_scan - h_gcp, 4)
  d2d_m = round(math.hypot(de_m, dn_m), 4)
  d3d_m = round(math.hypot(d2d_m, dh_m), 4)

  de_cm = round(de_m * 100.0, 2)
  dn_cm = round(dn_m * 100.0, 2)
  dh_cm = round(dh_m * 100.0, 2)
  d2d_cm = round(d2d_m * 100.0, 2)
  d3d_cm = round(d3d_m * 100.0, 2)
  dz_m = dh_m
  dz_cm = dh_cm
  ```
  Residuals are defined as $\Delta = \text{Scan} - \text{GCP}$, in units of meters (`_m`) with 4 decimal places ($0.1\text{ mm}$), and centimeters (`_cm`) with 2 decimal places ($0.1\text{ mm}$).

- **Statistical Aggregation & Singularity Guards** (Lines 2131–2152):
  ```python
  rmse_e_m = round(math.sqrt(sum(p["de"] ** 2 for p in evaluated) / n_pts), 4)
  rmse_n_m = round(math.sqrt(sum(p["dn"] ** 2 for p in evaluated) / n_pts), 4)
  rmse_h_m = round(math.sqrt(sum(p["dh"] ** 2 for p in evaluated) / n_pts), 4)
  rmse_2d_m = round(math.hypot(rmse_e_m, rmse_n_m), 4)
  rmse_3d_m = round(math.hypot(rmse_2d_m, rmse_h_m), 4)

  mean_de_m = round(sum(p["de"] for p in evaluated) / n_pts, 4)
  mean_dn_m = round(sum(p["dn"] for p in evaluated) / n_pts, 4)
  mean_dh_m = round(sum(p["dh"] for p in evaluated) / n_pts, 4)

  if n_pts > 1:
      std_de_m = round(math.sqrt(sum((p["de"] - mean_de_m) ** 2 for p in evaluated) / (n_pts - 1)), 4)
      std_dn_m = round(math.sqrt(sum((p["dn"] - mean_dn_m) ** 2 for p in evaluated) / (n_pts - 1)), 4)
      std_dh_m = round(math.sqrt(sum((p["dh"] - mean_dh_m) ** 2 for p in evaluated) / (n_pts - 1)), 4)
  else:
      std_de_m = std_dn_m = std_dh_m = 0.0
  ```
  Sample standard deviations strictly use $N-1$ degrees of freedom with an explicit guard `if n_pts > 1:` returning `0.0` when $N=1$, preventing any `ZeroDivisionError`.

- **ASPRS 2014 95% Confidence Positional Accuracies** (Lines 2155–2157):
  ```python
  conf_95_h_m = round(1.9600 * rmse_h_m, 4)
  conf_95_2d_m = round(1.7308 * rmse_2d_m, 4)
  conf_95_3d_m = round(1.6140 * rmse_3d_m, 4)
  ```
  Multipliers $1.9600$ (vertical 1D normal), $1.7308$ (horizontal 2D circular normal $2.4477/\sqrt{2}$), and $1.6140$ (3D spherical normal $\sqrt{7.8147/3}$) conform to ASPRS 2014 Positional Accuracy Standards.

- **1-Click TBM Vertical Datum Calibration Math** (Lines 2184–2212):
  ```python
  if tbm_pt is not None:
      tbm_mode = "designated"
      tbm_point_id = tbm_pt["name"]
      proposed_shift_m = round(-tbm_pt["dh"], 4)
  else:
      tbm_mode = "network_mean"
      tbm_point_id = None
      proposed_shift_m = round(-mean_dh_m, 4)

  for p in evaluated:
      h_scan_cal = round(p["h_scan"] + proposed_shift_m, 3)
      dh_cal = round(p["dh"] + proposed_shift_m, 4)
      d3d_cal = round(math.hypot(p["d2d"], dh_cal), 4)
      ...
  cal_rmse_h_m = round(math.sqrt(sum(dh ** 2 for dh in calibrated_dh_list) / n_pts), 4)
  cal_rmse_3d_m = round(math.hypot(rmse_2d_m, cal_rmse_h_m), 4)
  ```
  The shift is calculated as $-\Delta H$, which directly zeroes out vertical error at the benchmark or nullifies the network mean bias.

### 1.2 Downstream Propagation Inspection
- **Vertical Datum Resolver** (`pc_worker/surveying/dsm_and_volume.py:989–1046`):
  `_resolve_vertical_datum_shift` implements the resolution hierarchy:
  1. Explicit payload override: `payload['vertical_datum_offset']` or `payload['geoid_offset_override']`
  2. Database scan record extra_json: `scan['vertical_datum_offset']` or `scan['tbm_calibration']['shift_m']`
  3. Disk mirror: `project_dir/scan_meta.json`
  4. Fallback: `0.0`
- **Volume Downstream** (`pc_worker/surveying/dsm_and_volume.py:1067, 1148, 1181, 1267, 1276–1278`):
  `v_shift` is added to polygon vertices, perimeter samples, surface grid points ($z_{\text{surf}} = z_{\text{surf, raw}} + v_{\text{shift}}$), and baseline scan in `epoch_diff` ($z_{\text{base}} = z_{\text{base, raw}} + \text{cmp\_shift}$).
- **Contours Downstream** (`pc_worker/surveying/contours_and_cad.py:339, 344, 379–380`):
  `v_shift` is added to center elevation $c_h$ and applied to the DSM sub-grid (`sub_grid = sub_grid + v_shift`), correctly shifting all extracted contour polylines.
- **Profile Downstream** (`pc_worker/surveying/contours_and_cad.py:1378–1406`):
  `v_shift_curr` and `v_shift_cmp` are added to $z_{\text{start}}$, $z_{\text{end}}$, $z_{\text{curr}}$, and $z_{\text{base}}$.

### 1.3 Zero-Destruction Persistence (`pc_worker/priority_queue.py:578–644`)
`set_scan_vertical_datum_calibration` only modifies SQLite `scans.extra_json` and updates `scan_meta.json`. It does NOT touch, overwrite, or mutate any raw 3D point cloud or mesh files (`.las`, `.laz`, `.ply`, `.obj`, `.glb`, `.npz`).

### 1.4 Frontend 3D Vector Math (`web/src/09-construction-survey-and-bim.js:318–344`)
In Three.js local space:
`dx = de` ($+X = \text{East}$), `dy = dh` ($+Y = \text{Elevation Up}$), `dz = -dn` ($+Z = \text{South}$, meaning $+N = -Z$).
3D arrows (`THREE.ArrowHelper`) correctly project spatial error vectors from the GCP target position into the 3D scene with user-selectable exaggeration scaling.

### 1.5 Automated Test Suite Execution
- `python -m unittest tests/test_civil_surveying_e2e.py`
  Result: `Ran 28 tests in 0.961s ... OK`
- `python -m unittest tests/test_gathering_scans_suite.py`
  Result: `Ran 35 tests in 10.166s ... OK`
- Combined total: 63 tests passing, 0 failures, 0 errors.

### 1.6 Modular Architecture Compliance
Executed repository-wide line counter across all `.py`, `.js`, `.css`, and `.html` files:
Result: 0 violations of the 5,000-line ceiling.
`web/src/09-construction-survey-and-bim.js` is 860 lines; `web/survey-bim.css` is 250 lines.

### 1.7 Production Servers & Visual Artifacts
- Local Server (`http://127.0.0.1:8095/api/status`): HTTP 200, online, `daemon_running: true`.
- Live VPS Server (`https://scans.gatheren.cloud/api/status`): HTTP 200, online, `daemon_running: true`.
- VPS Assets: Both `/survey-bim.css?v=20261031_v219` (5,393 bytes) and `/src/09-construction-survey-and-bim.js?v=20261031_v219` (43,062 bytes) return HTTP 200 on `scans.gatheren.cloud`.
- Real screenshots verified in `.agents/teamwork/screenshots/`:
  - `m2_gcp_qa_inspector.png` (1,740,353 bytes)
  - `m2_gcp_qa_panel_zoom.png` (330,121 bytes)
  - `m2_gcp_qa_tbm_card.png` (330,122 bytes)

---

## 2. Logic Chain

1. **Residual Vector Correctness**:
   - Observations in Section 1.1 show that $dE = E_{\text{scan}} - E_{\text{gcp}}$, $dN = N_{\text{scan}} - N_{\text{gcp}}$, and $dH = H_{\text{scan}} - H_{\text{gcp}}$.
   - By Euclidean geometry, $d2D = \sqrt{dE^2 + dN^2}$ and $d3D = \sqrt{d2D^2 + dH^2} = \sqrt{dE^2 + dN^2 + dH^2}$.
   - These formulas satisfy the invariant $d3D^2 = dE^2 + dN^2 + dH^2$, which was independently verified both analytically and in `test_01_true_3d_gcp_residual_math_and_target_pairing`.

2. **Statistical Metric Rigor**:
   - The Root Mean Square Error is computed as $\sqrt{\frac{1}{N}\sum \Delta_i^2}$.
   - The planar horizontal RMSE satisfies $\text{RMSE}_{2D}^2 = \text{RMSE}_E^2 + \text{RMSE}_N^2$.
   - The spatial 3D RMSE satisfies $\text{RMSE}_{3D}^2 = \text{RMSE}_{2D}^2 + \text{RMSE}_H^2 = \text{RMSE}_E^2 + \text{RMSE}_N^2 + \text{RMSE}_H^2$.
   - Sample standard deviations use $N-1$ degrees of freedom and are guarded with an $N > 1$ condition, preventing division-by-zero errors when evaluating single check points or empty lists.
   - ASPRS 2014 multipliers ($1.9600$ for vertical, $1.7308$ for horizontal, $1.6140$ for 3D) strictly match standard geospatial confidence intervals.

3. **1-Click TBM Calibration Math & Invariance**:
   - With benchmark residual $dH_{\text{tbm}} = H_{\text{scan}} - H_{\text{tbm}}$, applying shift $-\Delta H_{\text{tbm}}$ gives $H_{\text{scan, cal}} = H_{\text{scan}} - \Delta H_{\text{tbm}} = H_{\text{tbm}}$, bringing residual to exactly $0.000\text{ m}$.
   - For network mean calibration, subtracting $\bar{\mu}_H$ produces calibrated residuals with zero mean, satisfying the analytical relation $\text{RMSE}_{\text{cal}}^2 = \text{RMSE}_{\text{raw}}^2 - \mu_H^2$. This was verified in `test_04_one_click_tbm_calibration_network_mean_bias`.

4. **Downstream Propagation Completeness**:
   - Volume, contour generation, and profile cross-sections all query `_resolve_vertical_datum_shift`.
   - In `calculate_cut_fill_volume`, adjusting $z_{\text{surf}}$ by $v_{\text{shift}}$ properly adjusts volumes relative to custom elevation planes and synchronizes epoch comparisons.
   - In `generate_elevation_contours`, adjusting `sub_grid` by $v_{\text{shift}}$ generates contour lines at the true calibrated datum.
   - In `compute_cross_section_profile`, both current and baseline elevation profiles reflect the calibrated datum.

5. **Adversarial & Architectural Robustness**:
   - Malformed coordinates, empty lists, and non-numeric strings are cleanly filtered without crashing.
   - Zero-destruction principle is maintained: SQLite and JSON metadata are updated, while original 3D geometry files remain untouched.
   - 5,000-line ceiling is preserved across all files by placing new UI and 3D vector logic into `09-construction-survey-and-bim.js`.

---

## 3. Adversarial Review & Challenge Analysis

### 3.1 Assumption Stress-Testing
- **Assumption 1: Rigid Vertical Datum Shift**:
  - *Challenge*: A single vertical shift $\Delta H$ assumes the scan's vertical error is purely translational (bias) without rotation/tilt.
  - *Mitigation*: Drone and TLS scans on typical engineering construction sites (< 500m span) predominantly suffer from vertical datum offsets (e.g., GPS base station ellipsoid vs TWVD2001 orthometric height differences). In the event of a significant planar tilt, the 3D residuals table, standard deviations ($\sigma_E, \sigma_N, \sigma_H$), and 3D visual arrow helpers immediately alert the civil surveyor to the differential gradient.
- **Assumption 2: Normal Error Distribution for ASPRS Multipliers**:
  - *Challenge*: In the presence of gross errors (blunders), assuming normal distribution for 95% confidence intervals ($1.9600 \times \text{RMSE}$) can be distorted.
  - *Mitigation*: The backend flags each point into categorical tiers (`pass` $\le 5\text{ cm}$, `warn` $\le 10\text{ cm}$, `outlier` $> 10\text{ cm}$) and computes `max_abs_dh_m` and sample standard deviations so outliers can be easily identified and excluded.
- **Assumption 3: Local Cartesian Coordinates for Three.js 3D Arrows**:
  - *Challenge*: Three.js uses a right-handed Cartesian system ($+X = \text{Right}, +Y = \text{Up}, +Z = \text{Out of screen}$). In GatheringScans, map coordinates are $+E$ (East) and $+N$ (North).
  - *Verification*: Inspected `web/src/09-construction-survey-and-bim.js:326–328`:
    `dx = de`, `dy = dh`, `dz = -dn`. This matches `lz = centerN - pn`. The 3D error vectors point in the exact physical direction of the scan error.

### 3.2 Integrity Check
- **No Hardcoded Test Bypasses**: Grep and static analysis of `pc_worker/surveying/dsm_and_volume.py` confirmed that no test-specific IDs (`test_m2_scan_01`, `BM-01`, `TBM-A`, etc.) are hardcoded.
- **Genuine Implementation**: All mathematical operations (Euclidean distance, RMSE, sample standard deviations, ASPRS confidence intervals, TBM calibration preview) are implemented using native `math` operations over dynamic inputs.
- **No Facade or Shortcuts**: Real Three.js overlays (`RingGeometry`, `ArrowHelper`), real CSV export with UTF-8 BOM, and real HTML certificate generation are present and tested.

---

## 4. Caveats

- **No Caveats**: All mathematical formulas, statistical metrics, datum calibration logic, downstream propagation paths, and modular constraints meet and exceed project specifications.

---

## 5. Conclusion

**Verdict: APPROVE**

Milestone 2 (Control Alignment & 3D GCP Calibration) has been reviewed with adversarial rigor. The mathematical formulas for 3D residuals ($dE, dN, dH, d2D, d3D$), statistical RMSEs, ASPRS 2014 95% confidence intervals, and 1-Click TBM vertical datum calibration are accurate, sound, and fully verified. Downstream datum propagation to Volume Takeoff, Elevation Contours, and Cross-Section Profiles operates seamlessly with zero destruction of raw scan data. All 63 automated tests pass, all files remain strictly under the 5,000-line ceiling, and both local and VPS deployments are online.

---

## 6. Verification Method

To independently reproduce and verify this assessment:

1. **Execute Unit & E2E Test Suites**:
   ```powershell
   python -m unittest tests/test_civil_surveying_e2e.py
   python -m unittest tests/test_gathering_scans_suite.py
   ```
   *Expected outcome*: 28 tests passing in `test_civil_surveying_e2e.py` and 35 tests passing in `test_gathering_scans_suite.py` (total 63 tests passing).

2. **Verify 5,000-Line Modular Limit**:
   ```powershell
   python -c "
   import os
   for root, dirs, files in os.walk('.'):
       if any(p in root for p in ('.git', '.agents', '__pycache__', 'node_modules')): continue
       for f in files:
           if f.endswith(('.py', '.js', '.css', '.html')):
               with open(os.path.join(root, f), 'r', encoding='utf-8', errors='ignore') as fp:
                   cnt = sum(1 for _ in fp)
               if cnt >= 5000: print('VIOLATION:', cnt, os.path.join(root, f))
   "
   ```
   *Expected outcome*: 0 violations.

3. **Verify Server Health & Assets**:
   ```powershell
   Invoke-RestMethod -Uri 'http://127.0.0.1:8095/api/status'
   Invoke-RestMethod -Uri 'https://scans.gatheren.cloud/api/status'
   ```
   *Expected outcome*: Both return HTTP 200 with `"status": "online"` and `"daemon_running": true`.
