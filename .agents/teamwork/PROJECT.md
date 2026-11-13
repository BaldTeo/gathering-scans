# Project: GatheringScans Surveying, Construction QA & Scan-to-BIM Enhancement

## Architecture
- **Backend Architecture**: Modular mixins unified under `SurveyingEngine` (`pc_worker/surveying_engine.py`) and exposed via `pc_worker/server_api_routes.py` and `server.py`.
  - `pc_worker/surveying/dsm_and_volume.py`: DSM, volume, GCP QA, slope/drainage.
  - `pc_worker/surveying/contours_and_cad.py`: Contours, PDF report, profile, stationing.
  - `pc_worker/surveying/categorization_io.py`: Mesh loading, categorization cache, manual overrides.
  - `pc_worker/surveying/categorization_heuristics.py`: Geometric classifiers for roads, trees, walls, water.
  - `pc_worker/surveying/construction_qa.py` (NEW): Flatness/Plumbness, Utility Tracer, RTK Stakeout export.
  - `pc_worker/surveying/scan_to_bim.py` (NEW): Geometric primitive fitting, IFC SPF (ISO-10303-21), 3D DXF, OBJ/MTL.
- **Frontend Architecture**: Modular scripts loaded sequentially in `web/index.html` and cached via `web/sw.js` (APP_SHELL).
  - All files strictly under 5,000 lines.
  - `web/src/09-construction-survey-and-bim.js` (NEW): Hosts Construction QA, Stationing AEA, Utility Tracer, RTK Stakeout, Scan-to-BIM 3D preview, Compare View ΔV Takeoff.
  - `web/survey-bim.css` (NEW): Stylesheet for QA tables, gauges, print site sheet.
  - Non-intrusive UI container: Single dock button `btnDockCivilQa` (`品管 / QA`), side panel tabs, sub-tabs in Volume/Profile/Categorization inspectors, and Compare View `#compareVolumeDrawer`.
  - 100% project-agnostic settings: All calculation parameters user-selectable in UI.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Least-Squares Reference Plane | SVD/Normal Equations best-fit plane for cut/fill volume | M1 | R2 |
