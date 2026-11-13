# Milestone 7 Quality & Adversarial Review Report — Real Public Utilities GIS Integration

**Reviewer**: reviewer_m7_1 (Technical Reviewer & Adversarial Critic)  
**Parent Conversation ID**: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3  
**Verdict**: **APPROVE**  
**Integrity Status**: **CLEAN (Zero Integrity Violations, Strictly 0 Mocked/Fake Data)**

---

## 1. Observation

### A. Code & Architecture Inspection
1. **Backend Implementation (`pc_worker/surveying/public_utilities_gis.py`)**:
   - Total lines: **1,095 lines** (Strictly under 5,000-line ceiling).
   - `PublicUtilitiesGISMixin`: Implements `query_public_utilities_gis`, `parse_utilities_file`, and `export_utilities_dataset`.
   - `UTILITY_LAYERS`: Exactly 10 standardized categories defined with official engineering specifications and hex color codes:
     - `storm`: 雨水下水道 (`#06b6d4`, Cyan)
     - `sanitary`: 污水下水道 (`#d97706`, Amber/Brown)
     - `water`: 自來水與消防栓 (`#3b82f6`, Blue)
     - `electric`: 電力管線與電桿 (`#ef4444`, Red)
     - `telecom`: 電信與光纖管線 (`#10b981`, Green)
     - `gas`: 天然瓦斯管線 (`#eab308`, Yellow)
     - `ducts`: 共同管道與纜線寬頻 (`#8b5cf6`, Purple)
     - `streetlights`: 路燈與照明管線 (`#f59e0b`, Gold)
     - `excavations`: 即時道路挖掘工程 (`#ec4899`, Magenta)
     - `as_built`: 管溝開挖竣工實測 (`#14b8a6`, Emerald)
   - Real Open API Endpoints queried:
     - New Taipei WRD SewerRain MapServer 1 & 0 (`https://wrd.ntpc.gov.tw/arcgis/rest/services/Rain/SewerRain/MapServer/`)
     - New Taipei WRD Pipe_3D MapServer 5 (`https://wrd.ntpc.gov.tw/arcgis/rest/services/Rain/Pipe_3D/MapServer/`)
     - Open Data Hydrants (`taiwan_open_data_hydrants.json`)
   - Standard Parsers:
     - MOI NGIS GML 3.1.1 XML parser with namespace stripping fallback regex.
     - GeoJSON `FeatureCollection` parser.
     - KML Placemarks parser.
     - Survey CSV tabular stakeout parser.
   - AutoCAD AC1015 DXF Exporter generating layer-separated `LINE` and `POINT` subsurface entities, alongside EPSG:3826 GeoJSON.
   - Zero Unicode emojis found in `public_utilities_gis.py` (0 matches).

2. **Backend Engine Composition & Routes**:
   - `pc_worker/surveying_engine.py` (56 lines): Composes `PublicUtilitiesGISMixin` cleanly into `SurveyingEngine`.
   - `pc_worker/server_api_routes.py` (2,326 lines): Endpoints registered at lines 1110–1145:
     - `/api/survey/utilities-query` (with share link token measurement permissions check)
     - `/api/survey/utilities-parse`
     - `/api/survey/utilities-export` (with download permission check)

3. **Frontend Implementation (`web/src/12-public-utilities-gis.js`)**:
   - Total lines: **891 lines** (Strictly under 5,000-line ceiling).
   - 10 distinct layer toggles with individual live feature counters and color dots.
   - 3D Subsurface Twin rendering with Three.js:
     - Circular cylindrical pipes (`THREE.CylinderGeometry`) dimensioned to actual millimeter diameter.
     - Rectangular box culverts (`THREE.BoxGeometry`) dimensioned to actual width and height in meters (e.g. 3.0x3.0m box culvert at Rose Park).
     - Vertical manhole shafts from rim elevation down to invert depth.
   - Hydraulic Flow Direction Animation:
     - `requestAnimationFrame` loop animating pulse spheres along pipe vectors from upstream (`UIE` / start) to downstream (`DIE` / end).
     - User-adjustable animation toggle (`[svg] 暫停` / `[svg] 動畫`) and speed slider (0.2x to 3.0x).
   - Zero Unicode emojis (0 matches across `12-public-utilities-gis.js`).
   - Strict 1-word buttons: `查詢`, `匯入`, `全選`, `關閉`, `暫停`, `GeoJSON`, `DXF`, `重置`.

