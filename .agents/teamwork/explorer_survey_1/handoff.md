# Frontend Survey Explorer Handoff Report

**Date**: 2026-10-31  
**Author**: teamwork_explorer (Frontend Survey Explorer)  
**Parent Conversation ID**: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3  
**Working Directory**: `c:\Antigravity\GatheringScans\.agents\teamwork\explorer_survey_1\`  
**Task Reference**: `c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md` (Requirements R1–R5)

---

## 1. Observation

### 1.1 Strict 5,000-Line Modular File Ceiling Status
We executed an exhaustive line-count scan of all source files in the repository (`tests/test_gathering_scans_suite.py:347` enforces `< 5000` lines per file via `test_07_modular_architecture_strict_5000_line_ceiling`).

Direct observations of top source files by line count:
```
File Path                                  Line Count   Headroom to 5,000 Lines
--------------------------------------------------------------------------------
web\src\03-studio-core.js                  4,996 lines  ONLY 4 LINES LEFT!
web\src\05-studio-civil-inspectors.js      4,983 lines  ONLY 17 LINES LEFT!
web\src\04-studio-lasso-and-edits.js       4,939 lines  ONLY 61 LINES LEFT!
web\app.css                                4,852 lines  ONLY 148 LINES LEFT!
web\src\08-advanced-surveying-and-qa.js    4,851 lines  ONLY 149 LINES LEFT!
web\src\02-map-and-timeline.js             4,375 lines  625 lines
pc_worker\optimizer_bridge.py              4,165 lines  835 lines
web\src\06-studio-align-and-optimizer.js   3,926 lines  1,074 lines
server.py                                  3,293 lines  1,707 lines
web\app.js                                 3,263 lines  1,737 lines
pc_worker\surveying\contours_and_cad.py    2,742 lines  2,258 lines
web\src\01-core-state.js                   2,680 lines  2,320 lines
pc_worker\surveying\categorization_heur.py 2,678 lines  2,322 lines
pc_worker\surveying\categorization_io.py   2,677 lines  2,323 lines
web\index.html                             2,402 lines  2,598 lines
tests\test_gathering_scans_suite.py        2,359 lines  2,641 lines
web\src\07-compare-and-queue.js            2,235 lines  2,765 lines
pc_worker\server_api_routes.py             2,197 lines  2,803 lines
pc_worker\surveying\dsm_and_volume.py      1,995 lines  3,005 lines
```

**Critical Finding**: `web/src/03-studio-core.js` (4,996), `web/src/05-studio-civil-inspectors.js` (4,983), `web/src/04-studio-lasso-and-edits.js` (4,939), `web/app.css` (4,852), and `web/src/08-advanced-surveying-and-qa.js` (4,851) **CANNOT** accept any substantial feature additions without instantly violating `test_07_modular_architecture_strict_5000_line_ceiling`.

### 1.2 Frontend Module Loading & Service Worker Cache
In `web/index.html` (lines 2390–2401):
```html
<script src="/i18n.js?v=20261030_v217"></script>
<script src="/src/01-core-state.js?v=20261030_v217"></script>
<script src="/src/02-map-and-timeline.js?v=20261030_v217"></script>
<script src="/src/03-studio-core.js?v=20261030_v217"></script>
<script src="/src/04-studio-lasso-and-edits.js?v=20261030_v217"></script>
<script src="/src/05-studio-civil-inspectors.js?v=20261030_v217"></script>
<script src="/src/06-studio-align-and-optimizer.js?v=20261030_v217"></script>
<script src="/src/07-compare-and-queue.js?v=20261030_v217"></script>
<script src="/src/08-advanced-surveying-and-qa.js?v=20261030_v217"></script>
<script src="/app.js?v=20261030_v217"></script>
```
In `web/sw.js` (lines 10–23):
`APP_SHELL` lists scripts `/src/01-core-state.js` through `/src/08-advanced-surveying-and-qa.js`.
In `tests/test_gathering_scans_suite.py` (lines 728–729):
`self.assertIn("/src/08-advanced-surveying-and-qa.js", html)` and `self.assertIn("/src/08-advanced-surveying-and-qa.js", sw_js)`.

### 1.3 Existing UI Containers & Layout
1. **Bottom Dock (`#bimBottomDock`)** in `web/index.html` (lines 834–1047):
   - Currently contains 13 tool buttons: `Distance`, `Angle`, `Area`, `Coords`, `Laser`, `Clear` | `Volume`, `Contours`, `Profile`, `Section` | `Photos`, `Categorize`, `Drainage`, `GCP QA`, `Bookmarks`, `Comments` | `Walk`, `Snap`.
