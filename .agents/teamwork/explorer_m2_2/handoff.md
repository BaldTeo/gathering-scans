# Milestone 2 (M2) 1-Click TBM Vertical Datum Calibration & Offset Persistence Handoff Report

**Agent**: `explorer_m2_2` (M2 TBM Vertical Datum Calibration & Offset Persistence Explorer)  
**Parent**: `35a7b3c4-959a-4d2b-a4b5-21fb2891dea3` (Orchestrator)  
**Date**: 2026-10-31T05:38:00Z  
**Type**: Hard Handoff (Investigation & Architecture Specification Complete)  

---

## 1. Observation

### 1.1 Existing Endpoint & Routing
In `pc_worker/server_api_routes.py` (lines 994–1004):
```python
# 5c. Civil Surveying: Automated GCP / Check-Point Accuracy QA Report
if path in ("/api/survey/gcp-qa", "/api/surveying/gcp-qa"):
    if share_token:
        ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(
            share_token, requested_scan_id=payload.get("scan_id")
        )
        if not ok_s or not (link_s and link_s.get("allow_measurements", True)):
            self.send_json({"error": "GCP QA is disabled for this external share link."}, status=403)
            return
    res = SURVEY.compute_gcp_accuracy_qa(payload)
    self.send_json(res)
    return
```
- Direct observation: `/api/survey/gcp-qa` currently delegates directly to `SURVEY.compute_gcp_accuracy_qa(payload)`.
- It receives `payload: Dict[str, Any]` and sends back JSON.

### 1.2 Current State of `compute_gcp_accuracy_qa` in `pc_worker/surveying/dsm_and_volume.py`
In `pc_worker/surveying/dsm_and_volume.py` (lines 1776–1931 and 2024–2045):
```python
def compute_gcp_accuracy_qa(self, payload: Dict[str, Any]) -> Dict[str, Any]:
    ...
    raw_pts = (
        payload.get("points")
        or payload.get("checkpoints")
        or payload.get("gcp_points")
        or payload.get("gcps")
        or []
    )
    geoid_override_raw = payload.get("geoid_offset_override") if payload.get("geoid_offset_override") is not None else payload.get("h_offset_from_twvd")
    geoid_offset_override = safe_float(geoid_override_raw)
    ...
    dz_m = round(h_scan - h_gcp, 4)
    ...
    rmse_z_m = round(math.sqrt(sq_sum / n_pts), 4)
    rmse_z_cm = round(rmse_z_m * 100.0, 2)
    mean_err_m = round(sum(p["dz_m"] for p in evaluated) / n_pts, 4)
    ...
    return {
        "status": "ok",
        "geoid_offset_override": geoid_offset_override,
        "geoid_offset_applied": bool(geoid_offset_override is not None),
        "scan_id": scan_id,
        "scan_name": scan.get("name") or scan_id,
        "crs": TWD97_TWVD2001_LABEL,
        "point_count": len(evaluated),
        "rmse_z_m": rmse_z_m,
        "rmse_z_cm": rmse_z_cm,
        "mean_error_m": mean_err_m,
        "mean_error_cm": mean_err_cm,
        "max_abs_dz_m": max_abs_m,
        "max_abs_dz_cm": max_abs_cm,
        "confidence_95_m": conf_95_m,
        "confidence_95_cm": conf_95_cm,
        "qa_grade": qa_grade,
        "qa_grade_label": qa_grade_label,
        "points": evaluated,
        "csv_url": f"/api/reports/{csv_filename}",
        "html_url": f"/api/reports/{html_filename}",
    }
```
- Direct observation:
  1. It currently supports only 1D vertical residuals (`dz_m = h_scan - h_gcp`) and vertical RMSE (`rmse_z_m`).
  2. It has zero awareness of `is_tbm` flags or `selected_tbm_id`.
  3. It does not compute or preview TBM calibration shifts.
  4. It does not support `apply_tbm_calibration: bool`.
  5. It does not persist any calibration offsets to database or disk.

