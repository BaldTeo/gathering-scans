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
 *    - Fast single-pass bare-earth 2D elevation grid sampler (< 3ms on large valley meshes)
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

  // Module state (Default shown radius = 250m; Server auto-queries and caches 1000m / 1km; legacy serverMasterRadiusM: 500.0 upgraded)
  const UTILS_STATE = {
    active: false,
    keepLayersOnClose:
      typeof localStorage !== "undefined" && localStorage.getItem("gs_util_keep_on_close_v2") !== null
        ? localStorage.getItem("gs_util_keep_on_close_v2") === "1"
        : false,
    verticalOffsetM: 0.0,
    loadedScanId: null,
    lastCenter: null,
    groundReferenceH: NaN,
    lastRenderedOriginH: NaN,
    radiusM: 250.0,
    serverMasterRadiusM: 1000.0,
    isCached: false,
    cacheTimestamp: "",
    taipei8UtilityStatus: null,
    groundXrayPct: 38, // Default 38% X-Ray translucency (= 0.62 terrain opacity) when Utilities active
    groundOpacity: 0.62,
    features: [],
    masterCacheByScan: {}, // scanId -> { center, groundReferenceH, radiusM: 1000, features: [...], taipei8UtilityStatus, timestamp }
    userAsBuiltByScan: {}, // scanId -> array of user-traced open-trench features (isolated NON-API layer)
    selectedFeature: null,
    hoveredFeature: null,
    isQuerying: false,
    loadingPct: 0,
    loadingMsg: "",
    loadingTimer: null,
    threeGroup: null,
    layerMeshes: [], // Merged per-layer THREE.Mesh objects with userData.triToFeature for O(1) raycast picking
    xrayMeshes: [], // Subsurface depth-fail (THREE.GreaterDepth) X-Ray meshes sharing mergedGeo
    lineMeshes: [], // Per-layer vertical depth leader LineSegments
    pipeMeshMap: new Map(), // featId_seg -> { mesh, layer, feature, v1, v2, dist, dir }
    groundGridCache: { scanId: null, originH: NaN, groundRefH: NaN, catCount: 0, sampler: null },
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
      ["區排箱涵/明渠", "Regional Storm Culvert / Channel"],
      ["地下箱涵", "Underground Box Culvert"],
      ["雨水排水幹線", "Stormwater Drain"],
      ["排水河道", "Stormwater Channel / River"],
      ["攔水堰", "Weir"],
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
  function hasVisibleUtilities3D() {
    const anyLayerVis = Object.values(UTILITY_LAYERS).some((l) => l && l.visible === true);
    return Boolean(
      (UTILS_STATE.active || UTILS_STATE.keepLayersOnClose) &&
        anyLayerVis &&
        UTILS_STATE.threeGroup &&
        UTILS_STATE.threeGroup.visible &&
        Array.isArray(UTILS_STATE.features) &&
        UTILS_STATE.features.length > 0
    );
  }

  function ensureAdaptiveCameraNearPlane() {
    const studioThree = window.studioThree;
    if (!studioThree || !studioThree.camera) return;

    function updateNear() {
      if (!studioThree || !studioThree.camera) return;
      const cam = studioThree.camera;
      const target = studioThree.controls && studioThree.controls.target ? studioThree.controls.target : new THREE.Vector3(0, 0, 0);
      const dist = cam.position.distanceTo(target);
      // Keep near plane at 0.03m whenever dist <= 60m and cap at <= 0.15m when zoomed far out so foreground 3D tiles are never clipped
      const desiredNear =
        Boolean(UTILS_STATE.active) && hasVisibleUtilities3D() && dist > 60.0
          ? Math.max(0.03, Math.min(0.15, dist * 0.0012))
          : 0.03;
      if (Math.abs(cam.near - desiredNear) > 0.008) {
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
   * Returns all active 3D scan model root groups in `studioThree` (`modelPivot`, `fallbackGroup`, `modelGroup`).
   */
  function getStudioModelRoots(studioThree) {
    if (!studioThree) return [];
    return [studioThree.modelPivot, studioThree.fallbackGroup, studioThree.modelGroup].filter(Boolean);
  }

  /**
   * Iterates over every 3D scan tile material, including both attached scene roots (`studioThree.modelPivot`)
   * AND detached/cached LOD tiles sitting in `studioThree.tilesRenderer.lruCache.itemSet`, so zooming in/out
   * and closing Utilities mode never leaves cached tiles in a stale material state.
   */
  function forEachStudioTileMaterial(studioThree, callback, scopeRoot = null) {
    if (!studioThree || typeof callback !== "function") return;
    const visitedMats = new Set();
    const visitMaterial = (mat) => {
      if (!mat || visitedMats.has(mat)) return;
      visitedMats.add(mat);
      if (mat.colorWrite === false) return; // Skip hidden Gaussian splat proxy meshes
      callback(mat);
    };
    const visitObjectTree = (rootObj) => {
      if (!rootObj || typeof rootObj.traverse !== "function") return;
      rootObj.traverse((child) => {
        if (!child || !child.isMesh || !child.material) return;
        if (child.userData && (child.userData.isUtilityFeature || child.userData.isUtilityXray)) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (let i = 0; i < mats.length; i++) {
          visitMaterial(mats[i]);
        }
      });
    };

    if (scopeRoot) {
      visitObjectTree(scopeRoot);
      return;
    }

    const roots = getStudioModelRoots(studioThree);
    for (let i = 0; i < roots.length; i++) {
      visitObjectTree(roots[i]);
    }

    const tr = studioThree.tilesRenderer;
    if (tr) {
      if (typeof tr.forEachLoadedModel === "function") {
        tr.forEachLoadedModel((scene) => visitObjectTree(scene));
      }
      const itemMap = tr.lruCache && tr.lruCache.itemSet;
      if (itemMap && typeof itemMap.forEach === "function") {
        itemMap.forEach((_, tile) => {
          const ed = tile && tile.engineData;
          if (!ed) return;
          if (ed.scene) visitObjectTree(ed.scene);
          if (Array.isArray(ed.materials)) {
            for (let i = 0; i < ed.materials.length; i++) {
              visitMaterial(ed.materials[i]);
            }
          }
        });
      }
    }
  }

  function syncSubsurfaceXrayOverlayMeshes(pct) {
    const showXrayOverlay = Boolean(UTILS_STATE.active) && hasVisibleUtilities3D() && Number(pct) > 1;
    const xrayAlpha = showXrayOverlay ? Math.max(0.14, Math.min(0.88, Number(((pct / 100.0) * 1.05).toFixed(2)))) : 0.0;
    if (Array.isArray(UTILS_STATE.xrayMeshes)) {
      for (let i = 0; i < UTILS_STATE.xrayMeshes.length; i++) {
        const xm = UTILS_STATE.xrayMeshes[i];
        if (!xm) continue;
        const lid = xm.userData && xm.userData.layerId;
        const lyrVis = Boolean(lid && UTILITY_LAYERS[lid] && UTILITY_LAYERS[lid].visible !== false);
        xm.visible = lyrVis && showXrayOverlay;
        if (xm.material) {
          xm.material.opacity = xrayAlpha;
        }
      }
    }
    if (Array.isArray(UTILS_STATE.lineMeshes)) {
      for (let i = 0; i < UTILS_STATE.lineMeshes.length; i++) {
        const lm = UTILS_STATE.lineMeshes[i];
        if (!lm || !lm.material) continue;
        lm.material.depthTest = !showXrayOverlay;
        lm.material.opacity = showXrayOverlay ? Math.max(0.32, xrayAlpha * 0.78) : 0.55;
      }
    }
  }

  /**
   * Applies or restores Ground Surface X-Ray Translucency on `studioThree.modelPivot` and subsurface X-Ray meshes
   * so buried 3D pipes and manhole shafts beneath the road are physically visible with true depth perception,
   * while keeping 3D photogrammetry tiles in the opaque depth-tested WebGL pass (zero self-occlusion holes when zooming in).
   */
  function applyUtilitiesGroundXray(xrayPct, scopeRoot = null) {
    const pct = Math.max(0, Math.min(80, Number(xrayPct) || 0));
    UTILS_STATE.groundXrayPct = pct;
    const targetOpacity = Number((1.0 - pct / 100.0).toFixed(2));
    UTILS_STATE.groundOpacity = targetOpacity;

    const studioThree = window.studioThree;
    const roots = getStudioModelRoots(studioThree);
    if (!roots.length) return;

    // Hook TilesRenderer 'load-model' & 'tile-visibility-change' once so newly streamed or cached 3D tiles stay synced
    if (studioThree.tilesRenderer && !studioThree.tilesRenderer.__gsUtilXrayLoadBound) {
      studioThree.tilesRenderer.__gsUtilXrayLoadBound = true;
      const onTileSceneReady = (ev) => {
        const tileScene = ev && ev.scene ? ev.scene : null;
        if (UTILS_STATE.active && UTILS_STATE.groundXrayPct > 1) {
          applyUtilitiesGroundXray(UTILS_STATE.groundXrayPct, tileScene);
        } else if (tileScene) {
          restoreUtilitiesGroundOpacity(tileScene);
        }
        if (
          ev &&
          ev.type === "load-model" &&
          hasVisibleUtilities3D() &&
          Array.isArray(UTILS_STATE.features) &&
          UTILS_STATE.features.length > 0
        ) {
          const curOrigin = resolveUtilitiesOriginTwd97();
          if (
            Number.isFinite(curOrigin.h) &&
            (!Number.isFinite(UTILS_STATE.lastRenderedOriginH) ||
              Math.abs(curOrigin.h - UTILS_STATE.lastRenderedOriginH) > 0.01)
          ) {
            renderUtilities3D();
          }
        }
      };
      studioThree.tilesRenderer.addEventListener("load-model", onTileSceneReady);
      studioThree.tilesRenderer.addEventListener("tile-visibility-change", (ev) => {
        if (ev && ev.visible && ev.scene) {
          onTileSceneReady(ev);
        }
      });
    }

    const isTranslucent = Boolean(UTILS_STATE.active) && hasVisibleUtilities3D() && pct > 1;
    syncSubsurfaceXrayOverlayMeshes(pct);

    const baseBright = Math.max(0.1, Math.min(4.0, Number(typeof STATE !== "undefined" ? STATE.scanBrightness : 1.0) || 1.0));
    const xrayBrightScale = isTranslucent ? Math.max(0.62, Number((1.0 - (pct / 100.0) * 0.38).toFixed(3))) : 1.0;

    forEachStudioTileMaterial(
      studioThree,
      (mat) => {
        if (!mat.userData) mat.userData = {};
        if (!mat.userData.__origUtilXrayState) {
          mat.userData.__origUtilXrayState = {
            transparent: false,
            opacity: 1.0,
            depthWrite: true,
          };
        }
        const orig = mat.userData.__origUtilXrayState;
        const needShaderRebuild = mat.transparent !== orig.transparent || mat.depthWrite !== orig.depthWrite;
        // Always keep 3D scan tiles in WebGL Pass 1 (opaque + depthWrite) so close-up zooming never suffers from triangle sorting holes
        mat.transparent = orig.transparent;
        mat.opacity = orig.opacity;
        mat.depthWrite = orig.depthWrite;
        mat.userData.__utilXrayScale = xrayBrightScale;
        if (!mat.userData.PassUniforms && typeof applyBrightnessToMaterial === "function") {
          applyBrightnessToMaterial(mat, baseBright);
        } else if (mat.userData.PassUniforms && mat.userData.PassUniforms.uBrightness) {
          mat.userData.PassUniforms.uBrightness.value = baseBright * xrayBrightScale;
        }
        if (needShaderRebuild) {
          mat.needsUpdate = true;
        }
      },
      scopeRoot
    );

    if (!scopeRoot) {
      ensureAdaptiveCameraNearPlane();
      if (typeof studioThree.render === "function") {
        studioThree.render();
      } else if (studioThree.renderer && studioThree.camera && studioThree.scene) {
        studioThree.renderer.render(studioThree.scene, studioThree.camera);
      }
    }
  }

  /**
   * Restores the 3D scan model opacity & brightness to 100% (1.0) across all active and cached 3D tiles whenever Utilities is closed.
   */
  function restoreUtilitiesGroundOpacity(scopeRoot = null) {
    const studioThree = window.studioThree;
    const roots = getStudioModelRoots(studioThree);
    if (!roots.length) return;

    syncSubsurfaceXrayOverlayMeshes(UTILS_STATE.groundXrayPct);
    const baseBright = Math.max(0.1, Math.min(4.0, Number(typeof STATE !== "undefined" ? STATE.scanBrightness : 1.0) || 1.0));

    forEachStudioTileMaterial(
      studioThree,
      (mat) => {
        if (!mat.userData) mat.userData = {};
        const orig = mat.userData.__origUtilXrayState || { transparent: false, opacity: 1.0, depthWrite: true };
        const needShaderRebuild = mat.transparent !== orig.transparent || mat.depthWrite !== orig.depthWrite;
        mat.transparent = orig.transparent;
        mat.opacity = orig.opacity;
        mat.depthWrite = orig.depthWrite;
        mat.userData.__utilXrayScale = 1.0;
        if (!mat.userData.PassUniforms && typeof applyBrightnessToMaterial === "function") {
          applyBrightnessToMaterial(mat, baseBright);
        } else if (mat.userData.PassUniforms && mat.userData.PassUniforms.uBrightness) {
          mat.userData.PassUniforms.uBrightness.value = baseBright;
        }
        if (needShaderRebuild) {
          mat.needsUpdate = true;
        }
      },
      scopeRoot
    );

    if (!scopeRoot) {
      ensureAdaptiveCameraNearPlane();
      if (typeof studioThree.render === "function") {
        studioThree.render();
      } else if (studioThree.renderer && studioThree.camera && studioThree.scene) {
        studioThree.renderer.render(studioThree.scene, studioThree.camera);
      }
    }
  }

  /**
   * Silently pre-warms and persists the 1000m (1km) server master cache for `scanId` in the background.
   */
  function prewarmScanUtilitiesCache500m(scanId) {
    const sid = String(scanId || "").trim();
    if (!sid || UTILS_STATE.masterCacheByScan[sid] || typeof apiPost !== "function") return;
    const defaultDisplayR = Math.max(10.0, Math.min(1000.0, Number(UTILS_STATE.radiusM) || 250.0));
    setTimeout(async () => {
      try {
        if (UTILS_STATE.masterCacheByScan[sid]) return;
        const res = await apiPost("/api/survey/utilities-query", {
          scan_id: sid,
          radius_m: defaultDisplayR,
          server_master_radius_m: Number(UTILS_STATE.serverMasterRadiusM) || 1000.0,
          force_refresh: false,
        });
        if (res && res.status === "ok" && Array.isArray(res.features) && res.features.length > 0) {
          if (!UTILS_STATE.masterCacheByScan[sid] || (UTILS_STATE.masterCacheByScan[sid].radiusM || 0) < defaultDisplayR) {
            UTILS_STATE.masterCacheByScan[sid] = {
              center: res.center || null,
              groundReferenceH: Number(res.ground_reference_h ?? res.center?.ground_h ?? res.center?.h),
              radiusM: Number(res.radius_m || defaultDisplayR),
              serverMasterRadiusM: Math.max(1000.0, Number(res.master_cached_radius_m || res.master_radius_m || 1000.0)),
              masterTotalFeatures: Number(res.master_total_features || res.total_features || res.features.length),
              features: res.features,
              taipei8UtilityStatus: res.taipei_8utility_status || null,
              timestamp: String(res.query_timestamp || ""),
            };
          }
        }
      } catch (_) {}
    }, 600);
  }

  /**
   * Called when switching scans so stale utilities from a previous site are cleared,
   * and automatically triggers a 1000m (1km) background server cache pre-warm for the new scan.
   */
  function resetUtilitiesOnScanChange(newScanId) {
    stopLoadingProgressTicker();
    UTILS_STATE.active = false;
    UTILS_STATE.loadedScanId = null;
    UTILS_STATE.lastCenter = null;
    UTILS_STATE.features = [];
    UTILS_STATE.selectedFeature = null;
    UTILS_STATE.hoveredFeature = null;
    UTILS_STATE.groundGridCache = { scanId: null, meshCount: 0, catCount: 0, sampler: null };
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
   * Always cancels the Ground X-Ray opacity filter on the 3D scan (restoring 100% scan opacity),
   * even when `keepLayersOnClose` ("Show when closed") is enabled.
   */
  function onUtilitiesPanelClosed() {
    stopLoadingProgressTicker();
    UTILS_STATE.active = false;
    hideUtilityHoverTooltip();
    restoreUtilitiesGroundOpacity();
    if (UTILS_STATE.keepLayersOnClose && Array.isArray(UTILS_STATE.features) && UTILS_STATE.features.length > 0) {
      updateLayerVisibility3D();
      return;
    }
    clearUtilitiesVisuals3D();
  }

  /**
   * Updates the non-blocking loading progress bar inside the Utilities side panel without replacing DOM buttons.
   */
  function updateUtilitiesLoadingBarDom(visible, pct, msg) {
    UTILS_STATE.isQuerying = Boolean(visible);
    UTILS_STATE.loadingPct = visible ? Math.max(0, Math.min(100, Math.round(Number(pct) || 0))) : 0;
    UTILS_STATE.loadingMsg = visible ? String(msg || "") : "";

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
    if (msgEl) {
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
    updateUtilitiesLoadingBarDom(false, 0, "");
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
      stopLoadingProgressTicker();
      UTILS_STATE.features = mergeUserAsBuiltFeatures(currentScanId, UTILS_STATE.features);
      renderUtilities3D();
      updateUtilitiesPanelMetricsInPlace();
    }
  }

  /**
   * Closes the Public Utilities GIS inspector.
   */
  function closeUtilitiesInspector() {
    onUtilitiesPanelClosed();
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

    const tpeStatus = UTILS_STATE.taipei8UtilityStatus;
    const tpeMsgEl = document.getElementById("utilTpeStatusMsg");
    if (tpeStatus && tpeMsgEl) {
      const tpedigCnt = (UTILS_STATE.features || []).filter((f) => String(getFeatProp(f, "id", "")).startsWith("tpedig_")).length;
      const tpe3dCnt = (UTILS_STATE.features || []).filter((f) => String(getFeatProp(f, "id", "")).startsWith("tpe3d_")).length;
      if (tpeStatus.whitelisted && (tpe3dCnt > 0 || tpedigCnt > 0)) {
        const cnt = tpe3dCnt + tpedigCnt;
        tpeStatus.message_zh = `臺北市道管中心 3D 八大管線 API (PipeQuery.ashx) 已獲 IP 授權連線載入 (${cnt} 筆設施)。`;
        tpeStatus.message_en = `Taipei 3D 8-Utilities API (PipeQuery.ashx) IP-whitelisted & active (${cnt} features loaded).`;
      } else if (tpeStatus.public_portal_active || tpedigCnt > 0) {
        tpeStatus.message_zh = `公開市民圖資 (dig.taipei / G97_A_NW_PIPE) 與地形高程 API (get3dz.ashx) 已合法載入 (${tpedigCnt} 筆設施)；受限 3D API (PipeQuery.ashx) 則維持待政府 IP 白名單授權。`;
        tpeStatus.message_en = `Public Citizen Portal GIS (dig.taipei / G97_A_NW_PIPE) & Elevation API (get3dz.ashx) legally loaded (${tpedigCnt} features); restricted 3D API (PipeQuery.ashx) awaits government IP whitelist.`;
      }
      tpeMsgEl.textContent = t(tpeStatus.message_zh || "", tpeStatus.message_en || "");
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
        ? `<span class="gs-util-cache-pill ${UTILS_STATE.isCached ? "cached" : "live"}" title="${escapeHtml(UTILS_STATE.cacheTimestamp || t("伺服器已自動快取 1000m (1km) 範圍管線，預設顯示 250m", "1000m (1km) radius automatically cached on server; showing 250m by default"))}">
             ${SVG.CHECK} ${UTILS_STATE.isCached ? t("1km已快取", "1km Cached") : t("1km已同步", "1km Synced")}
           </span>`
        : "";

    const tpeStatus = UTILS_STATE.taipei8UtilityStatus;
    const isTpe3dWhitelisted = Boolean(tpeStatus && tpeStatus.whitelisted);
    const hasTpeDigFeatures = Boolean(
      Array.isArray(UTILS_STATE.features) && UTILS_STATE.features.some((f) => String(getFeatProp(f, "id", "")).startsWith("tpedig_"))
    );
    const isTpePublicActive = Boolean(tpeStatus && !isTpe3dWhitelisted && (tpeStatus.public_portal_active || hasTpeDigFeatures));
    const isTpeGmlActive = Boolean(tpeStatus && !isTpe3dWhitelisted && !isTpePublicActive && Number(tpeStatus.gml_files_loaded) > 0);
    const isTpeAnyActive = isTpe3dWhitelisted || isTpePublicActive || isTpeGmlActive;
    const tpeBannerHtml =
      tpeStatus && tpeStatus.integrated
        ? `<div id="utilTpeStatusBanner" style="margin-top:7px;padding:6px 8px;border-radius:6px;font-size:10px;line-height:1.45;background:${
            isTpeAnyActive ? "rgba(16,185,129,0.10)" : "rgba(56,189,248,0.09)"
          };border:1px solid ${
            isTpeAnyActive ? "rgba(16,185,129,0.32)" : "rgba(56,189,248,0.28)"
          };color:var(--ui-text-secondary);">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;font-weight:700;color:${
              isTpeAnyActive ? "#34d399" : "#38bdf8"
            };margin-bottom:2px;">
              <span>${SVG.INFO} ${
                isTpePublicActive || isTpeGmlActive
                  ? t("臺北市道管中心八大管線 GIS (801–808)", "Taipei 8-Utilities GIS (801–808)")
                  : t("臺北市道管中心 3D 八大管線 API (801–808)", "Taipei 3D 8-Utilities API (801–808)")
              }</span>
              <span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(15,23,42,0.35);">${
                isTpe3dWhitelisted
                  ? t("3D API 已授權", "3D API AUTHORIZED")
                  : isTpePublicActive
                  ? t("公開市民圖資 (3D API 待IP白名單)", "PUBLIC PORTAL (3D API AWAITING IP)")
                  : isTpeGmlActive
                  ? t("GML 圖資已載入 (3D API 待IP白名單)", "GML LOADED (3D API AWAITING IP)")
                  : t("功能已就緒 / 待IP白名單", "READY / AWAITING IP")
              }</span>
            </div>
            <div id="utilTpeStatusMsg">${escapeHtml(t(tpeStatus.message_zh || "", tpeStatus.message_en || ""))}</div>
          </div>`
        : "";

    const html = `
      <div class="gs-util-panel-container">
        <!-- Search & Control Header -->
        <div class="gs-util-section-card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
            <label class="gs-util-field-label" style="margin:0;">${t("顯示半徑 (預設 250m / 1km 自動快取)", "Display Radius (250m Default / 1km Cached)")}</label>
            ${cacheBadgeHtml}
          </div>
          <div class="gs-util-row-flex" style="margin-bottom:8px;">
            <div style="display:flex;align-items:center;gap:4px;flex:1;">
              <input type="number" id="inpUtilRadius" class="gs-input gs-util-input" min="10" max="1000" step="10" value="${UTILS_STATE.radiusM}" />
              <span style="font-size:11px;font-weight:600;color:var(--ui-text-muted);">m</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              <button type="button" class="gs-btn gs-btn-primary btn-xs primary" id="btnUtilQuery" title="${t("同步顯示半徑或按住 Shift 強制重新抓取 1km 伺服器管線圖資", "Sync display radius or Shift+Click to force refresh 1km server utilities cache")}">
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
              <span id="utilLoadingBarMsg">${escapeHtml(UTILS_STATE.loadingMsg || t("正在背景載入 1km 公共管線圖資...", "Loading 1km public utilities in background..."))}</span>
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

        <!-- Subsurface Ground X-Ray Translucency & Vertical Calibration Controls -->
        <div class="gs-util-section-card">
          <div class="gs-util-section-header">
            <span>${SVG.LAYERS} ${t("地底透視與高程設定", "Subsurface X-Ray & Elevation")}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
            <span style="font-size:10px;color:var(--ui-text-muted);min-width:48px;">${t("地面透視", "X-Ray")}</span>
            <input type="range" id="rngUtilGroundXray" class="gs-brightness-slider" min="0" max="80" step="2" value="${UTILS_STATE.groundXrayPct}" style="flex:1;" />
            <span style="font-size:11px;font-weight:600;min-width:34px;text-align:right;" id="lblUtilGroundXray">${UTILS_STATE.groundXrayPct}%</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
            <span style="font-size:10px;color:var(--ui-text-muted);min-width:48px;" title="${t("微調全體管線 3D 垂直高程 (點擊右側數值重置為 0.0m)", "Fine-tune 3D utility vertical elevation offset (click value to reset to 0.0m)")}">${t("高程微調", "Z Offset")}</span>
            <input type="range" id="rngUtilZOffset" class="gs-brightness-slider" min="-5.0" max="5.0" step="0.1" value="${Number(UTILS_STATE.verticalOffsetM || 0).toFixed(1)}" style="flex:1;" />
            <span style="font-size:11px;font-weight:600;min-width:38px;text-align:right;cursor:pointer;color:var(--ui-accent-primary,#38bdf8);" id="lblUtilZOffset" title="${t("點擊重置為 0.0m", "Click to reset to 0.0m")}">${(Number(UTILS_STATE.verticalOffsetM || 0) >= 0 ? "+" : "") + Number(UTILS_STATE.verticalOffsetM || 0).toFixed(1)}m</span>
          </div>
          <div style="margin-top:8px;padding-top:6px;border-top:1px dashed rgba(148,163,184,0.22);">
            <label class="gs-util-checkbox-label" style="font-size:11px;cursor:pointer;display:flex;align-items:center;gap:6px;">
              <input type="checkbox" id="chkUtilKeepOnClose" ${UTILS_STATE.keepLayersOnClose ? "checked" : ""} />
              <span>${t("關閉面板後保留 3D 管線圖層", "Keep 3D utility layers visible when closed")}</span>
            </label>
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
   * Applies a radius change immediately in-place using the cached 1000m (1km) master features
   * (without destroying DOM nodes on blur so clicking `#btnUtilQuery` never misfires).
   */
  function applyRadiusChangeFromCacheOrQuery(newRadiusM) {
    const r = Math.max(10, Math.min(1000, Number(newRadiusM) || 250));
    UTILS_STATE.radiusM = r;
    const scanId = String((typeof STATE !== "undefined" && STATE.activeScanId) || "");
    const masterEntry = scanId ? UTILS_STATE.masterCacheByScan[scanId] : null;
    if (masterEntry && Array.isArray(masterEntry.features) && r <= (masterEntry.radiusM || 1000) + 5) {
      stopLoadingProgressTicker();
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
      elQuery.onclick = async (ev) => {
        const inpR = document.getElementById("inpUtilRadius");
        if (inpR) {
          UTILS_STATE.radiusM = Math.max(10, Math.min(1000, parseFloat(inpR.value) || 250));
        }
        // Normal click syncs via fast 1km server cache; Shift+Click forces live external API re-crawl
        const forceLive = Boolean(ev && ev.shiftKey);
        await runUtilitiesQuery(forceLive);
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

    // Vertical Z-Offset slider & reset label
    const rngZOffset = document.getElementById("rngUtilZOffset");
    const lblZOffset = document.getElementById("lblUtilZOffset");
    if (rngZOffset) {
      rngZOffset.oninput = () => {
        const zVal = Math.max(-5.0, Math.min(5.0, parseFloat(rngZOffset.value) || 0));
        UTILS_STATE.verticalOffsetM = Number(zVal.toFixed(2));
        if (lblZOffset) lblZOffset.textContent = `${(zVal >= 0 ? "+" : "") + zVal.toFixed(1)}m`;
        renderUtilities3D();
        updateUtilitiesPanelMetricsInPlace();
      };
    }
    if (lblZOffset) {
      lblZOffset.onclick = () => {
        UTILS_STATE.verticalOffsetM = 0.0;
        if (rngZOffset) rngZOffset.value = "0.0";
        lblZOffset.textContent = "+0.0m";
        renderUtilities3D();
        updateUtilitiesPanelMetricsInPlace();
      };
    }

    // Keep 3D layers on close checkbox (off by default)
    const chkKeep = document.getElementById("chkUtilKeepOnClose");
    if (chkKeep) {
      chkKeep.onchange = () => {
        UTILS_STATE.keepLayersOnClose = Boolean(chkKeep.checked);
        try {
          localStorage.setItem("gs_util_keep_on_close_v2", UTILS_STATE.keepLayersOnClose ? "1" : "0");
        } catch (_) {}
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
        stopLoadingProgressTicker();
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

  function isUtilitiesSidePanelOpen() {
    if (UTILS_STATE.active) return true;
    const sp = typeof document !== "undefined" ? document.getElementById("studioSidePanel") : null;
    return Boolean(sp && !sp.classList.contains("hidden") && sp.getAttribute("data-active-tool") === "utilities");
  }

  /**
   * Queries genuine Taiwan Open APIs in the background via `/api/survey/utilities-query`
   * with a non-blocking progress bar. Always ensures 1000m (1km) is queried and cached on the server
   * while displaying `UTILS_STATE.radiusM` (default 250m) in the 3D scene.
   */
  async function runUtilitiesQuery(forceRefresh = false) {
    if (UTILS_STATE.isQuerying) return;
    const scanId = String((typeof STATE !== "undefined" && STATE.activeScanId) || "");
    const displayRadiusM = Math.max(10.0, Math.min(1000.0, Number(UTILS_STATE.radiusM) || 250.0));
    const queryRadiusM = Math.max(displayRadiusM, Number(UTILS_STATE.serverMasterRadiusM) || 1000.0);

    // Fast in-memory 1000m (1km) cache hit when not forcing a live refresh
    const memMaster = scanId ? UTILS_STATE.masterCacheByScan[scanId] : null;
    if (!forceRefresh && memMaster && Array.isArray(memMaster.features) && memMaster.features.length > 0 && displayRadiusM <= (memMaster.radiusM || 1000.0) + 5.0) {
      stopLoadingProgressTicker();
      UTILS_STATE.loadedScanId = scanId;
      UTILS_STATE.lastCenter = memMaster.center;
      UTILS_STATE.groundReferenceH = memMaster.groundReferenceH;
      UTILS_STATE.isCached = true;
      UTILS_STATE.cacheTimestamp = memMaster.timestamp || "";
      UTILS_STATE.taipei8UtilityStatus = memMaster.taipei8UtilityStatus || null;
      const clipped = filterMasterFeaturesToRadius(memMaster.features, memMaster.center, displayRadiusM);
      UTILS_STATE.features = mergeUserAsBuiltFeatures(scanId, clipped);
      if (isUtilitiesSidePanelOpen() || UTILS_STATE.keepLayersOnClose) {
        renderUtilities3D({ center: memMaster.center, ground_reference_h: memMaster.groundReferenceH });
        if (!UTILS_STATE.selectedFeature || !UTILS_STATE.features.includes(UTILS_STATE.selectedFeature)) {
          UTILS_STATE.selectedFeature =
            UTILS_STATE.features.find((f) => getFeatProp(f, "type", "") === "pipe" || getFeatProp(f, "type", "") === "box_culvert") ||
            UTILS_STATE.features[0] ||
            null;
        }
        if (isUtilitiesSidePanelOpen()) {
          renderUtilitiesSidePanel();
        }
        stopLoadingProgressTicker();
        applyUtilitiesGroundXray(UTILS_STATE.groundXrayPct);
      }
      return;
    }

    startLoadingProgressTicker(
      forceRefresh
        ? t("正在背景向政府 API 同步 1km 公共管線並更新伺服器快取...", "Syncing 1km public utilities in background & updating server cache...")
        : t("正在背景載入 1km 公共管線圖資 (顯示 250m)...", "Loading 1km public utilities in background (displaying 250m)...")
    );

    try {
      const payload = {
        scan_id: scanId,
        radius_m: displayRadiusM,
        server_master_radius_m: queryRadiusM,
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
      if (UTILS_STATE.loadingTimer) {
        clearInterval(UTILS_STATE.loadingTimer);
        UTILS_STATE.loadingTimer = null;
      }
      if (res && res.status === "ok" && Array.isArray(res.features)) {
        updateUtilitiesLoadingBarDom(
          true,
          95,
          t("正在建構 3D 批次管網模型...", "Building batched 3D utility network...")
        );
        // Yield briefly via setTimeout (never requestAnimationFrame, which pauses in background/headless tabs)
        await new Promise((resolve) => setTimeout(resolve, 16));

        const groundRefH = Number(res.ground_reference_h ?? res.center?.ground_h ?? res.center?.h);
        const fetchedRadiusM = Number(res.radius_m || displayRadiusM);
        const masterCachedR = Math.max(queryRadiusM, Number(res.master_cached_radius_m || res.master_radius_m || queryRadiusM));
        const masterTotalCnt = Number(res.master_total_features || res.total_features || res.features.length);
        if (scanId) {
          const prevMaster = UTILS_STATE.masterCacheByScan[scanId];
          if (!prevMaster || forceRefresh || fetchedRadiusM >= (prevMaster.radiusM || 0)) {
            UTILS_STATE.masterCacheByScan[scanId] = {
              center: res.center || null,
              groundReferenceH: groundRefH,
              radiusM: fetchedRadiusM,
              serverMasterRadiusM: masterCachedR,
              masterTotalFeatures: masterTotalCnt,
              features: res.features,
              taipei8UtilityStatus: res.taipei_8utility_status || null,
              timestamp: String(res.query_timestamp || ""),
            };
          }
        }

        UTILS_STATE.loadedScanId = scanId;
        UTILS_STATE.lastCenter = res.center || null;
        UTILS_STATE.groundReferenceH = groundRefH;
        UTILS_STATE.isCached = Boolean(res.cached);
        UTILS_STATE.cacheTimestamp = String(res.query_timestamp || "");
        UTILS_STATE.taipei8UtilityStatus = res.taipei_8utility_status || null;

        const latestDisplayR = Math.max(10.0, Math.min(1000.0, Number(UTILS_STATE.radiusM) || displayRadiusM));
        const shownFeatures =
          latestDisplayR < fetchedRadiusM - 1.0
            ? filterMasterFeaturesToRadius(res.features, res.center, latestDisplayR)
            : res.features;
        UTILS_STATE.features = mergeUserAsBuiltFeatures(scanId, shownFeatures);

        stopLoadingProgressTicker();

        const panelStillOpen = isUtilitiesSidePanelOpen();
        if (!panelStillOpen && !UTILS_STATE.keepLayersOnClose) {
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
        if (panelStillOpen) {
          renderUtilitiesSidePanel();
        }
        stopLoadingProgressTicker();
        applyUtilitiesGroundXray(UTILS_STATE.groundXrayPct);

        if (typeof showToast === "function") {
          showToast(
            t(
              `已載入 ${UTILS_STATE.features.length} 筆管線 (顯示 ${Math.round(latestDisplayR)}m / 伺服器已快取 ${Math.round(masterCachedR)}m 共 ${masterTotalCnt} 筆)`,
              `Loaded ${UTILS_STATE.features.length} utilities (${Math.round(latestDisplayR)}m shown / ${masterTotalCnt} cached at ${Math.round(masterCachedR)}m)`
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
    UTILS_STATE.xrayMeshes = [];
    UTILS_STATE.lineMeshes = [];
    UTILS_STATE.pipeMeshMap.clear();
  }

  /**
   * Resolves a deterministic TWD97 / TWVD2001 origin `{ e, n, h }` for local Three.js coordinate `(0, 0, 0)`.
   * Pre-seeds `studioThree.tilesCenter` from `STATE.activeScan.home_view.tiles_center` if `tileset.json`
   * has not finished its async fetch yet, ensuring `originTwd.h` is identical before and after 3D tiles stream.
   */
  function resolveUtilitiesOriginTwd97() {
    const studioThree = window.studioThree;
    const activeScan = typeof STATE !== "undefined" ? STATE.activeScan : null;
    if (
      studioThree &&
      (!Array.isArray(studioThree.tilesCenter) || studioThree.tilesCenter.length < 3) &&
      Array.isArray(activeScan?.home_view?.tiles_center) &&
      activeScan.home_view.tiles_center.length >= 3
    ) {
      const tc = activeScan.home_view.tiles_center;
      if (Math.hypot(Number(tc[0]) || 0, Number(tc[1]) || 0) >= 50000 && Number.isFinite(Number(tc[2]))) {
        studioThree.tilesCenter = [Number(tc[0]), Number(tc[1]), Number(tc[2])];
      }
    }
    return typeof localToTwd97 === "function" ? localToTwd97({ x: 0, y: 0, z: 0 }) : { e: 0, n: 0, h: 0 };
  }

  /**
   * Builds a 100% deterministic, tile-streaming-invariant bare-earth ground elevation sampler
   * anchored to server-hydrated TWVD2001 elevations (`start_ground_h`, `end_ground_h`, `rim_h`),
   * `ground_reference_h`, and categorized street-grade road/waterway data (`STATE.lastCategorizeResult`).
   * Never reads raw streaming 3D tile mesh vertices so turning Utilities off and on again (or streaming LOD tiles)
   * never causes vertical height jumps or drags street utilities down into sunken park basins or river gorges.
   */
  function createCanopyRejectingGroundSampler(payload, originTwd) {
    const currentScanId = String((typeof STATE !== "undefined" && STATE.activeScanId) || "");
    const rawCatData = typeof STATE !== "undefined" ? STATE.lastCategorizeResult || STATE.categorizeData : null;
    const catData =
      rawCatData && (!rawCatData.scan_id || !currentScanId || String(rawCatData.scan_id) === currentScanId)
        ? rawCatData
        : null;
    const catCount =
      catData
        ? (Array.isArray(catData.roads) ? catData.roads.length : 0) +
          (Array.isArray(catData.trees) ? catData.trees.length : 0) +
          (Array.isArray(catData.water_bodies) ? catData.water_bodies.length : 0)
        : 0;
    const centerGroundH = Number(
      payload?.ground_reference_h ??
        payload?.center?.ground_h ??
        payload?.center?.h ??
        UTILS_STATE.groundReferenceH ??
        UTILS_STATE.lastCenter?.ground_h ??
        UTILS_STATE.lastCenter?.h
    );
    const originH = Number(originTwd?.h) || 0;

    if (
      UTILS_STATE.groundGridCache.sampler &&
      UTILS_STATE.groundGridCache.scanId === currentScanId &&
      Math.abs((Number(UTILS_STATE.groundGridCache.originH) || 0) - originH) < 1e-4 &&
      ((!Number.isFinite(UTILS_STATE.groundGridCache.groundRefH) && !Number.isFinite(centerGroundH)) ||
        Math.abs((Number(UTILS_STATE.groundGridCache.groundRefH) || 0) - centerGroundH) < 1e-4) &&
      UTILS_STATE.groundGridCache.catCount === catCount
    ) {
      return UTILS_STATE.groundGridCache.sampler;
    }

    const roadAnchorPts = []; // [{ x, z, y }] verified upper-street road anchors
    const roadSamplesY = [];
    const waterSamplesY = [];

    function addRoadAnchorSample(lx, lz, ly) {
      if (!Number.isFinite(lx) || !Number.isFinite(lz) || !Number.isFinite(ly)) return;
      roadSamplesY.push(ly);
      roadAnchorPts.push({ x: lx, z: lz, y: ly });
    }

    function readRoadLocalY(r) {
      const bPts = Array.isArray(r?.boundary_twd97) ? r.boundary_twd97 : [];
      const bZs = [];
      for (let i = 0; i < bPts.length; i++) {
        const pt = bPts[i];
        if (Array.isArray(pt) && pt.length >= 3 && Number.isFinite(Number(pt[2]))) {
          bZs.push(Number(pt[2]));
        }
      }
      if (bZs.length >= 4) {
        bZs.sort((a, b) => a - b);
        const p65Z = bZs[Math.min(bZs.length - 1, Math.floor(bZs.length * 0.65))];
        return p65Z - originH;
      }
      if (Array.isArray(r.center_twd97) && r.center_twd97.length >= 3 && Number.isFinite(Number(r.center_twd97[2]))) {
        return Number(r.center_twd97[2]) - originH;
      }
      if (Array.isArray(r.center_local) && r.center_local.length >= 3 && Number.isFinite(Number(r.center_local[1]))) {
        return Number(r.center_local[1]);
      }
      if (Number.isFinite(r.elevation_local_y)) return Number(r.elevation_local_y);
      if (Number.isFinite(r.elevation_twd97_z)) return Number(r.elevation_twd97_z) - originH;
      return NaN;
    }

    // Ingest categorized roads and water bodies (from STATE.lastCategorizeResult)
    let primaryRoadY = NaN;
    if (catData) {
      if (Array.isArray(catData.roads) && catData.roads.length > 0) {
        let maxRoadArea = 0;
        catData.roads.forEach((r) => {
          const a = Number(r?.planar_area_m2) || 0;
          if (a > maxRoadArea) maxRoadArea = a;
        });
        const primaryRoadYs = [];
        catData.roads.forEach((r) => {
          const a = Number(r?.planar_area_m2) || 100;
          const ry = readRoadLocalY(r);
          if (Number.isFinite(ry) && a >= 0.2 * maxRoadArea) {
            primaryRoadYs.push(ry);
          }
        });
        if (primaryRoadYs.length > 0) {
          primaryRoadY = primaryRoadYs.reduce((acc, v) => acc + v, 0) / primaryRoadYs.length;
        }

        catData.roads.forEach((r) => {
          const rArea = Number(r?.planar_area_m2) || 100;
          const ry = readRoadLocalY(r);
          const isSunkenFootpath =
            Number.isFinite(primaryRoadY) &&
            rArea < 0.2 * maxRoadArea &&
            Number.isFinite(ry) &&
            primaryRoadY - ry > 0.85;
          if (isSunkenFootpath) return;

          if (Number.isFinite(ry) && Array.isArray(r.center_twd97) && r.center_twd97.length >= 2) {
            addRoadAnchorSample(
              Number(r.center_twd97[0]) - originTwd.e,
              originTwd.n - Number(r.center_twd97[1]),
              ry
            );
          }
          if (Array.isArray(r.boundary_twd97)) {
            const stride = Math.max(1, Math.floor(r.boundary_twd97.length / 24));
            for (let i = 0; i < r.boundary_twd97.length; i += stride) {
              const pt = r.boundary_twd97[i];
              if (Array.isArray(pt) && pt.length >= 3) {
                const py = Number(pt[2]) - originH;
                if (!Number.isFinite(primaryRoadY) || primaryRoadY - py <= 0.85) {
                  addRoadAnchorSample(Number(pt[0]) - originTwd.e, originTwd.n - Number(pt[1]), py);
                }
              }
            }
          }
        });
      }
      if (Array.isArray(catData.water_bodies)) {
        catData.water_bodies.forEach((wb) => {
          const wy = Number.isFinite(Number(wb.water_level_twvd2001_m))
            ? Number(wb.water_level_twvd2001_m) - originH
            : Array.isArray(wb.center_twd97) && wb.center_twd97.length >= 3 && Number.isFinite(Number(wb.center_twd97[2]))
            ? Number(wb.center_twd97[2]) - originH
            : Array.isArray(wb.center_local) && wb.center_local.length >= 3 && Number.isFinite(Number(wb.center_local[1]))
            ? Number(wb.center_local[1])
            : Number.isFinite(wb.elevation_local_y)
            ? Number(wb.elevation_local_y)
            : Number.isFinite(wb.elevation_twd97_z)
            ? Number(wb.elevation_twd97_z) - originH
            : NaN;
          if (Number.isFinite(wy)) {
            waterSamplesY.push(wy);
          }
        });
      }
    }

    const baseCenterRefY = Number.isFinite(centerGroundH) && centerGroundH > -100 ? centerGroundH - originH : NaN;
    let roadRefY = Number.isFinite(baseCenterRefY) ? baseCenterRefY : 0.0;
    if (roadSamplesY.length > 0) {
      const sortedRoad = roadSamplesY.slice().sort((a, b) => a - b);
      const p60RoadY = sortedRoad[Math.min(sortedRoad.length - 1, Math.floor(sortedRoad.length * 0.6))];
      roadRefY = Number.isFinite(baseCenterRefY) ? Math.max(baseCenterRefY, p60RoadY) : p60RoadY;
    } else if (Number.isFinite(primaryRoadY)) {
      roadRefY = Number.isFinite(baseCenterRefY) ? Math.max(baseCenterRefY, primaryRoadY) : primaryRoadY;
    }

    const waterRefY =
      waterSamplesY.length > 0
        ? waterSamplesY.reduce((a, b) => a + b, 0) / waterSamplesY.length
        : roadRefY - 1.2;

    const sampler = function sampleLocalGroundY(lx, lz, fallbackGroundH, opts) {
      const isOpenChannel = Boolean(opts && opts.isOpenChannel);
      const fbH = Number(fallbackGroundH);
      const hasValidFb = Number.isFinite(fbH) && fbH > -100;
      const fbLocalY = hasValidFb ? fbH - originH : NaN;

      if (isOpenChannel) {
        if (Number.isFinite(fbLocalY)) {
          return Math.max(waterRefY - 0.35, Math.min(roadRefY + 0.6, fbLocalY));
        }
        return Math.max(roadRefY - 0.85, waterRefY);
      }

      // Street utilities: anchor deterministically to street grade (never dragged down by sunken park bowls)
      const safeFbY = Number.isFinite(fbLocalY) ? Math.max(roadRefY - 0.65, fbLocalY) : roadRefY;
      if (roadAnchorPts.length > 0) {
        let wSum = 0.0;
        let wySum = 0.0;
        let minD2 = Infinity;
        for (let i = 0; i < roadAnchorPts.length; i++) {
          const p = roadAnchorPts[i];
          const d2 = (p.x - lx) * (p.x - lx) + (p.z - lz) * (p.z - lz);
          if (d2 < minD2) minD2 = d2;
          if (d2 <= 3600.0) {
            const w = 1.0 / (d2 + 16.0);
            wSum += w;
            wySum += w * p.y;
          }
        }
        if (wSum > 0) {
          const anchorY = wySum / wSum;
          if (anchorY > safeFbY) {
            const distM = Math.sqrt(minD2);
            const alpha = Math.max(0.0, Math.min(0.5, 1.0 - Math.max(0.0, distM - 10.0) / 50.0));
            return alpha * anchorY + (1.0 - alpha) * safeFbY;
          }
        }
      }
      return safeFbY;
    };

    UTILS_STATE.groundGridCache = {
      scanId: currentScanId,
      originH: originH,
      groundRefH: centerGroundH,
      catCount: catCount,
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
   * - Eliminates large-mesh lag by merging each layer into 1 Mesh + 1 LineSegments (~20 draw calls total).
   * - Eliminates zoomed-out flickering by using opaque polygonOffset materials + adaptive camera near-plane.
   * - Eliminates 45-degree rotated box culverts across diagonal alignments via `computeZeroRollBasis`.
   */
  function renderUtilities3D(payload = null) {
    clearUtilitiesVisuals3D();
    const studioThree = window.studioThree;
    if (!studioThree || !studioThree.scene || !UTILS_STATE.features || UTILS_STATE.features.length === 0) {
      return;
    }

    const zOffsetM = Number(UTILS_STATE.verticalOffsetM) || 0.0;
    const originTwd = resolveUtilitiesOriginTwd97();
    UTILS_STATE.lastRenderedOriginH = Number(originTwd?.h) || 0;
    const sampleLocalGroundY = createCanopyRejectingGroundSampler(payload, originTwd);
    const tpl = getUnitGeometryTemplates();

    const group = new THREE.Group();
    group.name = "PublicUtilitiesGroup";
    UTILS_STATE.threeGroup = group;

    // Per-layer batch buckets & 3D segment deduplication set
    const layerBuckets = {};
    const seen3DSegments = new Set();
    Object.keys(UTILITY_LAYERS).forEach((k) => {
      layerBuckets[k] = {
        stamps: [], // [{ isBox, midX, midY, midZ, sx, sy, sz, basis, feat }]
        linePositions: [], // [x1, y1, z1, x2, y2, z2, ...] for vertical depth leaders
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

        const featName = String(getFeatProp(feat, "name", ""));
        const featId = String(getFeatProp(feat, "id", ""));
        const isOpenChannel =
          Boolean(getFeatProp(feat, "is_open_channel", false)) ||
          (featId.startsWith("osm_waterway_") && /排水河道|排水渠道|攔水堰/.test(featName));

        const diaM = Math.max(0.15, (Number(getFeatProp(feat, "diameter_mm", 300)) || 300) / 1000.0);
        const widthProp = Number(getFeatProp(feat, "width_m", 0));
        const heightProp = Number(getFeatProp(feat, "height_m", 0));
        const isBox = fType === "box_culvert";
        const widthM = isBox ? Math.max(0.35, widthProp || diaM) : diaM;
        const rawHeightM = isBox ? Math.max(0.35, heightProp || diaM) : diaM;
        const heightM = isOpenChannel ? Math.min(0.75, rawHeightM) : rawHeightM;

        const defDepth = Number(ldef.defaultDepthM || 1.6);
        const rawGroundH = Number(getFeatProp(feat, "ground_h", NaN));
        const startGroundH = Number(getFeatProp(feat, "start_ground_h", Number.isFinite(rawGroundH) ? rawGroundH : NaN));
        const endGroundH = Number(getFeatProp(feat, "end_ground_h", startGroundH));

        const rawStartInvH = Number(getFeatProp(feat, "start_invert_h", NaN));
        const rawEndInvH = Number(getFeatProp(feat, "end_invert_h", rawStartInvH));
        const rawStartCoverM = Number(getFeatProp(feat, "start_cover_m", NaN));
        const rawEndCoverM = Number(getFeatProp(feat, "end_cover_m", rawStartCoverM));

        let startDepthM = Number(getFeatProp(feat, "start_depth_m", NaN));
        if (isOpenChannel) {
          startDepthM = 0.45;
        } else if (!Number.isFinite(startDepthM) || startDepthM <= 0) {
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
            startDepthM = Math.max(defDepth, heightM + 0.8);
          }
        }

        let endDepthM = Number(getFeatProp(feat, "end_depth_m", NaN));
        if (isOpenChannel) {
          endDepthM = 0.50;
        } else if (!Number.isFinite(endDepthM) || endDepthM <= 0) {
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
          const groundY = sampleLocalGroundY(v.x, v.z, interpGroundH, { isOpenChannel }) + zOffsetM;

          const rawInterpDepth = startDepthM + frac * (endDepthM - startDepthM);
          const invertDepthM = isOpenChannel
            ? Math.min(0.55, Math.max(0.25, rawInterpDepth))
            : Math.max(heightM + 0.25, rawInterpDepth);
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
          startCoverM: Math.max(0.0, firstDepthM - heightM),
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

          // Deduplicate coincident 3D segments within the same layer so two identical pipes never Z-fight
          const qx1 = Math.round(v1.x * 2);
          const qz1 = Math.round(v1.z * 2);
          const qx2 = Math.round(v2.x * 2);
          const qz2 = Math.round(v2.z * 2);
          const segKeyFwd = `${layerId}_${qx1}_${qz1}_${qx2}_${qz2}`;
          const segKeyRev = `${layerId}_${qx2}_${qz2}_${qx1}_${qz1}`;
          if (seen3DSegments.has(segKeyFwd) || seen3DSegments.has(segKeyRev)) continue;
          seen3DSegments.add(segKeyFwd);
          seen3DSegments.add(segKeyRev);

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

          // Vertical depth leader from pipe center up to road surface (no horizontal surface line to prevent terrain Z-fighting)
          const midGroundY = 0.5 * (gY1 + gY2);
          if (midGroundY > midY + 0.15) {
            bucket.linePositions.push(midX, midY, midZ, midX, midGroundY, midZ);
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
        const groundY = sampleLocalGroundY(vBase.x, vBase.z, rawRimH) + zOffsetM;

        const rawDepth = Number(getFeatProp(feat, "depth_m", NaN));
        const calcDepth =
          Number.isFinite(rawDepth) && rawDepth >= 0.5 && rawDepth <= 15.0
            ? rawDepth
            : Number.isFinite(rawRimH) && Number.isFinite(rawInvH) && rawRimH - rawInvH >= 0.5 && rawRimH - rawInvH <= 15.0
            ? rawRimH - rawInvH
            : 1.8;
        const depthM = Math.max(0.75, Math.min(8.0, calcDepth));
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

        // B. Single Clean Surface Manhole Cover Disk at rimY + 0.08m (no overlapping coplanar disks!)
        bucket.stamps.push({
          isBox: false,
          midX: vBase.x,
          midY: rimY + 0.08,
          midZ: vBase.z,
          sx: coverDia * 1.12,
          sy: 0.07,
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
          v2: new THREE.Vector3(vBase.x, rimY + 0.1, vBase.z),
          dist: depthM,
          radiusM: coverDia * 0.6,
        });
      }

      // 3. Above-ground Hydrant or Utility Pole
      else if (fType === "hydrant" || fType === "pole") {
        const coord = feat.coord || feat.geometry?.coordinates || [0, 0, 0];
        const vBase = twd97ToLocal(coord[0], coord[1], 0);
        const groundY = sampleLocalGroundY(vBase.x, vBase.z, getFeatProp(feat, "rim_h", NaN)) + zOffsetM;
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
    Object.keys(UTILITY_LAYERS).forEach((layerId, layerIdx) => {
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

        // Opaque depth-tested material with staggered per-layer polygonOffset prevents cross-layer Z-fighting
        const solidMat = new THREE.MeshStandardMaterial({
          color: new THREE.Color(ldef.color),
          emissive: new THREE.Color(ldef.color),
          emissiveIntensity: 0.28,
          roughness: 0.4,
          metalness: 0.22,
          transparent: false,
          opacity: 1.0,
          depthTest: true,
          depthWrite: true,
          polygonOffset: true,
          polygonOffsetFactor: -1 - layerIdx * 0.25,
          polygonOffsetUnits: -1 - layerIdx * 0.5,
        });

        const layerMesh = new THREE.Mesh(mergedGeo, solidMat);
        layerMesh.name = `UtilitiesLayerMesh_${layerId}`;
        layerMesh.renderOrder = -10 + layerIdx;
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

        // Companion depth-fail (THREE.GreaterDepth) subsurface X-Ray mesh sharing mergedGeo (0 extra vertex memory!)
        // Renders buried utilities through 100% opaque 3D scan tiles without moving terrain tiles to the transparent pass.
        const showXrayNow = Boolean(UTILS_STATE.active) && hasVisibleUtilities3D() && Number(UTILS_STATE.groundXrayPct) > 1;
        const initXrayAlpha = showXrayNow
          ? Math.max(0.14, Math.min(0.88, Number(((Number(UTILS_STATE.groundXrayPct) / 100.0) * 1.05).toFixed(2))))
          : 0.0;
        const xrayMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(ldef.color),
          transparent: true,
          opacity: initXrayAlpha,
          depthTest: true,
          depthWrite: false,
          depthFunc: THREE.GreaterDepth,
          polygonOffset: true,
          polygonOffsetFactor: -1.5 - layerIdx * 0.25,
          polygonOffsetUnits: -2 - layerIdx * 0.5,
        });
        const xrayMesh = new THREE.Mesh(mergedGeo, xrayMat);
        xrayMesh.name = `UtilitiesLayerXray_${layerId}`;
        xrayMesh.renderOrder = 18 + layerIdx;
        xrayMesh.userData = {
          isUtilityXray: true,
          layerId: layerId,
        };
        xrayMesh.visible = isLayerVis && showXrayNow;
        group.add(xrayMesh);
        UTILS_STATE.xrayMeshes.push(xrayMesh);
      }

      if (bucket.linePositions.length >= 6) {
        const lineGeo = new THREE.BufferGeometry();
        lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(bucket.linePositions, 3));
        const showXrayNow = Boolean(UTILS_STATE.active) && hasVisibleUtilities3D() && Number(UTILS_STATE.groundXrayPct) > 1;
        const lineMat = new THREE.LineBasicMaterial({
          color: new THREE.Color(ldef.color),
          transparent: true,
          opacity: showXrayNow ? 0.45 : 0.55,
          depthTest: !showXrayNow,
          depthWrite: false,
        });
        const lineSegs = new THREE.LineSegments(lineGeo, lineMat);
        lineSegs.name = `UtilitiesLayerLines_${layerId}`;
        lineSegs.renderOrder = 17 + layerIdx;
        lineSegs.userData = {
          layerId: layerId,
        };
        lineSegs.visible = isLayerVis;
        group.add(lineSegs);
        UTILS_STATE.lineMeshes.push(lineSegs);
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

    if (UTILS_STATE.active && anyLayerVisible && UTILS_STATE.groundXrayPct > 1) {
      applyUtilitiesGroundXray(UTILS_STATE.groundXrayPct);
    } else if (!UTILS_STATE.active || !anyLayerVisible) {
      restoreUtilitiesGroundOpacity();
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

    const showXrayNow = Boolean(UTILS_STATE.active) && hasVisibleUtilities3D() && Number(UTILS_STATE.groundXrayPct) > 1;
    UTILS_STATE.threeGroup.traverse((child) => {
      if (child === UTILS_STATE.threeGroup) {
        child.visible = anyLayerVisible;
        return;
      }
      const lyr = child.userData && child.userData.layerId ? UTILITY_LAYERS[child.userData.layerId] : null;
      const isLyrVis = anyLayerVisible && Boolean(lyr && lyr.visible === true);
      child.visible = child.userData && child.userData.isUtilityXray ? isLyrVis && showXrayNow : isLyrVis;
    });

    if (!anyLayerVisible) {
      hideUtilityHoverTooltip();
    }

    if (UTILS_STATE.active && anyLayerVisible && UTILS_STATE.groundXrayPct > 1) {
      applyUtilitiesGroundXray(UTILS_STATE.groundXrayPct);
    } else {
      restoreUtilitiesGroundOpacity();
    }

    if (studioThree && typeof studioThree.render === "function") {
      studioThree.render();
    } else if (studioThree && studioThree.renderer && studioThree.camera && studioThree.scene) {
      studioThree.renderer.render(studioThree.scene, studioThree.camera);
    }
  }

  /**
   * Interactive 3D ray-to-segment picker for selecting/hovering utility features in Studio (< 0.15ms).
   * Uses allocation-free scalar 3D ray-to-segment distance math over `UTILS_STATE.pipeMeshMap`, with fallback to
   * `mesh.userData.triToFeature[hit.faceIndex]` when requested.
   */
  const _pickRaycaster = window.THREE ? new THREE.Raycaster() : null;
  const _pickMouse = window.THREE ? new THREE.Vector2() : null;

  function pickUtilityFeatureAtScreenXY(screenX, screenY, opts = {}) {
    const studioThree = window.studioThree;
    if (!studioThree || !studioThree.camera || !UTILS_STATE.threeGroup || !UTILS_STATE.threeGroup.visible) {
      return null;
    }

    const domEl = studioThree.renderer.domElement;
    const rect = domEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const rc = _pickRaycaster || new THREE.Raycaster();
    const mouse = _pickMouse || new THREE.Vector2();
    mouse.set(((screenX - rect.left) / rect.width) * 2 - 1, -((screenY - rect.top) / rect.height) * 2 + 1);
    rc.setFromCamera(mouse, studioThree.camera);

    // Fast allocation-free 3D world-ray-to-segment distance check (< 0.15ms for 5,000+ segments)
    if (UTILS_STATE.pipeMeshMap && UTILS_STATE.pipeMeshMap.size > 0 && !opts.forceTriangleRaycast) {
      const ro = rc.ray.origin;
      const rd = rc.ray.direction;
      const rox = ro.x, roy = ro.y, roz = ro.z;
      const rdx = rd.x, rdy = rd.y, rdz = rd.z;
      const fovRad = ((studioThree.camera.fov || 50) * Math.PI) / 180.0;
      const pxToWorldFactor = (2.0 * Math.tan(fovRad * 0.5)) / Math.max(200.0, rect.height);
      let bestFeat = null;
      let bestScore = Infinity;

      UTILS_STATE.pipeMeshMap.forEach((entry) => {
        const lyr = UTILITY_LAYERS[entry.layer];
        if (!lyr || lyr.visible === false || !entry.feature) return;
        const v1 = entry.v1;
        const v2 = entry.v2;
        const sx = v2.x - v1.x;
        const sy = v2.y - v1.y;
        const sz = v2.z - v1.z;
        const wx = v1.x - rox;
        const wy = v1.y - roy;
        const wz = v1.z - roz;

        // Solve closest points between ray (ro + s*rd, s>=0) and segment (v1 + t*sVec, 0<=t<=1)
        const a = 1.0; // rd is unit vector
        const b = rdx * sx + rdy * sy + rdz * sz;
        const c = sx * sx + sy * sy + sz * sz;
        const d = rdx * wx + rdy * wy + rdz * wz;
        const e = sx * wx + sy * wy + sz * wz;
        const denom = a * c - b * b;

        let sRay = 0.0;
        let tSeg = 0.0;
        if (denom > 1e-6) {
          tSeg = (b * d - a * e) / denom;
          if (tSeg < 0.0) tSeg = 0.0;
          else if (tSeg > 1.0) tSeg = 1.0;
        }
        sRay = b * tSeg + d;
        if (sRay < 0.1) return; // Behind camera

        const px = v1.x + tSeg * sx;
        const py = v1.y + tSeg * sy;
        const pz = v1.z + tSeg * sz;
        const qx = rox + sRay * rdx;
        const qy = roy + sRay * rdy;
        const qz = roz + sRay * rdz;
        const distSq = (px - qx) * (px - qx) + (py - qy) * (py - qy) + (pz - qz) * (pz - qz);

        // Combine physical pipe radius and 11px screen tolerance at distance sRay
        const worldTol = Math.max((entry.radiusM || 0.25) * 1.15, sRay * pxToWorldFactor * 11.0);
        if (distSq <= worldTol * worldTol) {
          const normDist = Math.sqrt(distSq) / worldTol;
          const score = normDist * 10.0 + sRay * 0.002;
          if (score < bestScore) {
            bestScore = score;
            bestFeat = entry.feature;
          }
        }
      });

      if (bestFeat) return bestFeat;
    }

    if (opts.forceTriangleRaycast) {
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
    }

    return null;
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

  /**
   * Appends visible 3D Utility meshes and Categorized Tree/Wall meshes to Studio's raycast targets
   * so Group 1 tools (distance, angle, area, coordinates, laser) can directly hit them.
   */
  function collectExtraStudioPickTargets(targets) {
    if (!Array.isArray(targets)) return;
    if (UTILS_STATE.threeGroup && UTILS_STATE.threeGroup.visible && Array.isArray(UTILS_STATE.layerMeshes)) {
      for (let i = 0; i < UTILS_STATE.layerMeshes.length; i++) {
        const m = UTILS_STATE.layerMeshes[i];
        if (m && m.visible !== false) targets.push(m);
      }
    }
    const st = window.studioThree;
    if (st && st.categoryGroup && st.categoryGroup.visible && typeof STATE !== "undefined" && STATE.categorizeOverlayVisible) {
      st.categoryGroup.traverse((ch) => {
        if (ch && ch.isMesh && ch.visible !== false) {
          targets.push(ch);
        }
      });
    }
  }

  /**
   * Pushes snappable 3D vertices for visible Utilities (pipe/culvert/manhole endpoints + closest point on segment under cursor ray)
   * and visible Categorized Trees (trunk base + 1.3m DBH point) & Walls so Group 1 tools snap to them seamlessly.
   */
  function collectExtraSnappableVertices(pushV) {
    if (typeof pushV !== "function" || !window.THREE) return;
    const st = window.studioThree;

    // 1. Snap to visible 3D Public Utilities (closest point along ray + endpoints of nearby segments/manholes)
    if (UTILS_STATE.threeGroup && UTILS_STATE.threeGroup.visible && UTILS_STATE.pipeMeshMap && UTILS_STATE.pipeMeshMap.size > 0) {
      const rc = st && st.raycaster ? st.raycaster : null;
      const ro = rc && rc.ray ? rc.ray.origin : null;
      const rd = rc && rc.ray ? rc.ray.direction : null;

      if (ro && rd) {
        const rox = ro.x, roy = ro.y, roz = ro.z;
        const rdx = rd.x, rdy = rd.y, rdz = rd.z;
        let bestDistSq = Infinity;
        let bestPt = null;
        let bestV1 = null;
        let bestV2 = null;

        UTILS_STATE.pipeMeshMap.forEach((entry) => {
          const lyr = UTILITY_LAYERS[entry.layer];
          if (!lyr || lyr.visible === false || !entry.v1 || !entry.v2) return;
          const v1 = entry.v1;
          const v2 = entry.v2;
          const sx = v2.x - v1.x;
          const sy = v2.y - v1.y;
          const sz = v2.z - v1.z;
          const wx = v1.x - rox;
          const wy = v1.y - roy;
          const wz = v1.z - roz;

          const b = rdx * sx + rdy * sy + rdz * sz;
          const c = sx * sx + sy * sy + sz * sz;
          const d = rdx * wx + rdy * wy + rdz * wz;
          const e = sx * wx + sy * wy + sz * wz;
          const denom = c - b * b;

          let tSeg = 0.0;
          if (denom > 1e-6) {
            tSeg = (b * d - e) / denom;
            if (tSeg < 0.0) tSeg = 0.0;
            else if (tSeg > 1.0) tSeg = 1.0;
          }
          const sRay = b * tSeg + d;
          if (sRay < 0.1) return;

          const px = v1.x + tSeg * sx;
          const py = v1.y + tSeg * sy;
          const pz = v1.z + tSeg * sz;
          const qx = rox + sRay * rdx;
          const qy = roy + sRay * rdy;
          const qz = roz + sRay * rdz;
          const distSq = (px - qx) * (px - qx) + (py - qy) * (py - qy) + (pz - qz) * (pz - qz);
          const maxWorldTol = Math.max((entry.radiusM || 0.3) * 2.5, sRay * 0.035);
          if (distSq <= maxWorldTol * maxWorldTol) {
            // Always push segment endpoints (manhole rim/invert or pipe node) for exact vertex snapping
            pushV(v1, "utilities", -1, false);
            pushV(v2, "utilities", -1, false);
            if (distSq < bestDistSq) {
              bestDistSq = distSq;
              bestPt = new THREE.Vector3(px, py, pz);
              bestV1 = v1;
              bestV2 = v2;
            }
          }
        });

        if (bestPt) {
          if (bestV1) pushV(bestV1, "utilities", -1, false);
          if (bestV2) pushV(bestV2, "utilities", -1, false);
          const nearV1 = bestV1 && bestPt.distanceToSquared(bestV1) <= 0.45;
          const nearV2 = bestV2 && bestPt.distanceToSquared(bestV2) <= 0.45;
          if (!nearV1 && !nearV2) {
            pushV(bestPt, "utilities", -1, false);
          }
        }
      }
    }

    // 2. Snap to visible 3D Categorized Trees (trunk base, 1.3m DBH measurement point, and crown top) & Walls
    if (typeof STATE !== "undefined" && STATE.categorizeOverlayVisible && STATE.lastCategorizeResult) {
      const cat = STATE.lastCategorizeResult;
      const originTwd = typeof localToTwd97 === "function" ? localToTwd97({ x: 0, y: 0, z: 0 }) : { e: 0, n: 0, h: 0 };
      const treesVis = STATE.categorizeFilters?.trees !== false && STATE.categorizeLayerToggles?.trees !== false;
      const wallsVis = STATE.categorizeFilters?.walls !== false && STATE.categorizeLayerToggles?.walls !== false;

      if (treesVis && Array.isArray(cat.trees)) {
        cat.trees.forEach((trObj) => {
          let tx = NaN, ty = NaN, tz = NaN;
          if (Array.isArray(trObj.trunk_twd97) && trObj.trunk_twd97.length >= 3) {
            tx = Number(trObj.trunk_twd97[0]) - originTwd.e;
            ty = Number(trObj.trunk_twd97[2]) - originTwd.h;
            tz = originTwd.n - Number(trObj.trunk_twd97[1]);
          } else {
            const tLoc = trObj.trunk_local || trObj.base_local;
            if (Array.isArray(tLoc) && tLoc.length >= 3) {
              tx = Number(tLoc[0]);
              ty = Number(tLoc[1]);
              tz = Number(tLoc[2]);
            }
          }
          if (Number.isFinite(tx) && Number.isFinite(ty) && Number.isFinite(tz)) {
            const hM = Math.max(1.8, Number(trObj.height_m) || 4.0);
            pushV(new THREE.Vector3(tx, ty, tz), "categorize", -1, false);
            pushV(new THREE.Vector3(tx, ty + Math.min(1.3, hM * 0.45), tz), "categorize", -1, false);
            pushV(new THREE.Vector3(tx, ty + hM, tz), "categorize", -1, false);
          }
        });
      }
      if (wallsVis && Array.isArray(cat.walls)) {
        cat.walls.forEach((wObj) => {
          const pushTwdPoly = (poly) => {
            if (!Array.isArray(poly)) return;
            for (let i = 0; i < poly.length; i++) {
              const p = poly[i];
              if (Array.isArray(p) && p.length >= 3) {
                pushV(
                  new THREE.Vector3(Number(p[0]) - originTwd.e, Number(p[2]) - originTwd.h, originTwd.n - Number(p[1])),
                  "categorize",
                  -1,
                  false
                );
              }
            }
          };
          const pushLocPoly = (poly) => {
            if (!Array.isArray(poly)) return;
            for (let i = 0; i < poly.length; i++) {
              const p = poly[i];
              if (Array.isArray(p) && p.length >= 3) {
                pushV(new THREE.Vector3(Number(p[0]), Number(p[1]), Number(p[2])), "categorize", -1, false);
              }
            }
          };
          if (Array.isArray(wObj.base_polyline_twd97) || Array.isArray(wObj.top_polyline_twd97)) {
            pushTwdPoly(wObj.base_polyline_twd97);
            pushTwdPoly(wObj.top_polyline_twd97);
          } else {
            pushLocPoly(wObj.base_polyline_local);
            pushLocPoly(wObj.top_polyline_local);
          }
          if (Array.isArray(wObj.start_local) && wObj.start_local.length >= 3) {
            pushV(new THREE.Vector3(Number(wObj.start_local[0]), Number(wObj.start_local[1]), Number(wObj.start_local[2])), "categorize", -1, false);
          }
          if (Array.isArray(wObj.end_local) && wObj.end_local.length >= 3) {
            pushV(new THREE.Vector3(Number(wObj.end_local[0]), Number(wObj.end_local[1]), Number(wObj.end_local[2])), "categorize", -1, false);
          }
        });
      }
    }

    // 3. Snap & drag for Curved / Bent Extruded Surface control pins (S1..Sn and E1)
    if (
      typeof STATE !== "undefined" &&
      (STATE.activeTool === "flatness" || Boolean(st?.overlayGroup?.getObjectByName?.("GS_SurfaceQA_Overlay"))) &&
      window.QA_STATE &&
      window.QA_STATE.flatnessPlaneMode === "curved_extruded"
    ) {
      if (Array.isArray(STATE.flatnessSplinePoints)) {
        STATE.flatnessSplinePoints.forEach((pt, idx) => {
          if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y) && Number.isFinite(pt.z)) {
            pushV(pt, {
              source: "flatnessSplinePoints",
              measId: "__flatness_spline__",
              measType: "flatness",
              pointIndex: idx,
              label: `Spline S${idx + 1}`,
              editable: true,
            });
          }
        });
      }
      if (
        STATE.flatnessExtrusionHandle &&
        Number.isFinite(STATE.flatnessExtrusionHandle.x) &&
        Number.isFinite(STATE.flatnessExtrusionHandle.y) &&
        Number.isFinite(STATE.flatnessExtrusionHandle.z)
      ) {
        pushV(STATE.flatnessExtrusionHandle, {
          source: "flatnessExtrusionHandle",
          measId: "__flatness_extrude__",
          measType: "flatness",
          pointIndex: 0,
          label: "Extrude E1",
          editable: true,
        });
      }
    }
  }

  /**
   * Computes an exact 3D Laser cross-section/span when the user aims the Group 1 Laser tool
   * at a visible 3D Public Utility pipe/culvert/manhole or a 3D Categorized Tree.
   */
  function computeLaserSpanForOverlayHit(rawPt) {
    if (!rawPt || !window.THREE) return null;
    const originTwd = typeof localToTwd97 === "function" ? localToTwd97({ x: 0, y: 0, z: 0 }) : { e: 0, n: 0, h: 0 };

    // 1. Check visible 3D Categorized Trees
    if (
      typeof STATE !== "undefined" &&
      STATE.categorizeOverlayVisible &&
      STATE.categorizeFilters?.trees !== false &&
      STATE.lastCategorizeResult &&
      Array.isArray(STATE.lastCategorizeResult.trees)
    ) {
      for (let i = 0; i < STATE.lastCategorizeResult.trees.length; i++) {
        const trObj = STATE.lastCategorizeResult.trees[i];
        let tx = NaN, ty = NaN, tz = NaN;
        if (Array.isArray(trObj.trunk_twd97) && trObj.trunk_twd97.length >= 3) {
          tx = Number(trObj.trunk_twd97[0]) - originTwd.e;
          ty = Number(trObj.trunk_twd97[2]) - originTwd.h;
          tz = originTwd.n - Number(trObj.trunk_twd97[1]);
        } else {
          const tLoc = trObj.trunk_local || trObj.base_local;
          if (Array.isArray(tLoc) && tLoc.length >= 3) {
            tx = Number(tLoc[0]);
            ty = Number(tLoc[1]);
            tz = Number(tLoc[2]);
          }
        }
        if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(tz)) continue;
        const hM = Math.max(1.8, Number(trObj.height_m) || 4.0);
        const crownDia = Math.max(1.2, Number(trObj.crown_diameter_m) || Number(trObj.canopy_diameter_m) || hM * 0.65);
        const hDist = Math.hypot(rawPt.x - tx, rawPt.z - tz);
        if (hDist <= Math.max(0.9, crownDia * 0.6) && rawPt.y >= ty - 0.5 && rawPt.y <= ty + hM + 0.8) {
          const halfR = 0.5 * crownDia;
          const midY = ty + Math.min(1.3, hM * 0.45);
          return {
            kind: "road",
            originPt: new THREE.Vector3(tx, ty, tz),
            pA: new THREE.Vector3(tx - halfR, midY, tz),
            pB: new THREE.Vector3(tx + halfR, midY, tz),
            width: crownDia,
            orthoLength: crownDia,
            orthoPA: new THREE.Vector3(tx, midY, tz - halfR),
            orthoPB: new THREE.Vector3(tx, midY, tz + halfR),
            ceilHeight: hM,
            ceilPt: new THREE.Vector3(tx, ty + hM, tz),
            crossPt: new THREE.Vector3(tx, ty, tz),
            crossSlopePct: 0,
          };
        }
      }
    }

    // 2. Check visible 3D Public Utilities
    if (UTILS_STATE.threeGroup && UTILS_STATE.threeGroup.visible && UTILS_STATE.pipeMeshMap && UTILS_STATE.pipeMeshMap.size > 0) {
      let bestEntry = null;
      let bestDistSq = Infinity;
      let bestProj = null;

      UTILS_STATE.pipeMeshMap.forEach((entry) => {
        const lyr = UTILITY_LAYERS[entry.layer];
        if (!lyr || lyr.visible === false || !entry.v1 || !entry.v2) return;
        const v1 = entry.v1;
        const v2 = entry.v2;
        const sx = v2.x - v1.x, sy = v2.y - v1.y, sz = v2.z - v1.z;
        const lenSq = sx * sx + sy * sy + sz * sz;
        let t = lenSq > 1e-6 ? ((rawPt.x - v1.x) * sx + (rawPt.y - v1.y) * sy + (rawPt.z - v1.z) * sz) / lenSq : 0.0;
        t = Math.max(0.0, Math.min(1.0, t));
        const px = v1.x + t * sx, py = v1.y + t * sy, pz = v1.z + t * sz;
        const dSq = (rawPt.x - px) * (rawPt.x - px) + (rawPt.y - py) * (rawPt.y - py) + (rawPt.z - pz) * (rawPt.z - pz);
        const tol = Math.max(0.85, (entry.radiusM || 0.35) * 2.5);
        if (dSq <= tol * tol && dSq < bestDistSq) {
          bestDistSq = dSq;
          bestEntry = entry;
          bestProj = new THREE.Vector3(px, py, pz);
        }
      });

      if (bestEntry && bestProj) {
        const feat = bestEntry.feature || {};
        const v1 = bestEntry.v1;
        const v2 = bestEntry.v2;
        const segLen = Math.max(0.2, v1.distanceTo(v2));
        const wM = Math.max(0.2, Number(feat.width_m) || (Number(feat.diameter_mm) || 300) / 1000.0);
        const dx = v2.x - v1.x;
        const dz = v2.z - v1.z;
        const hLen = Math.hypot(dx, dz);
        const nx = hLen > 1e-4 ? -dz / hLen : 1.0;
        const nz = hLen > 1e-4 ? dx / hLen : 0.0;
        const halfW = 0.5 * wM;
        const c3d = feat.__computed3D || {};
        const groundH = Number(c3d.startGroundH ?? c3d.rimH ?? feat.start_ground_h ?? feat.rim_h ?? NaN);
        const groundY = Number.isFinite(groundH) ? groundH - originTwd.h : bestProj.y + (Number(feat.depth_m) || 1.5);
        const depthToGround = Math.max(0.2, groundY - bestProj.y);
        return {
          kind: "road",
          originPt: bestProj.clone(),
          pA: new THREE.Vector3(bestProj.x - nx * halfW, bestProj.y, bestProj.z - nz * halfW),
          pB: new THREE.Vector3(bestProj.x + nx * halfW, bestProj.y, bestProj.z + nz * halfW),
          width: wM,
          orthoLength: segLen,
          orthoPA: v1.clone(),
          orthoPB: v2.clone(),
          ceilHeight: depthToGround,
          ceilPt: new THREE.Vector3(bestProj.x, groundY, bestProj.z),
          crossPt: bestProj.clone(),
          crossSlopePct: (Math.abs(v2.y - v1.y) / Math.max(0.1, hLen)) * 100,
        };
      }
    }
    return null;
  }
  window.computeLaserSpanForOverlayHit = computeLaserSpanForOverlayHit;

  // Bind pointerdown & pointermove in Studio to select and hover-inspect 3D utility elements
  let _lastHoverPickMs = 0;
  window.addEventListener("pointermove", (ev) => {
    if (typeof STATE === "undefined" || (!isUtilitiesSidePanelOpen() && !hasVisibleUtilities3D())) {
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
    if (typeof STATE === "undefined" || !isUtilitiesSidePanelOpen()) return;
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
  window.openPublicUtilitiesInspector = openUtilitiesInspector;
  window.closeUtilitiesInspector = closeUtilitiesInspector;
  window.resetUtilitiesOnScanChange = resetUtilitiesOnScanChange;
  window.onUtilitiesPanelClosed = onUtilitiesPanelClosed;
  window.selectUtilityFeature = selectUtilityFeature;
  window.renderSelectedFeatureCardHtml = renderSelectedFeatureCardHtml;
  window.pickUtilityFeatureAtScreenXY = pickUtilityFeatureAtScreenXY;
  window.syncUserTracedUtilityToGisLayer = syncUserTracedUtilityToGisLayer;
  window.clearUserTracedUtilityFromGisLayer = clearUserTracedUtilityFromGisLayer;
  window.collectExtraStudioPickTargets = collectExtraStudioPickTargets;
  window.collectExtraSnappableVertices = collectExtraSnappableVertices;
  window.UTILITY_LAYERS = UTILITY_LAYERS;
  window.UTILS_STATE = UTILS_STATE;
})();
