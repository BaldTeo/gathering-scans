# Milestone 7 Remediation Handoff Report (Iteration 2)
**Author**: `worker_m7_iter2` (Remediation Implementer & QA Specialist)  
**Parent Conv ID**: `35a7b3c4-959a-4d2b-a4b5-21fb2891dea3`  
**Target**: Milestone 7 (Real Public Utilities GIS Integration with Taiwan Open APIs)  
**Status**: **COMPLETE / READY FOR VERIFICATION**  

---

## 1. Observation

Direct observations from initial test execution and codebase inspection:

1. **Bug 1: Sentinel Slope Leak**:
   - `tests/test_adversarial_m7_challenger.py:109` failed with:
     ```
     AssertionError: False is not true : Pipe slope -9999.0% outside civil range
     ```
   - In `pc_worker/surveying/public_utilities_gis.py:381-383`:
     ```python
     slope_calc = round(((z1 - z2) / max(0.1, length_m)) * 100.0, 3)
     slope = safe_float(attrs.get("P_SLOPE"), slope_calc) or slope_calc
     ```
     New Taipei WRD MapServer returns `P_SLOPE: -9999`. Because `safe_float(-9999)` returns `-9999.0` (truthy), the sentinel was leaked directly into API responses and saved into `data/utilities_cache/*.json`.

2. **Bug 2: Layer Filtering Bypass on Cache Hit**:
   - `tests/test_adversarial_m7_challenger.py:133` failed with:
     ```
     AssertionError: 'sanitary' != 'storm' : Layer filtering failed: found sanitary
     ```
   - In `pc_worker/surveying/public_utilities_gis.py:250-258`, when `cache_file` existed, `cached_data` was returned immediately without filtering `cached_data["features"]` or `cached_data["layer_counts"]` by `requested_layers`.

3. **Bug 3: 2D Coordinates IndexError in DXF Export**:
   - In `pc_worker/surveying/public_utilities_gis.py:1079, 1087`:
     Direct indexing `p1[2]` and `pt[2]` crashed with `IndexError: list index out of range` and HTTP 500 when features contained standard 2D coordinates `[x, y]`.

4. **Bug 4: Non-String File Content AttributeError**:
   - In `pc_worker/surveying/public_utilities_gis.py:610` and `pc_worker/server_api_routes.py:1130`:
     Sending non-string payload like `file_content: 12345` invoked `.strip()`, crashing with `AttributeError: 'int' object has no attribute 'strip'` and HTTP 500 instead of returning HTTP 400 Bad Request.

---

## 2. Logic Chain

1. *Slope Sentinel Sanitization*:
   Municipal GIS systems use `-9999` to indicate unmeasured slopes. In civil engineering, true pipe slopes are bounded in `[-25.0%, 25.0%]`. Sanitizing `raw_slope` against `abs(raw_slope) < 900.0` and falling back to physical slope calculation from invert depths `((z1 - z2) / length) * 100.0` (typically ~0.4%–0.5%) produces genuine, physically accurate engineering models. Applying this at query time, on cache load, and sanitizing disk cache files guarantees no sentinel can ever leak.

2. *Strict Layer Isolation*:
   When a client requests a subset of layers (e.g. `layers: ["storm"]`), returning cached features belonging to `sanitary` violates the API contract. Filtering `cached_data["features"]` to only include features whose `layer in set(requested_layers)` and recomputing `layer_counts`, `total_features`, `total_pipe_length_m`, and `total_structures` ensures complete layer isolation. On cache write, merging newly queried layers with any existing unqueried layers preserves cumulative data without dropping layers.

3. *Safe 2D/3D Coordinate Handling in DXF*:
   GIS shapefiles and CAD exports often carry 2D coordinates `[E, N]`. Checking `len(pt) > 2` and safely defaulting elevation `z = 0.0` prevents `IndexError` while producing valid AutoCAD 3D `LINE` and `POINT` entities at baseline datum elevation.

4. *Input Type Validation & HTTP 400*:
   In both `server_api_routes.py` and `parse_utilities_file`, checking `isinstance(file_content, (str, bytes, bytearray))` and returning HTTP 400 Bad Request with a structured error payload adheres to REST API standards, preventing server-side exceptions.

---

## 3. Caveats

