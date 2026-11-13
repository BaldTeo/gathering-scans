# Milestone 6 Challenger Report: Exporter File Validation, Live API Stress, and Downstream Regression

**Author**: challenger_m6_2  
**Role**: Empirical Challenger (critic, specialist)  
**Date**: 2026-10-31  
**Verdict**: **REQUEST_CHANGES** (Path Traversal & Unhandled 500 Vulnerability in `POST /api/survey/scan-to-bim/export`)

---

## 1. Observation

### A. File Format Syntax & Parser Verification
1. **ISO-10303-21 IFC4 Exchange File (`scan_quchi_20261005_merged_bim.ifc`)**:
   - Header begins with `ISO-10303-21;` and terminates with `END-ISO-10303-21;`.
   - Schema defined as `FILE_SCHEMA(('IFC4'));`.
   - 100% of entity record lines terminate with a semicolon (`;`).
   - Symmetrical, balanced parentheses across all entity definition statements.
   - Graph entity resolution check: 1,155 defined entities (`#1` to `#1155`), 1,145 cross-entity references (`#X`). **Exactly 0 dangling entity references**.
   - Base64 GUID validation: all GUID strings match `[0-9A-Za-z_$]{22}` generated from UUID4 bit manipulation.
   - Semantic entities confirmed: `IfcWall`, `IfcGeographicElement`, `IfcCivilElement`, `IfcFlowSegment`, `IfcBuildingElementProxy` referencing `IfcFacetedBrep`, `IfcClosedShell`, and `IfcPolyLoop`.

2. **AutoCAD 3D DXF (`scan_quchi_20261005_merged_bim_3d.dxf`)**:
   - Total lines: 8,608 lines forming exactly 4,304 alternating Group Code (integer) and Value pairs.
   - Valid section structure: `SECTION/HEADER/TABLES/ENTITIES/ENDSEC/EOF`.
   - AC1015 (AutoCAD 2000) header specification (`$ACADVER = AC1015`, `$INSUNITS = 6` for meters).
   - Valid `3DFACE` geometry: 304 3DFACE entities on distinct layers (`BIM_WALLS`, `BIM_TREES`, `BIM_ROADS`, etc.) with standard ACI color indices and valid float coordinate quadruplets (10/20/30, 11/21/31, 12/22/32, 13/23/33).

3. **Wavefront OBJ & MTL (`scan_quchi_20261005_merged_bim.obj` & `.mtl`)**:
   - Vertices: 166 `v X Y Z` vertices with valid float coordinates.
   - Faces: 304 `f v1 v2 v3` faces. **All face indices are strictly 1-based (positive integers $\ge 1$, strictly non-zero)**, and no face index exceeds the total declared vertices up to that line.
   - Materials: `usemtl` statements reference `Mat_Wall`, `Mat_Tree`, `Mat_Road`, `Mat_Water`, `Mat_Building`, `Mat_Pipe`, all matching `newmtl` entries with `Ka`, `Kd`, `Ks`, `d`, `illum 2` in the accompanying `.mtl` file.

### B. Live API & Security Testing (`http://127.0.0.1:8095`)
1. **Valid Requests**:
   - `POST /api/survey/scan-to-bim`: 200 OK, returns classified primitives, KPI volume summaries.
   - `POST /api/survey/scan-to-bim/export`: 200 OK, returns URLs for IFC, DXF, OBJ, MTL.
   - Report download via `/api/reports/`: protected by role-based auth; guest mode download blocked with 403; internal/authenticated request with `X-Tunnel-Key` returns 200 OK.
2. **Missing Fields & Non-Existent Scan IDs**:
   - `POST /api/survey/scan-to-bim` with `{}`: returns `{"ok": false, "status": "error", "error": "Missing scan_id"}`.
   - Non-existent scan ID (`scan_id: "totally_nonexistent_scan_99999"`): returns 200 OK with `primitives: []`.
3. **Disallowed Formats**:
   - Payload: `{"scan_id": "test", "formats": ["exe", "bat", "sh"]}` -> server writes 0 files and returns empty downloads; no executable files generated.
