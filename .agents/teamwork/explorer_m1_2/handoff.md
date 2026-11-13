# Milestone 1 (M1) Handoff Report: Earthwork Mass Conservation & Dump Truck Load Estimator

## 1. Observation

### 1.1 Volume Engine & Base Mode Discrepancy
- **Backend**: `pc_worker/surveying/dsm_and_volume.py` (lines 1126–1142):
  ```python
  if base_mode == "custom_plane":
      z_base = datum_z
  elif base_mode == "lowest_point":
      z_base = min((p[2] for p in perim_samples), default=datum_z)
  elif base_mode == "epoch_diff" and dsm_cmp is not None:
      z_base, _, _, _ = self._sample_dsm_elevation(dsm_cmp, gx, gy)
  else:
      # Inverse-distance weighted interpolation of dense perimeter DSM elevations
      w_sum = 0.0
      z_interp = 0.0
      for vx, vy, vz in perim_samples:
          d2 = (gx - vx) ** 2 + (gy - vy) ** 2 + 0.04
          w = 1.0 / d2
          w_sum += w
          z_interp += w * vz
      z_base = z_interp / max(w_sum, 1e-9)
  ```
  `best_fit_plane` is completely missing from the backend `if/elif` branches. When a user or frontend requests `base_mode == "best_fit_plane"`, execution drops into the fallback `else` branch (IDW perimeter interpolation).
- **Frontend**: `web/src/05-studio-civil-inspectors.js` (lines 728–735) exposes `best_fit_plane` as an explicit option:
  ```html
  <select class="gs-select" id="volBaseMode">
    <option value="triangulated_boundary">1. 獨立土石堆周界擬合面</option>
    <option value="lowest_point">2. 周界最低點水平基準面 (Lowest Perimeter Point)</option>
    <option value="best_fit_plane">3. 最小平方法最佳擬合傾斜面 (Best-Fit Plane)</option>
    <option value="custom_plane">4. 指定設計高程基準面 Z₀ (TWVD2001)</option>
    <option value="epoch_diff">5. 跨期掃描進度挖填差額</option>
  </select>
  ```
- **Client Volume Calculation**: `web/src/04-studio-lasso-and-edits.js` (lines 3548–3580 and 3821–3822) implements a client-side least-squares normal equations fitter `fitBestFitPlaneToPoints(samples)`:
  ```javascript
  const a = (sxy * szz - szy * sxz) / det;
  const b = (szy * sxx - sxy * sxz) / det;
  const c = my - a * mx - b * mz;
  return { a, b, c };
  ```
  However, this plane equation is not evaluated or persisted consistently on the backend DSM server.

### 1.2 Material Catalog & Mass Conservation Physics
- **Material Catalog**: `pc_worker/config.py` (lines 95–105):
  ```python
  MATERIAL_CATALOG = {
      "crushed_stone": {"name": "Crushed Stone / 碎石級配", "density_t_m3": 1.65, "swell_factor": 0.88},
      "river_gravel": {"name": "River Gravel & Cobble / 河床卵礫石", "density_t_m3": 1.78, "swell_factor": 0.90},
      "sand_dry": {"name": "Dry Construction Sand / 建築乾砂", "density_t_m3": 1.55, "swell_factor": 0.92},
      "sand_wet": {"name": "Wet River Sand / 河砂(含水)", "density_t_m3": 1.92, "swell_factor": 0.94},
      "excavated_soil": {"name": "Excavated Earth / 一般開挖土方", "density_t_m3": 1.45, "swell_factor": 0.80},
      "clay_compacted": {"name": "Compacted Clay / 壓實黏土", "density_t_m3": 1.85, "swell_factor": 1.00},
      "concrete_rubble": {"name": "Concrete Rubble / 混凝土廢料", "density_t_m3": 1.50, "swell_factor": 0.78},
      "asphalt_milling": {"name": "Asphalt Millings / 瀝青刨除料", "density_t_m3": 1.40, "swell_factor": 0.85},
  }
  ```
