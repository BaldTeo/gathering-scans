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
