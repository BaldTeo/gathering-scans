# Milestone 2 (M2) GCP 3D Residuals & Accuracy Math Handoff Report

**Agent**: `explorer_m2_1` (M2 GCP 3D Residuals & Accuracy Math Explorer)  
**Parent**: `35a7b3c4-959a-4d2b-a4b5-21fb2891dea3` (Orchestrator)  
**Date**: 2026-10-31T05:40:00Z  
**Type**: Hard Handoff (Investigation & Specification Complete)  

---

## 1. Observation

### 1.1 Existing Endpoint & Route Dispatch
In `pc_worker/server_api_routes.py` (lines 994–1004):
```python
# 5c. Civil Surveying: Automated GCP / Check-Point Accuracy QA Report
if path in ("/api/survey/gcp-qa", "/api/surveying/gcp-qa"):
    if share_token:
        ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(
            share_token, requested_scan_id=payload.get("scan_id")
        )
        if not ok_s or not (link_s and link_s.get("allow_measurements", True)):
            self.send_json({"error": "GCP QA is disabled for this external share link."}, status=403)
            return
    res = SURVEY.compute_gcp_accuracy_qa(payload)
    self.send_json(res)
    return
```
The HTTP route `/api/survey/gcp-qa` directly delegates to `SURVEY.compute_gcp_accuracy_qa(payload)`.

### 1.2 Current Implementation in `pc_worker/surveying/dsm_and_volume.py`
In `pc_worker/surveying/dsm_and_volume.py` (lines 1776–1931):
- **Docstring**:
  ```python
  def compute_gcp_accuracy_qa(self, payload: Dict[str, Any]) -> Dict[str, Any]:
      """
      Evaluates vertical accuracy (ΔH = H_scan - H_gcp) across a list of Ground Control
      or Independent Check Points in TWD97 (121) + TWVD2001, computes RMSE_Z, Mean Bias,
      Max |ΔH|, 95% Confidence (1.96 × RMSE_Z), assigns Taiwan Surveying QA Grade (A/B/C),
      and generates CSV + Printable HTML QA Certificate in REPORTS_DIR.
      """
  ```
- **Input Coordinate Extraction (lines 1846–1867)**:
  ```python
  for idx, pt in enumerate(raw_pts):
      if isinstance(pt, dict):
          name = str(pt.get("name") or pt.get("id") or f"CP-{idx + 1:02d}").strip()
          e_val = safe_float(pt.get("e", pt.get("twd97_e", ce)))
          n_val = safe_float(pt.get("n", pt.get("twd97_n", cn)))
          h_gcp = safe_float(pt.get("h_gcp", pt.get("h", pt.get("twd97_h", ch))))
          h_scan_in = pt.get("h_scan", pt.get("mesh_h"))
  ```
  **Direct Observation**:
  - The function only extracts `h_scan_in = pt.get("h_scan", pt.get("mesh_h"))`.
  - It does **not** extract `e_scan` or `n_scan` (or `mesh_e`, `mesh_n`), even though existing test suite in `tests/test_gathering_scans_suite.py` (lines 683–685) explicitly passes `mesh_e: 304950.012`, `mesh_n: 2757079.989`, and `mesh_h: 125.418`.
- **Residual Computation (lines 1887–1890)**:
  ```python
  dz_m = round(h_scan - h_gcp, 4)
  dz_cm = round(dz_m * 100.0, 2)
  abs_cm = abs(dz_cm)
  status_tier = "pass" if abs_cm <= 5.0 else ("warn" if abs_cm <= 10.0 else "outlier")
  ```
  Only 1D vertical residual (`dz_m`) is computed. Horizontal residual (`dE`, `dN`, `d2D`) and spatial residual (`d3D`) are missing.
- **Statistical Aggregation (lines 1911–1921)**:
  ```python
  n_pts = max(1, len(evaluated))
  sq_sum = sum((p["dz_m"] ** 2) for p in evaluated)
  rmse_z_m = round(math.sqrt(sq_sum / n_pts), 4)
  rmse_z_cm = round(rmse_z_m * 100.0, 2)
  mean_err_m = round(sum(p["dz_m"] for p in evaluated) / n_pts, 4)
  mean_err_cm = round(mean_err_m * 100.0, 2)
  max_abs_m = round(max((abs(p["dz_m"]) for p in evaluated), default=0.0), 4)
  max_abs_cm = round(max_abs_m * 100.0, 2)
  conf_95_m = round(1.96 * rmse_z_m, 4)
  conf_95_cm = round(1.96 * rmse_z_cm, 2)
  ```
  Only vertical metrics (`rmse_z_m`, `mean_err_m`, `max_abs_m`, `conf_95_m`) are computed. `rmse_e`, `rmse_n`, `rmse_2d`, and `rmse_3d` are not computed.

