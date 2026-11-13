# Milestone 2 (M2) Frontend Investigation Handoff Report
**Module**: Control Alignment, 3D GCP Calibration, Interactive 3D Vectors & Civil QA Export  
**Author**: explorer_m2_3 (Teamwork Explorer)  
**Date**: 2026-10-31T05:35:00Z  
**Target Audience**: Orchestrator, Worker M2, Reviewer M2, Challenger M2  

---

## 1. Observations

### 1.1 Strict 5,000-Line Modular Architecture Ceiling & Headroom
Direct line count inspection across the repository revealed the following file lengths:

| File Path | Current Lines | 5,000-Line Ceiling Headroom | Risk Assessment |
|-----------|---------------|-----------------------------|-----------------|
| `web/src/03-studio-core.js` | **4,997 lines** | **3 lines** | 🚨 Critical: DO NOT TOUCH |
| `web/src/05-studio-civil-inspectors.js` | **4,988 lines** | **12 lines** | 🚨 Critical: DO NOT TOUCH |
| `web/src/08-advanced-surveying-and-qa.js` | **4,852 lines** | **148 lines** | ⚠️ Severe: Cannot hold full M2 UI (~350 lines) |
| `web/src/04-studio-lasso-and-edits.js` | **4,940 lines** | **60 lines** | ⚠️ High: DO NOT MODIFY |
| `web/src/06-studio-align-and-optimizer.js` | **3,982 lines** | **1,018 lines** | Medium headroom |
| `web/src/09-construction-survey-and-bim.js` | **219 lines** | **4,781 lines** | 🟢 Optimal Target Module |
| `web/app.css` | **4,277 lines** | **723 lines** | Safe for small rules |
| `web/survey-bim.css` | **0 lines (not created yet)** | **5,000 lines** | 🟢 Planned dedicated stylesheet |

In `tests/test_gathering_scans_suite.py`, lines 364–385:
```python
364:     def test_07_modular_architecture_strict_5000_line_ceiling(self):
365:         """Verify all source files (.py, .js, .css, .html) strictly obey the < 5,000-line modular limit."""
366:         checked = 0
367:         for root, dirs, files in os.walk(BASE_DIR):
...
378:                     self.assertLess(
379:                         line_count,
380:                         5000,
381:                         f"File {os.path.relpath(fp, BASE_DIR)} has {line_count} lines (exceeds 5,000-line ceiling)",
382:                     )
```
Any addition of more than 148 lines to `08-advanced-surveying-and-qa.js` or more than 12 lines to `05-studio-civil-inspectors.js` will cause `test_07_modular_architecture_strict_5000_line_ceiling` to **fail immediately**, blocking git push and deployment.

### 1.2 Frontend Script Loading Order in `web/index.html`
Lines 2390–2402 of `web/index.html`:
```html
2390:   <!-- Main GatheringScans Bilingual Translation & Modular Application Logic (< 5,000 lines per module) -->
2391:   <script src="/i18n.js?v=20261031_v218"></script>
2392:   <script src="/src/01-core-state.js?v=20261031_v218"></script>
2393:   <script src="/src/02-map-and-timeline.js?v=20261031_v218"></script>
2394:   <script src="/src/03-studio-core.js?v=20261031_v218"></script>
2395:   <script src="/src/04-studio-lasso-and-edits.js?v=20261031_v218"></script>
2396:   <script src="/src/05-studio-civil-inspectors.js?v=20261031_v218"></script>
2397:   <script src="/src/06-studio-align-and-optimizer.js?v=20261031_v218"></script>
2398:   <script src="/src/07-compare-and-queue.js?v=20261031_v218"></script>
2399:   <script src="/src/08-advanced-surveying-and-qa.js?v=20261031_v218"></script>
2400:   <script src="/src/09-construction-survey-and-bim.js?v=20261031_v218"></script>
2401:   <script src="/app.js?v=20261031_v218"></script>
```
Crucially, `web/src/09-construction-survey-and-bim.js` is loaded **after** `08-advanced-surveying-and-qa.js` and **before** `app.js`.

