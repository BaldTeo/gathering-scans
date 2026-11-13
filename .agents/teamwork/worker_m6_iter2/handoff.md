# Milestone 6 Remediation Handoff Report

## 1. Observation
1. **Mesh Inversion & Topology**:
   - `pc_worker/surveying/scan_to_bim.py:350-410` (`_generate_ellipsoid_mesh`): North/south pole fans and intermediate latitude bands had reversed triangle winding, resulting in signed volume `-47.7848 m³` (negative volume).
   - `pc_worker/surveying/scan_to_bim.py:440-475` (`_generate_pipe_cylinder_mesh`): Side quad winding was reversed, resulting in signed volume `-2.5000 m³`.
   - `pc_worker/surveying/scan_to_bim.py:530-580` (`_generate_extruded_polygon_mesh`): Upward extrusion side quads had inverted face ordering, causing negative signed volume `-16.6667 m³`.
   - After remediation, `python -m tests.test_scan_to_bim_empirical_stress` reports:
     - Cylinder: `signed_vol=6.1229 m³`, `euler=2`, `is_closed=True`, `is_oriented_manifold=True`, `unmatched=0`, `duplicate=0`.
     - Ellipsoid: `signed_vol=47.7848 m³`, `euler=2`, `is_closed=True`, `is_oriented_manifold=True`, `unmatched=0`, `duplicate=0`.
     - Box: `signed_vol=120.0000 m³`, `euler=2`, `is_closed=True`, `is_oriented_manifold=True`, `unmatched=0`, `duplicate=0`.
     - Pipe: `signed_vol=7.5000 m³`, `euler=2`, `is_closed=True`, `is_oriented_manifold=True`, `unmatched=0`, `duplicate=0`.
     - Wall Prism: `signed_vol=27.9017 m³`, `euler=2`, `is_closed=True`, `is_oriented_manifold=True`, `unmatched=0`, `duplicate=0`.
     - Extruded Polygon: `signed_vol=50.0000 m³`, `euler=2`, `is_closed=True`, `is_oriented_manifold=True`, `unmatched=0`, `duplicate=0`.

2. **BuildingSMART IFC4 Schema Conformance**:
   - `pc_worker/surveying/scan_to_bim.py:1445-1460`: Used invalid keyword `IFCGEOGRAPHIC_ELEMENT` (with underscore). BuildingSMART schema specifies `IFCGEOGRAPHICELEMENT`.
   - `IfcAxis2Placement3D` was previously passed directly as `ObjectPlacement` (attribute 6) to `IfcSite`, `IfcBuilding`, `IfcBuildingStorey`, and all products. In IFC4, `ObjectPlacement` requires an `IfcObjectPlacement` entity, specifically `IFCLOCALPLACEMENT($,#{id_axis})`.
   - When `PredefinedType` is `.USERDEFINED.`, schema rule `CorrectPredefinedType` requires non-null `ObjectType` (attribute 5). Previously `$` was emitted.
   - `IfcWall` in IFC4 requires 9 attributes (`GlobalId`, `OwnerHistory`, `Name`, `Description`, `ObjectType`, `ObjectPlacement`, `Representation`, `Tag`, `PredefinedType`).

3. **Path Traversal Security**:
   - `export_scan_to_bim` and HTTP endpoints `/api/survey/scan-to-bim` / `/export` previously allowed raw strings containing `..`, `/`, `\` to reach `os.path.join(REPORTS_DIR, f"scan_{scan_id}_bim.ifc")`, causing unhandled `FileNotFoundError` (HTTP 500) that leaked backend path information.
   - Validation now rejects traversal sequences immediately with HTTP 400 Bad Request (`{"error": "Invalid scan_id: path traversal forbidden"}`) and sanitizes filename using `os.path.basename` and regex `[^a-zA-Z0-9_\-]`.
   - Running `python -m unittest tests/verify_m6_challenger.py` verified all three traversal attack payloads (`../../../etc/passwd`, `..\\..\\windows\\system32\\calc`, `quchi/../../secret_scan`) returned HTTP 400 with zero file deletions and zero database changes.

4. **Frontend Architecture & UX**:
   - `web/src/11-scan-to-bim-primitives.js`: Added local `escapeHtml` helper to eliminate potential `ReferenceError`.
   - Added centroid fallback for `originTwd` when `STATE.activeScanOriginTwd` is missing.
   - Added cache reset in `openScanToBimInspector` when `activeScanId` changes.
   - `web/index.html:1030-1045`: Added `#btnStudioBim` dock button in `#bimBottomDock` with 1-word label `BIM` / `實體`, crisp SVG cube icon, and zero emojis.
   - `web/index.html` and `web/sw.js`: Bumped asset cache busting to `v230`.

