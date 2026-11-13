## 2026-10-31T07:59:13Z
You are worker_m7_iter2, the remediation worker for Milestone 7 (Real Public Utilities GIS Integration with Taiwan Open APIs).

Working Directory: c:\Antigravity\GatheringScans\.agents\teamwork\worker_m7_iter2\
Parent Conv ID: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

MANDATORY FIRST STEPS:
1. Read c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md.
2. Read critic handoffs:
   - c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m7_1\handoff.md
   - c:\Antigravity\GatheringScans\tests\test_adversarial_m7_challenger.py

REMEDIATION TASKS:
In pc_worker/surveying/public_utilities_gis.py:
1. Fix Null Sentinel Leak in P_SLOPE:
   - When P_SLOPE has sentinel values (e.g. -9999 or -9999.0), sanitize so it is treated as null or 0.0% instead of leaking as -9999.0% hydraulic slope in API responses and DXF outputs.
2. Fix Layer Filtering on Cached Spatial Queries:
   - When loading cached spatial features from data/utilities_cache/, ensure features are filtered by the user's requested `layers` categories (e.g. if user requests layers: ["storm"], do not leak cached sanitary sewer features).
3. Handle 2D Coordinates in DXF Export:
   - In export_utilities_dxf (and /api/survey/utilities-export), handle coordinates that are 2D `[x, y]` safely by defaulting elevation `z = 0.0` or local surface elevation, so `pt[2]` does NOT raise IndexError: list index out of range.
4. Non-String Payload Validation in File Parser:
   - In parse_uploaded_utility_file (and /api/survey/utilities-parse), if `file_content` is not a string (or bytes), return HTTP 400 Bad Request instead of crashing with AttributeError.
5. Verification, Tests & Deployment (AGENTS.md):
   - Run unittest suites:
     python -m unittest tests/test_adversarial_m7_challenger.py
     python -m unittest tests/test_civil_surveying_e2e.py
     python -m unittest tests/test_gathering_scans_suite.py
   - Ensure all files are strictly under 5,000 lines.
   - Bump asset version in web/index.html and web/sw.js.
   - Commit & push changes to origin/main.
   - Reload local server (8095) via watchdog.
   - Update live Hostinger VPS container.
6. Deliverable:
   - Write handoff report to c:\Antigravity\GatheringScans\.agents\teamwork\worker_m7_iter2\handoff.md.
   - Call send_message to parent (35a7b3c4-959a-4d2b-a4b5-21fb2891dea3).
