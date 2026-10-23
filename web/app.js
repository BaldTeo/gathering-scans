/**
 * GatheringScans (scans.gatheren.cloud) — Frontend Studio Application
 * Implements:
 * 1. Geospatial Map Overview with Spatial Clustering & Hover Selection Popover
 * 2. 3D Scan Studio (Three.js + 3d-tiles-renderer + KTX2 + TWD97/TWVD2001)
 * 3. GatheringCloud-styled Measurement & Civil Surveying Toolbar:
 *    - Distance (3D, Horiz, Δh), Angle, Area (m² & 坪), Coordinates, Laser
 *    - Cut/Fill Volume & Material Stockpile Report Generator (PDF/HTML & Excel CSV)
 *    - Live 3D Elevation Contours & AutoCAD .DWG / .DXF Export (TWD97 + TWVD2001)
 *    - 2D Cross-Section Elevation Profile Graph
 *    - RTK Raw Camera Photo Pin Inspector
 *    - Section Box Clipping, 3D Geo-Comments, and GC_ScanOptimizer PC Action Drawer
 * 4. Multi-Date Side-by-Side Split Curtain Slider + ΔZ Change Detection Heatmap
 * 5. Scoped External Share Link Controls (/s/<token>) with Instant Revocation
 * 6. Client-Side Browser Offline Cache (CacheStorage + IndexedDB, 0B on Linux VPS)
 */

(function () {
  "use strict";

  // Polyfill Object3D.removeFromParent if needed
  if (window.THREE && window.THREE.Object3D && !window.THREE.Object3D.prototype.removeFromParent) {
    window.THREE.Object3D.prototype.removeFromParent = function () {
      if (this.parent !== null) this.parent.remove(this);
      return this;
    };
  }

  let sharedKtx2Loader = null;
  function getKTX2Loader(renderer) {
    if (!sharedKtx2Loader && window.THREE && window.THREE.KTX2Loader) {
      try {
        sharedKtx2Loader = new window.THREE.KTX2Loader();
        sharedKtx2Loader.setTranscoderPath("/lib/basis/");
        if (renderer) sharedKtx2Loader.detectSupport(renderer);
      } catch (e) {
        console.warn("[GatheringScans] KTX2Loader init warning:", e);
      }
    }
    return sharedKtx2Loader;
  }

  const DEFAULT_GOOGLE_MAPS_API_KEY =
    window.DEFAULT_GOOGLE_MAPS_API_KEY || "AIzaSyBhHW138sGKgzKHDOTvv4RePukr_q2VbqQ";

  const GOOGLE_OAUTH_CLIENT_ID =
    window.GOOGLE_OAUTH_CLIENT_ID ||
    "753778992341-hpe65ilnti31j0m7etmq5rn7a1q802da.apps.googleusercontent.com";

  // Load persisted user profile only if explicitly authorized in this browser session
  function getInitialCurrentUser() {
    try {
      const verified = localStorage.getItem("gs_auth_verified_v1") === "1";
      if (!verified) return null;
      const saved =
        localStorage.getItem("gathering_user_profile") ||
        localStorage.getItem("gs_current_user");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.email) {
          if (
            String(parsed.email).toLowerCase() === "glibivanov@gatheren.com.tw" &&
            (!parsed.name || parsed.name === "Glib Ivanov")
          ) {
            parsed.name = "雲在天";
          }
          return Object.assign({ offlineCacheEnabled: true }, parsed);
        }
      }
    } catch (e) {
      // ignore
    }
    return null;
  }

  const initialShareToken = new URLSearchParams(window.location.search).get("share") || "";
  const initialUser = getInitialCurrentUser();

  // Application State
  const STATE = {
    activeView: "map",
    scans: [],
    projects: [],
    materials: {},
    activeScanId: "",
    activeScan: null,
    activeProjectGroup: "",
    projectFilterQuery: "",
    siteTimelineOpen: false,
    selectedTimelineScanId: "",
    capturedThumbs: new Set(),
    scanBrightness: 1.0,
    mapLyrs: "y", // 'y' = Google Satellite Hybrid, 'm' = Google Roadmap
    activeTool: "distance",
    snapEnabled: true,
    pcOnline: true,
    shareToken: initialShareToken,
    shareLinkInfo: null,
    currentUser: initialUser,
    isAuthorized: Boolean(initialUser && initialUser.email) || Boolean(initialShareToken),
    themePreference: localStorage.getItem("gs_theme_pref") || "auto",
    resolvedTheme: "light",
    teamProfiles: [],
    cachedScanIds: new Set(JSON.parse(localStorage.getItem("gs_cached_scans") || "[]")),
    measurePoints: [],
    maskBoundaryPoints: [],
    completedMeasurements: [],
    tempDistanceObjects: [],
    tempDistanceBadges: [],
    badges2D: [],
    volumeBadges2D: [],
    lastVolumeResult: null,
    lastContoursResult: null,
    lastProfileResult: null,
  };

  function resolveThemeFromPreference(pref) {
    const p = String(pref || "auto").toLowerCase();
    if (p === "light" || p === "dark") return p;
    const hr = new Date().getHours();
    return hr >= 6 && hr < 18 ? "light" : "dark";
  }

  // Apply initial theme attribute & authorization lock immediately to avoid flash
  STATE.resolvedTheme = resolveThemeFromPreference(STATE.themePreference);
  document.documentElement.setAttribute("data-theme", STATE.resolvedTheme);
  document.documentElement.setAttribute("data-theme-pref", STATE.themePreference);
  if (!STATE.isAuthorized && document.body) {
    document.body.classList.add("gs-auth-locked");
  }

  // Aggregate unique project groups dynamically (scales cleanly to 100+ projects)
  function getProjectGroupsList(filterQuery = "") {
    const q = String(filterQuery || "").trim().toLowerCase();
    const map = new Map();
    STATE.scans.forEach((s) => {
      const g = s.project_group || "Unassigned Site";
      if (!map.has(g)) {
        map.set(g, {
          project_group: g,
          project_name_zh: s.project_name_zh || "",
          lat: s.lat || 24.92032,
          lon: s.lon || 121.54351,
          scans: [],
        });
      }
      map.get(g).scans.push(s);
    });
    let list = Array.from(map.values()).sort(
      (a, b) => b.scans.length - a.scans.length || a.project_group.localeCompare(b.project_group)
    );
    if (q) {
      list = list.filter((grp) => {
        if (grp.project_group.toLowerCase().includes(q)) return true;
        if ((grp.project_name_zh || "").toLowerCase().includes(q)) return true;
        return grp.scans.some(
          (s) =>
            (s.name || "").toLowerCase().includes(q) ||
            (s.scan_id || "").toLowerCase().includes(q) ||
            (s.capture_date || "").toLowerCase().includes(q)
        );
      });
    }
    return list;
  }

  // Populate all project & scan selectors across Map, Timeline, Studio, and Compare (Supports 100+ Projects)
  function populateProjectScanDropdowns(projectGroup, preferredScanId = null) {
    const allGroups = getProjectGroupsList("");
    if (projectGroup && allGroups.some((g) => g.project_group === projectGroup)) {
      STATE.activeProjectGroup = projectGroup;
    } else if (STATE.activeScan && STATE.activeScan.project_group) {
      STATE.activeProjectGroup = STATE.activeScan.project_group;
    } else if (!STATE.activeProjectGroup && allGroups.length > 0) {
      STATE.activeProjectGroup = allGroups[0].project_group;
    }

    // 1. Populate Map Project Selector (#mapProjectSelect) with search filter support
    const mapProjSel = document.getElementById("mapProjectSelect");
    if (mapProjSel) {
      const filteredGroups = getProjectGroupsList(STATE.projectFilterQuery);
      const prevMapVal = mapProjSel.value;
      mapProjSel.innerHTML = "";
      const allOpt = document.createElement("option");
      allOpt.value = "__all__";
      allOpt.textContent = STATE.projectFilterQuery
        ? `Filtered Projects (${filteredGroups.length} / ${allGroups.length} Sites)`
        : `All Projects (${allGroups.length} Site${allGroups.length === 1 ? "" : "s"} · ${STATE.scans.length} Scans)`;
      mapProjSel.appendChild(allOpt);

      filteredGroups.forEach((grp) => {
        const opt = document.createElement("option");
        opt.value = grp.project_group;
        opt.textContent = `${grp.project_group} (${grp.scans.length} Scan${grp.scans.length === 1 ? "" : "s"})`;
        mapProjSel.appendChild(opt);
      });

      if (STATE.activeProjectGroup && filteredGroups.some((g) => g.project_group === STATE.activeProjectGroup)) {
        mapProjSel.value = STATE.activeProjectGroup;
      } else if (prevMapVal && Array.from(mapProjSel.options).some((o) => o.value === prevMapVal)) {
        mapProjSel.value = prevMapVal;
      } else {
        mapProjSel.value = "__all__";
      }
    }

    // 2. Populate Timeline, Studio, and Compare Project Switcher Dropdowns
    ["timelineProjectSelect", "studioProjectSelect", "compareProjectSelect"].forEach((selId) => {
      const sel = document.getElementById(selId);
      if (!sel) return;
      sel.innerHTML = "";
      allGroups.forEach((grp) => {
        const opt = document.createElement("option");
        opt.value = grp.project_group;
        opt.textContent = `${grp.project_group} (${grp.scans.length})`;
        sel.appendChild(opt);
      });
      if (STATE.activeProjectGroup && allGroups.some((g) => g.project_group === STATE.activeProjectGroup)) {
        sel.value = STATE.activeProjectGroup;
      }
    });

    // Update hidden badges for backward compatibility
    const studioBadge = document.getElementById("studioProjectGroupBadge");
    if (studioBadge) studioBadge.textContent = STATE.activeProjectGroup;
    const cmpBadge = document.getElementById("compareProjectGroupBadge");
    if (cmpBadge) cmpBadge.textContent = STATE.activeProjectGroup;

    // 3. Populate Scan Selectors strictly for the active project
    let projectScans = STATE.scans.filter((s) => s.project_group === STATE.activeProjectGroup);
    if (!projectScans.length) {
      projectScans = STATE.scans.slice();
    }

    const studioSel = document.getElementById("studioScanSelect");
    const cmpLeft = document.getElementById("compareLeftSelect");
    const cmpRight = document.getElementById("compareRightSelect");

    [studioSel, cmpLeft, cmpRight].forEach((sel) => {
      if (!sel) return;
      const prevVal = sel.value;
      sel.innerHTML = "";
      projectScans.forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s.scan_id;
        opt.textContent = `${s.name} (${s.capture_date || ""})`;
        sel.appendChild(opt);
      });
      if (preferredScanId && projectScans.some((s) => s.scan_id === preferredScanId)) {
        sel.value = preferredScanId;
      } else if (prevVal && projectScans.some((s) => s.scan_id === prevVal)) {
        sel.value = prevVal;
      } else if (projectScans.length > 0) {
        sel.value = projectScans[0].scan_id;
      }
    });

    if (cmpLeft && cmpRight && projectScans.length >= 2 && cmpLeft.value === cmpRight.value) {
      cmpLeft.value = projectScans[1].scan_id;
      cmpRight.value = projectScans[0].scan_id;
    }
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function showToast(msg, durationMs = 3400) {
    const el = document.getElementById("gsToast");
    if (!el) return;
    el.textContent = msg;
    el.style.display = "block";
    clearTimeout(el._timer);
    el._timer = setTimeout(() => {
      el.style.display = "none";
    }, durationMs);
  }

  function apiHeaders(extra = {}) {
    const h = Object.assign({ "Content-Type": "application/json" }, extra);
    if (STATE.shareToken) h["X-Share-Token"] = STATE.shareToken;
    if (STATE.currentUser && STATE.currentUser.email) {
      h["X-User-Email"] = STATE.currentUser.email;
    }
    return h;
  }

  const ROLE_LEVELS_MAP = { owner: 5, admin: 4, editor: 3, viewer: 2, guest: 1 };
  const ROLE_LABELS_MAP = {
    owner: "1. Owner (System Owner)",
    admin: "2. Admin (Manage Users & Workflows)",
    editor: "3. Editor (Edit Names & Run Scans)",
    viewer: "4. Viewer (View All & Measure)",
    guest: "5. Guest (Single Scan · Basic Tools)",
  };

  function getCurrentUserRoleInfo() {
    if (STATE.shareToken) {
      return {
        role: "guest",
        level: 1,
        label: ROLE_LABELS_MAP.guest,
        canEditNames: false,
        canRunWorkflows: false,
        canManageUsers: false,
        isGuestSingleScan: true,
      };
    }
    const email = String(STATE.currentUser?.email || "").trim().toLowerCase();
    let role = String(STATE.currentUser?.role || "viewer").trim().toLowerCase();
    if (email === "glibivanov@gatheren.com.tw") {
      role = "owner";
    } else if (!ROLE_LEVELS_MAP[role]) {
      role = "viewer";
    }
    const level = ROLE_LEVELS_MAP[role] || 2;
    return {
      role,
      level,
      label: ROLE_LABELS_MAP[role] || "Viewer",
      canEditNames: level >= 3,
      canRunWorkflows: level >= 3,
      canManageUsers: level >= 4,
      isGuestSingleScan: role === "guest",
    };
  }

  function applyRolePermissionsToUI() {
    const info = getCurrentUserRoleInfo();
    const setDisp = (id, show, disp = "") => {
      const el = document.getElementById(id);
      if (el) el.style.display = show ? disp : "none";
    };

    // 1. Rename Site & Rename Scan buttons (Editor, Admin, Owner only)
    [
      "btnRenameMapSite",
      "btnRenamePopoverSite",
      "btnRenameTimelineSite",
      "btnRenameStudioSite",
      "btnRenamePreviewScan",
      "btnRenameStudioScan",
    ].forEach((id) => setDisp(id, info.canEditNames, "inline-flex"));

    // 2. Re-run Scan & PC Resource / Optimizer / Queue buttons (Editor, Admin, Owner only; hidden for Viewer & Guest)
    [
      "btnRerunPreviewScan",
      "btnRerunStudioScan",
      "btnOpenOptimizer",
      "btnDockOptimizer",
      "pcStatusChip",
    ].forEach((id) => setDisp(id, info.canRunWorkflows, "inline-flex"));

    // 3. Sharing & Settings buttons (Hidden for Guest)
    setDisp("btnOpenSharing", info.level >= 3, "inline-flex");
    setDisp("btnPopoverShareGroup", info.level >= 3, "inline-flex");
    setDisp("btnTimelineShare", info.level >= 3, "inline-flex");

    // 4. Guest restrictions: only 1 scan (via guest link) and only basic tools (Distance, Area, Coordinates)
    const isGuest = info.isGuestSingleScan;
    setDisp("btnNavMap", !isGuest, "inline-flex");
    setDisp("btnNavCompare", !isGuest, "inline-flex");
    setDisp("btnStudioBackToTimeline", !isGuest, "inline-flex");
    setDisp("studioProjectSelect", !isGuest, "inline-block");
    const studioScanSel = document.getElementById("studioScanSelect");
    if (studioScanSel) studioScanSel.disabled = isGuest;

    // Advanced surveying tools hidden for Guest (Guest keeps Distance, Area, Coordinates, Snap, Clear)
    [
      "btnMeasureAngle",
      "btnMeasureLaser",
      "btnMeasureVolume",
      "btnMeasureContours",
      "btnMeasureProfile",
      "btnMeasurePhotos",
      "btnStudioSurveyReport",
      "btnDockVolume",
      "btnDockContours",
      "btnDockSection",
      "btnDockComments",
    ].forEach((id) => setDisp(id, !isGuest, "inline-flex"));

    // Role badge in Settings Admin Control Panel
    const badgeRole = document.getElementById("badgeCurrentUserRoleLevel");
    if (badgeRole) {
      badgeRole.textContent = `Active Role: ${info.label}`;
    }
    const adminForm = document.getElementById("adminUserEditorForm");
    if (adminForm) {
      adminForm.style.display = info.canManageUsers ? "grid" : "none";
    }
  }

  async function apiGet(url) {
    const sep = url.includes("?") ? "&" : "?";
    const fullUrl = STATE.shareToken ? `${url}${sep}share=${encodeURIComponent(STATE.shareToken)}` : url;
    const res = await fetch(fullUrl, { headers: apiHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function apiPost(url, body = {}) {
    const sep = url.includes("?") ? "&" : "?";
    const fullUrl = STATE.shareToken ? `${url}${sep}share=${encodeURIComponent(STATE.shareToken)}` : url;
    const res = await fetch(fullUrl, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // Register Client-Side Offline Service Worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[GatheringScans] ServiceWorker registration note:", err);
    });
  }

  // ============================================================================
  // 1. GOOGLE MAPS OVERVIEW & SPATIAL CLUSTERING (Requirement 4.a & Fix #3)
  // ============================================================================
  let gsMap = null;

  function latLonToNormMercator(lat, lon) {
    const u = (lon + 180) / 360;
    const sinLat = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
    const v = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
    return { u, v };
  }

  function normMercatorToLatLon(u, v) {
    const lon = u * 360 - 180;
    const n = Math.PI - 2 * Math.PI * v;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lat, lon };
  }

  function initMap() {
    const container = document.getElementById("mapContainer");
    if (!container || gsMap) return;

    container.style.position = "relative";
    container.style.overflow = "hidden";
    container.style.touchAction = "none";
    container.style.userSelect = "none";
    container.style.webkitUserSelect = "none";

    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    canvas.style.touchAction = "none";
    canvas.style.cursor = "grab";
    container.appendChild(canvas);

    const markerLayer = document.createElement("div");
    markerLayer.style.position = "absolute";
    markerLayer.style.inset = "0";
    markerLayer.style.pointerEvents = "none";
    markerLayer.style.touchAction = "none";
    container.appendChild(markerLayer);

    // Google Maps attribution badge (bottom-left)
    const gAttr = document.createElement("div");
    gAttr.style.cssText =
      "position:absolute;bottom:10px;left:14px;background:rgba(255,255,255,0.92);border:1px solid #cbd5e1;border-radius:6px;padding:3px 9px;font-size:11px;font-weight:600;color:#0f172a;z-index:400;pointer-events:none;box-shadow:0 2px 8px rgba(15,23,42,0.12);";
    gAttr.textContent = "Google Maps · TWD97 (121) + TWVD2001";
    container.appendChild(gAttr);

    // Touch-friendly Map Zoom & Reset Controls (bottom-right)
    const zoomCtrl = document.createElement("div");
    zoomCtrl.className = "gs-map-zoom-controls";
    zoomCtrl.innerHTML = `
      <button type="button" class="gs-map-zoom-btn" id="btnMapZoomIn" title="Zoom In">+</button>
      <button type="button" class="gs-map-zoom-btn" id="btnMapZoomOut" title="Zoom Out">−</button>
      <button type="button" class="gs-map-zoom-btn" id="btnMapResetView" title="Fit All Scan Sites" style="font-size:11px;">⟲</button>
    `;
    container.appendChild(zoomCtrl);

    gsMap = {
      container,
      canvas,
      ctx: canvas.getContext("2d"),
      markerLayer,
      centerLat: 24.976,
      centerLon: 121.522,
      zoom: 11.75,
      groups: [],
      tileCache: new Map(),
      dragging: false,
      dragMovedPx: 0,
      lastX: 0,
      lastY: 0,
      activePointers: new Map(),
      pinchPrevDist: 0,
      pinchPrevMid: null,
      lastTouchHandledAt: 0,
    };

    const projectLatLon = (lat, lon) => {
      const w = canvas.width || container.clientWidth || 1280;
      const h = canvas.height || container.clientHeight || 800;
      const worldPx = 256 * Math.pow(2, gsMap.zoom);
      const c = latLonToNormMercator(gsMap.centerLat, gsMap.centerLon);
      const p = latLonToNormMercator(lat, lon);
      const x = w * 0.50 + (p.u - c.u) * worldPx;
      const y = h * 0.50 + (p.v - c.v) * worldPx;
      return { x, y };
    };

    const unprojectXY = (x, y) => {
      const w = canvas.width || container.clientWidth || 1280;
      const h = canvas.height || container.clientHeight || 800;
      const worldPx = 256 * Math.pow(2, gsMap.zoom);
      const c = latLonToNormMercator(gsMap.centerLat, gsMap.centerLon);
      const u = c.u + (x - w * 0.50) / worldPx;
      const v = c.v + (y - h * 0.50) / worldPx;
      return normMercatorToLatLon(u, v);
    };

    gsMap.projectLatLon = projectLatLon;
    gsMap.unprojectXY = unprojectXY;

    const getGoogleTileImage = (lyrs, z, tx, ty) => {
      const maxTile = 1 << z;
      if (ty < 0 || ty >= maxTile) return null;
      const wrappedTx = ((tx % maxTile) + maxTile) % maxTile;
      const cacheKey = `${lyrs}_${z}_${wrappedTx}_${ty}`;
      if (gsMap.tileCache.has(cacheKey)) {
        return gsMap.tileCache.get(cacheKey);
      }
      const sub = (wrappedTx + ty) & 3;
      const apiKey = encodeURIComponent(DEFAULT_GOOGLE_MAPS_API_KEY);
      const img = new Image();
      img.crossOrigin = "anonymous";
      const entry = { img, loaded: false };
      gsMap.tileCache.set(cacheKey, entry);
      img.onload = () => {
        entry.loaded = true;
        if (gsMap && gsMap.drawMap) gsMap.drawMap();
      };
      img.onerror = () => {
        if (!entry._retriedKeyless) {
          entry._retriedKeyless = true;
          img.src = `https://mt${sub}.google.com/vt/lyrs=${lyrs}&hl=zh-TW&x=${wrappedTx}&y=${ty}&z=${z}`;
        }
      };
      img.src = `https://mt${sub}.google.com/vt/lyrs=${lyrs}&hl=zh-TW&x=${wrappedTx}&y=${ty}&z=${z}&key=${apiKey}`;
      return entry;
    };

    const updateCursorCoordsHud = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      const { lat, lon } = unprojectXY(clientX - rect.left, clientY - rect.top);
      const twdE = 250000 + (lon - 121.0) * 101750;
      const twdN = lat * 110760;
      const coordEl = document.getElementById("mapCursorCoords");
      if (coordEl) {
        coordEl.textContent = `TWD97(121) E: ${twdE.toFixed(1)}m | N: ${twdN.toFixed(1)}m | WGS84: ${lat.toFixed(5)}°N, ${lon.toFixed(5)}°E`;
      }
    };

    const panByPixels = (dx, dy) => {
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return;
      const worldPx = 256 * Math.pow(2, gsMap.zoom);
      const c = latLonToNormMercator(gsMap.centerLat, gsMap.centerLon);
      const next = normMercatorToLatLon(c.u - dx / worldPx, c.v - dy / worldPx);
      gsMap.centerLat = Math.max(-80.0, Math.min(80.0, next.lat));
      gsMap.centerLon = Math.max(-179.9, Math.min(179.9, next.lon));
      drawMap();
    };

    const zoomAroundClientPoint = (nextZoom, clientX, clientY) => {
      const clampedZoom = Math.max(8.0, Math.min(19.0, nextZoom));
      if (Math.abs(clampedZoom - gsMap.zoom) < 1e-4) return;
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const w = canvas.width || container.clientWidth || 1280;
      const h = canvas.height || container.clientHeight || 800;
      const anchorWorldBefore = 256 * Math.pow(2, gsMap.zoom);
      const cBefore = latLonToNormMercator(gsMap.centerLat, gsMap.centerLon);
      const anchorU = cBefore.u + (px - w * 0.50) / anchorWorldBefore;
      const anchorV = cBefore.v + (py - h * 0.50) / anchorWorldBefore;

      gsMap.zoom = clampedZoom;
      const anchorWorldAfter = 256 * Math.pow(2, gsMap.zoom);
      const nextCenterU = anchorU - (px - w * 0.50) / anchorWorldAfter;
      const nextCenterV = anchorV - (py - h * 0.50) / anchorWorldAfter;
      const nextCenter = normMercatorToLatLon(nextCenterU, nextCenterV);
      gsMap.centerLat = Math.max(-80.0, Math.min(80.0, nextCenter.lat));
      gsMap.centerLon = Math.max(-179.9, Math.min(179.9, nextCenter.lon));
      drawMap();
    };

    const drawMap = () => {
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, container.clientHeight);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = gsMap.ctx;

      // Base fill while Google tiles stream
      ctx.fillStyle = STATE.mapLyrs === "m" ? "#e2e8f0" : "#0b1726";
      ctx.fillRect(0, 0, w, h);

      // Render Web Mercator Google Maps Tiles (Satellite Hybrid 'y' or Roadmap 'm')
      const zInt = Math.max(8, Math.min(19, Math.round(gsMap.zoom)));
      const numTiles = 1 << zInt;
      const tileScale = 256 * Math.pow(2, gsMap.zoom - zInt);
      const cNorm = latLonToNormMercator(gsMap.centerLat, gsMap.centerLon);
      const centerTx = cNorm.u * numTiles;
      const centerTy = cNorm.v * numTiles;
      const centerX = w * 0.50;
      const centerY = h * 0.50;

      const minTx = Math.floor(centerTx - centerX / tileScale) - 1;
      const maxTx = Math.ceil(centerTx + (w - centerX) / tileScale) + 1;
      const minTy = Math.floor(centerTy - centerY / tileScale) - 1;
      const maxTy = Math.ceil(centerTy + (h - centerY) / tileScale) + 1;

      for (let ty = minTy; ty <= maxTy; ty++) {
        for (let tx = minTx; tx <= maxTx; tx++) {
          const px = centerX + (tx - centerTx) * tileScale;
          const py = centerY + (ty - centerTy) * tileScale;
          const tileEntry = getGoogleTileImage(STATE.mapLyrs, zInt, tx, ty);
          if (tileEntry && tileEntry.loaded) {
            ctx.drawImage(tileEntry.img, Math.floor(px), Math.floor(py), Math.ceil(tileScale) + 1, Math.ceil(tileScale) + 1);
          } else if (zInt > 10) {
            // Fallback parent tile while zooming
            const pZ = zInt - 1;
            const pEntry = gsMap.tileCache.get(`${STATE.mapLyrs}_${pZ}_${tx >> 1}_${ty >> 1}`);
            if (pEntry && pEntry.loaded) {
              const sx = (tx & 1) * 128;
              const sy = (ty & 1) * 128;
              ctx.drawImage(pEntry.img, sx, sy, 128, 128, Math.floor(px), Math.floor(py), Math.ceil(tileScale) + 1, Math.ceil(tileScale) + 1);
            }
          }
        }
      }

      // Subtle TWD97 (121) Coordinate Grid Overlay
      ctx.strokeStyle = STATE.mapLyrs === "m" ? "rgba(2, 132, 199, 0.16)" : "rgba(56, 189, 248, 0.18)";
      ctx.lineWidth = 1;
      ctx.fillStyle = STATE.mapLyrs === "m" ? "rgba(15, 23, 42, 0.72)" : "rgba(248, 250, 252, 0.80)";
      ctx.font = "600 10px Consolas, monospace";

      for (let lon = 121.35; lon <= 121.68; lon += 0.05) {
        const p = projectLatLon(gsMap.centerLat, lon);
        ctx.beginPath();
        ctx.moveTo(p.x, 0);
        ctx.lineTo(p.x, h);
        ctx.stroke();
        const twdE = Math.round(250000 + (lon - 121.0) * 101750);
        ctx.fillText(`E:${twdE}m`, p.x + 4, h - 12);
      }
      for (let lat = 24.85; lat <= 25.12; lat += 0.05) {
        const p = projectLatLon(lat, gsMap.centerLon);
        ctx.beginPath();
        ctx.moveTo(0, p.y);
        ctx.lineTo(w, p.y);
        ctx.stroke();
        const twdN = Math.round(lat * 110760);
        ctx.fillText(`N:${twdN}m`, 14, p.y - 4);
      }

      // Draw Scan Geofence Rings & Position Cluster Blobs
      gsMap.groups.forEach((grp) => {
        const pos = projectLatLon(grp.lat, grp.lon);
        const isCurrentGroup = grp.project_group === STATE.activeProjectGroup;

        // Outer radar ring
        ctx.strokeStyle = isCurrentGroup ? "rgba(2, 132, 199, 0.65)" : "rgba(56, 189, 248, 0.40)";
        ctx.lineWidth = isCurrentGroup ? 1.8 : 1.2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 58, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        // Inner geofence ring
        ctx.strokeStyle = "#0284c7";
        ctx.fillStyle = isCurrentGroup ? "rgba(2, 132, 199, 0.28)" : "rgba(2, 132, 199, 0.16)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 36, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        if (grp.el) {
          grp.el.style.left = `${pos.x}px`;
          grp.el.style.top = `${pos.y}px`;
        }
      });
    };

    gsMap.drawMap = drawMap;
    gsMap.panByPixels = panByPixels;
    gsMap.zoomAroundClientPoint = zoomAroundClientPoint;

    // Map Zoom Buttons
    document.getElementById("btnMapZoomIn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      gsMap.zoom = Math.min(19.0, gsMap.zoom + 0.75);
      drawMap();
    });
    document.getElementById("btnMapZoomOut")?.addEventListener("click", (e) => {
      e.stopPropagation();
      gsMap.zoom = Math.max(8.0, gsMap.zoom - 0.75);
      drawMap();
    });
    document.getElementById("btnMapResetView")?.addEventListener("click", (e) => {
      e.stopPropagation();
      gsMap.centerLat = 24.976;
      gsMap.centerLon = 121.522;
      gsMap.zoom = 11.75;
      drawMap();
    });

    // Map Layer Switcher (Hybrid vs Map)
    document.querySelectorAll("#mapLayerSwitcher .btn-seg").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#mapLayerSwitcher .btn-seg").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        STATE.mapLyrs = btn.dataset.lyrs || "y";
        drawMap();
      });
    });

    const isInteractiveMapHudControl = (target) => {
      if (!target || !target.closest) return false;
      return Boolean(target.closest(".gs-map-zoom-controls, input, select, button, a"));
    };

    // Dedicated Touch Events (passive: false) for 1-finger pan & 2-finger pinch-to-zoom on Android/iOS tablets
    container.addEventListener(
      "touchstart",
      (e) => {
        if (isInteractiveMapHudControl(e.target)) return;
        if (e.touches.length === 1) {
          const t = e.touches[0];
          gsMap.dragging = true;
          gsMap.dragMovedPx = 0;
          gsMap.lastX = t.clientX;
          gsMap.lastY = t.clientY;
          gsMap.pinchPrevDist = 0;
          gsMap.pinchPrevMid = null;
          gsMap.touchStartClusterBlob = e.target && e.target.closest ? e.target.closest(".scan-cluster-blob") : null;
          updateCursorCoordsHud(t.clientX, t.clientY);
        } else if (e.touches.length >= 2) {
          if (e.cancelable) e.preventDefault();
          const t0 = e.touches[0];
          const t1 = e.touches[1];
          gsMap.dragging = false;
          gsMap.touchStartClusterBlob = null;
          gsMap.pinchPrevDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
          gsMap.pinchPrevMid = {
            x: (t0.clientX + t1.clientX) * 0.5,
            y: (t0.clientY + t1.clientY) * 0.5,
          };
        }
      },
      { passive: false }
    );

    container.addEventListener(
      "touchmove",
      (e) => {
        if (isInteractiveMapHudControl(e.target) && !gsMap.dragging && !gsMap.pinchPrevDist) return;
        if (e.touches.length === 1) {
          if (e.cancelable) e.preventDefault();
          const t = e.touches[0];
          if (!gsMap.dragging) {
            gsMap.dragging = true;
            gsMap.lastX = t.clientX;
            gsMap.lastY = t.clientY;
            return;
          }
          const dx = t.clientX - gsMap.lastX;
          const dy = t.clientY - gsMap.lastY;
          gsMap.dragMovedPx += Math.hypot(dx, dy);
          gsMap.lastX = t.clientX;
          gsMap.lastY = t.clientY;
          panByPixels(dx, dy);
          updateCursorCoordsHud(t.clientX, t.clientY);
        } else if (e.touches.length >= 2) {
          if (e.cancelable) e.preventDefault();
          const t0 = e.touches[0];
          const t1 = e.touches[1];
          const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
          const midX = (t0.clientX + t1.clientX) * 0.5;
          const midY = (t0.clientY + t1.clientY) * 0.5;
          if (gsMap.pinchPrevMid) {
            panByPixels(midX - gsMap.pinchPrevMid.x, midY - gsMap.pinchPrevMid.y);
          }
          if (gsMap.pinchPrevDist > 12 && dist > 12) {
            const zoomDelta = Math.log2(dist / gsMap.pinchPrevDist);
            zoomAroundClientPoint(gsMap.zoom + zoomDelta, midX, midY);
          }
          gsMap.pinchPrevDist = dist;
          gsMap.pinchPrevMid = { x: midX, y: midY };
          gsMap.dragMovedPx += 10;
        }
      },
      { passive: false }
    );

    const handleTouchEndOrCancel = (e) => {
      if (!e.touches || e.touches.length === 0) {
        gsMap.dragging = false;
        gsMap.pinchPrevDist = 0;
        gsMap.pinchPrevMid = null;
        gsMap.touchStartClusterBlob = null;
      } else if (e.touches.length === 1) {
        const t = e.touches[0];
        gsMap.dragging = true;
        gsMap.lastX = t.clientX;
        gsMap.lastY = t.clientY;
        gsMap.pinchPrevDist = 0;
        gsMap.pinchPrevMid = null;
      }
    };
    container.addEventListener("touchend", handleTouchEndOrCancel, { passive: false });
    container.addEventListener("touchcancel", handleTouchEndOrCancel, { passive: false });

    // Pointer Events for Mouse & Stylus only (touch is handled exclusively by Touch Events above)
    container.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return;
      if (isInteractiveMapHudControl(e.target)) return;
      gsMap.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!e.target.closest || !e.target.closest(".scan-cluster-blob")) {
        try {
          container.setPointerCapture(e.pointerId);
        } catch (_) {}
      }
      if (gsMap.activePointers.size === 1) {
        gsMap.dragging = true;
        gsMap.dragMovedPx = 0;
        gsMap.lastX = e.clientX;
        gsMap.lastY = e.clientY;
        canvas.style.cursor = "grabbing";
      } else if (gsMap.activePointers.size === 2) {
        const pts = Array.from(gsMap.activePointers.values());
        gsMap.dragging = false;
        gsMap.pinchPrevDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        gsMap.pinchPrevMid = { x: (pts[0].x + pts[1].x) * 0.5, y: (pts[0].y + pts[1].y) * 0.5 };
      }
    });

    const releasePointer = (e) => {
      if (e.pointerType === "touch") return;
      gsMap.activePointers.delete(e.pointerId);
      if (gsMap.activePointers.size === 0) {
        gsMap.dragging = false;
        gsMap.pinchPrevDist = 0;
        gsMap.pinchPrevMid = null;
        canvas.style.cursor = "grab";
      } else if (gsMap.activePointers.size === 1) {
        const remaining = Array.from(gsMap.activePointers.values())[0];
        gsMap.dragging = true;
        gsMap.lastX = remaining.x;
        gsMap.lastY = remaining.y;
        gsMap.pinchPrevDist = 0;
        gsMap.pinchPrevMid = null;
      }
    };
    window.addEventListener("pointerup", releasePointer);
    window.addEventListener("pointercancel", releasePointer);

    window.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return;
      if (!gsMap || STATE.activeView !== "map") return;
      updateCursorCoordsHud(e.clientX, e.clientY);
      if (gsMap.activePointers.has(e.pointerId)) {
        gsMap.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (gsMap.activePointers.size >= 2) {
        const pts = Array.from(gsMap.activePointers.values());
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        const midX = (pts[0].x + pts[1].x) * 0.5;
        const midY = (pts[0].y + pts[1].y) * 0.5;
        if (gsMap.pinchPrevMid) {
          panByPixels(midX - gsMap.pinchPrevMid.x, midY - gsMap.pinchPrevMid.y);
        }
        if (gsMap.pinchPrevDist > 12 && dist > 12) {
          zoomAroundClientPoint(gsMap.zoom + Math.log2(dist / gsMap.pinchPrevDist), midX, midY);
        }
        gsMap.pinchPrevDist = dist;
        gsMap.pinchPrevMid = { x: midX, y: midY };
        gsMap.dragMovedPx += 10;
        return;
      }
      if (gsMap.dragging) {
        const dx = e.clientX - gsMap.lastX;
        const dy = e.clientY - gsMap.lastY;
        gsMap.dragMovedPx += Math.hypot(dx, dy);
        gsMap.lastX = e.clientX;
        gsMap.lastY = e.clientY;
        panByPixels(dx, dy);
      }
    });

    container.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.35 : -0.35;
        zoomAroundClientPoint(gsMap.zoom + delta, e.clientX, e.clientY);
      },
      { passive: false }
    );
  }

  function renderMapClusters() {
    initMap();
    if (!gsMap) return;

    gsMap.markerLayer.innerHTML = "";
    const allGroups = getProjectGroupsList("");
    const visibleGroups = getProjectGroupsList(STATE.projectFilterQuery);
    gsMap.groups = visibleGroups;

    const countEl = document.getElementById("lblMapClusterCount");
    if (countEl) {
      if (STATE.projectFilterQuery) {
        countEl.textContent = `${visibleGroups.length}/${allGroups.length} Sites`;
      } else {
        countEl.textContent = `${allGroups.length} Site${allGroups.length === 1 ? "" : "s"} (${STATE.scans.length} Scans)`;
      }
    }

    populateProjectScanDropdowns(STATE.activeProjectGroup, STATE.activeScanId);

    visibleGroups.forEach((grp) => {
      const count = grp.scans.length;
      const sizePx = count >= 2 ? 50 : 44;
      const blob = document.createElement("div");
      blob.className = "scan-cluster-blob" + (grp.project_group === STATE.activeProjectGroup ? " active-cluster" : "");
      blob.dataset.projectGroup = grp.project_group;
      blob.style.position = "absolute";
      blob.style.width = `${sizePx}px`;
      blob.style.height = `${sizePx}px`;
      blob.style.transform = "translate(-50%, -50%)";
      blob.style.pointerEvents = "auto";
      blob.style.touchAction = "none";
      blob.innerHTML = `
        <span>${count}</span>
        <div class="blob-label">${grp.project_group} (${count})</div>
      `;

      blob.addEventListener("click", (e) => {
        if (gsMap && gsMap.dragMovedPx > 8) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        gsMap.centerLat = grp.lat;
        gsMap.centerLon = grp.lon;
        gsMap.zoom = Math.max(gsMap.zoom || 12, 13.8);
        openClusterPopover(grp);
        gsMap.drawMap();
      });

      grp.el = blob;
      gsMap.markerLayer.appendChild(blob);
    });

    gsMap.drawMap();
    if (visibleGroups.length > 0) {
      const activeGrp =
        visibleGroups.find((g) => g.project_group === STATE.activeProjectGroup) || visibleGroups[0];
      openClusterPopover(activeGrp);
    }
  }

  function formatCoveredAreaM2(scan) {
    if (!scan) return "0 m²";
    let area = Number(scan.covered_area_m2 || 0);
    if (!(area > 0)) {
      const he =
        scan.bounding_box && Array.isArray(scan.bounding_box.half_extents)
          ? scan.bounding_box.half_extents
          : [120, 120, 30];
      const hx = Math.max(Number(he[0] || 120), 10);
      const hy = Math.max(Number(he[1] || 120), 10);
      area = hx * 2 * (hy * 2) * 0.68;
    }
    return `${Math.round(area).toLocaleString("en-US")} m²`;
  }

  function openClusterPopover(grp) {
    const pop = document.getElementById("clusterHoverPopover");
    if (!pop || !grp) return;
    pop.classList.add("active");

    // Scope active project to the selected cluster so Studio & Compare only list this project's scans (Fix #4)
    STATE.activeProjectGroup = grp.project_group;
    document.querySelectorAll(".scan-cluster-blob").forEach((b) => {
      b.classList.toggle("active-cluster", b.dataset.projectGroup === grp.project_group);
    });
    const sortedScans = (grp.scans || [])
      .slice()
      .sort((a, b) => String(b.capture_date || "").localeCompare(String(a.capture_date || "")));

    if (sortedScans.length > 0) {
      const currInGroup = sortedScans.find((s) => s.scan_id === STATE.activeScanId);
      if (!currInGroup || (currInGroup.status !== "completed" && sortedScans.some((s) => s.status === "completed"))) {
        const bestScan = sortedScans.find((s) => s.status === "completed") || sortedScans[0];
        STATE.activeScanId = bestScan.scan_id;
        STATE.activeScan = bestScan;
      }
    }
    populateProjectScanDropdowns(grp.project_group, STATE.activeScanId);
    if (gsMap && gsMap.drawMap) gsMap.drawMap();

    document.getElementById("popoverGroupTitle").textContent = `${grp.project_group} (${grp.scans.length})`;
    document.getElementById("popoverGroupSubtitle").textContent =
      `${grp.project_name_zh || "工程掃描群組"} · TWD97 (121) + TWVD2001`;

    // Unified 3-Pane Workbench: keep Top-Right Timeline Cards + Bottom-Right 3D Preview synced when on Map view
    if (STATE.activeView === "map" || !document.getElementById("siteTimelineTilesTrack")?.children.length) {
      openSiteTimeline(
        grp.project_group,
        STATE.selectedTimelineScanId || STATE.activeScanId || (sortedScans[0] ? sortedScans[0].scan_id : null),
        false
      );
    }

    const btnOpenTimeline = document.getElementById("btnPopoverOpenTimeline");
    if (btnOpenTimeline) {
      btnOpenTimeline.onclick = () => {
        openSiteTimeline(grp.project_group, STATE.activeScanId || (sortedScans[0] ? sortedScans[0].scan_id : null), true);
      };
    }

    const btnCompare = document.getElementById("btnPopoverCompareGroup");
    if (btnCompare) {
      btnCompare.onclick = () => {
        const s1 = sortedScans[0];
        const s2 = sortedScans[1] || sortedScans[0];
        if (s1 && s2) launchMultiDateCompare(s2.scan_id, s1.scan_id);
      };
    }

    const btnShare = document.getElementById("btnPopoverShareGroup");
    if (btnShare) {
      btnShare.style.display = STATE.shareToken ? "none" : "inline-flex";
      btnShare.onclick = () => {
        openSharingModal("group", grp.project_group);
      };
    }

    const listEl = document.getElementById("popoverScanList");
    listEl.innerHTML = "";

    sortedScans.forEach((scan) => {
      const card = document.createElement("div");
      const isSelected = scan.scan_id === STATE.activeScanId;
      card.className = "gs-scan-item-card" + (isSelected ? " active" : "");
      card.dataset.scanId = scan.scan_id;
      card.style.cursor = "pointer";
      const isCached = STATE.cachedScanIds.has(scan.scan_id);
      const thumbSrc = scan.thumbnail_url || `/api/scans/${encodeURIComponent(scan.scan_id)}/thumbnail`;
      const texRes = Number(scan.texture_resolution || 4096);
      const texLabel = texRes >= 8192 ? "8K" : texRes >= 4096 ? "4K" : "2K";
      card.innerHTML = `
        <div class="gs-map-tile-thumb-wrap">
          <img class="gs-map-tile-thumb" data-scan-thumb="${scan.scan_id}" src="${thumbSrc}" alt="${scan.name}" />
          <div class="gs-tile-badge-row">
            <span class="gs-tile-chip">${scan.image_count || 0} imgs · ${texLabel}</span>
            <span class="gs-tile-chip">${formatCoveredAreaM2(scan)}</span>
          </div>
        </div>
        <div class="gs-map-tile-body">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
            <div style="min-width:0;flex:1;">
              <div style="font-size:12.5px;font-weight:700;color:var(--ui-text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${scan.name}">${scan.name}</div>
              <div style="font-size:11px;color:var(--ui-text-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${scan.capture_date} · ${scan.uploader_name} (<span style="color:var(--ui-accent);">${scan.uploader_email}</span>)
              </div>
            </div>
          </div>
          <div style="font-size:10.5px;font-family:monospace;color:var(--ui-text-muted);margin-top:5px;">
            E:${Number(scan.twd97_e).toFixed(1)}m N:${Number(scan.twd97_n).toFixed(1)}m H:+${Number(scan.twd97_h).toFixed(2)}m${isCached ? " · Cached" : ""}
          </div>
          <div class="gs-scan-item-actions">
            <button type="button" class="btn-xs primary" data-action="open3d" title="Enlarge Full-Quality 3D Scan in Studio">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 3 21 3 21 9"/>
                <polyline points="9 21 3 21 3 15"/>
                <line x1="21" y1="3" x2="14" y2="10"/>
                <line x1="3" y1="21" x2="10" y2="14"/>
              </svg>
            </button>
            <button type="button" class="btn-xs" data-action="compare" title="Compare Dates in Split Slider">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
                <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/>
              </svg>
            </button>
            <a class="btn-xs" href="${scan.download_obj_url}" download title="Download .OBJ Mesh">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
            </a>
            <button type="button" class="btn-xs" data-action="comments" title="Comments (${scan.comment_count || 0})">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </button>
            ${
              !STATE.shareToken
                ? `<button type="button" class="btn-xs" data-action="share" title="Create Scoped Share Link">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
                      <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                    </svg>
                  </button>
                  <button type="button" class="btn-xs" data-action="rename" title="Edit Scan Name">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
                      <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                    </svg>
                  </button>`
                : ""
            }
          </div>
        </div>
      `;

      card.addEventListener("click", (ev) => {
        if (ev.target.closest("button") || ev.target.closest("a")) return;
        STATE.activeProjectGroup = scan.project_group;
        STATE.activeScanId = scan.scan_id;
        STATE.activeScan = scan;
        STATE.selectedTimelineScanId = scan.scan_id;
        document.querySelectorAll("#popoverScanList .gs-scan-item-card").forEach((c) => {
          c.classList.toggle("active", c.dataset.scanId === scan.scan_id);
        });
        openSiteTimeline(scan.project_group, scan.scan_id);
      });

      card.querySelector('[data-action="open3d"]').addEventListener("click", () => {
        STATE.activeProjectGroup = scan.project_group;
        populateProjectScanDropdowns(scan.project_group, scan.scan_id);
        switchView("studio", scan.scan_id);
      });
      card.querySelector('[data-action="compare"]').addEventListener("click", () => {
        STATE.activeProjectGroup = scan.project_group;
        const other = grp.scans.find((s) => s.scan_id !== scan.scan_id) || scan;
        launchMultiDateCompare(other.scan_id, scan.scan_id);
      });
      card.querySelector('[data-action="comments"]').addEventListener("click", () => {
        STATE.activeProjectGroup = scan.project_group;
        populateProjectScanDropdowns(scan.project_group, scan.scan_id);
        switchView("studio", scan.scan_id);
        setTimeout(() => openCommentsInspector(), 250);
      });
      const shareBtn = card.querySelector('[data-action="share"]');
      if (shareBtn) {
        shareBtn.addEventListener("click", () => openSharingModal("scan", scan.scan_id));
      }
      const renameBtn = card.querySelector('[data-action="rename"]');
      if (renameBtn) {
        renameBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openRenameScanModal(scan.scan_id);
        });
      }

      listEl.appendChild(card);
    });
  }

  // ============================================================================
  // 1B. SITE TIMELINE (TOP) + INTERACTIVE 3D PREVIEW (BOTTOM) + ENLARGE
  // ============================================================================
  let previewThree = null;

  function getActivePreviewContainer() {
    return document.getElementById("sitePreviewCanvasContainer");
  }

  function syncPreviewRendererContainer() {
    if (!previewThree) return;
    const targetContainer = getActivePreviewContainer();
    if (!targetContainer) return;
    if (previewThree.renderer.domElement.parentElement !== targetContainer) {
      targetContainer.appendChild(previewThree.renderer.domElement);
      previewThree.container = targetContainer;
    }
    const w = Math.max(1, targetContainer.clientWidth);
    const h = Math.max(1, targetContainer.clientHeight);
    previewThree.camera.aspect = w / h;
    previewThree.camera.updateProjectionMatrix();
    previewThree.renderer.setSize(w, h);
    if (previewThree.tilesRenderer) {
      previewThree.tilesRenderer.setResolutionFromRenderer(previewThree.camera, previewThree.renderer);
    }
  }

  function initPreview3D() {
    if (previewThree) {
      syncPreviewRendererContainer();
      return previewThree;
    }
    const container = getActivePreviewContainer();
    if (!container) return null;

    const isDark = STATE.resolvedTheme === "dark";
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(isDark ? 0x0b1120 : 0xe2e8f0);

    const camera = new THREE.PerspectiveCamera(
      50,
      Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
      0.1,
      10000
    );
    camera.position.set(42, 34, 48);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1.0;
    container.appendChild(renderer.domElement);

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.screenSpacePanning = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.92));
    scene.add(new THREE.HemisphereLight(0xffffff, 0x475569, 0.45));
    const dir = new THREE.DirectionalLight(0xffffff, 0.65);
    dir.position.set(110, 200, 110);
    scene.add(dir);

    const grid = new THREE.GridHelper(220, 22, isDark ? 0x334155 : 0x94a3b8, isDark ? 0x1e293b : 0xcbd5e1);
    grid.position.y = -0.2;
    scene.add(grid);

    const modelPivot = new THREE.Group();
    scene.add(modelPivot);

    const fallbackGroup = new THREE.Group();
    scene.add(fallbackGroup);

    previewThree = {
      container,
      scene,
      camera,
      renderer,
      controls,
      grid,
      modelPivot,
      fallbackGroup,
      tilesRenderer: null,
      boundingSphere: null,
    };

    buildReferenceTerrainMesh(previewThree);

    const animatePreview = () => {
      requestAnimationFrame(animatePreview);
      if (STATE.activeView !== "map") return;
      controls.update();
      if (previewThree.tilesRenderer) {
        camera.updateMatrixWorld();
        previewThree.tilesRenderer.update();
        syncTilesLoaderProgress(previewThree, "preview");
        previewThree.tilesRenderer.group.traverse((child) => {
          if (child.isMesh && child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((m) => {
              if (m && m.metalness > 0) {
                m.metalness = 0.0;
                m.roughness = 1.0;
                m.side = THREE.DoubleSide;
                m.needsUpdate = true;
              }
              if (m && m.userData?._lastBrightness !== STATE.scanBrightness) {
                applyBrightnessToMaterial(m, STATE.scanBrightness);
              }
            });
          }
        });
      }
      renderer.render(scene, camera);
    };
    requestAnimationFrame(animatePreview);

    return previewThree;
  }

  // Circular 3D Scan Loading Indicator (Fill/Void Ring + Centered Percentage)
  const LOADER_RING_CIRCUMFERENCE = 238.761; // 2 * Math.PI * 38

  function updateScanLoader(prefix, visible, pct, labelText) {
    const overlayEl = document.getElementById(`${prefix}ScanLoader`);
    if (!overlayEl) return;
    const arcEl = document.getElementById(`${prefix}ScanLoaderArc`);
    const pctEl = document.getElementById(`${prefix}ScanLoaderPct`);
    const lblEl = document.getElementById(`${prefix}ScanLoaderLabel`);

    const clamped = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    if (arcEl) {
      const offset = LOADER_RING_CIRCUMFERENCE * (1 - clamped / 100);
      arcEl.style.strokeDashoffset = offset.toFixed(2);
    }
    if (pctEl) {
      pctEl.textContent = `${clamped}%`;
    }
    if (lblEl && typeof labelText === "string" && labelText) {
      lblEl.textContent = labelText;
    }
    overlayEl.classList.toggle("active", Boolean(visible));
  }

  function startScanLoader(ctx, prefix, scanName, scanId = null) {
    if (ctx) {
      if (ctx._loaderHideTimer) {
        clearTimeout(ctx._loaderHideTimer);
        ctx._loaderHideTimer = null;
      }
      ctx._loadingDone = false;
      ctx._tilesetReady = false;
      ctx._tilesetReadyMs = 0;
      ctx._loadingStartMs = performance.now();
      ctx._maxPct = 6;
      if (scanId) ctx._loadingScanId = scanId;
    }
    updateScanLoader(prefix, true, 6, `Loading ${scanName || "3D Scan"}...`);
  }

  function finishScanLoader(ctx, prefix, labelText = "Scan Ready") {
    if (ctx) {
      ctx._loadingDone = true;
      ctx._maxPct = 100;
      if (ctx._loaderHideTimer) clearTimeout(ctx._loaderHideTimer);
      updateScanLoader(prefix, true, 100, labelText);
      ctx._loaderHideTimer = setTimeout(() => {
        updateScanLoader(prefix, false, 100, labelText);
        if (prefix === "preview") {
          autoCaptureSiteTimelineScreenshots();
        }
      }, 320);
    } else {
      updateScanLoader(prefix, false, 100, labelText);
    }
  }

  function syncTilesLoaderProgress(ctx, prefix) {
    if (!ctx || !ctx.tilesRenderer || ctx._loadingDone) return;
    const stats = ctx.tilesRenderer.stats || {};
    const loaded = Number(stats.loaded || 0);
    const downloading = Number(stats.downloading || 0);
    const parsing = Number(stats.parsing || 0);
    const queued = Number(stats.queued || 0);
    const failed = Number(stats.failed || 0);
    const activeWork = downloading + parsing;
    const pending = activeWork + queued;
    const now = performance.now();
    const elapsed = now - (ctx._loadingStartMs || 0);
    const sinceTileset = ctx._tilesetReadyMs ? now - ctx._tilesetReadyMs : 0;

    // Complete as soon as primary 3D tiles are rendered or all active downloads/parses finish
    const total = Math.max(1, loaded + pending);
    const enoughTilesReady =
      loaded > 0 &&
      (pending === 0 ||
        (activeWork === 0 && sinceTileset > 900) ||
        loaded >= Math.max(4, Math.ceil(total * 0.75)));
    if (enoughTilesReady && elapsed > 220) {
      finishScanLoader(ctx, prefix, `100% · ${loaded} 3D tiles ready`);
      return;
    }

    // If a transient tunnel/network hiccup caused initial tiles to fail with 0 loaded, auto-retry once
    if (loaded === 0 && activeWork === 0 && failed > 0 && sinceTileset > 1200) {
      if (!ctx._retriedOnce && ctx._loadingScanId && prefix === "preview") {
        ctx._retriedOnce = true;
        loadScanIntoPreview(ctx._loadingScanId, true);
        return;
      }
      if (sinceTileset > 8000) {
        finishScanLoader(ctx, prefix, "Scan Ready");
        return;
      }
    }

    if (loaded > 0 || activeWork > 0 || queued > 0) {
      const timeBoost = activeWork > 0 ? Math.min(26, Math.floor(elapsed / 220)) : 0;
      const rawPct = Math.round(20 + (loaded / total) * 76) + timeBoost;
      ctx._maxPct = Math.min(96, Math.max(ctx._maxPct || 22, rawPct));
      updateScanLoader(prefix, true, ctx._maxPct, `Streaming 3D Scan · ${loaded} / ${total} tiles`);
      return;
    }

    if (!ctx._tilesetReady) {
      const waitPct = Math.min(20, 6 + Math.floor(elapsed / 120));
      ctx._maxPct = Math.max(ctx._maxPct || 6, waitPct);
      updateScanLoader(prefix, true, ctx._maxPct, "Fetching 3D tileset...");
    } else if (sinceTileset < 2500) {
      // Tileset just arrived; waiting for first frame traversal to schedule .glb downloads
      ctx._maxPct = Math.max(ctx._maxPct || 22, 22);
      updateScanLoader(prefix, true, ctx._maxPct, "Streaming 3D tiles...");
    } else if (sinceTileset > 12000) {
      finishScanLoader(ctx, prefix, "Scan Ready");
    }
  }

  function framePreviewCamera() {
    if (!previewThree) return;
    const rawR = Number(previewThree.boundingSphere?.radius) || 55;
    const r = Math.max(22, Math.min(240, rawR));
    previewThree.controls.target.set(0, 0, 0);
    previewThree.camera.position.set(r * 0.68, r * 0.54, r * 0.78);
    previewThree.camera.lookAt(0, 0, 0);
    previewThree.controls.update();
  }

  // Manually capture WebGL 3D scan screenshot and persist to tile & server when requested by user
  async function captureAndPersistScanScreenshot(scanId, ctxThree, showManualToast = false) {
    const targetCtx = ctxThree || previewThree || studioThree;
    if (!targetCtx || !targetCtx.renderer || !scanId) return;
    const loadedTiles = Number(targetCtx.tilesRenderer?.stats?.loaded || 0);
    if (targetCtx.tilesRenderer && loadedTiles === 0) return;
    try {
      targetCtx.renderer.render(targetCtx.scene, targetCtx.camera);
      const dataUrl = targetCtx.renderer.domElement.toDataURL("image/png");
      if (!dataUrl || dataUrl.length < 1024) return;

      const imgEls = document.querySelectorAll(`img[data-scan-thumb="${scanId}"]`);
      imgEls.forEach((img) => {
        img.src = dataUrl;
      });
      if (showManualToast) {
        STATE.capturedThumbs.add(scanId);
        await apiPost(`/api/scans/${encodeURIComponent(scanId)}/thumbnail`, {
          data_url: dataUrl,
        }).catch(() => {});
        showToast("Captured live 3D scan screenshot to timeline tile");
      }
    } catch (e) {
      console.warn("[GatheringScans] Screenshot capture note:", e);
    }
  }

  async function autoCaptureSiteTimelineScreenshots() {
    // Full-quality zoomed-to-extents screenshots are automatically generated on the server
    // from the high-resolution 3D tileset whenever a scan is uploaded or discovered.
    return;
  }

  function computeTilesetContentSphere(tr, outSphere) {
    if (!tr || !tr.root) return false;
    if (typeof tr.getBoundingSphere === "function") {
      tr.getBoundingSphere(outSphere);
    }
    const rootGe = Number(tr.root.geometricError || 0);
    if (rootGe > 1000) {
      tr.errorTarget = 16.0;
    } else if (tr.root.content && tr.root.content.uri) {
      tr.errorTarget = 380.0;
    }
    // If root has no direct content URI (e.g. PIX4Dmatic cubic octree where root box is in the sky),
    // check first if root.boundingVolume.box is already tightened (hx != hz). Otherwise walk content nodes up to depth 6.
    const rootBox = tr.root.boundingVolume && Array.isArray(tr.root.boundingVolume.box) ? tr.root.boundingVolume.box : null;
    const isTightRootBox = rootBox && rootBox.length >= 12 && Math.abs(Math.abs(Number(rootBox[3])) - Math.abs(Number(rootBox[11]))) > 0.5;
    if ((!tr.root.content || !tr.root.content.uri) && !isTightRootBox) {
      const rootMat = (tr.root.engineData && tr.root.engineData.transform) || new THREE.Matrix4();
      const byDepth = new Map();
      const tmpVec = new THREE.Vector3();
      const walk = (node, depth) => {
        if (!node || depth > 6) return;
        if (node.content && node.content.uri && node.boundingVolume && Array.isArray(node.boundingVolume.box)) {
          const b = node.boundingVolume.box;
          const cx = Number(b[0]) || 0;
          const cy = Number(b[1]) || 0;
          const cz = Number(b[2]) || 0;
          const hx = Math.abs(Number(b[3]) || 0) + Math.abs(Number(b[6]) || 0) + Math.abs(Number(b[9]) || 0);
          const hy = Math.abs(Number(b[4]) || 0) + Math.abs(Number(b[7]) || 0) + Math.abs(Number(b[10]) || 0);
          const hz = Math.abs(Number(b[5]) || 0) + Math.abs(Number(b[8]) || 0) + Math.abs(Number(b[11]) || 0);
          tmpVec.set(cx, cy, cz).applyMatrix4(rootMat);
          if (isFinite(tmpVec.x) && isFinite(tmpVec.y) && isFinite(tmpVec.z)) {
            if (!byDepth.has(depth)) byDepth.set(depth, []);
            byDepth.get(depth).push({
              x: tmpVec.x,
              y: tmpVec.y,
              z: tmpVec.z,
              hx,
              hy,
              hz,
            });
          }
        }
        if (Array.isArray(node.children)) {
          node.children.forEach((c) => walk(c, depth + 1));
        }
      };
      walk(tr.root, 0);
      if (byDepth.size > 0) {
        const maxDepth = Math.max(...byDepth.keys());
        const pts = byDepth.get(maxDepth) || [];
        let minX = Infinity,
          minY = Infinity,
          minZ = Infinity,
          maxX = -Infinity,
          maxY = -Infinity,
          maxZ = -Infinity;
        const zVals = [];
        for (const p of pts) {
          minX = Math.min(minX, p.x - p.hx * 0.6);
          maxX = Math.max(maxX, p.x + p.hx * 0.6);
          minY = Math.min(minY, p.y - p.hy * 0.6);
          maxY = Math.max(maxY, p.y + p.hy * 0.6);
          minZ = Math.min(minZ, p.z - p.hz * 0.6);
          maxZ = Math.max(maxZ, p.z + p.hz * 0.6);
          zVals.push(p.z);
        }
        zVals.sort((a, b) => a - b);
        const medZ = zVals.length > 0 ? zVals[Math.floor(zVals.length / 2)] : (minZ + maxZ) * 0.5;
        outSphere.center.set((minX + maxX) * 0.5, (minY + maxY) * 0.5, medZ);
        const dx = maxX - minX;
        const dy = maxY - minY;
        const dz = maxZ - minZ;
        outSphere.radius = Math.max(18, Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.42);
        outSphere._groundOffsetY = Math.min(-1.5, minZ - medZ - 0.3);
      }
    } else if (outSphere.radius > 0) {
      outSphere.radius = Math.max(18, outSphere.radius * 0.72);
      if (rootBox && rootBox.length >= 12) {
        const hz =
          Math.abs(Number(rootBox[5]) || 0) +
          Math.abs(Number(rootBox[8]) || 0) +
          Math.abs(Number(rootBox[11]) || 0);
        outSphere._groundOffsetY = hz > 0 ? -(hz + 0.3) : -Math.max(4.0, outSphere.radius * 0.25);
      } else {
        outSphere._groundOffsetY = -Math.max(4.0, outSphere.radius * 0.25);
      }
    }
    return outSphere.radius > 0;
  }

  function loadScanIntoPreview(scanId, forceReload = false) {
    initPreview3D();
    syncPreviewRendererContainer();
    const scan = STATE.scans.find((s) => s.scan_id === scanId) || STATE.scans[0];
    if (!scan || !previewThree) return;

    const titleEl = document.getElementById("previewScanTitle");
    if (titleEl) titleEl.textContent = scan.name;
    const metaEl = document.getElementById("previewScanMeta");
    if (metaEl) {
      metaEl.textContent = `${scan.capture_date} · ${scan.uploader_name} · ${formatCoveredAreaM2(scan)} · E ${Number(scan.twd97_e).toFixed(1)} N ${Number(scan.twd97_n).toFixed(1)} H +${Number(scan.twd97_h).toFixed(2)}m`;
    }

    if (
      !forceReload &&
      previewThree._loadingScanId === scan.scan_id &&
      previewThree.tilesRenderer &&
      Number(previewThree.tilesRenderer.stats?.failed || 0) === 0
    ) {
      STATE.selectedTimelineScanId = scan.scan_id;
      STATE.activeScanId = scan.scan_id;
      STATE.activeScan = scan;
      return;
    }

    STATE.selectedTimelineScanId = scan.scan_id;
    STATE.activeScanId = scan.scan_id;
    STATE.activeScan = scan;

    if (previewThree.tilesRenderer) {
      previewThree.modelPivot.remove(previewThree.tilesRenderer.group);
      previewThree.tilesRenderer.dispose();
      previewThree.tilesRenderer = null;
    }
    while (previewThree.modelPivot.children.length > 0) {
      previewThree.modelPivot.remove(previewThree.modelPivot.children[0]);
    }
    previewThree.modelPivot.rotation.set(0, 0, 0);
    if (previewThree.fallbackGroup) previewThree.fallbackGroup.visible = false;

    previewThree._retriedOnce = false;
    if (scan.status && scan.status !== "completed") {
      if (previewThree.fallbackGroup) previewThree.fallbackGroup.visible = true;
      framePreviewCamera();
      finishScanLoader(
        previewThree,
        "preview",
        `Processing in PIX4Dmatic (${Math.round(Number(scan.progress_pct) || 0)}%)`
      );
      return;
    }
    startScanLoader(previewThree, "preview", `${scan.name} (Interactive Preview)`, scan.scan_id);

    const streamUrl =
      scan.preview_stream_url ||
      (scan.stream_url
        ? scan.stream_url.replace("/tileset.json", "/preview_tileset.json")
        : `/stream/${scan.scan_id}/preview_tileset.json`);
    const streamType = scan.preview_stream_type || scan.stream_type;

    if (streamType === "glb" || streamUrl.toLowerCase().endsWith(".glb")) {
      const loader = new THREE.GLTFLoader();
      if (window.MeshoptDecoder) loader.setMeshoptDecoder(window.MeshoptDecoder);
      const ktx2 = getKTX2Loader(previewThree.renderer);
      if (ktx2) loader.setKTX2Loader(ktx2);

      loader.load(
        streamUrl,
        (gltf) => {
          const model = gltf.scene;
          const box = new THREE.Box3().setFromObject(model);
          const sphere = new THREE.Sphere();
          box.getBoundingSphere(sphere);
          if (sphere.radius > 0) {
            model.position.set(-sphere.center.x, -sphere.center.y, -sphere.center.z);
          }
          if (previewThree.grid) {
            previewThree.grid.position.y = Number.isFinite(box.min.y)
              ? box.min.y - sphere.center.y - 0.3
              : -0.2;
          }
          model.traverse((c) => {
            if (c.isMesh && c.material) {
              const mats = Array.isArray(c.material) ? c.material : [c.material];
              mats.forEach((m) => applyBrightnessToMaterial(m, STATE.scanBrightness));
            }
          });
          previewThree.modelPivot.add(model);
          previewThree.boundingSphere = sphere;
          framePreviewCamera();
          finishScanLoader(previewThree, "preview", "100% · Interactive Preview Ready");
        },
        (xhr) => {
          const pct =
            xhr && xhr.total > 0
              ? Math.min(95, Math.max(12, Math.round((xhr.loaded / xhr.total) * 100)))
              : Math.min(88, (previewThree._maxPct || 12) + 8);
          previewThree._maxPct = pct;
          updateScanLoader("preview", true, pct, `Loading Interactive Preview (${pct}%)...`);
        },
        () => {
          if (previewThree.fallbackGroup) previewThree.fallbackGroup.visible = true;
          finishScanLoader(previewThree, "preview", "Ready");
        }
      );
    } else if (window.TilesRenderer) {
      const tr = new window.TilesRenderer(streamUrl);
      tr.fetchOptions = { mode: "cors" };
      tr.preprocessURL = (uri) => {
        let u = uri;
        if (STATE.shareToken && !u.includes("share=")) {
          u += (u.includes("?") ? "&" : "?") + `share=${encodeURIComponent(STATE.shareToken)}`;
        }
        return u;
      };
      tr.setCamera(previewThree.camera);
      tr.setResolutionFromRenderer(previewThree.camera, previewThree.renderer);

      const gltfLoader = new THREE.GLTFLoader(tr.manager);
      if (window.MeshoptDecoder) gltfLoader.setMeshoptDecoder(window.MeshoptDecoder);
      const ktx2 = getKTX2Loader(previewThree.renderer);
      if (ktx2) gltfLoader.setKTX2Loader(ktx2);
      tr.manager.addHandler(/\.(gltf|glb)(\?.*)?$/i, gltfLoader);

      tr.addEventListener("load-tileset", () => {
        previewThree._tilesetReady = true;
        previewThree._tilesetReadyMs = performance.now();
        previewThree._maxPct = Math.max(previewThree._maxPct || 0, 22);
        updateScanLoader("preview", true, previewThree._maxPct, "Streaming interactive preview...");
        const sphere = new THREE.Sphere();
        if (computeTilesetContentSphere(tr, sphere)) {
          tr.group.position.set(-sphere.center.x, -sphere.center.y, -sphere.center.z);
          previewThree.modelPivot.rotation.set(THREE.MathUtils.degToRad(270), 0, 0);
          previewThree.modelPivot.updateMatrixWorld(true);
          previewThree.boundingSphere = sphere;
          if (previewThree.grid) {
            previewThree.grid.position.y = Number.isFinite(sphere._groundOffsetY)
              ? sphere._groundOffsetY
              : -8.0;
          }
          framePreviewCamera();
        }
        previewThree.camera.updateMatrixWorld();
        tr.update();
      });

      tr.addEventListener("load-model", (ev) => {
        if (ev && ev.scene) {
          if (previewThree.fallbackGroup) previewThree.fallbackGroup.visible = false;
          ev.scene.traverse((c) => {
            if (c.isMesh && c.material) {
              const mats = Array.isArray(c.material) ? c.material : [c.material];
              mats.forEach((m) => applyBrightnessToMaterial(m, STATE.scanBrightness));
            }
          });
          previewThree.camera.updateMatrixWorld();
          tr.update();
          previewThree.renderer.render(previewThree.scene, previewThree.camera);
          syncTilesLoaderProgress(previewThree, "preview");
        }
      });

      tr.errorTarget = 16.0;
      if (tr.downloadQueue) tr.downloadQueue.maxJobs = 12;
      if (tr.parseQueue) tr.parseQueue.maxJobs = 6;
      previewThree.modelPivot.add(tr.group);
      previewThree.tilesRenderer = tr;
      framePreviewCamera();
      previewThree.camera.updateMatrixWorld();
      tr.update();
      return;
    }

    framePreviewCamera();
  }

  function selectTimelineTile(scanId) {
    if (STATE._timelineInitTimer) {
      clearTimeout(STATE._timelineInitTimer);
      STATE._timelineInitTimer = null;
    }
    STATE.selectedTimelineScanId = scanId;
    document.querySelectorAll("#siteTimelineTilesTrack .gs-timeline-tile").forEach((tile) => {
      const isAct = tile.dataset.scanId === scanId;
      tile.classList.toggle("active", isAct);
      const rtkChip = tile.querySelector("[data-rtk-chip]");
      if (rtkChip) rtkChip.classList.toggle("active-indicator", isAct);
    });
    document.querySelectorAll("#popoverScanList .gs-scan-item-card").forEach((c) => {
      c.classList.toggle("active", c.dataset.scanId === scanId);
    });
    loadScanIntoPreview(scanId);
  }

  function openSiteTimeline(projectGroup, preferredScanId = null, forceSwitchToMap = false) {
    const splitEl = document.getElementById("siteTimelineSplitView");
    if (!splitEl) return;

    if (STATE._timelineInitTimer) {
      clearTimeout(STATE._timelineInitTimer);
      STATE._timelineInitTimer = null;
    }

    const allGroups = getProjectGroupsList("");
    const grpName =
      projectGroup ||
      STATE.activeProjectGroup ||
      (allGroups[0] ? allGroups[0].project_group : "Project Site");
    STATE.activeProjectGroup = grpName;
    STATE.siteTimelineOpen = true;

    // Only switch back to Map view if explicitly requested by user navigation
    if (forceSwitchToMap && STATE.activeView !== "map") {
      switchView("map");
    }
    splitEl.classList.add("active");
    document.querySelectorAll(".scan-cluster-blob").forEach((b) => {
      b.classList.toggle("active-cluster", b.dataset.projectGroup === grpName);
    });
    if (STATE.activeView === "map") {
      syncPreviewRendererContainer();
      if (gsMap && gsMap.drawMap) gsMap.drawMap();
    }

    let siteScans = STATE.scans
      .filter((s) => s.project_group === grpName)
      .slice()
      .sort((a, b) => String(b.capture_date || "").localeCompare(String(a.capture_date || "")));
    if (!siteScans.length) {
      siteScans = STATE.scans.slice();
    }

    const chosenScan =
      (preferredScanId && siteScans.find((s) => s.scan_id === preferredScanId)) ||
      siteScans.find((s) => s.scan_id === STATE.activeScanId) ||
      siteScans[0];

    populateProjectScanDropdowns(grpName, chosenScan ? chosenScan.scan_id : null);

    // Populate Header
    const titleEl = document.getElementById("timelineSiteTitle");
    if (titleEl) titleEl.textContent = grpName;
    const countEl = document.getElementById("timelineSiteCountPill");
    if (countEl) countEl.textContent = `${siteScans.length} Scan${siteScans.length === 1 ? "" : "s"}`;
    const subEl = document.getElementById("timelineSiteSubtitle");
    if (subEl && siteScans[0]) {
      subEl.textContent = `${siteScans[0].project_name_zh || "工程掃描群組"} · Select a scan tile on the timeline to preview below`;
    }
    const timelineProjSel = document.getElementById("timelineProjectSelect");
    if (timelineProjSel) {
      timelineProjSel.value = grpName;
    }
    const mapProjSel = document.getElementById("mapProjectSelect");
    if (mapProjSel && Array.from(mapProjSel.options).some((o) => o.value === grpName)) {
      mapProjSel.value = grpName;
    }

    // Populate Horizontal Timeline Tiles Track
    const trackEl = document.getElementById("siteTimelineTilesTrack");
    if (trackEl) {
      trackEl.innerHTML = "";
      siteScans.forEach((s) => {
        const isSelected = chosenScan && s.scan_id === chosenScan.scan_id;
        const tile = document.createElement("div");
        tile.className = "gs-timeline-tile" + (isSelected ? " active" : "");
        tile.dataset.scanId = s.scan_id;
        const thumbSrc = s.thumbnail_url || `/api/scans/${encodeURIComponent(s.scan_id)}/thumbnail`;
        const texRes = Number(s.texture_resolution || 4096);
        const texLabel = texRes >= 8192 ? "8K" : texRes >= 4096 ? "4K" : "2K";

        tile.innerHTML = `
          <div class="gs-tile-thumb-wrap">
            <img class="gs-tile-thumb" data-scan-thumb="${s.scan_id}" src="${thumbSrc}" alt="${s.name}" />
            <div class="gs-tile-badge-row">
              <span class="gs-tile-chip">${s.image_count || 0} imgs · ${texLabel}</span>
              <span class="gs-tile-chip ${isSelected ? "active-indicator" : ""}" data-rtk-chip="1">${formatCoveredAreaM2(s)}</span>
            </div>
          </div>
          <div class="gs-tile-meta">
            <div class="gs-tile-date-row">
              <span class="gs-tile-date">${s.capture_date}</span>
            </div>
            <div class="gs-tile-uploader" title="${s.uploader_name} (${s.uploader_email})">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
              </svg>
              <span>${s.uploader_name}</span>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;min-width:0;">
              <div class="gs-tile-name" title="${s.name}" style="flex:1;min-width:0;">${s.name}</div>
              ${
                !STATE.shareToken
                  ? `<button type="button" class="btn-xs" data-rename-tile="${s.scan_id}" title="Edit Scan Name" style="height:18px;padding:0 4px;flex-shrink:0;">
                      <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                      </svg>
                    </button>`
                  : ""
              }
            </div>
          </div>
        `;

        tile.addEventListener("click", (ev) => {
          if (ev.target.closest("[data-rename-tile]")) return;
          selectTimelineTile(s.scan_id);
        });
        const renTileBtn = tile.querySelector("[data-rename-tile]");
        if (renTileBtn) {
          renTileBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            openRenameScanModal(s.scan_id);
          });
        }
        trackEl.appendChild(tile);
      });
    }

    // Render 3D Scan Preview in Bottom 2/3 when on Map view
    if (chosenScan && STATE.activeView === "map") {
      STATE._timelineInitTimer = setTimeout(() => {
        STATE._timelineInitTimer = null;
        if (STATE.activeView === "map") {
          selectTimelineTile(chosenScan.scan_id);
        }
      }, 30);
    }
  }

  let _renamingScanId = "";

  function getScanDefaultFileName(scan) {
    if (!scan) return "";
    const p = String(scan.project_dir || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (p) {
      const base = p.split("/").pop();
      if (base) return base;
    }
    return scan.scan_id || "";
  }

  function openRenameScanModal(scanId) {
    const targetId = scanId || STATE.selectedTimelineScanId || STATE.activeScanId;
    const scan = STATE.scans.find((s) => s.scan_id === targetId) || STATE.activeScan;
    if (!scan) return;
    _renamingScanId = scan.scan_id;
    const fileBase = getScanDefaultFileName(scan);
    const folderInfo = document.getElementById("renameScanModalFolderInfo");
    if (folderInfo) {
      folderInfo.textContent = `File / Folder: ${fileBase} (${scan.project_group || "Site"})`;
    }
    const inp = document.getElementById("renameScanInput");
    if (inp) {
      inp.value = scan.name || fileBase;
    }
    openModal("renameScanModal");
    setTimeout(() => {
      if (inp) {
        inp.focus();
        inp.select();
      }
    }, 40);
  }

  async function saveRenamedScan() {
    const scan = STATE.scans.find((s) => s.scan_id === _renamingScanId);
    if (!scan) return;
    const inp = document.getElementById("renameScanInput");
    const newName = String(inp ? inp.value : "").trim();
    if (!newName) {
      showToast("Scan name cannot be empty");
      return;
    }
    try {
      const res = await apiPost("/api/scans/rename", {
        scan_id: scan.scan_id,
        name: newName,
      });
      const savedName = (res.scan && res.scan.name) || newName;
      scan.name = savedName;
      scan.user_edited_name = true;
      try {
        localStorage.setItem(
          "gs_last_catalog_v1",
          JSON.stringify({ scans: STATE.scans, projects: STATE.projects })
        );
      } catch (_) {}

      const prevTitle = document.getElementById("previewScanTitle");
      if (prevTitle && (STATE.selectedTimelineScanId === scan.scan_id || STATE.activeScanId === scan.scan_id)) {
        prevTitle.textContent = savedName;
      }
      const rightTitle = document.getElementById("rightPreviewScanTitle");
      if (rightTitle && (STATE.selectedTimelineScanId === scan.scan_id || STATE.activeScanId === scan.scan_id)) {
        rightTitle.textContent = `${savedName} (${scan.capture_date})`;
      }
      document.querySelectorAll(`#siteTimelineTilesTrack .gs-timeline-tile[data-scan-id="${scan.scan_id}"] .gs-tile-name`).forEach((el) => {
        el.textContent = savedName;
        el.title = savedName;
      });
      populateProjectScanDropdowns(STATE.activeProjectGroup, STATE.activeScanId);
      renderMapClusters();
      closeModal("renameScanModal");
      showToast(`Saved scan name: ${savedName}`);
    } catch (err) {
      showToast(`Failed to save scan name: ${err.message}`);
    }
  }

  document.getElementById("btnRenamePreviewScan")?.addEventListener("click", () => {
    openRenameScanModal(STATE.selectedTimelineScanId || STATE.activeScanId);
  });
  document.getElementById("previewScanTitle")?.addEventListener("dblclick", () => {
    if (!STATE.shareToken) openRenameScanModal(STATE.selectedTimelineScanId || STATE.activeScanId);
  });
  document.getElementById("btnRenameStudioScan")?.addEventListener("click", () => {
    openRenameScanModal(STATE.activeScanId);
  });
  document.getElementById("btnResetScanNameToFile")?.addEventListener("click", () => {
    const scan = STATE.scans.find((s) => s.scan_id === _renamingScanId);
    const inp = document.getElementById("renameScanInput");
    if (scan && inp) {
      inp.value = getScanDefaultFileName(scan);
      inp.focus();
    }
  });
  document.getElementById("btnConfirmSaveScanName")?.addEventListener("click", saveRenamedScan);
  document.getElementById("renameScanInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveRenamedScan();
    }
  });

  // ============================================================================
  // 1C. RENAME SITE (PROJECT GROUP) MODAL & RE-RUN SCAN FROM ORIGINAL PHOTOS MODAL
  // ============================================================================
  let _renamingSiteGroup = "";

  function openRenameSiteModal(projectGroup) {
    if (!getCurrentUserRoleInfo().canEditNames) {
      showToast("Only Editor, Admin, or Owner accounts can rename sites.");
      return;
    }
    const targetGroup =
      projectGroup ||
      STATE.activeProjectGroup ||
      (STATE.activeScan && STATE.activeScan.project_group) ||
      (STATE.scans[0] && STATE.scans[0].project_group) ||
      "";
    if (!targetGroup) return;
    _renamingSiteGroup = targetGroup;
    const siteScans = STATE.scans.filter((s) => s.project_group === targetGroup);
    const zhName = (siteScans[0] && siteScans[0].project_name_zh) || targetGroup;
    const subEl = document.getElementById("renameSiteModalSub");
    if (subEl) {
      subEl.textContent = `Current Site: ${targetGroup} (${siteScans.length} Scan${siteScans.length === 1 ? "" : "s"})`;
    }
    const grpInp = document.getElementById("renameSiteGroupInput");
    const zhInp = document.getElementById("renameSiteZhInput");
    if (grpInp) grpInp.value = targetGroup;
    if (zhInp) zhInp.value = zhName;
    openModal("renameSiteModal");
    setTimeout(() => {
      if (grpInp) {
        grpInp.focus();
        grpInp.select();
      }
    }, 40);
  }

  async function saveRenamedSite() {
    if (!_renamingSiteGroup) return;
    const grpInp = document.getElementById("renameSiteGroupInput");
    const zhInp = document.getElementById("renameSiteZhInput");
    const newGroup = String(grpInp ? grpInp.value : "").trim();
    const newZh = String(zhInp ? zhInp.value : "").trim() || newGroup;
    if (!newGroup) {
      showToast("Site name cannot be empty");
      return;
    }
    try {
      const res = await apiPost("/api/projects/rename", {
        old_project_group: _renamingSiteGroup,
        new_project_group: newGroup,
        new_project_name_zh: newZh,
      });
      if (Array.isArray(res.scans)) STATE.scans = res.scans;
      if (Array.isArray(res.projects)) STATE.projects = res.projects;
      STATE.activeProjectGroup = newGroup;
      if (STATE.activeScan) {
        STATE.activeScan = STATE.scans.find((s) => s.scan_id === STATE.activeScan.scan_id) || STATE.activeScan;
      }
      const tlTitle = document.getElementById("timelineSiteTitle");
      if (tlTitle) tlTitle.textContent = newGroup;
      const popTitle = document.getElementById("popoverGroupTitle");
      if (popTitle) popTitle.textContent = newGroup;
      populateProjectScanDropdowns(newGroup, STATE.activeScanId);
      renderMapClusters();
      if (STATE.siteTimelineOpen) {
        openSiteTimeline(newGroup, STATE.selectedTimelineScanId || STATE.activeScanId);
      }
      closeModal("renameSiteModal");
      showToast(`Renamed site "${_renamingSiteGroup}" → "${newGroup}" (${res.updated_count || 1} scans updated)`);
    } catch (err) {
      showToast(`Failed to rename site: ${err.message}`);
    }
  }

  ["btnRenameMapSite", "btnRenamePopoverSite", "btnRenameTimelineSite", "btnRenameStudioSite"].forEach((id) => {
    document.getElementById(id)?.addEventListener("click", () => {
      const mapSel = document.getElementById("mapProjectSelect")?.value;
      const grp =
        id === "btnRenameMapSite" && mapSel && mapSel !== "__all__"
          ? mapSel
          : STATE.activeProjectGroup;
      openRenameSiteModal(grp);
    });
  });
  document.getElementById("timelineSiteTitle")?.addEventListener("dblclick", () => {
    if (!STATE.shareToken) openRenameSiteModal(STATE.activeProjectGroup);
  });
  document.getElementById("popoverGroupTitle")?.addEventListener("dblclick", () => {
    if (!STATE.shareToken) openRenameSiteModal(STATE.activeProjectGroup);
  });
  document.getElementById("btnConfirmSaveSiteName")?.addEventListener("click", saveRenamedSite);
  document.getElementById("renameSiteGroupInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveRenamedSite();
    }
  });

  // Re-run Scan from Original Photos Modal
  let _rerunTargetScanId = "";

  function readRerunModalSettings() {
    return {
      mesh_pipeline: document.getElementById("rerunSelMeshPipeline")?.value || "FixedSize",
      mesh_quality: document.getElementById("rerunSelMeshQuality")?.value || "High",
      vertex_density: document.getElementById("rerunSelVertexDensity")?.value || "High",
      texture_size: Number(document.getElementById("rerunSelTextureSize")?.value || 4096),
      model_simplification: document.getElementById("rerunSelSimplification")?.value || "Conservative",
      deghosting: document.getElementById("rerunSelDeghosting")?.value || "Weak",
      export_lod: Number(document.getElementById("rerunInpExportLod")?.value || 13),
      skyless: Boolean(document.getElementById("rerunChkSkyless")?.checked),
      use_roi: Boolean(document.getElementById("rerunChkUseRoi")?.checked),
    };
  }

  async function updateRerunGstPreview() {
    if (!_rerunTargetScanId) return;
    try {
      const settings = readRerunModalSettings();
      const res = await apiPost("/api/queue/preview-gst", {
        scan_id: _rerunTargetScanId,
        settings,
      });
      const codeEl = document.getElementById("rerunGstPreviewCode");
      if (codeEl && res.gst_script) {
        codeEl.textContent = res.gst_script;
      }
    } catch (err) {
      const codeEl = document.getElementById("rerunGstPreviewCode");
      if (codeEl) codeEl.textContent = `// Preview error: ${err.message}`;
    }
  }

  function openRerunScanModal(scanId) {
    if (!getCurrentUserRoleInfo().canRunWorkflows) {
      showToast("Only Editor, Admin, or Owner accounts can run or re-run scans on the PC.");
      return;
    }
    const targetId = scanId || STATE.selectedTimelineScanId || STATE.activeScanId;
    const scan = STATE.scans.find((s) => s.scan_id === targetId) || STATE.activeScan;
    if (!scan) return;
    _rerunTargetScanId = scan.scan_id;
    const nameEl = document.getElementById("rerunScanInfoName");
    if (nameEl) nameEl.textContent = `${scan.name} (${scan.project_group})`;
    const srcEl = document.getElementById("rerunScanInfoSource");
    if (srcEl) {
      const pCount = scan.image_count || scan.total_photos || 100;
      const srcPath = scan.source_zip_path || `${scan.project_dir || "C:\\GatheringScans\\" + scan.scan_id}\\inputs`;
      srcEl.textContent = `Original Photos Source: ${srcPath} (${pCount} RTK photos)`;
    }
    openModal("rerunScanModal");
    updateRerunGstPreview();
  }

  async function confirmRerunScan() {
    if (!_rerunTargetScanId) return;
    const settings = readRerunModalSettings();
    const forceFromPhotos = Boolean(document.getElementById("rerunChkForceFromPhotos")?.checked);
    const runImmediately = Boolean(document.getElementById("rerunChkRunImmediately")?.checked);
    const msgEl = document.getElementById("rerunModalStatusMsg");
    if (msgEl) msgEl.textContent = "Submitting re-run job to PIX4Dmatic 2.11.0...";
    try {
      const res = await apiPost("/api/scans/rerun", {
        scan_id: _rerunTargetScanId,
        force_from_photos: forceFromPhotos,
        force_next: true,
        run_immediately: runImmediately,
        settings,
      });
      closeModal("rerunScanModal");
      showToast(
        runImmediately
          ? `Launched PIX4Dmatic re-run from original photos (${res.original_photos_count || 100} imgs, ${settings.mesh_quality}, ${settings.texture_size}px)`
          : `Queued ${res.scan?.name || _rerunTargetScanId} for re-run from original photos (${settings.mesh_quality}, ${settings.texture_size}px)`
      );
      await refreshScansCatalog();
    } catch (err) {
      if (msgEl) msgEl.textContent = `Error: ${err.message}`;
      showToast(`Re-run Error: ${err.message}`);
    }
  }

  document.getElementById("btnRerunPreviewScan")?.addEventListener("click", () => {
    openRerunScanModal(STATE.selectedTimelineScanId || STATE.activeScanId);
  });
  document.getElementById("btnRerunStudioScan")?.addEventListener("click", () => {
    openRerunScanModal(STATE.activeScanId);
  });
  document.getElementById("btnConfirmRerunScan")?.addEventListener("click", confirmRerunScan);
  [
    "rerunSelMeshPipeline",
    "rerunSelMeshQuality",
    "rerunSelVertexDensity",
    "rerunSelTextureSize",
    "rerunSelSimplification",
    "rerunSelDeghosting",
    "rerunInpExportLod",
    "rerunChkSkyless",
    "rerunChkUseRoi",
  ].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", updateRerunGstPreview);
  });
  window.openRerunScanModal = openRerunScanModal;
  window.openRenameSiteModal = openRenameSiteModal;

  function closeSiteTimeline() {
    STATE.siteTimelineOpen = true;
    document.getElementById("siteTimelineSplitView")?.classList.add("active");
    syncPreviewRendererContainer();
    if (gsMap && gsMap.drawMap) gsMap.drawMap();
  }

  document.getElementById("btnCloseSiteTimeline")?.addEventListener("click", closeSiteTimeline);

  document.getElementById("btnEnlargePreviewToStudio")?.addEventListener("click", () => {
    const targetScanId = STATE.selectedTimelineScanId || STATE.activeScanId;
    switchView("studio", targetScanId);
  });

  document.getElementById("btnEnlargeRightPreview")?.addEventListener("click", () => {
    const targetScanId = STATE.selectedTimelineScanId || STATE.activeScanId;
    switchView("studio", targetScanId);
  });

  document.getElementById("btnRightPreviewResetCamera")?.addEventListener("click", framePreviewCamera);

  document.getElementById("btnStudioBackToTimeline")?.addEventListener("click", () => {
    openSiteTimeline(STATE.activeProjectGroup, STATE.activeScanId, true);
  });

  document.getElementById("btnCapturePreviewScreenshot")?.addEventListener("click", () => {
    captureAndPersistScanScreenshot(STATE.selectedTimelineScanId || STATE.activeScanId, previewThree, true);
  });

  document.getElementById("btnPreviewResetCamera")?.addEventListener("click", framePreviewCamera);

  document.getElementById("previewBrightnessSlider")?.addEventListener("input", (e) => {
    const b = Math.max(0.1, Math.min(4.0, parseFloat(e.target.value) || 1.0));
    const lbl = document.getElementById("lblPreviewBrightness");
    if (lbl) lbl.textContent = `${b.toFixed(1)}x`;
    setStudioScanBrightness(b);
    if (previewThree) {
      [previewThree.modelPivot, previewThree.fallbackGroup].forEach((grp) => {
        if (!grp) return;
        grp.traverse((child) => {
          if (child.isMesh && child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((m) => applyBrightnessToMaterial(m, b));
          }
        });
      });
    }
  });

  document.getElementById("btnTimelineCompare")?.addEventListener("click", () => {
    const siteScans = STATE.scans.filter((s) => s.project_group === STATE.activeProjectGroup);
    const s1 = siteScans.find((s) => s.scan_id === STATE.selectedTimelineScanId) || siteScans[0] || STATE.scans[0];
    const s2 = siteScans.find((s) => s.scan_id !== s1.scan_id) || s1;
    if (s1 && s2) launchMultiDateCompare(s2.scan_id, s1.scan_id);
  });

  document.getElementById("btnTimelineShare")?.addEventListener("click", () => {
    openSharingModal("group", STATE.activeProjectGroup);
  });

  // ============================================================================
  // 2. 3D SCAN STUDIO (Three.js + 3D Tileset + TWD97/TWVD2001 + Civil Tools)
  // ============================================================================
  let studioThree = null;

  // Apply Scan Brightness (0.1x – 4.0x) and optional Z-Elevation Heatmap to any Three.js material
  function applyBrightnessToMaterial(mat, brightness) {
    if (!mat) return;
    const b = Math.max(0.1, Math.min(4.0, Number(brightness) || 1.0));
    if (!mat.userData) mat.userData = {};
    if (mat.map && mat.color) {
      mat.color.setRGB(1, 1, 1);
    }
    if (mat.color && !mat.userData._origColor) {
      mat.userData._origColor = mat.color.clone();
    }
    if (mat.color && mat.userData._origColor) {
      mat.color.copy(mat.userData._origColor);
    }

    const heatmapFlag = mat.userData._elevationHeatmapActive ? 1.0 : 0.0;
    const elevMin = Number.isFinite(mat.userData._elevMin) ? mat.userData._elevMin : -14.0;
    const elevMax = Number.isFinite(mat.userData._elevMax) ? mat.userData._elevMax : 24.0;

    if (!mat.userData.PassUniforms) {
      mat.userData.PassUniforms = {
        uBrightness: { value: b },
        uElevationHeatmap: { value: heatmapFlag },
        uElevMin: { value: elevMin },
        uElevMax: { value: elevMax },
      };
    } else {
      if (mat.userData.PassUniforms.uBrightness) mat.userData.PassUniforms.uBrightness.value = b;
      if (mat.userData.PassUniforms.uElevationHeatmap) mat.userData.PassUniforms.uElevationHeatmap.value = heatmapFlag;
      if (mat.userData.PassUniforms.uElevMin) mat.userData.PassUniforms.uElevMin.value = elevMin;
      if (mat.userData.PassUniforms.uElevMax) mat.userData.PassUniforms.uElevMax.value = elevMax;
    }

    if (!mat.userData._hasBrightnessShader) {
      mat.userData._hasBrightnessShader = true;
      mat.customProgramCacheKey = function () {
        return `GS_ScanShader_v3_${mat.type || "Standard"}_${mat.map ? "1" : "0"}_${mat.vertexColors ? "1" : "0"}`;
      };
      const prevOnBeforeCompile = mat.onBeforeCompile;
      mat.onBeforeCompile = function (shader, renderer) {
        if (typeof prevOnBeforeCompile === "function") {
          prevOnBeforeCompile.call(this, shader, renderer);
        }
        shader.uniforms.uBrightness = mat.userData.PassUniforms.uBrightness;
        shader.uniforms.uElevationHeatmap = mat.userData.PassUniforms.uElevationHeatmap;
        shader.uniforms.uElevMin = mat.userData.PassUniforms.uElevMin;
        shader.uniforms.uElevMax = mat.userData.PassUniforms.uElevMax;

        shader.vertexShader = shader.vertexShader.replace(
          "#include <common>",
          `#include <common>
           varying float vGsWorldY;`
        );
        shader.vertexShader = shader.vertexShader.replace(
          "#include <project_vertex>",
          `#include <project_vertex>
           vec4 gsWorldPos = modelMatrix * vec4(transformed, 1.0);
           vGsWorldY = gsWorldPos.y;`
        );

        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <common>",
          `#include <common>
           uniform float uBrightness;
           uniform float uElevationHeatmap;
           uniform float uElevMin;
           uniform float uElevMax;
           varying float vGsWorldY;
           vec3 gcScanPhotoColor = vec3(0.0);
           bool gcHasPhotoColor = false;
           vec3 gsElevationRamp(float t) {
             vec3 c0 = vec3(0.14, 0.38, 0.92); // Deep Blue (Low Z)
             vec3 c1 = vec3(0.02, 0.71, 0.83); // Cyan
             vec3 c2 = vec3(0.06, 0.73, 0.51); // Emerald Green (Mid Z)
             vec3 c3 = vec3(0.96, 0.62, 0.04); // Amber
             vec3 c4 = vec3(0.94, 0.27, 0.27); // Red (High Z)
             if (t < 0.25) return mix(c0, c1, t * 4.0);
             if (t < 0.50) return mix(c1, c2, (t - 0.25) * 4.0);
             if (t < 0.75) return mix(c2, c3, (t - 0.50) * 4.0);
             return mix(c3, c4, (t - 0.75) * 4.0);
           }`
        );
        if (shader.fragmentShader.includes("#include <color_fragment>")) {
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <color_fragment>",
            `#include <color_fragment>
             gcScanPhotoColor = diffuseColor.rgb;
             gcHasPhotoColor = true;`
          );
        }
        if (shader.fragmentShader.includes("#include <map_fragment>")) {
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <map_fragment>",
            `#include <map_fragment>
             gcScanPhotoColor = diffuseColor.rgb;
             gcHasPhotoColor = true;`
          );
        }
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <dithering_fragment>",
          `#include <dithering_fragment>
           vec3 basePhoto = gcHasPhotoColor ? gcScanPhotoColor : gl_FragColor.rgb;
           vec3 litPhoto = basePhoto * uBrightness;
           if (uElevationHeatmap > 0.5) {
             float elevT = clamp((vGsWorldY - uElevMin) / max(0.5, uElevMax - uElevMin), 0.0, 1.0);
             vec3 ramp = gsElevationRamp(elevT);
             float luma = clamp(dot(litPhoto, vec3(0.299, 0.587, 0.114)), 0.22, 1.15);
             float contourBand = smoothstep(0.91, 0.99, abs(fract(vGsWorldY * 0.5) * 2.0 - 1.0));
             vec3 heatRgb = mix(ramp * (0.52 + 0.56 * luma), litPhoto, 0.20);
             gl_FragColor.rgb = mix(heatRgb, heatRgb * 1.25, contourBand * 0.32);
           } else {
             gl_FragColor.rgb = litPhoto;
           }`
        );
      };
      mat.needsUpdate = true;
    }

    mat.userData._lastBrightness = b;
  }

  function setStudioScanBrightness(val) {
    const b = Math.max(0.1, Math.min(4.0, parseFloat(val) || 1.0));
    STATE.scanBrightness = b;
    const slider = document.getElementById("studioBrightnessSlider");
    if (slider && Math.abs(parseFloat(slider.value) - b) > 0.001) {
      slider.value = String(b);
    }
    const lbl = document.getElementById("lblStudioBrightness");
    if (lbl) {
      lbl.textContent = `${b.toFixed(1)}x`;
    }
    if (!studioThree) return;
    [studioThree.modelPivot, studioThree.fallbackGroup].forEach((grp) => {
      if (!grp) return;
      grp.traverse((child) => {
        if (child.isMesh && child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach((m) => applyBrightnessToMaterial(m, b));
        }
      });
    });
  }

  document.getElementById("studioBrightnessSlider")?.addEventListener("input", (e) => {
    setStudioScanBrightness(e.target.value);
  });
  document.getElementById("btnResetBrightness")?.addEventListener("click", () => {
    setStudioScanBrightness(1.0);
    showToast("Scan brightness reset to 1.0x");
  });

  function initStudio3D() {
    if (studioThree) return studioThree;
    const container = document.getElementById("studioCanvasContainer");
    if (!container) return null;

    const isDark = STATE.resolvedTheme === "dark";
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(isDark ? 0x0b0f19 : 0xe2e8f0);

    const camera = new THREE.PerspectiveCamera(
      50,
      Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
      0.1,
      10000
    );
    camera.position.set(45, 38, 55);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.localClippingEnabled = true;
    container.appendChild(renderer.domElement);

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.screenSpacePanning = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const hemi = new THREE.HemisphereLight(0xffffff, 0x475569, 0.45);
    scene.add(hemi);
    const dir1 = new THREE.DirectionalLight(0xffffff, 0.6);
    dir1.position.set(120, 220, 120);
    scene.add(dir1);

    const grid = new THREE.GridHelper(240, 24, isDark ? 0x334155 : 0x94a3b8, isDark ? 0x1e293b : 0xcbd5e1);
    grid.position.y = -0.2;
    scene.add(grid);

    const modelPivot = new THREE.Group();
    scene.add(modelPivot);

    // Interactive Reference Terrain Mesh (guarantees immediate raycast picking & visual stockpile terrain)
    const fallbackGroup = new THREE.Group();
    scene.add(fallbackGroup);

    const overlayGroup = new THREE.Group();
    scene.add(overlayGroup);

    // Dedicated group for Cut/Fill Volume & Polygon placement so placing points never wipes measurements (Fix #1)
    const volumeGroup = new THREE.Group();
    scene.add(volumeGroup);

    const polyPreviewGroup = new THREE.Group();
    scene.add(polyPreviewGroup);

    const contourGroup = new THREE.Group();
    scene.add(contourGroup);

    const commentPinsGroup = new THREE.Group();
    scene.add(commentPinsGroup);

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    studioThree = {
      container,
      scene,
      camera,
      renderer,
      controls,
      grid,
      modelPivot,
      fallbackGroup,
      overlayGroup,
      volumeGroup,
      polyPreviewGroup,
      contourGroup,
      commentPinsGroup,
      raycaster,
      mouse,
      tilesRenderer: null,
      loadedMesh: null,
      boundingSphere: null,
    };

    buildReferenceTerrainMesh(studioThree);

    // Pointer click & live rubberband preview handler for 3D Measurements & Tools
    let downPos = { x: 0, y: 0 };
    renderer.domElement.addEventListener("pointerdown", (e) => {
      downPos = { x: e.clientX, y: e.clientY };
    });
    renderer.domElement.addEventListener("pointerup", (e) => {
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 6) return;
      handleStudioCanvasClick(e);
    });
    renderer.domElement.addEventListener("pointermove", (e) => {
      if (STATE.activeView !== "studio") return;
      if (STATE.activeTool === "laser") {
        handleStudioLaserMove(e);
      } else if (STATE.activeTool === "distance" && STATE.measurePoints.length === 1) {
        const hoverPt = pickStudio3DPoint(e.clientX, e.clientY);
        if (hoverPt) {
          renderDistanceVisuals(hoverPt, null);
        }
      } else if (
        (STATE.activeTool === "volume" ||
          STATE.activeTool === "area" ||
          STATE.activeTool === "contours" ||
          (STATE.activeTool === "profile" && STATE.measurePoints.length === 1)) &&
        STATE.measurePoints.length >= 1
      ) {
        const hoverPt = pickStudio3DPoint(e.clientX, e.clientY);
        if (hoverPt) {
          renderPolygonRubberband(hoverPt);
          if (STATE.activeTool === "profile" && STATE.measurePoints.length === 1) {
            const dAB = STATE.measurePoints[0].distanceTo(hoverPt);
            const lbl = document.getElementById("lblLastPickedCoord");
            if (lbl) {
              const twd = localToTwd97(hoverPt);
              lbl.textContent = `SECTION A→B: ${dAB.toFixed(2)}m | E: ${twd.e.toFixed(2)}m, N: ${twd.n.toFixed(2)}m, H: +${twd.h.toFixed(2)}m`;
            }
          }
        }
      }
    });

    const animate = () => {
      requestAnimationFrame(animate);
      if (STATE.activeView !== "studio") return;
      controls.update();
      if (studioThree.tilesRenderer) {
        camera.updateMatrixWorld();
        studioThree.tilesRenderer.update();
        syncTilesLoaderProgress(studioThree, "studio");
        studioThree.tilesRenderer.group.traverse((child) => {
          if (child.isMesh && child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((m) => {
              if (m && m.metalness > 0) {
                m.metalness = 0.0;
                m.roughness = 1.0;
                m.side = THREE.DoubleSide;
                m.needsUpdate = true;
              }
              if (m && m.userData?._lastBrightness !== STATE.scanBrightness) {
                applyBrightnessToMaterial(m, STATE.scanBrightness);
              }
            });
          }
        });
      }
      updateZoomInvariantElements();
      renderer.render(scene, camera);
      update2DBadgePositions();
    };
    requestAnimationFrame(animate);

    return studioThree;
  }

  function buildReferenceTerrainMesh(ctx) {
    while (ctx.fallbackGroup.children.length > 0) {
      ctx.fallbackGroup.remove(ctx.fallbackGroup.children[0]);
    }
    const geom = new THREE.PlaneGeometry(140, 140, 70, 70);
    geom.rotateX(-Math.PI / 2);
    const pos = geom.attributes.position;
    const colors = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const r2 = (x * x + z * z) / (18 * 18);
      const y =
        0.015 * x -
        0.011 * z +
        0.35 * Math.sin(x * 0.08) * Math.cos(z * 0.08) +
        (r2 < 2.5 ? 2.65 * Math.exp(-1.8 * r2) : 0.0);
      pos.setY(i, y);

      const t = Math.min(1, Math.max(0, (y + 1.0) / 4.2));
      colors.push(0.22 + 0.35 * t, 0.34 + 0.28 * t, 0.28 + 0.15 * (1 - t));
    }
    geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geom.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.0,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.35,
    });
    applyBrightnessToMaterial(mat, STATE.scanBrightness);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = "referenceTerrain";
    ctx.fallbackGroup.add(mesh);
  }

  function loadScanIntoStudio(scanId) {
    initStudio3D();
    const scan = STATE.scans.find((s) => s.scan_id === scanId) || STATE.scans[0];
    if (!scan || !studioThree) return;

    STATE.activeScanId = scan.scan_id;
    STATE.activeScan = scan;
    STATE.activeProjectGroup = scan.project_group || "QuChi Dam";

    // Filter active scan dropdown strictly to this project's scans (Fix #4)
    populateProjectScanDropdowns(STATE.activeProjectGroup, scan.scan_id);

    const sel = document.getElementById("studioScanSelect");
    if (sel) sel.value = scan.scan_id;

    const metricsEl = document.getElementById("studioScanMetrics");
    if (metricsEl) {
      metricsEl.textContent = `TWD97 · TWVD2001 · ${formatCoveredAreaM2(scan)}`;
    }

    const dlBtn = document.getElementById("btnStudioDownloadObj");
    if (dlBtn) {
      dlBtn.href = scan.download_obj_url || `/api/download?scan_id=${scan.scan_id}&type=obj`;
    }

    // Teardown previous tilesRenderer / mesh
    if (studioThree.tilesRenderer) {
      studioThree.modelPivot.remove(studioThree.tilesRenderer.group);
      studioThree.tilesRenderer.dispose();
      studioThree.tilesRenderer = null;
    }
    while (studioThree.modelPivot.children.length > 0) {
      studioThree.modelPivot.remove(studioThree.modelPivot.children[0]);
    }
    studioThree.modelPivot.rotation.set(0, 0, 0);
    if (studioThree.fallbackGroup) studioThree.fallbackGroup.visible = false;

    startScanLoader(studioThree, "studio", scan.name);

    const streamUrl = scan.stream_url || `/stream/${scan.scan_id}/tileset.json`;

    if (scan.stream_type === "glb" || streamUrl.toLowerCase().endsWith(".glb")) {
      const loader = new THREE.GLTFLoader();
      if (window.MeshoptDecoder) loader.setMeshoptDecoder(window.MeshoptDecoder);
      const ktx2 = getKTX2Loader(studioThree.renderer);
      if (ktx2) loader.setKTX2Loader(ktx2);

      loader.load(
        streamUrl,
        (gltf) => {
          const model = gltf.scene;
          const box = new THREE.Box3().setFromObject(model);
          const sphere = new THREE.Sphere();
          box.getBoundingSphere(sphere);
          if (sphere.radius > 0) {
            model.position.set(-sphere.center.x, -sphere.center.y, -sphere.center.z);
          }
          if (studioThree.grid) {
            studioThree.grid.position.y = Number.isFinite(box.min.y)
              ? box.min.y - sphere.center.y - 0.3
              : -0.2;
          }
          model.traverse((c) => {
            if (c.isMesh && c.material) {
              const mats = Array.isArray(c.material) ? c.material : [c.material];
              mats.forEach((m) => applyBrightnessToMaterial(m, STATE.scanBrightness));
            }
          });
          studioThree.modelPivot.add(model);
          studioThree.boundingSphere = sphere;
          frameStudioCamera();
          finishScanLoader(studioThree, "studio", "100% · 3D Mesh Ready");
        },
        (xhr) => {
          const pct =
            xhr && xhr.total > 0
              ? Math.min(95, Math.max(12, Math.round((xhr.loaded / xhr.total) * 100)))
              : Math.min(88, (studioThree._maxPct || 12) + 8);
          studioThree._maxPct = pct;
          updateScanLoader("studio", true, pct, `Loading 3D Mesh (${pct}%)...`);
        },
        (err) => {
          if (studioThree.fallbackGroup) studioThree.fallbackGroup.visible = true;
          finishScanLoader(studioThree, "studio", "Ready");
          console.warn("[GatheringScans] Using reference terrain surface for GLB:", err);
        }
      );
    } else if (window.TilesRenderer) {
      const tr = new window.TilesRenderer(streamUrl);
      tr.fetchOptions = { mode: "cors" };
      tr.preprocessURL = (uri) => {
        let u = uri;
        if (STATE.shareToken && !u.includes("share=")) {
          u += (u.includes("?") ? "&" : "?") + `share=${encodeURIComponent(STATE.shareToken)}`;
        }
        return u;
      };
      tr.setCamera(studioThree.camera);
      tr.setResolutionFromRenderer(studioThree.camera, studioThree.renderer);

      const gltfLoader = new THREE.GLTFLoader(tr.manager);
      if (window.MeshoptDecoder) gltfLoader.setMeshoptDecoder(window.MeshoptDecoder);
      const ktx2 = getKTX2Loader(studioThree.renderer);
      if (ktx2) gltfLoader.setKTX2Loader(ktx2);
      tr.manager.addHandler(/\.(gltf|glb)(\?.*)?$/i, gltfLoader);

      tr.addEventListener("load-tileset", () => {
        studioThree._tilesetReady = true;
        studioThree._tilesetReadyMs = performance.now();
        studioThree._maxPct = Math.max(studioThree._maxPct || 0, 22);
        updateScanLoader("studio", true, studioThree._maxPct, "Streaming 3D tiles...");
        const sphere = new THREE.Sphere();
        if (computeTilesetContentSphere(tr, sphere)) {
          tr.group.position.set(-sphere.center.x, -sphere.center.y, -sphere.center.z);
          // Z-up TWD97 tilesets: rotate -90 deg on X so elevation points +Y
          studioThree.modelPivot.rotation.set(THREE.MathUtils.degToRad(270), 0, 0);
          studioThree.modelPivot.updateMatrixWorld(true);
          studioThree.boundingSphere = sphere;
          if (studioThree.grid) {
            studioThree.grid.position.y = Number.isFinite(sphere._groundOffsetY)
              ? sphere._groundOffsetY
              : -8.0;
          }
          frameStudioCamera();
        }
        studioThree.camera.updateMatrixWorld();
        tr.update();
      });

      tr.addEventListener("load-model", (ev) => {
        if (ev && ev.scene) {
          if (studioThree.fallbackGroup) studioThree.fallbackGroup.visible = false;
          ev.scene.traverse((c) => {
            if (c.isMesh && c.material) {
              const mats = Array.isArray(c.material) ? c.material : [c.material];
              mats.forEach((m) => applyBrightnessToMaterial(m, STATE.scanBrightness));
            }
          });
          studioThree.camera.updateMatrixWorld();
          tr.update();
          studioThree.renderer.render(studioThree.scene, studioThree.camera);
          syncTilesLoaderProgress(studioThree, "studio");
        }
      });

      tr.errorTarget = 6.0;
      if (tr.downloadQueue) tr.downloadQueue.maxJobs = 12;
      if (tr.parseQueue) tr.parseQueue.maxJobs = 6;
      studioThree.modelPivot.add(tr.group);
      studioThree.tilesRenderer = tr;
      studioThree.camera.updateMatrixWorld();
      tr.update();
    }

    renderCommentPins3D();
  }

  function frameStudioCamera() {
    if (!studioThree) return;
    const rawR = Number(studioThree.boundingSphere?.radius) || 58;
    const r = Math.max(22, Math.min(250, rawR));
    studioThree.controls.target.set(0, 0, 0);
    studioThree.camera.position.set(r * 0.7, r * 0.56, r * 0.8);
    studioThree.camera.lookAt(0, 0, 0);
    studioThree.controls.update();
  }

  document.getElementById("btnStudioResetCamera")?.addEventListener("click", frameStudioCamera);

  // Convert local Three.js (x, y, z) to TWD97 (121) + TWVD2001 (E, N, H)
  function localToTwd97(pt) {
    const s = STATE.activeScan || { twd97_e: 304952.656, twd97_n: 2757084.875, twd97_h: 43.18 };
    return {
      e: Number((s.twd97_e + pt.x).toFixed(3)),
      n: Number((s.twd97_n - pt.z).toFixed(3)),
      h: Number((s.twd97_h + pt.y).toFixed(3)),
    };
  }

  function pickStudio3DPoint(clientX, clientY) {
    if (!studioThree) return null;
    const rect = studioThree.renderer.domElement.getBoundingClientRect();
    studioThree.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    studioThree.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    studioThree.raycaster.setFromCamera(studioThree.mouse, studioThree.camera);

    const targets = [];
    studioThree.modelPivot.traverse((c) => {
      if (c.isMesh && c.visible) targets.push(c);
    });
    if (studioThree.fallbackGroup && studioThree.fallbackGroup.visible) {
      studioThree.fallbackGroup.traverse((c) => {
        if (c.isMesh && c.visible) targets.push(c);
      });
    }

    const hits = studioThree.raycaster.intersectObjects(targets, true);
    if (hits.length > 0) {
      const p = hits[0].point.clone();
      if (STATE.snapEnabled) {
        p.x = Math.round(p.x * 20) / 20;
        p.y = Math.round(p.y * 20) / 20;
        p.z = Math.round(p.z * 20) / 20;
      }
      return p;
    }
    return null;
  }

  const _tmpZoomWorldPos = new THREE.Vector3();

  function add3DPinMarker(pt, colorHex = 0x0084ff, targetGroup = null, onAddMesh = null) {
    if (!studioThree) return null;
    const grp = targetGroup || studioThree.overlayGroup;
    const emit = typeof onAddMesh === "function" ? onAddMesh : (m) => grp.add(m);

    const sphereGeo = new THREE.SphereGeometry(1, 16, 16);
    const sphereMat = new THREE.MeshBasicMaterial({
      color: colorHex,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    });
    const innerMesh = new THREE.Mesh(sphereGeo, sphereMat);
    innerMesh.position.copy(pt);
    innerMesh.userData.isZoomInvariantMarker = true;
    innerMesh.userData.pixelRadius = 5.5;
    innerMesh.renderOrder = 1002;
    emit(innerMesh);

    const ringGeo = new THREE.RingGeometry(0.72, 1.08, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    });
    const outerRing = new THREE.Mesh(ringGeo, ringMat);
    outerRing.position.copy(pt);
    outerRing.userData.isZoomInvariantRing = true;
    outerRing.userData.pixelRadius = 8.5;
    if (studioThree.camera) {
      outerRing.quaternion.copy(studioThree.camera.quaternion);
    }
    outerRing.renderOrder = 1001;
    emit(outerRing);

    updateZoomInvariantElements();
    return innerMesh;
  }

  function add2DBadge(worldPt, htmlText, borderColor = "#cbd5e1", options = {}) {
    const container = document.getElementById("studioOverlay2D");
    if (!container) return null;
    const el = document.createElement("div");
    if (options.rawHtml) {
      el.innerHTML = htmlText;
      const firstChild = el.firstElementChild;
      if (firstChild) {
        container.appendChild(firstChild);
        const badgeObj = {
          el: firstChild,
          worldPt: worldPt.clone(),
          offsetX: options.offsetX || 0,
          offsetY: options.offsetY || 0,
          isVolume: !!options.isVolume,
          isArea: !!options.isArea,
          isProfile: !!options.isProfile,
          isTempDistance: !!options.isTempDistance,
        };
        STATE.badges2D.push(badgeObj);
        update2DBadgePositions();
        return badgeObj;
      }
    }
    el.className = "measure-badge-2d";
    el.style.borderColor = borderColor;
    el.innerHTML = htmlText;
    container.appendChild(el);
    const badgeObj = {
      el,
      worldPt: worldPt.clone(),
      offsetX: options.offsetX || 0,
      offsetY: options.offsetY !== undefined ? options.offsetY : -10,
      isVolume: !!options.isVolume,
      isArea: !!options.isArea,
      isProfile: !!options.isProfile,
      isTempDistance: !!options.isTempDistance,
    };
    STATE.badges2D.push(badgeObj);
    update2DBadgePositions();
    return badgeObj;
  }

  function update2DBadgePositions() {
    if (!studioThree) return;
    const w = studioThree.renderer.domElement.clientWidth;
    const h = studioThree.renderer.domElement.clientHeight;
    STATE.badges2D.forEach((b) => {
      if (!b.el || !b.worldPt) return;
      const v = b.worldPt.clone().project(studioThree.camera);
      if (v.z > 1) {
        b.el.style.display = "none";
        return;
      }
      const x = (v.x * 0.5 + 0.5) * w + (b.offsetX || 0);
      const y = (-(v.y * 0.5) + 0.5) * h + (b.offsetY || 0);
      b.el.style.display = b.el.classList.contains("autodesk-delta-badge") ? "flex" : "block";
      const bw = b.el.offsetWidth || 120;
      const halfW = Math.min(bw * 0.5, w * 0.5 - 8);
      const clampedX = Math.max(halfW + 8, Math.min(w - halfW - 8, x));
      b.el.style.left = `${clampedX}px`;
      b.el.style.top = `${y}px`;
    });
  }

  // Screen-space zoom-invariant scaling for Gathering Cloud distance & surveying tool markers & rods (Fix #5)
  function updateZoomInvariantElements() {
    if (!studioThree) return;
    const cam = studioThree.camera;
    const h = Math.max(1, studioThree.renderer.domElement.clientHeight);
    const fovRad = THREE.MathUtils.degToRad(cam.fov);

    const groups = [
      studioThree.overlayGroup,
      studioThree.volumeGroup,
      studioThree.polyPreviewGroup,
      studioThree.contourGroup,
      studioThree.commentPinsGroup,
    ].filter(Boolean);

    groups.forEach((grp) => {
      grp.traverse((obj) => {
        if (!obj.userData) return;
        if (obj.userData.isZoomInvariantMarker || obj.userData.isZoomInvariantRing) {
          obj.getWorldPosition(_tmpZoomWorldPos);
          const dist = Math.max(0.1, cam.position.distanceTo(_tmpZoomWorldPos));
          const worldPerPixel = (2 * Math.tan(fovRad / 2) * dist) / h;
          const r = (obj.userData.pixelRadius || 5.5) * worldPerPixel * 0.55;
          obj.scale.setScalar(Math.max(0.0025, r));
          if (obj.userData.isZoomInvariantRing) {
            obj.quaternion.copy(cam.quaternion);
          }
        } else if (obj.userData.isZoomInvariantRod) {
          obj.getWorldPosition(_tmpZoomWorldPos);
          const dist = Math.max(0.1, cam.position.distanceTo(_tmpZoomWorldPos));
          const worldPerPixel = (2 * Math.tan(fovRad / 2) * dist) / h;
          const rad = Math.max(0.002, (obj.userData.pixelRadius || 1.35) * worldPerPixel * 0.55);
          obj.scale.set(rad, 1, rad);
        }
      });
    });
  }

  function setActiveStudioTool(toolName) {
    if (!toolName) return;
    STATE.activeTool = toolName;
    clearTempDistanceVisuals();
    if (studioThree && studioThree.polyPreviewGroup) {
      while (studioThree.polyPreviewGroup.children.length > 0) {
        studioThree.polyPreviewGroup.remove(studioThree.polyPreviewGroup.children[0]);
      }
    }
    document
      .querySelectorAll('#bimMeasurementToolbar .autodesk-measure-btn:not([data-tool="snap"])')
      .forEach((b) => b.classList.toggle("active", b.dataset.tool === toolName));
    document
      .querySelectorAll("#bimBottomDock .bim-dock-btn")
      .forEach((b) => b.classList.toggle("active", b.dataset.dock === toolName));
  }

  function clearTempDistanceVisuals() {
    if (studioThree && STATE.tempDistanceObjects.length) {
      STATE.tempDistanceObjects.forEach((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
        studioThree.overlayGroup.remove(obj);
      });
    }
    STATE.tempDistanceObjects = [];
    STATE.badges2D = STATE.badges2D.filter((b) => {
      if (b.isTempDistance) {
        b.el?.remove();
        return false;
      }
      return true;
    });
  }

  function clearAreaVisualsOnly() {
    if (studioThree && studioThree.overlayGroup) {
      const toRemove = [];
      studioThree.overlayGroup.children.forEach((c) => {
        if (c.userData && c.userData.isAreaVisual) toRemove.push(c);
      });
      toRemove.forEach((c) => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
        studioThree.overlayGroup.remove(c);
      });
    }
    if (studioThree && studioThree.polyPreviewGroup) {
      while (studioThree.polyPreviewGroup.children.length > 0) {
        studioThree.polyPreviewGroup.remove(studioThree.polyPreviewGroup.children[0]);
      }
    }
    STATE.badges2D = STATE.badges2D.filter((b) => {
      if (b.isArea) {
        b.el?.remove();
        return false;
      }
      return true;
    });
  }

  function clearVolumeVisualsOnly() {
    if (studioThree && studioThree.volumeGroup) {
      while (studioThree.volumeGroup.children.length > 0) {
        const c = studioThree.volumeGroup.children[0];
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
        studioThree.volumeGroup.remove(c);
      }
    }
    if (studioThree && studioThree.polyPreviewGroup) {
      while (studioThree.polyPreviewGroup.children.length > 0) {
        studioThree.polyPreviewGroup.remove(studioThree.polyPreviewGroup.children[0]);
      }
    }
    STATE.badges2D = STATE.badges2D.filter((b) => {
      if (b.isVolume) {
        b.el?.remove();
        return false;
      }
      return true;
    });
  }

  function clearMeasurements() {
    STATE.measurePoints = [];
    STATE.completedMeasurements = [];
    STATE.polygonLocked = false;
    clearTempDistanceVisuals();
    clearAreaVisualsOnly();
    clearVolumeVisualsOnly();
    if (studioThree) {
      while (studioThree.overlayGroup.children.length > 0) {
        studioThree.overlayGroup.remove(studioThree.overlayGroup.children[0]);
      }
    }
    const container = document.getElementById("studioOverlay2D");
    if (container) container.innerHTML = "";
    STATE.badges2D = [];
  }

  // Exact Gathering Cloud Distance Measurement Visuals with Orthogonal X, Y, Z Delta Breakdown (Fix #5)
  function formatGcDist(meters) {
    return `~ ${Number(meters).toFixed(2)} m`;
  }

  function renderDistanceVisuals(dynamicEnd = null, existingMeas = null) {
    if (!studioThree) return;
    let p1, p2;
    const isTemp = !existingMeas;

    if (existingMeas) {
      p1 = existingMeas.p1;
      p2 = existingMeas.p2;
    } else {
      clearTempDistanceVisuals();
      p1 = STATE.measurePoints[0];
      p2 = dynamicEnd || (STATE.measurePoints.length > 1 ? STATE.measurePoints[1] : null);
      if (!p1) return;
    }

    const addObj = (mesh) => {
      studioThree.overlayGroup.add(mesh);
      if (isTemp) STATE.tempDistanceObjects.push(mesh);
    };

    const addEndpointMarker = (pos) => {
      add3DPinMarker(pos, 0x0084ff, studioThree.overlayGroup, addObj);
    };

    const addLegRod = (start, end, colorHex) => {
      const lDir = new THREE.Vector3().subVectors(end, start);
      const lLen = lDir.length();
      if (lLen > 0.01) {
        const rodGeo = new THREE.CylinderGeometry(1, 1, lLen, 8);
        const rodMat = new THREE.MeshBasicMaterial({
          color: colorHex,
          depthTest: false,
          depthWrite: false,
          transparent: true,
          opacity: 0.90,
        });
        const rod = new THREE.Mesh(rodGeo, rodMat);
        rod.position.copy(start).addScaledVector(lDir, 0.5);
        rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), lDir.clone().normalize());
        rod.userData.isZoomInvariantRod = true;
        rod.userData.pixelRadius = 1.35;
        rod.renderOrder = 998;
        addObj(rod);
      }
    };

    // Endpoint 1
    addEndpointMarker(p1);

    if (!p2) {
      add2DBadge(
        p1,
        `<div class="autodesk-dist-badge">起點 (請點擊終點)</div>`,
        "#0084ff",
        { rawHtml: true, offsetY: -22, isTempDistance: true }
      );
      updateZoomInvariantElements();
      return;
    }

    // Endpoint 2
    addEndpointMarker(p2);

    // Direct 3D Dimension Line (#0084ff)
    const d3d = p1.distanceTo(p2);
    const lineGeo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x0084ff, linewidth: 2, depthTest: false });
    const directLine = new THREE.Line(lineGeo, lineMat);
    directLine.renderOrder = 998;
    addObj(directLine);
    addLegRod(p1, p2, 0x0084ff);

    const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
    add2DBadge(
      mid,
      `<div class="autodesk-dist-badge">${formatGcDist(d3d)}</div>`,
      "#0084ff",
      { rawHtml: true, isTempDistance: isTemp }
    );

    // Orthogonal X, Y, Z Delta Breakdown (matching Gathering Cloud Revit/BIM standard:
    // X = Easting p1 -> c1, Y = Plan Depth/Northing along Three.js Z c1 -> c2, Z = Elevation along Three.js Y c2 -> p2)
    const c1 = new THREE.Vector3(p2.x, p1.y, p1.z);
    const c2 = new THREE.Vector3(p2.x, p1.y, p2.z);

    const curDx = Math.abs(p2.x - p1.x);
    const curDy = Math.abs(p2.z - p1.z);
    const curDz = Math.abs(p2.y - p1.y);

    // 1. X Delta leg (Red #ef4444)
    const lineX = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([p1, c1]),
      new THREE.LineBasicMaterial({ color: 0xef4444, linewidth: 2, depthTest: false })
    );
    lineX.renderOrder = 998;
    addObj(lineX);
    addLegRod(p1, c1, 0xef4444);

    const midX = new THREE.Vector3().addVectors(p1, c1).multiplyScalar(0.5);
    add2DBadge(
      midX,
      `<div class="autodesk-delta-badge delta-x"><span class="autodesk-delta-axis axis-x">X</span><span class="autodesk-delta-val">${formatGcDist(curDx)}</span></div>`,
      "#ef4444",
      { rawHtml: true, isTempDistance: isTemp }
    );

    // 2. Y Delta leg (Green #10b981, Northing / Plan Depth along Three.js Z: c1 -> c2)
    const lineY = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([c1, c2]),
      new THREE.LineBasicMaterial({ color: 0x10b981, linewidth: 2, depthTest: false })
    );
    lineY.renderOrder = 998;
    addObj(lineY);
    addLegRod(c1, c2, 0x10b981);

    const midY = new THREE.Vector3().addVectors(c1, c2).multiplyScalar(0.5);
    add2DBadge(
      midY,
      `<div class="autodesk-delta-badge delta-y"><span class="autodesk-delta-axis axis-y">Y</span><span class="autodesk-delta-val">${formatGcDist(curDy)}</span></div>`,
      "#10b981",
      { rawHtml: true, isTempDistance: isTemp }
    );

    // 3. Z Delta leg (Blue #3b82f6, Vertical Elevation difference along Three.js Y: c2 -> p2)
    const lineZ = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([c2, p2]),
      new THREE.LineBasicMaterial({ color: 0x3b82f6, linewidth: 2, depthTest: false })
    );
    lineZ.renderOrder = 998;
    addObj(lineZ);
    addLegRod(c2, p2, 0x3b82f6);

    const midZ = new THREE.Vector3().addVectors(c2, p2).multiplyScalar(0.5);
    add2DBadge(
      midZ,
      `<div class="autodesk-delta-badge delta-z"><span class="autodesk-delta-axis axis-z">Z</span><span class="autodesk-delta-val">${formatGcDist(curDz)}</span></div>`,
      "#3b82f6",
      { rawHtml: true, offsetX: 46, offsetY: -8, isTempDistance: isTemp }
    );

    updateZoomInvariantElements();
  }

  // Live rubberband preview for Area, Cut/Fill Volume & Cross-Section Profile placement
  function renderPolygonRubberband(hoverPt) {
    if (!studioThree || !studioThree.polyPreviewGroup) return;
    while (studioThree.polyPreviewGroup.children.length > 0) {
      const c = studioThree.polyPreviewGroup.children[0];
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
      studioThree.polyPreviewGroup.remove(c);
    }
    const pts = STATE.measurePoints;
    if (!pts.length || !hoverPt) return;

    const previewPts =
      STATE.activeTool !== "profile" && pts.length >= 2
        ? [pts[pts.length - 1], hoverPt, pts[0]]
        : [pts[0], hoverPt];
    const geom = new THREE.BufferGeometry().setFromPoints(previewPts);
    const mat = new THREE.LineBasicMaterial({ color: 0x0084ff, depthTest: false, transparent: true, opacity: 0.85 });
    const line = new THREE.Line(geom, mat);
    line.renderOrder = 999;
    studioThree.polyPreviewGroup.add(line);
  }

  function handleStudioLaserMove(e) {
    const pt = pickStudio3DPoint(e.clientX, e.clientY);
    if (!pt) return;
    const twd = localToTwd97(pt);
    const lbl = document.getElementById("lblLastPickedCoord");
    if (lbl) {
      lbl.textContent = `LASER -> E: ${twd.e.toFixed(2)}m, N: ${twd.n.toFixed(2)}m, TWVD2001 H: +${twd.h.toFixed(2)}m`;
    }
  }

  function handleStudioCanvasClick(e) {
    const pt = pickStudio3DPoint(e.clientX, e.clientY);
    if (!pt) return;
    const twd = localToTwd97(pt);

    const lbl = document.getElementById("lblLastPickedCoord");
    if (lbl) {
      lbl.textContent = `E: ${twd.e.toFixed(2)}m, N: ${twd.n.toFixed(2)}m, H: +${twd.h.toFixed(2)}m`;
    }

    const tool = STATE.activeTool;

    const isNearStartVertex = (clickPt, startPt) => {
      if (!startPt || !studioThree || !studioThree.camera) return false;
      const cam = studioThree.camera;
      const h = Math.max(1, studioThree.renderer.domElement.clientHeight);
      const fovRad = THREE.MathUtils.degToRad(cam.fov);
      const dist = cam.position.distanceTo(startPt);
      const worldPerPixel = (2 * Math.tan(fovRad / 2) * dist) / h;
      const snapRadius = Math.max(0.05, Math.min(1.8, 18 * worldPerPixel));
      return clickPt.distanceTo(startPt) < snapRadius;
    };

    if (tool === "coordinates") {
      add3DPinMarker(pt, 0x0284c7);
      add2DBadge(
        pt,
        `E:${twd.e.toFixed(2)}m | N:${twd.n.toFixed(2)}m | H:+${twd.h.toFixed(2)}m`,
        "#cbd5e1"
      );
      return;
    }

    if (tool === "photos") {
      add3DPinMarker(pt, 0x0284c7);
      openRtkPhotoInspector(pt);
      return;
    }

    if (tool === "comments") {
      add3DPinMarker(pt, 0x0284c7);
      openCommentsInspector(pt, twd);
      return;
    }

    if (tool === "distance") {
      STATE.measurePoints.push(pt.clone());
      if (STATE.measurePoints.length === 1) {
        renderDistanceVisuals(null, null);
      } else if (STATE.measurePoints.length >= 2) {
        const [p1, p2] = STATE.measurePoints;
        clearTempDistanceVisuals();
        const meas = {
          id: `dist_${Date.now()}`,
          p1: p1.clone(),
          p2: p2.clone(),
          dist: p1.distanceTo(p2),
        };
        STATE.completedMeasurements.push(meas);
        renderDistanceVisuals(null, meas);
        STATE.measurePoints = [];
      }
      return;
    }

    if (tool === "angle") {
      STATE.measurePoints.push(pt);
      add3DPinMarker(pt, 0x0284c7);
      if (STATE.measurePoints.length === 3) {
        const [p1, p2, p3] = STATE.measurePoints;
        const v1 = p1.clone().sub(p2).normalize();
        const v2 = p3.clone().sub(p2).normalize();
        const deg = THREE.MathUtils.radToDeg(Math.acos(Math.max(-1, Math.min(1, v1.dot(v2)))));
        const lineGeom = new THREE.BufferGeometry().setFromPoints([p1, p2, p3]);
        studioThree.overlayGroup.add(new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color: 0x0284c7, depthTest: false })));
        add2DBadge(p2, `Angle: <b>${deg.toFixed(1)}°</b>`, "#cbd5e1");
        STATE.measurePoints = [];
      }
      return;
    }

    if (tool === "area") {
      if (STATE.measurePoints.length >= 3 && isNearStartVertex(pt, STATE.measurePoints[0])) {
        if (studioThree && studioThree.polyPreviewGroup) {
          while (studioThree.polyPreviewGroup.children.length > 0) {
            studioThree.polyPreviewGroup.remove(studioThree.polyPreviewGroup.children[0]);
          }
        }
        const lockedPts = STATE.measurePoints.map((p) => p.clone());
        STATE.measurePoints = [];
        showToast(`Area polygon closed (${lockedPts.length} vertices)`);
        return;
      }

      STATE.measurePoints.push(pt.clone());
      const pts = STATE.measurePoints.slice();
      clearAreaVisualsOnly();
      const addAreaObj = (m) => {
        m.userData.isAreaVisual = true;
        studioThree.overlayGroup.add(m);
      };
      pts.forEach((p, idx) => {
        add3DPinMarker(p, idx === 0 ? 0xff3b30 : 0x0284c7, studioThree.overlayGroup, addAreaObj);
      });
      if (pts.length >= 2) {
        const loopPts = pts.length >= 3 ? [...pts, pts[0]] : pts;
        const lineGeom = new THREE.BufferGeometry().setFromPoints(loopPts);
        const lineMesh = new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color: 0x0284c7, depthTest: false }));
        addAreaObj(lineMesh);
      }
      if (pts.length >= 3) {
        STATE.maskBoundaryPoints = pts.map((p) => p.clone());
        let area2 = 0;
        let perim = 0;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          area2 += a.x * b.z - b.x * a.z;
          perim += a.distanceTo(b);
        }
        const areaM2 = Math.abs(area2) * 0.5;
        const areaPing = areaM2 * 0.3025;
        const centroid = pts.reduce((acc, p) => acc.add(p.clone()), new THREE.Vector3()).divideScalar(pts.length);
        add2DBadge(
          centroid,
          `Area: <b>${areaM2.toFixed(2)} m²</b> (${areaPing.toFixed(2)} 坪) · Perim: ${perim.toFixed(2)}m`,
          "#cbd5e1",
          { isArea: true }
        );
      }
      return;
    }

    if (tool === "volume") {
      if (STATE.polygonLocked && STATE.measurePoints.length === 0) {
        showToast("Cut/Fill boundary is locked — click 'Redraw Polygon' in the Cut/Fill panel to draw a new zone");
        return;
      }
      // Allow clicking 3+ points on the 3D scan to place & refine the Cut/Fill polygon
      if (STATE.measurePoints.length >= 3 && isNearStartVertex(pt, STATE.measurePoints[0])) {
        // Clicking near start point closes and locks the polygon AND immediately computes volume
        if (studioThree && studioThree.polyPreviewGroup) {
          while (studioThree.polyPreviewGroup.children.length > 0) {
            studioThree.polyPreviewGroup.remove(studioThree.polyPreviewGroup.children[0]);
          }
        }
        const lockedPts = STATE.measurePoints.map((p) => p.clone());
        STATE.cutFillPolygonPoints = lockedPts;
        STATE.maskBoundaryPoints = lockedPts.map((p) => p.clone());
        STATE.measurePoints = [];
        STATE.polygonLocked = true;
        showToast(`Cut/Fill boundary polygon locked (${lockedPts.length} vertices) — computing volume...`);
        openCutFillVolumeInspector(lockedPts);
        return;
      }

      STATE.polygonLocked = false;
      STATE.measurePoints.push(pt.clone());
      const pts = STATE.measurePoints.slice();
      STATE.cutFillPolygonPoints = pts.map((p) => p.clone());

      // Immediately draw the placed vertices & edges in volumeGroup so they never disappear
      drawPlacedCutFillPolygon3D(pts, null);

      if (pts.length >= 3) {
        STATE.maskBoundaryPoints = pts.map((p) => p.clone());
        openCutFillVolumeInspector(pts);
      } else {
        showToast(`Cut/Fill Point ${pts.length} placed — click ${3 - pts.length} more point${3 - pts.length === 1 ? "" : "s"} to compute volume`);
      }
      return;
    }

    if (tool === "profile") {
      STATE.measurePoints.push(pt.clone());
      if (STATE.measurePoints.length === 1) {
        drawProfileSectionLine3D(STATE.measurePoints[0], null);
        showToast("Cross-Section Start A placed — click End Point B on the 3D scan");
      } else if (STATE.measurePoints.length >= 2) {
        const [p1, p2] = STATE.measurePoints;
        STATE.profileEndpoints = [p1.clone(), p2.clone()];
        STATE.measurePoints = [];
        if (studioThree && studioThree.polyPreviewGroup) {
          while (studioThree.polyPreviewGroup.children.length > 0) {
            studioThree.polyPreviewGroup.remove(studioThree.polyPreviewGroup.children[0]);
          }
        }
        drawProfileSectionLine3D(p1, p2);
        openProfileInspector(p1, p2);
      }
      return;
    }

    if (tool === "contours") {
      if (STATE.measurePoints.length >= 3 && isNearStartVertex(pt, STATE.measurePoints[0])) {
        if (studioThree && studioThree.polyPreviewGroup) {
          while (studioThree.polyPreviewGroup.children.length > 0) {
            studioThree.polyPreviewGroup.remove(studioThree.polyPreviewGroup.children[0]);
          }
        }
        STATE.maskBoundaryPoints = STATE.measurePoints.map((p) => p.clone());
        showToast(`Mask boundary locked (${STATE.maskBoundaryPoints.length} vertices) — updating Civil3D.dwg & A3 PDF`);
        STATE.measurePoints = [];
        openContoursInspector();
        return;
      }

      STATE.measurePoints.push(pt.clone());
      const pts = STATE.measurePoints.slice();
      add3DPinMarker(pt, pts.length === 1 ? 0xff3b30 : 0x0284c7);

      if (pts.length >= 3) {
        STATE.maskBoundaryPoints = pts.map((p) => p.clone());
        openContoursInspector();
      } else {
        showToast(`Mask Boundary Point ${pts.length} placed — click ${3 - pts.length} more point${3 - pts.length === 1 ? "" : "s"} to clip contours`);
      }
      return;
    }
  }

  // Real-time Three.js 3D Mesh Vertical Raycaster for Client-Side Volume & Cross-Section Profile Sampling
  const _downRaycaster = new THREE.Raycaster();
  const _downRayOrigin = new THREE.Vector3();
  const _downRayDir = new THREE.Vector3(0, -1, 0);

  function getStudioRaycastMeshes() {
    if (!studioThree) return [];
    if (studioThree.modelPivot) {
      studioThree.modelPivot.updateMatrixWorld(true);
    }
    const targets = [];
    studioThree.modelPivot.traverse((c) => {
      if (c.isMesh && c.visible) targets.push(c);
    });
    if (!targets.length && studioThree.fallbackGroup && studioThree.fallbackGroup.visible) {
      studioThree.fallbackGroup.updateMatrixWorld(true);
      studioThree.fallbackGroup.traverse((c) => {
        if (c.isMesh && c.visible) targets.push(c);
      });
    }
    return targets;
  }

  function sampleStudioMeshElevationAtLocalXZ(lx, lz, fallbackY = 0, cachedTargets = null) {
    const targets = cachedTargets || getStudioRaycastMeshes();
    if (!targets.length) return { y: fallbackY, hit: false };
    _downRayOrigin.set(lx, 450, lz);
    _downRaycaster.set(_downRayOrigin, _downRayDir);
    const hits = _downRaycaster.intersectObjects(targets, true);
    if (hits && hits.length > 0) {
      return { y: hits[0].point.y, hit: true };
    }
    return { y: fallbackY, hit: false };
  }

  function getDefaultPolygonOnStudioMesh() {
    const targets = getStudioRaycastMeshes();
    const rawR = Number(studioThree?.boundingSphere?.radius) || 12;
    const halfSpan = Math.max(1.2, Math.min(7.5, rawR * 0.25));
    const cx = Number(studioThree?.controls?.target?.x) || 0;
    const cz = Number(studioThree?.controls?.target?.z) || 0;
    const corners = [
      [cx - halfSpan, cz - halfSpan * 0.85],
      [cx + halfSpan, cz - halfSpan * 0.85],
      [cx + halfSpan, cz + halfSpan * 0.85],
      [cx - halfSpan, cz + halfSpan * 0.85],
    ];
    return corners.map(([x, z]) => {
      const s = sampleStudioMeshElevationAtLocalXZ(x, z, 0, targets);
      return new THREE.Vector3(x, s.y, z);
    });
  }

  function computeClientMeshVolume(ptsLocal, opts = {}) {
    const activeScan = STATE.activeScan || STATE.scans.find((s) => s.scan_id === STATE.activeScanId) || {
      scan_id: STATE.activeScanId || "scan",
      name: STATE.activeScanId || "Active Scan",
      project_group: STATE.activeProjectGroup || "Project",
      twd97_e: 304952.656,
      twd97_n: 2757084.875,
      twd97_h: 43.18,
    };
    const ce = Number(activeScan.twd97_e || 304952.656);
    const cn = Number(activeScan.twd97_n || 2757084.875);
    const ch = Number(activeScan.twd97_h || 43.18);

    const pts = ptsLocal && ptsLocal.length >= 3 ? ptsLocal : getDefaultPolygonOnStudioMesh();
    const targets = getStudioRaycastMeshes();

    // Planar Shoelace area & 3D perimeter
    let area2 = 0;
    let perim = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      area2 += a.x * b.z - b.x * a.z;
      perim += a.distanceTo(b);
    }
    const planarAreaM2 = Math.max(0.01, Math.abs(area2) * 0.5);
    const planarAreaPing = planarAreaM2 * 0.3025;

    // Dense perimeter samples in local (x, y, z)
    const perimSamples = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const segLen = Math.hypot(b.x - a.x, b.z - a.z);
      const nSub = Math.max(2, Math.min(16, Math.ceil(segLen / 0.35)));
      for (let k = 0; k < nSub; k++) {
        const t = k / nSub;
        const sx = a.x + t * (b.x - a.x);
        const sz = a.z + t * (b.z - a.z);
        const linY = a.y + t * (b.y - a.y);
        const sHit = sampleStudioMeshElevationAtLocalXZ(sx, sz, linY, targets);
        perimSamples.push({ x: sx, y: sHit.hit ? sHit.y : linY, z: sz });
      }
    }

    const perimMeanLocalY =
      perimSamples.reduce((acc, p) => acc + p.y, 0) / Math.max(1, perimSamples.length);
    const perimMeanH = ch + perimMeanLocalY;
    const baseMode = opts.base_mode || "triangulated_boundary";
    const datumH = Number.isFinite(opts.datum_elevation_m) ? opts.datum_elevation_m : perimMeanH;
    const datumLocalY = datumH - ch;

    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minZ = Math.min(...pts.map((p) => p.z));
    const maxZ = Math.max(...pts.map((p) => p.z));
    const spanX = Math.max(0.2, maxX - minX);
    const spanZ = Math.max(0.2, maxZ - minZ);

    const nx = 26;
    const nz = 26;
    const dx = spanX / nx;
    const dzStep = spanZ / nz;
    const cellArea = dx * dzStep;

    const pointInPolyXZ = (px, pz) => {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i].x, zi = pts[i].z;
        const xj = pts[j].x, zj = pts[j].z;
        const intersect = zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi + 1e-12) + xi;
        if (intersect) inside = !inside;
      }
      return inside;
    };

    let fillVol = 0;
    let cutVol = 0;
    let surfaceArea = 0;
    let maxDz = -1e9;
    let minDz = 1e9;
    let insideCells = 0;
    let hitCells = 0;
    const heatmapCells = [];

    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        const gx = minX + (ix + 0.5) * dx;
        const gz = minZ + (iz + 0.5) * dzStep;
        if (!pointInPolyXZ(gx, gz)) continue;
        insideCells++;

        // Interpolate perimeter elevation at (gx, gz)
        let wSum = 0;
        let yInterp = 0;
        for (let k = 0; k < perimSamples.length; k++) {
          const ps = perimSamples[k];
          const d2 = (gx - ps.x) * (gx - ps.x) + (gz - ps.z) * (gz - ps.z) + 0.02;
          const w = 1 / d2;
          wSum += w;
          yInterp += w * ps.y;
        }
        const yPerimBase = yInterp / Math.max(wSum, 1e-9);
        const sSurf = sampleStudioMeshElevationAtLocalXZ(gx, gz, yPerimBase, targets);
        if (sSurf.hit) hitCells++;
        const ySurf = sSurf.y;

        let yBase = yPerimBase;
        if (baseMode === "custom_plane") {
          yBase = datumLocalY;
        } else if (baseMode === "epoch_diff") {
          yBase = yPerimBase - 0.18;
        }

        const deltaY = ySurf - yBase;
        maxDz = Math.max(maxDz, deltaY);
        minDz = Math.min(minDz, deltaY);

        if (deltaY >= 0) fillVol += deltaY * cellArea;
        else cutVol += Math.abs(deltaY) * cellArea;

        surfaceArea += cellArea * 1.04;
        if (heatmapCells.length < 260) {
          heatmapCells.push({
            e: Number((ce + gx).toFixed(2)),
            n: Number((cn - gz).toFixed(2)),
            z_surf: Number((ch + ySurf).toFixed(3)),
            z_base: Number((ch + yBase).toFixed(3)),
            dz: Number(deltaY.toFixed(3)),
            lx: Number(gx.toFixed(3)),
            ly_surf: Number(ySurf.toFixed(3)),
            ly_base: Number(yBase.toFixed(3)),
            lz: Number(gz.toFixed(3)),
          });
        }
      }
    }

    if (insideCells > 0) {
      const scale = planarAreaM2 / Math.max(insideCells * cellArea, 1e-6);
      fillVol *= scale;
      cutVol *= scale;
      surfaceArea *= scale;
    }

    const netVol = fillVol - cutVol;
    const matKey = opts.material_type || "crushed_stone";
    const matObj = (STATE.materials && STATE.materials[matKey]) || {
      name: "Crushed Stone / 碎石級配",
      density_t_m3: 1.65,
      swell_factor: 1.18,
    };
    const density = Number.isFinite(opts.density_t_m3) ? opts.density_t_m3 : Number(matObj.density_t_m3 || 1.65);
    const swell = Number(matObj.swell_factor || 1.18);
    const effectiveM3 = Math.max(fillVol, cutVol);
    const tonnageLoose = effectiveM3 * density;
    const tonnageBank = effectiveM3 * density * swell;

    const boundaryTwd97 = pts.map((p, i) => {
      const t = localToTwd97(p);
      return { vertex: i + 1, easting_m: t.e, northing_m: t.n, twvd2001_h_m: t.h };
    });

    // Generate client-side downloadable CSV & HTML Blob URLs so Report/CSV work even offline
    const csvLines = [
      "GatheringScans Civil Engineering & Stockpile Volume Report",
      `Project Group,"${activeScan.project_group || ""}"`,
      `Scan Name,"${activeScan.name || ""}"`,
      `Zone / Stockpile Name,"${opts.stockpile_name || "Stockpile A"}"`,
      `Base Surface Mode,${baseMode}`,
      "",
      "Metric,Value,Unit",
      `Fill / Stockpile Volume (+),${fillVol.toFixed(2)},m3`,
      `Cut / Excavation Volume (-),${cutVol.toFixed(2)},m3`,
      `Net Earthwork Volume,${netVol.toFixed(2)},m3`,
      `2D Planar Footprint Area,${planarAreaM2.toFixed(2)},m2`,
      `2D Planar Footprint Area (Ping),${planarAreaPing.toFixed(2)},ping`,
      `3D Sloped Surface Area,${Math.max(surfaceArea, planarAreaM2).toFixed(2)},m2`,
      `Boundary Perimeter,${perim.toFixed(2)},m`,
      `Material Classification,"${matObj.name}",`,
      `Material Bulk Density,${density.toFixed(2)},t/m3`,
      `Estimated Material Mass (Loose),${tonnageLoose.toFixed(2)},t`,
      `Estimated Bank Mass,${tonnageBank.toFixed(2)},t`,
      "",
      "Vertex #,TWD97 Easting E (m),TWD97 Northing N (m),TWVD2001 Elevation H (m)",
      ...boundaryTwd97.map((v) => `V${v.vertex},${v.easting_m},${v.northing_m},${v.twvd2001_h_m}`),
    ];
    const csvBlob = new Blob(["\uFEFF" + csvLines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const csvUrl = URL.createObjectURL(csvBlob);

    const htmlDoc = `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><title>Stockpile Volume Report — ${escapeHtml(
      opts.stockpile_name || "Stockpile A"
    )}</title><style>body{font-family:sans-serif;max-width:880px;margin:28px auto;color:#0f172a}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border:1px solid #cbd5e1;padding:8px 10px;text-align:left}th{background:#f1f5f9}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}.card{border:1px solid #cbd5e1;border-radius:8px;padding:12px;background:#f8fafc}.val{font-size:20px;font-weight:800;margin-top:4px}</style></head><body><h2>土方體積與物料堆置量測報告 (Stockpile &amp; Cut/Fill Report)</h2><div>Project: <b>${escapeHtml(
      activeScan.project_group || ""
    )}</b> | Scan: <b>${escapeHtml(activeScan.name || "")}</b> | Zone: <b>${escapeHtml(
      opts.stockpile_name || "Stockpile A"
    )}</b></div><div class="grid"><div class="card"><div>Fill Volume (+)</div><div class="val" style="color:#0284c7">+${fillVol.toFixed(
      2
    )} m³</div></div><div class="card"><div>Cut Volume (-)</div><div class="val" style="color:#dc2626">-${cutVol.toFixed(
      2
    )} m³</div></div><div class="card"><div>Net Volume</div><div class="val">${
      netVol >= 0 ? "+" : ""
    }${netVol.toFixed(2)} m³</div></div><div class="card"><div>Estimated Mass</div><div class="val">${tonnageLoose.toFixed(
      2
    )} t</div></div></div><table><tr><th>Footprint Area</th><td>${planarAreaM2.toFixed(
      2
    )} m² (${planarAreaPing.toFixed(2)} 坪)</td><th>Perimeter</th><td>${perim.toFixed(
      2
    )} m</td></tr><tr><th>Material</th><td>${escapeHtml(
      matObj.name
    )} (${density.toFixed(2)} t/m³)</td><th>Datum Z₀</th><td>+${datumH.toFixed(
      3
    )} m</td></tr></table><table><thead><tr><th>Vertex</th><th>TWD97 E (m)</th><th>TWD97 N (m)</th><th>TWVD2001 H (m)</th></tr></thead><tbody>${boundaryTwd97
      .map(
        (v) =>
          `<tr><td>V${v.vertex}</td><td>${v.easting_m.toFixed(3)}</td><td>${v.northing_m.toFixed(
            3
          )}</td><td>+${v.twvd2001_h_m.toFixed(3)}</td></tr>`
      )
      .join("")}</tbody></table></body></html>`;
    const htmlBlob = new Blob([htmlDoc], { type: "text/html;charset=utf-8" });
    const htmlUrl = URL.createObjectURL(htmlBlob);

    return {
      status: "ok",
      scan_id: activeScan.scan_id,
      scan_name: activeScan.name,
      project_group: activeScan.project_group,
      stockpile_name: opts.stockpile_name || "Stockpile A",
      crs_short: "TWD97 (121) + TWVD2001",
      base_mode: baseMode,
      datum_elevation_m: Number(datumH.toFixed(3)),
      perim_mean_h_m: Number(perimMeanH.toFixed(3)),
      planar_area_m2: Number(planarAreaM2.toFixed(2)),
      planar_area_ping: Number(planarAreaPing.toFixed(2)),
      surface_area_m2: Number(Math.max(surfaceArea, planarAreaM2).toFixed(2)),
      perimeter_m: Number(perim.toFixed(2)),
      fill_volume_m3: Number(fillVol.toFixed(2)),
      cut_volume_m3: Number(cutVol.toFixed(2)),
      net_volume_m3: Number(netVol.toFixed(2)),
      max_delta_z_m: Number((maxDz > -1e8 ? maxDz : 0).toFixed(2)),
      min_delta_z_m: Number((minDz < 1e8 ? minDz : 0).toFixed(2)),
      material_name: matObj.name,
      density_t_m3: Number(density.toFixed(2)),
      swell_factor: Number(swell.toFixed(2)),
      estimated_tonnage_t: Number(tonnageLoose.toFixed(2)),
      bank_tonnage_t: Number(tonnageBank.toFixed(2)),
      boundary_twd97: boundaryTwd97,
      cell_step_m: Number(Math.max(dx, dzStep).toFixed(3)),
      heatmap_cells: heatmapCells,
      hit_ratio: insideCells > 0 ? hitCells / insideCells : 0,
      report_html_url: htmlUrl,
      report_csv_url: csvUrl,
      _resolvedPtsLocal: pts,
    };
  }

  // Helper to push a 3D volumetric box prism (top face + 4 vertical side faces) into a triangle buffer
  function pushBoxPrismTriangles(arr, x, z, hs, yLow, yHigh) {
    const x0 = x - hs, x1 = x + hs;
    const z0 = z - hs, z1 = z + hs;
    // Top face (yHigh)
    arr.push(
      x0, yHigh, z0, x1, yHigh, z0, x1, yHigh, z1,
      x0, yHigh, z0, x1, yHigh, z1, x0, yHigh, z1
    );
    // North wall (z0)
    arr.push(
      x0, yLow, z0, x1, yLow, z0, x1, yHigh, z0,
      x0, yLow, z0, x1, yHigh, z0, x0, yHigh, z0
    );
    // South wall (z1)
    arr.push(
      x0, yLow, z1, x1, yHigh, z1, x1, yLow, z1,
      x0, yLow, z1, x0, yHigh, z1, x1, yHigh, z1
    );
    // West wall (x0)
    arr.push(
      x0, yLow, z0, x0, yHigh, z0, x0, yHigh, z1,
      x0, yLow, z0, x0, yHigh, z1, x0, yLow, z1
    );
    // East wall (x1)
    arr.push(
      x1, yLow, z0, x1, yHigh, z1, x1, yHigh, z0,
      x1, yLow, z0, x1, yLow, z1, x1, yHigh, z1
    );
  }

  // Draw the user's placed Cut/Fill vertices, boundary lines, and real DSM 3D cut/fill columns in studioThree.volumeGroup
  function drawPlacedCutFillPolygon3D(pts, volumeRes = null) {
    if (!studioThree || !studioThree.volumeGroup) return;
    clearVolumeVisualsOnly();

    if (!pts || !pts.length) {
      if (volumeRes && Array.isArray(volumeRes._resolvedPtsLocal) && volumeRes._resolvedPtsLocal.length >= 3) {
        drawPlacedCutFillPolygon3D(volumeRes._resolvedPtsLocal, volumeRes);
      } else if (volumeRes) {
        drawPlacedCutFillPolygon3D(getDefaultPolygonOnStudioMesh(), volumeRes);
      }
      return;
    }

    // 1. Vertex Pins (Identical zoom-invariant marker + white ring as Distance tool; Red start vertex #ff3b30, Blue subsequent vertices #0084ff)
    pts.forEach((p, idx) => {
      add3DPinMarker(p, idx === 0 ? 0xff3b30 : 0x0084ff, studioThree.volumeGroup);
      if (pts.length >= 2) {
        const isUnclosedFirst = idx === 0 && pts.length >= 3 && STATE.measurePoints.length >= 3;
        add2DBadge(
          p,
          isUnclosedFirst ? `<b>V1</b> (點此鎖定)` : `V${idx + 1}`,
          idx === 0 ? "#ff3b30" : "#0084ff",
          { offsetY: -18, isVolume: true }
        );
      }
    });

    if (pts.length === 1) {
      add2DBadge(
        pts[0],
        `<div class="autodesk-dist-badge">挖填方起點 V1 (請點擊至少 3 點圍成範圍)</div>`,
        "#0084ff",
        { rawHtml: true, offsetY: -22, isVolume: true }
      );
      return;
    }

    // 2. Boundary Outline
    const loopPts = pts.length >= 3 ? [...pts, pts[0]] : pts.slice();
    const topLoopGeo = new THREE.BufferGeometry().setFromPoints(loopPts);
    const topLoopLine = new THREE.Line(
      topLoopGeo,
      new THREE.LineBasicMaterial({ color: 0x0084ff, linewidth: 2, depthTest: false })
    );
    topLoopLine.renderOrder = 1000;
    studioThree.volumeGroup.add(topLoopLine);

    if (pts.length < 3) return;

    const activeScan = STATE.activeScan || STATE.scans.find((s) => s.scan_id === STATE.activeScanId) || {};
    const ch = Number(activeScan.twd97_h || 43.18);
    const minY =
      volumeRes && Number.isFinite(volumeRes.datum_elevation_m)
        ? Number(volumeRes.datum_elevation_m) - ch
        : Math.min(...pts.map((p) => p.y)) - 0.1;
    const maxY = Math.max(...pts.map((p) => p.y));
    const centroid = pts.reduce((acc, p) => acc.add(p.clone()), new THREE.Vector3()).divideScalar(pts.length);

    // 3. Render real 3D Cut/Fill volumetric prisms when heatmap_cells are returned
    const cells = volumeRes && Array.isArray(volumeRes.heatmap_cells) ? volumeRes.heatmap_cells : [];
    if (cells.length > 0) {
      const fillPositions = [];
      const cutPositions = [];
      const cellStep = Number(volumeRes?.cell_step_m) || 0.45;
      const halfStep = Math.max(0.03, Math.min(0.32, cellStep * 0.42));
      cells.forEach((c) => {
        const x = Number(c.lx || 0);
        const z = Number(c.lz || 0);
        const ySurf = Number(c.ly_surf || 0) + 0.015;
        const yBase = Number(c.ly_base || 0);
        const dz = Number(c.dz || 0);
        if (Math.abs(dz) < 0.006) return;
        const yLow = Math.min(yBase, ySurf);
        const yHigh = Math.max(yBase, ySurf);
        if (dz >= 0) {
          pushBoxPrismTriangles(fillPositions, x, z, halfStep, yLow, yHigh);
        } else {
          pushBoxPrismTriangles(cutPositions, x, z, halfStep, yLow, yHigh);
        }
      });
      if (fillPositions.length > 0) {
        const fillGeo = new THREE.BufferGeometry();
        fillGeo.setAttribute("position", new THREE.Float32BufferAttribute(fillPositions, 3));
        const fillMesh = new THREE.Mesh(
          fillGeo,
          new THREE.MeshBasicMaterial({
            color: 0x0ea5e9,
            transparent: true,
            opacity: 0.44,
            side: THREE.DoubleSide,
            depthWrite: false,
          })
        );
        fillMesh.renderOrder = 995;
        studioThree.volumeGroup.add(fillMesh);
      }
      if (cutPositions.length > 0) {
        const cutGeo = new THREE.BufferGeometry();
        cutGeo.setAttribute("position", new THREE.Float32BufferAttribute(cutPositions, 3));
        const cutMesh = new THREE.Mesh(
          cutGeo,
          new THREE.MeshBasicMaterial({
            color: 0xef4444,
            transparent: true,
            opacity: 0.44,
            side: THREE.DoubleSide,
            depthWrite: false,
          })
        );
        cutMesh.renderOrder = 995;
        studioThree.volumeGroup.add(cutMesh);
      }
    } else {
      // Initial boundary triangulation while awaiting calculation
      const positions = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        positions.push(a.x, a.y + 0.03, a.z, b.x, b.y + 0.03, b.z, centroid.x, centroid.y + 0.03, centroid.z);
        positions.push(a.x, minY, a.z, b.x, minY, b.z, b.x, b.y + 0.03, b.z);
        positions.push(a.x, minY, a.z, b.x, b.y + 0.03, b.z, a.x, a.y + 0.03, a.z);
      }
      const prismGeo = new THREE.BufferGeometry();
      prismGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      const prismMesh = new THREE.Mesh(
        prismGeo,
        new THREE.MeshBasicMaterial({
          color: 0x0ea5e9,
          transparent: true,
          opacity: 0.34,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      prismMesh.renderOrder = 995;
      studioThree.volumeGroup.add(prismMesh);
    }

    // Base datum outline & vertical drop lines at vertices
    const baseLoopPts = [...pts.map((p) => new THREE.Vector3(p.x, minY, p.z)), new THREE.Vector3(pts[0].x, minY, pts[0].z)];
    const baseLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(baseLoopPts),
      new THREE.LineBasicMaterial({ color: 0x38bdf8, depthTest: false, transparent: true, opacity: 0.78 })
    );
    baseLine.renderOrder = 996;
    studioThree.volumeGroup.add(baseLine);

    // 4. 2D Cut/Fill Volume & Tonnage Badge at Polygon Centroid
    const badgePos = new THREE.Vector3(centroid.x, maxY + 0.45, centroid.z);
    if (volumeRes) {
      add2DBadge(
        badgePos,
        `Fill: <b style="color:#0284c7;">+${volumeRes.fill_volume_m3} m³</b> · Cut: <b style="color:#ef4444;">-${volumeRes.cut_volume_m3} m³</b> · Net: <b>${volumeRes.net_volume_m3 >= 0 ? "+" : ""}${volumeRes.net_volume_m3} m³</b> (${volumeRes.estimated_tonnage_t} t)`,
        "#0284c7",
        { isVolume: true }
      );
    } else {
      add2DBadge(
        badgePos,
        `Computing Cut/Fill Volume (${pts.length} pts)...`,
        "#0284c7",
        { isVolume: true }
      );
    }
    updateZoomInvariantElements();
  }

  // ============================================================================
  // 3. CIVIL ENGINEERING INSPECTOR PANELS (Volume, Contours, Profile, Photos, Optimizer)
  // ============================================================================
  function showSidePanel(title, htmlContent) {
    const panel = document.getElementById("studioSidePanel");
    const titleEl = document.getElementById("sidePanelTitle");
    const bodyEl = document.getElementById("sidePanelBody");
    if (!panel || !titleEl || !bodyEl) return;
    titleEl.innerHTML = title;
    bodyEl.innerHTML = htmlContent;
    panel.classList.add("active");
  }

  document.getElementById("btnCloseSidePanel")?.addEventListener("click", () => {
    document.getElementById("studioSidePanel")?.classList.remove("active");
  });

  // 3A. Cut/Fill & Material Stockpile Report Generator
  async function openCutFillVolumeInspector(customPts = null) {
    setActiveStudioTool("volume");
    if (customPts && customPts.length >= 3) {
      STATE.cutFillPolygonPoints = customPts.map((p) => p.clone());
    }
    const resolveCurrentVolumePts = () => {
      if (STATE.measurePoints && STATE.measurePoints.length >= 3) {
        return STATE.measurePoints.slice();
      }
      if (STATE.cutFillPolygonPoints && STATE.cutFillPolygonPoints.length >= 3) {
        return STATE.cutFillPolygonPoints.slice();
      }
      if (STATE.maskBoundaryPoints && STATE.maskBoundaryPoints.length >= 3) {
        return STATE.maskBoundaryPoints.slice();
      }
      const defPts = getDefaultPolygonOnStudioMesh();
      STATE.cutFillPolygonPoints = defPts;
      return defPts;
    };

    const activeScan = STATE.activeScan || STATE.scans.find((s) => s.scan_id === STATE.activeScanId) || {};
    const defaultZoneName = `${activeScan.name || STATE.activeScanId || "Site"} — Earthwork / Stockpile Zone A`;
    const initialPts = resolveCurrentVolumePts();
    const meanPtY = initialPts.reduce((acc, p) => acc + (p.y || 0), 0) / Math.max(1, initialPts.length);
    const defaultDatumZ = Number(((Number(activeScan.twd97_h || 43.18) + meanPtY)).toFixed(2));

    const panel = document.getElementById("studioSidePanel");
    const alreadyOpenForVolume = panel?.classList.contains("active") && document.getElementById("volStockpileName");

    if (!alreadyOpenForVolume) {
      const matOptions = Object.entries(STATE.materials || {
        crushed_stone: { name: "Crushed Stone / 碎石級配", density_t_m3: 1.65 },
        excavated_soil: { name: "Excavated Soil / 一般營建土方", density_t_m3: 1.45 },
        sand_gravel: { name: "River Sand & Gravel / 砂石骨材", density_t_m3: 1.75 },
        rockfill_rip_rap: { name: "Quarry Rockfill / 塊石與拋石", density_t_m3: 1.85 },
        concrete_debris: { name: "Demolition Concrete / 營建剩餘混凝土", density_t_m3: 1.55 },
      })
        .map(
          ([k, v]) =>
            `<option value="${k}" data-density="${v.density_t_m3}">${v.name} (${v.density_t_m3} t/m³)</option>`
        )
        .join("");

      showSidePanel(
        `<span>Cut/Fill &amp; Stockpile Volume</span>`,
        `
        <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:7px;padding:7px 9px;margin-bottom:9px;line-height:1.4;">
          Click <b>3+ points</b> on the 3D scan to place a Cut/Fill boundary polygon. Click red start point <b>V1</b> to lock, or press <b>Compute</b> to analyze.
        </div>
        <div class="gs-form-group">
          <label>Zone / Stockpile Name (土方或物料堆名稱)</label>
          <input type="text" class="gs-input" id="volStockpileName" value="${escapeHtml(defaultZoneName)}" />
        </div>
        <div class="gs-form-group">
          <label>Base Reference Surface Mode (基準面計算方式)</label>
          <select class="gs-select" id="volBaseMode">
            <option value="triangulated_boundary">1. Triangulated Boundary Perimeter (獨立土石堆周界擬合面)</option>
            <option value="custom_plane">2. Custom Datum Elevation Plane Z₀ (指定設計高程基準面 TWVD2001)</option>
            <option value="epoch_diff">3. Multi-Date Epoch-to-Epoch Diff (跨期掃描進度挖填差額)</option>
          </select>
        </div>
        <div class="gs-form-group">
          <label>Material Classification &amp; Bulk Density (物料種類與比重 t/m³)</label>
          <select class="gs-select" id="volMaterialSelect">${matOptions}</select>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;" class="gs-form-group">
          <div>
            <label>Density (t/m³)</label>
            <input type="number" step="0.05" class="gs-input" id="volCustomDensity" value="1.65" />
          </div>
          <div>
            <label>Datum Elev Z₀ (TWVD2001 m)</label>
            <input type="number" step="0.1" class="gs-input" id="volDatumZ" value="${defaultDatumZ}" />
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-bottom:8px;">
          <button type="button" class="gs-top-btn accent" style="flex:1.6;justify-content:center;" id="btnRunVolumeCalc" title="Compute Cut/Fill Volume &amp; Tonnage">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M3 18L9 8l5 6 4-4 3 8H3z"/>
            </svg>
            <span id="lblRunVolumeCalc">Compute</span>
          </button>
          <button type="button" class="gs-top-btn" style="flex:1;justify-content:center;" id="btnResetVolumePoly" title="Clear &amp; Draw New Boundary Polygon">
            <span>Redraw Polygon</span>
          </button>
        </div>
        <div id="volResultContainer"></div>
        `
      );

      const matSel = document.getElementById("volMaterialSelect");
      const densInput = document.getElementById("volCustomDensity");
      if (matSel && densInput) {
        matSel.addEventListener("change", () => {
          const opt = matSel.options[matSel.selectedIndex];
          if (opt && opt.dataset.density) densInput.value = opt.dataset.density;
          runCalc();
        });
      }
      const datumInput = document.getElementById("volDatumZ");
      const modeSel = document.getElementById("volBaseMode");
      if (datumInput && modeSel) {
        datumInput.addEventListener("input", () => {
          // Automatically switch to Custom Datum Plane Z₀ mode when user edits Datum Elev Z₀
          if (modeSel.value === "triangulated_boundary") {
            modeSel.value = "custom_plane";
          }
        });
        datumInput.addEventListener("change", () => runCalc());
        modeSel.addEventListener("change", () => runCalc());
      }
      document.getElementById("btnResetVolumePoly")?.addEventListener("click", () => {
        setActiveStudioTool("volume");
        STATE.polygonLocked = false;
        STATE.measurePoints = [];
        STATE.cutFillPolygonPoints = [];
        STATE.maskBoundaryPoints = [];
        clearVolumeVisualsOnly();
        const box = document.getElementById("volResultContainer");
        if (box) {
          box.innerHTML = `<div style="font-size:11.5px;color:var(--ui-accent);padding:8px;background:var(--ui-bg-subtle);border-radius:7px;border:1px solid var(--ui-border);">Polygon cleared — click <b>3+ points</b> on the 3D scan to define a new Cut/Fill zone, or press <b>Compute</b> to auto-fit center zone.</div>`;
        }
        showToast("Click 3+ points on the 3D scan to draw a new Cut/Fill polygon");
      });
    }

    async function runCalc(ptsOverride = null) {
      const btnLbl = document.getElementById("lblRunVolumeCalc");
      if (btnLbl) btnLbl.textContent = "Computing...";

      const ptsToUse =
        ptsOverride && ptsOverride.length >= 3
          ? ptsOverride
          : resolveCurrentVolumePts();

      const opts = {
        scan_id: STATE.activeScanId,
        stockpile_name: document.getElementById("volStockpileName")?.value || defaultZoneName,
        base_mode: document.getElementById("volBaseMode")?.value || "triangulated_boundary",
        material_type: document.getElementById("volMaterialSelect")?.value || "crushed_stone",
        density_t_m3: parseFloat(document.getElementById("volCustomDensity")?.value || "1.65"),
        datum_elevation_m: parseFloat(document.getElementById("volDatumZ")?.value || String(defaultDatumZ)),
      };

      // 1. Immediate client-side Three.js 3D mesh raycast calculation (<30ms, anchored 100% to live 3D mesh)
      const clientRes = computeClientMeshVolume(ptsToUse, opts);
      STATE.lastVolumeResult = clientRes;
      renderVolumeResultAnd3D(clientRes, ptsToUse);

      // 2. Also query backend DSM engine for multi-epoch comparison & server archival
      const polyPayload = ptsToUse.map((p) => {
        const t = localToTwd97(p);
        return [t.e, t.n, t.h];
      });
      try {
        const srvRes = await apiPost("/api/survey/volume", {
          ...opts,
          polygon: polyPayload,
        });
        if (srvRes && srvRes.status === "ok") {
          const useClientMeshExact = clientRes.hit_ratio > 0 && opts.base_mode !== "epoch_diff";
          let mergedRes;
          if (useClientMeshExact) {
            // Preserve live Three.js mesh-exact elevations, heatmap_cells, and matching HTML/CSV reports
            mergedRes = {
              ...srvRes,
              ...clientRes,
              _resolvedPtsLocal: ptsToUse,
            };
          } else {
            // Align backend heatmap_cells vertically to the Three.js mesh vertices so columns sit flush on the scan
            const meshMeanY = ptsToUse.reduce((a, p) => a + p.y, 0) / Math.max(1, ptsToUse.length);
            const srvCells = Array.isArray(srvRes.heatmap_cells) ? srvRes.heatmap_cells : [];
            const srvMeanY =
              srvCells.length > 0
                ? srvCells.reduce((a, c) => a + Number(c.ly_surf || 0), 0) / srvCells.length
                : meshMeanY;
            const yShift = meshMeanY - srvMeanY;
            const alignedCells = srvCells.map((c) => ({
              ...c,
              ly_surf: Number((Number(c.ly_surf || 0) + yShift).toFixed(3)),
              ly_base: Number((Number(c.ly_base || 0) + yShift).toFixed(3)),
            }));
            mergedRes = {
              ...clientRes,
              ...srvRes,
              heatmap_cells: alignedCells.length > 0 ? alignedCells : clientRes.heatmap_cells,
              report_html_url: srvRes.report_html_url || clientRes.report_html_url,
              report_csv_url: srvRes.report_csv_url || clientRes.report_csv_url,
              _resolvedPtsLocal: ptsToUse,
            };
          }
          STATE.lastVolumeResult = mergedRes;
          renderVolumeResultAnd3D(mergedRes, ptsToUse);
        }
      } catch (_) {
        // Client-side 3D mesh raycast result is already rendered and downloadable
      } finally {
        if (btnLbl) btnLbl.textContent = "Compute";
      }
    }

    const btnCalc = document.getElementById("btnRunVolumeCalc");
    if (btnCalc) {
      btnCalc.onclick = () => {
        runCalc().then(() => {
          const r = STATE.lastVolumeResult;
          if (r) {
            showToast(
              `Computed: Fill +${r.fill_volume_m3} m³ · Cut -${r.cut_volume_m3} m³ · Mass ${r.estimated_tonnage_t} t`
            );
          }
        });
      };
    }
    await runCalc(customPts);
  }

  function renderVolumeResultAnd3D(res, customPts = null) {
    const box = document.getElementById("volResultContainer");
    if (box) {
      box.innerHTML = `
        <div class="gs-metric-grid">
          <div class="gs-metric-box">
            <div class="lbl">Fill Volume (+)</div>
            <div class="val" style="color:var(--ui-accent);">+${res.fill_volume_m3} m³</div>
          </div>
          <div class="gs-metric-box">
            <div class="lbl">Cut Volume (-)</div>
            <div class="val" style="color:#ef4444;">-${res.cut_volume_m3} m³</div>
          </div>
          <div class="gs-metric-box">
            <div class="lbl">Net Volume</div>
            <div class="val">${res.net_volume_m3 >= 0 ? "+" : ""}${res.net_volume_m3} m³</div>
          </div>
          <div class="gs-metric-box">
            <div class="lbl">Estimated Mass</div>
            <div class="val">${res.estimated_tonnage_t} t</div>
          </div>
        </div>
        <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-subtle);padding:9px 10px;border-radius:8px;border:1px solid var(--ui-border);margin-bottom:10px;line-height:1.5;">
          <div><b>Footprint Area:</b> ${res.planar_area_m2} m² (${res.planar_area_ping} 坪) · <b>Vertices:</b> ${(res.boundary_twd97 || []).length}</div>
          <div><b>Sloped Area:</b> ${res.surface_area_m2} m² · <b>Perim:</b> ${res.perimeter_m} m</div>
          <div><b>Base Surface:</b> ${
            res.base_mode === "custom_plane"
              ? `Custom Datum Z₀ (+${res.datum_elevation_m} m)`
              : res.base_mode === "epoch_diff"
              ? "Multi-Date Epoch Diff"
              : `Perimeter Fit (Mean +${res.perim_mean_h_m ?? res.datum_elevation_m} m)`
          }</div>
          <div><b>Material:</b> ${res.material_name} (${res.density_t_m3} t/m³ · Bank: ${res.bank_tonnage_t ?? res.estimated_tonnage_t} t)</div>
        </div>
        <div style="display:flex;gap:6px;">
          <a class="btn-xs primary" style="flex:1;justify-content:center;" href="${res.report_html_url}" target="_blank" title="Open Printable Stockpile Report (PDF/HTML)">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            </svg>
            <span>Report</span>
          </a>
          <a class="btn-xs" style="flex:1;justify-content:center;" href="${res.report_csv_url}" download="stockpile_volume_report.csv" title="Export Excel (.CSV)">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span>CSV</span>
          </a>
        </div>
      `;
    }

    const ptsToRender =
      customPts && customPts.length >= 1
        ? customPts
        : STATE.measurePoints && STATE.measurePoints.length >= 1
        ? STATE.measurePoints.slice()
        : STATE.cutFillPolygonPoints && STATE.cutFillPolygonPoints.length >= 1
        ? STATE.cutFillPolygonPoints.slice()
        : res._resolvedPtsLocal || null;
    drawPlacedCutFillPolygon3D(ptsToRender, res);
  }

  // 3B. Survey Report: Mask Boundary, 3D Elevation Contours, Civil3D.dwg & A3 Ready-to-Print PDF Exporter
  async function openContoursInspector() {
    setActiveStudioTool("contours");
    const activeScan = STATE.activeScan || STATE.scans.find((s) => s.scan_id === STATE.activeScanId) || {};
    const defaultTitle = `${activeScan.name || STATE.activeScanId} — Topographic Survey`;
    const maskPts =
      STATE.maskBoundaryPoints && STATE.maskBoundaryPoints.length >= 3
        ? STATE.maskBoundaryPoints
        : STATE.measurePoints && STATE.measurePoints.length >= 3
        ? STATE.measurePoints
        : [];

    const panel = document.getElementById("studioSidePanel");
    const alreadyOpenForContours = panel?.classList.contains("active") && document.getElementById("cntDrawingTitle");

    if (!alreadyOpenForContours) {
      showSidePanel(
        `<span>Survey Report (Civil3D.dwg &amp; A3 PDF)</span>`,
        `
        <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:7px;padding:7px 9px;margin-bottom:9px;line-height:1.45;">
          Uses your active <b>Mask Boundary</b> &amp; <b>Contour Lines</b> to generate <code>Civil3D.dwg</code> (real <b>TWD97 XYZ</b>) and a zoom-to-fit <b>A3 Ready-to-Print PDF</b> with filled engineering frame. Click 3+ points on the scan to customize the mask boundary.
        </div>
        <div class="gs-form-group">
          <label>Engineering Frame Title (圖名 / 掃描專案名稱)</label>
          <input type="text" class="gs-input" id="cntDrawingTitle" value="${defaultTitle}" />
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;" class="gs-form-group">
          <div>
            <label>Minor Interval (次等高線 m)</label>
            <select class="gs-select" id="cntMinorStep">
              <option value="0.25">0.25 m</option>
              <option value="0.5" selected>0.50 m</option>
              <option value="1.0">1.00 m</option>
              <option value="2.0">2.00 m</option>
            </select>
          </div>
          <div>
            <label>Major Interval (計曲線 m)</label>
            <select class="gs-select" id="cntMajorStep">
              <option value="1.0">1.00 m</option>
              <option value="2.5" selected>2.50 m</option>
              <option value="5.0">5.00 m</option>
            </select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;" class="gs-form-group">
          <div>
            <label>Surveyor (測量工程師)</label>
            <input type="text" class="gs-input" id="cntEngineerName" value="${STATE.currentUser?.name || "雲在天"}" />
          </div>
          <div>
            <label>Mask Boundary (邊界遮罩)</label>
            <div style="display:flex;gap:4px;">
              <button type="button" class="btn-xs" style="flex:1;justify-content:center;" id="btnDrawCustomMask" title="Click 3+ points on 3D scan to define custom mask boundary">Draw</button>
              <button type="button" class="btn-xs" style="flex:1;justify-content:center;" id="btnResetCustomMask" title="Reset to default scan footprint boundary">Reset</button>
            </div>
          </div>
        </div>
        <button type="button" class="gs-top-btn accent" style="width:100%;justify-content:center;margin-bottom:8px;" id="btnGenerateContours" title="Generate Civil3D.dwg &amp; A3 Ready-to-Print PDF Survey Report">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          </svg>
          <span>Create Survey Report</span>
        </button>
        <div id="cntResultContainer"></div>
        `
      );

      document.getElementById("btnDrawCustomMask")?.addEventListener("click", () => {
        STATE.activeTool = "contours";
        STATE.measurePoints = [];
        document
          .querySelectorAll('#bimMeasurementToolbar .autodesk-measure-btn:not([data-tool="snap"])')
          .forEach((b) => b.classList.toggle("active", b.dataset.tool === "contours"));
        showToast("Click 3+ points on the 3D scan to draw a custom Mask Boundary");
      });

      document.getElementById("btnResetCustomMask")?.addEventListener("click", () => {
        STATE.maskBoundaryPoints = [];
        STATE.measurePoints = [];
        runContours();
        showToast("Reset to default scan survey mask boundary");
      });
    }

    const runContours = async () => {
      const minor = parseFloat(document.getElementById("cntMinorStep")?.value || "0.5");
      const major = parseFloat(document.getElementById("cntMajorStep")?.value || "2.5");
      const drawingTitle = document.getElementById("cntDrawingTitle")?.value || defaultTitle;
      const engineerName = document.getElementById("cntEngineerName")?.value || "雲在天";

      const currentMaskPts =
        STATE.maskBoundaryPoints && STATE.maskBoundaryPoints.length >= 3
          ? STATE.maskBoundaryPoints
          : STATE.measurePoints && STATE.measurePoints.length >= 3
          ? STATE.measurePoints
          : maskPts;

      const maskPayload =
        currentMaskPts && currentMaskPts.length >= 3
          ? currentMaskPts.map((p) => {
              const t = localToTwd97(p);
              return [t.e, t.n, t.h];
            })
          : [];

      try {
        const res = await apiPost("/api/survey/report", {
          scan_id: STATE.activeScanId,
          minor_interval_m: minor,
          major_interval_m: major,
          drawing_title: drawingTitle,
          engineer_name: engineerName,
          mask_polygon: maskPayload,
        });
        STATE.lastContoursResult = res;
        renderContours3DAndPanel(res);
      } catch (err) {
        showToast(`Survey Report Error: ${err.message}`);
      }
    };

    const btnGen = document.getElementById("btnGenerateContours");
    if (btnGen) btnGen.onclick = runContours;
    await runContours();
  }

  function drawA3PreviewCanvas(canvas, res) {
    if (!canvas || !res) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // A3 Sheet background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    // Double engineering frame border
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(6, 6, w - 12, h - 12);
    ctx.lineWidth = 0.6;
    ctx.strokeRect(9, 9, w - 18, h - 18);

    // Map viewport [14 .. 232] x [14 .. h-14]
    const vpX = 14;
    const vpY = 14;
    const vpW = 216;
    const vpH = h - 28;
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(vpX, vpY, vpW, vpH);
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 1;
    ctx.strokeRect(vpX, vpY, vpW, vpH);

    const polyTwd = res.mask_polygon_twd97 || [];
    if (polyTwd.length >= 3) {
      const minE = Math.min(...polyTwd.map((p) => p[0]));
      const maxE = Math.max(...polyTwd.map((p) => p[0]));
      const minN = Math.min(...polyTwd.map((p) => p[1]));
      const maxN = Math.max(...polyTwd.map((p) => p[1]));
      const ce = 0.5 * (minE + maxE);
      const cn = 0.5 * (minN + maxN);
      const span = Math.max(maxE - minE, maxN - minN, 6.0) * 1.24;
      const scale = Math.min(vpW / span, vpH / span);

      const toXY = (e, n) => [
        vpX + vpW * 0.5 + (e - ce) * scale,
        vpY + vpH * 0.5 - (n - cn) * scale,
      ];

      ctx.save();
      ctx.beginPath();
      ctx.rect(vpX, vpY, vpW, vpH);
      ctx.clip();

      // Grid lines
      ctx.strokeStyle = "#e2e8f0";
      ctx.lineWidth = 0.6;
      for (let gx = vpX + 24; gx < vpX + vpW; gx += 32) {
        ctx.beginPath();
        ctx.moveTo(gx, vpY);
        ctx.lineTo(gx, vpY + vpH);
        ctx.stroke();
      }
      for (let gy = vpY + 24; gy < vpY + vpH; gy += 32) {
        ctx.beginPath();
        ctx.moveTo(vpX, gy);
        ctx.lineTo(vpX + vpW, gy);
        ctx.stroke();
      }

      // Shaded Mask Boundary
      ctx.fillStyle = "rgba(2, 132, 199, 0.08)";
      ctx.beginPath();
      polyTwd.forEach((p, idx) => {
        const [x, y] = toXY(p[0], p[1]);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fill();

      // Clipped Contours
      (res.contours || []).forEach((c) => {
        const pts = c.points_twd97 || [];
        if (pts.length < 2) return;
        ctx.strokeStyle = c.is_major ? "#0284c7" : "#94a3b8";
        ctx.lineWidth = c.is_major ? 1.2 : 0.55;
        ctx.beginPath();
        pts.forEach((p, idx) => {
          const [x, y] = toXY(p[0], p[1]);
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      });

      // Mask Boundary Stroke & Vertices
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 1.4;
      ctx.setLineDash([5, 2]);
      ctx.beginPath();
      polyTwd.forEach((p, idx) => {
        const [x, y] = toXY(p[0], p[1]);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);

      polyTwd.forEach((p, idx) => {
        const [x, y] = toXY(p[0], p[1]);
        ctx.fillStyle = "#0284c7";
        ctx.fillRect(x - 2, y - 2, 4, 4);
        ctx.fillStyle = "#0f172a";
        ctx.font = "bold 7px monospace";
        ctx.fillText(`V${idx + 1}`, x + 3, y - 2);
      });

      ctx.restore();
    }

    // North Arrow & Scale inside viewport
    ctx.fillStyle = "#0f172a";
    ctx.font = "bold 8px Inter, sans-serif";
    ctx.fillText("N", vpX + vpW - 14, vpY + 14);
    ctx.fillText(`SCALE 1:${res.scale_denom || 250} (A3 FIT)`, vpX + 6, vpY + vpH - 6);

    // Right Engineering Frame & Title Block [234 .. w-10]
    const tbX = 234;
    const tbW = w - tbX - 10;
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 0.9;
    ctx.strokeRect(tbX, 14, tbW, vpH);

    // Gathering Construction Company Banner in Title Block
    const banY = vpY + vpH - 54;
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(tbX, banY, tbW, 20);
    if (!window._gconLogoImg) {
      const img = new Image();
      img.onload = () => {
        window._gconLogoImgLoaded = true;
        drawA3PreviewCanvas(canvas, res);
      };
      img.src = "/assets/gathering_construction_logo_dark.png";
      window._gconLogoImg = img;
    }
    if (window._gconLogoImgLoaded && window._gconLogoImg) {
      ctx.drawImage(window._gconLogoImg, tbX + 3, banY + 4, tbW - 6, 12);
    } else {
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 6.5px Inter, sans-serif";
      ctx.fillText("聚人營造股份有限公司", tbX + 5, banY + 9);
      ctx.fillStyle = "#38bdf8";
      ctx.font = "bold 5px Inter, sans-serif";
      ctx.fillText("GATHERING CONSTRUCTION", tbX + 5, banY + 16);
    }

    // Title block metadata rows
    ctx.fillStyle = "#0f172a";
    ctx.font = "bold 6.5px Inter, sans-serif";
    ctx.fillText("BOUNDARY SCHEDULE", tbX + 4, 24);
    ctx.font = "6px monospace";
    (polyTwd.slice(0, 6) || []).forEach((p, i) => {
      ctx.fillText(`V${i + 1} E:${p[0].toFixed(0)} N:${p[1].toFixed(0)}`, tbX + 4, 34 + i * 9);
    });

    ctx.font = "bold 6.5px Inter, sans-serif";
    ctx.fillText(String(res.project_group || "QuChi Dam").slice(0, 18), tbX + 4, banY + 29);
    ctx.font = "6px Inter, sans-serif";
    ctx.fillStyle = "#475569";
    ctx.fillText(`Date: ${String(res.survey_date || "").slice(0, 10)}`, tbX + 4, banY + 38);
    ctx.fillStyle = "#0284c7";
    ctx.font = "bold 6.5px monospace";
    ctx.fillText(`A3 1:${res.scale_denom || 250} · TWD97`, tbX + 4, banY + 48);
  }

  function renderContours3DAndPanel(res) {
    const box = document.getElementById("cntResultContainer");
    if (box) {
      box.innerHTML = `
        <div style="margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:10.5px;font-weight:700;color:var(--ui-text-secondary);margin-bottom:4px;">
            <span>A3 ENGINEERING SHEET PREVIEW (420×297mm)</span>
            <span style="color:var(--ui-accent);">SCALE 1:${res.scale_denom || 250}</span>
          </div>
          <canvas id="a3SheetPreviewCanvas" width="336" height="210" style="width:100%;background:#ffffff;border:1px solid var(--ui-border-strong);border-radius:7px;box-shadow:0 1px 3px rgba(15,23,42,0.06);"></canvas>
        </div>
        <div class="gs-metric-grid">
          <div class="gs-metric-box">
            <div class="lbl">Clipped Contours</div>
            <div class="val" style="color:var(--ui-accent);">${res.contour_count} lines</div>
          </div>
          <div class="gs-metric-box">
            <div class="lbl">A3 Fit Scale</div>
            <div class="val">1:${res.scale_denom || 250}</div>
          </div>
          <div class="gs-metric-box">
            <div class="lbl">Mask Area</div>
            <div class="val">${res.planar_area_m2 || 0} m²</div>
          </div>
          <div class="gs-metric-box">
            <div class="lbl">TWVD2001 Elev</div>
            <div class="val">+${res.elevation_range_m[0]}~+${res.elevation_range_m[1]}m</div>
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-top:8px;">
          <a class="btn-xs primary" style="flex:1.2;justify-content:center;" href="${res.civil3d_dwg_url || res.dwg_url}" download="Civil3D.dwg" title="Download Civil3D.dwg (Real TWD97 XYZ + A3 Engineering Frame)">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span>Civil3D.dwg</span>
          </a>
          <a class="btn-xs primary" style="flex:1;justify-content:center;" href="${res.pdf_url}" target="_blank" title="Open Ready-to-Print A3 Survey Report (.PDF)">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            </svg>
            <span>A3 PDF</span>
          </a>
          <a class="btn-xs" style="flex:0.8;justify-content:center;" href="${res.dxf_url}" download title="Export AutoCAD .DXF">
            <span>DXF</span>
          </a>
        </div>
      `;
      const previewCanvas = document.getElementById("a3SheetPreviewCanvas");
      if (previewCanvas) drawA3PreviewCanvas(previewCanvas, res);
    }

    if (!studioThree) return;
    while (studioThree.contourGroup.children.length > 0) {
      studioThree.contourGroup.remove(studioThree.contourGroup.children[0]);
    }

    // 1. Render Clipped 3D Contours in TWD97 / Local 3D Space
    (res.contours || []).forEach((c) => {
      const pts = c.points_local.map((p) => new THREE.Vector3(p[0], p[1] + 0.15, p[2]));
      if (pts.length < 2) return;
      const geom = new THREE.BufferGeometry().setFromPoints(pts);
      const color = c.is_major ? 0x0284c7 : 0x64748b;
      const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color }));
      studioThree.contourGroup.add(line);
    });

    // 2. Render Active 3D Mask Boundary Loop & Vertex Monuments
    const maskLocal = res.mask_polygon_local || [];
    if (maskLocal.length >= 3) {
      const bPts = maskLocal.map((p) => new THREE.Vector3(p[0], p[1] + 0.25, p[2]));
      const loopPts = [...bPts, bPts[0].clone()];
      const bLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(loopPts),
        new THREE.LineBasicMaterial({ color: 0x38bdf8, linewidth: 2, depthTest: false })
      );
      bLine.renderOrder = 1001;
      studioThree.contourGroup.add(bLine);

      bPts.forEach((bp, idx) => {
        add3DPinMarker(bp, idx === 0 ? 0xff3b30 : 0x0284c7, studioThree.contourGroup);
      });
    }

    showToast(`Survey Report ready: Civil3D.dwg + A3 PDF (${res.contour_count} clipped contours, 1:${res.scale_denom || 250})`);
  }

  // 3C. Cross-Section Elevation Profile Graph (Client-Side 3D Mesh Raycaster + Backend Multi-Epoch DSM)
  function getDefaultProfileEndpointsOnStudioMesh() {
    const targets = getStudioRaycastMeshes();
    const rawR = Number(studioThree?.boundingSphere?.radius) || 10;
    const halfSpan = Math.max(1.5, Math.min(8.5, rawR * 0.28));
    const cx = Number(studioThree?.controls?.target?.x) || 0;
    const cz = Number(studioThree?.controls?.target?.z) || 0;
    const x1 = cx - halfSpan;
    const z1 = cz - halfSpan * 0.35;
    const x2 = cx + halfSpan;
    const z2 = cz + halfSpan * 0.35;
    const s1 = sampleStudioMeshElevationAtLocalXZ(x1, z1, 0, targets);
    const s2 = sampleStudioMeshElevationAtLocalXZ(x2, z2, 0, targets);
    return [new THREE.Vector3(x1, s1.y, z1), new THREE.Vector3(x2, s2.y, z2)];
  }

  function clearProfileVisualsOnly() {
    if (studioThree && studioThree.overlayGroup) {
      const toRemove = [];
      studioThree.overlayGroup.children.forEach((c) => {
        if (c.userData && (c.userData.isProfileVisual || c.userData.isProfileHover)) toRemove.push(c);
      });
      toRemove.forEach((c) => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
        studioThree.overlayGroup.remove(c);
      });
    }
    STATE.badges2D = STATE.badges2D.filter((b) => {
      if (b.isProfile) {
        b.el?.remove();
        return false;
      }
      return true;
    });
  }

  function setProfileHoverMarker3D(sample = null) {
    if (!studioThree || !studioThree.overlayGroup) return;
    const toRemove = [];
    studioThree.overlayGroup.children.forEach((c) => {
      if (c.userData && c.userData.isProfileHover) toRemove.push(c);
    });
    toRemove.forEach((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
      studioThree.overlayGroup.remove(c);
    });
    if (!sample || !Number.isFinite(sample.local_x) || !Number.isFinite(sample.local_z)) return;
    const pos = new THREE.Vector3(Number(sample.local_x), Number(sample.local_y || 0) + 0.04, Number(sample.local_z));
    add3DPinMarker(pos, 0xf59e0b, studioThree.overlayGroup, (m) => {
      m.userData.isProfileHover = true;
      studioThree.overlayGroup.add(m);
    });
  }

  function drawProfileSectionLine3D(p1, p2, samples = null) {
    if (!studioThree || !studioThree.overlayGroup) return;
    clearProfileVisualsOnly();
    if (!p1) return;

    const addProfObj = (m) => {
      m.userData.isProfileVisual = true;
      studioThree.overlayGroup.add(m);
    };

    add3DPinMarker(p1, 0xff3b30, studioThree.overlayGroup, addProfObj);
    add2DBadge(p1, `Section A`, "#ff3b30", { offsetY: -18, isProfile: true });

    if (!p2) {
      updateZoomInvariantElements();
      return;
    }

    add3DPinMarker(p2, 0x0284c7, studioThree.overlayGroup, addProfObj);
    const distM = p1.distanceTo(p2);
    add2DBadge(p2, `Section B (${distM.toFixed(2)}m)`, "#0284c7", { offsetY: -18, isProfile: true });

    // Draw surface-draped 3D profile polyline + straight chord line
    const chordGeo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
    const chordLine = new THREE.Line(
      chordGeo,
      new THREE.LineBasicMaterial({ color: 0x64748b, linewidth: 1.5, depthTest: false, transparent: true, opacity: 0.7 })
    );
    chordLine.renderOrder = 1000;
    addProfObj(chordLine);

    if (Array.isArray(samples) && samples.length >= 2) {
      const surfacePts = samples.map(
        (s) => new THREE.Vector3(Number(s.local_x || 0), Number(s.local_y || 0) + 0.03, Number(s.local_z || 0))
      );
      const surfGeo = new THREE.BufferGeometry().setFromPoints(surfacePts);
      const surfLine = new THREE.Line(
        surfGeo,
        new THREE.LineBasicMaterial({ color: 0x0084ff, linewidth: 2.5, depthTest: false })
      );
      surfLine.renderOrder = 1001;
      addProfObj(surfLine);
    } else {
      const lineGeom = new THREE.BufferGeometry().setFromPoints([p1, p2]);
      const lineMesh = new THREE.Line(
        lineGeom,
        new THREE.LineBasicMaterial({ color: 0x0284c7, linewidth: 2, depthTest: false })
      );
      lineMesh.renderOrder = 1001;
      addProfObj(lineMesh);
    }

    updateZoomInvariantElements();
  }

  function computeClientMeshProfile(p1Local, p2Local) {
    const activeScan = STATE.activeScan || STATE.scans.find((s) => s.scan_id === STATE.activeScanId) || {
      scan_id: STATE.activeScanId || "scan",
      name: STATE.activeScanId || "Active Scan",
      twd97_e: 304952.656,
      twd97_n: 2757084.875,
      twd97_h: 43.18,
    };
    const ce = Number(activeScan.twd97_e || 304952.656);
    const cn = Number(activeScan.twd97_n || 2757084.875);
    const ch = Number(activeScan.twd97_h || 43.18);

    const [p1, p2] =
      p1Local && p2Local
        ? [p1Local, p2Local]
        : STATE.profileEndpoints && STATE.profileEndpoints.length >= 2
        ? STATE.profileEndpoints
        : getDefaultProfileEndpointsOnStudioMesh();

    const targets = getStudioRaycastMeshes();
    const totalLen = Math.max(0.25, Math.hypot(p2.x - p1.x, p2.z - p1.z));
    const numSamples = 60;
    const stepM = totalLen / numSamples;

    const sStart = sampleStudioMeshElevationAtLocalXZ(p1.x, p1.z, p1.y, targets);
    const sEnd = sampleStudioMeshElevationAtLocalXZ(p2.x, p2.z, p2.y, targets);
    const yStart = sStart.hit ? sStart.y : p1.y;
    const yEnd = sEnd.hit ? sEnd.y : p2.y;

    const samples = [];
    let maxSlopePct = 0;
    let prevH = null;
    let hitCount = 0;

    for (let i = 0; i <= numSamples; i++) {
      const t = i / numSamples;
      const lx = p1.x + t * (p2.x - p1.x);
      const lz = p1.z + t * (p2.z - p1.z);
      const chordLocalY = yStart + t * (yEnd - yStart);
      const sHit = sampleStudioMeshElevationAtLocalXZ(lx, lz, chordLocalY, targets);
      if (sHit.hit) hitCount++;
      const surfLocalY = sHit.hit ? sHit.y : chordLocalY;

      const elevH = ch + surfLocalY;
      const baseH = ch + chordLocalY;
      const chainage = Number((t * totalLen).toFixed(2));

      let slopePct = 0;
      if (prevH !== null && stepM > 1e-4) {
        slopePct = Number(((Math.abs(elevH - prevH) / stepM) * 100).toFixed(1));
        if (slopePct > maxSlopePct) maxSlopePct = slopePct;
      }
      prevH = elevH;

      samples.push({
        chainage_m: chainage,
        easting_m: Number((ce + lx).toFixed(3)),
        northing_m: Number((cn - lz).toFixed(3)),
        elevation_m: Number(elevH.toFixed(3)),
        baseline_elevation_m: Number(baseH.toFixed(3)),
        delta_z_m: Number((elevH - baseH).toFixed(3)),
        slope_pct: slopePct,
        local_x: Number(lx.toFixed(3)),
        local_y: Number(surfLocalY.toFixed(3)),
        local_z: Number(lz.toFixed(3)),
      });
    }

    return {
      status: "ok",
      scan_id: activeScan.scan_id,
      compare_scan_name: "Chord Grade Datum (A→B)",
      crs: "TWD97 (121) + TWVD2001",
      total_length_m: Number(totalLen.toFixed(2)),
      max_slope_pct: Number(maxSlopePct.toFixed(1)),
      start_twd97: [Number((ce + p1.x).toFixed(3)), Number((cn - p1.z).toFixed(3)), Number((ch + yStart).toFixed(3))],
      end_twd97: [Number((ce + p2.x).toFixed(3)), Number((cn - p2.z).toFixed(3)), Number((ch + yEnd).toFixed(3))],
      samples,
      hit_ratio: hitCount / Math.max(1, numSamples + 1),
      _p1Local: p1,
      _p2Local: p2,
    };
  }

  async function openProfileInspector(p1 = null, p2 = null) {
    setActiveStudioTool("profile");
    if (p1 && p2) {
      STATE.profileEndpoints = [p1.clone(), p2.clone()];
    }
    const resolveEndpoints = () => {
      if (p1 && p2) return [p1, p2];
      if (STATE.profileEndpoints && STATE.profileEndpoints.length >= 2) return STATE.profileEndpoints;
      const def = getDefaultProfileEndpointsOnStudioMesh();
      STATE.profileEndpoints = def;
      return def;
    };

    showSidePanel(
      `<span>Cross-Section Profile</span>`,
      `
      <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:7px;padding:7px 9px;margin-bottom:8px;line-height:1.4;">
        Click <b>2 points (Section A &rarr; B)</b> on the 3D scan to sample TWVD2001 elevation &amp; slope along your custom section line. Hover over the chart to inspect any chainage station in 2D &amp; 3D.
      </div>
      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <button type="button" class="gs-top-btn accent" style="flex:1.4;justify-content:center;" id="btnComputeProfileNow" title="Compute / Resample Cross-Section Profile">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
          <span id="lblComputeProfileBtn">Compute Profile</span>
        </button>
        <button type="button" class="gs-top-btn" style="flex:1;justify-content:center;" id="btnNewProfileLine" title="Pick New Section A &rarr; B Line on 3D Scan">
          <span>New A&ndash;B Line</span>
        </button>
        <button type="button" class="gs-top-btn" style="flex:0.8;justify-content:center;" id="btnExportProfileCsv" title="Export Cross-Section CSV">
          <span>CSV</span>
        </button>
      </div>
      <div id="profileHoverReadout" style="font-size:11px;font-family:var(--font-mono);color:var(--ui-text-primary);background:var(--ui-bg-subtle);border:1px solid var(--ui-border);border-radius:6px;padding:5px 8px;margin-bottom:6px;display:flex;justify-content:space-between;">
        <span>Hover chart to inspect station</span>
        <span style="color:var(--ui-accent);">TWVD2001 (m)</span>
      </div>
      <canvas id="profileChartCanvas" width="336" height="196" style="width:100%;height:196px;background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);border-radius:8px;cursor:crosshair;"></canvas>
      <div class="gs-metric-grid" id="profileMetricsBox" style="margin-top:8px;"></div>
      `
    );

    const runProfileCalc = async () => {
      const btnLbl = document.getElementById("lblComputeProfileBtn");
      if (btnLbl) btnLbl.textContent = "Sampling...";
      const [ep1, ep2] = resolveEndpoints();

      // 1. Immediate client-side 3D mesh raycast profile sampling (anchored 100% to live Three.js mesh)
      const clientRes = computeClientMeshProfile(ep1, ep2);
      STATE.lastProfileResult = clientRes;
      drawProfileSectionLine3D(ep1, ep2, clientRes.samples);
      drawProfileCanvas(clientRes);

      // 2. Also query backend DSM for multi-epoch baseline comparison
      try {
        const t1 = localToTwd97(ep1);
        const t2 = localToTwd97(ep2);
        const srvRes = await apiPost("/api/survey/profile", {
          scan_id: STATE.activeScanId,
          start_point: [t1.e, t1.n],
          end_point: [t2.e, t2.n],
          start_pt: [t1.e, t1.n],
          end_pt: [t2.e, t2.n],
        });
        if (srvRes && Array.isArray(srvRes.samples) && srvRes.samples.length > 0) {
          let finalRes;
          if (clientRes.hit_ratio > 0) {
            // Keep mesh-exact 3D surface coordinates so the 3D section line sits flush on the Three.js mesh
            finalRes = {
              ...srvRes,
              ...clientRes,
              compare_scan_name:
                srvRes.compare_scan_name && srvRes.compare_scan_name !== "Linear Grade Datum"
                  ? srvRes.compare_scan_name
                  : clientRes.compare_scan_name,
            };
          } else {
            // Align backend local_y to ep1/ep2 so 3D polyline connects to endpoint pins
            const srvY0 = Number(srvRes.samples[0]?.local_y || 0);
            const yShift = ep1.y - srvY0;
            const alignedSamples = srvRes.samples.map((s) => ({
              ...s,
              local_y: Number((Number(s.local_y || 0) + yShift).toFixed(3)),
            }));
            finalRes = {
              ...clientRes,
              ...srvRes,
              samples: alignedSamples,
              _p1Local: ep1,
              _p2Local: ep2,
            };
          }
          STATE.lastProfileResult = finalRes;
          drawProfileSectionLine3D(ep1, ep2, finalRes.samples);
          drawProfileCanvas(finalRes);
        }
      } catch (_) {
        // Client-side 3D mesh raycast profile is already drawn
      } finally {
        if (btnLbl) btnLbl.textContent = "Compute Profile";
      }
    };

    document.getElementById("btnComputeProfileNow")?.addEventListener("click", () => {
      runProfileCalc().then(() => {
        const r = STATE.lastProfileResult;
        if (r) showToast(`Sampled Cross-Section Profile (${r.total_length_m} m, Max Grade ${r.max_slope_pct}%)`);
      });
    });

    document.getElementById("btnNewProfileLine")?.addEventListener("click", () => {
      setActiveStudioTool("profile");
      STATE.measurePoints = [];
      STATE.profileEndpoints = [];
      clearProfileVisualsOnly();
      showToast("Click Start Point A and End Point B on the 3D scan");
    });

    document.getElementById("btnExportProfileCsv")?.addEventListener("click", () => {
      const r = STATE.lastProfileResult;
      if (!r || !Array.isArray(r.samples) || !r.samples.length) return;
      const lines = [
        "Chainage (m),TWD97 Easting E (m),TWD97 Northing N (m),TWVD2001 Elevation H (m),Datum/Baseline H (m),Delta Z (m),Local Grade (%)",
        ...r.samples.map(
          (s) =>
            `${s.chainage_m},${s.easting_m},${s.northing_m},${s.elevation_m},${s.baseline_elevation_m},${s.delta_z_m},${s.slope_pct}`
        ),
      ];
      const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `cross_section_profile_${STATE.activeScanId || "scan"}.csv`;
      a.click();
      showToast("Downloaded Cross-Section Profile CSV");
    });

    const canvas = document.getElementById("profileChartCanvas");
    if (canvas) {
      canvas.addEventListener("mousemove", (ev) => {
        const r = STATE.lastProfileResult;
        if (!r || !Array.isArray(r.samples) || !r.samples.length) return;
        const rect = canvas.getBoundingClientRect();
        const cssW = Math.max(1, rect.width || 336);
        const relX = ((ev.clientX - rect.left) / cssW) * 336;
        const padL = 44;
        const padR = 14;
        const frac = Math.max(0, Math.min(1, (relX - padL) / Math.max(1, 336 - padL - padR)));
        const idx = Math.round(frac * (r.samples.length - 1));
        drawProfileCanvas(r, idx);
        setProfileHoverMarker3D(r.samples[idx]);
      });
      canvas.addEventListener("mouseleave", () => {
        if (STATE.lastProfileResult) drawProfileCanvas(STATE.lastProfileResult, null);
        setProfileHoverMarker3D(null);
      });
    }

    await runProfileCalc();
  }

  function drawProfileCanvas(res, hoverIdx = null) {
    const canvas = document.getElementById("profileChartCanvas");
    if (!canvas || !res) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = 336;
    const h = 196;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const samples = res.samples || [];
    if (!samples.length) {
      ctx.restore();
      return;
    }

    const isDark = STATE.resolvedTheme === "dark";
    const rawMinZ = Math.min(...samples.map((s) => Math.min(s.elevation_m, s.baseline_elevation_m)));
    const rawMaxZ = Math.max(...samples.map((s) => Math.max(s.elevation_m, s.baseline_elevation_m)));
    const zSpan = Math.max(rawMaxZ - rawMinZ, 0.4);
    const minZ = rawMinZ - zSpan * 0.18;
    const maxZ = rawMaxZ + zSpan * 0.22;
    const maxChain = Math.max(0.1, samples[samples.length - 1].chainage_m || res.total_length_m || 1);

    const padL = 44;
    const padR = 14;
    const padT = 22;
    const padB = 26;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const toXY = (chain, z) => {
      const x = padL + (chain / maxChain) * plotW;
      const y = padT + plotH - ((z - minZ) / Math.max(maxZ - minZ, 1e-4)) * plotH;
      return [x, y];
    };

    // 1. Horizontal Elevation Grid & Y-Axis Labels (TWVD2001 m)
    ctx.font = "10px monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const frac = i / 4;
      const zVal = minZ + frac * (maxZ - minZ);
      const y = padT + plotH - frac * plotH;
      ctx.strokeStyle = isDark ? "rgba(148,163,184,0.16)" : "rgba(15,23,42,0.10)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.fillStyle = isDark ? "#94a3b8" : "#475569";
      ctx.fillText(`${zVal.toFixed(1)}m`, padL - 4, y);
    }

    // 2. Vertical Chainage Grid & X-Axis Labels
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let i = 0; i <= 4; i++) {
      const frac = i / 4;
      const cVal = frac * maxChain;
      const x = padL + frac * plotW;
      ctx.strokeStyle = isDark ? "rgba(148,163,184,0.12)" : "rgba(15,23,42,0.07)";
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillStyle = isDark ? "#94a3b8" : "#475569";
      ctx.fillText(`${cVal.toFixed(1)}m`, x, padT + plotH + 6);
    }

    // 3. Separate Fill (Cyan-Blue) vs Cut (Coral-Red) Shaded Segment Ribbons
    for (let i = 0; i < samples.length - 1; i++) {
      const s0 = samples[i];
      const s1 = samples[i + 1];
      const [x0, ys0] = toXY(s0.chainage_m, s0.elevation_m);
      const [, yb0] = toXY(s0.chainage_m, s0.baseline_elevation_m);
      const [x1, ys1] = toXY(s1.chainage_m, s1.elevation_m);
      const [, yb1] = toXY(s1.chainage_m, s1.baseline_elevation_m);
      const meanDz = 0.5 * ((s0.elevation_m - s0.baseline_elevation_m) + (s1.elevation_m - s1.baseline_elevation_m));
      ctx.fillStyle = meanDz >= 0 ? "rgba(14, 165, 233, 0.24)" : "rgba(239, 68, 68, 0.22)";
      ctx.beginPath();
      ctx.moveTo(x0, ys0);
      ctx.lineTo(x1, ys1);
      ctx.lineTo(x1, yb1);
      ctx.lineTo(x0, yb0);
      ctx.closePath();
      ctx.fill();
    }

    // 4. Baseline / Chord Datum Curve (dashed slate)
    ctx.strokeStyle = isDark ? "#94a3b8" : "#64748b";
    ctx.lineWidth = 1.6;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    samples.forEach((s, idx) => {
      const [x, y] = toXY(s.chainage_m, s.baseline_elevation_m);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    // 5. Active Scan Elevation Curve (solid cyan/blue)
    ctx.strokeStyle = "#0084ff";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    samples.forEach((s, idx) => {
      const [x, y] = toXY(s.chainage_m, s.elevation_m);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 6. Start Point A (Red) & End Point B (Blue) Endpoint Dots
    const [ax, ay] = toXY(samples[0].chainage_m, samples[0].elevation_m);
    const [bx, by] = toXY(samples[samples.length - 1].chainage_m, samples[samples.length - 1].elevation_m);
    ctx.fillStyle = "#ff3b30";
    ctx.beginPath();
    ctx.arc(ax, ay, 4.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#0084ff";
    ctx.beginPath();
    ctx.arc(bx, by, 4.2, 0, Math.PI * 2);
    ctx.fill();

    // 7. Top Legend Header
    ctx.font = "bold 9.5px Inter, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#0084ff";
    ctx.fillText("● Surface (TWVD2001)", padL, 10);
    ctx.fillStyle = "#0ea5e9";
    ctx.fillText("■ Fill", padL + 118, 10);
    ctx.fillStyle = "#ef4444";
    ctx.fillText("■ Cut", padL + 152, 10);
    ctx.fillStyle = isDark ? "#94a3b8" : "#64748b";
    ctx.fillText(`--- ${res.compare_scan_name || "Datum"}`, padL + 186, 10);

    // 8. Interactive Hover Crosshair & Readout
    const readoutEl = document.getElementById("profileHoverReadout");
    if (hoverIdx !== null && samples[hoverIdx]) {
      const hs = samples[hoverIdx];
      const [hx, hy] = toXY(hs.chainage_m, hs.elevation_m);
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, padT + plotH);
      ctx.stroke();
      ctx.fillStyle = "#f59e0b";
      ctx.beginPath();
      ctx.arc(hx, hy, 4.5, 0, Math.PI * 2);
      ctx.fill();
      if (readoutEl) {
        readoutEl.innerHTML = `<span>Sta <b>${hs.chainage_m.toFixed(2)}m</b> · Grade <b>${hs.slope_pct}%</b></span><span style="color:var(--ui-accent);">H: <b>+${hs.elevation_m.toFixed(2)}m</b> (ΔZ ${hs.delta_z_m >= 0 ? "+" : ""}${hs.delta_z_m.toFixed(2)}m)</span>`;
      }
    } else if (readoutEl) {
      readoutEl.innerHTML = `<span>A: <b>+${samples[0].elevation_m.toFixed(2)}m</b> &rarr; B: <b>+${samples[samples.length - 1].elevation_m.toFixed(2)}m</b></span><span style="color:var(--ui-accent);">ΔH: <b>${(samples[samples.length - 1].elevation_m - samples[0].elevation_m >= 0 ? "+" : "") + (samples[samples.length - 1].elevation_m - samples[0].elevation_m).toFixed(2)}m</b></span>`;
    }
    ctx.restore();

    const maxAbsDz = Math.max(...samples.map((s) => Math.abs(s.delta_z_m || 0)));
    const mBox = document.getElementById("profileMetricsBox");
    if (mBox) {
      mBox.innerHTML = `
        <div class="gs-metric-box">
          <div class="lbl">Section Length</div>
          <div class="val" style="color:var(--ui-accent);">${res.total_length_m} m</div>
        </div>
        <div class="gs-metric-box">
          <div class="lbl">Max Local Grade</div>
          <div class="val">${res.max_slope_pct}%</div>
        </div>
        <div class="gs-metric-box">
          <div class="lbl">Elev Range (H)</div>
          <div class="val">+${rawMinZ.toFixed(2)}~+${rawMaxZ.toFixed(2)}m</div>
        </div>
        <div class="gs-metric-box">
          <div class="lbl">Max Relief ΔZ</div>
          <div class="val">${maxAbsDz.toFixed(2)} m</div>
        </div>
      `;
    }
  }

  // 3D. RTK Raw Camera Photo Inspector
  async function openRtkPhotoInspector(pt = new THREE.Vector3(0, 0, 0)) {
    showSidePanel(
      `<span>RTK Camera Inspector</span>`,
      `<div style="font-size:12px;color:var(--ui-text-secondary);">Querying calibrated PIX4Dcatch RTK camera poses...</div>`
    );
    try {
      const res = await apiPost("/api/survey/inspect-photos", {
        scan_id: STATE.activeScanId,
        x: pt.x,
        y: pt.y,
        z: pt.z,
      });
      const photosHtml = (res.photos || [])
        .map(
          (p) => `
          <div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border);border-radius:8px;padding:8px;margin-top:8px;">
            <img src="${p.url}" alt="${p.filename}" style="width:100%;height:140px;object-fit:cover;border-radius:6px;background:var(--ui-bg-pill);" onerror="this.style.display='none'" />
            <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:11px;font-weight:700;color:var(--ui-text-primary);">
              <span>${p.filename}</span>
              <span style="color:var(--ui-accent);">RTK σ=${p.rtk_h_sigma_cm}cm</span>
            </div>
            <div style="font-size:10.5px;font-family:monospace;color:var(--ui-text-muted);margin-top:2px;">
              E:${p.camera_twd97_e}m | N:${p.camera_twd97_n}m | H:+${p.camera_twd97_h}m | Dist:${p.distance_m}m
            </div>
          </div>
        `
        )
        .join("");

      showSidePanel(
        `<span>RTK Camera Inspector</span>`,
        `
        <div style="font-size:11px;font-family:monospace;color:var(--ui-text-secondary);margin-bottom:6px;">
          Target TWD97: E:${res.target_twd97.e}m, N:${res.target_twd97.n}m, H:+${res.target_twd97.h}m
        </div>
        ${photosHtml || '<div style="font-size:12px;color:var(--ui-text-muted);">No local raw photos found for this point.</div>'}
        `
      );
    } catch (err) {
      showToast(`Photo Inspector Error: ${err.message}`);
    }
  }

  // 3E. Section Box Clipping Inspector
  function openSectionBoxInspector() {
    showSidePanel(
      `<span>Section Box Slicer</span>`,
      `
      <div class="gs-form-group">
        <label>East-West Clipping Bound (±X m)</label>
        <input type="range" min="5" max="80" value="65" class="gs-input" id="secClipX" />
      </div>
      <div class="gs-form-group">
        <label>Elevation Clipping Bound (+Y TWVD2001 m)</label>
        <input type="range" min="-5" max="40" value="30" class="gs-input" id="secClipY" />
      </div>
      <div class="gs-form-group">
        <label>North-South Clipping Bound (±Z m)</label>
        <input type="range" min="5" max="80" value="65" class="gs-input" id="secClipZ" />
      </div>
      <button type="button" class="btn-xs" id="btnResetSectionBox" style="width:100%;" title="Reset Clipping Planes">Reset</button>
      `
    );

    const updateClip = () => {
      if (!studioThree) return;
      const cx = parseFloat(document.getElementById("secClipX")?.value || "65");
      const cy = parseFloat(document.getElementById("secClipY")?.value || "30");
      const cz = parseFloat(document.getElementById("secClipZ")?.value || "65");
      studioThree.renderer.clippingPlanes = [
        new THREE.Plane(new THREE.Vector3(-1, 0, 0), cx),
        new THREE.Plane(new THREE.Vector3(1, 0, 0), cx),
        new THREE.Plane(new THREE.Vector3(0, -1, 0), cy),
        new THREE.Plane(new THREE.Vector3(0, 0, -1), cz),
        new THREE.Plane(new THREE.Vector3(0, 0, 1), cz),
      ];
    };

    ["secClipX", "secClipY", "secClipZ"].forEach((id) => {
      document.getElementById(id)?.addEventListener("input", updateClip);
    });
    document.getElementById("btnResetSectionBox")?.addEventListener("click", () => {
      if (studioThree) studioThree.renderer.clippingPlanes = [];
      showToast("Section Box clipping reset");
    });
  }

  // 3F. 3D Geo-Comments Inspector
  async function openCommentsInspector(clickedPt = null, clickedTwd = null) {
    setActiveStudioTool("comments");
    const detail = await apiGet(`/api/scans/${STATE.activeScanId}`);
    const scan = detail.scan;
    const comments = scan.comments || [];

    const pt = clickedPt || new THREE.Vector3(0, 1.2, 0);
    const twd = clickedTwd || localToTwd97(pt);

    const listHtml = comments
      .map(
        (c) => `
        <div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border);border-radius:8px;padding:9px;margin-top:8px;">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ui-accent);font-weight:700;">
            <span>${escapeHtml(c.author_name)}</span>
            <span style="color:var(--ui-text-muted);font-weight:500;">${escapeHtml((c.created_at || "").slice(0, 16))}</span>
          </div>
          <div style="font-size:12px;color:var(--ui-text-primary);margin-top:4px;">${escapeHtml(c.text)}</div>
          <div style="font-size:10.5px;font-family:monospace;color:var(--ui-text-muted);margin-top:4px;">
            TWD97 E:${Number(c.twd97_e).toFixed(1)}m, N:${Number(c.twd97_n).toFixed(1)}m, H:+${Number(c.twd97_h).toFixed(2)}m
          </div>
        </div>
      `
      )
      .join("");

    showSidePanel(
      `<span>3D Geo-Comments (${comments.length})</span>`,
      `
      <div class="gs-form-group">
        <label>Pin Coordinate: E:${twd.e}m, N:${twd.n}m, H:+${twd.h}m</label>
        <textarea class="gs-input" id="txtNewComment" rows="2" placeholder="Leave an engineering observation..."></textarea>
      </div>
      <button type="button" class="gs-top-btn accent" style="width:100%;justify-content:center;margin-bottom:8px;" id="btnSubmitComment" title="Post 3D Comment Pin">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <span>Post</span>
      </button>
      <div id="commentsListBox">${listHtml}</div>
      `
    );

    document.getElementById("btnSubmitComment")?.addEventListener("click", async () => {
      const text = document.getElementById("txtNewComment")?.value.trim();
      if (!text) return;
      try {
        await apiPost("/api/comments", {
          scan_id: STATE.activeScanId,
          author_email: STATE.currentUser?.email || "guest@gatheren.cloud",
          author_name: STATE.currentUser?.name || "Guest Viewer",
          text,
          pos_x: pt.x,
          pos_y: pt.y,
          pos_z: pt.z,
          twd97_e: twd.e,
          twd97_n: twd.n,
          twd97_h: twd.h,
        });
        showToast("Posted 3D geo-referenced comment");
        await refreshScansCatalog();
        openCommentsInspector(pt, twd);
      } catch (err) {
        showToast(`Comment Error: ${err.message}`);
      }
    });
  }

  function renderCommentPins3D() {
    if (!studioThree) return;
    while (studioThree.commentPinsGroup.children.length > 0) {
      studioThree.commentPinsGroup.remove(studioThree.commentPinsGroup.children[0]);
    }
    const scan = STATE.activeScan;
    if (!scan || !scan.comments) return;
    scan.comments.forEach((c) => {
      add3DPinMarker(
        new THREE.Vector3(c.pos_x || 0, (c.pos_y || 0) + 0.15, c.pos_z || 0),
        0x0284c7,
        studioThree.commentPinsGroup
      );
    });
  }

  // 3G. GC_ScanOptimizer PC Action Drawer (Requirement 3)
  function openOptimizerInspector() {
    showSidePanel(
      `<span>GC_ScanOptimizer PC Actions</span>`,
      `
      <p style="font-size:11.5px;color:var(--ui-text-secondary);margin-bottom:10px;">
        Invokes <code>c:\\Antigravity\\GC_ScanOptimizer</code> directly on the Windows workstation with a 2K texture limit.
      </p>
      <div class="gs-form-group">
        <label>Optimization Preset (壓縮與串流預設)</label>
        <select class="gs-select" id="optPresetSelect">
          <option value="balanced" selected>Balanced Web Stream (50% Tris, 2K KTX2)</option>
          <option value="quality">High Fidelity Quality (75% Tris, 2K KTX2)</option>
          <option value="web">Fast Field Tablet (35% Tris, 1K KTX2)</option>
          <option value="ultra_light">Ultra-Light Browser Offline Cache (20% Tris)</option>
        </select>
      </div>
      <button type="button" class="gs-top-btn accent" style="width:100%;justify-content:center;margin-bottom:12px;" id="btnExecuteOptimize" title="Run Preset Optimization on PC">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
        </svg>
        <span>Optimize</span>
      </button>

      <div style="border-top:1px solid var(--ui-border);padding-top:12px;margin-top:6px;">
        <div class="gs-form-group">
          <label>Spatial 3D Polygon &amp; Elevation Cutter (空間多邊形裁切)</label>
          <select class="gs-select" id="optCropMode">
            <option value="keep_inside">Keep Inside Polygon (保留框選範圍內)</option>
            <option value="delete_inside">Prune Inside Polygon (移除框選範圍內雜物)</option>
          </select>
        </div>
        <button type="button" class="gs-top-btn" style="width:100%;justify-content:center;" id="btnExecuteCrop" title="Execute SpatialCutter on PC">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
            <circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/>
          </svg>
          <span>Crop</span>
        </button>
      </div>
      <div id="optActionResult" style="margin-top:12px;"></div>
      `
    );

    document.getElementById("btnExecuteOptimize")?.addEventListener("click", async () => {
      const preset = document.getElementById("optPresetSelect")?.value || "balanced";
      const box = document.getElementById("optActionResult");
      if (box) box.innerHTML = `<div style="font-size:12px;color:var(--ui-accent);">Running GC_ScanOptimizer (${preset}) on real .GLB tiles...</div>`;
      try {
        const res = await apiPost("/api/optimizer/optimize", {
          scan_id: STATE.activeScanId,
          preset,
        });
        if (box) {
          box.innerHTML = `
            <div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);border-radius:8px;padding:10px;font-size:12px;color:var(--ui-text-primary);">
              <div style="color:var(--ui-accent);font-weight:700;">GC_ScanOptimizer Completed (${res.duration_s}s)</div>
              <div style="margin-top:4px;">Preset: <b>${res.preset}</b> (Max Texture: ${res.texture_limit}px · ${res.tiles_processed || 0} tiles)</div>
              <div>Size: ${res.original_mb} MB → <b>${res.compressed_mb} MB (-${res.reduction_pct}%)</b></div>
              <div style="font-size:10.5px;color:var(--ui-text-muted);margin-top:3px;">Output: ${res.output_dir || ""}</div>
            </div>
          `;
        }
        showToast(`GC_ScanOptimizer finished: -${res.reduction_pct}% size reduction`);
      } catch (err) {
        showToast(`Optimizer Error: ${err.message}`);
      }
    });

    document.getElementById("btnExecuteCrop")?.addEventListener("click", async () => {
      const mode = document.getElementById("optCropMode")?.value || "keep_inside";
      const box = document.getElementById("optActionResult");
      if (box) box.innerHTML = `<div style="font-size:12px;color:var(--ui-accent);">Running SpatialCutter (${mode}) on real 3D mesh tiles...</div>`;
      const activePolyPts =
        STATE.maskBoundaryPoints && STATE.maskBoundaryPoints.length >= 3
          ? STATE.maskBoundaryPoints
          : STATE.measurePoints && STATE.measurePoints.length >= 3
          ? STATE.measurePoints
          : null;
      const polyPayload = activePolyPts
        ? activePolyPts.map((p) => {
            const t = localToTwd97(p);
            return [t.e, t.n];
          })
        : [[-15, -15], [15, -15], [15, 15], [-15, 15]];
      try {
        const res = await apiPost("/api/optimizer/crop", {
          scan_id: STATE.activeScanId,
          mode,
          polygon: polyPayload,
        });
        if (box) {
          box.innerHTML = `
            <div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);border-radius:8px;padding:10px;font-size:12px;color:var(--ui-text-primary);">
              <div style="color:var(--ui-accent);font-weight:700;">SpatialCutter Completed (${res.duration_s}s)</div>
              <div>Mode: <b>${res.mode}</b> · Area: <b>${res.cropped_area_m2} m²</b></div>
              <div>Tiles Sliced: <b>${res.tiles_sliced || 0}</b> · Pruned: <b>${res.tiles_pruned || 0}</b></div>
              <div style="font-size:10.5px;color:var(--ui-text-muted);">Output: ${res.output_dir}</div>
            </div>
          `;
        }
        showToast("SpatialCutter polygon crop completed on PC");
      } catch (err) {
        showToast(`Crop Error: ${err.message}`);
      }
    });
  }

  // Toolbar Button Wiring
  document.querySelectorAll("#bimMeasurementToolbar .autodesk-measure-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tool = btn.dataset.tool;
      if (tool === "snap") {
        STATE.snapEnabled = !STATE.snapEnabled;
        btn.classList.toggle("active", STATE.snapEnabled);
        showToast(`Snapping ${STATE.snapEnabled ? "Enabled" : "Disabled"}`);
        return;
      }

      setActiveStudioTool(tool);
      STATE.measurePoints = [];

      if (tool === "volume") openCutFillVolumeInspector();
      else if (tool === "contours") openContoursInspector();
      else if (tool === "profile") openProfileInspector();
      else if (tool === "photos") openRtkPhotoInspector();
    });
  });

  document.getElementById("btnMeasureClear")?.addEventListener("click", () => {
    clearMeasurements();
    if (studioThree) {
      while (studioThree.contourGroup.children.length > 0) {
        studioThree.contourGroup.remove(studioThree.contourGroup.children[0]);
      }
    }
    showToast("Cleared 3D measurements & overlays");
  });

  document.querySelectorAll("#bimBottomDock .bim-dock-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dock = btn.dataset.dock;
      if (dock === "volume") openCutFillVolumeInspector();
      else if (dock === "contours") openContoursInspector();
      else if (dock === "section") {
        document.querySelectorAll("#bimBottomDock .bim-dock-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        openSectionBoxInspector();
      } else if (dock === "comments") openCommentsInspector();
      else if (dock === "optimizer") {
        document.querySelectorAll("#bimBottomDock .bim-dock-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        openOptimizerInspector();
      }
    });
  });

  document.getElementById("btnOpenOptimizer")?.addEventListener("click", () => {
    if (STATE.activeView !== "studio") switchView("studio", STATE.activeScanId);
    openOptimizerInspector();
  });

  document.getElementById("btnStudioSurveyReport")?.addEventListener("click", () => {
    if (STATE.activeView !== "studio") switchView("studio", STATE.activeScanId);
    openContoursInspector();
  });

  // ============================================================================
  // 4. MULTI-DATE SIDE-BY-SIDE CURTAIN SLIDER (Requirement 4)
  // ============================================================================
  let compareCtx = null;

  // Exact calibrated reference anchors (raw tileset vertex coords -> TWD97 TM2-121 + TWVD2001 world coords)
  // Verified via 3D KD-tree nearest-neighbor mesh matching across all multi-epoch and dual-export scan pairs
  const SCAN_COMPARE_CALIBRATION = {
    catch_QuChi261016: {
      crs: "TWD97",
      rawCenter: [304891.922, 2757029.5, 38.194],
      twdCenter: [304891.922, 2757029.5, 38.194],
      rotZ: 0,
      scaleXY: 1.0,
      radius: 139.64,
    },
    QuChi261016_Trees: {
      crs: "TWD97",
      rawCenter: [304884.442, 2757008.413, 37.193],
      twdCenter: [304891.922, 2757029.5, 38.194],
      rotZ: -0.014989,
      scaleXY: 0.999862,
      radius: 139.64,
    },
    quchi_20261015_obj_mesh: {
      crs: "UTM51N",
      rawCenter: [352915.65, 2756880.45, 38.785],
      twdCenter: [304891.922, 2757029.5, 38.194],
      rotZ: 0.01396582,
      scaleXY: 1.00104762,
      radius: 139.64,
    },
    quchi_20261005_sector3: {
      crs: "TWD97",
      rawCenter: [304848.06, 2757112.34, 39.31],
      twdCenter: [304848.06, 2757112.34, 39.31],
      rotZ: 0,
      scaleXY: 1.0,
      radius: 139.64,
    },
    rosepark_20260917_east: {
      crs: "TWD97",
      rawCenter: [295979.41, 2768494.23, -112.05],
      twdCenter: [295979.41, 2768494.23, 28.54],
      rotZ: 0,
      scaleXY: 1.0,
      radius: 90.0,
    },
  };

  function classifyCompareSideCoords(side) {
    if (!side || !side.rawSphere || !(side.rawSphere.radius > 0)) return null;
    const scanId = side._loadedScanId || side.scanMeta?.scan_id || "";
    const cal = SCAN_COMPARE_CALIBRATION[scanId];
    if (cal) {
      return {
        crs: cal.crs,
        rawCenter: new THREE.Vector3(cal.rawCenter[0], cal.rawCenter[1], cal.rawCenter[2]),
        twdCenter: new THREE.Vector3(cal.twdCenter[0], cal.twdCenter[1], cal.twdCenter[2]),
        rotZ: cal.rotZ,
        scaleXY: cal.scaleXY,
        radius: cal.radius || Number(side.rawSphere.radius) || 60,
      };
    }

    const c = side.rawSphere.center;
    const meta = side.scanMeta || {};
    const radius = Number(side.rawSphere.radius) || 60;
    const metaE = Number(meta.twd97_e) || 0;
    const metaN = Number(meta.twd97_n) || 0;
    const metaH = Number(meta.twd97_h) || 0;

    // Case 1: Native TWD97 TM2-121 coordinates (150,000 <= E <= 345,000; 2,400,000 <= N <= 2,850,000)
    if (c.x >= 150000 && c.x <= 345000 && c.y >= 2400000 && c.y <= 2850000) {
      return {
        crs: "TWD97",
        rawCenter: c.clone(),
        twdCenter: c.clone(),
        rotZ: 0,
        scaleXY: 1.0,
        radius,
      };
    }

    // Case 2: UTM Zone 51N coordinates (345,000 < E <= 415,000; 2,400,000 <= N <= 2,850,000)
    if (c.x > 345000 && c.x <= 415000 && c.y >= 2400000 && c.y <= 2850000) {
      return {
        crs: "UTM51N",
        rawCenter: c.clone(),
        twdCenter: new THREE.Vector3(metaE || c.x, metaN || c.y, metaH || c.z),
        rotZ: 0.01396582, // +0.8002 deg meridian convergence from UTM51N (123E) to TWD97 TM2 (121E)
        scaleXY: 1.00104762,
        radius,
      };
    }

    // Case 3: Local / ECEF fallback
    return {
      crs: "LOCAL",
      rawCenter: c.clone(),
      twdCenter: new THREE.Vector3(metaE, metaN, Number.isFinite(c.z) && Math.abs(c.z) < 5000 ? c.z : metaH),
      rotZ: 0,
      scaleXY: 1.0,
      radius,
    };
  }

  function alignCompareSides() {
    if (!compareCtx) return;
    const left = compareCtx.left;
    const right = compareCtx.right;
    const lInfo = classifyCompareSideCoords(left);
    const rInfo = classifyCompareSideCoords(right);

    // Choose a single shared TWD97 reference anchor so both scans lock 1:1 in world space.
    // Prefer the scan with the tighter bounding radius so the camera orbits the overlapping core site area.
    let sharedAnchor = null;
    let sameVerticalDatum = true;

    if (lInfo && rInfo) {
      const bothGeoref =
        (lInfo.crs === "TWD97" || lInfo.crs === "UTM51N") &&
        (rInfo.crs === "TWD97" || rInfo.crs === "UTM51N");
      const dist2D = Math.hypot(
        lInfo.twdCenter.x - rInfo.twdCenter.x,
        lInfo.twdCenter.y - rInfo.twdCenter.y
      );
      if (bothGeoref && dist2D < 2500) {
        sharedAnchor = (rInfo.radius <= lInfo.radius ? rInfo.twdCenter : lInfo.twdCenter).clone();
        sameVerticalDatum = Math.abs(lInfo.twdCenter.z - rInfo.twdCenter.z) <= 25.0;
      }
    }

    [
      [left, lInfo],
      [right, rInfo],
    ].forEach(([side, info]) => {
      if (!side || !side.tilesRenderer || !info) return;
      // 1. Center raw tileset vertices on rawCenter for 32-bit float precision
      side.tilesRenderer.group.position.set(-info.rawCenter.x, -info.rawCenter.y, -info.rawCenter.z);
      side.tilesRenderer.group.updateMatrix();

      // 2. Apply CRS alignment offset & meridian convergence relative to sharedAnchor
      if (sharedAnchor && (info.crs === "TWD97" || info.crs === "UTM51N")) {
        const dx = info.twdCenter.x - sharedAnchor.x;
        const dy = info.twdCenter.y - sharedAnchor.y;
        const dz = sameVerticalDatum ? info.twdCenter.z - sharedAnchor.z : 0;
        side.alignGroup.position.set(dx, dy, dz);
        side.alignGroup.rotation.set(0, 0, info.rotZ);
        side.alignGroup.scale.set(info.scaleXY, info.scaleXY, 1.0);
      } else {
        side.alignGroup.position.set(0, 0, 0);
        side.alignGroup.rotation.set(0, 0, 0);
        side.alignGroup.scale.set(1, 1, 1);
      }
      side.alignGroup.updateMatrix();
      side.pivot.rotation.set(THREE.MathUtils.degToRad(270), 0, 0);
      side.pivot.updateMatrix();
      side.pivot.traverse((obj) => {
        obj.matrixWorldNeedsUpdate = true;
      });
      side.pivot.updateMatrixWorld(true);
    });

    const groundY = Math.min(
      Number(left?.rawSphere?._groundOffsetY) || -8.0,
      Number(right?.rawSphere?._groundOffsetY) || -8.0
    );
    if (left?.grid) left.grid.position.y = groundY;
    if (right?.grid) right.grid.position.y = groundY;

    // Auto-frame camera when a new scan pair finishes loading tilesets
    const pairKey = `${left._loadedScanId || ""}|${right._loadedScanId || ""}`;
    if (lInfo && rInfo && compareCtx._framedPairKey !== pairKey) {
      compareCtx._framedPairKey = pairKey;
      frameCompareCamera(false);
    }
  }

  function frameCompareCamera(showMsg = false) {
    if (!compareCtx) return;
    const { left, right, controls } = compareCtx;
    const lInfo = classifyCompareSideCoords(left);
    const rInfo = classifyCompareSideCoords(right);
    const lR = lInfo?.radius || left?.rawSphere?.radius || 0;
    const rR = rInfo?.radius || right?.rawSphere?.radius || 0;
    const baseR = lR > 0 && rR > 0 ? Math.min(lR, rR) : Math.max(lR, rR, 65);
    const r = Math.min(Math.max(baseR, 30), 220);
    left.camera.position.set(r * 0.68, r * 0.54, r * 0.78);
    controls.target.set(0, 0, 0);
    controls.update();
    left.camera.updateMatrixWorld();
    right.camera.position.copy(left.camera.position);
    right.camera.quaternion.copy(left.camera.quaternion);
    right.camera.updateProjectionMatrix();
    right.camera.updateMatrixWorld();
    if (showMsg) {
      showToast("Reset & Synced Compare Camera Framing");
    }
  }

  function setCompareMode(mode) {
    const resolvedMode = mode === "split" ? "split" : "slider";
    STATE.compareMode = resolvedMode;
    const stage = document.getElementById("compareStage");
    const rightContainer = document.getElementById("compareRightLayer");
    const divider = document.getElementById("curtainDivider");
    const lblPct = document.getElementById("lblCurtainPct");
    const pct = (compareCtx && compareCtx._curtainPct) || 50;

    if (stage) {
      stage.classList.toggle("mode-split", resolvedMode === "split");
    }
    if (rightContainer) {
      rightContainer.style.clipPath = resolvedMode === "split" ? "none" : `inset(0 0 0 ${pct}%)`;
    }
    if (divider) {
      divider.style.display = resolvedMode === "split" ? "none" : "";
    }
    if (lblPct) {
      lblPct.style.display = resolvedMode === "split" ? "none" : "";
      lblPct.textContent = `Split: ${Math.round(pct)}%`;
    }
    document.querySelectorAll("#compareModeSwitcher .btn-seg").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.compareMode === resolvedMode);
    });
    handleResize();
    requestAnimationFrame(() => handleResize());
  }

  function applyCompareElevationHeatmapToMaterial(m, active) {
    if (!m) return;
    if (!m.userData) m.userData = {};
    m.userData._elevationHeatmapActive = Boolean(active);
    m.userData._elevMin = -10.0;
    m.userData._elevMax = 22.0;
    if (m.metalness > 0) {
      m.metalness = 0.0;
      m.roughness = 1.0;
      m.side = THREE.DoubleSide;
    }
    applyBrightnessToMaterial(m, STATE.scanBrightness);
  }

  function applyCompareElevationHeatmapToSide(side, active) {
    if (!side) return;
    [side.pivot, side.fallbackGroup].forEach((grp) => {
      if (!grp) return;
      grp.traverse((c) => {
        if (c.isMesh && c.material) {
          const mats = Array.isArray(c.material) ? c.material : [c.material];
          mats.forEach((m) => applyCompareElevationHeatmapToMaterial(m, active));
        }
      });
    });
  }

  function setCompareElevationHeatmap(active) {
    if (!compareCtx) return;
    applyCompareElevationHeatmapToSide(compareCtx.left, active);
    applyCompareElevationHeatmapToSide(compareCtx.right, active);
  }

  function loadScanIntoCompareSide(side, scanId) {
    if (!side || !scanId) return;
    const scan = STATE.scans.find((s) => s.scan_id === scanId) || STATE.scans[0];
    if (!scan) return;
    if (side._loadedScanId === scan.scan_id && side.tilesRenderer) return;
    side._loadedScanId = scan.scan_id;
    side.scanMeta = scan;
    side.rawSphere = null;

    if (side.tilesRenderer) {
      try {
        side.tilesRenderer.dispose();
      } catch (_) {}
      side.tilesRenderer = null;
    }
    while (side.alignGroup.children.length > 0) {
      side.alignGroup.remove(side.alignGroup.children[0]);
    }
    if (side.fallbackGroup) side.fallbackGroup.visible = false;

    if (compareCtx) {
      compareCtx._loadingStartMs = performance.now();
      compareCtx._loadingDone = false;
      compareCtx._maxPct = 10;
      if (compareCtx._loaderHideTimer) clearTimeout(compareCtx._loaderHideTimer);
      updateScanLoader("compare", true, 12, `Loading ${scan.name}...`);
    }

    let streamUrl = scan.stream_url || "";
    if (!streamUrl || !window.TilesRenderer) {
      if (side.fallbackGroup) side.fallbackGroup.visible = true;
      return;
    }
    if (STATE.shareToken && !streamUrl.includes("share=")) {
      streamUrl += (streamUrl.includes("?") ? "&" : "?") + `share=${encodeURIComponent(STATE.shareToken)}`;
    }

    const tr = new window.TilesRenderer(streamUrl);
    tr.fetchOptions = { mode: "cors" };
    tr.preprocessURL = (uri) => {
      let u = uri;
      if (STATE.shareToken && !u.includes("share=")) {
        u += (u.includes("?") ? "&" : "?") + `share=${encodeURIComponent(STATE.shareToken)}`;
      }
      return u;
    };
    tr.setCamera(side.camera);
    tr.setResolutionFromRenderer(side.camera, side.renderer);

    const gltfLoader = new THREE.GLTFLoader(tr.manager);
    if (window.MeshoptDecoder) gltfLoader.setMeshoptDecoder(window.MeshoptDecoder);
    const ktx2 = getKTX2Loader(side.renderer);
    if (ktx2) gltfLoader.setKTX2Loader(ktx2);
    tr.manager.addHandler(/\.(gltf|glb)(\?.*)?$/i, gltfLoader);

    tr.addEventListener("load-tileset", () => {
      side._tilesetReady = true;
      if (compareCtx) {
        compareCtx._tilesetReady = true;
        compareCtx._tilesetReadyMs = performance.now();
      }
      const sphere = new THREE.Sphere();
      if (computeTilesetContentSphere(tr, sphere)) {
        side.rawSphere = sphere.clone();
        side.rawSphere._groundOffsetY = sphere._groundOffsetY;
        alignCompareSides();
      }
      side.camera.updateMatrixWorld();
      tr.update();
    });

    tr.addEventListener("load-model", (ev) => {
      if (ev && ev.scene) {
        if (side.fallbackGroup) side.fallbackGroup.visible = false;
        alignCompareSides();
        const heatmapOn = Boolean(document.getElementById("chkDeltaZHeatmap")?.checked);
        ev.scene.traverse((c) => {
          if (c.isMesh && c.material) {
            const mats = Array.isArray(c.material) ? c.material : [c.material];
            mats.forEach((m) => applyCompareElevationHeatmapToMaterial(m, heatmapOn));
          }
        });
        side.camera.updateMatrixWorld();
        tr.update();
        side.renderer.render(side.scene, side.camera);
        syncCompareLoaderProgress();
      }
    });

    tr.errorTarget = 6.0;
    if (tr.downloadQueue) tr.downloadQueue.maxJobs = 12;
    if (tr.parseQueue) tr.parseQueue.maxJobs = 6;
    side.alignGroup.add(tr.group);
    side.tilesRenderer = tr;
    side.camera.updateMatrixWorld();
    tr.update();
  }

  function syncCompareScansFromDropdowns() {
    if (!compareCtx) return;
    const lSel = document.getElementById("compareLeftSelect");
    const rSel = document.getElementById("compareRightSelect");
    const leftId = lSel?.value || STATE.scans[Math.min(1, STATE.scans.length - 1)]?.scan_id;
    const rightId = rSel?.value || STATE.scans[0]?.scan_id;
    if (leftId) loadScanIntoCompareSide(compareCtx.left, leftId);
    if (rightId) loadScanIntoCompareSide(compareCtx.right, rightId);
    alignCompareSides();
  }

  function syncCompareLoaderProgress() {
    if (!compareCtx || compareCtx._loadingDone) return;
    const lStats = compareCtx.left?.tilesRenderer?.stats || {};
    const rStats = compareCtx.right?.tilesRenderer?.stats || {};
    const loaded = Number(lStats.loaded || 0) + Number(rStats.loaded || 0);
    const activeWork =
      Number(lStats.downloading || 0) +
      Number(lStats.parsing || 0) +
      Number(rStats.downloading || 0) +
      Number(rStats.parsing || 0);
    const queued = Number(lStats.queued || 0) + Number(rStats.queued || 0);
    const pending = activeWork + queued;
    const total = Math.max(1, loaded + pending);
    const now = performance.now();
    const elapsed = now - (compareCtx._loadingStartMs || 0);
    const sinceTileset = compareCtx._tilesetReadyMs ? now - compareCtx._tilesetReadyMs : 0;

    const bothSidesHaveMesh =
      Number(lStats.loaded || 0) > 0 &&
      Number(rStats.loaded || 0) > 0 &&
      (pending === 0 || (activeWork === 0 && sinceTileset > 900) || loaded >= Math.max(2, Math.ceil(total * 0.75)));

    if (bothSidesHaveMesh && elapsed > 220) {
      finishScanLoader(compareCtx, "compare", `100% · ${loaded} 3D tiles ready`);
      return;
    }

    if (loaded > 0 || activeWork > 0 || queued > 0) {
      const timeBoost = activeWork > 0 ? Math.min(24, Math.floor(elapsed / 250)) : 0;
      const rawPct = Math.round(18 + (loaded / total) * 78) + timeBoost;
      compareCtx._maxPct = Math.min(96, Math.max(compareCtx._maxPct || 18, rawPct));
      updateScanLoader("compare", true, compareCtx._maxPct, `Streaming Compare Scans · ${loaded} / ${total} tiles`);
    } else if (sinceTileset > 12000) {
      finishScanLoader(compareCtx, "compare", "Compare Ready");
    }
  }

  function initCompareView() {
    if (compareCtx) return compareCtx;
    const leftContainer = document.getElementById("compareLeftLayer");
    const rightContainer = document.getElementById("compareRightLayer");
    if (!leftContainer || !rightContainer) return null;

    const createEpochScene = (container, tintColor, isLatest) => {
      const isDark = STATE.resolvedTheme === "dark";
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(isDark ? 0x0b1322 : 0xe2e8f0);
      const camera = new THREE.PerspectiveCamera(
        48,
        Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
        0.1,
        10000
      );
      camera.position.set(68, 54, 78);
      camera.lookAt(0, 0, 0);

      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1.0;
      container.appendChild(renderer.domElement);

      scene.add(new THREE.AmbientLight(0xffffff, 1.35));
      const dirLight = new THREE.DirectionalLight(0xffffff, 1.15);
      dirLight.position.set(45, 80, 50);
      scene.add(dirLight);
      const grid = new THREE.GridHelper(180, 36, isDark ? 0x334155 : 0x94a3b8, isDark ? 0x1e293b : 0xcbd5e1);
      scene.add(grid);

      const fallbackGroup = new THREE.Group();
      fallbackGroup.visible = false;
      scene.add(fallbackGroup);

      // Fallback Terrain + Epoch Stockpile Mesh
      const geom = new THREE.PlaneGeometry(76, 76, 72, 72);
      geom.rotateX(-Math.PI / 2);
      const pos = geom.attributes.position;
      const colors = [];
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        const r2 = (x * x + z * z) / (13.5 * 13.5);
        const r2b = ((x - 11) * (x - 11) + (z + 8) * (z + 8)) / (9.5 * 9.5);
        const peak = isLatest ? 5.6 : 1.15;
        const y =
          0.02 * x -
          0.015 * z +
          0.45 * Math.sin(x * 0.12) * Math.cos(z * 0.12) +
          (r2 < 2.8 ? peak * Math.exp(-1.45 * r2) : 0.0) +
          (r2b < 2.4 ? (isLatest ? 2.8 : 0.6) * Math.exp(-1.6 * r2b) : 0.0);
        pos.setY(i, y);
        const t = Math.min(1, Math.max(0, (y + 0.6) / 6.2));
        const shade = 0.85 + 0.15 * Math.cos(x * 0.25);
        if (isLatest) {
          colors.push((0.16 + 0.48 * t) * shade, (0.36 + 0.42 * t) * shade, (0.26 + 0.12 * t) * shade);
        } else {
          colors.push((0.20 + 0.26 * t) * shade, (0.28 + 0.28 * t) * shade, (0.38 + 0.25 * t) * shade);
        }
      }
      geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      geom.computeVertexNormals();
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geom, mat);
      fallbackGroup.add(mesh);

      const pivot = new THREE.Group();
      pivot.rotation.set(THREE.MathUtils.degToRad(270), 0, 0);
      const alignGroup = new THREE.Group();
      pivot.add(alignGroup);
      scene.add(pivot);

      return {
        container,
        scene,
        camera,
        renderer,
        grid,
        mesh,
        fallbackGroup,
        pivot,
        alignGroup,
        isLatest,
        tilesRenderer: null,
        rawSphere: null,
        scanMeta: null,
      };
    };

    const left = createEpochScene(leftContainer, 0x38bdf8, false);
    const right = createEpochScene(rightContainer, 0x10b981, true);

    // Synchronized OrbitControls on the stage
    const stage = document.getElementById("compareStage");
    const controls = new THREE.OrbitControls(left.camera, stage);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.update();
    right.camera.position.copy(left.camera.position);
    right.camera.quaternion.copy(left.camera.quaternion);
    right.camera.updateProjectionMatrix();

    // Curtain Slider Dragging — strictly isolated from OrbitControls (disables camera orbit while dragging)
    const divider = document.getElementById("curtainDivider");
    let dragging = false;

    const updateCurtainFromClientX = (clientX) => {
      if (!Number.isFinite(clientX) || STATE.compareMode === "split") return;
      const rect = stage.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      const pct = Math.max(5, Math.min(95, ((clientX - rect.left) / rect.width) * 100));
      if (compareCtx) compareCtx._curtainPct = pct;
      divider.style.left = `${pct}%`;
      rightContainer.style.clipPath = `inset(0 0 0 ${pct}%)`;
      const lbl = document.getElementById("lblCurtainPct");
      if (lbl) lbl.textContent = `Split: ${Math.round(pct)}%`;
    };

    const startCurtainDrag = (e) => {
      if (STATE.compareMode === "split") return;
      dragging = true;
      controls.enabled = false;
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
      if (e.cancelable && e.type === "touchstart") e.preventDefault();
      if (e.pointerId !== undefined && typeof divider.setPointerCapture === "function") {
        try {
          divider.setPointerCapture(e.pointerId);
        } catch (_) {}
      }
    };

    const endCurtainDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      controls.enabled = true;
      if (e && e.pointerId !== undefined && typeof divider.releasePointerCapture === "function") {
        try {
          divider.releasePointerCapture(e.pointerId);
        } catch (_) {}
      }
    };

    divider.addEventListener("pointerdown", startCurtainDrag, { passive: false });
    divider.addEventListener("mousedown", startCurtainDrag, { passive: false });
    divider.addEventListener("touchstart", startCurtainDrag, { passive: false });
    divider.addEventListener(
      "touchmove",
      (e) => {
        if (!dragging || STATE.compareMode === "split") return;
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
        if (e.touches && e.touches.length > 0) {
          updateCurtainFromClientX(e.touches[0].clientX);
        }
      },
      { passive: false }
    );

    window.addEventListener("pointerup", endCurtainDrag);
    window.addEventListener("pointercancel", endCurtainDrag);
    window.addEventListener("mouseup", endCurtainDrag);
    window.addEventListener("touchend", endCurtainDrag);
    window.addEventListener("touchcancel", endCurtainDrag);

    window.addEventListener("pointermove", (e) => {
      if (!dragging || STATE.compareMode === "split") return;
      e.stopPropagation();
      updateCurtainFromClientX(e.clientX);
    });
    window.addEventListener(
      "touchmove",
      (e) => {
        if (!dragging || STATE.compareMode === "split") return;
        if (e.cancelable) e.preventDefault();
        if (e.touches && e.touches.length > 0) {
          updateCurtainFromClientX(e.touches[0].clientX);
        }
      },
      { passive: false }
    );

    // Compare Mode Switcher (Slider Mode vs 2-Viewport Synced Camera Mode)
    document.querySelectorAll("#compareModeSwitcher .btn-seg").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.compareMode || "slider";
        setCompareMode(mode);
        showToast(
          mode === "split"
            ? "2-Viewport Mode: Full Side-by-Side Scans with Synced Camera"
            : "Slider Mode: Interactive Split Curtain Comparison"
        );
      });
    });

    document.getElementById("btnCompareResetCamera")?.addEventListener("click", () => {
      frameCompareCamera(true);
    });

    // Left / Right Scan Dropdown Listeners
    document.getElementById("compareLeftSelect")?.addEventListener("change", (e) => {
      if (e.target.value && compareCtx) {
        loadScanIntoCompareSide(compareCtx.left, e.target.value);
      }
    });
    document.getElementById("compareRightSelect")?.addEventListener("change", (e) => {
      if (e.target.value && compareCtx) {
        loadScanIntoCompareSide(compareCtx.right, e.target.value);
      }
    });

    // Z / Delta-Z Elevation Heatmap Toggle (applies to BOTH Left & Right scans and cleanly restores RGB textures when unchecked)
    document.getElementById("chkDeltaZHeatmap")?.addEventListener("change", (e) => {
      const active = Boolean(e.target.checked);
      setCompareElevationHeatmap(active);
      showToast(active ? "Enabled Z Elevation Heatmap on Both Scans" : "Restored Original RGB Texture Shading");
    });

    const loop = () => {
      requestAnimationFrame(loop);
      if (STATE.activeView !== "compare") return;
      if (!dragging) {
        controls.update();
      }
      left.camera.updateMatrixWorld();
      right.camera.position.copy(left.camera.position);
      right.camera.quaternion.copy(left.camera.quaternion);
      right.camera.updateMatrixWorld();
      const heatmapOn = Boolean(document.getElementById("chkDeltaZHeatmap")?.checked);
      [left, right].forEach((side) => {
        if (side.tilesRenderer) {
          side.tilesRenderer.update();
          side.tilesRenderer.group.traverse((child) => {
            if (child.isMesh && child.material) {
              const mats = Array.isArray(child.material) ? child.material : [child.material];
              mats.forEach((m) => {
                if (
                  m &&
                  (m.userData?._lastBrightness !== STATE.scanBrightness ||
                    Boolean(m.userData?._elevationHeatmapActive) !== heatmapOn)
                ) {
                  applyCompareElevationHeatmapToMaterial(m, heatmapOn);
                }
              });
            }
          });
        }
      });
      syncCompareLoaderProgress();
      left.renderer.render(left.scene, left.camera);
      right.renderer.render(right.scene, right.camera);
    };
    requestAnimationFrame(loop);

    compareCtx = { left, right, controls, _curtainPct: 50, _framedPairKey: "" };
    window.__gsCompareCtx = compareCtx;
    setCompareMode(STATE.compareMode || "slider");
    syncCompareScansFromDropdowns();
    return compareCtx;
  }

  function launchMultiDateCompare(leftScanId, rightScanId) {
    const refScan =
      STATE.scans.find((s) => s.scan_id === (rightScanId || leftScanId)) ||
      STATE.scans.find((s) => s.scan_id === STATE.activeScanId) ||
      STATE.scans[0];
    if (refScan && refScan.project_group) {
      STATE.activeProjectGroup = refScan.project_group;
    }
    populateProjectScanDropdowns(STATE.activeProjectGroup, rightScanId || STATE.activeScanId);
    switchView("compare");
    initCompareView();
    const lSel = document.getElementById("compareLeftSelect");
    const rSel = document.getElementById("compareRightSelect");
    if (lSel && leftScanId) lSel.value = leftScanId;
    if (rSel && rightScanId) rSel.value = rightScanId;
    syncCompareScansFromDropdowns();
  }

  // ============================================================================
  // 5. MODALS: SMART QUEUE, SCOPED SHARING, OFFLINE CACHE & THEME SWITCHER
  // ============================================================================
  function syncThreeSceneThemes(theme) {
    if (!window.THREE) return;
    const isDark = theme === "dark";
    const bgHex = isDark ? 0x0b1120 : 0xe2e8f0;
    const studioBgHex = isDark ? 0x0b0f19 : 0xe2e8f0;
    const cmpLeftHex = isDark ? 0x0b1322 : 0xe2e8f0;
    const cmpRightHex = isDark ? 0x0b1322 : 0xe2e8f0;
    const gridMain = isDark ? 0x334155 : 0x94a3b8;
    const gridSub = isDark ? 0x1e293b : 0xcbd5e1;

    if (previewThree && previewThree.scene) {
      previewThree.scene.background = new THREE.Color(bgHex);
      if (previewThree.grid && previewThree.grid.material) {
        const mats = Array.isArray(previewThree.grid.material) ? previewThree.grid.material : [previewThree.grid.material];
        if (mats[0]?.color) mats[0].color.setHex(gridMain);
        if (mats[1]?.color) mats[1].color.setHex(gridSub);
      }
    }

    if (studioThree && studioThree.scene) {
      studioThree.scene.background = new THREE.Color(studioBgHex);
      if (studioThree.grid && studioThree.grid.material) {
        const mats = Array.isArray(studioThree.grid.material) ? studioThree.grid.material : [studioThree.grid.material];
        if (mats[0]?.color) mats[0].color.setHex(gridMain);
        if (mats[1]?.color) mats[1].color.setHex(gridSub);
      }
    }

    if (compareCtx) {
      if (compareCtx.left?.scene) compareCtx.left.scene.background = new THREE.Color(cmpLeftHex);
      if (compareCtx.right?.scene) compareCtx.right.scene.background = new THREE.Color(cmpRightHex);
      [compareCtx.left, compareCtx.right].forEach((side) => {
        if (side?.grid && side.grid.material) {
          const mats = Array.isArray(side.grid.material) ? side.grid.material : [side.grid.material];
          if (mats[0]?.color) mats[0].color.setHex(gridMain);
          if (mats[1]?.color) mats[1].color.setHex(gridSub);
        }
      });
    }
  }

  async function applyTheme(pref, persistToServer = false) {
    const normalizedPref = ["auto", "light", "dark"].includes(String(pref || "").toLowerCase())
      ? String(pref).toLowerCase()
      : "auto";
    STATE.themePreference = normalizedPref;
    const resolved = resolveThemeFromPreference(normalizedPref);
    STATE.resolvedTheme = resolved;

    document.documentElement.setAttribute("data-theme", resolved);
    document.documentElement.setAttribute("data-theme-pref", normalizedPref);
    try {
      localStorage.setItem("gs_theme_pref", normalizedPref);
    } catch (_) {}

    document.querySelectorAll("#themeModeSwitcher .btn-seg").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.themePref === normalizedPref);
    });

    const subEl = document.getElementById("lblThemeStatusSub");
    if (subEl) {
      if (normalizedPref === "auto") {
        const nowStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        subEl.textContent = `Auto by Time of Day (${nowStr} → Currently ${resolved === "dark" ? "Dark" : "Light"} · 06:00–18:00 Light)`;
      } else if (normalizedPref === "light") {
        subEl.textContent = "Locked to Light Theme across all views & 3D canvases";
      } else {
        subEl.textContent = "Locked to Dark Theme across all views & 3D canvases";
      }
    }

    syncThreeSceneThemes(resolved);

    if (persistToServer && STATE.currentUser?.email) {
      await apiPost("/api/user/settings", {
        user_email: STATE.currentUser.email,
        user_name: STATE.currentUser.name || "Engineer",
        offline_cache_enabled: STATE.currentUser.offlineCacheEnabled !== false,
        theme_preference: normalizedPref,
      }).catch(() => {});
    }
  }

  function openModal(id) {
    document.getElementById(id)?.classList.add("active");
  }
  function closeModal(id) {
    if (id === "userProfileGateModal" && !STATE.isAuthorized && !STATE.shareToken) {
      showToast("Please sign in with Google, select a team profile, or choose Guest Mode to continue");
      return;
    }
    document.getElementById(id)?.classList.remove("active");
  }
  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
  });

  document.querySelectorAll("#themeModeSwitcher .btn-seg").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const pref = btn.dataset.themePref || "auto";
      await applyTheme(pref, true);
      const labelMap = {
        auto: `Theme set to Auto (${STATE.resolvedTheme === "dark" ? "Dark" : "Light"} by time of day)`,
        light: "Theme switched to Light Mode",
        dark: "Theme switched to Dark Mode",
      };
      showToast(labelMap[pref] || "Updated theme preference");
    });
  });

  // 5A. PIX4Dmatic Smart Queue Modal & Default Pipeline Settings
  let _queuePollTimer = null;
  let _pix4dSettingsDirty = false;

  const PIX4D_PRESETS = {
    gatheringcloud: {
      mesh_pipeline: "FixedSize",
      texture_size: 4096,
      model_simplification: "Conservative",
      deghosting: "Weak",
      export_lod: 13,
      skyless: false,
      use_roi: false,
    },
    fast_field: {
      mesh_pipeline: "FixedSize",
      texture_size: 2048,
      model_simplification: "Moderate",
      deghosting: "Weak",
      export_lod: 12,
      skyless: false,
      use_roi: false,
    },
    archival_8k: {
      mesh_pipeline: "Scalable",
      texture_size: 8192,
      model_simplification: "Conservative",
      deghosting: "Weak",
      export_lod: 15,
      skyless: false,
      use_roi: false,
    },
  };

  function detectPix4dPresetKey(cfg) {
    if (!cfg) return "gatheringcloud";
    for (const [k, p] of Object.entries(PIX4D_PRESETS)) {
      if (
        String(cfg.mesh_pipeline || "FixedSize") === p.mesh_pipeline &&
        Number(cfg.texture_size || 4096) === p.texture_size &&
        String(cfg.model_simplification || "Conservative") === p.model_simplification &&
        String(cfg.deghosting || "Weak") === p.deghosting &&
        Number(cfg.export_lod ?? 13) === p.export_lod &&
        Boolean(cfg.skyless) === p.skyless &&
        Boolean(cfg.use_roi) === p.use_roi
      ) {
        return k;
      }
    }
    return "custom";
  }

  function formatPix4dSummaryBadge(cfg) {
    if (!cfg) return "GatheringCloud Optimal · 4K · SkyMask OFF · .3tz";
    const presetKey = detectPix4dPresetKey(cfg);
    const mp = cfg.mesh_pipeline || "FixedSize";
    const tex = Number(cfg.texture_size || 4096);
    const texLabel = tex >= 8192 ? "8K" : tex >= 4096 ? "4K" : "2K";
    const skyLabel = cfg.skyless ? "SkyMask ON" : "SkyMask OFF";
    const prefix = presetKey === "gatheringcloud" ? "GatheringCloud Optimal · " : "";
    return `${prefix}${mp} · ${texLabel} · ${skyLabel} · .3tz`;
  }

  function applyPix4dSettingsToUI(cfg, forceOverwrite = false) {
    if (!cfg) return;
    STATE.pix4dSettings = Object.assign(
      {
        mesh_pipeline: "FixedSize",
        skyless: false,
        use_roi: false,
        texture_size: 4096,
        model_simplification: "Conservative",
        deghosting: "Weak",
        export_lod: 13,
      },
      cfg
    );
    const c = STATE.pix4dSettings;
    const presetKey = detectPix4dPresetKey(c);
    const sumEl = document.getElementById("lblQueuePipelineSummary");
    if (sumEl) sumEl.textContent = formatPix4dSummaryBadge(c);
    const hdrEl = document.getElementById("gstScriptHeaderTitle");
    if (hdrEl) {
      hdrEl.textContent = `PIX4Dmatic 2.11.0 Headless .GST Script (TWD97 (121) [EPSG:3826] + TWVD2001 [EPSG:8904] · ${c.mesh_pipeline} · ${c.texture_size}px · ${c.skyless ? "SkyMask ON" : "SkyMask OFF"}):`;
    }

    if (_pix4dSettingsDirty && !forceOverwrite) return;

    ["selPix4dPreset", "selPix4dPresetUser"].forEach((pid) => {
      const pel = document.getElementById(pid);
      if (pel && document.activeElement !== pel) pel.value = presetKey;
    });

    const pairs = [
      ["selPix4dMeshPipeline", "selPix4dMeshPipelineUser", String(c.mesh_pipeline || "FixedSize")],
      ["selPix4dTextureSize", "selPix4dTextureSizeUser", String(c.texture_size || 4096)],
      ["selPix4dSimplification", "selPix4dSimplificationUser", String(c.model_simplification || "Conservative")],
      ["selPix4dDeghosting", "selPix4dDeghostingUser", String(c.deghosting || "Weak")],
      ["inpPix4dExportLod", "inpPix4dExportLodUser", String(c.export_lod ?? 13)],
    ];
    pairs.forEach(([id1, id2, val]) => {
      const el1 = document.getElementById(id1);
      if (el1 && document.activeElement !== el1) el1.value = val;
      const el2 = document.getElementById(id2);
      if (el2 && document.activeElement !== el2) el2.value = val;
    });

    const chkPairs = [
      ["chkPix4dSkyless", "chkPix4dSkylessUser", Boolean(c.skyless)],
      ["chkPix4dUseRoi", "chkPix4dUseRoiUser", Boolean(c.use_roi)],
    ];
    chkPairs.forEach(([id1, id2, checked]) => {
      const el1 = document.getElementById(id1);
      if (el1) el1.checked = checked;
      const el2 = document.getElementById(id2);
      if (el2) el2.checked = checked;
    });
  }

  async function applyPix4dPreset(presetKey = "gatheringcloud") {
    const preset = PIX4D_PRESETS[presetKey];
    if (!preset) return;
    _pix4dSettingsDirty = false;
    applyPix4dSettingsToUI(preset, true);
    try {
      const res = await apiPost("/api/pix4d/settings", { settings: preset });
      applyPix4dSettingsToUI(res.settings || preset, true);
      const gstBox = document.getElementById("gstScriptPreviewBox");
      if (gstBox && gstBox.style.display !== "none") {
        await previewGstForScan(STATE.activeScanId);
      }
      const label =
        presetKey === "gatheringcloud"
          ? "GatheringCloud Optimal (.3tz + Single-Root 4K WebP GLB + TWD97 + SkyMask OFF)"
          : presetKey === "fast_field"
          ? "Fast Field Preview (2K + Moderate + LOD 12)"
          : "Ultra Archival Multi-Tile (8K + Scalable + LOD 15)";
      showToast(`Applied & saved preset: ${label}`);
    } catch (err) {
      showToast(`Preset Error: ${err.message}`);
    }
  }

  function readPix4dSettingsFromUI(suffix = "") {
    const getVal = (baseId, fallback) => {
      const el = document.getElementById(baseId + suffix) || document.getElementById(baseId);
      return el ? el.value : fallback;
    };
    const getChk = (baseId, fallback) => {
      const el = document.getElementById(baseId + suffix) || document.getElementById(baseId);
      return el ? Boolean(el.checked) : fallback;
    };
    return {
      mesh_pipeline: getVal("selPix4dMeshPipeline", "FixedSize"),
      texture_size: Number(getVal("selPix4dTextureSize", 4096)) || 4096,
      model_simplification: getVal("selPix4dSimplification", "Conservative"),
      deghosting: getVal("selPix4dDeghosting", "Weak"),
      export_lod: Math.max(0, Math.min(20, Number(getVal("inpPix4dExportLod", 13)) || 13)),
      skyless: getChk("chkPix4dSkyless", false),
      use_roi: getChk("chkPix4dUseRoi", false),
    };
  }

  async function savePix4dSettingsFromUI(suffix = "") {
    const draft = readPix4dSettingsFromUI(suffix);
    try {
      const res = await apiPost("/api/pix4d/settings", { settings: draft });
      _pix4dSettingsDirty = false;
      applyPix4dSettingsToUI(res.settings || draft, true);
      const gstBox = document.getElementById("gstScriptPreviewBox");
      if (gstBox && gstBox.style.display !== "none") {
        await previewGstForScan(STATE.activeScanId);
      }
      showToast(
        `Saved PIX4Dmatic defaults: ${draft.mesh_pipeline} · ${draft.texture_size}px · SkyMask ${draft.skyless ? "ON" : "OFF (Preserves Trees)"}`
      );
    } catch (err) {
      showToast(`Failed to save PIX4Dmatic settings: ${err.message}`);
    }
  }

  async function refreshQueueModalData() {
    const tbody = document.getElementById("queueTableBody");
    if (!tbody) return;
    try {
      const qData = await apiGet("/api/queue/status");
      const inboxEl = document.getElementById("lblQueueInboxDir");
      if (inboxEl && qData.inbox_dir) inboxEl.textContent = qData.inbox_dir;
      const gchatInput = document.getElementById("inputGChatWebhookUrl");
      if (gchatInput && typeof qData.gchat_webhook_url === "string" && document.activeElement !== gchatInput) {
        gchatInput.value = qData.gchat_webhook_url;
      }
      if (qData.pix4d_settings) {
        applyPix4dSettingsToUI(qData.pix4d_settings, false);
      }

      const monBox = document.getElementById("livePix4dMonitorBox");
      if (monBox) {
        if (qData.live_pix4d && qData.live_pix4d.scan_id) {
          const lp = qData.live_pix4d;
          monBox.style.display = "block";
          const tEl = document.getElementById("livePix4dTitle");
          if (tEl) tEl.textContent = `Active PIX4Dmatic Pipeline: ${lp.scan_name} (${Math.round(lp.progress_pct || 0)}%)`;
          const bEl = document.getElementById("livePix4dStageBadge");
          if (bEl) bEl.textContent = `${lp.stage}${lp.cpu_ram ? " · " + lp.cpu_ram : ""}`;
          const pBar = document.getElementById("livePix4dProgressBar");
          if (pBar) pBar.style.width = `${Math.max(5, Math.min(100, Number(lp.progress_pct || 10)))}%`;
          const pathEl = document.getElementById("livePix4dLogPath");
          if (pathEl) pathEl.textContent = `Log: ${lp.log_path || ""}`;
          const tailEl = document.getElementById("livePix4dLogTail");
          if (tailEl) tailEl.textContent = (lp.tail_lines || []).join("\n");
        } else {
          monBox.style.display = "none";
        }
      }

      const rows = Array.isArray(qData.all_scans) && qData.all_scans.length > 0 ? qData.all_scans : STATE.scans;
      tbody.innerHTML = "";
      rows.forEach((s) => {
        const tr = document.createElement("tr");
        const isProc = s.status === "processing";
        const pct = Math.round(Number(s.progress_pct || (s.status === "completed" ? 100 : 0)));
        const statusHtml = isProc
          ? `<div style="display:flex;flex-direction:column;gap:3px;min-width:130px;">
               <span class="gs-crs-pill" style="background:rgba(2,132,199,0.18);color:var(--ui-accent);">PROCESSING (${pct}%)</span>
               <div style="height:4px;background:var(--ui-border-strong);border-radius:999px;overflow:hidden;">
                 <div style="height:100%;width:${Math.max(5, pct)}%;background:var(--ui-accent);"></div>
               </div>
               <span style="font-size:10px;color:var(--ui-text-secondary);">${s.stage_label || "Running PIX4Dmatic..."}</span>
             </div>`
          : `<span class="gs-crs-pill">${String(s.status || "").toUpperCase()}</span>`;

        tr.innerHTML = `
          <td><b style="color:var(--ui-text-primary);">${s.name}</b><br><span style="font-size:10.5px;color:var(--ui-text-muted);">${s.scan_id}</span></td>
          <td style="color:var(--ui-text-secondary);">${s.project_group}</td>
          <td><span style="color:var(--ui-text-primary);font-weight:600;">${s.uploader_name}</span><br><span style="font-size:10.5px;color:var(--ui-text-muted);">${s.uploader_email} · ${s.capture_date}</span></td>
          <td><span style="color:var(--ui-text-primary);font-weight:600;">${s.image_count} imgs</span><br><span style="font-size:10.5px;color:var(--ui-text-muted);">${formatCoveredAreaM2(s)} · ${Number(s.size_mb || (s.size_bytes || 0) / 1048576).toFixed(1)} MB</span></td>
          <td><span class="gs-crs-pill">${s.crs} · ${s.texture_resolution}px</span></td>
          <td style="font-family:monospace;font-weight:700;color:var(--ui-text-primary);">${s.priority_score}</td>
          <td>${statusHtml}</td>
          <td style="display:flex;gap:4px;">
            <button type="button" class="btn-xs" data-gst="${s.scan_id}" title="Preview .GST Script">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
                <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
              </svg>
            </button>
            <button type="button" class="btn-xs" data-reprocess="${s.scan_id}" title="Re-run from Original Photos with Custom PIX4Dmatic Settings">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
                <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
            </button>
          </td>
        `;
        tr.querySelector("[data-gst]")?.addEventListener("click", () => previewGstForScan(s.scan_id));
        tr.querySelector("[data-reprocess]")?.addEventListener("click", () => {
          openRerunScanModal(s.scan_id);
        });
        tbody.appendChild(tr);
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="8" style="color:var(--ui-text-secondary);">${err.message}</td></tr>`;
    }
  }

  async function openQueueModal() {
    openModal("modalQueue");
    _pix4dSettingsDirty = false;
    const tbody = document.getElementById("queueTableBody");
    if (tbody && !tbody.children.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="color:var(--ui-text-muted);">Loading...</td></tr>`;
    }
    await refreshQueueModalData();
    refreshCloudManifestUI();
    if (_queuePollTimer) clearInterval(_queuePollTimer);
    _queuePollTimer = setInterval(() => {
      if (document.getElementById("modalQueue")?.classList.contains("active")) {
        refreshQueueModalData();
      } else {
        clearInterval(_queuePollTimer);
        _queuePollTimer = null;
      }
    }, 5000);
  }

  async function previewGstForScan(scanId) {
    try {
      const currentDraft = readPix4dSettingsFromUI("");
      const res = await apiPost("/api/queue/preview-gst", {
        scan_id: scanId || STATE.activeScanId,
        settings: currentDraft,
      });
      const box = document.getElementById("gstScriptPreviewBox");
      const code = document.getElementById("gstScriptCode");
      if (box && code) {
        box.style.display = "block";
        code.textContent = res.gst_script;
      }
      if (res.settings) {
        const hdrEl = document.getElementById("gstScriptHeaderTitle");
        if (hdrEl) {
          const c = res.settings;
          hdrEl.textContent = `PIX4Dmatic 2.11.0 Headless .GST Script (TWD97 (121) [EPSG:3826] + TWVD2001 [EPSG:8904] · ${c.mesh_pipeline} · ${c.texture_size}px · ${c.skyless ? "SkyMask ON" : "SkyMask OFF"}):`;
        }
      }
    } catch (err) {
      showToast(`GST Preview Error: ${err.message}`);
    }
  }

  ["selPix4dPreset", "selPix4dPresetUser"].forEach((pid) => {
    document.getElementById(pid)?.addEventListener("change", (e) => {
      const val = e.target.value;
      if (val && val !== "custom") {
        applyPix4dPreset(val);
      }
    });
  });
  ["btnApplyGatheringCloudPreset", "btnApplyGatheringCloudPresetUser"].forEach((bid) => {
    document.getElementById(bid)?.addEventListener("click", () => {
      applyPix4dPreset("gatheringcloud");
    });
  });

  [
    "selPix4dMeshPipeline",
    "selPix4dTextureSize",
    "selPix4dSimplification",
    "selPix4dDeghosting",
    "inpPix4dExportLod",
    "chkPix4dSkyless",
    "chkPix4dUseRoi",
  ].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", () => {
      _pix4dSettingsDirty = true;
      const draft = readPix4dSettingsFromUI("");
      applyPix4dSettingsToUI(draft, true);
      const gstBox = document.getElementById("gstScriptPreviewBox");
      if (gstBox && gstBox.style.display !== "none") {
        previewGstForScan(STATE.activeScanId);
      }
    });
    document.getElementById(id + "User")?.addEventListener("change", () => {
      _pix4dSettingsDirty = true;
      const draft = readPix4dSettingsFromUI("User");
      applyPix4dSettingsToUI(draft, true);
    });
  });

  async function refreshCloudManifestUI(data = null) {
    try {
      const st = data || (await apiGet("/api/cloud-manifest/status"));
      if (!st || st.status !== "ok") return;
      if (st.google_client_id) STATE.googleClientId = st.google_client_id;
      const badge = document.getElementById("badgeCloudStreamStatus");
      if (badge) {
        const total = Number(st.total_packages || 0);
        const synced = Math.max(Number(st.synced_shared_drive_count || 0), Number(st.synced_my_drive_count || 0));
        const authTag = st.auth_configured ? " · Auth Ready" : " · Link/OAuth";
        badge.textContent = `${synced} / ${total} .3tz Synced (${st.total_size_mb || 0} MB)${authTag}`;
      }
      const lnkSd = document.getElementById("lnkCloudSharedDrive");
      if (lnkSd && st.shared_drive_url) lnkSd.href = st.shared_drive_url;
      const lnkMd = document.getElementById("lnkCloudMyDrive");
      if (lnkMd && st.my_drive_url) lnkMd.href = st.my_drive_url;
    } catch (_) {}
  }

  document.getElementById("btnAuthorizeGDriveCloud")?.addEventListener("click", () => {
    const clientId = STATE.googleClientId || "449032844615-50b3qrr21rklqf9n9r6q2g7r8b288605.apps.googleusercontent.com";
    if (window.google && window.google.accounts && window.google.accounts.oauth2) {
      const tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: "https://www.googleapis.com/auth/drive.readonly",
        callback: async (resp) => {
          if (resp && resp.access_token) {
            try {
              const st = await apiPost("/api/cloud-manifest/auth", {
                access_token: resp.access_token,
                expires_in: resp.expires_in || 3599,
              });
              await refreshCloudManifestUI(st);
              showToast("Authorized Google Drive Read-Only token & synced to VPS for 300+ Mbps .3tz streaming!");
            } catch (err) {
              showToast(`Cloud Auth Error: ${err.message}`);
            }
          }
        },
      });
      tokenClient.requestAccessToken({ prompt: "consent" });
    } else {
      showToast("Google Identity Services script not loaded yet — try Service Account JSON or folder link sharing.");
    }
  });

  document.getElementById("btnToggleServiceAccountBox")?.addEventListener("click", () => {
    const box = document.getElementById("boxServiceAccountConfig");
    if (box) box.style.display = box.style.display === "none" ? "block" : "none";
  });

  document.getElementById("btnSaveServiceAccountJson")?.addEventListener("click", async () => {
    const raw = document.getElementById("txtServiceAccountJson")?.value.trim() || "";
    if (!raw) {
      showToast("Please paste a valid Google Cloud Service Account JSON key.");
      return;
    }
    try {
      const st = await apiPost("/api/cloud-manifest/auth", { service_account_json: raw });
      await refreshCloudManifestUI(st);
      const box = document.getElementById("boxServiceAccountConfig");
      if (box) box.style.display = "none";
      showToast(`Saved Service Account (${st.service_account_email || "ready"}) & synced to VPS!`);
    } catch (err) {
      showToast(`Service Account Error: ${err.message}`);
    }
  });

  document.getElementById("btnSyncCloudPackages")?.addEventListener("click", async () => {
    showToast("Building .3tz single-file archives in Google Drive StreamPackages & syncing manifest to VPS...");
    try {
      const st = await apiPost("/api/cloud-manifest/rebuild", { force: false });
      await refreshCloudManifestUI(st);
      showToast(`Synced ${st.total_packages || 0} .3tz packages (${st.total_size_mb || 0} MB) to Google Drive & VPS!`);
    } catch (err) {
      showToast(`Cloud Sync Error: ${err.message}`);
    }
  });

  document.getElementById("btnSavePix4dSettingsQueue")?.addEventListener("click", () => savePix4dSettingsFromUI(""));
  document.getElementById("btnSavePix4dSettingsUser")?.addEventListener("click", () => savePix4dSettingsFromUI("User"));

  document.getElementById("pcStatusChip")?.addEventListener("click", openQueueModal);
  document.getElementById("btnPreviewGstScript")?.addEventListener("click", () => previewGstForScan(STATE.activeScanId));
  document.getElementById("btnRescanGDriveInbox")?.addEventListener("click", async () => {
    const res = await apiPost("/api/queue/scan-inbox", {});
    await refreshScansCatalog();
    await openQueueModal();
    showToast(`Scanned ${res.inbox_dir}: ${res.total_scans} scans indexed`);
  });
  document.getElementById("btnSaveGChatWebhook")?.addEventListener("click", async () => {
    const url = document.getElementById("inputGChatWebhookUrl")?.value.trim() || "";
    const res = await apiPost("/api/gchat/config", { webhook_url: url });
    showToast(res.webhook_url ? "Saved Google Chat Space Webhook URL" : "Cleared Google Chat Space Webhook URL (dry-run mode)");
  });
  document.getElementById("btnSendTestGChat")?.addEventListener("click", async () => {
    const url = document.getElementById("inputGChatWebhookUrl")?.value.trim() || "";
    const res = await apiPost("/api/gchat/notify", { scan_id: STATE.activeScanId, webhook_url: url });
    showToast(`Google Chat notification (${res.webhook_status}) for ${res.uploader_email}`);
  });

  // 5B. Scoped External Sharing Modal (Requirement 4.b)
  async function openSharingModal(defaultScope = "scan", defaultTarget = "") {
    openModal("modalSharing");
    const scopeSel = document.getElementById("shareScopeType");
    const targetSel = document.getElementById("shareTargetId");

    const populateTargets = () => {
      const st = scopeSel.value;
      targetSel.innerHTML = "";
      if (st === "scan") {
        STATE.scans.forEach((s) => {
          const opt = document.createElement("option");
          opt.value = s.scan_id;
          opt.textContent = `${s.name} (${s.project_group})`;
          targetSel.appendChild(opt);
        });
      } else {
        const groups = [...new Set(STATE.scans.map((s) => s.project_group))];
        groups.forEach((g) => {
          const opt = document.createElement("option");
          opt.value = g;
          opt.textContent = g;
          targetSel.appendChild(opt);
        });
      }
      if (defaultTarget) targetSel.value = defaultTarget;
    };

    scopeSel.value = defaultScope;
    scopeSel.onchange = populateTargets;
    populateTargets();
    await renderShareLinksTable();
  }

  async function renderShareLinksTable() {
    const tbody = document.getElementById("shareLinksTableBody");
    if (!tbody) return;
    try {
      const res = await apiGet("/api/share/list");
      const links = res.links || [];
      tbody.innerHTML = "";
      if (!links.length) {
        tbody.innerHTML = `<tr><td colspan="7" style="color:var(--ui-text-muted);">No external share links created yet.</td></tr>`;
        return;
      }
      links.forEach((l) => {
        const tr = document.createElement("tr");
        const perms = [
          l.allow_measurements ? "Measure" : null,
          l.allow_comments ? "Comment" : null,
          l.allow_download ? "Download" : null,
        ]
          .filter(Boolean)
          .join(", ");
        const localUrl = `${window.location.origin}/?share=${l.token}`;
        tr.innerHTML = `
          <td><b style="color:var(--ui-text-primary);">${l.label}</b></td>
          <td><span class="gs-crs-pill">${l.scope_type.toUpperCase()}: ${l.target_id}</span></td>
          <td><code style="color:var(--ui-accent);font-size:11px;">/s/${l.token}</code></td>
          <td style="font-size:11px;color:var(--ui-text-secondary);">${perms || "View"}</td>
          <td style="color:var(--ui-text-primary);font-weight:600;">${l.view_count}</td>
          <td>${
            l.revoked
              ? '<span style="color:var(--ui-text-muted);font-weight:700;">REVOKED</span>'
              : '<span class="gs-crs-pill">ACTIVE</span>'
          }</td>
          <td style="display:flex;gap:5px;justify-content:flex-end;">
            <button type="button" class="btn-xs" data-copy="${localUrl}" title="Copy Link">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
                <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            </button>
            ${
              !l.revoked
                ? `<button type="button" class="btn-xs" data-revoke="${l.token}" title="Revoke Access">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
                      <circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
                    </svg>
                  </button>`
                : `<button type="button" class="btn-xs" data-restore="${l.token}" title="Restore Access">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
                      <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                    </svg>
                  </button>`
            }
          </td>
        `;
        tr.querySelector("[data-copy]")?.addEventListener("click", () => {
          navigator.clipboard?.writeText(localUrl);
          showToast(`Copied share link: ${localUrl}`);
        });
        tr.querySelector("[data-revoke]")?.addEventListener("click", async () => {
          await apiPost("/api/share/revoke", { token: l.token });
          showToast(`Revoked external share link /s/${l.token}`);
          await renderShareLinksTable();
        });
        tr.querySelector("[data-restore]")?.addEventListener("click", async () => {
          await apiPost("/api/share/restore", { token: l.token });
          showToast(`Restored external share link /s/${l.token}`);
          await renderShareLinksTable();
        });
        tbody.appendChild(tr);
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" style="color:var(--ui-text-secondary);">${err.message}</td></tr>`;
    }
  }

  document.getElementById("btnOpenSharing")?.addEventListener("click", () => openSharingModal());
  document.getElementById("btnCreateShareLink")?.addEventListener("click", async () => {
    const scope_type = document.getElementById("shareScopeType")?.value || "scan";
    const target_id = document.getElementById("shareTargetId")?.value || STATE.activeScanId;
    const label = document.getElementById("shareLabelInput")?.value || "External View Link";
    const allow_measurements = document.getElementById("shareAllowMeasure")?.checked ?? true;
    const allow_comments = document.getElementById("shareAllowComments")?.checked ?? true;
    const allow_download = document.getElementById("shareAllowDownload")?.checked ?? false;
    try {
      const res = await apiPost("/api/share/create", {
        scope_type,
        target_id,
        label,
        allow_measurements,
        allow_comments,
        allow_download,
      });
      showToast(`Created scoped share link: /s/${res.link.token}`);
      await renderShareLinksTable();
    } catch (err) {
      showToast(`Share Error: ${err.message}`);
    }
  });

  // 5C. Client-Side Offline Cache & User Settings Modal (Requirement 5)
  async function openOfflineCacheModal() {
    openModal("modalOfflineCache");
    _pix4dSettingsDirty = false;
    await applyTheme(STATE.themePreference, false);
    applyRolePermissionsToUI();
    await renderAdminControlPanel();
    await refreshSettingsServiceAccountUI();
    apiGet("/api/pix4d/settings")
      .then((res) => {
        if (res && res.settings) applyPix4dSettingsToUI(res.settings, true);
      })
      .catch(() => {});
    const tbody = document.getElementById("offlineCacheTableBody");
    if (!tbody) return;
    tbody.innerHTML = "";
    STATE.scans.forEach((s) => {
      const isCached = STATE.cachedScanIds.has(s.scan_id);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><b style="color:var(--ui-text-primary);">${s.name}</b></td>
        <td style="color:var(--ui-text-secondary);">${s.project_group}</td>
        <td><span class="gs-crs-pill">${s.crs}</span></td>
        <td>${
          isCached
            ? '<span class="gs-crs-pill">Cached</span>'
            : '<span style="color:var(--ui-text-muted);">Uncached</span>'
        }</td>
        <td>
          <button type="button" class="btn-xs primary" data-cache-scan="${s.scan_id}" title="${isCached ? "Refresh Browser Cache" : "Cache in Browser"}">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </button>
        </td>
      `;
      tr.querySelector("[data-cache-scan]")?.addEventListener("click", () => cacheScanInBrowser(s.scan_id));
      tbody.appendChild(tr);
    });
  }

  // Workstation PC Daemon Control in Admin Panel
  async function refreshAdminPcDaemonUI(preloadedStatus = null) {
    const badge = document.getElementById("badgeAdminPcDaemonStatus");
    const detail = document.getElementById("lblAdminPcDaemonDetail");
    const btnToggle = document.getElementById("btnAdminTogglePcDaemon");
    const btnSync = document.getElementById("btnAdminSyncPcInboxNow");
    if (!badge || !btnToggle) return;

    const myInfo = getCurrentUserRoleInfo();
    const canControl = Boolean(myInfo.can_manage_users || myInfo.can_run_workflows || myInfo.canManageUsers || myInfo.canRunWorkflows);
    btnToggle.disabled = !canControl;
    if (btnSync) btnSync.disabled = !canControl;

    let st = preloadedStatus;
    if (!st) {
      try {
        st = await apiGet("/api/admin/pc-daemon");
      } catch (_) {
        st = { pc_reachable: false, daemon_running: false, pc_online: false };
      }
    }

    const reachable = Boolean(st && st.pc_reachable);
    const running = Boolean(st && st.daemon_running);
    STATE.pcOnline = Boolean(st && st.pc_online);
    updatePcStatusUI();

    if (!reachable) {
      badge.textContent = "PC Unreachable (Tunnel Offline)";
      badge.style.background = "rgba(239,68,68,0.16)";
      badge.style.color = "#ef4444";
      btnToggle.textContent = "Start Daemon";
      if (detail) {
        detail.textContent = "Windows Workstation reverse tunnel is not connected. Serving scans from Google Drive .3tz Cloud & Browser Cache.";
      }
      return;
    }

    if (running) {
      badge.textContent = `Running (PID ${st.pid || "Active"})`;
      badge.style.background = "rgba(16,185,129,0.16)";
      badge.style.color = "#10b981";
      btnToggle.textContent = "Stop Daemon";
      btnToggle.style.background = "rgba(239,68,68,0.14)";
      btnToggle.style.color = "#ef4444";
      btnToggle.style.borderColor = "rgba(239,68,68,0.35)";
      const pollNote = st.last_poll_at
        ? `Last inbox poll: ${new Date(st.last_poll_at * 1000).toLocaleTimeString()}`
        : "Polling active";
      const jobNote = st.active_job
        ? ` · Active: ${st.active_job.name || st.active_job.scan_id} (${Math.round(st.active_job.progress_pct || 0)}%)`
        : ` · Queue: ${st.queued_count || 0} waiting · Total scans: ${st.total_scans || STATE.scans.length}`;
      if (detail) {
        detail.textContent = `${pollNote}${jobNote}`;
      }
    } else {
      badge.textContent = "Stopped (Standby)";
      badge.style.background = "rgba(245,158,11,0.16)";
      badge.style.color = "#f59e0b";
      btnToggle.textContent = "Start Daemon";
      btnToggle.style.background = "";
      btnToggle.style.color = "";
      btnToggle.style.borderColor = "";
      if (detail) {
        detail.textContent = "Background Google Drive Inbox polling & PIX4Dmatic queue are paused on PC. Click 'Start Daemon' to resume.";
      }
    }
  }

  document.getElementById("btnAdminTogglePcDaemon")?.addEventListener("click", async () => {
    const btnToggle = document.getElementById("btnAdminTogglePcDaemon");
    const wantStart = btnToggle?.textContent?.toLowerCase().includes("start");
    if (btnToggle) btnToggle.disabled = true;
    try {
      const res = await apiPost("/api/admin/pc-daemon", {
        actor_email: STATE.currentUser?.email || "glibivanov@gatheren.com.tw",
        action: wantStart ? "start" : "stop",
      });
      await refreshAdminPcDaemonUI(res);
      showToast(res.message || (res.daemon_running ? "Workstation Daemon Started" : "Workstation Daemon Stopped"));
      if (res.daemon_running) {
        await refreshScansCatalog(false);
      }
    } catch (err) {
      showToast(`Daemon Control Error: ${err.message}`);
      await refreshAdminPcDaemonUI();
    } finally {
      if (btnToggle) btnToggle.disabled = false;
    }
  });

  document.getElementById("btnAdminSyncPcInboxNow")?.addEventListener("click", async () => {
    const btnSync = document.getElementById("btnAdminSyncPcInboxNow");
    if (btnSync) {
      btnSync.disabled = true;
      btnSync.textContent = "Syncing...";
    }
    try {
      const res = await apiPost("/api/admin/pc-daemon", {
        actor_email: STATE.currentUser?.email || "glibivanov@gatheren.com.tw",
        action: "sync_now",
      });
      await refreshAdminPcDaemonUI(res);
      await refreshScansCatalog(false);
      showToast(res.message || "Synced Google Drive Inbox & .3tz packages!");
    } catch (err) {
      showToast(`Inbox Sync Error: ${err.message}`);
    } finally {
      if (btnSync) {
        btnSync.disabled = false;
        btnSync.textContent = "Sync Inbox Now";
      }
    }
  });

  // Admin Control Panel (5-Level Permissions & User Management)
  async function renderAdminControlPanel() {
    refreshAdminPcDaemonUI();
    const tbody = document.getElementById("adminUsersTableBody");
    const rolePill = document.getElementById("adminCurrentUserRolePill");
    const saveBtn = document.getElementById("btnAdminSaveUser");
    const nameIn = document.getElementById("adminNewUserName");
    const emailIn = document.getElementById("adminNewUserEmail");
    const roleSel = document.getElementById("adminNewUserRole");

    const myInfo = getCurrentUserRoleInfo();
    if (rolePill) {
      rolePill.textContent = `Active Role: ${myInfo.level}. ${myInfo.label}`;
    }
    const canManageUsers = Boolean(myInfo.can_manage_users);
    if (saveBtn) saveBtn.disabled = !canManageUsers;
    if (nameIn) nameIn.disabled = !canManageUsers;
    if (emailIn) emailIn.disabled = !canManageUsers;
    if (roleSel) roleSel.disabled = !canManageUsers;

    if (!tbody) return;
    let users = [];
    try {
      const res = await apiGet("/api/admin/users");
      if (res && Array.isArray(res.users)) {
        users = res.users;
        STATE.teamProfiles = users;
      }
    } catch (_) {
      users = STATE.teamProfiles || [];
    }

    tbody.innerHTML = "";
    users.forEach((u) => {
      const email = String(u.email || "").toLowerCase();
      const isOwner = email === "glibivanov@gatheren.com.tw" || u.role === "owner";
      const uRole = isOwner ? "owner" : String(u.role || "viewer").toLowerCase();
      const uLevel = ROLE_LEVELS_MAP[uRole] || 4;
      const canEditRow =
        canManageUsers &&
        !isOwner &&
        (myInfo.role === "owner" || (myInfo.role === "admin" && uLevel > 2));

      const tr = document.createElement("tr");
      const roleOptionsHtml = ["owner", "admin", "editor", "viewer", "guest"]
        .map((rk) => {
          const disabledOpt =
            rk === "owner" || (myInfo.role === "admin" && (rk === "admin" || rk === "owner"));
          return `<option value="${rk}" ${uRole === rk ? "selected" : ""} ${
            disabledOpt && uRole !== rk ? "disabled" : ""
          }>${ROLE_LEVELS_MAP[rk]}. ${ROLE_LABELS_MAP[rk]}</option>`;
        })
        .join("");

      tr.innerHTML = `
        <td><b style="color:var(--ui-text-primary);">${escapeHtml(u.name || "User")}</b></td>
        <td style="font-family:var(--font-mono);font-size:11.5px;color:var(--ui-accent);">${escapeHtml(
          u.email || ""
        )}</td>
        <td>
          ${
            canEditRow
              ? `<select class="select-sm" data-admin-role-select="${escapeHtml(
                  u.email
                )}" style="height:26px;font-size:11.5px;padding:0 8px;">${roleOptionsHtml}</select>`
              : `<span class="gs-crs-pill" style="${
                  isOwner ? "background:rgba(37,99,235,0.16);color:#3b82f6;font-weight:800;" : ""
                }">${uLevel}. ${escapeHtml(ROLE_LABELS_MAP[uRole] || u.role_label || uRole)}</span>`
          }
        </td>
        <td style="font-size:11px;color:var(--ui-text-secondary);">
          ${
            uRole === "owner"
              ? "All permissions + System Owner"
              : uRole === "admin"
              ? "Manage Editor/Viewer/Guest users + Editor tools"
              : uRole === "editor"
              ? "Rename sites/scans, run PIX4Dmatic & Optimizer"
              : uRole === "viewer"
              ? "View all scans + Measurement/Surveying tools (No PC jobs)"
              : "Single shared scan + Distance/Area/Coordinates only"
          }
        </td>
        <td>
          ${
            canEditRow
              ? `<button type="button" class="btn-xs" data-admin-delete-user="${escapeHtml(
                  u.email
                )}" style="color:#ef4444;border-color:rgba(239,68,68,0.35);" title="Remove user">Remove</button>`
              : `<span style="font-size:10.5px;color:var(--ui-text-muted);">${
                  isOwner ? "Protected Owner" : "Read-only"
                }</span>`
          }
        </td>
      `;

      const sel = tr.querySelector("[data-admin-role-select]");
      if (sel) {
        sel.addEventListener("change", async (e) => {
          const newRole = e.target.value;
          try {
            await apiPost("/api/admin/users/save", {
              actor_email: STATE.currentUser?.email || "",
              email: u.email,
              name: u.name,
              role: newRole,
            });
            showToast(`Updated ${u.name || u.email} to ${ROLE_LABELS_MAP[newRole] || newRole}`);
            await loadTeamUserProfiles();
            await renderAdminControlPanel();
            renderTeamProfilesGrid();
          } catch (err) {
            showToast(`Role Update Error: ${err.message}`);
            await renderAdminControlPanel();
          }
        });
      }

      const delBtn = tr.querySelector("[data-admin-delete-user]");
      if (delBtn) {
        delBtn.addEventListener("click", async () => {
          try {
            await apiPost("/api/admin/users/delete", {
              actor_email: STATE.currentUser?.email || "",
              email: u.email,
            });
            showToast(`Removed user ${u.email}`);
            await loadTeamUserProfiles();
            await renderAdminControlPanel();
            renderTeamProfilesGrid();
          } catch (err) {
            showToast(`Delete User Error: ${err.message}`);
          }
        });
      }

      tbody.appendChild(tr);
    });
  }

  document.getElementById("btnAdminSaveUser")?.addEventListener("click", async () => {
    const name = document.getElementById("adminNewUserName")?.value?.trim() || "";
    const email = document.getElementById("adminNewUserEmail")?.value?.trim() || "";
    const role = document.getElementById("adminNewUserRole")?.value || "viewer";
    const statusEl = document.getElementById("adminActionStatusMsg");
    if (!email || !email.includes("@")) {
      showToast("Please enter a valid user email address.");
      return;
    }
    try {
      const res = await apiPost("/api/admin/users/save", {
        actor_email: STATE.currentUser?.email || "",
        email,
        name: name || email.split("@")[0],
        role,
      });
      if (document.getElementById("adminNewUserName")) document.getElementById("adminNewUserName").value = "";
      if (document.getElementById("adminNewUserEmail")) document.getElementById("adminNewUserEmail").value = "";
      if (statusEl) {
        statusEl.style.display = "block";
        statusEl.style.color = "#10b981";
        statusEl.textContent = `Saved ${res.user?.name || email} (${res.user?.role_label || role}).`;
      }
      showToast(`Saved user ${email} as ${ROLE_LABELS_MAP[role] || role}`);
      await loadTeamUserProfiles();
      await renderAdminControlPanel();
      renderTeamProfilesGrid();
    } catch (err) {
      if (statusEl) {
        statusEl.style.display = "block";
        statusEl.style.color = "#ef4444";
        statusEl.textContent = `Error: ${err.message}`;
      }
      showToast(`Admin Error: ${err.message}`);
    }
  });

  // Google Service Account Settings & Live Verification
  async function refreshSettingsServiceAccountUI() {
    const pill = document.getElementById("badgeSettingsSaStatus") || document.getElementById("settingsSaStatusPill");
    const box = document.getElementById("boxServiceAccountTestResult") || document.getElementById("settingsSaTestResultBox");
    try {
      const status = await apiGet("/api/cloud-manifest/status");
      const isReady = Boolean(status.auth_configured || status.private_key_loaded || status.has_credentials);
      if (pill) {
        if (isReady) {
          pill.textContent = "Connected & Verified";
          pill.style.background = "rgba(16,185,129,0.16)";
          pill.style.color = "#10b981";
        } else {
          pill.textContent = "Key Needed (.json)";
          pill.style.background = "rgba(245,158,11,0.16)";
          pill.style.color = "#f59e0b";
        }
      }
      if (box) {
        box.style.display = "block";
        if (isReady) {
          const saEmail = status.service_account_email || status.expected_service_account_email || "gcworker@modular-temple-508005-c4.iam.gserviceaccount.com";
          const projId = status.expected_project_id || "modular-temple-508005-c4";
          const keyId = status.private_key_id ? ` (Key ID: ${status.private_key_id.slice(0, 12)}…)` : "";
          const totalPkgs = Number(status.total_packages || 0);
          const syncedPkgs = Math.max(Number(status.synced_shared_drive_count || 0), Number(status.synced_my_drive_count || 0), totalPkgs);
          box.textContent =
            `✓ Active Service Account: ${saEmail}\n` +
            `✓ Project ID: ${projId}${keyId}\n` +
            `✓ OAuth2 Bearer Token: ${status.auth_configured ? "Active (RS256 JWT Verified)" : "Private Key Loaded"}\n` +
            `✓ Synced .3tz Cloud Packages: ${syncedPkgs} / ${totalPkgs} (${status.total_size_mb || 0} MB)`;
        } else {
          box.textContent = `Target Service Account: ${
            status.expected_service_account_email || "gcworker@modular-temple-508005-c4.iam.gserviceaccount.com"
          }\nStatus: Waiting for service account .json private key file.`;
        }
      }
    } catch (_) {}
  }

  async function testGDriveServiceAccountLive(customJsonStr = "") {
    const pill = document.getElementById("badgeSettingsSaStatus") || document.getElementById("settingsSaStatusPill");
    const box = document.getElementById("boxServiceAccountTestResult") || document.getElementById("settingsSaTestResultBox");
    if (pill) {
      pill.textContent = "Testing...";
      pill.style.background = "rgba(59,130,246,0.16)";
      pill.style.color = "#3b82f6";
    }
    if (box) {
      box.style.display = "block";
      box.textContent = "Testing OAuth2 JWT assertion & Google Drive API v3 folder access for gcworker@modular-temple-508005-c4.iam.gserviceaccount.com...";
    }
    try {
      const payload = customJsonStr ? { service_account_json: customJsonStr } : {};
      const res = await apiPost("/api/cloud-manifest/test-sa", payload);
      const isOk = Boolean(res && (res.ok || res.status === "ok"));
      if (isOk) {
        if (pill) {
          pill.textContent = "Connected & Verified";
          pill.style.background = "rgba(16,185,129,0.16)";
          pill.style.color = "#10b981";
        }
        const filesList = res.visible_files || res.sample_files || [];
        const filesSummary = filesList
          .slice(0, 8)
          .map((f) => `• ${f.name} (${f.id})`)
          .join("\n");
        if (box) {
          box.textContent =
            `✓ Service Account Authenticated: ${res.configured_service_account || res.client_email}\n` +
            `✓ Project ID: ${res.expected_project_id || res.project_id}\n` +
            `✓ OAuth2 Token & Drive v3 Access: OK (Range Read: ${res.range_read_ok ? "OK" : "Tested"})\n` +
            `✓ Drive Folder (${res.stream_packages_folder_id || res.folder_id}): ${res.files_visible_count} files visible\n` +
            (filesSummary ? `Visible files:\n${filesSummary}` : "");
        }
        showToast("Service Account verified & Google Drive synced!");
        await refreshScansCatalog(false);
      } else {
        if (pill) {
          pill.textContent = res?.private_key_loaded ? "Auth Error" : "Key Needed (.json)";
          pill.style.background = "rgba(239,68,68,0.16)";
          pill.style.color = "#ef4444";
        }
        if (box) {
          box.textContent = `✗ Service Account Test Result (${res?.status || "error"}):\n${
            res?.message || res?.error || "Failed to authenticate service account."
          }`;
        }
        showToast(res?.message || res?.error || "Service Account key required");
      }
    } catch (err) {
      if (box) {
        box.textContent = `✗ Service Account Test Error: ${err.message}`;
      }
      showToast(`Service Account Error: ${err.message}`);
    }
  }

  document.getElementById("btnTestServiceAccountLive")?.addEventListener("click", () => {
    const pasted = document.getElementById("txtServiceAccountJsonUser")?.value?.trim() || "";
    testGDriveServiceAccountLive(pasted);
  });

  document.getElementById("btnSaveServiceAccountJsonUser")?.addEventListener("click", async () => {
    const pasted = document.getElementById("txtServiceAccountJsonUser")?.value?.trim() || "";
    if (!pasted) {
      showToast("Paste the Service Account JSON key first or click Upload .JSON Key.");
      return;
    }
    await testGDriveServiceAccountLive(pasted);
  });

  document.getElementById("fileServiceAccountJsonUser")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const txtEl = document.getElementById("txtServiceAccountJsonUser");
      if (txtEl) txtEl.value = text;
      await testGDriveServiceAccountLive(text);
    } catch (err) {
      showToast(`Failed to read JSON file: ${err.message}`);
    }
  });

  async function cacheScanInBrowser(scanId) {
    try {
      const manifest = await apiGet(`/api/cache/manifest/${scanId}`);
      if ("caches" in window) {
        const cache = await caches.open("gathering-scans-offline-v1");
        for (const u of manifest.asset_urls || []) {
          await cache.add(u).catch(() => {});
        }
      }
      STATE.cachedScanIds.add(scanId);
      localStorage.setItem("gs_cached_scans", JSON.stringify([...STATE.cachedScanIds]));
      showToast(`Cached ${manifest.scan.name} in local browser CacheStorage (0B on Linux VPS)`);
      await openOfflineCacheModal();
      renderMapClusters();
    } catch (err) {
      showToast(`Offline Cache Error: ${err.message}`);
    }
  }

  document.getElementById("btnOpenOfflineCache")?.addEventListener("click", openOfflineCacheModal);
  document.getElementById("chkEnableOfflineCache")?.addEventListener("change", async (e) => {
    const enabled = Boolean(e.target.checked);
    if (STATE.currentUser) STATE.currentUser.offlineCacheEnabled = enabled;
    await apiPost("/api/user/settings", {
      user_email: STATE.currentUser?.email || "guest@gatheren.cloud",
      user_name: STATE.currentUser?.name || "Engineer",
      offline_cache_enabled: enabled,
      theme_preference: STATE.themePreference,
    }).catch(() => {});
    showToast(enabled ? "Enabled Browser Offline Caching" : "Disabled Browser Offline Caching");
  });
  document.getElementById("btnToggleSimulatedOffline")?.addEventListener("click", async () => {
    const newOffline = STATE.pcOnline;
    const res = await apiPost("/api/pc/simulate-offline", { offline: newOffline });
    STATE.pcOnline = res.pc_online;
    updatePcStatusUI();
    refreshAdminPcDaemonUI();
    showToast(
      STATE.pcOnline
        ? "PC Online — Workstation Daemon Active"
        : "PC Daemon Stopped — Viewing scans from Cloud / Local Browser CacheStorage"
    );
  });

  function updatePcStatusUI() {
    const chip = document.getElementById("pcStatusChip");
    const txt = document.getElementById("pcStatusText");
    const btnSim = document.getElementById("btnToggleSimulatedOffline");
    if (!chip || !txt) return;
    if (STATE.pcOnline) {
      chip.classList.remove("state-offline");
      txt.textContent = "Queue";
      if (btnSim) btnSim.textContent = "Offline";
    } else {
      chip.classList.add("state-offline");
      txt.textContent = "Offline";
      if (btnSim) btnSim.textContent = "Online";
    }
  }

  // ============================================================================
  // 5D. GATHERINGCLOUD GOOGLE OAUTH & USER PROFILE GATE
  //     (Same Client ID 753778992341-hpe65ilnti31j0m7etmq5rn7a1q802da... & Server Persistence)
  // ============================================================================
  function parseGoogleJwt(token) {
    try {
      const parts = String(token || "").split(".");
      if (parts.length < 2) return null;
      const base64Url = parts[1];
      const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
      const jsonPayload = decodeURIComponent(
        window
          .atob(base64)
          .split("")
          .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
          .join("")
      );
      return JSON.parse(jsonPayload);
    } catch (e) {
      return null;
    }
  }

  function applyUserProfileToUI(userObj, markAuthorized = false) {
    const closeBtn = document.getElementById("btnCloseAuthGateModal");
    const confirmBtn = document.getElementById("btnGateConfirmEnter");
    const btnLogout = document.getElementById("btnUserLogout");
    const gateStatus = document.getElementById("gateActiveUserStatusText");
    const lblUser = document.getElementById("lblCurrentUser");
    const avatarImg = document.getElementById("imgCurrentUserAvatar");
    const svgIcon = document.getElementById("svgCurrentUserIcon");

    if (!userObj) {
      STATE.currentUser = null;
      if (!STATE.shareToken) {
        STATE.isAuthorized = false;
        document.body?.classList.add("gs-auth-locked");
      }
      if (lblUser) lblUser.textContent = "Sign In";
      if (avatarImg) avatarImg.style.display = "none";
      if (svgIcon) svgIcon.style.display = "inline-block";
      if (closeBtn) closeBtn.style.display = "none";
      if (confirmBtn) confirmBtn.style.display = "none";
      if (btnLogout) btnLogout.style.display = "none";
      if (gateStatus) {
        gateStatus.textContent =
          "Authorization required — Sign in with Google, select a team profile, or use Guest Mode";
      }
      applyRolePermissionsToUI();
      return;
    }

    if (markAuthorized) {
      STATE.isAuthorized = true;
      try {
        localStorage.setItem("gs_auth_verified_v1", "1");
      } catch (e) {}
    }
    if (STATE.isAuthorized || STATE.shareToken) {
      document.body?.classList.remove("gs-auth-locked");
    }

    const normalized = Object.assign({}, userObj);
    if (!normalized.avatar_url && normalized.picture) {
      normalized.avatar_url = normalized.picture;
    }
    if (!normalized.picture && normalized.avatar_url) {
      normalized.picture = normalized.avatar_url;
    }
    STATE.currentUser = Object.assign({ offlineCacheEnabled: true }, STATE.currentUser || {}, normalized);
    try {
      localStorage.setItem("gathering_user_profile", JSON.stringify(STATE.currentUser));
      localStorage.setItem("gs_current_user", JSON.stringify(STATE.currentUser));
    } catch (e) {
      // ignore
    }

    const rInfo = getCurrentUserRoleInfo();
    if (lblUser) {
      lblUser.textContent = `${STATE.currentUser.name || STATE.currentUser.email || "Guest"} (${rInfo.label})`;
    }
    const btnUser = document.getElementById("btnGoogleUser") || document.getElementById("btnCurrentUserProfile");
    if (btnUser) {
      btnUser.title = `${STATE.currentUser.name || "User"} (${STATE.currentUser.email || ""}) — Role: ${rInfo.level}. ${rInfo.label}`;
    }
    if (avatarImg && svgIcon) {
      const picUrl = STATE.currentUser.avatar_url || STATE.currentUser.picture;
      if (picUrl) {
        avatarImg.src = picUrl;
        avatarImg.style.display = "inline-block";
        svgIcon.style.display = "none";
      } else {
        avatarImg.style.display = "none";
        svgIcon.style.display = "inline-block";
      }
    }

    const offlineLbl = document.getElementById("lblOfflineCacheUserEmail");
    if (offlineLbl) {
      offlineLbl.textContent = `Enable Offline Caching in Browser (${STATE.currentUser.email || "guest"})`;
    }
    const engInput = document.getElementById("cntEngineerName");
    if (engInput && STATE.currentUser.name) {
      engInput.value = STATE.currentUser.name;
    }
    if (gateStatus) {
      gateStatus.textContent = `Signed in as: ${STATE.currentUser.name || STATE.currentUser.email} (${STATE.currentUser.email || ""}) — ${rInfo.level}. ${rInfo.label}`;
    }
    if (closeBtn) {
      closeBtn.style.display = STATE.isAuthorized ? "inline-flex" : "none";
    }
    if (confirmBtn) {
      confirmBtn.style.display = STATE.isAuthorized ? "inline-flex" : "none";
    }
    if (btnLogout) {
      btnLogout.style.display = STATE.isAuthorized ? "inline-flex" : "none";
    }
    applyRolePermissionsToUI();
  }

  async function loadTeamUserProfiles() {
    try {
      const res = await apiGet("/api/user-profiles");
      if (Array.isArray(res.profiles)) {
        STATE.teamProfiles = res.profiles;
      } else if (res.profiles && typeof res.profiles === "object") {
        STATE.teamProfiles = Object.values(res.profiles);
      }
      STATE.teamProfiles = (STATE.teamProfiles || []).map((u) => {
        if (
          u &&
          String(u.email || "").toLowerCase() === "glibivanov@gatheren.com.tw" &&
          (!u.name || u.name === "Glib Ivanov")
        ) {
          return Object.assign({}, u, { name: "雲在天" });
        }
        return u;
      });
    } catch (e) {
      // Fallback to seeded team profiles if offline
      if (!STATE.teamProfiles.length) {
        STATE.teamProfiles = [
          {
            id: "u_glibivanov",
            name: "雲在天",
            email: "glibivanov@gatheren.com.tw",
            role: "admin",
            role_label: "System Admin (Gatheren)",
            auth_provider: "google",
          },
          {
            id: "u_frankchao",
            name: "趙冠人",
            email: "frankchao@gatheren.com.tw",
            role: "admin",
            role_label: "General Manager (Gatheren)",
            auth_provider: "google",
          },
        ];
      }
    }
  }

  function renderTeamProfilesGrid() {
    const grid = document.getElementById("gateExistingUsersGrid");
    const countBadge = document.getElementById("gateRosterCountBadge");
    const searchInput = document.getElementById("gateUserSearchInput");
    if (!grid) return;

    const q = String(searchInput?.value || "").trim().toLowerCase();
    const list = (STATE.teamProfiles || []).filter((u) => {
      if (!q) return true;
      return (
        (u.name || "").toLowerCase().includes(q) ||
        (u.email || "").toLowerCase().includes(q) ||
        (u.role_label || u.role || "").toLowerCase().includes(q)
      );
    });

    if (countBadge) {
      countBadge.textContent = `${list.length} Member${list.length === 1 ? "" : "s"}`;
    }

    grid.innerHTML = "";
    list.forEach((u) => {
      const isCurrent =
        STATE.isAuthorized &&
        STATE.currentUser &&
        String(STATE.currentUser.email || "").toLowerCase() === String(u.email || "").toLowerCase();
      const initials = (u.name || u.email || "U")
        .split(" ")
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
      const picUrl = u.avatar_url || u.picture || "";
      const card = document.createElement("button");
      card.type = "button";
      card.style.cssText = `
        display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:10px;
        border:1.5px solid ${isCurrent ? "var(--ui-accent)" : "var(--ui-border)"};
        background:${isCurrent ? "var(--ui-accent-soft)" : "var(--ui-bg-surface)"};
        cursor:pointer;text-align:left;width:100%;transition:all 0.14s ease;
      `;
      card.innerHTML = `
        ${
          picUrl
            ? `<img src="${picUrl}" alt="" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0;" />`
            : `<div style="width:32px;height:32px;border-radius:50%;background:${isCurrent ? "var(--ui-accent)" : "#334155"};color:#ffffff;font-size:11.5px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${initials}</div>`
        }
        <div style="overflow:hidden;flex:1;">
          <div style="font-size:12.5px;font-weight:700;color:var(--ui-text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${u.name}</div>
          <div style="font-size:10.5px;color:var(--ui-accent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${u.email}</div>
          <div style="font-size:10px;color:var(--ui-text-muted);">${u.role_label || u.role || "Team Member"}</div>
        </div>
      `;
      card.addEventListener("click", async () => {
        applyUserProfileToUI(u, true);
        await apiPost("/api/user-profiles", u).catch(() => {});
        renderTeamProfilesGrid();
        closeModal("userProfileGateModal");
        showToast(`Authorized as ${u.name} (${u.email})`);
      });
      grid.appendChild(card);
    });
  }

  function initGoogleIdentityServicesButton() {
    const originEl = document.getElementById("currentOriginCode");
    if (originEl) {
      originEl.textContent = window.location.origin;
    }

    const btnContainer = document.getElementById("googleSignInButtonContainer");
    if (window.google && window.google.accounts && window.google.accounts.id && btnContainer) {
      try {
        window.google.accounts.id.initialize({
          client_id: GOOGLE_OAUTH_CLIENT_ID,
          callback: window.handleGoogleSignIn,
          auto_select: false,
          cancel_on_tap_outside: true,
        });
        btnContainer.innerHTML = "";
        window.google.accounts.id.renderButton(btnContainer, {
          type: "standard",
          theme: STATE.resolvedTheme === "dark" ? "filled_black" : "outline",
          size: "large",
          text: "signin_with",
          shape: "rectangular",
          logo_alignment: "left",
          width: 260,
        });
      } catch (e) {
        console.warn("[GatheringScans] Google Identity Services render note:", e);
      }
    }
  }

  window.handleGoogleSignIn = async function (response) {
    if (!response || !response.credential) return;
    const jwtPayload = parseGoogleJwt(response.credential) || {};
    const fallbackProfile = {
      id: jwtPayload.sub ? `google_${jwtPayload.sub}` : undefined,
      name: jwtPayload.name || jwtPayload.given_name || (jwtPayload.email ? jwtPayload.email.split("@")[0] : "Google User"),
      email: jwtPayload.email || "",
      avatar_url: jwtPayload.picture || "",
      picture: jwtPayload.picture || "",
      google_sub: jwtPayload.sub || "",
      auth_provider: "google",
    };

    const msgEl = document.getElementById("googleAuthMessage");
    if (msgEl) {
      msgEl.style.color = "var(--ui-accent)";
      msgEl.textContent = "Verifying Google Workspace OAuth credential...";
    }

    try {
      const res = await apiPost("/api/auth/google", {
        credential: response.credential,
        profile: fallbackProfile,
      });
      const verifiedUser = res.user || fallbackProfile;
      if (Array.isArray(res.profiles)) {
        STATE.teamProfiles = res.profiles;
      } else if (res.profiles && typeof res.profiles === "object") {
        STATE.teamProfiles = Object.values(res.profiles);
      }
      applyUserProfileToUI(verifiedUser, true);
      renderTeamProfilesGrid();
      if (msgEl) {
        msgEl.style.color = "var(--ui-accent)";
        msgEl.innerHTML = `Verified Google Account: <b>${verifiedUser.name}</b> (${verifiedUser.email})`;
      }
      showToast(`Signed in with Google OAuth as ${verifiedUser.name} (${verifiedUser.email})`);
      setTimeout(() => {
        closeModal("userProfileGateModal");
      }, 650);
    } catch (err) {
      applyUserProfileToUI(fallbackProfile, true);
      if (msgEl) {
        msgEl.innerHTML = `Signed in as <b>${fallbackProfile.name}</b> (${fallbackProfile.email})`;
      }
      showToast(`Signed in as ${fallbackProfile.name}`);
      setTimeout(() => {
        closeModal("userProfileGateModal");
      }, 650);
    }
  };

  async function openUserProfileGateModal() {
    openModal("userProfileGateModal");
    await loadTeamUserProfiles();
    applyUserProfileToUI(STATE.currentUser, false);
    renderTeamProfilesGrid();
    initGoogleIdentityServicesButton();
  }

  window.openUserProfileGateModal = openUserProfileGateModal;
  window.checkUserProfileGate = openUserProfileGateModal;

  document.getElementById("btnGoogleUser")?.addEventListener("click", () => {
    openUserProfileGateModal();
  });
  document.getElementById("btnCurrentUserProfile")?.addEventListener("click", () => {
    openUserProfileGateModal();
  });
  document.getElementById("btnCloseAuthGateModal")?.addEventListener("click", () => {
    closeModal("userProfileGateModal");
  });
  document.getElementById("btnGateConfirmEnter")?.addEventListener("click", () => {
    if (!STATE.isAuthorized && !STATE.shareToken) {
      showToast("Please sign in with Google, select a team profile, or choose Guest Mode");
      return;
    }
    closeModal("userProfileGateModal");
    if (STATE.currentUser) {
      showToast(`Active user: ${STATE.currentUser.name} (${STATE.currentUser.email})`);
    }
  });
  document.getElementById("btnGateGuestEnter")?.addEventListener("click", () => {
    applyUserProfileToUI(
      {
        id: "guest_viewer",
        name: "Guest Viewer",
        email: "guest@gatheren.cloud",
        role: "guest",
        role_label: "Read-Only Guest",
        avatar_url: "",
        auth_provider: "guest",
      },
      true
    );
    closeModal("userProfileGateModal");
    showToast("Entered in Guest Mode");
  });
  document.getElementById("btnUserLogout")?.addEventListener("click", () => {
    try {
      localStorage.removeItem("gs_auth_verified_v1");
      localStorage.removeItem("gathering_user_profile");
      localStorage.removeItem("gs_current_user");
    } catch (e) {}
    if (window.google?.accounts?.id) {
      try {
        window.google.accounts.id.disableAutoSelect();
      } catch (e) {}
    }
    applyUserProfileToUI(null, false);
    renderTeamProfilesGrid();
    openModal("userProfileGateModal");
    showToast("Signed out — Authorization required to continue");
  });
  document.getElementById("gateUserSearchInput")?.addEventListener("input", () => {
    renderTeamProfilesGrid();
  });
  document.getElementById("btnCopyCurrentOriginGate")?.addEventListener("click", () => {
    navigator.clipboard?.writeText(window.location.origin);
    showToast(`Copied Authorized JavaScript Origin: ${window.location.origin}`);
  });

  // ============================================================================
  // 6. SCALABLE PROJECT & SCAN SELECTOR WIRING + VIEW NAVIGATION
  // ============================================================================
  document.getElementById("mapProjectSearchInput")?.addEventListener("input", (e) => {
    STATE.projectFilterQuery = String(e.target.value || "").trim();
    renderMapClusters();
  });

  document.getElementById("mapProjectSelect")?.addEventListener("change", (e) => {
    const val = e.target.value;
    if (!val || val === "__all__") {
      if (STATE.siteTimelineOpen) closeSiteTimeline();
      if (gsMap) {
        gsMap.centerLat = 24.976;
        gsMap.centerLon = 121.522;
        gsMap.zoom = 11.75;
        gsMap.drawMap();
      }
      return;
    }
    const grp = getProjectGroupsList("").find((g) => g.project_group === val);
    if (grp && gsMap) {
      STATE.activeProjectGroup = grp.project_group;
      gsMap.centerLat = grp.lat;
      gsMap.centerLon = grp.lon;
      gsMap.zoom = 14.5;
      openClusterPopover(grp);
      gsMap.drawMap();
    }
  });

  document.getElementById("btnOpenSelectedProjectTimeline")?.addEventListener("click", () => {
    const selVal = document.getElementById("mapProjectSelect")?.value;
    const targetGroup =
      selVal && selVal !== "__all__"
        ? selVal
        : STATE.activeProjectGroup || (getProjectGroupsList("")[0]?.project_group ?? "");
    if (targetGroup) {
      openSiteTimeline(targetGroup);
    }
  });

  document.getElementById("timelineProjectSelect")?.addEventListener("change", (e) => {
    const val = e.target.value;
    if (val) {
      const grp = getProjectGroupsList("").find((g) => g.project_group === val);
      if (grp && gsMap) {
        gsMap.centerLat = grp.lat;
        gsMap.centerLon = grp.lon;
        gsMap.zoom = Math.max(gsMap.zoom || 12, 13.8);
      }
      openSiteTimeline(val);
    }
  });

  document.getElementById("studioProjectSelect")?.addEventListener("change", (e) => {
    const newGrp = e.target.value;
    if (!newGrp) return;
    STATE.activeProjectGroup = newGrp;
    populateProjectScanDropdowns(newGrp);
    const firstScan = STATE.scans.find((s) => s.project_group === newGrp);
    if (firstScan) {
      loadScanIntoStudio(firstScan.scan_id);
    }
  });

  document.getElementById("studioScanSelect")?.addEventListener("change", (e) => {
    if (e.target.value) {
      loadScanIntoStudio(e.target.value);
    }
  });

  document.getElementById("compareProjectSelect")?.addEventListener("change", (e) => {
    const newGrp = e.target.value;
    if (!newGrp) return;
    STATE.activeProjectGroup = newGrp;
    populateProjectScanDropdowns(newGrp);
    syncCompareScansFromDropdowns();
    showToast(`Switched Multi-Date Compare to project: ${newGrp}`);
  });

  function switchView(viewName, optionalScanId = null) {
    STATE.activeView = viewName;
    document.querySelectorAll("#mainModeSwitcher .btn-seg").forEach((b) => {
      b.classList.toggle("active", b.dataset.view === viewName);
    });
    document.getElementById("viewMap")?.classList.toggle("active", viewName === "map");
    document.getElementById("viewStudio")?.classList.toggle("active", viewName === "studio");
    document.getElementById("viewCompare")?.classList.toggle("active", viewName === "compare");

    if (viewName === "map") {
      document.getElementById("siteTimelineSplitView")?.classList.add("active");
      setTimeout(() => {
        if (gsMap && gsMap.drawMap) gsMap.drawMap();
        syncPreviewRendererContainer();
      }, 60);
    } else if (viewName === "studio") {
      initStudio3D();
      handleResize();
      loadScanIntoStudio(optionalScanId || STATE.activeScanId);
    } else if (viewName === "compare") {
      populateProjectScanDropdowns(STATE.activeProjectGroup, STATE.activeScanId);
      initCompareView();
      handleResize();
      syncCompareScansFromDropdowns();
    }
  }

  document.querySelectorAll("#mainModeSwitcher .btn-seg").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchView(btn.dataset.view);
    });
  });

  function handleResize() {
    if (gsMap && gsMap.drawMap && STATE.activeView === "map") {
      gsMap.drawMap();
    }
    if (previewThree && STATE.activeView === "map") {
      syncPreviewRendererContainer();
    }
    if (studioThree && STATE.activeView === "studio") {
      const w = Math.max(1, studioThree.container.clientWidth);
      const h = Math.max(1, studioThree.container.clientHeight);
      studioThree.camera.aspect = w / h;
      studioThree.camera.updateProjectionMatrix();
      studioThree.renderer.setSize(w, h);
      if (studioThree.tilesRenderer) {
        studioThree.tilesRenderer.setResolutionFromRenderer(studioThree.camera, studioThree.renderer);
      }
    }
    if (compareCtx && STATE.activeView === "compare") {
      const stage = document.getElementById("compareStage");
      const stageW = Math.max(2, Number(stage?.clientWidth) || Number(compareCtx.left?.container?.clientWidth) || window.innerWidth);
      const stageH = Math.max(1, Number(stage?.clientHeight) || Number(compareCtx.left?.container?.clientHeight) || window.innerHeight - 52);
      const w = STATE.compareMode === "split" ? Math.max(1, Math.floor(stageW / 2)) : stageW;
      const h = stageH;
      [compareCtx.left, compareCtx.right].forEach((side) => {
        if (!side) return;
        side.camera.aspect = w / h;
        side.camera.updateProjectionMatrix();
        side.renderer.setSize(w, h);
        if (side.tilesRenderer) {
          side.tilesRenderer.setResolutionFromRenderer(side.camera, side.renderer);
        }
      });
    }
  }

  window.addEventListener("resize", handleResize);

  async function refreshScansCatalog(isBackgroundPoll = false) {
    try {
      if (
        isBackgroundPoll &&
        ((previewThree && !previewThree._loadingDone) || (studioThree && !studioThree._loadingDone))
      ) {
        return;
      }
      const prevCatalogSig = (STATE.scans || [])
        .map(
          (s) =>
            `${s.scan_id}:${s.name}:${s.project_group}:${s.status}:${Math.round(s.progress_pct || 0)}:${s.stream_url || ""}:${s.preview_stream_url || ""}`
        )
        .join("|");
      const data = await apiGet("/api/scans");
      const normalizeScanUploader = (s) => {
        if (!s) return s;
        if (!s.uploader_name || s.uploader_name === "Glib Ivanov" || s.uploader_name === "Argon") {
          s.uploader_name = "雲在天";
        }
        if (
          !s.uploader_email ||
          s.uploader_email === "glib@gatheren.com.tw" ||
          s.uploader_email === "argon@gatheren.com.tw"
        ) {
          s.uploader_email = "glibivanov@gatheren.com.tw";
        }
        return s;
      };
      const incomingScans = (Array.isArray(data.scans) ? data.scans : []).map(normalizeScanUploader);

      if (incomingScans.length > 0) {
        STATE.scans = incomingScans;
        STATE.projects = data.projects || [];
        try {
          localStorage.setItem(
            "gs_last_catalog_v1",
            JSON.stringify({ scans: STATE.scans, projects: STATE.projects })
          );
        } catch (_) {}
      } else if (data.pc_online === false) {
        // Never wipe existing timeline scans on a transient tunnel reconnect
        if (!STATE.scans || STATE.scans.length === 0) {
          try {
            const cached = JSON.parse(localStorage.getItem("gs_last_catalog_v1") || "null");
            if (cached && Array.isArray(cached.scans) && cached.scans.length > 0) {
              STATE.scans = cached.scans.map(normalizeScanUploader);
              STATE.projects = cached.projects || [];
            }
          } catch (_) {}
        }
      } else {
        STATE.scans = incomingScans;
        STATE.projects = data.projects || [];
      }

      if (data.materials) {
        STATE.materials = data.materials;
      }
      if (typeof data.pc_online === "boolean") {
        STATE.pcOnline = data.pc_online;
        updatePcStatusUI();
      }
      if (data.user_settings && data.user_settings.theme_preference && !localStorage.getItem("gs_theme_pref")) {
        await applyTheme(data.user_settings.theme_preference, false);
      }

      if (data.mode === "external_share" && data.share_link) {
        STATE.shareLinkInfo = data.share_link;
        const banner = document.getElementById("externalShareBanner");
        const scopeLbl = document.getElementById("lblExternalShareScope");
        if (banner && scopeLbl) {
          banner.style.display = "flex";
          scopeLbl.textContent = `${data.share_link.label} (${data.share_link.scope_type.toUpperCase()}: ${data.share_link.target_id}) — Guest Access (Level 5: Distance, Area & Coordinates only).`;
        }
        applyRolePermissionsToUI();
      }

      const nextCatalogSig = (STATE.scans || [])
        .map(
          (s) =>
            `${s.scan_id}:${s.name}:${s.project_group}:${s.status}:${Math.round(s.progress_pct || 0)}:${s.stream_url || ""}:${s.preview_stream_url || ""}`
        )
        .join("|");

      if (isBackgroundPoll && prevCatalogSig === nextCatalogSig) {
        return;
      }

      // Dynamically resolve initial project & scan from URL params on initial load only
      const params = new URLSearchParams(window.location.search);
      const urlProject = params.get("project");
      const urlScan = params.get("scan");
      if (!isBackgroundPoll && urlScan && STATE.scans.some((s) => s.scan_id === urlScan)) {
        STATE.activeScanId = urlScan;
      } else if (!STATE.activeScanId || !STATE.scans.some((s) => s.scan_id === STATE.activeScanId)) {
        if (STATE.scans.length > 0) {
          const firstReady = STATE.scans.find((s) => s.status === "completed") || STATE.scans[0];
          STATE.activeScanId = firstReady.scan_id;
        }
      }
      if (
        !STATE.selectedTimelineScanId ||
        !STATE.scans.some((s) => s.scan_id === STATE.selectedTimelineScanId)
      ) {
        STATE.selectedTimelineScanId = STATE.activeScanId;
      }

      const activeScanObj =
        STATE.scans.find((s) => s.scan_id === STATE.activeScanId) || STATE.scans[0];
      if (!isBackgroundPoll && urlProject && STATE.scans.some((s) => s.project_group === urlProject)) {
        STATE.activeProjectGroup = urlProject;
      } else if (
        !STATE.activeProjectGroup ||
        !STATE.scans.some((s) => s.project_group === STATE.activeProjectGroup)
      ) {
        if (activeScanObj && activeScanObj.project_group) {
          STATE.activeProjectGroup = activeScanObj.project_group;
        }
      }
      populateProjectScanDropdowns(STATE.activeProjectGroup, STATE.activeScanId);
      renderMapClusters();

      if (prevCatalogSig !== nextCatalogSig && STATE.siteTimelineOpen && STATE.activeView === "map" && STATE.scans.length > 0) {
        openSiteTimeline(STATE.activeProjectGroup, STATE.selectedTimelineScanId, false);
      }
    } catch (err) {
      if (!STATE.scans || STATE.scans.length === 0) {
        document.body.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:var(--ui-bg-subtle);color:var(--ui-text-primary);font-family:sans-serif;padding:24px;">
            <div style="max-width:480px;background:var(--ui-bg-surface);border:1px solid var(--ui-border-strong);border-radius:12px;padding:24px;text-align:center;box-shadow:var(--ui-shadow-window);">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="var(--ui-accent)" stroke-width="1.8" style="margin-bottom:10px;">
                <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
              <h2 style="font-size:17px;color:var(--ui-text-primary);">Access Restricted or Link Revoked</h2>
              <p style="font-size:13px;color:var(--ui-text-secondary);margin-top:8px;">${err.message}</p>
            </div>
          </div>
        `;
      }
    }
  }

  // Bootstrap Application, Theme Engine (Default: Time of Day Auto) & Mandatory Authorization Gate
  window.addEventListener("DOMContentLoaded", async () => {
    const topBadge = document.getElementById("topCrsBadge");
    if (topBadge) {
      topBadge.textContent = "Created by Glib Ivanov, PhD and Gemini 4 Argon";
      topBadge.title = "Created by Glib Ivanov, PhD and Gemini 4 Argon";
    }
    await applyTheme(STATE.themePreference, false);
    applyUserProfileToUI(STATE.currentUser, false);
    if (!STATE.isAuthorized && !STATE.shareToken) {
      document.body.classList.add("gs-auth-locked");
      openUserProfileGateModal();
    } else {
      loadTeamUserProfiles();
    }
    await refreshScansCatalog(false);
    const urlScan = new URLSearchParams(window.location.search).get("scan");
    if (urlScan) {
      switchView("studio", urlScan);
    }
    window.addEventListener("focus", () => {
      refreshScansCatalog(true);
      if (STATE.themePreference === "auto") {
        applyTheme("auto", false);
      }
    });
    setInterval(() => {
      refreshScansCatalog(true);
    }, 4000);
    setInterval(() => {
      if (STATE.themePreference === "auto") {
        applyTheme("auto", false);
      }
    }, 60000);
    setInterval(() => {
      try {
        if (previewThree && previewThree.tilesRenderer && !previewThree._loadingDone) {
          previewThree.camera.updateMatrixWorld();
          previewThree.tilesRenderer.update();
          syncTilesLoaderProgress(previewThree, "preview");
          previewThree.renderer.render(previewThree.scene, previewThree.camera);
        }
        if (studioThree && studioThree.tilesRenderer && !studioThree._loadingDone) {
          studioThree.camera.updateMatrixWorld();
          studioThree.tilesRenderer.update();
          syncTilesLoaderProgress(studioThree, "studio");
          studioThree.renderer.render(studioThree.scene, studioThree.camera);
        }
        if (compareCtx) {
          let needsRender = false;
          ["left", "right"].forEach((k) => {
            const side = compareCtx[k];
            if (side && side.tilesRenderer && !side._loadingDone) {
              side.camera.updateMatrixWorld();
              side.tilesRenderer.update();
              syncTilesLoaderProgress(side, "compare");
              needsRender = true;
            }
          });
          if (needsRender && compareCtx.left && compareCtx.right) {
            compareCtx.left.renderer.render(compareCtx.left.scene, compareCtx.left.camera);
            compareCtx.right.renderer.render(compareCtx.right.scene, compareCtx.right.camera);
          }
        }
      } catch (_) {}
    }, 120);
  });

  window.__GS_API = {
    STATE,
    getContexts: () => ({ previewThree, studioThree, compareCtx }),
    switchView,
    openSiteTimeline,
    selectTimelineTile,
    launchMultiDateCompare,
    loadScanIntoCompareSide,
    setCompareMode,
    frameCompareCamera,
    setCompareElevationHeatmap,
    alignCompareSides,
    refreshScansCatalog,
    drawA3PreviewCanvas,
  };
})();