4. **CRITICAL SECURITY VULNERABILITY OBSERVED**:
   - **Path Traversal Arbitrary File Write**:
     Sending payload:
     ```json
     {"scan_id": "quchi/../../secret_scan", "formats": ["ifc"], "primitives": []}
     ```
     to `POST /api/survey/scan-to-bim/export` returned `200 OK` and created file:
     `C:\Antigravity\GatheringScans\data\secret_scan_bim.ifc`
     **This successfully wrote outside `REPORTS_DIR` into the parent `data/` directory.**
   - **Unhandled 500 Crash & Path Leakage**:
     Sending payload:
     ```json
     {"scan_id": "../../../etc/passwd", "formats": ["ifc"], "primitives": []}
     ```
     caused the server to return `HTTP 500 Internal Server Error`:
     ```json
     {"error": "[Errno 2] No such file or directory: 'C:\\\\Antigravity\\\\GatheringScans\\\\data\\\\reports\\\\scan_../../../etc/passwd_bim.ifc'"}
     ```
     This crashed with unhandled `FileNotFoundError` and leaked the backend internal directory path `C:\Antigravity\GatheringScans\data\reports\...`.
     This directly violates the challenge instruction: *"Test invalid scan IDs, missing fields, invalid formats (e.g. format: 'exe'), and path traversal attacks (e.g. scan_id: '../../../etc/passwd'). Verify all are rejected cleanly with 400/404 without crashing."*

### C. Test Suite & Downstream Regression Execution
1. `python -m unittest tests.test_civil_surveying_e2e.TestScanToBimExporters tests.test_gathering_scans_suite.GatheringScansTestSuite.test_37_milestone6_scan_to_bim_fitting_and_exporters`:
   - **Ran 5 tests in 0.665s. OK.**
2. `python -m unittest tests.test_civil_surveying_e2e.TestScanToBimGeometricFitting tests.test_civil_surveying_e2e.TestScanToBimExporters tests.test_civil_surveying_e2e.TestModularArchitectureCompliance`:
   - **Ran 10 tests in 0.909s. OK.**
3. `python -m unittest tests/test_gathering_scans_suite.py`:
   - **Ran 39 tests in 11.865s. OK.**
4. Modular 5,000-line ceiling:
   - `pc_worker/surveying/scan_to_bim.py`: 1,524 lines (< 5,000).
   - `web/src/11-scan-to-bim-primitives.js`: 646 lines (< 5,000).
   - All other modified files remain strictly under 5,000 lines.

### D. Zero Data Destruction Audit
1. `data/gathering_scans.db`:
   - Baseline record counts across all 11 tables:
     `{'scans': 27, 'scan_comments': 15, 'share_links': 17, 'user_settings': 4, 'gchat_notifications': 36, 'sqlite_sequence': 1, 'user_profiles': 20, 'trashed_scans': 14, 'share_access_sessions': 112, 'ip_geo_cache': 24, 'scan_measurement_bookmarks': 0}`
   - Post-test record counts: **Identical**. 0 records modified or deleted.
2. `C:\GatheringScans`:
   - Raw scan directories verified: 0 raw files deleted or modified.

---

## 2. Logic Chain

1. In `pc_worker/surveying/scan_to_bim.py`, `export_scan_to_bim` extracts `scan_id`:
   ```python
   scan_id = str(payload.get("scan_id") or "scan").strip()
   base_fname = f"scan_{scan_id}_bim"
   ifc_name = f"{base_fname}.ifc"
   ifc_path = os.path.join(REPORTS_DIR, ifc_name)
   ```
