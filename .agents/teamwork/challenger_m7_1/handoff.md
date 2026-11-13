# Milestone 7 Verification & Adversarial Challenge Report
**Author**: `challenger_m7_1` (Empirical Verification Challenger & Adversarial Critic)  
**Parent Conv ID**: `35a7b3c4-959a-4d2b-a4b5-21fb2891dea3`  
**Verdict**: **REQUEST_CHANGES**

---

## 1. Observation

### A. Code & File Inspections
- `pc_worker/surveying/public_utilities_gis.py` (1,095 lines): Modular mixin implementing live municipal GIS querying, MOI NGIS GML 3.1.1 parser, GeoJSON/KML/CSV parsers, and DXF exporter.
- `web/src/12-public-utilities-gis.js` (891 lines): Interactive 3D subsurface renderer with Three.js, 10 layer toggles with individual counts, animated hydraulic flow direction loop, raycasting picker, and export controls.
- `web/survey-bim.css` (1,258 lines): Responsive styling for `.gs-util-*` side panel components with CSS custom variables supporting Dark and Bright themes.
- Line ceiling compliance: Every source file is strictly below the 5,000-line modular ceiling (`test_07_modular_architecture_strict_5000_line_ceiling` passed).
- UI/UX compliance: Verified 0 Unicode emojis, strictly 1-word action buttons, and dual-theme visual screenshots (`m7_utilities_gis_dark.png` [2,407,670 bytes] and `m7_utilities_gis_light.png` [2,427,988 bytes]).
- Standard unit tests: `python -m unittest tests.test_civil_surveying_e2e.TestPublicUtilitiesGISIntegration` passed (7/7 in 0.983s).

### B. Empirical Adversarial Stress Testing Results
Executing our dedicated adversarial stress harness `tests/test_adversarial_m7_challenger.py` against the running server (`http://127.0.0.1:8095`) revealed 4 verified bugs:

1. **Critical Bug 1 — Unsanitized Null Sentinel Value in Hydraulic Slope Calculation (`-9999.0%`)**:
   - Location: `pc_worker/surveying/public_utilities_gis.py:381-383`
   ```python
   slope_calc = round(((z1 - z2) / max(0.1, length_m)) * 100.0, 3)
   slope = safe_float(attrs.get("P_SLOPE"), slope_calc) or slope_calc
   ```
   - Observation: When querying the New Taipei City WRD SewerRain MapServer API (`wrd.ntpc.gov.tw`), pipes without a measured field slope carry `P_SLOPE: -9999` (standard municipal GIS null sentinel). Because `safe_float(-9999)` returns `-9999.0` (which is truthy), the endpoint blindly outputs `slope_pct: -9999.0%` to the frontend and 3D DXF.
   - Empirical Result: `test_01_rosepark_live_endpoint_returns_genuine_features` failed with:
     `AssertionError: False is not true : Pipe slope -9999.0% outside civil range`.

2. **Critical Bug 2 — Cache Bypass of Layer Filtering**:
   - Location: `pc_worker/surveying/public_utilities_gis.py:250-258`
   ```python
   if not force_refresh and os.path.exists(cache_file):
       with open(cache_file, "r", encoding="utf-8") as f:
           cached_data = json.load(f)
           if cached_data and isinstance(cached_data.get("features"), list):
               cached_data["cached"] = True
               return cached_data
   ```
   - Observation: When a query with a subset of layers (e.g. `layers: ["storm"]`) is issued, and a cache file exists (generated during an initial multi-layer query), the method returns `cached_data` directly without filtering by `requested_layers`.
   - Empirical Result: Querying `layers: ["storm"]` returned all 58 sanitary sewer features and all layer counts. `test_02_rosepark_layer_filtering_consistency` failed with:
     `AssertionError: 'sanitary' != 'storm' : Layer filtering failed: found sanitary`.

