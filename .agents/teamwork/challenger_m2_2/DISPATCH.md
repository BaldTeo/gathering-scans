## 2026-10-31T06:15:16Z
[Message] timestamp=2026-10-31T06:15:16Z sender=35a7b3c4-959a-4d2b-a4b5-21fb2891dea3 priority=MESSAGE_PRIORITY_HIGH content=You are challenger_m2_2 (M2 Live API, Adversarial Stress & Downstream Propagation Challenger).
Your working directory is: c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m2_2\
Your parent is: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3

MANDATORY: Read c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md and c:\Antigravity\GatheringScans\.agents\teamwork\PROJECT.md before doing anything else.

INPUTS:
- Worker Handoff: c:\Antigravity\GatheringScans\.agents\teamwork\worker_m2\handoff.md
- Local live HTTP server: `http://127.0.0.1:8095`
- Test suites: `tests/test_civil_surveying_e2e.py` and `tests/test_gathering_scans_suite.py`

MISSION:
Act as an adversarial API & integration critic. Write a dedicated standalone test harness (e.g. `c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m2_2\test_m2_live_adversarial.py`) and empirically stress-test the live HTTP server and downstream integration:
1. Live HTTP API Endpoint Stress (`http://127.0.0.1:8095/api/survey/gcp-qa`):
   - Send requests with empty payloads, malformed JSON, hostile point lists (empty strings, whitespace, non-numeric tokens, missing keys).
   - Verify HTTP 200 responses with clean structured error messages or filtered point counts, and **zero HTTP 500 crashes**.
   - Send requests with mixed Check Points (only E, N, H) and Paired Targets (with mesh_e, mesh_n, mesh_h).
2. Live TBM Calibration Application & Downstream Invariance:
   - Perform `/api/survey/gcp-qa` with `apply_tbm_calibration: true`.
   - Verify that calibration status is returned as `tbm_applied: true` with non-zero `tbm_shift_m`.
   - Call `/api/survey/volume` for the calibrated scan: verify that the computed cut/fill volume respects the new vertical datum.
   - Re-run `/api/survey/gcp-qa`: verify that calibrated vertical residuals reflect the applied shift.
3. Full Suite Regression:
   - Run `python -m unittest tests/test_civil_surveying_e2e.py`
   - Run `python -m unittest tests/test_gathering_scans_suite.py`
   - Verify 100% of tests pass without flakiness.

CRITERIA:
- Explicit verdict: APPROVE or REQUEST_CHANGES in handoff.md.
- Write your full report to c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m2_2\handoff.md following the Handoff Protocol.
- Send a completion message via send_message to your parent when done.
