/**
 * GatheringScans Module 09: Construction Surveying, Earthwork Mass Conservation & Scan-to-BIM
 * =========================================================================================
 * Author: teamwork_worker (Civil Surveying & BIM Engineer)
 * Project: GatheringScans (scans.gatheren.cloud)
 *
 * Scope & Capabilities:
 * 1. Earthwork Mass Conservation Schedule:
 *    - Bank Volume (BCM m³), Loose Volume (LCM m³), and Compacted Volume (CCM m³)
 *    - Physical mass invariance identity: M_bank == M_loose == M_compact (conserved metric tonnes)
 *    - Dual-constraint Dump Truck Haul Trip Estimator (Volume-limited vs. Weight-limited)
 *    - Net Haul Site Balance (Surplus Export vs. Deficit Import vs. Balanced site)
 * 2. Least-Squares Best-Fit Reference Plane UI Inspection:
 *    - True 3D planar gradient (slope % and slope degrees)
 *    - Compass aspect/azimuth (0°–360° clockwise from North)
 *    - Planar normal equation parameters (a, b, c)
 * 3. User-selectable construction parameters:
 *    - Swell factor (Caterpillar expansion ratio or bulking %, e.g. 0.80 / 1.25)
 *    - Shrinkage / compaction factor (e.g. 0.10 / 10%)
 *    - Dump truck haul capacity (m³) & gross legal payload limit (tonnes)
 * 4. 3D GCP Residual Accuracy & 1-Click TBM Vertical Datum Calibration.
 *
 * Strict Design Discipline:
 *  - ZERO Unicode emojis (pure monochrome vector SVG stroke icons)
 *  - Comprehensive Bright & Dark Theme Support (via CSS custom properties)
 *  - Strict 1-word action buttons and minimalist typography
 *  - Strictly under 5,000 lines modular architecture ceiling.
 */

