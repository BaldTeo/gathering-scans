/**
 * GatheringScans Frontend Module 07 — Multi-Date Side-by-Side Curtain Slider, Change Heatmap, Theme Switcher & Smart Queue Modal
 */
"use strict";

  // ============================================================================
  // 4. MULTI-DATE SIDE-BY-SIDE CURTAIN SLIDER (Requirement 4)
  // ============================================================================
  let compareCtx = null;

  // Dynamic CRS & world-space classifier for Multi-Date Compare (100% derived from scan bounds & metadata)
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
      const worldZ = c.z < -50 && metaH > -50 && metaH !== 0 ? metaH : c.z;
      return {
        crs: "TWD97",
        rawCenter: c.clone(),
        twdCenter: new THREE.Vector3(c.x, c.y, worldZ),
        rotZ: 0,
        scaleXY: 1.0,
        radius,
      };
    }

    // Case 2: UTM Zone 51N coordinates (345,000 < E <= 415,000; 2,400,000 <= N <= 2,850,000)
    if (c.x > 345000 && c.x <= 415000 && c.y >= 2400000 && c.y <= 2850000) {
      const refLat = hasValidGeorefLatLon(meta) ? Number(meta.lat) : c.y / 110760.0;
      const refLon = hasValidGeorefLatLon(meta) ? Number(meta.lon) : 123.0 + (c.x - 500000.0) / 101750.0;
      const jac = computeConformalJacobianJS(
        refLat,
        refLon,
        { lon0: 123.0, fe: 500000.0, k0: 0.9996, fInv: 298.257223563 },
        { lon0: 121.0, fe: 250000.0, k0: 0.9999, fInv: 298.257222101 }
      );
      return {
        crs: "UTM51N",
        rawCenter: c.clone(),
        twdCenter: new THREE.Vector3(metaE || c.x, metaN || c.y, metaH || c.z),
        rotZ: jac.rotZ,
        scaleXY: jac.scaleXY,
        radius,
      };
    }

    // Case 3: Local / ECEF fallback
    return {
      crs: "LOCAL",
      rawCenter: c.clone(),
      twdCenter: new THREE.Vector3(metaE, metaN, metaH || (Number.isFinite(c.z) && Math.abs(c.z) < 5000 ? c.z : 0)),
      rotZ: 0,
      scaleXY: 1.0,
      radius,
    };
  }

  function findMergedComponentAlignment(compSide, compInfo, unifiedSide) {
    if (!compSide || !compInfo || !unifiedSide) return null;
    const mfList = Array.isArray(unifiedSide.scanMeta?.merged_from) ? unifiedSide.scanMeta.merged_from : [];
    if (!mfList.length) return null;
    const compId = String(compSide._loadedScanId || compSide.scanMeta?.scan_id || "");
    const compDerived = String(compSide.scanMeta?.derived_from_scan_id || "");
    const compName = String(compSide.scanMeta?.name || "").trim();
    const entry = mfList.find(
      (m) =>
        m &&
        (m.scan_id === compId ||
          (compDerived && m.scan_id === compDerived) ||
          (m.derived_from_scan_id && m.derived_from_scan_id === compId) ||
          (compName && m.name && String(m.name).trim() === compName))
    );
    if (!entry) return null;

    const mat4Zup = new THREE.Matrix4();
    if (Array.isArray(entry.r_zup_rowmajor) && entry.r_zup_rowmajor.length === 9) {
      const r = entry.r_zup_rowmajor.map(Number);
      mat4Zup.set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1);
    } else if (Array.isArray(entry.quaternion_three) && entry.quaternion_three.length >= 4) {
      const q3 = new THREE.Quaternion(
        Number(entry.quaternion_three[0]) || 0,
        Number(entry.quaternion_three[1]) || 0,
        Number(entry.quaternion_three[2]) || 0,
        Number(entry.quaternion_three[3] ?? 1)
      ).normalize();
      const mThree = new THREE.Matrix4().makeRotationFromQuaternion(q3);
      const rxPos90 = new THREE.Matrix4().makeRotationX(Math.PI / 2);
      const rxNeg90 = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
      mat4Zup.multiplyMatrices(rxPos90, mThree).multiply(rxNeg90);
    }

    let nativeAnchor = null;
    let mergedAnchor = null;
    if (
      Array.isArray(entry.native_anchor_zup) &&
      entry.native_anchor_zup.length >= 3 &&
      Array.isArray(entry.merged_anchor_zup) &&
      entry.merged_anchor_zup.length >= 3
    ) {
      nativeAnchor = new THREE.Vector3(
        Number(entry.native_anchor_zup[0]),
        Number(entry.native_anchor_zup[1]),
        Number(entry.native_anchor_zup[2])
      );
      mergedAnchor = new THREE.Vector3(
        Number(entry.merged_anchor_zup[0]),
        Number(entry.merged_anchor_zup[1]),
        Number(entry.merged_anchor_zup[2])
      );
    } else if (Array.isArray(entry.zup_shift) && entry.zup_shift.length >= 3) {
      nativeAnchor = compInfo.rawCenter.clone();
      mergedAnchor = compInfo.rawCenter
        .clone()
        .add(new THREE.Vector3(Number(entry.zup_shift[0]) || 0, Number(entry.zup_shift[1]) || 0, Number(entry.zup_shift[2]) || 0));
    }
    if (!nativeAnchor || !mergedAnchor) return null;
    const qZup = new THREE.Quaternion().setFromRotationMatrix(mat4Zup);
    return { compSide, nativeAnchor, mergedAnchor, mat4Zup, qZup };
  }

  function getActiveCompareSides() {
    if (!compareCtx) return [];
    const cnt = Math.max(2, Math.min(4, Number(STATE.compareScanCount) || 2));
    const list = [compareCtx.left, compareCtx.right];
    if (cnt >= 3 && compareCtx.third) list.push(compareCtx.third);
    if (cnt >= 4 && compareCtx.fourth) list.push(compareCtx.fourth);
    return list.filter(Boolean);
  }

  function alignCompareSides() {
    if (!compareCtx) return;
    const left = compareCtx.left;
    const right = compareCtx.right;
    const third = compareCtx.third;
    const fourth = compareCtx.fourth;
    const lInfo = classifyCompareSideCoords(left);
    const rInfo = classifyCompareSideCoords(right);
    const tInfo = classifyCompareSideCoords(third);
    const fInfo = classifyCompareSideCoords(fourth);

    // Choose a single shared TWD97 reference anchor so all active scans lock 1:1 in world space.
    let sharedAnchor = null;
    let sameVerticalDatum = true;
    const mergedLink =
      findMergedComponentAlignment(left, lInfo, right) ||
      findMergedComponentAlignment(right, rInfo, left);

    if (lInfo && rInfo) {
      const bothGeoref =
        (lInfo.crs === "TWD97" || lInfo.crs === "UTM51N") &&
        (rInfo.crs === "TWD97" || rInfo.crs === "UTM51N");
      const dist2D = Math.hypot(
        lInfo.twdCenter.x - rInfo.twdCenter.x,
        lInfo.twdCenter.y - rInfo.twdCenter.y
      );
      if (mergedLink && bothGeoref) {
        sharedAnchor = mergedLink.mergedAnchor.clone();
        sameVerticalDatum = true;
      } else if (bothGeoref && dist2D < 2500) {
        sharedAnchor = (rInfo.radius <= lInfo.radius ? rInfo.twdCenter : lInfo.twdCenter).clone();
        sameVerticalDatum = Math.abs(lInfo.twdCenter.z - rInfo.twdCenter.z) <= 25.0;
      }
    } else if (lInfo && (lInfo.crs === "TWD97" || lInfo.crs === "UTM51N")) {
      sharedAnchor = lInfo.twdCenter.clone();
    }

    [
      [left, lInfo],
      [right, rInfo],
      [third, tInfo],
      [fourth, fInfo],
    ].forEach(([side, info]) => {
      if (!side || !info) return;
      const rootObj = side.tilesRenderer?.group || side.loadedMesh;
      if (!rootObj) return;
      // 1. Center raw tileset/mesh vertices on rawCenter for 32-bit float precision
      rootObj.position.set(-info.rawCenter.x, -info.rawCenter.y, -info.rawCenter.z);
      rootObj.updateMatrix();

      const sideMergedLink =
        (mergedLink && mergedLink.compSide === side ? mergedLink : null) ||
        findMergedComponentAlignment(side, info, left) ||
        findMergedComponentAlignment(side, info, right);

      // 2. Apply exact Multi-Scan co-registration (when comparing source vs merged) or CRS alignment offset
      if (sideMergedLink && sideMergedLink.compSide === side && sharedAnchor) {
        const deltaRaw = info.rawCenter.clone().sub(sideMergedLink.nativeAnchor).applyMatrix4(sideMergedLink.mat4Zup);
        const tAlign = sideMergedLink.mergedAnchor.clone().sub(sharedAnchor).add(deltaRaw);
        side.alignGroup.position.copy(tAlign);
        side.alignGroup.quaternion.copy(sideMergedLink.qZup);
        side.alignGroup.scale.set(1.0, 1.0, 1.0);
      } else if (sharedAnchor && (info.crs === "TWD97" || info.crs === "UTM51N")) {
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
      const isGlbYUp = Boolean(side.loadedMesh && side._glbIsYUp);
      side.pivot.rotation.set(isGlbYUp ? 0 : THREE.MathUtils.degToRad(270), 0, 0);
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
    [left, right, third, fourth].forEach((s) => {
      if (s?.grid) s.grid.position.y = groundY;
    });

    // Auto-frame camera when a new scan pair finishes loading tilesets
    const pairKey = `${left._loadedScanId || ""}|${right._loadedScanId || ""}`;
    if (lInfo && rInfo && compareCtx._framedPairKey !== pairKey) {
      compareCtx._framedPairKey = pairKey;
      frameCompareCamera(false);
    }
  }

  function frameCompareCamera(showMsg = false) {
    if (!compareCtx) return;
    const { left, right, third, fourth, controls } = compareCtx;
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
    [right, third, fourth].forEach((s) => {
      if (!s) return;
      s.camera.position.copy(left.camera.position);
      s.camera.quaternion.copy(left.camera.quaternion);
      s.camera.updateProjectionMatrix();
      s.camera.updateMatrixWorld();
    });
    if (showMsg) {
      showToast("Reset & Synced Compare Camera Framing");
    }
  }

  function setCompareScanCount(count) {
    const resolvedCount = Math.max(2, Math.min(4, Number(count) || 2));
    STATE.compareScanCount = resolvedCount;
    const stage = document.getElementById("compareStage");
    if (stage) {
      stage.setAttribute("data-compare-count", String(resolvedCount));
    }
    const thirdWrap = document.getElementById("compareThirdWrap");
    const fourthWrap = document.getElementById("compareFourthWrap");
    if (thirdWrap) thirdWrap.style.display = resolvedCount >= 3 ? "inline-flex" : "none";
    if (fourthWrap) fourthWrap.style.display = resolvedCount >= 4 ? "inline-flex" : "none";

    document.querySelectorAll("#compareScanCountSwitcher .btn-seg").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.compareCount) === resolvedCount);
    });

    if (resolvedCount >= 3 && STATE.compareMode !== "split") {
      setCompareMode("split");
      return;
    }
    updateCompareLayersLayout();
    syncCompareScansFromDropdowns();
    handleResize();
    requestAnimationFrame(() => handleResize());
  }

  function updateCompareLayersLayout() {
    const resolvedMode = STATE.compareMode === "split" ? "split" : "slider";
    const cnt = Math.max(2, Math.min(4, Number(STATE.compareScanCount) || 2));
    const stage = document.getElementById("compareStage");
    const rightContainer = document.getElementById("compareRightLayer");
    const thirdContainer = document.getElementById("compareThirdLayer");
    const fourthContainer = document.getElementById("compareFourthLayer");
    const divider = document.getElementById("curtainDivider");
    const lblPct = document.getElementById("lblCurtainPct");
    const pct = (compareCtx && compareCtx._curtainPct) || 50;

    if (stage) {
      stage.classList.toggle("mode-split", resolvedMode === "split");
      stage.setAttribute("data-compare-count", String(cnt));
    }
    if (thirdContainer) {
      thirdContainer.style.display = cnt >= 3 ? "block" : "none";
      thirdContainer.style.clipPath = "none";
    }
    if (fourthContainer) {
      fourthContainer.style.display = cnt >= 4 ? "block" : "none";
      fourthContainer.style.clipPath = "none";
    }
    if (rightContainer) {
      rightContainer.style.clipPath = resolvedMode === "split" ? "none" : `inset(0 0 0 ${pct}%)`;
    }
    if (divider) {
      divider.style.display = resolvedMode === "split" ? "none" : "";
    }
    if (lblPct) {
      lblPct.style.display = resolvedMode === "split" ? "none" : "";
      lblPct.textContent = tr(`分割：${Math.round(pct)}%`, `Split: ${Math.round(pct)}%`);
    }
  }

  function setCompareMode(mode) {
    let resolvedMode = mode === "split" ? "split" : "slider";
    if (resolvedMode === "slider" && Number(STATE.compareScanCount) > 2) {
      STATE.compareScanCount = 2;
      const thirdWrap = document.getElementById("compareThirdWrap");
      const fourthWrap = document.getElementById("compareFourthWrap");
      if (thirdWrap) thirdWrap.style.display = "none";
      if (fourthWrap) fourthWrap.style.display = "none";
      document.querySelectorAll("#compareScanCountSwitcher .btn-seg").forEach((btn) => {
        btn.classList.toggle("active", Number(btn.dataset.compareCount) === 2);
      });
    }
    STATE.compareMode = resolvedMode;
    updateCompareLayersLayout();
    document.querySelectorAll("#compareModeSwitcher .btn-seg").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.compareMode === resolvedMode);
    });
    handleResize();
    requestAnimationFrame(() => handleResize());
  }

  function buildCompareBaselineHeightMap() {
    if (!compareCtx || !compareCtx.left || !window.THREE) return null;
    const left = compareCtx.left;
    const right = compareCtx.right;
    const targets = [];
    left.pivot?.traverse((c) => {
      if (c.isMesh && c.visible) targets.push(c);
    });
    if (!targets.length && left.fallbackGroup?.visible) {
      left.fallbackGroup.traverse((c) => {
        if (c.isMesh && c.visible) targets.push(c);
      });
    }

    // Derive tight shared bounds from actual loaded left (and right when available) mesh geometry
    const leftBox = new THREE.Box3();
    for (let i = 0; i < targets.length; i++) {
      targets[i].updateMatrixWorld(true);
      leftBox.expandByObject(targets[i]);
    }
    const rightBox = new THREE.Box3();
    if (right) {
      const rTargets = [];
      right.pivot?.traverse((c) => {
        if (c.isMesh && c.visible) rTargets.push(c);
      });
      if (!rTargets.length && right.fallbackGroup?.visible) {
        right.fallbackGroup.traverse((c) => {
          if (c.isMesh && c.visible) rTargets.push(c);
        });
      }
      for (let i = 0; i < rTargets.length; i++) {
        rTargets[i].updateMatrixWorld(true);
        rightBox.expandByObject(rTargets[i]);
      }
    }

    let minX, maxX, minZ, maxZ;
    if (!leftBox.isEmpty()) {
      minX = leftBox.min.x;
      maxX = leftBox.max.x;
      minZ = leftBox.min.z;
      maxZ = leftBox.max.z;
      if (!rightBox.isEmpty()) {
        const ix0 = Math.max(minX, rightBox.min.x);
        const ix1 = Math.min(maxX, rightBox.max.x);
        const iz0 = Math.max(minZ, rightBox.min.z);
        const iz1 = Math.min(maxZ, rightBox.max.z);
        if (ix1 - ix0 > 4.0 && iz1 - iz0 > 4.0) {
          minX = ix0 - 2.0;
          maxX = ix1 + 2.0;
          minZ = iz0 - 2.0;
          maxZ = iz1 + 2.0;
        }
      }
      if (maxX - minX < 4.0) {
        const cx = 0.5 * (minX + maxX);
        minX = cx - 10.0;
        maxX = cx + 10.0;
      }
      if (maxZ - minZ < 4.0) {
        const cz = 0.5 * (minZ + maxZ);
        minZ = cz - 10.0;
        maxZ = cz + 10.0;
      }
    } else {
      const span = Math.max(20, Math.min(250, Number(left.rawSphere?.radius) || 65));
      minX = -span;
      maxX = span;
      minZ = -span;
      maxZ = span;
    }

    const N = 96;
    const heights = new Float32Array(N * N);
    heights.fill(-1e30);
    const hitsMask = new Uint8Array(N * N);
    let yMin = Infinity,
      yMax = -Infinity,
      ySum = 0,
      hitCount = 0;

    // Fast direct world-space triangle top-surface rasterization into N x N grid
    const spanX = Math.max(1e-4, maxX - minX);
    const spanZ = Math.max(1e-4, maxZ - minZ);
    const scaleX = (N - 1) / spanX;
    const scaleZ = (N - 1) / spanZ;

    for (let mi = 0; mi < targets.length; mi++) {
      const m = targets[mi];
      const posAttr = m.geometry?.attributes?.position;
      if (!posAttr || posAttr.count < 3) continue;
      const idxAttr = m.geometry.index;
      const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(posAttr.count / 3);
      const mw = m.matrixWorld.elements;

      for (let t = 0; t < triCount; t++) {
        const i0 = idxAttr ? idxAttr.getX(t * 3) : t * 3;
        const i1 = idxAttr ? idxAttr.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = idxAttr ? idxAttr.getX(t * 3 + 2) : t * 3 + 2;

        const lx0 = posAttr.getX(i0), ly0 = posAttr.getY(i0), lz0 = posAttr.getZ(i0);
        const wx0 = mw[0] * lx0 + mw[4] * ly0 + mw[8] * lz0 + mw[12];
        const wy0 = mw[1] * lx0 + mw[5] * ly0 + mw[9] * lz0 + mw[13];
        const wz0 = mw[2] * lx0 + mw[6] * ly0 + mw[10] * lz0 + mw[14];

        const lx1 = posAttr.getX(i1), ly1 = posAttr.getY(i1), lz1 = posAttr.getZ(i1);
        const wx1 = mw[0] * lx1 + mw[4] * ly1 + mw[8] * lz1 + mw[12];
        const wy1 = mw[1] * lx1 + mw[5] * ly1 + mw[9] * lz1 + mw[13];
        const wz1 = mw[2] * lx1 + mw[6] * ly1 + mw[10] * lz1 + mw[14];

        const lx2 = posAttr.getX(i2), ly2 = posAttr.getY(i2), lz2 = posAttr.getZ(i2);
        const wx2 = mw[0] * lx2 + mw[4] * ly2 + mw[8] * lz2 + mw[12];
        const wy2 = mw[1] * lx2 + mw[5] * ly2 + mw[9] * lz2 + mw[13];
        const wz2 = mw[2] * lx2 + mw[6] * ly2 + mw[10] * lz2 + mw[14];

        const tMinX = Math.min(wx0, wx1, wx2), tMaxX = Math.max(wx0, wx1, wx2);
        const tMinZ = Math.min(wz0, wz1, wz2), tMaxZ = Math.max(wz0, wz1, wz2);
        if (tMaxX < minX || tMinX > maxX || tMaxZ < minZ || tMinZ > maxZ) continue;

        const gx0 = Math.max(0, Math.floor((tMinX - minX) * scaleX));
        const gx1 = Math.min(N - 1, Math.ceil((tMaxX - minX) * scaleX));
        const gz0 = Math.max(0, Math.floor((tMinZ - minZ) * scaleZ));
        const gz1 = Math.min(N - 1, Math.ceil((tMaxZ - minZ) * scaleZ));

        const denom = (wz1 - wz2) * (wx0 - wx2) + (wx2 - wx1) * (wz0 - wz2);
        if (Math.abs(denom) < 1e-7) {
          const cxIdx = Math.max(0, Math.min(N - 1, Math.round(((wx0 + wx1 + wx2) / 3.0 - minX) * scaleX)));
          const czIdx = Math.max(0, Math.min(N - 1, Math.round(((wz0 + wz1 + wz2) / 3.0 - minZ) * scaleZ)));
          const cCell = czIdx * N + cxIdx;
          const cy = Math.max(wy0, wy1, wy2);
          if (cy > heights[cCell]) {
            heights[cCell] = cy;
            hitsMask[cCell] = 1;
          }
          continue;
        }
        const invDenom = 1.0 / denom;
        for (let iz = gz0; iz <= gz1; iz++) {
          const pz = minZ + iz / scaleZ;
          const row = iz * N;
          for (let ix = gx0; ix <= gx1; ix++) {
            const px = minX + ix / scaleX;
            const l0 = ((wz1 - wz2) * (px - wx2) + (wx2 - wx1) * (pz - wz2)) * invDenom;
            if (l0 < -0.02) continue;
            const l1 = ((wz2 - wz0) * (px - wx2) + (wx0 - wx2) * (pz - wz2)) * invDenom;
            if (l1 < -0.02) continue;
            const l2 = 1.0 - l0 - l1;
            if (l2 < -0.02) continue;
            const hy = l0 * wy0 + l1 * wy1 + l2 * wy2;
            const cell = row + ix;
            if (hy > heights[cell]) {
              heights[cell] = hy;
              hitsMask[cell] = 1;
            }
          }
        }
      }
    }

    for (let i = 0; i < N * N; i++) {
      if (hitsMask[i]) {
        const hy = heights[i];
        if (hy < yMin) yMin = hy;
        if (hy > yMax) yMax = hy;
        ySum += hy;
        hitCount++;
      }
    }
    if (hitCount === 0) {
      yMin = -12;
      yMax = 20;
    } else if (yMax - yMin < 1.0) {
      yMin -= 2.0;
      yMax += 2.0;
    }
    const meanY = hitCount > 0 ? ySum / hitCount : 0.0;
    const data = new Uint8Array(N * N * 4);
    for (let i = 0; i < N * N; i++) {
      if (hitsMask[i]) {
        const norm = Math.max(0, Math.min(1, (heights[i] - yMin) / Math.max(0.5, yMax - yMin)));
        const scaled = Math.round(norm * 65535);
        data[i * 4 + 0] = (scaled >> 8) & 255;
        data[i * 4 + 1] = scaled & 255;
        data[i * 4 + 2] = 0;
        data[i * 4 + 3] = 255;
      } else {
        data[i * 4 + 0] = 128;
        data[i * 4 + 1] = 0;
        data[i * 4 + 2] = 0;
        data[i * 4 + 3] = 0;
      }
    }
    if (compareCtx._baselineHeightMap?.tex) {
      try {
        compareCtx._baselineHeightMap.tex.dispose();
      } catch (_) {}
    }
    const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    // Use NearestFilter so RG high/low 16-bit bytes are never blended across byte carry boundaries;
    // the GLSL shader performs exact 4-tap decoded bilinear interpolation using uBaseGridN.
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.needsUpdate = true;

    compareCtx._baselineHeightMap = {
      tex,
      gridN: N,
      bounds: new THREE.Vector4(minX, minZ, maxX, maxZ),
      yRange: new THREE.Vector2(yMin, yMax),
      meanY,
      deltaSpan: 4.0,
    };
    return compareCtx._baselineHeightMap;
  }

  function updateCompareHeatmapLegendUI(active) {
    const stage = document.getElementById("compareStage");
    if (!stage) return;
    let legend = document.getElementById("compareHeatmapLegend");
    if (!active) {
      if (legend) legend.style.display = "none";
      return;
    }
    if (!legend) {
      legend = document.createElement("div");
      legend.id = "compareHeatmapLegend";
      legend.style.cssText =
        "position:absolute;bottom:14px;left:50%;transform:translateX(-50%);z-index:60;background:var(--ui-bg-window);border:1px solid var(--ui-border-strong);border-radius:10px;padding:7px 14px;box-shadow:var(--ui-shadow-hud);display:flex;flex-direction:column;gap:4px;min-width:290px;pointer-events:none;";
      stage.appendChild(legend);
    }
    const hm = compareCtx?._baselineHeightMap;
    const zMin = hm ? hm.yRange.x.toFixed(1) : "-12.0";
    const zMax = hm ? hm.yRange.y.toFixed(1) : "+22.0";
    const dSpan = hm ? hm.deltaSpan.toFixed(1) : "4.0";
    legend.style.display = "flex";
    legend.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:10.5px;font-weight:700;color:var(--ui-text-primary);gap:12px;">
        <span>Left: Baseline Z (${zMin}m ~ +${zMax}m)</span>
        <span style="color:var(--ui-accent);">Right: ΔZ Height Change (Right − Left)</span>
      </div>
      <div style="height:7px;border-radius:999px;background:linear-gradient(90deg, #2461eb 0%, #05b5d4 25%, #0fba82 50%, #f59e0a 75%, #ef4545 100%);"></div>
      <div style="display:flex;justify-content:space-between;font-size:10px;font-family:var(--font-mono);color:var(--ui-text-secondary);">
        <span>-${dSpan}m (Cut / Lower)</span>
        <span>0.0m (No Change)</span>
        <span>+${dSpan}m (Fill / Higher)</span>
      </div>
    `;
  }

  function applyCompareElevationHeatmapToMaterial(m, active, side = null) {
    if (!m) return;
    if (!m.userData) m.userData = {};
    const isRightDelta = Boolean(side && side.isLatest);
    const hm = compareCtx?._baselineHeightMap;
    m.userData._elevationHeatmapActive = Boolean(active);
    m.userData._deltaZMode = Boolean(active && isRightDelta);
    if (isRightDelta) {
      m.userData._elevMin = -(hm?.deltaSpan || 4.0);
      m.userData._elevMax = hm?.deltaSpan || 4.0;
      if (hm) {
        m.userData._baseElevTex = hm.tex;
        m.userData._baseGridN = hm.gridN || 96;
        m.userData._baseBounds = hm.bounds;
        m.userData._baseYRange = hm.yRange;
        m.userData._baseMeanY = hm.meanY;
      }
    } else {
      m.userData._elevMin = hm ? hm.yRange.x : -12.0;
      m.userData._elevMax = hm ? hm.yRange.y : 22.0;
    }
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
          mats.forEach((m) => applyCompareElevationHeatmapToMaterial(m, active, side));
        }
      });
    });
  }

  function setCompareElevationHeatmap(active) {
    if (!compareCtx) return;
    if (active) {
      buildCompareBaselineHeightMap();
    }
    [compareCtx.left, compareCtx.right, compareCtx.third, compareCtx.fourth].forEach((s) => {
      if (s) applyCompareElevationHeatmapToSide(s, active);
    });
    updateCompareHeatmapLegendUI(active);
  }

  function loadScanIntoCompareSide(side, scanId) {
    if (!side || !scanId) return;
    const scan = STATE.scans.find((s) => s.scan_id === scanId) || STATE.scans[0];
    if (!scan) return;
    if (side._loadedScanId === scan.scan_id && (side.tilesRenderer || side.loadedMesh)) return;
    side._loadedScanId = scan.scan_id;
    side.scanMeta = scan;
    side.rawSphere = null;
    side._glbLoaded = false;
    side._fallbackLoaded = false;

    if (side.tilesRenderer) {
      try {
        side.tilesRenderer.dispose();
      } catch (_) {}
      side.tilesRenderer = null;
    }
    side.loadedMesh = null;
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
    if (!streamUrl) {
      if (side.fallbackGroup) side.fallbackGroup.visible = true;
      side._fallbackLoaded = true;
      syncCompareLoaderProgress();
      return;
    }
    if (STATE.shareToken && !streamUrl.includes("share=")) {
      streamUrl += (streamUrl.includes("?") ? "&" : "?") + `share=${encodeURIComponent(STATE.shareToken)}`;
    }

    const isGlbStream = scan.stream_type === "glb" || streamUrl.split("?")[0].toLowerCase().endsWith(".glb");
    if (isGlbStream && THREE.GLTFLoader) {
      const loader = new THREE.GLTFLoader();
      if (window.MeshoptDecoder) loader.setMeshoptDecoder(window.MeshoptDecoder);
      const ktx2 = getKTX2Loader(side.renderer);
      if (ktx2) loader.setKTX2Loader(ktx2);
      loader.load(
        streamUrl,
        (gltf) => {
          const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
          if (!root) {
            if (side.fallbackGroup) side.fallbackGroup.visible = true;
            side._fallbackLoaded = true;
            syncCompareLoaderProgress();
            return;
          }
          const box = new THREE.Box3().setFromObject(root);
          const sphere = new THREE.Sphere();
          box.getBoundingSphere(sphere);
          const spanY = box.max.y - box.min.y;
          const spanZ = box.max.z - box.min.z;
          side._glbIsYUp = spanY <= spanZ * 1.35;
          sphere._groundOffsetY = -(sphere.radius * 0.18);
          side.rawSphere = sphere;
          side.loadedMesh = root;
          side.alignGroup.add(root);
          side._glbLoaded = true;
          alignCompareSides();
          const heatmapOn = Boolean(document.getElementById("chkDeltaZHeatmap")?.checked);
          if (heatmapOn) buildCompareBaselineHeightMap();
          root.traverse((c) => {
            if (c.isMesh && c.material) {
              const mats = Array.isArray(c.material) ? c.material : [c.material];
              mats.forEach((m) => applyCompareElevationHeatmapToMaterial(m, heatmapOn, side));
            }
          });
          side.renderer.render(side.scene, side.camera);
          syncCompareLoaderProgress();
        },
        undefined,
        () => {
          if (side.fallbackGroup) side.fallbackGroup.visible = true;
          side._fallbackLoaded = true;
          syncCompareLoaderProgress();
        }
      );
      return;
    }

    if (!window.TilesRenderer) {
      if (side.fallbackGroup) side.fallbackGroup.visible = true;
      side._fallbackLoaded = true;
      syncCompareLoaderProgress();
      return;
    }

    const tr = new window.TilesRenderer(streamUrl);
    tr.fetchOptions = { mode: "cors" };
    tr.preprocessURL = (uri) => preprocessTileStreamUrl(uri, streamUrl);
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
        if (heatmapOn) {
          buildCompareBaselineHeightMap();
        }
        ev.scene.traverse((c) => {
          if (c.isMesh && c.material) {
            const mats = Array.isArray(c.material) ? c.material : [c.material];
            mats.forEach((m) => applyCompareElevationHeatmapToMaterial(m, heatmapOn, side));
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
    const cnt = Math.max(2, Math.min(4, Number(STATE.compareScanCount) || 2));
    const lSel = document.getElementById("compareLeftSelect");
    const rSel = document.getElementById("compareRightSelect");
    const tSel = document.getElementById("compareThirdSelect");
    const fSel = document.getElementById("compareFourthSelect");
    const leftId = lSel?.value || STATE.scans[Math.min(1, STATE.scans.length - 1)]?.scan_id;
    const rightId = rSel?.value || STATE.scans[0]?.scan_id;
    const thirdId = tSel?.value || STATE.scans[Math.min(2, STATE.scans.length - 1)]?.scan_id;
    const fourthId = fSel?.value || STATE.scans[Math.min(3, STATE.scans.length - 1)]?.scan_id;
    if (leftId) loadScanIntoCompareSide(compareCtx.left, leftId);
    if (rightId) loadScanIntoCompareSide(compareCtx.right, rightId);
    if (cnt >= 3 && thirdId && compareCtx.third) loadScanIntoCompareSide(compareCtx.third, thirdId);
    if (cnt >= 4 && fourthId && compareCtx.fourth) loadScanIntoCompareSide(compareCtx.fourth, fourthId);
    alignCompareSides();
  }

  function syncCompareLoaderProgress() {
    if (!compareCtx || compareCtx._loadingDone) return;
    const activeSides = getActiveCompareSides();
    if (!activeSides.length) return;
    let allSidesReady = true;
    let loaded = 0;
    let activeWork = 0;
    let queued = 0;
    activeSides.forEach((side) => {
      const stats = side?.tilesRenderer?.stats || {};
      const sideReady = Boolean(side?._glbLoaded || side?._fallbackLoaded || Number(stats.loaded || 0) > 0);
      if (!sideReady) allSidesReady = false;
      loaded += Number(stats.loaded || 0) + (side?._glbLoaded ? 1 : 0);
      activeWork += Number(stats.downloading || 0) + Number(stats.parsing || 0);
      queued += Number(stats.queued || 0);
    });
    const pending = activeWork + queued;
    const total = Math.max(1, loaded + pending);
    const now = performance.now();
    const elapsed = now - (compareCtx._loadingStartMs || 0);
    const sinceTileset = compareCtx._tilesetReadyMs ? now - compareCtx._tilesetReadyMs : 0;

    const allSidesHaveMesh =
      allSidesReady &&
      (pending === 0 || (activeWork === 0 && sinceTileset > 900) || loaded >= Math.max(activeSides.length, Math.ceil(total * 0.75)));

    if (allSidesHaveMesh && elapsed > 180) {
      if (document.getElementById("chkDeltaZHeatmap")?.checked) {
        setCompareElevationHeatmap(true);
      }
      finishScanLoader(compareCtx, "compare", `100% · Compare scans ready`);
      return;
    }

    if (loaded > 0 || activeWork > 0 || queued > 0) {
      const timeBoost = activeWork > 0 ? Math.min(24, Math.floor(elapsed / 250)) : 0;
      const rawPct = Math.round(18 + (loaded / total) * 78) + timeBoost;
      compareCtx._maxPct = Math.min(96, Math.max(compareCtx._maxPct || 18, rawPct));
      updateScanLoader("compare", true, compareCtx._maxPct, `Streaming Compare Scans · ${loaded} / ${total} tiles`);
    } else if (sinceTileset > 12000 || elapsed > 14000) {
      finishScanLoader(compareCtx, "compare", "Compare Ready");
    }
  }

  function initCompareView() {
    if (compareCtx) return compareCtx;
    const leftContainer = document.getElementById("compareLeftLayer");
    const rightContainer = document.getElementById("compareRightLayer");
    const thirdContainer = document.getElementById("compareThirdLayer");
    const fourthContainer = document.getElementById("compareFourthLayer");
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
    const third = thirdContainer ? createEpochScene(thirdContainer, 0xf59e0b, true) : null;
    const fourth = fourthContainer ? createEpochScene(fourthContainer, 0xa855f7, true) : null;

    // Synchronized OrbitControls on the stage
    const stage = document.getElementById("compareStage");
    const controls = new THREE.OrbitControls(left.camera, stage);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.enablePan = true;
    controls.enableZoom = true;
    controls.screenSpacePanning = true;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN,
    };
    controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
    stage?.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    stage?.addEventListener("auxclick", (e) => {
      if (e.button === 1) e.preventDefault();
    });
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
      if (lbl) lbl.textContent = tr(`分割：${Math.round(pct)}%`, `Split: ${Math.round(pct)}%`);
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

    // Compare Mode Switcher (Slider Mode vs Multi-Viewport Synced Camera Mode)
    document.querySelectorAll("#compareModeSwitcher .btn-seg").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.compareMode || "slider";
        setCompareMode(mode);
        showToast(
          mode === "split"
            ? tr("多視窗並排比較模式：同步相機視角", "Multi-Viewport Mode: Side-by-Side Scans with Synced Camera")
            : tr("拉簾滑桿模式：雙期掃描疊合比對", "Slider Mode: Interactive Split Curtain Comparison")
        );
      });
    });

    // Compare Scan Count Switcher (2 / 3 / 4 Scans)
    document.querySelectorAll("#compareScanCountSwitcher .btn-seg").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cnt = Number(btn.dataset.compareCount) || 2;
        setCompareScanCount(cnt);
        showToast(
          tr(`已切換為 ${cnt} 筆掃描同步對比`, `Comparing ${cnt} scans simultaneously with synced camera`)
        );
      });
    });

    document.getElementById("btnCompareResetCamera")?.addEventListener("click", () => {
      frameCompareCamera(true);
    });

    // Left / Right / Third / Fourth Scan Dropdown Listeners
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
    document.getElementById("compareThirdSelect")?.addEventListener("change", (e) => {
      if (e.target.value && compareCtx?.third) {
        loadScanIntoCompareSide(compareCtx.third, e.target.value);
      }
    });
    document.getElementById("compareFourthSelect")?.addEventListener("change", (e) => {
      if (e.target.value && compareCtx?.fourth) {
        loadScanIntoCompareSide(compareCtx.fourth, e.target.value);
      }
    });

    // Z / Delta-Z Elevation Heatmap Toggle (Left: Baseline Z Ramp · Right: ΔZ Height Change)
    document.getElementById("chkDeltaZHeatmap")?.addEventListener("change", (e) => {
      const active = Boolean(e.target.checked);
      setCompareElevationHeatmap(active);
      showToast(
        active
          ? "Enabled ΔZ Elevation Heatmap (Left: Baseline Z · Right: ΔZ Cut/Fill Change)"
          : "Restored Original RGB Texture Shading"
      );
    });

    const loop = () => {
      requestAnimationFrame(loop);
      if (STATE.activeView !== "compare") return;
      if (!dragging) {
        controls.update();
      }
      left.camera.updateMatrixWorld();
      const activeSides = getActiveCompareSides();
      activeSides.forEach((s) => {
        if (s && s !== left) {
          s.camera.position.copy(left.camera.position);
          s.camera.quaternion.copy(left.camera.quaternion);
          s.camera.updateMatrixWorld();
        }
      });
      const heatmapOn = Boolean(document.getElementById("chkDeltaZHeatmap")?.checked);
      activeSides.forEach((side) => {
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
                  applyCompareElevationHeatmapToMaterial(m, heatmapOn, side);
                }
              });
            }
          });
        }
      });
      if (typeof updateNorthArrowCompass === "function") {
        updateNorthArrowCompass(left.camera);
      }
      syncCompareLoaderProgress();
      activeSides.forEach((s) => {
        s.renderer.render(s.scene, s.camera);
      });
    };
    requestAnimationFrame(loop);

    compareCtx = { left, right, third, fourth, controls, _curtainPct: 50, _framedPairKey: "" };
    window.__gsCompareCtx = compareCtx;
    setCompareScanCount(STATE.compareScanCount || 2);
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
      [compareCtx.left, compareCtx.right, compareCtx.third, compareCtx.fourth].forEach((side) => {
        if (!side) return;
        if (side.scene) side.scene.background = new THREE.Color(cmpLeftHex);
        if (side.grid && side.grid.material) {
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
        const curModeZh = resolved === "dark" ? "深色" : "淺色";
        const curModeEn = resolved === "dark" ? "Dark" : "Light";
        subEl.textContent = tr(
          `依時段自動切換 · ${nowStr} → 目前為${curModeZh}模式 · 06:00–18:00 淺色`,
          `Auto by Time of Day · ${nowStr} → Currently ${curModeEn} · 06:00–18:00 Light`
        );
      } else if (normalizedPref === "light") {
        subEl.textContent = tr("所有檢視與 3D 畫布已固定為淺色主題", "Locked to Light Theme across all views & 3D canvases");
      } else {
        subEl.textContent = tr("所有檢視與 3D 畫布已固定為深色主題", "Locked to Dark Theme across all views & 3D canvases");
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
    if (STATE.fpMode) {
      STATE.fpMode.keys = Object.create(null);
      STATE.fpMode.dragLooking = false;
    }
    if (document.pointerLockElement) {
      try {
        document.exitPointerLock();
      } catch (_) {}
    }
    const toastEl = document.getElementById("gsToast");
    if (toastEl) {
      clearTimeout(toastEl._timer);
      toastEl.classList.remove("show");
      toastEl.style.display = "none";
    }
    document.getElementById(id)?.classList.add("active");
  }
  function closeModal(id) {
    if (id === "userProfileGateModal" && !STATE.isAuthorized && !STATE.shareToken) {
      showToast("Please sign in with Google or choose Guest Mode to continue");
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
    const saved = STATE.pix4dSettings || {};
    const getVal = (baseId, stateKey, fallback) => {
      const el =
        document.getElementById(baseId + suffix) ||
        document.getElementById(baseId + "User") ||
        document.getElementById(baseId);
      if (el && el.value !== undefined && el.value !== "") return el.value;
      if (saved[stateKey] !== undefined && saved[stateKey] !== null) return saved[stateKey];
      return fallback;
    };
    const getChk = (baseId, stateKey, fallback) => {
      const el =
        document.getElementById(baseId + suffix) ||
        document.getElementById(baseId + "User") ||
        document.getElementById(baseId);
      if (el) return Boolean(el.checked);
      if (saved[stateKey] !== undefined && saved[stateKey] !== null) return Boolean(saved[stateKey]);
      return fallback;
    };
    return {
      mesh_pipeline: String(getVal("selPix4dMeshPipeline", "mesh_pipeline", "FixedSize")),
      texture_size: Number(getVal("selPix4dTextureSize", "texture_size", 4096)) || 4096,
      model_simplification: String(getVal("selPix4dSimplification", "model_simplification", "Conservative")),
      deghosting: String(getVal("selPix4dDeghosting", "deghosting", "Weak")),
      export_lod: Math.max(0, Math.min(20, Number(getVal("inpPix4dExportLod", "export_lod", 13)) || 13)),
      skyless: getChk("chkPix4dSkyless", "skyless", false),
      use_roi: getChk("chkPix4dUseRoi", "use_roi", false),
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
          if (tEl)
            tEl.textContent = tr(
              `執行中 PIX4Dmatic 管線：${lp.scan_name} · ${Math.round(lp.progress_pct || 0)}%`,
              `Active PIX4Dmatic Pipeline: ${lp.scan_name} · ${Math.round(lp.progress_pct || 0)}%`
            );
          const bEl = document.getElementById("livePix4dStageBadge");
          if (bEl) bEl.textContent = `${lp.stage}${lp.cpu_ram ? " · " + lp.cpu_ram : ""}`;
          const pBar = document.getElementById("livePix4dProgressBar");
          if (pBar) pBar.style.width = `${Math.max(5, Math.min(100, Number(lp.progress_pct || 10)))}%`;
          const pathEl = document.getElementById("livePix4dLogPath");
          if (pathEl) pathEl.textContent = `${tr("日誌：", "Log: ")}${lp.log_path || ""}`;
          const tailEl = document.getElementById("livePix4dLogTail");
          if (tailEl) tailEl.textContent = (lp.tail_lines || []).join("\n");
        } else {
          monBox.style.display = "none";
        }
      }

      const rows = Array.isArray(qData.all_scans) && qData.all_scans.length > 0 ? qData.all_scans : STATE.scans;
      tbody.innerHTML = "";
      rows.forEach((s) => {
        const rowEl = document.createElement("tr");
        const isProc = s.status === "processing";
        const pct = Math.round(Number(s.progress_pct || (s.status === "completed" ? 100 : 0)));
        const rawStatusUpper = String(s.status || "").toUpperCase();
        const statusDisplay =
          rawStatusUpper === "COMPLETED"
            ? tr("已完成", "COMPLETED")
            : rawStatusUpper === "QUEUED" || rawStatusUpper === "WAITING"
            ? tr("排隊等待", "QUEUED")
            : rawStatusUpper === "FAILED" || rawStatusUpper === "ERROR"
            ? tr("失敗", "FAILED")
            : rawStatusUpper;
        const safeStatus = escapeHtml(statusDisplay);
        const safeStage = escapeHtml(s.stage_label || tr("正在執行 PIX4Dmatic...", "Running PIX4Dmatic..."));
        const statusHtml = isProc
          ? `<div style="display:flex;flex-direction:column;gap:3px;min-width:130px;">
               <span class="gs-crs-pill" style="background:rgba(2,132,199,0.18);color:var(--ui-accent);">${tr(`處理中 · ${pct}%`, `PROCESSING · ${pct}%`)}</span>
               <div style="height:4px;background:var(--ui-border-strong);border-radius:999px;overflow:hidden;">
                 <div style="height:100%;width:${Math.max(5, pct)}%;background:var(--ui-accent);"></div>
               </div>
               <span style="font-size:10px;color:var(--ui-text-secondary);">${safeStage}</span>
             </div>`
          : `<span class="gs-crs-pill">${safeStatus}</span>`;

        const safeScanId = escapeHtml(s.scan_id || "");
        rowEl.innerHTML = `
          <td><b style="color:var(--ui-text-primary);">${escapeHtml(s.name || s.scan_id || "")}</b><br><span style="font-size:10.5px;color:var(--ui-text-muted);">${safeScanId}</span></td>
          <td style="color:var(--ui-text-secondary);">${escapeHtml(s.project_group || "")}</td>
          <td><span style="color:var(--ui-text-primary);font-weight:600;">${escapeHtml(s.uploader_name || "")}</span><br><span style="font-size:10.5px;color:var(--ui-text-muted);">${escapeHtml(s.uploader_email || "")} · ${escapeHtml(s.capture_date || "")}</span></td>
          <td><span style="color:var(--ui-text-primary);font-weight:600;">${Number(s.image_count || 0)} ${tr("張照片", "imgs")}</span><br><span style="font-size:10.5px;color:var(--ui-text-muted);">${escapeHtml(formatCoveredAreaM2(s))} · ${Number(s.size_mb || (s.size_bytes || 0) / 1048576).toFixed(1)} MB</span></td>
          <td><span class="gs-crs-pill">${escapeHtml(getScanCrsDisplayLabel(s))} · ${Number(s.texture_resolution || 4096)}px</span></td>
          <td style="font-family:monospace;font-weight:700;color:var(--ui-text-primary);">${escapeHtml(String(s.priority_score ?? ""))}</td>
          <td>${statusHtml}</td>
          <td style="display:flex;gap:4px;">
            <button type="button" class="btn-xs" data-gst="${safeScanId}" title="${tr("預覽 .GST 腳本", "Preview .GST Script")}">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
                <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
              </svg>
            </button>
            <button type="button" class="btn-xs" data-reprocess="${safeScanId}" title="${tr("以自訂 PIX4Dmatic 參數從原始照片重新計算", "Re-run from Original Photos with Custom PIX4Dmatic Settings")}">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
                <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
            </button>
          </td>
        `;
        rowEl.querySelector("[data-gst]")?.addEventListener("click", () => previewGstForScan(s.scan_id));
        rowEl.querySelector("[data-reprocess]")?.addEventListener("click", () => {
          openRerunScanModal(s.scan_id);
        });
        tbody.appendChild(rowEl);
      });
    } catch (err) {
      const monBox = document.getElementById("livePix4dMonitorBox");
      if (monBox) monBox.style.display = "none";
      tbody.innerHTML = `<tr><td colspan="8" style="color:var(--ui-text-secondary);">${escapeHtml(err.message || "")}</td></tr>`;
    }
  }

  async function openQueueModal() {
    openModal("modalQueue");
    _pix4dSettingsDirty = false;
    const tbody = document.getElementById("queueTableBody");
    if (tbody && !tbody.children.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="color:var(--ui-text-muted);">${tr("載入中...", "Loading...")}</td></tr>`;
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
        const authTag = st.auth_configured ? tr(" · 憑證已就緒", " · Auth Ready") : tr(" · 連結／OAuth", " · Link/OAuth");
        badge.textContent = tr(
          `已同步 ${synced} / ${total} 個 .3tz · ${st.total_size_mb || 0} MB${authTag}`,
          `${synced} / ${total} .3tz Synced · ${st.total_size_mb || 0} MB${authTag}`
        );
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