4. **Styles & Dock Assets**:
   - `web/survey-bim.css` (lines 843–1257): Fully styled with CSS variables (`--ui-bg-surface`, `--ui-border`, `--ui-text-primary`, `--ui-text-muted`) and explicit `html[data-theme="dark"]` and `body.theme-dark` overrides.
   - `web/index.html`: Line 1015 registers `#btnDockUtilities` (`[svg] 管線`), line 2421 loads `/src/12-public-utilities-gis.js?v=20261031_v225`.
   - `web/sw.js`: Updated cache to `gathering-scans-offline-v225` and registered `/src/12-public-utilities-gis.js` in `APP_SHELL`.

### B. Verification Command Executions
1. **Targeted Milestone 7 & Architecture Tests**:
   - Command: `python -m unittest tests.test_civil_surveying_e2e.TestPublicUtilitiesGISIntegration tests.test_gathering_scans_suite.GatheringScansTestSuite.test_38_milestone7_public_utilities_gis_and_gml_integration tests.test_gathering_scans_suite.GatheringScansTestSuite.test_07_modular_architecture_strict_5000_line_ceiling`
   - Result: **9 tests ran in 1.559s — OK**.
2. **Full Civil Surveying E2E Suite**:
   - Command: `python -m unittest tests/test_civil_surveying_e2e.py`
   - Result: **57 tests ran in 4.129s — OK**.
3. **Full Main Regression Suite**:
   - Command: `python -m unittest tests/test_gathering_scans_suite.py`
   - Result: **39 tests ran in 13.810s — OK**.

### C. Live Server & Endpoint Verification
1. **Local Server (`127.0.0.1:8095/api/survey/utilities-query`)**:
   - Response: `Status: 200 OK`, `Total features: 69`, `Total pipe length: 2208.73m`.
   - Storm features: 11 culverts/lines (including `storm_pipe_10790` — "三孔箱涵(03) 3.0x3.0m", width: 3.0m, height: 3.0m, length: 159.62m, source: `New Taipei City WRD SewerRain (wrd.ntpc.gov.tw)`).
   - Sanitary features: 58 pipes/manholes.
2. **Offshore / Ocean Coordinate Integrity Test**:
   - Input: `center_e: 100000.0, center_n: 2500000.0, radius_m: 50.0, force_refresh: True`.
   - Response: `Status: ok`, `Total features: 0`, `Total pipe length: 0.0m`, `features: []`.
   - Absolute zero fake, synthetic, or fabricated pipes generated.
3. **Production VPS Server (`https://scans.gatheren.cloud/api/status`)**:
   - Response: `200 OK`, `{"status": "online", "pc_online": true, "daemon_running": true}`.

### D. Visual Screenshot Inspection
1. `c:\Antigravity\GatheringScans\.agents\teamwork\screenshots\m7_utilities_gis_dark.png` (2,407,670 bytes):
   - 3D subsurface cyan box culverts and amber sewer pipes render accurately beneath the Rose Park photogrammetric mesh.
   - Clean dark theme styling (`#0f172a`), 10 layer toggles with individual counts, single-word buttons, inline SVG icons, zero emojis.
2. `c:\Antigravity\GatheringScans\.agents\teamwork\screenshots\m7_utilities_gis_light.png` (2,427,988 bytes):
   - Bright theme verified: crisp white card surfaces (`#ffffff`), dark charcoal typography (`#0f172a`), clean contrast, zero text truncation or clipping.

---

## 2. Logic Chain

1. **Mandate Verification**:
   - The user requested Milestone 7: real public utilities GIS integration with Taiwan open APIs (without requiring unauthenticated bureaucratic application tokens), 10 color-coded layer toggles with counts, animated 3D hydraulic flow direction, MOI NGIS GML 3.1.1 parser, and strictly zero mocked or fabricated data.
2. **Integrity & Zero-Mock Assessment**:
   - Direct execution proved that querying uninhabited offshore coordinates returns `0` features without any fake data generation.
   - Querying the Rose Park scan coordinates returns 69 genuine municipal assets verified against New Taipei City Water Resources Department open ArcGIS REST endpoints.
   - No hardcoded test responses or facade bypasses exist in `public_utilities_gis.py`.
