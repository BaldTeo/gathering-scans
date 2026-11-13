# Technical Review & Adversarial Stress Report: Milestone 6 (Track C)

**Reviewer**: `reviewer_m6_2` (Reviewer & Adversarial Critic)  
**Target Milestone**: Milestone 6 — Scan-to-BIM Simplified Classified Geometric Model (Three.js 3D Solids Visualization, Studio UI/UX, Themes, and Styling)  
**Verdict**: **REQUEST_CHANGES**  

---

## 1. Observation

1. **Modular Architecture & Test Suite Verification**:
   - `python -m unittest tests.test_gathering_scans_suite.GatheringScansTestSuite.test_07_modular_architecture_strict_5000_line_ceiling`:
     ```
     Ran 1 test in 0.128s
     OK
     ```
   - Line counts:
     - `web/src/11-scan-to-bim-primitives.js`: 646 lines (strictly < 5,000 ceiling).
     - `web/survey-bim.css`: 1,258 lines (Milestone 6 styles occupy lines 543–843).
   - E2E BIM backend suite:
     `python -m unittest tests.test_gathering_scans_suite.GatheringScansTestSuite.test_37_milestone6_scan_to_bim_fitting_and_exporters tests.test_civil_surveying_e2e.TestScanToBimGeometricFitting tests.test_civil_surveying_e2e.TestScanToBimExporters`:
     ```
     Ran 10 tests in 1.352s
     OK
     ```

2. **CRITICAL FINDING 1 (Fatal Runtime Crash: Uncaught ReferenceError)**:
   - File: `web/src/11-scan-to-bim-primitives.js`, Lines 78, 362, 365, 369:
     - Line 78: `<span style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(scanId)}</span>`
     - Line 362: `<div class="bim-element-row" data-prim-id="${escapeHtml(prim.id)}" title="${escapeHtml(prim.ifc_class || "")}">`
     - Line 365: `<span class="bim-element-name">${escapeHtml(prim.name || prim.id)}</span>`
     - Line 369: `<button type="button" class="btn-icon-xs bim-fly-btn" data-prim-id="${escapeHtml(prim.id)}" ...>`
   - Observation: `escapeHtml` is invoked without being declared or imported within `web/src/11-scan-to-bim-primitives.js`. In `web/src/01-core-state.js:613`, `function escapeHtml` is scoped strictly within its local IIFE and is **never** assigned to `window.escapeHtml`.
   - Direct Execution Verification:
     ```
     node -e "const vm = require('vm'); ... context.openScanToBimInspector();"
     ```
     Result:
     ```
     ReferenceError: escapeHtml is not defined
         at renderBimInspectorBody (web/src/11-scan-to-bim-primitives.js:77:21)
         at Object.openScanToBimInspector (web/src/11-scan-to-bim-primitives.js:52:22)
     ```
     Opening the Scan-to-BIM inspector in any browser immediately crashes before the side panel HTML can be inserted into the DOM.

3. **CRITICAL FINDING 2 (Three.js 3D Solid Meshes Offset by Millions of Meters)**:
   - File: `web/src/11-scan-to-bim-primitives.js`, Lines 438–470:
     ```javascript
     const originTwd = (STATE.activeScan && (STATE.activeScan.anchor_twd97 || STATE.activeScan.origin_twd97)) || {
       e: 0,
       n: 0,
       h: 0,
     };
     ...
     for (let i = 0; i < vTwd.length; i++) {
       const pt = vTwd[i];
       const lx = Number(pt[0]) - originTwd.e;
       const ly = Number(pt[2]) - originTwd.h;
       const lz = originTwd.n - Number(pt[1]);
       posArray[i * 3] = lx;
       posArray[i * 3 + 1] = ly;
       posArray[i * 3 + 2] = lz;
     }
     ```
   - Observation: Across GatheringScans scan metadata (verified from `/api/scans`), scan objects contain properties `twd97_e`, `twd97_n`, `twd97_h`. Neither `anchor_twd97` nor `origin_twd97` exists directly on `STATE.activeScan`.
   - As a result, `originTwd` evaluates to `{ e: 0, n: 0, h: 0 }`.
   - When converting real TWD97 coordinates (e.g. `edited_1021_911189` where $E \approx 305,505\text{ m}$, $N \approx 2,754,606\text{ m}$):
     - $lx = 305,505 - 0 = 305,505$
     - $ly = 76.0 - 0 = 76.0$
     - $lz = 0 - 2,754,606 = -2,754,606$
   - The Three.js solid meshes are placed ~3,000,000 meters away from the Three.js camera and point cloud (which are centered near $(0, 0, 0)$).
   - In contrast, `pc_worker/surveying/scan_to_bim.py` line 701 already calculates and returns `mesh.vertices_local` in exact local coordinates ($[-203.71, 13.21, 161.77]$), and `flyToBimPrimitive` targets `prim.transform.center_local` ($[-199.98, 14.65, 160.29]$).
   - Because `renderBimThreeMeshes` ignores `vertices_local` and subtracts $0$, the camera flies to the origin while the meshes are invisible millions of meters away.

