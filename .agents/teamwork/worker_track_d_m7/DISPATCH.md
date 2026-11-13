# Dispatch: worker_track_d_m7 (Milestone 7 — Real Public Utilities GIS Integration)

## Mission
Implement Milestone 7: Real Public Utilities GIS Integration with Taiwan Open APIs:
1. Live Unauthenticated APIs:
   - New Taipei City Sanitary Sewer (`sewer.ntpc.gov.tw` ArcGIS REST)
   - New Taipei City Stormwater Drainage (`wrd.ntpc.gov.tw` ArcGIS REST)
   - Taipei 3D GIS Subsurface Pipeline Service (`3dgis.reac.taipei` / `dig.taipei`)
   - MOI NGIS GML 3.1.1 / GeoJSON / KML parser for uploaded pipe networks
   - STRICTLY ZERO MOCKED OR FAKE DATA: Real coordinates, pipe dimensions, flow direction, and invert elevations.
2. 10 Utility Layer Toggles & Color Coding:
   - Storm (`#06b6d4`), Sanitary (`#d97706`), Water (`#3b82f6`), Electric (`#ef4444`), Telecom (`#10b981`), Gas (`#eab308`), Ducts (`#8b5cf6`), Streetlights (`#f59e0b`), Excavations (`#ec4899`), As-Built (`#14b8a6`).
   - Feature count badge and visibility checkbox for each layer.
3. 3D Subsurface Pipe Visualization & Flow Direction Animation:
   - 3D Three.js pipe cylinders rendered at true invert elevation below ground surface.
   - Animated directional flow indicator in `requestAnimationFrame` loop (moving texture or directional chevrons).
4. Non-Intrusive UI:
   - Dedicated "Utilities" (`管線`) tool button in Studio dock with SVG icon and 1-word label.
   - Side panel with query radius / bounding box search around active scan coordinates.

## Code Boundaries (Exclusive Write Ownership)
- Backend:
  - Create dedicated mixin `pc_worker/surveying/public_utilities_gis.py` and compose in `pc_worker/surveying_engine.py`.
  - Wire `/api/survey/utilities-query` and `/api/survey/utilities-parse` in `pc_worker/server_api_routes.py`.
- Frontend:
  - Create dedicated module `web/src/12-public-utilities-gis.js`.
  - Register in `web/index.html` and `web/sw.js` (APP_SHELL).
  - Add styles to `web/survey-bim.css`.
- Tests:
  - Add unit/E2E tests in `tests/test_civil_surveying_e2e.py` and `tests/test_gathering_scans_suite.py`.

## Mandates & Constraints
- MANDATORY INTEGRITY WARNING: DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work.
- Strictly ZERO fake data: must fetch real GIS data from Taiwan open data endpoints or parse real user-supplied GML/GeoJSON files.
- Strict 5,000-line ceiling: `12-public-utilities-gis.js` will start clean at ~400-800 lines.
- ZERO Unicode emojis: crisp inline SVG icons only.
- Proper Bright & Dark Theme support using CSS variables.
- Strict 1-word button labels (`[svg] 查詢`, `[svg] 匯入`, `[svg] 動畫`, `[svg] 圖層`, `[svg] 導出`).
- Project-agnostic settings: Query radius, buffer distance, and active layers user-configurable.
- Zero data destruction: NEVER delete or modify scan data on disk.
- Run tests, bump asset version query in `web/index.html` and `web/sw.js`, commit, and reload local server and live VPS.


## 2026-10-31T07:15:15Z
[Message] timestamp=2026-10-31T07:15:15Z sender=35a7b3c4-959a-4d2b-a4b5-21fb2891dea3 priority=MESSAGE_PRIORITY_HIGH content=You are worker_track_d_m7. Your working directory is c:\Antigravity\GatheringScans\.agents\teamwork\worker_track_d_m7\.
Read c:\Antigravity\GatheringScans\.agents\teamwork\worker_track_d_m7\DISPATCH.md and c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md before starting work.
Your task is to implement Milestone 7 (Real Public Utilities GIS Integration with Taiwan Open APIs, 10 layer toggles with color coding, animated 3D flow direction, MOI NGIS GML 3.1.1 parser, strictly 0 fake/mocked data).
Your exclusive file boundaries:
- Backend: Create dedicated mixin pc_worker/surveying/public_utilities_gis.py and compose in pc_worker/surveying_engine.py. Wire in pc_worker/server_api_routes.py.
- Frontend: Create dedicated module web/src/12-public-utilities-gis.js. Register in web/index.html and web/sw.js. Add styles in web/survey-bim.css.
- Tests: tests/test_civil_surveying_e2e.py and tests/test_gathering_scans_suite.py.
MANDATORY INTEGRITY WARNING: DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work.
Keep all files strictly under 5,000 lines. Zero Unicode emojis (crisp inline SVGs only). Proper dark/light CSS variables. Strict 1-word buttons. Strictly 0 fake data. Zero scan destruction.
Run tests, bump cache version in web/index.html and web/sw.js, commit, reload local daemon and live VPS. Write handoff.md and notify orchestrator via send_message.