2. **Right Side Panel (`#studioSidePanel`)** in `web/index.html` (lines 813–828):
   - Managed by `showSidePanel(title, htmlContent)` and `closeSidePanel()` in `web/src/05-studio-civil-inspectors.js:41-112`.
   - Has `#sidePanelTitle`, `#sidePanelBody`, minimize button (`#btnCollapseSidePanel`), and close button (`#btnCloseSidePanel`).
3. **Compare View (`#viewCompare`)** in `web/index.html` (lines 1151–1280):
   - Managed in `web/src/07-compare-and-queue.js` and `web/src/08-advanced-surveying-and-qa.js:1000` (`initCompareSurveyingTools`).
   - Has `#btnCompareDeltaZProbe` and `#btnCompareMultiProfile`, with a bottom drawer `#compareProfileDrawer`.

### 1.4 Survey of Existing Logic for R2–R4 Requirements
1. **Cut/Fill Volume Calculations (R2)**:
   - `openCutFillVolumeInspector` in `web/src/05-studio-civil-inspectors.js:637`: Computes client volume via `computeClientMeshVolumeAsync` and queries backend `/api/survey/volume`.
   - `fitBestFitPlaneToPoints` in `web/src/04-studio-lasso-and-edits.js:3548`: Fits $y = a \cdot x + b \cdot z + c$.
   - **Gaps**: Missing mass conservation display (BCM, LCM, CCM), swell factor, compaction factor, and user-configurable dump truck estimator. Backend `pc_worker/surveying/dsm_and_volume.py` lacks explicit handling for `base_mode == "best_fit_plane"` (falls back to boundary mean).
2. **UTM51N / UTM50N Vertical Geoid Offsets (R2)**:
   - Frontend `web/src/06-studio-align-and-optimizer.js:37-57`: WGS84_UTM51N `hOff: 20.6`, WGS84_UTM50N `hOff: 19.8`.
   - Backend `pc_worker/optimizer_bridge.py:61-82`: WGS84_UTM51N `h_offset_from_twvd: 17.20`, WGS84_UTM50N `h_offset_from_twvd: 16.80`.
   - **Discrepancy**: Frontend and backend geoid offsets differ by up to 3.4 meters! Missing user override input for custom geoid separation.
3. **GCP Control Target QA & TBM Calibration (R2)**:
   - `web/src/08-advanced-surveying-and-qa.js:2326-2450`: `parseGcpCsvInput`, `runGcpAccuracyQaEvaluation`, `openGcpAccuracyQaInspector`.
   - **Gaps**: Only calculates vertical difference $H_{scan} - H_{gcp}$ and RMSE_Z. Does NOT compute true 3D residuals ($\Delta E, \Delta N, \Delta H, \Delta 3D$) or horizontal/3D RMSE. Missing one-click vertical TBM datum bias correction.
4. **Centerline Stationing & Corridor Profile (R2)**:
   - `web/src/05-studio-civil-inspectors.js:3170`: `openProfileInspector` only takes 2 endpoints (A–B) and renders a single linear elevation profile.
   - **Gaps**: Missing 0K+000 stationing chainage intervals, swath corridor width sampling, parametric road/canal cross-section template overlay, and Average-End-Area volume calculations ($V = \frac{A_1 + A_2}{2} \times L$).
5. **Slope/Drainage Classification & Ponding Depressions (R2)**:
   - `web/src/08-advanced-surveying-and-qa.js:1087-1210` & `2098-2200`: `SLOPE_STEPPED_TIERS` are hardcoded. Ponding is merely a count of flat points (`< 1:200`).
   - **Gaps**: Missing user-selectable slope classification tiers. Missing true ponding depression quantification: water volume (m³), max ponding depth (m), and surface area (m²).
6. **3D Surface Flatness, Levelness & Wall Plumbness (R3)**:
   - Currently nonexistent in the codebase.
7. **Open-Trench Buried Utility 3D Tracer (R3)**:
   - Currently nonexistent in the codebase.
8. **RTK Stakeout Export in Exact E N Z Order & Site Sheet (R3)**:
   - Currently nonexistent in the codebase. Existing point exports vary in coordinate order.