4. **MAJOR FINDING 3 (Missing Dock Action Button in `web/index.html`)**:
   - File: `web/index.html`, Lines 836–1065 (`<nav class="bim-bottom-dock" id="bimBottomDock">`).
   - In `web/src/06-studio-align-and-optimizer.js:3598`:
     `else if (tool === "bim" && typeof openScanToBimInspector === "function") openScanToBimInspector();`
   - In `web/src/11-scan-to-bim-primitives.js:640`:
     `const btnDock = document.getElementById("btnStudioBim"); if (btnDock) btnDock.addEventListener("click", () => openScanToBimInspector());`
   - Observation: There is **no element** with `id="btnStudioBim"` or `data-tool="bim"` in `web/index.html`. Users in the 3D Studio have no launcher button in the dock to open the Scan-to-BIM side panel.

5. **MAJOR FINDING 4 (Cross-Scan State Leakage)**:
   - File: `web/src/11-scan-to-bim-primitives.js`, Lines 48–63:
     ```javascript
     BIM_STATE.activeScanId = STATE.activeScanId || "";
     ...
     if (BIM_STATE.primitives.length === 0) {
       runScanToBimFitting();
     }
     ```
   - Observation: If a user runs fitting on Scan A, then switches to Scan B and opens Scan-to-BIM, `BIM_STATE.primitives` is not empty. `runScanToBimFitting()` is skipped, causing Scan A's fitted primitives to be displayed and rendered over Scan B.

6. **UI/UX & Design Language Compliance**:
   - Zero Unicode Emojis: Verified `0` emojis in `web/src/11-scan-to-bim-primitives.js` and `web/survey-bim.css`.
   - Strict 1-Word Buttons: `[wand] 擬合` (`Fit`), `[eye] 預覽` (`Preview`), `[download] IFC`, `[download] DXF`, `[download] OBJ`.
   - CSS Themes: Full dark and light theme classes defined in `web/survey-bim.css` using CSS custom properties.
   - Sizing: Grid and flex containers fit within side panel width without horizontal scrollbars.

---

## 2. Logic Chain

1. From Observation 1, the backend Python logic, pure Python IFC/DXF/OBJ exporters, and modular file line ceilings (< 5,000 lines) satisfy the architectural requirements.
2. From Observation 2, because `escapeHtml` was not scoped to `window` or defined locally in `11-scan-to-bim-primitives.js`, invoking `openScanToBimInspector()` raises an immediate `ReferenceError: escapeHtml is not defined`. This completely prevents the UI from rendering in a real browser session.
3. From Observation 3, because `STATE.activeScan` uses `twd97_e/n/h` rather than `anchor_twd97`, `originTwd` defaults to $0$. Three.js vertex positions are computed as unshifted TWD97 coordinates ($X \approx 300,000$, $Z \approx -2,700,000$). Because Three.js camera controls operate within local space ($[-200, 200]$), the 3D solids are completely invisible, rendering the 3D visual preview non-functional.
4. From Observation 4, the absence of a dock button (`id="btnStudioBim"`, `data-tool="bim"`) in `web/index.html` breaks the dock integration requirement.
5. From Observation 5, failure to clear `BIM_STATE.primitives` upon scan change results in cross-scan data pollution.
6. Therefore, the implementation cannot be approved in its current state.

---

## 3. Caveats

- **No Caveats**: All findings were directly reproduced and confirmed via static code analysis, AST inspection, node VM evaluation, and live API queries against `http://127.0.0.1:8095`.

---

## 4. Conclusion

**Verdict: REQUEST_CHANGES**

Milestone 6 Track C has excellent foundational architecture and passes backend exporter tests. However, it cannot be approved due to two Critical defects (runtime crash and 3D overlay coordinate disconnect) and two Major defects (missing dock launcher button and cross-scan state leakage).