- **Current Tonnage Calculation**: `pc_worker/surveying/dsm_and_volume.py` (lines 1182–1189):
  ```python
  mat_info = MATERIAL_CATALOG.get(material_key, MATERIAL_CATALOG["crushed_stone"])
  density = float(custom_density) if custom_density is not None else float(mat_info["density_t_m3"])
  swell = float(mat_info["swell_factor"])

  effective_m3 = fill_vol if fill_vol >= cut_vol else cut_vol
  tonnage_loose = effective_m3 * density
  tonnage_bank = effective_m3 * density * swell
  ```
  This implementation violates the physical law of mass conservation:
  - It assigns two different masses (`tonnage_loose` vs `tonnage_bank`) to the exact same soil body.
  - Multiplying density by `swell` (e.g. 0.80) produces a bank mass smaller than loose mass, whereas in physics mass is invariant ($M_{bank} = M_{loose} = M_{compacted}$) and volume expands upon excavation.
  - It computes `effective_m3 = max(fill_vol, cut_vol)` instead of calculating cut and fill volumes and masses independently.
  - Shrinkage factor ($S_{shrinkage}$) and Compacted Volume ($CCM$) are completely absent.

### 1.3 Dump Truck Load Estimator
- No dump truck haulage calculations currently exist in `pc_worker/surveying/dsm_and_volume.py`, `pc_worker/server_api_routes.py`, or frontend scripts.
- The volume response currently lacks:
  - Trips required for excavation haul-off
  - Volume-limited vs Weight-limited constraint flags
  - Net import/export truck balance

### 1.4 Vertical Geoid Offset Catalog Synchronization
- **Backend Definition**: `pc_worker/optimizer_bridge.py` (lines 61–82):
  ```python
  "WGS84_UTM51N": { ..., "h_offset_from_twvd": 17.20 },
  "WGS84_UTM50N": { ..., "h_offset_from_twvd": 16.80 },
  ```
- **Frontend Definition**: `web/src/06-studio-align-and-optimizer.js` (lines 37–57):
  ```javascript
  { code: "WGS84_UTM51N", ..., hOff: 20.6 },
  { code: "WGS84_UTM50N", ..., hOff: 19.8 },
  ```
  The frontend hardcodes `20.6m` and `19.8m`, creating a 3.40m and 3.00m vertical offset error between frontend and backend.

### 1.5 Strict 5,000-Line Modular File Ceiling
- Running `test_07_modular_architecture_strict_5000_line_ceiling` verifies all files are `< 5000` lines.
- File status:
  - `web/src/05-studio-civil-inspectors.js`: **4,984 lines** (only 16 lines below limit).
  - `web/src/04-studio-lasso-and-edits.js`: **4,940 lines** (60 lines below limit).
  - `pc_worker/surveying/dsm_and_volume.py`: **1,996 lines** (safe).
  - `web/src/09-construction-survey-and-bim.js`: designated in `PROJECT.md` for new civil QA and survey features.

---

## 2. Logic Chain

### 2.1 Least-Squares Best-Fit Plane Equations
From Observation 1.1, the backend requires a robust least-squares plane fitting implementation.

1. **Centering Coordinates for Numerical Stability**:
   Given $N$ perimeter sample points $(E_i, N_i, H_i)$ in TWD97 / TWVD2001 ($N \ge 3$):
   $$\bar{E} = \frac{1}{N}\sum_{i=1}^N E_i, \quad \bar{N} = \frac{1}{N}\sum_{i=1}^N N_i, \quad \bar{H} = \frac{1}{N}\sum_{i=1}^N H_i$$
   Centering reduces rounding errors from coordinates on the order of $10^6$:
   $$e_i = E_i - \bar{E}, \quad n_i = N_i - \bar{N}, \quad h_i = H_i - \bar{H}$$

2. **Normal Equations**:
   Fit plane $h = a \cdot e + b \cdot n$:
   $$\begin{bmatrix} S_{ee} & S_{en} \\ S_{en} & S_{nn} \end{bmatrix} \begin{bmatrix} a \\ b \end{bmatrix} = \begin{bmatrix} S_{eh} \\ S_{nh} \end{bmatrix}$$
   where:
   $$S_{ee} = \sum e_i^2, \quad S_{nn} = \sum n_i^2, \quad S_{en} = \sum e_i n_i, \quad S_{eh} = \sum e_i h_i, \quad S_{nh} = \sum n_i h_i$$
   Determinant:
   $$D = S_{ee} S_{nn} - S_{en}^2$$
   If $|D| > 10^{-9}$:
   $$a = \frac{S_{eh} S_{nn} - S_{nh} S_{en}}{D}$$
   $$b = \frac{S_{nh} S_{ee} - S_{eh} S_{en}}{D}$$
   $$c = \bar{H} - a \cdot \bar{E} - b \cdot \bar{N}$$
   If $|D| \le 10^{-9}$ (collinear boundary):
   $$a = 0.0, \quad b = 0.0, \quad c = \bar{H}$$