9. **Polygon-Bounded ΔV Cut/Fill Volume Takeoff in Compare View (R3)**:
   - Compare view only has ΔZ point probe and A–B elevation profile drawer. Missing polygon-bounded epoch-to-epoch ΔV volume takeoff.
10. **Scan-to-BIM Simplified Classified Geometric Model (R4)**:
    - AI categorization produces 2D/3D polygon overlays and point annotations, but does NOT generate simplified 3D geometric solid primitives (extruded bounding boxes, wall prisms, tree cylinders, planar water bodies) with interactive preview and CAD/BIM export.

---

## 2. Logic Chain

### Step 1: Solving the 5,000-Line Ceiling Constraint (R5)
- **Observation**: `web/src/03-studio-core.js` (4,996 lines), `web/src/05-studio-civil-inspectors.js` (4,983 lines), and `web/app.css` (4,852 lines) are at their limit.
- **Deduction**: We must create:
  1. `web/src/09-construction-survey-and-bim.js` (dedicated modular file for all new construction QA, stationing, utility tracer, stakeout, and Scan-to-BIM tools).
  2. `web/survey-bim.css` (dedicated stylesheet for new tabs, gauges, and tables, linked in `web/index.html`).
  3. Register both files in `web/index.html` and `web/sw.js` (APP_SHELL).
  4. Use `web/src/01-core-state.js` (2,680 lines, 2,320 lines headroom) for shared STATE variables and hooks.

### Step 2: Preserving the Minimalist Interface via Tabbed & Collapsible Containers (R1)
- **Observation**: Adding 5+ standalone buttons to `#bimBottomDock` would overcrowd the dock from 13 to 18+ icons, cluttering mobile and desktop viewports.
- **Deduction**: New capabilities should be embedded as non-intrusive tabs and collapsible panels:
  - **Dock addition**: Add **ONLY ONE** new icon button to `#bimBottomDock`:
    `btnDockCivilQa` (`品管 / QA`, data-tool="civil_qa"), which opens `#studioSidePanel` with tabbed views:
    `[平整垂直度 (Flatness & Plumb)]` | `[開挖管線 (Utility Tracer)]` | `[RTK 放樣 (Stakeout)]`.
  - **In Volume Inspector (`openCutFillVolumeInspector`)**: Add a top tab switcher:
    `[土方挖填 (Cut/Fill)]` | `[鬆實方與載運 (Bulking & Trucks)]`.
  - **In Profile Inspector (`openProfileInspector`)**: Add a top tab switcher:
    `[A-B 剖面 (Profile)]` | `[道路中心樁號 (Stationing 0K+000 & AEA)]`.
  - **In AI Categorization (`openCategorizeInspector`)**: Add a top tab switcher:
    `[地物標註 (Overlays)]` | `[Scan-to-BIM 幾何模型 (Primitives & Export)]`.
  - **In Compare View (`viewCompare`)**: Add button `#btnCompareVolumeTakeoff` beside `#btnCompareDeltaZProbe` and a collapsible drawer `#compareVolumeDrawer` beneath the compare stage.
  - **Project-Agnostic Settings**: Every calculation setting (density, swell factor, compaction factor, truck volume/mass, tolerance threshold, slope tiers, pipe diameter) must have explicit UI inputs and default fallbacks—zero hardcoded project tolerances.

### Step 3: Aligning Core Surveying & Geodetic Math (R2)
- **Volume & Mass Conservation**:
  - $V_{bank}$ from least-squares best-fit plane.
  - $M = V_{bank} \times \rho_{bank}$ (metric tonnes).
  - $V_{loose} = V_{bank} \times S_w$ (m³).
  - $V_{compact} = V_{bank} \times C_f$ (m³).
  - $N_{trucks} = \max(\lceil V_{loose} / V_{truck} \rceil, \lceil M / M_{truck} \rceil)$.
  - Backend `pc_worker/surveying/dsm_and_volume.py`: implement explicit least-squares plane fitting matching frontend `fitBestFitPlaneToPoints`.
- **UTM51N / UTM50N Geoid Offsets**:
  - Standardize default catalog values to 17.20m (UTM51N) and 16.80m (UTM50N).
  - Provide an editable override input field in CRS settings (`#inpGeoidOffsetOverride`).
