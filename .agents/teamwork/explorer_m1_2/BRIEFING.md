# BRIEFING — 2026-10-31T03:51:00Z

## Mission
Investigate and define exact equations, data structures, and implementation specifications for Milestone 1 (Earthwork Mass Conservation & Dump Truck Load Estimator) across backend and frontend.

## 🔒 My Identity
- Archetype: explorer
- Roles: investigation, synthesis
- Working directory: c:\Antigravity\GatheringScans\.agents\teamwork\explorer_m1_2\
- Original parent: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3
- Milestone: Milestone 1 (M1) — Earthwork Mass Conservation & Dump Truck Load Estimator

## 🔒 Key Constraints
- Read-only investigation — do NOT implement code in codebase directly
- Write only to my folder: c:\Antigravity\GatheringScans\.agents\teamwork\explorer_m1_2\
- Strict 5,000-line modular file ceiling
- Follow AGENTS.md guidelines (fast-forward, post-save, etc.)

## Current Parent
- Conversation ID: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3
- Updated: not yet

## Investigation State
- **Explored paths**:
  - `c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md`
  - `c:\Antigravity\GatheringScans\.agents\teamwork\PROJECT.md`
  - `pc_worker/config.py` (lines 95–105 `MATERIAL_CATALOG`)
  - `pc_worker/surveying/dsm_and_volume.py` (lines 950–1340)
  - `pc_worker/server_api_routes.py` (lines 920–932)
  - `pc_worker/server_cloud_and_tunnel.py` (lines 1770–1805)
  - `pc_worker/optimizer_bridge.py` (lines 45–85)
  - `web/src/01-core-state.js`
  - `web/src/04-studio-lasso-and-edits.js` (lines 3548–3920)
  - `web/src/05-studio-civil-inspectors.js` (lines 690–1180)
  - `web/src/06-studio-align-and-optimizer.js` (lines 20–60)
  - `tests/test_gathering_scans_suite.py` (lines 154–175, 347–368)

- **Key findings**:
  1. **Discrepancy in `base_mode == "best_fit_plane"`**:
     - Frontend UI has `best_fit_plane` and `04-studio-lasso-and-edits.js` implements `fitBestFitPlaneToPoints()`.
     - Backend `pc_worker/surveying/dsm_and_volume.py` lacks `best_fit_plane` handler, falling back to IDW perimeter interpolation.
  2. **Mass Conservation Violation in Current Volume Output**:
     - Current code does `tonnage_loose = effective_m3 * density` and `tonnage_bank = effective_m3 * density * swell` where `effective_m3 = max(fill_vol, cut_vol)`.
     - In real physics, mass is conserved ($M = BCM \times \rho_{bank} = LCM \times \rho_{loose}$). The current calculation implies two different masses for the same material.
  3. **Geoid Offset Inconsistency**:
     - Backend `optimizer_bridge.py` defines UTM51N as `17.20m` and UTM50N as `16.80m`.
     - Frontend `web/src/06-studio-align-and-optimizer.js` has `20.6m` for UTM51N and `19.8m` for UTM50N.
  4. **Missing Dump Truck Haulage Estimator**:
     - Neither backend nor frontend computes truck trips based on volume limit ($C_{truck\_vol}$) vs weight limit ($W_{truck\_max}$).
  5. **5,000-Line Ceiling Alert**:
     - `web/src/05-studio-civil-inspectors.js` has 4,984 lines (16 lines from ceiling).
     - New UI components must be modularly loaded via `web/src/09-construction-survey-and-bim.js` (which currently has 0 lines) to prevent test failure.

- **Unexplored areas**:
  - Downstream milestones M2–M6 (out of scope for explorer_m1_2).

## Key Decisions Made
- Derived comprehensive closed-form equations for BCM, LCM, CCM, conserved mass, dual-constraint truck trips, and centered 2x2 normal equations for least-squares plane fitting.
- Specified complete JSON schema contracts for `/api/survey/volume` and frontend integration plan.

## Artifact Index
- `c:\Antigravity\GatheringScans\.agents\teamwork\explorer_m1_2\handoff.md` — Final structured handoff report
