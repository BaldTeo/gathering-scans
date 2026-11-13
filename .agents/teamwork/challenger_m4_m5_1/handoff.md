# Handoff Report — Milestone 4 & Milestone 5: Adversarial Verification

**Agent**: `challenger_m4_m5_1` (Empirical Challenger)  
**Recipient**: Orchestrator (`35a7b3c4-959a-4d2b-a4b5-21fb2891dea3`)  
**Timestamp**: 2026-10-31T07:58:00Z  
**Type**: Hard (Task Complete)  
**Verdict**: **`REQUEST_CHANGES`**

---

## 1. Observation

### 1.1 Existing Unit Test Execution
- Executed:
  ```powershell
  python -m unittest tests.test_civil_surveying_e2e.TestSurfaceFlatnessAndPlumbnessInspector tests.test_civil_surveying_e2e.TestOpenTrenchUtilityTracer tests.test_civil_surveying_e2e.TestCompareViewDeltaVVolumeTakeoff tests.test_civil_surveying_e2e.TestRTKStakeoutExportStrictENZOrder
  ```
  Result: `Ran 6 tests in 0.561s, OK`.
  *(Note: Prompt listed approximate class names `TestSurfaceFlatnessAndPlumbness`, `TestMultiEpochCompareVolumeTakeoff`, `TestRtkStakeoutSheetExport`; actual module class names are suffixed as above).*
- Executed full test suite:
  ```powershell
  python -m unittest tests/test_gathering_scans_suite.py
  ```
  Result: `Ran 39 tests in 12.223s, OK`.

### 1.2 Adversarial Challenge 1: Coordinate Inversion & Field Safety Stress Test
- Tested `pc_worker/surveying/construction_qa.py::generate_stakeout_export` and `web/src/10-construction-qa-and-stakeout.js` using asymmetrical TWD97 coordinates `(E=304123.456, N=2757890.123, Z=115.678)`:
  - **CSV Export**: Header is verbatim `PtID,Easting,Northing,Elevation,Code`. Row is `STK-A1,304123.456,2757890.123,115.678,COLUMN_C1`. Easting (~300k) is strictly column 2, Northing (~2.75M) is strictly column 3, Elevation is column 4. No axis inversion.
  - **ASCII TXT Export**: Space-delimited string `STK-A1 304123.456 2757890.123 115.678 COLUMN_C1`. Coordinates formatted strictly E, N, Z.
  - **3D AutoCAD DXF R12 Export**: Entity `POINT` group `10` is `304123.456` (Easting), group `20` is `2757890.123` (Northing), group `30` is `115.678` (Elevation). Entity `TEXT` label is offset in E and N.
  - **Printable HTML Field Sheet**: Table headers are `Design E (m)`, `Design N (m)`, `Design Z (m)`, followed by `As-Staked E`, `As-Staked N`, `As-Staked Z`, `ΔE (mm)`, `ΔN (mm)`, `ΔZ (mm)`. Values in table cells strictly order Easting before Northing.
  - **Frontend UI Table**: Rendered in `web/src/10-construction-qa-and-stakeout.js:960-962` as `${p.easting.toFixed(3)}` then `${p.northing.toFixed(3)}` then `${p.elevation.toFixed(3)}`.
  - **Result**: **PASS (ROBUST)**.

### 1.3 Adversarial Challenge 2: Numerical Stress & Degenerate Point Clouds
- **Surface Flatness Plane Fitting**:
  - *Perfect flat slab*: 100-point planar grid at Z=100.0. RMS deviation = `0.0 mm`, Pass Rate = `100.0%`, ASTM E1155 $F_F$ = `115.0` (> 100), max high/low = `0.0 mm`. **PASS**.
  - *Collinear line of points*: 10 collinear points along 3D line. SVD plane fit converges gracefully, safeguards prevent singular matrix collapse, no NaNs. **PASS**.
  - *Spherical / random 3D noise*: 50 points on spherical shell with Gaussian noise. SVD converges, RMS deviation computed without division by zero. **PASS**.
- **Wall Plumbness Tilt Ratio**:
  - *Perfect vertical wall*: Evaluated vertical wall plane at E=304950.0. Normal vector horizontal, `plumb_mm_per_m = 0.0`, `tilt_angle_deg = 0.0`, `tilt_ratio > 1:100,000`. **PASS**.
  - *Tilted wall with 10 mm/m incline*: Normal tilted at 1:100. Evaluated `plumb_mm_per_m = 10.0 mm/m`, `tilt_ratio = 1:100.0`. **PASS**.
