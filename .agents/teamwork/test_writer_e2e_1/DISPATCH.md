## 2026-10-31T03:43:52Z
You are teamwork_test_writer (E2E Test Writer).
Your working directory is: c:\Antigravity\GatheringScans\.agents\teamwork\test_writer_e2e_1\
Original Request path: c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md
Test Architecture path: c:\Antigravity\GatheringScans\.agents\teamwork\TEST_INFRA.md
Parent conversation ID: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3

MANDATORY INSTRUCTIONS:
1. First read c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md completely.
2. Read and follow all rules in c:\Antigravity\GatheringScans\AGENTS.md.
3. Read c:\Antigravity\GatheringScans\.agents\teamwork\TEST_INFRA.md and inspect `tests/test_gathering_scans_suite.py`.
4. You are tasked with creating the dedicated, modular E2E civil surveying test suite file: `tests/test_civil_surveying_e2e.py`.
   - Ensure the file strictly adheres to the 5,000-line ceiling.
   - Implement comprehensive Tier 1 (Feature) and Tier 2 (Boundary) unit and regression tests for Milestone 1:
     * Test Least-Squares Best-Fit Reference Plane: analytical planar surface $Z = 100.0 + 0.05 \Delta E - 0.02 \Delta N$, verify recovered slope %, azimuth, and volume integration.
     * Test Mass Conservation Schedule: verify $M_{bank} \equiv M_{loose} \equiv M_{compact}$ identity holds, check swell/shrinkage transformations.
     * Test Dump Truck Load Estimator: verify volume-limited vs weight-limited trips, net import/export calculations with user parameters.
     * Test Geoid Catalog Synchronization: verify UTM51N / UTM50N catalog matches between frontend and backend, test user override `geoid_offset_override`.
     * Test collinear boundary safeguards and non-invertible matrix handling.
   - Run the tests using `python -m unittest tests/test_civil_surveying_e2e.py` (mocking or using analytical fixtures so it can be verified).
   - Verify `python -m unittest tests/test_gathering_scans_suite.py` continues to pass with zero regressions.
5. Write a structured handoff report at `c:\Antigravity\GatheringScans\.agents\teamwork\test_writer_e2e_1\handoff.md` following the Handoff Protocol.
6. Send a completion message to the parent (35a7b3c4-959a-4d2b-a4b5-21fb2891dea3) summarizing test coverage and execution output.