| 2 | Mass Conservation Schedule | Bank (BCM), Loose (LCM), Compacted (CCM), Conserved Mass | M1 | R2 |
| 3 | Dump Truck Load Estimator | Volume & weight limited truck trips, net import/export balance | M1 | R2 |
| 4 | Geoid Offset Sync & Override | Sync UTM51N (17.20m) / UTM50N (16.80m) & user override | M1 | R2 |
| 5 | True 3D GCP Residuals | ΔE, ΔN, ΔH, Δ2D, Δ3D, RMSE_E, RMSE_N, RMSE_H, RMSE_3D | M2 | R2 |
| 6 | 1-Click TBM Datum Calibration | Zero out vertical benchmark bias across scan datum | M2 | R2 |
| 7 | Centerline Stationing (0K+000) | Polyline chainage, interval & swath width sampling | M3 | R2 |
| 8 | Parametric Design Template & AEA | Roadway/trench template overlay & Average-End-Area volume | M3 | R2 |
| 9 | Custom Slope Tiers & Drainage | User-selectable slope classification tiers | M3 | R2 |
| 10 | Ponding Depression Takeoff | Sinks, spill pour points, water volume ($V_{water}$ m³), depth, area | M3 | R2 |
| 11 | 3D Flatness & Plumbness QA | Deviation heatmap, Pass Rate %, Max High/Low, Plumb Tilt ratio | M4 | R3 |
| 12 | Open-Trench Utility 3D Tracer | Invert/crown, gradient (% & 1:N), depth of cover, CSV & 3D DXF | M4 | R3 |
| 13 | RTK Stakeout Export strictly E N Z | PtID, Easting, Northing, Elevation, Code order & printable sheet | M4 | R3 |
| 14 | Compare View ΔV Volume Takeoff | Polygon-bounded epoch-to-epoch cut/fill volume takeoff | M4 | R3 |
| 15 | Scan-to-BIM Geometric Primitives | Simplified geometric solids (buildings, walls, roads, trees, water, pipes)| M5 | R4 |
| 16 | Scan-to-BIM 3D Studio & Export | Interactive Three.js preview, IFC SPF (ISO-10303-21), 3D DXF, OBJ | M5 | R4 |
| 17 | Non-Intrusive UI Containers | Minimalist dock button, tabbed side panel & drawers | M1–M5 | R1 |
| 18 | Strict 5,000-Line Ceiling | Strict compliance across all 49+ frontend and backend files | M1–M6 | R5 |
| 19 | Automated 4-Tier Test Suite | Feature, Boundary, Cross-Feature, Real-World test suite | M6 | Acceptance Criteria |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Core Surveying & Earthwork Math | Least-squares plane, BCM/LCM/CCM, Mass conservation, Truck estimator, Geoid catalog sync | none | DONE |
| M2 | Control Alignment & 3D GCP Calibration | True 3D GCP residuals (ΔE, ΔN, ΔH, RMSE_3D), 1-click TBM calibration | M1 | DONE |
| M3 | Stationing Profile & Drainage Ponding | 0K+000 stationing, transverse slicing, parametric template, AEA volume, slope tiers, depression water volume | M1 | DONE |
| M4 | Construction QA, Utility Tracer & Stakeout | Flatness/Plumbness heatmap & tilt, Utility tracer CSV/DXF, RTK stakeout strictly E N Z, Compare ΔV takeoff, UI containers | M1, M2, M3 | DONE |
| M5 | Scan-to-BIM Simplified Geometric Model | Primitive fitting, interactive 3D studio preview, IFC SPF, 3D DXF, OBJ/MTL export | M1, M4 | DONE |
| M6 | Final Verification & Coverage Hardening | 100% pass on tests, 5,000-line ceiling, real-world scan datasets, Tier 5 adversarial tests | M1–M5 | DONE |
| M7 | Real Public Utilities GIS Integration | Live unauthenticated APIs (New Taipei ArcGIS REST, Taipei 3D GIS/dig), MOI NGIS GML 3.1.1/KML/GeoJSON, 3D subsurface renderer, zero fake data | M5, M6 | DONE |


## Interface Contracts
### Cut/Fill Volume (`/api/survey/volume`)
- Request payload:
  `{ scan_id, points, base_mode: "best_fit_plane"|"custom_plane"|"triangulated_boundary", custom_elevation, density_t_m3, swell_factor, shrinkage_factor, truck_volume_m3, truck_max_tonnes, geoid_offset_override }`
- Response:
  `{ status: "ok", cut_volume_bcm, fill_volume_bcm, cut_volume_lcm, fill_volume_ccm, conserved_cut_mass_t, truck_loads_cut, truck_limiting_factor, net_volume_bcm, net_truck_loads, best_fit_plane: { a, b, c, slope_pct, azimuth_deg } }`

### GCP QA & TBM Calibration (`/api/survey/gcp-qa`)
- Request payload:
  `{ scan_id, points: [{ id, easting, northing, elevation, is_tbm }], apply_tbm_calibration: bool, selected_tbm_id: str }`
- Response:
  `{ status: "ok", gcp_residuals: [{ id, de, dn, dh, d2d, d3d, is_tbm }], rmse_e, rmse_n, rmse_h, rmse_2d, rmse_3d, tbm_applied: bool, tbm_shift_m }`

### Centerline Stationing & AEA Profile (`/api/survey/stationing`)
- Request payload:
  `{ scan_id, alignment_points: [[e, n], ...], station_interval_m, swath_width_m, template: { roadway_width_m, crown_slope_pct, cut_slope, fill_slope } }`