### 1.3 Existing GCP QA Tool Call Chains & Event Dispatching
In `web/src/06-studio-align-and-optimizer.js` (line 3597):
```javascript
3597: else if (tool === "gcp_qa" && typeof openGcpAccuracyQaInspector === "function") openGcpAccuracyQaInspector();
```
In `web/src/04-studio-lasso-and-edits.js` (line 3226):
```javascript
3226: if (tool === "gcp_qa" && typeof handleGcpQa3DPick === "function") {
3227:   handleGcpQa3DPick(pt, twd);
3228:   return;
3229: }
```
In `web/index.html` (lines 992–1000):
```html
992: <button type="button" class="bim-dock-btn autodesk-measure-btn" id="btnDockGcpQa" data-tool="gcp_qa" data-dock="gcp_qa" title="控制點精度檢核報告 (RMSE_Z 與台灣測量精度分級)" ...>
```
In `web/src/08-advanced-surveying-and-qa.js` (lines 2293–2468):
- Implements `function clearGcpQaMarkers3D()`
- Implements `function renderGcpQaMarkers3D(points)`
- Implements `function parseGcpCsvInput(csvText)`
- Implements `function handleGcpQa3DPick(pt, twd)`
- Implements `async function runGcpAccuracyQaEvaluation(pointsInput = [])`
- Implements `function openGcpAccuracyQaInspector(qaResult = STATE.lastGcpQaResult)`

Because `web/src/08-advanced-surveying-and-qa.js` executes in standard global script scope (not wrapped in a self-executing function), all top-level functions attach directly to `window`.

### 1.4 Deficiencies of the Legacy GCP QA Implementation
1. **Vertical-Only Evaluation**:
   - Lines 2341, 2348, 2400–2404 only track `h_gcp`, `h_scan`, and `ΔH (cm)`. Horizontal coordinates `E` and `N` are collected but never evaluated for horizontal residual errors ($\Delta E, \Delta N, \Delta 2\text{D}, \Delta 3\text{D}$, $\text{RMSE}_E, \text{RMSE}_N, \text{RMSE}_{2D}, \text{RMSE}_{3D}$).
2. **No 1-Click TBM Vertical Datum Calibration**:
   - There is no mechanism to designate a control point as a TBM (Temporary Benchmark) reference point or to calculate/preview/apply a datum bias compensation shift.
3. **Primitive 3D Visualization**:
   - Lines 2315–2322 only draw a static 2D ring (`THREE.RingGeometry(0.35, 0.72, 24)`) on the ground.
   - Zero 3D vector arrows, no residual magnitude representation, no vector exaggeration scale, and no TBM marker distinction.
4. **Missing Industry Standard QA Metrics**:
   - No ASPRS 2014 Positional Accuracy Standards ($1.7308 \times \text{RMSE}_{2D}$ and $1.9600 \times \text{RMSE}_H$).
   - No Mean Bias reporting in the UI.

---

## 2. Logic Chain

### 2.1 Delegation & Ceiling Protection Logic
1. **Fact**: `web/src/08-advanced-surveying-and-qa.js` currently has 4,852 lines (148 lines headroom). Adding the full M2 suite (interactive residual table, TBM selection radios, summary card, 3D arrow builder, CSV exporter, print sheet) would require ~350–450 lines, immediately exceeding 5,000 lines.
2. **Fact**: `web/src/09-construction-survey-and-bim.js` currently has only 219 lines (headroom of 4,781 lines) and is dedicated to construction surveying, civil QA, and BIM.
3. **Fact**: `09` loads after `08` in `web/index.html`.
4. **Deduction**: In `09-construction-survey-and-bim.js`, assigning:
   ```javascript
   window.openGcpAccuracyQaInspector = openEnhancedGcpAccuracyQaInspector;
   window.handleGcpQa3DPick = handleEnhancedGcpQa3DPick;
   window.renderGcpQaMarkers3D = renderEnhancedGcpQaMarkers3D;
   window.clearGcpQaMarkers3D = clearEnhancedGcpQaMarkers3D;
   ```
   cleanly intercepts the dock button click from `06-studio-align-and-optimizer.js` (`btnDockGcpQa`) and 3D canvas picking from `04-studio-lasso-and-edits.js`.
5. **Conclusion**: `08-advanced-surveying-and-qa.js`, `05-studio-civil-inspectors.js`, and `03-studio-core.js` require **zero modifications**, guaranteeing 100% compliance with the 5,000-line ceiling.

### 2.2 UI & UX Component Architecture
The enhanced inspector should render into `showSidePanel(title, html)` with 6 logical sections:

```
┌─────────────────────────────────────────────────────────────────┐
│ 🎯 控制點與檢核點精度檢核 (3D GCP QA & TBM Calibration)         │
│ [Grade A: RTK 測量級 ≤ 5cm]  CRS: TWD97 [121] + TWVD2001        │
├─────────────────────────────────────────────────────────────────┤
│ 📊 統計精度總覽卡 (ASPRS & Civil Surveying Accuracy KPIs)       │
│ ┌───────────────┬───────────────┬───────────────┐               │
│ │ 3D RMSE       │ 平面 2D RMSE   │ 高程 RMSE_H   │               │
│ │ 3.4 cm        │ 2.1 cm        │ 2.7 cm        │               │
│ ├───────────────┼───────────────┼───────────────┤               │
│ │ ASPRS 95% 平面 │ ASPRS 95% 高程 │ 檢核點總數    │               │
│ │ 3.6 cm (r)    │ 5.3 cm (z)    │ N = 6 點      │               │
│ └───────────────┴───────────────┴───────────────┘               │
├─────────────────────────────────────────────────────────────────┤
│ ⚓ 1-Click TBM 水準基點高程校正 (Vertical Datum Calibration)     │
│ 基準點選擇: [🔘 全區平均偏差校正 (-4.2cm) | ⚪ CP-01 (TBM) ]   │
│ 即時預覽: 當前高程 RMSE: 7.2 cm → 校正後預估 RMSE: 1.8 cm       │
│ [⚡ 套用 TBM 高程校正]  (零破壞原始資料 · 僅套用執行期位移補償)  │
├─────────────────────────────────────────────────────────────────┤
│ 📝 控制點座標輸入與 3D 採樣                                     │
│ [點號, E, N, H, [is_tbm]] 文字輸入框                            │
│ [📊 計算 3D 精度]  [🎯 自動工區佈點]  [🖱️ 3D 點選採樣]          │
├─────────────────────────────────────────────────────────────────┤
│ 📋 3D 殘差檢核表 (Scrollable Table with TBM selection)          │
│ ID | TBM | E_gcp | N_gcp | H_gcp | dE | dN | dH | d2D | d3D | 狀態│
│ CP-01 [●] 304940 2757080  124.50  +1.2 -0.8 +2.1  1.4  2.5  PASS│
│ CP-02 [○] 304965 2757095  125.10  -2.1 +1.5 -3.2  2.6  4.1  PASS│
├─────────────────────────────────────────────────────────────────┤
│ 👁️ 3D 視角視覺控制                                             │
│ [✓] 顯示 3D 誤差殘差向量   向量放大倍率: [20x ▾]                │
│ [✓] 顯示點位標籤 (ID & 誤差)  [✓] 凸顯 TBM 水準點標記           │
├─────────────────────────────────────────────────────────────────┤
│ 📤 土木品管報告匯出                                             │
│ [📄 檢核報告證書 (HTML)]  [💾 下載 3D 殘差 CSV]  [🖨️ 列印檢核單] │
└─────────────────────────────────────────────────────────────────┘
```

### 2.3 3D Studio Error Vector Visualization Architecture
In Three.js studio coordinates:
- X-axis = $\text{Easting} - C_E$
- Y-axis = $\text{Elevation} - C_H$ (Upward)
- Z-axis = $C_N - \text{Northing}$ (Southward)

Given scan coordinate $(E_{\text{scan}}, N_{\text{scan}}, H_{\text{scan}})$ and GCP coordinate $(E_{\text{gcp}}, N_{\text{gcp}}, H_{\text{gcp}})$:
$$\Delta E = E_{\text{scan}} - E_{\text{gcp}}, \quad \Delta N = N_{\text{scan}} - N_{\text{gcp}}, \quad \Delta H = H_{\text{scan}} - H_{\text{gcp}}$$
In Three.js local space:
$$dx = \Delta E, \quad dy = \Delta H, \quad dz = -\Delta N$$
Total 3D residual magnitude:
$$L = \sqrt{\Delta E^2 + \Delta N^2 + \Delta H^2} = \sqrt{dx^2 + dy^2 + dz^2}$$

Because surveying residual errors are typically on the order of $0.01$–$0.08\text{ m}$ ($1$–$8\text{ cm}$), rendering them $1:1$ on a $100\text{ m} \times 100\text{ m}$ civil engineering site produces imperceptible vectors.
**Solution**: Provide a user-selectable exaggeration multiplier $S \in \{1, 10, 20, 50, 100\}$ (default $S = 20$).
Visual arrow length: $L_{\text{vis}} = L \times S$.
Direction vector:
$$\vec{u} = \frac{(dx, dy, dz)}{L}$$
Instantiate via `THREE.ArrowHelper(dir, origin, L_vis, colorHex, headLength, headWidth)`.

