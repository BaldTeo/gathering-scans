# GatheringScans — E2E Testing Architecture & Verification Infrastructure (`TEST_INFRA.md`)

## 1. Overview & Architectural Principles

This document establishes the end-to-end testing architecture and verification framework for civil surveying, construction QA, earthwork takeoff, and Scan-to-BIM capabilities in GatheringScans (`scans.gatheren.cloud`).

### Key Design Pillars:
1. **Zero Data Destruction**: The test suite operates with absolute read-only safety towards production scan data (`C:\GatheringScans\*`), user comments, photo attachments, and categorization caches. All dynamic/transient tests must execute in isolated temporary SQLite databases (`tempfile.mkstemp`) or mock memory contexts.
2. **Strict 5,000-Line Modular File Ceiling**: Every test file and application source file (`.py`, `.js`, `.css`, `.html`) must strictly remain `< 5,000 lines`. Monolithic test or source bloat is caught by automated structural assertions.
3. **Dual-Environment Parity**: Calculations and API routes must execute consistently on both Windows local host (`127.0.0.1:8095`) and the production Linux Hostinger VPS (`scans.gatheren.cloud`).
4. **4-Tier Verification Hierarchy**:
   - **Tier 1**: Feature Coverage (Analytical math, unit algorithms, REST APIs)
   - **Tier 2**: Boundaries & Robustness (Degenerate geometries, numerical singularities, extreme scale)
   - **Tier 3**: Cross-Feature Integration (Multi-Epoch Compare, 3D Studio, Bookmarks, UI container switching)
   - **Tier 4**: Real-World Workload (Verification against the 4 live production datasets)

---

## 2. 4-Tier Verification Architecture

```
+-----------------------------------------------------------------------------------+
|                           TIER 4: REAL-WORLD WORKLOAD                             |
|  - edited_qihu_unified_merged_scan_4_scans__edited_372953 (6k imgs, Multi-Site)    |
|  - ntudorm_20260915_baseline & ntudorm_20260917_foundation (Excavation Multi-Epoch)|
|  - rosepark_20260918_merged (5.8k imgs, Drainage & Pavements)                     |
|  - QuChi261016_Trees (7.5k imgs, Forestry, Dam & Steep Slopes)                    |
+-----------------------------------------------------------------------------------+
|                        TIER 3: CROSS-FEATURE INTEGRATION                          |
|  - Multi-Epoch Compare Polygon-Bounded Takeoff + Delta-Z Heatmap                  |
|  - Scan-to-BIM Classifiers -> Interactive 3D Studio Overlay -> CAD/BIM Export     |
|  - UI State Machine: Minimalist Drawer/Container Switching & Zero Pointer Clashes |
|  - Persistent Measurement Bookmarks CRUD & Full Studio State Hydration            |
+-----------------------------------------------------------------------------------+
|                        TIER 2: BOUNDARIES & STRESS TESTING                        |
|  - Collinear/Coincident Vertices, Self-Intersecting Polygons, Zero-Area Bounds    |
|  - Zero/Negative Tolerances, Non-Invertible Normal Equations, Vertical Cliffs     |
|  - Grid Memory Safety (128x128 max), Sub-Second Latency under High Density        |
|  - Coordinate Boundary Conditions (TWD97 Zone 121 vs UTM51N / UTM50N transitions) |
+-----------------------------------------------------------------------------------+
|                        TIER 1: FEATURE & ALGORITHMIC UNIT                         |
|  - Least-Squares Best-Fit Plane & Mass Conservation (BCM, LCM, CCM, Mass, Trucks) |
|  - UTM51N/UTM50N Vertical Geoid Offset Catalog & User Override Sync               |
|  - 3D GCP Residuals (dE, dN, dH, RMSE_3D) & One-Click Vertical TBM Calibration    |
|  - Centerline Stationing (0K+000) & Average-End-Area Volume                       |
|  - User-Selectable Slope Tiers & Depression Ponding Volume (m³)                   |
|  - 3D Surface Flatness/Levelness/Plumbness Inspector & Plumb Tilt Ratio           |
|  - Open-Trench Utility Tracer (3D Length, Invert/Crown, Gradient, Cover, DXF/CSV)|
|  - RTK Stakeout Export strictly in E N Z order (PtID, E, N, Z, Code) & Sheet HTML|
+-----------------------------------------------------------------------------------+
```

---