### 1.3 Existing Regression Test Expectations
In `tests/test_gathering_scans_suite.py` (lines 673–706):
```python
gcp_res = survey.compute_gcp_accuracy_qa(
    {
        "scan_id": scan_id,
        "tolerance_3d_m": 0.05,
        "gcps": [
            {
                "id": "GCP-01",
                "e": 304950.000,
                "n": 2757080.000,
                "h": 125.400,
                "mesh_e": 304950.012,
                "mesh_n": 2757079.989,
                "mesh_h": 125.418,
            },
            {
                "id": "GCP-02",
                "e": 304985.000,
                "n": 2757110.000,
                "h": 126.850,
                "mesh_e": 304984.991,
                "mesh_n": 2757110.014,
                "mesh_h": 126.835,
            },
        ],
    }
)
self.assertEqual(gcp_res["status"], "ok")
self.assertEqual(gcp_res["point_count"], 2)
self.assertLess(gcp_res["rmse_z_m"], 0.05)
self.assertEqual(gcp_res["qa_grade"], "A")
self.assertIn("Grade A", gcp_res["qa_grade_label"])
self.assertTrue(gcp_res["csv_url"].startswith("/api/reports/"))
self.assertTrue(gcp_res["html_url"].startswith("/api/reports/"))
```
And in `tests/test_gathering_scans_suite.py` (lines 2625–2649):
```python
# Malformed input resilience
res_qa_malformed = survey.compute_gcp_accuracy_qa(
    {
        "scan_id": "quchi_20261005_merged",
        "points": [
            {"name": "CP_BAD_1", "e": "", "n": "  ", "h_gcp": "invalid"},
            {"name": "CP_BAD_2", "e": "none", "n": "null", "h_gcp": ""},
            {"name": "CP_VALID_1", "e": 304950.0, "n": 2757080.0, "h_gcp": 125.0, "h_scan": "125.04"},
        ],
    }
)
self.assertEqual(res_qa_malformed["status"], "ok")
self.assertEqual(res_qa_malformed["point_count"], 1)

res_qa_all_invalid = survey.compute_gcp_accuracy_qa(
    {
        "scan_id": "quchi_20261005_merged",
        "points": [{"name": "CP_BAD", "e": "", "n": "abc"}],
    }
)
self.assertEqual(res_qa_all_invalid["status"], "ok")
self.assertEqual(res_qa_all_invalid["point_count"], 0)
```

---

## 2. Logic Chain

### 2.1 Control Target Pairing Logic
Ground control point evaluation in photogrammetry and civil engineering operates in two distinct operational modes:
1. **Paired 3D Target Mode (GCP Target Pairing)**:
   The user (or photogrammetric bundle adjustment report) identifies specific target marks in both reference ground coordinates $(E_{\text{gcp}}, N_{\text{gcp}}, H_{\text{gcp}})$ and reconstructed photogrammetric model space $(E_{\text{scan}}, N_{\text{scan}}, H_{\text{scan}})$.
   - Reference: $E_{\text{gcp}}, N_{\text{gcp}}, H_{\text{gcp}}$ extracted from `e`/`easting`/`twd97_e`, `n`/`northing`/`twd97_n`, `h`/`elevation`/`h_gcp`/`twd97_h`.
   - Model: $E_{\text{scan}}, N_{\text{scan}}, H_{\text{scan}}$ extracted from `e_scan`/`mesh_e`, `n_scan`/`mesh_n`, `h_scan`/`mesh_h`.
2. **Independent Check Point Mode (Surface Elevation QA)**:
   The user supplies reference ground coordinates $(E_{\text{gcp}}, N_{\text{gcp}}, H_{\text{gcp}})$ without explicit model horizontal coordinates.
   - Horizontal pairing identity: $E_{\text{scan}} = E_{\text{gcp}}$ and $N_{\text{scan}} = N_{\text{gcp}}$, meaning $\Delta E = 0.0$ and $\Delta N = 0.0$.
   - Vertical elevation $H_{\text{scan}}$ is bilinearly sampled from the scan's Digital Surface Model (DSM) at $(E_{\text{gcp}}, N_{\text{gcp}})$ via `self._sample_dsm_elevation(dsm_data, e_gcp, n_gcp)`.

