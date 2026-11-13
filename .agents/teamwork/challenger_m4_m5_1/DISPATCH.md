# Challenger M4/M5 1: Numerical Stress & Coordinate Inversion Challenger
Working Directory: c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m4_m5_1\

## 2026-10-31T07:48:15Z
Sender: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3
Content:
You are challenger_m4_m5_1, an adversarial code-executing verification challenger for Milestone 4 and Milestone 5 (Construction QA & RTK Stakeout).

Working Directory: c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m4_m5_1\
Parent Conv ID: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3

MANDATORY FIRST STEPS:
1. Read c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md.
2. Read c:\Antigravity\GatheringScans\.agents\teamwork\worker_track_b_m4_m5\handoff.md.

YOUR ADVERSARIAL CHALLENGES:
1. Coordinate Inversion & Field Safety Stress Test:
   - Verify that all RTK stakeout exports (CSV, DXF, HTML field sheet) format coordinates strictly in Easting, Northing, Elevation (E, N, Z) order.
   - Assert that Easting is NOT swapped with Northing (N, E, Z is a failure).
2. Numerical Stress & Degenerate Point Cloud Tests:
   - Test surface flatness plane fitting with:
     - Perfectly flat slab (deviation = 0.0 mm, Pass Rate = 100%, F_F > 100).
     - Collinear line of points (assert safeguard prevents singular matrix crash).
     - Spherical or random noise points.
   - Test plumbness tilt ratio with perfectly vertical wall (tilt = 0.0 mm/m) vs tilted wall (known angle).
   - Test trench utility tracer with zero slope, reverse slope, and zero diameter.
   - Test multi-epoch compare volume with identical DSMs (net volume strictly 0.0 m³).
3. Code Execution:
   - Run tests: python -m unittest tests.test_civil_surveying_e2e.TestSurfaceFlatnessAndPlumbness tests.test_civil_surveying_e2e.TestOpenTrenchUtilityTracer tests.test_civil_surveying_e2e.TestMultiEpochCompareVolumeTakeoff tests.test_civil_surveying_e2e.TestRtkStakeoutSheetExport
4. Deliverable:
   - Write your complete handoff report to c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m4_m5_1\handoff.md with explicit verdict: APPROVE or REQUEST_CHANGES.
   - Call send_message to parent (35a7b3c4-959a-4d2b-a4b5-21fb2891dea3) with your verdict and handoff path.
