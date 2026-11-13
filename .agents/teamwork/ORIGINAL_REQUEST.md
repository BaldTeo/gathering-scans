# Original User Request

## Approved Task Prompt — 2026-10-31T03:28:01Z

Act as a high level orchestrator and subdivide work in several layers of sub-agents, continue working on the goals for at least 4 hours, make sure the verification critic agents are as harsh and nasty as possible, and post periodic progress reports with screenshots from the web interface. Build and enhance surveying, construction QA, and Scan-to-BIM capabilities in GatheringScans for general contractor engineering workflows.

Integrity mode: development
The team must NOT: delete or damage any existing data including scans and comments

## Verification Resources
- Automated test suite: `tests/test_gathering_scans_suite.py`
- Local scan datasets: `edited_qihu_unified_merged_scan_4_scans__edited_372953`, `rosepark_20260918_merged`, `ntudorm_20260915_baseline`, `QuChi261016_Trees`

## Requirements

### R1. Non-Intrusive UI Containers & Project-Agnostic Settings
Make sure new tools have proper containers and will not flood the existing minimalist interface. The code must be project-agnostic: project type must NOT set any hardcoded values or tolerances; if any different settings are required, they should be selected by the USER. The team must NOT delete or damage any existing data including scans and comments.

### R2. Core Surveying, Earthwork & Control Alignment Fixes (P0–P3)
- Implement least-squares best-fit plane for cut/fill volume calculations and mass conservation reporting: Bank Volume (BCM m³), Loose Volume (LCM m³), Compacted Volume (CCM m³), conserved Mass (metric tonnes), and Dump Truck Load Estimator with user-selectable parameters.
- Synchronize UTM51N / UTM50N vertical geoid offsets between frontend and backend catalogs with user override support.
- Implement true 3D (E, N, H) GCP control target pairing against scan coordinates and one-click vertical TBM datum bias calibration.
- Implement centerline stationing (0K+000) with user-selectable interval, swath width, and parametric cross-section template overlay with Average-End-Area volume calculations.
- Implement user-selectable slope and drainage classification tiers and quantify ponding depression volumes (m³).

### R3. Construction QA Tools, Open-Trench Utility Tracer & RTK Stakeout (P4–P5)
- Implement 3D surface flatness, levelness, and wall plumbness inspector with user-configurable reference plane (Horizontal, Vertical Plumb, or Best-Fit) and tolerance thresholds, reporting deviation heatmap, Pass Rate %, Max High/Low coordinates, and Plumb Tilt ratio.
- Implement open-trench buried utility 3D as-built tracer extracting 3D length, invert/crown coordinates, pipe gradient (% and 1:N), and depth of cover, exporting CSV and 3D DXF.
- Implement RTK stakeout export with point order strictly in E N Z order (PtID, E, N, Z, Code) and printable site sheet.
- Implement polygon-bounded ΔV Cut/Fill volume takeoff directly inside Multi-Epoch Compare View.

### R4. Scan-to-BIM Simplified Classified Geometric Model (Goal 4)
Create a simplified geometric model from the scan where all elements are correctly classified (buildings, walls, sidewalks, trees, water bodies, pipes/utilities, etc.) as simplified geometric primitives with semantic classification, interactive 3D studio preview, and CAD/BIM export.

### R5. Architecture, Modular Limits & Deployment Rules
Maintain the strict 5,000-line ceiling per file across all frontend and backend source files. Adhere to style and translation guidelines in AGENTS.md, along with mandatory GitHub, local server (127.0.0.1:8095), and VPS synchronization protocols.

## Acceptance Criteria

### Minimalist UI & Usability
- [ ] New tools reside in collapsible or tabbed containers that preserve the existing minimalist interface.
- [ ] No hardcoded project tolerances or values exist; all calculation parameters are user-selectable.
- [ ] Existing scans, comments, and project data remain intact without deletion or corruption.

### Surveying Calculations & Output Standards
- [ ] Cut/fill volumes conserve mass across BCM, LCM, and CCM with least-squares best-fit reference plane matching frontend and backend.
- [ ] Stakeout points export in exact E N Z coordinate order.
- [ ] GCP QA evaluates true 3D residuals (ΔE, ΔN, ΔH, RMSE) with one-click vertical TBM datum correction.
- [ ] Stationing profile calculates Average-End-Area volumes and displays parametric design templates.
- [ ] Ponding depressions report water volume (m³), max depth, and surface area.

