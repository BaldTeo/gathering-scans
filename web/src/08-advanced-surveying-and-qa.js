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
    let customDataUrl = null;
    let customBounds = null;
    try {
      customDataUrl = localStorage.getItem(`gs_nadir_ortho_v2_${sid}`);
      const rawB = localStorage.getItem(`gs_nadir_ortho_bounds_v2_${sid}`);
      if (rawB) customBounds = JSON.parse(rawB);
    } catch (_) {}
    const img = new Image();
    img.crossOrigin = "anonymous";
    const entry = {
      img,
      loaded: false,
      failed: false,
      isNadir: true,
      bounds: scan.ortho_bounds || customBounds || null,
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
    img.src = customDataUrl || scan.ortho_url || `/api/scans/${encodeURIComponent(sid)}/ortho${qSuffix}`;
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
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true });
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

  function buildFastStudioSurfaceArrows(gridSize = 20, excludeWalls = true) {
    const G = Math.max(8, Math.min(40, Number(gridSize) || 20));
    const meshes = [];
    let totalVerts = 0;

    const collectFromRoot = (rootObj) => {
      if (!rootObj || !rootObj.visible) return;
      rootObj.updateMatrixWorld(true);
      rootObj.traverse((c) => {
        if (
          c.isMesh &&
          c.geometry &&
          c.geometry.attributes &&
          c.geometry.attributes.position &&
          isMeshVisibleUnderRoot(c, rootObj) &&
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
      const cellStep = Math.max(1.2, Math.max(spanX, spanZ) / G);
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
      return { cellStep: 4.0, arrows: [] };
    }

    const stride = Math.max(1, Math.floor(totalVerts / 48000));
    const sx = [];
    const sy = [];
    const sz = [];

    for (let mi = 0; mi < meshes.length; mi++) {
      const m = meshes[mi];
      const pos = m.geometry.attributes.position;
      const arr = pos.array;
      const itemSize = pos.itemSize || 3;
      const count = pos.count;
      const e = m.matrixWorld.elements;
      const m0 = e[0], m1 = e[1], m2 = e[2];
      const m4 = e[4], m5 = e[5], m6 = e[6];
      const m8 = e[8], m9 = e[9], m10 = e[10];
      const m12 = e[12], m13 = e[13], m14 = e[14];

      for (let i = 0; i < count; i += stride) {
        const base = i * itemSize;
        const vx = arr[base];
        const vy = arr[base + 1];
        const vz = arr[base + 2];
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
      return { cellStep: 4.0, arrows: [] };
    }

    const sortedX = sx.slice().sort((a, b) => a - b);
    const sortedZ = sz.slice().sort((a, b) => a - b);
    const minX = sortedX[Math.floor(sortedX.length * 0.01)];
    const maxX = sortedX[Math.floor(sortedX.length * 0.99)];
    const minZ = sortedZ[Math.floor(sortedZ.length * 0.01)];
    const maxZ = sortedZ[Math.floor(sortedZ.length * 0.99)];

    const spanX = Math.max(6.0, maxX - minX);
    const spanZ = Math.max(6.0, maxZ - minZ);
    const cellStep = Math.max(1.0, Math.max(spanX, spanZ) / G);
    const nx = Math.max(6, Math.min(44, Math.round(spanX / cellStep) + 1));
    const nz = Math.max(6, Math.min(44, Math.round(spanZ / cellStep) + 1));
    const stepX = spanX / Math.max(1, nx - 1);
    const stepZ = spanZ / Math.max(1, nz - 1);

    // Build a fine 2D mesh surface occupancy grid (128x128) using both vertices and triangle centroids/midpoints
    // so un-scanned voids / water channels / outer bounding-box corners remain 0 (unoccupied)
    const fineN = 128;
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
    // Sample triangle centroids and edge midpoints across meshes to ensure genuine mesh triangles are marked occupied
    // while large empty un-scanned areas (where no triangles exist) stay strictly 0
    for (let mi = 0; mi < meshes.length; mi++) {
      const m = meshes[mi];
      const pos = m.geometry.attributes.position;
      const arr = pos.array;
      const itemSize = pos.itemSize || 3;
      const idxAttr = m.geometry.index;
      const e = m.matrixWorld.elements;
      const m0 = e[0], m4 = e[4], m8 = e[8], m12 = e[12];
      const m2 = e[2], m6 = e[6], m10 = e[10], m14 = e[14];
      const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(pos.count / 3);
      const triStride = Math.max(1, Math.floor(triCount / 28000));
      const idxArr = idxAttr ? idxAttr.array : null;
      const maxEdgeSq = Math.pow(Math.max(4.5, Math.min(stepX, stepZ) * 1.35), 2);
      for (let ti = 0; ti < triCount; ti += triStride) {
        const i0 = (idxArr ? idxArr[ti * 3] : ti * 3) * itemSize;
        const i1 = (idxArr ? idxArr[ti * 3 + 1] : ti * 3 + 1) * itemSize;
        const i2 = (idxArr ? idxArr[ti * 3 + 2] : ti * 3 + 2) * itemSize;
        const x0 = m0 * arr[i0] + m4 * arr[i0 + 1] + m8 * arr[i0 + 2] + m12;
        const z0 = m2 * arr[i0] + m6 * arr[i0 + 1] + m10 * arr[i0 + 2] + m14;
        const x1 = m0 * arr[i1] + m4 * arr[i1 + 1] + m8 * arr[i1 + 2] + m12;
        const z1 = m2 * arr[i1] + m6 * arr[i1 + 1] + m10 * arr[i1 + 2] + m14;
        const x2 = m0 * arr[i2] + m4 * arr[i2 + 1] + m8 * arr[i2 + 2] + m12;
        const z2 = m2 * arr[i2] + m6 * arr[i2 + 1] + m10 * arr[i2 + 2] + m14;
        const d01 = (x1 - x0) * (x1 - x0) + (z1 - z0) * (z1 - z0);
        const d12 = (x2 - x1) * (x2 - x1) + (z2 - z1) * (z2 - z1);
        const d20 = (x0 - x2) * (x0 - x2) + (z0 - z2) * (z0 - z2);
        if (d01 <= maxEdgeSq && d12 <= maxEdgeSq && d20 <= maxEdgeSq) {
          const cx = (x0 + x1 + x2) / 3.0;
          const cz = (z0 + z1 + z2) / 3.0;
          markFineOcc(cx, cz);
          markFineOcc(0.5 * (x0 + x1), 0.5 * (z0 + z1));
          markFineOcc(0.5 * (x1 + x2), 0.5 * (z1 + z2));
          markFineOcc(0.5 * (x2 + x0), 0.5 * (z2 + z0));
        }
      }
    }
    // Close only 1-pixel micro-gaps surrounded by >= 6 of 8 occupied fine cells (never bridges real voids)
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
        if (nOcc >= 6) fineOccClosed[fIdx] = 1;
      }
    }

    const isFineSurfaceOccupied = (wx, wz) => {
      if (wx < minX || wx > maxX || wz < minZ || wz > maxZ) return false;
      if (isPointInsideAnyWaterPolyXZ(wx, wz, waterPolys2D)) return false;
      const fx = Math.min(fineN - 1, Math.max(0, Math.floor((wx - minX) / fineStepX)));
      const fz = Math.min(fineN - 1, Math.max(0, Math.floor((wz - minZ) / fineStepZ)));
      if (!fineOccClosed[fz * fineN + fx]) return false;
      // Also require at least 7 of 9 cells in the 3x3 fine neighborhood to be occupied so arrows never sit on void rims
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
      return localOcc >= 7;
    };

    const minYGrid = new Float32Array(nx * nz);
    const sumYGrid = new Float32Array(nx * nz);
    const sumXGrid = new Float32Array(nx * nz);
    const sumZGrid = new Float32Array(nx * nz);
    const cntGrid = new Uint32Array(nx * nz);
    minYGrid.fill(Infinity);

    for (let i = 0; i < sx.length; i++) {
      const wx = sx[i];
      const wy = sy[i];
      const wz = sz[i];
      if (wx < minX || wx > maxX || wz < minZ || wz > maxZ) continue;
      const ix = Math.min(nx - 1, Math.max(0, Math.floor((wx - minX) / stepX)));
      const iz = Math.min(nz - 1, Math.max(0, Math.floor((wz - minZ) / stepZ)));
      const idx = iz * nx + ix;
      if (wy < minYGrid[idx]) minYGrid[idx] = wy;
      sumYGrid[idx] += wy;
      sumXGrid[idx] += wx;
      sumZGrid[idx] += wz;
      cntGrid[idx] += 1;
    }

    // Bare-surface elevation per occupied cell (requires >= 3 real mesh vertices; never extrapolates into voids)
    const rawH = new Float32Array(nx * nz);
    const validCell = new Uint8Array(nx * nz);
    for (let idx = 0; idx < nx * nz; idx++) {
      if (cntGrid[idx] >= 3 && Number.isFinite(minYGrid[idx])) {
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
    const maxStepJump = Math.max(1.8, cellStep * 0.85);
    for (let iz = 1; iz < nz - 1; iz++) {
      for (let ix = 1; ix < nx - 1; ix++) {
        const idx = iz * nx + ix;
        if (!smoothValid[idx]) continue;

        // Require all 4 cardinal neighbors to be valid occupied cells so arrows never overhang void edges
        const idxL = iz * nx + (ix - 1);
        const idxR = iz * nx + (ix + 1);
        const idxD = (iz - 1) * nx + ix;
        const idxU = (iz + 1) * nx + ix;
        if (!smoothValid[idxL] || !smoothValid[idxR] || !smoothValid[idxD] || !smoothValid[idxU]) continue;

        const hC = smoothH[idx];
        if (
          Math.abs(smoothH[idxR] - hC) > maxStepJump ||
          Math.abs(smoothH[idxL] - hC) > maxStepJump ||
          Math.abs(smoothH[idxU] - hC) > maxStepJump ||
          Math.abs(smoothH[idxD] - hC) > maxStepJump
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

        const dzdx = (smoothH[idxR] - smoothH[idxL]) / (2.0 * stepX);
        const dzdz = (smoothH[idxU] - smoothH[idxD]) / (2.0 * stepZ);
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

  function renderDrainageAndSlopeVisuals3D(
    opts = { gridSize: 20, arrowScale: 1.0, showLabels: true, excludeWalls: true }
  ) {
    if (!studioThree || !studioThree.overlayGroup) return null;
    clearDrainageVisuals3D();

    const gridSize = Math.max(8, Math.min(40, Number(opts?.gridSize) || Number(STATE.drainageGridSize) || 20));
    const arrowScale = Math.max(
      0.2,
      Math.min(3.0, Number(opts?.arrowScale) || Number(STATE.drainageArrowScale) || 1.0)
    );
    const showLabels = opts?.showLabels !== undefined ? Boolean(opts.showLabels) : STATE.drainageShowLabels !== false;
    const excludeWalls =
      opts?.excludeWalls !== undefined ? Boolean(opts.excludeWalls) : STATE.drainageExcludeWalls !== false;
    STATE.drainageGridSize = gridSize;
    STATE.drainageArrowScale = arrowScale;
    STATE.drainageShowLabels = showLabels;
    STATE.drainageExcludeWalls = excludeWalls;

    const grp = new THREE.Group();
    studioThree.drainageGroup = grp;
    studioThree.overlayGroup.add(grp);

    const { cellStep, arrows } = buildFastStudioSurfaceArrows(gridSize, excludeWalls);

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

    // Default arrow size (arrowScale = 1.0) is 1/5 (0.20x) of the legacy oversized arrows
    const yLift = Math.max(0.08, cellStep * 0.025);

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

      const len = cellStep * tier.lenScale * 0.172 * arrowScale;
      const shaftLen = len * 0.62;
      const shaftHalfW = Math.max(0.02, cellStep * 0.015 * arrowScale);
      const headHalfW = Math.max(0.045, cellStep * 0.038 * arrowScale);

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
          depthTest: false,
          depthWrite: false,
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
          depthTest: false,
          depthWrite: false,
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

  async function openDrainageAndSlopeInspector() {
    setActiveStudioTool("drainage");
    STATE.sidePanelMinimized = false;

    const curGridSize = Math.max(8, Math.min(40, Number(STATE.drainageGridSize) || 20));
    const curArrowScale = Math.max(0.2, Math.min(3.0, Number(STATE.drainageArrowScale) || 1.0));
    const curShowLabels = STATE.drainageShowLabels !== false;
    const curExcludeWalls = STATE.drainageExcludeWalls !== false;

    let localStats = renderDrainageAndSlopeVisuals3D({
      gridSize: curGridSize,
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
      const gVal = Math.max(8, Math.min(40, Number(STATE.drainageGridSize) || 20));
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
            <span style="font-weight:700;">${tr("箭頭網格密度 (Density)", "Arrow Grid Density")}</span>
            <span id="lblDrainageDensityVal" style="font-family:var(--font-mono);color:var(--ui-accent);font-weight:700;">${gVal}×${gVal}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <input type="range" id="rngDrainageDensity" class="gs-input" min="8" max="36" step="2" value="${gVal}" style="flex:1;" />
            <select id="selDrainageGridSize" class="gs-select" style="width:94px;height:24px;font-size:10.5px;">
              <option value="12" ${gVal <= 12 ? "selected" : ""}>12×12</option>
              <option value="20" ${gVal > 12 && gVal <= 22 ? "selected" : ""}>20×20</option>
              <option value="28" ${gVal > 22 && gVal <= 30 ? "selected" : ""}>28×28</option>
              <option value="36" ${gVal > 30 ? "selected" : ""}>36×36</option>
            </select>
          </div>
        </div>
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;">
            <span style="font-weight:700;">${tr("箭頭尺寸比例 (Arrow Size)", "Arrow Size Scale")}</span>
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
      const refreshVisInPlace = (overrideGrid = null) => {
        const rngG = document.getElementById("rngDrainageDensity");
        const selG = document.getElementById("selDrainageGridSize");
        const gVal = Math.max(
          8,
          Math.min(40, Number(overrideGrid || rngG?.value || selG?.value || STATE.drainageGridSize || 20))
        );
        if (rngG && Number(rngG.value) !== gVal) rngG.value = String(gVal);
        if (selG && overrideGrid) selG.value = String(gVal);
        const aScale = Math.max(
          0.2,
          Math.min(3.0, Number(document.getElementById("rngDrainageArrowSize")?.value || STATE.drainageArrowScale || 1.0))
        );
        const lVal = Boolean(document.getElementById("chkDrainageShowLabels")?.checked);
        const wVal = Boolean(document.getElementById("chkDrainageExcludeWalls")?.checked);
        const lblG = document.getElementById("lblDrainageDensityVal");
        if (lblG) lblG.textContent = `${gVal}×${gVal}`;
        const lblS = document.getElementById("lblDrainageArrowSizeVal");
        if (lblS) lblS.textContent = `${aScale.toFixed(1)}x`;
        const newSt = renderDrainageAndSlopeVisuals3D({
          gridSize: gVal,
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
        if (STATE.activeTool === "drainage" && (!localStats || localStats.arrow_count === 0)) {
          localStats = renderDrainageAndSlopeVisuals3D({
            gridSize: Number(STATE.drainageGridSize) || 20,
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
  // FEATURE 6: DIRECT FIELD-TO-3D PHOTO FRUSTUM PROJECTION & CAMERA ALIGNMENT
  // ============================================================================
  function clearRtkPhotoFrustums3D() {
    if (studioThree && studioThree.overlayGroup && studioThree.photoFrustumGroup) {
      studioThree.overlayGroup.remove(studioThree.photoFrustumGroup);
      studioThree.photoFrustumGroup = null;
    }
    const ov = document.getElementById("studioPhotoFrustumOverlay");
    if (ov) ov.style.display = "none";
  }

  function twd97ToStudioLocalVec(e, n, h, refTargetTwd, refTargetLocalPt) {
    if (refTargetTwd && refTargetLocalPt) {
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

  function renderRtkPhotoFrustums3D(photos, targetTwd, targetLocalPt) {
    if (!studioThree || !studioThree.overlayGroup || !Array.isArray(photos)) return;
    if (studioThree.photoFrustumGroup) {
      studioThree.overlayGroup.remove(studioThree.photoFrustumGroup);
      studioThree.photoFrustumGroup = null;
    }
    const grp = new THREE.Group();
    studioThree.photoFrustumGroup = grp;
    if (!studioThree.photoFrustumGroup.parent) {
      studioThree.overlayGroup.add(studioThree.photoFrustumGroup);
    }

    const tgtPt = targetLocalPt ? targetLocalPt.clone() : new THREE.Vector3(0, 0, 0);
    photos.forEach((p, idx) => {
      const camPt = twd97ToStudioLocalVec(p.camera_twd97_e, p.camera_twd97_n, p.camera_twd97_h, targetTwd, tgtPt);
      p._localCamPt = camPt;
      p._localTargetPt = tgtPt.clone();

      const dir = tgtPt.clone().sub(camPt);
      const dist = Math.max(1.5, dir.length());
      dir.normalize();
      const frustumDepth = Math.min(3.2, dist * 0.45);
      const halfW = frustumDepth * 0.52;
      const halfH = frustumDepth * 0.36;

      const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
      if (right.lengthSq() < 0.01) right.set(1, 0, 0);
      const up = new THREE.Vector3().crossVectors(right, dir).normalize();
      const centerPlane = camPt.clone().addScaledVector(dir, frustumDepth);

      const c0 = centerPlane.clone().addScaledVector(right, -halfW).addScaledVector(up, halfH);
      const c1 = centerPlane.clone().addScaledVector(right, halfW).addScaledVector(up, halfH);
      const c2 = centerPlane.clone().addScaledVector(right, halfW).addScaledVector(up, -halfH);
      const c3 = centerPlane.clone().addScaledVector(right, -halfW).addScaledVector(up, -halfH);

      const frustumPts = [
        camPt, c0, camPt, c1, camPt, c2, camPt, c3,
        c0, c1, c1, c2, c2, c3, c3, c0,
        camPt, tgtPt,
      ];
      const lineGeo = new THREE.BufferGeometry().setFromPoints(frustumPts);
      const col = idx === 0 ? 0x38bdf8 : 0xf59e0b;
      const line = new THREE.LineSegments(
        lineGeo,
        new THREE.LineBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.9 })
      );
      line.renderOrder = 997;
      grp.add(line);
    });
  }

  function alignStudioCameraToRtkPhoto(photo, opacityPct = 55) {
    if (!photo || !studioThree) return;
    if (STATE.fpMode?.active && typeof exitFirstPersonMode === "function") {
      exitFirstPersonMode(false);
    }
    const camPt = photo._localCamPt || new THREE.Vector3(10, 8, 10);
    const tgtPt = photo._localTargetPt || new THREE.Vector3(0, 0, 0);
    studioThree.camera.position.copy(camPt);
    studioThree.controls.target.copy(tgtPt);
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
      modal.style.cssText =
        "position:fixed;inset:0;z-index:9999;background:rgba(2,6,23,0.92);backdrop-filter:blur(10px);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;";
      document.body.appendChild(modal);
    }
    const list = Array.isArray(allPhotos) && allPhotos.length > 0 ? allPhotos : [{ url: photoUrl, filename: photoTitle, meta: photoMetaText }];
    let activeIdx = Math.max(0, Math.min(list.length - 1, Number(curIdx) || 0));

    const renderLightboxContent = () => {
      const item = list[activeIdx] || { url: photoUrl, filename: photoTitle, meta: photoMetaText };
      const url = item.url || photoUrl;
      const fname = item.filename || photoTitle || "RTK_Photo.jpg";
      const meta =
        item.meta ||
        photoMetaText ||
        (item.camera_twd97_e !== undefined
          ? `E:${item.camera_twd97_e}m | N:${item.camera_twd97_n}m | H:+${item.camera_twd97_h}m | RTK σ=${item.rtk_h_sigma_cm || 1.2}cm`
          : "");
      modal.innerHTML = `
        <div style="width:min(1120px,95vw);display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;color:#f8fafc;">
          <div style="min-width:0;">
            <div style="font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">📷 ${escapeHtml(fname)}</div>
            <div style="font-size:11.5px;color:#94a3b8;font-family:var(--font-mono);">${escapeHtml(meta)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
            ${
              list.length > 1
                ? `<button type="button" class="gs-top-btn" id="btnLightboxPrev" style="height:30px;padding:0 10px;">◀ ${tr("上一張", "Prev")}</button>
                   <span style="font-size:11.5px;font-family:var(--font-mono);color:#cbd5e1;">${activeIdx + 1} / ${list.length}</span>
                   <button type="button" class="gs-top-btn" id="btnLightboxNext" style="height:30px;padding:0 10px;">${tr("下一張", "Next")} ▶</button>`
                : ""
            }
            <a class="gs-top-btn accent" href="${escapeHtml(url)}" download="${escapeHtml(fname)}" style="height:30px;padding:0 12px;text-decoration:none;display:inline-flex;align-items:center;gap:5px;">
              <span>⬇ ${tr("下載照片", "Download")}</span>
            </a>
            <button type="button" class="gs-top-btn" id="btnLightboxClose" style="height:30px;padding:0 12px;">✕ ${tr("關閉", "Close")}</button>
          </div>
        </div>
        <div style="position:relative;width:min(1120px,95vw);height:min(76vh,760px);background:#0f172a;border:1px solid rgba(148,163,184,0.28);border-radius:12px;display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,0.65);">
          <img id="imgLightboxMain" src="${escapeHtml(url)}" alt="${escapeHtml(fname)}" style="max-width:100%;max-height:100%;object-fit:contain;transition:transform 0.18s ease;cursor:zoom-in;" />
        </div>
      `;
      modal.style.display = "flex";

      let zoomed = false;
      const imgEl = modal.querySelector("#imgLightboxMain");
      imgEl?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        zoomed = !zoomed;
        imgEl.style.transform = zoomed ? "scale(1.85)" : "scale(1)";
        imgEl.style.cursor = zoomed ? "zoom-out" : "zoom-in";
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
    };

    modal.onclick = (e) => {
      if (e.target === modal) modal.style.display = "none";
    };
    renderLightboxContent();
  }
  window.openPhotoLightboxModal = openPhotoLightboxModal;

  async function attachPhotosToCommentById(commentId, photosToAttach) {
    const cid = String(commentId || "").trim();
    const cleanPhotos = (Array.isArray(photosToAttach) ? photosToAttach : [])
      .filter((p) => p && p.url)
      .map((p) => ({
        id: String(p.id || p.filename || ""),
        filename: String(p.filename || "RTK_Photo.jpg"),
        url: String(p.url || ""),
        camera_twd97_e: Number(p.camera_twd97_e || 0),
        camera_twd97_n: Number(p.camera_twd97_n || 0),
        camera_twd97_h: Number(p.camera_twd97_h || 0),
        rtk_h_sigma_cm: Number(p.rtk_h_sigma_cm || 1.2),
      }));
    if (!cid || !cleanPhotos.length) return false;
    try {
      const res = await apiPost("/api/comments/update", {
        action: "attach_photos",
        comment_id: cid,
        scan_id: STATE.activeScanId,
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

  function getSelectedOrDraggedRtkPhotos(photos, fallbackIdx = 0) {
    const checkedIdxs = [];
    document.querySelectorAll("[data-rtk-photo-check]:checked").forEach((chk) => {
      const idx = Number(chk.getAttribute("data-rtk-photo-check"));
      if (Number.isFinite(idx) && photos[idx]) checkedIdxs.push(idx);
    });
    if (checkedIdxs.length > 0 && checkedIdxs.includes(fallbackIdx)) {
      return checkedIdxs.map((i) => photos[i]);
    }
    return photos[fallbackIdx] ? [photos[fallbackIdx]] : [];
  }

  function bindRtkPhotoInspectorActions(photos, targetTwd, targetLocalPt) {
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
        const batch = getSelectedOrDraggedRtkPhotos(photos, idx);
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAdvancedSurveyingAndQaModule);
  } else {
    initAdvancedSurveyingAndQaModule();
  }
