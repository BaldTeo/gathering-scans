# Handoff Report — Milestone 1 (M1): Least-Squares Best-Fit Reference Plane, Mass Conservation, Dump Truck Load Estimator & Geoid Synchronization

- **Agent**: `teamwork_worker` (M1 Implementation Worker)
- **Working Directory**: `c:\Antigravity\GatheringScans\.agents\teamwork\worker_m1\`
- **Milestone**: Milestone 1 (M1 — R2 Core Surveying & Earthwork Math)
- **Parent Conversation ID**: `35a7b3c4-959a-4d2b-a4b5-21fb2891dea3`
- **Date**: 2026-10-31T04:10:00Z

---

## 1. Observation

### 1.1. Missing Backend Implementation of Best-Fit Reference Plane
- In `pc_worker/surveying/dsm_and_volume.py` (lines 1126–1142 prior to modification):
  ```python
  if base_mode == "custom_plane":
      z_base = datum_z
  elif base_mode == "lowest_point":
      z_base = min((p[2] for p in perim_samples), default=datum_z)
  elif base_mode == "epoch_diff" and dsm_cmp is not None:
      z_base, _, _, _ = self._sample_dsm_elevation(dsm_cmp, gx, gy)
  else:
      # IDW perimeter interpolation fallback
  ```
  `best_fit_plane` was completely absent from the backend volume calculation, causing requests with `base_mode == "best_fit_plane"` to fall into IDW perimeter interpolation. The response lacked `{ a, b, c, slope_pct, azimuth_deg }`.

### 1.2. Physical Mass Conservation and Swell/Compaction Discrepancies
- In `pc_worker/config.py` (lines 95–105 prior to modification):
  `MATERIAL_CATALOG` only defined `density_t_m3` and `swell_factor` (Caterpillar load factor form, e.g. 0.80 for excavated soil). It lacked `shrinkage_factor` and `swell_pct`.
- In `pc_worker/surveying/dsm_and_volume.py` (lines 1182–1189 prior to modification):
  ```python
  effective_m3 = fill_vol if fill_vol >= cut_vol else cut_vol
  tonnage_loose = effective_m3 * density
  tonnage_bank = effective_m3 * density * swell
  ```
  This computed `effective_m3 = max(fill_vol, cut_vol)` instead of distinct cut and fill volumes, violated physical mass conservation ($M_{cut} = BCM_{cut} \times \rho_{bank} \equiv LCM_{cut} \times \rho_{loose}$), and lacked Compacted Volume ($CCM$) and Dump Truck haul trip calculations.

### 1.3. Frontend vs. Backend Vertical Geoid Offset Discrepancy
- In `pc_worker/optimizer_bridge.py` lines 61–82:
  `WGS84_UTM51N` defined `"h_offset_from_twvd": 17.20` and `WGS84_UTM50N` defined `"h_offset_from_twvd": 16.80`.
- In `web/src/06-studio-align-and-optimizer.js` lines 36–58 prior to modification:
  `WGS84_UTM51N` defined `hOff: 20.6` and `WGS84_UTM50N` defined `hOff: 19.8`.
  This produced a +3.40m and +3.00m elevation discrepancy between the frontend preview and backend deliverables. In addition, `openCoordinateSystemInspector()` lacked an input for user-specified geoid offsets $N$.

### 1.4. Verification Baseline
- Running `python -m unittest tests/test_gathering_scans_suite.py` on the clean tree executed 29 tests, all passing in 7.023s.
- Line counts of all target files were confirmed under 5,000 lines:
  - `pc_worker/config.py`: 230 lines
  - `pc_worker/surveying/dsm_and_volume.py`: 1,995 lines
  - `pc_worker/optimizer_bridge.py`: 4,165 lines
  - `web/src/06-studio-align-and-optimizer.js`: 3,926 lines
  - `tests/test_gathering_scans_suite.py`: 2,358 lines

---

## 2. Logic Chain

### 2.1. Least-Squares Centered Normal Equations
From Observation 1.1, fitting a plane $Z = a(E - \bar{E}) + b(N - \bar{N}) + c_0$ minimizes $\sum (a u_i + b v_i + c_0 - Z_i)^2$.
1. **Centroid Conditioning**:
   $\bar{E} = \frac{1}{n} \sum E_i$, $\bar{N} = \frac{1}{n} \sum N_i$, $\bar{Z} = \frac{1}{n} \sum Z_i$.
   Centered coordinates $u_i = E_i - \bar{E}$, $v_i = N_i - \bar{N}$, $w_i = Z_i - \bar{Z}$ eliminate cross-coupling with the intercept so $c_0 = \bar{Z}$.
2. **Cramer's Rule on 2D Normal Matrix**:
   $S_{uu} = \sum u_i^2, \quad S_{vv} = \sum v_i^2, \quad S_{uv} = \sum u_i v_i$
   $S_{uw} = \sum u_i w_i, \quad S_{vw} = \sum v_i w_i$
   $\text{det} = S_{uu} S_{vv} - S_{uv}^2, \quad \text{trace} = S_{uu} + S_{vv}$
3. **Singularity & Collinear Safeguards**:
   If $\text{det} < 10^{-9}$ or $\text{trace} < 10^{-6}$ (e.g. collinear points or $<3$ points), the plane falls back safely to horizontal $a = 0.0, b = 0.0, c_0 = \bar{Z}$, preventing division by zero or unbounded gradients.
4. **Plane Geometry Metrics**:
   - $s = \sqrt{a^2 + b^2}$, $\text{slope\_pct} = s \times 100\%$, $\text{slope\_deg} = \text{degrees}(\text{atan}(s))$.
   - Compass Azimuth: $\text{azimuth\_deg} = \text{degrees}(\text{atan2}(a, b)) \pmod{360^\circ}$ if $s > 10^{-7}$ else $0.0$.
5. **Grid Integration**:
   When $base\_mode == "best\_fit\_plane"$, $z_{base} = a(gx - \bar{E}) + b(gy - \bar{N}) + c_0$.

### 2.2. Earthwork Mass Conservation Physics
From Observation 1.2:
1. **Volumetric Conversions**:
   - Bank Volume: $BCM_{cut} = V_{cut}$, $BCM_{fill} = V_{fill}$, $BCM_{net} = V_{fill} - V_{cut}$.
   - Loose Volume: $LCM_{cut} = BCM_{cut} \times M_{swell}$ where $M_{swell} = 1 + S_{swell}$ (e.g. Caterpillar factor $0.80 \implies 1 / 0.80 = 1.25$).
   - Compacted Volume: $CCM_{fill} = BCM_{fill} \times (1 - S_{shrinkage})$ (e.g. $10\%$ shrinkage $\implies 0.90$).
2. **Strict Mass Conservation**:
   - $M_{cut} = BCM_{cut} \times \rho_{bank} = LCM_{cut} \times \rho_{loose}$ where $\rho_{loose} = \rho_{bank} / M_{swell}$.
   - $M_{fill} = BCM_{fill} \times \rho_{bank}$.
   - The response includes `cut_volume_bcm`, `fill_volume_bcm`, `net_volume_bcm`, `cut_volume_lcm`, `fill_volume_ccm`, `conserved_cut_mass_t`, and `conserved_fill_mass_t`.

### 2.3. Dual-Constraint Dump Truck Load Estimator
With user-configurable $C_{truck\_vol}$ (default 15.0 m³) and $W_{truck\_max}$ (default 20.0 tonnes):
1. **Trips Required**:
   $N_{vol} = \frac{LCM_{cut}}{C_{truck\_vol}}$, $N_{wt} = \frac{M_{cut}}{W_{truck\_max}}$.
   $\text{truck\_loads\_cut} = \lceil \max(N_{vol}, N_{wt}) \rceil$.
2. **Limiting Factor**:
   `"weight"` if $N_{wt} > N_{vol}$ else `"volume"`.
3. **Net Haul Direction**:
   `"export"` if $BCM_{cut} > BCM_{fill}$, `"import"` if $BCM_{fill} > BCM_{cut}$, else `"balanced"`.

### 2.4. Geoid Synchronization & User Override Architecture
From Observation 1.3:
1. **Frontend Synchronization**:
   In `web/src/06-studio-align-and-optimizer.js`:
   `WGS84_UTM51N`: updated `hOff` from $20.6$ to $17.20$.
   `WGS84_UTM50N`: updated `hOff` from $19.8$ to $16.80$.
2. **Inspector UI & Reset**:
   Added `numGeoidOffset` input and `btnResetGeoidOffset` in `openCoordinateSystemInspector()`, dynamically populated based on target CRS selection and editable by the surveyor.
3. **Backend Support**:
   - `pc_worker/optimizer_bridge.py`: Added `geoid_offset_override` parameter to `_transform_tileset_crs_in_place`, updated `generate_single_scan_optimization` and `execute_multi_scan_alignment_and_merge`, and exposed public `transform_scan_crs`.
   - `pc_worker/surveying/dsm_and_volume.py`: Added `geoid_offset_override` / `h_offset_from_twvd` support to `calculate_cut_fill_volume` and `compute_gcp_accuracy_qa`.

---

## 3. Caveats

1. **Boundary Ordering**: The best-fit plane algorithm operates on 3D boundary coordinates (`perim_samples` or `poly_twd`). Polygons should be simple closed loops; self-intersecting loops will be integrated via winding rules.
2. **Exclusive File Ownership**: Only the 5 files assigned to `worker_m1` were modified. No other files in the workspace were altered.

---

## 4. Conclusion

1. **Milestone 1 Implementation Complete**:
   - Least-squares best-fit reference plane with centered 2D Normal Equations, Cramer's Rule, slope %, azimuth, and collinear safeguards implemented in `pc_worker/surveying/dsm_and_volume.py`.
   - Earthwork Mass Conservation schedule ($BCM, LCM, CCM, M$) and Dump Truck Load Estimator (volume vs weight limiting factors, net haul direction) implemented in `pc_worker/surveying/dsm_and_volume.py` and `pc_worker/config.py`.
   - Vertical geoid offsets synchronized (UTM51N = 17.20m, UTM50N = 16.80m) in `web/src/06-studio-align-and-optimizer.js`.
   - User geoid override `numGeoidOffset` added to Studio CRS Inspector with reset action, preview updates, and backend support across `optimizer_bridge.py` and `dsm_and_volume.py`.
2. **Test Suite Expansion**:
   Added 4 new test methods (`test_30_best_fit_reference_plane`, `test_31_earthwork_mass_conservation`, `test_32_dump_truck_dual_constraint_estimator`, and `test_33_geoid_catalog_synchronization_and_overrides`) in `tests/test_gathering_scans_suite.py`.
   All 33 tests pass (`OK`).
3. **Modular Line Limit Compliance**:
   All modified files remain strictly under 5,000 lines:
   - `pc_worker/config.py`: 230 lines
   - `pc_worker/surveying/dsm_and_volume.py`: 2,164 lines
   - `pc_worker/optimizer_bridge.py`: 4,204 lines
   - `web/src/06-studio-align-and-optimizer.js`: 3,981 lines
   - `tests/test_gathering_scans_suite.py`: 2,541 lines

---

## 5. Verification Method

### 5.1. Automated Test Suite Execution
Execute the full test suite from the repository root:
```powershell
python -m unittest tests/test_gathering_scans_suite.py
```
**Expected Result**:
```
Ran 33 tests in ~14s
OK
```

### 5.2. Strict 5,000-Line Ceiling Test
Verify compliance with the line ceiling rule:
```powershell
python -c "
import unittest
from tests.test_gathering_scans_suite import GatheringScansTestSuite
suite = unittest.TestSuite()
suite.addTest(GatheringScansTestSuite('test_07_modular_architecture_strict_5000_line_ceiling'))
res = unittest.TextTestRunner().run(suite)
assert res.wasSuccessful()
"
```

### 5.3. Dedicated Mathematical Verification Script
Verify normal equations, collinear safeguards, mass conservation, and truck estimator:
```powershell
python c:\Antigravity\GatheringScans\.agents\teamwork\explorer_m1_1\test_m1_least_squares_math.py
```
**Expected Result**:
```
[PASS] Test 1: Pure horizontal plane
[PASS] Test 2: Known 2.5% Northward slope
[PASS] Test 3: Compound slope 3% East + 4% North (5% magnitude, 36.87 deg azimuth)
[PASS] Test 4: Collinear points fallback to mean horizontal plane
[PASS] Test 5: Fewer than 3 points fallback
[PASS] Test 6: Mass Conservation & Dump Truck Estimator (Loads: 100, Limiting: volume)
ALL MATHEMATICAL VERIFICATION TESTS PASSED SUCCESSFULLY!
```

### 5.4. Live SurveyingEngine Contract Verification
Verify API response payload structure on live scan data:
```powershell
python -c "
from pc_worker.surveying_engine import SurveyingEngine
from pc_worker.priority_queue import ScanQueueDB
from pc_worker.config import DB_PATH
db = ScanQueueDB(DB_PATH)
survey = SurveyingEngine(db)
res = survey.calculate_cut_fill_volume({
    'scan_id': 'quchi_20261005_merged',
    'base_mode': 'best_fit_plane',
    'material_type': 'excavated_soil',
    'density_t_m3': 1.45,
    'swell_factor': 0.80,
    'shrinkage_factor': 0.10,
    'truck_volume_m3': 15.0,
    'truck_max_tonnes': 20.0,
    'geoid_offset_override': 17.20,
    'polygon': [
        [304945.0, 2757078.0, 43.1],
        [304960.0, 2757078.0, 43.1],
        [304960.0, 2757090.0, 43.4],
        [304945.0, 2757090.0, 43.4],
    ],
})
assert res['status'] == 'ok'
assert 'best_fit_plane' in res
assert 'cut_volume_bcm' in res
assert 'cut_volume_lcm' in res
assert 'fill_volume_ccm' in res
assert 'conserved_cut_mass_t' in res
assert 'truck_loads_cut' in res
assert res['geoid_offset_override'] == 17.20
print('SurveyingEngine Live API Contract Verified Successfully!')
"
```

### 5.5. Invalidation Conditions
The implementation is invalidated if:
1. `res['best_fit_plane']` is missing or `slope_pct` / `azimuth_deg` are missing.
2. Collinear boundary points raise `ZeroDivisionError` instead of falling back to mean horizontal plane.
3. Conserved cut mass does not equal $BCM_{cut} \times \rho_{bank}$.
4. Loose volume is smaller than bank volume when swell multiplier $> 1.0$.
5. Any modified source file exceeds 5,000 lines.
6. `web/src/06-studio-align-and-optimizer.js` contains `20.6` or `19.8` for UTM51N / UTM50N geoid offsets.