- **True 3D GCP Residuals & TBM Calibration**:
  - Compute $\Delta E = E_{scan} - E_{gcp}$, $\Delta N = N_{scan} - N_{gcp}$, $\Delta H = H_{scan} - H_{gcp}$.
  - Compute $RMSE_E, RMSE_N, RMSE_{Horiz}, RMSE_Z, RMSE_{3D}$.
  - Compute mean vertical bias $\Delta \bar{Z} = \frac{1}{n}\sum \Delta H_i$ and provide `[一鍵 TBM 水準基準校正 (Apply TBM Calibration)]`.
- **Centerline Stationing & AEA Volume**:
  - Centerline parameterization: $S = 0$ to $S_{max}$, step $\Delta S$ (e.g. 10m). Station string: `0K+000`, `0K+010`, etc.
  - Transverse swath sampling at normal vectors $\pm W/2$.
  - Parametric template overlay (subgrade width, cut slope $1:m$, fill slope $1:n$).
  - AEA volume: $V = \sum \frac{A_k + A_{k+1}}{2} \Delta S_k$.
- **Slope Tiers & Ponding Depressions**:
  - Dropdown for slope standards (Civil/Highway, Embankment, Custom).
  - Watershed depression flood-fill algorithm: find enclosed sinks below spillway crest, quantify $V_{water} = \iint (Z_{crest} - Z) dA$, max depth $D_{max}$, and pond area $A_{pond}$.

### Step 4: Construction QA Tools, Utility Tracer & Stakeout (R3)
- **3D Flatness & Plumbness**:
  - User selects Reference Plane: Horizontal ($Y=Y_0$), Vertical Plumb (wall along 2 points extruded vertically), or Best-Fit ($a x + b z + c$).
  - Compute point-to-plane signed distances $\delta_i$.
  - Render deviation heatmap on Three.js mesh.
  - Compute Pass Rate % ($|\delta_i| \le \text{tolerance}$), Max High $(E, N, H)$, Max Low $(E, N, H)$, and Plumb Tilt Ratio ($1:N$ and mm/m).
- **Open-Trench Buried Utility Tracer**:
  - User clicks polyline on trench bottom/crown.
  - Select utility type (stormwater, sewer, water, power, gas) and pipe diameter $\Phi$.
  - Compute 3D length, invert elevation, crown elevation, gradient (% and 1:N), depth of cover $H_{ground} - H_{crown}$.
  - Render 3D cylindrical pipe in Three.js with color coding.
  - Export CSV and 3D DXF with 3D polylines.
- **RTK Stakeout Export & Site Sheet**:
  - Enforce strictly **E N Z** order: `PtID, Easting, Northing, Elevation, Code`.
  - Provide formatted printable site sheet modal with print CSS (`window.print()`).
- **Multi-Epoch Compare ΔV Takeoff**:
  - Add polygon tool to compare view.
  - Compute $\Delta Z(x, z) = Z_B(x, z) - Z_A(x, z)$.
  - Integrate Cut $\Delta V^-$, Fill $\Delta V^+$, Net $\Delta V$. Display in `#compareVolumeDrawer`.

### Step 5: Scan-to-BIM Simplified Geometric Model (R4)
- Transform classified 3D scan data into simplified semantic geometric primitives:
  - Buildings $\to$ Extruded polygonal prisms / Oriented Bounding Boxes (OBB).
  - Walls $\to$ Extruded wall ribbons with width and height.
  - Roads/Walkways $\to$ Surface ribbon meshes.
  - Trees $\to$ Trunk cylinder + canopy ellipsoid/cone (DBH, canopy radius, height).
  - Water Voids $\to$ Planar horizontal polygonal slabs.
  - Pipes $\to$ 3D cylindrical extrusions.
- Interactive 3D Studio Preview (`studioThree.bimPrimitivesGroup`): toggleable on/off, clickable elements displaying BIM property cards.
- Export: CAD 3D DXF (layers `BIM_BUILDINGS`, `BIM_WALLS`, etc.) and OBJ/JSON.

---

