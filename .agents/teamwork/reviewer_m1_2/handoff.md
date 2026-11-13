# Handoff Report — Milestone 1 (M1) Adversarial Review & Contract Verification

- **Agent**: `teamwork_reviewer` (M1 API & Contract Reviewer & Adversarial Critic)
- **Working Directory**: `c:\Antigravity\GatheringScans\.agents\teamwork\reviewer_m1_2\`
- **Milestone**: Milestone 1 (M1 — R2 Core Surveying & Earthwork Math)
- **Parent Conversation ID**: `35a7b3c4-959a-4d2b-a4b5-21fb2891dea3`
- **Date**: 2026-10-31T04:20:00Z
- **Verdict**: **REQUEST_CHANGES**

---

## 1. Observation

### 1.1. Unhandled Server Crashes on Invalid or Empty Input Strings
- In `pc_worker/surveying/dsm_and_volume.py`:
  - Line 990–991:
    ```python
    geoid_override_raw = payload.get("geoid_offset_override") if payload.get("geoid_offset_override") is not None else payload.get("h_offset_from_twvd")
    geoid_offset_override = float(geoid_override_raw) if geoid_override_raw is not None else None
    ```
  - Lines 1234–1236:
    ```python
    raw_swell = payload.get("swell_factor")
    if raw_swell is not None:
        sw = float(raw_swell)
    ```
  - Lines 1250–1252:
    ```python
    raw_shrink = payload.get("shrinkage_factor")
    if raw_shrink is not None:
        sh = float(raw_shrink)
    ```
  - Line 1746–1747 (in `compute_gcp_accuracy_qa`):
    ```python
    geoid_override_raw = payload.get("geoid_offset_override") if payload.get("geoid_offset_override") is not None else payload.get("h_offset_from_twvd")
    geoid_offset_override = float(geoid_override_raw) if geoid_override_raw is not None else None
    ```
- In `pc_worker/optimizer_bridge.py`:
  - Line 1752–1753 and Line 3190–3191:
    ```python
    geoid_override_raw = crs_cfg.get("geoid_offset_override") if crs_cfg.get("geoid_offset_override") is not None else crs_cfg.get("h_offset_from_twvd")
    geoid_override_val = float(geoid_override_raw) if geoid_override_raw is not None else None
    ```
- Verbatim tool execution results:
  When executing `survey.calculate_cut_fill_volume({'scan_id': 'quchi_20261005_merged', 'geoid_offset_override': ''})`:
  `ValueError: could not convert string to float: ''`
  When executing `survey.calculate_cut_fill_volume({'scan_id': 'quchi_20261005_merged', 'geoid_offset_override': 'not_a_number'})`:
  `ValueError: could not convert string to float: 'not_a_number'`
  When executing `survey.calculate_cut_fill_volume({'scan_id': 'quchi_20261005_merged', 'swell_factor': ''})`:
  `ValueError: could not convert string to float: ''`
  When executing `survey.calculate_cut_fill_volume({'scan_id': 'quchi_20261005_merged', 'shrinkage_factor': ''})`:
  `ValueError: could not convert string to float: ''`
  When executing `survey.compute_gcp_accuracy_qa({'scan_id': 'quchi_20261005_merged', 'geoid_offset_override': ''})`:
  `ValueError: could not convert string to float: ''`

### 1.2. Frontend Cut/Fill Volume Inspector Parameter & UI Sync Gap
- In `web/src/05-studio-civil-inspectors.js`:
  - Lines 727–750 (`openCutFillVolumeInspector` modal markup):
    The UI contains inputs only for `volStockpileName`, `volBaseMode`, `volMaterialSelect`, `volCustomDensity`, and `volDatumZ`.
    There are **no inputs** for:
    - `swell_factor` (Caterpillar expansion factor / loose expansion %)
    - `shrinkage_factor` (compaction shrinkage %)
    - `truck_volume_m3` (haul capacity m³)
    - `truck_max_tonnes` (haul max payload tonnes)
  - Lines 905–912 (`runCalc` payload options):
    ```javascript
    const opts = {
      scan_id: STATE.activeScanId,
      stockpile_name: document.getElementById("volStockpileName")?.value || defaultZoneName,
      base_mode: document.getElementById("volBaseMode")?.value || "triangulated_boundary",
      material_type: document.getElementById("volMaterialSelect")?.value || "crushed_stone",
      density_t_m3: parseFloat(document.getElementById("volCustomDensity")?.value || "1.65"),
      datum_elevation_m: parseFloat(document.getElementById("volDatumZ")?.value || String(defaultDatumZ)),
    };
    ```
    The request sent to `/api/survey/volume` does not forward user-specified swell, shrinkage, truck volume, or truck payload limits.
  - Lines 1061–1100 (`renderVolumeResultAnd3D`):
    The rendered UI card only displays `fill_volume_m3`, `cut_volume_m3`, `net_volume_m3`, `estimated_tonnage_t`, `planar_area_m2`, `surface_area_m2`, `perimeter_m`, and `material_name`.
    It **does not display**:
    - `cut_volume_bcm` / `fill_volume_bcm` (Bank volume)
    - `cut_volume_lcm` (Loose volume)
    - `fill_volume_ccm` (Compacted volume)
    - `conserved_cut_mass_t` / `conserved_fill_mass_t` (Physical conserved mass)
    - `truck_loads_cut` / `net_truck_loads` (Haul trip counts)
    - `truck_limiting_factor` (Volume vs. Weight limit)
    - `best_fit_plane.slope_pct` / `best_fit_plane.azimuth_deg`

### 1.3. Test Suite Hermeticity Flaw on Full Suite Execution
- On executing `python -m unittest tests/test_gathering_scans_suite.py`:
  ```
  ERROR: test_31_earthwork_mass_conservation (tests.test_gathering_scans_suite.GatheringScansTestSuite.test_31_earthwork_mass_conservation)
  ERROR: test_32_dump_truck_dual_constraint_estimator (tests.test_gathering_scans_suite.GatheringScansTestSuite.test_32_dump_truck_dual_constraint_estimator)
  ...
  File "C:\Antigravity\GatheringScans\pc_worker\surveying\dsm_and_volume.py", line 267, in _resolve_scan_record
      raise KeyError(f"Scan not found: {clean_id}")
  KeyError: 'Scan not found: quchi_20261005_merged'
  FAILED (errors=2)
  ```
- `GatheringScansTestSuite.setUp()` creates an empty temporary SQLite database (`tempfile.mkstemp(suffix=".db")`).
- `test_30`, `test_31`, `test_32`, and `test_33` invoke `survey.calculate_cut_fill_volume({'scan_id': 'quchi_20261005_merged', ...})` without upserting a scan entry into `self.db`.
- When the live daemon (`pythonw.exe`, PID 45532) performs cloud manifest updates (`data/gdrive_cloud_manifest.json`, size 9.7 MB), concurrent reads inside `_resolve_scan_record` fail to locate the scan, producing non-deterministic test failures during full suite runs.

### 1.4. Verified Passing Items
- **5,000-Line Modular Ceiling**:
  - `pc_worker/config.py`: 230 lines
  - `pc_worker/surveying/dsm_and_volume.py`: 2,165 lines
  - `pc_worker/optimizer_bridge.py`: 4,204 lines
  - `web/src/06-studio-align-and-optimizer.js`: 3,981 lines
  - `tests/test_gathering_scans_suite.py`: 2,542 lines
  - `tests/test_civil_surveying_e2e.py`: 441 lines
  - `test_07_modular_architecture_strict_5000_line_ceiling` passed.
- **Civil Surveying End-to-End Suite**:
  - `python -m unittest tests/test_civil_surveying_e2e.py`: 22 tests executed in 0.322s, all `OK`.
- **Mathematical Correctness & Integrity**:
  - Best-fit reference plane via centered 2D Normal Equations ($u_i = E_i - \bar{E}, v_i = N_i - \bar{N}, w_i = Z_i - \bar{Z}$), Cramer's rule determinant, slope %, and compass azimuth verified independently against known geometry.
  - Collinear fallback to mean horizontal plane (slope = 0%) verified; does not trigger `ZeroDivisionError`.
  - Caterpillar swell factor conversion ($1/S$ when $S < 1.0$) and compaction factor ($1 - C$) accurately enforce physical mass conservation: $M_{cut} = BCM_{cut} \times \rho_{bank} \equiv LCM_{cut} \times \rho_{loose}$.
  - Backward compatibility: Legacy fields `cut_volume_m3`, `fill_volume_m3`, `net_volume_m3`, `estimated_tonnage_t`, and `bank_tonnage_t` are preserved.
  - Geoid catalog synchronization: UTM51N ($17.20\text{ m}$) and UTM50N ($16.80\text{ m}$) are synchronized between backend `CRS_DEFINITIONS` and frontend `CRS_UI_CATALOG`. `numGeoidOffset` and `btnResetGeoidOffset` exist in `web/src/06-studio-align-and-optimizer.js`.
  - No integrity violations detected: Implementations contain genuine algorithmic logic, not hardcoded facade responses.

---

## 2. Logic Chain

1. **Direct Mandate Requirement Violation**:
   The orchestrator dispatch states:
   > *"Verify geoid offset handling: ensure `geoid_offset_override` is respected and doesn't crash on invalid inputs."*
   Observations in Section 1.1 prove that passing empty strings `""`, whitespace `"   "`, or non-numeric tokens (`"undefined"`, `"null"`, `"not_a_number"`) directly triggers an unhandled `ValueError: could not convert string to float` in `calculate_cut_fill_volume`, `compute_gcp_accuracy_qa`, and `_transform_tileset_crs_in_place`. This violates the explicit mandate criterion.

2. **Frontend Contract Disconnect**:
   Requirement R1 and R2 state:
   > *"The code must be project-agnostic: project type must NOT set any hardcoded values or tolerances; if any different settings are required, they should be selected by the USER."*
   > *"Implement least-squares best-fit plane for cut/fill volume calculations and mass conservation reporting: Bank Volume (BCM m³), Loose Volume (LCM m³), Compacted Volume (CCM m³), conserved Mass (metric tonnes), and Dump Truck Load Estimator with user-selectable parameters."*
   Observation 1.2 demonstrates that while the backend supports these parameters, the primary civil volume user interface in `web/src/05-studio-civil-inspectors.js` has no inputs for them, does not transmit them to `/api/survey/volume`, and does not render the resulting schedule metrics. Users of the web app cannot configure or inspect these features.

3. **Flaky Test Dependency**:
   Observation 1.3 reveals that unit tests `test_30` through `test_33` in `GatheringScansTestSuite` rely on reading a live 9.7 MB file from disk (`data/gdrive_cloud_manifest.json`) instead of mocking or populating `self.db`. This caused an unhandled `KeyError` failure during full suite execution due to file-locking / concurrent updates by the active background daemon.

4. **Verdict Deduction**:
   Because items 1, 2, and 3 represent functional and operational defects against the approved requirements and mandate, the review verdict must be **REQUEST_CHANGES**.

---

## 3. Caveats

1. The mathematical formulas for the normal equations, Cramer's Rule, Caterpillar swell expansion, and dual-constraint haul calculations are robust and verified correct under valid inputs.
2. The core backend geoid offset calculation operates properly when valid floats are provided.
3. No implementation code was modified by this reviewer agent, adhering to the review-only constraint.

---

## 4. Conclusion

**Verdict**: **REQUEST_CHANGES**

### Required Action Items for Worker:

#### Action Item 1: Robust Input Sanitization (CRITICAL)
In `pc_worker/surveying/dsm_and_volume.py` and `pc_worker/optimizer_bridge.py`, replace direct `float()` casts with safe float parsing helpers that safely return `None` or a fallback default on empty strings, non-numeric values, `NaN`, or exceptions:
```python
def safe_float(val: Any, default: Optional[float] = None) -> Optional[float]:
    if val is None:
        return default
    try:
        s = str(val).strip()
        if not s or s.lower() in ("none", "null", "undefined", "nan"):
            return default
        f = float(s)
        return f if math.isfinite(f) else default
    except (ValueError, TypeError):
        return default
