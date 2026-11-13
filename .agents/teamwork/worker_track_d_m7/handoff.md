# Milestone 7 Handoff Report — Real Public Utilities GIS Integration with Taiwan Open APIs

## 1. Observation
- **Code Modifications**:
  - `pc_worker/surveying/public_utilities_gis.py` (1,094 lines): Pure Python implementation of `PublicUtilitiesGISMixin`, `UTILITY_LAYERS` (10 official categories: Storm, Sanitary, Water, Power, Telecom, Gas, Common Duct, Street Light, Road Excavation, As-Built Survey), MOI NGIS GML 3.1.1 XML parser, GeoJSON/KML/CSV parsers, and 3D DXF exporter with `AC1015` POLYLINE/3DFACE geometry.
  - `pc_worker/surveying_engine.py`: Composed `PublicUtilitiesGISMixin` into `SurveyingEngine`.
  - `pc_worker/surveying/__init__.py`: Exported `PublicUtilitiesGISMixin` and `UTILITY_LAYERS`.
  - `pc_worker/server_api_routes.py`: Registered endpoints `/api/survey/utilities-query`, `/api/survey/utilities-parse`, and `/api/survey/utilities-export`.
  - `web/src/12-public-utilities-gis.js` (891 lines): Interactive 3D subsurface renderer with Three.js (cylindrical pipes, box culverts, vertical cylindrical manholes), 10 color-coded layer toggles with individual counts, animated hydraulic flow direction loop (`requestAnimationFrame` pulse), 3D raycasting picker for attribute cards, import/export controls.
  - `web/survey-bim.css`: Added responsive styles (lines 843–1257) for `#studioSidePanel` utilities inspector supporting both bright and dark themes using CSS variables (`var(--ui-bg-surface)`, `var(--ui-border)`, `var(--ui-text)`).
  - `web/index.html`: Added `#btnDockUtilities` (`[svg] 管線`) to Studio dock and bumped asset version query string to `v20261031_v223`.
  - `web/sw.js`: Updated offline cache name to `gathering-scans-offline-v223` and registered `/src/12-public-utilities-gis.js` in `APP_SHELL`.
  - `tests/test_civil_surveying_e2e.py`: Added `TestPublicUtilitiesGISIntegration` with 7 test cases covering live querying, MOI GML 3.1.1 parsing, GeoJSON parsing, layer toggles, DXF export, and flow direction calculation.
  - `tests/test_gathering_scans_suite.py`: Added `test_38_milestone7_public_utilities_gis_and_gml_integration`.
  - `tests/capture_m7_screenshots.py`: Automated headless Chrome CDP visual verification runner capturing high-resolution dual-theme screenshots.
- **Test Executions**:
  - `python -m unittest tests/test_civil_surveying_e2e.py`: 57 tests passed in 4.256s.
  - `python -m unittest tests/test_gathering_scans_suite.py`: 39 tests passed in 11.562s (including `test_07_modular_architecture_strict_5000_line_ceiling`).
  - Strict line ceiling verification:
    - `pc_worker/surveying/public_utilities_gis.py`: 1,094 lines (<5,000)
    - `web/src/12-public-utilities-gis.js`: 891 lines (<5,000)
    - `tests/test_civil_surveying_e2e.py`: 1,770 lines (<5,000)
    - `tests/test_gathering_scans_suite.py`: 3,288 lines (<5,000)
- **Zero Mock / Fake Data**:
  - Genuine Taiwan Open GIS query on `rosepark_20260918_merged` (E: 295966.7, N: 2768539.4, radius: 120m) returned 69 real public utilities features (11 storm sewer culverts/lines, 58 sanitary sewer pipes/manholes, total pipe length 2,208.73m).
  - Ocean coordinates (E: 0, N: 0) return 0 features honestly without fabrication.
- **Visual Artifacts**:
  - `c:\Antigravity\GatheringScans\.agents\teamwork\screenshots\m7_utilities_gis_dark.png` (2,407,670 bytes)
  - `c:\Antigravity\GatheringScans\.agents\teamwork\screenshots\m7_utilities_gis_light.png` (2,427,988 bytes)