- Government municipal GIS servers (`wrd.ntpc.gov.tw` and `sewer.ntpc.gov.tw`) occasionally take 1–3 seconds on fresh uncached queries; disk caching in `data/utilities_cache/` provides sub-millisecond repeat queries.
- No third-party CAD libraries were used; standard ASCII DXF format (R12/2000 compliant) is directly generated.

---

## 4. Conclusion

All 4 issues identified by `challenger_m7_1` and the orchestrator have been completely resolved:
- Genuine physical slopes (0.4%–0.5%) are reported; `-9999.0%` sentinels are 100% eliminated.
- Layer filtering strictly returns only requested layers (e.g. `layers: ['storm']` returns 0 sanitary features).
- 2D coordinates export to DXF cleanly with `z = 0.000` without errors.
- Non-string payloads return HTTP 400 Bad Request with structured error messages.
- All 17 adversarial tests, 57 e2e surveying tests, and 39 comprehensive suite tests pass.
- Asset versions bumped to `v229`, changes committed and pushed to GitHub `origin/main` (commit `348f434`), and deployed to both local server (127.0.0.1:8095) and live Hostinger VPS container (`scans.gatheren.cloud` / 76.13.197.29).

---

## 5. Verification Method

To independently verify all fixes:

1. **Run Adversarial Stress Test Suite**:
   ```powershell
   python -m unittest tests/test_adversarial_m7_challenger.py
   ```
   *Result*: 17/17 passed in ~2.7s.

2. **Verify Slope Sanitization at Rose Park**:
   ```powershell
   python -c "import urllib.request, json; data = json.dumps({'scan_id': 'rosepark_20260918_merged', 'radius_m': 120}).encode('utf-8'); req = urllib.request.Request('http://127.0.0.1:8095/api/survey/utilities-query', data=data, headers={'Content-Type': 'application/json'}); res = urllib.request.urlopen(req); d = json.loads(res.read().decode('utf-8')); slopes = [f.get('slope_pct') for f in d.get('features', []) if 'slope_pct' in f]; print('Min slope:', min(slopes), 'Max slope:', max(slopes))"
   ```
   *Expected Output*: `Min slope: 0.4 Max slope: 0.5` (no -9999).

3. **Verify Layer Filtering Consistency**:
   ```powershell
   python -c "import urllib.request, json; data = json.dumps({'scan_id': 'rosepark_20260918_merged', 'radius_m': 120, 'layers': ['storm']}).encode('utf-8'); req = urllib.request.Request('http://127.0.0.1:8095/api/survey/utilities-query', data=data, headers={'Content-Type': 'application/json'}); res = urllib.request.urlopen(req); d = json.loads(res.read().decode('utf-8')); layers = set(f.get('layer') for f in d.get('features', [])); print('Found layers:', layers)"
   ```
   *Expected Output*: `Found layers: {'storm'}` (no sanitary features).

4. **Verify 2D DXF Export (Anti-Crash)**:
   ```powershell
   python -c "import urllib.request, json; data = json.dumps({'scan_id': 'test', 'format': 'dxf', 'features': [{'id': 'p1', 'layer': 'storm', 'type': 'pipe', 'coords': [[10.0, 20.0], [30.0, 40.0]]}]}).encode('utf-8'); req = urllib.request.Request('http://127.0.0.1:8095/api/survey/utilities-export', data=data, headers={'Content-Type': 'application/json'}); res = urllib.request.urlopen(req); print('Status:', res.status)"
   ```
   *Expected Output*: `Status: 200`.

5. **Verify Non-String Payload Validation**:
   ```powershell
   python -c "import urllib.request, json; data = json.dumps({'file_content': 12345, 'filename': 'test.gml'}).encode('utf-8'); req = urllib.request.Request('http://127.0.0.1:8095/api/survey/utilities-parse', data=data, headers={'Content-Type': 'application/json'}); urllib.request.urlopen(req)"
   ```
   *Expected Output*: HTTP 400 Bad Request.

6. **Verify Live Production VPS**:
   ```powershell
   curl.exe -i -s -k https://scans.gatheren.cloud/api/status
   curl.exe -s -k https://scans.gatheren.cloud/ | Select-String "v229"
   ```
   *Expected Output*: HTTP 200 OK and asset version `v229`.