All 3D objects are added to a dedicated group:
```javascript
studioThree.gcpQaGroup = new THREE.Group();
studioThree.overlayGroup.add(studioThree.gcpQaGroup);
```
This ensures complete isolation: when the tool closes or another tool is activated, `clearEnhancedGcpQaMarkers3D()` disposes all geometries and materials and removes the group without affecting any mesh or other overlays.

### 2.4 1-Click TBM Vertical Calibration Workflow
1. **User Action**: The user selects a specific point as TBM (e.g. `CP-01` with certified elevation) or selects "Network Mean Bias".
2. **Live Preview**: Frontend computes:
   $$\Delta H_{\text{shift}} = \begin{cases} H_{\text{gcp, TBM}} - H_{\text{scan, TBM}} & \text{if TBM selected} \\ -\overline{\Delta H} & \text{if network mean} \end{cases}$$
   $$\text{calibrated } \Delta H_i = \Delta H_i + \Delta H_{\text{shift}}$$
   $$\text{calibrated } \text{RMSE}_H = \sqrt{\frac{1}{N}\sum (\text{calibrated } \Delta H_i)^2}$$
   The UI displays the diff: `當前 RMSE_H: 7.2 cm → 校正後預估 RMSE_H: 1.8 cm (系統提升 75%)`.
3. **Execution**: Clicking "⚡ 套用 TBM 高程校正" posts to `/api/survey/gcp-qa` with:
   ```json
   {
     "scan_id": "active_scan_id",
     "points": [...],
     "apply_tbm_calibration": true,
     "selected_tbm_id": "CP-01"
   }
   ```
4. **Non-Destructive Persistence**: The shift is recorded in the scan's session state and returned in the response (`tbm_shift_m: -0.054`). Original photogrammetric LAS/PLY and DSM rasters on disk remain completely unmodified.
5. **UI Update**: Residual table and 3D vectors immediately update to display post-calibration residuals, with an active pill: `✓ TBM 校正已生效 (-0.054 m) [復原 / Reset]`.

### 2.5 Civil Engineering QA Export (CSV & Printable Sheet)
1. **CSV Export**:
   - Includes full metadata header (Scan ID, CRS, Timestamp, ASPRS Accuracy metrics, TBM shift applied).
   - Standard columns: `PtID, Role, E_gcp, N_gcp, H_gcp, E_scan, N_scan, H_scan, dE_cm, dN_cm, dH_cm, d2D_cm, d3D_cm, Status`.
   - UTF-8 with BOM (`\ufeff`) for seamless Excel opening without Mojibake.
2. **Printable QA Certificate**:
   - Backend already generates `/api/reports/gcp_qa_{scan}_{ts}.html`.
   - Frontend will also provide a client-side `@media print` styled modal sheet for immediate browser printing (`Ctrl+P` / `window.print()`).

---

## 3. Caveats

1. **Local vs Global Coordinates**:
   - Three.js local coordinates use the scan center origin $(C_E, C_N, C_H)$. When points are picked or parsed, the backend provides `p.local = [E - C_E, H - C_H, C_N - N]`. If offline or when adding points client-side, the frontend must use `STATE.centerE`, `STATE.centerN`, `STATE.centerH` (or `studioThree.centerCoords`) to compute `local` positions.
2. **Three.js ArrowHelper Invalidation on Zero Length**:
   - If a point has perfect alignment ($\Delta 3\text{D} = 0$), `THREE.ArrowHelper` with zero length can produce `NaN` normalization vectors. The code must guard against $L < 0.0005\text{ m}$ by skipping arrow creation and showing only the target reticle.
3. **Three.js Resource Disposal**:
   - When updating or clearing 3D vectors (e.g. changing exaggeration scale slider), all geometries (`RingGeometry`, `CircleGeometry`, arrow cone/line) and materials in `studioThree.gcpQaGroup` must be explicitly disposed (`geom.dispose()`, `mat.dispose()`) to prevent GPU memory leaks across repeated calculations.
