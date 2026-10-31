/**
 * GatheringScans Module 10: Construction QA, Open-Trench Utility 3D Tracer & RTK Stakeout
 * =======================================================================================
 * Implements Milestone 4 & Milestone 5 Civil Engineering & Construction QA tools:
 * 1. 3D Surface Flatness, Levelness & Wall Plumbness Inspector:
 *    - Reference Plane modes: Horizontal, Vertical Plumb, Best-Fit Least Squares
 *    - User-selectable tolerance thresholds (mm)
 *    - Deviation heatmap grid, Pass Rate %, Max High / Max Low 3D pins
 *    - Plumb Tilt Ratio (1:N, mm/m) and ASTM E1155 approximation (F_F / F_L)
 * 2. Open-Trench Buried Utility 3D As-Built Tracer:
 *    - 3D polyline tracing (Invert, Crown, Ground)
 *    - Pipe diameter & type selection (DRAIN, SEWER, WATER, GAS, ELEC, TELECOM)
 *    - Cumulative stationing (0K+000) and segment gradients (% and 1:N)
 *    - Depth of cover evaluation and 3D DXF / CSV export
 * 3. Compare View ΔV Volume Takeoff:
 *    - Polygon-bounded epoch-to-epoch difference volume takeoff
 *    - Mass conservation (BCM, LCM, CCM, Tonnes) and dump truck haulage trips
 * 4. RTK Stakeout Export strictly in Easting, Northing, Elevation (E, N, Z) order:
 *    - PtID, Easting, Northing, Elevation, Code
 *    - Standard CSV, space-delimited TXT (Leica/Trimble), 3D DXF R12
 *    - Printable A4 Construction Field Sheet with sign-off blocks
 *
 * Compliance:
 * - Strictly under 5,000 lines modular ceiling
 * - ZERO Unicode emojis (crisp inline SVGs only)
 * - Comprehensive Bright & Dark Theme Support (via CSS Custom Properties)
 * - Strict 1-word action button labels
 * - TWD97 (121) + TWVD2001 coordinate ordering strictly E, N, Z
 */