2. When `scan_id` contains path separators (`/`, `\\`) or directory navigation (`..`), `base_fname` retains them.
3. In `os.path.join(REPORTS_DIR, f"scan_{scan_id}_bim.ifc")`, if `scan_id` has `quchi/../../secret_scan`, the path resolves to `REPORTS_DIR/scan_quchi/../../secret_scan_bim.ifc`, which normalizes to `data/secret_scan_bim.ifc`.
4. When `open(ifc_path, "w")` is executed, the file is written outside `REPORTS_DIR`.
5. If the relative path refers to a non-existent directory (e.g. `../../../etc/passwd`), `open()` raises `FileNotFoundError`.
6. Neither `export_scan_to_bim` nor `pc_worker/server_api_routes.py` catches this or validates `scan_id`, so the error bubbles up to `server.py` and returns `HTTP 500 Internal Server Error`, exposing the internal path.
7. To fulfill the challenge specification, `scan_id` must be sanitized or validated, rejecting any path traversal sequences with `HTTP 400 Bad Request` or `404 Not Found`.

---

## 3. Caveats

1. The geometric math, ISO-10303-21 IFC SPF generation, AutoCAD 3D DXF generation, Wavefront OBJ/MTL generation, and Three.js frontend module are mathematically sound, fully functional, and pass all automated regression tests without regression.
2. The vulnerability does not affect legitimate user requests with standard scan IDs (e.g. `quchi_20261005_merged`), but is an input validation security issue that can be triggered by hostile or malformed API calls.

---

## 4. Conclusion & Verdict

**Verdict: REQUEST_CHANGES**

Milestone 6 cannot be fully approved until the path traversal / arbitrary file write vulnerability in `POST /api/survey/scan-to-bim/export` is remediated.

### Required Changes for Implementation Worker:
1. **Input Validation in `pc_worker/server_api_routes.py` and `pc_worker/surveying/scan_to_bim.py`**:
   Sanitize or validate `scan_id`:
   - In `pc_worker/server_api_routes.py`:
     ```python
     scan_id = str(payload.get("scan_id") or "").strip()
     if ".." in scan_id or "/" in scan_id or "\\" in scan_id:
         self.send_json({"error": "Invalid scan_id: path traversal detected"}, status=400)
         return
     ```
   - In `pc_worker/surveying/scan_to_bim.py` (`export_scan_to_bim` and `fit_scan_to_bim_primitives`):
     ```python
     clean_scan_id = re.sub(r"[^a-zA-Z0-9_\-]", "_", scan_id).strip("._") or "scan"
     ```
   - In `export_scan_to_bim`, ensure target file paths resolve strictly inside `REPORTS_DIR` (e.g. `os.path.commonpath([os.path.abspath(fpath), os.path.abspath(REPORTS_DIR)]) == os.path.abspath(REPORTS_DIR)`).
2. Verify that `POST /api/survey/scan-to-bim/export` with `scan_id: "../../../etc/passwd"` returns `HTTP 400 Bad Request` cleanly without throwing HTTP 500 or writing outside `REPORTS_DIR`.

---

## 5. Verification Method

To independently reproduce this verification:
1. Run the empirical verification suite:
   ```powershell
   python tests/verify_m6_challenger.py
   ```
2. Verify live HTTP endpoints against local server:
   ```powershell
   # 1. Path traversal attempt (should return 400, currently returns 500):
   curl.exe -X POST http://127.0.0.1:8095/api/survey/scan-to-bim/export -H "Content-Type: application/json" -d "{\"scan_id\": \"../../../etc/passwd\", \"formats\": [\"ifc\"]}"

   # 2. File escape attempt (should be rejected, currently returns 200 and writes to data/):
   curl.exe -X POST http://127.0.0.1:8095/api/survey/scan-to-bim/export -H "Content-Type: application/json" -d "{\"scan_id\": \"quchi/../../secret_scan\", \"formats\": [\"ifc\"]}"
   Test-Path "data/secret_scan_bim.ifc"
   ```
3. Run official regression tests:
   ```powershell
   python -m unittest tests.test_civil_surveying_e2e.TestScanToBimExporters tests.test_gathering_scans_suite.GatheringScansTestSuite.test_37_milestone6_scan_to_bim_fitting_and_exporters
   python -m unittest tests/test_gathering_scans_suite.py
   ```