### 1.3 Database Schema & Extensible Metadata in `pc_worker/priority_queue.py`
In `pc_worker/priority_queue.py`:
- `CREATE TABLE scans` (lines 73–110):
  ```sql
  CREATE TABLE IF NOT EXISTS scans (
      scan_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ...
      elev_m REAL DEFAULT 0.0,
      twd97_e REAL DEFAULT 0.0,
      twd97_n REAL DEFAULT 0.0,
      twd97_h REAL DEFAULT 0.0,
      bounding_box_json TEXT DEFAULT '{}',
      status TEXT DEFAULT 'queued',
      ...
      extra_json TEXT DEFAULT '{}'
  );
  ```
- Unpacking in `_row_to_dict` (lines 1901–1950):
  ```python
  extra_raw = d.get("extra_json") or "{}"
  extra_dict: Dict[str, Any] = {}
  if isinstance(extra_raw, str) and extra_raw.strip() not in ("", "{}"):
      try:
          parsed_ex = json.loads(extra_raw)
          if isinstance(parsed_ex, dict):
              extra_dict = parsed_ex
      except Exception:
          pass
  for ex_k in (
      "merged_from",
      "derived_from_scan_id",
      "applied_adjustments",
      "poly_count",
      "home_view",
      "is_gaussian_splat",
      "splat_count",
      "gaussian_splat_uri",
      "group_type",
      "user_edited_project",
  ):
      if ex_k in extra_dict:
          d[ex_k] = extra_dict[ex_k]
  ```
- Existing metadata persistence pattern in `set_scan_home_view` (lines 530–576):
  ```python
  def set_scan_home_view(self, scan_id: str, home_view: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
      ...
      with DB_LOCK, self._connect() as conn:
          row = conn.execute("SELECT scan_id, project_dir, extra_json FROM scans WHERE lower(scan_id) = lower(?) LIMIT 1", (clean_id,)).fetchone()
          ...
          conn.execute(
              "UPDATE scans SET extra_json = ? WHERE scan_id = ?",
              (json.dumps(ex_dict, ensure_ascii=False), real_id),
          )
          conn.commit()
      if proj_dir and os.path.isdir(proj_dir):
          meta_file = os.path.join(proj_dir, "scan_meta.json")
          ...
          with open(meta_file, "w", encoding="utf-8") as wf:
              json.dump(meta, wf, indent=2, ensure_ascii=False)
      return self.get_scan(real_id)
  ```
- Direct observation: The system has a proven dual-tier persistence mechanism: SQLite `extra_json` column + on-disk `proj_dir/scan_meta.json`. Adding `tbm_calibration` and `vertical_datum_offset` fits this exact established architectural pattern.

### 1.4 Downstream Elevation Sampling in Civil Surveying Endpoints
Direct inspection of civil surveying endpoints in `pc_worker/surveying/`:
1. **Cut/Fill Volume** (`pc_worker/surveying/dsm_and_volume.py`, lines 1206–1227):
   - Samples surface height $z_{surf}$ via `self._sample_dsm_elevation(dsm_curr, gx, gy)`.
   - Computes $z_{base}$ against datum or reference plane.
   - For `custom_plane`: $z_{base} = \text{datum\_z}$. If scan datum is biased by $+0.25$ m, $z_{surf}$ is $+0.25$ m higher than the true physical grade, producing distorted cut/fill balances.
2. **AutoCAD Contours** (`pc_worker/surveying/contours_and_cad.py`, lines 360–370):
   - `full_grid = dsm_data["dsm_contour"]`
   - `sub_grid = full_grid[j0 : j1 + 1, i0 : i1 + 1].copy()`
   - Contours are extracted from `sub_grid` values.
3. **Cross-Section Profile** (`pc_worker/surveying/contours_and_cad.py`, lines 1391–1397):
   - `z_curr, _, _, _ = self._sample_dsm_elevation(dsm_curr, ex, ny)`
   - Samples compare scan `z_base, _, _, _ = self._sample_dsm_elevation(dsm_cmp, ex, ny)`.
4. **Surface Drainage & Ponding** (`pc_worker/surveying/dsm_and_volume.py`, line 2050):
   - DSM elevations determine downhill gradient flow lines and depression spill pour point elevations.
5. **Surface Flatness & Plumbness QA** (planned for M4 in `pc_worker/surveying/construction_qa.py`):
   - Evaluates slab flatness against design target elevation (FFL $Z_{design}$).

