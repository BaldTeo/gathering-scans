/**
 * GatheringScans Frontend Module 12: Real Public Utilities GIS Integration & 3D Subsurface Twin
 * =============================================================================================
 * Author: worker_track_d_m7 (Public Utilities GIS Specialist)
 * Project: GatheringScans (scans.gatheren.cloud)
 * Milestone 7: Real Public Utilities GIS Integration with Taiwan Open APIs
 *
 * Core Capabilities:
 * 1. Dedicated "Utilities" (管線) tool panel in Studio Dock.
 * 2. 10 Individual Layer Toggles with Color-Coding & Feature Counts:
 *    - Storm Sewer (雨水 — Cyan #06b6d4)
 *    - Sanitary Sewer (污水 — Amber/Brown #d97706)
 *    - Water Supply & Hydrants (自來水/消防栓 — Blue #3b82f6)
 *    - Electricity & Poles (電力/電桿 — Red #ef4444)
 *    - Telecom & Fiber (電信 — Green #10b981)
 *    - Natural Gas (瓦斯 — Yellow #eab308)
 *    - Common / Broadband Ducts (共同管道 — Purple #8b5cf6)
 *    - Streetlights (路燈 — Gold #f59e0b)
 *    - Active Road Excavations (道路挖掘 — Magenta #ec4899)
 *    - Open-Trench As-Built Traced Pipes (竣工實測 — Emerald #14b8a6)
 * 3. Survey-Accurate 3D Subsurface Visualization in Three.js:
 *    - Canopy-rejecting local ground surface raycaster (drapes manhole rims flush onto 3D road mesh)
 *    - Exact depth-below-ground placement for pipes & box culverts (invertY = groundY - invertDepthM)
 *    - Downward-extending underground manhole chambers + flush cast-iron surface manhole covers
 *    - Dual-pass subsurface rendering: Pass 1 (depth-tested 3D solid) + Pass 2 (GreaterDepth occluded X-ray ghost)
 *    - Interactive Ground X-Ray translucency slider (地面透視)
 * 4. Animated Hydraulic Flow Direction:
 *    - Flow animation loop in requestAnimationFrame along pipe axis from upstream (UIE) to downstream (DIE)
 * 5. Import & Export:
 *    - MOI NGIS GML 3.1.1, GeoJSON, KML file parse
 *    - GeoJSON & AutoCAD 3D DXF export
 *
 * Design Constraints:
 * - ZERO Unicode emojis (pure monochrome inline SVG vector icons)
 * - Comprehensive Bright & Dark Theme Support (via CSS custom properties)
 * - Strict 1-word action buttons and minimalist engineering metrics
 * - Strictly under 5,000 lines modular ceiling.
 */

