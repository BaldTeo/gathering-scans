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

  // Application State
  const STATE = {
    activeView: "map",
    scans: [],
    materials: {},
    activeScanId: "quchi_20261005_merged",
    activeScan: null,
    activeProjectGroup: "QuChi Dam",
    siteTimelineOpen: false,
    selectedTimelineScanId: "quchi_20261005_merged",
    capturedThumbs: new Set(),
    scanBrightness: 1.0,
    mapLyrs: "y", // 'y' = Google Satellite Hybrid, 'm' = Google Roadmap
    activeTool: "distance",
    snapEnabled: true,
    pcOnline: true,
    shareToken: new URLSearchParams(window.location.search).get("share") || "",
    shareLinkInfo: null,
    currentUser: {
      email: "vitaly@gatheren.cloud",
      name: "Vitaly (Lead Surveyor)",
      offlineCacheEnabled: true,
    },
    cachedScanIds: new Set(JSON.parse(localStorage.getItem("gs_cached_scans") || '["quchi_20261005_merged"]')),
    measurePoints: [],
    completedMeasurements: [],
    tempDistanceObjects: [],
    tempDistanceBadges: [],
    badges2D: [],
    volumeBadges2D: [],
    lastVolumeResult: null,
    lastContoursResult: null,
    lastProfileResult: null,
  };

  // Populate active scan dropdowns strictly with scans from the active project group (Fix #4)
  function populateProjectScanDropdowns(projectGroup, preferredScanId = null) {
    if (projectGroup) {
      STATE.activeProjectGroup = projectGroup;
    } else if (STATE.activeScan && STATE.activeScan.project_group) {
      STATE.activeProjectGroup = STATE.activeScan.project_group;
    }

    let projectScans = STATE.scans.filter((s) => s.project_group === STATE.activeProjectGroup);
    if (!projectScans.length) {
      projectScans = STATE.scans.slice();
    }

    const studioBadge = document.getElementById("studioProjectGroupBadge");
    if (studioBadge) studioBadge.textContent = STATE.activeProjectGroup;
    const cmpBadge = document.getElementById("compareProjectGroupBadge");
    if (cmpBadge) cmpBadge.textContent = STATE.activeProjectGroup;

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
        opt.textContent = s.name;
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
      const x = w * 0.46 + (p.u - c.u) * worldPx;
      const y = h * 0.50 + (p.v - c.v) * worldPx;
      return { x, y };
    };

    const unprojectXY = (x, y) => {
      const w = canvas.width || container.clientWidth || 1280;
      const h = canvas.height || container.clientHeight || 800;
      const worldPx = 256 * Math.pow(2, gsMap.zoom);
      const c = latLonToNormMercator(gsMap.centerLat, gsMap.centerLon);
      const u = c.u + (x - w * 0.46) / worldPx;
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
    const groups = {};
    STATE.scans.forEach((s) => {
      const g = s.project_group || "QuChi Dam";
      if (!groups[g]) {
        groups[g] = {
          project_group: g,
          project_name_zh: s.project_name_zh || "",
          lat: s.lat || 24.92032,
          lon: s.lon || 121.54351,
          scans: [],
        };
      }
      groups[g].scans.push(s);
    });

    const groupList = Object.values(groups);
    gsMap.groups = groupList;

    const countEl = document.getElementById("lblMapClusterCount");
    if (countEl) {
      countEl.textContent = `${groupList.length} Site${groupList.length === 1 ? "" : "s"} (${STATE.scans.length} Scans)`;
    }

    const quickBtns = document.getElementById("mapSiteQuickButtons");
    if (quickBtns) quickBtns.innerHTML = "";

    groupList.forEach((grp) => {
      const count = grp.scans.length;
      const sizePx = count >= 2 ? 50 : 44;
      const blob = document.createElement("div");
      blob.className = "scan-cluster-blob";
      blob.style.position = "absolute";
      blob.style.width = `${sizePx}px`;
      blob.style.height = `${sizePx}px`;
      blob.style.transform = "translate(-50%, -50%)";
      blob.style.pointerEvents = "auto";
      blob.innerHTML = `
        <span>${count}</span>
        <div class="blob-label">${grp.project_group} (${count})</div>
      `;

      blob.addEventListener("mouseenter", () => openClusterPopover(grp));
      blob.addEventListener("click", () => {
        gsMap.centerLat = grp.lat;
        gsMap.centerLon = grp.lon;
        gsMap.zoom = 14.5;
        openClusterPopover(grp);
        gsMap.drawMap();
        openSiteTimeline(grp.project_group);
      });

      grp.el = blob;
      gsMap.markerLayer.appendChild(blob);

      if (quickBtns) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn-xs";
        b.dataset.siteGroup = grp.project_group;
        b.textContent = grp.project_group.split(" ")[0];
        b.title = `${grp.project_group} (${count} Scans)`;
        b.addEventListener("click", () => {
          gsMap.centerLat = grp.lat;
          gsMap.centerLon = grp.lon;
          gsMap.zoom = 14.5;
          openClusterPopover(grp);
          gsMap.drawMap();
          openSiteTimeline(grp.project_group);
        });
        quickBtns.appendChild(b);
      }
    });

    gsMap.drawMap();
    if (groupList.length > 0) {
      const activeGrp = groupList.find((g) => g.project_group === STATE.activeProjectGroup) || groupList[0];
      openClusterPopover(activeGrp);
    }
  }

  function openClusterPopover(grp) {
    const pop = document.getElementById("clusterHoverPopover");
    if (!pop || !grp) return;
    pop.classList.add("active");

    // Scope active project to the selected cluster so Studio & Compare only list this project's scans (Fix #4)
    STATE.activeProjectGroup = grp.project_group;
    if (grp.scans && grp.scans.length > 0) {
      if (!grp.scans.some((s) => s.scan_id === STATE.activeScanId)) {
        STATE.activeScanId = grp.scans[0].scan_id;
        STATE.activeScan = grp.scans[0];
      }
    }
    populateProjectScanDropdowns(grp.project_group, STATE.activeScanId);
    if (gsMap && gsMap.drawMap) gsMap.drawMap();

    document.getElementById("popoverGroupTitle").textContent = `${grp.project_group} (${grp.scans.length})`;
    document.getElementById("popoverGroupSubtitle").textContent =
      `${grp.project_name_zh || "工程掃描群組"} · TWD97 (121) + TWVD2001`;

    const btnCompare = document.getElementById("btnPopoverCompareGroup");
    if (btnCompare) {
      btnCompare.onclick = () => {
        const s1 = grp.scans[0];
        const s2 = grp.scans[1] || grp.scans[0];
        launchMultiDateCompare(s2.scan_id, s1.scan_id);
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

    grp.scans.forEach((scan) => {
      const card = document.createElement("div");
      card.className = "gs-scan-item-card";
      card.style.cursor = "pointer";
      const isCached = STATE.cachedScanIds.has(scan.scan_id);
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div>
            <div style="font-size:12.5px;font-weight:700;color:#0f172a;">${scan.name}</div>
            <div style="font-size:11px;color:#475569;margin-top:2px;">
              ${scan.capture_date} · ${scan.uploader_name} (<span style="color:#0284c7;">${scan.uploader_email}</span>)
            </div>
          </div>
          <span class="gs-crs-pill" style="white-space:nowrap;">RTK σ=${scan.rtk_accuracy_cm}cm</span>
        </div>
        <div style="font-size:10.5px;font-family:monospace;color:#64748b;margin-top:5px;">
          E:${Number(scan.twd97_e).toFixed(1)}m N:${Number(scan.twd97_n).toFixed(1)}m H:+${Number(scan.twd97_h).toFixed(2)}m${isCached ? " · Cached" : ""}
        </div>
        <div class="gs-scan-item-actions">
          <button type="button" class="btn-xs primary" data-action="open3d" title="Open in 3D Studio">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
              <polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>
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
                </button>`
              : ""
          }
        </div>
      `;

      card.addEventListener("click", (ev) => {
        if (ev.target.closest("button") || ev.target.closest("a")) return;
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

      listEl.appendChild(card);
    });
  }

  document.getElementById("btnClosePopover")?.addEventListener("click", () => {
    document.getElementById("clusterHoverPopover")?.classList.remove("active");
  });

  // ============================================================================
  // 1B. SITE TIMELINE (TOP 1/3) + INTERACTIVE 3D PREVIEW (BOTTOM 2/3) + ENLARGE
  // ============================================================================
  let previewThree = null;

  function initPreview3D() {
    if (previewThree) return previewThree;
    const container = document.getElementById("sitePreviewCanvasContainer");
    if (!container) return null;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1120);

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

    const grid = new THREE.GridHelper(220, 22, 0x334155, 0x1e293b);
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
      modelPivot,
      fallbackGroup,
      tilesRenderer: null,
      boundingSphere: null,
    };

    buildReferenceTerrainMesh(previewThree);

    const animatePreview = () => {
      requestAnimationFrame(animatePreview);
      if (STATE.activeView !== "map" || !STATE.siteTimelineOpen) return;
      controls.update();
      if (previewThree.tilesRenderer) {
        camera.updateMatrixWorld();
        previewThree.tilesRenderer.update();
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

  function framePreviewCamera() {
    if (!previewThree) return;
    previewThree.controls.target.set(0, 0, 0);
    previewThree.camera.position.set(38, 30, 44);
    previewThree.camera.lookAt(0, 0, 0);
    previewThree.controls.update();
  }

  // Automatically capture WebGL 3D scan screenshot and persist to tile & server
  async function captureAndPersistScanScreenshot(scanId, ctxThree, showManualToast = false) {
    const targetCtx = ctxThree || previewThree || studioThree;
    if (!targetCtx || !targetCtx.renderer || !scanId) return;
    try {
      targetCtx.renderer.render(targetCtx.scene, targetCtx.camera);
      const dataUrl = targetCtx.renderer.domElement.toDataURL("image/png");
      if (!dataUrl || dataUrl.length < 1024) return;

      const imgEls = document.querySelectorAll(`img[data-scan-thumb="${scanId}"]`);
      imgEls.forEach((img) => {
        img.src = dataUrl;
      });
      if (showManualToast || !STATE.capturedThumbs.has(scanId)) {
        STATE.capturedThumbs.add(scanId);
        await apiPost(`/api/scans/${encodeURIComponent(scanId)}/thumbnail`, {
          data_url: dataUrl,
        }).catch(() => {});
      }
      if (showManualToast) {
        showToast("Captured live 3D scan screenshot to timeline tile");
      }
    } catch (e) {
      console.warn("[GatheringScans] Auto screenshot capture note:", e);
    }
  }

  async function autoCaptureSiteTimelineScreenshots() {
    if (!previewThree || !previewThree.renderer) return;
    const siteScans = STATE.scans.filter((s) => s.project_group === STATE.activeProjectGroup);
    if (!siteScans.length) return;

    const savedPos = previewThree.camera.position.clone();
    const savedTarget = previewThree.controls.target.clone();

    const viewpoints = [
      [38, 30, 44],
      [-36, 28, 42],
      [42, 34, -36],
      [-38, 32, -40],
      [12, 44, 48],
    ];

    for (let i = 0; i < siteScans.length; i++) {
      const s = siteScans[i];
      if (STATE.capturedThumbs.has(s.scan_id)) continue;
      const vp = viewpoints[i % viewpoints.length];
      previewThree.controls.target.set(0, 0, 0);
      previewThree.camera.position.set(vp[0], vp[1], vp[2]);
      previewThree.camera.lookAt(0, 0, 0);
      previewThree.camera.updateMatrixWorld();
      if (previewThree.tilesRenderer) {
        previewThree.tilesRenderer.update();
      }
      previewThree.renderer.render(previewThree.scene, previewThree.camera);
      const dataUrl = previewThree.renderer.domElement.toDataURL("image/png");
      if (dataUrl && dataUrl.length > 1024) {
        STATE.capturedThumbs.add(s.scan_id);
        document.querySelectorAll(`img[data-scan-thumb="${s.scan_id}"]`).forEach((img) => {
          img.src = dataUrl;
        });
        apiPost(`/api/scans/${encodeURIComponent(s.scan_id)}/thumbnail`, {
          data_url: dataUrl,
        }).catch(() => {});
      }
    }

    previewThree.controls.target.copy(savedTarget);
    previewThree.camera.position.copy(savedPos);
    previewThree.camera.lookAt(savedTarget);
    previewThree.controls.update();
    previewThree.renderer.render(previewThree.scene, previewThree.camera);
  }

  function loadScanIntoPreview(scanId) {
    initPreview3D();
    const scan = STATE.scans.find((s) => s.scan_id === scanId) || STATE.scans[0];
    if (!scan || !previewThree) return;

    STATE.selectedTimelineScanId = scan.scan_id;
    STATE.activeScanId = scan.scan_id;
    STATE.activeScan = scan;

    // Resize preview renderer to fit bottom 2/3 container
    const w = Math.max(1, previewThree.container.clientWidth);
    const h = Math.max(1, previewThree.container.clientHeight);
    previewThree.camera.aspect = w / h;
    previewThree.camera.updateProjectionMatrix();
    previewThree.renderer.setSize(w, h);

    const titleEl = document.getElementById("previewScanTitle");
    if (titleEl) titleEl.textContent = scan.name;
    const metaEl = document.getElementById("previewScanMeta");
    if (metaEl) {
      metaEl.textContent = `${scan.capture_date} · ${scan.uploader_name} · E ${Number(scan.twd97_e).toFixed(1)} N ${Number(scan.twd97_n).toFixed(1)} H +${Number(scan.twd97_h).toFixed(2)}m`;
    }

    // Teardown previous preview model
    if (previewThree.tilesRenderer) {
      previewThree.modelPivot.remove(previewThree.tilesRenderer.group);
      previewThree.tilesRenderer.dispose();
      previewThree.tilesRenderer = null;
    }
    while (previewThree.modelPivot.children.length > 0) {
      previewThree.modelPivot.remove(previewThree.modelPivot.children[0]);
    }
    previewThree.modelPivot.rotation.set(0, 0, 0);

    const streamUrl = scan.stream_url || `/stream/${scan.scan_id}/tileset.json`;

    if (scan.stream_type === "glb" || streamUrl.toLowerCase().endsWith(".glb")) {
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
          framePreviewCamera();
          setTimeout(() => autoCaptureSiteTimelineScreenshots(), 550);
        },
        undefined,
        () => {}
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
        const sphere = new THREE.Sphere();
        if (typeof tr.getBoundingSphere === "function" && tr.getBoundingSphere(sphere) && sphere.radius > 0) {
          tr.group.position.set(-sphere.center.x, -sphere.center.y, -sphere.center.z);
          previewThree.modelPivot.rotation.set(THREE.MathUtils.degToRad(270), 0, 0);
          framePreviewCamera();
        }
      });

      tr.addEventListener("load-model", (ev) => {
        if (ev && ev.scene) {
          ev.scene.traverse((c) => {
            if (c.isMesh && c.material) {
              const mats = Array.isArray(c.material) ? c.material : [c.material];
              mats.forEach((m) => applyBrightnessToMaterial(m, STATE.scanBrightness));
            }
          });
          setTimeout(() => autoCaptureSiteTimelineScreenshots(), 650);
        }
      });

      tr.errorTarget = 3.5;
      previewThree.modelPivot.add(tr.group);
      previewThree.tilesRenderer = tr;
    }

    framePreviewCamera();
  }

  function selectTimelineTile(scanId) {
    STATE.selectedTimelineScanId = scanId;
    document.querySelectorAll("#siteTimelineTilesTrack .gs-timeline-tile").forEach((tile) => {
      const isAct = tile.dataset.scanId === scanId;
      tile.classList.toggle("active", isAct);
      const rtkChip = tile.querySelector("[data-rtk-chip]");
      if (rtkChip) rtkChip.classList.toggle("active-indicator", isAct);
    });
    loadScanIntoPreview(scanId);
  }

  function openSiteTimeline(projectGroup, preferredScanId = null) {
    const splitEl = document.getElementById("siteTimelineSplitView");
    if (!splitEl) return;

    const grpName = projectGroup || STATE.activeProjectGroup || "QuChi Dam";
    STATE.activeProjectGroup = grpName;
    STATE.siteTimelineOpen = true;

    // Ensure Map view container is active
    if (STATE.activeView !== "map") {
      switchView("map");
    }
    splitEl.classList.add("active");

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

    // Populate Site Switcher buttons in timeline header
    const switcher = document.getElementById("timelineSiteSwitcher");
    if (switcher) {
      switcher.innerHTML = "";
      const uniqueGroups = [...new Set(STATE.scans.map((s) => s.project_group || "QuChi Dam"))];
      uniqueGroups.forEach((g) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn-xs" + (g === grpName ? " primary" : "");
        b.textContent = g.split(" ")[0];
        b.title = `Switch Timeline to ${g}`;
        b.addEventListener("click", () => openSiteTimeline(g));
        switcher.appendChild(b);
      });
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
            <div class="gs-tile-name" title="${s.name}">${s.name}</div>
          </div>
        `;

        tile.addEventListener("click", () => selectTimelineTile(s.scan_id));
        trackEl.appendChild(tile);
      });
    }

    // Render 3D Scan Preview in Bottom 2/3
    if (chosenScan) {
      setTimeout(() => {
        selectTimelineTile(chosenScan.scan_id);
      }, 30);
    }
  }

  function closeSiteTimeline() {
    STATE.siteTimelineOpen = false;
    document.getElementById("siteTimelineSplitView")?.classList.remove("active");
    if (gsMap && gsMap.drawMap) gsMap.drawMap();
  }

  document.getElementById("btnCloseSiteTimeline")?.addEventListener("click", closeSiteTimeline);

  document.getElementById("btnEnlargePreviewToStudio")?.addEventListener("click", () => {
    const targetScanId = STATE.selectedTimelineScanId || STATE.activeScanId;
    switchView("studio", targetScanId);
  });

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

  // Apply Scan Brightness (0.1x – 4.0x) to any Three.js material (Fix #2, matching Gathering Cloud scan-shaders.js)
  function applyBrightnessToMaterial(mat, brightness) {
    if (!mat) return;
    const b = Math.max(0.1, Math.min(4.0, Number(brightness) || 1.0));
    if (!mat.userData) mat.userData = {};
    if (!mat.userData.PassUniforms) {
      mat.userData.PassUniforms = {
        uBrightness: { value: b },
      };
    } else if (mat.userData.PassUniforms.uBrightness) {
      mat.userData.PassUniforms.uBrightness.value = b;
    }

    if (!mat.userData._hasBrightnessShader) {
      mat.userData._hasBrightnessShader = true;
      mat.customProgramCacheKey = function () {
        return `GS_ScanShader_v2_${mat.type || "Standard"}_${mat.map ? "1" : "0"}_${mat.vertexColors ? "1" : "0"}`;
      };
      const prevOnBeforeCompile = mat.onBeforeCompile;
      mat.onBeforeCompile = function (shader, renderer) {
        if (typeof prevOnBeforeCompile === "function") {
          prevOnBeforeCompile.call(this, shader, renderer);
        }
        shader.uniforms.uBrightness = mat.userData.PassUniforms.uBrightness;
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <common>",
          `#include <common>
           uniform float uBrightness;
           vec3 gcScanPhotoColor = vec3(0.0);
           bool gcHasPhotoColor = false;`
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
           gl_FragColor.rgb = basePhoto * uBrightness;`
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

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f19);

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

    const grid = new THREE.GridHelper(240, 24, 0x334155, 0x1e293b);
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
      } else if ((STATE.activeTool === "volume" || STATE.activeTool === "area") && STATE.measurePoints.length >= 1) {
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
        },
        undefined,
        (err) => {
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
        const sphere = new THREE.Sphere();
        if (typeof tr.getBoundingSphere === "function" && tr.getBoundingSphere(sphere) && sphere.radius > 0) {
          tr.group.position.set(-sphere.center.x, -sphere.center.y, -sphere.center.z);
          // Z-up TWD97 tilesets: rotate -90 deg on X so elevation points +Y
          studioThree.modelPivot.rotation.set(THREE.MathUtils.degToRad(270), 0, 0);
          studioThree.boundingSphere = sphere;
          frameStudioCamera();
        }
      });

      tr.addEventListener("load-model", (ev) => {
        if (ev && ev.scene) {
          ev.scene.traverse((c) => {
            if (c.isMesh && c.material) {
              const mats = Array.isArray(c.material) ? c.material : [c.material];
              mats.forEach((m) => applyBrightnessToMaterial(m, STATE.scanBrightness));
            }
          });
        }
      });

      tr.errorTarget = 3.5;
      studioThree.modelPivot.add(tr.group);
      studioThree.tilesRenderer = tr;
    }

    renderCommentPins3D();
  }

  function frameStudioCamera() {
    if (!studioThree) return;
    studioThree.controls.target.set(0, 0, 0);
    studioThree.camera.position.set(42, 34, 48);
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
      b.el.style.left = `${x}px`;
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
        showToast(`Cut/Fill polygon locked (${STATE.measurePoints.length} vertices)`);
        STATE.measurePoints = [];
        return;
      }

      STATE.measurePoints.push(pt.clone());
      const pts = STATE.measurePoints.slice();

      // Immediately draw the placed vertices & edges in volumeGroup so they never disappear
      drawPlacedCutFillPolygon3D(pts, null);

      if (pts.length >= 3) {
        openCutFillVolumeInspector(pts);
      } else {
        showToast(`Cut/Fill Point ${pts.length} placed — click ${3 - pts.length} more point${3 - pts.length === 1 ? "" : "s"} to compute volume`);
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
        <div style="font-size:11px;color:#475569;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;margin-bottom:9px;line-height:1.4;">
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
            <div class="val" style="color:#0284c7;">+${res.fill_volume_m3} m³</div>
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
        <div style="font-size:11px;color:#475569;background:#f8fafc;padding:9px 10px;border-radius:8px;border:1px solid #e2e8f0;margin-bottom:10px;line-height:1.5;">
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

  // 3B. Elevation Contours & AutoCAD .DWG / .DXF Exporter
  async function openContoursInspector() {
    showSidePanel(
      `<span>Elevation Contours &amp; CAD Export</span>`,
      `
      <p style="font-size:11.5px;color:#475569;margin-bottom:10px;line-height:1.45;">
        Extracts 3D elevation contours in <strong>TWD97 (121) + TWVD2001</strong> and exports CAD layers (<code>CONTOUR-MAJOR</code>, <code>CONTOUR-MINOR</code>, <code>CONTOUR-LABELS</code>) to <code>.dwg</code> and <code>.dxf</code>.
      </p>
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
      <button type="button" class="gs-top-btn accent" style="width:100%;justify-content:center;margin-bottom:8px;" id="btnGenerateContours" title="Generate 3D Contours &amp; CAD Files">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
          <ellipse cx="12" cy="12" rx="9" ry="5"/><ellipse cx="12" cy="12" rx="5" ry="2.5"/>
        </svg>
        <span>Generate</span>
      </button>
      <div id="cntResultContainer"></div>
      `
    );

    const runContours = async () => {
      const minor = parseFloat(document.getElementById("cntMinorStep")?.value || "0.5");
      const major = parseFloat(document.getElementById("cntMajorStep")?.value || "2.5");
      try {
        const res = await apiPost("/api/survey/contours", {
          scan_id: STATE.activeScanId,
          minor_interval_m: minor,
          major_interval_m: major,
        });
        STATE.lastContoursResult = res;
        renderContours3DAndPanel(res);
      } catch (err) {
        showToast(`Contour Error: ${err.message}`);
      }
    };

    document.getElementById("btnGenerateContours")?.addEventListener("click", runContours);
    await runContours();
  }

  function renderContours3DAndPanel(res) {
    const box = document.getElementById("cntResultContainer");
    if (box) {
      box.innerHTML = `
        <div class="gs-metric-grid">
          <div class="gs-metric-box">
            <div class="lbl">Extracted Contours</div>
            <div class="val" style="color:#0284c7;">${res.contour_count} lines</div>
          </div>
          <div class="gs-metric-box">
            <div class="lbl">TWVD2001 Range</div>
            <div class="val">+${res.elevation_range_m[0]}~+${res.elevation_range_m[1]}m</div>
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-top:8px;">
          <a class="btn-xs primary" style="flex:1;" href="${res.dwg_url}" download title="Export AutoCAD .DWG">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span>DWG</span>
          </a>
          <a class="btn-xs" style="flex:1;" href="${res.dxf_url}" download title="Export AutoCAD .DXF">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span>DXF</span>
          </a>
        </div>
      `;
    }

    if (!studioThree) return;
    while (studioThree.contourGroup.children.length > 0) {
      studioThree.contourGroup.remove(studioThree.contourGroup.children[0]);
    }

    (res.contours || []).forEach((c) => {
      const pts = c.points_local.map((p) => new THREE.Vector3(p[0], p[1] + 0.15, p[2]));
      const geom = new THREE.BufferGeometry().setFromPoints(pts);
      const color = c.is_major ? 0x0284c7 : 0x64748b;
      const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color }));
      studioThree.contourGroup.add(line);
    });
    showToast(`Rendered ${res.contour_count} 3D elevation contours in TWD97 (121) + TWVD2001`);
  }

  // 3C. Cross-Section Elevation Profile Graph
  async function openProfileInspector() {
    showSidePanel(
      `<span>Cross-Section Profile</span>`,
      `
      <p style="font-size:11.5px;color:#475569;margin-bottom:10px;">
        Compares TWVD2001 elevation profile along the section line between active scan and baseline epoch.
      </p>
      <canvas id="profileChartCanvas" width="330" height="180" style="width:100%;background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;"></canvas>
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
    ctx.strokeStyle = "#e2e8f0";
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
          <div class="val" style="color:#0284c7;">${res.total_length_m} m</div>
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
      `<div style="font-size:12px;color:#475569;">Querying calibrated PIX4Dcatch RTK camera poses...</div>`
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
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px;margin-top:8px;">
            <img src="${p.url}" alt="${p.filename}" style="width:100%;height:140px;object-fit:cover;border-radius:6px;background:#e2e8f0;" onerror="this.style.display='none'" />
            <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:11px;font-weight:700;color:#0f172a;">
              <span>${p.filename}</span>
              <span style="color:#0284c7;">RTK σ=${p.rtk_h_sigma_cm}cm</span>
            </div>
            <div style="font-size:10.5px;font-family:monospace;color:#64748b;margin-top:2px;">
              E:${p.camera_twd97_e}m | N:${p.camera_twd97_n}m | H:+${p.camera_twd97_h}m | Dist:${p.distance_m}m
            </div>
          </div>
        `
        )
        .join("");

      showSidePanel(
        `<span>RTK Camera Inspector</span>`,
        `
        <div style="font-size:11px;font-family:monospace;color:#475569;margin-bottom:6px;">
          Target TWD97: E:${res.target_twd97.e}m, N:${res.target_twd97.n}m, H:+${res.target_twd97.h}m
        </div>
        ${photosHtml || '<div style="font-size:12px;color:#64748b;">No local raw photos found for this point.</div>'}
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
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:9px;margin-top:8px;">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:#0284c7;font-weight:700;">
            <span>${c.author_name}</span>
            <span style="color:#64748b;font-weight:500;">${c.created_at.slice(0, 16)}</span>
          </div>
          <div style="font-size:12px;color:#0f172a;margin-top:4px;">${c.text}</div>
          <div style="font-size:10.5px;font-family:monospace;color:#64748b;margin-top:4px;">
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
      <p style="font-size:11.5px;color:#475569;margin-bottom:10px;">
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

      <div style="border-top:1px solid #e2e8f0;padding-top:12px;margin-top:6px;">
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
      if (box) box.innerHTML = `<div style="font-size:12px;color:#0284c7;">Running GC_ScanOptimizer (${preset})...</div>`;
      try {
        const res = await apiPost("/api/optimizer/optimize", {
          scan_id: STATE.activeScanId,
          preset,
          fast_mode: true,
        });
        if (box) {
          box.innerHTML = `
            <div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;padding:10px;font-size:12px;color:#0f172a;">
              <div style="color:#0284c7;font-weight:700;">GC_ScanOptimizer Completed (${res.duration_s}s)</div>
              <div style="margin-top:4px;">Preset: <b>${res.preset}</b> (Max Texture: ${res.texture_limit}px)</div>
              <div>Size: ${res.original_mb} MB → <b>${res.compressed_mb} MB (-${res.reduction_pct}%)</b></div>
              <div style="font-size:10.5px;color:#64748b;margin-top:3px;">CRS: ${res.crs}</div>
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
            <div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;padding:10px;font-size:12px;color:#0f172a;">
              <div style="color:#0284c7;font-weight:700;">SpatialCutter Completed (${res.duration_s}s)</div>
              <div>Mode: <b>${res.mode}</b> · Area: <b>${res.cropped_area_m2} m²</b></div>
              <div style="font-size:10.5px;color:#64748b;">Output: ${res.output_dir}</div>
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

  // ============================================================================
  // 4. MULTI-DATE SIDE-BY-SIDE CURTAIN SLIDER (Requirement 4)
  // ============================================================================
  let compareCtx = null;

  function initCompareView() {
    if (compareCtx) return compareCtx;
    const leftContainer = document.getElementById("compareLeftLayer");
    const rightContainer = document.getElementById("compareRightLayer");
    if (!leftContainer || !rightContainer) return null;

    const createEpochScene = (container, tintColor, isLatest) => {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(isLatest ? 0x091322 : 0x0d1829);
      const camera = new THREE.PerspectiveCamera(
        48,
        Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
        0.1,
        10000
      );
      camera.position.set(22, 16, 25);
      camera.lookAt(0, 1.2, 0);

      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
      container.appendChild(renderer.domElement);

      scene.add(new THREE.GridHelper(120, 24, 0x334155, 0x1e293b));

      // Terrain + Epoch Stockpile Mesh (MeshBasicMaterial with baked slope shading for crisp headless & GPU rendering)
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
      scene.add(mesh);

      // Subtle Topographic Wireframe Mesh Overlay
      const wireMat = new THREE.MeshBasicMaterial({
        color: isLatest ? 0x38bdf8 : 0x64748b,
        wireframe: true,
        transparent: true,
        opacity: 0.18,
      });
      const wireMesh = new THREE.Mesh(geom, wireMat);
      wireMesh.position.y = 0.02;
      scene.add(wireMesh);

      // 3D Elevation Contour Rings around Stockpile
      const maxElev = isLatest ? 5.2 : 1.1;
      for (let h = 0.5; h <= maxElev; h += 0.75) {
        const radius = Math.max(1.8, 13.5 * Math.sqrt(Math.max(0.05, -Math.log(h / (isLatest ? 5.6 : 1.35)) / 1.45)));
        const pts = [];
        for (let s = 0; s <= 64; s++) {
          const ang = (s / 64) * Math.PI * 2;
          pts.push(new THREE.Vector3(Math.cos(ang) * radius, h + 0.05, Math.sin(ang) * radius));
        }
        const cLine = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: isLatest ? 0xfbbf24 : 0x38bdf8 })
        );
        scene.add(cLine);
      }

      const pivot = new THREE.Group();
      scene.add(pivot);

      return { container, scene, camera, renderer, mesh, pivot, tilesRenderer: null };
    };

    const left = createEpochScene(leftContainer, 0x38bdf8, false);
    const right = createEpochScene(rightContainer, 0x10b981, true);

    // Synchronized OrbitControls on the stage
    const stage = document.getElementById("compareStage");
    const controls = new THREE.OrbitControls(left.camera, stage);
    controls.target.set(0, 1.5, 0);
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

    // Delta-Z Heatmap Toggle
    document.getElementById("chkDeltaZHeatmap")?.addEventListener("change", (e) => {
      const active = e.target.checked;
      const pos = right.mesh.geometry.attributes.position;
      const col = right.mesh.geometry.attributes.color;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        const t = Math.min(1, Math.max(0, (y + 0.3) / 5.5));
        if (active) {
          // Disciplined Monochromatic Slate -> GatheringCloud Blue (#0284c7) -> Ice Cyan (+ΔZ Fill)
          if (t < 0.5) {
            const k = t / 0.5;
            col.setXYZ(i, 0.18 - 0.16 * k, 0.24 + 0.28 * k, 0.33 + 0.45 * k);
          } else {
            const k = (t - 0.5) / 0.5;
            col.setXYZ(i, 0.02 + 0.72 * k, 0.52 + 0.38 * k, 0.78 + 0.20 * k);
          }
        } else {
          col.setXYZ(i, 0.24 + 0.32 * t, 0.30 + 0.34 * t, 0.36 + 0.34 * t);
        }
      }
      col.needsUpdate = true;
      showToast(active ? "Enabled ΔZ Elevation Change Heatmap" : "Restored RGB Texture Shading");
    });

    const loop = () => {
      requestAnimationFrame(loop);
      if (STATE.activeView !== "compare") return;
      controls.update();
      right.camera.position.copy(left.camera.position);
      right.camera.quaternion.copy(left.camera.quaternion);
      left.renderer.render(left.scene, left.camera);
      right.renderer.render(right.scene, right.camera);
    };
    requestAnimationFrame(loop);

    compareCtx = { left, right, controls };
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
  }

  // ============================================================================
  // 5. MODALS: SMART QUEUE, SCOPED SHARING, OFFLINE CACHE
  // ============================================================================
  function openModal(id) {
    document.getElementById(id)?.classList.add("active");
  }
  function closeModal(id) {
    document.getElementById(id)?.classList.remove("active");
  }
  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
  });

  // 5A. PIX4Dmatic Smart Queue Modal
  async function openQueueModal() {
    openModal("modalQueue");
    const tbody = document.getElementById("queueTableBody");
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="8" style="color:#64748b;">Loading...</td></tr>`;
    try {
      const qData = await apiGet("/api/queue/status");
      document.getElementById("lblQueueInboxDir").textContent = qData.inbox_dir;
      const gchatInput = document.getElementById("inputGChatWebhookUrl");
      if (gchatInput && typeof qData.gchat_webhook_url === "string") {
        gchatInput.value = qData.gchat_webhook_url;
      }
      tbody.innerHTML = "";
      STATE.scans.forEach((s) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td><b style="color:#0f172a;">${s.name}</b><br><span style="font-size:10.5px;color:#64748b;">${s.scan_id}</span></td>
          <td style="color:#475569;">${s.project_group}</td>
          <td><span style="color:#0f172a;font-weight:600;">${s.uploader_name}</span><br><span style="font-size:10.5px;color:#64748b;">${s.uploader_email} · ${s.capture_date}</span></td>
          <td><span style="color:#0f172a;font-weight:600;">${s.image_count} imgs</span><br><span style="font-size:10.5px;color:#64748b;">${s.size_mb} MB</span></td>
          <td><span class="gs-crs-pill">${s.crs} · ${s.texture_resolution}px</span></td>
          <td style="font-family:monospace;font-weight:700;color:#0f172a;">${s.priority_score}</td>
          <td><span class="gs-crs-pill">${s.status.toUpperCase()}</span></td>
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
      tbody.innerHTML = `<tr><td colspan="8" style="color:#475569;">${err.message}</td></tr>`;
    }
  }

  async function previewGstForScan(scanId) {
    try {
      const res = await apiPost("/api/queue/preview-gst", { scan_id: scanId });
      const box = document.getElementById("gstScriptPreviewBox");
      const code = document.getElementById("gstScriptCode");
      if (box && code) {
        box.style.display = "block";
        code.textContent = res.gst_script;
      }
    } catch (err) {
      showToast(`GST Preview Error: ${err.message}`);
    }
  }

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
        tbody.innerHTML = `<tr><td colspan="7" style="color:#64748b;">No external share links created yet.</td></tr>`;
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
          <td><b style="color:#0f172a;">${l.label}</b></td>
          <td><span class="gs-crs-pill">${l.scope_type.toUpperCase()}: ${l.target_id}</span></td>
          <td><code style="color:#0284c7;font-size:11px;">/s/${l.token}</code></td>
          <td style="font-size:11px;color:#475569;">${perms || "View"}</td>
          <td style="color:#0f172a;font-weight:600;">${l.view_count}</td>
          <td>${
            l.revoked
              ? '<span style="color:#64748b;font-weight:700;">REVOKED</span>'
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
      tbody.innerHTML = `<tr><td colspan="7" style="color:#475569;">${err.message}</td></tr>`;
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

  // 5C. Client-Side Offline Cache Modal (Requirement 5)
  async function openOfflineCacheModal() {
    openModal("modalOfflineCache");
    const tbody = document.getElementById("offlineCacheTableBody");
    if (!tbody) return;
    tbody.innerHTML = "";
    STATE.scans.forEach((s) => {
      const isCached = STATE.cachedScanIds.has(s.scan_id);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><b style="color:#0f172a;">${s.name}</b></td>
        <td style="color:#475569;">${s.project_group}</td>
        <td><span class="gs-crs-pill">${s.crs}</span></td>
        <td>${
          isCached
            ? '<span class="gs-crs-pill">Cached</span>'
            : '<span style="color:#64748b;">Uncached</span>'
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
  // 6. VIEW NAVIGATION & INITIALIZATION
  // ============================================================================
  function switchView(viewName, optionalScanId = null) {
    STATE.activeView = viewName;
    document.querySelectorAll("#mainModeSwitcher .btn-seg").forEach((b) => {
      b.classList.toggle("active", b.dataset.view === viewName);
    });
    document.getElementById("viewMap")?.classList.toggle("active", viewName === "map");
    document.getElementById("viewStudio")?.classList.toggle("active", viewName === "studio");
    document.getElementById("viewCompare")?.classList.toggle("active", viewName === "compare");

    if (viewName === "map") {
      setTimeout(() => {
        if (gsMap && gsMap.drawMap) gsMap.drawMap();
      }, 60);
    } else if (viewName === "studio") {
      initStudio3D();
      handleResize();
      loadScanIntoStudio(optionalScanId || STATE.activeScanId);
    } else if (viewName === "compare") {
      populateProjectScanDropdowns(STATE.activeProjectGroup, STATE.activeScanId);
      initCompareView();
      handleResize();
    }
  }

  document.querySelectorAll("#mainModeSwitcher .btn-seg").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.view === "map" && STATE.siteTimelineOpen) {
        closeSiteTimeline();
      }
      switchView(btn.dataset.view);
    });
  });

  function handleResize() {
    if (previewThree && STATE.activeView === "map" && STATE.siteTimelineOpen) {
      const w = Math.max(1, previewThree.container.clientWidth);
      const h = Math.max(1, previewThree.container.clientHeight);
      previewThree.camera.aspect = w / h;
      previewThree.camera.updateProjectionMatrix();
      previewThree.renderer.setSize(w, h);
      if (previewThree.tilesRenderer) {
        previewThree.tilesRenderer.setResolutionFromRenderer(previewThree.camera, previewThree.renderer);
      }
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
      });
    }
  }

  window.addEventListener("resize", handleResize);

  async function refreshScansCatalog() {
    try {
      const data = await apiGet("/api/scans");
      STATE.scans = data.scans || [];
      STATE.materials = data.materials || {};
      if (typeof data.pc_online === "boolean") {
        STATE.pcOnline = data.pc_online;
        updatePcStatusUI();
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

      // Fix #4: Strictly scope active scan & compare dropdowns to the active project only
      const activeScanObj =
        STATE.scans.find((s) => s.scan_id === STATE.activeScanId) || STATE.scans[0];
      if (activeScanObj && activeScanObj.project_group) {
        STATE.activeProjectGroup = activeScanObj.project_group;
      }
      populateProjectScanDropdowns(STATE.activeProjectGroup, STATE.activeScanId);

      renderMapClusters();
    } catch (err) {
      document.body.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#f8fafc;color:#0f172a;font-family:sans-serif;padding:24px;">
          <div style="max-width:480px;background:#ffffff;border:1px solid #cbd5e1;border-radius:12px;padding:24px;text-align:center;box-shadow:0 12px 32px rgba(15,23,42,0.08);">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#0284c7" stroke-width="1.8" style="margin-bottom:10px;">
              <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            <h2 style="font-size:17px;color:#0f172a;">Access Restricted or Link Revoked</h2>
            <p style="font-size:13px;color:#475569;margin-top:8px;">${err.message}</p>
          </div>
        </div>
      `;
    }
  }

  // Bootstrap Application
  window.addEventListener("DOMContentLoaded", async () => {
    await refreshScansCatalog();
    const urlScan = new URLSearchParams(window.location.search).get("scan");
    if (urlScan) {
      switchView("studio", urlScan);
    }
  });
})();
