# BRIEFING — 2026-10-31T03:39:30Z

## Mission
Frontend Survey Explorer: Investigate frontend architecture, UI containers, surveying tools, line counts, and integration points for survey & earthwork capabilities (R1–R5).

## 🔒 My Identity
- Archetype: explorer
- Roles: Frontend Survey Explorer, Investigator, Synthesizer
- Working directory: c:\Antigravity\GatheringScans\.agents\teamwork\explorer_survey_1\
- Original parent: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3
- Milestone: Survey & Earthwork Upgrade Frontend Investigation

## 🔒 Key Constraints
- Read-only investigation — do NOT implement or modify source code files
- Strict 5,000-line modular file ceiling enforcement
- Keep existing minimalist UI intact, organize tools in collapsible/tabbed containers
- Follow Handoff Protocol and communicate via send_message

## Current Parent
- Conversation ID: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3
- Updated: 2026-10-31T03:39:30Z

## Investigation State
- **Explored paths**:
  - `web/index.html` (2,402 lines)
  - `web/src/01-core-state.js` (2,680 lines)
  - `web/src/02-map-and-timeline.js` (4,375 lines)
  - `web/src/03-studio-core.js` (4,996 lines — only 4 lines headroom!)
  - `web/src/04-studio-lasso-and-edits.js` (4,939 lines — 61 lines headroom)
  - `web/src/05-studio-civil-inspectors.js` (4,983 lines — only 17 lines headroom!)
  - `web/src/06-studio-align-and-optimizer.js` (3,926 lines)
  - `web/src/07-compare-and-queue.js` (2,235 lines)
  - `web/src/08-advanced-surveying-and-qa.js` (4,851 lines — 149 lines headroom)
  - `web/app.css` (4,852 lines — 148 lines headroom)
  - `web/sw.js` (Service Worker caching)
  - `tests/test_gathering_scans_suite.py` (29 tests passing)
  - `pc_worker/surveying/dsm_and_volume.py`, `pc_worker/optimizer_bridge.py`, `server.py`
- **Key findings**:
  1. Strict 5,000-line limit: `03-studio-core.js` (4,996), `05-studio-civil-inspectors.js` (4,983), `web/app.css` (4,852), and `08-advanced-surveying-and-qa.js` (4,851) cannot accept additions. A new module `web/src/09-construction-survey-and-bim.js` and stylesheet `web/survey-bim.css` are required.
  2. Non-intrusive UI container strategy: Add ONE dock icon `品管 / QA` (`btnDockCivilQa`) housing Flatness/Plumbness, Utility Tracer, and RTK Stakeout. Use tabbed sub-panels in Volume, Profile, AI Categorization, and a drawer in Compare View.
  3. Geoid discrepancy: WGS84_UTM51N has `20.6m` in frontend vs `17.20m` in backend; WGS84_UTM50N has `19.8m` vs `16.80m`. Must synchronize and add user override.
  4. Core surveying math additions identified: BCM/LCM/CCM/Mass/Trucks, true 3D GCP residuals + TBM calibration, 0K+000 stationing + AEA volume, ponding depression quantification ($V_{water}$ m³), open-trench utility 3D DXF, RTK stakeout in strict E N Z order, and Scan-to-BIM geometric primitive preview.
- **Unexplored areas**: None. Full investigation complete.

## Key Decisions Made
- Architecture plan recommends creating `web/src/09-construction-survey-and-bim.js` and `web/survey-bim.css` to safely obey the 5,000-line limit.
- Comprehensive handoff report authored at `c:\Antigravity\GatheringScans\.agents\teamwork\explorer_survey_1\handoff.md`.

## Artifact Index
- DISPATCH.md — incoming dispatch instructions
- BRIEFING.md — working memory and state
- progress.md — liveness heartbeat
- html_structure.txt — DOM structures extracted from web/index.html
- crs_search.txt — CRS and geoid occurrences in codebase
- handoff.md — structured 5-component handoff report