3. **High Bug 3 — HTTP 500 Unhandled Exception on 2D Coordinates in DXF Export**:
   - Location: `pc_worker/surveying/public_utilities_gis.py:1079, 1087`
   ```python
   "30", f"{p1[2]:.3f}", ...
   "30", f"{pt[2]:.3f}", ...
   ```
   - Observation: In `export_utilities_dataset`, line 1079 accesses `p1[2]` and line 1087 accesses `pt[2]`. When features contain standard 2D coordinates `[x, y]` (common from 2D shapefiles, 2D GeoJSON, or 2D CAD imports), Python raises `IndexError: list index out of range`, crashing with HTTP 500.
   - Empirical Reproduction:
     ```powershell
     python -c "import urllib.request, json; data = json.dumps({'scan_id': 'test', 'format': 'dxf', 'features': [{'id': 'p1', 'layer': 'storm', 'type': 'pipe', 'coords': [[10.0, 20.0], [30.0, 40.0]]}]}).encode('utf-8'); req = urllib.request.Request('http://127.0.0.1:8095/api/survey/utilities-export', data=data, headers={'Content-Type': 'application/json'}); urllib.request.urlopen(req)"
     ```
     Result: `urllib.error.HTTPError: HTTP Error 500: {"error": "list index out of range"}`.

4. **Medium Bug 4 — HTTP 500 Unhandled Exception on Non-String File Content**:
   - Location: `pc_worker/surveying/public_utilities_gis.py:610, 614`
   ```python
   file_content = payload.get("file_content") or ""
   ...
   if not file_content.strip():
   ```
   - Observation: If `payload["file_content"]` is non-string (e.g. `int`, `list`, `bool`, or dictionary from programmatic API clients), `file_content.strip()` raises `AttributeError: ... object has no attribute 'strip'` and crashes with HTTP 500 instead of returning a clean error payload.
   - Empirical Reproduction:
     ```powershell
     python -c "import urllib.request, json; data = json.dumps({'file_content': 12345, 'filename': 'test.gml'}).encode('utf-8'); req = urllib.request.Request('http://127.0.0.1:8095/api/survey/utilities-parse', data=data, headers={'Content-Type': 'application/json'}); urllib.request.urlopen(req)"
     ```
     Result: `urllib.error.HTTPError: HTTP Error 500: {"error": "'int' object has no attribute 'strip'"}`.

### C. Positive Verifications (Anti-Mock & Coverage Integrity)
- **Genuine Data Fidelity**: Querying Rose Park (`rosepark_20260918_merged`, radius: 120m) returns 69 authentic features (11 storm sewer culverts/lines, 58 sanitary sewer pipes/manholes, total pipe length 2,208.73m). Real geometries in TWD97 (EPSG:3826) with accurate Eastings (~295900–296100) and Northings (~2768400–2768650).
- **Anti-Mock Mandate**:
  - Offshore/Ocean coordinates (E: 0, N: 0) return 0 features honestly without fabrication (`total_features: 0`, `total_pipe_length_m: 0.0`).
  - Offshore Taiwan Strait (E: 120000, N: 2500000) returns 0 features honestly.
  - Deep Pacific trench (E: 450000, N: 2650000) returns 0 features honestly.
  - Non-covered scans (`ntudorm_20260915_baseline`, `QuChi261016_Trees`, `edited_qihu_unified_merged_scan_4_scans__edited_372953`) return 0 features honestly without injecting fake pipelines.
- **Parsing Fuzzing**: Malformed GML (unclosed tags, missing posList, invalid floats, XXE), KML, GeoJSON (corrupted syntax, missing geometry, null geometry), and CSV (empty rows, truncated columns) return structured JSON errors without crashing.

---

## 2. Logic Chain
1. *Constraint Requirement*: In civil engineering surveying, pipe slope % is a critical hydraulic design parameter (typically 0.1% to 15.0%). Leaking a municipal GIS null sentinel `-9999` as `-9999.0%` corrupts the engineering model and misleads field contractors.
2. *Contract Integrity*: The API accepts `layers: [...]` to allow clients and UI inspectors to selectively isolate layers (e.g. only storm sewers). Returning unrequested cached layers breaks isolation and wastes rendering bandwidth.
3. *Robustness & Anti-Crash Discipline*: Endpoints must never crash with unhandled 500 exceptions on 2D coordinates or unexpected JSON types. In GIS, 2D coordinates are common and must default Z to 0.0 elevation gracefully.
4. *Scope Assessment*: While the visual interface, 3D subsurface renderer, layer toggles, and genuine API ingestion are implemented to a high standard, the 4 identified bugs in `public_utilities_gis.py` must be resolved before Milestone 7 can be approved.