### Required Remediation for Worker Track C:

1. **Fix `escapeHtml` in `web/src/11-scan-to-bim-primitives.js`**:
   Add a local helper at top of module:
   ```javascript
   function escapeHtml(str) {
     return String(str ?? "")
       .replace(/&/g, "&amp;")
       .replace(/</g, "&lt;")
       .replace(/>/g, "&gt;")
       .replace(/"/g, "&quot;")
       .replace(/'/g, "&#39;");
   }
   ```

2. **Fix Three.js Coordinate Alignment in `renderBimThreeMeshes`**:
   Prefer pre-computed local vertices if present; otherwise resolve `originTwd` with full fallback:
   ```javascript
   // In renderBimThreeMeshes:
   const originTwd = (STATE.activeScan && (
     STATE.activeScan.anchor_twd97 ||
     STATE.activeScan.origin_twd97 ||
     (STATE.activeScan.twd97_e !== undefined ? { e: STATE.activeScan.twd97_e, n: STATE.activeScan.twd97_n, h: STATE.activeScan.twd97_h } : null)
   )) || (typeof localToTwd97 === "function" ? localToTwd97({ x: 0, y: 0, z: 0 }) : { e: 0, n: 0, h: 0 });

   // Use precalculated vertices_local if available:
   const vLoc = meshData.vertices_local;
   if (Array.isArray(vLoc) && vLoc.length === vTwd.length) {
     for (let i = 0; i < vLoc.length; i++) {
       posArray[i * 3] = vLoc[i][0];
       posArray[i * 3 + 1] = vLoc[i][1];
       posArray[i * 3 + 2] = vLoc[i][2];
     }
   } else {
     for (let i = 0; i < vTwd.length; i++) {
       const pt = vTwd[i];
       posArray[i * 3] = Number(pt[0]) - originTwd.e;
       posArray[i * 3 + 1] = Number(pt[2]) - originTwd.h;
       posArray[i * 3 + 2] = originTwd.n - Number(pt[1]);
     }
   }
   ```

3. **Add Dock Button to `web/index.html`**:
   Add the following button into `<nav class="bim-bottom-dock" id="bimBottomDock">` (e.g. after `btnDockUtilities`):
   ```html
   <!-- 10g. Scan-to-BIM Classified Primitives -->
   <button type="button" class="bim-dock-btn autodesk-measure-btn" id="btnStudioBim" data-tool="bim" data-dock="bim" title="Scan-to-BIM 幾何實體模型與 CAD/BIM 匯出" data-i18n-title-zh="Scan-to-BIM 幾何實體模型與 CAD/BIM 匯出" data-i18n-title-en="Scan-to-BIM Primitives &amp; CAD/BIM Export" aria-label="Scan-to-BIM Primitives">
     <div class="bim-dock-icon">
       <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8">
         <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
         <polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>
       </svg>
     </div>
     <span class="bim-dock-label" data-i18n-zh="BIM" data-i18n-en="BIM">BIM</span>
   </button>
   ```

4. **Prevent Cross-Scan State Leakage**:
   In `openScanToBimInspector`:
   ```javascript
   if (BIM_STATE.activeScanId !== (STATE.activeScanId || "")) {
     BIM_STATE.activeScanId = STATE.activeScanId || "";
     BIM_STATE.primitives = [];
     clearBimThreeMeshes();
   }
   ```

---

## 5. Verification Method

To verify remediation:
1. **Runtime Verification**:
   ```powershell
   node -e "const vm = require('vm'); const fs = require('fs'); const code = fs.readFileSync('web/src/11-scan-to-bim-primitives.js', 'utf8'); const ctx = { window: {}, document: { addEventListener: () => {}, getElementById: () => null, documentElement: { getAttribute: () => '' }, body: { classList: { contains: () => false } } }, STATE: { activeScanId: 'test' }, tr: (a,b) => a }; ctx.window = ctx; vm.createContext(ctx); vm.runInContext(code, ctx); ctx.openScanToBimInspector(); console.log('PASS: No ReferenceError');"
   ```
2. **Modular Architecture Compliance**:
   ```powershell
   python -m unittest tests.test_gathering_scans_suite.GatheringScansTestSuite.test_07_modular_architecture_strict_5000_line_ceiling
   ```
3. **HTML Dock Button Check**:
   ```powershell
   Select-String -Path "web/index.html" -Pattern "btnStudioBim|data-tool=.bim."
   ```
