## 2026-10-31T04:58:46Z
You are `worker_m1_iter3` (M1 Remediation Worker Iteration 3).
Working directory: `c:\Antigravity\GatheringScans\.agents\teamwork\worker_m1_iter3\`
Your parent is `35a7b3c4-959a-4d2b-a4b5-21fb2891dea3`.

Read:
1. `c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md`
2. `c:\Antigravity\GatheringScans\PROJECT.md`
3. `c:\Antigravity\GatheringScans\.agents\teamwork\reviewer_m1_iter2_2\handoff.md`

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Task:
Remediate the compound coordinate and dictionary parsing findings from Reviewer 2 to eliminate 500 crashes:
1. In `pc_worker/surveying/dsm_and_volume.py`:
   - `compute_gcp_accuracy_qa` (around lines 1821–1842): Replace bare `float()` on `e`, `n`, `h_gcp`, `h_scan` with `safe_float()`. Gracefully skip points where `e` or `n` cannot be parsed.
   - `calculate_cut_fill_volume` (around lines 1060–1070): Replace bare `float()` on polygon vertices (`x`, `z`, `e`, `n`) with `safe_float()`. Filter out invalid points; if fewer than 3 valid points remain, return error response safely.
   - `_normalize_mask_polygon_twd97` (around lines 1679–1695): Use `safe_float()` for `x`, `y`, `z`, `e`, `n`, `h`.
   - `compute_drainage_and_slope` (around line 2022): Sanitize `payload.get("grid_size")` with `safe_float()`.
2. In `pc_worker/surveying/contours_and_cad.py`:
   - Import or define `safe_float(val, default=None)` helper in `contours_and_cad.py`.
   - `generate_elevation_contours` (around lines 332–333): Use `safe_float(payload.get("minor_interval_m"), 0.5)` and `safe_float(payload.get("major_interval_m"), ...)`.
   - `compute_cross_section_profile` (around lines 1347–1355): Use `safe_float()` when parsing `start_point` and `end_point`.
   - `inspect_rtk_camera_photos` (around lines 2473–2475, 2536): Use `safe_float()` for `x`, `y`, `z`, and `max_radius_m`.
3. In `pc_worker/optimizer_bridge.py`:
   - `run_generate_scan_action` (around lines 3183–3184): Use `safe_float(crop_keep.get("min_elev"), -9999.0)` and `safe_float(crop_keep.get("max_elev"), 9999.0)`.
   - Around lines 1781, 3155, 3177: Use `safe_float()` when parsing polygon vertices and reference centers.
4. In `tests/test_gathering_scans_suite.py`:
   - Add unit tests verifying that passing empty strings, whitespace, and invalid non-numeric tokens to `/api/survey/gcp-qa`, `/api/survey/volume`, `/api/survey/contours`, `/api/survey/profile`, and `/api/optimizer/generate-scan` return clean error/success responses without 500 `ValueError` crashes.
5. Strict 5,000-Line Modular Limit:
   - Verify that all modified files stay strictly under 5,000 lines (`test_07_modular_architecture_strict_5000_line_ceiling`).
6. Run full verification suite:
   `python -m unittest tests/test_gathering_scans_suite.py`
   `python -m unittest tests/test_civil_surveying_e2e.py`
   `python c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m1_1\test_m1_empirical_adversarial.py -v`
7. Git & Deployment:
   - Make local git commit. Attempt `git push origin main` (if push hits GitHub web push rate limit, do NOT fail or let that block the milestone; note in handoff).
   - Restart local Windows PC daemon (`powershell -ExecutionPolicy Bypass -File "C:\Antigravity\GatheringScans\ensure_daemon_running.ps1"`) and verify `http://127.0.0.1:8095/api/status` is 200 OK.
   - For VPS: upload files over SSH or note direct container sync.
8. Write `handoff.md` in your working directory and notify parent with `send_message`.