---

## 2. Logic Chain

### 2.1 1-Click TBM Vertical Datum Calibration Mathematics

#### Step 1: Sign Convention and Control Point Pairing
For each Ground Control Point (GCP) or Check Point (CP) $i \in \{1, \dots, N\}$:
- Known survey control benchmark coordinates: $P_i = (E_{gcp, i}, N_{gcp, i}, H_{gcp, i})$ in TWVD2001 orthometric height.
- Photogrammetric scan surface coordinates: $S_i = (E_{scan, i}, N_{scan, i}, H_{scan, i})$.
  - Where $(E_{scan, i}, N_{scan, i})$ match $(E_{gcp, i}, N_{gcp, i})$ (or extracted from `mesh_e`, `mesh_n` if provided).
  - $H_{scan, i}$ is bilinearly sampled from the scan DSM at $(E_{gcp, i}, N_{gcp, i})$ (or provided via `mesh_h`).
- Residual error definitions:
  $$\Delta E_i = E_{scan, i} - E_{gcp, i}$$
  $$\Delta N_i = N_{scan, i} - N_{gcp, i}$$
  $$\Delta H_i = H_{scan, i} - H_{gcp, i}$$
  $$\Delta 2\text{D}_i = \sqrt{\Delta E_i^2 + \Delta N_i^2}$$
  $$\Delta 3\text{D}_{raw, i} = \sqrt{\Delta E_i^2 + \Delta N_i^2 + \Delta H_i^2} = \sqrt{\Delta 2\text{D}_i^2 + \Delta H_i^2}$$
- **Civil Sign Convention**: Residual = $Scan - GCP$.
  - If $\Delta H_i > 0$, the photogrammetric surface is floating above the true physical benchmark.
  - If $\Delta H_i < 0$, the photogrammetric surface is below the true physical benchmark.

#### Step 2: Vertical Datum Bias Compensation Shift Calculation
There are two operational cases:

**Case A: Designated Benchmark / TBM Point**  
A specific benchmark $k$ is marked as the project Temporary Benchmark (`is_tbm = True` or `point_id == selected_tbm_id`):
$$\text{shift}_{tbm} = H_{gcp, k} - H_{scan, k} = -\Delta H_k$$
Applying this shift to benchmark $k$:
$$H_{scan, cal, k} = H_{scan, k} + \text{shift}_{tbm} = H_{scan, k} + (H_{gcp, k} - H_{scan, k}) = H_{gcp, k}$$
$$\Delta H_{cal, k} = H_{scan, cal, k} - H_{gcp, k} = 0.000 \text{ m}$$
The vertical residual at the project benchmark becomes exactly zero.

**Case B: Network-Wide Mean Vertical Bias (No single point designated)**  
When no single TBM is designated, compute the unweighted mean vertical error across all $N$ valid GCPs:
$$\overline{\Delta H} = \frac{1}{N} \sum_{i=1}^N \Delta H_i = \frac{1}{N} \sum_{i=1}^N (H_{scan, i} - H_{gcp, i})$$
The optimal vertical datum compensation shift that minimizes the sum of squared vertical residuals (least-squares minimum variance datum adjustment) is:
$$\text{shift}_{mean} = -\overline{\Delta H} = -\frac{1}{N} \sum_{i=1}^N \Delta H_i$$

#### Step 3: Post-Calibration Residuals and RMSE Drop
For all points $i \in \{1, \dots, N\}$, the calibrated metrics are:
$$H_{scan, cal, i} = H_{scan, i} + \text{shift}$$
$$\Delta H_{cal, i} = H_{scan, cal, i} - H_{gcp, i} = \Delta H_i + \text{shift}$$
$$\Delta 3\text{D}_{cal, i} = \sqrt{\Delta E_i^2 + \Delta N_i^2 + \Delta H_{cal, i}^2} = \sqrt{\Delta 2\text{D}_i^2 + \Delta H_{cal, i}^2}$$

Statistical Accuracy Metrics Post-Calibration:
$$\text{RMSE}_{H, cal} = \sqrt{\frac{1}{N} \sum_{i=1}^N \Delta H_{cal, i}^2}$$
$$\text{RMSE}_{3D, cal} = \sqrt{\text{RMSE}_E^2 + \text{RMSE}_N^2 + \text{RMSE}_{H, cal}^2} = \sqrt{\text{RMSE}_{2D}^2 + \text{RMSE}_{H, cal}^2}$$

