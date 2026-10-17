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

  // Load persisted user profile (compatible with GatheringCloud's gathering_user_profile)
  function getInitialCurrentUser() {
    try {
      const saved =
        localStorage.getItem("gathering_user_profile") ||
        localStorage.getItem("gs_current_user");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.email) {
          return Object.assign({ offlineCacheEnabled: true }, parsed);
        }
      }
    } catch (e) {
      // ignore
    }
    return {
      id: "user_glib_ivanov",
      email: "glibivanov@gatheren.com.tw",
      name: "Glib Ivanov",
      role: "admin",
      role_label: "System Admin (Gatheren)",
      auth_provider: "google",
      offlineCacheEnabled: true,
    };
  }

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
    shareToken: new URLSearchParams(window.location.search).get("share") || "",
    shareLinkInfo: null,
    currentUser: getInitialCurrentUser(),
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

  // Apply initial theme attribute immediately to avoid flash
  STATE.resolvedTheme = resolveThemeFromPreference(STATE.themePreference);
  document.documentElement.setAttribute("data-theme", STATE.resolvedTheme);
  document.documentElement.setAttribute("data-theme-pref", STATE.themePreference);

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
    return h;
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

    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    container.appendChild(canvas);

    const markerLayer = document.createElement("div");
    markerLayer.style.position = "absolute";
    markerLayer.style.inset = "0";
    markerLayer.style.pointerEvents = "none";
    container.appendChild(markerLayer);

    // Google Maps attribution badge (bottom-left)
    const gAttr = document.createElement("div");
    gAttr.style.cssText =
      "position:absolute;bottom:10px;left:14px;background:rgba(255,255,255,0.92);border:1px solid #cbd5e1;border-radius:6px;padding:3px 9px;font-size:11px;font-weight:600;color:#0f172a;z-index:400;pointer-events:none;box-shadow:0 2px 8px rgba(15,23,42,0.12);";
    gAttr.textContent = "Google Maps · TWD97 (121) + TWVD2001";
    container.appendChild(gAttr);

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
      lastX: 0,
      lastY: 0,
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
      const centerX = w * 0.46;
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

    // Map Layer Switcher (Hybrid vs Map)
    document.querySelectorAll("#mapLayerSwitcher .btn-seg").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#mapLayerSwitcher .btn-seg").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        STATE.mapLyrs = btn.dataset.lyrs || "y";
        drawMap();
      });
    });

    canvas.addEventListener("pointerdown", (e) => {
      gsMap.dragging = true;
      gsMap.lastX = e.clientX;
      gsMap.lastY = e.clientY;
    });
    window.addEventListener("pointerup", () => {
      if (gsMap) gsMap.dragging = false;
    });
    window.addEventListener("pointermove", (e) => {
      if (!gsMap || STATE.activeView !== "map") return;
      const rect = canvas.getBoundingClientRect();
      const { lat, lon } = unprojectXY(e.clientX - rect.left, e.clientY - rect.top);
      const twdE = 250000 + (lon - 121.0) * 101750;
      const twdN = lat * 110760;
      const coordEl = document.getElementById("mapCursorCoords");
      if (coordEl) {
        coordEl.textContent = `TWD97(121) E: ${twdE.toFixed(1)}m | N: ${twdN.toFixed(1)}m | WGS84: ${lat.toFixed(5)}°N, ${lon.toFixed(5)}°E`;
      }
      if (gsMap.dragging) {
        const dx = e.clientX - gsMap.lastX;
        const dy = e.clientY - gsMap.lastY;
        gsMap.lastX = e.clientX;
        gsMap.lastY = e.clientY;
        const worldPx = 256 * Math.pow(2, gsMap.zoom);
        const c = latLonToNormMercator(gsMap.centerLat, gsMap.centerLon);
        const next = normMercatorToLatLon(c.u - dx / worldPx, c.v - dy / worldPx);
        gsMap.centerLat = Math.max(21.5, Math.min(25.6, next.lat));
        gsMap.centerLon = Math.max(119.5, Math.min(122.5, next.lon));
        drawMap();
      }
    });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      gsMap.zoom = Math.max(9.5, Math.min(18.0, gsMap.zoom + (e.deltaY < 0 ? 0.35 : -0.35)));
      drawMap();
    });
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
      blob.innerHTML = `
        <span>${count}</span>
        <div class="blob-label">${grp.project_group} (${count})</div>
      `;

      blob.addEventListener("click", () => {
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

    // Unified 3-Pane Workbench: always keep Top-Right Timeline Cards + Bottom-Right 3D Preview synced with selected site
    openSiteTimeline(grp.project_group, STATE.activeScanId || (sortedScans[0] ? sortedScans[0].scan_id : null));

    const btnOpenTimeline = document.getElementById("btnPopoverOpenTimeline");
    if (btnOpenTimeline) {
      btnOpenTimeline.onclick = () => {
        openSiteTimeline(grp.project_group, STATE.activeScanId || (sortedScans[0] ? sortedScans[0].scan_id : null));
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
      card.innerHTML = `
        <div class="gs-map-tile-thumb-wrap">
          <img class="gs-map-tile-thumb" data-scan-thumb="${scan.scan_id}" src="${thumbSrc}" alt="${scan.name}" />
          <div class="gs-tile-badge-row">
            <span class="gs-tile-chip">${scan.image_count || 0} imgs · 2K</span>
            <span class="gs-tile-chip">RTK σ=${scan.rtk_accuracy_cm}cm</span>
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
    // compute exact bounding box of content nodes up to depth 6 for tight ground-level framing
    if (!tr.root.content || !tr.root.content.uri) {
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
      }
    } else if (outSphere.radius > 0) {
      outSphere.radius = Math.max(18, outSphere.radius * 0.72);
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
      metaEl.textContent = `${scan.capture_date} · ${scan.uploader_name} · E ${Number(scan.twd97_e).toFixed(1)} N ${Number(scan.twd97_n).toFixed(1)} H +${Number(scan.twd97_h).toFixed(2)}m`;
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
      tr.manager.addHandler(/\.(gltf|glb)$/i, gltfLoader);

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
          framePreviewCamera();
        }
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
          syncTilesLoaderProgress(previewThree, "preview");
        }
      });

      tr.errorTarget = 16.0;
      if (tr.downloadQueue) tr.downloadQueue.maxJobs = 12;
      if (tr.parseQueue) tr.parseQueue.maxJobs = 6;
      previewThree.modelPivot.add(tr.group);
      previewThree.tilesRenderer = tr;
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

  function openSiteTimeline(projectGroup, preferredScanId = null) {
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

    // Ensure Map view container is active
    if (STATE.activeView !== "map") {
      switchView("map");
    }
    splitEl.classList.add("active");
    document.querySelectorAll(".scan-cluster-blob").forEach((b) => {
      b.classList.toggle("active-cluster", b.dataset.projectGroup === grpName);
    });
    syncPreviewRendererContainer();
    if (gsMap && gsMap.drawMap) gsMap.drawMap();

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

        tile.innerHTML = `
          <div class="gs-tile-thumb-wrap">
            <img class="gs-tile-thumb" data-scan-thumb="${s.scan_id}" src="${thumbSrc}" alt="${s.name}" />
            <div class="gs-tile-badge-row">
              <span class="gs-tile-chip">${s.image_count || 0} imgs · 2K</span>
              <span class="gs-tile-chip ${isSelected ? "active-indicator" : ""}" data-rtk-chip="1">RTK ${s.rtk_accuracy_cm}cm</span>
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

    // Render 3D Scan Preview in Bottom 2/3
    if (chosenScan) {
      STATE._timelineInitTimer = setTimeout(() => {
        STATE._timelineInitTimer = null;
        selectTimelineTile(chosenScan.scan_id);
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
    openSiteTimeline(STATE.activeProjectGroup, STATE.activeScanId);
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
        (STATE.activeTool === "volume" || STATE.activeTool === "area" || STATE.activeTool === "contours") &&
        STATE.measurePoints.length >= 1
      ) {
        const hoverPt = pickStudio3DPoint(e.clientX, e.clientY);
        if (hoverPt) {
          renderPolygonRubberband(hoverPt);
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
      metricsEl.textContent = `TWD97 · TWVD2001 · σ ${scan.rtk_accuracy_cm}cm`;
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
      tr.manager.addHandler(/\.(gltf|glb)$/i, gltfLoader);

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
          frameStudioCamera();
        }
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
          syncTilesLoaderProgress(studioThree, "studio");
        }
      });

      tr.errorTarget = 6.0;
      studioThree.modelPivot.add(tr.group);
      studioThree.tilesRenderer = tr;
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
      if (c.isMesh) targets.push(c);
    });
    studioThree.fallbackGroup.traverse((c) => {
      if (c.isMesh) targets.push(c);
    });

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

  function add3DPinMarker(pt, colorHex = 0x0284c7, targetGroup = null) {
    if (!studioThree) return null;
    const grp = targetGroup || studioThree.overlayGroup;
    const geom = new THREE.SphereGeometry(0.42, 16, 16);
    const mat = new THREE.MeshBasicMaterial({ color: colorHex, depthTest: false, transparent: true, opacity: 0.95 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(pt);
    mesh.renderOrder = 1002;
    grp.add(mesh);
    return mesh;
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

  // Screen-space zoom-invariant scaling for Gathering Cloud distance markers & rods (Fix #5)
  function updateZoomInvariantElements() {
    if (!studioThree) return;
    const cam = studioThree.camera;
    const h = Math.max(1, studioThree.renderer.domElement.clientHeight);
    const fovRad = THREE.MathUtils.degToRad(cam.fov);

    studioThree.overlayGroup.traverse((obj) => {
      if (!obj.userData) return;
      if (obj.userData.isZoomInvariantMarker || obj.userData.isZoomInvariantRing) {
        const dist = cam.position.distanceTo(obj.position);
        const worldPerPixel = (2 * Math.tan(fovRad / 2) * dist) / h;
        const r = (obj.userData.pixelRadius || 8) * worldPerPixel * 0.55;
        obj.scale.setScalar(Math.max(0.05, r));
        if (obj.userData.isZoomInvariantRing) {
          obj.quaternion.copy(cam.quaternion);
        }
      } else if (obj.userData.isZoomInvariantRod) {
        const dist = cam.position.distanceTo(obj.position);
        const worldPerPixel = (2 * Math.tan(fovRad / 2) * dist) / h;
        const rad = Math.max(0.015, (obj.userData.pixelRadius || 1.35) * worldPerPixel * 0.55);
        obj.scale.set(rad, 1, rad);
      }
    });
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
    clearTempDistanceVisuals();
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
      const sphereGeo = new THREE.SphereGeometry(1, 16, 16);
      const sphereMat = new THREE.MeshBasicMaterial({
        color: 0x0084ff,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95,
      });
      const innerMesh = new THREE.Mesh(sphereGeo, sphereMat);
      innerMesh.position.copy(pos);
      innerMesh.userData.isZoomInvariantMarker = true;
      innerMesh.userData.pixelRadius = 8;
      innerMesh.renderOrder = 1002;
      addObj(innerMesh);

      const ringGeo = new THREE.RingGeometry(0.7, 1.2, 32);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95,
      });
      const outerRing = new THREE.Mesh(ringGeo, ringMat);
      outerRing.position.copy(pos);
      outerRing.userData.isZoomInvariantRing = true;
      outerRing.userData.pixelRadius = 14;
      outerRing.quaternion.copy(studioThree.camera.quaternion);
      outerRing.renderOrder = 1001;
      addObj(outerRing);
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

  // Live rubberband preview for Area & Cut/Fill Volume polygon placement (Fix #1)
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

    const previewPts = pts.length >= 2 ? [pts[pts.length - 1], hoverPt, pts[0]] : [pts[0], hoverPt];
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
      STATE.measurePoints.push(pt.clone());
      add3DPinMarker(pt, STATE.measurePoints.length === 1 ? 0xff3b30 : 0x0284c7);
      if (STATE.measurePoints.length >= 2) {
        const segGeom = new THREE.BufferGeometry().setFromPoints(STATE.measurePoints);
        studioThree.overlayGroup.add(new THREE.Line(segGeom, new THREE.LineBasicMaterial({ color: 0x0284c7, depthTest: false })));
      }
      if (STATE.measurePoints.length >= 3) {
        const pts = STATE.measurePoints.slice();
        STATE.maskBoundaryPoints = pts.map((p) => p.clone());
        const loopPts = [...pts, pts[0]];
        const lineGeom = new THREE.BufferGeometry().setFromPoints(loopPts);
        studioThree.overlayGroup.add(new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color: 0x0284c7, depthTest: false })));

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
          "#cbd5e1"
        );
      }
      return;
    }

    if (tool === "volume") {
      // Fix #1: Never clear placed vertices! Allow clicking 3+ points on the 3D scan to place & refine the Cut/Fill polygon
      if (STATE.measurePoints.length >= 3 && pt.distanceTo(STATE.measurePoints[0]) < 1.8) {
        // Clicking near start point closes and locks the polygon so next click can start a new one
        if (studioThree && studioThree.polyPreviewGroup) {
          while (studioThree.polyPreviewGroup.children.length > 0) {
            studioThree.polyPreviewGroup.remove(studioThree.polyPreviewGroup.children[0]);
          }
        }
        STATE.maskBoundaryPoints = STATE.measurePoints.map((p) => p.clone());
        showToast(`Cut/Fill & Mask boundary polygon locked (${STATE.measurePoints.length} vertices)`);
        STATE.measurePoints = [];
        return;
      }

      STATE.measurePoints.push(pt.clone());
      const pts = STATE.measurePoints.slice();

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

    if (tool === "contours") {
      if (STATE.measurePoints.length >= 3 && pt.distanceTo(STATE.measurePoints[0]) < 1.8) {
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

  // Draw the user's placed Cut/Fill vertices, boundary lines, and 3D extruded prism in studioThree.volumeGroup (Fix #1)
  function drawPlacedCutFillPolygon3D(pts, volumeRes = null) {
    if (!studioThree || !studioThree.volumeGroup) return;
    clearVolumeVisualsOnly();

    if (!pts || !pts.length) {
      // Default stockpile visualization when user clicked Compute in panel without placing custom points yet
      if (volumeRes) {
        const defaultPts = [
          new THREE.Vector3(-9.5, 0.3, -8.5),
          new THREE.Vector3(10.0, 0.4, -8.0),
          new THREE.Vector3(10.5, 1.9, 8.5),
          new THREE.Vector3(-9.0, 1.5, 9.0),
        ];
        drawPlacedCutFillPolygon3D(defaultPts, volumeRes);
      }
      return;
    }

    // 1. Vertex Pins (Red start vertex #ff3b30, Blue subsequent vertices #0084ff)
    pts.forEach((p, idx) => {
      const vGeo = new THREE.SphereGeometry(0.45, 16, 16);
      const vMat = new THREE.MeshBasicMaterial({
        color: idx === 0 ? 0xff3b30 : 0x0084ff,
        depthTest: false,
        transparent: true,
        opacity: 0.96,
      });
      const vMesh = new THREE.Mesh(vGeo, vMat);
      vMesh.position.copy(p);
      vMesh.renderOrder = 1002;
      studioThree.volumeGroup.add(vMesh);
    });

    if (pts.length === 1) {
      add2DBadge(
        pts[0],
        `<div class="autodesk-dist-badge">挖填方起點 (請點擊至少 3 點圍成範圍)</div>`,
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

    // 3. 3D Triangulated Cut/Fill Surface & Datum Base Prism over user's picked points
    const minY = Math.min(...pts.map((p) => p.y)) - 0.35;
    const maxY = Math.max(...pts.map((p) => p.y));
    const centroid = pts.reduce((acc, p) => acc.add(p.clone()), new THREE.Vector3()).divideScalar(pts.length);
    const apex = new THREE.Vector3(centroid.x, maxY + 0.85, centroid.z);

    // Top fan surface + vertical skirts down to minY datum plane
    const positions = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      // Top surface triangle (a, b, apex)
      positions.push(a.x, a.y + 0.04, a.z, b.x, b.y + 0.04, b.z, apex.x, apex.y, apex.z);
      // Vertical datum wall quad (2 triangles)
      positions.push(a.x, minY, a.z, b.x, minY, b.z, b.x, b.y + 0.04, b.z);
      positions.push(a.x, minY, a.z, b.x, b.y + 0.04, b.z, a.x, a.y + 0.04, a.z);
    }

    const prismGeo = new THREE.BufferGeometry();
    prismGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    prismGeo.computeVertexNormals();

    const prismMat = new THREE.MeshStandardMaterial({
      color: 0x0284c7,
      transparent: true,
      opacity: 0.44,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const prismMesh = new THREE.Mesh(prismGeo, prismMat);
    prismMesh.renderOrder = 995;
    studioThree.volumeGroup.add(prismMesh);

    // Base datum outline
    const baseLoopPts = [...pts.map((p) => new THREE.Vector3(p.x, minY, p.z)), new THREE.Vector3(pts[0].x, minY, pts[0].z)];
    const baseLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(baseLoopPts),
      new THREE.LineBasicMaterial({ color: 0x38bdf8, depthTest: false, transparent: true, opacity: 0.75 })
    );
    baseLine.renderOrder = 996;
    studioThree.volumeGroup.add(baseLine);

    // 4. 2D Cut/Fill Volume & Tonnage Badge at Polygon Centroid
    const badgePos = new THREE.Vector3(centroid.x, maxY + 1.0, centroid.z);
    if (volumeRes) {
      add2DBadge(
        badgePos,
        `Fill: <b style="color:#0284c7;">+${volumeRes.fill_volume_m3} m³</b> · Cut: <b>-${volumeRes.cut_volume_m3} m³</b> · Net: <b>${volumeRes.net_volume_m3 >= 0 ? "+" : ""}${volumeRes.net_volume_m3} m³</b> (${volumeRes.estimated_tonnage_t} t)`,
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
    const activePts = customPts && customPts.length >= 3 ? customPts : STATE.measurePoints.length >= 3 ? STATE.measurePoints.slice() : null;

    const panel = document.getElementById("studioSidePanel");
    const alreadyOpenForVolume = panel?.classList.contains("active") && document.getElementById("volStockpileName");

    if (!alreadyOpenForVolume) {
      const matOptions = Object.entries(STATE.materials || {})
        .map(
          ([k, v]) =>
            `<option value="${k}" data-density="${v.density_t_m3}">${v.name} (${v.density_t_m3} t/m³)</option>`
        )
        .join("");

      showSidePanel(
        `<span>Cut/Fill &amp; Stockpile Volume</span>`,
        `
        <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:7px;padding:7px 9px;margin-bottom:9px;line-height:1.4;">
          Click <b>3+ points</b> on the 3D scan to place a Cut/Fill boundary polygon. Click the red start point to lock.
        </div>
        <div class="gs-form-group">
          <label>Zone / Stockpile Name (土方或物料堆名稱)</label>
          <input type="text" class="gs-input" id="volStockpileName" value="QuChi Spillway Aggregate Stockpile A" />
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
            <input type="number" step="0.1" class="gs-input" id="volDatumZ" value="43.18" />
          </div>
        </div>
        <button type="button" class="gs-top-btn accent" style="width:100%;justify-content:center;margin-bottom:8px;" id="btnRunVolumeCalc" title="Compute Cut/Fill Volume &amp; Tonnage">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M3 18L9 8l5 6 4-4 3 8H3z"/>
          </svg>
          <span>Compute</span>
        </button>
        <div id="volResultContainer"></div>
        `
      );

      const matSel = document.getElementById("volMaterialSelect");
      const densInput = document.getElementById("volCustomDensity");
      if (matSel && densInput) {
        matSel.addEventListener("change", () => {
          const opt = matSel.options[matSel.selectedIndex];
          if (opt && opt.dataset.density) densInput.value = opt.dataset.density;
        });
      }
    }

    const runCalc = async (ptsOverride = null) => {
      const ptsToUse =
        ptsOverride && ptsOverride.length >= 3
          ? ptsOverride
          : STATE.measurePoints.length >= 3
          ? STATE.measurePoints.slice()
          : activePts;

      const polyPayload =
        ptsToUse && ptsToUse.length >= 3
          ? ptsToUse.map((p) => {
              const t = localToTwd97(p);
              return [t.e, t.n, t.h];
            })
          : [];
      const payload = {
        scan_id: STATE.activeScanId,
        stockpile_name: document.getElementById("volStockpileName")?.value || "Stockpile A",
        base_mode: document.getElementById("volBaseMode")?.value || "triangulated_boundary",
        material_type: document.getElementById("volMaterialSelect")?.value || "crushed_stone",
        density_t_m3: parseFloat(document.getElementById("volCustomDensity")?.value || "1.65"),
        datum_elevation_m: parseFloat(document.getElementById("volDatumZ")?.value || "43.18"),
        polygon: polyPayload,
      };
      try {
        const res = await apiPost("/api/survey/volume", payload);
        STATE.lastVolumeResult = res;
        renderVolumeResultAnd3D(res, ptsToUse);
      } catch (err) {
        showToast(`Volume Error: ${err.message}`);
      }
    };

    const btnCalc = document.getElementById("btnRunVolumeCalc");
    if (btnCalc) {
      btnCalc.onclick = () => runCalc();
    }
    await runCalc(activePts);
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
            <div class="val">-${res.cut_volume_m3} m³</div>
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
          <div><b>Footprint Area:</b> ${res.planar_area_m2} m² (${res.planar_area_ping} 坪)</div>
          <div><b>Sloped Area:</b> ${res.surface_area_m2} m² · <b>Perim:</b> ${res.perimeter_m} m</div>
          <div><b>Material:</b> ${res.material_name} (${res.density_t_m3} t/m³)</div>
          <div><b>CRS:</b> ${res.crs_short}</div>
        </div>
        <div style="display:flex;gap:6px;">
          <a class="btn-xs primary" style="flex:1;" href="${res.report_html_url}" target="_blank" title="Open Printable Stockpile Report (PDF/HTML)">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            </svg>
            <span>Report</span>
          </a>
          <a class="btn-xs" style="flex:1;" href="${res.report_csv_url}" download title="Export Excel (.CSV)">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span>CSV</span>
          </a>
        </div>
      `;
    }

    // Fix #1: Render 3D Cut/Fill polygon in volumeGroup WITHOUT calling clearMeasurements() or wiping STATE.measurePoints!
    const ptsToRender =
      customPts && customPts.length >= 1
        ? customPts
        : STATE.measurePoints.length >= 1
        ? STATE.measurePoints.slice()
        : null;
    drawPlacedCutFillPolygon3D(ptsToRender, res);
  }

  // 3B. Survey Report: Mask Boundary, 3D Elevation Contours, Civil3D.dwg & A3 Ready-to-Print PDF Exporter
  async function openContoursInspector() {
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
            <input type="text" class="gs-input" id="cntEngineerName" value="${STATE.currentUser?.name || "Glib Ivanov"}" />
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
      const engineerName = document.getElementById("cntEngineerName")?.value || "Glib Ivanov";

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

    // Gatheren Company Banner in Title Block
    const banY = vpY + vpH - 54;
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(tbX, banY, tbW, 20);
    ctx.fillStyle = "#0284c7";
    ctx.beginPath();
    ctx.arc(tbX + 10, banY + 10, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 8px Inter, sans-serif";
    ctx.fillText("GATHEREN", tbX + 19, banY + 9);
    ctx.fillStyle = "#38bdf8";
    ctx.font = "bold 5.5px Inter, sans-serif";
    ctx.fillText("GATHERINGSCANS C3D", tbX + 19, banY + 16);

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
        const vGeo = new THREE.SphereGeometry(0.42, 14, 14);
        const vMat = new THREE.MeshBasicMaterial({
          color: idx === 0 ? 0xff3b30 : 0x0284c7,
          depthTest: false,
        });
        const vMesh = new THREE.Mesh(vGeo, vMat);
        vMesh.position.copy(bp);
        vMesh.renderOrder = 1002;
        studioThree.contourGroup.add(vMesh);
      });
    }

    showToast(`Survey Report ready: Civil3D.dwg + A3 PDF (${res.contour_count} clipped contours, 1:${res.scale_denom || 250})`);
  }

  // 3C. Cross-Section Elevation Profile Graph
  async function openProfileInspector() {
    showSidePanel(
      `<span>Cross-Section Profile</span>`,
      `
      <p style="font-size:11.5px;color:var(--ui-text-secondary);margin-bottom:10px;">
        Compares TWVD2001 elevation profile along the section line between active scan and baseline epoch.
      </p>
      <canvas id="profileChartCanvas" width="330" height="180" style="width:100%;background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);border-radius:8px;"></canvas>
      <div class="gs-metric-grid" id="profileMetricsBox"></div>
      `
    );

    try {
      const res = await apiPost("/api/survey/profile", { scan_id: STATE.activeScanId });
      STATE.lastProfileResult = res;
      drawProfileCanvas(res);
    } catch (err) {
      showToast(`Profile Error: ${err.message}`);
    }
  }

  function drawProfileCanvas(res) {
    const canvas = document.getElementById("profileChartCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const samples = res.samples || [];
    if (!samples.length) return;

    const minZ = Math.min(...samples.map((s) => Math.min(s.elevation_m, s.baseline_elevation_m))) - 0.5;
    const maxZ = Math.max(...samples.map((s) => Math.max(s.elevation_m, s.baseline_elevation_m))) + 0.5;
    const maxChain = samples[samples.length - 1].chainage_m || 1;

    // Grid lines
    ctx.strokeStyle = STATE.resolvedTheme === "dark" ? "#334155" : "#e2e8f0";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      const y = (h - 24) * (i / 5) + 10;
      ctx.beginPath();
      ctx.moveTo(32, y);
      ctx.lineTo(w - 10, y);
      ctx.stroke();
    }

    const toXY = (chain, z) => {
      const x = 34 + ((chain / maxChain) * (w - 48));
      const y = h - 24 - (((z - minZ) / Math.max(maxZ - minZ, 0.1)) * (h - 40));
      return [x, y];
    };

    // Baseline scan curve (dashed slate)
    ctx.strokeStyle = "#64748b";
    ctx.lineWidth = 1.8;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    samples.forEach((s, idx) => {
      const [x, y] = toXY(s.chainage_m, s.baseline_elevation_m);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    // Active scan curve (solid blue)
    ctx.strokeStyle = "#0284c7";
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    samples.forEach((s, idx) => {
      const [x, y] = toXY(s.chainage_m, s.elevation_m);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

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
            <span>${c.author_name}</span>
            <span style="color:var(--ui-text-muted);font-weight:500;">${c.created_at.slice(0, 16)}</span>
          </div>
          <div style="font-size:12px;color:var(--ui-text-primary);margin-top:4px;">${c.text}</div>
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
          author_email: STATE.currentUser.email,
          author_name: STATE.currentUser.name,
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
      const geom = new THREE.SphereGeometry(0.55, 16, 16);
      const mat = new THREE.MeshBasicMaterial({ color: 0x0284c7 });
      const pin = new THREE.Mesh(geom, mat);
      pin.position.set(c.pos_x || 0, (c.pos_y || 0) + 1.2, c.pos_z || 0);
      studioThree.commentPinsGroup.add(pin);
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
      if (box) box.innerHTML = `<div style="font-size:12px;color:var(--ui-accent);">Running GC_ScanOptimizer (${preset})...</div>`;
      try {
        const res = await apiPost("/api/optimizer/optimize", {
          scan_id: STATE.activeScanId,
          preset,
          fast_mode: true,
        });
        if (box) {
          box.innerHTML = `
            <div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);border-radius:8px;padding:10px;font-size:12px;color:var(--ui-text-primary);">
              <div style="color:var(--ui-accent);font-weight:700;">GC_ScanOptimizer Completed (${res.duration_s}s)</div>
              <div style="margin-top:4px;">Preset: <b>${res.preset}</b> (Max Texture: ${res.texture_limit}px)</div>
              <div>Size: ${res.original_mb} MB → <b>${res.compressed_mb} MB (-${res.reduction_pct}%)</b></div>
              <div style="font-size:10.5px;color:var(--ui-text-muted);margin-top:3px;">CRS: ${res.crs}</div>
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
      try {
        const res = await apiPost("/api/optimizer/crop", {
          scan_id: STATE.activeScanId,
          mode,
          polygon: [[-15, -15], [15, -15], [15, 15], [-15, 15]],
          min_elev: 35.0,
          max_elev: 55.0,
        });
        if (box) {
          box.innerHTML = `
            <div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);border-radius:8px;padding:10px;font-size:12px;color:var(--ui-text-primary);">
              <div style="color:var(--ui-accent);font-weight:700;">SpatialCutter Completed (${res.duration_s}s)</div>
              <div>Mode: <b>${res.mode}</b> · Area: <b>${res.cropped_area_m2} m²</b></div>
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

      document
        .querySelectorAll('#bimMeasurementToolbar .autodesk-measure-btn:not([data-tool="snap"])')
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      STATE.activeTool = tool;
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
      document.querySelectorAll("#bimBottomDock .bim-dock-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const dock = btn.dataset.dock;
      if (dock === "volume") openCutFillVolumeInspector();
      else if (dock === "contours") openContoursInspector();
      else if (dock === "section") openSectionBoxInspector();
      else if (dock === "comments") openCommentsInspector();
      else if (dock === "optimizer") openOptimizerInspector();
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

  function classifyCompareSideCoords(side) {
    if (!side || !side.rawSphere || !(side.rawSphere.radius > 0)) return null;
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

    // Case 2: UTM Zone 51N coordinates (345,000 < E <= 415,000; 2,400,000 <= N <= 2,850,000, e.g. QuChi_20261015-obj_mesh)
    if (c.x > 345000 && c.x <= 415000 && c.y >= 2400000 && c.y <= 2850000) {
      return {
        crs: "UTM51N",
        rawCenter: c.clone(),
        twdCenter: new THREE.Vector3(metaE || c.x, metaN || c.y, c.z),
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
      side.alignGroup.updateMatrixWorld(true);
      side.pivot.rotation.set(THREE.MathUtils.degToRad(270), 0, 0);
      side.pivot.updateMatrixWorld(true);
    });
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
    tr.manager.addHandler(/\.(gltf|glb)$/i, gltfLoader);

    tr.addEventListener("load-tileset", () => {
      side._tilesetReady = true;
      if (compareCtx) {
        compareCtx._tilesetReady = true;
        compareCtx._tilesetReadyMs = performance.now();
      }
      const sphere = new THREE.Sphere();
      if (computeTilesetContentSphere(tr, sphere)) {
        side.rawSphere = sphere.clone();
        alignCompareSides();
      }
    });

    tr.addEventListener("load-model", (ev) => {
      if (ev && ev.scene) {
        if (side.fallbackGroup) side.fallbackGroup.visible = false;
        const heatmapOn = Boolean(document.getElementById("chkDeltaZHeatmap")?.checked);
        ev.scene.traverse((c) => {
          if (c.isMesh && c.material) {
            const mats = Array.isArray(c.material) ? c.material : [c.material];
            mats.forEach((m) => applyCompareElevationHeatmapToMaterial(m, heatmapOn));
          }
        });
        syncCompareLoaderProgress();
      }
    });

    tr.errorTarget = 6.0;
    if (tr.downloadQueue) tr.downloadQueue.maxJobs = 12;
    if (tr.parseQueue) tr.parseQueue.maxJobs = 6;
    side.alignGroup.add(tr.group);
    side.tilesRenderer = tr;
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
      scene.background = new THREE.Color(
        isDark ? (isLatest ? 0x091322 : 0x0d1829) : isLatest ? 0xe2e8f0 : 0xdbe4f0
      );
      const camera = new THREE.PerspectiveCamera(
        48,
        Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
        0.1,
        10000
      );
      camera.position.set(38, 30, 44);
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

    // Curtain Slider Dragging
    const divider = document.getElementById("curtainDivider");
    let dragging = false;
    divider.addEventListener("pointerdown", (e) => {
      dragging = true;
      e.stopPropagation();
    });
    window.addEventListener("pointerup", () => {
      dragging = false;
    });
    window.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const rect = stage.getBoundingClientRect();
      const pct = Math.max(5, Math.min(95, ((e.clientX - rect.left) / rect.width) * 100));
      divider.style.left = `${pct}%`;
      rightContainer.style.clipPath = `inset(0 0 0 ${pct}%)`;
      const lbl = document.getElementById("lblCurtainPct");
      if (lbl) lbl.textContent = `Split: ${Math.round(pct)}%`;
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
      controls.update();
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

    compareCtx = { left, right, controls };
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
    const cmpLeftHex = isDark ? 0x0d1829 : 0xdbe4f0;
    const cmpRightHex = isDark ? 0x091322 : 0xe2e8f0;
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

  function formatPix4dSummaryBadge(cfg) {
    if (!cfg) return "FixedSize · 4K · SkyMask OFF · 0B VPS";
    const mp = cfg.mesh_pipeline || "FixedSize";
    const tex = Number(cfg.texture_size || 4096);
    const texLabel = tex >= 8192 ? "8K" : tex >= 4096 ? "4K" : "2K";
    const skyLabel = cfg.skyless ? "SkyMask ON" : "SkyMask OFF";
    return `${mp} · ${texLabel} · ${skyLabel} · 0B VPS`;
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
    const sumEl = document.getElementById("lblQueuePipelineSummary");
    if (sumEl) sumEl.textContent = formatPix4dSummaryBadge(c);
    const hdrEl = document.getElementById("gstScriptHeaderTitle");
    if (hdrEl) {
      hdrEl.textContent = `PIX4Dmatic 2.11.0 Headless .GST Script (TWD97 (121) [EPSG:3826] + TWVD2001 [EPSG:8904] · ${c.mesh_pipeline} · ${c.texture_size}px · ${c.skyless ? "SkyMask ON" : "SkyMask OFF"}):`;
    }

    if (_pix4dSettingsDirty && !forceOverwrite) return;

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
          <td><span style="color:var(--ui-text-primary);font-weight:600;">${s.image_count} imgs</span><br><span style="font-size:10.5px;color:var(--ui-text-muted);">${Number(s.size_mb || (s.size_bytes || 0) / 1048576).toFixed(1)} MB</span></td>
          <td><span class="gs-crs-pill">${s.crs} · ${s.texture_resolution}px</span></td>
          <td style="font-family:monospace;font-weight:700;color:var(--ui-text-primary);">${s.priority_score}</td>
          <td>${statusHtml}</td>
          <td>
            <button type="button" class="btn-xs" data-gst="${s.scan_id}" title="Preview .GST Script">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
                <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
              </svg>
            </button>
          </td>
        `;
        tr.querySelector("[data-gst]")?.addEventListener("click", () => previewGstForScan(s.scan_id));
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
    STATE.currentUser.offlineCacheEnabled = enabled;
    await apiPost("/api/user/settings", {
      user_email: STATE.currentUser.email,
      user_name: STATE.currentUser.name || "Engineer",
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
    showToast(
      STATE.pcOnline
        ? "PC Online — Live streaming from Windows Workstation"
        : "PC Offline — Viewing scans from Local Browser CacheStorage"
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

  function applyUserProfileToUI(userObj) {
    if (!userObj) return;
    const normalized = Object.assign({}, userObj);
    if (!normalized.avatar_url && normalized.picture) {
      normalized.avatar_url = normalized.picture;
    }
    if (!normalized.picture && normalized.avatar_url) {
      normalized.picture = normalized.avatar_url;
    }
    STATE.currentUser = Object.assign({ offlineCacheEnabled: true }, STATE.currentUser, normalized);
    try {
      localStorage.setItem("gathering_user_profile", JSON.stringify(STATE.currentUser));
      localStorage.setItem("gs_current_user", JSON.stringify(STATE.currentUser));
    } catch (e) {
      // ignore
    }

    const lblUser = document.getElementById("lblCurrentUser");
    if (lblUser) {
      lblUser.textContent = STATE.currentUser.name || STATE.currentUser.email || "Guest";
    }
    const btnUser = document.getElementById("btnGoogleUser") || document.getElementById("btnCurrentUserProfile");
    if (btnUser) {
      btnUser.title = `${STATE.currentUser.name || "User"} (${STATE.currentUser.email || ""}) — Click to switch Google OAuth account`;
    }
    const avatarImg = document.getElementById("imgCurrentUserAvatar");
    const svgIcon = document.getElementById("svgCurrentUserIcon");
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
    const gateStatus = document.getElementById("gateActiveUserStatusText");
    if (gateStatus) {
      gateStatus.textContent = `Signed in as: ${STATE.currentUser.name || STATE.currentUser.email} (${STATE.currentUser.email || ""})`;
    }
    const btnLogout = document.getElementById("btnUserLogout");
    if (btnLogout) {
      btnLogout.style.display = STATE.currentUser.role === "guest" ? "none" : "inline-flex";
    }
  }

  async function loadTeamUserProfiles() {
    try {
      const res = await apiGet("/api/user-profiles");
      if (Array.isArray(res.profiles)) {
        STATE.teamProfiles = res.profiles;
      } else if (res.profiles && typeof res.profiles === "object") {
        STATE.teamProfiles = Object.values(res.profiles);
      }
    } catch (e) {
      // Fallback to seeded team profiles if offline
      if (!STATE.teamProfiles.length) {
        STATE.teamProfiles = [
          {
            id: "user_glib_ivanov",
            name: "Glib Ivanov",
            email: "glibivanov@gatheren.com.tw",
            role: "admin",
            role_label: "System Admin (Gatheren)",
            auth_provider: "google",
          },
          {
            id: "user_argon",
            name: "Argon",
            email: "argon@gatheren.com.tw",
            role: "site_engineer",
            role_label: "Site Engineer (Gatheren)",
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
        applyUserProfileToUI(u);
        await apiPost("/api/user-profiles", u).catch(() => {});
        renderTeamProfilesGrid();
        showToast(`Switched active profile to ${u.name} (${u.email})`);
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
      applyUserProfileToUI(verifiedUser);
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
      applyUserProfileToUI(fallbackProfile);
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
    applyUserProfileToUI(STATE.currentUser);
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
    closeModal("userProfileGateModal");
    showToast(`Active user: ${STATE.currentUser.name} (${STATE.currentUser.email})`);
  });
  document.getElementById("btnGateGuestEnter")?.addEventListener("click", () => {
    applyUserProfileToUI({
      id: "guest_viewer",
      name: "Guest Viewer",
      email: "guest@gatheren.cloud",
      role: "guest",
      role_label: "Read-Only Guest",
      avatar_url: "",
      auth_provider: "guest",
    });
    closeModal("userProfileGateModal");
    showToast("Entered in Guest Mode");
  });
  document.getElementById("btnUserLogout")?.addEventListener("click", () => {
    localStorage.removeItem("gathering_user_profile");
    localStorage.removeItem("gs_current_user");
    if (window.google?.accounts?.id) {
      try {
        window.google.accounts.id.disableAutoSelect();
      } catch (e) {}
    }
    applyUserProfileToUI({
      id: "guest_viewer",
      name: "Sign In",
      email: "guest@gatheren.cloud",
      role: "guest",
      role_label: "Not Signed In",
      avatar_url: "",
    });
    renderTeamProfilesGrid();
    showToast("Signed out of Google account");
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
      [compareCtx.left, compareCtx.right].forEach((side) => {
        const w = Math.max(1, side.container.clientWidth);
        const h = Math.max(1, side.container.clientHeight);
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
      const prevIdsSig = (STATE.scans || []).map((s) => `${s.scan_id}:${s.project_group}`).join("|");
      const data = await apiGet("/api/scans");
      const incomingScans = Array.isArray(data.scans) ? data.scans : [];

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
              STATE.scans = cached.scans;
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
          scopeLbl.textContent = `${data.share_link.label} (${data.share_link.scope_type.toUpperCase()}: ${data.share_link.target_id}) — Strictly isolated from other scans.`;
        }
        document.getElementById("btnOpenSharing").style.display = "none";
        document.getElementById("btnOpenOptimizer").style.display = "none";
      }

      // Dynamically resolve initial project & scan from URL params or discovered scans
      const params = new URLSearchParams(window.location.search);
      const urlProject = params.get("project");
      const urlScan = params.get("scan");
      if (urlScan && STATE.scans.some((s) => s.scan_id === urlScan)) {
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
      if (urlProject && STATE.scans.some((s) => s.project_group === urlProject)) {
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

      const nextIdsSig = (STATE.scans || []).map((s) => `${s.scan_id}:${s.project_group}`).join("|");
      if (prevIdsSig !== nextIdsSig && STATE.siteTimelineOpen && STATE.scans.length > 0) {
        openSiteTimeline(STATE.activeProjectGroup, STATE.selectedTimelineScanId);
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

  // Bootstrap Application, Theme Engine (Default: Time of Day Auto) & Live Folder Sync
  window.addEventListener("DOMContentLoaded", async () => {
    await applyTheme(STATE.themePreference, false);
    applyUserProfileToUI(STATE.currentUser);
    loadTeamUserProfiles();
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
    }, 12000);
    setInterval(() => {
      if (STATE.themePreference === "auto") {
        applyTheme("auto", false);
      }
    }, 60000);
  });
})();

