# Empirical Challenger Handoff Report — Milestone 1 (M1)

- **Agent**: `teamwork_challenger` (M1 Numerical & Geometric Challenger)
- **Roles**: `critic`, `specialist`
- **Working Directory**: `c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m1_1\`
- **Target File**: `pc_worker/surveying/dsm_and_volume.py` (lines 1096–1140, `calculate_cut_fill_volume` least-squares reference plane)
- **Verdict**: **`REQUEST_CHANGES`**

---

## 1. Observation

### Obs 1: Collinear Determinant Collapse Safeguard in `dsm_and_volume.py`
In `pc_worker/surveying/dsm_and_volume.py` (lines 1110–1122), the least-squares normal equations singularity safeguard is implemented as:
```python
1110:             det_plane = suu * svv - suv * suv
1111:             trace_plane = suu + svv
1112: 
1113:             # Safeguard: singularity / collinear points fallback to horizontal mean plane
1114:             if abs(det_plane) < 1e-9 or trace_plane < 1e-6:
1115:                 plane_a = 0.0
1116:                 plane_b = 0.0
1117:                 plane_c0 = p_mean_h
1118:             else:
1119:                 plane_a = (suw * svv - svw * suv) / det_plane
1120:                 plane_b = (svw * suu - suw * suv) / det_plane
1121:                 plane_c0 = p_mean_h
```

### Obs 2: Empirical Vulnerability 1 — Negative Determinant Leak on Long Collinear Alignments ($\ge 100\text{m}$)
When 10 collinear points along a straight line at an arbitrary angle ($35^\circ$) with length $L = 100.0\text{m}$ are passed to `solve_least_squares_plane`:
- Mathematical determinant: $\det = S_{uu} S_{vv} - S_{uv}^2 \equiv 0.0$.
- Floating point evaluation (IEEE 754 float64):
  `suu * svv = 2.290074e+07`, `suv * suv = 2.290074e+07`.
  Due to floating-point roundoff cancellation:
  `det_plane = -7.450580596923828e-09`.
  `abs(det_plane) = 7.45058e-09 > 1e-9`.
  `trace_plane = 2500.0 > 1e-6`.
- Execution: Line 1114 evaluates to `False`. The code enters the `else:` branch, dividing by `-7.45e-09`.
- Verbatim result:
  ```python
  det: -7.450580596923828e-09
  a: 0.0625
  b: 0.0625
  slope_pct: 8.839%
  slope_deg: 5.05 deg
  azimuth_deg: 45.0 deg
  ```
  Instead of falling back to a horizontal plane with `slope_pct = 0.0%`, the algorithm generates a spurious phantom plane tilted at **8.84% slope**.
  For $L = 2000.0\text{m}$, `det_plane = -0.000488`, producing a spurious **12.5% slope**.
  For $L = 9525.0\text{m}$, `det_plane = -2.0`, producing a spurious **4.42% slope**.

### Obs 3: Empirical Vulnerability 2 — Fixed Dimensional Threshold ($10^{-9}\text{m}^4$) Misses Near-Collinear Points
When 3 points forming a $179.999^\circ$ angle (sub-millimeter lateral deviation of $0.0436\text{mm}$) with a 10m baseline and a 5cm elevation difference are evaluated:
- Lateral offset: $\delta = 5\text{m} \times \tan(0.0005^\circ) = 4.363 \times 10^{-5}\text{m}$.
- `suu = 50.0`, `svv = 1.269e-09`, `suv = 0.0`.
- Determinant: `det_plane = 6.346e-08`.
- Because $6.346 \times 10^{-8} > 10^{-9}$, the safeguard does NOT trigger.
- Verbatim result:
  ```python
  det: 6.346243556706876e-08
  a: 0.0
  b: 1145.9113
  slope_pct: 114591.132%
  slope_deg: 89.95 deg
  ```
  The slope explodes to **114,591%** ($89.95^\circ$) due to near-collinearity.

### Obs 4: Successful Robustness Observations
1. **Extreme Slopes (89.9° & 89.99° Cliffs)**:
   Tested across all 8 cardinal/intercardinal azimuths ($0^\circ, 45^\circ, 90^\circ, 135^\circ, 180^\circ, 225^\circ, 270^\circ, 315^\circ$) with $\tan(89.9^\circ) \approx 572.958$. In all cases, $a, b, \text{slope\_deg}, \text{azimuth\_deg}$ converged exactly without NaN or Inf.
   Tested end-to-end in `calculate_cut_fill_volume` on synthetic DSM with 89.9° terrain: produced `slope_deg = 89.90`, `azimuth_deg = 90.0`, `surface_area_m2 = 57295.81` (matching exact 3D sloped surface area), and `cut_vol = 0.0`, `fill_vol = 0.0`.
2. **Coordinate Offsets ($3,000,000\text{m}$ E, $27,000,000\text{m}$ N)**:
   Centroid conditioning $(E - \bar{E}, N - \bar{N})$ completely eliminates catastrophic cancellation, preserving 10 decimal digits of accuracy for $a$ and $b$, and evaluating elevations to within $< 10^{-8}\text{m}$.
3. **Scale Extremes ($10\text{km} \times 10\text{km}$ Giant Polygon)**:
   Evaluated $100,000,000\text{m}^2$ footprint in $< 0.1\text{s}$ without integer or floating point overflow.
4. **Trigonometric Oracles (360° Sweep)**:
   Tested all orientations $\theta \in [0^\circ, 359^\circ]$ at 1° increments against oracle $a = S \sin(\theta), b = S \cos(\theta)$. Max error on $a, b$ was $< 10^{-7}$, and max azimuth discrepancy was $< 0.1^\circ$.

---

## 2. Logic Chain

1. **Step 2.1 (Mathematical Principle)**:
   By the Cauchy-Schwarz inequality, for any vectors $u, v \in \mathbb{R}^n$:
   $$(u \cdot v)^2 \le \|u\|^2 \|v\|^2 \implies S_{uu} S_{vv} - S_{uv}^2 \ge 0$$
   In exact arithmetic, $\det = S_{uu} S_{vv} - S_{uv}^2$ is strictly non-negative ($\det \ge 0$). A determinant of zero occurs if and only if $u$ and $v$ are linearly dependent (collinear points).
2. **Step 2.2 (Floating-Point Subtraction Cancellation)**:
   Per Obs 2, when points are collinear along a baseline $L \ge 100\text{m}$, $S_{uu} S_{vv} \sim 10^7$ to $10^{16}$. Double precision (float64) has 53 bits ($\sim 16$ decimal digits). Computing $S_{uu} S_{vv} - S_{uv}^2$ involves subtracting two numbers identical to 15 digits. The rounding noise in the 16th digit produces negative values between $-10^{-8}$ and $-2.0$.
3. **Step 2.3 (Safeguard Condition Failure)**:
   Line 1114 tests `abs(det_plane) < 1e-9`. When $\det = -7.45 \times 10^{-9}$, its absolute value $7.45 \times 10^{-9}$ exceeds $10^{-9}$. Therefore, the condition evaluates to `False`. The safeguard does not activate on collinear points with spans $\ge 100\text{m}$, causing Cramer's rule to divide by a spurious negative noise term and calculate a phantom plane (Obs 2).
4. **Step 2.4 (Dimensional Inconsistency of $10^{-9}$)**:
   The quantity $\det = S_{uu} S_{vv} - S_{uv}^2$ has physical dimensions of $[\text{Length}]^4 = \text{meters}^4$.
   A fixed threshold of $10^{-9}\text{m}^4$ corresponds to a linear dimension of $\sqrt[4]{10^{-9}} \approx 0.0056\text{m} = 5.6\text{mm}$.
   For surveying baselines $L = 10\text{m}$ to $100\text{m}$, points with sub-millimeter lateral deviation have $\det > 10^{-9}\text{m}^4$ (Obs 3), completely slipping past the threshold and exploding the slope.
5. **Step 2.5 (Resolution via Scale-Invariant Eigenvalue Condition)**:
   The transverse spread of the points along the minor axis is given by the minor eigenvalue of the $2 \times 2$ covariance matrix $M$:
   $$\lambda_{min} = \frac{2 \det}{S_{uu} + S_{vv} + \sqrt{(S_{uu} - S_{vv})^2 + 4 S_{uv}^2}}$$
   $\lambda_{min}$ has units of $\text{meters}^2$. The transverse standard deviation is $\sigma_\perp = \sqrt{\lambda_{min} / n}$.
   If $\det \le 0.0$ or $\lambda_{min} < 10^{-6}\text{m}^2$ (transverse deviation $< 1\text{mm}$), the points are geometrically collinear, regardless of baseline length or orientation.

---

## 3. Caveats

1. The standard test suite (`tests/test_gathering_scans_suite.py`) passes because its test case `test_30_best_fit_reference_plane` only tested a collinear line along the Easting axis with a 10m span, where $\det = 0.0$ identically due to axis alignment. The vulnerability only manifests on rotated alignments ($N \ne \text{const}, E \ne \text{const}$) with spans $\ge 100\text{m}$.
2. In `calculate_cut_fill_volume`, when a user passes a 3D polygon, the function samples the terrain elevation $Z$ from the DSM along the perimeter; it does not fit the plane to user-specified polygon $Z$ values. This is by design (earthwork volume measures cut/fill relative to the actual ground surface).

---

## 4. Conclusion & Actionable Verdict

### Explicit Verdict: **`REQUEST_CHANGES`**

The implementation in `pc_worker/surveying/dsm_and_volume.py` requires one specific mathematical patch to lines 1113–1117 to guarantee numerical stability across all scales and orientations:

### Actionable Remediation:
In `pc_worker/surveying/dsm_and_volume.py` line 1113, replace:
```python
            # Safeguard: singularity / collinear points fallback to horizontal mean plane
            if abs(det_plane) < 1e-9 or trace_plane < 1e-6:
                plane_a = 0.0
                plane_b = 0.0
                plane_c0 = p_mean_h