- **Deployment Status**:
  - Git commits `d0e1777` and `4e9c603` pushed to `origin/main`.
  - Local server `http://127.0.0.1:8095/api/status` returned `200 OK`.
  - Production VPS `https://scans.gatheren.cloud/api/status` restarted and returned `200 OK`.

## 2. Logic Chain
1. *Constraint Fulfillment*: The user requested Milestone 7 with genuine Taiwan Open GIS endpoints (`wrd.ntpc.gov.tw`, `sewer.ntpc.gov.tw`), 10 color-coded layer toggles with individual counts, animated 3D hydraulic flow direction, MOI NGIS GML 3.1.1 parsing, and strictly 0 mocked data.
2. *Architectural Separation*: Placing all backend GIS logic into `pc_worker/surveying/public_utilities_gis.py` keeps `surveying_engine.py` modular and ensures every file remains strictly below the 5,000-line ceiling enforced by `test_07_modular_architecture_strict_5000_line_ceiling`.
3. *Real Endpoint Resilience*: Taiwan municipal GIS servers occasionally throttle or experience latency; implementing spatial bounding box queries (`geometryType=esriGeometryEnvelope`), multi-endpoint fallbacks, local caching (`data/utilities_cache/`), and timeouts ensures fast response times while preserving 100% genuine data fidelity.
4. *Visual Verification*: Running automated Chrome CDP headless scripts rendered the 3D subsurface pipes and culverts under the real photogrammetric mesh at Rose Park in both Dark and Light themes. The side panel cleanly presents 10 layer toggles, counts, 1-word buttons, inline SVGs, and zero emojis.
5. *Multi-Server Deployment*: Following Rule 2, pushing to `origin/main` and reloading both the local Windows daemon and the live Hostinger VPS container ensures full parity between development and production.

## 3. Caveats
- Some Taiwan Open Data ArcGIS REST endpoints restrict external queries by IP or rate limiting. When outside Taiwan or during government maintenance windows, the engine uses local cached spatial responses (`data/utilities_cache/`) for known scans, or user-uploaded GML/GeoJSON files.
- Flow direction animation runs client-side via `requestAnimationFrame` pulse along the pipe vector based on upstream/downstream invert elevations (`UIE`, `DIE`). If elevation data is missing from a government record, flow direction defaults to horizontal vector along line digitization direction.

## 4. Conclusion
Milestone 7 (Real Public Utilities GIS Integration with Taiwan Open APIs, 10 layer toggles with color coding, animated 3D flow direction, MOI NGIS GML 3.1.1 parser, and 3D DXF exporter) is fully implemented, verified with 96 passing unit and E2E tests, verified visually with dual-theme high-resolution screenshots, committed, pushed to GitHub, and live on both local server and production VPS.

## 5. Verification Method
- **Unit and E2E Tests**:
  ```powershell
  python -m unittest tests/test_civil_surveying_e2e.py
  python -m unittest tests/test_gathering_scans_suite.py
  ```
- **Real GIS API Query Test**:
  ```powershell
  python -c "import urllib.request, json; data = json.dumps({'scan_id': 'rosepark_20260918_merged', 'radius_m': 120}).encode('utf-8'); req = urllib.request.Request('http://127.0.0.1:8095/api/survey/utilities-query', data=data, headers={'Content-Type': 'application/json'}); res = urllib.request.urlopen(req); d = json.loads(res.read().decode('utf-8')); print('Status:', res.status, 'Total features:', len(d.get('features', [])))"
  ```
- **Live Production Check**:
  ```powershell
  curl -I https://scans.gatheren.cloud/api/status
  ```
- **Visual Artifacts Inspection**:
  - `c:\Antigravity\GatheringScans\.agents\teamwork\screenshots\m7_utilities_gis_dark.png`
  - `c:\Antigravity\GatheringScans\.agents\teamwork\screenshots\m7_utilities_gis_light.png`
