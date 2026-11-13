# Handoff Report — M1 API & UI Independent Review (Iteration 2)

- **Agent**: `reviewer_m1_iter2_2` (M1 API & UI Reviewer & Critic)
- **Roles**: `reviewer`, `critic`
- **Working Directory**: `c:\Antigravity\GatheringScans\.agents\teamwork\reviewer_m1_iter2_2\`
- **Milestone**: Milestone 1 Remediation (R2 Core Surveying & Earthwork Math)
- **Parent Conversation ID**: `35a7b3c4-959a-4d2b-a4b5-21fb2891dea3`
- **Date**: 2026-10-31T04:56:00Z
- **Verdict**: **REQUEST_CHANGES**

---

## 1. Observation

### Obs 1: Unhandled Server 500 Crashes on Empty Strings & Malformed Tokens in Endpoint Coordinate Structures
While scalar parameters (`swell_factor`, `shrinkage_factor`, `density_t_m3`, `truck_volume_m3`, `truck_max_tonnes`, `geoid_offset_override`, `offset_x/y/z`) now use `safe_float()`, multiple endpoint parsers still perform direct `float()` casts on user-supplied compound dictionaries and coordinate arrays, causing unhandled 500 `ValueError` crashes:

1. **`/api/survey/gcp-qa` (`compute_gcp_accuracy_qa`) in `pc_worker/surveying/dsm_and_volume.py` (lines 1821–1824, 1828–1830, 1834–1836, 1842)**:
   ```python
   1821: e_val = float(pt.get("e", pt.get("twd97_e", ce)))
   1822: n_val = float(pt.get("n", pt.get("twd97_n", cn)))
   1823: h_gcp = float(pt.get("h_gcp", pt.get("h", pt.get("twd97_h", ch))))
   ...
   1842: h_scan = float(h_scan_in)
   ```
   **Verbatim Error**:
   When passed `{"scan_id": "quchi_20261005_merged", "points": [{"name": "CP1", "e": "", "n": "  ", "h_gcp": "invalid"}]}`, the server throws:
   ```
   ValueError: could not convert string to float: ''
   at pc_worker/surveying/dsm_and_volume.py:1821, in compute_gcp_accuracy_qa
   ```

2. **`/api/survey/volume` (`calculate_cut_fill_volume`) in `pc_worker/surveying/dsm_and_volume.py` (lines 1060–1061, 1069–1070)**:
   ```python
   1060: px = float(pt.get("x", pt.get("e", 0.0)))
   1061: py = float(pt.get("z", pt.get("n", 0.0)))
   ...
   1069: px = float(pt[0])
   1070: py = float(pt[1])
   ```
   **Verbatim Error**:
   When passed `{"scan_id": "quchi_20261005_merged", "polygon": [{"x": "", "z": "  "}]}`, the server throws:
   ```
   ValueError: could not convert string to float: ''
   at pc_worker/surveying/dsm_and_volume.py:1060, in calculate_cut_fill_volume
   ```

3. **`/api/survey/contours` (`generate_elevation_contours`) in `pc_worker/surveying/contours_and_cad.py` (lines 332–333) and `_normalize_mask_polygon_twd97` in `pc_worker/surveying/dsm_and_volume.py` (lines 1679–1681, 1693–1695)**:
   ```python
   332: minor_interval = max(float(payload.get("minor_interval_m", 0.5)), 0.1)
   333: major_interval = max(float(payload.get("major_interval_m", minor_interval * 5.0)), minor_interval)
   ```
   **Verbatim Error**:
   When passed `{"scan_id": "quchi_20261005_merged", "minor_interval_m": ""}`, the server throws:
   ```
   ValueError: could not convert string to float: ''
   at pc_worker/surveying/contours_and_cad.py:332, in generate_elevation_contours
   ```

4. **`/api/survey/profile` (`compute_cross_section_profile`) in `pc_worker/surveying/contours_and_cad.py` (lines 1347–1348)**:
   ```python
   1347: px = float(pt_val.get("x", pt_val.get("e", 0.0)))
   1348: pz = float(pt_val.get("z", pt_val.get("n", 0.0)))
   ```
   **Verbatim Error**:
   When passed `{"scan_id": "quchi_20261005_merged", "start_point": {"x": "", "z": "  "}}`, the server throws:
   ```
   ValueError: could not convert string to float: ''
   at pc_worker/surveying/contours_and_cad.py:1347, in compute_cross_section_profile
   ```

5. **`/api/survey/inspect-photos` (`inspect_rtk_camera_photos`) in `pc_worker/surveying/contours_and_cad.py` (lines 2473–2475, 2536)**:
   ```python
   2473: click_x = float(payload.get("x", 0.0))
   2474: click_y = float(payload.get("y", 0.0))
   2475: click_z = float(payload.get("z", 0.0))
   2536: max_radius_m = float(payload.get("max_radius_m") or 45.0)
   ```
   **Verbatim Error**:
   When passed `{"scan_id": "quchi_20261005_merged", "x": "", "y": "  ", "z": "bad"}`, the server throws:
   ```
   ValueError: could not convert string to float: ''
   at pc_worker/surveying/contours_and_cad.py:2473, in inspect_rtk_camera_photos
   ```

6. **`/api/optimizer/generate-scan` (`run_generate_scan_action`) in `pc_worker/optimizer_bridge.py` (lines 3183–3184)**:
   ```python
   3183: keep_min_z = float(crop_keep.get("min_elev", -9999.0))
   3184: keep_max_z = float(crop_keep.get("max_elev", 9999.0))
   ```
   **Verbatim Error**:
   When passed `{"scan_id": "quchi_20261005_merged", "crop_keep": {"min_elev": "", "max_elev": "bad"}}`, the server throws:
   ```
   ValueError: could not convert string to float: ''
   at pc_worker/optimizer_bridge.py:3183, in run_generate_scan_action
   ```

### Obs 2: Frontend UI Custom Earthwork Parameters & Results Rendering
- In `web/src/09-construction-survey-and-bim.js` (lines 44–98, 104–120, 125–211):
  - `renderEarthworkInputFieldsHtml(defaultDatumZ)` correctly renders input fields for `volSwellFactor`, `volShrinkFactor`, `volTruckVolumeM3`, and `volTruckMaxTonnes`.
  - `getEarthworkInputValues(defaultDatumZ)` extracts and sanitizes these values via `safeParseFloat()`.
  - `renderMassConservationScheduleHtml(res)` renders Bank Volume (BCM), Loose Volume (LCM), Compacted Volume (CCM), Cut Mass, Fill Mass, Net Haul Site Balance, Truck Haul Trips (Cut & Net), Volume-limited vs. Weight-limited pill indicator, and Best-Fit Plane slope %, slope degrees, azimuth, and plane equation.
- In `web/src/05-studio-civil-inspectors.js`:
  - `openCutFillVolumeInspector` embeds `renderEarthworkInputFieldsHtml(defaultDatumZ)` (line 743).
  - Background calculation gathers parameters via `getEarthworkInputValues` (line 903) and transmits them in `opts` to `/api/survey/volume` (line 968).
  - `renderVolumeResultAnd3D` embeds `renderMassConservationScheduleHtml(res)` (line 1104).
- `web/index.html` (line 2400) and `web/sw.js` (line 23) properly load `/src/09-construction-survey-and-bim.js?v=20261031_v218`.

### Obs 3: Test Hermeticity
- In `tests/test_gathering_scans_suite.py`:
  - `setUp()` calls `self._ensure_test_scan("quchi_20261005_merged")` (line 58).
  - `test_30`, `test_31`, `test_32`, and `test_33` each call `self._ensure_test_scan("quchi_20261005_merged")` at the top of the test method.
  - Guarantees zero reliance on uncommitted external `data/gdrive_cloud_manifest.json` files or dirty SQLite state.

### Obs 4: Test Suite Execution Results
- `python -m unittest tests/test_gathering_scans_suite.py`:
  ```
  Ran 33 tests in 9.753s
  OK
  ```
- `python -m unittest tests/test_civil_surveying_e2e.py`:
  ```
  Ran 22 tests in 0.314s
  OK
  ```
- `python c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m1_1\test_m1_empirical_adversarial.py -v`:
  ```
  Ran 18 tests in 0.380s
  OK
  ```

### Obs 5: Strict 5,000-Line Modular File Ceiling
- Verified across all 61 repository source files (`.py`, `.js`, `.css`, `.html`):
  - `web/src/03-studio-core.js`: 4,996 lines (< 5,000)
  - `web/src/05-studio-civil-inspectors.js`: 4,987 lines (< 5,000)
  - `web/src/04-studio-lasso-and-edits.js`: 4,939 lines (< 5,000)
  - `web/app.css`: 4,852 lines (< 5,000)
  - `web/src/08-advanced-surveying-and-qa.js`: 4,851 lines (< 5,000)
  - `web/src/09-construction-survey-and-bim.js`: 219 lines (< 5,000)
  - `pc_worker/optimizer_bridge.py`: 4,220 lines (< 5,000)
  - `pc_worker/surveying/dsm_and_volume.py`: 2,195 lines (< 5,000)
  - `pc_worker/surveying/contours_and_cad.py`: 2,743 lines (< 5,000)
  - `tests/test_gathering_scans_suite.py`: 2,622 lines (< 5,000)
  - **Zero violations detected** across all 61 files.

---

## 2. Logic Chain

1. **Step 2.1 — Evaluation of Mathematical Implementation**:
   - The collinearity and eigenvalue condition safeguard:
     `lambda_min = (2.0 * det_plane) / (trace_plane + math.sqrt(disc_plane)) if trace_plane > 1e-6 else 0.0`
     `if det_plane <= 0.0 or lambda_min < 1e-4 or (lambda_min / trace_plane) < 1e-4 or trace_plane < 1e-6:`
     was tested against 18 empirical adversarial scenarios including 100m collinear lines at 35°, 89.99° vertical terrain, and micro-polygons. All passed without division-by-zero or condition explosion (Obs 4).
   - Mass conservation calculations (BCM, LCM, CCM, conserved tonnes) and the dual-constraint truck estimator (volume-limited vs. weight-limited) correctly implement physical identities.
   - No integrity violations or hardcoded test facades were found in the algorithms.

2. **Step 2.2 — Evaluation of Frontend UI Integration**:
   - `web/src/09-construction-survey-and-bim.js` and `web/src/05-studio-civil-inspectors.js` cleanly expose and transmit swell factor, shrinkage factor, truck volume capacity, and legal payload limit (Obs 2).
   - Modular file ceiling compliance is preserved without breaching the 5,000-line limit (Obs 5).

3. **Step 2.3 — Evaluation of Test Hermeticity**:
   - `tests/test_gathering_scans_suite.py` hermetically provisions test scan records in memory via `_ensure_test_scan()` without leaking external file dependencies (Obs 3).

4. **Step 2.4 — Evaluation of Input Sanitization and 500 Crash Resilience**:
   - The task specifically mandates:
     *"Review `safe_float(val, default=None)` across `dsm_and_volume.py` and `optimizer_bridge.py`. Verify that all endpoints (`/api/survey/volume`, `/api/survey/gcp-qa`, etc.) safely handle empty strings, whitespace, null/undefined, and malformed numeric parameters without throwing 500 `ValueError`."*
   - As observed in Obs 1, empirical testing demonstrated that while scalar fields were updated with `safe_float()`, compound structures containing coordinate points and numeric intervals (`points` in `/api/survey/gcp-qa`, `polygon` in `/api/survey/volume`, `minor_interval_m` in `/api/survey/contours`, `start_point` in `/api/survey/profile`, `x/y/z` in `/api/survey/inspect-photos`, and `crop_keep` in `/api/optimizer/generate-scan`) still perform direct `float()` casts.
   - When requests containing empty strings (`""`), whitespace (`"  "`), or non-numeric tokens are sent to these endpoints, the server crashes with unhandled 500 `ValueError`.
   - Therefore, the requirement to safely handle empty/whitespace/malformed numeric inputs across all endpoints is NOT fully satisfied.

---

## 3. Caveats

- **No Caveats on Math or UI Layout**: Least-squares best-fit plane, mass conservation formulas, and Three.js frontend inspectors are robust and verified.
- **Scope of Changes Needed**: The required remediation is strictly confined to replacing bare `float()` casts with `safe_float()` across the identified dictionary/array extraction points in `pc_worker/surveying/dsm_and_volume.py`, `pc_worker/surveying/contours_and_cad.py`, and `pc_worker/optimizer_bridge.py`.

---

## 4. Conclusion

**Verdict: REQUEST_CHANGES**

### Actionable Remediation Items Required:
1. In `pc_worker/surveying/dsm_and_volume.py`:
   - In `compute_gcp_accuracy_qa` (lines 1821–1842): Replace bare `float()` calls on `e`, `n`, `h_gcp`, `h_scan` with `safe_float(..., default=...)`. Discard or gracefully handle points with invalid coordinates.
   - In `calculate_cut_fill_volume` (lines 1060–1070): Replace bare `float()` on polygon vertex `x`, `z`, `e`, `n` with `safe_float(..., default=None)`. Skip points with invalid coordinates; if fewer than 3 valid points remain, return error or fallback cleanly.
   - In `_normalize_mask_polygon_twd97` (lines 1679–1695): Use `safe_float()` for `x`, `y`, `z`, `e`, `n`, `h`.
   - In `compute_drainage_and_slope` (line 2022): Sanitize `payload.get("grid_size")` with `safe_float()` or strip whitespace before converting to `int`.
2. In `pc_worker/surveying/contours_and_cad.py`:
   - In `generate_elevation_contours` (lines 332–333): Use `safe_float(payload.get("minor_interval_m"), 0.5)` and `safe_float(payload.get("major_interval_m"), ...)`.
   - In `compute_cross_section_profile` (lines 1347–1355): Use `safe_float()` when parsing `start_point` and `end_point`.
   - In `inspect_rtk_camera_photos` (lines 2473–2475, 2536): Use `safe_float()` for `x`, `y`, `z`, and `max_radius_m`.
3. In `pc_worker/optimizer_bridge.py`:
   - In `run_generate_scan_action` (lines 3183–3184): Use `safe_float(crop_keep.get("min_elev"), -9999.0)` and `safe_float(crop_keep.get("max_elev"), 9999.0)`.
   - In lines 1781, 3155, 3177: Use `safe_float()` when parsing polygon vertices and reference centers.
4. Add comprehensive unit tests in `tests/test_gathering_scans_suite.py` verifying that passing empty strings (`""`), whitespace (`"  "`), `null`, and `"invalid"` to `/api/survey/gcp-qa`, `/api/survey/volume`, `/api/survey/contours`, `/api/survey/profile`, and `/api/optimizer/generate-scan` return `status: "ok"` or standard validation error responses without 500 `ValueError` exceptions.

---

## 5. Verification Method

To verify these findings and check subsequent remediation:

1. **Reproduce Endpoint ValueError Crashes**:
   ```powershell
   python -c "
   from pc_worker.surveying_engine import SurveyingEngine
   from pc_worker.optimizer_bridge import OptimizerBridge
   from pc_worker.priority_queue import ScanQueueDB
   db = ScanQueueDB()
   engine = SurveyingEngine(db)
   opt = OptimizerBridge(db)

   endpoints = [
       ('gcp_qa', lambda: engine.compute_gcp_accuracy_qa({'scan_id': 'quchi_20261005_merged', 'points': [{'name': 'CP1', 'e': '', 'n': '  ', 'h_gcp': 'invalid'}]})),
       ('volume_poly', lambda: engine.calculate_cut_fill_volume({'scan_id': 'quchi_20261005_merged', 'polygon': [{'x': '', 'z': '  '}, {'x': 10, 'z': 10}, {'x': 20, 'z': 0}]})),
       ('contours_interval', lambda: engine.generate_elevation_contours({'scan_id': 'quchi_20261005_merged', 'minor_interval_m': ''})),
       ('profile_start', lambda: engine.compute_cross_section_profile({'scan_id': 'quchi_20261005_merged', 'start_point': {'x': '', 'z': '  '}})),
       ('inspect_photos', lambda: engine.inspect_photos_at_point({'scan_id': 'quchi_20261005_merged', 'x': '', 'y': '  ', 'z': 'bad'})),
       ('opt_crop_keep', lambda: opt.run_generate_scan_action({'scan_id': 'quchi_20261005_merged', 'crop_keep': {'min_elev': '', 'max_elev': 'bad'}}))
   ]

   for name, fn in endpoints:
       try:
           fn()
           print(f'PASS: {name}')
       except Exception as e:
           print(f'FAIL (500 crash): {name} -> {type(e).__name__}: {e}')
   "
   ```

2. **Run Full Test Suites**:
   ```powershell
   python -m unittest tests/test_gathering_scans_suite.py
   python -m unittest tests/test_civil_surveying_e2e.py
   python c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m1_1\test_m1_empirical_adversarial.py -v
   ```

3. **Verify Modular Line Count Compliance**:
   ```powershell
   python -c "
   import os
   for root, dirs, files in os.walk(r'C:\Antigravity\GatheringScans'):
       dirs[:] = [d for d in dirs if d not in ('.git', 'data', 'node_modules', '__pycache__', '.agent')]
       for fn in files:
           if fn.endswith(('.py', '.js', '.css', '.html')):
               fp = os.path.join(root, fn)
               with open(fp, 'r', encoding='utf-8', errors='ignore') as f:
                   lines = sum(1 for _ in f)
               if lines >= 5000:
                   print(f'VIOLATION: {fp} has {lines} lines')
   print('Line count check complete.')
   "
   ```