4. **Pre-flight Git Push Limit Warning**:
   - As documented in `ORIGINAL_REQUEST.md` (Follow-up 2026-10-31T04:36:23Z), local commits must proceed normally, but if `git push origin main` encounters rate limits, verification and deployment will rely on local server testing and direct VPS file synchronization.

---

## 4. Conclusion & Actionable Implementation Plan

### Recommended Implementation Structure for Worker Agent:
1. **Target File**: `web/src/09-construction-survey-and-bim.js` (currently 219 lines).
2. **Target Stylesheet**: Create `web/survey-bim.css` (or append scoped styles).
3. **Key Functions to Implement in `web/src/09-construction-survey-and-bim.js`**:
   - `openEnhancedGcpAccuracyQaInspector(qaResult)`: Renders full 6-card side panel.
   - `computeGcpResidualStats(points, tbmShiftM)`: Real-time math for ASPRS 95% and TBM preview.
   - `renderEnhancedGcpQaMarkers3D(points, options)`: 3D Three.js ArrowHelpers, ground reticles, TBM diamonds, and scale exaggeration.
   - `clearEnhancedGcpQaMarkers3D()`: Safe Three.js group disposal and cleanup.
   - `handleEnhancedGcpQa3DPick(pt, twd)`: Adds 3D clicked points to the CSV table and re-evaluates.
   - `exportGcpQaCsv(qaResult)`: Client-side UTF-8 BOM CSV download.
   - `printGcpQaCertificate(qaResult)`: Formatted printable inspection certificate.
4. **Hook Assignments at End of `web/src/09-construction-survey-and-bim.js`**:
   ```javascript
   window.openGcpAccuracyQaInspector = openEnhancedGcpAccuracyQaInspector;
   window.handleGcpQa3DPick = handleEnhancedGcpQa3DPick;
   window.renderGcpQaMarkers3D = renderEnhancedGcpQaMarkers3D;
   window.clearGcpQaMarkers3D = clearEnhancedGcpQaMarkers3D;
   ```
5. **Ceiling Safety Guarantee**:
   - `08-advanced-surveying-and-qa.js`: 0 new lines (remains 4,852).
   - `05-studio-civil-inspectors.js`: 0 new lines (remains 4,988).
   - `03-studio-core.js`: 0 new lines (remains 4,997).
   - `09-construction-survey-and-bim.js`: ~450 new lines (will be ~670 lines, well below 5,000).

---

## 5. Verification Method

### 5.1 Modular Ceiling Verification
Run the automated test suite to ensure all source files remain strictly below 5,000 lines:
```powershell
python -m unittest tests/test_gathering_scans_suite.py -k test_07_modular_architecture_strict_5000_line_ceiling
```

### 5.2 Syntax & Integration Check
Run node syntax check on `09-construction-survey-and-bim.js`:
```powershell
node -c web/src/09-construction-survey-and-bim.js
```

### 5.3 Local Server Functional Verification
1. Launch or verify local server: `http://127.0.0.1:8095`.
2. Open Chrome/Edge at `http://127.0.0.1:8095/?scan=quchi_20261005_merged`.
3. Click the bottom dock button `檢核 / QA` (`#btnDockGcpQa`).
4. Verify:
   - Side panel opens with title: "控制點與檢核點精度檢核 (3D GCP QA & TBM Calibration)".
   - Statistical Summary Card displays RMSE_E, RMSE_N, RMSE_H, RMSE_2D, RMSE_3D, and ASPRS 95% accuracies.
   - 1-Click TBM calibration card allows selecting a TBM point or network mean bias.
   - Clicking "套用 TBM 高程校正" applies vertical datum shift and recalculates residuals.
   - In 3D Studio, Three.js 3D residual arrows appear at control point locations, pointing in the error direction.
   - Changing the vector scale slider (10x, 20x, 50x) scales the arrows dynamically.
   - Clicking "下載 3D 殘差 CSV" downloads a valid UTF-8 CSV with all 3D columns.
   - Clicking "📄 檢核報告證書" opens the printable civil QA certificate.

### 5.4 Invalidation Conditions
This investigation's recommendations would be invalidated if:
- `09-construction-survey-and-bim.js` were removed from `web/index.html` (verified present at line 2400).
- `window.openGcpAccuracyQaInspector` could not be reassigned (verified standard mutable global property).
- The 5,000-line ceiling was waived (the ceiling is strictly enforced by `test_07_modular_architecture_strict_5000_line_ceiling`).
