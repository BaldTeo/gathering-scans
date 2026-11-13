# Milestone 6 Verification & Challenge Report: Scan-to-BIM Geometric Fitting & Exporters

**Reviewer**: `challenger_m6_1` (Empirical Challenger, Critic & Specialist)  
**Date**: 2026-10-31T07:54:00Z  
**Verdict**: **`REQUEST_CHANGES`**

---

## 1. Observation

### 1.1 Inverted Normal Winding and Non-Manifold Shell Topologies
An empirical mathematical oracle (`compute_mesh_signed_volume` using divergence theorem $\sum \frac{1}{6} (v_0 \times v_1) \cdot v_2$ and `check_mesh_manifold_topology`) was executed on all generated geometric solid primitives in `tests/test_scan_to_bim_empirical_stress.py`.

Execution command and verbatim output:
```powershell
python -m tests.test_scan_to_bim_empirical_stress
```
Output:
```
=== Empirical Mesh Topology & Signed Volume Audit ===
Cylinder: signed_vol=6.1229 (expected ~6.2832), topo={'V': 34, 'E': 96, 'F': 64, 'euler': 2, 'is_closed': True, 'boundary_edge_count': 0, 'is_oriented_manifold': True, 'unmatched_directed_count': 0, 'duplicate_directed_count': 0}
Ellipsoid: signed_vol=-47.7848 (expected ~50.2655), topo={'V': 146, 'E': 432, 'F': 288, 'euler': 2, 'is_closed': True, 'boundary_edge_count': 0, 'is_oriented_manifold': True, 'unmatched_directed_count': 0, 'duplicate_directed_count': 0}
Box: signed_vol=120.0000 (expected ~120.0000), topo={'V': 8, 'E': 18, 'F': 12, 'euler': 2, 'is_closed': True, 'boundary_edge_count': 0, 'is_oriented_manifold': True, 'unmatched_directed_count': 0, 'duplicate_directed_count': 0}
Pipe: signed_vol=-2.5000 (expected ~7.8540), topo={'V': 26, 'E': 72, 'F': 48, 'euler': 2, 'is_closed': True, 'boundary_edge_count': 0, 'is_oriented_manifold': False, 'unmatched_directed_count': 24, 'duplicate_directed_count': 24}
Wall Prism: signed_vol=27.9017, topo={'V': 12, 'E': 30, 'F': 20, 'euler': 2, 'is_closed': True, 'boundary_edge_count': 0, 'is_oriented_manifold': True, 'unmatched_directed_count': 0, 'duplicate_directed_count': 0}
Extruded Polygon: signed_vol=-16.6667 (expected ~50.0000), topo={'V': 8, 'E': 18, 'F': 12, 'euler': 2, 'is_closed': True, 'boundary_edge_count': 0, 'is_oriented_manifold': False, 'unmatched_directed_count': 8, 'duplicate_directed_count': 8}
```

Direct observations:
1. **Tree Canopy Ellipsoid (`_generate_ellipsoid_mesh`, `pc_worker/surveying/scan_to_bim.py:251-274`)**:
   - `signed_vol = -47.7848` (strictly negative).
   - The triangle face indices `(p0, p2, p3)` and `(p0, p3, p1)` in the intermediate rings and pole fans wind clockwise looking from the exterior, orienting all face normal vectors inwards into the interior of the tree canopy instead of outwards.
2. **Cylindrical Pipe Solid (`_generate_pipe_cylinder_mesh`, `pc_worker/surveying/scan_to_bim.py:558-573`)**:
   - `is_oriented_manifold: False`, with 24 unmatched and 24 duplicate directed edges.
   - `signed_vol = -2.5000` (negative and corrupted).
   - Side faces `(b0, t0, t1)` and `(b0, t1, b1)` traverse the endcap ring edges in the *exact same direction* as the cap triangles (`(c1_idx, nxt, i)` and `(c2_idx, i + radial_segments, nxt + radial_segments)`), rather than opposite directions.
3. **Road Pavement & Water Bathymetric Prisms (`_generate_extruded_polygon_mesh`, `pc_worker/surveying/scan_to_bim.py:385-391`)**:
   - `is_oriented_manifold: False`, with 8 unmatched and 8 duplicate directed edges.
   - `signed_vol = -16.6667` (strictly negative).
   - In downward extrusion (`sign < 0`), the side skirts `(t0, t1, b1)` traverse directed edge `(t0, t1)` in the same direction as the top cap, producing inward normals and non-manifold duplicate edge sharing.

### 1.2 Invalid STEP Entity Keyword in ISO-10303-21 IFC Exporter
In `pc_worker/surveying/scan_to_bim.py:1350`:
```python
lines.append(f"#{id_elem}=IFCGEOGRAPHIC_ELEMENT('{create_ifc_guid()}',#{id_owner},'{prim_name}',$,$,#{id_axis},#{id_prod_shape},'{prim_id_str}',.USERDEFINED.);")
```
- In the ISO-10303-21 STEP physical file format for IFC4, entity names do not contain underscores (`IFCGEOGRAPHICELEMENT`, not `IFCGEOGRAPHIC_ELEMENT`).
- Verified against buildingSMART IFC4 schema specification: `IFCGEOGRAPHIC_ELEMENT` is an invalid token that causes parser rejection in strict IFC readers (IfcOpenShell, Solibri Model Checker, Autodesk Revit).

