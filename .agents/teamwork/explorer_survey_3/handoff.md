# Handoff Report — Test Suite, Datasets & Verification Architecture (R1–R5)

**Agent**: `explorer_survey_3` (Test & Dataset Explorer)  
**Parent Conversation ID**: `35a7b3c4-959a-4d2b-a4b5-21fb2891dea3`  
**Date**: `2026-10-31T03:41:00Z`  
**Working Directory**: `c:\Antigravity\GatheringScans\.agents\teamwork\explorer_survey_3\`  
**Related Documents**: `ORIGINAL_REQUEST.md`, `AGENTS.md`, `TEST_INFRA.md`  

---

## 1. Observation

### 1.1. Existing Test Suite Structure & Execution
- **Central Test Suite**: `tests/test_gathering_scans_suite.py` (2,358 lines, 29 test methods).
- **Execution Command & Runtime**:
  ```powershell
  python -m unittest tests/test_gathering_scans_suite.py
  ```
  Execution output:
  ```text
  .............................
  ----------------------------------------------------------------------
  Ran 29 tests in 8.609s

  OK
  [GDriveCloudSync] Optional Drive API v3 photo upload note: HTTP Error 404: Not Found
  ```
- **Test Structure & Isolation**:
  - Inherits from `unittest.TestCase`.
  - In `setUp(self)`: Creates isolated SQLite database via `self.tmp_db_fd, self.tmp_db_path = tempfile.mkstemp(suffix=".db")` and initializes `ScanQueueDB(db_path=self.tmp_db_path)`.
  - In `tearDown(self)`: Safely removes `self.tmp_db_path`.
  - Uses mock scan records alongside read-only calls to `SurveyingEngine(self.db)` against real pre-computed `.npz` DSM and `.glb` tileset caches.
  - Performs JS syntax verification via `node --check` across `web/app.js`, `web/sw.js`, and all `web/src/*.js` files.
- **Other Test & Verification Scripts in `tests/`**:
  - `tests/test_pix4d_live_smoke.py` (70 lines): Verifies headless PIX4Dmatic `.gst` execution with `TWD97_TWVD2001_WKT`.
  - `tests/test_e2e_browser_visual.py` (163 lines): Live HTTP Range streaming (206 Partial Content), Civil Surveying APIs (/api/survey/*), Scoped External Share Link isolation/revocation (403), and Google Chat Rich Cards.
  - `tests/capture_ui_screenshots.py` (296 lines): Headless Chrome CDP runner (1600x960) capturing visual screenshots of 3D Studio, Heatmaps, and Queue.

### 1.2. Local Scan Datasets Inventory
All 4 target scan datasets physically verified in `C:\GatheringScans\` and registered in `data/gathering_scans.db`:
1. `edited_qihu_unified_merged_scan_4_scans__edited_372953`:
   - Path: `C:\GatheringScans\edited_qihu_unified_merged_scan_4_scans__edited_372953`
   - Image count: 6,000 photos; CRS: `TWD97 (121) + TWVD2001`
   - Centroid: Easting $300,550.716$, Northing $2,780,975.538$, Elev $14.25\text{m}$
   - Assets: `tileset/tileset.json`, `exports/obj_mesh/mesh.obj`, `_dsm_cache_v5.npz`, `_categorization_cache_v3.json`, `ortho_nadir.png`
2. `rosepark_20260918_merged`:
   - Path: `C:\GatheringScans\RosePark_Merged2`
   - Image count: 5,853 photos; CRS: `TWD97 (121) + TWVD2001`
   - Centroid: Easting $295,966.701$, Northing $2,768,539.373$, Elev $11.34\text{m}$
   - Assets: `tileset/tileset.json`, `_dsm_cache_v5.npz`, `_categorization_cache_v3.json`, `ortho_nadir.png`
3. `ntudorm_20260915_baseline`:
   - Path: `C:\GatheringScans\NTU_Dorm_260915`
   - Image count: 4,000 photos; CRS: `TWD97 (121) + TWVD2001`
   - Centroid: Easting $303,009.961$, Northing $2,770,016.969$, Elev $4.29\text{m}$
   - Assets: `tileset/tileset.json`, `exports/ntuDorm_260915-obj_mesh/mesh.obj`, `_dsm_cache_v5.npz`, `_categorization_cache_v3.json`
   - Paired Epoch: `ntudorm_20260917_foundation` (`C:\GatheringScans\NTU_Dorm_260917`, E=$303,007.972$, N=$2,770,024.575$, H=$16.98\text{m}$, 4,000 photos)
4. `QuChi261016_Trees`:
   - Path: `C:\GatheringScans\QuChi261016_Trees`
   - Image count: 7,588 photos; CRS: `TWD97 (121) + TWVD2001`
   - Centroid: Easting $304,891.922$, Northing $2,757,029.500$, Elev $38.19\text{m}$
   - Assets: `tileset/tileset.json`, `exports/obj_mesh_full/mesh.obj`, `_dsm_cache_v5.npz`, `_categorization_cache_v3.json`

### 1.3. Strict 5,000-Line Modular File Ceiling Verification
Checked 49 source files (.py, .js, .css, .html) matching the walk filters of `test_07_modular_architecture_strict_5000_line_ceiling`:
- **Top 10 Files by Line Count**:
  1. `web\src\03-studio-core.js`: **4,996 lines** (⚠️ **ONLY 4 lines remaining before build failure!**)
  2. `web\src\05-studio-civil-inspectors.js`: **4,983 lines** (⚠️ **ONLY 17 lines remaining before build failure!**)
  3. `web\src\04-studio-lasso-and-edits.js`: **4,939 lines** (61 lines remaining)
  4. `web\app.css`: **4,852 lines** (148 lines remaining)
  5. `web\src\08-advanced-surveying-and-qa.js`: **4,851 lines** (149 lines remaining)
  6. `web\src\02-map-and-timeline.js`: 4,375 lines
  7. `pc_worker\optimizer_bridge.py`: 4,165 lines
  8. `web\src\06-studio-align-and-optimizer.js`: 3,926 lines
  9. `server.py`: 3,293 lines
  10. `web\app.js`: 3,263 lines
  11. `pc_worker\surveying\contours_and_cad.py`: 2,742 lines
  12. `pc_worker\surveying\categorization_heuristics.py`: 2,678 lines
  13. `pc_worker\surveying\categorization_io.py`: 2,677 lines
  14. `tests\test_gathering_scans_suite.py`: 2,358 lines
  15. `pc_worker\surveying\dsm_and_volume.py`: 1,996 lines
  16. `pc_worker\surveying_engine.py`: 49 lines

---

## 2. Logic Chain

### 2.1. Mathematical Foundations & Verification Requirements for R1–R5

#### R1: Non-Intrusive UI Containers & Project-Agnostic Settings
- **Observation**:
  - `web/index.html` (lines 2390–2400) loads modular scripts in order.
  - Side panel management in `web/src/05-studio-civil-inspectors.js` and `web/src/08-advanced-surveying-and-qa.js` uses collapsible containers (`.gs-side-panel`, `.gs-compare-profile-drawer`).
  - `web/src/03-studio-core.js` is at 4,996 lines and `web/src/05-studio-civil-inspectors.js` is at 4,983 lines.
- **Inference**:
  - Any attempt by implementers to inject R1–R4 UI code into `03-studio-core.js` or `05-studio-civil-inspectors.js` will immediately trigger CI failure in `test_07_modular_architecture_strict_5000_line_ceiling`.
  - New modular frontend files MUST be created:
    - `web/src/09-construction-qa-and-utility.js` (Flatness inspector, Utility tracer, RTK Stakeout export)
    - `web/src/10-scan-to-bim.js` (BIM primitives generation, 3D studio overlay, CAD/BIM export)
    Both registered in `web/index.html` and `web/sw.js`.
  - Zero hardcoded project-name conditions: Every calculation parameter (material density, swell/shrinkage, station interval, slope tiers, flatness tolerance) must be user-selectable in the UI and transmitted as API payload fields.

#### R2: Least-Squares Cut/Fill Mass Conservation & Geoid Catalog Sync
- **Observation**:
  - `pc_worker/surveying/dsm_and_volume.py` currently implements `triangulated_boundary`, `custom_plane`, `lowest_point`, and `epoch_diff`.
  - It computes `fill_volume_m3`, `cut_volume_m3`, `estimated_tonnage_t = effective_m3 * density`.
- **Inference**:
  - Must add least-squares best-fit reference plane:
    Fitting $Z_{ref}(e, n) = a(e - e_0) + b(n - n_0) + c$ to perimeter points via Normal Equations $(A^T A) \beta = A^T Z$.
  - Must report complete mass conservation schedule:
    * Bank Volume ($BCM$ $\text{m}^3$)
    * Loose Volume ($LCM$ $\text{m}^3$): $LCM = BCM \times (1 + S_{swell})$ or $BCM / \text{swell\_factor}$
    * Compacted Volume ($CCM$ $\text{m}^3$): $CCM = BCM \times (1 - S_{shrink})$
    * Conserved Mass ($M$ metric tonnes): $M = BCM \times \rho_{bank} == LCM \times \rho_{loose}$
    * Dump Truck Load Estimator: $\max(\lceil LCM / C_{truck\_vol} \rceil, \lceil M / W_{truck\_max} \rceil)$
  - Synchronize vertical geoid offsets between frontend and backend catalogs, allowing user override `geoid_offset_m`.

#### R2: 3D GCP Residuals & Vertical TBM Datum Correction
- **Observation**:
  - `compute_gcp_accuracy_qa` in `dsm_and_volume.py` (lines 1556–1650) currently evaluates only 1D vertical errors $\Delta H$.
- **Inference**:
  - Must upgrade to true 3D GCP pairing:
    $\Delta E = E_{scan} - E_{GCP}, \Delta N = N_{scan} - N_{GCP}, \Delta H = H_{scan} - H_{GCP}$.
    Vector 3D Error $= \sqrt{\Delta E^2 + \Delta N^2 + \Delta H^2}$.
    $\text{RMSE}_E, \text{RMSE}_N, \text{RMSE}_H, \text{RMSE}_{3D} = \sqrt{\text{RMSE}_E^2 + \text{RMSE}_N^2 + \text{RMSE}_H^2}$.
  - Must implement one-click vertical TBM datum correction:
    $\Delta H_{bias} = \frac{1}{N_{TBM}} \sum (H_{TBM, i} - H_{scan, i})$, shifting active scan datum uniformly so mean residual becomes $0.000\text{m}$.

#### R2: Stationing 0K+000 Profile & Average-End-Area Volume
- **Observation**:
  - `compute_cross_section_profile` in `contours_and_cad.py` (lines 1310–1420) samples 60 points on a single 2D line segment.
- **Inference**:
  - Must extend to polyline centerline alignment parameterized by station chainage (`0K+000.00`, `0K+020.00`).
  - At each interval $\Delta s$, extract transverse normal swath $[-W_{left}, +W_{right}]$ and overlay parametric cross-section template (centerline elevation, roadway crown, shoulder, side ditch, daylight cut/fill slope).
  - Compute cut/fill cross-section areas $A_{cut, i}, A_{fill, i}$ and integrate Average-End-Area volume:
    $V_{cut} = \sum \frac{A_{cut, i} + A_{cut, i+1}}{2} \Delta s$, $V_{fill} = \sum \frac{A_{fill, i} + A_{fill, i+1}}{2} \Delta s$.

#### R2: Slope/Drainage Tiers & Ponding Depression Volume
- **Observation**:
  - `compute_drainage_and_slope` in `dsm_and_volume.py` (lines 1816–1930) has hardcoded slope tiers and does not compute depression ponding volumes.
- **Inference**:
  - Tiers must accept custom user-configured tier intervals from API payload.
  - Must add 8-connected depression ponding detector:
    Identify enclosed pits, spillway elevation $Z_{spill}$, bottom elevation $Z_{bottom}$, max depth $D_{max} = Z_{spill} - Z_{bottom}$, surface area $A_{pond}$, and ponding volume $V_{pond} = \sum (Z_{spill} - Z_i) \Delta A$ in $\text{m}^3$.

#### R3: Construction QA Flatness/Levelness/Plumbness & Plumb Tilt Ratio
- **Observation**:
  - No dedicated 3D surface flatness / plumbness inspector currently exists in backend or frontend.
- **Inference**:
  - Must implement 3D point cloud/mesh flatness analyzer with 3 reference planes (Horizontal, Vertical Plumb, Best-Fit).
  - Compute point-to-plane orthogonal deviations $\delta_i$, Pass Rate % against user tolerance threshold ($\pm 3\text{mm}$, $\pm 5\text{mm}$, etc.), Max High/Low coordinates, and for vertical walls report Plumb Tilt Ratio $\Delta lateral / Height = 1:N$ and $\text{mm/m}$.

#### R3: Open-Trench Utility Tracer
- **Observation**:
  - Ground feature extraction exists for roads/walls, but no pipe invert/crown utility tracer.
- **Inference**:
  - Must implement tracer calculating 3D Length, Invert $(E, N, H_{inv})$, Crown $(E, N, H_{crown})$, Pipe Gradient (% and $1:N$), Depth of Cover $(H_{ground} - H_{crown})$.
  - Export structured CSV and 3D DXF with layers `UTILITY_CENTERLINE_3D`, `UTILITY_PIPE_CYLINDER`, `UTILITY_DEPTH_OF_COVER`.

#### R3: RTK Stakeout Export in Strict E N Z Order
- **Observation**:
  - Existing coordinate tools occasionally display local viewer coordinates or N, E, Z.
- **Inference**:
  - Stakeout export must strictly enforce column order: `PtID, Easting, Northing, Elevation, Code`.
  - Include automated test assertion verifying column 1 is Easting ($~300,000$), column 2 is Northing ($~2,750,000$), and rejecting swapped formats.
  - Generate printable HTML site sheet with print CSS and verification signature blocks.

#### R3: Multi-Epoch Compare Polygon-Bounded Takeoff
- **Observation**:
  - Compare View currently provides curtain slider and $\Delta Z$ probe.
- **Inference**:
  - Must integrate polygon lasso inside Compare View:
    $\Delta V_{cut} = \iint_{poly} \max(Z_A - Z_B, 0) dA$, $\Delta V_{fill} = \iint_{poly} \max(Z_B - Z_A, 0) dA$.
  - Real-world test on `ntudorm_20260915_baseline` vs `ntudorm_20260917_foundation` to verify excavation volume takeoff.

#### R4: Scan-to-BIM Simplified Classified Geometric Model
- **Observation**:
  - `pc_worker/surveying/categorization_heuristics.py` classifies trees, walls, roads, water, but does not emit simplified solid 3D BIM primitives.
- **Inference**:
  - Convert categorized boundaries and anchors into geometric primitives:
    * Buildings: extruded LOD1 bounding box prisms (`BUILDING`)
    * Walls: extruded solid wall prisms (`WALL`)
    * Roads/Sidewalks: 3D boundary ribbon slabs (`ROAD`/`SIDEWALK`)
    * Trees: cylinder trunk + sphere canopy (`TREE`)
    * Water: planar void prism (`WATER`)
    * Utilities: swept cylinders along 3D centerline (`UTILITY`)
  - Deliverables: Interactive 3D Studio overlay and multi-layer CAD/BIM DXF / IFC export.

---

## 3. Caveats
1. **Zero Data Destruction Constraint**:
   - The test suite must NEVER call `db.drop_tables()` or remove any scan directories under `C:\GatheringScans\`.
   - All dynamic database tests must strictly run against temporary SQLite files created in `tempfile.mkstemp()`.
2. **Execution Time Constraint**:
   - Running full photogrammetry mesh generation or Marching Cubes on 7,500 photos during automated unit test execution would exceed timeout limits.
   - Tests must utilize pre-computed DSM `.npz` files or synthetic analytical grids for high-speed deterministic test runs ($< 15$ seconds for the entire suite).
3. **Hardware Acceleration / Headless Browser**:
   - In headless environments without physical GPUs, WebGL SwiftShader must be used (`--enable-unsafe-swiftshader`) for Chrome CDP visual tests.

---

## 4. Conclusion
1. The GatheringScans test suite is healthy, passing all 29 tests in 8.6 seconds.
2. The 5,000-line ceiling is the primary architectural hazard:
   - `web/src/03-studio-core.js` (4,996 lines) and `web/src/05-studio-civil-inspectors.js` (4,983 lines) are at capacity.
   - Implementers MUST create `web/src/09-construction-qa-and-utility.js`, `web/src/10-scan-to-bim.js`, and `pc_worker/surveying/construction_qa_and_bim.py` to maintain modular compliance.
3. The 4 target datasets (`edited_qihu_unified_merged_scan_4_scans__edited_372953`, `rosepark_20260918_merged`, `ntudorm_20260915_baseline`, `QuChi261016_Trees`) are fully verified on disk and ready for Tier 4 real-world workload testing.
4. Comprehensive 4-tier testing architecture has been fully drafted in `TEST_INFRA.md`.

---

## 5. Verification Method

To independently verify the test suite, line counts, and dataset fixtures:

1. **Run Full Automated Unit Test Suite**:
   ```powershell
   python -m unittest tests/test_gathering_scans_suite.py
   ```
   *Expected*: Ran 29 tests in $< 10$s, OK.

2. **Verify Strict 5,000-Line Ceiling**:
   ```powershell
   python -m unittest tests.test_gathering_scans_suite.GatheringScansTestSuite.test_07_modular_architecture_strict_5000_line_ceiling
   ```
   *Expected*: Passes with $\ge 35$ files checked, all $< 5,000$ lines.

3. **Verify Physical Existence of All 4 Scan Datasets**:
   ```powershell
   python -c "import os; pdirs = [r'C:\GatheringScans\edited_qihu_unified_merged_scan_4_scans__edited_372953', r'C:\GatheringScans\RosePark_Merged2', r'C:\GatheringScans\NTU_Dorm_260915', r'C:\GatheringScans\NTU_Dorm_260917', r'C:\GatheringScans\QuChi261016_Trees']; print(all(os.path.isdir(p) for p in pdirs))"
   ```
   *Expected*: `True`.

4. **Verify Frontend JS Syntax across all modules**:
   ```powershell
   Get-ChildItem -Path "web/src/*.js","web/*.js" | ForEach-Object { node --check $_.FullName }
   ```
   *Expected*: Zero syntax errors.