## 3. Tier 1: Feature Coverage Specifications & Test Cases

### 3.1. Least-Squares Cut/Fill Mass Conservation (R2)
* **Mathematical Foundation**:
  - Reference Plane: $Z_{ref}(e, n) = a(e - e_0) + b(n - n_0) + c$, solved via Normal Equations:
    $$\begin{bmatrix} \sum (e_i - e_0)^2 & \sum (e_i - e_0)(n_i - n_0) & \sum (e_i - e_0) \\ \sum (e_i - e_0)(n_i - n_0) & \sum (n_i - n_0)^2 & \sum (n_i - n_0) \\ \sum (e_i - e_0) & \sum (n_i - n_0) & N \end{bmatrix} \begin{bmatrix} a \\ b \\ c \end{bmatrix} = \begin{bmatrix} \sum (e_i - e_0) z_i \\ \sum (n_i - n_0) z_i \\ \sum z_i \end{bmatrix}$$
  - Mass Conservation Equation:
    $$M = V_{bank} \times \rho_{bank} = V_{loose} \times \rho_{loose} = V_{compact} \times \rho_{compact}$$
    $$V_{loose} = V_{bank} \times (1 + S_{swell}) = \frac{V_{bank}}{\text{swell\_factor}}$$
    $$V_{compact} = V_{bank} \times (1 - S_{shrink})$$
  - Truck Load Estimator:
    $$\text{Loads}_{vol} = \lceil V_{loose} / C_{truck\_vol} \rceil, \quad \text{Loads}_{wt} = \lceil M / W_{truck\_max} \rceil, \quad \text{Required Trucks} = \max(\text{Loads}_{vol}, \text{Loads}_{wt})$$
* **Test Verification Assertions**:
  1. Fit synthetic plane $Z = 100.0 + 0.05 \Delta E - 0.02 \Delta N$; verify recovered coefficients within $10^{-5}$ tolerance.
  2. Compute volume for a synthetic $20\text{m} \times 20\text{m}$ pyramid of height $3\text{m}$ ($V_{analytical} = 400 \text{m}^3$). Verify integrated $V_{fill}$ matches analytical within $1.5\%$.
  3. Verify $M_{bank} == M_{loose} == M_{compact}$ strictly holds ($|M_{bank} - M_{loose}| < 10^{-4}$).
  4. Verify Truck load outputs round up correctly and match user truck parameters ($15\text{m}^3$ vs $20\text{m}^3$, $21\text{t}$ limit).

### 3.2. Geoid Catalog Synchronization & User Overrides (R2)
* **Specifications**:
  - Frontend (`web/src/01-core-state.js`, `web/src/03-studio-core.js`) and backend (`pc_worker/config.py`, `pc_worker/gdrive_watcher.py`) must maintain identical geoid undulation tables:
    * TWD97 (121) + TWVD2001: $N_{geoid} \approx +19.42\text{m}$ (interpolated by TWGEOID2018h grid).
    * UTM51N / WGS84: EGM96 / EGM2008 offset catalog.
    * UTM50N: Kinmen/Matsu regional geoid catalog.
  - User Override: API payload parameter `geoid_offset_m` or `vertical_datum_shift_m` allows manual calibration override.
* **Test Verification Assertions**:
  1. Synchronize catalog JSON; verify 0 disparity between frontend `CRS_CATALOG` and backend `pc_worker/config.py`.
  2. Test user override `geoid_offset_m: -2.35`; verify all reported $H$ values shift uniformly by $-2.35\text{m}$.

### 3.3. 3D GCP Residuals & Vertical TBM Datum Correction (R2)
* **Specifications**:
  - Pairing: 3D coordinates $(E, N, H)_{GCP}$ paired with $(E, N, H)_{scan}$.
  - Residuals: $\Delta E = E_{scan} - E_{GCP}, \Delta N = N_{scan} - N_{GCP}, \Delta H = H_{scan} - H_{GCP}$.
  - 3D Vector Error: $e_{3D} = \sqrt{\Delta E^2 + \Delta N^2 + \Delta H^2}$.
  - $\text{RMSE}_{3D} = \sqrt{\text{RMSE}_E^2 + \text{RMSE}_N^2 + \text{RMSE}_H^2}$.
  - TBM Correction: $\Delta H_{TBM\_bias} = \frac{1}{N_{TBM}} \sum (H_{TBM} - H_{scan})$.