(function () {
  "use strict";

  // Crisp inline SVG vector icons (Autodesk/BIM CAD style)
  const SVG = {
    PIPE: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M4 14v4a2 2 0 0 0 2 2h4"/><path d="M20 10V6a2 2 0 0 0-2-2h-4"/><rect x="2" y="10" width="6" height="4" rx="1"/><rect x="16" y="10" width="6" height="4" rx="1"/><circle cx="12" cy="12" r="3"/><line x1="8" y1="12" x2="9" y2="12"/><line x1="15" y1="12" x2="16" y2="12"/></svg>`,
    SEARCH: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
    UPLOAD: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
    EXPORT: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
    PLAY: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
    PAUSE: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
    RESET: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`,
    INFO: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    CHECK: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><polyline points="20 6 9 17 4 12"/></svg>`,
    EYE: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
    LAYERS: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
  };

  // 10 Standard Public Utility Layers Specification
  const UTILITY_LAYERS = {
    storm: { id: "storm", name_zh: "雨水下水道", name_en: "Storm Sewer", color: "#06b6d4", visible: true, count: 0, defaultDepthM: 2.2 },
    sanitary: { id: "sanitary", name_zh: "污水下水道", name_en: "Sanitary Sewer", color: "#d97706", visible: true, count: 0, defaultDepthM: 2.6 },
    water: { id: "water", name_zh: "自來水/消防栓", name_en: "Water & Hydrants", color: "#3b82f6", visible: true, count: 0, defaultDepthM: 1.4 },
    electric: { id: "electric", name_zh: "電力/電桿", name_en: "Electricity & Poles", color: "#ef4444", visible: true, count: 0, defaultDepthM: 1.1 },
    telecom: { id: "telecom", name_zh: "電信/光纖", name_en: "Telecom & Fiber", color: "#10b981", visible: true, count: 0, defaultDepthM: 1.0 },
    gas: { id: "gas", name_zh: "瓦斯管線", name_en: "Natural Gas", color: "#eab308", visible: true, count: 0, defaultDepthM: 1.2 },
    ducts: { id: "ducts", name_zh: "共同管道", name_en: "Common Ducts", color: "#8b5cf6", visible: true, count: 0, defaultDepthM: 1.8 },
    streetlights: { id: "streetlights", name_zh: "路燈照明", name_en: "Streetlights", color: "#f59e0b", visible: true, count: 0, defaultDepthM: 0.9 },
    excavations: { id: "excavations", name_zh: "道路挖掘", name_en: "Road Excavation", color: "#ec4899", visible: true, count: 0, defaultDepthM: 1.5 },
    as_built: { id: "as_built", name_zh: "竣工實測", name_en: "As-Built Traced", color: "#14b8a6", visible: true, count: 0, defaultDepthM: 1.5 },
  };

  // Module state
  const UTILS_STATE = {
    active: false,
    loadedScanId: null,
    lastCenter: null,
    radiusM: 120.0,
    groundXrayPct: 38, // Default 38% X-Ray translucency (= 0.62 terrain opacity) when Utilities active
    groundOpacity: 0.62,
    features: [],
    selectedFeature: null,
    flowAnimationActive: true,
    flowAnimationSpeed: 1.0,
    animationFrameId: null,
    lastAnimTime: 0,
    pulseOffset: 0.0,
    threeGroup: null,
    pipeMeshMap: new Map(), // featId_seg -> { mesh, xrayMesh, layer, flowDir, v1, v2, dist, dir, pulseMesh, pulseXrayMesh }
  };

  /**
   * Safe bilingual translator helper
   */
  function t(zh, en) {
    if (typeof tr === "function") return tr(zh, en);
    const lang = String(document.documentElement.lang || navigator.language || "zh").toLowerCase();
    return lang.startsWith("en") ? en : zh;
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Helper to read a property from either top-level feature object or GeoJSON feature.properties
   */
  function getFeatProp(feat, key, fallback = undefined) {
    if (!feat) return fallback;
    if (feat[key] !== undefined && feat[key] !== null) return feat[key];
    if (feat.properties && feat.properties[key] !== undefined && feat.properties[key] !== null) {
      return feat.properties[key];
    }
    return fallback;
  }

  /**
   * Applies or restores Ground Surface X-Ray Translucency on the 3D scan mesh (`studioThree.modelGroup`)
   * so buried 3D pipes and manhole shafts beneath the road are physically visible with true depth perception.
   */
  function applyUtilitiesGroundXray(xrayPct) {
    const pct = Math.max(0, Math.min(80, Number(xrayPct) || 0));
    UTILS_STATE.groundXrayPct = pct;
    const targetOpacity = Number((1.0 - pct / 100.0).toFixed(2));
    UTILS_STATE.groundOpacity = targetOpacity;

    const studioThree = window.studioThree;
    if (!studioThree || !studioThree.modelGroup) return;

    const isTranslucent = UTILS_STATE.active && pct > 1;
    studioThree.modelGroup.traverse((child) => {
      if (!child || !child.isMesh || !child.material) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((mat) => {
        if (!mat) return;
        if (!mat.userData) mat.userData = {};
        if (!mat.userData.__origUtilXrayState) {
          mat.userData.__origUtilXrayState = {
            transparent: Boolean(mat.transparent),
            opacity: typeof mat.opacity === "number" ? mat.opacity : 1.0,
            depthWrite: mat.depthWrite !== undefined ? Boolean(mat.depthWrite) : true,
          };
        }
        const orig = mat.userData.__origUtilXrayState;
        if (isTranslucent) {
          mat.transparent = true;
          mat.opacity = Math.min(orig.opacity, targetOpacity);
          mat.depthWrite = true;
        } else {
          mat.transparent = orig.transparent;
          mat.opacity = orig.opacity;
          mat.depthWrite = orig.depthWrite;
        }
        mat.needsUpdate = true;
      });
    });

    if (typeof studioThree.render === "function") {
      studioThree.render();
    } else if (studioThree.renderer && studioThree.camera && studioThree.scene) {
      studioThree.renderer.render(studioThree.scene, studioThree.camera);
    }
  }

  /**
   * Restores the 3D scan model opacity to 100% (1.0).
   */
  function restoreUtilitiesGroundOpacity() {
    const studioThree = window.studioThree;
    if (!studioThree || !studioThree.modelGroup) return;
    studioThree.modelGroup.traverse((child) => {
      if (!child || !child.isMesh || !child.material) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((mat) => {
        if (!mat || !mat.userData || !mat.userData.__origUtilXrayState) return;
        const orig = mat.userData.__origUtilXrayState;
        mat.transparent = orig.transparent;
        mat.opacity = orig.opacity;
        mat.depthWrite = orig.depthWrite;
        mat.needsUpdate = true;
      });
    });
    if (typeof studioThree.render === "function") {
      studioThree.render();
    } else if (studioThree.renderer && studioThree.camera && studioThree.scene) {
      studioThree.renderer.render(studioThree.scene, studioThree.camera);
    }
  }

  /**
   * Called when switching scans so stale utilities from a previous site are cleared.
   */
  function resetUtilitiesOnScanChange(newScanId) {
    UTILS_STATE.active = false;
    UTILS_STATE.loadedScanId = null;
    UTILS_STATE.lastCenter = null;
    UTILS_STATE.features = [];
    UTILS_STATE.selectedFeature = null;
    Object.keys(UTILITY_LAYERS).forEach((k) => {
      UTILITY_LAYERS[k].count = 0;
    });
    clearUtilitiesVisuals3D();
    restoreUtilitiesGroundOpacity();
  }

  /**
   * Called when the side panel is closed or switched to another tool.
   */
  function onUtilitiesPanelClosed() {
    UTILS_STATE.active = false;
    restoreUtilitiesGroundOpacity();
  }

  /**
   * Opens the dedicated Public Utilities GIS inspector side panel.
   */
  async function openUtilitiesInspector() {
    UTILS_STATE.active = true;
    if (typeof setActiveStudioTool === "function") {
      setActiveStudioTool("utilities");
    } else if (typeof STATE !== "undefined") {
      STATE.activeTool = "utilities";
    }

    renderUtilitiesSidePanel();
    applyUtilitiesGroundXray(UTILS_STATE.groundXrayPct);

    const currentScanId = String((typeof STATE !== "undefined" && STATE.activeScanId) || "");
    if (
      !UTILS_STATE.features ||
      UTILS_STATE.features.length === 0 ||
      UTILS_STATE.loadedScanId !== currentScanId
    ) {
      await runUtilitiesQuery(false);
    } else {
      renderUtilities3D();
    }
  }

  /**
   * Closes the Public Utilities GIS inspector.
   */
  function closeUtilitiesInspector() {
    UTILS_STATE.active = false;
    clearUtilitiesVisuals3D();
    restoreUtilitiesGroundOpacity();
    if (typeof closeSidePanel === "function") {
      closeSidePanel();
    }
  }

  /**
   * Renders the complete, minimalist bilingual Side Panel UI.
   */
  function renderUtilitiesSidePanel() {
    const title = `<span class="gs-inspector-title-badge">${SVG.PIPE} ${t("公共管線 GIS", "Utilities GIS")}</span>`;
    let totalPipes = 0;
    let totalPipeLen = 0.0;
    let totalMh = 0;

    UTILS_STATE.features.forEach((f) => {
      const fType = getFeatProp(f, "type", "");
      const gType = f.geometry?.type || "";
      if (fType === "pipe" || fType === "box_culvert" || gType === "LineString") {
        totalPipes++;
        totalPipeLen += Number(getFeatProp(f, "length_m", 0));
      } else {
        totalMh++;
      }
    });

    // 10 Layer toggle cards
    const layersHtml = Object.keys(UTILITY_LAYERS)
      .map((k) => {
        const l = UTILITY_LAYERS[k];
        const isChecked = l.visible !== false ? "checked" : "";
        const count = l.count || 0;
        return `
          <div class="gs-util-layer-row" data-layer="${l.id}">
            <label class="gs-util-checkbox-label">
              <input type="checkbox" id="chkUtil_${l.id}" data-layer="${l.id}" ${isChecked} />
              <span class="gs-util-color-dot" style="background:${l.color};box-shadow:0 0 6px ${l.color}44;"></span>
              <span class="gs-util-layer-name">${t(l.name_zh, l.name_en)}</span>
            </label>
            <span class="gs-util-count-pill" id="cntUtil_${l.id}" style="${count > 0 ? "font-weight:700;color:var(--ui-text-primary);" : "opacity:0.5;"}">${count}</span>
          </div>
        `;
      })
      .join("");

    const selCardHtml = UTILS_STATE.selectedFeature
      ? renderSelectedFeatureCardHtml(UTILS_STATE.selectedFeature)
      : `<div class="gs-util-hint-card">${t("點擊 3D 管線或人孔檢視埋深與管底高程", "Click 3D pipe or manhole to inspect burial depth & invert elevation")}</div>`;

    const html = `
      <div class="gs-util-panel-container">
        <!-- Search & Control Header -->
        <div class="gs-util-section-card">
          <div class="gs-util-row-flex" style="margin-bottom:8px;">
            <div style="flex:1;">
              <label class="gs-util-field-label">${t("搜尋半徑", "Radius")}</label>
              <div style="display:flex;align-items:center;gap:4px;">
                <input type="number" id="inpUtilRadius" class="gs-input gs-util-input" min="10" max="1000" step="10" value="${UTILS_STATE.radiusM}" />
                <span style="font-size:11px;color:var(--ui-text-muted);">m</span>
              </div>
            </div>
            <div style="display:flex;align-items:flex-end;gap:5px;">
              <button type="button" class="btn-xs primary" id="btnUtilQuery" title="${t("查詢現場周圍真實公共管線", "Query real public utilities around scan")}">
                ${SVG.SEARCH} ${t("查詢", "Query")}
              </button>
              <button type="button" class="btn-xs" id="btnUtilUpload" title="${t("匯入 MOI NGIS GML 3.1.1、GeoJSON 或 KML 管線檔案", "Import MOI NGIS GML 3.1.1, GeoJSON, or KML file")}">
                ${SVG.UPLOAD} ${t("匯入", "Import")}
              </button>
              <input type="file" id="inpUtilFile" accept=".gml,.xml,.json,.geojson,.kml,.csv" style="display:none;" />
            </div>
          </div>

          <!-- Metrics summary -->
          <div class="gs-util-metrics-grid">
            <div class="gs-util-metric-cell">
              <span class="gs-util-metric-val" id="utilTotalLen">${Math.round(totalPipeLen)}m</span>
              <span class="gs-util-metric-lbl">${t("總管長", "Length")}</span>
            </div>
            <div class="gs-util-metric-cell">
              <span class="gs-util-metric-val" id="utilPipeCount">${totalPipes}</span>
              <span class="gs-util-metric-lbl">${t("管段數", "Pipes")}</span>
            </div>
            <div class="gs-util-metric-cell">
              <span class="gs-util-metric-val" id="utilMhCount">${totalMh}</span>
              <span class="gs-util-metric-lbl">${t("人孔/設施", "Manholes")}</span>
            </div>
          </div>
        </div>

        <!-- 10 Layers Toggle List -->
        <div class="gs-util-section-card">
          <div class="gs-util-section-header">
            <span>${SVG.EYE} ${t("管線圖層 (10 類)", "Utility Layers")}</span>
            <div style="display:flex;gap:4px;">
              <button type="button" class="btn-xs" id="btnUtilAllLayers">${t("全選", "All")}</button>
              <button type="button" class="btn-xs" id="btnUtilNoneLayers">${t("全無", "None")}</button>
            </div>
          </div>
          <div class="gs-util-layers-list">
            ${layersHtml}
          </div>
        </div>

        <!-- Subsurface X-Ray & Flow Direction Controls -->
        <div class="gs-util-section-card">
          <div class="gs-util-section-header">
            <span>${SVG.LAYERS} ${t("地底透視與流向模擬", "Subsurface X-Ray & Flow")}</span>
            <button type="button" class="btn-xs ${UTILS_STATE.flowAnimationActive ? "primary" : ""}" id="btnUtilToggleAnim">
              ${UTILS_STATE.flowAnimationActive ? SVG.PAUSE : SVG.PLAY} ${UTILS_STATE.flowAnimationActive ? t("暫停", "Pause") : t("流動", "Flow")}
            </button>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
            <span style="font-size:10px;color:var(--ui-text-muted);min-width:44px;">${t("地面透視", "X-Ray")}</span>
            <input type="range" id="rngUtilGroundXray" class="gs-brightness-slider" min="0" max="80" step="2" value="${UTILS_STATE.groundXrayPct}" style="flex:1;" />
            <span style="font-size:11px;font-weight:600;min-width:32px;text-align:right;" id="lblUtilGroundXray">${UTILS_STATE.groundXrayPct}%</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
            <span style="font-size:10px;color:var(--ui-text-muted);min-width:44px;">${t("水力流速", "Speed")}</span>
            <input type="range" id="rngUtilAnimSpeed" class="gs-brightness-slider" min="0.2" max="3.0" step="0.2" value="${UTILS_STATE.flowAnimationSpeed}" style="flex:1;" />
            <span style="font-size:11px;font-weight:600;min-width:32px;text-align:right;" id="lblUtilAnimSpeed">${UTILS_STATE.flowAnimationSpeed.toFixed(1)}x</span>
          </div>
        </div>

        <!-- Selected Feature Inspector Card -->
        <div id="utilSelectedFeatureBox">
          ${selCardHtml}
        </div>

        <!-- Action Export Bar -->
        <div style="display:flex;gap:6px;margin-top:10px;">
          <button type="button" class="btn-xs" id="btnUtilExportGeoJson" style="flex:1;">
            ${SVG.EXPORT} GeoJSON
          </button>
          <button type="button" class="btn-xs" id="btnUtilExportDxf" style="flex:1;">
            ${SVG.EXPORT} DXF
          </button>
          <button type="button" class="btn-xs" id="btnUtilReset" style="width:auto;" title="${t("清除管線圖資", "Clear utilities")}">
            ${SVG.RESET} ${t("清除", "Clear")}
          </button>
        </div>
      </div>
    `;

    if (typeof showSidePanel === "function") {
      showSidePanel(title, html);
    }

    bindUtilitiesPanelEvents();
  }

  /**
   * Renders the engineering detail card for a clicked 3D pipe, box culvert, or manhole.
   */
  function renderSelectedFeatureCardHtml(feat) {
    if (!feat) return "";
    const layerId = getFeatProp(feat, "layer", "storm");
    const lyr = UTILITY_LAYERS[layerId] || { name_zh: layerId, name_en: layerId, color: "#94a3b8" };
    const fType = getFeatProp(feat, "type", feat.geometry?.type === "Point" ? "manhole" : "pipe");
    const nameStr = getFeatProp(feat, "name", getFeatProp(feat, "id", "Utility"));
    const diaMm = Number(getFeatProp(feat, "diameter_mm", 0));
    const widthM = Number(getFeatProp(feat, "width_m", 0));
    const heightM = Number(getFeatProp(feat, "height_m", 0));
    const diaText = diaMm > 0 ? `Ø${diaMm}mm` : "--";
    const dimText = widthM > 0 && heightM > 0 ? `${widthM.toFixed(2)}×${heightM.toFixed(2)}m` : diaText;

    const computed = feat.__computed3D || {};
    const isManhole = fType === "manhole" || fType === "catch_basin" || fType === "hydrant" || fType === "pole";

    const portalUrl = getFeatProp(feat, "portal_url", "");
    const portalLabel = getFeatProp(feat, "portal_label", t("政府管線圖資入口網", "Gov GIS Portal"));
    const apiUrl = getFeatProp(feat, "api_url", "");
    const apiLabel = getFeatProp(feat, "api_label", "ArcGIS REST API");
    const osmUrl = getFeatProp(feat, "osm_url", "");
    const osmLabel = getFeatProp(feat, "osm_label", "OpenStreetMap");
    const nlscUrl = getFeatProp(feat, "nlsc_url", "");
    const nlscLabel = getFeatProp(feat, "nlsc_label", t("國土測繪圖資雲", "NLSC Taiwan Map"));

    const linkPills = [];
    if (portalUrl) {
      linkPills.push(
        `<a href="${escapeHtml(portalUrl)}" target="_blank" rel="noopener noreferrer" class="btn-xs" style="text-decoration:none;display:inline-flex;align-items:center;gap:3px;font-size:10px;padding:2px 6px;background:rgba(56,189,248,0.14);color:#38bdf8;border:1px solid rgba(56,189,248,0.35);border-radius:4px;" title="${escapeHtml(portalUrl)}">${SVG.LAYERS} ${escapeHtml(portalLabel)}</a>`
      );
    }
    if (apiUrl) {
      linkPills.push(
        `<a href="${escapeHtml(apiUrl)}" target="_blank" rel="noopener noreferrer" class="btn-xs" style="text-decoration:none;display:inline-flex;align-items:center;gap:3px;font-size:10px;padding:2px 6px;background:rgba(16,185,129,0.14);color:#34d399;border:1px solid rgba(16,185,129,0.35);border-radius:4px;" title="${escapeHtml(apiUrl)}">${SVG.INFO} ${escapeHtml(apiLabel)}</a>`
      );
    }
    if (osmUrl) {
      linkPills.push(
        `<a href="${escapeHtml(osmUrl)}" target="_blank" rel="noopener noreferrer" class="btn-xs" style="text-decoration:none;display:inline-flex;align-items:center;gap:3px;font-size:10px;padding:2px 6px;background:rgba(245,158,11,0.14);color:#fbbf24;border:1px solid rgba(245,158,11,0.35);border-radius:4px;" title="${escapeHtml(osmUrl)}">${SVG.SEARCH} ${escapeHtml(osmLabel)}</a>`
      );
    }
    if (nlscUrl) {
      linkPills.push(
        `<a href="${escapeHtml(nlscUrl)}" target="_blank" rel="noopener noreferrer" class="btn-xs" style="text-decoration:none;display:inline-flex;align-items:center;gap:3px;font-size:10px;padding:2px 6px;background:rgba(168,85,247,0.14);color:#c084fc;border:1px solid rgba(168,85,247,0.35);border-radius:4px;" title="${escapeHtml(nlscUrl)}">${SVG.EYE} ${escapeHtml(nlscLabel)}</a>`
      );
    }
    const linksBarHtml =
      linkPills.length > 0
        ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;padding-top:5px;border-top:1px solid rgba(148,163,184,0.16);">${linkPills.join("")}</div>`
        : "";

    if (isManhole) {
      const depthVal = computed.depthM ?? getFeatProp(feat, "depth_m", undefined);
      const rimVal = computed.rimH ?? getFeatProp(feat, "rim_h", undefined);
      const invVal = computed.invertH ?? getFeatProp(feat, "invert_h", undefined);
      const depthStr = depthVal !== undefined ? `${Number(depthVal).toFixed(2)}m` : "--";
      const rimStr = rimVal !== undefined ? `${Number(rimVal).toFixed(2)}m` : "--";
      const invStr = invVal !== undefined ? `${Number(invVal).toFixed(2)}m` : "--";

      return `
        <div class="gs-util-detail-card" style="border-left:3px solid ${lyr.color};">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
            <span style="font-weight:700;font-size:12px;color:var(--ui-text-primary);">${escapeHtml(nameStr)}</span>
            <span class="gs-util-badge" style="background:${lyr.color}22;color:${lyr.color};border:1px solid ${lyr.color}44;">
              ${t(lyr.name_zh, lyr.name_en)}
            </span>
          </div>
          <div class="gs-util-detail-grid">
            <div><span class="gs-util-detail-lbl">${t("孔徑/尺寸", "Size")}:</span> <b>${escapeHtml(dimText)}</b></div>
            <div><span class="gs-util-detail-lbl">${t("人孔埋深", "Depth")}:</span> <b>${depthStr}</b></div>
            <div><span class="gs-util-detail-lbl">${t("路面高程", "Rim EL")}:</span> <b>${rimStr}</b></div>
            <div><span class="gs-util-detail-lbl">${t("孔底高程", "Inv EL")}:</span> <b>${invStr}</b></div>
          </div>
          <div style="font-size:10px;color:var(--ui-text-muted);margin-top:4px;">
            ${t("資料來源", "Source")}: ${escapeHtml(getFeatProp(feat, "source", "Taiwan Open GIS"))}
          </div>
          ${linksBarHtml}
        </div>
      `;
    }

    // Pipe or Box Culvert
    const startDepthVal = computed.startDepthM ?? getFeatProp(feat, "start_depth_m", undefined);
    const endDepthVal = computed.endDepthM ?? getFeatProp(feat, "end_depth_m", startDepthVal);
    const coverVal = computed.startCoverM ?? getFeatProp(feat, "start_cover_m", undefined);
    const rimVal = computed.startGroundH ?? getFeatProp(feat, "start_ground_h", getFeatProp(feat, "ground_h", undefined));
    const invStartVal = computed.startInvertH ?? getFeatProp(feat, "start_invert_h", undefined);
    const invEndVal = computed.endInvertH ?? getFeatProp(feat, "end_invert_h", undefined);
    const slopeVal = getFeatProp(feat, "slope_pct", undefined);
    const lenVal = getFeatProp(feat, "length_m", undefined);
    const flowDir = Number(getFeatProp(feat, "flow_direction", 1));

    const depthText =
      startDepthVal !== undefined
        ? endDepthVal !== undefined && Math.abs(Number(startDepthVal) - Number(endDepthVal)) > 0.04
          ? `${Number(startDepthVal).toFixed(2)}→${Number(endDepthVal).toFixed(2)}m`
          : `${Number(startDepthVal).toFixed(2)}m`
        : "--";
    const coverText = coverVal !== undefined ? `${Number(coverVal).toFixed(2)}m` : "--";
    const rimText = rimVal !== undefined ? `${Number(rimVal).toFixed(2)}m` : "--";
    const invStart = invStartVal !== undefined ? `${Number(invStartVal).toFixed(2)}m` : "--";
    const invEnd = invEndVal !== undefined ? `${Number(invEndVal).toFixed(2)}m` : "--";
    const slopeText = slopeVal !== undefined ? `${Number(slopeVal).toFixed(2)}%` : "--";
    const lenText = lenVal !== undefined ? `${Number(lenVal).toFixed(1)}m` : "--";

    return `
      <div class="gs-util-detail-card" style="border-left:3px solid ${lyr.color};">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
          <span style="font-weight:700;font-size:12px;color:var(--ui-text-primary);">${escapeHtml(nameStr)}</span>
          <span class="gs-util-badge" style="background:${lyr.color}22;color:${lyr.color};border:1px solid ${lyr.color}44;">
            ${t(lyr.name_zh, lyr.name_en)}
          </span>
        </div>
        <div class="gs-util-detail-grid">
          <div><span class="gs-util-detail-lbl">${t("管徑/尺寸", "Size")}:</span> <b>${escapeHtml(dimText)}</b></div>
          <div><span class="gs-util-detail-lbl">${t("管段長度", "Len")}:</span> <b>${lenText}</b></div>
          <div><span class="gs-util-detail-lbl">${t("管底埋深", "Depth")}:</span> <b>${depthText}</b></div>
          <div><span class="gs-util-detail-lbl">${t("頂部覆土深", "Cover")}:</span> <b>${coverText}</b></div>
          <div><span class="gs-util-detail-lbl">${t("路面高程", "Road EL")}:</span> <b>${rimText}</b></div>
          <div><span class="gs-util-detail-lbl">${t("水力坡度", "Slope")}:</span> <b>${slopeText}</b></div>
          <div><span class="gs-util-detail-lbl">${t("起點管底", "US Inv")}:</span> <b>${invStart}</b></div>
          <div><span class="gs-util-detail-lbl">${t("終點管底", "DS Inv")}:</span> <b>${invEnd}</b></div>
          <div style="grid-column:span 2;"><span class="gs-util-detail-lbl">${t("水力流向", "Flow")}:</span> <b>${flowDir === 1 ? t("起點 → 終點 (順流)", "Upstream → Downstream") : flowDir === -1 ? t("終點 → 起點 (逆流)", "Downstream → Upstream") : t("雙向/重力流", "Gravity / Bidirectional")}</b></div>
        </div>
        <div style="font-size:10px;color:var(--ui-text-muted);margin-top:4px;">
          ${t("資料來源", "Source")}: ${escapeHtml(getFeatProp(feat, "source", "Taiwan Open GIS"))}
        </div>
        ${linksBarHtml}
      </div>
    `;
  }

  /**
   * Binds user event listeners inside the inspector side panel.
   */
  function bindUtilitiesPanelEvents() {
    const elQuery = document.getElementById("btnUtilQuery");
    if (elQuery) {
      elQuery.onclick = async () => {
        const inpR = document.getElementById("inpUtilRadius");
        if (inpR) UTILS_STATE.radiusM = Math.max(10, Math.min(1000, parseFloat(inpR.value) || 120));
        await runUtilitiesQuery(true);
      };
    }

    // Radius change
    const inpR = document.getElementById("inpUtilRadius");
    if (inpR) {
      inpR.onchange = () => {
        UTILS_STATE.radiusM = Math.max(10, Math.min(1000, parseFloat(inpR.value) || 120));
      };
    }

    // Layer checkboxes
    Object.keys(UTILITY_LAYERS).forEach((k) => {
      const chk = document.getElementById(`chkUtil_${k}`);
      if (chk) {
        chk.onchange = () => {
          UTILITY_LAYERS[k].visible = chk.checked;
          updateLayerVisibility3D();
        };
      }
    });

    // All / None buttons
    const btnAll = document.getElementById("btnUtilAllLayers");
    if (btnAll) {
      btnAll.onclick = () => {
        Object.keys(UTILITY_LAYERS).forEach((k) => {
          UTILITY_LAYERS[k].visible = true;
          const chk = document.getElementById(`chkUtil_${k}`);
          if (chk) chk.checked = true;
        });
        updateLayerVisibility3D();
      };
    }

    const btnNone = document.getElementById("btnUtilNoneLayers");
    if (btnNone) {
      btnNone.onclick = () => {
        Object.keys(UTILITY_LAYERS).forEach((k) => {
          UTILITY_LAYERS[k].visible = false;
          const chk = document.getElementById(`chkUtil_${k}`);
          if (chk) chk.checked = false;
        });
        updateLayerVisibility3D();
      };
    }

    // Ground X-Ray Translucency slider
    const rngXray = document.getElementById("rngUtilGroundXray");
    if (rngXray) {
      rngXray.oninput = () => {
        const pct = Math.max(0, Math.min(80, parseFloat(rngXray.value) || 0));
        const lbl = document.getElementById("lblUtilGroundXray");
        if (lbl) lbl.textContent = `${Math.round(pct)}%`;
        applyUtilitiesGroundXray(pct);
      };
    }

    // Flow Animation Toggle & Speed
    const btnAnim = document.getElementById("btnUtilToggleAnim");
    if (btnAnim) {
      btnAnim.onclick = () => {
        UTILS_STATE.flowAnimationActive = !UTILS_STATE.flowAnimationActive;
        updateLayerVisibility3D();
        renderUtilitiesSidePanel();
      };
    }

    const rngSpeed = document.getElementById("rngUtilAnimSpeed");
    if (rngSpeed) {
      rngSpeed.oninput = () => {
        UTILS_STATE.flowAnimationSpeed = parseFloat(rngSpeed.value) || 1.0;
        const lbl = document.getElementById("lblUtilAnimSpeed");
        if (lbl) lbl.textContent = UTILS_STATE.flowAnimationSpeed.toFixed(1) + "x";
      };
    }

    // Import GML / GeoJSON / KML
    const btnUpload = document.getElementById("btnUtilUpload");
    const inpFile = document.getElementById("inpUtilFile");
    if (btnUpload && inpFile) {
      btnUpload.onclick = () => inpFile.click();
      inpFile.onchange = async (ev) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        const text = await file.text();
        await parseAndLoadUtilityFile(text, file.name);
      };
    }

    // Export buttons
    const btnExpGeo = document.getElementById("btnUtilExportGeoJson");
    if (btnExpGeo) {
      btnExpGeo.onclick = () => exportUtilities("geojson");
    }
    const btnExpDxf = document.getElementById("btnUtilExportDxf");
    if (btnExpDxf) {
      btnExpDxf.onclick = () => exportUtilities("dxf");
    }

    // Clear / Reset button
    const btnReset = document.getElementById("btnUtilReset");
    if (btnReset) {
      btnReset.onclick = () => {
        clearUtilitiesVisuals3D();
        restoreUtilitiesGroundOpacity();
        UTILS_STATE.features = [];
        UTILS_STATE.selectedFeature = null;
        UTILS_STATE.loadedScanId = null;
        Object.keys(UTILITY_LAYERS).forEach((k) => (UTILITY_LAYERS[k].count = 0));
        renderUtilitiesSidePanel();
      };
    }
  }

  /**
   * Queries genuine Taiwan Open APIs via backend `/api/survey/utilities-query`.
   */
  async function runUtilitiesQuery(forceRefresh = false) {
    const scanId = String((typeof STATE !== "undefined" && STATE.activeScanId) || "");
    if (typeof showToast === "function") {
      showToast(t("正在查詢現場周邊公共管線開放圖資...", "Querying public utilities GIS endpoints..."));
    }

    try {
      const payload = {
        scan_id: scanId,
        radius_m: UTILS_STATE.radiusM,
        force_refresh: forceRefresh,
      };
      if (typeof localToTwd97 === "function") {
        const originTwd = localToTwd97({ x: 0, y: 0, z: 0 });
        if (
          originTwd &&
          Number.isFinite(originTwd.e) &&
          Number.isFinite(originTwd.n) &&
          originTwd.e >= 150000 &&
          originTwd.n >= 2000000
        ) {
          payload.center_e = Number(originTwd.e.toFixed(3));
          payload.center_n = Number(originTwd.n.toFixed(3));
          if (Number.isFinite(originTwd.h)) payload.center_h = Number(originTwd.h.toFixed(3));
        }
      }

      const res = typeof apiPost === "function" ? await apiPost("/api/survey/utilities-query", payload) : null;
      if (res && res.status === "ok" && Array.isArray(res.features)) {
        UTILS_STATE.features = res.features;
        UTILS_STATE.loadedScanId = scanId;
        UTILS_STATE.lastCenter = res.center || null;

        // Reset counts and sum up
        Object.keys(UTILITY_LAYERS).forEach((k) => (UTILITY_LAYERS[k].count = 0));
        if (res.layer_counts) {
          Object.keys(res.layer_counts).forEach((k) => {
            if (UTILITY_LAYERS[k]) UTILITY_LAYERS[k].count = res.layer_counts[k];
          });
        }

        renderUtilitiesSidePanel();
        applyUtilitiesGroundXray(UTILS_STATE.groundXrayPct);
        renderUtilities3D(res);

        if (typeof showToast === "function") {
          showToast(
            t(
              `已成功取得 ${res.total_features} 筆公共管線圖資 (總長 ${Math.round(res.total_pipe_length_m || 0)}m)`,
              `Loaded ${res.total_features} public utility features (${Math.round(res.total_pipe_length_m || 0)}m)`
            )
          );
        }
      } else {
        const errMsg = res?.error || t("該區域未涵蓋開放公共管線資料", "No public utility features found in coverage area");
        if (typeof showToast === "function") showToast(errMsg);
      }
    } catch (err) {
      console.warn("[UtilitiesGIS] Query error:", err);
      if (typeof showToast === "function") {
        showToast(t("公共管線服務連線逾時，請稍後重試", "Utilities query timed out, please retry"));
      }
    }
  }

  /**
   * Parses uploaded GML/GeoJSON/KML file via backend `/api/survey/utilities-parse`.
   */
  async function parseAndLoadUtilityFile(content, filename) {
    if (typeof showToast === "function") {
      showToast(t("正在解析管線圖資檔案...", "Parsing utility file..."));
    }

    try {
      const payload = {
        file_content: content,
        filename: filename,
      };
      const res = typeof apiPost === "function" ? await apiPost("/api/survey/utilities-parse", payload) : null;
      if (res && res.status === "ok" && Array.isArray(res.features)) {
        UTILS_STATE.features = res.features;
        UTILS_STATE.loadedScanId = String((typeof STATE !== "undefined" && STATE.activeScanId) || "");

        Object.keys(UTILITY_LAYERS).forEach((k) => (UTILITY_LAYERS[k].count = 0));
        if (res.layer_counts) {
          Object.keys(res.layer_counts).forEach((k) => {
            if (UTILITY_LAYERS[k]) UTILITY_LAYERS[k].count = res.layer_counts[k];
          });
        }

        renderUtilitiesSidePanel();
        applyUtilitiesGroundXray(UTILS_STATE.groundXrayPct);
        renderUtilities3D(res);

        if (typeof showToast === "function") {
          showToast(t(`成功匯入 ${res.total_features} 筆管線圖資 (${res.format})`, `Imported ${res.total_features} features (${res.format})`));
        }
      } else {
        if (typeof showToast === "function") {
          showToast(res?.error || t("管線圖資格式錯誤", "Invalid utility file format"));
        }
      }
    } catch (err) {
      console.error("[UtilitiesGIS] Parse error:", err);
      if (typeof showToast === "function") showToast(t("匯入失敗", "Import failed"));
    }
  }

  /**
   * Exports features to GeoJSON or DXF via backend `/api/survey/utilities-export`.
   */
  async function exportUtilities(fmt) {
    if (!UTILS_STATE.features || UTILS_STATE.features.length === 0) {
      if (typeof showToast === "function") showToast(t("無管線圖資可供導出", "No utility features to export"));
      return;
    }

    try {
      const payload = {
        scan_id: (typeof STATE !== "undefined" && STATE.activeScanId) || "scan",
        format: fmt,
        features: UTILS_STATE.features,
      };
      const res = typeof apiPost === "function" ? await apiPost("/api/survey/utilities-export", payload) : null;
      if (res && res.status === "ok" && res.url) {
        const a = document.createElement("a");
        a.href = res.url;
        a.download = res.filename || `utilities.${fmt}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } catch (err) {
      console.error("[UtilitiesGIS] Export error:", err);
    }
  }

  /**
   * Converts real TWD97 (E, N, H) coordinates into Three.js local space.
   */
  function twd97ToLocal(e, n, h) {
    const originTwd = typeof localToTwd97 === "function" ? localToTwd97({ x: 0, y: 0, z: 0 }) : { e: 0, n: 0, h: 0 };
    return new THREE.Vector3(Number(e) - originTwd.e, Number(h) - originTwd.h, originTwd.n - Number(n));
  }

  /**
   * Clears all 3D Three.js utilities visuals from studioThree scene.
   */
  function clearUtilitiesVisuals3D() {
    if (UTILS_STATE.animationFrameId) {
      cancelAnimationFrame(UTILS_STATE.animationFrameId);
      UTILS_STATE.animationFrameId = null;
    }

    const studioThree = window.studioThree;
    if (studioThree && UTILS_STATE.threeGroup) {
      if (studioThree.overlayGroup) studioThree.overlayGroup.remove(UTILS_STATE.threeGroup);
      if (studioThree.scene) studioThree.scene.remove(UTILS_STATE.threeGroup);
      UTILS_STATE.threeGroup.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
      UTILS_STATE.threeGroup = null;
    }
    UTILS_STATE.pipeMeshMap.clear();
  }

  /**
   * Builds a fast, canopy-rejecting local ground surface sampler for `renderUtilities3D`.
   * Picks the lowest mesh intersection beneath any tree canopy, parked car, or scooter,
   * and caches quantized `(lx, lz)` lookups so 100+ vertices raycast in < 15ms.
   */
  function createCanopyRejectingGroundSampler(payload, originTwd) {
    const studioThree = window.studioThree;
    const meshes = typeof getStudioRaycastMeshes === "function" ? getStudioRaycastMeshes() : [];
    const rc = (studioThree && studioThree.raycaster) || new THREE.Raycaster();
    const downDir = new THREE.Vector3(0, -1, 0);
    const rayOrigin = new THREE.Vector3();

    // 1. Estimate reference road local Y (`roadRefY`) from categorized roads, tree bases, or mesh lower percentile
    const roadSamplesY = [];
    const catData = typeof STATE !== "undefined" ? STATE.categorizeData : null;
    if (catData) {
      if (Array.isArray(catData.roads)) {
        catData.roads.forEach((r) => {
          if (Number.isFinite(r.elevation_local_y)) {
            roadSamplesY.push(Number(r.elevation_local_y));
          } else if (Number.isFinite(r.elevation_twd97_z)) {
            roadSamplesY.push(Number(r.elevation_twd97_z) - originTwd.h);
          }
        });
      }
      if (roadSamplesY.length === 0 && Array.isArray(catData.trees)) {
        catData.trees.forEach((trObj) => {
          if (Array.isArray(trObj.base_local) && Number.isFinite(trObj.base_local[1])) {
            roadSamplesY.push(Number(trObj.base_local[1]));
          } else if (Number.isFinite(trObj.ground_elevation_twd97_z)) {
            roadSamplesY.push(Number(trObj.ground_elevation_twd97_z) - originTwd.h);
          }
        });
      }
    }

    // Also probe a quick 5x5 grid around scan center on the 3D mesh taking lowest hits
    if (meshes && meshes.length > 0) {
      for (let gx = -24; gx <= 24; gx += 12) {
        for (let gz = -24; gz <= 24; gz += 12) {
          rayOrigin.set(gx, 5000, gz);
          rc.set(rayOrigin, downDir);
          const hits = rc.intersectObjects(meshes, true);
          if (hits && hits.length > 0) {
            const lowestY = hits[hits.length - 1].point.y;
            if (Number.isFinite(lowestY)) roadSamplesY.push(lowestY);
          }
        }
      }
    }

    let roadRefY = 0.0;
    const centerGroundH = Number(payload?.center?.ground_h ?? UTILS_STATE.lastCenter?.ground_h);
    if (roadSamplesY.length > 0) {
      roadSamplesY.sort((a, b) => a - b);
      // Use 25th percentile to reject any roof/canopy outliers
      const idx25 = Math.max(0, Math.min(roadSamplesY.length - 1, Math.floor(roadSamplesY.length * 0.25)));
      roadRefY = roadSamplesY[idx25];
    } else if (Number.isFinite(centerGroundH) && centerGroundH > -100) {
      roadRefY = centerGroundH - originTwd.h;
    }

    const cache = new Map();
    const validSamples = []; // [{ x, z, y }]

    function raycastLowestGroundAt(x, z) {
      if (!meshes || meshes.length === 0) return null;
      rayOrigin.set(x, 5000, z);
      rc.set(rayOrigin, downDir);
      const hits = rc.intersectObjects(meshes, true);
      if (!hits || hits.length === 0) return null;
      // Pick lowest hit along vertical ray (road/ground beneath any overhanging tree canopy)
      for (let i = hits.length - 1; i >= 0; i--) {
        const py = hits[i].point.y;
        if (Number.isFinite(py) && py <= roadRefY + 2.0) {
          return py;
        }
      }
      return null;
    }

    return function sampleLocalGroundY(lx, lz, fallbackGroundH) {
      const qx = Math.round(lx);
      const qz = Math.round(lz);
      const key = `${qx}_${qz}`;
      if (cache.has(key)) return cache.get(key);

      let bestY = raycastLowestGroundAt(lx, lz);
      // If center ray hit a dense tree trunk/car (> roadRefY + 2.0m) or missed, probe a ±1.2m cross and take the minimum Y
      if (bestY === null && meshes && meshes.length > 0) {
        const offsets = [
          [1.2, 0],
          [-1.2, 0],
          [0, 1.2],
          [0, -1.2],
        ];
        for (let i = 0; i < offsets.length; i++) {
          const candY = raycastLowestGroundAt(lx + offsets[i][0], lz + offsets[i][1]);
          if (candY !== null && (bestY === null || candY < bestY)) {
            bestY = candY;
          }
        }
      }

      if (bestY !== null) {
        cache.set(key, bestY);
        validSamples.push({ x: lx, z: lz, y: bestY });
        return bestY;
      }

      // Outside 3D scan mesh footprint: use nearest valid mesh ground sample if within 80m, or backend road ground_h / roadRefY
      let fallbackY = roadRefY;
      if (
        Number.isFinite(Number(fallbackGroundH)) &&
        Number(fallbackGroundH) > -100 &&
        Math.abs(Number(fallbackGroundH) - (originTwd.h + roadRefY)) <= 2.2
      ) {
        fallbackY = Number(fallbackGroundH) - originTwd.h;
      } else if (validSamples.length > 0) {
        let minD2 = Infinity;
        let nearestY = roadRefY;
        for (let i = 0; i < validSamples.length; i++) {
          const s = validSamples[i];
          const d2 = (s.x - lx) * (s.x - lx) + (s.z - lz) * (s.z - lz);
          if (d2 < minD2) {
            minD2 = d2;
            nearestY = s.y;
          }
        }
        fallbackY = nearestY;
      }

      cache.set(key, fallbackY);
      return fallbackY;
    };
  }

  /**
   * Builds and renders survey-accurate 3D subsurface pipelines, box culverts, manholes,
   * flush road manhole covers, surface alignment traces, and hydraulic flow vectors.
   */
  function renderUtilities3D(payload = null) {
    clearUtilitiesVisuals3D();
    const studioThree = window.studioThree;
    if (!studioThree || !studioThree.scene || !UTILS_STATE.features || UTILS_STATE.features.length === 0) {
      return;
    }

    if (UTILS_STATE.active) {
      applyUtilitiesGroundXray(UTILS_STATE.groundXrayPct);
    }

    const originTwd = typeof localToTwd97 === "function" ? localToTwd97({ x: 0, y: 0, z: 0 }) : { e: 0, n: 0, h: 0 };
    const sampleLocalGroundY = createCanopyRejectingGroundSampler(payload, originTwd);

    const group = new THREE.Group();
    group.name = "PublicUtilitiesGroup";
    UTILS_STATE.threeGroup = group;

    // Dual-Pass Subsurface Engineering Material Cache:
    // Pass 1: True 3D Depth-Tested Solid Material (depthTest: true, depthWrite: true, opacity: 0.94)
    // Pass 2: Occluded GreaterDepth X-Ray Ghost Material (depthFunc: THREE.GreaterDepth, opacity: 0.28)
    const solidMatCache = new Map();
    const xrayMatCache = new Map();
    const traceLineMatCache = new Map();
    const leaderLineMatCache = new Map();

    function getSolidMaterial(layerId, opacity = 0.94) {
      const ldef = UTILITY_LAYERS[layerId] || { color: "#06b6d4" };
      const key = `${ldef.color}_${opacity}`;
      if (!solidMatCache.has(key)) {
        solidMatCache.set(
          key,
          new THREE.MeshStandardMaterial({
            color: new THREE.Color(ldef.color),
            emissive: new THREE.Color(ldef.color),
            emissiveIntensity: 0.28,
            roughness: 0.38,
            metalness: 0.25,
            transparent: opacity < 0.99,
            opacity: opacity,
            depthTest: true,
            depthWrite: true,
          })
        );
      }
      return solidMatCache.get(key);
    }

    function getXrayGhostMaterial(layerId, opacity = 0.28) {
      const ldef = UTILITY_LAYERS[layerId] || { color: "#06b6d4" };
      const key = `${ldef.color}_xray_${opacity}`;
      if (!xrayMatCache.has(key)) {
        xrayMatCache.set(
          key,
          new THREE.MeshBasicMaterial({
            color: new THREE.Color(ldef.color),
            transparent: true,
            opacity: opacity,
            depthTest: true,
            depthWrite: false,
            depthFunc: THREE.GreaterDepth,
          })
        );
      }
      return xrayMatCache.get(key);
    }

    function getSurfaceTraceMaterial(layerId) {
      const ldef = UTILITY_LAYERS[layerId] || { color: "#06b6d4" };
      if (!traceLineMatCache.has(ldef.color)) {
        traceLineMatCache.set(
          ldef.color,
          new THREE.LineDashedMaterial({
            color: new THREE.Color(ldef.color),
            dashSize: 0.8,
            gapSize: 0.45,
            transparent: true,
            opacity: 0.82,
            depthTest: true,
            depthWrite: false,
          })
        );
      }
      return traceLineMatCache.get(ldef.color);
    }

    function getDepthLeaderMaterial(layerId) {
      const ldef = UTILITY_LAYERS[layerId] || { color: "#06b6d4" };
      if (!leaderLineMatCache.has(ldef.color)) {
        leaderLineMatCache.set(
          ldef.color,
          new THREE.LineBasicMaterial({
            color: new THREE.Color(ldef.color),
            transparent: true,
            opacity: 0.42,
            depthTest: true,
            depthWrite: false,
          })
        );
      }
      return leaderLineMatCache.get(ldef.color);
    }

    // Shared Cast-Iron & Concrete Engineering Materials
    const castIronFrameMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.65,
      metalness: 0.75,
      depthTest: true,
      depthWrite: true,
    });
    const culvertBoreMat = new THREE.MeshBasicMaterial({
      color: 0x090d16,
      depthTest: true,
      depthWrite: true,
    });
    const collarRingMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.5,
      metalness: 0.6,
      depthTest: true,
      depthWrite: true,
    });
    const pulseSolidMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.92,
      depthTest: true,
      depthWrite: false,
    });
    const pulseXrayMat = new THREE.MeshBasicMaterial({
      color: 0xe0f2fe,
      transparent: true,
      opacity: 0.38,
      depthTest: true,
      depthWrite: false,
      depthFunc: THREE.GreaterDepth,
    });

    UTILS_STATE.features.forEach((feat) => {
      const layerId = getFeatProp(feat, "layer", "storm");
      const ldef = UTILITY_LAYERS[layerId] || UTILITY_LAYERS.storm;
      const isLayerVis = ldef.visible !== false;
      const fType = getFeatProp(feat, "type", feat.geometry?.type === "Point" ? "manhole" : "pipe");

      // 1. Subsurface Pipe or Box Culvert
      if (fType === "pipe" || fType === "box_culvert" || feat.geometry?.type === "LineString") {
        const rawCoords =
          feat.coords ||
          feat.geometry?.coordinates ||
          (feat.start_coord && feat.end_coord ? [feat.start_coord, feat.end_coord] : null);
        if (!rawCoords || rawCoords.length < 2) return;

        const diaM = Math.max(0.15, (Number(getFeatProp(feat, "diameter_mm", 300)) || 300) / 1000.0);
        const widthProp = Number(getFeatProp(feat, "width_m", 0));
        const heightProp = Number(getFeatProp(feat, "height_m", 0));
        const isBox = fType === "box_culvert" || (widthProp > 0 && heightProp > 0);
        const widthM = isBox ? Math.max(0.35, widthProp || diaM) : diaM;
        const heightM = isBox ? Math.max(0.35, heightProp || diaM) : diaM;

        // Determine surveyed invert depth below ground at start and end
        const defDepth = Number(ldef.defaultDepthM || 2.0);
        const rawGroundH = Number(getFeatProp(feat, "ground_h", NaN));
        const startGroundH = Number(getFeatProp(feat, "start_ground_h", Number.isFinite(rawGroundH) ? rawGroundH : NaN));
        const endGroundH = Number(getFeatProp(feat, "end_ground_h", startGroundH));

        const rawStartInvH = Number(getFeatProp(feat, "start_invert_h", NaN));
        const rawEndInvH = Number(getFeatProp(feat, "end_invert_h", rawStartInvH));
        const rawStartCoverM = Number(getFeatProp(feat, "start_cover_m", NaN));
        const rawEndCoverM = Number(getFeatProp(feat, "end_cover_m", rawStartCoverM));

        let startDepthM = Number(getFeatProp(feat, "start_depth_m", NaN));
        if (!Number.isFinite(startDepthM) || startDepthM <= 0) {
          if (Number.isFinite(rawStartCoverM) && rawStartCoverM > 0) {
            startDepthM = rawStartCoverM + heightM;
          } else if (
            Number.isFinite(startGroundH) &&
            Number.isFinite(rawStartInvH) &&
            startGroundH - rawStartInvH >= 0.35 &&
            startGroundH - rawStartInvH <= 16.0
          ) {
            startDepthM = startGroundH - rawStartInvH;
          } else {
            startDepthM = Math.max(defDepth, heightM + 1.1);
          }
        }

        let endDepthM = Number(getFeatProp(feat, "end_depth_m", NaN));
        if (!Number.isFinite(endDepthM) || endDepthM <= 0) {
          if (Number.isFinite(rawEndCoverM) && rawEndCoverM > 0) {
            endDepthM = rawEndCoverM + heightM;
          } else if (
            Number.isFinite(endGroundH) &&
            Number.isFinite(rawEndInvH) &&
            endGroundH - rawEndInvH >= 0.35 &&
            endGroundH - rawEndInvH <= 16.0
          ) {
            endDepthM = endGroundH - rawEndInvH;
          } else {
            endDepthM = startDepthM;
          }
        }

        // Compute exact 3D local vertices draped below local ground surface
        const localVertices = [];
        const surfaceTracePts = [];
        const vertexGroundYs = [];
        const vertexInvertDepths = [];

        for (let idx = 0; idx < rawCoords.length; idx++) {
          const c = rawCoords[idx];
          const frac = rawCoords.length > 1 ? idx / (rawCoords.length - 1) : 0.0;
          const interpGroundH =
            Number.isFinite(startGroundH) && Number.isFinite(endGroundH)
              ? startGroundH + frac * (endGroundH - startGroundH)
              : startGroundH;

          const v = twd97ToLocal(c[0], c[1], 0);
          const groundY = sampleLocalGroundY(v.x, v.z, interpGroundH);

          // Exact surveyed invert depth at this vertex (guaranteeing at least 0.5m top cover above crown)
          const invertDepthM = Math.max(heightM + 0.5, startDepthM + frac * (endDepthM - startDepthM));
          const invertY = groundY - invertDepthM;
          v.y = invertY + 0.5 * heightM;

          localVertices.push(v);
          vertexGroundYs.push(groundY);
          vertexInvertDepths.push(invertDepthM);
          surfaceTracePts.push(new THREE.Vector3(v.x, groundY + 0.02, v.z));
        }

        // Save computed engineering elevations on feature for Inspector display
        const firstGroundH = originTwd.h + vertexGroundYs[0];
        const lastGroundH = originTwd.h + vertexGroundYs[vertexGroundYs.length - 1];
        const firstDepthM = vertexInvertDepths[0];
        const lastDepthM = vertexInvertDepths[vertexInvertDepths.length - 1];
        feat.__computed3D = {
          startGroundH: firstGroundH,
          endGroundH: lastGroundH,
          startDepthM: firstDepthM,
          endDepthM: lastDepthM,
          startCoverM: Math.max(0.5, firstDepthM - heightM),
          startInvertH: firstGroundH - firstDepthM,
          endInvertH: lastGroundH - lastDepthM,
        };

        // Surface alignment dashed centerline trace on the road (y = groundY + 0.02, depthTest: true)
        if (surfaceTracePts.length >= 2) {
          const traceGeo = new THREE.BufferGeometry().setFromPoints(surfaceTracePts);
          const traceLine = new THREE.Line(traceGeo, getSurfaceTraceMaterial(layerId));
          traceLine.computeLineDistances();
          traceLine.userData = { isUtilityFeature: true, feature: feat, layerId: layerId };
          traceLine.visible = isLayerVis;
          group.add(traceLine);
        }

        // Build segmented 3D pipes or box culverts
        for (let i = 0; i < localVertices.length - 1; i++) {
          const v1 = localVertices[i];
          const v2 = localVertices[i + 1];
          const gY1 = vertexGroundYs[i];
          const gY2 = vertexGroundYs[i + 1];

          const dist = v1.distanceTo(v2);
          if (dist < 0.05) continue;

          const mid = new THREE.Vector3().addVectors(v1, v2).multiplyScalar(0.5);
          const dir = new THREE.Vector3().subVectors(v2, v1).normalize();
          const up = new THREE.Vector3(0, 1, 0);

          let geom;
          if (isBox) {
            geom = new THREE.BoxGeometry(widthM, dist, heightM);
          } else {
            const radius = diaM * 0.5;
            geom = new THREE.CylinderGeometry(radius, radius, dist, 18);
          }

          // Pass 1: True 3D Depth-Tested Solid Subsurface Pipe/Culvert
          const solidMesh = new THREE.Mesh(geom, getSolidMaterial(layerId, 0.94));
          solidMesh.position.copy(mid);
          solidMesh.quaternion.setFromUnitVectors(up, dir);
          solidMesh.userData = {
            isUtilityFeature: true,
            feature: feat,
            layerId: layerId,
          };
          solidMesh.visible = isLayerVis;
          group.add(solidMesh);

          // Pass 2: GreaterDepth Subsurface X-Ray Ghost Silhouette (only renders where occluded behind ground)
          const xrayMesh = new THREE.Mesh(geom, getXrayGhostMaterial(layerId, 0.28));
          xrayMesh.position.copy(mid);
          xrayMesh.quaternion.copy(solidMesh.quaternion);
          xrayMesh.userData = {
            isUtilityFeature: true,
            feature: feat,
            layerId: layerId,
          };
          xrayMesh.visible = isLayerVis;
          group.add(xrayMesh);

          // Engineering detail: Circumferential pipe joint collar rings every ~6m (or box culvert dark inner bore)
          if (!isBox && dist >= 3.5) {
            const radius = diaM * 0.5;
            const numCollars = Math.min(8, Math.floor(dist / 6.0));
            for (let cIdx = 1; cIdx <= numCollars; cIdx++) {
              const tCollar = cIdx / (numCollars + 1);
              const collarPos = new THREE.Vector3().lerpVectors(v1, v2, tCollar);
              const collarGeom = new THREE.CylinderGeometry(radius * 1.12, radius * 1.12, Math.max(0.12, radius * 0.35), 16);
              const collarMesh = new THREE.Mesh(collarGeom, collarRingMat);
              collarMesh.position.copy(collarPos);
              collarMesh.quaternion.copy(solidMesh.quaternion);
              collarMesh.userData = { layerId: layerId };
              collarMesh.visible = isLayerVis;
              group.add(collarMesh);
            }
          } else if (isBox) {
            // Inner dark bore face at ends of box culvert
            const boreGeom = new THREE.BoxGeometry(widthM * 0.84, dist + 0.02, heightM * 0.82);
            const boreMesh = new THREE.Mesh(boreGeom, culvertBoreMat);
            boreMesh.position.copy(mid);
            boreMesh.quaternion.copy(solidMesh.quaternion);
            boreMesh.userData = { layerId: layerId };
            boreMesh.visible = isLayerVis;
            group.add(boreMesh);
          }

          // Vertical Depth Leader Line strictly from Pipe Center up to Road Surface (NEVER above groundY!)
          const midGroundY = 0.5 * (gY1 + gY2);
          if (midGroundY > mid.y + 0.15) {
            const dropGeo = new THREE.BufferGeometry().setFromPoints([
              new THREE.Vector3(mid.x, mid.y, mid.z),
              new THREE.Vector3(mid.x, midGroundY + 0.02, mid.z),
            ]);
            const dropLine = new THREE.Line(dropGeo, getDepthLeaderMaterial(layerId));
            dropLine.userData = { layerId: layerId };
            dropLine.visible = isLayerVis;
            group.add(dropLine);
          }

          // Directional hydraulic flow chevron cone along pipe axis
          const flowDir = Number(getFeatProp(feat, "flow_direction", 1)) || 1;
          const coneRadius = Math.max(0.09, Math.min(0.32, Math.min(widthM, heightM) * 0.32));
          const coneLen = coneRadius * 2.4;
          const pulseGeom = new THREE.ConeGeometry(coneRadius, coneLen, 10);
          const flowQuat = new THREE.Quaternion().setFromUnitVectors(
            up,
            flowDir >= 0 ? dir : dir.clone().negate()
          );

          const pulseCone = new THREE.Mesh(pulseGeom, pulseSolidMat);
          pulseCone.position.copy(v1);
          pulseCone.quaternion.copy(flowQuat);
          pulseCone.userData = { layerId: layerId, isFlowPulse: true };
          pulseCone.visible = isLayerVis && UTILS_STATE.flowAnimationActive;
          group.add(pulseCone);

          const pulseXrayCone = new THREE.Mesh(pulseGeom, pulseXrayMat);
          pulseXrayCone.position.copy(v1);
          pulseXrayCone.quaternion.copy(flowQuat);
          pulseXrayCone.userData = { layerId: layerId, isFlowPulse: true };
          pulseXrayCone.visible = isLayerVis && UTILS_STATE.flowAnimationActive;
          group.add(pulseXrayCone);

          const meshKey = `${getFeatProp(feat, "id", "pipe")}_seg_${i}`;
          UTILS_STATE.pipeMeshMap.set(meshKey, {
            mesh: solidMesh,
            xrayMesh: xrayMesh,
            layer: layerId,
            v1: v1,
            v2: v2,
            dist: dist,
            dir: dir,
            flowDir: flowDir,
            pulseMesh: pulseCone,
            pulseXrayMesh: pulseXrayCone,
          });
        }
      }

      // 2. Manhole or Catch Basin (Flush Surface Rim Cover + Downward Underground Shaft)
      else if (fType === "manhole" || fType === "catch_basin") {
        const coord = feat.coord || feat.geometry?.coordinates || [0, 0, 0];
        const vBase = twd97ToLocal(coord[0], coord[1], 0);
        const rawRimH = Number(getFeatProp(feat, "rim_h", NaN));
        const rawInvH = Number(getFeatProp(feat, "invert_h", NaN));
        const groundY = sampleLocalGroundY(vBase.x, vBase.z, rawRimH);

        const rawDepth = Number(getFeatProp(feat, "depth_m", NaN));
        const calcDepth =
          Number.isFinite(rawDepth) && rawDepth >= 0.5 && rawDepth <= 15.0
            ? rawDepth
            : Number.isFinite(rawRimH) && Number.isFinite(rawInvH) && rawRimH - rawInvH >= 0.5 && rawRimH - rawInvH <= 15.0
            ? rawRimH - rawInvH
            : 2.2;
        const depthM = Math.max(0.8, Math.min(8.0, calcDepth));
        const rimY = groundY;
        const invertY = rimY - depthM;

        // Save computed engineering metrics for Inspector
        feat.__computed3D = {
          rimH: originTwd.h + rimY,
          invertH: originTwd.h + invertY,
          depthM: depthM,
        };

        // Realistic Manhole Cover & Chamber Radius (320mm to 550mm radius)
        const diaMm = Number(getFeatProp(feat, "diameter_mm", fType === "catch_basin" ? 500 : 650)) || 650;
        const coverRadius = Math.max(0.32, Math.min(0.55, (diaMm / 1000.0) * 0.5));
        const shaftRadius = coverRadius * 0.92;

        // A. Underground Manhole Chamber Cylinder (extending strictly DOWNWARD from rimY - 0.02 to invertY)
        const shaftGeom = new THREE.CylinderGeometry(shaftRadius, shaftRadius, depthM, 18);
        const shaftCenterY = rimY - 0.5 * depthM;

        const mhSolid = new THREE.Mesh(shaftGeom, getSolidMaterial(layerId, 0.92));
        mhSolid.position.set(vBase.x, shaftCenterY, vBase.z);
        mhSolid.userData = {
          isUtilityFeature: true,
          feature: feat,
          layerId: layerId,
        };
        mhSolid.visible = isLayerVis;
        group.add(mhSolid);

        const mhXray = new THREE.Mesh(shaftGeom, getXrayGhostMaterial(layerId, 0.26));
        mhXray.position.set(vBase.x, shaftCenterY, vBase.z);
        mhXray.userData = {
          isUtilityFeature: true,
          feature: feat,
          layerId: layerId,
        };
        mhXray.visible = isLayerVis;
        group.add(mhXray);

        // B. Flush Surface Manhole Cover on the Road (y = rimY + 0.025m, depthTest: true)
        const frameGeom = new THREE.CylinderGeometry(coverRadius * 1.12, coverRadius * 1.15, 0.036, 24);
        const frameMesh = new THREE.Mesh(frameGeom, castIronFrameMat);
        frameMesh.position.set(vBase.x, rimY + 0.018, vBase.z);
        frameMesh.userData = {
          isUtilityFeature: true,
          feature: feat,
          layerId: layerId,
        };
        frameMesh.visible = isLayerVis;
        group.add(frameMesh);

        const lidGeom = new THREE.CylinderGeometry(coverRadius * 0.92, coverRadius * 0.92, 0.042, 24);
        const lidMesh = new THREE.Mesh(lidGeom, getSolidMaterial(layerId, 0.98));
        lidMesh.position.set(vBase.x, rimY + 0.025, vBase.z);
        lidMesh.userData = {
          isUtilityFeature: true,
          feature: feat,
          layerId: layerId,
        };
        lidMesh.visible = isLayerVis;
        group.add(lidMesh);

        // Inner cast-iron waffle crosshair detail on top of cover plate
        const bar1Geom = new THREE.BoxGeometry(coverRadius * 1.6, 0.012, 0.04);
        const bar1Mesh = new THREE.Mesh(bar1Geom, castIronFrameMat);
        bar1Mesh.position.set(vBase.x, rimY + 0.046, vBase.z);
        bar1Mesh.userData = { layerId: layerId };
        bar1Mesh.visible = isLayerVis;
        group.add(bar1Mesh);

        const bar2Geom = new THREE.BoxGeometry(0.04, 0.012, coverRadius * 1.6);
        const bar2Mesh = new THREE.Mesh(bar2Geom, castIronFrameMat);
        bar2Mesh.position.set(vBase.x, rimY + 0.046, vBase.z);
        bar2Mesh.userData = { layerId: layerId };
        bar2Mesh.visible = isLayerVis;
        group.add(bar2Mesh);
      }

      // 3. Above-ground Hydrant or Utility Pole (anchored onto local ground surface)
      else if (fType === "hydrant" || fType === "pole") {
        const coord = feat.coord || feat.geometry?.coordinates || [0, 0, 0];
        const vBase = twd97ToLocal(coord[0], coord[1], 0);
        const groundY = sampleLocalGroundY(vBase.x, vBase.z, getFeatProp(feat, "rim_h", NaN));
        const heightM = fType === "pole" ? 7.5 : 0.95;
        const radiusM = fType === "pole" ? 0.14 : 0.12;

        const geom = new THREE.CylinderGeometry(radiusM * 0.8, radiusM, heightM, 12);
        const mesh = new THREE.Mesh(geom, getSolidMaterial(layerId, 0.95));
        mesh.position.set(vBase.x, groundY + heightM * 0.5, vBase.z);
        mesh.userData = {
          isUtilityFeature: true,
          feature: feat,
          layerId: layerId,
        };
        mesh.visible = isLayerVis;
        group.add(mesh);
      }
    });

    // Add to overlayGroup or scene (without hijacking or teleporting the user's camera)
    if (studioThree.overlayGroup) {
      studioThree.overlayGroup.add(group);
    } else {
      studioThree.scene.add(group);
    }

    if (typeof studioThree.render === "function") {
      studioThree.render();
    } else if (studioThree.renderer && studioThree.camera) {
      studioThree.renderer.render(studioThree.scene, studioThree.camera);
    }

    // Start hydraulic flow animation loop
    startFlowAnimationLoop();
  }

  /**
   * Updates 3D mesh visibility according to the 10 layer toggles.
   */
  function updateLayerVisibility3D() {
    if (!UTILS_STATE.threeGroup) return;

    UTILS_STATE.threeGroup.traverse((child) => {
      if (child.userData && child.userData.layerId) {
        const lyr = UTILITY_LAYERS[child.userData.layerId];
        const isVis = lyr ? lyr.visible !== false : true;
        if (child.userData.isFlowPulse) {
          child.visible = isVis && UTILS_STATE.flowAnimationActive;
        } else {
          child.visible = isVis;
        }
      }
    });

    UTILS_STATE.pipeMeshMap.forEach((entry) => {
      const lyr = UTILITY_LAYERS[entry.layer];
      const isVis = lyr ? lyr.visible !== false : true;
      entry.mesh.visible = isVis;
      if (entry.xrayMesh) entry.xrayMesh.visible = isVis;
      if (entry.pulseMesh) {
        entry.pulseMesh.visible = isVis && UTILS_STATE.flowAnimationActive;
      }
      if (entry.pulseXrayMesh) {
        entry.pulseXrayMesh.visible = isVis && UTILS_STATE.flowAnimationActive;
      }
    });

    const studioThree = window.studioThree;
    if (studioThree && typeof studioThree.render === "function") {
      studioThree.render();
    } else if (studioThree && studioThree.renderer && studioThree.camera && studioThree.scene) {
      studioThree.renderer.render(studioThree.scene, studioThree.camera);
    }
  }

  /**
   * requestAnimationFrame loop for genuine hydraulic flow direction animation.
   */
  function startFlowAnimationLoop() {
    if (UTILS_STATE.animationFrameId) return;

    function animate(timestamp) {
      if (!UTILS_STATE.active || !UTILS_STATE.threeGroup) {
        UTILS_STATE.animationFrameId = null;
        return;
      }

      if (UTILS_STATE.lastAnimTime === 0) UTILS_STATE.lastAnimTime = timestamp;
      const dt = Math.min(0.1, (timestamp - UTILS_STATE.lastAnimTime) / 1000.0);
      UTILS_STATE.lastAnimTime = timestamp;

      if (UTILS_STATE.flowAnimationActive) {
        const speed = 0.65 * UTILS_STATE.flowAnimationSpeed;
        UTILS_STATE.pulseOffset = (UTILS_STATE.pulseOffset + dt * speed) % 1.0;

        UTILS_STATE.pipeMeshMap.forEach((entry) => {
          if (!entry.pulseMesh || !entry.mesh.visible) return;
          const frac = entry.flowDir >= 0 ? UTILS_STATE.pulseOffset : 1.0 - UTILS_STATE.pulseOffset;
          entry.pulseMesh.position.lerpVectors(entry.v1, entry.v2, frac);
          if (entry.pulseXrayMesh) {
            entry.pulseXrayMesh.position.copy(entry.pulseMesh.position);
          }
        });

        const studioThree = window.studioThree;
        if (studioThree && typeof studioThree.render === "function") {
          studioThree.render();
        } else if (studioThree && studioThree.renderer && studioThree.camera && studioThree.scene) {
          studioThree.renderer.render(studioThree.scene, studioThree.camera);
        }
      }

      UTILS_STATE.animationFrameId = requestAnimationFrame(animate);
    }

    UTILS_STATE.animationFrameId = requestAnimationFrame(animate);
  }

  /**
   * Interactive 3D raycasting picker for selecting utility features in studio.
   */
  function pickUtilityFeatureAtScreenXY(screenX, screenY) {
    const studioThree = window.studioThree;
    if (!studioThree || !studioThree.camera || !UTILS_STATE.threeGroup) return null;

    const rect = studioThree.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((screenX - rect.left) / rect.width) * 2 - 1,
      -((screenY - rect.top) / rect.height) * 2 + 1
    );

    const rc = new THREE.Raycaster();
    rc.setFromCamera(mouse, studioThree.camera);
    const hits = rc.intersectObjects(UTILS_STATE.threeGroup.children, true);

    for (let i = 0; i < hits.length; i++) {
      const obj = hits[i].object;
      if (obj && obj.userData && obj.userData.isUtilityFeature && obj.visible !== false) {
        return obj.userData.feature;
      }
    }
    return null;
  }

  // Bind pointerdown in Studio to select utility features when tool is active
  window.addEventListener("pointerdown", (ev) => {
    if (typeof STATE === "undefined" || STATE.activeTool !== "utilities" || !UTILS_STATE.active) return;
    if (ev.target.closest("#studioSidePanel") || ev.target.closest("#studioDock") || ev.target.closest(".bim-dock")) {
      return;
    }

    const feat = pickUtilityFeatureAtScreenXY(ev.clientX, ev.clientY);
    if (feat) {
      UTILS_STATE.selectedFeature = feat;
      const box = document.getElementById("utilSelectedFeatureBox");
      if (box) box.innerHTML = renderSelectedFeatureCardHtml(feat);
    }
  });

  // Global namespace exports
  window.openUtilitiesInspector = openUtilitiesInspector;
  window.closeUtilitiesInspector = closeUtilitiesInspector;
  window.resetUtilitiesOnScanChange = resetUtilitiesOnScanChange;
  window.onUtilitiesPanelClosed = onUtilitiesPanelClosed;
  window.UTILITY_LAYERS = UTILITY_LAYERS;
  window.UTILS_STATE = UTILS_STATE;
})();
