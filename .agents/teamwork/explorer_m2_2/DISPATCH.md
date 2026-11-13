## 2026-10-31T05:28:01Z
You are explorer_m2_2 (M2 TBM Vertical Datum Calibration & Offset Persistence Explorer).
Your working directory is: c:\Antigravity\GatheringScans\.agents\teamwork\explorer_m2_2\
Your parent is: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3

MANDATORY: Read c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md and c:\Antigravity\GatheringScans\.agents\teamwork\PROJECT.md before doing anything else.

MISSION:
Investigate Milestone 2 (M2: Control Alignment & 3D GCP Calibration) 1-click TBM vertical datum calibration and offset persistence architecture.
Focus areas:
1. 1-Click TBM Vertical Datum Calibration Math:
   - Calculating the vertical datum bias compensation:
     - When a specific benchmark/TBM point is designated (`is_tbm=True` or `selected_tbm_id`), shift = H_gcp_tbm - H_scan_tbm (or sign convention: delta H = H_scan - H_gcp, shift = -delta H).
     - When no specific TBM is designated, compute the network-wide mean vertical bias: delta_H_mean = (1/N) * sum(H_scan_i - H_gcp_i), and offset = -delta_H_mean.
   - Recomputing residual errors after TBM calibration is applied:
     - New scan heights: H_scan_calibrated = H_scan + shift.
     - New vertical residuals: dH_calibrated = H_scan_calibrated - H_gcp = dH + shift.
     - New calibrated RMSE_H, RMSE_3D (which should drop significantly, zeroing out systematic vertical bias).
2. Vertical Datum Offset Persistence & Downstream Integration:
   - Where and how should the calibrated vertical datum offset be persisted?
     - Inspect `data/categorization_cache/`, scan DB records in `server.py`, `pc_worker/surveying/dsm_and_volume.py`, and `geoid_offset_override`.
     - Zero-destruction rule: NEVER destructively overwrite original photogrammetric point cloud (`.las`, `.ply`) or DSM raster files on disk. The offset must be applied as a runtime calibration shift or persisted metadata override.
   - Downstream consumption:
     - How do `/api/survey/volume`, `/api/survey/contours`, `/api/survey/profile`, `/api/survey/drainage`, and `/api/survey/surface-qa` consume the active calibrated vertical datum?
3. API Contract in `pc_worker/server_api_routes.py` and `pc_worker/surveying/dsm_and_volume.py`:
   - Inspect `/api/survey/gcp-qa` endpoint payload and response structure.
   - Support `apply_tbm_calibration: bool`, `selected_tbm_id: str`, and returning calibrated residuals, before-and-after RMSE, and persistence status.

CONSTRAINTS:
- You are a READ-ONLY explorer. DO NOT modify or create any source code, tests, or config files.
- Write your comprehensive findings to c:\Antigravity\GatheringScans\.agents\teamwork\explorer_m2_2\handoff.md.
- Follow the Handoff Protocol: Observation, Logic Chain, Caveats, Conclusion, Verification Method.
- Send a completion message via send_message to your parent when done.

## 2026-10-31T05:36:24Z
From: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3 (parent)
**Context**: Milestone 2 TBM Datum Calibration & Offset Persistence Investigation
**Content**: Status check. Explorer 1 and Explorer 3 have delivered their handoff reports (`explorer_m2_1/handoff.md` and `explorer_m2_3/handoff.md`). Please update your `progress.md` and deliver your handoff report on TBM datum calibration math and offset persistence mechanisms.
**Action**: Reply with your current status or completion report.