3. **Base Plane Elevation for DSM Grid Cell $(gx, gy)$**:
   $$z_{base}(gx, gy) = a \cdot gx + b \cdot gy + c$$

4. **Plane Geometry Metrics**:
   - Slope gradient ratio: $S = \sqrt{a^2 + b^2}$
   - Slope percentage: $S_{\%} = S \times 100\%$
   - Fall azimuth (steepest downhill descent, clockwise from True North):
     $$\text{azimuth\_deg} = \left(\text{degrees}(\text{atan2}(-a, -b)) + 360\right) \pmod{360}$$
     If $a = 0$ and $b = 0$, $\text{azimuth\_deg} = 0.0$.

### 2.2 Earthwork Mass Conservation Equations
From Observation 1.2, soil volume changes state while mass is invariant:

1. **Measured Volumes from DSM Integration**:
   - $V_{cut\_raw} = \sum \max(0, z_{base} - z_{surf}) \cdot \Delta A \cdot \text{scale} \implies BCM_{cut}$ (Bank Cubic Meters).
   - $V_{fill\_raw} = \sum \max(0, z_{surf} - z_{base}) \cdot \Delta A \cdot \text{scale} \implies BCM_{fill}$ (Bank Cubic Meters equivalent).

2. **Volume Expansion (Swelling)**:
   - User or catalog swell factor $F_{swell}$:
     - If $F_{swell} > 1.0$ (multiplier form, e.g. 1.25): expansion multiplier $M_{swell} = F_{swell}$.
     - If $F_{swell} \le 1.0$ (Caterpillar ratio form, e.g. 0.80): $M_{swell} = 1.0 / F_{swell} = 1.25$.
     - Equivalent swell percentage: $S_{swell} = M_{swell} - 1.0$ ($0.25 = 25\%$).
   - Loose Volume ($LCM$):
     $$LCM_{cut} = BCM_{cut} \times M_{swell} = BCM_{cut} \times (1 + S_{swell})$$

3. **Volume Compaction (Shrinkage)**:
   - User or catalog shrinkage percentage $S_{shrinkage}$ (default 0.10 = 10%):
     - If $S_{shrinkage} < 1.0$: compaction ratio $M_{shrink} = 1.0 - S_{shrinkage}$.
     - If $S_{shrinkage} \ge 1.0$: $M_{shrink} = S_{shrinkage} / 100.0$.
   - Compacted Volume ($CCM$):
     $$CCM_{fill} = BCM_{fill} \times (1 - S_{shrinkage})$$

4. **Conserved Mass**:
   - Given bank bulk density $\rho_{bank}$ (t/m³):
     $$M_{cut} = BCM_{cut} \times \rho_{bank} \quad (\text{metric tonnes})$$
     $$M_{fill} = BCM_{fill} \times \rho_{bank} \quad (\text{metric tonnes})$$
   - Derived densities satisfying $M \equiv BCM \times \rho_{bank} \equiv LCM \times \rho_{loose} \equiv CCM \times \rho_{compact}$:
     $$\rho_{loose} = \frac{\rho_{bank}}{M_{swell}} = \rho_{bank} \times F_{swell}$$
     $$\rho_{compact} = \frac{\rho_{bank}}{1 - S_{shrinkage}}$$

### 2.3 Dual-Constraint Dump Truck Load Estimator
From Observation 1.3, haulage trucks have volumetric and gross weight restrictions:

1. **Parameters**:
   - Truck Volumetric Capacity: $C_{truck\_vol}$ (m³, default $15.0\text{ m³}$).
   - Truck Maximum Legal Payload: $W_{truck\_max}$ (tonnes, default $20.0\text{ tonnes}$).

2. **Cut Excavation Haul Trips**:
   - Volume-limited trips:
     $$N_{vol} = \left\lceil \frac{LCM_{cut}}{C_{truck\_vol}} \right\rceil$$
   - Weight-limited trips:
     $$N_{weight} = \left\lceil \frac{M_{cut}}{W_{truck\_max}} \right\rceil$$
   - Required trips:
     $$N_{trips\_cut} = \max(N_{vol}, N_{weight})$$
   - Limiting factor:
     $$\text{limiting\_factor} = \begin{cases}
     \text{"weight"} & \text{if } N_{weight} > N_{vol} \\
     \text{"volume"} & \text{if } N_{vol} > N_{weight} \\
     \text{"balanced"} & \text{if } N_{vol} = N_{weight}
     \end{cases}$$

