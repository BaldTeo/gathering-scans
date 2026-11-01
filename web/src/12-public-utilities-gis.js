/**
 * GatheringScans Frontend Module 12: Real Public Utilities GIS Integration & 3D Subsurface Twin
 * =============================================================================================
 * Author: worker_track_d_m7 (Public Utilities GIS Specialist)
 * Project: GatheringScans (scans.gatheren.cloud)
 * Milestone 7: Real Public Utilities GIS Integration with Taiwan Open APIs
 *
 * Core Capabilities:
 * 1. Dedicated "Utilities" (管線) tool panel in Studio Dock with automatic 500m server caching
 *    and 250m default displayed radius.
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
 * 3. High-FPS Batched 3D Subsurface Visualization in Three.js:
 *    - Fast single-pass bare-earth 2D elevation grid sampler (< 3ms on large valley meshes like QiHu Park)
 *    - Batched BufferGeometry per utility layer (~20 draw calls total for 15,000+ features, zero RAF lag)
 *    - Zero-roll horizontal orthonormal basis (R, U, F) for rectangular box culverts (fixes 45-deg diagonal roll)
 *    - Opaque polygonOffset subsurface meshes + adaptive camera near-plane (zero zoomed-out Z-fighting flicker)
 *    - Interactive 3D Hover Info Tooltip displaying full engineering card without links
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

  // Module state (Default shown radius = 250m; Server auto-queries and caches 500m)
  const UTILS_STATE = {
    active: false,
    loadedScanId: null,
    lastCenter: null,
    radiusM: 250.0,
    serverMasterRadiusM: 500.0,
    isCached: false,
    cacheTimestamp: "",
    taipei8UtilityStatus: null,
    groundXrayPct: 38, // Default 38% X-Ray translucency (= 0.62 terrain opacity) when Utilities active
    groundOpacity: 0.62,
    features: [],
    masterCacheByScan: {}, // scanId -> { center, groundReferenceH, radiusM: 500, features: [...], taipei8UtilityStatus, timestamp }
    userAsBuiltByScan: {}, // scanId -> array of user-traced open-trench features (isolated NON-API layer)
    selectedFeature: null,
    hoveredFeature: null,
    isQuerying: false,
    loadingPct: 0,
    loadingMsg: "",
    loadingTimer: null,
    threeGroup: null,
    layerMeshes: [], // Merged per-layer THREE.Mesh objects with userData.triToFeature for O(1) raycast picking
    pipeMeshMap: new Map(), // featId_seg -> { mesh, layer, feature, v1, v2, dist, dir }
    groundGridCache: { scanId: null, meshCount: 0, sampler: null },
  };

  /**
   * Safe bilingual translator helper
   */
  function t(zh, en) {
    if (typeof tr === "function") return tr(zh, en);
    const lang = String(document.documentElement.lang || navigator.language || "zh").toLowerCase();
    return lang.startsWith("en") ? en : zh;
  }

  function localizeUtilityText(rawStr, zhFallback, enFallback) {
    let s = String(rawStr || "").trim();
    if (!s) return t(zhFallback || "", enFallback || "");
    if (t("zh", "en") !== "en") return s;
    const osmWayMatch = s.match(/OpenStreetMap\s*[^\d#]*\s*(#\d+)/i);
    if (osmWayMatch) return `OpenStreetMap Way ${osmWayMatch[1]}`;
    if (s.includes("dig.taipei") || s.includes("道路管線暨資訊中心")) return "dig.taipei Road & Pipe Center";
    if (s.includes("pipe.nlma.gov.tw") || s.includes("全國公共管線資料庫")) return "NLMA Public Pipe GIS";
    if (s.includes("OpenStreetMap") && s.includes("座標")) return "OpenStreetMap Map View";
    if (s.includes("NLSC") || s.includes("國土測繪圖資")) return "NLSC Taiwan Map";
    if (s.includes("ArcGIS REST")) return s.replace(/圖層/g, "Layer").replace(/服務/g, "Service");
    const dict = [
      ["台電地下電纜", "Taipower Underground Cable"],
      ["台電高壓管路", "Taipower HV Conduit"],
      ["台電手孔/電桿", "Taipower Manhole / Pole"],
      ["台電手孔", "Taipower Handhole"],
      ["中華電信光纖管道", "CHT Fiber Duct"],
      ["中華電信人手孔", "CHT Telecom Manhole"],
      ["電信光纖管道", "Telecom Fiber Duct"],
      ["雨水下水道箱涵", "Storm Box Culvert"],
      ["雨水箱涵", "Storm Box Culvert"],
      ["單孔箱涵", "Single-Cell Box Culvert"],
      ["雙孔箱涵", "Double-Cell Box Culvert"],
      ["三孔箱涵", "Triple-Cell Box Culvert"],
      ["雨水連接管", "Storm Lateral Pipe"],
      ["雨水涵管", "Storm Culvert Pipe"],
      ["雨水管線", "Storm Drain Pipe"],
      ["雨水幹線", "Storm Trunk Sewer"],
      ["雨水人孔", "Storm Manhole"],
      ["雨水集水井", "Storm Catch Basin"],
      ["污水下水道管線", "Sanitary Sewer Pipe"],
      ["污水連接管", "Sanitary Lateral Pipe"],
      ["污水管線", "Sanitary Sewer Pipe"],
      ["污水幹線", "Sanitary Trunk Sewer"],
      ["污水人孔", "Sanitary Manhole"],
      ["污水陰井/清除孔", "Sanitary Cleanout / Basin"],
      ["自來水管線", "Water Supply Main"],
      ["自來水幹管", "Water Supply Main"],
      ["自來水制水閥/消防栓", "Water Valve / Hydrant"],
      ["地上式消防栓", "Fire Hydrant"],
      ["地下式消防栓", "Underground Fire Hydrant"],
      ["消防栓", "Fire Hydrant"],
      ["瓦斯中壓管", "Medium-Pressure Gas Main"],
      ["瓦斯低壓管", "Low-Pressure Gas Pipe"],
      ["瓦斯管線", "Natural Gas Pipe"],
      ["瓦斯閥孔", "Gas Valve Box"],
      ["共同管道", "Common Utility Duct"],
      ["寬頻管道", "Broadband Duct"],
      ["路燈線路", "Streetlight Conduit"],
      ["路燈電纜", "Streetlight Cable"],
      ["路燈桿", "Streetlight Pole"],
      ["道路挖掘工程", "Road Excavation Zone"],
      ["明挖竣工實測管線", "User As-Built Trench Pipe"],
      ["使用者 3D 明挖管溝竣工實測", "User 3D Open-Trench As-Built Survey"],
    ];
    for (let i = 0; i < dict.length; i++) {
      if (s.includes(dict[i][0])) s = s.split(dict[i][0]).join(dict[i][1]);
    }
    return typeof window.translateDynamicHtml === "function" ? window.translateDynamicHtml(s) : s;
  }

  function mergeUserAsBuiltFeatures(scanId, baseFeatures) {
    const apiList = (Array.isArray(baseFeatures) ? baseFeatures : []).filter(
      (f) => getFeatProp(f, "origin_class", "api_open_data") !== "user_or_scan_to_bim" && getFeatProp(f, "layer", "") !== "as_built"
    );
    const userList = scanId && Array.isArray(UTILS_STATE.userAsBuiltByScan[scanId]) ? UTILS_STATE.userAsBuiltByScan[scanId] : [];
    const merged = apiList.concat(userList);
    Object.keys(UTILITY_LAYERS).forEach((k) => (UTILITY_LAYERS[k].count = 0));
    merged.forEach((f) => {
      const k = getFeatProp(f, "layer", "storm");
      if (UTILITY_LAYERS[k]) UTILITY_LAYERS[k].count++;
    });
    return merged;
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
   * Filters a cached 500m master feature list client-side to `targetRadiusM` around `center` in < 2ms.
   */
  function filterMasterFeaturesToRadius(masterFeatures, center, targetRadiusM) {
    if (!Array.isArray(masterFeatures) || masterFeatures.length === 0) return [];
    const ce = Number(center?.e);
    const cn = Number(center?.n);
    if (!Number.isFinite(ce) || !Number.isFinite(cn)) return masterFeatures;

    const r = Math.max(10, Number(targetRadiusM) || 250);
    const pPad = 12.0;
    const sPad = 15.0;
    const pxmin = ce - r - pPad;
    const pxmax = ce + r + pPad;
    const pymin = cn - r - pPad;
    const pymax = cn + r + pPad;
    const sxmin = ce - r - sPad;
    const sxmax = ce + r + sPad;
    const symin = cn - r - sPad;
    const symax = cn + r + sPad;

    const out = [];
    for (let i = 0; i < masterFeatures.length; i++) {
      const f = masterFeatures[i];
      const fType = getFeatProp(f, "type", "");
      if (fType === "manhole" || fType === "catch_basin" || fType === "hydrant" || fType === "pole") {
        const c = f.coord || f.geometry?.coordinates;
        if (Array.isArray(c) && c.length >= 2) {
          const ex = Number(c[0]);
          const ny = Number(c[1]);
          if (ex >= pxmin && ex <= pxmax && ny >= pymin && ny <= pymax) {
            out.push(f);
          }
        }
      } else {
        const coords = f.coords || f.geometry?.coordinates || (f.start_coord && f.end_coord ? [f.start_coord, f.end_coord] : null);
        if (!Array.isArray(coords) || coords.length < 2) continue;
        let inside = false;
        for (let j = 0; j < coords.length; j++) {
          const pt = coords[j];
          const ex = Number(pt[0]);
          const ny = Number(pt[1]);
          if (ex >= sxmin && ex <= sxmax && ny >= symin && ny <= symax) {
            inside = true;
            break;
          }
        }
        if (!inside) {
          // Check segment midpoints for long spans crossing the bbox
          for (let j = 0; j < coords.length - 1; j++) {
            const mx = 0.5 * (Number(coords[j][0]) + Number(coords[j + 1][0]));
            const my = 0.5 * (Number(coords[j][1]) + Number(coords[j + 1][1]));
            if (mx >= sxmin && mx <= sxmax && my >= symin && my <= symax) {
              inside = true;
              break;
            }
          }
        }
        if (inside) out.push(f);
      }
    }
    return out;
  }

  /**
   * Dynamically adapts `studioThree.camera.near` based on camera distance so 24-bit depth buffer
   * precision is up to 100x sharper when zoomed out (eliminating distant pipe Z-fighting flicker).
   */
  function ensureAdaptiveCameraNearPlane() {
    const studioThree = window.studioThree;
    if (!studioThree || !studioThree.camera) return;

    function updateNear() {
      if (!studioThree || !studioThree.camera) return;
      const cam = studioThree.camera;
      const target = studioThree.controls && studioThree.controls.target ? studioThree.controls.target : new THREE.Vector3(0, 0, 0);
      const dist = cam.position.distanceTo(target);
      const desiredNear = UTILS_STATE.active
        ? Math.max(0.05, Math.min(4.5, dist * 0.008))
        : 0.03;
      if (Math.abs(cam.near - desiredNear) > desiredNear * 0.12) {
        cam.near = desiredNear;
        cam.updateProjectionMatrix();
      }
    }

    updateNear();
    if (studioThree.controls && !studioThree.controls.__gsUtilNearBound) {
      studioThree.controls.__gsUtilNearBound = true;
      studioThree.controls.addEventListener("change", updateNear);
    }
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
          // Disable depthWrite on translucent ground when X-ray is active so opaque underground pipes never Z-fight with ground tiles
          mat.depthWrite = pct < 15;
        } else {
          mat.transparent = orig.transparent;
          mat.opacity = orig.opacity;
          mat.depthWrite = orig.depthWrite;
        }
        mat.needsUpdate = true;
      });
    });

    ensureAdaptiveCameraNearPlane();
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
    ensureAdaptiveCameraNearPlane();
    if (typeof studioThree.render === "function") {
      studioThree.render();
    } else if (studioThree.renderer && studioThree.camera && studioThree.scene) {
      studioThree.renderer.render(studioThree.scene, studioThree.camera);
    }
  }

  /**
   * Silently pre-warms and persists the 500m server master cache for `scanId` in the background.
   */
  function prewarmScanUtilitiesCache500m(scanId) {
    const sid = String(scanId || "").trim();
    if (!sid || UTILS_STATE.masterCacheByScan[sid] || typeof apiPost !== "function") return;
    setTimeout(async () => {
      try {
        if (UTILS_STATE.masterCacheByScan[sid]) return;
        const res = await apiPost("/api/survey/utilities-query", {
          scan_id: sid,
          radius_m: 500.0,
          force_refresh: false,
        });
        if (res && res.status === "ok" && Array.isArray(res.features) && res.features.length > 0) {
          UTILS_STATE.masterCacheByScan[sid] = {
            center: res.center || null,
            groundReferenceH: Number(res.ground_reference_h ?? res.center?.ground_h ?? res.center?.h),
            radiusM: Math.max(500.0, Number(res.master_cached_radius_m || res.radius_m || 500.0)),
            features: res.features,
            taipei8UtilityStatus: res.taipei_8utility_status || null,
            timestamp: String(res.query_timestamp || ""),
          };
        }
      } catch (_) {}
    }, 600);
  }

  /**
   * Called when switching scans so stale utilities from a previous site are cleared,
   * and automatically triggers a 500m background server cache pre-warm for the new scan.
   */
  function resetUtilitiesOnScanChange(newScanId) {
    UTILS_STATE.active = false;
    UTILS_STATE.loadedScanId = null;
    UTILS_STATE.lastCenter = null;
    UTILS_STATE.features = [];
    UTILS_STATE.selectedFeature = null;
    UTILS_STATE.hoveredFeature = null;
    UTILS_STATE.groundGridCache = { scanId: null, meshCount: 0, sampler: null };
    Object.keys(UTILITY_LAYERS).forEach((k) => {
      UTILITY_LAYERS[k].count = 0;
    });
    hideUtilityHoverTooltip();
    clearUtilitiesVisuals3D();
    restoreUtilitiesGroundOpacity();
    if (newScanId) {
      prewarmScanUtilitiesCache500m(newScanId);
    }
  }

  /**
   * Called when the side panel is closed or switched to another tool.
   */
  function onUtilitiesPanelClosed() {
    UTILS_STATE.active = false;
    hideUtilityHoverTooltip();
    clearUtilitiesVisuals3D();
    restoreUtilitiesGroundOpacity();
  }

  /**
   * Updates the non-blocking loading progress bar inside the Utilities side panel without replacing DOM buttons.
   */
  function updateUtilitiesLoadingBarDom(visible, pct, msg) {
    UTILS_STATE.isQuerying = Boolean(visible);
    UTILS_STATE.loadingPct = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    UTILS_STATE.loadingMsg = String(msg || "");

    const wrap = document.getElementById("utilLoadingBarWrap");
    const fill = document.getElementById("utilLoadingBarFill");
    const pctEl = document.getElementById("utilLoadingBarPct");
    const msgEl = document.getElementById("utilLoadingBarMsg");
    const btnQuery = document.getElementById("btnUtilQuery");

    if (wrap) {
      wrap.style.display = visible ? "flex" : "none";
    }
    if (fill) {
      fill.style.width = `${UTILS_STATE.loadingPct}%`;
    }
    if (pctEl) {
      pctEl.textContent = `${UTILS_STATE.loadingPct}%`;
    }
    if (msgEl && UTILS_STATE.loadingMsg) {
      msgEl.textContent = UTILS_STATE.loadingMsg;
    }
    if (btnQuery) {
      btnQuery.disabled = Boolean(visible);
    }
  }

  function startLoadingProgressTicker(initialMsg) {
    if (UTILS_STATE.loadingTimer) {
      clearInterval(UTILS_STATE.loadingTimer);
      UTILS_STATE.loadingTimer = null;
    }
    let curPct = 14;
    updateUtilitiesLoadingBarDom(true, curPct, initialMsg);
    UTILS_STATE.loadingTimer = setInterval(() => {
      if (!UTILS_STATE.isQuerying) {
        clearInterval(UTILS_STATE.loadingTimer);
        UTILS_STATE.loadingTimer = null;
        return;
      }
      curPct = Math.min(92, curPct + Math.max(2, Math.round((94 - curPct) * 0.18)));
      updateUtilitiesLoadingBarDom(true, curPct, UTILS_STATE.loadingMsg);
    }, 180);
  }

  function stopLoadingProgressTicker() {
    if (UTILS_STATE.loadingTimer) {
      clearInterval(UTILS_STATE.loadingTimer);
      UTILS_STATE.loadingTimer = null;
    }
    updateUtilitiesLoadingBarDom(false, 100, "");
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
      UTILS_STATE.features = mergeUserAsBuiltFeatures(currentScanId, UTILS_STATE.features);
      renderUtilities3D();
      updateUtilitiesPanelMetricsInPlace();
    }
  }

  /**
   * Closes the Public Utilities GIS inspector.
   */
  function closeUtilitiesInspector() {
    UTILS_STATE.active = false;
    hideUtilityHoverTooltip();
    clearUtilitiesVisuals3D();
    restoreUtilitiesGroundOpacity();
    if (typeof closeSidePanel === "function") {
      closeSidePanel();
    }
  }

  /**
   * Updates metrics and layer counts in-place in the side panel without destroying/recreating `#btnUtilQuery`.
   */
  function updateUtilitiesPanelMetricsInPlace() {
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

    const elLen = document.getElementById("utilTotalLen");
    const elPipes = document.getElementById("utilPipeCount");
    const elMh = document.getElementById("utilMhCount");
    if (elLen) elLen.textContent = `${Math.round(totalPipeLen)}m`;
    if (elPipes) elPipes.textContent = String(totalPipes);
    if (elMh) elMh.textContent = String(totalMh);

    Object.keys(UTILITY_LAYERS).forEach((k) => {
      const cntEl = document.getElementById(`cntUtil_${k}`);
      if (cntEl) {
        const count = UTILITY_LAYERS[k].count || 0;
        cntEl.textContent = String(count);
        cntEl.style.fontWeight = count > 0 ? "700" : "";
        cntEl.style.opacity = count > 0 ? "1" : "0.5";
      }
    });

    const box = document.getElementById("utilSelectedFeatureBox");
    if (box) {
      const rawHtml = UTILS_STATE.selectedFeature
        ? renderSelectedFeatureCardHtml(UTILS_STATE.selectedFeature, { includeLinks: true })
        : `<div class="gs-util-hint-card">${t("懸停或點擊 3D 管線與人孔檢視埋深與管底高程", "Hover or click 3D pipe or manhole to inspect burial depth & invert elevation")}</div>`;
      box.innerHTML = typeof window.translateDynamicHtml === "function" ? window.translateDynamicHtml(rawHtml) : rawHtml;
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

    // 9 Official API Public Utility Layers + 1 Strictly Isolated User/Scan-to-BIM As-Built Layer
    const apiLayerKeys = ["storm", "sanitary", "water", "electric", "telecom", "gas", "ducts", "streetlights", "excavations"];
    const apiLayersHtml = apiLayerKeys
      .map((k) => {
        const l = UTILITY_LAYERS[k];
        if (!l) return "";
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

    const asBuiltLayer = UTILITY_LAYERS.as_built;
    const asBuiltCount = asBuiltLayer ? asBuiltLayer.count || 0 : 0;
    const asBuiltChecked = asBuiltLayer && asBuiltLayer.visible !== false ? "checked" : "";
    const layersHtml = `
      <div style="margin:0 0 4px 0;font-size:9.5px;font-weight:700;color:var(--ui-text-muted);display:flex;align-items:center;justify-content:space-between;">
        <span>${t("官方開放 API 圖資 (9 圖層)", "Official Open API Layers (9)")}</span>
        <span style="font-size:9px;color:#38bdf8;">OPEN API</span>
      </div>
      ${apiLayersHtml}
      <div style="margin:6px 0 4px 0;padding-top:6px;border-top:1px dashed rgba(148,163,184,0.28);font-size:9.5px;font-weight:700;color:var(--ui-text-muted);display:flex;align-items:center;justify-content:space-between;">
        <span>${t("自建 / Scan-to-BIM 獨立圖層 (與 API 嚴格隔離)", "User / Scan-to-BIM Isolated Layer")}</span>
        <span style="font-size:9px;color:#14b8a6;">NON-API</span>
      </div>
      <div class="gs-util-layer-row" data-layer="as_built" style="background:rgba(20,184,166,0.06);border:1px solid rgba(20,184,166,0.22);border-radius:6px;padding:3px 6px;">
        <label class="gs-util-checkbox-label">
          <input type="checkbox" id="chkUtil_as_built" data-layer="as_built" ${asBuiltChecked} />
          <span class="gs-util-color-dot" style="background:${asBuiltLayer.color};box-shadow:0 0 6px ${asBuiltLayer.color}44;"></span>
          <span class="gs-util-layer-name">${t("竣工實測 / Scan-to-BIM 自建管線", "User / Scan-to-BIM As-Built Pipes")}</span>
        </label>
        <span class="gs-util-count-pill" id="cntUtil_as_built" style="${asBuiltCount > 0 ? "font-weight:700;color:#14b8a6;" : "opacity:0.5;"}">${asBuiltCount}</span>
      </div>
    `;

    const selCardHtml = UTILS_STATE.selectedFeature
      ? renderSelectedFeatureCardHtml(UTILS_STATE.selectedFeature, { includeLinks: true })
      : `<div class="gs-util-hint-card">${t("懸停或點擊 3D 管線與人孔檢視埋深與管底高程", "Hover or click 3D pipe or manhole to inspect burial depth & invert elevation")}</div>`;

    const cacheBadgeHtml =
      UTILS_STATE.features && UTILS_STATE.features.length > 0
        ? `<span class="gs-util-cache-pill ${UTILS_STATE.isCached ? "cached" : "live"}" title="${escapeHtml(UTILS_STATE.cacheTimestamp || t("伺服器已自動快取 500m 範圍管線，預設顯示 250m", "500m radius automatically cached on server; showing 250m by default"))}">
             ${SVG.CHECK} ${UTILS_STATE.isCached ? t("500m已快取", "500m Cached") : t("500m已同步", "500m Synced")}
           </span>`
        : "";

    const tpeStatus = UTILS_STATE.taipei8UtilityStatus;
    const tpeBannerHtml =
      tpeStatus && tpeStatus.integrated
        ? `<div style="margin-top:7px;padding:6px 8px;border-radius:6px;font-size:10px;line-height:1.45;background:${
            tpeStatus.whitelisted ? "rgba(16,185,129,0.10)" : "rgba(56,189,248,0.09)"
          };border:1px solid ${tpeStatus.whitelisted ? "rgba(16,185,129,0.32)" : "rgba(56,189,248,0.28)"};color:var(--ui-text-secondary);">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;font-weight:700;color:${
              tpeStatus.whitelisted ? "#34d399" : "#38bdf8"
            };margin-bottom:2px;">
              <span>${SVG.INFO} ${t("臺北市道管中心 3D 八大管線 API (801–808)", "Taipei 3D 8-Utilities API (801–808)")}</span>
              <span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(15,23,42,0.35);">${
                tpeStatus.whitelisted ? t("已授權連線", "AUTHORIZED") : t("功能已就緒 / 待IP白名單", "READY / AWAITING IP")
              }</span>
            </div>
            <div>${escapeHtml(t(tpeStatus.message_zh || "", tpeStatus.message_en || ""))}</div>
          </div>`
        : "";

    const html = `
      <div class="gs-util-panel-container">
        <!-- Search & Control Header -->
        <div class="gs-util-section-card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
            <label class="gs-util-field-label" style="margin:0;">${t("顯示半徑 (預設 250m / 500m 自動快取)", "Display Radius (250m Default / 500m Cached)")}</label>
            ${cacheBadgeHtml}
          </div>
          <div class="gs-util-row-flex" style="margin-bottom:8px;">
            <div style="display:flex;align-items:center;gap:4px;flex:1;">
              <input type="number" id="inpUtilRadius" class="gs-input gs-util-input" min="10" max="1000" step="10" value="${UTILS_STATE.radiusM}" />
              <span style="font-size:11px;font-weight:600;color:var(--ui-text-muted);">m</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              <button type="button" class="gs-btn gs-btn-primary btn-xs primary" id="btnUtilQuery" title="${t("背景查詢並更新 500m 伺服器管線圖資快取", "Query in background and update 500m server utilities cache")}">
                ${SVG.RESET} ${t("同步", "Sync")}
              </button>
              <button type="button" class="gs-btn btn-xs" id="btnUtilUpload" title="${t("匯入 MOI NGIS GML 3.1.1、GeoJSON 或 KML 管線檔案", "Import MOI NGIS GML 3.1.1, GeoJSON, or KML file")}">
                ${SVG.UPLOAD} ${t("匯入", "Import")}
              </button>
              <input type="file" id="inpUtilFile" accept=".gml,.xml,.json,.geojson,.kml,.csv" style="display:none;" />
            </div>
          </div>

          <!-- Non-Blocking Background Query Loading Progress Bar -->
          <div id="utilLoadingBarWrap" class="gs-util-loading-bar-wrap" style="display:${UTILS_STATE.isQuerying ? "flex" : "none"};">
            <div class="gs-util-loading-header">
              <span id="utilLoadingBarMsg">${escapeHtml(UTILS_STATE.loadingMsg || t("正在背景載入 500m 公共管線圖資...", "Loading 500m public utilities in background..."))}</span>
              <span id="utilLoadingBarPct">${UTILS_STATE.loadingPct || 15}%</span>
            </div>
            <div class="gs-util-loading-track">
              <div id="utilLoadingBarFill" class="gs-util-loading-fill" style="width:${UTILS_STATE.loadingPct || 15}%;"></div>
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
          ${tpeBannerHtml}
        </div>

        <!-- 10 Layers Toggle List -->
        <div class="gs-util-section-card">
          <div class="gs-util-section-header">
            <span>${SVG.EYE} ${t("管線圖層 (10 類)", "Utility Layers")}</span>
            <div style="display:flex;gap:5px;">
              <button type="button" class="gs-btn gs-btn-sm btn-xs" id="btnUtilAllLayers">${t("全選", "All")}</button>
              <button type="button" class="gs-btn gs-btn-sm btn-xs" id="btnUtilNoneLayers">${t("全無", "None")}</button>
            </div>
          </div>
          <div class="gs-util-layers-list">
            ${layersHtml}
          </div>
        </div>

        <!-- Subsurface Ground X-Ray Translucency Controls -->
        <div class="gs-util-section-card">
          <div class="gs-util-section-header">
            <span>${SVG.LAYERS} ${t("地底透視強度", "Subsurface Ground X-Ray")}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
            <span style="font-size:10px;color:var(--ui-text-muted);min-width:44px;">${t("地面透視", "X-Ray")}</span>
            <input type="range" id="rngUtilGroundXray" class="gs-brightness-slider" min="0" max="80" step="2" value="${UTILS_STATE.groundXrayPct}" style="flex:1;" />
            <span style="font-size:11px;font-weight:600;min-width:32px;text-align:right;" id="lblUtilGroundXray">${UTILS_STATE.groundXrayPct}%</span>
          </div>
        </div>

        <!-- Selected Feature Inspector Card -->
        <div id="utilSelectedFeatureBox">
          ${selCardHtml}
        </div>

        <!-- Action Export Bar -->
        <div style="display:flex;gap:6px;margin-top:10px;">
          <button type="button" class="gs-btn btn-xs" id="btnUtilExportGeoJson" style="flex:1;">
            ${SVG.EXPORT} GeoJSON
          </button>
          <button type="button" class="gs-btn btn-xs" id="btnUtilExportDxf" style="flex:1;">
            ${SVG.EXPORT} DXF
          </button>
          <button type="button" class="gs-btn btn-xs" id="btnUtilReset" style="width:auto;" title="${t("清除管線圖資", "Clear utilities")}">
            ${SVG.RESET} ${t("清除", "Clear")}
          </button>
        </div>
      </div>
    `;

    if (typeof showSidePanel === "function") {
      showSidePanel(title, html);
    }
    const contentEl = document.getElementById("studioSidePanelContent");
    if (contentEl) {
      contentEl.scrollTop = 0;
    }

    bindUtilitiesPanelEvents();
  }

  /**
   * Renders the engineering detail card for a 3D pipe, box culvert, or manhole.
   * When `opts.includeLinks === false` (used by the 3D Hover Tooltip), omits the external links bar.
   */
  function renderSelectedFeatureCardHtml(feat, opts = { includeLinks: true }) {
    if (!feat) return "";
    const includeLinks = !opts || opts.includeLinks !== false;
    const layerId = getFeatProp(feat, "layer", "storm");
    const lyr = UTILITY_LAYERS[layerId] || { name_zh: layerId, name_en: layerId, color: "#94a3b8" };
    const fType = getFeatProp(feat, "type", feat.geometry?.type === "Point" ? "manhole" : "pipe");
    const nameStr = localizeUtilityText(getFeatProp(feat, "name", getFeatProp(feat, "id", "Utility")), "公共管線", "Utility");
    const sourceStr = localizeUtilityText(getFeatProp(feat, "source", "Taiwan Open GIS"), "臺灣開放管線圖資", "Taiwan Open GIS");
    const diaMm = Number(getFeatProp(feat, "diameter_mm", 0));
    const widthM = Number(getFeatProp(feat, "width_m", 0));
    const heightM = Number(getFeatProp(feat, "height_m", 0));
    const diaText = diaMm > 0 ? `Ø${diaMm}mm` : "--";
    const dimText = fType === "box_culvert" && widthM > 0 && heightM > 0 ? `${widthM.toFixed(2)}×${heightM.toFixed(2)}m` : diaText;

    const computed = feat.__computed3D || {};
    const isManhole = fType === "manhole" || fType === "catch_basin" || fType === "hydrant" || fType === "pole";
    const originClass = getFeatProp(feat, "origin_class", layerId === "as_built" ? "user_or_scan_to_bim" : "api_open_data");
    const originBadgeHtml =
      originClass === "user_or_scan_to_bim"
        ? `<span class="gs-util-badge" style="background:rgba(20,184,166,0.16);color:#14b8a6;border:1px solid rgba(20,184,166,0.4);font-size:9.5px;">${t("自建 / Scan-to-BIM 圖層", "User / Scan-to-BIM Layer")}</span>`
        : `<span class="gs-util-badge" style="background:rgba(56,189,248,0.14);color:#38bdf8;border:1px solid rgba(56,189,248,0.35);font-size:9.5px;">${t("官方開放 API 圖資", "Official API Record")}</span>`;

    let linksBarHtml = "";
    if (includeLinks) {
      const portalUrl = getFeatProp(feat, "portal_url", "");
      const portalLabel = localizeUtilityText(getFeatProp(feat, "portal_label", ""), "政府管線圖資入口網", "Gov GIS Portal");
      const apiUrl = getFeatProp(feat, "api_url", "");
      const apiLabel = localizeUtilityText(getFeatProp(feat, "api_label", ""), "ArcGIS REST API", "ArcGIS REST API");
      const osmUrl = getFeatProp(feat, "osm_url", "");
      const osmLabel = localizeUtilityText(getFeatProp(feat, "osm_label", ""), "OpenStreetMap", "OpenStreetMap");
      const nlscUrl = getFeatProp(feat, "nlsc_url", "");
      const nlscLabel = localizeUtilityText(getFeatProp(feat, "nlsc_label", ""), "國土測繪圖資雲", "NLSC Taiwan Map");

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
      if (linkPills.length > 0) {
        linksBarHtml = `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;padding-top:5px;border-top:1px solid rgba(148,163,184,0.16);">${linkPills.join("")}</div>`;
      }
    }

    if (isManhole) {
      const depthVal = computed.depthM ?? getFeatProp(feat, "depth_m", undefined);
      const rimVal = computed.rimH ?? getFeatProp(feat, "rim_h", undefined);
      const invVal = computed.invertH ?? getFeatProp(feat, "invert_h", undefined);
      const depthStr = depthVal !== undefined ? `${Number(depthVal).toFixed(2)}m` : "--";
      const rimStr = rimVal !== undefined ? `${Number(rimVal).toFixed(2)}m` : "--";
      const invStr = invVal !== undefined ? `${Number(invVal).toFixed(2)}m` : "--";

      return `
        <div class="gs-util-detail-card" style="border-left:3px solid ${lyr.color};">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;margin-bottom:4px;flex-wrap:wrap;">
            <span style="font-weight:700;font-size:12px;color:var(--ui-text-primary);">${escapeHtml(nameStr)}</span>
            <div style="display:flex;align-items:center;gap:4px;">
              ${originBadgeHtml}
              <span class="gs-util-badge" style="background:${lyr.color}22;color:${lyr.color};border:1px solid ${lyr.color}44;">
                ${t(lyr.name_zh, lyr.name_en)}
              </span>
            </div>
          </div>
          <div class="gs-util-detail-grid">
            <div><span class="gs-util-detail-lbl">${t("孔徑/尺寸", "Size")}:</span> <b>${escapeHtml(dimText)}</b></div>
            <div><span class="gs-util-detail-lbl">${t("人孔埋深", "Depth")}:</span> <b>${depthStr}</b></div>
            <div><span class="gs-util-detail-lbl">${t("路面高程", "Rim EL")}:</span> <b>${rimStr}</b></div>
            <div><span class="gs-util-detail-lbl">${t("孔底高程", "Inv EL")}:</span> <b>${invStr}</b></div>
          </div>
          <div style="font-size:10px;color:var(--ui-text-muted);margin-top:4px;">
            ${t("資料來源", "Source")}: ${escapeHtml(sourceStr)}
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
        <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;margin-bottom:4px;flex-wrap:wrap;">
          <span style="font-weight:700;font-size:12px;color:var(--ui-text-primary);">${escapeHtml(nameStr)}</span>
          <div style="display:flex;align-items:center;gap:4px;">
            ${originBadgeHtml}
            <span class="gs-util-badge" style="background:${lyr.color}22;color:${lyr.color};border:1px solid ${lyr.color}44;">
              ${t(lyr.name_zh, lyr.name_en)}
            </span>
          </div>
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
          ${t("資料來源", "Source")}: ${escapeHtml(sourceStr)}
        </div>
        ${linksBarHtml}
      </div>
    `;
  }

  /**
   * Applies a radius change immediately in-place using the cached 500m master features
   * (without destroying DOM nodes on blur so clicking `#btnUtilQuery` never misfires).
   */
  function applyRadiusChangeFromCacheOrQuery(newRadiusM) {
    const r = Math.max(10, Math.min(1000, Number(newRadiusM) || 250));
    UTILS_STATE.radiusM = r;
    const scanId = String((typeof STATE !== "undefined" && STATE.activeScanId) || "");
    const masterEntry = scanId ? UTILS_STATE.masterCacheByScan[scanId] : null;
    if (masterEntry && Array.isArray(masterEntry.features) && r <= (masterEntry.radiusM || 500) + 5) {
      const clipped = filterMasterFeaturesToRadius(masterEntry.features, masterEntry.center, r);
      UTILS_STATE.features = mergeUserAsBuiltFeatures(scanId, clipped);
      renderUtilities3D({
        center: masterEntry.center,
        ground_reference_h: masterEntry.groundReferenceH,
      });
      updateUtilitiesPanelMetricsInPlace();
      return;
    }
    runUtilitiesQuery(false);
  }

  /**
   * Binds user event listeners inside the inspector side panel.
   * Prevents the blur-vs-click race condition by updating in-place on radius edits.
   */
  function bindUtilitiesPanelEvents() {
    const elQuery = document.getElementById("btnUtilQuery");
    if (elQuery) {
      elQuery.onclick = async () => {
        const inpR = document.getElementById("inpUtilRadius");
        if (inpR) {
          UTILS_STATE.radiusM = Math.max(10, Math.min(1000, parseFloat(inpR.value) || 250));
        }
        await runUtilitiesQuery(true);
      };
    }

    const inpR = document.getElementById("inpUtilRadius");
    if (inpR) {
      let radiusDebounce = null;
      inpR.oninput = () => {
        const parsed = parseFloat(inpR.value);
        if (!Number.isFinite(parsed) || parsed < 10) return;
        if (radiusDebounce) clearTimeout(radiusDebounce);
        radiusDebounce = setTimeout(() => {
          applyRadiusChangeFromCacheOrQuery(Math.max(10, Math.min(1000, parsed)));
        }, 140);
      };
      inpR.onkeydown = (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          if (radiusDebounce) clearTimeout(radiusDebounce);
          const parsed = Math.max(10, Math.min(1000, parseFloat(inpR.value) || 250));
          inpR.value = String(parsed);
          applyRadiusChangeFromCacheOrQuery(parsed);
        }
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
        hideUtilityHoverTooltip();
        clearUtilitiesVisuals3D();
        restoreUtilitiesGroundOpacity();
        UTILS_STATE.features = [];
        UTILS_STATE.selectedFeature = null;
        UTILS_STATE.loadedScanId = null;
        UTILS_STATE.isCached = false;
        Object.keys(UTILITY_LAYERS).forEach((k) => (UTILITY_LAYERS[k].count = 0));
        renderUtilitiesSidePanel();
      };
    }
  }

  /**
   * Queries genuine Taiwan Open APIs in the background via `/api/survey/utilities-query`
   * with a non-blocking progress bar. Always ensures 500m is queried and cached on the server
   * while displaying `UTILS_STATE.radiusM` (default 250m) in the 3D scene.
   */
  async function runUtilitiesQuery(forceRefresh = false) {
    if (UTILS_STATE.isQuerying) return;
    const scanId = String((typeof STATE !== "undefined" && STATE.activeScanId) || "");
    const displayRadiusM = Math.max(10.0, Math.min(1000.0, Number(UTILS_STATE.radiusM) || 250.0));
    const queryRadiusM = Math.max(displayRadiusM, 500.0);

    // Fast in-memory 500m cache hit when not forcing a live refresh
    const memMaster = scanId ? UTILS_STATE.masterCacheByScan[scanId] : null;
    if (!forceRefresh && memMaster && Array.isArray(memMaster.features) && memMaster.features.length > 0 && displayRadiusM <= (memMaster.radiusM || 500.0) + 5.0) {
      UTILS_STATE.loadedScanId = scanId;
      UTILS_STATE.lastCenter = memMaster.center;
      UTILS_STATE.groundReferenceH = memMaster.groundReferenceH;
      UTILS_STATE.isCached = true;
      UTILS_STATE.cacheTimestamp = memMaster.timestamp || "";
      UTILS_STATE.taipei8UtilityStatus = memMaster.taipei8UtilityStatus || null;
      const clipped = filterMasterFeaturesToRadius(memMaster.features, memMaster.center, displayRadiusM);
      UTILS_STATE.features = mergeUserAsBuiltFeatures(scanId, clipped);
      if (UTILS_STATE.active) {
        renderUtilities3D({ center: memMaster.center, ground_reference_h: memMaster.groundReferenceH });
        if (!UTILS_STATE.selectedFeature || !UTILS_STATE.features.includes(UTILS_STATE.selectedFeature)) {
          UTILS_STATE.selectedFeature =
            UTILS_STATE.features.find((f) => getFeatProp(f, "type", "") === "pipe" || getFeatProp(f, "type", "") === "box_culvert") ||
            UTILS_STATE.features[0] ||
            null;
        }
        renderUtilitiesSidePanel();
        applyUtilitiesGroundXray(UTILS_STATE.groundXrayPct);
      }
      return;
    }

    startLoadingProgressTicker(
      forceRefresh
        ? t("正在背景向政府 API 同步 500m 公共管線並更新伺服器快取...", "Syncing 500m public utilities in background & updating server cache...")
        : t("正在背景載入 500m 公共管線圖資 (顯示 250m)...", "Loading 500m public utilities in background (displaying 250m)...")
    );

    try {
      const payload = {
        scan_id: scanId,
        radius_m: queryRadiusM,
        force_refresh: Boolean(forceRefresh),
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
        updateUtilitiesLoadingBarDom(
          true,
          95,
          t("正在建構 3D 批次管網模型...", "Building batched 3D utility network...")
        );
        // Yield 1 animation frame so the progress bar paints smoothly before 3D mesh generation
        await new Promise((resolve) => requestAnimationFrame(resolve));

        const groundRefH = Number(res.ground_reference_h ?? res.center?.ground_h ?? res.center?.h);
        if (scanId) {
          UTILS_STATE.masterCacheByScan[scanId] = {
            center: res.center || null,
            groundReferenceH: groundRefH,
            radiusM: queryRadiusM,
            features: res.features,
            taipei8UtilityStatus: res.taipei_8utility_status || null,
            timestamp: String(res.query_timestamp || ""),
          };
        }

        UTILS_STATE.loadedScanId = scanId;
        UTILS_STATE.lastCenter = res.center || null;
        UTILS_STATE.groundReferenceH = groundRefH;
        UTILS_STATE.isCached = Boolean(res.cached);
        UTILS_STATE.cacheTimestamp = String(res.query_timestamp || "");
        UTILS_STATE.taipei8UtilityStatus = res.taipei_8utility_status || null;

        const shownFeatures =
          displayRadiusM < queryRadiusM - 1.0
            ? filterMasterFeaturesToRadius(res.features, res.center, displayRadiusM)
            : res.features;
        UTILS_STATE.features = mergeUserAsBuiltFeatures(scanId, shownFeatures);

        stopLoadingProgressTicker();

        if (!UTILS_STATE.active || (typeof STATE !== "undefined" && STATE.activeTool !== "utilities")) {
          return;
        }

        renderUtilities3D(res);
        if (
          !UTILS_STATE.selectedFeature ||
          !UTILS_STATE.features.some((f) => getFeatProp(f, "id", "") === getFeatProp(UTILS_STATE.selectedFeature, "id", "__none__"))
        ) {
          UTILS_STATE.selectedFeature =
            UTILS_STATE.features.find((f) => getFeatProp(f, "type", "") === "pipe" || getFeatProp(f, "type", "") === "box_culvert" || f.geometry?.type === "LineString") ||
            UTILS_STATE.features[0] ||
            null;
        }
        renderUtilitiesSidePanel();
        applyUtilitiesGroundXray(UTILS_STATE.groundXrayPct);

        if (typeof showToast === "function") {
          showToast(
            t(
              `已載入 ${UTILS_STATE.features.length} 筆管線 (顯示 ${Math.round(displayRadiusM)}m / 伺服器已快取 ${Math.round(queryRadiusM)}m 共 ${res.total_features} 筆)`,
              `Loaded ${UTILS_STATE.features.length} utilities (${Math.round(displayRadiusM)}m shown / ${res.total_features} cached at ${Math.round(queryRadiusM)}m)`
            )
          );
        }
      } else {
        stopLoadingProgressTicker();
        const errMsg = res?.error || t("該區域未涵蓋開放公共管線資料", "No public utility features found in coverage area");
        if (typeof showToast === "function") showToast(errMsg);
      }
    } catch (err) {
      stopLoadingProgressTicker();
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
    startLoadingProgressTicker(t("正在解析管線圖資檔案...", "Parsing utility file..."));

    try {
      const payload = {
        file_content: content,
        filename: filename,
      };
      const res = typeof apiPost === "function" ? await apiPost("/api/survey/utilities-parse", payload) : null;
      stopLoadingProgressTicker();
      if (res && res.status === "ok" && Array.isArray(res.features)) {
        UTILS_STATE.features = res.features;
        UTILS_STATE.loadedScanId = String((typeof STATE !== "undefined" && STATE.activeScanId) || "");
        UTILS_STATE.isCached = false;

        Object.keys(UTILITY_LAYERS).forEach((k) => (UTILITY_LAYERS[k].count = 0));
        if (res.layer_counts) {
          Object.keys(res.layer_counts).forEach((k) => {
            if (UTILITY_LAYERS[k]) UTILITY_LAYERS[k].count = res.layer_counts[k];
          });
        }

        renderUtilities3D(res);
        UTILS_STATE.selectedFeature =
          UTILS_STATE.features.find((f) => getFeatProp(f, "type", "") === "pipe" || f.geometry?.type === "LineString") ||
          UTILS_STATE.features[0] ||
          null;
        renderUtilitiesSidePanel();
        applyUtilitiesGroundXray(UTILS_STATE.groundXrayPct);

        if (typeof showToast === "function") {
          showToast(t(`成功匯入 ${res.total_features} 筆管線圖資 (${res.format})`, `Imported ${res.total_features} features (${res.format})`));
        }
      } else {
        if (typeof showToast === "function") {
          showToast(res?.error || t("管線圖資格式錯誤", "Invalid utility file format"));
        }
      }
    } catch (err) {
      stopLoadingProgressTicker();
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
   * Clears all 3D Three.js utilities visuals from studioThree scene (including any orphaned PublicUtilitiesGroup).
   */
  function clearUtilitiesVisuals3D() {
    function disposeGroupTree(grp) {
      if (!grp) return;
      grp.traverse((obj) => {
        if (obj.geometry) {
          try {
            obj.geometry.dispose();
          } catch (_) {}
        }
        if (obj.material) {
          try {
            if (Array.isArray(obj.material)) obj.material.forEach((m) => m && m.dispose && m.dispose());
            else if (obj.material.dispose) obj.material.dispose();
          } catch (_) {}
        }
      });
    }

    const studioThree = window.studioThree;
    if (studioThree) {
      const roots = [studioThree.overlayGroup, studioThree.scene].filter(Boolean);
      roots.forEach((root) => {
        const toRemove = [];
        root.children.forEach((ch) => {
          if (ch === UTILS_STATE.threeGroup || (ch && ch.name === "PublicUtilitiesGroup")) {
            toRemove.push(ch);
          }
        });
        toRemove.forEach((ch) => {
          root.remove(ch);
          disposeGroupTree(ch);
        });
      });
      if (UTILS_STATE.threeGroup) {
        disposeGroupTree(UTILS_STATE.threeGroup);
      }
      if (typeof studioThree.render === "function") {
        studioThree.render();
      } else if (studioThree.renderer && studioThree.camera && studioThree.scene) {
        studioThree.renderer.render(studioThree.scene, studioThree.camera);
      }
    }
    UTILS_STATE.threeGroup = null;
    UTILS_STATE.layerMeshes = [];
    UTILS_STATE.pipeMeshMap.clear();
  }

  /**
   * Builds a blazing-fast (< 3ms) bare-earth 2D spatial elevation grid from the scan's mesh vertices
   * and categorized road/tree-base points. Replaces slow per-vertex `THREE.Raycaster.intersectObjects`
   * so large sloped scans like QiHu Park (4,277+ features) render in < 35ms with zero main-thread freeze.
   */
  function createCanopyRejectingGroundSampler(payload, originTwd) {
    const meshes = typeof getStudioRaycastMeshes === "function" ? getStudioRaycastMeshes() : [];
    const currentScanId = String((typeof STATE !== "undefined" && STATE.activeScanId) || "");
    if (
      UTILS_STATE.groundGridCache.sampler &&
      UTILS_STATE.groundGridCache.scanId === currentScanId &&
      UTILS_STATE.groundGridCache.meshCount === (meshes ? meshes.length : 0)
    ) {
      return UTILS_STATE.groundGridCache.sampler;
    }

    const cellSize = 4.0;
    const cellMinY = new Map(); // "gx_gz" -> lowest bare-earth local Y in 4m cell
    const anchorPts = []; // [{ x, z, y }]
    const roadSamplesY = [];

    function addGroundSample(lx, lz, ly, isRoadAnchor = false) {
      if (!Number.isFinite(lx) || !Number.isFinite(lz) || !Number.isFinite(ly)) return;
      const gx = Math.floor(lx / cellSize);
      const gz = Math.floor(lz / cellSize);
      const key = `${gx}_${gz}`;
      const prev = cellMinY.get(key);
      if (prev === undefined || ly < prev) {
        cellMinY.set(key, ly);
      }
      if (isRoadAnchor) {
        roadSamplesY.push(ly);
        anchorPts.push({ x: lx, z: lz, y: ly });
      }
    }

    // 1. Ingest categorized roads and tree trunk bases
    const catData = typeof STATE !== "undefined" ? STATE.categorizeData : null;
    if (catData) {
      if (Array.isArray(catData.roads)) {
        catData.roads.forEach((r) => {
          const ry = Number.isFinite(r.elevation_local_y)
            ? Number(r.elevation_local_y)
            : Number.isFinite(r.elevation_twd97_z)
            ? Number(r.elevation_twd97_z) - originTwd.h
            : NaN;
          if (Number.isFinite(ry)) {
            roadSamplesY.push(ry);
            if (Array.isArray(r.center_twd97) && r.center_twd97.length >= 2) {
              addGroundSample(Number(r.center_twd97[0]) - originTwd.e, originTwd.n - Number(r.center_twd97[1]), ry, true);
            }
          }
          if (Array.isArray(r.boundary_twd97)) {
            const stride = Math.max(1, Math.floor(r.boundary_twd97.length / 24));
            for (let i = 0; i < r.boundary_twd97.length; i += stride) {
              const pt = r.boundary_twd97[i];
              if (Array.isArray(pt) && pt.length >= 3) {
                addGroundSample(Number(pt[0]) - originTwd.e, originTwd.n - Number(pt[1]), Number(pt[2]) - originTwd.h, true);
              }
            }
          }
        });
      }
      if (Array.isArray(catData.trees)) {
        catData.trees.forEach((trObj) => {
          if (Array.isArray(trObj.base_local) && trObj.base_local.length >= 3) {
            addGroundSample(Number(trObj.base_local[0]), Number(trObj.base_local[2]), Number(trObj.base_local[1]), true);
          }
        });
      }
    }

    // 2. Single-pass strided vertex scan across 3D scan meshes (< 3ms for millions of vertices, zero raycasting!)
    if (meshes && meshes.length > 0 && window.THREE) {
      const tmpV = new THREE.Vector3();
      let totalVerts = 0;
      meshes.forEach((m) => {
        const pos = m && m.geometry && m.geometry.attributes && m.geometry.attributes.position;
        if (pos && pos.count) totalVerts += pos.count;
      });
      const targetSamples = 24000;
      const stride = Math.max(1, Math.floor(totalVerts / targetSamples));

      meshes.forEach((m) => {
        const pos = m && m.geometry && m.geometry.attributes && m.geometry.attributes.position;
        if (!pos || !pos.count) return;
        m.updateMatrixWorld();
        const matW = m.matrixWorld;
        for (let i = 0; i < pos.count; i += stride) {
          tmpV.fromBufferAttribute(pos, i).applyMatrix4(matW);
          if (Number.isFinite(tmpV.y) && tmpV.y > -200 && tmpV.y < 500) {
            addGroundSample(tmpV.x, tmpV.z, tmpV.y, false);
          }
        }
      });
    }

    // Collect sparse cell centers for fast nearest-cell interpolation outside direct cell hits
    cellMinY.forEach((ly, key) => {
      const parts = key.split("_");
      const cx = (Number(parts[0]) + 0.5) * cellSize;
      const cz = (Number(parts[1]) + 0.5) * cellSize;
      roadSamplesY.push(ly);
      if (anchorPts.length < 600) {
        anchorPts.push({ x: cx, z: cz, y: ly });
      }
    });

    let roadRefY = 0.0;
    const centerGroundH = Number(
      payload?.ground_reference_h ??
        payload?.center?.ground_h ??
        payload?.center?.h ??
        UTILS_STATE.groundReferenceH ??
        UTILS_STATE.lastCenter?.ground_h ??
        UTILS_STATE.lastCenter?.h
    );
    if (roadSamplesY.length > 0) {
      roadSamplesY.sort((a, b) => a - b);
      const idx25 = Math.max(0, Math.min(roadSamplesY.length - 1, Math.floor(roadSamplesY.length * 0.25)));
      roadRefY = roadSamplesY[idx25];
    } else if (Number.isFinite(centerGroundH) && centerGroundH > -100) {
      roadRefY = centerGroundH - originTwd.h;
    }

    const queryCache = new Map();
    const sampler = function sampleLocalGroundY(lx, lz, fallbackGroundH) {
      const gx = Math.floor(lx / cellSize);
      const gz = Math.floor(lz / cellSize);
      const cKey = `${gx}_${gz}`;
      if (queryCache.has(cKey)) return queryCache.get(cKey);

      // Check 3x3 neighborhood in the 4m bare-earth grid and pick the minimum bare-earth Y (rejecting tree canopies/cars)
      let minNeighborY = Infinity;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const val = cellMinY.get(`${gx + dx}_${gz + dz}`);
          if (val !== undefined && val < minNeighborY) {
            minNeighborY = val;
          }
        }
      }
      if (Number.isFinite(minNeighborY)) {
        queryCache.set(cKey, minNeighborY);
        return minNeighborY;
      }

      // Outside 3D scan mesh footprint: use backend surveyed ground_h if valid, or inverse-distance weighted nearest anchor
      if (Number.isFinite(Number(fallbackGroundH)) && Number(fallbackGroundH) > -100) {
        const fbY = Number(fallbackGroundH) - originTwd.h;
        queryCache.set(cKey, fbY);
        return fbY;
      }

      if (anchorPts.length > 0) {
        let minD2 = Infinity;
        let nearestY = roadRefY;
        for (let i = 0; i < anchorPts.length; i++) {
          const p = anchorPts[i];
          const d2 = (p.x - lx) * (p.x - lx) + (p.z - lz) * (p.z - lz);
          if (d2 < minD2) {
            minD2 = d2;
            nearestY = p.y;
          }
        }
        queryCache.set(cKey, nearestY);
        return nearestY;
      }

      queryCache.set(cKey, roadRefY);
      return roadRefY;
    };

    UTILS_STATE.groundGridCache = {
      scanId: currentScanId,
      meshCount: meshes ? meshes.length : 0,
      sampler: sampler,
    };
    return sampler;
  }

  /**
   * Precomputes unit Cylinder and Box geometry templates so stamping thousands of pipes,
   * box culverts, and manholes into per-layer merged `Float32Array` buffers takes < 15ms.
   */
  let _UNIT_TEMPLATES = null;
  function getUnitGeometryTemplates() {
    if (_UNIT_TEMPLATES) return _UNIT_TEMPLATES;
    const cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1.0, 10, 1, false).toNonIndexed();
    const boxGeo = new THREE.BoxGeometry(1.0, 1.0, 1.0).toNonIndexed();
    _UNIT_TEMPLATES = {
      cylPos: cylGeo.attributes.position.array,
      cylNorm: cylGeo.attributes.normal.array,
      cylVerts: cylGeo.attributes.position.count,
      boxPos: boxGeo.attributes.position.array,
      boxNorm: boxGeo.attributes.normal.array,
      boxVerts: boxGeo.attributes.position.count,
    };
    return _UNIT_TEMPLATES;
  }

  /**
   * Computes a strictly zero-roll orthonormal basis (R, U, F) for a segment along direction `F = (fx, fy, fz)`:
   * - `F`: unit forward vector along the pipe/culvert trajectory
   * - `R`: unit horizontal right vector in the XZ plane (`ry === 0` ALWAYS, eliminating 45-degree diagonal box roll!)
   * - `U`: unit upward roof vector `R × F` (`uy >= 0` ALWAYS)
   */
  function computeZeroRollBasis(fx, fy, fz) {
    const horizLen = Math.hypot(fx, fz);
    let rx, ry, rz, ux, uy, uz;
    if (horizLen > 1e-5) {
      // Horizontal right vector perpendicular to (fx, 0, fz) with zero Y component (0.0 deg roll!)
      rx = -fz / horizLen;
      ry = 0.0;
      rz = fx / horizLen;
      // U = R x F = (ry*fz - rz*fy, rz*fx - rx*fz, rx*fy - ry*fx)
      ux = -rz * fy;
      uy = rz * fx - rx * fz; // = horizLen > 0 (always positive upward!)
      uz = rx * fy;
      const uLen = Math.hypot(ux, uy, uz) || 1.0;
      ux /= uLen;
      uy /= uLen;
      uz /= uLen;
    } else {
      // Vertical shaft (manhole / pole): F = (0, ±1, 0)
      rx = 1.0;
      ry = 0.0;
      rz = 0.0;
      ux = 0.0;
      uy = 0.0;
      uz = fy >= 0 ? 1.0 : -1.0;
    }
    return { rx, ry, rz, ux, uy, uz, fx, fy, fz };
  }

  /**
   * Builds and renders survey-accurate, high-FPS batched 3D subsurface pipelines, box culverts,
   * manholes, flush road manhole covers, and surface alignment traces.
   * - Eliminates QiHu Park lag by merging each layer into 1 Mesh + 1 LineSegments (~20 draw calls total).
   * - Eliminates zoomed-out flickering by using opaque polygonOffset materials + adaptive camera near-plane.
   * - Eliminates 45-degree rotated box culverts in Rose Park via `computeZeroRollBasis`.
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
    ensureAdaptiveCameraNearPlane();

    const originTwd = typeof localToTwd97 === "function" ? localToTwd97({ x: 0, y: 0, z: 0 }) : { e: 0, n: 0, h: 0 };
    const sampleLocalGroundY = createCanopyRejectingGroundSampler(payload, originTwd);
    const tpl = getUnitGeometryTemplates();

    const group = new THREE.Group();
    group.name = "PublicUtilitiesGroup";
    UTILS_STATE.threeGroup = group;

    // Per-layer batch buckets
    const layerBuckets = {};
    Object.keys(UTILITY_LAYERS).forEach((k) => {
      layerBuckets[k] = {
        stamps: [], // [{ isBox, midX, midY, midZ, sx, sy, sz, basis, feat }]
        linePositions: [], // [x1, y1, z1, x2, y2, z2, ...] for surface trace + depth leaders
        firstFeat: null,
      };
    });

    UTILS_STATE.features.forEach((feat) => {
      const layerId = getFeatProp(feat, "layer", "storm");
      const bucket = layerBuckets[layerId] || layerBuckets.storm;
      const ldef = UTILITY_LAYERS[layerId] || UTILITY_LAYERS.storm;
      if (!bucket.firstFeat) bucket.firstFeat = feat;
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
        const isBox = fType === "box_culvert";
        const widthM = isBox ? Math.max(0.35, widthProp || diaM) : diaM;
        const heightM = isBox ? Math.max(0.35, heightProp || diaM) : diaM;

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

        const localVertices = [];
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

          const invertDepthM = Math.max(heightM + 0.5, startDepthM + frac * (endDepthM - startDepthM));
          const invertY = groundY - invertDepthM;
          v.y = invertY + 0.5 * heightM;

          localVertices.push(v);
          vertexGroundYs.push(groundY);
          vertexInvertDepths.push(invertDepthM);
        }

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

        for (let i = 0; i < localVertices.length - 1; i++) {
          const v1 = localVertices[i];
          const v2 = localVertices[i + 1];
          const gY1 = vertexGroundYs[i];
          const gY2 = vertexGroundYs[i + 1];

          const dx = v2.x - v1.x;
          const dy = v2.y - v1.y;
          const dz = v2.z - v1.z;
          const dist = Math.hypot(dx, dy, dz);
          if (dist < 0.05) continue;

          const midX = 0.5 * (v1.x + v2.x);
          const midY = 0.5 * (v1.y + v2.y);
          const midZ = 0.5 * (v1.z + v2.z);
          const basis = computeZeroRollBasis(dx / dist, dy / dist, dz / dist);

          bucket.stamps.push({
            isBox: isBox,
            midX: midX,
            midY: midY,
            midZ: midZ,
            sx: widthM,
            sy: dist,
            sz: heightM,
            basis: basis,
            feat: feat,
          });

          // Surface alignment line segment (elevated +0.06m above road to prevent Z-fighting)
          bucket.linePositions.push(v1.x, gY1 + 0.06, v1.z, v2.x, gY2 + 0.06, v2.z);

          // Vertical depth leader from pipe center up to road surface
          const midGroundY = 0.5 * (gY1 + gY2);
          if (midGroundY > midY + 0.15) {
            bucket.linePositions.push(midX, midY, midZ, midX, midGroundY + 0.05, midZ);
          }

          const meshKey = `${getFeatProp(feat, "id", "pipe")}_seg_${i}`;
          UTILS_STATE.pipeMeshMap.set(meshKey, {
            mesh: null, // Bound to merged layerMesh below
            layer: layerId,
            feature: feat,
            v1: v1,
            v2: v2,
            dist: dist,
            radiusM: 0.5 * Math.max(widthM, heightM),
          });
        }
      }

      // 2. Manhole or Catch Basin (Downward Underground Shaft + Single Clean Surface Rim Cover)
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

        feat.__computed3D = {
          rimH: originTwd.h + rimY,
          invertH: originTwd.h + invertY,
          depthM: depthM,
        };

        const diaMm = Number(getFeatProp(feat, "diameter_mm", fType === "catch_basin" ? 500 : 650)) || 650;
        const coverDia = Math.max(0.68, Math.min(1.15, diaMm / 1000.0));
        const shaftDia = coverDia * 0.9;
        const vertBasis = { rx: 1, ry: 0, rz: 0, ux: 0, uy: 0, uz: 1, fx: 0, fy: 1, fz: 0 };

        // A. Underground Manhole Chamber Cylinder (extending strictly downward from rimY - 0.04 to invertY)
        bucket.stamps.push({
          isBox: false,
          midX: vBase.x,
          midY: rimY - 0.5 * depthM,
          midZ: vBase.z,
          sx: shaftDia,
          sy: depthM,
          sz: shaftDia,
          basis: vertBasis,
          feat: feat,
        });

        // B. Single Clean Surface Manhole Cover Disk at rimY + 0.05m (no overlapping coplanar disks!)
        bucket.stamps.push({
          isBox: false,
          midX: vBase.x,
          midY: rimY + 0.05,
          midZ: vBase.z,
          sx: coverDia * 1.12,
          sy: 0.06,
          sz: coverDia * 1.12,
          basis: vertBasis,
          feat: feat,
        });

        const mhKey = `${getFeatProp(feat, "id", "mh")}_pt`;
        UTILS_STATE.pipeMeshMap.set(mhKey, {
          mesh: null,
          layer: layerId,
          feature: feat,
          v1: new THREE.Vector3(vBase.x, invertY, vBase.z),
          v2: new THREE.Vector3(vBase.x, rimY + 0.08, vBase.z),
          dist: depthM,
          radiusM: coverDia * 0.6,
        });
      }

      // 3. Above-ground Hydrant or Utility Pole
      else if (fType === "hydrant" || fType === "pole") {
        const coord = feat.coord || feat.geometry?.coordinates || [0, 0, 0];
        const vBase = twd97ToLocal(coord[0], coord[1], 0);
        const groundY = sampleLocalGroundY(vBase.x, vBase.z, getFeatProp(feat, "rim_h", NaN));
        const heightM = fType === "pole" ? 6.5 : 0.95;
        const diaM = fType === "pole" ? 0.26 : 0.24;
        const vertBasis = { rx: 1, ry: 0, rz: 0, ux: 0, uy: 0, uz: 1, fx: 0, fy: 1, fz: 0 };

        feat.__computed3D = {
          rimH: originTwd.h + groundY,
          invertH: originTwd.h + groundY - (fType === "pole" ? 0.85 : 1.2),
          depthM: fType === "pole" ? 0.85 : 1.2,
        };

        bucket.stamps.push({
          isBox: false,
          midX: vBase.x,
          midY: groundY + 0.5 * heightM,
          midZ: vBase.z,
          sx: diaM,
          sy: heightM,
          sz: diaM,
          basis: vertBasis,
          feat: feat,
        });

        const ptKey = `${getFeatProp(feat, "id", "pt")}_pole`;
        UTILS_STATE.pipeMeshMap.set(ptKey, {
          mesh: null,
          layer: layerId,
          feature: feat,
          v1: new THREE.Vector3(vBase.x, groundY, vBase.z),
          v2: new THREE.Vector3(vBase.x, groundY + heightM, vBase.z),
          dist: heightM,
          radiusM: diaM,
        });
      }
    });

    // Build 1 Merged Solid Mesh + 1 Merged LineSegments per Utility Layer (~20 draw calls total!)
    const layerMeshById = {};
    Object.keys(UTILITY_LAYERS).forEach((layerId) => {
      const bucket = layerBuckets[layerId];
      const ldef = UTILITY_LAYERS[layerId];
      const isLayerVis = ldef.visible !== false;

      if (bucket.stamps.length > 0) {
        let totalVerts = 0;
        for (let i = 0; i < bucket.stamps.length; i++) {
          totalVerts += bucket.stamps[i].isBox ? tpl.boxVerts : tpl.cylVerts;
        }

        const posArr = new Float32Array(totalVerts * 3);
        const normArr = new Float32Array(totalVerts * 3);
        const triToFeature = new Array(totalVerts / 3);

        let vOffset = 0;
        let triIdx = 0;
        for (let i = 0; i < bucket.stamps.length; i++) {
          const st = bucket.stamps[i];
          const srcPos = st.isBox ? tpl.boxPos : tpl.cylPos;
          const srcNorm = st.isBox ? tpl.boxNorm : tpl.cylNorm;
          const vCount = st.isBox ? tpl.boxVerts : tpl.cylVerts;
          const { rx, ry, rz, ux, uy, uz, fx, fy, fz } = st.basis;
          const { midX, midY, midZ, sx, sy, sz, feat } = st;

          // Map local template coordinates (lx along width R, ly along forward axis F, lz along roof height U)
          for (let v = 0; v < vCount; v++) {
            const i3 = v * 3;
            const lx = srcPos[i3] * sx;
            const ly = srcPos[i3 + 1] * sy;
            const lz = srcPos[i3 + 2] * sz;

            const out3 = (vOffset + v) * 3;
            posArr[out3] = midX + rx * lx + fx * ly + ux * lz;
            posArr[out3 + 1] = midY + ry * lx + fy * ly + uy * lz;
            posArr[out3 + 2] = midZ + rz * lx + fz * ly + uz * lz;

            const nx = srcNorm[i3];
            const ny = srcNorm[i3 + 1];
            const nz = srcNorm[i3 + 2];
            normArr[out3] = rx * nx + fx * ny + ux * nz;
            normArr[out3 + 1] = ry * nx + fy * ny + uy * nz;
            normArr[out3 + 2] = rz * nx + fz * ny + uz * nz;
          }

          const numTris = vCount / 3;
          for (let tIdx = 0; tIdx < numTris; tIdx++) {
            triToFeature[triIdx++] = feat;
          }
          vOffset += vCount;
        }

        const mergedGeo = new THREE.BufferGeometry();
        mergedGeo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
        mergedGeo.setAttribute("normal", new THREE.BufferAttribute(normArr, 3));
        mergedGeo.computeBoundingSphere();

        // Opaque depth-tested material with polygonOffset prevents Z-fighting and transparent sorting flicker when zoomed out
        const solidMat = new THREE.MeshStandardMaterial({
          color: new THREE.Color(ldef.color),
          emissive: new THREE.Color(ldef.color),
          emissiveIntensity: 0.26,
          roughness: 0.4,
          metalness: 0.22,
          transparent: false,
          opacity: 1.0,
          depthTest: true,
          depthWrite: true,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        });

        const layerMesh = new THREE.Mesh(mergedGeo, solidMat);
        layerMesh.name = `UtilitiesLayerMesh_${layerId}`;
        layerMesh.userData = {
          isUtilityFeature: true,
          layerId: layerId,
          feature: bucket.firstFeat,
          triToFeature: triToFeature,
        };
        layerMesh.visible = isLayerVis;
        group.add(layerMesh);
        UTILS_STATE.layerMeshes.push(layerMesh);
        layerMeshById[layerId] = layerMesh;
      }

      if (bucket.linePositions.length >= 6) {
        const lineGeo = new THREE.BufferGeometry();
        lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(bucket.linePositions, 3));
        const lineMat = new THREE.LineBasicMaterial({
          color: new THREE.Color(ldef.color),
          transparent: true,
          opacity: 0.65,
          depthTest: true,
          depthWrite: false,
        });
        const lineSegs = new THREE.LineSegments(lineGeo, lineMat);
        lineSegs.name = `UtilitiesLayerLines_${layerId}`;
        lineSegs.userData = {
          layerId: layerId,
        };
        lineSegs.visible = isLayerVis;
        group.add(lineSegs);
      }
    });

    // Bind each segment entry in pipeMeshMap to its parent layerMesh
    UTILS_STATE.pipeMeshMap.forEach((entry) => {
      if (layerMeshById[entry.layer]) {
        entry.mesh = layerMeshById[entry.layer];
      }
    });

    const anyLayerVisible = Object.values(UTILITY_LAYERS).some((l) => l && l.visible === true);
    group.visible = anyLayerVisible;

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
  }

  /**
   * Updates 3D mesh visibility according to the 10 layer toggles.
   * When all layers are unchecked ("None"), hides the root group and all children completely.
   */
  function updateLayerVisibility3D() {
    const anyLayerVisible = Object.values(UTILITY_LAYERS).some((l) => l && l.visible === true);
    const studioThree = window.studioThree;
    if (studioThree) {
      [studioThree.overlayGroup, studioThree.scene].filter(Boolean).forEach((root) => {
        root.children.forEach((ch) => {
          if (ch && ch.name === "PublicUtilitiesGroup") {
            ch.visible = anyLayerVisible;
          }
        });
      });
    }

    if (!UTILS_STATE.threeGroup) return;
    UTILS_STATE.threeGroup.visible = anyLayerVisible;

    UTILS_STATE.threeGroup.traverse((child) => {
      if (child === UTILS_STATE.threeGroup) {
        child.visible = anyLayerVisible;
        return;
      }
      const lyr = child.userData && child.userData.layerId ? UTILITY_LAYERS[child.userData.layerId] : null;
      child.visible = anyLayerVisible && Boolean(lyr && lyr.visible === true);
    });

    if (!anyLayerVisible) {
      hideUtilityHoverTooltip();
    }

    if (studioThree && typeof studioThree.render === "function") {
      studioThree.render();
    } else if (studioThree && studioThree.renderer && studioThree.camera && studioThree.scene) {
      studioThree.renderer.render(studioThree.scene, studioThree.camera);
    }
  }

  /**
   * Interactive 3D raycasting + screen-space segment picker for selecting/hovering utility features in Studio.
   * Resolves exact feature in O(1) via `mesh.userData.triToFeature[hit.faceIndex]`, with a 14px screen-space
   * segment fallback so narrow buried pipes are effortless to hover and click.
   */
  function pickUtilityFeatureAtScreenXY(screenX, screenY) {
    const studioThree = window.studioThree;
    if (!studioThree || !studioThree.camera || !UTILS_STATE.threeGroup || !UTILS_STATE.threeGroup.visible) {
      return null;
    }

    const domEl = studioThree.renderer.domElement;
    const rect = domEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const mouse = new THREE.Vector2(
      ((screenX - rect.left) / rect.width) * 2 - 1,
      -((screenY - rect.top) / rect.height) * 2 + 1
    );

    const rc = new THREE.Raycaster();
    rc.setFromCamera(mouse, studioThree.camera);
    const visMeshes = UTILS_STATE.layerMeshes.filter((m) => m && m.visible !== false);
    const hits = rc.intersectObjects(visMeshes, false);

    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      const obj = hit.object;
      if (obj && obj.userData && obj.userData.isUtilityFeature && obj.visible !== false) {
        const triMap = obj.userData.triToFeature;
        if (Array.isArray(triMap) && hit.faceIndex !== undefined && hit.faceIndex !== null && triMap[hit.faceIndex]) {
          return triMap[hit.faceIndex];
        }
        if (obj.userData.feature) {
          return obj.userData.feature;
        }
      }
    }

    // Screen-space 2D segment proximity fallback (within 12px) so thin pipes are easy to hover when zoomed out
    const cam = studioThree.camera;
    const pA = new THREE.Vector3();
    const pB = new THREE.Vector3();
    const localX = screenX - rect.left;
    const localY = screenY - rect.top;
    let bestFeat = null;
    let bestDistSq = 12 * 12;

    UTILS_STATE.pipeMeshMap.forEach((entry) => {
      const lyr = UTILITY_LAYERS[entry.layer];
      if (!lyr || lyr.visible === false || !entry.feature) return;
      pA.copy(entry.v1).project(cam);
      pB.copy(entry.v2).project(cam);
      if (pA.z > 1.0 && pB.z > 1.0) return;
      const ax = (pA.x * 0.5 + 0.5) * rect.width;
      const ay = (-pA.y * 0.5 + 0.5) * rect.height;
      const bx = (pB.x * 0.5 + 0.5) * rect.width;
      const by = (-pB.y * 0.5 + 0.5) * rect.height;
      const abx = bx - ax;
      const aby = by - ay;
      const len2 = abx * abx + aby * aby;
      let tProj = 0;
      if (len2 > 1e-4) {
        tProj = Math.max(0, Math.min(1, ((localX - ax) * abx + (localY - ay) * aby) / len2));
      }
      const cx = ax + tProj * abx;
      const cy = ay + tProj * aby;
      const d2 = (localX - cx) * (localX - cx) + (localY - cy) * (localY - cy);
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        bestFeat = entry.feature;
      }
    });

    return bestFeat;
  }

  /**
   * Floating 3D Hover Tooltip displaying the exact engineering card (`renderSelectedFeatureCardHtml`) WITHOUT links.
   */
  function ensureUtilityHoverTooltipEl() {
    let el = document.getElementById("gsUtilHoverTooltip");
    if (!el) {
      el = document.createElement("div");
      el.id = "gsUtilHoverTooltip";
      el.className = "gs-util-hover-tooltip";
      el.style.display = "none";
      document.body.appendChild(el);
    }
    return el;
  }

  function showUtilityHoverTooltip(feat, clientX, clientY) {
    if (!feat) {
      hideUtilityHoverTooltip();
      return;
    }
    const el = ensureUtilityHoverTooltipEl();
    if (UTILS_STATE.hoveredFeature !== feat) {
      UTILS_STATE.hoveredFeature = feat;
      const rawHtml = renderSelectedFeatureCardHtml(feat, { includeLinks: false });
      el.innerHTML = typeof window.translateDynamicHtml === "function" ? window.translateDynamicHtml(rawHtml) : rawHtml;
    }
    el.style.display = "block";
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const tipW = 320;
    const tipH = el.offsetHeight || 175;
    let left = clientX + 16;
    let top = clientY + 14;
    if (left + tipW > vw - 12) left = Math.max(12, clientX - tipW - 14);
    if (top + tipH > vh - 12) top = Math.max(12, vh - tipH - 12);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function hideUtilityHoverTooltip() {
    UTILS_STATE.hoveredFeature = null;
    const el = document.getElementById("gsUtilHoverTooltip");
    if (el) {
      el.style.display = "none";
    }
  }

  function selectUtilityFeature(feat, opts = {}) {
    if (!feat) return;
    UTILS_STATE.selectedFeature = feat;
    const box = document.getElementById("utilSelectedFeatureBox");
    if (box) {
      const rawHtml = renderSelectedFeatureCardHtml(feat, { includeLinks: true });
      box.innerHTML = typeof window.translateDynamicHtml === "function" ? window.translateDynamicHtml(rawHtml) : rawHtml;
      if (opts && opts.scrollIntoView) {
        try {
          box.scrollIntoView({ behavior: "smooth", block: "nearest" });
        } catch (_) {}
      }
    }
  }

  function syncUserTracedUtilityToGisLayer(traceRes, scanId) {
    if (!traceRes || !Array.isArray(traceRes.stations) || traceRes.stations.length < 2) return null;
    const sid = String(scanId || traceRes.scan_id || (typeof STATE !== "undefined" && STATE.activeScanId) || "default");
    const stations = traceRes.stations;
    const firstSt = stations[0];
    const lastSt = stations[stations.length - 1];
    const diaMm = Math.round(Number(traceRes.pipe_diameter_mm || (traceRes.pipe_diameter_m ? traceRes.pipe_diameter_m * 1000 : 300)));
    const startDepthM = Number(
      firstSt.ground_z !== undefined && firstSt.invert_z !== undefined
        ? (Number(firstSt.ground_z) - Number(firstSt.invert_z)).toFixed(2)
        : (Number(firstSt.cover_depth_m || 1.2) + diaMm / 1000.0).toFixed(2)
    );
    const endDepthM = Number(
      lastSt.ground_z !== undefined && lastSt.invert_z !== undefined
        ? (Number(lastSt.ground_z) - Number(lastSt.invert_z)).toFixed(2)
        : (Number(lastSt.cover_depth_m || 1.2) + diaMm / 1000.0).toFixed(2)
    );

    const coordsTwd97 = stations.map((s) => [Number(s.e), Number(s.n), Number(s.invert_z)]);
    const pipeTypeLabel = String(traceRes.pipe_type || "DRAIN").toUpperCase();
    const feat = {
      id: `USER-TRACED-${sid}`,
      type: "pipe",
      layer: "as_built",
      origin_class: "user_or_scan_to_bim",
      name: t(`明挖竣工實測管線 (${pipeTypeLabel} Ø${diaMm}mm)`, `User As-Built Trench Pipe (${pipeTypeLabel} Ø${diaMm}mm)`),
      diameter_mm: diaMm,
      length_m: Number(traceRes.total_length_3d_m || traceRes.total_length_2d_m || 12.0),
      slope_pct: Number(traceRes.overall_slope_pct || 0.8),
      flow_direction: Number(firstSt.invert_z) >= Number(lastSt.invert_z) ? 1 : -1,
      start_depth_m: startDepthM,
      end_depth_m: endDepthM,
      start_cover_m: Number(firstSt.cover_depth_m || 1.2),
      start_ground_h: Number(firstSt.ground_z || Number(firstSt.invert_z) + startDepthM),
      end_ground_h: Number(lastSt.ground_z || Number(lastSt.invert_z) + endDepthM),
      start_invert_h: Number(firstSt.invert_z),
      end_invert_h: Number(lastSt.invert_z),
      coords_twd97: coordsTwd97,
      source: t("使用者 3D 明挖管溝竣工實測 (NON-API)", "User 3D Open-Trench As-Built Survey (NON-API)"),
      geometry: {
        type: "LineString",
        coordinates: coordsTwd97,
      },
    };
    UTILS_STATE.userAsBuiltByScan[sid] = [feat];
    if (UTILS_STATE.loadedScanId === sid && Array.isArray(UTILS_STATE.features)) {
      UTILS_STATE.features = mergeUserAsBuiltFeatures(sid, UTILS_STATE.features);
      if (UTILS_STATE.active) {
        renderUtilities3D();
        updateUtilitiesPanelMetricsInPlace();
      }
    }
    return feat;
  }

  function clearUserTracedUtilityFromGisLayer(scanId) {
    const sid = String(scanId || (typeof STATE !== "undefined" && STATE.activeScanId) || "default");
    delete UTILS_STATE.userAsBuiltByScan[sid];
    if (UTILS_STATE.loadedScanId === sid && Array.isArray(UTILS_STATE.features)) {
      UTILS_STATE.features = mergeUserAsBuiltFeatures(sid, UTILS_STATE.features);
      if (UTILS_STATE.active) {
        renderUtilities3D();
        updateUtilitiesPanelMetricsInPlace();
      }
    }
  }

  // Bind pointerdown & pointermove in Studio to select and hover-inspect 3D utility elements
  let _lastHoverPickMs = 0;
  window.addEventListener("pointermove", (ev) => {
    if (typeof STATE === "undefined" || STATE.activeTool !== "utilities" || !UTILS_STATE.active) {
      if (UTILS_STATE.hoveredFeature) hideUtilityHoverTooltip();
      return;
    }
    if (ev.buttons !== 0) {
      if (UTILS_STATE.hoveredFeature) hideUtilityHoverTooltip();
      return;
    }
    if (
      ev.target.closest("#studioSidePanel") ||
      ev.target.closest("#studioDock") ||
      ev.target.closest(".bim-dock") ||
      ev.target.closest(".gs-topbar")
    ) {
      if (UTILS_STATE.hoveredFeature) hideUtilityHoverTooltip();
      return;
    }

    const now = performance.now();
    if (now - _lastHoverPickMs < 28) {
      if (UTILS_STATE.hoveredFeature) {
        showUtilityHoverTooltip(UTILS_STATE.hoveredFeature, ev.clientX, ev.clientY);
      }
      return;
    }
    _lastHoverPickMs = now;

    const feat = pickUtilityFeatureAtScreenXY(ev.clientX, ev.clientY);
    if (feat) {
      showUtilityHoverTooltip(feat, ev.clientX, ev.clientY);
    } else if (UTILS_STATE.hoveredFeature) {
      hideUtilityHoverTooltip();
    }
  });

  window.addEventListener("pointerdown", (ev) => {
    if (typeof STATE === "undefined" || STATE.activeTool !== "utilities" || !UTILS_STATE.active) return;
    if (ev.target.closest("#studioSidePanel") || ev.target.closest("#studioDock") || ev.target.closest(".bim-dock")) {
      return;
    }

    const feat = pickUtilityFeatureAtScreenXY(ev.clientX, ev.clientY);
    if (feat) {
      selectUtilityFeature(feat, { scrollIntoView: true });
    }
  });

  // Global namespace exports
  window.openUtilitiesInspector = openUtilitiesInspector;
  window.closeUtilitiesInspector = closeUtilitiesInspector;
  window.resetUtilitiesOnScanChange = resetUtilitiesOnScanChange;
  window.onUtilitiesPanelClosed = onUtilitiesPanelClosed;
  window.selectUtilityFeature = selectUtilityFeature;
  window.renderSelectedFeatureCardHtml = renderSelectedFeatureCardHtml;
  window.pickUtilityFeatureAtScreenXY = pickUtilityFeatureAtScreenXY;
  window.syncUserTracedUtilityToGisLayer = syncUserTracedUtilityToGisLayer;
  window.clearUserTracedUtilityFromGisLayer = clearUserTracedUtilityFromGisLayer;
  window.UTILITY_LAYERS = UTILITY_LAYERS;
  window.UTILS_STATE = UTILS_STATE;
})();
