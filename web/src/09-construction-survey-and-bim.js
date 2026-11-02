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

  function resetSurveyPickingStates() {
    if (window.STATE) {
      window.STATE.isPickingStationAlignment = false;
      window.STATE.isPickingGcpPoint = false;
      window.STATE.stakeoutPickActive = false;
    }
  }

  function bindSurveyContainerSubtabs(activeTab) {
    document.getElementById("subtabStakeout")?.addEventListener("click", () => {
      if (activeTab !== "stakeout") {
        resetSurveyPickingStates();
        if (typeof window.openRtkStakeoutInspector === "function") window.openRtkStakeoutInspector();
      }
    });
    document.getElementById("subtabStationing")?.addEventListener("click", () => {
      if (activeTab !== "stationing") {
        resetSurveyPickingStates();
        openEnhancedStationingAndAeaInspector();
      }
    });
    document.getElementById("subtabGcpQa")?.addEventListener("click", () => {
      if (activeTab !== "gcp_qa") {
        resetSurveyPickingStates();
        openEnhancedGcpAccuracyQaInspector();
      }
    });
    document.getElementById("subtabContours")?.addEventListener("click", () => {
      if (activeTab !== "contours") {
        resetSurveyPickingStates();
        if (typeof setActiveStudioTool === "function") setActiveStudioTool("contours");
        if (typeof window.openContoursInspector === "function") window.openContoursInspector();
      }
    });
  }

  let _cachedGroundRefScanId = null;
  let _cachedGroundRefHasIdx = false;
  let _cachedGroundRefY = 0;

  function getScanGroundReferenceLocalY() {
    const scanId = (window.STATE && window.STATE.activeScanId) || "";
    const hasFastIdx = Boolean(window.studioThree && window.studioThree._laserSpatialIndex);
    if (_cachedGroundRefScanId === scanId && _cachedGroundRefHasIdx === hasFastIdx && Number.isFinite(_cachedGroundRefY)) {
      return _cachedGroundRefY;
    }
    if (!hasFastIdx || typeof window.sampleStudioMeshElevationAtLocalXZ !== "function") {
      _cachedGroundRefScanId = scanId;
      _cachedGroundRefHasIdx = false;
      _cachedGroundRefY = 0;
      return 0;
    }
    const r = Math.min(28, Math.max(8, (Number(window.studioThree?.boundingSphere?.radius) || 35) * 0.45));
    const ys = [];
    for (let ix = -2; ix <= 2; ix++) {
      for (let iz = -2; iz <= 2; iz++) {
        const hit = window.sampleStudioMeshElevationAtLocalXZ((ix * r) / 2, (iz * r) / 2, 0);
        if (hit && hit.hit && Number.isFinite(hit.y)) ys.push(hit.y);
      }
    }
    _cachedGroundRefScanId = scanId;
    _cachedGroundRefHasIdx = hasFastIdx;
    if (ys.length >= 3) {
      ys.sort((a, b) => a - b);
      _cachedGroundRefY = ys[Math.floor(ys.length * 0.25)];
      return _cachedGroundRefY;
    }
    _cachedGroundRefY = 0;
    return 0;
  }

  /**
   * Samples the 3D mesh elevation at (lx, lz) while rejecting overhanging tree canopy spikes.
   * Uses O(1) spatial grid when available; avoids unindexed brute-force multi-ray loops on large scans.
   */
  function sampleBareGroundMeshY(lx, lz, expectedGroundY = null, maxCanopyJump = 1.15) {
    const baseRefY = getScanGroundReferenceLocalY();
    const refY =
      Number.isFinite(expectedGroundY) && Math.abs(expectedGroundY - baseRefY) < 12.0
        ? expectedGroundY
        : baseRefY;
    const hasFastIdx = Boolean(window.studioThree && window.studioThree._laserSpatialIndex);
    if (!hasFastIdx || typeof window.sampleStudioMeshElevationAtLocalXZ !== "function") {
      return { y: refY, hit: false };
    }
    const sHit = window.sampleStudioMeshElevationAtLocalXZ(lx, lz, refY);
    if (!sHit || !sHit.hit || !Number.isFinite(sHit.y)) {
      return { y: refY, hit: false };
    }
    if (sHit.y <= refY + maxCanopyJump) {
      return { y: sHit.y, hit: true };
    }
    // Ray hit a tall canopy/obstacle above ground — search nearby bare ground within 1.5m..4.5m in O(1) grid
    let minNearY = sHit.y;
    const probeRadii = [1.5, 3.0, 4.5];
    for (let ir = 0; ir < probeRadii.length; ir++) {
      const pr = probeRadii[ir];
      for (let ia = 0; ia < 8; ia++) {
        const ang = (ia * Math.PI) / 4;
        const nh = window.sampleStudioMeshElevationAtLocalXZ(lx + pr * Math.cos(ang), lz + pr * Math.sin(ang), refY);
        if (nh && nh.hit && Number.isFinite(nh.y) && nh.y < minNearY) {
          minNearY = nh.y;
        }
      }
      if (minNearY <= refY + maxCanopyJump) {
        return { y: minNearY, hit: true };
      }
    }
    return { y: Math.min(minNearY, refY + 0.35), hit: true };
  }

  /**
   * Exact inverse of localToTwd97 with canopy-safe 3D mesh surface draping.
   * Resolves TWD97 (Easting, Northing, TWVD2001 Elevation) into Three.js local coordinates (x, y, z)
   * and drapes onto the bare-ground 3D scan mesh so markers never float on tree crowns or sink out of view.
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
    const hasFastIdx = Boolean(window.studioThree && window.studioThree._laserSpatialIndex);
    if (hasFastIdx && typeof window.sampleStudioMeshElevationAtLocalXZ === "function") {
      let sHit = sampleBareGroundMeshY(lx, lz, ly, 1.2);
      if ((!sHit || !sHit.hit) && hasExplicit && Math.hypot(lx - expX, lz - expZ) > 0.25) {
        const altHit = sampleBareGroundMeshY(expX, expZ, Number.isFinite(expY) ? expY : ly, 1.2);
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
  window.sampleBareGroundMeshY = sampleBareGroundMeshY;
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
    if (window.STATE && window.STATE.activeTool === "gcp_qa" && !window.STATE.isPickingGcpPoint) return;
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
            ${t(`${esc(grade)} 級`, `Grade ${esc(grade)}`)} (${rmse3dCm} cm)
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
            <span>${t("檢核點座標表 (開啟「加點」可點選 3D 模型)", "Check Points CSV (click Pick to sample 3D model)")}</span>
          </label>
          <textarea class="gs-input" id="txtGcpCsvInput" rows="3" placeholder="Point, E, N, H, [TBM]" style="font-family:var(--font-mono);font-size:10.5px;padding:5px 7px;">${esc(csvDefault)}</textarea>
        </div>

        <div style="display:flex;gap:6px;">
          <button type="button" class="btn-xs primary" id="btnComputeGcpQa" style="flex:1;justify-content:center;" title="${t("計算 3D 空間精度與殘差", "Compute 3D Spatial Accuracy & Residuals")}">
            ${SVG_ICONS.CALC} ${t("檢核", "Check")}
          </button>
          <button type="button" class="btn-xs ${window.STATE && window.STATE.isPickingGcpPoint ? "primary" : ""}" id="btnPickGcpPoint" title="${t("於 3D 模型點選新增檢核點", "Pick a Check Point on the 3D scan")}">
            ${SVG_ICONS.TARGET} ${t("加點", "Pick")}
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
      if (window.STATE) window.STATE.isPickingGcpPoint = false;
      const txt = document.getElementById("txtGcpCsvInput")?.value || "";
      const parsed = parseEnhancedGcpCsvInput(txt);
      runEnhancedGcpAccuracyQaEvaluation(parsed);
    });

    document.getElementById("btnPickGcpPoint")?.addEventListener("click", () => {
      if (!window.STATE) return;
      window.STATE.isPickingGcpPoint = !window.STATE.isPickingGcpPoint;
      const btn = document.getElementById("btnPickGcpPoint");
      if (btn) btn.classList.toggle("primary", Boolean(window.STATE.isPickingGcpPoint));
      if (typeof showToast === "function") {
        showToast(
          window.STATE.isPickingGcpPoint
            ? t("請在 3D 模型表面點擊以新增檢核點", "Click on the 3D surface to add a Check Point")
            : t("已關閉 3D 檢核點點選模式", "3D Check Point picking disabled")
        );
      }
    });

    document.getElementById("btnLoadSampleGcpPoints")?.addEventListener("click", () => {
      if (window.STATE) window.STATE.isPickingGcpPoint = false;
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

    stations.forEach((st) => {
      if (st._resolvedLocalVec && Number.isFinite(st._resolvedLocalVec.x)) {
        clVecs.push(new THREE.Vector3(st._resolvedLocalVec.x, st._resolvedLocalVec.y + 0.16, st._resolvedLocalVec.z));
        return;
      }
      const explicitLoc = (st.local_x !== undefined && st.local_z !== undefined)
        ? [st.local_x, st.local_y || 0, st.local_z]
        : null;
      const clVec = surveyTwd97ToLocalVec3(st.easting_m, st.northing_m, st.cl_ground_z, true, explicitLoc);
      if (!clVec) return;
      st._resolvedLocalVec = clVec;
      clVecs.push(new THREE.Vector3(clVec.x, clVec.y + 0.16, clVec.z));
    });

    // Establish corridor bare-ground local Y reference so overhanging roadside trees never cause vertical spikes
    const sortedClYs = stations
      .map((s) => s._resolvedLocalVec?.y)
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    const corridorGroundRefY = sortedClYs.length > 0
      ? sortedClYs[Math.floor(sortedClYs.length * 0.3)]
      : getScanGroundReferenceLocalY();

    stations.forEach((st, idx) => {
      const v = st._resolvedLocalVec;
      if (v && v.y > corridorGroundRefY + 0.85) {
        const diffY = v.y - corridorGroundRefY;
        v.y = corridorGroundRefY;
        if (Number.isFinite(v.surfaceH)) v.surfaceH = Number((v.surfaceH - diffY).toFixed(3));
        if (clVecs[idx]) clVecs[idx].y = v.y + 0.16;
      }
    });

    // 1. Render Draped 3D Centerline Polyline with cached canopy-safe intermediate terrain sampling
    if (clVecs.length >= 2) {
      let denseClPts = Array.isArray(stationResult._cachedDenseClPts) ? stationResult._cachedDenseClPts : null;
      if (!denseClPts || !denseClPts.length) {
        denseClPts = [];
        const hasFastIdx = Boolean(window.studioThree && window.studioThree._laserSpatialIndex);
        for (let i = 0; i < clVecs.length - 1; i++) {
          const a = clVecs[i];
          const b = clVecs[i + 1];
          const segLen = a.distanceTo(b);
          const steps = Math.max(1, Math.min(8, Math.ceil(segLen / 2.0)));
          for (let s = 0; s < steps; s++) {
            const tFrac = s / steps;
            const mx = a.x + (b.x - a.x) * tFrac;
            const mz = a.z + (b.z - a.z) * tFrac;
            const chordGroundY = (a.y - 0.16) + ((b.y - 0.16) - (a.y - 0.16)) * tFrac;
            const gHit = hasFastIdx ? sampleBareGroundMeshY(mx, mz, chordGroundY, 0.75) : null;
            const my = (gHit && gHit.hit ? Math.min(gHit.y, chordGroundY + 0.65) : chordGroundY) + 0.16;
            denseClPts.push(new THREE.Vector3(mx, my, mz));
          }
        }
        denseClPts.push(clVecs[clVecs.length - 1].clone());
        stationResult._cachedDenseClPts = denseClPts;
      }

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

      // Draw perpendicular 3D ground cross-section swath line draped on bare-ground DSM profile
      let groundSwathPts = st._cachedGroundSwathPts;
      let templateSwathPts = st._cachedTemplateSwathPts;
      if (!groundSwathPts || !templateSwathPts) {
        groundSwathPts = [];
        templateSwathPts = [];
        const profileArr = Array.isArray(st.cross_profile) && st.cross_profile.length >= 2
          ? st.cross_profile
          : [{ u: -swathHalf, z_ground: st.cl_ground_z, z_template: st.cl_design_z }, { u: swathHalf, z_ground: st.cl_ground_z, z_template: st.cl_design_z }];

        profileArr.forEach((cp) => {
          const u = Number(cp.u) || 0;
          const sx = clVec.x + u * nx;
          const sz = clVec.z + u * nz;
          const rawDzGround = (Number(cp.z_ground) || st.cl_ground_z) - (Number(st.cl_ground_z) || 0);
          const dzGround = Math.max(-2.5, Math.min(0.85, rawDzGround));
          const rawDzTmpl = (Number(cp.z_template) || st.cl_design_z) - (Number(st.cl_ground_z) || 0);
          const dzTmpl = Math.max(-3.0, Math.min(1.2, rawDzTmpl));
          const syGround = clVec.y + dzGround;
          const syTmpl = clVec.y + dzTmpl;
          groundSwathPts.push(new THREE.Vector3(sx, syGround + 0.12, sz));
          templateSwathPts.push(new THREE.Vector3(sx, syTmpl + 0.14, sz));
        });
        st._cachedGroundSwathPts = groundSwathPts;
        st._cachedTemplateSwathPts = templateSwathPts;
      }

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
    const curWidthM = Number(stationResult.width_m || stationResult.road_width_m || 7.0);

    let tableRowsHtml = "";
    stations.forEach((st, idx) => {
      tableRowsHtml += `
        <tr data-st-idx="${idx}" style="cursor:pointer;" title="${t("點擊聚焦此樁號 3D 橫斷面", "Click to focus station in 3D")}">
          <td style="font-weight:700;color:var(--ui-accent);">${st.chainage_code || ""}</td>
          <td>${Number(st.cut_area_m2 || 0).toFixed(1)}</td>
          <td>${Number(st.fill_area_m2 || 0).toFixed(1)}</td>
          <td>${Number(st.segment_cut_vol_m3 || 0).toFixed(1)}</td>
          <td>${Number(st.segment_fill_vol_m3 || 0).toFixed(1)}</td>
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
              <input type="number" id="txtStationWidth" class="gs-input" value="${curWidthM.toFixed(1)}" step="0.5" style="width:100%;height:26px;font-size:11px;padding:3px 6px;" />
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
            <button type="button" class="btn-xs ${window.STATE && window.STATE.isPickingStationAlignment ? "primary" : ""}" id="btnPickAlignment" style="flex:1;justify-content:center;" title="${t("在 3D 視圖點選中心線起終點", "Pick Centerline Points in 3D")}">
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
            bed_width: widthVal,
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
      if (!window.STATE) return;
      if (window.STATE.isPickingStationAlignment) {
        window.STATE.isPickingStationAlignment = false;
        const pickBtn = document.getElementById("btnPickAlignment");
        if (pickBtn) pickBtn.classList.remove("primary");
        renderStationing3DOverlay(stationResult, Number(document.getElementById("selActiveStation")?.value) || 0);
        return;
      }
      window.STATE.isPickingStationAlignment = true;
      window.STATE.stationAlignmentPoints = [];
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

  // =========================================================================
  // 5. CURVED / BENT EXTRUDED SPLINE SURFACE QA ENGINE (4TH FLATNESS MODE)
  // =========================================================================

  function cVecNorm(v) {
    const len = Math.hypot(v.x, v.y, v.z) || 1.0;
    return { x: v.x / len, y: v.y / len, z: v.z / len };
  }

  function cVecCross(a, b) {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    };
  }

  function cVecDot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }

  /**
   * Algebraic Kasa circle fit followed by Huber-weighted Gauss-Newton orthogonal refinement in 2D profile coordinates (u, v).
   * Fits (u - a)^2 + (v - b)^2 = R^2.
   */
  function fit2DCircleAlgebraicAndRefine(pts2D, opts = {}) {
    const n = Array.isArray(pts2D) ? pts2D.length : 0;
    const forceArc = Boolean(opts.forceArc);
    const manualR = Number(opts.manualRadiusM);
    const hasManualR = Number.isFinite(manualR) && manualR >= 0.12 && manualR <= 5000.0;
    if (n < 3 && !hasManualR) {
      return { isValidArc: forceArc, centerU: 0, centerV: 0, radiusM: forceArc ? 25.0 : 9999.0, rmsResidualM: 0, sagittaM: 0 };
    }

    let meanU = 0, meanV = 0, wSum = 0;
    for (let i = 0; i < n; i++) {
      const w = Number.isFinite(pts2D[i].w) && pts2D[i].w > 0 ? pts2D[i].w : 1.0;
      meanU += pts2D[i].u * w;
      meanV += pts2D[i].v * w;
      wSum += w;
    }
    if (wSum <= 1e-12) wSum = 1.0;
    meanU /= wSum;
    meanV /= wSum;

    let suu = 0, suv = 0, svv = 0, su3 = 0, sv3 = 0, suvv = 0, svuu = 0;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < n; i++) {
      const w = Number.isFinite(pts2D[i].w) && pts2D[i].w > 0 ? pts2D[i].w : 1.0;
      const u = pts2D[i].u - meanU;
      const v = pts2D[i].v - meanV;
      if (pts2D[i].u < minU) minU = pts2D[i].u;
      if (pts2D[i].u > maxU) maxU = pts2D[i].u;
      if (pts2D[i].v < minV) minV = pts2D[i].v;
      if (pts2D[i].v > maxV) maxV = pts2D[i].v;
      const u2 = u * u, v2 = v * v;
      suu += w * u2;
      suv += w * u * v;
      svv += w * v2;
      su3 += w * u2 * u;
      sv3 += w * v2 * v;
      suvv += w * u * v2;
      svuu += w * v * u2;
    }

    const det = suu * svv - suv * suv;
    const span = Number.isFinite(maxU - minU) ? Math.hypot(maxU - minU, maxV - minV) : 0;
    let cx = meanU;
    let cy = meanV;
    let R = hasManualR ? manualR : 50.0;

    if (Math.abs(det) >= 1e-11 && span >= 0.05) {
      const rhs1 = 0.5 * (su3 + suvv);
      const rhs2 = 0.5 * (sv3 + svuu);
      const uc = (rhs1 * svv - rhs2 * suv) / det;
      const vc = (suu * rhs2 - suv * rhs1) / det;
      cx = meanU + uc;
      cy = meanV + vc;
      if (!hasManualR) {
        R = Math.sqrt(uc * uc + vc * vc + (suu + svv) / wSum);
      } else {
        const dirLen = Math.hypot(uc, vc);
        const hChord = 0.5 * span;
        const offsetDist = Math.sqrt(Math.max(0.01, R * R - hChord * hChord));
        if (dirLen > 1e-5) {
          cx = meanU + (uc / dirLen) * offsetDist;
          cy = meanV + (vc / dirLen) * offsetDist;
        } else {
          cy = meanV - offsetDist;
        }
      }
    } else {
      if (!forceArc && !hasManualR) {
        return { isValidArc: false, centerU: meanU, centerV: meanV, radiusM: 9999.0, rmsResidualM: 0, sagittaM: 0 };
      }
      R = hasManualR ? manualR : Math.max(2.0, span * 4.0 || 25.0);
      cy = meanV - R;
    }

    if (forceArc && !hasManualR && (!Number.isFinite(R) || R > 1000.0)) {
      const oldSignV = cy <= meanV ? -1 : 1;
      R = Math.min(1000.0, Math.max(0.5, Number.isFinite(R) ? R : 100.0));
      cy = meanV + oldSignV * R;
    }

    // 6 iterations of Huber-weighted Gauss-Newton orthogonal distance refinement
    for (let iter = 0; iter < 6; iter++) {
      if (hasManualR) {
        let j00 = 0, j01 = 0, j11 = 0, g0 = 0, g1 = 0;
        for (let i = 0; i < n; i++) {
          const p = pts2D[i];
          const baseW = Number.isFinite(p.w) && p.w > 0 ? p.w : 1.0;
          const du = p.u - cx;
          const dv = p.v - cy;
          const dist = Math.hypot(du, dv);
          if (dist < 1e-6) continue;
          const res = dist - R;
          const absRes = Math.abs(res);
          const huberW = absRes <= 0.025 ? baseW : baseW * (0.025 / absRes);
          const ju = -du / dist;
          const jv = -dv / dist;
          j00 += huberW * ju * ju;
          j01 += huberW * ju * jv;
          j11 += huberW * jv * jv;
          g0 -= huberW * ju * res;
          g1 -= huberW * jv * res;
        }
        j00 += 1e-5; j11 += 1e-5;
        const d2 = j00 * j11 - j01 * j01;
        if (Math.abs(d2) < 1e-12) break;
        const dCx = (g0 * j11 - j01 * g1) / d2;
        const dCy = (j00 * g1 - j01 * g0) / d2;
        cx += dCx * 0.85;
        cy += dCy * 0.85;
        if (Math.hypot(dCx, dCy) < 1e-5) break;
        continue;
      }
      let j00 = 0, j01 = 0, j02 = 0, j11 = 0, j12 = 0, j22 = 0;
      let g0 = 0, g1 = 0, g2 = 0;
      for (let i = 0; i < n; i++) {
        const p = pts2D[i];
        const baseW = Number.isFinite(p.w) && p.w > 0 ? p.w : 1.0;
        const du = p.u - cx;
        const dv = p.v - cy;
        const dist = Math.hypot(du, dv);
        if (dist < 1e-6) continue;
        const res = dist - R;
        const absRes = Math.abs(res);
        const huberW = absRes <= 0.025 ? baseW : baseW * (0.025 / absRes);
        const ju = -du / dist;
        const jv = -dv / dist;
        const jr = -1.0;
        j00 += huberW * ju * ju;
        j01 += huberW * ju * jv;
        j02 += huberW * ju * jr;
        j11 += huberW * jv * jv;
        j12 += huberW * jv * jr;
        j22 += huberW * jr * jr;
        g0 -= huberW * ju * res;
        g1 -= huberW * jv * res;
        g2 -= huberW * jr * res;
      }
      // Solve 3x3 normal equation with small Levenberg-Marquardt damping
      j00 += 1e-5; j11 += 1e-5; j22 += 1e-5;
      const m01 = j01, m02 = j02, m12 = j12;
      const d =
        j00 * (j11 * j22 - m12 * m12) -
        m01 * (m01 * j22 - m12 * m02) +
        m02 * (m01 * m12 - j11 * m02);
      if (Math.abs(d) < 1e-12) break;
      const dCx = (g0 * (j11 * j22 - m12 * m12) - m01 * (g1 * j22 - m12 * g2) + m02 * (g1 * m12 - j11 * g2)) / d;
      const dCy = (j00 * (g1 * j22 - m12 * g2) - g0 * (m01 * j22 - m02 * m12) + m02 * (m01 * g2 - g1 * m02)) / d;
      const dR = (j00 * (j11 * g2 - g1 * m12) - m01 * (m01 * g2 - g1 * m02) + g0 * (m01 * m12 - j11 * m02)) / d;
      cx += dCx * 0.85;
      cy += dCy * 0.85;
      R = Math.max(0.12, Math.min(forceArc ? 1000.0 : 5000.0, R + dR * 0.85));
      if (Math.hypot(dCx, dCy, dR) < 1e-5) break;
    }

    let sqSum = 0;
    for (let i = 0; i < n; i++) {
      const dist = Math.hypot(pts2D[i].u - cx, pts2D[i].v - cy);
      const err = dist - R;
      sqSum += err * err;
    }
    const rmsResidualM = n > 0 ? Math.sqrt(sqSum / n) : 0;
    const halfChord = 0.5 * span;
    const sagittaM = R > halfChord ? R - Math.sqrt(Math.max(0, R * R - halfChord * halfChord)) : R;
    const isValidArc = forceArc || hasManualR
      ? Number.isFinite(R) && R >= 0.12 && R <= 5000.0
      : Number.isFinite(R) && R >= 0.12 && R <= 250.0 && sagittaM >= 0.005;

    return {
      isValidArc,
      centerU: cx,
      centerV: cy,
      radiusM: Number(R.toFixed(3)),
      rmsResidualM: Number(rmsResidualM.toFixed(4)),
      sagittaM: Number(sagittaM.toFixed(4)),
    };
  }

  /**
   * Evaluates a smooth Centripetal Catmull-Rom 3D spline chain through ctrlPts.
   */
  function evaluateCatmullRomChain3D(ctrlPts, numSamples = 200) {
    const pts = (Array.isArray(ctrlPts) ? ctrlPts : []).map((p) => ({
      x: Number(p.x) || 0,
      y: Number(p.y) || 0,
      z: Number(p.z) || 0,
    }));
    if (pts.length === 0) return [];
    if (pts.length === 1) return [pts[0]];
    if (pts.length === 2) {
      const out = [];
      for (let i = 0; i < numSamples; i++) {
        const f = i / Math.max(1, numSamples - 1);
        out.push({
          x: pts[0].x + (pts[1].x - pts[0].x) * f,
          y: pts[0].y + (pts[1].y - pts[0].y) * f,
          z: pts[0].z + (pts[1].z - pts[0].z) * f,
        });
      }
      return out;
    }

    // Remove consecutive duplicate points
    const clean = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const prev = clean[clean.length - 1];
      if (Math.hypot(pts[i].x - prev.x, pts[i].y - prev.y, pts[i].z - prev.z) > 1e-4) {
        clean.push(pts[i]);
      }
    }
    if (clean.length < 3) return evaluateCatmullRomChain3D(clean, numSamples);

    const p0 = clean[0], p1 = clean[1], p2 = clean[2];
    const pn1 = clean[clean.length - 1], pn2 = clean[clean.length - 2], pn3 = clean[clean.length - 3];
    const ext = [
      { x: 3 * p0.x - 3 * p1.x + p2.x, y: 3 * p0.y - 3 * p1.y + p2.y, z: 3 * p0.z - 3 * p1.z + p2.z },
      ...clean,
      { x: 3 * pn1.x - 3 * pn2.x + pn3.x, y: 3 * pn1.y - 3 * pn2.y + pn3.y, z: 3 * pn1.z - 3 * pn2.z + pn3.z },
    ];

    const nSegs = clean.length - 1;
    const out = [];
    const evalSeg = (P0, P1, P2, P3, u) => {
      const knotGap = (A, B) => Math.max(1e-3, Math.pow(Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z), 0.5));
      const t0 = 0.0;
      const t1 = t0 + knotGap(P0, P1);
      const t2 = t1 + knotGap(P1, P2);
      const t3 = t2 + knotGap(P2, P3);
      const t = t1 + u * (t2 - t1);

      const lerpPt = (A, B, ta, tb) => {
        const denom = tb - ta || 1e-6;
        const wA = (tb - t) / denom;
        const wB = (t - ta) / denom;
        return { x: wA * A.x + wB * B.x, y: wA * A.y + wB * B.y, z: wA * A.z + wB * B.z };
      };
      const A1 = lerpPt(P0, P1, t0, t1);
      const A2 = lerpPt(P1, P2, t1, t2);
      const A3 = lerpPt(P2, P3, t2, t3);
      const B1 = lerpPt(A1, A2, t0, t2);
      const B2 = lerpPt(A2, A3, t1, t3);
      return lerpPt(B1, B2, t1, t2);
    };

    for (let s = 0; s < numSamples; s++) {
      const globalU = (s / Math.max(1, numSamples - 1)) * nSegs;
      const segIdx = Math.min(nSegs - 1, Math.floor(globalU));
      const localU = globalU - segIdx;
      out.push(evalSeg(ext[segIdx], ext[segIdx + 1], ext[segIdx + 2], ext[segIdx + 3], localU));
    }
    return out;
  }

  /**
   * Builds the parametric extruded curved surface evaluator S(s, v) = C(s) + v * wAxis.
   */
  function buildCurvedExtrudedSurfaceEvaluator(config = {}) {
    const rawSplinePts = Array.isArray(config.splinePts) ? config.splinePts : [];
    const pts = rawSplinePts.map((p) => ({
      x: Number(p.x) || 0,
      y: Number(p.y) || 0,
      z: Number(p.z) || 0,
    }));
    const curveType = config.curveType === "arc" ? "arc" : "spline";
    const extrudeDirMode = config.extrudeDirMode || "auto";
    const offsetMode = config.offsetMode === "lock_spline" ? "lock_spline" : "auto_center";
    const normalOffsetM = Number(config.normalOffsetM) || 0.0;
    const manualRadiusM = Number(config.manualRadiusM);
    const hasManualRadius = Number.isFinite(manualRadiusM) && manualRadiusM >= 0.12 && manualRadiusM <= 5000.0;
    let extrudeDepthM = Math.max(0.15, Math.min(30.0, Number(config.extrudeDepthM) || 1.8));
    const extrudeTargetPt = config.extrudeTargetPt
      ? { x: Number(config.extrudeTargetPt.x) || 0, y: Number(config.extrudeTargetPt.y) || 0, z: Number(config.extrudeTargetPt.z) || 0 }
      : null;

    if (pts.length < 2) {
      pts.push({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 4, y: 0, z: 0 });
    }

    const firstPt = pts[0];
    const lastPt = pts[pts.length - 1];
    const chord = { x: lastPt.x - firstPt.x, y: lastPt.y - firstPt.y, z: lastPt.z - firstPt.z };
    const chordUnit = cVecNorm(chord);

    let minY = Infinity, maxY = -Infinity, maxXzDist = 0;
    let midX = 0, midY = 0, midZ = 0;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].y < minY) minY = pts[i].y;
      if (pts[i].y > maxY) maxY = pts[i].y;
      midX += pts[i].x;
      midY += pts[i].y;
      midZ += pts[i].z;
      for (let j = i + 1; j < pts.length; j++) {
        const dXz = Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z);
        if (dXz > maxXzDist) maxXzDist = dXz;
      }
    }
    midX /= pts.length;
    midY /= pts.length;
    midZ /= pts.length;
    const ySpan = maxY - minY;

    // 1. Determine unit extrusion axis wAxis
    let wAxis = { x: 0, y: -1, z: 0 };
    if (config.explicitWAxis && Number.isFinite(config.explicitWAxis.x)) {
      wAxis = cVecNorm(config.explicitWAxis);
    } else if (extrudeDirMode === "down_y") {
      wAxis = { x: 0, y: -1, z: 0 };
    } else if (extrudeDirMode === "up_y") {
      wAxis = { x: 0, y: 1, z: 0 };
    } else if (extrudeDirMode === "lateral") {
      const hLen = Math.hypot(chord.x, chord.z);
      wAxis = hLen > 1e-4 ? { x: -chord.z / hLen, y: 0, z: chord.x / hLen } : { x: 0, y: 0, z: 1 };
      if (extrudeTargetPt) {
        const toE1 = { x: extrudeTargetPt.x - midX, y: extrudeTargetPt.y - midY, z: extrudeTargetPt.z - midZ };
        if (cVecDot(wAxis, toE1) < 0) wAxis = { x: -wAxis.x, y: -wAxis.y, z: -wAxis.z };
      }
    } else if (extrudeDirMode === "custom_e1" && extrudeTargetPt) {
      const toE1 = { x: extrudeTargetPt.x - midX, y: extrudeTargetPt.y - midY, z: extrudeTargetPt.z - midZ };
      const dotT = cVecDot(toE1, chordUnit);
      const perp = { x: toE1.x - dotT * chordUnit.x, y: toE1.y - dotT * chordUnit.y, z: toE1.z - dotT * chordUnit.z };
      const pLen = Math.hypot(perp.x, perp.y, perp.z);
      if (pLen > 0.08) {
        wAxis = { x: perp.x / pLen, y: perp.y / pLen, z: perp.z / pLen };
        if (config.useE1Depth) extrudeDepthM = Math.max(0.2, Math.min(30.0, pLen));
      }
    } else {
      if (extrudeTargetPt && config.useE1Depth) {
        const toE1 = { x: extrudeTargetPt.x - midX, y: extrudeTargetPt.y - midY, z: extrudeTargetPt.z - midZ };
        const dotT = cVecDot(toE1, chordUnit);
        const perp = { x: toE1.x - dotT * chordUnit.x, y: toE1.y - dotT * chordUnit.y, z: toE1.z - dotT * chordUnit.z };
        const pLen = Math.hypot(perp.x, perp.y, perp.z);
        if (pLen > 0.08) {
          wAxis = { x: perp.x / pLen, y: perp.y / pLen, z: perp.z / pLen };
          extrudeDepthM = Math.max(0.2, Math.min(30.0, pLen));
        }
      } else if (ySpan < 0.38 * Math.max(0.4, maxXzDist)) {
        wAxis = { x: 0, y: -1, z: 0 };
      } else {
        const hLen = Math.hypot(chord.x, chord.z);
        wAxis = hLen > 1e-4 ? { x: -chord.z / hLen, y: 0, z: chord.x / hLen } : { x: 0, y: 0, z: 1 };
      }
    }

    // 2. Orthonormal profile plane basis (e1Axis, e2Axis) orthogonal to wAxis
    let meanW = 0;
    for (let i = 0; i < pts.length; i++) {
      meanW += (pts[i].x - firstPt.x) * wAxis.x + (pts[i].y - firstPt.y) * wAxis.y + (pts[i].z - firstPt.z) * wAxis.z;
    }
    meanW /= pts.length;
    const originP = {
      x: firstPt.x + meanW * wAxis.x,
      y: firstPt.y + meanW * wAxis.y,
      z: firstPt.z + meanW * wAxis.z,
    };

    const projPts3D = pts.map((p) => {
      const dw = (p.x - originP.x) * wAxis.x + (p.y - originP.y) * wAxis.y + (p.z - originP.z) * wAxis.z;
      return {
        x: p.x - dw * wAxis.x,
        y: p.y - dw * wAxis.y,
        z: p.z - dw * wAxis.z,
      };
    });

    let chordPerp = {
      x: projPts3D[projPts3D.length - 1].x - projPts3D[0].x,
      y: projPts3D[projPts3D.length - 1].y - projPts3D[0].y,
      z: projPts3D[projPts3D.length - 1].z - projPts3D[0].z,
    };
    if (Math.hypot(chordPerp.x, chordPerp.y, chordPerp.z) < 1e-4) {
      chordPerp = Math.abs(wAxis.y) < 0.9 ? cVecCross({ x: 0, y: 1, z: 0 }, wAxis) : { x: 1, y: 0, z: 0 };
    }
    const e1Axis = cVecNorm(chordPerp);
    const e2Axis = cVecNorm(cVecCross(wAxis, e1Axis));

    const ctrlPts2D = projPts3D.map((p) => ({
      u: (p.x - originP.x) * e1Axis.x + (p.y - originP.y) * e1Axis.y + (p.z - originP.z) * e1Axis.z,
      v: (p.x - originP.x) * e2Axis.x + (p.y - originP.y) * e2Axis.y + (p.z - originP.z) * e2Axis.z,
      w: 1.0,
    }));

    // 3. Fit circle to profile points in (originP, e1Axis, e2Axis) frame to report radiusM and support "arc" mode
    const useDenseForFit = !config.hasExplicitSpline && Array.isArray(config.denseProfilePts3D) && config.denseProfilePts3D.length >= 6;
    const fitInput2D = useDenseForFit
      ? config.denseProfilePts3D.map((p) => ({
          u: (p.x - originP.x) * e1Axis.x + (p.y - originP.y) * e1Axis.y + (p.z - originP.z) * e1Axis.z,
          v: (p.x - originP.x) * e2Axis.x + (p.y - originP.y) * e2Axis.y + (p.z - originP.z) * e2Axis.z,
          w: Number.isFinite(p.w) && p.w > 0 ? p.w : 1.0,
        }))
      : ctrlPts2D;
    const circleFit = fit2DCircleAlgebraicAndRefine(fitInput2D, {
      forceArc: curveType === "arc",
      manualRadiusM: hasManualRadius ? manualRadiusM : null,
    });

    // Compute domain coverage across inspection polygon (config.polyPts) so curved surface spans entire polygon
    const domainPts3D = [];
    if (Array.isArray(config.polyPts)) {
      for (let i = 0; i < config.polyPts.length; i++) {
        const p = config.polyPts[i];
        if (p && Number.isFinite(p.x)) domainPts3D.push(p);
      }
    }
    if (!config.hasExplicitSpline && Array.isArray(config.denseProfilePts3D)) {
      const stepD = Math.max(1, Math.floor(config.denseProfilePts3D.length / 80));
      for (let i = 0; i < config.denseProfilePts3D.length; i += stepD) {
        const p = config.denseProfilePts3D[i];
        if (p && Number.isFinite(p.x)) domainPts3D.push(p);
      }
    }

    let vStartM = 0.0;
    let vEndM = extrudeDepthM;
    if (domainPts3D.length >= 3) {
      let minDomW = 0.0;
      let maxDomW = extrudeDepthM;
      for (let i = 0; i < domainPts3D.length; i++) {
        const p = domainPts3D[i];
        const pw = (p.x - originP.x) * wAxis.x + (p.y - originP.y) * wAxis.y + (p.z - originP.z) * wAxis.z;
        if (pw < minDomW) minDomW = pw;
        if (pw > maxDomW) maxDomW = pw;
      }
      vStartM = Math.min(0.0, minDomW);
      if (!config.hasCustomExtrudeDepth) {
        vEndM = Math.max(extrudeDepthM, maxDomW);
        extrudeDepthM = Math.max(0.2, vEndM);
      } else {
        vEndM = extrudeDepthM;
      }
    }

    const N_RAW = 240;
    let rawCurve3D = [];
    if (curveType === "arc" && circleFit.isValidArc) {
      const a = circleFit.centerU;
      const b = circleFit.centerV;
      const R = circleFit.radiusM;
      const angles = ctrlPts2D.map((pt) => Math.atan2(pt.v - b, pt.u - a));
      for (let i = 1; i < angles.length; i++) {
        while (angles[i] - angles[i - 1] > Math.PI) angles[i] -= 2 * Math.PI;
        while (angles[i] - angles[i - 1] < -Math.PI) angles[i] += 2 * Math.PI;
      }
      let thetaStart = angles[0];
      let thetaEnd = angles[angles.length - 1];
      if (domainPts3D.length >= 3) {
        const dirSign = thetaEnd >= thetaStart ? 1 : -1;
        let minRel = 0;
        let maxRel = Math.abs(thetaEnd - thetaStart);
        const midAngle = 0.5 * (thetaStart + thetaEnd);
        for (let i = 0; i < domainPts3D.length; i++) {
          const p = domainPts3D[i];
          const pu = (p.x - originP.x) * e1Axis.x + (p.y - originP.y) * e1Axis.y + (p.z - originP.z) * e1Axis.z;
          const pv = (p.x - originP.x) * e2Axis.x + (p.y - originP.y) * e2Axis.y + (p.z - originP.z) * e2Axis.z;
          let th = Math.atan2(pv - b, pu - a);
          while (th - midAngle > Math.PI) th -= 2 * Math.PI;
          while (th - midAngle < -Math.PI) th += 2 * Math.PI;
          const rel = (th - thetaStart) * dirSign;
          if (rel < minRel && rel > -Math.PI * 0.85) minRel = rel;
          if (rel > maxRel && rel < Math.PI * 1.65) maxRel = rel;
        }
        thetaStart = thetaStart + dirSign * minRel;
        thetaEnd = thetaStart + dirSign * (maxRel - minRel);
      }
      for (let k = 0; k < N_RAW; k++) {
        const th = thetaStart + (k / (N_RAW - 1)) * (thetaEnd - thetaStart);
        const cu = a + R * Math.cos(th);
        const cv = b + R * Math.sin(th);
        rawCurve3D.push({
          x: originP.x + cu * e1Axis.x + cv * e2Axis.x,
          y: originP.y + cu * e1Axis.y + cv * e2Axis.y,
          z: originP.z + cu * e1Axis.z + cv * e2Axis.z,
        });
      }
    } else {
      let splineSeedPts = projPts3D.slice();
      if (config.hasExplicitSpline && domainPts3D.length >= 3 && splineSeedPts.length >= 2) {
        if (circleFit.isValidArc && circleFit.rmsResidualM <= 0.12 && ctrlPts2D.length >= 3) {
          const a = circleFit.centerU;
          const b = circleFit.centerV;
          const R = circleFit.radiusM;
          const angles = ctrlPts2D.map((pt) => Math.atan2(pt.v - b, pt.u - a));
          for (let i = 1; i < angles.length; i++) {
            while (angles[i] - angles[i - 1] > Math.PI) angles[i] -= 2 * Math.PI;
            while (angles[i] - angles[i - 1] < -Math.PI) angles[i] += 2 * Math.PI;
          }
          const th0 = angles[0];
          const th1 = angles[angles.length - 1];
          const dirSign = th1 >= th0 ? 1 : -1;
          let minRel = 0;
          let maxRel = Math.abs(th1 - th0);
          const midAngle = 0.5 * (th0 + th1);
          for (let i = 0; i < domainPts3D.length; i++) {
            const p = domainPts3D[i];
            const pu = (p.x - originP.x) * e1Axis.x + (p.y - originP.y) * e1Axis.y + (p.z - originP.z) * e1Axis.z;
            const pv = (p.x - originP.x) * e2Axis.x + (p.y - originP.y) * e2Axis.y + (p.z - originP.z) * e2Axis.z;
            let th = Math.atan2(pv - b, pu - a);
            while (th - midAngle > Math.PI) th -= 2 * Math.PI;
            while (th - midAngle < -Math.PI) th += 2 * Math.PI;
            const rel = (th - th0) * dirSign;
            if (rel < minRel && rel > -Math.PI * 0.85) minRel = rel;
            if (rel > maxRel && rel < Math.PI * 1.65) maxRel = rel;
          }
          const avgGap = circleFit.rmsResidualM <= 0.015
            ? 0.04
            : Math.max(0.05, Math.min(0.18, Math.abs(th1 - th0) / Math.max(1, angles.length - 1)));
          if (circleFit.rmsResidualM <= 0.015) {
            const fullStart = th0 + dirSign * minRel;
            const fullEnd = th0 + dirSign * maxRel;
            const nFull = Math.max(16, Math.min(64, Math.ceil(Math.abs(fullEnd - fullStart) / avgGap)));
            splineSeedPts = [];
            for (let s = 0; s <= nFull; s++) {
              const th = fullStart + (s / nFull) * (fullEnd - fullStart);
              const cu = a + R * Math.cos(th), cv = b + R * Math.sin(th);
              splineSeedPts.push({
                x: originP.x + cu * e1Axis.x + cv * e2Axis.x,
                y: originP.y + cu * e1Axis.y + cv * e2Axis.y,
                z: originP.z + cu * e1Axis.z + cv * e2Axis.z,
              });
            }
          } else {
            if (minRel < -0.01) {
              const prePts = [];
              const nPre = Math.max(1, Math.min(12, Math.round(Math.abs(minRel) / avgGap)));
              for (let s = nPre; s >= 1; s--) {
                const th = th0 + dirSign * (minRel * (s / nPre));
                const cu = a + R * Math.cos(th), cv = b + R * Math.sin(th);
                prePts.push({
                  x: originP.x + cu * e1Axis.x + cv * e2Axis.x,
                  y: originP.y + cu * e1Axis.y + cv * e2Axis.y,
                  z: originP.z + cu * e1Axis.z + cv * e2Axis.z,
                });
              }
              splineSeedPts = prePts.concat(splineSeedPts);
            }
            const spanOrig = Math.abs(th1 - th0);
            if (maxRel > spanOrig + 0.01) {
              const extraAng = maxRel - spanOrig;
              const nPost = Math.max(1, Math.min(12, Math.round(extraAng / avgGap)));
              for (let s = 1; s <= nPost; s++) {
                const th = th1 + dirSign * (extraAng * (s / nPost));
                const cu = a + R * Math.cos(th), cv = b + R * Math.sin(th);
                splineSeedPts.push({
                  x: originP.x + cu * e1Axis.x + cv * e2Axis.x,
                  y: originP.y + cu * e1Axis.y + cv * e2Axis.y,
                  z: originP.z + cu * e1Axis.z + cv * e2Axis.z,
                });
              }
            }
          }
        } else {
          const pFirst = splineSeedPts[0];
          const pSecond = splineSeedPts[1];
          const pLast = splineSeedPts[splineSeedPts.length - 1];
          const pPrev = splineSeedPts[splineSeedPts.length - 2];
          const tStart = cVecNorm({ x: pFirst.x - pSecond.x, y: pFirst.y - pSecond.y, z: pFirst.z - pSecond.z });
          const tEnd = cVecNorm({ x: pLast.x - pPrev.x, y: pLast.y - pPrev.y, z: pLast.z - pPrev.z });
          let maxStartExt = 0;
          let maxEndExt = 0;
          for (let i = 0; i < domainPts3D.length; i++) {
            const dp = domainPts3D[i];
            const dw = (dp.x - originP.x) * wAxis.x + (dp.y - originP.y) * wAxis.y + (dp.z - originP.z) * wAxis.z;
            const px = dp.x - dw * wAxis.x, py = dp.y - dw * wAxis.y, pz = dp.z - dw * wAxis.z;
            const dStart = (px - pFirst.x) * tStart.x + (py - pFirst.y) * tStart.y + (pz - pFirst.z) * tStart.z;
            const dEnd = (px - pLast.x) * tEnd.x + (py - pLast.y) * tEnd.y + (pz - pLast.z) * tEnd.z;
            if (dStart > maxStartExt) maxStartExt = Math.min(25.0, dStart);
            if (dEnd > maxEndExt) maxEndExt = Math.min(25.0, dEnd);
          }
          if (maxStartExt > 0.05) {
            splineSeedPts.unshift({
              x: pFirst.x + maxStartExt * tStart.x,
              y: pFirst.y + maxStartExt * tStart.y,
              z: pFirst.z + maxStartExt * tStart.z,
            });
          }
          if (maxEndExt > 0.05) {
            splineSeedPts.push({
              x: pLast.x + maxEndExt * tEnd.x,
              y: pLast.y + maxEndExt * tEnd.y,
              z: pLast.z + maxEndExt * tEnd.z,
            });
          }
        }
      }
      rawCurve3D = evaluateCatmullRomChain3D(splineSeedPts, N_RAW);
    }

    // 4. Build uniform arc-length lookup table (LUT)
    const cumS = new Float64Array(rawCurve3D.length);
    cumS[0] = 0;
    for (let i = 1; i < rawCurve3D.length; i++) {
      const dx = rawCurve3D[i].x - rawCurve3D[i - 1].x;
      const dy = rawCurve3D[i].y - rawCurve3D[i - 1].y;
      const dz = rawCurve3D[i].z - rawCurve3D[i - 1].z;
      cumS[i] = cumS[i - 1] + Math.hypot(dx, dy, dz);
    }
    const arcLengthM = Math.max(0.05, cumS[rawCurve3D.length - 1]);

    const N_LUT = 200;
    const lut = [];
    let rawIdx = 0;
    for (let k = 0; k < N_LUT; k++) {
      const targetS = (k / (N_LUT - 1)) * arcLengthM;
      while (rawIdx < rawCurve3D.length - 2 && cumS[rawIdx + 1] < targetS) {
        rawIdx++;
      }
      const s0 = cumS[rawIdx];
      const s1 = cumS[rawIdx + 1];
      const frac = s1 > s0 ? Math.max(0, Math.min(1, (targetS - s0) / (s1 - s0))) : 0;
      const p0 = rawCurve3D[rawIdx];
      const p1 = rawCurve3D[rawIdx + 1];
      lut.push({
        s: targetS,
        x: p0.x + (p1.x - p0.x) * frac,
        y: p0.y + (p1.y - p0.y) * frac,
        z: p0.z + (p1.z - p0.z) * frac,
        tanX: 1, tanY: 0, tanZ: 0,
        normX: 0, normY: 1, normZ: 0,
      });
    }

    // Compute tangents & normals along LUT
    for (let k = 0; k < N_LUT; k++) {
      const prev = lut[Math.max(0, k - 1)];
      const next = lut[Math.min(N_LUT - 1, k + 1)];
      const tVec = cVecNorm({ x: next.x - prev.x, y: next.y - prev.y, z: next.z - prev.z });
      const nVec = cVecNorm(cVecCross(tVec, wAxis));
      lut[k].tanX = tVec.x;
      lut[k].tanY = tVec.y;
      lut[k].tanZ = tVec.z;
      lut[k].normX = nVec.x;
      lut[k].normY = nVec.y;
      lut[k].normZ = nVec.z;
    }

    // Orient surface normals consistently toward camera (or +Y for horizontal / outward for cylinder)
    const midLut = lut[Math.floor(N_LUT * 0.5)];
    const center3D = {
      x: midLut.x + 0.5 * (vStartM + vEndM) * wAxis.x,
      y: midLut.y + 0.5 * (vStartM + vEndM) * wAxis.y,
      z: midLut.z + 0.5 * (vStartM + vEndM) * wAxis.z,
    };
    let flipNormal = false;
    const camPos = config.cameraPos || (window.studioThree && window.studioThree.camera ? window.studioThree.camera.position : null);
    if (config.preferredNormal && Number.isFinite(config.preferredNormal.x)) {
      if (cVecDot({ x: midLut.normX, y: midLut.normY, z: midLut.normZ }, config.preferredNormal) < 0) {
        flipNormal = true;
      }
    } else if (camPos) {
      const toCam = { x: camPos.x - center3D.x, y: camPos.y - center3D.y, z: camPos.z - center3D.z };
      if (cVecDot({ x: midLut.normX, y: midLut.normY, z: midLut.normZ }, toCam) < 0) {
        flipNormal = true;
      }
    } else if (midLut.normY < -0.25) {
      flipNormal = true;
    }

    if (flipNormal) {
      for (let k = 0; k < N_LUT; k++) {
        lut[k].normX = -lut[k].normX;
        lut[k].normY = -lut[k].normY;
        lut[k].normZ = -lut[k].normZ;
      }
    }

    // Apply normalOffsetM shift if non-zero
    if (Math.abs(normalOffsetM) > 1e-6) {
      for (let k = 0; k < N_LUT; k++) {
        lut[k].x += normalOffsetM * lut[k].normX;
        lut[k].y += normalOffsetM * lut[k].normY;
        lut[k].z += normalOffsetM * lut[k].normZ;
      }
    }

    const avgNormal3D = cVecNorm({
      x: lut[Math.floor(N_LUT * 0.5)].normX,
      y: lut[Math.floor(N_LUT * 0.5)].normY,
      z: lut[Math.floor(N_LUT * 0.5)].normZ,
    });
    const avgTan3D = cVecNorm({
      x: lut[Math.floor(N_LUT * 0.5)].tanX,
      y: lut[Math.floor(N_LUT * 0.5)].tanY,
      z: lut[Math.floor(N_LUT * 0.5)].tanZ,
    });

    const evalAt = (s, v) => {
      const clampedS = Math.max(0, Math.min(arcLengthM, s));
      const extraS = s - clampedS;
      const fIdx = (clampedS / arcLengthM) * (N_LUT - 1);
      const i0 = Math.min(N_LUT - 2, Math.max(0, Math.floor(fIdx)));
      const frac = fIdx - i0;
      const a = lut[i0];
      const b = lut[i0 + 1];
      const tx = a.tanX + (b.tanX - a.tanX) * frac;
      const ty = a.tanY + (b.tanY - a.tanY) * frac;
      const tz = a.tanZ + (b.tanZ - a.tanZ) * frac;
      const nx = a.normX + (b.normX - a.normX) * frac;
      const ny = a.normY + (b.normY - a.normY) * frac;
      const nz = a.normZ + (b.normZ - a.normZ) * frac;
      const tNorm = cVecNorm({ x: tx, y: ty, z: tz });
      const nNorm = cVecNorm({ x: nx, y: ny, z: nz });
      const cx = a.x + (b.x - a.x) * frac + extraS * tNorm.x + v * wAxis.x;
      const cy = a.y + (b.y - a.y) * frac + extraS * tNorm.y + v * wAxis.y;
      const cz = a.z + (b.z - a.z) * frac + extraS * tNorm.z + v * wAxis.z;
      return {
        x: cx, y: cy, z: cz,
        tanX: tNorm.x, tanY: tNorm.y, tanZ: tNorm.z,
        extX: wAxis.x, extY: wAxis.y, extZ: wAxis.z,
        normX: nNorm.x, normY: nNorm.y, normZ: nNorm.z,
      };
    };

    const projectPoint = (lx, ly, lz) => {
      const dx0 = lx - originP.x;
      const dy0 = ly - originP.y;
      const dz0 = lz - originP.z;
      const v = dx0 * wAxis.x + dy0 * wAxis.y + dz0 * wAxis.z;
      // Point projected onto v=0 profile plane
      const px = lx - v * wAxis.x;
      const py = ly - v * wAxis.y;
      const pz = lz - v * wAxis.z;

      // Coarse search every 8 stations, then fine search +-8 stations
      let bestK = 0;
      let bestDistSq = Infinity;
      for (let k = 0; k < N_LUT; k += 8) {
        const ddx = px - lut[k].x, ddy = py - lut[k].y, ddz = pz - lut[k].z;
        const dSq = ddx * ddx + ddy * ddy + ddz * ddz;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestK = k;
        }
      }
      const kMin = Math.max(0, bestK - 8);
      const kMax = Math.min(N_LUT - 1, bestK + 8);
      for (let k = kMin; k <= kMax; k++) {
        const ddx = px - lut[k].x, ddy = py - lut[k].y, ddz = pz - lut[k].z;
        const dSq = ddx * ddx + ddy * ddy + ddz * ddz;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestK = k;
        }
      }

      const st = lut[bestK];
      const relX = px - st.x, relY = py - st.y, relZ = pz - st.z;
      const ds = relX * st.tanX + relY * st.tanY + relZ * st.tanZ;
      const rawS = st.s + ds;
      const s = (bestK === 0 && rawS < 0) || (bestK === N_LUT - 1 && rawS > arcLengthM)
        ? rawS
        : Math.max(0, Math.min(arcLengthM, rawS));
      const ev = evalAt(s, v);
      const signedN = (lx - ev.x) * ev.normX + (ly - ev.y) * ev.normY + (lz - ev.z) * ev.normZ;
      return {
        s,
        v,
        signedN,
        planeX: ev.x,
        planeY: ev.y,
        planeZ: ev.z,
        normX: ev.normX,
        normY: ev.normY,
        normZ: ev.normZ,
        tanX: ev.tanX,
        tanY: ev.tanY,
        tanZ: ev.tanZ,
        extX: ev.extX,
        extY: ev.extY,
        extZ: ev.extZ,
      };
    };

    const midStation = evalAt(0.5 * arcLengthM, 0);
    const extrudeHandle3D = {
      x: midStation.x + extrudeDepthM * wAxis.x,
      y: midStation.y + extrudeDepthM * wAxis.y,
      z: midStation.z + extrudeDepthM * wAxis.z,
    };

    // Ribbon perimeter polygon in 3D (fallback boundary when no user polygon is drawn)
    const ribbonBoundaryPts3D = [];
    const nEdgePts = 7;
    for (let i = 0; i < nEdgePts; i++) {
      const s = (i / (nEdgePts - 1)) * arcLengthM;
      const pTop = evalAt(s, vStartM);
      ribbonBoundaryPts3D.push({ x: pTop.x, y: pTop.y, z: pTop.z });
    }
    for (let i = nEdgePts - 1; i >= 0; i--) {
      const s = (i / (nEdgePts - 1)) * arcLengthM;
      const pBot = evalAt(s, vEndM);
      ribbonBoundaryPts3D.push({ x: pBot.x, y: pBot.y, z: pBot.z });
    }

    // Build planeSummary compatible with cache.plane
    const nyAbs = Math.min(1.0, Math.abs(avgNormal3D.y));
    const nh = Math.hypot(avgNormal3D.x, avgNormal3D.z);
    const angleFromHorizontalDeg = (Math.atan2(nh, nyAbs) * 180.0) / Math.PI;
    const slopePct = nyAbs > 1e-4 ? (nh / nyAbs) * 100.0 : 999.9;
    const plumbMmPerM =
      angleFromHorizontalDeg <= 45.0
        ? nyAbs > 1e-4 ? (nh / nyAbs) * 1000.0 : 0.0
        : nh > 1e-4 ? (nyAbs / nh) * 1000.0 : 0.0;
    let tiltRatio = "1:INF";
    if (angleFromHorizontalDeg <= 45.0) {
      if (slopePct >= 0.05) tiltRatio = `1:${Math.max(1, Math.round(100.0 / slopePct))}`;
    } else if (plumbMmPerM >= 0.5) {
      tiltRatio = `1:${Math.max(1, Math.round(1000.0 / plumbMmPerM))}`;
    }
    const azRad = Math.atan2(avgNormal3D.x, -avgNormal3D.z);
    const azimuthDeg = ((azRad * 180.0) / Math.PI + 360.0) % 360.0;
    const rLabel = circleFit.isValidArc ? `R=${circleFit.radiusM.toFixed(2)}m` : `L=${arcLengthM.toFixed(2)}m`;

    const planeSummary = {
      center: center3D,
      normal: avgNormal3D,
      uAxis: avgTan3D,
      vAxis: wAxis,
      planeMode: "curved_extruded",
      slopePct: Number(slopePct.toFixed(2)),
      slopeDeg: Number(angleFromHorizontalDeg.toFixed(2)),
      tiltRatio,
      plumbMmPerM: Number(plumbMmPerM.toFixed(1)),
      azimuthDeg: Number(azimuthDeg.toFixed(1)),
      surfaceClassZh: angleFromHorizontalDeg > 55.0 ? `弧形牆面 (${rLabel})` : `弧形曲面 (${rLabel})`,
      surfaceClassEn: angleFromHorizontalDeg > 55.0 ? `Curved Wall (${rLabel})` : `Curved Surface (${rLabel})`,
    };

    const validRadiusM = circleFit.isValidArc ? Number(circleFit.radiusM.toFixed(2)) : null;

    return {
      evalAt,
      projectPoint,
      lut,
      arcLengthM: Number(arcLengthM.toFixed(3)),
      extrudeDepthM: Number(extrudeDepthM.toFixed(3)),
      vStartM: Number(vStartM.toFixed(3)),
      vEndM: Number(vEndM.toFixed(3)),
      radiusM: validRadiusM,
      curvatureRadiusM: validRadiusM,
      manualRadiusM: hasManualRadius ? Number(manualRadiusM.toFixed(2)) : null,
      sagittaM: circleFit.sagittaM,
      isValidArc: circleFit.isValidArc,
      curveType,
      extrudeDirMode,
      offsetMode,
      normalOffsetM: Number(normalOffsetM.toFixed(4)),
      wAxis,
      e1Axis,
      e2Axis,
      originP,
      splinePts3D: pts,
      extrudeHandle3D,
      ribbonBoundaryPts3D,
      planeSummary,
    };
  }

  /**
   * Automatically fits a Curved Extruded Surface (spline control points S1..S5 + extrusion axis wAxis + depth)
   * to a set of 3D mesh points sampled inside a polygon (Workflow B).
   */
  function fitCurvedExtrudedSurfaceFromPolygonSamples(sampledPts, polyPts, config = {}) {
    const pts = Array.isArray(sampledPts) && sampledPts.length >= 6 ? sampledPts : (Array.isArray(polyPts) ? polyPts : []);
    const boundaryPts = Array.isArray(polyPts) && polyPts.length >= 3 ? polyPts : pts;
    const initPlane = typeof window.fitFlatnessReferencePlane === "function"
      ? window.fitFlatnessReferencePlane(pts, "best_fit_3d")
      : { center: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, uAxis: { x: 1, y: 0, z: 0 }, vAxis: { x: 0, y: 0, z: 1 }, slopeDeg: 0 };

    const extrudeDirMode = config.extrudeDirMode || "auto";
    const curveType = config.curveType === "arc" ? "arc" : "spline";
    let wAxis = { x: 0, y: -1, z: 0 };

    if (extrudeDirMode === "down_y") {
      wAxis = { x: 0, y: -1, z: 0 };
    } else if (extrudeDirMode === "up_y") {
      wAxis = { x: 0, y: 1, z: 0 };
    } else if (extrudeDirMode === "lateral") {
      const fn = initPlane.normal;
      const hLen = Math.hypot(fn.x, fn.z);
      wAxis = hLen > 1e-4 ? { x: -fn.z / hLen, y: 0, z: fn.x / hLen } : { x: 1, y: 0, z: 0 };
    } else {
      // Auto ruling axis discovery:
      // 1. If steep/vertical wall (slopeDeg > 48 deg), cylinder generator axis is vertical (-Y)
      if (Number(initPlane.slopeDeg) > 48.0) {
        wAxis = { x: 0, y: -1, z: 0 };
      } else {
        // 2. For curved ramps / vaulted slabs, test candidate ruling directions in tangent plane
        // using a 36-step (5 deg) search + 1 deg local refinement around the minimum profile dispersion
        const u0 = initPlane.uAxis;
        const v0 = initPlane.vAxis;
        const c0 = initPlane.center;
        const candE2 = initPlane.normal;
        const step = Math.max(1, Math.floor(pts.length / 250));
        const evalCandidateAngle = (ang) => {
          const candW = cVecNorm({
            x: Math.cos(ang) * u0.x + Math.sin(ang) * v0.x,
            y: Math.cos(ang) * u0.y + Math.sin(ang) * v0.y,
            z: Math.cos(ang) * u0.z + Math.sin(ang) * v0.z,
          });
          const candE1 = cVecNorm({
            x: -Math.sin(ang) * u0.x + Math.cos(ang) * v0.x,
            y: -Math.sin(ang) * u0.y + Math.cos(ang) * v0.y,
            z: -Math.sin(ang) * u0.z + Math.cos(ang) * v0.z,
          });
          const p2d = [];
          let uMin = Infinity, uMax = -Infinity;
          for (let i = 0; i < pts.length; i += step) {
            const dx = pts[i].x - c0.x, dy = pts[i].y - c0.y, dz = pts[i].z - c0.z;
            const pu = dx * candE1.x + dy * candE1.y + dz * candE1.z;
            const pv = dx * candE2.x + dy * candE2.y + dz * candE2.z;
            if (pu < uMin) uMin = pu;
            if (pu > uMax) uMax = pu;
            p2d.push({ u: pu, v: pv, w: 1.0 });
          }
          if (curveType === "arc") {
            const cf = fit2DCircleAlgebraicAndRefine(p2d, { forceArc: true, manualRadiusM: config.manualRadiusM });
            return { rms: cf.rmsResidualM, candW };
          }
          const nBins = 10;
          const uSpan = Math.max(1e-4, uMax - uMin);
          const bins = Array.from({ length: nBins }, () => ({ n: 0, su: 0, sv: 0, suu: 0, suv: 0, svv: 0 }));
          for (let i = 0; i < p2d.length; i++) {
            const bIdx = Math.min(nBins - 1, Math.max(0, Math.floor(((p2d[i].u - uMin) / uSpan) * nBins)));
            const b = bins[bIdx];
            const u = p2d[i].u, v = p2d[i].v;
            b.n++; b.su += u; b.sv += v; b.suu += u * u; b.suv += u * v; b.svv += v * v;
          }
          let sumSqErr = 0, totalN = 0;
          for (let bIdx = 0; bIdx < nBins; bIdx++) {
            const b = bins[bIdx];
            if (b.n < 2) continue;
            const mu = b.su / b.n, mv = b.sv / b.n;
            const suuC = b.suu - b.n * mu * mu;
            const suvC = b.suv - b.n * mu * mv;
            const svvC = Math.max(0, b.svv - b.n * mv * mv);
            const slope = suuC > 1e-9 ? suvC / suuC : 0;
            sumSqErr += Math.max(0, svvC - slope * suvC);
            totalN += b.n;
          }
          return { rms: totalN > 0 ? Math.sqrt(sumSqErr / totalN) : Infinity, candW };
        };
        let bestAng = 0;
        let bestW = v0;
        let bestRms = Infinity;
        for (let aIdx = 0; aIdx < 36; aIdx++) {
          const ang = (aIdx * Math.PI) / 36.0;
          const res = evalCandidateAngle(ang);
          if (res.rms < bestRms) {
            bestRms = res.rms;
            bestAng = ang;
            bestW = res.candW;
          }
        }
        for (let dDeg = -4; dDeg <= 4; dDeg++) {
          if (dDeg === 0) continue;
          const ang = bestAng + (dDeg * Math.PI) / 180.0;
          const res = evalCandidateAngle(ang);
          if (res.rms < bestRms) {
            bestRms = res.rms;
            bestW = res.candW;
          }
        }
        wAxis = bestW;
      }
    }

    // Orthonormal profile basis (e1Axis, e2Axis) perpendicular to wAxis
    const c0 = initPlane.center;
    let e2Guess = initPlane.normal;
    const e2DotW = cVecDot(e2Guess, wAxis);
    e2Guess = cVecNorm({
      x: e2Guess.x - e2DotW * wAxis.x,
      y: e2Guess.y - e2DotW * wAxis.y,
      z: e2Guess.z - e2DotW * wAxis.z,
    });
    if (Math.hypot(e2Guess.x, e2Guess.y, e2Guess.z) < 1e-4) {
      e2Guess = Math.abs(wAxis.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    }
    const e1Axis = cVecNorm(cVecCross(e2Guess, wAxis));
    const e2Axis = cVecNorm(cVecCross(wAxis, e1Axis));

    // Find u bounds from sampled pts, and w bounds from pts (plus overlapping boundaryPts)
    let minW = Infinity, maxW = -Infinity, minU = Infinity, maxU = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!p || !Number.isFinite(p.x)) continue;
      const dx = p.x - c0.x, dy = p.y - c0.y, dz = p.z - c0.z;
      const pw = dx * wAxis.x + dy * wAxis.y + dz * wAxis.z;
      const pu = dx * e1Axis.x + dy * e1Axis.y + dz * e1Axis.z;
      if (pw < minW) minW = pw;
      if (pw > maxW) maxW = pw;
      if (pu < minU) minU = pu;
      if (pu > maxU) maxU = pu;
    }
    const ptsMinW = minW, ptsMaxW = maxW;
    for (let i = 0; i < boundaryPts.length; i++) {
      const p = boundaryPts[i];
      if (!p || !Number.isFinite(p.x)) continue;
      const dx = p.x - c0.x, dy = p.y - c0.y, dz = p.z - c0.z;
      const pw = dx * wAxis.x + dy * wAxis.y + dz * wAxis.z;
      if (!Number.isFinite(ptsMinW) || (pw >= ptsMinW - 0.5 && pw <= ptsMaxW + 0.5)) {
        if (pw < minW) minW = pw;
        if (pw > maxW) maxW = pw;
      }
    }
    if (!Number.isFinite(minW) || maxW - minW < 0.1) {
      minW = -1.0;
      maxW = 1.0;
    }
    if (!Number.isFinite(minU) || maxU - minU < 0.1) {
      minU = -1.0;
      maxU = 1.0;
    }

    const topOrigin = {
      x: c0.x + minW * wAxis.x,
      y: c0.y + minW * wAxis.y,
      z: c0.z + minW * wAxis.z,
    };
    const autoExtrudeDepthM = Math.max(0.2, maxW - minW);
    const extrudeDepthM =
      config.hasCustomExtrudeDepth && Number.isFinite(Number(config.extrudeDepthM)) && Number(config.extrudeDepthM) >= 0.15
        ? Number(config.extrudeDepthM)
        : autoExtrudeDepthM;

    // Project all sampled surface points into (u, v) in the topOrigin profile plane
    const dense2D = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const dx = p.x - topOrigin.x, dy = p.y - topOrigin.y, dz = p.z - topOrigin.z;
      dense2D.push({
        u: dx * e1Axis.x + dy * e1Axis.y + dz * e1Axis.z,
        v: dx * e2Axis.x + dy * e2Axis.y + dz * e2Axis.z,
        w: Number.isFinite(p.w) && p.w > 0 ? p.w : 1.0,
      });
    }

    const circleFit = fit2DCircleAlgebraicAndRefine(dense2D, {
      forceArc: curveType === "arc",
      manualRadiusM: config.manualRadiusM,
    });
    const useCircleStations = curveType === "arc" && circleFit.isValidArc;
    const numCtrl = useCircleStations ? 5 : 9;
    const splinePts = [];

    if (useCircleStations) {
      // Sample 5 control points directly along the fitted circular arc spanning [minU, maxU]
      const a = circleFit.centerU;
      const b = circleFit.centerV;
      const R = circleFit.radiusM;
      const pStart = dense2D.reduce((best, cur) => (cur.u < best.u ? cur : best), dense2D[0]);
      const pEnd = dense2D.reduce((best, cur) => (cur.u > best.u ? cur : best), dense2D[0]);
      let th0 = Math.atan2(pStart.v - b, pStart.u - a);
      let th1 = Math.atan2(pEnd.v - b, pEnd.u - a);
      while (th1 - th0 > Math.PI) th1 -= 2 * Math.PI;
      while (th1 - th0 < -Math.PI) th1 += 2 * Math.PI;
      for (let k = 0; k < numCtrl; k++) {
        const th = th0 + (k / (numCtrl - 1)) * (th1 - th0);
        const cu = a + R * Math.cos(th);
        const cv = b + R * Math.sin(th);
        splinePts.push({
          x: topOrigin.x + cu * e1Axis.x + cv * e2Axis.x,
          y: topOrigin.y + cu * e1Axis.y + cv * e2Axis.y,
          z: topOrigin.z + cu * e1Axis.z + cv * e2Axis.z,
        });
      }
    } else {
      // Robust local linear/median profile stations across [minU, maxU] for parabolic / S-curve / freeform spline surfaces
      const spanU = Math.max(0.2, maxU - minU);
      for (let k = 0; k < numCtrl; k++) {
        const targetU = minU + (k / (numCtrl - 1)) * spanU;
        let winHalf = spanU * 0.04;
        const nearPts = [];
        for (let i = 0; i < dense2D.length; i++) {
          const du = Math.abs(dense2D[i].u - targetU);
          if (du <= winHalf) nearPts.push({ u: dense2D[i].u - targetU, v: dense2D[i].v, w: 1.0 - 0.65 * (du / winHalf) });
        }
        if (nearPts.length < 3) {
          nearPts.length = 0;
          winHalf = spanU * 0.14;
          for (let i = 0; i < dense2D.length; i++) {
            const du = Math.abs(dense2D[i].u - targetU);
            if (du <= winHalf) nearPts.push({ u: dense2D[i].u - targetU, v: dense2D[i].v, w: 1.0 - 0.65 * (du / winHalf) });
          }
        }
        let estV = 0;
        if (nearPts.length >= 3) {
          // Local weighted linear regression v(u) = b0 + b1 * (u - targetU) to eliminate boundary bias at k=0 and k=4
          let sw = 0, su = 0, sv = 0, suu = 0, suv = 0;
          for (let i = 0; i < nearPts.length; i++) {
            const np = nearPts[i];
            sw += np.w;
            su += np.w * np.u;
            sv += np.w * np.v;
            suu += np.w * np.u * np.u;
            suv += np.w * np.u * np.v;
          }
          const det = sw * suu - su * su;
          estV = Math.abs(det) > 1e-9 ? (suu * sv - su * suv) / det : sv / Math.max(1e-9, sw);
        } else if (nearPts.length > 0) {
          nearPts.sort((x, y) => x.v - y.v);
          estV = nearPts[Math.floor(nearPts.length * 0.5)].v;
        }
        splinePts.push({
          x: topOrigin.x + targetU * e1Axis.x + estV * e2Axis.x,
          y: topOrigin.y + targetU * e1Axis.y + estV * e2Axis.y,
          z: topOrigin.z + targetU * e1Axis.z + estV * e2Axis.z,
        });
      }
    }

    return buildCurvedExtrudedSurfaceEvaluator({
      splinePts,
      curveType,
      extrudeDirMode,
      extrudeDepthM,
      hasCustomExtrudeDepth: Boolean(config.hasCustomExtrudeDepth),
      manualRadiusM: config.manualRadiusM,
      polyPts: boundaryPts,
      explicitWAxis: wAxis,
      denseProfilePts3D: pts,
      offsetMode: config.offsetMode || "auto_center",
      preferredNormal: initPlane.normal,
    });
  }

  /**
   * Converts or refines a sampled flatness cache into a Curved Extruded Surface cache,
   * orienting every cell along the local curved tangent/extrusion/normal frame (t(s), w, n(s)).
   */
  function evaluateCurvedCacheFromCells(rawCells, polyPts, config = {}) {
    if (!Array.isArray(rawCells) || rawCells.length === 0) return null;

    let evaluator = null;
    if (config.hasExplicitSpline && Array.isArray(config.splinePts) && config.splinePts.length >= 2) {
      evaluator = buildCurvedExtrudedSurfaceEvaluator({ ...config, polyPts });
    } else {
      evaluator = fitCurvedExtrudedSurfaceFromPolygonSamples(rawCells, polyPts, config);
    }

    // Project all sampled 3D points onto the curved surface and optionally center mean normal offset
    const projections = new Array(rawCells.length);
    const devs = [];
    for (let i = 0; i < rawCells.length; i++) {
      const c = rawCells[i];
      const rawX = Number.isFinite(c.rawX) ? c.rawX : c.x;
      const rawY = Number.isFinite(c.rawY) ? c.rawY : c.y;
      const rawZ = Number.isFinite(c.rawZ) ? c.rawZ : c.z;
      c.rawX = rawX;
      c.rawY = rawY;
      c.rawZ = rawZ;
      const proj = evaluator.projectPoint(rawX, rawY, rawZ);
      projections[i] = proj;
      devs.push(proj.signedN);
    }

    let meanOffsetM = 0.0;
    if (evaluator.offsetMode !== "lock_spline" && devs.length > 0) {
      const sorted = devs.slice().sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length * 0.5)] || 0.0;
      let wSum = 0, dSum = 0;
      for (let i = 0; i < devs.length; i++) {
        const r = Math.abs(devs[i] - med) / 0.025;
        const w = r <= 1.0 ? 1.0 : 1.0 / (1.0 + r * r);
        dSum += devs[i] * w;
        wSum += w;
      }
      meanOffsetM = wSum > 0 ? dSum / wSum : med;
    }

    const originTwd = typeof window.localToTwd97 === "function" ? window.localToTwd97({ x: 0, y: 0, z: 0 }) : { e: 0, n: 0, h: 0 };
    let sumSqMm = 0;
    let sumAbsMm = 0;
    let maxHigh = null;
    let maxLow = null;

    for (let i = 0; i < rawCells.length; i++) {
      const cell = rawCells[i];
      const proj = projections[i];
      const devM = proj.signedN - meanOffsetM;
      const devMm = devM * 1000.0;
      cell.devM = devM;
      cell.devMm = devMm;
      cell.planeU = proj.s;
      cell.planeV = proj.v;
      cell.planeX = proj.planeX + meanOffsetM * proj.normX;
      cell.planeY = proj.planeY + meanOffsetM * proj.normY;
      cell.planeZ = proj.planeZ + meanOffsetM * proj.normZ;
      cell.normX = proj.normX;
      cell.normY = proj.normY;
      cell.normZ = proj.normZ;
      cell.tanX = proj.tanX;
      cell.tanY = proj.tanY;
      cell.tanZ = proj.tanZ;
      cell.extX = proj.extX;
      cell.extY = proj.extY;
      cell.extZ = proj.extZ;
      cell.x = cell.planeX + devM * proj.normX;
      cell.y = cell.planeY + devM * proj.normY;
      cell.z = cell.planeZ + devM * proj.normZ;
      cell.e = Number((originTwd.e + cell.x).toFixed(3));
      cell.n = Number((originTwd.n - cell.z).toFixed(3));
      cell.h = Number((originTwd.h + cell.y).toFixed(3));
      sumSqMm += devMm * devMm;
      sumAbsMm += Math.abs(devMm);
      if (!maxHigh || devMm > maxHigh.devMm) maxHigh = cell;
      if (!maxLow || devMm < maxLow.devMm) maxLow = cell;
    }

    const nSamples = Math.max(1, rawCells.length);
    const rmsMm = Math.sqrt(sumSqMm / nSamples);
    const meanAbsMm = sumAbsMm / nSamples;
    let curvSumSq = 0, curvCnt = 0;
    for (let i = 2; i < rawCells.length; i++) {
      const q = Math.abs(rawCells[i].devMm - 2.0 * rawCells[i - 1].devMm + rawCells[i - 2].devMm);
      curvSumSq += q * q;
      curvCnt++;
    }
    const rmsCurvMm = curvCnt > 0 ? Math.sqrt(curvSumSq / curvCnt) : Math.max(1.2, rmsMm * 0.8);
    const ffVal = Number(Math.min(120.0, Math.max(8.0, 115.0 / Math.max(1.1, rmsCurvMm))).toFixed(1));
    const flVal = Number(Math.min(100.0, Math.max(6.0, 95.0 / Math.max(1.2, rmsMm))).toFixed(1));

    const planeSummary = evaluator.planeSummary;
    planeSummary.medH = Number((originTwd.h + planeSummary.center.y).toFixed(3));

    return {
      evaluator,
      plane: planeSummary,
      rmsMm: Number(rmsMm.toFixed(2)),
      meanAbsMm: Number(meanAbsMm.toFixed(2)),
      ffFlatness: ffVal,
      flLevelness: flVal,
      maxHigh,
      maxLow,
      curvedMeta: {
        curveType: evaluator.curveType,
        extrudeDirMode: evaluator.extrudeDirMode,
        offsetMode: evaluator.offsetMode,
        extrudeDepthM: evaluator.extrudeDepthM,
        vStartM: evaluator.vStartM,
        vEndM: evaluator.vEndM,
        arcLengthM: evaluator.arcLengthM,
        radiusM: evaluator.radiusM,
        curvatureRadiusM: evaluator.radiusM,
        manualRadiusM: evaluator.manualRadiusM,
        sagittaM: evaluator.sagittaM,
        isValidArc: evaluator.isValidArc,
        splinePts: evaluator.splinePts3D.map((p) => ({ x: Number(p.x.toFixed(3)), y: Number(p.y.toFixed(3)), z: Number(p.z.toFixed(3)) })),
        extrudeHandlePt: {
          x: Number(evaluator.extrudeHandle3D.x.toFixed(3)),
          y: Number(evaluator.extrudeHandle3D.y.toFixed(3)),
          z: Number(evaluator.extrudeHandle3D.z.toFixed(3)),
        },
        wAxis: evaluator.wAxis,
        lut: evaluator.lut.map((st) => ({
          s: Number(st.s.toFixed(3)),
          x: Number((st.x + meanOffsetM * st.normX).toFixed(3)),
          y: Number((st.y + meanOffsetM * st.normY).toFixed(3)),
          z: Number((st.z + meanOffsetM * st.normZ).toFixed(3)),
          normX: Number(st.normX.toFixed(4)),
          normY: Number(st.normY.toFixed(4)),
          normZ: Number(st.normZ.toFixed(4)),
        })),
      },
    };
  }

  /**
   * Builds the 3D curved wireframe reference surface, translucent ribbon, yellow spline control pins (S1..Sn)
   * matching polygon vertex pin formatting, and emerald extrusion handle (E1) for a saved/active curved flatness object.
   */
  function buildCurvedReferenceSurfaceThreeGroup(cache, opts = {}) {
    const THREE = window.THREE;
    if (!THREE || !cache || !cache.curvedMeta) return null;
    const grp = new THREE.Group();
    grp.name = "GS_CurvedReferenceSurface";
    const isActive = Boolean(opts.isActive);
    const meta = cache.curvedMeta;
    const lut = Array.isArray(meta.lut) && meta.lut.length >= 2 ? meta.lut : [];
    const wAxis = meta.wAxis || { x: 0, y: -1, z: 0 };
    const extDepth = Math.max(0.2, Number(meta.extrudeDepthM) || 1.8);
    const vStart = Number.isFinite(meta.vStartM) ? Number(meta.vStartM) : 0.0;
    const vEnd = Number.isFinite(meta.vEndM) && meta.vEndM > vStart + 0.05 ? Number(meta.vEndM) : extDepth;

    if (lut.length >= 2) {
      const segU = Math.min(32, lut.length - 1);
      const segV = 6;
      const positions = [];
      const indices = [];
      for (let r = 0; r <= segV; r++) {
        const vDist = vStart + (r / segV) * (vEnd - vStart);
        for (let c = 0; c <= segU; c++) {
          const lIdx = Math.min(lut.length - 1, Math.round((c / segU) * (lut.length - 1)));
          const st = lut[lIdx];
          positions.push(st.x + vDist * wAxis.x, st.y + vDist * wAxis.y, st.z + vDist * wAxis.z);
        }
      }
      for (let r = 0; r < segV; r++) {
        for (let c = 0; c < segU; c++) {
          const a = r * (segU + 1) + c;
          const b = a + 1;
          const d = (r + 1) * (segU + 1) + c;
          const e = d + 1;
          indices.push(a, b, d, b, e, d);
        }
      }
      const surfGeo = new THREE.BufferGeometry();
      surfGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      surfGeo.setIndex(indices);

      // Subtle translucent emerald/cyan curved surface fill
      const fillMat = new THREE.MeshBasicMaterial({
        color: 0x10b981,
        transparent: true,
        opacity: isActive ? 0.14 : 0.06,
        side: THREE.DoubleSide,
        depthTest: false,
      });
      const fillMesh = new THREE.Mesh(surfGeo, fillMat);
      fillMesh.name = "GS_CurvedRibbonFill";
      fillMesh.renderOrder = 993;
      grp.add(fillMesh);

      // Crisp curved wireframe grid
      const wireMat = new THREE.MeshBasicMaterial({
        color: 0x22d3ee,
        wireframe: true,
        transparent: true,
        opacity: isActive ? 0.48 : 0.25,
        depthTest: false,
      });
      const wireMesh = new THREE.Mesh(surfGeo, wireMat);
      wireMesh.name = "GS_CurvedRibbonWire";
      wireMesh.renderOrder = 994;
      grp.add(wireMesh);

      // Highlight top profile reference curve C(s) in yellow
      const curvePts = lut.map((st) => new THREE.Vector3(st.x, st.y, st.z));
      const curveGeo = new THREE.BufferGeometry().setFromPoints(curvePts);
      const curveLine = new THREE.Line(
        curveGeo,
        new THREE.LineBasicMaterial({ color: 0xfacc15, depthTest: false, transparent: !isActive, opacity: isActive ? 1.0 : 0.78 })
      );
      curveLine.renderOrder = 998;
      grp.add(curveLine);
    }

    // Render interactive yellow spline control pins (S1..Sn) in polygon vertex pin format and emerald extrusion handle (E1)
    if (Array.isArray(meta.splinePts)) {
      meta.splinePts.forEach((pt) => {
        const ptVec = new THREE.Vector3(pt.x, pt.y, pt.z);
        if (isActive && typeof window.add3DPinMarker === "function") {
          window.add3DPinMarker(ptVec, 0xfacc15, grp);
        } else {
          const sp = new THREE.Mesh(
            new THREE.SphereGeometry(isActive ? 0.12 : 0.09, 14, 14),
            new THREE.MeshBasicMaterial({ color: isActive ? 0xfacc15 : 0xeab308, depthTest: false })
          );
          sp.position.copy(ptVec);
          sp.renderOrder = 999;
          grp.add(sp);
        }
      });
    }
    if (isActive && meta.extrudeHandlePt) {
      const ep = meta.extrudeHandlePt;
      const eMesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.17, 0),
        new THREE.MeshBasicMaterial({ color: 0x10b981, depthTest: false })
      );
      eMesh.position.set(ep.x, ep.y, ep.z);
      eMesh.renderOrder = 999;
      grp.add(eMesh);
    }

    return grp;
  }

  /**
   * Builds the live 3D spline + translucent green extruded surface preview while drawing/adjusting S1..Sn & E1.
   */
  function buildCurvedDraftPreviewThreeGroup(draftConfig = {}) {
    const THREE = window.THREE;
    if (!THREE) return null;
    const grp = new THREE.Group();
    grp.name = "GS_CurvedDraftPreview";

    const pts = (Array.isArray(draftConfig.splinePts) ? draftConfig.splinePts : []).map((p) => ({
      x: Number(p.x) || 0,
      y: Number(p.y) || 0,
      z: Number(p.z) || 0,
    }));
    const hoverPt = draftConfig.hoverPt
      ? { x: Number(draftConfig.hoverPt.x) || 0, y: Number(draftConfig.hoverPt.y) || 0, z: Number(draftConfig.hoverPt.z) || 0 }
      : null;
    const pickStage = draftConfig.pickStage || "spline";

    const activeSplinePts = pts.slice();
    if (pickStage === "spline" && hoverPt) {
      activeSplinePts.push(hoverPt);
    }

    if (activeSplinePts.length < 2) {
      pts.forEach((p) => {
        const ptVec = new THREE.Vector3(p.x, p.y, p.z);
        if (typeof window.add3DPinMarker === "function") {
          window.add3DPinMarker(ptVec, 0xfacc15, grp);
        } else {
          const pinMesh = new THREE.Mesh(
            new THREE.SphereGeometry(0.12, 14, 14),
            new THREE.MeshBasicMaterial({ color: 0xfacc15, depthTest: false })
          );
          pinMesh.position.copy(ptVec);
          pinMesh.renderOrder = 999;
          grp.add(pinMesh);
        }
      });
    } else {
      const e1Target = pickStage === "extrude" && hoverPt ? hoverPt : draftConfig.extrudeTargetPt || null;
      const evaluator = buildCurvedExtrudedSurfaceEvaluator({
        splinePts: activeSplinePts,
        hasExplicitSpline: true,
        curveType: draftConfig.curveType || "spline",
        extrudeDirMode: e1Target && pickStage === "extrude" ? "custom_e1" : draftConfig.extrudeDirMode || "auto",
        extrudeDepthM: draftConfig.extrudeDepthM || 1.8,
        hasCustomExtrudeDepth: Boolean(draftConfig.hasCustomExtrudeDepth),
        manualRadiusM: draftConfig.manualRadiusM,
        polyPts: draftConfig.polyPts,
        extrudeTargetPt: e1Target,
        useE1Depth: Boolean(e1Target && (pickStage === "extrude" || draftConfig.extrudeDirMode === "custom_e1")),
      });

      const fakeCache = {
        curvedMeta: {
          lut: evaluator.lut,
          wAxis: evaluator.wAxis,
          extrudeDepthM: evaluator.extrudeDepthM,
          vStartM: evaluator.vStartM,
          vEndM: evaluator.vEndM,
          splinePts: activeSplinePts,
          extrudeHandlePt: evaluator.extrudeHandle3D,
        },
      };
      const surfGrp = buildCurvedReferenceSurfaceThreeGroup(fakeCache, { isActive: true });
      if (surfGrp) {
        surfGrp.traverse((ch) => {
          if (ch.name === "GS_CurvedRibbonFill" && ch.material) {
            ch.material.opacity = 0.34;
          }
        });
        grp.add(surfGrp);
      }
    }

    return grp;
  }

  function getFlatnessReportStylesheet() {
    return `
    * { box-sizing: border-box; }
    body { font-family: "Noto Serif TC", "PMingLiU", "Microsoft JhengHei", "Noto Sans TC", sans-serif; color: #0f172a; background: #ffffff; margin: 20px 28px; line-height: 1.55; font-size: 12.5px; }
    .doc-header { border-bottom: 2px solid #1e293b; padding-bottom: 10px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: flex-end; }
    h1 { font-size: 19px; font-weight: 700; margin: 0; color: #0f172a; letter-spacing: 0.5px; }
    .doc-subtitle { font-size: 11.5px; color: #334155; margin-top: 3px; }
    .meta-table { width: 100%; border-collapse: collapse; margin-bottom: 14px; font-size: 11.5px; }
    .meta-table th, .meta-table td { border: 1px solid #94a3b8; padding: 5px 8px; }
    .meta-table th { background: #f1f5f9; color: #1e293b; width: 13%; text-align: left; font-weight: 700; }
    .meta-table td { width: 20%; color: #0f172a; }
    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(175px, 1fr)); gap: 8px; margin-bottom: 14px; }
    .kpi-box { border: 1px solid #94a3b8; padding: 8px 10px; background: #f8fafc; }
    .kpi-label { font-size: 11px; color: #475569; font-weight: 600; }
    .kpi-val { font-size: 16px; font-weight: 700; margin-top: 2px; color: #0f172a; font-variant-numeric: tabular-nums; }
    .section-title { font-size: 13.5px; font-weight: 700; color: #0f172a; background: #e2e8f0; border: 1px solid #94a3b8; border-bottom: none; padding: 6px 10px; margin-top: 14px; }
    .section-block { margin-top: 16px; page-break-inside: avoid; }
    .section-header { background: #f1f5f9; border: 1px solid #94a3b8; border-bottom: none; padding: 6px 10px; font-size: 12.5px; font-weight: 700; display: flex; justify-content: space-between; color: #0f172a; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 11.5px; }
    th, td { border: 1px solid #94a3b8; padding: 6px 8px; text-align: left; vertical-align: middle; }
    th { background: #f8fafc; color: #1e293b; font-weight: 700; }
    .overview-fig { border: 1px solid #94a3b8; padding: 8px; background: #ffffff; margin-bottom: 14px; }
    .overview-fig img { width: 100%; max-height: 360px; object-fit: contain; display: block; background: #0f172a; }
    .figs { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px; }
    .fig-card { border: 1px solid #94a3b8; padding: 6px; background: #ffffff; }
    .fig-card img { width: 100%; height: auto; display: block; }
    .fig-cap { font-size: 11px; font-weight: 700; color: #1e293b; margin-top: 5px; text-align: center; }
    .norm-box { border: 1px solid #94a3b8; background: #f8fafc; padding: 8px 12px; font-size: 11px; color: #1e293b; margin-top: 14px; }
    .norm-box a { color: #0369a1; text-decoration: underline; }
    .sign-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 18px; page-break-inside: avoid; }
    .sign-box { border: 1px solid #64748b; padding: 8px 10px; height: 76px; font-size: 11.5px; color: #1e293b; display: flex; flex-direction: column; justify-content: space-between; }
    @media print { .no-print { display: none !important; } body { margin: 10mm; } }`;
  }

  function renderFlatnessCurvedConfigCardHtml(qaState, cache, svgs, trFn) {
    const t = typeof trFn === "function" ? trFn : (zh) => zh;
    const planeMode = qaState.flatnessPlaneMode || "best_fit_3d";
    const curveType = qaState.flatnessCurveType || "spline";
    const extrudeDir = qaState.flatnessExtrudeDirMode || "auto";
    const offsetMode = qaState.flatnessCurvedOffsetMode || "auto_center";
    const extDepthM = Number(qaState.flatnessExtrudeDepthM || cache?.curvedMeta?.extrudeDepthM || 1.8);
    const meta = cache?.curvedMeta || null;
    const manualR = Number(qaState.flatnessManualArcRadiusM ?? meta?.manualRadiusM);
    const manualRVal = Number.isFinite(manualR) && manualR >= 0.12 ? manualR.toFixed(2) : "";
    const autoRPlaceholder = meta && Number.isFinite(meta.radiusM) ? `${meta.radiusM}` : t("自動", "Auto");
    const splineCount = Array.isArray(qaState.curvedSplinePoints)
      ? qaState.curvedSplinePoints.length
      : Array.isArray(meta?.splinePts)
      ? meta.splinePts.length
      : 0;
    const pickStage = qaState.curvedPickStage || "";
    const radText = meta && Number.isFinite(meta.radiusM)
      ? `R = ${meta.radiusM} m`
      : curveType === "arc"
      ? t("圓弧擬合", "Circular Arc")
      : t("樣條擠出", "Spline Extrude");
    const statusText = pickStage === "spline"
      ? t(`請於 3D 表面點擊弧線控制點 S${splineCount + 1} (至少 3 點，完成點「套用曲面」；不影響檢測多邊形邊界)`, `Click 3D spline control point S${splineCount + 1} (3+ pts, then click Apply; keeps polygon boundary intact)`)
      : pickStage === "extrude"
      ? t("請於 3D 表面點擊擠出終點 E1 以決定擠出方向與深度", "Click extrusion target E1 on 3D surface to set direction & depth")
      : meta
      ? t(
          `已擬合 (${radText}, 弧長 ${meta.arcLengthM}m × 擠出 ${meta.extrudeDepthM}m) — 可於 3D 拖曳黃點 S1..S${splineCount} 或綠點 E1`,
          `Fitted (${radText}, Arc ${meta.arcLengthM}m × Ext ${meta.extrudeDepthM}m) — drag yellow S1..S${splineCount} or green E1 in 3D`
        )
      : t("多邊形定義檢測邊界；可自動擬合弧面，或點「繪製弧線」在 3D 點擊黃點 S1..Sn 自訂曲面", "Polygon defines boundary; auto-fits curved surface, or click 'Draw Spline' to place yellow S1..Sn in 3D");

    return `
      <div id="flatnessCurvedConfigWrap" style="display:${planeMode === "curved_extruded" ? "block" : "none"};margin-top:6px;padding-top:6px;border-top:1px solid var(--ui-border);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">
          <span style="font-size:10.5px;font-weight:700;color:#10b981;">
            ${t("弧形擠出基準曲面 (S(s,v) = C(s) + v·W)", "Curved Extruded Design Surface")}
          </span>
          <span id="lblFlatnessCurvedRadiusBadge" style="font-size:10px;padding:1px 6px;border-radius:999px;background:rgba(16,185,129,0.18);color:#34d399;font-weight:800;font-family:monospace;">
            ${radText}
          </span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:4px;margin-bottom:5px;">
          <button type="button" class="btn-xs ${!qaState.curvedHasExplicitSpline && !pickStage ? "primary" : ""}" id="btnAutoFitFlatnessCurved" title="${t("依據檢測多邊形內 3D 點雲自動擬合最佳樣條或圓弧曲面", "Auto-fit curved surface from 3D points inside inspection polygon")}">
            ${t("自動擬合", "Auto-Fit")}
          </button>
          <button type="button" class="btn-xs ${pickStage === "spline" ? "primary" : ""}" id="btnDrawFlatnessSpline" title="${t("在 3D 模型點擊 3+ 個黃色控制點 S1..Sn 自訂基準弧線 (保留檢測多邊形)", "Click 3+ yellow control points S1..Sn on 3D surface (preserves inspection polygon)")}">
            ${svgs.PICK} ${t("繪製弧線", "Draw Spline")}
          </button>
          <button type="button" class="btn-xs ${pickStage === "extrude" ? "primary" : ""}" id="btnPickFlatnessExtrudePt" title="${t("在 3D 模型點擊擠出終點 E1 設定擠出方向與寬度", "Click target point E1 in 3D to set extrusion vector & width")}">
            ${svgs.STAKEOUT} ${t("擠出點 E1", "Pick E1")}
          </button>
          <button type="button" class="btn-xs primary" id="btnFinishFlatnessSpline" title="${t("完成弧線並套用弧形擠出曲面分析", "Finish spline and analyze curved extruded surface")}">
            ${svgs.CHECK} ${t("套用曲面", "Apply")}
          </button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:5px;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px;">
            <label class="gs-qa-mode-pill ${curveType === "spline" ? "active" : ""}" title="${t("通過控制點 S1..Sn 之平滑樣條曲線 (Catmull-Rom)", "Smooth Catmull-Rom Spline through S1..Sn")}">
              <input type="radio" name="flatnessCurveType" value="spline" ${curveType === "spline" ? "checked" : ""} style="display:none;" />
              <span style="font-size:9.5px;">${t("樣條曲線", "Spline")}</span>
            </label>
            <label class="gs-qa-mode-pill ${curveType === "arc" ? "active" : ""}" title="${t("固定曲率半徑 R 之標準圓柱圓弧", "Constant-radius circular cylinder arc (R)")}">
              <input type="radio" name="flatnessCurveType" value="arc" ${curveType === "arc" ? "checked" : ""} style="display:none;" />
              <span style="font-size:9.5px;">${t("標準圓弧", "Circle Arc")}</span>
            </label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px;">
            <label class="gs-qa-mode-pill ${offsetMode === "auto_center" ? "active" : ""}" title="${t("自動平移曲面使平均法線偏差為 0mm", "Auto-center surface normal offset to 0mm mean")}">
              <input type="radio" name="flatnessCurvedOffsetMode" value="auto_center" ${offsetMode === "auto_center" ? "checked" : ""} style="display:none;" />
              <span style="font-size:9.5px;">${t("最佳平移", "Auto-Fit")}</span>
            </label>
            <label class="gs-qa-mode-pill ${offsetMode === "lock_spline" ? "active" : ""}" title="${t("嚴格鎖定 0mm 基準面通過 S1..Sn 控制點", "Strictly lock 0mm surface to S1..Sn pins")}">
              <input type="radio" name="flatnessCurvedOffsetMode" value="lock_spline" ${offsetMode === "lock_spline" ? "checked" : ""} style="display:none;" />
              <span style="font-size:9.5px;">${t("貼合弧線", "Lock Pins")}</span>
            </label>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1.05fr 0.95fr;gap:5px;align-items:center;margin-bottom:4px;">
          <select id="selFlatnessExtrudeDir" class="gs-select" style="width:100%;height:25px;font-size:10px;" title="${t("選擇弧線擠出延伸方向", "Select spline extrusion direction")}">
            <option value="auto" ${extrudeDir === "auto" ? "selected" : ""}>${t("擠出: 自動正交 (牆面-Y/坡面橫推)", "Extrude: Auto Orthogonal")}</option>
            <option value="down_y" ${extrudeDir === "down_y" ? "selected" : ""}>${t("擠出: 垂直向下 (-Y 牆頂往下)", "Extrude: Down (-Y)")}</option>
            <option value="up_y" ${extrudeDir === "up_y" ? "selected" : ""}>${t("擠出: 垂直向上 (+Y 牆底往上)", "Extrude: Up (+Y)")}</option>
            <option value="lateral" ${extrudeDir === "lateral" ? "selected" : ""}>${t("擠出: 水平橫向 (坡面側緣橫推)", "Extrude: Horizontal Lateral")}</option>
            <option value="custom_e1" ${extrudeDir === "custom_e1" ? "selected" : ""}>${t("擠出: 自訂終點 E1 向量", "Extrude: Custom E1 Vector")}</option>
          </select>
          <div style="display:flex;align-items:center;gap:4px;">
            <input type="range" id="rngFlatnessExtrudeDepthM" min="0.2" max="15.0" step="0.1" value="${Math.min(15, Math.max(0.2, extDepthM))}" style="flex:1;accent-color:#10b981;cursor:pointer;" title="${t("擠出深度/寬度 (m)", "Extrusion depth/width (m)")}" />
            <input type="number" id="inpFlatnessExtrudeDepthM" class="gs-input" value="${extDepthM.toFixed(2)}" min="0.1" max="30.0" step="0.1" style="width:48px;height:25px;font-size:10px;text-align:right;" />
            <span id="lblFlatnessExtrudeDepthReadout" style="font-size:9.5px;color:var(--ui-text-muted);font-family:monospace;">m</span>
          </div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:4px;">
          <span style="font-size:9.5px;color:var(--ui-text-secondary);">${t("圓弧半徑 R (留空=自動擬合):", "Arc Radius R (blank=Auto):")}</span>
          <div style="display:flex;align-items:center;gap:4px;">
            <input type="number" id="inpFlatnessArcRadiusM" class="gs-input" value="${manualRVal}" placeholder="${autoRPlaceholder}" min="0.2" max="1000.0" step="0.1" style="width:68px;height:23px;font-size:10px;text-align:right;" title="${t("自訂圓弧曲率半徑 R (m)，留空則自動最小二乘擬合", "Custom circular arc radius R (m); leave blank for auto fit")}" />
            <span style="font-size:9.5px;color:var(--ui-text-muted);font-family:monospace;">m</span>
          </div>
        </div>
        <div id="lblFlatnessCurvedStatus" style="font-size:9.5px;color:var(--ui-text-secondary);line-height:1.35;">
          ${statusText}
        </div>
      </div>
    `;
  }

  function buildUtilityTraceThreeGroup(res) {
    if (!window.studioThree || !window.studioThree.scene || !window.THREE) return null;
    const group = new window.THREE.Group();
    group.name = "GS_UtilityTrace_Overlay";
    const originTwd = typeof window.localToTwd97 === "function" ? window.localToTwd97({ x: 0, y: 0, z: 0 }) : { e: 0, n: 0, h: 0 };
    const stations = (res && res.stations) || [];
    const dia = Math.max(0.2, (res && res.pipe_diameter_m) || 0.3);
    if (stations.length >= 2) {
      const invPoints = [];
      for (let i = 0; i < stations.length; i++) {
        const s = stations[i];
        const lx = Number(s.e) - originTwd.e;
        const ly_inv = Number(s.invert_z) - originTwd.h;
        const ly_crown = Number(s.crown_z !== undefined ? s.crown_z : s.invert_z + dia) - originTwd.h;
        const ly_ground = Number(s.ground_z !== undefined ? s.ground_z : ly_crown + (s.cover_depth_m || 1.2)) - originTwd.h;
        const lz = originTwd.n - Number(s.n);
        const vInv = new window.THREE.Vector3(lx, ly_inv, lz);
        const vCrown = new window.THREE.Vector3(lx, ly_crown, lz);
        const vGround = new window.THREE.Vector3(lx, ly_ground, lz);
        invPoints.push(vInv);
        const dropLine = new window.THREE.Line(
          new window.THREE.BufferGeometry().setFromPoints([vGround, vCrown]),
          new window.THREE.LineBasicMaterial({ color: 0x10b981, depthTest: false })
        );
        dropLine.renderOrder = 997;
        group.add(dropLine);
        const ringGeo = new window.THREE.RingGeometry(dia * 0.6, dia * 0.9, 16);
        ringGeo.rotateX(-Math.PI / 2);
        const ringMesh = new window.THREE.Mesh(ringGeo, new window.THREE.MeshBasicMaterial({ color: 0xf59e0b, side: window.THREE.DoubleSide, depthTest: false }));
        ringMesh.position.copy(vGround);
        ringMesh.renderOrder = 998;
        group.add(ringMesh);
      }
      const pipeMat = new window.THREE.MeshStandardMaterial({
        color: 0x06b6d4, emissive: 0x06b6d4, emissiveIntensity: 0.5, roughness: 0.3, metalness: 0.2, transparent: true, opacity: 0.92, depthTest: false,
      });
      for (let i = 0; i < invPoints.length - 1; i++) {
        const v1 = invPoints[i], v2 = invPoints[i + 1];
        const segDist = v1.distanceTo(v2);
        if (segDist < 0.02) continue;
        const mid = new window.THREE.Vector3().addVectors(v1, v2).multiplyScalar(0.5);
        const dir = new window.THREE.Vector3().subVectors(v2, v1).normalize();
        const cylMesh = new window.THREE.Mesh(new window.THREE.CylinderGeometry(dia * 0.5, dia * 0.5, segDist, 16), pipeMat);
        cylMesh.position.copy(mid);
        cylMesh.quaternion.setFromUnitVectors(new window.THREE.Vector3(0, 1, 0), dir);
        cylMesh.renderOrder = 996;
        group.add(cylMesh);
        const trenchMesh = new window.THREE.Mesh(
          new window.THREE.BoxGeometry(Math.max(1.0, dia * 2.5), dia * 1.5, segDist),
          new window.THREE.MeshBasicMaterial({ color: 0xf59e0b, wireframe: true, transparent: true, opacity: 0.45, depthTest: false })
        );
        trenchMesh.position.copy(mid);
        trenchMesh.quaternion.setFromUnitVectors(new window.THREE.Vector3(0, 0, 1), dir);
        trenchMesh.renderOrder = 995;
        group.add(trenchMesh);
      }
      if (invPoints.length > 0 && window.studioThree.camera && window.studioThree.controls) {
        const center = invPoints[Math.floor(invPoints.length / 2)];
        const camDist = Math.max(15, ((res && res.total_length_3d_m) || 20) * 0.8);
        window.studioThree.controls.target.copy(center);
        window.studioThree.camera.position.set(center.x + camDist * 0.7, center.y + camDist * 0.65, center.z + camDist * 0.7);
        window.studioThree.controls.update();
      }
    }
    return group;
  }

  window.__GS_CURVED_QA = {
    fit2DCircleAlgebraicAndRefine,
    evaluateCatmullRomChain3D,
    buildCurvedExtrudedSurfaceEvaluator,
    fitCurvedExtrudedSurfaceFromPolygonSamples,
    evaluateCurvedCacheFromCells,
    buildCurvedReferenceSurfaceThreeGroup,
    buildCurvedDraftPreviewThreeGroup,
    getFlatnessReportStylesheet,
    renderFlatnessCurvedConfigCardHtml,
    buildUtilityTraceThreeGroup,
  };

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