5. **Modularity & Test Suite Results**:
   - Line counts: `scan_to_bim.py` (1627), `server_api_routes.py` (2342), `11-scan-to-bim-primitives.js` (668), `index.html` (2436), `sw.js` (202), `test_civil_surveying_e2e.py` (2685), `test_gathering_scans_suite.py` (3224). All strictly below the 5,000-line ceiling.
   - `test_civil_surveying_e2e.py`: 57 / 57 tests PASSED.
   - `test_gathering_scans_suite.py`: 39 / 39 tests PASSED.
   - `test_scan_to_bim_adversarial_stress.py`: 12 / 12 tests PASSED.
   - `verify_m6_challenger.py`: 6 / 6 tests PASSED.

---

## 2. Logic Chain
- **Step 1**: The critic reports identified that inverted face indices caused negative volume calculations in CAD/BIM tools. By reversing the winding order of the pole fan vertices in `_generate_ellipsoid_mesh` and quad triangles in `_generate_pipe_cylinder_mesh` and `_generate_extruded_polygon_mesh`, the signed divergence integral became strictly positive while preserving Euler characteristic 2 and closed manifold geometry.
- **Step 2**: BuildingSMART IFC4 validation fails when invalid keywords or mismatched attribute counts are encountered. Renaming `IFCGEOGRAPHIC_ELEMENT` to `IFCGEOGRAPHICELEMENT`, wrapping `id_axis` in `IFCLOCALPLACEMENT`, populating `ObjectType` for `.USERDEFINED.` types, and providing 9 attributes for `IFCWALL` brings the pure Python IFC generator into compliance with the ISO-10303-21 IFC4 specification.
- **Step 3**: To eliminate the path traversal vulnerability without altering legitimate scan IDs, input validation was added at both the HTTP routing layer (`server_api_routes.py`) and the service layer (`scan_to_bim.py`). Any payload containing `..`, `/`, or `\` immediately raises `ValueError("Invalid scan_id: path traversal forbidden")` (mapped to HTTP 400), and `os.path.basename` with regex stripping sanitizes the final output filename.
- **Step 4**: To ensure UI consistency, the studio dock was updated with `#btnStudioBim` inside `#bimBottomDock`. The button strictly conforms to the design system (1-word label, SVG icon, 0 emojis, dual-theme CSS). `window.studioThree` was exposed so `11-scan-to-bim-primitives.js` can mount the 3D primitives overlay cleanly.
- **Step 5**: Synchronization following AGENTS.md was executed: committed and pushed to GitHub `origin/main`, reloaded local server (port 8095) via watchdog, and restarted the live Hostinger VPS container (`76.13.197.29`), verifying both environments respond with 200 OK and serve `v230`.

---

## 3. Caveats
- No caveats. All defects raised by `reviewer_m6_1`, `challenger_m6_1`, and `challenger_m6_2` have been fully investigated and remediated with genuine logic.

---

## 4. Conclusion
Milestone 6 (Scan-to-BIM Simplified Classified Geometric Model & IFC/DXF/OBJ Exporter) remediation is complete, secure, robust, and verified. All automated and adversarial tests pass without regressions, and changes are deployed to both local and live production environments.

---

## 5. Verification Method
1. **Topology & Volume Verification**:
   ```powershell
   python -m tests.test_scan_to_bim_empirical_stress
   ```
2. **Adversarial & Security Verification**:
   ```powershell
   python -m unittest tests/test_scan_to_bim_adversarial_stress.py
   python -m unittest tests/verify_m6_challenger.py
   ```
3. **Full Regression Test Suites**:
   ```powershell
   python -m unittest tests/test_civil_surveying_e2e.py
   python -m unittest tests/test_gathering_scans_suite.py
   ```
4. **Live Endpoint Health**:
   ```powershell
   curl.exe -s http://127.0.0.1:8095/api/status
   curl.exe -s https://scans.gatheren.cloud/api/status
   ```
