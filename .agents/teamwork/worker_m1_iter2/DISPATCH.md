## 2026-10-31T04:21:46Z
You are teamwork_worker (M1 Remediation Worker).
Your working directory is: c:\Antigravity\GatheringScans\.agents\teamwork\worker_m1_iter2\
Original Request path: c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md
Project Scope path: c:\Antigravity\GatheringScans\.agents\teamwork\PROJECT.md
Gate Status path: c:\Antigravity\GatheringScans\.agents\teamwork\orchestrator\GATE_STATUS.md
Parent conversation ID: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

MANDATORY INSTRUCTIONS:
1. First read c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md completely.
2. Read and follow all rules in c:\Antigravity\GatheringScans\AGENTS.md.
3. Read the failure findings from the Reviewer and Challenger:
   - `c:\Antigravity\GatheringScans\.agents\teamwork\reviewer_m1_2\handoff.md`
   - `c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m1_1\handoff.md`
4. Exclusive Write Ownership:
   - `pc_worker/surveying/dsm_and_volume.py`
   - `pc_worker/optimizer_bridge.py`
   - `web/src/05-studio-civil-inspectors.js`
   - `web/src/09-construction-survey-and-bim.js` (NEW modular file)
   - `tests/test_gathering_scans_suite.py`
5. Implementation Requirements for Iteration 2:
   a. Collinear Determinant & Eigenvalue Safeguard in `pc_worker/surveying/dsm_and_volume.py`:
      Replace line 1114 with the scale-invariant eigenvalue safeguard from Challenger 1:
      ```python
      disc_plane = max(0.0, (suu - svv) ** 2 + 4.0 * suv * suv)
      lambda_min = (2.0 * det_plane) / (trace_plane + math.sqrt(disc_plane)) if trace_plane > 1e-6 else 0.0
      if det_plane <= 0.0 or lambda_min < 1e-6 or trace_plane < 1e-6:
          plane_a = 0.0
          plane_b = 0.0
          plane_c0 = p_mean_h
      ```
   b. Safe Float Parsing & Input Sanitization:
      Add a robust `safe_float(val, default=None)` helper function and use it for all float conversions:
      `geoid_offset_override`, `swell_factor`, `shrinkage_factor`, `density_t_m3`, `truck_volume_m3`, `truck_max_tonnes` in both `dsm_and_volume.py` and `optimizer_bridge.py`.
      Ensure empty strings `""`, whitespace `"   "`, `"undefined"`, or invalid tokens never throw unhandled `ValueError` 500 crashes.
   c. Volume Inspector UI & Results Schedule:
      In `web/src/05-studio-civil-inspectors.js` (and/or creating helper in `web/src/09-construction-survey-and-bim.js` to protect the 5,000-line ceiling on `05-studio-civil-inspectors.js` which is at 4,984 lines!):
      - Expose user inputs for `swell_factor` (e.g. Caterpillar ratio 0.80 / 1.25), `shrinkage_factor` (e.g. 0.10), `truck_volume_m3` (default 15.0), and `truck_max_tonnes` (default 20.0).
      - Include them in the payload to `/api/survey/volume`.
      - In `renderVolumeResultAnd3D`, display the mass conservation schedule: Bank Volume (BCM), Loose Volume (LCM), Compacted Volume (CCM), Conserved Mass (Cut/Fill in tonnes), Dump Truck Trips (Cut trips, Net trips, Limiting factor: volume vs weight), and Best-fit plane slope % and azimuth deg.
   d. Test Hermeticity in `tests/test_gathering_scans_suite.py`:
      In `test_30`, `test_31`, `test_32`, and `test_33`, ensure `quchi_20261005_merged` is explicitly upserted into `self.db` so tests never fail with `KeyError: 'Scan not found'` during background file manifest activity.
   e. Verify all tests pass:
      `python -m unittest tests/test_gathering_scans_suite.py`
      `python -m unittest tests/test_civil_surveying_e2e.py`
      `python c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m1_1\test_m1_empirical_adversarial.py`
      Verify strict 5,000-line ceiling on all files!
6. Deliverable:
   - Produce a detailed handoff report in `c:\Antigravity\GatheringScans\.agents\teamwork\worker_m1_iter2\handoff.md`.
   - Send completion message to parent (35a7b3c4-959a-4d2b-a4b5-21fb2891dea3).
