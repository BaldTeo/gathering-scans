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
 * 3. 3D Subsurface Visualization in Three.js:
 *    - Cylindrical pipes scaled to genuine diameter (DIA mm)
 *    - Box culverts scaled to genuine dimensions (W x H)
 *    - Vertical manhole structures from ground surface to invert elevation
 *    - Clickable 3D elements showing hydraulic profile & invert elevations
 * 4. Animated Hydraulic Flow Direction:
 *    - Flow animation loop in requestAnimationFrame (moving pulses/texture offsets along pipe axis)
 *    - Directional flow from upstream (UIE) to downstream (DIE) or gravity gradient
 *    - User-adjustable animation toggle and speed slider
 * 5. Import & Export:
 *    - MOI NGIS GML 3.1.1, GeoJSON, KML file drop & parse
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
  };

  // 10 Standard Public Utility Layers Specification
  const UTILITY_LAYERS = {
    storm: { id: "storm", name_zh: "雨水下水道", name_en: "Storm Sewer", color: "#06b6d4", visible: true, count: 0 },
    sanitary: { id: "sanitary", name_zh: "污水下水道", name_en: "Sanitary Sewer", color: "#d97706", visible: true, count: 0 },
    water: { id: "water", name_zh: "自來水/消防栓", name_en: "Water & Hydrants", color: "#3b82f6", visible: true, count: 0 },
    electric: { id: "electric", name_zh: "電力/電桿", name_en: "Electricity & Poles", color: "#ef4444", visible: true, count: 0 },
    telecom: { id: "telecom", name_zh: "電信/光纖", name_en: "Telecom & Fiber", color: "#10b981", visible: true, count: 0 },
    gas: { id: "gas", name_zh: "瓦斯管線", name_en: "Natural Gas", color: "#eab308", visible: true, count: 0 },
    ducts: { id: "ducts", name_zh: "共同管道", name_en: "Common Ducts", color: "#8b5cf6", visible: true, count: 0 },
    streetlights: { id: "streetlights", name_zh: "路燈照明", name_en: "Streetlights", color: "#f59e0b", visible: true, count: 0 },
    excavations: { id: "excavations", name_zh: "道路挖掘", name_en: "Road Excavation", color: "#ec4899", visible: true, count: 0 },
    as_built: { id: "as_built", name_zh: "竣工實測", name_en: "As-Built Traced", color: "#14b8a6", visible: true, count: 0 },
  };

  // Module state
  const UTILS_STATE = {
    active: false,
    radiusM: 120.0,
    features: [],
    selectedFeature: null,
    flowAnimationActive: true,
    flowAnimationSpeed: 1.0,
    animationFrameId: null,
    lastAnimTime: 0,
    pulseOffset: 0.0,
    threeGroup: null,
    pipeMeshMap: new Map(), // featId -> { mesh, layer, flowDir, curve, pts }
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
   * Opens the dedicated Public Utilities GIS inspector side panel.
   */
  async function openUtilitiesInspector() {
    UTILS_STATE.active = true;
    if (typeof setActiveStudioTool === "function") {
      setActiveStudioTool("utilities");
    } else {
      STATE.activeTool = "utilities";
    }

    renderUtilitiesSidePanel();

    // If no features loaded yet, automatically trigger genuine live query around current scan
    if (!UTILS_STATE.features || UTILS_STATE.features.length === 0) {
      await runUtilitiesQuery();
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
      if (f.type === "pipe" || f.type === "box_culvert") {
        totalPipes++;
        totalPipeLen += Number(f.length_m || 0);
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
      : `<div class="gs-util-hint-card">${t("點擊 3D 管線或人孔檢視高程與流向", "Click 3D pipe or manhole to inspect invert elevation & flow")}</div>`;

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
              <button type="button" class="gs-btn gs-btn-primary" id="btnUtilQuery" title="${t("查詢現場周圍真實公共管線", "Query real public utilities around scan")}">
                ${SVG.SEARCH} ${t("查詢", "Query")}
              </button>
              <button type="button" class="gs-btn" id="btnUtilUpload" title="${t("匯入 MOI NGIS GML 3.1.1、GeoJSON 或 KML 管線檔案", "Import MOI NGIS GML 3.1.1, GeoJSON, or KML file")}">
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
            <span>${SVG.EYE} ${t("管線圖層開關 (10 大類別)", "Utility Layer Toggles")}</span>
            <div style="display:flex;gap:4px;">
              <button type="button" class="gs-btn-text" id="btnUtilAllLayers" style="font-size:10px;">${t("全選", "All")}</button>
              <button type="button" class="gs-btn-text" id="btnUtilNoneLayers" style="font-size:10px;">${t("關閉", "None")}</button>
            </div>
          </div>
          <div class="gs-util-layers-list">
            ${layersHtml}
          </div>
        </div>

        <!-- Flow Direction Animation Controls -->
        <div class="gs-util-section-card">
          <div class="gs-util-section-header">
            <span>${SVG.PIPE} ${t("水力流向動畫模擬", "Hydraulic Flow Animation")}</span>
            <button type="button" class="gs-btn gs-btn-sm" id="btnUtilToggleAnim">
              ${UTILS_STATE.flowAnimationActive ? SVG.PAUSE : SVG.PLAY} ${UTILS_STATE.flowAnimationActive ? t("暫停", "Pause") : t("動畫", "Flow")}
            </button>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
            <span style="font-size:10px;color:var(--ui-text-muted);">${t("流速", "Speed")}</span>
            <input type="range" id="rngUtilAnimSpeed" min="0.2" max="3.0" step="0.2" value="${UTILS_STATE.flowAnimationSpeed}" style="flex:1;" />
            <span style="font-size:11px;font-weight:600;min-width:28px;" id="lblUtilAnimSpeed">${UTILS_STATE.flowAnimationSpeed}x</span>
          </div>
        </div>

        <!-- Selected Feature Inspector Card -->
        <div id="utilSelectedFeatureBox">
          ${selCardHtml}
        </div>

        <!-- Action Export Bar -->
        <div style="display:flex;gap:6px;margin-top:10px;">
          <button type="button" class="gs-btn" id="btnUtilExportGeoJson" style="flex:1;">
            ${SVG.EXPORT} GeoJSON
          </button>
          <button type="button" class="gs-btn" id="btnUtilExportDxf" style="flex:1;">
            ${SVG.EXPORT} DXF
          </button>
          <button type="button" class="gs-btn" id="btnUtilReset" style="width:auto;" title="${t("清除並重新載入", "Reset")}">
            ${SVG.RESET} ${t("重置", "Reset")}
          </button>
        </div>
      </div>
    `;

    if (typeof showSidePanel === "function") {
      showSidePanel(title, html);
    }

    bindUtilitiesPanelEvents();
  }

  function renderSelectedFeatureCardHtml(feat) {
    if (!feat) return "";
    const lyr = UTILITY_LAYERS[feat.layer] || { name_zh: feat.layer, color: "#94a3b8" };
    const diaText = feat.diameter_mm ? `D=${feat.diameter_mm}mm` : "";
    const dimText = feat.width_m && feat.height_m ? `${feat.width_m}x${feat.height_m}m` : diaText;
    const invStart = feat.start_invert_h !== undefined ? Number(feat.start_invert_h).toFixed(2) + "m" : "--";
    const invEnd = feat.end_invert_h !== undefined ? Number(feat.end_invert_h).toFixed(2) + "m" : "--";
    const slopeText = feat.slope_pct !== undefined ? `${feat.slope_pct}%` : "--";
    const lenText = feat.length_m !== undefined ? `${feat.length_m}m` : "--";

    return `
      <div class="gs-util-detail-card" style="border-left:3px solid ${lyr.color};">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
          <span style="font-weight:700;font-size:12px;color:var(--ui-text-primary);">${escapeHtml(feat.name || feat.id)}</span>
          <span class="gs-util-badge" style="background:${lyr.color}22;color:${lyr.color};border:1px solid ${lyr.color}44;">
            ${t(lyr.name_zh, lyr.name_en)}
          </span>
        </div>
        <div class="gs-util-detail-grid">
          <div><span class="gs-util-detail-lbl">${t("管徑/尺寸", "Size")}:</span> <b>${escapeHtml(dimText)}</b></div>
          <div><span class="gs-util-detail-lbl">${t("長度", "Len")}:</span> <b>${lenText}</b></div>
          <div><span class="gs-util-detail-lbl">${t("起點管底", "US Inv")}:</span> <b>${invStart}</b></div>
          <div><span class="gs-util-detail-lbl">${t("終點管底", "DS Inv")}:</span> <b>${invEnd}</b></div>
          <div><span class="gs-util-detail-lbl">${t("水力坡度", "Slope")}:</span> <b>${slopeText}</b></div>
          <div><span class="gs-util-detail-lbl">${t("流向", "Flow")}:</span> <b>${feat.flow_direction === 1 ? t("起點→終點", "Downstream") : t("雙向/未定", "Bidirectional")}</b></div>
        </div>
        <div style="font-size:10px;color:var(--ui-text-muted);margin-top:4px;">
          ${t("資料來源", "Source")}: ${escapeHtml(feat.source || "Taiwan Open GIS")}
        </div>
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

    // Flow Animation Toggle & Speed
    const btnAnim = document.getElementById("btnUtilToggleAnim");
    if (btnAnim) {
      btnAnim.onclick = () => {
        UTILS_STATE.flowAnimationActive = !UTILS_STATE.flowAnimationActive;
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

    // Reset button
    const btnReset = document.getElementById("btnUtilReset");
    if (btnReset) {
      btnReset.onclick = () => {
        clearUtilitiesVisuals3D();
        UTILS_STATE.features = [];
        UTILS_STATE.selectedFeature = null;
        Object.keys(UTILITY_LAYERS).forEach((k) => (UTILITY_LAYERS[k].count = 0));
        renderUtilitiesSidePanel();
      };
    }
  }

  /**
   * Queries genuine Taiwan Open APIs via backend `/api/survey/utilities-query`.
   */
  async function runUtilitiesQuery(forceRefresh = false) {
    const scanId = STATE.activeScanId || "";
    if (typeof showToast === "function") {
      showToast(t("正在查詢現場周邊公共管線開放圖資...", "Querying public utilities GIS endpoints..."));
    }

    try {
      const payload = {
        scan_id: scanId,
        radius_m: UTILS_STATE.radiusM,
        force_refresh: forceRefresh,
      };

      const res = typeof apiPost === "function" ? await apiPost("/api/survey/utilities-query", payload) : null;
      if (res && res.status === "ok" && Array.isArray(res.features)) {
        UTILS_STATE.features = res.features;

        // Reset counts and sum up
        Object.keys(UTILITY_LAYERS).forEach((k) => (UTILITY_LAYERS[k].count = 0));
        if (res.layer_counts) {
          Object.keys(res.layer_counts).forEach((k) => {
            if (UTILITY_LAYERS[k]) UTILITY_LAYERS[k].count = res.layer_counts[k];
          });
        }

        renderUtilitiesSidePanel();
        renderUtilities3D();

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

        Object.keys(UTILITY_LAYERS).forEach((k) => (UTILITY_LAYERS[k].count = 0));
        if (res.layer_counts) {
          Object.keys(res.layer_counts).forEach((k) => {
            if (UTILITY_LAYERS[k]) UTILITY_LAYERS[k].count = res.layer_counts[k];
          });
        }

        renderUtilitiesSidePanel();
        renderUtilities3D();

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
        scan_id: STATE.activeScanId || "scan",
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
    if (typeof twd97ToStudioLocalVec === "function") {
      return twd97ToStudioLocalVec(e, n, h);
    }
    // Fallback: relative to active scan metadata
    const scan = STATE.scans?.find((s) => s.id === STATE.activeScanId) || {};
    const ce = Number(scan.twd97_e || 0);
    const cn = Number(scan.twd97_n || 0);
    const ch = Number(scan.twd97_h || 0);
    return new THREE.Vector3(Number(e) - ce, Number(h) - ch, cn - Number(n));
  }

  /**
   * Clears all 3D Three.js utilities visuals from studioThree scene.
   */
  function clearUtilitiesVisuals3D() {
    if (UTILS_STATE.animationFrameId) {
      cancelAnimationFrame(UTILS_STATE.animationFrameId);
      UTILS_STATE.animationFrameId = null;
    }

    if (studioThree && studioThree.overlayGroup && UTILS_STATE.threeGroup) {
      studioThree.overlayGroup.remove(UTILS_STATE.threeGroup);
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
   * Builds and renders 3D subsurface pipelines, box culverts, manholes, and flow vectors.
   */
  function renderUtilities3D() {
    clearUtilitiesVisuals3D();
    if (!studioThree || !studioThree.scene || !UTILS_STATE.features || UTILS_STATE.features.length === 0) {
      return;
    }

    const group = new THREE.Group();
    group.name = "PublicUtilitiesGroup";
    UTILS_STATE.threeGroup = group;

    // Materials cache by layer color
    const matCache = new Map();
    function getLayerMaterial(layerId, opacity = 0.88) {
      const ldef = UTILITY_LAYERS[layerId] || { color: "#06b6d4" };
      const key = `${ldef.color}_${opacity}`;
      if (!matCache.has(key)) {
        matCache.set(
          key,
          new THREE.MeshStandardMaterial({
            color: new THREE.Color(ldef.color),
            roughness: 0.35,
            metalness: 0.25,
            transparent: true,
            opacity: opacity,
            depthWrite: true,
          })
        );
      }
      return matCache.get(key);
    }

    // Material for flow direction pulses
    const pulseMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
    });

    UTILS_STATE.features.forEach((feat) => {
      const layerId = feat.layer || "storm";
      const ldef = UTILITY_LAYERS[layerId] || { color: "#06b6d4" };

      // 1. Pipe or Box Culvert
      if (feat.type === "pipe" || feat.type === "box_culvert") {
        const coords = feat.coords || [feat.start_coord, feat.end_coord];
        if (!coords || coords.length < 2) return;

        // Create segmented 3D cylinders or boxes
        for (let i = 0; i < coords.length - 1; i++) {
          const c1 = coords[i];
          const c2 = coords[i + 1];
          const v1 = twd97ToLocal(c1[0], c1[1], c1[2]);
          const v2 = twd97ToLocal(c2[0], c2[1], c2[2]);

          const dist = v1.distanceTo(v2);
          if (dist < 0.05) continue;

          const mid = new THREE.Vector3().addVectors(v1, v2).multiplyScalar(0.5);
          const dir = new THREE.Vector3().subVectors(v2, v1).normalize();

          let geom;
          const diaM = Math.max(0.12, (Number(feat.diameter_mm) || 300) / 1000.0);
          const isBox = feat.type === "box_culvert" || (feat.width_m > 0 && feat.height_m > 0);

          if (isBox) {
            const wm = Math.max(0.3, Number(feat.width_m) || diaM);
            const hm = Math.max(0.3, Number(feat.height_m) || diaM);
            geom = new THREE.BoxGeometry(wm, dist, hm);
          } else {
            const radius = diaM * 0.5;
            geom = new THREE.CylinderGeometry(radius, radius, dist, 16);
          }

          const mesh = new THREE.Mesh(geom, getLayerMaterial(layerId));
          mesh.position.copy(mid);

          // Align Y axis to direction
          const up = new THREE.Vector3(0, 1, 0);
          mesh.quaternion.setFromUnitVectors(up, dir);

          mesh.userData = {
            isUtilityFeature: true,
            feature: feat,
            layerId: layerId,
          };
          mesh.visible = ldef.visible !== false;

          group.add(mesh);

          // Record for flow direction animation
          const meshKey = `${feat.id}_seg_${i}`;
          UTILS_STATE.pipeMeshMap.set(meshKey, {
            mesh: mesh,
            layer: layerId,
            v1: v1,
            v2: v2,
            dist: dist,
            dir: dir,
            flowDir: feat.flow_direction || 1,
            pulseMesh: null,
          });

          // Add a small animated pulse indicator sphere
          const pulseGeom = new THREE.SphereGeometry(diaM * 0.4, 8, 8);
          const pulseSphere = new THREE.Mesh(pulseGeom, pulseMat);
          pulseSphere.position.copy(v1);
          pulseSphere.visible = ldef.visible !== false && UTILS_STATE.flowAnimationActive;
          group.add(pulseSphere);
          UTILS_STATE.pipeMeshMap.get(meshKey).pulseMesh = pulseSphere;
        }
      }

      // 2. Manhole or Structure
      else if (feat.type === "manhole" || feat.type === "catch_basin") {
        const coord = feat.coord || [0, 0, 0];
        const vBase = twd97ToLocal(coord[0], coord[1], coord[2]);
        const depthM = Math.max(1.0, Number(feat.depth_m) || 2.5);
        const radiusM = 0.6; // 1200mm standard civil manhole

        // Vertical cylinder from invert to rim
        const mhGeom = new THREE.CylinderGeometry(radiusM, radiusM, depthM, 16);
        const mhMat = getLayerMaterial(layerId, 0.92);
        const mhMesh = new THREE.Mesh(mhGeom, mhMat);

        // Center vertically
        mhMesh.position.set(vBase.x, vBase.y + depthM * 0.5, vBase.z);
        mhMesh.userData = {
          isUtilityFeature: true,
          feature: feat,
          layerId: layerId,
        };
        mhMesh.visible = ldef.visible !== false;
        group.add(mhMesh);

        // Rim ring on top
        const ringGeom = new THREE.TorusGeometry(radiusM * 1.05, 0.05, 8, 24);
        const ringMat = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.8, roughness: 0.2 });
        const ringMesh = new THREE.Mesh(ringGeom, ringMat);
        ringMesh.rotation.x = Math.PI / 2;
        ringMesh.position.set(vBase.x, vBase.y + depthM, vBase.z);
        ringMesh.visible = ldef.visible !== false;
        group.add(ringMesh);
      }

      // 3. Hydrant or Pole
      else if (feat.type === "hydrant" || feat.type === "pole") {
        const coord = feat.coord || [0, 0, 0];
        const vBase = twd97ToLocal(coord[0], coord[1], coord[2]);
        const heightM = feat.type === "pole" ? 8.0 : 1.0;
        const radiusM = feat.type === "pole" ? 0.15 : 0.12;

        const geom = new THREE.CylinderGeometry(radiusM * 0.8, radiusM, heightM, 12);
        const mesh = new THREE.Mesh(geom, getLayerMaterial(layerId));
        mesh.position.set(vBase.x, vBase.y + heightM * 0.5, vBase.z);
        mesh.userData = {
          isUtilityFeature: true,
          feature: feat,
          layerId: layerId,
        };
        mesh.visible = ldef.visible !== false;
        group.add(mesh);
      }
    });

    // Add to overlayGroup or scene
    if (studioThree.overlayGroup) {
      studioThree.overlayGroup.add(group);
    } else {
      studioThree.scene.add(group);
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
        child.visible = lyr ? lyr.visible !== false : true;
      }
    });

    UTILS_STATE.pipeMeshMap.forEach((entry) => {
      const lyr = UTILITY_LAYERS[entry.layer];
      const isVis = lyr ? lyr.visible !== false : true;
      entry.mesh.visible = isVis;
      if (entry.pulseMesh) {
        entry.pulseMesh.visible = isVis && UTILS_STATE.flowAnimationActive;
      }
    });

    if (studioThree && typeof studioThree.render === "function") {
      studioThree.render();
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
        // Advance pulse offset along pipe axis
        const speed = 0.75 * UTILS_STATE.flowAnimationSpeed;
        UTILS_STATE.pulseOffset = (UTILS_STATE.pulseOffset + dt * speed) % 1.0;

        UTILS_STATE.pipeMeshMap.forEach((entry) => {
          if (!entry.pulseMesh || !entry.mesh.visible) return;

          // Compute moving position from upstream to downstream (or reverse if flowDir == -1)
          const frac = entry.flowDir >= 0 ? UTILS_STATE.pulseOffset : 1.0 - UTILS_STATE.pulseOffset;
          entry.pulseMesh.position.lerpVectors(entry.v1, entry.v2, frac);
        });

        if (studioThree && typeof studioThree.render === "function") {
          studioThree.render();
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
    if (STATE.activeTool !== "utilities" || !UTILS_STATE.active) return;
    // Don't intercept clicks on UI panels or docks
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

  // Attach dock button event listener
  function bindDockButton() {
    const btn = document.getElementById("btnDockUtilities");
    if (btn) {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (STATE.activeTool === "utilities" && UTILS_STATE.active) {
          closeUtilitiesInspector();
        } else {
          openUtilitiesInspector();
        }
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindDockButton);
  } else {
    bindDockButton();
  }

  // Global namespace exports
  window.openUtilitiesInspector = openUtilitiesInspector;
  window.closeUtilitiesInspector = closeUtilitiesInspector;
  window.UTILITY_LAYERS = UTILITY_LAYERS;
  window.UTILS_STATE = UTILS_STATE;
})();