### 2.2 Mathematical Formulas & Standard Sign Conventions
In geodesy, surveying, and ASPRS guidelines, residual error is defined as:
$$\text{Residual} = \text{Model (Scan)} - \text{Reference (GCP)}$$
- **Easting Error**:
  $$\Delta E = E_{\text{scan}} - E_{\text{gcp}}$$
- **Northing Error**:
  $$\Delta N = N_{\text{scan}} - N_{\text{gcp}}$$
- **Elevation Error**:
  $$\Delta H = H_{\text{scan}} - H_{\text{gcp}}$$

*Sign Significance*: If $\Delta H = +0.025\text{ m}$, the scan surface is $2.5\text{ cm}$ higher than the ground benchmark. To calibrate/shift the scan datum to match the benchmark, the required vertical shift is $-\Delta H = -0.025\text{ m}$.

- **Horizontal 2D Residual Magnitude**:
  $$\Delta 2D = \sqrt{\Delta E^2 + \Delta N^2}$$
- **Spatial 3D Residual Magnitude**:
  $$\Delta 3D = \sqrt{\Delta E^2 + \Delta N^2 + \Delta H^2} = \sqrt{\Delta 2D^2 + \Delta H^2}$$

### 2.3 Statistical Accuracy QA Metrics
For $N$ valid evaluated points ($N \ge 1$):
1. **Root Mean Square Error (RMSE)**:
   $$\text{RMSE}_E = \sqrt{\frac{1}{N} \sum_{i=1}^N (\Delta E_i)^2}$$
   $$\text{RMSE}_N = \sqrt{\frac{1}{N} \sum_{i=1}^N (\Delta N_i)^2}$$
   $$\text{RMSE}_H = \sqrt{\frac{1}{N} \sum_{i=1}^N (\Delta H_i)^2} \quad (\text{equivalent to } \text{RMSE}_z)$$
   $$\text{RMSE}_{2D} = \sqrt{\text{RMSE}_E^2 + \text{RMSE}_N^2} = \sqrt{\frac{1}{N} \sum_{i=1}^N (\Delta 2D_i)^2}$$
   $$\text{RMSE}_{3D} = \sqrt{\text{RMSE}_E^2 + \text{RMSE}_N^2 + \text{RMSE}_H^2} = \sqrt{\text{RMSE}_{2D}^2 + \text{RMSE}_H^2} = \sqrt{\frac{1}{N} \sum_{i=1}^N (\Delta 3D_i)^2}$$

2. **Mean Bias (Systematic Shift)**:
   $$\mu_{\Delta E} = \frac{1}{N} \sum_{i=1}^N \Delta E_i, \quad \mu_{\Delta N} = \frac{1}{N} \sum_{i=1}^N \Delta N_i, \quad \mu_{\Delta H} = \frac{1}{N} \sum_{i=1}^N \Delta H_i$$
   A non-zero $\mu_{\Delta H}$ represents systematic vertical datum error.

3. **Sample Standard Deviation (Random Noise Dispersion)**:
   For $N > 1$:
   $$\sigma_E = \sqrt{\frac{1}{N-1} \sum_{i=1}^N (\Delta E_i - \mu_{\Delta E})^2}$$
   $$\sigma_N = \sqrt{\frac{1}{N-1} \sum_{i=1}^N (\Delta N_i - \mu_{\Delta N})^2}$$
   $$\sigma_H = \sqrt{\frac{1}{N-1} \sum_{i=1}^N (\Delta H_i - \mu_{\Delta H})^2}$$
   For $N = 1$: $\sigma_E = 0.0, \sigma_N = 0.0, \sigma_H = 0.0$.

4. **Extrema & Ranges**:
   $$\text{Max } |\Delta E| = \max_i |\Delta E_i|, \quad \text{Max } |\Delta N| = \max_i |\Delta N_i|, \quad \text{Max } |\Delta H| = \max_i |\Delta H_i|$$
   $$\text{Max } \Delta 2D = \max_i \Delta 2D_i, \quad \text{Max } \Delta 3D = \max_i \Delta 3D_i$$
   $$\text{Range}_H = [\min_i \Delta H_i, \max_i \Delta H_i]$$

