# Dispatch: worker_track_b_m4_m5 (Milestone 4 & M5 — QA Flatness/Plumbness, Utility Tracer, Compare ΔV & RTK Stakeout)

## Mission
Implement Milestone 4 & 5 Construction QA tools:
1. 3D Surface Flatness & Plumbness Inspector: ASTM E1155 approximation, plumb tilt ratio (1:N or mm/m), deviation heatmap grid, Pass Rate %, Max High / Max Low.
2. Open-Trench Utility 3D Tracer: Invert & crown elevation, pipe diameter, gradient (% and 1:N), depth of cover from ground/design surface, DXF and CSV export.
3. Compare View ΔV Volume Takeoff: Polygon-bounded epoch-to-epoch cut/fill difference volume takeoff.
4. RTK Stakeout Export strictly in Easting, Northing, Elevation (E, N, Z) order: PtID, Easting, Northing, Elevation, Code format with printable field sheet.

## Code Boundaries (Exclusive Write Ownership)
- Backend:
  - Create dedicated mixin `pc_worker/surveying/construction_qa.py` and compose in `pc_worker/surveying_engine.py`.
  - Wire `/api/survey/surface-qa`, `/api/survey/utility-trace`, `/api/survey/stakeout-export`, and `/api/survey/compare-volume` in `pc_worker/server_api_routes.py`.
- Frontend:
  - Create dedicated module `web/src/10-construction-qa-and-stakeout.js`.
  - Register in `web/index.html` and `web/sw.js` (APP_SHELL).
  - Add styles to `web/survey-bim.css`.
- Tests:
  - Add unit/E2E tests in `tests/test_civil_surveying_e2e.py` and `tests/test_gathering_scans_suite.py`.

## Mandates & Constraints
- MANDATORY INTEGRITY WARNING: DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work.
- Strict 5,000-line ceiling: `10-construction-qa-and-stakeout.js` will start clean at ~400-800 lines.
- ZERO Unicode emojis: crisp inline SVG icons only.
- Proper Bright & Dark Theme support using CSS variables (`var(--bg-surface)`, `var(--text-main)`, etc.).
- Strict 1-word button labels (`[svg] 平整`, `[svg] 垂直`, `[svg] 追蹤`, `[svg] 放樣`, `[svg] 比對`, `[svg] 導出`).
- Coordinate ordering for RTK Stakeout MUST be strictly `PtID, Easting, Northing, Elevation, Code`.
- Project-agnostic settings: Tolerances (mm), reference planes, and pipe diameters user-selectable.
- Zero data destruction: NEVER delete or modify scan data on disk.
- Run tests, bump asset version query in `web/index.html` and `web/sw.js`, commit, and reload local server and live VPS.


## 2026-10-31T07:15:01Z
[Message] sender=35a7b3c4-959a-4d2b-a4b5-21fb2891dea3
You are worker_track_b_m4_m5. Your working directory is c:\Antigravity\GatheringScans\.agents\teamwork\worker_track_b_m4_m5\.
Read c:\Antigravity\GatheringScans\.agents\teamwork\worker_track_b_m4_m5\DISPATCH.md and c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md before starting work.
Your task is to implement Milestone 4 & M5 Construction QA tools (3D Surface Flatness/Plumbness Inspector, Open-Trench Utility 3D Tracer, Compare View ΔV Volume Takeoff, RTK Stakeout export strictly E N Z with printable field sheet).
Your exclusive file boundaries:
- Backend: Create dedicated mixin pc_worker/surveying/construction_qa.py and compose in pc_worker/surveying_engine.py. Wire in pc_worker/server_api_routes.py.
- Frontend: Create dedicated module web/src/10-construction-qa-and-stakeout.js. Register in web/index.html and web/sw.js. Add styles in web/survey-bim.css.
- Tests: tests/test_civil_surveying_e2e.py and tests/test_gathering_scans_suite.py.
MANDATORY INTEGRITY WARNING: DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work.
Keep all files strictly under 5,000 lines. Zero Unicode emojis (crisp inline SVGs only). Proper dark/light CSS variables. Strict 1-word buttons. Coordinate order strictly E, N, Z. Zero scan destruction.
Run tests, bump cache version in web/index.html and web/sw.js, commit, reload local daemon and live VPS. Write handoff.md and notify orchestrator via send_message.