## 3. Caveats
1. **Source File Line Budget**: Because `03-studio-core.js` has only 4 lines of headroom, **NO** code should be placed in `03-studio-core.js` or `05-studio-civil-inspectors.js`. All new logic must reside in `09-construction-survey-and-bim.js`, with minimal hooks in `01-core-state.js` or `07-compare-and-queue.js`.
2. **CSS Headroom**: `web/app.css` has only 148 lines of headroom. All new styles must go into `web/survey-bim.css`.
3. **Local PC Server Reload**: Per `AGENTS.md`, any `.py` modification requires terminating port 8095 and running `ensure_daemon_running.ps1`.
4. **Data Integrity**: Under no circumstances should existing scans, comments, or categorization cache files be deleted or modified destructively.

---

## 4. Conclusion & Actionable Frontend Implementation Plan

| Component | Target File | Line Budget | Functional Additions |
|---|---|---|---|
| **New Module** | `web/src/09-construction-survey-and-bim.js` | ~1,800–2,200 lines | - Construction QA Inspector: Flatness, Levelness, Wall Plumbness with heatmap, Pass Rate %, Tilt.<br>- Open-Trench Buried Utility 3D Tracer: invert/crown, pipe gradient, depth of cover, 3D DXF/CSV.<br>- RTK Stakeout: strict E N Z point order table & printable site sheet.<br>- Centerline Corridor Stationing (0K+000), swath width, parametric template & AEA volume.<br>- Scan-to-BIM: geometric primitive generator, interactive 3D preview, CAD/BIM export.<br>- Compare View ΔV Cut/Fill Takeoff logic. |
| **New Stylesheet** | `web/survey-bim.css` | ~250–350 lines | Styling for tabbed headers, QA gauges, stakeout tables, print media stylesheet for site sheets. |
| **HTML Shell** | `web/index.html` | ~60–80 lines | - Link `survey-bim.css`.<br>- Add `btnDockCivilQa` to `#bimBottomDock`.<br>- Add `btnCompareVolumeTakeoff` and `#compareVolumeDrawer` to `viewCompare`.<br>- Include `<script src="/src/09-construction-survey-and-bim.js?v=..."></script>`. |
| **Service Worker** | `web/sw.js` | ~3 lines | Add `/src/09-construction-survey-and-bim.js` and `/survey-bim.css` to `APP_SHELL`. Bump `CACHE_NAME`. |
| **Core State** | `web/src/01-core-state.js` | ~20–30 lines | Register state variables: `qaTool`, `stakeoutPoints`, `utilityTraces`, `stationingConfig`, `bimPrimitives`. |
| **Compare View** | `web/src/07-compare-and-queue.js` | ~40–60 lines | Wire `#btnCompareVolumeTakeoff` and `#compareVolumeDrawer` events. |
| **Backend Surveying** | `pc_worker/surveying/dsm_and_volume.py` & `pc_worker/server_api_routes.py` | ~150–200 lines | - Add `best_fit_plane` least-squares solver in volume endpoint.<br>- Synchronize UTM51N (17.20m) / UTM50N (16.80m) geoid offsets.<br>- Add true 3D GCP residual evaluation & TBM vertical bias shift endpoint. |

---

## 5. Verification Method

1. **Modular Line Limit Test**:
   ```powershell
   python -m unittest tests.test_gathering_scans_suite.TestGatheringScansSuite.test_07_modular_architecture_strict_5000_line_ceiling
   ```
   *Pass Condition*: All files remain `< 5000` lines.
2. **Complete Test Suite**:
   ```powershell
   python -m unittest tests/test_gathering_scans_suite.py
   ```
   *Pass Condition*: All unit and regression tests pass (29+ tests OK).
3. **Local Server Status Check**:
   ```powershell
   curl http://127.0.0.1:8095/api/status
   ```
   *Pass Condition*: HTTP 200 OK.
4. **Browser Visual Inspection**:
   - Verify Studio UI: bottom dock contains `品管 / QA`, clicking opens SidePanel with tabs.
   - Verify Volume panel: tabs for `Cut/Fill` and `Bulking & Trucks` show BCM, LCM, CCM, Conserved Mass, and Truck count.
   - Verify Profile panel: stationing `0K+000` displays cross-section template and AEA volume.
   - Verify Drainage panel: slope tier selector and ponding depression quantification ($V_{water}$ m³).
   - Verify Compare View: `#btnCompareVolumeTakeoff` allows drawing polygon and displays $\Delta V$ Cut/Fill in drawer.
   - Verify RTK Stakeout: exports CSV with exact `PtID, Easting, Northing, Elevation, Code` order.
   - Verify Scan-to-BIM: toggle 3D primitives in Studio and download CAD DXF.