* **Test Verification Assertions**:
  1. Evaluate 5 synthetic GCPs with intentional noise; verify $\text{RMSE}_E, \text{RMSE}_N, \text{RMSE}_H, \text{RMSE}_{3D}$ match analytical formula.
  2. One-click TBM calibration action applies $\Delta H_{bias}$; re-evaluating GCPs produces $\mu_{\Delta H} \equiv 0.000\text{m}$.

### 3.4. Centerline Stationing (0K+000) & Average-End-Area Volume (R2)
* **Specifications**:
  - Polyline alignment parameterized by arc length $s$.
  - Station notation: `0K+000.00`, `0K+020.00`, etc.
  - Slicing: Transverse normal $\vec{n} = (-\dot{N}, \dot{E}) / \|\vec{T}\|$ sampled from $-W_{left}$ to $+W_{right}$.
  - Parametric Template: Centerline elevation $Z_c$, crown slope $S_{crown}$, lane width $W$, ditch, daylight cut/fill slopes ($1:S_{cut}$, $1:S_{fill}$).
  - Average-End-Area: $V_{cut} = \sum \frac{A_{c, i} + A_{c, i+1}}{2} \Delta s$, $V_{fill} = \sum \frac{A_{f, i} + A_{f, i+1}}{2} \Delta s$.
* **Test Verification Assertions**:
  1. Generate stationing on a $100\text{m}$ alignment at $10\text{m}$ intervals -> exactly 11 stations (`0K+000.00` to `0K+100.00`).
  2. Evaluate a known prismatic trench ($A_1 = 10\text{m}^2, A_2 = 10\text{m}^2, L = 50\text{m}$) -> $V = 500\text{m}^3 \pm 0.1\%$.
  3. Verify curved alignments maintain continuous orthogonal transverse normals without inversion.

### 3.5. Slope/Drainage Tiers & Ponding Depression Volume (R2)
* **Specifications**:
  - Slope Tiers: User-configurable list of `{ id, min_s, max_s, label, color }`.
  - Ponding Depressions: Pits identified via 8-connected local minima flooding.
  - Quantified Metrics: Max depth $D_{max} = Z_{spill} - Z_{bottom}$, surface area $A_{pond}$, pond volume $V_{pond} = \sum (Z_{spill} - Z_i) \Delta A$.
* **Test Verification Assertions**:
  1. Pass custom 4-tier slope definitions (`0-3%`, `3-8%`, `8-15%`, `>15%`); verify classification breakdown sums to $100.0\%$.
  2. Test synthetic crater DSM with spillway at $Z=10.0\text{m}$ and bottom at $Z=8.5\text{m}$; verify $D_{max} = 1.5\text{m}$, and calculated volume matches integration.

### 3.6. Construction QA: Surface Flatness, Levelness & Wall Plumbness (R3)
* **Specifications**:
  - Reference Plane options:
    * `horizontal`: $Z = Z_{ref}$
    * `vertical_plumb`: Vertical plane through baseline vector $\vec{L}$
    * `best_fit`: SVD least-squares plane
  - Tolerances: User-selectable ($\pm 3\text{mm}$, $\pm 5\text{mm}$, $\pm 10\text{mm}$).
  - Outputs: Deviation heatmap cells, Pass Rate %, Max High $(E, N, H, \delta_{max})$, Max Low $(E, N, H, \delta_{min})$, Plumb Tilt Ratio ($1:N$ or $\text{mm/m}$).
* **Test Verification Assertions**:
  1. Flat slab with synthetic $+6\text{mm}$ bump tested against $\pm 5\text{mm}$ tolerance -> pass rate correctly reflects unaffected area, bump flagged in red.
  2. Vertical wall with $15\text{mm}$ tilt over $3.0\text{m}$ height -> reports Tilt Ratio $1:200$ ($5.0\text{mm/m}$), matching engineering calculation.

### 3.7. Open-Trench Utility Tracer (R3)
* **Specifications**:
  - Centerline polyline trace along pipe trench.
  - Computed Metrics: True 3D Length, 2D Length, Invert coordinates, Crown coordinates ($H_{crown} = H_{invert} + D_{pipe}$), Pipe Gradient (% and $1:N$), Depth of Cover ($H_{ground} - H_{crown}$).
  - Exports: Scheduled CSV and 3D DXF (`UTILITY_CENTERLINE_3D`, `UTILITY_PIPE_CYLINDER`, `UTILITY_DEPTH_OF_COVER`).