(function () {
  "use strict";

  // Crisp inline SVG icons (BIM CAD stroke style, stroke="currentColor", stroke-width="2", fill="none")
  const QA_SVGS = {
    FLATNESS: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M3 12h18"></path><path d="M3 6h18"></path><path d="M3 18h18"></path></svg>`,
    PLUMB: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><line x1="12" y1="2" x2="12" y2="18"></line><circle cx="12" cy="19.5" r="2.5"></circle></svg>`,
    PIPE: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><rect x="2" y="7" width="20" height="10" rx="2"></rect><line x1="6" y1="7" x2="6" y2="17"></line><line x1="18" y1="7" x2="18" y2="17"></line></svg>`,
    STAKEOUT: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><circle cx="12" cy="12" r="9"></circle><path d="M12 3v18"></path><path d="M3 12h18"></path></svg>`,
    COMPARE: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><rect x="2" y="4" width="9" height="16" rx="1"></rect><rect x="13" y="4" width="9" height="16" rx="1"></rect></svg>`,
    CHECK: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    PICK: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M21 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"></path><path d="M12 12l9 9"></path><path d="M16 21l5-5"></path></svg>`,
    RESET: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>`,
    CSV: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="16" y2="17"></line></svg>`,
    DXF: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>`,
    PRINT: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>`,
    ALERT: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`,
    CALC: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><rect x="4" y="2" width="16" height="20" rx="2"></rect><line x1="8" y1="6" x2="16" y2="6"></line><line x1="16" y1="14" x2="16" y2="18"></line><path d="M16 10h.01"></path><path d="M12 10h.01"></path><path d="M8 10h.01"></path><path d="M12 14h.01"></path><path d="M8 14h.01"></path><path d="M12 18h.01"></path><path d="M8 18h.01"></path></svg>`,
  };

  // Safe float parsing helper
  function safeFloat(val, fallback) {
    if (val === undefined || val === null) return fallback;
    const s = String(val).trim();
    if (!s || s.toLowerCase() === "undefined" || s.toLowerCase() === "null" || s.toLowerCase() === "nan") {
      return fallback;
    }
    const f = parseFloat(s);
    return Number.isFinite(f) ? f : fallback;
  }

  // Translation helper
  const t = (zh, en) => (typeof tr === "function" ? tr(zh, en) : zh);

  // Active 3D overlay groups
  let surfaceQa3DGroup = null;
  let utilityTrace3DGroup = null;
  let compareVolume3DGroup = null;
  let stakeout3DGroup = null;

  // Stored state for active tools
  const QA_STATE = {
    surfaceQaPoints: [],
    surfaceQaWallLine: [],
    surfaceQaLastResult: null,
    isPickingFlatnessPoint: false,
    utilityTrenchPoints: [],
    utilityLastResult: null,
    isPickingUtilityPoint: false,
    stakeoutPoints: [],
    stakeoutLastResult: null,
    isPickingStakeoutPoint: false,
  };

  function clear3DGroup(grp) {
    if (!grp) return null;
    if (window.studioThree && window.studioThree.overlayGroup) {
      window.studioThree.overlayGroup.remove(grp);
    }
    grp.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
    });
    return null;
  }

  // =========================================================================
  // 1. 3D SURFACE FLATNESS & PLUMBNESS INSPECTOR
  // =========================================================================

  function openSurfaceFlatnessQaInspector() {
    if (typeof showSidePanel !== "function") return;
    const scanId = (window.STATE && window.STATE.activeScanId) || "";

    const html = `
      <div class="gs-qa-container" id="surfaceQaContainer">
        <!-- Compact Header & CRS Pill -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-size:12px;font-weight:700;color:var(--ui-text-primary);">
            ${QA_SVGS.FLATNESS} ${t("3D 表面平整與垂直度", "3D Surface Flatness & Plumbness")}
          </span>
          <span class="gcp-crs-pill">EPSG:3826 + TWVD2001</span>
        </div>

        <!-- Reference Mode Selector -->
        <div class="gs-qa-card">
          <div style="font-size:11px;font-weight:700;color:var(--ui-text-secondary);margin-bottom:4px;">
            ${t("基準參考面", "Reference Plane Mode")}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;">
            <label class="gs-qa-mode-pill">
              <input type="radio" name="qaRefMode" value="horizontal" checked style="display:none;" />
              <span>${t("水平面", "Horizontal")}</span>
            </label>
            <label class="gs-qa-mode-pill">
              <input type="radio" name="qaRefMode" value="vertical" style="display:none;" />
              <span>${t("垂直鉛直", "Plumb Wall")}</span>
            </label>
            <label class="gs-qa-mode-pill">
              <input type="radio" name="qaRefMode" value="best_fit" style="display:none;" />
              <span>${t("最佳擬合", "Best-Fit")}</span>
            </label>
          </div>
        </div>

        <!-- Tolerances & Settings -->
        <div class="gs-qa-card">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
            <div>
              <label style="font-size:10.5px;color:var(--ui-text-muted);display:block;margin-bottom:2px;">
                ${t("合格公差 (mm)", "Tolerance (mm)")}
              </label>
              <input type="number" id="qaToleranceMm" class="gs-input" value="10" step="1" min="1" max="100" />
            </div>
            <div>
              <label style="font-size:10.5px;color:var(--ui-text-muted);display:block;margin-bottom:2px;">
                ${t("警戒公差 (mm)", "Secondary (mm)")}
              </label>
              <input type="number" id="qaSecToleranceMm" class="gs-input" value="15" step="1" min="1" max="150" />
            </div>
          </div>
          <div style="margin-top:6px;">
            <label style="font-size:10.5px;color:var(--ui-text-muted);display:block;margin-bottom:2px;">
              ${t("基準高程 (m，留空為平均高)", "Ref Elevation (m, blank=mean)")}
            </label>
            <input type="number" id="qaRefElevation" class="gs-input" placeholder="自動計算" step="0.01" />
          </div>
        </div>

        <!-- 1-Word Action Button Toolbar -->
        <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:4px;margin-top:4px;">
          <button type="button" class="btn-xs primary" id="btnRunSurfaceQa" title="${t("計算表面平整度", "Inspect")}">
            ${QA_SVGS.CHECK} 檢核
          </button>
          <button type="button" class="btn-xs" id="btnPickSurfaceQaPoint" title="${t("在 3D 模型選點", "Pick Point")}">
            ${QA_SVGS.PICK} 選點
          </button>
          <button type="button" class="btn-xs" id="btnResetSurfaceQa" title="${t("重置所有點位與設定", "Reset")}">
            ${QA_SVGS.RESET} 重置
          </button>
          <button type="button" class="btn-xs" id="btnExportSurfaceQaCsv" title="${t("導出檢核報表 CSV", "Export CSV")}">
            ${QA_SVGS.CSV} CSV
          </button>
        </div>

        <!-- Dynamic Results Card -->
        <div id="surfaceQaResultsCard" style="display:none;margin-top:8px;">
          <!-- Populated by renderSurfaceQaResults -->
        </div>
      </div>
    `;

    showSidePanel(t("表面平整度", "Surface Flatness"), html);
    bindSurfaceQaEvents(scanId);
  }

  function bindSurfaceQaEvents(scanId) {
    document.querySelectorAll('input[name="qaRefMode"]').forEach((radio) => {
      radio.addEventListener("change", (e) => {
        document.querySelectorAll(".gs-qa-mode-pill").forEach((p) => p.classList.remove("active"));
        e.target.closest(".gs-qa-mode-pill")?.classList.add("active");
      });
    });
    // Set initial active state on first radio
    document.querySelector('input[name="qaRefMode"]:checked')?.closest(".gs-qa-mode-pill")?.classList.add("active");

    document.getElementById("btnRunSurfaceQa")?.addEventListener("click", () => {
      runSurfaceFlatnessQa(scanId);
    });

    document.getElementById("btnPickSurfaceQaPoint")?.addEventListener("click", () => {
      QA_STATE.isPickingFlatnessPoint = true;
      if (typeof showToast === "function") {
        showToast(t("請在 3D 模型表面點擊取樣", "Click on 3D surface to sample points"));
      }
    });

    document.getElementById("btnResetSurfaceQa")?.addEventListener("click", () => {
      QA_STATE.surfaceQaPoints = [];
      QA_STATE.surfaceQaWallLine = [];
      QA_STATE.surfaceQaLastResult = null;
      surfaceQa3DGroup = clear3DGroup(surfaceQa3DGroup);
      const resEl = document.getElementById("surfaceQaResultsCard");
      if (resEl) resEl.style.display = "none";
      if (typeof showToast === "function") showToast(t("已重置平整度檢核設定", "Surface QA Reset"));
    });

    document.getElementById("btnExportSurfaceQaCsv")?.addEventListener("click", () => {
      if (!QA_STATE.surfaceQaLastResult) {
        if (typeof showToast === "function") showToast(t("請先執行平整度檢核", "Run QA inspection first"));
        return;
      }
      exportSurfaceQaCsv(QA_STATE.surfaceQaLastResult);
    });
  }

  async function runSurfaceFlatnessQa(scanId) {
    const refMode = document.querySelector('input[name="qaRefMode"]:checked')?.value || "horizontal";
    const tolMm = safeFloat(document.getElementById("qaToleranceMm")?.value, 10.0);
    const secTolMm = safeFloat(document.getElementById("qaSecToleranceMm")?.value, 15.0);
    const refElev = safeFloat(document.getElementById("qaRefElevation")?.value, null);

    const payload = {
      scan_id: scanId || (window.STATE && window.STATE.activeScanId) || "",
      reference_mode: refMode,
      tolerance_mm: tolMm,
      secondary_tolerance_mm: secTolMm,
      reference_elevation: refElev,
      points: QA_STATE.surfaceQaPoints.length > 0 ? QA_STATE.surfaceQaPoints : null,
      wall_line: QA_STATE.surfaceQaWallLine.length >= 2 ? QA_STATE.surfaceQaWallLine : null,
    };

    try {
      const res = typeof apiPost === "function" ? await apiPost("/api/survey/surface-qa", payload) : null;
      if (!res || res.status !== "ok") {
        if (typeof showToast === "function") showToast(t("檢核計算失敗", "QA Evaluation failed"));
        return;
      }
      QA_STATE.surfaceQaLastResult = res;
      renderSurfaceQaResults(res);
      renderSurfaceQa3DOverlay(res);
    } catch (err) {
      console.error("[SurfaceQA] Error:", err);
      if (typeof showToast === "function") showToast(t("伺服器連線異常", "Network error"));
    }
  }

  function renderSurfaceQaResults(res) {
    const card = document.getElementById("surfaceQaResultsCard");
    if (!card) return;
    card.style.display = "block";

    const passRate = res.pass_rate_pct !== undefined ? res.pass_rate_pct : 0.0;
    const badgeCls = passRate >= 85.0 ? "pass" : passRate >= 70.0 ? "warn" : "fail";
    const maxHigh = res.max_high || {};
    const maxLow = res.max_low || {};
    const astm = res.astm_e1155 || {};
    const plumb = res.plumb_tilt || {};

    card.innerHTML = `
      <!-- Grade / Pass Rate Banner -->
      <div class="gs-qa-grade-box ${badgeCls}">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:10px;text-transform:uppercase;color:var(--ui-text-muted);">
              ${t("合格率", "Pass Rate")}
            </div>
            <div style="font-size:18px;font-weight:800;color:currentColor;">
              ${passRate}%
            </div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:10.5px;font-weight:700;">
              ${res.pass_count || 0} / ${res.total_points || 0}
            </div>
            <div style="font-size:10px;color:var(--ui-text-muted);">
              RMS: ${res.rms_dev_mm || 0} mm
            </div>
          </div>
        </div>
      </div>

      <!-- Max High & Max Low Metrics -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:6px;">
        <div class="gs-qa-stat-pill">
          <div style="font-size:9.5px;color:var(--ui-text-muted);">${t("最高點 (凸起)", "Max High")}</div>
          <div style="font-size:12px;font-weight:800;color:#ef4444;">
            +${maxHigh.dev_mm || 0} mm
          </div>
          <div style="font-size:9px;color:var(--ui-text-muted);font-family:monospace;">
            H=${maxHigh.h || 0}m
          </div>
        </div>
        <div class="gs-qa-stat-pill">
          <div style="font-size:9.5px;color:var(--ui-text-muted);">${t("最低點 (凹陷)", "Max Low")}</div>
          <div style="font-size:12px;font-weight:800;color:#3b82f6;">
            ${maxLow.dev_mm || 0} mm
          </div>
          <div style="font-size:9px;color:var(--ui-text-muted);font-family:monospace;">
            H=${maxLow.h || 0}m
          </div>
        </div>
      </div>

      <!-- ASTM E1155 & Plumb Tilt Details -->
      <div class="gs-qa-card" style="margin-top:6px;">
        <div style="display:flex;justify-content:space-between;font-size:10.5px;margin-bottom:3px;">
          <span style="color:var(--ui-text-muted);">ASTM E1155 平整指標 (F_F):</span>
          <span style="font-weight:700;color:var(--ui-text-primary);">${astm.ff_flatness || "—"}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10.5px;margin-bottom:3px;">
          <span style="color:var(--ui-text-muted);">水平等級 (F_L):</span>
          <span style="font-weight:700;color:var(--ui-text-primary);">${astm.fl_levelness || "—"}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10.5px;margin-bottom:3px;">
          <span style="color:var(--ui-text-muted);">${t("垂直傾角比率", "Plumb Ratio")}:</span>
          <span style="font-weight:700;color:var(--ui-text-primary);">${plumb.tilt_ratio || "—"} (${plumb.plumb_mm_per_m || 0} mm/m)</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10.5px;">
          <span style="color:var(--ui-text-muted);">${t("傾斜方向", "Azimuth")}:</span>
          <span style="font-weight:700;color:var(--ui-text-primary);">${plumb.azimuth_deg || 0}°</span>
        </div>
      </div>
    `;
  }

  function renderSurfaceQa3DOverlay(res) {
    if (!window.studioThree || !window.studioThree.scene || !window.THREE) return;
    surfaceQa3DGroup = clear3DGroup(surfaceQa3DGroup);
    surfaceQa3DGroup = new window.THREE.Group();
    surfaceQa3DGroup.name = "GS_SurfaceQA_Overlay";

    const pts = res.heatmap_points || [];
    if (pts.length > 0) {
      const positions = [];
      const colors = [];
      const col = new window.THREE.Color();

      pts.forEach((p) => {
        positions.push(p.local_x, p.local_y, p.local_z);
        col.set(p.color || "#10b981");
        colors.push(col.r, col.g, col.b);
      });

      const geom = new window.THREE.BufferGeometry();
      geom.setAttribute("position", new window.THREE.Float32BufferAttribute(positions, 3));
      geom.setAttribute("color", new window.THREE.Float32BufferAttribute(colors, 3));

      const mat = new window.THREE.PointsMaterial({
        size: 0.15,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
      });
      const pointCloud = new window.THREE.Points(geom, mat);
      surfaceQa3DGroup.add(pointCloud);
    }

    if (window.studioThree.overlayGroup) {
      window.studioThree.overlayGroup.add(surfaceQa3DGroup);
    }
  }

  function exportSurfaceQaCsv(res) {
    const pts = res.heatmap_points || [];
    const lines = [
      `# GatheringScans 3D Surface Flatness & Plumbness Report`,
      `# Scan ID: ${res.scan_id} | CRS: EPSG:3826+TWVD2001`,
      `# Reference Mode: ${res.reference_mode} | Tolerance: +/-${res.tolerance_mm}mm`,
      `# Pass Rate: ${res.pass_rate_pct}% (${res.pass_count}/${res.total_points}) | RMS: ${res.rms_dev_mm}mm`,
      `Index,Easting,Northing,Elevation,Deviation_mm,Status`,
    ];
    pts.forEach((p, i) => {
      lines.push(`${i + 1},${p.e},${p.n},${p.h},${p.dev_mm},${p.status.toUpperCase()}`);
    });
    downloadBlob(lines.join("\n"), `surface_qa_${res.scan_id || "scan"}.csv`, "text/csv;charset=utf-8;");
  }

  // =========================================================================
  // 2. OPEN-TRENCH UTILITY 3D TRACER
  // =========================================================================

  function openUtilityTracerInspector() {
    if (typeof showSidePanel !== "function") return;
    const scanId = (window.STATE && window.STATE.activeScanId) || "";

    const html = `
      <div class="gs-qa-container" id="utilityTracerContainer">
        <!-- Compact Header & CRS Pill -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-size:12px;font-weight:700;color:var(--ui-text-primary);">
            ${QA_SVGS.PIPE} ${t("明挖管溝 3D 竣工實測", "Open-Trench Utility 3D Tracer")}
          </span>
          <span class="gcp-crs-pill">EPSG:3826 + TWVD2001</span>
        </div>

        <!-- Pipe Parameters Card -->
        <div class="gs-qa-card">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
            <div>
              <label style="font-size:10.5px;color:var(--ui-text-muted);display:block;margin-bottom:2px;">
                ${t("管線類別", "Utility Type")}
              </label>
              <select id="selUtilPipeType" class="gs-select" style="width:100%;">
                <option value="DRAIN">${t("雨排 (Cyan)", "Storm Drain")}</option>
                <option value="SEWER">${t("污水 (Amber)", "Sewer")}</option>
                <option value="WATER">${t("自來水 (Blue)", "Water Supply")}</option>
                <option value="GAS">${t("瓦斯 (Yellow)", "Gas")}</option>
                <option value="ELEC">${t("電力 (Red)", "Electric")}</option>
                <option value="TELECOM">${t("電信 (Green)", "Telecom")}</option>
              </select>
            </div>
            <div>
              <label style="font-size:10.5px;color:var(--ui-text-muted);display:block;margin-bottom:2px;">
                ${t("管徑 (mm)", "Diameter (mm)")}
              </label>
              <select id="selUtilPipeDia" class="gs-select" style="width:100%;">
                <option value="150">150 mm</option>
                <option value="200">200 mm</option>
                <option value="300" selected>300 mm</option>
                <option value="400">400 mm</option>
                <option value="600">600 mm</option>
                <option value="1000">1000 mm</option>
              </select>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px;">
            <div>
              <label style="font-size:10.5px;color:var(--ui-text-muted);display:block;margin-bottom:2px;">
                ${t("量測點基準", "Point Mode")}
              </label>
              <select id="selUtilPointMode" class="gs-select" style="width:100%;">
                <option value="invert" selected>${t("管底 (Invert)", "Invert")}</option>
                <option value="crown">${t("管頂 (Crown)", "Crown")}</option>
                <option value="ground">${t("地表 (Ground)", "Ground")}</option>
              </select>
            </div>
            <div>
              <label style="font-size:10.5px;color:var(--ui-text-muted);display:block;margin-bottom:2px;">
                ${t("規定覆土深 (m)", "Min Cover (m)")}
              </label>
              <input type="number" id="inpUtilMinCover" class="gs-input" value="1.20" step="0.1" />
            </div>
          </div>
        </div>

        <!-- 1-Word Action Button Toolbar -->
        <div style="display:grid;grid-template-columns:repeat(5, 1fr);gap:4px;margin-top:4px;">
          <button type="button" class="btn-xs primary" id="btnTraceUtility" title="${t("計算管溝高程與坡度", "Trace Pipe")}">
            ${QA_SVGS.PIPE} 追蹤
          </button>
          <button type="button" class="btn-xs" id="btnPickUtilityPoint" title="${t("在 3D 模型拾取管溝點", "Add Point")}">
            ${QA_SVGS.PICK} 加點
          </button>
          <button type="button" class="btn-xs" id="btnClearUtilityTrace" title="${t("清除點位與 3D 模型", "Clear")}">
            ${QA_SVGS.RESET} 清除
          </button>
          <button type="button" class="btn-xs" id="btnExportUtilityCsv" title="${t("導出管溝檢核 CSV", "Export CSV")}">
            ${QA_SVGS.CSV} CSV
          </button>
          <button type="button" class="btn-xs" id="btnExportUtilityDxf" title="${t("導出 3D AutoCAD DXF", "Export DXF")}">
            ${QA_SVGS.DXF} DXF
          </button>
        </div>

        <!-- Dynamic Results Card -->
        <div id="utilityTracerResultsCard" style="display:none;margin-top:8px;">
          <!-- Populated by renderUtilityTraceResults -->
        </div>
      </div>
    `;

    showSidePanel(t("管溝竣工實測", "Utility Tracer"), html);
    bindUtilityTracerEvents(scanId);
  }

  function bindUtilityTracerEvents(scanId) {
    document.getElementById("btnTraceUtility")?.addEventListener("click", () => {
      runUtilityTrace(scanId);
    });

    document.getElementById("btnPickUtilityPoint")?.addEventListener("click", () => {
      QA_STATE.isPickingUtilityPoint = true;
      if (typeof showToast === "function") {
        showToast(t("請在 3D 視圖中連續點擊管溝管底或人孔", "Click on 3D trench to add invert points"));
      }
    });

    document.getElementById("btnClearUtilityTrace")?.addEventListener("click", () => {
      QA_STATE.utilityTrenchPoints = [];
      QA_STATE.utilityLastResult = null;
      utilityTrace3DGroup = clear3DGroup(utilityTrace3DGroup);
      const resEl = document.getElementById("utilityTracerResultsCard");
      if (resEl) resEl.style.display = "none";
      if (typeof showToast === "function") showToast(t("已清除管溝點位", "Utility Points Cleared"));
    });

    document.getElementById("btnExportUtilityCsv")?.addEventListener("click", () => {
      if (!QA_STATE.utilityLastResult) {
        if (typeof showToast === "function") showToast(t("請先執行管溝追蹤", "Run utility trace first"));
        return;
      }
      downloadBlob(
        QA_STATE.utilityLastResult.csv_export || "",
        `utility_trace_${QA_STATE.utilityLastResult.scan_id || "scan"}.csv`,
        "text/csv;charset=utf-8;"
      );
    });

    document.getElementById("btnExportUtilityDxf")?.addEventListener("click", () => {
      if (!QA_STATE.utilityLastResult) {
        if (typeof showToast === "function") showToast(t("請先執行管溝追蹤", "Run utility trace first"));
        return;
      }
      downloadBlob(
        QA_STATE.utilityLastResult.dxf_export || "",
        `utility_trace_${QA_STATE.utilityLastResult.scan_id || "scan"}.dxf`,
        "application/dxf;charset=utf-8;"
      );
    });
  }

  async function runUtilityTrace(scanId) {
    const pipeType = document.getElementById("selUtilPipeType")?.value || "DRAIN";
    const pipeDia = safeFloat(document.getElementById("selUtilPipeDia")?.value, 300.0);
    const ptMode = document.getElementById("selUtilPointMode")?.value || "invert";
    const minCov = safeFloat(document.getElementById("inpUtilMinCover")?.value, 1.20);

    const payload = {
      scan_id: scanId || (window.STATE && window.STATE.activeScanId) || "",
      pipe_type: pipeType,
      pipe_diameter_mm: pipeDia,
      point_mode: ptMode,
      min_cover_m: minCov,
      trench_points: QA_STATE.utilityTrenchPoints.length > 0 ? QA_STATE.utilityTrenchPoints : null,
    };

    try {
      const res = typeof apiPost === "function" ? await apiPost("/api/survey/utility-trace", payload) : null;
      if (!res || res.status !== "ok") {
        if (typeof showToast === "function") showToast(t("管溝追蹤計算失敗", "Utility trace calculation failed"));
        return;
      }
      QA_STATE.utilityLastResult = res;
      renderUtilityTraceResults(res);
      renderUtilityTrace3DOverlay(res);
    } catch (err) {
      console.error("[UtilityTracer] Error:", err);
      if (typeof showToast === "function") showToast(t("連線伺服器異常", "Network error"));
    }
  }

  function renderUtilityTraceResults(res) {
    const card = document.getElementById("utilityTracerResultsCard");
    if (!card) return;
    card.style.display = "block";

    const stations = res.stations || [];
    let tableRows = "";
    stations.forEach((s) => {
      const covCls = s.cover_pass ? "color:#10b981;font-weight:700;" : "color:#ef4444;font-weight:700;";
      tableRows += `
        <tr>
          <td style="font-weight:700;">${s.station_label}</td>
          <td>${s.name}</td>
          <td style="text-align:right;">${s.invert_z}m</td>
          <td style="text-align:right;">${s.crown_z}m</td>
          <td style="text-align:right;${covCls}">${s.cover_depth_m}m</td>
          <td style="text-align:right;">${s.slope_ratio}</td>
        </tr>
      `;
    });

    card.innerHTML = `
      <div class="gs-qa-card">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
          <div>
            <div style="font-size:10px;color:var(--ui-text-muted);">${t("總長度 (2D / 3D)", "Length (2D/3D)")}</div>
            <div style="font-size:12px;font-weight:800;color:var(--ui-text-primary);">
              ${res.total_length_2d_m || 0}m / ${res.total_length_3d_m || 0}m
            </div>
          </div>
          <div>
            <div style="font-size:10px;color:var(--ui-text-muted);">${t("總體坡度", "Overall Slope")}</div>
            <div style="font-size:12px;font-weight:800;color:var(--ui-text-primary);">
              ${res.overall_slope_ratio || "—"} (${res.overall_slope_pct || 0}%)
            </div>
          </div>
        </div>
      </div>

      <!-- Station Table -->
      <div style="max-height:160px;overflow-y:auto;border:1px solid var(--ui-border);border-radius:6px;margin-top:6px;">
        <table class="gs-qa-table" style="width:100%;font-size:10px;">
          <thead>
            <tr>
              <th>${t("樁號", "Station")}</th>
              <th>${t("點號", "Pt")}</th>
              <th style="text-align:right;">${t("管底", "Invert")}</th>
              <th style="text-align:right;">${t("管頂", "Crown")}</th>
              <th style="text-align:right;">${t("覆土", "Cover")}</th>
              <th style="text-align:right;">${t("坡度", "Slope")}</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderUtilityTrace3DOverlay(res) {
    if (!window.studioThree || !window.studioThree.scene || !window.THREE) return;
    utilityTrace3DGroup = clear3DGroup(utilityTrace3DGroup);
    utilityTrace3DGroup = new window.THREE.Group();
    utilityTrace3DGroup.name = "GS_UtilityTrace_Overlay";

    const stations = res.stations || [];
    if (stations.length >= 2) {
      const invPoints = stations.map((s) => new window.THREE.Vector3(s.local_x, s.local_y, s.local_z));
      const crownPoints = stations.map(
        (s) => new window.THREE.Vector3(s.local_x, s.local_y + (res.pipe_diameter_m || 0.3), s.local_z)
      );

      // Invert Centerline
      const invGeom = new window.THREE.BufferGeometry().setFromPoints(invPoints);
      const invMat = new window.THREE.LineBasicMaterial({ color: 0x06b6d4, linewidth: 3 });
      utilityTrace3DGroup.add(new window.THREE.Line(invGeom, invMat));

      // Crown Centerline
      const crownGeom = new window.THREE.BufferGeometry().setFromPoints(crownPoints);
      const crownMat = new window.THREE.LineBasicMaterial({ color: 0x10b981, linewidth: 2 });
      utilityTrace3DGroup.add(new window.THREE.Line(crownGeom, crownMat));

      // Station Marker Cylinders
      const dia = res.pipe_diameter_m || 0.3;
      const cylGeom = new window.THREE.CylinderGeometry(dia * 0.5, dia * 0.5, 0.4, 16);
      const cylMat = new window.THREE.MeshStandardMaterial({ color: 0x06b6d4, roughness: 0.3 });

      stations.forEach((s) => {
        const mesh = new window.THREE.Mesh(cylGeom, cylMat);
        mesh.position.set(s.local_x, s.local_y + dia * 0.5, s.local_z);
        utilityTrace3DGroup.add(mesh);
      });
    }

    if (window.studioThree.overlayGroup) {
      window.studioThree.overlayGroup.add(utilityTrace3DGroup);
    }
  }

  // =========================================================================
  // 3. COMPARE VIEW ΔV VOLUME TAKEOFF
  // =========================================================================

  function openCompareVolumeTakeoffInspector() {
    if (typeof showSidePanel !== "function") return;
    const baseId = (window.STATE && window.STATE.compareBaseScanId) || (window.STATE && window.STATE.activeScanId) || "";
    const compId = (window.STATE && window.STATE.compareScanId) || baseId;

    const html = `
      <div class="gs-qa-container" id="compareVolumeContainer">
        <!-- Compact Header & CRS Pill -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-size:12px;font-weight:700;color:var(--ui-text-primary);">
            ${QA_SVGS.COMPARE} ${t("多時期比對 ΔV 土方計算", "Compare View ΔV Volume")}
          </span>
          <span class="gcp-crs-pill">EPSG:3826 + TWVD2001</span>
        </div>

        <!-- Scan Epoches Selector -->
        <div class="gs-qa-card">
          <div style="font-size:10.5px;color:var(--ui-text-muted);margin-bottom:2px;">
            ${t("基期 (Epoch 1) vs 比對期 (Epoch 2)", "Baseline vs Compare Epoch")}
          </div>
          <div style="font-size:11px;font-weight:700;color:var(--ui-text-primary);">
            ${baseId || "Baseline"} &nbsp;&rarr;&nbsp; ${compId || "Compare"}
          </div>

        </div>

        <!-- Material Parameters -->
        <div class="gs-qa-card">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
            <div>
              <label style="font-size:10.5px;color:var(--ui-text-muted);display:block;margin-bottom:2px;">
                ${t("土壤土質", "Material")}
              </label>
              <select id="selCmpSoilMaterial" class="gs-select" style="width:100%;">
                <option value="common_earth" selected>${t("普通土 (Common Earth)", "Common Earth")}</option>
                <option value="crushed_rock">${t("碎石級配 (Crushed Rock)", "Crushed Rock")}</option>
                <option value="clay">${t("黏土 (Clay)", "Clay")}</option>
                <option value="sand">${t("砂土 (Sand)", "Sand")}</option>
              </select>
            </div>
            <div>
              <label style="font-size:10.5px;color:var(--ui-text-muted);display:block;margin-bottom:2px;">
                ${t("卡車容量 (m³)", "Truck (m³)")}
              </label>
              <input type="number" id="inpCmpTruckCap" class="gs-input" value="12" step="1" />
            </div>
          </div>
        </div>

        <!-- 1-Word Action Button Toolbar -->
        <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:4px;margin-top:4px;">
          <button type="button" class="btn-xs primary" id="btnRunCompareVolume" title="${t("計算時期差體積", "Compute")}">
            ${QA_SVGS.CALC} 計算
          </button>
          <button type="button" class="btn-xs" id="btnPickComparePoly" title="${t("在 3D 模型繪製多邊形範圍", "Polygon")}">
            ${QA_SVGS.PICK} 圈選
          </button>
          <button type="button" class="btn-xs" id="btnExportCompareCsv" title="${t("導出體積報表", "Export CSV")}">
            ${QA_SVGS.CSV} 導出
          </button>
        </div>

        <!-- Dynamic Results Card -->
        <div id="compareVolumeResultsCard" style="display:none;margin-top:8px;">
          <!-- Populated by renderCompareVolumeResults -->
        </div>
      </div>
    `;

    showSidePanel(t("時期差體積計算", "Compare Volume"), html);
    bindCompareVolumeEvents(baseId, compId);
  }

  function bindCompareVolumeEvents(baseId, compId) {
    document.getElementById("btnRunCompareVolume")?.addEventListener("click", () => {
      runCompareVolumeTakeoff(baseId, compId);
    });
  }

  async function runCompareVolumeTakeoff(baseId, compId) {
    const matType = document.getElementById("selCmpSoilMaterial")?.value || "common_earth";
    const truckCap = safeFloat(document.getElementById("inpCmpTruckCap")?.value, 12.0);

    const payload = {
      baseline_scan_id: baseId,
      compare_scan_id: compId,
      material_type: matType,
      truck_capacity_m3: truckCap,
      polygon: (window.STATE && window.STATE.activeVolumePolygon) || null,
    };

    try {
      const res = typeof apiPost === "function" ? await apiPost("/api/survey/compare-volume", payload) : null;
      if (!res || res.status !== "ok") {
        if (typeof showToast === "function") showToast(t("時期差體積計算失敗", "Compare volume failed"));
        return;
      }
      renderCompareVolumeResults(res);
    } catch (err) {
      console.error("[CompareVolume] Error:", err);
      if (typeof showToast === "function") showToast(t("網路連線異常", "Network error"));
    }
  }

  function renderCompareVolumeResults(res) {
    const card = document.getElementById("compareVolumeResultsCard");
    if (!card) return;
    card.style.display = "block";

    const bal = res.site_balance || {};
    card.innerHTML = `
      <div class="gs-qa-grade-box pass">
        <div style="font-size:10px;text-transform:uppercase;color:var(--ui-text-muted);">
          ${t("淨土方差 (ΔV)", "Net Volume (ΔV)")}
        </div>
        <div style="font-size:18px;font-weight:800;color:currentColor;">
          ${res.net_volume_delta_m3 > 0 ? "+" : ""}${res.net_volume_delta_m3 || 0} m³
        </div>
        <div style="font-size:10.5px;font-weight:700;margin-top:2px;">
          ${bal.type || "—"}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:6px;">
        <div class="gs-qa-stat-pill">
          <div style="font-size:9.5px;color:var(--ui-text-muted);">${t("挖方 (BCM)", "Cut (BCM)")}</div>
          <div style="font-size:12px;font-weight:800;color:#ef4444;">
            ${res.cut_volume_bcm || 0} m³
          </div>
          <div style="font-size:9px;color:var(--ui-text-muted);">${res.cut_mass_tonnes || 0} t</div>
        </div>
        <div class="gs-qa-stat-pill">
          <div style="font-size:9.5px;color:var(--ui-text-muted);">${t("填方 (CCM)", "Fill (CCM)")}</div>
          <div style="font-size:12px;font-weight:800;color:#3b82f6;">
            ${res.fill_volume_ccm || 0} m³
          </div>
          <div style="font-size:9px;color:var(--ui-text-muted);">${res.fill_mass_tonnes || 0} t</div>
        </div>
      </div>

      <div class="gs-qa-card" style="margin-top:6px;">
        <div style="display:flex;justify-content:space-between;font-size:10.5px;margin-bottom:3px;">
          <span style="color:var(--ui-text-muted);">${t("預估卡車車次", "Haul Trips")}:</span>
          <span style="font-weight:700;color:var(--ui-text-primary);">${bal.truck_trips || 0} ${t("車次", "trips")}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10.5px;">
          <span style="color:var(--ui-text-muted);">${t("拘束限制條件", "Limiting Constraint")}:</span>
          <span style="font-weight:700;color:var(--ui-text-primary);">${bal.limiting_constraint || "—"}</span>
        </div>
      </div>
    `;
  }

  // =========================================================================
  // 4. RTK STAKEOUT EXPORT STRICTLY IN E, N, Z ORDER
  // =========================================================================

  function openRtkStakeoutInspector() {
    if (typeof showSidePanel !== "function") return;
    const scanId = (window.STATE && window.STATE.activeScanId) || "";

    const html = `
      <div class="gs-qa-container" id="rtkStakeoutContainer">
        <!-- Compact Header & Mandatory E, N, Z Coordinate Pill -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-size:12px;font-weight:700;color:var(--ui-text-primary);">
            ${QA_SVGS.STAKEOUT} ${t("RTK 工地放樣導出", "RTK Stakeout Export")}
          </span>
          <span class="gcp-crs-pill" style="color:#059669;border-color:rgba(16,185,129,0.4);">
            PtID, E, N, Z, Code
          </span>
        </div>

        <!-- Mode Selector -->
        <div class="gs-qa-card">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
            <label class="gs-qa-mode-pill active">
              <input type="radio" name="stkSourceMode" value="custom" checked style="display:none;" />
              <span>${t("自選點位", "Custom Points")}</span>
            </label>
            <label class="gs-qa-mode-pill">
              <input type="radio" name="stkSourceMode" value="grid" style="display:none;" />
              <span>${t("基礎網格", "Grid Array")}</span>
            </label>
          </div>
        </div>

        <!-- 1-Word Action Button Toolbar -->
        <div style="display:grid;grid-template-columns:repeat(5, 1fr);gap:4px;margin-top:4px;">
          <button type="button" class="btn-xs primary" id="btnGenStakeout" title="${t("生成放樣點位", "Generate")}">
            ${QA_SVGS.STAKEOUT} 放樣
          </button>
          <button type="button" class="btn-xs" id="btnPickStakeoutPt" title="${t("在 3D 視圖中拾取放樣點", "Pick Pt")}">
            ${QA_SVGS.PICK} 加點
          </button>
          <button type="button" class="btn-xs" id="btnExportStakeoutCsv" title="${t("導出標準 CSV (嚴格 E N Z 順序)", "CSV")}">
            ${QA_SVGS.CSV} CSV
          </button>
          <button type="button" class="btn-xs" id="btnExportStakeoutTxt" title="${t("導出 Leica/Trimble TXT", "TXT")}">
            ${QA_SVGS.PIPE} TXT
          </button>
          <button type="button" class="btn-xs" id="btnPrintStakeoutSheet" title="${t("列印 A4 現場放樣檢核記錄表", "Print")}">
            ${QA_SVGS.PRINT} 列印
          </button>
        </div>

        <!-- Point List Preview Card -->
        <div id="stakeoutPointsCard" style="margin-top:8px;">
          <!-- Populated by renderStakeoutPointsTable -->
        </div>
      </div>
    `;

    showSidePanel(t("RTK 放樣導出", "RTK Stakeout"), html);
    bindRtkStakeoutEvents(scanId);
    runGenerateStakeout(scanId);
  }

  function bindRtkStakeoutEvents(scanId) {
    document.getElementById("btnGenStakeout")?.addEventListener("click", () => {
      runGenerateStakeout(scanId);
    });

    document.getElementById("btnPickStakeoutPt")?.addEventListener("click", () => {
      QA_STATE.isPickingStakeoutPoint = true;
      if (typeof showToast === "function") {
        showToast(t("請在 3D 視圖中點擊放置放樣點", "Click on 3D view to add stakeout point"));
      }
    });

    document.getElementById("btnExportStakeoutCsv")?.addEventListener("click", () => {
      if (!QA_STATE.stakeoutLastResult) return;
      downloadBlob(
        QA_STATE.stakeoutLastResult.csv_export || "",
        `stakeout_ENZ_${QA_STATE.stakeoutLastResult.scan_id || "site"}.csv`,
        "text/csv;charset=utf-8;"
      );
    });

    document.getElementById("btnExportStakeoutTxt")?.addEventListener("click", () => {
      if (!QA_STATE.stakeoutLastResult) return;
      downloadBlob(
        QA_STATE.stakeoutLastResult.txt_export || "",
        `stakeout_rover_${QA_STATE.stakeoutLastResult.scan_id || "site"}.txt`,
        "text/plain;charset=utf-8;"
      );
    });

    document.getElementById("btnPrintStakeoutSheet")?.addEventListener("click", () => {
      if (!QA_STATE.stakeoutLastResult || !QA_STATE.stakeoutLastResult.html_field_sheet) return;
      const win = window.open("", "_blank");
      if (win) {
        win.document.write(QA_STATE.stakeoutLastResult.html_field_sheet);
        win.document.close();
        win.focus();
        setTimeout(() => win.print(), 350);
      }
    });
  }

  async function runGenerateStakeout(scanId) {
    const srcMode = document.querySelector('input[name="stkSourceMode"]:checked')?.value || "custom";
    const payload = {
      scan_id: scanId || (window.STATE && window.STATE.activeScanId) || "",
      source_mode: srcMode,
      points: QA_STATE.stakeoutPoints.length > 0 ? QA_STATE.stakeoutPoints : null,
    };

    try {
      const res = typeof apiPost === "function" ? await apiPost("/api/survey/stakeout-export", payload) : null;
      if (!res || res.status !== "ok") return;
      QA_STATE.stakeoutLastResult = res;
      renderStakeoutPointsTable(res);
      renderStakeout3DOverlay(res);
    } catch (err) {
      console.error("[RTKStakeout] Error:", err);
    }
  }

  function renderStakeoutPointsTable(res) {
    const card = document.getElementById("stakeoutPointsCard");
    if (!card) return;

    const pts = res.points || [];
    let rows = "";
    pts.forEach((p) => {
      rows += `
        <tr>
          <td style="font-weight:700;">${p.ptid}</td>
          <td style="font-family:monospace;text-align:right;">${p.easting.toFixed(3)}</td>
          <td style="font-family:monospace;text-align:right;">${p.northing.toFixed(3)}</td>
          <td style="font-family:monospace;text-align:right;">${p.elevation.toFixed(3)}</td>
          <td>${p.code}</td>
        </tr>
      `;
    });

    card.innerHTML = `
      <div style="max-height:200px;overflow-y:auto;border:1px solid var(--ui-border);border-radius:6px;">
        <table class="gs-qa-table" style="width:100%;font-size:10px;">
          <thead>
            <tr>
              <th>PtID</th>
              <th style="text-align:right;">Easting (m)</th>
              <th style="text-align:right;">Northing (m)</th>
              <th style="text-align:right;">Elev (m)</th>
              <th>Code</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderStakeout3DOverlay(res) {
    if (!window.studioThree || !window.studioThree.scene || !window.THREE) return;
    stakeout3DGroup = clear3DGroup(stakeout3DGroup);
    stakeout3DGroup = new window.THREE.Group();
    stakeout3DGroup.name = "GS_Stakeout_Overlay";

    const pts = res.points || [];
    const pinGeom = new window.THREE.ConeGeometry(0.12, 0.4, 8);
    pinGeom.rotateX(Math.PI);
    const pinMat = new window.THREE.MeshStandardMaterial({ color: 0xeab308, roughness: 0.3 });

    pts.forEach((p) => {
      const pin = new window.THREE.Mesh(pinGeom, pinMat);
      pin.position.set(p.local_x, p.local_y + 0.2, p.local_z);
      stakeout3DGroup.add(pin);
    });

    if (window.studioThree.overlayGroup) {
      window.studioThree.overlayGroup.add(stakeout3DGroup);
    }
  }

  // Blob download utility
  function downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  // Global exports & API bindings
  window.openSurfaceFlatnessQaInspector = openSurfaceFlatnessQaInspector;
  window.openUtilityTracerInspector = openUtilityTracerInspector;
  window.openCompareVolumeTakeoffInspector = openCompareVolumeTakeoffInspector;
  window.openRtkStakeoutInspector = openRtkStakeoutInspector;

  // Handle URL parameters auto-launching
  if (typeof window !== "undefined" && window.location) {
    try {
      const q = new URLSearchParams(window.location.search);
      const tool = q.get("tool") || q.get("inspect");
      if (["surface_qa", "utility_trace", "compare_volume", "rtk_stakeout"].includes(tool)) {
        const interval = setInterval(() => {
          if (window.STATE && window.STATE.activeScanId && window.studioThree && window.studioThree.scene) {
            clearInterval(interval);
            setTimeout(() => {
              if (tool === "surface_qa") openSurfaceFlatnessQaInspector();
              else if (tool === "utility_trace") openUtilityTracerInspector();
              else if (tool === "compare_volume") openCompareVolumeTakeoffInspector();
              else if (tool === "rtk_stakeout") openRtkStakeoutInspector();
            }, 800);
          }
        }, 400);
        setTimeout(() => clearInterval(interval), 25000);
      }
    } catch (_) {}
  }
})();