### 1.3 Unhandled HTTP 500 on Path Traversal in Export API
Command:
```powershell
python -c "import urllib.request, json; req = urllib.request.Request('http://127.0.0.1:8095/api/survey/scan-to-bim/export', data=json.dumps({'scan_id': '../../../etc/passwd', 'formats': ['ifc'], 'primitives': []}).encode('utf-8'), headers={'Content-Type': 'application/json'}, method='POST'); urllib.request.urlopen(req)"
```
Verbatim response:
```
HTTPError: 500 {"error": "[Errno 2] No such file or directory: 'C:\\\\Antigravity\\\\GatheringScans\\\\data\\\\reports\\\\scan_../../../etc/passwd_bim.ifc'"}
```
- `export_scan_to_bim` in `pc_worker/surveying/scan_to_bim.py:1098` uses raw `payload.get("scan_id")` without sanitization (`re.sub(r'[^a-zA-Z0-9_\-]', '_', scan_id)` or `os.path.basename`).
- The resulting `FileNotFoundError` escapes unhandled to `pc_worker/server_api_routes.py:2281`, producing an HTTP 500 error instead of a clean HTTP 400 Bad Request rejection or sanitized file path.

### 1.4 Unhandled HTTP 500 on Malformed Coordinate Types
Command:
```powershell
python -c "import urllib.request, json; req = urllib.request.Request('http://127.0.0.1:8095/api/survey/scan-to-bim', data=json.dumps({'scan_id': 'quchi_20261005_merged', 'categorization_data': {'ok': True, 'walls': [{'id': 'W_BAD', 'length_m': 10.0, 'base_polyline_twd97': 'abc', 'top_polyline_twd97': 'abc'}]}}).encode('utf-8'), headers={'Content-Type': 'application/json'}, method='POST'); urllib.request.urlopen(req)"
```
Verbatim response:
```
HTTPError: 500 {"error": "unsupported operand type(s) for -: 'str' and 'str'"}
```
- When malformed string data is passed in polylines or boundaries, `TypeError` is raised during coordinate arithmetic (`dx = base_polyline[1][0] - base_polyline[0][0]`).
- `pc_worker/server_api_routes.py:2276-2282` catches `KeyError` (404) and `ValueError` (400), but lacks handling for `TypeError`, causing an unhandled HTTP 500 response.

### 1.5 Positive Baseline Observations
- Standard test suite passes:
  - `python -m unittest tests.test_civil_surveying_e2e.TestScanToBimGeometricFitting tests.test_civil_surveying_e2e.TestScanToBimExporters`: 9/9 tests pass (0.835s).
  - `python -m unittest tests/test_gathering_scans_suite.py`: 37/37 tests pass (11.417s).
- Modular architecture line ceiling:
  - `pc_worker/surveying/scan_to_bim.py`: 1,524 lines (< 5,000).
  - `web/src/11-scan-to-bim-primitives.js`: 646 lines (< 5,000).
  - `web/survey-bim.css`: 1,258 lines (< 5,000).
- UI/UX compliance:
  - Zero emojis in `web/src/11-scan-to-bim-primitives.js` and `web/survey-bim.css` (0 occurrences verified by regex).
  - Strict 1-word buttons: `[wand] 擬合`, `[eye] 預覽`, `[download] IFC`, `[download] DXF`, `[download] OBJ`.
  - Dark and light theme CSS selectors (`html[data-theme="dark"]`, `html[data-theme="light"]`) are comprehensively wired.

---

## 2. Logic Chain

1. **Premise 1 — Brep Solid Validity**:
   - The user requirements state: "Verify that solid primitives have non-zero positive volume, consistent outward normal winding (counter-clockwise on outer faces), and clean closed Brep shells."
   - In 3D computational geometry, an outward-oriented 2-manifold closed triangle mesh must have a positive signed volume under the divergence theorem, and every directed edge $(u, v)$ must be paired with exactly one reverse directed edge $(v, u)$ on an adjacent face.
   - Observation 1.1 proves that `_generate_ellipsoid_mesh` produces negative signed volume (`-47.7848`), `_generate_pipe_cylinder_mesh` produces non-manifold topology (24 duplicate directed edges, signed volume `-2.5000`), and `_generate_extruded_polygon_mesh` produces non-manifold topology (8 duplicate directed edges, signed volume `-16.6667`).
   - Therefore, the fitted solid primitives for trees, pipes, roads, and water bodies do not meet the outward normal winding and manifold Brep shell requirements.

2. **Premise 2 — IFC SPF Schema Compliance**:
   - The ISO-10303-21 STEP physical format requires exact uppercase entity names defined in the schema.
   - In IFC4, the class `IfcGeographicElement` is represented as `IFCGEOGRAPHICELEMENT`, not `IFCGEOGRAPHIC_ELEMENT`.
   - Observation 1.2 proves that line 1350 emits `IFCGEOGRAPHIC_ELEMENT`, which is an invalid token that breaks standard IFC import tools.

