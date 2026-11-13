## 2026-10-31T08:17:38Z
You are worker_3d_viewport_overlays, working in c:\Antigravity\GatheringScans\.agents\teamwork\worker_3d_viewport_overlays\.
Your parent is 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3.

Read ORIGINAL_REQUEST.md at c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md and DISPATCH.md before starting.

CRITICAL USER DIRECTIVE:
"The screenshots provided by you only showed some interface panel and nothing more. No pipes, no scan to bim, no wall flatness nothing"
The 3D scene in the viewport was completely unchanged because 3D overlays failed to render at the camera position or were occluded.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

MANDATORY ASSIGNMENT & STEPS:
1. Expose window.studioThree:
   In `web/src/03-studio-core.js`, inside `initStudio3D()`, attach `window.studioThree = studioThree;` so other modules (`10`, `11`, `12`) can reliably access the 3D scene, camera, controls, and overlayGroup.

2. Fix TWD97 to Local Coordinate Origin across Modules `10`, `11`, `12`:
   In `web/src/10-construction-qa-and-stakeout.js`, `web/src/11-scan-to-bim-primitives.js`, and `web/src/12-public-utilities-gis.js`:
   Do NOT rely on `STATE.activeScan.origin_twd97` (which is undefined and was defaulting to {e:0, n:0, h:0}, placing meshes hundreds of km away!).
   Use the canonical transformation from `05-studio-civil-inspectors.js`:
   ```javascript
   const originTwd = (typeof localToTwd97 === 'function') ? localToTwd97({ x: 0, y: 0, z: 0 }) : { e: 0, n: 0, h: 0 };
   const lx = p.e - originTwd.e;
   const ly = p.h - originTwd.h;
   const lz = originTwd.n - p.n;
   ```

3. Milestone 6 (Scan-to-BIM) 3D Model Visibility:
   In `web/src/11-scan-to-bim-primitives.js`:
   - Render the 3D simplified solids (extruded wall prisms, cylindrical tree trunks + ellipsoidal canopies, road ribbons, building cuboids, pipe tubes) at the correct `originTwd`.
   - When Scan-to-BIM 3D preview is active, dim or ghost the raw photogrammetric mesh (`studioThree.modelPivot` traverse meshes -> set `transparent = true`, `opacity = 0.25`) and render the BIM solids with shaded materials + wireframe edges (`depthTest: true`) so the simplified 3D BIM model is unmistakably visible in the 3D viewport.
   - Position camera nicely to show the BIM solid model populated in the 3D viewport.

4. Milestone 7 (Public Utilities) Subsurface X-Ray Visibility:
   In `web/src/12-public-utilities-gis.js`:
   - Because utility pipes are underground, they are occluded by the opaque terrain mesh.
   - Implement Subsurface X-Ray / See-Through mode: set `depthTest: false`, `renderOrder: 995` with glowing emissive colors for pipes and manholes.
   - Add vertical surface projection leader lines from ground to pipe invert, and floating 3D labels.
   - Add camera auto-frame to center the pipes in the viewport.

5. Milestone 4 & 5 (Construction QA, Utility Tracer, Compare ΔV) 3D Overlays:
   In `web/src/10-construction-qa-and-stakeout.js`:
   - Surface Flatness / Plumbness: Render a vivid 3D deviation heatmap grid + reference plane frame + high/low 3D pins + plumb normal arrows (`depthTest: false, renderOrder: 996`). Support both Horizontal Slab mode AND Vertical Wall Plumbness mode! Auto-focus/frame camera on the evaluated surface!
   - Open-Trench Utility Tracer: Render a true 3D cylindrical pipe (`CylinderGeometry` / `TubeGeometry`) + trench cut-out wireframe + depth-of-cover drop-lines from ground to pipe crown + floating station tags (`0K+000`, `0K+010`). Auto-frame camera on trench!
   - Compare ΔV Takeoff: Render 3D cut (red) and fill (blue) volumetric prisms/heatmap over the compared scan region.

6. Re-capture and Visually Verify All Screenshots:
   Update/create the automated capture suite (e.g. in `tests/capture_m4_m5_m6_screenshots.py` or new script) to ensure the 3D viewport renders the vivid 3D overlays alongside the side panel, and captures high-resolution screenshots saved to `c:\Antigravity\GatheringScans\.agents\teamwork\screenshots\`:
   - `m4_flatness_plumb_dark.png` & `m4_flatness_plumb_light.png` (showing 3D slab heatmap in viewport)
   - `m4_trench_utility_dark.png` & `m4_trench_utility_light.png` (showing 3D cylindrical pipe & trench in viewport)
   - `m5_compare_delta_v_dark.png` & `m5_compare_delta_v_light.png` (showing 3D cut/fill volume prisms in viewport)
   - `m5_stakeout_dark.png` & `m5_stakeout_light.png` (showing 3D RTK stakeout pins in viewport)
   - `m6_scan_to_bim_dark.png` & `m6_scan_to_bim_light.png` (showing ghosted mesh + 3D solid BIM buildings, walls, trees in viewport)
   - `m7_utilities_gis_dark.png` & `m7_utilities_gis_light.png` (showing subsurface X-ray color-coded glowing pipes & manholes in viewport)
   Inspect all captured PNGs to ensure 3D geometric entities are clearly and unmistakably visible in the 3D viewport!

7. Strict Constraints & Deployment Rules:
   - Zero destruction: do NOT modify or delete raw scan directories in `C:\GatheringScans\` or DB records.
   - Strict 5,000-line modular file ceiling on all source files (`.py`, `.js`, `.css`, `.html`).
   - Zero Unicode emojis: monochrome SVG icons only.
   - CSS variables for both Bright and Dark theme support.
   - Strict 1-word buttons.
   - Bump asset version query string in `web/index.html` and `web/sw.js`.
   - Run unit tests (`tests/test_gathering_scans_suite.py`, `tests/test_civil_surveying_e2e.py`).
   - Commit & push to GitHub `origin/main`, reload local server (`127.0.0.1:8095`), update live Hostinger VPS container (`gathering_scans_web` on `76.13.197.29` / `https://scans.gatheren.cloud`).
   - Write comprehensive `handoff.md` in your directory and report back via send_message.
