/**
 * GatheringScans Frontend Module 08 — Advanced Surveying, Multi-Epoch Compare Profiling,
 * True Orthomosaic Map Overlay, Surface Drainage & Runoff, GCP Accuracy QA & 3D Photo Frustums
 */
"use strict";

  // ============================================================================
  // FEATURE 1: PERSISTENT MEASUREMENT SETS ("SAVED SURVEY VIEWS" / BOOKMARKS)
  // ============================================================================
  function serializeMeasurementEntryForBookmark(m) {
    if (!m || !m.type) return null;
    const vecToArr = (v) =>
      v && Number.isFinite(v.x)
        ? [Number(v.x.toFixed(4)), Number(v.y.toFixed(4)), Number(v.z.toFixed(4))]
        : null;
    if (m.type === "distance") {
      return {
        id: m.id || `dist_${Date.now()}`,
        type: "distance",
        p1: vecToArr(m.p1),
        p2: vecToArr(m.p2),
        dist: Number.isFinite(m.dist) ? Number(m.dist) : null,
      };
    }
    if (m.type === "angle") {
      return {
        id: m.id || `angle_${Date.now()}`,
        type: "angle",
        p1: vecToArr(m.p1),
        p2: vecToArr(m.p2),
        p3: vecToArr(m.p3),
        angleDeg: Number.isFinite(m.angleDeg) ? Number(m.angleDeg) : null,
      };
    }
    if (m.type === "coordinates") {
      return {
        id: m.id || `coord_${Date.now()}`,
        type: "coordinates",
        label: m.label || "P1",
        pt: vecToArr(m.pt),
        twd: m.twd ? { e: Number(m.twd.e), n: Number(m.twd.n), h: Number(m.twd.h) } : null,
      };
    }
    if (m.type === "laser") {
      return {
        id: m.id || `laser_${Date.now()}`,
        type: "laser",
        kind: m.kind || "road",
        originPt: vecToArr(m.originPt || m.origin),
        pA: vecToArr(m.pA || m.wHitA),
        pB: vecToArr(m.pB || m.wHitB),
        width: Number.isFinite(m.width) ? Number(m.width) : null,
        orthoLength: Number.isFinite(m.orthoLength) ? Number(m.orthoLength) : null,
        orthoPA: vecToArr(m.orthoPA || m.lHitA),
        orthoPB: vecToArr(m.orthoPB || m.lHitB),
        crossPt: vecToArr(m.crossPt),
        crossSlopePct: Number.isFinite(m.crossSlopePct) ? Number(m.crossSlopePct) : 0,
        areaM2: Number.isFinite(m.areaM2) ? Number(m.areaM2) : null,
        pitDepth: Number.isFinite(m.pitDepth) ? Number(m.pitDepth) : null,
        ceilHeight: Number.isFinite(m.ceilHeight) ? Number(m.ceilHeight) : null,
        ceilPt: vecToArr(m.ceilPt),
        floorPt: vecToArr(m.floorPt),
        slopeDeg: Number.isFinite(m.slopeDeg) ? Number(m.slopeDeg) : 0,
      };
    }
    if (m.type === "area" && Array.isArray(m.points)) {
      return {
        id: m.id || `area_${Date.now()}`,
        type: "area",
        points: m.points.map(vecToArr).filter(Boolean),
      };
    }
    return null;
  }

  function buildCurrentSurveyViewStatePayload() {
    const vecToArr = (v) =>
      v && Number.isFinite(v.x)
        ? [Number(v.x.toFixed(4)), Number(v.y.toFixed(4)), Number(v.z.toFixed(4))]
        : [0, 0, 0];
    const camPos = studioThree?.camera ? vecToArr(studioThree.camera.position) : [45, 38, 45];
    const camTarget = studioThree?.controls ? vecToArr(studioThree.controls.target) : [0, 0, 0];
    const completed = (Array.isArray(STATE.completedMeasurements) ? STATE.completedMeasurements : [])
      .map(serializeMeasurementEntryForBookmark)
      .filter(Boolean);
    const cutFillPts = (Array.isArray(STATE.cutFillPolygonPoints) ? STATE.cutFillPolygonPoints : [])
      .map(vecToArr)
      .filter(Boolean);
    const profilePts = (Array.isArray(STATE.profileEndpoints) ? STATE.profileEndpoints : [])
      .map(vecToArr)
      .filter(Boolean);
    return {
      camera: { pos: camPos, target: camTarget },
      completed_measurements: completed,
      cut_fill_polygon_points: cutFillPts,
      last_volume_result: STATE.lastVolumeResult || null,
      profile_endpoints: profilePts,
      last_profile_result: STATE.lastProfileResult || null,
      active_tool: STATE.activeTool || "distance",
    };
  }

  function restoreMeasurementBookmark(bookmark) {
    if (!bookmark || !studioThree) return;
    const st = bookmark.state || {};
    if (typeof clearMeasurements === "function") {
      clearMeasurements();
    }
    if (st.camera && Array.isArray(st.camera.pos) && st.camera.pos.length >= 3) {
      studioThree.camera.position.set(
        Number(st.camera.pos[0]) || 40,
        Number(st.camera.pos[1]) || 35,
        Number(st.camera.pos[2]) || 40
      );
      if (Array.isArray(st.camera.target) && st.camera.target.length >= 3) {
        studioThree.controls.target.set(
          Number(st.camera.target[0]) || 0,
          Number(st.camera.target[1]) || 0,
          Number(st.camera.target[2]) || 0
        );
      }
      studioThree.controls.update();
      studioThree.camera.updateMatrixWorld();
    }

    const arrToVec = (a) =>
      Array.isArray(a) && a.length >= 3
        ? new THREE.Vector3(Number(a[0]) || 0, Number(a[1]) || 0, Number(a[2]) || 0)
        : null;

    const list = Array.isArray(st.completed_measurements) ? st.completed_measurements : [];
    list.forEach((m, idx) => {
      if (!m || !m.type) return;
      if (m.type === "distance") {
        const p1 = arrToVec(m.p1);
        const p2 = arrToVec(m.p2);
        if (p1 && p2 && typeof renderDistanceVisuals === "function") {
          const measObj = {
            id: m.id || `dist_bmk_${idx}`,
            type: "distance",
            p1,
            p2,
            dist: Number.isFinite(m.dist) ? Number(m.dist) : p1.distanceTo(p2),
          };
          STATE.completedMeasurements.push(measObj);
          renderDistanceVisuals(null, measObj);
        }
      } else if (m.type === "angle") {
        const p1 = arrToVec(m.p1);
        const p2 = arrToVec(m.p2);
        const p3 = arrToVec(m.p3);
        if (p1 && p2 && p3 && typeof renderAngleVisuals === "function") {
          const v1 = p1.clone().sub(p2).normalize();
          const v2 = p3.clone().sub(p2).normalize();
          const fallbackDeg = THREE.MathUtils.radToDeg(Math.acos(Math.max(-1, Math.min(1, v1.dot(v2)))));
          const measObj = {
            id: m.id || `angle_bmk_${idx}`,
            type: "angle",
            p1,
            p2,
            p3,
            angleDeg: Number.isFinite(m.angleDeg) ? Number(m.angleDeg) : fallbackDeg,
          };
          STATE.completedMeasurements.push(measObj);
          renderAngleVisuals(null, measObj);
        }
      } else if (m.type === "coordinates") {
        const pt = arrToVec(m.pt);
        if (pt && typeof renderCoordinateVisuals === "function") {
          const twd = m.twd || (typeof localToTwd97 === "function" ? localToTwd97(pt) : { e: 0, n: 0, h: 0 });
          const measObj = {
            id: m.id || `coord_bmk_${idx}`,
            type: "coordinates",
            label: m.label || `P${idx + 1}`,
            pt,
            twd,
          };
          STATE.completedMeasurements.push(measObj);
          renderCoordinateVisuals(pt, measObj);
        }
      } else if (m.type === "laser") {
        const originPt = arrToVec(m.originPt || m.origin);
        const pA = arrToVec(m.pA || m.wHitA);
        const pB = arrToVec(m.pB || m.wHitB);
        const orthoPA = arrToVec(m.orthoPA || m.lHitA);
        const orthoPB = arrToVec(m.orthoPB || m.lHitB);
        if (originPt && typeof renderLaserVisuals === "function") {
          const width = Number.isFinite(m.width) ? Number(m.width) : pA && pB ? pA.distanceTo(pB) : null;
          const orthoLength = Number.isFinite(m.orthoLength)
            ? Number(m.orthoLength)
            : orthoPA && orthoPB
            ? orthoPA.distanceTo(orthoPB)
            : null;
          const measObj = {
            id: m.id || `laser_bmk_${idx}`,
            type: "laser",
            kind: m.kind || "road",
            originPt,
            pA,
            pB,
            width,
            orthoLength,
            orthoPA,
            orthoPB,
            crossPt: arrToVec(m.crossPt) || originPt.clone(),
            crossSlopePct: Number(m.crossSlopePct) || 0,
            areaM2: Number.isFinite(m.areaM2) ? Number(m.areaM2) : null,
            pitDepth: Number.isFinite(m.pitDepth) ? Number(m.pitDepth) : null,
            ceilHeight: Number.isFinite(m.ceilHeight) ? Number(m.ceilHeight) : null,
            ceilPt: arrToVec(m.ceilPt),
            floorPt: arrToVec(m.floorPt) || originPt.clone(),
            slopeDeg: Number(m.slopeDeg) || 0,
          };
          STATE.completedMeasurements.push(measObj);
          renderLaserVisuals(null, measObj);
        }
      } else if (m.type === "area" && Array.isArray(m.points)) {
        const pts = m.points.map(arrToVec).filter(Boolean);
        if (pts.length >= 3 && typeof renderClosedAreaPolygon === "function") {
          renderClosedAreaPolygon(pts);
          STATE.completedMeasurements.push({
            id: m.id || `area_bmk_${idx}`,
            type: "area",
            points: pts,
          });
        }
      }
    });

    if (Array.isArray(st.cut_fill_polygon_points) && st.cut_fill_polygon_points.length >= 3) {
      const cfPts = st.cut_fill_polygon_points.map(arrToVec).filter(Boolean);
      if (cfPts.length >= 3 && typeof drawPlacedCutFillPolygon3D === "function") {
        STATE.cutFillPolygonPoints = cfPts;
        STATE.polygonLocked = true;
        STATE.lastVolumeResult = st.last_volume_result || null;
        drawPlacedCutFillPolygon3D(cfPts, STATE.lastVolumeResult);
      }
    }

    if (Array.isArray(st.profile_endpoints) && st.profile_endpoints.length >= 2) {
      const p1 = arrToVec(st.profile_endpoints[0]);
      const p2 = arrToVec(st.profile_endpoints[1]);
      if (p1 && p2 && typeof drawProfileSectionLine3D === "function") {
        STATE.profileEndpoints = [p1, p2];
        STATE.lastProfileResult = st.last_profile_result || null;
        drawProfileSectionLine3D(p1, p2);
      }
    }

    if (typeof update2DBadgePositions === "function") {
      update2DBadgePositions();
    }
    showToast(
      tr(
        `已載入測量視角書籤：「${bookmark.title || "Saved View"}」`,
        `Restored Survey View Bookmark: "${bookmark.title || "Saved View"}"`
      )
    );
  }

  async function openSavedMeasurementsInspector() {
    setActiveStudioTool("bookmarks");
    STATE.sidePanelMinimized = false;
    const scanId = STATE.activeScanId;
    let bookmarks = Array.isArray(STATE.activeScan?.measurement_bookmarks)
      ? STATE.activeScan.measurement_bookmarks
      : [];
    try {
      const res = await apiGet(`/api/measurements/bookmarks?scan_id=${encodeURIComponent(scanId)}`);
      if (Array.isArray(res?.bookmarks)) {
        bookmarks = res.bookmarks;
        if (STATE.activeScan) STATE.activeScan.measurement_bookmarks = bookmarks;
      }
    } catch (_) {}

    const activeCount = Array.isArray(STATE.completedMeasurements) ? STATE.completedMeasurements.length : 0;
    const hasVol = Boolean(STATE.lastVolumeResult || (STATE.cutFillPolygonPoints && STATE.cutFillPolygonPoints.length >= 3));
    const hasProf = Boolean(STATE.profileEndpoints && STATE.profileEndpoints.length >= 2);

    const listHtml = bookmarks
      .map((b) => {
        const bid = escapeHtml(b.bookmark_id || "");
        const st = b.state || {};
        const mCount = Array.isArray(st.completed_measurements) ? st.completed_measurements.length : 0;
        const vTag = st.last_volume_result ? ` · 土方 ${Number(st.last_volume_result.net_volume_m3 || 0).toFixed(1)}m³` : "";
        const pTag = Array.isArray(st.profile_endpoints) && st.profile_endpoints.length >= 2 ? ` · 斷面 A→B` : "";
        return `
          <div class="gs-bookmark-card" data-bookmark-id="${bid}" style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border);border-radius:8px;padding:9px 10px;margin-top:8px;">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
              <div style="font-size:12px;font-weight:700;color:var(--ui-text-primary);">${escapeHtml(b.title || "Saved Survey View")}</div>
              <span style="font-size:10px;color:var(--ui-text-muted);">${escapeHtml((b.created_at || "").slice(0, 16))}</span>
            </div>
            <div style="font-size:11px;color:var(--ui-text-secondary);margin-top:3px;">
              ${tr(`${mCount} 筆量測${vTag}${pTag}`, `${mCount} measurement(s)${vTag}${pTag}`)} · ${escapeHtml(b.author_name || "Engineer")}
            </div>
            <div style="display:flex;gap:6px;margin-top:7px;">
              <button type="button" class="btn-xs primary" data-bookmark-load="${bid}" title="${tr("載入視角與量測", "Restore View & Measurements")}" style="flex:1;justify-content:center;">
                ${tr("載入", "Load")}
              </button>
              <button type="button" class="btn-xs" data-bookmark-delete="${bid}" title="${tr("刪除書籤", "Delete Bookmark")}" aria-label="${tr("刪除書籤", "Delete Bookmark")}" style="width:28px;padding:0;justify-content:center;color:#ef4444;border-color:rgba(239,68,68,0.35);">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
              </button>
            </div>
          </div>
        `;
      })
      .join("");

    showSidePanel(
      `<span>${tr(`測量視角書籤 (${bookmarks.length})`, `Saved Survey Views (${bookmarks.length})`)}</span>`,
      `
      <div style="font-size:11px;color:var(--ui-text-secondary);margin-bottom:8px;line-height:1.45;">
        ${tr(
          "將目前 3D 相機視角、所有已釘選量測（距離、角度、面積、座標、雷射）、土方挖填範圍與斷面線儲存至伺服器，方便團隊與業主一鍵重現。",
          "Save current 3D camera viewpoint, all pinned measurements, Cut/Fill polygon, and Cross-Section line to the server for 1-click recall."
        )}
      </div>
      <div style="background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:11px;color:var(--ui-text-primary);">
        <b>${tr("目前畫面狀態：", "Current Scene State:")}</b>
        ${tr(`${activeCount} 筆量測`, `${activeCount} measurements`)}
        ${hasVol ? tr(" · 含土方區域", " · Cut/Fill zone") : ""}
        ${hasProf ? tr(" · 含斷面線 A→B", " · Profile A→B") : ""}
      </div>
      <div class="gs-form-group" style="margin-bottom:8px;">
        <label>${tr("視角書籤名稱", "Bookmark Title")}</label>
        <input type="text" class="gs-input" id="txtNewBookmarkTitle" placeholder="${tr("例如：北側擋土牆淨寬與土方驗收", "e.g. North Retaining Wall & Stockpile Check")}" />
      </div>
      <button type="button" class="gs-top-btn accent" id="btnSaveMeasurementBookmark" title="${tr("儲存目前測量視角", "Save Current Survey View")}" style="width:100%;justify-content:center;margin-bottom:8px;">
        <span>${tr("💾 儲存", "💾 Save")}</span>
      </button>
      <div id="measurementBookmarksListBox">
        ${listHtml || `<div style="font-size:11.5px;color:var(--ui-text-muted);margin-top:6px;">${tr("尚無已儲存的測量視角書籤。", "No saved survey views yet for this scan.")}</div>`}
      </div>
      `
    );

    document.getElementById("btnSaveMeasurementBookmark")?.addEventListener("click", async () => {
      const titleInp = document.getElementById("txtNewBookmarkTitle");
      const title =
        (titleInp && titleInp.value.trim()) ||
        `${STATE.activeScan?.name || "Scan"} — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
      const statePayload = buildCurrentSurveyViewStatePayload();
      try {
        const res = await apiPost("/api/measurements/bookmarks", {
          action: "save",
          scan_id: STATE.activeScanId,
          title,
          author_email: STATE.currentUser?.email || "glibivanov@gatheren.com.tw",
          author_name: STATE.currentUser?.name || "雲在天",
          state: statePayload,
        });
        if (Array.isArray(res?.bookmarks) && STATE.activeScan) {
          STATE.activeScan.measurement_bookmarks = res.bookmarks;
        }
        showToast(tr(`已儲存測量視角書籤：「${title}」`, `Saved Survey View: "${title}"`));
        openSavedMeasurementsInspector();
      } catch (err) {
        showToast(`Bookmark Save Error: ${err.message}`);
      }
    });

    const box = document.getElementById("measurementBookmarksListBox");
    if (box) {
      box.querySelectorAll("[data-bookmark-load]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const bid = btn.getAttribute("data-bookmark-load");
          const found = bookmarks.find((x) => x.bookmark_id === bid);
          if (found) restoreMeasurementBookmark(found);
        });
      });
      box.querySelectorAll("[data-bookmark-delete]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const bid = btn.getAttribute("data-bookmark-delete");
          if (!bid) return;
          try {
            const res = await apiPost("/api/measurements/bookmarks/delete", {
              action: "delete",
              scan_id: STATE.activeScanId,
              bookmark_id: bid,
            });
            if (Array.isArray(res?.bookmarks) && STATE.activeScan) {
              STATE.activeScan.measurement_bookmarks = res.bookmarks;
            }
            showToast(tr("已刪除測量視角書籤", "Deleted survey view bookmark"));
            openSavedMeasurementsInspector();
          } catch (err) {
            showToast(`Bookmark Delete Error: ${err.message}`);
          }
        });
      });
    }
  }

  // ============================================================================
  // FEATURE 2: TRUE ORTHOMOSAIC (2D NADIR PLAN OVERLAY) ON THE GOOGLE MAP
  // ============================================================================
  function getOrLoadMapOrthoImage(scan) {
    if (!scan || !scan.scan_id) return null;
    const sid = scan.scan_id;
    if (!STATE.mapOrthoImageCache) STATE.mapOrthoImageCache = {};
    if (STATE.mapOrthoImageCache[sid]) {
      if (scan.ortho_bounds && !STATE.mapOrthoImageCache[sid].bounds) {
        STATE.mapOrthoImageCache[sid].bounds = scan.ortho_bounds;
      }
      return STATE.mapOrthoImageCache[sid];
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    const entry = {
      img,
      loaded: false,
      failed: false,
      isNadir: true,
      bounds: scan.ortho_bounds || null,
      fetchingMeta: false,
    };
    STATE.mapOrthoImageCache[sid] = entry;

    if (!entry.bounds && !entry.fetchingMeta) {
      entry.fetchingMeta = true;
      apiGet(`/api/scans/${encodeURIComponent(sid)}/ortho-meta`)
        .then((res) => {
          if (res && res.ortho_bounds) {
            entry.bounds = res.ortho_bounds;
            scan.ortho_bounds = res.ortho_bounds;
            if (typeof gsMap !== "undefined" && gsMap && typeof gsMap.drawMap === "function") {
              gsMap.drawMap();
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          entry.fetchingMeta = false;
        });
    }

    img.onload = () => {
      entry.loaded = true;
      entry.failed = false;
      if (typeof gsMap !== "undefined" && gsMap && typeof gsMap.drawMap === "function") {
        gsMap.drawMap();
      }
    };
    img.onerror = () => {
      entry.failed = true;
    };
    const qSuffix = STATE.shareToken ? `?share=${encodeURIComponent(STATE.shareToken)}` : "";
    img.src = scan.ortho_url || `/api/scans/${encodeURIComponent(sid)}/ortho${qSuffix}`;
    return entry;
  }

  function pickRepresentativeOrthoScanForGroup(grp, groupScans) {
    if (!Array.isArray(groupScans) || !groupScans.length) return null;
    if (STATE.activeProjectGroup && STATE.activeProjectGroup !== "__all__" && grp === STATE.activeProjectGroup) {
      if (STATE.selectedTimelineScanId) {
        const sel = groupScans.find((s) => s.scan_id === STATE.selectedTimelineScanId);
        if (sel) return sel;
      }
      if (STATE.activeScanId) {
        const act = groupScans.find((s) => s.scan_id === STATE.activeScanId);
        if (act) return act;
      }
    }
    const rtkPool = groupScans.filter(
      (s) =>
        !String(s.scan_id || "").toLowerCase().includes("nortk") &&
        !String(s.name || "").toLowerCase().includes("nortk")
    );
    const pool = rtkPool.length > 0 ? rtkPool : groupScans;
    const scored = pool.slice().sort((a, b) => {
      const aMerged =
        /merged|unified|整合/i.test(String(a.scan_id || "")) || /merged|unified|整合/i.test(String(a.name || ""))
          ? 1
          : 0;
      const bMerged =
        /merged|unified|整合/i.test(String(b.scan_id || "")) || /merged|unified|整合/i.test(String(b.name || ""))
          ? 1
          : 0;
      if (aMerged !== bMerged) return bMerged - aMerged;
      const aDate = String(a.capture_date || "");
      const bDate = String(b.capture_date || "");
      if (aDate !== bDate) return bDate.localeCompare(aDate);
      return (Number(b.covered_area_m2) || 0) - (Number(a.covered_area_m2) || 0);
    });
    return scored[0] || groupScans[0];
  }

  function drawMapTrueOrthoOverlays(ctx, mapInst) {
    if (!ctx || !mapInst || !STATE.mapOrthoOverlayEnabled) return;
    const opacity = Math.max(0.1, Math.min(1.0, Number(STATE.mapOrthoOpacity) || 0.78));
    const georefScans = (STATE.scans || []).filter(
      (s) =>
        s &&
        Number.isFinite(Number(s.lat)) &&
        Number.isFinite(Number(s.lon)) &&
        Math.abs(Number(s.lat)) > 0.001 &&
        !String(s.crs || "").toUpperCase().includes("LOCAL")
    );
    if (!georefScans.length) return;

    // Group georeferenced scans by project_group and draw strictly at most ONE (1) scan per site
    const byGroup = new Map();
    georefScans.forEach((s) => {
      const grp = s.project_group || s.scan_id;
      if (!byGroup.has(grp)) byGroup.set(grp, []);
      byGroup.get(grp).push(s);
    });

    const scansToDraw = [];
    byGroup.forEach((groupScans, grp) => {
      const rep = pickRepresentativeOrthoScanForGroup(grp, groupScans);
      if (rep) scansToDraw.push(rep);
    });

    scansToDraw.forEach((scan) => {
      const orthoEntry = getOrLoadMapOrthoImage(scan);
      if (!orthoEntry || !orthoEntry.loaded || orthoEntry.failed) return;
      const bounds = scan.ortho_bounds || orthoEntry.bounds;
      if (
        !bounds ||
        !Number.isFinite(Number(bounds.north_lat)) ||
        !Number.isFinite(Number(bounds.south_lat)) ||
        !Number.isFinite(Number(bounds.west_lon)) ||
        !Number.isFinite(Number(bounds.east_lon))
      ) {
        return;
      }

      const nwPx = mapInst.projectLatLon(Number(bounds.north_lat), Number(bounds.west_lon));
      const sePx = mapInst.projectLatLon(Number(bounds.south_lat), Number(bounds.east_lon));
      const x0 = Math.min(nwPx.x, sePx.x);
      const y0 = Math.min(nwPx.y, sePx.y);
      const boxW = Math.abs(sePx.x - nwPx.x);
      const boxH = Math.abs(sePx.y - nwPx.y);

      if (boxW < 6 || boxH < 6) return;
      if (x0 + boxW < 0 || x0 > mapInst.canvas.width || y0 + boxH < 0 || y0 > mapInst.canvas.height) {
        return;
      }

      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(orthoEntry.img, x0, y0, boxW, boxH);
      ctx.restore();
    });
  }

  async function captureNadirOrthoSnapshotForActiveScan(preferPreview = false) {
    const scanId =
      (preferPreview && STATE.selectedTimelineScanId) ||
      STATE.activeScanId ||
      (STATE.scans && STATE.scans[0]?.scan_id);
    if (!scanId) {
      showToast(tr("請先選擇 3D 掃描模型再更新正射疊圖", "Select a 3D scan first before updating Nadir Ortho"));
      return;
    }

    try {
      const res = await apiPost(`/api/scans/${encodeURIComponent(scanId)}/ortho`, {
        regenerate: true,
        force: true,
      });
      if (res && res.ortho_bounds) {
        const targetScan = (STATE.scans || []).find((s) => s.scan_id === scanId);
        if (targetScan) {
          targetScan.ortho_bounds = res.ortho_bounds;
          if (res.ortho_url) targetScan.ortho_url = res.ortho_url;
        }
        try {
          localStorage.removeItem(`gs_nadir_ortho_v2_${scanId}`);
          localStorage.setItem(`gs_nadir_ortho_bounds_v2_${scanId}`, JSON.stringify(res.ortho_bounds));
        } catch (_) {}
        if (!STATE.mapOrthoImageCache) STATE.mapOrthoImageCache = {};
        delete STATE.mapOrthoImageCache[scanId];
        if (targetScan) getOrLoadMapOrthoImage(targetScan);
        STATE.mapOrthoOverlayEnabled = true;
        document.getElementById("btnMapToggleOrthoOverlay")?.classList.add("active");
        if (typeof gsMap !== "undefined" && gsMap && typeof gsMap.drawMap === "function") {
          gsMap.drawMap();
        }
        showToast(
          tr(
            "已重新產製 TWD97 真實正射透明疊圖 (True-Nadir RGBA Ortho) 並對齊至地圖！",
            "Regenerated TWD97 True-Nadir transparent RGBA orthomosaic and aligned on Map!"
          )
        );
        return;
      }
    } catch (_) {}

    const viewer = preferPreview && typeof previewThree !== "undefined" && previewThree ? previewThree : studioThree;
    if (!viewer || !viewer.renderer || !viewer.scene) {
      showToast(tr("請先載入 3D 掃描模型再擷取正射疊圖", "Load a 3D scan first before capturing Nadir Ortho"));
      return;
    }
    const r = Math.max(18, Math.min(160, Number(viewer.boundingSphere?.radius) || 45));
    const orthoCam = new THREE.OrthographicCamera(-r, r, r, -r, 0.5, r * 8 + 500);
    const target = viewer.controls?.target ? viewer.controls.target.clone() : new THREE.Vector3(0, 0, 0);
    orthoCam.position.set(target.x, target.y + r * 3.5 + 80, target.z);
    orthoCam.up.set(0, 0, -1);
    orthoCam.lookAt(target);
    orthoCam.updateProjectionMatrix();
    orthoCam.updateMatrixWorld();

    const prevBg = viewer.scene.background;
    const prevClearAlpha = viewer.renderer.getClearAlpha ? viewer.renderer.getClearAlpha() : 1.0;
    viewer.scene.background = null;
    if (viewer.renderer.setClearColor) viewer.renderer.setClearColor(0x000000, 0);
    viewer.renderer.render(viewer.scene, orthoCam);
    const dataUrl = viewer.renderer.domElement.toDataURL("image/png");
    viewer.scene.background = prevBg;
    if (viewer.renderer.setClearAlpha) viewer.renderer.setClearAlpha(prevClearAlpha);
    viewer.renderer.render(viewer.scene, viewer.camera);

    const targetScan = (STATE.scans || []).find((s) => s.scan_id === scanId);
    const lat = Number(targetScan?.lat || 25.03);
    const lon = Number(targetScan?.lon || 121.52);
    const dLat = r / 110750.0;
    const dLon = r / (111320.0 * Math.max(0.25, Math.cos((lat * Math.PI) / 180.0)));
    const fallbackBounds = targetScan?.ortho_bounds || {
      north_lat: lat + dLat,
      south_lat: lat - dLat,
      west_lon: lon - dLon,
      east_lon: lon + dLon,
    };

    try {
      localStorage.setItem(`gs_nadir_ortho_v2_${scanId}`, dataUrl);
      localStorage.setItem(`gs_nadir_ortho_bounds_v2_${scanId}`, JSON.stringify(fallbackBounds));
    } catch (_) {}
    if (!STATE.mapOrthoImageCache) STATE.mapOrthoImageCache = {};
    const img = new Image();
    const entry = { img, loaded: false, failed: false, isNadir: true, bounds: fallbackBounds };
    STATE.mapOrthoImageCache[scanId] = entry;
    img.onload = () => {
      entry.loaded = true;
      if (typeof gsMap !== "undefined" && gsMap && typeof gsMap.drawMap === "function") {
        gsMap.drawMap();
      }
    };
    img.src = dataUrl;

    try {
      await apiPost(`/api/scans/${encodeURIComponent(scanId)}/ortho`, {
        data_url: dataUrl,
        ortho_bounds: fallbackBounds,
      });
    } catch (_) {}

    STATE.mapOrthoOverlayEnabled = true;
    document.getElementById("btnMapToggleOrthoOverlay")?.classList.add("active");
    showToast(
      tr(
        "已擷取正射俯視影像 (Nadir Ortho) 並更新至地圖 2D 疊圖！",
        "Captured Nadir Orthomosaic snapshot and updated Map 2D Ortho Overlay!"
      )
    );
  }

  // ============================================================================
  // FEATURE 3: QUANTITATIVE MULTI-EPOCH CROSS-SECTION PROFILE (A->B) & ΔZ PROBE IN COMPARE MODE
  // ============================================================================
  const COMPARE_EPOCH_COLORS = ["#38bdf8", "#10b981", "#f59e0b", "#a855f7"];
  const _cmpRaycaster = new THREE.Raycaster();
  const _cmpDownOrigin = new THREE.Vector3();
  const _cmpDownDir = new THREE.Vector3(0, -1, 0);

  function sampleCompareSideHeightAtXZ(side, x, z) {
    if (!side) return { y: 0, twdH: 0, hit: false };
    const meshes = [];
    side.pivot?.traverse((c) => {
      if (c.isMesh && c.visible) meshes.push(c);
    });
    if (!meshes.length && side.fallbackGroup?.visible) {
      side.fallbackGroup.traverse((c) => {
        if (c.isMesh && c.visible) meshes.push(c);
      });
    }
    let yVal = null;
    let hit = false;
    if (meshes.length > 0) {
      _cmpDownOrigin.set(x, 600, z);
      _cmpRaycaster.set(_cmpDownOrigin, _cmpDownDir);
      const hits = _cmpRaycaster.intersectObjects(meshes, true);
      if (hits && hits.length > 0) {
        yVal = hits[0].point.y;
        hit = true;
      }
    }
    if (yVal === null) {
      // Deterministic analytical fallback matching Compare fallback mesh when tiles are still streaming
      const r2 = (x * x + z * z) / (13.5 * 13.5);
      const r2b = ((x - 11) * (x - 11) + (z + 8) * (z + 8)) / (9.5 * 9.5);
      const peak = side.isLatest ? 5.6 : 1.15;
      yVal =
        0.02 * x -
        0.015 * z +
        0.45 * Math.sin(x * 0.12) * Math.cos(z * 0.12) +
        (r2 < 2.8 ? peak * Math.exp(-1.45 * r2) : 0.0) +
        (r2b < 2.4 ? (side.isLatest ? 2.8 : 0.6) * Math.exp(-1.6 * r2b) : 0.0);
    }
    const baseH = Number(side.scanMeta?.twd97_h) || 120.0;
    return { y: Number(yVal.toFixed(3)), twdH: Number((baseH + yVal).toFixed(3)), hit };
  }

  function clearCompareSurveyOverlays(ctx) {
    if (!ctx) return;
    [ctx.left, ctx.right, ctx.third, ctx.fourth].forEach((side) => {
      if (side && side._compareSurveyGroup) {
        while (side._compareSurveyGroup.children.length > 0) {
          side._compareSurveyGroup.remove(side._compareSurveyGroup.children[0]);
        }
      }
    });
  }

  function ensureCompareSideSurveyGroup(side) {
    if (!side || !side.scene) return null;
    if (!side._compareSurveyGroup) {
      side._compareSurveyGroup = new THREE.Group();
      side.scene.add(side._compareSurveyGroup);
    }
    return side._compareSurveyGroup;
  }

  function unprojectCompareStageEventToWorldXZ(e, ctx) {
    const stage = document.getElementById("compareStage");
    if (!stage || !ctx || !ctx.left) return null;
    const rect = stage.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    _cmpRaycaster.setFromCamera(ndc, ctx.left.camera);
    const meshes = [];
    const activeSides = typeof getActiveCompareSides === "function" ? getActiveCompareSides() : [ctx.left, ctx.right];
    activeSides.forEach((s) => {
      s?.pivot?.traverse((c) => {
        if (c.isMesh && c.visible) meshes.push(c);
      });
      if (s?.fallbackGroup?.visible) {
        s.fallbackGroup.traverse((c) => {
          if (c.isMesh && c.visible) meshes.push(c);
        });
      }
    });
    if (meshes.length > 0) {
      const hits = _cmpRaycaster.intersectObjects(meshes, true);
      if (hits && hits.length > 0) {
        return { x: hits[0].point.x, y: hits[0].point.y, z: hits[0].point.z };
      }
    }
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const pt = new THREE.Vector3();
    if (_cmpRaycaster.ray.intersectPlane(plane, pt)) {
      return { x: pt.x, y: pt.y, z: pt.z };
    }
    return null;
  }

  function evaluateCompareDeltaZProbeAtXZ(x, z, ctx) {
    const activeSides = typeof getActiveCompareSides === "function" ? getActiveCompareSides() : [ctx.left, ctx.right];
    clearCompareSurveyOverlays(ctx);
    const samples = activeSides.map((side, idx) => {
      const s = sampleCompareSideHeightAtXZ(side, x, z);
      const grp = ensureCompareSideSurveyGroup(side);
      if (grp) {
        const col = new THREE.Color(COMPARE_EPOCH_COLORS[idx % COMPARE_EPOCH_COLORS.length]);
        const sph = new THREE.Mesh(
          new THREE.SphereGeometry(0.42, 16, 16),
          new THREE.MeshBasicMaterial({ color: col, depthTest: false })
        );
        sph.position.set(x, s.y, z);
        sph.renderOrder = 999;
        grp.add(sph);
      }
      return {
        idx: idx + 1,
        name: side.scanMeta?.name || side._loadedScanId || `Scan ${idx + 1}`,
        date: side.scanMeta?.capture_date || "",
        y: s.y,
        twdH: s.twdH,
        color: COMPARE_EPOCH_COLORS[idx % COMPARE_EPOCH_COLORS.length],
      };
    });

    const pill = document.getElementById("compareDeltaZReadoutPill");
    if (!pill || samples.length < 2) return;
    const dz21 = Number((samples[1].y - samples[0].y).toFixed(3));
    const dzCm = (dz21 * 100).toFixed(1);
    const isLight =
      document.documentElement.getAttribute("data-theme") === "light" ||
      document.body.classList.contains("theme-light");
    const dzColor = dz21 >= 0 ? (isLight ? "#059669" : "#10b981") : isLight ? "#0284c7" : "#38bdf8";
    const dzPillBg = isLight ? "rgba(241, 245, 249, 0.96)" : "rgba(15, 23, 42, 0.85)";
    const itemsHtml = samples
      .map(
        (s) =>
          `<span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:8px;height:8px;border-radius:50%;background:${s.color};display:inline-block;"></span><b>Z${s.idx}:</b> +${s.twdH.toFixed(2)}m</span>`
      )
      .join(" · ");
    pill.style.display = "flex";
    pill.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11.5px;font-family:var(--font-mono);">
        ${itemsHtml}
        <span style="padding:2px 8px;border-radius:999px;background:${dzPillBg};color:${dzColor};font-weight:800;border:1px solid ${dzColor};">
          ΔZ (Scan 2 − Scan 1) = ${dz21 >= 0 ? "+" : ""}${dz21.toFixed(3)} m (${dz21 >= 0 ? "+" : ""}${dzCm} cm · ${dz21 >= 0 ? tr("填方/堆高", "FILL") : tr("挖方/沉陷", "CUT")})
        </span>
      </div>
    `;
  }

  function computeAndRenderCompareMultiEpochProfile(pA, pB, ctx) {
    const activeSides = typeof getActiveCompareSides === "function" ? getActiveCompareSides() : [ctx.left, ctx.right];
    if (!activeSides.length) return;
    clearCompareSurveyOverlays(ctx);

    const N = 60;
    const totalLen = Math.max(0.1, Math.hypot(pB.x - pA.x, pB.z - pA.z));
    const stations = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      stations.push({
        t,
        dist: Number((t * totalLen).toFixed(2)),
        x: pA.x + (pB.x - pA.x) * t,
        z: pA.z + (pB.z - pA.z) * t,
      });
    }

    const series = activeSides.map((side, idx) => {
      const color = COMPARE_EPOCH_COLORS[idx % COMPARE_EPOCH_COLORS.length];
      const pts3D = [];
      const values = stations.map((st) => {
        const s = sampleCompareSideHeightAtXZ(side, st.x, st.z);
        pts3D.push(new THREE.Vector3(st.x, s.y + 0.08, st.z));
        return { dist: st.dist, y: s.y, twdH: s.twdH };
      });
      const grp = ensureCompareSideSurveyGroup(side);
      if (grp && pts3D.length >= 2) {
        const lineGeo = new THREE.BufferGeometry().setFromPoints(pts3D);
        const lineMat = new THREE.LineBasicMaterial({ color: new THREE.Color(color), depthTest: false });
        const line = new THREE.Line(lineGeo, lineMat);
        line.renderOrder = 998;
        grp.add(line);
      }
      return {
        idx: idx + 1,
        scanId: side._loadedScanId || side.scanMeta?.scan_id || `scan_${idx + 1}`,
        name: side.scanMeta?.name || `Scan ${idx + 1}`,
        date: side.scanMeta?.capture_date || "",
        color,
        values,
      };
    });

    let maxAbsDz = 0;
    let netAreaM2 = 0;
    if (series.length >= 2) {
      const stepD = totalLen / N;
      for (let i = 0; i <= N; i++) {
        const dz = series[1].values[i].twdH - series[0].values[i].twdH;
        if (Math.abs(dz) > maxAbsDz) maxAbsDz = Math.abs(dz);
        if (i < N) netAreaM2 += dz * stepD;
      }
    }

    STATE.lastCompareMultiProfile = { totalLen, stations, series, maxAbsDz, netAreaM2 };
    const drawer = document.getElementById("compareProfileDrawer");
    if (drawer) drawer.style.display = "block";
    const summaryEl = document.getElementById("lblCompareProfileSummary");
    if (summaryEl) {
      summaryEl.textContent = `L = ${totalLen.toFixed(2)} m · Max |ΔZ| = ${maxAbsDz.toFixed(2)} m · ΔArea = ${netAreaM2 >= 0 ? "+" : ""}${netAreaM2.toFixed(2)} m²`;
    }
    drawCompareMultiProfileChart(STATE.lastCompareMultiProfile);
  }

  function drawCompareMultiProfileChart(profData, hoverIdx = -1) {
    const canvas = document.getElementById("compareMultiProfileCanvas");
    if (!canvas || !profData || !Array.isArray(profData.series) || !profData.series.length) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    let minH = Infinity;
    let maxH = -Infinity;
    profData.series.forEach((s) => {
      s.values.forEach((v) => {
        if (v.twdH < minH) minH = v.twdH;
        if (v.twdH > maxH) maxH = v.twdH;
      });
    });
    if (!Number.isFinite(minH) || !Number.isFinite(maxH)) return;
    if (maxH - minH < 1.0) {
      minH -= 0.5;
      maxH += 0.5;
    }
    const padL = 54,
      padR = 20,
      padT = 24,
      padB = 26;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const xOf = (i, n) => padL + (i / Math.max(1, n)) * plotW;
    const yOf = (val) => padT + (1 - (val - minH) / Math.max(0.01, maxH - minH)) * plotH;

    // Grid lines
    ctx.strokeStyle = "rgba(148, 163, 184, 0.22)";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#94a3b8";
    ctx.font = "600 10px Consolas, monospace";
    for (let g = 0; g <= 3; g++) {
      const gy = padT + (g / 3) * plotH;
      const gh = maxH - (g / 3) * (maxH - minH);
      ctx.beginPath();
      ctx.moveTo(padL, gy);
      ctx.lineTo(w - padR, gy);
      ctx.stroke();
      ctx.fillText(`${gh.toFixed(1)}m`, 6, gy + 3);
    }

    // Cut/Fill shaded delta between Scan 1 & Scan 2
    if (profData.series.length >= 2) {
      const s0 = profData.series[0].values;
      const s1 = profData.series[1].values;
      const n = s0.length - 1;
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const px = xOf(i, n),
          py = yOf(s1[i].twdH);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      for (let i = n; i >= 0; i--) {
        ctx.lineTo(xOf(i, n), yOf(s0[i].twdH));
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(16, 185, 129, 0.16)";
      ctx.fill();
      ctx.restore();
    }

    // Draw each scan's elevation profile curve
    profData.series.forEach((s, sIdx) => {
      const n = s.values.length - 1;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      s.values.forEach((v, i) => {
        const px = xOf(i, n);
        const py = yOf(v.twdH);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();

      // Legend label at top
      ctx.fillStyle = s.color;
      ctx.font = "700 10.5px Inter, system-ui, sans-serif";
      ctx.fillText(`● Scan ${s.idx}: ${(s.name || "").slice(0, 18)}`, padL + sIdx * 175, 14);
    });

    if (hoverIdx >= 0 && profData.stations[hoverIdx]) {
      const n = profData.stations.length - 1;
      const hx = xOf(hoverIdx, n);
      ctx.strokeStyle = "#f8fafc";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, h - padB);
      ctx.stroke();
    }
  }

  function exportCompareMultiProfileCsv() {
    const prof = STATE.lastCompareMultiProfile;
    if (!prof || !Array.isArray(prof.series) || !prof.series.length) return;
    const headers = ["Station_m", ...prof.series.map((s) => `Scan${s.idx}_${s.scanId}_TWVD2001_H_m`)];
    if (prof.series.length >= 2) headers.push("DeltaZ_Scan2_minus_Scan1_m");
    const rows = [headers.join(",")];
    prof.stations.forEach((st, i) => {
      const cols = [st.dist.toFixed(2), ...prof.series.map((s) => s.values[i].twdH.toFixed(3))];
      if (prof.series.length >= 2) {
        cols.push((prof.series[1].values[i].twdH - prof.series[0].values[i].twdH).toFixed(4));
      }
      rows.push(cols.join(","));
    });
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `multi_epoch_profile_${Date.now()}.csv`;
    a.click();
  }

  function initCompareSurveyingTools(ctx) {
    if (!ctx || ctx._surveyingToolsWired) return;
    ctx._surveyingToolsWired = true;

    const btnProbe = document.getElementById("btnCompareDeltaZProbe");
    const btnProfile = document.getElementById("btnCompareMultiProfile");
    const stage = document.getElementById("compareStage");

    const syncButtons = () => {
      btnProbe?.classList.toggle("active", STATE.compareTool === "dz_probe");
      btnProfile?.classList.toggle("active", STATE.compareTool === "multi_profile");
      if (STATE.compareTool !== "dz_probe") {
        const pill = document.getElementById("compareDeltaZReadoutPill");
        if (pill) pill.style.display = "none";
      }
    };

    btnProbe?.addEventListener("click", () => {
      STATE.compareTool = STATE.compareTool === "dz_probe" ? "none" : "dz_probe";
      STATE.compareProfilePoints = [];
      syncButtons();
      if (STATE.compareTool === "dz_probe") {
        evaluateCompareDeltaZProbeAtXZ(0, 0, ctx);
        showToast(tr("已啟用高程差探針 ΔZ：於比對畫面上移動或點擊即可量測各期高程差", "ΔZ Probe active: Hover or click on the 3D surface to inspect multi-epoch ΔZ"));
      } else {
        clearCompareSurveyOverlays(ctx);
      }
    });

    btnProfile?.addEventListener("click", () => {
      STATE.compareTool = STATE.compareTool === "multi_profile" ? "none" : "multi_profile";
      STATE.compareProfilePoints = [];
      syncButtons();
      if (STATE.compareTool === "multi_profile") {
        computeAndRenderCompareMultiEpochProfile({ x: -16, z: -10 }, { x: 18, z: 12 }, ctx);
        showToast(tr("跨期斷面比較 A→B：可於畫面上點擊起點 A 與終點 B 自訂斷面位置", "Multi-Epoch Profile A→B: Click Start Point A and End Point B on the 3D scan"));
      } else {
        clearCompareSurveyOverlays(ctx);
      }
    });

    document.getElementById("btnExportCompareProfileCsv")?.addEventListener("click", exportCompareMultiProfileCsv);
    document.getElementById("btnClearCompareProfile")?.addEventListener("click", () => {
      STATE.compareProfilePoints = [];
      clearCompareSurveyOverlays(ctx);
      showToast(tr("請於比對畫面上點擊斷面起點 A 與終點 B", "Click Start Point A and End Point B on the 3D scan"));
    });
    document.getElementById("btnCloseCompareProfileDrawer")?.addEventListener("click", () => {
      const d = document.getElementById("compareProfileDrawer");
      if (d) d.style.display = "none";
      STATE.compareTool = "none";
      syncButtons();
      clearCompareSurveyOverlays(ctx);
    });

    stage?.addEventListener("pointermove", (e) => {
      if (STATE.activeView !== "compare" || STATE.compareTool !== "dz_probe" || e.buttons > 0) return;
      const pt = unprojectCompareStageEventToWorldXZ(e, ctx);
      if (pt) evaluateCompareDeltaZProbeAtXZ(pt.x, pt.z, ctx);
    });

    stage?.addEventListener("click", (e) => {
      if (STATE.activeView !== "compare" || STATE.compareTool === "none") return;
      if (e.target && e.target.closest && e.target.closest(".gs-compare-hud, .gs-compare-profile-drawer, .gs-curtain-divider")) {
        return;
      }
      const pt = unprojectCompareStageEventToWorldXZ(e, ctx);
      if (!pt) return;
      if (STATE.compareTool === "dz_probe") {
        evaluateCompareDeltaZProbeAtXZ(pt.x, pt.z, ctx);
      } else if (STATE.compareTool === "multi_profile") {
        if (!Array.isArray(STATE.compareProfilePoints)) STATE.compareProfilePoints = [];
        STATE.compareProfilePoints.push(pt);
        if (STATE.compareProfilePoints.length === 1) {
          showToast(tr("已設定跨期斷面起點 A — 請點擊終點 B", "Multi-Epoch Profile Start A placed — click End Point B"));
        } else if (STATE.compareProfilePoints.length >= 2) {
          const [pA, pB] = STATE.compareProfilePoints;
          STATE.compareProfilePoints = [];
          computeAndRenderCompareMultiEpochProfile(pA, pB, ctx);
        }
      }
    });
  }

  // ============================================================================
  // FEATURE 4: SURFACE DRAINAGE / STEPPED 1:N SLOPE ARROWS & LEGEND (ZERO-FREEZE)
  // ============================================================================
  const SLOPE_STEPPED_TIERS = [
    {
      id: "flat_200",
      ratioRange: "< 1:200",
      pctRange: "< 0.5%",
      labelZh: "平緩 / 積水潛勢 (< 1:200)",
      labelEn: "Flat / Ponding (< 1:200)",
      color: "#38bdf8",
      rgb: [0.22, 0.741, 0.973],
      minS: 0.0,
      maxS: 0.005,
      lenScale: 0.38,
    },
    {
      id: "gentle_100",
      ratioRange: "1:200 – 1:100",
      pctRange: "0.5% – 1.0%",
      labelZh: "微緩排水坡 (1:200 – 1:100)",
      labelEn: "Gentle Drainage (1:200 – 1:100)",
      color: "#10b981",
      rgb: [0.063, 0.725, 0.506],
      minS: 0.005,
      maxS: 0.01,
      lenScale: 0.52,
    },
    {
      id: "mod_50",
      ratioRange: "1:100 – 1:50",
      pctRange: "1.0% – 2.0%",
      labelZh: "標準路面排水坡 (1:100 – 1:50)",
      labelEn: "Standard Grade (1:100 – 1:50)",
      color: "#84cc16",
      rgb: [0.518, 0.8, 0.086],
      minS: 0.01,
      maxS: 0.02,
      lenScale: 0.66,
    },
    {
      id: "brisk_20",
      ratioRange: "1:50 – 1:20",
      pctRange: "2.0% – 5.0%",
      labelZh: "明顯斜坡 (1:50 – 1:20)",
      labelEn: "Brisk Slope (1:50 – 1:20)",
      color: "#eab308",
      rgb: [0.918, 0.702, 0.031],
      minS: 0.02,
      maxS: 0.05,
      lenScale: 0.80,
    },
    {
      id: "steep_10",
      ratioRange: "1:20 – 1:10",
      pctRange: "5.0% – 10.0%",
      labelZh: "陡坡 / 坡道 (1:20 – 1:10)",
      labelEn: "Steep Ramp (1:20 – 1:10)",
      color: "#f97316",
      rgb: [0.976, 0.451, 0.086],
      minS: 0.05,
      maxS: 0.10,
      lenScale: 0.94,
    },
    {
      id: "vsteep",
      ratioRange: "> 1:10",
      pctRange: "> 10.0%",
      labelZh: "急陡邊坡 (> 1:10)",
      labelEn: "Very Steep (> 1:10)",
      color: "#ef4444",
      rgb: [0.937, 0.267, 0.267],
      minS: 0.10,
      maxS: 999.0,
      lenScale: 1.08,
    },
  ];

  function classifySlopeRatioTier(slopeVal) {
    const s = Math.max(0, Number(slopeVal) || 0);
    for (let i = 0; i < SLOPE_STEPPED_TIERS.length; i++) {
      if (s < SLOPE_STEPPED_TIERS[i].maxS) return SLOPE_STEPPED_TIERS[i];
    }
    return SLOPE_STEPPED_TIERS[SLOPE_STEPPED_TIERS.length - 1];
  }

  function updateStudioDrainageLegendHud(stats) {
    const container = document.getElementById("studioCanvasContainer");
    if (!container) return;
    let hud = document.getElementById("studioDrainageLegendHud");
    if (!stats || STATE.activeTool !== "drainage") {
      if (hud) hud.style.display = "none";
      return;
    }
    if (!hud) {
      hud = document.createElement("div");
      hud.id = "studioDrainageLegendHud";
      hud.className = "gs-drainage-floating-legend";
      hud.style.cssText =
        "position:absolute;bottom:78px;left:14px;z-index:45;background:var(--ui-bg-window);backdrop-filter:blur(12px);border:1px solid var(--ui-border-strong);border-radius:10px;padding:10px 12px;min-width:215px;box-shadow:var(--ui-shadow-hud);pointer-events:auto;font-size:11px;color:var(--ui-text-primary);";
      container.appendChild(hud);
    }
    const tierCounts = stats.tier_counts || {};
    const total = Math.max(1, Number(stats.arrow_count) || 0);
    hud.style.display = "block";
    hud.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;padding-bottom:5px;border-bottom:1px solid var(--ui-border);">
        <span style="font-weight:700;font-size:11.5px;">${tr("坡度分級圖例 (1:N 階梯色)", "Slope Legend (Stepped 1:N)")}</span>
        <span style="font-size:10px;color:var(--ui-text-secondary);font-family:var(--font-mono);">${stats.arrow_count || 0} ${tr("箭頭", "arrows")}</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        ${SLOPE_STEPPED_TIERS.map((t) => {
          const cnt = Number(tierCounts[t.id] || 0);
          const pct = stats.arrow_count ? ((cnt * 100) / total).toFixed(0) : "0";
          const barW = Math.round(t.lenScale * 24);
          return `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <div style="display:flex;align-items:center;gap:6px;">
                <span style="display:inline-block;width:11px;height:11px;border-radius:3px;background:${t.color};flex-shrink:0;border:1px solid rgba(255,255,255,0.28);"></span>
                <span style="font-family:var(--font-mono);font-weight:700;font-size:11px;min-width:78px;">${t.ratioRange}</span>
                <span style="display:inline-block;height:3px;width:${barW}px;background:${t.color};border-radius:2px;" title="Arrow length scale"></span>
              </div>
              <span style="font-size:10.5px;color:var(--ui-text-secondary);font-family:var(--font-mono);">${t.pctRange} (${pct}%)</span>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  function clearDrainageVisuals3D() {
    const hud = document.getElementById("studioDrainageLegendHud");
    if (hud) hud.style.display = "none";
    if (!studioThree || !studioThree.overlayGroup) return;
    if (studioThree.drainageGroup) {
      studioThree.overlayGroup.remove(studioThree.drainageGroup);
      studioThree.drainageGroup = null;
    }
  }

  const _drainageLabelTexCache = new Map();
  function createSlopeRatioSprite(ratioLabel, hexColor) {
    const isLight =
      document.documentElement.getAttribute("data-theme") === "light" ||
      document.body.classList.contains("theme-light");
    const themeTag = isLight ? "light" : "dark";
    const cacheKey = `${ratioLabel}_${hexColor}_${themeTag}`;
    let tex = _drainageLabelTexCache.get(cacheKey);
    if (!tex) {
      const c = document.createElement("canvas");
      c.width = 112;
      c.height = 40;
      const ctx = c.getContext("2d");
      ctx.fillStyle = isLight ? "rgba(255, 255, 255, 0.94)" : "rgba(15, 23, 42, 0.86)";
      ctx.strokeStyle = hexColor;
      ctx.lineWidth = 3;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(2, 2, 108, 36, 8);
      else ctx.rect(2, 2, 108, 36);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = isLight ? "#0f172a" : hexColor;
      ctx.font = "700 18px JetBrains Mono, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(ratioLabel, 56, 21);
      tex = new THREE.CanvasTexture(c);
      tex.needsUpdate = true;
      if (_drainageLabelTexCache.size > 200) _drainageLabelTexCache.clear();
      _drainageLabelTexCache.set(cacheKey, tex);
    }
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: true, depthWrite: false, transparent: true });
    const sp = new THREE.Sprite(mat);
    sp.renderOrder = 999;
    return sp;
  }

  // Zero-raycast, instant (<2ms) vertex-binned surface slope & drainage arrow generator
  // Strictly restricted to actual scanned mesh surfaces (never spawns arrows in empty voids or water bodies)
  function isPointInPolygon2D(px, pz, polyXZ) {
    if (!Array.isArray(polyXZ) || polyXZ.length < 3) return false;
    let inside = false;
    for (let i = 0, j = polyXZ.length - 1; i < polyXZ.length; j = i++) {
      const xi = Number(polyXZ[i][0]) || 0;
      const zi = Number(polyXZ[i][1]) || 0;
      const xj = Number(polyXZ[j][0]) || 0;
      const zj = Number(polyXZ[j][1]) || 0;
      const intersect = zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi + 1e-12) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function getActiveScanWaterPolysLocalXZ() {
    const polys = [];
    const cat =
      (STATE.lastCategorizeResult && STATE.lastCategorizeResult.scan_id === STATE.activeScanId
        ? STATE.lastCategorizeResult
        : null) ||
      STATE.activeScan?.categorization ||
      null;
    const waterList = Array.isArray(cat?.water_bodies) ? cat.water_bodies : [];
    for (let i = 0; i < waterList.length; i++) {
      const wb = waterList[i];
      const bLocal = Array.isArray(wb?.boundary_local) ? wb.boundary_local : [];
      if (bLocal.length >= 3) {
        polys.push(bLocal.map((pt) => [Number(pt[0]) || 0, Number(pt[2] !== undefined ? pt[2] : pt[1]) || 0]));
      }
    }
    return polys;
  }

  function isPointInsideAnyWaterPolyXZ(px, pz, waterPolys) {
    for (let i = 0; i < waterPolys.length; i++) {
      if (isPointInPolygon2D(px, pz, waterPolys[i])) return true;
    }
    return false;
  }

  function buildFastStudioSurfaceArrows(gridSize = 20, excludeWalls = true, densityPerM2 = null) {
    const G = Math.max(8, Math.min(40, Number(gridSize) || 20));
    const densityVal = Math.max(
      0.04,
      Math.min(2.0, Number(densityPerM2 ?? STATE.drainageDensityPerM2) || 0.25)
    );
    const targetStepM = Math.max(0.65, 1.0 / Math.sqrt(Math.max(0.02, densityVal)));
    const meshes = [];
    let totalVerts = 0;

    const collectFromRoot = (rootObj) => {
      if (!rootObj || !rootObj.visible) return;
      rootObj.updateMatrixWorld(true);
      const isTilesGrp = Boolean(studioThree?.tilesRenderer?.group && rootObj === studioThree.modelPivot);
      rootObj.traverse((c) => {
        if (
          c.isMesh &&
          c.geometry &&
          c.geometry.attributes &&
          c.geometry.attributes.position &&
          (isTilesGrp || isMeshVisibleUnderRoot(c, rootObj)) &&
          !c.userData?.isAlignBoxHelper
        ) {
          const cnt = c.geometry.attributes.position.count || 0;
          if (cnt > 0) {
            meshes.push(c);
            totalVerts += cnt;
          }
        }
      });
    };

    collectFromRoot(studioThree?.modelPivot);
    if (STATE.multiAlign?.active) {
      collectFromRoot(studioThree?.multiAlignGroup);
    }

    const waterPolys2D = getActiveScanWaterPolysLocalXZ();

    // If real tiles are still streaming and backend DSM arrows already arrived, use backend DSM arrows directly (filtered against water voids)
    const srvDrainage = STATE.lastDrainageResult;
    if (
      totalVerts < 300 &&
      srvDrainage &&
      srvDrainage.scan_id === STATE.activeScanId &&
      Array.isArray(srvDrainage.arrows) &&
      srvDrainage.arrows.length > 0
    ) {
      const filteredSrvArrows = srvDrainage.arrows.filter((a) => {
        const ax = Number(a.local_x) || 0;
        const az = Number(a.local_z) || 0;
        return !isPointInsideAnyWaterPolyXZ(ax, az, waterPolys2D);
      });
      const xs = filteredSrvArrows.map((a) => Number(a.local_x) || 0);
      const zs = filteredSrvArrows.map((a) => Number(a.local_z) || 0);
      const spanX = xs.length ? Math.max(8, Math.max(...xs) - Math.min(...xs)) : 20;
      const spanZ = zs.length ? Math.max(8, Math.max(...zs) - Math.min(...zs)) : 20;
      const cellStep = Math.max(0.65, targetStepM || Math.max(spanX, spanZ) / G);
      return {
        cellStep,
        arrows: filteredSrvArrows.map((a) => {
          const tier = classifySlopeRatioTier(a.slope_ratio);
          return {
            x: Number(a.local_x) || 0,
            y: Number(a.local_y) || 0,
            z: Number(a.local_z) || 0,
            ux: Number(a.dir_local_x) || 1,
            uz: Number(a.dir_local_z) || 0,
            slope: Number(a.slope_ratio) || 0.01,
            deg: Number(a.slope_deg) || 0.5,
            ratioLabel: a.ratio_label || "1:100",
            tier,
          };
        }),
      };
    }

    if (meshes.length === 0) {
      collectFromRoot(studioThree?.fallbackGroup);
    }
    if (meshes.length === 0 || totalVerts === 0) {
      return { cellStep: targetStepM, arrows: [] };
    }

    const stride = Math.max(1, Math.floor(totalVerts / 64000));
    const sx = [];
    const sy = [];
    const sz = [];

    for (let mi = 0; mi < meshes.length; mi++) {
      const m = meshes[mi];
      const pos = m.geometry.attributes.position;
      const count = pos.count;
      const e = m.matrixWorld.elements;
      const m0 = e[0], m1 = e[1], m2 = e[2];
      const m4 = e[4], m5 = e[5], m6 = e[6];
      const m8 = e[8], m9 = e[9], m10 = e[10];
      const m12 = e[12], m13 = e[13], m14 = e[14];

      for (let i = 0; i < count; i += stride) {
        const vx = pos.getX(i);
        const vy = pos.getY(i);
        const vz = pos.getZ(i);
        const wx = m0 * vx + m4 * vy + m8 * vz + m12;
        const wy = m1 * vx + m5 * vy + m9 * vz + m13;
        const wz = m2 * vx + m6 * vy + m10 * vz + m14;
        if (Number.isFinite(wx) && Number.isFinite(wy) && Number.isFinite(wz)) {
          if (!isPointInsideAnyWaterPolyXZ(wx, wz, waterPolys2D)) {
            sx.push(wx);
            sy.push(wy);
            sz.push(wz);
          }
        }
      }
    }

    if (sx.length < 16) {
      return { cellStep: targetStepM, arrows: [] };
    }

    const sortedX = sx.slice().sort((a, b) => a - b);
    const sortedZ = sz.slice().sort((a, b) => a - b);
    const minX = sortedX[Math.floor(sortedX.length * 0.005)];
    const maxX = sortedX[Math.floor(sortedX.length * 0.995)];
    const minZ = sortedZ[Math.floor(sortedZ.length * 0.005)];
    const maxZ = sortedZ[Math.floor(sortedZ.length * 0.995)];

    const spanX = Math.max(6.0, maxX - minX);
    const spanZ = Math.max(6.0, maxZ - minZ);
    const cellStep = Math.max(0.65, targetStepM);
    const nx = Math.max(6, Math.min(300, Math.round(spanX / cellStep) + 1));
    const nz = Math.max(6, Math.min(300, Math.round(spanZ / cellStep) + 1));
    const stepX = spanX / Math.max(1, nx - 1);
    const stepZ = spanZ / Math.max(1, nz - 1);

    // Build a fine 2D mesh surface occupancy grid (160x160) using both vertices and rasterized mesh triangles
    // so un-scanned voids / water channels / outer bounding-box corners remain 0 (unoccupied)
    const fineN = 160;
    const fineStepX = spanX / fineN;
    const fineStepZ = spanZ / fineN;
    const fineOcc = new Uint8Array(fineN * fineN);
    const markFineOcc = (wx, wz) => {
      if (wx < minX || wx > maxX || wz < minZ || wz > maxZ) return;
      const fx = Math.min(fineN - 1, Math.max(0, Math.floor((wx - minX) / fineStepX)));
      const fz = Math.min(fineN - 1, Math.max(0, Math.floor((wz - minZ) / fineStepZ)));
      fineOcc[fz * fineN + fx] = 1;
    };
    for (let i = 0; i < sx.length; i++) {
      markFineOcc(sx[i], sz[i]);
    }

    const minYGrid = new Float32Array(nx * nz);
    const sumYGrid = new Float32Array(nx * nz);
    const sumXGrid = new Float32Array(nx * nz);
    const sumZGrid = new Float32Array(nx * nz);
    const cntGrid = new Uint32Array(nx * nz);
    minYGrid.fill(Infinity);

    const accumGridSample = (wx, wy, wz) => {
      if (wx < minX || wx > maxX || wz < minZ || wz > maxZ) return;
      if (isPointInsideAnyWaterPolyXZ(wx, wz, waterPolys2D)) return;
      const ix = Math.min(nx - 1, Math.max(0, Math.floor((wx - minX) / stepX)));
      const iz = Math.min(nz - 1, Math.max(0, Math.floor((wz - minZ) / stepZ)));
      const idx = iz * nx + ix;
      if (wy < minYGrid[idx]) minYGrid[idx] = wy;
      sumYGrid[idx] += wy;
      sumXGrid[idx] += wx;
      sumZGrid[idx] += wz;
      cntGrid[idx] += 1;
    };

    for (let i = 0; i < sx.length; i++) {
      accumGridSample(sx[i], sy[i], sz[i]);
    }

    // Rasterize real mesh triangles across both the fine occupancy grid and the (nx x nz) elevation grid
    // using pos.getX/getY/getZ so quantized InterleavedBufferAttribute GLBs work with 100% fidelity
    const maxAllowedTriEdgeSq = Math.pow(Math.max(14.0, Math.max(spanX, spanZ) * 0.18), 2);
    for (let mi = 0; mi < meshes.length; mi++) {
      const m = meshes[mi];
      const pos = m.geometry.attributes.position;
      const idxAttr = m.geometry.index;
      const e = m.matrixWorld.elements;
      const m0 = e[0], m1 = e[1], m2 = e[2];
      const m4 = e[4], m5 = e[5], m6 = e[6];
      const m8 = e[8], m9 = e[9], m10 = e[10];
      const m12 = e[12], m13 = e[13], m14 = e[14];
      const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(pos.count / 3);
      const triStride = 1;

      for (let ti = 0; ti < triCount; ti += triStride) {
        const i0 = idxAttr ? idxAttr.getX(ti * 3) : ti * 3;
        const i1 = idxAttr ? idxAttr.getX(ti * 3 + 1) : ti * 3 + 1;
        const i2 = idxAttr ? idxAttr.getX(ti * 3 + 2) : ti * 3 + 2;
        const vx0 = pos.getX(i0), vy0 = pos.getY(i0), vz0 = pos.getZ(i0);
        const vx1 = pos.getX(i1), vy1 = pos.getY(i1), vz1 = pos.getZ(i1);
        const vx2 = pos.getX(i2), vy2 = pos.getY(i2), vz2 = pos.getZ(i2);

        const x0 = m0 * vx0 + m4 * vy0 + m8 * vz0 + m12;
        const y0 = m1 * vx0 + m5 * vy0 + m9 * vz0 + m13;
        const z0 = m2 * vx0 + m6 * vy0 + m10 * vz0 + m14;

        const x1 = m0 * vx1 + m4 * vy1 + m8 * vz1 + m12;
        const y1 = m1 * vx1 + m5 * vy1 + m9 * vz1 + m13;
        const z1 = m2 * vx1 + m6 * vy1 + m10 * vz1 + m14;

        const x2 = m0 * vx2 + m4 * vy2 + m8 * vz2 + m12;
        const y2 = m1 * vx2 + m5 * vy2 + m9 * vz2 + m13;
        const z2 = m2 * vx2 + m6 * vy2 + m10 * vz2 + m14;

        const d01 = (x1 - x0) * (x1 - x0) + (z1 - z0) * (z1 - z0);
        const d12 = (x2 - x1) * (x2 - x1) + (z2 - z1) * (z2 - z1);
        const d20 = (x0 - x2) * (x0 - x2) + (z0 - z2) * (z0 - z2);
        if (d01 > maxAllowedTriEdgeSq || d12 > maxAllowedTriEdgeSq || d20 > maxAllowedTriEdgeSq) continue;

        // Check surface normal Y component to skip vertical walls/trunks during ground rasterization
        const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0;
        const wx = x2 - x0, wy = y2 - y0, wz = z2 - z0;
        const nxTri = uy * wz - uz * wy;
        const nyTri = uz * wx - ux * wz;
        const nzTri = ux * wy - uy * wx;
        const nLen = Math.hypot(nxTri, nyTri, nzTri);
        if (nLen < 1e-6) continue;
        if (excludeWalls && Math.abs(nyTri) / nLen < 0.35) continue;

        const cx = (x0 + x1 + x2) / 3.0;
        const cy = (y0 + y1 + y2) / 3.0;
        const cz = (z0 + z1 + z2) / 3.0;
        markFineOcc(cx, cz);
        markFineOcc(0.5 * (x0 + x1), 0.5 * (z0 + z1));
        markFineOcc(0.5 * (x1 + x2), 0.5 * (z1 + z2));
        markFineOcc(0.5 * (x2 + x0), 0.5 * (z2 + z0));
        accumGridSample(cx, cy, cz);

        // Barycentric rasterization over covered drainage grid cells & fine occupancy cells
        const denom = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
        if (Math.abs(denom) > 1e-5) {
          const invDenom = 1.0 / denom;
          const tMinX = Math.max(minX, Math.min(x0, x1, x2));
          const tMaxX = Math.min(maxX, Math.max(x0, x1, x2));
          const tMinZ = Math.max(minZ, Math.min(z0, z1, z2));
          const tMaxZ = Math.min(maxZ, Math.max(z0, z1, z2));

          const ix0 = Math.max(0, Math.floor((tMinX - minX) / stepX));
          const ix1 = Math.min(nx - 1, Math.floor((tMaxX - minX) / stepX));
          const iz0 = Math.max(0, Math.floor((tMinZ - minZ) / stepZ));
          const iz1 = Math.min(nz - 1, Math.floor((tMaxZ - minZ) / stepZ));
          for (let iz = iz0; iz <= iz1; iz++) {
            const pz = minZ + (iz + 0.5) * stepZ;
            for (let ix = ix0; ix <= ix1; ix++) {
              const px = minX + (ix + 0.5) * stepX;
              const w0 = ((z1 - z2) * (px - x2) + (x2 - x1) * (pz - z2)) * invDenom;
              const w1 = ((z2 - z0) * (px - x2) + (x0 - x2) * (pz - z2)) * invDenom;
              const w2 = 1.0 - w0 - w1;
              if (w0 >= -0.05 && w1 >= -0.05 && w2 >= -0.05) {
                const py = w0 * y0 + w1 * y1 + w2 * y2;
                accumGridSample(px, py, pz);
              }
            }
          }

          const fx0 = Math.max(0, Math.floor((tMinX - minX) / fineStepX));
          const fx1 = Math.min(fineN - 1, Math.floor((tMaxX - minX) / fineStepX));
          const fz0 = Math.max(0, Math.floor((tMinZ - minZ) / fineStepZ));
          const fz1 = Math.min(fineN - 1, Math.floor((tMaxZ - minZ) / fineStepZ));
          if ((fx1 - fx0 + 1) * (fz1 - fz0 + 1) <= 256) {
            for (let fz = fz0; fz <= fz1; fz++) {
              const pz = minZ + (fz + 0.5) * fineStepZ;
              for (let fx = fx0; fx <= fx1; fx++) {
                const px = minX + (fx + 0.5) * fineStepX;
                const w0 = ((z1 - z2) * (px - x2) + (x2 - x1) * (pz - z2)) * invDenom;
                const w1 = ((z2 - z0) * (px - x2) + (x0 - x2) * (pz - z2)) * invDenom;
                const w2 = 1.0 - w0 - w1;
                if (w0 >= -0.04 && w1 >= -0.04 && w2 >= -0.04) {
                  fineOcc[fz * fineN + fx] = 1;
                }
              }
            }
          }
        }
      }
    }

    // Close 1-pixel micro-gaps surrounded by >= 5 of 8 occupied fine cells (never bridges real voids)
    const fineOccClosed = new Uint8Array(fineN * fineN);
    for (let fz = 0; fz < fineN; fz++) {
      for (let fx = 0; fx < fineN; fx++) {
        const fIdx = fz * fineN + fx;
        if (fineOcc[fIdx]) {
          fineOccClosed[fIdx] = 1;
          continue;
        }
        let nOcc = 0;
        for (let dz = -1; dz <= 1; dz++) {
          const jz = fz + dz;
          if (jz < 0 || jz >= fineN) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue;
            const jx = fx + dx;
            if (jx < 0 || jx >= fineN) continue;
            if (fineOcc[jz * fineN + jx]) nOcc++;
          }
        }
        if (nOcc >= 5) fineOccClosed[fIdx] = 1;
      }
    }

    const isFineSurfaceOccupied = (wx, wz) => {
      if (wx < minX || wx > maxX || wz < minZ || wz > maxZ) return false;
      if (isPointInsideAnyWaterPolyXZ(wx, wz, waterPolys2D)) return false;
      const fx = Math.min(fineN - 1, Math.max(0, Math.floor((wx - minX) / fineStepX)));
      const fz = Math.min(fineN - 1, Math.max(0, Math.floor((wz - minZ) / fineStepZ)));
      if (!fineOccClosed[fz * fineN + fx]) return false;
      let localOcc = 0;
      for (let dz = -1; dz <= 1; dz++) {
        const jz = fz + dz;
        if (jz < 0 || jz >= fineN) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const jx = fx + dx;
          if (jx < 0 || jx >= fineN) continue;
          if (fineOccClosed[jz * fineN + jx]) localOcc++;
        }
      }
      return localOcc >= 4;
    };

    // Bare-surface elevation per occupied cell (requires >= 1 real mesh sample; never extrapolates into voids)
    const rawH = new Float32Array(nx * nz);
    const validCell = new Uint8Array(nx * nz);
    for (let idx = 0; idx < nx * nz; idx++) {
      if (cntGrid[idx] >= 1 && Number.isFinite(minYGrid[idx])) {
        const meanY = sumYGrid[idx] / cntGrid[idx];
        rawH[idx] = 0.78 * minYGrid[idx] + 0.22 * meanY;
        validCell[idx] = 1;
      }
    }

    // 3x3 smoothing strictly over occupied cells ONLY (never fills empty/un-scanned cells!)
    const smoothH = new Float32Array(nx * nz);
    const smoothValid = new Uint8Array(nx * nz);
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const idx = iz * nx + ix;
        if (!validCell[idx]) continue;
        let wSum = 0;
        let hSum = 0;
        for (let dz = -1; dz <= 1; dz++) {
          const jz = iz + dz;
          if (jz < 0 || jz >= nz) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const jx = ix + dx;
            if (jx < 0 || jx >= nx) continue;
            const nIdx = jz * nx + jx;
            if (validCell[nIdx]) {
              const w = dx === 0 && dz === 0 ? 2.5 : 1.0;
              hSum += rawH[nIdx] * w;
              wSum += w;
            }
          }
        }
        smoothH[idx] = wSum > 0 ? hSum / wSum : rawH[idx];
        smoothValid[idx] = 1;
      }
    }

    const arrows = [];
    const maxStepJump = Math.max(2.2, cellStep * 1.15);
    for (let iz = 1; iz < nz - 1; iz++) {
      for (let ix = 1; ix < nx - 1; ix++) {
        const idx = iz * nx + ix;
        if (!smoothValid[idx]) continue;

        const idxL = iz * nx + (ix - 1);
        const idxR = iz * nx + (ix + 1);
        const idxD = (iz - 1) * nx + ix;
        const idxU = (iz + 1) * nx + ix;
        const hasHoriz = smoothValid[idxL] || smoothValid[idxR];
        const hasVert = smoothValid[idxD] || smoothValid[idxU];
        if (!hasHoriz || !hasVert) continue;

        const hC = smoothH[idx];
        const hL = smoothValid[idxL] ? smoothH[idxL] : hC;
        const hR = smoothValid[idxR] ? smoothH[idxR] : hC;
        const hD = smoothValid[idxD] ? smoothH[idxD] : hC;
        const hU = smoothValid[idxU] ? smoothH[idxU] : hC;
        const spanDx = (smoothValid[idxR] ? 1.0 : 0.0) + (smoothValid[idxL] ? 1.0 : 0.0);
        const spanDz = (smoothValid[idxU] ? 1.0 : 0.0) + (smoothValid[idxD] ? 1.0 : 0.0);
        if (spanDx < 1.0 || spanDz < 1.0) continue;

        if (
          Math.abs(hR - hC) > maxStepJump ||
          Math.abs(hL - hC) > maxStepJump ||
          Math.abs(hU - hC) > maxStepJump ||
          Math.abs(hD - hC) > maxStepJump
        ) {
          continue;
        }

        // Verify exact arrow placement lies on occupied mesh surface (not over an empty hole inside the cell)
        const cx0 = minX + (ix + 0.5) * stepX;
        const cz0 = minZ + (iz + 0.5) * stepZ;
        const meanX = sumXGrid[idx] / cntGrid[idx];
        const meanZ = sumZGrid[idx] / cntGrid[idx];
        let ax = cx0;
        let az = cz0;
        if (!isFineSurfaceOccupied(ax, az)) {
          if (isFineSurfaceOccupied(meanX, meanZ)) {
            ax = meanX;
            az = meanZ;
          } else {
            continue;
          }
        }

        const dzdx = (hR - hL) / (spanDx * stepX);
        const dzdz = (hU - hD) / (spanDz * stepZ);
        const slope = Math.hypot(dzdx, dzdz);
        if (!Number.isFinite(slope)) continue;
        if (excludeWalls && slope > 1.0) continue;

        const deg = (Math.atan(slope) * 180.0) / Math.PI;
        const ux = slope >= 1e-4 ? -dzdx / slope : 1.0;
        const uz = slope >= 1e-4 ? -dzdz / slope : 0.0;
        const tier = classifySlopeRatioTier(slope);
        const ratioN = Math.min(999, Math.max(1, Math.round(1.0 / Math.max(slope, 1e-4))));
        const ratioLabel = slope < 0.0005 ? "<1:999" : `1:${ratioN}`;

        arrows.push({
          x: ax,
          y: hC,
          z: az,
          ux,
          uz,
          slope,
          deg,
          ratioLabel,
          tier,
        });
      }
    }

    return { cellStep: Math.min(stepX, stepZ), arrows };
  }

  function renderDrainageAndSlopeVisuals3D(opts = {}) {
    if (!studioThree || !studioThree.overlayGroup) return null;
    clearDrainageVisuals3D();

    const gridSize = Math.max(8, Math.min(40, Number(opts?.gridSize) || Number(STATE.drainageGridSize) || 20));
    const densityPerM2 = Math.max(
      0.04,
      Math.min(2.0, Number(opts?.densityPerM2 ?? STATE.drainageDensityPerM2) || 0.25)
    );
    const arrowScale = Math.max(
      0.2,
      Math.min(3.0, Number(opts?.arrowScale) || Number(STATE.drainageArrowScale) || 1.0)
    );
    const showLabels = opts?.showLabels !== undefined ? Boolean(opts.showLabels) : STATE.drainageShowLabels !== false;
    const excludeWalls =
      opts?.excludeWalls !== undefined ? Boolean(opts.excludeWalls) : STATE.drainageExcludeWalls !== false;
    STATE.drainageGridSize = gridSize;
    STATE.drainageDensityPerM2 = densityPerM2;
    STATE.drainageArrowScale = arrowScale;
    STATE.drainageShowLabels = showLabels;
    STATE.drainageExcludeWalls = excludeWalls;

    const grp = new THREE.Group();
    studioThree.drainageGroup = grp;
    studioThree.overlayGroup.add(grp);

    const { cellStep, arrows } = buildFastStudioSurfaceArrows(gridSize, excludeWalls, densityPerM2);

    const tierCounts = {};
    SLOPE_STEPPED_TIERS.forEach((t) => {
      tierCounts[t.id] = 0;
    });

    let gentleCount = 0;
    let modCount = 0;
    let steepCount = 0;
    let slopeDegSum = 0;
    let slopeRatioSum = 0;
    let maxSlopeDeg = 0;

    const triPositions = [];
    const triColors = [];
    const linePositions = [];
    const lineColors = [];

    // Arrow physical length is decoupled from cellStep so changing Density (arrows/m²) never changes arrow length!
    const yLift = 0.11;

    for (let i = 0; i < arrows.length; i++) {
      const a = arrows[i];
      const tier = a.tier || classifySlopeRatioTier(a.slope);
      tierCounts[tier.id] = (tierCounts[tier.id] || 0) + 1;

      if (a.deg < 15.0) gentleCount++;
      else if (a.deg < 30.0) modCount++;
      else steepCount++;

      slopeDegSum += a.deg;
      slopeRatioSum += a.slope;
      if (a.deg > maxSlopeDeg) maxSlopeDeg = a.deg;

      const len = 0.85 * tier.lenScale * arrowScale;
      const shaftLen = len * 0.62;
      const shaftHalfW = Math.max(0.02, 0.055 * arrowScale);
      const headHalfW = Math.max(0.045, 0.135 * arrowScale);

      // Right-hand perpendicular in XZ plane
      const px = -a.uz;
      const pz = a.ux;

      // Center arrow on (a.x, a.y + yLift, a.z) and pitch slightly downhill
      const pitchY = -Math.min(0.35, a.slope) * len;
      const xStart = a.x - a.ux * (len * 0.45);
      const zStart = a.z - a.uz * (len * 0.45);
      const yStart = a.y + yLift - pitchY * 0.45;

      const xNeck = xStart + a.ux * shaftLen;
      const zNeck = zStart + a.uz * shaftLen;
      const yNeck = yStart + pitchY * 0.62;

      const xTip = xStart + a.ux * len;
      const zTip = zStart + a.uz * len;
      const yTip = yStart + pitchY;

      // Shaft quad corners
      const sL0x = xStart + px * shaftHalfW, sL0z = zStart + pz * shaftHalfW;
      const sR0x = xStart - px * shaftHalfW, sR0z = zStart - pz * shaftHalfW;
      const sL1x = xNeck + px * shaftHalfW, sL1z = zNeck + pz * shaftHalfW;
      const sR1x = xNeck - px * shaftHalfW, sR1z = zNeck - pz * shaftHalfW;

      // Head wing corners
      const hLx = xNeck + px * headHalfW, hLz = zNeck + pz * headHalfW;
      const hRx = xNeck - px * headHalfW, hRz = zNeck - pz * headHalfW;

      const [r, g, b] = tier.rgb;

      // Triangle 1 & 2: Shaft Quad
      triPositions.push(
        sL0x, yStart, sL0z,
        sR0x, yStart, sR0z,
        sR1x, yNeck, sR1z,
        sL0x, yStart, sL0z,
        sR1x, yNeck, sR1z,
        sL1x, yNeck, sL1z
      );
      // Triangle 3: Arrowhead
      triPositions.push(
        hLx, yNeck, hLz,
        hRx, yNeck, hRz,
        xTip, yTip, zTip
      );
      for (let v = 0; v < 9; v++) {
        triColors.push(r, g, b);
      }

      // Crisp dark outline segments around arrow silhouette
      const outlinePts = [
        [sL0x, yStart, sL0z, sR0x, yStart, sR0z],
        [sR0x, yStart, sR0z, sR1x, yNeck, sR1z],
        [sR1x, yNeck, sR1z, hRx, yNeck, hRz],
        [hRx, yNeck, hRz, xTip, yTip, zTip],
        [xTip, yTip, zTip, hLx, yNeck, hLz],
        [hLx, yNeck, hLz, sL1x, yNeck, sL1z],
        [sL1x, yNeck, sL1z, sL0x, yStart, sL0z],
      ];
      for (let sIdx = 0; sIdx < outlinePts.length; sIdx++) {
        const seg = outlinePts[sIdx];
        linePositions.push(seg[0], seg[1] + 0.005, seg[2], seg[3], seg[4] + 0.005, seg[5]);
        lineColors.push(0.06, 0.09, 0.16, 0.06, 0.09, 0.16);
      }
    }

    if (triPositions.length > 0) {
      const arrowGeom = new THREE.BufferGeometry();
      arrowGeom.setAttribute("position", new THREE.Float32BufferAttribute(triPositions, 3));
      arrowGeom.setAttribute("color", new THREE.Float32BufferAttribute(triColors, 3));
      const arrowMesh = new THREE.Mesh(
        arrowGeom,
        new THREE.MeshBasicMaterial({
          vertexColors: true,
          side: THREE.DoubleSide,
          depthTest: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
          transparent: true,
          opacity: 0.94,
        })
      );
      arrowMesh.renderOrder = 995;
      grp.add(arrowMesh);

      const outlineGeom = new THREE.BufferGeometry();
      outlineGeom.setAttribute("position", new THREE.Float32BufferAttribute(linePositions, 3));
      outlineGeom.setAttribute("color", new THREE.Float32BufferAttribute(lineColors, 3));
      const outlineLines = new THREE.LineSegments(
        outlineGeom,
        new THREE.LineBasicMaterial({
          vertexColors: true,
          depthTest: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
          transparent: true,
          opacity: 0.85,
        })
      );
      outlineLines.renderOrder = 996;
      grp.add(outlineLines);
    }

    // Add compact 1:N slope ratio badges on a non-overlapping subset of arrows (max 28 sprites)
    if (showLabels && arrows.length > 0) {
      const labelStep = Math.max(1, Math.ceil(arrows.length / 28));
      const spriteScale = Math.max(0.45, Math.min(1.4, cellStep * 0.12 * arrowScale));
      for (let i = 0; i < arrows.length; i += labelStep) {
        const a = arrows[i];
        const tier = a.tier || classifySlopeRatioTier(a.slope);
        const sp = createSlopeRatioSprite(a.ratioLabel, tier.color);
        sp.position.set(a.x, a.y + yLift + Math.max(0.18, cellStep * 0.05 * arrowScale), a.z);
        sp.scale.set(spriteScale * 1.4, spriteScale * 0.5, 1);
        grp.add(sp);
      }
    }

    const total = Math.max(1, arrows.length);
    const meanSlopeRatio = arrows.length > 0 ? slopeRatioSum / total : 0.01;
    const meanRatioN = Math.min(999, Math.max(1, Math.round(1.0 / Math.max(meanSlopeRatio, 1e-4))));
    const stats = {
      arrow_count: arrows.length,
      gentle_pct: arrows.length > 0 ? ((gentleCount * 100) / total).toFixed(1) : "0.0",
      moderate_pct: arrows.length > 0 ? ((modCount * 100) / total).toFixed(1) : "0.0",
      steep_pct: arrows.length > 0 ? ((steepCount * 100) / total).toFixed(1) : "0.0",
      mean_slope_deg: arrows.length > 0 ? (slopeDegSum / total).toFixed(1) : "0.0",
      max_slope_deg: arrows.length > 0 ? maxSlopeDeg.toFixed(1) : "0.0",
      mean_ratio_label: arrows.length > 0 ? `1:${meanRatioN}` : "—",
      ponding_zone_count: tierCounts.flat_200 || 0,
      tier_counts: tierCounts,
    };

    updateStudioDrainageLegendHud(stats);
    return stats;
  }
  window.renderDrainageAndSlopeVisuals3D = renderDrainageAndSlopeVisuals3D;
  window.renderDrainageOverlay3D = renderDrainageAndSlopeVisuals3D;

  async function openDrainageAndSlopeInspector() {
    setActiveStudioTool("drainage");
    STATE.sidePanelMinimized = false;

    const curGridSize = Math.max(8, Math.min(40, Number(STATE.drainageGridSize) || 20));
    const curDensityPerM2 = Math.max(0.04, Math.min(2.0, Number(STATE.drainageDensityPerM2) || 0.25));
    const curArrowScale = Math.max(0.2, Math.min(3.0, Number(STATE.drainageArrowScale) || 1.0));
    const curShowLabels = STATE.drainageShowLabels !== false;
    const curExcludeWalls = STATE.drainageExcludeWalls !== false;

    let localStats = renderDrainageAndSlopeVisuals3D({
      gridSize: curGridSize,
      densityPerM2: curDensityPerM2,
      arrowScale: curArrowScale,
      showLabels: curShowLabels,
      excludeWalls: curExcludeWalls,
    });

    const renderPanelHtml = (st) => {
      const s = st || {
        arrow_count: 0,
        gentle_pct: "0.0",
        moderate_pct: "0.0",
        steep_pct: "0.0",
        mean_slope_deg: "0.0",
        max_slope_deg: "0.0",
        mean_ratio_label: "—",
        ponding_zone_count: 0,
        tier_counts: {},
      };
      const total = Math.max(1, Number(s.arrow_count) || 0);
      const dVal = Math.max(0.04, Math.min(2.0, Number(STATE.drainageDensityPerM2) || 0.25));
      const aScale = Math.max(0.2, Math.min(3.0, Number(STATE.drainageArrowScale) || 1.0));
      return `
      <div style="font-size:11px;color:var(--ui-text-secondary);margin-bottom:8px;line-height:1.45;">
        ${tr(
          "於真實 3D 掃描地表配置排水流向箭頭（自動排除未建模空洞與水域）：箭頭指向下坡方向，長度與階梯色彩代表坡度比 (1:N)。",
          "Places 3D downhill drainage arrows strictly on scanned terrain (automatically excludes un-scanned voids & water bodies)."
        )}
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px;">
        <div class="gs-metric-box" style="border-left:3px solid #10b981;">
          <div class="lbl">${tr("平均坡度比", "Mean Ratio")}</div>
          <div class="val" id="valDrainageMeanRatio" style="color:#10b981;font-family:var(--font-mono);">${s.mean_ratio_label || "—"}</div>
        </div>
        <div class="gs-metric-box" style="border-left:3px solid #eab308;">
          <div class="lbl">${tr("平均角度", "Mean Angle")}</div>
          <div class="val" id="valDrainageMeanDeg" style="color:#eab308;font-family:var(--font-mono);">${s.mean_slope_deg}°</div>
        </div>
        <div class="gs-metric-box" style="border-left:3px solid #38bdf8;">
          <div class="lbl">${tr("平緩區 (<1:200)", "Flat (<1:200)")}</div>
          <div class="val" id="valDrainagePondingCnt" style="color:#38bdf8;font-family:var(--font-mono);">${s.ponding_zone_count}</div>
        </div>
      </div>

      <!-- Stepped 1:N Slope Color & Arrow Length Legend -->
      <div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border);border-radius:8px;padding:8px 10px;margin-bottom:10px;">
        <div style="display:flex;align-items:center;justify-content:space-between;font-size:11px;font-weight:700;margin-bottom:6px;">
          <span>${tr("階梯坡度比圖例 (Stepped 1:N Legend)", "Stepped Slope Ratio Legend (1:N)")}</span>
          <span id="lblDrainageArrowTotalCount" style="color:var(--ui-text-secondary);font-family:var(--font-mono);">${s.arrow_count} ${tr("支箭頭", "arrows")}</span>
        </div>
        <div id="boxDrainageTierRows" style="display:flex;flex-direction:column;gap:5px;font-size:11px;">
          ${SLOPE_STEPPED_TIERS.map((t) => {
            const cnt = Number((s.tier_counts && s.tier_counts[t.id]) || 0);
            const pct = s.arrow_count ? ((cnt * 100) / total).toFixed(1) : "0.0";
            const arrowPx = Math.round(t.lenScale * 28);
            return `
              <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                <div style="display:flex;align-items:center;gap:6px;min-width:0;">
                  <span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${t.color};flex-shrink:0;"></span>
                  <span style="font-family:var(--font-mono);font-weight:700;min-width:82px;">${t.ratioRange}</span>
                  <span style="display:inline-block;height:4px;width:${arrowPx}px;background:${t.color};border-radius:2px;" title="Arrow Length Scale"></span>
                </div>
                <span data-drainage-tier-stat="${t.id}" style="font-family:var(--font-mono);color:var(--ui-text-secondary);font-size:10.5px;">${t.pctRange} · <b>${cnt}</b> (${pct}%)</span>
              </div>
            `;
          }).join("")}
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:10px;font-size:11.5px;background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:8px;padding:8px 10px;">
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;">
            <span style="font-weight:700;">${tr("箭頭分佈密度 (arrows / m²)", "Arrow Density (arrows / m²)")}</span>
            <span id="lblDrainageDensityVal" style="font-family:var(--font-mono);color:var(--ui-accent);font-weight:700;">${dVal.toFixed(2)} / m²</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <input type="range" id="rngDrainageDensity" class="gs-input" min="0.04" max="2.00" step="0.02" value="${dVal.toFixed(2)}" style="flex:1;" />
            <select id="selDrainageGridSize" class="gs-select" style="width:104px;height:24px;font-size:10.5px;">
              <option value="0.10" ${dVal <= 0.14 ? "selected" : ""}>0.10 / m²</option>
              <option value="0.25" ${dVal > 0.14 && dVal <= 0.36 ? "selected" : ""}>0.25 / m²</option>
              <option value="0.50" ${dVal > 0.36 && dVal <= 0.75 ? "selected" : ""}>0.50 / m²</option>
              <option value="1.00" ${dVal > 0.75 && dVal <= 1.50 ? "selected" : ""}>1.00 / m²</option>
              <option value="2.00" ${dVal > 1.50 ? "selected" : ""}>2.00 / m²</option>
            </select>
          </div>
        </div>
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;">
            <span style="font-weight:700;">${tr("箭頭長度比例 (Arrow Length)", "Arrow Length Scale")}</span>
            <span id="lblDrainageArrowSizeVal" style="font-family:var(--font-mono);color:var(--ui-accent);font-weight:700;">${aScale.toFixed(1)}x</span>
          </div>
          <input type="range" id="rngDrainageArrowSize" class="gs-input" min="0.2" max="3.0" step="0.1" value="${aScale.toFixed(1)}" style="width:100%;" />
        </div>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" id="chkDrainageShowLabels" ${STATE.drainageShowLabels !== false ? "checked" : ""} />
          <span>${tr("於箭頭上方顯示 1:N 坡度比標籤", "Show 1:N Slope Ratio Labels on Arrows")}</span>
        </label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" id="chkDrainageExcludeWalls" ${STATE.drainageExcludeWalls !== false ? "checked" : ""} />
          <span>${tr("排除垂直牆面與樹幹 (> 1:1 / 45°)", "Exclude Vertical Walls & Trunks (> 1:1 / 45°)")}</span>
        </label>
      </div>
      <button type="button" class="gs-top-btn" id="btnClearDrainageVisuals" style="width:100%;justify-content:center;">
        <span>${tr("清除坡度與排水箭頭", "Clear Slope & Drainage Arrows")}</span>
      </button>
      `;
    };

    const updateDrainagePanelStatsInPlace = (st) => {
      if (!st) return;
      const total = Math.max(1, Number(st.arrow_count) || 0);
      const elMeanR = document.getElementById("valDrainageMeanRatio");
      if (elMeanR) elMeanR.textContent = st.mean_ratio_label || "—";
      const elMeanD = document.getElementById("valDrainageMeanDeg");
      if (elMeanD) elMeanD.textContent = `${st.mean_slope_deg}°`;
      const elPond = document.getElementById("valDrainagePondingCnt");
      if (elPond) elPond.textContent = String(st.ponding_zone_count ?? 0);
      const elTot = document.getElementById("lblDrainageArrowTotalCount");
      if (elTot) elTot.textContent = `${st.arrow_count} ${tr("支箭頭", "arrows")}`;
      SLOPE_STEPPED_TIERS.forEach((t) => {
        const rowEl = document.querySelector(`[data-drainage-tier-stat="${t.id}"]`);
        if (rowEl) {
          const cnt = Number((st.tier_counts && st.tier_counts[t.id]) || 0);
          const pct = st.arrow_count ? ((cnt * 100) / total).toFixed(1) : "0.0";
          rowEl.innerHTML = `${t.pctRange} · <b>${cnt}</b> (${pct}%)`;
        }
      });
    };

    const bindDrainageControls = () => {
      const refreshVisInPlace = (overrideDensity = null) => {
        const rngD = document.getElementById("rngDrainageDensity");
        const selD = document.getElementById("selDrainageGridSize");
        const dVal = Math.max(
          0.04,
          Math.min(2.0, Number(overrideDensity || rngD?.value || selD?.value || STATE.drainageDensityPerM2 || 0.25))
        );
        if (rngD && Math.abs(Number(rngD.value) - dVal) > 1e-3) rngD.value = dVal.toFixed(2);
        if (selD && overrideDensity) selD.value = dVal.toFixed(2);
        const aScale = Math.max(
          0.2,
          Math.min(3.0, Number(document.getElementById("rngDrainageArrowSize")?.value || STATE.drainageArrowScale || 1.0))
        );
        const lVal = Boolean(document.getElementById("chkDrainageShowLabels")?.checked);
        const wVal = Boolean(document.getElementById("chkDrainageExcludeWalls")?.checked);
        const lblD = document.getElementById("lblDrainageDensityVal");
        if (lblD) lblD.textContent = `${dVal.toFixed(2)} / m²`;
        const lblS = document.getElementById("lblDrainageArrowSizeVal");
        if (lblS) lblS.textContent = `${aScale.toFixed(1)}x`;
        const newSt = renderDrainageAndSlopeVisuals3D({
          gridSize: STATE.drainageGridSize || 20,
          densityPerM2: dVal,
          arrowScale: aScale,
          showLabels: lVal,
          excludeWalls: wVal,
        });
        updateDrainagePanelStatsInPlace(newSt);
      };
      document.getElementById("rngDrainageDensity")?.addEventListener("input", (e) => {
        refreshVisInPlace(Number(e.target.value));
      });
      document.getElementById("selDrainageGridSize")?.addEventListener("change", (e) => {
        refreshVisInPlace(Number(e.target.value));
      });
      document.getElementById("rngDrainageArrowSize")?.addEventListener("input", () => {
        refreshVisInPlace(null);
      });
      document.getElementById("chkDrainageShowLabels")?.addEventListener("change", () => refreshVisInPlace(null));
      document.getElementById("chkDrainageExcludeWalls")?.addEventListener("change", () => refreshVisInPlace(null));
      document.getElementById("btnClearDrainageVisuals")?.addEventListener("click", () => {
        clearDrainageVisuals3D();
        showToast(tr("已清除 3D 坡度與排水箭頭", "Cleared 3D Slope & Drainage arrows"));
      });
    };

    showSidePanel(
      `<span>${tr("坡度比 (1:N) 與排水箭頭分析", "Slope (1:N) & Drainage Arrows")}</span>`,
      renderPanelHtml(localStats)
    );
    bindDrainageControls();

    // Fetch backend DSM slope arrows asynchronously without blocking UI
    try {
      const srv = await apiPost("/api/survey/drainage", {
        scan_id: STATE.activeScanId,
        grid_size: Number(STATE.drainageGridSize) || 20,
        exclude_walls: STATE.drainageExcludeWalls !== false,
      });
      if (srv && srv.status === "ok") {
        STATE.lastDrainageResult = srv;
        const hasClientArrows =
          (localStats && localStats.arrow_count > 0) || (studioThree?.drainageGroup?.children?.length || 0) > 0;
        if (STATE.activeTool === "drainage" && !hasClientArrows) {
          localStats = renderDrainageAndSlopeVisuals3D({
            gridSize: Number(STATE.drainageGridSize) || 20,
            densityPerM2: Number(STATE.drainageDensityPerM2) || 0.25,
            arrowScale: Number(STATE.drainageArrowScale) || 1.0,
            showLabels: STATE.drainageShowLabels !== false,
            excludeWalls: STATE.drainageExcludeWalls !== false,
          });
          updateDrainagePanelStatsInPlace(localStats);
        }
      }
    } catch (_) {}
  }

  // ============================================================================
  // FEATURE 5: AUTOMATED GCP (GROUND CONTROL POINT) ACCURACY QA REPORT
  // ============================================================================
  function clearGcpQaMarkers3D() {
    if (!studioThree || !studioThree.overlayGroup) return;
    if (studioThree.gcpQaGroup) {
      studioThree.overlayGroup.remove(studioThree.gcpQaGroup);
      studioThree.gcpQaGroup = null;
    }
  }

  function renderGcpQaMarkers3D(points) {
    if (!studioThree || !studioThree.overlayGroup || !Array.isArray(points)) return;
    clearGcpQaMarkers3D();
    const grp = new THREE.Group();
    studioThree.gcpQaGroup = grp;
    if (!studioThree.gcpQaGroup.parent) {
      studioThree.overlayGroup.add(studioThree.gcpQaGroup);
    }

    points.forEach((p) => {
      const loc = Array.isArray(p.local) && p.local.length >= 3 ? p.local : [0, 0, 0];
      const colHex = p.status === "pass" ? 0x10b981 : p.status === "warn" ? 0xf59e0b : 0xef4444;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.35, 0.72, 24),
        new THREE.MeshBasicMaterial({ color: colHex, side: THREE.DoubleSide, depthTest: false })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(Number(loc[0]) || 0, (Number(loc[1]) || 0) + 0.15, Number(loc[2]) || 0);
      ring.renderOrder = 998;
      grp.add(ring);
    });
  }

  function parseGcpCsvInput(csvText) {
    const lines = String(csvText || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    const pts = [];
    lines.forEach((line, idx) => {
      const parts = line.split(/[,\t;]+/).map((s) => s.trim());
      if (parts.length < 3) return;
      if (idx === 0 && isNaN(Number(parts[1]))) return;
      if (parts.length >= 4 && isNaN(Number(parts[0]))) {
        pts.push({
          name: parts[0],
          e: Number(parts[1]),
          n: Number(parts[2]),
          h_gcp: Number(parts[3]),
        });
      } else {
        pts.push({
          name: `CP-${String(idx + 1).padStart(2, "0")}`,
          e: Number(parts[0]),
          n: Number(parts[1]),
          h_gcp: Number(parts[2]),
        });
      }
    });
    return pts.filter((p) => Number.isFinite(p.e) && Number.isFinite(p.n) && Number.isFinite(p.h_gcp));
  }

  function handleGcpQa3DPick(pt, twd) {
    const txtEl = document.getElementById("txtGcpCsvInput");
    if (!txtEl) return;
    const lines = txtEl.value.trim() ? txtEl.value.trim().split(/\r?\n/) : [];
    const nextIdx = lines.length + 1;
    const simGcpH = (Number(twd.h) - 0.012).toFixed(3);
    const newRow = `CP-${String(nextIdx).padStart(2, "0")}, ${Number(twd.e).toFixed(3)}, ${Number(twd.n).toFixed(3)}, ${simGcpH}`;
    lines.push(newRow);
    txtEl.value = lines.join("\n");
    showToast(tr(`已新增檢核點 CP-${String(nextIdx).padStart(2, "0")} 至檢核表`, `Added Check Point CP-${String(nextIdx).padStart(2, "0")} from 3D scan`));
    runGcpAccuracyQaEvaluation(parseGcpCsvInput(txtEl.value));
  }

  async function runGcpAccuracyQaEvaluation(pointsInput = []) {
    try {
      const res = await apiPost("/api/survey/gcp-qa", {
        scan_id: STATE.activeScanId,
        points: pointsInput,
      });
      STATE.lastGcpQaResult = res;
      renderGcpQaMarkers3D(res.points || []);
      openGcpAccuracyQaInspector(res);
    } catch (err) {
      showToast(`GCP QA Error: ${err.message}`);
    }
  }

  function openGcpAccuracyQaInspector(qaResult = STATE.lastGcpQaResult) {
    setActiveStudioTool("gcp_qa");
    STATE.sidePanelMinimized = false;
    if (!qaResult || qaResult.scan_id !== STATE.activeScanId) {
      runGcpAccuracyQaEvaluation([]);
      return;
    }

    const csvDefault = (qaResult.points || [])
      .map((p) => `${p.name}, ${Number(p.e).toFixed(3)}, ${Number(p.n).toFixed(3)}, ${Number(p.h_gcp).toFixed(3)}`)
      .join("\n");

    const gradeColor = qaResult.qa_grade === "A" ? "#10b981" : qaResult.qa_grade === "B" ? "#f59e0b" : "#ef4444";
    const rowsHtml = (qaResult.points || [])
      .map((p) => {
        const c = p.status === "pass" ? "#10b981" : p.status === "warn" ? "#f59e0b" : "#ef4444";
        return `
          <tr>
            <td><b>${escapeHtml(p.name)}</b></td>
            <td>${Number(p.h_gcp).toFixed(3)}</td>
            <td>${Number(p.h_scan).toFixed(3)}</td>
            <td style="color:${c};font-weight:700;">${p.dz_cm >= 0 ? "+" : ""}${Number(p.dz_cm).toFixed(1)} cm</td>
          </tr>
        `;
      })
      .join("");

    showSidePanel(
      `<span>${tr("控制點高程精度檢核 (GCP QA)", "GCP Accuracy QA Report")}</span>`,
      `
      <div style="display:flex;justify-content:space-between;align-items:center;background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:8px;padding:8px 10px;margin-bottom:8px;">
        <span style="font-size:11.5px;font-weight:700;">${tr("台灣工程測量精度評級", "Taiwan Surveying QA Grade")}</span>
        <span style="padding:2px 9px;border-radius:999px;background:${gradeColor}22;color:${gradeColor};font-weight:800;font-size:11.5px;">
          Grade ${escapeHtml(qaResult.qa_grade)} (RMSE ${Number(qaResult.rmse_z_cm).toFixed(2)} cm)
        </span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px;">
        <div class="gs-metric-box">
          <div class="lbl">RMSE_Z (${tr("高程均方根誤差", "Vertical RMSE")})</div>
          <div class="val" style="color:${gradeColor};">${Number(qaResult.rmse_z_cm).toFixed(2)} cm</div>
        </div>
        <div class="gs-metric-box">
          <div class="lbl">95% ${tr("信賴區間", "Confidence")} (1.96×RMSE)</div>
          <div class="val">±${Number(qaResult.confidence_95_cm).toFixed(2)} cm</div>
        </div>
      </div>
      <div class="gs-form-group" style="margin-bottom:6px;">
        <label>${tr("控制點 / 檢核點座標表 (Name, E, N, H_gcp)", "Check Points CSV (Name, E, N, H_gcp)")}</label>
        <textarea class="gs-input" id="txtGcpCsvInput" rows="4" style="font-family:var(--font-mono);font-size:11px;">${escapeHtml(csvDefault)}</textarea>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <button type="button" class="btn-xs primary" id="btnComputeGcpQa" style="flex:1;justify-content:center;">
          ${tr("計算 RMSE_Z 精度", "Compute RMSE_Z QA")}
        </button>
        <button type="button" class="btn-xs" id="btnLoadSampleGcpPoints" title="${tr("自動載入工區分佈檢核點", "Auto-Generate Site Check Points")}">
          ${tr("自動佈點", "Sample GCPs")}
        </button>
      </div>
      <div style="max-height:150px;overflow:auto;border:1px solid var(--ui-border);border-radius:7px;margin-bottom:8px;">
        <table class="gs-table" style="font-size:11px;">
          <thead>
            <tr><th>ID</th><th>H_gcp (m)</th><th>H_scan (m)</th><th>ΔH (cm)</th></tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <div style="display:flex;gap:6px;">
        <a class="btn-xs primary" href="${escapeHtml(appendAuthToDownloadUrl(qaResult.html_url || "#"))}" target="_blank" rel="noopener" style="flex:1;justify-content:center;text-decoration:none;">
          ${tr("📄 開啟 QA 精度證書", "📄 Printable QA Certificate")}
        </a>
        <a class="btn-xs" href="${escapeHtml(appendAuthToDownloadUrl(qaResult.csv_url || "#"))}" download style="text-decoration:none;">
          ${tr("下載 CSV", "CSV")}
        </a>
      </div>
      `
    );

    document.getElementById("btnComputeGcpQa")?.addEventListener("click", () => {
      const txt = document.getElementById("txtGcpCsvInput")?.value || "";
      const parsed = parseGcpCsvInput(txt);
      runGcpAccuracyQaEvaluation(parsed);
    });
    document.getElementById("btnLoadSampleGcpPoints")?.addEventListener("click", () => {
      runGcpAccuracyQaEvaluation([]);
    });
  }

  // ============================================================================
  // FEATURE 6: PIX4DMATIC CALIBRATED CAMERA TRAJECTORY, 3D FRUSTUM & 2D RETICLE
  // ============================================================================
  const SUB_SCAN_TRAJ_PALETTE = ["#38bdf8", "#10b981", "#f59e0b", "#a855f7", "#f43f5e", "#06b6d4"];

  function clearRtkPhotoFrustums3D() {
    if (studioThree && studioThree.photoFrustumGroup) {
      studioThree.photoFrustumGroup.visible = false;
      if (studioThree.overlayGroup) {
        studioThree.overlayGroup.remove(studioThree.photoFrustumGroup);
      }
      studioThree.photoFrustumGroup = null;
    }
    const ov = document.getElementById("studioPhotoFrustumOverlay");
    if (ov) ov.style.display = "none";
  }

  function clearCameraTrajectory3D() {
    if (studioThree && studioThree.cameraTrajectoryGroup) {
      studioThree.cameraTrajectoryGroup.visible = false;
      if (studioThree.overlayGroup) {
        studioThree.overlayGroup.remove(studioThree.cameraTrajectoryGroup);
      }
      studioThree.cameraTrajectoryGroup = null;
    }
  }
  window.clearCameraTrajectory3D = clearCameraTrajectory3D;

  function clearPhotoTargetVisuals3D() {
    const hideTrajectory = Boolean(arguments[0]);
    clearRtkPhotoFrustums3D();
    if (hideTrajectory || (STATE.activeTool !== "photos" && STATE.activeTool !== "rtk")) {
      clearCameraTrajectory3D();
      if (studioThree && studioThree.cameraTrajectoryGroup) {
        studioThree.cameraTrajectoryGroup.visible = false;
      }
    }
    if (studioThree && studioThree.photoFrustumGroup) {
      studioThree.photoFrustumGroup.visible = false;
    }
    if (studioThree && studioThree.photoTargetGroup) {
      studioThree.photoTargetGroup.visible = false;
      if (studioThree.overlayGroup) {
        studioThree.overlayGroup.remove(studioThree.photoTargetGroup);
      }
      studioThree.photoTargetGroup = null;
    }
    if (studioThree && studioThree.overlayGroup) {
      const toRemove = [];
      studioThree.overlayGroup.children.forEach((c) => {
        if (c && c.userData && c.userData.isPhotoTargetPin) {
          toRemove.push(c);
        }
      });
      toRemove.forEach((c) => studioThree.overlayGroup.remove(c));
    }
    STATE.lastInspectedPhotoTargetPt = null;
  }
  window.clearPhotoTargetVisuals3D = clearPhotoTargetVisuals3D;

  function placePhotoTargetMarker3D(targetPt) {
    if (!studioThree || !studioThree.overlayGroup || !targetPt) return;
    if (studioThree.photoTargetGroup) {
      studioThree.photoTargetGroup.visible = false;
      studioThree.overlayGroup.remove(studioThree.photoTargetGroup);
      studioThree.photoTargetGroup = null;
    }
    const toRemove = [];
    studioThree.overlayGroup.children.forEach((c) => {
      if (c && c.userData && c.userData.isPhotoTargetPin) {
        toRemove.push(c);
      }
    });
    toRemove.forEach((c) => studioThree.overlayGroup.remove(c));
    const targetGrp = new THREE.Group();
    targetGrp.name = "photoTargetGroup";
    targetGrp.visible = Boolean(STATE.activeTool === "photos" || STATE.activeTool === "rtk");
    targetGrp.userData.isPhotoTargetPin = true;
    studioThree.photoTargetGroup = targetGrp;
    studioThree.overlayGroup.add(targetGrp);
    if (typeof add3DPinMarker === "function") {
      add3DPinMarker(targetPt, 0x0284c7, targetGrp, (m) => {
        m.userData.isPhotoTargetPin = true;
        targetGrp.add(m);
      });
    }
  }
  window.placePhotoTargetMarker3D = placePhotoTargetMarker3D;

  function twd97ToStudioLocalVec(e, n, h, arg4, arg5) {
    let refTargetTwd = null;
    let refTargetLocalPt = null;
    if (arg4 && typeof arg4 === "object") {
      if (arg4.e !== undefined && arg4.n !== undefined) {
        refTargetTwd = arg4;
      } else if (arg4.x !== undefined && arg4.z !== undefined) {
        refTargetLocalPt = arg4;
      }
    }
    if (arg5 && typeof arg5 === "object") {
      if (arg5.e !== undefined && arg5.n !== undefined) {
        refTargetTwd = arg5;
      } else if (arg5.x !== undefined && arg5.z !== undefined) {
        refTargetLocalPt = arg5;
      }
    }
    if (refTargetTwd && refTargetLocalPt && Number.isFinite(refTargetTwd.e) && Number.isFinite(refTargetTwd.n)) {
      const dx = Number(e) - Number(refTargetTwd.e || 0);
      const dn = Number(n) - Number(refTargetTwd.n || 0);
      const dh = Number(h) - Number(refTargetTwd.h || 0);
      return new THREE.Vector3(
        refTargetLocalPt.x + dx,
        refTargetLocalPt.y + dh,
        refTargetLocalPt.z - dn
      );
    }
    const originTwd = typeof localToTwd97 === "function" ? localToTwd97({ x: 0, y: 0, z: 0 }) : { e: 0, n: 0, h: 0 };
    return new THREE.Vector3(
      Number(e) - Number(originTwd.e || 0),
      Number(h) - Number(originTwd.h || 0),
      Number(originTwd.n || 0) - Number(n)
    );
  }
  window.twd97ToStudioLocalVec = twd97ToStudioLocalVec;

  function _projectWorldPointToPhotoUV(photo, targetTwd) {
    if (!photo) return { u: 0.5, v: 0.5, inFov: true, zc: 3.0 };
    if (
      targetTwd &&
      Array.isArray(photo.right) &&
      photo.right.length === 3 &&
      Array.isArray(photo.down) &&
      photo.down.length === 3 &&
      Array.isArray(photo.forward) &&
      photo.forward.length === 3
    ) {
      const camE = Number(photo.camera_twd97_e ?? photo.e ?? 0);
      const camN = Number(photo.camera_twd97_n ?? photo.n ?? 0);
      const camH = Number(photo.camera_twd97_h ?? photo.h ?? 0);
      const dx = Number(targetTwd.e) - camE;
      const dy = Number(targetTwd.n) - camN;
      const dz = Number(targetTwd.h) - camH;
      const r = photo.right;
      const d = photo.down;
      const f = photo.forward;
      const zc = dx * f[0] + dy * f[1] + dz * f[2];
      if (zc > 0.15) {
        const xc = dx * r[0] + dy * r[1] + dz * r[2];
        const yc = dx * d[0] + dy * d[1] + dz * d[2];
        const fx = Number(photo.fx_norm || 0.92674);
        const fy = Number(photo.fy_norm || 0.69505);
        const u = 0.5 + fx * (xc / zc);
        const v = 0.5 + fy * (yc / zc);
        return {
          u: Math.max(0.02, Math.min(0.98, u)),
          v: Math.max(0.02, Math.min(0.98, v)),
          rawU: u,
          rawV: v,
          inFov: u >= 0.01 && u <= 0.99 && v >= 0.01 && v <= 0.99,
          zc,
        };
      }
    }
    if (photo.target_uv && Number.isFinite(Number(photo.target_uv.u)) && Number.isFinite(Number(photo.target_uv.v))) {
      return {
        u: Number(photo.target_uv.u),
        v: Number(photo.target_uv.v),
        in_fov: photo.target_uv.in_fov !== false,
        inFov: photo.target_uv.in_fov !== false,
      };
    }
    const uFb = Number.isFinite(Number(photo.proj_u)) ? Number(photo.proj_u) : 0.5;
    const vFb = Number.isFinite(Number(photo.proj_v)) ? Number(photo.proj_v) : 0.5;
    return {
      u: Math.max(0.02, Math.min(0.98, uFb)),
      v: Math.max(0.02, Math.min(0.98, vFb)),
      rawU: uFb,
      rawV: vFb,
      inFov: photo.in_fov !== false,
      zc: Number(photo.distance_m || 3.0),
    };
  }
  window._projectWorldPointToPhotoUV = _projectWorldPointToPhotoUV;

  async function loadAndRenderScanCameraTrajectory3D(scanId, forceReanchor = false, forceNetworkReload = false) {
    const sid = String(scanId || STATE.activeScanId || "").trim();
    if (!sid || !studioThree || !studioThree.overlayGroup) return null;
    if (!STATE.scanCameraCatalogCache) STATE.scanCameraCatalogCache = {};
    if (STATE.showCameraTrajectory3D === undefined) STATE.showCameraTrajectory3D = true;

    let camRes =
      !forceNetworkReload &&
      ((STATE.scanCameraCatalogScanId === sid && STATE.scanCameraCatalog) || STATE.scanCameraCatalogCache[sid])
        ? STATE.scanCameraCatalog || STATE.scanCameraCatalogCache[sid]
        : null;
    if (!camRes) {
      try {
        camRes = await apiGet(`/api/survey/cameras?scan_id=${encodeURIComponent(sid)}&limit=10000`);
        if (camRes && Array.isArray(camRes.cameras)) {
          STATE.scanCameraCatalogCache[sid] = camRes;
        }
      } catch (_) {
        return null;
      }
    }
    if (!camRes || !Array.isArray(camRes.cameras)) return null;
    STATE.scanCameraCatalog = camRes;
    STATE.scanCameraCatalogScanId = sid;
    STATE.activeScanCameras = camRes.cameras;
    STATE.activeScanCameraMeta = camRes;

    const originTwd = typeof localToTwd97 === "function" ? localToTwd97({ x: 0, y: 0, z: 0 }) : camRes.anchor_twd97 || { e: 0, n: 0, h: 0 };
    if (
      !forceReanchor &&
      !forceNetworkReload &&
      studioThree.cameraTrajectoryGroup &&
      studioThree.cameraTrajectoryScanId === sid &&
      Math.abs((studioThree.cameraTrajectoryOriginH || 0) - Number(originTwd.h || 0)) <= 0.01
    ) {
      studioThree.cameraTrajectoryGroup.visible = Boolean(
        STATE.showCameraTrajectory3D !== false && (STATE.activeTool === "photos" || STATE.activeTool === "rtk")
      );
      return camRes;
    }

    clearCameraTrajectory3D();
    if (!STATE.showCameraTrajectory3D) return camRes;

    const grp = new THREE.Group();
    grp.name = "cameraTrajectoryGroup";
    grp.visible = Boolean(
      STATE.showCameraTrajectory3D !== false && (STATE.activeTool === "photos" || STATE.activeTool === "rtk")
    );
    studioThree.cameraTrajectoryGroup = grp;
    studioThree.cameraTrajectoryScanId = sid;
    studioThree.cameraTrajectoryOriginH = Number(originTwd.h || 0);
    studioThree.overlayGroup.add(grp);

    const bySubScan = new Map();
    camRes.cameras.forEach((c) => {
      const subKey = String(c.sub_scan || sid);
      if (!bySubScan.has(subKey)) bySubScan.set(subKey, []);
      const lx = Number(c.e) - Number(originTwd.e || 0);
      const ly = Number(c.h) - Number(originTwd.h || 0);
      const lz = Number(originTwd.n || 0) - Number(c.n);
      c._localPt = new THREE.Vector3(lx, ly, lz);
      bySubScan.get(subKey).push(c);
    });

    let subIdx = 0;
    bySubScan.forEach((camList) => {
      const hexStr = SUB_SCAN_TRAJ_PALETTE[subIdx % SUB_SCAN_TRAJ_PALETTE.length];
      const col = new THREE.Color(hexStr);
      subIdx += 1;

      const linePts = [];
      const dotPts = [];
      const tickPts = [];
      const frustumPts = [];
      const frustumStride = Math.max(1, Math.ceil(camList.length / 36));
      for (let i = 0; i < camList.length; i++) {
        const c = camList[i];
        const pt = c._localPt;
        dotPts.push(pt);
        if (i > 0) {
          const prevPt = camList[i - 1]._localPt;
          if (pt.distanceTo(prevPt) <= 18.0) {
            linePts.push(prevPt, pt);
          }
        }
        if (Array.isArray(c.forward) && c.forward.length === 3 && i % 3 === 0) {
          const fVec = new THREE.Vector3(c.forward[0], c.forward[2], -c.forward[1]).normalize();
          tickPts.push(pt, pt.clone().addScaledVector(fVec, 0.36));
        }
        if (i % frustumStride === 0) {
          let dir;
          let right;
          let up;
          if (
            Array.isArray(c.forward) &&
            c.forward.length === 3 &&
            Array.isArray(c.right) &&
            c.right.length === 3 &&
            Array.isArray(c.down) &&
            c.down.length === 3
          ) {
            dir = new THREE.Vector3(c.forward[0], c.forward[2], -c.forward[1]).normalize();
            right = new THREE.Vector3(c.right[0], c.right[2], -c.right[1]).normalize();
            up = new THREE.Vector3(-c.down[0], -c.down[2], c.down[1]).normalize();
          } else if (Array.isArray(c.forward) && c.forward.length === 3) {
            dir = new THREE.Vector3(c.forward[0], c.forward[2], -c.forward[1]).normalize();
            right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
            if (right.lengthSq() < 0.01) right.set(1, 0, 0);
            up = new THREE.Vector3().crossVectors(right, dir).normalize();
          } else {
            const yawRad = THREE.MathUtils.degToRad(Number(c.yaw_deg) || 0);
            const pitchRad = THREE.MathUtils.degToRad(Number(c.pitch_deg) || -15);
            dir = new THREE.Vector3(
              Math.sin(yawRad) * Math.cos(pitchRad),
              Math.sin(pitchRad),
              -Math.cos(yawRad) * Math.cos(pitchRad)
            ).normalize();
            right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
            if (right.lengthSq() < 0.01) right.set(1, 0, 0);
            up = new THREE.Vector3().crossVectors(right, dir).normalize();
          }
          const fDepth = 1.4;
          const halfW = 0.65;
          const halfH = 0.45;
          const centerPlane = pt.clone().addScaledVector(dir, fDepth);
          const c0 = centerPlane.clone().addScaledVector(right, -halfW).addScaledVector(up, halfH);
          const c1 = centerPlane.clone().addScaledVector(right, halfW).addScaledVector(up, halfH);
          const c2 = centerPlane.clone().addScaledVector(right, halfW).addScaledVector(up, -halfH);
          const c3 = centerPlane.clone().addScaledVector(right, -halfW).addScaledVector(up, -halfH);
          frustumPts.push(pt, c0, pt, c1, pt, c2, pt, c3, c0, c1, c1, c2, c2, c3, c3, c0);
        }
      }

      if (linePts.length >= 2) {
        const lGeo = new THREE.BufferGeometry().setFromPoints(linePts);
        const lMat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.58, depthTest: false });
        const lMesh = new THREE.LineSegments(lGeo, lMat);
        lMesh.renderOrder = 992;
        grp.add(lMesh);
      }
      if (frustumPts.length >= 2) {
        const fGeo = new THREE.BufferGeometry().setFromPoints(frustumPts);
        const fMat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.75, depthTest: false });
        const fMesh = new THREE.LineSegments(fGeo, fMat);
        fMesh.renderOrder = 993;
        grp.add(fMesh);
      }
      if (tickPts.length >= 2) {
        const tGeo = new THREE.BufferGeometry().setFromPoints(tickPts);
        const tMat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.42, depthTest: false });
        const tMesh = new THREE.LineSegments(tGeo, tMat);
        tMesh.renderOrder = 993;
        grp.add(tMesh);
      }
      if (dotPts.length > 0) {
        const pGeo = new THREE.BufferGeometry().setFromPoints(dotPts);
        const pMat = new THREE.PointsMaterial({
          color: col,
          size: 4.5,
          sizeAttenuation: false,
          transparent: true,
          opacity: 0.88,
          depthTest: false,
        });
        const pMesh = new THREE.Points(pGeo, pMat);
        pMesh.renderOrder = 994;
        grp.add(pMesh);
      }
    });

    return camRes;
  }
  window.loadAndRenderScanCameraTrajectory3D = loadAndRenderScanCameraTrajectory3D;

  function pickCameraTrajectoryMarkerAtScreenXY(clientX, clientY) {
    if (!studioThree || !studioThree.camera || !studioThree.renderer) return null;
    const rect = studioThree.renderer.domElement.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const threshPx = window.innerWidth <= 768 ? 22 : 14;

    const findBestInPool = (pool) => {
      let bestCam = null;
      let bestScore = Infinity;
      for (let i = 0; i < pool.length; i++) {
        const c = pool[i];
        const pt =
          c._localCamPt ||
          c._localPt ||
          (c.camera_twd97_e !== undefined || c.e !== undefined
            ? twd97ToStudioLocalVec(
                c.camera_twd97_e ?? c.e,
                c.camera_twd97_n ?? c.n,
                c.camera_twd97_h ?? c.h,
                STATE.lastInspectedPhotoTargetTwd,
                STATE.lastInspectedPhotoTargetPt
              )
            : null);
        if (!pt) continue;
        const proj = pt.clone().project(studioThree.camera);
        if (proj.z < -1.0 || proj.z > 1.0) continue;
        const sx = rect.left + (proj.x * 0.5 + 0.5) * w;
        const sy = rect.top + (-proj.y * 0.5 + 0.5) * h;
        const dPx = Math.hypot(clientX - sx, clientY - sy);
        if (dPx <= threshPx) {
          const dist3D = studioThree.camera.position.distanceTo(pt);
          const score = dPx + Math.min(8.0, dist3D * 0.08);
          if (score < bestScore) {
            bestScore = score;
            bestCam = c;
          }
        }
      }
      return bestCam;
    };

    // 1. Check active frustum cameras first so active frustum apexes always take priority
    const activePool = Array.isArray(STATE.lastInspectedPhotos) ? STATE.lastInspectedPhotos : [];
    const hitActive = findBestInPool(activePool);
    if (hitActive) return hitActive;

    // 2. Check trajectory markers with 3D depth weighting so foreground cameras win over background cameras
    if (STATE.showCameraTrajectory3D === false) return null;
    const trajPool = Array.isArray(STATE.scanCameraCatalog?.cameras)
      ? STATE.scanCameraCatalog.cameras
      : Array.isArray(STATE.activeScanCameras)
      ? STATE.activeScanCameras
      : Array.isArray(STATE.scanCameraCatalog)
      ? STATE.scanCameraCatalog
      : [];
    return findBestInPool(trajPool);
  }
  window.pickCameraTrajectoryMarkerAtScreenXY = pickCameraTrajectoryMarkerAtScreenXY;

  function selectCalibratedCameraFrom3D(cam) {
    if (!cam || !studioThree) return false;
    const camPt =
      cam._localCamPt ||
      cam._localPt ||
      twd97ToStudioLocalVec(cam.camera_twd97_e ?? cam.e, cam.camera_twd97_n ?? cam.n, cam.camera_twd97_h ?? cam.h);
    const fLocal = new THREE.Vector3(0, -0.25, -1).normalize();
    if (Array.isArray(cam.forward) && cam.forward.length === 3) {
      fLocal.set(cam.forward[0], cam.forward[2], -cam.forward[1]).normalize();
    }
    let targetPt = null;
    if (studioThree.modelPivot) {
      try {
        studioThree.modelPivot.updateMatrixWorld(true);
        const rc = new THREE.Raycaster(camPt.clone(), fLocal.clone(), 0.25, 65.0);
        rc.near = 0.25;
        rc.far = 65.0;
        const hits = rc.intersectObject(studioThree.modelPivot, true);
        const meshHits = Array.isArray(hits)
          ? hits.filter((h) => h && h.object && h.object.isMesh && h.object.visible !== false && !h.object.userData?.isAlignBoxHelper)
          : [];
        if (meshHits.length > 0) {
          targetPt = meshHits[0].point.clone();
        }
      } catch (_) {}
    }
    clearPhotoTargetVisuals3D(false);
    if (targetPt) {
      placePhotoTargetMarker3D(targetPt);
      renderRtkPhotoInspectorPanel(targetPt, true, cam.filename);
    } else {
      renderRtkPhotoInspectorPanel(null, true, cam.filename);
    }
    return true;
  }
  window.selectCalibratedCameraFrom3D = selectCalibratedCameraFrom3D;

  function renderRtkPhotoFrustums3D(photos, arg2, arg3, highlightIdx = 0) {
    if (!studioThree || !studioThree.overlayGroup || !Array.isArray(photos)) return;
    if (studioThree.photoFrustumGroup) {
      studioThree.overlayGroup.remove(studioThree.photoFrustumGroup);
      studioThree.photoFrustumGroup = null;
    }
    const grp = new THREE.Group();
    grp.visible = Boolean(STATE.activeTool === "photos" || STATE.activeTool === "rtk");
    studioThree.photoFrustumGroup = grp;
    studioThree.overlayGroup.add(grp);

    let targetTwd = null;
    let targetLocalPt = null;
    if (arg2 && typeof arg2 === "object") {
      if (arg2.e !== undefined && arg2.n !== undefined) {
        targetTwd = arg2;
      } else if (arg2.x !== undefined && arg2.z !== undefined) {
        targetLocalPt = arg2;
      }
    }
    if (arg3 && typeof arg3 === "object") {
      if (arg3.e !== undefined && arg3.n !== undefined) {
        targetTwd = arg3;
      } else if (arg3.x !== undefined && arg3.z !== undefined) {
        targetLocalPt = arg3;
      }
    }
    const tgtPt = targetLocalPt
      ? targetLocalPt.clone
        ? targetLocalPt.clone()
        : new THREE.Vector3(Number(targetLocalPt.x) || 0, Number(targetLocalPt.y) || 0, Number(targetLocalPt.z) || 0)
      : targetTwd
      ? twd97ToStudioLocalVec(targetTwd.e, targetTwd.n, targetTwd.h, null, null)
      : new THREE.Vector3(0, 0, 0);
    photos.forEach((p, idx) => {
      const camPt = twd97ToStudioLocalVec(
        p.camera_twd97_e ?? p.e,
        p.camera_twd97_n ?? p.n,
        p.camera_twd97_h ?? p.h,
        targetTwd,
        tgtPt
      );
      p._localCamPt = camPt;
      p._localTargetPt = tgtPt.clone();

      const distToTgt = Math.max(1.2, camPt.distanceTo(tgtPt));
      const frustumDepth = Math.min(2.4, Math.max(0.75, distToTgt * 0.38));

      // Use canonical upright Pix4Dmatic basis (right, down, forward) in Three.js local coordinates (X=+E, Y=+H, Z=-N)
      let dir;
      let right;
      let up;
      if (
        Array.isArray(p.forward) &&
        p.forward.length === 3 &&
        Array.isArray(p.right) &&
        p.right.length === 3 &&
        Array.isArray(p.down) &&
        p.down.length === 3
      ) {
        dir = new THREE.Vector3(p.forward[0], p.forward[2], -p.forward[1]).normalize();
        right = new THREE.Vector3(p.right[0], p.right[2], -p.right[1]).normalize();
        up = new THREE.Vector3(-p.down[0], -p.down[2], p.down[1]).normalize();
      } else {
        dir = tgtPt.clone().sub(camPt).normalize();
        right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
        if (right.lengthSq() < 0.01) right.set(1, 0, 0);
        up = new THREE.Vector3().crossVectors(right, dir).normalize();
      }

      const fxNorm = Number(p.fx_norm || 0.92674);
      const fyNorm = Number(p.fy_norm || 0.69505);
      const halfW = frustumDepth / (2.0 * Math.max(0.35, fxNorm));
      const halfH = frustumDepth / (2.0 * Math.max(0.35, fyNorm));

      const centerPlane = camPt.clone().addScaledVector(dir, frustumDepth);
      const c0 = centerPlane.clone().addScaledVector(right, -halfW).addScaledVector(up, halfH); // Top-Left
      const c1 = centerPlane.clone().addScaledVector(right, halfW).addScaledVector(up, halfH); // Top-Right
      const c2 = centerPlane.clone().addScaledVector(right, halfW).addScaledVector(up, -halfH); // Bottom-Right
      const c3 = centerPlane.clone().addScaledVector(right, -halfW).addScaledVector(up, -halfH); // Bottom-Left
      // Top UP-orientation triangle above top edge c0-c1
      const topMid = centerPlane.clone().addScaledVector(up, halfH * 1.18);

      const isPrimary = idx === highlightIdx;
      const col = isPrimary ? 0x38bdf8 : 0xf59e0b;

      const frustumPts = [
        camPt, c0, camPt, c1, camPt, c2, camPt, c3,
        c0, c1, c1, c2, c2, c3, c3, c0,
        c0, topMid, c1, topMid,
        camPt, tgtPt,
      ];
      const lineGeo = new THREE.BufferGeometry().setFromPoints(frustumPts);
      const line = new THREE.LineSegments(
        lineGeo,
        new THREE.LineBasicMaterial({
          color: col,
          depthTest: false,
          transparent: true,
          opacity: isPrimary ? 0.96 : 0.78,
        })
      );
      line.renderOrder = isPrimary ? 998 : 997;
      grp.add(line);

      // Semi-transparent image plane quad inside the frustum
      const quadGeo = new THREE.BufferGeometry();
      const quadVerts = new Float32Array([
        c0.x, c0.y, c0.z, c1.x, c1.y, c1.z, c2.x, c2.y, c2.z,
        c0.x, c0.y, c0.z, c2.x, c2.y, c2.z, c3.x, c3.y, c3.z,
      ]);
      quadGeo.setAttribute("position", new THREE.BufferAttribute(quadVerts, 3));
      const quadMesh = new THREE.Mesh(
        quadGeo,
        new THREE.MeshBasicMaterial({
          color: col,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: isPrimary ? 0.16 : 0.07,
          depthTest: false,
        })
      );
      quadMesh.renderOrder = 996;
      grp.add(quadMesh);

      // Camera apex marker sphere
      const apexMesh = new THREE.Mesh(
        new THREE.SphereGeometry(isPrimary ? 0.14 : 0.1, 12, 12),
        new THREE.MeshBasicMaterial({ color: col, depthTest: false })
      );
      apexMesh.position.copy(camPt);
      apexMesh.renderOrder = 999;
      grp.add(apexMesh);
    });
  }
  window.renderRtkPhotoFrustums3D = renderRtkPhotoFrustums3D;
  window.renderPhoto3DFrustums = renderRtkPhotoFrustums3D;

  function alignStudioCameraToRtkPhoto(photo, opacityPct = 55) {
    if (!photo || !studioThree) return;
    if (STATE.fpMode?.active && typeof exitFirstPersonMode === "function") {
      exitFirstPersonMode(false);
    }
    const tgtPt = photo._localTargetPt || STATE.lastInspectedPhotoTargetPt || null;
    const camPt =
      photo._localCamPt ||
      twd97ToStudioLocalVec(
        photo.camera_twd97_e ?? photo.e,
        photo.camera_twd97_n ?? photo.n,
        photo.camera_twd97_h ?? photo.h,
        tgtPt,
        STATE.lastInspectedPhotoTargetTwd
      );
    studioThree.camera.position.copy(camPt);
    if (Array.isArray(photo.forward) && photo.forward.length === 3) {
      const fDir = new THREE.Vector3(
        Number(photo.forward[0]) || 0,
        Number(photo.forward[2]) || 0,
        -(Number(photo.forward[1]) || 0)
      ).normalize();
      studioThree.controls.target
        .copy(camPt)
        .addScaledVector(fDir, Math.max(2.0, tgtPt ? camPt.distanceTo(tgtPt) : 5.0));
    } else {
      studioThree.controls.target.copy(tgtPt || new THREE.Vector3(0, 0, 0));
    }
    studioThree.controls.update();
    studioThree.camera.updateMatrixWorld();

    const pct = Math.max(0, Math.min(90, Number(opacityPct) || 0));
    STATE.photoOverlayOpacity = pct / 100.0;
    const ov = document.getElementById("studioPhotoFrustumOverlay");
    const img = document.getElementById("studioPhotoFrustumImg");
    const badge = document.getElementById("studioPhotoFrustumBadge");
    if (ov && img) {
      if (pct > 0 && photo.url) {
        img.src = photo.url;
        ov.style.display = "flex";
        ov.style.opacity = String(STATE.photoOverlayOpacity);
        if (badge) {
          badge.textContent = `📷 ${photo.filename} · RTK σ=${photo.rtk_h_sigma_cm}cm (${pct}% Overlay)`;
        }
      } else {
        ov.style.display = "none";
      }
    }
    const slider = document.getElementById("rtkPhotoOverlayOpacitySlider");
    if (slider) slider.value = String(pct);
    const lbl = document.getElementById("lblRtkPhotoOverlayOpacity");
    if (lbl) lbl.textContent = `${pct}%`;
    showToast(
      tr(
        `已將 3D 相機對齊至 RTK 照片「${photo.filename}」視角`,
        `Aligned 3D Camera to RTK Photo "${photo.filename}"`
      )
    );
  }

  function openPhotoLightboxModal(photoUrl, photoTitle = "", photoMetaText = "", allPhotos = [], curIdx = 0) {
    if (!photoUrl) return;
    let modal = document.getElementById("gsPhotoLightboxModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "gsPhotoLightboxModal";
      document.body.appendChild(modal);
    }
    modal.className = "gs-lightbox-backdrop";
    const list = Array.isArray(allPhotos) && allPhotos.length > 0 ? allPhotos : [{ url: photoUrl, filename: photoTitle, meta: photoMetaText }];
    let activeIdx = Math.max(0, Math.min(list.length - 1, Number(curIdx) || 0));
    let showReticle = true;

    const renderLightboxContent = () => {
      const isLight =
        document.documentElement.getAttribute("data-theme") === "light" ||
        document.documentElement.getAttribute("data-theme") === "bright" ||
        document.body.classList.contains("theme-light") ||
        document.body.classList.contains("theme-bright") ||
        STATE.resolvedTheme === "light";
      modal.classList.toggle("is-light-theme", isLight);
      modal.style.cssText = `position:fixed;inset:0;z-index:9999;background:${
        isLight ? "rgba(241, 245, 249, 0.86)" : "rgba(2, 6, 23, 0.92)"
      };backdrop-filter:blur(10px);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;`;

      const item = list[activeIdx] || { url: photoUrl, filename: photoTitle, meta: photoMetaText };
      const url = item.url || photoUrl;
      const fname = item.filename || photoTitle || "RTK_Photo.jpg";
      const uv = _projectWorldPointToPhotoUV(item, STATE.lastInspectedPhotoTargetTwd);
      const hasTargetReticle = Boolean(
        item.proj_u !== undefined ||
        (item.target_uv && item.target_uv.u !== undefined) ||
        (Array.isArray(item.forward) && STATE.lastInspectedPhotoTargetTwd)
      );
      const meta =
        item.meta ||
        photoMetaText ||
        (item.camera_twd97_e !== undefined
          ? `E:${item.camera_twd97_e}m | N:${item.camera_twd97_n}m | H:+${item.camera_twd97_h}m | RTK σ=${item.rtk_h_sigma_cm || 1.2}cm`
          : "");
      modal.innerHTML = `
        <div class="gs-lightbox-card" style="width:min(1180px,96vw);display:flex;flex-direction:column;border-radius:14px;overflow:hidden;background:${
          isLight ? "#ffffff" : "#0b1120"
        };border:1px solid ${
          isLight ? "rgba(15, 23, 42, 0.14)" : "rgba(148, 163, 184, 0.26)"
        };box-shadow:${
          isLight ? "0 20px 50px rgba(15, 23, 42, 0.18)" : "0 24px 60px rgba(0, 0, 0, 0.65)"
        };">
          <div class="gs-lightbox-header" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;background:${
            isLight ? "#f8fafc" : "rgba(15, 23, 42, 0.92)"
          };border-bottom:1px solid ${
            isLight ? "rgba(15, 23, 42, 0.10)" : "rgba(148, 163, 184, 0.18)"
          };color:${isLight ? "#0f172a" : "#f8fafc"};">
            <div style="min-width:0;">
              <div style="font-size:13.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${
                isLight ? "#0f172a" : "#f8fafc"
              };">📷 ${escapeHtml(fname)}</div>
              <div class="gs-lightbox-meta" style="font-size:11px;color:${
                isLight ? "#475569" : "#94a3b8"
              };font-family:var(--font-mono);">${escapeHtml(meta)}</div>
            </div>
            <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
              ${
                hasTargetReticle
                  ? `<button type="button" class="gs-top-btn gs-lightbox-btn ${showReticle ? "accent" : ""}" id="btnLightboxToggleReticle" style="height:30px;padding:0 10px;" title="${tr("切換 3D 點擊目標準星", "Toggle 3D Target Reticle")}">🎯 ${tr("目標準星", "Target Reticle")}</button>`
                  : ""
              }
              ${
                list.length > 1
                  ? `<button type="button" class="gs-top-btn gs-lightbox-btn" id="btnLightboxPrev" style="height:30px;padding:0 10px;">◀ ${tr("上一張", "Prev")}</button>
                     <span class="gs-lightbox-meta" style="font-size:11.5px;font-family:var(--font-mono);color:${
                       isLight ? "#475569" : "#cbd5e1"
                     };">${activeIdx + 1} / ${list.length}</span>
                     <button type="button" class="gs-top-btn gs-lightbox-btn" id="btnLightboxNext" style="height:30px;padding:0 10px;">${tr("下一張", "Next")} ▶</button>`
                  : ""
              }
              <a class="gs-top-btn gs-lightbox-btn accent" href="${escapeHtml(url)}" download="${escapeHtml(fname)}" style="height:30px;padding:0 12px;text-decoration:none;display:inline-flex;align-items:center;gap:5px;">
                <span>⬇ ${tr("下載照片", "Download")}</span>
              </a>
              <button type="button" class="gs-top-btn gs-lightbox-btn" id="btnLightboxClose" style="height:30px;padding:0 12px;">✕ ${tr("關閉", "Close")}</button>
            </div>
          </div>
          <div id="photoLightboxViewport" class="gs-lightbox-stage" style="position:relative;width:100%;height:min(74vh,740px);background:${
            isLight ? "#f1f5f9" : "#0f172a"
          };display:flex;align-items:center;justify-content:center;overflow:hidden;user-select:none;touch-action:none;">
            <div id="lightboxZoomCanvas" style="position:relative;display:inline-flex;align-items:center;justify-content:center;max-width:100%;max-height:100%;transform-origin:center center;will-change:transform;">
              <img id="imgLightboxMain" src="${escapeHtml(url)}" alt="${escapeHtml(fname)}" draggable="false" style="display:block;max-width:min(1140px,93vw);max-height:min(72vh,720px);width:auto;height:auto;object-fit:contain;cursor:zoom-in;" />
              ${
                hasTargetReticle
                  ? `<div id="lightboxTargetReticle" style="display:${showReticle ? "block" : "none"};position:absolute;left:${(uv.u * 100).toFixed(2)}%;top:${(uv.v * 100).toFixed(2)}%;transform:translate(-50%,-50%);pointer-events:none;z-index:5;">
                       <div style="width:28px;height:28px;border:2px solid #0284c7;border-radius:50%;box-shadow:0 0 0 2px ${
                         isLight ? "rgba(255,255,255,0.92)" : "rgba(2,6,23,0.85)"
                       },0 0 12px #38bdf8;position:relative;">
                         <span style="position:absolute;left:50%;top:-7px;bottom:-7px;width:1.5px;background:#0284c7;transform:translateX(-50%);"></span>
                         <span style="position:absolute;top:50%;left:-7px;right:-7px;height:1.5px;background:#0284c7;transform:translateY(-50%);"></span>
                         <span style="position:absolute;left:50%;top:50%;width:5px;height:5px;border-radius:50%;background:#f43f5e;transform:translate(-50%,-50%);"></span>
                       </div>
                     </div>`
                  : ""
              }
            </div>
            <aside id="photoLightboxZoomSidebar" class="gs-photo-zoom-sidebar" aria-label="Photo Zoom Controls">
              <button type="button" class="gs-photo-zoom-btn gs-lightbox-btn" id="btnPhotoZoomIn" title="${tr("放大 (+)", "Zoom In (+)")}">+</button>
              <div class="gs-photo-zoom-slider-wrap">
                <input type="range" id="rngPhotoLightboxZoom" class="gs-photo-zoom-slider" min="1" max="25" step="0.1" value="1" orient="vertical" aria-label="Zoom Factor (1x to 25x)" />
              </div>
              <button type="button" class="gs-photo-zoom-btn gs-lightbox-btn" id="btnPhotoZoomOut" title="${tr("縮小 (−)", "Zoom Out (−)")}">−</button>
              <div class="gs-photo-zoom-badge gs-lightbox-meta" id="lblPhotoLightboxZoom">1.0×</div>
              <button type="button" class="gs-photo-zoom-reset gs-lightbox-btn" id="btnPhotoZoomReset" title="${tr("重設 1:1 比例", "Reset 1:1 Zoom")}">1:1</button>
            </aside>
          </div>
          ${
            list.length > 1
              ? `<div class="gs-lightbox-filmstrip" style="display:flex;align-items:center;gap:6px;padding:8px 12px;overflow-x:auto;background:${
                  isLight ? "#f8fafc" : "rgba(15, 23, 42, 0.92)"
                };border-top:1px solid ${
                  isLight ? "rgba(15, 23, 42, 0.10)" : "rgba(148, 163, 184, 0.18)"
                };">
                  ${list
                    .map(
                      (pItem, pIdx) => `
                    <button type="button" data-lightbox-thumb-idx="${pIdx}" class="gs-lightbox-btn" style="padding:2px;border-radius:6px;border:2px solid ${
                        pIdx === activeIdx
                          ? "#0284c7"
                          : isLight
                          ? "rgba(15,23,42,0.15)"
                          : "rgba(148,163,184,0.22)"
                      };background:${isLight ? "#ffffff" : "#0f172a"};cursor:pointer;flex-shrink:0;">
                      <img src="${escapeHtml(pItem.url || "")}" alt="${escapeHtml(pItem.filename || "")}" style="width:46px;height:34px;object-fit:cover;display:block;border-radius:4px;" />
                    </button>`
                    )
                    .join("")}
                </div>`
              : ""
          }
        </div>
      `;
      modal.style.display = "flex";

      let zoomFactor = 1.0;
      let panX = 0;
      let panY = 0;
      let isDragging = false;
      let dragMoved = false;
      let dragStartX = 0;
      let dragStartY = 0;
      let startPanX = 0;
      let startPanY = 0;

      const viewportEl = modal.querySelector("#photoLightboxViewport");
      const zoomCanvasEl = modal.querySelector("#lightboxZoomCanvas");
      const imgEl = modal.querySelector("#imgLightboxMain");
      const rngEl = modal.querySelector("#rngPhotoLightboxZoom");
      const lblEl = modal.querySelector("#lblPhotoLightboxZoom");
      const sidebarEl = modal.querySelector("#photoLightboxZoomSidebar");

      const clampPan = () => {
        if (!viewportEl || zoomFactor <= 1.001) {
          panX = 0;
          panY = 0;
          return;
        }
        const maxPanX = viewportEl.clientWidth * (zoomFactor - 1) * 0.55;
        const maxPanY = viewportEl.clientHeight * (zoomFactor - 1) * 0.55;
        panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
        panY = Math.max(-maxPanY, Math.min(maxPanY, panY));
      };

      const applyTransform = (animate = false) => {
        zoomFactor = Math.max(1.0, Math.min(25.0, Number(zoomFactor) || 1.0));
        clampPan();
        const targetEl = zoomCanvasEl || imgEl;
        if (targetEl) {
          targetEl.style.transition = animate ? "transform 0.14s ease-out" : "none";
          targetEl.style.transform = `translate3d(${panX.toFixed(1)}px, ${panY.toFixed(1)}px, 0) scale(${zoomFactor.toFixed(3)})`;
        }
        if (imgEl) {
          imgEl.style.cursor = isDragging ? "grabbing" : zoomFactor > 1.02 ? "grab" : "zoom-in";
        }
        if (rngEl && Math.abs(Number(rngEl.value) - zoomFactor) > 0.02) {
          rngEl.value = zoomFactor.toFixed(1);
        }
        if (lblEl) {
          lblEl.textContent = `${zoomFactor.toFixed(1)}×`;
        }
      };

      const setZoomAroundPoint = (nextZoom, clientX = null, clientY = null, animate = false) => {
        const clamped = Math.max(1.0, Math.min(25.0, Number(nextZoom) || 1.0));
        if (viewportEl && clientX !== null && clientY !== null && clamped > 1.001) {
          const rect = viewportEl.getBoundingClientRect();
          const cx = clientX - (rect.left + rect.width * 0.5);
          const cy = clientY - (rect.top + rect.height * 0.5);
          const ratio = clamped / Math.max(1.0, zoomFactor);
          panX = cx - (cx - panX) * ratio;
          panY = cy - (cy - panY) * ratio;
        } else if (clamped <= 1.001) {
          panX = 0;
          panY = 0;
        }
        zoomFactor = clamped;
        applyTransform(animate);
      };

      sidebarEl?.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      sidebarEl?.addEventListener("click", (ev) => ev.stopPropagation());

      modal.querySelector("#btnLightboxToggleReticle")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        showReticle = !showReticle;
        const retEl = modal.querySelector("#lightboxTargetReticle");
        if (retEl) retEl.style.display = showReticle ? "block" : "none";
        ev.currentTarget.classList.toggle("accent", showReticle);
      });

      modal.querySelector("#btnPhotoZoomIn")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const step = zoomFactor < 3 ? 0.5 : zoomFactor < 10 ? 1.5 : 2.5;
        setZoomAroundPoint(zoomFactor + step, null, null, true);
      });
      modal.querySelector("#btnPhotoZoomOut")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const step = zoomFactor <= 3 ? 0.5 : zoomFactor <= 10 ? 1.5 : 2.5;
        setZoomAroundPoint(zoomFactor - step, null, null, true);
      });
      modal.querySelector("#btnPhotoZoomReset")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        panX = 0;
        panY = 0;
        setZoomAroundPoint(1.0, null, null, true);
      });
      rngEl?.addEventListener("input", (ev) => {
        ev.stopPropagation();
        setZoomAroundPoint(parseFloat(ev.target.value) || 1.0, null, null, false);
      });

      viewportEl?.addEventListener(
        "wheel",
        (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const factor = ev.deltaY < 0 ? 1.18 : 1 / 1.18;
          setZoomAroundPoint(zoomFactor * factor, ev.clientX, ev.clientY, false);
        },
        { passive: false }
      );

      viewportEl?.addEventListener("pointerdown", (ev) => {
        if (ev.target && ev.target.closest && ev.target.closest("#photoLightboxZoomSidebar")) return;
        if (ev.button !== 0) return;
        isDragging = true;
        dragMoved = false;
        dragStartX = ev.clientX;
        dragStartY = ev.clientY;
        startPanX = panX;
        startPanY = panY;
        try {
          viewportEl.setPointerCapture(ev.pointerId);
        } catch (_) {}
        applyTransform(false);
      });

      viewportEl?.addEventListener("pointermove", (ev) => {
        if (!isDragging) return;
        const dx = ev.clientX - dragStartX;
        const dy = ev.clientY - dragStartY;
        if (Math.hypot(dx, dy) > 4) dragMoved = true;
        if (zoomFactor > 1.01) {
          panX = startPanX + dx;
          panY = startPanY + dy;
          applyTransform(false);
        }
      });

      const endDrag = (ev) => {
        if (!isDragging) return;
        isDragging = false;
        try {
          viewportEl?.releasePointerCapture(ev.pointerId);
        } catch (_) {}
        applyTransform(false);
      };
      viewportEl?.addEventListener("pointerup", endDrag);
      viewportEl?.addEventListener("pointercancel", endDrag);

      imgEl?.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        const nextZ = zoomFactor < 3.5 ? 4.0 : zoomFactor < 10.0 ? 12.0 : 1.0;
        setZoomAroundPoint(nextZ, ev.clientX, ev.clientY, true);
      });

      imgEl?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (dragMoved) return;
        if (zoomFactor <= 1.02) {
          setZoomAroundPoint(3.0, ev.clientX, ev.clientY, true);
        }
      });

      modal.querySelector("#btnLightboxClose")?.addEventListener("click", () => {
        modal.style.display = "none";
      });
      modal.querySelector("#btnLightboxPrev")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        activeIdx = (activeIdx - 1 + list.length) % list.length;
        renderLightboxContent();
      });
      modal.querySelector("#btnLightboxNext")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        activeIdx = (activeIdx + 1) % list.length;
        renderLightboxContent();
      });
      modal.querySelectorAll("[data-lightbox-thumb-idx]").forEach((tBtn) => {
        tBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const tIdx = Number(tBtn.getAttribute("data-lightbox-thumb-idx"));
          if (Number.isFinite(tIdx) && tIdx >= 0 && tIdx < list.length) {
            activeIdx = tIdx;
            renderLightboxContent();
          }
        });
      });
    };

    modal.onclick = (e) => {
      if (e.target === modal) modal.style.display = "none";
    };
    renderLightboxContent();
  }
  window.openPhotoLightboxModal = openPhotoLightboxModal;

  function _buildCameraTrajectoryHeaderHtml(camMeta) {
    const total = Number(camMeta?.total_cameras || STATE.activeScanCameras?.length || 0);
    const subScans = camMeta?.sub_scans || {};
    const subKeys = Object.keys(subScans);
    const showTraj = STATE.showCameraTrajectory3D !== false;
    const csvUrl = `/api/survey/cameras?scan_id=${encodeURIComponent(STATE.activeScanId || "")}&format=csv`;
    const legendHtml =
      subKeys.length > 1
        ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;">
             ${subKeys
               .map((k, idx) => {
                 const col = SUB_SCAN_TRAJ_PALETTE[idx % SUB_SCAN_TRAJ_PALETTE.length];
                 const matchCam = Array.isArray(camMeta?.cameras)
                   ? camMeta.cameras.find((c) => String(c.sub_scan || c.source_scan_id || "") === k)
                   : null;
                 const shortK = String(matchCam?.source_scan_name || k).replace(/^catch_/, "");
                 return `<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:1px 6px;border-radius:4px;background:var(--ui-bg-subtle);border:1px solid var(--ui-border);">
                           <span style="width:7px;height:7px;border-radius:50%;background:${col};"></span>
                           <span>${escapeHtml(shortK)} (${subScans[k]})</span>
                         </span>`;
               })
               .join("")}
           </div>`
        : "";
    return `
      <div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border);border-radius:8px;padding:8px 10px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
          <div style="font-size:11px;font-weight:700;color:var(--ui-text-primary);">
            🛰️ ${tr("Pix4Dmatic 率定相機軌跡", "Pix4Dmatic Calibrated Cameras")}
            <span style="font-family:var(--font-mono);color:var(--ui-accent);margin-left:4px;">${total.toLocaleString()}</span>
          </div>
          <div style="display:flex;align-items:center;gap:4px;">
            <button type="button" class="btn-xs ${showTraj ? "primary" : ""}" id="btnToggleCamTrajectory3D" title="${tr("顯示或隱藏 3D 相機拍攝軌跡與點位", "Show/Hide 3D Camera Trajectory & Markers")}">
              ${showTraj ? tr("👁 軌跡顯示中", "👁 Trajectory On") : tr("👁 顯示 3D 軌跡", "👁 Trajectory Off")}
            </button>
            <a class="btn-xs" href="${escapeHtml(csvUrl)}" download="${escapeHtml((STATE.activeScanId || "scan") + "_calibrated_cameras.csv")}" style="text-decoration:none;" title="${tr("匯出 Pix4Dmatic 率定相機座標 CSV (TWD97 + TWVD2001)", "Export Calibrated Camera Poses CSV")}">⬇ CSV</a>
          </div>
        </div>
        ${legendHtml}
      </div>
    `;
  }

  async function renderRtkPhotoInspectorPanel(pt = null, fromCanvasClick = false, pinnedCameraFilename = "") {
    if (window.innerWidth <= 768) {
      STATE.sidePanelMinimized = !fromCanvasClick;
    } else {
      STATE.sidePanelMinimized = false;
    }
    const camMetaPromise = loadAndRenderScanCameraTrajectory3D(STATE.activeScanId, false);
    if (!pt && !pinnedCameraFilename) {
      clearPhotoTargetVisuals3D(false);
      const cachedMeta =
        (STATE.scanCameraCatalogScanId === STATE.activeScanId && STATE.scanCameraCatalog) ||
        (STATE.scanCameraCatalogCache && STATE.scanCameraCatalogCache[STATE.activeScanId]) ||
        null;
      if (!cachedMeta) {
        showSidePanel(
          `<span>${tr("RTK 照片與 3D 視錐投影", "RTK Camera & 3D Frustum Inspector")}</span>`,
          `<div style="font-size:12px;color:var(--ui-text-secondary);padding:8px 0;">⏳ ${tr(
            "正在載入 Pix4Dmatic 率定相機軌跡與 3D 視錐...",
            "Loading calibrated Pix4Dmatic camera trajectory & 3D frustums..."
          )}</div>`
        );
      }
      const camMeta = await camMetaPromise;
      if (STATE.activeTool !== "photos" && STATE.activeTool !== "rtk") {
        clearPhotoTargetVisuals3D(true);
        return;
      }
      showSidePanel(
        `<span>${tr("RTK 照片與 3D 視錐投影", "RTK Camera & 3D Frustum Inspector")}</span>`,
        `
        ${_buildCameraTrajectoryHeaderHtml(camMeta)}
        <div style="font-size:11.5px;color:var(--ui-text-secondary);background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:8px;padding:10px 12px;line-height:1.5;">
          📷 ${tr(
            "請在 <b>3D 掃描模型上點擊任意位置</b>（或直接點擊 <b>3D 相機軌跡點</b>），系統將透過 Pix4Dmatic 率定內外方位參數檢索實際拍攝該處的照片、投射 3D 視錐，並在 2D 照片上標示目標準星。",
            "Click <b>any point on the 3D scan</b> (or click any <b>3D camera marker</b>) to retrieve the calibrated Pix4Dmatic photos observing that location, project 3D camera frustums, and mark the exact 2D target crosshair."
          )}
        </div>
        `
      );
      document.getElementById("btnToggleCamTrajectory3D")?.addEventListener("click", async () => {
        STATE.showCameraTrajectory3D = !STATE.showCameraTrajectory3D;
        await loadAndRenderScanCameraTrajectory3D(STATE.activeScanId, false);
        renderRtkPhotoInspectorPanel(null, false);
      });
      return;
    }
    showSidePanel(
      `<span>${tr("RTK 照片與 3D 視錐投影", "RTK Camera & 3D Frustum Inspector")}</span>`,
      `<div style="font-size:12px;color:var(--ui-text-secondary);">${tr("正在查詢 Pix4Dmatic 率定相機姿態與 3D 視錐...", "Querying calibrated Pix4Dmatic camera poses & 3D frustums...")}</div>`
    );
    try {
      const clickTwd =
        pt && pt._explicitTwd && (Math.abs(Number(pt._explicitTwd.e) || 0) > 100 || Math.abs(Number(pt._explicitTwd.n) || 0) > 100)
          ? {
              e: Number(pt._explicitTwd.e) || 0,
              n: Number(pt._explicitTwd.n) || 0,
              h: Number(pt._explicitTwd.h) || 0,
            }
          : pt
          ? localToTwd97(pt)
          : null;
      const reqPayload = {
        scan_id: STATE.activeScanId,
        x: pt ? pt.x : 0,
        y: pt ? pt.y : 0,
        z: pt ? pt.z : 0,
      };
      if (clickTwd) {
        reqPayload.twd_e = clickTwd.e;
        reqPayload.twd_n = clickTwd.n;
        reqPayload.twd_h = clickTwd.h;
      } else if (pinnedCameraFilename) {
        reqPayload.use_camera_ray_dsm = true;
      }
      if (pinnedCameraFilename) {
        reqPayload.camera_filename = pinnedCameraFilename;
      }
      const [res, camMeta] = await Promise.all([apiPost("/api/survey/inspect-photos", reqPayload), camMetaPromise]);
      if (STATE.activeTool !== "photos" && STATE.activeTool !== "rtk") {
        clearPhotoTargetVisuals3D(true);
        return;
      }
      const photos = Array.isArray(res.photos) ? res.photos : [];
      const targetTwd = res.target_twd97 || clickTwd || { e: 0, n: 0, h: 0 };
      const targetPt = pt ? pt.clone() : twd97ToStudioLocalVec(targetTwd.e, targetTwd.n, targetTwd.h, null, null);
      STATE.lastInspectedPhotos = photos;
      STATE.lastInspectedPhotoTargetPt = targetPt.clone();
      STATE.lastInspectedPhotoTargetTwd = targetTwd;
      placePhotoTargetMarker3D(targetPt);
      renderRtkPhotoFrustums3D(photos, targetTwd, targetPt, 0);

      const allComments = Array.isArray(STATE.activeScan?.comments) ? STATE.activeScan.comments : [];
      const existingComments = allComments.filter((c) =>
        typeof canUserEditComment === "function" ? canUserEditComment(c) : true
      );
      const targetCmt = STATE.targetAttachCommentId
        ? existingComments.find((c) => String(c.comment_id) === String(STATE.targetAttachCommentId))
        : null;
      if (STATE.targetAttachCommentId && !targetCmt) {
        STATE.targetAttachCommentId = null;
      }
      const targetCommentBannerHtml = targetCmt
        ? `<div style="background:rgba(2,132,199,0.14);border:1.5px solid var(--ui-accent);border-radius:8px;padding:8px 10px;margin-bottom:8px;">
             <div style="font-size:11.5px;font-weight:700;color:var(--ui-accent);margin-bottom:5px;line-height:1.35;">
               🎯 ${tr(`正在為標註「${escapeHtml(String(targetCmt.text || "").slice(0, 32))}」選擇位置照片`, `Selecting location photos for comment "${escapeHtml(String(targetCmt.text || "").slice(0, 32))}"`)}
             </div>
             <div style="display:flex;gap:5px;flex-wrap:wrap;">
               <button type="button" class="btn-xs primary" id="btnTargetCommentUploadLocalPhoto" style="gap:4px;">
                 📁 ${tr("從電腦上傳檔案", "Upload Local File")}
               </button>
               <button type="button" class="btn-xs" id="btnCancelTargetAttachComment">
                 ✕ ${tr("取消指定", "Clear Target")}
               </button>
             </div>
           </div>`
        : "";
      const commentDropTargetsHtml = `
        ${targetCommentBannerHtml}
        <div style="background:var(--ui-bg-pill);border:1px dashed var(--ui-border-strong);border-radius:8px;padding:8px 10px;margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;font-weight:700;color:var(--ui-text-primary);margin-bottom:5px;">
            <span>💬 ${tr("拖曳照片至標註以附加 (可多選)", "Drag & Drop Photo(s) onto a Comment")}</span>
            <span id="lblRtkSelectedPhotosCount" style="font-size:10.5px;color:var(--ui-accent);font-family:var(--font-mono);">${tr("可多選拖曳", "Multi-select drag")}</span>
          </div>
          <div style="font-size:10.5px;color:var(--ui-text-secondary);margin-bottom:6px;line-height:1.35;">
            ${tr(
              "可勾選多張照片，直接拖曳至 3D 畫面上的標註圖釘，或拖曳至下方標註卡片附加：",
              "Check 1 or more photos and drag them onto any 3D comment pin on the scan or onto a comment below:"
            )}
          </div>
          <div style="display:flex;flex-direction:column;gap:5px;max-height:125px;overflow-y:auto;">
            <div class="gs-comment-drop-target" data-drop-comment-id="__new__" style="padding:6px 8px;border:1px dashed var(--ui-accent);border-radius:6px;background:rgba(56,189,248,0.08);font-size:11px;font-weight:700;color:var(--ui-accent);cursor:copy;display:flex;align-items:center;justify-content:space-between;">
              <span>➕ ${tr("拖曳至此建立含照片的新標註", "Drop Here to Create New Comment with Photo(s)")}</span>
              <span style="font-size:10px;opacity:0.85;">Drop</span>
            </div>
            ${existingComments
              .map((c) => {
                const cid = escapeHtml(c.comment_id || "");
                const pCnt = Array.isArray(c.photos) ? c.photos.length : 0;
                const snippet = escapeHtml(String(c.text || "").slice(0, 34));
                const isTarget = targetCmt && String(targetCmt.comment_id) === String(c.comment_id);
                return `
                  <div class="gs-comment-drop-target" data-drop-comment-id="${cid}" style="padding:5px 8px;border:1px solid ${isTarget ? "var(--ui-accent)" : "var(--ui-border)"};border-radius:6px;background:${isTarget ? "rgba(2,132,199,0.12)" : "var(--ui-bg-subtle)"};font-size:11px;color:var(--ui-text-primary);display:flex;align-items:center;justify-content:space-between;gap:6px;">
                    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><b>${escapeHtml(c.author_name || "Reviewer")}:</b> ${snippet}</span>
                    <span style="font-size:10px;font-family:var(--font-mono);color:var(--ui-accent);flex-shrink:0;">📷 ${pCnt}</span>
                  </div>
                `;
              })
              .join("")}
          </div>
        </div>
      `;

      const photosHtml = photos
        .map((p, idx) => {
          const uv = _projectWorldPointToPhotoUV(p, targetTwd);
          return `
          <div class="gs-rtk-photo-card" draggable="true" data-rtk-photo-idx="${idx}" style="background:var(--ui-bg-subtle);border:1px solid ${idx === 0 ? "var(--ui-accent)" : "var(--ui-border)"};border-radius:8px;padding:8px;margin-top:8px;cursor:grab;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;font-size:11px;gap:4px;">
              <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-weight:700;color:var(--ui-text-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                <input type="checkbox" data-rtk-photo-check="${idx}" data-photo-select-cb="${idx}" />
                <span style="overflow:hidden;text-overflow:ellipsis;">${escapeHtml(p.filename)}</span>
              </label>
              <span style="color:var(--ui-accent);font-weight:700;font-size:10px;flex-shrink:0;">${p.calibrated ? "P4M" : "RTK"} σ=${escapeHtml(String(p.rtk_h_sigma_cm))}cm</span>
            </div>
            <div data-photo-enlarge-img="${idx}" title="${tr("點擊放大檢視照片與目標準星", "Click to enlarge photo with target reticle")}" style="width:100%;background:#090d16;border-radius:6px;display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:zoom-in;">
              <div style="position:relative;display:inline-flex;max-width:100%;max-height:240px;line-height:0;">
                <img src="${escapeHtml(p.url)}" alt="${escapeHtml(p.filename)}" style="max-width:100%;max-height:240px;width:auto;height:auto;display:block;object-fit:contain;" onerror="this.closest('[data-photo-enlarge-img]').style.display='none'" />
                <div class="gs-photo-target-reticle" style="position:absolute;left:${(uv.u * 100).toFixed(2)}%;top:${(uv.v * 100).toFixed(2)}%;transform:translate(-50%,-50%);pointer-events:none;">
                  <div style="width:20px;height:20px;border:2px solid #38bdf8;border-radius:50%;box-shadow:0 0 0 1.5px rgba(2,6,23,0.85),0 0 8px #38bdf8;position:relative;">
                    <span style="position:absolute;left:50%;top:50%;width:4px;height:4px;border-radius:50%;background:#f43f5e;transform:translate(-50%,-50%);"></span>
                  </div>
                </div>
              </div>
            </div>
            <div style="font-size:10px;font-family:monospace;color:var(--ui-text-muted);margin-top:5px;">
              E:${escapeHtml(String(p.camera_twd97_e))}m | N:${escapeHtml(String(p.camera_twd97_n))}m | H:+${escapeHtml(String(p.camera_twd97_h))}m | Dist:${escapeHtml(String(p.distance_m))}m
            </div>
            <div style="display:flex;gap:5px;margin-top:6px;">
              <button type="button" class="btn-xs primary" data-photo-enlarge-idx="${idx}" style="flex:1;justify-content:center;gap:4px;">
                <span>🔍 ${tr("放大檢視", "Enlarge")}</span>
              </button>
              <button type="button" class="btn-xs" data-photo-align-idx="${idx}" style="flex:1;justify-content:center;gap:4px;" title="${tr("將 3D 相機對齊至此照片拍攝位置與視角", "Align 3D camera to this photo viewpoint")}">
                <span>🎯 ${tr("對齊視角", "Align 3D")}</span>
              </button>
              <button type="button" class="btn-xs" data-photo-attach-comment-idx="${idx}" title="${tr("將此照片附加至新標註或選取標註", "Attach this photo to a new or existing comment")}">📎 ${tr("附加標註", "Attach Note")}</button>
              <a class="btn-xs" href="${escapeHtml(p.url)}" download="${escapeHtml(p.filename)}" style="padding:0 8px;justify-content:center;text-decoration:none;display:inline-flex;align-items:center;" title="${tr("下載原始 RTK 照片", "Download Original RTK Photo")}">⬇</a>
            </div>
          </div>
        `;
        })
        .join("");

      showSidePanel(
        `<span>${tr("RTK 照片檢視與標註附加", "RTK Photos & Comment Attachment")}</span>`,
        `
        ${_buildCameraTrajectoryHeaderHtml(camMeta)}
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px;">
          <div style="font-size:10.5px;font-family:monospace;color:var(--ui-text-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            Target: ${escapeHtml(formatScanCoordReadout({ e: Number(targetTwd.e || 0), n: Number(targetTwd.n || 0), h: Number(targetTwd.h || 0) }, STATE.activeScan))}
          </div>
          <div style="display:flex;gap:4px;flex-shrink:0;">
            <button type="button" class="btn-xs" id="btnRtkSelectAllPhotos" title="${tr("全選 / 取消全選照片", "Select / Deselect All Photos")}">${tr("全選", "Select All")}</button>
            <button type="button" class="btn-xs" id="btnClearPhotoFrustums" title="${tr("清除 3D 視錐", "Clear 3D Camera Frustums")}">${tr("清除視錐", "Clear")}</button>
          </div>
        </div>
        ${commentDropTargetsHtml}
        ${photosHtml || `<div style="font-size:12px;color:var(--ui-text-muted);">${tr("此點位附近無原始 RTK 照片。", "No local raw photos found for this point.")}</div>`}
        `
      );
      bindRtkPhotoInspectorActions(photos, targetTwd, targetPt);
    } catch (err) {
      showToast(`Photo Inspector Error: ${err.message}`);
    }
  }
  window.renderRtkPhotoInspectorPanel = renderRtkPhotoInspectorPanel;

  function _serializeRtkPhotoForComment(p, targetTwd = null) {
    if (!p || !p.url) return null;
    const uv = _projectWorldPointToPhotoUV(p, targetTwd || STATE.lastInspectedPhotoTargetTwd);
    const projU = Number.isFinite(Number(p.proj_u)) ? Number(p.proj_u) : Number(uv.u.toFixed(4));
    const projV = Number.isFinite(Number(p.proj_v)) ? Number(p.proj_v) : Number(uv.v.toFixed(4));
    const targetUv =
      p.target_uv && Number.isFinite(Number(p.target_uv.u)) && Number.isFinite(Number(p.target_uv.v))
        ? {
            u: Number(p.target_uv.u),
            v: Number(p.target_uv.v),
            in_fov: p.target_uv.in_fov !== false,
          }
        : {
            u: projU,
            v: projV,
            in_fov: uv.inFov !== false,
          };
    return {
      id: String(p.id || p.filename || ""),
      filename: String(p.filename || "RTK_Photo.jpg"),
      url: String(p.url || ""),
      camera_twd97_e: Number(p.camera_twd97_e || 0),
      camera_twd97_n: Number(p.camera_twd97_n || 0),
      camera_twd97_h: Number(p.camera_twd97_h || 0),
      rtk_h_sigma_cm: Number(p.rtk_h_sigma_cm || 1.2),
      proj_u: projU,
      proj_v: projV,
      target_uv: targetUv,
    };
  }

  async function attachPhotosToCommentById(commentId, photosToAttach) {
    const cid = String(commentId || "").trim();
    const cleanPhotos = (Array.isArray(photosToAttach) ? photosToAttach : [])
      .map((p) => _serializeRtkPhotoForComment(p, STATE.lastInspectedPhotoTargetTwd))
      .filter(Boolean);
    if (!cid || !cleanPhotos.length) return false;
    if (STATE.activeScan && Array.isArray(STATE.activeScan.comments)) {
      const targetCmt = STATE.activeScan.comments.find((c) => String(c.comment_id) === cid);
      if (targetCmt && typeof canUserEditComment === "function" && !canUserEditComment(targetCmt)) {
        showToast(tr("僅標註建立者或管理員可附加照片至此標註", "Only the comment author or an admin can attach photos to this comment."));
        return false;
      }
    }
    let resolvedAuthorName = STATE.currentUser?.name || "Engineer";
    try {
      const savedGuest = localStorage.getItem("gs_guest_comment_author") || "";
      if (STATE.shareToken || !STATE.currentUser?.email || STATE.currentUser.email.startsWith("guest@")) {
        resolvedAuthorName = savedGuest || resolvedAuthorName;
      }
    } catch (_) {}
    try {
      const res = await apiPost("/api/comments/update", {
        action: "attach_photos",
        comment_id: cid,
        scan_id: STATE.activeScanId,
        author_email: STATE.currentUser?.email || "",
        author_name: resolvedAuthorName,
        append_photos: cleanPhotos,
      });
      if (Array.isArray(res?.comments) && STATE.activeScan) {
        STATE.activeScan.comments = res.comments;
      }
      await refreshScansCatalog();
      if (typeof renderCommentPins3D === "function") {
        renderCommentPins3D();
      }
      showToast(
        tr(
          `已將 ${cleanPhotos.length} 張 RTK 照片附加至 3D 標註！`,
          `Attached ${cleanPhotos.length} RTK photo(s) to 3D comment!`
        )
      );
      return true;
    } catch (err) {
      showToast(`Attach Photo Error: ${err.message}`);
      return false;
    }
  }
  window.attachPhotosToCommentById = attachPhotosToCommentById;

  function getSelectedOrDraggedRtkPhotos(photos, fallbackIdx = 0, targetTwd = null) {
    const checkedIdxs = [];
    document.querySelectorAll("[data-rtk-photo-check]:checked, [data-photo-select-cb]:checked").forEach((chk) => {
      const rawIdx = chk.getAttribute("data-rtk-photo-check") ?? chk.getAttribute("data-photo-select-cb");
      const idx = Number(rawIdx);
      if (Number.isFinite(idx) && photos[idx] && !checkedIdxs.includes(idx)) checkedIdxs.push(idx);
    });
    const rawList =
      checkedIdxs.length > 0 && checkedIdxs.includes(fallbackIdx)
        ? checkedIdxs.map((i) => photos[i])
        : photos[fallbackIdx]
        ? [photos[fallbackIdx]]
        : [];
    return rawList.map((p) => _serializeRtkPhotoForComment(p, targetTwd) || p);
  }

  function bindRtkPhotoInspectorActions(photos, targetTwd, targetLocalPt) {
    document.getElementById("btnToggleCamTrajectory3D")?.addEventListener("click", async () => {
      STATE.showCameraTrajectory3D = !STATE.showCameraTrajectory3D;
      await loadAndRenderScanCameraTrajectory3D(STATE.activeScanId, false);
      renderRtkPhotoInspectorPanel(targetLocalPt, true);
    });
    document.getElementById("btnTargetCommentUploadLocalPhoto")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (STATE.targetAttachCommentId && typeof triggerCommentPhotoFilePicker === "function") {
        triggerCommentPhotoFilePicker(STATE.targetAttachCommentId, targetLocalPt, targetTwd);
      }
    });
    document.getElementById("btnCancelTargetAttachComment")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      STATE.targetAttachCommentId = null;
      renderRtkPhotoInspectorPanel(targetLocalPt, true);
    });

    document.querySelectorAll("[data-photo-enlarge-idx]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const idx = Number(btn.getAttribute("data-photo-enlarge-idx")) || 0;
        const p = photos[idx];
        if (p) {
          openPhotoLightboxModal(
            p.url,
            p.filename,
            `E:${p.camera_twd97_e}m | N:${p.camera_twd97_n}m | H:+${p.camera_twd97_h}m | RTK σ=${p.rtk_h_sigma_cm}cm`,
            photos,
            idx
          );
        }
      });
    });
    document.querySelectorAll("[data-photo-enlarge-img]").forEach((img) => {
      img.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const idx = Number(img.getAttribute("data-photo-enlarge-img")) || 0;
        const p = photos[idx];
        if (p) {
          openPhotoLightboxModal(
            p.url,
            p.filename,
            `E:${p.camera_twd97_e}m | N:${p.camera_twd97_n}m | H:+${p.camera_twd97_h}m | RTK σ=${p.rtk_h_sigma_cm}cm`,
            photos,
            idx
          );
        }
      });
    });
    document.querySelectorAll("[data-photo-align-idx]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const idx = Number(btn.getAttribute("data-photo-align-idx")) || 0;
        const p = photos[idx];
        if (p) {
          renderRtkPhotoFrustums3D(photos, targetTwd, targetLocalPt, idx);
          alignStudioCameraToRtkPhoto(p, 0);
        }
      });
    });
    document.querySelectorAll("[data-photo-attach-comment-idx]").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const idx = Number(btn.getAttribute("data-photo-attach-comment-idx")) || 0;
        const checkedIdxs = [];
        document.querySelectorAll("[data-rtk-photo-check]:checked, [data-photo-select-cb]:checked").forEach((chk) => {
          const rawIdx = chk.getAttribute("data-rtk-photo-check") ?? chk.getAttribute("data-photo-select-cb");
          const cIdx = Number(rawIdx);
          if (Number.isFinite(cIdx) && photos[cIdx] && !checkedIdxs.includes(cIdx)) checkedIdxs.push(cIdx);
        });
        if (!checkedIdxs.includes(idx) && photos[idx]) {
          checkedIdxs.push(idx);
        }
        const selectedPhotos = checkedIdxs
          .map((i) => _serializeRtkPhotoForComment(photos[i], targetTwd || STATE.lastInspectedPhotoTargetTwd))
          .filter(Boolean);
        if (!selectedPhotos.length) return;
        if (STATE.targetAttachCommentId) {
          const targetCmt = (Array.isArray(STATE.activeScan?.comments) ? STATE.activeScan.comments : []).find(
            (c) => String(c.comment_id) === String(STATE.targetAttachCommentId)
          );
          if (targetCmt && (typeof canUserEditComment !== "function" || canUserEditComment(targetCmt))) {
            const ok = await attachPhotosToCommentById(STATE.targetAttachCommentId, selectedPhotos);
            if (ok) {
              showToast(
                tr(
                  `✓ 已將 ${selectedPhotos.length} 張照片新增至標註「${String(targetCmt.text || "").slice(0, 24)}」`,
                  `✓ Added ${selectedPhotos.length} photo(s) to "${String(targetCmt.text || "").slice(0, 24)}"`
                )
              );
              renderRtkPhotoInspectorPanel(targetLocalPt || STATE.lastInspectedPhotoTargetPt, true);
            }
            return;
          }
        }
        STATE.pendingCommentDraftPhotos = selectedPhotos;
        if (typeof openCommentsInspector === "function") {
          openCommentsInspector(
            targetLocalPt || STATE.lastInspectedPhotoTargetPt,
            targetTwd || STATE.lastInspectedPhotoTargetTwd
          );
        }
        showToast(
          tr(
            `已選取 ${selectedPhotos.length} 張 RTK 照片準備附加至空間標註`,
            `Prepared ${selectedPhotos.length} RTK photo(s) to attach to comment`
          )
        );
      });
    });
    document.querySelectorAll(".gs-rtk-photo-card").forEach((card) => {
      card.addEventListener("mouseenter", () => {
        const idx = Number(card.getAttribute("data-rtk-photo-idx")) || 0;
        renderRtkPhotoFrustums3D(photos, targetTwd, targetLocalPt, idx);
      });
    });

    const updateSelectionCountLabel = () => {
      const cnt = document.querySelectorAll("[data-rtk-photo-check]:checked").length;
      const lbl = document.getElementById("lblRtkSelectedPhotosCount");
      if (lbl) {
        lbl.textContent = cnt > 0 ? tr(`已選取 ${cnt} 張`, `${cnt} selected`) : tr("可多選拖曳", "Multi-select drag");
      }
    };
    document.querySelectorAll("[data-rtk-photo-check]").forEach((chk) => {
      chk.addEventListener("change", updateSelectionCountLabel);
    });
    document.getElementById("btnRtkSelectAllPhotos")?.addEventListener("click", () => {
      const allChecks = Array.from(document.querySelectorAll("[data-rtk-photo-check]"));
      const allChecked = allChecks.length > 0 && allChecks.every((c) => c.checked);
      allChecks.forEach((c) => {
        c.checked = !allChecked;
      });
      updateSelectionCountLabel();
    });

    // HTML5 Drag start on each RTK photo card (supports dragging 1 or multiple checked photos onto any comment card or 3D comment pin)
    document.querySelectorAll(".gs-rtk-photo-card[draggable='true']").forEach((card) => {
      card.addEventListener("dragstart", (ev) => {
        const idx = Number(card.getAttribute("data-rtk-photo-idx")) || 0;
        const batch = getSelectedOrDraggedRtkPhotos(photos, idx, targetTwd);
        STATE.draggingRtkPhotos = batch;
        card.classList.add("dragging");
        try {
          ev.dataTransfer.effectAllowed = "copy";
          ev.dataTransfer.setData("application/x-gs-rtk-photos", JSON.stringify(batch));
          ev.dataTransfer.setData("text/plain", JSON.stringify(batch));
        } catch (_) {}
      });
      card.addEventListener("dragend", () => {
        card.classList.remove("dragging");
      });
    });

    // Drop targets inside the RTK Photo Inspector (existing comments + "New Comment with Photo(s)" drop zone)
    document.querySelectorAll(".gs-comment-drop-target").forEach((dropEl) => {
      dropEl.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "copy";
        dropEl.classList.add("drag-over");
      });
      dropEl.addEventListener("dragleave", () => {
        dropEl.classList.remove("drag-over");
      });
      dropEl.addEventListener("drop", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        dropEl.classList.remove("drag-over");
        let dropped = STATE.draggingRtkPhotos || [];
        try {
          const raw =
            ev.dataTransfer.getData("application/x-gs-rtk-photos") || ev.dataTransfer.getData("text/plain");
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length) dropped = parsed;
          }
        } catch (_) {}
        if (!dropped.length) return;
        const cid = dropEl.getAttribute("data-drop-comment-id");
        if (cid === "__new__") {
          STATE.pendingCommentDraftPhotos = dropped.slice();
          if (typeof openCommentsInspector === "function") {
            openCommentsInspector(targetLocalPt || STATE.lastInspectedPhotoTargetPt, targetTwd);
          }
        } else if (cid) {
          const ok = await attachPhotosToCommentById(cid, dropped);
          if (ok && typeof openRtkPhotoInspector === "function" && (targetLocalPt || STATE.lastInspectedPhotoTargetPt)) {
            openRtkPhotoInspector(targetLocalPt || STATE.lastInspectedPhotoTargetPt);
          }
        }
      });
    });

    document.getElementById("btnClearPhotoFrustums")?.addEventListener("click", () => {
      clearRtkPhotoFrustums3D();
      STATE.photoOverlayOpacity = 0;
      showToast(tr("已清除 3D 相機視錐", "Cleared 3D camera frustums"));
    });
  }

  // ============================================================================
  // FEATURE 7: 3D COMMENTS FOLDER ORGANIZATION, VISIBILITY & DRAG-AND-DROP
  // ============================================================================
  function getOrderedScanCommentFolders(scan, comments) {
    const seen = new Set();
    const named = [];
    const scanFolders = Array.isArray(scan?.comment_folders) ? scan.comment_folders : [];
    scanFolders.forEach((f) => {
      const fn = String(f || "").trim();
      if (fn && !seen.has(fn)) {
        seen.add(fn);
        named.push(fn);
      }
    });
    (Array.isArray(comments) ? comments : []).forEach((c) => {
      const fn = String(c?.folder || "").trim();
      if (fn && !seen.has(fn)) {
        seen.add(fn);
        named.push(fn);
      }
    });
    return [...named, ""];
  }
  window.getOrderedScanCommentFolders = getOrderedScanCommentFolders;

  function buildCommentFolderComposerBarHtml(scan, comments, canModifyComments) {
    const folders = getOrderedScanCommentFolders(scan, comments);
    const activeDefaultFolder = String(STATE.selectedNewCommentFolder || "").trim();
    const optionsHtml = folders
      .map((fName) => {
        const label = fName ? `📁 ${escapeHtml(fName)}` : `📂 ${tr("未分類 (Unclassified)", "Unclassified")}`;
        const sel = fName === activeDefaultFolder ? "selected" : "";
        return `<option value="${escapeHtml(fName)}" ${sel}>${label}</option>`;
      })
      .join("");
    return `
      <div style="display:flex;align-items:center;gap:5px;margin-bottom:6px;">
        <select id="selNewCommentFolder" class="gs-input" style="flex:1;height:28px;padding:2px 8px;font-size:11.5px;" title="${tr("選擇標註資料夾", "Select Note Folder")}" aria-label="${tr("選擇標註資料夾", "Select Note Folder")}">
          ${optionsHtml}
        </select>
        ${
          canModifyComments
            ? `<button type="button" class="btn-xs gs-comment-folder-icon-btn" id="btnCreateCommentFolder" title="${tr("新增標註資料夾", "Create New Note Folder")}" aria-label="${tr("新增標註資料夾", "Create New Note Folder")}" style="height:28px;padding:0 8px;font-weight:700;color:var(--ui-accent);border-color:var(--ui-accent);">+📁</button>`
            : ""
        }
      </div>
    `;
  }
  window.buildCommentFolderComposerBarHtml = buildCommentFolderComposerBarHtml;

  function buildCommentFoldersListHtml(scan, comments, canModifyComments) {
    if (!STATE.collapsedCommentFolders) STATE.collapsedCommentFolders = {};
    if (!STATE.hiddenCommentFolders) STATE.hiddenCommentFolders = {};
    const scanId = STATE.activeScanId || scan?.scan_id || "";
    const folders = getOrderedScanCommentFolders(scan, comments);
    const allComments = Array.isArray(comments) ? comments : [];

    const renderSingleCardHtml = (c) => {
      const cid = escapeHtml(c.comment_id || "");
      const folderStr = escapeHtml(String(c.folder || "").trim());
      const timeStr = escapeHtml((c.created_at || "").slice(0, 16));
      const avatar =
        typeof getCommentAuthorAvatar === "function"
          ? getCommentAuthorAvatar(c.author_name || "Reviewer", c.author_email || "")
          : { chars: "RV", bg: "#0284c7" };
      const canEditThis = typeof canUserEditComment === "function" ? canUserEditComment(c) : canModifyComments;
      const attachedPhotos = Array.isArray(c.photos) ? c.photos.filter((p) => p && p.url) : [];
      const photosGridHtml = attachedPhotos.length
        ? `<div class="gs-comment-photos-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(74px,1fr));gap:6px;margin-top:7px;">
            ${attachedPhotos
              .map((p, pIdx) => {
                const purl = escapeHtml(p.url || "");
                const pfn = escapeHtml(p.filename || `Photo_${pIdx + 1}.jpg`);
                return `
                  <div class="gs-comment-photo-thumb" draggable="${canEditThis ? "true" : "false"}" data-comment-photo-drag-cid="${cid}" data-comment-photo-drag-idx="${pIdx}" style="position:relative;border-radius:6px;overflow:hidden;border:1px solid var(--ui-border);background:var(--ui-bg-pill);cursor:${canEditThis ? "grab" : "pointer"};">
                    <img src="${purl}" alt="${pfn}" draggable="false" data-comment-photo-enlarge="${cid}" data-comment-photo-idx="${pIdx}" title="${tr("點擊放大檢視（可拖曳照片至其他標註或資料夾）", "Click to enlarge (or drag photo to another note/folder)")}: ${pfn}" style="width:100%;height:58px;object-fit:cover;display:block;cursor:zoom-in;" onerror="this.style.display='none'" />
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:2px 4px;font-size:9.5px;background:rgba(15,23,42,0.78);color:#e2e8f0;">
                      <a href="${purl}" download="${pfn}" title="${tr("下載照片", "Download")}" aria-label="${tr("下載照片", "Download")}" style="color:#38bdf8;text-decoration:none;font-weight:700;">⬇</a>
                      ${
                        canEditThis && cid
                          ? `<button type="button" data-comment-remove-photo-cid="${cid}" data-comment-remove-photo-url="${purl}" title="${tr("移除附加照片", "Remove attached photo")}" aria-label="${tr("移除附加照片", "Remove attached photo")}" style="background:none;border:none;color:#f87171;cursor:pointer;font-size:10px;padding:0;line-height:1;">✕</button>`
                          : ""
                      }
                    </div>
                  </div>
                `;
              })
              .join("")}
          </div>`
        : `<div class="gs-comment-photos-grid" style="display:none;grid-template-columns:repeat(auto-fill,minmax(74px,1fr));gap:6px;margin-top:7px;"></div>`;
      return `
        <div class="gs-comment-card" draggable="${canEditThis ? "true" : "false"}" data-comment-id="${cid}" data-comment-folder="${folderStr}" data-comment-editable="${canEditThis ? "1" : "0"}" title="${canEditThis ? tr("可拖曳此標註至其他資料夾，或將照片拖曳至此標註附加", "Drag note to a folder, or drop photos here to attach") : ""}" style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border);border-radius:8px;padding:8px 9px;margin-top:6px;transition:border-color 0.15s,background 0.15s;cursor:${canEditThis ? "grab" : "default"};">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;font-size:11px;color:var(--ui-accent);font-weight:700;">
            <span style="display:inline-flex;align-items:center;gap:6px;min-width:0;">
              <span class="gs-comment-card-avatar" style="background:${avatar.bg};">${escapeHtml(avatar.chars)}</span>
              <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(c.author_name || "Reviewer")}</span>
            </span>
            <div style="display:flex;align-items:center;gap:3px;flex-shrink:0;">
              <span style="color:var(--ui-text-muted);font-weight:500;font-size:10px;margin-right:2px;">${timeStr}</span>
              ${
                canEditThis && cid
                  ? `<button type="button" class="btn-xs gs-comment-folder-icon-btn" data-comment-find-photos="${cid}" title="${tr("檢視此標註位置的 RTK 實景照片並選擇附加", "Find & attach RTK photos at this comment's location")}" aria-label="${tr("選擇位置照片", "Find Location Photos")}" style="color:var(--ui-accent);border-color:var(--ui-accent);">📷+</button>
                     <button type="button" class="btn-xs gs-comment-folder-icon-btn" data-comment-upload-photo="${cid}" title="${tr("從電腦或手機上傳照片至 Google Drive 並附加", "Upload local photo to Google Drive & attach")}" aria-label="${tr("上傳檔案", "Upload File")}">📁</button>
                     <button type="button" class="btn-xs gs-comment-folder-icon-btn btn-move-comment ${STATE.movingCommentId === cid ? "active" : ""}" data-cid="${cid}" data-comment-move="${cid}" title="${tr("移動標記位置 (點擊 3D 模型新位置)", "Move Note Pin in 3D")}" aria-label="${tr("移動標記位置", "Move Note Pin")}" style="${STATE.movingCommentId === cid ? "background:#f59e0b;color:#111;border-color:#f59e0b;font-weight:700;" : ""}">${STATE.movingCommentId === cid ? tr("🎯 點擊 3D...", "🎯 Click 3D...") : "📍"}</button>
                     <button type="button" class="btn-xs gs-comment-folder-icon-btn" data-comment-edit="${cid}" title="${tr("編輯標註", "Edit Comment")}" aria-label="${tr("編輯標註", "Edit Comment")}">
                       <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                     </button>
                     <button type="button" class="btn-xs gs-comment-folder-icon-btn danger" data-comment-delete="${cid}" title="${tr("刪除標註", "Delete Comment")}" aria-label="${tr("刪除標註", "Delete Comment")}">
                       <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                     </button>`
                  : ""
              }
            </div>
          </div>
          <div class="gs-comment-body-text" data-comment-text="${cid}" style="font-size:12px;color:var(--ui-text-primary);margin-top:4px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(c.text)}</div>
          ${photosGridHtml}
          <div class="gs-comment-edit-wrap" data-comment-edit-box="${cid}" style="display:none;margin-top:6px;">
            <textarea class="gs-input" data-comment-edit-input="${cid}" rows="2" style="font-size:12px;margin-bottom:5px;">${escapeHtml(c.text)}</textarea>
            <div style="display:flex;gap:5px;justify-content:flex-end;">
              <button type="button" class="btn-xs" data-comment-edit-cancel="${cid}">${tr("取消", "Cancel")}</button>
              <button type="button" class="btn-xs accent" data-comment-edit-save="${cid}" style="background:var(--ui-accent);color:#fff;border-color:var(--ui-accent);">${tr("儲存", "Save")}</button>
            </div>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;font-size:10px;font-family:monospace;color:var(--ui-text-muted);margin-top:4px;">
            <span>E:${Number(c.twd97_e).toFixed(1)}m, N:${Number(c.twd97_n).toFixed(1)}m, H:+${Number(c.twd97_h).toFixed(2)}m</span>
            ${attachedPhotos.length ? `<span style="color:var(--ui-accent);">📷 ${attachedPhotos.length}</span>` : ""}
          </div>
        </div>
      `;
    };

    return folders
      .map((fName) => {
        const folderComments = allComments.filter((c) => String(c?.folder || "").trim() === fName);
        const folderKey = `${scanId}::${fName}`;
        const isCollapsed = Boolean(STATE.collapsedCommentFolders[folderKey]);
        if (STATE.hiddenCommentFolders[folderKey] === undefined) {
          STATE.hiddenCommentFolders[folderKey] = false; // Visible by default
        }
        const isHidden3D = Boolean(STATE.hiddenCommentFolders[folderKey]);
        const fEsc = escapeHtml(fName);
        const fTitle = fName ? escapeHtml(fName) : tr("未分類 (Unclassified)", "Unclassified");
        const eyeSvg = isHidden3D
          ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
          : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;

        return `
          <div class="gs-comment-folder-section" data-comment-folder-drop="${fEsc}">
            <div class="gs-comment-folder-header" data-comment-folder-header="${fEsc}">
              <div style="display:flex;align-items:center;gap:5px;min-width:0;flex:1;">
                <button type="button" class="btn-xs gs-comment-folder-icon-btn" data-folder-collapse="${fEsc}" title="${isCollapsed ? tr("展開資料夾", "Expand Folder") : tr("收合資料夾", "Collapse Folder")}" aria-label="${isCollapsed ? tr("展開資料夾", "Expand Folder") : tr("收合資料夾", "Collapse Folder")}">
                  ${isCollapsed ? "▸" : "▾"}
                </button>
                <span style="font-size:11.5px;font-weight:700;color:var(--ui-text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${fName ? "📁" : "📂"} ${fTitle}
                </span>
                <span style="font-size:10.5px;font-family:var(--font-mono);color:var(--ui-accent);flex-shrink:0;">(${folderComments.length})</span>
              </div>
              <div style="display:flex;align-items:center;gap:3px;flex-shrink:0;">
                <button type="button" class="btn-xs gs-comment-folder-icon-btn ${isHidden3D ? "is-hidden-3d" : "is-visible-3d"}" data-folder-toggle-vis="${fEsc}" title="${isHidden3D ? tr("顯示此資料夾的 3D 標註圖釘", "Show 3D Note Pins in this Folder") : tr("隱藏此資料夾的 3D 標註圖釘", "Hide 3D Note Pins in this Folder")}" aria-label="${isHidden3D ? tr("顯示此資料夾的 3D 標註圖釘", "Show 3D Note Pins in this Folder") : tr("隱藏此資料夾的 3D 標註圖釘", "Hide 3D Note Pins in this Folder")}">
                  ${eyeSvg}
                </button>
                ${
                  fName && canModifyComments
                    ? `<button type="button" class="btn-xs gs-comment-folder-icon-btn" data-folder-rename="${fEsc}" title="${tr("重新命名資料夾", "Rename Folder")}" aria-label="${tr("重新命名資料夾", "Rename Folder")}">
                         <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                       </button>
                       <button type="button" class="btn-xs gs-comment-folder-icon-btn danger" data-folder-delete="${fEsc}" title="${tr("刪除資料夾（標註移至未分類）", "Delete Folder (Move notes to Unclassified)")}" aria-label="${tr("刪除資料夾", "Delete Folder")}">
                         <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                       </button>`
                    : ""
                }
              </div>
            </div>
            <div class="gs-comment-folder-body" style="display:${isCollapsed ? "none" : "block"};">
              ${
                folderComments.length
                  ? folderComments.map(renderSingleCardHtml).join("")
                  : `<div style="font-size:10.5px;color:var(--ui-text-muted);padding:6px 8px;text-align:center;border:1px dashed var(--ui-border);border-radius:6px;margin-top:5px;">${tr("可將標註或照片拖曳至此資料夾", "Drop notes or photos into this folder")}</div>`
              }
            </div>
          </div>
        `;
      })
      .join("");
  }
  window.buildCommentFoldersListHtml = buildCommentFoldersListHtml;

  function bindCommentFoldersAndCardsEvents(scan, comments, pt, twd) {
    const scanId = STATE.activeScanId || scan?.scan_id || "";
    const listBox = document.getElementById("commentsListBox");
    const selFolder = document.getElementById("selNewCommentFolder");
    if (selFolder) {
      selFolder.addEventListener("change", () => {
        STATE.selectedNewCommentFolder = selFolder.value || "";
      });
    }

    document.getElementById("btnCreateCommentFolder")?.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const rawName = window.prompt(tr("請輸入新標註資料夾名稱：", "Enter new note folder name:"), "");
      const folderName = String(rawName || "").trim();
      if (!folderName) return;
      try {
        const res = await apiPost("/api/comments", {
          action: "create_folder",
          scan_id: scanId,
          folder_name: folderName,
        });
        if (STATE.activeScan) {
          if (Array.isArray(res?.comment_folders)) STATE.activeScan.comment_folders = res.comment_folders;
          if (Array.isArray(res?.comments)) STATE.activeScan.comments = res.comments;
        }
        STATE.selectedNewCommentFolder = folderName;
        await refreshScansCatalog();
        if (typeof openCommentsInspector === "function") openCommentsInspector(pt, twd);
      } catch (err) {
        showToast(`Create Folder Error: ${err.message}`, "error");
      }
    });

    if (!listBox) return;

    // 1. Collapse / Expand folder
    listBox.querySelectorAll("[data-folder-collapse]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const fName = btn.getAttribute("data-folder-collapse") || "";
        const folderKey = `${scanId}::${fName}`;
        STATE.collapsedCommentFolders[folderKey] = !STATE.collapsedCommentFolders[folderKey];
        const sec = btn.closest(".gs-comment-folder-section");
        const body = sec?.querySelector(".gs-comment-folder-body");
        if (body) {
          body.style.display = STATE.collapsedCommentFolders[folderKey] ? "none" : "block";
        }
        const isCol = Boolean(STATE.collapsedCommentFolders[folderKey]);
        btn.textContent = isCol ? "▸" : "▾";
        btn.title = isCol ? tr("展開資料夾", "Expand folder") : tr("收合資料夾", "Collapse folder");
        btn.setAttribute("aria-label", btn.title);
      });
    });

    // 2. Folder 3D visibility toggle (visible by default)
    listBox.querySelectorAll("[data-folder-toggle-vis]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const fName = btn.getAttribute("data-folder-toggle-vis") || "";
        const folderKey = `${scanId}::${fName}`;
        STATE.hiddenCommentFolders[folderKey] = !STATE.hiddenCommentFolders[folderKey];
        const isHidden = Boolean(STATE.hiddenCommentFolders[folderKey]);
        btn.classList.toggle("is-hidden-3d", isHidden);
        btn.classList.toggle("is-visible-3d", !isHidden);
        btn.title = isHidden ? tr("在 3D 顯示此資料夾標註", "Show folder notes in 3D") : tr("在 3D 隱藏此資料夾標註", "Hide folder notes in 3D");
        btn.setAttribute("aria-label", btn.title);
        btn.innerHTML = isHidden
          ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
          : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
        if (typeof renderCommentPins3D === "function") {
          renderCommentPins3D();
        }
      });
    });

    // 3. Rename folder
    listBox.querySelectorAll("[data-folder-rename]").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const oldName = btn.getAttribute("data-folder-rename") || "";
        if (!oldName) return;
        const rawNew = window.prompt(tr("重新命名標註資料夾：", "Rename note folder:"), oldName);
        const newName = String(rawNew || "").trim();
        if (!newName || newName === oldName) return;
        try {
          const res = await apiPost("/api/comments/update", {
            action: "rename_folder",
            scan_id: scanId,
            old_name: oldName,
            new_name: newName,
            author_email: STATE.currentUser?.email || "",
            author_name: typeof getCurrentCommentActorName === "function" ? getCurrentCommentActorName() : "Engineer",
          });
          const oldKey = `${scanId}::${oldName}`;
          const newKey = `${scanId}::${newName}`;
          if (STATE.collapsedCommentFolders && oldKey in STATE.collapsedCommentFolders) {
            STATE.collapsedCommentFolders[newKey] = STATE.collapsedCommentFolders[oldKey];
            delete STATE.collapsedCommentFolders[oldKey];
          }
          if (STATE.hiddenCommentFolders && oldKey in STATE.hiddenCommentFolders) {
            STATE.hiddenCommentFolders[newKey] = STATE.hiddenCommentFolders[oldKey];
            delete STATE.hiddenCommentFolders[oldKey];
          }
          if (STATE.activeScan) {
            if (Array.isArray(res?.comment_folders)) STATE.activeScan.comment_folders = res.comment_folders;
            if (Array.isArray(res?.comments)) STATE.activeScan.comments = res.comments;
          }
          await refreshScansCatalog();
          if (typeof renderCommentPins3D === "function") renderCommentPins3D();
          if (typeof openCommentsInspector === "function") openCommentsInspector(pt, twd);
        } catch (err) {
          showToast(`Rename Folder Error: ${err.message}`, "error");
        }
      });
    });

    // 4. Delete folder
    listBox.querySelectorAll("[data-folder-delete]").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const fName = btn.getAttribute("data-folder-delete") || "";
        if (!fName) return;
        try {
          const res = await apiPost("/api/comments/delete", {
            action: "delete_folder",
            scan_id: scanId,
            folder_name: fName,
            author_email: STATE.currentUser?.email || "",
            author_name: typeof getCurrentCommentActorName === "function" ? getCurrentCommentActorName() : "Engineer",
          });
          if (STATE.activeScan) {
            if (Array.isArray(res?.comment_folders)) STATE.activeScan.comment_folders = res.comment_folders;
            if (Array.isArray(res?.comments)) STATE.activeScan.comments = res.comments;
          }
          await refreshScansCatalog();
          if (typeof renderCommentPins3D === "function") renderCommentPins3D();
          if (typeof openCommentsInspector === "function") openCommentsInspector(pt, twd);
        } catch (err) {
          showToast(`Delete Folder Error: ${err.message}`, "error");
        }
      });
    });

    // 5. Drag start on individual comment photo thumbnails (application/x-gs-comment-photo)
    listBox.querySelectorAll(".gs-comment-photo-thumb[draggable='true']").forEach((thumbEl) => {
      thumbEl.addEventListener("dragstart", (ev) => {
        ev.stopPropagation();
        const cid = thumbEl.getAttribute("data-comment-photo-drag-cid") || "";
        const pIdx = Number(thumbEl.getAttribute("data-comment-photo-drag-idx")) || 0;
        const srcCmt = (Array.isArray(comments) ? comments : []).find((item) => String(item.comment_id) === String(cid));
        const photoObj = Array.isArray(srcCmt?.photos) ? srcCmt.photos[pIdx] : null;
        if (!cid || !photoObj) return;
        const payload = { source_comment_id: cid, photo: photoObj };
        STATE.draggingCommentPhoto = payload;
        thumbEl.classList.add("dragging");
        try {
          ev.dataTransfer.effectAllowed = "move";
          ev.dataTransfer.setData("application/x-gs-comment-photo", JSON.stringify(payload));
        } catch (_) {}
      });
      thumbEl.addEventListener("dragend", () => {
        thumbEl.classList.remove("dragging");
        STATE.draggingCommentPhoto = null;
      });
    });

    // 6. Drag start on comment cards (application/x-gs-comment-card)
    listBox.querySelectorAll(".gs-comment-card[data-comment-id][draggable='true']").forEach((cardEl) => {
      cardEl.addEventListener("dragstart", (ev) => {
        if (ev.target && ev.target.closest && ev.target.closest(".gs-comment-photo-thumb")) return;
        const cid = cardEl.getAttribute("data-comment-id") || "";
        const srcFolder = cardEl.getAttribute("data-comment-folder") || "";
        if (!cid) return;
        const payload = { comment_id: cid, source_folder: srcFolder };
        STATE.draggingCommentCard = payload;
        cardEl.classList.add("dragging");
        try {
          ev.dataTransfer.effectAllowed = "move";
          ev.dataTransfer.setData("application/x-gs-comment-card", JSON.stringify(payload));
        } catch (_) {}
      });
      cardEl.addEventListener("dragend", () => {
        cardEl.classList.remove("dragging");
        STATE.draggingCommentCard = null;
      });
    });

    // 7. Drop onto comment cards (move photo between notes, or upload/attach RTK photos)
    listBox.querySelectorAll('.gs-comment-card[data-comment-id][data-comment-editable="1"]').forEach((cardEl) => {
      cardEl.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        cardEl.classList.add("drag-over");
      });
      cardEl.addEventListener("dragleave", () => {
        cardEl.classList.remove("drag-over");
      });
      cardEl.addEventListener("drop", async (ev) => {
        const targetCid = cardEl.getAttribute("data-comment-id") || "";
        let movedPhotoPayload = STATE.draggingCommentPhoto || null;
        try {
          const rawPhoto = ev.dataTransfer?.getData("application/x-gs-comment-photo");
          if (rawPhoto) movedPhotoPayload = JSON.parse(rawPhoto);
        } catch (_) {}
        if (movedPhotoPayload && movedPhotoPayload.source_comment_id && movedPhotoPayload.photo) {
          ev.preventDefault();
          ev.stopPropagation();
          cardEl.classList.remove("drag-over");
          STATE.draggingCommentPhoto = null;
          if (String(movedPhotoPayload.source_comment_id) === String(targetCid)) return;
          try {
            const res = await apiPost("/api/comments/update", {
              action: "move_photo",
              scan_id: scanId,
              source_comment_id: movedPhotoPayload.source_comment_id,
              target_comment_id: targetCid,
              photo: movedPhotoPayload.photo,
              author_email: STATE.currentUser?.email || "",
              author_name: typeof getCurrentCommentActorName === "function" ? getCurrentCommentActorName() : "Engineer",
            });
            if (Array.isArray(res?.comments) && STATE.activeScan) {
              STATE.activeScan.comments = res.comments;
            }
            await refreshScansCatalog();
            if (typeof renderCommentPins3D === "function") renderCommentPins3D();
            if (typeof openCommentsInspector === "function") openCommentsInspector(pt, twd);
            showToast(tr("✓ 已移動照片至目標標註", "✓ Moved photo to target note"));
          } catch (err) {
            showToast(`Move Photo Error: ${err.message}`, "error");
          }
          return;
        }

        // If dragging a whole comment card, let the parent folder section handle the drop!
        let cardPayload = STATE.draggingCommentCard || null;
        try {
          const rawCard = ev.dataTransfer?.getData("application/x-gs-comment-card");
          if (rawCard) cardPayload = JSON.parse(rawCard);
        } catch (_) {}
        if (cardPayload && cardPayload.comment_id) {
          cardEl.classList.remove("drag-over");
          return;
        }

        ev.preventDefault();
        ev.stopPropagation();
        cardEl.classList.remove("drag-over");
        if (targetCid && ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length > 0) {
          if (typeof uploadLocalFilesToComment === "function") {
            await uploadLocalFilesToComment(ev.dataTransfer.files, targetCid, pt, twd);
          }
          return;
        }
        let dropped = STATE.draggingRtkPhotos || [];
        try {
          const raw = ev.dataTransfer.getData("application/x-gs-rtk-photos") || ev.dataTransfer.getData("text/plain");
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length) dropped = parsed;
          }
        } catch (_) {}
        if (targetCid && dropped.length && typeof attachPhotosToCommentById === "function") {
          const ok = await attachPhotosToCommentById(targetCid, dropped);
          if (ok && typeof openCommentsInspector === "function") openCommentsInspector(pt, twd);
        }
      });
    });

    // 8. Drop onto folder sections ([data-comment-folder-drop])
    listBox.querySelectorAll("[data-comment-folder-drop]").forEach((folderEl) => {
      folderEl.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        folderEl.classList.add("drag-over");
      });
      folderEl.addEventListener("dragleave", (ev) => {
        if (!folderEl.contains(ev.relatedTarget)) {
          folderEl.classList.remove("drag-over");
        }
      });
      folderEl.addEventListener("drop", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        folderEl.classList.remove("drag-over");
        const targetFolder = folderEl.getAttribute("data-comment-folder-drop") || "";
        const actorName = typeof getCurrentCommentActorName === "function" ? getCurrentCommentActorName() : "Engineer";
        const actorEmail = STATE.currentUser?.email || "engineer@gatheren.cloud";

        // Case A: Dropped a comment card onto this folder
        let cardPayload = STATE.draggingCommentCard || null;
        try {
          const rawCard = ev.dataTransfer?.getData("application/x-gs-comment-card");
          if (rawCard) cardPayload = JSON.parse(rawCard);
        } catch (_) {}
        if (cardPayload && cardPayload.comment_id) {
          STATE.draggingCommentCard = null;
          if (String(cardPayload.source_folder || "") === String(targetFolder)) return;
          try {
            const res = await apiPost("/api/comments/update", {
              action: "update",
              scan_id: scanId,
              comment_id: cardPayload.comment_id,
              folder: targetFolder,
              author_email: actorEmail,
              author_name: actorName,
            });
            if (Array.isArray(res?.comments) && STATE.activeScan) {
              STATE.activeScan.comments = res.comments;
            }
            await refreshScansCatalog();
            if (typeof renderCommentPins3D === "function") renderCommentPins3D();
            if (typeof openCommentsInspector === "function") openCommentsInspector(pt, twd);
            showToast(
              tr(
                `✓ 已將標註移至資料夾「${targetFolder || "未分類"}」`,
                `✓ Moved note to folder "${targetFolder || "Unclassified"}"`
              )
            );
          } catch (err) {
            showToast(`Move Note Error: ${err.message}`, "error");
          }
          return;
        }

        // Case B: Dropped a comment photo onto this folder
        let movedPhotoPayload = STATE.draggingCommentPhoto || null;
        try {
          const rawPhoto = ev.dataTransfer?.getData("application/x-gs-comment-photo");
          if (rawPhoto) movedPhotoPayload = JSON.parse(rawPhoto);
        } catch (_) {}
        if (movedPhotoPayload && movedPhotoPayload.source_comment_id && movedPhotoPayload.photo) {
          STATE.draggingCommentPhoto = null;
          const folderNotes = (Array.isArray(comments) ? comments : []).filter(
            (c) => String(c?.folder || "").trim() === targetFolder && String(c.comment_id) !== String(movedPhotoPayload.source_comment_id)
          );
          try {
            if (folderNotes.length > 0) {
              const res = await apiPost("/api/comments/update", {
                action: "move_photo",
                scan_id: scanId,
                source_comment_id: movedPhotoPayload.source_comment_id,
                target_comment_id: folderNotes[0].comment_id,
                photo: movedPhotoPayload.photo,
                author_email: actorEmail,
                author_name: actorName,
              });
              if (Array.isArray(res?.comments) && STATE.activeScan) STATE.activeScan.comments = res.comments;
            } else {
              const created = await apiPost("/api/comments", {
                scan_id: scanId,
                author_email: actorEmail,
                author_name: actorName,
                text: tr("（從其他標註移入照片）", "(Moved Photo)"),
                folder: targetFolder,
                pos_x: pt.x,
                pos_y: pt.y,
                pos_z: pt.z,
                twd97_e: twd.e,
                twd97_n: twd.n,
                twd97_h: twd.h,
                photos: [movedPhotoPayload.photo],
              });
              const srcCmt = (Array.isArray(comments) ? comments : []).find(
                (c) => String(c.comment_id) === String(movedPhotoPayload.source_comment_id)
              );
              if (srcCmt) {
                const rem = (Array.isArray(srcCmt.photos) ? srcCmt.photos : []).filter(
                  (p) => String(p.url) !== String(movedPhotoPayload.photo.url)
                );
                const upd = await apiPost("/api/comments/update", {
                  action: "update",
                  scan_id: scanId,
                  comment_id: srcCmt.comment_id,
                  photos: rem,
                  author_email: actorEmail,
                  author_name: actorName,
                });
                if (Array.isArray(upd?.comments) && STATE.activeScan) STATE.activeScan.comments = upd.comments;
              } else if (Array.isArray(created?.comments) && STATE.activeScan) {
                STATE.activeScan.comments = created.comments;
              }
            }
            await refreshScansCatalog();
            if (typeof renderCommentPins3D === "function") renderCommentPins3D();
            if (typeof openCommentsInspector === "function") openCommentsInspector(pt, twd);
            showToast(tr("✓ 已移動照片至資料夾", "✓ Moved photo to folder"));
          } catch (err) {
            showToast(`Move Photo to Folder Error: ${err.message}`, "error");
          }
          return;
        }

        // Case C: Dropped RTK photo(s) onto this folder
        let droppedRtk = STATE.draggingRtkPhotos || [];
        try {
          const rawRtk = ev.dataTransfer?.getData("application/x-gs-rtk-photos") || ev.dataTransfer?.getData("text/plain");
          if (rawRtk) {
            const parsed = JSON.parse(rawRtk);
            if (Array.isArray(parsed) && parsed.length) droppedRtk = parsed;
          }
        } catch (_) {}
        if (droppedRtk.length) {
          STATE.pendingCommentDraftPhotos = droppedRtk.slice();
          STATE.selectedNewCommentFolder = targetFolder;
          if (typeof openCommentsInspector === "function") openCommentsInspector(pt, twd);
          return;
        }
        if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length > 0) {
          STATE.selectedNewCommentFolder = targetFolder;
          if (typeof uploadLocalFilesToComment === "function") {
            await uploadLocalFilesToComment(ev.dataTransfer.files, null, pt, twd);
          }
        }
      });
    });

    // 9. Existing comment card actions (enlarge photo, remove photo, find location photos, upload photo, edit, delete)
    listBox.querySelectorAll("[data-comment-photo-enlarge]").forEach((imgEl) => {
      imgEl.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const cid = imgEl.getAttribute("data-comment-photo-enlarge");
        const pIdx = Number(imgEl.getAttribute("data-comment-photo-idx")) || 0;
        const targetComment = comments.find((item) => String(item.comment_id) === String(cid));
        const cPhotos = Array.isArray(targetComment?.photos) ? targetComment.photos : [];
        const p = cPhotos[pIdx];
        if (p && typeof openPhotoLightboxModal === "function") {
          openPhotoLightboxModal(p.url, p.filename, "", cPhotos, pIdx);
        }
      });
    });

    listBox.querySelectorAll("[data-comment-remove-photo-url]").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const cid = btn.getAttribute("data-comment-remove-photo-cid");
        const rmUrl = btn.getAttribute("data-comment-remove-photo-url");
        const targetComment = comments.find((item) => String(item.comment_id) === String(cid));
        if (!cid || !targetComment) return;
        const remaining = (Array.isArray(targetComment.photos) ? targetComment.photos : []).filter(
          (p) => String(p.url) !== String(rmUrl)
        );
        try {
          const res = await apiPost("/api/comments/update", {
            action: "update",
            comment_id: cid,
            scan_id: scanId,
            author_email: STATE.currentUser?.email || "",
            author_name: typeof getCurrentCommentActorName === "function" ? getCurrentCommentActorName() : "Engineer",
            photos: remaining,
          });
          if (Array.isArray(res?.comments) && STATE.activeScan) {
            STATE.activeScan.comments = res.comments;
          }
          await refreshScansCatalog();
          if (typeof openCommentsInspector === "function") openCommentsInspector(pt, twd);
        } catch (err) {
          showToast(`Remove Photo Error: ${err.message}`);
        }
      });
    });

    listBox.querySelectorAll("[data-comment-find-photos]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const cid = btn.getAttribute("data-comment-find-photos");
        const targetComment = comments.find((item) => String(item.comment_id) === String(cid));
        if (targetComment && typeof openLocationPhotosForComment === "function") {
          openLocationPhotosForComment(targetComment);
        }
      });
    });

    listBox.querySelectorAll("[data-comment-upload-photo]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const cid = btn.getAttribute("data-comment-upload-photo");
        if (cid && typeof triggerCommentPhotoFilePicker === "function") {
          triggerCommentPhotoFilePicker(cid, pt, twd);
        }
      });
    });

    listBox.querySelectorAll(".btn-move-comment").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const cid = btn.getAttribute("data-cid") || btn.getAttribute("data-comment-move") || "";
        if (!cid) return;
        STATE.movingCommentId = STATE.movingCommentId === cid ? null : cid;
        const canvasEl = document.getElementById("studioCanvas");
        if (canvasEl) canvasEl.style.cursor = STATE.movingCommentId ? "crosshair" : "";
        if (STATE.movingCommentId) {
          showToast(
            tr(
              "📍 請在 3D 模型上點擊新的標記位置 (按 Esc 取消)",
              "📍 Click new 3D point on scan to move note (Esc to cancel)"
            )
          );
        }
        if (typeof renderCommentPins3D === "function") renderCommentPins3D();
        if (typeof openCommentsInspector === "function") openCommentsInspector(pt, twd);
      });
    });

    listBox.querySelectorAll("[data-comment-edit]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const cid = btn.getAttribute("data-comment-edit");
        const editBox = listBox.querySelector(`[data-comment-edit-box="${cid}"]`);
        const textBox = listBox.querySelector(`[data-comment-text="${cid}"]`);
        if (editBox && textBox) {
          const openNow = editBox.style.display === "none";
          editBox.style.display = openNow ? "block" : "none";
          textBox.style.display = openNow ? "none" : "block";
        }
      });
    });

    listBox.querySelectorAll("[data-comment-edit-cancel]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const cid = btn.getAttribute("data-comment-edit-cancel");
        const editBox = listBox.querySelector(`[data-comment-edit-box="${cid}"]`);
        const textBox = listBox.querySelector(`[data-comment-text="${cid}"]`);
        if (editBox && textBox) {
          editBox.style.display = "none";
          textBox.style.display = "block";
        }
      });
    });

    listBox.querySelectorAll("[data-comment-edit-save]").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const cid = btn.getAttribute("data-comment-edit-save");
        const inp = listBox.querySelector(`[data-comment-edit-input="${cid}"]`);
        const newText = inp ? inp.value.trim() : "";
        if (!cid || !newText) return;
        try {
          const res = await apiPost("/api/comments/update", {
            action: "update",
            comment_id: cid,
            scan_id: scanId,
            author_email: STATE.currentUser?.email || "",
            author_name: typeof getCurrentCommentActorName === "function" ? getCurrentCommentActorName() : "Engineer",
            text: newText,
          });
          if (Array.isArray(res?.comments) && STATE.activeScan) {
            STATE.activeScan.comments = res.comments;
          }
          showToast(tr("已更新空間標註", "Updated 3D comment"));
          await refreshScansCatalog();
          if (typeof openCommentsInspector === "function") openCommentsInspector(pt, twd);
        } catch (err) {
          showToast(`Edit Comment Error: ${err.message}`);
        }
      });
    });

    listBox.querySelectorAll("[data-comment-delete]").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const cid = btn.getAttribute("data-comment-delete");
        if (!cid) return;
        try {
          const res = await apiPost("/api/comments/delete", {
            action: "delete",
            comment_id: cid,
            scan_id: scanId,
            author_email: STATE.currentUser?.email || "",
            author_name: typeof getCurrentCommentActorName === "function" ? getCurrentCommentActorName() : "Engineer",
          });
          if (Array.isArray(res?.comments) && STATE.activeScan) {
            STATE.activeScan.comments = res.comments;
          }
          showToast(tr("已刪除空間標註", "Deleted 3D comment"));
          await refreshScansCatalog();
          if (typeof openCommentsInspector === "function") openCommentsInspector(pt, twd);
        } catch (err) {
          showToast(`Delete Comment Error: ${err.message}`);
        }
      });
    });
  }
  window.bindCommentFoldersAndCardsEvents = bindCommentFoldersAndCardsEvents;

  // ============================================================================
  // GLOBAL EVENT BINDINGS FOR NEW MAP, STUDIO & COMPARE SURVEYING CONTROLS
  // ============================================================================
  function initAdvancedSurveyingAndQaModule() {
    document.getElementById("btnMapToggleOrthoOverlay")?.addEventListener("click", () => {
      STATE.mapOrthoOverlayEnabled = !STATE.mapOrthoOverlayEnabled;
      document.getElementById("btnMapToggleOrthoOverlay")?.classList.toggle("active", STATE.mapOrthoOverlayEnabled);
      if (typeof gsMap !== "undefined" && gsMap && typeof gsMap.drawMap === "function") {
        gsMap.drawMap();
      }
      showToast(
        STATE.mapOrthoOverlayEnabled
          ? tr("已開啟地圖 2D 正射影像疊圖 (True Ortho Overlay)", "Enabled 2D Nadir Orthomosaic Plan Overlay on Map")
          : tr("已隱藏地圖 2D 正射影像疊圖", "Hidden 2D Nadir Orthomosaic Plan Overlay")
      );
    });

    document.getElementById("mapOrthoOpacitySlider")?.addEventListener("input", (e) => {
      const v = Math.max(0.15, Math.min(1.0, parseFloat(e.target.value) || 0.78));
      STATE.mapOrthoOpacity = v;
      const lbl = document.getElementById("lblMapOrthoOpacity");
      if (lbl) lbl.textContent = `${Math.round(v * 100)}%`;
      if (typeof gsMap !== "undefined" && gsMap && typeof gsMap.drawMap === "function") {
        gsMap.drawMap();
      }
    });

    document.getElementById("btnCaptureNadirOrtho")?.addEventListener("click", () => {
      captureNadirOrthoSnapshotForActiveScan(true);
    });
    document.getElementById("btnStudioCaptureOrtho")?.addEventListener("click", () => {
      captureNadirOrthoSnapshotForActiveScan(false);
    });

    document.getElementById("btnStudioSavedViews")?.addEventListener("click", () => {
      openSavedMeasurementsInspector();
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && STATE.movingCommentId) {
        STATE.movingCommentId = null;
        const canvasEl = document.getElementById("studioCanvas");
        if (canvasEl) canvasEl.style.cursor = "";
        if (typeof renderCommentPins3D === "function") renderCommentPins3D();
        if (STATE.activeTool === "comments" && typeof openCommentsInspector === "function") {
          openCommentsInspector();
        }
        showToast(tr("已取消移動標記位置", "Cancelled moving note pin"));
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAdvancedSurveyingAndQaModule);
  } else {
    initAdvancedSurveyingAndQaModule();
  }
