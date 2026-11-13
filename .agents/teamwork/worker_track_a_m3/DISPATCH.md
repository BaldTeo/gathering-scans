# Dispatch: worker_track_a_m3 (Milestone 3 — Stationing, AEA & Drainage Ponding)

## Mission
Implement Milestone 3: Centerline Stationing (0K+000) with polyline chainage, interval & swath width sampling; Parametric Roadway/Trench template overlay with Average-End-Area cut/fill volume; Custom slope classification tiers; and Surface drainage depression takeoff (ponding water volume $V_{water}$ m³, maximum depth, and surface area).

## Code Boundaries (Exclusive Write Ownership)
- Backend:
  - `pc_worker/surveying/contours_and_cad.py` (Stationing alignment slicing, chainage codes, and Average-End-Area volume integration)
  - `pc_worker/surveying/dsm_and_volume.py` (Drainage depression sinks, spill pour points, water volume calculation)
  - `pc_worker/server_api_routes.py` (Wire `/api/survey/stationing` and `/api/survey/drainage` endpoints)
- Frontend:
  - `web/src/09-construction-survey-and-bim.js` (Stationing & Drainage UI tabs, station profile canvas/SVG, AEA volume summary)
  - `web/survey-bim.css` (Stationing & Drainage styles)
- Tests:
  - `tests/test_civil_surveying_e2e.py` and `tests/test_gathering_scans_suite.py`

## Mandates & Constraints
- MANDATORY INTEGRITY WARNING: DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work.
- Strict 5,000-line ceiling on all files! Currently `09` has ~860 lines (over 4,100 lines headroom).
- ZERO Unicode emojis: crisp inline SVG icons only.
- Proper Bright & Dark Theme support using CSS variables.
- Strict 1-word button labels (`[svg] 樁號`, `[svg] 剖面`, `[svg] 窪蓄`, `[svg] 導出`, etc.).
- Project-agnostic settings: User-configurable station interval, swath width, design template, and slope tiers.
- Zero data destruction: NEVER delete or modify scan data on disk.
- Run tests, bump asset version query in `web/index.html` and `web/sw.js`, commit, and reload local server and live VPS.


## 2026-10-31T07:14:53Z
Sender: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3
Priority: MESSAGE_PRIORITY_HIGH
Content:
You are worker_track_a_m3. Your working directory is c:\Antigravity\GatheringScans\.agents\teamwork\worker_track_a_m3\.
Read c:\Antigravity\GatheringScans\.agents\teamwork\worker_track_a_m3\DISPATCH.md and c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md before starting work.
Your task is to implement Milestone 3 (Centerline Stationing 0K+000, Average-End-Area cut/fill volume, and Surface drainage ponding volume takeoff).
Your exclusive file boundaries:
- Backend: pc_worker/surveying/contours_and_cad.py and pc_worker/surveying/dsm_and_volume.py, wire in pc_worker/server_api_routes.py.
- Frontend: web/src/09-construction-survey-and-bim.js and web/survey-bim.css.
- Tests: tests/test_civil_surveying_e2e.py and tests/test_gathering_scans_suite.py.
MANDATORY INTEGRITY WARNING: DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work.
Keep all files strictly under 5,000 lines. Zero Unicode emojis (crisp inline SVGs only). Proper dark/light CSS variables. Strict 1-word buttons. Zero scan destruction.
Run tests, bump cache version in web/index.html and web/sw.js, commit, reload local daemon and live VPS. Write handoff.md and notify orchestrator via send_message.