**Analytical Proof of RMSE Drop (Case B)**:
$$\sum_{i=1}^N \Delta H_{cal, i}^2 = \sum_{i=1}^N (\Delta H_i - \overline{\Delta H})^2 = \sum_{i=1}^N \Delta H_i^2 - N (\overline{\Delta H})^2$$
Dividing by $N$:
$$\text{RMSE}_{H, cal}^2 = \text{RMSE}_{H, raw}^2 - (\overline{\Delta H})^2$$
Because $(\overline{\Delta H})^2 \ge 0$, $\text{RMSE}_{H, cal} \le \text{RMSE}_{H, raw}$ unconditionally.
When systematic vertical bias exists (e.g. drone RTK geoid offset error of $0.45$ m):
- Raw: $\overline{\Delta H} = +0.450$ m, $\text{RMSE}_{H, raw} = 0.451$ m (Grade C).
- Calibrated: $\text{shift} = -0.450$ m, $\overline{\Delta H}_{cal} = 0.000$ m, $\text{RMSE}_{H, cal} = 0.022$ m = $2.2$ cm (Grade A RTK Survey-Grade $\le 5.0$ cm).
- $\text{RMSE}_{3D}$ correspondingly drops from $0.453$ m to $0.038$ m.

---

### 2.2 Zero-Destruction Persistence Architecture

#### Step 4: The Zero-Destruction Rule
- **Rule Definition**: Original photogrammetric point cloud (`.las`, `.ply`), textured mesh (`mesh.obj`, `mesh.mtl`), 3D tilesets (`tileset.json`, `*.b3dm`, `*.glb`), and DSM heightfield rasters (`_dsm_cache_v5.npz`) on disk **must never be destructively overwritten or modified**.
- **Rationale**:
  1. *Reversibility*: A surveyor must be able to switch TBM benchmarks or revert to raw uncalibrated ellipsoid heights at any time.
  2. *Data Integrity*: Photogrammetric raw reconstruction outputs remain 100% reproducible and tamper-free.
  3. *Performance*: Zero disk rewrites of multi-gigabyte point clouds; calibration takes $< 5$ milliseconds to persist and applies instantly at runtime.

#### Step 5: Persistence Storage Schema
When `apply_tbm_calibration: true` is sent to `/api/survey/gcp-qa`:
1. **SQLite Database** (`data/scans_priority.db`):
   Store inside `scans.extra_json`:
   ```json
   "tbm_calibration": {
       "calibrated_shift_m": -0.1824,
       "selected_tbm_id": "TBM-01",
       "tbm_mode": "designated",
       "calibrated_at": 1730352900,
       "before_rmse_h_m": 0.1842,
       "after_rmse_h_m": 0.0215,
       "before_rmse_3d_m": 0.1878,
       "after_rmse_3d_m": 0.0412,
       "calibrated_by": "engineer@gatheren.cloud"
   },
   "vertical_datum_offset": -0.1824
   ```
2. **Disk Mirror** (`<project_dir>/scan_meta.json`):
   Update `scan_meta.json` with the exact same `tbm_calibration` object and `vertical_datum_offset`.
   This guarantees persistence survives database rebuilds or environment redeployments.
3. **Database Method**:
   Implement `set_scan_vertical_datum_calibration(self, scan_id: str, calibration_data: Optional[Dict[str, Any]])` in `ScanDatabase` in `pc_worker/priority_queue.py` following the exact pattern of `set_scan_home_view`.

---