- **Open-Trench Utility Tracer**:
  - *Zero slope*: Perfectly level pipe. `slope_pct = 0.0%`, `slope_ratio = "Level (0%)"`, `flow_dir = "Flat"`. **PASS**.
  - *Reverse slope*: Adverse gradient. `slope_pct = +2.5%`, `flow_dir = "Reverse"`. **PASS**.
  - *Zero diameter*: Payload `pipe_diameter_mm: 0.0` was safely clamped to `20.0 mm` minimum. **PASS**.

### 1.4 CRITICAL FINDING: Phantom Volume in Multi-Epoch Compare Volume
- When running `compute_compare_volume_takeoff`:
  1. *Real Scan Self-Comparison (`rosepark_20260918_merged` vs itself)*:
     ```python
     res = survey.compute_compare_volume_takeoff({
         'baseline_scan_id': 'rosepark_20260918_merged',
         'compare_scan_id': 'rosepark_20260918_merged',
     })
     ```
     - Expected: `net_volume_delta_m3 == 0.0 m³`, `site_balance.truck_trips == 0`.
     - Actual: **`net_volume_delta_m3 == 19.3 m³` (Fill)**, `fill_volume_ccm == 19.3 m³`, `site_balance.type == "Deficit Fill (Import)"`, **`truck_trips == 3`**!
  2. *Scan without DSM on disk (or Unit Test Boundary)*:
     ```python
     res = survey.compute_compare_volume_takeoff({
         'baseline_scan_id': 'test_scan_no_dsm',
         'compare_scan_id': 'test_scan_no_dsm',
     })
     ```
     - Expected: `net_volume_delta_m3 == 0.0 m³`, `truck_trips == 0`.
     - Actual: **`net_volume_delta_m3 == 23.46 m³` (Fill)**, **`truck_trips == 3`**!
- Root Cause Identified in `pc_worker/surveying/construction_qa.py`:
  - **Defect A (Centroid Drift)**: In lines 734-736:
    ```python
    ce = safe_float(scan_base.get("twd97_e"), 304952.4) or 304952.4
    cn = safe_float(scan_base.get("twd97_n"), 2757084.2) or 2757084.2
    ch = safe_float(scan_base.get("twd97_h"), 124.8) or 124.8
    ```
    Unlike `compute_surface_flatness_and_plumbness` (lines 91-94) and `trace_open_trench_utility` (lines 471-474), `compute_compare_volume_takeoff` never updates `ce, cn, ch` from `dsm_base`. For scans whose DSM centroid differs from scan metadata or scans with local coordinates, the evaluation grid drifts outside DSM bounds.
  - **Defect B (Phantom Mound on NoData/Self-Compare)**: In lines 823-829:
    ```python
    if z_b is None:
        z_b = ch + 0.05 * (curr_e - ce)
    if z_c is None:
        # Slight mound / excavation
        dist_c = math.hypot(curr_e - ce, curr_n - cn)
        z_c = z_b + 0.35 * max(0.0, 1.0 - (dist_c / 8.0))
    ```
    Whenever `_sample_dsm_elevation` returns `is_valid == False` (e.g. edge of scan, void, or missing DSM), it assigns a synthetic slope to `z_b` and a synthetic mound to `z_c`! Even when `baseline_scan_id == compare_scan_id`! This manufactures up to +23.46 m³ of phantom fill and 3 dump truck trips on an identical scan.

---

## 2. Logic Chain
1. *Observation*: The user specification (R3) mandates: "polygon-bounded ΔV Cut/Fill volume takeoff directly inside Multi-Epoch Compare View" and the challenger prompt requires: "Test multi-epoch compare volume with identical DSMs (net volume strictly 0.0 m³)".
2. *Observation*: Running `compute_compare_volume_takeoff` on `rosepark_20260918_merged` against itself produced `19.3 m³` of fill and `3` dump truck trips.
3. *Observation*: Tracing `pc_worker/surveying/construction_qa.py` showed lines 823-829 inject `z_c = z_b + 0.35 * max(0.0, 1.0 - (dist_c / 8.0))` for any cell where DSM sampling returned `None`.
4. *Logic*: In civil engineering surveying, comparing an epoch against itself (or comparing identical DSMs) is the fundamental calibration identity ($\Delta Z \equiv 0$). If NoData cells or edge cells inject phantom elevation deltas, site excavation quantities and earthwork haulage estimates will be corrupted.
5. *Conclusion*: Milestone 4 and Milestone 5 cannot be approved until `compute_compare_volume_takeoff` correctly handles NoData cells and enforces `net_volume_delta_m3 == 0.0` when identical scans/DSMs are evaluated.