3. **Net Import / Export Site Balance**:
   - Net Bank Volume:
     $$\Delta BCM = BCM_{cut} - BCM_{fill}$$
   - **Case A: Surplus Excavation ($\Delta BCM > 0 \implies \text{Net Export}$)**:
     $$LCM_{net} = \Delta BCM \times M_{swell}$$
     $$M_{net} = \Delta BCM \times \rho_{bank}$$
     $$N_{net\_trucks} = \max\left(\left\lceil \frac{LCM_{net}}{C_{truck\_vol}} \right\rceil, \left\lceil \frac{M_{net}}{W_{truck\_max}} \right\rceil\right)$$
     $$\text{net\_haul\_direction} = \text{"export"}$$
   - **Case B: Deficit Borrow Required ($\Delta BCM < 0 \implies \text{Net Import}$)**:
     $$LCM_{net} = |\Delta BCM| \times M_{swell}$$
     $$M_{net} = |\Delta BCM| \times \rho_{bank}$$
     $$N_{net\_trucks} = \max\left(\left\lceil \frac{LCM_{net}}{C_{truck\_vol}} \right\rceil, \left\lceil \frac{M_{net}}{W_{truck\_max}} \right\rceil\right)$$
     $$\text{net\_haul\_direction} = \text{"import"}$$
   - **Case C: Mass-Balanced Site ($\Delta BCM = 0$)**:
     $$N_{net\_trucks} = 0, \quad \text{net\_haul\_direction} = \text{"balanced"}$$

### 2.4 Data Structure and API Contract
To satisfy `PROJECT.md` line 52 while maintaining backwards compatibility with existing clients and tests:

**Request Payload (`/api/survey/volume`)**:
```json
{
  "scan_id": "quchi_20261005_merged",
  "polygon": [[304945.0, 2757078.0, 43.1], ...],
  "points": [[304945.0, 2757078.0, 43.1], ...],
  "base_mode": "best_fit_plane",
  "stockpile_name": "Earthwork Zone A",
  "datum_elevation_m": 43.0,
  "custom_elevation": 43.0,
  "material_type": "excavated_soil",
  "density_t_m3": 1.45,
  "swell_factor": 0.80,
  "shrinkage_factor": 0.10,
  "truck_volume_m3": 15.0,
  "truck_max_tonnes": 20.0,
  "geoid_offset_override": null
}
```

**Response Payload (`/api/survey/volume`)**:
```json
{
  "status": "ok",
  "scan_id": "quchi_20261005_merged",
  "stockpile_name": "Earthwork Zone A",
  "base_mode": "best_fit_plane",
  "best_fit_plane": {
    "a": 0.0412,
    "b": -0.0185,
    "c": 42.85,
    "slope_pct": 4.52,
    "slope_ratio": "1:22.1",
    "azimuth_deg": 114.2
  },
  "planar_area_m2": 180.0,
  "planar_area_ping": 54.45,
  "surface_area_m2": 180.25,
  "perimeter_m": 54.0,

  "cut_volume_bcm": 120.50,
  "fill_volume_bcm": 35.20,
  "cut_volume_m3": 120.50,
  "fill_volume_m3": 35.20,
  "net_volume_bcm": 85.30,
  "net_volume_m3": 85.30,

  "cut_volume_lcm": 150.62,
  "fill_volume_ccm": 31.68,

  "conserved_cut_mass_t": 174.72,
  "conserved_fill_mass_t": 51.04,
  "estimated_tonnage_t": 174.72,
  "bank_tonnage_t": 174.72,

  "material_key": "excavated_soil",
  "material_name": "Excavated Earth / 一般開挖土方",
  "density_t_m3": 1.45,
  "swell_factor": 0.80,
  "shrinkage_factor": 0.10,

  "truck_specs": {
    "capacity_m3": 15.0,
    "max_payload_tonnes": 20.0
  },
  "truck_loads_cut": 11,
  "truck_loads_fill": 3,
  "truck_limiting_factor": "volume",
  "net_haul_direction": "export",
  "net_truck_loads": 8,

  "report_html_url": "/api/reports/stockpile_report_quchi_20261005_merged_1730346000.html",
  "report_csv_url": "/api/reports/stockpile_report_quchi_20261005_merged_1730346000.csv",
  "boundary_twd97": [...],
  "heatmap_cells": [...]
}
```

---

## 3. Caveats

1. **No Source Code Modified in this Turn**:
   Per the explorer role constraints, all analysis was conducted in read-only mode without altering production source files.