* **Test Verification Assertions**:
  1. Pipe falling $0.5\text{m}$ over $50\text{m}$ horizontal length -> Gradient $= 1.0\%$ ($1:100$).
  2. Ground at $H=20.0\text{m}$, pipe invert at $H=18.0\text{m}$, diameter $0.4\text{m}$ -> Crown $= 18.4\text{m}$, Depth of Cover $= 1.6\text{m}$.
  3. Validate exported DXF contains `3DPOLYLINE` and correct layer headers without syntax corruption.

### 3.8. RTK Stakeout Export strictly in E N Z order (R3)
* **Specifications**:
  - Coordinate order MUST be strictly: `PtID, Easting, Northing, Elevation, Code`.
  - Formats: CSV export and printable A4/Letter site sheet HTML.
* **Test Verification Assertions**:
  1. Inspect exported CSV columns: Column 0 is PtID, Column 1 is Easting ($200,000 < E < 400,000$), Column 2 is Northing ($2,400,000 < N < 2,900,000$), Column 3 is Elevation.
  2. Assert test fails immediately if Column 1 and Column 2 are swapped (N before E).
  3. Printable site sheet HTML contains `@media print` CSS, QR code or metadata, and signature boxes.

### 3.9. Multi-Epoch Compare Polygon-Bounded Takeoff (R3)
* **Specifications**:
  - Dynamic polygon drawn in Compare View (side-by-side or curtain slider).
  - Integration: $\Delta V_{cut} = \iint_{poly} \max(Z_A - Z_B, 0) dA$, $\Delta V_{fill} = \iint_{poly} \max(Z_B - Z_A, 0) dA$.
* **Test Verification Assertions**:
  1. Compare `ntudorm_20260915_baseline` vs `ntudorm_20260917_foundation` inside excavation boundary -> reports net excavation ($\Delta V_{cut} > 0, \Delta V_{fill} \approx 0$).
  2. Heatmap cells bounded strictly inside the user polygon.

### 3.10. Scan-to-BIM Classified Geometric Primitives (R4)
* **Specifications**:
  - Elements: Buildings (LOD1 extruded solids), Walls (3D wall prisms), Sidewalks/Roads (3D ribbon slabs), Trees (cylinders + crown ellipsoids), Water (void surfaces), Utilities (cylindrical pipe segments).
  - Outputs: Interactive 3D Studio visualization mesh and standard CAD/BIM export (IFC / 3D DXF solids).
* **Test Verification Assertions**:
  1. Generate BIM model from scan categorization; verify each primitive carries semantic category (`BUILDING`, `WALL`, `ROAD`, `TREE`, `WATER`, `UTILITY`).
  2. Verify CAD/BIM DXF export contains grouped entities by layer and passes AutoCAD/Civil3D parser.

---

## 4. Tier 2: Boundary & Stress Testing Matrix

| Scenario | Input Edge Case | Expected System Behavior | Test Assertion |
| :--- | :--- | :--- | :--- |
| **Collinear Polygon** | Polygon vertices lie on a single straight line | Reject with user-friendly error `Polygon area must be > 0.01 m²` | `status == "error"` & zero crash |
| **Micro Polygon** | Area $< 0.001\text{m}^2$ (double-click accident) | Graceful rejection without division-by-zero | Handled with informative toast |
| **Self-Intersecting Poly** | Bowtie / figure-8 polygon input | Decompose via odd-even winding or clean polygon repair | `polygon_area_2d > 0` |
| **Zero Tolerance QA** | User sets tolerance $\pm 0.000\text{m}$ | Handle gracefully without numeric overflow; pass rate $0.0\%$ | Pass rate computed without error |
| **Vertical Cliff Face** | Surface normal horizontal ($N_z \approx 0, \text{Slope} \to \infty$) | Slope capped at $90^\circ$; ratio output as `>1:1` or `Vertical` | `max_slope_deg <= 90.0` |
| **Empty GCP Set** | Payload sends `points: []` | Fall back to automated site footprint check points | Status `ok`, `point_count >= 2` |
| **Single GCP Point** | Exactly 1 point provided | TBM bias computable ($\Delta H$), but RMSE standard deviation degrees of freedom ($N-1$) handled cleanly | `rmse_z` reported, no zero-division |
| **Reversed Stationing** | Alignment digitized backwards | Stationing advances from $0\text{K}+000$ to end regardless of direction | Chainage strictly monotonically increasing |
| **Dense Sample Grid** | User requests maximum $128 \times 128$ grid on large scan | Sub-sample memory bounded; execution completes in $< 2.5\text{s}$ | Process memory delta $< 50\text{MB}$ |

