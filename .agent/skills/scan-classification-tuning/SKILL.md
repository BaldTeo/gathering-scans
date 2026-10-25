---
name: scan-classification-tuning
description: Diagnose, tune, and verify 3D photogrammetric scan surface and object classification (Trees, Walls/Fences, Roads/Paths, Water Voids, and Studio UI overlays) in pc_worker/surveying_engine.py and web/app.js. Use whenever improving detection recall/precision, fixing false positives (e.g. lamp posts or canopies), or updating categorization persistence.
---

# 3D Photogrammetric Scan Classification Tuning (`GatheringScans`)

Use this skill whenever modifying `SurveyingEngine.categorize_scan_surfaces_and_objects` in `pc_worker/surveying_engine.py`, `/api/survey/categorize*` in `server.py`, or the 3D Categorize Scan overlay in `web/app.js`.

---

## 1. Core Geometric & Spectral Invariants in Photogrammetric Meshes

Photogrammetric meshes (`textured_model.glb`) reconstruct solid surfaces well (trunks, walls, roads) but often leave thin foliage patchy and sky-lit metal/concrete slightly blue-tinted. Apply these physical invariants:

### A. Trees vs. Lamp Posts, Utility Poles, Bollards & Shrubs
1. **Trees Can Never Be Square or Planar (`R2` / `R4` Azimuthal Harmonics)**:
   - Compute 2-fold ($R_2 = |\langle e^{i 2\theta_n} \rangle|$) and 4-fold ($R_4 = |\langle e^{i 4\theta_n} \rangle|$) horizontal normal concentration on breast-height (`0.55m..1.85m`) trunk triangles.
   - Square pillars, flat fence posts, and building corners have high $R_2 > 0.30$ or $R_4 > 0.30$.
   - *Low-Poly Thin Stem Exception*: Genuine slender brown tree trunks (`med_rb >= 0.042`, < 50 triangles) may exhibit noisy $R_4$ up to `0.38`, provided 2-fold planarity stays low ($R_2 \le 0.23$) and radial normal dispersion exceeds `0.38`.
2. **Brown Bark Trunk + Green Canopy Core Directly Overhead**:
   - Real trees have **warm brown bark** at breast height (`R - B >= 0.038`, `sat >= 0.118`) and/or **green canopy foliage directly above their own stem axis** (`r <= 0.95m`, `z_rel >= 1.30m`, elevated `ExG >= 0.025`).
   - Lamp posts, utility poles, and playground posts have **achromatic grey/silver stems** (`sat < 0.118`, `R - B < 0.038`, `ExG < 0.025`) and only touch neighboring tree canopies at wide radii (`r = 1.2m..2.4m`).
   - **Rule**: Never allow an "occluded giant canopy" exemption (`tree_h_m >= 5.0m`) to bypass achromatic trunk rejection if `>= 65` bare grey trunk triangles are visible at breast height without a tight overhead green core (`r <= 0.85m`).
3. **Neck Continuity (`0.78m..1.18m`) Against Shrubs & Bollards Under Overhanging Branches**:
   - Low shrubs, boulders, or bollards sitting beneath an overhanging tree canopy have a wide base (`0.18m..0.75m`, `>= 180` triangles) with a vertical gap (`< 12` steep triangles or `< 3.5%` of base count) in the `0.78m..1.18m` neck zone. Reject candidates with this neck gap.
4. **Small Saplings (`1.65m..2.5m`) & Young Grove Trees**:
   - **Height Estimation**: Never estimate local tree height from the 92nd percentile of *all* triangles within `r <= 1.25m`—flat ground triangles dominate the disk around a slender trunk and pull the percentile down to ground level. Always compute the **95th percentile of elevated (`z - ground >= 0.85m`) triangles** (with fallback to `r <= 0.65m`).
   - **Tight Breast-Height Search**: When `pre_stem_xy` is already known from stem clustering, query `bh_tree.query_ball_point` at a tight radius (`r = 0.78m`, not `1.20m`) so Pratt circle fitting does not jump from a slender sapling onto a nearby shrub or rock.
   - **Crown Raster & Road Proximity Exemptions**: Verified cylindrical stems (`is_verified_cyl`) with warm bark and clean neck counts (`4 <= n_neck_fin <= 45`) must not be discarded by 2D rasterized `crown_diam_m < 1.08m` or `road_near_12m_grid` proximity (street/median trees).

---

