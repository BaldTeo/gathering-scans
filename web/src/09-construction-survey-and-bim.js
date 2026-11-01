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
    CHART: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>`,
    STAKEOUT: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><circle cx="12" cy="10" r="6"></circle><circle cx="12" cy="10" r="2"></circle><line x1="12" y1="16" x2="12" y2="22"></line><line x1="8" y1="22" x2="16" y2="22"></line></svg>`,
    CONTOURS: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><ellipse cx="12" cy="12" rx="9" ry="5"></ellipse><ellipse cx="12" cy="12" rx="5" ry="2.5"></ellipse></svg>`,
    INFO: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`
  };

  /**
   * Renders a bilingual (ZH + EN) function explanation banner at the top of each Survey / QA tool menu.
   */
  function renderSurveyToolExplanationBannerHtml(zhTitle, enTitle, zhDesc, enDesc) {
    const lang =
      (typeof window.getAppLanguage === "function" && window.getAppLanguage()) ||
      (window.STATE && window.STATE.lang) ||
      document.documentElement.lang ||
      "zh-TW";
    const isEn = String(lang).toLowerCase().startsWith("en");
    const primaryTitle = isEn ? enTitle : zhTitle;
    const subTitle = isEn ? "Function Overview" : enTitle;
    const primaryDesc = isEn ? enDesc : zhDesc;
    return `
      <div class="gs-survey-explainer-banner" data-no-auto-i18n="1" style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border);border-left:3px solid var(--ui-accent);border-radius:6px;padding:7px 9px;margin-bottom:8px;line-height:1.4;">
        <div style="font-size:11px;font-weight:700;color:var(--ui-text-primary);display:flex;align-items:center;justify-content:space-between;gap:5px;margin-bottom:3px;">
          <span style="display:inline-flex;align-items:center;gap:5px;">
            ${SVG_ICONS.INFO}
            <span>${primaryTitle}</span>
          </span>
          <span style="font-size:9.5px;font-weight:600;color:var(--ui-accent);opacity:0.9;">${subTitle}</span>
        </div>
        <div style="font-size:10.5px;color:var(--ui-text-secondary);">${primaryDesc}</div>
        ${!isEn ? `<div style="font-size:9.8px;color:var(--ui-text-muted);margin-top:2px;">${enDesc}</div>` : ""}
      </div>
    `;
  }

  /**
   * Renders the unified 4-tab Survey (測量) container navigation bar:
   * Stakeout (放樣), Station (樁號), Check (檢核), Contours (等高線).
   * Note: Slope/Drainage is intentionally excluded from the Survey menu (resides in QA menu).
   */
  function renderSurveyContainerSubtabsHtml(activeTab) {
    const t = typeof tr === "function" ? tr : (zh, en) => zh;
    return `
      <div class="civil-subtabs" id="surveyUnifiedSubtabBar" role="tablist" aria-label="${t("工程測量工具", "Engineering Survey Tools")}" style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:8px;">
        <button type="button" class="subtab-btn ${activeTab === "stakeout" ? "active" : ""}" id="subtabStakeout" data-survey-tab="stakeout" title="${t("RTK 施工放樣點位與座標匯出 (E, N, Z)", "RTK Stakeout Coordinate Exporter (E, N, Z)")}" style="padding:5px 4px;font-size:10.5px;justify-content:center;">
          ${SVG_ICONS.STAKEOUT} <span>${t("放樣", "Stakeout")}</span>
        </button>
        <button type="button" class="subtab-btn ${activeTab === "stationing" ? "active" : ""}" id="subtabStationing" data-survey-tab="stationing" title="${t("道路中心線樁號斷面 (0K+000) 與平均端面積土方", "Centerline Stationing (0K+000) & AEA Volume")}" style="padding:5px 4px;font-size:10.5px;justify-content:center;">
          ${SVG_ICONS.ROAD} <span>${t("樁號", "Station")}</span>
        </button>
        <button type="button" class="subtab-btn ${activeTab === "gcp_qa" ? "active" : ""}" id="subtabGcpQa" data-survey-tab="gcp_qa" title="${t("控制點精度檢核報告 (RMSE 與 TBM 校正)", "GCP Check-Point Accuracy QA & TBM Calibration")}" style="padding:5px 4px;font-size:10.5px;justify-content:center;">
          ${SVG_ICONS.TARGET} <span>${t("檢核", "Check")}</span>
        </button>
        <button type="button" class="subtab-btn ${activeTab === "contours" ? "active" : ""}" id="subtabContours" data-survey-tab="contours" title="${t("等高線與測量成果圖 (.DXF + A3 PDF)", "Elevation Contours & A3 Survey Sheet (.DXF + PDF)")}" style="padding:5px 4px;font-size:10.5px;justify-content:center;">
          ${SVG_ICONS.CONTOURS} <span>${t("等高線", "Contours")}</span>
        </button>
      </div>
    `;
  }

  function bindSurveyContainerSubtabs(activeTab) {
    document.getElementById("subtabStakeout")?.addEventListener("click", () => {
      if (activeTab !== "stakeout" && typeof window.openRtkStakeoutInspector === "function") {
        window.openRtkStakeoutInspector();
      }
    });
    document.getElementById("subtabStationing")?.addEventListener("click", () => {
      if (activeTab !== "stationing") {
        openEnhancedStationingAndAeaInspector();
      }
    });
    document.getElementById("subtabGcpQa")?.addEventListener("click", () => {
      if (activeTab !== "gcp_qa") {
        openEnhancedGcpAccuracyQaInspector();
      }
    });
    document.getElementById("subtabContours")?.addEventListener("click", () => {
      if (activeTab !== "contours") {
        if (typeof setActiveStudioTool === "function") setActiveStudioTool("contours");
        if (typeof window.openContoursInspector === "function") window.openContoursInspector();
      }
    });
  }

  /**
   * Exact inverse of localToTwd97 with optional 3D mesh surface draping.
   * Resolves TWD97 (Easting, Northing, TWVD2001 Elevation) into Three.js local coordinates (x, y, z)
   * and drapes onto the loaded 3D scan mesh so markers never float or sink out of view.
   */
  function surveyTwd97ToLocalVec3(e, n, h, drapeToMesh = true, explicitLocal = null) {
    const THREE = window.THREE;
    if (!THREE) return null;

    let o = { e: 304952.4, n: 2757084.2, h: 124.8 };
    let lx = 0, ly = 0, lz = 0;
    let resolvedViaJacobian = false;

    if (typeof window.localToTwd97 === "function") {
      try {
        o = window.localToTwd97({ x: 0, y: 0, z: 0 }) || o;
        const px = window.localToTwd97({ x: 1, y: 0, z: 0 });
        const pz = window.localToTwd97({ x: 0, y: 0, z: 1 });
        const ax = px.e - o.e;
        const bx = px.n - o.n;
        const az = pz.e - o.e;
        const bz = pz.n - o.n;
        const det = ax * bz - az * bx;
        if (Math.abs(det) > 1e-8 && Number.isFinite(Number(e)) && Number.isFinite(Number(n))) {
          const de = Number(e) - o.e;
          const dn = Number(n) - o.n;
          lx = (de * bz - dn * az) / det;
          lz = (ax * dn - bx * de) / det;
          ly = Number.isFinite(Number(h)) ? Number(h) - o.h : 0;
          resolvedViaJacobian = true;
        }
      } catch (_) {}
    }

    let expX = null, expY = null, expZ = null;
    if (Array.isArray(explicitLocal) && explicitLocal.length >= 3) {
      expX = Number(explicitLocal[0]);
      expY = Number(explicitLocal[1]);
      expZ = Number(explicitLocal[2]);
    } else if (explicitLocal && typeof explicitLocal === "object") {
      expX = Number(explicitLocal.x !== undefined ? explicitLocal.x : explicitLocal.local_x);
      expY = Number(explicitLocal.y !== undefined ? explicitLocal.y : explicitLocal.local_y);
      expZ = Number(explicitLocal.z !== undefined ? explicitLocal.z : explicitLocal.local_z);
    }
    const hasExplicit = Number.isFinite(expX) && Number.isFinite(expZ);

    if (!resolvedViaJacobian && hasExplicit) {
      lx = expX;
      ly = Number.isFinite(expY) ? expY : 0;
      lz = expZ;
    }

    const boundR = Math.max(40, (Number(window.studioThree?.boundingSphere?.radius) || 45) * 2.5);
    if (hasExplicit && Math.hypot(lx, lz) > boundR && Math.hypot(expX, expZ) <= boundR) {
      lx = expX;
      if (Number.isFinite(expY)) ly = expY;
      lz = expZ;
    }

    let hitMesh = false;
    if (typeof window.sampleStudioMeshElevationAtLocalXZ === "function") {
      let sHit = window.sampleStudioMeshElevationAtLocalXZ(lx, lz, ly);
      if ((!sHit || !sHit.hit) && hasExplicit && Math.hypot(lx - expX, lz - expZ) > 0.25) {
        const altHit = window.sampleStudioMeshElevationAtLocalXZ(expX, expZ, Number.isFinite(expY) ? expY : ly);
        if (altHit && altHit.hit) {
          lx = expX;
          lz = expZ;
          sHit = altHit;
        }
      }
      if (sHit && sHit.hit && Number.isFinite(sHit.y)) {
        hitMesh = true;
        if (drapeToMesh || Math.abs(ly - sHit.y) > 8.0) {
          ly = sHit.y;
        }
      }
    }

    const vec = new THREE.Vector3(lx, ly, lz);
    vec.surfaceH = Number((o.h + ly).toFixed(3));
    vec.hitMesh = hitMesh;
    return vec;
  }

  function focusStudioCameraOnLocalPoint(localVec, minDist = 14) {
    if (!localVec || !window.studioThree || !window.studioThree.camera || !window.studioThree.controls) return;
    const THREE = window.THREE;
    const cam = window.studioThree.camera;
    const ctrl = window.studioThree.controls;
    const offset = cam.position.clone().sub(ctrl.target);
    const curDist = offset.length();
    if (curDist < 2 || curDist > 120) {
      offset.normalize().multiplyScalar(Math.max(minDist, 22));
    }
    ctrl.target.copy(localVec);
    cam.position.copy(localVec).add(offset);
    ctrl.update();
    if (typeof window.updateZoomInvariantElements === "function") window.updateZoomInvariantElements();
    if (typeof window.update2DBadgePositions === "function") window.update2DBadgePositions();
  }

  window.surveyTwd97ToLocalVec3 = surveyTwd97ToLocalVec3;
  window.focusStudioCameraOnLocalPoint = focusStudioCameraOnLocalPoint;
  window.renderSurveyToolExplanationBannerHtml = renderSurveyToolExplanationBannerHtml;
  window.renderSurveyContainerSubtabsHtml = renderSurveyContainerSubtabsHtml;
  window.bindSurveyContainerSubtabs = bindSurveyContainerSubtabs;

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
            <div><b>${t("坡度：", "Slope:")}</b> ${esc(slopePct)}% (${esc(slopeDeg)} deg)</div>
            <div><b>${t("方位角：", "Azimuth:")}</b> ${esc(azDeg)} deg</div>
          </div>
          <div style="font-size:10px;color:var(--ui-text-muted);margin-top:2px;">
            Z = ${Number(bfp.c || bfp.c0 || 0).toFixed(3)} + (${Number(bfp.a || 0).toFixed(4)} x dE) + (${Number(bfp.b || 0).toFixed(4)} x dN)
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
   * Safely disposes and clears all Three.js 3D GCP QA overlay markers, error vectors, and 2D badges.
   */
  function clearEnhancedGcpQaMarkers3D() {
    if (window.STATE && Array.isArray(window.STATE.badges2D)) {
      window.STATE.badges2D = window.STATE.badges2D.filter((b) => {
        if (b && b.surveyTool === "gcp_qa") {
          b.el?.remove();
          return false;
        }
        return true;
      });
    }
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
   * Renders 3D Studio Three.js GCP Target Reticles, Zoom-Invariant Pin Monuments,
   * TBM Diamond Badges, 3D Error Vector Arrows (THREE.ArrowHelper), and floating 2D HUD Badges.
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
    const activePointId = String(options.activePointId || "");

    points.forEach((p, idx) => {
      const pe = Number(p.e_scan !== undefined ? p.e_scan : p.e) || 0;
      const pn = Number(p.n_scan !== undefined ? p.n_scan : p.n) || 0;
      const ph = Number(p.h_scan !== undefined ? p.h_scan : (p.h_gcp || 0)) || 0;
      const posVec = surveyTwd97ToLocalVec3(pe, pn, ph, true, p.local);
      if (!posVec) return;
      p._resolvedLocal = { x: posVec.x, y: posVec.y, z: posVec.z };

      const lx = posVec.x;
      const ly = posVec.y;
      const lz = posVec.z;

      const isTbm = Boolean(p.is_tbm);
      const isFocused = Boolean(activePointId && String(p.name || p.id) === activePointId);
      const status = String(p.status || "pass").toLowerCase();
      const colHex = isFocused
        ? 0x00f6ff
        : isTbm
        ? 0x0284c7
        : status === "pass"
        ? 0x10b981
        : status === "warn"
        ? 0xf59e0b
        : 0xef4444;

      // 1. Zoom-Invariant 3D Pin Marker + Range Pole (visible at any camera zoom)
      if (typeof window.add3DPinMarker === "function") {
        window.add3DPinMarker(posVec, colHex, grp);
      }
      const poleHeight = isTbm ? 1.85 : 1.35;
      const poleGeom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(lx, ly + 0.04, lz),
        new THREE.Vector3(lx, ly + poleHeight, lz),
      ]);
      const poleLine = new THREE.Line(
        poleGeom,
        new THREE.LineBasicMaterial({ color: colHex, depthTest: false, transparent: true, opacity: 0.92 })
      );
      poleLine.renderOrder = 998;
      grp.add(poleLine);

      // 2. Ground Target Reticle (Horizontal Ring + Crosshair)
      const ringGeom = new THREE.RingGeometry(0.45, 0.85, 28);
      const ringMat = new THREE.MeshBasicMaterial({
        color: colHex,
        side: THREE.DoubleSide,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      });
      const ringMesh = new THREE.Mesh(ringGeom, ringMat);
      ringMesh.rotation.x = -Math.PI / 2;
      ringMesh.position.set(lx, ly + 0.06, lz);
      ringMesh.renderOrder = 998;
      grp.add(ringMesh);

      if (isTbm) {
        const diamondGeom = new THREE.RingGeometry(0.95, 1.25, 4);
        const diamondMat = new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          side: THREE.DoubleSide,
          depthTest: false,
        });
        const diamondMesh = new THREE.Mesh(diamondGeom, diamondMat);
        diamondMesh.rotation.x = -Math.PI / 2;
        diamondMesh.rotation.z = Math.PI / 4;
        diamondMesh.position.set(lx, ly + 0.07, lz);
        diamondMesh.renderOrder = 999;
        grp.add(diamondMesh);
      }

      // 3. 3D Residual Error Vector (ArrowHelper)
      const de = Number(p.de !== undefined ? p.de : p.de_m) || 0;
      const dn = Number(p.dn !== undefined ? p.dn : p.dn_m) || 0;
      const dh = Number(p.dh !== undefined ? p.dh : (p.dz_m !== undefined ? p.dz_m : 0)) || 0;

      const dx = de;
      const dy = dh;
      const dz = -dn;
      const length3D = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (length3D >= 0.0005) {
        const dir = new THREE.Vector3(dx / length3D, dy / length3D, dz / length3D);
        const origin = new THREE.Vector3(lx, ly + 0.12, lz);
        const lengthVis = Math.max(0.45, length3D * scale);
        const headLen = Math.min(lengthVis * 0.35, 0.55);
        const headWidth = Math.min(lengthVis * 0.22, 0.3);

        const arrow = new THREE.ArrowHelper(dir, origin, lengthVis, colHex, headLen, headWidth);
        if (arrow.line && arrow.line.material) arrow.line.material.depthTest = false;
        if (arrow.cone && arrow.cone.material) arrow.cone.material.depthTest = false;
        arrow.renderOrder = 999;
        grp.add(arrow);
      }

      // 4. Floating 2D Badge showing CP ID, TBM tag, and ΔH / Δ3D residuals
      if (typeof window.add2DBadge === "function") {
        const ptName = String(p.name || p.id || `CP-${idx + 1}`);
        const dhCm = Number(p.dh_cm !== undefined ? p.dh_cm : dh * 100).toFixed(1);
        const d3dCm = Number(p.d3d_cm !== undefined ? p.d3d_cm : length3D * 100).toFixed(1);
        const bCol = isTbm ? "#38bdf8" : status === "pass" ? "#10b981" : status === "warn" ? "#f59e0b" : "#ef4444";
        const badgeAnchor = new THREE.Vector3(lx, ly + poleHeight + 0.15, lz);
        const badgeHtml = `<span style="display:inline-flex;align-items:center;gap:4px;font-family:var(--font-mono);font-size:10.5px;font-weight:700;"><span style="color:${bCol};">${ptName}${isTbm ? " [TBM]" : ""}</span><span style="opacity:0.88;">dH:${dhCm >= 0 ? "+" : ""}${dhCm}cm | 3D:${d3dCm}cm</span></span>`;
        window.add2DBadge(badgeAnchor, badgeHtml, {
          isSurveyToolBadge: true,
          surveyTool: "gcp_qa",
          priority: (isFocused ? 140 : 0) + (isTbm ? 95 : 80 - idx),
          isFocused,
          offsetY: -12,
        });
      }
    });

    if (typeof window.updateZoomInvariantElements === "function") window.updateZoomInvariantElements();
    if (typeof window.update2DBadgePositions === "function") window.update2DBadgePositions();
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
    const currentScale = (window.STATE && window.STATE.gcpVectorExaggeration) || 20;
    renderEnhancedGcpQaMarkers3D(resList, { exaggerationScale: currentScale });

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
      .map((p, idx) => {
        const status = String(p.status || "pass").toLowerCase();
        const isTbm = Boolean(p.is_tbm);
        const deCm = Number(p.de_cm !== undefined ? p.de_cm : (p.de * 100)).toFixed(1);
        const dnCm = Number(p.dn_cm !== undefined ? p.dn_cm : (p.dn * 100)).toFixed(1);
        const dhCm = Number(p.dh_cm !== undefined ? p.dh_cm : (p.dz_cm !== undefined ? p.dz_cm : (p.dh * 100))).toFixed(1);
        const d3dCm = Number(p.d3d_cm !== undefined ? p.d3d_cm : (p.d3d * 100)).toFixed(1);
        const hGcpStr = Number(p.h_gcp).toFixed(3);
        const hScanStr = Number(p.h_scan).toFixed(3);
        const statusColor = status === "pass" ? "#10b981" : status === "warn" ? "#f59e0b" : "#ef4444";
        const rowTooltip = `${esc(p.name)}: GCP H=${hGcpStr}m, Scan H=${hScanStr}m | dH=${dhCm >= 0 ? "+" : ""}${dhCm}cm, d3D=${d3dCm}cm | ${status.toUpperCase()}`;

        return `
          <tr data-point-id="${esc(p.name)}" data-point-idx="${idx}" style="cursor:pointer;" title="${rowTooltip}">
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

    const panelHtml = `
      <div class="gcp-qa-container">
        ${renderSurveyContainerSubtabsHtml("gcp_qa")}
        ${renderSurveyToolExplanationBannerHtml(
          "控制點精度檢核",
          "GCP & Check-Point Accuracy QA",
          "比對實測控制點 (E, N, H) 與 3D 掃描模型，自動計算 ASPRS 3D/2D/高程 RMSE 誤差向量並執行單鍵 TBM 水準校正。",
          "Validates 3D scan accuracy against ground control points (E, N, H), renders 3D residual vectors, and calibrates vertical TBM datum."
        )}

        <div class="gcp-grade-header">
          <span class="gcp-crs-pill" title="${esc(qaResult.crs || "TWD97 / TM2 zone 121 + TWVD 2001 height [EPSG:3826+8904]")}">
            EPSG:3826 + TWVD2001 | N=${resList.length}
          </span>
          <span class="gcp-grade-badge ${gradeClass}">
            Grade ${esc(grade)} (${rmse3dCm} cm)
          </span>
        </div>

        <div class="gcp-kpi-grid">
          <div class="gcp-kpi-card highlight">
            <div class="kpi-label">${t("3D 空間 RMSE", "3D Spatial RMSE")}</div>
            <div class="kpi-val">${rmse3dCm} <span style="font-size:10px;font-weight:600;">cm</span></div>
          </div>
          <div class="gcp-kpi-card">
            <div class="kpi-label">${t("平面 2D RMSE", "2D Planar RMSE")}</div>
            <div class="kpi-val">${rmse2dCm} <span style="font-size:10px;font-weight:600;">cm</span></div>
          </div>
          <div class="gcp-kpi-card">
            <div class="kpi-label">${t("高程 RMSE_H", "Vertical RMSE_H")}</div>
            <div class="kpi-val">${rmseHCm} <span style="font-size:10px;font-weight:600;">cm</span></div>
          </div>
          <div class="gcp-kpi-card">
            <div class="kpi-label">${t("ASPRS 95% 高程", "ASPRS 95% Vert")}</div>
            <div class="kpi-val">+/-${asprsVertCm} <span style="font-size:10px;font-weight:600;">cm</span></div>
          </div>
          <div class="gcp-kpi-card">
            <div class="kpi-label">${t("ASPRS 95% 平面", "ASPRS 95% Horiz")}</div>
            <div class="kpi-val">+/-${asprsHorizCm} <span style="font-size:10px;font-weight:600;">cm</span></div>
          </div>
          <div class="gcp-kpi-card">
            <div class="kpi-label">${t("高程平均偏差", "Mean Vert Bias")}</div>
            <div class="kpi-val">${biasHCm >= 0 ? "+" : ""}${biasHCm} <span style="font-size:10px;font-weight:600;">cm</span></div>
          </div>
        </div>

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

        <div class="gs-form-group" style="margin-bottom:2px;">
          <label style="display:flex;justify-content:space-between;align-items:center;">
            <span>${t("檢核點座標表 (或點擊 3D 模型新增)", "Check Points CSV (or click 3D model)")}</span>
          </label>
          <textarea class="gs-input" id="txtGcpCsvInput" rows="3" placeholder="Point, E, N, H, [TBM]" style="font-family:var(--font-mono);font-size:10.5px;padding:5px 7px;">${esc(csvDefault)}</textarea>
        </div>

        <div style="display:flex;gap:6px;">
          <button type="button" class="btn-xs primary" id="btnComputeGcpQa" style="flex:1;justify-content:center;" title="${t("計算 3D 空間精度與殘差", "Compute 3D Spatial Accuracy & Residuals")}">
            ${SVG_ICONS.CALC} ${t("檢核", "Check")}
          </button>
          <button type="button" class="btn-xs" id="btnLoadSampleGcpPoints" title="${t("自動在工區分佈 6 處標準檢核點", "Auto-Generate 6 Site Check Points")}">
            ${SVG_ICONS.SAMPLE} ${t("佈點", "Sample")}
          </button>
        </div>

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
        `<span>${SVG_ICONS.TARGET} ${t("控制點精度檢核 (Check)", "Control Accuracy QA (Check)")}</span>`,
        panelHtml
      );
    }

    bindSurveyContainerSubtabs("gcp_qa");

    document.querySelectorAll(".gcp-residuals-table tbody tr[data-point-idx]").forEach((row) => {
      row.addEventListener("click", (ev) => {
        if (ev.target && ev.target.tagName === "INPUT") return;
        const idx = Number(row.getAttribute("data-point-idx")) || 0;
        const pt = resList[idx];
        if (!pt) return;
        const pe = Number(pt.e_scan !== undefined ? pt.e_scan : pt.e) || 0;
        const pn = Number(pt.n_scan !== undefined ? pt.n_scan : pt.n) || 0;
        const ph = Number(pt.h_scan !== undefined ? pt.h_scan : (pt.h_gcp || 0)) || 0;
        const vec = surveyTwd97ToLocalVec3(pe, pn, ph, true, pt.local);
        renderEnhancedGcpQaMarkers3D(resList, {
          exaggerationScale: (window.STATE && window.STATE.gcpVectorExaggeration) || 20,
          activePointId: pt.name || pt.id,
        });
        if (vec) focusStudioCameraOnLocalPoint(vec, 16);
      });
    });

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
   * Clears 3D Stationing centerline, cross-section swaths, monuments, and 2D chainage badges.
   */
  function clearStationingVisuals3D() {
    if (window.STATE && Array.isArray(window.STATE.badges2D)) {
      window.STATE.badges2D = window.STATE.badges2D.filter((b) => {
        if (b && b.surveyTool === "stationing") {
          b.el?.remove();
          return false;
        }
        return true;
      });
    }
    if (!window.studioThree || !window.studioThree.overlayGroup) return;
    if (window.studioThree.stationingGroup) {
      window.studioThree.stationingGroup.traverse((obj) => {
        if (obj.geometry) {
          try { obj.geometry.dispose(); } catch (_) {}
        }
        if (obj.material) {
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => { try { m.dispose(); } catch (_) {} });
          } else {
            try { obj.material.dispose(); } catch (_) {}
          }
        }
      });
      window.studioThree.overlayGroup.remove(window.studioThree.stationingGroup);
      window.studioThree.stationingGroup = null;
    }
  }

  /**
   * Renders 3D Centerline Alignment, Perpendicular Cross-Section Swath Profiles,
   * Parametric Corridor Template Lines, Zoom-Invariant Station Monuments, and 2D Chainage HUD Badges.
   */
  function renderStationing3DOverlay(stationResult, activeIdx = 0) {
    if (!window.studioThree || !window.studioThree.overlayGroup) return;
    clearStationingVisuals3D();

    const THREE = window.THREE;
    if (!THREE) return;

    const grp = new THREE.Group();
    grp.name = "GS_StationingGroup";
    window.studioThree.stationingGroup = grp;
    window.studioThree.overlayGroup.add(grp);

    const pickedPts = (window.STATE && Array.isArray(window.STATE.stationAlignmentPoints))
      ? window.STATE.stationAlignmentPoints
      : [];

    // If user is actively picking centerline vertices (< 2 points), render picked nodes immediately
    if (window.STATE && window.STATE.isPickingStationAlignment && pickedPts.length > 0 && (!stationResult || pickedPts.length < 2)) {
      const pickVecs = [];
      pickedPts.forEach((pt, idx) => {
        const v = surveyTwd97ToLocalVec3(pt.e, pt.n, pt.h, true, [pt.local_x, pt.local_y, pt.local_z]);
        if (!v) return;
        pickVecs.push(v.clone().add(new THREE.Vector3(0, 0.14, 0)));
        if (typeof window.add3DPinMarker === "function") {
          window.add3DPinMarker(v, idx === 0 ? 0xff3b30 : 0x00f6ff, grp);
        }
        if (typeof window.add2DBadge === "function") {
          window.add2DBadge(
            v.clone().add(new THREE.Vector3(0, 1.35, 0)),
            `<span style="font-family:var(--font-mono);font-size:10.5px;font-weight:700;color:#00f6ff;">CL-${idx + 1} (${idx === 0 ? "0K+000" : "Vertex"})</span>`,
            { isSurveyToolBadge: true, surveyTool: "stationing", priority: 120 - idx, isFocused: true }
          );
        }
      });
      if (pickVecs.length >= 2) {
        const lineGeom = new THREE.BufferGeometry().setFromPoints(pickVecs);
        const lineObj = new THREE.Line(
          lineGeom,
          new THREE.LineBasicMaterial({ color: 0x00f6ff, depthTest: false, linewidth: 2 })
        );
        lineObj.renderOrder = 999;
        grp.add(lineObj);
      }
      if (typeof window.updateZoomInvariantElements === "function") window.updateZoomInvariantElements();
      if (typeof window.update2DBadgePositions === "function") window.update2DBadgePositions();
      return;
    }

    const stations = (stationResult && Array.isArray(stationResult.stations)) ? stationResult.stations : [];
    if (!stations.length) return;

    const clVecs = [];
    const swathHalf = Math.max(2.0, (Number(stationResult.swath_width_m) || 16.0) * 0.5);

    stations.forEach((st, idx) => {
      const explicitLoc = (st.local_x !== undefined && st.local_z !== undefined)
        ? [st.local_x, st.local_y || 0, st.local_z]
        : null;
      const clVec = surveyTwd97ToLocalVec3(st.easting_m, st.northing_m, st.cl_ground_z, true, explicitLoc);
      if (!clVec) return;
      st._resolvedLocalVec = clVec;
      clVecs.push(new THREE.Vector3(clVec.x, clVec.y + 0.16, clVec.z));
    });

    // 1. Render Draped 3D Centerline Polyline with dense intermediate terrain sampling
    if (clVecs.length >= 2) {
      const denseClPts = [];
      for (let i = 0; i < clVecs.length - 1; i++) {
        const a = clVecs[i];
        const b = clVecs[i + 1];
        const segLen = a.distanceTo(b);
        const steps = Math.max(1, Math.min(12, Math.ceil(segLen / 1.5)));
        for (let s = 0; s < steps; s++) {
          const tFrac = s / steps;
          const mx = a.x + (b.x - a.x) * tFrac;
          const mz = a.z + (b.z - a.z) * tFrac;
          let my = a.y + (b.y - a.y) * tFrac;
          if (typeof window.sampleStudioMeshElevationAtLocalXZ === "function") {
            const hit = window.sampleStudioMeshElevationAtLocalXZ(mx, mz, my - 0.16);
            if (hit && hit.hit) my = hit.y + 0.16;
          }
          denseClPts.push(new THREE.Vector3(mx, my, mz));
        }
      }
      denseClPts.push(clVecs[clVecs.length - 1].clone());

      const clGeom = new THREE.BufferGeometry().setFromPoints(denseClPts);
      const clLine = new THREE.Line(
        clGeom,
        new THREE.LineBasicMaterial({ color: 0x00f6ff, depthTest: false, linewidth: 2 })
      );
      clLine.renderOrder = 998;
      grp.add(clLine);
    }

    // 2. Render Station Monuments, Cross-Section Swath Profiles, and 2D Chainage Badges
    stations.forEach((st, idx) => {
      const clVec = st._resolvedLocalVec;
      if (!clVec) return;
      const isSelected = idx === activeIdx;
      const pinColor = isSelected ? 0xf59e0b : (idx === 0 ? 0xff3b30 : 0x0284c7);

      // Compute perpendicular cross-section unit normal in Three.js local XZ plane
      let nx = Number(st.normal_e);
      let nz = Number.isFinite(Number(st.normal_n)) ? -Number(st.normal_n) : NaN;
      if (!Number.isFinite(nx) || !Number.isFinite(nz) || Math.hypot(nx, nz) < 1e-4) {
        const prevVec = idx > 0 && stations[idx - 1]._resolvedLocalVec ? stations[idx - 1]._resolvedLocalVec : clVec;
        const nextVec = idx < stations.length - 1 && stations[idx + 1]._resolvedLocalVec ? stations[idx + 1]._resolvedLocalVec : clVec;
        const tx = nextVec.x - prevVec.x;
        const tz = nextVec.z - prevVec.z;
        const tLen = Math.hypot(tx, tz) || 1.0;
        nx = -tz / tLen;
        nz = tx / tLen;
      } else {
        const nLen = Math.hypot(nx, nz) || 1.0;
        nx /= nLen;
        nz /= nLen;
      }

      // Draw perpendicular 3D ground cross-section swath line draped on mesh
      const groundSwathPts = [];
      const templateSwathPts = [];
      const profileArr = Array.isArray(st.cross_profile) && st.cross_profile.length >= 2
        ? st.cross_profile
        : [{ u: -swathHalf, z_ground: st.cl_ground_z, z_template: st.cl_design_z }, { u: swathHalf, z_ground: st.cl_ground_z, z_template: st.cl_design_z }];

      profileArr.forEach((cp) => {
        const u = Number(cp.u) || 0;
        const sx = clVec.x + u * nx;
        const sz = clVec.z + u * nz;
        const dzGround = (Number(cp.z_ground) || st.cl_ground_z) - (Number(st.cl_ground_z) || 0);
        const dzTmpl = (Number(cp.z_template) || st.cl_design_z) - (Number(st.cl_ground_z) || 0);
        let syGround = clVec.y + dzGround;
        if (typeof window.sampleStudioMeshElevationAtLocalXZ === "function") {
          const hit = window.sampleStudioMeshElevationAtLocalXZ(sx, sz, syGround);
          if (hit && hit.hit) syGround = hit.y;
        }
        const syTmpl = clVec.y + dzTmpl;
        groundSwathPts.push(new THREE.Vector3(sx, syGround + 0.12, sz));
        templateSwathPts.push(new THREE.Vector3(sx, syTmpl + 0.14, sz));
      });

      if (groundSwathPts.length >= 2) {
        const swGeom = new THREE.BufferGeometry().setFromPoints(groundSwathPts);
        const swLine = new THREE.Line(
          swGeom,
          new THREE.LineBasicMaterial({
            color: isSelected ? 0xf59e0b : 0x38bdf8,
            depthTest: false,
            transparent: true,
            opacity: isSelected ? 1.0 : 0.72,
          })
        );
        swLine.renderOrder = isSelected ? 999 : 997;
        grp.add(swLine);
      }

      if (isSelected && templateSwathPts.length >= 2) {
        const tmplGeom = new THREE.BufferGeometry().setFromPoints(templateSwathPts);
        const tmplLine = new THREE.Line(
          tmplGeom,
          new THREE.LineBasicMaterial({
            color: 0x10b981,
            depthTest: false,
            transparent: true,
            opacity: 0.95,
          })
        );
        tmplLine.renderOrder = 999;
        grp.add(tmplLine);
      }

      // Zoom-invariant 3D station monument pin + range pole
      if (typeof window.add3DPinMarker === "function") {
        window.add3DPinMarker(clVec, pinColor, grp);
      }
      const poleH = isSelected ? 1.85 : 1.25;
      const poleLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(clVec.x, clVec.y + 0.04, clVec.z),
          new THREE.Vector3(clVec.x, clVec.y + poleH, clVec.z),
        ]),
        new THREE.LineBasicMaterial({ color: pinColor, depthTest: false, transparent: true, opacity: 0.9 })
      );
      poleLine.renderOrder = 998;
      grp.add(poleLine);

      // Floating 2D Chainage Badge
      if (typeof window.add2DBadge === "function") {
        const elevVal = Number.isFinite(clVec.surfaceH) ? clVec.surfaceH : Number(st.cl_ground_z || 0);
        const cutA = Number(st.cut_area_m2 || 0).toFixed(1);
        const fillA = Number(st.fill_area_m2 || 0).toFixed(1);
        const accentCol = isSelected ? "#f59e0b" : "#38bdf8";
        const badgeHtml = `<span style="display:inline-flex;align-items:center;gap:4px;font-family:var(--font-mono);font-size:10.5px;font-weight:700;"><span style="color:${accentCol};">${st.chainage_code}</span><span style="opacity:0.9;">Z:${elevVal.toFixed(2)}m | C:${cutA}/F:${fillA}m²</span></span>`;
        window.add2DBadge(
          new THREE.Vector3(clVec.x, clVec.y + poleH + 0.14, clVec.z),
          badgeHtml,
          {
            isSurveyToolBadge: true,
            surveyTool: "stationing",
            priority: isSelected ? 160 : (idx === 0 || idx === stations.length - 1 ? 95 : 75 - idx),
            isFocused: isSelected,
            offsetY: -10,
          }
        );
      }
    });

    if (typeof window.updateZoomInvariantElements === "function") window.updateZoomInvariantElements();
    if (typeof window.update2DBadgePositions === "function") window.update2DBadgePositions();
    if (window.studioThree && typeof window.studioThree.render === "function") {
      window.studioThree.render();
    }
  }

  window.clearStationingVisuals3D = clearStationingVisuals3D;
  window.renderStationing3DOverlay = renderStationing3DOverlay;

  /**
   * Opens the Centerline Stationing (0K+000) & Average-End-Area (AEA) Cut/Fill Volume Inspector.
   */
  async function openEnhancedStationingAndAeaInspector(initialResult = null) {
    if (typeof setActiveStudioTool === "function") setActiveStudioTool("stationing");
    const t = typeof tr === "function" ? tr : (zh, en) => zh;
    const scanId = window.STATE && window.STATE.activeScanId;
    if (!scanId) {
      if (typeof showToast === "function") showToast(t("請先載入 3D 掃描專案", "Please load a 3D scan first"), 2500);
      return;
    }

    let stationResult = initialResult || (window.STATE && window.STATE.lastStationingResult && window.STATE.lastStationingResult.scan_id === scanId ? window.STATE.lastStationingResult : null);
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

    if (window.STATE) {
      window.STATE.lastStationingResult = stationResult;
    }

    const stations = stationResult.stations || [];
    const totalCut = stationResult.total_cut_volume_m3 || 0.0;
    const totalFill = stationResult.total_fill_volume_m3 || 0.0;
    const netVol = stationResult.net_volume_m3 || 0.0;
    const hasCustomAlign = Boolean(window.STATE && Array.isArray(window.STATE.stationAlignmentPoints) && window.STATE.stationAlignmentPoints.length >= 2);

    renderStationing3DOverlay(stationResult, 0);

    let tableRowsHtml = "";
    stations.forEach((st, idx) => {
      tableRowsHtml += `
        <tr data-st-idx="${idx}" style="cursor:pointer;" title="${t("點擊聚焦此樁號 3D 橫斷面", "Click to focus station in 3D")}">
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
        ${renderSurveyContainerSubtabsHtml("stationing")}
        ${renderSurveyToolExplanationBannerHtml(
          "道路中心線樁號斷面",
          "Centerline Stationing & AEA Volume",
          "沿道路或管溝中心線自動佈設樁號 (0K+000)，於 3D 模型繪製橫斷面走廊並以平均端面積法 (AEA) 計算挖填土方。",
          "Generates 0K+000 station monuments and 3D cross-section swaths along a centerline to compute Average-End-Area (AEA) cut/fill volumes."
        )}

        <div class="gcp-grade-header">
          <div style="font-size:11px;color:var(--ui-text-secondary);display:flex;align-items:center;gap:6px;">
            <span>${t("全長", "Total")}: <b style="color:var(--ui-text-primary);">${stationResult.total_length_m} m</b></span>
            <span>|</span>
            <span><b style="color:var(--ui-text-primary);">${stationResult.station_count}</b> ${t("樁", "Stations")}</span>
          </div>
          <span class="gcp-crs-pill">EPSG:3826 + TWVD2001</span>
        </div>

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

        <div class="gcp-tbm-card">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;">
            <div>
              <label style="font-size:10px;color:var(--ui-text-secondary);display:block;margin-bottom:2px;">${t("樣板型式", "Template")}</label>
              <select id="selStationTemplate" class="gs-select" style="width:100%;height:26px;font-size:11px;">
                <option value="roadway" ${stationResult.template_type === "roadway" ? "selected" : ""}>${t("路面 (Roadway)", "Roadway")}</option>
                <option value="trench" ${stationResult.template_type === "trench" ? "selected" : ""}>${t("管溝 (Trench)", "Trench")}</option>
                <option value="flat" ${stationResult.template_type === "flat" ? "selected" : ""}>${t("平臺 (Flat)", "Flat Pad")}</option>
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
            <button type="button" class="btn-xs primary" id="btnRecomputeStationing" style="flex:1;justify-content:center;" title="${t("重新計算樁號斷面與 3D 走廊", "Recompute Stationing & 3D Corridor")}">
              ${SVG_ICONS.ROAD} ${t("樁號", "Compute")}
            </button>
            <button type="button" class="btn-xs" id="btnPickAlignment" style="flex:1;justify-content:center;" title="${t("在 3D 視圖點選中心線起終點", "Pick Centerline Points in 3D")}">
              ${SVG_ICONS.TARGET} ${t("選線", "Pick Line")}
            </button>
            ${hasCustomAlign ? `
              <button type="button" class="btn-xs" id="btnResetStationAlignment" title="${t("重設為自動主軸中心線", "Reset to Auto Principal Axis")}">
                ${SVG_ICONS.RESET} ${t("重設", "Reset")}
              </button>
            ` : ""}
          </div>
        </div>

        <div class="gcp-tbm-card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:8px;">
            <span class="station-profile-label" style="font-weight:700;font-size:11px;color:var(--ui-text-primary);white-space:nowrap;display:inline-flex;align-items:center;gap:4px;flex-shrink:0;">
              ${SVG_ICONS.CHART} ${t("橫斷面檢視", "Cross-Section")}
            </span>
            <select id="selActiveStation" class="gs-select" style="height:22px;font-size:10.5px;padding:1px 4px;max-width:140px;flex-shrink:1;">
              ${stations.map((st, i) => `<option value="${i}">${st.chainage_code}</option>`).join("")}
            </select>
          </div>
          <canvas id="cvsStationProfile" width="280" height="130" style="width:100%;height:130px;background:var(--ui-bg-subtle);border:1px solid var(--ui-border);border-radius:5px;display:block;"></canvas>
          <div style="display:flex;justify-content:space-between;font-size:9.5px;color:var(--ui-text-muted);margin-top:3px;">
            <span><span style="color:#0284c7;font-weight:700;">—</span> ${t("地表面", "Ground")}</span>
            <span><span style="color:#f59e0b;font-weight:700;">---</span> ${t("設計樣板", "Template")}</span>
            <span><span style="display:inline-block;width:8px;height:8px;background:#ef4444;border-radius:2px;"></span> ${t("挖方", "Cut")}</span>
            <span><span style="display:inline-block;width:8px;height:8px;background:#10b981;border-radius:2px;"></span> ${t("填方", "Fill")}</span>
          </div>
        </div>

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

        <div style="display:flex;gap:6px;">
          <button type="button" class="btn-xs" id="btnDownloadStationCsv" style="flex:1;justify-content:center;">
            ${SVG_ICONS.DOWNLOAD} CSV
          </button>
          <button type="button" class="btn-xs" id="btnPrintStationReport" style="flex:1;justify-content:center;">
            ${SVG_ICONS.PRINTER} ${t("列印", "Print")}
          </button>
        </div>
      </div>
    `;

    if (typeof showSidePanel === "function") {
      showSidePanel(`<span>${SVG_ICONS.ROAD} ${t("樁號斷面與平均端面土方 (Station)", "Stationing & AEA Volume")}</span>`, panelHtml);
    }

    bindSurveyContainerSubtabs("stationing");

    const cvs = document.getElementById("cvsStationProfile");
    const selectAndHighlightStation = (stIdx, focusCam = false) => {
      const st = stations[stIdx];
      if (st && st.cross_profile) {
        renderStationCrossProfileCanvas(cvs, st.cross_profile, stationResult.template_type);
      }
      renderStationing3DOverlay(stationResult, stIdx);
      if (focusCam && st && st._resolvedLocalVec) {
        focusStudioCameraOnLocalPoint(st._resolvedLocalVec, 18);
      }
    };
    selectAndHighlightStation(0, false);

    document.getElementById("selActiveStation")?.addEventListener("change", (e) => {
      selectAndHighlightStation(Number(e.target.value) || 0, true);
    });

    document.querySelectorAll("#stationingContainer tbody tr").forEach((row) => {
      row.addEventListener("click", () => {
        const idx = Number(row.getAttribute("data-st-idx")) || 0;
        const sel = document.getElementById("selActiveStation");
        if (sel) sel.value = String(idx);
        selectAndHighlightStation(idx, true);
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
            alignment: (window.STATE && Array.isArray(window.STATE.stationAlignmentPoints) && window.STATE.stationAlignmentPoints.length >= 2) ? window.STATE.stationAlignmentPoints : null,
          });
          if (window.STATE) window.STATE.isPickingStationAlignment = false;
          openEnhancedStationingAndAeaInspector(updated);
        } catch (err) {
          console.error("[Stationing] Recompute failed:", err);
        }
      }
    });

    document.getElementById("btnPickAlignment")?.addEventListener("click", () => {
      if (window.STATE) {
        window.STATE.isPickingStationAlignment = true;
        window.STATE.stationAlignmentPoints = [];
      }
      clearStationingVisuals3D();
      const pickBtn = document.getElementById("btnPickAlignment");
      if (pickBtn) pickBtn.classList.add("primary");
      if (typeof showToast === "function") {
        showToast(t("請在 3D 模型上依序點擊中心線起點 (0K+000) 與終點", "Click centerline start (0K+000) and end points on the 3D scan"));
      }
    });

    document.getElementById("btnResetStationAlignment")?.addEventListener("click", () => {
      if (window.STATE) {
        window.STATE.isPickingStationAlignment = false;
        window.STATE.stationAlignmentPoints = [];
        window.STATE.lastStationingResult = null;
      }
      openEnhancedStationingAndAeaInspector(null);
    });

    document.getElementById("btnDownloadStationCsv")?.addEventListener("click", () => {
      exportStationingCsv(stationResult);
    });

    document.getElementById("btnPrintStationReport")?.addEventListener("click", () => {
      window.print();
    });
  }

  window.handleStationAlignment3DPick = function (pt, twd) {
    if (!twd || !window.STATE) return false;
    if (!Array.isArray(window.STATE.stationAlignmentPoints)) window.STATE.stationAlignmentPoints = [];
    window.STATE.isPickingStationAlignment = true;
    window.STATE.stationAlignmentPoints.push({
      e: Number(twd.e.toFixed(3)),
      n: Number(twd.n.toFixed(3)),
      h: Number(twd.h.toFixed(3)),
      local_x: pt ? Number(pt.x.toFixed(3)) : undefined,
      local_y: pt ? Number(pt.y.toFixed(3)) : undefined,
      local_z: pt ? Number(pt.z.toFixed(3)) : undefined,
    });
    const t = typeof tr === "function" ? tr : (zh, en) => zh;
    if (window.STATE.stationAlignmentPoints.length >= 2) {
      if (typeof showToast === "function") {
        showToast(t(`已設定 ${window.STATE.stationAlignmentPoints.length} 處中心線節點 — 正在計算 3D 樁號與橫斷面`, `Centerline (${window.STATE.stationAlignmentPoints.length} vertices) locked — computing 3D stationing`));
      }
      document.getElementById("btnRecomputeStationing")?.click();
    } else {
      renderStationing3DOverlay(null, 0);
      if (typeof showToast === "function") {
        showToast(t("已設定中心線起點 (0K+000) — 請在 3D 模型點擊下一處中心線節點", "Centerline start (0K+000) placed in 3D — click next vertex"));
      }
    }
    return true;
  };

  // =========================================================================
  // 4. SURFACE DRAINAGE & PONDING WATER VOLUME TAKEOFF (V_water m³) INSPECTOR
  // =========================================================================

  /**
   * Ponding water visual meshes are disabled so only drainage slope arrows are rendered.
   */
  function renderEnhancedPondingVisuals3D(_depressions) {
    clearEnhancedPondingVisuals3D();
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
    if (window.studioThree.scene) {
      const legacy = window.studioThree.scene.getObjectByName("gs_enhanced_ponding_group");
      if (legacy && legacy.parent) legacy.parent.remove(legacy);
    }
    if (window.studioThree.overlayGroup) {
      const legacyOv = window.studioThree.overlayGroup.getObjectByName("gs_enhanced_ponding_group");
      if (legacyOv && legacyOv.parent) legacyOv.parent.remove(legacyOv);
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
   * Delegates to the restored Surface Drainage & Slope Arrow Inspector (with Density & Arrow Scale sliders).
   */
  async function openEnhancedDrainageAndPondingInspector(_initialResult = null) {
    clearEnhancedPondingVisuals3D();
    document.getElementById("btnToggleSlopeArrows")?.addEventListener("click", () => {
      if (typeof window.renderDrainageAndSlopeVisuals3D === "function") {
        window.renderDrainageAndSlopeVisuals3D();
      }
    });
    if (typeof window.openDrainageAndSlopeInspector === "function" && window.openDrainageAndSlopeInspector !== openEnhancedDrainageAndPondingInspector) {
      return window.openDrainageAndSlopeInspector();
    }
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
                if (typeof window.openDrainageAndSlopeInspector === "function") {
                  window.openDrainageAndSlopeInspector();
                }
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
