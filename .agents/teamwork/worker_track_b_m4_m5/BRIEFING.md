# BRIEFING — 2026-10-31T07:44:00Z

## Mission
Implement Milestone 4 & 5 Construction QA tools (3D Surface Flatness/Plumbness Inspector, Open-Trench Utility 3D Tracer, Compare View ΔV Volume Takeoff, RTK Stakeout export strictly E N Z with printable field sheet).

## 🔒 My Identity
- Archetype: worker_track_b_m4_m5
- Roles: implementer, qa, specialist
- Working directory: c:\Antigravity\GatheringScans\.agents\teamwork\worker_track_b_m4_m5\
- Original parent: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3
- Milestone: M4 & M5

## 🔒 Key Constraints
- Strict 5,000-line modular file ceiling.
- ZERO Unicode emojis: crisp inline SVGs only.
- Proper dark/light CSS variables (`var(--bg-surface)`, `var(--text-main)`, etc.).
- Strict 1-word buttons (`[svg] 平整`, `[svg] 垂直`, `[svg] 追蹤`, `[svg] 放樣`, `[svg] 比對`, `[svg] 導出`, etc.).
- Coordinate order strictly Easting, Northing, Elevation (E, N, Z): PtID, Easting, Northing, Elevation, Code.
- Project-agnostic settings: Tolerances (mm), reference planes, and pipe diameters user-selectable.
- Zero scan destruction: NEVER delete or modify scan data on disk.
- DO NOT CHEAT: Genuine implementations only, real math and geometry, no dummy facade or hardcoding.
- Adhere to GitHub, local server (127.0.0.1:8095), and VPS sync rules.

## Current Parent
- Conversation ID: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3
- Updated: 2026-10-31T07:44:00Z

## Task Summary
- **What to build**:
  1. 3D Surface Flatness & Plumbness Inspector: ASTM E1155 approximation, plumb tilt ratio (1:N or mm/m), deviation heatmap grid, Pass Rate %, Max High / Max Low.
  2. Open-Trench Utility 3D Tracer: Invert & crown elevation, pipe diameter, gradient (% and 1:N), depth of cover from ground/design surface, DXF and CSV export.
  3. Compare View ΔV Volume Takeoff: Polygon-bounded epoch-to-epoch cut/fill difference volume takeoff with mass conservation.
  4. RTK Stakeout Export strictly in Easting, Northing, Elevation (E, N, Z) order: PtID, Easting, Northing, Elevation, Code format with printable field sheet.
- **Success criteria**: All features tested and working, unit & E2E tests passing, clean dark/light themes, zero emojis, <5000 lines.
- **Interface contracts**: REST API endpoints `/api/survey/surface-qa`, `/api/survey/utility-trace`, `/api/survey/stakeout-export`, `/api/survey/compare-volume`.
- **Code layout**:
  - Backend: `pc_worker/surveying/construction_qa.py`, `pc_worker/surveying_engine.py`, `pc_worker/server_api_routes.py`
  - Frontend: `web/src/10-construction-qa-and-stakeout.js`, `web/index.html`, `web/sw.js`, `web/survey-bim.css`
  - Tests: `tests/test_civil_surveying_e2e.py`, `tests/test_gathering_scans_suite.py`

## Change Tracker
- **Files modified**:
  - `pc_worker/surveying/construction_qa.py`: 1,205 lines implementing ConstructionQAMixin.
  - `pc_worker/surveying/__init__.py`: Exported ConstructionQAMixin.
  - `pc_worker/surveying_engine.py`: Composed ConstructionQAMixin into SurveyingEngine.
  - `pc_worker/server_api_routes.py`: Wired HTTP POST endpoints.
  - `web/src/10-construction-qa-and-stakeout.js`: 1,052 lines implementing 4 modular UI inspectors, zero emojis, dark/light themes.
  - `web/survey-bim.css`: CSS styles with custom properties.
  - `web/index.html`: Registered script tag and bumped version to v225.
  - `web/sw.js`: Bumped offline cache to v225.
  - `tests/test_civil_surveying_e2e.py`: 4 test classes covering M4 & M5 with real mathematical verification.
  - `tests/test_gathering_scans_suite.py`: Added test_39 for M4 & M5 regression check.
- **Build status**: PASS (57 tests in civil_surveying_e2e, 39 tests in gathering_scans_suite).
- **Pending issues**: None. All deployed to GitHub and both servers.

## Quality Status
- **Build/test result**: All 57 E2E tests + 39 suite tests PASS (100%).
- **Lint status**: Zero Unicode emojis, strict 5,000 line ceiling satisfied across all files.
- **Tests added/modified**: `TestSurfaceFlatnessAndPlumbnessInspector`, `TestOpenTrenchUtilityTracer`, `TestCompareViewDeltaVVolumeTakeoff`, `TestRTKStakeoutExportStrictENZOrder`, `test_39_milestone4_milestone5_construction_qa_and_stakeout`.

## Key Decisions Made
- Architecture: Mixin `ConstructionQAMixin` in `pc_worker/surveying/construction_qa.py` inherited by `SurveyingEngine`.
- Modular UI: `web/src/10-construction-qa-and-stakeout.js` attached to `window.__GS_API` and global namespace.
- Coordinate order: Strictly enforced `PtID, Easting, Northing, Elevation, Code` for survey data interchange.

## Artifact Index
- `.agents/teamwork/worker_track_b_m4_m5/BRIEFING.md` — Agent working memory
- `.agents/teamwork/worker_track_b_m4_m5/progress.md` — Agent heartbeat
- `.agents/teamwork/worker_track_b_m4_m5/handoff.md` — Complete handoff report