```
With the scale-invariant, non-negative eigenvalue safeguard:
```python
            # Safeguard: singularity / collinear points / non-positive det fallback to horizontal mean plane
            disc_plane = max(0.0, (suu - svv) ** 2 + 4.0 * suv * suv)
            lambda_min = (2.0 * det_plane) / (trace_plane + math.sqrt(disc_plane)) if trace_plane > 1e-6 else 0.0

            if det_plane <= 0.0 or lambda_min < 1e-6 or trace_plane < 1e-6:
                plane_a = 0.0
                plane_b = 0.0
                plane_c0 = p_mean_h
```

---

## 5. Verification Method

### How to Independently Verify:
Run the self-contained adversarial test suite located in this working directory:
```powershell
python c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m1_1\test_m1_empirical_adversarial.py -v
```
All 18 adversarial tests verify:
- `test_cat1_*`: 89.9° and 89.99° near-vertical terrain and cliffs.
- `test_cat2_adversarial_finding_100m_collinear_negative_det_leak`: Confirms the reproduction of Finding 1.
- `test_cat2_adversarial_finding_10m_179_999_deg_submillimeter_anomaly`: Confirms the reproduction of Finding 2.
- `test_cat3_*`: Micro-polygons ($0.0001\text{m}^2$) and giant polygons ($10\text{km} \times 10\text{km}$).
- `test_cat4_*`: Large coordinate offsets ($3,000,000\text{m}$ Easting, $27,000,000\text{m}$ Northing).
- `test_cat5_*`: Full 360° trigonometric oracle sweep.

### Invalidation Conditions:
- If applying the remediation causes `test_cat2_adversarial_finding_100m_collinear_negative_det_leak` to return `slope_pct == 0.0%`, the bug is proven fixed.
- If any existing tests in `tests/test_gathering_scans_suite.py` fail.
