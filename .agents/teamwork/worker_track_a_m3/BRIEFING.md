# BRIEFING — 2026-10-31T07:42:00Z

## Mission
Implement Milestone 3: Centerline Stationing (0K+000) with polyline chainage, interval & swath width sampling; Parametric Roadway/Trench template overlay with Average-End-Area cut/fill volume; Custom slope classification tiers; and Surface drainage depression takeoff (ponding water volume V_water m³, maximum depth, and surface area).

## 🔒 My Identity
- Archetype: worker
- Roles: implementer, qa, specialist
- Working directory: c:\Antigravity\GatheringScans\.agents\teamwork\worker_track_a_m3
- Original parent: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3
- Milestone: Milestone 3 (Centerline Stationing 0K+000, Average-End-Area cut/fill volume, and Surface drainage ponding volume takeoff)

## 🔒 Key Constraints
- Genuine implementation only: DO NOT cheat, hardcode test results, or create dummy/facade implementations.
- Strict 5,000-line modular file ceiling on every source file.
- Zero Unicode emojis (crisp inline SVGs only).
- Proper dark/light CSS variables matching existing web/app.css design system.
- Strict 1-word button labels (e.g., [svg] 樁號, [svg] 剖面, [svg] 窪蓄, [svg] 導出, etc.).
- Project-agnostic settings: user-configurable interval, swath width, design template, and slope tiers.
- Zero scan destruction: NEVER delete or modify scan data on disk.
- File boundaries:
  - Backend: pc_worker/surveying/contours_and_cad.py, pc_worker/surveying/dsm_and_volume.py, pc_worker/server_api_routes.py
  - Frontend: web/src/09-construction-survey-and-bim.js, web/survey-bim.css
  - Tests: tests/test_civil_surveying_e2e.py, tests/test_gathering_scans_suite.py
- Fast-forward git from origin/main, test, bump cache version in web/index.html & web/sw.js, commit, reload local daemon & live VPS.

## Current Parent
- Conversation ID: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3
- Updated: 2026-10-31T07:42:00Z

## Task Summary
- **What to build**:
  1. Centerline Stationing (0K+000) alignment calculation, chainage codes, interval & swath width cross-section slicing.
  2. Parametric roadway/trench template overlay with Average-End-Area (AEA) cut & fill volume calculation.
  3. User-selectable custom slope classification tiers and surface drainage depression / ponding volume takeoff ($V_{water}$ m³, max depth, surface area).
  4. Non-intrusive UI tabs in `web/src/09-construction-survey-and-bim.js` and styling in `web/survey-bim.css`.
  5. API endpoints wired in `pc_worker/server_api_routes.py`.
  6. E2E tests in `tests/test_civil_surveying_e2e.py` and `tests/test_gathering_scans_suite.py`.
- **Success criteria**: All calculations genuine, unit and E2E tests pass, strict file limits and UX rules respected, local daemon and live VPS reloaded.
- **Interface contracts**: PROJECT.md / ORIGINAL_REQUEST.md / DISPATCH.md
- **Code layout**: .agents/teamwork/ holds metadata only.

## Key Decisions Made
- Used closed-form Priority-Flood morphological reconstruction for depression ponding volume: exact fill surface, saddle spill pour-point elevation, and precise polygonal boundary without heuristics.
- Integrated parametric templates (`roadway` with dual cross slopes, `trench` with batter side slopes, and `flat`) with numerical quadrature and linear zero-crossing interpolation.
- Added civil subtabs (`.civil-subtabs`) unifying Stationing (`樁號斷面`), Drainage & Ponding (`坡度窪蓄`), and GCP QA (`控制點`) within a shared side inspector panel.

## Artifact Index
- DISPATCH.md — assignment requirements and constraints
- BRIEFING.md — persistent situational awareness
- progress.md — liveness heartbeat and subtask tracking
- handoff.md — self-contained handoff report
- screenshots/m3_stationing_dark_theme.png — Stationing inspector dark theme screenshot
- screenshots/m3_stationing_light_theme.png — Stationing inspector light theme screenshot
- screenshots/m3_drainage_ponding_dark_theme.png — Drainage & ponding inspector dark theme screenshot
- screenshots/m3_drainage_ponding_light_theme.png — Drainage & ponding inspector light theme screenshot

## Change Tracker
- **Files modified**:
  - `pc_worker/surveying/contours_and_cad.py` (+325 lines, total 3,100 lines)
  - `pc_worker/surveying/dsm_and_volume.py` (+354 lines, total 3,020 lines)
  - `pc_worker/server_api_routes.py` (+130 lines, total 2,325 lines)
  - `web/src/09-construction-survey-and-bim.js` (+780 lines, total 1,650 lines)
  - `web/survey-bim.css` (+717 lines, total 1,257 lines)
  - `tests/test_civil_surveying_e2e.py` (+1295 lines, total 2,684 lines)
  - `tests/test_gathering_scans_suite.py` (+412 lines, total 2,969 lines)
  - `web/index.html` (bumped to v224)
  - `web/sw.js` (bumped to v224)
- **Build status**: PASS (102 tests in test suite pass, 7 tests in civil surveying e2e pass)
- **Pending issues**: none

## Quality Status
- **Build/test result**: PASS (102/102 test suite, 7/7 civil surveying E2E)
- **Lint status**: clean, zero emojis verified, strict 5,000-line ceiling verified
- **Tests added/modified**: `TestCenterlineStationingAndAverageEndArea` (4 tests), `TestSurfaceDrainagePondingAndCustomSlopeTiers` (3 tests), `test_36_milestone3_stationing_aea_and_drainage_ponding`