---

## 5. Tier 3: Cross-Feature Integration Testing

1. **Studio Tool Switching Lifecycle**:
   - Sequential activation: Distance Tool -> Volume Tool -> Stationing Alignment -> Flatness Inspector -> Trench Tracer.
   - Assert: Canvas Three.js scene contains zero leaked/orphaned helper objects, event listeners detach cleanly, and memory footprint remains stable.
2. **Persistent Measurement Bookmarks Integration**:
   - Save multi-tool state (Volume polygon + Stationing centerline + Flatness box).
   - Restore via `/api/bookmarks/restore`; assert 3D scene visual state and numerical metrics are 100% identical.
3. **Compare View to Studio View Transition**:
   - Switch between Map Nadir Overlay, Multi-Epoch Compare View, and 3D Studio View.
   - Assert WebGL context is preserved without context-loss or memory leaks on iPad/mobile.

---

## 6. Tier 4: Real-World Workload Testing Strategy

The 4 live scan datasets located at `C:\GatheringScans\` serve as ground-truth engineering validation:

```
+-------------------------------------------------------------------------------------------------------------+
| Dataset 1: edited_qihu_unified_merged_scan_4_scans__edited_372953 (Centroid: E=300550.7, N=2780975.5, H=14.3) |
| - Role: Large-scale multi-scan civil infrastructure benchmark (6,000 photos, 4 merged scans).               |
| - Tests: Site-wide Cut/Fill mass balance, road pavement extraction, water void boundary detection,          |
|          and Scan-to-BIM classification invariance.                                                        |
+-------------------------------------------------------------------------------------------------------------+
| Dataset 2: ntudorm_20260915_baseline & ntudorm_20260917_foundation (Centroid: E=303009.9, N=2770016.9)     |
| - Role: True multi-epoch building excavation benchmark (Baseline Sept 15 vs Foundation Sept 17).           |
| - Tests: Multi-Epoch Compare polygon-bounded ΔV excavation takeoff, ΔZ vertical probe, and foundation wall   |
|          plumbness / retaining wall tilt inspection.                                                       |
+-------------------------------------------------------------------------------------------------------------+
| Dataset 3: rosepark_20260918_merged (Centroid: E=295966.7, N=2768539.4, H=11.3)                            |
| - Role: Urban park & landscape grading benchmark (5,853 photos).                                            |
| - Tests: Custom slope & drainage classification tiers, rainwater runoff vector tracing, pathway stationing, |
|          and material stockpile tonnage estimator.                                                          |
+-------------------------------------------------------------------------------------------------------------+
| Dataset 4: QuChi261016_Trees (Centroid: E=304891.9, N=2757029.5, H=38.2)                                    |
| - Role: Steep terrain, hydraulic dam structure & forestry benchmark (7,588 photos).                        |
| - Tests: Steep slope stability tiers (>30%), True 3D GCP target pairing with vertical TBM bias correction,  |
|          water body surface delineation, and open-trench utility tracing.                                   |
+-------------------------------------------------------------------------------------------------------------+
```

---

## 7. Modular Limits & CI/CD Enforcement Rules

1. **Strict 5,000-Line Rule (`test_07_modular_architecture_strict_5000_line_ceiling`)**:
   - Pre-commit check walks all `.py`, `.js`, `.css`, and `.html` files.
   - Any file reaching $\ge 5,000$ lines triggers build failure.
   - When introducing frontend tools:
     * Do NOT add bulk lines to `03-studio-core.js` (4,996 lines) or `05-studio-civil-inspectors.js` (4,983 lines).
     * Add new modular scripts: `web/src/09-construction-qa-and-utility.js` and `web/src/10-scan-to-bim.js`, registered in `web/index.html` and `web/sw.js`.
   - When introducing backend tools:
     * Add new modular mixin `pc_worker/surveying/construction_qa_and_bim.py` composed into `SurveyingEngine`.
2. **Automated Test Execution Command**:
   ```powershell
   python -m unittest tests/test_gathering_scans_suite.py
   ```
   All tests must execute in $< 15$ seconds with zero unhandled exceptions.