### Construction QA & Utility Tracer
- [ ] Surface flatness/plumbness inspector computes deviation heatmaps and plumb tilt ratios against user-configured tolerance thresholds.
- [ ] Open-trench utility tracer computes 3D length, gradient, and depth of cover, exporting CSV and 3D DXF.
- [ ] Multi-Epoch Compare View computes polygon-bounded ΔV cut/fill volume takeoff.

### Scan-to-BIM Model
- [ ] Generates simplified geometric primitives classified by element category from 3D scan data.
- [ ] Provides interactive 3D preview and export in standard CAD/BIM-compatible formats.

### Verification & Testing
- [ ] All unit and regression tests pass in `tests/test_gathering_scans_suite.py` without exceeding the 5,000-line modular ceiling.
- [ ] Periodic progress reports include screenshots from the web interface.

## Follow-up — 2026-10-31T04:36:23Z

User update regarding Git push limits & VPS deployment:
"Unfortunately, I have hit git web push limits for today, so we need to continue testing locally. Or can we go around the git push limits by uploading directly to website?"

Instructions for the Orchestrator and all Workers/Critics:
1. Keep making local git commits (`git add ... && git commit -m ...`), and if `git push origin main` hits a GitHub limit or rate-limit, do NOT let that block any milestone or gate.
2. Continue full local testing and browser screenshot verification against the local server (`http://127.0.0.1:8095`).
3. To keep the live website (`https://scans.gatheren.cloud` on `76.13.197.29`) updated without relying on GitHub pulls, upload modified files directly over SSH/SCP (`ssh -i "$env:USERPROFILE\.ssh\id_gathering_vps" -o StrictHostKeyChecking=no root@76.13.197.29`) to `/docker/gathering_scans` and `/opt/gathering_scans` and copy into the running `gathering_scans_web` container (note: `gathering_scans_web`'s startup script pulls `main.tar.gz` from GitHub on full `docker restart`, so use `docker cp` into `gathering_scans_web` and signal/reload the Python process inside the container—or patch the host bind-mounted files—so direct uploads are not overwritten by an older GitHub tarball).

## Follow-up — 2026-10-31T05:38:14Z

Reminder from user requirements:
Please make sure the orchestrator or workers capture real `.png` screenshots of the web interface (`http://127.0.0.1:8095`) showing the newly added UI cards/containers (e.g., into `c:\Antigravity\GatheringScans\.agents\teamwork\screenshots\`) and include their file paths in your progress messages so we can embed the screenshots directly in our periodic progress reports to the user.

## Follow-up — 2026-10-31T06:19:18Z

URGENT USER FEEDBACK & NEW SCOPE EXTENSION (Must be enforced immediately in M2 Gate 1 and across all milestones):

### Part 1: Strict UI/UX Violations Spotted by User in `m2_gcp_qa_inspector.png` (MUST FIX NOW & ENFORCE IN ALL CRITIC GATES)
User feedback on `m2_gcp_qa_inspector.png`:
> "Just looking at this photo, I immediately see that emojis were used instead of icons, which is a no-no; bright/dark theme were not properly configured; excessive text and more than 1 word in buttons."

Mandatory UI/UX Rules for Orchestrator, Workers, and Critics (treat any violation as an immediate Gate FAIL):
1. **ZERO EMOJIS IN UI**: Never use Unicode emojis (`📍`, `📊`, `⚖️`, `📋`, `📄`, `🔍`, `✅`, `⚠️`, `🚛`, etc.) anywhere in HTML/JS UI labels, headings, badges, or buttons. Always use clean inline SVG icons matching the existing app's minimalist icon system.
2. **PROPER BRIGHT & DARK THEME SUPPORT**: Never hardcode dark-only inline colors (such as `#0f172a`, `#1e293b`, `#f8fafc`, `rgba(15,23,42,...)`) in JS templates or `web/survey-bim.css`! Use the app's CSS custom properties (`var(--bg-surface)`, `var(--bg-elevated)`, `var(--text-main)`, `var(--text-muted)`, `var(--border-subtle)`, etc., and explicit light/dark theme selectors matching `web/app.css`) and capture verification screenshots in **BOTH Dark Theme and Bright/Light Theme** to prove proper contrast and styling in both themes.
3. **MINIMALIST TEXT & STRICT 1-WORD BUTTONS**:
   - Remove verbose paragraphs, explanatory walls of text, and wordy subtitles inside inspector panels. Use compact metric cells and tooltips (`title="..."`) instead of long text blocks.
   - **Every button label MUST be at most 1 word** (plus an SVG icon), e.g., `[svg] Pick`, `[svg] Run`, `[svg] CSV`, `[svg] Report`, `[svg] Calibrate`, `[svg] Reset`, `[svg] Export` (or in Chinese single-action terms like `選點`, `計算`, `匯出`, `報告`, `校正`). Never put multi-word sentences inside buttons!

### Part 2: Additional Milestone After Scan-to-BIM — Real Public Utilities GIS Integration (Findings from Agent `4e5ad749-15ee-494d-8c99-be6a31aac2c4`)
User instruction:
> "When you are done with all discussed work items including Scan-to-BIM, then please work on implementing what agent 4e5ad749-15ee-494d-8c99-be6a31aac2c4 has found. I don't currently have the Taipei city API application, so first I want to see the absolute maximum we can achieve without it or any other bureaucratic procedures."

Verified findings from `4e5ad749-15ee-494d-8c99-be6a31aac2c4` to implement as a dedicated milestone once P0–P5 and Scan-to-BIM are completed (**CRITICAL RULE: 100% real data from live APIs/files only — absolute ZERO fake, mocked, or hardcoded utility data**):
1. **Live Unauthenticated Vector & Elevation REST APIs (100% Open, Zero Bureaucracy)**:
   - New Taipei City Sanitary Sewer (`sewer.ntpc.gov.tw` ArcGIS REST query): Manholes, Catch Basins, Sewer Pipes with inverts/depths/slope, house connections.
   - New Taipei City Stormwater Sewer (`wrd.ntpc.gov.tw` ArcGIS REST query): Storm culverts, pipes, manholes, catch basins.
   - Taipei City Unauthenticated 3D Elevation & Underground Pipeline Profile PDF (`3dgis.reac.taipei`): `get3dz.ashx` (official TWVD2001 ground Z for ΔZ verification), `PipeQueryPDF_v3.ashx` (official 3D pipeline cross-section PDF without whitelist), Taipei 2D 8-major-utilities dynamic token MapServer (`dig.taipei`), Taipei 2025 Topo WMTS (`historygis.udd.gov.taipei`).
   - New Taipei iRoad Live Excavation & Manhole APIs (`roadmt.maintenance.ntpc.gov.tw`).
2. **Open Data Portal APIs & Vector Extracts (`data.taipei`, `data.ntpc.gov.tw`, `data.gov.tw`, NLSC WMTS)**:
   - Taipei Storm/Sanitary pipes KML/CSV/GML, Common Ducts SHP/GML, Fire Hydrants, Streetlights, Today's Excavations.
   - New Taipei Daily Road Excavations, Streetlights w/ pole height.
   - National NLSC Fire Hydrant WMTS, Taipower Utility Poles CSV.
3. **Standard MOI NGIS GML 3.1.1, KML, GeoJSON Importer & 3D Subsurface Renderer**:
   - Parse MOI NGIS GML 3.1.1, KML, GeoJSON, CSV/SHP.
   - Render 3D cylindrical pipes, box culverts, manholes, hydrants, poles clipped to scan bounding box and export alongside Scan-to-BIM primitives (DXF/GeoJSON/IFC-ready JSON).
   - Strict Rule: Report 0 features honestly if outside coverage area; NEVER generate fake utility pipes!

## Follow-up — 2026-10-31T06:20:14Z

User addition for the Utilities GIS milestone:
"Regarding utilities, I hope there will be another tool "Utilities", in which I can configure the visibility of individual utility layers separately. They should be colour coded and flow direction animated."

Mandatory specifications:
1. Dedicated "Utilities" tool (`Utilities` / `管線`) in Studio dock / inspector (SVG icon, 1-word button label, proper Bright & Dark theme, no emojis, compact layout).
2. Individual visibility checkboxes/toggles (and feature counts) for each utility layer:
   - Storm Sewer (`雨水` — Cyan `#06b6d4`)
   - Sanitary Sewer (`污水` — Brown/Amber `#d97706`)
   - Water Supply & Hydrants (`自來水/消防栓` — Blue `#3b82f6`)
   - Electricity & Poles (`電力/電桿` — Red `#ef4444`)
   - Telecom (`電信` — Green `#10b981`)
   - Natural Gas (`瓦斯` — Yellow `#eab308`)
   - Common / Broadband Ducts (`共同管道` — Orange/Purple `#8b5cf6`)
   - Streetlights (`路燈` — Gold `#f59e0b`)
   - Active Road Excavations (`道路挖掘` — Magenta `#ec4899`)
   - Open-Trench As-Built Traced Pipes (`竣工實測` — Emerald `#14b8a6`)
3. Color-Coded 3D Subsurface Rendering & Animated Flow Direction:
   - 3D cylindrical pipes by diameter DIA, 3D rectangular box culverts by P_WIDTH × P_HEIGHT, vertical manhole cylinders from rim to invert, hydrants, poles.
   - Animate flow direction: in `requestAnimationFrame` loop (scrolling directional chevron/dash texture UV offset or flow pulses from upstream UIE to downstream DIE or higher to lower elevation) with toggle/speed control in the Utilities panel.

## Follow-up — 2026-10-31T06:47:05Z

Harsh Visual Inspection of `m2_gcp_qa_dark_scrolled.png` and `m2_gcp_qa_light_scrolled.png` — 3 Visual Polish Issues to Fix Before Clearing Gate 2:
1. **Legacy Emoji Peeking at Bottom of Panel**: At the very bottom of `m2_gcp_qa_light_scrolled.png` (just below the `CSV` / `報告` / `列印` buttons), a clipped legacy row from `08-advanced-surveying-and-qa.js` is peeking through with a green plant emoji (`🌱`). Make sure any legacy DOM content in `openGcpAccuracyQaInspector` is completely replaced/removed and grep all of `web/src/*.js` around GCP/Volume/Survey inspectors for any remaining emojis.
2. **Duplicate Header & Wrapping CRS Subtitle**: The outer panel header already says `控制點精度檢核`, and right below it the card repeats `控制點空間精度檢核` with a 3-line wrapping subtitle (`CRS: TWD97 / TM2 zone 121 + TWVD 2001 height - EPSG:3826+8904 [TWGEOID2018h] · N = 6` where `= 6` dangles on a 3rd line). Remove the duplicate inner heading and make the CRS line a single compact pill (`EPSG:3826 + TWVD2001 · N=6`).
3. **Horizontal Scrollbar Clipping the Residual Table**: The residual table (`TBM | ID | H_gcp | H_scan | dE | dN | dH (cm) | d3D (cm)`) overflows the narrow side panel width, causing a horizontal scrollbar and clipping the rightmost status column. Make the table columns compact (`TBM | ID | ΔE | ΔN | ΔH | Δ3D` in cm, with `H_gcp / H_scan` in row tooltip `title="..."`) so it fits 100% cleanly inside the side panel with zero horizontal scrollbar!






## Follow-up — 2026-10-31T06:21:03Z

User addition for the Utilities GIS milestone:
"Regarding utilities, I hope there will be another tool "Utilities", in which I can configure the visibility of individual utility layers separately. They should be colour coded and flow direction animated."

Mandatory specifications:
1. Dedicated "Utilities" tool (`Utilities` / `管線`) in Studio dock / inspector (SVG icon, 1-word button label, proper Bright & Dark theme, no emojis, compact layout).
2. Individual visibility checkboxes/toggles (and feature counts) for each utility layer separately:
   - Storm Sewer (`雨水` — Cyan `#06b6d4`)
   - Sanitary Sewer (`污水` — Brown/Amber `#d97706`)
   - Water Supply & Hydrants (`自來水/消防栓` — Blue `#3b82f6`)
   - Electricity & Poles (`電力/電桿` — Red `#ef4444`)
   - Telecom (`電信` — Green `#10b981`)
   - Natural Gas (`瓦斯` — Yellow `#eab308`)
   - Common / Broadband Ducts (`共同管道` — Orange/Purple `#8b5cf6`)
   - Streetlights (`路燈` — Gold `#f59e0b`)
   - Active Road Excavations (`道路挖掘` — Magenta `#ec4899`)
   - Open-Trench As-Built Traced Pipes (`竣工實測` — Emerald `#14b8a6`)
3. Color-Coded 3D Subsurface Rendering & Animated Flow Direction:
   - 3D cylindrical pipes by diameter DIA, 3D rectangular box culverts by P_WIDTH × P_HEIGHT, vertical manhole cylinders from rim to invert, hydrants, poles.
   - Animate flow direction: in `requestAnimationFrame` loop (scrolling directional chevron/dash texture UV offset or flow pulses from upstream UIE to downstream DIE or higher to lower elevation) with toggle/speed control in the Utilities panel.

## Follow-up — 2026-10-31T07:11:03Z

User message:
"Please report % of completed work, and try to expedite the work by using more parallel agents. From screenshots it seems only 1st milestone out of 7 is nearing completion"

Directives:
1. Milestone 1 and Milestone 2 are complete. Capture Dark + Light theme screenshots of Milestone 1 (Cut/Fill Volume Inspector showing BCM/LCM/CCM mass conservation schedule, best-fit plane, and dump truck estimator) to demonstrate visual completion alongside M2.
2. Parallelize M3, M4, M5, M6, and M7 simultaneously across decoupled modular files:
   - Track A (M3 — Stationing 0K+000 + Drainage Ponding Volume): `pc_worker/surveying/dsm_and_volume.py` / `contours_and_cad.py` + `web/src/09-construction-survey-and-bim.js`.
   - Track B (M4 & M5 — Flatness/Plumbness QA, Utility Tracer, Compare ΔV, RTK Stakeout): new `pc_worker/surveying/construction_qa.py` + `web/src/10-construction-qa-and-stakeout.js`.
   - Track C (M6 — Scan-to-BIM Simplified Classified Geometric Model): new `pc_worker/surveying/scan_to_bim.py` + `web/src/11-scan-to-bim-primitives.js`.
   - Track D (M7 — Real Public Utilities GIS Integration, layer toggles, animated flow direction): new `pc_worker/surveying/public_utilities_gis.py` + `web/src/12-public-utilities-gis.js`.
3. Include an explicit Overall % Completed breakdown (M1 through M7) in every progress report.


## Follow-up — 2026-10-31T07:51:43Z

Quick visual polish & screenshot check while M3–M7 critics run:
1. In `m3_stationing_dark_theme.png` / `m3_stationing_light_theme.png`, the label `横断面檢視` next to the station dropdown wraps onto 2 narrow lines (`ll 横断面` / `檢視`), and the inner card header `道路與溝渠樁號斷面` repeats right below the outer panel header `樁號斷面與平均端面土方` (similarly in `m3_drainage_ponding_dark_theme.png`, `坡度與積水窪蓄分析` repeats inside the card). Please ensure the M3 worker tightens that header (`white-space: nowrap` on the station label + no duplicate inner header) and refreshes the M3 screenshots.
2. Please ensure dual-theme screenshots (`dark` + `light`) are captured in `c:\Antigravity\GatheringScans\.agents\teamwork\screenshots\` for M4 (`m4_flatness_plumb_...`, `m4_trench_utility_...`), M5 (`m5_compare_delta_v_...`, `m5_stakeout_...`), and M6 (`m6_scan_to_bim_...`) so we can embed all 7 milestones' visual proof in chat for the user.


## Follow-up — 2026-10-31T07:59:17Z

User / Caller visual inspection feedback on M4 & M5 screenshots:
1. In `m4_surface_qa_dark.png`, `m4_utility_trace_dark.png`, and `m5_compare_volume_dark.png`, the screenshots were captured BEFORE clicking the action button (`檢核` / `追蹤` / `計算`), so the results cards (Pass-Rate %, Plumbness 1/N, deviation heatmap, traced pipe slope/depth table, and Compare ΔV Cut/Fill/Net metrics) are empty/not shown in the screenshot! For `m5_rtk_stakeout_dark.png`, the table IS populated (`STK-01`..`STK-04`), which looks great. Please make sure the Playwright capture script actually triggers/populates the calculation results for M4 Surface QA, M4 Utility Trace, M5 Compare Volume, and M6 Scan-to-BIM (with the 3D BIM primitives visible in the viewport) before taking the screenshots!
2. Also in M4/M5 panels, notice there is a redundant inner header right below the top panel title (e.g., top title `表面平整度` then inner header `3D 表面平整與垂直度`, top title `管溝竣工實測` then inner header `明挖管溝 3D 竣工實測`, top title `RTK 放樣導出` then inner header `RTK 工地放樣導出`), and at the bottom of the right inspector card, the parent panel (`自動化控制點 (GCP)...`) peeks out underneath. Please make sure the active inspector card cleanly occupies the panel without duplicate headers or underlying panel bleed-through.


## Follow-up — 2026-10-31T08:15:18Z

URGENT USER FEEDBACK ON SCREENSHOTS — DO NOT APPROVE VICTORY YET:
The user inspected the screenshots (m4_flatness_plumb_dark.png, m4_trench_utility_dark.png, m5_compare_delta_v_dark.png, m6_scan_to_bim_dark.png, m7_utilities_gis_dark.png) and gave this critical feedback:
"The screenshots provided by you only showed some interface panel and nothing more. No pipes, no scan to bim, no wall flatness nothing"

Root Causes & Action Plan:
1. Broken `studioThree` Global Reference + Wrong `originTwd` (`localToTwd97`) + Occlusion by Raw Mesh in M6 (`web/src/11-scan-to-bim-primitives.js`):
   - In `web/src/03-studio-core.js`, attach `window.studioThree = studioThree;` inside `initStudio3D()`.
   - In `11-scan-to-bim-primitives.js`, `originTwd` must be obtained via `localToTwd97({ x: 0, y: 0, z: 0 })` (as in `05-studio-civil-inspectors.js`), NOT `STATE.activeScan.origin_twd97`, which was defaulting to (0,0,0) and placing BIM meshes hundreds of km away!
   - When Scan-to-BIM 3D Preview is enabled, dim or toggle the raw photogrammetric mesh or render BIM solids with shaded + wireframe edges and `depthTest: true` at the exact origin so the simplified 3D BIM model (walls, trees, roads, buildings, pipes) is clearly visible in the viewport.
2. M7 Subsurface Pipes (`web/src/12-public-utilities-gis.js`) Hidden Underground & Wrong Origin:
   - Use `localToTwd97({ x: 0, y: 0, z: 0 })` (`dx = e - origin.e`, `dy = h - origin.h`, `dz = origin.n - n`).
   - Underground pipes are occluded by opaque ground mesh. Give 3D pipes, box culverts, manholes, and animated flow pulses a Subsurface X-Ray / See-Through rendering mode (`depthTest: false`, `renderOrder: 995`, glowing emissive/standard material + surface projection leader lines & floating labels, or X-ray translucent ground when Utilities tool is active) AND add a camera auto-frame / fly-to pipes button so 3D colour-coded pipes and flow pulses are 100% visible in the 3D viewport.
3. M4 Wall Plumbness / Surface Flatness Heatmap & Open-Trench Pipe (`web/src/10-construction-qa-and-stakeout.js`) Invisible in 3D:
   - Fix `window.studioThree` access.
   - Convert `(p.e, p.n, p.h)` to local coords using `localToTwd97({x:0,y:0,z:0})`.
   - In `renderSurfaceQa3DOverlay(res)`: render a vivid 3D Flatness/Plumbness Deviation Heatmap Mesh / Grid + 3D Reference Plane frame + High/Low 3D Pin Callouts + 3D Wall Plumb Normal Arrows with `depthTest: false, renderOrder: 996`.
   - In `renderUtilityTrace3DOverlay(res)`: render a true 3D cylindrical pipe (`CylinderGeometry`/`TubeGeometry`) + trench cut-out frame + vertical depth-of-cover drop-lines from ground to crown + floating station labels (`0K+000`, `0K+010`, invert/cover) with `depthTest: false, renderOrder: 996`.
   - In `renderCompareVolumeTakeoffInspector` (M5): render the 3D Cut/Fill ΔV Polygon Prism + 3D Cut (Red) / Fill (Blue) volumetric columns/heatmap in the 3D viewport.
4. Re-capture all screenshots for M3, M4 (Slab Flatness + Wall Plumbness + Open-Trench 3D Pipe), M5 (Compare ΔV 3D polygon heatmap + RTK Stakeout 3D pins), M6 (Scan-to-BIM simplified buildings, walls, trees, roads, pipes in viewport), and M7 (Utilities colour-coded 3D underground pipes, manholes, and animated flow pulses in viewport).
5. Visually inspect every single screenshot to verify the 3D objects are unmistakably visible in the 3D scene before reporting completion.