### B. Multi-Sided Fences & Building Facades vs. Tree Canopies
1. **Never Rely on Global Connected-Component PCA Thickness Alone**:
   - A 4-sided construction fence enclosure, rectangular toilet block, or L/U-shaped courtyard building forms a single connected component whose global `sigma_plane` is `0.6m..3.9m`.
   - Always group vertical faces into `30°` strike bins (`0°..180°`) and run recursive **coplanar splitting** (`_extract_coplanar_wall_segments`):
     - Split along **strike (`proj_s`)** first whenever `span_s >= 5.0m` and `sigma_plane > 0.34m` (separating stepped parallel facades or courtyard wings).
     - Split along **normal (`proj_n`)** across empty gaps (`>= 0.45m`) or bimodal thickness peaks.
2. **Outdoor Corrugated Metal & Tall Concrete Facades**:
   - Sky-lit grey/silver corrugated metal fences reflect blue skylight (`rb_diff = -0.115 .. +0.048`, `sat < 0.138`, `exg < 0.026`).
   - Treat `is_achromatic_wall`, `is_bright_white_wall` (`luma > 0.62, sat < 0.10`), and `is_tall_facade` (`wall_h_m >= 2.8m, span >= 2.4m, sigma_plane <= 0.35m`) as valid structural walls even when bordering park trees, while strictly enforcing `exg < 0.036` and `steep_grn_frac_grid < 0.26` to block false walls inside green tree canopies.
3. **1D Strike-Interval Overlap Deduplication**:
   - Two nearly parallel wall segments (`angle_diff < 18°`, normal distance `< 1.15m`) should only be merged/deduplicated if their 1D projections along the strike axis overlap by `>= 32%` of the shorter segment's length.

---

### C. Roads/Paths & Water Voids
1. **Road vs. Wall Apron Separation**:
   - Erode road masks within `0.35m` of detected structural wall footprints (`wall_foot_mask`) so concrete fence aprons do not bleed into wall bases.
2. **Boundary-Clipped Pond Voids**:
   - Photogrammetric water bodies often appear as dark/olive horizontal basin shelves clipped by the scan boundary (`boundary_touch_frac <= 0.72`). Evaluate bank elevation contrast (`10cm..180cm`) on interior non-boundary perimeter pixels (`interior_Valid >= 12`).

---

## 2. Server Persistence & Studio UI Contract

1. **Dual-Path Server Cache**:
   - Every categorization payload must be saved to both:
     - `<project_dir>/_categorization_cache_v3.json`
     - `data/categorization_cache/<scan_id>_categorization_v3.json` (committed to Git so the Hostinger VPS serves identical results without re-running heavy 3D mesh geometry).
2. **Default Visibility & Label Controls**:
   - `overlay_visible_default` must remain `false` (`STATE.categorizeOverlayVisible = false` on scan load).
   - Maintain independent toggles for **Show/Hide 3D Overlays** (`#btn-toggle-cat-overlay` / `#btn-top-cat-visibility`) and **Show/Hide 3D Labels Only** (`#btn-toggle-cat-labels`, `STATE.categorizeLabelsVisible`).
3. **Manual Override Preservation (`manual_overrides`)**:
   - User edits via `POST /api/survey/categorize/override` (`added_trees`, `added_walls`, `added_roads`, `added_water`, `removed_ids`) are stored in `manual_overrides` inside the cache JSON and **must** be re-applied via `_apply_categorization_manual_overrides()` even when `force=true` recomputes the algorithmic base.

---

## 3. Multi-Scan Diagnostic & Subagent Verification Loop

Whenever tuning thresholds in `pc_worker/surveying_engine.py`, never tune on a single scan in isolation. Run the 3-stage verification loop across all 5 reference scans:
- `edited_qihu_unified_merged_scan_4_scans__edited_372953` (4-sided construction fence + park trees + saplings + pond + curved road)
- `rosepark_20260918_merged` (dense park trees + small/large trees + 4-sided toilet block + utility poles/play structures)
- `ntudorm_20260915_baseline` & `ntudorm_20260917_foundation` (perimeter/courtyard dorm buildings + central parking lot + perimeter trees)
- `QuChi261016_Trees` (dense natural forest grove without false walls)

### Recommended Subagent Loop:
1. **Diagnostic Researcher (`research`)**: Inspect exact per-candidate feature values (`R2, R4, med_rb, med_sat, med_exg, n_canopy_tight, n_neck_fin, sigma_plane, span_s`) for missed targets and false positives before changing any threshold.
2. **Coding Worker (`self`)**: Implement targeted changes and regenerate all `data/categorization_cache/*_categorization_v3.json` files.
3. **Harsh Reviewer (`research` / `self`)**: Audit metrics across all reference scans and capture headless Studio 3D screenshots to verify zero regressions before deployment.
