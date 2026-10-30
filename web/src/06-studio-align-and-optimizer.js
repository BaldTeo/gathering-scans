/**
 * GatheringScans Frontend Module 06 — GC_ScanOptimizer Panels, Multi-Scan 3D Alignment & Merge Engine, Studio Dock & Hotkeys
 */
"use strict";

  // 3G. Staged Scan Editing Suite:
  //   1. Lasso Delete (`openLassoDeleteInspector`) — mark multiple polygons/lassos -> press Delete -> instant 3D preview (NO Mesh Optimizer inside!)
  //   2. Lasso Keep (`openLassoKeepInspector`) — mark keep boundary -> stage crop & instant 3D preview
  //   3. Mesh Compression (`openMeshCompressionInspector`) — stage compression preset
  //   4. Coordinate System (`openCoordinateSystemInspector`) — stage CRS & custom datum offset
  //   5. Generate Scan (`openGenerateScanInspector`) — build a brand-new scan once with all staged adjustments!

  const CRS_UI_CATALOG = [
    {
      code: "TWD97_121_TWVD2001",
      shortLabel: "TWD97 121 + TWVD2001",
      fullLabel: "TWD97 / TM2 Zone 121 + TWVD2001 · EPSG:3826+8904",
      kind: "tm",
      lon0: 121.0,
      fe: 250000.0,
      k0: 0.9999,
      fInv: 298.257222101,
      hOff: 0.0,
    },
    {
      code: "TWD97_119_TWVD2001",
      shortLabel: "TWD97 119 + TWVD2001",
      fullLabel: "TWD97 / TM2 Zone 119 + TWVD2001 · EPSG:3825+8904",
      kind: "tm",
      lon0: 119.0,
      fe: 250000.0,
      k0: 0.9999,
      fInv: 298.257222101,
      hOff: 0.0,
    },
    {
      code: "WGS84_UTM51N",
      shortLabel: "WGS84 / UTM 51N",
      fullLabel: "WGS84 / UTM Zone 51N · EPSG:32651",
      kind: "tm",
      lon0: 123.0,
      fe: 500000.0,
      k0: 0.9996,
      fInv: 298.257223563,
      hOff: 20.6,
    },
    {
      code: "WGS84_UTM50N",
      shortLabel: "WGS84 / UTM 50N",
      fullLabel: "WGS84 / UTM Zone 50N · EPSG:32650",
      kind: "tm",
      lon0: 117.0,
      fe: 500000.0,
      k0: 0.9996,
      fInv: 298.257223563,
      hOff: 19.8,
    },
    {
      code: "LOCAL_ORIGIN",
      shortLabel: "Local Origin 0,0,0",
      fullLabel: "Local Site Origin 0, 0, 0 m · BIM / Revit / Rhino",
      kind: "local",
      hOff: 0.0,
    },
  ];

  function getCrsItemShortLabel(c) {
    if (!c) return "";
    if (c.code === "LOCAL_ORIGIN") return tr("局部原點 0,0,0", "Local Origin 0,0,0");
    return c.shortLabel || c.code || "";
  }

  function getCrsItemFullLabel(c) {
    if (!c) return "";
    if (c.code === "TWD97_121_TWVD2001") return tr("TWD97 / TM2 121 分帶 + TWVD2001 · EPSG:3826+8904", "TWD97 / TM2 Zone 121 + TWVD2001 · EPSG:3826+8904");
    if (c.code === "TWD97_119_TWVD2001") return tr("TWD97 / TM2 119 離島分帶 + TWVD2001 · EPSG:3825+8904", "TWD97 / TM2 Zone 119 + TWVD2001 · EPSG:3825+8904");
    if (c.code === "WGS84_UTM51N") return tr("WGS84 / UTM 51N 國際分帶 · EPSG:32651", "WGS84 / UTM Zone 51N · EPSG:32651");
    if (c.code === "WGS84_UTM50N") return tr("WGS84 / UTM 50N 分帶 · EPSG:32650", "WGS84 / UTM Zone 50N · EPSG:32650");
    if (c.code === "LOCAL_ORIGIN") return tr("局部工區原點 0, 0, 0 公尺 · BIM / Revit / Rhino", "Local Site Origin 0, 0, 0 m · BIM / Revit / Rhino");
    return c.fullLabel || c.shortLabel || c.code;
  }

  function getCompressionPresetLabel(k) {
    if (k === "quality") return tr("高保真畫質 · 75% 面數 · 2K JPEG", "High Fidelity · 75% Tris · 2K JPEG");
    if (k === "balanced") return tr("平衡串流 · 50% 面數 · 1.5K JPEG", "Balanced Stream · 50% Tris · 1.5K JPEG");
    if (k === "web") return tr("高速行動平板 · 35% 面數 · 1K JPEG", "Fast Mobile / Field · 35% Tris · 1K JPEG");
    if (k === "ultra_light") return tr("極輕量離線快取 · 20% 面數 · 768px", "Ultra-Light Offline · 20% Tris · 768px");
    return k || "";
  }

  const COMPRESSION_PRESET_LABELS = {
    quality: "High Fidelity · 75% Tris · 2K JPEG",
    balanced: "Balanced Stream · 50% Tris · 1.5K JPEG",
    web: "Fast Mobile / Field · 35% Tris · 1K JPEG",
    ultra_light: "Ultra-Light Offline · 20% Tris · 768px",
  };

  function inferActiveScanCrsCode(scanObj) {
    const s = scanObj || STATE.activeScan || {};
    const raw = String(s.crs || "").toUpperCase();
    const ce = s.twd97_e !== undefined && s.twd97_e !== null ? Number(s.twd97_e) : 0;
    const cn = s.twd97_n !== undefined && s.twd97_n !== null ? Number(s.twd97_n) : 0;
    if (raw.includes("LOCAL") || (Math.abs(ce) < 50000 && Math.abs(cn) < 50000)) return "LOCAL_ORIGIN";
    if (raw.includes("UTM") && raw.includes("50")) return "WGS84_UTM50N";
    if (raw.includes("UTM") || raw.includes("32651")) return "WGS84_UTM51N";
    if (raw.includes("119") || raw.includes("3825")) return "TWD97_119_TWVD2001";
    return "TWD97_121_TWVD2001";
  }

  function wgs84ToTransverseMercatorJS(latDeg, lonDeg, lon0Deg, fe, k0, fInv) {
    const a = 6378137.0;
    const f = 1.0 / fInv;
    const e2 = 2 * f - f * f;
    const ep2 = e2 / (1 - e2);
    const lat = (latDeg * Math.PI) / 180.0;
    const lon = (lonDeg * Math.PI) / 180.0;
    const lon0 = (lon0Deg * Math.PI) / 180.0;
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const tanLat = Math.tan(lat);
    const n = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    const t = tanLat * tanLat;
    const c = ep2 * cosLat * cosLat;
    const A = cosLat * (lon - lon0);
    const M =
      a *
      ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256) * lat -
        ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 * e2 * e2) / 1024) * Math.sin(2 * lat) +
        ((15 * e2 * e2) / 256 + (45 * e2 * e2 * e2) / 1024) * Math.sin(4 * lat) -
        ((35 * e2 * e2 * e2) / 3072) * Math.sin(6 * lat));
    const easting =
      fe +
      k0 *
        n *
        (A + ((1 - t + c) * Math.pow(A, 3)) / 6 + ((5 - 18 * t + t * t + 72 * c - 58 * ep2) * Math.pow(A, 5)) / 120);
    const northing =
      k0 *
      (M +
        n *
          tanLat *
          (Math.pow(A, 2) / 2 +
            ((5 - t + 9 * c + 4 * c * c) * Math.pow(A, 4)) / 24 +
            ((61 - 58 * t + t * t + 600 * c - 330 * ep2) * Math.pow(A, 6)) / 720));
    return { e: easting, n: northing };
  }

  function hasValidGeorefLatLon(scanObj) {
    const s = scanObj || STATE.activeScan || {};
    if (s.lat === null || s.lat === undefined || s.lon === null || s.lon === undefined) return false;
    const lat = Number(s.lat);
    const lon = Number(s.lon);
    return (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      (Math.abs(lat) > 1e-5 || Math.abs(lon) > 1e-5) &&
      Math.abs(lat) <= 90.0 &&
      Math.abs(lon) <= 180.0
    );
  }

  function previewTargetCrsCenterJS(scanObj, targetCode, offX = 0, offY = 0, offZ = 0) {
    const s = scanObj || STATE.activeScan || {};
    const srcCode = inferActiveScanCrsCode(s);
    const srcDef = CRS_UI_CATALOG.find((c) => c.code === srcCode) || CRS_UI_CATALOG[0];
    const tgtDef = CRS_UI_CATALOG.find((c) => c.code === targetCode) || CRS_UI_CATALOG[0];
    const ce = s.twd97_e !== undefined && s.twd97_e !== null ? Number(s.twd97_e) : 0;
    const cn = s.twd97_n !== undefined && s.twd97_n !== null ? Number(s.twd97_n) : 0;
    const ch = s.twd97_h !== undefined && s.twd97_h !== null ? Number(s.twd97_h) : 0;
    const twvdH = ch - (srcDef.hOff || 0);

    if (tgtDef.code === srcCode) {
      return { x: ce + offX, y: cn + offY, z: ch + offZ, crsLabel: getCrsItemShortLabel(tgtDef) };
    }
    if (tgtDef.kind === "local") {
      return { x: 0 + offX, y: 0 + offY, z: 0 + offZ, crsLabel: getCrsItemShortLabel(tgtDef) };
    }
    if (!hasValidGeorefLatLon(s)) {
      return {
        error: tr(
          "此掃描使用局部原點 0,0,0 且無 WGS84/RTK 地理參考座標，無法投影至大地座標系統。",
          "Scan uses Local Origin 0,0,0 with no WGS84/RTK georeference — cannot project to geodetic CRS without georeferencing."
        ),
        crsLabel: getCrsItemShortLabel(tgtDef),
      };
    }
    const lat = Number(s.lat);
    const lon = Number(s.lon);
    const en = wgs84ToTransverseMercatorJS(lat, lon, tgtDef.lon0, tgtDef.fe, tgtDef.k0, tgtDef.fInv);
    return {
      x: en.e + offX,
      y: en.n + offY,
      z: twvdH + (tgtDef.hOff || 0) + offZ,
      crsLabel: getCrsItemShortLabel(tgtDef),
    };
  }

  function countMarkedRegionsPending() {
    const addStrokes = Array.isArray(STATE.lassoStrokes)
      ? STATE.lassoStrokes.filter((s) => s.op !== "sub").length
      : 0;
    const lockedPolys = Array.isArray(STATE.pendingCropPolygons) ? STATE.pendingCropPolygons.length : 0;
    const unclosedPoly = Array.isArray(STATE.measurePoints) && STATE.measurePoints.length >= 3 ? 1 : 0;
    return addStrokes + lockedPolys + unclosedPoly;
  }

  function serializeMultiAlignLayersForMerge(forceLockAll = false) {
    return (STATE.multiAlign?.layers || []).map((l) => {
      applyLayerTransformTo3D(l);
      const pos = l.layerGroup
        ? l.layerGroup.position
        : { x: Number(l.tx) || 0, y: Number(l.ty) || 0, z: Number(l.tz) || 0 };
      const quat = l.layerGroup ? l.layerGroup.quaternion : { x: 0, y: 0, z: 0, w: 1 };
      return {
        scan_id: l.scan_id,
        locked: forceLockAll ? true : Boolean(l.locked),
        tx: Number(l.tx) || 0,
        ty: Number(l.ty) || 0,
        tz: Number(l.tz) || 0,
        rx_deg: Number(l.rx_deg) || 0,
        ry_deg: Number(l.ry_deg) || 0,
        rz_deg: Number(l.rz_deg) || 0,
        raw_center_zup: l.rawCenter ? [Number(l.rawCenter.x), Number(l.rawCenter.y), Number(l.rawCenter.z)] : null,
        position_three: [Number(pos.x) || 0, Number(pos.y) || 0, Number(pos.z) || 0],
        quaternion_three: [Number(quat.x) || 0, Number(quat.y) || 0, Number(quat.z) || 0, Number(quat.w ?? 1)],
        euler_deg_three: [Number(l.rx_deg) || 0, Number(l.ry_deg) || 0, Number(l.rz_deg) || 0],
      };
    });
  }

  function worldPolygonToCameraFrustumStroke(pts, visibleOnly = true) {
    if (!studioThree?.camera || !studioThree?.renderer?.domElement || !Array.isArray(pts) || pts.length < 3) return null;
    const domEl = studioThree.renderer.domElement;
    const w = Math.max(1, domEl.clientWidth || 1);
    const h = Math.max(1, domEl.clientHeight || 1);
    studioThree.camera.updateMatrixWorld(true);
    const screenPts = pts.map((p) => {
      const v = p.clone().project(studioThree.camera);
      return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h };
    });
    const st = buildStudioLassoFrustumStroke(screenPts, "add");
    if (st) st.visible_only = Boolean(visibleOnly);
    return st;
  }
  window.worldPolygonToCameraFrustumStroke = worldPolygonToCameraFrustumStroke;

  function commitPendingLassoMarksToStagedEdits(modeOverride = null) {
    const mode =
      modeOverride ||
      (!STATE.multiAlign?.active && STATE.cropMode === "keep_inside" ? "keep_inside" : "delete_inside");
    const st = ensureStagedEditsForActiveScan();
    const activeSbSer = getSerializedActiveSectionBox();

    if (mode === "keep_inside" && !STATE.multiAlign?.active) {
      const effVis = getEffectiveLassoVisibleOnly("keep_inside");
      const batchStrokes = (STATE.lassoStrokes || []).map((s) =>
        Object.assign({}, s, { visible_only: effVis }, activeSbSer && !s.section_box ? { section_box: activeSbSer } : {})
      );
      const batchPolys = [];
      const rawKeepPolys = [];
      (STATE.pendingCropPolygons || []).forEach((pts) => {
        if (Array.isArray(pts) && pts.length >= 3) rawKeepPolys.push(pts);
      });
      if (Array.isArray(STATE.measurePoints) && STATE.measurePoints.length >= 3) {
        rawKeepPolys.push(STATE.measurePoints);
      }
      if (rawKeepPolys.length > 0 && (isActiveStudioTilesetEcef() || activeSbSer)) {
        rawKeepPolys.forEach((pts) => {
          const orthoSt = planPolygonToTopDownFrustumStroke(pts);
          if (orthoSt) batchStrokes.push(orthoSt);
        });
      } else {
        rawKeepPolys.forEach((pts) => {
          batchPolys.push(pts.map((p) => studioWorldToTilesetNative(p).slice(0, 2)));
        });
      }
      const regionCount = batchStrokes.filter((s) => s.op !== "sub").length + batchPolys.length;
      if (regionCount === 0) return { committed: 0, triCount: 0, mode };
      const triEst = Number(STATE.lassoSelectedTriCount || 0);
      st.cropKeep = {
        regionCount,
        triCount: triEst,
        frustum_strokes: batchStrokes,
        native_polygons: batchPolys,
      };
      if (activeSbSer) st.cropKeep.section_box = activeSbSer;
      st.rev++;
      STATE.measurePoints = [];
      clearLassoSelectionState();
      applyStagedEditsToStudioMeshes(true);
      syncStagedEditsDockBadge();
      return { committed: regionCount, triCount: triEst, mode };
    }

    const effVis = getEffectiveLassoVisibleOnly("delete_inside");
    const batchStrokes = (STATE.lassoStrokes || []).map((s) =>
      Object.assign({}, s, { visible_only: effVis }, activeSbSer && !s.section_box ? { section_box: activeSbSer } : {})
    );
    const rawWorldPolys = [];
    if (Array.isArray(STATE.pendingCropPolygons)) {
      STATE.pendingCropPolygons.forEach((pts) => {
        if (Array.isArray(pts) && pts.length >= 3) rawWorldPolys.push(pts);
      });
    }
    if (Array.isArray(STATE.measurePoints) && STATE.measurePoints.length >= 3) {
      rawWorldPolys.push(STATE.measurePoints);
    }

    const batchPolys = [];
    let layerCenteredPolygons = null;
    if (effVis && rawWorldPolys.length > 0) {
      rawWorldPolys.forEach((pts) => {
        const camSt = worldPolygonToCameraFrustumStroke(pts, true);
        if (camSt) batchStrokes.push(camSt);
      });
    } else if (STATE.multiAlign?.active && rawWorldPolys.length > 0) {
      if (studioThree?.multiAlignGroup) studioThree.multiAlignGroup.updateMatrixWorld(true);
      layerCenteredPolygons = {};
      (STATE.multiAlign.layers || []).forEach((layer) => {
        if (!layer || !layer.visible || !layer.zUpGroup) return;
        const invZUp = layer.zUpGroup.matrixWorld.clone().invert();
        layerCenteredPolygons[layer.scan_id] = rawWorldPolys.map((pts) =>
          pts.map((p) => {
            const loc = p.clone().applyMatrix4(invZUp);
            return [loc.x, loc.y];
          })
        );
      });
    } else if (rawWorldPolys.length > 0 && (isActiveStudioTilesetEcef() || activeSbSer)) {
      rawWorldPolys.forEach((pts) => {
        const orthoSt = planPolygonToTopDownFrustumStroke(pts);
        if (orthoSt) batchStrokes.push(orthoSt);
      });
    } else {
      rawWorldPolys.forEach((pts) => {
        batchPolys.push(
          pts.map((p) => {
            const n = studioWorldToTilesetNative(p);
            return [n[0], n[1]];
          })
        );
      });
    }

    const regionCount =
      batchStrokes.filter((s) => s.op !== "sub").length +
      batchPolys.length +
      (layerCenteredPolygons ? rawWorldPolys.length : 0);
    if (regionCount === 0) return { committed: 0, triCount: 0, mode: "delete_inside" };

    const markedTriEstimate = Number(STATE.lassoSelectedTriCount || 0);
    const delBatch = {
      id: Date.now(),
      regionCount,
      triCount: markedTriEstimate,
      frustum_strokes: batchStrokes,
      native_polygons: batchPolys,
    };
    if (activeSbSer) delBatch.section_box = activeSbSer;
    if (layerCenteredPolygons) {
      delBatch.layer_centered_polygons = layerCenteredPolygons;
    }
    st.deletions.push(delBatch);
    st.rev++;

    STATE.measurePoints = [];
    clearLassoSelectionState();
    applyStagedEditsToStudioMeshes(true);
    syncStagedEditsDockBadge();
    return { committed: regionCount, triCount: markedTriEstimate, mode: "delete_inside" };
  }

  function renderStagedAdjustmentsCardHtml(opts = {}) {
    const st = ensureStagedEditsForActiveScan();
    const isMulti = Boolean(STATE.multiAlign?.active);
    const pendingMarks = countMarkedRegionsPending();
    const pendingMarkTris = Number(STATE.lassoSelectedTriCount || 0);
    const totalAdj = countStagedAdjustments() + (pendingMarks > 0 && st.deletions.length === 0 && !st.cropKeep ? 1 : 0);
    const alwaysShow = Boolean(opts.alwaysShow);
    if (!alwaysShow && totalAdj === 0) return "";

    const totalDelRegions = st.deletions.reduce((acc, b) => acc + (Number(b.regionCount) || 1), 0);
    const totalDelTris = st.deletions.reduce((acc, b) => acc + (Number(b.triCount) || 0), 0);
    const crsItem = st.crsConfig
      ? CRS_UI_CATALOG.find((c) => c.code === st.crsConfig.target_crs) || CRS_UI_CATALOG[0]
      : null;
    const crsOffText =
      st.crsConfig &&
      (Math.abs(st.crsConfig.offset_x || 0) > 1e-4 ||
        Math.abs(st.crsConfig.offset_y || 0) > 1e-4 ||
        Math.abs(st.crsConfig.offset_z || 0) > 1e-4)
        ? ` + Δ ${Number(st.crsConfig.offset_x).toFixed(2)}, ${Number(st.crsConfig.offset_y).toFixed(2)}, ${Number(
            st.crsConfig.offset_z
          ).toFixed(2)} m`
        : "";

    const itemsHtml = [];
    if (isMulti) {
      const nLayers = Array.isArray(STATE.multiAlign?.layers) ? STATE.multiAlign.layers.length : 0;
      itemsHtml.push(`
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 7px;background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;font-size:11px;">
          <span>🔗 <b>${tr("合併掃描：", "Combine Scans:")}</b> ${tr(`${nLayers} 個掃描圖層`, `${nLayers} scan layer${nLayers === 1 ? "" : "s"}`)} ${
        nLayers < 2
          ? `<span style="color:#f59e0b;">· ${tr("請於對齊面板新增至少 1 組掃描", "add 1+ scan in Align & Merge")}</span>`
          : `· ${tr("已對齊", "aligned")}`
      }</span>
          <button type="button" class="gs-top-btn" data-jump-edit="align_merge" style="padding:1px 6px;font-size:10px;" title="${tr("開啟多掃描 3D 對齊與合併", "Open Multi-Scan Align & Merge")}">${tr("對齊", "Align")}</button>
        </div>
      `);
    }
    if (st.deletions.length > 0) {
      itemsHtml.push(`
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 7px;background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;font-size:11px;">
          <span>🗑️ <b>${tr("刪除區域：", "Delete:")}</b> ${tr(`${totalDelRegions} 個區域 · ${totalDelTris.toLocaleString()} 面`, `${totalDelRegions} region${totalDelRegions === 1 ? "" : "s"} · ${totalDelTris.toLocaleString()} tris`)}</span>
          <button type="button" class="gs-top-btn" data-unstage="deletions" style="padding:1px 6px;font-size:10px;" title="${tr("移除所有暫存刪除區域", "Remove all staged deletions")}">✕</button>
        </div>
      `);
    }
    if (pendingMarks > 0) {
      itemsHtml.push(`
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 7px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.35);border-radius:6px;font-size:11px;">
          <span>🔴 <b>${tr("已選取多邊形：", "Selected Polygons:")}</b> ${tr(`${pendingMarks} 個區域 · ${pendingMarkTris.toLocaleString()} 面已保留`, `${pendingMarks} region${pendingMarks === 1 ? "" : "s"} · ${pendingMarkTris.toLocaleString()} tris preserved`)}</span>
          <button type="button" class="gs-top-btn" data-stage-pending-marks="1" style="padding:1px 7px;font-size:10px;border-color:rgba(239,68,68,0.45);color:#ef4444;" title="${tr("立即將選取的多邊形套用至 3D 刪除預覽", "Apply these selected polygons to the 3D delete preview now")}">${tr("立即刪除", "Delete Now")}</button>
        </div>
      `);
    }
    if (!isMulti && st.cropKeep) {
      itemsHtml.push(`
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 7px;background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;font-size:11px;">
          <span>✂️ <b>${tr("保留裁切：", "Keep Crop:")}</b> ${tr(`${st.cropKeep.regionCount || 1} 個區域 · ${Number(st.cropKeep.triCount || 0).toLocaleString()} 面`, `${st.cropKeep.regionCount || 1} region${(st.cropKeep.regionCount || 1) === 1 ? "" : "s"} · ${Number(st.cropKeep.triCount || 0).toLocaleString()} tris`)}</span>
          <button type="button" class="gs-top-btn" data-unstage="cropKeep" style="padding:1px 6px;font-size:10px;" title="${tr("移除暫存裁切範圍", "Remove staged keep crop")}">✕</button>
        </div>
      `);
    }
    if (st.compressionPreset && st.compressionPreset !== "none") {
      itemsHtml.push(`
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 7px;background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;font-size:11px;">
          <span>⚡ <b>${tr("網格壓縮：", "Compression:")}</b> ${escapeHtml(getCompressionPresetLabel(st.compressionPreset))}</span>
          <button type="button" class="gs-top-btn" data-unstage="compression" style="padding:1px 6px;font-size:10px;" title="${tr("移除暫存壓縮設定", "Remove staged compression")}">✕</button>
        </div>
      `);
    }
    if (st.crsConfig) {
      itemsHtml.push(`
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 7px;background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;font-size:11px;">
          <span>🌐 <b>${tr("座標系：", "CRS:")}</b> ${escapeHtml((crsItem ? getCrsItemShortLabel(crsItem) : st.crsConfig.target_crs) + crsOffText)}</span>
          <button type="button" class="gs-top-btn" data-unstage="crs" style="padding:1px 6px;font-size:10px;" title="${tr("移除暫存座標系變更", "Remove staged CRS change")}">✕</button>
        </div>
      `);
    }

    const defaultNewName = st.newScanName || `${STATE.activeScan?.name || STATE.activeScanId || "Scan"}`;
    const canGenerate = isMulti
      ? Array.isArray(STATE.multiAlign?.layers) && STATE.multiAlign.layers.length >= 2
      : totalAdj > 0;

    return `
      <div style="background:rgba(2,132,199,0.08);border:1px solid rgba(2,132,199,0.35);border-radius:8px;padding:10px;margin-top:10px;">
        <div style="font-size:12px;font-weight:700;color:var(--ui-accent);display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px;flex-wrap:wrap;">
          <span>${tr(`✨ 待套用修改 · ${totalAdj}`, `✨ Pending Adjustments · ${totalAdj}`)}</span>
          <span style="font-size:10px;color:var(--ui-text-secondary);" title="${tr("未修改之原始掃描將安全移至回收桶，可隨時還原", "The untouched original scan is safely moved to the Trash Bin where you can restore it anytime")}">🗑️ ${isMulti ? tr("原掃描群 → 回收桶", "Originals → Trash Bin") : tr("原掃描 → 回收桶", "Original → Trash Bin")}</span>
        </div>
        ${
          itemsHtml.length > 0
            ? `<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:8px;">${itemsHtml.join("")}</div>`
            : `<div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-surface);border:1px dashed var(--ui-border-strong);border-radius:6px;padding:8px;margin-bottom:8px;">
                ${tr(
                  "尚未加入任何修改。請先使用左側工具列的<b>套索刪除</b>、<b>網格優化</b>或<b>座標系統</b>，再點擊<b>儲存變更</b>！",
                  "No adjustments staged yet. Use <b>Lasso Delete</b>, <b>Mesh Compression</b>, or <b>Coordinate System</b> on the left dock first, then press <b>Save Edits</b>!"
                )}
              </div>`
        }
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;">
          ${
            isMulti
              ? `<button type="button" class="gs-top-btn" data-jump-edit="align_merge" style="font-size:10.5px;padding:3px 7px;">${tr("🎯 返回對齊", "🎯 Return to Alignment")}</button>`
              : ""
          }
          <button type="button" class="gs-top-btn" data-jump-edit="crop_delete" style="font-size:10.5px;padding:3px 7px;">${tr("+ 刪除範圍", "+ Delete Regions")}</button>
          <button type="button" class="gs-top-btn" data-jump-edit="optimizer" style="font-size:10.5px;padding:3px 7px;">${tr("+ 壓縮優化", "+ Compression")}</button>
          <button type="button" class="gs-top-btn" data-jump-edit="crs" style="font-size:10.5px;padding:3px 7px;">${tr("+ 座標系統", "+ Coordinate System")}</button>
        </div>
        <div class="gs-form-group" style="margin-bottom:8px;">
          <label style="font-size:11px;">${tr("掃描名稱 · 原掃描將自動備份至回收桶", "Scan Name · original scan backed up to Trash Bin")}</label>
          <input type="text" class="gs-input" id="txtGenerateScanName" value="${escapeHtml(defaultNewName)}" placeholder="${tr("輸入掃描名稱...", "Enter scan name...")}" />
        </div>
        <button type="button" class="gs-top-btn accent" id="btnGenerateStagedScan" style="width:100%;justify-content:center;padding:9px 12px;font-weight:700;${
          !canGenerate ? "opacity:0.5;pointer-events:none;" : ""
        }" ${!canGenerate ? "disabled" : ""} title="${tr("儲存修改後之掃描，並將原始備份移至回收桶 · 可隨時還原", "Save edited scan and move untouched original backup to Trash Bin · easily restorable")}">
          <span>💾 ${
            isMulti
              ? tr(`合併並儲存 · ${totalAdj} 項修改`, `Save Merged Scan · ${totalAdj} step${totalAdj === 1 ? "" : "s"}`)
              : tr(`儲存變更 · ${totalAdj} 項修改`, `Save Edits · ${totalAdj} adjustment${totalAdj === 1 ? "" : "s"}`)
          }</span>
        </button>
        <div id="generateScanResultBox" style="margin-top:8px;"></div>
      </div>
    `;
  }

  function bindStagedAdjustmentsCardEvents(rerenderFn) {
    const st = ensureStagedEditsForActiveScan();
    const nameInput = document.getElementById("txtGenerateScanName");
    if (nameInput) {
      nameInput.addEventListener("input", () => {
        st.newScanName = nameInput.value;
      });
    }

    document.querySelectorAll("[data-stage-pending-marks]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const res = commitPendingLassoMarksToStagedEdits();
        if (res.committed > 0) {
          showToast(`Staged ${res.committed} selected region(s) for deletion`);
        }
        if (typeof rerenderFn === "function") rerenderFn();
      });
    });

    document.querySelectorAll("[data-unstage]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.getAttribute("data-unstage");
        if (kind === "deletions") {
          st.deletions = [];
          st.rev++;
          applyStagedEditsToStudioMeshes(true);
        } else if (kind === "cropKeep") {
          st.cropKeep = null;
          st.rev++;
          applyStagedEditsToStudioMeshes(true);
        } else if (kind === "compression") {
          st.compressionPreset = null;
        } else if (kind === "crs") {
          st.crsConfig = null;
        }
        syncStagedEditsDockBadge();
        if (typeof rerenderFn === "function") rerenderFn();
      });
    });

    document.querySelectorAll("[data-jump-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.getAttribute("data-jump-edit");
        preserveLassoSelectionBeforeToolSwitch();
        if (target === "align_merge") {
          setActiveStudioTool("align_merge");
          openAlignMergeInspector();
        } else if (target === "crop_delete") {
          STATE.cropMode = "delete_inside";
          openLassoDeleteInspector({ armLasso: true });
        } else if (target === "optimizer") {
          setActiveStudioTool("optimizer");
          openMeshCompressionInspector();
        } else if (target === "crs") {
          setActiveStudioTool("crs");
          openCoordinateSystemInspector();
        }
      });
    });

    document.getElementById("btnGenerateStagedScan")?.addEventListener("click", async () => {
      await executeGenerateStagedScan();
    });
  }

  async function executeGenerateStagedScan() {
    const st = ensureStagedEditsForActiveScan();
    const isMulti = Boolean(STATE.multiAlign?.active);

    if (countMarkedRegionsPending() > 0) {
      commitPendingLassoMarksToStagedEdits();
    }

    if (isMulti) {
      if (!Array.isArray(STATE.multiAlign.layers) || STATE.multiAlign.layers.length < 2) {
        showToast("Please add at least 2 scans in Align & Merge before saving a merged scan.");
        return;
      }
      if (STATE.multiAlign.layers.some((l) => !l.ready)) {
        showToast("Please wait a moment for all 3D scan layers to finish loading their bounds.");
        return;
      }
    } else if (countStagedAdjustments() === 0) {
      showToast("Stage at least one adjustment (Delete, Compression, or CRS) before saving edits.");
      return;
    }

    const nameEl = document.getElementById("txtGenerateScanName");
    const newScanName = String(nameEl?.value || st.newScanName || `${STATE.activeScan?.name || "Scan"}`).trim();
    st.newScanName = newScanName;

    const btnGen = document.getElementById("btnGenerateStagedScan");
    if (btnGen) {
      btnGen.disabled = true;
      btnGen.innerHTML = `<span>⏳ ${isMulti ? "Merging & Saving Scan on PC..." : "Saving Edits & Backing Up Original to Trash Bin..."}</span>`;
    }
    const resBox = document.getElementById("generateScanResultBox");
    if (resBox) {
      resBox.innerHTML = `<div style="font-size:11.5px;color:var(--ui-accent);">Saving "${escapeHtml(
        newScanName
      )}" with all staged edits (moving untouched original backup${isMulti ? "s" : ""} to Trash Bin)...</div>`;
    }

    try {
      let res = null;
      if (isMulti) {
        const curSite =
          (STATE.activeProjectGroup && STATE.activeProjectGroup !== "__all__" ? STATE.activeProjectGroup : "") ||
          STATE.multiAlign.layers[0]?.project_group ||
          STATE.activeScan?.project_group ||
          "Unassigned Site";
        const serializedLayers = serializeMultiAlignLayersForMerge(true);
        const refC = STATE.multiAlign.refCenter || STATE.multiAlign.layers[0]?.rawCenter || null;
        res = await apiPost("/api/scans/merge", {
          name: newScanName,
          new_scan_name: newScanName,
          project_group: curSite,
          ref_center_zup: refC ? [Number(refC.x), Number(refC.y), Number(refC.z)] : null,
          layers: serializedLayers,
          scans: serializedLayers,
          deletions: st.deletions,
          compression_preset: st.compressionPreset || "",
          crs_config: st.crsConfig || null,
          archive_originals_to_bin: Boolean(STATE.multiAlign.archiveOriginals),
        });
        STATE.multiAlign.lastMergedScan = res.scan || {
          scan_id: res.scan_id,
          name: newScanName,
          project_group: curSite,
        };
      } else {
        const targetSourceScanId = st.scanId && st.scanId !== "__multi_align__" ? st.scanId : STATE.activeScanId;
        const payload = {
          scan_id: targetSourceScanId,
          new_scan_name: newScanName,
          deletions: st.deletions,
          crop_keep: st.cropKeep || null,
          compression_preset: st.compressionPreset || "",
          crs_config: st.crsConfig || null,
          archive_original_to_bin: true,
        };
        res = await apiPost("/api/optimizer/generate-scan", payload);
      }

      clearLassoSelectionState();
      restoreOriginalStudioMeshIndices();
      if (isMulti) {
        exitMultiScanAlignMode(false);
      }
      setActiveStudioTool("orbit");

      if (typeof res.bin_scans_count === "number") {
        updateRecycleBinBadges(res.bin_scans_count);
      } else if (Array.isArray(res.bin_scans)) {
        updateRecycleBinBadges(res.bin_scans.length);
      }

      if (Array.isArray(res.scans)) {
        STATE.scans = res.scans;
      } else {
        await refreshScansCatalog();
      }
      if (Array.isArray(res.projects)) {
        STATE.projects = res.projects;
      }
      populateProjectScanDropdowns(res.scan?.project_group || STATE.activeProjectGroup, res.scan_id || res.scan?.scan_id || "");
      renderMapClusters();

      const prevResolvedGroundH = Number.isFinite(STATE.activeScan?._resolvedGroundH)
        ? STATE.activeScan._resolvedGroundH
        : null;
      const createdId = res.scan_id || res.scan?.scan_id;
      if (createdId) {
        if (prevResolvedGroundH !== null) {
          const createdObj = STATE.scans.find((s) => s.scan_id === createdId);
          if (createdObj && !Number.isFinite(createdObj._resolvedGroundH)) {
            createdObj._resolvedGroundH = prevResolvedGroundH;
          }
        }
        loadScanIntoStudio(createdId);
      }

      const outMb = res.output_mb ?? res.glb_size_mb ?? 0;
      const backupMsg = isMulti
        ? `${Number(res.archived_to_bin_count || 0)} original scan backup(s) moved to Trash Bin`
        : res.archived_to_bin
        ? `Original scan backup ("${escapeHtml(res.trashed_backup?.name || "Original Backup")}") moved to Trash Bin`
        : "Original scan backup preserved";
      showSidePanel(
        `<span>${tr("✓ 變更已儲存 · 原掃描已備份至回收桶", "✓ Edits Saved · Backup in Trash Bin")}</span>`,
        `
        <div style="background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.38);border-radius:8px;padding:12px;font-size:12px;color:var(--ui-text-primary);">
          <div style="color:#10b981;font-weight:700;font-size:13px;margin-bottom:6px;">✓ Saved "${escapeHtml(
            res.scan?.name || newScanName
          )}" (${res.duration_s}s)</div>
          <div style="margin-bottom:4px;">Scan ID: <code>${escapeHtml(createdId || "")}</code></div>
          <div style="margin-bottom:4px;">Coordinate System: <b>${escapeHtml(res.crs || res.scan?.crs || "TWD97 (121) + TWVD2001")}</b></div>
          <div style="margin-bottom:6px;">Output Size: <b>${outMb} MB</b></div>
          <div style="margin-bottom:8px;padding:6px 8px;border-radius:6px;background:var(--ui-bg-surface);border:1px solid var(--ui-border);font-size:11px;color:var(--ui-text-secondary);">
            🗑️ <b>Backup in Trash Bin:</b> ${backupMsg}. Easily restore it anytime from the Trash Bin.
          </div>
          <button type="button" class="gs-top-btn" id="btnOpenBinAfterSaveEdit" style="width:100%;justify-content:center;margin-bottom:8px;font-size:11.5px;">
            <span>${tr("🗑️ 開啟回收桶檢視 / 還原備份", "🗑️ Open Trash Bin to View / Restore Backup")}</span>
          </button>
          <div style="font-size:11px;color:var(--ui-text-secondary);border-top:1px solid var(--ui-border);padding-top:6px;">
            <b>${tr("已套用之修改項目：", "Applied Adjustments:")}</b>
            <ul style="margin:4px 0 0 16px;padding:0;">
              ${(res.applied_adjustments || []).map((a) => `<li>${escapeHtml(a)}</li>`).join("")}
            </ul>
          </div>
        </div>
        `
      );
      document.getElementById("btnOpenBinAfterSaveEdit")?.addEventListener("click", () => {
        openRecycleBinModal();
      });
      showToast(`Saved "${res.scan?.name || newScanName}" — original backup sent to Trash Bin!`);
    } catch (err) {
      if (resBox) {
        resBox.innerHTML = `<div style="font-size:11.5px;color:#ef4444;">Save Edits Error: ${escapeHtml(err.message)}</div>`;
      }
      if (btnGen) {
        btnGen.disabled = false;
        btnGen.innerHTML = `<span>${tr("💾 儲存變更", "💾 Save Edits")}</span>`;
      }
      showToast(`Save Edits Error: ${err.message}`);
    }
  }

  function openLassoDeleteInspector(opts = {}) {
    const armLasso = opts && opts.armLasso !== undefined ? Boolean(opts.armLasso) : true;
    STATE.cropMode = "delete_inside";
    if (armLasso) {
      if (STATE.activeTool !== "crop_delete") setActiveStudioTool("crop_delete");
    } else if (STATE.activeTool === "crop_delete" || STATE.activeTool === "crop") {
      setActiveStudioTool("orbit");
    }

    const st = ensureStagedEditsForActiveScan();
    const isLassoActive = STATE.activeTool === "crop_delete";
    const inputMethod = STATE.lassoInputMethod || "lasso";
    const visibleOnlyChecked = getEffectiveLassoVisibleOnly("delete_inside");
    const markedCount = countMarkedRegionsPending();
    const triCountLabel = `${Number(STATE.lassoSelectedTriCount || 0).toLocaleString()} ${tr("三角面", "tris")}`;
    const isMobView = window.innerWidth <= 768;
    if (isMobView) {
      if (isLassoActive && markedCount === 0 && !opts.keepExpanded) {
        STATE.sidePanelMinimized = true;
      } else if (!isLassoActive) {
        STATE.sidePanelMinimized = false;
      }
    } else {
      STATE.sidePanelMinimized = false;
    }

    const totalStagedDelRegions = st.deletions.reduce((acc, b) => acc + (Number(b.regionCount) || 1), 0);
    const totalStagedDelTris = st.deletions.reduce((acc, b) => acc + (Number(b.triCount) || 0), 0);
    const activeScanObj = STATE.scans.find((s) => s.scan_id === STATE.activeScanId) || STATE.activeScan;
    const canRestoreFromOriginal =
      !STATE.multiAlign?.active &&
      ((Array.isArray(activeScanObj?.merged_from) && activeScanObj.merged_from.length > 0) ||
        Boolean(activeScanObj?.derived_from_scan_id));
    const restoreConnChecked = STATE.restoreConnectedOnly !== false;

    const execBtnText = !isLassoActive
      ? markedCount > 0
        ? tr(`繼續套索標記 · 已保留 ${markedCount} 個選取範圍`, `Resume Lasso · ${markedCount} selected kept`)
        : tr("啟用套索標記刪除", "Select with Lasso — Mark for Deletion")
      : markedCount > 0
      ? tr(`🗑️ 刪除 · ${markedCount} 個範圍 · ${triCountLabel}`, `🗑️ Delete · ${markedCount} region${markedCount === 1 ? "" : "s"} · ${triCountLabel}`)
      : tr("🗑️ 刪除 · 請先用套索標記範圍", "🗑️ Delete · Mark polygons with Lasso first");

    showSidePanel(
      `<span>${tr("套索標記刪除", "Lasso Delete — Mark & Delete")}</span>`,
      `
      ${
        STATE.multiAlign?.active
          ? `<div style="background:rgba(56,189,248,0.11);border:1px solid rgba(56,189,248,0.4);border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:11px;color:var(--ui-text-primary);display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
              <span style="flex:1;min-width:140px;">${tr("🔗 <b>多掃描模式：</b>返回對齊視窗時將完整保留已選取與已刪除的多邊形範圍。", "🔗 <b>Multi-Scan Mode:</b> Selected &amp; deleted polygons stay preserved when returning to Alignment.")}</span>
              <button type="button" class="gs-top-btn" id="btnLassoBackToAlign" style="padding:4px 9px;font-size:11px;font-weight:700;flex-shrink:0;" title="${tr("返回 3D 對齊與圖層清單 · 完整保留已選取與已刪除範圍", "Return to 3D Gizmo Alignment & Layer Checklist · keeps all selected & deleted polygons")}">
                <span>${tr("🎯 返回對齊", "🎯 Return to Alignment")}</span>
              </button>
            </div>`
          : ""
      }
      <div style="background:rgba(239,68,68,0.10);border:1px solid rgba(239,68,68,0.35);border-radius:8px;padding:10px;margin-bottom:10px;">
        <div style="font-size:12px;font-weight:700;color:#ef4444;margin-bottom:5px;display:flex;align-items:center;justify-content:space-between;gap:6px;">
          <span>${tr("🗑️ 標記欲刪除之網格範圍", "🗑️ Mark Polygons for Deletion")}</span>
          ${
            isLassoActive
              ? `<button type="button" class="gs-top-btn" id="btnCancelLassoMode" style="padding:2px 7px;font-size:10.5px;border-color:rgba(239,68,68,0.45);color:#ef4444;" title="${tr("暫停套索並切換為自由旋轉視角 · Esc", "Pause Lasso to Orbit Freely · Esc")}">
                  <span>${tr("✋ 旋轉視角 · Esc", "✋ Orbit · Esc")}</span>
                </button>`
              : `<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:var(--ui-bg-surface);color:var(--ui-text-secondary);">${tr("環繞視角模式", "Orbit Mode")}</span>`
          }
        </div>
        <div style="font-size:11px;color:var(--ui-text-secondary);margin-bottom:8px;line-height:1.45;">
          ${
            !isLassoActive
              ? isMobView
                ? tr(
                    `單指旋轉模式 — 可自由拖曳旋轉視角${markedCount > 0 ? ` · 已保留 <b>${markedCount}</b> 個標記範圍` : ""}。點擊下方按鈕繼續套索標記。`,
                    `Orbit mode active — rotate freely${markedCount > 0 ? ` · <b>${markedCount}</b> selected region${markedCount === 1 ? " is" : "s are"} preserved` : ""}. Press the button below to resume Lasso.`
                  )
                : tr(
                    `環繞視角模式 — 可使用<b>滑鼠左鍵</b>或<b>滾輪中鍵</b>自由旋轉視角${markedCount > 0 ? ` · 已保留 <b>${markedCount}</b> 個選取範圍` : ""}。點擊下方按鈕繼續套索標記。`,
                    `Orbit mode active — rotate freely with <b>Left Mouse</b> or <b>Mouse Wheel</b>${
                      markedCount > 0 ? ` · your <b>${markedCount}</b> selected region${markedCount === 1 ? " is" : "s are"} preserved` : ""
                    }. Press the button below to resume Lasso.`
                  )
              : inputMethod !== "polygon"
              ? isMobView
                ? tr(
                    `<b>1.</b> 單指拖曳畫圈標記刪除範圍 · 雙指縮放平移 · 點擊上方 <b>🔄 旋轉</b> 切換視角。<br/><b>2.</b> 點擊上方或下方 <b>🗑️ 執行刪除</b> 套用預覽。`,
                    `<b>1.</b> Single-finger drag to mark regions for deletion · two-finger zoom/pan · tap <b>🔄 Orbit</b> above to rotate.<br/><b>2.</b> Tap <b>🗑️ Delete</b> to remove from preview.`
                  )
                : tr(
                    `<b>1.</b> 按住<b>滑鼠左鍵</b>拖曳可多次標記紅色刪除範圍 · 隨時按住<b>滑鼠中鍵滾輪</b>旋轉視角 · <b>Alt+拖曳</b>取消標記。<br/><b>2.</b> 點擊下方 <b>刪除</b> 即可從 3D 預覽移除 · 按 <b>Esc</b> 切換旋轉視角。`,
                    `<b>1.</b> Drag <b>Left Mouse</b> several times to mark multiple regions in red · rotate anytime by pressing <b>Mouse Wheel</b> · <b>Alt+Drag</b> to unmark.<br/><b>2.</b> Press <b>Delete</b> below to remove marked regions from preview · <b>Esc</b> to orbit.`
                  )
              : isMobView
              ? tr(
                  `<b>1.</b> 點擊 3+ 頂點並點擊上方 <b>✓ 鎖定</b> 完成多邊形標記 · 雙指縮放平移。<br/><b>2.</b> 點擊 <b>🗑️ 執行刪除</b> 套用預覽。`,
                  `<b>1.</b> Tap 3+ vertices and tap <b>✓ Lock</b> above to finish polygon · two-finger zoom/pan.<br/><b>2.</b> Tap <b>🗑️ Delete</b> to remove from preview.`
                )
              : tr(
                  `<b>1.</b> 點擊 3+ 個頂點並點擊紅色起點 <b>V1</b> 或按 <b>Enter</b> 鎖定多邊形 #1，可繼續繪製多邊形 #2、#3... · 按住<b>滑鼠滾輪</b>旋轉視角。<br/><b>2.</b> 點擊下方 <b>刪除</b> 移除標記範圍 · 按 <b>Esc</b> 切換旋轉視角。`,
                  `<b>1.</b> Click 3+ vertices and click red <b>V1</b> or press <b>Enter</b> to lock Polygon #1, then draw Polygon #2, #3... · <b>Mouse Wheel</b> to rotate.<br/><b>2.</b> Press <b>Delete</b> below to remove marked polygons · <b>Esc</b> to orbit.`
                )
          }
        </div>

        <div style="display:flex;gap:5px;margin-bottom:8px;">
          <button type="button" class="gs-top-btn ${isLassoActive && inputMethod !== "polygon" ? "accent" : ""}" id="btnModeFreehandLasso" style="flex:1;justify-content:center;font-size:11px;">
            <span>${tr("✏️ 3D 自由套索", "✏️ Freehand 3D Lasso")}</span>
          </button>
          <button type="button" class="gs-top-btn ${isLassoActive && inputMethod === "polygon" ? "accent" : ""}" id="btnModePolygonClick" style="flex:1;justify-content:center;font-size:11px;">
            <span>${tr("📐 多邊形點選", "📐 Plan Polygon")}</span>
          </button>
        </div>

        <div style="margin-bottom:8px;">
          <div style="font-size:10.5px;font-weight:700;color:var(--ui-text-secondary);margin-bottom:4px;">
            ${tr("刪除深度模式 (預設：選取內全部)：", "Erase Depth Mode (Default: Erase All):")}
          </div>
          <div style="display:flex;gap:5px;margin-bottom:5px;">
            <button type="button" class="gs-top-btn ${!visibleOnlyChecked ? "accent" : ""}" id="btnLassoEraseAllMode" style="flex:1;justify-content:center;font-size:10.5px;padding:5px 6px;" title="${tr("刪除選取範圍內所有深度的三角面（預設）", "Erase all triangles inside selection through all depths (Default)")}">
              <span>🌐 ${tr("刪除選取內全部", "Erase All in Selection")}</span>
            </button>
            <button type="button" class="gs-top-btn ${visibleOnlyChecked ? "accent" : ""}" id="btnLassoEraseVisibleMode" style="flex:1;justify-content:center;font-size:10.5px;padding:5px 6px;" title="${tr("僅刪除前景可見表面，保護後方被遮蔽的牆面或地面", "Erase only visible foreground triangles, protecting occluded background")}">
              <span>👁️ ${tr("僅刪除可見表面", "Erase Visible Only")}</span>
            </button>
          </div>
          <label style="display:flex;align-items:flex-start;gap:7px;font-size:10.5px;color:var(--ui-text-secondary);background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;padding:5px 8px;cursor:pointer;">
            <input type="checkbox" id="chkLassoVisibleOnly" ${visibleOnlyChecked ? "checked" : ""} style="margin-top:2px;accent-color:var(--ui-accent);" />
            <span>
              ${
                visibleOnlyChecked
                  ? tr("目前：<b>僅刪除可見前景表面</b>（避免誤刪後方被遮蔽的牆面或地形）", "Active: <b>Erase Visible in Selection</b> (protects background surfaces behind foreground objects)")
                  : tr("目前：<b>刪除選取內全部 (預設)</b>（穿透深度刪除圈選範圍內所有三角面）", "Active: <b>Erase All in Selection (Default)</b> (erases all triangles through depth inside selection)")
              }
            </span>
          </label>
          ${
            isSectionBoxClippingActive()
              ? `<div style="margin-top:5px;font-size:10.5px;color:var(--ui-accent);background:rgba(56,189,248,0.1);border:1px solid rgba(56,189,248,0.35);border-radius:6px;padding:4px 8px;">
                  📦 ${tr("<b>3D 剖面盒裁切啟用中</b> — 被剖面隱藏的外部三角面受到保護，不會被選取或刪除。", "<b>Section Box Active</b> — triangles hidden outside the section box are protected and will not be selected or erased.")}
                </div>`
              : ""
          }
        </div>

        <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;padding:6px 8px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">
          <span>
            ${tr("已標記：", "Marked:")} <b>${markedCount > 0 ? tr(`${markedCount} 個範圍`, `${markedCount} region${markedCount === 1 ? "" : "s"}`) : tr("尚未標記", "None yet")}</b>
            · <b id="lblLassoSelectedTris" style="color:#ef4444;">${triCountLabel}</b>
          </span>
          <div style="display:flex;gap:4px;">
            <button type="button" class="gs-top-btn" id="btnUndoLastMark" style="padding:2px 7px;font-size:10.5px;${
              markedCount > 0 ? "" : "opacity:0.45;pointer-events:none;"
            }" ${markedCount > 0 ? "" : "disabled"} title="${tr("復原最後標記的多邊形或套索筆畫", "Remove the most recently marked polygon/lasso stroke")}">
              <span>${tr("復原標記", "Undo Mark")}</span>
            </button>
            <button type="button" class="gs-top-btn" id="btnDrawCropPolygon" style="padding:2px 7px;font-size:10.5px;" title="${tr("清除所有目前已標記的紅色區域", "Clear all currently marked red regions")}">
              <span>${tr("清除", "Clear")}</span>
            </button>
          </div>
        </div>

        <div style="display:flex;gap:6px;">
          <button type="button" class="gs-top-btn accent" style="flex:1;justify-content:center;padding:9px 12px;font-weight:700;background:#ef4444;border-color:#dc2626;color:#fff;" id="btnExecuteCrop" title="${
            !isLassoActive
              ? tr("啟用 3D 套索選取 · 標記刪除範圍", "Activate 3D Lasso Selection · Mark for Deletion")
              : tr("於 3D 預覽中刪除所有標記範圍並加入待儲存變更", "Delete all marked regions in 3D preview and stage for Save Edits")
          }">
            <span id="lblExecuteCropBtn">${execBtnText}</span>
          </button>
          ${
            !isLassoActive && markedCount > 0
              ? `<button type="button" class="gs-top-btn" id="btnCommitMarkedWhilePaused" style="justify-content:center;padding:9px 10px;font-weight:700;border-color:#dc2626;color:#ef4444;" title="${tr(`立即刪除已標記的 ${markedCount} 個範圍`, `Delete the ${markedCount} marked regions right now`)}">
                  <span>🗑️ ${tr(`刪除 · ${markedCount}`, `Delete · ${markedCount}`)}</span>
                </button>`
              : ""
          }
        </div>
      </div>

      ${
        st.deletions.length > 0
          ? `<div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);border-radius:8px;padding:9px 10px;margin-bottom:8px;">
              <div style="font-size:11.5px;font-weight:700;color:var(--ui-text-primary);display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
                <span>🗑️ ${tr(`已於 3D 預覽刪除 · ${totalStagedDelRegions} 個範圍`, `Deleted in 3D Preview · ${totalStagedDelRegions} region${totalStagedDelRegions === 1 ? "" : "s"}`)}</span>
                <span style="font-size:10.5px;color:#ef4444;">-${totalStagedDelTris.toLocaleString()} ${tr("三角面", "tris")}</span>
              </div>
              <div style="display:flex;gap:6px;">
                <button type="button" class="gs-top-btn" id="btnUndoStagedDelete" style="flex:1;justify-content:center;font-size:11px;">
                  <span>↩️ ${tr("復原上一次刪除", "Undo Last Delete")}</span>
                </button>
                <button type="button" class="gs-top-btn" id="btnClearAllStagedDeletes" style="flex:1;justify-content:center;font-size:11px;">
                  <span>${tr("還原全部已刪區域", "Restore All Deleted")}</span>
                </button>
              </div>
            </div>`
          : ""
      }

      ${
        canRestoreFromOriginal
          ? `<div style="background:rgba(16,185,129,0.09);border:1px solid rgba(16,185,129,0.38);border-radius:8px;padding:10px;margin-bottom:10px;">
              <div style="font-size:12px;font-weight:700;color:#10b981;margin-bottom:4px;display:flex;align-items:center;justify-content:space-between;gap:6px;">
                <span>🩹 ${tr("從原始掃描補回缺口", "Restore Accidentally Deleted Area")}</span>
              </div>
              <div style="font-size:11px;color:var(--ui-text-secondary);margin-bottom:7px;line-height:1.45;">
                ${tr(
                  "使用上方 <b>3D 自由套索</b> 或 <b>多邊形點選</b> 圈選誤刪缺口，再點擊下方按鈕即可從未修改之原始 4K 掃描將缺失網格補回。",
                  "Draw a <b>Freehand 3D Lasso</b> or <b>Plan Polygon</b> over any missing gap above, then click below to splice the missing triangles back from the untouched original scan at full 4K quality."
                )}
              </div>
              <label style="display:flex;align-items:flex-start;gap:7px;font-size:11px;color:var(--ui-text-primary);background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;padding:5px 8px;margin-bottom:8px;cursor:pointer;">
                <input type="checkbox" id="chkRestoreConnectedOnly" ${restoreConnChecked ? "checked" : ""} style="margin-top:2px;accent-color:#10b981;" />
                <span>
                  <b>${tr("僅補回邊界相連表面 · 排除懸浮碎塊", "Boundary-connected surface only")}</b><br/>
                  <span style="font-size:10px;color:var(--ui-text-secondary);">${tr("補回與周圍道路或牆面相連的表面，並自動略過懸浮於空中的樹冠或雜訊碎塊。", "Restores surfaces connected to surrounding road/walls while skipping floating sky/tree debris.")}</span>
                </span>
              </label>
              <button type="button" class="gs-top-btn" id="btnRestoreDeletedRegion" style="width:100%;justify-content:center;padding:8px 12px;font-weight:700;background:${
                markedCount > 0 ? "#10b981" : "rgba(16,185,129,0.16)"
              };border-color:#059669;color:${markedCount > 0 ? "#fff" : "#10b981"};">
                <span>${
                  !isLassoActive && markedCount === 0
                    ? `🩹 ${tr("啟用套索圈選缺口", "Activate Lasso to Mark Gap for Restore")}`
                    : markedCount > 0
                    ? `🩹 ${tr(`補回原始模型 · 已圈選 ${markedCount} 處`, `Restore Deleted Area · ${markedCount} marked region${markedCount === 1 ? "" : "s"}`)}`
                    : `🩹 ${tr("補回誤刪區域 · 請先用套索圈選缺口", "Restore Deleted Area · Circle missing gap with Lasso first")}`
                }</span>
              </button>
              <div id="restoreDeletedRegionStatus" style="margin-top:5px;"></div>
            </div>`
          : ""
      }

      ${renderStagedAdjustmentsCardHtml({ alwaysShow: false })}
      `
    );

    document.getElementById("btnLassoBackToAlign")?.addEventListener("click", () => {
      preserveLassoSelectionBeforeToolSwitch();
      const keptMarks = countMarkedRegionsPending();
      setActiveStudioTool("align_merge");
      openAlignMergeInspector();
      if (keptMarks > 0) {
        showToast(`Returned to Alignment — ${keptMarks} selected polygon region${keptMarks === 1 ? "" : "s"} preserved`);
      }
    });

    document.getElementById("btnCancelLassoMode")?.addEventListener("click", () => {
      cancelLassoToolMode(true, false);
      const keptMarks = countMarkedRegionsPending();
      showToast(
        keptMarks > 0
          ? `Orbit mode (${keptMarks} selected region${keptMarks === 1 ? "" : "s"} preserved) — press Resume Lasso to mark more`
          : "Orbit mode — press the red button on the right to start Lasso again"
      );
    });

    const applyLassoDeleteDepthMode = (visOnly) => {
      STATE.lassoVisibleOnlyDelete = Boolean(visOnly);
      if (Array.isArray(STATE.lassoStrokes)) {
        STATE.lassoStrokes.forEach((s) => {
          if (s && typeof s === "object") s.visible_only = STATE.lassoVisibleOnlyDelete;
        });
      }
      const selTris = rebuildLassoHighlight3D();
      openLassoDeleteInspector({ armLasso: isLassoActive });
      showToast(
        STATE.lassoVisibleOnlyDelete
          ? tr(`👁️ 僅刪除可見表面 — 已標記 ${selTris.toLocaleString()} 個前景三角面`, `👁️ Erase Visible Only — ${selTris.toLocaleString()} visible foreground triangles marked`)
          : tr(`🌐 刪除選取內全部 (穿透) — 已標記 ${selTris.toLocaleString()} 個三角面`, `🌐 Erase All in Selection — ${selTris.toLocaleString()} triangles marked across all depths`)
      );
    };

    document.getElementById("btnLassoEraseAllMode")?.addEventListener("click", () => {
      applyLassoDeleteDepthMode(false);
    });
    document.getElementById("btnLassoEraseVisibleMode")?.addEventListener("click", () => {
      applyLassoDeleteDepthMode(true);
    });
    document.getElementById("chkLassoVisibleOnly")?.addEventListener("change", (ev) => {
      applyLassoDeleteDepthMode(Boolean(ev.target.checked));
    });

    document.getElementById("btnModeFreehandLasso")?.addEventListener("click", () => {
      STATE.lassoInputMethod = "lasso";
      STATE.measurePoints = [];
      STATE.cropPolygonPoints = [];
      setActiveStudioTool("crop_delete");
      rebuildLassoHighlight3D();
      openLassoDeleteInspector({ armLasso: true });
      showToast("Freehand 3D Lasso active — Left-Drag multiple regions, Mouse Wheel to rotate, then press Delete");
    });

    document.getElementById("btnModePolygonClick")?.addEventListener("click", () => {
      STATE.lassoInputMethod = "polygon";
      STATE.measurePoints = [];
      STATE.cropPolygonPoints = [];
      setActiveStudioTool("crop_delete");
      rebuildLassoHighlight3D();
      openLassoDeleteInspector({ armLasso: true });
      showToast("Plan Polygon active — click 3+ vertices & red V1 to mark multiple polygons, then press Delete");
    });

    document.getElementById("btnUndoLastMark")?.addEventListener("click", () => {
      if (Array.isArray(STATE.measurePoints) && STATE.measurePoints.length > 0) {
        STATE.measurePoints = [];
        STATE.cropPolygonPoints = [];
      } else if (STATE.lassoInputMethod === "polygon" && Array.isArray(STATE.pendingCropPolygons) && STATE.pendingCropPolygons.length > 0) {
        STATE.pendingCropPolygons.pop();
      } else if (Array.isArray(STATE.lassoStrokes) && STATE.lassoStrokes.length > 0) {
        STATE.lassoStrokes.pop();
      } else if (Array.isArray(STATE.pendingCropPolygons) && STATE.pendingCropPolygons.length > 0) {
        STATE.pendingCropPolygons.pop();
      }
      rebuildLassoHighlight3D();
      openLassoDeleteInspector({ armLasso: isLassoActive });
      showToast("Removed last marked region");
    });

    document.getElementById("btnDrawCropPolygon")?.addEventListener("click", () => {
      STATE.polygonLocked = false;
      STATE.measurePoints = [];
      clearLassoSelectionState();
      if (isLassoActive) setActiveStudioTool("crop_delete");
      openLassoDeleteInspector({ armLasso: isLassoActive });
      showToast("Cleared marked regions");
    });

    document.getElementById("btnUndoStagedDelete")?.addEventListener("click", () => {
      if (st.deletions.length > 0) {
        st.deletions.pop();
        st.rev++;
        applyStagedEditsToStudioMeshes(true);
        syncStagedEditsDockBadge();
        openLassoDeleteInspector({ armLasso: isLassoActive });
        showToast("Undid last Delete batch in 3D preview");
      }
    });

    document.getElementById("btnClearAllStagedDeletes")?.addEventListener("click", () => {
      st.deletions = [];
      st.rev++;
      applyStagedEditsToStudioMeshes(true);
      syncStagedEditsDockBadge();
      openLassoDeleteInspector({ armLasso: isLassoActive });
      showToast("Restored all deleted regions in 3D preview");
    });

    document.getElementById("btnCommitMarkedWhilePaused")?.addEventListener("click", () => {
      const res = commitPendingLassoMarksToStagedEdits("delete_inside");
      openLassoDeleteInspector({ armLasso: false });
      if (res.committed > 0) {
        showToast(`Deleted ${res.committed} marked region(s) in 3D preview — press Save Edits when ready!`);
      }
    });

    document.getElementById("btnExecuteCrop")?.addEventListener("click", () => {
      if (STATE.activeTool !== "crop_delete") {
        setActiveStudioTool("crop_delete");
        openLassoDeleteInspector({ armLasso: true });
        showToast("Lasso active (Mark for Deletion) — mark multiple regions, then press Delete");
        return;
      }

      const res = commitPendingLassoMarksToStagedEdits("delete_inside");
      if (res.committed === 0) {
        showToast(
          STATE.lassoInputMethod === "polygon"
            ? "Click 3+ polygon vertices on the 3D scan to mark regions first (Mouse Wheel to rotate)"
            : "Drag Left Mouse on the 3D scan to mark 1 or more regions first (Mouse Wheel to rotate)"
        );
        return;
      }

      openLassoDeleteInspector({ armLasso: true });
      showToast(
        `Deleted ${res.committed} marked region${res.committed === 1 ? "" : "s"} in 3D preview — mark more, adjust Compression / CRS, or press Save Edits!`
      );
    });

    document.getElementById("chkRestoreConnectedOnly")?.addEventListener("change", (ev) => {
      STATE.restoreConnectedOnly = Boolean(ev.target.checked);
    });

    document.getElementById("btnRestoreDeletedRegion")?.addEventListener("click", async () => {
      if (STATE.activeTool !== "crop_delete" && countMarkedRegionsPending() === 0) {
        setActiveStudioTool("crop_delete");
        openLassoDeleteInspector({ armLasso: true });
        showToast("Lasso active — circle the missing gap with Left-Drag, then press '🩹 Restore Deleted Area'");
        return;
      }

      const restoreStrokes = (STATE.lassoStrokes || []).map((s) => Object.assign({}, s, { visible_only: false }));
      const rawWorldPolys = [];
      if (Array.isArray(STATE.pendingCropPolygons)) {
        STATE.pendingCropPolygons.forEach((pts) => {
          if (Array.isArray(pts) && pts.length >= 3) rawWorldPolys.push(pts);
        });
      }
      if (Array.isArray(STATE.measurePoints) && STATE.measurePoints.length >= 3) {
        rawWorldPolys.push(STATE.measurePoints);
      }
      const restorePolys = [];
      if (rawWorldPolys.length > 0 && isActiveStudioTilesetEcef()) {
        rawWorldPolys.forEach((pts) => {
          const orthoSt = planPolygonToTopDownFrustumStroke(pts);
          if (orthoSt) restoreStrokes.push(orthoSt);
        });
      } else {
        rawWorldPolys.forEach((pts) => {
          restorePolys.push(
            pts.map((p) => {
              const n = studioWorldToTilesetNative(p);
              return [n[0], n[1]];
            })
          );
        });
      }

      const regionTotal = restoreStrokes.filter((s) => s.op !== "sub").length + restorePolys.length;
      if (regionTotal === 0) {
        showToast("Drag Left Mouse over the missing gap to mark it first, then press '🩹 Restore Deleted Area'");
        return;
      }

      const btnR = document.getElementById("btnRestoreDeletedRegion");
      const statusBox = document.getElementById("restoreDeletedRegionStatus");
      if (btnR) {
        btnR.disabled = true;
        btnR.innerHTML = `<span>⏳ Splicing Missing Geometry from Original 4K Scan...</span>`;
      }
      if (statusBox) {
        statusBox.innerHTML = `<div style="font-size:11px;color:#10b981;">Restoring missing triangles from original source scan...</div>`;
      }

      try {
        const res = await apiPost("/api/optimizer/restore-region", {
          scan_id: STATE.activeScanId,
          frustum_strokes: restoreStrokes,
          native_polygons: restorePolys,
          connected_only: STATE.restoreConnectedOnly !== false,
        });
        STATE.measurePoints = [];
        clearLassoSelectionState();
        if (Array.isArray(res.scans)) {
          STATE.scans = res.scans;
        } else {
          await refreshScansCatalog();
        }
        if (Array.isArray(res.projects)) {
          STATE.projects = res.projects;
        }
        populateProjectScanDropdowns(res.scan?.project_group || STATE.activeProjectGroup, STATE.activeScanId);
        renderMapClusters();
        loadScanIntoStudio(STATE.activeScanId, { preserveCamera: true, bustCache: true });
        openLassoDeleteInspector({ armLasso: false });
        showToast(
          `Restored ${Number(res.restored_triangles || 0).toLocaleString()} triangles from original scan (${res.duration_s}s)!`
        );
      } catch (err) {
        if (btnR) {
          btnR.disabled = false;
          btnR.innerHTML = `<span>🩹 Restore Deleted Area (${regionTotal} marked)</span>`;
        }
        if (statusBox) {
          statusBox.innerHTML = `<div style="font-size:11px;color:#ef4444;">${escapeHtml(err.message)}</div>`;
        }
        showToast(`Restore note: ${err.message}`);
      }
    });

    bindStagedAdjustmentsCardEvents(() => openLassoDeleteInspector({ armLasso: STATE.activeTool === "crop_delete" }));
  }

  function openLassoKeepInspector(opts = {}) {
    const armLasso = opts && opts.armLasso !== undefined ? Boolean(opts.armLasso) : true;
    STATE.cropMode = "keep_inside";
    if (armLasso) {
      if (STATE.activeTool !== "crop") setActiveStudioTool("crop");
    } else if (STATE.activeTool === "crop" || STATE.activeTool === "crop_delete") {
      setActiveStudioTool("orbit");
    }

    const st = ensureStagedEditsForActiveScan();
    const isLassoActive = STATE.activeTool === "crop";
    const inputMethod = STATE.lassoInputMethod || "lasso";
    const markedCount = countMarkedRegionsPending();
    const triCountLabel = `${Number(STATE.lassoSelectedTriCount || 0).toLocaleString()} ${tr("三角面", "tris")}`;
    const isMobKeep = window.innerWidth <= 768;
    if (isMobKeep) {
      if (isLassoActive && markedCount === 0 && !opts.keepExpanded) {
        STATE.sidePanelMinimized = true;
      } else if (!isLassoActive) {
        STATE.sidePanelMinimized = false;
      }
    } else {
      STATE.sidePanelMinimized = false;
    }

    const execBtnText = !isLassoActive
      ? markedCount > 0
        ? tr(`繼續框選 · 已保留 ${markedCount} 處`, `Resume Keep Selection · ${markedCount} kept`)
        : tr("啟用框選保留", "Select Keep Boundary")
      : markedCount > 0
      ? tr(`✂️ 套用保留裁切 · ${markedCount} 個範圍 · ${triCountLabel}`, `✂️ Stage Keep Crop · ${markedCount} region${markedCount === 1 ? "" : "s"} · ${triCountLabel}`)
      : tr("✂️ 套用保留裁切 · 請先框選保留範圍", "✂️ Stage Keep Crop · Mark region to keep first");

    showSidePanel(
      `<span>${tr("框選保留區域", "Crop Keep — Keep Selected Region")}</span>`,
      `
      <div style="background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.35);border-radius:8px;padding:10px;margin-bottom:10px;">
        <div style="font-size:12px;font-weight:700;color:#10b981;margin-bottom:5px;display:flex;align-items:center;justify-content:space-between;gap:6px;">
          <span>${tr("✂️ 標記欲保留之範圍", "✂️ Mark Regions to Keep")}</span>
          ${
            isLassoActive
              ? `<button type="button" class="gs-top-btn" id="btnCancelLassoMode" style="padding:2px 7px;font-size:10.5px;" title="${tr("暫停框選並切換旋轉視角 · Esc", "Pause Lasso to Orbit · Esc")}">${tr("✋ 旋轉視角 · Esc", "✋ Orbit · Esc")}</button>`
              : `<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:var(--ui-bg-surface);color:var(--ui-text-secondary);">${tr("環繞視角模式", "Orbit Mode")}</span>`
          }
        </div>
        <div style="font-size:11px;color:var(--ui-text-secondary);margin-bottom:8px;line-height:1.45;">
          ${
            isMobKeep
              ? tr(
                  `單指畫圈或點擊多邊形標記欲<b>保留</b>的範圍 · 範圍外將於儲存時裁切 · 雙指縮放平移 · 點擊上方 <b>🔄 旋轉</b> 切換視角。`,
                  `Single-finger draw or click polygon to mark the area to <b>keep</b> · outside cropped on Save · two-finger zoom/pan · tap <b>🔄 Orbit</b> above to rotate.`
                )
              : tr(
                  `標記欲<b>保留</b>的邊界範圍 · 範圍外的網格將於點擊<b>儲存變更</b>時裁切移除 · 可隨時按住<b>滑鼠中鍵滾輪</b>旋轉視角。`,
                  `Mark the boundary you want to <b>keep</b> · everything outside will be cropped out when you press <b>Save Edits</b> · Rotate anytime with <b>Mouse Wheel</b>.`
                )
          }
        </div>

        <div style="display:flex;gap:5px;margin-bottom:8px;">
          <button type="button" class="gs-top-btn ${isLassoActive && inputMethod !== "polygon" ? "accent" : ""}" id="btnModeFreehandLasso" style="flex:1;justify-content:center;font-size:11px;">
            <span>${tr("✏️ 3D 自由套索", "✏️ Freehand 3D Lasso")}</span>
          </button>
          <button type="button" class="gs-top-btn ${isLassoActive && inputMethod === "polygon" ? "accent" : ""}" id="btnModePolygonClick" style="flex:1;justify-content:center;font-size:11px;">
            <span>${tr("📐 多邊形點選", "📐 Plan Polygon")}</span>
          </button>
        </div>

        <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;padding:6px 8px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:6px;">
          <span>
            ${tr("已標記：", "Marked:")} <b>${markedCount > 0 ? tr(`${markedCount} 個範圍`, `${markedCount} region${markedCount === 1 ? "" : "s"}`) : tr("尚未標記", "None yet")}</b>
            · <b id="lblLassoSelectedTris" style="color:#10b981;">${triCountLabel}</b>
          </span>
          <button type="button" class="gs-top-btn" id="btnDrawCropPolygon" style="padding:2px 8px;font-size:10.5px;">${tr("清除", "Clear")}</button>
        </div>

        <button type="button" class="gs-top-btn accent" style="width:100%;justify-content:center;padding:8px 12px;font-weight:700;" id="btnExecuteCrop">
          <span>${execBtnText}</span>
        </button>
      </div>

      ${renderStagedAdjustmentsCardHtml({ alwaysShow: false })}
      `
    );

    document.getElementById("btnLassoBackToAlign")?.addEventListener("click", () => {
      preserveLassoSelectionBeforeToolSwitch();
      setActiveStudioTool("align_merge");
      openAlignMergeInspector();
    });

    document.getElementById("btnCancelLassoMode")?.addEventListener("click", () => {
      cancelLassoToolMode(true, false);
    });
    document.getElementById("btnModeFreehandLasso")?.addEventListener("click", () => {
      STATE.lassoInputMethod = "lasso";
      STATE.measurePoints = [];
      STATE.cropPolygonPoints = [];
      setActiveStudioTool("crop");
      rebuildLassoHighlight3D();
      openLassoKeepInspector({ armLasso: true });
    });
    document.getElementById("btnModePolygonClick")?.addEventListener("click", () => {
      STATE.lassoInputMethod = "polygon";
      STATE.measurePoints = [];
      STATE.cropPolygonPoints = [];
      setActiveStudioTool("crop");
      rebuildLassoHighlight3D();
      openLassoKeepInspector({ armLasso: true });
    });
    document.getElementById("btnDrawCropPolygon")?.addEventListener("click", () => {
      STATE.measurePoints = [];
      clearLassoSelectionState();
      if (isLassoActive) setActiveStudioTool("crop");
      openLassoKeepInspector({ armLasso: isLassoActive });
    });
    document.getElementById("btnExecuteCrop")?.addEventListener("click", () => {
      if (STATE.activeTool !== "crop") {
        setActiveStudioTool("crop");
        openLassoKeepInspector({ armLasso: true });
        return;
      }
      const res = commitPendingLassoMarksToStagedEdits("keep_inside");
      if (res.committed === 0) {
        showToast("Mark at least 1 region to keep first.");
        return;
      }
      setActiveStudioTool("orbit");
      openLassoKeepInspector({ armLasso: false });
      showToast("Staged Keep Crop in 3D preview — adjust Compression / CRS or press Save Edits!");
    });

    bindStagedAdjustmentsCardEvents(() => openLassoKeepInspector({ armLasso: STATE.activeTool === "crop" }));
  }

  function renderActiveScanSpecsCardHtml(scan = STATE.activeScan) {
    if (!scan) return "";
    updateStudioScanMetricsReadout(scan);
    const polyStr = formatScanPolyCount(scan);
    const texStr = formatScanTextureSize(scan);
    const sizeStr = formatScanSizeMb(scan, { includeTotal: true });
    return `
      <div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);border-radius:8px;padding:10px;margin-bottom:10px;">
        <div style="font-size:11px;font-weight:700;color:var(--ui-text-secondary);margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;">
          <span>📊 ${tr("目前掃描規格", "Active Scan Metrics")}</span>
          <span style="color:var(--ui-accent);font-family:monospace;">${escapeHtml(formatCoveredAreaM2(scan))}</span>
        </div>
        <div class="gs-metric-grid" style="grid-template-columns:repeat(3,1fr);gap:6px;">
          <div class="gs-metric-box" style="padding:6px 7px;">
            <div class="lbl">${tr("網格面數", "Polygon Count")}</div>
            <div class="val" style="font-size:11.5px;">${escapeHtml(polyStr)}</div>
          </div>
          <div class="gs-metric-box" style="padding:6px 7px;">
            <div class="lbl">${tr("貼圖解析度", "Texture Size")}</div>
            <div class="val" style="font-size:11.5px;">${escapeHtml(texStr)}</div>
          </div>
          <div class="gs-metric-box" style="padding:6px 7px;">
            <div class="lbl">${tr("模型大小 MB", "Scan Size MB")}</div>
            <div class="val" style="font-size:11.5px;" title="${escapeHtml(sizeStr)}">${escapeHtml(formatScanSizeMb(scan))}</div>
          </div>
        </div>
      </div>
    `;
  }

  function openMeshCompressionInspector() {
    STATE.sidePanelMinimized = false;
    const st = ensureStagedEditsForActiveScan();
    const curPreset = st.compressionPreset || "balanced";

    showSidePanel(
      `<span>${tr("網格與貼圖壓縮優化", "Mesh & Texture Compression")}</span>`,
      `
      ${renderActiveScanSpecsCardHtml(STATE.activeScan)}
      <div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);border-radius:8px;padding:11px;margin-bottom:10px;">
        <div style="font-size:12px;font-weight:700;color:var(--ui-text-primary);margin-bottom:4px;">
          ⚡ ${tr("GC_ScanOptimizer 網格壓縮預設", "GC_ScanOptimizer Compression Preset")}
        </div>
        <p style="font-size:11px;color:var(--ui-text-secondary);margin-bottom:9px;line-height:1.45;">
          ${tr(
            "選擇產製新掃描時套用之網格簡化與貼圖最佳化等級 · 完整保留 64 位元空間座標精度。",
            "Choose mesh decimation &amp; texture optimization to apply when generating your new scan · 64-bit coordinate precision preserved."
          )}
        </p>
        <div class="gs-form-group" style="margin-bottom:10px;">
          <label>${tr("壓縮與串流等級", "Target Compression Level")}</label>
          <select class="gs-select" id="optPresetSelect">
            <option value="none" ${curPreset === "none" ? "selected" : ""}>${tr("不額外壓縮 · 100% 原始網格與貼圖", "No Extra Compression · 100% Original Mesh & Textures")}</option>
            <option value="quality" ${curPreset === "quality" ? "selected" : ""}>${tr("高保真品質 · 75% 面數 · 2048px JPEG", "High Fidelity Quality · 75% Tris · 2048px JPEG")}</option>
            <option value="balanced" ${curPreset === "balanced" ? "selected" : ""}>${tr("平衡串流 · 50% 面數 · 1536px JPEG", "Balanced Web Stream · 50% Tris · 1536px JPEG")}</option>
            <option value="web" ${curPreset === "web" ? "selected" : ""}>${tr("高速行動平板 · 35% 面數 · 1024px JPEG", "Fast Field Tablet · 35% Tris · 1024px JPEG")}</option>
            <option value="ultra_light" ${curPreset === "ultra_light" ? "selected" : ""}>${tr("極輕量離線快取 · 20% 面數 · 768px JPEG", "Ultra-Light Offline Cache · 20% Tris · 768px JPEG")}</option>
          </select>
        </div>
        <button type="button" class="gs-top-btn accent" style="width:100%;justify-content:center;padding:8px 12px;font-weight:700;" id="btnStageCompression">
          <span>⚡ ${tr("加入壓縮設定", "Stage Compression Adjustment")}</span>
        </button>
      </div>

      ${renderStagedAdjustmentsCardHtml({ alwaysShow: true })}
      `
    );

    document.getElementById("btnStageCompression")?.addEventListener("click", () => {
      const chosen = document.getElementById("optPresetSelect")?.value || "balanced";
      if (chosen === "none") {
        st.compressionPreset = null;
        showToast(tr("已清除額外網格壓縮 · 將保留 100% 原始解析度", "Cleared extra mesh compression · 100% original resolution will be kept"));
      } else {
        st.compressionPreset = chosen;
        showToast(`${tr("已加入壓縮設定：", "Staged Compression: ")}${getCompressionPresetLabel(chosen)}`);
      }
      syncStagedEditsDockBadge();
      openMeshCompressionInspector();
    });

    bindStagedAdjustmentsCardEvents(() => openMeshCompressionInspector());
  }

  function openCoordinateSystemInspector() {
    STATE.sidePanelMinimized = false;
    const st = ensureStagedEditsForActiveScan();
    const rc = STATE.multiAlign?.active ? STATE.multiAlign?.refCenter : null;
    const scan = rc
      ? Object.assign({}, STATE.activeScan || {}, {
          twd97_e: Number(rc.x || 0),
          twd97_n: Number(rc.y || 0),
          twd97_h: Number(rc.z || 0),
          crs: "TWD97 121 + TWVD2001",
        })
      : STATE.activeScan || {};
    const curCode = inferActiveScanCrsCode(scan);
    const selectedCode = st.crsConfig?.target_crs || curCode;
    const initOffX = Number(st.crsConfig?.offset_x || 0);
    const initOffY = Number(st.crsConfig?.offset_y || 0);
    const initOffZ = Number(st.crsConfig?.offset_z || 0);

    const curE = scan.twd97_e !== undefined && scan.twd97_e !== null ? Number(scan.twd97_e) : 0;
    const curN = scan.twd97_n !== undefined && scan.twd97_n !== null ? Number(scan.twd97_n) : 0;
    const curH = scan.twd97_h !== undefined && scan.twd97_h !== null ? Number(scan.twd97_h) : 0;

    showSidePanel(
      `<span>${tr("座標系統轉換", "Coordinate System & Datum")}</span>`,
      `
      <div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);border-radius:8px;padding:11px;margin-bottom:10px;">
        <div style="font-size:12px;font-weight:700;color:var(--ui-text-primary);margin-bottom:4px;">
          🌐 ${tr("空間座標參考系統 · CRS", "Coordinate Reference System · CRS")}
        </div>
        <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;padding:7px 8px;margin-bottom:9px;line-height:1.45;">
          <div><b>${tr("目前掃描座標系：", "Current Scan CRS:")}</b> ${escapeHtml(getScanCrsDisplayLabel(scan))}</div>
          <div><b>${tr("目前中心點：", "Current Center:")}</b> X/E ${curE.toFixed(3)}m · Y/N ${curN.toFixed(3)}m · Z/H ${curH.toFixed(2)}m</div>
        </div>

        <div class="gs-form-group" style="margin-bottom:8px;">
          <label>${tr("目標座標系統", "Target Coordinate System")}</label>
          <select class="gs-select" id="selTargetCrs">
            ${CRS_UI_CATALOG.map(
              (c) => `<option value="${c.code}" ${c.code === selectedCode ? "selected" : ""}>${escapeHtml(getCrsItemFullLabel(c))}</option>`
            ).join("")}
          </select>
        </div>

        <div class="gs-form-group" style="margin-bottom:8px;">
          <label>${tr("自訂平移量 ΔX / ΔY / ΔZ · 公尺", "Optional Custom Datum Offset ΔX / ΔY / ΔZ · m")}</label>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">
            <input type="number" step="0.001" class="gs-input" id="numCrsOffsetX" value="${initOffX}" title="${tr("東距平移量 ΔX / ΔE · 公尺", "ΔX / ΔEasting · m")}" placeholder="ΔX m" />
            <input type="number" step="0.001" class="gs-input" id="numCrsOffsetY" value="${initOffY}" title="${tr("北距平移量 ΔY / ΔN · 公尺", "ΔY / ΔNorthing · m")}" placeholder="ΔY m" />
            <input type="number" step="0.001" class="gs-input" id="numCrsOffsetZ" value="${initOffZ}" title="${tr("高程平移量 ΔZ / ΔH · 公尺", "ΔZ / ΔElevation · m")}" placeholder="ΔZ m" />
          </div>
        </div>

        <div id="lblCrsTargetPreview" style="font-size:11px;color:var(--ui-accent);background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;padding:7px 8px;margin-bottom:9px;"></div>

        <button type="button" class="gs-top-btn accent" style="width:100%;justify-content:center;padding:8px 12px;font-weight:700;" id="btnStageCrs">
          <span>🌐 ${tr("加入座標系統設定", "Stage Coordinate System")}</span>
        </button>
      </div>

      ${renderStagedAdjustmentsCardHtml({ alwaysShow: true })}
      `
    );

    const updatePreviewBox = () => {
      const code = document.getElementById("selTargetCrs")?.value || curCode;
      const ox = Number(document.getElementById("numCrsOffsetX")?.value || 0);
      const oy = Number(document.getElementById("numCrsOffsetY")?.value || 0);
      const oz = Number(document.getElementById("numCrsOffsetZ")?.value || 0);
      const prev = previewTargetCrsCenterJS(scan, code, ox, oy, oz);
      const previewEl = document.getElementById("lblCrsTargetPreview");
      const stageBtn = document.getElementById("btnStageCrs");
      if (prev.error) {
        if (previewEl) {
          previewEl.innerHTML = `<span style="color:#f59e0b;font-weight:700;">⚠️ ${escapeHtml(prev.error)}</span>`;
        }
        if (stageBtn) stageBtn.disabled = true;
        return;
      }
      if (stageBtn) stageBtn.disabled = false;
      if (previewEl) {
        previewEl.innerHTML = `<b>${tr("轉換後中心座標", "New Scan Center")} · ${escapeHtml(prev.crsLabel)}:</b><br/>X/E <b>${prev.x.toFixed(
          3
        )}m</b> · Y/N <b>${prev.y.toFixed(3)}m</b> · Z/H <b>${prev.z.toFixed(2)}m</b>`;
      }
    };
    updatePreviewBox();

    ["selTargetCrs", "numCrsOffsetX", "numCrsOffsetY", "numCrsOffsetZ"].forEach((id) => {
      document.getElementById(id)?.addEventListener("input", updatePreviewBox);
      document.getElementById(id)?.addEventListener("change", updatePreviewBox);
    });

    document.getElementById("btnStageCrs")?.addEventListener("click", () => {
      const code = document.getElementById("selTargetCrs")?.value || curCode;
      const ox = Number(document.getElementById("numCrsOffsetX")?.value || 0);
      const oy = Number(document.getElementById("numCrsOffsetY")?.value || 0);
      const oz = Number(document.getElementById("numCrsOffsetZ")?.value || 0);
      const prev = previewTargetCrsCenterJS(scan, code, ox, oy, oz);
      if (prev.error) {
        showToast(prev.error);
        return;
      }
      st.crsConfig = {
        target_crs: code,
        offset_x: ox,
        offset_y: oy,
        offset_z: oz,
      };
      syncStagedEditsDockBadge();
      const item = CRS_UI_CATALOG.find((c) => c.code === code);
      openCoordinateSystemInspector();
      showToast(`${tr("已加入座標系統：", "Staged Coordinate System: ")}${item ? getCrsItemShortLabel(item) : code}`);
    });

    bindStagedAdjustmentsCardEvents(() => openCoordinateSystemInspector());
  }

  function openGenerateScanInspector() {
    STATE.sidePanelMinimized = false;
    showSidePanel(
      `<span>${tr("儲存掃描變更", "Save Scan Edits")}</span>`,
      `
      ${renderActiveScanSpecsCardHtml(STATE.activeScan)}
      <div style="font-size:11.5px;color:var(--ui-text-secondary);line-height:1.45;margin-bottom:6px;">
        ${tr(
          `可同時整合多筆<b>套索刪除</b>、<b>網格壓縮優化</b>與<b>座標系統轉換</b>，完成後點擊一次<b>儲存變更</b>即可產製新掃描，且 <b>${escapeHtml(
            STATE.activeScan?.name || STATE.activeScanId || "原始掃描"
          )}</b> 的原始備份將安全移至<b>回收桶</b>，可隨時還原。`,
          `Combine multiple <b>Lasso Deletions</b>, <b>Mesh Compression</b>, and <b>Coordinate System</b> changes, then press <b>Save Edits</b> once — your edited scan is saved and a backup of <b>${escapeHtml(
            STATE.activeScan?.name || STATE.activeScanId || "the original scan"
          )}</b> is moved to the <b>Trash Bin</b> · restorable anytime.`
        )}
      </div>
      ${renderStagedAdjustmentsCardHtml({ alwaysShow: true })}
      `
    );
    bindStagedAdjustmentsCardEvents(() => openGenerateScanInspector());
  }

  function openOptimizerInspector(preferredCropMode = null, opts = {}) {
    if (preferredCropMode === "keep_inside") {
      openLassoKeepInspector(opts);
    } else {
      openLassoDeleteInspector(opts);
    }
  }

  // =========================================================================
  // MULTI-SCAN 3D ALIGNMENT & MERGE ENGINE (Move + Rotate Gizmos + Lock + Merge)
  // =========================================================================
  const MULTI_ALIGN_PALETTE = [
    "#38bdf8", // Layer 1 Sky Blue
    "#f59e0b", // Layer 2 Amber
    "#10b981", // Layer 3 Emerald
    "#ec4899", // Layer 4 Pink
    "#a855f7", // Layer 5 Purple
    "#eab308", // Layer 6 Yellow
  ];

  const _gizmoDrag = {
    active: false,
    handleType: null, // 'tx' | 'ty' | 'tz' | 'txz' | 'rx' | 'ry' | 'rz'
    hoveredHandle: null,
    layer: null,
    startTx: 0,
    startTy: 0,
    startTz: 0,
    startRx: 0,
    startRy: 0,
    startRz: 0,
    originWorld: new THREE.Vector3(),
    axisWorld: new THREE.Vector3(),
    dragPlane: new THREE.Plane(),
    startHitPt: new THREE.Vector3(),
    startAngle: 0,
  };

  function buildStudioTransformGizmo(ctx) {
    if (!ctx || !ctx.gizmoGroup) return;
    while (ctx.gizmoGroup.children.length > 0) {
      ctx.gizmoGroup.remove(ctx.gizmoGroup.children[0]);
    }
    const handles = [];

    const makeMat = (hex, opacity = 0.95) =>
      new THREE.MeshBasicMaterial({
        color: hex,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
      });

    const makeHitMat = () =>
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.001,
        side: THREE.DoubleSide,
      });

    // Helper to build a translation arrow along +X, +Y, or +Z
    const addAxisArrow = (axisKey, hexColor, dirVec) => {
      const grp = new THREE.Group();
      grp.userData.gizmoModeGroup = "translate";
      const visMat = makeMat(hexColor, 0.96);

      const shaftGeo = new THREE.CylinderGeometry(0.032, 0.032, 0.82, 14);
      shaftGeo.translate(0, 0.41, 0);
      const shaft = new THREE.Mesh(shaftGeo, visMat);
      shaft.renderOrder = 2500;

      const coneGeo = new THREE.ConeGeometry(0.095, 0.24, 18);
      coneGeo.translate(0, 0.92, 0);
      const cone = new THREE.Mesh(coneGeo, visMat);
      cone.renderOrder = 2501;

      const hitGeo = new THREE.CylinderGeometry(0.13, 0.13, 1.08, 12);
      hitGeo.translate(0, 0.54, 0);
      const hitMesh = new THREE.Mesh(hitGeo, makeHitMat());
      hitMesh.renderOrder = 2502;
      hitMesh.userData.gizmoHandle = axisKey;
      hitMesh.userData.visualMat = visMat;
      hitMesh.userData.baseHex = hexColor;

      grp.add(shaft, cone, hitMesh);
      if (axisKey === "tx") grp.rotation.z = -Math.PI / 2;
      else if (axisKey === "tz") grp.rotation.x = Math.PI / 2;
      ctx.gizmoGroup.add(grp);
      handles.push(hitMesh);
    };

    addAxisArrow("tx", 0xef4444, new THREE.Vector3(1, 0, 0)); // +X East (Red)
    addAxisArrow("ty", 0x22c55e, new THREE.Vector3(0, 1, 0)); // +Y Up/Elev (Green)
    addAxisArrow("tz", 0x3b82f6, new THREE.Vector3(0, 0, 1)); // +Z South/North (Blue)

    // XZ Horizontal Ground Plane Slider Handle (Amber Quad)
    const xzGrp = new THREE.Group();
    xzGrp.userData.gizmoModeGroup = "translate";
    const xzVisMat = makeMat(0xf59e0b, 0.55);
    const xzGeo = new THREE.PlaneGeometry(0.28, 0.28);
    xzGeo.rotateX(-Math.PI / 2);
    xzGeo.translate(0.28, 0.01, 0.28);
    const xzQuad = new THREE.Mesh(xzGeo, xzVisMat);
    xzQuad.renderOrder = 2499;
    xzQuad.userData.gizmoHandle = "txz";
    xzQuad.userData.visualMat = xzVisMat;
    xzQuad.userData.baseHex = 0xf59e0b;
    xzGrp.add(xzQuad);
    ctx.gizmoGroup.add(xzGrp);
    handles.push(xzQuad);

    // Helper to build a 3D rotation torus ring around Y (Yaw), X (Pitch), Z (Roll)
    const addRotationRing = (handleKey, hexColor, rotX, rotY, radius = 1.15) => {
      const grp = new THREE.Group();
      grp.userData.gizmoModeGroup = "rotate";
      const visMat = makeMat(hexColor, 0.9);
      const torusGeo = new THREE.TorusGeometry(radius, 0.024, 14, 64);
      const torus = new THREE.Mesh(torusGeo, visMat);
      torus.rotation.set(rotX, rotY, 0);
      torus.renderOrder = 2500;

      const hitTorusGeo = new THREE.TorusGeometry(radius, 0.11, 10, 48);
      const hitTorus = new THREE.Mesh(hitTorusGeo, makeHitMat());
      hitTorus.rotation.set(rotX, rotY, 0);
      hitTorus.renderOrder = 2502;
      hitTorus.userData.gizmoHandle = handleKey;
      hitTorus.userData.visualMat = visMat;
      hitTorus.userData.baseHex = hexColor;

      grp.add(torus, hitTorus);
      ctx.gizmoGroup.add(grp);
      handles.push(hitTorus);
    };

    // RY (Yaw around vertical Y axis - Horizontal XZ ring, Emerald/Cyan)
    addRotationRing("ry", 0x10b981, Math.PI / 2, 0, 1.22);
    // RX (Pitch around X axis - YZ ring, Coral Red)
    addRotationRing("rx", 0xf87171, 0, Math.PI / 2, 1.08);
    // RZ (Roll around Z axis - XY ring, Sky Blue)
    addRotationRing("rz", 0x60a5fa, 0, 0, 1.15);

    // Center pivot sphere
    const centerMat = makeMat(0xffffff, 0.95);
    const centerSphere = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 16), centerMat);
    centerSphere.renderOrder = 2505;
    ctx.gizmoGroup.add(centerSphere);
    ctx.gizmoGroup.userData.handles = handles;
    ctx.gizmoGroup.userData.centerMat = centerMat;
  }

  function getSelectedMultiAlignLayer() {
    if (!STATE.multiAlign.active || !STATE.multiAlign.layers.length) return null;
    return (
      STATE.multiAlign.layers.find((l) => l.scan_id === STATE.multiAlign.selectedScanId) ||
      STATE.multiAlign.layers[0]
    );
  }

  function updateStudioTransformGizmo() {
    if (!studioThree || !studioThree.gizmoGroup) return;
    const layer = getSelectedMultiAlignLayer();
    const shouldShow = Boolean(
      STATE.multiAlign.active &&
        STATE.activeTool === "align_merge" &&
        layer &&
        layer.visible &&
        layer.layerGroup
    );
    studioThree.gizmoGroup.visible = shouldShow;
    if (!shouldShow) return;

    studioThree.gizmoGroup.position.copy(layer.layerGroup.position);
    const dist = Math.max(2.0, studioThree.camera.position.distanceTo(studioThree.gizmoGroup.position));
    const scale = dist * 0.16;
    studioThree.gizmoGroup.scale.setScalar(scale);

    const mode = STATE.multiAlign.gizmoMode || "both";
    studioThree.gizmoGroup.children.forEach((child) => {
      const mGrp = child.userData?.gizmoModeGroup;
      if (mGrp === "translate") {
        child.visible = mode === "both" || mode === "translate";
      } else if (mGrp === "rotate") {
        child.visible = mode === "both" || mode === "rotate";
      }
    });

    if (studioThree.gizmoGroup.userData.centerMat) {
      studioThree.gizmoGroup.userData.centerMat.color.setHex(layer.locked ? 0xf59e0b : 0xffffff);
    }

    // Highlight active layer bounding box
    STATE.multiAlign.layers.forEach((l) => {
      if (l.boxHelper) {
        l.boxHelper.visible = l.visible && l.scan_id === layer.scan_id;
      }
    });
  }

  function pickGizmoHandle(clientX, clientY) {
    if (!studioThree || !studioThree.gizmoGroup || !studioThree.gizmoGroup.visible) return null;
    const rect = studioThree.renderer.domElement.getBoundingClientRect();
    studioThree.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    studioThree.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    studioThree.raycaster.setFromCamera(studioThree.mouse, studioThree.camera);

    const activeHandles = (studioThree.gizmoGroup.userData.handles || []).filter(
      (h) => h.parent && h.parent.visible
    );
    const hits = studioThree.raycaster.intersectObjects(activeHandles, false);
    return hits.length > 0 ? hits[0].object : null;
  }

  function handleGizmoPointerDown(e) {
    if (e.button !== 0) return false;
    const hitObj = pickGizmoHandle(e.clientX, e.clientY);
    if (!hitObj) return false;

    const layer = getSelectedMultiAlignLayer();
    if (!layer) return false;
    if (layer.locked) {
      showToast(`"${layer.name}" is locked 🔒 — click Unlock before moving or rotating.`);
      return true;
    }

    const handleType = hitObj.userData.gizmoHandle;
    _gizmoDrag.active = true;
    _gizmoDrag.handleType = handleType;
    _gizmoDrag.layer = layer;
    _gizmoDrag.startTx = layer.tx;
    _gizmoDrag.startTy = layer.ty;
    _gizmoDrag.startTz = layer.tz;
    _gizmoDrag.startRx = layer.rx_deg;
    _gizmoDrag.startRy = layer.ry_deg;
    _gizmoDrag.startRz = layer.rz_deg;
    _gizmoDrag.originWorld.copy(layer.layerGroup.position);

    const camDir = new THREE.Vector3();
    studioThree.camera.getWorldDirection(camDir);

    if (handleType === "tx" || handleType === "ty" || handleType === "tz") {
      const axis =
        handleType === "tx"
          ? new THREE.Vector3(1, 0, 0)
          : handleType === "ty"
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(0, 0, 1);
      _gizmoDrag.axisWorld.copy(axis);
      // Plane containing the translation axis and facing the camera as closely as possible
      const ortho = new THREE.Vector3().crossVectors(axis, camDir);
      let planeNormal = new THREE.Vector3().crossVectors(ortho, axis).normalize();
      if (planeNormal.lengthSq() < 1e-4) {
        planeNormal.copy(camDir).negate();
      }
      _gizmoDrag.dragPlane.setFromNormalAndCoplanarPoint(planeNormal, _gizmoDrag.originWorld);
      studioThree.raycaster.ray.intersectPlane(_gizmoDrag.dragPlane, _gizmoDrag.startHitPt);
    } else if (handleType === "txz") {
      _gizmoDrag.dragPlane.setFromNormalAndCoplanarPoint(
        new THREE.Vector3(0, 1, 0),
        _gizmoDrag.originWorld
      );
      studioThree.raycaster.ray.intersectPlane(_gizmoDrag.dragPlane, _gizmoDrag.startHitPt);
    } else if (handleType === "rx" || handleType === "ry" || handleType === "rz") {
      const axis =
        handleType === "rx"
          ? new THREE.Vector3(1, 0, 0)
          : handleType === "ry"
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(0, 0, 1);
      _gizmoDrag.axisWorld.copy(axis);
      _gizmoDrag.dragPlane.setFromNormalAndCoplanarPoint(axis, _gizmoDrag.originWorld);
      if (studioThree.raycaster.ray.intersectPlane(_gizmoDrag.dragPlane, _gizmoDrag.startHitPt)) {
        const rel = _gizmoDrag.startHitPt.clone().sub(_gizmoDrag.originWorld);
        if (handleType === "ry") _gizmoDrag.startAngle = Math.atan2(rel.x, rel.z);
        else if (handleType === "rx") _gizmoDrag.startAngle = Math.atan2(rel.z, rel.y);
        else _gizmoDrag.startAngle = Math.atan2(rel.y, rel.x);
      }
    }

    studioThree.controls.enabled = false;
    studioThree.renderer.domElement.style.cursor = "grabbing";
    return true;
  }

  function handleGizmoPointerMove(e) {
    if (!studioThree) return false;
    if (!_gizmoDrag.active) {
      const hitObj = pickGizmoHandle(e.clientX, e.clientY);
      if (_gizmoDrag.hoveredHandle && _gizmoDrag.hoveredHandle !== hitObj) {
        const prevMat = _gizmoDrag.hoveredHandle.userData.visualMat;
        if (prevMat) prevMat.color.setHex(_gizmoDrag.hoveredHandle.userData.baseHex);
      }
      _gizmoDrag.hoveredHandle = hitObj;
      if (hitObj) {
        const layer = getSelectedMultiAlignLayer();
        if (layer?.locked) {
          studioThree.renderer.domElement.style.cursor = "not-allowed";
        } else {
          if (hitObj.userData.visualMat) hitObj.userData.visualMat.color.setHex(0xffffff);
          studioThree.renderer.domElement.style.cursor = "grab";
        }
      } else {
        studioThree.renderer.domElement.style.cursor = "";
      }
      return false;
    }

    const rect = studioThree.renderer.domElement.getBoundingClientRect();
    studioThree.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    studioThree.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    studioThree.raycaster.setFromCamera(studioThree.mouse, studioThree.camera);

    const curHit = new THREE.Vector3();
    if (!studioThree.raycaster.ray.intersectPlane(_gizmoDrag.dragPlane, curHit)) return true;

    const layer = _gizmoDrag.layer;
    if (!layer || layer.locked) return true;
    const h = _gizmoDrag.handleType;
    const snapPos = e.shiftKey ? 0.25 : STATE.snapEnabled ? 0.05 : 0.01;
    const snapDeg = e.shiftKey ? 5.0 : STATE.snapEnabled ? 0.5 : 0.1;

    if (h === "tx" || h === "ty" || h === "tz") {
      const deltaVec = curHit.clone().sub(_gizmoDrag.startHitPt);
      const deltaScalar = deltaVec.dot(_gizmoDrag.axisWorld);
      const q = Math.round(deltaScalar / snapPos) * snapPos;
      if (h === "tx") layer.tx = Number((_gizmoDrag.startTx + q).toFixed(2));
      else if (h === "ty") layer.ty = Number((_gizmoDrag.startTy + q).toFixed(2));
      else if (h === "tz") layer.tz = Number((_gizmoDrag.startTz + q).toFixed(2));
    } else if (h === "txz") {
      const deltaVec = curHit.clone().sub(_gizmoDrag.startHitPt);
      const qx = Math.round(deltaVec.x / snapPos) * snapPos;
      const qz = Math.round(deltaVec.z / snapPos) * snapPos;
      layer.tx = Number((_gizmoDrag.startTx + qx).toFixed(2));
      layer.tz = Number((_gizmoDrag.startTz + qz).toFixed(2));
    } else if (h === "rx" || h === "ry" || h === "rz") {
      const rel = curHit.clone().sub(_gizmoDrag.originWorld);
      let curAngle = 0;
      if (h === "ry") curAngle = Math.atan2(rel.x, rel.z);
      else if (h === "rx") curAngle = Math.atan2(rel.z, rel.y);
      else curAngle = Math.atan2(rel.y, rel.x);

      let diffRad = curAngle - _gizmoDrag.startAngle;
      while (diffRad > Math.PI) diffRad -= Math.PI * 2;
      while (diffRad < -Math.PI) diffRad += Math.PI * 2;
      const diffDeg = THREE.MathUtils.radToDeg(diffRad);
      const qDeg = Math.round(diffDeg / snapDeg) * snapDeg;

      const normDeg = (d) => {
        let v = ((d + 180) % 360 + 360) % 360 - 180;
        return Number(v.toFixed(1));
      };
      if (h === "ry") layer.ry_deg = normDeg(_gizmoDrag.startRy + qDeg);
      else if (h === "rx") layer.rx_deg = normDeg(_gizmoDrag.startRx - qDeg);
      else if (h === "rz") layer.rz_deg = normDeg(_gizmoDrag.startRz + qDeg);
    }

    layer._userMoved = true;
    applyLayerTransformTo3D(layer);
    syncAlignLayerInputsInDOM(layer);
    return true;
  }

  function handleGizmoPointerUp() {
    if (!_gizmoDrag.active) return false;
    _gizmoDrag.active = false;
    _gizmoDrag.handleType = null;
    if (studioThree) {
      studioThree.controls.enabled = true;
      studioThree.renderer.domElement.style.cursor = "";
      if (countMarkedRegionsPending() > 0) {
        rebuildLassoHighlight3D();
      }
    }
    return true;
  }

  function handleMultiAlignCanvasClick(e) {
    if (!studioThree || !STATE.multiAlign.active || STATE.activeTool !== "align_merge") return false;
    if (pickGizmoHandle(e.clientX, e.clientY)) return true;

    const rect = studioThree.renderer.domElement.getBoundingClientRect();
    studioThree.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    studioThree.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    studioThree.raycaster.setFromCamera(studioThree.mouse, studioThree.camera);

    const meshTargets = [];
    STATE.multiAlign.layers.forEach((layer) => {
      if (!layer.visible || !layer.layerGroup) return;
      layer.layerGroup.traverse((c) => {
        if (c.isMesh && c.visible && !c.userData?.isAlignBoxHelper) {
          c.userData._alignScanId = layer.scan_id;
          meshTargets.push(c);
        }
      });
    });

    const hits = studioThree.raycaster.intersectObjects(meshTargets, false);
    if (hits.length > 0) {
      const hitScanId = hits[0].object.userData?._alignScanId;
      if (hitScanId && hitScanId !== STATE.multiAlign.selectedScanId) {
        STATE.multiAlign.selectedScanId = hitScanId;
        updateStudioTransformGizmo();
        renderAlignMergeInspectorContent();
        const picked = STATE.multiAlign.layers.find((l) => l.scan_id === hitScanId);
        if (picked) showToast(`Selected "${picked.name}" for 3D Gizmo alignment`);
        return true;
      }
    }
    return false;
  }

  function applyLayerTransformTo3D(layer) {
    if (!layer || !layer.layerGroup) return;
    layer.layerGroup.position.set(
      Number(layer.tx) || 0,
      Number(layer.ty) || 0,
      Number(layer.tz) || 0
    );
    layer.layerGroup.rotation.set(
      THREE.MathUtils.degToRad(Number(layer.rx_deg) || 0),
      THREE.MathUtils.degToRad(Number(layer.ry_deg) || 0),
      THREE.MathUtils.degToRad(Number(layer.rz_deg) || 0),
      "XYZ"
    );
    layer.layerGroup.updateMatrixWorld(true);
    updateStudioTransformGizmo();
    if (!_gizmoDrag.active && studioThree && typeof scheduleScanGoogleMapCoverageUpdate === "function") {
      scheduleScanGoogleMapCoverageUpdate(studioThree, STATE.activeScan, 120);
    }
    if (!_gizmoDrag.active && studioThree && countMarkedRegionsPending() > 0) {
      if (studioThree._lassoRebuildTimer) clearTimeout(studioThree._lassoRebuildTimer);
      studioThree._lassoRebuildTimer = setTimeout(() => {
        rebuildLassoHighlight3D();
      }, 60);
    }
  }

  function syncAlignLayerInputsInDOM(layer) {
    if (!layer) return;
    const fields = ["tx", "ty", "tz", "rx_deg", "ry_deg", "rz_deg"];
    fields.forEach((f) => {
      const inp = document.querySelector(
        `.align-num-input[data-scan-id="${layer.scan_id}"][data-field="${f}"]`
      );
      if (inp && document.activeElement !== inp) {
        inp.value = f.endsWith("_deg") ? Number(layer[f] || 0).toFixed(1) : Number(layer[f] || 0).toFixed(2);
      }
    });
    const lbl = document.getElementById("lblLastPickedCoord");
    if (lbl) {
      lbl.textContent = `ALIGN [${layer.name}]: ΔX=${layer.tx.toFixed(2)}m, ΔY=${layer.ty.toFixed(2)}m, ΔZ=${layer.tz.toFixed(2)}m | Yaw=${layer.ry_deg.toFixed(1)}°, Pitch=${layer.rx_deg.toFixed(1)}°, Roll=${layer.rz_deg.toFixed(1)}°`;
    }
  }

  function updateMultiAlignLayersEachFrame() {
    if (!studioThree || !STATE.multiAlign.active) return;
    const showAlignBoxes = STATE.activeTool === "align_merge";
    STATE.multiAlign.layers.forEach((layer) => {
      if (layer.boxHelper) {
        layer.boxHelper.visible = Boolean(layer.visible && showAlignBoxes);
      }
      if (!layer.visible) return;
      if (layer.tilesRenderer) {
        layer.tilesRenderer.update();
        const tintKey = `${STATE.scanBrightness}_${layer.tintEnabled ? layer.color : "none"}`;
        layer.tilesRenderer.group.traverse((child) => {
          if (child.isMesh && child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((m) => {
              if (!m) return;
              if (m.metalness > 0) {
                m.metalness = 0.0;
                m.roughness = 1.0;
                m.side = THREE.DoubleSide;
                m.needsUpdate = true;
              }
              if (m.userData?._lastAlignTint !== tintKey) {
                applyBrightnessToMaterial(m, STATE.scanBrightness);
                if (layer.tintEnabled && m.color) {
                  const tintCol = new THREE.Color(layer.color);
                  m.color.lerp(tintCol, 0.35);
                }
                m.userData._lastAlignTint = tintKey;
              }
            });
          }
        });
      }
    });
  }

  function addScanLayerToMultiAlign(scanId, options = {}) {
    initStudio3D();
    const scan = STATE.scans.find((s) => s.scan_id === scanId);
    if (!scan || !studioThree) return null;

    const existing = STATE.multiAlign.layers.find((l) => l.scan_id === scanId);
    if (existing) {
      STATE.multiAlign.selectedScanId = existing.scan_id;
      updateStudioTransformGizmo();
      return existing;
    }

    const idx = STATE.multiAlign.layers.length;
    const color = MULTI_ALIGN_PALETTE[idx % MULTI_ALIGN_PALETTE.length];

    const layerGroup = new THREE.Group();
    const zUpGroup = new THREE.Group();
    zUpGroup.rotation.set(THREE.MathUtils.degToRad(270), 0, 0);
    layerGroup.add(zUpGroup);
    studioThree.multiAlignGroup.add(layerGroup);

    const layer = {
      scan_id: scan.scan_id,
      name: scan.name,
      project_group: scan.project_group || "Unassigned Site",
      color,
      visible: true,
      locked: false,
      tintEnabled: Boolean(options.tintEnabled),
      tx: Number(options.tx) || 0,
      ty: Number(options.ty) || 0,
      tz: Number(options.tz) || 0,
      rx_deg: Number(options.rx_deg) || 0,
      ry_deg: Number(options.ry_deg) || 0,
      rz_deg: Number(options.rz_deg) || 0,
      _userMoved: Boolean(options.userMoved),
      layerGroup,
      zUpGroup,
      tilesRenderer: null,
      rawCenter: null,
      boxHelper: null,
      ready: false,
    };

    STATE.multiAlign.layers.push(layer);
    STATE.multiAlign.selectedScanId = layer.scan_id;

    const syncLayerRelativeOffset = (targetLayer) => {
      if (!targetLayer || !targetLayer.rawCenter || targetLayer._userMoved || !STATE.multiAlign.refCenter) return;
      if (STATE.multiAlign.layers[0]?.scan_id === targetLayer.scan_id) return;
      const ref = STATE.multiAlign.refCenter;
      const dx = targetLayer.rawCenter.x - ref.x;
      const dy = targetLayer.rawCenter.z - ref.z;
      const dz = -(targetLayer.rawCenter.y - ref.y);
      const dist3D = Math.hypot(dx, dy, dz);
      if (dist3D > 0.3 && dist3D < 400) {
        targetLayer.tx = Number(dx.toFixed(2));
        targetLayer.ty = Number(dy.toFixed(2));
        targetLayer.tz = Number(dz.toFixed(2));
      } else if (dist3D >= 400) {
        const myIdx = STATE.multiAlign.layers.indexOf(targetLayer);
        targetLayer.tx = Number((Math.max(1, myIdx) * 14).toFixed(2));
        targetLayer.ty = 0;
        targetLayer.tz = 0;
      } else {
        targetLayer.tx = 0;
        targetLayer.ty = 0;
        targetLayer.tz = 0;
      }
      applyLayerTransformTo3D(targetLayer);
      syncAlignLayerInputsInDOM(targetLayer);
    };

    const finalizeLoadedMultiAlignLayer = (sphere) => {
      layer.rawCenter = { x: sphere.center.x, y: sphere.center.y, z: sphere.center.z };
      layer._sphereRadius = sphere.radius || 38;
      layer.ready = true;

      if (STATE.multiAlign.layers[0]?.scan_id === layer.scan_id || !STATE.multiAlign.refCenter) {
        STATE.multiAlign.refCenter = { ...layer.rawCenter };
        STATE.multiAlign.layers.forEach((other) => {
          if (other !== layer && other.ready) syncLayerRelativeOffset(other);
        });
      } else {
        syncLayerRelativeOffset(layer);
      }

      if (!layer.boxHelper) {
        const r = Math.max(4, Math.min(45, (sphere.radius || 20) * 0.45));
        const boxGeo = new THREE.BoxGeometry(r * 1.4, r * 0.55, r * 1.4);
        const edges = new THREE.EdgesGeometry(boxGeo);
        const lineMat = new THREE.LineBasicMaterial({
          color: new THREE.Color(layer.color),
          transparent: true,
          opacity: 0.75,
        });
        const boxHelper = new THREE.LineSegments(edges, lineMat);
        boxHelper.userData.isAlignBoxHelper = true;
        layerGroup.add(boxHelper);
        layer.boxHelper = boxHelper;
      }

      applyLayerTransformTo3D(layer);
      syncAlignLayerInputsInDOM(layer);
    };

    const streamUrl = scan.stream_url || `/stream/${scan.scan_id}/tileset.json`;
    const isGlbStream = scan.stream_type === "glb" || streamUrl.toLowerCase().endsWith(".glb");
    if (window.TilesRenderer && !isGlbStream) {
      const tr = new window.TilesRenderer(streamUrl);
      tr.fetchOptions = { mode: "cors" };
      tr.preprocessURL = (uri) => preprocessTileStreamUrl(uri, streamUrl);
      tr.setCamera(studioThree.camera);
      tr.setResolutionFromRenderer(studioThree.camera, studioThree.renderer);

      const gltfLoader = new THREE.GLTFLoader(tr.manager);
      if (window.MeshoptDecoder) gltfLoader.setMeshoptDecoder(window.MeshoptDecoder);
      const ktx2 = getKTX2Loader(studioThree.renderer);
      if (ktx2) gltfLoader.setKTX2Loader(ktx2);
      tr.manager.addHandler(/\.(gltf|glb)(\?.*)?$/i, gltfLoader);

      tr.addEventListener("load-tileset", () => {
        if (layer.tilesRenderer !== tr) return;
        if (tr._rootCentered) return;
        tr._rootCentered = true;
        const sphere = new THREE.Sphere();
        if (computeTilesetContentSphere(tr, sphere)) {
          tr.group.position.set(-sphere.center.x, -sphere.center.y, -sphere.center.z);
          finalizeLoadedMultiAlignLayer(sphere);
        }
        studioThree.camera.updateMatrixWorld();
        tr.update();
      });

      tr.addEventListener("load-model", (ev) => {
        if (layer.tilesRenderer !== tr) return;
        if (ev && ev.scene) {
          ev.scene.traverse((c) => {
            if (c.isMesh && c.material) {
              const mats = Array.isArray(c.material) ? c.material : [c.material];
              mats.forEach((m) => applyBrightnessToMaterial(m, STATE.scanBrightness));
            }
          });
          studioThree.camera.updateMatrixWorld();
          tr.update();
          if (STATE.multiAlign?.active && hasStagedMeshEditsForActiveScan()) {
            applyStagedEditsToStudioMeshes(false);
          }
          if (typeof scheduleScanGoogleMapCoverageUpdate === "function") {
            scheduleScanGoogleMapCoverageUpdate(studioThree, STATE.activeScan, 120);
          }
          if (studioThree.renderer && studioThree.scene && studioThree.camera) {
            studioThree.renderer.render(studioThree.scene, studioThree.camera);
          }
          if (
            STATE.multiAlign?.active &&
            ((Array.isArray(STATE.lassoStrokes) && STATE.lassoStrokes.length > 0) ||
              (Array.isArray(STATE.pendingCropPolygons) && STATE.pendingCropPolygons.length > 0) ||
              (Array.isArray(STATE.cropPolygonPoints) && STATE.cropPolygonPoints.length >= 3))
          ) {
            if (studioThree._lassoRebuildTimer) clearTimeout(studioThree._lassoRebuildTimer);
            studioThree._lassoRebuildTimer = setTimeout(() => {
              rebuildLassoHighlight3D();
            }, 90);
          }
        }
      });

      if (typeof configureTilesRendererLodAndCaps === "function") {
        configureTilesRendererLodAndCaps(tr, "auto", "align");
      } else {
        tr.errorTarget = 6.0;
      }
      zUpGroup.add(tr.group);
      layer.tilesRenderer = tr;
      studioThree.camera.updateMatrixWorld();
      tr.update();
    } else if (isGlbStream && THREE.GLTFLoader) {
      const gltfLoader = new THREE.GLTFLoader();
      if (window.MeshoptDecoder) gltfLoader.setMeshoptDecoder(window.MeshoptDecoder);
      const ktx2 = getKTX2Loader(studioThree.renderer);
      if (ktx2) gltfLoader.setKTX2Loader(ktx2);
      gltfLoader.load(
        streamUrl,
        (gltf) => {
          const model = gltf.scene;
          // zUpGroup has rotation.x = 270 deg; rotate Y-up GLB +90 deg X so it renders upright inside zUpGroup
          model.rotation.x = Math.PI * 0.5;
          model.updateMatrixWorld(true);
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
          zUpGroup.add(model);
          const metaE = Number(scan.twd97_e || 0);
          const metaN = Number(scan.twd97_n || 0);
          const metaH = Number(scan.twd97_h || 0);
          const worldSphere = new THREE.Sphere(
            new THREE.Vector3(
              metaE || sphere.center.x,
              metaN || sphere.center.y,
              metaH || sphere.center.z
            ),
            sphere.radius || 38
          );
          finalizeLoadedMultiAlignLayer(worldSphere);
          if (STATE.multiAlign?.active && hasStagedMeshEditsForActiveScan()) {
            applyStagedEditsToStudioMeshes(false);
          }
          if (typeof scheduleScanGoogleMapCoverageUpdate === "function") {
            scheduleScanGoogleMapCoverageUpdate(studioThree, STATE.activeScan, 120);
          }
          if (studioThree.renderer && studioThree.scene && studioThree.camera) {
            studioThree.renderer.render(studioThree.scene, studioThree.camera);
          }
          if (STATE.multiAlign?.active && countMarkedRegionsPending() > 0) {
            if (studioThree._lassoRebuildTimer) clearTimeout(studioThree._lassoRebuildTimer);
            studioThree._lassoRebuildTimer = setTimeout(() => {
              rebuildLassoHighlight3D();
            }, 90);
          }
        },
        undefined,
        (err) => {
          console.warn("[GatheringScans] Multi-Align GLB layer load failed:", err);
        }
      );
    }

    syncStagedEditsDockBadge();
    applyLayerTransformTo3D(layer);
    return layer;
  }

  function removeScanLayerFromMultiAlign(scanId) {
    const idx = STATE.multiAlign.layers.findIndex((l) => l.scan_id === scanId);
    if (idx === -1) return;
    const layer = STATE.multiAlign.layers[idx];
    if (layer.tilesRenderer) {
      layer.zUpGroup.remove(layer.tilesRenderer.group);
      layer.tilesRenderer.dispose();
    }
    if (studioThree && studioThree.multiAlignGroup && layer.layerGroup) {
      studioThree.multiAlignGroup.remove(layer.layerGroup);
    }
    STATE.multiAlign.layers.splice(idx, 1);
    if (STATE.multiAlign.selectedScanId === scanId) {
      STATE.multiAlign.selectedScanId = STATE.multiAlign.layers[0]?.scan_id || null;
    }
    if (STATE.multiAlign.layers.length > 0 && STATE.multiAlign.layers[0].rawCenter) {
      STATE.multiAlign.refCenter = { ...STATE.multiAlign.layers[0].rawCenter };
    }
    syncStagedEditsDockBadge();
    updateStudioTransformGizmo();
  }

  function enterMultiScanAlignMode() {
    initStudio3D();
    if (!studioThree) return;
    if (STATE.multiAlign?.active) {
      syncMultiAlignToolAvailability();
      syncStagedEditsDockBadge();
      updateStudioTransformGizmo();
      return;
    }

    // Preserve any active Lasso strokes, locked polygons, unclosed >=3pt polygon, and staged edits
    // from Single-Scan mode so switching to Align & Merge NEVER discards selected polygons!
    preserveLassoSelectionBeforeToolSwitch();
    const anchorScanId = STATE.activeScanId || STATE.activeScan?.scan_id || "";
    const anchorZUpMat = new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(270));
    const tcSingle = Array.isArray(studioThree.tilesCenter) ? studioThree.tilesCenter.slice() : [0, 0, 0];

    const upgradeStrokeToAnchorLayer = (stObj) => {
      if (!stObj || !anchorScanId) return stObj;
      if (stObj.layer_zup_to_clip && stObj.layer_zup_to_clip[anchorScanId]) return stObj;
      if (Array.isArray(stObj.view_proj_matrix) && stObj.view_proj_matrix.length === 16) {
        const vpMat = new THREE.Matrix4().fromArray(stObj.view_proj_matrix);
        const lMat = new THREE.Matrix4().multiplyMatrices(vpMat, anchorZUpMat);
        stObj.layer_zup_to_clip = Object.assign({}, stObj.layer_zup_to_clip || {}, {
          [anchorScanId]: Array.from(lMat.elements),
        });
      }
      return stObj;
    };

    if (Array.isArray(STATE.lassoStrokes) && STATE.lassoStrokes.length > 0 && anchorScanId) {
      STATE.lassoStrokes.forEach((s) => upgradeStrokeToAnchorLayer(s));
    }
    if (STATE.cropMode === "keep_inside") {
      STATE.cropMode = "delete_inside";
    }

    const prevSingleStaged =
      STATE.stagedEdits && anchorScanId && STATE.stagedEdits.scanId === anchorScanId
        ? {
            deletions: Array.isArray(STATE.stagedEdits.deletions)
              ? STATE.stagedEdits.deletions.map((b) => {
                  const cloned = JSON.parse(JSON.stringify(b));
                  if (Array.isArray(cloned.frustum_strokes)) {
                    cloned.frustum_strokes.forEach((s) => upgradeStrokeToAnchorLayer(s));
                  }
                  if (
                    (!cloned.layer_centered_polygons || !cloned.layer_centered_polygons[anchorScanId]) &&
                    Array.isArray(cloned.native_polygons) &&
                    cloned.native_polygons.length > 0
                  ) {
                    cloned.layer_centered_polygons = Object.assign({}, cloned.layer_centered_polygons || {}, {
                      [anchorScanId]: cloned.native_polygons.map((poly) =>
                        poly.map((pt) => [Number(pt[0]) - (Number(tcSingle[0]) || 0), Number(pt[1]) - (Number(tcSingle[1]) || 0)])
                      ),
                    });
                  }
                  return cloned;
                })
              : [],
            compressionPreset: STATE.stagedEdits.compressionPreset || null,
            crsConfig: STATE.stagedEdits.crsConfig ? { ...STATE.stagedEdits.crsConfig } : null,
          }
        : null;

    restoreOriginalStudioMeshIndices();
    STATE.multiAlign.active = true;
    resetStagedEditsForScan(STATE.activeScan);
    if (prevSingleStaged) {
      if (prevSingleStaged.deletions.length > 0) {
        STATE.stagedEdits.deletions = prevSingleStaged.deletions;
        STATE.stagedEdits.rev = (STATE.stagedEdits.rev || 0) + 1;
      }
      if (prevSingleStaged.compressionPreset) {
        STATE.stagedEdits.compressionPreset = prevSingleStaged.compressionPreset;
      }
      if (prevSingleStaged.crsConfig) {
        STATE.stagedEdits.crsConfig = prevSingleStaged.crsConfig;
      }
    }

    studioThree.modelPivot.visible = false;
    if (studioThree.fallbackGroup) studioThree.fallbackGroup.visible = false;
    studioThree.multiAlignGroup.visible = true;

    if (STATE.multiAlign.layers.length === 0 && STATE.activeScanId) {
      // Only include the currently active Studio scan as the starting anchor (#1);
      // the user selects which additional scans to import from the checklist in the panel.
      addScanLayerToMultiAlign(STATE.activeScanId);
    }
    if (hasStagedMeshEditsForActiveScan()) {
      applyStagedEditsToStudioMeshes(true);
    }
    if (countMarkedRegionsPending() > 0) {
      if (studioThree._lassoRebuildTimer) clearTimeout(studioThree._lassoRebuildTimer);
      studioThree._lassoRebuildTimer = setTimeout(() => {
        rebuildLassoHighlight3D();
      }, 110);
    }
    syncMultiAlignToolAvailability();
    syncStagedEditsDockBadge();
    updateStudioTransformGizmo();
  }

  function exitMultiScanAlignMode(reloadActive = true) {
    if (!studioThree) return;
    _gizmoDrag.active = false;
    clearLassoSelectionState();
    restoreOriginalStudioMeshIndices();
    STATE.multiAlign.layers.slice().forEach((l) => removeScanLayerFromMultiAlign(l.scan_id));
    STATE.multiAlign.active = false;
    STATE.multiAlign.selectedScanId = null;
    STATE.multiAlign.refCenter = null;
    resetStagedEditsForScan(STATE.activeScan);
    syncMultiAlignToolAvailability();
    if (studioThree.multiAlignGroup) studioThree.multiAlignGroup.visible = false;
    if (studioThree.gizmoGroup) studioThree.gizmoGroup.visible = false;
    studioThree.modelPivot.visible = true;
    studioThree.controls.enabled = true;
    if (reloadActive && STATE.activeScanId) {
      loadScanIntoStudio(STATE.activeScanId);
    }
  }

  function renderAlignMergeInspectorContent() {
    const layers = STATE.multiAlign.layers;
    const allLocked = layers.length >= 2 && layers.every((l) => l.locked);
    const lockedCount = layers.filter((l) => l.locked).length;
    const curSite =
      STATE.activeScan?.project_group ||
      (STATE.activeProjectGroup && STATE.activeProjectGroup !== "__all__" ? STATE.activeProjectGroup : "") ||
      STATE.scans[0]?.project_group ||
      "Unassigned Site";
    const pickerProject = STATE.multiAlign.pickerProjectGroup || curSite;
    const defaultMergedName = tr(
      `${curSite} — 整合合併掃描 · ${Math.max(2, layers.length)} 組掃描`,
      `${curSite} — Unified Merged Scan · ${Math.max(2, layers.length)} Scans`
    );

    const allProjectNames = Array.from(
      new Set(STATE.scans.map((s) => s.project_group || "Default"))
    ).sort();
    const projectFilterOptionsHtml = [
      `<option value="__all__" ${pickerProject === "__all__" ? "selected" : ""}>${tr(`全部工區 · ${STATE.scans.length} 組掃描`, `All Projects · ${STATE.scans.length} Scans`)}</option>`,
      ...allProjectNames.map((pg) => {
        const cnt = STATE.scans.filter((s) => (s.project_group || "Default") === pg).length;
        return `<option value="${escapeHtml(pg)}" ${pickerProject === pg ? "selected" : ""}>${escapeHtml(pg)} · ${tr(`${cnt} 組掃描`, `${cnt} Scan${cnt === 1 ? "" : "s"}`)}</option>`;
      }),
    ].join("");

    const candidateScans = STATE.scans
      .filter((s) => pickerProject === "__all__" || (s.project_group || "Default") === pickerProject)
      .sort((a, b) => String(a.name || a.scan_id).localeCompare(String(b.name || b.scan_id)));

    if (!STATE.multiAlign.checkedScanIds) {
      STATE.multiAlign.checkedScanIds = new Set();
    }

    const scanChecklistRowsHtml = candidateScans
      .map((s) => {
        const loadedIdx = layers.findIndex((l) => l.scan_id === s.scan_id);
        const isLoaded = loadedIdx !== -1;
        const loadedLayer = isLoaded ? layers[loadedIdx] : null;
        const isChecked = !isLoaded && STATE.multiAlign.checkedScanIds.has(s.scan_id);
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 7px;border-radius:6px;background:${
            isLoaded
              ? "rgba(56,189,248,0.10)"
              : isChecked
              ? "var(--ui-accent-soft)"
              : "var(--ui-bg-surface)"
          };border:1px solid ${
            isLoaded
              ? escapeHtml(loadedLayer.color)
              : isChecked
              ? "var(--ui-accent)"
              : "var(--ui-border)"
          };">
            <label style="display:flex;align-items:center;gap:7px;min-width:0;flex:1;cursor:pointer;margin:0;">
              ${
                isLoaded
                  ? `<span style="width:12px;height:12px;border-radius:50%;background:${loadedLayer.color};display:inline-block;flex-shrink:0;" title="${tr("已載入至 3D 視景", "Loaded in 3D View")}"></span>`
                  : `<input type="checkbox" class="chk-align-pick-scan" data-scan-id="${escapeHtml(s.scan_id)}" ${
                      isChecked ? "checked" : ""
                    } style="accent-color:var(--ui-accent);width:14px;height:14px;margin:0;flex-shrink:0;cursor:pointer;" />`
              }
              <div style="min-width:0;flex:1;">
                <div style="font-size:11.5px;font-weight:600;color:var(--ui-text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${escapeHtml(s.name || s.scan_id)}
                </div>
                <div style="font-size:10px;color:var(--ui-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${escapeHtml(s.project_group || "")}${s.capture_date ? ` · ${escapeHtml(s.capture_date)}` : ""}
                </div>
              </div>
            </label>
            ${
              isLoaded
                ? `<span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:rgba(16,185,129,0.16);color:#10b981;flex-shrink:0;">#${
                    loadedIdx + 1
                  }${loadedIdx === 0 ? tr(" 基準", " Anchor") : tr(" 已載入", " Loaded")}</span>
                   <button type="button" class="gs-top-btn btn-align-remove" data-scan-id="${escapeHtml(
                     s.scan_id
                   )}" style="padding:1px 6px;font-size:10px;flex-shrink:0;" title="${tr("從 3D 對齊檢視移除", "Remove from 3D alignment view")}">✕</button>`
                : `<button type="button" class="gs-top-btn btn-align-quick-add" data-scan-id="${escapeHtml(
                    s.scan_id
                  )}" style="padding:2px 7px;font-size:10.5px;flex-shrink:0;" title="${tr("將此掃描加入 3D 對齊檢視", "Add this scan to 3D alignment view")}">${tr("+ 加入", "+ Add")}</button>`
            }
          </div>
        `;
      })
      .join("");

    const checkedCount = candidateScans.filter(
      (s) => !layers.some((l) => l.scan_id === s.scan_id) && STATE.multiAlign.checkedScanIds.has(s.scan_id)
    ).length;

    const layerCardsHtml =
      layers.length === 0
        ? `<div style="padding:12px;border:1px dashed var(--ui-border-strong);border-radius:8px;text-align:center;font-size:11.5px;color:var(--ui-text-secondary);">
            ${tr("目前 3D 檢視尚無掃描圖層。請勾選上方掃描並點擊 <b>+ 加入所選掃描</b>。", "No scan layers in 3D view yet. Check scans above and click <b>+ Add Selected Scans</b>.")}
          </div>`
        : layers
            .map((l, idx) => {
              const isSel = l.scan_id === STATE.multiAlign.selectedScanId;
              const disAttr = l.locked ? "disabled" : "";
              return `
              <div class="align-layer-card" data-scan-id="${l.scan_id}" style="background:${
                isSel ? "var(--ui-bg-elevated)" : "var(--ui-bg-subtle)"
              };border:1.5px solid ${
                isSel ? l.color : "var(--ui-border)"
              };border-radius:8px;padding:9px 10px;margin-bottom:8px;transition:border-color 0.15s;">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
                  <div style="display:flex;align-items:center;gap:6px;min-width:110px;flex:1 1 auto;cursor:pointer;" class="btn-select-align-layer" data-scan-id="${l.scan_id}" title="${tr("點擊以將 3D 平移／旋轉控制軸掛載至此掃描", "Click to attach 3D Move/Rotate Gizmo to this scan")}">
                    <span style="width:11px;height:11px;border-radius:50%;background:${l.color};flex-shrink:0;box-shadow:0 0 0 2px rgba(255,255,255,0.15);"></span>
                    <span style="font-size:12px;font-weight:700;color:var(--ui-text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:80px;flex:1 1 auto;">
                      #${idx + 1} ${l.name}
                    </span>
                    ${
                      idx === 0
                        ? `<span style="font-size:9.5px;padding:1px 5px;border-radius:4px;background:rgba(56,189,248,0.16);color:#38bdf8;font-weight:600;white-space:nowrap;flex-shrink:0;">${tr("基準", "ANCHOR")}</span>`
                        : ""
                    }
                  </div>
                  <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
                    <button type="button" class="gs-top-btn btn-align-tint ${l.tintEnabled ? "accent" : ""}" data-scan-id="${l.scan_id}" style="padding:2px 6px;font-size:10px;" title="${tr("切換此掃描的假色渲染以檢視重疊精度", "Toggle false-color tint on this scan to inspect overlap")}">
                      🎨
                    </button>
                    <button type="button" class="gs-top-btn btn-align-vis" data-scan-id="${l.scan_id}" style="padding:2px 6px;font-size:10px;opacity:${l.visible ? 1 : 0.45};" title="${tr("顯示／隱藏掃描圖層", "Show/Hide scan layer")}">
                      ${l.visible ? "👁" : "🚫"}
                    </button>
                    <button type="button" class="gs-top-btn btn-align-lock ${l.locked ? "accent" : ""}" data-scan-id="${l.scan_id}" style="padding:2px 7px;font-size:10.5px;font-weight:700;${
                      l.locked
                        ? "background:#10b981;border-color:#059669;color:#ffffff;"
                        : ""
                    }" title="${l.locked ? tr("姿態已鎖定 · 點擊解鎖", "Orientation Locked · Click to Unlock") : tr("合併前鎖定姿態", "Lock Orientation before Merging")}">
                      ${l.locked ? tr("🔒 已鎖定", "🔒 Locked") : tr("🔓 鎖定", "🔓 Lock")}
                    </button>
                    <button type="button" class="gs-top-btn btn-align-remove" data-scan-id="${l.scan_id}" style="padding:2px 6px;font-size:10px;" title="${tr("從對齊檢視移除此掃描", "Remove scan from alignment view")}">
                      ✕
                    </button>
                  </div>
                </div>

                <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:5px;font-size:10.5px;">
                  <div>
                    <label style="display:block;color:#ef4444;font-weight:600;margin-bottom:2px;">${tr("平移 X · E m", "Move X · E m")}</label>
                    <input type="number" step="0.1" class="gs-input align-num-input" data-scan-id="${l.scan_id}" data-field="tx" value="${Number(l.tx || 0).toFixed(2)}" ${disAttr} style="padding:3px 5px;font-size:11px;width:100%;" />
                  </div>
                  <div>
                    <label style="display:block;color:#22c55e;font-weight:600;margin-bottom:2px;">${tr("高程 Y · H m", "Elev Y · H m")}</label>
                    <input type="number" step="0.1" class="gs-input align-num-input" data-scan-id="${l.scan_id}" data-field="ty" value="${Number(l.ty || 0).toFixed(2)}" ${disAttr} style="padding:3px 5px;font-size:11px;width:100%;" />
                  </div>
                  <div>
                    <label style="display:block;color:#3b82f6;font-weight:600;margin-bottom:2px;">${tr("平移 Z · N m", "Move Z · N m")}</label>
                    <input type="number" step="0.1" class="gs-input align-num-input" data-scan-id="${l.scan_id}" data-field="tz" value="${Number(l.tz || 0).toFixed(2)}" ${disAttr} style="padding:3px 5px;font-size:11px;width:100%;" />
                  </div>
                  <div>
                    <label style="display:block;color:#10b981;font-weight:600;margin-bottom:2px;">${tr("航向角 Ry °", "Yaw Ry °")}</label>
                    <input type="number" step="0.5" class="gs-input align-num-input" data-scan-id="${l.scan_id}" data-field="ry_deg" value="${Number(l.ry_deg || 0).toFixed(1)}" ${disAttr} style="padding:3px 5px;font-size:11px;width:100%;" />
                  </div>
                  <div>
                    <label style="display:block;color:#f87171;font-weight:600;margin-bottom:2px;">${tr("俯仰角 Rx °", "Pitch Rx °")}</label>
                    <input type="number" step="0.5" class="gs-input align-num-input" data-scan-id="${l.scan_id}" data-field="rx_deg" value="${Number(l.rx_deg || 0).toFixed(1)}" ${disAttr} style="padding:3px 5px;font-size:11px;width:100%;" />
                  </div>
                  <div>
                    <label style="display:block;color:#60a5fa;font-weight:600;margin-bottom:2px;">${tr("橫滾角 Rz °", "Roll Rz °")}</label>
                    <input type="number" step="0.5" class="gs-input align-num-input" data-scan-id="${l.scan_id}" data-field="rz_deg" value="${Number(l.rz_deg || 0).toFixed(1)}" ${disAttr} style="padding:3px 5px;font-size:11px;width:100%;" />
                  </div>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;gap:4px;">
                  <button type="button" class="gs-top-btn btn-select-align-layer ${isSel ? "accent" : ""}" data-scan-id="${l.scan_id}" style="padding:2px 8px;font-size:10.5px;flex:1;justify-content:center;">
                    <span>${isSel ? tr("🎯 控制軸已啟用", "🎯 Gizmo Active") : tr("選取 3D 控制軸", "Select for 3D Gizmo")}</span>
                  </button>
                  <button type="button" class="gs-top-btn btn-align-rot90" data-scan-id="${l.scan_id}" ${disAttr} style="padding:2px 7px;font-size:10.5px;" title="${tr("航向角旋轉 +90°", "Rotate Yaw +90°")}">
                    <span>↻ +90°</span>
                  </button>
                  <button type="button" class="gs-top-btn btn-align-zero" data-scan-id="${l.scan_id}" ${disAttr} style="padding:2px 7px;font-size:10.5px;" title="${tr("重設此掃描至原點 0,0,0 與 0° 旋轉", "Reset this scan to 0,0,0 and 0° rotation")}">
                    <span>${tr("重設", "Reset")}</span>
                  </button>
                </div>
              </div>
            `;
            })
            .join("");

    const postMergeHtml = STATE.multiAlign.lastMergedScan
      ? `
        <div style="margin-top:10px;padding:10px;border-radius:8px;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.4);font-size:11.5px;">
          <div style="font-weight:700;color:#10b981;margin-bottom:4px;">
            ✓ ${tr("合併掃描已就緒：", "Merged Scan Ready: ")}${escapeHtml(STATE.multiAlign.lastMergedScan.name)}
          </div>
          <div style="color:var(--ui-text-secondary);font-size:11px;margin-bottom:8px;">
            ${tr("已載入為目前 3D 工作台活動掃描，可直接套用以下工程分析工具：", "Loaded as the active Studio scan. Apply existing tools directly to this unified scan:")}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;">
            <button type="button" class="gs-top-btn accent" id="btnPostMergeOptimize" style="justify-content:center;font-size:11px;">
              <span>⚡ ${tr("壓縮 / 裁切", "Optimize / Crop")}</span>
            </button>
            <button type="button" class="gs-top-btn" id="btnPostMergeVolume" style="justify-content:center;font-size:11px;">
              <span>📐 ${tr("挖填方體積", "Cut/Fill Volume")}</span>
            </button>
            <button type="button" class="gs-top-btn" id="btnPostMergeContours" style="justify-content:center;font-size:11px;">
              <span>🗺️ ${tr("等高線 / DXF", "Contours / DXF")}</span>
            </button>
            <button type="button" class="gs-top-btn" id="btnPostMergeSection" style="justify-content:center;font-size:11px;">
              <span>🧊 ${tr("3D 剖面盒", "3D Section Box")}</span>
            </button>
          </div>
        </div>
      `
      : "";

    showSidePanel(
      tr("多掃描 3D 對齊與合併", "Multi-Scan 3D Alignment & Merge"),
      `
      <!-- Step 1: User-Controlled Scan Selector Checklist -->
      <div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);border-radius:8px;padding:9px 10px;margin-bottom:10px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px;">
          <span style="font-size:11.5px;font-weight:700;color:var(--ui-text-primary);">${tr("1. 選擇要加入的掃描", "1. Select Scans to Add")}</span>
          <div style="display:flex;gap:4px;">
            <button type="button" class="gs-top-btn" id="btnAlignCheckAllCandidates" style="padding:1px 6px;font-size:10px;" title="${tr("勾選清單中所有尚未載入的掃描", "Check all unloaded scans in this list")}">${tr("全選", "Select All")}</button>
            <button type="button" class="gs-top-btn" id="btnAlignUncheckAllCandidates" style="padding:1px 6px;font-size:10px;" title="${tr("取消勾選全部", "Uncheck all")}">${tr("清除", "Clear")}</button>
          </div>
        </div>

        <div style="margin-bottom:6px;">
          <select class="gs-select" id="alignProjectFilterSelect" style="width:100%;font-size:11.5px;height:28px;" title="${tr("依工區篩選掃描", "Filter scans by project site")}">
            ${projectFilterOptionsHtml}
          </select>
        </div>

        <div id="alignScanPickerChecklist" style="display:flex;flex-direction:column;gap:4px;max-height:155px;overflow-y:auto;padding-right:2px;margin-bottom:7px;">
          ${scanChecklistRowsHtml}
        </div>

        <button type="button" class="gs-top-btn accent" id="btnAlignAddCheckedScans" style="width:100%;justify-content:center;font-size:11.5px;font-weight:700;padding:6px 10px;">
          <span>${tr(`+ 將勾選掃描加入 3D 檢視 · 已勾選 ${checkedCount}`, `+ Add Selected Scans to 3D View · ${checkedCount} Checked`)}</span>
        </button>
      </div>

      <!-- Step 2: 3D Gizmo Mode & Active Layers -->
      <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;flex-wrap:wrap;margin-bottom:6px;">
        <span style="font-size:11.5px;font-weight:700;color:var(--ui-text-primary);white-space:nowrap;">${tr(`2. 活動中 3D 圖層 · 已載入 ${layers.length}`, `2. Active 3D Layers · ${layers.length} Loaded`)}</span>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          <button type="button" class="gs-top-btn" id="btnAlignSpreadScans" style="padding:2px 7px;font-size:10.5px;" title="${tr("沿 X 軸並排展開未鎖定掃描以便個別檢視", "Spread unlocked scans side-by-side along X so you can inspect them individually")}">
            <span>${tr("並排展開", "Spread")}</span>
          </button>
          <button type="button" class="gs-top-btn" id="btnAlignStackOrigin" style="padding:2px 7px;font-size:10.5px;" title="${tr("將未鎖定掃描疊合對齊於原點 0,0,0", "Co-locate unlocked scans at 0,0,0")}">
            <span>${tr("原點疊合", "Co-locate")}</span>
          </button>
        </div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;flex-wrap:wrap;margin-bottom:8px;background:var(--ui-bg-subtle);padding:5px 7px;border-radius:7px;border:1px solid var(--ui-border);">
        <span style="font-size:11px;font-weight:600;color:var(--ui-text-secondary);white-space:nowrap;">${tr("3D 控制軸模式：", "3D Gizmo Mode:")}</span>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          <button type="button" class="gs-top-btn btn-gizmo-mode ${STATE.multiAlign.gizmoMode === "both" ? "accent" : ""}" data-mode="both" style="padding:2px 7px;font-size:10.5px;">
            <span>${tr("平移 + 旋轉 · R", "Move + Rotate · R")}</span>
          </button>
          <button type="button" class="gs-top-btn btn-gizmo-mode ${STATE.multiAlign.gizmoMode === "translate" ? "accent" : ""}" data-mode="translate" style="padding:2px 7px;font-size:10.5px;">
            <span>${tr("平移 · W", "Move · W")}</span>
          </button>
          <button type="button" class="gs-top-btn btn-gizmo-mode ${STATE.multiAlign.gizmoMode === "rotate" ? "accent" : ""}" data-mode="rotate" style="padding:2px 7px;font-size:10.5px;">
            <span>${tr("旋轉 · E", "Rotate · E")}</span>
          </button>
        </div>
      </div>

      <div id="alignLayersList" style="max-height:270px;overflow-y:auto;padding-right:2px;margin-bottom:8px;">
        ${layerCardsHtml}
      </div>

      <div style="display:flex;gap:6px;margin-bottom:10px;">
        <button type="button" class="gs-top-btn ${allLocked ? "accent" : ""}" id="btnAlignLockAll" style="flex:1;justify-content:center;font-size:11.5px;${
          allLocked ? "background:#10b981;border-color:#059669;color:#fff;" : ""
        }">
          <span>${tr(`🔒 鎖定全部姿態 · ${lockedCount}/${layers.length}`, `🔒 Lock All Orientations · ${lockedCount}/${layers.length}`)}</span>
        </button>
        <button type="button" class="gs-top-btn" id="btnAlignUnlockAll" style="justify-content:center;font-size:11.5px;">
          <span>${tr("🔓 全部解鎖", "🔓 Unlock All")}</span>
        </button>
      </div>

      <div style="border-top:1px solid var(--ui-border);padding-top:10px;">
        <div class="gs-form-group" style="margin-bottom:7px;">
          <label style="font-size:11px;">${tr("合併後新掃描名稱", "Unified Scan Name")}</label>
          <input type="text" class="gs-input" id="alignMergedScanName" value="${defaultMergedName}" style="font-size:12px;" />
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px;">
          <div class="gs-form-group" style="margin-bottom:0;">
            <label style="font-size:11px;">${tr("目標工區名稱", "Target Project Site")}</label>
            <input type="text" class="gs-input" id="alignMergedProjectGroup" value="${curSite}" style="font-size:11.5px;" />
          </div>
          <div class="gs-form-group" style="margin-bottom:0;">
            <label style="font-size:11px;">${tr("合併後網格最佳化", "Post-Merge Optimizer")}</label>
            <select class="gs-select" id="alignPostOptPreset" style="font-size:11.5px;">
              <option value="none" ${!ensureStagedEditsForActiveScan().compressionPreset ? "selected" : ""}>${tr("保留原始合併網格", "Keep Native Merged Mesh")}</option>
              <option value="balanced" ${ensureStagedEditsForActiveScan().compressionPreset === "balanced" ? "selected" : ""}>${tr("自動執行平衡最佳化 · 50% 面數", "Auto-Run Balanced · 50% Tris")}</option>
              <option value="quality" ${ensureStagedEditsForActiveScan().compressionPreset === "quality" ? "selected" : ""}>${tr("自動執行高品質最佳化 · 75% 面數", "Auto-Run High Quality · 75% Tris")}</option>
              <option value="web" ${ensureStagedEditsForActiveScan().compressionPreset === "web" ? "selected" : ""}>${tr("自動執行行動裝置最佳化 · 35% 面數", "Auto-Run Fast Tablet · 35% Tris")}</option>
              <option value="ultra_light" ${ensureStagedEditsForActiveScan().compressionPreset === "ultra_light" ? "selected" : ""}>${tr("自動執行極輕量最佳化 · 20% 面數", "Auto-Run Ultra-Light · 20% Tris")}</option>
            </select>
          </div>
        </div>

        ${(() => {
          const stMulti = ensureStagedEditsForActiveScan();
          const delRegs = (stMulti.deletions || []).reduce((acc, b) => acc + (Number(b.regionCount) || 1), 0);
          const delTris = (stMulti.deletions || []).reduce((acc, b) => acc + (Number(b.triCount) || 0), 0);
          const pendingRegs = countMarkedRegionsPending();
          const pendingTris = Number(STATE.lassoSelectedTriCount) || 0;
          const crsItem = stMulti.crsConfig
            ? CRS_UI_CATALOG.find((c) => c.code === stMulti.crsConfig.target_crs)
            : null;
          const chips = [];
          if (pendingRegs > 0) {
            chips.push(
              `<span style="color:#ef4444;font-weight:700;">🔴 ${tr(
                `已保留 ${pendingRegs} 個選取多邊形${pendingTris > 0 ? ` · ~${pendingTris.toLocaleString()} 面` : ""}`,
                `${pendingRegs} selected polygon${pendingRegs === 1 ? "" : "s"}${pendingTris > 0 ? ` · ~${pendingTris.toLocaleString()} tris` : ""} preserved`
              )}</span>`
            );
          }
          if (delRegs > 0) {
            chips.push(
              tr(
                `🗑️ 已刪除 ${delRegs} 個區域 · -${delTris.toLocaleString()} 面`,
                `🗑️ ${delRegs} deleted region${delRegs === 1 ? "" : "s"} · -${delTris.toLocaleString()} tris`
              )
            );
          }
          if (crsItem) {
            chips.push(`🌐 CRS: ${escapeHtml(getCrsItemShortLabel(crsItem))}`);
          }
          return `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:5px;flex-wrap:wrap;margin-bottom:8px;padding:6px 8px;border-radius:7px;background:var(--ui-bg-subtle);border:1px solid ${
              pendingRegs > 0 ? "rgba(239,68,68,0.45)" : "var(--ui-border)"
            };font-size:10.5px;">
              <span style="color:var(--ui-text-secondary);">${
                chips.length > 0
                  ? `<b>${tr("合併包含項目：", "Included in Merge:")}</b> ${chips.join(" · ")}`
                  : tr(
                      `提示：可先使用 <b>套索刪除</b> 或 <b>座標系統</b> 調整後再合併！`,
                      `Tip: Use <b>Lasso Delete</b> or <b>CRS</b> before merging!`
                    )
              }</span>
              <div style="display:flex;gap:4px;flex-wrap:wrap;">
                ${
                  pendingRegs > 0
                    ? `<button type="button" class="gs-top-btn accent" id="btnAlignCommitPendingLasso" style="padding:2px 7px;font-size:10px;background:#ef4444;border-color:#dc2626;color:#fff;" title="${tr("套用即時 3D 刪除至保留的紅色多邊形", "Apply live 3D deletion to the preserved red polygons")}">${tr(`✓ 刪除已選取 · ${pendingRegs}`, `✓ Delete Selected · ${pendingRegs}`)}</button>`
                    : ""
                }
                <button type="button" class="gs-top-btn" id="btnAlignOpenLassoDelete" style="padding:2px 7px;font-size:10px;border-color:rgba(239,68,68,0.4);color:#ef4444;">🗑️ ${
                  pendingRegs > 0 ? tr("編輯多邊形", "Edit Polygons") : tr("套索刪除", "Lasso Delete")
                }</button>
                <button type="button" class="gs-top-btn" id="btnAlignOpenCrs" style="padding:2px 7px;font-size:10px;">🌐 CRS</button>
              </div>
            </div>
          `;
        })()}

        <label style="display:flex;align-items:center;gap:7px;margin-bottom:8px;padding:6px 8px;border-radius:7px;background:var(--ui-bg-subtle);border:1px solid var(--ui-border);font-size:11px;color:var(--ui-text-secondary);cursor:pointer;">
          <input type="checkbox" id="chkAlignArchiveOriginals" ${
            STATE.multiAlign.archiveOriginals === true ? "checked" : ""
          } style="accent-color:#10b981;width:14px;height:14px;margin:0;cursor:pointer;flex-shrink:0;" />
          <span>${tr(
            "選填：合併後將個別原掃描移至回收桶 · 預設保留所有個別掃描",
            "Optional: move individual source scans to <b>Trash Bin</b> after merge"
          )}</span>
        </label>

        <button type="button" class="gs-top-btn accent" id="btnExecuteMergeScans" style="width:100%;justify-content:center;padding:8px 12px;font-weight:700;${
          allLocked ? "" : "opacity:0.85;"
        }">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
          </svg>
          <span>${
            allLocked
              ? tr(`合併 ${layers.length} 組已鎖定掃描為單一掃描`, `Merge ${layers.length} Locked Scans into Unified Scan`)
              : tr(`請先鎖定所有掃描 🔒 再執行合併 · 已鎖定 ${lockedCount}/${layers.length}`, `Lock All Scans 🔒 to Merge · ${lockedCount}/${layers.length} Locked`)
          }</span>
        </button>

        <button type="button" class="gs-top-btn" id="btnExitMultiAlign" style="width:100%;justify-content:center;margin-top:6px;font-size:11px;">
          <span>${tr("離開多掃描對齊檢視", "Exit Multi-Scan Alignment View")}</span>
        </button>
      </div>

      <div id="alignMergeResultBox" style="margin-top:8px;"></div>
      ${postMergeHtml}
      `
    );

    // Wire scan selector checklist events
    document.getElementById("alignProjectFilterSelect")?.addEventListener("change", (ev) => {
      STATE.multiAlign.pickerProjectGroup = ev.target.value;
      renderAlignMergeInspectorContent();
    });

    document.querySelectorAll(".chk-align-pick-scan").forEach((chk) => {
      chk.addEventListener("change", () => {
        const sid = chk.dataset.scanId;
        if (!sid) return;
        if (chk.checked) {
          STATE.multiAlign.checkedScanIds.add(sid);
        } else {
          STATE.multiAlign.checkedScanIds.delete(sid);
        }
        renderAlignMergeInspectorContent();
      });
    });

    document.querySelectorAll(".btn-align-quick-add").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const sid = btn.dataset.scanId;
        if (!sid) return;
        if (!STATE.multiAlign.active) enterMultiScanAlignMode();
        addScanLayerToMultiAlign(sid);
        STATE.multiAlign.checkedScanIds?.delete(sid);
        renderAlignMergeInspectorContent();
        const added = STATE.scans.find((s) => s.scan_id === sid);
        showToast(`Added "${added?.name || sid}" to 3D alignment view`);
      });
    });

    document.getElementById("btnAlignCheckAllCandidates")?.addEventListener("click", () => {
      candidateScans.forEach((s) => {
        if (!STATE.multiAlign.layers.some((l) => l.scan_id === s.scan_id)) {
          STATE.multiAlign.checkedScanIds.add(s.scan_id);
        }
      });
      renderAlignMergeInspectorContent();
    });

    document.getElementById("btnAlignUncheckAllCandidates")?.addEventListener("click", () => {
      STATE.multiAlign.checkedScanIds.clear();
      renderAlignMergeInspectorContent();
    });

    document.getElementById("btnAlignAddCheckedScans")?.addEventListener("click", () => {
      const toAdd = candidateScans.filter(
        (s) =>
          !STATE.multiAlign.layers.some((l) => l.scan_id === s.scan_id) &&
          STATE.multiAlign.checkedScanIds.has(s.scan_id)
      );
      if (toAdd.length === 0) {
        showToast("Please check at least one scan in the list above (or click '+ Add' next to a scan).");
        return;
      }
      if (!STATE.multiAlign.active) enterMultiScanAlignMode();
      toAdd.forEach((s) => {
        addScanLayerToMultiAlign(s.scan_id);
        STATE.multiAlign.checkedScanIds.delete(s.scan_id);
      });
      renderAlignMergeInspectorContent();
      showToast(`Added ${toAdd.length} selected scan(s) to 3D alignment view`);
    });

    document.getElementById("btnAlignSpreadScans")?.addEventListener("click", () => {
      STATE.multiAlign.layers.forEach((l, i) => {
        if (l.locked) return;
        l.tx = Number(((i - (STATE.multiAlign.layers.length - 1) * 0.5) * 18).toFixed(2));
        l.ty = 0;
        l.tz = 0;
        l._userMoved = true;
        applyLayerTransformTo3D(l);
      });
      renderAlignMergeInspectorContent();
      showToast("Spread unlocked scans along X axis for clear visual inspection");
    });

    document.getElementById("btnAlignStackOrigin")?.addEventListener("click", () => {
      STATE.multiAlign.layers.forEach((l) => {
        if (l.locked) return;
        l.tx = 0;
        l.ty = 0;
        l.tz = 0;
        l._userMoved = true;
        applyLayerTransformTo3D(l);
      });
      renderAlignMergeInspectorContent();
      showToast("Co-located unlocked scans at (0, 0, 0)");
    });

    document.querySelectorAll(".btn-gizmo-mode").forEach((btn) => {
      btn.addEventListener("click", () => {
        STATE.multiAlign.gizmoMode = btn.dataset.mode || "both";
        updateStudioTransformGizmo();
        renderAlignMergeInspectorContent();
      });
    });

    document.querySelectorAll(".btn-select-align-layer").forEach((btn) => {
      btn.addEventListener("click", () => {
        STATE.multiAlign.selectedScanId = btn.dataset.scanId;
        updateStudioTransformGizmo();
        renderAlignMergeInspectorContent();
      });
    });

    document.querySelectorAll(".btn-align-tint").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const l = STATE.multiAlign.layers.find((x) => x.scan_id === btn.dataset.scanId);
        if (l) {
          l.tintEnabled = !l.tintEnabled;
          renderAlignMergeInspectorContent();
        }
      });
    });

    document.querySelectorAll(".btn-align-vis").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const l = STATE.multiAlign.layers.find((x) => x.scan_id === btn.dataset.scanId);
        if (l) {
          l.visible = !l.visible;
          if (l.layerGroup) l.layerGroup.visible = l.visible;
          if (countMarkedRegionsPending() > 0) rebuildLassoHighlight3D();
          updateStudioTransformGizmo();
          renderAlignMergeInspectorContent();
        }
      });
    });

    document.querySelectorAll(".btn-align-lock").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const l = STATE.multiAlign.layers.find((x) => x.scan_id === btn.dataset.scanId);
        if (l) {
          l.locked = !l.locked;
          updateStudioTransformGizmo();
          renderAlignMergeInspectorContent();
          showToast(
            l.locked
              ? `Locked orientation for "${l.name}" 🔒`
              : `Unlocked "${l.name}" 🔓`
          );
        }
      });
    });

    document.querySelectorAll(".btn-align-remove").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        removeScanLayerFromMultiAlign(btn.dataset.scanId);
        renderAlignMergeInspectorContent();
      });
    });

    document.querySelectorAll(".btn-align-rot90").forEach((btn) => {
      btn.addEventListener("click", () => {
        const l = STATE.multiAlign.layers.find((x) => x.scan_id === btn.dataset.scanId);
        if (!l || l.locked) return;
        l.ry_deg = Number((((l.ry_deg + 90 + 180) % 360 + 360) % 360 - 180).toFixed(1));
        l._userMoved = true;
        applyLayerTransformTo3D(l);
        syncAlignLayerInputsInDOM(l);
      });
    });

    document.querySelectorAll(".btn-align-zero").forEach((btn) => {
      btn.addEventListener("click", () => {
        const l = STATE.multiAlign.layers.find((x) => x.scan_id === btn.dataset.scanId);
        if (!l || l.locked) return;
        l.tx = 0;
        l.ty = 0;
        l.tz = 0;
        l.rx_deg = 0;
        l.ry_deg = 0;
        l.rz_deg = 0;
        l._userMoved = true;
        applyLayerTransformTo3D(l);
        syncAlignLayerInputsInDOM(l);
      });
    });

    document.querySelectorAll(".align-num-input").forEach((inp) => {
      inp.addEventListener("input", () => {
        const l = STATE.multiAlign.layers.find((x) => x.scan_id === inp.dataset.scanId);
        if (!l || l.locked) return;
        const field = inp.dataset.field;
        const val = parseFloat(inp.value);
        if (Number.isFinite(val)) {
          l[field] = val;
          l._userMoved = true;
          STATE.multiAlign.selectedScanId = l.scan_id;
          applyLayerTransformTo3D(l);
        }
      });
    });

    document.getElementById("btnAlignLockAll")?.addEventListener("click", () => {
      STATE.multiAlign.layers.forEach((l) => {
        l.locked = true;
      });
      updateStudioTransformGizmo();
      renderAlignMergeInspectorContent();
      showToast(`All ${STATE.multiAlign.layers.length} scan orientations locked 🔒 — ready to merge!`);
    });

    document.getElementById("btnAlignUnlockAll")?.addEventListener("click", () => {
      STATE.multiAlign.layers.forEach((l) => {
        l.locked = false;
      });
      updateStudioTransformGizmo();
      renderAlignMergeInspectorContent();
      showToast("Unlocked all scan layers 🔓");
    });

    document.getElementById("chkAlignArchiveOriginals")?.addEventListener("change", (ev) => {
      STATE.multiAlign.archiveOriginals = Boolean(ev.target.checked);
    });

    document.getElementById("btnAlignCommitPendingLasso")?.addEventListener("click", () => {
      const committed = commitPendingLassoMarksToStagedEdits("delete_inside");
      renderAlignMergeInspectorContent();
      if (committed.committed) {
        showToast(
          `Deleted ${committed.regionCount} selected polygon(s) in live 3D preview (${(committed.hiddenTris || 0).toLocaleString()} tris hidden)`
        );
      }
    });

    document.getElementById("btnAlignOpenLassoDelete")?.addEventListener("click", () => {
      STATE.cropMode = "delete_inside";
      openLassoDeleteInspector({ armLasso: true });
      showToast("Lasso active across visible scan layers — mark regions & press Delete, or Return to Alignment anytime!");
    });

    document.getElementById("btnAlignOpenCrs")?.addEventListener("click", () => {
      preserveLassoSelectionBeforeToolSwitch();
      setActiveStudioTool("crs");
      openCoordinateSystemInspector();
    });

    document.getElementById("btnExitMultiAlign")?.addEventListener("click", () => {
      exitMultiScanAlignMode(true);
      document.getElementById("studioSidePanel")?.classList.remove("active");
      setActiveStudioTool("distance");
    });

    document.getElementById("btnExecuteMergeScans")?.addEventListener("click", async () => {
      if (STATE.multiAlign.layers.length < 2) {
        showToast("Please load at least 2 scans to merge.");
        return;
      }
      if (STATE.multiAlign.layers.some((l) => !l.ready)) {
        showToast("Please wait a moment for all 3D scan layers to finish loading their bounds before merging.");
        return;
      }
      const unlocked = STATE.multiAlign.layers.filter((l) => !l.locked);
      if (unlocked.length > 0) {
        showToast(
          `Please lock all scan orientations (🔒) before merging (${unlocked.length} still unlocked).`
        );
        return;
      }

      if (countMarkedRegionsPending() > 0) {
        commitPendingLassoMarksToStagedEdits("delete_inside");
      }

      const stMulti = ensureStagedEditsForActiveScan();
      const mergedName =
        document.getElementById("alignMergedScanName")?.value?.trim() ||
        stMulti.newScanName ||
        defaultMergedName;
      const mergedProject =
        document.getElementById("alignMergedProjectGroup")?.value?.trim() ||
        curSite;
      const postOptPresetRaw =
        document.getElementById("alignPostOptPreset")?.value || "none";
      const effectiveCompression =
        postOptPresetRaw && postOptPresetRaw !== "none"
          ? postOptPresetRaw
          : stMulti.compressionPreset || "";
      const archiveOriginals = STATE.multiAlign.archiveOriginals === true;

      const resBox = document.getElementById("alignMergeResultBox");
      if (resBox) {
        resBox.innerHTML = `<div style="padding:10px;border-radius:8px;background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);font-size:12px;color:var(--ui-accent);">
          Merging ${STATE.multiAlign.layers.length} locked scans, applying deletions / CRS / compression${
            archiveOriginals ? ", and moving source scan backups to Trash Bin" : ""
          }...
        </div>`;
      }

      try {
        const serializedLayers = serializeMultiAlignLayersForMerge(false);
        const refC = STATE.multiAlign.refCenter || STATE.multiAlign.layers[0]?.rawCenter || null;
        const payload = {
          name: mergedName,
          new_scan_name: mergedName,
          project_group: mergedProject,
          ref_center_zup: refC ? [Number(refC.x), Number(refC.y), Number(refC.z)] : null,
          layers: serializedLayers,
          scans: serializedLayers,
          deletions: stMulti.deletions || [],
          compression_preset: effectiveCompression,
          crs_config: stMulti.crsConfig || null,
          archive_originals_to_bin: archiveOriginals,
        };

        const res = await apiPost("/api/scans/merge", payload);

        if (typeof res.bin_scans_count === "number") {
          updateRecycleBinBadges(res.bin_scans_count);
        } else if (Array.isArray(res.bin_scans)) {
          updateRecycleBinBadges(res.bin_scans.length);
        }

        STATE.multiAlign.lastMergedScan = res.scan || {
          scan_id: res.scan_id,
          name: mergedName,
          project_group: mergedProject,
        };

        await refreshScansCatalog();
        exitMultiScanAlignMode(false);
        loadScanIntoStudio(res.scan_id);
        renderAlignMergeInspectorContent();

        const finalBox = document.getElementById("alignMergeResultBox");
        if (finalBox) {
          const outMb = res.output_mb ?? res.glb_size_mb ?? 0;
          const archivedCount = Number(res.archived_to_bin_count) || 0;
          finalBox.innerHTML = `
            <div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);border-radius:8px;padding:10px;font-size:12px;color:var(--ui-text-primary);">
              <div style="color:#10b981;font-weight:700;">✓ Unified Scan Saved (${res.duration_s}s)</div>
              <div style="margin-top:3px;">Scan ID: <code>${res.scan_id}</code></div>
              <div>Coordinate System: <b>${escapeHtml(res.crs || res.scan?.crs || "TWD97 (121) + TWVD2001")}</b></div>
              <div>Geometry: <b>${(res.total_vertices || 0).toLocaleString()} verts · ${(res.total_faces || 0).toLocaleString()} faces</b></div>
              <div>Stream Size: <b>${outMb} MB</b></div>
              ${
                archivedCount > 0
                  ? `<div style="margin-top:5px;padding-top:5px;border-top:1px solid var(--ui-border);display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--ui-text-secondary);">
                       <span>🗑️ <b>${archivedCount}</b> source scan backup${archivedCount === 1 ? "" : "s"} moved to Trash Bin</span>
                       <button type="button" class="gs-top-btn" id="btnMergeResultOpenBin" style="padding:2px 7px;font-size:10.5px;">Open Trash Bin</button>
                     </div>`
                  : ""
              }
            </div>
          `;
          document.getElementById("btnMergeResultOpenBin")?.addEventListener("click", () => {
            openRecycleBinModal();
          });
        }
        showToast(
          `Merged ${res.merged_count} scans into "${mergedName}"${
            Number(res.archived_to_bin_count) > 0 ? " · Source backups in Trash Bin" : ""
          }!`
        );
      } catch (err) {
        if (resBox) {
          resBox.innerHTML = `<div style="padding:8px;border-radius:6px;background:rgba(239,68,68,0.12);color:#ef4444;font-size:11.5px;">Merge failed: ${err.message}</div>`;
        }
        showToast(`Merge Error: ${err.message}`);
      }
    });

    // Post-merge quick workflow launchers
    document.getElementById("btnPostMergeOptimize")?.addEventListener("click", () => {
      setActiveStudioTool("optimizer");
      openOptimizerInspector();
    });
    document.getElementById("btnPostMergeVolume")?.addEventListener("click", () => {
      STATE.measurePoints = [];
      STATE.polygonLocked = false;
      STATE.maskBoundaryPoints = [];
      STATE.cutFillPolygonPoints = [];
      clearVolumeVisualsOnly();
      setActiveStudioTool("volume");
      openCutFillVolumeInspector();
    });
    document.getElementById("btnPostMergeContours")?.addEventListener("click", () => {
      STATE.measurePoints = [];
      STATE.polygonLocked = false;
      STATE.maskBoundaryPoints = [];
      setActiveStudioTool("contours");
      openContoursInspector();
    });
    document.getElementById("btnPostMergeSection")?.addEventListener("click", () => {
      STATE.measurePoints = [];
      STATE.sectionBoxEndpoints = [];
      setActiveStudioTool("section");
      openSectionBoxInspector();
    });
  }

  function openAlignMergeInspector() {
    STATE.sidePanelMinimized = false;
    if (!STATE.multiAlign.active) {
      STATE.multiAlign.lastMergedScan = null;
      enterMultiScanAlignMode();
    } else {
      updateStudioTransformGizmo();
    }
    renderAlignMergeInspectorContent();
  }

  function triggerStudioEscapeAction(ev = null) {
    if (document.getElementById("gsStudioQuickSharePopover")) {
      closeQuickSingleScanSharePopover();
      return true;
    }
    if (document.getElementById("gsDownloadFormatPopover") && typeof closeDownloadFormatMenu === "function") {
      closeDownloadFormatMenu();
      return true;
    }
    // 1. If a non-locked modal is open, close the topmost open modal
    const openModals = Array.from(document.querySelectorAll(".gs-modal-backdrop.active"));
    if (openModals.length > 0) {
      const topModal = openModals[openModals.length - 1];
      if (topModal.id !== "userProfileGateModal" || STATE.isAuthorized || STATE.shareToken) {
        closeModal(topModal.id);
        return true;
      }
    }
    // 2. If moving an existing measurement/area/coord/angle vertex, cancel the move and restore original position
    if (STATE.activeView === "studio" && STATE.movingVertex && typeof cancelStudioVertexMove === "function") {
      if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
      cancelStudioVertexMove(true);
      return true;
    }
    // 3. Pause Lasso on Esc (if mid-drag, cancel only the in-progress drag; if armed, switch to orbit mode while keeping all selected polygons!)
    if (STATE.activeView === "studio") {
      const isDraggingLasso = Boolean(
        studioThree && typeof studioThree._isLassoDragging === "function" && studioThree._isLassoDragging()
      );
      if (isDraggingLasso) {
        if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
        if (typeof studioThree._cancelLassoDrag === "function") studioThree._cancelLassoDrag();
        showToast("Cancelled current Lasso drag (Esc) — previous polygons preserved");
        return true;
      }
      if (STATE.activeTool === "crop_delete" || STATE.activeTool === "crop") {
        if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
        cancelLassoToolMode(true, false);
        showToast("Lasso paused (Esc) — selected polygons preserved");
        return true;
      }
    }
    // 4. Cancel in-progress measurement points, active Categorize edit mode, active Studio tool / side panel, or First-Person mode
    if (
      STATE.activeView === "studio" &&
      STATE.activeTool === "categorize" &&
      (STATE.categorizeEditMode || (Array.isArray(STATE.categorizeEditPoints) && STATE.categorizeEditPoints.length > 0))
    ) {
      STATE.categorizeEditMode = null;
      STATE.categorizeEditPoints = [];
      clearTempDistanceVisuals();
      if (STATE.lastCategorizeResult && document.getElementById("catResultContainer")) {
        renderCategorizePanelContent(STATE.lastCategorizeResult);
      }
      if (typeof syncStudioMobileToolHud === "function") syncStudioMobileToolHud();
      showToast(tr("已取消手動編輯模式", "Cancelled manual edit mode"));
      return true;
    }
    if (STATE.activeView === "studio" && STATE.measurePoints.length > 0) {
      STATE.measurePoints = [];
      clearTempDistanceVisuals();
      if (studioThree && studioThree.overlayGroup) {
        const tempPins = [];
        studioThree.overlayGroup.children.forEach((c) => {
          if (c && c.userData && c.userData.isSectionTempPin) tempPins.push(c);
        });
        tempPins.forEach((c) => {
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
      if (STATE.activeTool === "area" && typeof rebuildAllCompletedMeasurements3D === "function") {
        rebuildAllCompletedMeasurements3D();
      } else if (STATE.activeTool === "volume" && !STATE.polygonLocked) {
        clearVolumeVisualsOnly();
        openCutFillVolumeInspector(null);
      }
      if (typeof syncStudioMobileToolHud === "function") syncStudioMobileToolHud();
      showToast("Cancelled in-progress points (Esc)");
      return true;
    }
    if (
      STATE.activeView === "studio" &&
      [
        "laser",
        "coordinates",
        "angle",
        "distance",
        "area",
        "volume",
        "contours",
        "profile",
        "section",
        "photos",
        "rtk",
        "categorize",
        "drainage",
        "gcp_qa",
        "bookmarks",
        "comments",
        "optimizer",
        "crs",
        "generate_scan",
      ].includes(STATE.activeTool)
    ) {
      clearTempDistanceVisuals();
      if (STATE.activeTool === "section") {
        clearSectionBoxClippingIfNotKept();
      }
      if (STATE.activeTool === "categorize") {
        STATE.categorizeOverlayVisible = false;
        clearCategorizeVisualsOnly();
        if (typeof syncCategorizeVisibilityUI === "function") syncCategorizeVisibilityUI();
      }
      if (STATE.activeTool === "drainage" && typeof clearDrainageVisuals3D === "function") {
        clearDrainageVisuals3D();
      }
      if ((STATE.activeTool === "photos" || STATE.activeTool === "rtk") && typeof clearPhotoTargetVisuals3D === "function") {
        clearPhotoTargetVisuals3D(true);
      }
      const panelEl = document.getElementById("studioSidePanel");
      if (panelEl) {
        panelEl.classList.remove("active", "open");
        panelEl.classList.add("hidden");
      }
      setActiveStudioTool(STATE.multiAlign?.active ? "align_merge" : "orbit");
      if (typeof syncStudioMobileToolHud === "function") syncStudioMobileToolHud();
      showToast("Exited active tool (Esc)");
      return true;
    }
    if (STATE.activeView === "studio" && document.getElementById("studioSidePanel")?.classList.contains("active")) {
      if (typeof closeSidePanel === "function") {
        closeSidePanel();
      } else {
        const panelEl = document.getElementById("studioSidePanel");
        panelEl.classList.remove("active", "open");
        panelEl.classList.add("hidden");
      }
      return true;
    }
    if (STATE.activeView === "studio" && STATE.fpMode?.active) {
      exitFirstPersonMode(false);
      return true;
    }
    return false;
  }
  window.triggerStudioEscapeAction = triggerStudioEscapeAction;

  // Unified Bottom Dock (#bimBottomDock) + Separate Left-Side Scan Editing Dock (#studioEditingDock) Button Wiring
  let _lastToolBtnClick = { tool: "", ts: 0 };
  let _lastDockEscapeTriggeredMs = 0;
  document.querySelectorAll("#bimBottomDock .bim-dock-btn, #studioEditingDock .bim-dock-btn").forEach((btn) => {
    btn.addEventListener("dblclick", (ev) => {
      const tool = btn.dataset.tool || btn.dataset.dock || "";
      if (!tool || tool === "snap" || tool === "first_person" || tool === "orbit") return;
      ev.preventDefault();
      ev.stopPropagation();
      const nowMs = performance.now();
      _lastToolBtnClick = { tool: "", ts: 0 };
      if (nowMs - _lastDockEscapeTriggeredMs <= 280) {
        return;
      }
      _lastDockEscapeTriggeredMs = nowMs;
      triggerStudioEscapeAction(ev);
    });

    btn.addEventListener("click", (ev) => {
      if (btn.id === "btnClearMeasurements" || btn.id === "btnMeasureClear") {
        clearMeasurements();
        if (studioThree && studioThree.contourGroup) {
          while (studioThree.contourGroup.children.length > 0) {
            studioThree.contourGroup.remove(studioThree.contourGroup.children[0]);
          }
        }
        showToast("Cleared 3D measurements & overlays");
        return;
      }

      const tool = btn.dataset.tool || btn.dataset.dock || "";
      if (STATE.multiAlign?.active && (MULTI_ALIGN_DISABLED_TOOLS.has(tool) || btn.classList.contains("multi-align-disabled"))) {
        ev.preventDefault();
        showToast("Unavailable during Multi-Scan Editing — merge scans first (or exit Multi-Scan mode)");
        return;
      }
      if (tool === "snap") {
        STATE.snapEnabled = !STATE.snapEnabled;
        btn.classList.toggle("active", STATE.snapEnabled);
        if (!STATE.snapEnabled && typeof updateStudioSnapIndicator === "function") {
          updateStudioSnapIndicator(null, false);
        }
        showToast(`Snapping ${STATE.snapEnabled ? "Enabled" : "Disabled"}`);
        return;
      }
      if (tool === "first_person" || btn.id === "btnToggleFirstPerson") {
        toggleFirstPersonMode();
        return;
      }
      if (!tool) return;

      const nowMs = performance.now();
      const wasAlreadyActive = STATE.activeTool === tool;
      if (
        wasAlreadyActive &&
        tool !== "orbit" &&
        _lastToolBtnClick.tool === tool &&
        nowMs - _lastToolBtnClick.ts <= 420
      ) {
        _lastToolBtnClick = { tool: "", ts: 0 };
        if (nowMs - _lastDockEscapeTriggeredMs > 280) {
          _lastDockEscapeTriggeredMs = nowMs;
          triggerStudioEscapeAction(ev);
        }
        return;
      }
      _lastToolBtnClick = { tool, ts: nowMs };

      // Clicking an already-active Lasso dock button pauses Lasso cleanly WITHOUT discarding selected polygons
      if ((tool === "crop_delete" && STATE.activeTool === "crop_delete") || (tool === "crop" && STATE.activeTool === "crop")) {
        cancelLassoToolMode(true, false);
        showToast("Lasso paused (orbit mode) — selected polygons preserved");
        return;
      }

      // If clicking an already-selected measurement/surveying tool button once (Click #1), preserve all active/locked
      // tool state (measurePoints, cutFillPolygonPoints, maskBoundaryPoints, categorizeEditMode, profileEndpoints,
      // sectionBoxEndpoints) so a subsequent second click (double-click on selected tool) triggers Escape cleanly!
      if (wasAlreadyActive) {
        const panelEl = document.getElementById("studioSidePanel");
        const isPanelOpen = Boolean(
          panelEl && !panelEl.classList.contains("hidden") && panelEl.classList.contains("active")
        );
        if (
          STATE.measurePoints.length > 0 ||
          ["distance", "area", "angle", "coordinates", "laser"].includes(tool) ||
          isPanelOpen
        ) {
          return;
        }
      }

      if (tool === "optimizer") {
        preserveLassoSelectionBeforeToolSwitch();
        setActiveStudioTool("optimizer");
        openMeshCompressionInspector();
        return;
      }

      if (tool === "crs") {
        preserveLassoSelectionBeforeToolSwitch();
        setActiveStudioTool("crs");
        openCoordinateSystemInspector();
        return;
      }

      if (tool === "generate_scan") {
        preserveLassoSelectionBeforeToolSwitch();
        setActiveStudioTool("generate_scan");
        openGenerateScanInspector();
        return;
      }

      preserveLassoSelectionBeforeToolSwitch();
      if (tool !== "photos" && tool !== "rtk" && typeof clearPhotoTargetVisuals3D === "function") {
        clearPhotoTargetVisuals3D(true);
      }
      setActiveStudioTool(tool);
      STATE.measurePoints = [];

      if (tool === "volume") {
        STATE.polygonLocked = false;
        STATE.cutFillPolygonPoints = [];
        STATE.maskBoundaryPoints = [];
        clearVolumeVisualsOnly();
        openCutFillVolumeInspector(null);
      } else if (tool === "contours") {
        STATE.polygonLocked = false;
        STATE.maskBoundaryPoints = [];
        clearContoursVisualsOnly();
        openContoursInspector(null);
      } else if (tool === "profile") {
        STATE.profileEndpoints = [];
        clearProfileVisualsOnly();
        openProfileInspector(null, null);
      } else if (tool === "section") {
        STATE.sectionBoxEndpoints = [];
        openSectionBoxInspector(null, null);
      } else if (tool === "photos") {
        if (typeof clearPhotoTargetVisuals3D === "function") {
          clearPhotoTargetVisuals3D();
        }
        openRtkPhotoInspector(null, false);
      } else if (tool === "categorize") openCategorizeInspector();
      else if (tool === "comments") openCommentsInspector();
      else if (tool === "drainage" && typeof openDrainageAndSlopeInspector === "function") openDrainageAndSlopeInspector();
      else if (tool === "gcp_qa" && typeof openGcpAccuracyQaInspector === "function") openGcpAccuracyQaInspector();
      else if (tool === "bookmarks" && typeof openSavedMeasurementsInspector === "function") openSavedMeasurementsInspector();
      else if (tool === "crop_delete") {
        STATE.cropMode = "delete_inside";
        openLassoDeleteInspector({ armLasso: true });
        showToast(
          window.innerWidth <= 768
            ? "✏️ 套索刪除已啟用 — 單指畫圈標記，雙指縮放平移，點擊上方 🔄 切換旋轉"
            : "Lasso active (Mark for Deletion) — mark multiple regions, Mouse Wheel to rotate, then press Delete"
        );
      } else if (tool === "crop") {
        STATE.cropMode = "keep_inside";
        openLassoKeepInspector({ armLasso: true });
        showToast(
          window.innerWidth <= 768
            ? "✂️ 框選保留已啟用 — 單指畫圈標記保留區，雙指縮放平移，點擊上方 🔄 切換旋轉"
            : "Lasso active (Keep Inside) — mark keep boundary, Mouse Wheel to rotate, Esc to cancel"
        );
      } else if (tool === "align_merge") {
        openAlignMergeInspector();
      }
      if (typeof syncStudioMobileToolHud === "function") syncStudioMobileToolHud();
    });
  });

  // Mobile Editing Umbrella Button Toggle (#btnMobileEditingUmbrella -> #studioEditingDock.mobile-expanded)
  document.getElementById("btnMobileEditingUmbrella")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const dock = document.getElementById("studioEditingDock");
    const btn = document.getElementById("btnMobileEditingUmbrella");
    if (!dock || !btn) return;
    const expanded = dock.classList.toggle("mobile-expanded");
    btn.classList.toggle("active", expanded);
    btn.setAttribute("aria-expanded", expanded ? "true" : "false");
  });

  // First-Person Camera Top Bar & HUD Controls + PointerLock Listeners
  document.getElementById("btnStudioFirstPerson")?.addEventListener("click", () => {
    toggleFirstPersonMode();
  });
  document.getElementById("btnExitFirstPerson")?.addEventListener("click", () => {
    exitFirstPersonMode(false);
  });
  document.getElementById("btnFpPointerLock")?.addEventListener("click", () => {
    if (document.pointerLockElement) {
      try {
        document.exitPointerLock();
      } catch (_) {}
    } else {
      requestStudioPointerLock();
    }
  });
  document.getElementById("btnFpModeFly")?.addEventListener("click", () => {
    setFirstPersonLocomotion("fly", true);
  });
  document.getElementById("btnFpModeWalk")?.addEventListener("click", () => {
    setFirstPersonLocomotion("walk", true);
  });
  document.getElementById("fpSpeedSlider")?.addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v) && v >= 0.5) {
      STATE.fpMode.baseSpeed = v;
      syncFirstPersonHudUI();
    }
  });

  // Mobile / Tablet Touch D-Pad for First-Person Navigation (supports continuous thumb sliding across buttons)
  const fpTouchMovePadEl = document.getElementById("fpTouchMovePad");
  if (fpTouchMovePadEl) {
    let activePadPointerId = null;
    let activePadKey = null;
    const clearPadKey = () => {
      if (activePadKey && STATE.fpMode.keys) {
        delete STATE.fpMode.keys[activePadKey];
      }
      activePadKey = null;
      fpTouchMovePadEl.querySelectorAll("[data-fp-key].active").forEach((el) => el.classList.remove("active"));
    };
    const updatePadFromPoint = (clientX, clientY) => {
      if (!STATE.fpMode.active) {
        clearPadKey();
        return;
      }
      const hitBtn = document.elementFromPoint(clientX, clientY)?.closest?.("#fpTouchMovePad [data-fp-key]");
      const nextCode = hitBtn ? hitBtn.getAttribute("data-fp-key") : null;
      if (nextCode === activePadKey) return;
      clearPadKey();
      if (nextCode && hitBtn) {
        activePadKey = nextCode;
        STATE.fpMode.keys[nextCode] = true;
        hitBtn.classList.add("active");
      }
    };
    fpTouchMovePadEl.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      activePadPointerId = e.pointerId;
      try {
        fpTouchMovePadEl.setPointerCapture(e.pointerId);
      } catch (_) {}
      updatePadFromPoint(e.clientX, e.clientY);
    });
    fpTouchMovePadEl.addEventListener("pointermove", (e) => {
      if (activePadPointerId === null || e.pointerId !== activePadPointerId) return;
      e.preventDefault();
      e.stopPropagation();
      updatePadFromPoint(e.clientX, e.clientY);
    });
    const endPadGesture = (e) => {
      if (activePadPointerId !== null && e.pointerId !== activePadPointerId) return;
      e.stopPropagation();
      activePadPointerId = null;
      clearPadKey();
    };
    fpTouchMovePadEl.addEventListener("pointerup", endPadGesture);
    fpTouchMovePadEl.addEventListener("pointercancel", endPadGesture);
  }

  document.addEventListener("pointerlockchange", () => {
    syncStudioControlsForTool();
    syncFirstPersonHudUI();
  });

  document.addEventListener("mousemove", (e) => {
    if (!STATE.fpMode.active || STATE.activeView !== "studio") return;
    const domEl = studioThree?.renderer?.domElement;
    if (!domEl || document.pointerLockElement !== domEl) return;
    const mx = Number(e.movementX) || 0;
    const my = Number(e.movementY) || 0;
    if (mx !== 0 || my !== 0) {
      applyFirstPersonLookDelta(mx, my, 0.0021);
    }
  });

  window.addEventListener("keyup", (e) => {
    if (STATE.fpMode.keys && e.code) {
      delete STATE.fpMode.keys[e.code];
      if (e.code === "ShiftLeft" || e.code === "ShiftRight" || e.code === "AltLeft" || e.code === "AltRight") {
        syncFirstPersonHudUI();
      }
    }
  });

  window.addEventListener("blur", () => {
    if (STATE.fpMode) {
      STATE.fpMode.keys = Object.create(null);
      STATE.fpMode.dragLooking = false;
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && STATE.fpMode) {
      STATE.fpMode.keys = Object.create(null);
      STATE.fpMode.dragLooking = false;
    }
  });

  // Keyboard shortcuts for First-Person WASD, Esc (cancel active lasso / measurement / FP or close top modal), Enter (lock active polygon), and W/E/R/L in Align & Merge mode
  window.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable) return;

    if ((e.ctrlKey || e.metaKey) && STATE.fpMode?.keys) {
      STATE.fpMode.keys = Object.create(null);
    }

    const hasOpenModal = document.querySelectorAll(".gs-modal-backdrop.active").length > 0;

    // Toggle First-Person Mode anytime in Studio with 'F' (without Ctrl/Meta/Alt)
    if (STATE.activeView === "studio" && !hasOpenModal && !e.ctrlKey && !e.metaKey && !e.altKey && e.code === "KeyF") {
      e.preventDefault();
      toggleFirstPersonMode();
      return;
    }

    // Active First-Person Video-Game Movement & Mode Controls (takes priority over Gizmo W/E!)
    if (STATE.activeView === "studio" && !hasOpenModal && STATE.fpMode.active) {
      if (!e.ctrlKey && !e.metaKey && e.code === "KeyG") {
        e.preventDefault();
        setFirstPersonLocomotion(STATE.fpMode.locomotion === "walk" ? "fly" : "walk", true);
        return;
      }
      if (!e.ctrlKey && !e.metaKey && FP_MOVEMENT_CODES.has(e.code)) {
        e.preventDefault();
        STATE.fpMode.keys[e.code] = true;
        if (e.code === "ShiftLeft" || e.code === "ShiftRight" || e.code === "AltLeft" || e.code === "AltRight") {
          syncFirstPersonHudUI();
        }
        return;
      }
    }

    if (
      STATE.activeView === "studio" &&
      !hasOpenModal &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      STATE.multiAlign.active &&
      STATE.activeTool === "align_merge"
    ) {
      const k = e.key.toLowerCase();
      if (k === "w") {
        STATE.multiAlign.gizmoMode = "translate";
        updateStudioTransformGizmo();
        renderAlignMergeInspectorContent();
        showToast("Gizmo Mode: Move (W)");
        return;
      } else if (k === "e") {
        STATE.multiAlign.gizmoMode = "rotate";
        updateStudioTransformGizmo();
        renderAlignMergeInspectorContent();
        showToast("Gizmo Mode: Rotate (E)");
        return;
      } else if (k === "r") {
        STATE.multiAlign.gizmoMode = "both";
        updateStudioTransformGizmo();
        renderAlignMergeInspectorContent();
        showToast("Gizmo Mode: Move + Rotate (R)");
        return;
      } else if (k === "l") {
        const sel = getSelectedMultiAlignLayer();
        if (sel) {
          sel.locked = !sel.locked;
          updateStudioTransformGizmo();
          renderAlignMergeInspectorContent();
          showToast(sel.locked ? `Locked "${sel.name}" 🔒` : `Unlocked "${sel.name}" 🔓`);
          return;
        }
      }
    }

    if (e.key === "Escape") {
      triggerStudioEscapeAction(e);
      return;
    } else if (
      (e.key === "ArrowUp" || e.key === "ArrowDown") &&
      STATE.activeView === "studio" &&
      !hasOpenModal &&
      !STATE.fpMode?.active &&
      (STATE.activeTool === "section" || isSectionBoxClippingActive())
    ) {
      e.preventDefault();
      const st = STATE.sectionBoxState;
      if (st && st.active && typeof applySectionBoxStateToClippingAndUI === "function") {
        const stepM = 0.1 * (e.key === "ArrowUp" ? 1 : -1);
        st.centerY = Math.round((Number(st.centerY || 0) + stepM) * 100) / 100;
        applySectionBoxStateToClippingAndUI(true);
        if (typeof rebuildLassoHighlight3D === "function" && ((STATE.lassoStrokes && STATE.lassoStrokes.length > 0) || (STATE.pendingCropPolygons && STATE.pendingCropPolygons.length > 0))) {
          rebuildLassoHighlight3D();
        }
      }
      return;
    } else if (
      e.key === "Enter" &&
      STATE.activeView === "studio" &&
      STATE.activeTool === "categorize" &&
      STATE.categorizeEditMode &&
      Array.isArray(STATE.categorizeEditPoints)
    ) {
      if (STATE.categorizeEditMode === "add_road" && STATE.categorizeEditPoints.length >= 3) {
        const boundaryLoc = STATE.categorizeEditPoints.map((x) => [
          Number(x.pt.x.toFixed(3)),
          Number(x.pt.y.toFixed(3)),
          Number(x.pt.z.toFixed(3)),
        ]);
        const boundaryTwd = STATE.categorizeEditPoints.map((x) => [
          Number(x.twd.e.toFixed(3)),
          Number(x.twd.n.toFixed(3)),
          Number(x.twd.h.toFixed(3)),
        ]);
        STATE.categorizeEditPoints = [];
        clearTempDistanceVisuals();
        submitCategorizeManualEdit("manual_add", "roads", null, {
          boundary_local: boundaryLoc,
          boundary_twd97: boundaryTwd,
        });
      } else if (STATE.categorizeEditMode === "add_wall" && STATE.categorizeEditPoints.length >= 2) {
        const p0 = STATE.categorizeEditPoints[0];
        const p1 = STATE.categorizeEditPoints[1];
        STATE.categorizeEditPoints = [];
        clearTempDistanceVisuals();
        submitCategorizeManualEdit("manual_add", "walls", null, {
          base_polyline_local: [
            [Number(p0.pt.x.toFixed(3)), Number(p0.pt.y.toFixed(3)), Number(p0.pt.z.toFixed(3))],
            [Number(p1.pt.x.toFixed(3)), Number(p1.pt.y.toFixed(3)), Number(p1.pt.z.toFixed(3))],
          ],
          base_polyline_twd97: [
            [Number(p0.twd.e.toFixed(3)), Number(p0.twd.n.toFixed(3)), Number(p0.twd.h.toFixed(3))],
            [Number(p1.twd.e.toFixed(3)), Number(p1.twd.n.toFixed(3)), Number(p1.twd.h.toFixed(3))],
          ],
          height_m: 2.5,
          mean_height_m: 2.5,
        });
      }
    } else if (e.key === "Enter" && STATE.activeView === "studio" && STATE.measurePoints.length >= 3) {
      if (studioThree && studioThree.polyPreviewGroup) {
        while (studioThree.polyPreviewGroup.children.length > 0) {
          studioThree.polyPreviewGroup.remove(studioThree.polyPreviewGroup.children[0]);
        }
      }
      const lockedPts = STATE.measurePoints.map((p) => p.clone());
      STATE.measurePoints = [];
      STATE.polygonLocked = true;
      if (STATE.activeTool === "volume") {
        STATE.maskBoundaryPoints = lockedPts.map((p) => p.clone());
        STATE.cutFillPolygonPoints = lockedPts;
        showToast(`Cut/Fill polygon locked (${lockedPts.length} vertices) — computing volume...`);
        openCutFillVolumeInspector(lockedPts);
      } else if (STATE.activeTool === "crop" || STATE.activeTool === "crop_delete") {
        const isDel = STATE.activeTool === "crop_delete";
        STATE.cropMode = isDel ? "delete_inside" : "keep_inside";
        if (!Array.isArray(STATE.pendingCropPolygons)) STATE.pendingCropPolygons = [];
        STATE.pendingCropPolygons.push(lockedPts);
        STATE.cropPolygonPoints = [];
        const selTris = rebuildLassoHighlight3D();
        showToast(
          isDel
            ? `Polygon #${STATE.pendingCropPolygons.length} marked (${selTris.toLocaleString()} tris) — mark more or press Delete`
            : `Keep Polygon #${STATE.pendingCropPolygons.length} marked (${selTris.toLocaleString()} tris)`
        );
        if (isDel) openLassoDeleteInspector({ armLasso: true });
        else openLassoKeepInspector({ armLasso: true });
      } else if (STATE.activeTool === "area") {
        STATE.completedMeasurements.push({
          id: `area_${Date.now()}`,
          type: "area",
          points: lockedPts.map((p) => p.clone()),
        });
        if (typeof rebuildAllCompletedMeasurements3D === "function") {
          rebuildAllCompletedMeasurements3D();
        } else if (typeof renderClosedAreaPolygon === "function") {
          renderClosedAreaPolygon(lockedPts, { preserveExistingAreas: true });
        }
        showToast(
          tr(
            `面積多邊形已閉合 (${lockedPts.length} 個頂點) — 可直接按住拖曳頂點調整範圍並重新計算面積`,
            `Area polygon locked (${lockedPts.length} vertices) — drag any vertex to adjust & recalculate area`
          )
        );
      } else if (STATE.activeTool === "contours") {
        STATE.maskBoundaryPoints = lockedPts.map((p) => p.clone());
        showToast(`Mask boundary locked (${lockedPts.length} vertices) — generating Contours, Civil3D.dxf & A3 PDF`);
        openContoursInspector(lockedPts);
      }
    }
  });

  document.getElementById("btnOpenOptimizer")?.addEventListener("click", () => {
    if (STATE.activeView !== "studio") switchView("studio", STATE.activeScanId);
    setActiveStudioTool("optimizer");
    openMeshCompressionInspector();
  });

  document.getElementById("btnStudioDownloadObj")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (STATE.multiAlign?.active) {
      showToast("Unavailable during Multi-Scan Editing — merge scans first to download unified mesh");
      return;
    }
    const dlBtn = document.getElementById("btnStudioDownloadObj");
    const activeScan =
      STATE.activeScan || STATE.scans.find((s) => s.scan_id === STATE.activeScanId) || null;
    if (dlBtn && activeScan) {
      openDownloadFormatMenu(dlBtn, activeScan);
    }
  });

  document.getElementById("btnStudioSurveyReport")?.addEventListener("click", (ev) => {
    if (STATE.multiAlign?.active) {
      ev.preventDefault();
      showToast("Unavailable during Multi-Scan Editing — merge scans first to generate a Survey Report");
      return;
    }
    if (STATE.activeView !== "studio") switchView("studio", STATE.activeScanId);
    STATE.measurePoints = [];
    STATE.polygonLocked = false;
    STATE.maskBoundaryPoints = [];
    setActiveStudioTool("contours");
    openContoursInspector();
  });


