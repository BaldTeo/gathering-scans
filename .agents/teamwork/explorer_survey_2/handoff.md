# Handoff Report: Backend Surveying Architecture, Algorithms & API Endpoints (R1–R5)

**Agent**: `explorer_survey_2` (Backend Survey Explorer)  
**Date**: 2026-10-31  
**Working Directory**: `c:\Antigravity\GatheringScans\.agents\teamwork\explorer_survey_2\`  
**Target Recipient**: Orchestrator / Parent (`35a7b3c4-959a-4d2b-a4b5-21fb2891dea3`) and Implementation Agents  

---

## 1. Observation

### 1.1 Existing Architecture & File Line Counts
The backend surveying stack in GatheringScans is composed of modular mixins unified under `SurveyingEngine` (`pc_worker/surveying_engine.py`) and wired through `ServerWriteRoutesMixin` (`pc_worker/server_api_routes.py`) and `GatheringScansHandler` (`server.py`).

Line counts and headroom against the strict 5,000-line modular ceiling (`test_07_modular_architecture_strict_5000_line_ceiling`):

| File Path | Description | Line Count | 5k Headroom |
|---|---|---|---|
| `server.py` | HTTP Server & GET handlers | 3,293 | 1,707 lines |
| `pc_worker/server_api_routes.py` | POST / DELETE write route handlers | 2,197 | 2,803 lines |
| `pc_worker/server_cloud_and_tunnel.py` | Reverse SSH VPS tunnel & Cloud sync | 2,090 | 2,910 lines |
| `pc_worker/surveying_engine.py` | Facade composing domain mixins | 48 | 4,952 lines |
| `pc_worker/surveying/dsm_and_volume.py` | DSM, cut/fill volume, GCP QA, drainage | 1,995 | 3,005 lines |
| `pc_worker/surveying/contours_and_cad.py` | DXF contours, PDF report, profile, cameras | 2,742 | 2,258 lines |
| `pc_worker/surveying/categorization_io.py` | Mesh loader, Gemini AI, cache & overrides | 2,677 | 2,323 lines |
| `pc_worker/surveying/categorization_heuristics.py` | Roads, trees, walls, water heuristics | 2,678 | 2,322 lines |
| `tests/test_gathering_scans_suite.py` | Automated regression test suite | 2,359 | 2,641 lines |

### 1.2 Current Route Dispatching (`pc_worker/server_api_routes.py`)
Existing POST survey routes:
- `/api/survey/volume` (line 921): calls `SURVEY.calculate_cut_fill_volume(payload)`
- `/api/survey/contours` / `/api/survey/report` (line 934): calls `SURVEY.generate_civil3d_survey_report(payload)`
- `/api/survey/profile` (line 947): calls `SURVEY.compute_cross_section_profile(payload)`
- `/api/survey/inspect-photos` (line 960): calls `SURVEY.inspect_rtk_camera_photos(payload)`
- `/api/survey/cameras` (line 972): calls `SURVEY.get_scan_cameras_response(...)`
- `/api/survey/categorize` (line 981): calls `SURVEY.categorize_scan_surfaces_and_objects(payload)`
- `/api/survey/gcp-qa` (line 994): calls `SURVEY.compute_gcp_accuracy_qa(payload)`
- `/api/survey/drainage` (line 1007): calls `SURVEY.compute_drainage_and_slope(payload)`

### 1.3 Technical Gaps Directly Observed
1. **Cut/Fill Reference Plane & Earthwork Mass Balance**:
   - `pc_worker/surveying/dsm_and_volume.py` lines 975–1242: Supports `triangulated_boundary` (IDW perimeter interpolation), `custom_plane` (flat constant $Z_0$), `lowest_point`, and `epoch_diff`.
   - **Gap**: Missing `best_fit_plane` (least-squares planar fit to perimeter boundary samples).
   - **Gap**: Missing civil earthwork state breakdown: Bank Cubic Meters ($BCM$), Loose Cubic Meters ($LCM$), Compacted Cubic Meters ($CCM$).
   - **Gap**: In `config.py` line 96–105 (`MATERIAL_CATALOG`), swell factors are stored as load factors (e.g. 0.80), and mass calculation in lines 1187–1188 computes loose vs bank tonnage as `effective_m3 * density * swell` without strict mass conservation across volume expansion.
   - **Gap**: Missing Dump Truck Load Estimator (calculating required 15m³/20t truck loads and net import/export balance).
2. **Coordinate Systems & Geoid Inconsistency**:
   - `pc_worker/optimizer_bridge.py` line 70: `WGS84_UTM51N` sets `h_offset_from_twvd: 17.20`.
   - `web/src/06-studio-align-and-optimizer.js` line 45: `WGS84_UTM51N` sets `hOff: 20.6`.
   - `pc_worker/optimizer_bridge.py` line 81: `WGS84_UTM50N` sets `h_offset_from_twvd: 16.80`.
   - `web/src/06-studio-align-and-optimizer.js` line 56: `WGS84_UTM50N` sets `hOff: 19.8`.
   - **Gap**: Backend and frontend catalogs are completely out of sync. Furthermore, neither allows user override of geoid undulation (`h_offset_from_twvd`).
3. **GCP Accuracy QA & TBM Calibration**:
   - `pc_worker/surveying/dsm_and_volume.py` lines 1556–1700: Evaluates only vertical residual $\Delta H = H_{\text{scan}} - H_{\text{gcp}}$ (lines 1655–1656). It samples the DSM at $(E_{\text{gcp}}, N_{\text{gcp}})$, assuming zero horizontal deviation.
   - **Gap**: Missing 3D target pairing ($E, N, H$), $\Delta E$, $\Delta N$, horizontal error $\Delta \text{2D} = \sqrt{\Delta E^2 + \Delta N^2}$, 3D residual $\Delta \text{3D} = \sqrt{\Delta E^2 + \Delta N^2 + \Delta H^2}$, and respective RMSE values ($\text{RMSE}_E, \text{RMSE}_N, \text{RMSE}_H, \text{RMSE}_{2D}, \text{RMSE}_{3D}$).
   - **Gap**: Missing 1-click vertical TBM datum bias calibration to zero out benchmark offset and eliminate systematic vertical shift across the scan.
4. **Centerline Stationing & Average-End-Area Integration**:
   - `pc_worker/surveying/contours_and_cad.py` lines 1310–1432: Takes a single 2-point line $[P_{\text{start}}, P_{\text{end}}]$ and generates 60 1D chord elevation samples.
   - **Gap**: Missing stationing notation `0K+000` along a polyline alignment.
   - **Gap**: Missing transverse cross-section slicing (swath width left/right).
   - **Gap**: Missing parametric roadway/trench template overlay (roadbed width, cross-fall %, cut/fill side slopes).
   - **Gap**: Missing Average-End-Area volume integration ($V = \frac{A_1 + A_2}{2} \times L$).
5. **Drainage Classification & Ponding Depressions**:
   - `pc_worker/surveying/dsm_and_volume.py` lines 1816–1994: Slope tiers are hardcoded (lines 1851–1858).
   - **Gap**: Ignores user-defined custom slope tiers in payload.
   - **Gap**: Completely lacks ponding depression quantification (sink detection, spill pour-point elevation, depression water volume in m³, max ponding depth, and surface area).
6. **Construction QA Tools (Flatness / Plumbness & Utility Tracer)**:
   - Neither exists anywhere in the codebase.
   - **Gap**: Missing 3D surface flatness, floor levelness, and wall plumbness inspector against Horizontal, Plumb, or Best-Fit reference planes with deviation heatmaps and plumb tilt ratios (e.g. 1:350).
   - **Gap**: Missing open-trench utility 3D tracer extracting 3D length, invert/crown elevations, gradient (% and 1:N), depth of cover, CSV schedule, and 3D DXF.
7. **RTK Stakeout Export**:
   - **Gap**: No dedicated endpoint exporting points strictly in $E, N, Z$ order (`PtID, Easting, Northing, Elevation, Code`) with printable site sheet.
8. **Multi-Epoch Compare ΔV Takeoff**:
   - `pc_worker/surveying/dsm_and_volume.py` supports `epoch_diff`, but the compare module (`web/src/07-compare-and-queue.js`) has no polygon boundary drawing tool or direct UI invocation of `/api/survey/volume`.
9. **Scan-to-BIM Primitive Fitting & Export**:
   - `pc_worker/surveying/categorization_io.py` and `categorization_heuristics.py` produce rich 2D boundaries and 3D attributes for roads, trees, water, and walls in JSON cache files (`data/categorization_cache/*_categorization_v3.json`).
   - **Gap**: No automated geometric primitive fitting (3D cuboids/OBB for buildings/walls, 3D trunk/crown cylinders/ellipsoids for trees, 3D slabs for roads, 3D cylinders for utility pipes).
   - **Gap**: Missing standard IFC SPF (`ISO-10303-21`), 3D DXF solid/mesh, and OBJ export formats.

---

## 2. Logic Chain

### 2.1 Least-Squares Best-Fit Reference Plane Math
To compute cut/fill earthwork volumes relative to a least-squares best-fit planar datum:
1. Extract perimeter boundary sample points $(x_i, y_i, z_i)$ for $i = 1 \dots N$ along the boundary polygon.
2. Centroid shift for numerical stability:
   $$\bar{x} = \frac{1}{N}\sum_{i=1}^N x_i, \quad \bar{y} = \frac{1}{N}\sum_{i=1}^N y_i, \quad \bar{z} = \frac{1}{N}\sum_{i=1}^N z_i$$
   $$u_i = x_i - \bar{x}, \quad v_i = y_i - \bar{y}, \quad w_i = z_i - \bar{z}$$
3. Plane equation: $w = a \cdot u + b \cdot v$.
4. Normal equations:
   $$\begin{bmatrix} \sum u_i^2 & \sum u_i v_i \\ \sum u_i v_i & \sum v_i^2 \end{bmatrix} \begin{bmatrix} a \\ b \end{bmatrix} = \begin{bmatrix} \sum u_i w_i \\ \sum v_i w_i \end{bmatrix}$$
5. Analytical closed-form solution:
   $$D = (\sum u_i^2)(\sum v_i^2) - (\sum u_i v_i)^2$$
   $$a = \frac{(\sum u_i w_i)(\sum v_i^2) - (\sum v_i w_i)(\sum u_i v_i)}{\max(D, 10^{-12})}$$
   $$b = \frac{(\sum v_i w_i)(\sum u_i^2) - (\sum u_i w_i)(\sum u_i v_i)}{\max(D, 10^{-12})}$$
6. Base elevation at any integration cell $(g_e, g_n)$:
   $$z_{\text{base}}(g_e, g_n) = \bar{z} + a \cdot (g_e - \bar{x}) + b \cdot (g_n - \bar{y})$$
7. Reference plane slope gradient and azimuth:
   $$\text{slope\_pct} = \sqrt{a^2 + b^2} \times 100\%$$
   $$\text{azimuth\_deg} = (\text{atan2}(a, b) \times \frac{180}{\pi} + 360) \pmod{360}$$

### 2.2 Earthwork Mass Conservation & Dump Truck Load Balancing
1. **Volume States**:
   - In-situ excavation cut: $V_{\text{cut, BCM}}$ ($m^3$).
   - Loose excavation volume: $V_{\text{cut, LCM}} = V_{\text{cut, BCM}} \times S_w$ (where $S_w \ge 1.0$ is the swell factor, e.g. 1.25).
   - Compacted required fill: $V_{\text{fill, CCM}}$ ($m^3$).
   - Bank-equivalent required fill: $V_{\text{fill, BCM}} = \frac{V_{\text{fill, CCM}}}{1 - S_h}$ (where $S_h$ is shrinkage factor, e.g. 0.10, so $C = 0.90$).
2. **Mass Conservation**:
   - Bank density $\rho_{\text{bank}}$ ($t/m^3$).
   - Cut mass $M_{\text{cut}} = V_{\text{cut, BCM}} \times \rho_{\text{bank}}$ (metric tonnes).
   - Loose density $\rho_{\text{loose}} = \rho_{\text{bank}} / S_w$.
   - Conserved mass: $V_{\text{cut, LCM}} \times \rho_{\text{loose}} \equiv M_{\text{cut}}$ (identity holds identically).
3. **Dump Truck Load Estimator**:
   - User parameters: $C_{\text{truck}}$ (truck volume capacity, default 15.0 $m^3$), $W_{\text{truck}}$ (truck legal weight limit, default 20.0 tonnes).
   - Volume-limited loads: $N_{\text{vol}} = \frac{V_{\text{cut, LCM}}}{C_{\text{truck}}}$.
   - Weight-limited loads: $N_{\text{wt}} = \frac{M_{\text{cut}}}{W_{\text{truck}}}$.
   - Effective loads: $N_{\text{loads}} = \lceil \max(N_{\text{vol}}, N_{\text{wt}}) \rceil$.
   - Governing factor: `"weight_limited"` if $N_{\text{wt}} \ge N_{\text{vol}}$ else `"volume_limited"`.
   - Site mass balance:
     $$\Delta V_{\text{BCM}} = V_{\text{cut, BCM}} - V_{\text{fill, BCM}}$$
     If $\Delta V_{\text{BCM}} > 0$: Net Export of $\Delta V_{\text{BCM}} \times S_w$ loose $m^3$ ($\lceil \frac{\Delta V_{\text{BCM}} \times S_w}{C_{\text{truck}}} \rceil$ truck trips off-site).
     If $\Delta V_{\text{BCM}} < 0$: Net Import required of $|\Delta V_{\text{BCM}}| \times S_w$ loose $m^3$ delivered to site.

### 2.3 True 3D GCP Residuals & 1-Click TBM Datum Calibration
1. Pair target $j$: $(E_{\text{gcp}, j}, N_{\text{gcp}, j}, H_{\text{gcp}, j})$ with $(E_{\text{scan}, j}, N_{\text{scan}, j}, H_{\text{scan}, j})$.
2. Residual components:
   $$\Delta E_j = E_{\text{scan}, j} - E_{\text{gcp}, j}$$
   $$\Delta N_j = N_{\text{scan}, j} - N_{\text{gcp}, j}$$
   $$\Delta H_j = H_{\text{scan}, j} - H_{\text{gcp}, j}$$
   $$\Delta \text{2D}_j = \sqrt{\Delta E_j^2 + \Delta N_j^2}, \quad \Delta \text{3D}_j = \sqrt{\Delta E_j^2 + \Delta N_j^2 + \Delta H_j^2}$$
3. Accuracy RMSE metrics:
   $$\text{RMSE}_E = \sqrt{\frac{1}{M}\sum \Delta E_j^2}, \quad \text{RMSE}_N = \sqrt{\frac{1}{M}\sum \Delta N_j^2}$$
   $$\text{RMSE}_{\text{Horiz}} = \sqrt{\text{RMSE}_E^2 + \text{RMSE}_N^2}$$
   $$\text{RMSE}_H = \sqrt{\frac{1}{M}\sum \Delta H_j^2}, \quad \text{RMSE}_{\text{3D}} = \sqrt{\text{RMSE}_{\text{Horiz}}^2 + \text{RMSE}_H^2}$$
4. 1-Click Vertical TBM Calibration:
   - Identify datum shift $\delta Z$:
     If specific benchmark selected: $\delta Z = \Delta H_{\text{TBM}}$.
     Else site mean vertical error: $\delta Z = \frac{1}{M}\sum \Delta H_j$.
   - Apply calibration:
     $$H_{\text{scan, cal}, j} = H_{\text{scan}, j} - \delta Z$$
     $$\Delta H_{\text{cal}, j} = H_{\text{scan, cal}, j} - H_{\text{gcp}, j}$$
     $$\text{RMSE}_{H, \text{cal}} = \sqrt{\frac{1}{M}\sum (\Delta H_{\text{cal}, j})^2}$$
   - This drives $\Delta H_{\text{TBM}} \to 0$ and drastically reduces $\text{RMSE}_H$.

### 2.4 Centerline Stationing & Average-End-Area Roadway Math
1. Centerline Polyline alignment $[P_0, P_1, \dots, P_m]$:
   Cumulative chainage $s_k$. Stationing tag formatted as:
   `station_code = f"{int(s_k // 1000)}K+{s_k % 1000:06.2f}"` (e.g. `0K+020.00`).
2. Transverse normal vector $\mathbf{N}_{\perp} = (-\Delta N, \Delta E) / \|\Delta L\|$.
3. Transverse slice profile sampled from DSM at transverse offset $u \in [-W_{\text{left}}, W_{\text{right}}]$:
   $$E(u) = E(s_k) + u \cdot N_{\perp, E}, \quad N(u) = N(s_k) + u \cdot N_{\perp, N}$$
   Ground surface elevation: $Z_{\text{ground}}(u) = \text{sample\_dsm}(E(u), N(u))$.
4. Parametric template at station $k$:
   Crown center elevation $Z_{\text{design, center}}$.
   For $|u| \le B/2$ (carriageway): $Z_{\text{design}}(u) = Z_{\text{design, center}} - |u| \times S_c$.
   For $|u| > B/2$ (daylight cut/fill batter slopes):
   Slope intersection: cut slope $1:m_{\text{cut}}$, fill slope $1:m_{\text{fill}}$.
5. Cross-Section End Areas:
   $$A_{\text{cut}}(k) = \int \max(Z_{\text{ground}}(u) - Z_{\text{design}}(u), 0) du \quad (m^2)$$
   $$A_{\text{fill}}(k) = \int \max(Z_{\text{design}}(u) - Z_{\text{ground}}(u), 0) du \quad (m^2)$$
6. Average-End-Area Volume Integration:
   $$V_{\text{cut}} = \sum_{k=0}^{n-1} \frac{A_{\text{cut}}(k) + A_{\text{cut}}(k+1)}{2} \times (s_{k+1} - s_k) \quad (m^3)$$
   $$V_{\text{fill}} = \sum_{k=0}^{n-1} \frac{A_{\text{fill}}(k) + A_{\text{fill}}(k+1)}{2} \times (s_{k+1} - s_k) \quad (m^3)$$

### 2.5 Ponding Depression Volume Quantification
1. On the high-resolution DSM raster grid:
   Identify local topographic sinks (cells $(r, c)$ where $Z(r, c) < Z(\text{neighbors})$).
2. Connected component basin growing up to the spill pour-point elevation:
   $$Z_{\text{spill}} = \min_{(r, c) \in \partial \Omega} Z(r, c)$$
3. Depression ponding depth:
   $$d(r, c) = \max(0, Z_{\text{spill}} - Z(r, c))$$
4. Depression volume:
   $$V_{\text{pond}} = \sum_{(r, c) \in \Omega} d(r, c) \times \Delta x \times \Delta y \quad (m^3)$$
5. Depression surface area:
   $$A_{\text{pond}} = \text{count}(\Omega) \times \Delta x \times \Delta y \quad (m^2)$$
6. Max depth: $d_{\max} = \max d(r, c)$.

### 2.6 Surface Flatness, Levelness & Wall Plumbness 3D Computation
1. Sample 3D points $\mathbf{p}_i = (x_i, y_i, z_i)$ inside selected region.
2. Centroid $\bar{\mathbf{p}} = \frac{1}{N}\sum \mathbf{p}_i$.
3. Plane reference cases:
   - **Horizontal (Floor Flatness/Levelness)**: $\mathbf{n} = (0, 0, 1)$, plane $z = \bar{z}$ or target elevation $Z_{\text{target}}$.
   - **Vertical Plumb (Wall Plumbness)**:
     Compute horizontal wall azimuth line $a \cdot x + b \cdot y + c = 0$ ($a^2 + b^2 = 1$).
     Plumb plane normal $\mathbf{n}_{\text{plumb}} = (a, b, 0)$.
     Fit 3D PCA normal $\mathbf{n}_{\text{fit}} = (n_x, n_y, n_z)$.
     Plumb tilt angle: $\theta_{\text{tilt}} = \arcsin(|n_z|)$.
     Plumb tilt ratio: $1 : (1 / \tan(\theta_{\text{tilt}}))$ (e.g. $1:350$) and mm/m displacement.
   - **Best-Fit Plane**: Smallest eigenvector of $3 \times 3$ covariance matrix $\mathbf{C} = \frac{1}{N}\sum (\mathbf{p}_i - \bar{\mathbf{p}})(\mathbf{p}_i - \bar{\mathbf{p}})^T$.
4. Signed point deviation: $\delta_i = \mathbf{n} \cdot (\mathbf{p}_i - \bar{\mathbf{p}})$.
5. Tolerance pass rate: $P_{\text{pass}} = \frac{\sum [|\delta_i| \le \text{tol}]}{N} \times 100\%$.
6. Identify `max_high` coordinate & deviation, and `max_low` coordinate & deviation.

### 2.7 Open-Trench Utility 3D Tracer Math
1. Polyline centerline $[P_1, \dots, P_m]$:
   Pipe outer diameter $D$.
   Target feature:
   - If crown: $Z_{\text{crown}} = Z_k, Z_{\text{axis}} = Z_k - D/2, Z_{\text{invert}} = Z_k - D$.
   - If invert: $Z_{\text{invert}} = Z_k, Z_{\text{axis}} = Z_k + D/2, Z_{\text{crown}} = Z_k + D$.
2. Depth of cover: $H_{\text{cover}} = Z_{\text{ground}}(E_k, N_k) - Z_{\text{crown}, k}$.
3. Segment gradient:
   $$S_{\%} = \frac{Z_{\text{invert}, k+1} - Z_{\text{invert}, k}}{\sqrt{(E_{k+1} - E_k)^2 + (N_{k+1} - N_k)^2}} \times 100\%$$
   $$\text{Gradient ratio} = 1 : \left(\frac{L_{\text{2D}}}{|\Delta Z|}\right)$$
4. Cumulative 3D length $\sum L_{\text{3D}}$.

### 2.8 Scan-to-BIM Primitive Fitting & Exporters
1. Primitive extraction from classified objects:
   - **Trees**:
     * Trunk: Vertical Cylinder with base $(E, N, H)$, radius $r = \text{DBH}/2$, height $H_{\text{trunk}}$.
     * Crown: Cone / Ellipsoid with base at trunk top, radius $R_{\text{crown}}$, height $H_{\text{crown}}$.
   - **Walls**:
     * 3D Extruded prism or 3D Oriented Bounding Box along `base_polyline` with mean height and thickness $0.3\text{m}$.
   - **Roads / Pavements**:
     * 3D Planar prism with thickness $0.2\text{m}$ following road boundary polygon.
   - **Water Bodies**:
     * 3D Planar polygon at hydrostatic TWVD2001 elevation.
   - **Buildings**:
     * 3D Extruded massing cuboid from footprint polygon.
   - **Pipes**:
     * 3D Pipe cylinders connecting pipe joints.
2. Standard Exporters:
   - **IFC4 / IFC2X3 SPF (STEP ISO-10303-21)**:
     Standard entity tree: `IFCPROJECT`, `IFCSITE`, `IFCBUILDING`, `IFCBUILDINGSTOREY`, `IfcWall`, `IfcSlab`, `IfcBuildingElementProxy`, `IfcGeographicElement`, `IfcPipeSegment`.
   - **AutoCAD 3D DXF**:
     `3DSOLID` / `3DFACE` / faceted polyface mesh with standard layer assignments.
   - **Wavefront OBJ + MTL**:
     Low-poly simplified CAD model with named groups (`g Building_01`, `g Wall_02`, `g Tree_03`) and category materials.

---

## 3. Caveats
1. **Numerical Stability on Collinear / Point Boundary Inputs**:
   When fitting a least-squares plane to a polygon boundary, if points are nearly collinear ($D \approx 0$), the least-squares normal equation determinant collapses.
   *Mitigation*: Guard with threshold $|D| < 10^{-12}$; if determinant is near-zero, gracefully fallback to flat datum elevation ($\bar{z}$).
2. **Dense Mesh Memory Footprint on Large Merged Scans**:
   Extracting all triangles from large merged scans (e.g. `edited_qihu_unified_merged_scan_4_scans__edited_372953` with ~4.5M triangles) can be memory intensive if loaded all at once into RAM.
   *Mitigation*: The backend already leverages the raster DSM (`dsm_data`) with spatial bounds indexing and KD-trees. The new endpoints should prioritize sampling from DSM raster and pre-computed categorization cache before falling back to full triangle loads.
3. **No External Dependencies (Pure Python Stdlib)**:
   IFC generation must NOT rely on heavy third-party C++ libraries (e.g. `ifcopenshell`) that might fail to compile on Windows or the Hostinger VPS Docker container.
   *Mitigation*: Implement standard ASCII STEP physical file generation (`ISO-10303-21`) using Python stdlib templates. This guarantees 100% platform portability and zero dependency risk.
4. **File Line Headroom Discipline**:
   Creating large monoliths would risk violating the 5,000-line ceiling in `test_07_modular_architecture_strict_5000_line_ceiling`.
   *Mitigation*: Split new capabilities into two new dedicated mixin modules:
   - `pc_worker/surveying/construction_qa.py`
   - `pc_worker/surveying/scan_to_bim.py`
   Both will easily remain well under 1,500 lines, preserving massive headroom across the entire repository.

---

## 4. Conclusion & Concrete Inventory of Backend Changes

### 4.1 New Modular Backend Mixins & Files
1. **`pc_worker/surveying/construction_qa.py`** (`ConstructionQaMixin`):
   - `compute_surface_flatness_and_plumbness(payload)`: Horizontal floor flatness, vertical wall plumbness, best-fit plane, deviation heatmap, plumb tilt ratio, pass rate %.
   - `trace_open_trench_utility(payload)`: Invert/crown/axis 3D coordinates, 3D length, pipe gradient % and 1:N, depth of cover, CSV schedule, 3D DXF.
   - `export_rtk_stakeout_points(payload)`: Strictly $E, N, Z$ order CSV export (`PtID, Easting, Northing, Elevation, Code`) and printable HTML/PDF stakeout field card.
2. **`pc_worker/surveying/scan_to_bim.py`** (`ScanToBimMixin`):
   - `extract_scan_to_bim_model(payload)`: Fits 3D geometric primitives (cuboids, cylinders, planar slabs, extruded prisms) from classified scan objects.
   - `generate_ifc_spf_file(data, output_path)`: Exports standard IFC4 / IFC2X3 STEP physical file.
   - `generate_bim_3d_dxf(data, output_path)`: Exports AutoCAD 3D solids / polyface mesh DXF.
   - `generate_bim_obj_and_mtl(data, output_path)`: Exports simplified CAD Wavefront OBJ + MTL.
3. **`pc_worker/surveying/dsm_and_volume.py`** (`DsmAndVolumeMixin` Enhancements):
   - In `calculate_cut_fill_volume`:
     * Add `base_mode: "best_fit_plane"` (least-squares 2D reference plane).
     * Calculate Bank Volume ($BCM$), Loose Volume ($LCM$), Compacted Volume ($CCM$), Conserved Mass (tonnes).
     * Calculate Dump Truck Load Estimator (truck trips, volume vs weight limit, import/export balance).
   - In `compute_gcp_accuracy_qa`:
     * True 3D residuals ($\Delta E, \Delta N, \Delta H, \text{RMSE}_E, \text{RMSE}_N, \text{RMSE}_H, \text{RMSE}_{2D}, \text{RMSE}_{3D}$).
     * 1-Click Vertical TBM Datum Bias Calibration.
   - In `compute_drainage_and_slope`:
     * User-selectable custom slope tiers.
     * Quantify ponding depression volumes ($m^3$), max depth (m/cm), surface area ($m^2$), and spill pour points.
4. **`pc_worker/surveying/contours_and_cad.py`** (`ContoursAndCadMixin` Enhancements):
   - In `compute_cross_section_profile`:
     * Centerline stationing `0K+000` along polyline alignments.
     * Transverse cross-section slicing (swath width left/right).
     * Parametric road/trench template overlay.
     * Average-End-Area volume integration.
5. **`pc_worker/optimizer_bridge.py` & `web/src/06-studio-align-and-optimizer.js`**:
   - Synchronize `WGS84_UTM51N` (20.60 m) and `WGS84_UTM50N` (19.80 m) vertical geoid offsets.
   - Support `geoid_offset_override` / `h_offset_from_twvd` parameter in optimizer and survey endpoints.
6. **`pc_worker/surveying_engine.py`**:
   - Inherit `ConstructionQaMixin` and `ScanToBimMixin` in `SurveyingEngine`.
7. **`pc_worker/server_api_routes.py`**:
   - Wire new endpoints:
     * `POST /api/survey/surface-qa`
     * `POST /api/survey/utility-trace`
     * `POST /api/survey/stakeout-export`
     * `POST /api/survey/scan-to-bim` (and `GET /api/survey/scan-to-bim`)

---

## 5. Verification Method

### 5.1 Automated Unit & Regression Tests
Run the project test suite via Powershell / Python:
```powershell
python -m unittest tests/test_gathering_scans_suite.py
```
**Acceptance Criteria**:
1. All 29 existing tests continue to pass with zero regressions.
2. New unit tests added to `tests/test_gathering_scans_suite.py` verify:
   - Least-squares best-fit plane cut/fill calculation matches expected analytical slope and volume.
   - Bank (BCM), Loose (LCM), Compacted (CCM) volumes and mass conservation identity:
     $$\text{Mass}_{\text{BCM}} == \text{Mass}_{\text{LCM}}$$
   - Dump truck load estimator calculations.
   - Synchronized UTM51N / UTM50N geoid catalog and user override parameter.
   - 3D GCP residuals ($\Delta E, \Delta N, \Delta H, \text{RMSE}_{3D}$) and 1-click TBM calibration.
   - Centerline stationing format (`0K+000`), parametric cross-section slicing, and Average-End-Area integration.
   - Slope tiers and ponding depression water volume ($m^3$), max depth, and surface area.
   - Surface flatness, floor levelness, wall plumbness deviation heatmap, pass rate %, and plumb tilt ratio.
   - Open-trench utility tracer 3D length, invert/crown coordinates, gradient % and 1:N, depth of cover, CSV, and 3D DXF.
   - RTK stakeout export with points strictly in $E, N, Z$ order.
   - Scan-to-BIM primitive fitting and valid IFC / 3D DXF / OBJ generation.
   - Strict 5,000-line ceiling verified across all source files.

### 5.2 Local Scan Dataset Integration Check
Test endpoints against local regression scans in `data/categorization_cache/`:
- `rosepark_20260918_merged`
- `edited_qihu_unified_merged_scan_4_scans__edited_372953`
- `ntudorm_20260915_baseline`
- `QuChi261016_Trees`

### 5.3 Invalidation Conditions
The design is invalidated if:
1. Any file exceeds 5,000 lines.
2. Stakeout points are exported in $N, E, Z$ order rather than strictly $E, N, Z$.
3. Cut mass does not equal loose mass (mass conservation failure).
4. External compiled dependencies (e.g. `ifcopenshell`) are required, breaking deployment on Windows or VPS containers.