5. **NSSDA / ASPRS 95% Positional Accuracy Standards**:
   - **Vertical Accuracy at 95% Confidence ($\text{LE}_{95}$)**:
     $$\text{Accuracy}_z = 1.9600 \times \text{RMSE}_H$$
   - **Horizontal Accuracy at 95% Confidence ($\text{CE}_{95}$)**:
     Under the standard NSSDA assumption that errors in $X$ and $Y$ are normally distributed with $\sigma_x \approx \sigma_y$:
     $$\text{Accuracy}_r = 2.4477 \times \frac{\text{RMSE}_{2D}}{\sqrt{2}} \approx 1.7308 \times \text{RMSE}_{2D}$$
   - **Spatial 3D Accuracy at 95% Confidence ($\text{SE}_{95}$)**:
     $$\text{Accuracy}_{3D} \approx 1.6140 \times \text{RMSE}_{3D}$$

6. **Surveying QA Grade Classification (Taiwan MOI & ASPRS Tiers)**:
   - **Grade A (RTK Survey-Grade ≤ 5.0 cm)**:
     $\text{RMSE}_H \le 0.05\text{ m}$ ($5.0\text{ cm}$) AND $\text{RMSE}_{2D} \le 0.05\text{ m}$ ($5.0\text{ cm}$).
   - **Grade B (Engineering Topographic ≤ 10.0 cm)**:
     $\text{RMSE}_H \le 0.10\text{ m}$ ($10.0\text{ cm}$) AND $\text{RMSE}_{2D} \le 0.10\text{ m}$ ($10.0\text{ cm}$).
   - **Grade C (Reconnaissance / Calibration Needed > 10.0 cm)**:
     $\text{RMSE}_H > 0.10\text{ m}$ OR $\text{RMSE}_{2D} > 0.10\text{ m}$.

### 2.4 Edge Cases & Robustness Analysis
1. **String / Empty / Null Sanitization**:
   All coordinate parameters must be sanitized via `safe_float(val)`.
   - If $E_{\text{gcp}}$ or $N_{\text{gcp}}$ cannot be resolved to a finite float, the point cannot be positioned and is skipped without raising an unhandled exception.
   - If all submitted points are invalid ($N = 0$), the function returns `status: "ok"`, `point_count: 0`, all RMSE values `0.0`, empty arrays, and does not crash with HTTP 500.
2. **Single Point ($N = 1$) Singularity**:
   When $N = 1$, standard deviation formulas have $N-1 = 0$ in the denominator. The code must guard against `ZeroDivisionError` and return `std = 0.0`.
3. **Collinear Control Points**:
   Pointwise RMSE calculation is invariant to point geometry ($\sum \Delta^2 / N$). However, if points are collinear, spatial rotation/tilt cannot be independently verified. An advisory flag `is_collinear: bool` can be provided in metadata.
4. **Out-of-Bounds Points**:
   When sampling the DSM via `_sample_dsm_elevation`, if `is_valid` is `False` and no explicit `h_scan` was provided:
   - The point lies outside the modeled photogrammetric reconstruction boundary.
   - Instead of clamping to boundary edge pixels (which introduces massive synthetic elevation errors), the point should be marked `"status": "out_of_bounds"` and excluded from RMSE statistics, with a warning emitted in the report.
5. **DSM Interpolation (Bilinear vs Nearest Neighbor)**:
   `_sample_dsm_elevation` performs bilinear interpolation between grid cells $(i_0, j_0), (i_1, j_0), (i_0, j_1), (i_1, j_1)$. When a point is near an unmodeled void or building edge, if any corner has `hull == False`, falling back to nearest neighbor among valid hull cells prevents interpolation artifacts.

---

## 3. Caveats

1. **Frontend Rendering Scope**:
   Visualizing 3D displacement vectors (e.g., Three.js `ArrowHelper` or colored error pins) in Studio mode and updating UI HTML tables is investigated by `explorer_m2_3`. This report focuses strictly on the mathematical formulas, backend data structures, and API contract.
2. **TBM Datum Persistence Scope**:
   Zero-destruction metadata persistence of TBM offsets across scan records and downstream consumption in `/api/survey/volume` is investigated by `explorer_m2_2`.
3. **Coordinate Reference System Assumption**:
   Formulas assume projected planar grid coordinates in meters (e.g., TWD97 TM2 Zone 121 Easting, Northing; UTM 51N) where Euclidean distance $\sqrt{\Delta E^2 + \Delta N^2}$ directly represents metric distances. Angular degrees (WGS84 Lat/Lon) must be converted to projected grid meters prior to residual evaluation.
