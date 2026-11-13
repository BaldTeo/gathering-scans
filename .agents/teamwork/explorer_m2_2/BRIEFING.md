# BRIEFING — 2026-10-31T05:37:00Z

## Mission
Investigate Milestone 2 (M2: Control Alignment & 3D GCP Calibration) 1-click TBM vertical datum calibration and offset persistence architecture.

## 🔒 My Identity
- Archetype: explorer
- Roles: investigation, synthesis
- Working directory: c:\Antigravity\GatheringScans\.agents\teamwork\explorer_m2_2\
- Original parent: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3
- Milestone: M2

## 🔒 Key Constraints
- Read-only investigation — do NOT implement
- Zero-destruction rule: NEVER destructively overwrite original photogrammetric point cloud (.las, .ply) or DSM raster files on disk
- All files strictly under 5,000-line modular ceiling
- Project-agnostic settings: no hardcoded values

## Current Parent
- Conversation ID: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3
- Updated: 2026-10-31T05:37:00Z

## Investigation State
- **Explored paths**:
  - `pc_worker/surveying/dsm_and_volume.py`: `compute_gcp_accuracy_qa`, `calculate_cut_fill_volume`, `compute_drainage_and_slope`, `_load_or_build_scan_dsm`, `_sample_dsm_elevation`
  - `pc_worker/surveying/contours_and_cad.py`: `generate_civil3d_contours`, `compute_cross_section_profile`
  - `pc_worker/priority_queue.py`: `scans` schema, `extra_json`, `_row_to_dict`, `set_scan_home_view`
  - `pc_worker/server_api_routes.py`: route bindings for `/api/survey/gcp-qa`
  - `web/src/08-advanced-surveying-and-qa.js`: legacy GCP QA UI
  - `web/src/09-construction-survey-and-bim.js`: new module target for M2 UI delegation
  - `tests/test_gathering_scans_suite.py` and `tests/test_civil_surveying_e2e.py`
  - Peer reports: `explorer_m2_1/handoff.md` and `explorer_m2_3/handoff.md`
- **Key findings**:
  - TBM vertical datum bias compensation math fully derived for designated TBM ($shift = -\Delta H_{tbm}$) and network-wide mean ($shift = -\overline{\Delta H}$).
  - Post-calibration residuals ($H_{cal} = H_{scan} + shift, \Delta H_{cal} = \Delta H + shift$) and calibrated RMSE ($RMSE_{H, cal}^2 = RMSE_{H, raw}^2 - \overline{\Delta H}^2$) analytically proven.
  - Zero-destructive persistence architecture: store in SQLite `scans.extra_json` and mirror in `proj_dir/scan_meta.json`. Original raw `.las`, `.ply`, `.obj`, `.npz` files remain 100% pristine.
  - Downstream consumption pattern via `_resolve_vertical_datum_shift` across Volume, Contours, Profile, Drainage, and Surface QA.
  - Full API request/response contract defined with backward compatibility for existing tests.
- **Unexplored areas**: None. Investigation complete.

## Key Decisions Made
- Confirmed zero-destructive persistence using SQLite `extra_json` + `scan_meta.json`.
- Standardized sign convention: $\Delta H = H_{scan} - H_{gcp}$, shift = $-\Delta H$.
- Synthesized findings with `explorer_m2_1` (3D math) and `explorer_m2_3` (UI delegation in `09-construction-survey-and-bim.js`).

## Artifact Index
- DISPATCH.md — Initial and status dispatch messages
- BRIEFING.md — Persistent situational awareness
- progress.md — Heartbeat progress
- handoff.md — Comprehensive M2 TBM calibration and persistence handoff report
