/**
 * GatheringScans Frontend Module 04 — 3D Frustum Lasso Engine, Staged Mesh Edits & Client Volume Raycaster
 */
"use strict";

  // =========================================================================
  // REAL-TIME 3D LASER WIDTH & CLEARANCE ENGINE (Road Width + Room Width/Height)
  // =========================================================================
  function getLaserSpatialIndex(allowStaleMs = 0) {
    if (!studioThree) return null;
    const alignSig = STATE.multiAlign?.active
      ? (STATE.multiAlign.layers || [])
          .map((l) => `${l.scan_id}:${l.visible ? 1 : 0}:${l.tx}:${l.ty}:${l.tz}:${l.rx_deg}:${l.ry_deg}:${l.rz_deg}`)
          .join("|")
      : STATE.activeScanId || "";
    const stagedRev = STATE.stagedEdits?.rev || 0;
    const baseSig = `${alignSig}#r=${stagedRev}`;

    if (
      allowStaleMs > 0 &&
      studioThree._laserSpatialIndex &&
      studioThree._laserSpatialIndex.baseSig === baseSig &&
      performance.now() - (studioThree._laserSpatialIndex.builtAt || 0) < allowStaleMs
    ) {
      return studioThree._laserSpatialIndex;
    }

    const meshes = [];
    if (STATE.multiAlign?.active && studioThree.multiAlignGroup && studioThree.multiAlignGroup.visible) {
      studioThree.multiAlignGroup.updateMatrixWorld(true);
      studioThree.multiAlignGroup.traverse((c) => {
        if (
          c.isMesh &&
          isMeshVisibleUnderRoot(c, studioThree.multiAlignGroup) &&
          !c.userData?.isAlignBoxHelper &&
          c.geometry?.attributes?.position
        ) {
          meshes.push(c);
        }
      });
    } else if (studioThree.modelPivot && studioThree.modelPivot.visible) {
      studioThree.modelPivot.updateMatrixWorld(true);
      studioThree.modelPivot.traverse((c) => {
        if (c.isMesh && isMeshVisibleUnderRoot(c, studioThree.modelPivot) && c.geometry?.attributes?.position) {
          meshes.push(c);
        }
      });
    }
    if (meshes.length === 0 && studioThree.fallbackGroup && studioThree.fallbackGroup.visible) {
      studioThree.fallbackGroup.updateMatrixWorld(true);
      studioThree.fallbackGroup.traverse((c) => {
        if (c.isMesh && c.visible && c.geometry?.attributes?.position) {
          meshes.push(c);
        }
      });
    }
    if (meshes.length === 0) return null;

    let totalTris = 0;
    for (let i = 0; i < meshes.length; i++) {
      const g = meshes[i].geometry;
      const idx = g.index;
      totalTris += idx ? Math.floor(idx.count / 3) : Math.floor(g.attributes.position.count / 3);
    }
    if (totalTris === 0) return null;

    const cacheKey = `${baseSig}#m=${meshes.length}#t=${totalTris}`;

    if (studioThree._laserSpatialIndex && studioThree._laserSpatialIndex.key === cacheKey) {
      return studioThree._laserSpatialIndex;
    }

    // Cap synchronous indexing at ~180k triangles so first mouse-move / hover never stalls a 60 FPS frame
    const targetMaxTris = 180000;
    const triStride = totalTris > targetMaxTris ? Math.ceil(totalTris / targetMaxTris) : 1;
    const maxIndexed = Math.ceil(totalTris / triStride) + 16;
    const triVerts = new Float32Array(maxIndexed * 9);
    const triAbsNy = new Float32Array(maxIndexed);

    let minX = 1e30, maxX = -1e30, minZ = 1e30, maxZ = -1e30;
    let wCount = 0;

    for (let mi = 0; mi < meshes.length; mi++) {
      const m = meshes[mi];
      const e = m.matrixWorld.elements;
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

        const x0 = e[0] * lx0 + e[4] * ly0 + e[8] * lz0 + e[12];
        const y0 = e[1] * lx0 + e[5] * ly0 + e[9] * lz0 + e[13];
        const z0 = e[2] * lx0 + e[6] * ly0 + e[10] * lz0 + e[14];

        const x1 = e[0] * lx1 + e[4] * ly1 + e[8] * lz1 + e[12];
        const y1 = e[1] * lx1 + e[5] * ly1 + e[9] * lz1 + e[13];
        const z1 = e[2] * lx1 + e[6] * ly1 + e[10] * lz1 + e[14];

        const x2 = e[0] * lx2 + e[4] * ly2 + e[8] * lz2 + e[12];
        const y2 = e[1] * lx2 + e[5] * ly2 + e[9] * lz2 + e[13];
        const z2 = e[2] * lx2 + e[6] * ly2 + e[10] * lz2 + e[14];

        const ax = x1 - x0, ay = y1 - y0, az = z1 - z0;
        const bx = x2 - x0, by = y2 - y0, bz = z2 - z0;
        const nx = ay * bz - az * by;
        const ny = az * bx - ax * bz;
        const nz = ax * by - ay * bx;
        const nLen = Math.hypot(nx, ny, nz);
        if (nLen < 1e-7) continue;

        const base = wCount * 9;
        triVerts[base] = x0;
        triVerts[base + 1] = y0;
        triVerts[base + 2] = z0;
        triVerts[base + 3] = x1;
        triVerts[base + 4] = y1;
        triVerts[base + 5] = z1;
        triVerts[base + 6] = x2;
        triVerts[base + 7] = y2;
        triVerts[base + 8] = z2;
        triAbsNy[wCount] = Math.abs(ny) / nLen;
        wCount++;

        const tMinX = Math.min(x0, x1, x2);
        const tMaxX = Math.max(x0, x1, x2);
        const tMinZ = Math.min(z0, z1, z2);
        const tMaxZ = Math.max(z0, z1, z2);
        if (tMinX < minX) minX = tMinX;
        if (tMaxX > maxX) maxX = tMaxX;
        if (tMinZ < minZ) minZ = tMinZ;
        if (tMaxZ > maxZ) maxZ = tMaxZ;
      }
    }

    if (wCount === 0) return null;
    minX -= 0.5;
    minZ -= 0.5;
    maxX += 0.5;
    maxZ += 0.5;

    const spanMax = Math.max(10, maxX - minX, maxZ - minZ);
    const cellSize = Math.max(0.85, spanMax / 180);
    const invCell = 1.0 / cellSize;
    const gridW = Math.max(4, Math.ceil((maxX - minX) * invCell) + 1);
    const gridH = Math.max(4, Math.ceil((maxZ - minZ) * invCell) + 1);
    const numCells = gridW * gridH;

    const cellCounts = new Int32Array(numCells);
    for (let t = 0; t < wCount; t++) {
      const b = t * 9;
      const gx0 = Math.max(0, Math.min(gridW - 1, Math.floor((Math.min(triVerts[b], triVerts[b + 3], triVerts[b + 6]) - minX) * invCell)));
      const gx1 = Math.max(0, Math.min(gridW - 1, Math.floor((Math.max(triVerts[b], triVerts[b + 3], triVerts[b + 6]) - minX) * invCell)));
      const gz0 = Math.max(0, Math.min(gridH - 1, Math.floor((Math.min(triVerts[b + 2], triVerts[b + 5], triVerts[b + 8]) - minZ) * invCell)));
      const gz1 = Math.max(0, Math.min(gridH - 1, Math.floor((Math.max(triVerts[b + 2], triVerts[b + 5], triVerts[b + 8]) - minZ) * invCell)));
      if ((gx1 - gx0 + 1) * (gz1 - gz0 + 1) > 40000) continue;
      for (let gz = gz0; gz <= gz1; gz++) {
        const row = gz * gridW;
        for (let gx = gx0; gx <= gx1; gx++) {
          cellCounts[row + gx]++;
        }
      }
    }

    const cellOffsets = new Int32Array(numCells + 1);
    for (let c = 0; c < numCells; c++) {
      cellOffsets[c + 1] = cellOffsets[c] + cellCounts[c];
    }
    const cellTris = new Int32Array(cellOffsets[numCells]);
    const writePtr = cellOffsets.slice(0, numCells);

    for (let t = 0; t < wCount; t++) {
      const b = t * 9;
      const gx0 = Math.max(0, Math.min(gridW - 1, Math.floor((Math.min(triVerts[b], triVerts[b + 3], triVerts[b + 6]) - minX) * invCell)));
      const gx1 = Math.max(0, Math.min(gridW - 1, Math.floor((Math.max(triVerts[b], triVerts[b + 3], triVerts[b + 6]) - minX) * invCell)));
      const gz0 = Math.max(0, Math.min(gridH - 1, Math.floor((Math.min(triVerts[b + 2], triVerts[b + 5], triVerts[b + 8]) - minZ) * invCell)));
      const gz1 = Math.max(0, Math.min(gridH - 1, Math.floor((Math.max(triVerts[b + 2], triVerts[b + 5], triVerts[b + 8]) - minZ) * invCell)));
      if ((gx1 - gx0 + 1) * (gz1 - gz0 + 1) > 40000) continue;
      for (let gz = gz0; gz <= gz1; gz++) {
        const row = gz * gridW;
        for (let gx = gx0; gx <= gx1; gx++) {
          cellTris[writePtr[row + gx]++] = t;
        }
      }
    }

    const built = {
      key: cacheKey,
      baseSig,
      builtAt: performance.now(),
      triCount: wCount,
      triVerts,
      triAbsNy,
      minX,
      minZ,
      cellSize,
      invCell,
      gridW,
      gridH,
      cellOffsets,
      cellTris,
      visitStamp: new Int32Array(wCount),
      raySeq: 1,
    };
    studioThree._laserSpatialIndex = built;
    return built;
  }

  // Exact Möller–Trumbore raycast walking CSR grid cells via 2D Amanatides–Woo DDA
  function castRayInLaserGrid(idx, ox, oy, oz, dx, dy, dz, minT = 0.08, maxT = 70.0, maxAllowedAbsNy = 1.01) {
    if (!idx) return null;
    const { triVerts, triAbsNy, minX, minZ, cellSize, invCell, gridW, gridH, cellOffsets, cellTris, visitStamp } = idx;
    idx.raySeq = (idx.raySeq + 1) | 0;
    if (idx.raySeq <= 0) {
      visitStamp.fill(0);
      idx.raySeq = 1;
    }
    const stamp = idx.raySeq;

    let bestT = maxT + 1.0;
    let bestTri = -1;

    const testCell = (gx, gz) => {
      const cIdx = gz * gridW + gx;
      const start = cellOffsets[cIdx];
      const end = cellOffsets[cIdx + 1];
      for (let p = start; p < end; p++) {
        const t = cellTris[p];
        if (visitStamp[t] === stamp) continue;
        visitStamp[t] = stamp;
        if (triAbsNy[t] > maxAllowedAbsNy) continue;

        const b = t * 9;
        const x0 = triVerts[b], y0 = triVerts[b + 1], z0 = triVerts[b + 2];
        const e1x = triVerts[b + 3] - x0, e1y = triVerts[b + 4] - y0, e1z = triVerts[b + 5] - z0;
        const e2x = triVerts[b + 6] - x0, e2y = triVerts[b + 7] - y0, e2z = triVerts[b + 8] - z0;

        const hx = dy * e2z - dz * e2y;
        const hy = dz * e2x - dx * e2z;
        const hz = dx * e2y - dy * e2x;
        const det = e1x * hx + e1y * hy + e1z * hz;
        if (det > -1e-8 && det < 1e-8) continue;
        const invDet = 1.0 / det;

        const sx = ox - x0, sy = oy - y0, sz = oz - z0;
        const u = (sx * hx + sy * hy + sz * hz) * invDet;
        if (u < 0.0 || u > 1.0) continue;

        const qx = sy * e1z - sz * e1y;
        const qy = sz * e1x - sx * e1z;
        const qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * invDet;
        if (v < 0.0 || u + v > 1.0) continue;

        const tHit = (e2x * qx + e2y * qy + e2z * qz) * invDet;
        if (tHit >= minT && tHit <= maxT && tHit < bestT) {
          bestT = tHit;
          bestTri = t;
        }
      }
    };

    // Pure vertical ray (+Y or -Y)
    if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) {
      const gx = Math.floor((ox - minX) * invCell);
      const gz = Math.floor((oz - minZ) * invCell);
      if (gx < 0 || gx >= gridW || gz < 0 || gz >= gridH) return null;
      testCell(gx, gz);
      if (bestTri < 0) return null;
      return {
        t: bestT,
        x: ox + dx * bestT,
        y: oy + dy * bestT,
        z: oz + dz * bestT,
        absNy: triAbsNy[bestTri],
      };
    }

    let gx = Math.floor((ox - minX) * invCell);
    let gz = Math.floor((oz - minZ) * invCell);
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const tDeltaX = stepX !== 0 ? Math.abs(cellSize / dx) : 1e30;
    const tDeltaZ = stepZ !== 0 ? Math.abs(cellSize / dz) : 1e30;

    let tMaxX = 1e30;
    if (stepX > 0) tMaxX = (minX + (gx + 1) * cellSize - ox) / dx;
    else if (stepX < 0) tMaxX = (minX + gx * cellSize - ox) / dx;

    let tMaxZ = 1e30;
    if (stepZ > 0) tMaxZ = (minZ + (gz + 1) * cellSize - oz) / dz;
    else if (stepZ < 0) tMaxZ = (minZ + gz * cellSize - oz) / dz;

    let curT = 0.0;
    let maxSteps = gridW + gridH + 4;
    while (maxSteps-- > 0 && curT <= maxT) {
      if (gx >= 0 && gx < gridW && gz >= 0 && gz < gridH) {
        testCell(gx, gz);
      }
      const nextT = tMaxX < tMaxZ ? tMaxX : tMaxZ;
      if (bestTri >= 0 && bestT <= nextT + 1e-4) break;
      curT = nextT;
      if (tMaxX < tMaxZ) {
        tMaxX += tDeltaX;
        gx += stepX;
      } else {
        tMaxZ += tDeltaZ;
        gz += stepZ;
      }
    }

    if (bestTri < 0) return null;
    return {
      t: bestT,
      x: ox + dx * bestT,
      y: oy + dy * bestT,
      z: oz + dz * bestT,
      absNy: triAbsNy[bestTri],
    };
  }

  // Exact local surface elevation & vertical curb/wall obstacle probe at (qx, qz) near expectedY (ignores tree canopies & ceilings!)
  function queryRoadSurfaceAtXZ(idx, qx, qz, prevY, expectedY) {
    const { triVerts, triAbsNy, minX, minZ, invCell, gridW, gridH, cellOffsets, cellTris } = idx;
    const gx = Math.floor((qx - minX) * invCell);
    const gz = Math.floor((qz - minZ) * invCell);
    if (gx < 0 || gx >= gridW || gz < 0 || gz >= gridH) {
      return { hit: false, y: prevY, absNy: 0, obstacle: false };
    }

    const cIdx = gz * gridW + gx;
    const start = cellOffsets[cIdx];
    const end = cellOffsets[cIdx + 1];

    let bestDiff = 1e30;
    let bestY = prevY;
    let bestNy = 0;
    let found = false;
    let obstacle = false;

    for (let p = start; p < end; p++) {
      const t = cellTris[p];
      const b = t * 9;
      const x0 = triVerts[b], y0 = triVerts[b + 1], z0 = triVerts[b + 2];
      const x1 = triVerts[b + 3], y1 = triVerts[b + 4], z1 = triVerts[b + 5];
      const x2 = triVerts[b + 6], y2 = triVerts[b + 7], z2 = triVerts[b + 8];

      const pad = 0.14;
      if (
        qx < Math.min(x0, x1, x2) - pad ||
        qx > Math.max(x0, x1, x2) + pad ||
        qz < Math.min(z0, z1, z2) - pad ||
        qz > Math.max(z0, z1, z2) + pad
      ) {
        continue;
      }

      const absNy = triAbsNy[t];
      const tMinY = Math.min(y0, y1, y2);
      const tMaxY = Math.max(y0, y1, y2);

      // Detect genuinely near-vertical curb / barrier / wall face rising right at (qx, qz)
      if (absNy < 0.56 && tMaxY > prevY + 0.17 && tMinY < prevY + 1.55) {
        const checkSeg = (ax, az, bx, bz) => {
          const vx = bx - ax, vz = bz - az;
          const len2 = vx * vx + vz * vz;
          const s = len2 > 1e-8 ? Math.max(0, Math.min(1, ((qx - ax) * vx + (qz - az) * vz) / len2)) : 0;
          const dx = qx - (ax + s * vx), dz = qz - (az + s * vz);
          return dx * dx + dz * dz <= 0.020;
        };
        if (checkSeg(x0, z0, x1, z1) || checkSeg(x1, z1, x2, z2) || checkSeg(x2, z2, x0, z0)) {
          obstacle = true;
        }
      }

      const denom = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
      if (Math.abs(denom) < 1e-8) continue;
      const invDen = 1.0 / denom;
      const u = ((z1 - z2) * (qx - x2) + (x2 - x1) * (qz - z2)) * invDen;
      if (u < -1e-4 || u > 1.0001) continue;
      const v = ((z2 - z0) * (qx - x2) + (x0 - x2) * (qz - z2)) * invDen;
      if (v < -1e-4 || u + v > 1.0001) continue;
      const w = 1.0 - u - v;

      const yHit = u * y0 + v * y1 + w * y2;
      if (absNy < 0.58 && yHit > prevY + 0.16 && yHit < prevY + 1.65) {
        obstacle = true;
        continue;
      }

      if (yHit < prevY - 0.65 || yHit > prevY + 0.65) continue;
      const diff = Math.abs(yHit - expectedY);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestY = yHit;
        bestNy = absNy;
        found = true;
      }
    }

    return { hit: found, y: bestY, absNy: bestNy, obstacle };
  }

  function traceRoadEdgeAlongRay(idx, ox, oy, oz, ux, uz, maxDist = 26.0, initSlope = null) {
    const step = 0.24;
    let prevS = 0.0;
    let prevY = oy;
    let localSlope = Number.isFinite(initSlope) ? Math.max(-0.10, Math.min(0.10, initSlope)) : 0.0;
    let hasSlope = Number.isFinite(initSlope);
    const histS = [0.0];
    const histY = [oy];

    for (let s = step; s <= maxDist; s += step) {
      const qx = ox + ux * s;
      const qz = oz + uz * s;
      const expY = prevY + localSlope * (s - prevS);
      const probe = queryRoadSurfaceAtXZ(idx, qx, qz, prevY, expY);

      const isMissingOrObstacle = !probe.hit || probe.obstacle;
      const stepDelta = probe.hit ? probe.y - prevY : 999;
      const stepJump = Math.abs(stepDelta);

      // Multi-scale local trailing windows (0.48m and 0.96m) detect beveled 13–24 cm curbs & pool walls
      // while allowing smooth rolling grades on hill streets (westRoad 4.2%) and sloped pool floors (bigPool 2.2%)!
      const idx2 = Math.max(0, histY.length - 2);
      const idx4 = Math.max(0, histY.length - 4);
      const win2Rise = probe.hit ? probe.y - histY[idx2] - localSlope * (s - histS[idx2]) : 999;
      const win4Rise = probe.hit ? probe.y - histY[idx4] - localSlope * (s - histS[idx4]) : 999;
      const isSteep = probe.hit && probe.absNy < 0.72;

      let edgeTriggered =
        isMissingOrObstacle ||
        stepJump > 0.135 ||
        win2Rise > 0.115 ||
        win2Rise < -0.145 ||
        win4Rise > 0.135 ||
        win4Rise < -0.175;

      if (!edgeTriggered && isSteep) {
        const cS = s + 0.24;
        const expNext = expY + localSlope * 0.24;
        const cProbe = queryRoadSurfaceAtXZ(idx, ox + ux * cS, oz + uz * cS, probe.y, expNext);
        if (!cProbe.hit || cProbe.obstacle || cProbe.absNy < 0.74 || Math.abs(cProbe.y - expNext) > 0.115) {
          edgeTriggered = true;
        }
      }

      if (edgeTriggered) {
        // Check if this is a sustained upward curb/median ridge (>= +0.12m across s and s + 0.22m) or low wall:
        // NEVER bridge across a real raised curb divider onto the sidewalk behind it!
        const nextCheckS = s + 0.22;
        const nextCheck = queryRoadSurfaceAtXZ(
          idx,
          ox + ux * nextCheckS,
          oz + uz * nextCheckS,
          probe.hit ? probe.y : prevY + 0.18,
          expY + localSlope * 0.22
        );
        const isSustainedUpCurb =
          (probe.hit && probe.y - expY >= 0.19 && nextCheck.hit && nextCheck.y - (expY + localSlope * 0.22) >= 0.15) ||
          (probe.obstacle && nextCheck.hit && nextCheck.y - (expY + localSlope * 0.22) >= 0.14);

        let bridged = false;
        if (!isSustainedUpCurb) {
          const blockRay = castRayInLaserGrid(
            idx,
            ox,
            prevY + 0.24,
            oz,
            ux,
            0,
            uz,
            Math.max(0.10, prevS),
            Math.min(maxDist, s + 0.78),
            0.68
          );
          if (!blockRay) {
            const lookOffsets = [0.30, 0.58, 0.84];
            for (let li = 0; li < lookOffsets.length; li++) {
              const sLook = s + lookOffsets[li];
              if (sLook + 0.22 > maxDist) break;
              const expLook1 = prevY + localSlope * (sLook - prevS);
              const lProbe1 = queryRoadSurfaceAtXZ(idx, ox + ux * sLook, oz + uz * sLook, expLook1, expLook1);
              if (
                lProbe1.hit &&
                !lProbe1.obstacle &&
                lProbe1.absNy >= 0.78 &&
                Math.abs(lProbe1.y - expLook1) <= 0.085
              ) {
                const sLook2 = sLook + 0.22;
                const expLook2 = prevY + localSlope * (sLook2 - prevS);
                const lProbe2 = queryRoadSurfaceAtXZ(idx, ox + ux * sLook2, oz + uz * sLook2, lProbe1.y, expLook2);
                if (
                  lProbe2.hit &&
                  !lProbe2.obstacle &&
                  lProbe2.absNy >= 0.76 &&
                  Math.abs(lProbe2.y - expLook2) <= 0.095
                ) {
                  s = sLook;
                  prevS = sLook;
                  prevY = lProbe1.y;
                  histS.push(sLook);
                  histY.push(lProbe1.y);
                  bridged = true;
                  break;
                }
              }
            }
          }
        }
        if (bridged) {
          continue;
        }

        // Backtrack 1–2 steps if curb bevel already started creeping up so lo sits right at the curb/wall toe
        let loIdx = histS.length - 1;
        const refIdx = Math.max(0, histS.length - 4);
        const refBaseY = histY[refIdx];
        const refBaseS = histS[refIdx];
        while (
          loIdx > refIdx &&
          Math.abs(histY[loIdx] - (refBaseY + localSlope * (histS[loIdx] - refBaseS))) > 0.055
        ) {
          loIdx--;
        }
        let lo = histS[loIdx];
        let hi = s;
        let edgeY = histY[loIdx];
        const baseLo = lo;
        const baseEdgeY = edgeY;
        for (let b = 0; b < 3; b++) {
          const mid = 0.5 * (lo + hi);
          const expMid = baseEdgeY + localSlope * (mid - baseLo);
          const mProbe = queryRoadSurfaceAtXZ(idx, ox + ux * mid, oz + uz * mid, edgeY, expMid);
          if (
            mProbe.hit &&
            !mProbe.obstacle &&
            mProbe.absNy >= 0.75 &&
            Math.abs(mProbe.y - edgeY) <= 0.065 &&
            mProbe.y - expMid <= 0.075 &&
            mProbe.y - expMid >= -0.105
          ) {
            lo = mid;
            edgeY = mProbe.y;
          } else {
            hi = mid;
          }
        }

        // Classify edge signature (rising curb/rim vs wall vs drop-off/void)
        const beyondS = Math.min(maxDist + 0.6, hi + 0.50);
        const bProbe = queryRoadSurfaceAtXZ(idx, ox + ux * beyondS, oz + uz * beyondS, edgeY + 0.45, edgeY + 0.45);
        const bProbeHi = queryRoadSurfaceAtXZ(idx, ox + ux * (hi + 0.85), oz + uz * (hi + 0.85), edgeY + 0.90, edgeY + 0.90);
        const wNear = castRayInLaserGrid(
          idx,
          ox,
          edgeY + 0.28,
          oz,
          ux,
          0,
          uz,
          Math.max(0.10, lo - 0.15),
          hi + 0.75,
          0.74
        );
        let edgeKind = "down_step";
        let rimHeight = 0;
        const riseHere = probe.hit ? probe.y - edgeY : -999;
        const riseBeyond = bProbe.hit ? bProbe.y - edgeY : -999;
        const riseFar = bProbeHi.hit ? bProbeHi.y - edgeY : -999;
        const maxDeckRise = Math.max(riseHere, riseBeyond, riseFar);

        if (wNear) {
          edgeKind = "wall";
          const wHi = castRayInLaserGrid(idx, ox, edgeY + 0.80, oz, ux, 0, uz, Math.max(0.10, lo - 0.15), hi + 0.95, 0.76);
          rimHeight = maxDeckRise > 0.20 ? maxDeckRise : wHi ? 0.95 : 0.38;
        } else if (maxDeckRise >= 0.095 || probe.obstacle) {
          edgeKind = "up_step";
          rimHeight = Math.max(0.12, maxDeckRise);
        } else if (!probe.hit && !bProbe.hit) {
          edgeKind = "void";
        }

        return {
          bounded: true,
          dist: lo,
          pt: new THREE.Vector3(ox + ux * lo, edgeY, oz + uz * lo),
          edgeKind,
          rimHeight,
        };
      }

      // Smoothly track rolling road/pool-floor grade via EMA on smooth steps (never polluted by curb ramps!)
      if (stepJump <= 0.042 && probe.absNy >= 0.84) {
        const backK = Math.max(0, histS.length - 3);
        const dsSpan = s - histS[backK];
        if (dsSpan >= 0.20) {
          const instSlope = Math.max(-0.11, Math.min(0.11, (probe.y - histY[backK]) / dsSpan));
          localSlope = hasSlope ? localSlope * 0.76 + instSlope * 0.24 : instSlope;
          hasSlope = true;
        }
      }
      prevS = s;
      prevY = probe.y;
      histS.push(s);
      histY.push(probe.y);
    }

    return {
      bounded: false,
      dist: maxDist,
      pt: new THREE.Vector3(ox + ux * maxDist, prevY, oz + uz * maxDist),
      edgeKind: "open",
      rimHeight: 0,
    };
  }

  function findDirectionalBoundary(idx, ox, oy, oz, ux, uz, maxDist, hasCeiling) {
    const surf = traceRoadEdgeAlongRay(idx, ox, oy, oz, ux, uz, maxDist);
    const hitLo = castRayInLaserGrid(idx, ox, oy + 0.24, oz, ux, 0, uz, 0.20, maxDist, 0.68);
    const hitHi = castRayInLaserGrid(idx, ox, oy + 0.78, oz, ux, 0, uz, 0.20, maxDist, 0.72);

    let wallHit = null;
    if (hitLo && hitHi) {
      if (hasCeiling || Math.abs(hitHi.t - hitLo.t) <= 0.70) {
        wallHit = hitLo.t <= hitHi.t ? hitLo : hitHi;
      } else {
        wallHit = hitLo;
      }
    } else if (hitLo) {
      wallHit = hitLo;
    } else if (hitHi && (hasCeiling || (surf.bounded && Math.abs(hitHi.t - surf.dist) <= 0.85))) {
      wallHit = hitHi;
    }

    const wallRimH = wallHit
      ? hitHi && Math.abs(hitHi.t - wallHit.t) <= 0.85
        ? 0.85
        : 0.32
      : 0;

    // Rule 1: If surface already terminated at a closer curb, pool toe, or drop-off BEFORE a distant setback wall/fence,
    // respect the closer surface boundary (prevents shooting over 15 cm road curbs into sidewalk fences/trucks!).
    if (surf.bounded && (!wallHit || surf.dist < wallHit.t - 0.32)) {
      return surf;
    }

    // Rule 2: Floor-rooted wall / pool wall / room wall stops the span
    if (wallHit && (!surf.bounded || wallHit.t <= surf.dist + 0.32)) {
      const dIn = Math.max(0, wallHit.t - 0.14);
      const fProbe = queryRoadSurfaceAtXZ(idx, ox + ux * dIn, oz + uz * dIn, oy, oy);
      const baseFloorY = fProbe.hit ? fProbe.y : surf.bounded ? surf.pt.y : oy;
      return {
        bounded: true,
        dist: wallHit.t,
        pt: new THREE.Vector3(ox + ux * wallHit.t, baseFloorY + 0.05, oz + uz * wallHit.t),
        edgeKind: "wall",
        rimHeight: Math.max(wallRimH, surf.bounded && Math.abs(surf.dist - wallHit.t) <= 0.55 ? surf.rimHeight : 0),
      };
    }

    if (surf.bounded) return surf;

    return {
      bounded: false,
      dist: maxDist,
      pt: new THREE.Vector3(ox + ux * maxDist, surf.pt.y, oz + uz * maxDist),
      edgeKind: "open",
      rimHeight: 0,
    };
  }

  function computeLaserSpanAtPoint(rawPt, surfNormal) {
    if (!studioThree || !rawPt) return null;
    const idx = getLaserSpatialIndex();
    if (!idx) return null;

    const n = surfNormal ? surfNormal.clone().normalize() : new THREE.Vector3(0, 1, 0);
    const camPos = studioThree.camera ? studioThree.camera.position : new THREE.Vector3(0, 50, 50);

    // Step 0: If hovered/clicked on a vertical wall, pool side, or curb riser (|ny| < 0.55),
    // step slightly inward toward the open space and drop onto the floor/road/pool bottom so the full 36-azimuth W×L solver runs!
    let sweepPt = rawPt.clone();
    let fallbackWallSpan = null;
    if (Math.abs(n.y) < 0.55) {
      let dx = n.x;
      let dz = n.z;
      const hLen = Math.hypot(dx, dz);
      if (hLen > 1e-5) {
        dx /= hLen;
        dz /= hLen;
        if ((camPos.x - rawPt.x) * dx + (camPos.z - rawPt.z) * dz < 0) {
          dx = -dx;
          dz = -dz;
        }
        let landedOnFloor = false;
        for (const stepIn of [0.35, 0.70]) {
          const gProbe = castRayInLaserGrid(
            idx,
            rawPt.x + dx * stepIn,
            rawPt.y + 0.45,
            rawPt.z + dz * stepIn,
            0,
            -1,
            0,
            0.05,
            9.0,
            1.01
          );
          if (gProbe && gProbe.absNy >= 0.58) {
            sweepPt = new THREE.Vector3(gProbe.x, gProbe.y, gProbe.z);
            landedOnFloor = true;
            break;
          }
        }
        if (!landedOnFloor) {
          const hitOpp = castRayInLaserGrid(idx, rawPt.x + dx * 0.06, rawPt.y, rawPt.z + dz * 0.06, dx, 0, dz, 0.14, 75.0, 0.85);
          if (hitOpp) {
            const pB = new THREE.Vector3(hitOpp.x, hitOpp.y, hitOpp.z);
            const w = rawPt.distanceTo(pB);
            const mid = new THREE.Vector3().addVectors(rawPt, pB).multiplyScalar(0.5);
            const ox = -dz, oz = dx;
            const oP = castRayInLaserGrid(idx, mid.x, mid.y, mid.z, ox, 0, oz, 0.20, 75.0, 0.75);
            const oM = castRayInLaserGrid(idx, mid.x, mid.y, mid.z, -ox, 0, -oz, 0.20, 75.0, 0.75);
            const oLen = oP && oM ? oP.t + oM.t : null;
            fallbackWallSpan = {
              kind: "wall_span",
              originPt: rawPt.clone(),
              pA: rawPt.clone(),
              pB,
              width: w,
              orthoLength: oLen && oLen >= 0.85 ? oLen : null,
              orthoPA: oLen && oLen >= 0.85 ? new THREE.Vector3(mid.x - ox * oM.t, mid.y, mid.z - oz * oM.t) : null,
              orthoPB: oLen && oLen >= 0.85 ? new THREE.Vector3(mid.x + ox * oP.t, mid.y, mid.z + oz * oP.t) : null,
              crossPt: mid,
            };
          }
        }
      }
    }

    // Step 1: Detect overhead ceiling for indoor Room classification
    const ceilRay = castRayInLaserGrid(idx, sweepPt.x, sweepPt.y + 0.18, sweepPt.z, 0, 1, 0, 0.9, 25.0, 1.01);
    const ceilRayCheck = ceilRay
      ? castRayInLaserGrid(idx, sweepPt.x + 0.38, sweepPt.y + 0.18, sweepPt.z + 0.38, 0, 1, 0, 0.9, 25.0, 1.01)
      : null;
    const hasCeiling = Boolean(
      ceilRay &&
        ceilRay.absNy >= 0.60 &&
        (!ceilRayCheck || (ceilRayCheck.absNy >= 0.50 && Math.abs(ceilRayCheck.y - ceilRay.y) <= 0.42))
    );
    const ceilHeight = hasCeiling ? ceilRay.y - sweepPt.y : null;
    const ceilPt = hasCeiling ? new THREE.Vector3(ceilRay.x, ceilRay.y, ceilRay.z) : null;

    // Step 2: Sweep N_AZ = 36 azimuths (every 5°) for primary cross-section candidates
    const N_AZ = 36;
    const MAX_WIDTH_SCAN = 44.0;
    const cands = new Array(N_AZ).fill(null);

    for (let k = 0; k < N_AZ; k++) {
      const ang = (k * Math.PI) / N_AZ;
      const ux = Math.cos(ang);
      const uz = Math.sin(ang);
      const bP = findDirectionalBoundary(idx, sweepPt.x, sweepPt.y, sweepPt.z, ux, uz, MAX_WIDTH_SCAN, hasCeiling);
      const bM = findDirectionalBoundary(idx, sweepPt.x, sweepPt.y, sweepPt.z, -ux, -uz, MAX_WIDTH_SCAN, hasCeiling);
      if (bP.bounded && bM.bounded && bP.dist >= 0.28 && bM.dist >= 0.28) {
        const w0 = Math.hypot(bP.pt.x - bM.pt.x, bP.pt.z - bM.pt.z);
        if (w0 >= 0.95) {
          cands[k] = { k, ang, ux, uz, bP, bM, w0 };
        }
      }
    }

    const validList = cands.filter(Boolean);
    if (validList.length === 0) {
      if (fallbackWallSpan) return fallbackWallSpan;
      return {
        kind: "point_only",
        originPt: rawPt.clone(),
        slopeDeg: THREE.MathUtils.radToDeg(Math.acos(Math.max(-1, Math.min(1, Math.abs(n.y))))),
      };
    }

    // Step 3: Parallel-Corridor Consistency & 90° Right-Angle Boundary Scoring
    // Select local minima around the 36-azimuth circle + top 8 narrowest chords
    const evalSet = new Set();
    const sortedByW = validList.slice().sort((a, b) => a.w0 - b.w0);
    for (let i = 0; i < Math.min(8, sortedByW.length); i++) {
      evalSet.add(sortedByW[i].k);
    }
    for (let k = 0; k < N_AZ; k++) {
      const c = cands[k];
      if (!c) continue;
      const prevC = cands[(k + N_AZ - 1) % N_AZ];
      const nextC = cands[(k + 1) % N_AZ];
      if ((!prevC || c.w0 <= prevC.w0 * 1.02) && (!nextC || c.w0 <= nextC.w0 * 1.02)) {
        evalSet.add(k);
      }
    }

    let bestCand = null;
    evalSet.forEach((k) => {
      const c = cands[k];
      const lx = -c.uz;
      const lz = c.ux;
      const dOff = Math.min(1.35, Math.max(0.50, c.w0 * 0.18));

      const evalOffsetChord = (mult) => {
        const ox = sweepPt.x + lx * dOff * mult;
        const oz = sweepPt.z + lz * dOff * mult;
        const oSurf = queryRoadSurfaceAtXZ(idx, ox, oz, sweepPt.y, sweepPt.y);
        if (!oSurf.hit || oSurf.obstacle || Math.abs(oSurf.y - sweepPt.y) > 0.28) {
          return { status: "end_wall" };
        }
        const oP = findDirectionalBoundary(idx, ox, oSurf.y, oz, c.ux, c.uz, MAX_WIDTH_SCAN, hasCeiling);
        const oM = findDirectionalBoundary(idx, ox, oSurf.y, oz, -c.ux, -c.uz, MAX_WIDTH_SCAN, hasCeiling);
        const wOff = oP.bounded && oM.bounded ? Math.hypot(oP.pt.x - oM.pt.x, oP.pt.z - oM.pt.z) : oP.dist + oM.dist;
        if (wOff > c.w0 * 1.24 + 0.45) {
          // Parallel ray on the same floor sailed right past c's endpoint to a much wider real wall/curb -> c hit an internal bump/obstacle!
          return { status: "wider_open", wOff };
        }
        if (!oP.bounded || !oM.bounded || Math.abs(wOff - c.w0) > Math.max(0.75, c.w0 * 0.26)) {
          return { status: "mismatch", wOff };
        }
        return { status: "match", oP, oM, wOff };
      };

      const rP1 = evalOffsetChord(1);
      const rM1 = evalOffsetChord(-1);
      const rP2 = evalOffsetChord(2.2);
      const rM2 = evalOffsetChord(-2.2);

      const chPlus = rP1.status === "match" ? rP1 : null;
      const chMinus = rM1.status === "match" ? rM1 : null;
      const widerCount = [rP1, rM1, rP2, rM2].filter((r) => r.status === "wider_open").length;

      let score;
      let refinedAng = c.ang;
      if (!chPlus && !chMinus) {
        score = c.w0 * 3.2;
      } else {
        const p1A = chMinus ? chMinus.oM.pt : c.bM.pt;
        const p2A = chPlus ? chPlus.oM.pt : c.bM.pt;
        const p1B = chMinus ? chMinus.oP.pt : c.bP.pt;
        const p2B = chPlus ? chPlus.oP.pt : c.bP.pt;

        const tAx = p2A.x - p1A.x, tAz = p2A.z - p1A.z;
        const tBx = p2B.x - p1B.x, tBz = p2B.z - p1B.z;
        const lenA = Math.hypot(tAx, tAz);
        const lenB = Math.hypot(tBx, tBz);

        const skewA = lenA > 0.15 ? Math.abs(c.ux * tAx + c.uz * tAz) / lenA : 0.25;
        const skewB = lenB > 0.15 ? Math.abs(c.ux * tBx + c.uz * tBz) / lenB : 0.25;
        const skewPenalty = 0.5 * (skewA + skewB);

        const diffs = [];
        if (chPlus) diffs.push(Math.abs(chPlus.wOff - c.w0) / c.w0);
        if (chMinus) diffs.push(Math.abs(chMinus.wOff - c.w0) / c.w0);
        const relDiff = diffs.reduce((s, v) => s + v, 0) / diffs.length;

        // Penalize internal floor bumps/parked scooter grazes where adjacent floor chords open up much wider!
        const internalBumpPenalty = widerCount > 0 ? 1.0 + 0.85 * widerCount : 1.0;
        const singleSidePenalty = !chPlus || !chMinus ? 1.12 : 1.0;
        score = c.w0 * (1.0 + 0.85 * skewPenalty + 0.65 * relDiff) * internalBumpPenalty * singleSidePenalty;

        // Sub-5° exact edge-normal refinement when both opposing curbs/walls agree in tangent direction
        if (lenA > 0.25 && lenB > 0.25 && skewA < 0.24 && skewB < 0.24) {
          let uAx = tAx / lenA, uAz = tAz / lenA;
          let uBx = tBx / lenB, uBz = tBz / lenB;
          if (uAx * uBx + uAz * uBz < 0) {
            uBx = -uBx;
            uBz = -uBz;
          }
          const avgTx = uAx + uBx;
          const avgTz = uAz + uBz;
          const avgTLen = Math.hypot(avgTx, avgTz);
          if (avgTLen > 0.5) {
            let nx = avgTz / avgTLen;
            let nz = -avgTx / avgTLen;
            if (nx * c.ux + nz * c.uz < 0) {
              nx = -nx;
              nz = -nz;
            }
            refinedAng = Math.atan2(nz, nx);
          }
        }
      }

      if (!bestCand || score < bestCand.score) {
        bestCand = { ...c, score, refinedAng };
      }
    });

    if (!bestCand) {
      bestCand = { ...sortedByW[0], score: sortedByW[0].w0, refinedAng: sortedByW[0].ang };
    }

    // Step 4: Lock Orthogonal Width × Length Axes (leveraging longitudinal corridor lever-arm on roads!)
    let angW = bestCand.refinedAng;
    let uxW = Math.cos(angW);
    let uzW = Math.sin(angW);
    let bW_P = bestCand.bP;
    let bW_M = bestCand.bM;
    if (Math.abs(angW - bestCand.ang) > 0.008) {
      const rP = findDirectionalBoundary(idx, sweepPt.x, sweepPt.y, sweepPt.z, uxW, uzW, MAX_WIDTH_SCAN, hasCeiling);
      const rM = findDirectionalBoundary(idx, sweepPt.x, sweepPt.y, sweepPt.z, -uxW, -uzW, MAX_WIDTH_SCAN, hasCeiling);
      if (rP.bounded && rM.bounded) {
        const rw = Math.hypot(rP.pt.x - rM.pt.x, rP.pt.z - rM.pt.z);
        if (rw >= 0.85 && rw <= bestCand.w0 * 1.08) {
          bW_P = rP;
          bW_M = rM;
        } else {
          angW = bestCand.ang;
          uxW = bestCand.ux;
          uzW = bestCand.uz;
        }
      }
    }

    const computeCenterlineOrigin = (pM, pP) => {
      const mx = 0.5 * (pM.pt.x + pP.pt.x);
      const mz = 0.5 * (pM.pt.z + pP.pt.z);
      const avgY = 0.5 * (pM.pt.y + pP.pt.y);
      const mSurf = queryRoadSurfaceAtXZ(idx, mx, mz, sweepPt.y, avgY);
      if (mSurf.hit && !mSurf.obstacle && Math.abs(mSurf.y - sweepPt.y) <= 0.45) {
        return new THREE.Vector3(mx, mSurf.y, mz);
      }
      return sweepPt.clone();
    };

    let midOrigin = computeCenterlineOrigin(bW_M, bW_P);
    const width0 = bW_M.pt.distanceTo(bW_P.pt);

    // Probe longitudinal Length along angL = angW + π/2 (+ fine ±8° sweep to prevent grazing curbs on long streets)
    const MAX_LEN_SCAN = 120.0;
    const baseAngL = angW + Math.PI * 0.5;
    const fineDeltasDeg = [0, -2, 2, -4, 4, -6, 6, -8, 8];
    const lenProbes = [];
    for (let i = 0; i < fineDeltasDeg.length; i++) {
      const dRad = (fineDeltasDeg[i] * Math.PI) / 180;
      const aL = baseAngL + dRad;
      const lx = Math.cos(aL);
      const lz = Math.sin(aL);
      const lP = findDirectionalBoundary(idx, midOrigin.x, midOrigin.y, midOrigin.z, lx, lz, MAX_LEN_SCAN, hasCeiling);
      const lM = findDirectionalBoundary(idx, midOrigin.x, midOrigin.y, midOrigin.z, -lx, -lz, MAX_LEN_SCAN, hasCeiling);
      const spanL = lP.dist + lM.dist;
      lenProbes.push({ dDeg: fineDeltasDeg[i], aL, lx, lz, lP, lM, spanL });
    }

    let chosenLen = lenProbes[0];
    const maxLenRun = Math.max(...lenProbes.map((p) => p.spanL));
    const minLenRun = Math.min(...lenProbes.map((p) => p.spanL));

    if (maxLenRun > width0 * 2.1 && maxLenRun > chosenLen.spanL * 1.15) {
      // Elongated road/corridor regime: the angle that runs farthest down the corridor without grazing curbs is the true road axis!
      chosenLen = lenProbes.reduce((best, p) => (p.spanL > best.spanL ? p : best), lenProbes[0]);
      // Re-lock Width strictly 90.0° perpendicular to the true longitudinal road axis
      const lockedAngW = chosenLen.aL - Math.PI * 0.5;
      const lux = Math.cos(lockedAngW);
      const luz = Math.sin(lockedAngW);
      const lockP = findDirectionalBoundary(idx, sweepPt.x, sweepPt.y, sweepPt.z, lux, luz, MAX_WIDTH_SCAN, hasCeiling);
      const lockM = findDirectionalBoundary(idx, sweepPt.x, sweepPt.y, sweepPt.z, -lux, -luz, MAX_WIDTH_SCAN, hasCeiling);
      if (lockP.bounded && lockM.bounded) {
        const lw = lockM.pt.distanceTo(lockP.pt);
        if (lw >= 0.85 && lw <= width0 * 1.12) {
          uxW = lux;
          uzW = luz;
          bW_P = lockP;
          bW_M = lockM;
          midOrigin = computeCenterlineOrigin(bW_M, bW_P);
        }
      }
    } else if (maxLenRun <= width0 * 3.8 && maxLenRun <= minLenRun * 1.25) {
      // Enclosed Pool / Room regime: pick shortest perpendicular end-to-end distance
      chosenLen = lenProbes.reduce((best, p) => (p.spanL < best.spanL ? p : best), lenProbes[0]);
    }

    // On wide roads (>= 2.8m), also check quarter-width lane chords so a single parked vehicle/pole on centerline doesn't truncate road length
    let finalLP = chosenLen.lP;
    let finalLM = chosenLen.lM;
    const lx = chosenLen.lx;
    const lz = chosenLen.lz;
    const curWidth = bW_M.pt.distanceTo(bW_P.pt);

    if (!hasCeiling && curWidth >= 2.8) {
      const laneOff = Math.min(2.2, curWidth * 0.24);
      for (const sgn of [-1, 1]) {
        const qx = midOrigin.x + uxW * laneOff * sgn;
        const qz = midOrigin.z + uzW * laneOff * sgn;
        const qSurf = queryRoadSurfaceAtXZ(idx, qx, qz, midOrigin.y, midOrigin.y);
        if (!qSurf.hit || qSurf.obstacle || Math.abs(qSurf.y - midOrigin.y) > 0.25) continue;
        const qLP = findDirectionalBoundary(idx, qx, qSurf.y, qz, lx, lz, MAX_LEN_SCAN, false);
        const qLM = findDirectionalBoundary(idx, qx, qSurf.y, qz, -lx, -lz, MAX_LEN_SCAN, false);
        if (qLP.dist > finalLP.dist * 1.45 && qLP.dist > curWidth * 1.6) {
          finalLP = {
            ...qLP,
            pt: new THREE.Vector3(midOrigin.x + lx * qLP.dist, qLP.pt.y, midOrigin.z + lz * qLP.dist),
          };
        }
        if (qLM.dist > finalLM.dist * 1.45 && qLM.dist > curWidth * 1.6) {
          finalLM = {
            ...qLM,
            pt: new THREE.Vector3(midOrigin.x - lx * qLM.dist, qLM.pt.y, midOrigin.z - lz * qLM.dist),
          };
        }
      }
    }

    let pA = bW_M.pt.clone();
    let pB = bW_P.pt.clone();
    let width = pA.distanceTo(pB);

    let orthoPA = finalLM.pt.clone();
    let orthoPB = finalLP.pt.clone();
    let orthoLength = orthoPA.distanceTo(orthoPB);
    if (!Number.isFinite(orthoLength) || orthoLength < 0.85) {
      orthoPA = null;
      orthoPB = null;
      orthoLength = null;
    }

    const horizSpan = Math.max(0.1, Math.hypot(pB.x - pA.x, pB.z - pA.z));
    const crossSlopePct = (Math.abs(pB.y - pA.y) / horizSpan) * 100;

    // Step 5: Classify Indoor Room vs Sunken Pool / Pit / Open Basin vs Road / Corridor
    const fourSides = [bW_M, bW_P, finalLM, finalLP];
    const boundedCount = fourSides.filter((s) => s && s.bounded).length;
    const risingSides = fourSides.filter((s) => s && s.bounded && (s.edgeKind === "wall" || s.edgeKind === "up_step"));
    const tallRimSides = risingSides.filter((s) => (s.rimHeight || 0) >= 0.25);
    const maxSpan = orthoLength ? Math.max(width, orthoLength) : width;
    const minSpan = orthoLength ? Math.min(width, orthoLength) : width;
    const aspect = maxSpan / Math.max(0.4, minSpan);

    let kind = "road";
    let pitDepth = null;

    if (hasCeiling) {
      kind = "room";
    } else if (
      orthoLength &&
      boundedCount === 4 &&
      ((risingSides.length === 4 && maxSpan <= 55.0 && aspect <= 3.8) ||
        (risingSides.length >= 3 && tallRimSides.length >= 2 && maxSpan <= 78.0 && aspect <= 4.5))
    ) {
      kind = "pool";
      const avgRim =
        risingSides.reduce((acc, s) => acc + (s.rimHeight || 0), 0) / Math.max(1, risingSides.length);
      if (avgRim >= 0.24) {
        pitDepth = avgRim;
      }
    }

    // For Rooms and Pools/Pits, canonicalize so Width <= Length (寬 <= 長)
    if ((kind === "room" || kind === "pool") && orthoLength && width > orthoLength) {
      const tmpA = pA, tmpB = pB, tmpW = width;
      pA = orthoPA;
      pB = orthoPB;
      width = orthoLength;
      orthoPA = tmpA;
      orthoPB = tmpB;
      orthoLength = tmpW;
    }

    const areaM2 = (kind === "room" || kind === "pool") && orthoLength ? width * orthoLength : null;

    return {
      kind,
      originPt: rawPt.clone(),
      pA,
      pB,
      width,
      orthoLength,
      orthoPA,
      orthoPB,
      crossPt: midOrigin.clone(),
      crossSlopePct,
      areaM2,
      pitDepth,
      ceilHeight,
      ceilPt,
      floorPt: sweepPt.clone(),
    };
  }

  function formatSlopeDhL(dh, horizLen) {
    const absDh = Math.abs(Number(dh) || 0);
    const L = Math.max(0.001, Number(horizLen) || 0);
    if (absDh < 1e-3) return "0:1";
    const ratio = L / absDh;
    const ratioStr = ratio >= 10 ? String(Math.round(ratio)) : ratio.toFixed(1).replace(/\.0$/, "");
    return `1:${ratioStr}`;
  }
  window.formatSlopeDhL = formatSlopeDhL;

  function renderLaserVisuals(spanInfo, existingMeas = null) {
    if (!studioThree) return;
    const isTemp = !existingMeas;
    const info = existingMeas || spanInfo;
    if (isTemp) {
      clearTempDistanceVisuals();
    }
    if (!info || !info.originPt) return;

    const addObj = (mesh) => {
      studioThree.overlayGroup.add(mesh);
      if (isTemp) STATE.tempDistanceObjects.push(mesh);
    };

    const addLaserBeam = (start, end, colorHex, pixelRad = 1.65, opacity = 0.94) => {
      const lDir = new THREE.Vector3().subVectors(end, start);
      const lLen = lDir.length();
      if (lLen <= 0.02) return;
      const coreLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([start, end]),
        new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 1, depthTest: false, transparent: true, opacity: 0.88 })
      );
      coreLine.renderOrder = 1000;
      addObj(coreLine);

      const rodGeo = new THREE.CylinderGeometry(1, 1, lLen, 10);
      const rodMat = new THREE.MeshBasicMaterial({
        color: colorHex,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity,
      });
      const rod = new THREE.Mesh(rodGeo, rodMat);
      rod.position.copy(start).addScaledVector(lDir, 0.5);
      rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), lDir.clone().normalize());
      rod.userData.isZoomInvariantRod = true;
      rod.userData.pixelRadius = pixelRad;
      rod.renderOrder = 999;
      addObj(rod);
    };

    // Origin emitter dot
    add3DPinMarker(info.originPt, 0xff2d55, studioThree.overlayGroup, addObj);

    if (info.kind === "point_only" || !info.pA || !info.pB) {
      const twd = localToTwd97(info.originPt);
      const slopeRad = ((Number(info.slopeDeg) || 0) * Math.PI) / 180;
      const ptDhL = formatSlopeDhL(Math.tan(slopeRad), 1.0);
      add2DBadge(
        info.originPt,
        `<div class="autodesk-laser-pair ${isTemp ? "" : "pinned"}">` +
          `<span class="laser-bubble laser-bubble-w">H ${twd.h >= 0 ? "+" : ""}${twd.h.toFixed(2)} m</span>` +
          `<span class="laser-bubble laser-bubble-slope">${ptDhL}</span>` +
        `</div>`,
        "#e11d48",
        { rawHtml: true, offsetY: isTemp ? -20 : -14, isTempDistance: isTemp }
      );
      updateZoomInvariantElements();
      return;
    }

    // Primary Width Laser Beam (pA <-> pB, crimson-pink) + endpoint pins
    addLaserBeam(info.pA, info.pB, 0xff2d55, 1.85, 0.95);
    add3DPinMarker(info.pA, 0xff2d55, studioThree.overlayGroup, addObj);
    add3DPinMarker(info.pB, 0xff2d55, studioThree.overlayGroup, addObj);

    const crossC = info.crossPt || info.originPt || new THREE.Vector3().addVectors(info.pA, info.pB).multiplyScalar(0.5);

    // Secondary Orthogonal Length Laser Beam (orthoPA <-> orthoPB, vivid sky-blue) + 90° intersection tick
    if (info.orthoPA && info.orthoPB && info.orthoLength) {
      addLaserBeam(info.orthoPA, info.orthoPB, 0x38bdf8, 1.40, 0.88);
      add3DPinMarker(info.orthoPA, 0x38bdf8, studioThree.overlayGroup, addObj);
      add3DPinMarker(info.orthoPB, 0x38bdf8, studioThree.overlayGroup, addObj);

      // Draw crisp 90° right-angle symbol at intersection of Width & Length axes
      const uW = new THREE.Vector3().subVectors(info.pB, info.pA).setY(0);
      const uL = new THREE.Vector3().subVectors(info.orthoPB, info.orthoPA).setY(0);
      if (uW.lengthSq() > 1e-4 && uL.lengthSq() > 1e-4) {
        uW.normalize();
        uL.normalize();
        const tickSz = Math.min(0.65, Math.max(0.22, Math.min(info.width, info.orthoLength) * 0.08));
        const yTick = crossC.y + 0.08;
        const c1 = new THREE.Vector3(crossC.x + uW.x * tickSz, yTick, crossC.z + uW.z * tickSz);
        const c2 = new THREE.Vector3(
          crossC.x + uW.x * tickSz + uL.x * tickSz,
          yTick,
          crossC.z + uW.z * tickSz + uL.z * tickSz
        );
        const c3 = new THREE.Vector3(crossC.x + uL.x * tickSz, yTick, crossC.z + uL.z * tickSz);
        const sqLine = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([c1, c2, c3]),
          new THREE.LineBasicMaterial({ color: 0xfef08a, linewidth: 2, depthTest: false, transparent: true, opacity: 0.95 })
        );
        sqLine.renderOrder = 1002;
        addObj(sqLine);
      }
    }

    // Optional Vertical Ceiling Clearance Laser (floorPt <-> ceilPt, amber)
    if (info.ceilPt && info.floorPt && info.ceilHeight) {
      addLaserBeam(info.floorPt, info.ceilPt, 0xf59e0b, 1.15, 0.72);
      add3DPinMarker(info.ceilPt, 0xf59e0b, studioThree.overlayGroup, addObj);
    }

    // 1. Width Label: placed on the Width beam away from the cross-section intersection point, with [W ... m] [dh:L] bubbles
    const dWA = crossC.distanceTo(info.pA);
    const dWB = crossC.distanceTo(info.pB);
    const widthFarEnd = dWA >= dWB ? info.pA : info.pB;
    const widthLabelAnchor = crossC.clone().lerp(widthFarEnd, 0.56);
    const wDh = Math.abs(info.pB.y - info.pA.y);
    const wHoriz = Math.max(0.05, Math.hypot(info.pB.x - info.pA.x, info.pB.z - info.pA.z));
    const wSlopeDhL = formatSlopeDhL(wDh, wHoriz);

    add2DBadge(
      widthLabelAnchor,
      `<div class="autodesk-laser-pair ${isTemp ? "" : "pinned"}">` +
        `<span class="laser-bubble laser-bubble-w">W ${info.width.toFixed(2)} m</span>` +
        `<span class="laser-bubble laser-bubble-slope">${wSlopeDhL}</span>` +
      `</div>`,
      "#e11d48",
      { rawHtml: true, offsetY: -12, isTempDistance: isTemp }
    );

    // 2. Length Label: separate label placed on the Length beam away from the cross-section intersection point, with [L ... m] [dh:L] bubbles
    if (info.orthoPA && info.orthoPB && info.orthoLength) {
      const dLA = crossC.distanceTo(info.orthoPA);
      const dLB = crossC.distanceTo(info.orthoPB);
      const lengthFarEnd = dLA >= dLB ? info.orthoPA : info.orthoPB;
      const lengthLabelAnchor = crossC.clone().lerp(lengthFarEnd, 0.56);
      const lDh = Math.abs(info.orthoPB.y - info.orthoPA.y);
      const lHoriz = Math.max(0.05, Math.hypot(info.orthoPB.x - info.orthoPA.x, info.orthoPB.z - info.orthoPA.z));
      const lSlopeDhL = formatSlopeDhL(lDh, lHoriz);

      add2DBadge(
        lengthLabelAnchor,
        `<div class="autodesk-laser-pair ${isTemp ? "" : "pinned"}">` +
          `<span class="laser-bubble laser-bubble-l">L ${info.orthoLength.toFixed(2)} m</span>` +
          `<span class="laser-bubble laser-bubble-slope">${lSlopeDhL}</span>` +
        `</div>`,
        "#38bdf8",
        { rawHtml: true, offsetY: -12, isTempDistance: isTemp }
      );
    }

    updateZoomInvariantElements();
  }


  function isMeshVisibleUnderRoot(mesh, rootStop) {
    let cur = mesh;
    while (cur) {
      if (!cur.visible) return false;
      if (cur === rootStop) break;
      cur = cur.parent;
    }
    return true;
  }

  function pointInPoly2D(px, py, poly) {
    let inside = false;
    const n = poly.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = poly[i][0], yi = poly[i][1];
      const xj = poly[j][0], yj = poly[j][1];
      const intersect = (yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-12) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function fillEmptyDepthCells3x3JS(grid, G) {
    const out = new Float32Array(grid.length);
    for (let y = 0; y < G; y++) {
      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(G - 1, y + 1);
      for (let x = 0; x < G; x++) {
        const idx = y * G + x;
        const v = grid[idx];
        if (v > 0) {
          out[idx] = v;
          continue;
        }
        let best = 1e30;
        const x0 = Math.max(0, x - 1);
        const x1 = Math.min(G - 1, x + 1);
        for (let yy = y0; yy <= y1; yy++) {
          const row = yy * G;
          for (let xx = x0; xx <= x1; xx++) {
            const nv = grid[row + xx];
            if (nv > 0 && nv < best) best = nv;
          }
        }
        out[idx] = best < 1e29 ? best : 0;
      }
    }
    return out;
  }

  function getEffectiveLassoVisibleOnly(mode = null) {
    const m = mode || (STATE.activeTool === "crop" && STATE.cropMode === "keep_inside" ? "keep_inside" : STATE.cropMode || "delete_inside");
    return m === "delete_inside" ? Boolean(STATE.lassoVisibleOnlyDelete) : Boolean(STATE.lassoVisibleOnlyKeep);
  }

  function studioWorldToTilesetNative(worldPt) {
    if (!worldPt) return [0, 0, 0];
    if (!studioThree || !studioThree.modelPivot) {
      const t = localToTwd97(worldPt);
      return [t.e, t.n, t.h];
    }
    studioThree.modelPivot.updateMatrixWorld(true);
    const invPivot = studioThree.modelPivot.matrixWorld.clone().invert();
    const local = worldPt.clone().applyMatrix4(invPivot);
    const tc = studioThree.tilesCenter || [0, 0, 0];
    return [local.x + tc[0], local.y + tc[1], local.z + tc[2]];
  }

  function clearLassoHighlight3D() {
    if (studioThree && studioThree.overlayGroup) {
      const toRemove = [];
      studioThree.overlayGroup.children.forEach((c) => {
        if (c.userData && c.userData.isLassoHighlight) toRemove.push(c);
      });
      toRemove.forEach((c) => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
        studioThree.overlayGroup.remove(c);
      });
    }
    STATE.badges2D = STATE.badges2D.filter((b) => {
      if (b.isLassoHighlight) {
        b.el?.remove();
        return false;
      }
      return true;
    });
    STATE.lassoSelectedTriCount = 0;
  }

  function clearLassoSelectionState() {
    if (studioThree && typeof studioThree._cancelLassoDrag === "function") {
      studioThree._cancelLassoDrag();
    }
    STATE.lassoStrokes = [];
    STATE.pendingCropPolygons = [];
    STATE.cropPolygonPoints = [];
    STATE.lassoSelectedTriCount = 0;
    clearLassoHighlight3D();
    if (
      STATE.activeTool === "crop" ||
      STATE.activeTool === "crop_delete" ||
      STATE.activeTool === "optimizer" ||
      STATE.activeTool === "crs" ||
      STATE.activeTool === "generate_scan"
    ) {
      clearAreaVisualsOnly();
    }
  }

  function collectVisibleStudioScanMeshes() {
    const meshes = [];
    if (!studioThree) return meshes;
    if (STATE.multiAlign?.active && studioThree.multiAlignGroup && studioThree.multiAlignGroup.visible) {
      studioThree.multiAlignGroup.updateMatrixWorld(true);
      (STATE.multiAlign.layers || []).forEach((layer) => {
        if (!layer || !layer.visible || !layer.zUpGroup) return;
        layer.zUpGroup.traverse((m) => {
          if (
            m &&
            m.isMesh &&
            !m.userData?.isAlignBoxHelper &&
            m.geometry &&
            m.geometry.attributes &&
            m.geometry.attributes.position &&
            isMeshVisibleUnderRoot(m, studioThree.multiAlignGroup)
          ) {
            m.userData._alignLayerScanId = layer.scan_id;
            m.userData._alignZUpGroup = layer.zUpGroup;
            meshes.push(m);
          }
        });
      });
      return meshes;
    }
    if (!studioThree.modelPivot || !studioThree.modelPivot.visible) return meshes;
    studioThree.modelPivot.updateMatrixWorld(true);
    studioThree.modelPivot.traverse((m) => {
      if (
        m &&
        m.isMesh &&
        m.geometry &&
        m.geometry.attributes &&
        m.geometry.attributes.position &&
        isMeshVisibleUnderRoot(m, studioThree.modelPivot)
      ) {
        m.userData._alignLayerScanId = null;
        m.userData._alignZUpGroup = null;
        meshes.push(m);
      }
    });
    return meshes;
  }

  function buildStudioLassoFrustumStroke(screenPts, op = "add") {
    if (!studioThree || !studioThree.renderer || !studioThree.camera || !screenPts || screenPts.length < 3) {
      return null;
    }
    const rect = studioThree.renderer.domElement.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);

    const rawNdc = screenPts.map((p) => [
      Math.max(-1.05, Math.min(1.05, (p.x / w) * 2 - 1)),
      Math.max(-1.05, Math.min(1.05, 1 - (p.y / h) * 2)),
    ]);

    const maxVerts = 96;
    const ndcPoly = [];
    if (rawNdc.length <= maxVerts) {
      for (let i = 0; i < rawNdc.length; i++) ndcPoly.push(rawNdc[i]);
    } else {
      const step = (rawNdc.length - 1) / (maxVerts - 1);
      for (let i = 0; i < maxVerts; i++) {
        ndcPoly.push(rawNdc[Math.min(rawNdc.length - 1, Math.round(i * step))]);
      }
    }
    if (ndcPoly.length < 3) return null;

    let bMinX = 1e9, bMinY = 1e9, bMaxX = -1e9, bMaxY = -1e9;
    for (let i = 0; i < ndcPoly.length; i++) {
      const px = ndcPoly[i][0], py = ndcPoly[i][1];
      if (px < bMinX) bMinX = px;
      if (px > bMaxX) bMaxX = px;
      if (py < bMinY) bMinY = py;
      if (py > bMaxY) bMaxY = py;
    }
    if (bMaxX - bMinX < 0.004 || bMaxY - bMinY < 0.004) return null;

    const cam = studioThree.camera;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    studioThree.modelPivot.updateMatrixWorld(true);

    const viewProjMat = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const tilesCenter = studioThree.tilesCenter ? studioThree.tilesCenter.slice() : [0, 0, 0];
    const upMat = studioThree.tileUpMatrix ? studioThree.tileUpMatrix.clone() : new THREE.Matrix4();
    const pivotMat = studioThree.modelPivot.matrixWorld.clone();

    // Conservative 160x160 frontmost camera-depth grid across all visible Studio scan triangles
    const G = 160;
    const infVal = 1e30;
    const depthRaw = new Float32Array(G * G);
    depthRaw.fill(infVal);
    const padMinX = Math.max(-1.05, bMinX - 0.05);
    const padMaxX = Math.min(1.05, bMaxX + 0.05);
    const padMinY = Math.max(-1.05, bMinY - 0.05);
    const padMaxY = Math.min(1.05, bMaxY + 0.05);
    const cellDiagNdc = 1.42 / G;

    const meshes = collectVisibleStudioScanMeshes();
    const mvp = new THREE.Matrix4();

    for (let mi = 0; mi < meshes.length; mi++) {
      const m = meshes[mi];
      mvp.multiplyMatrices(viewProjMat, m.matrixWorld);
      const e = mvp.elements;
      const posAttr = m.geometry.attributes.position;
      const idxAttr = m.geometry.index;
      const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(posAttr.count / 3);

      for (let t = 0; t < triCount; t++) {
        const i0 = idxAttr ? idxAttr.getX(t * 3) : t * 3;
        const i1 = idxAttr ? idxAttr.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = idxAttr ? idxAttr.getX(t * 3 + 2) : t * 3 + 2;

        const x0 = posAttr.getX(i0), y0 = posAttr.getY(i0), z0 = posAttr.getZ(i0);
        const cw0 = e[3] * x0 + e[7] * y0 + e[11] * z0 + e[15];
        if (cw0 <= 0.05) continue;

        const x1 = posAttr.getX(i1), y1 = posAttr.getY(i1), z1 = posAttr.getZ(i1);
        const cw1 = e[3] * x1 + e[7] * y1 + e[11] * z1 + e[15];
        if (cw1 <= 0.05) continue;

        const x2 = posAttr.getX(i2), y2 = posAttr.getY(i2), z2 = posAttr.getZ(i2);
        const cw2 = e[3] * x2 + e[7] * y2 + e[11] * z2 + e[15];
        if (cw2 <= 0.05) continue;

        const nx0 = (e[0] * x0 + e[4] * y0 + e[8] * z0 + e[12]) / cw0;
        const ny0 = (e[1] * x0 + e[5] * y0 + e[9] * z0 + e[13]) / cw0;
        const nx1 = (e[0] * x1 + e[4] * y1 + e[8] * z1 + e[12]) / cw1;
        const ny1 = (e[1] * x1 + e[5] * y1 + e[9] * z1 + e[13]) / cw1;
        const nx2 = (e[0] * x2 + e[4] * y2 + e[8] * z2 + e[12]) / cw2;
        const ny2 = (e[1] * x2 + e[5] * y2 + e[9] * z2 + e[13]) / cw2;

        const tMinX = Math.min(nx0, nx1, nx2);
        const tMaxX = Math.max(nx0, nx1, nx2);
        const tMinY = Math.min(ny0, ny1, ny2);
        const tMaxY = Math.max(ny0, ny1, ny2);
        if (tMaxX < padMinX || tMinX > padMaxX || tMaxY < padMinY || tMinY > padMaxY) continue;

        const gx0 = Math.max(0, Math.min(G - 1, Math.floor((tMinX * 0.5 + 0.5) * G)));
        const gx1 = Math.max(0, Math.min(G - 1, Math.floor((tMaxX * 0.5 + 0.5) * G)));
        const gy0 = Math.max(0, Math.min(G - 1, Math.floor((tMinY * 0.5 + 0.5) * G)));
        const gy1 = Math.max(0, Math.min(G - 1, Math.floor((tMaxY * 0.5 + 0.5) * G)));

        const wMin = Math.min(cw0, cw1, cw2);
        const wMax = Math.max(cw0, cw1, cw2);

        if (gx0 === gx1 && gy0 === gy1) {
          const gi = gy0 * G + gx0;
          if (wMin < depthRaw[gi]) depthRaw[gi] = wMin;
          continue;
        }

        const denom = (ny1 - ny2) * (nx0 - nx2) + (nx2 - nx1) * (ny0 - ny2);
        const absDenom = Math.abs(denom);
        if (absDenom < 1e-9) {
          for (let gy = gy0; gy <= gy1; gy++) {
            const row = gy * G;
            for (let gx = gx0; gx <= gx1; gx++) {
              if (wMin < depthRaw[row + gx]) depthRaw[row + gx] = wMin;
            }
          }
          continue;
        }

        const invDenom = 1.0 / denom;
        const m0 = (cellDiagNdc * Math.hypot(nx2 - nx1, ny2 - ny1)) / absDenom;
        const m1 = (cellDiagNdc * Math.hypot(nx0 - nx2, ny0 - ny2)) / absDenom;
        const m2 = (cellDiagNdc * Math.hypot(nx1 - nx0, ny1 - ny0)) / absDenom;

        for (let gy = gy0; gy <= gy1; gy++) {
          const py = ((gy + 0.5) / G) * 2 - 1;
          const row = gy * G;
          for (let gx = gx0; gx <= gx1; gx++) {
            const px = ((gx + 0.5) / G) * 2 - 1;
            const l0 = ((ny1 - ny2) * (px - nx2) + (nx2 - nx1) * (py - ny2)) * invDenom;
            if (l0 < -m0) continue;
            const l1 = ((ny2 - ny0) * (px - nx2) + (nx0 - nx2) * (py - ny2)) * invDenom;
            if (l1 < -m1) continue;
            const l2 = 1.0 - l0 - l1;
            if (l2 < -m2) continue;
            const wInterp = Math.max(wMin, Math.min(wMax, l0 * cw0 + l1 * cw1 + l2 * cw2));
            if (wInterp < depthRaw[row + gx]) depthRaw[row + gx] = wInterp;
          }
        }
      }
    }

    const depthGridList = new Array(G * G);
    for (let i = 0; i < G * G; i++) {
      depthGridList[i] = depthRaw[i] < 1e29 ? Math.round(depthRaw[i] * 1000) / 1000 : 0;
    }

    let layerZUpToClip = null;
    if (STATE.multiAlign?.active && Array.isArray(STATE.multiAlign.layers)) {
      if (studioThree.multiAlignGroup) studioThree.multiAlignGroup.updateMatrixWorld(true);
      layerZUpToClip = {};
      STATE.multiAlign.layers.forEach((layer) => {
        if (!layer || !layer.visible || !layer.zUpGroup) return;
        const lMat = new THREE.Matrix4().multiplyMatrices(viewProjMat, layer.zUpGroup.matrixWorld);
        layerZUpToClip[layer.scan_id] = Array.from(lMat.elements);
      });
    }

    const strokeObj = {
      op: op === "sub" ? "sub" : "add",
      ndc_polygon: ndcPoly.map((p) => [Math.round(p[0] * 100000) / 100000, Math.round(p[1] * 100000) / 100000]),
      tiles_center: tilesCenter,
      up_matrix: Array.from(upMat.elements),
      pivot_matrix: Array.from(pivotMat.elements),
      view_proj_matrix: Array.from(viewProjMat.elements),
      visible_only: getEffectiveLassoVisibleOnly(),
      depth_grid_size: G,
      depth_grid: depthGridList,
      depth_tolerance_m: 0.85,
    };
    if (layerZUpToClip) {
      strokeObj.layer_zup_to_clip = layerZUpToClip;
    }
    return strokeObj;
  }

  function prepareStrokeEvalList(rawStrokes, overrideVisibleOnly = null) {
    if (!Array.isArray(rawStrokes) || rawStrokes.length === 0) return [];
    return rawStrokes.map((st) => {
      const visOnly = overrideVisibleOnly !== null ? Boolean(overrideVisibleOnly) : Boolean(st.visible_only);
      const poly = st.ndc_polygon || [];
      let bMinX = 1e9, bMinY = 1e9, bMaxX = -1e9, bMaxY = -1e9;
      for (let i = 0; i < poly.length; i++) {
        if (poly[i][0] < bMinX) bMinX = poly[i][0];
        if (poly[i][0] > bMaxX) bMaxX = poly[i][0];
        if (poly[i][1] < bMinY) bMinY = poly[i][1];
        if (poly[i][1] > bMaxY) bMaxY = poly[i][1];
      }
      const G = Number(st.depth_grid_size) || 0;
      let dgFilled = null;
      let maxValidW = 0;
      if (visOnly && G >= 8 && Array.isArray(st.depth_grid) && st.depth_grid.length === G * G) {
        const rawArr = Float32Array.from(st.depth_grid);
        const posVals = [];
        for (let i = 0; i < rawArr.length; i++) {
          if (rawArr[i] > 0) posVals.push(rawArr[i]);
        }
        if (posVals.length > 0) {
          posVals.sort((a, b) => a - b);
          maxValidW = posVals[Math.min(posVals.length - 1, Math.floor(posVals.length * 0.98))];
          dgFilled = fillEmptyDepthCells3x3JS(rawArr, G);
        }
      }
      const vpMat = new THREE.Matrix4();
      if (Array.isArray(st.view_proj_matrix) && st.view_proj_matrix.length === 16) {
        vpMat.fromArray(st.view_proj_matrix);
      }
      let layerZUpMap = null;
      if (st.layer_zup_to_clip && typeof st.layer_zup_to_clip === "object") {
        layerZUpMap = {};
        Object.keys(st.layer_zup_to_clip).forEach((lid) => {
          const arr = st.layer_zup_to_clip[lid];
          if (Array.isArray(arr) && arr.length === 16) {
            layerZUpMap[lid] = new THREE.Matrix4().fromArray(arr);
          }
        });
      }
      return {
        op: st.op === "sub" ? "sub" : "add",
        poly,
        bMinX,
        bMinY,
        bMaxX,
        bMaxY,
        vpMat,
        layerZUpMap,
        visibleOnly: visOnly,
        dg: dgFilled,
        G,
        maxValidW,
        tolM: Number(st.depth_tolerance_m) || 0.85,
      };
    });
  }

  function prepareNativePolyEvalList(polyList2D) {
    if (!Array.isArray(polyList2D) || polyList2D.length === 0) return [];
    const out = [];
    for (let pi = 0; pi < polyList2D.length; pi++) {
      const poly = polyList2D[pi];
      if (!Array.isArray(poly) || poly.length < 3) continue;
      let bMinX = 1e9, bMinY = 1e9, bMaxX = -1e9, bMaxY = -1e9;
      for (let i = 0; i < poly.length; i++) {
        const px = poly[i][0], py = poly[i][1];
        if (px < bMinX) bMinX = px;
        if (px > bMaxX) bMaxX = px;
        if (py < bMinY) bMinY = py;
        if (py > bMaxY) bMaxY = py;
      }
      out.push({ poly, bMinX, bMinY, bMaxX, bMaxY });
    }
    return out;
  }

  function evaluateTrianglesMaskOnMesh(m, posAttr, indexArrayOrAttr, triCount, preparedStrokes, preparedPolys, invPivot, tc) {
    const selFlags = new Uint8Array(triCount);
    const isTypedArr = ArrayBuffer.isView(indexArrayOrAttr);
    const getIdx = indexArrayOrAttr
      ? isTypedArr
        ? (k) => indexArrayOrAttr[k]
        : (k) => indexArrayOrAttr.getX(k)
      : (k) => k;

    if (preparedStrokes.length > 0) {
      const mvp = new THREE.Matrix4();
      const layerId = m.userData?._alignLayerScanId || null;
      const curZUp = m.userData?._alignZUpGroup || null;
      const invCurZUp = layerId && curZUp ? curZUp.matrixWorld.clone().invert() : null;
      for (let si = 0; si < preparedStrokes.length; si++) {
        const st = preparedStrokes[si];
        const isSub = st.op === "sub";
        if (layerId && st.layerZUpMap) {
          const lMat = st.layerZUpMap[layerId];
          if (!lMat || !invCurZUp) continue;
          mvp.multiplyMatrices(lMat, invCurZUp).multiply(m.matrixWorld);
        } else {
          mvp.multiplyMatrices(st.vpMat, m.matrixWorld);
        }
        const e = mvp.elements;

        for (let t = 0; t < triCount; t++) {
          if (isSub && !selFlags[t]) continue;
          if (!isSub && selFlags[t]) continue;

          const i0 = getIdx(t * 3);
          const i1 = getIdx(t * 3 + 1);
          const i2 = getIdx(t * 3 + 2);

          const x0 = posAttr.getX(i0), y0 = posAttr.getY(i0), z0 = posAttr.getZ(i0);
          const cw0 = e[3] * x0 + e[7] * y0 + e[11] * z0 + e[15];
          if (cw0 <= 0.05) continue;

          const x1 = posAttr.getX(i1), y1 = posAttr.getY(i1), z1 = posAttr.getZ(i1);
          const cw1 = e[3] * x1 + e[7] * y1 + e[11] * z1 + e[15];
          if (cw1 <= 0.05) continue;

          const x2 = posAttr.getX(i2), y2 = posAttr.getY(i2), z2 = posAttr.getZ(i2);
          const cw2 = e[3] * x2 + e[7] * y2 + e[11] * z2 + e[15];
          if (cw2 <= 0.05) continue;

          const xc = (x0 + x1 + x2) / 3.0, yc = (y0 + y1 + y2) / 3.0, zc = (z0 + z1 + z2) / 3.0;
          const cwc = (cw0 + cw1 + cw2) / 3.0;

          const nx0 = (e[0] * x0 + e[4] * y0 + e[8] * z0 + e[12]) / cw0;
          const ny0 = (e[1] * x0 + e[5] * y0 + e[9] * z0 + e[13]) / cw0;
          const nx1 = (e[0] * x1 + e[4] * y1 + e[8] * z1 + e[12]) / cw1;
          const ny1 = (e[1] * x1 + e[5] * y1 + e[9] * z1 + e[13]) / cw1;
          const nx2 = (e[0] * x2 + e[4] * y2 + e[8] * z2 + e[12]) / cw2;
          const ny2 = (e[1] * x2 + e[5] * y2 + e[9] * z2 + e[13]) / cw2;
          const nxc = (e[0] * xc + e[4] * yc + e[8] * zc + e[12]) / cwc;
          const nyc = (e[1] * xc + e[5] * yc + e[9] * zc + e[13]) / cwc;

          if (
            Math.max(nx0, nx1, nx2, nxc) < st.bMinX ||
            Math.min(nx0, nx1, nx2, nxc) > st.bMaxX ||
            Math.max(ny0, ny1, ny2, nyc) < st.bMinY ||
            Math.min(ny0, ny1, ny2, nyc) > st.bMaxY
          ) {
            continue;
          }

          let hit = pointInPoly2D(nxc, nyc, st.poly);
          if (!hit) {
            let vIn = 0;
            if (pointInPoly2D(nx0, ny0, st.poly)) vIn++;
            if (pointInPoly2D(nx1, ny1, st.poly)) vIn++;
            if (vIn < 2 && pointInPoly2D(nx2, ny2, st.poly)) vIn++;
            hit = vIn >= 2;
          }
          if (!hit) continue;

          if (st.visibleOnly && st.dg) {
            const gx = Math.max(0, Math.min(st.G - 1, Math.floor((nxc * 0.5 + 0.5) * st.G)));
            const gy = Math.max(0, Math.min(st.G - 1, Math.floor((nyc * 0.5 + 0.5) * st.G)));
            const cellW = st.dg[gy * st.G + gx];
            const effFrontW = cellW > 0 ? cellW : st.maxValidW;
            const tol = Math.max(st.tolM, 0.03 * effFrontW);
            const triNearW = Math.min(cwc, cw0, cw1, cw2);
            if (triNearW > effFrontW + tol) continue;
          }

          selFlags[t] = isSub ? 0 : 1;
        }
      }
    }

    if (preparedPolys.length > 0 && invPivot) {
      const meshToPivotLocal = new THREE.Matrix4().multiplyMatrices(invPivot, m.matrixWorld);
      const me = meshToPivotLocal.elements;
      for (let t = 0; t < triCount; t++) {
        if (selFlags[t]) continue;
        const i0 = getIdx(t * 3);
        const i1 = getIdx(t * 3 + 1);
        const i2 = getIdx(t * 3 + 2);

        const xc = (posAttr.getX(i0) + posAttr.getX(i1) + posAttr.getX(i2)) / 3.0;
        const yc = (posAttr.getY(i0) + posAttr.getY(i1) + posAttr.getY(i2)) / 3.0;
        const zc = (posAttr.getZ(i0) + posAttr.getZ(i1) + posAttr.getZ(i2)) / 3.0;

        const natX = me[0] * xc + me[4] * yc + me[8] * zc + me[12] + tc[0];
        const natY = me[1] * xc + me[5] * yc + me[9] * zc + me[13] + tc[1];

        for (let pi = 0; pi < preparedPolys.length; pi++) {
          const pp = preparedPolys[pi];
          if (natX < pp.bMinX || natX > pp.bMaxX || natY < pp.bMinY || natY > pp.bMaxY) continue;
          if (pointInPoly2D(natX, natY, pp.poly)) {
            selFlags[t] = 1;
            break;
          }
        }
      }
    }

    return selFlags;
  }

  function isActiveStudioTilesetEcef() {
    const tc = studioThree?.tilesCenter;
    return Array.isArray(tc) && tc.length === 3 && Math.hypot(tc[0], tc[1], tc[2]) > 4e6;
  }

  function planPolygonToTopDownFrustumStroke(pts) {
    if (!studioThree || !Array.isArray(pts) || pts.length < 3) return null;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!p) continue;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minZ)) return null;
    const cx = 0.5 * (minX + maxX);
    const cz = 0.5 * (minZ + maxZ);
    const halfSpan = Math.max(5.0, 0.65 * Math.max(maxX - minX, maxZ - minZ) + 4.0);
    const orthoCam = new THREE.OrthographicCamera(-halfSpan, halfSpan, halfSpan, -halfSpan, 0.1, 20000);
    orthoCam.position.set(cx, 5000, cz);
    orthoCam.up.set(0, 0, -1);
    orthoCam.lookAt(cx, 0, cz);
    orthoCam.updateProjectionMatrix();
    orthoCam.updateMatrixWorld(true);
    studioThree.modelPivot.updateMatrixWorld(true);
    const viewProjMat = new THREE.Matrix4().multiplyMatrices(orthoCam.projectionMatrix, orthoCam.matrixWorldInverse);
    const ndcPoly = pts.map((p) => {
      const v = new THREE.Vector4(p.x, 0, p.z, 1.0).applyMatrix4(viewProjMat);
      const invW = Math.abs(v.w) > 1e-9 ? 1.0 / v.w : 1.0;
      return [Math.round(v.x * invW * 100000) / 100000, Math.round(v.y * invW * 100000) / 100000];
    });
    const tilesCenter = studioThree.tilesCenter ? studioThree.tilesCenter.slice() : [0, 0, 0];
    const upMat = studioThree.tileUpMatrix ? studioThree.tileUpMatrix.clone() : new THREE.Matrix4();
    const pivotMat = studioThree.modelPivot.matrixWorld.clone();
    return {
      op: "add",
      ndc_polygon: ndcPoly,
      tiles_center: tilesCenter,
      up_matrix: Array.from(upMat.elements),
      pivot_matrix: Array.from(pivotMat.elements),
      view_proj_matrix: Array.from(viewProjMat.elements),
      visible_only: false,
      depth_grid_size: 0,
      depth_grid: [],
      depth_tolerance_m: 0.85,
    };
  }

  function rebuildLassoHighlight3D() {
    clearLassoHighlight3D();
    if (!studioThree || !studioThree.overlayGroup) return 0;

    const isDelete = (STATE.cropMode || "delete_inside") === "delete_inside";
    const visibleOnlyNow = getEffectiveLassoVisibleOnly(isDelete ? "delete_inside" : "keep_inside");
    const meshes = collectVisibleStudioScanMeshes();

    let preparedStrokes = [];
    if (Array.isArray(STATE.lassoStrokes) && STATE.lassoStrokes.length > 0) {
      STATE.lassoStrokes.forEach((st) => {
        st.visible_only = visibleOnlyNow;
      });
      preparedStrokes = prepareStrokeEvalList(STATE.lassoStrokes, visibleOnlyNow);
    }

    const allWorldPolys = [];
    if (Array.isArray(STATE.pendingCropPolygons)) {
      for (let i = 0; i < STATE.pendingCropPolygons.length; i++) {
        if (Array.isArray(STATE.pendingCropPolygons[i]) && STATE.pendingCropPolygons[i].length >= 3) {
          allWorldPolys.push(STATE.pendingCropPolygons[i]);
        }
      }
    }
    if (Array.isArray(STATE.cropPolygonPoints) && STATE.cropPolygonPoints.length >= 3) {
      allWorldPolys.push(STATE.cropPolygonPoints);
    }

    drawAllCropPolygons3D(isDelete);

    const isMulti = Boolean(STATE.multiAlign?.active);
    let preparedPolys = [];
    const preparedPolysByLayer = {};
    const invZUpByLayer = {};

    if (isMulti && allWorldPolys.length > 0) {
      (STATE.multiAlign.layers || []).forEach((layer) => {
        if (!layer || !layer.visible || !layer.zUpGroup) return;
        const invZUp = layer.zUpGroup.matrixWorld.clone().invert();
        invZUpByLayer[layer.scan_id] = invZUp;
        const layerPolys2D = allWorldPolys.map((pts) =>
          pts.map((p) => {
            const loc = p.clone().applyMatrix4(invZUp);
            return [loc.x, loc.y];
          })
        );
        preparedPolysByLayer[layer.scan_id] = prepareNativePolyEvalList(layerPolys2D);
      });
    } else if (allWorldPolys.length > 0 && isActiveStudioTilesetEcef()) {
      const orthoStrokes = allWorldPolys.map((pts) => planPolygonToTopDownFrustumStroke(pts)).filter(Boolean);
      if (orthoStrokes.length > 0) {
        preparedStrokes = preparedStrokes.concat(prepareStrokeEvalList(orthoStrokes, false));
      }
    } else {
      const nativePolyList2D = allWorldPolys.map((pts) =>
        pts.map((p) => {
          const n = studioWorldToTilesetNative(p);
          return [n[0], n[1]];
        })
      );
      preparedPolys = prepareNativePolyEvalList(nativePolyList2D);
    }

    if (preparedStrokes.length === 0 && allWorldPolys.length === 0) {
      return 0;
    }
    if (meshes.length === 0) return 0;

    const highlightedPositions = [];
    let sumX = 0, sumY = 0, sumZ = 0;
    let selectedCount = 0;
    const maxPreviewTris = 180000;
    const invPivot = studioThree.modelPivot.matrixWorld.clone().invert();
    const tc = studioThree.tilesCenter || [0, 0, 0];

    for (let mi = 0; mi < meshes.length; mi++) {
      const m = meshes[mi];
      const mw = m.matrixWorld.elements;
      const posAttr = m.geometry.attributes.position;
      const idxAttr = m.geometry.index;
      const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(posAttr.count / 3);
      if (triCount === 0) continue;

      const lid = m.userData?._alignLayerScanId || null;
      const meshPolys = isMulti && lid ? preparedPolysByLayer[lid] || [] : preparedPolys;
      const meshInv = isMulti && lid ? invZUpByLayer[lid] || null : invPivot;
      const meshTc = isMulti && lid ? [0, 0, 0] : tc;

      const selFlags = evaluateTrianglesMaskOnMesh(
        m,
        posAttr,
        idxAttr,
        triCount,
        preparedStrokes,
        meshPolys,
        meshInv,
        meshTc
      );

      for (let t = 0; t < triCount; t++) {
        if (!selFlags[t]) continue;
        selectedCount++;
        const i0 = idxAttr ? idxAttr.getX(t * 3) : t * 3;
        const i1 = idxAttr ? idxAttr.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = idxAttr ? idxAttr.getX(t * 3 + 2) : t * 3 + 2;

        const x0 = posAttr.getX(i0), y0 = posAttr.getY(i0), z0 = posAttr.getZ(i0);
        const wx0 = mw[0] * x0 + mw[4] * y0 + mw[8] * z0 + mw[12];
        const wy0 = mw[1] * x0 + mw[5] * y0 + mw[9] * z0 + mw[13];
        const wz0 = mw[2] * x0 + mw[6] * y0 + mw[10] * z0 + mw[14];

        const x1 = posAttr.getX(i1), y1 = posAttr.getY(i1), z1 = posAttr.getZ(i1);
        const wx1 = mw[0] * x1 + mw[4] * y1 + mw[8] * z1 + mw[12];
        const wy1 = mw[1] * x1 + mw[5] * y1 + mw[9] * z1 + mw[13];
        const wz1 = mw[2] * x1 + mw[6] * y1 + mw[10] * z1 + mw[14];

        const x2 = posAttr.getX(i2), y2 = posAttr.getY(i2), z2 = posAttr.getZ(i2);
        const wx2 = mw[0] * x2 + mw[4] * y2 + mw[8] * z2 + mw[12];
        const wy2 = mw[1] * x2 + mw[5] * y2 + mw[9] * z2 + mw[13];
        const wz2 = mw[2] * x2 + mw[6] * y2 + mw[10] * z2 + mw[14];

        sumX += (wx0 + wx1 + wx2) / 3.0;
        sumY += (wy0 + wy1 + wy2) / 3.0;
        sumZ += (wz0 + wz1 + wz2) / 3.0;

        if (highlightedPositions.length < maxPreviewTris * 9) {
          highlightedPositions.push(wx0, wy0, wz0, wx1, wy1, wz1, wx2, wy2, wz2);
        }
      }
    }

    STATE.lassoSelectedTriCount = selectedCount;
    const lblTris = document.getElementById("lblLassoSelectedTris");
    if (lblTris) {
      lblTris.textContent = selectedCount > 0 ? `${selectedCount.toLocaleString()} tris` : "0 tris";
    }

    if (highlightedPositions.length >= 9) {
      const hlGeom = new THREE.BufferGeometry();
      hlGeom.setAttribute("position", new THREE.Float32BufferAttribute(highlightedPositions, 3));
      const hlMat = new THREE.MeshBasicMaterial({
        color: isDelete ? 0xff2b2b : 0x10b981,
        transparent: true,
        opacity: 0.48,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      });
      const hlMesh = new THREE.Mesh(hlGeom, hlMat);
      hlMesh.renderOrder = 996;
      hlMesh.userData.isLassoHighlight = true;
      studioThree.overlayGroup.add(hlMesh);

      if (preparedStrokes.length > 0 && selectedCount > 0) {
        const centroid = new THREE.Vector3(sumX / selectedCount, sumY / selectedCount, sumZ / selectedCount);
        add2DBadge(
          centroid,
          isDelete
            ? `🗑️ Marked for Deletion: <b>${selectedCount.toLocaleString()} triangles</b>`
            : `✂️ Marked to Keep: <b>${selectedCount.toLocaleString()} triangles</b>`,
          isDelete ? "#ef4444" : "#10b981",
          { isLassoHighlight: true }
        );
      }
    }

    if (studioThree.renderer && studioThree.scene && studioThree.camera) {
      studioThree.renderer.render(studioThree.scene, studioThree.camera);
    }
    return selectedCount;
  }

  function renderSingleCropPolyOutline3D(pts, isDelete, labelPrefix, highlightFirstPin) {
    if (!studioThree || !pts || pts.length < 1) return;
    const colorHex = isDelete ? 0xef4444 : 0x10b981;
    const borderCss = isDelete ? "#ef4444" : "#10b981";
    const addCropObj = (m) => {
      m.userData.isAreaVisual = true;
      studioThree.overlayGroup.add(m);
    };
    const maxPins = 12;
    const pinStep = Math.max(1, Math.floor(pts.length / maxPins));
    pts.forEach((p, idx) => {
      if (idx === 0 || idx % pinStep === 0 || pts.length <= maxPins) {
        add3DPinMarker(p, highlightFirstPin && idx === 0 ? 0xff3b30 : colorHex, studioThree.overlayGroup, addCropObj);
      }
    });
    if (pts.length >= 2) {
      const loopPts = pts.length >= 3 ? [...pts, pts[0]] : pts;
      const lineGeom = new THREE.BufferGeometry().setFromPoints(loopPts);
      const lineMesh = new THREE.Line(
        lineGeom,
        new THREE.LineBasicMaterial({ color: colorHex, depthTest: false, linewidth: 2 })
      );
      lineMesh.renderOrder = 1000;
      addCropObj(lineMesh);
    }
    if (pts.length >= 3 && labelPrefix) {
      let area2 = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        area2 += a.x * b.z - b.x * a.z;
      }
      const areaM2 = Math.abs(area2) * 0.5;
      const centroid = pts.reduce((acc, p) => acc.add(p.clone()), new THREE.Vector3()).divideScalar(pts.length);
      add2DBadge(
        centroid,
        `${labelPrefix}: <b>${areaM2.toFixed(1)} m²</b> (${pts.length} pts)`,
        borderCss,
        { isArea: true }
      );
    }
  }

  function drawAllCropPolygons3D(isDelete = true) {
    if (!studioThree) return;
    clearAreaVisualsOnly();
    const lockedList = Array.isArray(STATE.pendingCropPolygons) ? STATE.pendingCropPolygons : [];
    for (let i = 0; i < lockedList.length; i++) {
      const pList = lockedList[i];
      if (Array.isArray(pList) && pList.length >= 3) {
        renderSingleCropPolyOutline3D(
          pList,
          isDelete,
          isDelete ? `🗑️ Polygon #${i + 1}` : `✂️ Keep Zone #${i + 1}`,
          false
        );
      }
    }
    if (
      (STATE.activeTool === "crop" || STATE.activeTool === "crop_delete") &&
      STATE.lassoInputMethod === "polygon" &&
      Array.isArray(STATE.measurePoints) &&
      STATE.measurePoints.length >= 1
    ) {
      renderSingleCropPolyOutline3D(
        STATE.measurePoints,
        isDelete,
        STATE.measurePoints.length >= 3
          ? isDelete
            ? `🗑️ New Polygon (click V1 / Enter)`
            : `✂️ New Keep Zone (click V1 / Enter)`
          : "",
        true
      );
    }
  }

  function drawLassoSelection3D(pts, isDelete = true) {
    drawAllCropPolygons3D(isDelete);
  }

  // =========================================================================
  // STAGED SCAN ADJUSTMENTS & REVERSIBLE LIVE 3D TRIANGLE PREVIEW
  // =========================================================================
  function getStagedEditsScopeKey(scanObj = null) {
    if (STATE.multiAlign?.active) return "__multi_align__";
    const sc = scanObj || STATE.activeScan || {};
    return sc.scan_id || STATE.activeScanId || "";
  }

  function resetStagedEditsForScan(scanObj = null) {
    const sc = scanObj || STATE.activeScan || {};
    const sid = getStagedEditsScopeKey(sc);
    const curSite =
      (STATE.activeProjectGroup && STATE.activeProjectGroup !== "__all__" ? STATE.activeProjectGroup : "") ||
      sc.project_group ||
      "Unassigned Site";
    const todayStr = new Date().toISOString().slice(0, 10);
    const baseName = STATE.multiAlign?.active
      ? `${curSite}_Merged_${todayStr}`
      : `${String(sc.name || sid || "Scan").trim()}`;
    STATE.stagedEdits = {
      scanId: sid,
      rev: 0,
      deletions: [],
      cropKeep: null,
      compressionPreset: null,
      crsConfig: null,
      newScanName: baseName,
    };
    syncStagedEditsDockBadge();
  }

  function ensureStagedEditsForActiveScan() {
    const sid = getStagedEditsScopeKey();
    if (!STATE.stagedEdits || STATE.stagedEdits.scanId !== sid) {
      resetStagedEditsForScan(STATE.activeScan);
    }
    return STATE.stagedEdits;
  }

  function countStagedAdjustments() {
    const sid = getStagedEditsScopeKey();
    if (!STATE.stagedEdits || STATE.stagedEdits.scanId !== sid) return 0;
    const st = STATE.stagedEdits;
    let cnt = 0;
    if (STATE.multiAlign?.active && Array.isArray(STATE.multiAlign.layers) && STATE.multiAlign.layers.length >= 2) {
      cnt++;
    }
    if (Array.isArray(st.deletions) && st.deletions.length > 0) cnt++;
    if (!STATE.multiAlign?.active && st.cropKeep) cnt++;
    if (st.compressionPreset && st.compressionPreset !== "none") cnt++;
    if (st.crsConfig) cnt++;
    return cnt;
  }

  function hasStagedMeshEditsForActiveScan() {
    const sid = getStagedEditsScopeKey();
    if (!STATE.stagedEdits || STATE.stagedEdits.scanId !== sid) return false;
    return (
      (Array.isArray(STATE.stagedEdits.deletions) && STATE.stagedEdits.deletions.length > 0) ||
      Boolean(!STATE.multiAlign?.active && STATE.stagedEdits.cropKeep)
    );
  }

  function syncStagedEditsDockBadge() {
    const cnt = countStagedAdjustments();
    const badge = document.getElementById("lblStagedEditsBadge");
    const mobBadge = document.getElementById("lblMobileUmbrellaStagedBadge");
    const btn = document.getElementById("btnDockGenerateScan");
    if (badge) {
      badge.textContent = String(cnt);
      badge.style.display = cnt > 0 ? "inline-block" : "none";
    }
    if (mobBadge) {
      mobBadge.textContent = String(cnt);
      mobBadge.style.display = cnt > 0 ? "inline-block" : "none";
    }
    if (btn) {
      btn.classList.toggle("has-staged", cnt > 0);
    }
  }

  function restoreOriginalStudioMeshIndices() {
    if (!studioThree) return;
    const restoreUnder = (root) => {
      if (!root) return;
      root.traverse((m) => {
        if (m && m.isMesh && m.geometry && m.userData && m.userData._origIndexSaved) {
          if (m.userData._origHadIndex) {
            m.geometry.setIndex(new THREE.BufferAttribute(m.userData._origIndexArray.slice(), 1));
          } else {
            m.geometry.setIndex(null);
          }
          if (typeof m.userData._origVisible === "boolean") {
            m.visible = m.userData._origVisible;
          }
          if ("boundsTree" in m.geometry) m.geometry.boundsTree = null;
          m.geometry.computeBoundingBox();
          m.geometry.computeBoundingSphere();
          m.userData._appliedStagedRev = 0;
        }
      });
    };
    restoreUnder(studioThree.modelPivot);
    restoreUnder(studioThree.multiAlignGroup);
    studioThree._laserSpatialIndex = null;
    if (typeof scheduleScanGoogleMapCoverageUpdate === "function") {
      scheduleScanGoogleMapCoverageUpdate(studioThree, STATE.activeScan, 35);
    }
    if (studioThree.renderer && studioThree.scene && studioThree.camera) {
      studioThree.renderer.render(studioThree.scene, studioThree.camera);
    }
  }

  function applyStagedEditsToStudioMeshes(forceRecompute = true) {
    if (!studioThree) return 0;
    const st = ensureStagedEditsForActiveScan();
    if (!hasStagedMeshEditsForActiveScan()) {
      restoreOriginalStudioMeshIndices();
      return 0;
    }

    const isMulti = Boolean(STATE.multiAlign?.active && studioThree.multiAlignGroup && studioThree.multiAlignGroup.visible);
    const allDelStrokes = [];
    const allDelPolys = [];
    const delPolysByLayer = {};
    for (let bi = 0; bi < st.deletions.length; bi++) {
      const b = st.deletions[bi];
      if (Array.isArray(b.frustum_strokes)) {
        for (let i = 0; i < b.frustum_strokes.length; i++) allDelStrokes.push(b.frustum_strokes[i]);
      }
      if (isMulti && b.layer_centered_polygons && typeof b.layer_centered_polygons === "object") {
        Object.keys(b.layer_centered_polygons).forEach((lid) => {
          const arr = b.layer_centered_polygons[lid];
          if (Array.isArray(arr) && arr.length > 0) {
            if (!delPolysByLayer[lid]) delPolysByLayer[lid] = [];
            for (let i = 0; i < arr.length; i++) delPolysByLayer[lid].push(arr[i]);
          }
        });
      } else if (Array.isArray(b.native_polygons)) {
        for (let i = 0; i < b.native_polygons.length; i++) allDelPolys.push(b.native_polygons[i]);
      }
    }
    const prepDelStrokes = prepareStrokeEvalList(allDelStrokes, null);
    const prepDelPolys = prepareNativePolyEvalList(allDelPolys);
    const prepDelPolysByLayer = {};
    Object.keys(delPolysByLayer).forEach((lid) => {
      prepDelPolysByLayer[lid] = prepareNativePolyEvalList(delPolysByLayer[lid]);
    });

    const hasKeep = Boolean(!isMulti && st.cropKeep);
    const prepKeepStrokes = hasKeep ? prepareStrokeEvalList(st.cropKeep.frustum_strokes || [], null) : [];
    const prepKeepPolys = hasKeep ? prepareNativePolyEvalList(st.cropKeep.native_polygons || []) : [];

    let totalHiddenTris = 0;
    const applyOnMesh = (m, meshDelPolys, meshInv, meshTc) => {
      if (!m || !m.isMesh || m.userData?.isAlignBoxHelper || !m.geometry?.attributes?.position) return;
      if (!forceRecompute && m.userData._appliedStagedRev === st.rev) return;

      const posAttr = m.geometry.attributes.position;
      if (!m.userData._origIndexSaved) {
        m.userData._origVisible = m.visible;
        if (m.geometry.index && m.geometry.index.array) {
          m.userData._origIndexArray = m.geometry.index.array.slice();
          m.userData._origHadIndex = true;
        } else {
          const vCount = posAttr.count;
          const seq = vCount > 65535 ? new Uint32Array(vCount) : new Uint16Array(vCount);
          for (let i = 0; i < vCount; i++) seq[i] = i;
          m.userData._origIndexArray = seq;
          m.userData._origHadIndex = false;
        }
        m.userData._origIndexSaved = true;
      }

      const origIdx = m.userData._origIndexArray;
      const triCount = Math.floor(origIdx.length / 3);
      if (triCount === 0) return;

      const delFlags =
        prepDelStrokes.length > 0 || meshDelPolys.length > 0
          ? evaluateTrianglesMaskOnMesh(m, posAttr, origIdx, triCount, prepDelStrokes, meshDelPolys, meshInv, meshTc)
          : null;
      const keepFlags =
        hasKeep && (prepKeepStrokes.length > 0 || prepKeepPolys.length > 0)
          ? evaluateTrianglesMaskOnMesh(m, posAttr, origIdx, triCount, prepKeepStrokes, prepKeepPolys, meshInv, meshTc)
          : null;

      let keptTris = 0;
      for (let t = 0; t < triCount; t++) {
        if (delFlags && delFlags[t]) continue;
        if (keepFlags && !keepFlags[t]) continue;
        keptTris++;
      }
      totalHiddenTris += triCount - keptTris;

      const OutArrType = origIdx instanceof Uint32Array ? Uint32Array : Uint16Array;
      const filteredIdx = new OutArrType(keptTris * 3);
      let wPtr = 0;
      for (let t = 0; t < triCount; t++) {
        if (delFlags && delFlags[t]) continue;
        if (keepFlags && !keepFlags[t]) continue;
        filteredIdx[wPtr++] = origIdx[t * 3];
        filteredIdx[wPtr++] = origIdx[t * 3 + 1];
        filteredIdx[wPtr++] = origIdx[t * 3 + 2];
      }
      m.geometry.setIndex(new THREE.BufferAttribute(filteredIdx, 1));
      m.visible = keptTris > 0 ? (m.userData._origVisible !== false) : false;
      if ("boundsTree" in m.geometry) m.geometry.boundsTree = null;
      m.geometry.computeBoundingBox();
      m.geometry.computeBoundingSphere();
      m.userData._appliedStagedRev = st.rev;
    };

    if (isMulti) {
      studioThree.multiAlignGroup.updateMatrixWorld(true);
      (STATE.multiAlign.layers || []).forEach((layer) => {
        if (!layer || !layer.zUpGroup) return;
        const invZUp = layer.zUpGroup.matrixWorld.clone().invert();
        const lPolys = prepDelPolysByLayer[layer.scan_id] || [];
        layer.zUpGroup.traverse((m) => {
          if (m && m.isMesh && !m.userData?.isAlignBoxHelper) {
            m.userData._alignLayerScanId = layer.scan_id;
            m.userData._alignZUpGroup = layer.zUpGroup;
            applyOnMesh(m, lPolys, invZUp, [0, 0, 0]);
          }
        });
      });
    } else if (studioThree.modelPivot) {
      studioThree.modelPivot.updateMatrixWorld(true);
      const invPivot = studioThree.modelPivot.matrixWorld.clone().invert();
      const tc = studioThree.tilesCenter || [0, 0, 0];
      studioThree.modelPivot.traverse((m) => {
        if (m && m.isMesh) {
          m.userData._alignLayerScanId = null;
          m.userData._alignZUpGroup = null;
          applyOnMesh(m, prepDelPolys, invPivot, tc);
        }
      });
    }

    if (typeof scheduleScanGoogleMapCoverageUpdate === "function") {
      scheduleScanGoogleMapCoverageUpdate(studioThree, STATE.activeScan, 35);
    }
    if (studioThree.renderer && studioThree.scene && studioThree.camera) {
      studioThree.renderer.render(studioThree.scene, studioThree.camera);
    }
    return totalHiddenTris;
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

  let _laserMoveRafPending = false;
  let _lastLaserPointerEvt = null;

  function handleStudioLaserMove(e) {
    _lastLaserPointerEvt = { clientX: e.clientX, clientY: e.clientY };
    if (_laserMoveRafPending) return;
    _laserMoveRafPending = true;
    requestAnimationFrame(() => {
      _laserMoveRafPending = false;
      if (STATE.activeView !== "studio" || STATE.activeTool !== "laser" || !_lastLaserPointerEvt) return;
      const hit = pickStudio3DHit(_lastLaserPointerEvt.clientX, _lastLaserPointerEvt.clientY);
      if (!hit) {
        STATE._lastLaserSpan = null;
        clearTempDistanceVisuals();
        return;
      }
      const span = computeLaserSpanAtPoint(hit.rawPoint, hit.normal);
      STATE._lastLaserSpan = span;
      renderLaserVisuals(span, null);
      const twd = localToTwd97(hit.rawPoint);
      const lbl = document.getElementById("lblLastPickedCoord");
      if (lbl) {
        const wTxt =
          span && span.width
            ? `W: ${span.width.toFixed(2)}m${span.orthoLength ? ` × L: ${span.orthoLength.toFixed(2)}m` : ""} | `
            : "";
        lbl.textContent = `LASER -> ${wTxt}${formatScanCoordReadout(twd, STATE.activeScan)}`;
      }
    });
  }

  function handleStudioCoordinateMove(e) {
    const hit = pickStudio3DHit(e.clientX, e.clientY);
    if (!hit) {
      clearTempDistanceVisuals();
      return;
    }
    const pt = hit.point;
    const twd = localToTwd97(pt);
    renderCoordinateVisuals(pt, null);
    const lbl = document.getElementById("lblLastPickedCoord");
    if (lbl) {
      lbl.textContent = formatScanCoordReadout(twd, STATE.activeScan);
    }
  }

  function handleStudioAngleMove(e) {
    const hoverPt = pickStudio3DPoint(e.clientX, e.clientY);
    if (!hoverPt) {
      if (STATE.measurePoints.length === 0) {
        clearTempDistanceVisuals();
      } else {
        renderAngleVisuals(null, null);
      }
      return;
    }
    const twd = localToTwd97(hoverPt);
    const lbl = document.getElementById("lblLastPickedCoord");
    if (lbl) {
      lbl.textContent = formatScanCoordReadout(twd, STATE.activeScan);
    }
    renderAngleVisuals(hoverPt, null);
  }

  function renderClosedAreaPolygon(lockedPts, opts = {}) {
    if (!studioThree || !Array.isArray(lockedPts) || lockedPts.length < 3) return;
    if (studioThree.polyPreviewGroup) {
      while (studioThree.polyPreviewGroup.children.length > 0) {
        studioThree.polyPreviewGroup.remove(studioThree.polyPreviewGroup.children[0]);
      }
    }
    if (!opts || !opts.preserveExistingAreas) {
      clearAreaVisualsOnly();
    }
    const addAreaObj = (m) => {
      m.userData.isAreaVisual = true;
      studioThree.overlayGroup.add(m);
    };
    lockedPts.forEach((p, idx) => {
      add3DPinMarker(p, idx === 0 ? 0xff3b30 : 0x0284c7, studioThree.overlayGroup, addAreaObj);
    });
    const loopPts = [...lockedPts, lockedPts[0]];
    const lineGeom = new THREE.BufferGeometry().setFromPoints(loopPts);
    const lineMesh = new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color: 0x0284c7, depthTest: false }));
    addAreaObj(lineMesh);

    let area2 = 0;
    let perim = 0;
    for (let i = 0; i < lockedPts.length; i++) {
      const a = lockedPts[i];
      const b = lockedPts[(i + 1) % lockedPts.length];
      area2 += a.x * b.z - b.x * a.z;
      perim += a.distanceTo(b);
    }
    const areaM2 = Math.abs(area2) * 0.5;
    const areaPing = areaM2 * 0.3025;
    const centroid = lockedPts.reduce((acc, p) => acc.add(p.clone()), new THREE.Vector3()).divideScalar(lockedPts.length);
    add2DBadge(
      centroid,
      `Area: <b>${areaM2.toFixed(2)} m²</b> (${areaPing.toFixed(2)} 坪) · Perim: ${perim.toFixed(2)}m`,
      "#cbd5e1",
      { isArea: true }
    );
  }
  window.renderClosedAreaPolygon = renderClosedAreaPolygon;

  let _lastCanvasVertexClick = null;

  document.getElementById("studioCanvasContainer")?.addEventListener("dblclick", (e) => {
    if (STATE.activeView !== "studio" || STATE.fpMode?.active) return;
    if (e.target && e.target.closest && e.target.closest("#studioSidePanel, .gs-comment-pin-popover, .gs-scan-comment-pin, #studioMobileToolHud")) {
      return;
    }
    if (STATE.movingVertex) return;
    if (typeof findNearestEditableVertexAtScreenXY !== "function" || typeof startStudioVertexMove !== "function") return;
    if (
      _lastCanvasVertexClick &&
      performance.now() - _lastCanvasVertexClick.ts <= 500 &&
      _lastCanvasVertexClick.vDesc
    ) {
      if (Array.isArray(STATE.measurePoints) && STATE.measurePoints.length > _lastCanvasVertexClick.preMeasureLen) {
        STATE.measurePoints.length = _lastCanvasVertexClick.preMeasureLen;
      }
      if (
        Array.isArray(STATE.completedMeasurements) &&
        STATE.completedMeasurements.length > _lastCanvasVertexClick.preCompletedLen
      ) {
        STATE.completedMeasurements.length = _lastCanvasVertexClick.preCompletedLen;
      }
      if (typeof rebuildAllCompletedMeasurements3D === "function") {
        rebuildAllCompletedMeasurements3D();
      }
      const targetV = _lastCanvasVertexClick.vDesc;
      _lastCanvasVertexClick = null;
      startStudioVertexMove(targetV);
      return;
    }
    const nearV = findNearestEditableVertexAtScreenXY(e.clientX, e.clientY, window.innerWidth <= 768 ? 34 : 28);
    if (nearV) {
      startStudioVertexMove(nearV);
    }
  });

  function handleStudioCanvasClick(e) {
    const nowMs = performance.now();

    // 1. If currently moving an existing vertex, single click commits the new vertex position
    if (STATE.movingVertex && typeof commitStudioVertexMove === "function") {
      if (nowMs - (STATE.movingVertex.startedAt || 0) < 260) {
        return;
      }
      const moveHit = pickStudio3DHit(e.clientX, e.clientY);
      commitStudioVertexMove(moveHit ? moveHit.point : null);
      _lastCanvasVertexClick = null;
      return;
    }

    // 2. Rapid double-click detection on any existing measurement, area, coordinate, or angle vertex to pick & move it
    if (typeof findNearestEditableVertexAtScreenXY === "function" && typeof startStudioVertexMove === "function") {
      if (
        _lastCanvasVertexClick &&
        nowMs - _lastCanvasVertexClick.ts <= 380 &&
        Math.hypot(e.clientX - _lastCanvasVertexClick.clientX, e.clientY - _lastCanvasVertexClick.clientY) <= 22 &&
        _lastCanvasVertexClick.vDesc
      ) {
        if (Array.isArray(STATE.measurePoints) && STATE.measurePoints.length > _lastCanvasVertexClick.preMeasureLen) {
          STATE.measurePoints.length = _lastCanvasVertexClick.preMeasureLen;
        }
        if (
          Array.isArray(STATE.completedMeasurements) &&
          STATE.completedMeasurements.length > _lastCanvasVertexClick.preCompletedLen
        ) {
          STATE.completedMeasurements.length = _lastCanvasVertexClick.preCompletedLen;
        }
        if (typeof rebuildAllCompletedMeasurements3D === "function") {
          rebuildAllCompletedMeasurements3D();
        }
        const targetV = _lastCanvasVertexClick.vDesc;
        _lastCanvasVertexClick = null;
        startStudioVertexMove(targetV);
        return;
      }
      const nearEditable = findNearestEditableVertexAtScreenXY(
        e.clientX,
        e.clientY,
        window.innerWidth <= 768 ? 30 : 26
      );
      if (nearEditable) {
        _lastCanvasVertexClick = {
          ts: nowMs,
          clientX: e.clientX,
          clientY: e.clientY,
          preMeasureLen: Array.isArray(STATE.measurePoints) ? STATE.measurePoints.length : 0,
          preCompletedLen: Array.isArray(STATE.completedMeasurements) ? STATE.completedMeasurements.length : 0,
          vDesc: nearEditable,
        };
      } else {
        _lastCanvasVertexClick = null;
      }
    }

    if (
      STATE.activeTool === "photos" &&
      typeof pickCameraTrajectoryMarkerAtScreenXY === "function" &&
      typeof selectCalibratedCameraFrom3D === "function"
    ) {
      const clickedCam = pickCameraTrajectoryMarkerAtScreenXY(e.clientX, e.clientY);
      if (clickedCam) {
        selectCalibratedCameraFrom3D(clickedCam);
        return;
      }
    }

    const hit = pickStudio3DHit(e.clientX, e.clientY);
    if (!hit) return;
    const pt = hit.point;
    const twd = localToTwd97(pt);

    const lbl = document.getElementById("lblLastPickedCoord");
    if (lbl) {
      lbl.textContent = formatScanCoordReadout(twd, STATE.activeScan);
    }

    const tool = STATE.activeTool;

    const isNearStartVertex = (clickPt, startPt) => {
      if (!startPt || !studioThree || !studioThree.camera) return false;
      const cam = studioThree.camera;
      const domEl = studioThree.renderer?.domElement;
      const w = Math.max(1, domEl?.clientWidth || 1);
      const h = Math.max(1, domEl?.clientHeight || 1);
      const pClick = clickPt.clone().project(cam);
      const pStart = startPt.clone().project(cam);
      const pxThresh = window.innerWidth <= 768 ? 28 : 18;
      if (Math.abs(pStart.z) <= 1.0 && Math.abs(pClick.z) <= 1.0) {
        const sxClick = (pClick.x * 0.5 + 0.5) * w;
        const syClick = (-pClick.y * 0.5 + 0.5) * h;
        const sxStart = (pStart.x * 0.5 + 0.5) * w;
        const syStart = (-pStart.y * 0.5 + 0.5) * h;
        if (Math.hypot(sxClick - sxStart, syClick - syStart) <= pxThresh) return true;
      }
      const fovRad = THREE.MathUtils.degToRad(cam.fov);
      const dist = cam.position.distanceTo(startPt);
      const worldPerPixel = (2 * Math.tan(fovRad / 2) * dist) / h;
      const snapRadius = Math.max(0.08, pxThresh * worldPerPixel);
      return clickPt.distanceTo(startPt) < snapRadius;
    };

    if (tool === "categorize" && STATE.categorizeEditMode) {
      const mode = STATE.categorizeEditMode;
      const originTwd = localToTwd97({ x: 0, y: 0, z: 0 });
      if (mode === "add_tree") {
        submitCategorizeManualEdit("manual_add", "trees", null, {
          trunk_local: [Number(pt.x.toFixed(3)), Number(pt.y.toFixed(3)), Number(pt.z.toFixed(3))],
          trunk_twd97: [Number(twd.e.toFixed(3)), Number(twd.n.toFixed(3)), Number(twd.h.toFixed(3))],
          auto_measure: true,
          dbh_cm: 28.0,
          height_m: 6.5,
          crown_diameter_m: 4.2,
        });
        return;
      }
      if (mode === "add_wall") {
        if (!Array.isArray(STATE.categorizeEditPoints)) STATE.categorizeEditPoints = [];
        STATE.categorizeEditPoints.push({ pt: pt.clone(), twd });
        add3DPinMarker(pt, 0xf43f5e, studioThree.overlayGroup, (m) => {
          m.userData.isTempDistance = true;
          studioThree.overlayGroup.add(m);
        });
        if (STATE.categorizeEditPoints.length >= 2) {
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
        } else {
          showToast(tr("🔴 牆面起點已標記，請點擊牆面終點", "🔴 Point 1/2 placed — click wall end point"));
          if (STATE.lastCategorizeResult) renderCategorizePanelContent(STATE.lastCategorizeResult);
        }
        syncStudioMobileToolHud();
        return;
      }
      if (mode === "add_road") {
        if (!Array.isArray(STATE.categorizeEditPoints)) STATE.categorizeEditPoints = [];
        if (
          STATE.categorizeEditPoints.length >= 3 &&
          isNearStartVertex(pt, STATE.categorizeEditPoints[0].pt)
        ) {
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
        STATE.categorizeEditPoints.push({ pt: pt.clone(), twd });
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
        showToast(
          pts.length >= 3
            ? `🟠 道路頂點 #${pts.length} 已標記 — 點擊紅色起點 V1 或按 Enter 完成新增道路`
            : `🟠 道路頂點 #${pts.length} 已標記 — 請再標記至少 ${3 - pts.length} 個頂點`
        );
        if (STATE.lastCategorizeResult) renderCategorizePanelContent(STATE.lastCategorizeResult);
        syncStudioMobileToolHud();
        return;
      }
      if (mode === "remove_click") {
        const res = STATE.lastCategorizeResult;
        if (!res) return;
        let bestId = null;
        let bestCat = null;
        let bestDist = 5.5;
        (res.trees || []).forEach((t) => {
          const v = twd97PointToStudioVec3(t.trunk_twd97, t.trunk_local, originTwd);
          const d = Math.hypot(v.x - pt.x, v.z - pt.z);
          if (d < bestDist) {
            bestDist = d;
            bestId = t.id;
            bestCat = "trees";
          }
        });
        (res.walls || []).forEach((wl) => {
          const bTwd = wl.base_polyline_twd97 || [];
          const bLoc = wl.base_polyline_local || [];
          const nPts = Math.max(bTwd.length, bLoc.length);
          for (let i = 0; i < nPts - 1; i++) {
            const a = twd97PointToStudioVec3(bTwd[i], bLoc[i], originTwd);
            const b = twd97PointToStudioVec3(bTwd[i + 1], bLoc[i + 1], originTwd);
            const abx = b.x - a.x;
            const abz = b.z - a.z;
            const len2 = abx * abx + abz * abz;
            const tProj = len2 > 1e-6 ? Math.max(0, Math.min(1, ((pt.x - a.x) * abx + (pt.z - a.z) * abz) / len2)) : 0;
            const px = a.x + tProj * abx;
            const pz = a.z + tProj * abz;
            const d = Math.hypot(pt.x - px, pt.z - pz);
            if (d < bestDist) {
              bestDist = d;
              bestId = wl.id;
              bestCat = "walls";
            }
          }
        });
        const checkPolyHit = (polyObj, catName) => {
          const bTwd = polyObj.boundary_twd97 || [];
          const bLoc = polyObj.boundary_local || [];
          const nVerts = Math.max(bTwd.length, bLoc.length);
          if (nVerts >= 3) {
            const ringXZ = [];
            for (let i = 0; i < nVerts; i++) {
              const v = twd97PointToStudioVec3(bTwd[i], bLoc[i], originTwd);
              ringXZ.push([v.x, v.z]);
            }
            if (pointInPoly2D(pt.x, pt.z, ringXZ)) {
              const holesTwd = polyObj.holes_twd97 || [];
              const holesLoc = polyObj.holes_local || [];
              let inHole = false;
              const nH = Math.max(holesTwd.length, holesLoc.length);
              for (let hi = 0; hi < nH; hi++) {
                const ht = holesTwd[hi] || [];
                const hl = holesLoc[hi] || [];
                const nhv = Math.max(ht.length, hl.length);
                if (nhv >= 3) {
                  const hXZ = [];
                  for (let k = 0; k < nhv; k++) {
                    const hv = twd97PointToStudioVec3(ht[k], hl[k], originTwd);
                    hXZ.push([hv.x, hv.z]);
                  }
                  if (pointInPoly2D(pt.x, pt.z, hXZ)) {
                    inHole = true;
                    break;
                  }
                }
              }
              if (!inHole && 1.8 < bestDist) {
                bestDist = 1.8;
                bestId = polyObj.id;
                bestCat = catName;
              }
            }
            for (let i = 0; i < ringXZ.length; i++) {
              const a = ringXZ[i];
              const b = ringXZ[(i + 1) % ringXZ.length];
              const abx = b[0] - a[0];
              const abz = b[1] - a[1];
              const len2 = abx * abx + abz * abz;
              const tProj = len2 > 1e-6 ? Math.max(0, Math.min(1, ((pt.x - a[0]) * abx + (pt.z - a[1]) * abz) / len2)) : 0;
              const d = Math.hypot(pt.x - (a[0] + tProj * abx), pt.z - (a[1] + tProj * abz));
              if (d < bestDist) {
                bestDist = d;
                bestId = polyObj.id;
                bestCat = catName;
              }
            }
          }
          const vc = twd97PointToStudioVec3(polyObj.center_twd97, polyObj.center_local, originTwd);
          const dc = Math.hypot(vc.x - pt.x, vc.z - pt.z);
          if (dc < bestDist) {
            bestDist = dc;
            bestId = polyObj.id;
            bestCat = catName;
          }
        };
        (res.roads || []).forEach((r) => checkPolyHit(r, "roads"));
        (res.water_bodies || []).forEach((w) => checkPolyHit(w, "water_bodies"));
        if (bestId && bestCat) {
          submitCategorizeManualEdit("manual_remove", bestCat, bestId);
        } else {
          showToast("附近 5.5m 內未找到可刪除的分類項目，或請直接點擊表格中的 🗑️ 按鈕", "warn");
        }
        return;
      }
    }

    if (tool === "coordinates") {
      clearTempDistanceVisuals();
      const coordIndex = STATE.completedMeasurements.filter((m) => m.type === "coordinates").length + 1;
      const meas = {
        id: `coord_${Date.now()}`,
        type: "coordinates",
        label: `P${coordIndex}`,
        pt: pt.clone(),
        twd,
      };
      STATE.completedMeasurements.push(meas);
      renderCoordinateVisuals(pt, meas);
      return;
    }

    if (tool === "laser") {
      const span = computeLaserSpanAtPoint(hit.rawPoint, hit.normal);
      if (span) {
        clearTempDistanceVisuals();
        const meas = Object.assign(
          {
            id: `laser_${Date.now()}`,
            type: "laser",
          },
          span
        );
        STATE.completedMeasurements.push(meas);
        renderLaserVisuals(null, meas);
        if (span.width) {
          const kindLabel =
            span.kind === "room"
              ? "室內 寬"
              : span.kind === "pool"
              ? "區域 寬"
              : span.kind === "road"
              ? "雷射路寬"
              : "雷射淨寬";
          const lenSuffix = span.orthoLength ? ` × 長 ${span.orthoLength.toFixed(2)} m` : "";
          showToast(`${kindLabel} ${span.width.toFixed(2)} m${lenSuffix} 已釘選`);
        }
      }
      return;
    }

    if (tool === "photos") {
      if (_lastCanvasVertexClick && _lastCanvasVertexClick.vDesc) {
        return;
      }
      if (typeof clearPhotoTargetVisuals3D === "function") {
        clearPhotoTargetVisuals3D();
      }
      add3DPinMarker(pt, 0x0284c7, studioThree.overlayGroup, (m) => {
        m.userData.isPhotoTargetPin = true;
        studioThree.overlayGroup.add(m);
      });
      openRtkPhotoInspector(pt, true);
      return;
    }

    if (tool === "comments") {
      if (_lastCanvasVertexClick && _lastCanvasVertexClick.vDesc) {
        return;
      }
      STATE.pendingCommentDraftPt = pt.clone();
      if (typeof renderCommentPins3D === "function") renderCommentPins3D();
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
          type: "distance",
          p1: p1.clone(),
          p2: p2.clone(),
          dist: p1.distanceTo(p2),
        };
        STATE.completedMeasurements.push(meas);
        renderDistanceVisuals(null, meas);
        STATE.measurePoints = [];
      }
      syncStudioMobileToolHud();
      return;
    }

    if (tool === "angle") {
      STATE.measurePoints.push(pt.clone());
      if (STATE.measurePoints.length < 3) {
        renderAngleVisuals(null, null);
      } else {
        const [p1, p2, p3] = STATE.measurePoints;
        clearTempDistanceVisuals();
        const v1 = p1.clone().sub(p2).normalize();
        const v2 = p3.clone().sub(p2).normalize();
        const deg = THREE.MathUtils.radToDeg(Math.acos(Math.max(-1, Math.min(1, v1.dot(v2)))));
        const meas = {
          id: `angle_${Date.now()}`,
          type: "angle",
          p1: p1.clone(),
          p2: p2.clone(),
          p3: p3.clone(),
          angleDeg: deg,
        };
        STATE.completedMeasurements.push(meas);
        renderAngleVisuals(null, meas);
        STATE.measurePoints = [];
      }
      syncStudioMobileToolHud();
      return;
    }

    if (tool === "area") {
      if (STATE.measurePoints.length >= 3 && isNearStartVertex(pt, STATE.measurePoints[0])) {
        const lockedPts = STATE.measurePoints.map((p) => p.clone());
        STATE.measurePoints = [];
        STATE.completedMeasurements.push({
          id: `area_${Date.now()}`,
          type: "area",
          points: lockedPts.map((p) => p.clone()),
        });
        if (typeof rebuildAllCompletedMeasurements3D === "function") {
          rebuildAllCompletedMeasurements3D();
        } else {
          renderClosedAreaPolygon(lockedPts, { preserveExistingAreas: true });
        }
        showToast(`Area polygon closed (${lockedPts.length} vertices)`);
        syncStudioMobileToolHud();
        return;
      }

      STATE.polygonLocked = false;
      STATE.measurePoints.push(pt.clone());
      const pts = STATE.measurePoints.slice();
      clearAreaVisualsOnly();
      (STATE.completedMeasurements || [])
        .filter((m) => m && m.type === "area" && Array.isArray(m.points) && m.points.length >= 3)
        .forEach((m) => renderClosedAreaPolygon(m.points, { preserveExistingAreas: true }));
      const addAreaObj = (m) => {
        m.userData.isAreaVisual = true;
        studioThree.overlayGroup.add(m);
      };
      pts.forEach((p, idx) => {
        add3DPinMarker(p, idx === 0 ? 0xff3b30 : 0x0284c7, studioThree.overlayGroup, addAreaObj);
      });
      if (pts.length >= 2) {
        // Draw only the open polyline while placing vertices; do not close loop or show Area badge until polygon is closed!
        const lineGeom = new THREE.BufferGeometry().setFromPoints(pts);
        const lineMesh = new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color: 0x0284c7, depthTest: false }));
        addAreaObj(lineMesh);
      }
      if (pts.length >= 3) {
        showToast(`Area: ${pts.length} vertices placed — click red start point V1 (or press Enter) to close polygon & compute area`);
      }
      syncStudioMobileToolHud();
      return;
    }

    if (tool === "crop" || tool === "crop_delete") {
      if (STATE.lassoInputMethod !== "polygon") {
        // In Freehand Drag Lasso mode, single-clicking without dragging only updates picked coordinates
        // without accidentally overwriting or placing stray polygon vertices.
        return;
      }
      const isDelete = tool === "crop_delete";
      if (!Array.isArray(STATE.pendingCropPolygons)) STATE.pendingCropPolygons = [];
      if (STATE.measurePoints.length >= 3 && isNearStartVertex(pt, STATE.measurePoints[0])) {
        if (studioThree && studioThree.polyPreviewGroup) {
          while (studioThree.polyPreviewGroup.children.length > 0) {
            studioThree.polyPreviewGroup.remove(studioThree.polyPreviewGroup.children[0]);
          }
        }
        const lockedPts = STATE.measurePoints.map((p) => p.clone());
        STATE.pendingCropPolygons.push(lockedPts);
        STATE.cropPolygonPoints = [];
        STATE.measurePoints = [];
        STATE.polygonLocked = true;
        STATE.cropMode = isDelete ? "delete_inside" : "keep_inside";
        const selTris = rebuildLassoHighlight3D();
        const totalMarked =
          STATE.pendingCropPolygons.length +
          (Array.isArray(STATE.lassoStrokes) ? STATE.lassoStrokes.filter((s) => s.op !== "sub").length : 0);
        showToast(
          isDelete
            ? `Polygon #${STATE.pendingCropPolygons.length} marked (${totalMarked} region${totalMarked === 1 ? "" : "s"} · ${selTris.toLocaleString()} tris) — mark more or press Delete`
            : `Keep Polygon #${STATE.pendingCropPolygons.length} marked (${selTris.toLocaleString()} tris)`
        );
        if (isDelete) {
          openLassoDeleteInspector({ armLasso: true });
        } else {
          openLassoKeepInspector({ armLasso: true });
        }
        syncStudioMobileToolHud();
        return;
      }
      STATE.polygonLocked = false;
      STATE.measurePoints.push(pt.clone());
      const pts = STATE.measurePoints.slice();
      drawAllCropPolygons3D(isDelete);
      if (pts.length >= 3) {
        STATE.cropPolygonPoints = pts.map((p) => p.clone());
        rebuildLassoHighlight3D();
        if (isDelete) {
          openLassoDeleteInspector({ armLasso: true });
        } else {
          openLassoKeepInspector({ armLasso: true });
        }
        showToast(
          `${isDelete ? "Lasso Delete" : "Crop"} Polygon #${STATE.pendingCropPolygons.length + 1}: ${pts.length} vertices — click red V1 (or Enter) to lock`
        );
      } else {
        showToast(
          `${isDelete ? "Lasso Delete" : "Crop"} Polygon #${STATE.pendingCropPolygons.length + 1}: Point ${pts.length} placed — click ${3 - pts.length} more`
        );
      }
      syncStudioMobileToolHud();
      return;
    }

    if (tool === "volume") {
      if (STATE.polygonLocked && STATE.measurePoints.length === 0) {
        if (_lastCanvasVertexClick && _lastCanvasVertexClick.vDesc) {
          return;
        }
        showToast("Cut/Fill boundary is locked — click 'Redraw Polygon' in the Cut/Fill panel to draw a new zone");
        return;
      }
      // Clicking near start point V1 closes and locks the polygon AND then computes volume
      if (STATE.measurePoints.length >= 3 && isNearStartVertex(pt, STATE.measurePoints[0])) {
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
        syncStudioMobileToolHud();
        return;
      }

      STATE.polygonLocked = false;
      STATE.measurePoints.push(pt.clone());
      const pts = STATE.measurePoints.slice();
      STATE.cutFillPolygonPoints = pts.map((p) => p.clone());

      // Draw placed vertices & edges in volumeGroup without running volume calculation until polygon is locked
      drawPlacedCutFillPolygon3D(pts, null);

      if (pts.length >= 3) {
        STATE.maskBoundaryPoints = pts.map((p) => p.clone());
        openCutFillVolumeInspector(null);
        showToast(`Cut/Fill: ${pts.length} vertices placed — click red start point V1 (or press Enter / Lock & Compute) to calculate volume`);
      } else {
        openCutFillVolumeInspector(null);
        showToast(`Cut/Fill Point ${pts.length} placed — click ${3 - pts.length} more point${3 - pts.length === 1 ? "" : "s"} to form boundary`);
      }
      syncStudioMobileToolHud();
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
      syncStudioMobileToolHud();
      return;
    }

    if (tool === "section") {
      STATE.measurePoints.push(pt.clone());
      if (STATE.measurePoints.length === 1) {
        add3DPinMarker(STATE.measurePoints[0], 0xff3b30, studioThree.overlayGroup, (m) => {
          m.userData.isSectionTempPin = true;
          studioThree.overlayGroup.add(m);
        });
        showToast(tr("已設定剖面盒起點 P1 — 請點擊第二點 P2 建立剖面範圍", "Section Pt 1 placed — click 2nd point P2 on the 3D scan to create section box"));
      } else if (STATE.measurePoints.length >= 2) {
        const [p1, p2] = STATE.measurePoints;
        STATE.sectionBoxEndpoints = [p1.clone(), p2.clone()];
        STATE.measurePoints = [];
        if (studioThree && studioThree.polyPreviewGroup) {
          while (studioThree.polyPreviewGroup.children.length > 0) {
            studioThree.polyPreviewGroup.remove(studioThree.polyPreviewGroup.children[0]);
          }
        }
        openSectionBoxInspector(p1, p2);
      }
      syncStudioMobileToolHud();
      return;
    }

    if (tool === "contours") {
      if (STATE.measurePoints.length >= 3 && isNearStartVertex(pt, STATE.measurePoints[0])) {
        if (studioThree && studioThree.polyPreviewGroup) {
          while (studioThree.polyPreviewGroup.children.length > 0) {
            studioThree.polyPreviewGroup.remove(studioThree.polyPreviewGroup.children[0]);
          }
        }
        const lockedPts = STATE.measurePoints.map((p) => p.clone());
        STATE.maskBoundaryPoints = lockedPts;
        STATE.polygonLocked = true;
        STATE.measurePoints = [];
        showToast(`Mask boundary locked (${lockedPts.length} vertices) — generating Contours, Civil3D.dxf & A3 PDF`);
        openContoursInspector(lockedPts);
        syncStudioMobileToolHud();
        return;
      }

      STATE.polygonLocked = false;
      STATE.measurePoints.push(pt.clone());
      const pts = STATE.measurePoints.slice();
      add3DPinMarker(pt, pts.length === 1 ? 0xff3b30 : 0x0284c7);

      if (pts.length >= 3) {
        STATE.maskBoundaryPoints = pts.map((p) => p.clone());
        showToast(`Contours Boundary: ${pts.length} vertices placed — click red start point V1 (or press Enter) to lock & generate contours`);
      } else {
        showToast(`Mask Boundary Point ${pts.length} placed — click ${3 - pts.length} more point${3 - pts.length === 1 ? "" : "s"} to form boundary`);
      }
      syncStudioMobileToolHud();
      return;
    }

    if (tool === "gcp_qa" && typeof handleGcpQa3DPick === "function") {
      handleGcpQa3DPick(pt, twd);
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

  const _spatialFallbackOffsets = [
    [0.14, 0],
    [-0.14, 0],
    [0, 0.14],
    [0, -0.14],
    [0.42, 0.42],
    [-0.42, 0.42],
    [0.42, -0.42],
    [-0.42, -0.42],
    [0.95, 0],
    [-0.95, 0],
    [0, 0.95],
    [0, -0.95],
  ];

  function sampleStudioMeshElevationAtLocalXZ(lx, lz, fallbackY = 0, cachedTargets = null, spatialIdx = null) {
    const rayTopY = Math.max(450, (Number(studioThree?.boundingSphere?.radius) || 60) * 3 + 200);
    const rayMaxDist = rayTopY * 2 + 400;
    const idx = spatialIdx || studioThree?._laserSpatialIndex || null;
    if (idx) {
      const gHit = castRayInLaserGrid(idx, lx, rayTopY, lz, 0, -1, 0, 0.05, rayMaxDist, 1.01);
      if (gHit) {
        return { y: gHit.y, hit: true };
      }
      // Fast micro-seam/gap bridging in O(1) spatial grid (never falls back to slow unindexed raycast when idx exists)
      for (let i = 0; i < _spatialFallbackOffsets.length; i++) {
        const off = _spatialFallbackOffsets[i];
        const nHit = castRayInLaserGrid(idx, lx + off[0], rayTopY, lz + off[1], 0, -1, 0, 0.05, rayMaxDist, 1.01);
        if (nHit) {
          return { y: nHit.y, hit: true };
        }
      }
      return { y: fallbackY, hit: false };
    }
    const targets = cachedTargets || getStudioRaycastMeshes();
    if (!targets.length) return { y: fallbackY, hit: false };
    _downRayOrigin.set(lx, rayTopY, lz);
    _downRaycaster.set(_downRayOrigin, _downRayDir);
    const hits = _downRaycaster.intersectObjects(targets, true);
    if (hits && hits.length > 0) {
      return { y: hits[0].point.y, hit: true };
    }
    return { y: fallbackY, hit: false };
  }

  async function getLaserSpatialIndexAsync(onProgress = null, cancelToken = null) {
    if (!studioThree) return null;
    const alignSig = STATE.multiAlign?.active
      ? (STATE.multiAlign.layers || [])
          .map((l) => `${l.scan_id}:${l.visible ? 1 : 0}:${l.tx}:${l.ty}:${l.tz}:${l.rx_deg}:${l.ry_deg}:${l.rz_deg}`)
          .join("|")
      : STATE.activeScanId || "";
    const stagedRev = STATE.stagedEdits?.rev || 0;
    const baseSig = `${alignSig}#r=${stagedRev}`;

    const meshes = [];
    if (STATE.multiAlign?.active && studioThree.multiAlignGroup && studioThree.multiAlignGroup.visible) {
      studioThree.multiAlignGroup.updateMatrixWorld(true);
      studioThree.multiAlignGroup.traverse((c) => {
        if (
          c.isMesh &&
          isMeshVisibleUnderRoot(c, studioThree.multiAlignGroup) &&
          !c.userData?.isAlignBoxHelper &&
          c.geometry?.attributes?.position
        ) {
          meshes.push(c);
        }
      });
    } else if (studioThree.modelPivot && studioThree.modelPivot.visible) {
      studioThree.modelPivot.updateMatrixWorld(true);
      studioThree.modelPivot.traverse((c) => {
        if (c.isMesh && isMeshVisibleUnderRoot(c, studioThree.modelPivot) && c.geometry?.attributes?.position) {
          meshes.push(c);
        }
      });
    }
    if (meshes.length === 0 && studioThree.fallbackGroup && studioThree.fallbackGroup.visible) {
      studioThree.fallbackGroup.updateMatrixWorld(true);
      studioThree.fallbackGroup.traverse((c) => {
        if (c.isMesh && c.visible && c.geometry?.attributes?.position) {
          meshes.push(c);
        }
      });
    }
    if (meshes.length === 0) return null;

    let totalTris = 0;
    for (let i = 0; i < meshes.length; i++) {
      const g = meshes[i].geometry;
      const idx = g.index;
      totalTris += idx ? Math.floor(idx.count / 3) : Math.floor(g.attributes.position.count / 3);
    }
    if (totalTris === 0) return null;

    const cacheKey = `${baseSig}#m=${meshes.length}#t=${totalTris}`;
    if (studioThree._laserSpatialIndex && studioThree._laserSpatialIndex.key === cacheKey) {
      return studioThree._laserSpatialIndex;
    }

    const isCancelled = () =>
      Boolean(
        cancelToken &&
          ((typeof cancelToken.isCancelled === "function" && cancelToken.isCancelled()) ||
            (Number.isFinite(cancelToken.seq) && cancelToken.seq !== STATE._volumeCalcSeq))
      );

    let frameStart = performance.now();
    const targetAsyncTris = 450000;
    const triStride = totalTris > targetAsyncTris ? Math.ceil(totalTris / targetAsyncTris) : 1;
    const maxIndexed = Math.ceil(totalTris / triStride) + 16;
    const triVerts = new Float32Array(maxIndexed * 9);
    const triAbsNy = new Float32Array(maxIndexed);

    let minX = 1e30, maxX = -1e30, minZ = 1e30, maxZ = -1e30;
    let wCount = 0;
    let processedTris = 0;

    for (let mi = 0; mi < meshes.length; mi++) {
      const m = meshes[mi];
      const e = m.matrixWorld.elements;
      const pos = m.geometry.attributes.position;
      const idxAttr = m.geometry.index;
      const nTris = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(pos.count / 3);

      for (let t = 0; t < nTris; t += triStride) {
        if ((t & 2047) === 0 && performance.now() - frameStart > 8.0) {
          if (isCancelled()) return null;
          if (typeof onProgress === "function") {
            const pct = Math.min(28, Math.max(2, Math.round((processedTris / Math.max(1, totalTris)) * 28)));
            onProgress(pct, tr("建立 3D 網格空間索引...", "Building 3D spatial grid index..."));
          }
          await new Promise((r) => requestAnimationFrame(r));
          frameStart = performance.now();
          if (isCancelled()) return null;
        }
        processedTris += triStride;

        const i0 = idxAttr ? idxAttr.getX(t * 3) : t * 3;
        const i1 = idxAttr ? idxAttr.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = idxAttr ? idxAttr.getX(t * 3 + 2) : t * 3 + 2;

        const lx0 = pos.getX(i0), ly0 = pos.getY(i0), lz0 = pos.getZ(i0);
        const lx1 = pos.getX(i1), ly1 = pos.getY(i1), lz1 = pos.getZ(i1);
        const lx2 = pos.getX(i2), ly2 = pos.getY(i2), lz2 = pos.getZ(i2);

        const x0 = e[0] * lx0 + e[4] * ly0 + e[8] * lz0 + e[12];
        const y0 = e[1] * lx0 + e[5] * ly0 + e[9] * lz0 + e[13];
        const z0 = e[2] * lx0 + e[6] * ly0 + e[10] * lz0 + e[14];

        const x1 = e[0] * lx1 + e[4] * ly1 + e[8] * lz1 + e[12];
        const y1 = e[1] * lx1 + e[5] * ly1 + e[9] * lz1 + e[13];
        const z1 = e[2] * lx1 + e[6] * ly1 + e[10] * lz1 + e[14];

        const x2 = e[0] * lx2 + e[4] * ly2 + e[8] * lz2 + e[12];
        const y2 = e[1] * lx2 + e[5] * ly2 + e[9] * lz2 + e[13];
        const z2 = e[2] * lx2 + e[6] * ly2 + e[10] * lz2 + e[14];

        const ax = x1 - x0, ay = y1 - y0, az = z1 - z0;
        const bx = x2 - x0, by = y2 - y0, bz = z2 - z0;
        const nx = ay * bz - az * by;
        const ny = az * bx - ax * bz;
        const nz = ax * by - ay * bx;
        const nLen = Math.hypot(nx, ny, nz);
        if (nLen < 1e-7) continue;

        const base = wCount * 9;
        triVerts[base] = x0;
        triVerts[base + 1] = y0;
        triVerts[base + 2] = z0;
        triVerts[base + 3] = x1;
        triVerts[base + 4] = y1;
        triVerts[base + 5] = z1;
        triVerts[base + 6] = x2;
        triVerts[base + 7] = y2;
        triVerts[base + 8] = z2;
        triAbsNy[wCount] = Math.abs(ny) / nLen;
        wCount++;

        const tMinX = Math.min(x0, x1, x2);
        const tMaxX = Math.max(x0, x1, x2);
        const tMinZ = Math.min(z0, z1, z2);
        const tMaxZ = Math.max(z0, z1, z2);
        if (tMinX < minX) minX = tMinX;
        if (tMaxX > maxX) maxX = tMaxX;
        if (tMinZ < minZ) minZ = tMinZ;
        if (tMaxZ > maxZ) maxZ = tMaxZ;
      }
    }

    if (wCount === 0 || isCancelled()) return null;
    minX -= 0.5;
    minZ -= 0.5;
    maxX += 0.5;
    maxZ += 0.5;

    const spanMax = Math.max(10, maxX - minX, maxZ - minZ);
    const cellSize = Math.max(0.85, spanMax / 180);
    const invCell = 1.0 / cellSize;
    const gridW = Math.max(4, Math.ceil((maxX - minX) * invCell) + 1);
    const gridH = Math.max(4, Math.ceil((maxZ - minZ) * invCell) + 1);
    const numCells = gridW * gridH;

    const cellCounts = new Int32Array(numCells);
    for (let t = 0; t < wCount; t++) {
      if ((t & 4095) === 0 && performance.now() - frameStart > 8.0) {
        if (isCancelled()) return null;
        await new Promise((r) => requestAnimationFrame(r));
        frameStart = performance.now();
        if (isCancelled()) return null;
      }
      const b = t * 9;
      const gx0 = Math.max(0, Math.min(gridW - 1, Math.floor((Math.min(triVerts[b], triVerts[b + 3], triVerts[b + 6]) - minX) * invCell)));
      const gx1 = Math.max(0, Math.min(gridW - 1, Math.floor((Math.max(triVerts[b], triVerts[b + 3], triVerts[b + 6]) - minX) * invCell)));
      const gz0 = Math.max(0, Math.min(gridH - 1, Math.floor((Math.min(triVerts[b + 2], triVerts[b + 5], triVerts[b + 8]) - minZ) * invCell)));
      const gz1 = Math.max(0, Math.min(gridH - 1, Math.floor((Math.max(triVerts[b + 2], triVerts[b + 5], triVerts[b + 8]) - minZ) * invCell)));
      if ((gx1 - gx0 + 1) * (gz1 - gz0 + 1) > 40000) continue;
      for (let gz = gz0; gz <= gz1; gz++) {
        const row = gz * gridW;
        for (let gx = gx0; gx <= gx1; gx++) {
          cellCounts[row + gx]++;
        }
      }
    }

    const cellOffsets = new Int32Array(numCells + 1);
    for (let c = 0; c < numCells; c++) {
      cellOffsets[c + 1] = cellOffsets[c] + cellCounts[c];
    }
    const cellTris = new Int32Array(cellOffsets[numCells]);
    const writePtr = cellOffsets.slice(0, numCells);

    for (let t = 0; t < wCount; t++) {
      if ((t & 4095) === 0 && performance.now() - frameStart > 8.0) {
        if (isCancelled()) return null;
        await new Promise((r) => requestAnimationFrame(r));
        frameStart = performance.now();
        if (isCancelled()) return null;
      }
      const b = t * 9;
      const gx0 = Math.max(0, Math.min(gridW - 1, Math.floor((Math.min(triVerts[b], triVerts[b + 3], triVerts[b + 6]) - minX) * invCell)));
      const gx1 = Math.max(0, Math.min(gridW - 1, Math.floor((Math.max(triVerts[b], triVerts[b + 3], triVerts[b + 6]) - minX) * invCell)));
      const gz0 = Math.max(0, Math.min(gridH - 1, Math.floor((Math.min(triVerts[b + 2], triVerts[b + 5], triVerts[b + 8]) - minZ) * invCell)));
      const gz1 = Math.max(0, Math.min(gridH - 1, Math.floor((Math.max(triVerts[b + 2], triVerts[b + 5], triVerts[b + 8]) - minZ) * invCell)));
      if ((gx1 - gx0 + 1) * (gz1 - gz0 + 1) > 40000) continue;
      for (let gz = gz0; gz <= gz1; gz++) {
        const row = gz * gridW;
        for (let gx = gx0; gx <= gx1; gx++) {
          cellTris[writePtr[row + gx]++] = t;
        }
      }
    }

    const built = {
      key: cacheKey,
      baseSig,
      builtAt: performance.now(),
      triCount: wCount,
      triVerts,
      triAbsNy,
      minX,
      minZ,
      cellSize,
      invCell,
      gridW,
      gridH,
      cellOffsets,
      cellTris,
      visitStamp: new Int32Array(wCount),
      raySeq: 1,
    };
    studioThree._laserSpatialIndex = built;
    return built;
  }
  window.getLaserSpatialIndexAsync = getLaserSpatialIndexAsync;

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

  function fitBestFitPlaneToPoints(samples) {
    if (!samples || samples.length < 3) {
      const c = samples && samples.length ? samples[0].y || 0 : 0;
      return { a: 0, b: 0, c };
    }
    let sx = 0, sz = 0, sy = 0;
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      sx += samples[i].x;
      sz += samples[i].z;
      sy += samples[i].y;
    }
    const mx = sx / n, mz = sz / n, my = sy / n;
    let sxx = 0, szz = 0, sxz = 0, sxy = 0, szy = 0;
    for (let i = 0; i < n; i++) {
      const dx = samples[i].x - mx;
      const dz = samples[i].z - mz;
      const dy = samples[i].y - my;
      sxx += dx * dx;
      szz += dz * dz;
      sxz += dx * dz;
      sxy += dx * dy;
      szy += dz * dy;
    }
    const det = sxx * szz - sxz * sxz;
    if (Math.abs(det) < 1e-8) {
      return { a: 0, b: 0, c: my };
    }
    const a = (sxy * szz - szy * sxz) / det;
    const b = (szy * sxx - sxy * sxz) / det;
    const c = my - a * mx - b * mz;
    return { a, b, c };
  }

  function buildVolumeReportBlobUrls(volData, opts = {}, perspectiveImgDataUrl = "", nadirImgDataUrl = "") {
    const activeScan = STATE.activeScan || STATE.scans.find((s) => s.scan_id === STATE.activeScanId) || {
      scan_id: STATE.activeScanId || "scan",
      name: STATE.activeScanId || "Active Scan",
      project_group: STATE.activeProjectGroup || "Unassigned Site",
    };
    const boundaryTwd97 = Array.isArray(volData.boundary_twd97) ? volData.boundary_twd97 : [];
    const csvLines = [
      "GatheringScans Civil Engineering & Stockpile Volume Report",
      `Project Group,"${activeScan.project_group || volData.project_group || ""}"`,
      `Scan Name,"${activeScan.name || volData.scan_name || ""}"`,
      `Zone / Stockpile Name,"${volData.stockpile_name || opts.stockpile_name || "Stockpile A"}"`,
      `Base Surface Mode,${volData.base_mode || opts.base_mode || "triangulated_boundary"}`,
      "",
      "Metric,Value,Unit",
      `Fill / Stockpile Volume (+),${Number(volData.fill_volume_m3 || 0).toFixed(2)},m3`,
      `Cut / Excavation Volume (-),${Number(volData.cut_volume_m3 || 0).toFixed(2)},m3`,
      `Net Earthwork Volume,${Number(volData.net_volume_m3 || 0).toFixed(2)},m3`,
      `2D Planar Footprint Area,${Number(volData.planar_area_m2 || 0).toFixed(2)},m2`,
      `2D Planar Footprint Area (Ping),${Number(volData.planar_area_ping || 0).toFixed(2)},ping`,
      `3D Sloped Surface Area,${Number(volData.surface_area_m2 || 0).toFixed(2)},m2`,
      `Boundary Perimeter,${Number(volData.perimeter_m || 0).toFixed(2)},m`,
      `Material Classification,"${volData.material_name || ""}",`,
      `Material Bulk Density,${Number(volData.density_t_m3 || 1.65).toFixed(2)},t/m3`,
      `Estimated Material Mass (Loose),${Number(volData.estimated_tonnage_t || 0).toFixed(2)},t`,
      `Estimated Bank Mass,${Number(volData.bank_tonnage_t || 0).toFixed(2)},t`,
      "",
      "Vertex #,TWD97 Easting E (m),TWD97 Northing N (m),TWVD2001 Elevation H (m)",
      ...boundaryTwd97.map((v) => `V${v.vertex},${v.easting_m},${v.northing_m},${v.twvd2001_h_m}`),
    ];
    if (STATE._lastVolCsvBlobUrl) {
      try {
        URL.revokeObjectURL(STATE._lastVolCsvBlobUrl);
      } catch (_) {}
    }
    if (STATE._lastVolHtmlBlobUrl) {
      try {
        URL.revokeObjectURL(STATE._lastVolHtmlBlobUrl);
      } catch (_) {}
    }
    const csvBlob = new Blob(["\uFEFF" + csvLines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const csvUrl = URL.createObjectURL(csvBlob);
    STATE._lastVolCsvBlobUrl = csvUrl;

    const pImg = perspectiveImgDataUrl || volData._perspectiveImgDataUrl || "";
    const nImg = nadirImgDataUrl || volData._nadirImgDataUrl || "";
    const figuresHtml =
      pImg || nImg
        ? `<div style="display:grid;grid-template-columns:1fr;gap:18px;margin:20px 0;">
            ${
              pImg
                ? `<div style="border:1px solid #cbd5e1;border-radius:10px;overflow:hidden;background:#0f172a;page-break-inside:avoid;">
                     <div style="background:#f1f5f9;color:#0f172a;padding:8px 12px;font-weight:700;font-size:13px;border-bottom:1px solid #cbd5e1;">
                       Figure 1 — ${tr("3D 土方圍束範圍與基準面立體總覽圖 (3D Volume Enclosure & Limiting Plane Overview)", "3D Volume Enclosure & Bottom Limiting Plane Overview")}
                     </div>
                     <img src="${pImg}" alt="3D Volume Enclosure Overview" style="width:100%;display:block;height:auto;" />
                   </div>`
                : ""
            }
            ${
              nImg
                ? `<div style="border:1px solid #cbd5e1;border-radius:10px;overflow:hidden;background:#0f172a;page-break-inside:avoid;">
                     <div style="background:#f1f5f9;color:#0f172a;padding:8px 12px;font-weight:700;font-size:13px;border-bottom:1px solid #cbd5e1;">
                       Figure 2 — ${tr("正射俯視圖、加粗範圍邊界與頂點標註 (Top-Down Nadir View with Point Labels V1..Vn & Thick Boundary)", "Top-Down Nadir View with Point Labels (V1..Vn) & Thick Boundary")}
                     </div>
                     <img src="${nImg}" alt="Top-Down Nadir View with Vertex Labels" style="width:100%;display:block;height:auto;" />
                   </div>`
                : ""
            }
          </div>`
        : "";

    const fillVal = Number(volData.fill_volume_m3 || 0);
    const cutVal = Number(volData.cut_volume_m3 || 0);
    const netVal = Number(volData.net_volume_m3 || 0);
    const tonVal = Number(volData.estimated_tonnage_t || 0);
    const areaVal = Number(volData.planar_area_m2 || 0);
    const pingVal = Number(volData.planar_area_ping || 0);
    const perimVal = Number(volData.perimeter_m || 0);
    const datumVal = Number(volData.datum_elevation_m || 0);
    const densVal = Number(volData.density_t_m3 || 1.65);

    const htmlDoc = `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${tr(
      "土方體積與堆置量測報告",
      "Stockpile Volume Report"
    )} — ${escapeHtml(volData.stockpile_name || opts.stockpile_name || "Stockpile A")}</title><style>body{font-family:sans-serif;max-width:920px;margin:24px auto;padding:0 16px;color:#0f172a}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border:1px solid #cbd5e1;padding:8px 10px;text-align:left;font-size:13px}th{background:#f1f5f9}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}.card{border:1px solid #cbd5e1;border-radius:8px;padding:12px;background:#f8fafc}.val{font-size:20px;font-weight:800;margin-top:4px}@media print{body{margin:0;max-width:100%}.no-print{display:none}}</style></head><body><div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #0f172a;padding-bottom:10px;margin-bottom:14px;"><div><h2 style="margin:0;">${tr(
      "土方體積與物料堆置量測報告",
      "Stockpile & Cut/Fill Volume Report"
    )}</h2><div style="font-size:12.5px;color:#475569;margin-top:4px;">Project: <b>${escapeHtml(
      activeScan.project_group || volData.project_group || ""
    )}</b> | Scan: <b>${escapeHtml(activeScan.name || volData.scan_name || "")}</b> | Zone: <b>${escapeHtml(
      volData.stockpile_name || opts.stockpile_name || "Stockpile A"
    )}</b></div></div><button class="no-print" onclick="window.print()" style="padding:7px 14px;border-radius:6px;border:1px solid #0284c7;background:#0284c7;color:#fff;font-weight:700;cursor:pointer;">🖨️ Print / Save PDF</button></div><div class="grid"><div class="card"><div>Fill Volume (+)</div><div class="val" style="color:#0284c7">+${fillVal.toFixed(
      2
    )} m³</div></div><div class="card"><div>Cut Volume (-)</div><div class="val" style="color:#dc2626">-${cutVal.toFixed(
      2
    )} m³</div></div><div class="card"><div>Net Volume</div><div class="val">${
      netVal >= 0 ? "+" : ""
    }${netVal.toFixed(2)} m³</div></div><div class="card"><div>Estimated Mass</div><div class="val">${tonVal.toFixed(
      2
    )} t</div></div></div><table><tr><th>Footprint Area</th><td>${areaVal.toFixed(
      2
    )} m² (${pingVal.toFixed(2)} 坪)</td><th>Perimeter</th><td>${perimVal.toFixed(
      2
    )} m</td></tr><tr><th>Material</th><td>${escapeHtml(
      volData.material_name || ""
    )} (${densVal.toFixed(2)} t/m³)</td><th>Limiting Base Mode / Datum Z₀</th><td>${escapeHtml(
      String(volData.base_mode || "triangulated_boundary")
    )} (+${datumVal.toFixed(3)} m)</td></tr></table>${figuresHtml}<table><thead><tr><th>Vertex</th><th>TWD97 E (m)</th><th>TWD97 N (m)</th><th>TWVD2001 H (m)</th></tr></thead><tbody>${boundaryTwd97
      .map(
        (v) =>
          `<tr><td><b>V${v.vertex}</b></td><td>${Number(v.easting_m).toFixed(3)}</td><td>${Number(
            v.northing_m
          ).toFixed(3)}</td><td>+${Number(v.twvd2001_h_m).toFixed(3)}</td></tr>`
      )
      .join("")}</tbody></table></body></html>`;
    const htmlBlob = new Blob([htmlDoc], { type: "text/html;charset=utf-8" });
    const htmlUrl = URL.createObjectURL(htmlBlob);
    STATE._lastVolHtmlBlobUrl = htmlUrl;
    return { htmlUrl, csvUrl };
  }
  window.buildVolumeReportBlobUrls = buildVolumeReportBlobUrls;

  function computeClientMeshVolume(ptsLocal, opts = {}) {
    const activeScan = STATE.activeScan || STATE.scans.find((s) => s.scan_id === STATE.activeScanId) || {
      scan_id: STATE.activeScanId || "scan",
      name: STATE.activeScanId || "Active Scan",
      project_group: STATE.activeProjectGroup || "Unassigned Site",
      twd97_e: 0,
      twd97_n: 0,
      twd97_h: 0,
    };
    const originTwd = localToTwd97({ x: 0, y: 0, z: 0 });
    const ce = Number(originTwd.e || 0);
    const cn = Number(originTwd.n || 0);
    const ch = Number(originTwd.h || 0);

    const pts = ptsLocal && ptsLocal.length >= 3 ? ptsLocal : getDefaultPolygonOnStudioMesh();
    const spatialIdx = studioThree?._laserSpatialIndex || null;
    const targets = spatialIdx ? null : getStudioRaycastMeshes();

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
        const sHit = sampleStudioMeshElevationAtLocalXZ(sx, sz, linY, targets, spatialIdx);
        perimSamples.push({ x: sx, y: sHit.hit ? sHit.y : linY, z: sz });
      }
    }

    const perimMeanLocalY =
      perimSamples.reduce((acc, p) => acc + p.y, 0) / Math.max(1, perimSamples.length);
    const minPerimLocalY =
      perimSamples.length > 0 ? Math.min(...perimSamples.map((p) => p.y)) : Math.min(...pts.map((p) => p.y));
    const perimMeanH = ch + perimMeanLocalY;
    const baseMode = opts.base_mode || "triangulated_boundary";
    const datumH = Number.isFinite(opts.datum_elevation_m) ? opts.datum_elevation_m : perimMeanH;
    const datumLocalY = datumH - ch;
    const planeFit = fitBestFitPlaneToPoints(perimSamples.length >= 3 ? perimSamples : pts);

    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minZ = Math.min(...pts.map((p) => p.z));
    const maxZ = Math.max(...pts.map((p) => p.z));
    const spanX = Math.max(0.2, maxX - minX);
    const spanZ = Math.max(0.2, maxZ - minZ);

    const nx = 42;
    const nz = 42;
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
        const sSurf = sampleStudioMeshElevationAtLocalXZ(gx, gz, yPerimBase, targets, spatialIdx);
        if (sSurf.hit) hitCells++;
        const ySurf = sSurf.y;

        let yBase = yPerimBase;
        if (baseMode === "custom_plane") {
          yBase = datumLocalY;
        } else if (baseMode === "lowest_point") {
          yBase = minPerimLocalY;
        } else if (baseMode === "best_fit_plane") {
          yBase = planeFit.a * gx + planeFit.b * gz + planeFit.c;
        } else if (baseMode === "epoch_diff") {
          yBase = yPerimBase - 0.18;
        }

        const deltaY = ySurf - yBase;
        maxDz = Math.max(maxDz, deltaY);
        minDz = Math.min(minDz, deltaY);

        if (deltaY >= 0) fillVol += deltaY * cellArea;
        else cutVol += Math.abs(deltaY) * cellArea;

        surfaceArea += cellArea * 1.04;
        if (heatmapCells.length < 4096) {
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
            step_x: Number(dx.toFixed(4)),
            step_z: Number(dzStep.toFixed(4)),
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

    const resObj = {
      status: "ok",
      scan_id: activeScan.scan_id,
      scan_name: activeScan.name,
      project_group: activeScan.project_group,
      stockpile_name: opts.stockpile_name || "Stockpile A",
      crs_short: "TWD97 (121) + TWVD2001",
      base_mode: baseMode,
      datum_elevation_m: Number(datumH.toFixed(3)),
      datum_local_y: Number(datumLocalY.toFixed(3)),
      min_perim_y: Number(minPerimLocalY.toFixed(3)),
      plane_fit: planeFit,
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
      cell_dx: Number(dx.toFixed(4)),
      cell_dz: Number(dzStep.toFixed(4)),
      heatmap_cells: heatmapCells,
      hit_ratio: insideCells > 0 ? hitCells / insideCells : 0,
      _resolvedPtsLocal: pts,
    };

    const blobs = buildVolumeReportBlobUrls(resObj, opts);
    resObj.report_html_url = blobs.htmlUrl;
    resObj.report_csv_url = blobs.csvUrl;
    return resObj;
  }

  async function computeClientMeshVolumeAsync(
    ptsLocal,
    baseModeOrOpts = "triangulated_boundary",
    densityArg = null,
    customDatumHArg = null,
    onProgress = null,
    cancelToken = null
  ) {
    let opts = {};
    if (baseModeOrOpts && typeof baseModeOrOpts === "object") {
      opts = { ...baseModeOrOpts };
      if (typeof densityArg === "function" && !onProgress) {
        onProgress = densityArg;
        cancelToken = customDatumHArg;
      }
    } else {
      opts = {
        base_mode: typeof baseModeOrOpts === "string" ? baseModeOrOpts : "triangulated_boundary",
        density_t_m3: Number.isFinite(densityArg) ? Number(densityArg) : undefined,
        datum_elevation_m: Number.isFinite(customDatumHArg) ? Number(customDatumHArg) : undefined,
      };
    }

    const isCancelled = () =>
      Boolean(
        cancelToken &&
          ((typeof cancelToken.isCancelled === "function" && cancelToken.isCancelled()) ||
            (Number.isFinite(cancelToken.seq) && cancelToken.seq !== STATE._volumeCalcSeq))
      );

    if (typeof onProgress === "function") {
      onProgress(2, tr("準備 3D 網格空間索引...", "Preparing 3D mesh spatial index..."));
    }

    const spatialIdx = await getLaserSpatialIndexAsync(onProgress, cancelToken);
    if (isCancelled()) return null;

    const targets = spatialIdx ? null : getStudioRaycastMeshes();
    const activeScan = STATE.activeScan || STATE.scans.find((s) => s.scan_id === STATE.activeScanId) || {
      scan_id: STATE.activeScanId || "scan",
      name: STATE.activeScanId || "Active Scan",
      project_group: STATE.activeProjectGroup || "Unassigned Site",
      twd97_e: 0,
      twd97_n: 0,
      twd97_h: 0,
    };
    const originTwd = localToTwd97({ x: 0, y: 0, z: 0 });
    const ce = Number(originTwd.e || 0);
    const cn = Number(originTwd.n || 0);
    const ch = Number(originTwd.h || 0);

    const pts = ptsLocal && ptsLocal.length >= 3 ? ptsLocal : getDefaultPolygonOnStudioMesh();

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

    let frameStart = performance.now();
    const perimSamples = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const segLen = Math.hypot(b.x - a.x, b.z - a.z);
      const nSub = Math.max(2, Math.min(20, Math.ceil(segLen / 0.35)));
      for (let k = 0; k < nSub; k++) {
        if (performance.now() - frameStart > 8.0) {
          if (isCancelled()) return null;
          if (typeof onProgress === "function") {
            const pPct = 28 + Math.round(((i + k / nSub) / Math.max(1, pts.length)) * 12);
            onProgress(pPct, tr("取樣多邊形周界高程...", "Sampling perimeter elevations..."));
          }
          await new Promise((r) => requestAnimationFrame(r));
          frameStart = performance.now();
          if (isCancelled()) return null;
        }
        const t = k / nSub;
        const sx = a.x + t * (b.x - a.x);
        const sz = a.z + t * (b.z - a.z);
        const linY = a.y + t * (b.y - a.y);
        const sHit = sampleStudioMeshElevationAtLocalXZ(sx, sz, linY, targets, spatialIdx);
        perimSamples.push({ x: sx, y: sHit.hit ? sHit.y : linY, z: sz });
      }
    }

    const perimMeanLocalY =
      perimSamples.reduce((acc, p) => acc + p.y, 0) / Math.max(1, perimSamples.length);
    const minPerimLocalY =
      perimSamples.length > 0 ? Math.min(...perimSamples.map((p) => p.y)) : Math.min(...pts.map((p) => p.y));
    const perimMeanH = ch + perimMeanLocalY;
    const baseMode = opts.base_mode || "triangulated_boundary";
    const datumH = Number.isFinite(opts.datum_elevation_m) ? opts.datum_elevation_m : perimMeanH;
    const datumLocalY = datumH - ch;
    const planeFit = fitBestFitPlaneToPoints(perimSamples.length >= 3 ? perimSamples : pts);

    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minZ = Math.min(...pts.map((p) => p.z));
    const maxZ = Math.max(...pts.map((p) => p.z));
    const spanX = Math.max(0.2, maxX - minX);
    const spanZ = Math.max(0.2, maxZ - minZ);

    const nx = 42;
    const nz = 42;
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
    const totalGridCells = nx * nz;
    let doneGridCells = 0;

    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        doneGridCells++;
        if (performance.now() - frameStart > 8.0) {
          if (isCancelled()) return null;
          if (typeof onProgress === "function") {
            const pct = Math.min(96, 40 + Math.round((doneGridCells / Math.max(1, totalGridCells)) * 56));
            onProgress(
              pct,
              tr(
                `正在背景計算土方體積... ${pct}% (可自由旋轉檢視 3D 模型)`,
                `Computing Volume in background... ${pct}%`
              )
            );
          }
          await new Promise((r) => requestAnimationFrame(r));
          frameStart = performance.now();
          if (isCancelled()) return null;
        }

        const gx = minX + (ix + 0.5) * dx;
        const gz = minZ + (iz + 0.5) * dzStep;
        if (!pointInPolyXZ(gx, gz)) continue;
        insideCells++;

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
        const sSurf = sampleStudioMeshElevationAtLocalXZ(gx, gz, yPerimBase, targets, spatialIdx);
        if (sSurf.hit) hitCells++;
        const ySurf = sSurf.y;

        let yBase = yPerimBase;
        if (baseMode === "custom_plane") {
          yBase = datumLocalY;
        } else if (baseMode === "lowest_point") {
          yBase = minPerimLocalY;
        } else if (baseMode === "best_fit_plane") {
          yBase = planeFit.a * gx + planeFit.b * gz + planeFit.c;
        } else if (baseMode === "epoch_diff") {
          yBase = yPerimBase - 0.18;
        }

        const deltaY = ySurf - yBase;
        maxDz = Math.max(maxDz, deltaY);
        minDz = Math.min(minDz, deltaY);

        if (deltaY >= 0) fillVol += deltaY * cellArea;
        else cutVol += Math.abs(deltaY) * cellArea;

        surfaceArea += cellArea * 1.04;
        if (heatmapCells.length < 4096) {
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
            step_x: Number(dx.toFixed(4)),
            step_z: Number(dzStep.toFixed(4)),
          });
        }
      }
    }

    if (isCancelled()) return null;

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

    const resObj = {
      status: "ok",
      scan_id: activeScan.scan_id,
      scan_name: activeScan.name,
      project_group: activeScan.project_group,
      stockpile_name: opts.stockpile_name || "Stockpile A",
      crs_short: "TWD97 (121) + TWVD2001",
      base_mode: baseMode,
      datum_elevation_m: Number(datumH.toFixed(3)),
      datum_local_y: Number(datumLocalY.toFixed(3)),
      min_perim_y: Number(minPerimLocalY.toFixed(3)),
      plane_fit: planeFit,
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
      cell_dx: Number(dx.toFixed(4)),
      cell_dz: Number(dzStep.toFixed(4)),
      heatmap_cells: heatmapCells,
      hit_ratio: insideCells > 0 ? hitCells / insideCells : 0,
      _resolvedPtsLocal: pts,
    };

    const blobs = buildVolumeReportBlobUrls(resObj, opts);
    resObj.report_html_url = blobs.htmlUrl;
    resObj.report_csv_url = blobs.csvUrl;
    if (typeof onProgress === "function") {
      onProgress(100, tr("土方計算完成 (100%)", "Volume calculation complete (100%)"));
    }
    return resObj;
  }
  window.computeClientMeshVolumeAsync = computeClientMeshVolumeAsync;

  // Helper to push a 3D volumetric box prism (top face + 4 vertical side faces) into a triangle buffer
  function pushBoxPrismTriangles(arr, x, z, halfX, halfZOrYLow, yLowOrHigh, yHighOpt) {
    const isRect = yHighOpt !== undefined;
    const hx = halfX;
    const hz = isRect ? halfZOrYLow : halfX;
    const yLow = isRect ? yLowOrHigh : halfZOrYLow;
    const yHigh = isRect ? yHighOpt : yLowOrHigh;
    const x0 = x - hx, x1 = x + hx;
    const z0 = z - hz, z1 = z + hz;
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

  // Draw the user's placed Cut/Fill vertices, boundary lines, Bottom Limiting Plane, and real DSM 3D cut/fill columns in studioThree.volumeGroup
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

    // 2. Top Surface Boundary Outline
    const loopPts = pts.length >= 3 ? [...pts, pts[0]] : pts.slice();
    const topLoopGeo = new THREE.BufferGeometry().setFromPoints(loopPts);
    const topLoopLine = new THREE.Line(
      topLoopGeo,
      new THREE.LineBasicMaterial({ color: 0x0084ff, linewidth: 2, depthTest: false })
    );
    topLoopLine.renderOrder = 1000;
    studioThree.volumeGroup.add(topLoopLine);

    if (pts.length < 3) return;

    const originTwd = localToTwd97({ x: 0, y: 0, z: 0 });
    const ch = Number(originTwd.h || 0);
    const minSurfY = Math.min(...pts.map((p) => p.y));
    const maxY = Math.max(...pts.map((p) => p.y));
    const datumLocalY =
      volumeRes && Number.isFinite(volumeRes.datum_local_y)
        ? Number(volumeRes.datum_local_y)
        : volumeRes && Number.isFinite(volumeRes.datum_elevation_m)
        ? Number(volumeRes.datum_elevation_m) - ch
        : minSurfY - 0.1;
    const minPerimY =
      volumeRes && Number.isFinite(volumeRes.min_perim_y) ? Number(volumeRes.min_perim_y) : minSurfY;
    const baseMode = (volumeRes && volumeRes.base_mode) || "triangulated_boundary";
    const planeFit = (volumeRes && volumeRes.plane_fit) || fitBestFitPlaneToPoints(pts);
    const centroid = pts.reduce((acc, p) => acc.add(p.clone()), new THREE.Vector3()).divideScalar(pts.length);

    const evalLimitYAtVertex = (v) => {
      if (baseMode === "custom_plane") return datumLocalY;
      if (baseMode === "lowest_point") return minPerimY;
      if (baseMode === "best_fit_plane") return planeFit.a * v.x + planeFit.b * v.z + planeFit.c;
      if (baseMode === "epoch_diff") return v.y - 0.18;
      return v.y;
    };

    // 3. Render real 3D Cut/Fill volumetric prisms + Translucent Bottom Limiting Plane Surface & Wireframe Grid
    const cells = volumeRes && Array.isArray(volumeRes.heatmap_cells) ? volumeRes.heatmap_cells : [];
    const cellStep = Number(volumeRes?.cell_step_m) || 0.5;
    let minBaseY = minPerimY;
    let minCellLowY = Math.min(minBaseY, minSurfY);
    cells.forEach((c) => {
      const yb = Number(c.ly_base ?? minPerimY);
      const ys = Number(c.ly_surf ?? minSurfY);
      if (yb < minBaseY) minBaseY = yb;
      if (yb < minCellLowY) minCellLowY = yb;
      if (ys < minCellLowY) minCellLowY = ys;
    });
    const yFloor = Math.min(minBaseY, minSurfY, minCellLowY);

    const limitVerts = pts.map((v) => {
      const yLim = evalLimitYAtVertex(v);
      return new THREE.Vector3(
        v.x,
        baseMode === "triangulated_boundary" || baseMode === "lowest_point" || baseMode === "epoch_diff"
          ? yFloor
          : Math.min(yLim, v.y - 0.02),
        v.z
      );
    });

    const limitPlanePositions = [];
    const limitGridPositions = [];

    // Always triangulate the exact polygon footprint on the Bottom Limiting Plane (limitVerts) so 100% of the bottom is closed
    const cLimY = limitVerts.reduce((acc, v) => acc + v.y, 0) / Math.max(1, limitVerts.length);
    if (THREE.ShapeUtils && typeof THREE.ShapeUtils.triangulateShape === "function") {
      const contour2D = limitVerts.map((v) => new THREE.Vector2(v.x, v.z));
      const tris = THREE.ShapeUtils.triangulateShape(contour2D, []);
      if (Array.isArray(tris) && tris.length > 0) {
        tris.forEach(([ia, ib, ic]) => {
          const va = limitVerts[ia], vb = limitVerts[ib], vc = limitVerts[ic];
          if (va && vb && vc) {
            limitPlanePositions.push(va.x, va.y, va.z, vb.x, vb.y, vb.z, vc.x, vc.y, vc.z);
          }
        });
      }
    }
    if (limitPlanePositions.length === 0) {
      for (let i = 0; i < limitVerts.length; i++) {
        const a = limitVerts[i];
        const b = limitVerts[(i + 1) % limitVerts.length];
        limitPlanePositions.push(a.x, a.y, a.z, b.x, b.y, b.z, centroid.x, cLimY, centroid.z);
      }
    }

    if (cells.length > 0) {
      const fillPositions = [];
      const cutPositions = [];
      const topCellWirePositions = [];

      cells.forEach((cell) => {
        const x = Number(cell.lx || 0);
        const z = Number(cell.lz || 0);
        const ySurf = Number(cell.ly_surf || 0) + 0.02;
        const yBase = Number(cell.ly_base || 0);
        const dz = Number(cell.dz || 0);
        const stepX = Number(volumeRes.cell_dx || cell.step_x || cellStep) || 0.5;
        const stepZ = Number(volumeRes.cell_dz || cell.step_z || cellStep) || 0.5;
        const halfX = Math.max(0.03, stepX * 0.485);
        const halfZ = Math.max(0.03, stepZ * 0.485);

        const gx0 = x - stepX * 0.495, gx1 = x + stepX * 0.495;
        const gz0 = z - stepZ * 0.495, gz1 = z + stepZ * 0.495;
        const yGrid =
          baseMode === "triangulated_boundary" || baseMode === "lowest_point" || baseMode === "epoch_diff"
            ? yFloor + 0.005
            : yBase + 0.005;
        limitPlanePositions.push(
          gx0, yGrid - 0.005, gz0, gx1, yGrid - 0.005, gz0, gx1, yGrid - 0.005, gz1,
          gx0, yGrid - 0.005, gz0, gx1, yGrid - 0.005, gz1, gx0, yGrid - 0.005, gz1
        );
        limitGridPositions.push(
          gx0, yGrid, gz0, gx1, yGrid, gz0,
          gx1, yGrid, gz0, gx1, yGrid, gz1,
          gx1, yGrid, gz1, gx0, yGrid, gz1,
          gx0, yGrid, gz1, gx0, yGrid, gz0
        );

        const rawLow = Math.min(yBase, ySurf);
        const rawHigh = Math.max(yBase, ySurf);
        const yLow = rawHigh - rawLow < 0.025 ? rawHigh - 0.025 : rawLow;
        const yHigh = rawHigh;
        if (dz >= 0) {
          pushBoxPrismTriangles(fillPositions, x, z, halfX, halfZ, yLow, yHigh);
        } else {
          pushBoxPrismTriangles(cutPositions, x, z, halfX, halfZ, yLow, yHigh);
        }
        topCellWirePositions.push(
          x - halfX, yHigh + 0.004, z - halfZ, x + halfX, yHigh + 0.004, z - halfZ,
          x + halfX, yHigh + 0.004, z - halfZ, x + halfX, yHigh + 0.004, z + halfZ,
          x + halfX, yHigh + 0.004, z + halfZ, x - halfX, yHigh + 0.004, z + halfZ,
          x - halfX, yHigh + 0.004, z + halfZ, x - halfX, yHigh + 0.004, z - halfZ
        );
      });

      if (fillPositions.length > 0) {
        const fillGeo = new THREE.BufferGeometry();
        fillGeo.setAttribute("position", new THREE.Float32BufferAttribute(fillPositions, 3));
        const fillMesh = new THREE.Mesh(
          fillGeo,
          new THREE.MeshBasicMaterial({
            color: 0x0ea5e9,
            transparent: true,
            opacity: 0.42,
            side: THREE.DoubleSide,
            depthTest: false,
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
            opacity: 0.42,
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false,
          })
        );
        cutMesh.renderOrder = 995;
        studioThree.volumeGroup.add(cutMesh);
      }
      if (topCellWirePositions.length > 0) {
        const topWireGeo = new THREE.BufferGeometry();
        topWireGeo.setAttribute("position", new THREE.Float32BufferAttribute(topCellWirePositions, 3));
        const topWireLines = new THREE.LineSegments(
          topWireGeo,
          new THREE.LineBasicMaterial({
            color: 0xe2e8f0,
            transparent: true,
            opacity: 0.26,
            depthTest: false,
            depthWrite: false,
          })
        );
        topWireLines.renderOrder = 996;
        studioThree.volumeGroup.add(topWireLines);
      }
    } else {
      for (let i = 0; i < limitVerts.length; i++) {
        const a = limitVerts[i];
        limitGridPositions.push(a.x, a.y + 0.004, a.z, centroid.x, cLimY + 0.004, centroid.z);
      }
    }

    if (limitPlanePositions.length > 0) {
      const limitGeo = new THREE.BufferGeometry();
      limitGeo.setAttribute("position", new THREE.Float32BufferAttribute(limitPlanePositions, 3));
      const limitMesh = new THREE.Mesh(
        limitGeo,
        new THREE.MeshBasicMaterial({
          color: 0xf59e0b,
          transparent: true,
          opacity: 0.30,
          side: THREE.DoubleSide,
          depthTest: false,
          depthWrite: false,
        })
      );
      limitMesh.renderOrder = 990;
      studioThree.volumeGroup.add(limitMesh);
    }

    if (limitGridPositions.length > 0) {
      const gridGeo = new THREE.BufferGeometry();
      gridGeo.setAttribute("position", new THREE.Float32BufferAttribute(limitGridPositions, 3));
      const gridLines = new THREE.LineSegments(
        gridGeo,
        new THREE.LineBasicMaterial({
          color: 0xfbbf24,
          transparent: true,
          opacity: 0.72,
          depthTest: false,
          depthWrite: false,
        })
      );
      gridLines.renderOrder = 991;
      studioThree.volumeGroup.add(gridLines);
    }

    // B. Bottom Limiting Plane Perimeter Outline & Vertical Drop-Pillars + Translucent Side-Curtain Walls
    const limitLoopPts = [...limitVerts, limitVerts[0].clone()];
    const limitOutline = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(limitLoopPts),
      new THREE.LineBasicMaterial({ color: 0xf59e0b, linewidth: 2, depthTest: false, transparent: true, opacity: 0.96 })
    );
    limitOutline.renderOrder = 997;
    studioThree.volumeGroup.add(limitOutline);

    const pillarPositions = [];
    const curtainPositions = [];
    for (let i = 0; i < pts.length; i++) {
      const topA = pts[i];
      const botA = limitVerts[i];
      const topB = pts[(i + 1) % pts.length];
      const botB = limitVerts[(i + 1) % pts.length];
      pillarPositions.push(topA.x, topA.y, topA.z, botA.x, botA.y, botA.z);
      curtainPositions.push(
        topA.x, topA.y, topA.z, botA.x, botA.y, botA.z, botB.x, botB.y, botB.z,
        topA.x, topA.y, topA.z, botB.x, botB.y, botB.z, topB.x, topB.y, topB.z
      );
    }
    if (pillarPositions.length > 0) {
      const pillarGeo = new THREE.BufferGeometry();
      pillarGeo.setAttribute("position", new THREE.Float32BufferAttribute(pillarPositions, 3));
      const pillarLines = new THREE.LineSegments(
        pillarGeo,
        new THREE.LineBasicMaterial({ color: 0xf59e0b, depthTest: false, transparent: true, opacity: 0.92 })
      );
      pillarLines.renderOrder = 997;
      studioThree.volumeGroup.add(pillarLines);
    }
    if (curtainPositions.length > 0) {
      const curtainGeo = new THREE.BufferGeometry();
      curtainGeo.setAttribute("position", new THREE.Float32BufferAttribute(curtainPositions, 3));
      const curtainMesh = new THREE.Mesh(
        curtainGeo,
        new THREE.MeshBasicMaterial({
          color: 0xf59e0b,
          transparent: true,
          opacity: 0.20,
          side: THREE.DoubleSide,
          depthTest: false,
          depthWrite: false,
        })
      );
      curtainMesh.renderOrder = 992;
      studioThree.volumeGroup.add(curtainMesh);
    }

    // 4. 2D Cut/Fill Volume & Tonnage Badge at Polygon Centroid + Bottom Limiting Plane Elevation Badge
    const badgePos = new THREE.Vector3(centroid.x, maxY + 0.45, centroid.z);
    if (volumeRes) {
      add2DBadge(
        badgePos,
        `Fill: <b style="color:#0284c7;">+${volumeRes.fill_volume_m3} m³</b> · Cut: <b style="color:#ef4444;">-${volumeRes.cut_volume_m3} m³</b> · Net: <b>${volumeRes.net_volume_m3 >= 0 ? "+" : ""}${volumeRes.net_volume_m3} m³</b> (${volumeRes.estimated_tonnage_t} t)`,
        "#0284c7",
        { isVolume: true }
      );
      const bottomElevH = (ch + cLimY).toFixed(2);
      const botBadgeAnchor = limitVerts[0] ? limitVerts[0].clone().lerp(centroid, 0.35) : new THREE.Vector3(centroid.x, cLimY, centroid.z);
      botBadgeAnchor.y = cLimY;
      add2DBadge(
        botBadgeAnchor,
        `Bottom Limiting Plane: <b style="color:#fbbf24;">H +${bottomElevH} m</b>`,
        "#f59e0b",
        { offsetY: 18, isVolume: true }
      );
    } else {
      add2DBadge(
        badgePos,
        `Boundary: <b>${pts.length} vertices</b> — Click red V1 (or press Enter) to lock &amp; compute volume`,
        "#0284c7",
        { isVolume: true }
      );
    }
    updateZoomInvariantElements();
  }

  // Capture Figure 1 (3D Perspective Overview) & Figure 2 (Top-Down Nadir View with V1..Vn & Thick Boundary) for Volume Report
  function captureVolumeReportFigures(ptsLocal, volumeRes) {
    if (!studioThree || !studioThree.renderer || !studioThree.scene || !studioThree.camera) {
      return { perspectiveImgDataUrl: "", nadirImgDataUrl: "" };
    }
    const pts =
      ptsLocal && ptsLocal.length >= 3
        ? ptsLocal
        : volumeRes && Array.isArray(volumeRes._resolvedPtsLocal) && volumeRes._resolvedPtsLocal.length >= 3
        ? volumeRes._resolvedPtsLocal
        : STATE.cutFillPolygonPoints && STATE.cutFillPolygonPoints.length >= 3
        ? STATE.cutFillPolygonPoints
        : [];
    if (pts.length < 3) {
      return { perspectiveImgDataUrl: "", nadirImgDataUrl: "" };
    }

    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    let minY = Math.min(...pts.map((p) => p.y));
    let maxY = Math.max(...pts.map((p) => p.y));
    if (volumeRes && Array.isArray(volumeRes.heatmap_cells)) {
      for (let i = 0; i < volumeRes.heatmap_cells.length; i++) {
        const c = volumeRes.heatmap_cells[i];
        const ys = Number(c.ly_surf);
        const yb = Number(c.ly_base);
        if (Number.isFinite(ys)) {
          if (ys < minY) minY = ys;
          if (ys > maxY) maxY = ys;
        }
        if (Number.isFinite(yb)) {
          if (yb < minY) minY = yb;
          if (yb > maxY) maxY = yb;
        }
      }
    }
    const minZ = Math.min(...pts.map((p) => p.z));
    const maxZ = Math.max(...pts.map((p) => p.z));
    const cx = 0.5 * (minX + maxX);
    const cy = 0.5 * (minY + maxY);
    const cz = 0.5 * (minZ + maxZ);
    const spanX = Math.max(2.0, maxX - minX);
    const spanZ = Math.max(2.0, maxZ - minZ);
    const spanMax = Math.max(spanX, spanZ, (maxY - minY) * 1.35, 4.0);

    const cam = studioThree.camera;
    const prevPos = cam.position.clone();
    const prevQuat = cam.quaternion.clone();
    const prevUp = cam.up.clone();
    const prevTarget = studioThree.controls?.target ? studioThree.controls.target.clone() : new THREE.Vector3(cx, cy, cz);

    let perspectiveImgDataUrl = "";
    let nadirImgDataUrl = "";

    try {
      // 1. Figure 1 — 3D Perspective Overview Screenshot onto 880x500 canvas
      const dist = Math.max(8.0, spanMax * 1.42);
      const centerVec = new THREE.Vector3(cx, cy, cz);
      cam.up.set(0, 1, 0);
      cam.position.set(cx + dist * 0.56, cy + dist * 0.68, cz + dist * 0.80);
      cam.lookAt(centerVec);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      updateZoomInvariantElements();
      studioThree.renderer.render(studioThree.scene, cam);

      const pCanvas = document.createElement("canvas");
      pCanvas.width = 880;
      pCanvas.height = 500;
      const pCtx = pCanvas.getContext("2d");
      pCtx.fillStyle = "#0f172a";
      pCtx.fillRect(0, 0, 880, 500);
      pCtx.drawImage(studioThree.renderer.domElement, 0, 0, 880, 500);

      // Composite V1..Vn vertex callouts onto 880x500 perspective overview
      pts.forEach((pt, idx) => {
        const proj = pt.clone().project(cam);
        if (proj.z >= -1 && proj.z <= 1) {
          const sx = (proj.x * 0.5 + 0.5) * 880;
          const sy = (-proj.y * 0.5 + 0.5) * 500;
          pCtx.beginPath();
          pCtx.arc(sx, sy, 6, 0, Math.PI * 2);
          pCtx.fillStyle = idx === 0 ? "#ff3b30" : "#0084ff";
          pCtx.fill();
          pCtx.lineWidth = 2;
          pCtx.strokeStyle = "#ffffff";
          pCtx.stroke();

          const lbl = `V${idx + 1}`;
          pCtx.font = "bold 12px monospace";
          const tw = pCtx.measureText(lbl).width + 10;
          pCtx.fillStyle = "rgba(15, 23, 42, 0.88)";
          pCtx.fillRect(sx - tw * 0.5, sy - 26, tw, 18);
          pCtx.strokeStyle = idx === 0 ? "#ff3b30" : "#38bdf8";
          pCtx.lineWidth = 1.2;
          pCtx.strokeRect(sx - tw * 0.5, sy - 26, tw, 18);
          pCtx.fillStyle = "#ffffff";
          pCtx.textAlign = "center";
          pCtx.textBaseline = "middle";
          pCtx.fillText(lbl, sx, sy - 17);
        }
      });

      // Summary Callout Badge on Figure 1
      if (volumeRes) {
        pCtx.fillStyle = "rgba(15, 23, 42, 0.90)";
        pCtx.fillRect(14, 14, 480, 52);
        pCtx.strokeStyle = "#38bdf8";
        pCtx.lineWidth = 1.5;
        pCtx.strokeRect(14, 14, 480, 52);
        pCtx.textAlign = "left";
        pCtx.textBaseline = "top";
        pCtx.font = "bold 13px sans-serif";
        pCtx.fillStyle = "#f8fafc";
        pCtx.fillText(
          `${volumeRes.stockpile_name || "Volume Enclosure"} · Base: ${volumeRes.base_mode || "triangulated_boundary"}`,
          24,
          22
        );
        pCtx.font = "bold 12.5px monospace";
        pCtx.fillStyle = "#38bdf8";
        pCtx.fillText(
          `Fill: +${volumeRes.fill_volume_m3} m³   Cut: -${volumeRes.cut_volume_m3} m³   Net: ${
            Number(volumeRes.net_volume_m3) >= 0 ? "+" : ""
          }${volumeRes.net_volume_m3} m³ (${volumeRes.estimated_tonnage_t} t)`,
          24,
          42
        );
      }
      perspectiveImgDataUrl = pCanvas.toDataURL("image/png");

      // 2. Figure 2 — Top-Down (Nadir) View with All Point Labels (V1..Vn) & Thick Boundary onto 880x560 canvas
      const nW = 880;
      const nH = 560;
      const aspect = nW / nH;
      const halfSpanZ = Math.max(spanZ * 0.5 * 1.42, (spanX * 0.5 * 1.42) / aspect, 3.0);
      const halfSpanX = halfSpanZ * aspect;
      const nadirCam = new THREE.OrthographicCamera(
        -halfSpanX,
        halfSpanX,
        halfSpanZ,
        -halfSpanZ,
        0.5,
        Math.max(800, spanMax * 12 + 400)
      );
      nadirCam.position.set(cx, maxY + Math.max(100, spanMax * 4), cz);
      nadirCam.up.set(0, 0, -1);
      nadirCam.lookAt(new THREE.Vector3(cx, cy, cz));
      nadirCam.updateProjectionMatrix();
      nadirCam.updateMatrixWorld(true);

      // Hide volumeGroup during raw nadir terrain render so our crisp 2D canvas vector overlay + cell shading is ultra-clean
      const prevVolVis = studioThree.volumeGroup ? studioThree.volumeGroup.visible : true;
      if (studioThree.volumeGroup) studioThree.volumeGroup.visible = false;
      studioThree.renderer.render(studioThree.scene, nadirCam);
      if (studioThree.volumeGroup) studioThree.volumeGroup.visible = prevVolVis;

      const nCanvas = document.createElement("canvas");
      nCanvas.width = nW;
      nCanvas.height = nH;
      const nCtx = nCanvas.getContext("2d");
      nCtx.fillStyle = "#0f172a";
      nCtx.fillRect(0, 0, nW, nH);
      nCtx.drawImage(studioThree.renderer.domElement, 0, 0, nW, nH);

      const toNadirXY = (lx, lz) => [
        ((lx - cx + halfSpanX) / (2 * halfSpanX)) * nW,
        ((lz - cz + halfSpanZ) / (2 * halfSpanZ)) * nH,
      ];

      // Engineering coordinate grid ticks (E, N)
      const originTwd = localToTwd97({ x: 0, y: 0, z: 0 });
      const ce = Number(originTwd.e || 0);
      const cn = Number(originTwd.n || 0);
      const ch = Number(originTwd.h || 0);
      nCtx.strokeStyle = "rgba(226, 232, 240, 0.22)";
      nCtx.lineWidth = 1;
      nCtx.font = "10.5px monospace";
      nCtx.fillStyle = "rgba(248, 250, 252, 0.85)";
      for (let gi = 1; gi <= 4; gi++) {
        const frac = gi / 5;
        const gxPx = frac * nW;
        const gzPx = frac * nH;
        const lxVal = cx - halfSpanX + frac * 2 * halfSpanX;
        const lzVal = cz - halfSpanZ + frac * 2 * halfSpanZ;
        nCtx.beginPath();
        nCtx.moveTo(gxPx, 0);
        nCtx.lineTo(gxPx, nH);
        nCtx.stroke();
        nCtx.beginPath();
        nCtx.moveTo(0, gzPx);
        nCtx.lineTo(nW, gzPx);
        nCtx.stroke();
        nCtx.textAlign = "center";
        nCtx.textBaseline = "top";
        nCtx.fillText(`E:${(ce + lxVal).toFixed(1)}`, gxPx, 6);
        nCtx.textAlign = "left";
        nCtx.textBaseline = "middle";
        nCtx.fillText(`N:${(cn - lzVal).toFixed(1)}`, 6, gzPx - 8);
      }

      // Semi-transparent Cut (#ef4444) and Fill (#0ea5e9) cell shading across 100% of interior cells
      const cells = volumeRes && Array.isArray(volumeRes.heatmap_cells) ? volumeRes.heatmap_cells : [];
      const pxPerMeterX = nW / (2 * halfSpanX);
      const pxPerMeterZ = nH / (2 * halfSpanZ);
      cells.forEach((cell) => {
        const dz = Number(cell.dz || 0);
        const stepX = Number(volumeRes.cell_dx || cell.step_x || volumeRes.cell_step_m || 0.5);
        const stepZ = Number(volumeRes.cell_dz || cell.step_z || volumeRes.cell_step_m || 0.5);
        const [cxPx, czPx] = toNadirXY(Number(cell.lx || 0), Number(cell.lz || 0));
        const cw = Math.max(2, stepX * pxPerMeterX * 0.96);
        const chPx = Math.max(2, stepZ * pxPerMeterZ * 0.96);
        nCtx.fillStyle = dz >= 0 ? "rgba(14, 165, 233, 0.36)" : "rgba(239, 68, 68, 0.36)";
        nCtx.fillRect(cxPx - cw * 0.5, czPx - chPx * 0.5, cw, chPx);
      });

      // Thick, high-contrast polygon boundary (lineWidth = 4.5, #0ea5e9 over #0f172a halo)
      nCtx.beginPath();
      pts.forEach((pt, idx) => {
        const [px, py] = toNadirXY(pt.x, pt.z);
        if (idx === 0) nCtx.moveTo(px, py);
        else nCtx.lineTo(px, py);
      });
      nCtx.closePath();
      nCtx.strokeStyle = "#0f172a";
      nCtx.lineWidth = 8.0;
      nCtx.lineJoin = "round";
      nCtx.stroke();
      nCtx.strokeStyle = "#0ea5e9";
      nCtx.lineWidth = 4.5;
      nCtx.stroke();

      // Edge length labels (m)
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const segLen = a.distanceTo(b);
        const [ax, ay] = toNadirXY(a.x, a.z);
        const [bx, by] = toNadirXY(b.x, b.z);
        const mx = 0.5 * (ax + bx);
        const my = 0.5 * (ay + by);
        const edgeTxt = `${segLen.toFixed(2)}m`;
        nCtx.font = "bold 11px monospace";
        const etw = nCtx.measureText(edgeTxt).width + 8;
        nCtx.fillStyle = "rgba(15, 23, 42, 0.85)";
        nCtx.fillRect(mx - etw * 0.5, my - 9, etw, 18);
        nCtx.fillStyle = "#fbbf24";
        nCtx.textAlign = "center";
        nCtx.textBaseline = "middle";
        nCtx.fillText(edgeTxt, mx, my);
      }

      // All vertex point markers & callout labels V1, V2, ..., Vn with their elevation (H:+XX.XXm) and collision avoidance
      const placedBoxes = [];
      pts.forEach((pt, idx) => {
        const [px, py] = toNadirXY(pt.x, pt.z);
        const hVal = ch + pt.y;
        nCtx.beginPath();
        nCtx.arc(px, py, 7, 0, Math.PI * 2);
        nCtx.fillStyle = idx === 0 ? "#ff3b30" : "#0084ff";
        nCtx.fill();
        nCtx.lineWidth = 2.2;
        nCtx.strokeStyle = "#ffffff";
        nCtx.stroke();

        const vLbl = `V${idx + 1} (H:+${hVal.toFixed(2)}m)`;
        nCtx.font = "bold 11.5px monospace";
        const vtw = nCtx.measureText(vLbl).width + 12;
        let bx = Math.max(6, Math.min(nW - vtw - 6, px - vtw * 0.5));
        let by = py > 44 ? py - 30 : py + 12;
        for (let pass = 0; pass < 4; pass++) {
          const hit = placedBoxes.find(
            (b) => !(bx + vtw < b.x - 3 || bx > b.x + b.w + 3 || by + 20 < b.y - 2 || by > b.y + b.h + 2)
          );
          if (!hit) break;
          by = hit.y > py ? Math.max(6, hit.y - 24) : Math.min(nH - 26, hit.y + hit.h + 4);
        }
        placedBoxes.push({ x: bx, y: by, w: vtw, h: 20 });
        nCtx.fillStyle = "rgba(15, 23, 42, 0.92)";
        nCtx.fillRect(bx, by, vtw, 20);
        nCtx.strokeStyle = idx === 0 ? "#ff3b30" : "#38bdf8";
        nCtx.lineWidth = 1.4;
        nCtx.strokeRect(bx, by, vtw, 20);
        nCtx.fillStyle = "#ffffff";
        nCtx.textAlign = "center";
        nCtx.textBaseline = "middle";
        nCtx.fillText(vLbl, bx + vtw * 0.5, by + 10);
      });

      // North arrow & metric scale bar
      nCtx.fillStyle = "rgba(15, 23, 42, 0.88)";
      nCtx.fillRect(nW - 62, 16, 46, 54);
      nCtx.strokeStyle = "#cbd5e1";
      nCtx.lineWidth = 1.2;
      nCtx.strokeRect(nW - 62, 16, 46, 54);
      nCtx.fillStyle = "#38bdf8";
      nCtx.beginPath();
      nCtx.moveTo(nW - 39, 24);
      nCtx.lineTo(nW - 47, 44);
      nCtx.lineTo(nW - 39, 39);
      nCtx.lineTo(nW - 31, 44);
      nCtx.closePath();
      nCtx.fill();
      nCtx.fillStyle = "#ffffff";
      nCtx.font = "bold 12px sans-serif";
      nCtx.textAlign = "center";
      nCtx.fillText("N", nW - 39, 58);

      const rawBarMeters = Math.max(1, Math.round((2 * halfSpanX * 0.18) * 2) / 2);
      const barPx = rawBarMeters * pxPerMeterX;
      nCtx.fillStyle = "rgba(15, 23, 42, 0.88)";
      nCtx.fillRect(16, nH - 42, barPx + 28, 28);
      nCtx.strokeStyle = "#cbd5e1";
      nCtx.lineWidth = 1.2;
      nCtx.strokeRect(16, nH - 42, barPx + 28, 28);
      nCtx.strokeStyle = "#ffffff";
      nCtx.lineWidth = 3;
      nCtx.beginPath();
      nCtx.moveTo(28, nH - 22);
      nCtx.lineTo(28 + barPx, nH - 22);
      nCtx.moveTo(28, nH - 27);
      nCtx.lineTo(28, nH - 17);
      nCtx.moveTo(28 + barPx, nH - 27);
      nCtx.lineTo(28 + barPx, nH - 17);
      nCtx.stroke();
      nCtx.font = "bold 11px monospace";
      nCtx.fillStyle = "#38bdf8";
      nCtx.textAlign = "center";
      nCtx.fillText(`${rawBarMeters} m`, 28 + barPx * 0.5, nH - 32);

      nadirImgDataUrl = nCanvas.toDataURL("image/png");
    } catch (err) {
      console.warn("[GatheringScans] captureVolumeReportFigures warning:", err);
    } finally {
      // Restore camera & controls synchronously
      cam.position.copy(prevPos);
      cam.quaternion.copy(prevQuat);
      cam.up.copy(prevUp);
      if (studioThree.controls?.target) {
        studioThree.controls.target.copy(prevTarget);
        studioThree.controls.update();
      }
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      studioThree.renderer.render(studioThree.scene, cam);
      updateZoomInvariantElements();
      update2DBadgePositions();
    }

    return { perspectiveImgDataUrl, nadirImgDataUrl };
  }
  window.captureVolumeReportFigures = captureVolumeReportFigures;