### 2.3 Downstream Consumption Architecture
Implement a unified resolver helper in `pc_worker/surveying/dsm_and_volume.py`:
```python
def _resolve_vertical_datum_shift(
    self, scan_id: str, payload: Optional[Dict[str, Any]] = None, scan: Optional[Dict[str, Any]] = None
) -> float:
    # 1. Highest Priority: Explicit override in request payload
    if payload and payload.get("vertical_datum_offset") is not None:
        val = safe_float(payload.get("vertical_datum_offset"))
        if val is not None:
            return val
    # 2. Second Priority: Persistent scan metadata from DB
    sc = scan or (self.db.get_scan(scan_id) if hasattr(self, "db") and self.db else None) or {}
    shift = safe_float(sc.get("vertical_datum_offset"))
    if shift is not None:
        return shift
    cal = sc.get("tbm_calibration")
    if isinstance(cal, dict) and cal.get("calibrated_shift_m") is not None:
        val = safe_float(cal.get("calibrated_shift_m"))
        if val is not None:
            return val
    # 3. Third Priority: scan_meta.json on disk
    proj_dir = sc.get("project_dir") or os.path.join(SCANS_ROOT_DIR, scan_id)
    if proj_dir and os.path.isdir(proj_dir):
        meta_fp = os.path.join(proj_dir, "scan_meta.json")
        if os.path.isfile(meta_fp):
            try:
                with open(meta_fp, "r", encoding="utf-8") as mf:
                    m = json.load(mf)
                val = safe_float(m.get("vertical_datum_offset", m.get("tbm_calibration", {}).get("calibrated_shift_m")))
                if val is not None:
                    return val
            except Exception:
                pass
    return 0.0
```

#### Consumption by Downstream Survey Endpoints:
| Endpoint | Function & File | How Active Shift is Applied | Downstream Effect |
|---|---|---|---|
| `/api/survey/volume` | `calculate_cut_fill_volume` (`dsm_and_volume.py`) | $z_{surf, cal} = z_{surf} + \text{shift}$ | For `custom_plane`, volume is computed against true calibrated grade $Z_0$. Boundary vertex heights $twvd2001\_h\_m$ reflect calibrated elevation. |
| `/api/survey/contours` | `generate_civil3d_contours` (`contours_and_cad.py`) | $sub\_grid = sub\_grid + \text{shift}$ | Contour slicing elevations (e.g. 120.0m, 120.5m), labels, DXF text, and PDF title blocks are placed at true calibrated elevations. |
| `/api/survey/profile` | `compute_cross_section_profile` (`contours_and_cad.py`) | $z_{curr, cal} = z_{curr} + \text{shift}_1$, $z_{base, cal} = z_{base} + \text{shift}_2$ | Cross-section profiles reflect true site elevations; epoch comparison $\Delta Z$ is free of false vertical datum bias. |
| `/api/survey/drainage` | `compute_drainage_and_slope` (`dsm_and_volume.py`) | $Z_{spill, cal} = Z_{spill} + \text{shift}$ | Spill elevations of ponding depressions report calibrated water spill heights. Slope % is invariant. |
| `/api/survey/surface-qa` | `compute_surface_flatness_and_plumbness_qa` (`construction_qa.py`) | $\delta = (Z_{scan} + \text{shift}) - FFL$ | Slab levelness and elevation tolerance checks are accurately evaluated against site bench elevation. |

---

## 3. Caveats

1. **Horizontal Rigidity Assumption**:
   - 1-Click TBM calibration addresses vertical datum bias ($\Delta H$). It intentionally does not adjust Easting or Northing coordinates ($\Delta E, \Delta N$). 3D similarity transformation (Helmert 7-parameter) should be reserved for global multi-point control adjustments.
2. **Boundary Points Outside DSM Extent**:
   - GCP points that fall outside the photogrammetric footprint or where `is_inside_hull == False` must be excluded from the TBM shift computation, otherwise edge extrapolation noise could corrupt the datum calibration.
3. **Ellipsoidal Geoid Override Interaction**:
   - If `geoid_offset_override` is passed, the orthometric height conversion is applied first ($H = h - N$), and then $\text{shift}_{tbm}$ is applied ($H_{final} = H + \text{shift}_{tbm}$). Total effective offset: $\Delta Z_{total} = -N + \text{shift}_{tbm}$.
4. **Reverting Calibration**:
   - A reset option (`reset_calibration: true` or `apply_tbm_calibration: false` with `persist_reset: true`) must be provided to clear the stored offset back to $0.000$ m without requiring manual database editing.

---

## 4. Conclusion