4. **Sign Convention Consistency**:
   In some older external packages, residuals are defined as $\text{Truth} - \text{Measured}$. In civil photogrammetry and GatheringScans codebase, $\text{Scan} - \text{GCP}$ is strictly adhered to, so positive $\Delta H$ means the model is higher than reality.

---

## 4. Conclusion & Proposed Implementation Specification

### 4.1 Request Payload Contract
Endpoint: `POST /api/survey/gcp-qa` (or `POST /api/surveying/gcp-qa`)
```json
{
  "scan_id": "quchi_20261005_merged",
  "points": [
    {
      "id": "GCP-01",
      "e": 304950.000,
      "n": 2757080.000,
      "h": 125.400,
      "mesh_e": 304950.012,
      "mesh_n": 2757079.989,
      "mesh_h": 125.418,
      "is_tbm": false
    }
  ],
  "tolerance_3d_m": 0.05,
  "apply_tbm_calibration": false,
  "selected_tbm_id": null,
  "geoid_offset_override": null
}
```

### 4.2 Response Payload Contract (100% Backward-Compatible)
```json
{
  "status": "ok",
  "scan_id": "quchi_20261005_merged",
  "scan_name": "QuChi Dam",
  "crs": "TWD97 (121) + TWVD2001",
  "point_count": 2,
  "total_submitted": 2,

  "rmse_e_m": 0.0115,
  "rmse_e_cm": 1.15,
  "rmse_n_m": 0.0126,
  "rmse_n_cm": 1.26,
  "rmse_h_m": 0.0166,
  "rmse_h_cm": 1.66,
  "rmse_2d_m": 0.0171,
  "rmse_2d_cm": 1.71,
  "rmse_3d_m": 0.0238,
  "rmse_3d_cm": 2.38,

  "rmse_z_m": 0.0166,
  "rmse_z_cm": 1.66,

  "mean_de_m": 0.0015,
  "mean_de_cm": 0.15,
  "mean_dn_m": 0.0015,
  "mean_dn_cm": 0.15,
  "mean_dh_m": 0.0015,
  "mean_dh_cm": 0.15,
  "mean_error_m": 0.0015,
  "mean_error_cm": 0.15,

  "std_de_m": 0.0140,
  "std_dn_m": 0.0150,
  "std_dh_m": 0.0200,

  "max_abs_de_m": 0.0120,
  "max_abs_dn_m": 0.0140,
  "max_abs_dh_m": 0.0180,
  "max_abs_dz_m": 0.0180,
  "max_d2d_m": 0.0180,
  "max_d3d_m": 0.0250,

  "confidence_95_h_m": 0.0325,
  "confidence_95_h_cm": 3.25,
  "confidence_95_2d_m": 0.0296,
  "confidence_95_2d_cm": 2.96,
  "confidence_95_3d_m": 0.0384,
  "confidence_95_m": 0.0325,
  "confidence_95_cm": 3.25,

  "qa_grade": "A",
  "qa_grade_label": "Grade A (RTK Survey-Grade ≤ 5.0 cm)",

  "tbm_applied": false,
  "tbm_shift_m": 0.0,

  "gcp_residuals": [
    {
      "id": "GCP-01",
      "name": "GCP-01",
      "e_gcp": 304950.000,
      "n_gcp": 2757080.000,
      "h_gcp": 125.400,
      "e_scan": 304950.012,
      "n_scan": 2757079.989,
      "h_scan": 125.418,
      "de": 0.0120,
      "dn": -0.0110,
      "dh": 0.0180,
      "d2d": 0.0163,
      "d3d": 0.0243,
      "dz_m": 0.0180,
      "de_cm": 1.20,
      "dn_cm": -1.10,
      "dh_cm": 1.80,
      "d2d_cm": 1.63,
      "d3d_cm": 2.43,
      "dz_cm": 1.80,
      "is_tbm": false,
      "status": "pass",
      "local": [-2.4, 0.618, 4.2]
    }
  ],
  "points": [ ... ],
  "csv_url": "/api/reports/gcp_qa_quchi_20261005_merged_1761898765.csv",
  "html_url": "/api/reports/gcp_qa_quchi_20261005_merged_1761898765.html"
}
```

