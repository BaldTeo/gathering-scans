/**
 * GatheringScans — Scan-to-BIM Simplified Classified Geometric Model (Milestone 6)
 * File: web/src/11-scan-to-bim-primitives.js
 * Compliance: Strictly under 5,000 lines modular ceiling.
 * Discipline:
 *  - ZERO Unicode emojis (crisp inline SVG icons only)
 *  - Comprehensive Bright & Dark Theme Support (via CSS Custom Properties in survey-bim.css)
 *  - Strict 1-word action buttons and minimalist typography
 *  - Project-agnostic user-configurable calculation parameters
 */

(function () {
  "use strict";

  // Global Scan-to-BIM State
  const BIM_STATE = {
    activeScanId: "",
    primitives: [],
    overlayVisible: false,
    threeGroup: null,
    selectedCategories: new Set(["buildings", "walls", "roads", "trees", "water", "pipes"]),
    params: {
      tolerance_m: 0.25,
      wall_thickness_m: 0.25,
      pipe_default_dia_m: 0.30,
      min_wall_length_m: 1.0,
      min_tree_height_m: 1.5,
    },
    hoveredPrimitiveId: null,
  };

  // Inline Crisp SVGs (Strictly Zero Emojis)
  const ICONS = {
    cube: `<svg class="gs-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`,
    wand: `<svg class="gs-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 11-4-4"></path><path d="m15 7 4 4"></path><path d="m21 15-4-4"></path><path d="m17 11 4 4"></path><path d="M14 2 2 14"></path><path d="m2 14 8 8 12-12-8-8Z"></path></svg>`,
    eye: `<svg class="gs-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>`,
    download: `<svg class="gs-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
    crosshair: `<svg class="gs-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="22" y1="12" x2="18" y2="12"></line><line x1="6" y1="12" x2="2" y2="12"></line><line x1="12" y1="6" x2="12" y2="2"></line><line x1="12" y1="22" x2="12" y2="18"></line></svg>`,
  };

  /**
   * Escape HTML entities to prevent XSS and ReferenceErrors
   */
  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Open the Scan-to-BIM side panel inspector
   */
  function openScanToBimInspector() {
    if (typeof setActiveStudioTool === "function") {
      setActiveStudioTool("bim");
    }
    STATE.sidePanelMinimized = false;
    const curScanId = STATE.activeScanId || "";
    if (BIM_STATE.activeScanId !== curScanId) {
      BIM_STATE.primitives = [];
      clearBimThreeMeshes();
      BIM_STATE.overlayVisible = false;
      BIM_STATE.activeScanId = curScanId;
    }

    const titleHtml = `<div style="display:flex;align-items:center;gap:6px;">${ICONS.cube}<span>${tr("Scan-to-BIM 幾何實體模型", "Scan-to-BIM Primitives")}</span></div>`;
    const bodyHtml = renderBimInspectorBody();

    if (typeof showSidePanel === "function") {
      showSidePanel(titleHtml, bodyHtml);
    }
    attachBimInspectorEvents();

    // If primitives already exist for this scan, update UI; otherwise run initial fitting
    if (BIM_STATE.primitives.length === 0) {
      runScanToBimFitting();
    }
  }

  /**
   * Render side panel HTML content
   */
  function renderBimInspectorBody() {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark" || document.body.classList.contains("theme-dark");
    const scanId = STATE.activeScanId || tr("未選擇掃描", "No Scan");

    return `
      <div class="bim-container" id="bimInspectorRoot">
        <!-- Top Status Banner -->
        <div class="bim-header-banner">
          <div style="display:flex;align-items:center;gap:6px;min-width:0;">
            ${ICONS.cube}
            <span style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(scanId)}</span>
          </div>
          <span class="bim-badge-pill" title="TWD97 / TM2 121 + TWVD2001 [EPSG:3826+8904]">EPSG:3826 + TWVD2001</span>
        </div>

        <!-- Metric KPI Cards -->
        <div class="bim-kpi-grid">
          <div class="bim-kpi-card">
            <span class="bim-kpi-val" id="bimKpiCount">${BIM_STATE.primitives.length}</span>
            <span class="bim-kpi-lbl">${tr("擬合實體數", "Primitives")}</span>
          </div>
          <div class="bim-kpi-card">
            <span class="bim-kpi-val" id="bimKpiVolume">0.0</span>
            <span class="bim-kpi-lbl">${tr("總實體體積 (m³)", "Volume (m³)")}</span>
          </div>
          <div class="bim-kpi-card">
            <span class="bim-kpi-val" id="bimKpiCategories">0</span>
            <span class="bim-kpi-lbl">${tr("地物類別數", "Classes")}</span>
          </div>
        </div>

        <!-- Category Selector (User-Selectable Filter) -->
        <div class="bim-categories-box">
          <div style="font-size:10px;font-weight:700;color:var(--ui-text-secondary);margin-bottom:2px;">${tr("地物分類篩選", "Element Categories")}</div>
          <div class="bim-category-row">
            <span class="bim-cat-pill ${BIM_STATE.selectedCategories.has("walls") ? "active" : ""}" data-cat="walls">
              <span class="bim-dot" style="background:#f43f5e;"></span>${tr("結構牆體", "Walls")}
            </span>
            <span class="bim-cat-pill ${BIM_STATE.selectedCategories.has("trees") ? "active" : ""}" data-cat="trees">
              <span class="bim-dot" style="background:#10b981;"></span>${tr("喬木植栽", "Trees")}
            </span>
            <span class="bim-cat-pill ${BIM_STATE.selectedCategories.has("roads") ? "active" : ""}" data-cat="roads">
              <span class="bim-dot" style="background:#f59e0b;"></span>${tr("道路鋪面", "Roads")}
            </span>
            <span class="bim-cat-pill ${BIM_STATE.selectedCategories.has("water") ? "active" : ""}" data-cat="water">
              <span class="bim-dot" style="background:#06b6d4;"></span>${tr("水體水域", "Water")}
            </span>
            <span class="bim-cat-pill ${BIM_STATE.selectedCategories.has("buildings") ? "active" : ""}" data-cat="buildings">
              <span class="bim-dot" style="background:#3b82f6;"></span>${tr("建築設施", "Buildings")}
            </span>
            <span class="bim-cat-pill ${BIM_STATE.selectedCategories.has("pipes") ? "active" : ""}" data-cat="pipes">
              <span class="bim-dot" style="background:#f97316;"></span>${tr("地下管線", "Pipes")}
            </span>
          </div>
        </div>

        <!-- Project-Agnostic User-Configurable Parameters -->
        <div class="bim-categories-box">
          <div style="font-size:10px;font-weight:700;color:var(--ui-text-secondary);margin-bottom:2px;">${tr("擬合幾何參數", "Fitting Parameters")}</div>
          <div class="bim-params-grid">
            <div class="bim-param-field">
              <span class="bim-param-label">${tr("簡化容差 (m)", "Tolerance (m)")}</span>
              <input type="number" step="0.05" min="0.05" max="2.0" id="inpBimTolerance" class="bim-input" value="${BIM_STATE.params.tolerance_m}" />
            </div>
            <div class="bim-param-field">
              <span class="bim-param-label">${tr("牆體厚度 (m)", "Wall Thick (m)")}</span>
              <input type="number" step="0.05" min="0.10" max="1.5" id="inpBimWallThickness" class="bim-input" value="${BIM_STATE.params.wall_thickness_m}" />
            </div>
            <div class="bim-param-field">
              <span class="bim-param-label">${tr("最小牆長 (m)", "Min Wall (m)")}</span>
              <input type="number" step="0.5" min="0.5" max="20.0" id="inpBimMinWallLen" class="bim-input" value="${BIM_STATE.params.min_wall_length_m}" />
            </div>
            <div class="bim-param-field">
              <span class="bim-param-label">${tr("最小樹高 (m)", "Min Tree (m)")}</span>
              <input type="number" step="0.5" min="0.5" max="30.0" id="inpBimMinTreeH" class="bim-input" value="${BIM_STATE.params.min_tree_height_m}" />
            </div>
          </div>
        </div>

        <!-- Strict 1-Word Action Buttons -->
        <div class="bim-actions-bar">
          <button type="button" class="bim-btn primary" id="btnBimRunFit" title="${tr("重新執行幾何實體擬合", "Fit geometric primitives")}">
            ${ICONS.wand}<span>${tr("擬合", "Fit")}</span>
          </button>
          <button type="button" class="bim-btn" id="btnBimTogglePreview" title="${tr("切換 Studio 3D 實體預覽覆蓋", "Toggle 3D BIM preview")}">
            ${ICONS.eye}<span id="lblBimPreviewStatus">${BIM_STATE.overlayVisible ? tr("隱藏", "Hide") : tr("預覽", "Preview")}</span>
          </button>
          <button type="button" class="bim-btn" id="btnBimExportIfc" title="${tr("匯出純 Python ISO-10303-21 IFC4 模型", "Export IFC SPF")}">
            ${ICONS.download}<span>IFC</span>
          </button>
          <button type="button" class="bim-btn" id="btnBimExportDxf" title="${tr("匯出 AutoCAD 3D Solid / 3DFACE DXF", "Export 3D DXF")}">
            ${ICONS.download}<span>DXF</span>
          </button>
          <button type="button" class="bim-btn" id="btnBimExportObj" title="${tr("匯出 Wavefront OBJ + MTL 幾何材質包", "Export OBJ/MTL")}">
            ${ICONS.download}<span>OBJ</span>
          </button>
        </div>

        <!-- Elements Scroll List -->
        <div style="font-size:10px;font-weight:700;color:var(--ui-text-secondary);margin-top:2px;">${tr("擬合實體清冊", "Fitted Primitives Schedule")}</div>
        <div class="bim-elements-scroll" id="bimElementsList">
          <div style="padding:16px;text-align:center;color:var(--ui-text-muted);font-size:11px;">
            ${tr("尚無擬合實體，請點擊「擬合」開始計算。", "No primitives fitted yet. Click 'Fit' to compute.")}
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Attach events to side panel DOM elements
   */
  function attachBimInspectorEvents() {
    const root = document.getElementById("bimInspectorRoot");
    if (!root) return;

    // Category toggle pills
    root.querySelectorAll(".bim-cat-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        const cat = pill.getAttribute("data-cat");
        if (BIM_STATE.selectedCategories.has(cat)) {
          BIM_STATE.selectedCategories.delete(cat);
          pill.classList.remove("active");
        } else {
          BIM_STATE.selectedCategories.add(cat);
          pill.classList.add("active");
        }
        updateBimElementsList();
        if (BIM_STATE.overlayVisible) {
          renderBimThreeMeshes();
        }
      });
    });

    // Run Fit button
    const btnFit = document.getElementById("btnBimRunFit");
    if (btnFit) {
      btnFit.addEventListener("click", () => {
        readBimParamsFromInputs();
        runScanToBimFitting();
      });
    }

    // Toggle Preview button
    const btnPreview = document.getElementById("btnBimTogglePreview");
    if (btnPreview) {
      btnPreview.addEventListener("click", () => {
        toggleBim3DOverlay();
      });
    }

    // Exporter buttons
    const btnIfc = document.getElementById("btnBimExportIfc");
    if (btnIfc) btnIfc.addEventListener("click", () => exportBimFormat("ifc"));

    const btnDxf = document.getElementById("btnBimExportDxf");
    if (btnDxf) btnDxf.addEventListener("click", () => exportBimFormat("dxf"));

    const btnObj = document.getElementById("btnBimExportObj");
    if (btnObj) btnObj.addEventListener("click", () => exportBimFormat("obj"));
  }

  /**
   * Read user parameters from input fields
   */
  function readBimParamsFromInputs() {
    const inpTol = document.getElementById("inpBimTolerance");
    if (inpTol && !isNaN(parseFloat(inpTol.value))) BIM_STATE.params.tolerance_m = parseFloat(inpTol.value);

    const inpWall = document.getElementById("inpBimWallThickness");
    if (inpWall && !isNaN(parseFloat(inpWall.value))) BIM_STATE.params.wall_thickness_m = parseFloat(inpWall.value);

    const inpMinWall = document.getElementById("inpBimMinWallLen");
    if (inpMinWall && !isNaN(parseFloat(inpMinWall.value))) BIM_STATE.params.min_wall_length_m = parseFloat(inpMinWall.value);

    const inpMinTree = document.getElementById("inpBimMinTreeH");
    if (inpMinTree && !isNaN(parseFloat(inpMinTree.value))) BIM_STATE.params.min_tree_height_m = parseFloat(inpMinTree.value);
  }

  /**
   * Request geometric primitive fitting from backend API
   */
  async function runScanToBimFitting() {
    const scanId = STATE.activeScanId;
    if (!scanId) {
      if (typeof showToast === "function") showToast(tr("請先載入 3D 掃描專案", "Please load a scan first"));
      return;
    }

    const btnFit = document.getElementById("btnBimRunFit");
    if (btnFit) {
      btnFit.disabled = true;
      btnFit.innerHTML = `${ICONS.wand}<span>${tr("計算中", "Fitting")}</span>`;
    }

    try {
      const payload = {
        scan_id: scanId,
        categories: Array.from(BIM_STATE.selectedCategories),
        tolerance_m: BIM_STATE.params.tolerance_m,
        wall_thickness_m: BIM_STATE.params.wall_thickness_m,
        min_wall_length_m: BIM_STATE.params.min_wall_length_m,
        min_tree_height_m: BIM_STATE.params.min_tree_height_m,
      };

      const resp = await fetch("/api/survey/scan-to-bim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        throw new Error(`Server returned HTTP ${resp.status}`);
      }

      const res = await resp.json();
      if (!res.ok) {
        throw new Error(res.error || "Failed to fit Scan-to-BIM primitives");
      }

      BIM_STATE.primitives = res.primitives || [];
      updateBimKpis(res);
      updateBimElementsList();

      BIM_STATE.overlayVisible = true;
      const lbl = document.getElementById("lblBimPreviewStatus");
      if (lbl) lbl.textContent = tr("隱藏", "Hide");
      renderBimThreeMeshes();

      if (typeof showToast === "function") {
        showToast(tr(`成功擬合 ${BIM_STATE.primitives.length} 個 BIM 幾何實體`, `Fitted ${BIM_STATE.primitives.length} BIM solids`));
      }
    } catch (err) {
      console.error("[ScanToBim] Error fitting primitives:", err);
      if (typeof showToast === "function") {
        showToast(tr("擬合計算失敗：" + err.message, "Fitting failed: " + err.message));
      }
    } finally {
      if (btnFit) {
        btnFit.disabled = false;
        btnFit.innerHTML = `${ICONS.wand}<span>${tr("擬合", "Fit")}</span>`;
      }
    }
  }

  /**
   * Update KPI cards in side panel
   */
  function updateBimKpis(res) {
    const elCount = document.getElementById("bimKpiCount");
    const elVol = document.getElementById("bimKpiVolume");
    const elCats = document.getElementById("bimKpiCategories");

    if (elCount) elCount.textContent = (res.primitive_count ?? BIM_STATE.primitives.length).toString();
    if (elVol) elVol.textContent = Number(res.total_volume_m3 || 0).toFixed(1);

    const activeCatsCount = new Set(BIM_STATE.primitives.map((p) => p.category)).size;
    if (elCats) elCats.textContent = activeCatsCount.toString();
  }

  /**
   * Update scrollable list of fitted primitives
   */
  function updateBimElementsList() {
    const listContainer = document.getElementById("bimElementsList");
    if (!listContainer) return;

    const visiblePrims = BIM_STATE.primitives.filter((p) => BIM_STATE.selectedCategories.has(p.category));

    if (visiblePrims.length === 0) {
      listContainer.innerHTML = `
        <div style="padding:16px;text-align:center;color:var(--ui-text-muted);font-size:11px;">
          ${tr("無符合選定分類的幾何實體", "No primitives match selected categories")}
        </div>
      `;
      return;
    }

    const html = visiblePrims
      .map((prim) => {
        const props = prim.properties || {};
        let dimStr = "";
        if (prim.category === "walls") {
          dimStr = `L:${props.length_m}m · H:${props.height_m}m`;
        } else if (prim.category === "trees") {
          dimStr = `DBH:${props.dbh_cm}cm · H:${props.height_m}m`;
        } else if (prim.category === "roads" || prim.category === "water") {
          dimStr = `${props.planar_area_m2}m² · V:${props.volume_m3}m³`;
        } else if (prim.category === "pipes") {
          dimStr = `Ø${props.diameter_mm}mm · L:${props.length_m}m`;
        } else {
          dimStr = `V:${props.volume_m3}m³`;
        }

        return `
          <div class="bim-element-row" data-prim-id="${escapeHtml(prim.id)}" title="${escapeHtml(prim.ifc_class || "")}">
            <div class="bim-element-info">
              <span class="bim-dot" style="background:${prim.color || '#3b82f6'};"></span>
              <span class="bim-element-name">${escapeHtml(prim.name || prim.id)}</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              <span class="bim-element-meta">${dimStr}</span>
              <button type="button" class="btn-icon-xs bim-fly-btn" data-prim-id="${escapeHtml(prim.id)}" title="${tr("鏡頭對焦", "Focus Camera")}" style="background:none;border:none;cursor:pointer;color:var(--ui-text-secondary);padding:2px;">
                ${ICONS.crosshair}
              </button>
            </div>
          </div>
        `;
      })
      .join("");

    listContainer.innerHTML = html;

    // Attach fly-to events
    listContainer.querySelectorAll(".bim-fly-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const pId = btn.getAttribute("data-prim-id");
        flyToBimPrimitive(pId);
      });
    });

    listContainer.querySelectorAll(".bim-element-row").forEach((row) => {
      row.addEventListener("click", () => {
        const pId = row.getAttribute("data-prim-id");
        flyToBimPrimitive(pId);
      });
    });
  }

  /**
   * Toggle 3D solid overlay in Studio
   */
  function toggleBim3DOverlay(forceState) {
    if (typeof forceState === "boolean") {
      BIM_STATE.overlayVisible = forceState;
    } else {
      BIM_STATE.overlayVisible = !BIM_STATE.overlayVisible;
    }

    const lbl = document.getElementById("lblBimPreviewStatus");
    if (lbl) {
      lbl.textContent = BIM_STATE.overlayVisible ? tr("隱藏", "Hide") : tr("預覽", "Preview");
    }

    if (BIM_STATE.overlayVisible) {
      renderBimThreeMeshes();
      if (typeof showToast === "function") {
        showToast(tr("已開啟 Scan-to-BIM 3D 幾何實體預覽", "BIM 3D Solid Preview Enabled"));
      }
    } else {
      clearBimThreeMeshes();
      if (typeof showToast === "function") {
        showToast(tr("已關閉 BIM 3D 實體預覽", "BIM 3D Preview Hidden"));
      }
    }
  }

  /**
   * Render 3D geometric solid meshes in Three.js Studio Scene
   */
  function renderBimThreeMeshes() {
    clearBimThreeMeshes();
    const studioThree = window.studioThree;
    if (!studioThree || !studioThree.scene) return;

    if (!BIM_STATE.threeGroup) {
      BIM_STATE.threeGroup = new THREE.Group();
      BIM_STATE.threeGroup.name = "BIM_PRIMITIVES_OVERLAY_GROUP";
      studioThree.scene.add(BIM_STATE.threeGroup);
    }

    const originTwd = (typeof localToTwd97 === "function") ? localToTwd97({ x: 0, y: 0, z: 0 }) : { e: 0, n: 0, h: 0 };

    // Ghost / dim raw photogrammetric mesh to make solid BIM model pop vividly
    if (studioThree.modelPivot) {
      studioThree.modelPivot.traverse((m) => {
        if (m.isMesh) {
          if (m.userData._origTransparent === undefined) {
            m.userData._origTransparent = m.transparent;
            m.userData._origOpacity = m.opacity !== undefined ? m.opacity : 1.0;
          }
          m.transparent = true;
          m.opacity = 0.25;
        }
      });
    }
    if (studioThree.fallbackGroup) {
      studioThree.fallbackGroup.traverse((m) => {
        if (m.isMesh) {
          if (m.userData._origTransparent === undefined) {
            m.userData._origTransparent = m.transparent;
            m.userData._origOpacity = m.opacity !== undefined ? m.opacity : 1.0;
          }
          m.transparent = true;
          m.opacity = 0.25;
        }
      });
    }

    const visiblePrims = BIM_STATE.primitives.filter((p) => BIM_STATE.selectedCategories.has(p.category));

    visiblePrims.forEach((prim) => {
      const meshData = prim.mesh;
      if (!meshData || !Array.isArray(meshData.vertices_twd97) || !Array.isArray(meshData.faces)) {
        return;
      }

      const vTwd = meshData.vertices_twd97;
      const faces = meshData.faces;
      if (vTwd.length === 0 || faces.length === 0) return;

      // Construct Three.js BufferGeometry from vertices & faces
      const geom = new THREE.BufferGeometry();
      const posArray = new Float32Array(vTwd.length * 3);

      for (let i = 0; i < vTwd.length; i++) {
        const pt = vTwd[i];
        // Convert to local Studio vector: x = dE, y = dH, z = -dN
        const lx = Number(pt[0]) - originTwd.e;
        const ly = Number(pt[2]) - originTwd.h;
        const lz = originTwd.n - Number(pt[1]);

        posArray[i * 3] = lx;
        posArray[i * 3 + 1] = ly;
        posArray[i * 3 + 2] = lz;
      }

      geom.setAttribute("position", new THREE.BufferAttribute(posArray, 3));

      // Flatten triangular face indices
      const indices = [];
      for (let fi = 0; fi < faces.length; fi++) {
        indices.push(faces[fi][0], faces[fi][1], faces[fi][2]);
      }
      geom.setIndex(indices);
      geom.computeVertexNormals();

      // Semantic Color & Opacity
      const hexColor = prim.color || "#3b82f6";
      let opacity = 0.88;
      if (prim.category === "water") opacity = 0.65;
      else if (prim.category === "roads") opacity = 0.92;
      else if (prim.category === "trees") opacity = 0.90;
      else if (prim.category === "walls") opacity = 0.92;
      else if (prim.category === "buildings") opacity = 0.90;

      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(hexColor),
        roughness: 0.35,
        metalness: 0.15,
        transparent: opacity < 1.0,
        opacity: opacity,
        side: THREE.DoubleSide,
        depthTest: true,
      });

      const mesh = new THREE.Mesh(geom, mat);
      mesh.renderOrder = 994;
      mesh.userData = {
        isBimPrimitive: true,
        primitiveId: prim.id,
        category: prim.category,
        name: prim.name,
        properties: prim.properties,
      };

      // Add crisp wireframe edge outline
      const wireGeom = new THREE.WireframeGeometry(geom);
      const wireMat = new THREE.LineBasicMaterial({
        color: new THREE.Color(hexColor).clone().multiplyScalar(0.7),
        transparent: true,
        opacity: 0.95,
        linewidth: 1.5,
        depthTest: true,
      });
      const wireLine = new THREE.LineSegments(wireGeom, wireMat);
      wireLine.renderOrder = 995;
      mesh.add(wireLine);

      BIM_STATE.threeGroup.add(mesh);
    });

    // Auto-frame camera to showcase the generated 3D BIM primitives
    if (BIM_STATE.threeGroup.children.length > 0 && studioThree.camera && studioThree.controls) {
      const box = new THREE.Box3().setFromObject(BIM_STATE.threeGroup);
      if (!box.isEmpty()) {
        const center = new THREE.Vector3();
        box.getCenter(center);
        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z, 20);
        studioThree.controls.target.copy(center);
        studioThree.camera.position.set(center.x + maxDim * 0.85, center.y + maxDim * 0.65, center.z + maxDim * 0.95);
        studioThree.controls.update();
      }
    }

    if (studioThree.renderer && studioThree.camera) {
      studioThree.renderer.render(studioThree.scene, studioThree.camera);
    }
  }

  /**
   * Clear 3D solid overlays from scene & restore mesh opacity
   */
  function clearBimThreeMeshes() {
    const studioThree = window.studioThree;
    if (studioThree) {
      if (studioThree.modelPivot) {
        studioThree.modelPivot.traverse((m) => {
          if (m.isMesh && m.userData._origTransparent !== undefined) {
            m.transparent = m.userData._origTransparent;
            m.opacity = m.userData._origOpacity;
            delete m.userData._origTransparent;
            delete m.userData._origOpacity;
          }
        });
      }
      if (studioThree.fallbackGroup) {
        studioThree.fallbackGroup.traverse((m) => {
          if (m.isMesh && m.userData._origTransparent !== undefined) {
            m.transparent = m.userData._origTransparent;
            m.opacity = m.userData._origOpacity;
            delete m.userData._origTransparent;
            delete m.userData._origOpacity;
          }
        });
      }
    }
    if (BIM_STATE.threeGroup && studioThree && studioThree.scene) {
      while (BIM_STATE.threeGroup.children.length > 0) {
        const obj = BIM_STATE.threeGroup.children[0];
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
        BIM_STATE.threeGroup.remove(obj);
      }
    }
  }

  /**
   * Fly camera to target primitive center
   */
  function flyToBimPrimitive(primId) {
    const prim = BIM_STATE.primitives.find((p) => p.id === primId);
    if (!prim || !prim.transform) return;

    const studioThree = window.studioThree;
    if (!studioThree || !studioThree.camera || !studioThree.controls) return;

    const originTwd = (typeof localToTwd97 === "function") ? localToTwd97({ x: 0, y: 0, z: 0 }) : { e: 0, n: 0, h: 0 };
    let targetPt;
    if (prim.transform.center_twd97 && prim.transform.center_twd97.length >= 3) {
      const ct = prim.transform.center_twd97;
      targetPt = new THREE.Vector3(Number(ct[0]) - originTwd.e, Number(ct[2]) - originTwd.h, originTwd.n - Number(ct[1]));
    } else if (prim.transform.center_local && prim.transform.center_local.length >= 3) {
      const cl = prim.transform.center_local;
      targetPt = new THREE.Vector3(cl[0], cl[1], cl[2]);
    } else {
      return;
    }

    const curTarget = studioThree.controls.target.clone();
    const curPos = studioThree.camera.position.clone();
    const offset = curPos.clone().sub(curTarget);
    const curDist = Math.max(10, Math.min(35, offset.length() * 0.5));
    offset.normalize().multiplyScalar(curDist);
    offset.y = Math.max(offset.y, curDist * 0.45);

    studioThree.controls.target.copy(targetPt);
    studioThree.camera.position.copy(targetPt).add(offset);
    studioThree.controls.update();

    if (typeof showToast === "function") {
      showToast(`${prim.name} (${prim.category})`);
    }
  }

  /**
   * Export BIM file in selected format
   */
  async function exportBimFormat(fmt) {
    const scanId = STATE.activeScanId;
    if (!scanId) {
      if (typeof showToast === "function") showToast(tr("請先載入 3D 掃描專案", "Please load a scan first"));
      return;
    }

    if (BIM_STATE.primitives.length === 0) {
      await runScanToBimFitting();
    }

    if (typeof showToast === "function") {
      showToast(tr(`正在匯出 ${fmt.toUpperCase()} 模型...`, `Exporting ${fmt.toUpperCase()} model...`));
    }

    try {
      const resp = await fetch("/api/survey/scan-to-bim/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scan_id: scanId,
          formats: [fmt],
          primitives: BIM_STATE.primitives,
        }),
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const res = await resp.json();
      if (!res.ok) throw new Error(res.error || "Export failed");

      const dlUrl = res.downloads && (res.downloads[`${fmt}_url`] || res.downloads.ifc_url || res.downloads.dxf_url || res.downloads.obj_url);

      if (dlUrl) {
        // Trigger direct browser download
        const a = document.createElement("a");
        a.href = dlUrl;
        a.download = dlUrl.split("/").pop();
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        if (typeof showToast === "function") {
          showToast(tr(`已成功匯出 ${fmt.toUpperCase()} 檔案`, `${fmt.toUpperCase()} exported successfully`));
        }
      }
    } catch (err) {
      console.error("[ScanToBim] Export error:", err);
      if (typeof showToast === "function") {
        showToast(tr("匯出失敗：" + err.message, "Export failed: " + err.message));
      }
    }
  }

  // Register on window and studio tool system
  window.openScanToBimInspector = openScanToBimInspector;
  window.__GS_BIM = {
    openInspector: openScanToBimInspector,
    fit: runScanToBimFitting,
    toggleOverlay: toggleBim3DOverlay,
    export: exportBimFormat,
    getState: () => BIM_STATE,
  };

  // Wire into Studio toolbar/dock if present
  document.addEventListener("DOMContentLoaded", () => {
    const btnDock = document.getElementById("btnStudioBim");
    if (btnDock) {
      btnDock.addEventListener("click", () => openScanToBimInspector());
    }
  });
})();
