## 2026-10-31T03:31:18Z
You are teamwork_explorer (Backend Survey Explorer).
Your working directory is: c:\Antigravity\GatheringScans\.agents\teamwork\explorer_survey_2\
Original Request path: c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md
Parent conversation ID: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3

MANDATORY INSTRUCTIONS:
1. First read c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md completely.
2. Read and follow all rules in c:\Antigravity\GatheringScans\AGENTS.md.
3. Investigate the backend surveying architecture, algorithms, and API endpoints in GatheringScans:
   - Check `server.py`, `pc_worker/server_api_routes.py`, `pc_worker/surveying_engine.py`, `pc_worker/surveying/dsm_and_volume.py`, `pc_worker/surveying/contours_and_cad.py`, `pc_worker/surveying/categorization_io.py`, `pc_worker/surveying/categorization_heuristics.py`, and other relevant backend modules.
   - Investigate existing math and API implementations for:
     * Cut/fill volume calculations: least-squares best-fit reference plane, bank volume (BCM m³), loose volume (LCM m³), compacted volume (CCM m³), conserved mass (tonnes), dump truck load estimator (R2).
     * Coordinate systems and vertical geoids: UTM51N / UTM50N geoid catalog and vertical offset calculations, user override support (R2).
     * GCP control target pairing (E, N, H), 3D residual computation (ΔE, ΔN, ΔH, RMSE), and 1-click vertical TBM datum bias calibration (R2).
     * Centerline stationing (0K+000), parametric cross-section slicing, Average-End-Area volume integration (R2).
     * Surface slope/drainage classification and ponding depression volume (m³), max depth, area quantification (R2).
     * Surface flatness, levelness, wall plumbness 3D computation against horizontal, plumb, and best-fit planes, tolerance check, plumb tilt ratio, max high/low (R3).
     * Open-trench utility 3D tracer: 3D length, invert/crown coordinates, gradient (% and 1:N), depth of cover, CSV & 3D DXF generation (R3).
     * RTK stakeout export endpoint: strictly E N Z order (PtID, E, N, Z, Code) and printable sheet (R3).
     * Multi-epoch compare: polygon-bounded ΔV volume takeoff (R3).
     * Scan-to-BIM: geometric primitive extraction/fitting (cuboids/bounding boxes, cylinders, planes, meshes) from classified scan objects, IFC/DXF/OBJ export format (R4).
   - Check file line counts and verify headroom against the strict 5,000-line ceiling per file (R5).
4. Produce a detailed, structured handoff report in your working directory at `c:\Antigravity\GatheringScans\.agents\teamwork\explorer_survey_2\handoff.md` following the Handoff Protocol:
   - Observation: Current backend architecture, existing endpoints, math modules, line counts.
   - Logic Chain: Algorithmic designs, proposed modules/endpoints, mathematical formulas (least-squares, Average-End-Area, plumb tilt, etc.).
   - Caveats: Performance on large scans, numerical stability, 5,000-line ceiling.
   - Conclusion: Concrete inventory of backend changes needed for R1–R5.
   - Verification Method: How to test endpoints and math functions with local scan datasets.
5. Send a completion message to the parent (35a7b3c4-959a-4d2b-a4b5-21fb2891dea3) summarizing findings and referencing `handoff.md`.
