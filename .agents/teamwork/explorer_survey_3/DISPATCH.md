## 2026-10-31T03:31:35Z
You are teamwork_explorer (Test & Dataset Explorer).
Your working directory is: c:\Antigravity\GatheringScans\.agents\teamwork\explorer_survey_3\
Original Request path: c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md
Parent conversation ID: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3

MANDATORY INSTRUCTIONS:
1. First read c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md completely.
2. Read and follow all rules in c:\Antigravity\GatheringScans\AGENTS.md.
3. Investigate the test suite, fixtures, and local scan datasets:
   - Check `tests/test_gathering_scans_suite.py` and any other test files in `tests/`.
   - Inspect the local scan datasets:
     * `edited_qihu_unified_merged_scan_4_scans__edited_372953`
     * `rosepark_20260918_merged`
     * `ntudorm_20260915_baseline`
     * `QuChi261016_Trees`
   - Understand the current test structure, how tests are executed (pytest or unittest), how test assertions are constructed, and how mock or live scan data is utilized.
   - Note the strict 5,000-line modular file ceiling test (`test_07_modular_architecture_strict_5000_line_ceiling`) and current line counts across all `.py`, `.js`, `.css`, and `.html` files.
   - Map out the exact verification requirements for:
     * Non-intrusive UI containers & project-agnostic settings (R1).
     * Least-squares cut/fill mass conservation (BCM, LCM, CCM, Mass, Truck loads) & Geoid catalog synchronization (R2).
     * 3D GCP residuals & vertical TBM datum correction (R2).
     * Stationing 0K+000 profile & Average-End-Area volume (R2).
     * Slope/drainage tiers & ponding depression volume (m³) (R2).
     * Surface flatness, levelness, wall plumbness deviation heatmaps & plumb tilt ratio (R3).
     * Open-trench utility tracer 3D metrics, CSV & 3D DXF export (R3).
     * RTK stakeout E N Z coordinate order export & printable sheet (R3).
     * Multi-Epoch Compare polygon-bounded ΔV volume takeoff (R3).
     * Scan-to-BIM classified geometric model generation, interactive 3D studio preview, and CAD/BIM export (R4).
   - Propose the E2E Testing architecture (TEST_INFRA.md) with 4-tier coverage (Feature Coverage, Boundaries, Cross-Feature, Real-World Workload).
4. Produce a detailed, structured handoff report in your working directory at `c:\Antigravity\GatheringScans\.agents\teamwork\explorer_survey_3\handoff.md` following the Handoff Protocol:
   - Observation: Existing test suite coverage, fixture definitions, dataset paths, line counts.
   - Logic Chain: Test plan design, test cases for R1-R5, testing methodology.
   - Caveats: Test execution time, data preservation constraints (must NOT delete or damage scans or comments).
   - Conclusion: Test gaps and recommended new test modules/methods.
   - Verification Method: Exact commands to run tests.
5. Send a completion message to the parent (35a7b3c4-959a-4d2b-a4b5-21fb2891dea3) summarizing findings and referencing `handoff.md`.