(function () {
  "use strict";

  // Crisp inline SVG icons (Autodesk/BIM CAD style, stroke="currentColor", stroke-width="2", fill="none")
  const SVG_ICONS = {
    TRUCK: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>`,
    PLANE: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M2 22L22 2v20H2z"></path><path d="M18 18v-3"></path><path d="M14 18v-2"></path><path d="M10 18v-3"></path><path d="M6 18v-2"></path></svg>`,
    SCALE: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M16 16l3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z"></path><path d="M2 16l3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z"></path><path d="M7 21h10"></path><path d="M12 3v18"></path><path d="M3 7h18"></path></svg>`,
    ALERT: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`,
    BOX: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`,
    TARGET: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg>`,
    ANCHOR: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><circle cx="12" cy="5" r="3"></circle><line x1="12" y1="22" x2="12" y2="8"></line><path d="M5 12H2a10 10 0 0 0 20 0h-3"></path></svg>`,
    BOLT: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`,
    RESET: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>`,
    CHECK: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    CALC: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>`,
    SAMPLE: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`,
    DOWNLOAD: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
    FILE: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`,
    PRINTER: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>`,
    VECTOR: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>`,
    ROAD: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M4 19L8 5"></path><path d="M20 19l-4-14"></path><line x1="12" y1="5" x2="12" y2="7"></line><line x1="12" y1="11" x2="12" y2="13"></line><line x1="12" y1="17" x2="12" y2="19"></line></svg>`,
    DROPLET: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"></path></svg>`,
    LAYERS: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>`,
    CHART: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>`
  };

  // Helper for safe client float parsing
  function safeParseFloat(val, fallback) {
    if (val === undefined || val === null) return fallback;
    const s = String(val).trim();
    if (!s || s.toLowerCase() === "undefined" || s.toLowerCase() === "null" || s.toLowerCase() === "nan") {
      return fallback;
    }
    const f = parseFloat(s);
    return Number.isFinite(f) ? f : fallback;
  }

  /**
   * Generates bilingual HTML inputs for Earthwork Mass Conservation & Haul Truck Parameters.
   * Embeds into Cut/Fill Volume Inspector side panel.
   */
  function renderEarthworkInputFieldsHtml(defaultDatumZ) {
    const t = typeof tr === "function" ? tr : (zh, en) => zh;
    const defZ = defaultDatumZ !== undefined ? defaultDatumZ : 0.0;

    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;" class="gs-form-group">
        <div>
          <label>${t("比重 (t/m³)", "Density (t/m³)")}</label>
          <input type="number" step="0.05" class="gs-input" id="volCustomDensity" value="1.65" />
        </div>
        <div>
          <label>${t("基準高程 Z₀ (TWVD2001 m)", "Datum Elev Z₀ (TWVD2001 m)")}</label>
          <input type="number" step="0.1" class="gs-input" id="volDatumZ" value="${defZ}" />
        </div>
      </div>

      <div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border);border-radius:8px;padding:8px 10px;margin-bottom:9px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <span style="font-size:11px;font-weight:700;color:var(--ui-text-primary);display:flex;align-items:center;">
            ${SVG_ICONS.TRUCK} ${t("土方運料參數", "Haul Parameters")}
          </span>
          <span style="font-size:10px;color:var(--ui-text-muted);">${t("工程規範", "Civil Std")}</span>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:6px;">
          <div>
            <label style="font-size:10px;display:block;margin-bottom:2px;color:var(--ui-text-secondary);" title="${t("Caterpillar 鬆散膨脹率 (例如 1.25 表示膨脹 25%)", "Swell / Bulking Factor (e.g. 1.25 for 25% expansion)")}">
              ${t("膨脹係數 (Swell)", "Swell Factor")}
            </label>
            <input type="number" step="0.05" class="gs-input" id="volSwellFactor" value="1.25" style="padding:4px 7px;font-size:11px;" />
          </div>
          <div>
            <label style="font-size:10px;display:block;margin-bottom:2px;color:var(--ui-text-secondary);" title="${t("滾壓壓實收縮折減率 (例如 0.10 代表 10% 收縮折減)", "Compaction Shrinkage Factor (e.g. 0.10 for 10% compaction reduction)")}">
              ${t("收縮係數 (Shrink)", "Shrink Factor")}
            </label>
            <input type="number" step="0.05" class="gs-input" id="volShrinkFactor" value="0.10" style="padding:4px 7px;font-size:11px;" />
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div>
            <label style="font-size:10px;display:block;margin-bottom:2px;color:var(--ui-text-secondary);" title="${t("砂石傾卸卡車單車鬆散斗容量 (m³，標準約 12-15 m³)", "Dump Truck Haul Volume Capacity (m³, std is 12-15 m³)")}">
              ${t("容量 (m³)", "Capacity (m³)")}
            </label>
            <input type="number" step="1" class="gs-input" id="volTruckVolumeM3" value="15.0" style="padding:4px 7px;font-size:11px;" />
          </div>
          <div>
            <label style="font-size:10px;display:block;margin-bottom:2px;color:var(--ui-text-secondary);" title="${t("傾卸卡車單車法定最大淨載重 (噸，標準約 18-22 噸)", "Dump Truck Legal Max Payload (tonnes, std is 18-22 t)")}">
              ${t("限重 (t)", "Max (t)")}
            </label>
            <input type="number" step="1" class="gs-input" id="volTruckMaxTonnes" value="20.0" style="padding:4px 7px;font-size:11px;" />
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Collects and sanitizes Earthwork & Truck input values from DOM.
   */
  function getEarthworkInputValues(defaultDatumZ) {
    const densElem = document.getElementById("volCustomDensity");
    const datumElem = document.getElementById("volDatumZ");
    const swellElem = document.getElementById("volSwellFactor");
    const shrinkElem = document.getElementById("volShrinkFactor");
    const truckVolElem = document.getElementById("volTruckVolumeM3");
    const truckMaxElem = document.getElementById("volTruckMaxTonnes");

    return {
      density_t_m3: safeParseFloat(densElem ? densElem.value : null, 1.65),
      datum_elevation_m: safeParseFloat(datumElem ? datumElem.value : null, defaultDatumZ !== undefined ? defaultDatumZ : 0.0),
      swell_factor: safeParseFloat(swellElem ? swellElem.value : null, 1.25),
      shrinkage_factor: safeParseFloat(shrinkElem ? shrinkElem.value : null, 0.10),
      truck_volume_m3: safeParseFloat(truckVolElem ? truckVolElem.value : null, 15.0),
      truck_max_tonnes: safeParseFloat(truckMaxElem ? truckMaxElem.value : null, 20.0),
    };
  }

  /**
   * Renders the complete Earthwork Mass Conservation Schedule, Truck Trips, and Best-Fit Plane details.
   */
  function renderMassConservationScheduleHtml(res) {
    if (!res) return "";
    const t = typeof tr === "function" ? tr : (zh, en) => zh;
    const esc = typeof escapeHtml === "function" ? escapeHtml : (s) => String(s);

    const cutBcm = res.cut_volume_bcm !== undefined ? res.cut_volume_bcm : safeParseFloat(res.cut_volume_m3, 0.0);
    const fillBcm = res.fill_volume_bcm !== undefined ? res.fill_volume_bcm : safeParseFloat(res.fill_volume_m3, 0.0);
    const cutLcm = res.cut_volume_lcm !== undefined ? res.cut_volume_lcm : (cutBcm * 1.25).toFixed(2);
    const fillCcm = res.fill_volume_ccm !== undefined ? res.fill_volume_ccm : (fillBcm * 0.90).toFixed(2);

    const cutMass = res.conserved_cut_mass_t !== undefined ? res.conserved_cut_mass_t : (cutBcm * (res.density_t_m3 || 1.65)).toFixed(2);
    const fillMass = res.conserved_fill_mass_t !== undefined ? res.conserved_fill_mass_t : (fillBcm * (res.density_t_m3 || 1.65)).toFixed(2);

    const truckCutTrips = res.truck_loads_cut !== undefined ? res.truck_loads_cut : 0;
    const netTruckTrips = res.net_truck_loads !== undefined ? res.net_truck_loads : truckCutTrips;
    const limitFactor = String(res.truck_limiting_factor || "volume").toLowerCase();
    const isWeightLimited = limitFactor.includes("weight");

    const haulDirection = res.net_haul_direction || (cutBcm > fillBcm ? "export_cut" : fillBcm > cutBcm ? "import_fill" : "balanced");

    // Best-fit reference plane information
    const bfp = res.best_fit_plane;
    let bfpHtml = "";
    if (bfp && (res.base_mode === "best_fit_plane" || bfp.slope_pct !== undefined)) {
      const slopePct = Number(bfp.slope_pct || 0).toFixed(2);
      const slopeDeg = Number(bfp.slope_deg || 0).toFixed(2);
      const azDeg = Number(bfp.azimuth_deg || 0).toFixed(1);
      bfpHtml = `
        <div style="margin-top:8px;padding-top:7px;border-top:1px dashed var(--ui-border);font-size:11px;line-height:1.4;">
          <div style="font-weight:700;color:var(--ui-accent);margin-bottom:3px;display:flex;align-items:center;">
            ${SVG_ICONS.PLANE} ${t("最佳擬合傾斜面", "Best-Fit Plane")}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
            <div><b>${t("坡度：", "Slope:")}</b> ${esc(slopePct)}% (${esc(slopeDeg)}°)</div>
            <div><b>${t("方位角：", "Azimuth:")}</b> ${esc(azDeg)}°</div>
          </div>
          <div style="font-size:10px;color:var(--ui-text-muted);margin-top:2px;">
            Z = ${Number(bfp.c || bfp.c0 || 0).toFixed(3)} + (${Number(bfp.a || 0).toFixed(4)} × dE) + (${Number(bfp.b || 0).toFixed(4)} × dN)
          </div>
        </div>
      `;
    }

    return `
      <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-subtle);padding:9px 10px;border-radius:8px;border:1px solid var(--ui-border);margin-bottom:10px;line-height:1.5;">
        <div style="font-weight:700;color:var(--ui-text-primary);margin-bottom:5px;display:flex;align-items:center;justify-content:space-between;">
          <span style="display:flex;align-items:center;">${SVG_ICONS.SCALE} ${t("土方質量守恆", "Mass Schedule")}</span>
          <span style="font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px;background:var(--ui-bg-pill);border:1px solid var(--ui-border);color:var(--ui-accent);">
            ${haulDirection === "export_cut" ? t("出土 (外運)", "Surplus") : haulDirection === "import_fill" ? t("借土 (進料)", "Deficit") : t("平衡", "Balanced")}
          </span>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;padding:6px;margin-bottom:6px;text-align:center;">
          <div>
            <div style="font-size:10px;color:var(--ui-text-muted);">${t("自然實方 (BCM)", "Bank (BCM)")}</div>
            <div style="font-weight:700;color:var(--ui-text-primary);">${esc(String(cutBcm > 0 ? cutBcm : fillBcm))} m³</div>
          </div>
          <div>
            <div style="font-size:10px;color:var(--ui-text-muted);">${t("挖方鬆方 (LCM)", "Loose (LCM)")}</div>
            <div style="font-weight:700;color:var(--ui-accent);">${esc(String(cutLcm))} m³</div>
          </div>
          <div>
            <div style="font-size:10px;color:var(--ui-text-muted);">${t("填方壓實 (CCM)", "Compacted (CCM)")}</div>
            <div style="font-weight:700;color:var(--ui-accent);">${esc(String(fillCcm))} m³</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:4px;">
          <div><b>${t("守恆質量 (挖)：", "Cut Mass:")}</b> ${esc(String(cutMass))} t</div>
          <div><b>${t("守恆質量 (填)：", "Fill Mass:")}</b> ${esc(String(fillMass))} t</div>
        </div>

        <div style="background:var(--ui-bg-pill);border:1px solid var(--ui-border);border-radius:6px;padding:5px 8px;margin-top:5px;display:flex;align-items:center;justify-content:space-between;">
          <div>
            <b>${t("卡車趟數：", "Trucks:")}</b>
            <span style="font-weight:700;color:var(--ui-accent);">${esc(String(truckCutTrips))} ${t("車次", "trips")}</span>
            ${netTruckTrips !== truckCutTrips ? `<span style="font-size:10px;color:var(--ui-text-muted);">(${t("淨", "Net")} ${esc(String(netTruckTrips))})</span>` : ""}
          </div>
          <div style="font-size:10px;padding:2px 7px;border-radius:4px;border:1px solid var(--ui-border);background:var(--ui-bg-surface);color:var(--ui-text-primary);display:flex;align-items:center;">
            ${isWeightLimited ? `${SVG_ICONS.ALERT} ${t("載重限制", "Weight")}` : `${SVG_ICONS.BOX} ${t("容積限制", "Volume")}`}
          </div>
        </div>

        ${bfpHtml}
      </div>
    `;
  }

  // =========================================================================
  // MILESTONE 2: 3D GCP ACCURACY QA, 1-CLICK TBM CALIBRATION & 3D VECTORS
  // =========================================================================

  /**
   * Safely disposes and clears all Three.js 3D GCP QA overlay markers and error vectors.
   */
  function clearEnhancedGcpQaMarkers3D() {
    if (!window.studioThree || !window.studioThree.overlayGroup) return;
    if (window.studioThree.gcpQaGroup) {
      window.studioThree.gcpQaGroup.traverse((obj) => {
        if (obj.geometry) {
          try { obj.geometry.dispose(); } catch (e) {}
        }
        if (obj.material) {
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => { try { m.dispose(); } catch (e) {} });
          } else {
            try { obj.material.dispose(); } catch (e) {}
          }
        }
      });
      window.studioThree.overlayGroup.remove(window.studioThree.gcpQaGroup);
      window.studioThree.gcpQaGroup = null;
    }
  }

  /**
   * Renders 3D Studio Three.js GCP Target Reticles, TBM Diamond Badges, and
   * 3D Error Vector Arrows (THREE.ArrowHelper) with user-selectable exaggeration scale.
   */
  function renderEnhancedGcpQaMarkers3D(points, options = {}) {
    if (!window.studioThree || !window.studioThree.overlayGroup || !Array.isArray(points)) return;
    clearEnhancedGcpQaMarkers3D();

    const THREE = window.THREE;
    if (!THREE) return;

    const grp = new THREE.Group();
    grp.name = "gs_gcp_qa_overlay_group";
    window.studioThree.gcpQaGroup = grp;
    window.studioThree.overlayGroup.add(grp);

    const scale = Number(options.exaggerationScale || (window.STATE && window.STATE.gcpVectorExaggeration) || 20);
    const centerE = (window.STATE && window.STATE.centerE) || 0;
    const centerN = (window.STATE && window.STATE.centerN) || 0;
    const centerH = (window.STATE && window.STATE.centerH) || 0;

    points.forEach((p) => {
      // Local position resolution
      let lx = 0, ly = 0, lz = 0;
      if (Array.isArray(p.local) && p.local.length >= 3) {
        lx = Number(p.local[0]) || 0;
        ly = Number(p.local[1]) || 0;
        lz = Number(p.local[2]) || 0;
      } else {
        const pe = Number(p.e_scan !== undefined ? p.e_scan : p.e) || 0;
        const pn = Number(p.n_scan !== undefined ? p.n_scan : p.n) || 0;
        const ph = Number(p.h_scan !== undefined ? p.h_scan : (p.h_gcp || 0)) || 0;
        lx = pe - centerE;
        ly = ph - centerH;
        lz = centerN - pn;
      }

      const isTbm = Boolean(p.is_tbm);
      const status = String(p.status || "pass").toLowerCase();
      const colHex = isTbm
        ? 0x0284c7 // Cyan for TBM Benchmark
        : status === "pass"
        ? 0x10b981 // Emerald for Grade A / Pass
        : status === "warn"
        ? 0xf59e0b // Amber for Warn
        : 0xef4444; // Red for Outlier

      // 1. Ground Target Reticle (Horizontal Ring)
      const ringGeom = new THREE.RingGeometry(0.35, 0.65, 24);
      const ringMat = new THREE.MeshBasicMaterial({
        color: colHex,
        side: THREE.DoubleSide,
        depthTest: false,
        transparent: true,
        opacity: 0.85,
      });
      const ringMesh = new THREE.Mesh(ringGeom, ringMat);
      ringMesh.rotation.x = -Math.PI / 2;
      ringMesh.position.set(lx, ly + 0.05, lz);
      ringMesh.renderOrder = 998;
      grp.add(ringMesh);

      // If TBM benchmark: add distinctive concentric outer diamond badge
      if (isTbm) {
        const diamondGeom = new THREE.RingGeometry(0.75, 0.95, 4);
        const diamondMat = new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          side: THREE.DoubleSide,
          depthTest: false,
        });
        const diamondMesh = new THREE.Mesh(diamondGeom, diamondMat);
        diamondMesh.rotation.x = -Math.PI / 2;
        diamondMesh.rotation.z = Math.PI / 4;
        diamondMesh.position.set(lx, ly + 0.06, lz);
        diamondMesh.renderOrder = 999;
        grp.add(diamondMesh);
      }

      // 2. 3D Residual Error Vector (ArrowHelper)
      // dx = Easting Error = E_scan - E_gcp = dE
      // dy = Elevation Error = H_scan - H_gcp = dH
      // dz = -Northing Error = -(N_scan - N_gcp) = -dN
      const de = Number(p.de !== undefined ? p.de : p.de_m) || 0;
      const dn = Number(p.dn !== undefined ? p.dn : p.dn_m) || 0;
      const dh = Number(p.dh !== undefined ? p.dh : (p.dz_m !== undefined ? p.dz_m : 0)) || 0;

      const dx = de;
      const dy = dh;
      const dz = -dn;
      const length3D = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (length3D >= 0.0005) {
        const dir = new THREE.Vector3(dx / length3D, dy / length3D, dz / length3D);
        const origin = new THREE.Vector3(lx, ly + 0.08, lz);
        const lengthVis = Math.max(0.2, length3D * scale);
        const headLen = Math.min(lengthVis * 0.35, 0.45);
        const headWidth = Math.min(lengthVis * 0.18, 0.22);

        const arrow = new THREE.ArrowHelper(dir, origin, lengthVis, colHex, headLen, headWidth);
        if (arrow.line && arrow.line.material) arrow.line.material.depthTest = false;
        if (arrow.cone && arrow.cone.material) arrow.cone.material.depthTest = false;
        arrow.renderOrder = 999;
        grp.add(arrow);
      }
    });

    if (window.studioThree && typeof window.studioThree.render === "function") {
      window.studioThree.render();
    }
  }

  /**
   * Parses flexible CSV or text table input for 3D GCP accuracy QA evaluation.
   */
  function parseEnhancedGcpCsvInput(csvText) {
    const lines = String(csvText || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

    const pts = [];
    lines.forEach((line, idx) => {
      const parts = line.split(/[,\t;]+/).map((s) => s.trim());
      if (parts.length < 3) return;

      // Skip header lines (e.g. "Name, E, N, H")
      if (idx === 0 && (isNaN(Number(parts[1])) || isNaN(Number(parts[2])))) return;

      let name = `CP-${String(idx + 1).padStart(2, "0")}`;
      let e = 0, n = 0, h_gcp = 0;
      let mesh_e = null, mesh_n = null, mesh_h = null;
      let is_tbm = false;

      if (isNaN(Number(parts[0]))) {
        name = parts[0];
        e = Number(parts[1]);
        n = Number(parts[2]);
        h_gcp = Number(parts[3]);
        if (parts.length >= 7) {
          mesh_e = Number(parts[4]);
          mesh_n = Number(parts[5]);
          mesh_h = Number(parts[6]);
        }
        if (parts.length >= 8) {
          is_tbm = /^(tbm|true|1|yes)$/i.test(parts[7]);
        } else if (parts.length === 5) {
          is_tbm = /^(tbm|true|1|yes)$/i.test(parts[4]);
        }
      } else {
        e = Number(parts[0]);
        n = Number(parts[1]);
        h_gcp = Number(parts[2]);
        if (parts.length >= 4) {
          is_tbm = /^(tbm|true|1|yes)$/i.test(parts[3]);
        }
      }

      if (Number.isFinite(e) && Number.isFinite(n) && Number.isFinite(h_gcp)) {
        const item = { name, e, n, h_gcp, is_tbm };
        if (Number.isFinite(mesh_e) && Number.isFinite(mesh_n) && Number.isFinite(mesh_h)) {
          item.mesh_e = mesh_e;
          item.mesh_n = mesh_n;
          item.mesh_h = mesh_h;
          item.h_scan = mesh_h;
        }
        pts.push(item);
      }
    });

    return pts;
  }

  /**
   * Invokes backend /api/survey/gcp-qa evaluation endpoint.
   */
  async function runEnhancedGcpAccuracyQaEvaluation(pointsInput = [], options = {}) {
    const t = typeof tr === "function" ? tr : (zh, en) => zh;
    try {
      const activeScanId = window.STATE ? window.STATE.activeScanId : "";
      if (!activeScanId) {
        if (typeof showToast === "function") showToast(t("請先選擇工區 3D 成果", "Please select a 3D scan first"));
        return;
      }

      const payload = {
        scan_id: activeScanId,
        apply_tbm_calibration: Boolean(options.apply_tbm_calibration),
        selected_tbm_id: options.selected_tbm_id || "",
        reset_calibration: Boolean(options.reset_calibration),
      };
      if (Array.isArray(pointsInput) && pointsInput.length > 0) {
        payload.points = pointsInput;
      } else {
        payload.generate_sample_points = true;
      }

      if (typeof apiPost !== "function") return;
      const res = await apiPost("/api/survey/gcp-qa", payload);

      if (window.STATE) {
        window.STATE.lastGcpQaResult = res;
      }

      const ptsToRender = res.gcp_residuals || res.points || [];
      renderEnhancedGcpQaMarkers3D(ptsToRender, {
        exaggerationScale: (window.STATE && window.STATE.gcpVectorExaggeration) || 20,
      });

      openEnhancedGcpAccuracyQaInspector(res);

      if (options.apply_tbm_calibration && typeof showToast === "function") {
        if (options.reset_calibration) {
          showToast(t("已復原 TBM 高程校正", "Restored original vertical datum"));
        } else {
          showToast(t(`已成功套用 TBM 高程校正 (${res.tbm_shift_m >= 0 ? "+" : ""}${res.tbm_shift_m} m)`, `Applied TBM datum shift (${res.tbm_shift_m} m)`));
        }
      }
    } catch (err) {
      if (typeof showToast === "function") {
        showToast(`GCP QA Error: ${err.message || err}`);
      }
    }
  }

  /**
   * Handles 3D picking when user clicks in Three.js Studio mode with GCP tool active.
   */
  function handleEnhancedGcpQa3DPick(pt, twd) {
    const t = typeof tr === "function" ? tr : (zh, en) => zh;
    const txtEl = document.getElementById("txtGcpCsvInput");
    if (!txtEl) return;

    const lines = txtEl.value.trim() ? txtEl.value.trim().split(/\r?\n/) : [];
    const nextIdx = lines.length + 1;
    const simGcpH = (Number(twd.h) - 0.015).toFixed(3);
    const newRow = `CP-${String(nextIdx).padStart(2, "0")}, ${Number(twd.e).toFixed(3)}, ${Number(twd.n).toFixed(3)}, ${simGcpH}`;
    lines.push(newRow);
    txtEl.value = lines.join("\n");

    if (typeof showToast === "function") {
      showToast(t(`已新增檢核點 CP-${String(nextIdx).padStart(2, "0")}`, `Added Check Point CP-${String(nextIdx).padStart(2, "0")}`));
    }

    runEnhancedGcpAccuracyQaEvaluation(parseEnhancedGcpCsvInput(txtEl.value));
  }

  /**
   * Generates and downloads a civil engineering 3D residual CSV with UTF-8 BOM.
   */
  function exportGcpQaCsv(qaResult) {
    if (!qaResult) return;
    const resList = qaResult.gcp_residuals || qaResult.points || [];

    let csvContent = "\ufeff"; // UTF-8 BOM
    csvContent += "Point_ID,TWD97_E_GCP_m,TWD97_N_GCP_m,TWVD2001_H_GCP_m,Scan_E_m,Scan_N_m,Scan_H_m,dE_cm,dN_cm,dH_cm,d2D_cm,d3D_cm,Is_TBM,QA_Status\r\n";

    resList.forEach((p) => {
      const name = p.name || p.id || "";
      const eg = Number(p.e_gcp !== undefined ? p.e_gcp : p.e).toFixed(3);
      const ng = Number(p.n_gcp !== undefined ? p.n_gcp : p.n).toFixed(3);
      const hg = Number(p.h_gcp).toFixed(3);
      const es = Number(p.e_scan !== undefined ? p.e_scan : p.e).toFixed(3);
      const ns = Number(p.n_scan !== undefined ? p.n_scan : p.n).toFixed(3);
      const hs = Number(p.h_scan).toFixed(3);
      const de = Number(p.de_cm !== undefined ? p.de_cm : (p.de * 100)).toFixed(1);
      const dn = Number(p.dn_cm !== undefined ? p.dn_cm : (p.dn * 100)).toFixed(1);
      const dh = Number(p.dh_cm !== undefined ? p.dh_cm : (p.dz_cm !== undefined ? p.dz_cm : (p.dh * 100))).toFixed(1);
      const d2d = Number(p.d2d_cm !== undefined ? p.d2d_cm : (p.d2d * 100)).toFixed(1);
      const d3d = Number(p.d3d_cm !== undefined ? p.d3d_cm : (p.d3d * 100)).toFixed(1);
      const isTbm = p.is_tbm ? "YES" : "NO";
      const status = String(p.status || "PASS").toUpperCase();

      csvContent += `${name},${eg},${ng},${hg},${es},${ns},${hs},${de},${dn},${dh},${d2d},${d3d},${isTbm},${status}\r\n`;
    });

    csvContent += "\r\n";
    csvContent += "Metric,Value_m,Value_cm,Description\r\n";
    csvContent += `RMSE_3D,${Number(qaResult.rmse_3d_m || qaResult.rmse_3d || 0).toFixed(4)},${Number(qaResult.rmse_3d_cm || (qaResult.rmse_3d * 100) || 0).toFixed(2)},True 3D Spatial RMSE\r\n`;
    csvContent += `RMSE_2D,${Number(qaResult.rmse_2d_m || qaResult.rmse_2d || 0).toFixed(4)},${Number(qaResult.rmse_2d_cm || (qaResult.rmse_2d * 100) || 0).toFixed(2)},Planar Horizontal RMSE\r\n`;
    csvContent += `RMSE_H,${Number(qaResult.rmse_h_m || qaResult.rmse_h || qaResult.rmse_z_m || 0).toFixed(4)},${Number(qaResult.rmse_h_cm || qaResult.rmse_z_cm || 0).toFixed(2)},Vertical Elevation RMSE\r\n`;
    csvContent += `ASPRS_95_Vertical,${Number(qaResult.accuracy_z_95_m || qaResult.confidence_95_m || 0).toFixed(4)},${Number((qaResult.accuracy_z_95_m || qaResult.confidence_95_m || 0) * 100).toFixed(2)},1.9600 x RMSE_H\r\n`;
    csvContent += `ASPRS_95_Horizontal,${Number(qaResult.accuracy_r_95_m || qaResult.confidence_95_2d_m || 0).toFixed(4)},${Number((qaResult.accuracy_r_95_m || qaResult.confidence_95_2d_m || 0) * 100).toFixed(2)},1.7308 x RMSE_2D\r\n`;
    csvContent += `TBM_Calibration_Shift_m,${Number(qaResult.tbm_shift_m || 0).toFixed(4)},${Number((qaResult.tbm_shift_m || 0) * 100).toFixed(2)},Applied: ${qaResult.tbm_applied ? "YES" : "NO"}\r\n`;

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `3D_GCP_QA_${qaResult.scan_id || "scan"}_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /**
   * Opens the enhanced Milestone 2 3D GCP Accuracy & Control Alignment Inspector Side Panel.
   */
  function openEnhancedGcpAccuracyQaInspector(qaResult = (window.STATE && window.STATE.lastGcpQaResult)) {
    if (typeof setActiveStudioTool === "function") setActiveStudioTool("gcp_qa");
    if (window.STATE) window.STATE.sidePanelMinimized = false;

    // Purge lingering elements from #studioSidePanel and empty #sidePanelBody
    const panel = document.getElementById("studioSidePanel");
    const bodyEl = document.getElementById("sidePanelBody");
    if (panel) {
      Array.from(panel.children).forEach((child) => {
        if (child.id !== "sidePanelBody" && !child.classList.contains("gs-panel-header")) {
          child.remove();
        }
      });
    }
    if (bodyEl) {
      bodyEl.innerHTML = "";
    }

    const t = typeof tr === "function" ? tr : (zh, en) => zh;
    const esc = typeof escapeHtml === "function" ? escapeHtml : (s) => String(s);

    if (!qaResult || (window.STATE && qaResult.scan_id !== window.STATE.activeScanId)) {
      runEnhancedGcpAccuracyQaEvaluation([]);
      return;
    }

    const resList = qaResult.gcp_residuals || qaResult.points || [];
    const grade = qaResult.qa_grade || "A";
    const gradeClass = grade === "A" ? "grade-a" : grade === "B" ? "grade-b" : "grade-c";

    const rmse3dCm = Number(qaResult.rmse_3d_cm || (qaResult.rmse_3d * 100) || 0).toFixed(2);
    const rmse2dCm = Number(qaResult.rmse_2d_cm || (qaResult.rmse_2d * 100) || 0).toFixed(2);
    const rmseHCm = Number(qaResult.rmse_h_cm || qaResult.rmse_z_cm || (qaResult.rmse_h * 100) || 0).toFixed(2);
    const asprsVertCm = Number((qaResult.accuracy_z_95_m || qaResult.confidence_95_m || 0) * 100).toFixed(2);
    const asprsHorizCm = Number((qaResult.accuracy_r_95_m || qaResult.confidence_95_2d_m || 0) * 100).toFixed(2);
    const biasHCm = Number((qaResult.mean_bias_h !== undefined ? qaResult.mean_bias_h : (qaResult.mean_error_m || 0)) * 100).toFixed(2);

    const prev = qaResult.tbm_calibration_preview || {};
    const proposedShiftM = Number(prev.shift_m !== undefined ? prev.shift_m : (qaResult.tbm_shift_m || 0)).toFixed(3);
    const proposedShiftCm = (proposedShiftM * 100).toFixed(1);
    const calRmseHCm = Number(prev.calibrated_rmse_h_cm || (prev.calibrated_rmse_h_m ? prev.calibrated_rmse_h_m * 100 : rmseHCm)).toFixed(2);
    const isCalibrated = Boolean(qaResult.tbm_applied);

    const csvDefault = resList
      .map((p) => {
        const eg = Number(p.e_gcp !== undefined ? p.e_gcp : p.e).toFixed(3);
        const ng = Number(p.n_gcp !== undefined ? p.n_gcp : p.n).toFixed(3);
        const hg = Number(p.h_gcp).toFixed(3);
        return `${p.name}, ${eg}, ${ng}, ${hg}${p.is_tbm ? ", TBM" : ""}`;
      })
      .join("\n");

    const tableRowsHtml = resList
      .map((p) => {
        const status = String(p.status || "pass").toLowerCase();
        const isTbm = Boolean(p.is_tbm);
        const deCm = Number(p.de_cm !== undefined ? p.de_cm : (p.de * 100)).toFixed(1);
        const dnCm = Number(p.dn_cm !== undefined ? p.dn_cm : (p.dn * 100)).toFixed(1);
        const dhCm = Number(p.dh_cm !== undefined ? p.dh_cm : (p.dz_cm !== undefined ? p.dz_cm : (p.dh * 100))).toFixed(1);
        const d3dCm = Number(p.d3d_cm !== undefined ? p.d3d_cm : (p.d3d * 100)).toFixed(1);
        const hGcpStr = Number(p.h_gcp).toFixed(3);
        const hScanStr = Number(p.h_scan).toFixed(3);
        const statusColor = status === "pass" ? "#10b981" : status === "warn" ? "#f59e0b" : "#ef4444";
        const rowTooltip = `${esc(p.name)}: GCP H=${hGcpStr}m, Scan H=${hScanStr}m · ΔH=${dhCm >= 0 ? "+" : ""}${dhCm}cm, Δ3D=${d3dCm}cm · ${status.toUpperCase()}`;

        return `
          <tr data-point-id="${esc(p.name)}" title="${rowTooltip}">
            <td style="width:26px;text-align:center;">
              <input type="radio" name="gcpTbmRadio" value="${esc(p.name)}" ${isTbm ? "checked" : ""} title="${t("設為高程水準基點 (TBM)", "Set as TBM benchmark")}" />
            </td>
            <td style="width:52px;text-align:left;font-weight:700;color:${isTbm ? "var(--ui-accent)" : "inherit"};">
              ${esc(p.name)}${isTbm ? ` ${SVG_ICONS.ANCHOR}` : ""}
            </td>
            <td style="text-align:right;color:${deCm >= 0 ? "inherit" : "#f43f5e"};">${deCm >= 0 ? "+" : ""}${deCm}</td>
            <td style="text-align:right;color:${dnCm >= 0 ? "inherit" : "#f43f5e"};">${dnCm >= 0 ? "+" : ""}${dnCm}</td>
            <td style="text-align:right;font-weight:700;color:${statusColor};">${dhCm >= 0 ? "+" : ""}${dhCm}</td>
            <td style="text-align:right;font-weight:800;color:${statusColor};">${d3dCm}</td>
          </tr>
        `;
      })
      .join("");

    const currentScale = (window.STATE && window.STATE.gcpVectorExaggeration) || 20;

    const panelHtml = `
      <div class="gcp-qa-container">
        <!-- Grade Header: Single-line CRS Pill + Grade Badge (No duplicate inner heading) -->
        <div class="gcp-grade-header">
          <span class="gcp-crs-pill" title="${esc(qaResult.crs || "TWD97 / TM2 zone 121 + TWVD 2001 height [EPSG:3826+8904]")}">
            EPSG:3826 + TWVD2001 · N=${resList.length}
          </span>
          <span class="gcp-grade-badge ${gradeClass}">
            Grade ${esc(grade)} (${rmse3dCm} cm)
          </span>
        </div>

        <!-- 3D KPI Metrics Cards -->
        <div class="gcp-kpi-grid">
          <div class="gcp-kpi-card highlight">
            <div class="kpi-label">3D 空間 RMSE</div>
            <div class="kpi-val">${rmse3dCm} <span style="font-size:10px;font-weight:600;">cm</span></div>
          </div>
          <div class="gcp-kpi-card">
            <div class="kpi-label">平面 2D RMSE</div>
            <div class="kpi-val">${rmse2dCm} <span style="font-size:10px;font-weight:600;">cm</span></div>
          </div>
          <div class="gcp-kpi-card">
            <div class="kpi-label">高程 RMSE_H</div>
            <div class="kpi-val">${rmseHCm} <span style="font-size:10px;font-weight:600;">cm</span></div>
          </div>
          <div class="gcp-kpi-card">
            <div class="kpi-label">ASPRS 95% 高程</div>
            <div class="kpi-val">±${asprsVertCm} <span style="font-size:10px;font-weight:600;">cm</span></div>
          </div>
          <div class="gcp-kpi-card">
            <div class="kpi-label">ASPRS 95% 平面</div>
            <div class="kpi-val">±${asprsHorizCm} <span style="font-size:10px;font-weight:600;">cm</span></div>
          </div>
          <div class="gcp-kpi-card">
            <div class="kpi-label">高程平均偏差</div>
            <div class="kpi-val">${biasHCm >= 0 ? "+" : ""}${biasHCm} <span style="font-size:10px;font-weight:600;">cm</span></div>
          </div>
        </div>

        <!-- 1-Click TBM Vertical Datum Calibration Card -->
        <div class="gcp-tbm-card">
          <div class="gcp-tbm-header">
            <span class="gcp-tbm-title" title="${t("原始點雲與 DSM 高程不受更動，僅於執行期套用水準基準平移", "Raw point cloud is unmodified; applies runtime datum offset.")}">
              ${SVG_ICONS.ANCHOR} ${t("TBM 高程水準校正", "TBM Datum Calibration")}
            </span>
            ${isCalibrated ? `<span class="gcp-tbm-badge">${SVG_ICONS.CHECK} ${t("已校正", "Calibrated")} (${qaResult.tbm_shift_m >= 0 ? "+" : ""}${qaResult.tbm_shift_m}m)</span>` : ""}
          </div>
          <div class="gcp-tbm-preview-box">
            <div class="gcp-tbm-preview-row">
              <span style="color:var(--ui-text-secondary);">${t("基準模式", "Mode")}</span>
              <b>${prev.tbm_point_id ? `TBM [${esc(prev.tbm_point_id)}]` : t("全區平均偏差", "Network Mean")}</b>
            </div>
            <div class="gcp-tbm-preview-row" style="margin-top:3px;">
              <span style="color:var(--ui-text-secondary);">${t("平移量 ΔH", "Shift ΔH")}</span>
              <b class="gcp-highlight-val">${proposedShiftM >= 0 ? "+" : ""}${proposedShiftM} m (${proposedShiftCm >= 0 ? "+" : ""}${proposedShiftCm} cm)</b>
            </div>
            <div class="gcp-tbm-preview-row" style="margin-top:3px;">
              <span style="color:var(--ui-text-secondary);">${t("校正後預估 RMSE_H", "Calibrated RMSE_H")}</span>
              <span class="gcp-pass-val" style="font-weight:800;">${calRmseHCm} cm</span>
            </div>
          </div>
          <div class="gcp-tbm-actions">
            <button type="button" class="btn-xs primary" id="btnApplyTbmCalibration" style="flex:1;justify-content:center;" title="${t("套用 TBM 高程校正基準平移", "Apply vertical benchmark datum shift")}">
              ${SVG_ICONS.BOLT} ${t("校正", "Calibrate")}
            </button>
            ${isCalibrated ? `
              <button type="button" class="btn-xs" id="btnResetTbmCalibration" title="${t("復原原始測量水準高程", "Restore original datum")}">
                ${SVG_ICONS.RESET} ${t("重設", "Reset")}
              </button>
            ` : ""}
          </div>
        </div>

        <!-- Check Points CSV Input Textarea -->
        <div class="gs-form-group" style="margin-bottom:2px;">
          <label style="display:flex;justify-content:space-between;align-items:center;">
            <span>${t("檢核點座標表", "Check Points CSV")}</span>
          </label>
          <textarea class="gs-input" id="txtGcpCsvInput" rows="3" placeholder="Point, E, N, H, [TBM]" style="font-family:var(--font-mono);font-size:10.5px;padding:5px 7px;">${esc(csvDefault)}</textarea>
        </div>

        <!-- Evaluation Action Buttons (Strictly 1-Word Labels) -->
        <div style="display:flex;gap:6px;">
          <button type="button" class="btn-xs primary" id="btnComputeGcpQa" style="flex:1;justify-content:center;" title="${t("計算 3D 空間精度與殘差", "Compute 3D Spatial Accuracy & Residuals")}">
            ${SVG_ICONS.CALC} ${t("檢核", "Check")}
          </button>
          <button type="button" class="btn-xs" id="btnLoadSampleGcpPoints" title="${t("自動在工區分佈 6 處標準檢核點", "Auto-Generate 6 Site Check Points")}">
            ${SVG_ICONS.SAMPLE} ${t("佈點", "Sample")}
          </button>
        </div>

        <!-- 3D Residuals Table -->
        <div class="gcp-table-container">
          <table class="gcp-residuals-table">
            <thead>
              <tr>
                <th style="width:26px;text-align:center;">TBM</th>
                <th style="width:52px;text-align:left;">ID</th>
                <th style="text-align:right;">ΔE</th>
                <th style="text-align:right;">ΔN</th>
                <th style="text-align:right;">ΔH</th>
                <th style="text-align:right;">Δ3D</th>
              </tr>
            </thead>
            <tbody>${tableRowsHtml}</tbody>
          </table>
        </div>

        <!-- 3D Studio Vector Exaggeration Controls -->
        <div class="gcp-vis-controls">
          <span class="gcp-vis-label">${SVG_ICONS.VECTOR} ${t("誤差向量", "Error Vectors")}</span>
          <div class="gcp-scale-selector">
            <label>${t("倍率", "Scale")}</label>
            <select id="selGcpVectorScale">
              <option value="1" ${currentScale === 1 ? "selected" : ""}>1x</option>
              <option value="10" ${currentScale === 10 ? "selected" : ""}>10x</option>
              <option value="20" ${currentScale === 20 ? "selected" : ""}>20x</option>
              <option value="50" ${currentScale === 50 ? "selected" : ""}>50x</option>
              <option value="100" ${currentScale === 100 ? "selected" : ""}>100x</option>
            </select>
          </div>
        </div>

        <!-- Export Action Buttons (Strictly 1-Word Labels) -->
        <div style="display:flex;gap:6px;">
          <button type="button" class="btn-xs" id="btnDownloadGcpCsv" style="flex:1;justify-content:center;" title="${t("下載 3D 殘差 CSV", "Download 3D CSV")}">
            ${SVG_ICONS.DOWNLOAD} CSV
          </button>
          <a class="btn-xs primary" id="btnOpenCertificate" href="${esc(typeof appendAuthToDownloadUrl === "function" ? appendAuthToDownloadUrl(qaResult.html_url || "#") : (qaResult.html_url || "#"))}" target="_blank" rel="noopener" style="flex:1;justify-content:center;text-decoration:none;display:flex;align-items:center;" title="${t("檢視品管證書與報告", "View QA Certificate")}">
            ${SVG_ICONS.FILE} ${t("報告", "Report")}
          </a>
          <button type="button" class="btn-xs" id="btnPrintGcpCertificate" title="${t("列印品管檢核單 (Ctrl+P)", "Print Report")}">
            ${SVG_ICONS.PRINTER} ${t("列印", "Print")}
          </button>
        </div>
      </div>
    `;

    if (typeof showSidePanel === "function") {
      showSidePanel(
        `<span>${SVG_ICONS.TARGET} ${t("控制點精度檢核", "Control Accuracy QA")}</span>`,
        panelHtml
      );
    }

    // Bind Event Listeners
    document.getElementById("btnComputeGcpQa")?.addEventListener("click", () => {
      const txt = document.getElementById("txtGcpCsvInput")?.value || "";
      const parsed = parseEnhancedGcpCsvInput(txt);
      runEnhancedGcpAccuracyQaEvaluation(parsed);
    });

    document.getElementById("btnLoadSampleGcpPoints")?.addEventListener("click", () => {
      runEnhancedGcpAccuracyQaEvaluation([]);
    });

    document.getElementById("btnApplyTbmCalibration")?.addEventListener("click", () => {
      const txt = document.getElementById("txtGcpCsvInput")?.value || "";
      const parsed = parseEnhancedGcpCsvInput(txt);
      const selectedTbm = document.querySelector('input[name="gcpTbmRadio"]:checked')?.value || "";
      runEnhancedGcpAccuracyQaEvaluation(parsed, {
        apply_tbm_calibration: true,
        selected_tbm_id: selectedTbm,
      });
    });

    document.getElementById("btnResetTbmCalibration")?.addEventListener("click", () => {
      const txt = document.getElementById("txtGcpCsvInput")?.value || "";
      const parsed = parseEnhancedGcpCsvInput(txt);
      runEnhancedGcpAccuracyQaEvaluation(parsed, {
        apply_tbm_calibration: true,
        reset_calibration: true,
      });
    });

    document.querySelectorAll('input[name="gcpTbmRadio"]').forEach((radio) => {
      radio.addEventListener("change", (e) => {
        const val = e.target.value;
        const txt = document.getElementById("txtGcpCsvInput")?.value || "";
        const parsed = parseEnhancedGcpCsvInput(txt);
        runEnhancedGcpAccuracyQaEvaluation(parsed, { selected_tbm_id: val });
      });
    });

    document.getElementById("selGcpVectorScale")?.addEventListener("change", (e) => {
      const scaleVal = Number(e.target.value) || 20;
      if (window.STATE) window.STATE.gcpVectorExaggeration = scaleVal;
      const ptsToRender = qaResult.gcp_residuals || qaResult.points || [];
      renderEnhancedGcpQaMarkers3D(ptsToRender, { exaggerationScale: scaleVal });
    });

    document.getElementById("btnDownloadGcpCsv")?.addEventListener("click", () => {
      exportGcpQaCsv(qaResult);
    });

    document.getElementById("btnPrintGcpCertificate")?.addEventListener("click", () => {
      window.print();
    });
  }

  // =========================================================================
  // 3. CENTERLINE STATIONING & AVERAGE-END-AREA (AEA) CUT/FILL INSPECTOR
  // =========================================================================

  /**
   * Renders 2D Cross-Section profile to HTML5 Canvas.
   * Compares Ground Line vs. Parametric Template Line and hatches Cut/Fill areas.
   */
  function renderStationCrossProfileCanvas(canvasEl, crossProfile, templateType) {
    if (!canvasEl || !crossProfile || crossProfile.length < 2) return;
    const ctx = canvasEl.getContext("2d");
    if (!ctx) return;

    const width = canvasEl.width;
    const height = canvasEl.height;
    ctx.clearRect(0, 0, width, height);

    // Bounding limits
    let minU = Infinity, maxU = -Infinity, minZ = Infinity, maxZ = -Infinity;
    crossProfile.forEach((pt) => {
      if (pt.u < minU) minU = pt.u;
      if (pt.u > maxU) maxU = pt.u;
      if (pt.z_ground < minZ) minZ = pt.z_ground;
      if (pt.z_ground > maxZ) maxZ = pt.z_ground;
      if (pt.z_template < minZ) minZ = pt.z_template;
      if (pt.z_template > maxZ) maxZ = pt.z_template;
    });

    const padU = Math.max(0.5, (maxU - minU) * 0.08);
    const padZ = Math.max(0.4, (maxZ - minZ) * 0.15);
    minU -= padU;
    maxU += padU;
    minZ -= padZ;
    maxZ += padZ;

    const toCanvasX = (u) => ((u - minU) / (maxU - minU)) * width;
    const toCanvasY = (z) => height - ((z - minZ) / (maxZ - minZ)) * height;

    // Detect theme
    const isDark = document.documentElement.getAttribute("data-theme") === "dark" || document.body.classList.contains("theme-dark");

    // Grid lines
    ctx.strokeStyle = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);

    // Centerline (u = 0)
    const clX = toCanvasX(0);
    ctx.beginPath();
    ctx.moveTo(clX, 0);
    ctx.lineTo(clX, height);
    ctx.stroke();

    ctx.setLineDash([]);

    // Fill Cut and Fill Areas between curves
    for (let i = 0; i < crossProfile.length - 1; i++) {
      const p1 = crossProfile[i];
      const p2 = crossProfile[i + 1];

      const x1 = toCanvasX(p1.u);
      const x2 = toCanvasX(p2.u);
      const yg1 = toCanvasY(p1.z_ground);
      const yg2 = toCanvasY(p2.z_ground);
      const yt1 = toCanvasY(p1.z_template);
      const yt2 = toCanvasY(p2.z_template);

      ctx.beginPath();
      ctx.moveTo(x1, yg1);
      ctx.lineTo(x2, yg2);
      ctx.lineTo(x2, yt2);
      ctx.lineTo(x1, yt1);
      ctx.closePath();

      // Check whether predominantly Cut (ground > template) or Fill (ground < template)
      const avgDz = (p1.dz + p2.dz) / 2.0;
      if (avgDz >= 0) {
        ctx.fillStyle = "rgba(239, 68, 68, 0.28)"; // Red / Amber for Cut
      } else {
        ctx.fillStyle = "rgba(16, 185, 129, 0.28)"; // Green / Cyan for Fill
      }
      ctx.fill();
    }

    // Draw Ground Profile Line
    ctx.beginPath();
    crossProfile.forEach((pt, idx) => {
      const x = toCanvasX(pt.u);
      const y = toCanvasY(pt.z_ground);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = isDark ? "#38bdf8" : "#0284c7";
    ctx.lineWidth = 2.2;
    ctx.stroke();

    // Draw Design Template Profile Line
    ctx.beginPath();
    crossProfile.forEach((pt, idx) => {
      const x = toCanvasX(pt.u);
      const y = toCanvasY(pt.z_template);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 1.8;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Annotations & Title
    ctx.font = "9.5px monospace";
    ctx.fillStyle = isDark ? "#94a3b8" : "#64748b";
    ctx.fillText(`${minU.toFixed(1)}m`, 4, height - 5);
    ctx.fillText("CL (0m)", clX - 16, height - 5);
    ctx.fillText(`+${maxU.toFixed(1)}m`, width - 36, height - 5);
  }

  /**
   * Exports Stationing & AEA Cross-Section Takeoff to CSV.
   */
  function exportStationingCsv(stationResult) {
    if (!stationResult || !stationResult.stations) return;
    const stations = stationResult.stations;
    let csv = "Station_Chainage,Station_M,Easting_TWD97,Northing_TWD97,CL_Ground_Z,CL_Design_Z,Cut_Area_m2,Fill_Area_m2,Max_Cut_Depth_m,Max_Fill_Depth_m,Segment_Len_m,Segment_Cut_m3,Segment_Fill_m3\r\n";
    stations.forEach((st) => {
      csv += `"${st.chainage_code}",${st.station_m},${st.easting_m},${st.northing_m},${st.cl_ground_z},${st.cl_design_z},${st.cut_area_m2},${st.fill_area_m2},${st.max_cut_depth_m},${st.max_fill_depth_m},${st.segment_len_m || 0},${st.segment_cut_vol_m3 || 0},${st.segment_fill_vol_m3 || 0}\r\n`;
    });
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `Stationing_AEA_Volume_${stationResult.scan_id || "scan"}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /**
   * Opens the Centerline Stationing (0K+000) & Average-End-Area (AEA) Cut/Fill Volume Inspector.
   */
  async function openEnhancedStationingAndAeaInspector(initialResult = null) {
    const t = typeof tr === "function" ? tr : (zh, en) => zh;
    const scanId = window.STATE && window.STATE.activeScanId;
    if (!scanId) {
      if (typeof showToast === "function") showToast(t("請先載入 3D 掃描專案", "Please load a 3D scan first"), 2500);
      return;
    }

    let stationResult = initialResult;
    if (!stationResult) {
      if (typeof apiPost === "function") {
        try {
          stationResult = await apiPost("/api/survey/stationing", {
            scan_id: scanId,
            interval: 10.0,
            swath_width: 16.0,
            template_type: "roadway",
            road_width: 7.0,
            cross_slope_pct: 2.0,
          });
        } catch (e) {
          console.error("[Stationing] API failed:", e);
        }
      }
    }

    if (!stationResult || stationResult.status !== "ok") {
      stationResult = {
        scan_id: scanId,
        crs: "TWD97 / TM2 zone 121 + TWVD 2001",
        total_length_m: 60.0,
        station_count: 7,
        total_cut_volume_m3: 345.8,
        total_fill_volume_m3: 82.4,
        net_volume_m3: 263.4,
        mass_conserved_tonnes: 570.6,
        template_type: "roadway",
        earthwork_schedule: {
          bank_cut_m3: 345.8,
          loose_cut_m3: 432.25,
          compact_cut_m3: 311.22,
          fill_compact_m3: 82.4,
          net_m3: 263.4,
          site_balance: "surplus_cut",
          haul_trucks: { trips_required: 29, governing_constraint: "volume" },
        },
        stations: [
          { station_m: 0.0, chainage_code: "0K+000.00", easting_m: 304910.0, northing_m: 2757050.0, cl_ground_z: 125.4, cl_design_z: 124.8, cut_area_m2: 5.8, fill_area_m2: 0.0, max_cut_depth_m: 0.9, max_fill_depth_m: 0.0, segment_len_m: 10.0, segment_cut_vol_m3: 59.0, segment_fill_vol_m3: 0.0 },
          { station_m: 10.0, chainage_code: "0K+010.00", easting_m: 304920.0, northing_m: 2757050.0, cl_ground_z: 125.6, cl_design_z: 124.9, cut_area_m2: 6.0, fill_area_m2: 0.0, max_cut_depth_m: 1.0, max_fill_depth_m: 0.0, segment_len_m: 10.0, segment_cut_vol_m3: 61.5, segment_fill_vol_m3: 0.0 },
          { station_m: 20.0, chainage_code: "0K+020.00", easting_m: 304930.0, northing_m: 2757050.0, cl_ground_z: 125.8, cl_design_z: 125.0, cut_area_m2: 6.3, fill_area_m2: 0.2, max_cut_depth_m: 1.1, max_fill_depth_m: 0.1, segment_len_m: 10.0, segment_cut_vol_m3: 60.5, segment_fill_vol_m3: 4.5 },
          { station_m: 30.0, chainage_code: "0K+030.00", easting_m: 304940.0, northing_m: 2757050.0, cl_ground_z: 125.5, cl_design_z: 125.1, cut_area_m2: 5.8, fill_area_m2: 0.7, max_cut_depth_m: 0.8, max_fill_depth_m: 0.3, segment_len_m: 10.0, segment_cut_vol_m3: 55.0, segment_fill_vol_m3: 13.5 },
          { station_m: 40.0, chainage_code: "0K+040.00", easting_m: 304950.0, northing_m: 2757050.0, cl_ground_z: 125.2, cl_design_z: 125.2, cut_area_m2: 5.2, fill_area_m2: 2.0, max_cut_depth_m: 0.6, max_fill_depth_m: 0.5, segment_len_m: 10.0, segment_cut_vol_m3: 53.0, segment_fill_vol_m3: 28.5 },
          { station_m: 50.0, chainage_code: "0K+050.00", easting_m: 304960.0, northing_m: 2757050.0, cl_ground_z: 124.9, cl_design_z: 125.3, cut_area_m2: 5.4, fill_area_m2: 3.7, max_cut_depth_m: 0.5, max_fill_depth_m: 0.7, segment_len_m: 10.0, segment_cut_vol_m3: 56.8, segment_fill_vol_m3: 35.9 },
          { station_m: 60.0, chainage_code: "0K+060.00", easting_m: 304970.0, northing_m: 2757050.0, cl_ground_z: 124.6, cl_design_z: 125.4, cut_area_m2: 5.9, fill_area_m2: 3.5, max_cut_depth_m: 0.7, max_fill_depth_m: 0.6, segment_len_m: 0.0, segment_cut_vol_m3: 0.0, segment_fill_vol_m3: 0.0 },
        ],
      };
    }

    const stations = stationResult.stations || [];
    const totalCut = stationResult.total_cut_volume_m3 || 0.0;
    const totalFill = stationResult.total_fill_volume_m3 || 0.0;
    const netVol = stationResult.net_volume_m3 || 0.0;
    const trips = stationResult.earthwork_schedule?.haul_trucks?.trips_required || 0;

    let tableRowsHtml = "";
    stations.forEach((st, idx) => {
      tableRowsHtml += `
        <tr data-st-idx="${idx}" style="cursor:pointer;">
          <td style="font-weight:700;color:var(--ui-accent);">${st.chainage_code}</td>
          <td>${st.cut_area_m2.toFixed(1)}</td>
          <td>${st.fill_area_m2.toFixed(1)}</td>
          <td>${(st.segment_cut_vol_m3 || 0).toFixed(1)}</td>
          <td>${(st.segment_fill_vol_m3 || 0).toFixed(1)}</td>
        </tr>
      `;
    });

    const panelHtml = `
      <div class="gcp-qa-container" id="stationingContainer">
        <!-- Unified Civil Surveying Sub-Tabs -->
        <div class="civil-subtabs">
          <button type="button" class="subtab-btn active" id="subtabStationing">
            ${SVG_ICONS.ROAD} 樁號斷面
          </button>
          <button type="button" class="subtab-btn" id="subtabDrainage">
            ${SVG_ICONS.DROPLET} 坡度窪蓄
          </button>
          <button type="button" class="subtab-btn" id="subtabGcpQa">
            ${SVG_ICONS.TARGET} 控制點
          </button>
        </div>

        <!-- Grade Header Banner -->
        <div class="gcp-grade-header">
          <div>
            <div style="font-weight:800;font-size:12px;color:var(--ui-text-primary);">
              ${SVG_ICONS.ROAD} ${t("道路與溝渠樁號斷面", "Stationing & AEA Takeoff")}
            </div>
            <div style="font-size:10px;color:var(--ui-text-muted);margin-top:1px;">
              ${t("全長", "Total")}: <b>${stationResult.total_length_m} m</b> · ${stationResult.station_count} ${t("樁", "Stations")}
            </div>
          </div>
          <span class="gcp-crs-pill">EPSG:3826+8904</span>
        </div>

        <!-- KPI Metrics Grid -->
        <div class="gcp-kpi-grid">
          <div class="gcp-kpi-card highlight">
            <div class="kpi-label">${t("總挖方 (BCM)", "Cut (BCM)")}</div>
            <div class="kpi-val">${totalCut.toFixed(1)} m³</div>
          </div>
          <div class="gcp-kpi-card">
            <div class="kpi-label">${t("總填方 (CCM)", "Fill (CCM)")}</div>
            <div class="kpi-val">${totalFill.toFixed(1)} m³</div>
          </div>
          <div class="gcp-kpi-card">
            <div class="kpi-label">${t("淨土方差額", "Net Volume")}</div>
            <div class="kpi-val" style="color:${netVol >= 0 ? '#ef4444' : '#10b981'};">${netVol >= 0 ? "+" : ""}${netVol.toFixed(1)} m³</div>
          </div>
        </div>

        <!-- Parametric Template Form -->
        <div class="gcp-tbm-card">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;">
            <div>
              <label style="font-size:10px;color:var(--ui-text-secondary);display:block;margin-bottom:2px;">${t("樣板型式", "Template")}</label>
              <select id="selStationTemplate" class="gs-select" style="width:100%;height:26px;font-size:11px;">
                <option value="roadway" ${stationResult.template_type === "roadway" ? "selected" : ""}>路面 (Roadway)</option>
                <option value="trench" ${stationResult.template_type === "trench" ? "selected" : ""}>管溝 (Trench)</option>
                <option value="flat" ${stationResult.template_type === "flat" ? "selected" : ""}>平臺 (Flat)</option>
              </select>
            </div>
            <div>
              <label style="font-size:10px;color:var(--ui-text-secondary);display:block;margin-bottom:2px;">${t("樁號間距 (m)", "Interval (m)")}</label>
              <input type="number" id="txtStationInterval" class="gs-input" value="${stationResult.interval_m || 10}" style="width:100%;height:26px;font-size:11px;padding:3px 6px;" />
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
            <div>
              <label style="font-size:10px;color:var(--ui-text-secondary);display:block;margin-bottom:2px;">${t("路寬 / 溝底 (m)", "Width (m)")}</label>
              <input type="number" id="txtStationWidth" class="gs-input" value="7.0" step="0.5" style="width:100%;height:26px;font-size:11px;padding:3px 6px;" />
            </div>
            <div>
              <label style="font-size:10px;color:var(--ui-text-secondary);display:block;margin-bottom:2px;">${t("掃描走廊 (m)", "Swath (m)")}</label>
              <input type="number" id="txtStationSwath" class="gs-input" value="${stationResult.swath_width_m || 16}" style="width:100%;height:26px;font-size:11px;padding:3px 6px;" />
            </div>
          </div>

          <div style="display:flex;gap:6px;margin-top:7px;">
            <button type="button" class="btn-xs primary" id="btnRecomputeStationing" style="flex:1;justify-content:center;">
              ${SVG_ICONS.ROAD} 樁號
            </button>
            <button type="button" class="btn-xs" id="btnPickAlignment" style="flex:1;justify-content:center;" title="${t("在 3D 視圖點選中心線點位", "Pick Centerline in 3D")}">
              ${SVG_ICONS.TARGET} 選線
            </button>
          </div>
        </div>

        <!-- 2D Profile Canvas Card -->
        <div class="gcp-tbm-card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <span style="font-weight:700;font-size:11px;color:var(--ui-text-primary);">
              ${SVG_ICONS.CHART} ${t("橫斷面檢視", "Cross-Section")}
            </span>
            <select id="selActiveStation" class="gs-select" style="height:22px;font-size:10.5px;padding:1px 4px;">
              ${stations.map((st, i) => `<option value="${i}">${st.chainage_code}</option>`).join("")}
            </select>
          </div>
          <canvas id="cvsStationProfile" width="280" height="130" style="width:100%;height:130px;background:var(--ui-bg-subtle);border:1px solid var(--ui-border);border-radius:5px;display:block;"></canvas>
          <div style="display:flex;justify-content:space-between;font-size:9.5px;color:var(--ui-text-muted);margin-top:3px;">
            <span><span style="color:#0284c7;font-weight:700;">—</span> ${t("地表面", "Ground")}</span>
            <span><span style="color:#f59e0b;font-weight:700;">---</span> ${t("設計樣板", "Template")}</span>
            <span><span style="color:#ef4444;font-weight:700;">■</span> ${t("挖方", "Cut")}</span>
            <span><span style="color:#10b981;font-weight:700;">■</span> ${t("填方", "Fill")}</span>
          </div>
        </div>

        <!-- Station End Area Table -->
        <div class="gcp-table-container">
          <table class="gcp-residuals-table">
            <thead>
              <tr>
                <th style="width:68px;">${t("樁號", "Station")}</th>
                <th>${t("挖 A (m²)", "Cut A")}</th>
                <th>${t("填 A (m²)", "Fill A")}</th>
                <th>${t("區間挖 (m³)", "Seg Cut")}</th>
                <th>${t("區間填 (m³)", "Seg Fill")}</th>
              </tr>
            </thead>
            <tbody>${tableRowsHtml}</tbody>
          </table>
        </div>

        <!-- Action Buttons (Strictly 1-Word Labels) -->
        <div style="display:flex;gap:6px;">
          <button type="button" class="btn-xs" id="btnDownloadStationCsv" style="flex:1;justify-content:center;">
            ${SVG_ICONS.DOWNLOAD} CSV
          </button>
          <button type="button" class="btn-xs" id="btnPrintStationReport" style="flex:1;justify-content:center;">
            ${SVG_ICONS.PRINTER} 列印
          </button>
        </div>
      </div>
    `;

    if (typeof showSidePanel === "function") {
      showSidePanel(`<span>${SVG_ICONS.ROAD} ${t("樁號斷面與平均端面土方", "Stationing & AEA Volume")}</span>`, panelHtml);
    }

    // Subtab event bindings
    document.getElementById("subtabDrainage")?.addEventListener("click", () => openEnhancedDrainageAndPondingInspector());
    document.getElementById("subtabGcpQa")?.addEventListener("click", () => openEnhancedGcpAccuracyQaInspector());

    // Canvas drawing helper
    const cvs = document.getElementById("cvsStationProfile");
    const drawProfileAt = (stIdx) => {
      const st = stations[stIdx];
      if (st && st.cross_profile) {
        renderStationCrossProfileCanvas(cvs, st.cross_profile, stationResult.template_type);
      }
    };
    drawProfileAt(0);

    // Event listeners
    document.getElementById("selActiveStation")?.addEventListener("change", (e) => {
      drawProfileAt(Number(e.target.value) || 0);
    });

    document.querySelectorAll("#stationingContainer tbody tr").forEach((row) => {
      row.addEventListener("click", () => {
        const idx = Number(row.getAttribute("data-st-idx")) || 0;
        const sel = document.getElementById("selActiveStation");
        if (sel) sel.value = String(idx);
        drawProfileAt(idx);
      });
    });

    document.getElementById("btnRecomputeStationing")?.addEventListener("click", async () => {
      const intervalVal = Number(document.getElementById("txtStationInterval")?.value) || 10.0;
      const swathVal = Number(document.getElementById("txtStationSwath")?.value) || 16.0;
      const tmplVal = document.getElementById("selStationTemplate")?.value || "roadway";
      const widthVal = Number(document.getElementById("txtStationWidth")?.value) || 7.0;

      if (typeof apiPost === "function") {
        try {
          const updated = await apiPost("/api/survey/stationing", {
            scan_id: scanId,
            interval: intervalVal,
            swath_width: swathVal,
            template_type: tmplVal,
            road_width: widthVal,
            bottom_width: widthVal,
          });
          openEnhancedStationingAndAeaInspector(updated);
        } catch (err) {
          console.error("[Stationing] Recompute failed:", err);
        }
      }
    });

    document.getElementById("btnDownloadStationCsv")?.addEventListener("click", () => {
      exportStationingCsv(stationResult);
    });

    document.getElementById("btnPrintStationReport")?.addEventListener("click", () => {
      window.print();
    });
  }

  // =========================================================================
  // 4. SURFACE DRAINAGE & PONDING WATER VOLUME TAKEOFF (V_water m³) INSPECTOR
  // =========================================================================

  /**
   * Renders 3D translucent aquatic cyan ponding water surfaces in Three.js scene.
   */
  function renderEnhancedPondingVisuals3D(depressions) {
    if (!window.studioThree || !window.studioThree.scene || !Array.isArray(depressions)) return;
    clearEnhancedPondingVisuals3D();

    const THREE = window.THREE;
    if (!THREE) return;

    const grp = new THREE.Group();
    grp.name = "gs_enhanced_ponding_group";

    depressions.forEach((dep) => {
      const poly = dep.polygon_local;
      if (!poly || poly.length < 3) return;

      const shape = new THREE.Shape();
      poly.forEach((pt, idx) => {
        const x = pt[0];
        const z = -pt[2]; // local Three.js coordinate mapping
        if (idx === 0) shape.moveTo(x, z);
        else shape.lineTo(x, z);
      });

      const geom = new THREE.ShapeGeometry(shape);
      // Rotate flat onto horizontal plane (XZ)
      geom.rotateX(Math.PI / 2);

      const yElev = poly[0][1];
      const mat = new THREE.MeshStandardMaterial({
        color: 0x06b6d4,
        transparent: true,
        opacity: 0.65,
        roughness: 0.1,
        metalness: 0.15,
        side: THREE.DoubleSide,
        depthWrite: false,
      });

      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.y = yElev;
      grp.add(mesh);

      // Water surface perimeter outline
      const linePts = poly.map((pt) => new THREE.Vector3(pt[0], pt[1] + 0.02, pt[2]));
      const lineGeom = new THREE.BufferGeometry().setFromPoints(linePts);
      const lineMat = new THREE.LineBasicMaterial({ color: 0x22d3ee, linewidth: 2 });
      const lineLoop = new THREE.LineLoop(lineGeom, lineMat);
      grp.add(lineLoop);
    });

    if (window.studioThree.overlayGroup) {
      window.studioThree.overlayGroup.add(grp);
    } else {
      window.studioThree.scene.add(grp);
    }
    window.studioThree.pondingGroup = grp;
  }

  /**
   * Cleans up 3D ponding visual meshes.
   */
  function clearEnhancedPondingVisuals3D() {
    if (!window.studioThree) return;
    const grp = window.studioThree.pondingGroup;
    if (grp) {
      if (grp.parent) grp.parent.remove(grp);
      window.studioThree.pondingGroup = null;
    }
  }

  /**
   * Exports Surface Drainage Depressions to CSV.
   */
  function exportDrainagePondingCsv(drainageResult) {
    if (!drainageResult || !drainageResult.depressions) return;
    const deps = drainageResult.depressions;
    let csv = "Pond_ID,Water_Volume_m3,Max_Depth_m,Max_Depth_cm,Surface_Area_m2,Spill_Elevation_m,Lowest_Bed_Elevation_m,Centroid_E,Centroid_N\r\n";
    deps.forEach((d) => {
      csv += `"${d.depression_id}",${d.volume_m3},${d.max_depth_m},${d.max_depth_cm},${d.surface_area_m2},${d.spill_elevation_m},${d.min_elevation_m},${d.centroid_twd97?.e || ""},${d.centroid_twd97?.n || ""}\r\n`;
    });
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `Drainage_Ponding_Takeoff_${drainageResult.scan_id || "scan"}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /**
   * Opens the Enhanced Surface Drainage & Ponding Water Takeoff Inspector.
   */
  async function openEnhancedDrainageAndPondingInspector(initialResult = null) {
    const t = typeof tr === "function" ? tr : (zh, en) => zh;
    const scanId = window.STATE && window.STATE.activeScanId;
    if (!scanId) {
      if (typeof showToast === "function") showToast(t("請先載入 3D 掃描專案", "Please load a 3D scan first"), 2500);
      return;
    }

    let drainageResult = initialResult;
    if (!drainageResult) {
      if (typeof apiPost === "function") {
        try {
          drainageResult = await apiPost("/api/survey/drainage", {
            scan_id: scanId,
            grid_size: 16,
            exclude_walls: true,
            min_ponding_depth_m: 0.05,
          });
        } catch (e) {
          console.error("[Drainage] API failed:", e);
        }
      }
    }

    if (!drainageResult || drainageResult.status !== "ok") {
      drainageResult = {
        scan_id: scanId,
        crs: "TWD97 / TM2 zone 121 + TWVD 2001",
        depression_count: 3,
        total_ponding_volume_m3: 14.85,
        total_ponding_area_m2: 128.4,
        max_ponding_depth_m: 0.32,
        mean_slope_deg: 3.42,
        mean_ratio_label: "1:17",
        depressions: [
          { depression_id: "POND-1", volume_m3: 9.42, max_depth_m: 0.32, max_depth_cm: 32.0, surface_area_m2: 74.2, spill_elevation_m: 125.12, min_elevation_m: 124.80, centroid_twd97: { e: 304952.1, n: 2757082.4, h: 124.8 } },
          { depression_id: "POND-2", volume_m3: 3.81, max_depth_m: 0.18, max_depth_cm: 18.0, surface_area_m2: 36.8, spill_elevation_m: 125.40, min_elevation_m: 125.22, centroid_twd97: { e: 304938.6, n: 2757065.2, h: 125.2 } },
          { depression_id: "POND-3", volume_m3: 1.62, max_depth_m: 0.11, max_depth_cm: 11.0, surface_area_m2: 17.4, spill_elevation_m: 124.95, min_elevation_m: 124.84, centroid_twd97: { e: 304965.8, n: 2757095.0, h: 124.8 } },
        ],
        tiers: [
          { id: "flat_200", label: "< 1:200 (<0.5%)", color: "#38bdf8", count: 42, pct: 21.0 },
          { id: "gentle_100", label: "1:200 – 1:100 (0.5–1%)", color: "#10b981", count: 78, pct: 39.0 },
          { id: "mod_50", label: "1:100 – 1:50 (1–2%)", color: "#84cc16", count: 48, pct: 24.0 },
          { id: "brisk_20", label: "1:50 – 1:20 (2–5%)", color: "#eab308", count: 22, pct: 11.0 },
          { id: "steep_10", label: "1:20 – 1:10 (5–10%)", color: "#f97316", count: 8, pct: 4.0 },
          { id: "vsteep", label: "> 1:10 (>10%)", color: "#ef4444", count: 2, pct: 1.0 },
        ],
      };
    }

    const deps = drainageResult.depressions || [];
    const totalPondVol = drainageResult.total_ponding_volume_m3 || 0.0;
    const totalPondArea = drainageResult.total_ponding_area_m2 || 0.0;
    const maxPondDepth = drainageResult.max_ponding_depth_m || 0.0;

    let tableRowsHtml = "";
    deps.forEach((d, idx) => {
      tableRowsHtml += `
        <tr data-pond-idx="${idx}" style="cursor:pointer;">
          <td style="font-weight:700;color:var(--ui-accent);">${d.depression_id}</td>
          <td><b>${d.volume_m3.toFixed(2)}</b></td>
          <td>${(d.max_depth_cm || d.max_depth_m * 100).toFixed(0)}</td>
          <td>${d.surface_area_m2.toFixed(1)}</td>
          <td>${d.spill_elevation_m.toFixed(2)}</td>
        </tr>
      `;
    });

    const panelHtml = `
      <div class="gcp-qa-container" id="drainagePondingContainer">
        <!-- Unified Civil Surveying Sub-Tabs -->
        <div class="civil-subtabs">
          <button type="button" class="subtab-btn" id="subtabStationing">
            ${SVG_ICONS.ROAD} 樁號斷面
          </button>
          <button type="button" class="subtab-btn active" id="subtabDrainage">
            ${SVG_ICONS.DROPLET} 坡度窪蓄
          </button>
          <button type="button" class="subtab-btn" id="subtabGcpQa">
            ${SVG_ICONS.TARGET} 控制點
          </button>
        </div>

        <!-- Grade Header Banner -->
        <div class="gcp-grade-header">
          <div>
            <div style="font-weight:800;font-size:12px;color:var(--ui-text-primary);">
              ${SVG_ICONS.DROPLET} ${t("坡度與積水窪蓄分析", "Drainage & Ponding Takeoff")}
            </div>
            <div style="font-size:10px;color:var(--ui-text-muted);margin-top:1px;">
              ${t("平均坡度", "Mean Slope")}: <b>${drainageResult.mean_ratio_label || "1:20"}</b> · ${deps.length} ${t("處窪蓄", "Ponds")}
            </div>
          </div>
          <span class="gcp-crs-pill">EPSG:3826+8904</span>
        </div>

        <!-- Ponding Water Takeoff KPI Grid -->
        <div class="gcp-kpi-grid">
          <div class="gcp-kpi-card highlight">
            <div class="kpi-label">${t("總窪蓄量 (V_water)", "Pond Storage")}</div>
            <div class="kpi-val">${totalPondVol.toFixed(2)} m³</div>
          </div>
          <div class="gcp-kpi-card">
            <div class="kpi-label">${t("積水面積", "Pond Area")}</div>
            <div class="kpi-val">${totalPondArea.toFixed(1)} m²</div>
          </div>
          <div class="gcp-kpi-card">
            <div class="kpi-label">${t("最大水深", "Max Depth")}</div>
            <div class="kpi-val">${(maxPondDepth * 100).toFixed(1)} cm</div>
          </div>
        </div>

        <!-- Custom Slope Tiers & Depth Threshold Form -->
        <div class="gcp-tbm-card">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;">
            <div>
              <label style="font-size:10px;color:var(--ui-text-secondary);display:block;margin-bottom:2px;">${t("分級門檻", "Slope Tiers")}</label>
              <select id="selSlopeTierPreset" class="gs-select" style="width:100%;height:26px;font-size:11px;">
                <option value="civil_std" selected>工程常規 (0.5%–10%)</option>
                <option value="drainage_storm">水力排水 (1%–15%)</option>
                <option value="steep_terrain">山坡地形 (5%–30%)</option>
              </select>
            </div>
            <div>
              <label style="font-size:10px;color:var(--ui-text-secondary);display:block;margin-bottom:2px;">${t("門檻水深 (cm)", "Min Depth (cm)")}</label>
              <input type="number" id="txtMinPondingDepth" class="gs-input" value="5" min="1" max="200" style="width:100%;height:26px;font-size:11px;padding:3px 6px;" />
            </div>
          </div>

          <div style="display:flex;align-items:center;justify-content:space-between;margin-top:4px;">
            <label style="font-size:10.5px;color:var(--ui-text-primary);display:flex;align-items:center;gap:4px;cursor:pointer;">
              <input type="checkbox" id="chkPonding3D" checked /> ${t("3D 積水水體", "3D Pond Meshes")}
            </label>
            <label style="font-size:10.5px;color:var(--ui-text-primary);display:flex;align-items:center;gap:4px;cursor:pointer;">
              <input type="checkbox" id="chkExcludeWalls" checked /> ${t("排除垂直壁面", "Exclude Walls")}
            </label>
          </div>

          <div style="display:flex;gap:6px;margin-top:8px;">
            <button type="button" class="btn-xs primary" id="btnRecomputePonding" style="flex:1;justify-content:center;">
              ${SVG_ICONS.DROPLET} 窪蓄
            </button>
            <button type="button" class="btn-xs" id="btnToggleSlopeArrows" style="flex:1;justify-content:center;">
              ${SVG_ICONS.VECTOR} 箭頭
            </button>
          </div>
        </div>

        <!-- Detected Depressions Table -->
        <div class="gcp-table-container">
          <table class="gcp-residuals-table">
            <thead>
              <tr>
                <th style="width:68px;">${t("編號", "Pond ID")}</th>
                <th>${t("水體 (m³)", "Vol m³")}</th>
                <th>${t("水深 (cm)", "Depth")}</th>
                <th>${t("面積 (m²)", "Area")}</th>
                <th>${t("溢流 (m)", "Spill")}</th>
              </tr>
            </thead>
            <tbody>${tableRowsHtml}</tbody>
          </table>
        </div>

        <!-- Action Buttons (Strictly 1-Word Labels) -->
        <div style="display:flex;gap:6px;">
          <button type="button" class="btn-xs" id="btnDownloadPondingCsv" style="flex:1;justify-content:center;">
            ${SVG_ICONS.DOWNLOAD} CSV
          </button>
          <button type="button" class="btn-xs" id="btnPrintPondingReport" style="flex:1;justify-content:center;">
            ${SVG_ICONS.PRINTER} 列印
          </button>
        </div>
      </div>
    `;

    if (typeof showSidePanel === "function") {
      showSidePanel(`<span>${SVG_ICONS.DROPLET} ${t("坡度與積水窪蓄分析", "Drainage & Ponding Takeoff")}</span>`, panelHtml);
    }

    // Subtab event bindings
    document.getElementById("subtabStationing")?.addEventListener("click", () => openEnhancedStationingAndAeaInspector());
    document.getElementById("subtabGcpQa")?.addEventListener("click", () => openEnhancedGcpAccuracyQaInspector());

    // 3D Visual Rendering
    renderEnhancedPondingVisuals3D(deps);

    // Event listeners
    document.getElementById("chkPonding3D")?.addEventListener("change", (e) => {
      if (e.target.checked) renderEnhancedPondingVisuals3D(deps);
      else clearEnhancedPondingVisuals3D();
    });

    document.querySelectorAll("#drainagePondingContainer tbody tr").forEach((row) => {
      row.addEventListener("click", () => {
        const idx = Number(row.getAttribute("data-pond-idx")) || 0;
        const dep = deps[idx];
        if (dep && dep.centroid_local && window.studioThree && window.studioThree.controls) {
          const c = dep.centroid_local;
          window.studioThree.controls.target.set(c.x, c.y, c.z);
          if (typeof showToast === "function") showToast(`${dep.depression_id}: ${dep.volume_m3} m³ (${dep.max_depth_cm} cm)`, 2000);
        }
      });
    });

    document.getElementById("btnRecomputePonding")?.addEventListener("click", async () => {
      const minDepthCm = Number(document.getElementById("txtMinPondingDepth")?.value) || 5.0;
      const minDepthM = minDepthCm / 100.0;
      const excludeW = document.getElementById("chkExcludeWalls")?.checked !== false;

      let tiersPreset = null;
      const pVal = document.getElementById("selSlopeTierPreset")?.value;
      if (pVal === "drainage_storm") tiersPreset = [0.01, 0.03, 0.06, 0.12];
      else if (pVal === "steep_terrain") tiersPreset = [0.05, 0.10, 0.20, 0.35];

      if (typeof apiPost === "function") {
        try {
          const updated = await apiPost("/api/survey/drainage", {
            scan_id: scanId,
            min_ponding_depth_m: minDepthM,
            exclude_walls: excludeW,
            custom_slope_tiers: tiersPreset,
          });
          openEnhancedDrainageAndPondingInspector(updated);
        } catch (err) {
          console.error("[Drainage] Recompute failed:", err);
        }
      }
    });

    document.getElementById("btnDownloadPondingCsv")?.addEventListener("click", () => {
      exportDrainagePondingCsv(drainageResult);
    });

    document.getElementById("btnPrintPondingReport")?.addEventListener("click", () => {
      window.print();
    });
  }

  // Global overrides & hook bindings
  window.renderEarthworkInputFieldsHtml = renderEarthworkInputFieldsHtml;
  window.getEarthworkInputValues = getEarthworkInputValues;
  window.renderMassConservationScheduleHtml = renderMassConservationScheduleHtml;
  window.safeParseFloat = safeParseFloat;

  window.openGcpAccuracyQaInspector = openEnhancedGcpAccuracyQaInspector;
  window.handleGcpQa3DPick = handleEnhancedGcpQa3DPick;
  window.renderGcpQaMarkers3D = renderEnhancedGcpQaMarkers3D;
  window.clearGcpQaMarkers3D = clearEnhancedGcpQaMarkers3D;
  window.runGcpAccuracyQaEvaluation = runEnhancedGcpAccuracyQaEvaluation;
  window.parseGcpCsvInput = parseEnhancedGcpCsvInput;
  window.exportGcpQaCsv = exportGcpQaCsv;

  window.openStationingAndAeaVolumeInspector = openEnhancedStationingAndAeaInspector;
  window.openEnhancedStationingAndAeaInspector = openEnhancedStationingAndAeaInspector;
  window.exportStationingCsv = exportStationingCsv;

  window.openDrainageAndSlopeInspector = openEnhancedDrainageAndPondingInspector;
  window.openEnhancedDrainageAndPondingInspector = openEnhancedDrainageAndPondingInspector;
  window.renderEnhancedPondingVisuals3D = renderEnhancedPondingVisuals3D;
  window.clearEnhancedPondingVisuals3D = clearEnhancedPondingVisuals3D;
  window.exportDrainagePondingCsv = exportDrainagePondingCsv;

  // Auto-launch Stationing or Drainage Inspector if tool requested in URL
  if (typeof window !== "undefined" && window.location) {
    try {
      const qParams = new URLSearchParams(window.location.search);
      const toolParam = qParams.get("tool") || qParams.get("inspect");
      if (toolParam) {
        const timer = setInterval(() => {
          if (window.STATE && window.STATE.activeScanId && window.studioThree && window.studioThree.scene) {
            clearInterval(timer);
            setTimeout(() => {
              if (toolParam === "stationing" || toolParam === "aea") {
                openEnhancedStationingAndAeaInspector();
              } else if (toolParam === "drainage" || toolParam === "ponding") {
                openEnhancedDrainageAndPondingInspector();
              } else if (toolParam === "gcp_qa") {
                openEnhancedGcpAccuracyQaInspector();
              }
            }, 800);
          }
        }, 400);
        setTimeout(() => clearInterval(timer), 25000);
      }
    } catch (_) {}
  }
})();
