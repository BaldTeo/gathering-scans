# Forensic Audit Report — Milestone 1 (M1)

**Work Product**: Milestone 1 Implementation (`pc_worker/surveying/dsm_and_volume.py`, `pc_worker/config.py`, `pc_worker/optimizer_bridge.py`, `web/src/06-studio-align-and-optimizer.js`, `tests/test_gathering_scans_suite.py`)  
**Profile**: General Project (Development Integrity Mode per `ORIGINAL_REQUEST.md`)  
**Auditor**: `teamwork_auditor` (Milestone 1 Forensic Integrity Auditor)  
**Parent Conversation ID**: `35a7b3c4-959a-4d2b-a4b5-21fb2891dea3`  
**Date**: 2026-10-31T04:16:00Z  
**Verdict**: **CLEAN**

---

### Phase Results
- **Hardcoded Test Results Detection**: PASS — Zero hardcoded responses or scan-specific conditionals detected in `dsm_and_volume.py` or `optimizer_bridge.py`.
- **Facade Implementation Detection**: PASS — Real mathematical OLS plane solver with centered 2D Normal Equations, Cramer's Rule, and discrete grid elevation integration.
- **Fabricated Verification Outputs**: PASS — Zero pre-populated test artifacts; all unit and e2e test outputs executed and verified live.
- **Mass Conservation Genuineness**: PASS — Physical mass invariance identity ($M_{cut} = BCM_{cut} \times \rho_{bank} \equiv LCM_{cut} \times \rho_{loose}$) and dual-constraint truck estimator dynamic logic verified.
- **Data Preservation Check**: PASS — All 43 scan directories in `C:\GatheringScans\` and all database tables/rows verified completely intact.
- **Strict 5,000-Line Modular Ceiling**: PASS — All source and test files verified strictly under 5,000 lines (maximum source file is 4,204 lines).
- **Test Suite Execution**: PASS — 33/33 tests passed in `tests/test_gathering_scans_suite.py` and 22/22 tests passed in `tests/test_civil_surveying_e2e.py` (total 55/55 passed).

---

## 1. Observation

### 1.1. Static Analysis & Code Inspection
- In `pc_worker/surveying/dsm_and_volume.py` (lines 1096–1138):
  ```python
  # Least-Squares Best-Fit Reference Plane via 2D Normal Equations with Centroid Conditioning
  plane_pts = perim_samples if len(perim_samples) >= 3 else poly_twd
  n_plane = len(plane_pts)
  if n_plane >= 3:
      p_mean_e = sum(p[0] for p in plane_pts) / n_plane
      p_mean_n = sum(p[1] for p in plane_pts) / n_plane
      p_mean_h = sum(p[2] for p in plane_pts) / n_plane

      suu = sum((p[0] - p_mean_e) ** 2 for p in plane_pts)
      svv = sum((p[1] - p_mean_n) ** 2 for p in plane_pts)
      suv = sum((p[0] - p_mean_e) * (p[1] - p_mean_n) for p in plane_pts)
      suw = sum((p[0] - p_mean_e) * (p[2] - p_mean_h) for p in plane_pts)
      svw = sum((p[1] - p_mean_n) * (p[2] - p_mean_h) for p in plane_pts)

      det_plane = suu * svv - suv * suv
      trace_plane = suu + svv

      # Safeguard: singularity / collinear points fallback to horizontal mean plane
      if abs(det_plane) < 1e-9 or trace_plane < 1e-6:
          plane_a = 0.0
          plane_b = 0.0
          plane_c0 = p_mean_h
      else:
          plane_a = (suw * svv - svw * suv) / det_plane
          plane_b = (svw * suu - suw * suv) / det_plane
          plane_c0 = p_mean_h
  ```
  The plane equation parameters `a`, `b`, and `c0` are derived analytically without magic numbers or canned return structures.

- In `pc_worker/surveying/dsm_and_volume.py` (lines 1176–1177):
  ```python
  elif base_mode == "best_fit_plane":
      z_base = plane_a * (gx - p_mean_e) + plane_b * (gy - p_mean_n) + plane_c0
  ```
  Cell-by-cell numerical volume integration directly evaluates the fitted reference plane against true DSM surface samples $z_{surf}$.

- In `pc_worker/surveying/dsm_and_volume.py` (lines 1265–1284):
  ```python
  cut_vol_bcm = round(cut_vol, 2)
  fill_vol_bcm = round(fill_vol, 2)
  net_vol_bcm = round(net_vol, 2)
  cut_vol_lcm = round(cut_vol * swell_mult, 2)
  fill_vol_ccm = round(fill_vol * compaction_mult, 2)
  conserved_cut_mass = round(cut_vol * density, 2)
  conserved_fill_mass = round(fill_vol * density, 2)

  # Dump Truck Load Estimator (Volume-limited vs Weight-limited)
  truck_vol = float(payload.get("truck_volume_m3", 15.0) or 15.0)
  truck_max_wt = float(payload.get("truck_max_tonnes", 20.0) or 20.0)
  trips_vol = cut_vol_lcm / max(truck_vol, 0.1)
  trips_wt = conserved_cut_mass / max(truck_max_wt, 0.1)
  truck_loads_cut = int(math.ceil(max(trips_vol, trips_wt))) if cut_vol > 0 else 0
  truck_limiting_factor = "weight" if trips_wt > trips_vol else "volume"
  ```
  Earthwork conversions strictly respect mass conservation. Haul trips evaluate both volumetric capacity and structural axle load constraints dynamically.

- In `web/src/06-studio-align-and-optimizer.js` (lines 45, 56, 1486–1500):
  `WGS84_UTM51N` is synchronized to `hOff: 17.20` and `WGS84_UTM50N` to `hOff: 16.80`. The UI features `numGeoidOffset` with reset button `btnResetGeoidOffset`, allowing user overrides.

### 1.2. Data Preservation Inspection
- Inspection of `C:\GatheringScans`:
  All 43 scan and site directories are present with unaltered timestamps and payloads.
- Inspection of `data/gathering_scans.db`:
  Table query confirmed:
  - `scans`: 27 rows
  - `scan_comments`: 15 rows
  - `share_links`: 17 rows
  - `user_profiles`: 20 rows
  - `trashed_scans`: 14 rows
  - `share_access_sessions`: 111 rows
  Zero records were deleted or wiped.

### 1.3. Line Count Audit
- `python -m unittest tests.test_gathering_scans_suite.GatheringScansTestSuite.test_07_modular_architecture_strict_5000_line_ceiling` passed cleanly.
- Direct repository audit confirmed 0 files exceeding 5,000 lines. The target Milestone 1 files:
  - `pc_worker/config.py`: 230 lines
  - `pc_worker/surveying/dsm_and_volume.py`: 2,164 lines
  - `pc_worker/optimizer_bridge.py`: 4,204 lines
  - `web/src/06-studio-align-and-optimizer.js`: 3,981 lines
  - `tests/test_gathering_scans_suite.py`: 2,541 lines
  - `tests/test_civil_surveying_e2e.py`: 1,036 lines

### 1.4. Test Suite Execution Output
- `python -m unittest tests/test_gathering_scans_suite.py`:
  `Ran 33 tests in 11.755s — OK`
- `python -m unittest -v tests/test_civil_surveying_e2e.py`:
  `Ran 22 tests in 0.293s — OK`
- Combined total: 55 tests executed, 55 passed, 0 failures, 0 errors.

---

## 2. Logic Chain

1. **Analytical Genuineness vs. Hardcoded Values**:
   - From Observation 1.1, the least-squares best-fit plane solves the 2D Normal Equations $\mathbf{A}^T\mathbf{A}\mathbf{x} = \mathbf{A}^T\mathbf{b}$ in centroid-reduced coordinates $(u_i, v_i, w_i)$.
   - The cell-by-cell DSM elevation integration evaluates $z_{base} = a(gx - \bar{E}) + b(gy - \bar{N}) + c_0$ over all active cells inside the polygon boundary.
   - Grep searches for scan IDs (`quchi_20261005_merged`) or test boundary strings (`Best-Fit Plane Zone`) in `pc_worker/` confirmed zero hardcoded branch logic or test-specific shortcuts.
   - Therefore, the calculation is authentic and project-agnostic.

2. **Physical Mass Conservation**:
   - From Observation 1.1, Bank Cut Volume $BCM_{cut}$ and Loose Cut Volume $LCM_{cut} = BCM_{cut} \times M_{swell}$ satisfy $M_{cut} = BCM_{cut} \times \rho_{bank} \equiv LCM_{cut} \times \rho_{loose}$ where $\rho_{loose} = \rho_{bank} / M_{swell}$.
   - The truck load estimator computes $N_{vol} = LCM / C_{truck\_vol}$ and $N_{wt} = M_{cut} / W_{truck\_max}$, governing trips via $\lceil \max(N_{vol}, N_{wt}) \rceil$.
   - Tested across both volume-limited (light density 1.1 t/m³) and weight-limited (dense rock 2.5 t/m³) scenarios, the limiting factor switches dynamically.
   - Therefore, mass conservation and haul logistics are physically genuine.

3. **Data Integrity**:
   - From Observation 1.2, all 43 scan directories in `C:\GatheringScans\` and all SQLite records in `gathering_scans.db` (including comments, share links, and user profiles) remain intact.
   - Therefore, the ground-truth constraint from `ORIGINAL_REQUEST.md` ("The team must NOT: delete or damage any existing data including scans and comments") is fully satisfied.

4. **Modular Ceiling Compliance**:
   - From Observation 1.3, every file in the repository remains strictly under the 5,000-line ceiling, with the largest file at 4,204 lines.
   - Therefore, architectural ceiling rules are strictly maintained.

---

## 3. Caveats

- Milestone 1 encompasses core earthwork mathematics, volume integration, mass conservation, truck load estimation, and vertical geoid catalog synchronization. Downstream features (True 3D GCP RMSE residuals, TBM datum shift, 0K+000 stationing, surface flatness heatmaps, and Scan-to-BIM primitives) belong to Milestones 2 through 5.
- No other caveats.

---

## 4. Conclusion

The Milestone 1 work product satisfies all forensic integrity criteria without exception. There are no hardcoded test outputs, no facade stubs, no data destruction, and no modular ceiling violations. All 55 automated tests pass with authentic numerical results.

**Hard Binary Verdict**: **CLEAN**

---

## 5. Verification Method

To independently verify this audit:

1. **Run Full Test Suites**:
   ```powershell
   python -m unittest tests/test_gathering_scans_suite.py
   python -m unittest tests/test_civil_surveying_e2e.py
   ```
   *Expected Result*: 33/33 tests pass in `test_gathering_scans_suite.py`, 22/22 tests pass in `test_civil_surveying_e2e.py`.

2. **Verify 5,000-Line Ceiling**:
   ```powershell
   python -c "
   import os
   for root, _, files in os.walk('.'):
       if any(x in root for x in ['.git', '.agents', 'node_modules']): continue
       for f in files:
           if f.endswith(('.py', '.js', '.css', '.html')):
               p = os.path.join(root, f)
               with open(p, 'r', encoding='utf-8', errors='ignore') as fp:
                   cnt = sum(1 for _ in fp)
                   assert cnt < 5000, f'{p} exceeds 5000 lines: {cnt}'
   print('ALL FILES COMPLIANT (<5000 lines)')
   "
   ```

3. **Verify Data Preservation**:
   ```powershell
   python -c "
   import sqlite3
   conn = sqlite3.connect('data/gathering_scans.db')
   scans = conn.execute('SELECT count(*) FROM scans').fetchone()[0]
   comments = conn.execute('SELECT count(*) FROM scan_comments').fetchone()[0]
   assert scans >= 27 and comments >= 15
   print(f'DB Intact: {scans} scans, {comments} comments')
   "
   ```

4. **Invalidation Conditions**:
   The verdict is invalidated if:
   - Any test fails or raises unhandled exceptions on collinear perimeters.
   - `quchi_20261005_merged` or any other scan directory in `C:\GatheringScans\` is missing.
   - Any source file reaches or exceeds 5,000 lines.
   - Mass is not conserved ($BCM_{cut} \times \rho_{bank} \ne M_{cut}$).