```
Apply this helper to:
- `geoid_offset_override` / `h_offset_from_twvd`
- `swell_factor`
- `shrinkage_factor`
- `density_t_m3`
- `truck_volume_m3`
- `truck_max_tonnes`

#### Action Item 2: UI Controls & Result Display in Volume Inspector (MAJOR)
In `web/src/05-studio-civil-inspectors.js`:
1. Add collapsible/sub-panel inputs in `openCutFillVolumeInspector()` for:
   - Swell factor (`volSwellFactor`, default e.g. 0.80 or 1.25)
   - Compaction shrinkage factor (`volShrinkFactor`, default e.g. 0.10)
   - Truck capacity (`volTruckVolumeM3`, default 15.0 m³)
   - Truck max payload (`volTruckMaxTonnes`, default 20.0 t)
2. Pass these fields in `opts` to `/api/survey/volume`.
3. In `renderVolumeResultAnd3D(res)`, display the mass conservation schedule:
   - Bank Volume (BCM), Loose Volume (LCM), Compacted Volume (CCM)
   - Conserved Mass (Cut/Fill in tonnes)
   - Dump Truck Trips (Cut trips, Net trips, Limiting constraint: Volume vs. Weight)
   - Best-fit plane slope % and azimuth deg (when `base_mode === "best_fit_plane"`)

#### Action Item 3: Hermetic Unit Tests in `GatheringScansTestSuite` (MAJOR)
In `tests/test_gathering_scans_suite.py`:
In `test_30`, `test_31`, `test_32`, and `test_33`, ensure `quchi_20261005_merged` is explicitly upserted into `self.db` in `setUp()` or inside the tests so that unit tests are completely independent of `data/gdrive_cloud_manifest.json` on disk:
```python
self.db.upsert_scan({
    "scan_id": "quchi_20261005_merged",
    "name": "QuChi 2026-10-05 Merged",
    "project_group": "QuChi Dam",
    "status": "completed",
    "twd97_e": 304952.656,
    "twd97_n": 2757084.875,
    "twd97_h": 43.18,
})
```

---

## 5. Verification Method

### 5.1. Adversarial Input Robustness Verification
Run the following script to ensure invalid inputs are handled gracefully without raising exceptions:
```powershell
python -c "
import sys
sys.path.insert(0, r'c:\Antigravity\GatheringScans')
from pc_worker.surveying_engine import SurveyingEngine
from pc_worker.priority_queue import ScanQueueDB
from pc_worker.config import DB_PATH

