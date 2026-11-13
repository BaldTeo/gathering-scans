## 2026-10-31T05:28:12Z
From: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3 (parent)
Mission:
Investigate Milestone 2 (M2: Control Alignment & 3D GCP Calibration) frontend integration, interactive 3D UI, and civil engineering QA export.
Focus areas:
1. Architectural modular line limits:
   - Check line counts of:
     - `web/src/08-advanced-surveying-and-qa.js` (currently 4,851 lines, only 149 lines headroom!)
     - `web/src/05-studio-civil-inspectors.js` (currently 4,987 lines, only 13 lines headroom!)
     - `web/src/09-construction-survey-and-bim.js` (currently 219 lines, ample headroom)
     - `web/survey-bim.css`
   - Formulate clear delegation strategy so that all new GCP residual tables, 3D residual vector visualization, 1-click TBM calibration trigger, and CSV/PDF export logic live in `web/src/09-construction-survey-and-bim.js` without inflating `05` or `08` beyond the 5,000-line ceiling.
2. UI & UX Design for GCP QA & TBM Calibration:
   - Inspect existing `renderGcpAccuracyReport` or GCP panel in `web/src/08-advanced-surveying-and-qa.js`.
   - Design interactive elements:
     - User entry/paste of GCP control points (PtID, Easting, Northing, Orthometric Height H, radio/checkbox to set as TBM reference).
     - Residual Error Table: PtID, E_gcp, N_gcp, H_gcp, E_scan, N_scan, H_scan, dE, dN, dH, d2D, d3D, status badge (e.g. green < 0.05m, yellow < 0.10m, red > 0.10m).
     - Overall Summary Card: Point count, RMSE_E, RMSE_N, RMSE_H, RMSE_2D, RMSE_3D, Mean Bias, ASPRS 95% Positional Accuracy.
     - 1-Click "Apply TBM Vertical Calibration" button with live preview of calibrated RMSE_H and prompt confirmation.
3. 3D Studio Visual Overlays:
   - How can 3D error vectors (arrows from scan point to GCP point or color-coded pins) be rendered in Three.js in Studio mode?
   - Ensure overlays follow the non-intrusive rule (hidden by default or toggleable in QA drawer).
4. Civil QA Export:
   - Export CSV: Standard format with all raw and residual fields.
   - Printable / PDF QA Report: Clean civil engineering inspection sheet format with site metadata, scan ID, date, RMSE summary, and residual table.

CONSTRAINTS:
- You are a READ-ONLY explorer. DO NOT modify or create any source code, tests, or config files.
- Write your comprehensive findings to c:\Antigravity\GatheringScans\.agents\teamwork\explorer_m2_3\handoff.md.
- Follow the Handoff Protocol: Observation, Logic Chain, Caveats, Conclusion, Verification Method.
- Send a completion message via send_message to your parent when done.
