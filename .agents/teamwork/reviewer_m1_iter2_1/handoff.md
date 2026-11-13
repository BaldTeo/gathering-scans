# Quality & Adversarial Review Report — Milestone 1 (M1) Iteration 2

- **Reviewer**: `reviewer_m1_iter2_1` (M1 Math & Collinear Reviewer)
- **Roles**: `reviewer`, `critic`
- **Working Directory**: `c:\Antigravity\GatheringScans\.agents\teamwork\reviewer_m1_iter2_1\`
- **Parent Conversation ID**: `35a7b3c4-959a-4d2b-a4b5-21fb2891dea3`
- **Date**: 2026-10-31T04:52:30Z
- **Verdict**: **APPROVE**

---

## 1. Observation

### Obs 1: Normal Equations & Eigenvalue Ratio Safeguard in `dsm_and_volume.py`
- **Location**: `pc_worker/surveying/dsm_and_volume.py` (lines 1114–1159).
- **Verbatim Code Observed**:
  ```python
  suu = sum((p[0] - p_mean_e) ** 2 for p in plane_pts)
  svv = sum((p[1] - p_mean_n) ** 2 for p in plane_pts)
  suv = sum((p[0] - p_mean_e) * (p[1] - p_mean_n) for p in plane_pts)
  suw = sum((p[0] - p_mean_e) * (p[2] - p_mean_h) for p in plane_pts)
  svw = sum((p[1] - p_mean_n) * (p[2] - p_mean_h) for p in plane_pts)

  det_plane = suu * svv - suv * suv
  trace_plane = suu + svv

  disc_plane = max(0.0, (suu - svv) ** 2 + 4.0 * suv * suv)
  lambda_min = (2.0 * det_plane) / (trace_plane + math.sqrt(disc_plane)) if trace_plane > 1e-6 else 0.0

  if det_plane <= 0.0 or lambda_min < 1e-4 or (lambda_min / trace_plane) < 1e-4 or trace_plane < 1e-6:
      plane_a = 0.0
      plane_b = 0.0
      plane_c0 = p_mean_h
  else:
      plane_a = (suw * svv - svw * suv) / det_plane
      plane_b = (svw * suu - suw * suv) / det_plane
      plane_c0 = p_mean_h
  ```
- **Empirical Test Results on 100m Collinear Alignments at Arbitrary Azimuths**:
  Tested 14 distinct azimuths ($0^\circ, 15^\circ, 30^\circ, 35^\circ, 45^\circ, 60^\circ, 89^\circ, 90^\circ, 120^\circ, 135^\circ, 180^\circ, 225^\circ, 270^\circ, 315^\circ$) with 10 collinear points over 100m baseline.
  - Failures: `0 / 14`.
  - In all 14 cases, `slope_pct == 0.0`, `a == 0.0`, `b == 0.0`, `c0 == p_mean_h`.
  - Negative determinant leak ($\det \approx -7.45 \times 10^{-9}$) and millimeter quantization noise ($\sigma_\perp < 0.2\text{mm}$) are both 100% suppressed by `det_plane <= 0.0` and `(lambda_min / trace_plane) < 1e-4`.

### Obs 2: Slope & Azimuth Recovery on Non-Collinear Real Polygons
- Tested with `calculate_cut_fill_volume` against real scan `quchi_20261005_merged`:
  - 5m x 5m building pad: `slope_pct = 46.666%`, valid planar gradient recovered without triggering collinear fallback.
  - 100m x 5m road corridor (aspect ratio 20:1): `slope_pct = 14.031%`, valid planar gradient recovered.
  - 100m x 2m road corridor (aspect ratio 50:1): `slope_pct = 12.870%`, valid planar gradient recovered.
  - 89.9° steep cliff: `slope_pct = 57295.78%`, `slope_deg = 89.9°`, `azimuth_deg = 90.0°` accurately recovered.

### Obs 3: Mass Conservation & Truck Haul Logic
- **Location**: `pc_worker/surveying/dsm_and_volume.py` (lines 1255–1335).
- **Test Case 1 (Volume-Limited Haul)**:
  - Input: density = 1.70 t/m³, swell = 1.25, shrink = 0.15, truck_vol = 14 m³, truck_max_tonnes = 20 t.
  - Observed:
    - Cut BCM: 830.41 m³
    - Cut LCM: 1038.01 m³ (exact ratio: $1038.01 / 830.41 = 1.250$)
    - Fill BCM: 3168.36 m³
    - Fill CCM: 2693.11 m³ (exact ratio: $2693.11 / 3168.36 = 0.850 = 1 - 0.15$)
    - Conserved Cut Mass: 1411.69 tonnes (exact ratio: $1411.69 / 830.41 = 1.700$)
    - Truck trips vol: $1038.01 / 14 = 74.14 \implies 75$ trips.
    - Truck trips wt: $1411.69 / 20 = 70.58 \implies 71$ trips.
    - Observed Truck loads cut: 75, limiting factor: `"volume"`. Exact match.
- **Test Case 2 (Weight-Limited Haul)**:
  - Input: density = 2.50 t/m³, swell = 1.10, shrink = 0.10, truck_vol = 25 m³, truck_max_tonnes = 10 t.
  - Observed:
    - Cut BCM: 830.41 m³, Cut LCM: 913.45 m³, Cut Mass: 2076.02 tonnes.
    - Trips vol: $913.45 / 25 = 36.5 \implies 37$ trips.
    - Trips wt: $2076.02 / 10 = 207.6 \implies 208$ trips.
    - Observed Truck loads cut: 208, limiting factor: `"weight"`. Exact match.

### Obs 4: Input Sanitization & 0 Crash Robustness
- **Location**: `pc_worker/surveying/dsm_and_volume.py` (lines 990–991, 1094, 1251, 1257, 1275, 1304, 1307).
- Tested payload with invalid strings: `datum_elevation_m: "null"`, `density_t_m3: ""`, `swell_factor: "not_a_number"`, `shrinkage_factor: None`, `truck_volume_m3: "   "`, `truck_max_tonnes: "nan"`.
- Response: `{"status": "ok", ...}` with graceful fallback to engineering defaults. Zero 500 exceptions.

### Obs 5: Test Execution Results
1. `python -m unittest tests/test_gathering_scans_suite.py`:
   `Ran 33 tests in 9.360s, OK`
2. `python -m unittest tests/test_civil_surveying_e2e.py`:
   `Ran 22 tests in 0.293s, OK`
3. `python c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m1_1\test_m1_empirical_adversarial.py -v`:
   `Ran 18 tests in 0.383s, OK`
4. Custom adversarial verification script `verify_m1_math.py`:
   14/14 rotated collinear tests pass, 4/4 polygon geometry tests pass, 5/5 mass & truck assertions pass.

### Obs 6: Strict 5,000-Line Ceiling Audit
- Checked all 58 repository source files (`.py`, `.js`, `.css`, `.html`):
  - `web/src/03-studio-core.js`: 4,996 lines (< 5,000)
  - `web/src/05-studio-civil-inspectors.js`: 4,987 lines (< 5,000)
  - `web/src/09-construction-survey-and-bim.js`: 219 lines (< 5,000)
  - `pc_worker/surveying/dsm_and_volume.py`: 2,195 lines (< 5,000)
  - `pc_worker/optimizer_bridge.py`: 4,220 lines (< 5,000)
  - `tests/test_gathering_scans_suite.py`: 2,621 lines (< 5,000)
  - Zero violations across all 58 files.

### Obs 7: Integrity Verification
- Inspected source code for hardcoded returns (`if scan_id == ...`), dummy facades, or shortcuts.
- None found. Real normal equations, true eigenvalue decomposition, and true raster elevation integration are executed across all scan datasets.

---

## 2. Logic Chain

1. **Collinear Alignment Detection Stability**:
   - The covariance matrix $M = \begin{bmatrix} S_{uu} & S_{uv} \\ S_{uv} & S_{vv} \end{bmatrix}$ describes the spatial dispersion of polygon boundary points projected on the horizontal datum plane.
   - For an idealized 1D collinear alignment, $\lambda_{max} \approx N L^2 / 12$ while $\lambda_{min} = 0$.
   - In floating-point arithmetic with rotated alignments or millimeter coordinate quantization, $\lambda_{min}$ can be small and positive ($\sim 10^{-6}$ to $10^{-5}$) or $\det(M)$ can fluctuate below zero ($\sim -10^{-8}$).
   - The dual safeguard:
     `det_plane <= 0.0 or lambda_min < 1e-4 or (lambda_min / trace_plane) < 1e-4 or trace_plane < 1e-6`
     evaluates the scale-invariant condition ratio $\kappa^{-1} = \frac{\lambda_{min}}{\text{trace}} \approx \frac{\sigma_\perp^2}{\sigma_\parallel^2}$.
   - For any straight alignment (regardless of orientation azimuth $0^\circ \le \theta < 360^\circ$ or elevation ramp), $\sigma_\perp < 0.2\text{mm} \implies \frac{\lambda_{min}}{\text{trace}} \le 10^{-8} \ll 10^{-4}$, triggering an immediate, clean fallback to a horizontal mean plane (`plane_a = 0.0, plane_b = 0.0, slope_pct = 0.0%`).
   - For real 2D engineering polygons (even elongated corridors with 50:1 aspect ratios), $\frac{\lambda_{min}}{\text{trace}} \ge 4 \times 10^{-4} > 10^{-4}$, ensuring genuine slopes are never falsely zeroed out.

2. **Mass Conservation Invariance**:
   - Soil volume expands from in-situ Bank state ($BCM$) to Loose state ($LCM = BCM \times \text{swell\_factor}$) upon excavation.
   - Embankment compaction compresses Loose/Bank material to Compacted state ($CCM = BCM \times [1 - \text{shrinkage\_factor}]$).
   - Invariant physical mass $M = BCM \times \rho_{\text{bank}}$ is conserved across state transformations and accurately reported in metric tonnes.
   - Dual-constraint dump truck trip estimation $\lceil \max(LCM / V_{\text{truck}}, M / W_{\text{truck}}) \rceil$ correctly captures both volumetric limit (for light porous materials) and legal gross weight limit (for dense rock/gravel).

3. **Modular Architecture & Frontend Separation**:
   - Placing civil construction UI components into `web/src/09-construction-survey-and-bim.js` preserved `web/src/05-studio-civil-inspectors.js` at 4,987 lines without breaching the 5,000-line ceiling.
   - All components are registered into `window` and loaded cleanly in `index.html` and `sw.js` with version `20261031_v218`.

---

## 3. Caveats

- **No Caveats**: All mathematical claims, normal equation conditions, adversarial edge cases, modular line limits, and test executions passed unconditionally.

---

## 4. Conclusion

**Verdict: APPROVE**

The Milestone 1 (M1) remediation successfully resolves all previous findings:
1. Least-squares plane fitting is scale-invariant, robust against floating-point cancellation, and handles collinear alignments across all azimuths safely.
2. Non-collinear polygons compute accurate slopes and azimuths without false collinear triggers.
3. Mass conservation identities ($BCM \to LCM \to CCM$, invariant mass in tonnes) and dual-constraint truck hauling logic are mathematically verified and functionally complete.
4. Input parsing is immune to malformed/empty tokens.
5. All 58 source files strictly adhere to the 5,000-line modular limit.
6. 100% of tests (33 unit/integration tests, 22 civil surveying e2e tests, 18 empirical adversarial tests) pass cleanly. Zero integrity violations detected.

---

## 5. Verification Method

To independently verify this report:

1. **Run Full Test Suites**:
   ```powershell
   python -m unittest tests/test_gathering_scans_suite.py
   python -m unittest tests/test_civil_surveying_e2e.py
   python c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m1_1\test_m1_empirical_adversarial.py -v
   ```

2. **Run Empirical Math & Collinear Verification Script**:
   ```powershell
   python c:\Antigravity\GatheringScans\.agents\teamwork\reviewer_m1_iter2_1\verify_m1_math.py
   ```

3. **Verify 5,000-Line Limit Across Entire Repository**:
   ```powershell
   python -c "import os; [print(f'VIOLATION: {os.path.join(r, fn)}') for r, d, fs in os.walk(r'c:\Antigravity\GatheringScans') if not any(x in r for x in ['.git', 'data', 'node_modules', '__pycache__', '.agent']) for fn in fs if fn.endswith(('.py', '.js', '.css', '.html')) and sum(1 for _ in open(os.path.join(r, fn), 'r', encoding='utf-8', errors='ignore')) >= 5000]; print('Line audit done.')"
   ```

4. **Verify Health of Local PC Server & Live VPS Server**:
   ```powershell
   python -c "import urllib.request; print('Local 8095:', urllib.request.urlopen('http://127.0.0.1:8095/api/status').status); print('VPS:', urllib.request.urlopen('https://scans.gatheren.cloud/api/status').status)"
   ```
