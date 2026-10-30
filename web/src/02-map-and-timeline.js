/**
 * GatheringScans Frontend Module 02 — Google Maps Overview, Spatial Clustering, Site Timeline, 3D Preview & Bin/Rerun Modals
 */
"use strict";

  // ============================================================================
  // 1. GOOGLE MAPS OVERVIEW & SPATIAL CLUSTERING (Requirement 4.a & Fix #3)
  // ============================================================================
  let gsMap = null;
  const _sharedGoogleTileCache = new Map();

  function latLonToNormMercator(lat, lon) {
    const u = (lon + 180) / 360;
    const sinLat = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
    const v = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
    return { u, v, x: u, y: v };
  }

  function getGoogleTileImage(lyrs, z, tx, ty, onLoad) {
    if (!Number.isFinite(z) || !Number.isFinite(tx) || !Number.isFinite(ty)) return null;
    const maxTile = 1 << z;
    if (ty < 0 || ty >= maxTile) return null;
    const wrappedTx = ((tx % maxTile) + maxTile) % maxTile;
    const cacheKey = `${lyrs}_${z}_${wrappedTx}_${ty}`;
    if (_sharedGoogleTileCache.has(cacheKey)) {
      const existing = _sharedGoogleTileCache.get(cacheKey);
      if (existing.loaded) return existing;
      if (!existing.failed && typeof onLoad === "function" && !existing.callbacks.includes(onLoad)) {
        existing.callbacks.push(onLoad);
      }
      return existing;
    }
    const sub = (wrappedTx + ty) & 3;
    const img = new Image();
    img.crossOrigin = "anonymous";
    const callbacks = typeof onLoad === "function" ? [onLoad] : [];
    const entry = { img, loaded: false, failed: false, callbacks, _retriedBackupSub: false };
    _sharedGoogleTileCache.set(cacheKey, entry);
    img.onload = () => {
      entry.loaded = true;
      entry.failed = false;
      if (gsMap && typeof gsMap.drawMap === "function") gsMap.drawMap();
      const cbs = entry.callbacks.splice(0, entry.callbacks.length);
      for (let i = 0; i < cbs.length; i++) {
        try {
          cbs[i](entry);
        } catch (_) {}
      }
    };
    img.onerror = () => {
      if (!entry._retriedBackupSub) {
        entry._retriedBackupSub = true;
        const backupSub = (sub + 1) & 3;
        img.src = `https://mt${backupSub}.google.com/vt/lyrs=${lyrs}&hl=zh-TW&x=${wrappedTx}&y=${ty}&z=${z}`;
        return;
      }
      entry.failed = true;
      entry.callbacks.length = 0;
    };
    img.src = `https://mt${sub}.google.com/vt/lyrs=${lyrs}&hl=zh-TW&x=${wrappedTx}&y=${ty}&z=${z}`;
    return entry;
  }
  window.getGoogleTileImage = getGoogleTileImage;

  function normMercatorToLatLon(u, v) {
    const lon = u * 360 - 180;
    const n = Math.PI - 2 * Math.PI * v;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lat, lon };
  }

  function fitMapToAllGeorefGroups(targetGroups = null) {
    if (!gsMap) return;
    const groups = (targetGroups || getProjectGroupsList("")).filter(
      (g) => g && g.hasGeoref && Number.isFinite(g.lat) && Number.isFinite(g.lon)
    );
    if (groups.length === 0) {
      gsMap.centerLat = 0;
      gsMap.centerLon = 0;
      gsMap.zoom = 2.0;
      return;
    }
    if (groups.length === 1) {
      gsMap.centerLat = groups[0].lat;
      gsMap.centerLon = groups[0].lon;
      gsMap.zoom = 14.5;
      return;
    }
    let minLat = Infinity,
      maxLat = -Infinity,
      minLon = Infinity,
      maxLon = -Infinity;
    groups.forEach((g) => {
      if (g.lat < minLat) minLat = g.lat;
      if (g.lat > maxLat) maxLat = g.lat;
      if (g.lon < minLon) minLon = g.lon;
      if (g.lon > maxLon) maxLon = g.lon;
    });
    gsMap.centerLat = (minLat + maxLat) * 0.5;
    gsMap.centerLon = (minLon + maxLon) * 0.5;
    const pMin = latLonToNormMercator(maxLat, minLon);
    const pMax = latLonToNormMercator(minLat, maxLon);
    const du = Math.abs(pMax.u - pMin.u);
    const dv = Math.abs(pMax.v - pMin.v);
    const w = Math.max(320, gsMap.container?.clientWidth || 840);
    const h = Math.max(240, gsMap.container?.clientHeight || 640);
    const zX = du > 1e-9 ? Math.log2((w * 0.68) / (256 * du)) : 14.5;
    const zY = dv > 1e-9 ? Math.log2((h * 0.68) / (256 * dv)) : 14.5;
    gsMap.zoom = Math.max(2.0, Math.min(15.0, Math.min(zX, zY)));
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
      "position:absolute;bottom:10px;left:14px;background:var(--ui-bg-window);border:1px solid var(--ui-border-strong);border-radius:6px;padding:3px 9px;font-size:11px;font-weight:600;color:var(--ui-text-primary);z-index:400;pointer-events:none;box-shadow:var(--ui-shadow-hud);";
    gAttr.textContent = "Google Maps";
    container.appendChild(gAttr);

    // Touch-friendly Map Zoom & Reset Controls (bottom-right)
    const zoomCtrl = document.createElement("div");
    zoomCtrl.className = "gs-map-zoom-controls";
    zoomCtrl.innerHTML = `
      <button type="button" class="gs-map-zoom-btn" id="btnMapZoomIn" title="${tr("放大", "Zoom In")}" data-i18n-title-zh="放大" data-i18n-title-en="Zoom In" aria-label="Zoom In">+</button>
      <button type="button" class="gs-map-zoom-btn" id="btnMapZoomOut" title="${tr("縮小", "Zoom Out")}" data-i18n-title-zh="縮小" data-i18n-title-en="Zoom Out" aria-label="Zoom Out">−</button>
      <button type="button" class="gs-map-zoom-btn" id="btnMapResetView" title="${tr("顯示所有掃描工區", "Fit All Scan Sites")}" data-i18n-title-zh="顯示所有掃描工區" data-i18n-title-en="Fit All Scan Sites" aria-label="Fit All Scan Sites">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      </button>
    `;
    container.appendChild(zoomCtrl);

    gsMap = {
      container,
      canvas,
      ctx: canvas.getContext("2d"),
      markerLayer,
      centerLat: 0,
      centerLon: 0,
      zoom: 2.0,
      _initialFitDone: false,
      groups: [],
      tileCache: _sharedGoogleTileCache,
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

    const updateCursorCoordsHud = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      const { lat, lon } = unprojectXY(clientX - rect.left, clientY - rect.top);
      const coordEl = document.getElementById("mapCursorCoords");
      if (!coordEl) return;
      if (lat >= 21.5 && lat <= 26.5 && lon >= 119.8 && lon <= 122.3) {
        const tm = wgs84ToTransverseMercatorJS(lat, lon, 121.0, 250000.0, 0.9999, 298.257222101);
        coordEl.innerHTML = `<div style="white-space:nowrap;">TWD97(121) E: ${tm.e.toFixed(1)}m | N: ${tm.n.toFixed(1)}m</div><div style="white-space:nowrap;">WGS84: ${lat.toFixed(5)}°N, ${lon.toFixed(5)}°E</div>`;
      } else if (lat >= 21.5 && lat <= 26.5 && lon >= 118.0 && lon < 119.8) {
        const tm = wgs84ToTransverseMercatorJS(lat, lon, 119.0, 250000.0, 0.9999, 298.257222101);
        coordEl.innerHTML = `<div style="white-space:nowrap;">TWD97(119) E: ${tm.e.toFixed(1)}m | N: ${tm.n.toFixed(1)}m</div><div style="white-space:nowrap;">WGS84: ${lat.toFixed(5)}°N, ${lon.toFixed(5)}°E</div>`;
      } else if (Math.abs(lat) <= 84.0) {
        const zone = Math.max(1, Math.min(60, Math.floor((lon + 180.0) / 6.0) + 1));
        const lon0 = (zone - 1) * 6.0 - 180.0 + 3.0;
        const utm = wgs84ToTransverseMercatorJS(lat, lon, lon0, 500000.0, 0.9996, 298.257223563);
        const uN = lat < 0 ? utm.n + 10000000.0 : utm.n;
        const hemi = lat >= 0 ? "N" : "S";
        coordEl.innerHTML = `<div style="white-space:nowrap;">UTM ${zone}${hemi} E: ${utm.e.toFixed(1)}m | N: ${uN.toFixed(1)}m</div><div style="white-space:nowrap;">WGS84: ${lat.toFixed(5)}°, ${lon.toFixed(5)}°</div>`;
      } else {
        coordEl.innerHTML = `<div style="white-space:nowrap;">WGS84: ${lat.toFixed(5)}°, ${lon.toFixed(5)}°</div>`;
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
      const clampedZoom = Math.max(2.0, Math.min(23.0, nextZoom));
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
      const zInt = Math.max(2, Math.min(19, Math.floor(gsMap.zoom)));
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

      // Dynamic Viewport Coordinate Grid Overlay (Zero Hardcoded Lat/Lon Bounds)
      ctx.strokeStyle = STATE.mapLyrs === "m" ? "rgba(2, 132, 199, 0.16)" : "rgba(56, 189, 248, 0.18)";
      ctx.lineWidth = 1;
      ctx.fillStyle = STATE.mapLyrs === "m" ? "rgba(15, 23, 42, 0.72)" : "rgba(248, 250, 252, 0.80)";
      ctx.font = "600 10px Consolas, monospace";

      const nw = unprojectXY(0, 0);
      const se = unprojectXY(w, h);
      const viewMinLon = Math.max(-180, Math.min(nw.lon, se.lon));
      const viewMaxLon = Math.min(180, Math.max(nw.lon, se.lon));
      const viewMinLat = Math.max(-85, Math.min(nw.lat, se.lat));
      const viewMaxLat = Math.min(85, Math.max(nw.lat, se.lat));
      const gridStep =
        gsMap.zoom >= 15 ? 0.005 : gsMap.zoom >= 13 ? 0.02 : gsMap.zoom >= 10 ? 0.05 : gsMap.zoom >= 7 ? 0.5 : 10.0;

      const startLon = Math.floor(viewMinLon / gridStep) * gridStep;
      for (let lon = startLon, n = 0; lon <= viewMaxLon + gridStep && n < 40; lon += gridStep, n++) {
        const p = projectLatLon(gsMap.centerLat, lon);
        ctx.beginPath();
        ctx.moveTo(p.x, 0);
        ctx.lineTo(p.x, h);
        ctx.stroke();
        const isTm2 = gsMap.centerLat >= 21.5 && gsMap.centerLat <= 26.5 && lon >= 118.0 && lon <= 122.3;
        let lbl;
        if (isTm2) {
          const lon0 = lon < 119.8 ? 119.0 : 121.0;
          const tm = wgs84ToTransverseMercatorJS(gsMap.centerLat, lon, lon0, 250000.0, 0.9999, 298.257222101);
          lbl = `E:${Math.round(tm.e)}m`;
        } else {
          lbl = `${lon.toFixed(gsMap.zoom >= 13 ? 3 : 2)}°`;
        }
        ctx.fillText(lbl, p.x + 4, h - 12);
      }
      const startLat = Math.floor(viewMinLat / gridStep) * gridStep;
      for (let lat = startLat, n = 0; lat <= viewMaxLat + gridStep && n < 40; lat += gridStep, n++) {
        const p = projectLatLon(lat, gsMap.centerLon);
        ctx.beginPath();
        ctx.moveTo(0, p.y);
        ctx.lineTo(w, p.y);
        ctx.stroke();
        const isTm2 = lat >= 21.5 && lat <= 26.5 && gsMap.centerLon >= 118.0 && gsMap.centerLon <= 122.3;
        let lbl;
        if (isTm2) {
          const lon0 = gsMap.centerLon < 119.8 ? 119.0 : 121.0;
          const tm = wgs84ToTransverseMercatorJS(lat, gsMap.centerLon, lon0, 250000.0, 0.9999, 298.257222101);
          lbl = `N:${Math.round(tm.n)}m`;
        } else {
          lbl = `${lat.toFixed(gsMap.zoom >= 13 ? 3 : 2)}°`;
        }
        ctx.fillText(lbl, 14, p.y - 4);
      }

      // Draw 2D True Orthomosaic Nadir Plan Overlays for Georeferenced Scans when enabled
      if (typeof drawMapTrueOrthoOverlays === "function") {
        drawMapTrueOrthoOverlays(ctx, gsMap);
      }

      // Draw Scan Geofence Rings & Position Cluster Blobs (Strictly Georeferenced Sites Only)
      gsMap.groups.forEach((grp) => {
        if (!grp.hasGeoref || !Number.isFinite(grp.lat) || !Number.isFinite(grp.lon)) return;
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
      gsMap.zoom = Math.min(23.0, gsMap.zoom + 0.75);
      drawMap();
    });
    document.getElementById("btnMapZoomOut")?.addEventListener("click", (e) => {
      e.stopPropagation();
      gsMap.zoom = Math.max(2.0, gsMap.zoom - 0.75);
      drawMap();
    });
    document.getElementById("btnMapResetView")?.addEventListener("click", (e) => {
      e.stopPropagation();
      fitMapToAllGeorefGroups();
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

  function renderMapClusters(opts = {}) {
    initMap();
    if (!gsMap) return;

    gsMap.markerLayer.innerHTML = "";
    const allGroups = getProjectGroupsList("");
    const visibleGroups = getProjectGroupsList(STATE.projectFilterQuery);
    gsMap.groups = visibleGroups;
    if (!gsMap._initialFitDone && allGroups.some((g) => g.hasGeoref)) {
      fitMapToAllGeorefGroups(allGroups);
      gsMap._initialFitDone = true;
    }

    const countEl = document.getElementById("lblMapClusterCount");
    if (countEl) {
      if (STATE.projectFilterQuery) {
        countEl.textContent = tr(
          `${visibleGroups.length}/${allGroups.length} 個工區`,
          `${visibleGroups.length}/${allGroups.length} Sites`
        );
      } else {
        countEl.textContent = tr(
          `${allGroups.length} 個工區 · ${STATE.scans.length} 組掃描`,
          `${allGroups.length} Site${allGroups.length === 1 ? "" : "s"} · ${STATE.scans.length} Scans`
        );
      }
    }

    populateProjectScanDropdowns(STATE.activeProjectGroup, STATE.activeScanId);

    visibleGroups.forEach((grp) => {
      if (!grp.hasGeoref || !Number.isFinite(grp.lat) || !Number.isFinite(grp.lon)) return;
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
        <div class="blob-label">${escapeHtml(grp.project_group)} (${count})</div>
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
        openClusterPopover(grp, true);
        gsMap.drawMap();
      });

      grp.el = blob;
      gsMap.markerLayer.appendChild(blob);
    });

    gsMap.drawMap();
    if (STATE.activeProjectGroup === "__all__") {
      document.getElementById("clusterHoverPopover")?.classList.remove("active");
      document.querySelectorAll(".scan-cluster-blob").forEach((b) => b.classList.remove("active-cluster"));
    } else if (visibleGroups.length > 0) {
      const activeGrp =
        visibleGroups.find((g) => g.project_group === STATE.activeProjectGroup) || visibleGroups[0];
      const isSingleScanShare =
        Boolean(STATE.shareToken) &&
        (STATE.scans.length === 1 || String(STATE.shareLinkInfo?.scope_type || "").toLowerCase() === "scan");
      if (STATE.activeView === "map" && !isSingleScanShare) {
        if (
          opts &&
          opts.preservePopover &&
          document.getElementById("clusterHoverPopover")?.classList.contains("active") &&
          STATE.activeProjectGroup === activeGrp.project_group
        ) {
          return;
        }
        openClusterPopover(activeGrp, false);
      }
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

  function formatScanPolyCount(scan, { short = false } = {}) {
    const isGs = Boolean(scan && scan.is_gaussian_splat);
    const unit = isGs ? tr("潑濺點", "splats") : tr("面", "polys");
    if (!scan) return `— ${unit}`;
    const polys = Number(isGs ? scan.splat_count || scan.poly_count || 0 : scan._live_poly_count || scan.poly_count || 0);
    if (!(polys > 0)) return `— ${unit}`;
    if (short) {
      if (polys >= 1000000) return `${(polys / 1000000).toFixed(2)}M ${unit}`;
      if (polys >= 1000) return `${Math.round(polys / 1000)}K ${unit}`;
    }
    return `${Math.round(polys).toLocaleString("en-US")} ${unit}`;
  }

  function formatScanTextureSize(scan, { short = false } = {}) {
    if (!scan) return "4096×4096 px";
    if (scan.is_gaussian_splat) return short ? "3DGS" : "3DGS Splat";
    const cnt = Number(scan.texture_count || 1);
    const w = Number(scan.texture_width || scan.texture_resolution || 4096);
    const h = Number(scan.texture_height || scan.texture_resolution || w);
    const tileMax = Math.max(w, h);
    const gridSide = cnt > 1 ? Math.ceil(Math.sqrt(cnt)) : 1;
    const tiledEff = cnt > 1 ? Math.min(16384, tileMax * gridSide) : tileMax;
    const effRes = Math.max(Number(scan.texture_resolution || 0), tiledEff, tileMax);
    const toK = (v) => (v >= 12288 ? "16K" : v >= 6144 ? "8K" : v >= 3072 ? "4K" : v >= 1536 ? "2K" : `${v}px`);
    if (short) {
      if (cnt > 1 && effRes > tileMax) {
        return `${toK(effRes)} (${cnt}×${toK(tileMax)})`;
      }
      const kTag = toK(tileMax);
      return cnt > 1 ? `${kTag}×${cnt}` : toK(effRes);
    }
    if (scan.texture_size_label) return String(scan.texture_size_label);
    if (cnt > 1 && effRes > tileMax) {
      return `${toK(effRes)} (${cnt}×${toK(tileMax)} tiles)`;
    }
    return cnt > 1 && cnt <= 8 ? `${w}×${h} px (×${cnt})` : cnt > 8 ? `${w}×${h} px (${cnt} tiles)` : `${w}×${h} px`;
  }

  function formatScanSizeMb(scan, { includeTotal = false } = {}) {
    if (!scan) return "0.0 MB";
    const streamMb = Number(scan.scan_size_mb || scan.stream_size_mb || 0);
    const totalMb = Number(scan.size_mb || (Number(scan.size_bytes || 0) / 1048576) || 0);
    const primaryMb = streamMb > 0 ? streamMb : totalMb;
    if (includeTotal && streamMb > 0 && totalMb > streamMb + 1.0) {
      return `${primaryMb.toFixed(1)} MB · ${totalMb.toFixed(1)} MB ${tr("總計", "total")}`;
    }
    return `${primaryMb.toFixed(1)} MB`;
  }

  function updateStudioScanMetricsReadout(scan = STATE.activeScan) {
    const metricsEl = document.getElementById("studioScanMetrics");
    if (!metricsEl || !scan) return;

    // Also inspect live loaded Three.js studio scene if available
    if (studioThree && studioThree.modelPivot && scan.scan_id === STATE.activeScanId) {
      let liveTris = 0;
      const liveTexDims = [];
      const seenTex = new Set();
      studioThree.modelPivot.traverse((node) => {
        if (node && node.isMesh && node.geometry && node.visible !== false) {
          const g = node.geometry;
          if (g.index) {
            liveTris += Math.floor(g.index.count / 3);
          } else if (g.attributes && g.attributes.position) {
            liveTris += Math.floor(g.attributes.position.count / 3);
          }
          const mats = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
          mats.forEach((m) => {
            const map = m && m.map;
            const img = map && map.image;
            if (img && img.width > 0 && img.height > 0 && !seenTex.has(map.uuid)) {
              seenTex.add(map.uuid);
              liveTexDims.push([Number(img.width), Number(img.height)]);
            }
          });
        }
      });
      if (liveTris > 0 && (!scan.poly_count || scan._has_staged_crop_preview)) {
        scan._live_poly_count = liveTris;
      } else {
        delete scan._live_poly_count;
      }
      if (!scan.texture_size_label && liveTexDims.length > 0) {
        const mw = Math.max(...liveTexDims.map((d) => d[0]));
        const mh = Math.max(...liveTexDims.map((d) => d[1]));
        const cnt = liveTexDims.length;
        const tileMax = Math.max(mw, mh);
        const effRes = Math.max(
          Number(scan.texture_resolution || 0),
          cnt > 1 ? Math.min(16384, tileMax * Math.ceil(Math.sqrt(cnt))) : tileMax
        );
        const toK = (v) => (v >= 12288 ? "16K" : v >= 6144 ? "8K" : v >= 3072 ? "4K" : v >= 1536 ? "2K" : `${v}px`);
        scan.texture_width = mw;
        scan.texture_height = mh;
        scan.texture_count = cnt;
        if (cnt > 1 && effRes > tileMax) {
          scan.texture_size_label = `${toK(effRes)} (${cnt}×${toK(tileMax)} tiles)`;
        } else {
          scan.texture_size_label =
            cnt > 1 && cnt <= 8 ? `${mw}×${mh} px (×${cnt})` : cnt > 8 ? `${mw}×${mh} px (${cnt} tiles)` : `${mw}×${mh} px`;
        }
      }
    }

    const crsText = getScanCrsDisplayLabel(scan);
    const areaText = formatCoveredAreaM2(scan);
    const polyText = formatScanPolyCount(scan);
    const texText = formatScanTextureSize(scan);
    const sizeText = formatScanSizeMb(scan);
    const stageTag =
      scan.quality_stage === "preview_ready"
        ? ` · ⚡ ${tr("快速預覽 (16K 完整版排隊中)", "Fast Preview (16K HQ Queued)")}`
        : "";

    metricsEl.textContent = `${crsText} · ${areaText} · ${polyText} · ${texText} · ${sizeText}${stageTag}`;
    const totalDiskMb = Number(scan.size_mb || (Number(scan.size_bytes || 0) / 1048576) || 0);
    const objMb = Number(scan.obj_size_mb || 0);
    metricsEl.title = [
      `${tr("座標系統", "CRS")}: ${crsText}`,
      `${tr("涵蓋面積", "Covered Area")}: ${areaText}`,
      `${tr("網格面數", "Polygon Count")}: ${polyText}`,
      `${tr("貼圖尺寸", "Texture Size")}: ${texText}`,
      `${tr("3D 模型大小", "3D Scan Size")}: ${sizeText}`,
      objMb > 0 ? `${tr("OBJ 匯出大小", "OBJ Export Size")}: ${objMb.toFixed(1)} MB` : null,
      totalDiskMb > 0 ? `${tr("專案總大小", "Total Project Size")}: ${totalDiskMb.toFixed(1)} MB` : null,
    ]
      .filter(Boolean)
      .join(" | ");
  }

  let _downloadFormatMenuAnchor = null;
  let _downloadFormatMenuScan = null;

  function closeDownloadFormatMenu() {
    const existing = document.getElementById("gsDownloadFormatPopover");
    if (existing) existing.remove();
  }

  function openDownloadFormatMenu(anchorEl, scan = STATE.activeScan, forceRefresh = false) {
    if (!scan || !scan.scan_id) return;
    _downloadFormatMenuAnchor = anchorEl;
    _downloadFormatMenuScan = scan;
    const existing = document.getElementById("gsDownloadFormatPopover");
    if (!forceRefresh && existing && existing.dataset.scanId === scan.scan_id && existing.dataset.anchorId === (anchorEl?.id || "")) {
      existing.remove();
      return;
    }
    closeDownloadFormatMenu();

    const sid = encodeURIComponent(scan.scan_id);
    const url3tz = appendAuthToDownloadUrl(scan.download_3tz_url || `/api/download?scan_id=${sid}&type=3tz`);
    const urlGlb = appendAuthToDownloadUrl(scan.download_glb_url || `/api/download?scan_id=${sid}&type=glb`);
    const urlObj = appendAuthToDownloadUrl(scan.download_obj_url || `/api/download?scan_id=${sid}&type=obj`);
    const urlZip = appendAuthToDownloadUrl(scan.download_zip_url || `/api/download?scan_id=${sid}&type=zip`);

    const streamMbStr = formatScanSizeMb(scan);
    const objMb = Number(scan.obj_size_mb || 0);
    const objMbStr = objMb > 0 ? `${objMb.toFixed(1)} MB` : tr("空間定位網格", "Georef Mesh");
    const crsLabel = getScanCrsDisplayLabel(scan);
    const safeScanName = escapeHtml(scan.name || scan.scan_id);

    const pop = document.createElement("div");
    pop.id = "gsDownloadFormatPopover";
    pop.dataset.scanId = scan.scan_id;
    pop.dataset.anchorId = anchorEl?.id || "";
    pop.style.cssText = [
      "position:fixed",
      "z-index:9999",
      "width:310px",
      "background:var(--ui-bg-window)",
      "backdrop-filter:blur(16px)",
      "border:1px solid var(--ui-border-strong)",
      "border-radius:10px",
      "box-shadow:0 14px 36px rgba(0,0,0,0.32)",
      "padding:8px",
      "color:var(--ui-text-primary)",
      "font-family:var(--sans, system-ui, sans-serif)",
    ].join(";");

    const formats = [
      {
        ext: ".3tz",
        title: tr("3D Tiles 串流封包 · .3tz", "3D Tiles Package · .3tz"),
        badge: streamMbStr,
        desc: tr("完整 Cesium / 3D Tiles 封裝檔（含 tileset.json、.glb 圖磚與預覽 LOD）", "Complete Cesium / 3D Tileset archive (tileset.json + .glb tiles + preview LOD)"),
        url: url3tz,
        color: "#0284c7",
      },
      {
        ext: ".glb",
        title: tr("二進位 glTF 2.0 模型 · .glb", "Binary glTF 2.0 Model · .glb"),
        badge: `${formatScanTextureSize(scan, { short: true })} ${tr("內嵌", "Embedded")}`,
        desc: tr("內嵌貼圖之單一 3D 模型檔（支援 Blender、3D 檢視器與 Three.js）", "Single self-contained 3D model with embedded JPEG textures (Blender, 3D Viewer, Three.js)"),
        url: urlGlb,
        color: "#10b981",
      },
      {
        ext: ".obj",
        title: tr("Wavefront 網格模型 · .obj", "Wavefront .OBJ Mesh · .obj"),
        badge: crsLabel,
        desc: tr("含空間座標之 .obj 三角網格（支援 Civil 3D、AutoCAD 與 CloudCompare）", "Georeferenced world-coordinate .obj geometry for Civil 3D, AutoCAD & CloudCompare"),
        url: urlObj,
        color: "#f59e0b",
      },
      {
        ext: ".zip",
        title: tr("完整貼圖包 .OBJ + .MTL + .JPG · .zip", "Textured .OBJ + .MTL + .JPG · .zip"),
        badge: objMbStr,
        desc: tr("完整 .obj 網格 + .mtl 材質 + 高解析度 .jpg 貼圖集 + offset.xyz 壓縮包", "Full Wavefront .obj + .mtl + full-res .jpg texture atlases + offset.xyz in one ZIP"),
        url: urlZip,
        color: "#8b5cf6",
      },
    ];

    pop.innerHTML = `
      <div style="padding:4px 6px 7px;border-bottom:1px solid var(--ui-border);margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <div style="min-width:0;">
          <div style="font-size:11.5px;font-weight:700;color:var(--ui-text-primary);" data-i18n-zh="選擇下載格式" data-i18n-en="Download 3D Scan">${tr("選擇下載格式", "Download 3D Scan")}</div>
          <div style="font-size:10px;color:var(--ui-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${safeScanName}">${safeScanName} · ${escapeHtml(formatScanPolyCount(scan, { short: true }))}</div>
        </div>
        <button type="button" id="btnCloseDlPopover" style="background:none;border:none;color:var(--ui-text-muted);cursor:pointer;font-size:13px;padding:2px 5px;line-height:1;" title="${tr("關閉", "Close")}" data-i18n-title-zh="關閉" data-i18n-title-en="Close">✕</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:5px;">
        ${formats
          .map(
            (f) => `
          <a href="${escapeHtml(f.url)}" download data-dl-ext="${escapeHtml(f.ext)}" style="display:flex;align-items:flex-start;gap:9px;padding:7px 8px;border-radius:7px;border:1px solid var(--ui-border);background:var(--ui-bg-surface);text-decoration:none;color:inherit;transition:background 0.12s,border-color 0.12s;">
            <span style="flex-shrink:0;min-width:38px;text-align:center;font-family:monospace;font-size:11px;font-weight:800;padding:3px 5px;border-radius:5px;background:${f.color}20;color:${f.color};border:1px solid ${f.color}55;margin-top:1px;">${escapeHtml(f.ext)}</span>
            <span style="flex:1;min-width:0;">
              <span style="display:flex;justify-content:space-between;align-items:center;gap:4px;">
                <span style="font-size:11.5px;font-weight:700;color:var(--ui-text-primary);">${escapeHtml(f.title)}</span>
                <span style="font-size:9.5px;font-family:monospace;color:var(--ui-text-secondary);background:var(--ui-bg-subtle);padding:1px 5px;border-radius:4px;white-space:nowrap;">${escapeHtml(f.badge)}</span>
              </span>
              <span style="display:block;font-size:10px;color:var(--ui-text-secondary);line-height:1.35;margin-top:2px;">${escapeHtml(f.desc)}</span>
            </span>
          </a>
        `
          )
          .join("")}
      </div>
    `;

    document.body.appendChild(pop);

    // Position near anchorEl
    if (anchorEl && typeof anchorEl.getBoundingClientRect === "function") {
      const rect = anchorEl.getBoundingClientRect();
      const popRect = pop.getBoundingClientRect();
      let left = rect.left;
      if (left + popRect.width > window.innerWidth - 12) {
        left = Math.max(12, window.innerWidth - popRect.width - 12);
      }
      let top = rect.bottom + 6;
      if (top + popRect.height > window.innerHeight - 12) {
        top = Math.max(12, rect.top - popRect.height - 6);
      }
      pop.style.left = `${Math.round(left)}px`;
      pop.style.top = `${Math.round(top)}px`;
    } else {
      pop.style.top = "64px";
      pop.style.right = "24px";
    }

    pop.querySelector("#btnCloseDlPopover")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeDownloadFormatMenu();
    });

    pop.querySelectorAll("a[data-dl-ext]").forEach((aEl) => {
      aEl.addEventListener("mouseenter", () => {
        aEl.style.borderColor = "var(--ui-accent)";
      });
      aEl.addEventListener("mouseleave", () => {
        aEl.style.borderColor = "var(--ui-border)";
      });
      aEl.addEventListener("click", () => {
        const ext = aEl.getAttribute("data-dl-ext") || "";
        // Refresh session_token right on click
        aEl.href = appendAuthToDownloadUrl(aEl.getAttribute("href") || "");
        SHARE_TELEMETRY.recordDownload(ext, scan);
        showToast(`Preparing ${scan.name || scan.scan_id} (${ext}) download...`);
        setTimeout(() => closeDownloadFormatMenu(), 120);
      });
    });

    setTimeout(() => {
      const onDocClick = (ev) => {
        const curPop = document.getElementById("gsDownloadFormatPopover");
        if (!curPop) {
          document.removeEventListener("mousedown", onDocClick);
          return;
        }
        if (!curPop.contains(ev.target) && (!anchorEl || !anchorEl.contains(ev.target))) {
          closeDownloadFormatMenu();
          document.removeEventListener("mousedown", onDocClick);
        }
      };
      document.addEventListener("mousedown", onDocClick);
    }, 10);
  }

  function formatScanQueueStatusBadgeHtml(scan) {
    if (!scan || !scan.status) return "";
    const st = String(scan.status).toLowerCase();
    const isPreviewReady = scan.quality_stage === "preview_ready";
    const isPass1 = scan.pending_pass === "preview" && !isPreviewReady;
    if (st === "completed") {
      if (isPreviewReady) {
        return `<span class="gs-tile-chip" style="background:rgba(139,92,246,0.92);color:#fff;font-weight:700;">${tr("⚡ 快速預覽版", "⚡ FAST PREVIEW")}</span>`;
      }
      return "";
    }
    if (st === "processing") {
      const pct = Math.round(Number(scan.progress_pct || 0));
      if (isPreviewReady) {
        return `<span class="gs-tile-chip" style="background:rgba(139,92,246,0.92);color:#fff;font-weight:700;" title="${tr("快速預覽已上線可檢視，正在計算 16K 完整版", "Fast Preview is live & viewable while 16K HQ builds")}">${tr(`⚡ 預覽就緒 · 16K ${pct}%`, `⚡ PREVIEW · 16K ${pct}%`)}</span>`;
      }
      if (isPass1) {
        return `<span class="gs-tile-chip" style="background:rgba(2,132,199,0.92);color:#fff;font-weight:700;">${tr(`⚡ 快速預覽 ${pct}%`, `⚡ PREVIEW ${pct}%`)}</span>`;
      }
      return `<span class="gs-tile-chip" style="background:rgba(2,132,199,0.9);color:#fff;font-weight:700;">${tr(`處理中 ${pct}%`, `PROCESSING ${pct}%`)}</span>`;
    }
    if (st === "queued") {
      let qPos = Number(scan.queue_position || 0);
      if (!qPos && Array.isArray(STATE.scans)) {
        const qList = STATE.scans
          .filter((x) => x.status === "queued")
          .sort(
            (a, b) =>
              Number(b.force_next || 0) - Number(a.force_next || 0) ||
              Number(b.priority_score || 0) - Number(a.priority_score || 0) ||
              Number(a.uploaded_at || 0) - Number(b.uploaded_at || 0)
          );
        const idx = qList.findIndex((x) => x.scan_id === scan.scan_id);
        if (idx >= 0) qPos = idx + 1;
      }
      if (isPreviewReady) {
        const lbl = qPos > 0 ? tr(`⚡ 預覽版 · 16K 排隊 #${qPos}`, `⚡ PREVIEW · 16K #${qPos}`) : tr("⚡ 預覽版 · 16K 排隊", "⚡ PREVIEW · 16K QUEUED");
        return `<span class="gs-tile-chip" style="background:rgba(139,92,246,0.92);color:#fff;font-weight:700;" title="${tr("快速預覽已上線可檢視，16K 完整版排隊中", "Fast Preview is live & viewable; 16K HQ upgrade is queued")}">${lbl}</span>`;
      }
      const isNext = qPos === 1 || Number(scan.force_next || 0) === 1;
      const passPrefix = isPass1 ? "⚡ " : "";
      const lbl = qPos > 0 ? tr(`${passPrefix}排隊 #${qPos}`, `${passPrefix}QUEUED #${qPos}`) : isNext ? tr(`${passPrefix}排隊 #1`, `${passPrefix}QUEUED #1`) : tr(`${passPrefix}排隊中`, `${passPrefix}QUEUED`);
      const bg = isNext ? "rgba(16,185,129,0.9)" : "rgba(245,158,11,0.9)";
      return `<span class="gs-tile-chip" style="background:${bg};color:#fff;font-weight:700;">${lbl}</span>`;
    }
    if (st === "waiting_parts") {
      return `<span class="gs-tile-chip" style="background:rgba(6,182,212,0.9);color:#fff;font-weight:700;">${tr("等待分卷", "WAITING PARTS")}</span>`;
    }
    return "";
  }

  function formatPendingScanStatusMessage(scan) {
    if (!scan) return "";
    if (scan.status === "processing") {
      return `Processing in PIX4Dmatic (${Math.round(scan.progress_pct || 0)}%) — ${scan.stage_label || ""}`;
    }
    if (scan.status === "queued") {
      return `Queued for PIX4Dmatic — ${scan.stage_label || "Waiting in Queue"}`;
    }
    if (scan.status === "waiting_parts") {
      return `Waiting for Split Upload Parts — ${scan.stage_label || ""}`;
    }
    return `Status: ${scan.status || "Pending"}`;
  }
  window.formatPendingScanStatusMessage = formatPendingScanStatusMessage;

  function openClusterPopover(grp, userExplicit = false) {
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
      const isPlayable = (s) => s.status === "completed" || Boolean(s.stream_url);
      if (!currInGroup || (!isPlayable(currInGroup) && sortedScans.some(isPlayable))) {
        const bestScan = sortedScans.find(isPlayable) || sortedScans[0];
        STATE.activeScanId = bestScan.scan_id;
        STATE.activeScan = bestScan;
      }
    }
    populateProjectScanDropdowns(grp.project_group, STATE.activeScanId);
    if (gsMap && gsMap.drawMap) gsMap.drawMap();

    document.getElementById("popoverGroupTitle").textContent = `${grp.project_group} · ${grp.scans.length}`;
    const rawSubZh = String(grp.project_name_zh || "工程掃描群組");
    const subGroupLabel =
      window.getAppLanguage?.() === "en"
        ? rawSubZh.replace(/工程掃描群組/g, "Engineering Scan Group")
        : rawSubZh;
    document.getElementById("popoverGroupSubtitle").textContent = subGroupLabel;

    // Unified 3-Pane Workbench on Desktop/Tablet; on Phone (<=767px), keep first page map-only until a site is explicitly chosen
    const isMobileViewport = typeof window !== "undefined" && window.innerWidth <= 767;
    const shouldOpenTimeline =
      STATE.activeView === "map" &&
      (isMobileViewport
        ? Boolean(userExplicit || STATE.siteTimelineOpen)
        : true);
    if (shouldOpenTimeline) {
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
      btnShare.style.display = !STATE.shareToken && getCurrentUserRoleInfo().level >= 3 ? "inline-flex" : "none";
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
      const texLabel = formatScanTextureSize(scan, { short: true });
      const polyShort = formatScanPolyCount(scan, { short: true });
      const sizeShort = formatScanSizeMb(scan);
      const safeId = escapeHtml(scan.scan_id);
      const safeThumbSrc = escapeHtml(thumbSrc);
      const safeName = escapeHtml(scan.name || scan.scan_id);
      const safeDate = escapeHtml(scan.capture_date || "");
      const safeUploaderName = escapeHtml(scan.uploader_name || "");
      const safeUploaderEmail = escapeHtml(scan.uploader_email || "");
      const safeDownloadObjUrl = escapeHtml(
        appendAuthToDownloadUrl(scan.download_obj_url || `/api/download?scan_id=${encodeURIComponent(scan.scan_id)}&type=obj`)
      );
      const coordReadout = escapeHtml(
        formatScanCoordReadout({ e: scan.twd97_e, n: scan.twd97_n, h: scan.twd97_h }, scan)
      );
      card.innerHTML = `
        <div class="gs-map-tile-thumb-wrap">
          <img class="gs-map-tile-thumb" data-scan-thumb="${safeId}" src="${safeThumbSrc}" alt="${safeName}" />
          <div class="gs-tile-badge-row">
            ${formatScanQueueStatusBadgeHtml(scan)}
            <span class="gs-tile-chip">${escapeHtml(polyShort)} · ${escapeHtml(texLabel)} · ${escapeHtml(sizeShort)}</span>
            <span class="gs-tile-chip">${escapeHtml(formatCoveredAreaM2(scan))}</span>
          </div>
        </div>
        <div class="gs-map-tile-body">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
            <div style="min-width:0;flex:1;">
              <div style="font-size:12.5px;font-weight:700;color:var(--ui-text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${safeName}">${safeName}</div>
              <div style="font-size:11px;color:var(--ui-text-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${safeDate} · ${safeUploaderName} (<span style="color:var(--ui-accent);">${safeUploaderEmail}</span>)
              </div>
            </div>
          </div>
          <div style="font-size:10.5px;font-family:monospace;color:var(--ui-text-muted);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${tr("網格面數", "Polygons")}: ${escapeHtml(formatScanPolyCount(scan))} | ${tr("貼圖解析度", "Texture")}: ${escapeHtml(formatScanTextureSize(scan))} | ${tr("掃描大小", "Scan Size")}: ${escapeHtml(formatScanSizeMb(scan, { includeTotal: true }))}">
            ${escapeHtml(formatScanPolyCount(scan))} · ${escapeHtml(formatScanTextureSize(scan))} · ${escapeHtml(sizeShort)}
          </div>
          <div style="font-size:10.5px;font-family:monospace;color:var(--ui-text-muted);margin-top:3px;">
            ${coordReadout}${isCached ? tr(" · 已快取", " · Cached") : ""}
          </div>
          <div class="gs-scan-item-actions">
            <button type="button" class="btn-xs primary" data-action="open3d" title="${tr("於 3D 工作台放大檢視全畫質掃描", "Enlarge Full-Quality 3D Scan in Studio")}">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 3 21 3 21 9"/>
                <polyline points="9 21 3 21 3 15"/>
                <line x1="21" y1="3" x2="14" y2="10"/>
                <line x1="3" y1="21" x2="10" y2="14"/>
              </svg>
            </button>
            <button type="button" class="btn-xs" data-action="compare" title="${tr("多期別分割捲簾比對", "Compare Dates in Split Slider")}">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
                <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/>
              </svg>
            </button>
            ${
              getCurrentUserRoleInfo().allowDownload
                ? `<button type="button" class="btn-xs" data-action="download" title="${tr("下載 3D 掃描 (.3tz, .glb, .obj, .zip)", "Download 3D Scan (.3tz, .glb, .obj, .zip)")}" style="gap:2px;">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.2" style="opacity:0.75;">
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </button>`
                : ""
            }
            ${
              getCurrentUserRoleInfo().allowComments
                ? `<button type="button" class="btn-xs" data-action="comments" title="${tr(`留言標註 · ${scan.comment_count || 0}`, `Comments · ${scan.comment_count || 0}`)}">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                  </button>`
                : ""
            }
            ${
              !STATE.shareToken && getCurrentUserRoleInfo().level >= 3
                ? `<button type="button" class="btn-xs" data-action="share" title="${tr("建立限定範圍分享連結", "Create Scoped Share Link")}">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
                      <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                    </svg>
                  </button>`
                : ""
            }
            ${
              !STATE.shareToken && getCurrentUserRoleInfo().canEditNames
                ? `<button type="button" class="btn-xs" data-action="rename" title="${tr("修改掃描名稱", "Edit Scan Name")}">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
                      <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                    </svg>
                  </button>
                  <button type="button" class="btn-xs" data-action="delete" title="${tr("刪除掃描", "Delete Scan")}" style="color:#ef4444;">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
                      <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
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

      card.querySelector('[data-action="open3d"]')?.addEventListener("click", () => {
        STATE.activeProjectGroup = scan.project_group;
        populateProjectScanDropdowns(scan.project_group, scan.scan_id);
        switchView("studio", scan.scan_id);
      });
      card.querySelector('[data-action="compare"]')?.addEventListener("click", () => {
        STATE.activeProjectGroup = scan.project_group;
        const other = grp.scans.find((s) => s.scan_id !== scan.scan_id) || scan;
        launchMultiDateCompare(other.scan_id, scan.scan_id);
      });
      const dlCardBtn = card.querySelector('[data-action="download"]');
      if (dlCardBtn) {
        dlCardBtn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openDownloadFormatMenu(dlCardBtn, scan);
        });
      }
      card.querySelector('[data-action="comments"]')?.addEventListener("click", () => {
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
      const deleteBtn = card.querySelector('[data-action="delete"]');
      if (deleteBtn) {
        deleteBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openDeleteScanModal(scan.scan_id);
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

  function suspendPreview3DResources() {
    if (STATE._timelineInitTimer) {
      clearTimeout(STATE._timelineInitTimer);
      STATE._timelineInitTimer = null;
    }
    if (!previewThree) return;
    if (previewThree._loaderHideTimer) {
      clearTimeout(previewThree._loaderHideTimer);
      previewThree._loaderHideTimer = null;
    }
    if (typeof disposeGaussianSplatFromContext === "function") {
      disposeGaussianSplatFromContext(previewThree);
    }
    if (previewThree.tilesRenderer) {
      try {
        previewThree.modelPivot.remove(previewThree.tilesRenderer.group);
        previewThree.tilesRenderer.dispose();
      } catch (_) {}
      previewThree.tilesRenderer = null;
    }
    if (previewThree.modelPivot) {
      disposeObject3DResources(previewThree.modelPivot);
      while (previewThree.modelPivot.children.length > 0) {
        previewThree.modelPivot.remove(previewThree.modelPivot.children[0]);
      }
    }
    previewThree._loadingScanId = null;
    previewThree._loadingDone = true;
    updateScanLoader("preview", false, 100, "");
  }
  window.suspendPreview3DResources = suspendPreview3DResources;

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
      0.03,
      10000
    );
    camera.position.set(42, 34, 48);

    const isIOS = typeof isIOSOrIPadDevice === "function" && isIOSOrIPadDevice();
    const renderer = new THREE.WebGLRenderer({
      antialias: !isIOS,
      preserveDrawingBuffer: !isIOS,
      powerPreference: isIOS ? "default" : "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isIOS ? 1.35 : 2));
    renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1.0;
    container.appendChild(renderer.domElement);

    renderer.domElement.addEventListener(
      "webglcontextlost",
      (ev) => {
        ev.preventDefault();
        if (previewThree) {
          previewThree._contextLost = true;
          renderer.setPixelRatio(1);
        }
      },
      false
    );
    renderer.domElement.addEventListener(
      "webglcontextrestored",
      () => {
        if (previewThree) {
          previewThree._contextLost = false;
          if (STATE.activeView === "map" && STATE.selectedTimelineScanId) {
            loadScanIntoPreview(STATE.selectedTimelineScanId, true);
          }
        }
      },
      false
    );

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.enablePan = true;
    controls.enableZoom = true;
    controls.minDistance = 0.08;
    controls.screenSpacePanning = true;
    controls.autoRotate = Boolean(STATE.autoRotateEnabled);
    controls.autoRotateSpeed = Number(STATE.autoRotateSpeed) || 0.45;
    if (typeof installSurfaceAwareOrbitZoom === "function") {
      installSurfaceAwareOrbitZoom(renderer.domElement, () => previewThree);
    }
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN,
    };
    controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
    controls.addEventListener("end", () => {
      SHARE_TELEMETRY.recordCameraInteraction("preview");
    });
    renderer.domElement.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    renderer.domElement.addEventListener("auxclick", (e) => {
      if (e.button === 1) e.preventDefault();
    });

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
      if (typeof updateGaussianSplatForContext === "function") {
        updateGaussianSplatForContext(previewThree, "preview");
      }
      if (typeof updateNorthArrowCompass === "function" && STATE.siteTimelineOpen) {
        updateNorthArrowCompass(camera);
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
    if (visible) {
      SHARE_TELEMETRY.recordLoadProgress(clamped, false);
    }
  }

  function startScanLoader(ctx, prefix, scanName, scanId = null) {
    if (ctx) {
      if (ctx._loaderHideTimer) {
        clearTimeout(ctx._loaderHideTimer);
        ctx._loaderHideTimer = null;
      }
      if (ctx._detailPillHideTimer) {
        clearTimeout(ctx._detailPillHideTimer);
        ctx._detailPillHideTimer = null;
      }
      ctx._wasRefiningDetails = false;
      ctx._loadingDone = false;
      ctx._tilesetReady = false;
      ctx._tilesetReadyMs = 0;
      ctx._loadingStartMs = performance.now();
      ctx._maxPct = 6;
      if (scanId) ctx._loadingScanId = scanId;
    }
    const detailPill = document.getElementById(`${prefix}DetailStreamPill`);
    if (detailPill) detailPill.classList.remove("active", "done");
    updateScanLoader(prefix, true, 6, tr(`正在載入 ${scanName || "3D 掃描"}...`, `Loading ${scanName || "3D Scan"}...`));
  }

  function syncBackgroundDetailStreamingPill(ctx, prefix) {
    if (!ctx || !ctx.tilesRenderer) return;
    const pillEl = document.getElementById(`${prefix}DetailStreamPill`);
    if (!pillEl) return;
    const textEl = document.getElementById(`${prefix}DetailStreamText`);
    const barEl = document.getElementById(`${prefix}DetailStreamBar`);
    const stats = ctx.tilesRenderer.stats || {};
    const loaded = Number(stats.loaded || 0);
    const downloading = Number(stats.downloading || 0);
    const parsing = Number(stats.parsing || 0);
    const queued = Number(stats.queued || 0);
    const pending = downloading + parsing + queued;

    if (pending > 0) {
      if (ctx._detailPillHideTimer) {
        clearTimeout(ctx._detailPillHideTimer);
        ctx._detailPillHideTimer = null;
      }
      ctx._wasRefiningDetails = true;
      const total = Math.max(1, loaded + pending);
      const pct = Math.min(99, Math.max(8, Math.round((loaded / total) * 100)));
      pillEl.classList.remove("done");
      pillEl.classList.add("active");
      if (textEl) {
        textEl.textContent = tr(
          `正在載入更多高清細節 · ${loaded}/${total} 圖磚 (${pct}%)`,
          `Loading more HD details · ${loaded}/${total} tiles (${pct}%)`
        );
      }
      if (barEl) {
        barEl.style.width = `${pct}%`;
      }
    } else if (ctx._wasRefiningDetails) {
      ctx._wasRefiningDetails = false;
      pillEl.classList.add("active", "done");
      if (textEl) {
        textEl.textContent = tr(
          `✓ 高清細節已載入 (${loaded} 圖磚)`,
          `✓ HD details loaded (${loaded} tiles)`
        );
      }
      if (barEl) {
        barEl.style.width = "100%";
      }
      if (ctx._detailPillHideTimer) clearTimeout(ctx._detailPillHideTimer);
      ctx._detailPillHideTimer = setTimeout(() => {
        pillEl.classList.remove("active", "done");
      }, 1800);
    }
  }

  function finishScanLoader(ctx, prefix, labelText = tr("掃描已就緒", "Scan Ready")) {
    const loadElapsedMs = ctx && ctx._loadingStartMs ? performance.now() - ctx._loadingStartMs : 0;
    SHARE_TELEMETRY.recordLoadProgress(100, true, loadElapsedMs);
    if (ctx) {
      ctx._loadingDone = true;
      ctx._maxPct = 100;
      if (ctx._loaderHideTimer) clearTimeout(ctx._loaderHideTimer);
      updateScanLoader(prefix, true, 100, labelText);
      ctx._loaderHideTimer = setTimeout(() => {
        updateScanLoader(prefix, false, 100, labelText);
        if (typeof scheduleScanGoogleMapCoverageUpdate === "function") {
          scheduleScanGoogleMapCoverageUpdate(ctx, STATE.activeScan, 120);
        }
        if (prefix === "preview") {
          autoCaptureSiteTimelineScreenshots();
        } else if (prefix === "studio") {
          updateStudioScanMetricsReadout(STATE.activeScan);
        }
      }, 320);
    } else {
      updateScanLoader(prefix, false, 100, labelText);
    }
  }

  function syncTilesLoaderProgress(ctx, prefix) {
    if (!ctx || !ctx.tilesRenderer) return;
    if (ctx._loadingDone) {
      syncBackgroundDetailStreamingPill(ctx, prefix);
      return;
    }
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

    // Complete as soon as the coarse L0 root tile (loaded >= 1) is rendered so L1/L2 stream silently in background
    const total = Math.max(1, loaded + pending);
    const enoughTilesReady = loaded >= 1;
    if (enoughTilesReady && elapsed > 180) {
      finishScanLoader(ctx, prefix, tr(`100% · ${loaded} 個 3D 圖磚已就緒`, `100% · ${loaded} 3D tiles ready`));
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
        finishScanLoader(ctx, prefix, tr("掃描已就緒", "Scan Ready"));
        return;
      }
    }

    if (loaded > 0 || activeWork > 0 || queued > 0) {
      const timeBoost = activeWork > 0 ? Math.min(26, Math.floor(elapsed / 220)) : 0;
      const rawPct = Math.round(20 + (loaded / total) * 76) + timeBoost;
      ctx._maxPct = Math.min(96, Math.max(ctx._maxPct || 22, rawPct));
      updateScanLoader(
        prefix,
        true,
        ctx._maxPct,
        tr(`正在串流 3D 掃描 · ${loaded} / ${total} 圖磚`, `Streaming 3D Scan · ${loaded} / ${total} tiles`)
      );
      return;
    }

    if (!ctx._tilesetReady) {
      const waitPct = Math.min(20, 6 + Math.floor(elapsed / 120));
      ctx._maxPct = Math.max(ctx._maxPct || 6, waitPct);
      updateScanLoader(prefix, true, ctx._maxPct, tr("正在讀取 3D 圖磚索引...", "Fetching 3D tileset..."));
    } else if (sinceTileset < 2500) {
      // Tileset just arrived; waiting for first frame traversal to schedule .glb downloads
      ctx._maxPct = Math.max(ctx._maxPct || 22, 22);
      updateScanLoader(prefix, true, ctx._maxPct, tr("正在串流 3D 圖磚...", "Streaming 3D tiles..."));
    } else if (sinceTileset > 12000) {
      finishScanLoader(ctx, prefix, tr("掃描已就緒", "Scan Ready"));
    }
  }

  function framePreviewCamera() {
    if (!previewThree) return;
    const hv = STATE.activeScan?.home_view;
    if (hv && Array.isArray(hv.pos) && hv.pos.length >= 3 && Array.isArray(hv.target) && hv.target.length >= 3) {
      let dx = 0, dy = 0, dz = 0;
      if (Array.isArray(hv.tiles_center) && hv.tiles_center.length >= 3 && Array.isArray(previewThree.tilesCenter) && previewThree.tilesCenter.length >= 3) {
        const rawDx = Number(previewThree.tilesCenter[0]) - Number(hv.tiles_center[0]);
        const rawDy = Number(previewThree.tilesCenter[1]) - Number(hv.tiles_center[1]);
        const rawDz = Number(previewThree.tilesCenter[2]) - Number(hv.tiles_center[2]);
        if (Math.hypot(rawDx, rawDy, rawDz) < 500) {
          dx = rawDx;
          dy = rawDy;
          dz = rawDz;
        }
      }
      previewThree.controls.target.set(
        (Number(hv.target[0]) || 0) - dx,
        (Number(hv.target[1]) || 0) - dz,
        (Number(hv.target[2]) || 0) + dy
      );
      previewThree.camera.position.set(
        (Number(hv.pos[0]) || 0) - dx,
        (Number(hv.pos[1]) || 0) - dz,
        (Number(hv.pos[2]) || 0) + dy
      );
      previewThree.camera.lookAt(previewThree.controls.target);
      previewThree.controls.update();
      previewThree.camera.updateMatrixWorld(true);
      return;
    }
    const rawR = Number(previewThree.boundingSphere?.radius) || 55;
    const r = rawR < 14 ? Math.max(1.4, rawR * 1.55) : Math.max(22, Math.min(240, rawR));
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

  function computeTilesetDepthLimits(rootNode, maxAutoTiles) {
    if (!rootNode) {
      return { roughMaxDepth: 1, autoMaxDepth: 3, acceptedCumTiles: 0 };
    }
    const countsByDepth = new Map();
    const walkDepth = (node, depth) => {
      if (!node || depth > 14) return;
      const hasContent = Boolean(node.content && (node.content.uri || node.content.url));
      if (hasContent) {
        countsByDepth.set(depth, (countsByDepth.get(depth) || 0) + 1);
      }
      if (Array.isArray(node.children)) {
        for (let i = 0; i < node.children.length; i++) {
          walkDepth(node.children[i], depth + 1);
        }
      }
    };
    walkDepth(rootNode, 0);
    const depths = Array.from(countsByDepth.keys()).sort((a, b) => a - b);
    if (depths.length === 0) {
      return { roughMaxDepth: 2, autoMaxDepth: 3, acceptedCumTiles: 0 };
    }
    const firstDepth = depths[0];
    let bestAutoDepth = firstDepth;
    let cumTiles = 0;
    let acceptedCumTiles = 0;
    for (let i = 0; i < depths.length; i++) {
      const d = depths[i];
      const nextCum = cumTiles + (countsByDepth.get(d) || 0);
      if (d === firstDepth || nextCum <= maxAutoTiles) {
        bestAutoDepth = d;
        cumTiles = nextCum;
        acceptedCumTiles = nextCum;
      } else {
        break;
      }
    }
    return {
      roughMaxDepth: firstDepth + 1,
      autoMaxDepth: bestAutoDepth + 1,
      acceptedCumTiles,
    };
  }
  window.computeTilesetDepthLimits = computeTilesetDepthLimits;

  function configureTilesRendererLodAndCaps(tr, rawLodMode, viewerType = "studio") {
    if (!tr) return;
    tr._gsViewerType = viewerType;
    const isIOS = typeof isIOSOrIPadDevice === "function" && isIOSOrIPadDevice();
    const isPhone = typeof isIPhoneOrMobilePhone === "function" && isIPhoneOrMobilePhone();
    const isMobOrTab = isIOS || isPhone || (typeof isMobileOrTabletDevice === "function" && isMobileOrTabletDevice());
    const isEmbed = Boolean(STATE.isEmbedded);
    const isPreview = viewerType === "preview";
    const isCompareOrAlign = viewerType === "compare" || viewerType === "align";
    const isLocalHost = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";

    const lodMode = isEmbed
      ? (rawLodMode === "rough" ? "rough" : "auto")
      : (rawLodMode === "rough" || rawLodMode === "max" ? rawLodMode : "auto");

    tr.loadSiblings = false;

    const depthInfo = computeTilesetDepthLimits(tr.root, 30);
    if (lodMode === "rough") {
      tr.errorTarget = 1e9;
      tr.maxDepth = depthInfo.roughMaxDepth;
      tr._maxActiveTiles = 16;
    } else if (lodMode === "max" && !isEmbed) {
      tr.maxDepth = Infinity;
      tr.errorTarget = isPreview ? 1.5 : isMobOrTab ? 4.0 : 0.8;
      tr._maxActiveTiles = isIOS || isPhone ? 120 : isMobOrTab ? 140 : isPreview ? 180 : 600;
    } else {
      // Auto mode: NO depth cap (maxDepth = Infinity) so close-up zooming refines all the way to leaf tiles,
      // while capping active in-frustum tiles (_maxActiveTiles) and culling out-of-frustum tiles.
      tr.maxDepth = Infinity;
      if (isIOS || isPhone) {
        tr._maxActiveTiles = 85;
        tr.errorTarget = 8.0;
      } else if (isMobOrTab) {
        tr._maxActiveTiles = 100;
        tr.errorTarget = 7.0;
      } else if (isEmbed || isPreview || isCompareOrAlign) {
        tr._maxActiveTiles = 120;
        tr.errorTarget = 6.0;
      } else {
        tr._maxActiveTiles = 160;
        tr.errorTarget = 5.0;
      }
    }

    if (tr.downloadQueue) {
      tr.downloadQueue.maxJobs = isIOS
        ? 3
        : isMobOrTab
        ? 4
        : isEmbed || isPreview
        ? 6
        : isLocalHost
        ? 8
        : lodMode === "max"
        ? 8
        : 6;
    }
    if (tr.parseQueue) {
      tr.parseQueue.maxJobs = isIOS ? 2 : isMobOrTab || isEmbed || isPreview ? 3 : 4;
    }
    if (tr.lruCache) {
      if (lodMode === "rough") {
        tr.lruCache.minSize = 16;
        tr.lruCache.maxSize = 32;
        tr.lruCache.minBytesSize = 48 * 1024 * 1024;
        tr.lruCache.maxBytesSize = 96 * 1024 * 1024;
      } else if (lodMode === "max" && !isEmbed) {
        tr.lruCache.minSize = isMobOrTab ? 140 : isPreview ? 180 : 400;
        tr.lruCache.maxSize = isMobOrTab ? 180 : isPreview ? 240 : 800;
        tr.lruCache.minBytesSize = (isMobOrTab ? 256 : isPreview ? 384 : 768) * 1024 * 1024;
        tr.lruCache.maxBytesSize = (isMobOrTab ? 512 : isPreview ? 768 : 1536) * 1024 * 1024;
      } else if (isIOS || isPhone) {
        tr.lruCache.minSize = 85;
        tr.lruCache.maxSize = 120;
        tr.lruCache.minBytesSize = 256 * 1024 * 1024;
        tr.lruCache.maxBytesSize = 512 * 1024 * 1024;
      } else if (isMobOrTab) {
        tr.lruCache.minSize = 100;
        tr.lruCache.maxSize = 140;
        tr.lruCache.minBytesSize = 320 * 1024 * 1024;
        tr.lruCache.maxBytesSize = 640 * 1024 * 1024;
      } else if (isEmbed || isPreview || isCompareOrAlign) {
        tr.lruCache.minSize = 120;
        tr.lruCache.maxSize = 165;
        tr.lruCache.minBytesSize = 384 * 1024 * 1024;
        tr.lruCache.maxBytesSize = 768 * 1024 * 1024;
      } else {
        tr.lruCache.minSize = 160;
        tr.lruCache.maxSize = 220;
        tr.lruCache.minBytesSize = 512 * 1024 * 1024;
        tr.lruCache.maxBytesSize = 1024 * 1024 * 1024;
      }
      if (typeof tr.lruCache.scheduleUnload === "function") {
        tr.lruCache.scheduleUnload();
      }
    }
  }
  window.configureTilesRendererLodAndCaps = configureTilesRendererLodAndCaps;

  function computeTilesetContentSphere(tr, outSphere) {
    if (!tr || !tr.root) return false;
    if (typeof tr.getBoundingSphere === "function") {
      tr.getBoundingSphere(outSphere);
    }
    const isPreviewRenderer = Boolean(previewThree && previewThree.tilesRenderer === tr);
    const vType = isPreviewRenderer ? "preview" : (tr._gsViewerType || "studio");
    const lodMode = isPreviewRenderer
      ? (STATE.previewLodMode || "rough")
      : vType === "compare" || vType === "align"
      ? "auto"
      : (STATE.scanLodMode || "auto");
    configureTilesRendererLodAndCaps(tr, lodMode, vType);
    // If root has no direct content URI (e.g. PIX4Dmatic cubic octree where root box is in the sky),
    // or if root box spans > 1,500m horizontally (Safeguard C: multi-island scan), walk content nodes and center on the dominant island.
    const rootBox = tr.root.boundingVolume && Array.isArray(tr.root.boundingVolume.box) ? tr.root.boundingVolume.box : null;
    const rootSpanHalfXY = rootBox && rootBox.length >= 12 ? Math.max(Math.abs(Number(rootBox[3]) || 0), Math.abs(Number(rootBox[7]) || 0)) : 0;
    const isTightRootBox =
      rootBox &&
      rootBox.length >= 12 &&
      Math.abs(Math.abs(Number(rootBox[3])) - Math.abs(Number(rootBox[11]))) > 0.5 &&
      rootSpanHalfXY < 750;
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
        let pts = byDepth.get(maxDepth) || [];
        // Safeguard C: If leaf nodes span > 1,000m across disconnected islands, cluster and frame the dominant island
        if (pts.length > 2) {
          let spanMinX = Infinity, spanMaxX = -Infinity, spanMinY = Infinity, spanMaxY = -Infinity;
          for (const p of pts) {
            if (p.x < spanMinX) spanMinX = p.x;
            if (p.x > spanMaxX) spanMaxX = p.x;
            if (p.y < spanMinY) spanMinY = p.y;
            if (p.y > spanMaxY) spanMaxY = p.y;
          }
          if (Math.hypot(spanMaxX - spanMinX, spanMaxY - spanMinY) > 1000) {
            const visited = new Uint8Array(pts.length);
            let bestCluster = pts;
            for (let i = 0; i < pts.length; i++) {
              if (visited[i]) continue;
              visited[i] = 1;
              const cluster = [pts[i]];
              const queue = [i];
              while (queue.length > 0) {
                const cur = queue.pop();
                const cp = pts[cur];
                for (let j = 0; j < pts.length; j++) {
                  if (visited[j]) continue;
                  if (Math.hypot(pts[j].x - cp.x, pts[j].y - cp.y) <= 1000) {
                    visited[j] = 1;
                    cluster.push(pts[j]);
                    queue.push(j);
                  }
                }
              }
              if (cluster === pts || cluster.length > bestCluster.length || bestCluster === pts) {
                if (bestCluster === pts || cluster.length > bestCluster.length) {
                  bestCluster = cluster;
                }
              }
            }
            if (bestCluster.length > 0) pts = bestCluster;
          }
        }
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
        const calcR = Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.42;
        outSphere.radius = calcR < 12 ? Math.max(0.4, calcR) : Math.max(18, calcR);
        outSphere._groundOffsetY = calcR < 12 ? minZ - medZ - 0.02 : Math.min(-1.5, minZ - medZ - 0.3);
      }
    } else if (outSphere.radius > 0) {
      const scaledR = outSphere.radius * 0.72;
      outSphere.radius = outSphere.radius < 14 ? Math.max(0.4, outSphere.radius * 0.92) : Math.max(18, scaledR);
      if (rootBox && rootBox.length >= 12) {
        const hz =
          Math.abs(Number(rootBox[5]) || 0) +
          Math.abs(Number(rootBox[8]) || 0) +
          Math.abs(Number(rootBox[11]) || 0);
        if (outSphere.radius < 12) {
          outSphere._groundOffsetY = hz > 0 ? -(hz + 0.02) : -outSphere.radius * 0.85;
        } else {
          outSphere._groundOffsetY = hz > 0 ? -Math.min(hz + 0.3, 24.0) : -Math.max(4.0, Math.min(20.0, outSphere.radius * 0.25));
        }
      } else {
        outSphere._groundOffsetY = outSphere.radius < 12 ? -outSphere.radius * 0.85 : -Math.max(4.0, Math.min(20.0, outSphere.radius * 0.25));
      }
    }
    return outSphere.radius > 0;
  }

  function loadScanIntoPreview(scanId, forceReload = false) {
    const scan = STATE.scans.find((s) => s.scan_id === scanId) || STATE.scans[0];
    if (!scan) return;
    if (STATE.activeView !== "map") {
      STATE.selectedTimelineScanId = scan.scan_id;
      return;
    }
    initPreview3D();
    syncPreviewRendererContainer();
    if (!previewThree) return;

    const titleEl = document.getElementById("previewScanTitle");
    if (titleEl) titleEl.textContent = scan.name;
    const metaEl = document.getElementById("previewScanMeta");
    if (metaEl) {
      if (typeof isLibraryScan === "function" && isLibraryScan(scan)) {
        metaEl.textContent = `${scan.capture_date} · ${scan.uploader_name} · 📁 ${scan.project_group || "3D Library"} · ${formatScanPolyCount(scan)}`;
      } else {
        metaEl.textContent = `${scan.capture_date} · ${scan.uploader_name} · ${formatCoveredAreaM2(scan)} · E ${Number(scan.twd97_e).toFixed(1)} N ${Number(scan.twd97_n).toFixed(1)} H +${Number(scan.twd97_h).toFixed(2)}m`;
      }
    }

    const hasLoadedPreviewContent =
      Boolean(previewThree.gaussianSplatMesh) ||
      (previewThree.tilesRenderer && Number(previewThree.tilesRenderer.stats?.failed || 0) === 0) ||
      (!previewThree.tilesRenderer && previewThree.modelPivot && previewThree.modelPivot.children.length > 0) ||
      !previewThree._loadingDone;

    if (!forceReload && previewThree._loadingScanId === scan.scan_id && hasLoadedPreviewContent) {
      STATE.selectedTimelineScanId = scan.scan_id;
      STATE.activeScanId = scan.scan_id;
      STATE.activeScan = scan;
      return;
    }

    STATE.selectedTimelineScanId = scan.scan_id;
    STATE.activeScanId = scan.scan_id;
    STATE.activeScan = scan;
    SHARE_TELEMETRY.recordScanViewed(scan, "preview");

    if (typeof disposeGaussianSplatFromContext === "function") {
      disposeGaussianSplatFromContext(previewThree);
    }
    if (previewThree.tilesRenderer) {
      previewThree.modelPivot.remove(previewThree.tilesRenderer.group);
      previewThree.tilesRenderer.dispose();
      previewThree.tilesRenderer = null;
    }
    disposeObject3DResources(previewThree.modelPivot);
    while (previewThree.modelPivot.children.length > 0) {
      previewThree.modelPivot.remove(previewThree.modelPivot.children[0]);
    }
    previewThree.modelPivot.rotation.set(0, 0, 0);
    if (previewThree.fallbackGroup) previewThree.fallbackGroup.visible = false;

    previewThree._retriedOnce = false;
    if (scan.status && scan.status !== "completed" && !scan.stream_url) {
      if (previewThree.fallbackGroup) previewThree.fallbackGroup.visible = true;
      framePreviewCamera();
      const pendingMsg =
        scan.status === "processing"
          ? `Processing in PIX4Dmatic (${Math.round(scan.progress_pct || 0)}%) — ${scan.stage_label || ""}`
          : scan.status === "queued"
          ? `Queued for PIX4Dmatic — ${scan.stage_label || "Waiting in Queue"}`
          : scan.status === "waiting_parts"
          ? `Waiting for Split Upload Parts — ${scan.stage_label || ""}`
          : formatPendingScanStatusMessage(scan);
      finishScanLoader(previewThree, "preview", pendingMsg);
      return;
    }
    startScanLoader(previewThree, "preview", `${scan.name} (Interactive Preview)`, scan.scan_id);

    const isMobileOrTab = typeof isMobileOrTabletDevice === "function" && isMobileOrTabletDevice();
    const isIOS = typeof isIOSOrIPadDevice === "function" && isIOSOrIPadDevice();
    const lodMode = STATE.previewLodMode || "rough";
    const useRoughTilesetOnly = lodMode === "rough" && isIOS;
    const streamUrl = useRoughTilesetOnly
      ? scan.preview_stream_url ||
        (scan.stream_url
          ? scan.stream_url.replace("/tileset.json", "/preview_tileset.json")
          : `/stream/${scan.scan_id}/preview_tileset.json`)
      : scan.stream_url ||
        scan.preview_stream_url ||
        `/stream/${scan.scan_id}/tileset.json`;
    const streamType = useRoughTilesetOnly ? scan.preview_stream_type || scan.stream_type : scan.stream_type || scan.preview_stream_type;
    previewThree._loadedTilesetUrl = streamUrl;
    document.querySelectorAll("#previewLodModeSwitcher [data-lod-mode]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.lodMode === lodMode);
    });

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
            previewThree.tilesCenter = [sphere.center.x, sphere.center.y, sphere.center.z];
          }
          if (previewThree.grid) {
            previewThree.grid.position.y = Number.isFinite(box.min.y)
              ? box.min.y - sphere.center.y - 0.3
              : -0.2;
          }
          model.traverse((c) => {
            if (c.isMesh && c.material) {
              const mats = Array.isArray(c.material) ? c.material : [c.material];
              mats.forEach((m) => {
                if (m && typeof m.metalness === "number" && m.metalness > 0) {
                  m.metalness = 0.0;
                  m.roughness = 1.0;
                }
                if (m && m.side !== THREE.DoubleSide) {
                  m.side = THREE.DoubleSide;
                }
                applyBrightnessToMaterial(m, STATE.scanBrightness);
              });
            }
          });
          previewThree.modelPivot.add(model);
          previewThree.boundingSphere = sphere;
          updateScanGoogleMap3DLayer(previewThree, scan);
          scheduleScanGoogleMapCoverageUpdate(previewThree, scan, 30);
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
      tr.preprocessURL = (uri) => preprocessTileStreamUrl(uri, streamUrl);
      tr.setCamera(previewThree.camera);
      tr.setResolutionFromRenderer(previewThree.camera, previewThree.renderer);

      const gltfLoader = new THREE.GLTFLoader(tr.manager);
      if (window.MeshoptDecoder) gltfLoader.setMeshoptDecoder(window.MeshoptDecoder);
      const ktx2 = getKTX2Loader(previewThree.renderer);
      if (ktx2) gltfLoader.setKTX2Loader(ktx2);
      tr.manager.addHandler(/\.(gltf|glb)(\?.*)?$/i, gltfLoader);

      tr.addEventListener("load-tileset", () => {
        if (previewThree.tilesRenderer !== tr) return;
        if (tr._rootCentered) return;
        tr._rootCentered = true;
        previewThree._tilesetReady = true;
        previewThree._tilesetReadyMs = performance.now();
        previewThree._maxPct = Math.max(previewThree._maxPct || 0, 22);
        updateScanLoader("preview", true, previewThree._maxPct, "Streaming interactive preview...");
        const sphere = new THREE.Sphere();
        if (computeTilesetContentSphere(tr, sphere)) {
          tr.group.position.set(-sphere.center.x, -sphere.center.y, -sphere.center.z);
          previewThree.tilesCenter = [sphere.center.x, sphere.center.y, sphere.center.z];
          previewThree.modelPivot.rotation.set(THREE.MathUtils.degToRad(270), 0, 0);
          previewThree.modelPivot.updateMatrixWorld(true);
          previewThree.boundingSphere = sphere;
          if (previewThree.grid) {
            if (Number.isFinite(scan._resolvedGroundH)) {
              previewThree.grid.position.y = scan._resolvedGroundH - sphere.center.z - 0.19;
            } else {
              previewThree.grid.position.y = Number.isFinite(sphere._groundOffsetY)
                ? sphere._groundOffsetY
                : -8.0;
            }
          }
          updateScanGoogleMap3DLayer(previewThree, scan);
          framePreviewCamera();
          previewThree.currentScanId = scan.scan_id;
          previewThree.qualityMode = lodMode;
          const isGsplat = Boolean(scan.is_gaussian_splat || tr.root?.extras?.is_gaussian_splat || tr.root?.parent?.extras?.is_gaussian_splat);
          if (isGsplat && typeof loadGaussianSplatIntoContext === "function") {
            scan.is_gaussian_splat = true;
            loadGaussianSplatIntoContext(previewThree, scan, "preview", () => {
              finishScanLoader(previewThree, "preview", tr("100% · 3D 高斯潑濺已就緒", "100% · 3D Gaussian Splat Ready"));
            });
          }
        }
        previewThree.camera.updateMatrixWorld();
        tr.update();
      });

      tr.addEventListener("load-model", (ev) => {
        if (previewThree.tilesRenderer !== tr) return;
        if (ev && ev.scene) {
          if (previewThree.fallbackGroup) previewThree.fallbackGroup.visible = false;
          const isGsplat = Boolean(scan.is_gaussian_splat || tr.root?.extras?.is_gaussian_splat || tr.root?.parent?.extras?.is_gaussian_splat);
          ev.scene.traverse((c) => {
            if (c.isMesh && c.material) {
              const mats = Array.isArray(c.material) ? c.material : [c.material];
              mats.forEach((m) => {
                if (!m) return;
                if (isGsplat) {
                  m.transparent = true;
                  m.opacity = 0.0;
                  m.depthWrite = false;
                  m.colorWrite = false;
                  m.needsUpdate = true;
                  return;
                }
                if (typeof m.metalness === "number" && m.metalness > 0) {
                  m.metalness = 0.0;
                  m.roughness = 1.0;
                }
                if (m.side !== THREE.DoubleSide) {
                  m.side = THREE.DoubleSide;
                }
                applyBrightnessToMaterial(m, STATE.scanBrightness);
              });
            }
          });
          previewThree.camera.updateMatrixWorld();
          tr.update();
          scheduleScanGoogleMapCoverageUpdate(previewThree, scan, 90);
          previewThree.renderer.render(previewThree.scene, previewThree.camera);
          syncTilesLoaderProgress(previewThree, "preview");
        }
      });

      configureTilesRendererLodAndCaps(tr, lodMode, "preview");
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
    const crsPill = document.getElementById("timelineCrsExtraPill");
    if (crsPill) {
      crsPill.style.display = "none";
    }
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
    if (typeof gsMap !== "undefined" && gsMap && typeof gsMap.drawMap === "function") {
      gsMap.drawMap();
    }
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
      (allGroups[0] ? allGroups[0].project_group : "__all__");
    const isAllProjects = grpName === "__all__";
    STATE.activeProjectGroup = grpName;
    STATE.siteTimelineOpen = true;
    document.getElementById("viewMap")?.classList.add("mobile-site-open");

    // Only switch back to Map view if explicitly requested by user navigation
    if (forceSwitchToMap && STATE.activeView !== "map") {
      switchView("map");
    }
    splitEl.classList.add("active");
    document.querySelectorAll(".scan-cluster-blob").forEach((b) => {
      b.classList.toggle("active-cluster", !isAllProjects && b.dataset.projectGroup === grpName);
    });
    if (STATE.activeView === "map") {
      syncPreviewRendererContainer();
      if (gsMap && gsMap.drawMap) gsMap.drawMap();
    }

    let siteScans = (isAllProjects ? STATE.scans : STATE.scans.filter((s) => s.project_group === grpName))
      .slice()
      .sort((a, b) => String(b.capture_date || "").localeCompare(String(a.capture_date || "")));
    if (!siteScans.length) {
      siteScans = STATE.scans
        .slice()
        .sort((a, b) => String(b.capture_date || "").localeCompare(String(a.capture_date || "")));
    }

    const chosenScan =
      (preferredScanId && siteScans.find((s) => s.scan_id === preferredScanId)) ||
      siteScans.find((s) => s.scan_id === STATE.activeScanId) ||
      siteScans[0];

    populateProjectScanDropdowns(grpName, chosenScan ? chosenScan.scan_id : null);

    const roleInfo = getCurrentUserRoleInfo();
    const btnRenSite = document.getElementById("btnRenameTimelineSite");
    if (btnRenSite) {
      btnRenSite.style.display = roleInfo.canEditNames && !isAllProjects ? "inline-flex" : "none";
    }

    // Populate Header
    const titleEl = document.getElementById("timelineSiteTitle");
    if (titleEl) {
      titleEl.textContent = isAllProjects ? tr("全部工區", "All Project Sites") : grpName;
    }
    const countEl = document.getElementById("timelineSiteCountPill");
    if (countEl) {
      countEl.textContent = isAllProjects
        ? tr(
            `${allGroups.length} 個工區 · ${siteScans.length} 組掃描`,
            `${allGroups.length} Site${allGroups.length === 1 ? "" : "s"} · ${siteScans.length} Scan${siteScans.length === 1 ? "" : "s"}`
          )
        : tr(
            `${siteScans.length} 組掃描`,
            `${siteScans.length} Scan${siteScans.length === 1 ? "" : "s"}`
          );
    }
    const crsExtraPill = document.getElementById("timelineCrsExtraPill");
    if (crsExtraPill) {
      crsExtraPill.style.display = "none";
    }
    const subEl = document.getElementById("timelineSiteSubtitle");
    if (subEl && siteScans[0]) {
      const rawSubZh = String(siteScans[0].project_name_zh || "工程掃描群組");
      const enSubName = rawSubZh.replace(/工程掃描群組/g, "Engineering Scan Group");
      subEl.textContent = isAllProjects
        ? tr(
            "全部工區依最新日期排序 · 點選任一掃描卡片即可於下方預覽",
            "All project sites sorted newest-first · Select any scan tile to preview below"
          )
        : tr(
            `${rawSubZh} · 點選時間軸上的掃描卡片即可於下方預覽`,
            `${enSubName} · Select a scan tile on the timeline to preview below`
          );
    }
    const timelineProjSel = document.getElementById("timelineProjectSelect");
    if (timelineProjSel && Array.from(timelineProjSel.options).some((o) => o.value === grpName)) {
      timelineProjSel.value = grpName;
    }
    const mapProjSel = document.getElementById("mapProjectSelect");
    if (mapProjSel && Array.from(mapProjSel.options).some((o) => o.value === grpName)) {
      mapProjSel.value = grpName;
    }

    // Populate Horizontal Timeline Tiles Track
    ensureTimelineAndDockWheelScroll();
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
        const texLabel = formatScanTextureSize(s, { short: true });
        const polyShort = formatScanPolyCount(s, { short: true });
        const sizeShort = formatScanSizeMb(s);
        const safeName = escapeHtml(s.name || s.scan_id);
        const safeUploader = escapeHtml(s.uploader_name || "Engineer");
        const safeEmail = escapeHtml(s.uploader_email || "");
        const safeGroup = escapeHtml(s.project_group || "");

        tile.innerHTML = `
          <div class="gs-tile-thumb-wrap">
            <img class="gs-tile-thumb" data-scan-thumb="${escapeHtml(s.scan_id)}" src="${thumbSrc}" alt="${safeName}" />
            <div class="gs-tile-badge-row">
              ${formatScanQueueStatusBadgeHtml(s)}
              <span class="gs-tile-chip" title="${tr("網格面數", "Polygons")}: ${escapeHtml(formatScanPolyCount(s))} · ${tr("貼圖解析度", "Texture")}: ${escapeHtml(formatScanTextureSize(s))} · ${tr("掃描大小", "Scan Size")}: ${escapeHtml(sizeShort)}">${escapeHtml(polyShort)} · ${escapeHtml(texLabel)} · ${escapeHtml(sizeShort)}</span>
              <span class="gs-tile-chip ${isSelected ? "active-indicator" : ""}" data-rtk-chip="1">${formatCoveredAreaM2(s)}</span>
            </div>
          </div>
          <div class="gs-tile-meta">
            <div class="gs-tile-date-row" style="display:flex;align-items:center;justify-content:space-between;gap:4px;">
              <span class="gs-tile-date">${escapeHtml(s.capture_date || "")}</span>
              ${
                isAllProjects && safeGroup
                  ? `<span style="font-size:9.5px;font-weight:700;padding:1px 5px;border-radius:4px;background:var(--ui-accent-soft);color:var(--ui-accent);max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${safeGroup}">${safeGroup}</span>`
                  : ""
              }
            </div>
            <div class="gs-tile-uploader" title="${safeUploader} (${safeEmail})">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
              </svg>
              <span>${safeUploader}</span>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;min-width:0;">
              <div class="gs-tile-name" title="${safeName}" style="flex:1;min-width:0;">${safeName}</div>
              <div class="gs-tile-edit-actions" style="display:${roleInfo.canEditNames ? "flex" : "none"};align-items:center;gap:2px;flex-shrink:0;">
                <button type="button" class="btn-xs" data-move-tile="${escapeHtml(s.scan_id)}" title="${tr("移動至其他工區或 3D 模型庫資料夾", "Move to another Site or 3D Library Folder")}" style="height:18px;padding:0 4px;">
                  ⇄
                </button>
                <button type="button" class="btn-xs" data-rename-tile="${escapeHtml(s.scan_id)}" title="${tr("修改掃描名稱", "Edit Scan Name")}" style="height:18px;padding:0 4px;">
                  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                  </svg>
                </button>
                <button type="button" class="btn-xs" data-delete-tile="${escapeHtml(s.scan_id)}" title="${tr("刪除掃描", "Delete Scan")}" style="height:18px;padding:0 4px;color:#ef4444;">
                  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        `;

        tile.addEventListener("click", (ev) => {
          if (ev.target.closest("[data-move-tile]") || ev.target.closest("[data-rename-tile]") || ev.target.closest("[data-delete-tile]")) return;
          selectTimelineTile(s.scan_id);
        });
        const moveTileBtn = tile.querySelector("[data-move-tile]");
        if (moveTileBtn) {
          moveTileBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (typeof openMoveScanModal === "function") openMoveScanModal(s.scan_id);
          });
        }
        const renTileBtn = tile.querySelector("[data-rename-tile]");
        if (renTileBtn) {
          renTileBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            openRenameScanModal(s.scan_id);
          });
        }
        const delTileBtn = tile.querySelector("[data-delete-tile]");
        if (delTileBtn) {
          delTileBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            openDeleteScanModal(s.scan_id);
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

  function bindHorizontalWheelScroll(listenEl, scrollTargetEl = listenEl) {
    if (!listenEl || !scrollTargetEl || listenEl._gsHorizWheelBound) return;
    listenEl._gsHorizWheelBound = true;
    listenEl.addEventListener(
      "wheel",
      (e) => {
        if (e.target && e.target.closest && e.target.closest("select")) return;
        if (scrollTargetEl.scrollWidth <= scrollTargetEl.clientWidth + 1) return;
        const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        if (delta !== 0) {
          e.preventDefault();
          scrollTargetEl.scrollLeft += delta;
        }
      },
      { passive: false }
    );
  }

  function ensureTimelineAndDockWheelScroll() {
    const trackEl = document.getElementById("siteTimelineTilesTrack");
    const topPaneEl = document.getElementById("siteTimelineTopPane");
    if (trackEl) {
      bindHorizontalWheelScroll(trackEl, trackEl);
      if (topPaneEl) bindHorizontalWheelScroll(topPaneEl, trackEl);
    }
    const bottomDockEl = document.getElementById("bimBottomDock");
    if (bottomDockEl) {
      bindHorizontalWheelScroll(bottomDockEl, bottomDockEl);
    }
  }
  ensureTimelineAndDockWheelScroll();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureTimelineAndDockWheelScroll);
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
      folderInfo.textContent = tr(
        `原始檔案／資料夾：${fileBase} · ${scan.project_group || "工區"}`,
        `File / Folder: ${fileBase} · ${scan.project_group || "Site"}`
      );
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
  document.getElementById("btnMovePreviewScan")?.addEventListener("click", () => {
    if (typeof openMoveScanModal === "function") openMoveScanModal(STATE.selectedTimelineScanId || STATE.activeScanId);
  });
  document.getElementById("previewScanTitle")?.addEventListener("dblclick", () => {
    if (!STATE.shareToken) openRenameScanModal(STATE.selectedTimelineScanId || STATE.activeScanId);
  });
  document.getElementById("btnRenameStudioScan")?.addEventListener("click", () => {
    openRenameScanModal(STATE.activeScanId);
  });
  document.getElementById("btnMoveStudioScan")?.addEventListener("click", () => {
    if (typeof openMoveScanModal === "function") openMoveScanModal(STATE.activeScanId);
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

  let _deletingScanId = "";
  let _cachedBinScans = [];

  function updateRecycleBinBadges(count) {
    const n = Math.max(0, Number(count) || 0);
    const topBadge = document.getElementById("topRecycleBinBadge");
    if (topBadge) {
      topBadge.textContent = String(n);
      topBadge.style.display = n > 0 ? "inline-block" : "none";
    }
    const tlBadge = document.getElementById("timelineRecycleBinBadge");
    if (tlBadge) {
      tlBadge.textContent = String(n);
      tlBadge.style.display = n > 0 ? "inline-block" : "none";
    }
    const studioBadge = document.getElementById("studioRecycleBinBadge");
    if (studioBadge) {
      studioBadge.textContent = String(n);
      studioBadge.style.display = n > 0 ? "inline-block" : "none";
    }
    const modalPill = document.getElementById("recycleBinModalCountPill");
    if (modalPill) {
      modalPill.textContent = tr(`${n} 組掃描`, `${n} Scan${n === 1 ? "" : "s"}`);
    }
    const btnClear = document.getElementById("btnClearAllBinScans");
    if (btnClear) {
      btnClear.disabled = n === 0;
      btnClear.style.opacity = n === 0 ? "0.5" : "1";
    }
  }

  function openDeleteScanModal(scanId) {
    if (!getCurrentUserRoleInfo().canEditNames) {
      showToast(tr("僅編輯者、管理員或擁有者可將掃描移至回收桶。", "Only Editor, Admin, or Owner accounts can move scans to the Bin."));
      return;
    }
    const targetId = scanId || STATE.selectedTimelineScanId || STATE.activeScanId;
    const scan = STATE.scans.find((s) => s.scan_id === targetId) || STATE.activeScan;
    if (!scan) {
      showToast(tr("尚未選取要移至回收桶的掃描。", "No scan selected to move to the Bin."));
      return;
    }
    _deletingScanId = scan.scan_id;
    const nameEl = document.getElementById("deleteScanTargetName");
    const metaEl = document.getElementById("deleteScanTargetMeta");
    const fileBase = getScanDefaultFileName(scan);
    if (nameEl) nameEl.textContent = scan.name || fileBase;
    if (metaEl) {
      metaEl.textContent = tr(
        `工區：${scan.project_group || "工區"} · 日期：${scan.capture_date || "—"} · ID: ${scan.scan_id}`,
        `Site: ${scan.project_group || "Site"} · Date: ${scan.capture_date || "—"} · ID: ${scan.scan_id}`
      );
    }
    openModal("deleteScanModal");
  }

  function applyUpdatedCatalogState(res, preferredGroup = "", preferredScanId = "") {
    if (Array.isArray(res.scans)) {
      STATE.scans = res.scans;
    }
    if (Array.isArray(res.projects)) {
      STATE.projects = res.projects;
    }
    if (Array.isArray(res.library_folders)) {
      STATE.libraryFolders = res.library_folders;
    }
    if (typeof renderModelLibraryView === "function") {
      renderModelLibraryView();
    }
    if (typeof res.bin_scans_count === "number") {
      updateRecycleBinBadges(res.bin_scans_count);
    } else if (Array.isArray(res.bin_scans)) {
      updateRecycleBinBadges(res.bin_scans.length);
    }
    try {
      localStorage.setItem(
        "gs_last_catalog_v1",
        JSON.stringify({ scans: STATE.scans, projects: STATE.projects })
      );
    } catch (_) {}

    const targetGroup = preferredGroup || STATE.activeProjectGroup;
    const remainingInGroup = STATE.scans.filter((s) => s.project_group === targetGroup);
    const chosenById = preferredScanId ? STATE.scans.find((s) => s.scan_id === preferredScanId) : null;
    const nextScan = chosenById || remainingInGroup[0] || STATE.scans[0] || null;
    const nextGroup = nextScan ? nextScan.project_group : "";
    const nextId = nextScan ? nextScan.scan_id : "";

    STATE.activeProjectGroup = nextGroup;
    STATE.activeScanId = nextId;
    STATE.activeScan = nextScan;
    STATE.selectedTimelineScanId = nextId;

    populateProjectScanDropdowns(nextGroup, nextId);
    renderMapClusters();
    if (nextGroup) {
      openSiteTimeline(nextGroup, nextId);
    }
    if (STATE.activeView === "studio" && nextId) {
      switchView("studio", nextId);
    } else if (STATE.activeView === "studio" && !nextId) {
      switchView("map");
    }
  }

  async function confirmDeleteScan() {
    const scan = STATE.scans.find((s) => s.scan_id === _deletingScanId);
    if (!scan) {
      closeModal("deleteScanModal");
      return;
    }
    const btn = document.getElementById("btnConfirmDeleteScan");
    const origText = btn ? btn.textContent : "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Moving to Bin...";
    }
    try {
      const deletedName = scan.name || scan.scan_id;
      const deletedGroup = scan.project_group;
      const res = await apiPost("/api/scans/delete", {
        scan_id: scan.scan_id,
        actor_name: STATE.currentUser?.name || STATE.currentUser?.email || "User",
      });
      if (!Array.isArray(res.scans)) {
        res.scans = STATE.scans.filter((s) => s.scan_id !== scan.scan_id);
      }
      applyUpdatedCatalogState(res, deletedGroup, "");
      closeModal("deleteScanModal");
      showToast(`Moved scan to Recycle Bin: ${deletedName}`);
    } catch (err) {
      showToast(`Failed to move scan to Bin: ${err.message}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = origText || tr("移至回收桶", "Move to Bin");
      }
    }
  }

  function updateBinSelectionActionState() {
    const boxes = Array.from(document.querySelectorAll("#recycleBinListContainer .chk-bin-scan-item"));
    const checked = boxes.filter((b) => b.checked);
    const countEl = document.getElementById("recycleBinSelectedCount");
    if (countEl) countEl.textContent = String(checked.length);
    const allChk = document.getElementById("chkSelectAllBinScans");
    if (allChk) {
      allChk.checked = boxes.length > 0 && checked.length === boxes.length;
      allChk.indeterminate = checked.length > 0 && checked.length < boxes.length;
      allChk.disabled = boxes.length === 0;
    }
    const btnRestore = document.getElementById("btnRestoreSelectedBinScans");
    const btnPurge = document.getElementById("btnPurgeSelectedBinScans");
    if (btnRestore) btnRestore.disabled = checked.length === 0;
    if (btnPurge) btnPurge.disabled = checked.length === 0;
  }

  function renderRecycleBinItems(items) {
    _cachedBinScans = Array.isArray(items) ? items : [];
    updateRecycleBinBadges(_cachedBinScans.length);
    const roleInfo = getCurrentUserRoleInfo();
    const canPurge = Boolean(roleInfo.canManageUsers);
    const btnPurgeSel = document.getElementById("btnPurgeSelectedBinScans");
    const btnClearAll = document.getElementById("btnClearAllBinScans");
    if (btnPurgeSel) btnPurgeSel.style.display = canPurge ? "inline-flex" : "none";
    if (btnClearAll) btnClearAll.style.display = canPurge ? "inline-flex" : "none";
    const footerEl = document.getElementById("recycleBinStatusFooter");
    if (footerEl) {
      footerEl.textContent = canPurge
        ? tr(
            "原始備份與已刪除掃描可隨時還原 · 永久刪除將從磁碟移除檔案。",
            "Original backups & deleted scans can be restored anytime · Permanent delete removes files from disk."
          )
        : tr(
            "原始備份與已刪除掃描可隨時還原（永久刪除需管理員權限）。",
            "Original backups & deleted scans can be restored anytime (Permanent delete requires Admin / Owner)."
          );
    }
    const listEl = document.getElementById("recycleBinListContainer");
    if (!listEl) return;
    if (_cachedBinScans.length === 0) {
      listEl.innerHTML = `
        <div style="padding:32px 16px;text-align:center;color:var(--ui-text-muted);font-size:12.5px;border:1px dashed var(--ui-border);border-radius:8px;">
          ${tr("回收桶目前沒有掃描備份或檔案。", "Recycle Bin is empty.")}
        </div>
      `;
      updateBinSelectionActionState();
      return;
    }

    listEl.innerHTML = "";
    _cachedBinScans.forEach((item) => {
      const sid = String(item.scan_id || "");
      const safeName = escapeHtml(item.name || sid);
      const safeGroup = escapeHtml(item.project_group || "Site");
      const safeDate = escapeHtml(item.capture_date || "—");
      const safeActor = escapeHtml(item.trashed_by_name || item.trashed_by_email || "User");
      const sizeMb = item.size_bytes ? `${(Number(item.size_bytes) / (1024 * 1024)).toFixed(1)} MB` : "—";
      const trashedTime = item.trashed_at
        ? new Date(Number(item.trashed_at) * 1000).toLocaleString("zh-TW", { hour12: false })
        : "";
      const thumbSrc = item.thumbnail_url || `/api/scans/${encodeURIComponent(sid)}/thumbnail`;
      const isBackup = Boolean(item.is_edit_backup || /\((Original|Pre-Merge) Backup\)/i.test(String(item.name || "")));

      const row = document.createElement("div");
      row.className = "gs-bin-item-row recycle-bin-item";
      row.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:9px 12px;border:1px solid var(--ui-border);border-radius:8px;background:var(--ui-bg-elevated);";
      row.innerHTML = `
        <label style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer;">
          <input type="checkbox" class="chk-bin-scan-item" data-scan-id="${escapeHtml(sid)}" style="accent-color:#0284c7;width:15px;height:15px;flex-shrink:0;" />
          <img src="${thumbSrc}" alt="${safeName}" onerror="this.style.display='none'" style="width:52px;height:36px;object-fit:cover;border-radius:5px;border:1px solid var(--ui-border);flex-shrink:0;background:#0f172a;" />
          <div style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
              <span style="font-size:12.5px;font-weight:700;color:var(--ui-text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${safeName}</span>
              ${
                isBackup
                  ? `<span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:rgba(16,185,129,0.14);color:#10b981;">${tr("原始備份", "Backup")}</span>`
                  : ""
              }
              <span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:var(--ui-accent-soft);color:var(--ui-accent);">${safeGroup}</span>
              <span style="font-size:10.5px;color:var(--ui-text-secondary);font-family:var(--mono);">${safeDate} · ${item.image_count || 0} ${tr("張照片", "imgs")} · ${sizeMb}</span>
            </div>
            <div style="font-size:10.5px;color:var(--ui-text-muted);word-break:break-word;">
              ${isBackup ? tr("備份者：", "Archived by ") : tr("刪除者：", "Deleted by ")}${safeActor}${trashedTime ? ` · ${escapeHtml(trashedTime)}` : ""} · ID: <code>${escapeHtml(sid)}</code>
            </div>
          </div>
        </label>
        <div class="gs-bin-item-actions recycle-bin-item-actions" style="display:flex;align-items:center;gap:6px;flex-shrink:0;flex-wrap:wrap;">
          <button type="button" class="btn-xs primary" data-bin-restore="${escapeHtml(sid)}" title="${tr("將此掃描還原至地圖與 3D 工作台", "Restore this scan back to Map & Studio")}">
            ↩ ${tr("還原", "Restore")}
          </button>
          ${
            canPurge
              ? `<button type="button" class="btn-xs" data-bin-purge="${escapeHtml(sid)}" style="color:#ef4444;border-color:rgba(239,68,68,0.4);" title="${tr("從磁碟永久刪除此掃描與檔案", "Permanently delete this scan and its files from disk")}">
                  🗑 ${tr("永久刪除", "Delete Forever")}
                </button>`
              : ""
          }
        </div>
      `;

      row.querySelector(".chk-bin-scan-item")?.addEventListener("change", updateBinSelectionActionState);
      row.querySelector("[data-bin-restore]")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        restoreBinScans([sid]);
      });
      row.querySelector("[data-bin-purge]")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        purgeBinScans([sid], false);
      });
      listEl.appendChild(row);
    });
    updateBinSelectionActionState();
  }

  async function refreshRecycleBinList() {
    try {
      const res = await apiGet("/api/scans/bin");
      renderRecycleBinItems(res.bin_scans || []);
    } catch (err) {
      showToast(`Failed to load Recycle Bin: ${err.message}`);
    }
  }

  async function openRecycleBinModal() {
    const rInfo = getCurrentUserRoleInfo();
    if (!rInfo.canEditNames && !rInfo.canManageUsers) {
      showToast("Only Editor, Admin, or Owner accounts can access the Recycle Bin.");
      return;
    }
    closeModal("deleteScanModal");
    openModal("recycleBinModal");
    await refreshRecycleBinList();
  }

  async function restoreBinScans(scanIds) {
    const rInfo = getCurrentUserRoleInfo();
    if (!rInfo.canEditNames && !rInfo.canManageUsers) {
      showToast("Only Editor, Admin, or Owner accounts can restore scans from the Bin.");
      return;
    }
    if (!Array.isArray(scanIds) || scanIds.length === 0) return;
    try {
      const res = await apiPost("/api/scans/bin/restore", { scan_ids: scanIds });
      renderRecycleBinItems(res.bin_scans || []);
      const firstRestored = Array.isArray(res.restored) && res.restored[0] ? res.restored[0] : null;
      applyUpdatedCatalogState(
        res,
        firstRestored ? firstRestored.project_group : STATE.activeProjectGroup,
        firstRestored ? firstRestored.scan_id : STATE.activeScanId
      );
      showToast(`Restored ${scanIds.length} scan${scanIds.length === 1 ? "" : "s"} from Recycle Bin`);
    } catch (err) {
      showToast(`Failed to restore from Bin: ${err.message}`);
    }
  }

  async function purgeBinScans(scanIds, clearAll = false) {
    if (!getCurrentUserRoleInfo().canManageUsers) {
      showToast("Only Admin or Owner accounts can permanently delete scans from the Bin.");
      return;
    }
    try {
      const res = await apiPost("/api/scans/bin/purge", {
        scan_ids: scanIds || [],
        clear_all: Boolean(clearAll),
      });
      renderRecycleBinItems(res.bin_scans || []);
      applyUpdatedCatalogState(res, STATE.activeProjectGroup, STATE.activeScanId);
      const purgedCount = Array.isArray(res.purged_scan_ids) ? res.purged_scan_ids.length : (scanIds || []).length;
      showToast(
        clearAll
          ? `Emptied Recycle Bin (${purgedCount} scan${purgedCount === 1 ? "" : "s"} permanently deleted)`
          : `Permanently deleted ${purgedCount} scan${purgedCount === 1 ? "" : "s"} from Bin`
      );
    } catch (err) {
      showToast(`Failed to permanently delete from Bin: ${err.message}`);
    }
  }

  document.getElementById("btnDeletePreviewScan")?.addEventListener("click", () => {
    openDeleteScanModal(STATE.selectedTimelineScanId || STATE.activeScanId);
  });
  document.getElementById("btnDeleteStudioScan")?.addEventListener("click", () => {
    openDeleteScanModal(STATE.activeScanId);
  });
  document.getElementById("btnConfirmDeleteScan")?.addEventListener("click", confirmDeleteScan);
  document.getElementById("btnOpenRecycleBin")?.addEventListener("click", openRecycleBinModal);
  document.getElementById("btnTimelineRecycleBin")?.addEventListener("click", openRecycleBinModal);
  document.getElementById("btnStudioRecycleBin")?.addEventListener("click", openRecycleBinModal);
  document.getElementById("btnOpenBinFromDeleteModal")?.addEventListener("click", openRecycleBinModal);
  document.getElementById("chkSelectAllBinScans")?.addEventListener("change", (ev) => {
    const checked = Boolean(ev.target.checked);
    document.querySelectorAll("#recycleBinListContainer .chk-bin-scan-item").forEach((b) => {
      b.checked = checked;
    });
    updateBinSelectionActionState();
  });
  document.getElementById("btnRestoreSelectedBinScans")?.addEventListener("click", () => {
    const ids = Array.from(document.querySelectorAll("#recycleBinListContainer .chk-bin-scan-item:checked"))
      .map((b) => b.getAttribute("data-scan-id"))
      .filter(Boolean);
    restoreBinScans(ids);
  });
  document.getElementById("btnPurgeSelectedBinScans")?.addEventListener("click", () => {
    const ids = Array.from(document.querySelectorAll("#recycleBinListContainer .chk-bin-scan-item:checked"))
      .map((b) => b.getAttribute("data-scan-id"))
      .filter(Boolean);
    purgeBinScans(ids, false);
  });
  document.getElementById("btnClearAllBinScans")?.addEventListener("click", () => {
    purgeBinScans([], true);
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
      subEl.textContent = tr(
        `目前工區：${targetGroup} · ${siteScans.length} 組掃描`,
        `Current Site: ${targetGroup} · ${siteScans.length} Scan${siteScans.length === 1 ? "" : "s"}`
      );
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
    const vd = document.getElementById("rerunSelVertexDensity")?.value || "High";
    return {
      mesh_pipeline: document.getElementById("rerunSelMeshPipeline")?.value || "Scalable",
      mesh_quality: document.getElementById("rerunSelMeshQuality")?.value || "High",
      vertex_density: vd,
      dense_image_scale: vd === "High" ? "Full" : vd === "Low" ? "Quarter" : "Half",
      depth_min_confidence: vd === "High" ? "Medium" : "High",
      depth_agreement_m: vd === "High" ? 0.01 : 0.02,
      texture_size: Number(document.getElementById("rerunSelTextureSize")?.value || 16384),
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
    if (nameEl) nameEl.textContent = `${scan.name} · ${scan.project_group}`;
    const srcEl = document.getElementById("rerunScanInfoSource");
    if (srcEl) {
      const pCount = scan.image_count || scan.total_photos || 100;
      const srcPath = scan.source_zip_path || `${scan.project_dir || "C:\\GatheringScans\\" + scan.scan_id}\\inputs`;
      srcEl.textContent = tr(
        `原始照片來源：${srcPath} · ${pCount} 張 RTK 照片`,
        `Original Photos Source: ${srcPath} · ${pCount} RTK photos`
      );
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
    STATE.siteTimelineOpen = false;
    document.getElementById("viewMap")?.classList.remove("mobile-site-open");
    document.getElementById("siteTimelineSplitView")?.classList.remove("active");
    syncPreviewRendererContainer();
    setTimeout(() => {
      if (gsMap && gsMap.drawMap) gsMap.drawMap();
    }, 30);
  }
  window.closeSiteTimeline = closeSiteTimeline;

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
  // TWD97-ALIGNED 3D GOOGLE MAP SURROUNDINGS LAYER WITH SCANNED-AREA MASKING
  // ============================================================================
  function twd97ToWgs84JS(
    easting,
    northing,
    lon0Deg = 121.0,
    fe = 250000.0,
    k0 = 0.9999,
    fInv = 298.257222101
  ) {
    const a = 6378137.0;
    const f = 1.0 / fInv;
    const b = a * (1.0 - f);
    const e2 = (a * a - b * b) / (a * a);
    const ep2 = (a * a - b * b) / (b * b);

    const x = Number(easting) - fe;
    const y = Number(northing);
    const M = y / k0;
    const mu = M / (a * (1.0 - e2 / 4.0 - (3.0 * e2 * e2) / 64.0 - (5.0 * e2 * e2 * e2) / 256.0));
    const e1 = (1.0 - Math.sqrt(1.0 - e2)) / (1.0 + Math.sqrt(1.0 - e2));
    const j1 = (3.0 * e1) / 2.0 - (27.0 * Math.pow(e1, 3)) / 32.0;
    const j2 = (21.0 * e1 * e1) / 16.0 - (55.0 * Math.pow(e1, 4)) / 32.0;
    const j3 = (151.0 * Math.pow(e1, 3)) / 96.0;
    const j4 = (1097.0 * Math.pow(e1, 4)) / 512.0;
    const fp =
      mu +
      j1 * Math.sin(2.0 * mu) +
      j2 * Math.sin(4.0 * mu) +
      j3 * Math.sin(6.0 * mu) +
      j4 * Math.sin(8.0 * mu);
    const sinFp = Math.sin(fp);
    const cosFp = Math.max(1e-9, Math.cos(fp));
    const tanFp = Math.tan(fp);
    const c1 = ep2 * cosFp * cosFp;
    const t1 = tanFp * tanFp;
    const r1 = (a * (1.0 - e2)) / Math.pow(1.0 - e2 * sinFp * sinFp, 1.5);
    const n1 = a / Math.sqrt(1.0 - e2 * sinFp * sinFp);
    const d = x / (n1 * k0);

    const q1 = (n1 * tanFp) / r1;
    const q2 = (d * d) / 2.0;
    const q3 = ((5.0 + 3.0 * t1 + 10.0 * c1 - 4.0 * c1 * c1 - 9.0 * ep2) * Math.pow(d, 4)) / 24.0;
    const q4 =
      ((61.0 + 90.0 * t1 + 298.0 * c1 + 45.0 * t1 * t1 - 3.0 * c1 * c1 - 252.0 * ep2) * Math.pow(d, 6)) / 720.0;
    const latRad = fp - q1 * (q2 - q3 + q4);

    const q5 = d;
    const q6 = ((1.0 + 2.0 * t1 + c1) * Math.pow(d, 3)) / 6.0;
    const q7 =
      ((5.0 - 2.0 * c1 + 28.0 * t1 - 3.0 * c1 * c1 + 8.0 * ep2 + 24.0 * t1 * t1) * Math.pow(d, 5)) / 120.0;
    const lonRad = (lon0Deg * Math.PI) / 180.0 + (q5 - q6 + q7) / cosFp;
    return {
      lat: (latRad * 180.0) / Math.PI,
      lon: (lonRad * 180.0) / Math.PI,
    };
  }
  window.twd97ToWgs84JS = twd97ToWgs84JS;

  function resolveViewerOriginTwd97(ctx, scanObj) {
    const s = scanObj || STATE.activeScan || {};
    const crsCode = typeof inferActiveScanCrsCode === "function" ? inferActiveScanCrsCode(s) : "TWD97_121_TWVD2001";
    const crsList = typeof CRS_UI_CATALOG !== "undefined" ? CRS_UI_CATALOG : [];
    const crsDef = crsList.find((c) => c.code === crsCode) || {
      lon0: 121.0,
      fe: 250000.0,
      k0: 0.9999,
      fInv: 298.257222101,
    };
    const lon0 = Number(crsDef.lon0) || 121.0;
    const fe = Number(crsDef.fe) || 250000.0;
    const k0 = Number(crsDef.k0) || 0.9999;
    const fInv = Number(crsDef.fInv) || 298.257222101;

    let e0 = 0;
    let n0 = 0;
    let h0 = 0;
    if (typeof studioThree !== "undefined" && ctx === studioThree && typeof localToTwd97 === "function") {
      const orig = localToTwd97({ x: 0, y: 0, z: 0 });
      e0 = Number(orig.e) || 0;
      n0 = Number(orig.n) || 0;
      h0 = Number(orig.h) || 0;
    } else {
      const metaE = s.twd97_e !== undefined && s.twd97_e !== null ? Number(s.twd97_e) : 0;
      const metaN = s.twd97_n !== undefined && s.twd97_n !== null ? Number(s.twd97_n) : 0;
      const metaH = s.twd97_h !== undefined && s.twd97_h !== null ? Number(s.twd97_h) : 0;
      const tc = ctx?.tilesCenter;
      const isZUp = Boolean(
        ctx?.tilesRenderer &&
          Array.isArray(tc) &&
          tc.length >= 3 &&
          Math.abs(ctx?.modelPivot?.rotation?.x || 0) > 0.1
      );
      if (isZUp) {
        const tcNorm = Math.hypot(tc[0], tc[1], tc[2]);
        if (tcNorm > 50000 && tcNorm < 4000000) {
          if (tc[0] > 345000 && tc[0] <= 415000 && metaE >= 150000 && metaE <= 345000) {
            e0 = metaE;
            n0 = metaN;
            h0 = tc[2] < -50 && metaH > -50 ? metaH : tc[2];
          } else {
            e0 = tc[0];
            n0 = tc[1];
            h0 = tc[2] < -50 && metaH > -50 ? metaH : tc[2];
          }
        } else {
          e0 = metaE;
          n0 = metaN;
          h0 = metaH;
        }
      } else {
        e0 = metaE;
        n0 = metaN;
        h0 = metaH;
      }
    }

    let valid = Math.abs(e0) >= 50000 && Math.abs(n0) >= 50000;
    if (!valid && typeof hasValidGeorefLatLon === "function" && hasValidGeorefLatLon(s) && typeof wgs84ToTransverseMercatorJS === "function") {
      const proj = wgs84ToTransverseMercatorJS(Number(s.lat), Number(s.lon), 121.0, 250000.0, 0.9999, 298.257222101);
      if (Number.isFinite(proj.e) && Number.isFinite(proj.n)) {
        e0 = proj.e;
        n0 = proj.n;
        valid = true;
      }
    }
    return { e: e0, n: n0, h: h0, lon0, fe, k0, fInv, valid };
  }

  function ensureScanGoogleMap3DLayer(ctx) {
    if (!ctx || !ctx.scene || !window.THREE) return null;
    if (ctx.googleMapLayer) return ctx.googleMapLayer;

    const MASK_N = 512;
    const maskData = new Uint8Array(MASK_N * MASK_N * 4);
    const maskTex = new THREE.DataTexture(maskData, MASK_N, MASK_N, THREE.RGBAFormat, THREE.UnsignedByteType);
    maskTex.magFilter = THREE.LinearFilter;
    maskTex.minFilter = THREE.LinearFilter;
    maskTex.wrapS = THREE.ClampToEdgeWrapping;
    maskTex.wrapT = THREE.ClampToEdgeWrapping;
    maskTex.flipY = false;
    maskTex.needsUpdate = true;

    const canvas = document.createElement("canvas");
    const isMob = typeof isMobileOrTabletDevice === "function" && isMobileOrTabletDevice();
    canvas.width = isMob ? 1024 : 2048;
    canvas.height = isMob ? 1024 : 2048;
    const mapTex = new THREE.CanvasTexture(canvas);
    mapTex.magFilter = THREE.LinearFilter;
    mapTex.minFilter = THREE.LinearMipmapLinearFilter;
    mapTex.anisotropy = isMob ? 4 : 8;
    mapTex.wrapS = THREE.ClampToEdgeWrapping;
    mapTex.wrapT = THREE.ClampToEdgeWrapping;

    const halfSpan = 320;
    const geom = new THREE.PlaneGeometry(halfSpan * 2, halfSpan * 2, 1, 1);
    geom.rotateX(-Math.PI / 2);

    const uniforms = {
      uMapTex: { value: mapTex },
      uCoverageMask: { value: maskTex },
      uCoverageTex: { value: maskTex },
      uOpacity: { value: Math.max(0.05, Math.min(1.0, Number(STATE.scanGoogleMapOpacity) || 0.5)) },
      uHalfSpan: { value: halfSpan },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: `
        uniform float uHalfSpan;
        varying vec2 vUv;
        #include <clipping_planes_pars_vertex>
        void main() {
          vUv = uv;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <clipping_planes_vertex>
        }
      `,
      fragmentShader: `
        uniform sampler2D uMapTex;
        uniform sampler2D uCoverageMask;
        uniform float uOpacity;
        varying vec2 vUv;
        #include <clipping_planes_pars_fragment>
        void main() {
          #include <clipping_planes_fragment>
          float cov = texture2D(uCoverageMask, vUv).a;
          if (cov > 0.88) discard;
          float scanMaskAlpha = 1.0 - smoothstep(0.15, 0.88, cov);
          vec4 mapCol = texture2D(uMapTex, vUv);
          if (mapCol.a < 0.01) discard;
          vec2 dEdge = abs(vUv - vec2(0.5)) * 2.0;
          float outerFade = 1.0 - smoothstep(0.92, 1.0, max(dEdge.x, dEdge.y));
          float finalAlpha = mapCol.a * uOpacity * outerFade * scanMaskAlpha;
          if (finalAlpha < 0.005) discard;
          gl_FragColor = vec4(mapCol.rgb, finalAlpha);
        }
      `,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      clipping: true,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = "scanGoogleMapGroundPlane";
    mesh.renderOrder = -4;
    mesh.frustumCulled = false;

    const group = new THREE.Group();
    group.name = "scanGoogleMapGroup";
    group.add(mesh);
    ctx.scene.add(group);

    const layer = {
      group,
      mesh,
      geom,
      mat,
      uniforms,
      canvas,
      mapTex,
      maskN: MASK_N,
      maskData,
      maskTex,
      rawOcc: new Uint8Array(MASK_N * MASK_N),
      tmpOcc: new Uint8Array(MASK_N * MASK_N),
      closedOcc: new Uint8Array(MASK_N * MASK_N),
      blurA: new Float32Array(MASK_N * MASK_N),
      blurB: new Float32Array(MASK_N * MASK_N),
      halfSpan,
      originTwd: null,
      tileSig: "",
      covTimer: null,
      tileDrawTimer: null,
      scanId: "",
    };
    ctx.googleMapLayer = layer;
    return layer;
  }

  function stitchScanGoogleMapTilesToCanvas(ctx) {
    const layer = ctx?.googleMapLayer;
    if (!layer || !layer.originTwd || !layer.originTwd.valid) return;
    const { e: e0, n: n0, lon0, fe, k0, fInv } = layer.originTwd;
    const halfSpan = layer.halfSpan;
    const minE = e0 - halfSpan;
    const maxE = e0 + halfSpan;
    const minN = n0 - halfSpan;
    const maxN = n0 + halfSpan;
    const lyrs = STATE.scanGoogleMapLyrs === "m" ? "m" : "y";

    const sw = twd97ToWgs84JS(minE, minN, lon0, fe, k0, fInv);
    const ne = twd97ToWgs84JS(maxE, maxN, lon0, fe, k0, fInv);
    const nwMerc = latLonToNormMercator(ne.lat, sw.lon);
    const seMerc = latLonToNormMercator(sw.lat, ne.lon);

    let zoom = 18;
    for (let z = 19; z >= 15; z--) {
      const zPow = Math.pow(2, z);
      const tx0 = Math.floor(nwMerc.u * zPow);
      const tx1 = Math.floor(seMerc.u * zPow);
      const ty0 = Math.floor(nwMerc.v * zPow);
      const ty1 = Math.floor(seMerc.v * zPow);
      if (Math.abs(tx1 - tx0) + 1 <= 9 && Math.abs(ty1 - ty0) + 1 <= 9) {
        zoom = z;
        break;
      }
    }

    const zPow = Math.pow(2, zoom);
    const minTx = Math.floor(Math.min(nwMerc.u, seMerc.u) * zPow) - 1;
    const maxTx = Math.floor(Math.max(nwMerc.u, seMerc.u) * zPow) + 1;
    const minTy = Math.floor(Math.min(nwMerc.v, seMerc.v) * zPow) - 1;
    const maxTy = Math.floor(Math.max(nwMerc.v, seMerc.v) * zPow) + 1;

    const canvas = layer.canvas;
    const cW = canvas.width;
    const cH = canvas.height;
    const spanE = Math.max(1.0, maxE - minE);
    const spanN = Math.max(1.0, maxN - minN);
    const ctx2d = canvas.getContext("2d");
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    ctx2d.fillStyle = lyrs === "m" ? "#e2e8f0" : "#0f172a";
    ctx2d.fillRect(0, 0, cW, cH);

    const scheduleRedraw = () => {
      if (layer.tileDrawTimer) return;
      layer.tileDrawTimer = setTimeout(() => {
        layer.tileDrawTimer = null;
        stitchScanGoogleMapTilesToCanvas(ctx);
      }, 65);
    };

    const projectMercToTwdCanvas = (mx, my) => {
      const ll = normMercatorToLatLon(mx, my);
      const en =
        typeof wgs84ToTransverseMercatorJS === "function"
          ? wgs84ToTransverseMercatorJS(ll.lat, ll.lon, lon0, fe, k0, fInv)
          : { e: e0, n: n0 };
      return {
        px: ((en.e - minE) / spanE) * cW,
        py: ((maxN - en.n) / spanN) * cH,
      };
    };

    let drawnCount = 0;
    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        const tileObj = getGoogleTileImage(lyrs, zoom, tx, ty, scheduleRedraw);
        if (tileObj && tileObj.loaded && !tileObj.failed) {
          const pNW = projectMercToTwdCanvas(tx / zPow, ty / zPow);
          const pNE = projectMercToTwdCanvas((tx + 1) / zPow, ty / zPow);
          const pSW = projectMercToTwdCanvas(tx / zPow, (ty + 1) / zPow);
          const a = (pNE.px - pNW.px) / 256.0;
          const b = (pNE.py - pNW.py) / 256.0;
          const c = (pSW.px - pNW.px) / 256.0;
          const d = (pSW.py - pNW.py) / 256.0;
          ctx2d.setTransform(a, b, c, d, pNW.px, pNW.py);
          ctx2d.drawImage(tileObj.img, -0.45, -0.45, 256.9, 256.9);
          drawnCount++;
        }
      }
    }
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    layer.mapTex.needsUpdate = true;
    if (ctx.renderer && ctx.scene && ctx.camera) {
      ctx.renderer.render(ctx.scene, ctx.camera);
    }
  }

  function rebuildScanGoogleMapCoverageMask(ctx, scanObj = null) {
    const layer = ctx?.googleMapLayer;
    if (!layer || !layer.originTwd || !layer.originTwd.valid) return;
    const scan = scanObj || STATE.activeScan || {};
    const N = layer.maskN;
    const halfSpan = layer.halfSpan;
    const span = halfSpan * 2.0;
    const invCell = N / span;
    const rawOcc = layer.rawOcc;
    const tmpOcc = layer.tmpOcc;
    const closedOcc = layer.closedOcc || (layer.closedOcc = new Uint8Array(N * N));
    const blurA = layer.blurA || (layer.blurA = new Float32Array(N * N));
    const blurB = layer.blurB || (layer.blurB = new Float32Array(N * N));
    rawOcc.fill(0);

    const isStudio = typeof studioThree !== "undefined" && ctx === studioThree;
    const isMulti = Boolean(isStudio && STATE.multiAlign?.active && ctx.multiAlignGroup && ctx.multiAlignGroup.visible);
    const hasStagedEdits = Boolean(
      isStudio && typeof hasStagedMeshEditsForActiveScan === "function" && hasStagedMeshEditsForActiveScan()
    );

    const meshes = [];
    if (isMulti) {
      ctx.multiAlignGroup.updateMatrixWorld(true);
      ctx.multiAlignGroup.traverse((c) => {
        if (c.isMesh && c.visible && !c.userData?.isAlignBoxHelper && c.geometry?.attributes?.position) {
          let vis = true;
          let p = c.parent;
          while (p && p !== ctx.multiAlignGroup) {
            if (!p.visible) {
              vis = false;
              break;
            }
            p = p.parent;
          }
          if (vis) meshes.push(c);
        }
      });
    } else if (ctx.modelPivot && ctx.modelPivot.visible) {
      ctx.modelPivot.updateMatrixWorld(true);
      const seenGeoms = new Set();
      ctx.modelPivot.traverse((c) => {
        if (c.isMesh && c.visible && c.geometry?.attributes?.position) {
          let vis = true;
          let p = c.parent;
          while (p && p !== ctx.modelPivot) {
            if (!p.visible) {
              vis = false;
              break;
            }
            p = p.parent;
          }
          if (vis) {
            if (c.userData && c.userData._detachedWorldElements) delete c.userData._detachedWorldElements;
            seenGeoms.add(c.geometry);
            meshes.push(c);
          }
        }
      });
      const rootScene = ctx.tilesRenderer?.root?.engineData?.scene;
      const grpMat = ctx.tilesRenderer?.group?.matrixWorld || ctx.modelPivot.matrixWorld;
      if (rootScene && rootScene.parent === null && grpMat) {
        rootScene.updateMatrixWorld(true);
        rootScene.traverse((c) => {
          if (c.isMesh && c.visible && c.geometry?.attributes?.position && !seenGeoms.has(c.geometry)) {
            seenGeoms.add(c.geometry);
            const wm = new THREE.Matrix4().multiplyMatrices(grpMat, c.matrixWorld);
            c.userData = c.userData || {};
            c.userData._detachedWorldElements = wm.elements.slice();
            meshes.push(c);
          }
        });
      }
    }

    let totalTris = 0;
    for (let i = 0; i < meshes.length; i++) {
      const g = meshes[i].geometry;
      totalTris += g.index ? Math.floor(g.index.count / 3) : Math.floor(g.attributes.position.count / 3);
    }

    const triStride = totalTris > 240000 ? Math.ceil(totalTris / 240000) : 1;
    let rasterizedTris = 0;
    const G_N = 64;
    const groundCellMinY = layer.groundCellMinY || (layer.groundCellMinY = new Float32Array(G_N * G_N));
    groundCellMinY.fill(Infinity);
    const maxSampleRadius = Math.min(
      halfSpan,
      Math.max(45, Math.min(360, (Number(ctx.boundingSphere?.radius) || 90) * 1.4))
    );

    for (let mi = 0; mi < meshes.length; mi++) {
      const m = meshes[mi];
      const e = (m.parent === null || !m.matrixWorld) && m.userData?._detachedWorldElements
        ? m.userData._detachedWorldElements
        : (m.userData?._detachedWorldElements || m.matrixWorld.elements);
      const pos = m.geometry.attributes.position;
      const idxAttr = m.geometry.index;
      const nTris = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(pos.count / 3);

      for (let t = 0; t < nTris; t += triStride) {
        const i0 = idxAttr ? idxAttr.getX(t * 3) : t * 3;
        const i1 = idxAttr ? idxAttr.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = idxAttr ? idxAttr.getX(t * 3 + 2) : t * 3 + 2;

        const lx0 = pos.getX(i0), ly0 = pos.getY(i0), lz0 = pos.getZ(i0);
        const lx1 = pos.getX(i1), ly1 = pos.getY(i1), lz1 = pos.getZ(i1);
        const lx2 = pos.getX(i2), ly2 = pos.getY(i2), lz2 = pos.getZ(i2);

        const wx0 = e[0] * lx0 + e[4] * ly0 + e[8] * lz0 + e[12];
        const wy0 = e[1] * lx0 + e[5] * ly0 + e[9] * lz0 + e[13];
        const wz0 = e[2] * lx0 + e[6] * ly0 + e[10] * lz0 + e[14];

        const wx1 = e[0] * lx1 + e[4] * ly1 + e[8] * lz1 + e[12];
        const wz1 = e[2] * lx1 + e[6] * ly1 + e[10] * lz1 + e[14];

        const wx2 = e[0] * lx2 + e[4] * ly2 + e[8] * lz2 + e[12];
        const wz2 = e[2] * lx2 + e[6] * ly2 + e[10] * lz2 + e[14];

        rasterizedTris++;

        const gx0 = (wx0 + halfSpan) * invCell;
        const gz0 = (wz0 + halfSpan) * invCell;
        const gx1 = (wx1 + halfSpan) * invCell;
        const gz1 = (wz1 + halfSpan) * invCell;
        const gx2 = (wx2 + halfSpan) * invCell;
        const gz2 = (wz2 + halfSpan) * invCell;

        const xMin = Math.max(0, Math.floor(Math.min(gx0, gx1, gx2)));
        const xMax = Math.min(N - 1, Math.floor(Math.max(gx0, gx1, gx2)));
        const zMin = Math.max(0, Math.floor(Math.min(gz0, gz1, gz2)));
        const zMax = Math.min(N - 1, Math.floor(Math.max(gz0, gz1, gz2)));
        if (xMin > xMax || zMin > zMax) continue;

        if (
          Number.isFinite(wy0) &&
          Math.abs(wx0) <= maxSampleRadius &&
          Math.abs(wz0) <= maxSampleRadius &&
          wy0 >= -65.0 &&
          wy0 <= 120.0
        ) {
          const bx = Math.max(0, Math.min(G_N - 1, Math.floor(((wx0 + halfSpan) / span) * G_N)));
          const bz = Math.max(0, Math.min(G_N - 1, Math.floor(((wz0 + halfSpan) / span) * G_N)));
          const bIdx = bz * G_N + bx;
          if (wy0 < groundCellMinY[bIdx]) {
            groundCellMinY[bIdx] = wy0;
          }
        }

        if (xMax - xMin <= 1 && zMax - zMin <= 1) {
          for (let gz = zMin; gz <= zMax; gz++) {
            const row = gz * N;
            for (let gx = xMin; gx <= xMax; gx++) {
              rawOcc[row + gx] = 1;
            }
          }
          continue;
        }

        if ((xMax - xMin + 1) * (zMax - zMin + 1) > 6400) continue;

        const area2 = (gx1 - gx0) * (gz2 - gz0) - (gz1 - gz0) * (gx2 - gx0);
        if (Math.abs(area2) < 1e-5) {
          rawOcc[zMin * N + xMin] = 1;
          rawOcc[zMax * N + xMax] = 1;
          continue;
        }
        const sgn = area2 > 0 ? 1 : -1;
        const e01Len = Math.hypot(gx1 - gx0, gz1 - gz0);
        const e12Len = Math.hypot(gx2 - gx1, gz2 - gz1);
        const e20Len = Math.hypot(gx0 - gx2, gz0 - gz2);
        const tol01 = -0.65 * e01Len;
        const tol12 = -0.65 * e12Len;
        const tol20 = -0.65 * e20Len;

        for (let gz = zMin; gz <= zMax; gz++) {
          const py = gz + 0.5;
          const row = gz * N;
          for (let gx = xMin; gx <= xMax; gx++) {
            if (rawOcc[row + gx]) continue;
            const px = gx + 0.5;
            const w0 = ((gx1 - gx0) * (py - gz0) - (gz1 - gz0) * (px - gx0)) * sgn;
            if (w0 < tol01) continue;
            const w1 = ((gx2 - gx1) * (py - gz1) - (gz2 - gz1) * (px - gx1)) * sgn;
            if (w1 < tol12) continue;
            const w2 = ((gx0 - gx2) * (py - gz2) - (gz0 - gz2) * (px - gx2)) * sgn;
            if (w2 < tol20) continue;
            rawOcc[row + gx] = 1;
          }
        }
      }
    }

    // ONLY fall back to True-Nadir RGBA Ortho footprint when 3D mesh triangles have not streamed in yet (rasterizedTris === 0)
    if (rasterizedTris === 0 && !isMulti && !hasStagedEdits && scan && scan.scan_id && typeof getOrLoadMapOrthoImage === "function") {
      const orthoEntry = getOrLoadMapOrthoImage(scan);
      if (orthoEntry && !orthoEntry._gmapHooked) {
        orthoEntry._gmapHooked = true;
        orthoEntry.img.addEventListener("load", () => {
          scheduleScanGoogleMapCoverageUpdate(ctx, scan, 40);
        });
      }
      const b = scan.ortho_bounds || orthoEntry?.bounds;
      if (
        orthoEntry &&
        orthoEntry.loaded &&
        !orthoEntry.failed &&
        b &&
        Number.isFinite(Number(b.north_lat)) &&
        Number.isFinite(Number(b.south_lat)) &&
        Number.isFinite(Number(b.west_lon)) &&
        Number.isFinite(Number(b.east_lon)) &&
        typeof wgs84ToTransverseMercatorJS === "function"
      ) {
        if (!orthoEntry._alphaGrid) {
          try {
            const aN = 256;
            const aCanvas = document.createElement("canvas");
            aCanvas.width = aN;
            aCanvas.height = aN;
            const aCtx = aCanvas.getContext("2d");
            aCtx.drawImage(orthoEntry.img, 0, 0, aN, aN);
            const imgData = aCtx.getImageData(0, 0, aN, aN).data;
            const alphaArr = new Uint8Array(aN * aN);
            let nonZero = 0;
            for (let i = 0; i < aN * aN; i++) {
              const aVal = imgData[i * 4 + 3];
              if (aVal > 20) {
                alphaArr[i] = 1;
                nonZero++;
              }
            }
            if (nonZero > 0 && nonZero < aN * aN * 0.98) {
              orthoEntry._alphaGrid = alphaArr;
              orthoEntry._alphaN = aN;
            }
          } catch (_) {}
        }
        if (orthoEntry._alphaGrid) {
          const { e: e0, n: n0, lon0, fe, k0, fInv } = layer.originTwd;
          const nwEN = wgs84ToTransverseMercatorJS(Number(b.north_lat), Number(b.west_lon), lon0, fe, k0, fInv);
          const seEN = wgs84ToTransverseMercatorJS(Number(b.south_lat), Number(b.east_lon), lon0, fe, k0, fInv);
          const minX = Math.min(nwEN.e - e0, seEN.e - e0);
          const maxX = Math.max(nwEN.e - e0, seEN.e - e0);
          const minZ = Math.min(n0 - nwEN.n, n0 - seEN.n);
          const maxZ = Math.max(n0 - nwEN.n, n0 - seEN.n);
          const spanOX = Math.max(0.5, maxX - minX);
          const spanOZ = Math.max(0.5, maxZ - minZ);
          const gx0 = Math.max(0, Math.floor((minX + halfSpan) * invCell));
          const gx1 = Math.min(N - 1, Math.ceil((maxX + halfSpan) * invCell));
          const gz0 = Math.max(0, Math.floor((minZ + halfSpan) * invCell));
          const gz1 = Math.min(N - 1, Math.ceil((maxZ + halfSpan) * invCell));
          const aN = orthoEntry._alphaN;
          const aGrid = orthoEntry._alphaGrid;
          for (let gz = gz0; gz <= gz1; gz++) {
            const wz = (gz + 0.5) / invCell - halfSpan;
            const v = Math.floor(((wz - minZ) / spanOZ) * aN);
            if (v < 0 || v >= aN) continue;
            const row = gz * N;
            const aRow = v * aN;
            for (let gx = gx0; gx <= gx1; gx++) {
              const wx = (gx + 0.5) / invCell - halfSpan;
              const u = Math.floor(((wx - minX) / spanOX) * aN);
              if (u >= 0 && u < aN && aGrid[aRow + u]) {
                rawOcc[row + gx] = 1;
              }
            }
          }
        }
      }
    }

    const cellYs = [];
    for (let i = 0; i < G_N * G_N; i++) {
      if (Number.isFinite(groundCellMinY[i])) {
        cellYs.push(groundCellMinY[i]);
      }
    }
    const refZ = isMulti
      ? Number(STATE.multiAlign?.refCenter?.z) || 0
      : Array.isArray(ctx.tilesCenter)
      ? Number(ctx.tilesCenter[2]) || 0
      : 0;
    const hasValidRefZ =
      Math.abs(refZ) > 1e-4 ||
      (Array.isArray(ctx.tilesCenter) && Math.hypot(ctx.tilesCenter[0] || 0, ctx.tilesCenter[1] || 0) > 1);

    if (cellYs.length >= 4) {
      cellYs.sort((a, b) => a - b);
      const p20 = cellYs[Math.floor(cellYs.length * 0.2)];
      if (Number.isFinite(p20)) {
        if (!isMulti && !hasStagedEdits && scan && hasValidRefZ) {
          if (!Number.isFinite(scan._resolvedGroundH) || cellYs.length >= (scan._resolvedGroundCells || 0)) {
            scan._resolvedGroundH = refZ + p20;
            scan._resolvedGroundCells = cellYs.length;
          }
          const lockedGroundY = scan._resolvedGroundH - refZ;
          layer.mesh.position.y = lockedGroundY - 0.15;
          if (ctx.grid) ctx.grid.position.y = lockedGroundY - 0.19;
        } else {
          layer.mesh.position.y = p20 - 0.15;
          if (ctx.grid) ctx.grid.position.y = p20 - 0.19;
        }
      }
    } else if (!isMulti && scan && Number.isFinite(scan._resolvedGroundH) && hasValidRefZ) {
      const lockedGroundY = scan._resolvedGroundH - refZ;
      layer.mesh.position.y = lockedGroundY - 0.15;
      if (ctx.grid) ctx.grid.position.y = lockedGroundY - 0.19;
    } else if (ctx.grid) {
      layer.mesh.position.y = ctx.grid.position.y + 0.04;
    }

    // Morphological closing: dilate rawOcc by R = 2 into tmpOcc, then erode tmpOcc by R = 2 into closedOcc
    // (seals internal 1-4m mesh holes/seams inside the scan without expanding the outer boundary)
    const R_CLOSE = 2;
    tmpOcc.fill(0);
    for (let gz = 0; gz < N; gz++) {
      const row = gz * N;
      for (let gx = 0; gx < N; gx++) {
        if (!rawOcc[row + gx]) continue;
        const z0 = Math.max(0, gz - R_CLOSE);
        const z1 = Math.min(N - 1, gz + R_CLOSE);
        const x0 = Math.max(0, gx - R_CLOSE);
        const x1 = Math.min(N - 1, gx + R_CLOSE);
        for (let zz = z0; zz <= z1; zz++) {
          const r2 = zz * N;
          for (let xx = x0; xx <= x1; xx++) {
            tmpOcc[r2 + xx] = 1;
          }
        }
      }
    }

    closedOcc.fill(0);
    for (let gz = 0; gz < N; gz++) {
      const row = gz * N;
      const z0 = Math.max(0, gz - R_CLOSE);
      const z1 = Math.min(N - 1, gz + R_CLOSE);
      for (let gx = 0; gx < N; gx++) {
        if (!tmpOcc[row + gx]) continue;
        const x0 = Math.max(0, gx - R_CLOSE);
        const x1 = Math.min(N - 1, gx + R_CLOSE);
        let allOne = true;
        for (let zz = z0; zz <= z1 && allOne; zz++) {
          const r2 = zz * N;
          for (let xx = x0; xx <= x1; xx++) {
            if (!tmpOcc[r2 + xx]) {
              allOne = false;
              break;
            }
          }
        }
        if (allOne || rawOcc[row + gx]) {
          closedOcc[row + gx] = 1;
        }
      }
    }

    // Smooth feathering: 2 passes of 3x3 box blur on 0..255 coverage values
    for (let i = 0; i < N * N; i++) {
      blurA[i] = closedOcc[i] ? 255.0 : 0.0;
    }
    const runBoxBlur3x3 = (src, dst) => {
      for (let gz = 0; gz < N; gz++) {
        const z0 = Math.max(0, gz - 1);
        const z1 = Math.min(N - 1, gz + 1);
        const row = gz * N;
        for (let gx = 0; gx < N; gx++) {
          const x0 = Math.max(0, gx - 1);
          const x1 = Math.min(N - 1, gx + 1);
          let sum = 0.0;
          let cnt = 0;
          for (let zz = z0; zz <= z1; zz++) {
            const r2 = zz * N;
            for (let xx = x0; xx <= x1; xx++) {
              sum += src[r2 + xx];
              cnt++;
            }
          }
          dst[row + gx] = sum / cnt;
        }
      }
    };
    runBoxBlur3x3(blurA, blurB);
    runBoxBlur3x3(blurB, blurA);

    const maskData = layer.maskData;
    for (let gz = 0; gz < N; gz++) {
      const srcRow = gz * N;
      const dstRow = (N - 1 - gz) * N;
      for (let gx = 0; gx < N; gx++) {
        const val = Math.max(0, Math.min(255, Math.round(blurA[srcRow + gx])));
        const idx = (dstRow + gx) * 4;
        maskData[idx] = val;
        maskData[idx + 1] = val;
        maskData[idx + 2] = val;
        maskData[idx + 3] = val;
      }
    }
    layer.maskTex.needsUpdate = true;
    if (ctx.renderer && ctx.scene && ctx.camera) {
      ctx.renderer.render(ctx.scene, ctx.camera);
    }
  }

  function scheduleScanGoogleMapCoverageUpdate(ctx, scanObj = null, delayMs = 80) {
    if (!ctx) return;
    const layer = ensureScanGoogleMap3DLayer(ctx);
    if (!layer) return;
    if (layer.covTimer) clearTimeout(layer.covTimer);
    layer.covTimer = setTimeout(() => {
      layer.covTimer = null;
      rebuildScanGoogleMapCoverageMask(ctx, scanObj || STATE.activeScan);
    }, Math.max(16, delayMs));
  }
  window.scheduleScanGoogleMapCoverageUpdate = scheduleScanGoogleMapCoverageUpdate;

  function updateScanGoogleMap3DLayer(ctx, scanObj = null) {
    if (!ctx || !ctx.scene) return;
    const scan = scanObj || STATE.activeScan || {};
    const layer = ensureScanGoogleMap3DLayer(ctx);
    if (!layer) return;

    const originTwd = resolveViewerOriginTwd97(ctx, scan);
    layer.originTwd = originTwd;
    layer.scanId = scan.scan_id || "";

    const isLibModel = typeof isLibraryScan === "function" && isLibraryScan(scan);
    if (!STATE.scanGoogleMapEnabled || !originTwd.valid || isLibModel) {
      layer.group.visible = false;
      if (ctx.renderer && ctx.scene && ctx.camera) {
        ctx.renderer.render(ctx.scene, ctx.camera);
      }
      return;
    }

    layer.group.visible = true;
    const rawR = Math.max(25, Number(ctx.boundingSphere?.radius) || 60);
    const nextHalfSpan = Math.max(240, Math.min(840, Math.ceil((rawR * 3.0) / 20) * 20));
    if (Math.abs(nextHalfSpan - layer.halfSpan) > 10) {
      layer.halfSpan = nextHalfSpan;
      layer.uniforms.uHalfSpan.value = nextHalfSpan;
      const newGeom = new THREE.PlaneGeometry(nextHalfSpan * 2, nextHalfSpan * 2, 1, 1);
      newGeom.rotateX(-Math.PI / 2);
      layer.mesh.geometry.dispose();
      layer.mesh.geometry = newGeom;
      layer.geom = newGeom;
      layer.tileSig = "";
    }

    layer.uniforms.uOpacity.value = Math.max(0.05, Math.min(1.0, Number(STATE.scanGoogleMapOpacity) || 0.5));
    const isMulti = Boolean(typeof studioThree !== "undefined" && ctx === studioThree && STATE.multiAlign?.active);
    const refZ = isMulti
      ? Number(STATE.multiAlign?.refCenter?.z) || 0
      : Array.isArray(ctx.tilesCenter)
      ? Number(ctx.tilesCenter[2]) || 0
      : 0;
    const hasValidRefZ =
      Math.abs(refZ) > 1e-4 ||
      (Array.isArray(ctx.tilesCenter) && Math.hypot(ctx.tilesCenter[0] || 0, ctx.tilesCenter[1] || 0) > 1);
    if (!isMulti && scan && Number.isFinite(scan._resolvedGroundH) && hasValidRefZ) {
      const lockedGroundY = scan._resolvedGroundH - refZ;
      if (ctx.grid) ctx.grid.position.y = lockedGroundY - 0.19;
      layer.mesh.position.y = lockedGroundY - 0.15;
    } else if (ctx.grid) {
      layer.mesh.position.y = ctx.grid.position.y + 0.04;
    }

    const lyrs = STATE.scanGoogleMapLyrs === "m" ? "m" : "y";
    const nextSig = `${originTwd.e.toFixed(1)}_${originTwd.n.toFixed(1)}_${layer.halfSpan}_${lyrs}`;
    if (layer.tileSig !== nextSig) {
      layer.tileSig = nextSig;
      stitchScanGoogleMapTilesToCanvas(ctx);
    }

    rebuildScanGoogleMapCoverageMask(ctx, scan);
  }
  window.updateScanGoogleMap3DLayer = updateScanGoogleMap3DLayer;

  function syncScanGoogleMapControlsUI() {
    const enabled = Boolean(STATE.scanGoogleMapEnabled);
    const lyrs = STATE.scanGoogleMapLyrs === "m" ? "m" : "y";
    const op = Math.max(0.05, Math.min(1.0, Number(STATE.scanGoogleMapOpacity) || 0.5));
    const pctTxt = `${Math.round(op * 100)}%`;

    ["btnStudioToggleGoogleMap", "btnPreviewToggleGoogleMap"].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) {
        btn.classList.toggle("active", enabled);
        btn.classList.toggle("primary", enabled);
        btn.setAttribute("aria-pressed", enabled ? "true" : "false");
      }
    });

    ["studioGoogleMapTypeSwitcher", "previewGoogleMapTypeSwitcher"].forEach((id) => {
      const sw = document.getElementById(id);
      if (sw) {
        sw.querySelectorAll("[data-gmap-lyrs]").forEach((b) => {
          b.classList.toggle("active", b.getAttribute("data-gmap-lyrs") === lyrs);
        });
      }
    });

    ["studioGoogleMapOpacitySlider", "previewGoogleMapOpacitySlider"].forEach((id) => {
      const sl = document.getElementById(id);
      if (sl && Math.abs(parseFloat(sl.value) - op) > 0.005) {
        sl.value = String(op);
      }
    });

    ["lblStudioGoogleMapOpacity", "lblPreviewGoogleMapOpacity"].forEach((id) => {
      const lbl = document.getElementById(id);
      if (lbl) lbl.textContent = pctTxt;
    });
  }
  window.syncScanGoogleMapControlsUI = syncScanGoogleMapControlsUI;

  function setScanGoogleMapEnabled(enabled) {
    STATE.scanGoogleMapEnabled = Boolean(enabled);
    syncScanGoogleMapControlsUI();
    if (typeof studioThree !== "undefined" && studioThree) {
      updateScanGoogleMap3DLayer(studioThree, STATE.activeScan);
    }
    if (typeof previewThree !== "undefined" && previewThree) {
      const pScan = STATE.scans.find((s) => s.scan_id === STATE.selectedTimelineScanId) || STATE.activeScan;
      updateScanGoogleMap3DLayer(previewThree, pScan);
    }
  }
  window.setScanGoogleMapEnabled = setScanGoogleMapEnabled;

  function setScanGoogleMapLyrs(lyrs) {
    STATE.scanGoogleMapLyrs = lyrs === "m" ? "m" : "y";
    if (!STATE.scanGoogleMapEnabled) {
      STATE.scanGoogleMapEnabled = true;
    }
    syncScanGoogleMapControlsUI();
    if (typeof studioThree !== "undefined" && studioThree) {
      updateScanGoogleMap3DLayer(studioThree, STATE.activeScan);
    }
    if (typeof previewThree !== "undefined" && previewThree) {
      const pScan = STATE.scans.find((s) => s.scan_id === STATE.selectedTimelineScanId) || STATE.activeScan;
      updateScanGoogleMap3DLayer(previewThree, pScan);
    }
  }
  window.setScanGoogleMapLyrs = setScanGoogleMapLyrs;

  function setScanGoogleMapOpacity(val) {
    const op = Math.max(0.05, Math.min(1.0, parseFloat(val) || 0.5));
    STATE.scanGoogleMapOpacity = op;
    syncScanGoogleMapControlsUI();
    [typeof studioThree !== "undefined" ? studioThree : null, previewThree].forEach((ctx) => {
      if (ctx && ctx.googleMapLayer) {
        ctx.googleMapLayer.uniforms.uOpacity.value = op;
        if (ctx.renderer && ctx.scene && ctx.camera) {
          ctx.renderer.render(ctx.scene, ctx.camera);
        }
      }
    });
  }
  window.setScanGoogleMapOpacity = setScanGoogleMapOpacity;

  function bindScanGoogleMapControlsEvents() {
    ["btnStudioToggleGoogleMap", "btnPreviewToggleGoogleMap"].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn && !btn._gsGmapBound) {
        btn._gsGmapBound = true;
        btn.addEventListener("click", () => {
          setScanGoogleMapEnabled(!STATE.scanGoogleMapEnabled);
        });
      }
    });

    ["studioGoogleMapTypeSwitcher", "previewGoogleMapTypeSwitcher"].forEach((id) => {
      const sw = document.getElementById(id);
      if (sw && !sw._gsGmapBound) {
        sw._gsGmapBound = true;
        sw.querySelectorAll("[data-gmap-lyrs]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const lyrs = btn.getAttribute("data-gmap-lyrs") || "y";
            setScanGoogleMapLyrs(lyrs);
          });
        });
      }
    });

    ["studioGoogleMapOpacitySlider", "previewGoogleMapOpacitySlider"].forEach((id) => {
      const sl = document.getElementById(id);
      if (sl && !sl._gsGmapBound) {
        sl._gsGmapBound = true;
        sl.addEventListener("input", (e) => {
          setScanGoogleMapOpacity(e.target.value);
        });
      }
    });

    syncScanGoogleMapControlsUI();
  }
  bindScanGoogleMapControlsEvents();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindScanGoogleMapControlsEvents);
  }