1. **Analytical Formulae Verified**:
   - When a TBM point $k$ is designated: $\text{shift}_{tbm} = -\Delta H_k = H_{gcp, k} - H_{scan, k}$.
   - When network-wide: $\text{shift}_{mean} = -\overline{\Delta H} = -\frac{1}{N} \sum (H_{scan, i} - H_{gcp, i})$.
   - Residual update: $\Delta H_{cal, i} = \Delta H_i + \text{shift}$.
   - Calibrated vertical RMSE: $\text{RMSE}_{H, cal} = \sqrt{\text{RMSE}_{H, raw}^2 - (\overline{\Delta H})^2}$, systematically dropping $\text{RMSE}_H$ to the pure random noise floor $\sigma_H$.
2. **Persistence Specification**:
   - Use SQLite `scans.extra_json` (`tbm_calibration`, `vertical_datum_offset`) paired with `<project_dir>/scan_meta.json`.
   - Adhere strictly to the zero-destruction rule: never touch `.las`, `.ply`, `.obj`, `.glb`, or `.npz` files on disk.
3. **Downstream Unification**:
   - Unify active shift retrieval via `_resolve_vertical_datum_shift(scan_id, payload, scan)` across `/api/survey/volume`, `/api/survey/contours`, `/api/survey/profile`, `/api/survey/drainage`, and `/api/survey/surface-qa`.
4. **API Interface Contract**:
   - Request: `{ scan_id, points: [{ id, easting, northing, elevation, is_tbm }], apply_tbm_calibration: bool, selected_tbm_id: str }`
   - Response: `{ status: "ok", gcp_residuals: [{ id, de, dn, dh, d2d, d3d, is_tbm }], rmse_e, rmse_n, rmse_h, rmse_2d, rmse_3d, tbm_applied: bool, tbm_shift_m: float, before_calibration: {...}, after_calibration: {...}, persisted: bool }`

---

## 5. Verification Method

To independently verify the implementation:

### 5.1 Unit Tests
Run the automated test suite:
```powershell
python -m unittest tests.test_civil_surveying_e2e
python -m unittest tests.test_gathering_scans_suite.TestGatheringScansSuite.test_07_modular_architecture_strict_5000_line_ceiling
```

### 5.2 Synthetic Mathematical Oracle Test
Verify that for a 4-point network with known vertical bias $+0.250$ m:
- Points:
  - $CP_1$: $H_{gcp} = 100.00$, $H_{scan} = 100.27 \implies \Delta H = +0.27$
  - $CP_2$: $H_{gcp} = 102.50$, $H_{scan} = 102.73 \implies \Delta H = +0.23$
  - $CP_3$: $H_{gcp} = 105.00$, $H_{scan} = 105.26 \implies \Delta H = +0.26$
  - $CP_4$: $H_{gcp} = 101.00$, $H_{scan} = 101.24 \implies \Delta H = +0.24$
- Network Mean: $\overline{\Delta H} = +0.250$ m.
- Raw: $\text{RMSE}_{H, raw} = \sqrt{\frac{0.0729 + 0.0529 + 0.0676 + 0.0576}{4}} = \sqrt{0.06275} \approx 0.2505$ m ($25.0$ cm $\implies$ Grade C).
- Calibrated ($\text{shift} = -0.250$ m):
  - $\Delta H_{cal}$: $[+0.02, -0.02, +0.01, -0.01]$
  - $\text{RMSE}_{H, cal} = \sqrt{\frac{0.0004 + 0.0004 + 0.0001 + 0.0001}{4}} = \sqrt{0.00025} \approx 0.0158$ m ($1.58$ cm $\implies$ Grade A).
- Verify that $\text{RMSE}_{H, cal}$ drops from $25.05$ cm to $1.58$ cm, and $\Delta H_{cal}$ has zero mean bias.

### 5.3 Invalidation Conditions
The design is invalidated if:
1. Applying TBM calibration modifies or truncates any `.las`, `.ply`, `.obj`, or `.npz` file on disk.
2. $\text{RMSE}_{H, cal} > \text{RMSE}_{H, raw}$ when using network-wide mean calibration.
3. `/api/survey/volume` or `/api/survey/contours` fails to reflect the calibrated shift when `vertical_datum_offset` is active.
4. Any source file exceeds the 5,000-line modular ceiling.