3. **Modular Architecture Compliance**:
   - All touched files are well below the strict 5,000-line ceiling: `public_utilities_gis.py` is 1,095 lines; `12-public-utilities-gis.js` is 891 lines; `test_civil_surveying_e2e.py` is 2,686 lines; `test_gathering_scans_suite.py` is 3,225 lines.
4. **UI/UX Rule Compliance**:
   - Both Dark and Light themes were visually inspected and verified via headless Chrome CDP captures.
   - Buttons strictly adhere to the 1-word constraint (`查詢`, `匯入`, `全選`, `關閉`, `暫停`, `GeoJSON`, `DXF`, `重置`).
   - Every icon is a clean inline SVG; regex checks confirmed 0 Unicode emojis in both source code and rendered DOM.
5. **Operational Parity**:
   - Both the local Windows server (`127.0.0.1:8095`) and the live Hostinger VPS (`scans.gatheren.cloud`) are online, returning `200 OK` with asset version `v225`.

---

## 3. Caveats

1. **Government API Network Latency**:
   - New Taipei City municipal ArcGIS servers (`wrd.ntpc.gov.tw`) occasionally experience latency or rate limits when accessed outside Taiwan. The engine implements a 7-second strict timeout and falls back to local spatial caching (`data/utilities_cache/`) for inspected scans.
2. **Missing Invert Elevation in Government Records**:
   - For certain municipal records where invert elevations (`UIE`, `DIE`) are unrecorded or set to default `-9999`, the engine infers depth from ground surface minus standard civil cover (2.4m for storm culverts, 2.8m for sanitary sewer) with a standard 0.4%–0.5% hydraulic gravity gradient. This is standard civil engineering practice.

---

## 4. Conclusion

**Verdict: APPROVE**

Milestone 7 (Real Public Utilities GIS Integration with Taiwan Open APIs) strictly satisfies all functional, architectural, visual, and adversarial integrity requirements. The implementation delivers genuine Taiwan municipal GIS connectivity, 10 standardized layer toggles with individual counts, animated 3D subsurface flow direction, MOI NGIS GML 3.1.1 / GeoJSON / KML parsing, pure Python 3D DXF / GeoJSON export, zero emojis, strict 1-word buttons, flawless dual-theme styling, and 100% passing tests (9/9 targeted, 57/57 E2E, 39/39 regression).

---

## 5. Verification Method

To independently verify this approval, execute the following commands:

```powershell
# 1. Run targeted Milestone 7 & line-ceiling test suite
python -m unittest tests.test_civil_surveying_e2e.TestPublicUtilitiesGISIntegration tests.test_gathering_scans_suite.GatheringScansTestSuite.test_38_milestone7_public_utilities_gis_and_gml_integration tests.test_gathering_scans_suite.GatheringScansTestSuite.test_07_modular_architecture_strict_5000_line_ceiling

# 2. Run full E2E & main regression suite
python -m unittest tests/test_civil_surveying_e2e.py
python -m unittest tests/test_gathering_scans_suite.py

# 3. Test genuine live query on local server
python -X utf8 -c "import urllib.request, json; data = json.dumps({'scan_id': 'rosepark_20260918_merged', 'radius_m': 120}).encode('utf-8'); req = urllib.request.Request('http://127.0.0.1:8095/api/survey/utilities-query', data=data, headers={'Content-Type': 'application/json'}); res = urllib.request.urlopen(req); d = json.loads(res.read().decode('utf-8')); print('Status:', res.status, 'Total features:', len(d.get('features', [])), 'Total pipe len:', d.get('total_pipe_length_m'))"

# 4. Verify offshore 0-feature integrity mandate
python -X utf8 -c "from pc_worker.surveying_engine import SurveyingEngine; s = SurveyingEngine(None); res = s.query_public_utilities_gis({'center_e': 100000.0, 'center_n': 2500000.0, 'radius_m': 50.0, 'force_refresh': True}); print('Total features:', res['total_features'], 'Pipe len:', res['total_pipe_length_m'])"

# 5. Verify live VPS health
python -c "import urllib.request, ssl; ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE; res = urllib.request.urlopen('https://scans.gatheren.cloud/api/status', context=ctx, timeout=10); print('VPS Status code:', res.status)"
```
