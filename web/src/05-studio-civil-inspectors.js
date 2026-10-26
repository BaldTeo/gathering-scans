/**
 * GatheringScans Frontend Module 05 — Civil Engineering Inspector Panels (Volume, Contours, AI Categorization, Profile, RTK, Section, Comments)
 */
"use strict";

  // ============================================================================
  // 3. CIVIL ENGINEERING INSPECTOR PANELS (Volume, Contours, Profile, Photos, Optimizer)
  // ============================================================================
  function clearSectionBoxClippingIfNotKept() {
    if (!studioThree || !studioThree.renderer) return;
    if (!STATE.keepSectionBoxClip) {
      studioThree.renderer.clippingPlanes = [];
      if (studioThree._sectionBoxHelper) {
        studioThree.overlayGroup?.remove(studioThree._sectionBoxHelper);
        if (studioThree._sectionBoxHelper.geometry) studioThree._sectionBoxHelper.geometry.dispose();
        if (studioThree._sectionBoxHelper.material) studioThree._sectionBoxHelper.material.dispose();
        studioThree._sectionBoxHelper = null;
      }
    }
  }

  function showSidePanel(title, htmlContent) {
    const panel = document.getElementById("studioSidePanel");
    const titleEl = document.getElementById("sidePanelTitle");
    const bodyEl = document.getElementById("sidePanelBody");
    if (!panel || !titleEl || !bodyEl) return;
    const tTitle = typeof window.translateDynamicHtml === "function" ? window.translateDynamicHtml(String(title || "")) : String(title || "");
    const tBody =
      typeof window.translateDynamicHtml === "function" ? window.translateDynamicHtml(String(htmlContent || "")) : String(htmlContent || "");
    titleEl.innerHTML = tTitle;
    bodyEl.innerHTML = tBody;
    panel.setAttribute("data-active-tool", STATE.activeTool || "");
    panel.classList.remove("hidden");
    panel.classList.add("active", "open");
    panel.classList.toggle("mobile-minimized", Boolean(STATE.sidePanelMinimized));
    panel.classList.toggle("gs-panel-minimized", Boolean(STATE.sidePanelMinimized));
    const lblCollapse = document.getElementById("lblCollapseSidePanel");
    if (lblCollapse) {
      lblCollapse.textContent = STATE.sidePanelMinimized ? tr("▴ 展開", "▴ Expand") : tr("▾ 收合", "▾ Collapse");
    }
    if (typeof syncStudioMobileToolHud === "function") syncStudioMobileToolHud();
    if (typeof syncMobileToastPosition === "function") syncMobileToastPosition();
    update2DBadgePositions();
  }

  document.getElementById("btnCollapseSidePanel")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const panel = document.getElementById("studioSidePanel");
    if (!panel) return;
    STATE.sidePanelMinimized = !STATE.sidePanelMinimized;
    panel.classList.toggle("mobile-minimized", STATE.sidePanelMinimized);
    panel.classList.toggle("gs-panel-minimized", STATE.sidePanelMinimized);
    const lblCollapse = document.getElementById("lblCollapseSidePanel");
    if (lblCollapse) {
      lblCollapse.textContent = STATE.sidePanelMinimized ? tr("▴ 展開", "▴ Expand") : tr("▾ 收合", "▾ Collapse");
    }
    if (typeof syncStudioMobileToolHud === "function") syncStudioMobileToolHud();
    if (typeof syncMobileToastPosition === "function") syncMobileToastPosition();
    update2DBadgePositions();
  });

  document.getElementById("btnCloseSidePanel")?.addEventListener("click", () => {
    clearSectionBoxClippingIfNotKept();
    if (STATE.activeTool === "crop_delete" || STATE.activeTool === "crop" || STATE.activeTool === "optimizer") {
      cancelLassoToolMode(false);
    } else if (
      ["section", "profile", "crs", "generate_scan", "rtk", "photos", "comments"].includes(STATE.activeTool)
    ) {
      setActiveStudioTool(STATE.multiAlign?.active ? "align_merge" : "orbit");
    }
    const panel = document.getElementById("studioSidePanel");
    if (panel) {
      panel.classList.remove("active", "open", "mobile-minimized", "gs-panel-minimized");
      panel.classList.add("hidden");
    }
    STATE.sidePanelMinimized = false;
    if (typeof syncStudioMobileToolHud === "function") syncStudioMobileToolHud();
    if (typeof syncMobileToastPosition === "function") syncMobileToastPosition();
    update2DBadgePositions();
  });

  function finalizeActiveMobilePolygon() {
    if (
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
        syncStudioMobileToolHud();
        return;
      }
      if (STATE.categorizeEditMode === "add_wall" && STATE.categorizeEditPoints.length >= 2) {
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
        syncStudioMobileToolHud();
        return;
      }
    }

    if (STATE.activeView === "studio" && Array.isArray(STATE.measurePoints) && STATE.measurePoints.length >= 3) {
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
        if (typeof renderClosedAreaPolygon === "function") {
          renderClosedAreaPolygon(lockedPts);
        }
        showToast(`Area polygon locked (${lockedPts.length} vertices)`);
      } else if (STATE.activeTool === "contours") {
        STATE.maskBoundaryPoints = lockedPts.map((p) => p.clone());
        STATE.polygonLocked = true;
        showToast(`Mask boundary locked (${lockedPts.length} vertices) — updating Civil3D.dwg & A3 PDF`);
        openContoursInspector(lockedPts);
      }
      syncStudioMobileToolHud();
    }
  }

  function syncStudioMobileToolHud() {
    const hud = document.getElementById("studioMobileToolHud");
    if (!hud) return;
    if (STATE.activeView !== "studio" || STATE.fpMode?.active) {
      hud.style.display = "none";
      return;
    }
    const tool = STATE.activeTool || "orbit";
    const ptsCount = Array.isArray(STATE.measurePoints) ? STATE.measurePoints.length : 0;

    if (tool === "crop_delete" || tool === "crop") {
      const isDel = tool === "crop_delete";
      const isOrbitSub = Boolean(STATE.studioLassoOrbitMode);
      const pendingRegions = typeof countMarkedRegionsPending === "function" ? countMarkedRegionsPending() : 0;
      const hasAnyMarks =
        pendingRegions > 0 ||
        ptsCount > 0 ||
        (Array.isArray(STATE.lassoStrokes) && STATE.lassoStrokes.length > 0) ||
        (Array.isArray(STATE.pendingCropPolygons) && STATE.pendingCropPolygons.length > 0);
      hud.style.display = "flex";
      hud.innerHTML = `
        <button type="button" class="gs-mobile-hud-btn ${isOrbitSub ? "primary" : ""}" data-mobile-hud="toggle_lasso_orbit">
          ${isOrbitSub ? tr("🔄 旋轉中 (點此套索)", "🔄 Orbiting (Tap to Lasso)") : tr("✏️ 套索標記 (點此旋轉)", "✏️ Lasso (Tap to Orbit)")}
        </button>
        ${
          STATE.lassoInputMethod === "polygon" && ptsCount >= 3
            ? `<button type="button" class="gs-mobile-hud-btn primary" data-mobile-hud="lock_poly">✓ ${tr(`鎖定 (${ptsCount}點)`, `Lock (${ptsCount})`)}</button>`
            : ""
        }
        ${
          pendingRegions > 0
            ? `<button type="button" class="gs-mobile-hud-btn primary" data-mobile-hud="commit_lasso">✓ ${
                isDel ? tr("執行刪除", "Delete") : tr("執行保留", "Keep")
              } (${pendingRegions})</button>`
            : ""
        }
        ${
          hasAnyMarks
            ? `<button type="button" class="gs-mobile-hud-btn" data-mobile-hud="undo_lasso">↩ ${tr("復原", "Undo")}</button>`
            : ""
        }
        <button type="button" class="gs-mobile-hud-btn" data-mobile-hud="expand_cat_panel">${
          STATE.sidePanelMinimized ? tr("▴ 面板", "▴ Panel") : tr("▾ 收合", "▾ Hide")
        }</button>
        <button type="button" class="gs-mobile-hud-btn danger" data-mobile-hud="exit_tool">✕ ${tr("離開", "Exit")}</button>
      `;
    } else if (tool === "area" || tool === "volume" || tool === "contours") {
      const toolLabel =
        tool === "area" ? tr("面積", "Area") : tool === "volume" ? tr("土方", "Volume") : tr("等高線", "Contours");
      const hasPanelToggle = tool === "volume" || tool === "contours";
      if (ptsCount === 0) {
        if (window.innerWidth > 768) {
          hud.style.display = "none";
          return;
        }
        hud.style.display = "flex";
        hud.innerHTML = `
          <span class="gs-mobile-hud-label">📐 ${toolLabel}${tr("：請點擊 3+ 點圍成範圍", ": Tap 3+ points")}</span>
          ${
            hasPanelToggle
              ? `<button type="button" class="gs-mobile-hud-btn" data-mobile-hud="expand_cat_panel">${
                  STATE.sidePanelMinimized ? tr("▴ 展開面板", "▴ Panel") : tr("▾ 收合面板", "▾ Hide")
                }</button>`
              : ""
          }
        `;
      } else {
        hud.style.display = "flex";
        hud.innerHTML = `
          <span class="gs-mobile-hud-label">📐 ${toolLabel}：${tr(`已標記 ${ptsCount} 點`, `${ptsCount} pts`)}</span>
          ${
            ptsCount >= 3
              ? `<button type="button" class="gs-mobile-hud-btn primary" data-mobile-hud="lock_poly">✓ ${tr("完成多邊形", "Lock Polygon")}</button>`
              : `<span class="gs-mobile-hud-label" style="color:var(--ui-text-secondary);">${tr(`再點 ${3 - ptsCount} 點可閉合`, `${3 - ptsCount} more`)}</span>`
          }
          <button type="button" class="gs-mobile-hud-btn" data-mobile-hud="undo_pt">↩ ${tr("復原點", "Undo")}</button>
          <button type="button" class="gs-mobile-hud-btn danger" data-mobile-hud="clear_pts">✕ ${tr("清除", "Clear")}</button>
          ${
            hasPanelToggle
              ? `<button type="button" class="gs-mobile-hud-btn" data-mobile-hud="expand_cat_panel">${
                  STATE.sidePanelMinimized ? tr("▴ 面板", "▴ Panel") : tr("▾ 收合", "▾ Hide")
                }</button>`
              : ""
          }
        `;
      }
    } else if (tool === "distance" || tool === "angle" || tool === "profile" || tool === "section") {
      const toolLabel =
        tool === "distance"
          ? tr("距離", "Distance")
          : tool === "angle"
          ? tr("角度", "Angle")
          : tool === "section"
          ? tr("剖面盒", "Section Box")
          : tr("斷面", "Profile");
      if (ptsCount === 0) {
        if (window.innerWidth > 768) {
          hud.style.display = "none";
          return;
        }
        const promptText =
          tool === "distance"
            ? tr("📏 距離：請點擊起點與終點 (0/2)", "📏 Distance: Tap start & end (0/2)")
            : tool === "angle"
            ? tr("📐 角度：請點擊 3 點量測夾角 (0/3)", "📐 Angle: Tap 3 points (0/3)")
            : tool === "section"
            ? tr("📦 剖面盒：請點擊 P1、P2 兩點 (0/2)", "📦 Section Box: Tap P1 & P2 (0/2)")
            : tr("📈 斷面：請點擊 A、B 兩點 (0/2)", "📈 Profile: Tap A & B (0/2)");
        hud.style.display = "flex";
        hud.innerHTML = `
          <span class="gs-mobile-hud-label">${promptText}</span>
          ${
            tool === "profile" || tool === "section"
              ? `<button type="button" class="gs-mobile-hud-btn" data-mobile-hud="expand_cat_panel">${
                  STATE.sidePanelMinimized ? tr("▴ 展開面板", "▴ Panel") : tr("▾ 收合面板", "▾ Hide")
                }</button>`
              : ""
          }
        `;
      } else {
        hud.style.display = "flex";
        hud.innerHTML = `
          <span class="gs-mobile-hud-label">📏 ${toolLabel}：${tr(`已標記 ${ptsCount} 點`, `${ptsCount} pts`)}</span>
          <button type="button" class="gs-mobile-hud-btn" data-mobile-hud="undo_pt">↩ ${tr("復原點", "Undo")}</button>
          <button type="button" class="gs-mobile-hud-btn danger" data-mobile-hud="clear_pts">✕ ${tr("取消", "Cancel")}</button>
          ${
            tool === "profile" || tool === "section"
              ? `<button type="button" class="gs-mobile-hud-btn" data-mobile-hud="expand_cat_panel">${
                  STATE.sidePanelMinimized ? tr("▴ 面板", "▴ Panel") : tr("▾ 收合", "▾ Hide")
                }</button>`
              : ""
          }
        `;
      }
    } else if ((tool === "photos" || tool === "comments") && window.innerWidth <= 768 && STATE.sidePanelMinimized) {
      const isPhoto = tool === "photos";
      hud.style.display = "flex";
      hud.innerHTML = `
        <span class="gs-mobile-hud-label">${
          isPhoto
            ? tr("📷 光達照片：點擊 3D 模型查詢實景照片", "📷 Photos: Tap 3D model to inspect photo")
            : tr("💬 空間標註：點擊 3D 模型放置標註點", "💬 Comments: Tap 3D model to place pin")
        }</span>
        <button type="button" class="gs-mobile-hud-btn" data-mobile-hud="expand_cat_panel">${tr("▴ 展開面板", "▴ Panel")}</button>
      `;
    } else if (tool === "categorize" && STATE.categorizeEditMode) {
      const mode = STATE.categorizeEditMode;
      const catPts = Array.isArray(STATE.categorizeEditPoints) ? STATE.categorizeEditPoints.length : 0;
      const modeText =
        mode === "add_tree"
          ? tr("🟢 點擊 3D 樹木新增", "🟢 Tap 3D tree to add")
          : mode === "add_wall"
          ? tr(`🔴 點擊牆面起終點 (${catPts}/2)`, `🔴 Tap wall endpoints (${catPts}/2)`)
          : mode === "add_road"
          ? tr(`🟠 點擊道路頂點 (${catPts}點)`, `🟠 Tap road vertices (${catPts})`)
          : tr("🗑️ 點擊 3D 物件刪除", "🗑️ Tap 3D item to remove");
      hud.style.display = "flex";
      hud.innerHTML = `
        <span class="gs-mobile-hud-label">${modeText}</span>
        ${
          (mode === "add_road" && catPts >= 3) || (mode === "add_wall" && catPts >= 2)
            ? `<button type="button" class="gs-mobile-hud-btn primary" data-mobile-hud="lock_poly">✓ ${tr("完成新增", "Finish")}</button>`
            : ""
        }
        ${
          catPts > 0
            ? `<button type="button" class="gs-mobile-hud-btn" data-mobile-hud="undo_cat_pt">↩ ${tr("復原點", "Undo")}</button>`
            : ""
        }
        <button type="button" class="gs-mobile-hud-btn" data-mobile-hud="expand_cat_panel">${
          STATE.sidePanelMinimized ? tr("▴ 面板", "▴ Panel") : tr("▾ 收合", "▾ Hide")
        }</button>
        <button type="button" class="gs-mobile-hud-btn danger" data-mobile-hud="exit_cat_edit">✕ ${tr("結束編輯", "Exit Edit")}</button>
      `;
    } else {
      hud.style.display = "none";
      return;
    }

    hud.querySelector('[data-mobile-hud="toggle_lasso_orbit"]')?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      STATE.studioLassoOrbitMode = !STATE.studioLassoOrbitMode;
      syncStudioControlsForTool();
      syncStudioMobileToolHud();
      showToast(
        STATE.studioLassoOrbitMode
          ? tr("🔄 已切換為單指旋轉視角", "🔄 Switched to 1-Finger Orbit Mode")
          : tr("✏️ 已切換為單指套索標記", "✏️ Switched to 1-Finger Lasso Draw Mode")
      );
    });
    hud.querySelector('[data-mobile-hud="lock_poly"]')?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      finalizeActiveMobilePolygon();
    });
    hud.querySelector('[data-mobile-hud="commit_lasso"]')?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const mode = STATE.activeTool === "crop" ? "keep_inside" : "delete_inside";
      const res = commitPendingLassoMarksToStagedEdits(mode);
      if (res.committed > 0) {
        showToast(
          mode === "keep_inside"
            ? tr(`已套用保留範圍（${res.committed} 區）— 點擊儲存變更建立新掃描`, `Applied keep region (${res.committed}) — click Save Edits to generate`)
            : tr(`已刪除選取範圍（${res.committed} 區）— 點擊儲存變更建立新掃描`, `Deleted ${res.committed} region(s) — click Save Edits to generate`)
        );
        if (mode === "keep_inside") openLassoKeepInspector({ armLasso: true });
        else openLassoDeleteInspector({ armLasso: true });
      }
      syncStudioMobileToolHud();
    });
    hud.querySelector('[data-mobile-hud="undo_lasso"]')?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (Array.isArray(STATE.measurePoints) && STATE.measurePoints.length > 0) {
        STATE.measurePoints.pop();
        drawAllCropPolygons3D(STATE.activeTool === "crop_delete");
      } else if (Array.isArray(STATE.lassoStrokes) && STATE.lassoStrokes.length > 0) {
        STATE.lassoStrokes.pop();
        rebuildLassoHighlight3D();
      } else if (Array.isArray(STATE.pendingCropPolygons) && STATE.pendingCropPolygons.length > 0) {
        STATE.pendingCropPolygons.pop();
        drawAllCropPolygons3D(STATE.activeTool === "crop_delete");
        rebuildLassoHighlight3D();
      }
      syncStudioMobileToolHud();
    });
    hud.querySelector('[data-mobile-hud="exit_tool"]')?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      cancelLassoToolMode(true, false);
      syncStudioMobileToolHud();
    });
    hud.querySelector('[data-mobile-hud="undo_pt"]')?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (Array.isArray(STATE.measurePoints) && STATE.measurePoints.length > 0) {
        STATE.measurePoints.pop();
        clearTempDistanceVisuals();
        if (STATE.activeTool === "area") {
          clearAreaVisualsOnly();
          const pts = STATE.measurePoints.slice();
          const addAreaObj = (m) => {
            m.userData.isAreaVisual = true;
            studioThree.overlayGroup.add(m);
          };
          pts.forEach((p, idx) => add3DPinMarker(p, idx === 0 ? 0xff3b30 : 0x0284c7, studioThree.overlayGroup, addAreaObj));
          if (pts.length >= 2) {
            const lineGeom = new THREE.BufferGeometry().setFromPoints(pts);
            const lineMesh = new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color: 0x0284c7, depthTest: false }));
            addAreaObj(lineMesh);
          }
        } else if (STATE.activeTool === "volume") {
          drawPlacedCutFillPolygon3D(STATE.measurePoints.slice(), null);
        }
      }
      syncStudioMobileToolHud();
    });
    hud.querySelector('[data-mobile-hud="clear_pts"]')?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      STATE.measurePoints = [];
      clearTempDistanceVisuals();
      if (studioThree && studioThree.polyPreviewGroup) {
        while (studioThree.polyPreviewGroup.children.length > 0) {
          studioThree.polyPreviewGroup.remove(studioThree.polyPreviewGroup.children[0]);
        }
      }
      if (STATE.activeTool === "area") clearAreaVisualsOnly();
      if (STATE.activeTool === "volume" && !STATE.polygonLocked) clearVolumeVisualsOnly();
      syncStudioMobileToolHud();
    });
    hud.querySelector('[data-mobile-hud="undo_cat_pt"]')?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (Array.isArray(STATE.categorizeEditPoints) && STATE.categorizeEditPoints.length > 0) {
        STATE.categorizeEditPoints.pop();
        clearTempDistanceVisuals();
        const pts = STATE.categorizeEditPoints.map((x) => x.pt);
        pts.forEach((p, idx) => {
          add3DPinMarker(p, idx === 0 ? 0xff3b30 : 0xf59e0b, studioThree.overlayGroup, (m) => {
            m.userData.isTempDistance = true;
            studioThree.overlayGroup.add(m);
          });
        });
        if (pts.length >= 2) {
          const loopPts = pts.length >= 3 ? [...pts, pts[0]] : pts;
          const lGeo = new THREE.BufferGeometry().setFromPoints(loopPts);
          const lMesh = new THREE.Line(lGeo, new THREE.LineBasicMaterial({ color: 0xf59e0b, depthTest: false }));
          lMesh.userData.isTempDistance = true;
          studioThree.overlayGroup.add(lMesh);
        }
        if (STATE.lastCategorizeResult) renderCategorizePanelContent(STATE.lastCategorizeResult);
      }
      syncStudioMobileToolHud();
    });
    hud.querySelector('[data-mobile-hud="expand_cat_panel"]')?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const panel = document.getElementById("studioSidePanel");
      if (panel) {
        STATE.sidePanelMinimized = !STATE.sidePanelMinimized;
        panel.classList.remove("hidden");
        panel.classList.add("active", "open");
        panel.classList.toggle("mobile-minimized", STATE.sidePanelMinimized);
        panel.classList.toggle("gs-panel-minimized", STATE.sidePanelMinimized);
        const lblCollapse = document.getElementById("lblCollapseSidePanel");
        if (lblCollapse) lblCollapse.textContent = STATE.sidePanelMinimized ? "▴ 展開" : "▾ 收合";
        syncStudioMobileToolHud();
        if (typeof syncMobileToastPosition === "function") syncMobileToastPosition();
        update2DBadgePositions();
      }
    });
    hud.querySelector('[data-mobile-hud="exit_cat_edit"]')?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      STATE.categorizeEditMode = null;
      STATE.categorizeEditPoints = [];
      clearTempDistanceVisuals();
      const panel = document.getElementById("studioSidePanel");
      if (panel) {
        STATE.sidePanelMinimized = false;
        panel.classList.remove("mobile-minimized", "gs-panel-minimized");
        const lblCollapse = document.getElementById("lblCollapseSidePanel");
        if (lblCollapse) lblCollapse.textContent = "▾ 收合";
      }
      if (STATE.lastCategorizeResult) renderCategorizePanelContent(STATE.lastCategorizeResult);
      syncStudioMobileToolHud();
      update2DBadgePositions();
    });
  }

  // 3A. Cut/Fill & Material Stockpile Report Generator
  async function openCutFillVolumeInspector(customPts = null) {
    setActiveStudioTool("volume");
    if (customPts && customPts.length >= 3) {
      STATE.cutFillPolygonPoints = customPts.map((p) => p.clone());
      STATE.polygonLocked = true;
    }
    const resolveLockedVolumePts = () => {
      if (customPts && customPts.length >= 3) {
        return customPts.slice();
      }
      if (STATE.polygonLocked && STATE.cutFillPolygonPoints && STATE.cutFillPolygonPoints.length >= 3) {
        return STATE.cutFillPolygonPoints.slice();
      }
      return [];
    };

    const hasLockedPoly = resolveLockedVolumePts().length >= 3;
    if (window.innerWidth <= 768) {
      STATE.sidePanelMinimized = !hasLockedPoly;
      const pEl = document.getElementById("studioSidePanel");
      if (pEl) {
        pEl.classList.toggle("mobile-minimized", STATE.sidePanelMinimized);
        pEl.classList.toggle("gs-panel-minimized", STATE.sidePanelMinimized);
      }
      const lblCol = document.getElementById("lblCollapseSidePanel");
      if (lblCol) lblCol.textContent = STATE.sidePanelMinimized ? tr("▴ 展開", "▴ Expand") : tr("▾ 收合", "▾ Collapse");
    }

    const activeScan = STATE.activeScan || STATE.scans.find((s) => s.scan_id === STATE.activeScanId) || {};
    const defaultZoneName = `${activeScan.name || STATE.activeScanId || "Site"} — Earthwork / Stockpile Zone A`;
    const candidatePts =
      resolveLockedVolumePts().length >= 3
        ? resolveLockedVolumePts()
        : STATE.measurePoints?.length
        ? STATE.measurePoints
        : [];
    const meanPtY =
      candidatePts.length > 0
        ? candidatePts.reduce((acc, p) => acc + (p.y || 0), 0) / candidatePts.length
        : 0;
    const defaultDatumZ = Number((Number(localToTwd97({ x: 0, y: meanPtY, z: 0 }).h || 0)).toFixed(2));

    const panel = document.getElementById("studioSidePanel");
    const alreadyOpenForVolume = panel?.classList.contains("active") && document.getElementById("volStockpileName");

    if (!alreadyOpenForVolume) {
      const stagedNoticeHtml = hasStagedMeshEditsForActiveScan()
        ? `<div style="font-size:11px;color:#fbbf24;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.35);border-radius:7px;padding:7px 9px;margin-bottom:9px;line-height:1.4;">
             ⚠️ <b>Staged Mesh Edits Active:</b> Live 3D volume uses your edited mesh preview, while server DSM archival/epoch-diff uses the committed scan on disk until you run <b>Generate Edited Scan</b>.
           </div>`
        : "";
      const matNameByKey = {
        crushed_stone: tr("碎石級配", "Crushed Stone"),
        excavated_soil: tr("一般營建土方", "Excavated Soil"),
        sand_gravel: tr("砂石骨材", "River Sand & Gravel"),
        rockfill_rip_rap: tr("塊石與拋石", "Quarry Rockfill"),
        concrete_debris: tr("營建剩餘混凝土", "Demolition Concrete"),
      };
      const matOptions = Object.entries(STATE.materials || {
        crushed_stone: { name: "Crushed Stone / 碎石級配", density_t_m3: 1.65 },
        excavated_soil: { name: "Excavated Soil / 一般營建土方", density_t_m3: 1.45 },
        sand_gravel: { name: "River Sand & Gravel / 砂石骨材", density_t_m3: 1.75 },
        rockfill_rip_rap: { name: "Quarry Rockfill / 塊石與拋石", density_t_m3: 1.85 },
        concrete_debris: { name: "Demolition Concrete / 營建剩餘混凝土", density_t_m3: 1.55 },
      })
        .map(([k, v]) => {
          let label = matNameByKey[k];
          if (!label) {
            const parts = String(v.name || k).split("/").map((p) => p.trim());
            label = window.getAppLanguage?.() === "en" ? parts[0] : parts[parts.length - 1] || parts[0];
          }
          return `<option value="${escapeHtml(k)}" data-density="${escapeHtml(String(v.density_t_m3))}">${escapeHtml(label)} · ${escapeHtml(String(v.density_t_m3))} t/m³</option>`;
        })
        .join("");

      showSidePanel(
        `<span>${tr("土方體積與挖填分析", "Cut/Fill & Stockpile Volume")}</span>`,
        `
        ${stagedNoticeHtml}
        <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:7px;padding:7px 9px;margin-bottom:9px;line-height:1.4;">
          ${tr(
            "步驟 1：在 3D 掃描模型上點擊 <b>3 個以上頂點</b>繪製挖填範圍。<br>步驟 2：點擊紅色起點 <b>V1</b>（或按 <b>Enter</b> / <b>鎖定並計算</b>）完成多邊形並計算土方。",
            "Step 1: Click <b>3+ points</b> on the 3D scan to draw a Cut/Fill boundary polygon.<br>Step 2: Click red start point <b>V1</b> (or press <b>Enter</b> / <b>Lock &amp; Compute</b>) to lock the polygon and calculate volume."
          )}
        </div>
        <div class="gs-form-group">
          <label>${tr("土方或物料堆名稱", "Zone / Stockpile Name")}</label>
          <input type="text" class="gs-input" id="volStockpileName" value="${escapeHtml(defaultZoneName)}" />
        </div>
        <div class="gs-form-group">
          <label>${tr("基準面計算方式", "Base Reference Surface Mode")}</label>
          <select class="gs-select" id="volBaseMode">
            <option value="triangulated_boundary">${tr("1. 獨立土石堆周界擬合面", "1. Triangulated Boundary Perimeter")}</option>
            <option value="custom_plane">${tr("2. 指定設計高程基準面 Z₀ (TWVD2001)", "2. Custom Datum Elevation Plane Z₀ (TWVD2001)")}</option>
            <option value="epoch_diff">${tr("3. 跨期掃描進度挖填差額", "3. Multi-Date Epoch-to-Epoch Diff")}</option>
          </select>
        </div>
        <div class="gs-form-group">
          <label>${tr("物料種類與比重 (t/m³)", "Material Classification & Bulk Density (t/m³)")}</label>
          <select class="gs-select" id="volMaterialSelect">${matOptions}</select>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;" class="gs-form-group">
          <div>
            <label>${tr("比重 (t/m³)", "Density (t/m³)")}</label>
            <input type="number" step="0.05" class="gs-input" id="volCustomDensity" value="1.65" />
          </div>
          <div>
            <label>${tr("基準高程 Z₀ (TWVD2001 m)", "Datum Elev Z₀ (TWVD2001 m)")}</label>
            <input type="number" step="0.1" class="gs-input" id="volDatumZ" value="${defaultDatumZ}" />
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-bottom:8px;">
          <button type="button" class="gs-top-btn accent" style="flex:1.6;justify-content:center;" id="btnRunVolumeCalc" title="${tr("鎖定多邊形並計算挖填土方體積", "Lock Polygon & Compute Cut/Fill Volume")}">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M3 18L9 8l5 6 4-4 3 8H3z"/>
            </svg>
            <span id="lblRunVolumeCalc">${tr("鎖定並計算", "Lock & Compute")}</span>
          </button>
          <button type="button" class="gs-top-btn" style="flex:1;justify-content:center;" id="btnResetVolumePoly" title="${tr("清除並重新繪製範圍多邊形", "Clear & Draw New Boundary Polygon")}">
            <span>${tr("重新繪製多邊形", "Redraw Polygon")}</span>
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
          if (STATE.polygonLocked && STATE.cutFillPolygonPoints?.length >= 3) {
            runCalc();
          }
        });
      }
      const datumInput = document.getElementById("volDatumZ");
      const modeSel = document.getElementById("volBaseMode");
      if (datumInput && modeSel) {
        datumInput.addEventListener("input", () => {
          if (modeSel.value === "triangulated_boundary") {
            modeSel.value = "custom_plane";
          }
        });
        datumInput.addEventListener("change", () => {
          if (STATE.polygonLocked && STATE.cutFillPolygonPoints?.length >= 3) runCalc();
        });
        modeSel.addEventListener("change", () => {
          if (STATE.polygonLocked && STATE.cutFillPolygonPoints?.length >= 3) runCalc();
        });
      }
      document.getElementById("btnResetVolumePoly")?.addEventListener("click", () => {
        setActiveStudioTool("volume");
        STATE.polygonLocked = false;
        STATE.measurePoints = [];
        STATE.cutFillPolygonPoints = [];
        STATE.maskBoundaryPoints = [];
        STATE.lastVolumeResult = null;
        clearVolumeVisualsOnly();
        renderUnlockedVolumePrompt();
        if (window.innerWidth <= 768) {
          STATE.sidePanelMinimized = true;
          const pEl = document.getElementById("studioSidePanel");
          pEl?.classList.add("mobile-minimized", "gs-panel-minimized");
          const lblCol = document.getElementById("lblCollapseSidePanel");
          if (lblCol) lblCol.textContent = "▴ 展開";
        }
        syncStudioMobileToolHud();
        showToast("Click 3+ points on the 3D scan and close on V1 to draw a new Cut/Fill polygon");
      });
    }

    function renderUnlockedVolumePrompt() {
      const box = document.getElementById("volResultContainer");
      if (!box) return;
      const placedCount = STATE.measurePoints?.length || 0;
      const btnLbl = document.getElementById("lblRunVolumeCalc");
      if (btnLbl) {
        btnLbl.textContent =
          placedCount >= 3
            ? tr(`鎖定 (${placedCount} 點) 並計算`, `Lock (${placedCount} pts) & Compute`)
            : tr("鎖定並計算", "Lock & Compute");
      }
      if (placedCount === 0) {
        box.innerHTML = `
          <div style="font-size:11.5px;color:var(--ui-text-secondary);padding:10px;background:var(--ui-bg-subtle);border-radius:8px;border:1px dashed var(--ui-border-strong);line-height:1.5;">
            <b style="color:var(--ui-accent);">${tr("尚未繪製範圍多邊形", "Awaiting Boundary Polygon")}</b><br>
            ${tr(
              "請在 3D 掃描模型上的土石堆或開挖區周圍點擊至少 <b>3 個頂點</b>，接著點擊紅色起點 <b>V1</b>（或按 <b>Enter</b>）以鎖定多邊形並計算土方體積。",
              "Click at least <b>3 points</b> around a stockpile or excavation zone on the 3D scan, then click the red start point <b>V1</b> (or press <b>Enter</b>) to lock the polygon and calculate volume."
            )}
          </div>
        `;
      } else if (placedCount < 3) {
        box.innerHTML = `
          <div style="font-size:11.5px;color:var(--ui-text-primary);padding:10px;background:var(--ui-bg-subtle);border-radius:8px;border:1px solid var(--ui-accent);line-height:1.5;">
            <b>${tr(`繪製多邊形中：已放置 ${placedCount} / 3+ 個頂點`, `Drawing Polygon: ${placedCount} / 3+ vertices placed`)}</b><br>
            ${tr(
              `請在 3D 掃描模型上再點擊 <b>${3 - placedCount} 個頂點</b>以形成有效範圍。`,
              `Click <b>${3 - placedCount} more point${3 - placedCount === 1 ? "" : "s"}</b> on the 3D scan to form a valid boundary.`
            )}
          </div>
        `;
      } else {
        box.innerHTML = `
          <div style="font-size:11.5px;color:var(--ui-text-primary);padding:10px;background:var(--ui-accent-soft);border-radius:8px;border:1px solid var(--ui-accent);line-height:1.5;">
            <b style="color:var(--ui-accent);">${tr(`可鎖定計算：已放置 ${placedCount} 個頂點`, `Ready to Lock: ${placedCount} vertices placed`)}</b><br>
            ${tr(
              `點擊 3D 畫面上的紅色起點 <b>V1</b>、按 <b>Enter</b>，或點擊上方 <b>鎖定 (${placedCount} 點) 並計算</b> 以計算土方體積。`,
              `Click the red start point <b>V1</b> on the 3D scan, press <b>Enter</b>, or click <b>Lock (${placedCount} pts) &amp; Compute</b> above to calculate earthwork volume.`
            )}
          </div>
        `;
      }
    }

    async function runCalc(ptsOverride = null) {
      let ptsToUse =
        ptsOverride && ptsOverride.length >= 3
          ? ptsOverride
          : resolveLockedVolumePts();

      // If the user placed 3+ vertices and clicked "Lock & Compute", lock those vertices now
      if ((!ptsToUse || ptsToUse.length < 3) && STATE.measurePoints && STATE.measurePoints.length >= 3) {
        if (studioThree && studioThree.polyPreviewGroup) {
          while (studioThree.polyPreviewGroup.children.length > 0) {
            studioThree.polyPreviewGroup.remove(studioThree.polyPreviewGroup.children[0]);
          }
        }
        ptsToUse = STATE.measurePoints.map((p) => p.clone());
        STATE.cutFillPolygonPoints = ptsToUse;
        STATE.maskBoundaryPoints = ptsToUse.map((p) => p.clone());
        STATE.measurePoints = [];
        STATE.polygonLocked = true;
      }

      if (!ptsToUse || ptsToUse.length < 3) {
        renderUnlockedVolumePrompt();
        showToast("Please click at least 3 points on the 3D scan and lock the polygon first.");
        return;
      }

      if (window.innerWidth <= 768) {
        STATE.sidePanelMinimized = false;
        const pEl = document.getElementById("studioSidePanel");
        pEl?.classList.remove("mobile-minimized", "gs-panel-minimized");
        const lblCol = document.getElementById("lblCollapseSidePanel");
        if (lblCol) lblCol.textContent = "▾ 收合";
      }

      const btnLbl = document.getElementById("lblRunVolumeCalc");
      if (btnLbl) btnLbl.textContent = "Computing...";

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

      // 2. Also query backend DSM engine for multi-epoch comparison & server archival (only once polygon is locked)
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
            mergedRes = {
              ...srvRes,
              ...clientRes,
              _resolvedPtsLocal: ptsToUse,
            };
          } else {
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
        if (btnLbl) btnLbl.textContent = "Recompute";
      }
    }

    const btnCalc = document.getElementById("btnRunVolumeCalc");
    if (btnCalc) {
      btnCalc.onclick = () => {
        runCalc().then(() => {
          const r = STATE.lastVolumeResult;
          if (r && STATE.polygonLocked) {
            showToast(
              `Computed: Fill +${r.fill_volume_m3} m³ · Cut -${r.cut_volume_m3} m³ · Mass ${r.estimated_tonnage_t} t`
            );
          }
        });
      };
    }

    const lockedPts = resolveLockedVolumePts();
    if (lockedPts.length >= 3) {
      await runCalc(lockedPts);
    } else {
      renderUnlockedVolumePrompt();
    }
  }

  function renderVolumeResultAnd3D(res, customPts = null) {
    const box = document.getElementById("volResultContainer");
    if (box) {
      const safeHtmlUrl = escapeHtml(res.report_html_url || "#");
      const safeCsvUrl = escapeHtml(res.report_csv_url || "#");
      box.innerHTML = `
        <div class="gs-metric-grid">
          <div class="gs-metric-box">
            <div class="lbl">${tr("填方體積 (+)", "Fill Volume (+)")}</div>
            <div class="val" style="color:var(--ui-accent);">+${escapeHtml(String(res.fill_volume_m3))} m³</div>
          </div>
          <div class="gs-metric-box">
            <div class="lbl">${tr("挖方體積 (-)", "Cut Volume (-)")}</div>
            <div class="val" style="color:#ef4444;">-${escapeHtml(String(res.cut_volume_m3))} m³</div>
          </div>
          <div class="gs-metric-box">
            <div class="lbl">${tr("淨土方量", "Net Volume")}</div>
            <div class="val">${Number(res.net_volume_m3) >= 0 ? "+" : ""}${escapeHtml(String(res.net_volume_m3))} m³</div>
          </div>
          <div class="gs-metric-box">
            <div class="lbl">${tr("預估總重", "Estimated Mass")}</div>
            <div class="val">${escapeHtml(String(res.estimated_tonnage_t))} t</div>
          </div>
        </div>
        <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-subtle);padding:9px 10px;border-radius:8px;border:1px solid var(--ui-border);margin-bottom:10px;line-height:1.5;">
          <div><b>${tr("水平投影面積：", "Footprint Area:")}</b> ${escapeHtml(String(res.planar_area_m2))} m² (${escapeHtml(String(res.planar_area_ping))} 坪) · <b>${tr("頂點數：", "Vertices:")}</b> ${(res.boundary_twd97 || []).length}</div>
          <div><b>${tr("3D 表面積：", "Sloped Area:")}</b> ${escapeHtml(String(res.surface_area_m2))} m² · <b>${tr("周長：", "Perim:")}</b> ${escapeHtml(String(res.perimeter_m))} m</div>
          <div><b>${tr("基準面：", "Base Surface:")}</b> ${
            res.base_mode === "custom_plane"
              ? `${tr("自訂高程基準 Z₀", "Custom Datum Z₀")} (+${escapeHtml(String(res.datum_elevation_m))} m)`
              : res.base_mode === "epoch_diff"
              ? tr("跨期掃描比對", "Multi-Date Epoch Diff")
              : `${tr("周界擬合面", "Perimeter Fit")} (Mean +${escapeHtml(String(res.perim_mean_h_m ?? res.datum_elevation_m))} m)`
          }</div>
          <div><b>${tr("物料：", "Material:")}</b> ${escapeHtml(String(res.material_name || ""))} (${escapeHtml(String(res.density_t_m3))} t/m³ · ${tr("實方重：", "Bank:")} ${escapeHtml(String(res.bank_tonnage_t ?? res.estimated_tonnage_t))} t)</div>
        </div>
        <div style="display:flex;gap:6px;">
          <a class="btn-xs primary" style="flex:1;justify-content:center;" href="${safeHtmlUrl}" target="_blank" rel="noopener noreferrer" title="${tr("開啟可列印土方報告 (PDF/HTML)", "Open Printable Stockpile Report (PDF/HTML)")}">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            </svg>
            <span>${tr("土方報告", "Report")}</span>
          </a>
          <a class="btn-xs" style="flex:1;justify-content:center;" href="${safeCsvUrl}" download="stockpile_volume_report.csv" title="${tr("匯出 Excel (.CSV)", "Export Excel (.CSV)")}">
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
  async function openContoursInspector(lockedPts = null) {
    setActiveStudioTool("contours");
    const hasLockedPolygon =
      (Array.isArray(lockedPts) && lockedPts.length >= 3) ||
      Boolean(STATE.polygonLocked && Array.isArray(STATE.maskBoundaryPoints) && STATE.maskBoundaryPoints.length >= 3);
    if (window.innerWidth <= 768) {
      STATE.sidePanelMinimized = !hasLockedPolygon;
    } else if (!STATE.measurePoints || STATE.measurePoints.length === 0) {
      STATE.sidePanelMinimized = false;
    }
    const activeScan = STATE.activeScan || STATE.scans.find((s) => s.scan_id === STATE.activeScanId) || {};
    const defaultTitle = `${activeScan.name || STATE.activeScanId} — Topographic Survey`;
    const maskPts =
      Array.isArray(lockedPts) && lockedPts.length >= 3
        ? lockedPts
        : STATE.maskBoundaryPoints && STATE.maskBoundaryPoints.length >= 3
        ? STATE.maskBoundaryPoints
        : [];

    const panel = document.getElementById("studioSidePanel");
    const alreadyOpenForContours = panel?.classList.contains("active") && document.getElementById("cntDrawingTitle");

    if (!alreadyOpenForContours) {
      const stagedContoursNotice = hasStagedMeshEditsForActiveScan()
        ? `<div style="font-size:11px;color:#fbbf24;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.35);border-radius:7px;padding:7px 9px;margin-bottom:9px;line-height:1.4;">
             ⚠️ ${tr("<b>待儲存網格修改進行中：</b>伺服器端 <code>.DXF</code> 與 A3 PDF 等高線會讀取磁碟上已儲存的模型。若需將暫存刪除套用至測量報告，請先執行<b>儲存變更</b>。", "<b>Staged Mesh Edits Active:</b> Server-side <code>.DXF</code> &amp; A3 PDF contours read committed scan geometry on disk. Run <b>Save Edits</b> first if you want staged deletions baked into the survey report.")}
           </div>`
        : "";
      showSidePanel(
        `<span>${tr("測量圖資報表 · Civil3D.dwg & A3 PDF", "Survey Report · Civil3D.dwg & A3 PDF")}</span>`,
        `
        ${stagedContoursNotice}
        <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:7px;padding:7px 9px;margin-bottom:9px;line-height:1.45;">
          ${tr(
            `使用目前之<b>邊界遮罩</b>與<b>等高線</b>自動產製 <code>Civil3D.dwg</code>（真實 <b>${escapeHtml(getScanCrsDisplayLabel(activeScan))}</b> 座標）與 <b>A3 標準工程圖框報告 PDF</b>。可在掃描上點擊 3+ 點自訂遮罩範圍。`,
            `Uses your active <b>Mask Boundary</b> &amp; <b>Contour Lines</b> to generate <code>Civil3D.dwg</code> (real <b>${escapeHtml(getScanCrsDisplayLabel(activeScan))}</b>) and a zoom-to-fit <b>A3 Ready-to-Print PDF</b> with filled engineering frame. Click 3+ points on the scan to customize the mask boundary.`
          )}
        </div>
        <div class="gs-form-group">
          <label>${tr("圖名 / 掃描專案名稱", "Engineering Frame Title")}</label>
          <input type="text" class="gs-input" id="cntDrawingTitle" value="${escapeHtml(defaultTitle)}" />
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;" class="gs-form-group">
          <div>
            <label>${tr("次等高線間距 (m)", "Minor Interval (m)")}</label>
            <select class="gs-select" id="cntMinorStep">
              <option value="0.25">0.25 m</option>
              <option value="0.5" selected>0.50 m</option>
              <option value="1.0">1.00 m</option>
              <option value="2.0">2.00 m</option>
            </select>
          </div>
          <div>
            <label>${tr("計曲線間距 (m)", "Major Interval (m)")}</label>
            <select class="gs-select" id="cntMajorStep">
              <option value="1.0">1.00 m</option>
              <option value="2.5" selected>2.50 m</option>
              <option value="5.0">5.00 m</option>
            </select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;" class="gs-form-group">
          <div>
            <label>${tr("測量工程師", "Surveyor")}</label>
            <input type="text" class="gs-input" id="cntEngineerName" value="${escapeHtml(STATE.currentUser?.name || "雲在天")}" />
          </div>
          <div>
            <label>${tr("邊界遮罩", "Mask Boundary")}</label>
            <div style="display:flex;gap:4px;">
              <button type="button" class="btn-xs" style="flex:1;justify-content:center;" id="btnDrawCustomMask" title="${tr("在 3D 掃描上點擊 3+ 點定義自訂遮罩邊界", "Click 3+ points on 3D scan to define custom mask boundary")}">${tr("繪製", "Draw")}</button>
              <button type="button" class="btn-xs" style="flex:1;justify-content:center;" id="btnResetCustomMask" title="${tr("重設為預設掃描邊界", "Reset to default scan footprint boundary")}">${tr("重設", "Reset")}</button>
            </div>
          </div>
        </div>
        <div class="gs-form-group" style="margin-bottom:8px;">
          <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;font-weight:600;color:var(--ui-text-primary);">
            <input type="checkbox" id="chkBareEarthContours" checked />
            <span>${tr("濾除樹木與建物之純地形等高線", "Bare-Earth DTM Contours")}</span>
          </label>
        </div>
        <button type="button" class="gs-top-btn accent" style="width:100%;justify-content:center;margin-bottom:8px;" id="btnGenerateContours" title="${tr("產製 AutoCAD / Civil 3D (.DXF) 與 A3 標準圖框工程報告 PDF", "Generate .DXF (AutoCAD / Civil 3D) & A3 Ready-to-Print PDF Survey Report")}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          </svg>
          <span>${tr("產製測量圖資報表 (.DXF + A3 PDF)", "Create Survey Report (.DXF + A3 PDF)")}</span>
        </button>
        <div id="cntResultContainer"></div>
        `
      );

      document.getElementById("btnDrawCustomMask")?.addEventListener("click", () => {
        setActiveStudioTool("contours");
        STATE.measurePoints = [];
        if (window.innerWidth <= 768) {
          STATE.sidePanelMinimized = true;
          const pEl = document.getElementById("studioSidePanel");
          pEl?.classList.add("mobile-minimized", "gs-panel-minimized");
          const lblCol = document.getElementById("lblCollapseSidePanel");
          if (lblCol) lblCol.textContent = tr("▴ 展開", "▴ Expand");
        }
        syncStudioMobileToolHud();
        showToast(tr("請在 3D 掃描上點擊 3+ 點繪製自訂遮罩邊界", "Click 3+ points on the 3D scan to draw a custom Mask Boundary"));
      });

      document.getElementById("btnResetCustomMask")?.addEventListener("click", () => {
        STATE.maskBoundaryPoints = [];
        STATE.measurePoints = [];
        runContours();
        showToast(tr("已重設為預設掃描邊界遮罩", "Reset to default scan survey mask boundary"));
      });
    }

    const runContours = async () => {
      const minor = parseFloat(document.getElementById("cntMinorStep")?.value || "0.5");
      const major = parseFloat(document.getElementById("cntMajorStep")?.value || "2.5");
      const drawingTitle = document.getElementById("cntDrawingTitle")?.value || defaultTitle;
      const engineerName = document.getElementById("cntEngineerName")?.value || "雲在天";
      const bareEarthDtm = document.getElementById("chkBareEarthContours")
        ? Boolean(document.getElementById("chkBareEarthContours").checked)
        : true;

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
          bare_earth_dtm: bareEarthDtm,
        });
        STATE.lastContoursResult = res;
        renderContours3DAndPanel(res);
      } catch (err) {
        showToast(`Survey Report Error: ${err.message}`);
      }
    };

    const btnGen = document.getElementById("btnGenerateContours");
    if (btnGen) btnGen.onclick = runContours;
    if (hasLockedPolygon) {
      await runContours();
    } else {
      const cntBox = document.getElementById("cntResultContainer");
      if (cntBox) {
        cntBox.innerHTML = `<div style="font-size:11.5px;color:var(--ui-text-secondary);background:var(--ui-bg-subtle);border:1px dashed var(--ui-border-strong);border-radius:8px;padding:10px 12px;text-align:center;line-height:1.45;">
          📐 ${tr(
            "請在 3D 掃描模型上依序點擊 <b>3 個以上頂點</b> 並點擊紅色起點 <b>V1</b> 閉合範圍以產生等高線（或直接點擊上方按鈕產製全區報告）。",
            "Click <b>3+ points</b> on the 3D scan and close on red start vertex <b>V1</b> to generate contours (or click Create Survey Report above)."
          )}
        </div>`;
      }
    }
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
    ctx.fillText(String(res.project_group || "Unassigned Site").slice(0, 18), tbX + 4, banY + 29);
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
            <span>${tr("A3 工程圖紙預覽 · 420×297mm", "A3 ENGINEERING SHEET PREVIEW · 420×297mm")}</span>
            <span style="color:var(--ui-accent);">${tr("比例尺", "SCALE")} 1:${res.scale_denom || 250}</span>
          </div>
          <canvas id="a3SheetPreviewCanvas" width="336" height="210" style="width:100%;background:#ffffff;border:1px solid var(--ui-border-strong);border-radius:7px;box-shadow:0 1px 3px rgba(15,23,42,0.06);"></canvas>
        </div>
        <div class="gs-metric-grid">
          <div class="gs-metric-box">
            <div class="lbl">${tr("裁切等高線", "Clipped Contours")}</div>
            <div class="val" style="color:var(--ui-accent);">${res.contour_count} ${tr("條", "lines")}</div>
          </div>
          <div class="gs-metric-box">
            <div class="lbl">${tr("A3 圖紙比例尺", "A3 Fit Scale")}</div>
            <div class="val">1:${res.scale_denom || 250}</div>
          </div>
          <div class="gs-metric-box">
            <div class="lbl">${tr("遮罩面積", "Mask Area")}</div>
            <div class="val">${res.planar_area_m2 || 0} m²</div>
          </div>
          <div class="gs-metric-box">
            <div class="lbl">${tr("TWVD2001 高程", "TWVD2001 Elev")}</div>
            <div class="val">+${res.elevation_range_m[0]}~+${res.elevation_range_m[1]}m</div>
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-top:8px;">
          <a class="btn-xs primary" style="flex:1.4;justify-content:center;" href="${escapeHtml(appendAuthToDownloadUrl(res.dxf_url || res.civil3d_dxf_url || res.civil3d_dwg_url || res.dwg_url))}" download="Civil3D.dxf" title="${tr("下載 .DXF · AutoCAD / Civil 3D 實測 TWD97 XYZ 與 A3 工程圖框", "Download .DXF · AutoCAD / Civil 3D Real TWD97 XYZ + A3 Engineering Frame")}">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span>${tr(".DXF · AutoCAD / Civil 3D", ".DXF · AutoCAD / Civil 3D")}</span>
          </a>
          <a class="btn-xs primary" style="flex:1;justify-content:center;" href="${escapeHtml(appendAuthToDownloadUrl(res.pdf_url))}" target="_blank" title="${tr("開啟可列印 A3 測量報告 PDF", "Open Ready-to-Print A3 Survey Report PDF")}">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            </svg>
            <span>${tr("A3 測量報告 PDF", "A3 PDF")}</span>
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

    showToast(
      tr(
        `測量報告已就緒：.DXF · AutoCAD / Civil 3D + A3 PDF · ${res.contour_count} 條裁切等高線 · 1:${res.scale_denom || 250}`,
        `Survey Report ready: .DXF · AutoCAD / Civil 3D + A3 PDF · ${res.contour_count} clipped contours · 1:${res.scale_denom || 250}`
      )
    );
  }

  // 3B-2. AI + 3D Geometric Surface & Object Categorization (Roads, Trees & 1.3m DBH, Water Voids, Walls, Stockpiles)
  function clearCategorizeVisualsOnly() {
    if (studioThree && studioThree.categoryGroup) {
      while (studioThree.categoryGroup.children.length > 0) {
        const c = studioThree.categoryGroup.children[0];
        if (c.geometry) c.geometry.dispose();
        if (c.material) {
          if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
          else c.material.dispose();
        }
        studioThree.categoryGroup.remove(c);
      }
    }
    STATE.badges2D = STATE.badges2D.filter((b) => {
      if (b.isCategorize) {
        b.el?.remove();
        return false;
      }
      return true;
    });
  }

  function hasSavedCategorizationForActiveScan() {
    const sid = STATE.activeScanId || STATE.activeScan?.scan_id || "";
    if (!sid) return false;
    if (STATE.lastCategorizeResult && STATE.lastCategorizeResult.scan_id === sid && STATE.lastCategorizeResult.status === "ok") {
      return true;
    }
    if (STATE.activeScan && STATE.activeScan.scan_id === sid && STATE.activeScan.has_categorization) {
      return true;
    }
    const catScan = (STATE.scans || []).find((s) => s.scan_id === sid);
    return Boolean(catScan && catScan.has_categorization);
  }

  function syncCategorizeVisibilityUI() {
    const hasSaved = hasSavedCategorizationForActiveScan();
    const vis = Boolean(STATE.categorizeOverlayVisible && hasSaved);
    const lblsVis = STATE.categorizeLabelsVisible !== false;

    const topBtn = document.getElementById("btnStudioToggleCategorizeVis");
    const topLbl = document.getElementById("lblStudioToggleCategorizeVis");
    if (topBtn) {
      topBtn.style.display = hasSaved ? "inline-flex" : "none";
      topBtn.setAttribute("aria-pressed", vis ? "true" : "false");
      topBtn.style.borderColor = vis ? "rgba(16,185,129,0.75)" : "rgba(16,185,129,0.35)";
      topBtn.style.background = vis ? "rgba(16,185,129,0.18)" : "";
      topBtn.style.color = vis ? "#34d399" : "";
    }
    if (topLbl) {
      topLbl.textContent = vis ? tr("👁️ AI 分類: 顯示", "👁️ AI Class: On") : tr("👁️‍🗨️ AI 分類: 隱藏", "👁️‍🗨️ AI Class: Off");
    }

    const topLblBtn = document.getElementById("btnStudioToggleCategorizeLabels");
    const topLblTxt = document.getElementById("lblStudioToggleCategorizeLabels");
    if (topLblBtn) {
      topLblBtn.style.display = hasSaved ? "inline-flex" : "none";
      topLblBtn.setAttribute("aria-pressed", lblsVis ? "true" : "false");
      topLblBtn.style.borderColor = lblsVis ? "rgba(56,189,248,0.75)" : "rgba(148,163,184,0.35)";
      topLblBtn.style.background = lblsVis ? "rgba(56,189,248,0.16)" : "";
      topLblBtn.style.color = lblsVis ? "#38bdf8" : "#94a3b8";
    }
    if (topLblTxt) {
      topLblTxt.textContent = lblsVis ? tr("🏷️ 標籤: 顯示", "🏷️ Labels: On") : tr("🏷️ 標籤: 隱藏", "🏷️ Labels: Off");
    }

    const chkLbls = document.getElementById("chkCategorizeLabelsVis");
    if (chkLbls) {
      chkLbls.checked = lblsVis;
    }

    const dockDot = document.getElementById("lblCategorizeSavedDot");
    if (dockDot) {
      dockDot.style.display = hasSaved ? "block" : "none";
      dockDot.style.background = vis ? "#10b981" : "#38bdf8";
      dockDot.title = vis
        ? tr("AI 分類已儲存於伺服器 · 3D 圖層顯示中", "AI Classification Saved on Server · 3D Overlays Visible")
        : tr("AI 分類已儲存於伺服器 · 預設隱藏", "AI Classification Saved on Server · Hidden by Default");
    }

    const masterChk = document.getElementById("chkCategorizeMasterVis");
    if (masterChk) {
      masterChk.checked = vis;
    }
    const masterBtn = document.getElementById("btnToggleCategorizeOverlayVis");
    if (masterBtn) {
      masterBtn.textContent = vis
        ? tr("👁️ 顯示中 · 點擊隱藏 3D 圖層", "👁️ Visible · Click to Hide 3D Layer")
        : tr("👁️‍🗨️ 預設隱藏 · 點擊顯示 3D 圖層", "👁️‍🗨️ Hidden by Default · Click to Show 3D Layer");
      masterBtn.classList.toggle("primary", vis);
    }
    const masterBadge = document.getElementById("lblCategorizeVisBadge");
    if (masterBadge) {
      masterBadge.textContent = vis ? tr("顯示中", "Visible") : tr("預設隱藏", "Hidden by Default");
      masterBadge.style.background = vis ? "rgba(16,185,129,0.20)" : "rgba(148,163,184,0.18)";
      masterBadge.style.color = vis ? "#34d399" : "#94a3b8";
    }
  }

  function setCategorizeLabelsVisibility(visible, opts = {}) {
    STATE.categorizeLabelsVisible = Boolean(visible);
    update2DBadgePositions();
    syncCategorizeVisibilityUI();
    if (!opts.silent) {
      showToast(
        STATE.categorizeLabelsVisible
          ? tr("🏷️ AI 分類 2D 浮動標籤：顯示中", "🏷️ 2D Classification Labels: Visible")
          : tr("🏷️ AI 分類 2D 浮動標籤：已隱藏", "🏷️ 2D Classification Labels: Hidden")
      );
    }
  }

  async function submitCategorizeManualEdit(action, category, itemId = null, itemData = null) {
    const sid = STATE.activeScanId || STATE.activeScan?.scan_id || STATE.lastCategorizeResult?.scan_id || "";
    if (!sid) {
      showToast(tr("請先選擇掃描檔", "No active scan selected"), "warn");
      return null;
    }
    try {
      const payload = {
        scan_id: sid,
        action,
        category,
        item_id: itemId,
        item: itemData,
      };
      const updated = await apiPost("/api/survey/categorize", payload);
      if (updated && updated.status === "ok") {
        STATE.lastCategorizeResult = updated;
        if (STATE.activeScan && STATE.activeScan.scan_id === sid && updated.summary) {
          STATE.activeScan.categorization_summary = updated.summary;
        }
        if (!STATE.categorizeOverlayVisible) {
          STATE.categorizeOverlayVisible = true;
        }
        renderCategorize3DOverlays(updated);
        syncCategorizeVisibilityUI();
        if (document.getElementById("catResultContainer")) {
          renderCategorizePanelContent(updated);
        }
        if (action === "manual_remove") {
          showToast(
            tr(
              `🗑️ 已刪除分類項目 ${itemId || ""}（已儲存於伺服器）`,
              `🗑️ Removed item ${itemId || ""} (Saved on Server)`
            )
          );
        } else if (action === "manual_add") {
          showToast(
            tr(
              `➕ 已新增分類項目 (${category})（已儲存於伺服器）`,
              `➕ Added item (${category}) (Saved on Server)`
            )
          );
        } else if (action === "manual_reset") {
          showToast(tr("↺ 已還原所有手動新增/刪除變更", "↺ Reset all manual classification edits"));
        }
        return updated;
      }
    } catch (err) {
      showToast(tr(`手動編輯分類失敗: ${err.message || err}`, `Manual classification edit failed: ${err.message || err}`), "error");
    }
    return null;
  }

  async function preloadSavedCategorizationForScan(scanId, scanObj = null, opts = {}) {
    if (!scanId) return null;
    const renderWhenLoaded = Boolean(opts.renderWhenLoaded);
    if (
      STATE.lastCategorizeResult &&
      STATE.lastCategorizeResult.scan_id === scanId &&
      STATE.lastCategorizeResult.status === "ok"
    ) {
      if (STATE.lastCategorizeResult.layer_filters && typeof STATE.lastCategorizeResult.layer_filters === "object") {
        STATE.categorizeFilters = Object.assign(
          { roads: true, trees: true, water: true, walls: true, stockpiles: true },
          STATE.lastCategorizeResult.layer_filters
        );
      }
      if (renderWhenLoaded) {
        STATE.categorizeOverlayVisible = true;
        renderCategorize3DOverlays(STATE.lastCategorizeResult);
      } else if (!STATE.categorizeOverlayVisible) {
        clearCategorizeVisualsOnly();
      }
      syncCategorizeVisibilityUI();
      return STATE.lastCategorizeResult;
    }

    try {
      const res = await apiGet(`/api/survey/categorize?scan_id=${encodeURIComponent(scanId)}`);
      if (!res || res.status !== "ok" || res.has_categorization === false) {
        syncCategorizeVisibilityUI();
        return null;
      }
      // Guard against race if user switched scans while request was in flight
      if (STATE.activeScanId && STATE.activeScanId !== scanId) {
        return res;
      }
      STATE.lastCategorizeResult = res;
      if (res.layer_filters && typeof res.layer_filters === "object") {
        STATE.categorizeFilters = Object.assign(
          { roads: true, trees: true, water: true, walls: true, stockpiles: true },
          res.layer_filters
        );
      }
      const targetScan = scanObj || STATE.activeScan || (STATE.scans || []).find((s) => s.scan_id === scanId);
      if (targetScan) {
        targetScan.has_categorization = true;
        targetScan.categorization_overlay_visible_default = false;
        if (res.summary) targetScan.categorization_summary = res.summary;
      }
      if (renderWhenLoaded) {
        STATE.categorizeOverlayVisible = true;
        renderCategorize3DOverlays(res);
      } else if (!STATE.categorizeOverlayVisible) {
        // Hidden by default on scan load!
        clearCategorizeVisualsOnly();
      } else {
        renderCategorize3DOverlays(res);
      }
      syncCategorizeVisibilityUI();
      if (STATE.activeTool === "categorize" && document.getElementById("catResultContainer")) {
        renderCategorizePanelContent(res);
      }
      return res;
    } catch (_) {
      syncCategorizeVisibilityUI();
      return null;
    }
  }

  async function setCategorizeOverlayVisibility(visible, opts = {}) {
    const nextVis = Boolean(visible);
    STATE.categorizeOverlayVisible = nextVis;
    const sid = STATE.activeScanId || STATE.activeScan?.scan_id || "";

    if (nextVis) {
      if (STATE.lastCategorizeResult && STATE.lastCategorizeResult.scan_id === sid) {
        renderCategorize3DOverlays(STATE.lastCategorizeResult);
      } else if (sid) {
        await preloadSavedCategorizationForScan(sid, STATE.activeScan, { renderWhenLoaded: true });
      }
    } else {
      clearCategorizeVisualsOnly();
      if (studioThree?.renderer && studioThree?.scene && studioThree?.camera) {
        studioThree.renderer.render(studioThree.scene, studioThree.camera);
      }
    }

    syncCategorizeVisibilityUI();
    if (!opts.silent) {
      showToast(
        nextVis
          ? tr("AI 地物分類 3D 圖層：顯示中", "3D Classification Overlays: Visible")
          : tr("AI 地物分類 3D 圖層：已隱藏（預設隱藏）", "3D Classification Overlays: Hidden (Default)")
      );
    }
  }

  document.getElementById("btnStudioToggleCategorizeVis")?.addEventListener("click", () => {
    setCategorizeOverlayVisibility(!STATE.categorizeOverlayVisible);
  });
  document.getElementById("btnStudioToggleCategorizeLabels")?.addEventListener("click", () => {
    setCategorizeLabelsVisibility(STATE.categorizeLabelsVisible === false);
  });

  function twd97PointToStudioVec3(twdArr, fallbackLocalArr, originTwd) {
    if (Array.isArray(twdArr) && twdArr.length >= 3 && Math.abs(Number(twdArr[0])) > 50000) {
      const lx = Number(twdArr[0]) - originTwd.e;
      const ly = Number(twdArr[2]) - originTwd.h;
      const lz = originTwd.n - Number(twdArr[1]);
      return new THREE.Vector3(lx, ly, lz);
    }
    if (Array.isArray(fallbackLocalArr) && fallbackLocalArr.length >= 3) {
      return new THREE.Vector3(Number(fallbackLocalArr[0] || 0), Number(fallbackLocalArr[1] || 0), Number(fallbackLocalArr[2] || 0));
    }
    return new THREE.Vector3(0, 0, 0);
  }

  function flyToCategorizeFeature(lx, ly, lz, labelText = "", featureId = "") {
    if (!studioThree || !studioThree.camera || !studioThree.controls) return;
    const targetPt = new THREE.Vector3(Number(lx) || 0, Number(ly) || 0, Number(lz) || 0);
    const curTarget = studioThree.controls.target.clone();
    const curPos = studioThree.camera.position.clone();
    const offset = curPos.clone().sub(curTarget);
    const curDist = Math.max(12, Math.min(48, offset.length() * 0.65));
    if (offset.lengthSq() < 1e-3) offset.set(16, 22, 18);
    offset.normalize().multiplyScalar(curDist);
    offset.y = Math.max(offset.y, curDist * 0.55);

    studioThree.controls.target.copy(targetPt);
    studioThree.camera.position.copy(targetPt).add(offset);
    studioThree.controls.update();

    if (featureId) {
      let foundBadge = false;
      STATE.badges2D.forEach((b) => {
        if (b.isCategorize) {
          b.isFocused = b.featureId === featureId;
          if (b.isFocused) foundBadge = true;
        }
      });
      if (!foundBadge && labelText) {
        add2DBadge(
          new THREE.Vector3(targetPt.x, targetPt.y + 1.2, targetPt.z),
          `<span style="color:#38bdf8;font-weight:800;">🎯 ${escapeHtml(labelText)}</span>`,
          "#38bdf8",
          { isCategorize: true, offsetY: -14, priority: 100, featureId, isFocused: true }
        );
      }
    }

    updateZoomInvariantElements();
    update2DBadgePositions();
    if (studioThree.renderer && studioThree.scene) {
      studioThree.renderer.render(studioThree.scene, studioThree.camera);
    }
    if (labelText) {
      showToast(`Focused on ${labelText}`);
    }
  }

  function renderCategorize3DOverlays(res) {
    if (!studioThree || !studioThree.categoryGroup || !res) return;
    clearCategorizeVisualsOnly();
    if (!STATE.categorizeOverlayVisible) {
      syncCategorizeVisibilityUI();
      if (studioThree.renderer && studioThree.scene && studioThree.camera) {
        studioThree.renderer.render(studioThree.scene, studioThree.camera);
      }
      return;
    }

    if (!STATE.categorizeFilters) {
      STATE.categorizeFilters = {
        roads: true,
        trees: true,
        water: true,
        walls: true,
        stockpiles: true,
      };
    }
    const flt = STATE.categorizeFilters;
    const originTwd = localToTwd97({ x: 0, y: 0, z: 0 });
    const grp = studioThree.categoryGroup;

    // Smart Category-Separated 3D Spatial Separation & Viewport-Aware Priority Queue for 2D Floating Badges
    const placedBadgeAnchorsByCat = {
      water: [],
      roads: [],
      walls: [],
      trees: [],
      stockpiles: [],
      default: [],
    };
    const allPlacedBadgeAnchors3D = [];
    const camDist =
      studioThree?.camera && studioThree?.controls?.target
        ? studioThree.camera.position.distanceTo(studioThree.controls.target)
        : 45.0;
    const isVec3InSafeViewport = (pt3) => {
      if (!pt3 || !studioThree?.camera || !studioThree?.renderer) return true;
      studioThree.camera.updateMatrixWorld();
      const w = studioThree.renderer.domElement.clientWidth || 1280;
      const h = studioThree.renderer.domElement.clientHeight || 800;
      const panelEl = document.getElementById("studioSidePanel");
      const panelOpen = Boolean(panelEl && (panelEl.classList.contains("open") || panelEl.classList.contains("active")));
      const rightSafe = w - (panelOpen ? (panelEl.offsetWidth || 380) + 24 : 24);
      const v = pt3.clone().project(studioThree.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) return false;
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-(v.y * 0.5) + 0.5) * h;
      return sx >= 110 && sx <= rightSafe - 55 && sy >= 74 && sy <= h - 84;
    };
    const tryAddCategorizeBadge = (anchorVec3, html, colorHex, opts = {}) => {
      if (!anchorVec3) return false;
      if (!opts.isFocused && !isVec3InSafeViewport(anchorVec3)) {
        return false;
      }
      const catKey = opts.catKey || "default";
      const catArr = placedBadgeAnchorsByCat[catKey] || placedBadgeAnchorsByCat.default;
      const minSameCatSep =
        opts.minSep ??
        (catKey === "trees"
          ? Math.max(3.5, Math.min(7.5, camDist * 0.065))
          : 11.5);
      for (const prev of catArr) {
        if (anchorVec3.distanceTo(prev) < minSameCatSep) {
          return false;
        }
      }
      for (const prevAll of allPlacedBadgeAnchors3D) {
        if (anchorVec3.distanceTo(prevAll) < 2.2) {
          return false;
        }
      }
      catArr.push(anchorVec3.clone());
      allPlacedBadgeAnchors3D.push(anchorVec3.clone());
      add2DBadge(anchorVec3, html, colorHex, {
        isCategorize: true,
        offsetY: opts.offsetY ?? -12,
        priority: opts.priority ?? 10,
        featureId: opts.featureId || null,
        catKey: opts.catKey || null,
        isFocused: Boolean(opts.isFocused),
      });
      return true;
    };

    const addPolygonHorizontalMesh = (
      ptsVec3,
      fillHex,
      strokeHex,
      fillOpacity = 0.34,
      yLift = 0.22,
      holesVec3List = []
    ) => {
      if (!Array.isArray(ptsVec3) || ptsVec3.length < 3) return;
      const meanY = ptsVec3.reduce((acc, p) => acc + p.y, 0) / ptsVec3.length + yLift;
      const shape = new THREE.Shape();
      ptsVec3.forEach((p, idx) => {
        if (idx === 0) shape.moveTo(p.x, -p.z);
        else shape.lineTo(p.x, -p.z);
      });
      shape.closePath();
      if (Array.isArray(holesVec3List)) {
        holesVec3List.forEach((holePts) => {
          if (!Array.isArray(holePts) || holePts.length < 3) return;
          const holePath = new THREE.Path();
          holePts.forEach((hp, hIdx) => {
            if (hIdx === 0) holePath.moveTo(hp.x, -hp.z);
            else holePath.lineTo(hp.x, -hp.z);
          });
          holePath.closePath();
          shape.holes.push(holePath);
        });
      }
      const sGeo = new THREE.ShapeGeometry(shape);
      sGeo.rotateX(-Math.PI / 2);
      sGeo.translate(0, meanY, 0);
      const sMat = new THREE.MeshBasicMaterial({
        color: fillHex,
        transparent: true,
        opacity: fillOpacity,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const fillMesh = new THREE.Mesh(sGeo, sMat);
      fillMesh.renderOrder = 992;
      grp.add(fillMesh);

      const loopPts = ptsVec3.map((p) => new THREE.Vector3(p.x, p.y + yLift + 0.06, p.z));
      loopPts.push(loopPts[0].clone());
      const lGeo = new THREE.BufferGeometry().setFromPoints(loopPts);
      const lMat = new THREE.LineBasicMaterial({
        color: strokeHex,
        linewidth: 2,
        depthTest: false,
      });
      const line = new THREE.Line(lGeo, lMat);
      line.renderOrder = 996;
      grp.add(line);

      if (Array.isArray(holesVec3List)) {
        holesVec3List.forEach((holePts) => {
          if (!Array.isArray(holePts) || holePts.length < 3) return;
          const hLoopPts = holePts.map((hp) => new THREE.Vector3(hp.x, hp.y + yLift + 0.07, hp.z));
          hLoopPts.push(hLoopPts[0].clone());
          const hlGeo = new THREE.BufferGeometry().setFromPoints(hLoopPts);
          const hlLine = new THREE.Line(hlGeo, lMat);
          hlLine.renderOrder = 996;
          grp.add(hlLine);
        });
      }
    };

    // 1. WATER BODIES & UN-MODELLED WATER VOIDS (Hydrostatic Cyan Plane #06b6d4) — Highest badge priority (Top 2: W1, W2)
    if (flt.water && Array.isArray(res.water_bodies)) {
      let waterBadgesAdded = 0;
      res.water_bodies.forEach((w, idx) => {
        const bTwd = w.boundary_twd97 || [];
        const bLoc = w.boundary_local || [];
        const waterLevelH = Number(w.water_level_twvd2001_m ?? (w.center_twd97 && w.center_twd97[2]) ?? originTwd.h);
        const pts = (bTwd.length >= 3 ? bTwd : bLoc).map((p, i) => {
          const v = twd97PointToStudioVec3(bTwd[i], bLoc[i], originTwd);
          v.y = waterLevelH - originTwd.h;
          return v;
        });
        addPolygonHorizontalMesh(pts, 0x06b6d4, 0x22d3ee, 0.42, 0.16);
        const cPt = twd97PointToStudioVec3(w.center_twd97, w.center_local, originTwd);
        cPt.y = waterLevelH - originTwd.h + 0.5;
        if (waterBadgesAdded < 4) {
          const isVoid = w.detection_mode === "unmodelled_void_shoreline";
          const added = tryAddCategorizeBadge(
            cPt,
            `<span style="color:#22d3ee;font-weight:800;">💧 ${escapeHtml(w.id)}</span> ${isVoid ? tr("水域空洞", "Water Void") : tr("水體", "Water")} · <b>TWVD2001 +${waterLevelH.toFixed(2)}m</b> (${Number(w.planar_area_m2 || 0).toFixed(0)} m²)`,
            "#06b6d4",
            { offsetY: -14, priority: 90 - idx, featureId: w.id, catKey: "water" }
          );
          if (added) waterBadgesAdded++;
        }
      });
    }

    // 2. ROADS (Amber #f59e0b) — Top 5 badges (R1..R5) with interior lawn/planter hole cutouts
    if (flt.roads && Array.isArray(res.roads)) {
      let roadBadgesAdded = 0;
      res.roads.forEach((r, idx) => {
        const bTwd = r.boundary_twd97 || [];
        const bLoc = r.boundary_local || [];
        const pts = (bTwd.length >= 3 ? bTwd : bLoc).map((p, i) =>
          twd97PointToStudioVec3(bTwd[i], bLoc[i], originTwd)
        );
        const hTwdList = r.holes_twd97 || [];
        const hLocList = r.holes_local || [];
        const nHoles = Math.max(hTwdList.length, hLocList.length);
        const holesPts = [];
        for (let hi = 0; hi < nHoles; hi++) {
          const ht = hTwdList[hi] || [];
          const hl = hLocList[hi] || [];
          const hRing = (ht.length >= 3 ? ht : hl).map((hp, pi) =>
            twd97PointToStudioVec3(ht[pi], hl[pi], originTwd)
          );
          if (hRing.length >= 3) holesPts.push(hRing);
        }
        addPolygonHorizontalMesh(pts, 0xf59e0b, 0xfbbf24, 0.36, 0.25, holesPts);
        const cPt = twd97PointToStudioVec3(r.center_twd97, r.center_local, originTwd);
        cPt.y += 0.6;
        if (roadBadgesAdded < 5) {
          const added = tryAddCategorizeBadge(
            cPt,
            `<span style="color:#fbbf24;font-weight:800;">🛣️ ${escapeHtml(r.id)}</span> · <b>${Number(r.planar_area_m2 || 0).toFixed(1)} m²</b> (${Number(r.mean_width_m || 0).toFixed(1)}m W)`,
            "#f59e0b",
            { offsetY: -12, priority: 80 - idx, featureId: r.id, catKey: "roads" }
          );
          if (added) roadBadgesAdded++;
        }
      });
    }

    // 3. WALLS (Extruded 3D Vertical Wall Ribbon + Wireframe #f43f5e) — Top 4 badges (WL1..WL4)
    if (flt.walls && Array.isArray(res.walls)) {
      let wallBadgesAdded = 0;
      res.walls.forEach((wl, idx) => {
        const bTwd = wl.base_polyline_twd97 || [];
        const tTwd = wl.top_polyline_twd97 || [];
        const bLoc = wl.base_polyline_local || [];
        const tLoc = wl.top_polyline_local || [];
        const nPts = Math.min(bTwd.length || bLoc.length, tTwd.length || tLoc.length);
        if (nPts < 2) return;

        const basePts = [];
        const topPts = [];
        for (let i = 0; i < nPts; i++) {
          basePts.push(twd97PointToStudioVec3(bTwd[i], bLoc[i], originTwd));
          topPts.push(twd97PointToStudioVec3(tTwd[i], tLoc[i], originTwd));
        }

        const posArr = [];
        for (let i = 0; i < nPts - 1; i++) {
          const b0 = basePts[i], b1 = basePts[i + 1];
          const t0 = topPts[i], t1 = topPts[i + 1];
          posArr.push(b0.x, b0.y, b0.z, b1.x, b1.y, b1.z, t1.x, t1.y, t1.z);
          posArr.push(b0.x, b0.y, b0.z, t1.x, t1.y, t1.z, t0.x, t0.y, t0.z);
        }
        const wallGeo = new THREE.BufferGeometry();
        wallGeo.setAttribute("position", new THREE.Float32BufferAttribute(posArr, 3));
        wallGeo.computeVertexNormals();
        const wallMat = new THREE.MeshBasicMaterial({
          color: 0xf43f5e,
          transparent: true,
          opacity: 0.62,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const wallMesh = new THREE.Mesh(wallGeo, wallMat);
        wallMesh.renderOrder = 997;
        grp.add(wallMesh);

        const outlinePts = [...basePts, ...topPts.slice().reverse(), basePts[0].clone()];
        const outGeo = new THREE.BufferGeometry().setFromPoints(outlinePts);
        const outLine = new THREE.Line(
          outGeo,
          new THREE.LineBasicMaterial({ color: 0xfda4af, linewidth: 2, depthTest: false })
        );
        outLine.renderOrder = 999;
        grp.add(outLine);

        if (wallBadgesAdded < 4) {
          const cPt = twd97PointToStudioVec3(wl.center_twd97, wl.center_local, originTwd);
          cPt.y += Number(wl.mean_height_m || wl.height_m || 2.0) * 0.6 + 0.5;
          const added = tryAddCategorizeBadge(
            cPt,
            `<span style="color:#fb7185;font-weight:800;">🧱 ${escapeHtml(wl.id)}</span> · L ${Number(wl.length_m || 0).toFixed(1)}m · 3D <b>${Number(wl.vertical_area_m2 || 0).toFixed(1)} m²</b>`,
            "#f43f5e",
            { offsetY: -12, priority: 70 - idx, featureId: wl.id, catKey: "walls" }
          );
          if (added) wallBadgesAdded++;
        }
      });
    }

    // 4. TREES & 1.3m BREAST-HEIGHT DBH (3D Trunk Cylinders + 1.3m DBH Ring + Emerald Canopy Domes + Crown Ring #10b981)
    if (flt.trees && Array.isArray(res.trees)) {
      let treeBadgesAdded = 0;
      const maxTreeBadges = STATE.categorizeActiveTab === "trees" ? 16 : 12;
      const treePriorityBase = STATE.categorizeActiveTab === "trees" ? 95 : 68;
      res.trees.forEach((t, idx) => {
        const basePt = twd97PointToStudioVec3(t.trunk_twd97, t.trunk_local, originTwd);
        const treeH = Math.max(2.5, Number(t.height_m || 6.0));
        const dbhCm = Math.max(10.0, Number(t.dbh_cm || 30.0));
        const crownD = Math.max(2.0, Number(t.crown_diameter_m || 4.0));
        const rTrunk = Math.max(0.22, (dbhCm / 200.0) * 1.35);
        const trunkH = Math.max(1.8, treeH * 0.52);

        const trunkGeo = new THREE.CylinderGeometry(rTrunk * 0.85, rTrunk * 1.15, trunkH, 10);
        const trunkMat = new THREE.MeshBasicMaterial({
          color: 0xb45309,
          transparent: true,
          opacity: 0.88,
        });
        const trunkMesh = new THREE.Mesh(trunkGeo, trunkMat);
        trunkMesh.position.set(basePt.x, basePt.y + trunkH * 0.5, basePt.z);
        trunkMesh.renderOrder = 995;
        grp.add(trunkMesh);

        // 1.3m Breast-Height (DBH) bright measurement collar ring
        const dbhRingGeo = new THREE.RingGeometry(rTrunk * 1.05, rTrunk * 1.65, 22);
        dbhRingGeo.rotateX(-Math.PI / 2);
        const dbhRingMat = new THREE.MeshBasicMaterial({
          color: 0xfef08a,
          side: THREE.DoubleSide,
          depthTest: false,
        });
        const dbhRing = new THREE.Mesh(dbhRingGeo, dbhRingMat);
        dbhRing.position.set(basePt.x, basePt.y + 1.3, basePt.z);
        dbhRing.renderOrder = 999;
        grp.add(dbhRing);

        // Translucent 3D Canopy Crown Sphere/Dome + Crisp Emerald Crown Equatorial Ring
        const crownR = Math.max(1.2, crownD * 0.46);
        const crownY = basePt.y + trunkH + crownR * 0.35;
        const crownGeo = new THREE.SphereGeometry(crownR, 14, 10);
        const crownMat = new THREE.MeshBasicMaterial({
          color: 0x10b981,
          transparent: true,
          opacity: 0.30,
          depthWrite: false,
        });
        const crownMesh = new THREE.Mesh(crownGeo, crownMat);
        crownMesh.position.set(basePt.x, crownY, basePt.z);
        crownMesh.scale.set(1.0, Math.max(0.65, (treeH * 0.55) / Math.max(crownR * 1.6, 1.0)), 1.0);
        crownMesh.renderOrder = 994;
        grp.add(crownMesh);

        const cRingPts = [];
        for (let s = 0; s <= 24; s++) {
          const ang = (s / 24) * Math.PI * 2;
          cRingPts.push(
            new THREE.Vector3(
              basePt.x + Math.cos(ang) * crownR,
              basePt.y + trunkH * 0.92,
              basePt.z + Math.sin(ang) * crownR
            )
          );
        }
        const cRingLine = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(cRingPts),
          new THREE.LineBasicMaterial({ color: 0x34d399, linewidth: 2, depthTest: false })
        );
        cRingLine.renderOrder = 998;
        grp.add(cRingLine);

        if (treeBadgesAdded < maxTreeBadges) {
          const topPt = new THREE.Vector3(basePt.x, basePt.y + Math.min(treeH * 0.65, 5.2), basePt.z);
          const added = tryAddCategorizeBadge(
            topPt,
            `<span style="color:#34d399;font-weight:800;">🌳 ${escapeHtml(t.id)}</span> · DBH <b>${dbhCm.toFixed(1)} cm</b> · H ${treeH.toFixed(1)}m`,
            "#10b981",
            {
              offsetY: -10,
              priority: treePriorityBase - idx,
              featureId: t.id,
              catKey: "trees",
              isFocused: STATE.categorizeActiveTab === "trees",
            }
          );
          if (added) treeBadgesAdded++;
        }
      });
    }

    // 5. BARE EARTH / STOCKPILES (Orange #d97706) — Top 1 badge (S1)
    if (flt.stockpiles && Array.isArray(res.stockpiles)) {
      let spBadgesAdded = 0;
      res.stockpiles.slice(0, 4).forEach((sp, idx) => {
        const bTwd = sp.boundary_twd97 || [];
        const bLoc = sp.boundary_local || [];
        const pts = (bTwd.length >= 3 ? bTwd : bLoc).map((p, i) =>
          twd97PointToStudioVec3(bTwd[i], bLoc[i], originTwd)
        );
        addPolygonHorizontalMesh(pts, 0xd97706, 0xf59e0b, 0.22, 0.18);
        if (spBadgesAdded < 1) {
          const cPt = twd97PointToStudioVec3(sp.center_twd97, sp.center_local, originTwd);
          cPt.y += 0.5;
          const added = tryAddCategorizeBadge(
            cPt,
            `<span style="color:#fbbf24;font-weight:800;">⛰️ ${escapeHtml(sp.id)}</span> · <b>${Number(sp.planar_area_m2 || 0).toFixed(0)} m²</b> (~${Number(sp.estimated_volume_m3 || 0).toFixed(0)} m³)`,
            "#d97706",
            { offsetY: -10, priority: 50 - idx, featureId: sp.id, catKey: "stockpiles" }
          );
          if (added) spBadgesAdded++;
        }
      });
    }

    updateZoomInvariantElements();
    update2DBadgePositions();
    if (studioThree.renderer && studioThree.scene && studioThree.camera) {
      studioThree.renderer.render(studioThree.scene, studioThree.camera);
    }
  }

  function renderCategorizePanelContent(res) {
    const box = document.getElementById("catResultContainer");
    if (!box || !res) return;
    const s = res.summary || {};
    if (!STATE.categorizeFilters) {
      STATE.categorizeFilters = {
        roads: true,
        trees: true,
        water: true,
        walls: true,
        stockpiles: true,
      };
    }
    const flt = STATE.categorizeFilters;
    const activeTab = STATE.categorizeActiveTab || "all";
    const originTwd = localToTwd97({ x: 0, y: 0, z: 0 });

    const toFlyAttr = (twdArr, locArr) => {
      const v = twd97PointToStudioVec3(twdArr, locArr, originTwd);
      return `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}`;
    };

    const rows = [];
    if ((activeTab === "all" || activeTab === "roads") && flt.roads) {
      (res.roads || []).forEach((r) => {
        rows.push({
          id: r.id,
          catType: "roads",
          badge: `<span style="color:#f59e0b;font-weight:800;">${escapeHtml(r.id)}</span>`,
          type: tr("道路", "Road"),
          metric1: `${Number(r.planar_area_m2 || 0).toFixed(1)} m²`,
          metric2: `W ${Number(r.mean_width_m || 0).toFixed(1)}m · ${Number(r.mean_slope_pct || 0).toFixed(1)}%`,
          fly: toFlyAttr(r.center_twd97, r.center_local),
          label: `${r.id} · ${r.planar_area_m2} m²`,
        });
      });
    }
    if ((activeTab === "all" || activeTab === "trees") && flt.trees) {
      (res.trees || []).slice(0, activeTab === "trees" ? 50 : 12).forEach((t) => {
        rows.push({
          id: t.id,
          catType: "trees",
          badge: `<span style="color:#10b981;font-weight:800;">${escapeHtml(t.id)}</span>`,
          type: tr("喬木", "Tree"),
          metric1: `DBH ${Number(t.dbh_cm || 0).toFixed(1)} cm`,
          metric2: `H ${Number(t.height_m || 0).toFixed(1)}m · Ø${Number(t.crown_diameter_m || 0).toFixed(1)}m`,
          fly: toFlyAttr(t.trunk_twd97, t.trunk_local),
          label: `${t.id} · DBH ${t.dbh_cm}cm`,
        });
      });
    }
    if ((activeTab === "all" || activeTab === "water") && flt.water) {
      (res.water_bodies || []).forEach((w) => {
        rows.push({
          id: w.id,
          catType: "water_bodies",
          badge: `<span style="color:#06b6d4;font-weight:800;">${escapeHtml(w.id)}</span>`,
          type: w.detection_mode === "unmodelled_void_shoreline" ? tr("水域空洞", "Water Void") : tr("水體", "Water"),
          metric1: `${Number(w.planar_area_m2 || 0).toFixed(1)} m²`,
          metric2: `TWVD +${Number(w.water_level_twvd2001_m || 0).toFixed(2)}m`,
          fly: toFlyAttr(w.center_twd97, w.center_local),
          label: `${w.id} · +${w.water_level_twvd2001_m}m`,
        });
      });
    }
    if ((activeTab === "all" || activeTab === "walls") && flt.walls) {
      (res.walls || []).forEach((wl) => {
        rows.push({
          id: wl.id,
          catType: "walls",
          badge: `<span style="color:#f43f5e;font-weight:800;">${escapeHtml(wl.id)}</span>`,
          type: tr("擋土牆", "Wall"),
          metric1: `3D ${Number(wl.vertical_area_m2 || 0).toFixed(1)} m²`,
          metric2: `L ${Number(wl.length_m || 0).toFixed(1)}m · H ${Number(wl.mean_height_m || wl.height_m || 0).toFixed(1)}m`,
          fly: toFlyAttr(wl.center_twd97, wl.center_local),
          label: `${wl.id} · ${wl.vertical_area_m2} m²`,
        });
      });
    }
    if ((activeTab === "all" || activeTab === "stockpiles") && flt.stockpiles) {
      (res.stockpiles || []).forEach((sp) => {
        rows.push({
          id: sp.id,
          catType: "stockpiles",
          badge: `<span style="color:#d97706;font-weight:800;">${escapeHtml(sp.id)}</span>`,
          type: tr("土石堆置", "Stockpile"),
          metric1: `${Number(sp.planar_area_m2 || 0).toFixed(1)} m²`,
          metric2: `~${Number(sp.estimated_volume_m3 || 0).toFixed(1)} m³`,
          fly: toFlyAttr(sp.center_twd97, sp.center_local),
          label: `${sp.id} · ${sp.planar_area_m2} m² · ~${sp.estimated_volume_m3} m³`,
        });
      });
    }

    const breakdownHtml = (res.categories_breakdown || [])
      .slice(0, 10)
      .map((c) => {
        const cleanZh = String(c.name_zh || c.name_en || "").replace(/\s*[\(（][^\)）]*[\)）]\s*/g, "").trim();
        const cleanEn = String(c.name_en || c.name_zh || "").replace(/\s*[\(（][^\)）]*[\)）]\s*/g, "").trim();
        return `
        <div style="display:flex;align-items:center;justify-content:space-between;font-size:10.5px;padding:2px 0;">
          <span style="display:inline-flex;align-items:center;gap:5px;color:var(--ui-text-primary);font-weight:600;">
            <span style="width:8px;height:8px;border-radius:2px;background:${escapeHtml(c.color || "#38bdf8")};display:inline-block;"></span>
            ${escapeHtml(tr(cleanZh, cleanEn))}
          </span>
          <span style="font-family:monospace;color:var(--ui-text-secondary);">${Number(c.planar_area_m2 || c.surface_area_3d_m2 || 0).toLocaleString()} m² · ${Number(c.site_share_pct || 0).toFixed(1)}%</span>
        </div>`;
      })
      .join("");

    const exportBarHtml = `
      <div style="display:flex;gap:4px;flex-wrap:nowrap;margin-bottom:8px;">
        <a class="btn-xs primary" style="flex:1.15;justify-content:center;font-weight:700;white-space:nowrap;font-size:10.5px;padding:5px 6px;" href="${escapeHtml(appendAuthToDownloadUrl(res.dxf_url))}" download="Civil3D_Categorized.dxf" title="${tr("下載 AutoCAD Civil 3D 分類圖層 .DXF", "Download AutoCAD Civil 3D Categorized .DXF")}">
          <span>${tr("📐 .DXF 圖檔", "📐 .DXF CAD")}</span>
        </a>
        <a class="btn-xs primary" style="flex:1.15;justify-content:center;font-weight:700;white-space:nowrap;font-size:10.5px;padding:5px 6px;" href="${escapeHtml(appendAuthToDownloadUrl(res.report_html_url))}" target="_blank" title="${tr("開啟可列印分類明細報表 · HTML / 另存 PDF", "Open Printable Categorization Report · HTML / Save PDF")}">
          <span>${tr("📄 報表 · HTML/PDF", "📄 Report · HTML/PDF")}</span>
        </a>
        <a class="btn-xs" style="flex:0.9;justify-content:center;font-weight:700;white-space:nowrap;font-size:10.5px;padding:5px 6px;" href="${escapeHtml(appendAuthToDownloadUrl(res.report_csv_url))}" download="Categorization_Schedule.csv" title="${tr("下載 UTF-8 Excel 數量明細表 .CSV", "Download UTF-8 Excel Schedule .CSV")}">
          <span>${tr("📊 明細表 · .CSV", "📊 Schedule · .CSV")}</span>
        </a>
      </div>
    `;

    const isVis = Boolean(STATE.categorizeOverlayVisible);
    const lblsVis = STATE.categorizeLabelsVisible !== false;
    const editMode = STATE.categorizeEditMode || null;
    const rawSavedAt = String(res.saved_at || res.generated_at || "");
    const savedAtStr = rawSavedAt ? rawSavedAt : tr("已儲存於伺服器", "Persisted on Server");

    let editStatusMsg = tr(
      "點選上方按鈕後，直接點擊 3D 場景即可新增或刪除分類項目",
      "Click a mode button above, then click directly on the 3D scene to add or remove items"
    );
    if (editMode === "add_tree") {
      editStatusMsg = tr(
        "🟢 新增喬木模式：請點擊 3D 場景中的樹木位置",
        "🟢 Add Tree Mode: Click tree location on the 3D model"
      );
    } else if (editMode === "add_wall") {
      const nPts = (STATE.categorizeEditPoints || []).length;
      editStatusMsg = tr(
        `🔴 新增牆面模式：請依序點擊牆面起點與終點 · ${nPts}/2 點`,
        `🔴 Add Wall Mode: Click start and end points on 3D wall · ${nPts}/2 pts`
      );
    } else if (editMode === "add_road") {
      const nPts = (STATE.categorizeEditPoints || []).length;
      editStatusMsg = tr(
        `🟠 新增道路模式：點擊多邊形頂點 · ${nPts} 點 · 點擊起點 V1 或按 Enter 完成`,
        `🟠 Add Road Mode: Click polygon vertices · ${nPts} pts · click V1 or press Enter to finish`
      );
    } else if (editMode === "remove_click") {
      editStatusMsg = tr(
        "🗑️ 點選刪除模式：點擊 3D 場景中的樹木/牆面/道路，或點擊下方表格 🗑️ 即可刪除",
        "🗑️ Remove Mode: Click any tree/wall/road in 3D or click 🗑️ in the table below"
      );
    }

    const rawAiModel = String(res.ai_model || "Gemini 3.6 Flash Multimodal + 3D Geometry");
    const localizedAiModel = tr(
      rawAiModel.replace("Multimodal + 3D Geometry", "多模態 + 3D 幾何分析"),
      rawAiModel
    );

    const rawCatHtml = `
      ${exportBarHtml}

      <div style="background:rgba(14,165,233,0.10);border:1px solid rgba(56,189,248,0.35);border-radius:8px;padding:7px 9px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;margin-bottom:5px;">
          <span style="font-size:10.5px;font-weight:800;color:#38bdf8;">${tr("💾 已儲存於伺服器", "💾 Saved on Server")}</span>
          <span id="lblCategorizeVisBadge" style="font-size:9.5px;padding:1px 7px;border-radius:99px;background:${isVis ? "rgba(16,185,129,0.20)" : "rgba(148,163,184,0.18)"};color:${isVis ? "#34d399" : "#94a3b8"};font-weight:700;">
            ${isVis ? tr("顯示中", "Visible") : tr("預設隱藏", "Hidden by Default")}
          </span>
        </div>
        <div style="font-size:9.5px;color:var(--ui-text-muted);margin-bottom:6px;">
          ${tr("伺服器快取：", "Server Cache: ")}<code>_categorization_cache_v3.json</code> · ${escapeHtml(savedAtStr)}
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px;">
          <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;font-size:11px;font-weight:700;color:var(--ui-text-primary);">
            <input type="checkbox" id="chkCategorizeMasterVis" ${isVis ? "checked" : ""} />
            ${tr("顯示 3D 地物分類圖層", "Show 3D Overlays")}
          </label>
          <button type="button" class="btn-xs ${isVis ? "primary" : ""}" id="btnToggleCategorizeOverlayVis" style="padding:3px 8px;font-weight:700;">
            ${isVis ? tr("👁️ 顯示中 · 點擊隱藏 3D 圖層", "👁️ Visible · Click to Hide 3D Overlays") : tr("👁️‍🗨️ 預設隱藏 · 點擊顯示 3D 圖層", "👁️‍🗨️ Hidden by Default · Click to Show 3D Overlays")}
          </button>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:4px;border-top:1px dashed rgba(56,189,248,0.25);">
          <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;font-size:10.5px;font-weight:700;color:#38bdf8;">
            <input type="checkbox" id="chkCategorizeLabelsVis" ${lblsVis ? "checked" : ""} />
            ${tr("🏷️ 顯示 2D 浮動標籤", "🏷️ Show 2D Floating Labels")}
          </label>
          <span style="font-size:9.5px;color:var(--ui-text-muted);">${lblsVis ? tr("標籤開啟", "Labels On") : tr("僅保留 3D 幾何", "3D Geometry Only")}</span>
        </div>
      </div>

      <div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.35);border-radius:8px;padding:7px 9px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;margin-bottom:5px;">
          <span style="font-size:10.5px;font-weight:800;color:#fbbf24;">${tr("🛠️ 手動新增 / 刪除分類", "🛠️ Manual Add / Remove Classification")}</span>
          <button type="button" class="btn-xs" id="btnResetCategorizeManualEdits" style="padding:1px 6px;font-size:9.5px;" title="${tr("還原所有手動新增或刪除的項目", "Reset Manual Overrides")}">
            ${tr("↺ 重設手動變更", "↺ Reset Edits")}
          </button>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:5px;">
          <button type="button" class="btn-xs ${editMode === "add_tree" ? "primary" : ""}" data-cat-edit-mode="add_tree" style="flex:1;justify-content:center;font-size:10px;border-color:rgba(16,185,129,0.5);">
            ${tr("➕ 喬木", "➕ Tree")}
          </button>
          <button type="button" class="btn-xs ${editMode === "add_wall" ? "primary" : ""}" data-cat-edit-mode="add_wall" style="flex:1;justify-content:center;font-size:10px;border-color:rgba(244,63,94,0.5);">
            ${tr("➕ 擋土牆", "➕ Wall")}
          </button>
          <button type="button" class="btn-xs ${editMode === "add_road" ? "primary" : ""}" data-cat-edit-mode="add_road" style="flex:1;justify-content:center;font-size:10px;border-color:rgba(245,158,11,0.5);">
            ${tr("➕ 道路", "➕ Road")}
          </button>
          <button type="button" class="btn-xs ${editMode === "remove_click" ? "primary" : ""}" data-cat-edit-mode="remove_click" style="flex:1;justify-content:center;font-size:10px;border-color:rgba(239,68,68,0.5);color:#fca5a5;">
            ${tr("🗑️ 點選刪除", "🗑️ Click to Remove")}
          </button>
        </div>
        <div id="categorizeEditStatusHint" style="font-size:9.5px;color:${editMode ? "#fbbf24" : "var(--ui-text-muted)"};line-height:1.35;">
          ${escapeHtml(editStatusMsg)}
        </div>
      </div>

      <div style="background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.35);border-radius:8px;padding:8px 10px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;margin-bottom:4px;">
          <span style="font-size:10.5px;font-weight:800;color:#34d399;">✨ ${escapeHtml(localizedAiModel)}</span>
          <span style="font-size:9.5px;padding:1px 6px;border-radius:99px;background:rgba(6,182,212,0.18);color:#22d3ee;font-weight:700;">${tr("RTK + 3D 幾何驗證", "RTK + 3D Verified")}</span>
        </div>
        <div style="font-size:11px;color:var(--ui-text-primary);line-height:1.42;margin-bottom:3px;">${escapeHtml(tr(res.ai_summary_zh || res.ai_summary_en || "", res.ai_summary_en || res.ai_summary_zh || ""))}</div>
      </div>

      <div class="gs-metric-grid" style="grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px;">
        <div class="gs-metric-box" style="border-left:3px solid #f59e0b;">
          <div class="lbl">${tr(`🛣️ 道路鋪面 · ${s.roads_count || 0}`, `🛣️ Roads · ${s.roads_count || 0}`)}</div>
          <div class="val" style="color:#fbbf24;font-size:13px;">${Number(s.roads_planar_area_m2 || 0).toLocaleString()} m²</div>
          <div style="font-size:9.5px;color:var(--ui-text-muted);">${Number(s.roads_planar_area_ping || 0).toLocaleString()} ${tr("坪", "ping")} · 3D ${Number(s.roads_surface_area_3d_m2 || 0).toLocaleString()} m²</div>
        </div>
        <div class="gs-metric-box" style="border-left:3px solid #10b981;">
          <div class="lbl">${tr(`🌳 喬木與胸徑 · ${s.trees_count || 0} 棵`, `🌳 Trees & DBH · ${s.trees_count || 0}`)}</div>
          <div class="val" style="color:#34d399;font-size:13px;">DBH ${Number(s.trees_mean_dbh_cm || 0).toFixed(1)} cm</div>
          <div style="font-size:9.5px;color:var(--ui-text-muted);">${tr(`最大 ${Number(s.trees_max_dbh_cm || 0).toFixed(1)} cm · 樹高 ${Number(s.trees_mean_height_m || 0).toFixed(1)} m`, `Max ${Number(s.trees_max_dbh_cm || 0).toFixed(1)} cm · H ${Number(s.trees_mean_height_m || 0).toFixed(1)} m`)}</div>
        </div>
        <div class="gs-metric-box" style="border-left:3px solid #06b6d4;">
          <div class="lbl">${tr(`💧 水體與河道空洞 · ${s.water_count || 0}`, `💧 Water & Voids · ${s.water_count || 0}`)}</div>
          <div class="val" style="color:#22d3ee;font-size:13px;">${Number(s.water_count || 0) > 0 && s.water_level_twvd2001_m !== null && s.water_level_twvd2001_m !== undefined ? `+${Number(s.water_level_twvd2001_m).toFixed(2)} m` : tr("無水域", "None")}</div>
          <div style="font-size:9.5px;color:var(--ui-text-muted);">${Number(s.water_count || 0) > 0 ? `${Number(s.water_planar_area_m2 || 0).toLocaleString()} m² · ${tr("岸際等位面", "shoreline")}` : `0 m² · ${tr("乾燥陸域場址", "dry site")}`}</div>
        </div>
        <div class="gs-metric-box" style="border-left:3px solid #f43f5e;">
          <div class="lbl">${tr(`🧱 擋土牆與垂直面 · ${s.walls_count || 0}`, `🧱 Retaining Walls · ${s.walls_count || 0}`)}</div>
          <div class="val" style="color:#fb7185;font-size:13px;">3D ${Number(s.walls_vertical_area_m2 || 0).toLocaleString()} m²</div>
          <div style="font-size:9.5px;color:var(--ui-text-muted);">${tr("總長 L", "Total L")} ${Number(s.walls_total_length_m || 0).toFixed(1)} m · PCA</div>
        </div>
      </div>

      <div style="background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:7px;padding:6px 8px;margin-bottom:8px;">
        <div style="font-size:10px;font-weight:700;color:var(--ui-text-secondary);margin-bottom:4px;">${tr("3D 子圖層開關", "3D SCENE OVERLAY FILTERS")}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;font-size:10.5px;">
          <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:#fbbf24;font-weight:600;">
            <input type="checkbox" data-cat-filter="roads" ${flt.roads ? "checked" : ""} /> ${tr("道路", "Roads")} · ${(res.roads || []).length}
          </label>
          <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:#34d399;font-weight:600;">
            <input type="checkbox" data-cat-filter="trees" ${flt.trees ? "checked" : ""} /> ${tr("喬木 DBH", "Trees DBH")} · ${(res.trees || []).length}
          </label>
          <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:#22d3ee;font-weight:600;">
            <input type="checkbox" data-cat-filter="water" ${flt.water ? "checked" : ""} /> ${tr("水域空洞", "Water Voids")} · ${(res.water_bodies || []).length}
          </label>
          <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:#fb7185;font-weight:600;">
            <input type="checkbox" data-cat-filter="walls" ${flt.walls ? "checked" : ""} /> ${tr("擋土牆", "Walls")} · ${(res.walls || []).length}
          </label>
          <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:#f59e0b;font-weight:600;">
            <input type="checkbox" data-cat-filter="stockpiles" ${flt.stockpiles ? "checked" : ""} /> ${tr("土石堆置", "Stockpiles")} · ${(res.stockpiles || []).length}
          </label>
        </div>
      </div>

      <div style="background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:7px;padding:6px 8px;margin-bottom:8px;">
        <div style="font-size:10px;font-weight:700;color:var(--ui-text-secondary);margin-bottom:3px;">${tr("全場地物面積組成", "SITE SURFACE BREAKDOWN")} · ${(s.triangle_count || 0).toLocaleString()} ${tr("三角面", "tris")}</div>
        ${breakdownHtml}
      </div>

      <div style="display:flex;gap:3px;margin-bottom:5px;flex-wrap:wrap;">
        ${[
          ["all", tr("全部", "All")],
          ["roads", tr("道路", "Roads")],
          ["trees", tr("喬木 DBH", "Trees DBH")],
          ["water", tr("水域", "Water")],
          ["walls", tr("擋土牆", "Walls")],
          ["stockpiles", tr("土石", "Stockpiles")],
        ]
          .map(
            ([k, lbl]) =>
              `<button type="button" class="btn-xs ${activeTab === k ? "primary" : ""}" data-cat-tab="${k}" style="padding:2px 7px;font-size:10px;">${lbl}</button>`
          )
          .join("")}
      </div>

      <div style="max-height:165px;overflow-y:auto;border:1px solid var(--ui-border-strong);border-radius:6px;margin-bottom:8px;">
        <table style="width:100%;border-collapse:collapse;font-size:10.5px;">
          <thead>
            <tr style="background:var(--ui-bg-pill);color:var(--ui-text-secondary);text-align:left;position:sticky;top:0;">
              <th style="padding:4px 6px;">ID</th>
              <th style="padding:4px 6px;">${tr("類別", "Type")}</th>
              <th style="padding:4px 6px;">${tr("主量測值", "Primary Metric")}</th>
              <th style="padding:4px 6px;">${tr("次要參數 · 點擊定位", "Secondary · Click to Fly")}</th>
              <th style="padding:4px 4px;text-align:center;">${tr("刪除", "Del")}</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (r) => `
              <tr data-cat-fly="${escapeHtml(r.fly)}" data-cat-id="${escapeHtml(r.id || "")}" data-cat-label="${escapeHtml(r.label)}" style="cursor:pointer;border-top:1px solid rgba(148,163,184,0.14);" title="${tr("點擊將 3D 鏡頭飛至", "Click to fly 3D camera to")} ${escapeHtml(r.label)}">
                <td style="padding:4px 6px;font-family:monospace;">${r.badge}</td>
                <td style="padding:4px 6px;">${escapeHtml(r.type)}</td>
                <td style="padding:4px 6px;font-weight:700;">${escapeHtml(r.metric1)}</td>
                <td style="padding:4px 6px;color:var(--ui-text-secondary);">${escapeHtml(r.metric2)}</td>
                <td style="padding:3px 4px;text-align:center;">
                  ${
                    r.catType && r.catType !== "stockpiles"
                      ? `<button type="button" class="btn-xs" data-cat-delete-id="${escapeHtml(r.id || "")}" data-cat-delete-type="${escapeHtml(r.catType)}" title="${tr("刪除此分類項目", "Remove")} ${escapeHtml(r.id || "")}" style="padding:1px 5px;font-size:10px;color:#fca5a5;border-color:rgba(239,68,68,0.35);">🗑️</button>`
                      : ""
                  }
                </td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>

      ${exportBarHtml}
    `;
    box.innerHTML = typeof window.translateDynamicHtml === "function" ? window.translateDynamicHtml(rawCatHtml) : rawCatHtml;

    document.getElementById("chkCategorizeMasterVis")?.addEventListener("change", (ev) => {
      setCategorizeOverlayVisibility(Boolean(ev.target.checked));
      renderCategorizePanelContent(res);
    });
    document.getElementById("btnToggleCategorizeOverlayVis")?.addEventListener("click", () => {
      setCategorizeOverlayVisibility(!STATE.categorizeOverlayVisible);
      renderCategorizePanelContent(res);
    });
    document.getElementById("chkCategorizeLabelsVis")?.addEventListener("change", (ev) => {
      setCategorizeLabelsVisibility(Boolean(ev.target.checked));
      renderCategorizePanelContent(res);
    });
    document.getElementById("btnResetCategorizeManualEdits")?.addEventListener("click", () => {
      STATE.categorizeEditMode = null;
      STATE.categorizeEditPoints = [];
      clearTempDistanceVisuals();
      submitCategorizeManualEdit("manual_reset", "all");
    });

    box.querySelectorAll("[data-cat-edit-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-cat-edit-mode") || null;
        if (STATE.categorizeEditMode === mode) {
          STATE.categorizeEditMode = null;
        } else {
          STATE.categorizeEditMode = mode;
          if (!STATE.categorizeOverlayVisible) {
            setCategorizeOverlayVisibility(true, { silent: true });
          }
          if (window.innerWidth <= 768 && mode) {
            STATE.sidePanelMinimized = true;
            const panel = document.getElementById("studioSidePanel");
            panel?.classList.add("mobile-minimized", "gs-panel-minimized");
            const lblCollapse = document.getElementById("lblCollapseSidePanel");
            if (lblCollapse) lblCollapse.textContent = tr("▴ 展開", "▴ Expand");
          }
        }
        STATE.categorizeEditPoints = [];
        clearTempDistanceVisuals();
        renderCategorizePanelContent(res);
        syncStudioMobileToolHud();
        update2DBadgePositions();
      });
    });

    box.querySelectorAll("[data-cat-delete-id]").forEach((delBtn) => {
      delBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const itemId = delBtn.getAttribute("data-cat-delete-id");
        const catType = delBtn.getAttribute("data-cat-delete-type");
        if (itemId && catType) {
          submitCategorizeManualEdit("manual_remove", catType, itemId);
        }
      });
    });

    box.querySelectorAll("[data-cat-filter]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const k = cb.getAttribute("data-cat-filter");
        if (k && STATE.categorizeFilters) {
          STATE.categorizeFilters[k] = cb.checked;
          if (cb.checked && !STATE.categorizeOverlayVisible) {
            STATE.categorizeOverlayVisible = true;
          }
          renderCategorize3DOverlays(res);
          syncCategorizeVisibilityUI();
          renderCategorizePanelContent(res);
          apiPost("/api/survey/categorize", {
            scan_id: res.scan_id || STATE.activeScanId,
            only_update_filters: true,
            layer_filters: STATE.categorizeFilters,
          }).catch(() => {});
        }
      });
    });

    box.querySelectorAll("[data-cat-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tabKey = btn.getAttribute("data-cat-tab") || "all";
        STATE.categorizeActiveTab = tabKey;
        if (!STATE.categorizeOverlayVisible) {
          STATE.categorizeOverlayVisible = true;
        }
        if (tabKey !== "all" && STATE.categorizeFilters && STATE.categorizeFilters[tabKey] === false) {
          STATE.categorizeFilters[tabKey] = true;
        }
        renderCategorize3DOverlays(res);
        syncCategorizeVisibilityUI();
        const prefixMap = { roads: "R", trees: "T", water: "W", walls: "WL", stockpiles: "S" };
        const pref = prefixMap[tabKey] || "";
        STATE.badges2D.forEach((b) => {
          if (b.isCategorize) {
            if (!pref) {
              b.isFocused = false;
            } else if (pref === "W") {
              b.isFocused = Boolean(b.featureId && b.featureId.startsWith("W") && !b.featureId.startsWith("WL"));
            } else {
              b.isFocused = Boolean(b.featureId && b.featureId.startsWith(pref));
            }
          }
        });
        update2DBadgePositions();
        renderCategorizePanelContent(res);
      });
    });

    box.querySelectorAll("[data-cat-fly]").forEach((tr) => {
      tr.addEventListener("click", () => {
        const raw = tr.getAttribute("data-cat-fly") || "";
        const lbl = tr.getAttribute("data-cat-label") || "";
        const fid = tr.getAttribute("data-cat-id") || "";
        const parts = raw.split(",").map(Number);
        if (parts.length >= 3 && Number.isFinite(parts[0])) {
          if (!STATE.categorizeOverlayVisible) {
            STATE.categorizeOverlayVisible = true;
            renderCategorize3DOverlays(res);
            syncCategorizeVisibilityUI();
            renderCategorizePanelContent(res);
          }
          flyToCategorizeFeature(parts[0], parts[1], parts[2], lbl, fid);
        }
      });
    });
  }

  async function openCategorizeInspector(opts = {}) {
    if (!STATE.categorizeEditMode) {
      STATE.sidePanelMinimized = false;
    }
    const activeScan = STATE.activeScan || STATE.scans.find((s) => s.scan_id === STATE.activeScanId) || {
      scan_id: STATE.activeScanId || "scan",
      name: STATE.activeScanId || "Active Scan",
    };

    showSidePanel(
      `<span>${tr("AI 自動地物分類", "AI Surface & Object Categorization")}</span>`,
      `
      <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:7px;padding:7px 9px;margin-bottom:8px;line-height:1.42;">
        ${tr(
          "結合 <b>3D 網格幾何分析</b>（純地形 DTM、1.3m 胸高樹幹切片與 Pratt 圓擬合 DBH、水域空洞岸際等高線夾取、3D PCA 牆面共面分析）與 <b>Gemini 3.6 Flash 多模態</b>驗證。",
          "Combines <b>3D Mesh Geometry</b> (Bare-Earth DTM, 1.3m Breast-Height Trunk Slicing + Pratt Circle DBH, Un-Modelled Water Void Shoreline Clamping, 3D PCA Wall Coplanarity) with <b>Gemini 3.6 Flash Multimodal</b> verification."
        )}
      </div>
      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <button type="button" class="gs-top-btn accent" style="flex:1;justify-content:center;" id="btnRunCategorize">
          <span>${tr("執行 / 顯示 AI 地物分類", "Analyze & Show 3D Overlays")}</span>
        </button>
        <button type="button" class="btn-xs" id="btnRecomputeCategorize" title="${tr("強制重新計算並執行 Gemini 多模態分析", "Force Recompute & Re-run Gemini Multimodal Analysis")}">
          <span>${tr("↻ 重新計算", "↻ Recompute")}</span>
        </button>
      </div>
      <div id="catResultContainer">
        <div style="padding:18px 10px;text-align:center;color:var(--ui-text-secondary);font-size:11.5px;">
          ${tr(
            "⏳ 正在從伺服器載入已儲存之 AI 分類結果（或分析 3D 網格）...",
            "⏳ Loading saved AI classification from server (or analyzing 3D mesh triangles)..."
          )}
        </div>
      </div>
      `
    );

    const runCategorize = async (forceRecompute = false, explicitShowOverlays = null) => {
      const box = document.getElementById("catResultContainer");
      if (box && (forceRecompute || !STATE.lastCategorizeResult || STATE.lastCategorizeResult.scan_id !== activeScan.scan_id)) {
        box.innerHTML = `
          <div style="padding:18px 10px;text-align:center;color:var(--ui-text-secondary);font-size:11.5px;">
            ${tr(
              `⏳ 正在對 <b>${escapeHtml(activeScan.name || activeScan.scan_id)}</b> ${forceRecompute ? "重新計算" : "載入 / 執行"} 3D 幾何與 Gemini 多模態分類分析...`,
              `⏳ ${forceRecompute ? "Recomputing" : "Loading / Running"} 3D Geometric + Gemini Multimodal Categorization on <b>${escapeHtml(activeScan.name || activeScan.scan_id)}</b>...`
            )}
          </div>
        `;
      }
      try {
        const res = await apiPost("/api/survey/categorize", {
          scan_id: activeScan.scan_id,
          force_recompute: Boolean(forceRecompute),
        });
        STATE.lastCategorizeResult = res;
        activeScan.has_categorization = true;
        activeScan.categorization_overlay_visible_default = false;
        if (res.summary) activeScan.categorization_summary = res.summary;
        if (res.layer_filters && typeof res.layer_filters === "object") {
          STATE.categorizeFilters = Object.assign(
            { roads: true, trees: true, water: true, walls: true, stockpiles: true },
            res.layer_filters
          );
        }
        if (typeof explicitShowOverlays === "boolean") {
          STATE.categorizeOverlayVisible = explicitShowOverlays;
        }
        renderCategorize3DOverlays(res);
        syncCategorizeVisibilityUI();
        renderCategorizePanelContent(res);
        const s = res.summary || {};
        const waterToastZh =
          Number(s.water_count || 0) > 0 && s.water_level_twvd2001_m !== null && s.water_level_twvd2001_m !== undefined
            ? `${s.water_count} 處水域 · +${Number(s.water_level_twvd2001_m).toFixed(2)}m`
            : `0 處水域`;
        const waterToastEn =
          Number(s.water_count || 0) > 0 && s.water_level_twvd2001_m !== null && s.water_level_twvd2001_m !== undefined
            ? `${s.water_count} Water Zones · +${Number(s.water_level_twvd2001_m).toFixed(2)}m`
            : `0 Water Zones`;
        const visTagZh = STATE.categorizeOverlayVisible ? "3D 圖層顯示中" : "已儲存於伺服器 · 預設隱藏";
        const visTagEn = STATE.categorizeOverlayVisible ? "3D Overlays Visible" : "Saved on Server · Hidden by Default";
        showToast(
          tr(
            `AI 分類完成 · ${visTagZh}：道路 ${s.roads_count || 0} 處 · ${s.roads_planar_area_m2 || 0}m²、樹木 ${s.trees_count || 0} 棵 · 平均胸徑 ${s.trees_mean_dbh_cm || 0}cm、${waterToastZh}、牆體 ${s.walls_count || 0} 處`,
            `Categorized · ${visTagEn}: ${s.roads_count || 0} Roads · ${s.roads_planar_area_m2 || 0}m², ${s.trees_count || 0} Trees · DBH ${s.trees_mean_dbh_cm || 0}cm, ${waterToastEn}, ${s.walls_count || 0} Walls`
          )
        );
      } catch (err) {
        if (box) {
          box.innerHTML = `<div style="color:#ef4444;font-size:11.5px;padding:10px;">${tr("AI 分類錯誤：", "Categorization Error: ")}${escapeHtml(err.message)}</div>`;
        }
        showToast(tr(`AI 分類錯誤：${err.message}`, `Categorization Error: ${err.message}`));
      }
    };

    document.getElementById("btnRunCategorize")?.addEventListener("click", () => runCategorize(false, true));
    document.getElementById("btnRecomputeCategorize")?.addEventListener("click", () => runCategorize(true, true));

    const initialShow =
      typeof opts.showOverlays === "boolean"
        ? opts.showOverlays
        : opts.forceRecompute
        ? true
        : Boolean(STATE.categorizeOverlayVisible);
    await runCategorize(Boolean(opts.forceRecompute), initialShow);
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
    add2DBadge(p1, tr("剖面 A", "Section A"), "#ff3b30", { offsetY: -18, isProfile: true });

    if (!p2) {
      updateZoomInvariantElements();
      return;
    }

    add3DPinMarker(p2, 0x0284c7, studioThree.overlayGroup, addProfObj);
    const distM = p1.distanceTo(p2);
    const horizDist = Math.max(0.01, Math.hypot(p2.x - p1.x, p2.z - p1.z));
    const dh =
      Array.isArray(samples) && samples.length >= 2
        ? samples[samples.length - 1].elevation_m - samples[0].elevation_m
        : p2.y - p1.y;
    const slopePctStr = ((Math.abs(dh) / horizDist) * 100).toFixed(1);
    const slopeDhLStr = typeof formatSlopeDhL === "function" ? formatSlopeDhL(dh, horizDist) : "0:1";
    add2DBadge(
      p2,
      tr(
        `剖面 B · ${distM.toFixed(2)}m · ${slopePctStr}% (${slopeDhLStr})`,
        `Section B · ${distM.toFixed(2)}m · ${slopePctStr}% (${slopeDhLStr})`
      ),
      "#0284c7",
      { offsetY: -18, isProfile: true }
    );

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
      twd97_e: 0,
      twd97_n: 0,
      twd97_h: 0,
    };
    const originTwd = localToTwd97({ x: 0, y: 0, z: 0 });
    const ce = Number(originTwd.e || 0);
    const cn = Number(originTwd.n || 0);
    const ch = Number(originTwd.h || 0);

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

    const overallDh = samples.length >= 2 ? Number((samples[samples.length - 1].elevation_m - samples[0].elevation_m).toFixed(3)) : 0;
    const overallSlopePct = Number(((Math.abs(overallDh) / Math.max(0.01, totalLen)) * 100).toFixed(1));
    const overallSlopeDhL = typeof formatSlopeDhL === "function" ? formatSlopeDhL(overallDh, totalLen) : "0:1";

    return {
      status: "ok",
      scan_id: activeScan.scan_id,
      compare_scan_name: "Chord Grade Datum (A→B)",
      crs: "TWD97 (121) + TWVD2001",
      total_length_m: Number(totalLen.toFixed(2)),
      max_slope_pct: Number(maxSlopePct.toFixed(1)),
      overall_dh_m: overallDh,
      overall_slope_pct: overallSlopePct,
      overall_slope_dhl: overallSlopeDhL,
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
    const hasUserEndpoints = Boolean(
      (p1 && p2) || (Array.isArray(STATE.profileEndpoints) && STATE.profileEndpoints.length >= 2)
    );
    if (window.innerWidth <= 768) {
      STATE.sidePanelMinimized = !hasUserEndpoints;
    } else {
      STATE.sidePanelMinimized = false;
    }
    const resolveEndpoints = () => {
      if (p1 && p2) return [p1, p2];
      if (STATE.profileEndpoints && STATE.profileEndpoints.length >= 2) return STATE.profileEndpoints;
      return null;
    };

    const isMobProfile = window.innerWidth <= 768;
    const profCanvasH = isMobProfile ? 118 : 196;
    showSidePanel(
      `<span>${tr("高程縱斷面圖", "Cross-Section Profile")}</span>`,
      `
      <div style="display:${isMobProfile ? "none" : "block"};font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:7px;padding:7px 9px;margin-bottom:8px;line-height:1.4;">
        ${tr(
          "於 3D 掃描模型上點擊 <b>2 個端點（剖面 A &rarr; B）</b>，即可沿自訂剖面線取樣 TWVD2001 高程與坡度。滑鼠移至圖表上可同步檢視 2D 與 3D 樁號高程。",
          "Click <b>2 points · Section A &rarr; B</b> on the 3D scan to sample TWVD2001 elevation &amp; slope along your custom section line. Hover over the chart to inspect any chainage station in 2D &amp; 3D."
        )}
      </div>
      <div style="display:flex;gap:${isMobProfile ? 4 : 6}px;margin-bottom:${isMobProfile ? 4 : 8}px;">
        <button type="button" class="gs-top-btn accent" style="flex:1.4;justify-content:center;${isMobProfile ? "height:26px;font-size:11px;padding:0 6px;" : ""}" id="btnComputeProfileNow" title="${tr("計算／重新取樣高程縱斷面", "Compute / Resample Cross-Section Profile")}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
          <span id="lblComputeProfileBtn">${tr("計算斷面", "Compute Profile")}</span>
        </button>
        <button type="button" class="gs-top-btn" style="flex:1;justify-content:center;${isMobProfile ? "height:26px;font-size:11px;padding:0 6px;" : ""}" id="btnNewProfileLine" title="${tr("於 3D 模型重新點選剖面 A → B", "Pick New Section A → B Line on 3D Scan")}">
          <span>${tr("重選 A–B 線", "New A–B Line")}</span>
        </button>
        <button type="button" class="gs-top-btn" style="flex:0.8;justify-content:center;${isMobProfile ? "height:26px;font-size:11px;padding:0 6px;" : ""}" id="btnExportProfileCsv" title="${tr("匯出縱斷面 CSV 報表", "Export Cross-Section CSV")}">
          <span>CSV</span>
        </button>
      </div>
      <div id="profileHoverReadout" style="font-size:${isMobProfile ? "10.5px" : "11px"};font-family:var(--font-mono);color:var(--ui-text-primary);background:var(--ui-bg-subtle);border:1px solid var(--ui-border);border-radius:6px;padding:${isMobProfile ? "3px 6px" : "5px 8px"};margin-bottom:${isMobProfile ? 4 : 6}px;display:flex;justify-content:space-between;">
        <span>${tr("滑鼠移至圖表以檢視樁號高程", "Hover chart to inspect station")}</span>
        <span style="color:var(--ui-accent);">TWVD2001 (m)</span>
      </div>
      <canvas id="profileChartCanvas" width="336" height="${profCanvasH}" style="width:100%;height:${profCanvasH}px;background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);border-radius:8px;cursor:crosshair;"></canvas>
      <div class="gs-metric-grid" id="profileMetricsBox" style="margin-top:${isMobProfile ? 6 : 8}px;"></div>
      `
    );

    const runProfileCalc = async () => {
      const eps = resolveEndpoints();
      if (!eps || eps.length < 2) {
        showToast(tr("請先在 3D 掃描模型上點擊起點 A 與終點 B", "Please click Start Point A and End Point B on the 3D scan first"));
        return;
      }
      const [ep1, ep2] = eps;
      const btnLbl = document.getElementById("lblComputeProfileBtn");
      if (btnLbl) btnLbl.textContent = tr("取樣計算中...", "Sampling...");

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
        if (btnLbl) btnLbl.textContent = tr("計算斷面", "Compute Profile");
      }
    };

    document.getElementById("btnComputeProfileNow")?.addEventListener("click", () => {
      runProfileCalc().then(() => {
        const r = STATE.lastProfileResult;
        if (r)
          showToast(
            tr(
              `已完成縱斷面取樣 · 總長 ${r.total_length_m} m · 最大坡度 ${r.max_slope_pct}%`,
              `Sampled Cross-Section Profile · ${r.total_length_m} m · Max Grade ${r.max_slope_pct}%`
            )
          );
      });
    });

    document.getElementById("btnNewProfileLine")?.addEventListener("click", () => {
      setActiveStudioTool("profile");
      STATE.measurePoints = [];
      STATE.profileEndpoints = [];
      clearProfileVisualsOnly();
      if (window.innerWidth <= 768) {
        STATE.sidePanelMinimized = true;
        const pEl = document.getElementById("studioSidePanel");
        pEl?.classList.add("mobile-minimized", "gs-panel-minimized");
        const lblCol = document.getElementById("lblCollapseSidePanel");
        if (lblCol) lblCol.textContent = tr("▴ 展開", "▴ Expand");
      }
      syncStudioMobileToolHud();
      showToast(tr("請在 3D 掃描模型上點擊起點 A 與終點 B", "Click Start Point A and End Point B on the 3D scan"));
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
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `cross_section_profile_${STATE.activeScanId || "scan"}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
      showToast("Downloaded Cross-Section Profile CSV");
    });

    const canvas = document.getElementById("profileChartCanvas");
    if (canvas) {
      const scrubProfileAtClientX = (clientX) => {
        if (!Number.isFinite(clientX)) return;
        const r = STATE.lastProfileResult;
        if (!r || !Array.isArray(r.samples) || !r.samples.length) return;
        const rect = canvas.getBoundingClientRect();
        const cssW = Math.max(1, rect.width || 336);
        const relX = ((clientX - rect.left) / cssW) * 336;
        const padL = 44;
        const padR = 14;
        const frac = Math.max(0, Math.min(1, (relX - padL) / Math.max(1, 336 - padL - padR)));
        const idx = Math.round(frac * (r.samples.length - 1));
        drawProfileCanvas(r, idx);
        setProfileHoverMarker3D(r.samples[idx]);
      };
      canvas.addEventListener("mousemove", (ev) => scrubProfileAtClientX(ev.clientX));
      canvas.addEventListener("pointerdown", (ev) => scrubProfileAtClientX(ev.clientX));
      canvas.addEventListener("pointermove", (ev) => scrubProfileAtClientX(ev.clientX));
      canvas.addEventListener(
        "touchstart",
        (ev) => {
          if (ev.touches && ev.touches[0]) {
            scrubProfileAtClientX(ev.touches[0].clientX);
          }
        },
        { passive: true }
      );
      canvas.addEventListener(
        "touchmove",
        (ev) => {
          if (ev.touches && ev.touches[0]) {
            ev.preventDefault();
            scrubProfileAtClientX(ev.touches[0].clientX);
          }
        },
        { passive: false }
      );
      canvas.addEventListener("mouseleave", () => {
        if (STATE.lastProfileResult) drawProfileCanvas(STATE.lastProfileResult, null);
        setProfileHoverMarker3D(null);
      });
    }

    if (hasUserEndpoints) {
      await runProfileCalc();
    } else {
      const readoutEl = document.getElementById("profileHoverReadout");
      if (readoutEl) {
        readoutEl.innerHTML = `<span style="color:var(--ui-accent);font-weight:700;">⏳ ${tr("等待點選 2 個端點（剖面 A → B）...", "Waiting for 2 points (Section A → B) on 3D scan...")}</span><span>TWVD2001</span>`;
      }
      const mBox = document.getElementById("profileMetricsBox");
      if (mBox) {
        mBox.innerHTML = `<div style="grid-column:1 / -1;font-size:11.5px;color:var(--ui-text-secondary);background:var(--ui-bg-subtle);border:1px dashed var(--ui-border-strong);border-radius:8px;padding:10px 12px;text-align:center;">
          📐 ${tr("請在 3D 掃描模型上點擊 <b>起點 A</b> 與 <b>終點 B</b> 建立縱橫斷面", "Click <b>Start Point A</b> and <b>End Point B</b> on the 3D scan to generate the cross-section profile")}
        </div>`;
      }
    }
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
    ctx.fillText(tr("● 地表高程 TWVD2001", "● Surface TWVD2001"), padL, 10);
    ctx.fillStyle = "#0ea5e9";
    ctx.fillText(tr("■ 填方", "■ Fill"), padL + 118, 10);
    ctx.fillStyle = "#ef4444";
    ctx.fillText(tr("■ 挖方", "■ Cut"), padL + 152, 10);
    ctx.fillStyle = isDark ? "#94a3b8" : "#64748b";
    const rawDatumLbl = String(res.compare_scan_name || "Datum");
    const datumLbl =
      rawDatumLbl === "Chord Grade Datum (A→B)"
        ? tr("起終點坡度基準線 A→B", "Chord Grade Datum A→B")
        : rawDatumLbl === "Datum"
        ? tr("基準面", "Datum")
        : rawDatumLbl;
    ctx.fillText(`--- ${datumLbl}`, padL + 186, 10);

    const overallDh = samples[samples.length - 1].elevation_m - samples[0].elevation_m;
    const horizLen = Math.max(0.01, Number(res.total_length_m) || 0.01);
    const overallSlopePct =
      res.overall_slope_pct !== undefined
        ? Number(res.overall_slope_pct).toFixed(1)
        : ((Math.abs(overallDh) / horizLen) * 100).toFixed(1);
    const overallSlopeDhL =
      res.overall_slope_dhl ||
      (typeof formatSlopeDhL === "function" ? formatSlopeDhL(overallDh, horizLen) : "0:1");

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
        readoutEl.innerHTML = `<span>${tr("樁號", "Sta")} <b>${hs.chainage_m.toFixed(2)}m</b> · ${tr("坡度", "Grade")} <b>${hs.slope_pct}%</b></span><span style="color:var(--ui-accent);">H: <b>+${hs.elevation_m.toFixed(2)}m</b> · ΔZ ${hs.delta_z_m >= 0 ? "+" : ""}${hs.delta_z_m.toFixed(2)}m</span>`;
      }
    } else if (readoutEl) {
      readoutEl.innerHTML = `<span>A→B: <b>${overallSlopePct}% (${overallSlopeDhL})</b></span><span style="color:var(--ui-accent);">ΔH: <b>${(overallDh >= 0 ? "+" : "") + overallDh.toFixed(2)}m</b> · L: <b>${res.total_length_m}m</b></span>`;
    }
    ctx.restore();

    const maxAbsDz = Math.max(...samples.map((s) => Math.abs(s.delta_z_m || 0)));
    const mBox = document.getElementById("profileMetricsBox");
    if (mBox) {
      mBox.innerHTML = `
        <div class="gs-metric-box">
          <div class="lbl">${tr("斷面總長", "Section Length")}</div>
          <div class="val" style="color:var(--ui-accent);">${res.total_length_m} m</div>
        </div>
        <div class="gs-metric-box">
          <div class="lbl">${tr("起終點坡度 A→B", "Slope A→B (% & dh:L)")}</div>
          <div class="val" style="color:#f59e0b;">${overallSlopePct}% (${overallSlopeDhL})</div>
        </div>
        <div class="gs-metric-box">
          <div class="lbl">${tr("最大局部坡度", "Max Local Grade")}</div>
          <div class="val">${res.max_slope_pct}%</div>
        </div>
        <div class="gs-metric-box">
          <div class="lbl">${tr("高程範圍 H", "Elev Range H")}</div>
          <div class="val">+${rawMinZ.toFixed(2)}~+${rawMaxZ.toFixed(2)}m (ΔZ ${maxAbsDz.toFixed(2)}m)</div>
        </div>
      `;
    }
  }

  // 3D. RTK Raw Camera Photo Inspector
  async function openRtkPhotoInspector(pt = new THREE.Vector3(0, 0, 0), fromCanvasClick = false) {
    if (window.innerWidth <= 768) {
      STATE.sidePanelMinimized = !fromCanvasClick;
    } else {
      STATE.sidePanelMinimized = false;
    }
    showSidePanel(
      `<span>RTK Camera Inspector</span>`,
      `<div style="font-size:12px;color:var(--ui-text-secondary);">Querying calibrated PIX4Dcatch RTK camera poses...</div>`
    );
    try {
      const clickTwd = localToTwd97(pt);
      const res = await apiPost("/api/survey/inspect-photos", {
        scan_id: STATE.activeScanId,
        x: pt.x,
        y: pt.y,
        z: pt.z,
        twd_e: clickTwd.e,
        twd_n: clickTwd.n,
        twd_h: clickTwd.h,
      });
      const photosHtml = (res.photos || [])
        .map(
          (p) => `
          <div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border);border-radius:8px;padding:8px;margin-top:8px;">
            <img src="${escapeHtml(p.url)}" alt="${escapeHtml(p.filename)}" style="width:100%;height:140px;object-fit:cover;border-radius:6px;background:var(--ui-bg-pill);" onerror="this.style.display='none'" />
            <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:11px;font-weight:700;color:var(--ui-text-primary);">
              <span>${escapeHtml(p.filename)}</span>
              <span style="color:var(--ui-accent);">RTK σ=${escapeHtml(String(p.rtk_h_sigma_cm))}cm</span>
            </div>
            <div style="font-size:10.5px;font-family:monospace;color:var(--ui-text-muted);margin-top:2px;">
              E:${escapeHtml(String(p.camera_twd97_e))}m | N:${escapeHtml(String(p.camera_twd97_n))}m | H:+${escapeHtml(String(p.camera_twd97_h))}m | Dist:${escapeHtml(String(p.distance_m))}m
            </div>
          </div>
        `
        )
        .join("");

      showSidePanel(
        `<span>RTK Camera Inspector</span>`,
        `
        <div style="font-size:11px;font-family:monospace;color:var(--ui-text-secondary);margin-bottom:6px;">
          Target: ${escapeHtml(formatScanCoordReadout({ e: Number(res.target_twd97?.e || 0), n: Number(res.target_twd97?.n || 0), h: Number(res.target_twd97?.h || 0) }, STATE.activeScan))}
        </div>
        ${photosHtml || '<div style="font-size:12px;color:var(--ui-text-muted);">No local raw photos found for this point.</div>'}
        `
      );
    } catch (err) {
      showToast(`Photo Inspector Error: ${err.message}`);
    }
  }

  // 3E. Section Box Clipping Inspector (Waits for 2 user clicks P1->P2 before creating section box; no random initial section)
  function openSectionBoxInspector(p1 = null, p2 = null) {
    setActiveStudioTool("section");
    if (p1 && p2) {
      STATE.sectionBoxEndpoints = [p1.clone(), p2.clone()];
    }
    const eps =
      p1 && p2
        ? [p1, p2]
        : Array.isArray(STATE.sectionBoxEndpoints) && STATE.sectionBoxEndpoints.length >= 2
        ? STATE.sectionBoxEndpoints
        : null;
    const hasTwoPoints = Boolean(eps && eps.length >= 2);
    if (window.innerWidth <= 768) {
      STATE.sidePanelMinimized = !hasTwoPoints;
    } else {
      STATE.sidePanelMinimized = false;
    }
    const rawR = Math.max(20, computeStudioEffectiveBoundingRadius());
    const maxHoriz = Math.ceil(rawR * 1.35);
    const centerX = hasTwoPoints ? 0.5 * (eps[0].x + eps[1].x) : 0;
    const centerZ = hasTwoPoints ? 0.5 * (eps[0].z + eps[1].z) : 0;
    const initHorizX = hasTwoPoints
      ? Math.max(2, Math.min(maxHoriz, Math.ceil(Math.abs(eps[1].x - eps[0].x) * 0.5 + 1)))
      : Math.ceil(rawR * 1.05);
    const initHorizZ = hasTwoPoints
      ? Math.max(2, Math.min(maxHoriz, Math.ceil(Math.abs(eps[1].z - eps[0].z) * 0.5 + 1)))
      : Math.ceil(rawR * 1.05);
    const maxElev = Math.max(25, Math.ceil(rawR * 0.75));
    const minElev = -Math.max(20, Math.ceil(rawR * 0.55));
    const initYTop = Math.ceil(maxElev * 0.85);
    const initYBot = Math.floor(minElev * 0.85);

    showSidePanel(
      `<span>${tr("3D 剖面盒裁切器", "Section Box Slicer")}</span>`,
      `
      <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:7px;padding:7px 9px;margin-bottom:9px;line-height:1.4;">
        ${
          hasTwoPoints
            ? tr(
                `已根據您點選的 2 點建立剖面盒。拖曳滑桿可微調 X、Z、頂部 (+Y) 與底部 (-Y) 裁切平面。`,
                `Section box created from your 2 selected points. Drag sliders below to adjust X, Z, Top (+Y), and Bottom (-Y) planes.`
              )
            : tr(
                `請先在 3D 掃描模型上點擊 <b>2 個端點 (P1 &rarr; P2)</b> 建立剖面裁切範圍（或直接拖曳下方滑桿）。`,
                `Click <b>2 points (P1 &rarr; P2)</b> on the 3D scan to create a section box (or drag any slider below).`
              )
        }
      </div>
      <div class="gs-form-group">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <label>${tr("東西向裁切範圍 (±X m)", "East-West Clipping Bound (±X m)")}</label>
          <span id="lblSecClipX" style="font-size:11px;font-family:var(--font-mono);color:var(--ui-accent);">±${initHorizX} m</span>
        </div>
        <input type="range" min="2" max="${maxHoriz}" step="1" value="${initHorizX}" class="gs-input" id="secClipX" />
      </div>
      <div class="gs-form-group">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <label>${tr("南北向裁切範圍 (±Z m)", "North-South Clipping Bound (±Z m)")}</label>
          <span id="lblSecClipZ" style="font-size:11px;font-family:var(--font-mono);color:var(--ui-accent);">±${initHorizZ} m</span>
        </div>
        <input type="range" min="2" max="${maxHoriz}" step="1" value="${initHorizZ}" class="gs-input" id="secClipZ" />
      </div>
      <div class="gs-form-group">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <label>${tr("頂部高程裁切上限 (+Y m)", "Top Ceiling Bound (+Y Elevation m)")}</label>
          <span id="lblSecClipY" style="font-size:11px;font-family:var(--font-mono);color:var(--ui-accent);">+${initYTop} m</span>
        </div>
        <input type="range" min="${minElev}" max="${maxElev}" step="0.5" value="${initYTop}" class="gs-input" id="secClipY" />
      </div>
      <div class="gs-form-group">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <label>${tr("底部高程裁切下限 (-Y m)", "Bottom Floor Bound (-Y Elevation m)")}</label>
          <span id="lblSecClipYMin" style="font-size:11px;font-family:var(--font-mono);color:var(--ui-accent);">${initYBot} m</span>
        </div>
        <input type="range" min="${minElev}" max="${maxElev}" step="0.5" value="${initYBot}" class="gs-input" id="secClipYMin" />
      </div>
      <label style="display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--ui-text-primary);cursor:pointer;margin:8px 0 10px;">
        <input type="checkbox" id="chkKeepSectionClip" ${STATE.keepSectionBoxClip ? "checked" : ""} />
        <span>${tr("關閉面板後保留剖面裁切", "Keep Clipping Active When Panel Closed")}</span>
      </label>
      <button type="button" class="gs-top-btn" id="btnResetSectionBox" style="width:100%;justify-content:center;" title="${tr("重設剖面盒裁切面", "Reset Clipping Planes")}">
        <span>${tr("重設剖面盒", "Reset Section Box")}</span>
      </button>
      `
    );

    const updateWireframeBox = (cx, cz, yMin, yMax) => {
      if (!studioThree || !studioThree.overlayGroup) return;
      if (studioThree._sectionBoxHelper) {
        studioThree.overlayGroup.remove(studioThree._sectionBoxHelper);
        if (studioThree._sectionBoxHelper.geometry) studioThree._sectionBoxHelper.geometry.dispose();
        if (studioThree._sectionBoxHelper.material) studioThree._sectionBoxHelper.material.dispose();
        studioThree._sectionBoxHelper = null;
      }
      const w = Math.max(0.5, cx * 2);
      const h = Math.max(0.5, yMax - yMin);
      const d = Math.max(0.5, cz * 2);
      const boxGeo = new THREE.BoxGeometry(w, h, d);
      const edgesGeo = new THREE.EdgesGeometry(boxGeo);
      boxGeo.dispose();
      const lineMat = new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        depthTest: false,
        transparent: true,
        opacity: 0.85,
      });
      const wireframe = new THREE.LineSegments(edgesGeo, lineMat);
      wireframe.position.set(centerX, 0.5 * (yMin + yMax), centerZ);
      wireframe.renderOrder = 997;
      studioThree.overlayGroup.add(wireframe);
      studioThree._sectionBoxHelper = wireframe;
    };

    const updateClip = () => {
      if (!studioThree) return;
      const cx = parseFloat(document.getElementById("secClipX")?.value || String(initHorizX));
      const cz = parseFloat(document.getElementById("secClipZ")?.value || String(initHorizZ));
      let cyTop = parseFloat(document.getElementById("secClipY")?.value || String(initYTop));
      let cyBot = parseFloat(document.getElementById("secClipYMin")?.value || String(initYBot));
      if (cyBot >= cyTop - 0.5) {
        cyBot = cyTop - 0.5;
        const botEl = document.getElementById("secClipYMin");
        if (botEl) botEl.value = String(cyBot);
      }
      const lblX = document.getElementById("lblSecClipX");
      if (lblX) lblX.textContent = `±${cx} m`;
      const lblZ = document.getElementById("lblSecClipZ");
      if (lblZ) lblZ.textContent = `±${cz} m`;
      const lblY = document.getElementById("lblSecClipY");
      if (lblY) lblY.textContent = `${cyTop >= 0 ? "+" : ""}${cyTop} m`;
      const lblYMin = document.getElementById("lblSecClipYMin");
      if (lblYMin) lblYMin.textContent = `${cyBot >= 0 ? "+" : ""}${cyBot} m`;

      studioThree.renderer.clippingPlanes = [
        new THREE.Plane(new THREE.Vector3(-1, 0, 0), centerX + cx),
        new THREE.Plane(new THREE.Vector3(1, 0, 0), cx - centerX),
        new THREE.Plane(new THREE.Vector3(0, -1, 0), cyTop),
        new THREE.Plane(new THREE.Vector3(0, 1, 0), -cyBot),
        new THREE.Plane(new THREE.Vector3(0, 0, -1), centerZ + cz),
        new THREE.Plane(new THREE.Vector3(0, 0, 1), cz - centerZ),
      ];
      updateWireframeBox(cx, cz, cyBot, cyTop);
    };

    ["secClipX", "secClipZ", "secClipY", "secClipYMin"].forEach((id) => {
      document.getElementById(id)?.addEventListener("input", updateClip);
    });
    document.getElementById("chkKeepSectionClip")?.addEventListener("change", (e) => {
      STATE.keepSectionBoxClip = Boolean(e.target.checked);
    });
    document.getElementById("btnResetSectionBox")?.addEventListener("click", () => {
      STATE.sectionBoxEndpoints = [];
      STATE.measurePoints = [];
      const elX = document.getElementById("secClipX");
      const elZ = document.getElementById("secClipZ");
      const elY = document.getElementById("secClipY");
      const elYMin = document.getElementById("secClipYMin");
      if (elX) elX.value = String(maxHoriz);
      if (elZ) elZ.value = String(maxHoriz);
      if (elY) elY.value = String(maxElev);
      if (elYMin) elYMin.value = String(minElev);
      if (studioThree) {
        studioThree.renderer.clippingPlanes = [];
        if (studioThree._sectionBoxHelper) {
          studioThree.overlayGroup?.remove(studioThree._sectionBoxHelper);
          if (studioThree._sectionBoxHelper.geometry) studioThree._sectionBoxHelper.geometry.dispose();
          if (studioThree._sectionBoxHelper.material) studioThree._sectionBoxHelper.material.dispose();
          studioThree._sectionBoxHelper = null;
        }
      }
      showToast("Section Box clipping reset — click 2 points on scan to create new section box");
    });

    if (hasTwoPoints) {
      updateClip();
    } else if (studioThree) {
      studioThree.renderer.clippingPlanes = [];
      if (studioThree._sectionBoxHelper) {
        studioThree.overlayGroup?.remove(studioThree._sectionBoxHelper);
        if (studioThree._sectionBoxHelper.geometry) studioThree._sectionBoxHelper.geometry.dispose();
        if (studioThree._sectionBoxHelper.material) studioThree._sectionBoxHelper.material.dispose();
        studioThree._sectionBoxHelper = null;
      }
    }
  }

  // 3F. 3D Geo-Comments Inspector
  async function openCommentsInspector(clickedPt = null, clickedTwd = null) {
    setActiveStudioTool("comments");
    if (window.innerWidth <= 768) {
      STATE.sidePanelMinimized = !clickedPt;
    } else {
      STATE.sidePanelMinimized = false;
    }
    const detail = await apiGet(`/api/scans/${STATE.activeScanId}`);
    const scan = detail.scan;
    const comments = scan.comments || [];

    const pt = clickedPt || new THREE.Vector3(0, 1.2, 0);
    const twd = clickedTwd || localToTwd97(pt);
    const isExternalOrGuest = Boolean(STATE.shareToken || !STATE.currentUser?.email || STATE.currentUser.email.startsWith("guest@"));
    const savedGuestAuthor = localStorage.getItem("gs_guest_comment_author") || "";

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
      <div style="font-size:11px;color:var(--ui-text-secondary);margin-bottom:8px;">
        Click anywhere on the 3D scan to place the comment pin, then write your note below.
      </div>
      ${
        isExternalOrGuest
          ? `<div class="gs-form-group" style="margin-bottom:8px;">
               <label>Your Name</label>
               <input type="text" class="gs-input" id="txtGuestAuthorName" value="${escapeHtml(savedGuestAuthor)}" placeholder="e.g. Reviewer Name" />
             </div>`
          : ""
      }
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
      const customGuestName = document.getElementById("txtGuestAuthorName")?.value.trim() || "";
      if (isExternalOrGuest && customGuestName) {
        try {
          localStorage.setItem("gs_guest_comment_author", customGuestName);
        } catch (_) {}
      }
      const resolvedAuthorName = isExternalOrGuest
        ? customGuestName || STATE.currentUser?.name || "External Reviewer"
        : STATE.currentUser?.name || "Guest Viewer";
      const resolvedAuthorEmail = isExternalOrGuest
        ? "external@gatheren.cloud"
        : STATE.currentUser?.email || "guest@gatheren.cloud";
      try {
        await apiPost("/api/comments", {
          scan_id: STATE.activeScanId,
          author_email: resolvedAuthorEmail,
          author_name: resolvedAuthorName,
          text,
          pos_x: pt.x,
          pos_y: pt.y,
          pos_z: pt.z,
          twd97_e: twd.e,
          twd97_n: twd.n,
          twd97_h: twd.h,
        });
        SHARE_TELEMETRY.recordCommentPosted(resolvedAuthorName, text);
        const bannerNameInp = document.getElementById("inpShareViewerName");
        if (bannerNameInp && customGuestName) {
          bannerNameInp.value = customGuestName;
        }
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