---

## 3. Caveats
- No code in `pc_worker/` or `web/` was modified by this challenger (strict adherence to Review-Only constraint).
- The live external endpoints (`wrd.ntpc.gov.tw` and `sewer.ntpc.gov.tw`) were tested directly; government network latency can occasionally take up to 2–5 seconds, which the local caching layer mitigates effectively.

---

## 4. Conclusion
**Verdict: REQUEST_CHANGES**

Worker Track D (`worker_track_d_m7`) must address the following 4 remediation items in `pc_worker/surveying/public_utilities_gis.py`:
1. **Sanitize `P_SLOPE`**:
   Filter out null sentinels: if `raw_slope is not None and -100.0 < raw_slope < 100.0: slope = raw_slope else: slope = slope_calc`.
2. **Apply Layer Filter on Cache Hit**:
   When returning from `cache_file`, filter `cached_data["features"]` and `cached_data["layer_counts"]` by `requested_layers`.
3. **Safe 3D Coordinate Extraction in DXF Export**:
   In `export_utilities_dataset`, safely handle 2D coordinates: `z1 = p1[2] if len(p1) > 2 else 0.0`, `z2 = p2[2] if len(p2) > 2 else 0.0`, and `z_pt = pt[2] if len(pt) > 2 else 0.0`.
4. **Coerce `file_content` to String**:
   In `parse_utilities_file`, use `file_content = str(payload.get("file_content") or "")` to prevent `AttributeError` crashes on non-string inputs.

---

## 5. Verification Method

To verify the fixes independently:

1. **Run the Adversarial Stress Suite**:
   ```powershell
   python -m unittest tests.test_adversarial_m7_challenger
   ```
   *Expected Result*: All 14 tests pass with 0 failures and 0 errors.

2. **Verify 2D DXF Export (Anti-Crash)**:
   ```powershell
   python -c "import urllib.request, json; data = json.dumps({'scan_id': 'test', 'format': 'dxf', 'features': [{'id': 'p1', 'layer': 'storm', 'type': 'pipe', 'coords': [[10.0, 20.0], [30.0, 40.0]]}]}).encode('utf-8'); req = urllib.request.Request('http://127.0.0.1:8095/api/survey/utilities-export', data=data, headers={'Content-Type': 'application/json'}); res = urllib.request.urlopen(req); print('Status:', res.status)"
   ```
   *Expected Result*: `Status: 200`.

3. **Verify Slope Sanitization at Rose Park**:
   ```powershell
   python -c "import urllib.request, json; data = json.dumps({'scan_id': 'rosepark_20260918_merged', 'radius_m': 120}).encode('utf-8'); req = urllib.request.Request('http://127.0.0.1:8095/api/survey/utilities-query', data=data, headers={'Content-Type': 'application/json'}); res = urllib.request.urlopen(req); d = json.loads(res.read().decode('utf-8')); slopes = [f.get('slope_pct') for f in d.get('features', []) if 'slope_pct' in f]; print('Min slope:', min(slopes), 'Max slope:', max(slopes))"
   ```
   *Expected Result*: All slopes are between -25.0% and +25.0% (no `-9999.0%`).

4. **Verify Layer Filtering Consistency**:
   ```powershell
   python -c "import urllib.request, json; data = json.dumps({'scan_id': 'rosepark_20260918_merged', 'radius_m': 120, 'layers': ['storm']}).encode('utf-8'); req = urllib.request.Request('http://127.0.0.1:8095/api/survey/utilities-query', data=data, headers={'Content-Type': 'application/json'}); res = urllib.request.urlopen(req); d = json.loads(res.read().decode('utf-8')); layers = set(f.get('layer') for f in d.get('features', [])); print('Found layers:', layers)"
   ```
   *Expected Result*: `Found layers: {'storm'}` (no sanitary features).