3. **Premise 3 — Zero Unhandled 500 Errors on Malformed Inputs**:
   - The user requirements mandate: "Execute custom stress tests asserting that malformed classification geometries do not crash the fitting algorithm with unhandled 500 errors."
   - Observations 1.3 and 1.4 prove that path traversal payloads in `scan_id` trigger `FileNotFoundError` (HTTP 500), and string coordinate payloads trigger `TypeError` (HTTP 500).
   - Therefore, the API routes and fitting algorithms fail the zero unhandled 500 error criteria.

4. **Conclusion**:
   - Because multiple core geometric, schema, and API resilience criteria failed empirical verification, the Milestone 6 implementation cannot be approved in its current state.

---

## 3. Caveats

- The box cuboid (`_generate_box_mesh`) and wall prism (`_generate_extruded_wall_prism_mesh`) meshes were verified to have strictly positive signed volumes and clean closed 2-manifold topology without boundary edges or duplicate directed edges.
- The 403 Forbidden on `/api/reports/` download is by-design behavior for unauthenticated guest requests (which require explicit authorization or admin session cookies).
- The existing automated regression test suite (`tests/test_gathering_scans_suite.py` and `tests/test_civil_surveying_e2e.py`) passed cleanly without regression on baseline tasks.

---

## 4. Conclusion

**Verdict: `REQUEST_CHANGES`**

The following concrete remediations are required from the implementation worker:
1. **Fix Mesh Face Normal Winding and Manifold Topology**:
   - In `_generate_ellipsoid_mesh`: Reverse face vertex order in the intermediate rings and pole connections so outward normals point away from center and signed volume is positive.
   - In `_generate_pipe_cylinder_mesh`: Correct side quad face winding (`(b0, b1, t1)` and `(b0, t1, t0)`) so ring edges oppose the cap face edges, resolving the 24 duplicate directed edges and positive volume.
   - In `_generate_extruded_polygon_mesh`: For downward extrusion (`sign < 0`), correct side skirt face winding (`(t0, b0, b1)` and `(t0, b1, t1)`) so boundary edges oppose top and bottom cap edges, resolving the 8 duplicate directed edges and positive volume.
2. **Correct IFC Entity Name**:
   - In `pc_worker/surveying/scan_to_bim.py:1350`: Replace `IFCGEOGRAPHIC_ELEMENT` with `IFCGEOGRAPHICELEMENT`.
3. **Sanitize `scan_id` in `export_scan_to_bim`**:
   - Apply `clean_scan_id = re.sub(r'[^a-zA-Z0-9_\-]', '_', str(scan_id).strip())` before constructing file paths in `REPORTS_DIR` and `CONTOURS_DIR`.
4. **Harden Coordinate Unpacking & Exception Handling**:
   - In `pc_worker/surveying/scan_to_bim.py`: Validate that coordinate lists contain numeric floats before indexing or computing vector lengths; wrap primitive assembly loops in graceful try/except blocks to skip corrupt elements rather than crashing.
   - In `pc_worker/server_api_routes.py:2280`: Catch `TypeError` alongside `ValueError` with `status=400` to prevent unhandled 500 errors on malformed payloads.

---

## 5. Verification Method

To independently verify the failure modes:
1. **Mesh Topology & Signed Volume Audit**:
   ```powershell
   python -m tests.test_scan_to_bim_empirical_stress
   ```
   *Expected*: `Ellipsoid` signed volume is negative; `Pipe` and `Extruded Polygon` report `is_oriented_manifold: False` with duplicate directed edges.
2. **Path Traversal 500 Error**:
   ```powershell
   python -c "import urllib.request, json; req = urllib.request.Request('http://127.0.0.1:8095/api/survey/scan-to-bim/export', data=json.dumps({'scan_id': '../../../etc/passwd', 'formats': ['ifc'], 'primitives': []}).encode('utf-8'), headers={'Content-Type': 'application/json'}, method='POST'); urllib.request.urlopen(req)"
   ```
   *Expected*: Returns HTTP 500 `FileNotFoundError`.
3. **Malformed Coordinate 500 Error**:
   ```powershell
   python -c "import urllib.request, json; req = urllib.request.Request('http://127.0.0.1:8095/api/survey/scan-to-bim', data=json.dumps({'scan_id': 'quchi_20261005_merged', 'categorization_data': {'ok': True, 'walls': [{'id': 'W_BAD', 'length_m': 10.0, 'base_polyline_twd97': 'abc', 'top_polyline_twd97': 'abc'}]}}).encode('utf-8'), headers={'Content-Type': 'application/json'}, method='POST'); urllib.request.urlopen(req)"
   ```
   *Expected*: Returns HTTP 500 `TypeError`.
4. **Invalid IFC Keyword**:
   Inspect line 1350 of `pc_worker/surveying/scan_to_bim.py`:
   *Expected*: Verbatim presence of `IFCGEOGRAPHIC_ELEMENT` instead of standard `IFCGEOGRAPHICELEMENT`.
