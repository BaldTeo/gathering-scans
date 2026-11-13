# Dispatch: worker_track_c_m6 (Milestone 6 — Scan-to-BIM Simplified Geometric Model & Exporters)

## Mission
Implement Milestone 6: Scan-to-BIM Simplified Classified Geometric Model:
1. Geometric Primitive Fitting: From classified scan points and meshes (buildings, walls, roads, trees, water, pipes), fit simplified parametric solids (bounding cuboids, wall prisms, ground road strips, tree trunk cylinders + canopy ellipsoids, water planar boundaries, pipe cylinders).
2. Exporters: Pure Python standard library IFC SPF (ISO-10303-21) exporter (`.ifc` schema IFC4 or IFC2X3), 3D DXF mesh/solids exporter (`.dxf`), and Wavefront OBJ/MTL exporter (`.obj`).
3. 3D Studio Preview: Interactive Three.js preview mode in Studio to view fitted BIM solid primitives overlayed on the scan mesh.

## Code Boundaries (Exclusive Write Ownership)
- Backend:
  - Create dedicated mixin `pc_worker/surveying/scan_to_bim.py` and compose in `pc_worker/surveying_engine.py`.
  - Wire `/api/survey/scan-to-bim` endpoint in `pc_worker/server_api_routes.py`.
- Frontend:
  - Create dedicated module `web/src/11-scan-to-bim-primitives.js`.
  - Register in `web/index.html` and `web/sw.js` (APP_SHELL).
  - Add styles to `web/survey-bim.css`.
- Tests:
  - Add unit/E2E tests in `tests/test_civil_surveying_e2e.py` and `tests/test_gathering_scans_suite.py`.

## Mandates & Constraints
- MANDATORY INTEGRITY WARNING: DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work.
- Pure Python standard library for IFC SPF generation (do NOT require complex external C++ dependencies like IfcOpenShell).
- Strict 5,000-line ceiling: `11-scan-to-bim-primitives.js` will start clean at ~400-800 lines.
- ZERO Unicode emojis: crisp inline SVG icons only.
- Proper Bright & Dark Theme support using CSS variables.
- Strict 1-word button labels (`[svg] 擬合`, `[svg] 預覽`, `[svg] IFC`, `[svg] DXF`, `[svg] OBJ`).
- Project-agnostic settings: Category selection and simplification tolerance user-selectable.
- Zero data destruction: NEVER delete or modify scan data on disk.
- Run tests, bump asset version query in `web/index.html` and `web/sw.js`, commit, and reload local server and live VPS.


## 2026-10-31T07:15:08Z
[Message] timestamp=2026-10-31T07:15:08Z sender=35a7b3c4-959a-4d2b-a4b5-21fb2891dea3 priority=MESSAGE_PRIORITY_HIGH content=You are worker_track_c_m6. Your working directory is c:\Antigravity\GatheringScans\.agents\teamwork\worker_track_c_m6\.
Read c:\Antigravity\GatheringScans\.agents\teamwork\worker_track_c_m6\DISPATCH.md and c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md before starting work.
Your task is to implement Milestone 6 (Scan-to-BIM Simplified Classified Geometric Model, pure Python stdlib IFC SPF ISO-10303-21 exporter, 3D DXF exporter, OBJ/MTL exporter, and interactive Three.js BIM preview).
Your exclusive file boundaries:
- Backend: Create dedicated mixin pc_worker/surveying/scan_to_bim.py and compose in pc_worker/surveying_engine.py. Wire in pc_worker/server_api_routes.py.
- Frontend: Create dedicated module web/src/11-scan-to-bim-primitives.js. Register in web/index.html and web/sw.js. Add styles in web/survey-bim.css.
- Tests: tests/test_civil_surveying_e2e.py and tests/test_gathering_scans_suite.py.
MANDATORY INTEGRITY WARNING: DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work.
Keep all files strictly under 5,000 lines. Zero Unicode emojis (crisp inline SVGs only). Proper dark/light CSS variables. Strict 1-word buttons. Zero scan destruction.
Run tests, bump cache version in web/index.html and web/sw.js, commit, reload local daemon and live VPS. Write handoff.md and notify orchestrator via send_message.