### 4.3 Proposed Implementation Architecture in `pc_worker/surveying/dsm_and_volume.py`
In `compute_gcp_accuracy_qa`:
1. **Coordinate extraction**:
   ```python
   e_gcp = safe_float(pt.get("e", pt.get("easting", pt.get("twd97_e", ce))))
   n_gcp = safe_float(pt.get("n", pt.get("northing", pt.get("twd97_n", cn))))
   h_gcp = safe_float(pt.get("h_gcp", pt.get("h", pt.get("elevation", pt.get("twd97_h", ch)))))

   e_scan_in = pt.get("e_scan", pt.get("mesh_e", pt.get("scan_e")))
   n_scan_in = pt.get("n_scan", pt.get("mesh_n", pt.get("scan_n")))
   h_scan_in = pt.get("h_scan", pt.get("mesh_h", pt.get("scan_h")))

   e_scan = safe_float(e_scan_in, e_gcp) if e_scan_in is not None else e_gcp
   n_scan = safe_float(n_scan_in, n_gcp) if n_scan_in is not None else n_gcp
   ```
2. **Elevation resolution**:
   If `h_scan_in` is None, sample via `self._sample_dsm_elevation(dsm_data, e_scan, n_scan)`.
3. **Residual vector calculation**:
   ```python
   de_m = round(e_scan - e_gcp, 4)
   dn_m = round(n_scan - n_gcp, 4)
   dh_m = round(h_scan - h_gcp, 4)
   d2d_m = round(math.hypot(de_m, dn_m), 4)
   d3d_m = round(math.hypot(d2d_m, dh_m), 4)
   ```
4. **Statistical aggregation**:
   ```python
   n_pts = len(evaluated)
   if n_pts > 0:
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

       conf_95_h_m = round(1.9600 * rmse_h_m, 4)
       conf_95_2d_m = round(1.7308 * rmse_2d_m, 4)
       conf_95_3d_m = round(1.6140 * rmse_3d_m, 4)
   ```
5. **Grading & CSV/HTML Certificate**:
   Update CSV columns to output all 3D coordinates and residuals (`dE, dN, dH, d2D, d3D, is_tbm, status`), and update HTML certificate to display the comprehensive 3D accuracy summary card.

---

## 5. Verification Method

1. **Automated Unit Testing**:
   Run the existing suite to ensure zero regressions:
   ```powershell
   python -m unittest tests.test_gathering_scans_suite.GatheringScansTestSuite.test_08_eleven_ux_and_surveying_fixes
   python -m unittest tests.test_gathering_scans_suite.GatheringScansTestSuite.test_34_compound_coordinate_adversarial_input_resilience
   python -m unittest tests.test_gathering_scans_suite.GatheringScansTestSuite.test_07_modular_architecture_strict_5000_line_ceiling
   ```
2. **New M2 3D GCP Verification Test**:
   The implementer should add a unit test in `tests/test_gathering_scans_suite.py` asserting:
   - Given points with known `(e, n, h)` and `(mesh_e, mesh_n, mesh_h)`:
     - Verified: $\Delta E = \text{mesh\_e} - e$, $\Delta N = \text{mesh\_n} - n$, $\Delta H = \text{mesh\_h} - h$.
     - Verified: $\Delta 2D = \sqrt{\Delta E^2 + \Delta N^2}$, $\Delta 3D = \sqrt{\Delta 2D^2 + \Delta H^2}$.
     - Verified: $\text{RMSE}_{3D} = \sqrt{\text{RMSE}_E^2 + \text{RMSE}_N^2 + \text{RMSE}_H^2}$.
     - Verified: $\text{Accuracy}_r = 1.7308 \times \text{RMSE}_{2D}$, $\text{Accuracy}_z = 1.9600 \times \text{RMSE}_H$.
   - Given adversarial inputs:
     - Missing/null strings parsed safely.
     - $N=1$ executes without division by zero on standard deviations.
     - $N=0$ returns `status: "ok"` and `point_count: 0`.
3. **Independent Mathematical Invariant**:
   The implementer can verify the mathematical invariant:
   $$\text{RMSE}_{3D}^2 \equiv \text{RMSE}_{2D}^2 + \text{RMSE}_H^2 \equiv \text{RMSE}_E^2 + \text{RMSE}_N^2 + \text{RMSE}_H^2$$
   within numerical floating-point precision ($< 10^{-6}$).

---
*Report authored by `explorer_m2_1`. Ready for implementer adoption in Milestone 2.*