---

## 3. Caveats
- Coordinate inversion testing demonstrated 100% compliance: CSV, TXT, DXF, and HTML field sheets all strictly adhere to Easting, Northing, Elevation (E, N, Z) order.
- Floor flatness ($F_F$) and wall plumbness ratio calculations behave correctly on degenerate and extreme point clouds.
- The open-trench utility tracer correctly computes stations, invert/crown offsets, and safeguards against zero diameters.
- The single-epoch analytical mock test passed only because the mock DSM had no NoData cells and monkey-patched elevation sampling across the entire polygon. Real scans with boundary NoData cells trigger the bug.

---

## 4. Conclusion
**VERDICT**: **`REQUEST_CHANGES`**

The implementation is high quality, modular, and strictly under the 5,000-line ceiling with zero Unicode emojis. However, the phantom volume bug in `compute_compare_volume_takeoff` is a mathematical flaw in earthwork estimation that fails empirical self-comparison testing.

### Required Changes for Worker (`worker_track_b_m4_m5`):
1. In `pc_worker/surveying/construction_qa.py::compute_compare_volume_takeoff`:
   - Update centroid `ce, cn, ch` from `dsm_base` when available:
     ```python
     if dsm_base is not None:
         ce = float(dsm_base.get("ce", ce))
         cn = float(dsm_base.get("cn", cn))
         ch = float(dsm_base.get("ch", ch))
     ```
   - In the grid sampling loop (around line 812):
     If real DSMs are provided and a cell has NoData in either epoch (`not vb` or `not vc`), skip the cell (`continue`) instead of synthesizing elevations.
   - If synthetic simulation mode is used (when no DSMs are available), check if `baseline_id == compare_id`:
     ```python
     if z_b is None:
         z_b = ch + 0.05 * (curr_e - ce)
     if z_c is None:
         if baseline_id == compare_id:
             z_c = z_b
         else:
             dist_c = math.hypot(curr_e - ce, curr_n - cn)
             z_c = z_b + 0.35 * max(0.0, 1.0 - (dist_c / 8.0))
     ```
   - If `baseline_id == compare_id` (identical scan comparison), assert or enforce that `dz = z_c - z_b == 0.0` for all cells so net volume delta is strictly 0.0 m³ and truck trips = 0.
2. Verify that both tests in `tests/test_challenger_m4_m5_stress.py` pass:
   ```powershell
   python -m unittest tests.test_challenger_m4_m5_stress.AdversarialM4M5StressTests.test_multi_epoch_compare_volume_no_dsm_self_compare
   python -m unittest tests.test_challenger_m4_m5_stress.AdversarialM4M5StressTests.test_multi_epoch_compare_volume_real_scan_rosepark_self_compare
   ```

---

## 5. Verification Method
To independently reproduce the findings and verify the fix:
1. **Run the Adversarial Stress Suite**:
   ```powershell
   python -m unittest tests.test_challenger_m4_m5_stress
   ```
   *Current Result*: 7 passed, 2 failed on self-compare tests (`AssertionError: 23.46 != 0.0` and `AssertionError: 19.3 != 0.0`).
   *Expected Result after Fix*: Ran 9 tests, OK (100% pass).
2. **Run Standard Civil Surveying E2E Suite**:
   ```powershell
   python -m unittest tests.test_civil_surveying_e2e.TestSurfaceFlatnessAndPlumbnessInspector tests.test_civil_surveying_e2e.TestOpenTrenchUtilityTracer tests.test_civil_surveying_e2e.TestCompareViewDeltaVVolumeTakeoff tests.test_civil_surveying_e2e.TestRTKStakeoutExportStrictENZOrder
   ```
   *Expected Result*: Ran 6 tests, OK.
3. **Run GatheringScans Full Suite**:
   ```powershell
   python -m unittest tests/test_gathering_scans_suite.py
   ```
   *Expected Result*: Ran 39 tests, OK.