- Response:
  `{ status: "ok", total_length_m, stations: [{ station_code, cumulative_m, ground_profile, design_profile, cut_area_m2, fill_area_m2 }], total_cut_volume_aea_m3, total_fill_volume_aea_m3 }`

### Drainage & Ponding Depressions (`/api/survey/drainage`)
- Request payload:
  `{ scan_id, bounds, custom_slope_tiers: [{ id, min_pct, max_pct, label, color }], compute_ponding: bool }`
- Response:
  `{ status: "ok", slope_distribution, ponding_depressions: [{ id, centroid, max_depth_m, surface_area_m2, water_volume_m3, spill_elevation_m }] }`

### Surface Flatness & Plumbness QA (`/api/survey/surface-qa`)
- Request payload:
  `{ scan_id, region_points, reference_plane: "horizontal"|"vertical_plumb"|"best_fit", target_elevation, wall_baseline, tolerance_mm }`
- Response:
  `{ status: "ok", pass_rate_pct, tolerance_mm, max_high: { e, n, h, deviation_mm }, max_low: { e, n, h, deviation_mm }, plumb_tilt_ratio, plumb_tilt_mm_per_m, heatmap_grid }`

### Open-Trench Utility Tracer (`/api/survey/utility-trace`)
- Request payload:
  `{ scan_id, centerline_points: [[e, n, h], ...], reference_type: "crown"|"invert", pipe_diameter_m, utility_category }`
- Response:
  `{ status: "ok", total_3d_length_m, total_2d_length_m, average_gradient_pct, gradient_ratio, segments: [{ p1, p2, length_3d, invert_p1, invert_p2, crown_p1, crown_p2, gradient_pct, depth_of_cover_m }], dxf_url, csv_url }`

### RTK Stakeout Export (`/api/survey/stakeout-export`)
- Request payload:
  `{ scan_id, points: [{ id, easting, northing, elevation, code }] }`
- Output format: CSV strictly ordered as `PtID,Easting,Northing,Elevation,Code` and printable HTML field sheet.

### Scan-to-BIM (`/api/survey/scan-to-bim`)
- Request payload:
  `{ scan_id, element_categories: ["buildings", "walls", "roads", "trees", "water", "pipes"] }`
- Response:
  `{ status: "ok", primitives_count, primitives: [{ id, category, type, geometry, properties }], ifc_url, dxf_url, obj_url }`

## Code Layout
- `pc_worker/surveying/dsm_and_volume.py`: Volume math, Least-Squares Plane, Mass Conservation, GCP QA, Drainage/Ponding
- `pc_worker/surveying/contours_and_cad.py`: Contours, Stationing alignment slicing & Average-End-Area
- `pc_worker/surveying/construction_qa.py`: Flatness/Plumbness Inspector, Utility Tracer, RTK Stakeout export
- `pc_worker/surveying/scan_to_bim.py`: Geometric primitive generators, IFC SPF exporter, 3D DXF solid exporter, OBJ exporter
- `pc_worker/server_api_routes.py`: API route bindings for civil survey endpoints
- `web/src/01-core-state.js`: Global surveying state & CRS catalog
- `web/src/09-construction-survey-and-bim.js`: Frontend implementation for all new UI tools
- `web/survey-bim.css`: Styling for QA panels, gauges, and print site sheet
- `web/index.html` & `web/sw.js`: Asset registration and cache busting
- `tests/test_gathering_scans_suite.py`: Automated regression and unit test suite

## UI/UX Strict Guidelines
1. **Zero Emojis**: Never use Unicode emojis in headings, badges, or buttons. Use inline SVG icons matching the minimalist icon system.
2. **Theme Architecture**: Always use CSS custom properties (`var(--bg-surface)`, `var(--text-main)`, etc.) for dark & light theme compatibility. Never hardcode dark-only background colors in JS templates. Screenshots must verify both themes.
3. **Strict 1-Word Buttons & Minimalist Text**: Every button label must contain at most 1 word (plus an SVG icon). Remove explanatory paragraphs and walls of text.
