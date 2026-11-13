## 2026-10-31T07:57:21Z

You are worker_m6_iter2, the remediation worker for Milestone 6 (Scan-to-BIM Simplified Classified Geometric Model & IFC/DXF/OBJ Exporter).

Working Directory: c:\Antigravity\GatheringScans\.agents\teamwork\worker_m6_iter2\
Parent Conv ID: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

MANDATORY FIRST STEPS:
1. Read c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md.
2. Read critic handoffs:
   - c:\Antigravity\GatheringScans\.agents\teamwork\reviewer_m6_1\handoff.md
   - c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m6_1\handoff.md
   - c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m6_2\handoff.md

REMEDIATION TASKS:
1. Path Traversal & Security in pc_worker/surveying/scan_to_bim.py and pc_worker/server_api_routes.py:
   - In export_scan_to_bim and POST /api/survey/scan-to-bim/export: reject scan_id containing path traversal sequences ("..", "/", "\\") with HTTP 400 Bad Request ("Invalid scan_id"), and sanitize file paths using os.path.basename.
2. BuildingSMART IFC4 Schema Conformance in pc_worker/surveying/scan_to_bim.py:
   - Line 1350: Change "IFCGEOGRAPHIC_ELEMENT" to standard buildingSMART "IFCGEOGRAPHICELEMENT". Also update test assertion in tests/test_civil_surveying_e2e.py.
   - For IfcProduct.ObjectPlacement: ensure products reference valid IfcLocalPlacement entities instead of raw Axis2Placement3D directly.
   - For IfcBuildingElementProxy and IfcGeographicElement: when PredefinedType is .USERDEFINED., provide a valid ObjectType string (e.g. 'PROXY' / 'GEOGRAPHIC') instead of $ to satisfy IFC4 CorrectPredefinedType rule.
   - For IfcWall: ensure 9 IFC4 attributes (including PredefinedType = .NOTDEFINED. or .SOLIDWALL.).
3. Geometric Winding & Positive Signed Volume in pc_worker/surveying/scan_to_bim.py:
   - In _generate_ellipsoid_mesh: flip triangle face vertex order to ensure outward CCW normals and strictly positive signed volume (> 0).
   - In _generate_pipe_cylinder_mesh and _generate_extruded_polygon_mesh: ensure consistent directed edge winding on cylinder sides and downward polygon extrusion.
   - In fit_scan_to_bim_primitives: wrap coordinate parsing in safe_float() / type guards to prevent unhandled TypeError on malformed string arrays.
4. Frontend Fixes in web/src/11-scan-to-bim-primitives.js and web/index.html:
   - Add local helper function escapeHtml(s) to fix ReferenceError: escapeHtml is not defined.
   - Add fallback for originTwd in renderBimThreeMeshes (if STATE.activeScanOriginTwd is missing, derive origin from primitive bounding centroid).
   - Verify web/index.html has dock button for BIM (#btnStudioBim with 1-word label BIM and SVG icon).
   - Clear stale primitives on scan change.
5. Verification, Tests & Deployment (AGENTS.md):
   - Run unittest suites:
     python -m unittest tests.test_civil_surveying_e2e.TestScanToBimGeometricFitting tests.test_civil_surveying_e2e.TestScanToBimExporters
     python -m unittest tests/test_gathering_scans_suite.py
   - Bump asset version in web/index.html and web/sw.js (e.g. v227).
   - Commit & push changes to origin/main.
   - Reload local server (8095) via watchdog.
   - Update live Hostinger VPS container.
6. Deliverable:
   - Write handoff report to c:\Antigravity\GatheringScans\.agents\teamwork\worker_m6_iter2\handoff.md.
   - Call send_message to parent (35a7b3c4-959a-4d2b-a4b5-21fb2891dea3).