2. **File Size Budget for `05-studio-civil-inspectors.js`**:
   At 4,984 lines, any direct additions to `05-studio-civil-inspectors.js` risk exceeding the 5,000-line ceiling. The implementation plan must delegate UI rendering for the Truck Estimator to `web/src/09-construction-survey-and-bim.js` (or a concise call in `05-studio-civil-inspectors.js` of under 8 lines).
3. **Materials Catalog Schema**:
   Updating `MATERIAL_CATALOG` in `pc_worker/config.py` should keep the existing keys (`density_t_m3`, `swell_factor`) while adding `shrinkage_factor` and `swell_pct` to ensure all existing endpoints (`/api/scans`, `/api/status`) continue working seamlessly.

---

## 4. Conclusion

1. **Milestone 1 is fully specified and ready for implementation**:
   - The mathematical model for least-squares best-fit plane, bank/loose/compacted volumetric conversions, invariant mass conservation, dual-constraint truck trips, and net import/export balance is fully derived and verified.
2. **Target File Modifications Identified**:
   - `pc_worker/config.py`: Add `shrinkage_factor` and `swell_pct` to `MATERIAL_CATALOG`.
   - `pc_worker/surveying/dsm_and_volume.py`:
     - Implement `base_mode == "best_fit_plane"` using centered 2x2 normal equations.
     - Implement mass conservation calculations ($BCM, LCM, CCM, M$).
     - Implement Dump Truck Load Estimator ($\max(N_{vol}, N_{weight})$).
     - Support `geoid_offset_override`.
     - Update CSV and HTML reports with earthwork schedule table.
   - `web/src/06-studio-align-and-optimizer.js`: Fix geoid offsets for UTM51N ($17.20\text{ m}$) and UTM50N ($16.80\text{ m}$).
   - `web/src/09-construction-survey-and-bim.js`: Implement UI container for advanced earthwork parameters and truck estimator card, keeping `05-studio-civil-inspectors.js` under 5,000 lines.
   - `tests/test_gathering_scans_suite.py`: Add test cases for mass conservation, volume-vs-weight truck trips, and best-fit plane.

---

## 5. Verification Method

### 5.1 Test Suite Verification
Run the regression suite from the project root:
```powershell
python -m unittest tests.test_gathering_scans_suite
```
All existing 29 tests must pass, plus new tests for Milestone 1:
- `test_07_modular_architecture_strict_5000_line_ceiling`: Must pass, verifying every file remains strictly under 5,000 lines.
- `test_m1_earthwork_mass_conservation`: Verifies $BCM \times \rho_{bank} == LCM \times \rho_{loose} == CCM \times \rho_{compact} == M$.
- `test_m1_dump_truck_dual_constraint`: Verifies volume-limited trips for light materials and weight-limited trips for heavy materials.
- `test_m1_best_fit_plane`: Verifies normal equations plane fitting on sloping topography with correct slope % and fall azimuth.

### 5.2 Server API Verification
Call `/api/survey/volume` with `base_mode: "best_fit_plane"`:
```powershell
$body = @{
    scan_id = "quchi_20261005_merged"
    base_mode = "best_fit_plane"
    material_type = "excavated_soil"
    truck_volume_m3 = 15.0
    truck_max_tonnes = 20.0
    polygon = @(
        @(304945.0, 2757078.0, 43.1),
        @(304960.0, 2757078.0, 43.1),
        @(304960.0, 2757090.0, 43.2),
        @(304945.0, 2757090.0, 43.2)
    )
} | ConvertTo-Json -Depth 4

Invoke-RestMethod -Uri "http://127.0.0.1:8095/api/survey/volume" -Method Post -Body $body -ContentType "application/json"
```
Verify response contains:
- `cut_volume_bcm`, `fill_volume_bcm`
- `cut_volume_lcm`, `fill_volume_ccm`
- `conserved_cut_mass_t`, `conserved_fill_mass_t`
- `truck_loads_cut`, `truck_limiting_factor`, `net_truck_loads`
- `best_fit_plane: { a, b, c, slope_pct, azimuth_deg }`

### 5.3 Invalidation Conditions
The solution is invalidated if:
1. $BCM \times \rho_{bank} \ne M$ (mass conservation violation).
2. Heavy materials ($> 1.8\text{ t/m³}$) are marked volume-limited instead of weight-limited.
3. Any file exceeds 4,999 lines.
4. Calling `/api/survey/volume` with `base_mode: "best_fit_plane"` drops into IDW perimeter interpolation instead of the best-fit plane.