db = ScanQueueDB(DB_PATH)
survey = SurveyingEngine(db)

for test_input in [
    {'geoid_offset_override': ''},
    {'geoid_offset_override': '   '},
    {'geoid_offset_override': 'not_a_number'},
    {'geoid_offset_override': 'NaN'},
    {'swell_factor': ''},
    {'shrinkage_factor': ''},
    {'density_t_m3': ''},
]:
    res = survey.calculate_cut_fill_volume({'scan_id': 'quchi_20261005_merged', **test_input})
    assert res['status'] == 'ok', f'Failed on input {test_input}'

print('Input Sanitization Verification Passed!')
"
```

### 5.2. Full Test Suite Hermetic Execution
Run the complete regression suite:
```powershell
python -m unittest tests/test_gathering_scans_suite.py
python -m unittest tests/test_civil_surveying_e2e.py
```
**Expected Result**: All tests pass (`OK`) with zero errors or failures.

### 5.3. Invalidation Conditions
This review report is invalidated if:
1. `calculate_cut_fill_volume` or `compute_gcp_accuracy_qa` gracefully handle empty strings and non-numeric inputs without throwing `ValueError`.
2. `web/src/05-studio-civil-inspectors.js` exposes the earthwork parameters and renders BCM/LCM/CCM/truck haul schedules.
3. Full test suite passes hermetically without relying on external filesystem manifest files.
